/**
 * WetRoad — what a car adds to its sound on a wet track. Used inside ChassisVoice; costs nothing when the
 * road is dry (the chassis never calls it).
 *
 *   hiss     the sizzle of water squeezed out of the tread, 1-9 kHz, growing steeply with speed
 *   spray    the mid-band wash of water thrown into the wheel arches and behind the car (200-2500 Hz), with a
 *            slow wobble tied to wheel rotation. Opponents driving past make this their "whoosh"
 *   splash   now and then a puddle: a low slap with a swell of spray
 *   slush    wheelspin / lock-up on a wet road: a sloshing, gurgling spray bed instead of a screech
 *
 * The noise comes from two shared, seamlessly looping tables (built once per sample rate, 2^17 samples each),
 * read at a per-car random offset with linear interpolation. The read speed doubles as a brightness control:
 * faster = brighter (finer droplets at speed), slower = duller (the cabin). That makes a wet car a few dozen
 * flops per sample instead of a filter chain, so twelve cars stay cheap. The whole block is rendered in one tight
 * loop (state kept in locals) and added to the chassis output, scaled by the car's output-gain ramp.
 */
import type { WetRoadLevels } from '../weather-model';
import { SVF } from './filters';
import { Rng, TAU, ouStep, sinCyc, smoothCoef } from './util';

const N = 1 << 17;
const MASK = N - 1;
const HALF = N >> 1;

export interface WetTables {
  hiss: Float32Array;
  spray: Float32Array;
}

/** Linear gains: a wet-tire hiss / spray of "level 1" is this many RMS in full scale. */
export const WET_CAL = {
  hiss: 0.12,
  spray: 0.085,
  /** Splash peak relative to the continuous wet noise (hiss + spray level) at that moment. */
  splash: 1.5,
  slush: 0.2,
};

function buildTable(sr: number, seed: number, kind: 'hiss' | 'spray'): Float32Array {
  const rng = new Rng(seed);
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = rng.s2();
  const out = new Float32Array(N);
  const f1 = new SVF();
  let lpA = 0;
  let lpB = 0;
  const kA = 1 - Math.exp((-TAU * 9000) / sr);
  const kB = 1 - Math.exp((-TAU * 3800) / sr);
  const kC = 1 - Math.exp((-TAU * 2800) / sr);
  if (kind === 'hiss') f1.set(1100, 0.7, sr);
  else f1.set(700, 0.5, sr);
  // Settle the filters on the last few thousand samples (the loop's "previous" noise), then render one pass: the
  // table is periodic and the loop point is seamless (the filters' memory is a millisecond or two).
  const PRE = 4096;
  for (let i = -PRE; i < N; i++) {
    const x = w[i < 0 ? N + i : i];
    let y: number;
    if (kind === 'hiss') {
      f1.step(x);
      lpA += kA * (f1.hp - lpA);
      lpB += kB * (lpA - lpB);
      y = 0.55 * lpA + 0.45 * lpB;
    } else {
      // band-pass about 700 Hz, then a one-pole low-pass: a wash that stays out of the hiss's band
      lpA += kC * (f1.step(x) - lpA);
      y = lpA;
    }
    if (i >= 0) out[i] = y;
  }
  let e = 0;
  for (let i = 0; i < N; i++) e += out[i] * out[i];
  const g = 1 / Math.sqrt(e / N + 1e-30);
  for (let i = 0; i < N; i++) out[i] *= g;
  return out;
}

const cache = new Map<number, WetTables>();
/** Shared noise tables (one pair per sample rate and worklet scope). */
export function getWetTables(sr: number): WetTables {
  let t = cache.get(sr);
  if (!t) {
    t = { hiss: buildTable(sr, 0x51ed270b, 'hiss'), spray: buildTable(sr, 0x2c1b3c6d, 'spray') };
    cache.set(sr, t);
  }
  return t;
}

const WHEEL_PAN_L = [0.75, 0.25, 0.7, 0.3];

