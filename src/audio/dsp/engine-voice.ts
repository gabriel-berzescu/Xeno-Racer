/**
 * EngineVoice — procedural, physically-structured engine synthesis (mono).
 *
 * Signal flow (all driven by a crank-angle clock, so pitch is exactly rpm * cylinders / 120):
 *
 *   crank phase ──► per-cylinder events (EVO blowdown, combustion peak, valve ticks)
 *        │
 *        ├─ exhaust events ─► impulse accumulators (sub-sample positioned) ─► pulse shapers
 *        │      (fast crack + slow body + pops) ─► header primaries (waveguide pair per equal-length
 *        │      group, closed cylinder end) ─► bank collectors (parallel-junction scattering) ─►
 *        │      secondary pipes (+ turbine loss) ─► merge/X-pipe ─► main pipe ─► muffler (area-step
 *        │      expansion chamber with absorption + quarter-wave stub) ─► tailpipe ─► open-end
 *        │      reflection / radiation (volume-velocity derivative)
 *        ├─ combustion events ─► engine block modes (3 damped resonators)
 *        ├─ intake window table ─► gated, resonated intake noise
 *        └─ valve ticks ─► mechanical clatter
 *   + turbo (spool whistle / flutter / blow-off), gear whine, shift clunk, backfire pops, rev limiter
 *   + interior / exterior mix (cabin resonance, muffled exhaust path)
 *
 * No allocation after construction; process() is safe to call from an AudioWorklet.
 */
import type { EngineSoundProfile } from '../../core/contracts';
import {
  EV_COMBUSTION,
  EV_EXHAUST,
  EV_TICK_INT_CLOSE,
  buildLayout,
  type EngineLayout,
} from './engine-layout';
import { Biquad, DcBlock, DelayLine, OnePole, Resonator, SVF } from './filters';
import { Rng, TAU, clamp, clamp01, lerp, ouStep, sinCyc, smoothCoef, smoothstep, wrap1 } from './util';

/** Live control inputs (targets). The voice smooths them itself. */
export interface EngineInputs {
  rpm: number;
  throttle: number;
  load: number;
  boost: number;
  /** >0.5 = rev limiter cutting. */
  limiter: number;
  /** Counters: any change triggers an event. */
  shiftCount: number;
  backfireCount: number;
  clutch: number;
  idleRpm: number;
  limiterRpm: number;
  redlineRpm: number;
  /** 0 = exterior, 1 = interior. */
  interior: number;
  /** Doppler time scale (1 = none; >1 = approaching). */
  timeScale: number;
  /** Output gain (LOD fades, pause). */
  gain: number;
  /** 0 = off, 1 = lite, 2 = full. */
  quality: number;
  /** Mean wheel angular speed, rad/s (gear whine). */
  driveOmega: number;
  speed: number;
  gear: number;
  /**
   * The driver's throttle pedal 0..1, which the throttle body follows: the ignition cut of a flat upshift and the traction control
   * cut the torque (`throttle`) but leave the throttle open, so they do not blow the turbo's blow-off valve. -1 = not known: the
   * applied throttle stands in for it.
   */
  pedal: number;
}

export function defaultEngineInputs(): EngineInputs {
  return {
    rpm: 900,
    throttle: 0,
    load: 0,
    boost: 0,
    limiter: 0,
    shiftCount: 0,
    backfireCount: 0,
    clutch: 0,
    idleRpm: 900,
    limiterRpm: 7000,
    redlineRpm: 6800,
    interior: 0,
    timeScale: 1,
    gain: 1,
    quality: 2,
    driveOmega: 0,
    speed: 0,
    gear: 1,
    pedal: -1,
  };
}

/** Per-layer taps for the lab / tests (optional; costs one branch per sample). */
export interface EngineDebug {
  exhaust: Float32Array;
  intake: Float32Array;
  mech: Float32Array;
  block: Float32Array;
  turbo: Float32Array;
  whine: Float32Array;
  events: Float32Array;
}
export function createEngineDebug(n: number): EngineDebug {
  return {
    exhaust: new Float32Array(n),
    intake: new Float32Array(n),
    mech: new Float32Array(n),
    block: new Float32Array(n),
    turbo: new Float32Array(n),
    whine: new Float32Array(n),
    events: new Float32Array(n),
  };
}

/** Everything that characterises "this car's" sound, derived from the EngineSoundProfile. */
export interface Voicing {
  // exhaust topology (metres) and area ratios
  Ls: number;
  Lm: number;
  Lc: number;
  Lq: number;
  Lt: number;
  gS: number;
  gM: number;
  rc: number;
  rq: number;
  Rc: number;
  Ro: number;
  Rq: number;
  // loss filters (Hz)
  fcP: number;
  fcS: number;
  fcM: number;
  fcMuff: number;
  fcTail: number;
  fcTurb: number;
  turbineGain: number;
  // radiation
  tilt: number;
  kd: number;
  exGain: number;
  // pulse shape
  fastTau0: number;
  fastFrac: number;
  bodyTauK: number;
  popArea: number;
  jitter: number;
  timingJitterDeg: number;
  // intake / mech / block
  runnerHz: number;
  hissHz: number;
  intakeGain: number;
  intakeMod: number;
  tickGain: number;
  mechHiss: number;
  /** Broadband crack radiated at every blowdown (rasp of open exhausts), relative level. */
  crackLevel: number;
  /** Absolute crack amplitude scale (set from the exhaust loudness target). */
  crackAbs: number;
  blockHz: [number, number, number];
  blockDecay: [number, number, number];
  blockGain: number;
  // turbo / whine / misc
  turbo: boolean;
  twin: boolean;
  whistleF0: number;
  whistleF1: number;
  whistleLevel: number;
  whine: number;
  crackle: number;
  liteGain: number;
  // supercharger: a positive-displacement blower, its whine locked to the crank
  blower: boolean;
  /** Whine fundamental per rpm (Hz): pulley ratio x lobes / 60. */
  blowerHzPerRpm: number;
  /** Whole lobes: the rotor turns at fundamental / lobes. */
  blowerLobes: number;
  blowerLevel: number;
  // the cross-plane V8's lumpiness (see EngineVoice.pulseFactor): all 0 for every other engine
  /** Depth of the back-pressure memory of a bank's pipe, 0 = none. */
  lope: number;
  /** Seconds in which a bank's pipe forgets the last pulse. */
  lopeTau: number;
  /** Spread (log) of the pulse strengths at idle: the cammed idle's cycle-to-cycle irregularity. */
  lump: number;
  /** Chance per exhaust event at idle that a cylinder fires weakly. */
  misfire: number;
  /** How far (log) the strength of one bank wanders from the other's at idle: a bank that runs a little richer for a while. */
  bankDrift: number;
  /** Chance per exhaust event of an engine that is being lifted off that the unburnt charge lights in the pipe. */
  burble: number;
  /** Depth of the idle's slow hunting of the rpm (a fraction); every engine has 0.03. */
  idleWobble: number;
  // exhaust: a true dual system, each bank to its own tailpipe (full quality)
  dual: boolean;
  /** Length of the left / right pipes (after the collector) relative to the nominal ones. */
  dualLen: [number, number];
  /** Muffler cut-off of the left / right pipes relative to the nominal one. */
  dualMuff: [number, number];
  /** What reaches the listener from the left / right tailpipe: the listener is nearer one of them. */
  dualGain: [number, number];
  /** Seconds by which the right tailpipe arrives after the left (the listener's extra path to the far side of the car). */
  dualDelay: number;
}

export function deriveVoicing(p: EngineSoundProfile, layout: EngineLayout): Voicing {
  const o = p.exhaustOpenness;
  const b = p.brightness;
  const perCyl = p.displacement / p.cylinders; // litres per cylinder
  const fScale = Math.pow(0.5 / Math.max(perCyl, 0.15), 0.25);
  const smallTurbo = p.displacement <= 2.6;
  const boxer = p.crankType === 'boxer';
  // a cross-plane V8: its banks fire unevenly, so each bank's pipe sees pulses 90, 180, 270 and 180 degrees apart
  const cross = p.crankType === 'crossplane' && p.cylinders === 8 && layout.banks === 2;
  const dual = p.exhaustSystem === 'dual' && layout.banks === 2;
  const sc = p.supercharger;
  const lobes = sc ? Math.max(1, Math.round(sc.lobes)) : 0;
  return {
    Ls: lerp(0.62, 0.4, o),
    Lm: lerp(1.0, 0.55, o),
    Lc: lerp(0.52, 0.3, o),
    Lq: lerp(0.34, 0.2, o),
    Lt: lerp(0.62, 0.3, o),
    gS: 2.0,
    gM: layout.banks === 2 ? 1.5 : 1.0,
    rc: lerp(5.2, 1.18, Math.pow(o, 0.8)),
    rq: lerp(0.45, 0.06, o),
    Rc: 0.78,
    Ro: lerp(0.95, 0.88, o),
    Rq: 0.85,
    fcP: 5200 + 3500 * b,
    fcS: 6000 + 3000 * b,
    fcM: 5000 + 4000 * o,
    fcMuff: lerp(1500, 9000, Math.pow(o, 0.8)) * (0.8 + 0.4 * b),
    fcTail: lerp(3200, 9500, o),
    fcTurb: 3400,
    turbineGain: p.turbo ? 0.78 : 1,
    tilt: 0.25 + 0.5 * b,
    kd: 7,
    exGain: 1,
    fastTau0: lerp(0.00045, 0.0001, b),
    fastFrac: 0.28 + 0.4 * b,
    bodyTauK: 0.065,
    popArea: 4,
    jitter: boxer ? 0.1 : 0.07,
    timingJitterDeg: boxer ? 1.1 : 0.7,
    runnerHz: 210 * fScale,
    hissHz: 1800 + 1400 * b,
    intakeGain: p.turbo ? 0.5 : 0.65,
    intakeMod: 0.35 + 0.5 * layout.intakeDepth,
    tickGain: 0.35,
    mechHiss: 0.045,
    crackLevel: 0.55 * (0.25 + 0.75 * b) * (0.3 + 0.7 * o),
    crackAbs: 0,
    blockHz: [96 * fScale, 205 * fScale, 430 * fScale],
    blockDecay: [0.035, 0.022, 0.012],
    blockGain: 2.1,
    turbo: p.turbo,
    twin: p.turbo && p.cylinders >= 8,
    whistleF0: smallTurbo ? 2400 : 1800,
    whistleF1: smallTurbo ? 6400 : 4800,
    whistleLevel: 0.09,
    whine: p.gearWhine,
    crackle: p.crackle,
    liteGain: 1.35,
    blower: sc !== undefined && sc.ratio > 0 && lobes > 0,
    blowerHzPerRpm: sc ? (sc.ratio * lobes) / 60 : 0,
    blowerLobes: lobes,
    blowerLevel: sc ? clamp01(sc.level ?? 1) : 0,
    lope: cross ? 0.28 : 0,
    lopeTau: 0.018,
    lump: cross ? 0.3 : 0,
    misfire: cross ? 0.04 : 0,
    bankDrift: cross ? 0.16 : 0,
    burble: cross ? 1 : 0,
    idleWobble: cross ? 0.045 : 0.03,
    dual,
    dualLen: [1, 1.09],
    dualMuff: [1, 0.82],
    dualGain: [1.17, 0.86],
    dualDelay: 0.0015,
  };
}

