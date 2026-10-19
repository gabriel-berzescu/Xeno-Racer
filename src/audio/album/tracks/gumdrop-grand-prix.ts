// Gumdrop Grand Prix: melodic dubstep in the colour-bass style, for the album "Xeno-Racer Vol. 1": the playful one.
// 150 BPM in half time, G major; drop 2 moves to the relative E minor.
//
// THE HOOK is a conversation on one bouncy rhythm (8th, 16th, 8th, dotted 8th, a rest where the snare hits, 8th, 8th, dotted 8th).
// A bell asks a one-bar question; a chord of three growls answers it note for note, on the same rhythm, in the next chord:
//   bell  G G A B . D B A  (over G)        growls  A A B D . F# D B   (top voice, over Bm7)
//   bell  G G A B . E D B  (over Cadd9)    growls  C C D Eb . G Eb D  (over Cm, the iv borrowed from G minor)
//   bell  G G A B . D B A  (over G/B)      growls  G# G# B D . E D B  (over E7)
//   bell  E E D C . B A G  (over Am7)      growls  G G Bb Eb . A C F  (Eb then F: the bVI-bVII-I "level clear" fanfare into G)
// The questions climb to D6 and E6 and then tumble down the scale; the answers climb back up, and the last one is the fanfare that
// every build ends on and every drop lands from. The growls are three mono growl channels, one voice of the chord each (root low,
// a middle voice, the tune on top), each with its own vowel and a little pan, over a separate clean sub.
//
// Drop 1 introduces the conversation (eight bars of question and answer, then eight with the growls holding chords under the bell and
// the chip lead doubling it). Drop 2 flips it: the relative minor, the tune a third lower, everything in eighth-note triplets
// (Em7 Cmaj7 G D/F# | Em7 Cmaj7 Am7 B7), and its last four bars snap back to straight sixteenths over a double-time beat. Drop 3 swaps
// the roles: the growls sing the questions (the hook in the bass) and the bell answers two octaves up; then everybody sings everything,
// the third question jumps to G6 (the highest note of the track), the beat goes double time and the fanfare closes it.
// The intro and the outro play the conversation on a music box and a pluck; the toy-box break slows the first half of it down; the
// bridge is a new tune over the circle of fifths (Am7 D7 Gmaj7 Cadd9 F#m7b5 B7 Em7), first on the music box, then on the chip lead.
// A small story runs through it for a kid to follow: the growls' first word is the fanfare at the end of build 1; at the end of
// drops 1 and 2 their last chord dives an octave ("bwooop") and they fall asleep, snoring under the toy box; build 3 ends with the
// bell's question alone, and drop 3 starts with the growls repeating it back like a parrot.
//
//   bars     section  what happens
//   0-8      intro    music box asks, pluck answers (the whole hook), a pad opening; snap, shaker and the sub from bar 4
//   8-16     verse    chip-lead verse tune over Cmaj7 Bm7 Am7 G (the bass walks down); kick and snare join for the last four
//   16-24    build    the question's head climbing, chords struck faster, the growls' fanfare, a roll, the riser, a silent beat
//   24-40    drop     8 bars of question (bell) and answer (growls, sub with them) ending in a stop; then 8 with held growl chords
//                     under the bell, the chip doubling it, sixteenth hats, an arpeggio, a laser "pew"; the last answer dives
//   40-48    toybox   the first half of the hook at half speed on music box and pluck, stop-time beat, the growls snoring
//   48-56    build2   into E minor, everything in triplets (quarter-note-triplet kicks, triplet roll)
//   56-72    drop2    the flip: E minor, a third lower, triplets; a stop; then four bars more and four bars of double time
//   72-88    bridge   a new tune round the circle of fifths: music box alone, then the chip lead over held growls and a beat
//   88-96    build3   build 1 again, ending with the bell's question alone
//   96-112   drop3    the growls sing the questions and the bell answers; then all of it together, the G6 peak, double time
//   112-120  outro    the conversation on the music box, the growls' fanfare, a last G chord
//
// Probe:  ALBUM=1 ONLY=gumdrop-grand-prix AUTOTRIM=1 SPEC=1 CLASH=1 npx vitest run tests/probes/album-render.test.ts
import { defineTrack, fx } from '../song';
import type { GrowlOpts, SynthOpts } from '../song';

// ── patches (plain option objects: README section 11) ─────────────────────────────────────────────────────────────────

/** The lead: a bright bell-pluck. An FM tine at ratio 3 (harmonic partials 1 2 4 5 7 ...) whose brightness falls within a quarter
 * second, three soft saws for the EDM snap and a faint sine an octave up for sparkle. */
export const BELL: SynthOpts = {
  layers: [
    { wave: 'fm', level: 1 },
    { wave: 'saw', unison: 3, detune: 0.6, level: 0.3 },
    { wave: 'sine', octave: 1, level: 0.12 },
  ],
  fmRatio: 3, fmIndex: 2.6, fmDecay: 0.22, fmSustain: 0.18, fmFeedback: 0.05,
  filter: 'lp', cutoff: 3800, res: 0.1, envAmt: 1.6, fAttack: 0.001, fDecay: 0.18, fSustain: 0.35, keytrack: 0.5, velFilter: 0.6,
  attack: 0.0015, decay: 0.45, sustain: 0.45, release: 0.28,
  unisonDetune: 10, spread: 0.6, voices: 6,
  click: 0.25, clickTone: 2000, clickKeytrack: 0.3, clickDecay: 0.008, // a mallet on every note (about 3.4 kHz around G5)
};

/** The music box of the intro, the toy-box break, the bridge and the outro: a glassy FM tine (ratio 4: odd partials) that dies in a second. */
export const MUSICBOX: SynthOpts = {
  layers: [{ wave: 'fm', level: 1 }, { wave: 'sine', octave: 1, level: 0.22 }],
  fmRatio: 4, fmIndex: 1.6, fmDecay: 0.12, fmSustain: 0.08,
  filter: 'off', attack: 0.001, decay: 1.3, sustain: 0, release: 0.5, mono: true, voices: 8,
  click: 0.18, clickTone: 3500, clickKeytrack: 0.3, clickDecay: 0.005, // the pin plucking the tine: a tiny "tink"
};

/** The chip lead (a Bossfight-era touch): a 25 % pulse pair with a "blip" at every note (it starts an octave up and falls in about
 * 10 ms), a fingered glide (only into notes played legato: a note after a rest starts clean, on its blip) and a late vibrato. */
export const CHIP: SynthOpts = {
  mode: 'legato', voices: 1, glideMode: 'fingered',
  layers: [{ wave: 'pulse', unison: 2, detune: 0.4, phase: 'free' }, { wave: 'square', octave: -1, level: 0.25, phase: 'free' }],
  pw: 0.25, pwmDepth: 0.08, pwmRate: 0.4, unisonDetune: 8, spread: 0.5,
  filter: 'lp', cutoff: 4200, res: 0.1, envAmt: 0.8, fDecay: 0.2, fSustain: 0.6, keytrack: 0.5,
  attack: 0.003, decay: 0.2, sustain: 0.85, release: 0.12,
  glide: 0.03, vibDepth: 16, vibRate: 6, vibDelay: 0.22, pEnv: 12, pEnvTime: 0.01,
};

/** The pad: five soft saws and a triangle an octave down, a gentle filter; chorus in the strip. */
export const PAD: SynthOpts = {
  filter: 'lp', layers: [{ wave: 'saw', unison: 5, detune: 0.8 }, { wave: 'tri', octave: -1, level: 0.4 }],
  unisonDetune: 18, spread: 1, cutoff: 2400, res: 0.08, envAmt: 0.8, fAttack: 0.05, fDecay: 0.8, fSustain: 0.6, keytrack: 0.4,
  attack: 0.04, decay: 0.8, sustain: 0.85, release: 0.7, voices: 12,
};

