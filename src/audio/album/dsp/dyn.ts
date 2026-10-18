/**
 * Dynamics: feed-forward compressor (stereo-linked, soft knee, optional external key) and a look-ahead limiter whose
 * detector estimates inter-sample (true) peaks, so the mastered output stays under the ceiling after any later D/A or
 * resampling.
 */

/** Feed-forward compressor. The detector runs per sample, the gain computer every 4 samples (gain is interpolated). */
export class Compressor {
  /** dB */
  threshold = -18;
  ratio = 2;
  /** seconds */
  attack = 0.01;
  release = 0.15;
  /** dB, soft-knee width */
  knee = 6;
  /** dB, applied after compression */
  makeup = 0;
  /** 0..1 parallel mix (1 = fully compressed) */
  mix = 1;
  /** 'rms' smooths the squared key over ~10 ms before the gain computer: gentler, "glue"; 'peak' reacts to transients */
  detect: 'peak' | 'rms' = 'peak';
  /** Current gain reduction in dB (<= 0), for meters. */
  gr = 0;
  private env = 0; // detector state (linear, power for rms)
  private gDb = 0; // smoothed gain reduction (dB, <= 0)
  private gPrev = 1;
  private aK = 0;
  private rK = 0;
  private rmsK = 0;
  constructor(private readonly sr: number) {
    this.update();
  }
  /** Recomputes the smoothing coefficients; call after changing attack/release. */
  update(): this {
    const step = 4 / this.sr;
    this.aK = Math.exp(-step / Math.max(this.attack, 1e-4));
    this.rK = Math.exp(-step / Math.max(this.release, 1e-3));
    this.rmsK = Math.exp(-1 / (0.01 * this.sr));
    return this;
  }
  private computeGain(lvlDb: number): number {
    const over = lvlDb - this.threshold;
    const slope = 1 / this.ratio - 1;
    const kn = this.knee;
    let gr: number;
    if (2 * over < -kn) gr = 0;
    else if (2 * Math.abs(over) <= kn) {
      const t = over + kn / 2;
      gr = (slope * t * t) / (2 * kn);
    } else gr = slope * over;
    const coef = gr < this.gDb ? this.aK : this.rK;
    this.gDb = gr + coef * (this.gDb - gr);
    this.gr = this.gDb;
    return Math.pow(10, (this.gDb + this.makeup) / 20);
  }
  /** Processes l/r in place. `keyL`/`keyR` (optional) drive the detector instead of the signal itself (sidechain). */
  process(l: Float64Array, r: Float64Array, n: number, keyL?: Float64Array, keyR?: Float64Array): void {
    const kl = keyL ?? l;
    const kr = keyR ?? r;
    const mix = this.mix;
    const rms = this.detect === 'rms';
    for (let i0 = 0; i0 < n; i0 += 4) {
      const m = Math.min(4, n - i0);
      let lvl: number;
      if (rms) {
        let e = this.env;
        for (let i = i0; i < i0 + m; i++) {
          const a = kl[i];
          const b = kr[i];
          e = this.rmsK * e + (1 - this.rmsK) * 0.5 * (a * a + b * b);
        }
        this.env = e;
        lvl = Math.sqrt(e);
      } else {
        let pk = 0;
        for (let i = i0; i < i0 + m; i++) {
          const a = kl[i] < 0 ? -kl[i] : kl[i];
          const b = kr[i] < 0 ? -kr[i] : kr[i];
          if (a > pk) pk = a;
          if (b > pk) pk = b;
        }
        lvl = pk;
      }
      const g1 = this.computeGain(20 * Math.log10(lvl > 1e-9 ? lvl : 1e-9));
      const g0 = this.gPrev;
      const dg = (g1 - g0) / m;
      let g = g0;
      for (let i = i0; i < i0 + m; i++) {
        g += dg;
        const dryL = l[i];
        const dryR = r[i];
        l[i] = dryL + (dryL * g - dryL) * mix;
        r[i] = dryR + (dryR * g - dryR) * mix;
      }
      this.gPrev = g1;
    }
  }
  /** Mono variant (in place). */
  processMono(x: Float64Array, n: number, key?: Float64Array): void {
    const k = key ?? x;
    const mix = this.mix;
    const rms = this.detect === 'rms';
    for (let i0 = 0; i0 < n; i0 += 4) {
      const m = Math.min(4, n - i0);
      let lvl: number;
      if (rms) {
        let e = this.env;
        for (let i = i0; i < i0 + m; i++) e = this.rmsK * e + (1 - this.rmsK) * k[i] * k[i];
        this.env = e;
        lvl = Math.sqrt(e);
      } else {
        let pk = 0;
        for (let i = i0; i < i0 + m; i++) {
          const a = k[i] < 0 ? -k[i] : k[i];
          if (a > pk) pk = a;
        }
        lvl = pk;
      }
      const g1 = this.computeGain(20 * Math.log10(lvl > 1e-9 ? lvl : 1e-9));
      const g0 = this.gPrev;
      const dg = (g1 - g0) / m;
      let g = g0;
      for (let i = i0; i < i0 + m; i++) {
        g += dg;
        const dry = x[i];
        x[i] = dry + (dry * g - dry) * mix;
      }
      this.gPrev = g1;
    }
  }
  reset(): void {
    this.env = 0;
    this.gDb = 0;
    this.gPrev = 1;
    this.gr = 0;
  }
}

