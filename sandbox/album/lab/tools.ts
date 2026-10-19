/**
 * Analysis helpers for the album lab and the probes (Node only): render a song to arrays, band energies, decay times,
 * stereo statistics, WAV and PNG output. Used to sanity-check sound without listening.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { encodeWav16 } from '../../../src/audio/wav';
import { hann, powerSpectrum, welch, rms, peakAbs } from '../../../src/audio/analysis';
import { encodePng, spectrogramPng, waveformPng, psdPng } from '../../audio/lab/png';
import type { TrackRenderer } from '../../../src/audio/album/index';

export function renderAll(r: TrackRenderer, block = 4096): [Float32Array, Float32Array] {
  const L = new Float32Array(r.frames);
  const R = new Float32Array(r.frames);
  const bl = new Float32Array(block);
  const br = new Float32Array(block);
  let pos = 0;
  while (pos < r.frames) {
    const m = r.render(bl, br, Math.min(block, r.frames - pos));
    if (m === 0) break;
    L.set(bl.subarray(0, m), pos);
    R.set(br.subarray(0, m), pos);
    pos += m;
  }
  return [L, R];
}

export function save(path: string, data: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

export function saveWav(path: string, l: Float32Array, r: Float32Array, sr: number): void {
  save(path, encodeWav16([l, r], sr));
}

export const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-12));

/** Octave-ish band edges (Hz) used in reports. */
export const BANDS: [string, number, number][] = [
  ['sub 20-60', 20, 60],
  ['bass 60-150', 60, 150],
  ['lowmid 150-400', 150, 400],
  ['mid 400-1.2k', 400, 1200],
  ['upmid 1.2-3k', 1200, 3000],
  ['pres 3-6k', 3000, 6000],
  ['high 6-12k', 6000, 12000],
  ['air 12k+', 12000, 22000],
];

/** Mean power spectral density of x[start..end) (Welch). */
export function psd(x: ArrayLike<number>, sr: number, start = 0, end = x.length, nfft = 8192): Float64Array {
  return welch(x, nfft, start, end);
}

/**
 * Power in each report band, in dB re full scale: the mean square of the part of the signal that lies in the band, so that the bands add up
 * to the mean square of the whole signal (a full-scale sine reads -3 dB, a sine of amplitude 0.1 reads -23 dB, and the eight bands of a
 * mix whose rms is -18 dBFS read about -18 dB when summed in power). Returns the dB values.
 */
export function bandDb(x: ArrayLike<number>, sr: number, start = 0, end = x.length): number[] {
  const nfft = 8192;
  const p = psd(x, sr, start, end, nfft);
  const df = sr / nfft;
  return BANDS.map(([, lo, hi]) => {
    let s = 0;
    for (let i = Math.max(1, Math.floor(lo / df)); i <= Math.min(p.length - 1, Math.ceil(hi / df)); i++) s += p[i];
    return 10 * Math.log10((s * 2) / nfft + 1e-14); // p[i] is |X|^2 / sum(w^2) of one bin; the mean square is 2/N times the sum over the half spectrum
  });
}

export function bandReport(x: ArrayLike<number>, sr: number, start = 0, end = x.length): string {
  const v = bandDb(x, sr, start, end);
  return BANDS.map(([n], i) => `${n}: ${v[i].toFixed(1)}`).join(' | ');
}

/** Spectral centroid in Hz of x[start..end). */
export function centroid(x: ArrayLike<number>, sr: number, start = 0, end = x.length, lo = 30, hi = 16000): number {
  const nfft = 8192;
  const p = psd(x, sr, start, end, nfft);
  const df = sr / nfft;
  let num = 0;
  let den = 0;
  for (let i = Math.floor(lo / df); i <= Math.min(p.length - 1, Math.ceil(hi / df)); i++) {
    num += i * df * p[i];
    den += p[i];
  }
  return den > 0 ? num / den : 0;
}

