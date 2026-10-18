/**
 * Guitar amp and cabinet simulation (and a bass amp), mono in place.
 *
 *   noise gate -> input high-pass ("tight") -> mid boost (screamer-style) -> [2x oversampled: three asymmetric tanh gain
 *   stages with coupling high-/low-pass filters between them] -> tone stack (bass / mid / treble / presence) -> power amp with
 *   sag (compression) -> cabinet (a chain of biquads shaped like a closed-back 4x12 with a dynamic mic).
 *
 * The gain stages are asymmetric (bias per stage) so that even harmonics appear, as in a real tube preamp; the coupling
 * filters keep each stage from saturating on low-frequency mud, which is what makes palm-muted chords stay tight.
 */
import { ANTI_DENORMAL, clamp, dbToLin, tanh3 } from './core';
import { Biquad, BiquadChain } from './filters';
import { Downsampler2x, Upsampler2x } from './delay';

export const CAB_TYPES = ['4x12', '2x12', '1x12', 'bass-8x10', 'bass-1x15', 'none'] as const;
export type CabType = (typeof CAB_TYPES)[number];

export interface AmpParams {
  /** 0 (clean) .. 1 (maximum gain). */
  gain: number;
  /** 0..1: how much low end is cut before the distortion (tight, focused) - 0 = 60 Hz, 1 = 200 Hz. */
  tight: number;
  /** dB, tone stack. */
  bass: number;
  mid: number;
  treble: number;
  presence: number;
  /** 0..1: screamer-style mid boost in front of the amp (push, focus). */
  boost: number;
  /** 0..1: power amp sag (compression and softness on loud notes). */
  sag: number;
  /** dB: noise-gate threshold (-90 = off). */
  gate: number;
  /** dB output level. */
  level: number;
  cab: CabType;
  /** -1..1: cabinet brightness (mic position: centre of the cone = brighter). */
  cabBright: number;
}

export const AMP_DEFAULTS: AmpParams = {
  gain: 0.65,
  tight: 0.45,
  bass: 0,
  mid: 1,
  treble: -0.5,
  presence: -1.5,
  boost: 0.4,
  sag: 0.4,
  gate: -62,
  level: 0,
  cab: '4x12',
  cabBright: 0,
};

