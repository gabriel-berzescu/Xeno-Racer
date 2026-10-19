/**
 * Profiles a track: time spent per channel, sends and master, as a share of the render time (best of several runs, since the
 * laptop is shared with other work).
 *   node sandbox/album/run.mjs sandbox/album/lab/profile.ts [track-id=sound-check|stress] [--sr 48000] [--runs 3]
 */
import soundCheck from '../../../src/audio/album/sound-check';
import { renderAll } from './tools';
import { stressTrack } from './stress-song';

const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const id = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'sound-check';
const sr = Number(arg('sr', '48000'));
const runs = Number(arg('runs', '3'));
const defs: Record<string, typeof soundCheck> = { 'sound-check': soundCheck, stress: stressTrack(32) };
const def = defs[id];
if (!def) throw new Error(`unknown track ${id} (the profiler only knows: ${Object.keys(defs).join(', ')})`);
let best: { total: number; times: Map<string, number>; seconds: number } | null = null;
for (let k = 0; k < runs; k++) {
  const r = def.build(sr).toRenderer();
  const times = new Map<string, number>();
  (r as unknown as { profile: unknown }).profile = { now: () => performance.now(), times };
  const t1 = performance.now();
  renderAll(r, 4096);
  const total = performance.now() - t1;
  if (!best || total < best.total) best = { total, times, seconds: r.frames / sr };
}
const b = best!;
console.log(`best of ${runs}: rendered ${b.seconds.toFixed(1)} s in ${(b.total / 1000).toFixed(2)} s = ${(b.seconds / (b.total / 1000)).toFixed(1)}x real time (${((b.total / b.seconds)).toFixed(1)} ms per second of audio)`);
const rows = [...b.times.entries()].sort((a, c) => c[1] - a[1]);
for (const [k, v] of rows) console.log(`  ${k.padEnd(14)} ${(v / b.seconds).toFixed(2).padStart(6)} ms/s  ${((100 * v) / b.total).toFixed(1).padStart(5)} %`);