/** RMS envelope in dB with a window of `winMs`, hop `hopMs`. */
export function envelopeDb(x: ArrayLike<number>, sr: number, winMs = 10, hopMs = 5): { t: number[]; db: number[] } {
  const w = Math.max(1, Math.round((winMs / 1000) * sr));
  const h = Math.max(1, Math.round((hopMs / 1000) * sr));
  const t: number[] = [];
  const d: number[] = [];
  for (let s = 0; s + w <= x.length; s += h) {
    t.push((s + w / 2) / sr);
    d.push(db(rms(x, s, s + w)));
  }
  return { t, db: d };
}

/** Time (s) from the envelope peak until the envelope has fallen `thresholdDb` below it for good. */
export function decayTime(x: ArrayLike<number>, sr: number, thresholdDb = 40): { peakAt: number; peakDb: number; decay: number } {
  const e = envelopeDb(x, sr, 5, 2);
  let pk = -200;
  let pi = 0;
  e.db.forEach((v, i) => {
    if (v > pk) {
      pk = v;
      pi = i;
    }
  });
  let last = pi;
  for (let i = pi; i < e.db.length; i++) if (e.db[i] > pk - thresholdDb) last = i;
  return { peakAt: e.t[pi], peakDb: pk, decay: e.t[last] - e.t[pi] };
}

/** Index of the first sample whose magnitude exceeds `frac` of the peak. */
export function onsetIndex(x: ArrayLike<number>, frac = 0.1): number {
  const pk = peakAbs(x);
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > pk * frac) return i;
  return -1;
}

/** Fundamental estimate (Hz) of x[start..start+n) by the strongest spectral peak in [lo, hi] with parabolic interpolation. */
export function pitchOf(x: ArrayLike<number>, sr: number, start: number, n: number, lo: number, hi: number): number {
  let nfft = 1;
  while (nfft < n) nfft <<= 1;
  nfft = Math.min(Math.max(nfft, 4096), 65536);
  const p = powerSpectrum(x, start, nfft);
  const df = sr / nfft;
  let best = Math.max(1, Math.floor(lo / df));
  for (let i = best; i <= Math.min(p.length - 2, Math.ceil(hi / df)); i++) if (p[i] > p[best]) best = i;
  const a = Math.log(p[best - 1] + 1e-30);
  const b = Math.log(p[best] + 1e-30);
  const c = Math.log(p[best + 1] + 1e-30);
  const off = (0.5 * (a - c)) / (a - 2 * b + c);
  return (best + off) * df;
}

export function stereoStats(l: ArrayLike<number>, r: ArrayLike<number>, start = 0, end = l.length): { corr: number; widthDb: number } {
  let ll = 0;
  let rr = 0;
  let lr = 0;
  let mm = 0;
  let ss = 0;
  for (let i = start; i < end; i++) {
    ll += l[i] * l[i];
    rr += r[i] * r[i];
    lr += l[i] * r[i];
    const m = (l[i] + r[i]) * 0.5;
    const s = (l[i] - r[i]) * 0.5;
    mm += m * m;
    ss += s * s;
  }
  return { corr: lr / Math.sqrt(ll * rr + 1e-30), widthDb: 10 * Math.log10((ss + 1e-30) / (mm + 1e-30)) };
}

/** Writes a spectrogram PNG of a mono signal (two panels: 0-8k fine and 0-22k). */
export function saveSpectrogram(path: string, x: Float32Array, sr: number, opts: { fMax?: number; width?: number } = {}): void {
  const fMax = opts.fMax ?? 12000;
  const png = spectrogramPng(
    x,
    sr,
    [
      { nfft: 4096, hop: 512, fMax: Math.min(fMax, 2000), grid: 250, height: 200 },
      { nfft: 1024, hop: 256, fMax: Math.min(fMax * 2, sr / 2), grid: 2000, height: 200 },
    ],
    { width: opts.width ?? 1400 },
  );
  save(path, png);
}

