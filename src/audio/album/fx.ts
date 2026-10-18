/**
 * Insert effects for channel strips (and buses): drive, chorus, phaser, bit crusher, stereo widener, trance gate,
 * tempo-synced filter, ping-pong delay and a (gated) reverb. All parameters are automatable (`ch.auto('fx.<name>.<param>', ...)`).
 *
 * Create them through the Song helpers (`fx.drive({...})`, `fx.chorus({...})` ...) or directly with `new Drive(ctx, opts)`.
 */
import { ANTI_DENORMAL, TAU, clamp, dbToLin, divisionToBeats, fold, hardClip, sinCyc, tanh3, tube } from './dsp/core';
import { Allpass1, DcBlocker, Svf } from './dsp/filters';
import { DelayLine, Downsampler2x, Upsampler2x } from './dsp/delay';
import { Reverb } from './dsp/reverb';
import { CAB_TYPES, CabType, GuitarAmp } from './dsp/amp';
import { BLOCK, Ctx, Effect, ParamBase, ParamSpecs, pickWord } from './instrument';

/** Every effect factory accepts an optional display `name` (used in automation paths: `fx.<name>.<param>`). */
export interface FxBase {
  name?: string;
}

// ── Drive ────────────────────────────────────────────────────────────────────

export const DRIVE_SPECS = {
  drive: { default: 12, min: 0, max: 48, unit: 'dB', doc: 'Gain into the shaper: more drive, more harmonics and compression.' },
  bias: { default: 0, min: -1, max: 1, doc: 'DC offset into the shaper: adds even harmonics (asymmetric clipping).' },
  tone: { default: 9000, min: 200, max: 20000, unit: 'Hz', curve: 'exp', doc: 'Low-pass after the shaper (tames the fizz).' },
  level: { default: 0, min: -30, max: 12, unit: 'dB', doc: 'Output trim after the shaper.' },
  mix: { default: 1, min: 0, max: 1, doc: 'Dry/wet.' },
} satisfies ParamSpecs;

export interface DriveOpts extends FxBase {
  /** 'soft' tanh, 'tube' asymmetric tube-like, 'hard' hard clip, 'fold' wavefolder. Default 'soft'. */
  mode?: 'soft' | 'tube' | 'hard' | 'fold';
  /** 2x oversampling around the shaper (cleaner highs, double the cost). Default true. */
  oversample?: boolean;
  drive?: number;
  bias?: number;
  tone?: number;
  level?: number;
  mix?: number;
}

export class Drive extends ParamBase<typeof DRIVE_SPECS> implements Effect {
  readonly mono = true;
  private readonly mode: 'soft' | 'tube' | 'hard' | 'fold';
  private readonly os: boolean;
  private readonly up = [new Upsampler2x(), new Upsampler2x()];
  private readonly down = [new Downsampler2x(), new Downsampler2x()];
  private readonly buf2 = new Float64Array(256);
  private readonly dry = new Float64Array(BLOCK);
  private readonly lp = [0, 0];
  private readonly dc = [new DcBlocker().setFc(12, 48000), new DcBlocker().setFc(12, 48000)];
  private readonly sr: number;
  constructor(ctx: Ctx, opts: DriveOpts = {}) {
    super('Drive', DRIVE_SPECS, opts);
    this.mode = pickWord('fx.drive', 'mode', opts.mode, ['soft', 'tube', 'hard', 'fold'] as const, 'soft');
    this.os = opts.oversample ?? true;
    this.sr = ctx.sr;
    for (const d of this.dc) d.setFc(12, ctx.sr);
  }
  private shape(x: number): number {
    switch (this.mode) {
      case 'tube':
        return tube(x);
      case 'hard':
        return hardClip(x);
      case 'fold':
        return fold(x);
      default:
        return tanh3(x);
    }
  }
  private run(x: Float64Array, n: number, c: number): void {
    const p = this.params;
    const g = dbToLin(p.drive);
    const out = dbToLin(p.level);
    const bias = p.bias;
    const mix = p.mix;
    const k = 1 - Math.exp((-TAU * p.tone) / (this.sr * (this.os ? 2 : 1)));
    const dc0 = this.shape(bias);
    const d = this.dry;
    for (let i = 0; i < n; i++) d[i] = x[i];
    if (this.os) {
      const b = this.buf2;
      this.up[c].process(x, n, b);
      let lp = this.lp[c];
      for (let i = 0; i < 2 * n; i++) {
        const y = this.shape(b[i] * g + bias) - dc0;
        lp += k * (y - lp);
        b[i] = lp;
      }
      this.lp[c] = lp;
      this.down[c].process(b, n, x);
    } else {
      let lp = this.lp[c];
      for (let i = 0; i < n; i++) {
        const y = this.shape(x[i] * g + bias) - dc0;
        lp += k * (y - lp);
        x[i] = lp;
      }
      this.lp[c] = lp;
    }
    const dcb = this.dc[c];
    for (let i = 0; i < n; i++) {
      const wet = dcb.process(x[i]) * out;
      x[i] = d[i] + (wet - d[i]) * mix;
    }
  }
  processMono(x: Float64Array, n: number): void {
    this.run(x, n, 0);
  }
  process(l: Float64Array, r: Float64Array, n: number): void {
    this.run(l, n, 0);
    this.run(r, n, 1);
  }
  active(): boolean {
    return false;
  }
}

