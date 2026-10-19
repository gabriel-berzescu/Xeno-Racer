// Example track: a short melodic dubstep piece (140 BPM, half time, F minor): voice-led supersaw chords, an e-piano arp, a growl with a separate
// sub, a build with risers and a snare roll, two drops and a bridge, an ending. Written by following src/audio/album/README.md. It is not part
// of the album.
// Probe it:  ALBUM=1 TRACK=sandbox/album/examples/dubstep.ts AUTOTRIM=1 SPEC=1 npx vitest run tests/probes/album-render.test.ts
// To build on it, copy it to src/audio/album/tracks/<id>.ts, change the import to '../song' and the id to the file name.
import { defineTrack } from '../../../src/audio/album/song';

export default defineTrack({ id: 'example-dubstep', title: 'Example Dubstep', genre: 'Test', bpm: 140, bars: 28, tail: 3 }, (s) => {
  s.key('F', 'minor');
  const S = s.sections({ intro: 4, build: 4, drop: 8, bridge: 4, drop2: 8 });
  const prog = s.chords('Fm | Db | Ab | Eb', { octave: 3, lead: true }); // one chord per bar, voice-led (prog.show() prints the voicings)

  // ── buses ──
  const music = s.bus('music', {});

  // ── drums (half time: kick on 1, snare + clap on beat 3) ──
  const kick = s.kick('punchy-kick', { gain: -3 });
  const snare = s.snare('trap-snare', { gain: -5, reverb: 0.15 });
  const clap = s.clap('clap', { gain: -8, reverb: 0.2, pan: 0.1 });
  const hat = s.hat('closed-hat', { gain: -8, pan: 0.2 });

  // ── music ──
  const chords = s.synth('supersaw-chord', { name: 'chords', gain: -7, duck: 0.9, reverb: 0.25, bus: 'music' });
  const keys = s.synth('fm-epiano', { name: 'keys', gain: -9, reverb: 0.3, delay: 0.25, duck: 0.5, bus: 'music' });
  const lead = s.synth('supersaw-lead', { name: 'lead', gain: -6, reverb: 0.3, delay: 0.3, duck: 0.4 });
  const growl = s.growl({ preset: 'dubstep-growl', sub: 0 }, { gain: -3, duck: 0.7, hp: 60 }); // sub: 0, because the sub below is its own channel
  const sub = s.sub('sub-sine', { gain: -8, duck: 0.9 });

  // ── fx (their level decides how loud the build is: README section 12) ──
  const riser = s.riser('riser', { gain: -14 });
  const wash = s.riser('noise-wash', { name: 'wash', gain: -15 });
  const whoosh = s.riser('whoosh', { name: 'whoosh', gain: -14 });
  const boom = s.impact('impact', { name: 'boom', gain: -6, reverb: 0.3 });

  // ── patterns ──
  const kickDrop = s.hits('X.........x..... | X.....x...x...x.'); // on 1 and off the snare: the snare owns beat 3
  const backbeat = s.hits('........X.......');
  const hats = s.hits('x.xgx.xgx.xgx.xg | x.xgx.xgxxxxx.xo');
  const roll = s.hits('1.2.3.4.5.6.7.8. | 1234567899999999');
  const growlLine = s.notes('F1:6 . . F1:4 F2:4 | Db2:8 Db2:4 Ab1:4 | Ab1:6 . . Ab1:4 Ab2:4 | Eb2:8 Eb2:2 Eb2:2 Bb1:4');
  const hook = s.notes('C5:6 Ab4:2 F4:4 G4:2 Ab4:2 | F4:6 Ab4:2 Db5:8 | C5:6 Eb5:2 C5:4 Ab4:4 | Bb4:8 G4:4 Bb4:4');

  // ── intro: filtered held chords and an e-piano arp ──
  chords.play(prog, S.intro);
  keys.play(s.arp(prog, { order: 'updown', octaves: 2, res: 2 }), S.intro.bar, S.intro.bars + S.build.bars);
  hat.play(s.hits('x.x.x.x.x.x.x.x.'), S.intro.end - 1, 1, { vel: 0.6 });

  // ── build: chords re-struck in eighths, no kick, a snare roll and risers ──
  chords.play(prog.rhythm('x.x.x.x.x.x.x.x.'), S.build);
  hat.play(hats, S.build, undefined, { vel: 0.7 });
  snare.play(backbeat, S.build.bar, 2);
  clap.play(backbeat, S.build.bar, 2);
  snare.play(roll, S.build.end - 2, undefined, { vel: 0.7 });
  riser.hit(S.build.bar, '', 1, 0, 16);
  wash.hit(S.build.end - 2, '', 1, 0, 8);
  chords.auto('mix.hp', [[S.build.bar, 20], [S.build.end, 600, 'exp'], [S.drop.bar, 20, 'step']]); // two points at one bar: ramp up to it, then jump back

  // ── drops ──
  for (const D of [S.drop, S.drop2]) {
    const bars = D === S.drop2 ? D.bars - 0.5 : D.bars; // the last drop stops two beats early: the ending
    boom.hit(D.bar, '', 1);
    kick.play(kickDrop, D.bar, bars);
    snare.play(backbeat, D.bar, bars);
    clap.play(backbeat, D.bar, bars);
    hat.play(hats, D.bar, bars);
    chords.play(prog.rhythm('x..x..x...x..x..'), D.bar, bars);
    keys.play(s.arp(prog, { order: 'up', octaves: 2, res: 4, mask: 'x.xx.xx.x.xx.xx.' }), D.bar, bars, { vel: 0.7 });
    growl.play(growlLine, D.bar, bars);
    sub.play(prog.roots({ low: 28 }), D.bar, bars);
    // the classic speed-up at the end of each four-bar phrase
    growl.auto('lfoRate', [[D.bar, 1], [D.bar + 3, 2, 'step'], [D.bar + 3.5, 4, 'step'], [D.bar + 4, 1, 'step'], [D.bar + 7, 2, 'step'], [D.bar + 7.5, 4, 'step'], [D.end, 1, 'step']]);
  }
  lead.play(hook, S.drop.bar + 4, 4);
  lead.play(hook, S.drop2.bar, S.drop2.bars - 0.5);
  // the ending: one Fm chord and a boom on the last two beats, then the reverb tail
  chords.play(s.chords('Fm', { octave: 3 }), S.drop2.end - 0.5, 0.5);
  boom.hit(S.drop2.end - 0.5, '', 0.8);
  whoosh.hit(S.drop.end - 1, '', 1, 0, 8);

  // ── bridge: no kick, held chords behind a closed music bus, the lead alone ──
  chords.play(prog, S.bridge);
  keys.play(s.arp(prog, { order: 'updown', octaves: 2, res: 2 }), S.bridge);
  lead.play(hook, S.bridge, undefined, { vel: 0.6 });
  hat.play(hats, S.bridge.bar + 2, 2, { vel: 0.6 });
  snare.play(roll, S.bridge.end - 2, undefined, { vel: 0.6 });
  riser.hit(S.bridge.end - 2, '', 1, 0, 8);

  // ── the music-bus filter: closed in the intro, opens over the build, closes for the bridge ──
  music.auto('mix.lp', [[0, 700], [S.build.bar, 1000, 'exp'], [S.drop.bar, 20000, 'exp'], [S.bridge.bar, 1500, 'step'], [S.bridge.end - 2, 1500], [S.drop2.bar, 20000, 'exp']]);

  s.setReverb({ time: 3, return: -9 });
  s.setDelay({ time: '1/8.', feedback: 0.35 });
  s.setSidechain({ release: 0.25, curve: 1.4 }); // a long, pumping recovery
  s.setMaster({ trim: 4.3 }); // master trim in dB, found with the probe's AUTOTRIM=1 (README section 8, "Master")
});