export interface SpecMark {
  name: string;
  /** Start of the section in seconds. */
  sec: number;
}

/** Magma-like colour ramp, t in [0,1], written into rgba[o..o+3]. */
function magma(t: number, rgba: Uint8Array, o: number): void {
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
      rgba[o] = a[1] + (b[1] - a[1]) * u;
      rgba[o + 1] = a[2] + (b[2] - a[2]) * u;
      rgba[o + 2] = a[3] + (b[3] - a[3]) * u;
      rgba[o + 3] = 255;
      return;
    }
  }
}

/**
 * The album's spectrogram: one panel, time left to right over `width` pixels, frequency on a LOG scale from 30 Hz (bottom) to 16 kHz
 * (top), so that bass, mids and highs get the same room. A coloured strip on top marks the sections (bright vertical lines at their
 * starts), faint vertical lines mark every four bars (`lineBars`), faint horizontal lines mark 50, 100, 200, 500, 1k, 2k, 5k and 10k Hz (brighter at
 * 100 Hz, 1 kHz and 10 kHz). The low end is analysed with a long window (8192) and the rest with a short one (2048). The picture is tilted
 * by 4.5 dB per octave (typical music then looks even from bass to treble) and scaled so that the loudest 0.3 % is white, 80 dB below is black.
 */
