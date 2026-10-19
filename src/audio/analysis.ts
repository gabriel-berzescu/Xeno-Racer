/**
 * Offline signal analysis used to verify the audio without listening to it: FFT, PSD, spectral
 * centroid, fundamental tracking, continuity / click detection, spectrograms. Pure TypeScript, no
 * DOM or Node dependency — runs in vitest, in the browser report and in the lab.
 */

type Arr = ArrayLike<number>;

const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array }>();

/** In-place iterative radix-2 FFT. n must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  let tw = twiddleCache.get(n);
  if (!tw) {
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    tw = { cos, sin };
    twiddleCache.set(n, tw);
  }
  // bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const wr = tw.cos[t];
        const wi = tw.sin[t];
        const a = i + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

const hannCache = new Map<number, Float64Array>();
export function hann(n: number): Float64Array {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    hannCache.set(n, w);
  }
  return w;
}

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Power spectrum (|X|^2 / sum(w^2)) of x[start .. start+nfft) with a Hann window. Length nfft/2+1. */
export function powerSpectrum(x: Arr, start: number, nfft: number, out?: Float64Array): Float64Array {
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const w = hann(nfft);
  let wsum = 0;
  for (let i = 0; i < nfft; i++) {
    const idx = start + i;
    const v = idx >= 0 && idx < x.length ? x[idx] : 0;
    re[i] = v * w[i];
    wsum += w[i] * w[i];
  }
  fft(re, im);
  const half = nfft / 2 + 1;
  const o = out ?? new Float64Array(half);
  for (let i = 0; i < half; i++) o[i] = (re[i] * re[i] + im[i] * im[i]) / wsum;
  return o;
}

/** Welch-averaged PSD over x[start..end). */
export function welch(x: Arr, nfft: number, start = 0, end = x.length, overlap = 0.5): Float64Array {
  const hop = Math.max(1, Math.floor(nfft * (1 - overlap)));
  const acc = new Float64Array(nfft / 2 + 1);
  const tmp = new Float64Array(nfft / 2 + 1);
  let count = 0;
  for (let s = start; s + nfft <= end; s += hop) {
    powerSpectrum(x, s, nfft, tmp);
    for (let i = 0; i < acc.length; i++) acc[i] += tmp[i];
    count++;
  }
  if (count === 0) {
    powerSpectrum(x, start, nfft, tmp);
    return tmp;
  }
  for (let i = 0; i < acc.length; i++) acc[i] /= count;
  return acc;
}

export function binHz(sr: number, nfft: number): number {
  return sr / nfft;
}

/** Power-weighted mean frequency in [fLo, fHi]. */
export function spectralCentroid(psd: Arr, sr: number, fLo = 40, fHi = 12000): number {
  const nfft = (psd.length - 1) * 2;
  const df = sr / nfft;
  let num = 0;
  let den = 0;
  const a = Math.max(1, Math.floor(fLo / df));
  const b = Math.min(psd.length - 1, Math.ceil(fHi / df));
  for (let i = a; i <= b; i++) {
    num += i * df * psd[i];
    den += psd[i];
  }
  return den > 0 ? num / den : 0;
}

/** Energy in [f0, f1] Hz. */
export function bandPower(psd: Arr, sr: number, f0: number, f1: number): number {
  const nfft = (psd.length - 1) * 2;
  const df = sr / nfft;
  let s = 0;
  const a = Math.max(0, Math.floor(f0 / df));
  const b = Math.min(psd.length - 1, Math.ceil(f1 / df));
  for (let i = a; i <= b; i++) s += psd[i];
  return s;
}

