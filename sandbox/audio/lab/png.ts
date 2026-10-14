/**
 * Node-only helpers for the lab: PNG encoding and spectrogram rendering, so that sound can be
 * inspected visually (harmonic lines, formants, shifts, pops, squeal) without listening.
 */
import { deflateSync } from 'node:zlib';
import { spectrogram } from '../../../src/audio/analysis';

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodePng(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 6 }))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Magma-like colour ramp, t in [0,1]. */
function colour(t: number, out: Uint8Array, o: number): void {
  const stops = [
    [0.0, 0, 0, 4],
    [0.2, 40, 11, 84],
    [0.4, 114, 31, 129],
    [0.6, 189, 55, 84],
    [0.8, 249, 142, 8],
    [1.0, 252, 253, 191],
  ];
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1];
      const b = stops[i];
      const u = (t - a[0]) / (b[0] - a[0]);
      out[o] = a[1] + (b[1] - a[1]) * u;
      out[o + 1] = a[2] + (b[2] - a[2]) * u;
      out[o + 2] = a[3] + (b[3] - a[3]) * u;
      out[o + 3] = 255;
      return;
    }
  }
}

export interface SpecPanel {
  nfft: number;
  hop: number;
  fMax: number;
  /** Grid line spacing in Hz. */
  grid: number;
  height: number;
}

/** Render a stack of spectrogram panels (shared time axis) into one PNG. */
export function spectrogramPng(
  x: Float32Array,
  sr: number,
  panels: SpecPanel[],
  opts: { width?: number; dbTop?: number; dbRange?: number } = {},
): Uint8Array {
  const W = opts.width ?? 1200;
  const dbTop = opts.dbTop ?? -10;
  const dbRange = opts.dbRange ?? 95;
  const totalH = panels.reduce((s, p) => s + p.height + 4, 0);
  const img = new Uint8Array(W * totalH * 4);
  let y0 = 0;
  const seconds = x.length / sr;
  for (const p of panels) {
    const sg = spectrogram(x, sr, p.nfft, p.hop);
    const maxBin = Math.min(sg.bins - 1, Math.floor(p.fMax / sg.df));
    for (let py = 0; py < p.height; py++) {
      const fHi = (1 - py / p.height) * p.fMax;
      const fLo = (1 - (py + 1) / p.height) * p.fMax;
      const b0 = Math.max(0, Math.floor(fLo / sg.df));
      const b1 = Math.min(maxBin, Math.max(b0, Math.floor(fHi / sg.df)));
      for (let px = 0; px < W; px++) {
        const f0 = Math.floor((px / W) * sg.frames);
        const f1 = Math.max(f0, Math.min(sg.frames - 1, Math.floor(((px + 1) / W) * sg.frames) - 1));
        let m = -200;
        for (let f = f0; f <= f1; f++) for (let b = b0; b <= b1; b++) m = Math.max(m, sg.db[f * sg.bins + b]);
        colour((m - (dbTop - dbRange)) / dbRange, img, ((y0 + py) * W + px) * 4);
      }
    }
    // grid
    for (let g = p.grid; g < p.fMax; g += p.grid) {
      const py = Math.round((1 - g / p.fMax) * p.height);
      const major = Math.round(g / p.grid) % 5 === 0;
      for (let px = 0; px < W; px += major ? 1 : 3) {
        const o = ((y0 + py) * W + px) * 4;
        img[o] = Math.min(255, img[o] + (major ? 70 : 28));
        img[o + 1] = Math.min(255, img[o + 1] + (major ? 70 : 28));
        img[o + 2] = Math.min(255, img[o + 2] + (major ? 70 : 28));
      }
    }
    for (let s = 1; s < seconds; s++) {
      const px = Math.round((s / seconds) * W);
      for (let py = 0; py < p.height; py += 2) {
        const o = ((y0 + py) * W + px) * 4;
        img[o] = Math.min(255, img[o] + 60);
        img[o + 1] = Math.min(255, img[o + 1] + 60);
        img[o + 2] = Math.min(255, img[o + 2] + 60);
      }
    }
    y0 += p.height + 4;
  }
  return encodePng(W, totalH, img);
}

// ── simple 2D plotting (waveform / PSD) ──────────────────────────────────────

