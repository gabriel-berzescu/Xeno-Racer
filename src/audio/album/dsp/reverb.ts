/**
 * Stereo reverb: input diffusion, early-reflection taps and an 8-line feedback delay network with a Hadamard mixing matrix,
 * per-line damping (high frequencies decay faster than lows, like a real room) and slow modulation of four lines to keep
 * the tail from ringing metallically. 100 % wet output (the caller scales the return).
 *
 * Written for speed: all delay lines live in one Float64Array, taps are integer offsets except on the four modulated lines
 * (linear interpolation), and the Hadamard transform is unrolled.
 */
import { ANTI_DENORMAL, TAU, clamp } from './core';

const LINES = 8;
// line lengths in milliseconds for size = 1 (mutually "inharmonic" values)
const LINE_MS = [31.7, 37.3, 43.1, 47.9, 53.5, 59.9, 67.1, 73.3];
// output tap signs per line (orthogonal-ish patterns so L and R are decorrelated)
const SIGN_L = [1, 1, -1, -1, 1, -1, -1, 1];
const SIGN_R = [1, -1, -1, 1, -1, 1, 1, -1];
// early-reflection taps (ms) per side, and gains
const ER_L = [7.3, 13.1, 19.7, 28.3, 37.9, 47.3];
const ER_R = [9.1, 15.7, 23.3, 31.1, 41.3, 52.9];
const ER_G = [0.9, 0.75, 0.62, 0.5, 0.4, 0.3];
const AP_MS = [5.1, 8.3, 5.7, 9.1];
const AP_G = [0.62, 0.6, 0.62, 0.6];

export interface ReverbParams {
  /** RT60 of the low band in seconds. */
  time: number;
  /** 0..1: how much faster the highs decay than the lows (0 = same, 1 = very dark). */
  damp: number;
  /** Room size multiplier for the delay lengths (0.3..3). */
  size: number;
  /** Pre-delay in seconds. */
  preDelay: number;
  /** 0..1 level of the early reflections in the output. */
  early: number;
  /** Modulation depth (0..1). */
  mod: number;
  /** Output low cut in Hz (keeps the tail out of the bass). */
  lowCut: number;
  /** Output high cut in Hz. */
  highCut: number;
  /** 0..1.5 stereo width of the output. */
  width: number;
}

export const REVERB_DEFAULTS: ReverbParams = {
  time: 2.4,
  damp: 0.5,
  size: 1,
  preDelay: 0.012,
  early: 0.35,
  mod: 0.5,
  lowCut: 130,
  highCut: 9000,
  width: 1,
};

export class Reverb {
  readonly p: ReverbParams;
  private readonly sr: number;
  // delay lines: one big buffer, a power-of-two slice per line
  private readonly buf: Float64Array;
  private readonly lineBase = new Int32Array(LINES);
  private readonly lineMask = new Int32Array(LINES);
  private readonly linePos = new Int32Array(LINES);
  private readonly lineLen = new Float64Array(LINES);
  private readonly dcGain = new Float64Array(LINES);
  private readonly dampK = new Float64Array(LINES);
  private readonly lp = new Float64Array(LINES);
  private readonly vec = new Float64Array(LINES);
  private readonly modPh = new Float64Array(4);
  private readonly modInc = new Float64Array(4);
  // pre-delay and early reflections share one stereo history
  private readonly hist: [Float64Array, Float64Array];
  private readonly histMask: number;
  private histPos = 0;
  private readonly erOffL = new Int32Array(ER_L.length);
  private readonly erOffR = new Int32Array(ER_R.length);
  // allpass diffusers
  private readonly apBuf: Float64Array[] = [];
  private readonly apPos = new Int32Array(4);
  private readonly apLen = new Int32Array(4);
  private hpL = 0;
  private hpR = 0;
  private lpL = 0;
  private lpR = 0;
  private hpK = 0;
  private lpK = 0;
  private dirty = true;
  private lastSize = -1;
  private lastTime = -1;
  private lastDamp = -1;

