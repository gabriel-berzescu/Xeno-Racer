// Example track: a short Goa trance piece (142 BPM, F# phrygian): a psy kick, the off-beat rolling bass, a 303 acid line, a trance-gated pad, an arp
// and a lead, a break with a riser and a reverse crash. Written by following src/audio/album/README.md. It is not part of the album.
// Probe it:  ALBUM=1 TRACK=sandbox/album/examples/goa.ts AUTOTRIM=1 SPEC=1 npx vitest run tests/probes/album-render.test.ts
// To build on it, copy it to src/audio/album/tracks/<id>.ts, change the import to '../song' and the id to the file name.
import { defineTrack, fx } from '../../../src/audio/album/song';

export default defineTrack({ id: 'example-goa', title: 'Example Goa', genre: 'Test', bpm: 142, bars: 28, tail: 3 }, (s) => {
  s.key('F#', 'phrygian');
  const S = s.sections({ intro: 4, groove: 8, break: 4, drop: 8, outro: 4 });
  const prog = s.chords('F#m | G | F#m | Em', { octave: 3, lead: true }); // i - bII - i - bvii

  // ── instruments ──
  const kick = s.kick('psy-kick', { gain: -3 });
  const bass = s.reese('rolling-bass', { name: 'bass', gain: -6, duck: 1 }); // short notes, narrow: made for the sixteenths after each kick
  const acid = s.acid('goa-acid', { gain: -9, delay: 0.15, pan: -0.1 });
  const arp = s.synth('trance-pluck', { name: 'arp', gain: -7, delay: 0.25, reverb: 0.15, pan: 0.15, fx: [fx.filter({ mode: 'lp', cutoff: 1200 })] });
  const lead = s.synth('trance-lead', { name: 'lead', gain: -6, delay: 0.3, reverb: 0.25 });
  const pad = s.synth('supersaw-pad', { name: 'pad', gain: -12, duck: 0.7, reverb: 0.3, fx: [fx.gate({ pattern: 'x.xx.x.xx.x.xx.x' })] });
  const hat = s.hat('closed-hat', { name: 'ohat', gain: -10, pan: 0.2 });
  const shaker = s.perc('shaker', { name: 'shaker', gain: -13, pan: -0.25 });
  const tamb = s.perc('tambourine', { name: 'tamb', gain: -10, pan: 0.3 });
  const riser = s.riser('riser', { gain: -9 });
  const boom = s.impact('impact', { name: 'boom', gain: -4 });
  const crash = s.cymbal('crash', { gain: -6, reverb: 0.2 });
  const swell = s.cymbal('reverse-crash', { name: 'swell', gain: -8 });

  // ── patterns ──
  const four = s.hits('X...X...X...X...');
  const roll = prog.roots({ rhythm: '.xxx.xxx.xxx.xxx', low: 28 }); // the off-beat rolling bass on the chord roots
  // a slide (~) goes on the note you glide INTO and must follow another note directly: G2 -> A2, E2 -> F#2, G2 -> G3 ...
  const acidA = s.notes('F#2 . F#3! F#2 G2 A2~ F#2 . F#2 F#2 C#3! . E2 F#2~ G2 F#2!');
  const acidB = s.notes('F#2 F#3! F#2 . G2 G3!~ F#2 E2 F#2 . A2 C#3~ D3 C#3 . F#2!');
  const arpLine = s.arp(prog, { order: 'up', octaves: 2, res: 4 }).transpose(12);
  const hook = s.notes('F#4 - - - G4 - A4~ - C#5 - - - B4~ - A4 - | G4 - - - - - F#4~ - E4 - - - F#4 - - -');
  const ohats = s.hits('..o...o...o...o.');
  const shake = s.hits('x.xxx.xxx.xxx.xx');
  const tambs = s.hits('....x.......x...');

  // ── arrangement ──
  kick.play(four, S.intro.bar, S.intro.bars + S.groove.bars);
  kick.play(four, S.drop.bar, S.drop.bars + S.outro.bars);
  bass.play(roll, S.groove);
  bass.play(roll, S.drop);
  bass.play(roll, S.outro.bar, 2);
  acid.play(acidA, S.groove);
  acid.play(acidA.then(acidB), S.drop);
  acid.play(acidA, S.outro.bar, 2);
  arp.play(arpLine, S.groove.bar + 4, 4 + S.break.bars + S.drop.bars);
  lead.play(hook, S.drop);
  pad.play(prog, S.intro);
  pad.play(prog, S.break.bar, S.break.bars + S.drop.bars + S.outro.bars);
  hat.play(ohats, S.groove);
  hat.play(ohats, S.drop.bar, S.drop.bars + S.outro.bars);
  shaker.play(shake, S.intro.bar, S.intro.bars + S.groove.bars + S.break.bars + S.drop.bars + S.outro.bars);
  tamb.play(tambs, S.drop);
  riser.hit(S.break.bar, '', 1, 0, 16); // the whole break: 16 beats of sweep
  boom.hit(S.drop.bar, '', 1);
  crash.hit(S.drop.bar, '', 1);
  swell.note(S.drop.bar - 1, 'A3', 4, 1); // a reverse crash that ends on the drop (its pitch does not matter)

  // ── automation ──
  acid.auto('cutoff', [[S.groove.bar, 300], [S.groove.end, 2000, 'exp'], [S.drop.bar, 900, 'step'], [S.drop.end, 2400, 'exp'], [S.outro.bar + 2, 400, 'exp']]);
  arp.auto('fx.filter.cutoff', [[S.groove.bar + 4, 600], [S.break.bar, 1500, 'exp'], [S.drop.bar, 9000, 'exp']]);
  pad.auto('mix.hp', [[S.break.bar, 20], [S.drop.bar - 0.25, 900, 'exp'], [S.drop.bar, 20, 'step']]);
  pad.auto('fx.gate.depth', [[S.break.bar, 0.4], [S.drop.bar, 1, 'step']]); // a soft gate in the break, the full chop in the drop
  bass.lfo('cutoff', { period: 4, depth: 0.5, mode: 'exp', from: S.drop.bar, to: S.outro.bar });

  // ── mix ──
  s.setReverb({ time: 3, return: -9 });
  s.setDelay({ time: '1/8.', feedback: 0.35 });
  s.setSidechain({ release: 0.1 }); // the duck is gone 0.1 s after its hold: the first off-beat sixteenth (0.106 s after the kick) is within 0.1 dB of full level
  const TRIM = 3.4; // master trim in dB, found with the probe's AUTOTRIM=1 (README section 8, "Master")
  s.setMaster({ trim: TRIM });
  s.auto('master.trim', [[S.outro.bar + 2, TRIM], [S.outro.end, TRIM - 6]]); // fade the last two bars
});
