// Storm Chaser: melodic dubstep for the album "Xeno-Racer Vol. 1": the epic, cinematic one (mountains, a storm, the sun breaking through).
// 150 BPM in half time, C# minor: the relative major's E and B for light, the harmonic minor's G# major (its sus4 resolving) for tension.
//
// The harmony is a lament: C#m B A E/G# | C#m B A G#sus4-G# (i VII VI III6 | i VII VI V), the bass stepping down C# B A G# twice, the
// first time onto the bright E major, the second onto the dominant. Over it a slow THEME in half notes, chord tones only, that climbs
// from E5 to C#6, and the HOOK made from it: a chanted pickup (E E E F#) that reaches a higher note each time (G#, then A, then B), falling
// answers, the climb to C#6 and the leading tone B#. The piano states the theme in the storm, a horn sings it over taiko and galloping
// strings, the first build teases the hook's chant, drop 1 sings the hook on a supersaw lead with the growl answering in its gaps, the
// break floats the theme over a trance arpeggio, reharmonised from the relative major (E B F#m7 C#m | E G#m7 F#m G#: the clouds part),
// then goes four-on-the-floor; drop 2 is a growl riff (a low roar calls, a talking growl answers after the snare) under horns holding
// the theme, then the hook returns over it harmonised and doubled an octave up; the eye of the storm breathes before the finale switches
// the drums to double time for the hook's last statement, and the outro ends in C# major.
// Probe:  ALBUM=1 ONLY=storm-chaser AUTOTRIM=1 SPEC=1 CLASH=1 npx vitest run tests/probes/album-render.test.ts
import { FLAG, defineTrack, fx } from '../song';
import type { DrumOpts, GrowlOpts, SynthOpts } from '../song';

// ── patches ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A cinematic grand: a bright FM hammer over a detuned triangle body, a long decay and a sustain-pedal release. */
export const GRAND: SynthOpts = {
  layers: [
    { wave: 'fm', level: 1 },
    { wave: 'tri', unison: 2, detune: 1, level: 0.3 },
    { wave: 'sine', octave: 1, level: 0.06 },
  ],
  fmRatio: 1, fmIndex: 4.4, fmDecay: 0.45, fmSustain: 0.05, fmFeedback: 0.14,
  filter: 'lp', cutoff: 3000, res: 0.05, envAmt: 1.4, fAttack: 0.001, fDecay: 0.35, fSustain: 0.3, fRelease: 0.5, keytrack: 0.8, velFilter: 1,
  attack: 0.001, decay: 4.5, sustain: 0, release: 1.1, velAmp: 0.85,
  unisonDetune: 5, spread: 0.6, voices: 16,
  click: 0.22, clickDecay: 0.01, clickTone: 3200, clickKeytrack: 0.5, // the hammer
};

/** Slow-bowed strings: the string ensemble with a slower bow, a darker top and a late vibrato (chorus and the hall do the rest). */
export const STRINGS: SynthOpts = { preset: 'string-pad', attack: 0.8, release: 1.4, cutoff: 2600, vibDepth: 8, vibDelay: 0.7, unisonDetune: 12 };

/** Spiccato strings for the galloping ostinato: a short bowed saw stack with a quick filter bite. */
export const SPICCATO: SynthOpts = {
  layers: [
    { wave: 'saw', unison: 5, detune: 1 },
    { wave: 'saw', octave: 1, unison: 2, detune: 0.5, level: 0.22 },
  ],
  filter: 'lp', cutoff: 1300, res: 0.1, envAmt: 1.7, fAttack: 0.003, fDecay: 0.11, fSustain: 0.1, keytrack: 0.6,
  attack: 0.004, decay: 0.15, sustain: 0.05, release: 0.1, unisonDetune: 10, spread: 0.9, voices: 10,
  click: 0.35, clickDecay: 0.008, clickTone: 2400, // the bow's bite
};

/** A French-horn section: saws behind a filter that swells open at each note (the brass bloom), legato, a slow vibrato. */
export const HORN: SynthOpts = {
  mode: 'legato', voices: 1,
  layers: [
    { wave: 'saw', unison: 3, detune: 0.5, phase: 'free' },
    { wave: 'tri', level: 0.45, phase: 'free' },
    { wave: 'square', octave: -1, level: 0.2, phase: 'free' },
  ],
  filter: 'lp', cutoff: 620, res: 0.12, envAmt: 2.1, fAttack: 0.09, fDecay: 0.7, fSustain: 0.45, keytrack: 0.7, velFilter: 1.2,
  attack: 0.035, decay: 0.5, sustain: 0.85, release: 0.4, glide: 0.05, vibDepth: 12, vibRate: 5, vibDelay: 0.45,
  unisonDetune: 8, spread: 0.4, drive: 3, glideMode: 'fingered', // a slur only where the notes join
};

/** The soaring lead: seven wide saws, three more an octave up for the shine, a square an octave down for the body; legato, a scoop, late vibrato. */
export const SOAR: SynthOpts = {
  preset: 'supersaw-lead',
  layers: [
    { wave: 'saw', unison: 7, detune: 1, phase: 'free' },
    { wave: 'saw', octave: 1, unison: 3, detune: 0.6, level: 0.26, phase: 'free' },
    { wave: 'square', octave: -1, level: 0.28, phase: 'free' },
  ],
  unisonDetune: 20, cutoff: 6500, drive: 3, vibDepth: 22, vibDelay: 0.32, glide: 0.06,
  glideMode: 'fingered', // the chant's repeated notes start clean on their pitch; the slid C#6 still scoops
};

/** The harmony under the lead: the same voice without its octave shine, so it sits below. */
export const SOAR_HARM: SynthOpts = {
  preset: 'supersaw-lead',
  layers: [
    { wave: 'saw', unison: 5, detune: 1, phase: 'free' },
    { wave: 'square', octave: -1, level: 0.2, phase: 'free' },
  ],
  unisonDetune: 18, cutoff: 5200, vibDepth: 18, vibDelay: 0.35, glide: 0.06, glideMode: 'fingered',
};

/** The wall of chords: the supersaw chord, wider and driven. */
export const WALL: SynthOpts = { preset: 'supersaw-chord', unisonDetune: 27, cutoff: 6500, drive: 4, release: 0.45 };

/** The break's trance arpeggio: a resonant pluck with a bright snap (the filter opens over the break). */
export const TRANCE_ARP: SynthOpts = { preset: 'trance-pluck', cutoff: 1500, res: 0.42, fDecay: 0.2, release: 0.14 };

/** The break's theme voice: the trance lead, its octave layer making it ring. */
export const TRANCE_LEAD: SynthOpts = { preset: 'trance-lead', cutoff: 2800, res: 0.3, envAmt: 2, release: 0.6, vibDepth: 14, vibDelay: 0.4 };