  constructor(sr: number, params: Partial<ReverbParams> = {}) {
    this.sr = sr;
    this.p = { ...REVERB_DEFAULTS, ...params };
    // buffers: the longest line at size 3, plus modulation headroom
    let total = 0;
    for (let i = 0; i < LINES; i++) {
      const maxLen = Math.ceil(((LINE_MS[i] * 3.2 + 4) / 1000) * sr);
      let n = 16;
      while (n < maxLen) n <<= 1;
      this.lineBase[i] = total;
      this.lineMask[i] = n - 1;
      total += n;
    }
    this.buf = new Float64Array(total);
    let hn = 16;
    while (hn < Math.ceil(sr * 0.52)) hn <<= 1;
    this.hist = [new Float64Array(hn), new Float64Array(hn)];
    this.histMask = hn - 1;
    for (let i = 0; i < 4; i++) {
      this.apLen[i] = Math.max(1, Math.round((AP_MS[i] / 1000) * sr));
      this.apBuf.push(new Float64Array(this.apLen[i]));
    }
    for (let i = 0; i < 4; i++) {
      this.modInc[i] = (0.11 + 0.07 * i + 0.013 * i * i) / sr;
      this.modPh[i] = i * 0.27;
    }
  }

  private refresh(): void {
    const { size, time, damp, lowCut, highCut } = this.p;
    const sr = this.sr;
    if (size !== this.lastSize || time !== this.lastTime || damp !== this.lastDamp) {
      for (let i = 0; i < LINES; i++) {
        const d = ((LINE_MS[i] * clamp(size, 0.3, 3)) / 1000) * sr;
        this.lineLen[i] = d;
        // gain per pass for the requested RT60: 60 dB over `time` seconds
        const g = Math.pow(10, (-3 * d) / (sr * Math.max(time, 0.05)));
        const a = clamp(damp, 0, 1) * 0.72;
        this.dampK[i] = a;
        this.dcGain[i] = g * (1 - a); // one-pole with DC gain g
      }
      for (let k = 0; k < ER_L.length; k++) {
        this.erOffL[k] = Math.max(1, Math.round(((ER_L[k] * clamp(size, 0.3, 3)) / 1000) * sr));
        this.erOffR[k] = Math.max(1, Math.round(((ER_R[k] * clamp(size, 0.3, 3)) / 1000) * sr));
      }
      this.lastSize = size;
      this.lastTime = time;
      this.lastDamp = damp;
    }
    this.hpK = 1 - Math.exp((-TAU * clamp(lowCut, 10, 2000)) / sr);
    this.lpK = 1 - Math.exp((-TAU * clamp(highCut, 500, sr * 0.45)) / sr);
    this.dirty = false;
  }

  setParam(name: keyof ReverbParams, v: number): void {
    this.p[name] = v;
    this.dirty = true;
  }

