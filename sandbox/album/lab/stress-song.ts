/**
 * A deliberately dense track for speed and headroom tests: about a dozen busy channels at once (drums, bass, pad, chords,
 * arp, lead, acid, guitars) with reverb, delay, sidechain and a master chain: what a full composition asks of the engine.
 */
import { defineTrack, fx } from '../../../src/audio/album/song';

export function stressTrack(bars = 16, bpm = 128) {
  return defineTrack({ id: 'stress', title: 'Stress', genre: 'Test', bpm, bars, tail: 3 }, (s) => {
    s.key('A', 'minor');
    s.setReverb({ time: 2.8, return: -8 });
    s.setDelay({ time: '1/8.', feedback: 0.45, return: -9 });
    const prog = 'Am | F | C | G';
    const drums = s.drumKit(
      { kick: 'darksynth-kick', snare: 'darksynth-snare', clap: 'big-clap', hat: 'closed-hat', crash: 'crash', tomHi: 'tom-high' },
      { name: 'drums', gain: -4, reverb: 0.1 },
    );
    drums.play(
      s.drums({
        kick: 'X...X...X...X...',
        snare: '....X.......X..x',
        clap: '....x.......x...',
        hat: 'xxxxxxxxxxxxxxxo',
        crash: 'X...............',
        tomHi: '............xxxx',
      }, { free: true }),
      0,
      bars,
    );
    const dark = s.darkBass('darksynth-bass', { gain: -8, duck: 0.8 });
    dark.play(s.chords(prog, { octave: 1 }).roots({ rhythm: 'xxxxxxxxxxxxxxxx', low: 33 }), 0, bars);
    const sub = s.sub('sub-sine', { gain: -9, duck: 0.8 });
    sub.play(s.chords(prog, { octave: 1 }).roots({ low: 28 }), 0, bars);
    const pad = s.synth('supersaw-pad', { gain: -12, duck: 0.7, reverb: 0.3, fx: [fx.chorus()] });
    pad.play(s.chords(prog, { octave: 3, lead: true }), 0, bars);
    const chords = s.synth('supersaw-chord', { gain: -11, duck: 0.6, reverb: 0.2, delay: 0.15 });
    chords.play(s.chords(prog, { octave: 3, lead: true }).rhythm('x..x..x.x..x..x.', { res: 4 }), 0, bars);
    const arp = s.synth('dark-pluck', { gain: -10, reverb: 0.15, delay: 0.3 });
    arp.play(s.arp(s.chords(prog, { octave: 3 }), { order: 'updown', octaves: 2, res: 4 }), 0, bars);
    const lead = s.synth('supersaw-lead', { gain: -10, reverb: 0.25, delay: 0.3 });
    lead.play(s.notes('A4 . . C5 . . E5 . D5 - - - C5 - - -'), 0, bars);
    const acid = s.acid('goa-acid', { gain: -9 });
    acid.play(s.notes('A1 . A1 A2! . A1 . A1~ C2 . A1 A1 E2! . G1~ A1'), 0, bars);
    const gtr = s.guitar('punk-guitar', { gain: -11, reverb: 0.05 });
    gtr.play(s.notes('[A2,E3,A3]{pm} [A2,E3,A3]{pm} [A2,E3,A3]{pm} [A2,E3,A3]{pm} [C3,G3,C4]! . [D3,A3,D4] . [A2,E3,A3]{pm} [A2,E3,A3]{pm} [E2,B2,E3]{pm} [E2,B2,E3]{pm} [G2,D3,G3]! . [A2,E3,A3]:2'), 0, bars);
    const bass = s.bassGuitar('punk-bass', { gain: -9 });
    bass.play(s.notes('A1 A1 A1 A1 A1 A1 A1 A1 C2 C2 C2 C2 D2 D2 E2 E2'), 0, bars);
    const riser = s.riser('riser', { gain: -12 });
    riser.hit(bars - 4, '', 1, 0, 16);
  });
}