/** The trance off-beat bass of the break's second half: a plucked saw, short and round. */
export const OFF_BASS: SynthOpts = { preset: 'psy-bass', cutoff: 420, res: 0.22, envAmt: 2.4, fDecay: 0.11, drive: 2, decay: 0.16, release: 0.02 };

/** Glint: a glassy bell (FM ratio 4: odd harmonics, a celesta's hollowness) for the hook an octave up. */
export const GLINT: SynthOpts = {
  layers: [
    { wave: 'fm', level: 1 },
    { wave: 'sine', octave: 1, level: 0.12 },
  ],
  fmRatio: 4, fmIndex: 2.4, fmDecay: 0.5, fmSustain: 0.1, filter: 'off',
  attack: 0.002, decay: 1.6, sustain: 0, release: 0.7, mono: true, voices: 8,
  click: 0.12, clickDecay: 0.006, clickTone: 6000, clickKeytrack: 0.3, // the mallet
};

/** Rain: band-passed noise whose level flickers at random forty times a second (the drops) and whose band drifts slowly. */
export const RAIN: SynthOpts = {
  layers: [{ wave: 'noise' }], filter: 'bp', cutoff: 5200, res: 0.25, keytrack: 0, velFilter: 0,
  attack: 2.5, decay: 1, sustain: 1, release: 3, mono: false, spread: 1, unisonDetune: 0,
  mods: [{ src: 'lfo1', dst: 'amp', amount: 0.25 }, { src: 'lfo2', dst: 'cutoff', amount: 0.35 }],
  lfo1Shape: 'sh', lfo1Rate: 16, lfo2Shape: 'smooth', lfo2Rate: 0.125,
};

/** The roar: a dark O-vowel growl, gnarly FM an octave up, a little comb resonance; its sub is the sub channel's job. */
export const ROAR: GrowlOpts = {
  preset: 'dubstep-growl', sub: 0, cutoff: 380, res: 0.45, lfoRate: 2, lfoPhase: 0.75, lfoDepth: 3, lfoFm: 2.2, lfoVowel: 0.9,
  vowel: 3, formant: 0.6, fmMix: 0.55, fmRatio: 2, fmIndex: 3.2, drive: 18, fold: 0.3, clip: 8, comb: 0.2, tone: 8500, release: 0.06,
  width: 0.55, // stereo above 200 Hz, mono below; its dives (pEnv) are set per section
};

/** The talker: vowels sweeping from A to I on an eighth-note wobble, an octave or two above the roar: drop 2's answers. */
export const TALKER: GrowlOpts = {
  preset: 'yoi', sub: 0, lfoRate: 2, lfoPhase: 0.75, lfoVowel: 2.6, vowel: 0.2, formant: 0.9, fmMix: 0.5, fmIndex: 3.8, lfoFm: 3,
  cutoff: 700, lfoDepth: 2, drive: 17, fold: 0.2, tone: 9000, release: 0.05, width: 0.85, // wide above 200 Hz: the answers open out
};

/** The finale's roar: the same growl with its wobble locked to the beat grid, for a riff of eighth notes. */
export const DRIVER: GrowlOpts = { ...ROAR, lfoSync: 'beat', lfoRate: 2, lfoPhase: 0.75, comb: 0.15, width: 0.5, pEnv: 3, pEnvTime: 0.04 }; // a small dive: punch on every eighth

const KICK: DrumOpts = { preset: 'punchy-kick', pitch: 50, sweep: 2.5, decay: 0.42, punch: 0.6, drive: 12, click: 0.45, tail: 0.22 };
const SNARE: DrumOpts = { preset: 'heavy-snare', tune: 175, noiseTone: 5000, snap: 1, noiseDecay: 0.22 };
const TAIKO: DrumOpts = { preset: 'synth-tom', pitch: 62, drop: 0.6, dropTime: 0.07, decay: 0.8, click: 0.55, overtone: 0.4, drive: 9 };
const TOM_HI: DrumOpts = { preset: 'tom-mid', pitch: 120, decay: 0.45, drive: 5 };

// ── harmony ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Hand-voiced chords, E3-F#4, voice-led: C#m and E/G# share three notes, G#sus4's C# falls to B# and B# rises to C# again. */
const V: Record<string, readonly string[]> = {
  'C#m': ['E3', 'G#3', 'C#4', 'E4'],
  B: ['F#3', 'B3', 'D#4', 'F#4'],
  A: ['E3', 'A3', 'C#4', 'E4'],
  'E/G#': ['E3', 'G#3', 'B3', 'E4'],
  'F#m': ['F#3', 'A3', 'C#4', 'F#4'],
  'G#sus4': ['D#3', 'G#3', 'C#4', 'D#4'],
  'G#': ['D#3', 'G#3', 'B#3', 'D#4'],
  'C#': ['E#3', 'G#3', 'C#4', 'E#4'], // the Picardy third: C# major, the sun breaking through
  // the break's colours: the relative major and two sevenths
  E: ['E3', 'G#3', 'B3', 'E4'],
  'F#m7': ['E3', 'A3', 'C#4', 'F#4'],
  'G#m7': ['F#3', 'B3', 'D#4', 'G#4'],
};
/** The sub's note of each chord (the bass of E/G# is its G#). */
const SUBR: Record<string, string> = {
  'C#m': 'C#2', B: 'B1', A: 'A1', 'E/G#': 'G#1', 'F#m': 'F#1', 'G#sus4': 'G#1', 'G#': 'G#1', 'C#': 'C#2', E: 'E2', 'F#m7': 'F#1', 'G#m7': 'G#1',
};
/** The piano's left hand: root, fifth and octave, low and open. */
const LH: Record<string, readonly string[]> = {
  'C#m': ['C#2', 'G#2', 'C#3'], B: ['B1', 'F#2', 'B2'], A: ['A1', 'E2', 'A2'], 'E/G#': ['G#1', 'E2', 'B2'], 'F#m': ['F#1', 'C#2', 'F#2'],
  'G#sus4': ['G#1', 'D#2', 'G#2'], 'G#': ['G#1', 'D#2', 'G#2'], 'C#': ['C#2', 'G#2', 'C#3'], E: ['E2', 'B2', 'E3'], 'F#m7': ['F#1', 'C#2', 'F#2'],
  'G#m7': ['G#1', 'D#2', 'G#2'],
};
/** The piano's rolling left hand: root, fifth, octave, tenth and twelfth, played up and back down in eighths (one roll a bar). */
const ROLL: Record<string, readonly string[]> = {
  'C#m': ['C#2', 'G#2', 'C#3', 'E3', 'G#3'], B: ['B1', 'F#2', 'B2', 'D#3', 'F#3'], A: ['A1', 'E2', 'A2', 'C#3', 'E3'],
  'E/G#': ['G#1', 'E2', 'B2', 'E3', 'G#3'], 'G#sus4': ['G#1', 'D#2', 'G#2', 'C#3', 'D#3'], 'G#': ['G#1', 'D#2', 'G#2', 'B#2', 'D#3'],
  'F#m': ['F#1', 'C#2', 'F#2', 'A2', 'C#3'], E: ['E2', 'B2', 'E3', 'G#3', 'B3'], 'F#m7': ['F#1', 'C#2', 'E2', 'A2', 'C#3'],
  'G#m7': ['G#1', 'D#2', 'F#2', 'B2', 'D#3'], 'C#': ['C#2', 'G#2', 'C#3', 'E#3', 'G#3'],
};
/** The galloping ostinato: one note per beat (each struck three times, x.xx), per bar of a progression. */
const GALLOP: Record<string, readonly string[]> = {
  'C#m': ['C#3', 'E3', 'G#3', 'E3'], B: ['B2', 'D#3', 'F#3', 'D#3'], A: ['A2', 'C#3', 'E3', 'C#3'], 'E/G#': ['G#2', 'B2', 'E3', 'B2'],
  'F#m': ['F#2', 'A2', 'C#3', 'A2'], 'G#sus4': ['G#2', 'C#3', 'D#3', 'C#3'], 'G#': ['G#2', 'B#2', 'D#3', 'B#2'], 'G#sus4>G#': ['G#2', 'C#3', 'B#2', 'D#3'],
};

