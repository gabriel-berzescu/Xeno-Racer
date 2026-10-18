/**
 * The composer API. A track is a module that calls `defineTrack(meta, compose)`; `compose(s)` receives a Song and describes the
 * music with data and a little code: instruments become mixer channels, patterns are written on a step grid, clips are placed on
 * the bar timeline, any parameter can be automated. See README.md in this folder for the full guide and a worked example.
 *
 * Time conventions: bars are counted from 0 (bar 0 is the first bar) and may be fractional (7.5 = halfway through bar 7);
 * note lengths and delay times are in beats (quarter notes).
 */
import type { AlbumTrack } from './index';
import { AlbumRenderer, EventDef, LaneCurve, LaneDef, LfoDef, LfoWave, Program } from './engine';
import { Rng, divisionToBeats, hashString } from './dsp/core';
import { Ctx, Effect, FLAG, FxSpec, Instrument, LFO_SHAPES, ParamHost, ParamSpec, Transport, checkKeys, pickWord, rangeError, suggest } from './instrument';
import { Bus, Channel, DUCK_SPECS, DelayReturn, Duck, MASTER_SPECS, MasterBus, MixOpts, REVERB_RETURN_SPECS, ReverbReturn, STRIP_SPECS, Strip } from './mixer';
import type { DelayOpts, FxKind } from './fx';
import { AMP_SPECS, CHORUS_SPECS, CRUSH_SPECS, DELAY_SPECS, DRIVE_SPECS, FILTER_SPECS, FX_KINDS, GATE_SPECS, PHASER_SPECS, REVERB_FX_SPECS, WIDEN_SPECS } from './fx';
import {
  ARP_KEYS,
  ArpOpts,
  ChordParseOpts,
  DrumParseOpts,
  NoteParseOpts,
  ParseCtx,
  Pattern,
  PatternBuilder,
  PEvt,
  euclid,
  parseChords,
  parseDegrees,
  parseDrums,
  parseHits,
  parseNotes,
  articulation,
} from './pattern';
import { Key, midiToName, noteToMidi, parseChord, pitchClass, voiceChord, ChordInfo, VoicingOpts } from './theory';
import { DrumKit, DrumOpts, DrumType, KitPartSpec, makeDrum } from './instruments/drums';
import { Synth, SynthOpts } from './instruments/synth';
import { AcidBass, DarkBass, GrowlBass, GrowlOpts, ReeseBass, SubBass } from './instruments/bass';
import { Impact, Riser, RiserOpts, Zap } from './instruments/sfx';
import { AcousticKit, AcousticKitOpts } from './instruments/acoustic-kit';
import { BassGuitar, BassGuitarOpts, Guitar, GuitarOpts, guitarChord } from './instruments/guitar';

export type { LaneCurve, LfoWave } from './engine';
export { Pattern, PatternBuilder, euclid, articulation, FLAG };
export { Key, midiToName, noteToMidi, parseChord, pitchClass, voiceChord, guitarChord };
export type { MixOpts } from './mixer';
export type { FxSpec, Instrument, Effect, Ctx, ParamSpec, ParamSpecs, PresetDef } from './instrument';
export { ParamBase, Transport, resolveOpts } from './instrument';
export { MonoTracker } from './instruments/mono';
export * as dsp from './dsp';
export { measure, LoudnessMeter } from './measure';
export { SYNTH_PRESETS } from './instruments/synth';
export { DRUM_PRESETS } from './instruments/drums';
export { DARK_PRESETS, REESE_PRESETS, GROWL_PRESETS, ACID_PRESETS, SUB_PRESETS } from './instruments/bass';
export { RISER_PRESETS, IMPACT_PRESETS, ZAP_PRESETS } from './instruments/sfx';
export { AKIT_PRESETS } from './instruments/acoustic-kit';
export { GUITAR_PRESETS, BASSG_PRESETS } from './instruments/guitar';
export type { SynthOpts } from './instruments/synth';
export type { DrumOpts, KitPartSpec } from './instruments/drums';
export type { GrowlOpts } from './instruments/bass';
export type { RiserOpts } from './instruments/sfx';
export type { AcousticKitOpts } from './instruments/acoustic-kit';
export type { GuitarOpts, BassGuitarOpts } from './instruments/guitar';

// ── track definition ─────────────────────────────────────────────────────────

export interface TrackMeta {
  /** Stable id = the file name in tracks/ (e.g. 'neon-overdrive'). */
  id: string;
  title: string;
  /** 'Cyberpunk', 'Goa trance', 'Melodic dubstep', 'Punk' (as the player shows it). */
  genre: string;
  bpm: number;
  /** Length of the arrangement in bars. The track lasts bars * barLength + tail. */
  bars: number;
  /** Time signature [beats, note value]; default [4, 4]. */
  signature?: [number, number];
  /** Seconds of ring-out (reverb, delay) after the last bar. Default 3. */
  tail?: number;
  /** Seconds of fade-in at the very start (default 0.0005: the first sample is exactly 0, nothing more). */
  fadeIn?: number;
  /** Seconds of fade-out at the very end (default: the tail, at most 2.5). */
  fadeOut?: number;
}

export interface TrackDef {
  readonly meta: TrackMeta;
  /** What ALBUM lists. */
  readonly info: AlbumTrack;
  /** Builds the renderer at a sample rate (this is what createTrackRenderer calls). */
  build(sampleRate: number, opts?: { startFrame?: number }): Song;
}

/** Bar length in beats (quarter notes) of a signature. */
export function barBeatsOf(sig: [number, number]): number {
  return (sig[0] * 4) / sig[1];
}

/** Defines a track. `compose` runs when the renderer is created (not at import). */
export function defineTrack(meta: TrackMeta, compose: (s: Song) => void): TrackDef {
  if (!(meta.bpm > 20 && meta.bpm < 400)) throw new Error(`track ${meta.id}: bpm ${meta.bpm} is out of range`);
  if (!(meta.bars >= 1)) throw new Error(`track ${meta.id}: bars must be at least 1`);
  const sig = meta.signature ?? [4, 4];
  const tail = meta.tail ?? 3;
  const seconds = ((meta.bars * barBeatsOf(sig)) * 60) / meta.bpm + tail;
  return {
    meta,
    info: { id: meta.id, title: meta.title, genre: meta.genre, bpm: meta.bpm, seconds },
    build(sampleRate: number): Song {
      const s = new Song(meta, sampleRate);
      compose(s);
      return s;
    },
  };
}

/** Options accepted by the instrument factories: a preset name, plus any parameter or structural option. */
export interface InstOpts {
  preset?: string;
  /** Name of the mixer channel (used in automation paths); defaults to the factory name. */
  name?: string;
  [option: string]: unknown;
}
function nameOf(o: { name?: string } | string | undefined): string | undefined {
  return typeof o === 'object' ? o.name : undefined;
}

// ── option validation: a misspelt option is an error with a suggestion, not a silent no-op ─────────────────

const MIX_KEYS = [...Object.keys(STRIP_SPECS), 'bus', 'fx', 'comp', 'key', 'mute', 'name'];
const COMP_KEYS = ['threshold', 'ratio', 'attack', 'release', 'knee', 'makeup', 'mix', 'detect'];
const PLAY_KEYS = ['vel', 'transpose', 'offset', 'gate', 'from', 'art', 'only', 'rename', 'humanize', 'swing'];
const GROOVE_KEYS = ['swing', 'unit', 'push', 'humanize'];
const HUMANIZE_KEYS = ['time', 'vel'];
const LFO_KEYS = ['period', 'perBar', 'depth', 'shape', 'from', 'to', 'phase', 'mode'];
const NOTE_KEYS = ['res', 'vel', 'gate', 'art', 'oct', 'free'];
const DRUM_KEYS = ['res', 'vel', 'free'];
const CHORD_KEYS = ['octave', 'inversion', 'spread', 'bass', 'range', 'add', 'lead', 'vel', 'gate', 'strum'];
const FX_KEYS: Record<FxKind, string[]> = {
  drive: [...Object.keys(DRIVE_SPECS), 'mode', 'oversample', 'name'],
  chorus: [...Object.keys(CHORUS_SPECS), 'voices', 'name'],
  phaser: [...Object.keys(PHASER_SPECS), 'stages', 'name'],
  crusher: [...Object.keys(CRUSH_SPECS), 'name'],
  widener: [...Object.keys(WIDEN_SPECS), 'name'],
  gate: [...Object.keys(GATE_SPECS), 'pattern', 'res', 'name'],
  filter: [...Object.keys(FILTER_SPECS), 'mode', 'shape', 'name'],
  delay: [...Object.keys(DELAY_SPECS), 'name'],
  reverb: [...Object.keys(REVERB_FX_SPECS), 'gated', 'name'],
  amp: [...Object.keys(AMP_SPECS), 'cab', 'name'],
};

