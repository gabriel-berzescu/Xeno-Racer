/**
 * ChassisVoice — everything a car makes that is not the engine:
 *   - tire squeal x4 (scrub / tonal squeal / ragged howl, per-wheel pitch and stereo position)
 *   - rolling noise by surface (asphalt roar + tread whine, curb pulse train, gravel crunch,
 *     grass swish, sand hiss, dirt), blended by how many wheels are on each surface
 *   - wind (speed^2, gusts, mirror whistle), suspension thumps, metal scrape grinding
 *   - impacts: modal metal/plastic crunch + body thump + glass tinkle (pool of 3)
 *   - wet road (wet > 0): tire hiss, spray wash, puddle splashes and wheelspin slush (WetRoad), the dry road roar
 *     and the tonal squeal easing off. With wet = 0 none of it runs and the output is exactly the dry sound.
 *
 * Player mode renders stereo (decorrelated noise, wheel-position panning); lite mode (opponents)
 * renders a cheap mono mix. No allocation after construction.
 */
import { CTL, TIRE_STRIDE } from '../controls';
import { makeWetRoadLevels, wetRoad } from '../weather-model';
import { Resonator, SVF } from './filters';
import { Rng, TAU, clamp, clamp01, lerp, sinCyc, smoothCoef, smoothstep, wrap1 } from './util';
import { WetRoad } from './wet-road';

export const SURF = { HARD: 0, CURB: 1, GRASS: 2, GRAVEL: 3, SAND: 4, DIRT: 5 } as const;

export interface ChassisInputs {
  speed: number;
  gain: number;
  interior: number;
  airborne: number;
  scrape: number;
  /** hard, curb, grass, gravel, sand, dirt (fractions of wheels, 0..1). */
  surf: Float32Array;
  curb: Float32Array;
  /** per wheel: scrub, tone, howl, pitch */
  tire: Float32Array;
  thumpCount: number;
  thumpStrength: number;
  thumpPan: number;
  impactCount: number;
  impactStrength: number;
  impactKind: number;
  impactPan: number;
  /** 0 off, 1 lite, 2 full. */
  quality: number;
  /** Water on the track 0..1. */
  wet: number;
  /** Per wheel wheelspin / lock-up slush on a wet road. */
  slush: Float32Array;
}

export function makeChassisInputs(): ChassisInputs {
  const t = new Float32Array(16);
  for (let w = 0; w < 4; w++) t[w * TIRE_STRIDE + 3] = 1000;
  return {
    speed: 0,
    gain: 1,
    interior: 0,
    airborne: 0,
    scrape: 0,
    surf: new Float32Array([1, 0, 0, 0, 0, 0]),
    curb: new Float32Array(4),
    tire: t,
    thumpCount: 0,
    thumpStrength: 0,
    thumpPan: 0,
    impactCount: 0,
    impactStrength: 0,
    impactKind: 0,
    impactPan: 0,
    quality: 2,
    wet: 0,
    slush: new Float32Array(4),
  };
}

function fin(x: number, d: number): number {
  return Number.isFinite(x) ? x : d;
}

export function readChassisInputs(v: Float32Array, o: ChassisInputs): void {
  o.speed = clamp(fin(v[CTL.SPEED], 0), 0, 200);
  o.gain = Math.max(0, fin(v[CTL.CH_GAIN], 1));
  o.interior = clamp01(fin(v[CTL.CH_INTERIOR], 0));
  o.airborne = clamp01(fin(v[CTL.AIRBORNE], 0));
  o.scrape = clamp01(fin(v[CTL.SCRAPE], 0));
  for (let i = 0; i < 6; i++) o.surf[i] = clamp01(fin(v[CTL.SURF_HARD + i], 0));
  for (let i = 0; i < 4; i++) o.curb[i] = clamp01(fin(v[CTL.CURB_FL + i], 0));
  for (let i = 0; i < 16; i++) o.tire[i] = fin(v[CTL.TIRE0 + i], o.tire[i]);
  o.thumpCount = v[CTL.THUMP_COUNT];
  o.thumpStrength = clamp01(fin(v[CTL.THUMP_STRENGTH], 0));
  o.thumpPan = clamp(fin(v[CTL.THUMP_PAN], 0), -1, 1);
  o.impactCount = v[CTL.IMPACT_COUNT];
  o.impactStrength = Math.max(0, fin(v[CTL.IMPACT_STRENGTH], 0));
  o.impactKind = fin(v[CTL.IMPACT_KIND], 0);
  o.impactPan = clamp(fin(v[CTL.IMPACT_PAN], 0), -1, 1);
  o.quality = fin(v[CTL.CH_QUALITY], 2);
  o.wet = clamp01(fin(v[CTL.WET], 0));
  for (let i = 0; i < 4; i++) o.slush[i] = clamp(fin(v[CTL.SLUSH0 + i], 0), 0, 1.5);
}

