/**
 * The instrument and effect contracts of the album engine, plus the helpers every instrument shares:
 * parameter specs (name, default, range, unit, documentation: the single source of truth for the automation system, the
 * validation and the README tables), articulation flags, and option resolution (presets + flat overrides + typo hints).
 */

/** Largest number of frames the engine asks an instrument or effect to render in one call (scratch buffers are this long). */
export const BLOCK = 64;

/** Description of one automatable parameter. */
export interface ParamSpec {
  default: number;
  min: number;
  max: number;
  unit?: string;
  doc: string;
  /** 'exp' for frequency-like values: automation ramps between two values geometrically instead of linearly. */
  curve?: 'lin' | 'exp';
}
export type ParamSpecs = Record<string, ParamSpec>;
export type ParamValues<S extends ParamSpecs> = { [K in keyof S]: number };

/** Note articulation bits, set by the pattern notation and interpreted by each instrument (see the README). */
export const FLAG = {
  /** `!` accent: louder, and for the acid bass a bigger filter sweep. */
  ACCENT: 1,
  /** `~` slide: glide into this note from the previous one without re-triggering (mono instruments). */
  SLIDE: 2,
  /** palm mute (guitar, bass guitar), damped / choked (drums). */
  MUTE: 4,
  /** let ring: do not damp the strings when the note ends (guitar). */
  RING: 8,
  /** staccato. */
  STACCATO: 16,
  /** up-stroke (guitar strums from the high strings down) */
  UP: 32,
  /** ghost note. */
  GHOST: 64,
  /** rim-shot / side-stick / cross-stick / bell (alternate articulation of a drum part). */
  RIM: 128,
  /** flam: a quiet grace hit just before the main one. */
  FLAM: 256,
  /** open / ringing variant where the instrument has one (open chord strum, open hat). */
  OPEN: 512,
} as const;

/** A named starting point for an instrument: documentation plus option values. */
export interface PresetDef {
  doc: string;
  opts: Record<string, unknown>;
}

/** Playback context handed to instruments and effects when they are built. */
export interface Ctx {
  sr: number;
  bpm: number;
  /** Length of a bar in beats (quarter notes). */
  barBeats: number;
  /** Shared transport, advanced by the engine before each rendered segment. */
  transport: Transport;
  /** Seed for everything random inside this object (derived from the track id and the channel name). */
  seed: number;
}

/** Song position, updated by the engine once per segment (read-only for instruments and effects). */
export class Transport {
  /** Position of the first frame of the current segment, in beats from the start of the song. */
  beat = 0;
  /** Absolute frame index of the first frame of the current segment. */
  frame = 0;
}

/** Anything with named, automatable parameters. */
export interface ParamHost {
  readonly specs: ParamSpecs;
  readonly params: Record<string, number>;
  setParam(name: string, value: number): void;
  /**
   * Optional: why automating this parameter would do nothing on this instance (the growl's `width` when it was built without one, and so
   * is mono). Automation of such a parameter is an error that says it; the parameter stays valid as an option.
   */
  inertParam?(name: string): string | null;
}