/**
 * One bank's own pipe in a true dual exhaust, from the end of its secondary to its open tailpipe: main pipe, muffler (expansion chamber
 * with a quarter-wave stub) and tailpipe with its radiating end. The equations are those of the shared chain of the merged system
 * in EngineVoice.block(); here each bank has a copy of its own with a length of its own and a muffler that damps a little differently,
 * and what leaves the end is delayed and weighted by where the listener is (nearer one tailpipe than the other).
 */
class TailChain {
  readonly mf: DelayLine;
  readonly mb: DelayLine;
  readonly cf: DelayLine;
  readonly cb: DelayLine;
  readonly qd: DelayLine;
  readonly tf: DelayLine;
  readonly tb: DelayLine;
  /** The listener's extra path to this tailpipe. */
  readonly rad: DelayLine;
  readonly lpMf = new OnePole();
  readonly lpMb = new OnePole();
  readonly lpCf = new OnePole();
  readonly lpCb = new OnePole();
  readonly lpQ = new OnePole();
  readonly lpTf = new OnePole();
  readonly lpEnd = new OnePole();
  readonly dc = new DcBlock();
  uPrev = 0;
  /** Length, muffler cut-off and radiated gain relative to the nominal ones, and the extra path (s): followed from the voicing every block. */
  lenMul = 1;
  muffMul = 1;
  gain = 1;
  delayS = 0;
  /** Delays in samples (kept up to date with the speed of sound and the Doppler time-scale). */
  Ds = 2;
  Dm = 2;
  Dc = 2;
  Dq = 2;
  Dt = 2;
  Dr = 0;

  /** Room for pipes up to 1.35 x the nominal length and for a listener's path up to 10 ms longer. */
  constructor(V: Voicing, sr: number, readonly index: number) {
    const maxD = (len: number): number => Math.ceil(((len * 1.35) / 380) * sr * 1.8) + 8;
    this.mf = new DelayLine(maxD(V.Lm));
    this.mb = new DelayLine(maxD(V.Lm));
    this.cf = new DelayLine(maxD(V.Lc));
    this.cb = new DelayLine(maxD(V.Lc));
    this.qd = new DelayLine(maxD(V.Lq * 2));
    this.tf = new DelayLine(maxD(V.Lt));
    this.tb = new DelayLine(maxD(V.Lt));
    this.rad = new DelayLine(Math.ceil(0.01 * sr * 2) + 8);
    this.dc.setFc(18, sr);
    this.follow(V);
  }

  /** What distinguishes this pipe from the nominal one, read from the voicing (the left pipe is the nominal one, the right the longer and the later). */
  follow(V: Voicing): void {
    this.lenMul = V.dualLen[this.index];
    this.muffMul = V.dualMuff[this.index];
    this.gain = V.dualGain[this.index];
    this.delayS = this.index === 0 ? 0 : V.dualDelay;
  }

  /** `k` = samples per metre of pipe (sample rate / speed of sound / time-scale). */
  setDelays(V: Voicing, k: number, sr: number, ts: number): void {
    this.follow(V);
    const m = this.lenMul;
    this.Ds = Math.max(2, V.Ls * m * k);
    this.Dm = Math.max(2, V.Lm * m * k);
    this.Dc = Math.max(2, V.Lc * m * k);
    this.Dq = Math.max(2, V.Lq * 2 * m * k);
    this.Dt = Math.max(2, V.Lt * m * k);
    this.Dr = (this.delayS * sr) / ts;
  }

  clear(): void {
    this.mf.clear();
    this.mb.clear();
    this.cf.clear();
    this.cb.clear();
    this.qd.clear();
    this.tf.clear();
    this.tb.clear();
    this.rad.clear();
    this.lpMf.y = this.lpMb.y = this.lpCf.y = this.lpCb.y = this.lpQ.y = this.lpTf.y = this.lpEnd.y = 0;
    this.dc.x1 = this.dc.y1 = 0;
    this.uPrev = 0;
  }
}

const K_FINAL_DRIVE = 3.7;
const PINION_TEETH = 11;
const PAIR_TEETH = 22;
const WIN_N = 1024;
/** Clamp to [lo, hi]; NaN / undefined fall back to `d`. */
function sane(x: number, lo: number, hi: number, d: number): number {
  return x >= lo && x <= hi ? x : x < lo ? lo : x > hi ? hi : d;
}
/** Calibrates crack amplitude so crack-only RMS sits ~14 dB under the exhaust for an open, bright engine. */
const CRACK_K = 3.5;

export class EngineVoice {
  readonly sr: number;
  readonly profile: EngineSoundProfile;
  readonly layout: EngineLayout;
  readonly V: Voicing;
  readonly inp: EngineInputs = defaultEngineInputs();
  debug: EngineDebug | null = null;

  private rng: Rng;
  private readonly G: number;
  private readonly B: number;
  private readonly N: number;

  // smoothed controls (block rate)
  private sRpm: number;
  private sThr = 0;
  private sLoad = 0;
  private sBoost = 0;
  private sInt = 0;
  private sClutch = 0;
  private sTs = 1;
  private sGain = 0;
  private therm = 0.2;
  private ovr = 0;
  private lastShift: number;
  private lastBackfire: number;
  private asleep = false;
  private needSnap = true;

  // crank clock
  private ph: number;
  private cycleBase = 0;
  private evIdx = 0;
  private evNext = 0;

  // pulse parameters (updated per block)
  private pArea = 0;
  private pFast = 0.4;
  private kF = 0.1;
  private kS = 0.01;
  private kP = 0.3;
  private jitAmp = 0.05;
  private jitPh = 0.0005;
  private cutActive = false;
  private cutTimer = 0;
  private limHold = 0;

  // group shapers
  private accF: Float64Array;
  private accFn: Float64Array;
  private accS: Float64Array;
  private accSn: Float64Array;
  private accP: Float64Array;
  private accPn: Float64Array;
  private f1: Float64Array;
  private f2: Float64Array;
  private s1: Float64Array;
  private s2: Float64Array;
  private p1: Float64Array;
  private p2: Float64Array;
  private inj: Float64Array;
  private arr: Float64Array;
  private wl: Float64Array;
  private wrr: Float64Array;
  private blA: Float64Array;
  private asA: Float64Array;
  private grpCnt: Float64Array;
  private grpBank: Int32Array;
  private bankN: Float64Array;

  // waveguide
  private pf: DelayLine[] = [];
  private pb: DelayLine[] = [];
  private lpP: OnePole[] = [];
  private sf: DelayLine[] = [];
  private sb: DelayLine[] = [];
  private lpTurb: OnePole[] = [];
  private lpSf: OnePole[] = [];
  private lpSb: OnePole[] = [];
  private mf: DelayLine;
  private mb: DelayLine;
  private lpMf = new OnePole();
  private lpMb = new OnePole();
  private cf: DelayLine;
  private cb: DelayLine;
  private lpCf = new OnePole();
  private lpCb = new OnePole();
  private qd: DelayLine;
  private lpQ = new OnePole();
  private tf: DelayLine;
  private tb: DelayLine;
  private lpTf = new OnePole();
  private lpEnd = new OnePole();
  private Dp: Float64Array;
  private Ds = 0;
  private Dm = 0;
  private Dc = 0;
  private Dq = 0;
  private Dt = 0;
  private uPrev = 0;
  private dcEx = new DcBlock();

  // body
  private blk: Resonator[] = [];
  private blkIn = 0;
  private blkInN = 0;

  // intake
  private svfRun = new SVF();
  private svfHiss = new SVF();

  // mechanical
  private svfTick = new SVF();
  private svfMech = new SVF();
  private tickIn = 0;
  private tickInN = 0;

  // turbo
  private tSpeed = 0;
  private wPh1 = 0;
  private wPh2 = 0.37;
  private svfBreath = new SVF();
  private svfBov = new SVF();
  private bovEnv = 0;
  private bovF = 3000;
  private flutT = 0;
  private flutPh = 0;
  private bovCool = 0;
  /** The throttle body (the pedal), smoothed like the throttle, and its value a block ago: a quick close blows the blow-off valve. */
  private sPlate = 0;
  private prevPlate = 0;

  // whine
  private whPh1 = 0;
  private whPh3 = 0;
  private whA1 = 0;
  private whA3 = 0;

  // supercharger: rotor phase (turns), smoothed strength, the hiss of the air
  private scPh = 0;
  private scA = 0;
  private svfSc = new SVF();

  // the cross-plane V8's lumpiness (pulseFactor): what each bank's pipe still holds of the last pulses, when the bank last fired (in samples)
  private lopeH: Float64Array;
  private lopeT: Float64Array;
  private lopeAvg = 0.3;
  private bankDr = new Float64Array(2);
  private bankDrW = 0;
  private lopeDepth = 0;
  private lumpSigma = 0;
  private misProb = 0;
  private burbleP = 0;
  /** Samples rendered so far: the clock the exhaust events are timed on. */
  private clock = 0;
  /** True dual exhaust: one chain per bank after the collectors (empty otherwise). */
  private tails: TailChain[] = [];
  private kMuffBank = new Float64Array(2);
  private wasFull = true;

  // events
  private clunkR1 = new Resonator();
  private clunkR2 = new Resonator();
  private clunkIn = 0;
  private clunkNoise = 0;
  private dipT = 0;
  private popEnv = 0;
  private popToneEnv = 0;
  private popTonePh = 0;
  private nextPopIn = 1e9;
  private burstLeft = 0;
  private burstGap = 0;
  private svfPopN = new SVF();

  // interior path
  private lpInt = new Biquad();
  private lpInt2 = new Biquad();
  private cabin = new Biquad();
  private cabin2 = new Biquad();
  private hpOut = new DcBlock();

