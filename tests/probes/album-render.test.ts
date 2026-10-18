/**
 * Album render probe (on demand): renders the album's tracks to WAV files (48 kHz, 16 bit, stereo) in previews/album/ and prints, per track:
 * the render speed (x real time), the integrated loudness (LUFS), the true peak and the length; the arrangement (which channels play in
 * each section) and the automation that was registered; then a per-section table with loudness, peak, stereo width, band balance and the
 * level of every channel (with a legend). It also checks the album's gates: finite, true peak at or below -1 dBTP, integrated loudness
 * within 1.5 LU of -14, no DC, a silent first and last sample.
 *
 *   ALBUM=1 npx vitest run tests/probes/album-render.test.ts                  (every track of the album)
 *   ALBUM=1 ONLY=sound-check npx vitest run tests/probes/album-render.test.ts (one track)
 *   ALBUM=1 TRACK=sandbox/album/examples/punk.ts npx vitest run tests/probes/album-render.test.ts   (a track file that is not in the album)
 *   ALBUM=1 ONLY=my-track SPEC=1 ...   also writes a spectrogram PNG next to the WAV (log frequency, sections marked)
 *   ALBUM=1 ONLY=my-track AUTOTRIM=1 ...   searches (up to five renders) for the master trim that gives -14 LUFS, prints the line to write
 *                                          and reports the track rendered with it
 *   ALBUM=1 ONLY=my-track BANDS=1 ...   adds a table of the band levels of every channel in every section (each channel is rendered alone,
 *                                          so this takes one extra render per channel): which channel owns a band
 *   ALBUM=1 ONLY=my-track CLASH=1 ...   the harmony check: every minor 2nd / minor 9th between two parts (and a tone between bass notes), by bar;
 *                                        CLASH=2 also checks the synths' upper octave layers against the other parts
 *   ALBUM=1 ONLY=my-track SOLO=acid,bass ...   renders only those channels (files get a .solo-acid+bass suffix; the loudness gates are skipped)
 *   ALBUM=1 ONLY=my-track SPEC=1 BARS=16-24 ...   the spectrogram of bars 16 to 24 only (a zoom; combine with SOLO to see one channel)
 *   ALBUM=1 SR=44100 ...   renders at another sample rate
 * In PowerShell set the variables first and clear them afterwards, they stay set in the session:
 *   $env:ALBUM='1'; $env:ONLY='my-track'; $env:AUTOTRIM='1'; $env:SPEC='1'; npx vitest run tests/probes/album-render.test.ts
 *   Remove-Item Env:ALBUM, Env:ONLY, Env:AUTOTRIM, Env:SPEC
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRACK_DEFS } from '../../src/audio/album';
import soundCheck from '../../src/audio/album/sound-check';
import type { TrackDef } from '../../src/audio/album/song';
import { LoudnessMeter, integratedFromBlocks, measure, truePeakLinear } from '../../src/audio/album/measure';
import { BANDS, bandDb, renderAll, save, saveAlbumSpectrogram, saveWav, stereoStats, db } from '../../sandbox/album/lab/tools';

const RUN = process.env.ALBUM === '1';
const ONLY = process.env.ONLY;
const SR = Number(process.env.SR ?? 48000);
const TARGET_LUFS = -14;
// SOLO=a,b renders only those channels; BARS=from-to zooms the spectrogram; BANDS=1 adds the per-channel band table
const SOLO: string[] | null = process.env.SOLO ? process.env.SOLO.split(',').map((x) => x.trim()).filter(Boolean) : null;
const ZOOM: { from: number; to: number } | null = (() => {
  const text = process.env.BARS;
  if (!text) return null;
  const m = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!m || !(Number(m[2]) > Number(m[1]))) throw new Error(`BARS=${text}: write the bars as from-to, for example BARS=16-24`);
  return { from: Number(m[1]), to: Number(m[2]) };
})();
const PER_CHANNEL = process.env.BANDS === '1';
// TRACK=<path>: probe a track file that is not part of the album (its default export must be a defineTrack(...) result)
const EXTRA: TrackDef | undefined = RUN && process.env.TRACK ? ((await import(/* @vite-ignore */ pathToFileURL(resolve(process.env.TRACK)).href)) as { default: TrackDef }).default : undefined;