/** Map a physics impact strength (assumed closing speed in m/s) to 0..1. */
export function impactNorm(strength: number): number {
  return clamp01(1 - Math.exp(-Math.max(strength, 0) / 16));
}

const WHEEL_PAN = [-0.5, 0.5, -0.4, 0.4];
/** Output scale of the impact synth (peaks land near -2 dBFS for a 28 m/s crash). */
const IMPACT_GAIN = 0.48;
const MODE_RATIO = [1, 1.59, 2.14, 2.65, 3.16, 3.6, 4.3, 5.1];
const MODE_DECAY = [0.3, 0.22, 0.16, 0.12, 0.09, 0.07, 0.05, 0.04];
const MODE_AMP = [0.9, 0.8, 0.7, 0.55, 0.45, 0.35, 0.25, 0.2];
const N_MODES = 8;
const N_GLASS = 6;
const N_GRAINS = 10;
const N_PINGS = 20;

class ImpactVoice {
  active = false;
  pan = 0;
  age = 0;
  life = 0;
  modes: Resonator[] = [];
  glass: Resonator[] = [];
  pend = new Float64Array(N_MODES);
  grT = new Int32Array(N_GRAINS);
  grA = new Float64Array(N_GRAINS);
  grN = 0;
  grI = 0;
  grEnv = 0;
  grK = 0.99;
  svfCrunch = new SVF();
  svfGrit = new SVF();
  piT = new Int32Array(N_PINGS);
  piF = new Float64Array(N_PINGS);
  piA = new Float64Array(N_PINGS);
  piD = new Float64Array(N_PINGS);
  piN = 0;
  piI = 0;
  glassRR = 0;
  thumpPh = 0;
  thumpF = 80;
  thumpEnv = 0;
  thumpK = 0.9998;
  thumpDrop = 0.9999;
  thumpAmp = 0;
  gritAmp = 0;
  crunchAmp = 0;
  constructor() {
    for (let i = 0; i < N_MODES; i++) this.modes.push(new Resonator());
    for (let i = 0; i < N_GLASS; i++) this.glass.push(new Resonator());
  }
}

export class ChassisVoice {
  readonly inp = makeChassisInputs();
  private rng: Rng;
  private readonly sr: number;
  private asleep = false;
  private firstBlock = true;

  // smoothed inputs
  private sSpeed = 0;
  private sGain = 0;
  private sInt = 0;
  private sAir = 0;
  private sScrape = 0;
  private sSurf = new Float64Array(6);
  private sCurb = new Float64Array(4);
  private sTire = new Float64Array(16);
  private pTire = new Float64Array(16);
  private pSurf = new Float64Array(6);
  private pScrape = 0;
  private pAir = 0;
  private lastThump = 0;
  private lastImpact = 0;
  private lastGain = 0;
  private lastSpeed = 0;

  // wet road
  private wet: WetRoad;
  private wetLv = makeWetRoadLevels();
  private sWet = 0;
  private sSlush = new Float64Array(4);
  /** Cutoff the scrub band-passes are currently set to (2400 Hz = the dry setting). */
  private scrubFc = 2400;

  // tires
  private tPh = new Float64Array(4);
  private tRw = new Float64Array(4);
  private tRwT = new Float64Array(4);
  private tAm = new Float64Array(4);
  private svfScrub: SVF[] = [];
  private svfHowl: SVF[] = [];
  private howlLp = new Float64Array(4);

  // road / surfaces / wind
  private svfRoadL = new SVF();
  private svfRoadR = new SVF();
  private svfHumL = new SVF();
  private svfHumR = new SVF();
  private svfGravel = new SVF();
  private svfGrass = new SVF();
  private svfSand = new SVF();
  private svfDirt = new SVF();
  private svfWindL = new SVF();
  private svfWindR = new SVF();
  private svfWhistle = new SVF();
  private grassMod = 0;
  private grassModT = 0;
  private gravelEnv = 0;
  private gravelEnv2 = 0;
  private treadPh = 0;
  private gust = 0;
  private gustT = 0;
  private gust2 = 0;

  // curb
  private curbPh = new Float64Array(4);
  private curbRes: Resonator[] = [];
  private curbIn = new Float64Array(2);
  private svfCurb = new SVF();
  private curbTick = 0;

  // thumps
  private thumpRes1 = new Resonator();
  private thumpRes2 = new Resonator();
  private thumpIn = 0;
  private thumpPan = 0;
  private thumpNoise = 0;
  private svfThump = new SVF();

  // scrape
  private svfScr1 = new SVF();
  private svfScr2 = new SVF();
  private svfScr3 = new SVF();
  private svfScrLo = new SVF();
  private scrGate = 0;
  private scrGateT = 0;
  private scrSpark = 0;

  // impacts
  private imp: ImpactVoice[] = [];
  private impRR = 0;

