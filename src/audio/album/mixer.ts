/**
 * The mixer: channel strips (inserts, EQ, gain, pan, sends, sidechain ducking), buses, the shared reverb and delay returns
 * and the master chain (trim, EQ, glue compressor, soft saturation, mono-bass, true-peak limiter).
 *
 * The engine renders in segments of at most SEG frames; every buffer here is that long.
 */
import { Biquad } from './dsp/filters';
import { Compressor, Limiter } from './dsp/dyn';
import { Reverb, REVERB_DEFAULTS, ReverbParams } from './dsp/reverb';
import { ANTI_DENORMAL, TAU, clamp, dbToLin, tanh3 } from './dsp/core';
import { BLOCK, Ctx, Effect, FxSpec, Instrument, ParamBase, ParamSpecs, pickWord, suggest } from './instrument';
import { PingPongDelay, DelayOpts } from './fx';

/** Longest segment the engine renders at once (frames). */
export const SEG = BLOCK;

export const STRIP_SPECS = {
  gain: { default: 0, min: -80, max: 24, unit: 'dB', doc: 'Channel fader.' },
  pan: { default: 0, min: -1, max: 1, doc: 'Stereo position (-1 left, 0 centre, 1 right). Constant-power for mono sources, balance for stereo ones.' },
  width: { default: 1, min: 0, max: 2.5, doc: 'Stereo width of the channel (stereo sources only): 0 mono, 1 unchanged, 2 very wide.' },
  hp: { default: 20, min: 10, max: 4000, unit: 'Hz', curve: 'exp', doc: 'High-pass filter (12 dB/oct). 20 = off.' },
  lp: { default: 20000, min: 200, max: 20000, unit: 'Hz', curve: 'exp', doc: 'Low-pass filter (12 dB/oct). 20000 = off.' },
  eqLow: { default: 0, min: -18, max: 18, unit: 'dB', doc: 'Low shelf gain.' },
  eqLowFreq: { default: 110, min: 30, max: 400, unit: 'Hz', curve: 'exp', doc: 'Low shelf corner.' },
  eqMid: { default: 0, min: -18, max: 18, unit: 'dB', doc: 'Mid bell gain.' },
  eqMidFreq: { default: 1000, min: 150, max: 8000, unit: 'Hz', curve: 'exp', doc: 'Mid bell centre.' },
  eqMidQ: { default: 1, min: 0.2, max: 8, doc: 'Mid bell width (higher = narrower).' },
  eqHigh: { default: 0, min: -18, max: 18, unit: 'dB', doc: 'High shelf gain.' },
  eqHighFreq: { default: 7500, min: 2000, max: 16000, unit: 'Hz', curve: 'exp', doc: 'High shelf corner.' },
  reverb: { default: 0, min: 0, max: 2, doc: 'Send to the shared reverb (0..1; 0.2 is a typical amount).' },
  delay: { default: 0, min: 0, max: 2, doc: 'Send to the shared tempo-synced delay (0..1).' },
  duck: { default: 0, min: 0, max: 1, doc: 'How much the sidechain (the kick) ducks this channel: 0 none, 1 fully at each kick.' },
} satisfies ParamSpecs;

/** Channel strip / mixer options (everything automatable with `ch.auto('mix.<name>', ...)`). */
export interface MixOpts {
  gain?: number;
  pan?: number;
  width?: number;
  hp?: number;
  lp?: number;
  eqLow?: number;
  eqLowFreq?: number;
  eqMid?: number;
  eqMidFreq?: number;
  eqMidQ?: number;
  eqHigh?: number;
  eqHighFreq?: number;
  reverb?: number;
  delay?: number;
  duck?: number;
  /** Route to a bus created with `s.bus(...)` instead of straight to the master. */
  bus?: string;
  /** Insert effects, in order: `fx: [fx.chorus(), fx.drive({ drive: 6 })]` (see the README). */
  fx?: FxSpec[];
  /** Parallel-less compressor on the channel (after the inserts, before the EQ). */
  comp?: { threshold?: number; ratio?: number; attack?: number; release?: number; knee?: number; makeup?: number; mix?: number; detect?: 'peak' | 'rms' };
  /** This channel's hits trigger the sidechain ducking of the others (default true for kicks). */
  key?: boolean;
  /** Silences the channel (mute while composing). */
  mute?: boolean;
  /** Name used in automation paths and reports. */
  name?: string;
}