export function saveAlbumSpectrogram(path: string, x: Float32Array, sr: number, opts: { sections?: SpecMark[]; barSec?: number; width?: number; height?: number; lineBars?: number } = {}): void {
  const W = opts.width ?? 1600;
  const H = opts.height ?? 420;
  const STRIP = opts.sections?.length ? 10 : 0;
  const FMIN = 30;
  const FMAX = 16000;
  const SPLIT = 700;
  const seconds = x.length / sr;
  const nfftLo = 8192;
  const nfftHi = 2048;
  const dfLo = sr / nfftLo;
  const dfHi = sr / nfftHi;
  // per row: frequency range and which analysis feeds it
  const rowLo = new Int32Array(H);
  const rowHi = new Int32Array(H);
  const rowUsesLo = new Uint8Array(H);
  for (let r = 0; r < H; r++) {
    const fTop = FMIN * Math.pow(FMAX / FMIN, 1 - r / H);
    const fBot = FMIN * Math.pow(FMAX / FMIN, 1 - (r + 1) / H);
    const useLo = fTop < SPLIT;
    const df = useLo ? dfLo : dfHi;
    rowUsesLo[r] = useLo ? 1 : 0;
    rowLo[r] = Math.max(1, Math.floor(fBot / df));
    rowHi[r] = Math.max(rowLo[r], Math.ceil(fTop / df));
  }
  const grid = new Float32Array(H * W).fill(-200);
  const spec = new Float64Array(nfftLo / 2 + 1);
  const accumulate = (nfft: number, hop: number, wantLo: boolean, offsetDb: number): void => {
    const half = nfft / 2 + 1;
    const buf = spec.subarray(0, half);
    for (let st = 0; st + nfft <= x.length; st += hop) {
      const c = Math.min(W - 1, Math.floor(((st + nfft / 2) / sr / seconds) * W));
      powerSpectrum(x, st, nfft, buf);
      for (let r = 0; r < H; r++) {
        if ((rowUsesLo[r] === 1) !== wantLo) continue;
        let m = 0;
        for (let b = rowLo[r]; b <= rowHi[r] && b < half; b++) if (buf[b] > m) m = buf[b];
        const v = 10 * Math.log10(m + 1e-14) + offsetDb;
        const o = r * W + c;
        if (v > grid[o]) grid[o] = v;
      }
    }
  };
  // at least two analysis frames per pixel column (else columns stay empty), and never more than half a window between frames
  const columnSamples = (seconds * sr) / W;
  accumulate(nfftLo, Math.min(2048, Math.max(32, Math.floor(columnSamples / 2))), true, -10 * Math.log10(nfftLo / nfftHi)); // tones are 6 dB stronger in the longer window: even them out
  accumulate(nfftHi, Math.min(1024, Math.max(32, Math.floor(columnSamples / 2))), false, 0);
  const totalH = STRIP + H;
  const img = new Uint8Array(W * totalH * 4);
  // music falls off by about 4.5 dB per octave: tilt the picture so that bass and treble can be read on one scale, then scale it so
  // that the loudest 0.3 % of the picture is white and 55 dB below that is black (each pixel holds the loudest moment of its column, so a
  // dense mix fills the top of the scale: a wider range paints a whole arrangement the same orange)
  const sample: number[] = [];
  for (let r = 0; r < H; r++) {
    const f = FMIN * Math.pow(FMAX / FMIN, 1 - (r + 0.5) / H);
    const tilt = 4.5 * Math.log2(f / 1000);
    for (let c = 0; c < W; c++) {
      grid[r * W + c] += tilt;
      if ((r * 7 + c) % 5 === 0) sample.push(grid[r * W + c]);
    }
  }
  sample.sort((a, b) => a - b);
  const dbTop = sample[Math.floor(sample.length * 0.997)];
  const dbRange = 55;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) magma((grid[r * W + c] - (dbTop - dbRange)) / dbRange, img, ((STRIP + r) * W + c) * 4);
  }
  const add = (px: number, py: number, amount: number): void => {
    const o = (py * W + px) * 4;
    img[o] = Math.min(255, img[o] + amount);
    img[o + 1] = Math.min(255, img[o + 1] + amount);
    img[o + 2] = Math.min(255, img[o + 2] + amount);
  };
  // frequency grid
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const py = STRIP + Math.round((1 - Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * H);
    const major = f === 100 || f === 1000 || f === 10000;
    for (let px = 0; px < W; px += major ? 1 : 3) if (py >= STRIP && py < totalH) add(px, py, major ? 75 : 30);
  }
  // bar lines (every four bars) and section starts
  if (opts.barSec) {
    const every = opts.barSec * (opts.lineBars ?? 4);
    for (let t = every; t < seconds; t += every) {
      const px = Math.min(W - 1, Math.round((t / seconds) * W));
      for (let py = STRIP; py < totalH; py += 2) add(px, py, 28);
    }
  }
  const palette: [number, number, number][] = [
    [230, 80, 80],
    [80, 180, 230],
    [230, 200, 80],
    [120, 220, 120],
    [200, 120, 230],
    [240, 140, 60],
    [100, 220, 200],
    [220, 110, 170],
  ];
  const marks = opts.sections ?? [];
  marks.forEach((m, i) => {
    const x0 = Math.min(W - 1, Math.round((m.sec / seconds) * W));
    const x1 = Math.min(W, i + 1 < marks.length ? Math.round((marks[i + 1].sec / seconds) * W) : W);
    const col = palette[i % palette.length];
    for (let px = x0; px < x1; px++) {
      for (let py = 0; py < STRIP; py++) {
        const o = (py * W + px) * 4;
        const edge = px === x0;
        img[o] = edge ? 255 : col[0];
        img[o + 1] = edge ? 255 : col[1];
        img[o + 2] = edge ? 255 : col[2];
        img[o + 3] = 255;
      }
    }
    if (i > 0) for (let py = STRIP; py < totalH; py++) add(x0, py, 150);
  });
  save(path, encodePng(W, totalH, img));
}

export function saveWaveform(path: string, x: Float32Array, sr: number, t0: number, dur: number, rows = 1): void {
  save(path, waveformPng(x, sr, t0, dur, rows, 1400, 180));
}

export function savePsd(path: string, series: { x: ArrayLike<number>; colour: [number, number, number] }[], sr: number, start = 0, end?: number): void {
  const png = psdPng(
    series.map((s) => ({ psd: psd(s.x, sr, start, end ?? s.x.length), colour: s.colour })),
    sr,
  );
  save(path, png);
}

void hann;
