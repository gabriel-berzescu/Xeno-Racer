// The harmony check (Song.clashes): it finds a minor ninth and a minor second between channels, a tone between two bass notes,
// and leaves consonant music, drums and ghost notes alone.
import { describe, expect, it } from 'vitest';
import { defineTrack } from '../src/audio/album/song';

const song = (compose: Parameters<typeof defineTrack>[1]) => defineTrack({ id: 'clash-test', title: 'Clash Test', genre: 'Test', bpm: 120, bars: 4 }, compose).build(48000);

describe('Song.clashes', () => {
  it('finds a minor ninth between a lead and a chord', () => {
    const s = song((s) => {
      s.synth('warm-pad', { name: 'pad' }).play(s.chords('C', { octave: 4 }), 0, 2); // C4 E4 G4
      s.synth('saw-lead', { name: 'lead' }).play(s.notes('F5 - - - - - - - . . . . . . . .'), 1, 1); // F5 over E4: a minor 9th
    });
    const out = s.clashes();
    expect(out).toContain('bar 1 (beat 1): lead F5 / pad E4, minor 9th');
    expect(out).toContain('(8 sixteenths)');
  });

  it('finds a minor second and a tone in the bass', () => {
    const s = song((s) => {
      s.synth('pluck', { name: 'a' }).play(s.notes('C4 - - - . . . . . . . . . . . .'), 0, 1);
      s.synth('pluck', { name: 'b' }).play(s.notes('B3 - - - . . . . . . . . . . . .'), 0, 1);
      s.sub('sub-sine', { name: 'sub' }).play(s.notes('F1 - - - - - - - . . . . . . . .'), 2, 1);
      s.darkBass('darksynth-bass', { name: 'bass' }).play(s.notes('G1 - - - - - - - . . . . . . . .'), 2, 1);
    });
    const out = s.clashes();
    expect(out).toContain('bar 0 (beat 1): a C4 / b B3, minor 2nd');
    expect(out).toContain('bar 2 (beat 1): bass G1 / sub F1, major 2nd in the bass');
  });

  it("hears a synth's octave layer", () => {
    const s = song((s) => {
      s.synth('supersaw-chord', { name: 'saws' }).play(s.notes('[D4,F#4,A4] - - - - - - - - - - - - - - -'), 0, 1); // its second layer sounds D5 F#5 A5
      s.synth('saw-lead', { name: 'harm' }).play(s.notes('C#5 - - - - - - - . . . . . . . .'), 0, 1);
    });
    expect(s.channelList[0].inst.pitches).toEqual([0, 12]);
    expect(s.clashes({ layers: true })).toContain('bar 0 (beat 1): saws D5 (octave layer) / harm Db5, minor 2nd');
    expect(s.clashes()).toBe('no clashes'); // written notes only: D4 F#4 A4 against C#5 is fine
  });

  it('leaves consonant harmony, drums and ghost notes alone', () => {
    const s = song((s) => {
      s.synth('warm-pad', { name: 'pad' }).play(s.chords('Am | F | C | G', { octave: 3, lead: true }), 0, 4);
      s.synth('saw-lead', { name: 'lead' }).play(s.notes('A4 - - - C5 - - - E5 - - - C5 - - - | A4 - - - - - - - F4 - - - - - - - | G4 - - - E4 - - - C5 - - - - - - - | B4 - - - D5 - - - G4 - - - - - - -'), 0, 4);
      s.drumKit({ kick: 'darksynth-kick', hat: 'closed-hat' }).play(s.drums({ kick: 'x...x...x...x...', hat: 'xxxxxxxxxxxxxxxx' }), 0, 4);
      s.synth('pluck', { name: 'ghost' }).play(s.notes('Bb4? . . . . . . . . . . . . . . .'), 0, 1); // a ghost a semitone off the lead's A4
    });
    expect(s.clashes()).toBe('no clashes');
  });
});