/** Searches for the master-trim offset (dB) that makes the track measure TARGET_LUFS; the compressor makes the response flatter than 1 dB per dB. */
function autoTrim(def: TrackDef): { offset: number; lufs: number; renders: number; log: string[] } {
  const log: string[] = [];
  const at = (offset: number): number => {
    const song = def.build(SR);
    song.master.offsetDb = offset;
    const [l, r] = renderAll(song.toRenderer());
    const lufs = measure(l, r, SR).lufs;
    log.push(`offset ${offset >= 0 ? '+' : ''}${offset.toFixed(2)} dB -> ${lufs.toFixed(2)} LUFS`);
    return lufs;
  };
  let o0 = 0;
  let l0 = at(o0);
  let renders = 1;
  if (Math.abs(l0 - TARGET_LUFS) < 0.1) return { offset: 0, lufs: l0, renders, log };
  let o1 = (TARGET_LUFS - l0) * 1.4;
  let l1 = at(o1);
  renders++;
  while (Math.abs(l1 - TARGET_LUFS) > 0.1 && renders < 5) {
    const slope = Math.max(0.2, (l1 - l0) / (o1 - o0 || 1));
    const o2 = o1 + (TARGET_LUFS - l1) / slope;
    o0 = o1;
    l0 = l1;
    o1 = o2;
    l1 = at(o1);
    renders++;
  }
  return { offset: o1, lufs: l1, renders, log };
}

