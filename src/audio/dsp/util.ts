/**
 * Small math / RNG helpers shared by every DSP module. Pure TypeScript, no Web Audio dependency,
 * so it runs inside the AudioWorklet, in vitest (Node) and in the offline lab alike.
 */

export const TAU = Math.PI * 2;

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
/** Smoothstep; works for reversed edges (e0 > e1) too. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}
export function gainToDb(g: number): number {
  return 20 * Math.log10(Math.max(g, 1e-12));
}
/** One-pole smoothing coefficient for a time constant `tau` seconds when stepped every `dt` seconds. */
export function smoothCoef(tau: number, dt: number): number {
  return 1 - Math.exp(-dt / Math.max(tau, 1e-6));
}
/** `x` if it is a finite number, else the fallback. */
export function fin(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback;
}
/**
 * One Ornstein-Uhlenbeck step: `x` relaxes towards 0 with coefficient `k` (see smoothCoef) while random kicks keep its
 * stationary deviation at `sigma`. `u` is a uniform random number in [-1, 1). Used for slow wandering (gusts, flutter, drift).
 */
export function ouStep(x: number, k: number, sigma: number, u: number): number {
  return x - k * x + sigma * Math.sqrt(2 * k) * 1.732 * u;
}

/** xorshift32 — tiny, fast, deterministic (seeded for reproducible tests). */
export class Rng {
  s: number;
  constructor(seed = 1) {
    this.s = (seed | 0) || 0x2545f491;
    for (let i = 0; i < 4; i++) this.u();
  }
  /** Uniform in [0, 1). */
  u(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x;
    return (x >>> 0) * 2.3283064365386963e-10;
  }
  /** Uniform in [-1, 1). */
  s2(): number {
    return this.u() * 2 - 1;
  }
  /** Roughly Gaussian (sum of 3 uniforms), unit-ish variance. */
  g(): number {
    return (this.u() + this.u() + this.u() - 1.5) * 1.1547;
  }
}

// ── sine table ───────────────────────────────────────────────────────────────

const SIN_N = 4096;
const SIN_TAB = new Float64Array(SIN_N + 2);
for (let i = 0; i < SIN_N + 2; i++) SIN_TAB[i] = Math.sin((i / SIN_N) * TAU);

/** sin(2π·p) for p in [0, 1) (caller wraps). Linear-interpolated table, error ≈ 1e-7. */
export function sinCyc(p: number): number {
  const x = p * SIN_N;
  const i = x | 0;
  const f = x - i;
  const a = SIN_TAB[i];
  return a + f * (SIN_TAB[i + 1] - a);
}
/** cos(2π·p) for p in [0, 1). */
export function cosCyc(p: number): number {
  let q = p + 0.25;
  if (q >= 1) q -= 1;
  return sinCyc(q);
}
/** Wrap to [0, 1). */
export function wrap1(p: number): number {
  return p - Math.floor(p);
}

/** Flush denormals / tiny values to zero. */
export function flush(x: number): number {
  return x < 1e-24 && x > -1e-24 ? 0 : x;
}

/** tanh-like saturator (Pade approximant, C1-continuous at the ±3 knee). Never exceeds ±1. */
export function softClip(x: number): number {
  if (x >= 3) return 1;
  if (x <= -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}