export class WetRoad {
  /** True while there is anything to render (the chassis skips render() otherwise). */
  on = false;
  private readonly T: WetTables;
  private readonly rng: Rng;
  private readonly sr: number;
  private hPos: number;
  private sPos: number;
  private hStep = 1;
  private sStep = 1;
  private gH = 0;
  private gS = 0;
  private gHt = 0;
  private gSt = 0;
  private amPh = 0;
  private amInc = 0;
  private len = 128;

  // puddle splashes (2 voices)
  private spEnv = new Float64Array(2);
  private spAmp = new Float64Array(2);
  private spK = new Float64Array(2);
  private spPos = new Float64Array(2);
  private spPh = new Float64Array(2);
  private spGL = new Float64Array(2);
  private spGR = new Float64Array(2);
  private spLow = new Float64Array(2);
  private spActive = 0;
  private spRR = 0;

  // wheelspin slush (one source per wheel)
  private slush = new Float64Array(4);
  private slushPrev = new Float64Array(4);
  private slushPos = new Float64Array(4);
  private slosh = new Float64Array(4);
  private sloshPrev = new Float64Array(4);
  private sloshT = new Float64Array(4);
  private slushOn = false;
  // slow drift of the table read speeds (about +-2 %): keeps a steady-speed car from ever repeating the table exactly
  private driftH = 0;
  private driftS = 0;

  constructor(sr: number, seed: number) {
    this.sr = sr;
    this.T = getWetTables(sr);
    this.rng = new Rng(seed * 69069 + 12345);
    this.hPos = Math.floor(this.rng.u() * N);
    this.sPos = Math.floor(this.rng.u() * N);
    for (let w = 0; w < 4; w++) this.slushPos[w] = Math.floor(this.rng.u() * N);
  }

  reset(): void {
    this.gH = this.gS = this.gHt = this.gSt = 0;
    this.spEnv.fill(0);
    this.spActive = 0;
    this.slush.fill(0);
    this.slushPrev.fill(0);
    this.on = false;
  }

  /**
   * Block-rate update. `lv` = target levels from wetRoad(); `slushIn` = per-wheel slush levels (0..1.2, already
   * smoothed); `wheelHz` = wheel rotation frequency; `len` = samples in the block. The car's output gain
   * (LOD fade, pause) is applied by render().
   */
  prepare(lv: WetRoadLevels, slushIn: ArrayLike<number>, wheelHz: number, len: number): void {
    const dt = len / this.sr;
    this.len = len;
    this.gHt = lv.hiss * WET_CAL.hiss;
    this.gSt = lv.spray * WET_CAL.spray;
    const kd = smoothCoef(1.5, dt);
    this.driftH = ouStep(this.driftH, kd, 1, this.rng.u() * 2 - 1);
    this.driftS = ouStep(this.driftS, kd, 1, this.rng.u() * 2 - 1);
    this.hStep = lv.step * (1 + 0.02 * this.driftH);
    this.sStep = lv.step * 0.9 * (1 + 0.02 * this.driftS);
    this.amInc = wheelHz / this.sr;
    // puddle splash
    if (lv.splashRate > 0 && this.rng.u() < lv.splashRate * dt) this.startSplash(lv);
    // slush
    let any = false;
    const kSl = smoothCoef(0.07, dt);
    for (let w = 0; w < 4; w++) {
      this.slushPrev[w] = this.slush[w];
      this.slush[w] = slushIn[w];
      this.sloshPrev[w] = this.slosh[w];
      if (this.slush[w] > 1e-4 || this.slushPrev[w] > 1e-4) any = true;
      // sloshing: the level follows a random target that is re-drawn about eight times a second, smoothed (~70 ms)
      if (this.slush[w] > 1e-4) {
        if (this.rng.u() < dt / 0.12) this.sloshT[w] = this.rng.u();
        this.slosh[w] += (this.sloshT[w] - this.slosh[w]) * kSl;
      }
    }
    this.slushOn = any;
    this.on = this.gHt > 1e-6 || this.gH > 1e-6 || this.gSt > 1e-6 || this.gS > 1e-6 || this.spActive !== 0 || any;
  }