export interface Instrument extends ParamHost {
  /** false: only buffer `l` is written (mono source); the channel strip pans it. */
  readonly stereo: boolean;
  /** Names accepted by `hit` (drum kits), if any. */
  readonly parts?: readonly string[];
  /** Mixer defaults this instrument asks for (a guitar preset panned hard left): the channel's own mix options win. */
  readonly defaultMix?: { pan?: number };
  /** Optional: told which parts a track actually uses, so that heavy parts (cymbal buffers) are only built when needed. */
  prepare?(used: Set<string>): void;
  /** Optional: true when the instrument has a kick and should key the sidechain unless the channel's mix says `key: false`. */
  readonly keysByDefault?: boolean;
  /** Optional: which hits trigger the sidechain on a keyed channel (default: all). A drum kit answers true only for its kick parts. */
  keyed?(part: string): boolean;
  /**
   * Optional: what a `~` (slide) mark does. 'tie': the note glides from the note right before it (it must follow it directly, no rest, or
   * the mark has no effect: the arrangement listing says so); 'scoop': the note scoops up into its pitch by itself (guitars); 'none': ignored.
   * Instruments that do not say are drums and effects, where `~` means nothing.
   */
  readonly slides?: 'tie' | 'scoop' | 'none';
  /**
   * Optional: the pitches every note really sounds at, as semitones from it (default [0]): a synth with a layer an octave up answers
   * [0, 12]. The harmony check (Song.clashes) checks each of them, so a clash with a hidden octave is found too.
   */
  readonly pitches?: readonly number[];
  /**
   * Optional: true when the instrument sounds one note at a time (a mono or legato synth, the basses): two of its own notes that
   * overlap for a moment (a slur written as an overlap) are one voice moving, so the harmony check never compares them.
   */
  readonly monophonic?: boolean;
  /** Starts a note. `note` is a MIDI number (A4 = 69; fractions allowed), `vel` 0..1, `dur` the planned length in samples. */
  noteOn(note: number, vel: number, dur: number, flags: number): void;
  noteOff(note: number): void;
  /** Triggers a drum / one-shot part. */
  hit(part: string, vel: number, dur: number, flags: number): void;
  /** Adds `n` frames (n <= 64... up to the engine's segment size) into l (and r when stereo). */
  process(l: Float64Array, r: Float64Array, n: number): void;
  /** True while something may still be audible (voices, tails): idle instruments are skipped to save CPU. */
  active(): boolean;
}

/** A recipe for an insert effect; the Song instantiates it with the channel's context. */
export interface FxSpec {
  kind: string;
  name: string;
  make(ctx: Ctx): Effect;
}

export interface Effect extends ParamHost {
  /** true when the effect works on a mono signal without needing two channels (the strip stays mono through it). */
  readonly mono: boolean;
  /** Mono in-place processing (only when `mono`). */
  processMono?(x: Float64Array, n: number): void;
  /** Stereo in-place processing. */
  process(l: Float64Array, r: Float64Array, n: number): void;
  /** True while a tail may still be audible after the input went silent. */
  active(): boolean;
}

// ── parameter plumbing ───────────────────────────────────────────────────────

/** Levenshtein-based suggestion for typos in option / parameter names. */
export function suggest(name: string, valid: readonly string[]): string {
  let best = '';
  let bestD = 1e9;
  for (const v of valid) {
    const a = name.toLowerCase();
    const b = v.toLowerCase();
    const m = a.length;
    const n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
      prev = cur;
    }
    // a name that starts with another one ("lowest" and "low", "resolution" and "res") is a close call whatever the length
    const d = a.length >= 2 && b.length >= 2 && (a.startsWith(b) || b.startsWith(a)) ? Math.min(prev[n], 1) : prev[n];
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return bestD <= Math.max(2, Math.floor(name.length / 3)) ? ` Did you mean "${best}"?` : '';
}

/** Throws when `opts` has a key that is not in `valid` (with a spelling suggestion); undefined and null are fine. */
export function checkKeys(who: string, opts: object | undefined | null, valid: readonly string[]): void {
  if (!opts) return;
  for (const k of Object.keys(opts)) {
    if (!valid.includes(k)) throw new Error(`${who}: unknown option "${k}".${suggest(k, valid)} Valid: ${valid.join(', ')}`);
  }
}

/**
 * An option that must be one of a few words ('lp', 'hp' ...). `undefined` gives the fallback (an error when there is none); any other value
 * that is not in the list is an error with a spelling suggestion (falling back silently would hide the typo and leave the sound wrong).
 */