// ── helpers exposed to composers ─────────────────────────────────────────────

/** A named stretch of the timeline. */
export interface Section {
  name: string;
  /** First bar (0-based). */
  bar: number;
  bars: number;
  /** First bar after the section. */
  end: number;
}

/** Where a clip goes: a bar number, or a Section (its first bar and length). */
export type Placement = number | { bar: number; bars: number };

export interface PlayOpts {
  /** Velocity multiplier (default 1). */
  vel?: number;
  /** Transposition in semitones. */
  transpose?: number;
  /** Shift in beats (can be negative: a pickup into the clip). */
  offset?: number;
  /** Note length multiplier. */
  gate?: number;
  /** Start inside the pattern: skips the first `from` beats (e.g. to play only the second half). */
  from?: number;
  /** Articulation(s) added to every note: 'pm', 'ring' ... */
  art?: string | readonly string[];
  /** Play only these parts of a drum pattern. */
  only?: string[];
  /** Map drum part names: { hat: 'hatC' }. */
  rename?: Record<string, string>;
  /** Random timing / velocity variation for this clip, deterministic. */
  humanize?: { time?: number; vel?: number };
  /** Swing for this clip only (overrides the channel / song groove). */
  swing?: number;
}

export interface Groove {
  /** Where the second of each pair of subdivisions falls: 0.5 straight, 0.6 swung, 0.667 triplet shuffle. Default 0.5. */
  swing?: number;
  /** The subdivision that swings, in beats (0.5 = eighth notes, the default; 0.25 = sixteenths). */
  unit?: number;
  /** Constant push (+) or drag (-) in milliseconds for the whole channel (a laid-back snare: +8). */
  push?: number;
  /** Random timing (ms) and velocity (fraction) variation. */
  humanize?: { time?: number; vel?: number };
}

export interface LfoOpts {
  /** Length of one cycle: a note division ('1/8', '1/4.', '2' bars is not valid: use beats) or a number of beats. */
  period?: string | number;
  /** Alternatively: cycles per bar. */
  perBar?: number;
  /** How far the parameter swings each way, in the parameter's unit (or octaves with mode 'exp'). */
  depth: number;
  shape?: LfoWave;
  /** First and last bar of the modulation (default: the whole song). */
  from?: number;
  to?: number;
  /** Phase offset in cycles (0..1). */
  phase?: number;
  /** 'add' (default): value + depth*lfo; 'exp': value * 2^(depth*lfo), for frequency-like parameters. */
  mode?: 'add' | 'exp';
}

type AutoPoint = [bar: number, value: number, curve?: LaneCurve];
const LANE_CURVES = ['lin', 'exp', 'step', 'smooth', 'in', 'out'] as const;

function fxSpec<O extends { name?: string }>(kind: FxKind, opts: O | undefined): FxSpec {
  checkKeys(`fx.${kind}`, opts, FX_KEYS[kind]);
  const o = (opts ?? {}) as O;
  return {
    kind,
    name: o.name ?? kind,
    make: (ctx) => (FX_KINDS[kind] as (c: Ctx, o: unknown) => Effect)(ctx, o),
  };
}

/** Insert effect recipes for `mix.fx`: `s.synth('supersaw-pad', { fx: [fx.chorus(), fx.drive({ drive: 6 })] })`. */
export const fx = {
  drive: (o?: import('./fx').DriveOpts) => fxSpec('drive', o),
  chorus: (o?: import('./fx').ChorusOpts) => fxSpec('chorus', o),
  phaser: (o?: import('./fx').PhaserOpts) => fxSpec('phaser', o),
  crusher: (o?: import('./fx').CrusherOpts) => fxSpec('crusher', o),
  widener: (o?: import('./fx').WidenerOpts) => fxSpec('widener', o),
  /** Rhythmic gate: `fx.gate({ pattern: 'x.xx.x.x' })`. */
  gate: (o: import('./fx').GateOpts) => fxSpec('gate', o),
  filter: (o?: import('./fx').FilterFxOpts) => fxSpec('filter', o),
  delay: (o?: DelayOpts) => fxSpec('delay', o),
  reverb: (o?: import('./fx').ReverbFxOpts) => fxSpec('reverb', o),
  /** The guitar amp and cabinet on any channel: `fx.amp({ gain: 0.8, cab: '4x12' })`. */
  amp: (o?: import('./fx').AmpFxOpts) => fxSpec('amp', o),
};

/** Registry for effect kinds added by other modules (the guitar amp registers itself here). */
export const FX_EXTRA: Record<string, (c: Ctx, o: never) => Effect> = {};
export function customFx(kind: string, name: string, make: (ctx: Ctx) => Effect): FxSpec {
  return { kind, name, make };
}

// ── channel handle ───────────────────────────────────────────────────────────

interface LaneRequest {
  path: string;
  host: ParamHost;
  name: string;
  points: AutoPoint[];
  curve: LaneCurve;
}

/** Mixer options as the Song stores them (effects already instantiated). */
export class ChannelHandle<I extends Instrument = Instrument> {
  /** Position in the song's channel list. */
  index = -1;
  readonly effects: Map<string, Effect> = new Map();
  private grooveOpts: Groove | null = null;
  constructor(
    private readonly song: Song,
    readonly name: string,
    readonly inst: I,
    readonly strip: Strip,
  ) {}

  /** Places a pattern. `at` is a bar number or a Section; `bars` defaults to the section length or the pattern length. */
  play(pattern: Pattern, at: Placement, bars?: number, opts: PlayOpts = {}): this {
    this.song._play(this, pattern, at, bars, opts);
    return this;
  }
  /** One note: `bass.note(8, 'A1', 2)` plays A1 from bar 8 for 2 beats. */
  note(bar: number, note: string | number, beats = 1, vel = 0.8, flags = 0): this {
    this.song._single(this, bar, { t: 0, d: beats, n: typeof note === 'string' ? noteToMidi(note) : note, v: vel, f: flags, part: '' });
    return this;
  }
  /** One drum hit / one-shot: `riser.hit(12, '', 1, 0, 16)` with a length in beats. */
  hit(bar: number, part = '', vel = 0.8, flags = 0, beats = 0.1): this {
    this.song._single(this, bar, { t: 0, d: beats, n: 0, v: vel, f: flags, part });
    return this;
  }
  /**
   * The value an instrument parameter starts with (the preset's own value plus your options, before any automation):
   * `arp.ramp('cutoff', 0, 4, 400, arp.param('cutoff'))` sweeps up from 400 Hz to wherever the preset sits.
   */
  param(name: string): number {
    const v = this.inst.params[name];
    if (v === undefined) {
      const valid = Object.keys(this.inst.specs);
      throw new Error(`${this.name}.param: the instrument has no parameter "${name}".${suggest(name, valid)} Valid: ${valid.join(', ')}`);
    }
    return v;
  }
  /** Automates a parameter: `points` are [bar, value, curve?]. Parameter names: instrument parameters by name, `mix.gain`, `fx.<name>.<param>`. */
  auto(param: string, points: AutoPoint[], curve: LaneCurve = 'lin'): this {
    this.song._auto(`${this.name}.${param}`, points, curve);
    return this;
  }
  /** Ramp between two values over a stretch of bars. */
  ramp(param: string, fromBar: number, toBar: number, fromValue: number, toValue: number, curve: LaneCurve = 'lin'): this {
    return this.auto(param, [[fromBar, fromValue], [toBar, toValue]], curve);
  }
  /** Sets a parameter to a value from a bar on (default: from the start). */
  set(param: string, value: number, bar = 0): this {
    return this.auto(param, [[bar, value]]);
  }
  /** Tempo-synced modulation of a parameter. */
  lfo(param: string, opts: LfoOpts): this {
    this.song._lfo(`${this.name}.${param}`, opts);
    return this;
  }
  /** Swing, push/drag and humanize for this channel. */
  groove(g: Groove): this {
    checkKeys(`${this.name}.groove`, g, GROOVE_KEYS);
    checkKeys(`${this.name}.groove humanize`, g.humanize, HUMANIZE_KEYS);
    this.grooveOpts = g;
    return this;
  }
  get grooveSettings(): Groove | null {
    return this.grooveOpts;
  }
  /** Mutes the channel (handy while composing). */
  mute(on = true): this {
    this.song._mute(this, on);
    return this;
  }
}