/** Scratch buffers shared by all strips of one segment. */
export class MixIO {
  readonly revL = new Float64Array(SEG);
  readonly revR = new Float64Array(SEG);
  readonly dlyL = new Float64Array(SEG);
  readonly dlyR = new Float64Array(SEG);
  /** Sidechain gain per sample, 1 = no ducking (shared by all strips). */
  readonly duck = new Float64Array(SEG);
  duckActive = false;
  revUsed = false;
  dlyUsed = false;
}

export class Strip extends ParamBase<typeof STRIP_SPECS> {
  readonly fx: Effect[];
  readonly comp: Compressor | null;
  private readonly sr: number;
  private readonly hpF: [Biquad, Biquad] = [new Biquad(), new Biquad()];
  private readonly lpF: [Biquad, Biquad] = [new Biquad(), new Biquad()];
  private readonly lowF: [Biquad, Biquad] = [new Biquad(), new Biquad()];
  private readonly midF: [Biquad, Biquad] = [new Biquad(), new Biquad()];
  private readonly highF: [Biquad, Biquad] = [new Biquad(), new Biquad()];
  private cache = { hp: -1, lp: -1, low: NaN, lowF: -1, mid: NaN, midF: -1, midQ: -1, high: NaN, highF: -1 };
  private gl = 0;
  private gr = 0;
  private started = false;
  private readonly midBuf = new Float64Array(SEG);
  /** Mean-square energy accumulated by the meters (post fader). */
  meterEnergy = 0;
  meterFrames = 0;
  constructor(ctx: Ctx, opts: MixOpts = {}, fx: Effect[] = []) {
    super('mix', STRIP_SPECS, opts);
    this.sr = ctx.sr;
    this.fx = fx;
    if (opts.comp) {
      const c = new Compressor(ctx.sr);
      const o = opts.comp;
      if (o.threshold !== undefined) c.threshold = o.threshold;
      if (o.ratio !== undefined) c.ratio = o.ratio;
      if (o.attack !== undefined) c.attack = o.attack;
      if (o.release !== undefined) c.release = o.release;
      if (o.knee !== undefined) c.knee = o.knee;
      if (o.makeup !== undefined) c.makeup = o.makeup;
      if (o.mix !== undefined) c.mix = o.mix;
      if (o.detect !== undefined) c.detect = pickWord('mix.comp', 'detect', o.detect, ['peak', 'rms'] as const);
      c.update();
      this.comp = c;
    } else this.comp = null;
  }
  /** True when anything inside the strip may still ring (effects with tails). */
  hasTails(): boolean {
    for (const f of this.fx) if (f.active()) return true;
    return false;
  }
  private updateFilters(): void {
    const p = this.params;
    const c = this.cache;
    const sr = this.sr;
    if (p.hp !== c.hp) {
      c.hp = p.hp;
      for (const b of this.hpF) b.highpass(p.hp, 0.7071, sr);
    }
    if (p.lp !== c.lp) {
      c.lp = p.lp;
      for (const b of this.lpF) b.lowpass(p.lp, 0.7071, sr);
    }
    if (p.eqLow !== c.low || p.eqLowFreq !== c.lowF) {
      c.low = p.eqLow;
      c.lowF = p.eqLowFreq;
      for (const b of this.lowF) b.lowShelf(p.eqLowFreq, p.eqLow, sr);
    }
    if (p.eqMid !== c.mid || p.eqMidFreq !== c.midF || p.eqMidQ !== c.midQ) {
      c.mid = p.eqMid;
      c.midF = p.eqMidFreq;
      c.midQ = p.eqMidQ;
      for (const b of this.midF) b.peaking(p.eqMidFreq, p.eqMidQ, p.eqMid, sr);
    }
    if (p.eqHigh !== c.high || p.eqHighFreq !== c.highF) {
      c.high = p.eqHigh;
      c.highF = p.eqHighFreq;
      for (const b of this.highF) b.highShelf(p.eqHighFreq, p.eqHigh, sr);
    }
  }
  /**
   * Processes l/r[0..n) in place through inserts, compressor, filters and EQ, then adds the faded/panned result to the
   * destination bus and the send buffers. `stereo` tells whether r carries a separate signal.
   */
  process(l: Float64Array, r: Float64Array, n: number, stereo: boolean, outL: Float64Array, outR: Float64Array, io: MixIO): void {
    const p = this.params;
    // inserts
    for (let k = 0; k < this.fx.length; k++) {
      const f = this.fx[k];
      if (!stereo && f.mono && f.processMono) f.processMono(l, n);
      else {
        if (!stereo) {
          for (let i = 0; i < n; i++) r[i] = l[i];
          stereo = true;
        }
        f.process(l, r, n);
      }
    }
    if (this.comp) {
      if (stereo) this.comp.process(l, r, n);
      else this.comp.processMono(l, n);
    }
    // filters and EQ
    this.updateFilters();
    const c = this.cache;
    for (let ch = 0; ch < (stereo ? 2 : 1); ch++) {
      const x = ch === 0 ? l : r;
      if (c.hp > 21) this.hpF[ch].block(x, n);
      if (c.low !== 0) this.lowF[ch].block(x, n);
      if (c.mid !== 0) this.midF[ch].block(x, n);
      if (c.high !== 0) this.highF[ch].block(x, n);
      if (c.lp < 19900) this.lpF[ch].block(x, n);
    }
    // stereo width (M/S)
    if (stereo && p.width !== 1) {
      const w = p.width;
      for (let i = 0; i < n; i++) {
        const m = (l[i] + r[i]) * 0.5;
        const s = (l[i] - r[i]) * 0.5 * w;
        l[i] = m + s;
        r[i] = m - s;
      }
    }
    // gain, pan, ducking
    const g = dbToLin(p.gain);
    let tl: number;
    let tr: number;
    if (stereo) {
      const pan = p.pan;
      tl = g * (pan > 0 ? 1 - pan : 1);
      tr = g * (pan < 0 ? 1 + pan : 1);
    } else {
      const a = (p.pan + 1) * 0.25 * Math.PI;
      tl = g * Math.cos(a) * Math.SQRT2;
      tr = g * Math.sin(a) * Math.SQRT2;
    }
    if (!this.started) {
      this.gl = tl;
      this.gr = tr;
      this.started = true;
    }
    const dl = (tl - this.gl) / n;
    const dr = (tr - this.gr) / n;
    let gl = this.gl;
    let gr = this.gr;
    const rv = p.reverb;
    const dy = p.delay;
    const duckAmt = p.duck;
    const duck = io.duck;
    const useDuck = duckAmt > 0 && io.duckActive;
    let e = 0;
    for (let i = 0; i < n; i++) {
      gl += dl;
      gr += dr;
      const d = useDuck ? 1 - duckAmt * (1 - duck[i]) : 1;
      const xl = l[i] * gl * d;
      const xr = (stereo ? r[i] : l[i]) * gr * d;
      outL[i] += xl;
      outR[i] += xr;
      if (rv > 0) {
        io.revL[i] += xl * rv;
        io.revR[i] += xr * rv;
      }
      if (dy > 0) {
        io.dlyL[i] += xl * dy;
        io.dlyR[i] += xr * dy;
      }
      e += xl * xl + xr * xr;
    }
    if (rv > 0) io.revUsed = true;
    if (dy > 0) io.dlyUsed = true;
    this.gl = tl;
    this.gr = tr;
    this.meterEnergy += e;
    this.meterFrames += n;
  }
}

