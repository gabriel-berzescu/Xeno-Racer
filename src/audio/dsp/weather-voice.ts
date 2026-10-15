/**
 * WeatherVoice — the rain ambience (stereo), synthesised, with distant thunder on top.
 *
 *   smooth bed      white noise through a broad band-pass (the "shhh" of a million drops, centred ~3 kHz) and a
 *                   low-pass body, decorrelated left / right, with slow gusts that move the level around
 *   drop events     one superposed Poisson stream scattered into a small ring buffer from pre-rendered drop
 *                   waveforms: grains (the dense sizzle), ticks, bubble "plinks" (damped, chirping sine) and the odd
 *                   big splat. Amplitudes are heavy-tailed, so a few drops stand out of the roar: patter in light
 *                   rain, a roar with texture in a downpour. Event cost is a handful of MACs per drop.
 *   in the cabin    the exterior set cross-fades (about 0.2 s) into a muffled bed plus drumming on the roof,
 *                   patter on the panels and ticks on the windscreen (more of them the faster the car goes)
 *   storm           a gusty low wind bed, and ThunderVoice claps (triggered from the main thread's scheduler)
 *
 * Silent (and nearly free) when the target is 0 and the fade has finished; the main thread then drops the
 * node altogether. No allocation after construction; safe to call from an AudioWorklet.
 */
import {
  N_STREAMS,
  STREAM,
  type ThunderEvent,
  type WeatherInputs,
  type RainProfile,
  makeRainProfile,
  makeWeatherInputs,
  rainProfile,
} from '../weather-model';
import { SVF } from './filters';
import { ThunderVoice } from './thunder-voice';
import { Rng, TAU, clamp, lerp, ouStep, smoothCoef } from './util';

// ── drop waveform bank ───────────────────────────────────────────────────────

const RING = 4096;
const MASK = RING - 1;

interface ProtoSet {
  base: number;
  n: number;
}

export interface ProtoBank {
  data: Float32Array;
  off: Int32Array;
  len: Int32Array;
  grain: ProtoSet;
  tick: ProtoSet;
  plink: ProtoSet;
  splat: ProtoSet;
  drum: ProtoSet;
  patter: ProtoSet;
  glass: ProtoSet;
}

/** Two cascaded one-pole high-passes: drop the DC / low skirt a damped sine leaves behind. */
function highpass(x: Float32Array, fc: number, sr: number): void {
  const a = 1 / (1 + (TAU * fc) / sr);
  for (let pass = 0; pass < 2; pass++) {
    let px = 0;
    let py = 0;
    for (let i = 0; i < x.length; i++) {
      const y = a * (py + x[i] - px);
      px = x[i];
      py = y;
      x[i] = y;
    }
  }
}

function normalise(x: Float32Array): void {
  let e = 0;
  for (let i = 0; i < x.length; i++) e += x[i] * x[i];
  const g = e > 0 ? 1 / Math.sqrt(e) : 0;
  for (let i = 0; i < x.length; i++) x[i] *= g;
}

/** Fade the last quarter to zero so a truncated tail never clicks. */
function fadeTail(x: Float32Array): void {
  const n = x.length;
  const m = Math.max(2, n >> 2);
  for (let i = 0; i < m; i++) {
    const w = 0.5 + 0.5 * Math.cos((Math.PI * i) / m);
    x[n - m + i] *= w;
  }
}

function addMode(x: Float32Array, sr: number, f0: number, tau: number, amp: number, chirp = 0, chirpTau = 0.002): void {
  const k = Math.exp(-1 / (tau * sr));
  const kc = Math.exp(-1 / (chirpTau * sr));
  const att = Math.max(2, 0.00012 * sr);
  let env = amp;
  let ce = 1; // exp(-n / (chirpTau * sr)), by recursion
  let ph = 0;
  for (let n = 0; n < x.length; n++) {
    const f = f0 * (1 + chirp * (1 - ce));
    ph += (TAU * f) / sr;
    x[n] += env * Math.sin(ph) * Math.min(1, (n + 1) / att);
    env *= k;
    ce *= kc;
  }
}