  // idle wobble
  private wobble = 0;
  private wobbleLp = 0;

  // ramped per-component gains (value at end of previous block)
  private gExE = 0;
  private gExI = 0;
  private gBlk = 0;
  private gInt = 0;
  private gMech = 0;
  private gTur = 0;
  private gWh = 0;
  private gEv = 0;
  private gOut = 0;

  /**
   * @param exGain  undefined = self-calibrate the exhaust loudness (cached per profile, ~15 ms);
   *                a number = use that gain (computed ahead of time on the main thread);
   *                null = leave the exhaust gain at 1 (used by the calibration voice itself).
   */
  constructor(sr: number, profile: EngineSoundProfile, seed = 1, exGain?: number | null) {
    this.sr = sr;
    this.profile = profile;
    this.layout = buildLayout(profile);
    this.V = deriveVoicing(profile, this.layout);
    this.V.crackAbs = this.V.crackLevel * Math.pow(10, exhaustTargetDb(profile.exhaustOpenness) / 20) * CRACK_K;
    this.rng = new Rng(seed * 7919 + 13);
    const L = this.layout;
    const V = this.V;
    this.G = L.groups.length;
    this.B = L.banks;
    this.N = L.cylinders;
    const G = this.G;
    const B = this.B;
    this.sRpm = this.inp.rpm;
    this.lastShift = this.inp.shiftCount;
    this.lastBackfire = this.inp.backfireCount;

    const mk = (n: number): Float64Array => new Float64Array(n);
    this.accF = mk(G);
    this.accFn = mk(G);
    this.accS = mk(G);
    this.accSn = mk(G);
    this.accP = mk(G);
    this.accPn = mk(G);
    this.f1 = mk(G);
    this.f2 = mk(G);
    this.s1 = mk(G);
    this.s2 = mk(G);
    this.p1 = mk(G);
    this.p2 = mk(G);
    this.inj = mk(G);
    this.arr = mk(G);
    this.wl = mk(G);
    this.wrr = mk(G);
    this.Dp = mk(G);
    this.grpCnt = mk(G);
    this.grpBank = new Int32Array(G);
    this.bankN = mk(B);
    this.blA = mk(B);
    this.asA = mk(B);
    this.lopeH = mk(B);
    this.lopeT = mk(B);
    for (let g = 0; g < G; g++) {
      this.grpCnt[g] = L.groups[g].count;
      this.grpBank[g] = L.groups[g].bank;
    }
    for (let b = 0; b < B; b++) this.bankN[b] = L.bankCount[b];

    // delay line capacity: longest pipe at the lowest speed of sound and highest Doppler time-scale
    const maxD = (len: number): number => Math.ceil((len / 380) * sr * 1.8) + 8;
    for (let g = 0; g < G; g++) {
      const m = maxD(L.groups[g].lenM);
      this.pf.push(new DelayLine(m));
      this.pb.push(new DelayLine(m));
      this.lpP.push(new OnePole());
    }
    for (let b = 0; b < B; b++) {
      const m = maxD(V.Ls);
      this.sf.push(new DelayLine(m));
      this.sb.push(new DelayLine(m));
      this.lpTurb.push(new OnePole());
      this.lpSf.push(new OnePole());
      this.lpSb.push(new OnePole());
    }
    this.mf = new DelayLine(maxD(V.Lm));
    this.mb = new DelayLine(maxD(V.Lm));
    this.cf = new DelayLine(maxD(V.Lc));
    this.cb = new DelayLine(maxD(V.Lc));
    this.qd = new DelayLine(maxD(V.Lq * 2));
    this.tf = new DelayLine(maxD(V.Lt));
    this.tb = new DelayLine(maxD(V.Lt));
    if (V.dual) {
      // a true dual exhaust: the left pipe is the nominal one, the right a little longer and damping more, and heard a little later
      for (let b = 0; b < B; b++) {
        this.tails.push(new TailChain(V, sr, b));
        // (the secondary of a longer pipe is longer: room for it)
        const m = maxD(V.Ls * 1.35);
        this.sf[b] = new DelayLine(m);
        this.sb[b] = new DelayLine(m);
      }
    }

    for (let i = 0; i < 3; i++) {
      const r = new Resonator();
      r.set(V.blockHz[i], V.blockDecay[i], sr);
      this.blk.push(r);
    }
    this.svfTick.set(3100, 3.5, sr);
    this.svfMech.set(1900, 0.8, sr);
    this.svfHiss.set(V.hissHz, 0.7, sr);
    this.svfRun.set(V.runnerHz, 1.6, sr);
    // the crack of a backfire sits in the mids, where the bang of a real one has its body: at 2.6 kHz it was a high "pac" over a
    // thump, with nothing between them (half the pop's energy above 2 kHz; now about a fifth)
    this.svfPopN.set(1200, 0.75, sr);
    this.svfCrack.set(3400, 0.7, sr);
    this.clunkR1.set(95, 0.045, sr);
    this.clunkR2.set(240, 0.03, sr);
    this.lpInt.setLowpass(900 + 700 * profile.exhaustOpenness, 0.7, sr);
    this.lpInt2.setLowpass(1500 + 1000 * profile.exhaustOpenness, 0.6, sr);
    this.cabin.setPeaking(95, 2.2, 5, sr);
    this.cabin2.setPeaking(230, 1.6, 2.5, sr);
    this.dcEx.setFc(18, sr);
    this.hpOut.setFc(14, sr);

    // crank clock start
    this.ph = this.rng.u();
    this.cycleBase = Math.floor(this.ph);
    this.evIdx = 0;
    while (this.evIdx < L.evPhase.length && this.cycleBase + L.evPhase[this.evIdx] < this.ph) this.evIdx++;
    if (this.evIdx >= L.evPhase.length) {
      this.evIdx = 0;
      this.cycleBase += 1;
    }
    this.evNext = this.cycleBase + L.evPhase[this.evIdx];
    this.recomputeDelays(1);
    if (exGain === undefined) this.V.exGain = calibratedExhaustGain(profile, sr);
    else if (exGain !== null) this.V.exGain = exGain;
  }

  /** Clear every dynamic state (used after a long sleep so stale energy does not burst out). */
  reset(): void {
    for (let g = 0; g < this.G; g++) {
      this.pf[g].clear();
      this.pb[g].clear();
      this.accF[g] = this.accFn[g] = this.accS[g] = this.accSn[g] = this.accP[g] = this.accPn[g] = 0;
      this.f1[g] = this.f2[g] = this.s1[g] = this.s2[g] = this.p1[g] = this.p2[g] = 0;
      this.lpP[g].y = 0;
    }
    for (let b = 0; b < this.B; b++) {
      this.sf[b].clear();
      this.sb[b].clear();
      this.lpTurb[b].y = this.lpSf[b].y = this.lpSb[b].y = 0;
    }
    this.mf.clear();
    this.mb.clear();
    this.cf.clear();
    this.cb.clear();
    this.qd.clear();
    this.tf.clear();
    this.tb.clear();
    this.lpMf.y = this.lpMb.y = this.lpCf.y = this.lpCb.y = this.lpQ.y = this.lpTf.y = this.lpEnd.y = 0;
    for (const t of this.tails) t.clear();
    this.scA = 0;
    this.lopeH.fill(0);
    for (const r of this.blk) r.reset();
    this.clunkR1.reset();
    this.clunkR2.reset();
    this.uPrev = 0;
    this.bovEnv = 0;
    this.popEnv = 0;
    this.popToneEnv = 0;
    this.flutT = 0;
    this.blkIn = this.blkInN = this.tickIn = this.tickInN = this.clunkIn = 0;
  }

  /** A dual exhaust's pipes are not run in lite quality: what they held when the voice went lite is old news when it comes back. */
  private clearPipes(): void {
    for (let g = 0; g < this.G; g++) {
      this.pf[g].clear();
      this.pb[g].clear();
      this.lpP[g].y = 0;
    }
    for (let b = 0; b < this.B; b++) {
      this.sf[b].clear();
      this.sb[b].clear();
      this.lpTurb[b].y = this.lpSf[b].y = this.lpSb[b].y = 0;
    }
    for (const t of this.tails) t.clear();
  }

  private firstBlock = true;
  private heat = 0;
  // rpm is ramped piecewise-linearly between control updates (no 60 Hz pitch staircase)
  private rpmIn = 900;
  private rpmFrom = 900;
  private rpmTo = 900;
  private rpmRampT = 0;
  private rpmRampLen = 1 / 60;
  private sinceRpmChange = 0;
  private crackIn = 0;
  private crackInN = 0;
  private crackEnv = 0;
  private svfCrack = new SVF();

  private heatTarget(load: number, rpmN: number): number {
    return clamp01(load * (0.4 + 0.6 * rpmN) * 1.3);
  }

  /** Jump every smoothed control to its target (first block, tests) so nothing ramps up from defaults. */
  private snapControls(): void {
    const I = this.inp;
    this.sRpm = I.rpm;
    this.rpmIn = this.rpmFrom = this.rpmTo = I.rpm;
    this.rpmRampT = this.rpmRampLen;
    this.sinceRpmChange = 0;
    this.sThr = I.throttle;
    this.sLoad = I.load;
    this.sBoost = I.boost;
    this.sInt = I.interior;
    this.sClutch = I.clutch;
    this.sTs = clamp(I.timeScale, 0.6, 1.6);
    this.sGain = I.gain;
    this.lastShift = I.shiftCount;
    this.lastBackfire = I.backfireCount;
    const rpmN = clamp(I.rpm / Math.max(I.limiterRpm, 1000), 0, 1.1);
    this.therm = 0.12 + 0.88 * clamp01(I.load * 0.75 + rpmN * 0.45);
    this.tSpeed = this.V.turbo ? clamp01(I.boost * (0.55 + 0.45 * rpmN) + 0.12 * I.load * rpmN) : 0;
    this.sPlate = this.prevPlate = I.pedal >= 0 ? I.pedal : I.throttle;
    this.recomputeDelays(this.sTs);
  }

  private recomputeDelays(ts: number): void {
    const V = this.V;
    const c = 430 + 200 * this.therm;
    const k = this.sr / (c * ts);
    const L = this.layout;
    for (let g = 0; g < this.G; g++) this.Dp[g] = Math.max(2, L.groups[g].lenM * k);
    this.Ds = Math.max(2, V.Ls * k);
    this.Dm = Math.max(2, V.Lm * k);
    this.Dc = Math.max(2, V.Lc * k);
    this.Dq = Math.max(2, V.Lq * 2 * k);
    this.Dt = Math.max(2, V.Lt * k);
    for (const t of this.tails) t.setDelays(V, k, this.sr, ts);
  }