/** 24-tap windowed-sinc interpolators for the quarter, half and three-quarter points between the middle two of 24 samples. */
const TP_TAPS = 24;
const TP_FILT: Float64Array[] = (() => {
  const i0 = (x: number): number => {
    let s = 1;
    let t = 1;
    for (let k = 1; k < 40; k++) {
      t *= (x / (2 * k)) * (x / (2 * k));
      s += t;
    }
    return s;
  };
  const beta = 7;
  return [0.25, 0.5, 0.75].map((f) => {
    const h = new Float64Array(TP_TAPS);
    for (let k = 0; k < TP_TAPS; k++) {
      const t = k - (TP_TAPS / 2 - 1) - f;
      const sinc = Math.abs(t) < 1e-12 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const r = t / (TP_TAPS / 2);
      h[k] = sinc * (Math.abs(r) < 1 ? i0(beta * Math.sqrt(1 - r * r)) / i0(beta) : 0);
    }
    return h;
  });
})();

/**
 * Look-ahead brick-wall limiter with an inter-sample ("true") peak detector: 4x oversampling of every segment by 24-tap
 * windowed-sinc interpolation, stereo linked. The output is delayed by `latency` samples. Gain = boxcar-smoothed sliding
 * minimum of the per-sample ceiling/peak ratio, followed by an exponential release that can only keep the gain lower; the
 * audio is delayed by the look-ahead plus the detector's own lag so that every peak is limited before it plays.
 */