/** Short band-passed noise burst (the "click" of the impact itself). */
function addClick(x: Float32Array, sr: number, rng: Rng, tau: number, fc: number, amp: number): void {
  const svf = new SVF();
  svf.set(fc, 0.9, sr);
  const k = Math.exp(-1 / (tau * sr));
  let env = amp;
  const att = Math.max(2, 0.00008 * sr);
  for (let n = 0; n < x.length && env > amp * 0.003; n++) {
    svf.step(rng.s2());
    x[n] += svf.bp * env * Math.min(1, (n + 1) / att);
    env *= k;
  }
}

export function buildProtoBank(sr: number): ProtoBank {
  const rng = new Rng(0x7a1b2c3d);
  const protos: Float32Array[] = [];
  const add = (x: Float32Array, hp: number): void => {
    fadeTail(x);
    highpass(x, hp, sr);
    normalise(x);
    protos.push(x);
  };
  const mkSet = (n: number, hp: number, make: (i: number, f: number) => Float32Array): ProtoSet => {
    const base = protos.length;
    for (let i = 0; i < n; i++) add(make(i, n > 1 ? i / (n - 1) : 0), hp);
    return { base, n };
  };
  const logf = (lo: number, hi: number, f: number): number => lo * Math.pow(hi / lo, f);
  const samples = (sec: number, max: number): number => Math.min(max, Math.max(16, Math.round(sec * sr)));

  // grains: the dense sizzle, ~0.5-1.2 ms band-passed clicks between 1.8 and 7.5 kHz
  const grain = mkSet(14, 600, (_i, f) => {
    const x = new Float32Array(samples(0.0011, 96));
    addClick(x, sr, rng, lerp(0.00035, 0.00018, f) * (0.8 + 0.4 * rng.u()), logf(1800, 7500, f) * (0.92 + 0.16 * rng.u()), 1);
    return x;
  });
  // ticks: drops on hard ground, 1.5-4 ms, 1.2-6 kHz, with a hint of ring
  const tick = mkSet(14, 500, (_i, f) => {
    const x = new Float32Array(samples(0.0045, 300));
    const fc = logf(1200, 6200, f) * (0.94 + 0.12 * rng.u());
    addClick(x, sr, rng, 0.0009 * (0.8 + 0.5 * rng.u()), fc, 1);
    addMode(x, sr, fc * 0.8, 0.0013, 0.35);
    return x;
  });
  // plinks: bubble resonance of a drop on water, 1.1-6.2 kHz, rising a little as it rings
  const plink = mkSet(26, 600, (_i, f) => {
    const fr = logf(1100, 6200, f) * (0.97 + 0.06 * rng.u());
    const tau = clamp(0.0024 * Math.pow(3000 / fr, 0.8) * (0.8 + 0.5 * rng.u()), 0.0008, 0.009);
    const x = new Float32Array(samples(tau * 5, 900));
    addMode(x, sr, fr, tau, 1, 0.08 + 0.18 * rng.u(), 0.0015);
    addClick(x, sr, rng, 0.0004, fr * 1.3, 0.25);
    return x;
  });
  // splats: big drops on a puddle / car / leaf, 320-1400 Hz, 4-12 ms
  const splat = mkSet(12, 200, (_i, f) => {
    const fr = logf(320, 1400, f) * (0.95 + 0.1 * rng.u());
    const tau = lerp(0.011, 0.005, f) * (0.8 + 0.4 * rng.u());
    const x = new Float32Array(samples(tau * 4.5, 1800));
    addMode(x, sr, fr, tau, 1, 0.05 + 0.1 * rng.u(), 0.004);
    addMode(x, sr, fr * 2.3, tau * 0.5, 0.3);
    addClick(x, sr, rng, 0.0015, fr * 2, 0.5);
    return x;
  });
  // roof drumming (cabin): a thin panel struck by a drop, 160-650 Hz modes
  const drum = mkSet(16, 70, (_i, f) => {
    const f1 = logf(160, 650, f) * (0.96 + 0.08 * rng.u());
    const tau = lerp(0.012, 0.005, f) * (0.85 + 0.3 * rng.u());
    const x = new Float32Array(samples(tau * 3.6, 3000));
    addMode(x, sr, f1, tau, 1);
    addMode(x, sr, f1 * (2.05 + 0.5 * rng.u()), tau * 0.65, 0.55);
    addMode(x, sr, f1 * (3.6 + 0.8 * rng.u()), tau * 0.4, 0.3);
    addClick(x, sr, rng, 0.0018, 1100, 0.45);
    return x;
  });
  // panel patter (cabin): lighter taps, 450-1700 Hz, 3-8 ms
  const patter = mkSet(16, 250, (_i, f) => {
    const f1 = logf(450, 1700, f) * (0.96 + 0.08 * rng.u());
    const tau = lerp(0.008, 0.0035, f) * (0.85 + 0.3 * rng.u());
    const x = new Float32Array(samples(tau * 4, 1200));
    addMode(x, sr, f1, tau, 1);
    addMode(x, sr, f1 * (1.9 + 0.7 * rng.u()), tau * 0.6, 0.4);
    addClick(x, sr, rng, 0.001, 1600, 0.5);
    return x;
  });
  // windscreen ticks (cabin): glass, 2.2-4.8 kHz, 1.2-3 ms
  const glass = mkSet(12, 700, (_i, f) => {
    const f1 = logf(2200, 4800, f) * (0.97 + 0.06 * rng.u());
    const tau = lerp(0.003, 0.0013, f) * (0.85 + 0.3 * rng.u());
    const x = new Float32Array(samples(tau * 5, 700));
    addMode(x, sr, f1, tau, 1);
    addMode(x, sr, f1 * 1.62, tau * 0.6, 0.4);
    addClick(x, sr, rng, 0.0005, f1, 0.6);
    return x;
  });

  let total = 0;
  for (const p of protos) total += p.length;
  const data = new Float32Array(total);
  const off = new Int32Array(protos.length);
  const len = new Int32Array(protos.length);
  let o = 0;
  protos.forEach((p, i) => {
    off[i] = o;
    len[i] = p.length;
    data.set(p, o);
    o += p.length;
  });
  return { data, off, len, grain, tick, plink, splat, drum, patter, glass };
}

