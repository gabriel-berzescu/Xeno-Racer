// Solar Chariot: melodic Goa trance for Xeno-Racer Vol. 1. 143 BPM, A phrygian dominant (A Bb C# D E F G).
// The sun god's chariot: a flight, not a descent. Bright major tonic, the flat second as the exotic lift.
//
// Harmony. The grooves sit on an A drone (the roll on A1, the b2 Bb as the colour). The theme moves, two bars per chord:
//   A | Bb | Gm | A     (I - bII - bvii - I: the phrygian-dominant lift a semitone up and back)
//   Dm | C | Bb | A     (the descending tetrachord D-C-Bb-A: i - bVII - bVI - V of D minor, landing on our major I)
// The journey lifts its drone a semitone (A, then Bb, then A); the climax plays the whole theme a semitone higher (in Bb), and the
// outro falls back to A: the bII - I cadence of the mode, over the whole form.
//
// Theme A (16 bars). A rising call, E5 - C#5 E5 A5 (the A5 pushed a sixteenth early), its sigh Bb5-A5-G5-E5, the same call a
// semitone up over Bb (F5 - D5 F5 Bb5); a falling answer over Gm and the hijaz turn D5 C#5 Bb4 C#5 onto an open E5. The second
// half climbs against the falling bass: D5-E5-F5-A5, E5-F5-G5-C6, F5-G5-A5-D6, the peak D6 (and E6, the #11 of Bb), then the
// augmented second Bb5 -> C#6 lands on the A chord and the line comes home to A5.
//
// Form (bars): intro 0-8 (the kick at bar 4), groove 8-24 (the theme hinted at 20), theme 24-40, journey 40-56 (theme B: an
// off-beat riff on a reed voice, the drone lifting to Bb), float 56-64 and build 64-72 (the break: the theme in long notes),
// peak 72-88 (the theme harmonised in thirds and sixths), climax 88-104 (a semitone up, three voices), outro 104-120.
//
// Harmony check (CLASH=1 and CLASH=2 give the same 11 lines). All are meant, each two sixteenths long, all in the hook (theme,
// peak, and the climax a semitone up):
//   - bar 7 of the hook (bars 30, 78, 94): the hijaz turn C#5 D5 C#5 Bb4 C#5 over the A chord. The upper neighbour D5 rubs the
//     pad's C#4, the lower neighbour Bb4 (an augmented second under C#) the pad's A3; at the peak the second voice's Bb4 under D5
//     makes the passing bII-over-I chord, the sound of the mode.
//   - bar 11 of the hook (bars 34, 82, 98): the passing F5 of the climb E5-F5-G5-C6, over the C chord's E4.
// The arp and the orbit never rub the melodies: clear() drops the few sixteenths where they would (3 to 8 of 256 per section).
//
// Probe:  ALBUM=1 ONLY=solar-chariot AUTOTRIM=1 SPEC=1 CLASH=1 npx vitest run tests/probes/album-render.test.ts
import { FLAG, Pattern, defineTrack, fx, type SynthOpts } from '../song';

const TRIM = 2.6; // master trim in dB (AUTOTRIM=1)

/** Bars of note text joined with bar lines. */
const bars = (...b: string[]): string => b.join(' | ');

/**
 * A counter-line that yields to the melody: drops the notes of `p` that would sound a minor second or a minor ninth against a
 * note of `against` (all patterns placed at the same bar). The arp and the orbit lose a sixteenth here and there where the hook
 * takes a neighbour note, instead of grinding against it.
 */
const clear = (p: Pattern, ...against: Pattern[]): Pattern => {
  const others = against.flatMap((q) => q.events.filter((e) => e.part === ''));
  return p.filter((e) => !others.some((o) => o.t < e.t + e.d - 1e-9 && e.t < o.t + o.d - 1e-9 && (Math.abs(o.n - e.n) === 1 || Math.abs(o.n - e.n) === 13)));
};
/**
 * Phrases a line like a singer, for a legato patch: a note that starts a breath (`breath(t)`, t in beats from the start of the
 * pattern; by default every bar line) keeps its own attack; every other note is slurred from the one before it, which is held a hair
 * (0.01 beat) into it, so the envelopes go on and the pitch moves with the patch's fingered glide. A note after a rest starts fresh,
 * and a slid note (~) is tied anyway. The overlap ends before the probe's harmony check looks (0.02 beat after each sixteenth), so a
 * slur never shows as a second between a note and the next.
 */
const slur = (p: Pattern, breath: (t: number) => boolean = (t) => Math.abs(t / 4 - Math.round(t / 4)) < 1e-9): Pattern => {
  const ev = p.events;
  return p.map((e, i) => {
    const next = ev[i + 1];
    if (!next || breath(next.t) || next.f & FLAG.SLIDE || next.t - (e.t + e.d) > 0.05) return e;
    return { ...e, d: next.t - e.t + 0.01 };
  });
};
/** The same notes without slide marks (for a polyphonic voice that doubles a legato line). */
const noSlide = (p: Pattern): Pattern => p.map((e) => ({ ...e, f: e.f & ~FLAG.SLIDE }));

// ── patches ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The theme's voice: five saws and a triangle for body, a faint saw an octave up for shimmer, a resonant ladder that blooms on
 * every attack, a late vibrato. Fingered glide: a 15 ms slide inside the slurs only; the swoops are the notes marked ~. */