// ── sidechain duck envelope ──────────────────────────────────────────────────

export const DUCK_SPECS = {
  depth: { default: 1, min: 0, max: 1, doc: 'Strength of the sidechain at velocity 1 (multiplied by each channel\'s `duck` amount).' },
  attack: { default: 0.004, min: 0.0005, max: 0.05, unit: 's', doc: 'How fast the ducked channels drop at each kick.' },
  hold: { default: 0.02, min: 0, max: 0.3, unit: 's', doc: 'Time the ducking is held at full depth.' },
  release: { default: 0.2, min: 0.02, max: 1.5, unit: 's', doc: 'Recovery time: this long after the hold the ducked channel is back at full level exactly (a total, not a time constant). With the default curve and full depth it is back to -3 dB after a fifth of it, to about -1 dB after a third.' },
  curve: { default: 1, min: 0.3, max: 4, doc: '1 = exponential recovery; above 1 the recovery starts slower and finishes quicker (pumping), below 1 the opposite.' },
} satisfies ParamSpecs;

export class Duck extends ParamBase<typeof DUCK_SPECS> {
  private level = 1; // 1 = no ducking
  private floor = 1;
  private holdLeft = 0;
  private phase = 1; // 1 = recovering (or idle); 0 = attacking
  private rel = 1; // recovery progress 0..1
  private active = false;
  constructor(private readonly sr: number) {
    super('duck', DUCK_SPECS);
  }
  trigger(vel: number): void {
    const f = 1 - this.params.depth * clamp(vel, 0, 1);
    this.floor = Math.min(this.active ? this.level : 1, f);
    if (!this.active) this.floor = f;
    this.phase = 0;
    this.holdLeft = this.params.hold * this.sr;
    this.active = true;
  }
  /** Fills io.duck[0..n) and sets io.duckActive. */
  fill(io: MixIO, n: number): void {
    if (!this.active) {
      io.duckActive = false;
      return;
    }
    io.duckActive = true;
    const p = this.params;
    const aK = 1 - Math.exp(-1 / (p.attack * this.sr * 0.35));
    const rStep = 1 / Math.max(p.release * this.sr, 1);
    for (let i = 0; i < n; i++) {
      if (this.phase === 0) {
        this.level += (this.floor - this.level) * aK;
        if (this.level <= this.floor + 0.002) {
          this.level = this.floor;
          this.phase = 2; // hold
        }
      } else if (this.phase === 2) {
        if (--this.holdLeft <= 0) {
          this.phase = 1;
          this.rel = 0;
          this.from = this.level;
        }
      } else {
        this.rel += rStep;
        if (this.rel >= 1) {
          this.level = 1;
          this.active = false;
          for (let k = i; k < n; k++) io.duck[k] = 1;
          io.duck[i] = 1;
          return;
        }
        // exponential-ish recovery: 1 - (1 - from) * exp(-k * x), reshaped by `curve`
        const x = Math.pow(this.rel, p.curve);
        this.level = 1 - (1 - this.from) * Math.exp(-5 * x) * (1 - x);
      }
      io.duck[i] = this.level;
    }
  }
  private from = 1;
}