  constructor(sr: number, seed = 1) {
    this.sr = sr;
    this.rng = new Rng(seed * 104729 + 5);
    for (let i = 0; i < 4; i++) {
      const a = new SVF();
      a.set(2400, 0.9, sr);
      this.svfScrub.push(a);
      const b = new SVF();
      b.set(1300, 2.2, sr);
      this.svfHowl.push(b);
      this.tPh[i] = this.rng.u();
      this.curbPh[i] = this.rng.u();
    }
    for (let i = 0; i < 2; i++) {
      const r = new Resonator();
      r.set(118 + i * 14, 0.04, sr);
      this.curbRes.push(r);
    }
    this.svfCurb.set(900, 1.4, sr);
    this.thumpRes1.set(72, 0.09, sr);
    this.thumpRes2.set(165, 0.05, sr);
    this.svfThump.set(320, 0.8, sr);
    this.svfGravel.set(2300, 1.1, sr);
    this.svfGrass.set(750, 0.7, sr);
    this.svfSand.set(520, 0.7, sr);
    this.svfDirt.set(1500, 0.9, sr);
    this.svfHumL.set(85, 1.4, sr);
    this.svfHumR.set(95, 1.4, sr);
    this.svfScr1.set(900, 7, sr);
    this.svfScr2.set(1900, 6, sr);
    this.svfScr3.set(3600, 5, sr);
    this.svfScrLo.set(260, 2, sr);
    for (let i = 0; i < 3; i++) this.imp.push(new ImpactVoice());
    this.wet = new WetRoad(sr, seed + 31);
  }

  reset(): void {
    for (const r of this.curbRes) r.reset();
    this.thumpRes1.reset();
    this.thumpRes2.reset();
    for (const v of this.imp) {
      v.active = false;
      for (const m of v.modes) m.reset();
      for (const m of v.glass) m.reset();
    }
    this.gravelEnv = this.gravelEnv2 = this.thumpNoise = this.thumpIn = 0;
    this.wet.reset();
  }

  /** Render n samples. outR = null -> mono (lite) mix into outL. */
  process(outL: Float32Array, outR: Float32Array | null, n: number, offset = 0): void {
    let done = 0;
    while (done < n) {
      const len = Math.min(128, n - done);
      this.block(outL, outR, offset + done, len);
      done += len;
    }
  }

  private triggerImpact(kindIn: number, strength: number, pan: number): void {
    const sr = this.sr;
    const rng = this.rng;
    const s = impactNorm(strength);
    if (s < 0.015) return;
    // pick a free voice or steal the oldest
    let v: ImpactVoice | null = null;
    for (let k = 0; k < this.imp.length; k++) {
      const c = this.imp[(this.impRR + k) % this.imp.length];
      if (!c.active) {
        v = c;
        break;
      }
    }
    if (!v) {
      let oldest = this.imp[0];
      for (const c of this.imp) if (c.age > oldest.age) oldest = c;
      v = oldest;
    }
    this.impRR = (this.impRR + 1) % this.imp.length;
    const kind = Math.round(kindIn); // 0 wall, 1 car, 2 ground
    v.active = true;
    v.pan = pan;
    v.age = 0;
    const base = kind === 1 ? 320 + rng.u() * 380 : kind === 2 ? 110 + rng.u() * 150 : 170 + rng.u() * 250;
    const decScale = (kind === 1 ? 0.55 : kind === 2 ? 0.8 : 1) * (0.55 + 0.9 * s);
    const modeAmp = kind === 1 ? 0.55 : kind === 2 ? 0.35 : 0.8;
    for (let k = 0; k < N_MODES; k++) {
      const f = base * MODE_RATIO[k] * (0.97 + 0.06 * rng.u());
      v.modes[k].reset();
      v.modes[k].set(Math.min(f, sr * 0.4), MODE_DECAY[k] * decScale, sr);
      v.pend[k] = Math.pow(s, 1.3) * modeAmp * MODE_AMP[k] * (0.7 + 0.6 * rng.u());
      for (const g of v.glass) g.reset();
    }
    // body thump
    v.thumpPh = 0;
    v.thumpF = (kind === 1 ? 110 : 85) * (0.9 + 0.2 * rng.u());
    v.thumpEnv = 1;
    v.thumpK = Math.exp(-1 / (sr * (0.1 + 0.08 * s)));
    v.thumpDrop = Math.exp(-1 / (sr * 0.07));
    v.thumpAmp = (kind === 1 ? 0.35 : 0.9) * Math.pow(s, 1.0);
    // crunch grains: clusters of band-limited noise bursts
    const nG = Math.min(N_GRAINS, 2 + Math.floor(s * 8));
    v.grN = nG;
    v.grI = 0;
    let t = 0;
    for (let k = 0; k < nG; k++) {
      v.grT[k] = Math.floor(t * sr);
      v.grA[k] = (0.5 + 0.5 * rng.u()) * (1 - 0.5 * (k / nG));
      t += (0.004 + 0.03 * rng.u()) * (kind === 2 ? 1.5 : 1);
    }
    v.svfCrunch.reset();
    v.svfCrunch.set(kind === 1 ? 900 + rng.u() * 1100 : 1500 + rng.u() * 2200, 1.0, sr);
    v.svfGrit.reset();
    v.svfGrit.set(kind === 2 ? 450 : 700, 0.9, sr);
    v.grEnv = 0;
    v.grK = Math.exp(-1 / (sr * (kind === 1 ? 0.016 : 0.011)));
    v.crunchAmp = (kind === 1 ? 0.95 : 0.7) * Math.pow(s, 1.1);
    v.gritAmp = (kind === 2 ? 0.6 : 0.3) * s;
    // glass tinkle on big hits
    v.piN = 0;
    v.piI = 0;
    if (kind !== 2 && s > (kind === 1 ? 0.55 : 0.42)) {
      const nP = Math.min(N_PINGS, 6 + Math.floor((s - 0.4) * 24));
      v.piN = nP;
      let tt = 0.012;
      for (let k = 0; k < nP; k++) {
        v.piT[k] = Math.floor(tt * sr);
        v.piF[k] = 3200 + rng.u() * 5600;
        v.piA[k] = (0.08 + 0.15 * rng.u()) * (0.6 + 0.6 * s);
        v.piD[k] = 0.012 + 0.05 * rng.u();
        tt += 0.004 + 0.03 * rng.u() * (1 + k * 0.12);
      }
    }
    v.life = Math.floor(sr * (0.5 + 1.0 * s));
  }

