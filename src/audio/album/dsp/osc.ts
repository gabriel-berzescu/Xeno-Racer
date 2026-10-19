/**
 * Band-limited oscillators (PolyBLEP / PolyBLAMP) and noise colours. The instruments inline the same
 * formulas in their per-sample loops; the `Osc` class is the convenient building block for custom instruments.
 */
import { Noise, sinCyc } from './core';

/**
 * Two-sample polynomial band-limited step residual for a discontinuity at phase 0 (t in [0,1) is the phase, dt the phase
 * increment per sample). Subtract it from a naive saw (jump of -2 at the wrap) or add it for a rising step.
 */
export function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/**
 * Four-sample band-limited step residual (the step smoothed by a cubic B-spline, support four samples: two before the discontinuity and
 * two after). Same convention as `polyBlep` (the residual of a step of height 2), but about 10 dB less aliasing at every pitch for
 * the same cost in an oscillator loop: it is what the synth's saws and pulses use.
 */
export function polyBlep4(t: number, dt: number): number {
  if (t < dt + dt) {
    const x = t / dt;
    if (x < 1) return -1 + 1.3333333333333333 * x - (2 * x * x * x) / 3 + (x * x * x * x) / 4;
    const u = 2 - x;
    return -(u * u * u * u) / 12;
  }
  if (t > 1 - dt - dt) {
    const x = (t - 1) / dt;
    if (x > -1) return 1 + 1.3333333333333333 * x - (2 * x * x * x) / 3 - (x * x * x * x) / 4;
    const u = 2 + x;
    return (u * u * u * u) / 12;
  }
  return 0;
}

/** Polynomial band-limited ramp residual (a derivative discontinuity of 2 per unit phase at phase 0), for triangle corners. */
export function polyBlamp(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt - 1;
    return (-1 / 3) * x * x * x * dt;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt + 1;
    return (1 / 3) * x * x * x * dt;
  }
  return 0;
}

/** Band-limited sawtooth in [-1, 1], rising; `t` is the phase in [0,1), `dt` the phase step per sample. */
export function sawBL(t: number, dt: number): number {
  return 2 * t - 1 - polyBlep4(t, dt);
}

/** Band-limited pulse in [-1, 1]; `pw` is the duty (0.5 = square). */
export function pulseBL(t: number, dt: number, pw: number): number {
  let y = t < pw ? 1 : -1;
  y += polyBlep4(t, dt);
  let t2 = t - pw;
  if (t2 < 0) t2 += 1;
  y -= polyBlep4(t2, dt);
  return y;
}

/** Band-limited triangle in [-1, 1] (0 at phase 0, rising first), via PolyBLAMP at the two corners. */
export function triBL(t: number, dt: number): number {
  // naive: peaks at t = 0.25 (+1) and troughs at t = 0.75 (-1); slope +-4 per cycle
  let y = t < 0.25 ? 4 * t : t < 0.75 ? 2 - 4 * t : 4 * t - 4;
  // corners at t = 0.25 (slope +4 -> -4) and t = 0.75 (slope -4 -> +4): slope changes of -8 / +8 per unit phase;
  // polyBlamp is the residual for a slope change of 2, hence the factor 4
  let tp = t - 0.25;
  if (tp < 0) tp += 1;
  y -= 4 * polyBlamp(tp, dt);
  let tq = t - 0.75;
  if (tq < 0) tq += 1;
  y += 4 * polyBlamp(tq, dt);
  return y;
}

export type OscWave = 'saw' | 'square' | 'pulse' | 'tri' | 'sine';

