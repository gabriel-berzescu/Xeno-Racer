/** Shared helpers for the browser report: check collection, mono mix-down, segment analysis. */
import {
  harmonicShare,
  hasNonFinite,
  peakAbs,
  rms,
  spectralCentroid,
  strongestPeak,
  welch,
  type PeakInfo,
} from '../../src/audio/analysis';
import type { SceneResult } from './harness';

export interface Check {
  name: string;
  pass: boolean;
  value?: number | string;
  limit?: string;
  note?: string;
}

export class Checks {
  list: Check[] = [];
  add(name: string, pass: boolean, value?: number | string, limit?: string, note?: string): boolean {
    this.list.push({ name, pass, value: typeof value === 'number' ? Math.round(value * 1000) / 1000 : value, limit, note });
    return pass;
  }
  get ok(): boolean {
    return this.list.every((c) => c.pass);
  }
  get failed(): Check[] {
    return this.list.filter((c) => !c.pass);
  }
}

export function mono(r: SceneResult): Float32Array {
  const n = r.left.length;
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = (r.left[i] + r.right[i]) * 0.5;
  return m;
}

export function db(x: number): number {
  return 20 * Math.log10(Math.max(x, 1e-9));
}

export interface SegmentStats {
  rmsDb: number;
  peakDb: number;
  centroid: number;
  psd: Float64Array;
}

/** Analyse [t0, t1) seconds of a mono signal. */
export function analyseSegment(x: Float32Array, sr: number, t0: number, t1: number, nfft = 16384): SegmentStats {
  const a = Math.floor(t0 * sr);
  const b = Math.min(x.length, Math.floor(t1 * sr));
  const psd = welch(x, nfft, a, b);
  return {
    rmsDb: db(rms(x, a, b)),
    peakDb: db(peakAbs(x, a, b)),
    centroid: spectralCentroid(psd, sr, 40, 12000),
    psd,
  };
}

export function peakNear(psd: Float64Array, sr: number, f: number, tol = 0.1): PeakInfo {
  return strongestPeak(psd, sr, f * (1 - tol), f * (1 + tol));
}

export { harmonicShare, hasNonFinite, peakAbs, rms, spectralCentroid, strongestPeak, welch };

/** Short-time RMS envelope in `ms` windows. */
export function envelope(x: Float32Array, sr: number, ms: number, from = 0, to = x.length): Float32Array {
  const w = Math.max(1, Math.floor((ms / 1000) * sr));
  const n = Math.floor((to - from) / w);
  const e = new Float32Array(n);
  for (let k = 0; k < n; k++) e[k] = rms(x, from + k * w, from + (k + 1) * w);
  return e;
}

export function median(a: number[]): number {
  const s = [...a].sort((p, q) => p - q);
  return s.length ? s[s.length >> 1] : 0;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}
