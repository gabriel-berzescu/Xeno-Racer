/**
 * Patterns: the notes and hits of a clip, positioned in beats, with the step-grid text notation the composers write and a set
 * of transforms (transpose, reverse, arpeggiate, re-rhythm ...). Everything is plain data; `Channel.play` places patterns on the
 * timeline.
 */
import { Rng } from './dsp/core';
import { FLAG, checkKeys, pickWord } from './instrument';
import { ChordInfo, Key, VoicingOpts, midiToName, noteToMidi, parseChord, voiceChord, voiceLead } from './theory';

/** One note or hit. Times are in beats (quarter notes) from the start of the pattern. */
export interface PEvt {
  t: number;
  /** Length in beats. */
  d: number;
  /** MIDI note (notes) or 0 (drum hits). */
  n: number;
  /** Velocity 0..1. */
  v: number;
  /** FLAG bits. */
  f: number;
  /** Drum part name ('' for notes). */
  part: string;
}

export interface ChordSeg {
  t: number;
  d: number;
  chord: ChordInfo;
  notes: number[];
}

export interface ParseCtx {
  barBeats: number;
  key: Key | null;
}

const NOTE_RE = '[A-Ga-g][#b]?\\d';
const PITCH_RE = new RegExp(`^(\\[${NOTE_RE}(?:,${NOTE_RE})*\\]|${NOTE_RE}|\\d{1,2}|[b#]\\d{1,2})`);
const MOD_RE = /^(?:([!?~'])|:(\d+(?:\.\d+)?)|@(\d+(?:\.\d+)?)|\{([^}]*)\})/;

/** Splits a note token into its pitch part and its modifiers, in any order; null when the token is not valid. */
function splitToken(tok: string): { pitch: string; marks: string; len: string | undefined; vel: string | undefined; art: string | undefined } | null {
  const pm = PITCH_RE.exec(tok);
  if (!pm) return null;
  let rest = tok.slice(pm[0].length);
  let marks = '';
  let len: string | undefined;
  let vel: string | undefined;
  let art: string | undefined;
  while (rest.length) {
    const m = MOD_RE.exec(rest);
    if (!m) return null;
    if (m[1]) marks += m[1];
    else if (m[2] !== undefined) len = m[2];
    else if (m[3] !== undefined) vel = m[3];
    else if (m[4] !== undefined) art = art ? `${art},${m[4]}` : m[4];
    rest = rest.slice(m[0].length);
  }
  return { pitch: pm[1], marks, len, vel, art };
}

const ART: Record<string, number> = {
  pm: FLAG.MUTE,
  mute: FLAG.MUTE,
  palm: FLAG.MUTE,
  ring: FLAG.RING,
  up: FLAG.UP,
  down: 0,
  open: FLAG.OPEN,
  rim: FLAG.RIM,
  flam: FLAG.FLAM,
  ghost: FLAG.GHOST,
  accent: FLAG.ACCENT,
  slide: FLAG.SLIDE,
  stac: FLAG.STACCATO,
  staccato: FLAG.STACCATO,
};

/** Articulation names accepted in `{...}` and in the `art` option, as flag bits. */
export function articulation(names: string | readonly string[]): number {
  const list = typeof names === 'string' ? names.split(/[\s,]+/).filter(Boolean) : names;
  let f = 0;
  for (const n of list) {
    const b = ART[n.toLowerCase()];
    if (b === undefined) throw new Error(`unknown articulation "${n}". Known: ${Object.keys(ART).join(', ')}`);
    f |= b;
  }
  return f;
}

function velOf(s: string): number {
  const v = parseFloat(s);
  return v > 1 ? Math.min(1, v / 127) : v;
}

export interface NoteParseOpts {
  /** Steps per beat: 4 = sixteenth notes (default), 2 = eighths, 8 = thirty-seconds, 3 = eighth-note triplets, 6 = sixteenth triplets. */
  res?: number;
  /** Default velocity 0..1 (default 0.8). */
  vel?: number;
  /** Gate: fraction of a step a note sounds (the rest is a small gap before the next note). Default 0.9. */
  gate?: number;
  /** Articulation(s) applied to every note: 'pm', 'ring', ... */
  art?: string | readonly string[];
  /** Octave of the tonic for s.degrees() (default 3). */
  oct?: number;
  /** Allow a length that is not a whole number of beats, and bars of another length. */
  free?: boolean;
}

/** 1st, 2nd, 3rd, 4th ... (the bars of a pattern are named like this in errors: the song's own bars count from 0, which would confuse). */
function ordinal(n: number): string {
  const t = n % 100;
  return `${n}${t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

function barSplit(text: string, label: string): string[][] {
  // bars separated by '|', tokens by whitespace; brackets keep their commas together
  const t = text.replace(/\[[^\]]*\]/g, (m) => m.replace(/\s+/g, ''));
  const groups = t.split('|').map((b) => b.trim().split(/\s+/).filter(Boolean));
  while (groups.length && groups[0].length === 0) groups.shift();
  while (groups.length && groups[groups.length - 1].length === 0) groups.pop();
  groups.forEach((g, i) => {
    if (g.length === 0) throw new Error(`${label}: the ${ordinal(i + 1)} bar is empty (two | in a row)`);
  });
  return groups;
}

function checkBars(label: string, stepCounts: number[], res: number, barBeats: number, free: boolean): void {
  if (stepCounts.length < 2 || free) return;
  const perBar = res * barBeats;
  stepCounts.forEach((c, i) => {
    if (Math.abs(c - perBar) > 1e-9) {
      throw new Error(
        `${label}: the ${ordinal(i + 1)} bar has ${c} steps but a bar at ${res} steps per beat needs ${perBar} (${barBeats} beats). ` +
          `Count the steps between the | marks, or pass { free: true } for odd-length patterns.`,
      );
    }
  });
}

function lenCheck(label: string, steps: number, res: number, barBeats: number, free: boolean): void {
  if (free) return;
  const beats = steps / res;
  const bars = beats / barBeats;
  if (Math.abs(beats - Math.round(beats)) > 1e-9 && Math.abs(bars - Math.round(bars)) > 1e-9) {
    throw new Error(`${label}: ${steps} steps at ${res} steps per beat is ${beats} beats, not a whole number of beats. Add or remove steps, or pass { free: true }.`);
  }
}

export class Pattern {
  readonly events: PEvt[];
  /** Length in beats. */
  readonly beats: number;
  /** Chord segments when the pattern was made from chord symbols (used by arp / roots / rhythm). */
  readonly chords: ChordSeg[] | null;
  /** Length of one step of the grid the pattern was written on, in beats (0.25 = sixteenths): `rev()` mirrors on it. */
  readonly grid: number;
  constructor(events: PEvt[], beats: number, chords: ChordSeg[] | null = null, grid = 0.25) {
    this.events = events.slice().sort((a, b) => a.t - b.t || a.n - b.n);
    this.beats = beats;
    this.chords = chords;
    this.grid = grid;
  }
  static empty(beats: number): Pattern {
    return new Pattern([], beats);
  }

  // ── transforms (each returns a new pattern) ────────────────────────────────

  private with(events: PEvt[], beats = this.beats, chords: ChordSeg[] | null = this.chords): Pattern {
    return new Pattern(events, beats, chords, this.grid);
  }
  map(fn: (e: PEvt, i: number) => PEvt | null): Pattern {
    const out: PEvt[] = [];
    this.events.forEach((e, i) => {
      const r = fn({ ...e }, i);
      if (r) out.push(r);
    });
    return this.with(out);
  }
  /** Transposes every note by `semitones` (fractions allowed). */
  transpose(semitones: number): Pattern {
    return new Pattern(
      this.events.map((e) => ({ ...e, n: e.n + semitones })),
      this.beats,
      this.chords ? this.chords.map((c) => ({ ...c, notes: c.notes.map((n) => n + semitones) })) : null,
      this.grid,
    );
  }
  /** Moves every note up (or down) whole octaves. */
  octave(n: number): Pattern {
    return this.transpose(12 * n);
  }
  /** Multiplies every velocity by `f` (a number) or sets it from a function of the event. */
  vel(f: number | ((e: PEvt, i: number) => number)): Pattern {
    return this.map((e, i) => ({ ...e, v: Math.max(0, Math.min(1, typeof f === 'number' ? e.v * f : f(e, i))) }));
  }
  /** Sets every velocity to exactly `v`. */
  velTo(v: number): Pattern {
    return this.map((e) => ({ ...e, v }));
  }
  /** Rotates the pattern in time by `beats` (events that fall off the end wrap around to the start). */
  rotate(beats: number): Pattern {
    const out = this.events.map((e) => {
      let t = (e.t + beats) % this.beats;
      if (t < 0) t += this.beats;
      return { ...e, t };
    });
    return this.with(out, this.beats, null);
  }
  /**
   * Reverses the pattern in time. Hits and notes that start on the step grid are mirrored by whole steps (so a reversed
   * sixteenth-note line stays exactly on the grid, and a reversed drum lane keeps its hits on their steps).
   */
  rev(): Pattern {
    const g = this.grid;
    const span = (e: PEvt): number => {
      if (e.part !== '') return g;
      const onGrid = Math.abs(e.t / g - Math.round(e.t / g)) < 1e-6;
      return onGrid ? Math.max(g, Math.ceil(e.d / g - 1e-6) * g) : e.d;
    };
    const out = this.events.map((e) => ({ ...e, t: Math.max(0, this.beats - e.t - span(e)) }));
    const chords = this.chords ? this.chords.map((c) => ({ ...c, t: Math.max(0, this.beats - c.t - c.d) })).sort((a, b) => a.t - b.t) : null;
    return this.with(out, this.beats, chords);
  }
  /** Repeats the pattern `n` times back to back. */
  repeat(n: number): Pattern {
    return Pattern.concat(Array.from({ length: n }, () => this));
  }
  /** This pattern followed by the others. */
  then(...others: Pattern[]): Pattern {
    return Pattern.concat([this, ...others]);
  }
  static concat(list: readonly Pattern[]): Pattern {
    const out: PEvt[] = [];
    const chords: ChordSeg[] = [];
    let t0 = 0;
    let grid = Infinity;
    for (const p of list) {
      for (const e of p.events) out.push({ ...e, t: e.t + t0 });
      if (p.chords) for (const c of p.chords) chords.push({ ...c, t: c.t + t0 });
      t0 += p.beats;
      grid = Math.min(grid, p.grid);
    }
    return new Pattern(out, t0, chords.length ? chords : null, Number.isFinite(grid) ? grid : 0.25);
  }
  /** Layers patterns on top of each other (the result is as long as the longest). */
  static layer(...list: Pattern[]): Pattern {
    const out: PEvt[] = [];
    let beats = 0;
    let grid = Infinity;
    for (const p of list) {
      out.push(...p.events.map((e) => ({ ...e })));
      beats = Math.max(beats, p.beats);
      grid = Math.min(grid, p.grid);
    }
    return new Pattern(out, beats, list.find((p) => p.chords)?.chords ?? null, Number.isFinite(grid) ? grid : 0.25);
  }
  /** Layers `others` on top of this pattern. */
  and(...others: Pattern[]): Pattern {
    return Pattern.layer(this, ...others);
  }
  /** Loops or trims the pattern to exactly `beats` (notes crossing the end are shortened). */
  over(beats: number): Pattern {
    if (!(this.beats > 0)) throw new Error('over(): cannot loop a pattern that is 0 beats long');
    if (!(beats > 0)) throw new Error(`over(): the length must be positive (got ${beats})`);
    const out: PEvt[] = [];
    const chords: ChordSeg[] = [];
    for (let t0 = 0; t0 < beats - 1e-9; t0 += this.beats) {
      for (const e of this.events) {
        const t = e.t + t0;
        if (t >= beats - 1e-9) continue;
        out.push({ ...e, t, d: Math.min(e.d, beats - t) });
      }
      if (this.chords) for (const c of this.chords) if (c.t + t0 < beats - 1e-9) chords.push({ ...c, t: c.t + t0, d: Math.min(c.d, beats - c.t - t0) });
    }
    return new Pattern(out, beats, chords.length ? chords : null, this.grid);
  }
  /** The part between `from` and `to` beats (event times shift so the slice starts at 0). */
  slice(from: number, to: number): Pattern {
    if (!(to > from)) throw new Error(`slice(${from}, ${to}): the end must be after the start`);
    const out: PEvt[] = [];
    for (const e of this.events) {
      if (e.t >= from - 1e-9 && e.t < to - 1e-9) out.push({ ...e, t: e.t - from, d: Math.min(e.d, to - e.t) });
    }
    return new Pattern(out, to - from, null, this.grid);
  }
  /** Scales every note length by `g` (a staccato / legato control). */
  gate(g: number): Pattern {
    return this.map((e) => ({ ...e, d: e.d * g }));
  }
  /** Each note lasts until the next onset (or the end of the pattern), minus an optional gap in beats. */
  legato(gap = 0): Pattern {
    const onsets = [...new Set(this.events.map((e) => e.t))].sort((a, b) => a - b);
    return this.map((e) => {
      const next = onsets.find((t) => t > e.t + 1e-9);
      return { ...e, d: Math.max(0.01, (next ?? this.beats) - e.t - gap) };
    });
  }
  /** Adds articulation flags to every event: `p.art('pm')`. */
  art(names: string | readonly string[]): Pattern {
    const f = articulation(names);
    return this.map((e) => ({ ...e, f: e.f | f }));
  }
  /** Keeps only the given drum parts. */
  only(...parts: string[]): Pattern {
    return this.with(this.events.filter((e) => parts.includes(e.part)).map((e) => ({ ...e })));
  }
  /** Drops the given drum parts. */
  without(...parts: string[]): Pattern {
    return this.with(this.events.filter((e) => !parts.includes(e.part)).map((e) => ({ ...e })));
  }
  /** Renames drum parts: `p.rename({ hat: 'hatC' })`. */
  rename(map: Record<string, string>): Pattern {
    return this.map((e) => ({ ...e, part: map[e.part] ?? e.part }));
  }
  /** Stretches time: `scaleTime(0.5)` plays the pattern twice as fast (and half as long). */
  scaleTime(f: number): Pattern {
    return new Pattern(
      this.events.map((e) => ({ ...e, t: e.t * f, d: e.d * f })),
      this.beats * f,
      this.chords ? this.chords.map((c) => ({ ...c, t: c.t * f, d: c.d * f })) : null,
      this.grid * f,
    );
  }
  /** Keeps the events for which `fn` is true. */
  filter(fn: (e: PEvt, i: number) => boolean): Pattern {
    return this.with(this.events.filter(fn).map((e) => ({ ...e })));
  }
  /** Adds `offsetBeats` between the notes of every chord (a strum); `up` reverses the direction (high strings first). */
  strum(offsetBeats: number, up = false): Pattern {
    const groups = new Map<number, PEvt[]>();
    for (const e of this.events) {
      const k = Math.round(e.t * 1e6);
      const g = groups.get(k) ?? [];
      g.push(e);
      groups.set(k, g);
    }
    const out: PEvt[] = [];
    for (const g of groups.values()) {
      const sorted = g.slice().sort((a, b) => (up ? b.n - a.n : a.n - b.n));
      sorted.forEach((e, i) => out.push({ ...e, t: e.t + i * offsetBeats, d: Math.max(0.01, e.d - i * offsetBeats), f: up ? e.f | FLAG.UP : e.f }));
    }
    return this.with(out);
  }

  // ── chord helpers ──────────────────────────────────────────────────────────

  /** Chord segments: from the chord symbols, or by grouping simultaneous notes. */
  segments(): ChordSeg[] {
    if (this.chords) return this.chords;
    const onsets = [...new Set(this.events.map((e) => Math.round(e.t * 1e6) / 1e6))].sort((a, b) => a - b);
    return onsets.map((t, i) => {
      const notes = this.events.filter((e) => Math.abs(e.t - t) < 1e-6).map((e) => e.n);
      const next = onsets[i + 1] ?? this.beats;
      const root = notes.length ? Math.min(...notes) : 60;
      return { t, d: next - t, chord: { symbol: '', root: ((root % 12) + 12) % 12, bass: null, intervals: [0] }, notes };
    });
  }

  /**
   * Re-triggers each chord on a rhythm: `p.rhythm('x..x..x.')` plays the chord on the x's of an 8-step grid (steps of
   * `res` per beat, default 4 = sixteenths) instead of one long hold. The grid restarts at every chord change, and a rhythm shorter
   * than the chord loops inside it (an 8-step rhythm on a 16-step bar plays twice).
   */
  rhythm(text: string, o: { res?: number; gate?: number; vel?: number } = {}): Pattern {
    checkKeys('rhythm', o, RHYTHM_KEYS);
    const res = o.res ?? 4;
    const gate = o.gate ?? 0.9;
    const steps = [...text.replace(/[\s|]/g, '')];
    const out: PEvt[] = [];
    for (const seg of this.segments()) {
      const n = Math.round(seg.d * res);
      const hits: { i: number; v: number; f: number }[] = [];
      for (let i = 0; i < n; i++) {
        const h = parseHitChar(steps[i % steps.length]);
        if (h) hits.push({ i, v: h.v, f: h.f });
      }
      hits.forEach((h, k) => {
        const next = k + 1 < hits.length ? hits[k + 1].i : n;
        const len = ((next - h.i) * gate) / res;
        for (const note of seg.notes) out.push({ t: seg.t + h.i / res, d: Math.max(0.02, len), n: note, v: Math.min(1, (o.vel ?? 0.8) * (h.v / 0.8)), f: h.f, part: '' });
      });
    }
    return new Pattern(out, this.beats, this.chords, 1 / res);
  }

  /** Arpeggiates each chord segment. */
  arp(o: ArpOpts = {}, rng?: Rng): Pattern {
    checkKeys('arp', o, ARP_KEYS);
    if (!Array.isArray(o.order)) pickWord('arp', 'order', o.order, ARP_ORDERS, 'up');
    const res = o.res ?? 4;
    const gate = o.gate ?? 0.85;
    const octaves = Math.max(1, Math.round(o.octaves ?? 1));
    const mask = o.mask ? [...o.mask.replace(/[\s|]/g, '')] : null;
    const accent = o.accent ? [...o.accent.replace(/[\s|]/g, '')] : null;
    const order = o.order ?? 'up';
    const out: PEvt[] = [];
    const rnd = rng ?? new Rng(7);
    for (const seg of this.segments()) {
      const base = seg.notes.slice().sort((a, b) => a - b);
      const pool: number[] = [];
      for (let k = 0; k < octaves; k++) pool.push(...base.map((n) => n + 12 * k));
      const n = Math.round(seg.d * res);
      let seq: number[];
      if (Array.isArray(order)) {
        seq = order.map((i) => pool[((i % pool.length) + pool.length) % pool.length]);
      } else {
        switch (order) {
          case 'down':
            seq = pool.slice().reverse();
            break;
          case 'updown':
            seq = pool.concat(pool.slice(1, -1).reverse());
            break;
          case 'downup':
            seq = pool.slice().reverse().concat(pool.slice(1, -1));
            break;
          case 'converge': {
            seq = [];
            for (let a = 0, b = pool.length - 1; a <= b; a++, b--) {
              seq.push(pool[a]);
              if (a !== b) seq.push(pool[b]);
            }
            break;
          }
          case 'diverge': {
            const c: number[] = [];
            for (let a = 0, b = pool.length - 1; a <= b; a++, b--) {
              c.push(pool[a]);
              if (a !== b) c.push(pool[b]);
            }
            seq = c.reverse();
            break;
          }
          case 'asplayed':
            seq = seg.notes.slice();
            break;
          case 'random':
            seq = [];
            for (let i = 0; i < Math.max(1, n); i++) seq.push(pool[Math.floor(rnd.next() * pool.length)]);
            break;
          default:
            seq = pool;
        }
      }
      for (let i = 0; i < n; i++) {
        if (mask && mask[i % mask.length] === '.') continue;
        const acc = accent ? accent[i % accent.length] === 'x' || accent[i % accent.length] === 'X' : false;
        out.push({
          t: seg.t + i / res,
          d: Math.max(0.02, gate / res),
          n: seq[i % seq.length],
          v: Math.min(1, (o.vel ?? 0.8) * (acc ? 1.25 : 1)),
          f: acc ? FLAG.ACCENT : 0,
          part: '',
        });
      }
    }
    return new Pattern(out, this.beats, this.chords, 1 / res);
  }

  /**
   * Root notes of the chords as a bass line. `rhythm` is a step string like 'x.xx' (default: one long note per chord; it loops inside
   * each chord like the one of `rhythm()`); `low` is the lowest MIDI note the roots may take (default 28 = E1: every root is put in the
   * octave that starts at `low`, so with 28 the roots fall between E1 and D#2, with 33 between A1 and G#2).
   */
  roots(o: { low?: number; rhythm?: string; res?: number; gate?: number; vel?: number } = {}): Pattern {
    checkKeys('roots', o, ROOTS_KEYS);
    const low = o.low ?? 28;
    const res = o.res ?? 4;
    const gate = o.gate ?? 0.9;
    const steps = o.rhythm ? [...o.rhythm.replace(/[\s|]/g, '')] : null;
    const out: PEvt[] = [];
    for (const seg of this.segments()) {
      const pc = seg.chord.bass ?? seg.chord.root;
      const root = low + ((((pc - low) % 12) + 12) % 12);
      if (!steps) {
        out.push({ t: seg.t, d: seg.d * gate, n: root, v: o.vel ?? 0.85, f: 0, part: '' });
        continue;
      }
      const n = Math.round(seg.d * res);
      const hits: { i: number; v: number; f: number }[] = [];
      for (let i = 0; i < n; i++) {
        const h = parseHitChar(steps[i % steps.length]);
        if (h) hits.push({ i, v: h.v, f: h.f });
      }
      hits.forEach((h, k) => {
        const next = k + 1 < hits.length ? hits[k + 1].i : n;
        out.push({ t: seg.t + h.i / res, d: Math.max(0.02, ((next - h.i) * gate) / res), n: root, v: Math.min(1, (o.vel ?? 0.85) * (h.v / 0.8)), f: h.f, part: '' });
      });
    }
    return new Pattern(out, this.beats, this.chords, 1 / res);
  }

  toString(): string {
    return `Pattern(${this.events.length} events, ${this.beats} beats)`;
  }

  /**
   * The pattern as text, one line per onset (a chord is one line): where it falls (bar and beat, both counted from 1 inside the
   * pattern), the note names or drum parts, the length in beats, the velocity and the articulations. For checking voicings, rhythms
   * and transformations without rendering: `process.stdout.write(prog.show() + '\n')`. `barBeats` is the bar length (4 in 4/4). Notes are
   * named with flats when a chord symbol of the pattern has a flat root (Db, Ab ...), else with sharps.
   */
  show(barBeats = 4): string {
    const flats = this.chords?.some((c) => /^[A-G]b/.test(c.chord.symbol)) ?? false;
    const FLAG_NAMES: [number, string][] = [
      [FLAG.ACCENT, 'accent'],
      [FLAG.SLIDE, 'slide'],
      [FLAG.MUTE, 'pm'],
      [FLAG.RING, 'ring'],
      [FLAG.STACCATO, 'stac'],
      [FLAG.UP, 'up'],
      [FLAG.GHOST, 'ghost'],
      [FLAG.RIM, 'rim'],
      [FLAG.FLAM, 'flam'],
      [FLAG.OPEN, 'open'],
    ];
    const num = (x: number): string => String(Math.round(x * 100) / 100);
    const span = (v: number[]): string => {
      const lo = Math.min(...v);
      const hi = Math.max(...v);
      return hi - lo < 0.005 ? num(lo) : `${num(lo)}-${num(hi)}`;
    };
    const groups = new Map<number, PEvt[]>();
    for (const e of this.events) {
      const k = Math.round(e.t * 1e4);
      const g = groups.get(k);
      if (g) g.push(e);
      else groups.set(k, [e]);
    }
    const lines = [`${this.toString()}, ${num(this.beats / barBeats)} bars of ${barBeats} beats`];
    for (const k of [...groups.keys()].sort((a, b) => a - b)) {
      const g = groups.get(k) as PEvt[];
      const t = g[0].t;
      const bar = Math.floor(t / barBeats + 1e-9);
      const what = g
        .slice()
        .sort((a, b) => a.n - b.n)
        .map((e) => (e.part !== '' ? e.part : midiToName(e.n, flats)))
        .join(' ');
      const flags = FLAG_NAMES.filter(([bit]) => g.some((e) => e.f & bit)).map(([, n]) => n);
      lines.push(
        `bar ${bar + 1} beat ${num(1 + t - bar * barBeats)}`.padEnd(18) +
          what.padEnd(22) +
          `len ${span(g.map((e) => e.d))}`.padEnd(14) +
          `vel ${span(g.map((e) => e.v))}` +
          (flags.length ? `  ${flags.join(' ')}` : ''),
      );
    }
    return lines.join('\n');
  }
}

/** Option names and values accepted by the chord methods (a misspelt one is an error, not a silent default). */
export const ARP_KEYS = ['res', 'order', 'octaves', 'gate', 'vel', 'mask', 'accent'];
export const ARP_ORDERS = ['up', 'down', 'updown', 'downup', 'converge', 'diverge', 'random', 'asplayed'] as const;
export const RHYTHM_KEYS = ['res', 'gate', 'vel'];
export const ROOTS_KEYS = ['low', 'rhythm', 'res', 'gate', 'vel'];

export interface ArpOpts {
  /** Steps per beat (4 = sixteenths, the default). */
  res?: number;
  /** 'up' (default), 'down', 'updown', 'downup', 'converge', 'diverge', 'random', 'asplayed', or a list of indices into the chord pool (0 = lowest note). */
  order?: 'up' | 'down' | 'updown' | 'downup' | 'converge' | 'diverge' | 'random' | 'asplayed' | number[];
  /** Octaves the arpeggio spans (default 1). */
  octaves?: number;
  /** Fraction of a step each note sounds (default 0.85). */
  gate?: number;
  vel?: number;
  /** Step mask: 'x.xx' plays only the x steps (the cycle restarts at each chord). */
  mask?: string;
  /** Accent mask: 'x...' accents the x steps. */
  accent?: string;
}

/** Hit characters shared by rhythm strings and drum lanes. Returns null for a rest. */
export function parseHitChar(c: string): { v: number; f: number } | null {
  switch (c) {
    case '.':
    case '-':
    case '_':
    case '0':
      return null;
    case 'x':
      return { v: 0.8, f: 0 };
    case 'X':
      return { v: 1, f: FLAG.ACCENT };
    case 'g':
      return { v: 0.4, f: FLAG.GHOST };
    case 'o':
      return { v: 0.8, f: FLAG.OPEN };
    case 'O':
      return { v: 1, f: FLAG.OPEN | FLAG.ACCENT };
    case 'r':
      return { v: 0.8, f: FLAG.RIM };
    case 'R':
      return { v: 1, f: FLAG.RIM | FLAG.ACCENT };
    case 'f':
      return { v: 0.8, f: FLAG.FLAM };
    case 'm':
      return { v: 0.7, f: FLAG.MUTE };
    default:
      if (c >= '1' && c <= '9') return { v: (c.charCodeAt(0) - 48) / 9, f: 0 };
      throw new Error(`bad hit character "${c}" (use x X g o O r R f m . and 1-9)`);
  }
}

// ── parsers ──────────────────────────────────────────────────────────────────

/**
 * Parses the step-grid note notation (see the README): tokens separated by spaces, `|` between bars.
 *   A2 note   . rest   - hold the previous note one more step   [A2,E3,A3] chord
 *   modifiers after a note, in any order: ! accent, ? ghost, ~ slide into it, ' staccato, :3 length in steps (the note then occupies
 *   those steps: A2:3 is the same as A2 - -), @90 velocity, {pm} articulation
 */
export function parseNotes(text: string, opts: NoteParseOpts, ctx: ParseCtx, label = 'notes'): Pattern {
  const res = opts.res ?? 4;
  const baseVel = opts.vel ?? 0.8;
  const gate = opts.gate ?? 0.9;
  const artFlags = opts.art ? articulation(opts.art) : 0;
  const bars = barSplit(text, label);
  if (!bars.length) throw new Error(`${label}: empty pattern`);
  const barSteps: number[] = [];
  const events: PEvt[] = [];
  let step = 0;
  let last: PEvt[] | null = null; // events of the previous token (a note or a chord), while it can still be tied to
  let lastStart = -1;
  let lastSteps = 0;
  let lastStac = false;
  const setLen = (evs: PEvt[], steps: number, stac: boolean): void => {
    for (const e of evs) e.d = Math.max(0.01, (stac ? steps * 0.4 : steps - (1 - gate)) / res);
  };
  bars.forEach((bar, bi) => {
    const barStart = step;
    bar.forEach((tok, ti) => {
      const where = `${label}: the ${ordinal(bi + 1)} bar, step ${ti + 1} ("${tok}")`;
      if (tok === '.' || tok === '_') {
        last = null;
        step++;
        return;
      }
      if (tok === '-') {
        if (!last) throw new Error(`${where}: "-" holds the previous note but there is none right before it`);
        lastSteps++;
        setLen(last, lastSteps, lastStac);
        step++;
        return;
      }
      const m = splitToken(tok);
      if (!m) throw new Error(`${where}: cannot read this token. Notes look like A2, C#3, Bb1, [A2,E3] with optional ! ? ~ ' :len @vel {art}`);
      const { pitch, marks, len: lenStr, vel: velStr, art: artStr } = m;
      let notes: number[];
      if (pitch.startsWith('[')) notes = pitch.slice(1, -1).split(',').map((n) => noteToMidi(n));
      else if (/^[A-Ga-g]/.test(pitch)) notes = [noteToMidi(pitch)];
      else throw new Error(`${where}: scale degrees belong in s.degrees(), not s.notes()`);
      let v = baseVel;
      let f = artFlags;
      let stac = false;
      if (marks.includes('!')) {
        v = 1;
        f |= FLAG.ACCENT;
      }
      if (marks.includes('?')) {
        v = baseVel * 0.45;
        f |= FLAG.GHOST;
      }
      if (marks.includes('~')) f |= FLAG.SLIDE;
      if (marks.includes("'")) {
        stac = true;
        f |= FLAG.STACCATO;
      }
      if (velStr) v = velOf(velStr);
      if (artStr) f |= articulation(artStr);
      const steps = lenStr ? parseFloat(lenStr) : 1;
      if (!(steps > 0)) throw new Error(`${where}: the length after : must be positive`);
      const consumed = Math.max(1, Math.ceil(steps - 1e-9));
      const t = step / res;
      const evs: PEvt[] = notes.map((n) => ({ t, d: 0, n, v: Math.min(1, v), f, part: '' }));
      // slide: the previous note ends exactly where this one starts so the engine ties them (legato)
      if (f & FLAG.SLIDE && last && lastStart + lastSteps === step) {
        for (const e of last as PEvt[]) e.d = (step - lastStart) / res;
      }
      setLen(evs, steps, stac);
      events.push(...evs);
      last = evs;
      lastStart = step;
      lastSteps = steps;
      lastStac = stac;
      step += consumed;
    });
    barSteps.push(step - barStart);
  });
  checkBars(label, barSteps, res, ctx.barBeats, !!opts.free);
  lenCheck(label, step, res, ctx.barBeats, !!opts.free);
  return new Pattern(events, step / res, null, 1 / res);
}

