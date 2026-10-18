/**
 * Numbers for every electronic drum preset (one hit each, master bypassed): peak, loudness, spectral centroid, decay times and where
 * the energy sits, and for kicks the pitch trajectory (from successive upward zero crossings). To judge the sounds without listening
 * and to check them against the textbook figures: an 808 kick settles at 45-60 Hz and rings for 0.5 s or more, a techno kick drops from
 * 150-250 Hz to 45-55 Hz in 30-60 ms and is over in 0.2-0.4 s, a snare has a body at 170-250 Hz and noise up to 8 kHz and lasts 0.15-0.3 s,
 * a closed hat is bright (centroid over 6 kHz) and under 100 ms, an open hat rings for 0.2-0.5 s.
 *   node sandbox/album/run.mjs sandbox/album/lab/drum-report.ts [kick|snare|clap|hat|tom|cymbal|perc]
 */
import { defineTrack } from '../../../src/audio/album/song';
import type { Song } from '../../../src/audio/album/song';
import { DRUM_PRESETS } from '../../../src/audio/album/instruments/drums';
import { measure } from '../../../src/audio/album/measure';
import { centroid, decayTime, renderAll } from './tools';
import { welch } from '../../../src/audio/analysis';

const filter = process.argv[2] ?? '';
const sr = 48000;

function bandFractions(x: Float32Array, n: number): number[] {
  const p = welch(x, 8192, 0, n);
  const df = sr / 8192;
  const edges = [0, 60, 200, 1000, 5000, 24000];
  const tot = p.reduce((a, b) => a + b, 0) + 1e-30;
  return edges.slice(0, -1).map((lo, i) => {
    let s = 0;
    for (let k = Math.floor(lo / df); k < Math.min(p.length, Math.floor(edges[i + 1] / df)); k++) s += p[k];
    return s / tot;
  });
}

function zeroCrossFreqs(x: Float32Array, times: number[]): string {
  const ups: number[] = [];
  for (let i = 1; i < Math.min(x.length, Math.round(0.6 * sr)); i++) {
    if (x[i - 1] <= 0 && x[i] > 0) ups.push(i - x[i] / (x[i] - x[i - 1]));
  }
  return times
    .map((t) => {
      const k = ups.findIndex((u) => u / sr >= t);
      if (k < 0 || k + 1 >= ups.length) return '   -';
      return (sr / (ups[k + 1] - ups[k])).toFixed(0).padStart(4);
    })
    .join(' ');
}

console.log('preset            type    peak   LUFS  centroid  -20dB  -40dB   <60  60-200 200-1k 1-5k  >5k   pitch at 5,15,30,60,120,250 ms (kicks)');
for (const [name, p] of Object.entries(DRUM_PRESETS)) {
  if (filter && p.type !== filter) continue;
  const def = defineTrack({ id: 'dr', title: 'dr', genre: 'Test', bpm: 120, bars: 1, tail: 1.6, fadeOut: 0.01 }, (s: Song) => {
    const f = (s as unknown as Record<string, (o?: unknown, m?: unknown) => ReturnType<Song['add']>>)[p.type];
    const ch = f.call(s, name, { gain: 0 });
    if (p.type === 'tom') ch.note(0, 'A2', 0.5, 0.9);
    else if (p.opts.reverse) ch.note(0, 'A3', 3.9, 0.9);
    else ch.hit(0, '', 0.9);
    s.master.raw = true;
  });
  const [l, r] = renderAll(def.build(sr).toRenderer());
  const mono = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) mono[i] = 0.5 * (l[i] + r[i]);
  const m = measure(l, r, sr);
  const d40 = decayTime(mono, sr, 40);
  const d20 = decayTime(mono, sr, 20);
  const win = Math.round(0.1 * sr);
  const c = centroid(mono, sr, 0, win);
  const bf = bandFractions(mono, win);
  const fr = p.type === 'kick' ? zeroCrossFreqs(mono, [0.005, 0.015, 0.03, 0.06, 0.12, 0.25]) : '';
  console.log(
    `${name.padEnd(17)} ${p.type.padEnd(7)} ${m.samplePeakDb.toFixed(1).padStart(5)} ${m.lufs.toFixed(1).padStart(6)} ${c.toFixed(0).padStart(8)} ${(d20.decay * 1000).toFixed(0).padStart(6)} ${(d40.decay * 1000).toFixed(0).padStart(6)}   ${bf.map((v) => (v * 100).toFixed(0).padStart(3) + '%').join(' ')}   ${fr}`,
  );
}