export interface BusHandle {
  readonly name: string;
  auto(param: string, points: AutoPoint[], curve?: LaneCurve): BusHandle;
}

// ── the Song ─────────────────────────────────────────────────────────────────

export class Song {
  readonly sr: number;
  readonly bpm: number;
  readonly barBeats: number;
  readonly bars: number;
  readonly meta: TrackMeta;
  /** Deterministic generator for composers who want controlled randomness: `s.rng.next()`. */
  readonly rng: Rng;
  /** Current key (set with `key()`), or null. */
  keySig: Key | null = null;
  readonly transport = new Transport();
  readonly master: MasterBus;
  readonly reverbReturn: ReverbReturn;
  readonly delayReturn: DelayReturn;
  readonly duckEnv: Duck;
  private readonly channels: ChannelHandle[] = [];
  private readonly busList: { name: string; strip: Strip; handle: BusHandle }[] = [];
  private readonly keyFlags: boolean[] = [];
  private readonly mutes: boolean[] = [];
  private readonly busOf: string[] = [];
  private readonly events: EventDef[] = [];
  private readonly laneReqs: LaneRequest[] = [];
  private readonly lfos: LfoDef[] = [];
  private readonly names = new Set<string>();
  private cursor = 0;
  private globalGroove: Groove = {};
  private soloNames: string[] | null = null;
  private readonly sectionList: Section[] = [];

  constructor(meta: TrackMeta, sr: number) {
    this.meta = meta;
    this.sr = sr;
    this.bpm = meta.bpm;
    this.barBeats = barBeatsOf(meta.signature ?? [4, 4]);
    this.bars = meta.bars;
    this.rng = new Rng(`song:${meta.id}`);
    this.master = new MasterBus(sr);
    this.reverbReturn = new ReverbReturn(sr);
    this.delayReturn = new DelayReturn(this.ctx('delay'));
    this.duckEnv = new Duck(sr);
  }

  /** Playback context for something named `name` (the seed is derived from the track id and the name). */
  ctx(name: string): Ctx {
    return { sr: this.sr, bpm: this.bpm, barBeats: this.barBeats, transport: this.transport, seed: hashString(`${this.meta.id}:${name}`) };
  }

  // ── theory ───────────────────────────────────────────────────────────────

  /** Sets the key: `s.key('E', 'minor')`. Scales: major, minor, dorian, phrygian, lydian, mixolydian, locrian, harmonic minor, melodic minor, phrygian dominant, double harmonic ... */
  key(tonic: string, scale = 'minor'): Key {
    this.keySig = new Key(tonic, scale);
    return this.keySig;
  }
  /** MIDI number of a note name: `s.note('A2')` = 45. */
  note(name: string): number {
    return noteToMidi(name);
  }
  /** MIDI notes of a chord symbol: `s.chordNotes('Am7', { octave: 3 })`. */
  chordNotes(symbol: string, opts: VoicingOpts = {}): number[] {
    return voiceChord(parseChord(symbol), opts);
  }
  /** Scale-degree to MIDI in the current key: `s.degree(5, 3)` is the fifth, tonic in octave 3. */
  degree(deg: number, octave = 3, accidental = 0): number {
    if (!this.keySig) throw new Error("s.degree(): set a key first with s.key('E', 'minor')");
    return this.keySig.degree(deg, octave, accidental);
  }

  // ── sections ─────────────────────────────────────────────────────────────

  /** Declares the next section of `bars` bars (sections follow one another from bar 0 unless `startBar` is given). */
  section(name: string, bars: number, startBar?: number): Section {
    const bar = startBar ?? this.cursor;
    if (bar + bars > this.bars + 1e-9) {
      throw new Error(`section "${name}" (bars ${bar}-${bar + bars}) goes past the end of the track (${this.bars} bars): raise "bars" in the track meta or shorten the arrangement`);
    }
    const sec: Section = { name, bar, bars, end: bar + bars };
    this.cursor = Math.max(this.cursor, sec.end);
    this.sectionList.push(sec);
    return sec;
  }
  /** Declares several sections at once: `const S = s.sections({ intro: 8, drop: 16 })` then `S.drop.bar`, `S.drop.bars`. */
  sections<T extends Record<string, number>>(spec: T): { [K in keyof T]: Section } {
    const out: Record<string, Section> = {};
    for (const [k, v] of Object.entries(spec)) out[k] = this.section(k, v);
    return out as { [K in keyof T]: Section };
  }
  get sectionsDeclared(): readonly Section[] {
    return this.sectionList;
  }

  // ── patterns ─────────────────────────────────────────────────────────────

  private pctx(): ParseCtx {
    return { barBeats: this.barBeats, key: this.keySig };
  }
  /** Note pattern in step-grid notation: `s.notes('A1 . A1 A1 | C2 . . .')` (see README). */
  notes(text: string, opts: NoteParseOpts = {}): Pattern {
    checkKeys('s.notes', opts, NOTE_KEYS);
    return parseNotes(text, opts, this.pctx());
  }
  /** Scale-degree pattern in the current key: `s.degrees('1 . 3 5 | 8 . 5 3', { oct: 3 })`. */
  degrees(text: string, opts: NoteParseOpts = {}): Pattern {
    checkKeys('s.degrees', opts, NOTE_KEYS);
    return parseDegrees(text, opts, this.pctx());
  }
  /** Drum pattern with one lane per part: `s.drums({ kick: 'x...x...', snare: '....x...' })`. */
  drums(lanes: Record<string, string>, opts: DrumParseOpts = {}): Pattern {
    checkKeys('s.drums', opts, DRUM_KEYS);
    return parseDrums(lanes, opts, this.pctx());
  }
  /** Hit pattern for a single-part instrument (kick, snare, clap, riser ...): `s.hits('x...x...x...x...')`. */
  hits(text: string, opts: DrumParseOpts = {}): Pattern {
    checkKeys('s.hits', opts, DRUM_KEYS);
    return parseHits(text, opts, this.pctx());
  }
  /** Chord progression: `s.chords('Am | F | C | G', { octave: 3, lead: true })`. */
  chords(text: string, opts: ChordParseOpts = {}): Pattern {
    checkKeys('s.chords', opts, CHORD_KEYS);
    return parseChords(text, opts, this.pctx());
  }
  /** Programmatic pattern builder of `bars` bars: `s.pattern(2).note(0, 'A2', 0.5).hit(1, 'kick').done()`. */
  pattern(bars: number): PatternBuilder {
    return new PatternBuilder(bars * this.barBeats);
  }
  /** An empty pattern of `bars` bars. */
  silence(bars: number): Pattern {
    return Pattern.empty(bars * this.barBeats);
  }
  /** Arpeggiates a chord pattern (see ArpOpts). */
  arp(chords: Pattern, opts: ArpOpts = {}): Pattern {
    checkKeys('s.arp', opts, ARP_KEYS);
    return chords.arp(opts, this.rng.fork('arp'));
  }
  /** Euclidean rhythm string: `s.euclid(5, 16)` -> 'x..x..x..x..x...'; `rotate` moves it later by that many steps. */
  euclid(hits: number, steps: number, rotate = 0): string {
    return euclid(hits, steps, rotate);
  }