const bankCache = new Map<number, ProtoBank>();
/** One bank per sample rate, shared by every voice in the worklet scope. */
export function getProtoBank(sr: number): ProtoBank {
  let b = bankCache.get(sr);
  if (!b) {
    b = buildProtoBank(sr);
    bankCache.set(sr, b);
  }
  return b;
}

// ── calibration ──────────────────────────────────────────────────────────────

/**
 * Linear gains that put the exterior rain at about -27 dBFS RMS (storm, rain = 1), -32.5 dBFS (the "rain" preset, 0.55) and
 * -39 dBFS (drizzle, 0.2), with the cabin a couple of dB lower: A-weighted that is ~10 dB under an engine at full
 * throttle (-18 dB(A)) in a storm and ~15 dB under it in the preset, and about level with the engine when it coasts
 * (-30 dB(A)). Measured by the tests and the browser report (sandbox/audio.html?test=1&only=weather), not guessed.
 */
export const RAIN_CAL = {
  /** Overall level in dB as a function of the intensity: -1 dB in a storm, +2.8 dB more as it eases off (see masterGain). */
  masterDb: -1.0,
  masterSlopeDb: 2.8,
  hi: 0.087,
  lo: 0.072,
  cabin: 0.11,
  wind: 0.145,
  /** Depth of the fast (~150 Hz) grain modulation of the smooth bed: the crackle that keeps it from sounding like static. */
  tex: 0.3,
  /** Per-stream event amplitude (before the heavy-tailed random factor). */
  stream: [0.09, 0.232, 0.203, 0.36, 0.26, 0.165, 0.195] as number[],
  /** Pareto shape per stream (smaller = heavier tail). */
  alpha: [3, 2.6, 2.4, 2, 2.2, 2.4, 2.4] as number[],
};

/** Trims for isolating layers while measuring (all 1 in normal use). */
export interface WeatherTrim {
  hi: number;
  lo: number;
  cabin: number;
  wind: number;
  thunder: number;
  stream: Float64Array;
}

export class WeatherVoice {
  readonly inp: WeatherInputs = makeWeatherInputs();
  readonly trim: WeatherTrim = { hi: 1, lo: 1, cabin: 1, wind: 1, thunder: 1, stream: new Float64Array(N_STREAMS).fill(1) };
  private readonly sr: number;
  private readonly bank: ProtoBank;
  private rng: Rng;
  private erng: Rng;

