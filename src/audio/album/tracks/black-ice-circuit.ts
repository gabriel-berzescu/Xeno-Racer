/**
 * Black Ice Circuit: heavy darksynth / cyberpunk, E minor with a phrygian edge (the F), 138 BPM, 104 bars.
 *
 * Two worlds: the riff sections are a metal riff on a distorted synth bass, the kick in unison with its accents and parallel power-chord
 * stabs on every accent (E, G, F, then a fall from Bb through A and G to F); the verse and the drops are melodic darksynth over
 * Em C Am B and Em C G D (the harmonic minor's B major pulls back to E). The half-time breakdown swings between Em and F.
 * One chord per bar in HARMONY; every melodic part reads it.
 */
import { FLAG, defineTrack, fx, type Pattern } from '../song';

const RIFF_H = ['Em', 'Em', 'Em', 'Em'];
const VERSE = ['Em', 'C', 'Am', 'B'];
const BUILD = ['C', 'C', 'D', 'D', 'Em', 'Em', 'B', 'B'];
const DROP = ['Em', 'C', 'G', 'D', 'Em', 'C', 'Am', 'B'];
const DOWN = ['Em', 'F', 'Em', 'F', 'Em', 'F', 'G', 'B'];

const HARMONY: string[] = [
  ...RIFF_H, ...RIFF_H, // 0 intro
  ...RIFF_H, ...RIFF_H, ...RIFF_H, ...RIFF_H, // 8 riff
  ...VERSE, ...VERSE, ...VERSE, ...VERSE, // 24 verse
  ...BUILD, // 40 build
  ...DROP, ...DROP, // 48 drop
  ...DOWN, // 64 breakdown
  ...RIFF_H, ...RIFF_H, // 72 build 2 (the riff returns)
  ...DROP, ...DROP, // 80 drop 2
  ...RIFF_H, ...RIFF_H, // 96 outro
];

// ── the riff: two bars, the bass, the kick in unison, the stabs on its accents ──
const RIFF_BASS = 'E1! . E1 E1 . E1 . E1 G1! . E1 E1 F1! . E1 . | E1! . E1 E1 . E1 . E1 Bb1! . A1 . G1 . F1 .';
const RIFF_KICK = 'X..x.x..X..xX...|X..x.x..X.x.x.x.';
const RIFF_STAB =
  '[E3,B3,E4] . . . . . . . [G3,D4,G4] . . . [F3,C4,F4] . . . | [E3,B3,E4] . . . . . . . [Bb2,F3,Bb3] . [A2,E3,A3] . [G2,D3,G3] . [F2,C3,F3] .';
// the riff's high theme: the phrygian E F G over the pedal
const RIFF_THEME = [
  'E5 - - - - - - - - - - - - - - -',
  'G5 - - - - - - - F5 - - - - - - -',
  'E5 - - - - - - - - - - - G5 - A5 -',
  'Bb5 - - - A5 - - - G5 - - - F5 - - -',
];

