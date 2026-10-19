/**
 * Music theory helpers for composers: note names, scales and keys, chord symbols and voicings.
 *
 * Conventions: MIDI note numbers, middle C = C4 = 60, A4 = 69 = 440 Hz. Octave numbers are scientific pitch notation
 * (a bass guitar's open E string is E1 = 28, a guitar's lowest string E2 = 40).
 */

const LETTER: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Pitch class (0 = C .. 11 = B) of a note letter with optional # / b: 'F#' = 6, 'Bb' = 10, 'e' = 4. */
export function pitchClass(s: string): number {
  const m = /^([A-Ga-g])([#b]?)$/.exec(s.trim());
  if (!m) throw new Error(`bad pitch class "${s}" (expected a letter A-G with an optional # or b, e.g. "F#" or "Bb")`);
  return (LETTER[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
}

/** MIDI number of a note name with octave: 'A4' = 69, 'C#3' = 49, 'Bb1' = 34, 'C-1' = 0. */
export function noteToMidi(s: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(s.trim());
  if (!m) throw new Error(`bad note name "${s}" (expected e.g. "A2", "C#3", "Bb1")`);
  return LETTER[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12 * (parseInt(m[3], 10) + 1);
}

/** Accepts a note name or a MIDI number. */
export function toMidi(n: string | number): number {
  return typeof n === 'number' ? n : noteToMidi(n);
}

export function midiToName(m: number, flats = false): string {
  const r = Math.round(m);
  return (flats ? FLAT_NAMES : SHARP_NAMES)[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
}

/** Scale interval tables (semitones above the tonic). */
export const SCALES: Record<string, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  'harmonic minor': [0, 2, 3, 5, 7, 8, 11],
  'melodic minor': [0, 2, 3, 5, 7, 9, 11],
  'phrygian dominant': [0, 1, 4, 5, 7, 8, 10],
  'double harmonic': [0, 1, 4, 5, 7, 8, 11],
  'hungarian minor': [0, 2, 3, 6, 7, 8, 11],
  'whole tone': [0, 2, 4, 6, 8, 10],
  'pentatonic major': [0, 2, 4, 7, 9],
  'pentatonic minor': [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const SCALE_ALIASES: Record<string, string> = {
  ionian: 'major',
  aeolian: 'minor',
  'natural minor': 'minor',
  'harmonic': 'harmonic minor',
  'melodic': 'melodic minor',
  spanish: 'phrygian dominant',
  hijaz: 'phrygian dominant',
  freygish: 'phrygian dominant',
  'phrygian-dominant': 'phrygian dominant',
  arabic: 'double harmonic',
  byzantine: 'double harmonic',
  'minor pentatonic': 'pentatonic minor',
  'major pentatonic': 'pentatonic major',
};

export function scaleIntervals(name: string): readonly number[] {
  const k = name.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  const key = SCALE_ALIASES[k] ?? k;
  const s = SCALES[key];
  if (!s) throw new Error(`unknown scale "${name}". Known: ${Object.keys(SCALES).join(', ')} (aliases: ${Object.keys(SCALE_ALIASES).join(', ')})`);
  return s;
}

/** A key (tonic + scale) with degree and chord helpers. */
export class Key {
  readonly tonic: number;
  readonly scale: string;
  readonly intervals: readonly number[];
  constructor(tonic: string | number, scale: string) {
    this.tonic = typeof tonic === 'number' ? ((tonic % 12) + 12) % 12 : pitchClass(tonic);
    this.scale = scale;
    this.intervals = scaleIntervals(scale);
  }
  /**
   * MIDI note of scale degree `deg` (1 = tonic, 2 = second ..., 8 = the tonic an octave up, 0 / -1 = below the tonic) with the
   * tonic of the lowest octave at octave number `octave`. `accidental` raises (+1) or lowers (-1) the note chromatically.
   */
  degree(deg: number, octave = 3, accidental = 0): number {
    const n = this.intervals.length;
    const i = deg - 1;
    const oct = Math.floor(i / n);
    const idx = ((i % n) + n) % n;
    return this.tonic + 12 * (octave + 1 + oct) + this.intervals[idx] + accidental;
  }
  /** Whether the MIDI note belongs to the scale (any octave). */
  has(midi: number): boolean {
    const pc = (((Math.round(midi) - this.tonic) % 12) + 12) % 12;
    return this.intervals.includes(pc);
  }
  /** Nearest scale tone (ties go down). */
  snap(midi: number): number {
    for (let d = 0; d < 12; d++) {
      if (this.has(midi - d)) return Math.round(midi) - d;
      if (this.has(midi + d)) return Math.round(midi) + d;
    }
    return midi;
  }
  /** Diatonic chord on degree `deg` built from stacked scale thirds (size 3 = triad, 4 = seventh, 5 = ninth). MIDI notes. */
  chord(deg: number, size = 3, octave = 3): number[] {
    const out: number[] = [];
    for (let k = 0; k < size; k++) out.push(this.degree(deg + 2 * k, octave));
    return out;
  }
  /** Chord symbol of the diatonic chord on `deg` ('Am', 'F', 'G7', 'Bdim' ...). Works for 7-note scales. */
  chordSymbol(deg: number, size = 3): string {
    const notes = this.chord(deg, Math.max(size, 3), 3);
    const root = notes[0];
    const iv = notes.map((n) => n - root);
    const name = SHARP_NAMES[((root % 12) + 12) % 12];
    const key = iv.slice(0, size).join(',');
    const table: Record<string, string> = {
      '0,4,7': '',
      '0,3,7': 'm',
      '0,3,6': 'dim',
      '0,4,8': 'aug',
      '0,4,7,11': 'maj7',
      '0,4,7,10': '7',
      '0,3,7,10': 'm7',
      '0,3,6,10': 'm7b5',
      '0,3,6,9': 'dim7',
      '0,3,7,11': 'mMaj7',
      '0,4,8,11': 'maj7#5',
      '0,4,8,10': '7#5',
    };
    return name + (table[key] ?? '');
  }
}

// ── chords ───────────────────────────────────────────────────────────────────

export interface ChordInfo {
  symbol: string;
  /** Root pitch class. */
  root: number;
  /** Bass pitch class for slash chords, else null. */
  bass: number | null;
  /** Semitones above the root (may exceed 12 for 9ths, 11ths, 13ths). */
  intervals: number[];
}

/**
 * Parses a chord symbol: root, quality, extensions, alterations, optional slash bass.
 * Examples: 'Am', 'F#m7', 'Cmaj7', 'G7', 'Bdim', 'Dsus4', 'E5' (power chord), 'Am9', 'C/E', 'Gadd9', 'D7b9', 'Fmaj7#11', 'Ebm7b5'.
 */
export function parseChord(symbol: string): ChordInfo {
  const m = /^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(symbol.trim());
  if (!m) throw new Error(`bad chord symbol "${symbol}" (examples: Am, F#m7, Cmaj7, G7, Bdim, Dsus4, E5, Am9, C/E)`);
  const root = pitchClass(m[1]);
  const bass = m[3] ? pitchClass(m[3]) : null;
  let rest = m[2];
  let third: number | null = 4;
  let fifth: number | null = 7;
  let seventh: number | null = null;
  let major7 = false;
  const extra: number[] = [];
  const consume = (re: RegExp): RegExpExecArray | null => {
    const mm = re.exec(rest);
    if (mm) rest = rest.slice(mm[0].length);
    return mm;
  };
  let dim = false;
  let first = true;
  while (rest.length) {
    let mm: RegExpExecArray | null;
    if ((mm = consume(/^(maj|Maj|M(?!inor))(?=\d|$|[#b(])/))) {
      major7 = true;
      if (/^\d/.test(rest) === false && first) {
        // 'Cmaj' alone is just a major triad
        major7 = false;
      }
    } else if ((mm = consume(/^(min|m(?!aj)|-)/))) third = 3;
    else if ((mm = consume(/^(dim|o(?![a-z]))/))) {
      third = 3;
      fifth = 6;
      dim = true;
    } else if ((mm = consume(/^(aug|\+)/))) fifth = 8;
    else if ((mm = consume(/^ø/))) {
      third = 3;
      fifth = 6;
      seventh = 10;
    } else if ((mm = consume(/^sus2/))) third = 2;
    else if ((mm = consume(/^sus4|^sus/))) third = 5;
    else if ((mm = consume(/^add(9|11|13)/))) extra.push(mm[1] === '9' ? 14 : mm[1] === '11' ? 17 : 21);
    else if ((mm = consume(/^13/))) {
      seventh = major7 ? 11 : 10;
      extra.push(14, 21);
    } else if ((mm = consume(/^11/))) {
      seventh = major7 ? 11 : 10;
      extra.push(14, 17);
    } else if ((mm = consume(/^9/))) {
      seventh = major7 ? 11 : 10;
      extra.push(14);
    } else if ((mm = consume(/^7/))) seventh = dim ? 9 : major7 ? 11 : 10;
    else if ((mm = consume(/^6/))) extra.push(9);
    else if ((mm = consume(/^5/))) {
      third = null;
    } else if ((mm = consume(/^b5/))) fifth = 6;
    else if ((mm = consume(/^#5/))) fifth = 8;
    else if ((mm = consume(/^b9/))) extra.push(13);
    else if ((mm = consume(/^#9/))) extra.push(15);
    else if ((mm = consume(/^#11/))) extra.push(18);
    else if ((mm = consume(/^b13/))) extra.push(20);
    else if ((mm = consume(/^[()]/))) {
      // grouping parentheses are ignored: 'C7(b9)'
    } else throw new Error(`cannot parse chord "${symbol}" at "${rest}" (examples: Am, F#m7, Cmaj7, G7, Bdim, Dsus4, E5, Am9, C/E, D7b9)`);
    first = false;
  }
  const iv: number[] = [0];
  if (third !== null) iv.push(third);
  if (fifth !== null) iv.push(fifth);
  if (seventh !== null) iv.push(seventh);
  for (const e of extra) iv.push(e);
  iv.sort((a, b) => a - b);
  return { symbol: symbol.trim(), root, bass, intervals: [...new Set(iv)] };
}

export interface VoicingOpts {
  /** Octave of the root of the lowest chord note (default 3: a root of C is C3 = 48). */
  octave?: number;
  /** Inversion (0 = root position, 1 = first inversion ...). */
  inversion?: number;
  /** 'close' (default), 'open' (every second note an octave up), 'drop2' (second-highest note an octave down), 'wide' (root + fifth low, the rest above), 'power' (root, fifth, octave). */
  spread?: 'close' | 'open' | 'drop2' | 'wide' | 'power';
  /** Adds the bass note (the slash bass or the root) this many octaves below the voicing: true = 1 octave below the root. */
  bass?: boolean | number;
  /** Keeps the whole voicing inside [lo, hi] MIDI by shifting it in octaves (the best fit wins). */
  range?: [number, number];
  /** Extra chord notes to add (semitones above the root). */
  add?: number[];
}

/** MIDI notes of a chord voicing, lowest first. */
export function voiceChord(c: ChordInfo, o: VoicingOpts = {}): number[] {
  const oct = o.octave ?? 3;
  const rootMidi = c.root + 12 * (oct + 1);
  let notes = c.intervals.map((i) => rootMidi + i);
  if (o.add) notes.push(...o.add.map((i) => rootMidi + i));
  notes.sort((a, b) => a - b);
  if (o.spread === 'power' || (c.intervals.length === 2 && c.intervals[1] === 7 && o.spread === undefined)) {
    notes = [rootMidi, rootMidi + 7, rootMidi + 12];
  }
  const inv = o.inversion ?? 0;
  for (let k = 0; k < inv; k++) {
    const lowest = notes.shift() as number;
    notes.push(lowest + 12);
  }
  if (o.spread === 'open') {
    notes = notes.map((n, i) => (i % 2 === 1 ? n + 12 : n)).sort((a, b) => a - b);
  } else if (o.spread === 'drop2' && notes.length >= 3) {
    const i = notes.length - 2;
    notes[i] -= 12;
    notes.sort((a, b) => a - b);
  } else if (o.spread === 'wide' && notes.length >= 3) {
    const low = [notes[0], notes[0] + 7 > notes[notes.length - 1] ? notes[1] : notes[0] + 7];
    const rest = notes.filter((n) => !low.includes(n)).map((n) => (n < low[1] ? n + 12 : n));
    notes = [...low, ...rest].sort((a, b) => a - b);
  }
  if (o.range) {
    const [lo, hi] = o.range;
    let best = notes;
    let bestScore = Infinity;
    for (let sft = -4; sft <= 4; sft++) {
      const t = notes.map((n) => n + 12 * sft);
      const over = Math.max(0, Math.max(...t) - hi) + Math.max(0, lo - Math.min(...t));
      const score = over * 100 + Math.abs(sft);
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    notes = best;
  }
  if (o.bass) {
    const bassPc = c.bass ?? c.root;
    const octs = typeof o.bass === 'number' ? o.bass : 1;
    let b = bassPc + 12 * (oct + 1) - 12 * octs;
    while (b >= notes[0] - 0 && b > 0) b -= 12;
    notes.unshift(b);
  }
  return notes;
}

/** Picks, for a chord, the inversion / octave closest to the previous voicing (smooth voice leading). */
export function voiceLead(prev: number[] | null, c: ChordInfo, o: VoicingOpts = {}): number[] {
  const base = voiceChord(c, { ...o, bass: false, inversion: 0 });
  if (!prev) return voiceChord(c, o);
  const n = base.length;
  let best: number[] = base;
  let bestCost = Infinity;
  const centre = prev.reduce((a, b) => a + b, 0) / prev.length;
  for (let inv = 0; inv < n; inv++) {
    for (let sft = -2; sft <= 2; sft++) {
      let t = base.slice();
      for (let k = 0; k < inv; k++) t.push((t.shift() as number) + 12);
      t = t.map((x) => x + 12 * sft);
      const mean = t.reduce((a, b) => a + b, 0) / t.length;
      let cost = Math.abs(mean - centre) * 2;
      const m = Math.min(t.length, prev.length);
      for (let i = 0; i < m; i++) cost += Math.abs(t[t.length - 1 - i] - prev[prev.length - 1 - i]);
      if (o.range) {
        cost += 20 * (Math.max(0, Math.max(...t) - o.range[1]) + Math.max(0, o.range[0] - Math.min(...t)));
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = t;
      }
    }
  }
  if (o.bass) {
    const bassPc = c.bass ?? c.root;
    const octs = typeof o.bass === 'number' ? o.bass : 1;
    let b = bassPc + 12 * ((o.octave ?? 3) + 1) - 12 * octs;
    while (b >= best[0] && b > 0) b -= 12;
    best = [b, ...best];
  }
  return best;
}
