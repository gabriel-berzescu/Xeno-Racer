/**
 * Small math helpers for the track module (headless: no DOM, no WebGL).
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
export function smootherstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}
/** Positive modulo. */
export function mod(a: number, n: number): number {
  const r = a % n;
  return r < 0 ? r + n : r;
}

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash -> [0,1). */
export function hash1(n: number): number {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function hash2(x: number, y: number): number {
  return hash1(Math.imul(x | 0, 0x1f1f1f1f) ^ Math.imul(y | 0, 0x7a3b9d1) ^ 0x5bd1e995);
}

/**
 * 2D gradient noise, seeded. Returns roughly [-1, 1]. Allocation-free after construction.
 */
export class Noise2 {
  private readonly perm = new Uint8Array(512);
  private readonly gx = new Float32Array(256);
  private readonly gz = new Float32Array(256);

  constructor(seed: number) {
    const rnd = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    for (let i = 0; i < 256; i++) {
      const a = rnd() * TAU;
      this.gx[i] = Math.cos(a);
      this.gz[i] = Math.sin(a);
    }
  }

  noise(x: number, z: number): number {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const xf = x - xi;
    const zf = z - zi;
    const X = xi & 255;
    const Z = zi & 255;
    const perm = this.perm;
    const a = perm[perm[X] + Z];
    const b = perm[perm[X + 1] + Z];
    const c = perm[perm[X] + Z + 1];
    const d = perm[perm[X + 1] + Z + 1];
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = zf * zf * zf * (zf * (zf * 6 - 15) + 10);
    const n00 = this.gx[a] * xf + this.gz[a] * zf;
    const n10 = this.gx[b] * (xf - 1) + this.gz[b] * zf;
    const n01 = this.gx[c] * xf + this.gz[c] * (zf - 1);
    const n11 = this.gx[d] * (xf - 1) + this.gz[d] * (zf - 1);
    const nx0 = n00 + (n10 - n00) * u;
    const nx1 = n01 + (n11 - n01) * u;
    return (nx0 + (nx1 - nx0) * v) * 1.41421356;
  }

  /** Fractal Brownian motion, ~[-1, 1]. */
  fbm(x: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let sum = 0;
    let norm = 0;
    let fx = x;
    let fz = z;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(fx, fz);
      norm += amp;
      amp *= gain;
      // rotate + scale each octave to hide the lattice
      const nx = fx * 0.8 - fz * 0.6;
      const nz = fx * 0.6 + fz * 0.8;
      fx = nx * lacunarity;
      fz = nz * lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal, [0, 1] (sharp crests) — used for mountains. */
  ridged(x: number, z: number, octaves: number, lacunarity = 2.07, gain = 0.5): number {
    let amp = 1;
    let sum = 0;
    let norm = 0;
    let fx = x;
    let fz = z;
    let w = 1;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(this.noise(fx, fz));
      n *= n;
      n *= w;
      w = clamp(n * 1.6, 0, 1);
      sum += amp * n;
      norm += amp;
      amp *= gain;
      const nx = fx * 0.8 - fz * 0.6;
      const nz = fx * 0.6 + fz * 0.8;
      fx = nx * lacunarity;
      fz = nz * lacunarity;
    }
    return sum / norm;
  }
}

/**
 * Cubic Hermite (Catmull-Rom style) helpers used for height interpolation between samples.
 */
export function hermite(y0: number, m0: number, y1: number, m1: number, h: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m1;
}
export function hermiteSlope(y0: number, m0: number, y1: number, m1: number, h: number, t: number): number {
  const t2 = t * t;
  return ((6 * t2 - 6 * t) * y0) / h + (3 * t2 - 4 * t + 1) * m0 + ((-6 * t2 + 6 * t) * y1) / h + (3 * t2 - 2 * t) * m1;
}

/** Periodic box blur (in place, via temp). `radius` in samples. */
export function boxBlurPeriodic(a: Float64Array, n: number, radius: number, passes = 1): void {
  if (radius < 1) return;
  const tmp = new Float64Array(n);
  const win = radius * 2 + 1;
  for (let p = 0; p < passes; p++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) acc += a[mod(k, n)];
    for (let i = 0; i < n; i++) {
      tmp[i] = acc / win;
      acc += a[mod(i + radius + 1, n)] - a[mod(i - radius, n)];
    }
    a.set(tmp);
  }
}