/** The cabinet: biquad chain, rebuilt when the type or brightness changes. */
export class Cabinet {
  private readonly chain = new BiquadChain(9);
  private type: CabType = 'none';
  private bright = 9;
  constructor(private readonly sr: number) {}
  setup(type: CabType, bright: number): void {
    if (type === this.type && bright === this.bright) return;
    this.type = type;
    this.bright = bright;
    const s = this.chain.stages;
    const sr = this.sr;
    for (const b of s) b.setIdentity();
    switch (type) {
      case '4x12': {
        // closed-back 4x12 with a dynamic mic near the cap edge: a cabinet thump at 110 Hz, a broad dip through the boxy low mids, the
        // speaker's presence rise at 2-3 kHz with a cone-breakup notch above it and a last peak near 5 kHz, then the steep fall of the cone
        const lp = 5700 * Math.pow(2, 0.35 * bright);
        s[0].highpass(70, 0.72, sr);
        s[1].peaking(112, 1.1, 2.5, sr);
        s[2].peaking(330, 0.7, -5.5, sr);
        s[3].peaking(1500, 1.0, 1.0, sr);
        s[4].peaking(2500 * Math.pow(2, 0.15 * bright), 1.1, 3.5 + 1.5 * bright, sr);
        s[5].peaking(3500, 4.0, -3.5, sr);
        s[6].peaking(4900, 2.2, 1.5, sr);
        s[7].lowpass(lp, 0.6, sr);
        s[8].lowpass(lp * 1.6, 0.7, sr); // the cone stops radiating: no fizz above 10 kHz
        break;
      }
      case '2x12': {
        const lp = 5900 * Math.pow(2, 0.35 * bright);
        s[0].highpass(88, 0.72, sr);
        s[1].peaking(130, 1.2, 2.5, sr);
        s[2].peaking(500, 0.9, -3, sr);
        s[3].peaking(1900, 1.0, 3, sr);
        s[4].peaking(3100 * Math.pow(2, 0.15 * bright), 1.1, 4 + 1.5 * bright, sr);
        s[5].peaking(4800, 2.4, 2, sr);
        s[6].lowpass(lp, 0.65, sr);
        s[7].lowpass(lp * 1.1, 0.72, sr);
        break;
      }
      case '1x12': {
        const lp = 6300 * Math.pow(2, 0.35 * bright);
        s[0].highpass(105, 0.72, sr);
        s[1].peaking(160, 1.4, 2.5, sr);
        s[2].peaking(650, 0.8, -2.5, sr);
        s[3].peaking(2300, 1.0, 4, sr);
        s[4].peaking(3500 * Math.pow(2, 0.15 * bright), 1.2, 3.5 + 1.5 * bright, sr);
        s[5].peaking(5200, 2.4, 2, sr);
        s[6].lowpass(lp, 0.7, sr);
        s[7].lowpass(lp * 1.1, 0.72, sr);
        break;
      }
      case 'bass-8x10': {
        s[0].highpass(38, 0.72, sr);
        s[1].peaking(95, 1.1, 3, sr);
        s[2].peaking(420, 1.0, -4, sr);
        s[3].peaking(1100, 1.0, 2.5, sr);
        s[4].peaking(2500, 1.2, 2, sr);
        s[5].lowpass(4800 * Math.pow(2, 0.35 * bright), 0.7, sr);
        s[6].lowpass(5400 * Math.pow(2, 0.35 * bright), 0.72, sr);
        break;
      }
      case 'bass-1x15': {
        s[0].highpass(42, 0.72, sr);
        s[1].peaking(80, 1.2, 4, sr);
        s[2].peaking(300, 1.0, -2, sr);
        s[3].peaking(900, 1.0, 1.5, sr);
        s[4].lowpass(3200 * Math.pow(2, 0.35 * bright), 0.7, sr);
        s[5].lowpass(3600 * Math.pow(2, 0.35 * bright), 0.72, sr);
        break;
      }
      default:
        break;
    }
  }
  block(buf: Float64Array, n: number): void {
    if (this.type !== 'none') this.chain.block(buf, n);
  }
  /** Magnitude (linear) at f, for tests and the docs. */
  magnitude(f: number): number {
    return this.type === 'none' ? 1 : this.chain.magnitude(f, this.sr);
  }
}