export function rms(x: Arr, start = 0, end = x.length): number {
  let s = 0;
  const n = Math.max(0, end - start);
  for (let i = start; i < end; i++) s += x[i] * x[i];
  return n > 0 ? Math.sqrt(s / n) : 0;
}
export function rmsDb(x: Arr, start = 0, end = x.length): number {
  return 20 * Math.log10(Math.max(rms(x, start, end), 1e-9));
}
export function peakAbs(x: Arr, start = 0, end = x.length): number {
  let p = 0;
  for (let i = start; i < end; i++) {
    const a = Math.abs(x[i]);
    if (a > p) p = a;
  }
  return p;
}
export function hasNonFinite(x: Arr): boolean {
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return true;
  return false;
}
export function countAbove(x: Arr, thresh: number): number {
  let c = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > thresh) c++;
  return c;
}

export interface PeakInfo {
  freq: number;
  powerDb: number;
  /** dB above the median of the surrounding spectrum (excluding the peak itself). */
  prominenceDb: number;
}

/** Strongest spectral line in [fLo, fHi] with parabolic interpolation. */
export function strongestPeak(psd: Arr, sr: number, fLo: number, fHi: number): PeakInfo {
  const nfft = (psd.length - 1) * 2;
  const df = sr / nfft;
  const a = Math.max(2, Math.floor(fLo / df));
  const b = Math.min(psd.length - 3, Math.ceil(fHi / df));
  let best = a;
  for (let i = a; i <= b; i++) if (psd[i] > psd[best]) best = i;
  const l = Math.log(psd[best - 1] + 1e-30);
  const c = Math.log(psd[best] + 1e-30);
  const r = Math.log(psd[best + 1] + 1e-30);
  const den = l - 2 * c + r;
  const off = den !== 0 ? (0.5 * (l - r)) / den : 0;
  const freq = (best + off) * df;
  // prominence vs local median (+-25 bins, skipping +-3 bins around the peak)
  const vals: number[] = [];
  for (let i = Math.max(1, best - 25); i <= Math.min(psd.length - 1, best + 25); i++) {
    if (Math.abs(i - best) > 3) vals.push(psd[i]);
  }
  vals.sort((p, q) => p - q);
  const med = vals.length ? vals[vals.length >> 1] : 1e-30;
  return {
    freq,
    powerDb: 10 * Math.log10(psd[best] + 1e-30),
    prominenceDb: 10 * Math.log10((psd[best] + 1e-30) / (med + 1e-30)),
  };
}

/** Power within +-tolFrac of f (relative), as a fraction of total power in [fLo, fHi]. */
export function lineShare(psd: Arr, sr: number, f: number, tolFrac: number, fLo = 40, fHi = 8000): number {
  const total = bandPower(psd, sr, fLo, fHi);
  return total > 0 ? bandPower(psd, sr, f * (1 - tolFrac), f * (1 + tolFrac)) / total : 0;
}

/**
 * Share of the spectral power (in [fLo, fHi]) that sits within +-tolHz of integer multiples of
 * `base` Hz. A clean harmonic engine note scores high; aliasing / inharmonic junk scores low.
 */
export function harmonicShare(psd: Arr, sr: number, base: number, tolHz: number, fLo = 60, fHi = 6000): number {
  const nfft = (psd.length - 1) * 2;
  const df = sr / nfft;
  let on = 0;
  let total = 0;
  for (let i = Math.floor(fLo / df); i <= Math.min(psd.length - 1, Math.ceil(fHi / df)); i++) {
    const f = i * df;
    const k = Math.round(f / base);
    const near = k >= 1 && Math.abs(f - k * base) <= tolHz;
    if (near) on += psd[i];
    total += psd[i];
  }
  return total > 0 ? on / total : 0;
}

export interface Spectrogram {
  frames: number;
  bins: number;
  hopSec: number;
  df: number;
  /** dB power, frames * bins, row-major by frame. */
  db: Float32Array;
}