// ── Chorus ───────────────────────────────────────────────────────────────────

export const CHORUS_SPECS = {
  rate: { default: 0.6, min: 0.02, max: 10, unit: 'Hz', curve: 'exp', doc: 'LFO speed.' },
  depth: { default: 3.5, min: 0, max: 15, unit: 'ms', doc: 'Modulation depth of the delay taps.' },
  delay: { default: 14, min: 1, max: 40, unit: 'ms', doc: 'Centre delay (short = flanger, 12-25 = chorus).' },
  feedback: { default: 0, min: -0.9, max: 0.9, doc: 'Feedback (with a short delay this is a flanger).' },
  mix: { default: 0.5, min: 0, max: 1, doc: 'Wet level (the dry signal always stays at full level).' },
  spread: { default: 1, min: 0, max: 1, doc: 'Stereo spread of the voices.' },
} satisfies ParamSpecs;

export interface ChorusOpts extends FxBase {
  /** Number of detuned voices per side (1..4). Default 3. */
  voices?: number;
  rate?: number;
  depth?: number;
  delay?: number;
  feedback?: number;
  mix?: number;
  spread?: number;
}

export class Chorus extends ParamBase<typeof CHORUS_SPECS> implements Effect {
  readonly mono = false;
  private readonly lines: [DelayLine, DelayLine];
  private readonly phase: Float64Array;
  private readonly nv: number;
  private readonly sr: number;
  private fbL = 0;
  private fbR = 0;
  private primed = false;
  private readonly dL = new Float64Array(4);
  private readonly dR = new Float64Array(4);
  private readonly stepL = new Float64Array(4);
  private readonly stepR = new Float64Array(4);
  constructor(ctx: Ctx, opts: ChorusOpts = {}) {
    super('Chorus', CHORUS_SPECS, opts);
    this.sr = ctx.sr;
    this.nv = clamp(Math.round(opts.voices ?? 3), 1, 4);
    this.phase = new Float64Array(this.nv);
    for (let v = 0; v < this.nv; v++) this.phase[v] = v / this.nv;
    this.lines = [new DelayLine(Math.ceil(0.07 * ctx.sr)), new DelayLine(Math.ceil(0.07 * ctx.sr))];
  }
  process(l: Float64Array, r: Float64Array, n: number): void {
    const p = this.params;
    const sr = this.sr;
    const depth = (p.depth / 1000) * sr;
    const centre = (p.delay / 1000) * sr;
    const nv = this.nv;
    const wet = p.mix / nv;
    const fb = p.feedback;
    const off = 0.5 * p.spread; // phase offset of the right channel's modulation: decorrelates L and R
    const phase = this.phase;
    const bufL = this.lines[0].buf;
    const bufR = this.lines[1].buf;
    const mask = this.lines[0].mask;
    let pos = this.lines[0].pos;
    let fbL = this.fbL;
    let fbR = this.fbR;
    // the modulation moves slowly: the delay of every tap is computed every 16 samples and interpolated linearly in between
    const dL = this.dL;
    const dR = this.dR;
    const stepL = this.stepL;
    const stepR = this.stepR;
    for (let c0 = 0; c0 < n; c0 += 16) {
      const c1 = Math.min(n, c0 + 16);
      const len = c1 - c0;
      for (let v = 0; v < nv; v++) {
        let a = phase[v] + (p.rate * len) / sr;
        if (a >= 1) a -= 1;
        phase[v] = a;
        let b = a + off;
        if (b >= 1) b -= 1;
        const tl = Math.max(2, centre + depth * sinCyc(a));
        const tr = Math.max(2, centre + depth * sinCyc(b));
        if (c0 === 0 && !this.primed) {
          dL[v] = tl;
          dR[v] = tr;
        }
        stepL[v] = (tl - dL[v]) / len;
        stepR[v] = (tr - dR[v]) / len;
      }
      this.primed = true;
      for (let i = c0; i < c1; i++) {
        const xl = l[i];
        const xr = r[i];
        bufL[pos] = xl + fbL * fb;
        bufR[pos] = xr + fbR * fb;
        let wl = 0;
        let wr = 0;
        for (let v = 0; v < nv; v++) {
          dL[v] += stepL[v];
          dR[v] += stepR[v];
          const al = dL[v] - 1;
          const il = al | 0;
          const fl = al - il;
          const j0 = (pos - il) & mask;
          const y0 = bufL[j0];
          wl += y0 + fl * (bufL[(j0 - 1) & mask] - y0);
          const ar = dR[v] - 1;
          const ir = ar | 0;
          const fr = ar - ir;
          const k0 = (pos - ir) & mask;
          const z0 = bufR[k0];
          wr += z0 + fr * (bufR[(k0 - 1) & mask] - z0);
        }
        pos = (pos + 1) & mask;
        fbL = wl / nv + ANTI_DENORMAL;
        fbR = wr / nv + ANTI_DENORMAL;
        l[i] = xl + wl * wet;
        r[i] = xr + wr * wet;
      }
    }
    this.lines[0].pos = pos;
    this.lines[1].pos = pos;
    this.fbL = fbL;
    this.fbR = fbR;
  }
  active(): boolean {
    return false;
  }
}