export class GuitarAmp {
  readonly p: AmpParams;
  private readonly sr: number;
  private readonly up = new Upsampler2x();
  private readonly down = new Downsampler2x();
  private readonly buf2 = new Float64Array(256);
  private readonly cab: Cabinet;
  // coefficients and state (2x rate for the stages)
  private hpIn = 0;
  private hpInK = 0;
  private stageHp = [90, 110, 60];
  private readonly lpS = [0, 0, 0];
  private readonly hpS = [0, 0, 0];
  private readonly dcX = [0, 0, 0];
  private readonly dcY = [0, 0, 0];
  private readonly boostF = new Biquad();
  private readonly lowSh = new Biquad();
  private readonly midPk = new Biquad();
  private readonly highSh = new Biquad();
  private readonly presSh = new Biquad();
  private gateEnv = 0;
  private gateGain = 1;
  private sagEnv = 0;
  private dirty = true;
  private last = { tight: -1, boost: -1, bass: NaN, mid: NaN, treble: NaN, presence: NaN };
  constructor(sr: number, params: Partial<AmpParams> = {}) {
    this.sr = sr;
    this.p = { ...AMP_DEFAULTS, ...params };
    this.cab = new Cabinet(sr);
  }
  setParam(name: keyof AmpParams, v: number | CabType): void {
    (this.p as unknown as Record<string, number | string>)[name] = v;
    this.dirty = true;
  }
  private refresh(): void {
    const p = this.p;
    const l = this.last;
    const sr = this.sr;
    if (p.tight !== l.tight) {
      l.tight = p.tight;
      this.hpInK = 1 - Math.exp((-2 * Math.PI * (30 + 80 * p.tight)) / sr);
      this.stageHp = [50 + 90 * p.tight, 60 + 100 * p.tight, 40 + 60 * p.tight];
    }
    if (p.boost !== l.boost) {
      l.boost = p.boost;
      this.boostF.peaking(780, 0.8, 9 * p.boost, sr);
    }
    if (p.bass !== l.bass) {
      l.bass = p.bass;
      this.lowSh.lowShelf(110, p.bass, sr);
    }
    if (p.mid !== l.mid) {
      l.mid = p.mid;
      this.midPk.peaking(680, 0.75, p.mid, sr);
    }
    if (p.treble !== l.treble) {
      l.treble = p.treble;
      this.highSh.highShelf(3300, p.treble, sr);
    }
    if (p.presence !== l.presence) {
      l.presence = p.presence;
      this.presSh.highShelf(5600, p.presence, sr);
    }
    this.cab.setup(p.cab, p.cabBright);
    this.dirty = false;
  }
  /** Processes buf[0..n) in place (mono). */
  process(buf: Float64Array, n: number): void {
    if (this.dirty) this.refresh();
    const p = this.p;
    const sr = this.sr;
    // ── noise gate (downward expander on the input level) ────────────────────
    if (p.gate > -89) {
      const thr = dbToLin(p.gate);
      const aK = 1 - Math.exp(-1 / (0.0012 * sr));
      const rK = 1 - Math.exp(-1 / (0.045 * sr));
      let env = this.gateEnv;
      let g = this.gateGain;
      for (let i = 0; i < n; i++) {
        const a = buf[i] < 0 ? -buf[i] : buf[i];
        env += (a > env ? aK : rK) * (a - env);
        const q = env / thr;
        const tgt = q >= 1 ? 1 : q * q + 1e-6;
        g += (tgt > g ? 0.02 : 0.004) * (tgt - g);
        buf[i] *= g;
      }
      this.gateEnv = env;
      this.gateGain = g;
    }
    // a tiny Nyquist-rate signal keeps every filter state out of the denormal range when the input is silent
    for (let i = 0; i < n; i++) buf[i] += i & 1 ? 1e-20 : -1e-20;
    // ── input high-pass and boost ────────────────────────────────────────────
    {
      let lp = this.hpIn;
      const k = this.hpInK;
      for (let i = 0; i < n; i++) {
        lp += k * (buf[i] - lp);
        buf[i] -= lp;
      }
      this.hpIn = lp;
      if (p.boost > 0.01) this.boostF.block(buf, n);
    }
    // ── 2x oversampled gain stages ───────────────────────────────────────────
    const A = 16 + 40 * p.gain; // total gain in dB
    const g1 = Math.pow(10, (A * 0.36) / 20);
    const g2 = Math.pow(10, (A * 0.34) / 20);
    const g3 = Math.pow(10, (A * 0.3) / 20);
    const b2 = this.buf2;
    this.up.process(buf, n, b2);
    const sr2 = sr * 2;
    const lpK1 = 1 - Math.exp((-2 * Math.PI * 4800) / sr2);
    const lpK2 = 1 - Math.exp((-2 * Math.PI * 4200) / sr2);
    const lpK3 = 1 - Math.exp((-2 * Math.PI * 5500) / sr2);
    const hpK1 = 1 - Math.exp((-2 * Math.PI * this.stageHp[0]) / sr2);
    const hpK2 = 1 - Math.exp((-2 * Math.PI * this.stageHp[1]) / sr2);
    const hpK3 = 1 - Math.exp((-2 * Math.PI * this.stageHp[2]) / sr2);
    const bias1 = 0.16;
    const bias2 = -0.12;
    const bias3 = 0.08;
    const dc1 = tanh3(bias1);
    const dc2 = tanh3(bias2);
    const dc3 = tanh3(bias3);
    const dcR = 1 - (2 * Math.PI * 22) / sr2;
    const lpS = this.lpS;
    const hpS = this.hpS;
    const dcX = this.dcX;
    const dcY = this.dcY;
    const stage3 = p.gain > 0.35;
    for (let j = 0; j < 2 * n; j++) {
      let x = b2[j];
      // stage 1
      x = tanh3(x * g1 + bias1) - dc1;
      lpS[0] += lpK1 * (x - lpS[0]);
      x = lpS[0];
      hpS[0] += hpK1 * (x - hpS[0]);
      x -= hpS[0];
      // stage 2
      x = tanh3(x * g2 + bias2) - dc2;
      lpS[1] += lpK2 * (x - lpS[1]);
      x = lpS[1];
      hpS[1] += hpK2 * (x - hpS[1]);
      x -= hpS[1];
      // stage 3 (high-gain only)
      if (stage3) {
        x = tanh3(x * g3 * (0.35 + 0.65 * Math.min(1, (p.gain - 0.35) / 0.5)) + bias3) - dc3;
        lpS[2] += lpK3 * (x - lpS[2]);
        x = lpS[2];
        hpS[2] += hpK3 * (x - hpS[2]);
        x -= hpS[2];
      }
      // DC blocker (the asymmetry leaves a little)
      const y = x - dcX[0] + dcR * dcY[0];
      dcX[0] = x;
      dcY[0] = y;
      b2[j] = y;
    }
    this.down.process(b2, n, buf);
    // ── tone stack ───────────────────────────────────────────────────────────
    if (p.bass !== 0) this.lowSh.block(buf, n);
    if (p.mid !== 0) this.midPk.block(buf, n);
    if (p.treble !== 0) this.highSh.block(buf, n);
    if (p.presence !== 0) this.presSh.block(buf, n);
    // ── power amp: sag + soft clip ───────────────────────────────────────────
    {
      const sag = p.sag;
      let env = this.sagEnv;
      const aK = 1 - Math.exp(-1 / (0.004 * sr));
      const rK = 1 - Math.exp(-1 / (0.15 * sr));
      for (let i = 0; i < n; i++) {
        const x = buf[i];
        const a = x < 0 ? -x : x;
        env += (a > env ? aK : rK) * (a - env);
        const g = 1 / (1 + sag * 1.6 * env);
        buf[i] = tanh3(x * g * 1.25) * 0.8 + ANTI_DENORMAL;
      }
      this.sagEnv = env;
    }
    // ── cabinet and level ────────────────────────────────────────────────────
    this.cab.block(buf, n);
    const lv = dbToLin(p.level);
    for (let i = 0; i < n; i++) buf[i] *= lv;
  }
  cabinetMagnitude(f: number): number {
    if (this.dirty) this.refresh();
    return this.cab.magnitude(f);
  }
}