export function spectrogram(x: Arr, sr: number, nfft = 2048, hop = 512): Spectrogram {
  const frames = Math.max(1, Math.floor((x.length - nfft) / hop) + 1);
  const bins = nfft / 2 + 1;
  const db = new Float32Array(frames * bins);
  const tmp = new Float64Array(bins);
  for (let f = 0; f < frames; f++) {
    powerSpectrum(x, f * hop, nfft, tmp);
    for (let b = 0; b < bins; b++) db[f * bins + b] = 10 * Math.log10(tmp[b] + 1e-14);
  }
  return { frames, bins, hopSec: hop / sr, df: sr / nfft, db };
}

/**
 * Track the strongest line near an expected frequency trajectory. Returns per-frame measured Hz
 * (NaN when the line is not prominent) so tests can compare against the commanded rpm curve.
 */
export function trackLine(
  x: Arr,
  sr: number,
  expectedHz: (tSec: number) => number,
  opts: { nfft?: number; hop?: number; tol?: number; t0?: number; t1?: number } = {},
): { t: Float64Array; hz: Float64Array; expected: Float64Array; prom: Float64Array } {
  const nfft = opts.nfft ?? 8192;
  const hop = opts.hop ?? 2048;
  const tol = opts.tol ?? 0.18;
  const t0 = opts.t0 ?? 0;
  const t1 = opts.t1 ?? x.length / sr;
  const n = Math.max(0, Math.floor(((t1 - t0) * sr - nfft) / hop) + 1);
  const t = new Float64Array(n);
  const hz = new Float64Array(n);
  const ex = new Float64Array(n);
  const prom = new Float64Array(n);
  const tmp = new Float64Array(nfft / 2 + 1);
  for (let k = 0; k < n; k++) {
    const s = Math.floor(t0 * sr) + k * hop;
    const tc = (s + nfft / 2) / sr;
    const e = expectedHz(tc);
    powerSpectrum(x, s, nfft, tmp);
    const p = strongestPeak(tmp, sr, e * (1 - tol), e * (1 + tol));
    t[k] = tc;
    hz[k] = p.freq;
    ex[k] = e;
    prom[k] = p.prominenceDb;
  }
  return { t, hz, expected: ex, prom };
}

/**
 * Click / discontinuity detector. Looks at the second difference of the signal; a click is a
 * sample whose second difference towers over the surrounding noise floor. Returns the worst
 * ratio (peak |d2| over the local RMS of d2, measured +-win samples away) and where it happened.
 * Impulsive-but-legit material (engine pulses) scores moderate values; true clicks score very high.
 */
export function clickScore(x: Arr, win = 96): { score: number; at: number } {
  const n = x.length;
  const d2 = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) d2[i] = x[i + 1] - 2 * x[i] + x[i - 1];
  // running energy
  const pref = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pref[i + 1] = pref[i] + d2[i] * d2[i];
  let worst = 0;
  let at = 0;
  for (let i = win + 2; i < n - win - 2; i += 1) {
    const a = Math.abs(d2[i]);
    if (a < 1e-6) continue;
    const e = pref[i - 2] - pref[i - win] + (pref[i + win] - pref[i + 3]);
    const loc = Math.sqrt(e / (2 * (win - 2)) + 1e-18);
    const sc = a / loc;
    if (sc > worst) {
      worst = sc;
      at = i;
    }
  }
  return { score: worst, at };
}

/** Largest relative change of the short-time RMS envelope between adjacent windows (ms-scale). */
export function envelopeJump(x: Arr, sr: number, winMs = 4, from = 0, to = x.length): { maxRatioDb: number; at: number } {
  const w = Math.max(8, Math.floor((winMs / 1000) * sr));
  let prev = -1;
  let worst = 0;
  let at = 0;
  for (let s = from; s + w <= to; s += w) {
    const r = rms(x, s, s + w) + 1e-9;
    if (prev > 0) {
      const d = Math.abs(20 * Math.log10(r / prev));
      if (d > worst) {
        worst = d;
        at = s;
      }
    }
    prev = r;
  }
  return { maxRatioDb: worst, at };
}