// ── shared sends ─────────────────────────────────────────────────────────────

export const REVERB_RETURN_SPECS = {
  time: { default: REVERB_DEFAULTS.time, min: 0.1, max: 15, unit: 's', doc: 'Reverb time (RT60).' },
  damp: { default: REVERB_DEFAULTS.damp, min: 0, max: 1, doc: 'How much faster the highs decay than the lows.' },
  size: { default: REVERB_DEFAULTS.size, min: 0.3, max: 3, doc: 'Room size (scales the delay lengths).' },
  preDelay: { default: REVERB_DEFAULTS.preDelay, min: 0, max: 0.3, unit: 's', doc: 'Pre-delay before the reverb starts.' },
  early: { default: REVERB_DEFAULTS.early, min: 0, max: 1, doc: 'Level of the early reflections.' },
  mod: { default: REVERB_DEFAULTS.mod, min: 0, max: 1, doc: 'Modulation of the lines (keeps long tails smooth).' },
  lowCut: { default: REVERB_DEFAULTS.lowCut, min: 20, max: 1000, unit: 'Hz', curve: 'exp', doc: 'High-pass on the wet signal (keeps the bass clean).' },
  highCut: { default: REVERB_DEFAULTS.highCut, min: 1000, max: 20000, unit: 'Hz', curve: 'exp', doc: 'Low-pass on the wet signal.' },
  width: { default: REVERB_DEFAULTS.width, min: 0, max: 1.5, doc: 'Stereo width of the wet signal.' },
  return: { default: -8, min: -60, max: 12, unit: 'dB', doc: 'Level of the reverb return into the mix.' },
  duck: { default: 0, min: 0, max: 1, doc: 'Ducks the reverb return with the sidechain (clears space at each kick).' },
} satisfies ParamSpecs;

export interface ReverbOpts {
  time?: number;
  damp?: number;
  size?: number;
  preDelay?: number;
  early?: number;
  mod?: number;
  lowCut?: number;
  highCut?: number;
  width?: number;
  return?: number;
  duck?: number;
}

