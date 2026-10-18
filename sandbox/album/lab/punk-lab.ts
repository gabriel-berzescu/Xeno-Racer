/**
 * The punk sound lab (written for Flat Out): the numbers used as ears for the punk instruments (guitar, amp, string, bass guitar, acoustic kit).
 *   node sandbox/album/run.mjs sandbox/album/lab/punk-lab.ts [gtr|pm|lead|bass|kit|lvl|all] [--set preset:param=value ...]
 * gtr   1/3-octave spectrum of a chugging riff per rhythm preset against the reference curve of guitar-lab.ts, plus the 6-12 kHz share
 * pm    palm-muted against open chords: envelope and spectral centroid in time windows (a chug must be dark after its pick click)
 * lead  one held lead note: pitch track (vibrato depth and rate) and the harmonic levels
 * bass  bass guitar: band levels, centroid, attack, and how much of it lies above 400 Hz (the growl that cuts through guitars)
 * kit   acoustic kit kick and snare: peak, crest, centroid, decay, band split
 * lvl   loudness of the guitar, bass guitar and kit presets on the levels.ts patterns (targets -18 / -18 / -16 LUFS)
 */
import { defineTrack } from '../../../src/audio/album/song';
import type { Song } from '../../../src/audio/album/song';
import { renderAll, envelopeDb, centroid, bandDb, saveAlbumSpectrogram, saveWav, saveWaveform, db } from './tools';
import { welch, rms, fft } from '../../../src/audio/analysis';
import { measure } from '../../../src/audio/album/measure';
import { GUITAR_PRESETS, BASSG_PRESETS } from '../../../src/audio/album/instruments/guitar';
import { AKIT_PRESETS } from '../../../src/audio/album/instruments/acoustic-kit';

const sr = 48000;
const argv = process.argv.slice(2);
const what = argv.find((a) => !a.startsWith('--') && !a.includes('=')) ?? 'all';
const sets = argv.reduce<string[]>((acc, a, i) => (a === '--set' ? [...acc, argv[i + 1]] : acc), []);
const OUT = '.cache/album-lab/out/fo';

function applySets(ch: { inst: { setParam(k: string, v: number): void } }, preset: string): void {
  for (const kv of sets) {
    const [lhs, v] = kv.split('=');
    const [p, k] = lhs.includes(':') ? lhs.split(':') : ['*', lhs];
    if (p === '*' || p === preset) ch.inst.setParam(k, Number(v));
  }
}

type Make = (s: Song) => { play: (p: never, at: number, bars: number) => unknown; inst: { setParam(k: string, v: number): void } };
function render(make: Make, pat: (s: Song) => unknown, bars: number, bpm: number, preset: string, tail = 1): { l: Float32Array; r: Float32Array; m: Float32Array } {
  const def = defineTrack({ id: 'fo-lab', title: 'lab', genre: 'Test', bpm, bars, tail, fadeOut: 0.01 }, (s: Song) => {
    s.key('E', 'minor');
    const ch = make(s);
    applySets(ch, preset);
    ch.play(pat(s) as never, 0, bars);
    s.master.raw = true;
  });
  const [l, r] = renderAll(def.build(sr).toRenderer());
  const m = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) m[i] = 0.5 * (l[i] + r[i]);
  return { l, r, m };
}
const gtr = (preset: string): Make => (s) => s.guitar(preset, { gain: 0 }) as never;

const RIFF = '[A2,E3,A3]{pm} [A2,E3,A3]{pm} [A2,E3,A3]{pm} [A2,E3,A3]{pm} [C3,G3,C4]! . [D3,A3,D4] . | [A2,E3,A3]{pm} [A2,E3,A3]{pm} [E2,B2,E3]{pm} [E2,B2,E3]{pm} [G2,D3,G3]! . [A2,E3,A3]:2 .';
const OPEN = '[E2,B2,E3]!{ring}:2 [E2,B2,E3] [E2,B2,E3] [E2,B2,E3] [E2,B2,E3] [E2,B2,E3] [E2,B2,E3] | [C3,G3,C4] [C3,G3,C4] [C3,G3,C4] [C3,G3,C4] [D3,A3,D4] [D3,A3,D4] [D3,A3,D4] [D3,A3,D4]';
const CENTRES = [63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500];
const REF: Record<number, number> = { 63: -14, 80: -8, 100: -4, 125: -2, 160: 0, 200: 1, 250: 1, 315: 1, 400: 1, 500: 1, 630: 1, 800: 1, 1000: 0, 1250: 0, 1600: -1, 2000: -2, 2500: -4, 3150: -6, 4000: -9, 5000: -13, 6300: -19, 8000: -27, 10000: -35, 12500: -43 };