const SUNLEAD: SynthOpts = {
  mode: 'legato', voices: 1,
  layers: [
    { wave: 'saw', unison: 5, detune: 1, phase: 'free' },
    { wave: 'tri', level: 0.55, phase: 'free' },
    { wave: 'saw', octave: 1, level: 0.2, phase: 'free' },
  ],
  filter: 'ladder', cutoff: 2400, res: 0.32, envAmt: 1.8, fAttack: 0.003, fDecay: 0.3, fSustain: 0.42, fRelease: 0.4, keytrack: 0.55, velFilter: 0.6,
  attack: 0.005, decay: 0.6, sustain: 0.82, release: 0.45,
  glide: 0.015, glideMode: 'fingered', vibDepth: 16, vibRate: 5.4, vibDelay: 0.35, unisonDetune: 12, spread: 0.7, level: 6,
};
/** The second voice of the peak: the same family, darker and without the octave shimmer, so the hook stays on top. */
const HARMLEAD: SynthOpts = {
  ...SUNLEAD,
  layers: [{ wave: 'saw', unison: 5, detune: 0.9, phase: 'free' }, { wave: 'tri', level: 0.6, phase: 'free' }],
  cutoff: 1900, res: 0.25, envAmt: 1.4, vibDepth: 12, vibRate: 5.1,
};
/** The break's voice: a soft, breathy flute (triangle, a sine an octave up, a whisper of saws and noise), slow vibrato. */
const BREATH: SynthOpts = {
  mode: 'legato', voices: 1,
  layers: [{ wave: 'tri', phase: 'free' }, { wave: 'sine', octave: 1, level: 0.22, phase: 'free' }, { wave: 'saw', unison: 3, detune: 0.5, level: 0.2, phase: 'free' }],
  filter: 'lp', cutoff: 2400, res: 0.1, keytrack: 0.4, envAmt: 0.5, fAttack: 0.25, fDecay: 1.2, fSustain: 0.7,
  attack: 0.12, decay: 0.8, sustain: 0.9, release: 1.2, noise: 0.04,
  glide: 0.07, glideMode: 'fingered', vibDepth: 24, vibRate: 4.8, vibDelay: 0.5, unisonDetune: 8, spread: 0.5,
};
/** Theme B's voice: a hollow, nasal pulse lead with a quick filter blip and a breathy tongued click (a synth shawm); crisp, it
 * slides only where the riff says ~. */
const REED: SynthOpts = {
  mode: 'mono', voices: 1,
  layers: [{ wave: 'pulse', unison: 3, detune: 0.6, phase: 'free' }, { wave: 'saw', level: 0.4, phase: 'free' }],
  pw: 0.32, pwmDepth: 0.12, pwmRate: 0.3,
  filter: 'ladder', cutoff: 1500, res: 0.38, envAmt: 2.4, fDecay: 0.16, fSustain: 0.25, keytrack: 0.7, velFilter: 0.8,
  attack: 0.003, decay: 0.25, sustain: 0.6, release: 0.12, glide: 0.025, glideMode: 'fingered', unisonDetune: 9, spread: 0.6, level: 6,
  click: 0.2, clickTone: 2000, clickDecay: 0.008,
};
/** The orbit: a glassy FM pluck (ratio 3) with a saw pair under it, for the twisting sixteenths. */
const ORBIT: SynthOpts = {
  layers: [{ wave: 'fm' }, { wave: 'saw', unison: 2, detune: 0.5, level: 0.4 }],
  fmRatio: 3, fmIndex: 3, fmDecay: 0.09, fmSustain: 0.08,
  filter: 'ladder', cutoff: 1800, res: 0.4, envAmt: 2.6, fDecay: 0.14, fSustain: 0, keytrack: 0.7,
  attack: 0.001, decay: 0.2, sustain: 0, release: 0.09, voices: 6, unisonDetune: 7, spread: 0.5, level: 12,
};
/** The chord arp under the theme: short, bright and round (three saws, no octave layer), with a pick click so that its
 * sixteenths stay distinct under the hook without being louder. */
const ARPP: SynthOpts = { preset: 'arp-bright', cutoff: 2600, res: 0.22, decay: 0.16, release: 0.1, click: 0.25, clickTone: 3500, clickDecay: 0.006 };
/** The pad: the supersaw pad without its sub-octave saws (they sat in the acid's register). */
const PADP: SynthOpts = { preset: 'supersaw-pad', layers: [{ wave: 'saw', unison: 6 }], cutoff: 2200 };
/** The sky: a pure triangle and sine for the octave above the climax. */
const SKY: SynthOpts = {
  mode: 'legato', voices: 1,
  layers: [{ wave: 'tri', phase: 'free' }, { wave: 'sine', level: 0.5, phase: 'free' }],
  filter: 'lp', cutoff: 5000, res: 0.05, keytrack: 0,
  attack: 0.02, decay: 0.5, sustain: 0.85, release: 0.5, glide: 0.02, glideMode: 'fingered', vibDepth: 12, vibRate: 5.6, vibDelay: 0.4, level: 4,
};