  private block(outL: Float32Array, outR: Float32Array | null, o: number, len: number): void {
    const I = this.inp;
    const sr = this.sr;
    const invSr = 1 / sr;
    const dt = len * invSr;
    const rng = this.rng;
    const full = I.quality >= 1.5;
    const stereo = outR !== null;

    // ── sleep ────────────────────────────────────────────────────────────────
    const gainPrev = this.sGain;
    if (this.firstBlock) {
      this.sGain = I.gain;
      this.sSpeed = I.speed;
      this.sInt = I.interior;
      this.sAir = I.airborne;
      this.sScrape = I.scrape;
      for (let i = 0; i < 6; i++) this.sSurf[i] = I.surf[i];
      for (let i = 0; i < 4; i++) this.sCurb[i] = I.curb[i];
      for (let i = 0; i < 16; i++) this.sTire[i] = I.tire[i];
      this.pTire.set(this.sTire);
      this.pSurf.set(this.sSurf);
      this.pScrape = this.sScrape;
      this.pAir = this.sAir;
      this.lastThump = I.thumpCount;
      this.lastImpact = I.impactCount;
      this.lastSpeed = this.sSpeed;
      this.lastGain = this.sGain;
      this.sWet = I.wet;
      for (let w = 0; w < 4; w++) this.sSlush[w] = I.slush[w];
    } else this.sGain += smoothCoef(0.02, dt) * (I.gain - this.sGain);
    const gainNow = this.sGain;
    if (I.quality < 0.5 || (I.gain < 1e-4 && gainNow < 1e-4)) {
      for (let i = 0; i < len; i++) {
        outL[o + i] = 0;
        if (outR) outR[o + i] = 0;
      }
      this.asleep = true;
      return;
    }
    if (this.asleep) {
      this.reset();
      this.asleep = false;
    }
    const first = this.firstBlock;
    this.firstBlock = false;

    // ── smoothing ────────────────────────────────────────────────────────────
    this.sSpeed += smoothCoef(0.04, dt) * (I.speed - this.sSpeed);
    this.sInt += smoothCoef(0.06, dt) * (I.interior - this.sInt);
    this.sAir += smoothCoef(0.03, dt) * (I.airborne - this.sAir);
    this.sScrape += smoothCoef(0.025, dt) * (I.scrape - this.sScrape);
    const kS = smoothCoef(0.04, dt);
    for (let i = 0; i < 6; i++) {
      this.pSurf[i] = this.sSurf[i];
      this.sSurf[i] += kS * (I.surf[i] - this.sSurf[i]);
    }
    const kC = smoothCoef(0.012, dt);
    for (let i = 0; i < 4; i++) this.sCurb[i] += kC * (I.curb[i] - this.sCurb[i]);
    const kT = smoothCoef(0.018, dt);
    const kP = smoothCoef(0.03, dt);
    for (let w = 0; w < 4; w++) {
      const b = w * TIRE_STRIDE;
      this.pTire[b] = this.sTire[b];
      this.pTire[b + 1] = this.sTire[b + 1];
      this.pTire[b + 2] = this.sTire[b + 2];
      this.pTire[b + 3] = this.sTire[b + 3];
      this.sTire[b] += kT * (I.tire[b] - this.sTire[b]);
      this.sTire[b + 1] += kT * (I.tire[b + 1] - this.sTire[b + 1]);
      this.sTire[b + 2] += kT * (I.tire[b + 2] - this.sTire[b + 2]);
      this.sTire[b + 3] += kP * (I.tire[b + 3] - this.sTire[b + 3]);
    }
    this.sWet += smoothCoef(0.35, dt) * (I.wet - this.sWet);
    const kSl = smoothCoef(0.03, dt);
    for (let w = 0; w < 4; w++) this.sSlush[w] += kSl * (I.slush[w] - this.sSlush[w]);

    // events
    if (I.thumpCount !== this.lastThump) {
      this.lastThump = I.thumpCount;
      this.thumpIn += I.thumpStrength;
      this.thumpPan = I.thumpPan;
      this.thumpNoise = Math.max(this.thumpNoise, I.thumpStrength);
    }
    if (I.impactCount !== this.lastImpact) {
      this.lastImpact = I.impactCount;
      this.triggerImpact(I.impactKind, I.impactStrength, I.impactPan);
    }

    const sB = this.sSpeed;
    const speed = sB;
    const sN = clamp(speed / 70, 0, 1.4);
    const sI = this.sInt;
    const invLen = 1 / len;

    // category gains (ext, int)
    const gTire = lerp(0.85, 1.0, sI);
    const gRoad = lerp(0.6, 1.0, sI);
    const gWind = lerp(0.8, 0.55, sI);
    const gHit = lerp(1.0, 1.15, sI);
    const roadAir = 1 - 0.9 * this.sAir;

    // filter updates (block rate)
    const fcRoad = (180 + 950 * Math.min(sN, 1)) * lerp(1.0, 0.72, sI);
    this.svfRoadL.set(fcRoad, 0.7, sr);
    this.svfRoadR.set(fcRoad, 0.7, sr);
    const fcWind = (320 + 1900 * Math.min(sN, 1.2)) * lerp(1, 0.6, sI);
    this.svfWindL.set(fcWind, 0.7, sr);
    this.svfWindR.set(fcWind, 0.7, sr);
    const whistleF = 900 + 1700 * Math.min(sN, 1.2);
    this.svfWhistle.set(whistleF, 14, sr);
    this.svfGravel.set(1900 + 900 * Math.min(sN, 1), 1.1, sr);
    // gust
    this.gustT += (rng.s2() - this.gustT) * smoothCoef(0.4, dt);
    this.gust += (this.gustT - this.gust) * smoothCoef(0.25, dt);
    this.gust2 += (rng.s2() - this.gust2) * smoothCoef(0.06, dt);
    const gustF = 1 + 0.45 * this.gust + 0.12 * this.gust2;
    // grass swish modulation target
    this.grassModT += (rng.u() - this.grassModT) * smoothCoef(0.05, dt);
    this.grassMod += (this.grassModT - this.grassMod) * smoothCoef(0.08, dt);

    // levels (ramped)
    const wHard = this.sSurf[SURF.HARD];
    const wCurb = this.sSurf[SURF.CURB];
    const wGrass = this.sSurf[SURF.GRASS];
    const wGravel = this.sSurf[SURF.GRAVEL];
    const wSand = this.sSurf[SURF.SAND];
    const wDirt = this.sSurf[SURF.DIRT];
    // wet road: only wheels on pavement carry a film for the squeal; every surface throws some spray
    const wetNow = this.sWet;
    const wT = wetNow > 0.002 ? wetNow * Math.min(1, wHard + 0.9 * wCurb) : 0;
    let wetCut = 0;
    const wetVoice = this.wet;
    const wetActive = wetNow > 0.002 || wetVoice.on;
    if (wetActive) {
      const paved = wHard + 0.8 * wCurb + 0.22 * wGrass + 0.12 * wGravel + 0.1 * wSand + 0.28 * wDirt;
      wetRoad(wetNow > 0.002 ? wetNow : 0, paved, speed, sI, this.wetLv);
      wetCut = this.wetLv.roarCut;
      wetVoice.prepare(this.wetLv, this.sSlush, speed / 2.1, len);
    }
    const wetOn = wetActive && wetVoice.on;
    // wet squeal: a duller tone (fewer harmonics) and a lower, softer scrub band
    const h2w = 0.5 - 0.35 * wT;
    const h3w = 0.26 - 0.234 * wT;
    const h2l = 0.45 - 0.315 * wT;
    const fcS = wT > 0.002 ? 2400 - 700 * wT : 2400;
    if (fcS !== this.scrubFc && (fcS === 2400 || Math.abs(fcS - this.scrubFc) > 2)) {
      for (let w = 0; w < 4; w++) this.svfScrub[w].set(fcS, 0.9, sr);
      this.scrubFc = fcS;
    }
    const roadLevel = (wHard + 0.6 * wCurb) * 0.2 * Math.pow(sN, 1.35) * roadAir * gRoad * (1 - wetCut);
    const humLevel = full ? (wHard + wCurb) * 0.11 * sN * roadAir * gRoad : 0;
    const treadHz = Math.min(5200, speed / 0.026);
    const treadLevel = full ? (wHard + wCurb * 0.5) * 0.006 * smoothstep(8, 40, speed) * roadAir * gRoad * (1 - 1.5 * wetCut) : 0;
    const gravelLevel = (wGravel + 0.55 * wDirt) * 0.4 * Math.pow(sN, 0.9) * roadAir;
    const grassLevel = (wGrass + 0.4 * wDirt) * 0.3 * Math.pow(sN, 1.1) * roadAir;
    const sandLevel = wSand * 0.26 * Math.pow(sN, 1.0) * roadAir;
    const windLevel = full ? 0.5 * sN * sN * gustF * gWind : 0;
    const whistleLevel = full ? 0.045 * smoothstep(0.5, 1.1, sN) * gWind : 0;
    const gravelRate = (140 + 11 * speed) * invSr;
    const curbStep = speed / 0.45 * invSr;
    const curbAmp = Math.pow(clamp(speed / 40, 0, 1.3), 0.7) * 0.24 * gHit;
    const scrapeLevel = this.sScrape * 0.5 * gHit;
    const scrapeSpeedMod = 0.8 + 0.5 * Math.min(sN, 1);
    this.svfScr1.set(900 * scrapeSpeedMod, 7, sr);
    this.svfScr2.set(1900 * scrapeSpeedMod, 6, sr);
    this.svfScr3.set(3600 * (0.85 + 0.3 * sN), 5, sr);
    this.svfScrLo.set(240 * scrapeSpeedMod, 2, sr);
    this.scrGateT += (rng.u() - this.scrGateT) * smoothCoef(0.012, dt);
    const wheelRot = speed / 2.1;

    const gOutPrev = first ? gainNow : gainPrev;
    const gOutStep = (gainNow - gOutPrev) * invLen;
    let gOut = gOutPrev;

    // thump / impacts accumulators are per sample below
    const thumpGainL = Math.cos(((this.thumpPan + 1) * Math.PI) / 4);
    const thumpGainR = Math.sin(((this.thumpPan + 1) * Math.PI) / 4);

    for (let i = 0; i < len; i++) {
      const fr = (i + 1) * invLen;
      gOut += gOutStep;
      // white noise sources (L, R decorrelated)
      const nL = rng.s2();
      const nR = stereo ? rng.s2() : nL;
      let mixL = 0;
      let mixR = 0;

      // ── tires ──────────────────────────────────────────────────────────────
      if (full) {
        for (let w = 0; w < 4; w++) {
          const b = w * TIRE_STRIDE;
          const sc = this.pTire[b] + (this.sTire[b] - this.pTire[b]) * fr;
          const to = this.pTire[b + 1] + (this.sTire[b + 1] - this.pTire[b + 1]) * fr;
          const ho = this.pTire[b + 2] + (this.sTire[b + 2] - this.pTire[b + 2]) * fr;
          if (sc < 0.002 && to < 0.002 && ho < 0.002) continue;
          const pitch = this.pTire[b + 3] + (this.sTire[b + 3] - this.pTire[b + 3]) * fr;
          // wobble: random walk updated at block rate, smoothed per sample
          if (i === 0) this.tRwT[w] = rng.s2();
          this.tRw[w] += (this.tRwT[w] - this.tRw[w]) * 0.012;
          const wob = 1 + (0.012 + 0.07 * ho) * this.tRw[w];
          this.howlLp[w] += (rng.s2() - this.howlLp[w]) * 0.02;
          let ph = this.tPh[w] + (pitch * wob) * invSr;
          if (ph >= 1) ph -= 1;
          this.tPh[w] = ph;
          const s1 = sinCyc(ph);
          const c1 = sinCyc(ph >= 0.75 ? ph - 0.75 : ph + 0.25);
          const s2 = 2 * s1 * c1;
          const s3 = 3 * s1 - 4 * s1 * s1 * s1;
          const tone = s1 + h2w * s2 + h3w * s3;
          this.tAm[w] += wheelRot * invSr * (1 + 0.04 * w);
          if (this.tAm[w] >= 1) this.tAm[w] -= 1;
          const am = 1 + 0.18 * sinCyc(this.tAm[w]) + 0.1 * this.tRw[w];
          const hMod = 1 + 0.9 * ho * this.howlLp[w] * 3;
          const scr = this.svfScrub[w].step(rng.s2());
          const how = this.svfHowl[w].step(rng.s2());
          const v =
            (tone * 0.17 * to * am + tone * 0.07 * ho * hMod + scr * 0.22 * sc * (0.85 + 0.3 * am) + how * 0.5 * ho) * gTire;
          const pan = WHEEL_PAN[w];
          mixL += v * (0.5 + 0.5 * (1 - (pan + 1) * 0.5)) * (1.1 - 0.1 * w * 0);
          mixR += v * (0.5 + 0.5 * (pan + 1) * 0.5);
        }
      } else {
        // composite single voice from the four wheels
        let sc = 0;
        let to = 0;
        let ho = 0;
        let pw = 0;
        let ps = 0;
        for (let w = 0; w < 4; w++) {
          const b = w * TIRE_STRIDE;
          sc = Math.max(sc, this.sTire[b]);
          to = Math.max(to, this.sTire[b + 1]);
          ho = Math.max(ho, this.sTire[b + 2]);
          pw += this.sTire[b + 1] + 0.01;
          ps += (this.sTire[b + 1] + 0.01) * this.sTire[b + 3];
        }
        if (sc > 0.003 || to > 0.003 || ho > 0.003) {
          const pitch = ps / pw;
          if (i === 0) this.tRwT[0] = rng.s2();
          this.tRw[0] += (this.tRwT[0] - this.tRw[0]) * 0.012;
          let ph = this.tPh[0] + (pitch * (1 + (0.012 + 0.07 * ho) * this.tRw[0])) * invSr;
          if (ph >= 1) ph -= 1;
          this.tPh[0] = ph;
          const s1 = sinCyc(ph);
          const tone = s1 + h2l * sinCyc(wrap1(ph * 2));
          const scr = this.svfScrub[0].step(nL);
          mixL += (tone * 0.17 * (to + 0.5 * ho) + scr * 0.22 * (sc + 0.5 * ho)) * gTire;
        }
        mixR = mixL;
      }

      // ── rolling noise by surface ────────────────────────────────────────
      if (roadLevel > 1e-5) {
        this.svfRoadL.step(nL);
        if (stereo) this.svfRoadR.step(nR);
        const hl = this.svfHumL.step(nL);
        const hr = stereo ? this.svfHumR.step(nR) : hl;
        mixL += this.svfRoadL.lp * roadLevel * 2.2 + hl * humLevel;
        mixR += (stereo ? this.svfRoadR.lp : this.svfRoadL.lp) * roadLevel * 2.2 + hr * humLevel;
      }
      if (treadLevel > 1e-6) {
        this.treadPh += treadHz * invSr;
        if (this.treadPh >= 1) this.treadPh -= 1;
        const t = sinCyc(this.treadPh) * treadLevel * (0.8 + 0.4 * nL);
        mixL += t;
        mixR += t;
      }
      if (gravelLevel > 1e-5) {
        if (rng.u() < gravelRate) this.gravelEnv = 0.4 + 0.6 * rng.u();
        if (rng.u() < gravelRate * 0.6) this.gravelEnv2 = 0.3 + 0.5 * rng.u();
        const g1 = this.svfGravel.step(nL);
        this.gravelEnv *= 0.9965;
        this.gravelEnv2 *= 0.9985;
        const gr = g1 * (this.gravelEnv * 1.1 + this.gravelEnv2 * 0.4) + this.svfGravel.lp * 0.05;
        const lo = this.svfGrass.step(nR) * 0.2;
        const v = (gr + lo) * gravelLevel;
        mixL += v;
        mixR += stereo ? v * 0.9 + this.svfGravel.bp * 0.0 : v;
      }
      if (grassLevel > 1e-5) {
        const g = this.svfGrass.step(nR);
        const v = this.svfGrass.lp * grassLevel * (0.55 + 0.9 * this.grassMod) * 2.4 + g * 0;
        mixL += v;
        mixR += stereo ? v * 0.85 : v;
      }
      if (sandLevel > 1e-5) {
        this.svfSand.step(nL);
        const v = this.svfSand.lp * sandLevel * 2.0 * (0.7 + 0.6 * this.grassMod);
        mixL += v;
        mixR += v;
      }

      // ── curb pulse train: one thump per ridge, per wheel side ───────────────
      if (full) {
        let cl = 0;
        let cr = 0;
        for (let w = 0; w < 4; w++) {
          const c = this.sCurb[w];
          if (c < 0.01) continue;
          this.curbPh[w] += curbStep;
          if (this.curbPh[w] >= 1) {
            this.curbPh[w] -= 1;
            const a = c * curbAmp * (0.75 + 0.5 * rng.u());
            if (WHEEL_PAN[w] < 0) cl += a;
            else cr += a;
            this.curbTick += a * 0.4;
          }
        }
        const rl = this.curbRes[0].step(cl * 0.55);
        const rr = this.curbRes[1].step(cr * 0.55);
        let tick = 0;
        if (this.curbTick > 1e-4) {
          tick = this.svfCurb.step(nL) * this.curbTick * 0.5;
          this.curbTick *= 0.9965;
        }
        mixL += rl + tick * 0.7;
        mixR += rr + tick * 0.7;
      }

      // ── wind ────────────────────────────────────────────────────────────
      if (windLevel > 1e-5) {
        this.svfWindL.step(nL);
        const wl = this.svfWindL.lp;
        let wr = wl;
        if (stereo) {
          this.svfWindR.step(nR);
          wr = this.svfWindR.lp;
        }
        mixL += wl * windLevel * 1.5;
        mixR += wr * windLevel * 1.5;
        if (whistleLevel > 1e-5) {
          const wh = this.svfWhistle.step(nL) * whistleLevel;
          mixL += wh;
          mixR += wh;
        }
      }

      // ── suspension thump ─────────────────────────────────────────────────
      if (this.thumpIn !== 0 || this.thumpNoise > 1e-4 || this.thumpRes1.y1 > 1e-7 || this.thumpRes1.y1 < -1e-7) {
        const ti = this.thumpIn;
        this.thumpIn = 0;
        let tv = this.thumpRes1.step(ti * 0.5) + this.thumpRes2.step(ti * 0.3);
        if (this.thumpNoise > 1e-4) {
          tv += this.svfThump.step(nR) * this.thumpNoise * 0.35;
          this.thumpNoise *= 0.9985;
        }
        tv *= gHit;
        mixL += tv * thumpGainL * 1.2;
        mixR += tv * thumpGainR * 1.2;
      }

      // ── scrape grinding ──────────────────────────────────────────────────
      if (scrapeLevel > 1e-4) {
        this.scrGate += (this.scrGateT - this.scrGate) * 0.01;
        const gate = 0.45 + 0.9 * this.scrGate;
        const a = this.svfScr1.step(nL) * 1.0 + this.svfScr2.step(nR) * 0.8 + this.svfScr3.step(nL) * 0.55;
        const lo = this.svfScrLo.step(nR) * 0.9;
        let sp = 0;
        if (rng.u() < 0.0015) this.scrSpark = 0.6 * rng.u();
        if (this.scrSpark > 1e-4) {
          sp = nL * this.scrSpark;
          this.scrSpark *= 0.995;
        }
        const v = (a * 0.5 + lo * 0.35 + sp) * gate * scrapeLevel;
        mixL += v * 1.05;
        mixR += v * 0.95;
      }

      // ── impacts ───────────────────────────────────────────────────────────
      for (let k = 0; k < this.imp.length; k++) {
        const v = this.imp[k];
        if (!v.active) continue;
        let x = 0;
        // inject pending mode impulses on the first sample
        if (v.age === 0) {
          for (let m = 0; m < N_MODES; m++) {
            x += v.modes[m].step(v.pend[m]);
          }
        } else {
          for (let m = 0; m < N_MODES; m++) x += v.modes[m].step(0);
        }
        // thump
        if (v.thumpEnv > 1e-4) {
          v.thumpF = 45 + (v.thumpF - 45) * v.thumpDrop;
          v.thumpPh += v.thumpF * invSr;
          if (v.thumpPh >= 1) v.thumpPh -= 1;
          x += sinCyc(v.thumpPh) * v.thumpEnv * v.thumpAmp;
          v.thumpEnv *= v.thumpK;
        }
        // crunch grains
        while (v.grI < v.grN && v.age >= v.grT[v.grI]) {
          v.grEnv = Math.max(v.grEnv, v.grA[v.grI]);
          v.grI++;
        }
        if (v.grEnv > 1e-3) {
          const cr = v.svfCrunch.step(rng.s2());
          const gr = v.svfGrit.step(rng.s2());
          x += (cr * v.crunchAmp * 1.6 + gr * v.gritAmp * 1.2) * v.grEnv;
          v.grEnv *= v.grK;
        }
        // glass pings
        while (v.piI < v.piN && v.age >= v.piT[v.piI]) {
          const g = v.glass[v.glassRR];
          v.glassRR = (v.glassRR + 1) % N_GLASS;
          g.set(v.piF[v.piI], v.piD[v.piI], sr);
          g.step(v.piA[v.piI]);
          v.piI++;
        }
        if (v.piN > 0) for (let g = 0; g < N_GLASS; g++) x += v.glass[g].step(0) * 1.0;
        v.age++;
        x *= gHit * IMPACT_GAIN;
        const pg = ((v.pan + 1) * Math.PI) / 4;
        mixL += x * Math.cos(pg);
        mixR += x * Math.sin(pg);
        if (v.age > v.life) v.active = false;
      }

      if (stereo) {
        outL[o + i] = mixL * gOut;
        outR![o + i] = mixR * gOut;
      } else {
        outL[o + i] = (mixL + mixR) * 0.5 * gOut;
      }
    }
    // wet road: hiss, spray, puddle splashes, wheelspin slush (rendered per block, added with the same gain ramp)
    if (wetOn) wetVoice.render(outL, outR, o, gOutPrev, gOutStep);
    this.lastGain = gainNow;
    this.lastSpeed = sB;
  }
}
