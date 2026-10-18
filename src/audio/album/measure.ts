/**
 * Loudness and peak measurement for the album: ITU-R BS.1770-4 K-weighted loudness (momentary / short-term / integrated with
 * the two gates) and an oversampled true-peak estimate. Pure TypeScript; used by the master calibration, the tests and the
 * WAV probe, and available to composers (`import { measure } from '../measure'`).
 */
import { Biquad } from './dsp/filters';

/** K-weighting filter pair (high shelf + high pass) for any sample rate, per BS.1770-4. */
export class KWeighting {
  private readonly shelf = new Biquad();
  private readonly hp = new Biquad();
  constructor(sr: number) {
    {
      const f0 = 1681.974450955533;
      const G = 3.999843853973347;
      const Q = 0.7071752369554196;
      const K = Math.tan((Math.PI * f0) / sr);
      const Vh = Math.pow(10, G / 20);
      const Vb = Math.pow(Vh, 0.4996667741545416);
      const a0 = 1 + K / Q + K * K;
      this.shelf.b0 = (Vh + (Vb * K) / Q + K * K) / a0;
      this.shelf.b1 = (2 * (K * K - Vh)) / a0;
      this.shelf.b2 = (Vh - (Vb * K) / Q + K * K) / a0;
      this.shelf.a1 = (2 * (K * K - 1)) / a0;
      this.shelf.a2 = (1 - K / Q + K * K) / a0;
    }
    {
      const f0 = 38.13547087602444;
      const Q = 0.5003270373238773;
      const K = Math.tan((Math.PI * f0) / sr);
      const a0 = 1 + K / Q + K * K;
      this.hp.b0 = 1;
      this.hp.b1 = -2;
      this.hp.b2 = 1;
      this.hp.a1 = (2 * (K * K - 1)) / a0;
      this.hp.a2 = (1 - K / Q + K * K) / a0;
    }
  }
  process(x: number): number {
    return this.hp.process(this.shelf.process(x));
  }
}

/** Streaming BS.1770 loudness meter for stereo material. Feed blocks with `push`; read results at any time. */
export class LoudnessMeter {
  private readonly kl: KWeighting;
  private readonly kr: KWeighting;
  private readonly sub: number; // samples per 100 ms sub-block
  private acc = 0; // energy sum of the current sub-block
  private cnt = 0;
  private readonly hist: number[] = []; // mean-square energies of finished 100 ms sub-blocks
  /** Mean-square energy of each 400 ms block (one per 100 ms hop), stereo-summed. */
  readonly blocks: number[] = [];
  /** Highest absolute sample value seen. */
  samplePeak = 0;
  constructor(readonly sr: number) {
    this.kl = new KWeighting(sr);
    this.kr = new KWeighting(sr);
    this.sub = Math.round(sr * 0.1);
  }
  push(l: ArrayLike<number>, r: ArrayLike<number>, n = l.length, offset = 0): void {
    for (let i = offset; i < offset + n; i++) {
      const a = l[i];
      const b = r[i];
      const aa = a < 0 ? -a : a;
      const bb = b < 0 ? -b : b;
      if (aa > this.samplePeak) this.samplePeak = aa;
      if (bb > this.samplePeak) this.samplePeak = bb;
      const yl = this.kl.process(a);
      const yr = this.kr.process(b);
      this.acc += yl * yl + yr * yr;
      if (++this.cnt >= this.sub) {
        this.hist.push(this.acc / this.cnt);
        this.acc = 0;
        this.cnt = 0;
        const h = this.hist;
        if (h.length >= 4) {
          const m = h.length;
          this.blocks.push((h[m - 1] + h[m - 2] + h[m - 3] + h[m - 4]) / 4);
        }
      }
    }
  }
  static toLufs(energy: number): number {
    return -0.691 + 10 * Math.log10(Math.max(energy, 1e-12));
  }
  /** Momentary loudness (last 400 ms) in LUFS; -Infinity before 400 ms have been seen. */
  momentary(): number {
    return this.blocks.length ? LoudnessMeter.toLufs(this.blocks[this.blocks.length - 1]) : -Infinity;
  }
  /** Short-term loudness (last 3 s) in LUFS. */
  shortTerm(): number {
    const h = this.hist;
    const n = Math.min(30, h.length);
    if (n < 4) return -Infinity;
    let s = 0;
    for (let i = h.length - n; i < h.length; i++) s += h[i];
    return LoudnessMeter.toLufs(s / n);
  }
  /** Integrated loudness over everything pushed so far, with the absolute (-70) and relative (-10 LU) gates. */
  integrated(from = 0, to = this.blocks.length): number {
    return integratedFromBlocks(this.blocks, from, to);
  }
}