// ── Phaser ───────────────────────────────────────────────────────────────────

export const PHASER_SPECS = {
  rate: { default: 0.3, min: 0.02, max: 8, unit: 'Hz', curve: 'exp', doc: 'Sweep speed.' },
  depth: { default: 0.8, min: 0, max: 1, doc: 'Sweep range in octaves/4.' },
  centre: { default: 900, min: 100, max: 6000, unit: 'Hz', curve: 'exp', doc: 'Centre frequency of the sweep.' },
  feedback: { default: 0.5, min: -0.95, max: 0.95, doc: 'Resonance of the notches.' },
  mix: { default: 0.5, min: 0, max: 1, doc: 'Wet level (equal parts of dry and wet = deepest notches).' },
} satisfies ParamSpecs;

export interface PhaserOpts extends FxBase {
  /** All-pass stages per channel (2..12, even numbers sound classic). Default 6. */
  stages?: number;
  rate?: number;
  depth?: number;
  centre?: number;
  feedback?: number;
  mix?: number;
}

export class Phaser extends ParamBase<typeof PHASER_SPECS> implements Effect {
  readonly mono = false;
  private readonly ap: Allpass1[][];
  private readonly sr: number;
  private ph = 0;
  private fbL = 0;
  private fbR = 0;
  private readonly stages: number;
  constructor(ctx: Ctx, opts: PhaserOpts = {}) {
    super('Phaser', PHASER_SPECS, opts);
    this.sr = ctx.sr;
    this.stages = clamp(Math.round(opts.stages ?? 6), 2, 12);
    this.ap = [[], []];
    for (let c = 0; c < 2; c++) for (let s = 0; s < this.stages; s++) this.ap[c].push(new Allpass1());
  }
  process(l: Float64Array, r: Float64Array, n: number): void {
    const p = this.params;
    // coefficients per segment (k-rate), phase offset between the channels for width
    this.ph += (p.rate * n) / this.sr;
    if (this.ph >= 1) this.ph -= 1;
    const mod = (ph: number): number => sinCyc(ph - Math.floor(ph));
    const fL = p.centre * Math.pow(2, mod(this.ph) * p.depth * 2);
    const fR = p.centre * Math.pow(2, mod(this.ph + 0.25) * p.depth * 2);
    for (let s = 0; s < this.stages; s++) {
      this.ap[0][s].setFc(fL * (1 + s * 0.35), this.sr);
      this.ap[1][s].setFc(fR * (1 + s * 0.35), this.sr);
    }
    const fb = p.feedback;
    const mix = p.mix;
    for (let i = 0; i < n; i++) {
      let yl = l[i] + this.fbL * fb;
      let yr = r[i] + this.fbR * fb;
      for (let s = 0; s < this.stages; s++) {
        yl = this.ap[0][s].process(yl);
        yr = this.ap[1][s].process(yr);
      }
      this.fbL = yl + ANTI_DENORMAL;
      this.fbR = yr + ANTI_DENORMAL;
      l[i] += (yl - l[i]) * mix;
      r[i] += (yr - r[i]) * mix;
    }
  }
  active(): boolean {
    return false;
  }
}

// ── Bit crusher ──────────────────────────────────────────────────────────────

export const CRUSH_SPECS = {
  bits: { default: 8, min: 1, max: 16, doc: 'Bit depth (quantisation).' },
  rate: { default: 4, min: 1, max: 64, doc: 'Sample-rate reduction factor (1 = off).' },
  mix: { default: 1, min: 0, max: 1, doc: 'Dry/wet.' },
} satisfies ParamSpecs;

export interface CrusherOpts extends FxBase {
  bits?: number;
  rate?: number;
  mix?: number;
}