  private startSplash(lv: WetRoadLevels): void {
    const k = this.spRR;
    this.spRR = (this.spRR + 1) % 2;
    const r = this.rng;
    this.spEnv[k] = 0.55 + 0.45 * r.u();
    // a puddle is as loud as the water noise the car is already making, a bit more: it scales with speed and wetness
    this.spAmp[k] = (lv.hiss * WET_CAL.hiss + lv.spray * WET_CAL.spray) * WET_CAL.splash;
    this.spK[k] = Math.exp(-1 / (this.sr * (0.05 + 0.14 * r.u())));
    this.spPos[k] = Math.floor(r.u() * N);
    this.spPh[k] = 0;
    this.spLow[k] = 85 + 55 * r.u();
    const side = r.u() * 2 - 1;
    const a = ((side * 0.7 + 1) * Math.PI) / 4;
    this.spGL[k] = Math.cos(a);
    this.spGR[k] = Math.sin(a);
    this.spActive |= 1 << k;
  }

  /**
   * Add this block's wet sound to outL (and outR for the stereo voice; for the mono voice everything goes to
   * outL) at offset `o`, scaled by the car's output-gain ramp g0 -> g0 + gStep * len.
   */
  render(outL: Float32Array, outR: Float32Array | null, o: number, g0: number, gStep: number): void {
    const len = this.len;
    const inv = 1 / len;
    // wheel-rotation phase at both ends of the block (the spray wobbles with it, the slush pulses with it)
    const ph0 = this.amPh;
    let ph1 = ph0 + this.amInc * len;
    ph1 -= Math.floor(ph1);
    // hiss + spray
    let gH = this.gH;
    let gS = this.gS;
    const dH = (this.gHt - gH) * inv;
    const dS = (this.gSt - gS) * inv;
    if (gH > 1e-7 || gS > 1e-7 || this.gHt > 1e-7 || this.gSt > 1e-7) {
      const H = this.T.hiss;
      const S = this.T.spray;
      let hp = this.hPos;
      let sp = this.sPos;
      const hStep = this.hStep;
      const sStep = this.sStep;
      // evaluated at both ends of the block, interpolated between
      const q0 = ph0 * 2.7;
      const q1 = ph1 * 2.7;
      const am0 = 1 + 0.22 * sinCyc(ph0) + 0.1 * sinCyc(q0 - (q0 | 0));
      const am1 = 1 + 0.22 * sinCyc(ph1) + 0.1 * sinCyc(q1 - (q1 | 0));
      const dAm = (am1 - am0) * inv;
      let am = am0;
      let g = g0;
      if (outR !== null) {
        for (let i = 0; i < len; i++) {
          gH += dH;
          gS += dS;
          am += dAm;
          g += gStep;
          const hi = hp | 0;
          const hf = hp - hi;
          const si = sp | 0;
          const sf = sp - si;
          const hj = hi + HALF;
          const sj = si + HALF;
          const h0 = H[hi & MASK];
          const hl = h0 + hf * (H[(hi + 1) & MASK] - h0);
          const h1 = H[hj & MASK];
          const hr = h1 + hf * (H[(hj + 1) & MASK] - h1);
          const s0 = S[si & MASK];
          const sl = s0 + sf * (S[(si + 1) & MASK] - s0);
          const s1 = S[sj & MASK];
          const sr = s1 + sf * (S[(sj + 1) & MASK] - s1);
          const k = gS * am;
          outL[o + i] += (hl * gH + sl * k) * g;
          outR[o + i] += (hr * gH + sr * k) * g;
          hp += hStep;
          sp += sStep;
          if (hp >= N) hp -= N;
          if (sp >= N) sp -= N;
        }
      } else {
        for (let i = 0; i < len; i++) {
          gH += dH;
          gS += dS;
          am += dAm;
          g += gStep;
          const hi = hp | 0;
          const hf = hp - hi;
          const si = sp | 0;
          const sf = sp - si;
          const h0 = H[hi & MASK];
          const s0 = S[si & MASK];
          const hl = h0 + hf * (H[(hi + 1) & MASK] - h0);
          const sl = s0 + sf * (S[(si + 1) & MASK] - s0);
          outL[o + i] += (hl * gH + sl * gS * am) * g;
          hp += hStep;
          sp += sStep;
          if (hp >= N) hp -= N;
          if (sp >= N) sp -= N;
        }
      }
      this.hPos = hp;
      this.sPos = sp;
    }
    this.gH = this.gHt;
    this.gS = this.gSt;
    if (this.spActive !== 0) this.renderSplashes(outL, outR, o, g0, gStep);
    if (this.slushOn) this.renderSlush(outL, outR, o, g0, gStep, ph0, ph1);
    this.amPh = ph1;
  }

