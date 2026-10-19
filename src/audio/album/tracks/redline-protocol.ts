/**
 * Redline Protocol: darksynth / cyberpunk, F minor, 124 BPM, 96 bars.
 *
 * The harmony is one chord per bar, written once for the whole song (HARMONY below); every part reads it, so the bass, the pads, the
 * arp and the lead's harmony always agree. The hook is a three-three-two cell climbing over Fm, Db and Ab and falling back over Eb;
 * the second half of each drop answers it higher and lands on C major (the harmonic minor's dominant), and the first drop's C goes
 * to Db for the break (a deceptive cadence).
 */
import { FLAG, defineTrack, fx, type Pattern } from '../song';

// ── the harmony: one chord per bar ───────────────────────────────────────────

const INTRO = ['Fm', 'Fm', 'Db', 'Db', 'Fm', 'Fm', 'Db', 'C'];
const VERSE = ['Fm', 'Db', 'Bbm', 'C'];
const BUILD = ['Db', 'Eb', 'Fm', 'Fm', 'Bbm', 'Bbm', 'C', 'C'];
const DROP = ['Fm', 'Db', 'Ab', 'Eb', 'Fm', 'Db', 'Bbm', 'C'];
const BREAK = ['Db', 'Eb', 'Fm', 'Fm', 'Db', 'Eb', 'C', 'C'];
const OUTRO = ['Fm', 'Db', 'Bbm', 'C', 'Fm', 'Db', 'Fm', 'Fm'];

const HARMONY: string[] = [
  ...INTRO, // 0 intro
  ...VERSE, ...VERSE, ...VERSE, ...VERSE, // 8 verse
  ...BUILD, // 24 build
  ...DROP, ...DROP, // 32 drop
  ...BREAK, // 48 break
  ...VERSE, ...VERSE, // 56 verse 2
  ...BUILD, // 64 build 2
  ...DROP, ...DROP, // 72 drop 2
  ...OUTRO, // 88 outro
];

// ── the melodies (sixteenth-note grid, one bar per line) ─────────────────────

const HOOK_A = [
  'C5 - - Ab4 - - F4 - G4 - Ab4 - C5 - - -', // Fm
  'Db5 - - C5 - - Ab4 - F4 - Ab4 - Db5 - - -', // Db
  'Eb5 - - C5 - - Ab4 - Bb4 - C5 - Eb5 - - -', // Ab
  'G5 - - - F5 - - - Eb5 - - - Bb4 - - -', // Eb
  'C5 - - Ab4 - - F4 - G4 - Ab4 - C5 - - -', // Fm
  'Db5 - - C5 - - Ab4 - F4 - Ab4 - Db5 - - -', // Db
  'F5 - - Db5 - - Bb4 - C5 - Db5 - F5 - - -', // Bbm
  'G5 - - - F5 - - - E5 - - - - - - -', // C
];
const HOOK_B = [
  'F5 - - C5 - - Ab4 - C5 - Eb5 - F5 - - -', // Fm (the E of the last bar resolves here)
  'Ab5 - - F5 - - Db5 - C5 - Db5 - F5 - - -', // Db
  'Ab5 - - Eb5 - - C5 - Bb4 - C5 - Eb5 - - -', // Ab
  'G5 - - - Bb5~ - - - G5 - - - Eb5 - - -', // Eb (a glide up to the peak)
  'F5 - - C5 - - Ab4 - C5 - Eb5 - F5 - - -', // Fm
  'Ab5 - - F5 - - Db5 - C5 - Db5 - F5 - - -', // Db
  'Bb5 - - F5 - - Db5 - C5 - Db5 - F5 - - -', // Bbm
  'G5 - - - E5 - - - C5 - - - E5 - G5 -', // C
];
const VERSE_MEL = [
  'Ab4 - - - - - - - G4 - - - F4 - - -', // Fm
  'F4 - - - - - - - Ab4 - - - Db5 - - -', // Db
  'C5 - - - - - - - Bb4 - - - Db5 - - -', // Bbm
  'C5 - - - Bb4 - - - G4 - - - E4 - - -', // C (C7 falling into Fm)
  'Ab4 - - - - - - - G4 - - - F4 - - -', // Fm
  'F4 - - - - - - - Ab4 - - - C5 - Db5 -', // Db
  'F5 - - - - - - - Eb5 - - - Db5 - - -', // Bbm
  'C5 - - - - - - - - - - - . . . .', // C
];
const BREAK_MEL = [
  'Db5 - - - - - C5 - - - - - Ab4 - - -', // Db
  'Bb4 - - - - - G4 - - - - - Eb5 - - -', // Eb
  'C5 - - - - - - - - - - - - - - -', // Fm
  'Ab4 - - - - - - - F4 - - - G4 - Ab4 -', // Fm
  'Db5 - - - - - C5 - - - - - Ab4 - - -', // Db
  'Bb4 - - - - - G4 - - - - - Bb4 - Eb5 -', // Eb
  'E5 - - - - - - - - - - - - - - -', // C
  '. . . . . . . . . . . . . . . .', // C
];