describe.skipIf(!RUN)('album render', () => {
  // ONLY=sound-check works even after the album's real tracks have replaced it
  const defs: readonly TrackDef[] = EXTRA ? [EXTRA] : ONLY === soundCheck.info.id && !TRACK_DEFS.some((d) => d.info.id === ONLY) ? [soundCheck] : TRACK_DEFS;
  for (const def of defs) {
    if (!EXTRA && ONLY && def.info.id !== ONLY) continue;
    it(`renders ${def.info.id}`, () => {
      const lines: string[] = [];
      let offset = 0;
      let autoLine = '';
      if (process.env.AUTOTRIM === '1' && SOLO) autoLine = '  AUTOTRIM is skipped with SOLO (it trims the whole mix).';
      else if (process.env.AUTOTRIM === '1') {
        const a = autoTrim(def);
        offset = a.offset;
        const probe = def.build(SR);
        const base = probe.master.params.trim;
        const automated = probe.describeAutomation().split('\n').some((l) => l.startsWith('master.trim:'));
        autoLine = automated
          ? `  AUTOTRIM: master.trim is automated; add ${offset >= 0 ? '+' : ''}${offset.toFixed(1)} dB to each of its values to reach ${a.lufs.toFixed(2)} LUFS (${a.renders} renders: ${a.log.join('; ')})`
          : `  AUTOTRIM: write s.setMaster({ trim: ${(base + offset).toFixed(1)} }); (now ${base.toFixed(1)}) to reach ${a.lufs.toFixed(2)} LUFS (${a.renders} renders: ${a.log.join('; ')}). The report below is rendered with it.`;
      }
      const tBuild = performance.now();
      const song = def.build(SR);
      if (SOLO) song.solo(SOLO);
      song.master.offsetDb = offset;
      const r = song.toRenderer();
      const buildMs = performance.now() - tBuild;
      const stem = SOLO ? `${def.info.id}.solo-${SOLO.join('+')}` : def.info.id;
      const L = new Float32Array(r.frames);
      const R = new Float32Array(r.frames);
      // per-section chunks (or 8-bar chunks) so that channel meters can be read per section
      const barSec = (60 * (def.meta.signature ? (def.meta.signature[0] * 4) / def.meta.signature[1] : 4)) / def.meta.bpm;
      const barFrames = SR * barSec;
      const secs = song.sectionsDeclared.length
        ? [...song.sectionsDeclared]
        : Array.from({ length: Math.ceil(def.meta.bars / 8) }, (_, i) => ({ name: `bars ${i * 8}-${Math.min(def.meta.bars, i * 8 + 8)}`, bar: i * 8, bars: Math.min(8, def.meta.bars - i * 8), end: Math.min(def.meta.bars, i * 8 + 8) }));
      const rows: { name: string; from: number; to: number; meters: { name: string; sum: number }[] }[] = [];
      let pos = 0;
      const block = 4096;
      const bl = new Float32Array(block);
      const br = new Float32Array(block);
      const t0 = performance.now();
      const segEnds = secs.map((s) => Math.min(r.frames, Math.round(s.end * barFrames)));
      segEnds[segEnds.length - 1] = r.frames; // the tail belongs to the last section
      // the engine's own clock runs `latency` frames (the limiter's look-ahead) ahead of the output: read each section's channel meters
      // when that clock reaches the section end, so that a hit on the first beat of a section is not counted in the previous one
      const latency = song.master.limiter.latency;
      const renderTo = (to: number): void => {
        while (pos < to) {
          const m = r.render(bl, br, Math.min(block, to - pos));
          if (m === 0) break;
          L.set(bl.subarray(0, m), pos);
          R.set(br.subarray(0, m), pos);
          pos += m;
        }
      };
      secs.forEach((s, si) => {
        const from = pos;
        const last = si === secs.length - 1;
        renderTo(last ? segEnds[si] : Math.max(from, segEnds[si] - latency));
        const meters = (r as unknown as { readMeters(): { name: string; sum: number }[] }).readMeters();
        renderTo(segEnds[si]);
        rows.push({ name: s.name, from, to: pos, meters });
      });
      const dt = (performance.now() - t0) / 1000;
      const seconds = r.frames / SR;
      const stats = measure(L, R, SR);
      saveWav(`previews/album/${stem}.wav`, L, R, SR);
      let specName = '';
      if (process.env.SPEC === '1') {
        // the whole track, or the bars of BARS=from-to (a zoom: the picture is as wide as ever, so the detail grows)
        const f0 = ZOOM ? Math.max(0, Math.round(ZOOM.from * barFrames)) : 0;
        const f1 = ZOOM ? Math.min(L.length, Math.round(ZOOM.to * barFrames)) : L.length;
        if (f1 <= f0) throw new Error(`BARS=${process.env.BARS}: the track has only ${(def.meta.bars).toString()} bars`);
        const mono = new Float32Array(f1 - f0);
        for (let i = f0; i < f1; i++) mono[i - f0] = 0.5 * (L[i] + R[i]);
        const t0s = f0 / SR;
        const t1s = f1 / SR;
        const marks = secs.filter((s) => s.end * barSec > t0s + 1e-6 && s.bar * barSec < t1s - 1e-6).map((s) => ({ name: s.name, sec: Math.max(0, s.bar * barSec - t0s) }));
        specName = ZOOM ? `${stem}.spec-bars-${ZOOM.from}-${ZOOM.to}.png` : `${stem}.spec.png`;
        saveAlbumSpectrogram(`previews/album/${specName}`, mono, SR, { sections: marks, barSec, lineBars: ZOOM && ZOOM.to - ZOOM.from <= 16 ? 1 : 4 });
      }
      lines.push(`\n=== ${def.info.id} "${def.info.title}" (${def.info.genre}, ${def.info.bpm} BPM) ===`);
      if (SOLO) lines.push(`  SOLO: only ${SOLO.join(', ')} sound. The loudness and peak gates are skipped (they are for the whole mix).`);
      if (autoLine) lines.push(autoLine);
      lines.push(`  length ${seconds.toFixed(2)} s (ALBUM says ${def.info.seconds.toFixed(2)} s), built in ${buildMs.toFixed(0)} ms, rendered in ${dt.toFixed(2)} s = ${(seconds / dt).toFixed(1)}x real time`);
      lines.push(
        `  integrated ${stats.lufs.toFixed(2)} LUFS (target ${TARGET_LUFS}; a linear estimate says trim by ${(TARGET_LUFS - stats.lufs).toFixed(1)} dB, but the master compresses: dense tracks need about 1.4x that, or use AUTOTRIM=1), short-term max ${stats.shortTermMax.toFixed(1)} LUFS, true peak ${stats.truePeakDb.toFixed(2)} dBTP, sample peak ${stats.samplePeakDb.toFixed(2)} dBFS`,
      );
      lines.push(`  DC ${stats.dc[0].toExponential(1)} / ${stats.dc[1].toExponential(1)}   rms ${stats.rmsDb.toFixed(1)} dBFS   first/last sample ${L[0].toFixed(5)} / ${L[L.length - 1].toFixed(5)}`);
      lines.push(`  file: previews/album/${stem}.wav${specName ? ` and ${specName}` : ''}`);
      lines.push('\n  arrangement (bars, section, channels that play notes or hits in it):');
      lines.push(song.describe().split('\n').map((l) => `    ${l}`).join('\n'));
      if (process.env.CLASH === '1' || process.env.CLASH === '2') {
        lines.push(`\n  harmony check (CLASH=${process.env.CLASH}: notes a minor 2nd / minor 9th apart, a tone apart in the bass${process.env.CLASH === '2' ? ', and the synths\' upper octave layers' : ''}; bar, beat counted from 1):`);
        lines.push(song.clashes({ layers: process.env.CLASH === '2' }).split('\n').map((l) => `    ${l}`).join('\n'));
      }
      const auto = song.describeAutomation();
      if (auto) {
        const al = auto.split('\n');
        lines.push('\n  automation (path: bar:value points, (curve) into a point; lfo settings):');
        lines.push(al.slice(0, 40).map((l) => `    ${l}`).join('\n') + (al.length > 40 ? `\n    ... ${al.length - 40} more` : ''));
      }
      // per section
      const meter = new LoudnessMeter(SR);
      meter.push(L, R, L.length);
      const bandHead = BANDS.map(([n]) => n.split(' ')[0].padStart(5)).join(' ');
      lines.push(`\n  section              LUFS   TP dBTP  width dB  ${bandHead}   channels (rms dBFS over the whole section)`);
      const rowBands: number[][] = [];
      for (const row of rows) {
        const b0 = Math.floor(row.from / (SR * 0.1));
        const b1 = Math.max(b0 + 1, Math.floor(row.to / (SR * 0.1)) - 3);
        const lufs = integratedFromBlocks(meter.blocks, b0, Math.min(b1, meter.blocks.length));
        const tp = db(Math.max(truePeakLinear(L, row.from, row.to), truePeakLinear(R, row.from, row.to)));
        const st = stereoStats(L, R, row.from, row.to);
        const mid = new Float32Array(row.to - row.from);
        for (let i = row.from; i < row.to; i++) mid[i - row.from] = 0.5 * (L[i] + R[i]);
        const bands = bandDb(mid, SR);
        rowBands.push(bands);
        const n = Math.max(1, row.to - row.from);
        const ch = row.meters
          .map((m) => ({ name: m.name, rms: 10 * Math.log10(m.sum / (2 * n) + 1e-20) }))
          .filter((m) => m.rms > -90)
          .sort((a, b) => b.rms - a.rms)
          .map((m) => `${m.name} ${m.rms.toFixed(0)}`)
          .join(', ');
        if (!Number.isFinite(lufs) || tp < -100) {
          lines.push(`  ${row.name.padEnd(20)} silent`);
          continue;
        }
        lines.push(`  ${row.name.padEnd(20)} ${lufs.toFixed(1).padStart(5)}  ${tp.toFixed(1).padStart(7)}  ${st.widthDb.toFixed(1).padStart(8)}  ${bands.map((v) => v.toFixed(0).padStart(5)).join(' ')}   ${ch}`);
      }
      if (PER_CHANNEL) {
        // every channel that sounds, rendered alone with the master's glue and saturation off, so that the bands add up the way the mix's do
        const heard = new Set<string>();
        for (const row of rows) for (const m of row.meters) if (10 * Math.log10(m.sum / (2 * Math.max(1, row.to - row.from)) + 1e-20) > -90) heard.add(m.name);
        const perChannel = new Map<string, number[][]>();
        for (const name of heard) {
          const s2 = def.build(SR);
          s2.solo([name]);
          s2.master.offsetDb = offset;
          s2.master.setParam('glue', 0);
          s2.master.setParam('sat', 0);
          const [l2, r2] = renderAll(s2.toRenderer());
          perChannel.set(
            name,
            rows.map((row) => {
              const mid = new Float32Array(row.to - row.from);
              for (let i = row.from; i < row.to; i++) mid[i - row.from] = 0.5 * (l2[i] + r2[i]);
              return bandDb(mid, SR);
            }),
          );
        }
        lines.push(`\n  bands per channel (BANDS=1; each channel rendered alone, same units as the table above; "." = more than 25 dB under the mix in that band):`);
        lines.push(`  ${'section / channel'.padEnd(22)}${bandHead}`);
        rows.forEach((row, ri) => {
          lines.push(`  ${row.name.padEnd(22)}${rowBands[ri].map((v) => v.toFixed(0).padStart(5)).join(' ')}   (the mix)`);
          const n = Math.max(1, row.to - row.from);
          const here = row.meters
            .map((m) => ({ name: m.name, rms: 10 * Math.log10(m.sum / (2 * n) + 1e-20) }))
            .filter((m) => m.rms > -90)
            .sort((a, b) => b.rms - a.rms);
          for (const m of here) {
            const b = perChannel.get(m.name)?.[ri];
            if (!b) continue;
            lines.push(`    ${m.name.padEnd(20)}${b.map((v, i) => (v < rowBands[ri][i] - 25 ? '.' : v.toFixed(0)).padStart(5)).join(' ')}`);
          }
        });
      }
      lines.push(
        '\n  how to read it:',
        '    LUFS    integrated loudness of the section (BS.1770, gated); TP = true peak of the section; width = side energy against mid in dB (0 = as wide as it gets, below -20 = nearly mono).',
        `    bands   power of the mono mix in each band, in dB re full scale (the mean square of that part of the signal: the eight bands add up to the mix's own, so a mix at -18 dBFS rms has its loudest bands near -22) (${BANDS.map(([n]) => n).join(', ')}): read a row left to right for the balance, a column top to bottom for the change between sections.`,
        '    channels  rms of each channel over the WHOLE section (post fader, left and right averaged, dBFS), loudest first: a part that plays one bar of eight reads 9 dB lower. Measured before the master, so a master.trim',
        '              fade does not show here. A preset alone at gain 0 reads 0 to 4 dB below its calibrated LUFS (README section 7), and the master compresses the sum.',
        '    spectrogram (SPEC=1)  time left to right (coloured strip = sections, bright lines = section starts, faint lines = every 4 bars, or every bar when BARS spans 16 bars or less), frequency bottom to top on a log scale from 30 Hz to 16 kHz, faint lines at 50/100/200/500/1k/2k/5k/10k Hz.',
      );
      const report = lines.join('\n') + '\n';
      process.stdout.write(report);
      save(`previews/album/${stem}.report.txt`, report);
      if (SOLO) return; // a solo render is for listening to one part: the album's gates are for the whole mix
      // the album's gates (the report above is written first, so that a failing track still shows its numbers)
      expect(Number.isFinite(stats.lufs)).toBe(true);
      expect(stats.truePeakDb, 'true peak must stay at or below -1 dBTP (lower s.setMaster trim)').toBeLessThanOrEqual(-0.99);
      expect(stats.lufs, `integrated loudness ${stats.lufs.toFixed(2)} LUFS is outside -15.5 .. -12.5: change s.setMaster({ trim }) (AUTOTRIM=1 finds the value)`).toBeGreaterThan(-15.5);
      expect(stats.lufs, `integrated loudness ${stats.lufs.toFixed(2)} LUFS is outside -15.5 .. -12.5: change s.setMaster({ trim }) (AUTOTRIM=1 finds the value)`).toBeLessThan(-12.5);
      expect(Math.abs(stats.dc[0]) + Math.abs(stats.dc[1]), 'DC offset').toBeLessThan(2e-3);
      expect(Math.abs(L[0]) + Math.abs(R[0]), 'the first sample must be silent (no click at the start)').toBeLessThan(1e-3);
      expect(Math.abs(L[L.length - 1]) + Math.abs(R[R.length - 1]), 'the last sample must be silent (the fade-out must reach zero)').toBeLessThan(1e-3);
    }, 900000);
  }
});
