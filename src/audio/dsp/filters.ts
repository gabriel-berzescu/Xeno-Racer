/**
 * Filter / delay primitives. Everything here is allocation-free after construction and keeps its
 * state in plain numeric fields so the JIT can keep hot loops monomorphic.
 */
import { TAU } from './util';

/** One-pole lowpass. */
export class OnePole {
  y = 0;
  k = 1;
  setFc(fc: number, sr: number): void {
    this.k = 1 - Math.exp((-TAU * Math.min(fc, sr * 0.45)) / sr);
  }
  step(x: number): number {
    this.y += this.k * (x - this.y);
    return this.y;
  }
}

/** Zavalishin TPT state-variable filter. After step(): lp / bp / bpn / hp hold the outputs. */
export class SVF {
  ic1 = 0;
  ic2 = 0;
  a1 = 0;
  a2 = 0;
  a3 = 0;
  k = 1;
  lp = 0;
  bp = 0; // peak gain = Q
  bpn = 0; // constant 0 dB peak
  hp = 0;
  set(fc: number, q: number, sr: number): void {
    const f = Math.min(Math.max(fc, 10), sr * 0.45);
    const g = Math.tan((Math.PI * f) / sr);
    const k = 1 / Math.max(q, 0.05);
    this.k = k;
    this.a1 = 1 / (1 + g * (g + k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  step(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.bpn = this.k * v1;
    this.hp = x - this.k * v1 - v2;
    return this.bpn;
  }
  reset(): void {
    this.ic1 = 0;
    this.ic2 = 0;
  }
}

/** Direct-form-II-transposed biquad with RBJ cookbook designs. */
export class Biquad {
  b0 = 1;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  z1 = 0;
  z2 = 0;
  step(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }
  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): void {
    const i = 1 / a0;
    this.b0 = b0 * i;
    this.b1 = b1 * i;
    this.b2 = b2 * i;
    this.a1 = a1 * i;
    this.a2 = a2 * i;
  }
  setLowpass(fc: number, q: number, sr: number): void {
    const w = (TAU * Math.min(fc, sr * 0.45)) / sr;
    const cw = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    this.set((1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + al, -2 * cw, 1 - al);
  }
  setHighpass(fc: number, q: number, sr: number): void {
    const w = (TAU * Math.min(fc, sr * 0.45)) / sr;
    const cw = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    this.set((1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + al, -2 * cw, 1 - al);
  }
  /** Constant 0 dB peak-gain band-pass. */
  setBandpass(fc: number, q: number, sr: number): void {
    const w = (TAU * Math.min(fc, sr * 0.45)) / sr;
    const cw = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    this.set(al, 0, -al, 1 + al, -2 * cw, 1 - al);
  }
  setPeaking(fc: number, q: number, gainDb: number, sr: number): void {
    const A = Math.pow(10, gainDb / 40);
    const w = (TAU * Math.min(fc, sr * 0.45)) / sr;
    const cw = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    this.set(1 + al * A, -2 * cw, 1 - al * A, 1 + al / A, -2 * cw, 1 - al / A);
  }
  setHighShelf(fc: number, gainDb: number, sr: number): void {
    const A = Math.pow(10, gainDb / 40);
    const w = (TAU * Math.min(fc, sr * 0.45)) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const al = (sw / 2) * Math.SQRT2; // shelf slope S = 1
    const t = 2 * Math.sqrt(A) * al;
    this.set(
      A * (A + 1 + (A - 1) * cw + t),
      -2 * A * (A - 1 + (A + 1) * cw),
      A * (A + 1 + (A - 1) * cw - t),
      A + 1 - (A - 1) * cw + t,
      2 * (A - 1 - (A + 1) * cw),
      A + 1 - (A - 1) * cw - t,
    );
  }
  setLowShelf(fc: number, gainDb: number, sr: number): void {
    const A = Math.pow(10, gainDb / 40);
    const w = (TAU * Math.min(fc, sr * 0.45)) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const al = (sw / 2) * Math.SQRT2;
    const t = 2 * Math.sqrt(A) * al;
    this.set(
      A * (A + 1 - (A - 1) * cw + t),
      2 * A * (A - 1 - (A + 1) * cw),
      A * (A + 1 - (A - 1) * cw - t),
      A + 1 + (A - 1) * cw + t,
      -2 * (A - 1 + (A + 1) * cw),
      A + 1 + (A - 1) * cw - t,
    );
  }
}

/** Two-pole resonator (damped sinusoid impulse response). Used for modal synthesis and body modes. */
export class Resonator {
  c1 = 0;
  c2 = 0;
  g = 1;
  y1 = 0;
  y2 = 0;
  /**
   * `decay` = time (s) for the amplitude to fall by 1/e. An input impulse of value `a` produces a
   * damped sinusoid of initial amplitude ~a (input is scaled by sin(w) to make it so).
   */
  set(freq: number, decay: number, sr: number): void {
    const r = Math.exp(-1 / Math.max(decay * sr, 1));
    const w = (TAU * Math.min(freq, sr * 0.45)) / sr;
    this.c1 = 2 * r * Math.cos(w);
    this.c2 = -r * r;
    this.g = Math.sin(w);
  }
  step(x: number): number {
    const y = this.g * x + this.c1 * this.y1 + this.c2 * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
  reset(): void {
    this.y1 = 0;
    this.y2 = 0;
  }
}

/** DC blocker (one-pole high-pass). */
export class DcBlock {
  x1 = 0;
  y1 = 0;
  r = 0.995;
  setFc(fc: number, sr: number): void {
    this.r = 1 - (TAU * fc) / sr;
  }
  step(x: number): number {
    const y = x - this.x1 + this.r * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y;
  }
}

/**
 * Circular delay line with linear-interpolated fractional taps.
 * `tap(0)` is the most recently written sample. For a waveguide delay of D samples (D >= 1) read
 * `tap(D - 1)` BEFORE writing the new input of the same sample step.
 */
export class DelayLine {
  buf: Float32Array;
  mask: number;
  pos = 0;
  constructor(maxSamples: number) {
    let n = 16;
    while (n < maxSamples + 4) n <<= 1;
    this.buf = new Float32Array(n);
    this.mask = n - 1;
  }
  write(x: number): void {
    this.buf[this.pos] = x;
    this.pos = (this.pos + 1) & this.mask;
  }
  tap(d: number): number {
    const i = d | 0;
    const f = d - i;
    const i0 = (this.pos - 1 - i) & this.mask;
    const a = this.buf[i0];
    return a + f * (this.buf[(i0 - 1) & this.mask] - a);
  }
  clear(): void {
    this.buf.fill(0);
  }
}