function thirdOct(x: Float32Array): number[] {
  const nfft = 16384;
  const p = welch(x, nfft, Math.round(0.3 * sr), x.length);
  const df = sr / nfft;
  const band = (fc: number): number => {
    let s = 0;
    for (let i = Math.floor(fc / Math.pow(2, 1 / 6) / df); i <= Math.ceil((fc * Math.pow(2, 1 / 6)) / df); i++) s += p[i];
    return s;
  };
  const ref = band(1000);
  return CENTRES.map((c) => 10 * Math.log10(band(c) / ref + 1e-12));
}


/** Power spectrum of exactly x[i0..i1) (Tukey window with 10 % tapers, zero-padded to nfft): for short windows right after an onset. */
function segPsd(x: Float32Array, i0: number, i1: number, nfft = 8192): Float64Array {
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const n = Math.min(nfft, i1 - i0);
  const taper = Math.max(1, Math.floor(n * 0.1));
  for (let i = 0; i < n; i++) {
    const w = i < taper ? 0.5 - 0.5 * Math.cos((Math.PI * i) / taper) : i >= n - taper ? 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / taper) : 1;
    re[i] = (x[i0 + i] ?? 0) * w;
  }
  fft(re, im);
  const out = new Float64Array(nfft / 2 + 1);
  for (let k = 0; k <= nfft / 2; k++) out[k] = (re[k] * re[k] + im[k] * im[k]) / n;
  return out;
}
function segCentroid(x: Float32Array, i0: number, i1: number, lo = 60, hi = 12000): number {
  const p = segPsd(x, i0, i1);
  const df = sr / 8192;
  let a = 0;
  let b = 0;
  for (let k = Math.ceil(lo / df); k <= Math.floor(hi / df); k++) {
    a += k * df * p[k];
    b += p[k];
  }
  return b > 0 ? a / b : 0;
}
/** Band levels (dB, relative to the loudest band) of x[i0..i1): sub bass lowmid mid upmid pres high air. */
function segBands(x: Float32Array, i0: number, i1: number): number[] {
  const p = segPsd(x, i0, i1);
  const df = sr / 8192;
  const edges = [20, 60, 150, 400, 1200, 3000, 6000, 12000, 22000];
  const v = edges.slice(0, -1).map((lo, i) => {
    let s = 0;
    for (let k = Math.ceil(lo / df); k < Math.floor(edges[i + 1] / df); k++) s += p[k];
    return 10 * Math.log10(s + 1e-30);
  });
  const top = Math.max(...v);
  return v.map((d) => d - top);
}

function spectrumTable(): void {
  console.log('--- rhythm spectrum, 1/3 octave re 1 kHz (riff of guitar-lab.ts at 180 BPM), and the open-chord eighths ---');
  console.log('preset'.padEnd(22) + CENTRES.map((c) => (c >= 1000 ? `${c / 1000}k` : String(c)).padStart(5)).join('') + '  rms err 125-8k');
  console.log('reference'.padEnd(22) + CENTRES.map((c) => String(REF[c]).padStart(5)).join(''));
  for (const preset of ['punk-guitar-L', 'punk-guitar-R', 'punk-guitar', 'power-chord-wall', 'crunch-guitar', 'metal-guitar']) {
    for (const [label, pat] of [['riff', RIFF], ['open', OPEN]] as const) {
      const { m } = render(gtr(preset), (s) => s.notes(pat, { free: true }), 8, 180, preset);
      if (label === 'riff' && preset === 'punk-guitar-L') {
        saveWav(`${OUT}-riff-${preset}.wav`, m, m, sr);
        saveAlbumSpectrogram(`${OUT}-riff-${preset}.spec.png`, m, sr, { barSec: (60 / 180) * 4 });
      }
      const rel = thirdOct(m);
      let e = 0;
      let k = 0;
      rel.forEach((v, i) => {
        if (CENTRES[i] >= 125 && CENTRES[i] <= 8000) {
          e += (v - REF[CENTRES[i]]) ** 2;
          k++;
        }
      });
      const b = bandDb(m, sr);
      console.log(`${preset} ${label}`.padEnd(22) + rel.map((v) => v.toFixed(0).padStart(5)).join('') + `  ${Math.sqrt(e / k).toFixed(1)} dB  high-upmid ${(b[6] - b[4]).toFixed(0)} dB`);
    }
  }
}