const P1 = ['C#m', 'B', 'A', 'E/G#', 'C#m', 'B', 'A', 'G#sus4>G#']; // the hook: i VII VI III6 | i VII VI V (a lament bass, twice)
const PB = ['C#m', 'B', 'A', 'E/G#', 'F#m', 'F#m', 'G#sus4', 'G#']; // the builds: the same start, then iv and the dominant
// the break: the theme reharmonised from the relative major (every theme note still a chord tone): III VII iv7 i | III v7 iv V
const PR = ['E', 'B', 'F#m7', 'C#m', 'E', 'G#m7', 'F#m', 'G#sus4>G#'];

/** One bar of 16 steps: a note or a chord struck on a rhythm ('x' strikes, 'X' accented, '-' holds, '.' rests). */
function strike(what: string | readonly string[], rhythm: string): string {
  const r = rhythm.replace(/\s/g, '');
  const head = typeof what === 'string' ? what : `[${what.join(',')}]`;
  const out: string[] = [];
  for (let i = 0; i < r.length; ) {
    if (r[i] === 'x' || r[i] === 'X') {
      let n = 1;
      while (r[i + n] === '-') n++;
      out.push(`${head}${r[i] === 'X' ? '!' : ''}:${n}`);
      i += n;
    } else {
      out.push('.');
      i++;
    }
  }
  return out.join(' ');
}
/**
 * A progression bar by bar through a table: an entry is a chord name, or 'A>B' (two chords, half a bar each: the second is struck where
 * it begins, also when the rhythm holds across the middle of the bar); the rhythms cycle.
 */
function prog(names: readonly string[], table: Record<string, string | readonly string[]>, rhythm: string | readonly string[]): string {
  return names
    .map((name, i) => {
      const r = (typeof rhythm === 'string' ? rhythm : rhythm[i % rhythm.length]).replace(/\s/g, '');
      const [a, b] = name.split('>');
      if (b === undefined) return strike(table[a], r);
      const second = r[8] === '-' ? `x${r.slice(9)}` : r.slice(8);
      return `${strike(table[a], r.slice(0, 8))} ${strike(table[b], second)}`;
    })
    .join(' | ');
}
/** The ostinato: every beat of every bar, its note struck on the cell (default the gallop x.xx). */
function gallop(names: readonly string[], cell = 'X.xx'): string {
  return names.map((name) => GALLOP[name].map((n) => strike(n, cell)).join(' ')).join(' | ');
}

// ── melodies ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// the theme in half notes, chord tones only: it climbs E5 G#5 | F#5 D#5 | E5 A5 | G#5 E5 | E5 B5 | B5 F#5 | C#6 A5 to the
// suspension C#6 over G#sus4 and the leading tone B#5 over G#
const THEME = 'E5:8 G#5:8 | F#5:8 D#5:8 | E5:8 A5:8 | G#5:8 E5:8 | E5:8 B5:8 | B5:8 F#5:8 | C#6:8 A5:8 | C#6:8 B#5:8';
// the hook: three calls on one chanted pickup (E E E F#) reaching higher each time (G#5, A5, then G#5 B5), two falling answers, the
// climb (a scoop into C#6), the peak, and the turn back down (or, the last time, the leading tone left hanging)
const CALL1 = 'E5:2 E5:2 E5:2 F#5:2 G#5:6 E5:2';
const ANS1 = 'F#5:4 D#5:4 B4:8';
const CALL2 = 'E5:2 E5:2 E5:2 F#5:2 A5:6 E5:2';
const ANS2 = 'G#5:4 F#5:4 E5:8';
const CALL3 = 'E5:2 E5:2 E5:2 F#5:2 G#5:4 B5:4';
const CLIMB = 'B5:6 A5:2 F#5:4 G#5:2 A5:2';
const PEAK = 'C#6~:8 B5:4 A5:4';
const TURN = 'C#6:8 B#5:4 G#5:2 F#5:2';
const HANG = 'C#6:8 B#5:6 . .';
const HOOK = [CALL1, ANS1, CALL2, ANS2, CALL3, CLIMB, PEAK, TURN].join(' | ');
const HOOK_END = [CALL1, ANS1, CALL2, ANS2, CALL3, CLIMB, PEAK, HANG].join(' | ');
// the harmony: thirds, fourths and sixths below, chord tones on the beats (the chant's pickup holds C#5 under it)
const HARM = [
  'C#5:2 C#5:2 C#5:2 C#5:2 E5:6 C#5:2', 'D#5:4 B4:4 F#4:8', 'C#5:2 C#5:2 C#5:2 C#5:2 E5:6 C#5:2', 'E5:4 B4:4 G#4:8',
  'C#5:2 C#5:2 C#5:2 C#5:2 E5:4 G#5:4', 'F#5:6 F#5:2 D#5:4 D#5:2 F#5:2', 'A5:8 E5:4 C#5:4',
].join(' | ');
const HARM_HOOK = `${HARM} | G#5:8 D#5:4 B#4:2 B#4:2`;
const HARM_END = `${HARM} | G#5:8 D#5:6 . .`;
// the builds: the hook's first half, a scale up through F#m to the suspension, the leading tone, a breath
const BUILD_MEL = [CALL1, ANS1, CALL2, ANS2, 'F#5:4 G#5:4 A5:4 B5:4', 'C#6:12 B5:2 A5:2', 'C#6:16', 'B#5:8 G#5:4 . . . .'].join(' | ');
const BUILD_HARM = [HARM.split(' | ').slice(0, 4).join(' | '), 'C#5:4 E5:4 F#5:4 F#5:4', 'A5:12 F#5:2 F#5:2', 'G#5:16', 'D#5:8 B#4:4 . . . .'].join(' | ');