  // smoothed inputs
  private sRain = 0;
  private sInt = 0;
  private sSpeed = 0;
  private sGain = 0;
  private asleep = true;

  // bed
  private aL = new SVF();
  private aR = new SVF();
  private bL = new SVF();
  private bR = new SVF();
  private wL = new SVF();
  private wR = new SVF();
  private gHi = 0;
  private gLo = 0;
  private gWind = 0;
  private gustL = 0;
  private gustR = 0;
  private gustMulL = 1;
  private gustMulR = 1;
  private windMod = 0;
  private gOutPrev = 0;
  private texL = 0;
  private texR = 0;

  // drop events
  private accL = new Float32Array(RING);
  private accR = new Float32Array(RING);
  private pos = 0;
  private evCnt = 1e9;
  private readonly prof: RainProfile = makeRainProfile();
  private readonly cum = new Float64Array(N_STREAMS);
  private total = 0;
  private readonly streamGain = new Float64Array(N_STREAMS);
  private readonly pareto = new Float64Array(N_STREAMS);

  // thunder
  private thunder: ThunderVoice[] = [];
  private thunderRR = 0;
  private tL = new Float32Array(128);
  private tR = new Float32Array(128);

  constructor(sr: number, seed = 1) {
    this.sr = sr;
    this.bank = getProtoBank(sr);
    this.rng = new Rng(seed * 104729 + 31);
    this.erng = new Rng(seed * 15485863 + 7);
    this.aL.set(2000, 0.55, sr);
    this.aR.set(2000, 0.55, sr);
    this.bL.set(520, 0.7, sr);
    this.bR.set(520, 0.7, sr);
    this.wL.set(420, 1.4, sr);
    this.wR.set(420, 1.4, sr);
    for (let s = 0; s < N_STREAMS; s++) this.pareto[s] = -1 / RAIN_CAL.alpha[s];
    this.thunder.push(new ThunderVoice(sr), new ThunderVoice(sr));
  }

  /** Is the voice producing (or about to produce) sound? */
  get awake(): boolean {
    return !this.asleep;
  }

  /** Start a clap now. */
  triggerThunder(ev: ThunderEvent): void {
    // reuse a free voice, else steal the older one
    let v = this.thunder[this.thunderRR];
    for (let i = 0; i < this.thunder.length; i++) {
      if (!this.thunder[i].active) {
        v = this.thunder[i];
        break;
      }
    }
    this.thunderRR = (this.thunderRR + 1) % this.thunder.length;
    v.trigger(ev);
  }

  private wake(): void {
    this.asleep = false;
    this.accL.fill(0);
    this.accR.fill(0);
    this.evCnt = 1;
    this.aL.reset();
    this.aR.reset();
    this.bL.reset();
    this.bR.reset();
    this.wL.reset();
    this.wR.reset();
  }

  reset(): void {
    this.asleep = true;
    this.sRain = this.sInt = this.sSpeed = this.sGain = 0;
    this.accL.fill(0);
    this.accR.fill(0);
    for (let i = 0; i < this.thunder.length; i++) this.thunder[i].stop();
  }

  process(outL: Float32Array, outR: Float32Array, n: number, offset = 0): void {
    let done = 0;
    while (done < n) {
      const len = Math.min(128, n - done);
      this.block(outL, outR, offset + done, len);
      done += len;
    }
  }

  private pickGap(): number {
    const rate = this.total;
    if (!(rate > 0.01)) return 1e9;
    const g = (-Math.log(1 - this.erng.u()) / rate) * this.sr;
    return g < 1 ? 1 : g;
  }

