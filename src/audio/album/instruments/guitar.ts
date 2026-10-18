/**
 * Electric guitar and bass guitar.
 *
 * Guitar: plucked-string waveguides (dsp/string.ts: extended Karplus-Strong with pick position, pickup comb, damping and palm
 * muting) summed like a pickup, into an amp model (noise gate, tight high-pass, screamer-style boost, three asymmetric gain
 * stages at 2x oversampling, tone stack, sagging power amp) and a cabinet (dsp/amp.ts). Chords are strummed (the strings of
 * a chord start a few milliseconds apart, low to high, or high to low with the up flag). Two takes (double-tracked: their own
 * strings, timing and tuning errors, panned hard left and right) are the default.
 *
 * Articulations (pattern flags): palm mute {pm}, let ring {ring}, ghost / dead note ?, accent !, slide into the note ~, up-stroke {up}.
 * Notes are MIDI pitches: a power chord is [A2,E3,A3]; `guitarChord('A5')` / `guitarChord('Em')` give playable voicings.
 */
import { Rng, dbToLin, mtof } from '../dsp/core';
import { Biquad } from '../dsp/filters';
import { KsString, PluckParams } from '../dsp/string';
import { AMP_DEFAULTS, AmpParams, BassAmp, BassAmpParams, CabType, GuitarAmp } from '../dsp/amp';
import { BLOCK, Ctx, FLAG, Instrument, ParamBase, ParamSpecs, PresetDef, pickWord, resolveOpts } from '../instrument';

export const GUITAR_SPECS = {
  level: { default: 0, min: -30, max: 12, unit: 'dB', doc: 'Trim in dB on top of the preset\'s calibrated loudness (0 = as calibrated; the fader is the channel\'s `gain` in the mix).' },
  gain: { default: 0.65, min: 0, max: 1, doc: 'Amp gain: 0 clean, 0.3 crunch, 0.6 punk / hard rock, 0.85 high-gain metal.' },
  tight: { default: 0.5, min: 0, max: 1, doc: 'How much low end is cut before the distortion (tighter, more focused chugs).' },
  bass: { default: 0, min: -12, max: 12, unit: 'dB', doc: 'Tone stack: bass.' },
  mid: { default: 1, min: -12, max: 12, unit: 'dB', doc: 'Tone stack: mids (negative = scooped metal tone, positive = honky rock).' },
  treble: { default: -0.5, min: -12, max: 12, unit: 'dB', doc: 'Tone stack: treble.' },
  presence: { default: -1.5, min: -12, max: 12, unit: 'dB', doc: 'Tone stack: presence (the fizz and air on top).' },
  boost: { default: 0.4, min: 0, max: 1, doc: 'Screamer-style mid boost in front of the amp: focus and push.' },
  sag: { default: 0.4, min: 0, max: 1, doc: 'Power-amp sag: compression and softness on loud notes.' },
  gate: { default: -62, min: -90, max: -30, unit: 'dB', doc: 'Noise-gate threshold (-90 = off): cuts the hiss-like tail of a note that is fading out.' },
  cabBright: { default: 0, min: -1, max: 1, doc: 'Cabinet brightness (mic nearer the centre of the speaker cone = brighter).' },
  decay: { default: 2.6, min: 0.3, max: 8, unit: 's', doc: 'How long an open string rings (time to -60 dB).' },
  bright: { default: 0.55, min: 0, max: 1, doc: 'Brightness of the strings: how well the high harmonics survive.' },
  pickPos: { default: 0.17, min: 0.05, max: 0.5, doc: 'Where the string is picked (near the bridge = thinner and brighter).' },
  pickHard: { default: 0.65, min: 0, max: 1, doc: 'Pick hardness (attack brightness).' },
  pickup: { default: 0.14, min: 0, max: 0.35, doc: 'Pickup position from the bridge (0 = off; neck pickups are further).' },
  strum: { default: 7, min: 0, max: 40, unit: 'ms', doc: 'Time between the strings of a strummed chord.' },
  timing: { default: 4, min: 0, max: 30, unit: 'ms', doc: 'Random timing error of each take (the looseness of a human double-track).' },
  detune: { default: 3, min: 0, max: 20, unit: 'cents', doc: 'Random tuning error of each take.' },
  muteDecay: { default: 0.16, min: 0.04, max: 0.6, unit: 's', doc: 'Ring time of palm-muted notes.' },
  releaseDamp: { default: 0.04, min: 0.01, max: 0.5, unit: 's', doc: 'How quickly the strings are silenced at the end of a note (unless {ring}).' },
  attackBend: { default: 0.12, min: 0, max: 1, unit: 'semitones', doc: 'Sharpness of a hard-picked string at the very start (it settles within 40 ms).' },
  velocity: { default: 0.7, min: 0, max: 1, doc: 'How much velocity changes the picking strength and brightness.' },
  width: { default: 1, min: 0, max: 1, doc: 'Stereo width of a double-tracked pair (1 = hard left and right, 0 = both in the centre).' },
} satisfies ParamSpecs;