// ── melodies (sixteenths, one bar per line) ──
const HOOK_A = [
  'E5 - - - - - B4 - E5 - G5 - - - F#5 -', // Em
  'E5 - - - - - - - C5 - - - D5 - E5 -', // C
  'D5 - - - - - B4 - D5 - G5 - - - F#5 -', // G
  'F#5 - - - - - - - A5 - - - - - - -', // D
  'B5 - - - - - G5 - E5 - - - G5 - A5 -', // Em
  'G5 - - - - - E5 - C5 - - - E5 - G5 -', // C
  'A5 - - - - - E5 - C5 - - - B4 - A4 -', // Am
  'B4 - - - D#5 - - - F#5 - - - D#5 - - -', // B (the leading tone pulls back to E)
];
const HOOK_B = [
  'E5 - - - - - B4 - E5 - G5 - - - F#5 -', // Em
  'E5 - - - - - - - C5 - - - D5 - E5 -', // C
  'D5 - - - - - B4 - D5 - G5 - - - A5 -', // G
  'B5 - - - - - - - A5 - - - F#5 - - -', // D
  'G5 - - - - - B5~ - - - A5 - G5 - F#5 -', // Em
  'G5 - - - - - - - E5 - - - C5 - - -', // C
  'E5 - - - - - - - C5 - - - A4 - - -', // Am
  'B4 - - - - - - - D#5 - - - - - - -', // B
];
const VERSE_MEL = [
  'G4 - - - - - - - F#4 - - - E4 - - -', // Em
  'E4 - - - - - - - G4 - - - C5 - - -', // C
  'C5 - - - - - - - B4 - - - A4 - - -', // Am
  'B4 - - - - - - - - - - - D#4 - F#4 -', // B
  'G4 - - - - - - - F#4 - - - E4 - - -', // Em
  'E4 - - - - - - - G4 - - - B4 - C5 -', // C
  'E5 - - - - - - - D5 - - - C5 - - -', // Am
  'B4 - - - - - - - - - - - . . . .', // B
];
const DOWN_MEL = [
  'B4 - - - - - - - - - - - - - - -', // Em
  'C5 - - - - - - - - - - - A4 - - -', // F
  'B4 - - - - - - - G4 - - - E4 - - -', // Em
  'F4 - - - - - - - A4 - - - C5 - - -', // F
  'B4 - - - - - - - - - - - - - - -', // Em
  'C5 - - - - - - - D5 - - - E5 - - -', // F (an E over F: the major seventh)
  'D5 - - - - - - - B4 - - - G4 - - -', // G
  'F#4 - - - - - - - B4 - - - D#5 - - -', // B
];

const ROLL = 'LLHLLHLLHLLHLHLH';
const ROLL_DROP = 'LLHALLHALLHALH5H';
const EIGHTHS = 'L.L.L.L.L.L.L.L.';