// ── the bass lines ───────────────────────────────────────────────────────────────────────────────────────────────────

// drop 1: a roar on each downbeat with the kick, answers where the lead holds (the second eight answers in more bars)
const GROWL_1 = [
  'C#2:4 . . . . . . . . . . . .', 'B1:4 . . . . . . B1:2 B2:2 F#2:2', 'A1:4 . . . . . . . . . . . .', 'G#1:4 . . . . . . G#1:2 B1:2 E2:2',
  'C#2:4 . . . . . . . . . . . .', 'B1:4 . . . . . . . . . . . .', 'A1:4 . . . . . . A1:2 E2:2 A2:2', 'G#1:4 . . . . G#1:4 D#2:2 G#2:2',
].join(' | ');
const GROWL_2 = [
  'C#2:4 . . . . . . C#2:2 E2:2 G#2:2', 'B1:4 . . . . . . B2:2 F#2:2 D#2:2', 'A1:4 . . . . . . A1:2 C#2:2 E2:2', 'G#1:4 . . . . . . E2:2 B1:2 G#1:2',
  'C#2:4 . . . . . . C#2:2 C#3:2 G#2:2', 'B1:4 . . . . . . . . . . . .', 'A1:4 . . . . . . A2:2 E2:2 C#2:2', 'G#1:4 . . . . G#1:2 G#2:2 D#2:2 B#1:2',
].join(' | ');
// drop 2: the roar calls on beats 1-2 (root, root, octave: 3-3-2), the talker answers after the snare (beats 3-4)
const ROAR_CALL = [
  'C#2:3 C#2:3 C#3:2 . . . . . . . .', 'B1:3 B1:3 B2:2 . . . . . . . .', 'A1:3 A1:3 A2:2 . . . . . . . .', 'G#1:3 G#1:3 G#2:2 . . . . . . . .',
  'C#2:3 C#2:3 C#3:2 . . . . . . . .', 'B1:3 B1:3 B2:2 . . . . . . . .', 'A1:3 A1:3 A2:2 . . . . . . . .', 'G#1:3 G#1:3 G#2:2 G#1:8',
].join(' | ');
const TALK_ANS = [
  '. . . . . . . . G#3:4 F#3:2 E3:2', '. . . . . . . . F#3:4 D#3:2 B2:2', '. . . . . . . . A3:4 E3:2 C#3:2', '. . . . . . . . B3:4 G#3:2 E3:2',
  '. . . . . . . . G#3:4 B3:2 C#4:2', '. . . . . . . . F#3:4 A3:2 B3:2', '. . . . . . . . E3:2 A3:2 C#4:2 E4:2', '. . . . . . . . . . . . . . . .',
].join(' | ');
// with the hook over it the talker answers only in the bars where the lead holds a long note
const TALK_ANS_2 = [
  '. . . . . . . . . . . . . . . .', '. . . . . . . . F#3:4 D#3:2 B2:2', '. . . . . . . . . . . . . . . .', '. . . . . . . . B3:4 G#3:2 E3:2',
  '. . . . . . . . . . . . . . . .', '. . . . . . . . . . . . . . . .', '. . . . . . . . E3:2 A3:2 C#4:2 E4:2', '. . . . . . . . . . . . . . . .',
].join(' | ');
// the finale: eighth notes on the roots and their octaves, leaving the double-time snare (beats 2 and 4) alone
const driveBar = (r: string, o: string): string => `${r}:2 ${r}:2 . . ${o}:2 ${r}:2 ${r}:2 . . ${o}:2`;
const DRIVE = [
  driveBar('C#2', 'C#3'), driveBar('B1', 'B2'), driveBar('A1', 'A2'), driveBar('G#1', 'G#2'),
  driveBar('C#2', 'G#2'), driveBar('B1', 'F#2'), driveBar('A1', 'E2'), 'G#1:2 G#1:2 . . G#2:2 G#1:2 G#1:2 . . D#2:2',
].join(' | ');

// ── drums (16 steps a bar) ───────────────────────────────────────────────────────────────────────────────────────────
const KICK_D1 = 'X.........x..... | X......x..x.....'; // on 1 and around the snare, never under it
const KICK_D2 = 'X......x..x..... | X.........x..x..'; // heavier: more pushes
const KICK_DT = 'X.......X.x..... | X.......X.....x.'; // double time: 1 and 3, the snare on 2 and 4
const TAIKO_LO = 'A2:4 . . A2:2 . . A2:2 . . . . | A2:4 . . A2:2 . . A2:2 . . A2 A2'; // the taiko: tom notes give the pitch
const TAIKO_HI = '. . . . . . . . A2:4 . . . . | . . . . . . . . A2:4 . A2 A2 A2';
const TAIKO_FILL = '. . . . . . . . A2:2 A2:2 A2 A2 A2 A2'; // the second half of a phrase's last bar

