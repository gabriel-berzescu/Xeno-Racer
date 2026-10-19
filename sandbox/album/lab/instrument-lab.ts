/**
 * Instrument lab: renders one instrument preset in isolation (master bypassed) and reports what it sounds like in numbers,
 * with a WAV, a spectrogram and a waveform in .cache/album-lab/out/. Run with:
 *
 *   node sandbox/album/run.mjs sandbox/album/lab/instrument-lab.ts kick darksynth-kick
 *   node sandbox/album/run.mjs sandbox/album/lab/instrument-lab.ts synth supersaw-pad --pat "A2 - - - - - - - | A2 - - - - - - -" --bars 2
 *   node sandbox/album/run.mjs sandbox/album/lab/instrument-lab.ts hat closed-hat --pat "x.x.x.o.x.x.x.o." --bpm 140
 *
 * Arguments: <factory> [preset] [--pat text] [--bpm n] [--bars n] [--sr n] [--set param=value ...] [--tail seconds]
 */
import { defineTrack } from '../../../src/audio/album/song';
import type { Song } from '../../../src/audio/album/song';
import { bandReport, centroid, decayTime, renderAll, saveAlbumSpectrogram, saveWav, saveWaveform, db, stereoStats } from './tools';
import { peakAbs, rms } from '../../../src/audio/analysis';
import { measure } from '../../../src/audio/album/measure';

const argv = process.argv.slice(2);
const opt = (name: string, def?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && argv[i - 1] !== '--solo'));
const factory = positional[0] ?? 'kick';
const preset = positional[1];
const sr = Number(opt('sr', '48000'));
const bpm = Number(opt('bpm', '120'));
const bars = Number(opt('bars', '2'));
const tail = Number(opt('tail', '1.5'));
const sets = argv.reduce<string[]>((acc, a, i) => (a === '--set' ? [...acc, argv[i + 1]] : acc), []);

const DRUMS = ['kick', 'snare', 'clap', 'hat', 'tom', 'cymbal', 'perc'];
const KITS = ['acousticKit', 'drumKit'];
const lanesArg = opt('lanes');
const defaultLanes: Record<string, string> = { kick: 'x...x..x..x.x...', snare: '....x.g.....x..o'.replace('o', 'x'), hat: 'x.x.x.x.x.x.x.o.', crash: 'X...............' };
const defaultPat = (): string => {
  if (DRUMS.includes(factory)) {
    if (factory === 'hat') return 'x.x.x.x.x.x.x.o. | x.x.x.x.x.x.x.x.'.replace(/ /g, '').replace('|', '');
    if (factory === 'cymbal') return 'X...............';
    return 'X...x...x...x...';
  }
  return 'A2 . . . A2 - - - | E3 . . . E3 - - -'.replace('|', '|');
};
const pat = opt('pat', defaultPat()) as string;

const def = defineTrack({ id: `lab-${factory}`, title: 'Lab', genre: 'Test', bpm, bars, tail }, (s: Song) => {
  s.key('A', 'minor');
  const f = (s as unknown as Record<string, (o?: unknown, m?: unknown) => ReturnType<Song['add']>>)[factory];
  if (typeof f !== 'function') throw new Error(`no factory "${factory}" on Song`);
  const ch = f.call(s, preset, { gain: 0 });
  for (const kv of sets) {
    const [k, v] = kv.split('=');
    ch.inst.setParam(k, Number(v));
  }
  let p;
  if (KITS.includes(factory)) {
    const lanes = lanesArg ? Object.fromEntries(lanesArg.split(',').map((kv) => kv.split(':') as [string, string])) : defaultLanes;
    p = s.drums(lanes, { free: true });
  } else p = DRUMS.includes(factory) ? s.hits(pat, { free: true }) : s.notes(pat, { free: true });
  ch.play(p, 0, bars);
  s.setMaster({ trim: 0 });
  s.master.raw = true;
});

const song = def.build(sr);
const r = song.toRenderer();
const t0 = performance.now();
const [L, R] = renderAll(r);
const dt = (performance.now() - t0) / 1000;
const name = `${factory}${preset ? '-' + preset : ''}`;
const out = `.cache/album-lab/out/${name}`;
saveWav(`${out}.wav`, L, R, sr);
const mono = new Float32Array(L.length);
for (let i = 0; i < L.length; i++) mono[i] = 0.5 * (L[i] + R[i]);
saveAlbumSpectrogram(`${out}.spec.png`, mono, sr, { barSec: (60 / bpm) * 4 }); // the probe's picture: log frequency 30 Hz - 16 kHz, faint lines every 4 bars
saveWaveform(`${out}.wave.png`, mono, sr, 0, Math.min(0.6, L.length / sr), 3);
const pk = peakAbs(L);
const rm = rms(L);
const m = measure(L, R, sr);
const dec = decayTime(mono.subarray(0, Math.min(mono.length, Math.round(0.9 * sr))), sr, 40);
const st = stereoStats(L, R);
console.log(`${name}: ${(L.length / sr).toFixed(2)} s rendered in ${(dt * 1000).toFixed(0)} ms (${((L.length / sr) / dt).toFixed(0)}x real time)`);
console.log(`  peak ${db(pk).toFixed(1)} dBFS  rms ${db(rm).toFixed(1)} dBFS  crest ${(db(pk) - db(rm)).toFixed(1)} dB  LUFS ${m.lufs.toFixed(1)}  true peak ${m.truePeakDb.toFixed(1)} dBTP`);
console.log(`  centroid ${centroid(mono, sr, 0, Math.min(mono.length, sr)).toFixed(0)} Hz   first peak at ${(dec.peakAt * 1000).toFixed(1)} ms, -40 dB after ${(dec.decay * 1000).toFixed(0)} ms   stereo corr ${st.corr.toFixed(2)} width ${st.widthDb.toFixed(1)} dB`);
console.log(`  bands (first 0.5 s): ${bandReport(mono, sr, 0, Math.min(mono.length, Math.round(0.5 * sr)))}`);
console.log(`  files: ${out}.wav .spec.png .wave.png`);