export interface GuitarOpts {
  preset?: string;
  name?: string;
  /** 1 = a single guitar (mono), 2 = a double-tracked pair hard left and right (stereo, the default). */
  takes?: 1 | 2;
  /** Cabinet: '4x12' (default), '2x12', '1x12', 'none'. */
  cab?: CabType;
  /** Strings that can sound at once per take (default 8). */
  voices?: number;
  /** Default channel pan for a single take (the preset 'punk-guitar-L' sets -1). */
  pan?: number;
  [param: string]: unknown;
}

/** Level of the pickup signal into the amp (a real pickup gives a few hundred millivolts: leave headroom in front of the gain stages). */
const PICKUP_LEVEL = 0.12;

interface Pending {
  delay: number; // samples until the string starts (relative to the start of the current segment)
  note: number;
  vel: number;
  flags: number;
  released: boolean;
  take: number;
}

class Take {
  readonly strings: KsString[] = [];
  readonly amp: GuitarAmp;
  readonly buf = new Float64Array(BLOCK);
  readonly pickupF = new Biquad();
  readonly pickupL = new Biquad();
  readonly notes: number[] = [];
  readonly flagsOf: number[] = [];
  /** Unit tuning error in [-1, 1]; scaled by the detune parameter when a note starts. */
  readonly tuning: number;
  constructor(sr: number, voices: number, seed: number, ampP: Partial<AmpParams>, tuningUnit: number) {
    for (let i = 0; i < voices; i++) {
      this.strings.push(new KsString(sr, 38, seed + i * 7919));
      this.notes.push(-1);
      this.flagsOf.push(0);
    }
    this.amp = new GuitarAmp(sr, ampP);
    this.pickupF.peaking(3000, 1.4, 2.5, sr);
    this.pickupL.lowpass(8500, 0.7, sr);
    this.tuning = tuningUnit;
  }
}

export class Guitar extends ParamBase<typeof GUITAR_SPECS> implements Instrument {
  readonly stereo: boolean;
  /** A `~` note scoops up into its pitch by itself; it needs no note before it. */
  readonly slides = 'scoop' as const;
  readonly defaultMix?: { pan?: number };
  private readonly sr: number;
  private readonly takes: Take[] = [];
  private readonly rng: Rng;
  private readonly pending: Pending[] = [];
  private readonly chordBuf: { note: number; vel: number; flags: number }[] = [];
  private readonly out = new Float64Array(BLOCK);
  private lastAmp = '';