  /** Adds the wet signal for inL/inR[0..n) into outL/outR[0..n). */
  process(inL: Float64Array, inR: Float64Array, outL: Float64Array, outR: Float64Array, n: number): void {
    if (this.dirty) this.refresh();
    const sr = this.sr;
    const early = this.p.early;
    const modDepth = this.p.mod * 0.0006 * sr; // up to 0.6 ms
    const width = this.p.width;
    const buf = this.buf;
    const base = this.lineBase;
    const mask = this.lineMask;
    const pos = this.linePos;
    const len = this.lineLen;
    const lp = this.lp;
    const dampK = this.dampK;
    const dcGain = this.dcGain;
    const vec = this.vec;
    const hpK = this.hpK;
    const lpK = this.lpK;
    const preD = Math.max(1, Math.round(this.p.preDelay * sr));
    const hL = this.hist[0];
    const hR = this.hist[1];
    const hMask = this.histMask;
    let hp = this.histPos;
    const erL = this.erOffL;
    const erR = this.erOffR;
    const apBuf = this.apBuf;
    const apPos = this.apPos;
    const apLen = this.apLen;
    const s8 = 0.35355339059327373;
    let hpL = this.hpL;
    let hpR = this.hpR;
    let lpL = this.lpL;
    let lpR = this.lpR;
    const modPh = this.modPh;
    const modInc = this.modInc;
    for (let i = 0; i < n; i++) {
      // history of the input: pre-delay and early reflections read from it
      hL[hp & hMask] = inL[i];
      hR[hp & hMask] = inR[i];
      const pl = hL[(hp - preD) & hMask];
      const pr = hR[(hp - preD) & hMask];
      let eL = 0;
      let eR = 0;
      if (early > 0) {
        for (let k = 0; k < 6; k++) {
          eL += ER_G[k] * hL[(hp - preD - erL[k]) & hMask];
          eR += ER_G[k] * hR[(hp - preD - erR[k]) & hMask];
        }
        eL *= 0.5 * early;
        eR *= 0.5 * early;
      }
      hp++;
      // input diffusion: two Schroeder all-passes per side
      let a = pl;
      for (let k = 0; k < 2; k++) {
        const b = apBuf[k];
        const p0 = apPos[k];
        const d = b[p0];
        const v = a - AP_G[k] * d;
        b[p0] = v;
        apPos[k] = p0 + 1 >= apLen[k] ? 0 : p0 + 1;
        a = d + AP_G[k] * v;
      }
      let c = pr;
      for (let k = 2; k < 4; k++) {
        const b = apBuf[k];
        const p0 = apPos[k];
        const d = b[p0];
        const v = c - AP_G[k] * d;
        b[p0] = v;
        apPos[k] = p0 + 1 >= apLen[k] ? 0 : p0 + 1;
        c = d + AP_G[k] * v;
      }
      const inM = (a + c) * 0.25;
      const inS = (a - c) * 0.25;
      // read the lines (the odd ones are modulated, with linear interpolation), damp, scale
      for (let k = 0; k < LINES; k++) {
        const m = mask[k];
        const bs = base[k];
        let x: number;
        if (k & 1) {
          const mi = k >> 1;
          let ph = modPh[mi] + modInc[mi];
          if (ph >= 1) ph -= 1;
          modPh[mi] = ph;
          const d = len[k] - 1 + modDepth * (ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph);
          const di = d | 0;
          const f = d - di;
          const i0 = (pos[k] - 1 - di) & m;
          const y0 = buf[bs + i0];
          x = y0 + f * (buf[bs + ((i0 - 1) & m)] - y0);
        } else {
          x = buf[bs + ((pos[k] - Math.round(len[k])) & m)];
        }
        const y = dcGain[k] * x + dampK[k] * lp[k] + ANTI_DENORMAL;
        lp[k] = y - ANTI_DENORMAL;
        vec[k] = y;
      }
      // Hadamard mixing (fast Walsh-Hadamard transform, scaled by 1/sqrt(8)), unrolled
      const a0 = vec[0] + vec[1];
      const a1 = vec[0] - vec[1];
      const a2 = vec[2] + vec[3];
      const a3 = vec[2] - vec[3];
      const a4 = vec[4] + vec[5];
      const a5 = vec[4] - vec[5];
      const a6 = vec[6] + vec[7];
      const a7 = vec[6] - vec[7];
      const b0 = a0 + a2;
      const b1 = a1 + a3;
      const b2 = a0 - a2;
      const b3 = a1 - a3;
      const b4 = a4 + a6;
      const b5 = a5 + a7;
      const b6 = a4 - a6;
      const b7 = a5 - a7;
      // write back with the injected input (mid into the even lines, side into the odd lines)
      const w0 = (b0 + b4) * s8 + inM;
      const w1 = (b1 + b5) * s8 + inS;
      const w2 = (b2 + b6) * s8 + inM;
      const w3 = (b3 + b7) * s8 - inS;
      const w4 = (b0 - b4) * s8 + inM;
      const w5 = (b1 - b5) * s8 + inS;
      const w6 = (b2 - b6) * s8 + inM;
      const w7 = (b3 - b7) * s8 - inS;
      buf[base[0] + (pos[0] & mask[0])] = w0;
      buf[base[1] + (pos[1] & mask[1])] = w1;
      buf[base[2] + (pos[2] & mask[2])] = w2;
      buf[base[3] + (pos[3] & mask[3])] = w3;
      buf[base[4] + (pos[4] & mask[4])] = w4;
      buf[base[5] + (pos[5] & mask[5])] = w5;
      buf[base[6] + (pos[6] & mask[6])] = w6;
      buf[base[7] + (pos[7] & mask[7])] = w7;
      for (let k = 0; k < LINES; k++) pos[k] = (pos[k] + 1) & mask[k];
      // output taps (the state after damping, before mixing)
      let oL = 0;
      let oR = 0;
      for (let k = 0; k < LINES; k++) {
        oL += SIGN_L[k] * vec[k];
        oR += SIGN_R[k] * vec[k];
      }
      oL *= 0.35;
      oR *= 0.35;
      const mid = (oL + oR) * 0.5;
      const side = (oL - oR) * 0.5 * width;
      oL = mid + side + eL;
      oR = mid - side + eR;
      // low cut / high cut
      hpL += hpK * (oL - hpL);
      hpR += hpK * (oR - hpR);
      oL -= hpL;
      oR -= hpR;
      lpL += lpK * (oL - lpL);
      lpR += lpK * (oR - lpR);
      outL[i] += lpL;
      outR[i] += lpR;
    }
    this.histPos = hp & 0x3fffffff;
    this.hpL = hpL;
    this.hpR = hpR;
    this.lpL = lpL;
    this.lpR = lpR;
  }

  clear(): void {
    this.buf.fill(0);
    this.lp.fill(0);
    this.hist[0].fill(0);
    this.hist[1].fill(0);
    for (const b of this.apBuf) b.fill(0);
  }
}
