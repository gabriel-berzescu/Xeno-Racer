/**
 * Cymbal and hi-hat synthesis by modal synthesis: a few dozen inharmonic damped partials (higher partials die faster, as in
 * real brass) plus a band of noise, rendered once into a stereo buffer when the instrument is built. The drum voices then play
 * the buffer back with a velocity-dependent tilt. Deterministic: the partials come from a seeded generator.
 */
import { Noise, Rng, TAU } from './core';
import { Biquad } from './filters';

export interface CymbalSpec {
  seed: number;
  /** Buffer length in seconds (the sound is faded out smoothly at the end). */
  duration: number;
  partials: number;
  /** Frequency range of the partials in Hz. */
  fLo: number;
  fHi: number;
  /** Decay time constant (seconds, amplitude 1/e) of a partial at 1 kHz. */
  tau: number;
  /** Exponent of the frequency dependence of the decay: tau(f) = tau * (1000 / f) ^ alpha. */
  alpha: number;
  /** Level of the noise band relative to the partials. */
  noise: number;
  /** Decay time constant of the noise. */
  noiseTau: number;
  /** Noise band-pass centre and width (Hz). */
  noiseHz: number;
  /** Attack time (ms) of the lowest partials; higher partials start sooner. */
  attackMs: number;
  /** Strike click level (a very short burst at the start). */
  strike: number;
  /** Extra emphasis (dB) of the partials near `bellHz` (ride bell / ping). */
  bellHz?: number;
  bellGain?: number;
  /** Spectral tilt: positive = brighter (dB per octave above 1 kHz). */
  tilt: number;
  /** High-pass corner in Hz. */
  hp: number;
}

export interface CymbalBuffer {
  l: Float32Array;
  r: Float32Array;
  /** Sample rate it was rendered at. */
  sr: number;
}

/** Renders a stereo cymbal buffer. Cost grows with partials x duration (about 60 ms for a 2.8 s crash at 48 kHz). */
export function renderCymbal(sr: number, spec: CymbalSpec): CymbalBuffer {
  const n = Math.round(spec.duration * sr);
  const out = [new Float32Array(n), new Float32Array(n)];
  const rng = new Rng(spec.seed);
  const part = spec.partials;
  // partial frequencies: log-uniform with a minimum spacing so that neighbours do not fuse
  const freqs: number[] = [];
  const logLo = Math.log(spec.fLo);
  const logHi = Math.log(spec.fHi);
  let guard = 0;
  while (freqs.length < part && guard++ < part * 60) {
    const f = Math.exp(logLo + (logHi - logLo) * rng.next());
    if (freqs.every((g) => Math.abs(Math.log(f / g)) > 0.012)) freqs.push(f);
  }
  freqs.sort((a, b) => a - b);
  for (let ch = 0; ch < 2; ch++) {
    const buf = out[ch];
    const r2 = new Rng(spec.seed * 7919 + ch * 104729 + 13);
    // one damped sinusoid by recurrence, with a soft onset (lower partials take longer to bloom)
    const addPartial = (f: number, amp: number, tau: number, phi: number): void => {
      if (f >= sr * 0.46) return;
      const w = (TAU * f) / sr;
      const r = Math.exp(-1 / (tau * sr));
      const c = 2 * r * Math.cos(w);
      const rr = r * r;
      let y1 = amp * Math.sin(phi);
      let y2 = (amp * Math.sin(phi - w)) / r;
      const onset = Math.max(1, Math.round(((spec.attackMs / 1000) * sr * 1000) / Math.max(f, 300)));
      for (let i = 0; i < n; i++) {
        const y = c * y1 - rr * y2;
        y2 = y1;
        y1 = y;
        buf[i] += i < onset ? y * (i / onset) : y;
      }
    };
    for (let k = 0; k < freqs.length; k++) {
      const f = freqs[k] * (1 + (ch ? 1 : -1) * 0.0012 * (r2.next() - 0.3));
      const tau = spec.tau * Math.pow(1000 / f, spec.alpha) * (0.7 + 0.6 * r2.next());
      let amp = (0.35 + 0.65 * r2.next()) * Math.pow(f / 1000, spec.tilt / 6.02);
      if (spec.bellHz) amp *= 1 + (Math.pow(10, (spec.bellGain ?? 6) / 20) - 1) * Math.exp(-Math.pow(Math.log(f / spec.bellHz) / 0.22, 2));
      addPartial(f, amp, tau, r2.next() * TAU);
      // every other partial gets a slightly detuned twin: the two beat against each other, which is what makes a cymbal shimmer
      if (k % 2 === 0) {
        const d = (0.0015 + 0.005 * r2.next()) * (r2.next() < 0.5 ? -1 : 1);
        addPartial(f * (1 + d), amp * 0.8, tau * (0.8 + 0.3 * r2.next()), r2.next() * TAU);
      }
    }
    // noise band
    const nz = new Noise(spec.seed * 31 + ch * 977 + 5);
    const bp = new Biquad().bandpass(spec.noiseHz, 0.6, sr);
    const bp2 = new Biquad().highpass(spec.noiseHz * 0.4, 0.7, sr);
    const nr = Math.exp(-1 / (spec.noiseTau * sr));
    let e = spec.noise;
    const nAmp = 0.5;
    for (let i = 0; i < n; i++) {
      const v = bp2.process(bp.process(nz.next())) * e * nAmp;
      buf[i] += v;
      e *= nr;
    }
    // strike click
    const clickN = Math.round(0.0018 * sr);
    const hp = new Biquad().highpass(2500, 0.7, sr);
    const nz2 = new Noise(spec.seed + 99 + ch);
    for (let i = 0; i < clickN; i++) buf[i] += hp.process(nz2.next()) * spec.strike * (1 - i / clickN);
    // high-pass, fade out the last 12 %
    const h = new Biquad().highpass(spec.hp, 0.7, sr);
    const fadeStart = Math.floor(n * 0.88);
    for (let i = 0; i < n; i++) {
      let v = h.process(buf[i]);
      if (i > fadeStart) {
        const x = (i - fadeStart) / (n - fadeStart);
        v *= 0.5 + 0.5 * Math.cos(Math.PI * x);
      }
      buf[i] = v;
    }
  }
  // normalise both channels together
  let peak = 1e-9;
  for (const b of out) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(b[i]));
  const g = 0.95 / peak;
  for (const b of out) for (let i = 0; i < n; i++) b[i] *= g;
  return { l: out[0], r: out[1], sr };
}