export class Crusher extends ParamBase<typeof CRUSH_SPECS> implements Effect {
  readonly mono = true;
  private readonly held = [0, 0];
  private readonly count = [0, 0];
  constructor(_ctx: Ctx, opts: CrusherOpts = {}) {
    super('Crusher', CRUSH_SPECS, opts);
  }
  private run(x: Float64Array, n: number, c: number): void {
    const p = this.params;
    const levels = Math.pow(2, p.bits - 1);
    const every = Math.max(1, p.rate);
    let held = this.held[c];
    let cnt = this.count[c];
    const mix = p.mix;
    for (let i = 0; i < n; i++) {
      cnt += 1;
      if (cnt >= every) {
        cnt -= every;
        held = Math.round(clamp(x[i], -1, 1) * levels) / levels;
      }
      x[i] += (held - x[i]) * mix;
    }
    this.held[c] = held;
    this.count[c] = cnt;
  }
  processMono(x: Float64Array, n: number): void {
    this.run(x, n, 0);
  }
  process(l: Float64Array, r: Float64Array, n: number): void {
    this.run(l, n, 0);
    this.run(r, n, 1);
  }
  active(): boolean {
    return false;
  }
}

// ── Widener ──────────────────────────────────────────────────────────────────

export const WIDEN_SPECS = {
  width: { default: 1.3, min: 0, max: 2.5, doc: 'Side level: 0 = mono, 1 = unchanged, 2 = very wide.' },
  monoBelow: { default: 140, min: 20, max: 600, unit: 'Hz', curve: 'exp', doc: 'Below this frequency the side signal is removed (keeps the lows centred).' },
} satisfies ParamSpecs;

export interface WidenerOpts extends FxBase {
  width?: number;
  monoBelow?: number;
}

export class Widener extends ParamBase<typeof WIDEN_SPECS> implements Effect {
  readonly mono = false;
  private lp = 0;
  private readonly sr: number;
  constructor(ctx: Ctx, opts: WidenerOpts = {}) {
    super('Widener', WIDEN_SPECS, opts);
    this.sr = ctx.sr;
  }
  process(l: Float64Array, r: Float64Array, n: number): void {
    const k = 1 - Math.exp((-TAU * this.params.monoBelow) / this.sr);
    const w = this.params.width;
    let lp = this.lp;
    for (let i = 0; i < n; i++) {
      const m = (l[i] + r[i]) * 0.5;
      const s = (l[i] - r[i]) * 0.5;
      lp += k * (s - lp);
      const sOut = (s - lp) * w; // the side signal without its lows, scaled
      l[i] = m + sOut;
      r[i] = m - sOut;
    }
    this.lp = lp;
  }
  active(): boolean {
    return false;
  }
}

// ── Trance gate ──────────────────────────────────────────────────────────────

export const GATE_SPECS = {
  depth: { default: 1, min: 0, max: 1, doc: 'How far the gate closes (1 = silent between hits).' },
  attack: { default: 2, min: 0.2, max: 50, unit: 'ms', doc: 'Opening time.' },
  release: { default: 25, min: 0.5, max: 400, unit: 'ms', doc: 'Closing time.' },
} satisfies ParamSpecs;

export interface GateOpts extends FxBase {
  /** One character per step: 'x' open, '.' closed, digits 1-9 = partial level. Whitespace and | are ignored. */
  pattern: string;
  /** Steps per beat (4 = 16ths, 2 = 8ths, 8 = 32nds). Default 4. */
  res?: number;
  depth?: number;
  attack?: number;
  release?: number;
}

export class TranceGate extends ParamBase<typeof GATE_SPECS> implements Effect {
  readonly mono = true;
  private readonly steps: Float64Array;
  private readonly res: number;
  private readonly ctx: Ctx;
  private readonly g = [1, 1];
  constructor(ctx: Ctx, opts: GateOpts) {
    super('TranceGate', GATE_SPECS, opts);
    this.ctx = ctx;
    this.res = opts.res ?? 4;
    const chars = [...opts.pattern.replace(/[\s|]/g, '')];
    if (!chars.length) throw new Error('TranceGate: empty pattern');
    this.steps = new Float64Array(chars.length);
    chars.forEach((c, i) => {
      if (c === 'x' || c === 'X') this.steps[i] = 1;
      else if (c >= '1' && c <= '9') this.steps[i] = (c.charCodeAt(0) - 48) / 9;
      else if (c === '.' || c === '-' || c === '0') this.steps[i] = 0;
      else throw new Error(`TranceGate: bad pattern character "${c}" (use x . - 0-9)`);
    });
  }
  private run(x: Float64Array, n: number, c: number): void {
    const p = this.params;
    const sr = this.ctx.sr;
    const spb = (this.ctx.sr * 60) / this.ctx.bpm;
    const aK = 1 - Math.exp(-1 / ((p.attack / 1000) * sr));
    const rK = 1 - Math.exp(-1 / ((p.release / 1000) * sr));
    const depth = p.depth;
    const len = this.steps.length;
    let g = this.g[c];
    for (let i = 0; i < n; i++) {
      const stepF = (this.ctx.transport.beat + i / spb) * this.res;
      const idx = (Math.floor(stepF + 1e-9) % len + len) % len;
      const target = 1 - depth * (1 - this.steps[idx]);
      g += (target - g) * (target > g ? aK : rK);
      x[i] *= g;
    }
    this.g[c] = g;
  }
  processMono(x: Float64Array, n: number): void {
    this.run(x, n, 0);
  }
  process(l: Float64Array, r: Float64Array, n: number): void {
    this.run(l, n, 0);
    this.run(r, n, 1);
  }
  active(): boolean {
    return false;
  }
}