// ── bass amp (DI + a tube-ish preamp + cabinet) ──────────────────────────────

/** Crossover of the bass amp's split drive (Hz): below it the bass stays clean, above it it growls. */
const BASS_SPLIT = 220;

export interface BassAmpParams {
  /** 0..1 overdrive of the preamp. */
  drive: number;
  /** dB tone controls. */
  bass: number;
  mid: number;
  treble: number;
  /** dB output level. */
  level: number;
  cab: CabType;
  /** 0..1: compression amount. */
  comp: number;
}

export class BassAmp {
  readonly p: BassAmpParams;
  private readonly sr: number;
  private readonly cab: Cabinet;
  private readonly up = new Upsampler2x();
  private readonly down = new Downsampler2x();
  private readonly b2 = new Float64Array(256);
  private readonly lowSh = new Biquad();
  private readonly midPk = new Biquad();
  private readonly highSh = new Biquad();
  private readonly hp = new Biquad();
  private env = 0;
  private dcX = 0;
  private dcY = 0;
  private lp = 0;
  private lp2 = 0;
  private dirty = true;
  // the growl: the band above SPLIT Hz is driven on its own, the lows stay clean (the classic split bass rig)
  private readonly split = new Biquad();
  private readonly emph = new Biquad();
  private readonly lo = new Float64Array(256);
  private readonly hi = new Float64Array(256);
  constructor(sr: number, params: Partial<BassAmpParams> = {}) {
    this.sr = sr;
    this.p = { drive: 0.3, bass: 2, mid: 0, treble: 1, level: 0, cab: 'bass-8x10', comp: 0.4, ...params };
    this.cab = new Cabinet(sr);
    this.split.lowpass(BASS_SPLIT, 0.7071, sr);
    this.emph.peaking(1100, 0.9, 8, sr);
  }
  setParam(name: keyof BassAmpParams, v: number | CabType): void {
    (this.p as unknown as Record<string, number | string>)[name] = v;
    this.dirty = true;
  }
  process(buf: Float64Array, n: number): void {
    const p = this.p;
    const sr = this.sr;
    if (this.dirty) {
      this.lowSh.lowShelf(90, p.bass, sr);
      this.midPk.peaking(700, 0.8, p.mid, sr);
      this.highSh.highShelf(2800, p.treble, sr);
      this.hp.highpass(32, 0.72, sr);
      this.cab.setup(p.cab, 0);
      this.dirty = false;
    }
    for (let i = 0; i < n; i++) buf[i] += i & 1 ? 1e-20 : -1e-20;
    this.hp.block(buf, n);
    // compressor: slow envelope gain
    if (p.comp > 0) {
      const aK = 1 - Math.exp(-1 / (0.012 * sr));
      const rK = 1 - Math.exp(-1 / (0.18 * sr));
      let env = this.env;
      for (let i = 0; i < n; i++) {
        const a = buf[i] < 0 ? -buf[i] : buf[i];
        env += (a > env ? aK : rK) * (a - env);
        buf[i] *= 1 / (1 + p.comp * 3 * env);
      }
      this.env = env;
    }
    if (p.drive > 0) {
      // split at BASS_SPLIT Hz: lows + highs = the input exactly
      const lo = this.lo;
      const hi = this.hi;
      for (let i = 0; i < n; i++) {
        lo[i] = this.split.process(buf[i]);
        hi[i] = buf[i] - lo[i];
      }
      // the lows: a gentle tube-ish squash that keeps the fundamental round and solid (no fizz, no flub)
      const gl = 1 + 2.5 * p.drive;
      const nl = 1 / gl;
      for (let i = 0; i < n; i++) lo[i] = tanh3(lo[i] * gl) * nl;
      // the highs: a mid push, then driven hard at 2x oversampling (the growl and the pick clank), tamed by two poles at 3.8 kHz
      this.emph.block(hi, n);
      const g = 2 + 70 * p.drive * p.drive;
      const b2 = this.b2;
      this.up.process(hi, n, b2);
      let lp = this.lp;
      let lp2 = this.lp2;
      const k = 1 - Math.exp((-2 * Math.PI * 3800) / (sr * 2));
      const bias = 0.12;
      const dc = tanh3(bias);
      for (let j = 0; j < 2 * n; j++) {
        const x = tanh3(b2[j] * g + bias) - dc;
        lp += k * (x - lp);
        lp2 += k * (lp - lp2);
        b2[j] = lp2;
      }
      this.lp = lp;
      this.lp2 = lp2;
      this.down.process(b2, n, hi);
      // the driven band comes back at a level that grows with the drive (0.05 = barely there, 0.4 = punk, 0.75 = fuzz)
      const hl = 1.5 * Math.pow(p.drive, 0.8);
      for (let i = 0; i < n; i++) buf[i] = lo[i] + hi[i] * hl;
    }
    if (p.bass !== 0) this.lowSh.block(buf, n);
    if (p.mid !== 0) this.midPk.block(buf, n);
    if (p.treble !== 0) this.highSh.block(buf, n);
    this.cab.block(buf, n);
    const lv = dbToLin(p.level);
    const dcR = 1 - (2 * Math.PI * 20) / sr;
    let dx = this.dcX;
    let dy = this.dcY;
    for (let i = 0; i < n; i++) {
      const y = buf[i] - dx + dcR * dy;
      dx = buf[i];
      dy = y;
      buf[i] = y * lv;
    }
    this.dcX = dx;
    this.dcY = dy;
  }
}

void clamp;