/** The colour growl: the classic growl made brighter and more vocal (more formant, less fold), no sub of its own. Every note says one
 * "wow": the wobble restarts with the note half open, opens fully and starts to close within the longest stab (a dotted eighth is half
 * a cycle at lfoRate 2/3), a quick filter snap marks the attack, and the note dives into its pitch from 4 semitones up in 35 ms
 * (a "bwip"; the drops' first notes and the last chords dive a whole octave: see bigDive). */
const COLOUR: GrowlOpts = {
  preset: 'dubstep-growl', sub: 0,
  cutoff: 650, res: 0.32, lfoRate: 2 / 3, lfoPhase: 0, lfoDepth: 2.5,
  lfoFm: 1.4, lfoVowel: 0.9, formant: 0.7, fmMix: 0.35, fmIndex: 2.6,
  drive: 13, fold: 0.12, clip: 6, envAmt: 1.0, envDecay: 0.06, tone: 9000, release: 0.045,
  pEnv: 4, pEnvTime: 0.035,
};
/** The three voices of a growl chord, each its own vowel so that the chord stays clear: "ah" at the bottom, "oh" in the middle and a
 * bright "ee" on top, where the tune is. All three sit in the centre and the stereo width spreads them above 200 Hz: the middle voice
 * widest, the tune on top nearly mono so that the answers stay focused. */
export const G_LO: GrowlOpts = { ...COLOUR, vowel: 0.2, cutoff: 500, width: 0.6 };
export const G_MID: GrowlOpts = { ...COLOUR, vowel: 3, cutoff: 650, width: 1 };
export const G_HI: GrowlOpts = { ...COLOUR, vowel: 1.9, cutoff: 900, fmIndex: 3.2, lfoVowel: 0.7, width: 0.35 };
/** The held growl chords under the bell (the second half of a drop): a slow half-note breath that starts open, wide, no dive. */
const HOLD: GrowlOpts = { ...COLOUR, lfoRate: 0.5, lfoPhase: 0.25, lfoDepth: 1.5, envAmt: 0.5, cutoff: 380, fmIndex: 1.8, drive: 10, release: 0.12, pEnv: 0 };
export const H_LO: GrowlOpts = { ...HOLD, vowel: 0.2, width: 0.6 };
export const H_MID: GrowlOpts = { ...HOLD, vowel: 3, width: 1 };
export const H_HI: GrowlOpts = { ...HOLD, vowel: 1.9, cutoff: 480, width: 0.8 };

// ── notation helpers ────────────────────────────────────────────────────────────────────────────────────────────────

/** A phrase on a rhythm: `rhythm` lists the note lengths in steps (a negative length is a rest), `notes` the pitches of the notes. */
function phrase(rhythm: readonly number[], notes: readonly string[]): string {
  const out: string[] = [];
  let k = 0;
  for (const len of rhythm) {
    if (len < 0) {
      for (let i = 0; i < -len; i++) out.push('.');
      continue;
    }
    const note = notes[k++];
    if (note === undefined) throw new Error(`phrase: ${notes.length} notes for a rhythm of more`);
    out.push(len === 1 ? note : `${note}:${len}`);
  }
  if (k !== notes.length) throw new Error(`phrase: ${notes.length} notes for a rhythm of ${k}`);
  return out.join(' ');
}