// ── Filter (with a tempo-locked LFO) ─────────────────────────────────────────

export const FILTER_SPECS = {
  cutoff: { default: 1200, min: 20, max: 20000, unit: 'Hz', curve: 'exp', doc: 'Centre / corner frequency.' },
  res: { default: 0.8, min: 0.3, max: 20, doc: 'Resonance as Q (0.7 = flat, 4 = pronounced, 12 = whistling).' },
  lfoRate: { default: 0, min: 0, max: 16, unit: 'cycles/beat', doc: 'LFO speed, locked to the song tempo (0 = off). 0.25 = one cycle per bar in 4/4.' },
  lfoDepth: { default: 1, min: 0, max: 6, unit: 'octaves', doc: 'LFO swing of the cutoff, in octaves each way.' },
  lfoPhase: { default: 0, min: 0, max: 1, doc: 'LFO phase offset (0..1 of a cycle).' },
  mix: { default: 1, min: 0, max: 1, doc: 'Dry/wet.' },
} satisfies ParamSpecs;

export interface FilterFxOpts extends FxBase {
  /** 'lp' (default), 'hp', 'bp' or 'notch'. */
  mode?: 'lp' | 'hp' | 'bp' | 'notch';
  /** LFO shape: 'sine' (default), 'tri', 'saw', 'ramp' or 'square'. Position-locked to the song, never drifts. */
  shape?: 'sine' | 'tri' | 'saw' | 'ramp' | 'square';
  cutoff?: number;
  res?: number;
  lfoRate?: number;
  lfoDepth?: number;
  lfoPhase?: number;
  mix?: number;
}

export class FilterFx extends ParamBase<typeof FILTER_SPECS> implements Effect {
  readonly mono = true;
  private readonly f = [new Svf(), new Svf()];
  private readonly mode: 'lp' | 'hp' | 'bp' | 'notch';
  private readonly shape: 'sine' | 'tri' | 'saw' | 'ramp' | 'square';
  private readonly ctx: Ctx;
  constructor(ctx: Ctx, opts: FilterFxOpts = {}) {
    super('FilterFx', FILTER_SPECS, opts);
    this.ctx = ctx;
    this.mode = pickWord('fx.filter', 'mode', opts.mode, ['lp', 'hp', 'bp', 'notch'] as const, 'lp');
    this.shape = pickWord('fx.filter', 'shape', opts.shape, ['sine', 'tri', 'saw', 'ramp', 'square'] as const, 'sine');
  }
  private lfo(): number {
    const p = this.params;
    if (p.lfoRate <= 0) return 0;
    let ph = this.ctx.transport.beat * p.lfoRate + p.lfoPhase;
    ph -= Math.floor(ph);
    switch (this.shape) {
      case 'tri':
        return ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
      case 'saw':
        return 2 * ph - 1;
      case 'ramp':
        return 1 - 2 * ph;
      case 'square':
        return ph < 0.5 ? 1 : -1;
      default:
        return sinCyc(ph);
    }
  }
  private run(x: Float64Array, n: number, c: number): void {
    const p = this.params;
    const fc = p.cutoff * Math.pow(2, this.lfo() * p.lfoDepth);
    const f = this.f[c];
    f.set(fc, p.res, this.ctx.sr);
    const mix = p.mix;
    for (let i = 0; i < n; i++) {
      const dry = x[i];
      f.step(dry);
      const wet = this.mode === 'lp' ? f.lp : this.mode === 'hp' ? f.hp : this.mode === 'bp' ? f.k * f.bp : f.lp + f.hp;
      x[i] = dry + (wet - dry) * mix;
    }
  }
  processMono(x: Float64Array, n: number): void {
    this.run(x, n, 0);
  }
  process(l: Float64Array, r: Float64Array, n: number): void {
    this.run(l, n, 0);
    this.run(r, n, 1);
  }
  active(): boolean {
    return false;
  }
}

// ── Ping-pong delay ──────────────────────────────────────────────────────────