  // ── groove ───────────────────────────────────────────────────────────────

  /** Song-wide swing / humanize defaults (channels can override with `ch.groove(...)`). */
  groove(g: Groove): this {
    checkKeys('s.groove', g, GROOVE_KEYS);
    checkKeys('s.groove humanize', g.humanize, HUMANIZE_KEYS);
    this.globalGroove = g;
    return this;
  }

  // ── channels ─────────────────────────────────────────────────────────────

  /**
   * Adds an instrument as a mixer channel. The factories (`s.kick`, `s.synth` ...) call this; use it directly for a custom
   * instrument: `s.add('mine', (ctx) => new MyInstrument(ctx), { gain: -3 })`.
   */
  add<I extends Instrument>(kind: string, make: (ctx: Ctx) => I, mix: MixOpts = {}, key = false, factory = kind): ChannelHandle<I> {
    checkKeys(`s.${factory}: mixer options`, mix, MIX_KEYS);
    checkKeys(`s.${factory}: comp`, mix.comp, COMP_KEYS);
    let name = mix.name ?? kind;
    if (this.names.has(name)) {
      let k = 2;
      while (this.names.has(`${name}${k}`)) k++;
      name = `${name}${k}`;
    }
    this.names.add(name);
    const ctx = this.ctx(name);
    // an error from an instrument, an effect or the strip says which channel it belongs to
    const where = `s.${factory}${name !== kind ? ` (channel "${name}")` : ''}`;
    const inChannel = <T>(what: string, f: () => T): T => {
      try {
        return f();
      } catch (e) {
        throw new Error(`${where}${what}: ${(e as Error).message}`);
      }
    };
    const inst = inChannel('', () => make(ctx));
    mix = { ...(inst.defaultMix ?? {}), ...mix };
    const fxs: Effect[] = [];
    const fxNames = new Set<string>();
    const handle = { effects: new Map<string, Effect>() };
    for (const spec of mix.fx ?? []) {
      let n = spec.name;
      if (fxNames.has(n)) {
        let k = 2;
        while (fxNames.has(`${n}${k}`)) k++;
        n = `${n}${k}`;
      }
      fxNames.add(n);
      const e = inChannel(` fx.${spec.kind}`, () => spec.make(this.ctx(`${name}:${n}`)));
      fxs.push(e);
      handle.effects.set(n, e);
    }
    const strip = inChannel(' mixer options', () => new Strip(ctx, mix, fxs));
    const h = new ChannelHandle<I>(this, name, inst, strip);
    for (const [k, v] of handle.effects) h.effects.set(k, v);
    h.index = this.channels.length;
    this.channels.push(h);
    this.keyFlags.push(mix.key ?? (key || inst.keysByDefault === true));
    this.mutes.push(!!mix.mute);
    this.busOf.push(mix.bus ?? '');
    return h;
  }

  // ── instrument factories ─────────────────────────────────────────────────

  /** Kick drum from a preset name or `{ preset, ...parameters }`. Kicks key the sidechain by default. */
  kick(opts?: DrumOpts | string, mix: MixOpts = {}): ChannelHandle {
    return this.add('kick', (c) => makeDrum('kick', c, opts), mix, true);
  }
  snare(opts?: DrumOpts | string, mix: MixOpts = {}): ChannelHandle {
    return this.add('snare', (c) => makeDrum('snare', c, opts), mix);
  }
  clap(opts?: DrumOpts | string, mix: MixOpts = {}): ChannelHandle {
    return this.add('clap', (c) => makeDrum('clap', c, opts), mix);
  }
  hat(opts?: DrumOpts | string, mix: MixOpts = {}): ChannelHandle {
    return this.add('hat', (c) => makeDrum('hat', c, opts), mix);
  }
  /** Pitched tom: play notes (A2 = the pitch as set; other notes transpose it). */
  tom(opts?: DrumOpts | string, mix: MixOpts = {}): ChannelHandle {
    return this.add('tom', (c) => makeDrum('tom', c, opts), mix);
  }
  /** Crash / ride / splash / china / reverse crash (a preset name picks the cymbal). */
  cymbal(opts?: DrumOpts | string, mix: MixOpts = {}): ChannelHandle {
    return this.add('cymbal', (c) => makeDrum('cymbal', c, opts), mix);
  }
  /** Percussion: rim, clave, cowbell, shaker, tambourine, conga, conga-hi, block, snap. */
  perc(opts?: DrumOpts | string, mix: MixOpts = {}): ChannelHandle {
    return this.add('perc', (c) => makeDrum('perc', c, opts), mix);
  }
  /** Several electronic drums on one channel: `s.drumKit({ kick: 'psy-kick', snare: 'tight-snare', hat: { preset: 'closed-hat', pan: 0.2 } })`. */
  drumKit(parts: Record<string, string | KitPartSpec>, mix: MixOpts = {}): ChannelHandle<DrumKit> {
    return this.add('drums', (c) => new DrumKit(c, parts), mix, false, 'drumKit'); // a kit with a kick part keys the sidechain (on its kick hits only)
  }

  /**
   * The synth: pads, supersaw chords, plucks, arps, leads, FM bells, organs. `s.synth('supersaw-pad')`, or
   * `s.synth({ preset: 'pluck', cutoff: 2400, release: 0.3 })`, or a patch from scratch: `s.synth({ layers: [{ wave: 'saw', unison: 5 }], attack: 0.4 })`.
   */
  synth(opts?: SynthOpts | string, mix: MixOpts = {}): ChannelHandle<Synth> {
    return this.add('synth', (c) => new Synth(c, opts), { name: nameOf(opts), ...mix });
  }

  /** Clean sine/triangle sub bass (presets: sub-sine, sub-saturated, sub-tri, 808-sub). */
  sub(opts?: InstOpts | string, mix: MixOpts = {}): ChannelHandle<SubBass> {
    return this.add('sub', (c) => new SubBass(c, opts), { name: nameOf(opts), ...mix });
  }
  /** Distorted darksynth bass (presets: darksynth-bass, dark-growl, dark-sustain, dark-pluck, dark-clean). */
  darkBass(opts?: InstOpts | string, mix: MixOpts = {}): ChannelHandle<DarkBass> {
    return this.add('darkBass', (c) => new DarkBass(c, opts), { name: nameOf(opts), ...mix });
  }
  /** Detuned-saw reese bass, stereo (presets: reese, reese-wide, reese-dark, reese-neuro). */
  reese(opts?: InstOpts | string, mix: MixOpts = {}): ChannelHandle<ReeseBass> {
    return this.add('reese', (c) => new ReeseBass(c, opts), { name: nameOf(opts), ...mix });
  }
  /** Dubstep growl / wobble bass (presets: dubstep-growl, wub, yoi, riddim, neuro, screech). */
  growl(opts?: GrowlOpts | string, mix: MixOpts = {}): ChannelHandle<GrowlBass> {
    return this.add('growl', (c) => new GrowlBass(c, opts), { name: nameOf(opts), ...mix });
  }
  /** TB-303-style acid bass: use ! for accents and ~ for slides in the pattern (presets: acid-303, goa-acid, acid-soft, acid-square, acid-screamer). */
  acid(opts?: InstOpts | string, mix: MixOpts = {}): ChannelHandle<AcidBass> {
    return this.add('acid', (c) => new AcidBass(c, opts), { name: nameOf(opts), ...mix });
  }