export class ReverbReturn extends ParamBase<typeof REVERB_RETURN_SPECS> {
  readonly rv: Reverb;
  private quiet = 0;
  private readonly wl = new Float64Array(SEG);
  private readonly wr = new Float64Array(SEG);
  constructor(private readonly sr: number, opts: ReverbOpts = {}) {
    super('reverb', REVERB_RETURN_SPECS, opts);
    this.rv = new Reverb(sr, {});
  }
  /** Runs the reverb on io.rev* and adds the return into outL/outR. */
  process(io: MixIO, outL: Float64Array, outR: Float64Array, n: number): void {
    // quiet-input shortcut: nothing sent for a while and the tail has died away
    let inE = 0;
    if (io.revUsed) for (let i = 0; i < n; i++) inE += Math.abs(io.revL[i]) + Math.abs(io.revR[i]);
    if (inE < 1e-12 && this.quiet > this.sr * (this.params.time * 1.6 + 1)) return;
    const p = this.params;
    const rp = this.rv.p;
    for (const k of ['time', 'damp', 'size', 'early', 'mod', 'lowCut', 'highCut', 'width'] as const) if (rp[k] !== p[k]) this.rv.setParam(k, p[k]);
    rp.preDelay = p.preDelay;
    this.wl.fill(0, 0, n);
    this.wr.fill(0, 0, n);
    this.rv.process(io.revL, io.revR, this.wl, this.wr, n);
    const g = dbToLin(p.return);
    const duckAmt = p.duck;
    const useDuck = duckAmt > 0 && io.duckActive;
    let outE = 0;
    for (let i = 0; i < n; i++) {
      const d = useDuck ? 1 - duckAmt * (1 - io.duck[i]) : 1;
      const a = this.wl[i] * g * d;
      const b = this.wr[i] * g * d;
      outL[i] += a;
      outR[i] += b;
      outE += Math.abs(a) + Math.abs(b);
    }
    if (inE < 1e-12 && outE < 1e-9) this.quiet += n;
    else this.quiet = 0;
  }
}

export const DELAY_RETURN_SPECS = {
  time: { default: 0.75, min: 0.0625, max: 4, unit: 'beats', doc: 'Delay time in beats (0.75 = dotted eighth, 0.5 = eighth, 1 = quarter).' },
  feedback: { default: 0.4, min: 0, max: 0.95, doc: 'Repeats.' },
  pingpong: { default: 0.8, min: 0, max: 1, doc: 'Left/right alternation of the repeats.' },
  tone: { default: 4200, min: 500, max: 16000, unit: 'Hz', curve: 'exp', doc: 'Low-pass in the loop (darker repeats).' },
  lowCut: { default: 160, min: 20, max: 1500, unit: 'Hz', curve: 'exp', doc: 'High-pass in the loop.' },
  drive: { default: 0.15, min: 0, max: 1, doc: 'Soft saturation in the loop.' },
  mod: { default: 0.15, min: 0, max: 1, doc: 'Slow pitch wobble of the repeats.' },
  return: { default: -9, min: -60, max: 12, unit: 'dB', doc: 'Level of the delay return into the mix.' },
  duck: { default: 0, min: 0, max: 1, doc: 'Ducks the delay return with the sidechain.' },
} satisfies ParamSpecs;

export class DelayReturn extends ParamBase<typeof DELAY_RETURN_SPECS> {
  private readonly dl: PingPongDelay;
  private quiet = 0;
  private readonly wl = new Float64Array(SEG);
  private readonly wr = new Float64Array(SEG);
  constructor(ctx: Ctx, opts: Partial<Record<keyof typeof DELAY_RETURN_SPECS, number>> = {}) {
    super('delay', DELAY_RETURN_SPECS, opts);
    this.dl = new PingPongDelay(ctx, { mix: 1 } as DelayOpts);
    this.sr = ctx.sr;
  }
  private readonly sr: number;
  process(io: MixIO, outL: Float64Array, outR: Float64Array, n: number): void {
    let inE = 0;
    if (io.dlyUsed) for (let i = 0; i < n; i++) inE += Math.abs(io.dlyL[i]) + Math.abs(io.dlyR[i]);
    if (inE < 1e-12 && this.quiet > this.sr * 12) return;
    const p = this.params;
    const dp = this.dl.params;
    for (const k of ['time', 'feedback', 'pingpong', 'tone', 'lowCut', 'drive', 'mod'] as const) if (dp[k] !== p[k]) this.dl.setParam(k, p[k]);
    this.wl.fill(0, 0, n);
    this.wr.fill(0, 0, n);
    this.dl.run(io.dlyL, io.dlyR, this.wl, this.wr, n);
    const g = dbToLin(p.return);
    const duckAmt = p.duck;
    const useDuck = duckAmt > 0 && io.duckActive;
    let outE = 0;
    for (let i = 0; i < n; i++) {
      const d = useDuck ? 1 - duckAmt * (1 - io.duck[i]) : 1;
      const a = this.wl[i] * g * d;
      const b = this.wr[i] * g * d;
      outL[i] += a;
      outR[i] += b;
      outE += Math.abs(a) + Math.abs(b);
    }
    if (inE < 1e-12 && outE < 1e-9) this.quiet += n;
    else this.quiet = 0;
  }
}