// the bass: per step L = the root, H = the octave above, 5 = the fifth, A = an accented root, . = rest
const ROLL = 'LLHLLHLLHLLHLHLH';
const ROLL_DROP = 'LLHALLHALLHALH5H';
const EIGHTHS = 'L.L.L.L.L.L.L.L.';

const PC: Record<string, number> = { C: 0, Db: 1, D: 2, Eb: 3, E: 4, F: 5, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
const rootPc = (sym: string): number => PC[/^[A-G][b#]?/.exec(sym)![0]];
/** The chord's root in the bass register (Db1 .. C2). */
const bassRoot = (sym: string): number => {
  let r = rootPc(sym) + 24;
  while (r < 25) r += 12;
  while (r > 36) r -= 12;
  return r;
};

export default defineTrack({ id: 'redline-protocol', title: 'Redline Protocol', genre: 'Cyberpunk', bpm: 124, bars: 96, tail: 4 }, (s) => {
  s.key('F', 'minor');
  const S = s.sections({ intro: 8, verse: 16, build: 8, drop: 16, break: 8, verse2: 8, build2: 8, drop2: 16, outro: 8 });
  if (HARMONY.length !== s.bars) throw new Error(`redline-protocol: ${HARMONY.length} chords for ${s.bars} bars`);
  const prog = (from: number, to: number): string => HARMONY.slice(from, to).join(' | ');
  const chordsOf = (from: number, to: number, octave = 3): Pattern => s.chords(prog(from, to), { octave, lead: true });
  const mel = (lines: string[]): Pattern => s.notes(lines.join(' | '));

  /** A bass line over bars [from, to) from a per-step figure (see ROLL). */
  const bassLine = (from: number, to: number, figure: string, vel = 0.8): Pattern => {
    const b = s.pattern(to - from);
    for (let bar = from; bar < to; bar++) {
      const root = bassRoot(HARMONY[bar]);
      for (let i = 0; i < 16; i++) {
        const c = figure[i % figure.length];
        if (c === '.') continue;
        const n = c === 'H' ? root + 12 : c === '5' ? root + 7 : root;
        b.note((bar - from) * 4 + i * 0.25, n, 0.22, c === 'A' ? 1 : vel, c === 'A' ? FLAG.ACCENT : 0);
      }
    }
    return b.done();
  };

  /** A harmony line under a melody: the nearest chord tone at least a minor third below each note (chord of that bar). */
  const harmonyBelow = (melody: Pattern, startBar: number): Pattern => {
    const b = s.pattern(Math.ceil(melody.beats / 4));
    for (const e of melody.events) {
      const sym = HARMONY[startBar + Math.floor(e.t / 4 + 1e-9)];
      const tones = s.chordNotes(sym, { octave: 2 }).map((n) => n % 12);
      let h = e.n - 3;
      while (!tones.includes(((h % 12) + 12) % 12)) h--;
      b.note(e.t, h, e.d, e.v * 0.85, e.f);
    }
    return b.done();
  };

  /** The arp steps out of the melody's way: an arp note a semitone (or a minor ninth) from a melody note sounding with it drops an octave. */
  const avoid = (arpP: Pattern, arpBar: number, melody: Pattern, melBar: number): Pattern => {
    const shift = (melBar - arpBar) * 4;
    return arpP.map((e) => {
      const m = melody.events.find((x) => x.t + shift <= e.t + 1e-9 && x.t + shift + x.d > e.t + 1e-9);
      const d = m ? Math.abs(e.n - m.n) : 0;
      return m && (d === 1 || d === 13) ? { ...e, n: e.n - 12 } : e;
    });
  };

  // ── the mix ────────────────────────────────────────────────────────────────
  s.setReverb({ time: 2.3, damp: 0.45, return: -10, lowCut: 180, width: 1.2 });
  s.setDelay({ time: '1/8.', feedback: 0.36, return: -11, tone: 3800 });
  s.setSidechain({ release: 0.22, curve: 1.4 });
  s.setMaster({ trim: 5.5 });

  const drums = s.bus('drums', {});
  const music = s.bus('music', {});

  const kick = s.kick({ preset: 'darksynth-kick', decay: 0.34, drive: 8 }, { gain: -3, bus: 'drums', eqMid: -6, eqMidFreq: 260, eqMidQ: 0.9 });
  const snare = s.snare('darksynth-snare', { gain: -6, bus: 'drums', reverb: 0.08, fx: [fx.reverb({ gated: true, mix: 0.45, time: 2 })] });
  const clap = s.clap('big-clap', { gain: -12, bus: 'drums', reverb: 0.15, pan: 0.05 });
  const hat = s.hat('closed-hat', { gain: -11, pan: 0.18, bus: 'drums' });
  const toms = s.tom('synth-tom', { gain: -9, reverb: 0.2, bus: 'drums' });
  const crash = s.cymbal('crash', { gain: -12, reverb: 0.1, pan: -0.15 });
  const swell = s.cymbal('reverse-crash', { name: 'swell', gain: -13 });

  const bass = s.darkBass('darksynth-bass', { gain: -8, duck: 0.8, reverb: 0.02 });
  const sub = s.sub('sub-sine', { gain: -14, duck: 0.9 });
  const arp = s.synth('dark-pluck', { gain: -10, reverb: 0.15, delay: 0.25, width: 1.2, duck: 0.4, bus: 'music' });
  const pad = s.synth('supersaw-pad', { gain: -14, width: 1.5, reverb: 0.3, duck: 0.7, hp: 160, fx: [fx.chorus({ mix: 0.4 })], bus: 'music' });
  const saws = s.synth('supersaw-chord', { name: 'saws', gain: -4, width: 1.4, reverb: 0.2, duck: 0.65, hp: 220, bus: 'music' });
  const brass = s.synth('brass-stab', { name: 'brass', gain: -13, reverb: 0.15, duck: 0.5, bus: 'music' });
  const lead = s.synth('supersaw-lead', { name: 'lead', gain: -6, reverb: 0.22, delay: 0.28, bus: 'music' });
  const lead2 = s.synth('square-lead', { name: 'lead2', gain: -17, reverb: 0.25, delay: 0.3, pan: -0.1, bus: 'music' });
  const harm = s.synth('saw-lead', { name: 'harm', gain: -13, reverb: 0.22, delay: 0.2, pan: 0.12, bus: 'music' });
  const vlead = s.synth('saw-lead', { name: 'vlead', gain: -6, reverb: 0.22, delay: 0.3, bus: 'music' });
  const bell = s.synth('fm-bell', { name: 'bell', gain: -13, reverb: 0.4, delay: 0.3, pan: 0.15, bus: 'music' });
  const riser = s.riser('riser', { gain: -16 });
  const boom = s.impact('impact-deep', { name: 'boom', gain: -8, reverb: 0.3 });
  const down = s.riser('downlifter', { name: 'down', gain: -17, reverb: 0.2 });

  // ── drum patterns ──────────────────────────────────────────────────────────
  const FOUR = s.hits('X...x...x...x...');
  const FOUR_TURN = s.hits('X...x...x...x.x.');
  const kick4 = (bar: number, bars: number) => {
    for (let b = bar; b < bar + bars; b++) kick.play((b - bar) % 4 === 3 ? FOUR_TURN : FOUR, b, 1);
  };
  const BACKBEAT = s.hits('....X.......X...');
  const HATS8 = s.hits('x.x.x.x.x.x.x.xx');
  const HATS16 = s.hits('x3x3x3o3x3x3x3o3');
  // three fills for the ends of phrases: toms over the last half bar; snare then toms; a quick tom run on the last beat
  const TOM_FILL = s.notes('. . . . . . . . A2 . A2 F2 D2 D2 A1 A1');
  const fillA = (bar: number, vel = 0.8) => toms.play(TOM_FILL, bar, 1, { vel });
  const fillB = (bar: number, vel = 0.8) => {
    snare.play(s.hits('........x.x.xxx.'), bar, 1, { vel: vel * 0.8 });
    toms.play(s.notes('. . . . . . . . . . . . . . D2 A1'), bar, 1, { vel });
  };
  const fillC = (bar: number, vel = 0.7) => toms.play(s.notes('. . . . . . . . . . . . A2 F2 D2 A1'), bar, 1, { vel });
  const ROLL2 = s.hits('1.2.3.4.5.6.7.8.|1234567899999999');

  // ── intro (0-8): the arp alone, opening; a muffled kick and the sub from bar 4 ──
  arp.play(s.arp(chordsOf(0, 8), { order: 'updown', octaves: 2, accent: 'x...' }), S.intro);
  arp.ramp('cutoff', 0, 8, 380, arp.param('cutoff'), 'exp');
  pad.play(chordsOf(0, 8), S.intro);
  pad.ramp('mix.gain', 0, 4, -26, -14);
  kick4(4, 4);
  drums.auto('mix.lp', [[4, 320], [7.5, 1400, 'exp'], [8, 20000, 'step']]);
  sub.play(s.chords(prog(4, 8), { octave: 1 }).roots({ low: 25 }), 4, 4);
  fillA(7);
  swell.note(7, 'A3', 4, 0.9);

  // ── verse (8-24): drums, the rolling bass, the arp; the verse melody in its second half ──
  kick4(S.verse.bar, S.verse.bars);
  snare.play(BACKBEAT, S.verse);
  hat.play(HATS8, S.verse.bar, 8);
  hat.play(HATS16, S.verse.bar + 8, 8, { vel: 0.9 });
  clap.play(BACKBEAT, S.verse.bar + 8, 8);
  crash.hit(S.verse.bar, '', 1);
  crash.hit(S.verse.bar + 8, '', 0.8);
  bass.play(bassLine(S.verse.bar, S.verse.end, ROLL), S.verse);
  bass.set('drive', 9, S.verse.bar);
  bass.set('clip', 4, S.verse.bar);
  bass.set('drive', 12, S.verse.bar + 8);
  bass.ramp('cutoff', S.verse.bar, S.verse.bar + 8, 420, 700, 'exp');
  arp.play(avoid(s.arp(chordsOf(S.verse.bar, S.verse.end), { order: 'updown', octaves: 2, accent: 'x...' }), S.verse.bar, mel(VERSE_MEL), S.verse.bar + 8), S.verse);
  pad.play(chordsOf(S.verse.bar + 8, S.verse.end), S.verse.bar + 8, 8);
  vlead.play(mel(VERSE_MEL), S.verse.bar + 8, 8);
  fillB(S.verse.end - 1, 0.75);

  // ── build (24-32): stabs, eighth-note bass, the filters open, a roll, a beat of silence ──
  const B = S.build;
  kick4(B.bar, 6);
  snare.play(BACKBEAT, B.bar, 4);
  snare.play(s.hits('....X.......X...|....X...X...X.X.'), B.bar + 4, 2);
  snare.play(ROLL2, B.bar + 6, 1.75, { vel: 0.65 });
  snare.auto('mix.hp', [[B.bar + 4, 20], [B.end - 0.25, 700, 'exp'], [B.end, 20, 'step']]);
  hat.play(HATS16, B.bar, 6);
  brass.play(chordsOf(B.bar, B.end).rhythm('x..x..x...x..x..'), B.bar, B.bars - 0.25);
  brass.ramp('cutoff', B.bar, B.end, 600, 2400, 'exp');
  bass.play(bassLine(B.bar, B.end, EIGHTHS), B.bar, B.bars - 0.25);
  bass.set('drive', 14, B.bar);
  bass.ramp('cutoff', B.bar, B.end, 500, 1600, 'exp');
  arp.play(s.arp(chordsOf(B.bar, B.end), { order: 'up', octaves: 2, accent: 'x...' }), B.bar, B.bars - 0.25);
  arp.ramp('cutoff', B.bar, B.end, arp.param('cutoff'), 2600, 'exp');
  pad.play(chordsOf(B.bar, B.end), B.bar, B.bars - 0.25);
  pad.ramp('mix.hp', B.bar + 4, B.end, 160, 900, 'exp');
  riser.hit(B.bar + 4, '', 1, 0, 15);
  swell.note(B.end - 1, 'A3', 4, 1);

  // ── drop (32-48): the hook, supersaw chords, the heavy bass ──
  const D = S.drop;
  boom.hit(D.bar, '', 1);
  crash.hit(D.bar, '', 1);
  crash.hit(D.bar + 8, '', 0.9);
  kick4(D.bar, D.bars);
  snare.play(BACKBEAT, D);
  clap.play(BACKBEAT, D);
  hat.play(HATS16, D);
  fillC(D.bar + 7, 0.6);
  fillA(D.bar + 15, 0.55);
  down.hit(D.end, '', 0.9, 0, 8);
  bass.play(bassLine(D.bar, D.end, ROLL_DROP), D);
  bass.set('cutoff', 760, D.bar);
  bass.set('drive', 18, D.bar);
  bass.set('clip', 9, D.bar);
  sub.play(s.chords(prog(D.bar, D.end), { octave: 1 }).roots({ low: 25 }), D);
  saws.play(chordsOf(D.bar, D.end), D);
  arp.play(s.arp(chordsOf(D.bar, D.end), { order: 'up', octaves: 1, accent: 'x...' }), D, undefined, { vel: 0.7 });
  arp.set('cutoff', arp.param('cutoff'), D.bar);
  arp.set('mix.gain', -12, D.bar);
  pad.set('mix.hp', 160, D.bar);
  lead.play(mel(HOOK_A), D.bar, 8);
  lead.play(mel(HOOK_B), D.bar + 8, 8);
  lead.set('mix.delay', 0.6, D.end - 0.5);
  lead.set('mix.delay', 0.28, D.end);

  // ── break (48-56): no kick; the bell sings the hook slowly over long bass notes; half time from bar 52 ──
  const K = S.break;
  arp.set('mix.gain', -10, K.bar);
  bell.play(mel(BREAK_MEL), K);
  pad.play(chordsOf(K.bar, K.end), K);
  bass.play(s.chords(prog(K.bar, K.end), { octave: 1 }).roots({ low: 25 }), K, undefined, { vel: 0.7 });
  bass.ramp('cutoff', K.bar, K.end, 300, 520, 'exp');
  bass.set('cutoff', 700, S.verse2.bar);
  bass.set('drive', 12, K.bar);
  arp.play(s.arp(chordsOf(K.bar + 4, K.end), { order: 'updown', octaves: 2, accent: 'x...' }), K.bar + 4, 4, { vel: 0.6 });
  snare.play(s.hits('........X.......'), K.bar + 4, 3);
  kick.play(s.hits('X.........X.....'), K.bar + 4, 3);
  hat.play(s.hits('x.x.x.x.x.x.x.x.'), K.bar + 4, 4, { vel: 0.7 });
  fillA(K.end - 1, 0.8);
  swell.note(K.end - 1, 'A3', 4, 0.9);

  // ── verse 2 (56-64): the drums back, the verse melody on the big lead with the bell above ──
  const V = S.verse2;
  crash.hit(V.bar, '', 1);
  kick4(V.bar, V.bars);
  snare.play(BACKBEAT, V);
  hat.play(HATS8, V.bar, 4);
  hat.play(HATS16, V.bar + 4, 4);
  clap.play(BACKBEAT, V.bar + 4, 4);
  bass.play(bassLine(V.bar, V.end, ROLL), V);
  arp.play(avoid(s.arp(chordsOf(V.bar, V.end), { order: 'updown', octaves: 2, accent: 'x...' }), V.bar, mel(VERSE_MEL), V.bar), V);
  pad.play(chordsOf(V.bar, V.end), V);
  lead.play(mel(VERSE_MEL), V, undefined, { vel: 0.85 });
  bell.play(mel(VERSE_MEL), V, undefined, { transpose: 12, vel: 0.6 });

  // ── build 2 (64-72): as the first, longer roll, everything rising ──
  const B2 = S.build2;
  kick4(B2.bar, 4);
  kick.play(s.hits('X...X...X...X...|X.X.X.X.X.X.X.X.'), B2.bar + 4, 2);
  snare.play(BACKBEAT, B2.bar, 2);
  snare.play(s.hits('x.x.x.x.x.x.x.x.|x.x.x.x.x.x.x.x.'), B2.bar + 2, 2, { vel: 0.55 });
  snare.play(ROLL2, B2.bar + 4, 2, { vel: 0.6 });
  snare.play(s.hits('1234567899999999|99999999........'), B2.bar + 6, 1.75, { vel: 0.7 });
  snare.auto('mix.hp', [[B2.bar + 2, 20], [B2.end - 0.25, 900, 'exp'], [B2.end, 20, 'step']]);
  bass.set('drive', 16, B2.bar);
  hat.play(HATS16, B2.bar, 6);
  brass.play(chordsOf(B2.bar, B2.end).rhythm('x..x..x...x..x..'), B2.bar, B2.bars - 0.25);
  brass.ramp('cutoff', B2.bar, B2.end, 600, 3200, 'exp');
  bass.play(bassLine(B2.bar, B2.bar + 4, EIGHTHS), B2.bar, 4);
  bass.play(bassLine(B2.bar + 4, B2.end, ROLL), B2.bar + 4, B2.bars - 4.25);
  bass.ramp('cutoff', B2.bar, B2.end, 420, 1400, 'exp');
  saws.play(chordsOf(B2.bar + 4, B2.end), B2.bar + 4, 3.75);
  saws.ramp('mix.gain', B2.bar + 4, B2.end, -20, -4);
  arp.play(s.arp(chordsOf(B2.bar, B2.end), { order: 'up', octaves: 2, accent: 'x...' }), B2.bar, B2.bars - 0.25);
  arp.ramp('cutoff', B2.bar, B2.end, arp.param('cutoff'), 3000, 'exp');
  pad.play(chordsOf(B2.bar, B2.end), B2.bar, B2.bars - 0.25);
  pad.ramp('mix.hp', B2.bar + 4, B2.end, 160, 1000, 'exp');
  riser.hit(B2.bar, '', 1, 0, 31);
  swell.note(B2.end - 1, 'A3', 4, 1);

  // ── drop 2 (72-88): the hook doubled an octave down and harmonised; heavier bass; brass answers ──
  const D2 = S.drop2;
  boom.hit(D2.bar, '', 1);
  crash.hit(D2.bar, '', 1);
  crash.hit(D2.bar + 8, '', 1);
  kick4(D2.bar, D2.bars);
  snare.play(BACKBEAT, D2);
  clap.play(BACKBEAT, D2);
  hat.play(HATS16, D2);
  fillC(D2.bar + 7, 0.7);
  fillB(D2.end - 1, 0.8);
  bass.play(bassLine(D2.bar, D2.end, ROLL_DROP), D2);
  bass.set('cutoff', 820, D2.bar);
  bass.set('drive', 22, D2.bar);
  bass.set('clip', 10, D2.bar);
  sub.play(s.chords(prog(D2.bar, D2.end), { octave: 1 }).roots({ low: 25 }), D2);
  saws.play(chordsOf(D2.bar, D2.end), D2);
  saws.set('mix.gain', -4, D2.bar);
  arp.set('mix.gain', -12, D2.bar);
  arp.set('mix.gain', -10, S.outro.bar);
  arp.play(s.arp(chordsOf(D2.bar, D2.end), { order: 'up', octaves: 1, accent: 'x...' }), D2, undefined, { vel: 0.7 });
  arp.set('cutoff', arp.param('cutoff'), D2.bar);
  pad.set('mix.hp', 160, D2.bar);
  const hook2 = mel(HOOK_A).then(mel(HOOK_B));
  lead.play(hook2, D2);
  lead2.play(hook2, D2, undefined, { transpose: 12, vel: 0.8 });
  harm.play(harmonyBelow(hook2, D2.bar), D2, undefined, { vel: 0.8 });
  brass.play(chordsOf(D2.bar + 8, D2.end).rhythm('......x.......x.'), D2.bar + 8, 8);
  brass.set('cutoff', 2200, D2.bar);

  // ── outro (88-96): the drums for four bars, then the arp and the bell close the circle ──
  const O = S.outro;
  crash.hit(O.bar, '', 0.8);
  kick4(O.bar, 4);
  snare.play(BACKBEAT, O.bar, 4);
  hat.play(HATS8, O.bar, 4);
  bass.play(bassLine(O.bar, O.bar + 4, ROLL), O.bar, 4);
  bass.set('drive', 14, O.bar);
  bass.set('clip', 8, O.bar);
  const outroBell = mel(HOOK_A.slice(0, 2)).then(s.silence(2)).then(mel(HOOK_A.slice(0, 2)));
  arp.play(avoid(s.arp(chordsOf(O.bar, O.end), { order: 'updown', octaves: 2, accent: 'x...' }), O.bar, outroBell, O.bar), O.bar, O.bars - 0.5);
  arp.ramp('cutoff', O.bar + 4, O.end, arp.param('cutoff'), 420, 'exp');
  pad.play(chordsOf(O.bar, O.end - 1), O.bar, O.bars - 1);
  bell.play(mel(HOOK_A.slice(0, 2)), O.bar, 2, { vel: 0.7 });
  bell.play(mel(HOOK_A.slice(0, 2)), O.bar + 4, 2, { vel: 0.55 });
  pad.play(s.chords('Fm', { octave: 3 }), O.end - 1, 1);
  saws.play(s.chords('Fm', { octave: 3 }), O.end - 1, 1, { vel: 0.8 });
  sub.note(O.end - 1, 'F1', 4, 0.9);
  boom.hit(O.end - 1, '', 0.8);
  music.auto('mix.lp', [[O.bar + 4, 20000], [O.end - 1, 2400, 'exp']]);
});