  /** Riser / downlifter / whoosh: the note (or hit) length is the length of the sweep (presets: riser, riser-bright, riser-dark, downlifter, whoosh, noise-wash). */
  riser(opts?: RiserOpts | string, mix: MixOpts = {}): ChannelHandle<Riser> {
    return this.add('riser', (c) => new Riser(c, opts), { name: nameOf(opts), ...mix });
  }
  /** Impact / boom (presets: impact, impact-short, impact-deep, boom). */
  impact(opts?: InstOpts | string, mix: MixOpts = {}): ChannelHandle<Impact> {
    return this.add('impact', (c) => new Impact(c, opts), { name: nameOf(opts), ...mix });
  }
  /** Laser zaps, pitch falls and sirens (presets: zap, zap-fm, siren, pitch-fall). */
  zap(opts?: InstOpts | string, mix: MixOpts = {}): ChannelHandle<Zap> {
    return this.add('zap', (c) => new Zap(c, opts), { name: nameOf(opts), ...mix });
  }
  /**
   * Acoustic drum kit (rock / punk): parts kick, snare, rim, hat (o flag = open), hatC, hatO, hatP, tomHi, tomMid, tomLo, crash,
   * crash2, ride, bell, splash, china. Presets: rock-kit, punk-kit, dry-kit, big-room-kit, garage-kit.
   */
  acousticKit(opts?: AcousticKitOpts | string, mix: MixOpts = {}): ChannelHandle<AcousticKit> {
    return this.add('kit', (c) => new AcousticKit(c, opts), { name: nameOf(opts), ...mix }, false, 'acousticKit');
  }

  /**
   * Electric guitar through an amp and cabinet. Play power chords like [A2,E3,A3] (see guitarChord()) with {pm} for palm mutes.
   * Presets: punk-guitar (double-tracked pair, hard left and right), punk-guitar-L, punk-guitar-R, power-chord-wall, crunch-guitar,
   * clean-guitar, lead-guitar, metal-guitar.
   */
  guitar(opts?: GuitarOpts | string, mix: MixOpts = {}): ChannelHandle<Guitar> {
    return this.add('guitar', (c) => new Guitar(c, opts), { name: nameOf(opts), ...mix });
  }
  /** Bass guitar through a bass amp (presets: punk-bass, rock-bass, finger-bass, dirty-bass). */
  bassGuitar(opts?: BassGuitarOpts | string, mix: MixOpts = {}): ChannelHandle<BassGuitar> {
    return this.add('bass', (c) => new BassGuitar(c, opts), { name: nameOf(opts), ...mix }, false, 'bassGuitar');
  }

  /** A bus (group) channel: route channels to it with `bus: 'name'` in their mix options. */
  bus(name: string, mix: MixOpts = {}): BusHandle {
    if (this.busList.some((b) => b.name === name)) throw new Error(`bus "${name}" already exists`);
    checkKeys(`s.bus("${name}")`, mix, MIX_KEYS);
    checkKeys(`s.bus("${name}"): comp`, mix.comp, COMP_KEYS);
    const ctx = this.ctx(`bus:${name}`);
    const fxs: Effect[] = [];
    try {
      for (const spec of mix.fx ?? []) fxs.push(spec.make(this.ctx(`bus:${name}:${spec.name}`)));
    } catch (e) {
      throw new Error(`s.bus("${name}") fx: ${(e as Error).message}`);
    }
    let strip: Strip;
    try {
      strip = new Strip(ctx, mix, fxs);
    } catch (e) {
      throw new Error(`s.bus("${name}") mixer options: ${(e as Error).message}`);
    }
    const handle: BusHandle = {
      name,
      auto: (param, points, curve = 'lin') => {
        this._auto(`bus.${name}.${param}`, points, curve);
        return handle;
      },
    };
    this.busList.push({ name, strip, handle });
    return handle;
  }

  /** Master chain settings: `s.master({ trim: -2, glue: 0.8 })`. All of them are automatable as `master.<name>`. */
  setMaster(opts: Partial<Record<keyof typeof MASTER_SPECS, number>>): this {
    for (const [k, v] of Object.entries(opts)) this.master.setParam(k, v as number);
    return this;
  }
  /** Shared reverb settings: `s.setReverb({ time: 2.4, return: -9 })`. */
  setReverb(opts: Partial<Record<keyof typeof REVERB_RETURN_SPECS, number>>): this {
    for (const [k, v] of Object.entries(opts)) this.reverbReturn.setParam(k, v as number);
    return this;
  }
  /** Shared delay settings; `time` may be a note division: `s.setDelay({ time: '1/8.', feedback: 0.45 })`. */
  setDelay(opts: { time?: number | string; feedback?: number; pingpong?: number; tone?: number; lowCut?: number; drive?: number; mod?: number; return?: number; duck?: number }): this {
    for (const [k, v] of Object.entries(opts)) this.delayReturn.setParam(k, k === 'time' ? divisionToBeats(v as number | string) : (v as number));
    return this;
  }
  /** Sidechain ducking (keyed by the channels with `key: true`, which kick drums are by default). */
  setSidechain(opts: Partial<Record<keyof typeof DUCK_SPECS, number>>): this {
    for (const [k, v] of Object.entries(opts)) this.duckEnv.setParam(k, v as number);
    return this;
  }
  /**
   * Listens to some channels only (debugging aid; the master chain still applies): `s.solo(bass)`, `s.solo('bass')`, `s.solo([bass, 'kick'])`.
   * `s.solo(null)` listens to everything again. The probe does this for you: `SOLO=bass,kick`.
   */
  solo(what: ChannelHandle | string | readonly (ChannelHandle | string)[] | null): this {
    if (what === null) this.soloNames = null;
    else this.soloNames = (Array.isArray(what) ? (what as readonly (ChannelHandle | string)[]) : [what as ChannelHandle | string]).map((w) => (typeof w === 'string' ? w : w.name));
    return this;
  }
  /** The channels that sound: not muted, and in the solo list when there is one. */
  private audible(i: number): boolean {
    return !this.mutes[i] && (this.soloNames === null || this.soloNames.includes(this.channels[i].name));
  }

  // ── automation ───────────────────────────────────────────────────────────

  /**
   * Automates any parameter by path: `s.auto('bass.cutoff', [[0, 300], [8, 4000, 'exp']])`,
   * `s.auto('master.trim', ...)`, `s.auto('reverb.time', ...)`, `s.auto('lead.mix.gain', ...)`, `s.auto('pad.fx.chorus.depth', ...)`.
   * Points are [bar, value, curve?]; the curve (default `curve`) shapes the move *into* that point: 'lin', 'exp', 'step', 'smooth', 'in', 'out'.
   */
  auto(path: string, points: AutoPoint[], curve: LaneCurve = 'lin'): this {
    this._auto(path, points, curve);
    return this;
  }
  /** Tempo-synced LFO on any parameter path (see LfoOpts). */
  lfo(path: string, opts: LfoOpts): this {
    this._lfo(path, opts);
    return this;
  }

  /** Resolves 'channel.param' / 'channel.mix.param' / 'channel.fx.name.param' / 'master.param' ... to the object that owns the parameter. */
  resolve(path: string): { host: ParamHost; name: string; spec: ParamSpec } {
    const parts = path.split('.');
    const fail = (msg: string): never => {
      throw new Error(`automation path "${path}": ${msg}`);
    };
    const pick = (host: ParamHost, name: string, where: string): { host: ParamHost; name: string; spec: ParamSpec } => {
      const spec = host.specs[name];
      if (!spec) fail(`${where} has no parameter "${name}".${suggest(name, Object.keys(host.specs))} Valid: ${Object.keys(host.specs).join(', ')}`);
      return { host, name, spec };
    };
    const head = parts[0];
    if (head === 'master' && parts.length === 2) return pick(this.master, parts[1], 'the master');
    if (head === 'reverb' && parts.length === 2) return pick(this.reverbReturn, parts[1], 'the reverb');
    if (head === 'delay' && parts.length === 2) return pick(this.delayReturn, parts[1], 'the delay');
    if (head === 'duck' && parts.length === 2) return pick(this.duckEnv, parts[1], 'the sidechain');
    if (head === 'bus' && parts.length >= 3) {
      const b = this.busList.find((x) => x.name === parts[1]);
      if (!b) return fail(`no bus "${parts[1]}"`);
      const rest = parts.slice(2);
      if (rest[0] === 'mix' && rest.length === 2) return pick(b.strip, rest[1], `bus ${b.name}`);
      return fail(`use bus.<name>.mix.<param>`);
    }
    const ch = this.channels.find((c) => c.name === head);
    if (!ch) {
      const names = [...this.channels.map((c) => c.name), 'master', 'reverb', 'delay', 'duck', 'bus'];
      return fail(`no channel called "${head}".${suggest(head, names)} Known: ${names.join(', ')}`);
    }
    const rest = parts.slice(1);
    if (rest.length === 1) return pick(ch.inst, rest[0], `instrument "${ch.name}"`);
    if (rest[0] === 'mix' && rest.length === 2) return pick(ch.strip, rest[1], `the mixer strip of "${ch.name}"`);
    if (rest[0] === 'fx' && rest.length === 3) {
      const e = ch.effects.get(rest[1]);
      if (!e) return fail(`channel "${ch.name}" has no effect "${rest[1]}". Effects: ${[...ch.effects.keys()].join(', ') || '(none)'}`);
      return pick(e, rest[2], `effect "${rest[1]}"`);
    }
    // drum kits name their parameters `part.param` (kick.decay), so the rest of the path is the parameter name
    if (rest.length >= 2 && rest[0] !== 'mix' && rest[0] !== 'fx') return pick(ch.inst, rest.join('.'), `instrument "${ch.name}"`);
    return fail('expected channel.param, channel.mix.param or channel.fx.name.param');
  }

