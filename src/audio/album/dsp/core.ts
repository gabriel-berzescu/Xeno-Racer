/**
 * Math, RNG and small shaping helpers shared by the whole album engine. Pure TypeScript: no Web Audio, no DOM, no Node.
 * Everything here is deterministic (no Math.random anywhere in the engine).
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
export function smoothstep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** MIDI note number (A4 = 69 = 440 Hz; may be fractional) to frequency in Hz. */
export function mtof(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}
/** Frequency in Hz to MIDI note number (fractional). */
export function ftom(f: number): number {
  return 69 + 12 * Math.log2(f / 440);
}
export function dbToLin(db: number): number {
  return Math.pow(10, db / 20);
}
export function linToDb(x: number): number {
  return 20 * Math.log10(x > 1e-12 ? x : 1e-12);
}

/** Added to feedback states so that decaying tails never reach the denormal range (-500 dB: inaudible). */
export const ANTI_DENORMAL = 1e-24;

/** 32-bit FNV-1a hash of a string: the engine's way of turning names into seeds. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seeded generator (sfc32): small, fast, good statistics, identical on every JS engine. */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  constructor(seed: number | string = 1) {
    let s = (typeof seed === 'string' ? hashString(seed) : seed) | 0;
    // splitmix32 to spread the seed over the four state words
    const next = (): number => {
      s = (s + 0x9e3779b9) | 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) | 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 12; i++) this.next();
  }
  /** Uniform in [0, 1). */
  next(): number {
    const a = this.a | 0;
    const b = this.b | 0;
    const c = this.c | 0;
    let d = this.d | 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    this.a = b ^ (b >>> 9);
    this.b = (c + (c << 3)) | 0;
    this.c = (((c << 21) | (c >>> 11)) + t) | 0;
    this.d = d;
    return (t >>> 0) / 4294967296;
  }
  /** Uniform in [-1, 1). */
  bi(): number {
    return this.next() * 2 - 1;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }
  /** Roughly Gaussian, unit variance (sum of four uniforms). */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508;
  }
  /** An independent generator derived from this seed and a label. */
  fork(label: string): Rng {
    return new Rng((hashString(label) ^ Math.imul((this.a ^ this.d) | 0, 0x9e3779b1)) >>> 0);
  }
}

/** White-noise source for per-sample use: xorshift32, [-1, 1). Hot loops can inline the three xorshift lines. */
export class Noise {
  s: number;
  constructor(seed = 1) {
    this.s = (seed | 0) || 0x2545f491;
    for (let i = 0; i < 8; i++) this.next();
  }
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x;
    return x * 4.656612875245797e-10; // 1 / 2^31
  }
}

// ── shapers ──────────────────────────────────────────────────────────────────

/** tanh-like saturator (Pade approximant, C1 at the +-3 knee). Output is within [-1, 1]. */
export function tanh3(x: number): number {
  if (x >= 3) return 1;
  if (x <= -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}
/** Softer, cheaper saturator: x / (1 + |x|). */
export function softsign(x: number): number {
  return x / (1 + (x < 0 ? -x : x));
}
/** Hard clip to [-lim, lim]. */
export function hardClip(x: number, lim = 1): number {
  return x > lim ? lim : x < -lim ? -lim : x;
}
/** Triangle wavefolder: |x| <= 1 passes unchanged, larger values fold back. */
export function fold(x: number): number {
  // map to a period-4 triangle
  let y = x + 1;
  y -= 4 * Math.floor(y * 0.25);
  return (y < 2 ? y : 4 - y) - 1;
}
/** Asymmetric "tube-ish" saturator: the positive half saturates earlier than the negative one (even harmonics). */
export function tube(x: number): number {
  return x >= 0 ? tanh3(x * 1.15) : tanh3(x * 0.8) * 1.15;
}

// ── sine table ───────────────────────────────────────────────────────────────

const SIN_BITS = 12;
const SIN_N = 1 << SIN_BITS;
let SIN_TAB: Float64Array | null = null;
function sinTab(): Float64Array {
  if (!SIN_TAB) {
    SIN_TAB = new Float64Array(SIN_N + 2);
    for (let i = 0; i < SIN_N + 2; i++) SIN_TAB[i] = Math.sin((i / SIN_N) * TAU);
  }
  return SIN_TAB;
}
/** sin(2*pi*p) for p in [0, 1). Linear-interpolated 4096-point table (error ~1e-7). */
export function sinCyc(p: number): number {
  const t = SIN_TAB ?? sinTab();
  const x = p * SIN_N;
  const i = x | 0;
  const f = x - i;
  const a = t[i];
  return a + f * (t[i + 1] - a);
}
/** sin(2*pi*p) for any real p (wraps itself). */
export function sinWrap(p: number): number {
  return sinCyc(p - Math.floor(p));
}

// ── musical time helpers ─────────────────────────────────────────────────────

/**
 * Parses a note division such as '1/8', '1/8.' (dotted), '1/4t' (triplet), '3/16', '2' (two beats), '1/16' into beats
 * (quarter notes). Numbers pass through unchanged (already beats).
 */
export function divisionToBeats(d: number | string): number {
  if (typeof d === 'number') return d;
  const m = /^\s*(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?\s*([.t]?)\s*$/.exec(d);
  if (!m) throw new Error(`bad note division: "${d}" (use e.g. '1/8', '1/8.', '1/4t', '3/16' or a number of beats)`);
  const num = parseFloat(m[1]);
  const den = m[2] ? parseInt(m[2], 10) : 0;
  let beats = den ? (num / den) * 4 : num;
  if (m[3] === '.') beats *= 1.5;
  else if (m[3] === 't') beats *= 2 / 3;
  return beats;
}