// ── master ───────────────────────────────────────────────────────────────────

export const MASTER_SPECS = {
  trim: { default: 0, min: -40, max: 40, unit: 'dB', doc: 'Gain into the master chain: the knob that sets the loudness of the whole track (calibrate it so the probe reports about -14 LUFS).' },
  lowShelf: { default: 1, min: -12, max: 12, unit: 'dB', doc: 'Low shelf at 80 Hz.' },
  highShelf: { default: 0, min: -12, max: 12, unit: 'dB', doc: 'High shelf at 9 kHz.' },
  glue: { default: 1, min: 0, max: 1, doc: 'Amount of the glue compressor (0 = bypass).' },
  glueThreshold: { default: -14, min: -40, max: 0, unit: 'dB', doc: 'Glue compressor threshold.' },
  glueRatio: { default: 1.8, min: 1, max: 8, doc: 'Glue compressor ratio.' },
  glueAttack: { default: 0.03, min: 0.001, max: 0.2, unit: 's', doc: 'Glue compressor attack.' },
  glueRelease: { default: 0.18, min: 0.02, max: 1, unit: 's', doc: 'Glue compressor release.' },
  sat: { default: 0.25, min: 0, max: 1, doc: 'Soft saturation of the master (0 = clean).' },
  monoBelow: { default: 90, min: 20, max: 300, unit: 'Hz', curve: 'exp', doc: 'Stereo information below this frequency is folded to mono.' },
  ceiling: { default: -1.4, min: -6, max: -0.3, unit: 'dB', doc: 'Limiter ceiling (true peak). -1.4 keeps the 16-bit WAV and any later resampling under -1 dBTP.' },
  release: { default: 0.09, min: 0.01, max: 0.5, unit: 's', doc: 'Limiter release.' },
} satisfies ParamSpecs;