function palmMute(): void {
  console.log('--- palm mute vs open: rms dB and centroid (Hz) in windows after the pick (A5 chord, punk-guitar-L, one hit) ---');
  const wins: [number, number][] = [[0, 0.01], [0.01, 0.03], [0.03, 0.06], [0.06, 0.1], [0.1, 0.15], [0.15, 0.25], [0.25, 0.4]];
  console.log('window ms'.padEnd(26) + wins.map(([a, b]) => `${a * 1000}-${b * 1000}`.padStart(12)).join(''));
  for (const preset of ['punk-guitar-L', 'metal-guitar', 'punk-bass']) {
    for (const [label, pat] of [['pm', '. . . . [A2,E3,A3]{pm}:4 . . . . . . . .'], ['open', '. . . . [A2,E3,A3]:8 - - - - - - - . . . .']] as const) {
      const isBass = preset === 'punk-bass';
      const p2 = isBass ? pat.replace('[A2,E3,A3]', 'A1') : pat;
      const { m } = render(isBass ? (s) => s.bassGuitar(preset, { gain: 0 }) as never : gtr(preset), (s) => s.notes(p2, { free: true }), 1, 120, preset);
      const on = Math.round(0.5 * sr);
      const cells = wins.map(([a, b]) => {
        const i0 = on + Math.round(a * sr);
        const i1 = on + Math.round(b * sr);
        return `${db(rms(m, i0, i1)).toFixed(0).padStart(4)} ${String(Math.round(segCentroid(m, i0, i1))).padStart(6)} `;
      });
      console.log(`${preset} ${label}`.padEnd(26) + cells.join(''));
      if (label === 'pm' && preset === 'punk-guitar-L') saveWaveform(`${OUT}-pm.wave.png`, m, sr, 0.48, 0.3, 1);
    }
  }
}

function zeroCrossPitch(x: Float32Array, t0: number, t1: number, hop: number): { t: number; f: number }[] {
  const out: { t: number; f: number }[] = [];
  // band-limit around the fundamental by a crude two-pole low-pass, then measure periods between upward zero crossings
  const y = new Float32Array(x.length);
  let a = 0;
  let b = 0;
  const k = 1 - Math.exp((-2 * Math.PI * 900) / sr);
  for (let i = 0; i < x.length; i++) {
    a += k * (x[i] - a);
    b += k * (a - b);
    y[i] = b;
  }
  const ups: number[] = [];
  for (let i = Math.round(t0 * sr); i < Math.round(t1 * sr); i++) if (y[i - 1] <= 0 && y[i] > 0) ups.push(i - y[i] / (y[i] - y[i - 1]));
  for (let j = 1; j < ups.length; j++) out.push({ t: ups[j] / sr, f: sr / (ups[j] - ups[j - 1]) });
  const res: { t: number; f: number }[] = [];
  for (let t = t0; t < t1; t += hop) {
    const sel = out.filter((o) => o.t >= t && o.t < t + hop);
    if (sel.length) res.push({ t, f: sel.reduce((s, o) => s + o.f, 0) / sel.length });
  }
  return res;
}

