/**
 * Delay lines (circular buffers with fractional taps), all-pass and comb sections, and a 2x halfband oversampler.
 */

/** Circular delay line. `tap(0)` is the most recently written sample. */
export class DelayLine {
  readonly buf: Float64Array;
  readonly mask: number;
  pos = 0;
  constructor(maxSamples: number) {
    let n = 16;
    while (n < maxSamples + 8) n <<= 1;
    this.buf = new Float64Array(n);
    this.mask = n - 1;
  }
  write(x: number): void {
    this.buf[this.pos] = x;
    this.pos = (this.pos + 1) & this.mask;
  }
  /** Sample written `d` samples ago (d >= 0), linear interpolation. */
  tap(d: number): number {
    const i = d | 0;
    const f = d - i;
    const m = this.mask;
    const i0 = (this.pos - 1 - i) & m;
    const a = this.buf[i0];
    return a + f * (this.buf[(i0 - 1) & m] - a);
  }
  /** Cubic (Catmull-Rom) interpolated tap: flatter response than linear for modulated delays (d >= 1). */
  tapCubic(d: number): number {
    const i = d | 0;
    const f = d - i;
    const m = this.mask;
    const i1 = (this.pos - 1 - i) & m;
    const y0 = this.buf[(i1 + 1) & m];
    const y1 = this.buf[i1];
    const y2 = this.buf[(i1 - 1) & m];
    const y3 = this.buf[(i1 - 2) & m];
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * f + c2) * f + c1) * f + y1;
  }
  clear(): void {
    this.buf.fill(0);
  }
}

/** Schroeder all-pass (delay `n` samples, coefficient g). */
export class AllpassDelay {
  private readonly buf: Float64Array;
  private pos = 0;
  readonly n: number;
  g: number;
  constructor(n: number, g = 0.6) {
    this.n = Math.max(1, Math.round(n));
    this.buf = new Float64Array(this.n);
    this.g = g;
  }
  process(x: number): number {
    const d = this.buf[this.pos];
    const v = x - this.g * d;
    this.buf[this.pos] = v;
    if (++this.pos >= this.n) this.pos = 0;
    return d + this.g * v;
  }
}

/** Number of non-zero tap pairs of the halfband filter (31-tap Kaiser-windowed). */
const HB_K = 8;
const HB = (() => {
  // h[2j+1] for j = 0..K-1 of the ideal half-band low-pass (cutoff = fs2 / 4), Kaiser window (beta 7: about 70 dB of stopband)
  const N = 4 * HB_K - 1; // taps
  const c = (N - 1) / 2;
  const beta = 7;
  const i0 = (x: number): number => {
    let s = 1;
    let t = 1;
    for (let k = 1; k < 30; k++) {
      t *= (x / (2 * k)) * (x / (2 * k));
      s += t;
    }
    return s;
  };
  const h = new Float64Array(HB_K);
  for (let j = 0; j < HB_K; j++) {
    const n = 2 * j + 1;
    const ideal = Math.sin((Math.PI * n) / 2) / (Math.PI * n);
    const r = n / c;
    h[j] = (ideal * i0(beta * Math.sqrt(Math.max(0, 1 - r * r)))) / i0(beta);
  }
  return h;
})();

/** Doubles the sample rate (zero-stuffing + halfband filter, gain 1). Latency: K = 8 input samples. */
export class Upsampler2x {
  private hist = new Float64Array(2 * HB_K);
  private w = new Float64Array(64 + 2 * HB_K);
  /** Upsamples src[0..n) into dst[0..2n). */
  process(src: Float64Array, n: number, dst: Float64Array): void {
    const K = HB_K;
    if (this.w.length < n + 2 * K) this.w = new Float64Array(n + 2 * K);
    const w = this.w;
    const h = this.hist;
    for (let i = 0; i < 2 * K; i++) w[i] = h[i];
    for (let i = 0; i < n; i++) w[2 * K + i] = src[i];
    for (let i = 0; i < n; i++) {
      const m = i + K;
      let o = 0;
      for (let j = 0; j < K; j++) o += HB[j] * (w[m - j] + w[m + 1 + j]);
      dst[2 * i] = w[m];
      dst[2 * i + 1] = 2 * o;
    }
    for (let i = 0; i < 2 * K; i++) h[i] = w[n + i];
  }
}

/** Halves the sample rate (halfband filter + decimation, gain 1). Latency: K - 1 output samples. */
export class Downsampler2x {
  private oh = new Float64Array(2 * HB_K);
  private eh = new Float64Array(HB_K);
  private ow = new Float64Array(64 + 2 * HB_K);
  private ew = new Float64Array(64 + HB_K);
  /** Decimates src[0..2n) into dst[0..n). */
  process(src: Float64Array, n: number, dst: Float64Array): void {
    const K = HB_K;
    if (this.ow.length < n + 2 * K) {
      this.ow = new Float64Array(n + 2 * K);
      this.ew = new Float64Array(n + K);
    }
    const ow = this.ow;
    const ew = this.ew;
    for (let i = 0; i < 2 * K; i++) ow[i] = this.oh[i];
    for (let i = 0; i < K; i++) ew[i] = this.eh[i];
    for (let i = 0; i < n; i++) {
      ew[K + i] = src[2 * i];
      ow[2 * K + i] = src[2 * i + 1];
    }
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = 0; j < K; j++) acc += HB[j] * (ow[K + i - j] + ow[K + i + 1 + j]);
      dst[i] = 0.5 * ew[i + 1] + acc;
    }
    for (let i = 0; i < 2 * K; i++) this.oh[i] = ow[n + i];
    for (let i = 0; i < K; i++) this.eh[i] = ew[n + i];
  }
}

/** Both halves together; latency 2K - 1 = 15 samples at the base rate. */
export class Oversampler2x {
  readonly upper = new Upsampler2x();
  readonly lower = new Downsampler2x();
  readonly buf = new Float64Array(2 * 512);
  static readonly LATENCY = 2 * HB_K - 1;
}