export default defineTrack({ id: 'solar-chariot', title: 'Solar Chariot', genre: 'Goa trance', bpm: 143, bars: 120, tail: 4 }, (s) => {
  s.key('A', 'phrygian dominant');
  const S = s.sections({ intro: 8, groove: 16, theme: 16, journey: 16, float: 8, build: 8, peak: 16, climax: 16, outro: 16 });

  // ── instruments ───────────────────────────────────────────────────────────────────────────────────────────────────
  const kick = s.kick('psy-kick', { gain: -3 });
  const bass = s.synth('psy-bass', { name: 'bass', gain: -6, duck: 1 });
  const acid = s.acid('goa-acid', { name: 'acid', gain: -10, pan: 0.1, delay: 0.18, reverb: 0.05 });
  const clap = s.clap('clap', { gain: -9, reverb: 0.15, pan: -0.05 });
  const snare = s.snare('tight-snare', { name: 'snare', gain: -11, reverb: 0.12 });
  const chat = s.hat('tight-hat', { name: 'chat', gain: -13, pan: 0.22 });
  const ohat = s.hat('closed-hat', { name: 'ohat', gain: -11, pan: -0.15 });
  const shaker = s.perc('shaker', { name: 'shaker', gain: -16, pan: -0.35 });
  const tamb = s.perc('tambourine', { name: 'tamb', gain: -14, pan: 0.35 });
  const crash = s.cymbal('crash', { gain: -10, reverb: 0.2 });
  const swell = s.cymbal('reverse-crash', { name: 'swell', gain: -12 });
  const pad = s.synth(PADP, { name: 'pad', gain: -12, duck: 0.7, reverb: 0.35, hp: 200, fx: [fx.gate({ pattern: 'x.xx.xx.x.xx.xx.' }), fx.chorus({ rate: 0.25, depth: 4 })] });
  const arp = s.synth(ARPP, { name: 'arp', gain: -7, pan: 0.25, delay: 0.22, reverb: 0.15, duck: 0.3 });
  const orbit = s.synth(ORBIT, { name: 'orbit', gain: -9, pan: -0.25, delay: 0.25, reverb: 0.2, duck: 0.3, fx: [fx.filter({ mode: 'lp', cutoff: 2600, res: 1.2, lfoRate: 0.125, lfoDepth: 0.8 })] });
  const lead = s.synth(SUNLEAD, { name: 'lead', gain: -1.5, delay: 0.28, reverb: 0.25 });
  const harm = s.synth(HARMLEAD, { name: 'harm', gain: -8, delay: 0.22, reverb: 0.3, pan: 0.2 });
  const reed = s.synth(REED, { name: 'reed', gain: -5, delay: 0.3, reverb: 0.2, pan: -0.1 });
  const breath = s.synth(BREATH, { name: 'breath', gain: -5, delay: 0.4, reverb: 0.5 });
  const sky = s.synth(SKY, { name: 'sky', gain: -11, delay: 0.3, reverb: 0.4, pan: -0.15 });
  const bell = s.synth('fm-bell', { name: 'bell', gain: -7, delay: 0.5, reverb: 0.45, pan: 0.3 });
  const drone = s.sub('sub-sine', { name: 'drone', gain: -16 });
  const riser = s.riser('riser', { gain: -15 });
  const wash = s.riser('noise-wash', { name: 'wash', gain: -17 });
  const whoosh = s.riser('whoosh', { name: 'whoosh', gain: -16, reverb: 0.3 });
  const down = s.riser('downlifter', { name: 'down', gain: -14, reverb: 0.3 });
  const boom = s.impact('impact', { name: 'boom', gain: -7, reverb: 0.25 });
  const zap = s.zap('zap-fm', { name: 'zap', gain: -16, delay: 0.45, reverb: 0.35 });

  // ── harmony ──────────────────────────────────────────────────────────────────────────────────────────────────────
  // hand-voiced triads in A3-F4, root position except Dm (A3 D4 F4): close to each other, under the hook's register
  const V: Record<string, string> = { A: '[A3,C#4,E4]', Bb: '[Bb3,D4,F4]', Gm: '[G3,Bb3,D4]', Dm: '[A3,D4,F4]', C: '[G3,C4,E4]' };
  const ROOT: Record<string, string> = { A: 'A1', Bb: 'Bb1', Gm: 'G1', Dm: 'D2', C: 'C2' };
  /** Chords held for whole bars, one name per bar; the same chord on the next bar is held on, not struck again. */
  const hold = (names: string[]): Pattern => {
    const toks: string[] = [];
    for (let i = 0; i < names.length; ) {
      let j = i;
      while (j < names.length && names[j] === names[i]) j++;
      toks.push(`${V[names[i]]}:${16 * (j - i)}`);
      i = j;
    }
    return s.notes(toks.join(' '), { gate: 1 });
  };
  const rep = (c: string, n: number): string[] => Array.from({ length: n }, () => c);
  const THEME = ['A', 'A', 'Bb', 'Bb', 'Gm', 'Gm', 'A', 'A', 'Dm', 'Dm', 'C', 'C', 'Bb', 'Bb', 'A', 'A'];
  const FLOAT = [...rep('A', 4), ...rep('Bb', 4)];
  const BUILD = ['Dm', 'Dm', 'C', 'C', 'Bb', 'Bb', 'Bb', 'Bb'];

  // ── Theme A: the hook (see the header). The pushed notes land a sixteenth before the beat. Four swoops (~): the call's leap,
  // its echo over Bb, the leap to the peak D6 and the augmented second onto the tonic chord; everything else is sung legato (slur).
  const themeA = s.notes(bars(
    'E5 - - - - - - - C#5 - E5 A5~ - - - -', //       A  the call: down a third, up, the leap pushed
    '- - - - - - Bb5 - A5 - - - G5 - E5 -', //         A  the sigh through the flat second
    'F5 - - - - - - - D5 - F5 Bb5~ - - - -', //       Bb the same call a semitone higher
    '- - - - - - C6 - Bb5 - - - A5 - F5 -', //         Bb
    'G5 - - - - - - - F5 - D5 Bb4 - - - -', //         Gm the answer falls
    '- - - - - - C5 - D5 - - - E5 - D5 -', //          Gm
    'C#5 - - - - - - - D5 - C#5 - Bb4 - C#5 -', //     A  the hijaz turn: upper neighbour, the augmented second below
    'E5 - - - - - - - - - - - . . . .', //             A  open, on the fifth
    'D5 - - - - - - - E5 - F5 A5 - - - -', //          Dm the climb begins against the falling bass
    '- - - - - - - - G5 - F5 - E5 - F5 -', //          Dm
    'E5 - - - - - - - F5 - G5 C6 - - - -', //          C
    '- - - - - - - - Bb5 - A5 - G5 - A5 -', //         C
    'F5 - - - - - - - G5 - A5 D6~ - - - -', //         Bb the peak
    '- - - - - - - - E6 - D6 - C6 - Bb5 -', //         Bb E6: the #11, the brightest note
    'C#6~ - - - - - - - D6 - C#6 - Bb5 - C#6 -', //    A  the augmented second Bb5 -> C#6 lands on the tonic chord
    'A5 - - - - - - - - - - - . . . .', //             A  home
  ));
  // the second voice of the peak: thirds and sixths under the hook, in its rhythm, chord tones on the strong beats (it holds C#5
  // under the sigh of bar 2: a major sixth under Bb5; over C in bar 12 it moves in sixths, clear of the chord's E)
  const harmA = s.notes(bars(
    'C#5 - - - - - - - A4 - C#5 - - - - -',
    '- - - - - - - - - - - - E5 - C#5 -',
    'D5 - - - - - - - Bb4 - D5 - - - - -',
    '- - - - - - - - - - - - F5 - D5 -',
    'D5 - - - - - - - - - Bb4 G4 - - - -',
    '- - - - - - A4 - Bb4 - - - G4 - Bb4 -',
    'A4 - - - - - - - Bb4 - A4 - G4 - A4 -',
    'C#5 - - - - - - - - - - - . . . .',
    'A4 - - - - - - - C#5 - D5 F5 - - - -',
    '- - - - - - - - E5 - D5 - C#5 - D5 -',
    'C5 - - - - - - - D5 - E5 - - - - -',
    '- - - - - - - - D5 - C5 - Bb4 - C5 -',
    'D5 - - - - - - - E5 - F5 - - - - -',
    '- - - - - - - - G5 - F5 - E5 - D5 -',
    'A5 - - - - - - - Bb5 - A5 - G5 - A5 -',
    'E5 - - - - - - - - - - - . . . .',
  ));
  // the climax's last four bars go higher: F6 over Bb, then the whole hijaz tetrachord down from E6 to the tonic
  const climaxEnd = s.notes(bars(
    'F5 - - - - - - - G5 - A5 D6~ - - - -',
    '- - - - - - - - E6 - F6 - E6 - D6 -',
    'C#6~ - - - - - - - E6 - D6 - C#6 - Bb5 -',
    'A5 - - - - - - - - - - - . . . .',
  ));
  const climaxHarmEnd = s.notes(bars(
    'D5 - - - - - - - E5 - F5 - - - - -',
    '- - - - - - - - G5 - A5 - G5 - F5 -',
    'A5 - - - - - - - C#6 - Bb5 - A5 - G5 -',
    'E5 - - - - - - - - - - - . . . .',
  ));
  // as played: one breath per bar line, the rest slurred (see slur())
  const hook = slur(themeA);
  const harmLine = slur(harmA);
  const themeClimax = slur(themeA.slice(0, 48).then(climaxEnd));
  const harmClimax = slur(harmA.slice(0, 48).then(climaxHarmEnd));
  // the sky: the hook an octave up for the first half, then the second voice an octave up (a sixth above the hook)
  const skyLine = slur(themeA.slice(0, 32).octave(1).then(harmA.slice(32, 48).then(climaxHarmEnd).octave(1)));
  // the call alone (the hook's first two bars), and the hint of the groove: the call, then again, stopping on the sigh
  const motif = hook.slice(0, 8);
  const hint2 = slur(s.notes(bars('E5 - - - - - - - C#5 - E5 A5~ - - - -', '- - - - - - Bb5 - A5 - - - . . . .')));

  // ── the break: the theme in long notes (bars 1-4 at half speed over A and Bb, then the climb in whole notes to the E6 hang)
  const breathTheme = s.notes(bars(
    'E5 - - - - - - - - - - - - - - -',
    'C#5 - - - E5 - A5~ - - - - - - - - -',
    '- - - - - - - - - - - - Bb5 - - -',
    'A5 - - - - - - - G5 - - - E5 - - -',
    'F5 - - - - - - - - - - - - - - -',
    'D5 - - - F5 - Bb5~ - - - - - - - - -',
    '- - - - - - - - - - - - C6 - - -',
    'Bb5 - - - - - - - A5 - - - F5 - - -',
    'D5 - - - - - - - E5 - - - F5 - - -', //    Dm
    'A5~ - - - - - - - - - - - - - - -',
    'E5 - - - - - - - G5 - - - A5 - - -', //    C
    'C6~ - - - - - - - - - - - - - - -',
    'F5 - - - - - - - G5 - - - A5 - - -', //    Bb
    'D6~ - - - - - - - - - - - - - - -',
    '- - - - - - - - - - - - - - - -',
    'E6 - - - - - - - - - - - - - - -', //      the #11 hangs over Bb; at the drop the same E sounds as the fifth of A
  ));
  // sung in four-bar breaths in the first half (the hook's two-bar ones at half speed), then one per chord, and the hang
  const breathLine = slur(breathTheme, (t) => [0, 16, 32, 40, 48, 60].includes(t));

  // ── Theme B (the journey): an off-beat riff, a question and its answer, on the reed
  const riffA = s.notes(bars(
    '. E5 . A5 G5 . A5 . . Bb5 . A5 G5 . E5 .',
    '. F5 . E5 D5 . E5 . . C#5 . D5 E5~ - - -',
    '. E5 . A5 G5 . A5 . . C#6 . Bb5 A5 . G5 .',
    '. A5 . G5 F5 . E5 . . D5 . C#5 Bb4 - C#5~ -',
  ));
  // the second time the answer soars a third higher (to E6) and falls through the whole mode onto C#5
  const riffA2 = riffA.slice(0, 8).then(s.notes(bars(
    '. A5 . C#6 Bb5 . C#6 . . E6 . D6 C#6 . Bb5 .',
    '. C#6 . Bb5 A5 . G5 . . F5 . E5 D5 - C#5~ -',
  )));
  // the same riff with the drone a semitone up, on Bb (A5 is now the leading note under Bb5, C6 the bright ninth)
  const riffBb = s.notes(bars(
    '. F5 . Bb5 A5 . Bb5 . . C6 . Bb5 A5 . F5 .',
    '. G5 . F5 E5 . F5 . . D5 . E5 F5~ - - -',
    '. F5 . Bb5 A5 . Bb5 . . D6 . C6 Bb5 . A5 .',
    '. Bb5 . A5 G5 . F5 . . E5 . D5 C#5~ - - -',
  ));

  // ── the orbit: four-note cells, the A major arpeggio with a colour on top (b9, octave, b7), and falling tails through A7 and
  // A7(b9) (C#6 Bb5 G5 E5): only chord tones, the b7 and the b9 two octaves above the pad's A3, so it never rubs the pad.
  // Eight bars that evolve: the statement (1-2), the cells inverted a step higher (3-4), the statement (5-6), a spiral up through
  // the arpeggio to E6 (7) and a fall back down to E4 (8).
  const orbitA = s.notes(bars(
    'A4 C#5 E5 Bb5 A4 C#5 E5 A5 A4 C#5 E5 G5 A5 G5 E5 C#5',
    'A4 C#5 E5 Bb5 A4 C#5 E5 C#6 A4 C#5 E5 Bb5 C#6 Bb5 G5 E5',
  ));
  const orbit8 = orbitA.then(s.notes(bars(
    'C#5 E5 A5 Bb5 C#5 E5 A5 C#6 C#5 E5 A5 E6 C#6 Bb5 A5 E5',
    'C#5 E5 A5 Bb5 C#5 E5 A5 G5 C#5 E5 A5 C#6 Bb5 G5 E5 C#5',
  )), orbitA, s.notes(bars(
    'A4 C#5 E5 A5 C#5 E5 A5 C#6 E5 A5 C#6 E6 C#6 A5 E5 C#5',
    'A4 C#5 E5 Bb5 A4 C#5 E5 C#6 E6 C#6 Bb5 G5 E5 C#5 A4 E4',
  )));
  // the same over Bb: Bb major cells, the ninth C6 and the major seventh A5 on top
  const orbitBb = s.notes(bars(
    'Bb4 D5 F5 C6 Bb4 D5 F5 Bb5 Bb4 D5 F5 A5 Bb5 A5 F5 D5',
    'Bb4 D5 F5 C6 Bb4 D5 F5 D6 Bb4 D5 F5 C6 D6 C6 A5 F5',
    'D5 F5 Bb5 C6 D5 F5 Bb5 D6 D5 F5 Bb5 F6 D6 C6 Bb5 F5',
    'Bb4 D5 F5 Bb5 D5 F5 Bb5 D6 F5 Bb5 D6 F6 D6 Bb5 F5 D5',
  ));
  // a twisting order over the chord tones (two octaves of the voicing), for the arp of the theme; another for the climax
  const themeArp = s.arp(hold(THEME), { order: [0, 2, 4, 3, 1, 3, 5, 4, 2, 4, 5, 3, 1, 2, 4, 2], octaves: 2, res: 4 });
  const climaxArp = s.arp(hold(THEME), { order: [0, 5, 1, 4, 2, 3, 2, 4, 1, 5, 0, 3, 1, 4, 2, 5], octaves: 2, res: 4 });
  const buildArp = s.arp(hold(BUILD), { order: 'updown', octaves: 2, res: 4 });

  // ── bass: the off-beat roll (psy-bass: the three sixteenths after each kick)
  const rollBar = (n: string): string => `. ${n} ${n} ${n} . ${n} ${n} ${n} . ${n} ${n} ${n} . ${n} ${n} ${n}`;
  const pedal = s.notes(bars(
    rollBar('A1'), rollBar('A1'), rollBar('A1'), '. A1 A1 A1 . A1 A1 A1 . A1 A1 A1 . A1 A1 Bb1', // the flat second just before the bar line
    rollBar('A1'), rollBar('A1'), rollBar('A1'), '. A1 A1 A1 . A1 A1 A1 . A1 A1 A1 . E2 C#2 Bb1', // down the arpeggio into it
  ));
  const pedalBb = s.notes(bars(rollBar('Bb1'), rollBar('Bb1'), rollBar('Bb1'), '. Bb1 Bb1 Bb1 . Bb1 Bb1 Bb1 . Bb1 Bb1 Bb1 . F2 D2 Bb1'));
  const themeRoll = s.notes(bars(
    ...['A', 'A', 'Bb', 'Bb', 'Gm', 'Gm', 'A'].map((c) => rollBar(ROOT[c])),
    '. A1 A1 A1 . A1 A1 A1 . A1 A1 A1 . A1 E2 C#2', // the leading tone C#2 into the Dm of the answer
    ...['Dm', 'Dm', 'C', 'C', 'Bb', 'Bb', 'A', 'A'].map((c) => rollBar(ROOT[c])),
  ));
  const buildRoll = s.notes(bars(rollBar('Bb1'), rollBar('Bb1'), rollBar('Bb1'), rollBar('Bb1')));

  // ── the 303: squelches at the ends of phrases, a supporting colour
  const sq1 = s.notes('. . . . . . . . A2 A3! . A2 C#3~ E3 A3!~ G3'); // up the arpeggio, an accented slide to the octave
  const sq2 = s.notes('A2 . A3! A2 . A2 E3~ . A2 A3! . A2 F3! E3~ C#3 A2'); // a whole bar, the b6-5 sigh (F3 E3) at the end
  const sq3 = s.notes('. . . . . . . . . . . . A2 A3! E3~ A3'); // a flick on the last beat
  const sqBb = s.notes('. . . . . . . . Bb2 Bb3! . Bb2 D3~ F3 Bb3!~ F3');

  // ── bell sparkles for the break: chord tones high up, thrown across the stereo field by the delay
  const sparkle = s.notes(bars(
    'A5 . . . . . . . . . . . E6 . . .', '. . . . C#6 . . . . . . . . . . .', 'E6 . . . . . . . A5 . . . . . . .', '. . . . . . . . C#6 . . . E6 . . .',
    'Bb5 . . . . . . . . . . . F6 . . .', '. . . . D6 . . . . . . . . . . .', 'F6 . . . . . . . Bb5 . . . . . . .', '. . . . . . . . D6 . . . F6 . . .',
  ));

  // ── drums
  const four = s.hits('X...X...X...X...');
  const fourEnd = s.hits('X...X...X.......'); // the last beat left out: a breath before a new section
  const backbeat = s.hits('....X.......X...');
  const offHat = s.hits('..o...o...o...o.');
  const offHatAcc = s.hits('..O...o...O...o.');
  const tick = s.hits('.x.x.x.x.x.x.x.x');
  const tickG = s.hits('.x.g.x.g.x.g.x.g');
  const shake = s.hits('xgxgxgxgxgxgxgxg');
  const tambs = s.hits('....x.......x...');
  const snareFill = s.hits('..........x..xxX');
  const snareBuild = s.hits('........x.x.xxxX');
  const roll4 = s.hits(bars('2...2...3...3...', '3.3.4.4.5.5.6.6.', '5.5.5.5.66666666', '7777888899999999'));

  // ── frames: what the melodic voices play over a whole section, so that the counter-lines can be cleared against them
  const bellIntro = noSlide(s.silence(1).then(themeA.slice(0, 8), s.silence(2), themeA.slice(0, 8), s.silence(1)));
  const leadGroove = s.silence(12).then(motif, hint2);
  const reedJourney = riffA.then(riffA2, riffBb, s.silence(2), riffA.slice(8, 16));
  const leadJourney = s.silence(12).then(motif, s.silence(2));
  const acidJourney = s.silence(3).then(sq1, s.silence(3), sq1, s.silence(3), sqBb, s.silence(4));
  const padJourney = s.silence(8).then(hold(rep('Bb', 4)), s.silence(4));
  const orbitJourney = s.silence(4).then(orbit8.slice(0, 16).octave(-1), orbitBb.octave(-1), orbit8.slice(16, 32).octave(-1));
  const orbitFloat = orbitA.scaleTime(2).then(orbitBb.slice(0, 8).scaleTime(2));
  const reedOutro = s.silence(4).then(riffA, s.silence(8));
  const bellOutro = noSlide(s.silence(8).then(themeA.slice(0, 8), s.silence(5), s.notes('A5:16')));
  const leadOutro = s.notes('A5:32').then(s.silence(10), noSlide(hook.slice(56, 64)), s.silence(2)); // the landing, then the hook's last words

  // ── arrangement ──────────────────────────────────────────────────────────────────────────────────────────────────
  // intro: the sun rises. The pad and the orbit open, the bell calls the theme's first words twice; the kick and the roll at bar 4
  whoosh.hit(S.intro.bar, '', 0.8, 0, 12); // the sun comes up over the horizon
  pad.play(hold(rep('A', 8)), S.intro);
  orbit.play(clear(orbit8, bellIntro), S.intro);
  bell.play(bellIntro, S.intro);
  kick.play(four, S.intro.bar + 4, 3);
  kick.play(fourEnd, S.intro.bar + 7, 1);
  bass.play(pedal, S.intro.bar + 4, 4);
  chat.play(tickG, S.intro.bar + 6, 2);
  shaker.play(shake, S.intro.bar + 4, 4);
  riser.hit(S.intro.bar + 6, '', 0.8, 0, 8);
  snare.play(snareFill, S.intro.end - 1, 1);
  swell.note(S.intro.end - 1, 'A3', 4, 0.9);

  // groove: the full roll and the hats; the clap, the tambourine and the shaker at bar 16; the hook hinted at bar 20
  boom.hit(S.groove.bar, '', 0.8);
  for (const b of [S.groove.bar, S.groove.bar + 8]) crash.hit(b, '', 1);
  kick.play(four, S.groove.bar, S.groove.bars - 1);
  kick.play(fourEnd, S.groove.end - 1, 1);
  bass.play(pedal, S.groove);
  chat.play(tick, S.groove);
  ohat.play(offHat, S.groove);
  orbit.play(clear(orbit8.repeat(2), leadGroove), S.groove);
  pad.play(hold(rep('A', 16)), S.groove);
  clap.play(backbeat, S.groove.bar + 8, 8);
  tamb.play(tambs, S.groove.bar + 8, 8);
  shaker.play(shake, S.groove.bar + 8, 8);
  acid.play(sq1, S.groove.bar + 3, 1);
  acid.play(sq3, S.groove.bar + 7, 1);
  acid.play(sq2, S.groove.bar + 11, 1);
  acid.play(sq1, S.groove.bar + 15, 1);
  lead.play(leadGroove, S.groove);
  snare.play(snareFill, S.groove.bar + 7, 1);
  snare.play(snareBuild, S.groove.end - 1, 1);
  swell.note(S.groove.end - 1, 'A3', 4, 1);

  // theme: the progression arrives with the hook; the arp twists through the chords
  boom.hit(S.theme.bar, '', 1);
  for (const b of [S.theme.bar, S.theme.bar + 8]) crash.hit(b, '', 1);
  kick.play(four, S.theme.bar, S.theme.bars - 1);
  kick.play(fourEnd, S.theme.end - 1, 1);
  bass.play(themeRoll, S.theme);
  chat.play(tick, S.theme);
  ohat.play(offHatAcc, S.theme);
  clap.play(backbeat, S.theme);
  tamb.play(tambs, S.theme.bar + 8, 8); // the tambourine and the shaker join for the answer
  shaker.play(shake, S.theme.bar + 8, 8);
  pad.play(hold(THEME), S.theme);
  arp.play(clear(themeArp, hook), S.theme);
  lead.play(hook, S.theme);
  acid.play(sq1, S.theme.bar + 7, 1);
  acid.play(sq3, S.theme.end - 1, 1);
  snare.play(snareFill, S.theme.bar + 7, 1);
  snare.play(snareBuild, S.theme.end - 1, 1);
  swell.note(S.theme.end - 1, 'A3', 4, 0.8);

  // journey: back on the drone, lean: theme B on the reed over the roll, the orbit low under it from bar 44; the drone lifts to Bb
  // at 48 (with the pad: the lift), falls back at 52, where the hook's call returns once and the riff answers; all stop at 55.5
  boom.hit(S.journey.bar, '', 0.8);
  for (const b of [S.journey.bar, S.journey.bar + 8, S.journey.bar + 12]) crash.hit(b, '', 1);
  kick.play(four, S.journey.bar, S.journey.bars - 1);
  kick.play(s.hits('X...X...........'), S.journey.end - 1, 1);
  bass.play(pedal, S.journey.bar, 8);
  bass.play(pedalBb, S.journey.bar + 8, 4);
  bass.play(pedal, S.journey.bar + 12, 3.5);
  chat.play(tick, S.journey.bar, S.journey.bars - 0.5);
  ohat.play(offHatAcc, S.journey.bar, S.journey.bars - 0.5);
  clap.play(backbeat, S.journey.bar, S.journey.bars - 0.5);
  tamb.play(tambs, S.journey.bar + 8, 7.5);
  shaker.play(shake, S.journey.bar + 4, 11.5);
  pad.play(padJourney, S.journey);
  reed.play(reedJourney, S.journey.bar, S.journey.bars - 0.5);
  lead.play(leadJourney, S.journey);
  orbit.play(clear(orbitJourney, reedJourney, leadJourney, acidJourney, padJourney), S.journey.bar, S.journey.bars - 0.5);
  acid.play(acidJourney, S.journey);
  snare.play(snareFill, S.journey.bar + 7, 1);
  zap.hit(S.journey.end - 0.5, '', 0.8);

  // float: the kick goes; the hook in long notes on the breath voice over the pad, a drone, the bell's sparkles, the orbit at half speed
  down.hit(S.float.bar, '', 0.9, 0, 8);
  pad.play(hold(FLOAT), S.float);
  breath.play(breathLine, S.float.bar, S.float.bars + S.build.bars);
  drone.note(S.float.bar, 'A1', 16, 0.8);
  drone.note(S.float.bar + 4, 'Bb1', 16, 0.8);
  bell.play(sparkle, S.float);
  orbit.play(clear(orbitFloat, breathLine.slice(0, 32), sparkle), S.float);
  shaker.play(shake, S.float.bar + 4, 4);

  // build: the climb in whole notes over Dm, C and Bb; the arp opens, the roll returns on Bb, a snare roll, a riser to the drop
  pad.play(hold(BUILD), S.build.bar, S.build.bars - 0.25);
  arp.play(clear(buildArp, breathLine.slice(32, 64)), S.build.bar, S.build.bars - 0.25);
  drone.note(S.build.bar, 'D2', 8, 0.7);
  drone.note(S.build.bar + 2, 'C2', 8, 0.7);
  bass.play(buildRoll, S.build.bar + 4, 3.75);
  chat.play(tick, S.build.bar + 4, 4);
  snare.play(roll4, S.build.bar + 4, 4);
  riser.hit(S.build.bar, '', 1, 0, 32);
  wash.hit(S.build.end - 2, '', 1, 0, 8);
  swell.note(S.build.end - 1, 'A3', 4, 1);

  // peak: the hook returns harmonised over the full groove
  boom.hit(S.peak.bar, '', 1);
  for (const b of [S.peak.bar, S.peak.bar + 8]) crash.hit(b, '', 1);
  kick.play(four, S.peak.bar, S.peak.bars - 1);
  kick.play(fourEnd, S.peak.end - 1, 1);
  bass.play(themeRoll, S.peak);
  chat.play(tick, S.peak);
  ohat.play(offHatAcc, S.peak);
  clap.play(backbeat, S.peak);
  tamb.play(tambs, S.peak);
  shaker.play(shake, S.peak);
  pad.play(hold(THEME), S.peak);
  arp.play(clear(themeArp.slice(0, 32).then(climaxArp.slice(32, 64)), hook, harmLine), S.peak); // the answer half twists the other way
  lead.play(hook, S.peak);
  harm.play(harmLine, S.peak);
  acid.play(sq1, S.peak.bar + 7, 1);
  acid.play(sq3, S.peak.end - 1, 1);
  snare.play(snareFill, S.peak.bar + 7, 1);
  snare.play(snareBuild, S.peak.end - 1, 1);
  wash.hit(S.peak.end - 1, '', 0.8, 0, 4);
  swell.note(S.peak.end - 1, 'A3', 4, 1); // into the key change

  // climax: the whole theme a semitone higher (in Bb), three voices: the hook, its second voice and the sky above
  const up = { transpose: 1 };
  boom.hit(S.climax.bar, '', 1);
  for (const b of [S.climax.bar, S.climax.bar + 8]) crash.hit(b, '', 1);
  kick.play(four, S.climax.bar, S.climax.bars - 1);
  kick.play(fourEnd, S.climax.end - 1, 1);
  bass.play(themeRoll, S.climax, undefined, up);
  chat.play(tick, S.climax);
  ohat.play(offHatAcc, S.climax);
  clap.play(backbeat, S.climax);
  tamb.play(tambs, S.climax);
  shaker.play(shake, S.climax);
  pad.play(hold(THEME), S.climax, undefined, up);
  arp.play(clear(climaxArp, themeClimax, harmClimax, skyLine), S.climax, undefined, up);
  lead.play(themeClimax, S.climax, undefined, up);
  harm.play(harmClimax, S.climax, undefined, up);
  sky.play(skyLine, S.climax, undefined, up);
  acid.play(sq1, S.climax.bar + 7, 1, up);
  acid.play(sq2, S.climax.end - 1, 1, up);
  snare.play(snareFill, S.climax.bar + 7, 1);
  snare.play(snareBuild, S.climax.end - 1, 1);

  // outro: the landing. Back on the A drone (the climax's Bb falls to A: bII - I); the riff once more without the pad, the bell's
  // call, the layers leave; the hook's cadence once more at 116; the kick stops at 119 under a last chord and a boom
  boom.hit(S.outro.bar, '', 0.9);
  crash.hit(S.outro.bar, '', 1);
  crash.hit(S.outro.bar + 8, '', 0.8);
  lead.play(leadOutro, S.outro);
  kick.play(four, S.outro.bar, S.outro.bars - 1);
  bass.play(pedal, S.outro.bar, S.outro.bars - 1);
  chat.play(tick, S.outro.bar, 12);
  ohat.play(offHat, S.outro.bar, 12);
  clap.play(backbeat, S.outro.bar, 8);
  tamb.play(tambs, S.outro.bar, 8);
  shaker.play(shake, S.outro.bar, 8);
  pad.play(hold(rep('A', 4)), S.outro.bar, 4);
  pad.play(hold(rep('A', 4)), S.outro.bar + 8, 4);
  reed.play(reedOutro, S.outro);
  bell.play(bellOutro, S.outro);
  orbit.play(clear(s.silence(2).then(orbit8, orbit8.slice(0, 24)), reedOutro, bellOutro, leadOutro), S.outro.bar, 15);
  acid.play(sq1, S.outro.bar + 3, 1);
  acid.play(sq2, S.outro.bar + 7, 1);
  pad.play(hold(['A']), S.outro.end - 1, 1);
  boom.hit(S.outro.end - 1, '', 0.7);

  // ── automation ───────────────────────────────────────────────────────────────────────────────────────────────────
  // the intro opens: the pad from a high-pass, the orbit from a low-pass; the roll arrives thin and fills out
  pad.auto('mix.hp', [[S.intro.bar, 900], [S.intro.end, 200, 'exp'], [S.float.bar, 200], [S.build.end - 2, 200], [S.build.end - 0.25, 1200, 'exp'], [S.build.end, 200, 'step']]);
  pad.auto('fx.gate.depth', [[S.intro.bar, 0.2], [S.groove.bar + 8, 1, 'step'], [S.float.bar, 0.3, 'step'], [S.build.bar, 0.6, 'step'], [S.peak.bar, 1, 'step'], [S.outro.end - 1, 0, 'step']]);
  pad.auto('mix.gain', [[S.intro.bar, -9], [S.intro.end, -12], [S.float.bar, -12], [S.float.bar, -7, 'step'], [S.build.bar, -9], [S.peak.bar, -12, 'step'], [S.outro.end - 1, -9, 'step']]);
  orbit.auto('fx.filter.cutoff', [[S.intro.bar, 350], [S.intro.end, 2600, 'exp'], [S.float.bar, 1200, 'step'], [S.float.end, 1800, 'exp'], [S.outro.bar, 2600, 'step'], [S.outro.bar + 8, 2600], [S.outro.end - 1, 300, 'exp']]);
  bass.auto('mix.hp', [[S.intro.bar + 4, 400], [S.intro.end, 90, 'exp'], [S.intro.end, 20, 'step'], [S.build.bar + 4, 300, 'step'], [S.build.end - 0.25, 30, 'exp'], [S.build.end, 20, 'step']]);
  shaker.auto('mix.gain', [[S.intro.bar + 4, -28], [S.intro.end, -16, 'in']]);
  lead.auto('cutoff', [[S.groove.bar + 12, 900], [S.groove.end, 2400, 'exp']]); // the hint arrives from far away
  arp.auto('cutoff', [[S.build.bar, 500], [S.build.end, 2600, 'exp']]);
  // the 303 brightens through the track, wide open in the climax
  acid.auto('cutoff', [[S.groove.bar, 300], [S.theme.bar, 900, 'exp'], [S.journey.end, 1400, 'exp'], [S.peak.bar, 1000, 'step'], [S.climax.end, 2200, 'exp'], [S.outro.bar, 1200, 'step'], [S.outro.end, 400, 'exp']]);
  // delay throws on the held phrase ends of the hook
  for (const sec of [S.theme, S.peak, S.climax]) {
    lead.auto('mix.delay', [[sec.bar + 7, 0.28], [sec.bar + 7, 0.6, 'step'], [sec.bar + 8, 0.28, 'step'], [sec.end - 1, 0.6, 'step'], [sec.end, 0.28, 'step']]);
  }
  s.auto('reverb.time', [[S.journey.end - 1, 3], [S.float.bar, 5, 'smooth'], [S.build.end - 1, 4.5], [S.peak.bar, 3, 'step']]);

  // ── mix ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  s.setReverb({ time: 3, return: -9, lowCut: 200 });
  s.setDelay({ time: '1/8.', feedback: 0.38, return: -9 });
  s.setSidechain({ release: 0.1 });
  s.setMaster({ trim: TRIM });
});