  /** @internal */
  _auto(path: string, points: AutoPoint[], curve: LaneCurve): void {
    const r = this.resolve(path);
    if (!points.length) throw new Error(`automation "${path}": no points`);
    pickWord(`automation "${path}"`, 'curve', curve, LANE_CURVES, 'lin');
    let last = -Infinity;
    for (const p of points) {
      if (!(p[0] >= last)) throw new Error(`automation "${path}": bars must not go backwards (${p[0]} after ${last})`);
      if (!Number.isFinite(p[1])) throw new Error(`automation "${path}": value ${p[1]} is not a number`);
      if (p[1] < r.spec.min - 1e-9 || p[1] > r.spec.max + 1e-9) throw rangeError(`automation "${path}", the point at bar ${p[0]}`, r.name, p[1], r.spec);
      if (p[2] !== undefined) pickWord(`automation "${path}", the point at bar ${p[0]}`, 'curve', p[2], LANE_CURVES);
      last = p[0];
      if (p[0] < 0 || p[0] > this.bars + 1e-9) throw new Error(`automation "${path}": bar ${p[0]} is outside the track (it ends at bar ${this.bars}: bars 0 to ${this.bars - 1} exist)`);
    }
    this.laneReqs.push({ path, host: r.host, name: r.name, points, curve });
  }

  /** @internal */
  _lfo(path: string, o: LfoOpts): void {
    checkKeys(`lfo "${path}"`, o, LFO_KEYS);
    const r = this.resolve(path);
    let rate: number;
    if (o.perBar !== undefined) rate = o.perBar / this.barBeats;
    else if (o.period !== undefined) rate = 1 / divisionToBeats(o.period);
    else throw new Error(`lfo "${path}": give a period ('1/8', 1.5 ...) or perBar`);
    this.lfos.push({
      host: r.host,
      name: r.name,
      startBeat: (o.from ?? 0) * this.barBeats,
      endBeat: (o.to ?? this.bars) * this.barBeats,
      rate,
      depth: o.depth,
      shape: pickWord(`lfo "${path}"`, 'shape', o.shape, LFO_SHAPES, 'sine'),
      phase: o.phase ?? 0,
      mode: pickWord(`lfo "${path}"`, 'mode', o.mode, ['add', 'exp'] as const, 'add'),
      path,
    });
  }

  /** @internal */
  _mute(h: ChannelHandle, on: boolean): void {
    this.mutes[h.index] = on;
  }

  // ── event generation ─────────────────────────────────────────────────────

  private warp(beat: number, g: Groove): number {
    const swing = g.swing ?? 0.5;
    if (Math.abs(swing - 0.5) < 1e-9) return beat;
    const unit = g.unit ?? 0.5;
    const period = unit * 2;
    const base = Math.floor(beat / period + 1e-9) * period;
    const ph = beat - base;
    const split = swing * period;
    return base + (ph <= unit ? (ph * split) / unit : split + ((ph - unit) * (period - split)) / unit);
  }

  /** @internal */
  _play(ch: ChannelHandle, pattern: Pattern, at: Placement, bars: number | undefined, o: PlayOpts): void {
    if (at === undefined || at === null || (typeof at === 'number' && !Number.isFinite(at)) || (typeof at === 'object' && !Number.isFinite(at.bar))) {
      const names = this.sectionList.map((x) => x.name);
      throw new Error(`${ch.name}.play: where? "at" must be a bar number or a section (S.verse), got ${String(at)}: a misspelt section name? ${names.length ? `The sections are: ${names.join(', ')}.` : 'No sections are declared (s.sections({ ... })).'}`);
    }
    checkKeys(`${ch.name}.play`, o, PLAY_KEYS);
    checkKeys(`${ch.name}.play humanize`, o.humanize, HUMANIZE_KEYS);
    const startBar = typeof at === 'number' ? at : at.bar;
    const nBars = bars ?? (typeof at === 'number' ? Math.max(1, Math.ceil(pattern.beats / this.barBeats - 1e-9)) : at.bars);
    if (!(nBars > 0)) throw new Error(`${ch.name}.play: bars must be positive`);
    const span = nBars * this.barBeats;
    const startBeat = startBar * this.barBeats;
    if (startBar < -1e-9 || startBar + nBars > this.bars + 1e-9) {
      throw new Error(`${ch.name}.play: the clip runs from bar ${startBar} to bar ${startBar + nBars}, but the track ends at bar ${this.bars} (bars 0 to ${this.bars - 1} exist). Raise "bars" in the track meta or shorten the clip.`);
    }
    if (!(pattern.beats > 0)) throw new Error(`${ch.name}.play: the pattern is empty (0 beats long)`);
    let p = pattern;
    if (o.from) {
      if (!(o.from > 0 && o.from < pattern.beats)) {
        throw new Error(`${ch.name}.play: from ${o.from} is outside the pattern (it is ${pattern.beats} beats long: use 0 <= from < ${pattern.beats})`);
      }
      p = p.slice(o.from, p.beats).over(span);
    } else p = p.over(span);
    const g: Groove = { ...this.globalGroove, ...(ch.grooveSettings ?? {}) };
    if (o.swing !== undefined) g.swing = o.swing;
    const hum = o.humanize ?? g.humanize;
    const rng = this.rng.fork(`play:${ch.name}:${startBar}:${this.events.length}`);
    const pushBeats = ((g.push ?? 0) / 1000) * (this.bpm / 60) + (o.offset ?? 0);
    const artFlags = o.art ? articulation(o.art) : 0;
    const vmul = o.vel ?? 1;
    const gm = o.gate ?? 1;
    const tr = o.transpose ?? 0;
    for (const e0 of p.events) {
      if (o.only && !o.only.includes(e0.part)) continue;
      const part = o.rename && o.rename[e0.part] !== undefined ? o.rename[e0.part] : e0.part;
      let t = startBeat + e0.t;
      let end = t + e0.d * gm;
      t = this.warp(t, g);
      end = this.warp(end, g);
      let v = e0.v * vmul;
      if (hum) {
        if (hum.time) {
          const jitter = (rng.bi() * hum.time * (this.bpm / 60)) / 1000;
          const t0 = t;
          t = t >= 0 ? Math.max(0, t + jitter) : t + jitter; // a note on the very first beat is not pushed out in front of the song and lost
          end += t - t0; // the whole note moves: a late start must not eat into its length, nor its end cut the next note of the same pitch
        }
        if (hum.vel) v *= 1 + rng.bi() * hum.vel;
      }
      t += pushBeats;
      end += pushBeats;
      if (t < 0) continue;
      this.emit(ch, { ...e0, n: e0.n + tr, v: Math.max(0, Math.min(1, v)), f: e0.f | artFlags, part }, t, Math.max(end - t, 0.005), startBeat + span);
    }
  }

  /** @internal */
  _single(ch: ChannelHandle, bar: number, e: PEvt): void {
    if (bar < 0 || bar >= this.bars) throw new Error(`${ch.name}: bar ${bar} is outside the track (it ends at bar ${this.bars}: bars 0 to ${this.bars - 1} exist)`);
    this.emit(ch, e, bar * this.barBeats, e.d, Infinity);
  }

