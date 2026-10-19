// Example track: a short darksynth piece (110 BPM, E minor) written by following src/audio/album/README.md. It is not part of the album.
// Probe it:  ALBUM=1 TRACK=sandbox/album/examples/darksynth.ts AUTOTRIM=1 SPEC=1 npx vitest run tests/probes/album-render.test.ts
// To build on it, copy it to src/audio/album/tracks/<id>.ts, change the import to '../song' and the id to the file name.
import { defineTrack, fx } from '../../../src/audio/album/song';
import type { SynthOpts } from '../../../src/audio/album/song';

const TRIM = 3.7; // master trim in dB, found with the probe's AUTOTRIM=1 (README section 8, "Master")

// README section 11: an own patch from the building blocks, a plain options object typed SynthOpts
const nightDrone: SynthOpts = {
  layers: [{ wave: 'saw', unison: 3, detune: 1 }, { wave: 'square', octave: -1, level: 0.45 }],
  filter: 'lp', cutoff: 650, res: 0.35, envAmt: 0.8, fAttack: 1.5, fDecay: 2.5, fSustain: 0.5,
  attack: 1.0, decay: 1, sustain: 0.9, release: 2.0, unisonDetune: 12, spread: 0.9,
  mods: [{ src: 'lfo1', dst: 'cutoff', amount: 1.2 }], lfo1Rate: 0.125, // one filter breath every two bars
};