export class Canvas {
  readonly data: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
    bg: [number, number, number] = [10, 10, 14],
  ) {
    this.data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      this.data[i * 4] = bg[0];
      this.data[i * 4 + 1] = bg[1];
      this.data[i * 4 + 2] = bg[2];
      this.data[i * 4 + 3] = 255;
    }
  }
  px(x: number, y: number, c: [number, number, number], a = 1): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 4;
    this.data[o] = this.data[o] * (1 - a) + c[0] * a;
    this.data[o + 1] = this.data[o + 1] * (1 - a) + c[1] * a;
    this.data[o + 2] = this.data[o + 2] * (1 - a) + c[2] * a;
  }
  line(x0: number, y0: number, x1: number, y1: number, c: [number, number, number], a = 1): void {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let i = 0; i <= n; i++) this.px(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c, a);
  }
  png(): Uint8Array {
    return encodePng(this.w, this.h, this.data);
  }
}

/** Waveform plot: `rows` stacked traces of the same signal, each `dur` seconds, starting at t0 + k*dur. */
export function waveformPng(x: Float32Array, sr: number, t0: number, dur: number, rows = 1, w = 1200, rowH = 160): Uint8Array {
  const cv = new Canvas(w, rows * rowH);
  let peak = 1e-6;
  for (let r = 0; r < rows; r++) {
    const a = Math.floor((t0 + r * dur) * sr);
    const b = Math.min(x.length, a + Math.floor(dur * sr));
    for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(x[i]));
  }
  for (let r = 0; r < rows; r++) {
    const y0 = r * rowH + rowH / 2;
    cv.line(0, y0, w, y0, [50, 50, 60]);
    const a = Math.floor((t0 + r * dur) * sr);
    const n = Math.floor(dur * sr);
    for (let px = 0; px < w; px++) {
      const i0 = a + Math.floor((px / w) * n);
      const i1 = a + Math.max(Math.floor(((px + 1) / w) * n), Math.floor((px / w) * n) + 1);
      let mn = 1e9;
      let mx = -1e9;
      for (let i = i0; i < i1 && i < x.length; i++) {
        if (x[i] < mn) mn = x[i];
        if (x[i] > mx) mx = x[i];
      }
      if (mn > mx) continue;
      cv.line(px, y0 - (mx / peak) * (rowH / 2 - 4), px, y0 - (mn / peak) * (rowH / 2 - 4), [120, 220, 255]);
    }
    // 10 ms ticks
    for (let ms = 0; ms * 0.001 < dur; ms += 10) cv.line((ms * 0.001 * w) / dur, r * rowH, (ms * 0.001 * w) / dur, r * rowH + 6, [255, 200, 80]);
  }
  return cv.png();
}

/** PSD line plot: dB vs log-frequency (fLo..fHi). Several series allowed. */
export function psdPng(
  series: { psd: Float64Array; colour: [number, number, number] }[],
  sr: number,
  fLo = 30,
  fHi = 12000,
  dbHi = -20,
  dbLo = -110,
  w = 1200,
  h = 520,
): Uint8Array {
  const cv = new Canvas(w, h);
  const xOf = (f: number): number => ((Math.log(f) - Math.log(fLo)) / (Math.log(fHi) - Math.log(fLo))) * w;
  const yOf = (d: number): number => ((dbHi - d) / (dbHi - dbLo)) * h;
  for (let d = Math.ceil(dbLo / 10) * 10; d <= dbHi; d += 10) cv.line(0, yOf(d), w, yOf(d), d % 20 === 0 ? [48, 48, 60] : [26, 26, 34]);
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    if (f >= fLo && f <= fHi) cv.line(xOf(f), 0, xOf(f), h, [48, 48, 60]);
  }
  for (const s of series) {
    const nfft = (s.psd.length - 1) * 2;
    const df = sr / nfft;
    let px = -1;
    let py = 0;
    for (let i = 1; i < s.psd.length; i++) {
      const f = i * df;
      if (f < fLo || f > fHi) continue;
      const x = xOf(f);
      const y = yOf(10 * Math.log10(s.psd[i] + 1e-14));
      if (px >= 0) cv.line(px, py, x, y, s.colour, 0.9);
      px = x;
      py = y;
    }
  }
  return cv.png();
}