function lead(): void {
  console.log('--- lead-guitar: one held E5 (659.3 Hz) for 2 s at 120 BPM: pitch in cents against E5 every 50 ms, then the harmonic levels ---');
  const { m } = render(gtr('lead-guitar'), (s) => s.notes('E5:32', { free: true }), 2, 120, 'lead-guitar');
  saveWav(`${OUT}-lead.wav`, m, m, sr);
  const pt = zeroCrossPitch(m, 0.02, 1.9, 0.05);
  console.log(pt.map((p) => `${(1200 * Math.log2(p.f / 659.255)).toFixed(0)}`).join(' '));
  const pp = welch(m, 32768, Math.round(0.1 * sr), Math.round(1.0 * sr));
  const dff = sr / 32768;
  const hs: number[] = [];
  for (let h = 1; h <= 12; h++) {
    let mx = 0;
    for (let i = Math.round((659.255 * h * 0.97) / dff); i <= Math.round((659.255 * h * 1.03) / dff); i++) mx = Math.max(mx, pp[i]);
    hs.push(mx);
  }
  const top = Math.max(...hs);
  console.log(hs.map((v, i) => `h${i + 1}:${(10 * Math.log10(v / top + 1e-12)).toFixed(0)}`).join(' '));
  const e = envelopeDb(m, sr, 50, 100).db.slice(0, 20).map((v) => v.toFixed(0)).join(' ');
  console.log(`envelope (50 ms rms every 100 ms): ${e}`);
}

function bass(): void {
  console.log('--- bass guitar presets: eighths A1 C2 D2 E2 at 190 BPM: bands (dB re full scale), centroid, share above 400 Hz ---');
  console.log('preset'.padEnd(16) + ['sub', 'bass', 'lowmid', 'mid', 'upmid', 'pres', 'high', 'air'].map((x) => x.padStart(7)).join('') + '  centroid  >400Hz  LUFS');
  for (const preset of Object.keys(BASSG_PRESETS)) {
    const pat = 'A1 A1 A1 A1 A1 A1 A1 A1 | C2 C2 C2 C2 D2 D2 E2 E2';
    const { l, r, m } = render((s) => s.bassGuitar(preset, { gain: 0 }) as never, (s) => s.notes(pat, { free: true, res: 2 }), 4, 190, preset);
    const b = bandDb(m, sr);
    const tot = b.reduce((a, v) => a + Math.pow(10, v / 10), 0);
    const above = b.slice(3).reduce((a, v) => a + Math.pow(10, v / 10), 0);
    console.log(preset.padEnd(16) + b.map((v) => v.toFixed(0).padStart(7)).join('') + `  ${centroid(m, sr, 0, m.length, 30, 12000).toFixed(0).padStart(8)}  ${(10 * Math.log10(above / tot)).toFixed(1).padStart(6)}  ${measure(l, r, sr).lufs.toFixed(1)}`);
    if (preset === 'punk-bass') {
      saveWav(`${OUT}-bass.wav`, m, m, sr);
      saveAlbumSpectrogram(`${OUT}-bass.spec.png`, m, sr, { barSec: (60 / 190) * 4 });
    }
  }
}