  constructor(ctx: Ctx, input?: GuitarOpts | string) {
    const o = resolveOpts('guitar', GUITAR_PRESETS, input ?? 'punk-guitar', GUITAR_SPECS, ['takes', 'cab', 'voices', 'pan']);
    super('Guitar', GUITAR_SPECS, o);
    this.sr = ctx.sr;
    this.rng = new Rng(ctx.seed);
    if (o.takes !== undefined && o.takes !== 1 && o.takes !== 2) throw new Error(`guitar: option "takes" is ${String(o.takes)}: use 1 (one mono take) or 2 (a double-tracked pair)`);
    const nTakes = (o.takes as number) === 1 ? 1 : 2;
    this.stereo = nTakes === 2;
    const voices = Math.max(3, Math.min(12, Math.round((o.voices as number) ?? 8)));
    const cab: CabType = pickWord('guitar', 'cab', o.cab, ['4x12', '2x12', '1x12', 'none'] as const, '4x12');
    for (let t = 0; t < nTakes; t++) {
      const tune = this.rng.bi();
      this.takes.push(new Take(ctx.sr, voices, ctx.seed + t * 104729, { ...AMP_DEFAULTS, cab }, tune));
    }
    if (typeof o.pan === 'number') this.defaultMix = { pan: o.pan };
    this.syncAmp(true);
  }

  private syncAmp(force: boolean): void {
    const p = this.params;
    const key = `${p.gain}|${p.tight}|${p.bass}|${p.mid}|${p.treble}|${p.presence}|${p.boost}|${p.sag}|${p.gate}|${p.cabBright}`;
    if (!force && key === this.lastAmp) return;
    this.lastAmp = key;
    for (const t of this.takes) {
      const a = t.amp;
      a.setParam('gain', p.gain);
      a.setParam('tight', p.tight);
      a.setParam('bass', p.bass);
      a.setParam('mid', p.mid);
      a.setParam('treble', p.treble);
      a.setParam('presence', p.presence);
      a.setParam('boost', p.boost);
      a.setParam('sag', p.sag);
      a.setParam('gate', p.gate);
      a.setParam('cabBright', p.cabBright);
    }
  }

  noteOn(note: number, vel: number, _dur: number, flags: number): void {
    this.chordBuf.push({ note, vel, flags });
  }

  noteOff(note: number): void {
    // strings of this pitch: damp them unless they were played with {ring}
    for (let ti = 0; ti < this.takes.length; ti++) {
      const t = this.takes[ti];
      for (let i = 0; i < t.strings.length; i++) {
        if (t.notes[i] === note && t.strings[i].active && !(t.flagsOf[i] & FLAG.RING)) t.strings[i].damp(this.params.releaseDamp);
      }
    }
    for (const p of this.pending) if (p.note === note && !(p.flags & FLAG.RING)) p.released = true;
    for (let i = this.chordBuf.length - 1; i >= 0; i--) if (this.chordBuf[i].note === note && !(this.chordBuf[i].flags & FLAG.RING)) this.chordBuf[i].flags |= 1 << 20; // ended in the same instant
  }

  hit(_part: string, vel: number, dur: number, flags: number): void {
    this.noteOn(45, vel, dur, flags);
  }

  /** Turns the chord buffer into strum-timed pending string starts. */
  private flushChord(): void {
    if (!this.chordBuf.length) return;
    const p = this.params;
    const sr = this.sr;
    const ch = this.chordBuf.slice().sort((a, b) => a.note - b.note);
    const up = ch.some((c) => (c.flags & FLAG.UP) !== 0);
    if (up) ch.reverse();
    const strumS = (p.strum / 1000) * sr;
    for (let ti = 0; ti < this.takes.length; ti++) {
      const tOff = this.rng.next() * (p.timing / 1000) * sr;
      ch.forEach((c, i) => {
        const jitter = ch.length > 1 ? this.rng.bi() * 0.18 * strumS : 0;
        const delay = Math.max(0, Math.round(tOff + i * strumS + jitter));
        this.pending.push({ delay, note: c.note, vel: c.vel * (0.94 + this.rng.next() * 0.12), flags: c.flags & 0xfffff, released: (c.flags & (1 << 20)) !== 0, take: ti });
      });
    }
    this.chordBuf.length = 0;
  }

