// How even is the roll? Renders the off-beat F#1 sixteenths alone (no kick, no master glue) with the track's own key-synced bass patch and
// with the `rolling-bass` reese preset, and prints the rms of every note over eight bars. A psy roll should hit the same every sixteenth;
// the reese's free-running, detuned saws make it wander (measured: sd 1.6 dB over an 8 dB range; the key-synced patch: sd 0.03 dB).
//   node sandbox/album/run.mjs sandbox/album/lab/goa-roll.ts
import { defineTrack } from '../../../src/audio/album/song';
import type { SynthOpts } from '../../../src/audio/album/song';
import { renderAll } from './tools';

// a copy of the roll patch of third-eye-highway.ts (so that this script does not depend on where the track file lives)
const psyBass: SynthOpts = {
  mode: 'mono', voices: 1, mono: true,
  layers: [{ wave: 'saw', phase: 'reset' }],
  filter: 'ladder', cutoff: 600, res: 0.35, envAmt: 2.4, fAttack: 0.0005, fDecay: 0.09, fSustain: 0.2, fRelease: 0.01, keytrack: 0, velFilter: 0.2,
  attack: 0.0008, decay: 0.1, sustain: 0.6, release: 0.006, velAmp: 0.15, drive: 5, level: 17.5, // level: as loud as the reese roll it replaces
};

const sr = 48000;
const bpm = 145;
const line = '. F#1 F#1 F#1 . F#1 F#1 F#1 . F#1 F#1 F#1 . F#1 F#1 F#1';
for (const which of ['patch', 'rolling-bass'] as const) {
  const t = defineTrack({ id: 'roll', title: 'roll', genre: 'Test', bpm, bars: 9, tail: 0.5 }, (s) => {
    const b = which === 'patch' ? s.synth(psyBass, { name: 'bass' }) : s.reese('rolling-bass', { name: 'bass' });
    b.play(s.notes(line), 1, 8);
    s.setMaster({ glue: 0, sat: 0 });
  });
  const [l] = renderAll(t.build(sr).toRenderer());
  const step = 60 / bpm / 4;
  const vals: number[] = [];
  for (let k = 16; k < 16 * 9; k++) {
    if (k % 4 === 0) continue; // the kick's step
    const t0 = Math.round(k * step * sr);
    const t1 = t0 + Math.round(step * 0.8 * sr);
    let e = 0;
    for (let i = t0; i < t1; i++) e += l[i] * l[i];
    vals.push(10 * Math.log10(e / (t1 - t0) + 1e-12));
  }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  process.stdout.write(`${which.padEnd(13)} ${vals.length} notes: mean ${mean.toFixed(1)} dB, sd ${sd.toFixed(2)} dB, range ${Math.min(...vals).toFixed(1)} .. ${Math.max(...vals).toFixed(1)} dB\n`);
}