  /** Render `n` samples into out[offset..offset+n). */
  process(out: Float32Array, n: number, offset = 0): void {
    let done = 0;
    while (done < n) {
      const len = Math.min(128, n - done);
      this.block(out, offset + done, len, done);
      done += len;
    }
  }

  private block(out: Float32Array, o: number, len: number, dbgOffset: number): void {
    const I = this.inp;
    const V = this.V;
    const L = this.layout;
    const sr = this.sr;
    const invSr = 1 / sr;
    const dt = len * invSr;
    const full = I.quality >= 1.5;
    const rng = this.rng;

    // ── input sanitising (the worklet already clamps; the DSP protects itself too) ─────────────────
    I.rpm = sane(I.rpm, 0, 20000, this.rpmIn);
    I.throttle = sane(I.throttle, 0, 1, 0);
    I.load = sane(I.load, 0, 1, 0);
    I.boost = sane(I.boost, 0, 1.5, 0);
    I.clutch = sane(I.clutch, 0, 1, 0);
    I.interior = sane(I.interior, 0, 1, 0);
    I.gain = sane(I.gain, 0, 4, 1);
    I.driveOmega = sane(I.driveOmega, -4000, 4000, 0);
    I.idleRpm = sane(I.idleRpm, 100, 5000, 900);
    I.limiterRpm = sane(I.limiterRpm, 1000, 20000, 7000);
    I.timeScale = sane(I.timeScale, 0.5, 2, 1);
    // ── sleep handling ────────────────────────────────────────────────────────
    if (this.needSnap) {
      this.snapControls();
      this.needSnap = false;
    }
    const firstBlock = this.firstBlock;
    this.firstBlock = false;
    const gainPrev = this.sGain;
    this.sGain += smoothCoef(0.02, dt) * (I.gain - this.sGain);
    if (I.quality < 0.5 || (I.gain < 1e-4 && this.sGain < 1e-4)) {
      for (let i = 0; i < len; i++) out[o + i] = 0;
      this.asleep = true;
      return;
    }
    if (this.asleep) {
      this.reset();
      this.asleep = false;
      // (what the car did while it was out of earshot, its shifts and backfires, is not played now as if it had just happened)
      this.lastShift = I.shiftCount;
      this.lastBackfire = I.backfireCount;
    }
    if (full && !this.wasFull && this.tails.length > 0) this.clearPipes();
    this.wasFull = full;

    // ── control smoothing ─────────────────────────────────────────────────────
    const rpmPrev = this.sRpm;
    if (I.rpm !== this.rpmIn) {
      // a new control frame arrived: glide to it over the interval since the previous one
      this.rpmRampLen = clamp(this.sinceRpmChange, 0.006, 0.05);
      this.sinceRpmChange = 0;
      this.rpmFrom = this.sRpm;
      this.rpmTo = I.rpm;
      this.rpmRampT = 0;
      this.rpmIn = I.rpm;
    }
    this.sinceRpmChange += dt;
    this.rpmRampT = Math.min(this.rpmRampT + dt, this.rpmRampLen);
    this.sRpm = this.rpmFrom + (this.rpmTo - this.rpmFrom) * (this.rpmRampT / this.rpmRampLen);
    this.sThr += smoothCoef(0.03, dt) * (I.throttle - this.sThr);
    this.sPlate += smoothCoef(0.03, dt) * ((I.pedal >= 0 ? I.pedal : I.throttle) - this.sPlate);
    this.sLoad += smoothCoef(0.035, dt) * (I.load - this.sLoad);
    this.sBoost += smoothCoef(0.04, dt) * (I.boost - this.sBoost);
    this.sInt += smoothCoef(0.06, dt) * (I.interior - this.sInt);
    this.sClutch += smoothCoef(0.02, dt) * (I.clutch - this.sClutch);
    const tsPrev = this.sTs;
    this.sTs += smoothCoef(0.04, dt) * (clamp(I.timeScale, 0.6, 1.6) - this.sTs);

    const rpm = this.sRpm;
    const limiterRpm = Math.max(I.limiterRpm, 1000);
    const rpmN = clamp(rpm / limiterRpm, 0, 1.1);
    const idle = Math.max(I.idleRpm, 300);

    // counters -> events (a counter that went back is a replay starting over, not a shift: it is taken as the new count, silently)
    if (I.shiftCount !== this.lastShift) {
      const fresh = I.shiftCount > this.lastShift;
      this.lastShift = I.shiftCount;
      if (fresh) {
        this.dipT = 0.07;
        this.clunkIn += 0.5 + 0.5 * this.sLoad;
        this.clunkNoise = 1;
        if (V.crackle > 0.3 && this.ovr > 0.2) this.burstLeft += 1;
      }
    }
    if (I.backfireCount !== this.lastBackfire) {
      const fresh = I.backfireCount > this.lastBackfire;
      this.lastBackfire = I.backfireCount;
      if (fresh) {
        this.firePop(1 + 0.3 * rng.u());
        this.burstLeft += Math.floor(V.crackle * 1.6 * rng.u());
        this.burstGap = 0.03;
      }
    }

    // shift torque-cut dip
    if (this.dipT > 0) this.dipT = Math.max(0, this.dipT - dt);
    const dip = this.dipT > 0 ? smoothstep(0, 0.03, this.dipT) * 0.8 : 0;
    const loadE = this.sLoad * (1 - dip);

    // overrun: throttle closed while spinning
    const ovrT =
      smoothstep(0.16, 0.03, this.sThr) * smoothstep(idle * 1.15, idle * 1.9, rpm) * smoothstep(0.35, 0.1, loadE);
    this.ovr += smoothCoef(0.05, dt) * (ovrT - this.ovr);
    const ovr = this.ovr;

    // thermal state -> speed of sound -> pipe resonances
    const thermT = 0.12 + 0.88 * clamp01(loadE * 0.75 + rpmN * 0.45);
    this.therm += smoothCoef(1.6, dt) * (thermT - this.therm);
    this.recomputeDelays(this.sTs);

    // limiter chop (time-based fuel cut, like a real ECU)
    if (I.limiter > 0.5) this.limHold = 0.14;
    else if (this.limHold > 0) this.limHold = Math.max(0, this.limHold - dt);
    if (this.limHold > 0) {
      this.cutTimer -= dt;
      if (this.cutTimer <= 0) {
        this.cutActive = !this.cutActive;
        this.cutTimer = (this.cutActive ? 0.03 : 0.04) * (0.7 + 0.6 * rng.u());
      }
    } else {
      this.cutActive = false;
      this.cutTimer = 0;
    }

    // idle wobble (hunting) fades out above idle
    this.wobbleLp += smoothCoef(0.25, dt) * (rng.s2() - this.wobbleLp);
    this.wobble += smoothCoef(0.12, dt) * (this.wobbleLp - this.wobble);
    const idleness = smoothstep(idle * 1.3, idle * 1.02, rpm);
    const wobPrev = 1 + this.wobbleBlockPrev * V.idleWobble * this.idlenessPrev;
    const wobNow = 1 + this.wobble * V.idleWobble * idleness;
    this.wobbleBlockPrev = this.wobble;
    this.idlenessPrev = idleness;

    // ── pulse parameters for this block ──────────────────────────────────────
    const loadShape = 0.45 + 0.55 * Math.pow(loadE, 1.2);
    const rpmShape = 0.4 + 0.6 * rpmN;
    // idle presence: a real idle is far quieter than full throttle, but in a game the grid / pit wait must stay
    // characterful, so lift the region around idle (fades out by ~2.2 x idle rpm)
    const idlePresence = 1 + 1.9 * smoothstep(idle * 2.2, idle * 1.0, rpm);
    this.pArea = V.exGain * loadShape * rpmShape * idlePresence * (1 - 0.1 * ovr) * (1 + 0.25 * this.sBoost);
    this.pFast = clamp(V.fastFrac + 0.25 * loadE - 0.1 * ovr, 0.12, 0.85);
    // the valve-opening part of the blowdown is fixed in crank angle, so pulses are softer at low rpm and
    // sharper at high rpm (gas-dynamic part fixed in time)
    const rpmSoft = 0.55 + 0.45 * Math.pow(clamp(4000 / Math.max(rpm, 1000), 0.4, 3), 0.9);
    const tauF = V.fastTau0 * (2.0 - 1.0 * loadE) * (1 + 0.5 * ovr) * rpmSoft;
    this.kF = 1 - Math.exp(-1 / (tauF * sr));
    const tauS = clamp((V.bodyTauK * 120) / Math.max(rpm, 200), 0.0012, 0.03);
    this.kS = 1 - Math.exp(-1 / (tauS * sr));
    this.kP = 1 - Math.exp(-1 / (0.00009 * sr));
    this.jitAmp = V.jitter * (1.6 - 1.2 * rpmN) * (1.3 - 0.8 * loadE) * (1 + 0.8 * idleness);
    this.jitPh = (V.timingJitterDeg * (1.4 - 0.9 * rpmN) * (1 + idleness)) / 720;
    if (V.lope > 0) {
      // the cross-plane's lumpiness is strongest at idle and light load and gives way to the roar as the pulses crowd together
      const lowW = smoothstep(idle * 2.8, idle * 1.0, rpm);
      this.lopeDepth = V.lope * (1 - 0.55 * loadE) * smoothstep(5200, 1500, rpm);
      this.lumpSigma = V.lump * lowW * (1 - 0.7 * loadE);
      this.misProb = V.misfire * lowW * (1 - loadE);
      // one bank runs a little richer than the other for a second or so, then the other: the half orders at idle breathe
      const kDr = smoothCoef(0.9, dt);
      this.bankDr[0] = ouStep(this.bankDr[0], kDr, V.bankDrift, rng.s2());
      this.bankDr[1] = ouStep(this.bankDr[1], kDr, V.bankDrift, rng.s2());
      this.bankDrW = lowW * (1 - 0.7 * loadE);
    }

    // ── crackle / pops ───────────────────────────────────────────────────────
    this.heat += smoothCoef(this.heatTarget(loadE, rpmN) > this.heat ? 0.3 : 3.0, dt) * (this.heatTarget(loadE, rpmN) - this.heat);
    let popRate = V.crackle * 16 * ovr * this.heat * smoothstep(1800, 4500, rpm);
    if (this.cutActive) popRate += V.crackle * 28;
    if (this.burstLeft > 0) {
      this.burstGap -= dt;
      if (this.burstGap <= 0) {
        this.burstLeft--;
        this.burstGap = 0.025 + 0.06 * rng.u();
        this.firePop(0.45 + 0.5 * rng.u());
      }
    }
    if (popRate > 0) {
      if (this.nextPopIn > 1e8) this.nextPopIn = -Math.log(Math.max(rng.u(), 1e-6)) / popRate;
      this.nextPopIn -= dt;
      if (this.nextPopIn <= 0) {
        const big = rng.u() < 0.03 * V.crackle;
        this.firePop(big ? 0.8 + 0.4 * rng.u() : 0.18 + 0.4 * rng.u() * rng.u());
        this.nextPopIn = -Math.log(Math.max(rng.u(), 1e-6)) / popRate;
      }
    } else this.nextPopIn = 1e9;
    // the burble of a cross-plane V8 that is being lifted off: unburnt charge lights in the pipe on some of the exhaust events (see below), a
    // dozen to thirty a second through the middle of the rev range while the exhaust is hot, and none at idle or near the limiter
    if (V.burble > 0) {
      this.burbleP = V.burble * ovr * (0.25 + 0.75 * this.heat) * smoothstep(idle * 1.5, idle * 2.6, rpm) * smoothstep(5200, 3600, rpm) * 0.16;
    }

    // ── turbo spool state ────────────────────────────────────────────────────
    if (V.turbo) {
      const tgt = clamp01(this.sBoost * (0.55 + 0.45 * rpmN) + 0.12 * loadE * rpmN);
      const tau = tgt > this.tSpeed ? 0.09 : 0.9;
      this.tSpeed += smoothCoef(tau, dt) * (tgt - this.tSpeed);
      // the blow-off valve vents the boost when the throttle body snaps shut: when the driver lifts, not on a flat upshift
      const dPlate = (this.sPlate - this.prevPlate) / dt;
      this.prevPlate = this.sPlate;
      this.bovCool = Math.max(0, this.bovCool - dt);
      if (dPlate < -3.5 && this.sBoost > 0.2 && this.bovCool <= 0) {
        this.bovEnv = clamp01(this.sBoost * 1.2);
        this.flutT = 0.7 * V.crackle + 0.25;
        this.bovF = 3300;
        this.bovCool = 0.45;
      }
    }

    // ── per-component target gains (linearly ramped over the block) ──────────
    const sI = this.sInt;
    const thr = this.sThr;
    const intakeAmt =
      (0.1 + 0.9 * Math.pow(thr, 1.1)) * (0.15 + 0.85 * Math.pow(rpmN, 1.4)) + 0.75 * ovr * Math.pow(rpmN, 1.3);
    const tExE = 1 - sI;
    const tExI = 0.55 * sI;
    const tBlk = lerp(0.5, 0.85, sI) * (0.15 + 0.85 * loadE) * (0.35 + 0.65 * rpmN) * (1 + 1.2 * smoothstep(idle * 2.2, idle * 1.0, rpm));
    const tInt = lerp(0.42, 1.05, sI) * V.intakeGain * intakeAmt;
    const tMech = lerp(0.145, 0.36, sI) * (0.25 + 0.75 * Math.pow(rpmN, 1.6)) * (0.45 + 0.55 * loadE);
    const tTur = V.turbo ? lerp(0.165, 0.46, sI) : V.blower ? lerp(0.42, 0.9, sI) : 0;
    const tWh = lerp(0.14, 0.9, sI) * V.whine;
    const tEv = lerp(0.7, 1.0, sI);
    if (firstBlock) {
      this.gExE = tExE;
      this.gExI = tExI;
      this.gBlk = tBlk;
      this.gInt = tInt;
      this.gMech = tMech;
      this.gTur = tTur;
      this.gWh = tWh;
      this.gEv = tEv;
    }
    const gOutA = gainPrev;
    const gOutB = this.sGain;
    const invLen = 1 / len;
    const dExE = (tExE - this.gExE) * invLen;
    const dExI = (tExI - this.gExI) * invLen;
    const dBlk = (tBlk - this.gBlk) * invLen;
    const dInt = (tInt - this.gInt) * invLen;
    const dMech = (tMech - this.gMech) * invLen;
    const dTur = (tTur - this.gTur) * invLen;
    const dWh = (tWh - this.gWh) * invLen;
    const dEv = (tEv - this.gEv) * invLen;
    const dOut = (gOutB - gOutA) * invLen;
    let cExE = this.gExE;
    let cExI = this.gExI;
    let cBlk = this.gBlk;
    let cInt = this.gInt;
    let cMech = this.gMech;
    let cTur = this.gTur;
    let cWh = this.gWh;
    let cEv = this.gEv;
    let cOut = gOutA;
    this.gExE = tExE;
    this.gExI = tExI;
    this.gBlk = tBlk;
    this.gInt = tInt;
    this.gMech = tMech;
    this.gTur = tTur;
    this.gWh = tWh;
    this.gEv = tEv;

    // rpm ramp (pitch continuity) — per-sample linear interpolation inside the block
    const kPh = 1 / (120 * sr);
    const phInc0 = rpmPrev * wobPrev * tsPrev * kPh;
    const phInc1 = rpm * wobNow * this.sTs * kPh;

    // filters following the block parameters
    const svfRun = this.svfRun;
    const svfHiss = this.svfHiss;
    const svfTick = this.svfTick;
    const svfMech = this.svfMech;
    svfMech.set(1300 + 1500 * rpmN, 0.8, sr);
    svfRun.set(V.runnerHz * (0.9 + 0.25 * this.therm), 1.6, sr);
    svfHiss.set(V.hissHz * (0.7 + 0.5 * thr), 0.7, sr);
    const kLpP = 1 - Math.exp((-TAU * V.fcP) / sr);
    const kLpS = 1 - Math.exp((-TAU * V.fcS) / sr);
    const kLpM = 1 - Math.exp((-TAU * V.fcM) / sr);
    const kLpMuff = 1 - Math.exp((-TAU * V.fcMuff) / sr);
    const kLpTail = 1 - Math.exp((-TAU * V.fcTail) / sr);
    const kLpTurb = 1 - Math.exp((-TAU * V.fcTurb) / sr);
    const kLpQ = 1 - Math.exp((-TAU * 2400) / sr);
    const kLpEnd = 1 - Math.exp((-TAU * (V.fcTail * 0.8)) / sr);

    // turbo whistle block parameters
    const tSp = this.tSpeed;
    const wF = (V.whistleF0 + (V.whistleF1 - V.whistleF0) * Math.pow(tSp, 0.85)) * this.sTs;
    const wAmp = V.whistleLevel * Math.pow(tSp, 1.5);
    const flutDepth = this.flutT > 0 ? clamp01(this.flutT * 2) : 0;
    const flutRate = 11 + 4 * (1 - clamp01(this.flutT));
    if (this.flutT > 0) this.flutT = Math.max(0, this.flutT - dt);
    const bovK = Math.exp(-invSr / 0.2);
    this.svfBreath.set(clamp(wF, 600, sr * 0.4), 5, sr);
    this.bovF = Math.max(1500, this.bovF - 2200 * dt);
    this.svfBov.set(this.bovF, 1.3, sr);

    // gear whine block parameters
    const omega = Math.abs(I.driveOmega);
    const pinionHz = (omega / TAU) * K_FINAL_DRIVE * PINION_TEETH * this.sTs;
    const pairHz = (rpm / 60) * PAIR_TEETH * this.sTs;
    const whLoad = 0.35 + 0.65 * clamp01(Math.max(thr, loadE));
    const nyq = sr * 0.42;
    const whTargetP = omega > 2 && pinionHz < nyq && pinionHz > 30 ? whLoad : 0;
    const whTargetQ = pairHz < nyq && pairHz > 40 ? (1 - this.sClutch) * whLoad * 0.7 : 0;
    const whK = 1 - Math.exp(-invSr / 0.03);

    // supercharger block parameters. The rotors are driven by a belt off the crank, so the tone sits at rpm/60 x ratio x lobes and follows
    // every change of the rpm at once (positive displacement: no lag, no spool), whatever the throttle does; how much of it there is
    // depends on what the blower is doing: with the throttle shut the bypass valve is open and lets the air go round the rotors (a
    // whirr, the rotors' own noise), on the throttle the valve is shut and the whole of the rotor speed becomes pressure and a whine
    const blowOn = V.blower && full;
    const blowInc0 = V.blowerHzPerRpm * rpmPrev * tsPrev * invSr; // fundamental, cycles per sample, at the start and end of the block
    const blowInc1 = V.blowerHzPerRpm * rpm * this.sTs * invSr;
    const plateB = Math.pow(this.sPlate, 1.3);
    const blowSpeed = Math.pow(clamp(rpm / limiterRpm, 0, 1.1), 1.15);
    const blowTarget = blowOn && blowInc1 < 0.42 ? V.blowerLevel * (0.16 + 0.84 * plateB) * (0.1 + 0.9 * blowSpeed) : 0;
    // harmonics: more of them the harder it pushes; none beyond the Nyquist guard (a partial that folded back would be a whistle off the engine orders)
    const blowW2 = blowInc1 * 2 < 0.42 ? 0.35 + 0.35 * plateB : 0;
    const blowW3 = blowInc1 * 3 < 0.42 ? 0.15 + 0.3 * plateB : 0;
    const blowW4 = blowInc1 * 4 < 0.42 ? 0.06 + 0.16 * plateB : 0;
    const blowLobes = V.blowerLobes;
    const blowKa = 1 - Math.exp(-invSr / 0.05);
    const blowKr = 1 - Math.exp(-invSr / 0.03);
    if (blowOn) this.svfSc.set(clamp(blowInc1 * sr * 3.3, 900, sr * 0.4), 2.5, sr);
    const svfSc = this.svfSc;

    // event-sound decay constants (sample-rate independent)
    const popEnvK = Math.exp(-invSr / 0.017);
    const popToneK = Math.exp(-invSr / 0.045);
    const clunkNoiseK = Math.exp(-invSr / 0.02);
    const exTilt = V.tilt;
    const kd = V.kd;
    const evRate = Math.max(this.N * 0.5 * (rpm / 60), 20); // combustion events per second
    const crackAmp = V.crackAbs * loadE * loadE * (0.12 + 0.88 * rpmN * rpmN) * (1 - 0.6 * ovr);
    const crackK = Math.exp(-invSr / (0.0011 - 0.0006 * loadE));
    const combAmp = (0.25 + 0.75 * loadE) * (0.4 + 0.6 * rpmN) * Math.pow(300 / evRate, 0.6);

    // localise hot state
    const G = this.G;
    const bankCount = full ? this.B : 1;
    let ph = this.ph;
    const evPhase = L.evPhase;
    const evType = L.evType;
    const evCyl = L.evCyl;
    const nEv = evPhase.length;
    const win = L.intakeWindow;
    const accF = this.accF;
    const accFn = this.accFn;
    const accS = this.accS;
    const accSn = this.accSn;
    const accP = this.accP;
    const accPn = this.accPn;
    const f1 = this.f1;
    const f2 = this.f2;
    const s1 = this.s1;
    const s2 = this.s2;
    const p1 = this.p1;
    const p2 = this.p2;
    const inj = this.inj;
    const arr = this.arr;
    const wl = this.wl;
    const wrr = this.wrr;
    const blA = this.blA;
    const asA = this.asA;
    const Dp = this.Dp;
    const grpCnt = this.grpCnt;
    const grpBank = this.grpBank;
    const bankN = this.bankN;
    const pf = this.pf;
    const pb = this.pb;
    const lpP = this.lpP;
    const sf = this.sf;
    const sb = this.sb;
    const lpTurb = this.lpTurb;
    const lpSf = this.lpSf;
    const lpSb = this.lpSb;
    const mf = this.mf;
    const mb = this.mb;
    const cf = this.cf;
    const cb = this.cb;
    const qd = this.qd;
    const tf = this.tf;
    const tb = this.tb;
    const lpMf = this.lpMf;
    const lpMb = this.lpMb;
    const lpCf = this.lpCf;
    const lpCb = this.lpCb;
    const lpQ = this.lpQ;
    const lpTf = this.lpTf;
    const lpEnd = this.lpEnd;
    const Ds = this.Ds;
    const Dm = this.Dm;
    const Dc = this.Dc;
    const Dq = this.Dq;
    const Dt = this.Dt;
    const gS = V.gS;
    const gM = bankCount === 1 ? 1 : V.gM;
    const rc = V.rc;
    const rq = V.rq;
    const Rc = V.Rc;
    const Ro = V.Ro;
    const Rq = V.Rq;
    const turbineGain = V.turbineGain;
    const turboOn = V.turbo;
    const twin = V.twin;
    const liteGain = V.liteGain;
    const dbg = this.debug;
    const Y1 = 1 + rc + rq; // X1: main + chamber + stub
    const Y2 = rc + 1; // X2: chamber + tail
    const lpInt = this.lpInt;
    const lpInt2 = this.lpInt2;
    const cabin = this.cabin;
    const cabin2 = this.cabin2;
    const blk0 = this.blk[0];
    const blk1 = this.blk[1];
    const blk2 = this.blk[2];
    const clunkR1 = this.clunkR1;
    const clunkR2 = this.clunkR2;
    const intakeMod = V.intakeMod;
    const tickGain = V.tickGain;
    const mechHiss = V.mechHiss;
    const blockGain = V.blockGain;
    const hpOut = this.hpOut;
    const dcEx = this.dcEx;
    const popNoiseSvf = this.svfPopN;
    const svfBreath = this.svfBreath;
    const svfBov = this.svfBov;
    const nN = this.N;

    let uPrev = this.uPrev;
    let wPh1 = this.wPh1;
    let wPh2 = this.wPh2;
    let whPh1 = this.whPh1;
    let whPh3 = this.whPh3;
    let whA1 = this.whA1;
    let whA3 = this.whA3;
    let scPh = this.scPh;
    let scA = blowOn ? this.scA : 0; // a blower that was not rendered (lite) fades in again, it does not come back at its old level
    let bovEnv = this.bovEnv;
    let flutPh = this.flutPh;
    let popEnv = this.popEnv;
    let popToneEnv = this.popToneEnv;
    let popTonePh = this.popTonePh;
    let clunkNoise = this.clunkNoise;
    let blkIn = this.blkIn;
    let blkInN = this.blkInN;
    let tickIn = this.tickIn;
    let tickInN = this.tickInN;
    let clunkIn = this.clunkIn;
    let crackIn = this.crackIn;
    let crackInN = this.crackInN;
    let crackEnv = this.crackEnv;
    const svfCrack = this.svfCrack;
    let nzState = rng.s;
    const jitAmp = this.jitAmp;
    const jitPh = this.jitPh;
    const pArea = this.pArea;
    const pFast = this.pFast;
    const kF = this.kF;
    const kS = this.kS;
    const kP = this.kP;
    const cutActive = this.cutActive;
    const sIntNow = sI;
    const lopeOn = V.lope > 0;
    const burbleP = this.burbleP;
    const tails = this.tails;
    const dualOn = full && tails.length > 0;
    const gMd = 1.1; // a true dual exhaust: each pipe a little wider than the secondary it continues
    const kMuffBank = this.kMuffBank;
    if (dualOn) for (let b = 0; b < 2; b++) kMuffBank[b] = 1 - Math.exp((-TAU * V.fcMuff * tails[b].muffMul) / sr);

    for (let i = 0; i < len; i++) {
      const fr = (i + 1) * invLen;
      const phInc = phInc0 + (phInc1 - phInc0) * fr;

      // ── crank clock & events ───────────────────────────────────────────────
      ph += phInc;
      while (phInc > 0 && ph >= this.evNext) {
        let frac = (ph - this.evNext) / phInc;
        if (frac > 1) frac = 1;
        const ty = evType[this.evIdx];
        const cy = evCyl[this.evIdx];
        if (ty === EV_EXHAUST) {
          const cs = L.cyl[cy];
          let amp = pArea * cs.gain * (1 + jitAmp * rng.s2());
          let burb = 0;
          if (lopeOn) {
            amp *= this.pulseFactor(cs.bank, this.clock + i + 1 - frac, !full);
            if (burbleP > 0 && rng.u() < burbleP) burb = 0.8 + 2.4 * rng.u() * rng.u();
          }
          amp *= 1 + burb;
          if (cutActive) amp *= 0.07;
          const g = L.cylGroup[cy];
          const aF = amp * pFast;
          const aS = amp - aF;
          accF[g] += aF * frac;
          accFn[g] += aF * (1 - frac);
          accS[g] += aS * frac;
          accSn[g] += aS * (1 - frac);
          if (!cutActive) {
            const ca = (crackAmp + burb * V.crackAbs * 0.3) * cs.gain * (0.6 + 0.8 * rng.u());
            crackIn += ca * frac;
            crackInN += ca * (1 - frac);
          }
        } else if (ty === EV_COMBUSTION) {
          const a = combAmp * L.cyl[cy].gain * (cutActive ? 0.05 : 1) * (1 + 0.3 * rng.s2());
          blkIn += a * frac;
          blkInN += a * (1 - frac);
        } else {
          const a = tickGain * (0.6 + 0.8 * rng.u()) * (ty === EV_TICK_INT_CLOSE ? 1.3 : 1);
          tickIn += a * frac;
          tickInN += a * (1 - frac);
        }
        this.evIdx++;
        if (this.evIdx >= nEv) {
          this.evIdx = 0;
          this.cycleBase += 1;
        }
        this.evNext = this.cycleBase + evPhase[this.evIdx] + (ty === EV_EXHAUST ? rng.s2() * jitPh : 0);
        if (this.cycleBase > 8192) {
          ph -= 8192;
          this.cycleBase -= 8192;
          this.evNext -= 8192;
        }
      }
      const cyc = ph - Math.floor(ph);

      // ── pulse shapers per group ────────────────────────────────────────────
      for (let g = 0; g < G; g++) {
        const xf = accF[g];
        accF[g] = accFn[g];
        accFn[g] = 0;
        const xs = accS[g];
        accS[g] = accSn[g];
        accSn[g] = 0;
        const xp = accP[g];
        accP[g] = accPn[g];
        accPn[g] = 0;
        let a = f1[g];
        a += kF * (xf - a);
        f1[g] = a;
        let b2 = f2[g];
        b2 += kF * (a - b2);
        f2[g] = b2;
        let c = s1[g];
        c += kS * (xs - c);
        s1[g] = c;
        let d = s2[g];
        d += kS * (c - d);
        s2[g] = d;
        let e = p1[g];
        e += kP * (xp - e);
        p1[g] = e;
        let f = p2[g];
        f += kP * (e - f);
        p2[g] = f;
        inj[g] = b2 + d + f;
      }

      // ── waveguide: READ every arrival (before any write of the same step) ──
      if (full) {
        for (let g = 0; g < G; g++) {
          wl[g] = pb[g].tap(Dp[g] - 1);
          arr[g] = pf[g].tap(Dp[g] - 1);
        }
      } else {
        for (let g = 0; g < G; g++) arr[g] = inj[g] * liteGain;
      }
      for (let b = 0; b < bankCount; b++) {
        const dsb = dualOn ? tails[b].Ds : Ds;
        blA[b] = sb[b].tap(dsb - 1);
        asA[b] = sf[b].tap(dsb - 1);
      }
      const ml = mb.tap(Dm - 1);
      const mfa = mf.tap(Dm - 1);
      const cbl = cb.tap(Dc - 1);
      const caf = cf.tap(Dc - 1);
      const qdOut = qd.tap(Dq - 1);
      const tbl = tb.tap(Dt - 1);
      const ta = tf.tap(Dt - 1);

      // ── scatter + WRITE ────────────────────────────────────────────────────
      if (full) {
        for (let g = 0; g < G; g++) pf[g].write(Rc * wl[g] + inj[g]);
      }
      let asSum = 0;
      for (let b = 0; b < bankCount; b++) {
        let S = 0;
        let Nb = nN;
        if (full) {
          Nb = bankN[b];
          for (let g = 0; g < G; g++) if (grpBank[g] === b) S += arr[g];
        } else {
          for (let g = 0; g < G; g++) S += arr[g];
        }
        const bl = blA[b];
        const pJ = (2 * (S + gS * bl)) / (Nb + gS);
        if (full) {
          for (let g = 0; g < G; g++) {
            if (grpBank[g] === b) {
              const lp = lpP[g];
              lp.y += kLpP * (grpCnt[g] * pJ - arr[g] - lp.y);
              pb[g].write(lp.y);
            }
          }
        }
        let fwd = pJ - bl;
        if (turboOn) {
          const lt = lpTurb[b];
          lt.y += kLpTurb * (fwd - lt.y);
          fwd = lt.y * turbineGain;
        }
        const lf = lpSf[b];
        lf.y += kLpS * (fwd - lf.y);
        sf[b].write(lf.y);
        asSum += asA[b];
      }

      let u = 0;
      let exD = 0;
      if (dualOn) {
        // a true dual exhaust: each secondary goes on into a pipe of its own (no X-pipe, no crossover), through its own muffler to its own
        // tailpipe; the two come out on opposite sides of the car and the listener hears the sum, a little later and a little less from the
        // far one. Same equations as the shared chain below.
        for (let b = 0; b < 2; b++) {
          const t = tails[b];
          const sa = asA[b];
          const mlb = t.mb.tap(t.Dm - 1);
          const mfb = t.mf.tap(t.Dm - 1);
          const cbb = t.cb.tap(t.Dc - 1);
          const cfb = t.cf.tap(t.Dc - 1);
          const qdb = t.qd.tap(t.Dq - 1);
          const tbb = t.tb.tap(t.Dt - 1);
          const tab = t.tf.tap(t.Dt - 1);
          // the secondary meets the main pipe: a small step in area, nothing else on the junction
          const pMb = (2 * (sa + gMd * mlb)) / (1 + gMd);
          const lb = lpSb[b];
          lb.y += kLpS * (pMb - sa - lb.y);
          sb[b].write(lb.y);
          t.lpMf.y += kLpM * (pMb - mlb - t.lpMf.y);
          t.mf.write(t.lpMf.y);
          // muffler entrance X1
          t.lpQ.y += kLpQ * (qdb - t.lpQ.y);
          const qab = Rq * t.lpQ.y;
          const pX1b = (2 * (mfb + rc * cbb + rq * qab)) / Y1;
          t.lpMb.y += kLpM * (pX1b - mfb - t.lpMb.y);
          t.mb.write(t.lpMb.y);
          const kMuffB = kMuffBank[b];
          t.lpCf.y += kMuffB * (pX1b - cbb - t.lpCf.y);
          t.cf.write(t.lpCf.y);
          t.qd.write(pX1b - qab);
          // X2: chamber -> tailpipe
          const pX2b = (2 * (rc * cfb + tbb)) / Y2;
          t.lpCb.y += kMuffB * (pX2b - cfb - t.lpCb.y);
          t.cb.write(t.lpCb.y);
          t.lpTf.y += kLpTail * (pX2b - tbb - t.lpTf.y);
          t.tf.write(t.lpTf.y);
          // open end, then the listener's path to it
          t.lpEnd.y += kLpEnd * (tab - t.lpEnd.y);
          const reflb = -Ro * t.lpEnd.y;
          t.tb.write(reflb);
          let xb = tab - reflb;
          if (t.Dr > 0) {
            t.rad.write(xb);
            xb = t.rad.tap(t.Dr);
          }
          const ub = t.dc.step(xb);
          const dub = ub - t.uPrev;
          t.uPrev = ub;
          u += t.gain * ub;
          exD += t.gain * ((1 - exTilt) * ub + exTilt * kd * dub);
        }
      } else {
        // merge junction (X-pipe): secondaries <-> main pipe
        const pM = (2 * (asSum + gM * ml)) / (bankCount + gM);
        for (let b = 0; b < bankCount; b++) {
          const lb = lpSb[b];
          lb.y += kLpS * (pM - asA[b] - lb.y);
          sb[b].write(lb.y);
        }
        lpMf.y += kLpM * (pM - ml - lpMf.y);
        mf.write(lpMf.y);

        // muffler entrance X1: main / expansion chamber / quarter-wave stub
        lpQ.y += kLpQ * (qdOut - lpQ.y);
        const qa = Rq * lpQ.y;
        const pX1 = (2 * (mfa + rc * cbl + rq * qa)) / Y1;
        lpMb.y += kLpM * (pX1 - mfa - lpMb.y);
        mb.write(lpMb.y);
        lpCf.y += kLpMuff * (pX1 - cbl - lpCf.y);
        cf.write(lpCf.y);
        qd.write(pX1 - qa);

        // X2: chamber -> tailpipe
        const pX2 = (2 * (rc * caf + tbl)) / Y2;
        lpCb.y += kLpMuff * (pX2 - caf - lpCb.y);
        cb.write(lpCb.y);
        lpTf.y += kLpTail * (pX2 - tbl - lpTf.y);
        tf.write(lpTf.y);

        // open end: reflection (inverted, HF leaks out) + radiation (volume-velocity derivative)
        lpEnd.y += kLpEnd * (ta - lpEnd.y);
        const refl = -Ro * lpEnd.y;
        tb.write(refl);
        u = dcEx.step(ta - refl);
        const du = u - uPrev;
        uPrev = u;
        exD = (1 - exTilt) * u + exTilt * kd * du;
      }

      // ── noise sources ─────────────────────────────────────────────────────
      nzState ^= nzState << 13;
      nzState ^= nzState >>> 17;
      nzState ^= nzState << 5;
      const nz = (nzState >>> 0) * 4.656612873077393e-10 - 1;
      nzState ^= nzState << 13;
      nzState ^= nzState >>> 17;
      nzState ^= nzState << 5;
      const nz2 = (nzState >>> 0) * 4.656612873077393e-10 - 1;

      // broadband crack at the blowdown (open-exhaust rasp): noise burst per exhaust event
      {
        const ci = crackIn;
        crackIn = crackInN;
        crackInN = 0;
        if (ci > crackEnv) crackEnv = ci;
        else crackEnv *= crackK;
      }
      const crack = full && crackEnv > 1e-5 ? svfCrack.step(nz) * crackEnv * 2.2 : 0;

      let blkOut = 0;
      let intake = 0;
      let mech = 0;
      let whine = 0;
      let turbo = 0;
      let bov = 0;
      if (full) {
        // engine block modes excited by combustion
        const bi = blkIn * 0.05;
        blkIn = blkInN;
        blkInN = 0;
        blkOut = (blk0.step(bi) + blk1.step(bi) * 0.8 + blk2.step(bi) * 0.5) * blockGain;

        // intake: runner resonance + hiss, gated by the summed valve windows
        const w = win[(cyc * WIN_N) | 0];
        const mod = 1 - intakeMod + intakeMod * w;
        svfRun.step(nz);
        svfHiss.step(nz2);
        intake = (svfRun.bpn * 1.4 + svfHiss.lp * 0.6) * mod;

        // mechanical ticks + hiss
        const ti = tickIn;
        tickIn = tickInN;
        tickInN = 0;
        svfTick.step(ti);
        svfMech.step(nz);
        mech = svfTick.bpn * 2.2 + svfMech.bpn * mechHiss * 6;

        // turbo: spool whistle (+ twin detune), flutter, blow-off
        if (turboOn) {
          const fN = wF * invSr;
          wPh1 += fN;
          if (wPh1 >= 1) wPh1 -= 1;
          let tone = sinCyc(wPh1) + 0.28 * sinCyc(wrap1(wPh1 * 2));
          if (twin) {
            wPh2 += fN * 1.013;
            if (wPh2 >= 1) wPh2 -= 1;
            tone = 0.62 * tone + 0.62 * (sinCyc(wPh2) + 0.28 * sinCyc(wrap1(wPh2 * 2)));
          }
          let fl = 1;
          if (flutDepth > 0) {
            flutPh += flutRate * invSr;
            if (flutPh >= 1) flutPh -= 1;
            const q = 0.5 + 0.5 * sinCyc(flutPh);
            fl = 1 - flutDepth * (1 - q * q);
          }
          svfBreath.step(nz);
          turbo = (tone * wAmp + svfBreath.bpn * wAmp * 0.5) * fl;
          if (bovEnv > 0.002) {
            svfBov.step(nz2);
            bov = svfBov.bpn * bovEnv * 0.8;
            bovEnv *= bovK;
          }
        }

        // transmission whine: final-drive pinion (follows wheel speed) + input gear pair (follows rpm)
        whA1 += whK * (whTargetP - whA1);
        whA3 += whK * (whTargetQ - whA3);
        if (whA1 > 1e-4 || whA3 > 1e-4) {
          whPh1 += pinionHz * invSr;
          if (whPh1 >= 1) whPh1 -= 1;
          whPh3 += pairHz * invSr;
          if (whPh3 >= 1) whPh3 -= 1;
          const pin = sinCyc(whPh1) + (pinionHz * 2 < nyq ? 0.4 * sinCyc(wrap1(whPh1 * 2)) : 0);
          const pair = sinCyc(whPh3) + (pairHz * 2 < nyq ? 0.3 * sinCyc(wrap1(whPh3 * 2)) : 0);
          whine = (pin * whA1 + pair * whA3) * 0.05;
        }

        // supercharger: the lobe-pass whine and its harmonics (the rotor's own turn beneath them) and the hiss of the air. The belt
        // drive's speed fluctuates a little at the firing frequency, so every line has sidebands one firing frequency either side.
        if (blowOn) {
          scA += (blowTarget > scA ? blowKa : blowKr) * (blowTarget - scA);
          if (scA > 1e-4) {
            const bInc = blowInc0 + (blowInc1 - blowInc0) * fr;
            scPh += (bInc / blowLobes) * (1 + 0.03 * sinCyc(wrap1(nN * cyc)));
            if (scPh >= 1) scPh -= 1;
            const bl = wrap1(scPh * blowLobes);
            const tone =
              sinCyc(bl) + 0.12 * sinCyc(scPh) + blowW2 * sinCyc(wrap1(bl * 2)) + blowW3 * sinCyc(wrap1(bl * 3)) + blowW4 * sinCyc(wrap1(bl * 4));
            svfSc.step(nz2);
            turbo += (tone + 0.5 * svfSc.bpn) * scA * 0.05;
          }
        }
      } else {
        // A lite voice renders neither the block nor the ticks, but what feeds them (every combustion, every valve tick) must not pile
        // up: a voice promoted to full (an opponent coming within 80 m, a TV camera cutting onto a pack) used to throw the whole heap
        // into the resonators in one sample, a loud crack that grew with the seconds spent in lite (24 times the level of the engine
        // after one, 370 times after twenty). A blow-off that began in lite dies out unheard.
        blkIn = blkInN = tickIn = tickInN = 0;
        if (bovEnv > 0.002) bovEnv *= bovK;
      }

      // ── discrete event sounds: shift clunk, backfire pops ─────────────────
      let ev = 0;
      if (clunkIn !== 0) {
        const ci = clunkIn;
        clunkIn = 0;
        ev += clunkR1.step(ci * 0.06) + clunkR2.step(ci * 0.04);
      } else if (clunkR1.y1 > 1e-7 || clunkR1.y1 < -1e-7) {
        ev += clunkR1.step(0) + clunkR2.step(0);
      }
      if (clunkNoise > 0.001) {
        ev += nz * clunkNoise * 0.08;
        clunkNoise *= clunkNoiseK;
      }
      if (popEnv > 0.001) {
        popNoiseSvf.step(nz2);
        ev += popNoiseSvf.bpn * popEnv * 0.42;
        popEnv *= popEnvK;
      }
      if (popToneEnv > 0.001) {
        popTonePh += 95 * invSr;
        if (popTonePh >= 1) popTonePh -= 1;
        ev += sinCyc(popTonePh) * popToneEnv * 0.1;
        popToneEnv *= popToneK;
      }

      // ── interior / exterior mix ───────────────────────────────────────────
      cExE += dExE;
      cExI += dExI;
      cBlk += dBlk;
      cInt += dInt;
      cMech += dMech;
      cTur += dTur;
      cWh += dWh;
      cEv += dEv;
      cOut += dOut;
      const exI = cExI > 1e-4 || sIntNow > 0.002 ? lpInt2.step(lpInt.step(u)) : 0;
      let y = bov * lerp(0.7, 0.9, sIntNow) + exD * cExE + exI * cExI + crack * (cExE + 0.3 * cExI) + blkOut * cBlk + intake * cInt + mech * cMech + turbo * cTur + whine * cWh + ev * cEv;
      if (sIntNow > 0.002) {
        const cb1 = cabin2.step(cabin.step(y));
        y += (cb1 - y) * sIntNow;
      }
      out[o + i] = hpOut.step(y) * cOut;
      if (dbg) {
        const k = dbgOffset + i;
        dbg.exhaust[k] = exD * cExE + exI * cExI + crack * (cExE + 0.3 * cExI);
        dbg.intake[k] = intake * cInt;
        dbg.mech[k] = mech * cMech;
        dbg.block[k] = blkOut * cBlk;
        dbg.turbo[k] = turbo * cTur;
        dbg.whine[k] = whine * cWh;
        dbg.events[k] = ev * cEv;
      }
    }

    rng.s = nzState;
    this.ph = ph;
    this.uPrev = uPrev;
    this.wPh1 = wPh1;
    this.wPh2 = wPh2;
    this.whPh1 = whPh1;
    this.whPh3 = whPh3;
    this.whA1 = whA1;
    this.whA3 = whA3;
    this.scPh = scPh;
    this.scA = scA;
    this.clock += len;
    this.bovEnv = bovEnv;
    this.flutPh = flutPh;
    this.popEnv = popEnv;
    this.popToneEnv = popToneEnv;
    this.popTonePh = popTonePh;
    this.clunkNoise = clunkNoise;
    this.blkIn = blkIn;
    this.blkInN = blkInN;
    this.tickIn = tickIn;
    this.tickInN = tickInN;
    this.clunkIn = clunkIn;
    this.crackIn = crackIn;
    this.crackInN = crackInN;
    this.crackEnv = crackEnv;

    // keep denormals out of long silences
    for (let g = 0; g < G; g++) {
      if (f1[g] < 1e-20 && f1[g] > -1e-20) f1[g] = 0;
      if (f2[g] < 1e-20 && f2[g] > -1e-20) f2[g] = 0;
      if (s1[g] < 1e-20 && s1[g] > -1e-20) s1[g] = 0;
      if (s2[g] < 1e-20 && s2[g] > -1e-20) s2[g] = 0;
      if (p1[g] < 1e-20 && p1[g] > -1e-20) p1[g] = 0;
      if (p2[g] < 1e-20 && p2[g] > -1e-20) p2[g] = 0;
    }
  }