  private startString(pd: Pending, atSample: number, n: number): void {
    const t = this.takes[pd.take];
    const p = this.params;
    // allocate: a free string, else the quietest / oldest
    let k = t.strings.findIndex((s) => !s.active);
    if (k < 0) {
      let best = Infinity;
      for (let i = 0; i < t.strings.length; i++) {
        const sc = t.strings[i].level * 100 - t.strings[i].age * 1e-6;
        if (sc < best) {
          best = sc;
          k = i;
        }
      }
    }
    const f = mtof(pd.note + (t.tuning * p.detune) / 100);
    const mute = (pd.flags & FLAG.MUTE) !== 0 || (pd.flags & FLAG.GHOST) !== 0;
    const ghost = (pd.flags & FLAG.GHOST) !== 0;
    let vel = pd.vel;
    if (pd.flags & FLAG.ACCENT) vel = Math.min(1, vel * 1.1);
    const vv = 1 - p.velocity + p.velocity * vel;
    const pp: PluckParams = {
      decay: p.decay,
      bright: p.bright * (0.7 + 0.3 * vv),
      pickPos: p.pickPos,
      pickHard: p.pickHard * (0.6 + 0.4 * vv),
      pickup: p.pickup,
      mute,
      attackBend: p.attackBend * vv,
    };
    const s = t.strings[k];
    s.pluck(f, ghost ? vv * 0.5 : vv, pp, pd.flags & FLAG.SLIDE ? -2 : 0, 0.06);
    t.notes[k] = pd.note;
    t.flagsOf[k] = pd.flags;
    if (pd.released) s.damp(p.releaseDamp);
    if (ghost) s.damp(0.05);
    // render the part of this segment that follows the start
    if (atSample < n) s.process(t.buf, n, atSample);
    // mark "already rendered this segment"
    this.rendered.add(s);
  }
  private readonly rendered = new Set<KsString>();

  process(l: Float64Array, r: Float64Array, n: number): void {
    this.syncAmp(false);
    this.flushChord();
    const p = this.params;
    for (const t of this.takes) t.buf.fill(0, 0, n);
    this.rendered.clear();
    // start strings whose time has come inside this segment (sample accurate)
    if (this.pending.length) {
      const stillWaiting: Pending[] = [];
      for (const pd of this.pending) {
        if (pd.delay < n) this.startString(pd, pd.delay, n);
        else {
          pd.delay -= n;
          stillWaiting.push(pd);
        }
      }
      this.pending.length = 0;
      this.pending.push(...stillWaiting);
    }
    for (let ti = 0; ti < this.takes.length; ti++) {
      const t = this.takes[ti];
      for (const s of t.strings) if (s.active && !this.rendered.has(s)) s.process(t.buf, n, 0);
      // pickup: a slight resonance and top roll-off, then the amp and cabinet
      t.pickupF.block(t.buf, n);
      t.pickupL.block(t.buf, n);
      for (let i = 0; i < n; i++) t.buf[i] *= PICKUP_LEVEL;
      t.amp.process(t.buf, n);
    }
    const g = dbToLin(p.level + (-9.5));
    if (this.takes.length === 2) {
      const w = p.width;
      const a = this.takes[0].buf;
      const b = this.takes[1].buf;
      for (let i = 0; i < n; i++) {
        const x = a[i] * g;
        const y = b[i] * g;
        l[i] += x * (0.5 + 0.5 * w) + y * (0.5 - 0.5 * w);
        r[i] += y * (0.5 + 0.5 * w) + x * (0.5 - 0.5 * w);
      }
    } else {
      const a = this.takes[0].buf;
      for (let i = 0; i < n; i++) l[i] += a[i] * g;
    }
    void this.out;
  }

  active(): boolean {
    if (this.pending.length || this.chordBuf.length) return true;
    for (const t of this.takes) for (const s of t.strings) if (s.active) return true;
    return false;
  }
}