export class Limiter {
  ceiling: number;
  readonly latency: number;
  private readonly L: number;
  private readonly dl: Float64Array;
  private readonly dr: Float64Array;
  private dPos = 0;
  // sliding-minimum deque over the last L+1 targets
  private readonly dqV: Float64Array;
  private readonly dqI: Float64Array;
  private dqHead = 0;
  private dqLen = 0;
  private readonly dqMask: number;
  private idx = 0;
  // boxcar over the last L values of the minimum
  private readonly box: Float64Array;
  private boxPos = 0;
  private boxSum = 0;
  private gOut = 1;
  private relK: number;
  // the newest TP_TAPS samples per channel, oldest first (shifted each sample)
  private readonly hl = new Float64Array(2 * TP_TAPS);
  private readonly hr = new Float64Array(2 * TP_TAPS);
  private hPos = 0;
  private prevBlockMax = 0;
  /** Deepest gain reduction (dB) seen since the last reset, for meters. */
  maxReduction = 0;
  /** How many samples the last-resort clip had to catch (a peak the detector missed); should stay at 0. */
  clipped = 0;
  constructor(sr: number, ceilingDb = -1.2, lookaheadMs = 1.5, releaseS = 0.09) {
    this.ceiling = Math.pow(10, ceilingDb / 20);
    this.L = Math.max(8, Math.round((lookaheadMs / 1000) * sr));
    this.latency = this.L + TP_TAPS / 2 - 1;
    const size = 1 << Math.ceil(Math.log2(this.latency + 4));
    this.dl = new Float64Array(size);
    this.dr = new Float64Array(size);
    this.dqMask = (1 << Math.ceil(Math.log2(this.L + 4))) - 1;
    this.dqV = new Float64Array(this.dqMask + 1);
    this.dqI = new Float64Array(this.dqMask + 1);
    this.box = new Float64Array(this.L).fill(1);
    this.boxSum = this.L;
    this.relK = 1 - Math.exp(-1 / (releaseS * sr));
  }
  setRelease(s: number, sr: number): void {
    this.relK = 1 - Math.exp(-1 / (Math.max(s, 0.005) * sr));
  }
  /** In place; the signal comes out `latency` samples late. */
  process(l: Float64Array, r: Float64Array, n: number): void {
    const L = this.L;
    const ceil = this.ceiling;
    const dMask = this.dl.length - 1;
    const qMask = this.dqMask;
    const relK = this.relK;
    const lat = this.latency;
    const ceilTol = ceil * 1.00001;
    const hl = this.hl;
    const hr = this.hr;
    const f1 = TP_FILT[0];
    const f2 = TP_FILT[1];
    const f3 = TP_FILT[2];
    const T = TP_TAPS;
    const mid = T / 2;
    // when the block (and the one before it) stays far below the ceiling no inter-sample peak can reach it: the interpolation
    // gain of the filters is below 1.9, so the expensive detection is skipped
    let bm = 0;
    for (let i = 0; i < n; i++) {
      const a = l[i] < 0 ? -l[i] : l[i];
      const b = r[i] < 0 ? -r[i] : r[i];
      if (a > bm) bm = a;
      if (b > bm) bm = b;
    }
    const quiet = Math.max(bm, this.prevBlockMax) * 1.9 < ceil;
    this.prevBlockMax = bm;
    let hp = this.hPos;
    for (let i = 0; i < n; i++) {
      const xl = l[i];
      const xr = r[i];
      // append to the doubled circular history: the window oldest..newest is hl[hp + 1 .. hp + T]
      hl[hp] = xl;
      hl[hp + T] = xl;
      hr[hp] = xr;
      hr[hp + T] = xr;
      const w = hp + 1;
      hp = hp + 1 >= T ? 0 : hp + 1;
      // peak around the middle of the history: the sample at the middle tap and the three points before it, both channels
      let pk = Math.abs(hl[w + mid]);
      let t = Math.abs(hr[w + mid]);
      if (t > pk) pk = t;
      if (!quiet) {
        let al = 0;
        let bl = 0;
        let cl = 0;
        let ar = 0;
        let br = 0;
        let cr = 0;
        for (let k = 0; k < T; k++) {
          const vl = hl[w + k];
          const vr = hr[w + k];
          const c1 = f1[k];
          const c2 = f2[k];
          const c3 = f3[k];
          al += vl * c1;
          bl += vl * c2;
          cl += vl * c3;
          ar += vr * c1;
          br += vr * c2;
          cr += vr * c3;
        }
        t = Math.abs(al);
        if (t > pk) pk = t;
        t = Math.abs(bl);
        if (t > pk) pk = t;
        t = Math.abs(cl);
        if (t > pk) pk = t;
        t = Math.abs(ar);
        if (t > pk) pk = t;
        t = Math.abs(br);
        if (t > pk) pk = t;
        t = Math.abs(cr);
        if (t > pk) pk = t;
      }
      const target = pk > ceil ? ceil / pk : 1;
      // sliding-window minimum over the last L + 1 targets
      const idx = this.idx++;
      let head = this.dqHead;
      let len = this.dqLen;
      while (len > 0 && this.dqV[(head + len - 1) & qMask] >= target) len--;
      this.dqV[(head + len) & qMask] = target;
      this.dqI[(head + len) & qMask] = idx;
      len++;
      if (this.dqI[head & qMask] <= idx - L - 1) {
        head = (head + 1) & qMask;
        len--;
      }
      this.dqHead = head;
      this.dqLen = len;
      const gMin = this.dqV[head & qMask];
      // boxcar over the last L minimum values
      this.boxSum += gMin - this.box[this.boxPos];
      this.box[this.boxPos] = gMin;
      if (++this.boxPos >= L) this.boxPos = 0;
      const gBox = this.boxSum / L;
      // release: recover slowly, never above the safe value
      let g = this.gOut + (1 - this.gOut) * relK;
      if (gBox < g) g = gBox;
      this.gOut = g;
      // delayed audio
      const wp = this.dPos;
      this.dl[wp] = xl;
      this.dr[wp] = xr;
      const rp = (wp - lat) & dMask;
      let ol = this.dl[rp] * g;
      let or = this.dr[rp] * g;
      // last resort: a peak the detector missed is clipped rather than allowed through
      if (ol > ceilTol) {
        ol = ceil;
        this.clipped++;
      } else if (ol < -ceilTol) {
        ol = -ceil;
        this.clipped++;
      }
      if (or > ceilTol) {
        or = ceil;
        this.clipped++;
      } else if (or < -ceilTol) {
        or = -ceil;
        this.clipped++;
      }
      l[i] = ol;
      r[i] = or;
      this.dPos = (wp + 1) & dMask;
      if (g < 1) {
        const red = 20 * Math.log10(g);
        if (red < this.maxReduction) this.maxReduction = red;
      }
    }
    this.hPos = hp;
  }
}