export const DELAY_SPECS = {
  time: { default: 0.75, min: 0.0625, max: 4, unit: 'beats', doc: 'Delay time in beats (0.75 = dotted eighth, 0.5 = eighth, 0.25 = sixteenth, 1 = quarter).' },
  feedback: { default: 0.4, min: 0, max: 0.95, doc: 'How much of the output returns to the input.' },
  pingpong: { default: 0.8, min: 0, max: 1, doc: 'Amount of left/right alternation (0 = plain stereo echo).' },
  tone: { default: 4200, min: 500, max: 16000, unit: 'Hz', curve: 'exp', doc: 'Low-pass in the feedback loop (darker repeats).' },
  lowCut: { default: 160, min: 20, max: 1500, unit: 'Hz', curve: 'exp', doc: 'High-pass in the feedback loop (thinner repeats).' },
  drive: { default: 0.15, min: 0, max: 1, doc: 'Soft saturation in the loop (tape-like warmth).' },
  mod: { default: 0.15, min: 0, max: 1, doc: 'Slow pitch wobble of the repeats.' },
  mix: { default: 1, min: 0, max: 1, doc: 'Wet level (as an insert; as the song-wide send it is the return level).' },
} satisfies ParamSpecs;

export interface DelayOpts extends FxBase {
  /** Time as a note division ('1/8.', '1/4', '3/16') or a number of beats. Same as the `time` parameter. */
  time?: number | string;
  feedback?: number;
  pingpong?: number;
  tone?: number;
  lowCut?: number;
  drive?: number;
  mod?: number;
  mix?: number;
}

/** The stereo delay engine: `run` adds the wet signal of in -> out (100 % wet, scaled by `mix`). */
export class PingPongDelay extends ParamBase<typeof DELAY_SPECS> {
  private readonly dl: DelayLine;
  private readonly dr: DelayLine;
  private readonly sr: number;
  private readonly bpm: number;
  private tl = 0;
  private tr = 0;
  private lpL = 0;
  private lpR = 0;
  private hpL = 0;
  private hpR = 0;
  private modPh = 0;
  private cur = -1;
  constructor(ctx: Ctx, opts: DelayOpts = {}) {
    const o = { ...opts } as Record<string, unknown>;
    if (o.time !== undefined) o.time = divisionToBeats(o.time as number | string);
    super('Delay', DELAY_SPECS, o);
    this.sr = ctx.sr;
    this.bpm = ctx.bpm;
    this.dl = new DelayLine(Math.ceil(ctx.sr * 4.2 * (60 / ctx.bpm) * 1.0) + 2048);
    this.dr = new DelayLine(Math.ceil(ctx.sr * 4.2 * (60 / ctx.bpm) * 1.0) + 2048);
  }
  run(inL: Float64Array, inR: Float64Array, outL: Float64Array, outR: Float64Array, n: number): void {
    const p = this.params;
    const sr = this.sr;
    const target = (p.time * 60 * sr) / this.bpm;
    if (this.cur < 0) this.cur = target;
    const fb = p.feedback;
    const pp = p.pingpong;
    const lpK = 1 - Math.exp((-TAU * p.tone) / sr);
    const hpK = 1 - Math.exp((-TAU * p.lowCut) / sr);
    const dr = 1 + p.drive * 3;
    const mix = p.mix;
    const modAmt = p.mod * 0.0012 * sr;
    for (let i = 0; i < n; i++) {
      // glide towards the target delay (time changes sound like a tape slewing, no clicks)
      this.cur += (target - this.cur) * 0.0015;
      this.modPh += 0.37 / sr;
      if (this.modPh >= 1) this.modPh -= 1;
      const d = Math.max(4, this.cur + modAmt * sinCyc(this.modPh));
      const rl = this.dl.tapCubic(d - 1);
      const rr = this.dr.tapCubic(d - 1);
      // filter the feedback path
      this.lpL += lpK * (rl - this.lpL);
      this.lpR += lpK * (rr - this.lpR);
      this.hpL += hpK * (this.lpL - this.hpL);
      this.hpR += hpK * (this.lpR - this.hpR);
      let fl = this.lpL - this.hpL;
      let fr = this.lpR - this.hpR;
      if (p.drive > 0) {
        fl = tanh3(fl * dr) / dr;
        fr = tanh3(fr * dr) / dr;
      }
      // ping-pong: the left repeat feeds the right line and vice versa; pingpong = 0 keeps each side on its own
      const xl = inL[i];
      const xr = inR[i];
      const mono = (xl + xr) * 0.5;
      const sendL = mono * pp + xl * (1 - pp);
      this.dl.write(sendL + (fr * pp + fl * (1 - pp)) * fb + ANTI_DENORMAL);
      const sendR = xr * (1 - pp);
      this.dr.write(sendR + (fl * pp + fr * (1 - pp)) * fb + ANTI_DENORMAL);
      outL[i] += fl * mix;
      outR[i] += fr * mix;
    }
  }
}