  private spawn(): void {
    const e = this.erng;
    const b = this.bank;
    // which stream? (cum[] holds the running sum of the rates)
    const pick = e.u() * this.total;
    let s = 0;
    while (s < N_STREAMS - 1 && pick > this.cum[s]) s++;
    let set: ProtoSet;
    let width = 0.9;
    switch (s) {
      case STREAM.GRAIN:
        set = b.grain;
        break;
      case STREAM.TICK:
        set = b.tick;
        break;
      case STREAM.PLINK:
        set = b.plink;
        break;
      case STREAM.SPLAT:
        set = b.splat;
        break;
      case STREAM.DRUM:
        set = b.drum;
        width = 0.7;
        break;
      case STREAM.PATTER:
        set = b.patter;
        width = 0.8;
        break;
      default:
        set = b.glass;
        width = 0.3;
    }
    const k = set.base + ((e.u() * set.n) | 0);
    // heavy-tailed amplitude (a few drops stand out of the roar)
    const u = e.u();
    const a = this.streamGain[s] * Math.pow(u < 0.06 ? 0.06 : u, this.pareto[s]);
    // position: constant-power level difference plus an interaural delay on the far ear (up to ~0.6 ms), so
    // drops all around the listener decorrelate the two channels instead of collapsing to a centre image
    const p = (e.u() * 2 - 1) * width;
    const ang = ((p + 1) * Math.PI) / 4;
    const gl = a * Math.cos(ang);
    const gr = a * Math.sin(ang);
    const itd = Math.round(Math.abs(p) * 0.0006 * this.sr);
    const dL = p > 0 ? itd : 0;
    const dR = p < 0 ? itd : 0;
    const off = b.off[k];
    const len = b.len[k];
    const d = b.data;
    const aL = this.accL;
    const aR = this.accR;
    const p0 = this.pos;
    for (let i = 0; i < len; i++) {
      const h = d[off + i];
      aL[(p0 + i + dL) & MASK] += gl * h;
      aR[(p0 + i + dR) & MASK] += gr * h;
    }
  }

