// The worked example of src/audio/album/README.md (the README embeds this file; tests/album-engine.test.ts renders it).
import { defineTrack, fx, guitarChord } from '../../src/audio/album/song';

export default defineTrack({ id: 'example', title: 'Worked Example', genre: 'Test', bpm: 126, bars: 24, tail: 3 }, (s) => {
  s.key('A', 'minor');
  const S = s.sections({ intro: 4, groove: 8, drop: 8, outro: 4 });
  const prog = 'Am | F | C | G'; // one chord per bar

  // ── instruments: every factory returns a channel; the second argument is its mixer strip ──
  const kick = s.kick('darksynth-kick', { gain: -3 }); // kicks key the sidechain by default
  const kit = s.drumKit({ snare: 'darksynth-snare', hat: { preset: 'closed-hat', pan: 0.2, gain: -6 }, crash: { preset: 'crash', gain: -8 } }, { gain: -4, reverb: 0.1 });
  const bass = s.darkBass('darksynth-bass', { gain: -6, duck: 0.8 });
  const pad = s.synth('supersaw-pad', { gain: -10, reverb: 0.3, duck: 0.7, fx: [fx.chorus()] });
  const arp = s.synth('dark-pluck', { gain: -9, reverb: 0.15, delay: 0.3 });
  const lead = s.synth('supersaw-lead', { gain: -9, reverb: 0.25, delay: 0.25 });
  const riser = s.riser('riser', { gain: -12 });

  // ── patterns: text on a 16th-note grid (| = bar line, . = rest, - = hold, ! accent, ~ slide) ──
  const four = s.hits('X...X...X...X...');
  const beat = s.drums({ snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.xo', crash: 'X...............' });
  const chords = s.chords(prog, { octave: 3, lead: true }); // voice-led chord notes, one bar each
  const roots = chords.roots({ rhythm: 'x.xxx.xxx.xxx.xx', low: 33 }); // bass on the chord roots
  const hook = s.notes('A4 . . C5 . . E5 - D5~ - E5 - A5 - - - | G5 . . E5 . . D5 . C5 - - - A4 - - -');

  // ── arrangement: place patterns on the bar timeline (a Section works as the position) ──
  pad.play(chords, S.intro.bar, S.intro.bars + S.groove.bars + S.drop.bars + S.outro.bars);
  arp.play(s.arp(chords, { order: 'updown', octaves: 2 }), S.intro.bar, S.intro.bars);
  arp.play(s.arp(chords, { order: 'up', octaves: 2, mask: 'xxx.xxx.xxxxxxx.' }), S.groove.bar, S.groove.bars + S.drop.bars);
  kick.play(four, S.groove.bar, S.groove.bars + S.drop.bars);
  kit.play(beat, S.groove.bar, S.groove.bars + S.drop.bars);
  bass.play(roots, S.groove.bar, S.groove.bars + S.drop.bars);
  lead.play(hook, S.drop.bar, S.drop.bars, { vel: 0.9 });
  riser.hit(S.drop.bar - 2, '', 1, 0, 8); // a riser: the hit length (8 beats) is the sweep length

  // ── automation and mixing: any parameter, by path ──
  arp.ramp('cutoff', S.intro.bar, S.intro.end, 500, arp.param('cutoff'), 'exp'); // filter opens over the intro, to the preset's own cutoff
  bass.lfo('cutoff', { period: '1/2', depth: 0.6, mode: 'exp', from: S.drop.bar, to: S.outro.bar }); // slow tempo-synced wobble
  s.auto('master.trim', [[0, 2.0], [S.outro.bar, 2.0], [S.outro.end, -3]]); // 2 dB brings the probe's reading to about -14 LUFS; -3 fades the outro
  s.setReverb({ time: 2.6, return: -9 });
  s.setDelay({ time: '1/8.', feedback: 0.4 });
  s.setSidechain({ release: 0.2 });

  // guitar chords from a fingering helper, for the outro
  const gtr = s.guitar('crunch-guitar', { gain: -12, reverb: 0.08 });
  gtr.play(s.pattern(4).chord(0, guitarChord('Am'), 4, 0.8).chord(4, guitarChord('F'), 4, 0.8).chord(8, guitarChord('C'), 4, 0.8).chord(12, guitarChord('G'), 4, 0.8).done(), S.outro.bar, S.outro.bars);
});
