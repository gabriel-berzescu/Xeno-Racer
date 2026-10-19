// A script that builds a track, prints its arrangement and automation without rendering anything, then renders it block by block (the way
// the player does) and measures it. Run any script like this one with:  node sandbox/album/run.mjs sandbox/album/lab/script-example.ts
import soundCheck from '../../../src/audio/album/sound-check'; // a track module: import it by path (the album's index.ts needs Vite)
import { measure } from '../../../src/audio/album/measure';

const sr = 48000;
const song = soundCheck.build(sr); // defineTrack(...) returns a TrackDef: build(sampleRate) composes the track and returns the Song
process.stdout.write(`${song.describe()}\n\n${song.describeAutomation()}\n\n`); // the arrangement (note counts, articulations) and the automation lanes

const r = song.toRenderer(); // the streaming renderer of the player: r.frames and r.render(l, r, n)
const L = new Float32Array(r.frames);
const R = new Float32Array(r.frames);
const bl = new Float32Array(4096);
const br = new Float32Array(4096);
for (let pos = 0; pos < r.frames; ) {
  const n = r.render(bl, br, Math.min(4096, r.frames - pos)); // any block size gives the same samples
  L.set(bl.subarray(0, n), pos);
  R.set(br.subarray(0, n), pos);
  pos += n;
}
const m = measure(L, R, sr); // integrated LUFS, true peak, DC ...
process.stdout.write(`${(r.frames / sr).toFixed(1)} s, ${m.lufs.toFixed(2)} LUFS, true peak ${m.truePeakDb.toFixed(2)} dBTP\n`); // console.log may be swallowed by vitest