/** Linear regression slope (per index) of y. */
export function slope(y: Arr): number {
  const n = y.length;
  if (n < 2) return 0;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += y[i];
    sxy += i * y[i];
    sxx += i * i;
  }
  return (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
}

/** Pearson correlation. */
export function correlation(a: Arr, b: Arr): number {
  const n = Math.min(a.length, b.length);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb || 1);
}

/** Normalised autocorrelation pitch estimate in [fMin, fMax] (Hz). */
export function autocorrPitch(x: Arr, sr: number, start: number, n: number, fMin: number, fMax: number): { freq: number; strength: number } {
  const lagMin = Math.floor(sr / fMax);
  const lagMax = Math.min(n - 2, Math.ceil(sr / fMin));
  let e0 = 0;
  for (let i = 0; i < n - lagMax; i++) e0 += x[start + i] * x[start + i];
  let best = lagMin;
  let bestV = -Infinity;
  const vals = new Float64Array(lagMax + 2);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let c = 0;
    let e1 = 0;
    for (let i = 0; i < n - lagMax; i++) {
      c += x[start + i] * x[start + i + lag];
      e1 += x[start + i + lag] * x[start + i + lag];
    }
    const v = c / Math.sqrt(e0 * e1 + 1e-18);
    vals[lag] = v;
    if (v > bestV) {
      bestV = v;
      best = lag;
    }
  }
  // prefer the first strong peak (avoid octave errors): smallest lag within 90% of the best
  for (let lag = lagMin + 1; lag < best; lag++) {
    if (vals[lag] > 0.9 * bestV && vals[lag] >= vals[lag - 1] && vals[lag] >= vals[lag + 1]) {
      best = lag;
      break;
    }
  }
  const l = vals[best - 1] ?? vals[best];
  const c = vals[best];
  const r = vals[best + 1] ?? vals[best];
  const den = l - 2 * c + r;
  const off = den !== 0 ? (0.5 * (l - r)) / den : 0;
  return { freq: sr / (best + off), strength: bestV };
}

/** Mix-down helper: returns a mono copy (mean of channels). */
export function toMono(ch: Arr[]): Float32Array {
  const n = ch[0].length;
  const out = new Float32Array(n);
  for (let c = 0; c < ch.length; c++) for (let i = 0; i < n; i++) out[i] += ch[c][i] / ch.length;
  return out;
}