  private wobbleBlockPrev = 0;
  private idlenessPrev = 0;

  /**
   * The strength of one exhaust pulse of a cross-plane V8 relative to an even one, `t` the time of the event in samples. Three things
   * make a cross-plane's pulses unequal, and they are all strongest where the engine is slow and the pulses are single events:
   *
   *  - what the bank's pipe still holds of the last pulse. A bank fires 90, 180, 270 and 180 degrees apart; the pulse that comes 90
   *    degrees after another meets a pipe still full of it, with less pressure to drive it out (and a weaker blowdown), and the one
   *    after the long 270 degree gap meets an empty pipe. The pipe forgets a pulse in about `lopeTau`, a time and not an angle, so
   *    the memory gets longer than the gaps as the rpm rises and every pulse sees much the same pipe: the pattern fades into the roar.
   *    (Both banks are copies of each other 360 degrees apart, so this alone makes a pattern that repeats every crank turn: whole
   *    orders. The half orders, the lope itself, need the two pipes to differ, which is what the dual exhaust is.)
   *  - the cammed idle's irregularity: a big overlap leaves an idle that burns a little differently every cycle (a log-normal spread
   *    of the pulse strengths) and now and then a cylinder that hardly burns at all.
   *  - in lite quality, where the banks do not have pipes of their own, the loudness of the side the listener hears more of.
   */
  private pulseFactor(bank: number, t: number, lite: boolean): number {
    const V = this.V;
    const dt = (t - this.lopeT[bank]) / this.sr;
    this.lopeT[bank] = t;
    const held = this.lopeH[bank] * Math.exp(-Math.max(dt, 0) / V.lopeTau);
    this.lopeH[bank] = held + 1;
    const avg = this.lopeAvg;
    this.lopeAvg += 0.12 * (held - avg);
    let f = 1 - this.lopeDepth * (held / Math.max(avg, 0.15) - 1);
    f = f < 0.4 ? 0.4 : f > 1.5 ? 1.5 : f;
    const s = this.lumpSigma;
    if (s > 0.001) {
      f *= Math.exp(s * 1.732 * this.rng.g() - 0.5 * s * s + this.bankDrW * this.bankDr[bank]);
      if (this.rng.u() < this.misProb) f *= 0.2 + 0.25 * this.rng.u();
    }
    if (lite && V.dual) f *= V.dualGain[bank];
    return f;
  }