export class MasterBus extends ParamBase<typeof MASTER_SPECS> {
  private readonly hp = new Biquad();
  private readonly hp2 = new Biquad();
  private readonly lowSh: [Biquad, Biquad] = [new Biquad(), new Biquad()];
  private readonly highSh: [Biquad, Biquad] = [new Biquad(), new Biquad()];
  private readonly comp: Compressor;
  readonly limiter: Limiter;
  private sideLp = 0;
  private cache = { low: NaN, high: NaN, rel: NaN };
  private gTrim = -1;
  private readonly dcL = new Biquad();
  // after the saturation: a lopsided waveform through tanh comes out with an offset (a Goa bass alone read 1e-3 at sat 0.25)
  private readonly dc2L = new Biquad();
  private readonly dc2R = new Biquad();
  private readonly dcR = new Biquad();
  /** Largest gain reduction of the glue compressor since last read (dB). */
  glueMax = 0;
  /** Analysis aid: skips tone shaping, glue, saturation, mono-bass and limiting (only the trim and the latency stay). */
  raw = false;
  /** Analysis aid: dB added to the trim whatever its automation says (the probe's AUTOTRIM mode searches for the right offset). */
  offsetDb = 0;
  constructor(private readonly sr: number) {
    super('master', MASTER_SPECS);
    this.comp = new Compressor(sr);
    this.comp.detect = 'rms';
    this.limiter = new Limiter(sr, -1.4, 1.5, 0.09);
    this.hp.highpass(24, 0.7071, sr);
    this.hp2.highpass(24, 0.7071, sr);
    this.dcL.highpass(24, 0.7071, sr);
    this.dc2L.highpass(5, 0.7071, sr);
    this.dc2R.highpass(5, 0.7071, sr);
    this.dcR.highpass(24, 0.7071, sr);
  }
  /** Master processing in place (l/r hold the summed mix). Output is delayed by the limiter latency. */
  process(l: Float64Array, r: Float64Array, n: number): void {
    const p = this.params;
    const sr = this.sr;
    if (p.lowShelf !== this.cache.low) {
      this.cache.low = p.lowShelf;
      for (const b of this.lowSh) b.lowShelf(80, p.lowShelf, sr);
    }
    if (p.highShelf !== this.cache.high) {
      this.cache.high = p.highShelf;
      for (const b of this.highSh) b.highShelf(9000, p.highShelf, sr);
    }
    // a tiny Nyquist-rate signal keeps the filter states out of the denormal range while the mix is silent
    for (let i = 0; i < n; i++) {
      const e = i & 1 ? 1e-21 : -1e-21;
      l[i] += e;
      r[i] += e;
    }
    // trim
    const g1 = dbToLin(p.trim + this.offsetDb);
    if (this.gTrim < 0) this.gTrim = g1;
    const dg = (g1 - this.gTrim) / n;
    let g = this.gTrim;
    for (let i = 0; i < n; i++) {
      g += dg;
      l[i] *= g;
      r[i] *= g;
    }
    this.gTrim = g1;
    if (this.raw) {
      this.limiter.ceiling = 1000;
      this.limiter.process(l, r, n);
      return;
    }
    // DC / subsonic high-pass, tone shelves
    this.dcL.block(l, n);
    this.dcR.block(r, n);
    if (p.lowShelf !== 0) {
      this.lowSh[0].block(l, n);
      this.lowSh[1].block(r, n);
    }
    if (p.highShelf !== 0) {
      this.highSh[0].block(l, n);
      this.highSh[1].block(r, n);
    }
    // glue compressor
    if (p.glue > 0) {
      const c = this.comp;
      c.threshold = p.glueThreshold;
      c.ratio = p.glueRatio;
      if (c.attack !== p.glueAttack || c.release !== p.glueRelease) {
        c.attack = p.glueAttack;
        c.release = p.glueRelease;
        c.update();
      }
      c.mix = p.glue;
      c.makeup = 0;
      c.process(l, r, n);
      if (c.gr < this.glueMax) this.glueMax = c.gr;
    }
    // soft saturation: tanh with drive, normalised so small signals pass unchanged
    if (p.sat > 0) {
      const dr = 1 + p.sat * 1.2;
      const inv = 1 / dr;
      for (let i = 0; i < n; i++) {
        l[i] = tanh3(l[i] * dr) * inv;
        r[i] = tanh3(r[i] * dr) * inv;
      }
    }
    this.dc2L.block(l, n);
    this.dc2R.block(r, n);
    // mono bass: remove the side signal below `monoBelow`
    {
      const k = 1 - Math.exp((-TAU * p.monoBelow) / sr);
      let lp = this.sideLp;
      for (let i = 0; i < n; i++) {
        const m = (l[i] + r[i]) * 0.5;
        const s = (l[i] - r[i]) * 0.5;
        lp += k * (s - lp);
        const sh = s - lp;
        l[i] = m + sh;
        r[i] = m - sh;
      }
      this.sideLp = lp;
    }
    // limiter
    const lim = this.limiter;
    lim.ceiling = dbToLin(p.ceiling);
    if (p.release !== this.cache.rel) {
      this.cache.rel = p.release;
      lim.setRelease(p.release, sr);
    }
    lim.process(l, r, n);
  }
}

// ── bus and channel records the engine works with ────────────────────────────

export class Channel {
  /** Silent for a while and nothing pending: the engine skips it until the next event. */
  idle = false;
  quietSamples = 0;
  muted = false;
  constructor(
    readonly name: string,
    readonly inst: Instrument,
    readonly strip: Strip,
    readonly bus: number, // -1 = master, else index into the buses
    readonly key: boolean,
  ) {}
}

export class Bus {
  readonly l = new Float64Array(SEG);
  readonly r = new Float64Array(SEG);
  constructor(
    readonly name: string,
    readonly strip: Strip,
  ) {}
}

void ANTI_DENORMAL;
void suggest;