export default defineTrack({ id: 'example-darksynth', title: 'Example Darksynth', genre: 'Test', bpm: 110, bars: 24, tail: 3 }, (s) => {
  s.key('E', 'minor');
  const S = s.sections({ intro: 4, groove: 8, drop: 8, outro: 4 });

  // ── instruments ──
  const kick = s.kick('darksynth-kick', { gain: -3 });
  const snare = s.snare({ preset: 'darksynth-snare', noiseTone: 2600 }, { gain: -4, eqHigh: -3, reverb: 0.12, fx: [fx.reverb({ gated: true })] });
  const clap = s.clap('big-clap', { gain: -9, reverb: 0.1 });
  const hat = s.hat('closed-hat', { gain: -7, pan: 0.15 });
  const crash = s.cymbal('crash', { gain: -12, reverb: 0.1 });
  const swell = s.cymbal('reverse-crash', { name: 'swell', gain: -12 });
  const bass = s.darkBass('darksynth-bass', { gain: -10, duck: 0.8 });
  const sub = s.sub('sub-sine', { gain: -8, duck: 0.8 });
  const pad = s.synth('supersaw-pad', { name: 'pad', gain: -10, reverb: 0.3, duck: 0.7, fx: [fx.chorus()] });
  const arp = s.synth('dark-pluck', { name: 'arp', gain: -6, reverb: 0.15, delay: 0.3, duck: 0.4 });
  const lead = s.synth('supersaw-lead', { name: 'lead', gain: -4, reverb: 0.25, delay: 0.3 });
  const drone = s.synth(nightDrone, { name: 'drone', gain: -8, reverb: 0.35, duck: 0.5 });
  const riser = s.riser('riser-dark', { gain: -10 });
  const down = s.riser('downlifter', { name: 'down', gain: -12, reverb: 0.2 });
  const boom = s.impact('impact', { name: 'boom', gain: -8, reverb: 0.2 });

  // ── patterns ──
  const chords = s.chords('Em | C | D | B7', { octave: 3, lead: true });
  const outroChords = s.chords('Em | C | D | Em', { octave: 3, lead: true });
  const four = s.hits('X...x...X...x...');
  const halfKick = s.hits('X.........x.....');
  const halfSnare = s.hits('........X.......');
  const backbeat = s.hits('....X.......X...');
  const hats8 = s.hits('x.x.x.x.x.x.x.xo');
  const hats16 = s.hits('xxXxxxXxxxXxxxXo');
  const roll = s.hits('1.2.3.4.5.6.7.8. | 1234567899999999');
  const grooveBass = chords.roots({ rhythm: 'x.xxx.xxx.xxX.xx', low: 28 });
  const dropBass = s.notes(
    'E1 E1 E2 E1 E1 E2 E1 E1 E2 E1 E1 E2 E1 E2! D2~ B1 | C2 C2 C3 C2 C2 C3 C2 C2 C3 C2 C2 C3 C2 C3! B2~ G2 | ' +
      'D2 D2 D3 D2 D2 D3 D2 D2 D3 D2 D2 D3 D2 D3! E3~ F#2 | B1 B1 B2 B1 B1 B2 B1 B1 B2 B1 B1 B2 D#2 F#2 A2! B2~',
  );
  const subLine = s.notes('E1:16 | C2:16 | D2:16 | B1:16');
  const hook = s.notes(
    'B4 - - - E5 - - - G5 - - - - - F#5 - | E5 - - - - - - - G5 - - - B5 - A5 - | ' +
      'A5 - - - F#5 - - - D5 - - - F#5 - A5 - | F#5 - - - - - D#5 - - - - - B4 - - -',
  );
  const droneNotes = s.notes('[E2,B2]:64');

  // ── arrangement ──
  // intro: drone, pad and an arp whose filter opens; hats in the second half
  drone.play(droneNotes, S.intro);
  pad.play(chords, S.intro.bar, S.intro.bars + S.groove.bars + S.drop.bars);
  arp.play(s.arp(chords, { order: 'updown', octaves: 2 }), S.intro.bar, S.intro.bars + S.groove.bars + S.drop.bars);
  hat.play(hats8, S.intro.bar + 2, 2);

  // groove: half-time drums and a filtered, quieter bass for four bars, then four on the floor into the build
  crash.hit(S.groove.bar, '', 0.8);
  kick.play(halfKick, S.groove.bar, 4);
  snare.play(halfSnare, S.groove.bar, 4);
  kick.play(four, S.groove.bar + 4, 3.75); // one beat of silence before the drop
  snare.play(backbeat, S.groove.bar + 4, 2);
  snare.play(roll, S.drop.bar - 2); // the roll over the last two bars
  hat.play(hats8, S.groove);
  bass.play(grooveBass, S.groove);
  bass.set('mix.gain', -5, S.drop.bar); // the bass is created at -10 dB and steps up for the drop
  hat.set('mix.gain', -4, S.drop.bar);

  // the build into the drop
  riser.hit(S.drop.bar - 4, '', 1, 0, 16);
  swell.note(S.drop.bar - 1, 'A3', 4, 1);

  // drop: the hook, a busier bass with the sub under it, sixteenth hats, the clap on the snare
  boom.hit(S.drop.bar, '', 1);
  crash.hit(S.drop.bar, '', 1);
  kick.play(four, S.drop);
  snare.play(backbeat, S.drop);
  clap.play(backbeat, S.drop);
  hat.play(hats16, S.drop);
  bass.play(dropBass, S.drop);
  sub.play(subLine, S.drop);
  lead.play(hook, S.drop, undefined, { vel: 0.9 });

  // outro: the drone and the pad on a resolving progression, the arp closes
  down.hit(S.outro.bar, '', 1, 0, 8);
  crash.hit(S.outro.bar, '', 0.7);
  drone.play(droneNotes, S.outro);
  pad.play(outroChords, S.outro);
  arp.play(s.arp(outroChords, { order: 'updown', octaves: 2 }), S.outro);
  hat.play(hats8, S.outro.bar, 2);

  // ── automation ──
  arp.ramp('cutoff', S.intro.bar, S.intro.end, 300, arp.param('cutoff'), 'exp'); // filter sweep: opens over the intro
  arp.ramp('cutoff', S.outro.bar, S.outro.end, arp.param('cutoff'), 300, 'exp'); // and closes over the outro
  bass.auto('cutoff', [[S.groove.bar, 260], [S.drop.bar, 700, 'exp']]); // the bass opens over the groove (700 = darksynth-bass default)
  pad.auto('mix.hp', [[S.drop.bar - 4, 20], [S.drop.bar - 0.0625, 800, 'exp'], [S.drop.bar, 20, 'step']]); // thin the pad before the drop
  bass.lfo('cutoff', { period: '1/2', depth: 0.6, mode: 'exp', from: S.drop.bar + 4, to: S.drop.end }); // wobble in the second half of the drop
  lead.ramp('bend', S.drop.end - 1, S.drop.end, 0, -12, 'in'); // a pitch dive at the end of the drop

  // ── mix ──
  s.setReverb({ time: 2.8, return: -9 });
  s.setDelay({ time: '1/8.', feedback: 0.38 });
  s.setSidechain({ release: 0.18, curve: 1.4 });
  s.setMaster({ trim: TRIM });
  s.auto('master.trim', [[S.outro.bar + 2, TRIM], [S.outro.end, TRIM - 4]]); // fade the last two bars
});