  /** Inject a backfire / crackle pop into a random header group. */
  private firePop(size: number): void {
    const g = (this.rng.u() * this.G) | 0;
    const a = size * this.V.popArea * (0.7 + 0.6 * this.rng.u());
    this.accP[g] += a;
    this.popEnv = Math.max(this.popEnv, size * (0.6 + 0.4 * (this.V.fcTail / 9500)));
    this.popToneEnv = Math.max(this.popToneEnv, size * 0.8);
  }
}

/** Nominal rpm range used for the loudness reference (the profile itself carries no rpm limits). */
const CAL_LIMITER = 8000;
/**
 * The nominal limiter of the loudness sweep. Small and medium engines are measured over 2800..8000 rpm; a big V8 (a 6.2 L turns to 6500, not 8000) over
 * its own range, since what is averaged is the exhaust's loudness at the rpm it actually runs at, and a pipe that rings at 7000 rpm
 * must not decide how loud the engine is at 4500. 5 L and below: 8000 as it always was; 6.5 L and up: 6200.
 */
function calLimiter(profile: EngineSoundProfile): number {
  return profile.displacement > 5 ? lerp(CAL_LIMITER, 6200, clamp01((profile.displacement - 5) / 1.5)) : CAL_LIMITER;
}
const calCache = new Map<string, number>();