export class DelayFx extends PingPongDelay implements Effect {
  readonly mono = false;
  private readonly tmpL = new Float64Array(BLOCK);
  private readonly tmpR = new Float64Array(BLOCK);
  constructor(ctx: Ctx, opts: DelayOpts = {}) {
    super(ctx, { ...opts, mix: opts.mix ?? 0.35 });
  }
  process(l: Float64Array, r: Float64Array, n: number): void {
    const a = this.tmpL;
    const b = this.tmpR;
    a.fill(0, 0, n);
    b.fill(0, 0, n);
    this.run(l, r, a, b, n);
    for (let i = 0; i < n; i++) {
      l[i] += a[i];
      r[i] += b[i];
    }
  }
  active(): boolean {
    return true;
  }
}

// ── Reverb insert (plain or gated) ───────────────────────────────────────────

export const REVERB_FX_SPECS = {
  time: { default: 1.6, min: 0.1, max: 12, unit: 's', doc: 'Reverb time (RT60).' },
  damp: { default: 0.5, min: 0, max: 1, doc: 'High-frequency damping.' },
  size: { default: 1, min: 0.3, max: 3, doc: 'Room size.' },
  preDelay: { default: 0.012, min: 0, max: 0.3, unit: 's', doc: 'Pre-delay.' },
  mix: { default: 0.3, min: 0, max: 1, doc: 'Wet level (dry stays at full level).' },
  hold: { default: 140, min: 10, max: 1000, unit: 'ms', doc: 'Gated mode: how long the gate stays open after the dry signal.' },
  close: { default: 70, min: 5, max: 500, unit: 'ms', doc: 'Gated mode: closing time.' },
  threshold: { default: -34, min: -80, max: 0, unit: 'dB', doc: 'Gated mode: the dry level that opens the gate.' },
} satisfies ParamSpecs;

export interface ReverbFxOpts extends FxBase {
  /** true: the 80s gated reverb (the tail is cut off by a gate keyed from the dry signal). Default false. */
  gated?: boolean;
  time?: number;
  damp?: number;
  size?: number;
  preDelay?: number;
  mix?: number;
  hold?: number;
  close?: number;
  threshold?: number;
}

export class ReverbFx extends ParamBase<typeof REVERB_FX_SPECS> implements Effect {
  readonly mono = false;
  private readonly rv: Reverb;
  private readonly gated: boolean;
  private readonly wl = new Float64Array(BLOCK);
  private readonly wr = new Float64Array(BLOCK);
  private readonly sr: number;
  private env = 0;
  private holdLeft = 0;
  private gate = 0;
  private tail = 0;
  constructor(ctx: Ctx, opts: ReverbFxOpts = {}) {
    super('ReverbFx', REVERB_FX_SPECS, opts);
    this.sr = ctx.sr;
    this.gated = opts.gated ?? false;
    this.rv = new Reverb(ctx.sr, { early: this.gated ? 0.8 : 0.35, lowCut: 200, highCut: 10000 });
  }
  process(l: Float64Array, r: Float64Array, n: number): void {
    const p = this.params;
    if (p.time !== this.rv.p.time) this.rv.setParam('time', p.time);
    if (p.damp !== this.rv.p.damp) this.rv.setParam('damp', p.damp);
    if (p.size !== this.rv.p.size) this.rv.setParam('size', p.size);
    this.rv.p.preDelay = p.preDelay;
    const a = this.wl;
    const b = this.wr;
    a.fill(0, 0, n);
    b.fill(0, 0, n);
    this.rv.process(l, r, a, b, n);
    const mix = p.mix * 1.5;
    if (!this.gated) {
      for (let i = 0; i < n; i++) {
        l[i] += a[i] * mix;
        r[i] += b[i] * mix;
      }
      this.tail = Math.max(0, this.tail - n);
      return;
    }
    const thr = dbToLin(p.threshold);
    const hold = (p.hold / 1000) * this.sr;
    const closeK = 1 - Math.exp(-1 / ((p.close / 1000) * this.sr));
    for (let i = 0; i < n; i++) {
      const lvl = Math.max(Math.abs(l[i]), Math.abs(r[i]));
      this.env = Math.max(lvl, this.env * 0.9995);
      if (this.env > thr) this.holdLeft = hold;
      else if (this.holdLeft > 0) this.holdLeft -= 1;
      const target = this.holdLeft > 0 ? 1 : 0;
      this.gate += (target - this.gate) * (target > this.gate ? 0.05 : closeK);
      l[i] += a[i] * this.gate * mix;
      r[i] += b[i] * this.gate * mix;
    }
  }
  active(): boolean {
    return true;
  }
}

// ── factory table used by the Song helpers ───────────────────────────────────