  private renderSplashes(outL: Float32Array, outR: Float32Array | null, o: number, g0: number, gStep: number): void {
    const len = this.len;
    const S = this.T.spray;
    for (let k = 0; k < 2; k++) {
      if ((this.spActive & (1 << k)) === 0) continue;
      let env = this.spEnv[k];
      const kd = this.spK[k];
      let p = this.spPos[k];
      let ph = this.spPh[k];
      const dph = this.spLow[k] / this.sr;
      const gl = this.spGL[k];
      const gr = this.spGR[k];
      const amp = this.spAmp[k];
      let g = g0;
      for (let i = 0; i < len; i++) {
        g += gStep;
        const pi = p | 0;
        const pf = p - pi;
        const a = S[pi & MASK];
        const v = a + pf * (S[(pi + 1) & MASK] - a);
        p += 1.1;
        if (p >= N) p -= N;
        ph += dph;
        if (ph >= 1) ph -= 1;
        // slap (a low thud) then the spray swells out of it
        const x = (v * 0.8 * env + sinCyc(ph) * 0.9 * env * env) * amp * g;
        env *= kd;
        if (outR !== null) {
          outL[o + i] += x * gl;
          outR[o + i] += x * gr;
        } else outL[o + i] += x;
      }
      this.spEnv[k] = env;
      this.spPos[k] = p;
      this.spPh[k] = ph;
      if (env < 1e-4) this.spActive &= ~(1 << k);
    }
  }

  private renderSlush(outL: Float32Array, outR: Float32Array | null, o: number, g0: number, gStep: number, phA: number, phB: number): void {
    const len = this.len;
    const S = this.T.spray;
    const inv = 1 / len;
    for (let w = 0; w < 4; w++) {
      const lv1 = this.slush[w];
      const lv0 = this.slushPrev[w];
      if (lv1 < 1e-4 && lv0 < 1e-4) continue;
      let lv = lv0;
      const dl = (lv1 - lv0) * inv;
      let p = this.slushPos[w];
      const step = 0.78 + 0.1 * w;
      let am = 0.55 + 0.9 * this.sloshPrev[w];
      const dam = (0.9 * (this.slosh[w] - this.sloshPrev[w])) * inv;
      const pl = WHEEL_PAN_L[w];
      // rooster-tail pulses: slow wobble per wheel, interpolated across the block
      const pw0 = phA * (1 + 0.13 * w);
      const pw1 = phB * (1 + 0.13 * w);
      const m0 = 0.75 + 0.25 * sinCyc(pw0 - Math.floor(pw0));
      const m1 = 0.75 + 0.25 * sinCyc(pw1 - Math.floor(pw1));
      const dm = (m1 - m0) * inv;
      let m = m0;
      let g = g0;
      for (let i = 0; i < len; i++) {
        lv += dl;
        m += dm;
        am += dam;
        g += gStep;
        const pi = p | 0;
        const pf = p - pi;
        const a = S[pi & MASK];
        const v = a + pf * (S[(pi + 1) & MASK] - a);
        p += step;
        if (p >= N) p -= N;
        const x = v * lv * WET_CAL.slush * am * m * g;
        if (outR !== null) {
          outL[o + i] += x * pl;
          outR[o + i] += x * (1 - pl);
        } else outL[o + i] += x;
      }
      this.slushPos[w] = p;
    }
  }
}