function kit(): void {
  console.log('--- acoustic kit: single hits (kick, snare, rim, tomHi, tomLo, crash) of punk-kit at velocity 0.9: peak, rms first 50 ms, crest, centroid 0-30 ms / 30-150 ms, -20/-40 dB times, bands of the first 0.2 s ---');
  for (const preset of ['punk-kit', 'rock-kit', 'dry-kit']) {
    for (const part of ['kick', 'snare', 'rim', 'tomHi', 'tomLo']) {
      const lanes: Record<string, string> = { [part]: '....x...........' };
      const { m } = render((s) => s.acousticKit({ preset, room: 0 }, { gain: 0 }) as never, (s) => s.drums(lanes, { free: true }), 1, 120, preset, 0.6);
      const on = Math.round(0.5 * sr);
      const pk = Math.max(...Array.from(m.subarray(on, on + Math.round(0.3 * sr)), Math.abs));
      const r50 = rms(m, on, on + Math.round(0.05 * sr));
      const e = envelopeDb(m.subarray(on - 96), sr, 5, 2);
      let pi = 0;
      e.db.forEach((v, i) => {
        if (v > e.db[pi]) pi = i;
      });
      const after = (th: number): number => {
        let last = pi;
        for (let i = pi; i < e.db.length; i++) if (e.db[i] > e.db[pi] - th) last = i;
        return (e.t[last] - e.t[pi]) * 1000;
      };
      const b = segBands(m, on - 96, on + Math.round(0.2 * sr));
      const bc = segBands(m, on - 48, on + Math.round(0.008 * sr));
      console.log(`${preset.padEnd(9)} ${part.padEnd(6)} peak ${db(pk).toFixed(1).padStart(5)}  rms50 ${db(r50).toFixed(1).padStart(5)}  crest ${(db(pk) - db(r50)).toFixed(1).padStart(4)}  cent ${segCentroid(m, on - 48, on + 1440, 30, 16000).toFixed(0).padStart(5)} / ${segCentroid(m, on + 1440, on + 7200, 30, 16000).toFixed(0).padStart(5)}  -20dB ${after(20).toFixed(0).padStart(4)} ms -40dB ${after(40).toFixed(0).padStart(4)} ms  bands 0-200ms ${b.map((v) => v.toFixed(0)).join(' ')}  first 8ms ${bc.map((v) => v.toFixed(0)).join(' ')}`);
      if (preset === 'punk-kit') saveWaveform(`${OUT}-kit-${part}.wave.png`, m, sr, 0.49, 0.25, 1);
    }
  }
  const beat = render((s) => s.acousticKit('punk-kit', { gain: 0 }) as never, (s) => s.drums({ kick: 'x...x...x...x...', snare: '..x...x...x...x.', hat: 'x.x.x.x.x.x.x.x.', crash: 'X...............' }, { free: true }), 4, 192, 'punk-kit');
  saveWav(`${OUT}-kit-beat.wav`, beat.l, beat.r, sr);
  saveAlbumSpectrogram(`${OUT}-kit-beat.spec.png`, beat.m, sr, { barSec: (60 / 192) * 4 });
}

function levels(): void {
  console.log('--- loudness of the presets on the levels.ts patterns at 120 BPM (targets: guitar -18, bass guitar -18, acoustic kit -16) ---');
  const GPAT = '[A2,E3,A3]{pm} [A2,E3,A3]{pm} [A2,E3,A3]{pm} [A2,E3,A3]{pm} [C3,G3,C4]! . [D3,A3,D4] . [A2,E3,A3]{pm} [A2,E3,A3]{pm} [E2,B2,E3]{pm} [E2,B2,E3]{pm} [G2,D3,G3]! . [A2,E3,A3] -';
  const rows: string[] = [];
  for (const preset of Object.keys(GUITAR_PRESETS)) {
    const { l, r } = render(gtr(preset), (s) => s.notes(GPAT, { free: true }), 4, 120, preset);
    rows.push(`guitar:${preset} ${measure(l, r, sr).lufs.toFixed(1)}`);
  }
  for (const preset of Object.keys(BASSG_PRESETS)) {
    const { l, r } = render((s) => s.bassGuitar(preset) as never, (s) => s.notes('A1 A1 A1 A1 A1 A1 A1 A1 C2 C2 C2 C2 D2 D2 E2 E2', { free: true }), 4, 120, preset);
    rows.push(`bass:${preset} ${measure(l, r, sr).lufs.toFixed(1)}`);
  }
  for (const preset of Object.keys(AKIT_PRESETS)) {
    const { l, r } = render((s) => s.acousticKit(preset) as never, (s) => s.drums({ kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' }, { free: true }), 4, 120, preset);
    rows.push(`kit:${preset} ${measure(l, r, sr).lufs.toFixed(1)}`);
  }
  console.log(rows.join('  |  '));
}

const t0 = performance.now();
if (what === 'gtr' || what === 'all') spectrumTable();
if (what === 'pm' || what === 'all') palmMute();
if (what === 'lead' || what === 'all') lead();
if (what === 'bass' || what === 'all') bass();
if (what === 'kit' || what === 'all') kit();
if (what === 'lvl' || what === 'all') levels();
console.log(`(${((performance.now() - t0) / 1000).toFixed(1)} s)`);