/** Chroma (pitch-class energy) from a PSD, for key / chord checks of the music. */
export function chroma(psd: Arr, sr: number, fLo = 60, fHi = 2000): Float64Array {
  const nfft = (psd.length - 1) * 2;
  const df = sr / nfft;
  const out = new Float64Array(12);
  for (let i = Math.max(1, Math.floor(fLo / df)); i <= Math.min(psd.length - 1, Math.ceil(fHi / df)); i++) {
    const f = i * df;
    const midi = 69 + 12 * Math.log2(f / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    out[pc] += psd[i];
  }
  return out;
}

/**
 * Phase-locked pitch deviation: heterodynes the signal with a unit phasor following the EXPECTED
 * frequency trajectory, low-passes (boxcar) and measures the slope of the residual phase. Returns
 * the relative frequency deviation (measured - expected) / expected per step. Far more precise
 * than FFT peak picking for fast sweeps / low frequencies.
 */
export function chirpDeviation(
  x: Arr,
  sr: number,
  fExp: (tSec: number) => number,
  t0: number,
  t1: number,
  opts: { boxMs?: number; fitMs?: number; stepMs?: number } = {},
): { t: Float64Array; relDev: Float64Array; level: Float64Array } {
  const boxN = Math.max(8, Math.floor(((opts.boxMs ?? 30) / 1000) * sr));
  const fitN = Math.max(boxN, Math.floor(((opts.fitMs ?? 120) / 1000) * sr));
  const stepN = Math.max(1, Math.floor(((opts.stepMs ?? 40) / 1000) * sr));
  const n0 = Math.floor(t0 * sr);
  const n1 = Math.min(x.length, Math.floor(t1 * sr));
  const len = n1 - n0;
  const re = new Float64Array(len + 1);
  const im = new Float64Array(len + 1);
  let phi = 0;
  for (let i = 0; i < len; i++) {
    phi += (2 * Math.PI * fExp((n0 + i) / sr)) / sr;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    re[i + 1] = re[i] + x[n0 + i] * c;
    im[i + 1] = im[i] - x[n0 + i] * s;
  }
  // boxcar low-pass of the baseband via prefix sums
  const m = len - boxN;
  const zr = new Float64Array(Math.max(m, 0));
  const zi = new Float64Array(Math.max(m, 0));
  for (let i = 0; i < m; i++) {
    zr[i] = (re[i + boxN] - re[i]) / boxN;
    zi[i] = (im[i + boxN] - im[i]) / boxN;
  }
  // unwrap the phase
  const ph = new Float64Array(m);
  let prev = 0;
  let off = 0;
  for (let i = 0; i < m; i++) {
    let p = Math.atan2(zi[i], zr[i]) + off;
    while (p - prev > Math.PI) {
      p -= 2 * Math.PI;
      off -= 2 * Math.PI;
    }
    while (p - prev < -Math.PI) {
      p += 2 * Math.PI;
      off += 2 * Math.PI;
    }
    ph[i] = p;
    prev = p;
  }
  const tt: number[] = [];
  const rd: number[] = [];
  const lv: number[] = [];
  for (let s = 0; s + fitN <= m; s += stepN) {
    // linear regression of phase over the fit window
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sxx = 0;
    let mag = 0;
    for (let i = 0; i < fitN; i += 4) {
      const xx = i / sr;
      const yy = ph[s + i];
      sx += xx;
      sy += yy;
      sxy += xx * yy;
      sxx += xx * xx;
      mag += Math.hypot(zr[s + i], zi[s + i]);
    }
    const cnt = Math.ceil(fitN / 4);
    const slopeRad = (cnt * sxy - sx * sy) / (cnt * sxx - sx * sx || 1);
    const tc = (n0 + s + (fitN + boxN) / 2) / sr;
    const fe = fExp(tc);
    tt.push(tc);
    rd.push(slopeRad / (2 * Math.PI) / fe);
    lv.push(mag / cnt);
  }
  return { t: Float64Array.from(tt), relDev: Float64Array.from(rd), level: Float64Array.from(lv) };
}

/** Where the power of an engine note sits relative to its crank (see orderFamilies). Powers are sums over the lines in the band. */
export interface OrderFamilies {
  /** The firing lines: multiples of `fireOrder` x f0. */
  fire: number;
  /** The half orders of the crank: odd multiples of f0 = rpm/120. */
  half: number;
  /** The other even multiples of f0 (whole orders of the crank that are not firing lines). */
  whole: number;
  /** Everything between the lines (noise, jitter, anything off the grid). */
  between: number;
  /** How many distinct lines of each family fell in the band, so that families can be compared line for line. */
  lines: { fire: number; half: number; whole: number };
  /** The share of all the power in the band that sits in the half-order lines. */
  halfShare: number;
}

/**
 * Splits the spectrum of a four-stroke engine into the families of lines the crank makes: f0 = rpm/120 is one turn of the 720 degree
 * cycle, an engine of N cylinders fires N times in it, so its firing lines are at multiples of N x f0. An engine whose pulses are even
 * has nothing else but noise; the lines at the odd multiples of f0 (the half orders of the crank) belong to an engine whose pulses are
 * uneven from one half-turn to the next: the burble of a cross-plane V8 through a dual exhaust, the rumble of a boxer. The PSD needs a
 * resolution of about f0/9 or finer (the lines are told from the gaps between them within `tolFrac` x f0 of each multiple).
 */
export function orderFamilies(psd: Arr, sr: number, f0: number, fireOrder: number, fLo: number, fHi: number, tolFrac = 0.13): OrderFamilies {
  const nfft = (psd.length - 1) * 2;
  const df = sr / nfft;
  const sum = { fire: 0, half: 0, whole: 0 };
  const seen = { fire: new Set<number>(), half: new Set<number>(), whole: new Set<number>() };
  let between = 0;
  const tol = tolFrac * f0;
  for (let i = Math.max(1, Math.floor(fLo / df)); i <= Math.min(psd.length - 1, Math.ceil(fHi / df)); i++) {
    const f = i * df;
    const m = Math.round(f / f0);
    if (m < 1) continue;
    if (Math.abs(f - m * f0) > tol) {
      between += psd[i];
      continue;
    }
    const fam = m % fireOrder === 0 ? 'fire' : m % 2 === 1 ? 'half' : 'whole';
    sum[fam] += psd[i];
    seen[fam].add(m);
  }
  const total = sum.fire + sum.half + sum.whole + between;
  return {
    ...sum,
    between,
    lines: { fire: seen.fire.size, half: seen.half.size, whole: seen.whole.size },
    halfShare: total > 0 ? sum.half / total : 0,
  };
}

/**
 * Aliasing / inharmonic-line detector: finds tonal peaks (prominent over the local floor) that do NOT
 * sit on integer multiples of `baseHz`. Aliased components of a band-limited synthesiser fold back to
 * off-grid frequencies, so a clean engine note has none. Returns the number of off-grid lines and the
 * strongest one relative to the strongest line overall (dB, negative = weaker).
 */
export function offGridLines(
  psd: Arr,
  sr: number,
  baseHz: number,
  opts: { fLo?: number; fHi?: number; prominenceDb?: number; floorDb?: number; tolHz?: number } = {},
): { count: number; worstDb: number; strongestHz: number; lines: { hz: number; db: number }[] } {
  const nfft = (psd.length - 1) * 2;
  const df = sr / nfft;
  const fLo = opts.fLo ?? 60;
  const fHi = opts.fHi ?? Math.min(sr * 0.45, 16000);
  const prom = Math.pow(10, (opts.prominenceDb ?? 14) / 10);
  const floorRel = Math.pow(10, -(opts.floorDb ?? 55) / 10);
  const tol = opts.tolHz ?? Math.max(2.5, baseHz * 0.012);
  // strongest line overall
  let top = 0;
  for (let i = Math.max(3, Math.floor(fLo / df)); i <= Math.min(psd.length - 4, Math.ceil(fHi / df)); i++) top = Math.max(top, psd[i]);
  const lines: { hz: number; db: number }[] = [];
  let worst = -999;
  let strongestHz = 0;
  for (let i = Math.max(30, Math.floor(fLo / df)); i <= Math.min(psd.length - 31, Math.ceil(fHi / df)); i++) {
    const p = psd[i];
    if (!(p > psd[i - 1] && p >= psd[i + 1]) || p < top * floorRel) continue;
    const nb: number[] = [];
    for (let k = -25; k <= 25; k++) if (Math.abs(k) > 4) nb.push(psd[i + k]);
    nb.sort((a, b) => a - b);
    if (p < nb[nb.length >> 1] * prom) continue;
    const l = Math.log(psd[i - 1] + 1e-30);
    const c = Math.log(p + 1e-30);
    const r = Math.log(psd[i + 1] + 1e-30);
    const d = l - 2 * c + r;
    const hz = (i + (d !== 0 ? (0.5 * (l - r)) / d : 0)) * df;
    const k = Math.max(1, Math.round(hz / baseHz));
    if (Math.abs(hz - k * baseHz) <= tol) continue;
    const db = 10 * Math.log10(p / top);
    lines.push({ hz, db });
    if (db > worst) {
      worst = db;
      strongestHz = hz;
    }
  }
  return { count: lines.length, worstDb: worst, strongestHz, lines };
}