/** Target exhaust RMS (dBFS), power-averaged over a WOT sweep: open exhausts are a little louder. */
export function exhaustTargetDb(openness: number): number {
  return -20.5 + 4.5 * openness;
}

/**
 * RMS of the exhaust layer (exterior) over a full-throttle sweep from 35 % to 100 % of the limiter,
 * power-averaged so that harmonic/resonance coincidences at single rpm values do not skew it.
 */
export function measureExhaustSweepRms(profile: EngineSoundProfile, sr: number, exGain: number, withCrack = true): number {
  const v = new EngineVoice(sr, profile, 99, exGain);
  if (!withCrack) v.V.crackAbs = 0;
  const i = v.inp;
  const lim = calLimiter(profile);
  i.limiterRpm = lim;
  i.redlineRpm = lim * 0.97;
  i.idleRpm = 900;
  i.throttle = 1;
  i.load = 1;
  i.boost = 0;
  i.quality = 2;
  i.rpm = lim * 0.35;
  const secs = 0.5;
  const n = Math.floor(sr * secs);
  const out = new Float32Array(n);
  const dbg = createEngineDebug(n);
  v.debug = dbg;
  for (let k = 0; k < n; k += 128) {
    i.rpm = lim * (0.35 + 0.65 * (k / n));
    const len = Math.min(128, n - k);
    v.debug = {
      exhaust: dbg.exhaust.subarray(k),
      intake: dbg.intake.subarray(k),
      mech: dbg.mech.subarray(k),
      block: dbg.block.subarray(k),
      turbo: dbg.turbo.subarray(k),
      whine: dbg.whine.subarray(k),
      events: dbg.events.subarray(k),
    };
    v.process(out.subarray(k), len);
  }
  let acc = 0;
  const a = Math.floor(n * 0.08); // skip the very first waveguide fill
  for (let k = a; k < n; k++) acc += dbg.exhaust[k] * dbg.exhaust[k];
  return Math.sqrt(acc / (n - a));
}