export const GUITAR_PRESETS: Record<string, PresetDef> = {
  'punk-guitar': {
    doc: 'Double-tracked punk rhythm guitar (hard left and right): a Marshall-style crunch with plenty of mids, tight palm mutes. Use power chords like [A2,E3,A3] and {pm} for the chugging verses.',
    opts: { level: 0, takes: 2, gain: 0.62, tight: 0.5, bass: 1.5, mid: 0.5, treble: 2, presence: 2, boost: 0.45, strum: 5, timing: 5 },
  },
  'punk-guitar-L': {
    doc: 'Single punk guitar panned hard LEFT (use with punk-guitar-R playing the same part for a manual double-track, or a different part for harmony).',
    opts: { level: 0, takes: 1, pan: -1, gain: 0.62, tight: 0.5, bass: 1.5, mid: 0.5, treble: 2, presence: 2, boost: 0.45, strum: 5, timing: 6, detune: 4 },
  },
  'punk-guitar-R': {
    doc: 'Single punk guitar panned hard RIGHT (slightly different tone from -L for a realistic double-track).',
    opts: { level: 0, takes: 1, pan: 1, gain: 0.66, tight: 0.45, bass: 1, mid: 1, treble: 2.5, presence: 2.5, boost: 0.4, strum: 5, timing: 6, detune: 4, cabBright: 0.2 },
  },
  'power-chord-wall': {
    doc: 'Bigger and thicker for choruses: more gain, more low end, longer strum.',
    opts: { level: -0.5, takes: 2, gain: 0.72, tight: 0.4, bass: 3, mid: 0, treble: 2, presence: 2, boost: 0.5, sag: 0.5, strum: 7 },
  },
  'crunch-guitar': {
    doc: 'Open, ringing crunch (lighter gain): strummed open chords like E, A, D, Em, Am.',
    opts: { level: 3, takes: 2, gain: 0.42, tight: 0.3, bass: 1, mid: 1, treble: 3.5, presence: 3, cabBright: 0.8, boost: 0.2, sag: 0.5, strum: 9, decay: 3.2, bright: 0.65 },
  },
  'clean-guitar': {
    doc: 'Clean, chiming electric guitar (intros, quiet parts).',
    opts: { level: 6, takes: 1, gain: 0.05, tight: 0.2, bass: 0, mid: 0, treble: 3, presence: 3, boost: 0, sag: 0.1, gate: -80, strum: 10, decay: 3.5, bright: 0.7, cab: '2x12' },
  },
  'lead-guitar': {
    doc: 'Singing lead: higher gain with a mid push, single mono take (play single notes; slides ~ add expression).',
    opts: { level: -1, takes: 1, gain: 0.8, tight: 0.35, bass: -1, mid: 2, treble: 1, presence: 1, boost: 0.7, sag: 0.4, strum: 0, decay: 4, bright: 0.6, pickPos: 0.22, pickup: 0.2 },
  },
  'metal-guitar': {
    doc: 'High-gain scooped tone with very tight palm mutes (for heavier moments).',
    opts: { level: -1.5, takes: 2, gain: 0.88, tight: 0.75, bass: 2, mid: -3, treble: 3, presence: 3, boost: 0.65, sag: 0.3, strum: 4 },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Bass guitar
// ─────────────────────────────────────────────────────────────────────────────

export const BASSG_SPECS = {
  level: { default: 0, min: -30, max: 12, unit: 'dB', doc: 'Trim in dB on top of the preset\'s calibrated loudness (0 = as calibrated; the fader is the channel\'s `gain` in the mix).' },
  decay: { default: 2.4, min: 0.3, max: 6, unit: 's', doc: 'How long an open string rings.' },
  bright: { default: 0.5, min: 0, max: 1, doc: 'Brightness of the strings (round vs clanky).' },
  pickPos: { default: 0.2, min: 0.08, max: 0.5, doc: 'Where the string is plucked (near the bridge = more attack).' },
  pickHard: { default: 0.55, min: 0, max: 1, doc: 'Pick / finger hardness (attack brightness).' },
  pickup: { default: 0.2, min: 0, max: 0.4, doc: 'Pickup position (0 = off).' },
  drive: { default: 0.35, min: 0, max: 1, doc: 'Overdrive in the bass amp.' },
  comp: { default: 0.45, min: 0, max: 1, doc: 'Compression in the bass amp.' },
  bass: { default: 2, min: -12, max: 12, unit: 'dB', doc: 'Tone: bass.' },
  mid: { default: 0, min: -12, max: 12, unit: 'dB', doc: 'Tone: mids.' },
  treble: { default: 2, min: -12, max: 12, unit: 'dB', doc: 'Tone: treble.' },
  muteDecay: { default: 0.2, min: 0.05, max: 0.8, unit: 's', doc: 'Ring time of palm-muted notes.' },
  releaseDamp: { default: 0.06, min: 0.01, max: 0.6, unit: 's', doc: 'How quickly the string is silenced at the end of a note (unless {ring}).' },
  attackBend: { default: 0.08, min: 0, max: 0.6, unit: 'semitones', doc: 'Pitch sharpness of a hard pluck at the very start.' },
  velocity: { default: 0.6, min: 0, max: 1, doc: 'How much velocity changes the pluck.' },
} satisfies ParamSpecs;

export interface BassGuitarOpts {
  preset?: string;
  name?: string;
  cab?: CabType;
  [param: string]: unknown;
}

export class BassGuitar extends ParamBase<typeof BASSG_SPECS> implements Instrument {
  readonly stereo = false;
  /** A `~` note scoops up into its pitch by itself; it needs no note before it. */
  readonly slides = 'scoop' as const;
  private readonly sr: number;
  private readonly strings: KsString[] = [];
  private readonly notes: number[] = [];
  private readonly flagsOf: number[] = [];
  private readonly amp: BassAmp;
  private readonly buf = new Float64Array(BLOCK);
  private readonly pickupF = new Biquad();
  private readonly pending: { delay: number; note: number; vel: number; flags: number; released: boolean }[] = [];
  private lastKey = '';
  constructor(ctx: Ctx, input?: BassGuitarOpts | string) {
    const o = resolveOpts('bass guitar', BASSG_PRESETS, input ?? 'punk-bass', BASSG_SPECS, ['cab']);
    super('BassGuitar', BASSG_SPECS, o);
    this.sr = ctx.sr;
    for (let i = 0; i < 4; i++) {
      this.strings.push(new KsString(ctx.sr, 28, ctx.seed + i * 331));
      this.notes.push(-1);
      this.flagsOf.push(0);
    }
    this.amp = new BassAmp(ctx.sr, { cab: pickWord('bass guitar', 'cab', o.cab, ['bass-8x10', 'bass-1x15', 'none'] as const, 'bass-8x10') });
    this.pickupF.peaking(1800, 1.2, 2, ctx.sr);
    this.sync(true);
  }
  private sync(force: boolean): void {
    const p = this.params;
    const key = `${p.drive}|${p.comp}|${p.bass}|${p.mid}|${p.treble}`;
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    const a = this.amp;
    a.setParam('drive', p.drive);
    a.setParam('comp', p.comp);
    a.setParam('bass', p.bass);
    a.setParam('mid', p.mid);
    a.setParam('treble', p.treble);
  }
  noteOn(note: number, vel: number, _dur: number, flags: number): void {
    this.pending.push({ delay: 0, note, vel, flags, released: false });
  }
  noteOff(note: number): void {
    for (let i = 0; i < this.strings.length; i++) {
      if (this.notes[i] === note && this.strings[i].active && !(this.flagsOf[i] & FLAG.RING)) this.strings[i].damp(this.params.releaseDamp);
    }
    for (const p of this.pending) if (p.note === note && !(p.flags & FLAG.RING)) p.released = true;
  }
  hit(_part: string, vel: number, dur: number, flags: number): void {
    this.noteOn(28, vel, dur, flags);
  }
  process(l: Float64Array, _r: Float64Array, n: number): void {
    this.sync(false);
    const p = this.params;
    this.buf.fill(0, 0, n);
    // bass guitar is effectively monophonic: a new note stops the strings still sounding (the hand mutes them)
    if (this.pending.length) {
      for (const pd of this.pending) {
        for (let i = 0; i < this.strings.length; i++) if (this.strings[i].active && !(this.flagsOf[i] & FLAG.RING)) this.strings[i].damp(0.02);
        let k = this.strings.findIndex((s) => !s.active);
        if (k < 0) {
          k = 0;
          let best = Infinity;
          for (let i = 0; i < this.strings.length; i++) {
            const sc = this.strings[i].level * 100 - this.strings[i].age * 1e-6;
            if (sc < best) {
              best = sc;
              k = i;
            }
          }
        }
        const mute = (pd.flags & FLAG.MUTE) !== 0 || (pd.flags & FLAG.GHOST) !== 0;
        let vel = pd.vel;
        if (pd.flags & FLAG.ACCENT) vel = Math.min(1, vel * 1.1);
        const vv = 1 - p.velocity + p.velocity * vel;
        const pp: PluckParams = {
          decay: p.decay,
          bright: p.bright * (0.7 + 0.3 * vv),
          pickPos: p.pickPos,
          pickHard: p.pickHard * (0.6 + 0.4 * vv),
          pickup: p.pickup,
          mute,
          attackBend: p.attackBend * vv,
        };
        const s = this.strings[k];
        s.pluck(mtof(pd.note), (pd.flags & FLAG.GHOST) !== 0 ? vv * 0.5 : vv, pp, pd.flags & FLAG.SLIDE ? -1 : 0, 0.05);
        this.notes[k] = pd.note;
        this.flagsOf[k] = pd.flags;
        if (pd.released) s.damp(p.releaseDamp);
        if (pd.flags & FLAG.GHOST) s.damp(0.04);
      }
      this.pending.length = 0;
    }
    for (const s of this.strings) if (s.active) s.process(this.buf, n, 0);
    this.pickupF.block(this.buf, n);
    this.amp.process(this.buf, n);
    const g = dbToLin(p.level + (-14));
    for (let i = 0; i < n; i++) l[i] += this.buf[i] * g;
  }
  active(): boolean {
    return this.pending.length > 0 || this.strings.some((s) => s.active);
  }
}

export const BASSG_PRESETS: Record<string, PresetDef> = {
  'punk-bass': { doc: 'Picked, bright, driven punk bass: roots in eighth notes (with {pm} for the muted verses).', opts: { level: -2, bright: 0.65, pickHard: 0.75, pickPos: 0.17, drive: 0.4, comp: 0.5, bass: 2, treble: 2.5 } },
  'rock-bass': { doc: 'Round, growly rock bass with a little drive.', opts: { level: -1, bright: 0.5, pickHard: 0.5, drive: 0.28, comp: 0.4, mid: 1.5 } },
  'finger-bass': { doc: 'Warm fingerstyle bass, clean and round.', opts: { level: 1.5, bright: 0.3, pickHard: 0.2, pickPos: 0.3, drive: 0.05, comp: 0.35, bass: 3, treble: 0, decay: 3 } },
  'dirty-bass': { doc: 'Fuzzy, overdriven bass for garage and noisy parts.', opts: { level: -4.5, bright: 0.6, pickHard: 0.7, drive: 0.75, comp: 0.5, mid: 2, treble: 1 } },
};

export interface GuitarChordOpts {
  /** 'power' (root, fifth, octave), 'open' (open-string shapes where they exist), 'barre' (movable E / A shapes). Default: power for X5 symbols, open when a shape exists, else barre. */
  shape?: 'power' | 'open' | 'barre';
  /** Drop-D style tuning: the lowest string is a whole tone lower, so D5, D, Dm have a full low voicing. */
  dropD?: boolean;
}

const OPEN: Record<string, number[]> = {
  E: [40, 47, 52, 56, 59, 64],
  Em: [40, 47, 52, 55, 59, 64],
  E7: [40, 47, 50, 56, 59, 64],
  Em7: [40, 47, 50, 55, 59, 64],
  A: [45, 52, 57, 61, 64],
  Am: [45, 52, 57, 60, 64],
  A7: [45, 52, 55, 61, 64],
  Am7: [45, 52, 55, 60, 64],
  Asus4: [45, 52, 57, 62, 64],
  Asus2: [45, 52, 57, 59, 64],
  D: [50, 57, 62, 66],
  Dm: [50, 57, 62, 65],
  D7: [50, 57, 60, 66],
  Dsus4: [50, 57, 62, 67],
  G: [43, 47, 50, 55, 59, 67],
  G7: [43, 47, 50, 55, 59, 65],
  C: [48, 52, 55, 60, 64],
  C7: [48, 52, 58, 60, 64],
  Cadd9: [48, 52, 55, 62, 64],
  B7: [47, 51, 57, 59, 63, 66],
};

/**
 * A playable guitar voicing (MIDI notes, lowest first) for a chord symbol: power chords ('A5'), open shapes ('Em', 'D', 'G'),
 * and barre chords moved up the neck ('F#m', 'Bb', 'C#7'). Standard tuning.
 */
export function guitarChord(symbol: string, opts: GuitarChordOpts = {}): number[] {
  const m = /^([A-G][#b]?)(.*)$/.exec(symbol.trim());
  if (!m) throw new Error(`guitarChord: bad chord "${symbol}"`);
  const rootName = m[1];
  const q = m[2];
  const pcMap: Record<string, number> = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
  const pc = pcMap[rootName];
  if (pc === undefined) throw new Error(`guitarChord: unknown root "${rootName}"`);
  const shape = pickWord('guitarChord', 'shape', opts.shape, ['power', 'open', 'barre'] as const, q === '5' ? 'power' : OPEN[symbol.trim()] ? 'open' : 'barre');
  const lowE = opts.dropD ? 38 : 40;
  if (shape === 'power') {
    // roots E..G# sit on the low E string (frets 0-4), A..D# on the A string (frets 0-6)
    const root = (((pc - lowE) % 12) + 12) % 12 <= 4 ? lowE + ((((pc - lowE) % 12) + 12) % 12) : 45 + ((((pc - 9) % 12) + 12) % 12);
    return [root, root + 7, root + 12];
  }
  if (shape === 'open' && OPEN[symbol.trim()]) return OPEN[symbol.trim()].slice();
  // barre chords: E-shape for roots E..G (frets 0-3) and up, A-shape otherwise
  const minor = q.startsWith('m') && !q.startsWith('maj');
  const seventh = q.includes('7');
  const eFret = (((pc - 4) % 12) + 12) % 12;
  const aFret = (((pc - 9) % 12) + 12) % 12;
  if (eFret <= 7) {
    // E-shape: root, fifth, octave, third, fifth, octave (open E major / minor shape moved up eFret frets)
    const base = minor ? [40, 47, 52, 55, 59, 64] : seventh ? [40, 47, 50, 56, 59, 64] : [40, 47, 52, 56, 59, 64];
    const b = seventh && minor ? [40, 47, 50, 55, 59, 64] : base;
    return b.map((n) => n + eFret);
  }
  const base = minor ? [45, 52, 57, 60, 64] : seventh ? [45, 52, 55, 61, 64] : [45, 52, 57, 61, 64];
  const b = seventh && minor ? [45, 52, 55, 60, 64] : base;
  return b.map((n) => n + aFret);
}