/** A single band-limited oscillator: set `wave`, `pw` and call `next(freq / sr)` once per sample. */
export class Osc {
  phase = 0;
  pw = 0.5;
  constructor(public wave: OscWave = 'saw', phase = 0) {
    this.phase = phase;
  }
  next(dt: number): number {
    let t = this.phase + dt;
    if (t >= 1) t -= 1;
    this.phase = t;
    switch (this.wave) {
      case 'saw':
        return sawBL(t, dt);
      case 'square':
        return pulseBL(t, dt, 0.5);
      case 'pulse':
        return pulseBL(t, dt, this.pw);
      case 'tri':
        return triBL(t, dt);
      default:
        return sinCyc(t);
    }
  }
}

/** Pink noise (about -3 dB/oct), Paul Kellet's economy filter on a white source. Output roughly in [-1, 1]. */
export class PinkNoise {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private readonly white: Noise;
  constructor(seed = 1) {
    this.white = new Noise(seed);
  }
  next(): number {
    const w = this.white.next();
    this.b0 = 0.99765 * this.b0 + w * 0.099046;
    this.b1 = 0.963 * this.b1 + w * 0.2965164;
    this.b2 = 0.57 * this.b2 + w * 1.0526913;
    return (this.b0 + this.b1 + this.b2 + w * 0.1848) * 0.25;
  }
}

/** Brown-ish noise (leaky integrated white, about -6 dB/oct). */
export class BrownNoise {
  private y = 0;
  private readonly white: Noise;
  constructor(seed = 1) {
    this.white = new Noise(seed);
  }
  next(): number {
    this.y = this.y * 0.998 + this.white.next() * 0.06;
    return this.y * 3.2;
  }
}

// ── block oscillators ────────────────────────────────────────────────────────
// Small stand-alone loops that add n samples of one band-limited oscillator into dst: the JIT compiles these far tighter than the
// same code inside a large voice function. Each takes the phase, the phase step per sample and the gain, and returns the new phase.

/** Adds a band-limited saw (four-sample PolyBLEP). */
export function addSaw(dst: Float64Array, n: number, ph: number, dt: number, g: number): number {
  const dt2 = dt + dt;
  for (let i = 0; i < n; i++) {
    ph += dt;
    if (ph >= 1) ph -= 1;
    let y = 2 * ph - 1;
    if (ph < dt2) {
      const x = ph / dt;
      if (x < 1) y -= -1 + 1.3333333333333333 * x - (2 * x * x * x) / 3 + (x * x * x * x) / 4;
      else {
        const u = 2 - x;
        y += (u * u * u * u) / 12;
      }
    } else if (ph > 1 - dt2) {
      const x = (ph - 1) / dt;
      if (x > -1) y -= 1 + 1.3333333333333333 * x - (2 * x * x * x) / 3 - (x * x * x * x) / 4;
      else {
        const u = 2 + x;
        y -= (u * u * u * u) / 12;
      }
    }
    dst[i] += y * g;
  }
  return ph;
}

/** Adds a band-limited pulse of the given duty (0.5 = square), four-sample PolyBLEP. */
export function addPulse(dst: Float64Array, n: number, ph: number, dt: number, g: number, duty: number): number {
  for (let i = 0; i < n; i++) {
    ph += dt;
    if (ph >= 1) ph -= 1;
    let y = ph < duty ? 1 : -1;
    y += polyBlep4(ph, dt);
    let t2 = ph - duty;
    if (t2 < 0) t2 += 1;
    y -= polyBlep4(t2, dt);
    dst[i] += y * g;
  }
  return ph;
}

/** Adds a band-limited triangle. */
export function addTri(dst: Float64Array, n: number, ph: number, dt: number, g: number): number {
  for (let i = 0; i < n; i++) {
    ph += dt;
    if (ph >= 1) ph -= 1;
    dst[i] += triBL(ph, dt) * g;
  }
  return ph;
}

/** Adds a sine (table lookup). */
export function addSine(dst: Float64Array, n: number, ph: number, dt: number, g: number): number {
  for (let i = 0; i < n; i++) {
    ph += dt;
    if (ph >= 1) ph -= 1;
    dst[i] += sinCyc(ph) * g;
  }
  return ph;
}