export const FX_KINDS = {
  drive: (c: Ctx, o: DriveOpts) => new Drive(c, o),
  chorus: (c: Ctx, o: ChorusOpts) => new Chorus(c, o),
  phaser: (c: Ctx, o: PhaserOpts) => new Phaser(c, o),
  crusher: (c: Ctx, o: CrusherOpts) => new Crusher(c, o),
  widener: (c: Ctx, o: WidenerOpts) => new Widener(c, o),
  gate: (c: Ctx, o: GateOpts) => new TranceGate(c, o),
  filter: (c: Ctx, o: FilterFxOpts) => new FilterFx(c, o),
  delay: (c: Ctx, o: DelayOpts) => new DelayFx(c, o),
  reverb: (c: Ctx, o: ReverbFxOpts) => new ReverbFx(c, o),
  amp: (c: Ctx, o: AmpFxOpts) => new AmpFx(c, o),
} as const;

export type FxKind = keyof typeof FX_KINDS;

// ── Amp + cabinet (any channel through the guitar amp) ───────────────────────

export const AMP_SPECS = {
  gain: { default: 0.65, min: 0, max: 1, doc: 'Amp gain: 0 clean, 0.3 crunch, 0.6 punk / hard rock, 0.85 high-gain.' },
  tight: { default: 0.5, min: 0, max: 1, doc: 'How much low end is cut before the distortion.' },
  bass: { default: 0, min: -12, max: 12, unit: 'dB', doc: 'Tone stack: bass.' },
  mid: { default: 1, min: -12, max: 12, unit: 'dB', doc: 'Tone stack: mids.' },
  treble: { default: -0.5, min: -12, max: 12, unit: 'dB', doc: 'Tone stack: treble.' },
  presence: { default: -1.5, min: -12, max: 12, unit: 'dB', doc: 'Tone stack: presence.' },
  boost: { default: 0.4, min: 0, max: 1, doc: 'Screamer-style mid boost in front of the amp.' },
  sag: { default: 0.4, min: 0, max: 1, doc: 'Power-amp sag (compression on loud notes).' },
  gate: { default: -62, min: -90, max: -30, unit: 'dB', doc: 'Noise-gate threshold (-90 = off).' },
  cabBright: { default: 0, min: -1, max: 1, doc: 'Cabinet brightness.' },
  level: { default: -12, min: -40, max: 12, unit: 'dB', doc: 'Output level (the amp is loud: the default leaves room in the mix).' },
  mix: { default: 1, min: 0, max: 1, doc: 'Dry/wet.' },
} satisfies ParamSpecs;

export interface AmpFxOpts extends FxBase {
  /** Cabinet: '4x12' (default), '2x12', '1x12', 'bass-8x10', 'bass-1x15' or 'none'. */
  cab?: CabType;
  gain?: number;
  tight?: number;
  bass?: number;
  mid?: number;
  treble?: number;
  presence?: number;
  boost?: number;
  sag?: number;
  gate?: number;
  cabBright?: number;
  level?: number;
  mix?: number;
}

/** The guitar amp and cabinet as an insert: run a synth lead, a bass or a whole drum loop through it. */
export class AmpFx extends ParamBase<typeof AMP_SPECS> implements Effect {
  readonly mono = true;
  private readonly amps: [GuitarAmp, GuitarAmp];
  private readonly dry = new Float64Array(BLOCK);
  private last = '';
  constructor(ctx: Ctx, opts: AmpFxOpts = {}) {
    super('AmpFx', AMP_SPECS, opts);
    const cab = pickWord('fx.amp', 'cab', opts.cab, CAB_TYPES, '4x12');
    this.amps = [new GuitarAmp(ctx.sr, { cab }), new GuitarAmp(ctx.sr, { cab })];
  }
  private sync(): void {
    const p = this.params;
    const key = `${p.gain}|${p.tight}|${p.bass}|${p.mid}|${p.treble}|${p.presence}|${p.boost}|${p.sag}|${p.gate}|${p.cabBright}`;
    if (key === this.last) return;
    this.last = key;
    for (const a of this.amps) {
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
  private run(x: Float64Array, n: number, c: number): void {
    const mix = this.params.mix;
    const d = this.dry;
    if (mix < 1) for (let i = 0; i < n; i++) d[i] = x[i];
    this.amps[c].process(x, n);
    const g = dbToLin(this.params.level);
    for (let i = 0; i < n; i++) x[i] = mix < 1 ? d[i] + (x[i] * g - d[i]) * mix : x[i] * g;
  }
  processMono(x: Float64Array, n: number): void {
    this.sync();
    this.run(x, n, 0);
  }
  process(l: Float64Array, r: Float64Array, n: number): void {
    this.sync();
    this.run(l, n, 0);
    this.run(r, n, 1);
  }
  active(): boolean {
    return false;
  }
}
