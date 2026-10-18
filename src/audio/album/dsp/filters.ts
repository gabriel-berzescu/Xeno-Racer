/**
 * Filters: biquad (RBJ designs), one-pole, DC blocker, state-variable filter (SVF), 4-pole Moog-style ladder.
 * Everything keeps its state in plain numeric fields; the hot loops are written so the JIT keeps them monomorphic.
 * Coefficient updates are meant to happen at control rate (once per rendered segment, <= 64 samples).
 */
import { TAU, tanh3, clamp } from './core';

/** Direct-form-II-transposed biquad with RBJ cookbook designs (all `set*` methods return `this`). */
export class Biquad {
  b0 = 1;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  z1 = 0;
  z2 = 0;

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  /** Filters buf[0..n) in place. */
  block(buf: Float64Array, n: number): void {
    const b0 = this.b0;
    const b1 = this.b1;
    const b2 = this.b2;
    const a1 = this.a1;
    const a2 = this.a2;
    let z1 = this.z1;
    let z2 = this.z2;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }
    this.z1 = z1;
    this.z2 = z2;
  }
  reset(): this {
    this.z1 = 0;
    this.z2 = 0;
    return this;
  }
  setIdentity(): this {
    this.b0 = 1;
    this.b1 = 0;
    this.b2 = 0;
    this.a1 = 0;
    this.a2 = 0;
    return this;
  }
  copyFrom(o: Biquad): this {
    this.b0 = o.b0;
    this.b1 = o.b1;
    this.b2 = o.b2;
    this.a1 = o.a1;
    this.a2 = o.a2;
    return this;
  }
  private norm(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): this {
    const i = 1 / a0;
    this.b0 = b0 * i;
    this.b1 = b1 * i;
    this.b2 = b2 * i;
    this.a1 = a1 * i;
    this.a2 = a2 * i;
    return this;
  }
  lowpass(fc: number, q: number, sr: number): this {
    const w = (TAU * clamp(fc, 5, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    return this.norm((1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + al, -2 * cw, 1 - al);
  }
  highpass(fc: number, q: number, sr: number): this {
    const w = (TAU * clamp(fc, 5, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    return this.norm((1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + al, -2 * cw, 1 - al);
  }
  /** Constant 0 dB peak-gain band-pass. */
  bandpass(fc: number, q: number, sr: number): this {
    const w = (TAU * clamp(fc, 5, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    return this.norm(al, 0, -al, 1 + al, -2 * cw, 1 - al);
  }
  notch(fc: number, q: number, sr: number): this {
    const w = (TAU * clamp(fc, 5, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    return this.norm(1, -2 * cw, 1, 1 + al, -2 * cw, 1 - al);
  }
  allpass(fc: number, q: number, sr: number): this {
    const w = (TAU * clamp(fc, 5, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    return this.norm(1 - al, -2 * cw, 1 + al, 1 + al, -2 * cw, 1 - al);
  }
  peaking(fc: number, q: number, gainDb: number, sr: number): this {
    const A = Math.pow(10, gainDb / 40);
    const w = (TAU * clamp(fc, 5, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    return this.norm(1 + al * A, -2 * cw, 1 - al * A, 1 + al / A, -2 * cw, 1 - al / A);
  }
  /** Shelf slope S = 1 (as steep as it can be without overshoot). */
  highShelf(fc: number, gainDb: number, sr: number, slope = 1): this {
    const A = Math.pow(10, gainDb / 40);
    const w = (TAU * clamp(fc, 5, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const al = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
    const t = 2 * Math.sqrt(A) * al;
    return this.norm(
      A * (A + 1 + (A - 1) * cw + t),
      -2 * A * (A - 1 + (A + 1) * cw),
      A * (A + 1 + (A - 1) * cw - t),
      A + 1 - (A - 1) * cw + t,
      2 * (A - 1 - (A + 1) * cw),
      A + 1 - (A - 1) * cw - t,
    );
  }
  lowShelf(fc: number, gainDb: number, sr: number, slope = 1): this {
    const A = Math.pow(10, gainDb / 40);
    const w = (TAU * clamp(fc, 5, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const al = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
    const t = 2 * Math.sqrt(A) * al;
    return this.norm(
      A * (A + 1 - (A - 1) * cw + t),
      2 * A * (A - 1 - (A + 1) * cw),
      A * (A + 1 - (A - 1) * cw - t),
      A + 1 + (A - 1) * cw + t,
      -2 * (A - 1 + (A + 1) * cw),
      A + 1 + (A - 1) * cw - t,
    );
  }
  /** Magnitude response |H| at frequency f (Hz). */
  magnitude(f: number, sr: number): number {
    const w = (TAU * f) / sr;
    const c1 = Math.cos(w);
    const s1 = Math.sin(w);
    const c2 = Math.cos(2 * w);
    const s2 = Math.sin(2 * w);
    const nr = this.b0 + this.b1 * c1 + this.b2 * c2;
    const ni = -(this.b1 * s1 + this.b2 * s2);
    const dr = 1 + this.a1 * c1 + this.a2 * c2;
    const di = -(this.a1 * s1 + this.a2 * s2);
    return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  }
}

/** A cascade of biquads processed in series (used for steep filters, cabinet curves and EQ stacks). */
export class BiquadChain {
  readonly stages: Biquad[];
  constructor(n: number) {
    this.stages = [];
    for (let i = 0; i < n; i++) this.stages.push(new Biquad());
  }
  process(x: number): number {
    const s = this.stages;
    for (let i = 0; i < s.length; i++) x = s[i].process(x);
    return x;
  }
  block(buf: Float64Array, n: number): void {
    const s = this.stages;
    for (let i = 0; i < s.length; i++) s[i].block(buf, n);
  }
  reset(): void {
    for (const b of this.stages) b.reset();
  }
  magnitude(f: number, sr: number): number {
    let m = 1;
    for (const b of this.stages) m *= b.magnitude(f, sr);
    return m;
  }
}

/** Sets up two biquads as a 4th-order Butterworth low-pass (24 dB/oct). */
export function butterworth4Lowpass(a: Biquad, b: Biquad, fc: number, sr: number): void {
  a.lowpass(fc, 0.5411961, sr);
  b.lowpass(fc, 1.3065630, sr);
}
/** Sets up two biquads as a 4th-order Butterworth high-pass (24 dB/oct). */
export function butterworth4Highpass(a: Biquad, b: Biquad, fc: number, sr: number): void {
  a.highpass(fc, 0.5411961, sr);
  b.highpass(fc, 1.3065630, sr);
}

/** One-pole low-pass. */
export class OnePole {
  y = 0;
  k = 1;
  setFc(fc: number, sr: number): this {
    this.k = 1 - Math.exp((-TAU * clamp(fc, 0.1, sr * 0.49)) / sr);
    return this;
  }
  /** Time constant in seconds. */
  setTau(tau: number, sr: number): this {
    this.k = 1 - Math.exp(-1 / Math.max(tau * sr, 1e-3));
    return this;
  }
  process(x: number): number {
    this.y += this.k * (x - this.y);
    return this.y;
  }
  block(buf: Float64Array, n: number): void {
    const k = this.k;
    let y = this.y;
    for (let i = 0; i < n; i++) {
      y += k * (buf[i] - y);
      buf[i] = y;
    }
    this.y = y;
  }
}

/** DC blocker (one-pole high-pass, ~10 Hz by default). */
export class DcBlocker {
  x1 = 0;
  y1 = 0;
  r = 0.9987;
  setFc(fc: number, sr: number): this {
    this.r = 1 - (TAU * fc) / sr;
    return this;
  }
  process(x: number): number {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
  block(buf: Float64Array, n: number): void {
    const r = this.r;
    let x1 = this.x1;
    let y1 = this.y1;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      const y = x - x1 + r * y1;
      x1 = x;
      y1 = y;
      buf[i] = y;
    }
    this.x1 = x1;
    this.y1 = y1;
  }
}

/** First-order all-pass (phasers, dispersion). Coefficient c in (-1, 1): break frequency fb gives c = (tan(pi fb/sr) - 1)/(tan(pi fb/sr) + 1). */
export class Allpass1 {
  c = 0;
  x1 = 0;
  y1 = 0;
  setFc(fc: number, sr: number): this {
    const t = Math.tan((Math.PI * clamp(fc, 5, sr * 0.49)) / sr);
    this.c = (t - 1) / (t + 1);
    return this;
  }
  process(x: number): number {
    const y = this.c * x + this.x1 - this.c * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

/**
 * Zavalishin TPT state-variable filter (zero-delay feedback): stable under fast modulation. After step(x): lp, bp, hp hold the
 * outputs (bp has a peak gain of Q; `bpn` is the constant-0-dB-peak band-pass, `notch` = lp + hp).
 */
export class Svf {
  ic1 = 0;
  ic2 = 0;
  a1 = 0;
  a2 = 0;
  a3 = 0;
  k = 1;
  lp = 0;
  bp = 0;
  hp = 0;
  /** `q` is the resonance quality factor: 0.5 = no resonance (Butterworth is 0.707), large = sharp peak. */
  set(fc: number, q: number, sr: number): this {
    const g = Math.tan((Math.PI * clamp(fc, 5, sr * 0.49)) / sr);
    const k = 1 / Math.max(q, 0.05);
    this.k = k;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
    return this;
  }
  /** Runs one sample, returns the low-pass output. */
  step(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = x - this.k * v1 - v2;
    return v2;
  }
  get bpn(): number {
    return this.k * this.bp;
  }
  get notch(): number {
    return this.lp + this.hp;
  }
  reset(): this {
    this.ic1 = 0;
    this.ic2 = 0;
    this.lp = 0;
    this.bp = 0;
    this.hp = 0;
    return this;
  }
  /** Filters buf[start..end) in place; `mode`: 0 low-pass, 1 high-pass, 2 band-pass (constant 0 dB peak), 3 notch. */
  blockRange(buf: Float64Array, start: number, end: number, mode: number): void {
    const a1 = this.a1;
    const a2 = this.a2;
    const a3 = this.a3;
    const k = this.k;
    let ic1 = this.ic1;
    let ic2 = this.ic2;
    for (let i = start; i < end; i++) {
      const x = buf[i];
      const v3 = x - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      buf[i] = mode === 0 ? v2 : mode === 1 ? x - k * v1 - v2 : mode === 2 ? k * v1 : x - k * v1;
    }
    this.ic1 = ic1;
    this.ic2 = ic2;
  }
  /** Low-pass over a block, in place. */
  blockLp(buf: Float64Array, n: number): void {
    const a1 = this.a1;
    const a2 = this.a2;
    const a3 = this.a3;
    let ic1 = this.ic1;
    let ic2 = this.ic2;
    for (let i = 0; i < n; i++) {
      const v3 = buf[i] - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      buf[i] = v2;
    }
    this.ic1 = ic1;
    this.ic2 = ic2;
  }
}

/**
 * Four-pole (24 dB/oct) Moog-style ladder low-pass, TPT / zero-delay-feedback form, with tanh saturation at the input
 * and softly inside the loop. `res` runs 0..1 (about 0.95 starts to self-oscillate; the saturation keeps it bounded).
 * The stage outputs y1..y4 are exposed after process(): y3 (18 dB/oct) is what the acid voice taps.
 */
export class Ladder {
  s1 = 0;
  s2 = 0;
  s3 = 0;
  s4 = 0;
  y1 = 0;
  y2 = 0;
  y3 = 0;
  y4 = 0;
  /** one-pole gain G = g / (1 + g) */
  G = 0;
  /** 1 / (1 + g) */
  A = 1;
  k = 0;
  /** 1 / (1 + k G^4): the instantaneous loop-gain correction of the zero-delay feedback solution */
  inv = 1;
  G2 = 0;
  G3 = 0;
  G4 = 0;
  /** Gain into the input saturator. */
  drive = 1;
  /** Resonance feedback high-pass state (removes the loop's low-frequency gain; 0 disables). */
  fbHpK = 0;
  private fbLp = 0;
  set(fc: number, res: number, sr: number): this {
    const g = Math.tan((Math.PI * clamp(fc, 10, sr * 0.45)) / sr);
    const G = g / (1 + g);
    this.G = G;
    this.A = 1 / (1 + g);
    this.G2 = G * G;
    this.G3 = this.G2 * G;
    this.G4 = this.G2 * this.G2;
    this.k = 4.05 * clamp(res, 0, 1.2);
    this.inv = 1 / (1 + this.k * this.G4);
    return this;
  }
  /** Feedback high-pass corner: 0 = off. (A few tens of Hz keeps strong resonance from thinning the bass.) */
  setFeedbackHp(fc: number, sr: number): this {
    this.fbHpK = fc > 0 ? 1 - Math.exp((-TAU * fc) / sr) : 0;
    return this;
  }
  process(x: number): number {
    const G = this.G;
    const sigma = this.A * (this.G3 * this.s1 + this.G2 * this.s2 + G * this.s3 + this.s4);
    let fb = sigma;
    if (this.fbHpK > 0) {
      // a one-pole high-pass on the feedback path (acid-style: the loop does not boost the lows)
      this.fbLp += this.fbHpK * (sigma - this.fbLp);
      fb = sigma - this.fbLp;
    }
    const u = tanh3((this.drive * x - this.k * fb) * this.inv);
    let v = (u - this.s1) * G;
    const y1 = v + this.s1;
    this.s1 = y1 + v;
    v = (y1 - this.s2) * G;
    const y2 = v + this.s2;
    this.s2 = y2 + v;
    v = (y2 - this.s3) * G;
    const y3 = v + this.s3;
    this.s3 = y3 + v;
    v = (y3 - this.s4) * G;
    const y4 = v + this.s4;
    this.s4 = y4 + v;
    this.y1 = y1;
    this.y2 = y2;
    this.y3 = y3;
    this.y4 = y4;
    return y4;
  }
  /**
   * Filters buf[start..end) in place with the state in registers (several times faster than calling process() per sample).
   * The output is w4 * y4 + w3 * y3 (w3 = 0: the plain 24 dB/oct output), times `gain`.
   */
  block(buf: Float64Array, start: number, end: number, gain = 1, w3 = 0): void {
    const G = this.G;
    const A = this.A;
    const G2 = this.G2;
    const G3 = this.G3;
    const k = this.k;
    const inv = this.inv;
    const drive = this.drive;
    const fbK = this.fbHpK;
    let s1 = this.s1;
    let s2 = this.s2;
    let s3 = this.s3;
    let s4 = this.s4;
    let fbLp = this.fbLp;
    const w4 = (1 - w3) * gain;
    const o3 = w3 * gain;
    let y3 = 0;
    let y4 = 0;
    for (let i = start; i < end; i++) {
      const sigma = A * (G3 * s1 + G2 * s2 + G * s3 + s4);
      let fb = sigma;
      if (fbK > 0) {
        fbLp += fbK * (sigma - fbLp);
        fb = sigma - fbLp;
      }
      const t = (drive * buf[i] - k * fb) * inv;
      const u = t >= 3 ? 1 : t <= -3 ? -1 : (t * (27 + t * t)) / (27 + 9 * t * t);
      let v = (u - s1) * G;
      const y1 = v + s1;
      s1 = y1 + v;
      v = (y1 - s2) * G;
      const y2 = v + s2;
      s2 = y2 + v;
      v = (y2 - s3) * G;
      y3 = v + s3;
      s3 = y3 + v;
      v = (y3 - s4) * G;
      y4 = v + s4;
      s4 = y4 + v;
      buf[i] = y4 * w4 + y3 * o3;
    }
    this.s1 = s1;
    this.s2 = s2;
    this.s3 = s3;
    this.s4 = s4;
    this.fbLp = fbLp;
    this.y3 = y3;
    this.y4 = y4;
  }
  reset(): this {
    this.s1 = this.s2 = this.s3 = this.s4 = 0;
    this.y1 = this.y2 = this.y3 = this.y4 = 0;
    this.fbLp = 0;
    return this;
  }
}