const PC: Record<string, number> = { C: 0, Db: 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
const rootPc = (sym: string): number => PC[/^[A-G][b#]?/.exec(sym)![0]];
/** The chord's root in the bass register (E1 .. D#2). */
const bassRoot = (sym: string): number => {
  let r = rootPc(sym) + 24;
  while (r < 28) r += 12;
  while (r > 39) r -= 12;
  return r;
};

export default defineTrack({ id: 'black-ice-circuit', title: 'Black Ice Circuit', genre: 'Cyberpunk', bpm: 138, bars: 104, tail: 4 }, (s) => {
  s.key('E', 'minor');
  const S = s.sections({ intro: 8, riff: 16, verse: 16, build: 8, drop: 16, breakdown: 8, build2: 8, drop2: 16, outro: 8 });
  if (HARMONY.length !== s.bars) throw new Error(`black-ice-circuit: ${HARMONY.length} chords for ${s.bars} bars`);
  const prog = (from: number, to: number): string => HARMONY.slice(from, to).join(' | ');
  const chordsOf = (from: number, to: number, octave = 3): Pattern => s.chords(prog(from, to), { octave, lead: true });
  const mel = (lines: string[]): Pattern => s.notes(lines.join(' | '));

  const bassLine = (from: number, to: number, figure: string, vel = 0.8): Pattern => {
    const b = s.pattern(to - from);
    for (let bar = from; bar < to; bar++) {
      const root = bassRoot(HARMONY[bar]);
      for (let i = 0; i < 16; i++) {
        const c = figure[i % figure.length];
        if (c === '.') continue;
        const n = c === 'H' ? root + 12 : c === '5' ? root + 7 : root;
        b.note((bar - from) * 4 + i * 0.25, n, 0.2, c === 'A' ? 1 : vel, c === 'A' ? FLAG.ACCENT : 0);
      }
    }
    return b.done();
  };
  const harmonyBelow = (melody: Pattern, startBar: number): Pattern => {
    const b = s.pattern(Math.ceil(melody.beats / 4));
    for (const e of melody.events) {
      const tones = s.chordNotes(HARMONY[startBar + Math.floor(e.t / 4 + 1e-9)], { octave: 2 }).map((n) => n % 12);
      let h = e.n - 3;
      while (!tones.includes(((h % 12) + 12) % 12)) h--;
      b.note(e.t, h, e.d, e.v * 0.85, e.f);
    }
    return b.done();
  };
  const avoid = (arpP: Pattern, arpBar: number, melody: Pattern, melBar: number): Pattern => {
    const shift = (melBar - arpBar) * 4;
    return arpP.map((e) => {
      const m = melody.events.find((x) => x.t + shift <= e.t + 1e-9 && x.t + shift + x.d > e.t + 1e-9);
      const d = m ? Math.abs(e.n - m.n) : 0;
      return m && (d === 1 || d === 13) ? { ...e, n: e.n - 12 } : e;
    });
  };

  // ── the mix ──
  s.setReverb({ time: 2.0, damp: 0.5, return: -11, lowCut: 200, width: 1.2 });
  s.setDelay({ time: '1/8.', feedback: 0.33, return: -12, tone: 3600 });
  s.setSidechain({ release: 0.18, curve: 1.4 });
  s.setMaster({ trim: 4.3 });

  const drums = s.bus('drums', {});
  const music = s.bus('music', {});
  const low = s.bus('low', {});

  const kick = s.kick({ preset: 'darksynth-kick', decay: 0.3, drive: 10 }, { gain: -3, bus: 'drums', eqMid: -6, eqMidFreq: 260, eqMidQ: 0.9 });
  const snare = s.snare('darksynth-snare', { gain: -6, bus: 'drums', reverb: 0.06, fx: [fx.reverb({ gated: true, mix: 0.5, time: 1.8 })] });
  const crack = s.snare('heavy-snare', { name: 'crack', gain: -12, bus: 'drums' });
  const clap = s.clap('big-clap', { gain: -13, bus: 'drums', reverb: 0.12 });
  const hat = s.hat('closed-hat', { gain: -12, pan: 0.2, bus: 'drums' });
  const toms = s.tom('synth-tom', { gain: -9, reverb: 0.2, bus: 'drums' });
  const crash = s.cymbal('crash', { gain: -12, reverb: 0.1, pan: -0.15 });
  const swell = s.cymbal('reverse-crash', { name: 'swell', gain: -13 });

  const riff = s.darkBass('dark-growl', { name: 'riff', gain: -9, duck: 0.5, bus: 'low' });
  const bass = s.darkBass('darksynth-bass', { gain: -8, duck: 0.8, bus: 'low' });
  const sub = s.sub('sub-sine', { gain: -14, duck: 0.9, bus: 'low' });
  const stab = s.synth('brass-stab', { name: 'stab', gain: -11, reverb: 0.12, duck: 0.3, width: 1.3, bus: 'music', fx: [fx.drive({ drive: 8 })] });
  const arp = s.synth('dark-pluck', { gain: -10, reverb: 0.15, delay: 0.25, width: 1.2, duck: 0.4, bus: 'music' });
  const pad = s.synth('supersaw-pad', { gain: -15, width: 1.5, reverb: 0.3, duck: 0.7, hp: 160, fx: [fx.chorus({ mix: 0.4 })], bus: 'music' });
  const saws = s.synth('supersaw-chord', { name: 'saws', gain: -5, width: 1.4, reverb: 0.2, duck: 0.65, hp: 220, bus: 'music' });
  const lead = s.synth('supersaw-lead', { name: 'lead', gain: -6, reverb: 0.22, delay: 0.26, bus: 'music' });
  const theme = s.synth('saw-lead', { name: 'theme', gain: -9, reverb: 0.3, delay: 0.3, bus: 'music', fx: [fx.drive({ drive: 6 })] });
  const harm = s.synth('saw-lead', { name: 'harm', gain: -13, reverb: 0.22, delay: 0.2, pan: 0.12, bus: 'music' });
  const sparkle = s.synth('square-lead', { name: 'sparkle', gain: -17, reverb: 0.25, delay: 0.3, pan: -0.1, bus: 'music' });
  const riser = s.riser('riser', { gain: -16 });
  const siren = s.zap('siren', { gain: -18, delay: 0.3, reverb: 0.3 });
  const boom = s.impact('impact-deep', { name: 'boom', gain: -8, reverb: 0.3 });

  // ── drum patterns ──
  const FOUR = s.hits('X...x...x...x...');
  const FOUR_TURN = s.hits('X...x...x...x.x.');
  const kick4 = (bar: number, bars: number) => {
    for (let b = bar; b < bar + bars; b++) kick.play((b - bar) % 4 === 3 ? FOUR_TURN : FOUR, b, 1);
  };
  const BACKBEAT = s.hits('....X.......X...');
  const HATS8 = s.hits('x.x.x.x.x.x.x.xx');
  const HATS16 = s.hits('x3x3x3o3x3x3x3o3');
  const ROLL2 = s.hits('1.2.3.4.5.6.7.8.|1234567899999999');
  const fillA = (bar: number, vel = 0.8) => toms.play(s.notes('. . . . . . . . A2 . A2 F2 D2 D2 A1 A1'), bar, 1, { vel });
  const fillC = (bar: number, vel = 0.7) => toms.play(s.notes('. . . . . . . . . . . . A2 F2 D2 A1'), bar, 1, { vel });

  /** The riff over [bar, bar + bars): bass, kick in unison, stabs, backbeat; `full` adds the crack and the hats. */
  const playRiff = (bar: number, bars: number, full = true) => {
    riff.play(s.notes(RIFF_BASS), bar, bars);
    kick.play(s.hits(RIFF_KICK), bar, bars);
    stab.play(s.notes(RIFF_STAB), bar, bars);
    snare.play(BACKBEAT, bar, bars);
    if (full) {
      crack.play(BACKBEAT, bar, bars);
      hat.play(HATS8, bar, bars, { vel: 0.85 });
    }
  };

  // ── intro (0-8): the riff behind a closed filter, opening; a siren; the drums from bar 4 ──
  const I = S.intro;
  riff.play(s.notes(RIFF_BASS), I);
  stab.play(s.notes(RIFF_STAB), I.bar + 4, 4, { vel: 0.7 });
  kick.play(s.hits(RIFF_KICK), I.bar + 4, 4);
  snare.play(BACKBEAT, I.bar + 6, 2, { vel: 0.7 });
  low.auto('mix.lp', [[0, 260], [I.end - 0.5, 2200, 'exp'], [I.end, 20000, 'step']]);
  music.auto('mix.lp', [[I.bar + 4, 500], [I.end - 0.5, 3000, 'exp'], [I.end, 20000, 'step']]);
  drums.auto('mix.lp', [[I.bar + 4, 400], [I.end - 0.5, 2500, 'exp'], [I.end, 20000, 'step']]);
  siren.hit(I.bar, '', 0.8, 0, 8);
  siren.hit(I.bar + 2, '', 0.6, 0, 8);
  riser.hit(I.bar + 4, '', 0.9, 0, 15.5);
  swell.note(I.end - 1, 'A3', 4, 1);

  // ── the riff (8-24): full force; the high theme over its second half ──
  const R = S.riff;
  crash.hit(R.bar, '', 1);
  boom.hit(R.bar, '', 0.9);
  playRiff(R.bar, R.bars);
  crash.hit(R.bar + 8, '', 0.8);
  theme.play(mel(RIFF_THEME), R.bar + 8, 8);
  fillA(R.end - 1);

  // ── verse (24-40): melodic; the rolling bass on Em C Am B, the arp, then the verse melody ──
  const V = S.verse;
  crash.hit(V.bar, '', 0.8);
  kick4(V.bar, V.bars);
  snare.play(s.hits('............X...'), V.bar, 8, { vel: 0.7 });
  snare.play(BACKBEAT, V.bar + 8, 8);
  hat.play(HATS8, V.bar, 8);
  hat.play(HATS16, V.bar + 8, 8, { vel: 0.9 });
  clap.play(BACKBEAT, V.bar + 8, 8);
  bass.play(bassLine(V.bar, V.end, ROLL), V);
  bass.set('drive', 8, V.bar);
  bass.set('clip', 4, V.bar);
  bass.set('drive', 13, V.bar + 8);
  bass.set('clip', 8, V.bar + 8);
  sub.play(s.chords(prog(V.bar, V.end), { octave: 1 }).roots({ low: 28 }), V);
  const vmel = mel(VERSE_MEL);
  arp.play(avoid(s.arp(chordsOf(V.bar, V.end), { order: 'updown', octaves: 2, accent: 'x...' }), V.bar, vmel, V.bar + 8), V);
  pad.play(chordsOf(V.bar + 8, V.end), V.bar + 8, 8);
  theme.play(vmel, V.bar + 8, 8, { vel: 0.9 });
  fillC(V.bar + 7, 0.6);
  fillA(V.end - 1, 0.75);

  // ── build (40-48): stabs on a rhythm, eighth-note bass, everything opening, a roll, a beat of silence ──
  const B = S.build;
  kick4(B.bar, 6);
  snare.play(BACKBEAT, B.bar, 4);
  snare.play(s.hits('....X.......X...|....X...X...X.X.'), B.bar + 4, 2);
  snare.play(ROLL2, B.bar + 6, 1.75, { vel: 0.65 });
  snare.auto('mix.hp', [[B.bar + 4, 20], [B.end - 0.25, 700, 'exp'], [B.end, 20, 'step']]);
  hat.play(HATS16, B.bar, 6);
  stab.play(chordsOf(B.bar, B.end).rhythm('x..x..x...x..x..'), B.bar, B.bars - 0.25, { vel: 0.8 });
  bass.play(bassLine(B.bar, B.end, EIGHTHS), B.bar, B.bars - 0.25);
  bass.ramp('cutoff', B.bar, B.end, 500, 1500, 'exp');
  arp.play(s.arp(chordsOf(B.bar, B.end), { order: 'up', octaves: 2, accent: 'x...' }), B.bar, B.bars - 0.25);
  arp.ramp('cutoff', B.bar, B.end, arp.param('cutoff'), 2600, 'exp');
  pad.play(chordsOf(B.bar, B.end), B.bar, B.bars - 0.25);
  pad.ramp('mix.hp', B.bar + 4, B.end, 160, 900, 'exp');
  riser.hit(B.bar + 4, '', 1, 0, 15);
  swell.note(B.end - 1, 'A3', 4, 1);

  // ── drop (48-64): the hook over Em C G D / Em C Am B, the wall of saws, the heavy roll ──
  const D = S.drop;
  boom.hit(D.bar, '', 1);
  crash.hit(D.bar, '', 1);
  crash.hit(D.bar + 8, '', 0.9);
  kick4(D.bar, D.bars);
  snare.play(BACKBEAT, D);
  crack.play(BACKBEAT, D, undefined, { vel: 0.7 });
  clap.play(BACKBEAT, D);
  hat.play(HATS16, D);
  fillC(D.bar + 7, 0.6);
  fillA(D.end - 1, 0.6);
  bass.play(bassLine(D.bar, D.end, ROLL_DROP), D);
  bass.set('cutoff', 760, D.bar);
  bass.set('drive', 18, D.bar);
  sub.play(s.chords(prog(D.bar, D.end), { octave: 1 }).roots({ low: 28 }), D);
  saws.play(chordsOf(D.bar, D.end), D);
  arp.play(s.arp(chordsOf(D.bar, D.end), { order: 'up', octaves: 1, accent: 'x...' }), D, undefined, { vel: 0.7 });
  arp.set('cutoff', arp.param('cutoff'), D.bar);
  arp.set('mix.gain', -12, D.bar);
  pad.set('mix.hp', 160, D.bar);
  lead.play(mel(HOOK_A), D.bar, 8);
  lead.play(mel(HOOK_B), D.bar + 8, 8);
  lead.set('mix.delay', 0.6, D.end - 0.5);
  lead.set('mix.delay', 0.26, D.end);

  // ── breakdown (64-72): half time, Em against F; the growl bass holds, the stabs hit, the theme sings ──
  const K = S.breakdown;
  boom.hit(K.bar, '', 0.8);
  arp.set('mix.gain', -10, K.bar);
  riff.play(s.chords(prog(K.bar, K.end), { octave: 1 }).roots({ low: 28 }), K, undefined, { vel: 0.9 });
  riff.set('mix.duck', 0.8, K.bar);
  kick.play(s.hits('X.........X.....'), K.bar, K.bars - 1);
  snare.play(s.hits('........X.......'), K.bar, K.bars - 1);
  crack.play(s.hits('........X.......'), K.bar, K.bars - 1);
  hat.play(s.hits('x.x.x.x.x.x.x.x.'), K.bar + 2, K.bars - 3, { vel: 0.7 });
  stab.play(chordsOf(K.bar, K.end).rhythm('X...............'), K, undefined, { vel: 0.8 });
  pad.play(chordsOf(K.bar, K.end), K);
  theme.play(mel(DOWN_MEL), K);
  fillA(K.end - 1, 0.85);
  swell.note(K.end - 1, 'A3', 4, 0.9);

  // ── build 2 (72-80): the riff comes back and climbs into the last drop ──
  const B2 = S.build2;
  riff.set('mix.duck', 0.5, B2.bar);
  crash.hit(B2.bar, '', 0.9);
  playRiff(B2.bar, 4);
  riff.play(s.notes(RIFF_BASS), B2.bar + 4, 3.75);
  kick.play(s.hits('X...X...X...X...|X.X.X.X.X.X.X.X.'), B2.bar + 4, 2);
  stab.play(s.notes(RIFF_STAB), B2.bar + 4, 3.75, { vel: 0.9 });
  snare.play(ROLL2, B2.bar + 4, 2, { vel: 0.6 });
  snare.play(s.hits('1234567899999999|99999999........'), B2.bar + 6, 1.75, { vel: 0.7 });
  snare.auto('mix.hp', [[B2.bar + 4, 20], [B2.end - 0.25, 900, 'exp'], [B2.end, 20, 'step']]);
  hat.play(HATS16, B2.bar + 4, 3.75);
  low.auto('mix.hp', [[B2.bar + 6, 20], [B2.end - 0.25, 300, 'exp'], [B2.end, 20, 'step']]);
  riser.hit(B2.bar, '', 1, 0, 31);
  swell.note(B2.end - 1, 'A3', 4, 1);

  // ── drop 2 (80-96): the hook with its harmony and an octave above, the stabs answering ──
  const D2 = S.drop2;
  boom.hit(D2.bar, '', 1);
  crash.hit(D2.bar, '', 1);
  crash.hit(D2.bar + 8, '', 1);
  kick4(D2.bar, D2.bars);
  snare.play(BACKBEAT, D2);
  crack.play(BACKBEAT, D2, undefined, { vel: 0.7 });
  clap.play(BACKBEAT, D2);
  hat.play(HATS16, D2);
  fillC(D2.bar + 7, 0.7);
  bass.play(bassLine(D2.bar, D2.end, ROLL_DROP), D2);
  bass.set('cutoff', 820, D2.bar);
  bass.set('drive', 22, D2.bar);
  sub.play(s.chords(prog(D2.bar, D2.end), { octave: 1 }).roots({ low: 28 }), D2);
  saws.play(chordsOf(D2.bar, D2.end), D2);
  arp.play(s.arp(chordsOf(D2.bar, D2.end), { order: 'up', octaves: 1, accent: 'x...' }), D2, undefined, { vel: 0.7 });
  arp.set('mix.gain', -12, D2.bar);
  const hook2 = mel(HOOK_A).then(mel(HOOK_B));
  lead.play(hook2, D2);
  sparkle.play(hook2, D2, undefined, { transpose: 12, vel: 0.8 });
  harm.play(harmonyBelow(hook2, D2.bar), D2, undefined, { vel: 0.8 });
  stab.play(chordsOf(D2.bar + 8, D2.end).rhythm('......x.......x.'), D2.bar + 8, 8, { vel: 0.8 });
  fillA(D2.end - 1, 0.8);

  // ── outro (96-104): the riff to the end, a last power chord ──
  const O = S.outro;
  arp.set('mix.gain', -10, O.bar);
  crash.hit(O.bar, '', 1);
  playRiff(O.bar, 6);
  theme.play(mel(RIFF_THEME.slice(0, 2)), O.bar + 2, 2, { vel: 0.8 });
  theme.play(mel(RIFF_THEME.slice(2, 4)), O.bar + 4, 2, { vel: 0.8 });
  const last = O.end - 2;
  stab.play(s.notes('[E3,B3,E4]:16'), last, 1, { vel: 1 });
  saws.play(s.chords('Em', { octave: 3 }), last, 1);
  riff.note(last, 'E1', 3, 1, FLAG.ACCENT);
  sub.note(last, 'E1', 6, 0.9);
  kick.hit(last, '', 1);
  snare.hit(last, '', 1);
  crash.hit(last, '', 1);
  boom.hit(last, '', 1);
  music.auto('mix.lp', [[last, 20000], [O.end, 3000, 'exp']]);
});