export default defineTrack({ id: 'storm-chaser', title: 'Storm Chaser', genre: 'Melodic dubstep', bpm: 150, bars: 116, tail: 4 }, (s) => {
  s.key('C#', 'minor');
  const S = s.sections({ intro: 8, rise: 8, build: 8, drop: 16, break: 8, trance: 8, build2: 8, drop2: 16, eye: 8, finale: 16, outro: 12 });

  const music = s.bus('music', {}); // chords, strings, piano, ostinato and arp: one filter for the transitions

  // ── drums ──
  const kick = s.kick(KICK, { gain: -6 });
  const snare = s.snare(SNARE, { gain: -6, reverb: 0.3 }); // the global sidechain is the kick's alone: the music's half-time breath is its pumps
  const clap = s.clap('big-clap', { gain: -10, reverb: 0.3, pan: 0.08 });
  const roll = s.snare({ preset: 'tight-snare', tune: 210 }, { name: 'roll', gain: -12, reverb: 0.2 });
  const hat = s.hat('closed-hat', { gain: -7.5, pan: 0.15 });
  const shaker = s.perc('shaker', { name: 'shaker', gain: -16, pan: -0.2 });
  const crash = s.cymbal('crash', { name: 'crash', gain: -11, reverb: 0.2 });
  const swell = s.cymbal('reverse-crash', { name: 'swell', gain: -13 });
  const taiko = s.tom(TAIKO, { name: 'taiko', gain: -9.5, reverb: 0.35 });
  const tomHi = s.tom(TOM_HI, { name: 'tomhi', gain: -12, reverb: 0.3, pan: 0.2 });
  // ── bass ──
  const sub = s.sub('sub-sine', { gain: -8, duck: 0.9 });
  const roar = s.growl(ROAR, { name: 'roar', gain: -4, duck: 0.7, hp: 60, eqMid: -3.5, eqMidFreq: 900 }); // a dip where the lead sings
  const talk = s.growl(TALKER, { name: 'talk', gain: -4, duck: 0.6, hp: 100 }); // stereo: kept in the centre
  const driver = s.growl(DRIVER, { name: 'driver', gain: -4, duck: 0.6, hp: 60, eqMid: -2, eqMidFreq: 1200 });
  const offBass = s.synth(OFF_BASS, { name: 'offbass', gain: -12.5, duck: 1 });
  // ── harmony and melody ──
  // the chords and strings breathe on pumps of their own (depth 0 until a section opens them): pumpH on 1 and 3 in the half-time
  // drops, pumpQ on every beat in the double-time finale (and the strings' trance lift)
  const pumps = (): ReturnType<typeof fx.pump>[] => [
    fx.pump({ name: 'pumpH', pattern: 'x.......x.......', depth: 0, release: 0.32, curve: 1.4 }),
    fx.pump({ name: 'pumpQ', pattern: 'x...x...x...x...', depth: 0, release: 0.24, curve: 1.4 }),
  ];
  const wall = s.synth(WALL, { name: 'wall', gain: -8, duck: 0.9, reverb: 0.25, hp: 150, width: 1.2, fx: pumps(), bus: 'music' });
  const strings = s.synth(STRINGS, { name: 'strings', gain: -11, duck: 0.5, reverb: 0.45, hp: 110, fx: [fx.chorus({ rate: 0.3, depth: 4 }), ...pumps()], bus: 'music' });
  const grand = s.synth(GRAND, { name: 'grand', gain: -7, reverb: 0.4, delay: 0.1, bus: 'music' });
  const spic = s.synth(SPICCATO, { name: 'spic', gain: -4, duck: 0.6, reverb: 0.25, hp: 100, bus: 'music' });
  const horn = s.synth(HORN, { name: 'horn', gain: -8, reverb: 0.4, delay: 0.15 });
  const lead = s.synth(SOAR, { name: 'lead', gain: -3.5, reverb: 0.3, delay: 0.22, duck: 0.25 });
  const harm = s.synth(SOAR_HARM, { name: 'harm', gain: -10, reverb: 0.3, delay: 0.2, duck: 0.25 });
  const tlead = s.synth(TRANCE_LEAD, { name: 'tlead', gain: -7, reverb: 0.35, delay: 0.3 });
  const arp = s.synth(TRANCE_ARP, { name: 'arp', gain: -11, delay: 0.35, duck: 0.6, bus: 'music' });
  const gpad = s.synth('supersaw-pad', { name: 'gpad', gain: -15, duck: 0.8, reverb: 0.3, hp: 200, fx: [fx.gate({ pattern: 'x.xx.xx.x.xx.xx.' })], bus: 'music' });
  const glint = s.synth(GLINT, { name: 'glint', gain: -13, reverb: 0.45, delay: 0.3 });
  // ── weather and transitions ──
  const rain = s.synth(RAIN, { name: 'rain', gain: -16, hp: 900, width: 1.4 });
  // thunder far away: hardly any pitch fall, a long rumble, low-passed and sent deep into the hall
  const thunder = s.impact({ preset: 'impact-deep', drop: 0.5, decay: 5, thump: 1.2, crack: 0.15, rumble: 1, drive: 4 }, { name: 'thunder', gain: -12, lp: 1400, reverb: 0.6 });
  const riser = s.riser('riser-dark', { name: 'riser', gain: -16 });
  const wash = s.riser('noise-wash', { name: 'wash', gain: -18 });
  const down = s.riser('downlifter', { name: 'down', gain: -15, reverb: 0.3 });
  const boom = s.impact('impact-deep', { name: 'boom', gain: -6, reverb: 0.3 });

  // ── patterns ──
  const held = 'x---------------';
  const theme = s.notes(THEME);
  const hook = s.notes(HOOK);
  const hookEnd = s.notes(HOOK_END);
  const keysHook = s.notes(HOOK.replace('~', '')); // the hook for the bell (polyphonic: no slide)
  const keysHookEnd = s.notes(HOOK_END.replace('~', ''));
  const harmHook = s.notes(HARM_HOOK);
  const harmEnd = s.notes(HARM_END);
  const buildMel = s.notes(BUILD_MEL);
  const buildHarm = s.notes(BUILD_HARM);
  const chordsP1 = s.notes(prog(P1, V, held));
  const chordsPB = s.notes(prog(PB, V, held));
  const stabsP1 = s.notes(prog(P1, V, 'x--x--x---x--x--'));
  const lhP1 = s.notes(prog(P1, LH, held));
  const subP1 = s.notes(prog(P1, SUBR, held));
  const gallopP1 = s.notes(gallop(P1));
  const gallopPB = s.notes(gallop(PB));
  // the piano's rolling left hand: up and back down each bar (a split bar rolls up twice); each note rings into the next, like the pedal
  const rollOf = (names: readonly string[]) => s.arp(s.notes(prog(names, ROLL, held)), { order: [0, 1, 2, 3, 4, 3, 2, 1], res: 2, gate: 1.9 });
  const rollP1 = rollOf(P1);

  const back = s.hits('........X.......');
  const twoFour = s.hits('....X.......X...');
  const four = s.hits('X...X...X...X...');
  const eights = s.hits('X.x.X.x.X.x.X.x.');
  const hats8 = s.hits('x.x.x.x.x.x.x.x.');
  const hats16 = s.hits('x.xgx.xgx.xgx.xg | x.xgx.xgx.xgxxxo');
  const hatsOff = s.hits('..o...o...o...o.');
  const shake16 = s.hits('x.xxx.xxx.xxx.xx');
  const fillEnd = s.hits('............x.xX'); // the last bar of an eight
  const roll8 = s.hits('3.3.4.4.5.5.6.6. | 5.5.6.6.7.7.8.8.');
  const roll16 = s.hits('6666777777888888');
  const roll32 = s.hits('999999999999999999999999........', { res: 8 }); // the last beat is the breath before the drop

  // ── the sub sits lower outside the drops ──
  sub.auto('mix.gain', [[0, -14], [S.drop.bar, -8, 'step'], [S.break.bar, -14, 'step'], [S.drop2.bar, -8, 'step'], [S.eye.bar, -14, 'step'],
    [S.finale.bar, -8, 'step'], [S.outro.bar + 1, -13, 'step']]);

  // ── the pumps open where the drums are full; meanwhile the kick's duck on the chords and strings steps down so the two do not stack
  //    (the builds keep the full kick duck: their kicks on every beat and eighth are the pump there) ──
  const open = (sec: { bar: number; end: number }, v: number): [number, number, 'step'][] => [[sec.bar, v, 'step'], [sec.end, 0, 'step']];
  wall.auto('fx.pumpH.depth', [...open(S.drop, 0.8), ...open(S.drop2, 0.8)]);
  wall.auto('fx.pumpQ.depth', open(S.finale, 0.75));
  strings.auto('fx.pumpH.depth', [...open(S.drop, 0.55), ...open(S.drop2, 0.55)]);
  strings.auto('fx.pumpQ.depth', [...open(S.trance, 0.5), ...open(S.finale, 0.55)]);
  const lighter = (base: number, light: number, secs: { bar: number; end: number }[]): [number, number, 'step'][] =>
    secs.flatMap((sec): [number, number, 'step'][] => [[sec.bar, light, 'step'], [sec.end, base, 'step']]);
  wall.auto('mix.duck', lighter(0.9, 0.3, [S.drop, S.drop2, S.finale]));
  strings.auto('mix.duck', lighter(0.5, 0.15, [S.drop, S.trance, S.drop2, S.finale]));
  // the roar's dives: a quick fifth into every note of drop 1, an octave rising over a second as it wakes in build 2, a fourth into each
  // call of drop 2
  roar.auto('pEnv', [[S.drop.bar, 7, 'step'], [S.drop.end, 0, 'step'], [S.build2.bar + 6, -12, 'step'], [S.drop2.bar, 5, 'step'], [S.drop2.end, 0, 'step']]);
  roar.auto('pEnvTime', [[S.drop.bar, 0.06, 'step'], [S.build2.bar + 6, 1, 'step'], [S.drop2.bar, 0.09, 'step']]);

  // ── intro: the storm far away; the piano states the theme, the strings come in under it ──
  rain.note(0, 'C5', 4 * 11, 0.8, FLAG.GHOST); // unpitched noise: the ghost flag keeps it out of the harmony check
  rain.auto('mix.gain', [[0, -16], [8, -16], [11, -40, 'in']]);
  thunder.hit(0.25, '', 0.7);
  thunder.hit(5, '', 0.55);
  grand.play(theme, S.intro, undefined, { vel: 0.8 });
  grand.play(rollP1, S.intro, undefined, { vel: 0.42 });
  strings.play(chordsP1, 2, 6, { vel: 0.7, from: 8 });
  strings.auto('mix.gain', [[2, -20], [8, -11, 'out']]);
  swell.note(S.rise.bar - 1, 'A3', 4, 0.7);

  // ── rise: the horn sings the theme over taiko and galloping strings; the sub and a half-time kick join at the half ──
  horn.play(theme, S.rise, undefined, { transpose: -12, vel: 0.85 });
  strings.play(chordsP1, S.rise, undefined, { vel: 0.8 });
  spic.play(gallopP1, S.rise, undefined, { vel: 0.75 });
  spic.auto('cutoff', [[S.rise.bar, 900], [S.rise.end, 1500, 'exp']]);
  grand.play(lhP1, S.rise.bar, 4, { vel: 0.4 });
  taiko.play(s.notes(TAIKO_LO), S.rise, undefined, { vel: 0.8 });
  tomHi.play(s.notes(TAIKO_HI), S.rise.bar + 4, 4, { vel: 0.7 });
  kick.play(s.hits('X.........x..... | X...............'), S.rise.bar + 4, 4, { vel: 0.65 });
  sub.play(subP1, S.rise.bar + 4, 4, { from: 16 });
  shaker.play(shake16, S.rise.bar + 4, 4, { vel: 0.45 });
  swell.note(S.build.bar - 1, 'A3', 4, 0.7);

  // ── a build: chords struck faster and faster, the lead teasing the hook through an opening filter, the roll, the risers,
  //    the breath on the last beat. No sub and a thinned kick: the low end is saved for the drop. ──
  const build = (at: number, o: { harmony?: boolean; growl?: boolean } = {}): void => {
    wall.play(s.notes(prog(PB, V, 'x---x---x---x---')), at, 4, { vel: 0.6 });
    wall.play(s.notes(prog(PB.slice(4), V, ['x-x-x-x-x-x-x-x-', 'x-x-x-x-x-x-x-x-', 'xxxxxxxxxxxxxxxx', 'xxxxxxxxxxxx....'])), at + 4, 4, { vel: 0.65 });
    wall.auto('mix.hp', [[at, 160], [at + 7.75, 900, 'exp'], [at + 8, 150, 'step']]);
    strings.play(chordsPB, at, 7.75, { vel: 0.75 });
    spic.play(gallopPB, at, 7.5, { vel: 0.7 });
    lead.play(buildMel, at, 7.75);
    lead.auto('cutoff', [[at, 1600], [at + 7.75, 6500, 'exp']]);
    lead.auto('mix.delay', [[at + 7, 0.22], [at + 7, 0.5, 'step'], [at + 8, 0.22, 'step']]); // a delay throw on the last notes
    if (o.harmony) harm.play(buildHarm, at, 7.75, { vel: 0.85 });
    kick.play(s.hits('X.........x.....'), at, 2, { vel: 0.7 });
    kick.play(four, at + 2, 4, { vel: 0.7 });
    kick.play(eights.velTo(0.7), at + 6, 1);
    kick.play(s.hits('X.x.X.x.X.x.....'), at + 7, 1, { vel: 0.7 });
    kick.auto('mix.hp', [[at, 20], [at, 180, 'step'], [at + 8, 20, 'step']]);
    clap.play(twoFour, at + 2, 4, { vel: 0.5 });
    hat.play(hats8, at, 6, { vel: 0.5 });
    taiko.play(s.notes('. . . . . . . . . . . . A2 A2 A2 A2'), at + 3, 1, { vel: 0.75 });
    roll.play(roll8, at + 4, 2, { vel: 0.7 });
    roll.play(roll16, at + 6, 1, { vel: 0.7 });
    roll.play(roll32, at + 7, 1, { vel: 0.7 });
    roll.auto('tune', [[at + 4, 200], [at + 7.75, 420, 'exp'], [at + 8, 210, 'step']]);
    riser.hit(at, '', 1, 0, 31);
    wash.hit(at + 4, '', 1, 0, 15);
    swell.note(at + 7, 'A3', 4, 1);
    music.auto('mix.lp', [[at, 2600], [at + 7.75, 20000, 'exp']]);
    if (o.growl) {
      // the beast wakes under the roll: a held G# whose wobble speeds up and whose filter opens
      roar.play(s.notes('G#1:24 . . . . . . . .'), at + 6, 2, { vel: 0.7 });
      roar.auto('lfoRate', [[at + 6, 1], [at + 6.5, 2, 'step'], [at + 7, 4, 'step'], [at + 7.5, 8, 'step'], [at + 8, 2, 'step']]);
      roar.auto('cutoff', [[at + 6, 120], [at + 7.5, 500, 'exp'], [at + 8, 380, 'step']]);
    }
  };

  // ── the drop helpers: half-time drums, the sub on the roots ──
  const beat = (at: number, bars: number, kicks: string, hats: 'eights' | 'sixteens'): void => {
    kick.play(s.hits(kicks), at, bars);
    snare.play(back, at, bars);
    clap.play(back, at, bars);
    hat.play(hats === 'eights' ? hats8 : hats16, at, bars, { vel: hats === 'eights' ? 0.7 : 0.8 });
    roll.play(fillEnd, at + bars - 1, 1, { vel: 0.75 });
    sub.play(subP1, at, bars);
  };
  // the classic speed-ups at the ends of the phrases
  const speedUps = (ch: typeof roar, at: number, base: number): void => {
    ch.auto('lfoRate', [[at, base], [at + 3.5, base * 2, 'step'], [at + 4, base, 'step'], [at + 7, base * 2, 'step'], [at + 7.5, base * 4, 'step'], [at + 8, base, 'step']]);
  };

  build(S.build.bar);

  // ── drop 1: the hook on the soaring lead, the wall of chords, the roar answering in the lead's gaps ──
  {
    const at = S.drop.bar;
    boom.hit(at, '', 1);
    crash.hit(at, '', 1);
    crash.hit(at + 8, '', 0.8);
    beat(at, 8, KICK_D1, 'eights');
    beat(at + 8, 8, KICK_D1, 'sixteens');
    roar.play(s.notes(GROWL_1), at, 8);
    roar.play(s.notes(GROWL_2), at + 8, 8);
    speedUps(roar, at, 2);
    speedUps(roar, at + 8, 2);
    wall.play(chordsP1, at, 8);
    wall.play(stabsP1, at + 8, 8);
    strings.play(chordsP1, at, 16, { vel: 0.6 });
    lead.play(hook, at, 8);
    lead.play(hookEnd, at + 8, 8);
    spic.play(gallopP1, at + 8, 8, { vel: 0.6 });
  }

  // ── break: the theme in long notes over a trance arpeggio, reharmonised from the relative major (the clouds part); the second
  //    half goes four-on-the-floor ──
  {
    const at = S.break.bar;
    const chordsPR = s.notes(prog(PR, V, held));
    down.hit(at, '', 1, 0, 8);
    crash.hit(at, '', 0.65); // the drop rings out into the calm
    grand.play(theme, at, 8, { vel: 0.82 });
    grand.play(rollOf(PR), at, 8, { vel: 0.45 });
    strings.play(chordsPR, at, 16, { vel: 0.9 });
    arp.play(s.arp(chordsPR, { order: 'up', octaves: 2, res: 4 }), at, 16, { vel: 0.7 });
    arp.auto('cutoff', [[at, 500], [at + 8, 1500, 'exp'], [at + 16, 2600, 'exp']]);
    sub.play(s.notes(prog(PR, SUBR, held)), at + 4, 4, { from: 16, vel: 0.8 });
    shaker.play(shake16, at + 4, 4, { vel: 0.35 });
    // the trance half
    const t = at + 8;
    tlead.play(theme, t, 8, { vel: 0.85 });
    kick.play(four, t, 8, { vel: 0.5 });
    kick.auto('mix.gain', [[t, -10], [t + 8, -6, 'step']]); // four kicks a bar: the fader comes down so the lift stays under build 2
    clap.play(twoFour, t, 8, { vel: 0.45 });
    hat.play(hatsOff, t, 8, { vel: 0.55 });
    shaker.play(shake16, t, 8, { vel: 0.4 });
    offBass.play(s.notes(prog(PR, SUBR, '..x-..x-..x-..x-')), t, 8, { vel: 0.85 }); // the off-beat eighths on the roots
    gpad.play(chordsPR, t, 8, { vel: 0.8 });
    roll.play(fillEnd, t + 7, 1, { vel: 0.6 });
    crash.hit(t, '', 0.7);
    riser.hit(t + 6, '', 0.8, 0, 8);
  }

  build(S.build2.bar, { harmony: true, growl: true });
  // (one octave here: over F#m the lead's passing G#5 would rub against the arp's octave layer an octave above its A4)
  arp.play(s.arp(chordsPB, { order: 'up', octaves: 1, res: 4 }), S.build2.bar, 7.75, { vel: 0.75 });

  // ── drop 2: the growl riff (the roar calls, the talker answers after the snare); then the hook returns over it, harmonised,
  //    with the glass bell an octave up ──
  {
    const at = S.drop2.bar;
    boom.hit(at, '', 1);
    crash.hit(at, '', 1);
    crash.hit(at + 8, '', 0.9);
    beat(at, 8, KICK_D2, 'sixteens');
    beat(at + 8, 8, KICK_D2, 'sixteens');
    roar.set('lfoRate', 1.333, at); // a 3-step note is one wobble
    roar.play(s.notes(ROAR_CALL), at, 16);
    roar.auto('lfoRate', [[at + 7.5, 2.667, 'step'], [at + 7.75, 5.333, 'step'], [at + 8, 1.333, 'step'], [at + 15.5, 2.667, 'step'], [at + 15.75, 5.333, 'step'], [at + 16, 2, 'step']]);
    talk.play(s.notes(TALK_ANS), at, 8);
    talk.play(s.notes(TALK_ANS_2), at + 8, 8);
    taiko.play(s.notes(TAIKO_FILL), at + 7, 1, { vel: 0.85 });
    taiko.play(s.notes(TAIKO_FILL), at + 15, 1, { vel: 0.85 });
    strings.play(chordsP1, at, 8, { vel: 0.7 });
    wall.play(s.notes(prog(P1, V, 'x-----..........')), at, 8, { vel: 0.7 }); // a stab with each call
    horn.play(theme, at, 8, { transpose: -12, vel: 0.75 }); // the horns hold the theme above the riff: heavy, still singing
    wall.play(chordsP1, at + 8, 8);
    lead.play(hookEnd, at + 8, 8);
    harm.play(harmEnd, at + 8, 8);
    glint.play(keysHookEnd, at + 8, 8, { transpose: 12, vel: 0.6 });
  }

  // ── the eye of the storm: two bars of piano and rain, then the fastest build ──
  {
    const at = S.eye.bar;
    down.hit(at, '', 1, 0, 8);
    thunder.hit(at, '', 0.8);
    rain.note(at, 'C5', 4 * 8, 0.7, FLAG.GHOST);
    grand.play(theme, at, 2, { vel: 0.6 });
    grand.play(rollP1, at, 2, { vel: 0.42 });
    strings.play(chordsPB, at, 7.75, { vel: 0.7 });
    lead.play(buildMel, at + 2, 5.75, { from: 8 });
    lead.auto('cutoff', [[at + 2, 1400], [at + 7.75, 6500, 'exp']]);
    harm.play(buildHarm, at + 2, 5.75, { from: 8, vel: 0.85 });
    spic.play(gallopPB, at + 2, 5.5, { from: 8, vel: 0.75 });
    taiko.play(s.notes(TAIKO_LO), at + 2, 4, { vel: 0.8 });
    wall.play(s.notes(prog(PB.slice(4), V, ['x-x-x-x-x-x-x-x-', 'x-x-x-x-x-x-x-x-', 'xxxxxxxxxxxxxxxx', 'xxxxxxxxxxxx....'])), at + 4, 4, { vel: 0.65 });
    wall.auto('mix.hp', [[at + 4, 160], [at + 7.75, 900, 'exp'], [at + 8, 150, 'step']]);
    kick.play(four, at + 4, 2, { vel: 0.7 });
    kick.play(eights.velTo(0.7), at + 6, 1);
    kick.play(s.hits('X.x.X.x.X.x.....'), at + 7, 1, { vel: 0.7 });
    kick.auto('mix.hp', [[at + 4, 180], [at + 8, 20, 'step']]);
    clap.play(twoFour, at + 4, 2, { vel: 0.5 });
    roll.play(roll8.slice(4, 8), at + 5, 1, { vel: 0.7 });
    roll.play(roll16, at + 6, 1, { vel: 0.7 });
    roll.play(roll32, at + 7, 1, { vel: 0.7 });
    roll.auto('tune', [[at + 5, 200], [at + 7.75, 420, 'exp'], [at + 8, 210, 'step']]);
    riser.hit(at + 2, '', 1, 0, 23);
    wash.hit(at + 4, '', 1, 0, 15);
    swell.note(at + 7, 'A3', 4, 1);
    music.auto('mix.lp', [[at, 3000], [at + 2, 3000], [at + 7.75, 20000, 'exp']]);
  }

  // ── finale: the drums switch to double time; the driver growl in eighths, the hook's last statement harmonised, the bell an
  //    octave up, the gallop under it all ──
  {
    const at = S.finale.bar;
    boom.hit(at, '', 1);
    crash.hit(at, '', 1);
    crash.hit(at + 8, '', 0.9);
    const last = 15.75; // everything with a beat stops a beat early: the breath before the last hit
    kick.play(s.hits(KICK_DT), at, last);
    snare.play(twoFour, at, last);
    clap.play(twoFour, at, last);
    hat.play(hats8, at, last, { vel: 0.75 });
    shaker.play(shake16, at, last, { vel: 0.5 });
    roll.play(fillEnd, at + 7, 1, { vel: 0.75 });
    roll.play(s.hits('x.x.x.xxxxxxXXXX'), at + 15, 0.75, { vel: 0.75 });
    taiko.play(s.notes(TAIKO_FILL), at + 7, 1, { vel: 0.85 });
    taiko.play(s.notes(TAIKO_FILL), at + 15, 0.75, { vel: 0.9 });
    sub.play(subP1, at, last);
    driver.play(s.notes(DRIVE), at, last);
    wall.play(stabsP1, at, last);
    strings.play(chordsP1, at, last, { vel: 0.65 });
    spic.play(gallopP1, at, last, { vel: 0.65 });
    lead.play(hook, at, 8);
    lead.play(hookEnd, at + 8, 8);
    harm.play(harmHook, at, 8);
    harm.play(harmEnd, at + 8, 8);
    glint.play(keysHook, at, 8, { transpose: 12, vel: 0.6 });
    glint.play(keysHookEnd, at + 8, 8, { transpose: 12, vel: 0.6 });
    swell.note(at + 15, 'A3', 4, 0.9);
  }

  // ── outro: the last hit resolves the leading tone; then the piano sings the theme once more in the rain, and the storm ends in C# major ──
  {
    const at = S.outro.bar;
    boom.hit(at, '', 1);
    crash.hit(at, '', 1);
    wall.play(s.notes(`[${V['C#m'].join(',')}]:16`), at, 1);
    lead.note(at, 'C#6', 4, 0.9);
    sub.note(at, 'C#2', 4, 0.9);
    rain.note(at + 1, 'C5', 4 * 11, 0.7, FLAG.GHOST);
    rain.auto('mix.gain', [[at + 1, -18], [at + 8, -18], [at + 12, -40, 'in']]);
    thunder.hit(at + 5, '', 0.45);
    const t = at + 1;
    grand.play(s.notes(THEME), t, 8, { vel: 0.66 });
    grand.play(rollP1, t, 8, { vel: 0.42 });
    strings.play(chordsP1, t, 8, { vel: 0.7 });
    sub.play(s.notes(prog(P1, SUBR, held)), t, 8, { vel: 0.7 });
    const fin = t + 8; // the last three bars: C# major, rolled on the piano, the strings and the bell holding it
    grand.play(s.notes('[C#2,G#2,C#3,E#3,G#3,C#4,E#4,G#4,C#5]:48').strum(0.08), fin, 3, { vel: 0.6 });
    strings.play(s.notes(`[${V['C#'].join(',')}]:48`), fin, 3, { vel: 0.75 });
    sub.play(s.notes('C#2:48'), fin, 3, { vel: 0.6 });
    glint.note(fin, 'C#6', 8, 0.5);
    glint.note(fin + 0.5, 'G#5', 6, 0.4);
  }

  // ── the music bus: half closed at the start, opening through the intro and the rise; each build closes and sweeps it ──
  music.auto('mix.lp', [[0, 3000], [S.intro.end, 9000, 'exp'], [S.rise.end, 20000, 'exp']]);

  s.setReverb({ time: 3.6, preDelay: 0.03, return: -9, lowCut: 220, highCut: 7500 });
  s.setDelay({ time: '1/8.', feedback: 0.35, return: -11 });
  s.setSidechain({ release: 0.28, curve: 1.5 });
  s.setMaster({ trim: 4.7, highShelf: 1.5 }); // the trim found with the probe's AUTOTRIM=1; a little air on top
});
