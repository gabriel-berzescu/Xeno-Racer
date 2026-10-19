/**
 * Render speed of a dense 3.5-minute track (the stress track: a dozen busy channels with reverb, delay, sidechain and master):
 *   node sandbox/album/run.mjs sandbox/album/lab/speed.ts [bars] [bpm]
 * Prints the length, the time it took on one core and the speed as a multiple of real time (the target is 10x or better).
 */
import { renderAll } from './tools';
import { stressTrack } from './stress-song';
import { measure } from '../../../src/audio/album/measure';

const bars = Number(process.argv[2] ?? 112);
const bpm = Number(process.argv[3] ?? 128);
const sr = 48000;
const def = stressTrack(bars, bpm);
const t0 = performance.now();
const r = def.build(sr).toRenderer();
const tBuild = performance.now() - t0;
const t1 = performance.now();
const [l, rr] = renderAll(r);
const dt = (performance.now() - t1) / 1000;
const secs = r.frames / sr;
const m = measure(l, rr, sr);
console.log(`${secs.toFixed(1)} s of audio (${bars} bars at ${bpm} BPM), built in ${tBuild.toFixed(0)} ms, rendered in ${dt.toFixed(2)} s = ${(secs / dt).toFixed(1)}x real time; ${m.lufs.toFixed(1)} LUFS, ${m.truePeakDb.toFixed(2)} dBTP`);