  private block(outL: Float32Array, outR: Float32Array, o: number, len: number): void {
    const I = this.inp;
    const sr = this.sr;
    const dt = len / sr;
    const T = this.trim;

    // ── smoothing / sleep ───────────────────────────────────────────────────
    this.sRain += smoothCoef(1.4, dt) * (I.rain - this.sRain);
    this.sInt += smoothCoef(0.2, dt) * (I.interior - this.sInt);
    this.sSpeed += smoothCoef(0.4, dt) * (I.speed - this.sSpeed);
    const gTarget = I.rain > 0 ? I.gain : 0;
    // rain starting: ease in; rain over: fade out; paused (gain 0): drop out quickly so the voice goes to sleep
    const tauG = I.rain <= 0 ? 0.45 : I.gain < this.sGain ? 0.08 : 0.5;
    this.sGain += smoothCoef(tauG, dt) * (gTarget - this.sGain);
    if (this.sGain < 1e-4 && gTarget < 1e-4) {
      for (let i = 0; i < len; i++) {
        outL[o + i] = 0;
        outR[o + i] = 0;
      }
      if (!this.asleep) this.reset();
      return;
    }
    if (this.asleep) this.wake();

    // ── block-rate parameters ──────────────────────────────────────────────
    const r = this.sRain;
    const sI = this.sInt;
    const master = Math.pow(10, (RAIN_CAL.masterDb + RAIN_CAL.masterSlopeDb * (1 - r)) / 20);
    const P = rainProfile(r, sI, this.sSpeed / 70, this.prof);
    const rate = P.rate;
    let tot = 0;
    for (let s = 0; s < N_STREAMS; s++) {
      tot += rate[s] * T.stream[s];
      this.cum[s] = tot;
      // big drops get a little louder as the rain gets heavier
      this.streamGain[s] = master * RAIN_CAL.stream[s] * (0.7 + 0.3 * r);
    }
    this.total = tot;
    if (this.evCnt > 8 * sr / Math.max(tot, 1)) this.evCnt = this.pickGap();

    // gusts: the intensity wanders by a few dB, differently on the two sides
    const kG = smoothCoef(2.2, dt);
    this.gustL = ouStep(this.gustL, kG, 1, this.rng.s2());
    this.gustR = ouStep(this.gustR, kG, 1, this.rng.s2());
    const depth = P.gustDepth * 0.3;
    const mulL = Math.exp(depth * this.gustL);
    const mulR = Math.exp(depth * this.gustR);
    const wMod = ouStep(this.windMod, smoothCoef(1.6, dt), 1, this.rng.s2());
    this.windMod = wMod;

    const gHiT = master * (RAIN_CAL.hi * T.hi * P.bedHi + RAIN_CAL.cabin * T.cabin * P.bedCabin);
    const gLoT = master * RAIN_CAL.lo * T.lo * P.bedLo;
    const gWindT = master * RAIN_CAL.wind * T.wind * P.wind * (0.55 + 0.45 * clamp(1 + 0.6 * wMod, 0, 2)) * lerp(1, 0.45, sI);
    // the cabin bed is the same band-pass dragged down to ~560 Hz (windows and roof muffle everything above)
    const fcA = lerp(2000, 560, sI);
    const qA = lerp(0.55, 0.5, sI);
    this.aL.set(fcA, qA, sr);
    this.aR.set(fcA, qA, sr);
    const fcW = 420 * Math.exp(0.28 * wMod);
    this.wL.set(fcW, 1.4, sr);
    this.wR.set(fcW * 1.07, 1.4, sr);
    const invLen = 1 / len;
    let gHi = this.gHi;
    let gLo = this.gLo;
    let gWd = this.gWind;
    const dHi = (gHiT - gHi) * invLen;
    const dLo = (gLoT - gLo) * invLen;
    const dWd = (gWindT - gWd) * invLen;
    this.gHi = gHiT;
    this.gLo = gLoT;
    this.gWind = gWindT;
    let mL = this.gustMulL;
    let mR = this.gustMulR;
    const dmL = (mulL - mL) * invLen;
    const dmR = (mulR - mR) * invLen;
    this.gustMulL = mulL;
    this.gustMulR = mulR;

    // thunder into scratch buffers
    let anyThunder = false;
    for (let k = 0; k < this.thunder.length; k++) if (this.thunder[k].active) anyThunder = true;
    const tL = this.tL;
    const tR = this.tR;
    if (anyThunder) {
      tL.fill(0, 0, len);
      tR.fill(0, 0, len);
      for (let k = 0; k < this.thunder.length; k++) this.thunder[k].render(tL, tR, 0, len, sI, T.thunder);
    }

    const gOutPrev = this.gOutPrev;
    const gOutStep = (this.sGain - gOutPrev) * invLen;
    this.gOutPrev = this.sGain;
    let gOut = gOutPrev;
    const rng = this.rng;
    const accL = this.accL;
    const accR = this.accR;
    const aL = this.aL;
    const aR = this.aR;
    const bL = this.bL;
    const bR = this.bR;
    const wL = this.wL;
    const wR = this.wR;
    const tex = RAIN_CAL.tex * 17.5; // 17.5 = 1 / std of the one-pole filtered noise below
    let texL = this.texL;
    let texR = this.texR;
    const windOn = gWindT > 1e-5 || gWd > 1e-5;
    let pos = this.pos;
    let cnt = this.evCnt;

    for (let i = 0; i < len; i++) {
      if (--cnt <= 0) {
        if (this.total > 0) {
          this.pos = pos;
          this.spawn();
        }
        cnt = this.pickGap();
      }
      gHi += dHi;
      gLo += dLo;
      gWd += dWd;
      mL += dmL;
      mR += dmR;
      gOut += gOutStep;
      const nL = rng.s2();
      const nR = rng.s2();
      aL.step(nL);
      aR.step(nR);
      bL.step(nL);
      bR.step(nR);
      texL += 0.02 * (nR - texL);
      texR += 0.02 * (nL - texR);
      const modL = 1 + tex * texL;
      const modR = 1 + tex * texR;
      let l = aL.bpn * gHi * (modL < 0.15 ? 0.15 : modL) + bL.bpn * gLo;
      let rr = aR.bpn * gHi * (modR < 0.15 ? 0.15 : modR) + bR.bpn * gLo;
      if (windOn) {
        wL.step(nL);
        wR.step(nR);
        l += wL.bpn * gWd;
        rr += wR.bpn * gWd;
      }
      l *= mL;
      rr *= mR;
      const q = pos & MASK;
      l += accL[q];
      rr += accR[q];
      accL[q] = 0;
      accR[q] = 0;
      pos++;
      if (anyThunder) {
        l += tL[i];
        rr += tR[i];
      }
      outL[o + i] = l * gOut;
      outR[o + i] = rr * gOut;
    }
    this.pos = pos & 0x3fffffff;
    this.evCnt = cnt;
    this.texL = texL;
    this.texR = texR;
  }
}