/** Gated integrated loudness of a list of 400 ms block energies (indices [from, to)). */
export function integratedFromBlocks(blocks: readonly number[], from = 0, to = blocks.length): number {
  const abs = Math.pow(10, (-70 + 0.691) / 10);
  let s = 0;
  let c = 0;
  for (let i = from; i < to; i++) {
    if (blocks[i] > abs) {
      s += blocks[i];
      c++;
    }
  }
  if (!c) return -Infinity;
  const rel = (s / c) * 0.1; // -10 LU
  let s2 = 0;
  let c2 = 0;
  for (let i = from; i < to; i++) {
    if (blocks[i] > abs && blocks[i] > rel) {
      s2 += blocks[i];
      c2++;
    }
  }
  return c2 ? LoudnessMeter.toLufs(s2 / c2) : -Infinity;
}

// ── true peak ────────────────────────────────────────────────────────────────

const TP_M = 16; // taps per side
let TP_FILT: Float64Array[] | null = null;
function tpFilters(): Float64Array[] {
  if (TP_FILT) return TP_FILT;
  const i0 = (x: number): number => {
    let s = 1;
    let t = 1;
    for (let k = 1; k < 40; k++) {
      t *= (x / (2 * k)) * (x / (2 * k));
      s += t;
    }
    return s;
  };
  const beta = 8;
  const out: Float64Array[] = [];
  for (let p = 1; p < 4; p++) {
    const f = p / 4;
    const h = new Float64Array(2 * TP_M);
    // taps k = -(M-1)..M applied to x[n+k]; the interpolation point sits at n + f
    for (let j = 0; j < 2 * TP_M; j++) {
      const k = j - (TP_M - 1);
      const t = f - k;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const r = t / TP_M;
      const w = Math.abs(r) < 1 ? i0(beta * Math.sqrt(1 - r * r)) / i0(beta) : 0;
      h[j] = sinc * w;
    }
    out.push(h);
  }
  TP_FILT = out;
  return out;
}

/** Oversampled (4x) true peak of one channel as a linear value; also covers the sample peak. */
export function truePeakLinear(x: ArrayLike<number>, from = 0, to = x.length): number {
  const filt = tpFilters();
  let peak = 0;
  for (let i = from; i < to; i++) {
    const a = x[i] < 0 ? -x[i] : x[i];
    if (a > peak) peak = a;
  }
  for (let n = Math.max(from, TP_M); n < Math.min(to, x.length) - TP_M - 1; n++) {
    for (let p = 0; p < 3; p++) {
      const h = filt[p];
      let y = 0;
      const base = n - (TP_M - 1);
      for (let j = 0; j < 2 * TP_M; j++) y += x[base + j] * h[j];
      const a = y < 0 ? -y : y;
      if (a > peak) peak = a;
    }
  }
  return peak;
}

export interface MasterStats {
  /** Integrated loudness, LUFS (BS.1770-4, gated). */
  lufs: number;
  /** Highest 3-second short-term loudness, LUFS. */
  shortTermMax: number;
  /** True peak in dBTP (4x oversampled), over both channels. */
  truePeakDb: number;
  /** Highest sample value in dBFS. */
  samplePeakDb: number;
  /** DC offset of each channel (mean value). */
  dc: [number, number];
  rmsDb: number;
  seconds: number;
}

const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-12));

/** One-call measurement of a finished stereo render. */
export function measure(l: ArrayLike<number>, r: ArrayLike<number>, sr: number): MasterStats {
  const m = new LoudnessMeter(sr);
  m.push(l, r, l.length);
  let stMax = -Infinity;
  // short-term maximum from the 100 ms history: reuse blocks (400 ms) averaged over 3 s windows
  const b = m.blocks;
  for (let i = 0; i + 30 <= b.length; i += 5) {
    let s = 0;
    for (let j = i; j < i + 30; j++) s += b[j];
    stMax = Math.max(stMax, LoudnessMeter.toLufs(s / 30));
  }
  let dl = 0;
  let dr = 0;
  let sq = 0;
  for (let i = 0; i < l.length; i++) {
    dl += l[i];
    dr += r[i];
    sq += l[i] * l[i] + r[i] * r[i];
  }
  const n = Math.max(1, l.length);
  return {
    lufs: m.integrated(),
    shortTermMax: stMax,
    truePeakDb: db(Math.max(truePeakLinear(l), truePeakLinear(r))),
    samplePeakDb: db(m.samplePeak),
    dc: [dl / n, dr / n],
    rmsDb: 10 * Math.log10(Math.max(sq / (2 * n), 1e-24)),
    seconds: l.length / sr,
  };
}