  private emit(ch: ChannelHandle, e: PEvt, t: number, d: number, clipEnd: number): void {
    const parts = ch.inst.parts;
    if (e.part !== '' && parts && !parts.includes(e.part)) {
      throw new Error(`${ch.name}: this instrument has no part "${e.part}".${suggest(e.part, parts)} Parts: ${parts.join(', ')}`);
    }
    if (e.part !== '' && !parts) {
      throw new Error(`${ch.name}: "${e.part}" is a drum part name but this instrument takes notes (use s.notes(...), not s.drums(...))`);
    }
    const isHit = e.part !== '' || (parts !== undefined && e.n === 0);
    if (isHit) {
      this.events.push({ beat: t, kind: 'hit', ch: ch.index, note: 0, vel: e.v, durBeats: d, flags: e.f, part: e.part });
      return;
    }
    const off = Math.min(t + d, clipEnd);
    this.events.push({ beat: t, kind: 'on', ch: ch.index, note: e.n, vel: e.v, durBeats: Math.max(0.005, off - t), flags: e.f, part: '' });
    this.events.push({ beat: off, kind: 'off', ch: ch.index, note: e.n, vel: 0, durBeats: 0, flags: e.f, part: '' });
  }

  // ── compile ──────────────────────────────────────────────────────────────