export function pickWord<T extends string>(who: string, name: string, value: unknown, valid: readonly T[], fallback?: T): T {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${who}: option "${name}" is missing. Choose one of: ${valid.join(', ')}.`);
  }
  if (typeof value === 'string' && (valid as readonly string[]).includes(value)) return value as T;
  const shown = typeof value === 'string' ? `"${value}"` : String(value);
  throw new Error(`${who}: option "${name}" is ${shown}.${typeof value === 'string' ? suggest(value, valid) : ''} Choose one of: ${valid.join(', ')}.`);
}

/** The LFO shapes of the synth, the growl and the automation LFOs. */
export const LFO_SHAPES = ['sine', 'tri', 'saw', 'ramp', 'square', 'smooth', 'sh'] as const;

export function paramDefaults<S extends ParamSpecs>(specs: S): ParamValues<S> {
  const o: Record<string, number> = {};
  for (const k of Object.keys(specs)) o[k] = specs[k].default;
  return o as ParamValues<S>;
}

/** The error for a value outside a parameter's range (with the usual trap spelled out: an amp's `gain` is 0..1, the fader is `mix.gain` in dB). */
export function rangeError(who: string, name: string, value: number, sp: ParamSpec): Error {
  const hint = name === 'gain' ? ' (the channel fader in dB is "mix.gain": use ch.auto("mix.gain", ...) or { gain: -6 } in the mix options; "gain" here is an instrument parameter)' : '';
  return new Error(`${who}: parameter "${name}" is ${value}, outside its range ${sp.min} .. ${sp.max}${sp.unit ? ` ${sp.unit}` : ''}.${hint}`);
}

/** Shared implementation of `setParam`: validates the name and the range (an out-of-range value is an error, not a silent clamp). Returns the stored value. */
export function applyParam(host: string, specs: ParamSpecs, params: Record<string, number>, name: string, value: number): number {
  const sp = specs[name];
  if (!sp) throw new Error(`${host}: unknown parameter "${name}".${suggest(name, Object.keys(specs))} Valid: ${Object.keys(specs).join(', ')}`);
  if (!Number.isFinite(value)) throw new Error(`${host}: parameter "${name}" must be a finite number, got ${value}`);
  if (value < sp.min - 1e-9 || value > sp.max + 1e-9) throw rangeError(host, name, value, sp);
  params[name] = value;
  return value;
}

/** Plain-object deep merge (arrays and primitives are replaced, objects merged); used for preset + override resolution. */
export function mergeOpts<T extends object>(base: T, over: object | undefined): T {
  if (!over) return { ...base };
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (v === undefined) continue;
    const b = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) out[k] = mergeOpts(b as object, v as object);
    else out[k] = v;
  }
  return out as T;
}

/**
 * Resolves `{ preset?, ...overrides }` against a preset table. `structural` lists the non-parameter option names this
 * instrument accepts; every other key must be a parameter name, otherwise an error with a spelling suggestion is thrown.
 * Returns the merged flat options.
 */
export function resolveOpts<O extends object>(
  kind: string,
  presets: Record<string, PresetDef>,
  input: (O & { preset?: string }) | string | undefined,
  specs: ParamSpecs,
  structural: readonly string[],
): Record<string, unknown> {
  const o: Record<string, unknown> = typeof input === 'string' ? { preset: input } : { ...((input ?? {}) as Record<string, unknown>) };
  const presetName = o.preset as string | undefined;
  delete o.preset;
  let base: Record<string, unknown> = {};
  if (presetName !== undefined) {
    const p = presets[presetName];
    if (!p) throw new Error(`${kind}: unknown preset "${presetName}".${suggest(presetName, Object.keys(presets))} Presets: ${Object.keys(presets).join(', ')}`);
    base = p.opts;
  }
  const merged = mergeOpts(base, o);
  const valid = new Set<string>([...Object.keys(specs), ...structural, 'name']);
  for (const k of Object.keys(merged)) {
    if (!valid.has(k)) throw new Error(`${kind}: unknown option "${k}".${suggest(k, [...valid])} Valid: ${[...valid].join(', ')}`);
  }
  return merged;
}

/** Writes the parameter-valued entries of `opts` into `params` (clamped). */
export function loadParams(host: string, specs: ParamSpecs, params: Record<string, number>, opts: Record<string, unknown>): void {
  for (const k of Object.keys(opts)) {
    if (specs[k] !== undefined) {
      const v = opts[k];
      if (typeof v !== 'number') throw new Error(`${host}: parameter "${k}" must be a number`);
      applyParam(host, specs, params, k, v);
    }
  }
}

/** Convenience base class: parameter storage with validation. */
export abstract class ParamBase<S extends ParamSpecs> implements ParamHost {
  readonly specs: S;
  readonly params: ParamValues<S>;
  protected readonly label: string;
  constructor(label: string, specs: S, opts: object = {}) {
    this.label = label;
    this.specs = specs;
    this.params = paramDefaults(specs);
    loadParams(label, specs, this.params as Record<string, number>, opts as Record<string, unknown>);
  }
  setParam(name: string, value: number): void {
    applyParam(this.label, this.specs, this.params as Record<string, number>, name, value);
  }
}
