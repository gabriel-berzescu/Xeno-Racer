/**
 * Evidence for the claims in the README's "Honest notes": numbers measured on the engine itself.
 *   node sandbox/album/run.mjs sandbox/album/lab/evidence.ts
 * 1. Aliasing of the band-limited oscillators (energy off the harmonic series, relative to the total).
 * 2. The growl's wobble: how far the spectral centroid swings and how fast.
 * 3. The acid line: an accent opens the filter wider than a plain note; a slide glides without retriggering.
 * 4. The supersaw: width of the stereo image and how wide the unison smears the pitch.
 * 5. The reese: the beating of its detuned saws.
 */
import { defineTrack } from '../../../src/audio/album/song';
import type { Song } from '../../../src/audio/album/song';
import { Osc } from '../../../src/audio/album/dsp/osc';
import { centroid, renderAll, stereoStats, envelopeDb } from './tools';
import { fft, powerSpectrum } from '../../../src/audio/analysis';

const sr = 48000;

// 1. aliasing ----------------------------------------------------------------------------------
console.log('--- aliasing of the band-limited oscillators (48 kHz): off-harmonic energy relative to the signal, dB ---');
{
  const N = 65536;
  for (const wave of ['saw', 'square', 'tri'] as const) {
    const cells: string[] = [];
    for (const target of [110, 440, 1000, 2000, 4000]) {
      let k = Math.round((target * N) / sr);
      if (k % 2 === 0) k += 1; // odd: coprime with N
      const f0 = (k * sr) / N;
      const o = new Osc(wave);
      const re = new Float64Array(N);
      const im = new Float64Array(N);
      for (let i = 0; i < N; i++) re[i] = o.next(f0 / sr);
      // the block holds exactly k periods, so a rectangular window puts every true harmonic on a bin that is a multiple of k and
      // leaks nothing: all the energy on other bins is aliasing (or oscillator error)
      fft(re, im);
      let harm = 0;
      let off = 0;
      for (let b = 1; b < N / 2; b++) {
        const p = re[b] * re[b] + im[b] * im[b];
        if (b % k === 0) harm += p;
        else off += p;
      }
      cells.push(`${Math.round(f0)} Hz: ${(10 * Math.log10(off / harm + 1e-30)).toFixed(0).padStart(4)}`);
    }
    console.log(`${wave.padEnd(7)} ${cells.join('   ')}`);
  }
}

function track(bpm: number, bars: number, build: (s: Song) => void, tail = 0.5): { l: Float32Array; r: Float32Array } {
  const def = defineTrack({ id: 'ev', title: 'ev', genre: 'Test', bpm, bars, tail, fadeOut: 0.01 }, (s) => {
    s.key('A', 'minor');
    build(s);
    s.master.raw = true;
  });
  const [l, r] = renderAll(def.build(sr).toRenderer());
  return { l, r };
}

// 2. growl wobble ---------------------------------------------------------------------------
console.log('--- growl: spectral centroid (150 Hz - 10 kHz) over time for a held A1 at 140 BPM, lfoRate 1 (quarter notes) ---');
{
  const { l } = track(140, 2, (s) => {
    s.growl('dubstep-growl', { gain: 0 }).set('lfoRate', 1).play(s.notes('A1:32', { free: true }), 0, 2);
  });
  const hop = Math.round(0.02 * sr);
  const cs: number[] = [];
  for (let st = Math.round(0.3 * sr); st + 4096 < Math.round(3.2 * sr); st += hop) cs.push(centroid(l, sr, st, st + 4096, 150, 10000));
  const mn = Math.min(...cs);
  const mx = Math.max(...cs);
  let crossings = 0;
  const mid = (mn + mx) / 2;
  for (let i = 1; i < cs.length; i++) if (cs[i - 1] < mid && cs[i] >= mid) crossings++;
  const secs = (cs.length * hop) / sr;
  console.log(`centroid ${mn.toFixed(0)} .. ${mx.toFixed(0)} Hz, ${(crossings / secs).toFixed(2)} cycles/s (a quarter note at 140 BPM is ${(140 / 60).toFixed(2)} cycles/s)`);
}