  /**
   * Which slide-marked notes tie to a note before them, and which note ends that removes. For the instruments that tie slides (the mono
   * basses and the synth in mono / legato mode) a slid note ties to a note of the same channel that is still sounding when it starts, or
   * that ended up to 15 ms before: humanize moves starts but not ends. Where a slide does nothing (a polyphonic synth) no note is tied. For the
   * others (guitars, custom instruments) only a note that ends exactly where the slid one starts is.
   */
  private tieSlides(): { tied: Set<EventDef>; drop: Set<EventDef> } {
    const TOL = (0.015 * this.bpm) / 60; // 15 ms in beats
    const tied = new Set<EventDef>();
    const drop = new Set<EventDef>();
    const ev = this.events;
    let byChannel: Map<number, number[]> | null = null; // per channel: the index of every note-on (its note-off follows it)
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (e.kind !== 'on' || !(e.flags & FLAG.SLIDE)) continue;
      if (!byChannel) {
        byChannel = new Map();
        for (let j = 0; j + 1 < ev.length; j++) {
          if (ev[j].kind !== 'on' || ev[j + 1].kind !== 'off') continue;
          const list = byChannel.get(ev[j].ch);
          if (list) list.push(j);
          else byChannel.set(ev[j].ch, [j]);
        }
      }
      const kind = this.channels[e.ch].inst.slides;
      if (kind === 'none') continue; // a slide mark does nothing here: the note before it ends as written
      const exact = kind !== 'tie';
      for (const j of byChannel.get(e.ch) ?? []) {
        if (j === i) continue;
        const on = ev[j];
        const off = ev[j + 1];
        if (exact) {
          if (Math.abs(off.beat - e.beat) < 1e-6) drop.add(off);
        } else if (on.beat < e.beat - 1e-9 && off.beat >= e.beat - TOL) {
          tied.add(e);
          if (off.beat <= e.beat + 1e-9) drop.add(off);
        }
      }
    }
    return { tied, drop };
  }

  /** Builds the renderer. */
  toRenderer(opts: { startFrame?: number } = {}): AlbumRenderer {
    const meta = this.meta;
    const sig = meta.signature ?? [4, 4];
    const tail = meta.tail ?? 3;
    const seconds = (this.bars * barBeatsOf(sig) * 60) / this.bpm + tail;
    const frames = Math.round(seconds * this.sr);
    // mono slides: a note with the SLIDE flag ties to the note before it (that note's end is dropped, so the instrument glides)
    const { drop } = this.tieSlides();
    const events = this.events.filter((e) => !drop.has(e));
    if (this.soloNames) {
      const known = this.channels.map((c) => c.name);
      for (const n of this.soloNames) if (!known.includes(n)) throw new Error(`solo: no channel called "${n}".${suggest(n, known)} Channels: ${known.join(', ')}`);
    }
    const lanes: LaneDef[] = this.laneReqs.map((r) => ({
      host: r.host,
      name: r.name,
      t: r.points.map((p) => p[0] * this.barBeats),
      v: r.points.map((p) => p[1]),
      curve: r.points.map((p, i) => (i === 0 ? 'lin' : (p[2] ?? r.curve))),
    }));
    // tell instruments with heavy parts (the acoustic kit's cymbal buffers) which parts this track really uses
    const usedParts = new Map<number, Set<string>>();
    for (const e of this.events) {
      if (e.kind === 'hit' || e.part !== '') {
        let u = usedParts.get(e.ch);
        if (!u) usedParts.set(e.ch, (u = new Set()));
        u.add(e.part === '' ? 'kick' : e.part);
      }
    }
    this.channels.forEach((c, i) => c.inst.prepare?.(usedParts.get(i) ?? new Set()));
    const busIndex = new Map(this.busList.map((b, i) => [b.name, i]));
    const prog: Program = {
      sr: this.sr,
      frames,
      bpm: this.bpm,
      channels: this.channels.map((c, i) => {
        const bn = this.busOf[i];
        if (bn && !busIndex.has(bn)) throw new Error(`channel "${c.name}" is routed to bus "${bn}" which does not exist (create it with s.bus("${bn}", ...) first)`);
        const muted = !this.audible(i);
        return { name: c.name, inst: c.inst, strip: c.strip, bus: bn ? (busIndex.get(bn) as number) : -1, key: this.keyFlags[i], mute: muted };
      }),
      buses: this.busList.map((b) => ({ name: b.name, strip: b.strip })),
      events,
      lanes,
      lfos: this.lfos,
      reverb: this.reverbReturn,
      delay: this.delayReturn,
      duck: this.duckEnv,
      master: this.master,
      transport: this.transport,
      fadeIn: meta.fadeIn ?? 0.0005,
      fadeOut: meta.fadeOut ?? Math.min(tail, 2.5),
    };
    return new AlbumRenderer(prog, opts);
  }

  /**
   * Text summary of the arrangement: for each section the channels that play in it, with the number of notes or hits and how many carry
   * an articulation: `gtrL(64: 40 pm, 2 slide)` is 64 notes of which 40 are palm-muted and 2 slide (for checking your work: the probe prints it).
   * A muted channel is marked `[muted]`; slide marks that do nothing (no note right before them) are counted as `slide(not tied)`
   * and explained in a `warning:` line at the end.
   */
  describe(): string {
    const lines: string[] = [];
    const secs = this.sectionList.length ? this.sectionList : [{ name: 'song', bar: 0, bars: this.bars, end: this.bars }];
    const FLAG_NAMES: [number, string][] = [
      [FLAG.MUTE, 'pm'],
      [FLAG.RING, 'ring'],
      [FLAG.SLIDE, 'slide'],
      [FLAG.GHOST, 'ghost'],
      [FLAG.ACCENT, 'accent'],
      [FLAG.UP, 'up'],
      [FLAG.OPEN, 'open'],
      [FLAG.RIM, 'rim'],
      [FLAG.FLAM, 'flam'],
      [FLAG.STACCATO, 'stac'],
    ];
    const { tied } = this.tieSlides();
    const lost = new Map<number, number>(); // channel -> slide marks that do nothing
    const listed = (ch: number): boolean => this.soloNames === null || this.soloNames.includes(this.channels[ch].name); // a solo render lists only what sounds
    for (const s of secs) {
      const b0 = s.bar * this.barBeats;
      const b1 = s.end * this.barBeats;
      const counts = new Map<number, { n: number; flags: number[]; lost: number }>();
      for (const e of this.events) {
        if (e.kind === 'off' || e.beat < b0 - 1e-9 || e.beat >= b1 - 1e-9 || !listed(e.ch)) continue;
        let c = counts.get(e.ch);
        if (!c) counts.set(e.ch, (c = { n: 0, flags: FLAG_NAMES.map(() => 0), lost: 0 }));
        c.n++;
        const kind = this.channels[e.ch].inst.slides;
        const slideLost = e.kind === 'on' && (e.flags & FLAG.SLIDE) !== 0 && (kind === 'none' || (kind === 'tie' && !tied.has(e)));
        if (slideLost) {
          c.lost++;
          lost.set(e.ch, (lost.get(e.ch) ?? 0) + 1);
        }
        FLAG_NAMES.forEach(([bit], i) => {
          if ((e.flags & bit) === 0 || (bit === FLAG.SLIDE && slideLost)) return;
          c!.flags[i]++;
        });
      }
      const text = [...counts.keys()]
        .sort((x, y) => x - y)
        .map((ch) => {
          const c = counts.get(ch)!;
          const fl = FLAG_NAMES.map(([, name], i) => (c.flags[i] ? `${c.flags[i]} ${name}` : '')).filter(Boolean);
          if (c.lost) fl.push(`${c.lost} slide(${this.channels[ch].inst.slides === 'none' ? 'ignored' : 'not tied'})`);
          return `${this.channels[ch].name}(${c.n}${fl.length ? `: ${fl.join(', ')}` : ''})${this.audible(ch) ? '' : ' [muted]'}`;
        })
        .join(' ');
      lines.push(`${String(s.bar).padStart(3)}-${String(s.end).padEnd(3)} ${s.name.padEnd(14)} ${text}`);
    }
    for (const [ch, n] of lost) {
      const c = this.channels[ch];
      lines.push(
        c.inst.slides === 'none'
          ? `warning: ${c.name} has ${n} slide marks (~) that do nothing: this synth is polyphonic, a slide needs mode: 'mono' or 'legato'`
          : `warning: ${c.name} has ${n} slide marks (~) that are not tied to a note right before them, so they only retrigger: put ~ on the note you glide INTO, directly after another note (no rest between)`,
      );
    }
    return lines.join('\n');
  }

  /**
   * One line per automation lane and LFO: the path, the points as bar:value (with the curve into each point) or the LFO settings.
   * Use it to confirm that what you wrote was registered where you meant it (the probe prints it).
   */
  describeAutomation(): string {
    const num = (x: number): string => String(Math.round(x * 1000) / 1000);
    const lines: string[] = [];
    for (const r of this.laneReqs) {
      lines.push(`${r.path}: ${r.points.map((p, i) => `${num(p[0])}:${num(p[1])}${i > 0 && (p[2] ?? r.curve) !== 'lin' ? `(${p[2] ?? r.curve})` : ''}`).join(' ')}${r.points.length === 1 ? ' (a set: held from here on)' : ''}`);
    }
    for (const o of this.lfos) {
      const per = o.rate > 0 ? `${num(1 / o.rate)} beats` : 'static';
      lines.push(`${o.path ?? o.name}: lfo ${o.shape} every ${per}, depth ${num(o.depth)}${o.mode === 'exp' ? ' octaves' : ''}, bars ${num(o.startBeat / this.barBeats)}-${num(o.endBeat / this.barBeats)}`);
    }
    return lines.join('\n');
  }

  /** Channel handles (for tools and tests). */
  get channelList(): readonly ChannelHandle[] {
    return this.channels;
  }
  get eventCount(): number {
    return this.events.length;
  }

  /**
   * The harmony check, for composers who cannot listen: every place where two pitched notes sound together a minor second or a
   * minor ninth apart (the intervals that sound like a wrong note: C over B, Db over C), and, below C3, a major second (two bass
   * notes a tone apart are mud). It reads the score, not the audio: notes from their start to their end (not the release tails),
   * sampled on every sixteenth; drum channels and muted channels are left out, and so are ghost notes (`?`) and notes quieter than `minVel`. Lines
   * are grouped by bar: `bar 33 (beat 2.75): lead C5 / saws Db4, minor 9th`; a pair that repeats is listed once per bar with a count.
   * With `layers` (the probe's CLASH=2), an instrument's layers above the written note (`supersaw-chord` sounds every note an octave up
   * too: `Instrument.pitches`) are checked against the other channels' written notes, marked `(octave layer)`: a harmony line a semitone
   * under the chords' upper octave. Off by default: a layer blends into its note, so these are milder than a clash of written notes.
   * The probe prints it with CLASH=1. A clash can be meant (a passing note, an appoggiatura): the list says where to look.
   */
  clashes(opts: { maxLines?: number; minVel?: number; layers?: boolean } = {}): string {
    const minVel = opts.minVel ?? 0.25;
    const maxLines = opts.maxLines ?? 60;
    const pitched = this.channels.map((c, i) => !c.inst.parts && !this.mutes[i] && (this.soloNames === null || this.soloNames.includes(c.name)));
    // with `layers`, the upper octave layers of an instrument too (a sub-octave layer blends into its note; it is not checked)
    const offsets = this.channels.map((c) => (opts.layers && c.inst.pitches ? [0, ...c.inst.pitches.filter((o) => o > 0)] : [0]));
    // every sounding pitch: the note itself, and the octave layers of its instrument ("layer": offset other than 0)
    interface Sounding { beat: number; end: number; ch: number; n: number; src: EventDef; layer: boolean }
    const sounding: Sounding[] = [];
    for (const e of this.events) {
      if (e.kind !== 'on' || !pitched[e.ch] || e.vel < minVel || e.flags & FLAG.GHOST) continue;
      for (const o of offsets[e.ch]) sounding.push({ beat: e.beat, end: e.beat + e.durBeats, ch: e.ch, n: e.note + o, src: e, layer: o !== 0 });
    }
    sounding.sort((a, b) => a.beat - b.beat);
    const step = 0.25;
    const total = this.bars * this.barBeats;
    const byBar = new Map<number, Map<string, { beat: number; count: number }>>();
    const nameOf = (x: Sounding): string => `${this.channels[x.ch].name} ${midiToName(x.n, true)}${x.layer ? ' (octave layer)' : ''}`;
    let active: Sounding[] = [];
    let next = 0;
    for (let k = 0; k * step < total - 1e-9; k++) {
      const t = k * step + 0.02;
      while (next < sounding.length && sounding[next].beat <= t) active.push(sounding[next++]);
      active = active.filter((e) => e.end > t);
      for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
          const a = active[i];
          const b = active[j];
          if (a.src === b.src) continue; // one note's own layers
          if (a.layer && b.layer) continue; // two layers: colour, not a wrong note
          if (a.ch === b.ch && (a.layer || b.layer)) continue; // a chord against its own octave layers is the patch's colour
          const d = Math.abs(a.n - b.n);
          const lo = Math.min(a.n, b.n);
          const what = d === 1 ? 'minor 2nd' : d === 13 ? 'minor 9th' : d === 2 && lo < 48 ? 'major 2nd in the bass' : '';
          if (!what) continue;
          const [x, y] = a.n >= b.n ? [a, b] : [b, a];
          const key = `${nameOf(x)} / ${nameOf(y)}, ${what}`;
          const bar = Math.floor(t / this.barBeats);
          let m = byBar.get(bar);
          if (!m) byBar.set(bar, (m = new Map()));
          const hit = m.get(key);
          if (hit) hit.count++;
          else m.set(key, { beat: Math.round((t - bar * this.barBeats) / step) * step + 1, count: 1 });
        }
      }
    }
    const lines: string[] = [];
    let n = 0;
    for (const bar of [...byBar.keys()].sort((a, b) => a - b)) {
      for (const [key, v] of byBar.get(bar)!) {
        n++;
        if (lines.length < maxLines) lines.push(`bar ${bar} (beat ${v.beat}): ${key}${v.count > 1 ? ` (${v.count} sixteenths)` : ''}`);
      }
    }
    if (n > lines.length) lines.push(`... ${n - lines.length} more`);
    return n ? lines.join('\n') : 'no clashes';
  }
}

void Bus;
void Channel;
void REVERB_RETURN_SPECS;
void STRIP_SPECS;
void midiToName;
void ({} as ChordInfo);
void ({} as FxKind);
void ({} as DrumType);