/** A note name moved by whole octaves (`up('F#3', 24)` is F#5): keeps the spelling (sharps stay sharps, flats flats). */
function up(note: string, semis: number): string {
  if (semis % 12 !== 0) throw new Error('up: whole octaves only');
  const m = /^([A-G][#b]?)(-?\d+)$/.exec(note);
  if (!m) throw new Error(`up: bad note ${note}`);
  return `${m[1]}${Number(m[2]) + semis / 12}`;
}

/** One chord voiced on three growls: the root (or a fixed bass), a middle voice and the tune on top, one entry per note. */
interface Voicing {
  readonly lo: string | readonly string[];
  readonly mid: readonly string[];
  readonly top: readonly string[];
}
/** The three growl phrases (lo, mid, top) of a voicing on a rhythm. */
function voices(rhythm: readonly number[], v: Voicing): [string, string, string] {
  const lo = typeof v.lo === 'string' ? v.top.map(() => v.lo as string) : v.lo;
  return [phrase(rhythm, lo), phrase(rhythm, v.mid), phrase(rhythm, v.top)];
}
/** The same with a cartoon dive at the end: the last note sounds for a sixteenth, then slides down an octave (needs a glide). */
function voicesDive(rhythm: readonly number[], v: Voicing): [string, string, string] {
  const r = [...rhythm.slice(0, -1), 1, rhythm[rhythm.length - 1] - 1];
  const add = (xs: readonly string[]): string[] => [...xs, `${up(xs[xs.length - 1], -12)}~`];
  const lo = typeof v.lo === 'string' ? v.top.map(() => v.lo as string) : v.lo;
  return [phrase(r, add(lo)), phrase(r, add(v.mid)), phrase(r, add(v.top))];
}
/** The upper two voices of a voicing as two-note chords, moved by octaves (the intro's pluck answers). */
function pairs(rhythm: readonly number[], v: Voicing, semis: number): string {
  return phrase(rhythm, v.top.map((t, i) => `[${up(v.mid[i], semis)},${up(t, semis)}]`));
}

/** One bar (or half bar) on a rhythm: 'x' strikes (X accented), '-' holds, '.' rests. `what` is a note or a chord. */
function strike(what: string | readonly string[], rhythm: string): string {
  const r = rhythm.replace(/\s/g, '');
  const head = typeof what === 'string' ? what : `[${what.join(',')}]`;
  const out: string[] = [];
  for (let i = 0; i < r.length; ) {
    if (r[i] === 'x' || r[i] === 'X') {
      let len = 1;
      while (r[i + len] === '-') len++;
      out.push(`${head}${r[i] === 'X' ? '!' : ''}${len > 1 ? `:${len}` : ''}`);
      i += len;
    } else {
      out.push('.');
      i++;
    }
  }
  return out.join(' ');
}
/** A progression (one name per bar; 'Eb|F' splits a bar in two) mapped through a table and struck on a rhythm (one bar long). */
function prog(names: readonly string[], table: Record<string, string | readonly string[]>, rhythm: string): string {
  const r = rhythm.replace(/\s/g, '');
  const look = (c: string): string | readonly string[] => {
    const v = table[c];
    if (v === undefined) throw new Error(`prog: no chord ${c} in the table`);
    return v;
  };
  return names
    .map((c) => {
      if (!c.includes('|')) return strike(look(c), r);
      const [a, b] = c.split('|');
      const h = r.length / 2;
      const second = r.slice(h);
      return `${strike(look(a), r.slice(0, h))} ${strike(look(b), second[0] === '-' ? `x${second.slice(1)}` : second)}`;
    })
    .join(' | ');
}

// ── harmony ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Pad voicings, G3-B4. Chosen against the tunes: no B next to a C, no F# under a G, no D next to an Eb (the clash check's list). */
const PADV: Record<string, readonly string[]> = {
  G: ['G3', 'B3', 'D4', 'G4'],
  Bm7: ['A3', 'B3', 'D4', 'F#4'],
  Cadd9: ['G3', 'C4', 'D4', 'E4'],
  Cm: ['Eb3', 'G3', 'C4', 'G4'], // its 9th, D, comes from the growls' answer: an Eb3 is a major seventh under that D4
  'G/B': ['B3', 'D4', 'G4', 'B4'],
  E7: ['G#3', 'B3', 'D4', 'E4'],
  Am7: ['A3', 'C4', 'E4', 'G4'],
  Eb: ['G3', 'Bb3', 'Eb4', 'G4'],
  F: ['A3', 'C4', 'F4', 'A4'],
  D: ['F#3', 'A3', 'D4', 'F#4'],
  'D/F#': ['F#3', 'A3', 'D4', 'F#4'],
  Em7: ['G3', 'B3', 'D4', 'E4'],
  Cmaj7: ['G3', 'C4', 'E4', 'B4'],
  B7: ['A3', 'B3', 'D#4', 'F#4'],
  B7sus4: ['A3', 'B3', 'E4', 'F#4'],
  D7sus4: ['G3', 'A3', 'C4', 'D4'],
  D7: ['F#3', 'A3', 'C4', 'D4'],
  Gmaj7: ['G3', 'B3', 'D4', 'F#4'],
  'F#m7b5': ['F#3', 'A3', 'C4', 'E4'],
};
/** The sub's root of each chord (Eb1 .. D2: the fanfare's bass climbs Eb1 F1 G1). */
const SUBR: Record<string, string> = {
  G: 'G1', Bm7: 'B1', Cadd9: 'C2', Cm: 'C2', 'G/B': 'B1', E7: 'E1', Am7: 'A1', Eb: 'Eb1', F: 'F1', D: 'D2', 'D/F#': 'F#1', Em7: 'E1',
  Cmaj7: 'C2', B7: 'B1', B7sus4: 'B1', D7sus4: 'D2', D7: 'D2', Gmaj7: 'G1', 'F#m7b5': 'F#1',
};
/** The pluck arpeggio's notes in the drops (G4-C6): no Eb near the growls' D4 over Cm, no C5 a ninth over their B3 in Cmaj7, no C at all
 * in Cadd9 and Am7, where the tune has a B. */
const ARPV: Record<string, readonly string[]> = {
  G: ['G4', 'B4', 'D5', 'G5'], Bm7: ['A4', 'B4', 'D5', 'F#5'], Cadd9: ['G4', 'D5', 'E5', 'G5'], Cm: ['G4', 'C5', 'G5', 'C6'],
  'G/B': ['B4', 'D5', 'G5', 'B5'], E7: ['G#4', 'B4', 'D5', 'E5'], Am7: ['A4', 'E5', 'G5', 'A5'], Eb: ['G4', 'Bb4', 'Eb5', 'G5'],
  F: ['A4', 'C5', 'F5', 'A5'], Em7: ['G4', 'B4', 'D5', 'E5'], Cmaj7: ['G4', 'E5', 'G5', 'C6'], 'D/F#': ['F#4', 'A4', 'D5', 'F#5'],
};
/** The verse's arpeggio, under the chip (D4-E5); its Cmaj7 has no C, whose octave layer would rub against the pad's B4. */
const VARP: Record<string, readonly string[]> = {
  Cmaj7: ['E4', 'G4', 'B4', 'E5'], Bm7: ['F#4', 'A4', 'B4', 'D5'], Am7: ['C4', 'E4', 'G4', 'A4'], G: ['D4', 'G4', 'B4', 'D5'],
  D7sus4: ['D4', 'G4', 'A4', 'C5'], D7: ['D4', 'F#4', 'A4', 'C5'],
};
/** An arpeggio: each bar's chord notes go up and round on the 'x' steps of a one-bar mask ('Eb|F' splits the bar). */
function arpLine(names: readonly string[], table: Record<string, readonly string[]>, mask: string): string {
  return names
    .map((name) => {
      const parts = name.split('|');
      const per = mask.length / parts.length;
      const out: string[] = [];
      parts.forEach((p, pi) => {
        const notes = table[p];
        if (!notes) throw new Error(`arpLine: no chord ${p}`);
        let k = 0;
        for (let i = 0; i < per; i++) out.push(mask[pi * per + i] === 'x' ? notes[k++ % notes.length] : '.');
      });
      return out.join(' ');
    })
    .join(' | ');
}
/** The held growl chords (root, middle, top) under the bell's questions and in the bridge. */
const HOLDV: Record<string, readonly [string, string, string]> = {
  G: ['G2', 'D3', 'B3'], Cadd9: ['C3', 'G3', 'E4'], 'G/B': ['B2', 'G3', 'D4'], Am7: ['A2', 'E3', 'C4'], Em7: ['E2', 'B2', 'G3'],
  D7: ['D3', 'A3', 'C4'], Gmaj7: ['G2', 'D3', 'B3'], 'F#m7b5': ['F#2', 'E3', 'A3'], B7: ['B2', 'F#3', 'A3'], Cm: ['C3', 'G3', 'Eb4'],
};

const P1 = ['G', 'Bm7', 'Cadd9', 'Cm', 'G/B', 'E7', 'Am7', 'Eb|F']; // the hook: I iii IV iv I6 V/ii ii bVI-bVII
const PV = ['Cmaj7', 'Bm7', 'Am7', 'G', 'Cmaj7', 'Bm7', 'Am7', 'D7sus4|D7']; // the verse: the bass walks down C B A G
const PB = ['Cadd9', 'D', 'Em7', 'D/F#', 'Cadd9', 'D', 'Eb|F', 'F']; // builds 1 and 3: the fanfare, then F held into the drop's G
const PT = ['G', 'G', 'Bm7', 'Bm7', 'Cadd9', 'Cadd9', 'Cm', 'Cm']; // the toy box: the hook's first half at half speed
const PB2 = ['Cmaj7', 'D', 'Bm7', 'Em7', 'Cmaj7', 'D', 'B7sus4', 'B7']; // build 2: into E minor
const P2 = ['Em7', 'Cmaj7', 'G', 'D/F#', 'Em7', 'Cmaj7', 'Am7', 'B7']; // drop 2: i VI III VII6 i VI iv V7
const PR = ['Am7', 'D7', 'Gmaj7', 'Cadd9', 'F#m7b5', 'B7', 'Em7', 'Em7']; // the bridge: the circle of fifths
const PO = ['G', 'Bm7', 'Cadd9', 'Cm', 'Am7', 'Eb|F']; // the outro, before the last chord

// ── the conversation ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The hook's rhythm (16 steps): 8th, 16th, 8th, dotted 8th, a rest on the snare, 8th, 8th, dotted 8th. */
const RQ = [2, 1, 2, 3, -1, 2, 2, 3];
/** The same, twice as slow (two bars): the toy box. */
const RQ2 = RQ.map((x) => x * 2);
/** Drop 2's flip, on eighth-note triplets (12 steps a bar at res 3): a triplet run, a held beat, the snare, then a skip. */
const RT = [1, 1, 1, 3, -1, 2, 1, 2];

/** The bell's questions (over G, Cadd9, G/B and Am7). */
const CALLS = [
  ['G5', 'G5', 'A5', 'B5', 'D6', 'B5', 'A5'],
  ['G5', 'G5', 'A5', 'B5', 'E6', 'D6', 'B5'],
  ['G5', 'G5', 'A5', 'B5', 'D6', 'B5', 'A5'],
  ['E6', 'E6', 'D6', 'C6', 'B5', 'A5', 'G5'],
];
/** Drop 3's third question: the same start, then up to G6. */
const CALL_PEAK = ['G5', 'G5', 'A5', 'B5', 'G6', 'E6', 'D6'];

/** The growls' answers (over Bm7, Cm, E7 and Eb-F). */
const A1: Voicing = { lo: 'B2', mid: ['F#3', 'F#3', 'F#3', 'F#3', 'A3', 'A3', 'F#3'], top: ['A3', 'A3', 'B3', 'D4', 'F#4', 'D4', 'B3'] };
const A2: Voicing = { lo: 'C3', mid: ['G3', 'G3', 'G3', 'G3', 'C4', 'G3', 'G3'], top: ['C4', 'C4', 'D4', 'Eb4', 'G4', 'Eb4', 'D4'] };
const A3: Voicing = { lo: 'E2', mid: ['D3', 'D3', 'D3', 'G#3', 'G#3', 'G#3', 'G#3'], top: ['G#3', 'G#3', 'B3', 'D4', 'E4', 'D4', 'B3'] };
const A4: Voicing = {
  lo: ['Eb2', 'Eb2', 'Eb2', 'Eb2', 'F2', 'F2', 'F2'],
  mid: ['Bb2', 'Bb2', 'Eb3', 'G3', 'C3', 'F3', 'A3'],
  top: ['G3', 'G3', 'Bb3', 'Eb4', 'A3', 'C4', 'F4'],
};
const ANSWERS = [A1, A2, A3, A4];

/** Drop 3: the growls sing the questions (the hook in the bass, two octaves under the bell). */
const GC1: Voicing = { lo: 'G2', mid: ['D3', 'D3', 'D3', 'D3', 'G3', 'D3', 'D3'], top: ['G3', 'G3', 'A3', 'B3', 'D4', 'B3', 'A3'] };
const GC2: Voicing = { lo: 'C3', mid: ['E3', 'E3', 'E3', 'G3', 'G3', 'G3', 'G3'], top: ['G3', 'G3', 'A3', 'B3', 'E4', 'D4', 'B3'] };
const GC3: Voicing = { lo: 'B2', mid: ['D3', 'D3', 'D3', 'D3', 'G3', 'D3', 'D3'], top: ['G3', 'G3', 'A3', 'B3', 'D4', 'B3', 'A3'] };
const GC4: Voicing = { lo: 'A2', mid: ['C4', 'C4', 'A3', 'E3', 'E3', 'E3', 'E3'], top: ['E4', 'E4', 'D4', 'C4', 'B3', 'A3', 'G3'] };
const GC_PEAK: Voicing = { lo: 'B2', mid: ['D3', 'D3', 'D3', 'D3', 'D4', 'G3', 'G3'], top: ['G3', 'G3', 'A3', 'B3', 'G4', 'E4', 'D4'] };
const GCALLS = [GC1, GC2, GC3, GC4];

/** Drop 2: the questions a diatonic third lower, in E minor, on the triplet rhythm (over Em7, G, Em7, Am7)... */
const TCALLS = [
  ['E5', 'E5', 'F#5', 'G5', 'B5', 'G5', 'F#5'],
  ['G5', 'G5', 'A5', 'B5', 'D6', 'B5', 'A5'], // over G: drop 1's first question, now in triplets
  ['E5', 'E5', 'F#5', 'G5', 'B5', 'G5', 'F#5'],
  ['C6', 'C6', 'B5', 'A5', 'G5', 'F#5', 'E5'],
];
/** ...and the growls' answers (over Cmaj7, D/F#, Cmaj7, B7). */
const U1: Voicing = { lo: 'C3', mid: ['E3', 'E3', 'E3', 'G3', 'B3', 'G3', 'G3'], top: ['G3', 'G3', 'B3', 'C4', 'E4', 'C4', 'B3'] };
const U2: Voicing = { lo: 'F#2', mid: ['D3', 'D3', 'F#3', 'F#3', 'A3', 'A3', 'F#3'], top: ['A3', 'A3', 'B3', 'D4', 'F#4', 'D4', 'B3'] };
const U4: Voicing = { lo: 'B2', mid: ['D#3', 'D#3', 'F#3', 'F#3', 'A3', 'B3', 'D#4'], top: ['F#3', 'F#3', 'A3', 'B3', 'D#4', 'F#4', 'A4'] };
const UANS = [U1, U2, U1, U4];

// ── the other tunes ──────────────────────────────────────────────────────────────────────────────────────────────────

// the verse (chip lead, over Cmaj7 Bm7 Am7 G | Cmaj7 Bm7 Am7 D7sus4-D7): a pickup into a held note, then a falling answer, while the
// bass walks down the scale
const VERSE_MEL =
  '. . E5:2 G5:2 B5:10 | A5:4 F#5:4 D5:8 | . . C5:2 E5:2 A5:10 | G5:4 D5:4 B4:8 | ' +
  '. . E5:2 G5:2 B5:6 D6:4 | D6:4 B5:4 F#5:8 | . . E5:2 G5:2 A5:4 B5:2 C6:4 | D6:8 C6:4 A5:4';
// builds 1 and 3 (over Cadd9 D Em7 D/F# Cadd9 D Eb-F F): the head of the question four times, climbing; then two whole questions;
// the growls' fanfare (the bell rests); an F arpeggio up to F6 and a silent last beat
const BUILD_MEL =
  'G5:2 G5 A5:2 B5:3 . . . . . . . . | A5:2 A5 B5:2 D6:3 . . . . . . . . | G5:2 G5 A5:2 B5:3 . . . . . . . . | A5:2 A5 B5:2 D6:3 . . . . . . . . | ' +
  'G5:2 G5 A5:2 B5:3 . E6:2 D6:2 B5:3 | A5:2 A5 B5:2 D6:3 . F#6:2 D6:2 A5:3 | . . . . . . . . . . . . . . . . | F5:2 A5:2 C6:2 F6:6 . . . .';
// build 2 (over Cmaj7 D Bm7 Em7 Cmaj7 D B7sus4 B7), in eighth-note triplets: the head of drop 2's question four times, then twice
// whole, then B7 spelled upwards into the drop's E minor
const BUILD2_MEL =
  'E5 E5 F#5 G5:3 . . . . . . | D5 D5 E5 F#5:3 . . . . . . | B4 B4 C#5 D5:3 . . . . . . | E5 E5 F#5 G5:3 . . . . . . | ' +
  'E5 E5 F#5 G5:3 . B5:2 G5 E5:2 | D5 D5 E5 F#5:3 . A5:2 F#5 E5:2 | F#5:6 E5:6 | D#5:3 F#5:3 B5:3 . . .';
// the bridge (over Am7 D7 Gmaj7 Cadd9 F#m7b5 B7 Em7 Em7): the question's repeated first note, slowed down, falling a step each time
// round the circle of fifths, each answered by a run down the scale
const BRIDGE_MEL =
  'E5:3 E5:3 F#5:2 G5:8 | . . A5:2 G5:2 F#5:4 E5:2 D5:4 | D5:3 D5:3 E5:2 F#5:8 | . . G5:2 F#5:2 E5:4 D5:2 C5:4 | ' +
  'C5:3 C5:3 D5:2 E5:8 | . . A5:2 F#5:2 D#5:4 B4:2 A4:4 | G4:3 B4:3 E5:2 G5:8 | F#5:4 E5:4 D5:4 B4:4';

// ── drums (16 steps a bar unless marked) ───────────────────────────────────────────────────────────────────────────────
const K_HALF = 'X.........x.....'; // half time: on 1 and the "and" of 3, never under the snare
const K_QA = 'X.........x..... | X............x..'; // a bell bar, then a growl bar (the second kick lands with the last stab)
const K_AQ = 'X............x.. | X.........x.....'; // drop 3: the growls speak first
const K_GG = 'X............x..'; // the growls in every bar
const C_QA = '........X....... | ........X....x..'; // claps: the backbeat, and in a growl bar also with the last stab
const C_AQ = '........X....x.. | ........X.......';
const C_GG = '........X....x..';
const K_TRIP = 'X.........x..... | X...........x...'; // drop 2: the growl bar's second kick on the triplet skip (beat 4)
const K_FOUR = 'X...X...X...X...';
const K_DOUBLE = 'X.......X.x..... | X.....x.X.......'; // double time: 1 and 3 with pushes
const BACK = '........X.......'; // the half-time backbeat (beat 3)
const TWO_FOUR = '....X.......X...'; // the double-time backbeat
const H8 = 'x.x.x.x.x.x.x.x.';
const H16 = 'x.xgx.xgx.xgx.xg | x.xgx.xgx.xgxxxo';
const H_TRIP = 'xgxxgxxgxxgo'; // res 3: eighth-note triplets, the last one open
const SHAKE = 'x.xxx.xxx.xxx.xx';
const BOING = '. . . . . . . . C4 . A3 . F3 . C3 .'; // a tom run down an F chord under the fanfare's second half
const BOING_B = '. . . . . . . . B3 . F#3 . D#3 . B2 .'; // the same down a B7 chord (drop 2)

export default defineTrack({ id: 'gumdrop-grand-prix', title: 'Gumdrop Grand Prix', genre: 'Melodic dubstep', bpm: 150, bars: 120, tail: 4 }, (s) => {
  s.key('G', 'major');
  const S = s.sections({ intro: 8, verse: 8, build: 8, drop: 16, toybox: 8, build2: 8, drop2: 16, bridge: 16, build3: 8, drop3: 16, outro: 8 });

  const music = s.bus('music', {}); // pad, pluck and music box: one filter for the transitions

  // ── drums ──
  const kick = s.kick({ preset: 'punchy-kick', pitch: 58, decay: 0.3 }, { gain: -4 });
  const snare = s.snare({ preset: 'tight-snare', tune: 235, snap: 0.8, noiseDecay: 0.16 }, { gain: -6, reverb: 0.2, key: true }); // the backbeat pumps the music too
  const clap = s.clap('clap', { gain: -10, reverb: 0.25, pan: 0.1 });
  const roll = s.snare({ preset: 'tight-snare', tune: 220 }, { name: 'roll', gain: -13, reverb: 0.2 });
  const hat = s.hat('tight-hat', { gain: -11, pan: 0.2 });
  const shaker = s.perc('shaker', { name: 'shaker', gain: -17, pan: -0.25 });
  const snap = s.perc('snap', { name: 'snap', gain: -11, reverb: 0.25, pan: -0.1 });
  const block = s.perc('block', { name: 'block', gain: -14, pan: 0.3, reverb: 0.15 });
  const tom = s.tom('synth-tom', { gain: -11, reverb: 0.2 });
  const crash = s.cymbal('crash', { gain: -12, reverb: 0.15 });
  const swell = s.cymbal('reverse-crash', { name: 'swell', gain: -14 });
  // ── bass: a clean sub, three growls for the stabbed chords, three for the held ones (all stereo, all in the centre: their width
  // spreads them above 200 Hz and keeps the lows mono) ──
  const sub = s.sub('sub-sine', { gain: -8, duck: 0.9 });
  const gLo = s.growl(G_LO, { name: 'gLo', gain: -7, duck: 0.7, hp: 70 });
  const gMid = s.growl(G_MID, { name: 'gMid', gain: -9, duck: 0.7, hp: 130 });
  const gHi = s.growl(G_HI, { name: 'gHi', gain: -8.5, duck: 0.7, hp: 180 });
  // the held chords also pump on every beat on their own (the kick's duck plays 1 and the "and" of 3): colour-bass chords breathing under
  // the bell; the pump is off while they snore in the toy box
  const holdPump = () => [fx.pump({ pattern: 'x...x...x...x...', depth: 0.5, release: 0.25, curve: 1.4 })];
  const hLo = s.growl(H_LO, { name: 'hLo', gain: -12, duck: 0.8, hp: 70, fx: holdPump() });
  const hMid = s.growl(H_MID, { name: 'hMid', gain: -14, duck: 0.8, hp: 130, fx: holdPump() });
  const hHi = s.growl(H_HI, { name: 'hHi', gain: -14, duck: 0.8, hp: 180, fx: holdPump() });
  const HELD_GAIN = [-12, -14, -14]; // the faders of hLo, hMid, hHi (for the automation below)
  // ── tunes and harmony ──
  const bell = s.synth(BELL, { name: 'bell', gain: -3, reverb: 0.25, delay: 0.18, duck: 0.2, width: 1.3, fx: [fx.chorus({ rate: 0.35, depth: 2.5, mix: 0.3 })] });
  const chip = s.synth(CHIP, { name: 'chip', gain: -9, reverb: 0.2, delay: 0.15, duck: 0.3, width: 1.4 });
  const box = s.synth(MUSICBOX, { name: 'box', gain: -9, reverb: 0.35, delay: 0.25, pan: 0.1, bus: 'music' });
  const pluck = s.synth({ preset: 'pluck', cutoff: 2000, click: 0.15 }, { name: 'pluck', gain: -10, reverb: 0.25, delay: 0.2, duck: 0.4, pan: -0.15, bus: 'music' });
  // the pad also pumps on every beat in the verse and the bridge (future-bass breathing under the chip's tune; its depth is automated
  // below, 0 elsewhere, where the pad follows the kick's duck)
  const pad = s.synth(PAD, {
    name: 'pad', gain: -13, reverb: 0.35, duck: 0.85, hp: 160, width: 1.4, bus: 'music',
    fx: [fx.chorus({ rate: 0.5, depth: 4 }), fx.pump({ pattern: 'x...x...x...x...', depth: 0, release: 0.3, curve: 1.4 })],
  });
  // ── transitions ──
  const riser = s.riser('riser', { gain: -16 });
  const wash = s.riser('noise-wash', { name: 'wash', gain: -18 });
  const down = s.riser('downlifter', { name: 'down', gain: -15, reverb: 0.3 });
  const boom = s.impact('impact', { name: 'boom', gain: -7, reverb: 0.3 });
  const zap = s.zap('zap', { gain: -16, reverb: 0.2, delay: 0.3 });

  // ── helpers ──
  const held = 'x---------------';
  const N = (text: string, res = 4) => s.notes(text, { res });
  type Ch = typeof gLo;
  const STAB: readonly Ch[] = [gLo, gMid, gHi];
  const HELD: readonly Ch[] = [hLo, hMid, hHi];
  /** The three voices of a growl phrase, one bar at `bar`. */
  const sing = (chs: readonly Ch[], v: [string, string, string], bar: number, res = 4, vel = 1): void => {
    chs.forEach((ch, i) => ch.play(N(v[i], res), bar, 1, { vel }));
  };
  /** A held growl chord for one bar. */
  const hold = (name: string, bar: number, vel = 0.8): void => {
    const c = HOLDV[name];
    if (!c) throw new Error(`no held growl chord for ${name}`);
    HELD.forEach((ch, i) => ch.play(N(`${c[i]}:16`), bar, 1, { vel }));
  };
  /** A slow glide for a dive's slid note only (the glide starts after the bar's last stab, so the stabs before it do not slur). */
  const slideBar = (bar: number): void => {
    for (const ch of STAB) ch.auto('glide', [[bar + 0.84, 0.22], [bar + 1, 0, 'step']]);
  };
  /** Where the bass lands (a drop's first beat, the last chords), the growls dive into the note from a whole octave up, in 0.12 s. */
  const bigDive = (bar: number): void => {
    for (const ch of STAB) {
      ch.auto('pEnv', [[bar, 12], [bar + 0.125, ch.param('pEnv'), 'step']]);
      ch.auto('pEnvTime', [[bar, 0.12], [bar + 0.125, ch.param('pEnvTime'), 'step']]);
    }
  };
  const padBar = (name: string, bar: number, vel = 0.6): void => {
    pad.play(N(strike(PADV[name], held)), bar, 1, { vel });
  };
  /** The sub in a growl bar: the growls' root an octave down, on their rhythm (the whole bass answers). */
  const subStab = (v: Voicing, rhythm: readonly number[], bar: number, res = 4): void => {
    const lo = typeof v.lo === 'string' ? v.top.map(() => v.lo as string) : v.lo;
    sub.play(N(phrase(rhythm, lo.map((x) => up(x, -12))), res), bar, 1);
  };
  /** The sub held for a bar under the bell's question. */
  const subHold = (name: string, bar: number): void => {
    sub.play(N(prog([name], SUBR, held)), bar, 1);
  };
  /**
   * The drop beat, half time. The kick follows who speaks: under the bell 1 and the "and" of 3, under the growls 1 and their last stab
   * (so the sidechain never chops a stab); `kicks` is that two-bar pattern, `claps` the clap's (it can clap along with the last stab).
   * A: eighth-note hats. B: sixteenths, a shaker and a triplet
   * flourish closing every second bar. trip: hats in eighth-note triplets. double: double time. `stop`: the last bar drops out for the
   * growls (a kick on 1 and that tom run under its second half).
   */
  const beat = (at: number, bars: number, style: 'A' | 'B' | 'trip' | 'double', o: { kicks?: string; claps?: string; stop?: string } = {}): void => {
    if (style === 'double') {
      kick.play(s.hits(K_DOUBLE), at, bars);
      snare.play(s.hits(TWO_FOUR), at, bars);
      clap.play(s.hits(TWO_FOUR), at, bars, { vel: 0.8 });
      hat.play(s.hits('x.xox.xox.xox.xo'), at, bars, { vel: 0.75 });
      shaker.play(s.hits(SHAKE), at, bars, { vel: 0.55 });
      return;
    }
    const n = o.stop ? bars - 1 : bars;
    kick.play(s.hits(o.kicks ?? K_QA), at, n);
    snare.play(s.hits(BACK), at, n);
    clap.play(s.hits(o.claps ?? BACK), at, n);
    if (style === 'trip') hat.play(s.hits(H_TRIP, { res: 3 }), at, n, { vel: 0.75 });
    else hat.play(s.hits(style === 'A' ? H8 : H16), at, n, { vel: 0.75 });
    if (style === 'B') shaker.play(s.hits(SHAKE), at, n, { vel: 0.5 });
    if (style === 'B') for (let b = 1; b < n; b += 2) hat.play(s.hits('xxxxxx', { res: 6 }), at + b + 0.75, 0.25, { vel: 0.6 });
    else if (n > 4) {
      hat.play(s.hits('xxxxxx', { res: 6 }), at + 3.75, 0.25, { vel: 0.6 }); // the first four bars close with a flourish
      crash.hit(at + 4, '', 0.5); // and the next four open with a soft crash
    }
    if (o.stop) {
      kick.play(s.hits('X...............'), at + n, 1);
      tom.play(N(o.stop), at + n, 1, { vel: 0.6 });
    }
  };
  /** The first beat of a drop: a boom and a crash (the build before it has the reverse crash) and, when the bell speaks first, one
   * eighth-note chord of growls under its first note (`hit`: the chord), so that the bass lands on the downbeat. */
  const land = (at: number, hit?: string): void => {
    boom.hit(at, '', 1);
    crash.hit(at, '', 1);
    if (hit) {
      const c = HOLDV[hit];
      STAB.forEach((ch, i) => ch.play(N(`${c[i]}:2 . . . . . . . . . . . . . .`), at, 1));
    }
  };

  // ── intro: the conversation on a music box and a pluck, over a pad that opens ──
  pad.play(N(prog(P1, PADV, held)), S.intro, undefined, { vel: 0.7 });
  pad.auto('cutoff', [[0, 600], [S.intro.end, 2400, 'exp']]);
  for (let i = 0; i < 4; i++) {
    box.play(N(phrase(RQ, CALLS[i])), 2 * i, 1, { vel: 0.75 });
    pluck.play(N(pairs(RQ, ANSWERS[i], 12)), 2 * i + 1, 1, { vel: 0.7 });
  }
  snap.play(s.hits(BACK), 4, 4, { vel: 0.6 });
  shaker.play(s.hits(SHAKE), 4, 4, { vel: 0.4 });
  kick.play(s.hits('X...............'), 4, 3, { vel: 0.55 });
  sub.play(N(prog(P1.slice(4), SUBR, held)), 4, 4, { vel: 0.7 });
  tom.play(N(BOING), 7, 1, { vel: 0.55 });

  // ── verse: the beat, the chip lead over a bass walking down, a pluck arpeggio ──
  pad.play(N(prog(PV, PADV, held)), S.verse, undefined, { vel: 0.55 });
  chip.play(N(VERSE_MEL), S.verse);
  pluck.play(N(arpLine(PV, VARP, 'x.xx.xx.x.xx.xx.')), S.verse, undefined, { vel: 0.55 });
  sub.play(N(prog(PV, SUBR, held)), S.verse);
  // the first four bars keep the intro's snap on 3; the kick and the snare come in for the second four
  snap.play(s.hits(BACK), S.verse.bar, 4, { vel: 0.6 });
  kick.play(s.hits('X...............'), S.verse.bar, 4, { vel: 0.5 });
  kick.play(s.hits(K_HALF), S.verse.bar + 4, 4, { vel: 0.55 });
  snare.play(s.hits(BACK), S.verse.bar + 4, 4, { vel: 0.5 });
  clap.play(s.hits(BACK), S.verse.bar + 4, 4, { vel: 0.5 });
  hat.play(s.hits(H8), S.verse, undefined, { vel: 0.5 });
  shaker.play(s.hits(SHAKE), S.verse, undefined, { vel: 0.4 });
  snap.play(s.hits('..............x.'), S.verse, undefined, { vel: 0.4 });
  roll.play(s.hits('............x.xX'), S.verse.end - 1, 1, { vel: 0.5 });

  // ── a build: the question's head climbing, chords struck faster and faster, the growls' fanfare, a roll, the riser ──
  // (no sub, no low pad: the low end is saved for the drop; lone: the last bar is the bell's question alone, the drop answers it)
  const build = (at: number, o: { lone?: boolean } = {}): void => {
    pad.play(N(prog(PB.slice(0, 4), PADV, 'x---x---x---x---')), at, 4, { vel: 0.6 });
    pad.play(N(prog(PB.slice(4, 6), PADV, 'x-x-x-x-x-x-x-x-')), at + 4, 2, { vel: 0.6 });
    pad.play(N(prog(['Eb|F'], PADV, 'xxxxxxxxxxxxxxxx')), at + 6, 1, { vel: 0.55 });
    pad.auto('mix.hp', [[at, 160], [at + 7, 700, 'exp'], [at + 8, 160, 'step']]);
    if (o.lone) {
      bell.play(N(BUILD_MEL), at, 7, { vel: 0.75 });
      bell.play(N(phrase(RQ, CALLS[0])), at + 7, 1); // the question, alone
    } else {
      bell.play(N(BUILD_MEL), at, 8, { vel: 0.75 }); // softer (and so a little darker) than in the drop
      pad.play(N(prog(['F'], PADV, 'xxxxxxxxxxxx....')), at + 7, 1, { vel: 0.55 });
    }
    sing(STAB, voices(RQ, A4), at + 6, 4, 0.85); // the growls' first word
    kick.play(s.hits(K_HALF), at, 4, { vel: 0.6 });
    clap.play(s.hits(BACK), at, 4, { vel: 0.55 });
    kick.play(s.hits(K_FOUR), at + 4, 2, { vel: 0.6 });
    kick.play(s.hits(K_GG), at + 6, 1, { vel: 0.65 }); // with the fanfare's first and last stab
    kick.auto('mix.hp', [[at, 20], [at, 180, 'step'], [at + 8, 20, 'step']]); // a thin kick: the low end is saved for the drop
    hat.play(s.hits(H8), at, 6, { vel: 0.5 });
    roll.play(s.hits('3.3.3.3.4.4.4.4. | 5.5.5.5.6.6.6.6.'), at + 4, 2, { vel: 0.65 });
    roll.play(s.hits('6666777777888888'), at + 6, 1, { vel: 0.65 });
    if (!o.lone) roll.play(s.hits('999999999999999999999999........', { res: 8 }), at + 7, 1, { vel: 0.65 }); // the last beat is silent
    roll.auto('tune', [[at + 4, 200], [at + 7.75, 400, 'exp'], [at + 8, 220, 'step']]);
    riser.hit(at, '', 1, 0, o.lone ? 28 : 31); // lone: the sweeps end where the bell's solo begins
    wash.hit(at + 4, '', 1, 0, o.lone ? 12 : 15);
    swell.note(at + 7, 'A3', 4, 1);
    music.auto('mix.lp', [[at, 2500], [at + 7.75, 20000, 'exp']]);
  };

  // ── a drop of the hook (drops 1 and 3 share the harmony; the parts differ) ──
  const D1 = S.drop.bar;
  build(S.build.bar);
  land(D1, 'G');
  bigDive(D1);
  beat(D1, 8, 'A', { stop: BOING }); // the first eight ends in a stop: the fanfare alone
  beat(D1 + 8, 8, 'B', { claps: C_QA });
  for (let i = 0; i < 4; i++) {
    // first eight: the bell asks (the sub holds), the growls answer (the sub with them)
    const q = D1 + 2 * i;
    bell.play(N(phrase(RQ, CALLS[i])), q, 1);
    padBar(P1[2 * i], q);
    subHold(P1[2 * i], q);
    sing(STAB, voices(RQ, ANSWERS[i]), q + 1);
    subStab(ANSWERS[i], RQ, q + 1);
    // second eight: the growls hold the chord under the question, the chip doubles the bell an octave down
    const q2 = q + 8;
    bell.play(N(phrase(RQ, CALLS[i])), q2, 1);
    chip.play(N(phrase(RQ, CALLS[i])), q2, 1, { transpose: -12, vel: 0.85 });
    hold(P1[2 * i], q2);
    subHold(P1[2 * i], q2);
    sing(STAB, i === 3 ? voicesDive(RQ, A4) : voices(RQ, ANSWERS[i]), q2 + 1); // the last fanfare dives an octave: the growls fall asleep
    if (i === 3) slideBar(q2 + 1);
    subStab(ANSWERS[i], RQ, q2 + 1);
  }
  crash.hit(D1 + 8, '', 0.8);
  pluck.play(N(arpLine(P1, ARPV, 'x.xx.xx.x.xx.xx.')), D1 + 8, 8, { vel: 0.45 }); // a sparkle over the second eight
  // cheeky details in the second eight: a laser "pew" on the snare of every other question, a ghost snare leading into the answers' beat 3
  for (const b of [D1 + 10, D1 + 14]) zap.hit(b + 0.5, '', 0.7);
  roll.play(s.hits('................ | ......4.........'), D1 + 8, 8); // on the roll snare: it does not key the sidechain
  tom.play(N(BOING), D1 + 15, 1, { vel: 0.6 });

  // ── the toy box: the first half of the conversation at half speed, the beat in stop time ──
  const T = S.toybox.bar;
  down.hit(T, '', 1, 0, 8);
  pad.play(N(prog(PT, PADV, held)), S.toybox, undefined, { vel: 0.55 });
  sub.play(N(prog(PT, SUBR, held)), S.toybox, undefined, { vel: 0.6 });
  box.play(N(phrase(RQ2, CALLS[0])), T, 2, { vel: 0.8 });
  pluck.play(N(pairs(RQ2, A1, 12)), T + 2, 2, { vel: 0.7 });
  box.play(N(phrase(RQ2, CALLS[1])), T + 4, 2, { vel: 0.8 });
  pluck.play(N(pairs(RQ2, A2, 12)), T + 6, 2, { vel: 0.7 });
  kick.play(s.hits('X............... | ................'), S.toybox, undefined, { vel: 0.5 });
  snap.play(s.hits(BACK), S.toybox, undefined, { vel: 0.6 });
  shaker.play(s.hits(SHAKE), T + 4, 4, { vel: 0.4 });
  block.play(s.hits('..........x.x.x.'), T + 3, 1, { vel: 0.6 });
  block.play(s.hits('......x...x.xxx.'), T + 7, 1, { vel: 0.7 });
  music.auto('mix.lp', [[T, 20000], [T, 5000, 'step'], [T + 4, 9000, 'exp'], [T + 8, 20000, 'exp']]);
  // the growls fell asleep at the end of drop 1 (the dive): now they snore, one slow breath a bar under a closed filter; build 2 wakes them
  PT.slice(4).forEach((c, i) => hold(c, T + 4 + i, 0.28));
  for (const ch of HELD) {
    ch.auto('lfoRate', [[T + 4, 0.25], [T + 8, ch.param('lfoRate'), 'step']]);
    ch.auto('cutoff', [[T + 4, 220], [T + 8, ch.param('cutoff'), 'step']]);
    const g = HELD_GAIN[HELD.indexOf(ch)];
    ch.auto('mix.gain', [[T + 4, g - 7], [T + 8, g, 'step']]); // (velocity hardly changes a growl's level: the fader does it)
    ch.auto('fx.pump.depth', [[T + 4, 0], [T + 8, 0.5, 'step']]); // no pumping in their sleep
  }

  // ── build 2: into E minor, in triplets ──
  const B2 = S.build2.bar;
  pad.play(N(prog(PB2.slice(0, 4), PADV, 'x--x--x--x--'), 3), B2, 4, { vel: 0.6 });
  pad.play(N(prog(PB2.slice(4, 6), PADV, 'x-x-x-x-x-x-'), 3), B2 + 4, 2, { vel: 0.6 });
  pad.play(N(prog(['B7sus4'], PADV, 'xxxxxxxxxxxx'), 3), B2 + 6, 1, { vel: 0.55 });
  pad.play(N(prog(['B7'], PADV, 'xxxxxxxxxxxxxxxxxx......'), 6), B2 + 7, 1, { vel: 0.55 });
  pad.auto('mix.hp', [[B2, 160], [B2 + 7, 700, 'exp'], [B2 + 8, 160, 'step']]);
  bell.play(N(BUILD2_MEL, 3), B2, 8, { vel: 0.75 });
  kick.play(s.hits(K_HALF), B2, 4, { vel: 0.6 });
  clap.play(s.hits(BACK), B2, 4, { vel: 0.55 });
  kick.play(s.hits('x.x.x.x.x.x.', { res: 3 }), B2 + 4, 3, { vel: 0.6 }); // quarter-note triplets
  kick.auto('mix.hp', [[B2, 20], [B2, 180, 'step'], [B2 + 8, 20, 'step']]);
  hat.play(s.hits(H_TRIP, { res: 3 }), B2, 6, { vel: 0.5 });
  roll.play(s.hits('123344556677 | 778888999999', { res: 3 }), B2 + 4, 2, { vel: 0.65 });
  roll.play(s.hits('666666777777888888999999', { res: 6 }), B2 + 6, 1, { vel: 0.65 });
  roll.play(s.hits('999999999999999999......', { res: 6 }), B2 + 7, 1, { vel: 0.65 });
  roll.auto('tune', [[B2 + 4, 200], [B2 + 7.75, 400, 'exp'], [B2 + 8, 220, 'step']]);
  riser.hit(B2, '', 1, 0, 31);
  wash.hit(B2 + 4, '', 1, 0, 15);
  swell.note(B2 + 7, 'A3', 4, 1);
  music.auto('mix.lp', [[B2, 2500], [B2 + 7.75, 20000, 'exp']]);

  // ── drop 2: the flip ──
  const D2 = S.drop2.bar;
  land(D2, 'Em7');
  bigDive(D2);
  beat(D2, 8, 'trip', { kicks: K_TRIP, stop: BOING_B });
  for (let i = 0; i < 4; i++) {
    const q = D2 + 2 * i;
    bell.play(N(phrase(RT, TCALLS[i]), 3), q, 1);
    padBar(P2[2 * i], q);
    subHold(P2[2 * i], q);
    sing(STAB, voices(RT, UANS[i]), q + 1, 3);
    subStab(UANS[i], RT, q + 1, 3);
  }
  crash.hit(D2 + 8, '', 0.8);
  beat(D2 + 8, 4, 'trip', { kicks: K_TRIP });
  shaker.play(s.hits('xxxxxxxxxxxx', { res: 3 }), D2 + 8, 4, { vel: 0.45 }); // the shaker in triplets too
  pluck.play(N(arpLine(P2.slice(0, 4), ARPV, 'xxxxxxxxxxxx'), 3), D2 + 8, 4, { vel: 0.45 }); // rolling triplets
  for (let i = 0; i < 2; i++) {
    const q = D2 + 8 + 2 * i;
    bell.play(N(phrase(RT, TCALLS[i]), 3), q, 1);
    chip.play(N(phrase(RT, TCALLS[i]), 3), q, 1, { transpose: -12, vel: 0.85 });
    hold(P2[2 * i], q);
    subHold(P2[2 * i], q);
    sing(STAB, voices(RT, UANS[i]), q + 1, 3);
    subStab(UANS[i], RT, q + 1, 3);
  }
  // double time: the same conversation snaps back to straight sixteenths, the beat twice as fast; the drums stop for the last beat
  beat(D2 + 12, 3.75, 'double');
  for (let i = 2; i < 4; i++) {
    const q = D2 + 8 + 2 * i;
    bell.play(N(phrase(RQ, TCALLS[i])), q, 1);
    chip.play(N(phrase(RQ, TCALLS[i])), q, 1, { transpose: -12, vel: 0.85 });
    hold(P2[2 * i], q);
    subHold(P2[2 * i], q);
    sing(STAB, i === 3 ? voicesDive(RQ, U4) : voices(RQ, UANS[i]), q + 1);
    if (i === 3) slideBar(q + 1);
    subStab(UANS[i], RQ, q + 1);
  }
  crash.hit(D2 + 12, '', 0.9);
  zap.hit(D2 + 15.75, '', 0.8);

  // ── bridge: a new tune round the circle of fifths: the music box alone, then the chip lead over held growl chords and a light beat ──
  const BR = S.bridge.bar;
  down.hit(BR, '', 0.9, 0, 8);
  pad.play(N(prog(PR, PADV, held)), S.bridge, undefined, { vel: 0.55 });
  box.play(N(BRIDGE_MEL), BR, 8, { vel: 0.8 });
  sub.play(N(prog(PR.slice(4), SUBR, held)), BR + 4, 4, { vel: 0.65 });
  sub.play(N(prog(PR, SUBR, held)), BR + 8, 8, { vel: 0.65 });
  shaker.play(s.hits(SHAKE), BR + 4, 4, { vel: 0.35 });
  chip.play(N(BRIDGE_MEL), BR + 8, 8);
  box.play(N(BRIDGE_MEL), BR + 8, 8, { transpose: 12, vel: 0.45 });
  PR.forEach((c, i) => hold(c, BR + 8 + i, 0.45));
  HELD.forEach((ch, i) => ch.auto('mix.gain', [[BR + 8, HELD_GAIN[i] - 4], [BR + 16, HELD_GAIN[i], 'step']])); // under the chip's tune
  kick.play(s.hits(K_HALF), BR + 8, 8, { vel: 0.6 });
  clap.play(s.hits(BACK), BR + 8, 8, { vel: 0.5 });
  hat.play(s.hits(H8), BR + 12, 4, { vel: 0.45 });
  riser.hit(BR + 14, '', 0.8, 0, 8);

  // ── build 3 and drop 3: the roles swap ──
  build(S.build3.bar, { lone: true });
  const D3 = S.drop3.bar;
  land(D3);
  bigDive(D3); // the parrot's first note
  beat(D3, 8, 'B', { kicks: K_AQ, claps: C_AQ });
  beat(D3 + 8, 4, 'B', { kicks: K_GG, claps: C_GG });
  beat(D3 + 12, 4, 'double');
  for (let i = 0; i < 4; i++) {
    // first eight: the growls sing the questions (the chip doubles them an octave up), the bell answers two octaves up
    const q = D3 + 2 * i;
    sing(STAB, voices(RQ, GCALLS[i]), q);
    subStab(GCALLS[i], RQ, q);
    chip.play(N(phrase(RQ, CALLS[i])), q, 1, { transpose: -12, vel: 0.85 });
    const answerHigh = ANSWERS[i].top.map((x) => up(x, 24));
    bell.play(N(phrase(RQ, answerHigh)), q + 1, 1);
    if (i < 3) {
      padBar(P1[2 * i + 1], q + 1);
      subHold(P1[2 * i + 1], q + 1);
    } else {
      sing(STAB, voices(RQ, A4), q + 1); // the fanfare: everybody
      subStab(A4, RQ, q + 1);
    }
    // second eight: everybody sings everything; the third question goes up to G6
    const q2 = q + 8;
    const gcall = i === 2 ? GC_PEAK : GCALLS[i];
    bell.play(N(phrase(RQ, i === 2 ? CALL_PEAK : CALLS[i])), q2, 1);
    chip.play(N(phrase(RQ, i === 2 ? CALL_PEAK : CALLS[i])), q2, 1, { transpose: -12, vel: 0.85 });
    sing(STAB, voices(RQ, gcall), q2);
    subStab(gcall, RQ, q2);
    bell.play(N(phrase(RQ, answerHigh)), q2 + 1, 1);
    chip.play(N(phrase(RQ, ANSWERS[i].top.map((x) => up(x, 12)))), q2 + 1, 1, { vel: 0.85 });
    sing(STAB, voices(RQ, ANSWERS[i]), q2 + 1);
    subStab(ANSWERS[i], RQ, q2 + 1);
  }
  crash.hit(D3 + 8, '', 0.8);
  for (const b of [D3 + 8, D3 + 10, D3 + 14]) zap.hit(b + 0.5, '', 0.7);
  crash.hit(D3 + 12, '', 0.9);

  // ── outro: the conversation on the music box once more, the growls' fanfare as the last word, the last chord ──
  const O = S.outro.bar;
  const landG: [string, string, string] = ['G2:6 . . . . . . . . . .', 'D3:6 . . . . . . . . . .', 'B3:6 . . . . . . . . . .'];
  sing(STAB, landG, O); // drop 3's fanfare lands on a G chord of growls
  bigDive(O);
  crash.hit(O, '', 0.8);
  down.hit(O, '', 0.8, 0, 8);
  pad.play(N(prog(PO, PADV, held)), O, 6, { vel: 0.55 });
  sub.play(N(prog(PO, SUBR, held)), O, 6, { vel: 0.65 });
  box.play(N(phrase(RQ, CALLS[0])), O, 1, { vel: 0.75 });
  pluck.play(N(pairs(RQ, A1, 12)), O + 1, 1, { vel: 0.65 });
  box.play(N(phrase(RQ, CALLS[1])), O + 2, 1, { vel: 0.75 });
  pluck.play(N(pairs(RQ, A2, 12)), O + 3, 1, { vel: 0.65 });
  box.play(N(phrase(RQ, CALLS[3])), O + 4, 1, { vel: 0.75 });
  sing(STAB, voices(RQ, A4), O + 5, 4, 0.75);
  kick.play(s.hits(K_HALF), O, 4, { vel: 0.55 });
  snap.play(s.hits(BACK), O, 6, { vel: 0.55 });
  const fin = O + 6;
  sing(STAB, landG, fin, 4, 0.8); // and so does the outro's: the growls have the last word
  bigDive(fin);
  pad.play(N('[G3,B3,D4,G4]:32'), fin, 2, { vel: 0.65 });
  sub.play(N('G1:32'), fin, 2, { vel: 0.6 });
  box.play(N('[G5,B5,D6,G6]:32').strum(0.08), fin, 2, { vel: 0.7 });
  boom.hit(fin, '', 0.7);
  crash.hit(fin, '', 0.7);

  // ── mix moves ──
  sub.auto('mix.gain', [[0, -12], [S.verse.bar, -14, 'step'], [D1, -8, 'step'], [T, -12, 'step'], [D2, -8, 'step'], [BR, -13, 'step'], [D3, -8, 'step'], [O, -11, 'step']]);
  music.auto('mix.lp', [[0, 3000], [S.intro.end, 20000, 'exp']]);
  // the pad's own pump in the verse and the bridge, where its duck on the kick steps back (the two ducks would multiply)
  pad.auto('fx.pump.depth', [[S.verse.bar, 0.6], [S.verse.end, 0, 'step'], [BR, 0.6, 'step'], [BR + 16, 0, 'step']]);
  pad.auto('mix.duck', [[S.verse.bar, 0.4], [S.verse.end, 0.85, 'step'], [BR, 0.4, 'step'], [BR + 16, 0.85, 'step']]);

  s.setReverb({ time: 2.6, preDelay: 0.02, return: -10, lowCut: 220, highCut: 8500 });
  s.setDelay({ time: '1/8.', feedback: 0.3, return: -12 });
  s.setSidechain({ release: 0.22, curve: 1.4 });
  s.setMaster({ trim: 5.7 }); // found with the probe's AUTOTRIM=1
});