// 3. acid ----------------------------------------------------------------------------------------
console.log('--- acid: a plain A1 against an accented A1!, and a slide A1 -> E2 ---');
{
  const plain = track(120, 1, (s) => void s.acid('acid-303', { gain: 0 }).play(s.notes('A1:4 . . . . . . . . . . . .'), 0, 1)).l;
  const acc = track(120, 1, (s) => void s.acid('acid-303', { gain: 0 }).play(s.notes('A1!:4 . . . . . . . . . . . .'), 0, 1)).l;
  const c = (x: Float32Array): number => centroid(x, sr, Math.round(0.004 * sr), Math.round(0.004 * sr) + 1024, 150, 12000);
  const pk = (x: Float32Array): number => Math.max(...Array.from(x.subarray(0, Math.round(0.3 * sr)), Math.abs));
  console.log(`plain: centroid ${c(plain).toFixed(0)} Hz, peak ${pk(plain).toFixed(3)}   accent: centroid ${c(acc).toFixed(0)} Hz, peak ${pk(acc).toFixed(3)}`);
  const sl = track(120, 1, (s) => void s.acid('acid-303', { gain: 0 }).play(s.notes('A1 - - - E2~ - - - . . . . . . . .'), 0, 1)).l;
  const hop = Math.round(0.02 * sr);
  const env = (x: Float32Array): string => envelopeDb(x, sr, 20, 20).db.slice(Math.round(0.5 / 0.02) - 4, Math.round(0.5 / 0.02) + 6).map((v) => v.toFixed(0)).join(' ');
  void hop;
  const retrig = track(120, 1, (s) => void s.acid('acid-303', { gain: 0 }).play(s.notes('A1 - - - E2 - - - . . . . . . . .'), 0, 1)).l;
  console.log(`envelope (dB, 20 ms steps) from 0.42 s to 0.62 s, the note changes at 0.5 s:
  slide ~   ${env(sl)}
  retrigger ${env(retrig)}`);
  // pitch trajectory by upward zero crossings around the slide
  const ups: number[] = [];
  for (let i = Math.round(0.4 * sr); i < Math.round(0.9 * sr); i++) if (sl[i - 1] <= 0 && sl[i] > 0) ups.push(i);
  const fs = ups.slice(1).map((u, i) => [u / sr, sr / (u - ups[i])]);
  const sample = fs.filter((_, i) => i % Math.ceil(fs.length / 12) === 0).map(([t, f]) => `${(t * 1000).toFixed(0)}ms:${f.toFixed(0)}`);
  console.log(`pitch (zero-crossing estimate): ${sample.join('  ')}`);
}

// 4. supersaw ------------------------------------------------------------------------------------
console.log('--- supersaw chord: stereo image and pitch smear of one note A3 ---');
{
  const { l, r } = track(120, 2, (s) => void s.synth('supersaw-chord', { gain: 0 }).play(s.notes('A3:16 | . . . . . . . . . . . . . . . .'), 0, 2), 1);
  const st = stereoStats(l, r, Math.round(0.3 * sr), Math.round(1.5 * sr));
  const nfft = 65536;
  const p = powerSpectrum(l, Math.round(0.4 * sr), nfft);
  const df = sr / nfft;
  const f0 = 220;
  let tot = 0;
  let near = 0;
  for (let b = Math.floor(100 / df); b < Math.floor(1000 / df); b++) {
    tot += p[b];
    if (Math.abs(b * df - f0) < f0 * 0.012) near += p[b];
  }
  console.log(`side/mid ${st.widthDb.toFixed(1)} dB, L/R correlation ${st.corr.toFixed(2)}, ${(100 * near / tot).toFixed(0)} % of the 100-1000 Hz energy within +-1.2 % (20 cents) of the 220 Hz fundamental`);
}

// 5. reese ---------------------------------------------------------------------------------------
console.log('--- reese: amplitude beating of a held A1 (envelope of the output, 10 ms) ---');
{
  const { l } = track(120, 2, (s) => void s.reese('reese', { gain: 0 }).play(s.notes('A1:32', { free: true }), 0, 2), 0.2);
  const e = envelopeDb(l, sr, 10, 10);
  const seg = e.db.slice(30, 300);
  console.log(`level ranges ${Math.min(...seg).toFixed(1)} .. ${Math.max(...seg).toFixed(1)} dB over 2.7 s (the swirl of the detuned saws)`);
}