/** Preset recipes for cymbal-like buffers. */
export const CYMBAL_RECIPES: Record<string, CymbalSpec> = {
  crash: { seed: 11, duration: 2.6, partials: 58, fLo: 420, fHi: 15500, tau: 0.9, alpha: 0.75, noise: 0.7, noiseTau: 0.6, noiseHz: 7500, attackMs: 14, strike: 0.5, tilt: 4.5, hp: 380 },
  'crash-dark': { seed: 12, duration: 2.6, partials: 54, fLo: 320, fHi: 12500, tau: 1.0, alpha: 0.7, noise: 0.5, noiseTau: 0.65, noiseHz: 5200, attackMs: 18, strike: 0.4, tilt: 2, hp: 300 },
  splash: { seed: 13, duration: 1.1, partials: 28, fLo: 800, fHi: 16000, tau: 0.32, alpha: 0.8, noise: 0.65, noiseTau: 0.25, noiseHz: 9000, attackMs: 6, strike: 0.5, tilt: 4, hp: 700 },
  china: { seed: 14, duration: 2.0, partials: 52, fLo: 500, fHi: 14000, tau: 0.6, alpha: 0.6, noise: 0.7, noiseTau: 0.5, noiseHz: 5200, attackMs: 4, strike: 0.7, tilt: 0.5, hp: 400 },
  ride: { seed: 15, duration: 2.2, partials: 48, fLo: 450, fHi: 13000, tau: 1.1, alpha: 1.1, noise: 0.18, noiseTau: 0.3, noiseHz: 7500, attackMs: 3, strike: 0.5, tilt: 0.8, hp: 400, bellHz: 2100, bellGain: 7 },
  'ride-bell': { seed: 16, duration: 1.8, partials: 26, fLo: 900, fHi: 9000, tau: 1.0, alpha: 0.9, noise: 0.05, noiseTau: 0.15, noiseHz: 6000, attackMs: 1.5, strike: 0.6, tilt: 0, hp: 700, bellHz: 2400, bellGain: 10 },
  hatClosed: { seed: 21, duration: 0.2, partials: 22, fLo: 2500, fHi: 16000, tau: 0.035, alpha: 0.4, noise: 0.55, noiseTau: 0.03, noiseHz: 9000, attackMs: 0.8, strike: 0.7, tilt: 1, hp: 3500 },
  hatOpen: { seed: 22, duration: 1.2, partials: 30, fLo: 1800, fHi: 16000, tau: 0.35, alpha: 0.7, noise: 0.5, noiseTau: 0.28, noiseHz: 8500, attackMs: 1.2, strike: 0.6, tilt: 1, hp: 3000 },
  hatPedal: { seed: 23, duration: 0.14, partials: 18, fLo: 2000, fHi: 14000, tau: 0.03, alpha: 0.4, noise: 0.5, noiseTau: 0.025, noiseHz: 7000, attackMs: 1.5, strike: 0.5, tilt: 0, hp: 2500 },
};