/**
 * Loudness calibration: returns the exhaust gain that lands the sweep-average exhaust RMS on
 * exhaustTargetDb(). Every profile (current or future) is then equally loud no matter how its
 * muffler topology attenuates. Cached per profile; costs ~15 ms once.
 */
export function calibratedExhaustGain(profile: EngineSoundProfile, sr: number): number {
  const key = [sr, profile.cylinders, profile.layout, profile.crankType, profile.displacement, profile.turbo ? 1 : 0, profile.exhaustOpenness, profile.brightness, profile.exhaustSystem ?? 'merged'].join('|');
  const hit = calCache.get(key);
  if (hit !== undefined) return hit;
  const rmsCrack = measureExhaustSweepRms(profile, sr, 0, true); // pulses off: crack only
  const pulses1 = measureExhaustSweepRms(profile, sr, 1, false); // crack off: pulses at unit gain
  const target = Math.pow(10, exhaustTargetDb(profile.exhaustOpenness) / 20);
  // total^2 = pulses^2 + crack^2 = target^2 (independent noise-like sources add in power)
  const wanted = Math.sqrt(Math.max(target * target - rmsCrack * rmsCrack, 0.04 * target * target));
  const g = pulses1 > 1e-12 ? wanted / pulses1 : 1;
  calCache.set(key, g);
  return g;
}