function midiNameSharp(m: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return names[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

/**
 * Scale-degree notation: like notes() but tokens are degrees of the song's key: `1`..`7` (8 = the octave), prefixed
 * with b or # to flatten or sharpen, followed by + or - to move an octave: `1 . 3 5+ b7-`.
 */
export function parseDegrees(text: string, opts: NoteParseOpts, ctx: ParseCtx, label = 'degrees'): Pattern {
  if (!ctx.key) throw new Error(`${label}: set a key first with s.key('E', 'minor')`);
  const key = ctx.key;
  const oct = opts.oct ?? 3;
  const conv = (d: string): string => {
    const mm = /^([b#]?)(\d{1,2})([+-]*)$/.exec(d);
    if (!mm) throw new Error(`${label}: bad degree "${d}" (use 1-7, an optional b/# prefix and +/- octave marks, e.g. 5+ or b3-)`);
    const acc = mm[1] === 'b' ? -1 : mm[1] === '#' ? 1 : 0;
    const shift = (mm[3].match(/\+/g)?.length ?? 0) - (mm[3].match(/-/g)?.length ?? 0);
    return midiNameSharp(key.degree(parseInt(mm[2], 10), oct + shift, acc));
  };
  const t = text.replace(/\[[^\]]*\]/g, (m) => m.replace(/\s+/g, ''));
  const out = t
    .split(/(\s+|\|)/)
    .map((tok) => {
      if (!tok || /^\s+$/.test(tok) || tok === '|' || tok === '.' || tok === '-') return tok;
      const m = /^(\[[^\]]*\]|[b#]?\d{1,2}[+-]*)(.*)$/.exec(tok);
      if (!m) throw new Error(`${label}: cannot read "${tok}"`);
      const head = m[1];
      const converted = head.startsWith('[') ? `[${head.slice(1, -1).split(',').map(conv).join(',')}]` : conv(head);
      return converted + m[2];
    })
    .join('');
  return parseNotes(out, opts, ctx, label);
}

export interface DrumParseOpts {
  /** Steps per beat (4 = sixteenths, default). */
  res?: number;
  /** Velocity multiplier applied to every hit (default 1). */
  vel?: number;
  free?: boolean;
}

/**
 * Drum lanes: `{ kick: 'x...x...', snare: '....X...', hat: 'x.x.x.xo' }`, one character per step (spaces and | are ignored).
 * x hit, X accent, g ghost, o open, r rim, f flam, m muted, 1-9 velocity, . rest. All lanes must be the same length.
 */
export function parseDrums(lanes: Record<string, string>, opts: DrumParseOpts, ctx: ParseCtx, label = 'drums'): Pattern {
  const res = opts.res ?? 4;
  const mult = opts.vel ?? 1;
  const events: PEvt[] = [];
  let steps = -1;
  for (const [part, text] of Object.entries(lanes)) {
    const bars = text.split('|').map((b) => [...b.replace(/\s+/g, '')]);
    checkBars(`${label}.${part}`, bars.map((b) => b.length), res, ctx.barBeats, !!opts.free);
    const chars = bars.flat();
    if (steps < 0) steps = chars.length;
    else if (chars.length !== steps) throw new Error(`${label}: lane "${part}" has ${chars.length} steps but the others have ${steps}`);
    chars.forEach((c, i) => {
      let h: { v: number; f: number } | null;
      try {
        h = parseHitChar(c);
      } catch (e) {
        throw new Error(`${label}.${part}, step ${i + 1}: ${(e as Error).message}`);
      }
      if (h) events.push({ t: i / res, d: 0.1, n: 0, v: Math.min(1, h.v * mult), f: h.f, part });
    });
  }
  if (steps < 0) throw new Error(`${label}: no lanes`);
  lenCheck(label, steps, res, ctx.barBeats, !!opts.free);
  return new Pattern(events, steps / res, null, 1 / res);
}

/** A drum pattern for a single-part instrument (a kick, a snare ...): one lane. */
export function parseHits(text: string, opts: DrumParseOpts, ctx: ParseCtx, label = 'hits'): Pattern {
  return parseDrums({ '': text }, opts, ctx, label);
}

export interface ChordParseOpts extends VoicingOpts {
  /** Smooth voice leading between successive chords (picks the nearest inversion / octave). */
  lead?: boolean;
  /** Velocity (default 0.8). */
  vel?: number;
  /** Fraction of each chord's duration the notes sound (default 0.98). */
  gate?: number;
  /** Offset in beats between successive notes of a chord (a strum; default 0). */
  strum?: number;
}

/**
 * Chord progression text: chords separated by spaces or |. Each |-separated group is one bar, and the chords inside a bar
 * share it equally ('Am F | C G' = two bars of two chords). With no | at all every chord is one bar. `.` (or -) continues the
 * previous chord into the next slot (or bar); `%` repeats the previous bar.
 */
export function parseChords(text: string, opts: ChordParseOpts, ctx: ParseCtx, label = 'chords'): Pattern {
  const hasBars = text.includes('|');
  const barToks: string[][] = hasBars
    ? barSplit(text, label)
    : text
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => [t]);
  if (!barToks.length) throw new Error(`${label}: empty progression`);
  const events: PEvt[] = [];
  const segs: ChordSeg[] = [];
  let prev: number[] | null = null;
  let barStart = 0;
  let prevBar: string[] | null = null;
  let cur: ChordSeg | null = null;
  const voice = (c: ChordInfo): number[] => (opts.lead ? voiceLead(prev, c, opts) : voiceChord(c, opts));
  barToks.forEach((toks, bi) => {
    let bar = toks;
    if (bar.length === 1 && bar[0] === '%') {
      if (!prevBar) throw new Error(`${label}: the ${ordinal(bi + 1)} bar is "%" but there is no previous bar`);
      bar = prevBar;
    }
    prevBar = bar;
    const slot = ctx.barBeats / bar.length;
    bar.forEach((tok, si) => {
      const t = barStart + si * slot;
      if (tok === '.' || tok === '-') {
        if (!cur) throw new Error(`${label}: the ${ordinal(bi + 1)} bar: "${tok}" continues a chord but there is none before it`);
        cur.d += slot;
        return;
      }
      let info: ChordInfo;
      try {
        info = parseChord(tok);
      } catch (e) {
        throw new Error(`${label}: the ${ordinal(bi + 1)} bar: ${(e as Error).message}`);
      }
      const notes = voice(info);
      prev = notes;
      cur = { t, d: slot, chord: info, notes };
      segs.push(cur);
    });
    barStart += ctx.barBeats;
  });
  const strum = opts.strum ?? 0;
  const gate = opts.gate ?? 0.98;
  for (const seg of segs) {
    seg.notes.forEach((n, i) => {
      events.push({ t: seg.t + i * strum, d: Math.max(0.05, seg.d * gate - i * strum), n, v: opts.vel ?? 0.8, f: 0, part: '' });
    });
  }
  return new Pattern(events, barStart, segs);
}

/** Fluent builder for patterns made in code: loops, euclidean rhythms, generated lines. Times are in beats. */
export class PatternBuilder {
  private readonly events: PEvt[] = [];
  constructor(readonly beats: number) {}
  /** A note at `beat` (fractions allowed) lasting `len` beats. `note` is a MIDI number or a name like 'A2'. */
  note(beat: number, note: number | string, len = 0.25, vel = 0.8, flags = 0): this {
    this.events.push({ t: beat, d: len, n: typeof note === 'string' ? noteToMidi(note) : note, v: vel, f: flags, part: '' });
    return this;
  }
  /** Several notes at once. */
  chord(beat: number, notes: (number | string)[], len = 1, vel = 0.8, flags = 0): this {
    for (const n of notes) this.note(beat, n, len, vel, flags);
    return this;
  }
  /** A drum hit at `beat` on the named part. */
  hit(beat: number, part = '', vel = 0.8, flags = 0): this {
    this.events.push({ t: beat, d: 0.1, n: 0, v: vel, f: flags, part });
    return this;
  }
  done(): Pattern {
    for (const e of this.events) {
      if (e.t < 0 || e.t >= this.beats + 1e-9) throw new Error(`PatternBuilder: event at beat ${e.t} is outside the ${this.beats}-beat pattern`);
    }
    return new Pattern(this.events, this.beats);
  }
}

/**
 * Euclidean rhythm (Bjorklund's algorithm): `hits` spread as evenly as possible over `steps`, as a step string that starts on a hit.
 * euclid(3, 8) = 'x..x..x.', euclid(5, 8) = 'x.xx.xx.', euclid(5, 16) = 'x..x..x..x..x...', euclid(7, 16) = 'x..x.x.x..x.x.x.'.
 * `rotate` moves the pattern later by that many steps (negative: earlier), wrapping around.
 */
export function euclid(hits: number, steps: number, rotate = 0): string {
  if (!Number.isInteger(steps) || steps < 1) throw new Error(`euclid: steps must be a whole number of at least 1 (got ${steps})`);
  const k = Math.max(0, Math.min(steps, Math.round(hits)));
  let a: number[][] = Array.from({ length: k }, () => [1]);
  let b: number[][] = Array.from({ length: steps - k }, () => [0]);
  while (b.length > 1 && a.length > 0) {
    const n = Math.min(a.length, b.length);
    const merged: number[][] = [];
    for (let i = 0; i < n; i++) merged.push(a[i].concat(b[i]));
    const rest = a.length > b.length ? a.slice(n) : b.slice(n);
    a = merged;
    b = rest;
  }
  const seq = a.concat(b).flat();
  const r = ((Math.round(rotate) % steps) + steps) % steps;
  const rot = seq.slice(steps - r).concat(seq.slice(0, steps - r));
  return rot.map((v) => (v ? 'x' : '.')).join('');
}
