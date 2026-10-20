/**
 * AI racing driver. Uses the same CarControls as the player.
 *
 * - Steering: path tracking on the racing line (curvature feedforward + lateral / heading feedback
 *   over a speed-dependent preview), with yaw-rate damping and countersteer for real slides. The curvature it asks
 *   for never exceeds what the tyres can give, so a car that has run wide cannot pile on steering and slide wider.
 * - Speed: the line's speed profile with anticipation, corrected for driving off the line. A throttle governor lifts
 *   while the front tyres push or the driven tyres slide, and in the wet a car that is catching up on the plan does
 *   not get full power in the middle of a corner.
 * - Traffic: plans a lateral offset from the racing line around nearby cars — gives room to cars
 *   alongside, commits to a passing side, follows at a time gap when there's no way by. On a slippery road the
 *   following is gentle and kinematic (it brakes in proportion to the deceleration it needs, with the car ahead's
 *   braking added, never in a panic; only a pass that is still inside the other car's lane is held to the firm gap
 *   law), lane changes slow down while the tyres are busy, and passes keep clear of kerbs, grass and gravel at the
 *   edge of the asphalt.
 * - Weather: everything that depends on the water on the road (speed profile, racing line, grip estimates, the wet
 *   racecraft) is derived from one number, set at construction and changed with setWetness(), which moves the driver to
 *   the new conditions over a couple of seconds instead of jumping.
 * - Nitro: the game says whether a shot is ready (`nitroReady`) and burning (`nitroOn`); the driver asks for one (`wantNitro`)
 *   on a straight with no corner within reach of the boosted car, and while it burns (and until the car is back down to the
 *   profile) it drives to what the corners ahead and its brakes allow, not to the profile, which is capped by the car's own power.
 * - Asks for a reset when stuck or facing the wrong way.
 */
import { Vector3 } from 'three';
import type { CarControls, CarDefinition, Difficulty, GroundSample, SurfaceType, TrackPoint, TrackRuntime, VehicleState } from '../core/contracts';
import { cloneEffects, isNeutral, type MechEffects } from '../core/mechanical';
import { NITRO_SECONDS } from '../core/nitro';
import { fitCar } from '../physics/compound';
import { peakPower } from '../physics/engine';
import { SURFACES, wetGripFactor, type SurfaceProps } from '../physics/surfaces';
import { awdTractionShare } from '../physics/traction';
import { carLineGrip, computeRacingLine, computeSpeedProfile, damageFactors, lineSurfaces, type LineSurfaces, type RacingLine, type SpeedProfile } from './racing-line';

export interface Skill {
  gripUse: number;
  brakeUse: number;
  pace: number;
  /** Amplitude (m) of slow line wander. */
  wander: number;
  /** Reaction to the start lights going out (s): min..max. */
  reaction: [number, number];
  /** Mean time between small mistakes (s; 0 = never) and their size (fraction over the target speed). */
  mistakeEvery: number;
  mistakeSize: number;
}

export const SKILL: Record<Difficulty, Skill> = {
  rookie: { gripUse: 0.8, brakeUse: 0.72, pace: 0.95, wander: 0.55, reaction: [0.3, 0.55], mistakeEvery: 45, mistakeSize: 0.07 },
  amateur: { gripUse: 0.86, brakeUse: 0.8, pace: 0.97, wander: 0.35, reaction: [0.24, 0.42], mistakeEvery: 80, mistakeSize: 0.05 },
  pro: { gripUse: 0.92, brakeUse: 0.88, pace: 0.99, wander: 0.18, reaction: [0.18, 0.3], mistakeEvery: 200, mistakeSize: 0.035 },
  alien: { gripUse: 0.965, brakeUse: 0.94, pace: 1, wander: 0.06, reaction: [0.14, 0.22], mistakeEvery: 0, mistakeSize: 0 },
};

const G = 9.81;
const RHO = 1.225;
/**
 * What a driver on a winter circuit adds to the share of the grip it uses (SKILL.gripUse). A studded tyre peaks wide and falls off
 * gently, so the quickest way round is at and a little over the peak, the car just sliding in the fast corners and caught with the
 * wheel: measured with a lone car (Isvik, all four cars), the lap time falls as the share rises up to a total of about 1.0 to 1.03,
 * and rises again beyond it, with the car running at 20 to 40 degrees of body slip.
 */
const WINTER_GRIP_USE = 0.06;
/**
 * The share of what the friction circle leaves for the driven axle that a driver on snow asks of the throttle. A lane change, a catch-up
 * after a mistake or the corner exit all use grip the corner has already used: with half the grip of asphalt the throttle that would be
 * nothing on a dry road is a spun axle here, and a car that has run wide on the outside of a sweeper is on its way to the snowbank.
 */
const WINTER_AX_USE = 1.1;
/** The most a car's engine and gearing can push it along (m/s^2), at any speed (the first gear's thrust). */
const THRUST_MAX = 1.5 * 9.81;
/** The throttle at which an engine neither pushes nor holds the car back (its own friction against what it makes): the thrust grows from here. */
const THR_NEUTRAL = 0.22;
/** Nitro: a car in this car's lane within this distance ahead (m) keeps the driver from firing a shot. */
const NITRO_CLEAR_AHEAD = 150;

// ── tuning ────────────────────────────────────────────────────────────────────
/** Water on the track at which the cautious behaviours are fully on is 1 / WET_RAMP (rain, 0.75, is past it). */
const WET_RAMP = 1.5;
/** setWetness: seconds over which the speed profile, the racing line and the wet parameters move to the new conditions. */
const WET_BLEND_SECONDS = 2;
/** setDamage: seconds over which the speed profile moves to the damaged car's (a driver notices a bent car within a second or two). */
const DAMAGE_BLEND_SECONDS = 1;
/** setDamage: the change in the grip or the downforce factors (see damageFactors) below which the profile is not worked out again. */
const DAMAGE_NOTICED = 0.002;
/** How far (m) beyond the asphalt edge the car's side may reach when passing, at 0 and at full water on a slippery edge. */
const EDGE_ALLOW_DRY = 0.2;
const EDGE_WET_MARGIN = 0.9;
/** Ground beyond the edge that keeps less than this share of the wet grip of asphalt counts as slippery. */
const SLIPPERY_RATIO = 0.8;
/** The slowest a lane change gets (share of its normal lateral speed) while the tyres are fully busy, on a wet road. */
const LATERAL_RATE_MIN = 0.15;
/** The steering never asks for more lateral acceleration than this share of the grip (plus the bank's help). */
const CURVATURE_GRIP = 1.05;
/** Throttle gain (per m/s of speed deficit) in the middle of a corner on a wet road, instead of the normal 0.35. */
const THROTTLE_GAIN_CORNER_WET = 0.03;
/** Slip angle / combined-slip thresholds (multiples of the tyre's peak) where the throttle governor starts and finishes lifting. */
const GOV_FRONT: [number, number] = [1.2, 2.0];
const GOV_REAR: [number, number] = [0.9, 1.6];
const GOV_DRIVEN: [number, number] = [1.2, 1.6];
/** On a dry road wheelspin only counts for the governor together with sideways slip: from this share of the peak slip angle, fading in over the span. */
const GOV_SPIN_FROM = 0.1;
const GOV_SPIN_SPAN = 0.3;
const GOV_MIN = 0.15;
/** Angle (rad) between the nose and the way the car travels from which it counts as a big slide (the wheels follow the travel, the throttle goes), and where that is complete. */
const SLIDE_FROM = 0.3;
const SLIDE_FULL = 0.5;
const GOV_RELEASE = 4;
/** Winter: the angle (rad) between the nose and the way the car travels from which it counts as a spin and the driver brakes, and where the braking is complete. */
const SPIN_FROM = 0.52;
const SPIN_FULL = 0.85;
/** Following: share of the tyres' deceleration used to settle behind a car, and the time gap (s) held (more in the wet). */
const FOLLOW_COMFORT = 0.5;
const FOLLOW_TIME_GAP = 0.3;
const FOLLOW_TIME_GAP_WET = 0.3;
const FOLLOW_REACTION = 0.3;
const FOLLOW_SOFT_GAIN = 0.04;
/** Braking for a car in the way: dead band (m/s^2), margin on the deceleration it takes, and the weight of the car's own braking. */
const BRAKE_DEAD_BAND = 0.4;
const BRAKE_MARGIN = 1.15;
const LEADER_BRAKE_WEIGHT = 1;

const _tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
const _f = new Vector3();
const _l = new Vector3();
const _gs: GroundSample = { height: 0, normal: new Vector3(0, 1, 0), surface: 'asphalt' };
const _hp = new Vector3();

/** How much wet grip a surface keeps compared with the wet road itself (asphalt, or packed snow on a winter circuit): an average road tyre. */
function wetGripRatio(surface: SurfaceType, road: SurfaceProps = SURFACES.asphalt): number {
  const sp = SURFACES[surface];
  return (sp.grip * Math.min(1.15, 0.7 * sp.wet)) / (road.grip * Math.min(1.15, 0.7 * road.wet));
}

/** Throttle factor from 1 (below the first threshold) down to GOV_MIN (past the second). */
function fade(u: number, t: [number, number]): number {
  return Math.max(GOV_MIN, Math.min(1, (t[1] - u) / (t[1] - t[0])));
}

const smooth01 = (x: number) => x * x * (3 - 2 * x);
const clampWetness = (w: number | undefined) => (w === undefined || !(w > 0) ? 0 : w > 1 ? 1 : w);

const hazardCache = new Map<string, Uint8Array>();
/**
 * For every point of the racing line: is the ground just beyond the asphalt edge slippery in the wet (kerb, grass, gravel,
 * sand: bit 0 = left, bit 1 = right)? Tarmac run-offs and concrete are not, so a car may use the whole width there.
 * (It is the track's, for a road tyre, and every car shares it. A racing slick would answer the same, ground by ground: loose ground
 * is slippery for it, and more so, and paved ground is the same for every tyre. The grip a car has on the ground under its own line
 * is its own: `surfGrip`, from `carLineGrip`.)
 */
function edgeHazards(track: TrackRuntime, line: RacingLine): Uint8Array {
  const road = SURFACES[track.info.winter ? 'snow' : 'asphalt'];
  const key = `${track.info.id}:${track.length.toFixed(1)}:${line.n}`;
  let h = hazardCache.get(key);
  if (h) return h;
  h = new Uint8Array(line.n);
  // (on a winter circuit the metre of packed snow at the edge is as good as the road: the trouble is the deep snow beyond it)
  const out = track.info.winter ? 1.5 : 0.5;
  for (let i = 0; i < line.n; i++) {
    const sa = i * line.step;
    const j = Math.min(track.count - 1, Math.round(sa / track.spacing));
    track.pointAt(sa, track.widthLeft[j] + out, _hp);
    track.groundAt(_hp.x, _hp.z, _gs);
    if (wetGripRatio(_gs.surface, road) < SLIPPERY_RATIO) h[i] |= 1;
    track.pointAt(sa, -(track.widthRight[j] + out), _hp);
    track.groundAt(_hp.x, _hp.z, _gs);
    if (wetGripRatio(_gs.surface, road) < SLIPPERY_RATIO) h[i] |= 2;
  }
  hazardCache.set(key, h);
  return h;
}

export interface AIDriverOptions {
  difficulty: Difficulty;
  /** Per-driver variation seed. */
  seed: number;
  /** Water on the track (0..1): slower corners, earlier braking, wheels kept off the kerbs, gentler racecraft. */
  wetness?: number;
}

export class AIDriver {
  readonly skill: Skill;
  /** Set when the car is stuck or facing the wrong way; the game resets it to the track. */
  needsReset = false;
  /** Current track position (updated every update). */
  s = 0;
  d = 0;
  /** Set by the game before update(): a nitro shot is ready to fire, and one is burning. */
  nitroReady = false;
  nitroOn = false;
  /** Set by update(): the driver wants to fire a nitro shot now. */
  wantNitro = false;
  /** Faster than the profile after a nitro shot: the corners ahead and the brakes set the speed until the car is back on it. */
  private overspeed = false;
  /** How long the conditions for a shot have held, and how long this driver waits for them (drawn for each shot). */
  private nitroWait = 0;
  private nitroDelay = -1;
  /** The driver's own random stream for nitro, apart from rand() so the rest of its behaviour stays as it always was. */
  private nitroRng: number;
  /** No car alongside, and none ahead in this car's lane within NITRO_CLEAR_AHEAD (planTraffic): a shot would not run into anybody. */
  private nitroClear = true;

  // ── weather: all derived from the wetness (see applyWetness / setWetness) ──
  /** Water on the track the driver is working with now (0..1). While setWetness is blending it is somewhere between the old and the new. */
  private wetness = 0;
  /** Asphalt grip factor for the weather (1 when dry). */
  private wetMu = 1;
  /** 0 on a dry road, 1 once the road is wet enough for the cautious behaviours to be fully on. */
  private wetF = 0;
  private readonly tireWet: number;
  /** Peak friction coefficient of the weaker axle (dry), downforce acceleration per (m/s)^2, braking acceleration at full pedal. */
  private readonly gripMu: number;
  private readonly cDown: number;
  /** What mechanical damage has left of the car (setDamage): the grip of its weaker axle, the downforce of its weaker end. Both 1 on a sound car. */
  private dmgGrip = 1;
  private dmgAero = 1;
  private dmg: MechEffects | null = null;
  private readonly brakeGain: number;
  private readonly alphaPkF: number;
  private readonly alphaPkR: number;
  /** Which axles take the drive: the rear (rear- and all-wheel drive) and the front (front- and all-wheel drive). */
  private readonly rearDriven: boolean;
  private readonly frontDriven: boolean;
  /** Slippery ground beyond the asphalt edge along the line (bit 0 left, bit 1 right); all clear on a dry road. */
  private hazard!: Uint8Array;
  private hazardMask: Uint8Array | null = null;
  private hazardNone: Uint8Array | null = null;
  /** The gentle, kinematic following law (for slippery roads); a dry road keeps the firm gap law. */
  private softFollow = false;
  private govern = 1;
  /** Grip usage (0..1+) of the last update: measured acceleration over what the tyres can give. */
  usage = 0;

  private hint = -1;
  private offset = 0;
  private prevOffset: number | null = null;
  private stuckTime = 0;
  private wrongTime = 0;
  private wanderPhase: number;
  private readonly paceJitter: number;
  private readonly halfWidth: number;
  private time = 0;
  /** Final speed target and traffic cap of the last update (m/s), for probes. */
  dbgVT = 0;
  dbgCap = Infinity;
  private dbgSteer = { lineD: 0, dDes: 0, ey: 0, epsi: 0, kff: 0, kappa: 0, yawErr: 0, delta: 0, Lp: 0 };
  /** Steering state of the last update, for probes. */
  get debug(): string {
    const d = this.dbgSteer;
    return `lineD=${d.lineD.toFixed(2)} dDes=${d.dDes.toFixed(2)} ey=${d.ey.toFixed(2)} epsi=${d.epsi.toFixed(3)} kff=${(d.kff * 1000).toFixed(2)} kap=${(d.kappa * 1000).toFixed(2)} yawErr=${d.yawErr.toFixed(3)} delta=${d.delta.toFixed(3)} Lp=${d.Lp.toFixed(1)}`;
  }
  /** Traffic planner state of the last update, for probes. */
  get debugTraffic(): string {
    let dbg = `side=[${this.dbgSideLo.toFixed(1)},${this.dbgSideHi.toFixed(1)}] ob=`;
    for (let k = 0; k < this.nOb; k++) dbg += `(${this.obLo[k].toFixed(1)}..${this.obHi[k].toFixed(1)} g${this.obGap[k].toFixed(0)} room${this.obRoomLo[k].toFixed(1)}/${this.obRoomHi[k].toFixed(1)} side${this.others.get(this.obId[k])?.side})`;
    return `off=${this.offset.toFixed(2)} plan=${this.planTarget.toFixed(2)} env=[${this.envLo.toFixed(1)},${this.envHi.toFixed(1)}] ${dbg} cap=${this.dbgCap === Infinity ? '-' : (this.dbgCap * 3.6).toFixed(0)}`;
  }
  private readonly up = new Vector3();

  /** The car as it is fitted for this track (winter tyres on a winter circuit). */
  readonly def: CarDefinition;
  /** The surface the road is made of at each point of the line (the grip under the car: ice on a frozen lake is not packed snow). */
  private readonly surfaces: LineSurfaces;
  /** The grip of that surface for this car's tyres, relative to asphalt: the track's own numbers (the same array) for a car on road tyres. */
  private readonly surfGripAt: Float32Array;
  /** The road's own surface: asphalt, or packed snow on a winter circuit: what the water (fresh snow) acts on. */
  private readonly road: SurfaceProps;
  /** A winter circuit: the road is slippery all the time (the cautious racecraft of a wet road is on whatever the snow), the line keeps off the edge. */
  private readonly winter: boolean;
  /** The engine's power at the wheels per kilogram of car (W/kg): the thrust it has at a speed v is this over v. */
  private readonly powerPerKg: number;
  /** The share of the car's weight on the driven axle (a little more for the load it picks up under power). */
  private readonly drivenShare: number;
  /** Aerodynamic drag per kilogram and per (m/s)^2. */
  private readonly cDrag: number;

  constructor(
    readonly track: TrackRuntime,
    def: CarDefinition,
    opts: AIDriverOptions,
  ) {
    this.def = def = fitCar(def, track);
    this.winter = track.info.winter === true;
    this.road = SURFACES[this.winter ? 'snow' : 'asphalt'];
    const base = SKILL[opts.difficulty];
    const r = fract(Math.sin(opts.seed * 12.9898) * 43758.5453);
    this.paceJitter = 1 - 0.018 * r;
    this.wanderPhase = r * 100;
    this.rng = ((opts.seed * 2654435761) ^ 0x9e3779b9) >>> 0 || 1;
    this.nitroRng = (this.rng ^ 0x5bd1e995) >>> 0 || 1;
    this.skill = base;
    this.halfWidth = def.visual.width / 2;
    const wet = clampWetness(opts.wetness);
    this.tireWet = Math.min(def.physics.tireFront.wetGrip ?? 0.72, def.physics.tireRear.wetGrip ?? 0.72);
    this.lineCur = this.racingLine(wet > 0);
    this.surfaces = lineSurfaces(track, this.lineCur);
    // (a car on all-terrain tyres has more grip than the track's table says on loose ground, a car on slicks a good deal less; the line seldom
    // crosses any, but a grass or gravel verge it may touch is not the same verge to a Mammoth, a Vanta and an LMP-X)
    this.surfGripAt = carLineGrip(this.surfaces, def.physics);
    this.lineLam = this.lineLamTo = wet > 0 ? 1 : 0;
    this.profCur = this.profileFor(this.lineCur, wet);
    this.wetFrom = this.wetTo = wet;
    this.applyWetness(wet);
    this.mistakeIn = this.nextMistake();
    const ph = def.physics;
    this.gripMu = Math.min(ph.tireFront.mu, ph.tireRear.mu);
    this.cDown = (0.5 * RHO * (ph.aero.liftAreaFront + ph.aero.liftAreaRear)) / ph.chassis.mass;
    this.brakeGain = ((2 * ph.brakes.frontTorque) / ph.tireFront.radius + (2 * ph.brakes.rearTorque) / ph.tireRear.radius) / ph.chassis.mass;
    this.alphaPkF = ph.tireFront.peakSlipAngle;
    this.alphaPkR = ph.tireRear.peakSlipAngle;
    this.rearDriven = ph.drivetrain.layout !== 'FWD';
    this.frontDriven = ph.drivetrain.layout !== 'RWD';
    this.powerPerKg = (peakPower(ph.engine).watts * ph.drivetrain.efficiency * 0.92) / ph.chassis.mass;
    const wb = ph.chassis.wheelbase;
    const cgA = ph.chassis.cgToFrontAxle;
    this.drivenShare = ph.drivetrain.layout === 'FWD' ? ((wb - cgA) / wb) * 0.92 : ph.drivetrain.layout === 'RWD' ? Math.min(1, (cgA / wb) * 1.1) : awdTractionShare(ph);
    this.cDrag = (0.5 * RHO * ph.aero.dragArea) / ph.chassis.mass;
  }

  // ── weather ─────────────────────────────────────────────────────────────────
  /** The racing line in use: the dry or the wet one, or a mix of the two while the weather is changing. */
  get line(): RacingLine {
    return this.lineCur;
  }
  /** The speed profile in use (on its way to the new one while the weather is changing). */
  get profile(): SpeedProfile {
    return this.profCur;
  }
  private lineCur!: RacingLine;
  private profCur!: SpeedProfile;
  /** The two lines the driver can follow (cached per track and car width, computed when first needed) and a scratch mix of them. */
  private lineDry: RacingLine | null = null;
  private lineWet: RacingLine | null = null;
  private lineMix: RacingLine | null = null;
  /** Share of the wet line in the line in use (0..1), and where it is heading. */
  private lineLam = 0;
  private lineLamTo = 0;
  /** The blend towards a new wetness: where it started, where it ends, how far along it is (0..1) and how long it takes (s). */
  private wetFrom = 0;
  private wetTo = 0;
  private blendT = 1;
  private blendSpan = WET_BLEND_SECONDS;
  private profFrom: Float32Array | null = null;
  private profTo: Float32Array | null = null;

  /** Racing line for a dry road or a wet one: in the wet, painted kerbs are ice, so the line keeps the wheels on the asphalt. */
  private racingLine(wet: boolean): RacingLine {
    // (on a winter circuit the snowbank is no place for a wheel: the line keeps off the edge, wet or not, and the two lines are one)
    if (this.winter) {
      this.lineWet ??= computeRacingLine(this.track, { edgeMargin: this.halfWidth - 0.25 + 0.45 });
      return (this.lineDry ??= this.lineWet);
    }
    if (wet) return (this.lineWet ??= computeRacingLine(this.track, { edgeMargin: this.halfWidth - 0.25 + 0.45 }));
    return (this.lineDry ??= computeRacingLine(this.track, { edgeMargin: this.halfWidth - 0.25 + 0 }));
  }

  private profileFor(line: RacingLine, wet: number): SpeedProfile {
    return computeSpeedProfile(this.track, line, this.def, { gripUse: this.skill.gripUse + (this.track.info.winter ? WINTER_GRIP_USE : 0), brakeUse: this.skill.brakeUse, wetness: wet, damage: this.dmg });
  }

  /** Everything the driver works out from the water on the road, except the line and the profile. */
  private applyWetness(w: number): void {
    this.wetness = w;
    this.wetF = this.winter ? 1 : Math.min(1, w * WET_RAMP);
    this.softFollow = this.wetF >= 0.5;
    this.wetMu = wetGripFactor(w, this.tireWet, this.road, 0);
    if (w > 0 || this.winter) this.hazard = this.hazardMask ??= edgeHazards(this.track, this.lineCur);
    else this.hazard = this.hazardNone ??= new Uint8Array(this.lineCur.n);
  }

  /**
   * The water on the track has changed (0 = dry .. 1 = standing water): work out the speed profile, the racing line, the
   * grip and braking estimates and the wet-weather racecraft for it, as a driver built at that wetness would. The
   * driver moves to the new conditions over `blendSeconds` of its own time (advanced by update()), so a car in the middle
   * of a corner does not see its target speed or its line jump; 0 makes the change at once.
   *
   * Cost: one speed profile, about 1 to 2 ms per car (3 ms at worst; 1 000 to 1 700 points, not cached) and about 0.01 ms
   * per update() while it blends, plus the racing line the first time the driver needs the other weather's line (about
   * 0.1 to 0.2 s per track and car width, cached and shared by every car of that width; prepareWeather() does it in advance).
   */
  setWetness(w: number, blendSeconds = WET_BLEND_SECONDS): void {
    const wet = clampWetness(w);
    if (!Number.isFinite(blendSeconds)) blendSeconds = WET_BLEND_SECONDS;
    if (wet === this.wetTo) {
      if (blendSeconds <= 0) this.finishBlend();
      return;
    }
    this.startBlend(wet, blendSeconds);
  }

  /** Work out the profile (and line) for water `wet` and the damage the car has, and start moving the driver to it. */
  private startBlend(wet: number, blendSeconds: number): void {
    const lineTo = this.racingLine(wet > 0);
    const profTo = this.profileFor(lineTo, wet).v;
    // (a change that interrupts a blend starts from where the driver is now)
    this.profFrom ??= new Float32Array(profTo.length);
    this.profFrom.set(this.profCur.v);
    this.profTo = profTo;
    this.wetFrom = this.wetness;
    this.wetTo = wet;
    this.lineLamTo = wet > 0 ? 1 : 0;
    this.blendT = 0;
    this.blendSpan = blendSeconds;
    if (blendSeconds <= 0) this.finishBlend();
  }

  /**
   * The car has mechanical damage (src/core/mechanical.ts), or has been repaired (null): less downforce and grip. The driver works
   * out the speed profile of the car as it is now (a part of what the damage took: see damageFactors) and moves to it over
   * `blendSeconds`: it brakes earlier and carries less speed, most of all where the downforce used to carry it. The pull of bent
   * suspension and the loss of power need no telling: the steering already corrects the lateral error the first causes, and a
   * driver that has the throttle flat out wherever the profile asks for more than the car has meets the second as it comes.
   *
   * Cost: one speed profile, about 1 to 2 ms (see setWetness), when the damage changes.
   */
  setDamage(e: MechEffects | null, blendSeconds = DAMAGE_BLEND_SECONDS): void {
    const fx = e && !isNeutral(e) ? cloneEffects(e) : null;
    if (!fx && !this.dmg) return;
    if (!Number.isFinite(blendSeconds)) blendSeconds = DAMAGE_BLEND_SECONDS;
    const f = damageFactors(fx);
    // a change too small to alter the profile (the tap of a pack race) is not worth working it out again: the driver keeps the
    // damage, the factors and the profile it has, which stay in step with one another
    if (Math.abs(f.grip - this.dmgGrip) < DAMAGE_NOTICED && Math.abs(f.aero - this.dmgAero) < DAMAGE_NOTICED) return;
    this.dmg = fx;
    this.dmgGrip = f.grip;
    this.dmgAero = f.aero;
    this.startBlend(this.wetTo, blendSeconds);
  }

  /**
   * Computes (and caches) the racing line of the other weather, so that a later setWetness() across dry and wet costs
   * only the speed profile. Worth calling while a race loads if the weather may change during it.
   */
  prepareWeather(): void {
    this.racingLine(false);
    this.racingLine(true);
  }

  /** The conditions the driver is heading for are reached: line, profile and parameters are exactly those of a driver built there. */
  private finishBlend(): void {
    if (this.profTo) this.profCur.v.set(this.profTo);
    this.profTo = null;
    this.blendT = 1;
    this.lineLam = this.lineLamTo;
    this.lineCur = this.lineLam > 0 ? this.lineWet! : this.lineDry!;
    this.wetFrom = this.wetTo;
    this.applyWetness(this.wetTo);
  }

  private advanceBlend(dt: number): void {
    const step = dt / Math.max(1e-3, this.blendSpan);
    this.blendT += step;
    if (this.blendT >= 1) {
      this.finishBlend();
      return;
    }
    const a = smooth01(this.blendT);
    const v = this.profCur.v;
    const from = this.profFrom!;
    const to = this.profTo!;
    for (let i = 0; i < v.length; i++) v[i] = from[i] + (to[i] - from[i]) * a;
    // the line moves from one weather's to the other's (from wherever it was, if the change interrupted another)
    this.lineLam = this.lineLamTo > this.lineLam ? Math.min(this.lineLamTo, this.lineLam + step) : Math.max(this.lineLamTo, this.lineLam - step);
    if (this.lineLam <= 0) this.lineCur = this.lineDry!;
    else if (this.lineLam >= 1) this.lineCur = this.lineWet!;
    else this.mixLines(smooth01(this.lineLam));
    this.applyWetness(this.wetFrom + (this.wetTo - this.wetFrom) * a);
  }

  /** The line in use as a blend of the dry line (a = 0) and the wet line (a = 1). */
  private mixLines(a: number): void {
    const A = this.lineDry!;
    const B = this.lineWet!;
    const m = (this.lineMix ??= { n: A.n, step: A.step, d: new Float32Array(A.n), x: new Float32Array(A.n), z: new Float32Array(A.n), k: new Float32Array(A.n), ds: new Float32Array(A.n) });
    for (let i = 0; i < A.n; i++) {
      m.d[i] = A.d[i] + (B.d[i] - A.d[i]) * a;
      m.x[i] = A.x[i] + (B.x[i] - A.x[i]) * a;
      m.z[i] = A.z[i] + (B.z[i] - A.z[i]) * a;
      m.k[i] = A.k[i] + (B.k[i] - A.k[i]) * a;
      m.ds[i] = A.ds[i] + (B.ds[i] - A.ds[i]) * a;
    }
    this.lineCur = m;
  }

  /** What the tyres can give in any horizontal direction at speed v (m/s^2): wet grip, aquaplaning and downforce included. */
  private gripAccel(v: number): number {
    const wetF = this.wetness > 0 ? wetGripFactor(this.wetness, this.tireWet, this.road, v) : 1;
    return this.gripMu * this.dmgGrip * wetF * (G + this.cDown * this.dmgAero * v * v);
  }

  /** The grip of the surface under the racing line at track position s, relative to asphalt (1 on a road of asphalt). */
  private surfGrip(s: number): number {
    const g = this.surfGripAt;
    return g[Math.floor(this.track.wrapS(s) / this.line.step + 0.5) % g.length];
  }

  /** The least grip under the line from here up to `dist` m ahead: what a driver has to brake for. */
  private surfGripAhead(s: number, dist: number): number {
    let m = this.surfGrip(s);
    for (let x = this.line.step; x <= dist; x += this.line.step) m = Math.min(m, this.surfGrip(s + x));
    return m;
  }

  /** Target speed at track position s (m/s), with this driver's pace. */
  targetSpeed(s: number): number {
    const line = this.line;
    const f = this.track.wrapS(s) / line.step;
    const i = Math.floor(f) % line.n;
    const b = (i + 1) % line.n;
    const t = f - Math.floor(f);
    return (this.profile.v[i] * (1 - t) + this.profile.v[b] * t) * this.skill.pace * this.paceJitter * this.mistakeMul;
  }

  // ── human touches: start reaction, the odd mistake ─────────────────────────
  private rng: number;
  private wasRacing = false;
  private reactLeft = 0;
  private mistakeIn = 0;
  private mistakeLeft = 0;
  private mistakeMul = 1;
  private rand(): number {
    // xorshift32, seeded per driver: deterministic races for tests and replays
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return this.rng / 4294967296;
  }
  private nextMistake(): number {
    const m = this.skill.mistakeEvery;
    return m > 0 ? m * (0.4 + 1.2 * this.rand()) : Infinity;
  }
  /** Mistake window: carries a little too much speed into whatever comes next for ~2.5 s. */
  private updateMistakes(dt: number, v: number): void {
    if (this.mistakeLeft > 0) {
      this.mistakeLeft -= dt;
      if (this.mistakeLeft <= 0) this.mistakeMul = 1;
      return;
    }
    this.mistakeIn -= dt;
    if (this.mistakeIn <= 0 && v > 20) {
      this.mistakeMul = 1 + this.skill.mistakeSize * (0.6 + 0.8 * this.rand());
      this.mistakeLeft = 2 + this.rand();
      this.mistakeIn = this.nextMistake();
    }
  }

  update(dt: number, me: VehicleState, others: readonly VehicleState[], c: CarControls, racing: boolean): void {
    if (this.blendT < 1) this.advanceBlend(dt);
    const tr = this.track;
    const line = this.line;
    const def = this.def;
    this.time += dt;
    this.hint = tr.project(me.position.x, me.position.z, _tp, this.hint);
    const s = _tp.s;
    this.s = s;
    this.d = _tp.d;
    const v = Math.max(0, me.forwardSpeed);
    _f.set(0, 0, 1).applyQuaternion(me.quaternion);
    _l.set(1, 0, 0).applyQuaternion(me.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(me.quaternion);

    // lights out: a human-ish reaction before the launch
    if (racing && !this.wasRacing) this.reactLeft = this.skill.reaction[0] + (this.skill.reaction[1] - this.skill.reaction[0]) * this.rand();
    this.wasRacing = racing;
    if (this.reactLeft > 0) this.reactLeft -= dt;
    if (!racing || this.reactLeft > 0) {
      // on the grid: hold revs, wheels straight, foot on the brake until we react
      c.steer = 0;
      c.throttle = 0.35 + 0.15 * Math.sin(this.time * 3 + this.wanderPhase);
      c.brake = racing ? 1 : 0;
      c.handbrake = 0;
      return;
    }
    this.updateMistakes(dt, Math.max(0, me.forwardSpeed));

    // ── how much of the tyres' grip is in use right now (measured accelerations vs what they can give) ──
    const sGrip = this.surfGrip(s);
    const aGrip = this.gripAccel(v) * sGrip;
    const aLatM = Math.abs(me.localAccel.x);
    const aLongM = me.localAccel.z;
    this.usage = Math.min(1.3, Math.hypot(aLatM, aLongM) / Math.max(aGrip, 2));

    // ── traffic: plan a lateral offset (relative to the racing line) around the cars nearby ──
    const lineD = this.lineOffsetAt(s);
    const myOff = _tp.d - lineD;
    const myWL = _tp.widthLeft;
    const myWR = _tp.widthRight;
    const myD = _tp.d;
    const myTx = _tp.tx;
    const myTz = _tp.tz;
    const wander = this.skill.wander * Math.sin(this.time * 0.35 + this.wanderPhase);
    this.offsetEnvelope(s, v);
    const speedCap = this.planTraffic(s, v, myOff, wander, me, others, aGrip);
    // move the offset toward the plan: low-pass, then a lateral rate limit. On a wet road a lane change is cornering
    // too: it slows down while the tyres are busy (unless a car beside leaves no choice)
    const kOff = 1 - Math.exp(-dt * 2.2);
    const want = this.offset + (this.planTarget - this.offset) * kOff;
    let latScale = 1;
    if (this.wetF > 0 && !this.forceMove) latScale = 1 - this.wetF * (1 - Math.max(LATERAL_RATE_MIN, Math.min(1, 1.25 - this.usage * this.usage * 1.1)));
    // (on snow a lane change is cornering with half the grip to do it in: the same lateral acceleration takes twice the distance)
    const gripScale = this.winter ? Math.max(0.3, sGrip) : 1;
    const rate = (1.2 + 0.05 * v) * dt * latScale * gripScale;
    this.offset += Math.max(-rate, Math.min(rate, want - this.offset));

    // ── steering: path following on the (offset) racing line ──
    // Curvature feedforward from the line just ahead, plus feedback on lateral and course error
    // over a preview distance (a linearised pure pursuit that doesn't cut the inside of corners).
    const L = def.physics.chassis.wheelbase;
    const dDes = lineD + Math.max(this.envLo, Math.min(this.envHi, this.offset));
    const ey = myD - dDes; // + = left of the planned path
    const fl = tr.wrapS(s) / line.step;
    const li = Math.floor(fl) % line.n;
    const lb = (li + 1) % line.n;
    let ptx = line.x[lb] - line.x[li];
    let ptz = line.z[lb] - line.z[li];
    const pl = Math.hypot(ptx, ptz) || 1;
    ptx /= pl;
    ptz /= pl;
    // body heading (not the course): a rotating car then sees its own yaw and countersteers,
    // which is what keeps a sliding RWD car stable
    const vel = me.velocity;
    const cx = _f.x;
    const cz = _f.z;
    // signed angle of the heading relative to the path (+ = pointing left), minus the planned drift
    // planned lateral drift: rate of the effective (edge-clamped) offset
    const offEff = dDes - lineD;
    const offVel = this.prevOffset === null ? 0 : (offEff - this.prevOffset) / Math.max(dt, 1e-3);
    this.prevOffset = offEff;
    // a turning car's nose points outward of its travel by the kinematic body slip (rear axle
    // tracks inside): add it back so a hairpin doesn't read as a heading error
    const yawRate = me.angularVelocity.x * this.up.x + me.angularVelocity.y * this.up.y + me.angularVelocity.z * this.up.z;
    const bRear = L - def.physics.chassis.cgToFrontAxle;
    const betaKin = Math.atan((bRear * yawRate) / Math.max(v, 5));
    const epsi = Math.atan2(cx * ptz - cz * ptx, cx * ptx + cz * ptz) + betaKin - Math.atan(offVel / Math.max(v, 5));
    // feedforward: mean line curvature over the next ~0.15 s, corrected for the lateral offset
    let kff = 0;
    for (let k = 1; k <= 3; k++) {
      const fi = Math.floor(tr.wrapS(s + v * 0.05 * k) / line.step) % line.n;
      kff += line.k[fi];
    }
    kff /= 3;
    kff /= Math.max(0.5, 1 - kff * offEff);
    const Lp = 7 + 0.5 * v;
    let kappa = kff - (2 * ey) / (Lp * Lp) - (2 * Math.sin(epsi)) / Lp;
    if (v > 12) {
      // never ask for more lateral acceleration than the tyres can give (the bank helps): a car that has run wide
      // would otherwise pile on steering and slide even wider. (The line's own curvature always passes.)
      const bank = tr.bank[Math.min(tr.count - 1, _tp.segment)];
      const help = Math.max(0, -Math.sign(kappa) * Math.sin(bank)) * G;
      const aLong = Math.min(Math.abs(aLongM), aGrip * 0.9);
      const aMax = Math.sqrt(Math.max(0, aGrip * aGrip - aLong * aLong)) * CURVATURE_GRIP + help;
      const kLim = Math.max(aMax / (v * v), Math.abs(kff) * 1.02);
      kappa = Math.max(-kLim, Math.min(kLim, kappa));
    }
    // kinematic angle + the slip angle the front tires need for this lateral acceleration
    const ph = def.physics;
    const aLat = v * v * kappa;
    const muG = 9.81 * ph.tireFront.mu * this.wetMu * sGrip;
    let delta = Math.atan(L * kappa) + ph.tireFront.peakSlipAngle * Math.max(-1.2, Math.min(1.2, aLat / muG)) * 0.85;
    // yaw-rate tracking: steer against yaw rate that differs from what the path asks for
    // (gentler at hairpin speeds, where the loop through the tires would otherwise ring)
    if (v > 4) delta += (0.08 + 0.12 * Math.min(1, Math.max(0, (v - 8) / 14))) * (kappa * v - yawRate);
    // slide correction: point the front wheels along the direction of travel
    const vLat = vel.x * _l.x + vel.z * _l.z;
    const vLong = vel.x * _f.x + vel.z * _f.z;
    if (vLong > 4) {
      // only the slip beyond the kinematic body slip of a car turning at this yaw rate is a slide
      // (in a hairpin the rear axle tracks inside, so the CG velocity points in without sliding)
      const beta = Math.atan2(vLat, vLong) - Math.atan((bRear * yawRate) / vLong);
      if (Math.abs(beta) > 0.04) delta += 0.55 * (beta - 0.04 * Math.sign(beta));
    }
    // a car that has let go (on snow it takes a long slide to get there, and the path it is asked for pulls the wheels the wrong way while it
    // is in one): point the wheels along the way it is travelling and get off the throttle, whatever the path asks, until it bites again
    const slideAng = me.speed > 5 ? Math.atan2(vLat, Math.max(vLong, 0.2 * me.speed)) : 0;
    const bigSlide = smooth01(Math.min(1, Math.max(0, (Math.abs(slideAng) - SLIDE_FROM) / (SLIDE_FULL - SLIDE_FROM))));
    if (bigSlide > 0) delta += (slideAng * 1.1 - delta) * bigSlide;
    const maxSteer = def.physics.chassis.maxSteer;
    const dbg = this.dbgSteer;
    dbg.lineD = lineD;
    dbg.dDes = dDes;
    dbg.ey = ey;
    dbg.epsi = epsi;
    dbg.kff = kff;
    dbg.kappa = kappa;
    dbg.yawErr = kappa * v - yawRate;
    dbg.delta = delta;
    dbg.Lp = Lp;
    c.steer = Math.max(-1, Math.min(1, -delta / maxSteer));
    c.handbrake = 0;

    // ── speed: track the profile slightly ahead; brake early for slower points ahead ──
    let vT = this.targetSpeedOff(s + v * 0.3 + 2, this.offset);
    // anticipate: the slowest requirement within the next ~1.2 s, discounted by distance
    const brakeCap = 9.81 * Math.min(def.physics.tireFront.mu, def.physics.tireRear.mu) * this.dmgGrip * this.wetMu * this.skill.brakeUse * 0.9 * this.surfGripAhead(s, 8 + v * 1.3);
    for (let k = 1; k <= 6; k++) {
      const ahead = v * 0.2 * k + 4;
      const va = this.targetSpeedOff(s + ahead, this.offset);
      const allowed = Math.sqrt(va * va + 2 * brakeCap * Math.max(0, ahead - v * 0.12));
      if (allowed < vT) vT = allowed;
    }
    // nitro: the profile is capped by the car's own power, so a boosted car would lift for it. While a shot burns, and after it until
    // the car has come back down to the profile, the speed is what the corners ahead and the brakes allow (the traffic below still
    // has its say); after the shot the car coasts down to the profile rather than braking for it on a straight.
    if (this.nitroOn || this.overspeed) {
      const vC = this.cornerBrakeSpeed(s, v, brakeCap);
      if (this.nitroOn) {
        this.overspeed = true;
        vT = Math.min(vC, Math.max(vT, v + 10));
      } else if (v <= vT + 0.5) this.overspeed = false;
      else vT = Math.min(vC, Math.max(vT, v - 0.8));
    }
    // (the gentle following law keeps the traffic cap apart: it is a spacing target, not a speed the car must hit; only a
    // pass that is still inside the other car's lane is held to a hard gap)
    if (!this.softFollow && speedCap < vT) vT = speedCap;
    if (this.softFollow && this.capHard < vT) vT = this.capHard;
    // off the asphalt: back off a bit
    if (myD > myWL + 0.5 || myD < -myWR - 0.5) vT *= 0.8;
    this.dbgVT = vT;
    this.dbgCap = speedCap;
    const e = vT - v;
    let thr: number;
    let brk: number;
    if (e >= 0) {
      // on a wet road a car catching up on the plan does not get full power in the middle of a corner: the driven axle
      // is already using its grip to turn, and it is what spins
      let gain = 0.35;
      if (this.wetF > 0) {
        const lat = Math.min(1, Math.max(0, (aLatM / aGrip - 0.3) / 0.4));
        gain = 0.35 + (THROTTLE_GAIN_CORNER_WET - 0.35) * lat * lat * (3 - 2 * lat) * this.wetF;
      }
      thr = Math.min(1, 0.3 + gain * e);
      brk = 0;
    } else {
      thr = Math.max(0, 0.3 + 0.35 * e);
      brk = e < -0.8 ? Math.min(1, (-e - 0.8) * 0.22) : 0;
    }
    if (this.softFollow && speedCap < Infinity) {
      // the traffic cap is a spacing target: lift for it, and brake in proportion to the excess (gently), never in a panic
      const eC = speedCap - v;
      if (eC < 0) {
        thr = Math.min(thr, Math.max(0, 0.3 + 0.35 * eC));
        if (eC < -0.3) brk = Math.max(brk, Math.min(1, (-eC - 0.3) * FOLLOW_SOFT_GAIN));
      }
    }
    if (this.brakeReq > 0) {
      brk = Math.max(brk, this.brakeReq);
      thr = 0;
    }
    // on snow: the throttle is limited to what the corner leaves of the driven axle's grip (the friction circle), where the governor below
    // only lifts after the axle has begun to slide
    if (this.winter && v > 5) {
      const aLatNeed = Math.max(aLatM, v * v * Math.abs(kappa));
      const r = Math.min(1, aLatNeed / Math.max(aGrip, 2));
      const axLeft = this.drivenShare * aGrip * Math.sqrt(1 - r * r) * WINTER_AX_USE;
      const thrust = Math.min(THRUST_MAX, this.powerPerKg / Math.max(v, 3));
      thr = Math.min(thr, THR_NEUTRAL + (1 - THR_NEUTRAL) * Math.min(1, (axLeft + this.cDrag * v * v + 0.12) / thrust));
    }
    // governor: lift while an axle is sliding past its peak (front = understeer, driven rear = oversteer) or the driven
    // tyres use more than they have (wheelspin on top of the sideways slip)
    if (v > 8 || me.speed > 8) {
      const wh = me.wheels;
      const uF = Math.max(Math.abs(wh[0].slipAngle), Math.abs(wh[1].slipAngle)) / this.alphaPkF;
      const uR = Math.max(Math.abs(wh[2].slipAngle), Math.abs(wh[3].slipAngle)) / this.alphaPkR;
      let gNow = fade(uF, GOV_FRONT);
      if (this.rearDriven) gNow = Math.min(gNow, fade(uR, GOV_REAR));
      let rho = 0;
      // (every driven wheel: an all-wheel-drive car can spin its front axle as well as its rear one, and it is the front that goes first on a
      // snowy corner exit, with the centre differential sending the drive where there is no grip)
      for (let i = this.frontDriven ? 0 : 2; i < (this.rearDriven ? 4 : 2); i++) {
        const w = wh[i];
        const dT = i < 2 ? def.physics.tireFront : def.physics.tireRear;
        const tk = Math.tan(dT.peakSlipAngle);
        const lam = Math.abs(Math.tan(w.slipAngle)) / tk;
        // (wheelspin on its own, in a launch or on a straight, is for the traction control on a dry road; on a wet road
        // the car does not lean on it and the whole slip counts)
        const sw = Math.min(1, Math.max(0, (lam - GOV_SPIN_FROM) / GOV_SPIN_SPAN));
        const gate = this.wetF + (1 - this.wetF) * sw * sw * (3 - 2 * sw);
        rho = Math.max(rho, Math.hypot((w.slipRatio / dT.peakSlipRatio) * gate, lam));
      }
      gNow = Math.min(gNow, fade(rho, GOV_DRIVEN));
      this.govern = gNow < this.govern ? gNow : Math.min(gNow, this.govern + GOV_RELEASE * dt);
      thr *= this.govern;
    } else this.govern = 1;
    c.throttle = thr * (1 - bigSlide);
    // a car that is not drifting but spinning (its nose has come round beyond 30 degrees to the way it travels) brakes, and the ABS keeps the wheels turning:
    // on snow it takes a long way to stop, and every metre of it is a metre nearer the bank
    if (this.winter && v > 4) brk = Math.max(brk, 0.85 * smooth01(Math.min(1, Math.max(0, (Math.abs(slideAng) - SPIN_FROM) / (SPIN_FULL - SPIN_FROM)))));
    c.brake = brk;
    // big slide: ease off
    let slip = 0;
    for (const w of me.wheels) slip = Math.max(slip, Math.abs(w.slipAngle));
    if (slip > 0.25) c.throttle *= 0.5;

    // ── stuck / wrong-way detection ──
    const tangentDot = _f.x * myTx + _f.z * myTz;
    if (v < 1.5) this.stuckTime += dt;
    else this.stuckTime = 0;
    if (tangentDot < -0.2 && v < 10) this.wrongTime += dt;
    else this.wrongTime = 0;
    if (this.stuckTime > 3 || this.wrongTime > 2.5) this.needsReset = true;

    // ── nitro: fire a shot on a straight, flat out, on the road, with nothing to brake for within reach ──
    this.wantNitro = false;
    // (on snow the throttle is held to what the driven axle can take, never flat: there it is enough that the car is still gathering speed)
    const nitroOk = this.nitroReady && !this.nitroOn && v > (this.winter ? 22 : 18 + 17 * this.wetF) && (c.throttle > 0.95 || (this.winter && this.targetSpeed(s + 2 * v) > v + 2)) && brk === 0 && this.brakeReq === 0 && slip < 0.08
      && this.mistakeLeft <= 0 && myD < myWL - 0.3 && myD > -myWR + 0.3 && tangentDot > 0.97 && this.nitroClear && speedCap === Infinity
      && this.straightAhead(s, v, brakeCap);
    if (nitroOk) {
      if (this.nitroDelay < 0) this.nitroDelay = this.nitroRand() * 1.5;
      this.nitroWait += dt;
      if (this.nitroWait >= this.nitroDelay) {
        this.wantNitro = true;
        this.nitroWait = 0;
        this.nitroDelay = -1;
      }
    } else this.nitroWait = 0;
  }

  private nitroRand(): number {
    let x = this.nitroRng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.nitroRng = x >>> 0;
    return this.nitroRng / 4294967296;
  }

  /**
   * The speed (m/s) a corner allows at track position s, from the line's curvature and the share of the grip this driver uses
   * there (as the speed profile takes it). On a wet road the grip falls with speed (aquaplaning): a second pass takes the grip at
   * the speed the first found.
   */
  private cornerSpeed(s: number): number {
    const line = this.line;
    const i = Math.floor(this.track.wrapS(s) / line.step) % line.n;
    const k = Math.abs(line.k[i]);
    const base = this.gripMu * this.dmgGrip * 0.95 * this.skill.gripUse * this.surfGrip(s);
    let vc = 150;
    for (let it = 0; it < (this.wetness > 0 ? 2 : 1); it++) {
      const mu = base * (this.wetness > 0 ? wetGripFactor(this.wetness, this.tireWet, this.road, Math.min(vc, 150)) : 1);
      const den = k - mu * this.cDown * this.dmgAero;
      vc = den > 1e-6 ? Math.min(150, Math.sqrt((mu * G) / den)) : 150;
    }
    return vc;
  }

  /** The most a car at speed v can do at s and still slow for every corner ahead with brakes `brakeCap` (m/s^2). */
  private cornerBrakeSpeed(s: number, v: number, brakeCap: number): number {
    const look = (v * v) / (2 * brakeCap) + 40;
    const step = Math.max(this.line.step, 4);
    let best = 150;
    for (let x = 0; x <= look; x += step) {
      const vc = this.cornerSpeed(s + x);
      const allowed = Math.sqrt(vc * vc + 2 * brakeCap * Math.max(0, x - v * 0.3));
      if (allowed < best) best = allowed;
    }
    return best;
  }

  /** No corner the car would have to brake for within the reach of a nitro shot fired now. */
  private straightAhead(s: number, v: number, brakeCap: number): boolean {
    const vBoost = v + 20;
    const reach = vBoost * NITRO_SECONDS * 0.75 + 30;
    const step = Math.max(this.line.step, 5);
    for (let x = 0; x <= reach; x += step) if (this.cornerSpeed(s + x) < vBoost) return false;
    return this.cornerBrakeSpeed(s, v, brakeCap) > vBoost;
  }

  /** Called by the game after it resets the car to the track. */
  onReset(): void {
    this.needsReset = false;
    this.overspeed = false;
    this.nitroWait = 0;
    this.stuckTime = 0;
    this.wrongTime = 0;
    this.offset = 0;
    this.prevOffset = null;
    this.planTarget = 0;
    this.mistakeMul = 1;
    this.mistakeLeft = 0;
    this.hint = -1;
    this.govern = 1;
  }

  /** Target speed at s when driving `off` meters beside the racing line: tighter radius on the inside. */
  private targetSpeedOff(s: number, off: number): number {
    const v = this.targetSpeed(s);
    if (Math.abs(off) < 0.05) return v;
    const line = this.line;
    const i = Math.floor(this.track.wrapS(s) / line.step) % line.n;
    const k = line.k[i];
    const kd = k * off;
    // inside: a parallel path has a tighter radius; outside: the path gets pinched against the
    // track edge at entry and exit, which costs nearly as much
    let scale = Math.sqrt(Math.max(0.5, 1 - (kd > 0 ? kd : -0.7 * kd)));
    scale *= 1 - 0.012 * Math.min(4, Math.abs(off)) * Math.min(1, Math.abs(k) * 60);
    return v * scale;
  }

  /**
   * Lateral planning in "offset from the racing line" space. Cars alongside are hard limits (never
   * steer into a car beside you); cars ahead that we would reach soon are blocked intervals, and
   * we pick the free offset closest to the preferred one, with hysteresis so the choice of side
   * doesn't flicker. Returns a speed cap for following when there is no gap.
   */
  private planTarget = 0;
  /** Pedal the traffic ahead demands (0..1): the deceleration needed to match the speed of a car in the way before the gap is gone. */
  private brakeReq = 0;
  /** Speed cap (m/s) of the firm gap law for a pass that is still inside the other car's lane (gentle following only). */
  private capHard = Infinity;
  /** Per-car tracking of the others: projection hint, last offset, lateral rate, committed pass side, how hard it brakes. */
  private readonly others = new Map<number, { hint: number; off: number; rate: number; t: number; side: number; brk: number }>();
  private readonly obLo = new Float64Array(16);
  private readonly obHi = new Float64Array(16);
  private readonly obGap = new Float64Array(16);
  private readonly obV = new Float64Array(16);
  private readonly obBrk = new Float64Array(16);
  private readonly obTtc = new Float64Array(16);
  private readonly obId = new Int32Array(16);
  private readonly obRoomLo = new Float64Array(16);
  private readonly obRoomHi = new Float64Array(16);
  private nOb = 0;
  private dbgSideLo = 0;
  private dbgSideHi = 0;
  private envLo = 0;
  private envHi = 0;
  /** A car alongside is closer than the safe separation: the move away from it is not optional. */
  private forceMove = false;
  /**
   * Offsets (from the racing line) that keep the car on the asphalt over the preview distance.
   * Edge limits further ahead are relaxed by a slope, so an offset path blends into the edge
   * gradually instead of being clipped with a kink. Sets envLo / envHi.
   */
  private offsetEnvelope(s: number, v: number): void {
    const tr = this.track;
    const halfW = this.halfWidth;
    const W = 10 + 1.0 * v;
    let lo = -Infinity;
    let hi = Infinity;
    const allow = this.edgeAllow();
    for (let x = 0; x <= W; x += 4) {
      const sa = tr.wrapS(s + x);
      const j = Math.min(tr.count - 1, Math.round(sa / tr.spacing));
      const ld = this.lineOffsetAt(sa);
      const slack = 0.05 * x;
      const hz = this.hazardAt(sa);
      hi = Math.min(hi, Math.max(0, tr.widthLeft[j] - halfW + (hz & 1 ? allow : EDGE_ALLOW_DRY) - ld) + slack);
      lo = Math.max(lo, Math.min(0, -(tr.widthRight[j] - halfW + (hz & 2 ? allow : EDGE_ALLOW_DRY)) - ld) - slack);
    }
    this.envLo = lo;
    this.envHi = hi;
  }

  /** Slippery ground beyond the edge at s (bit 0 left, bit 1 right). */
  private hazardAt(s: number): number {
    return this.hazard[Math.floor(this.track.wrapS(s) / this.line.step + 0.5) % this.line.n];
  }

  /** How far the car's side may reach past the asphalt edge where the ground beyond is slippery (m; negative = stay inside): in the wet it is ice. */
  private edgeAllow(): number {
    return EDGE_ALLOW_DRY - EDGE_WET_MARGIN * this.wetF;
  }

  /** Tightest offset limits (no slack) over [s, s + dist]: the room a pass actually has. */
  private roomLo = 0;
  private roomHi = 0;
  private strictRoom(s: number, dist: number): void {
    const tr = this.track;
    const halfW = this.halfWidth;
    let lo = -Infinity;
    let hi = Infinity;
    const allow = this.edgeAllow();
    for (let x = 0; x <= dist; x += 4) {
      const sa = tr.wrapS(s + x);
      const j = Math.min(tr.count - 1, Math.round(sa / tr.spacing));
      const ld = this.lineOffsetAt(sa);
      const hz = this.hazardAt(sa);
      hi = Math.min(hi, Math.max(0, tr.widthLeft[j] - halfW + (hz & 1 ? allow : EDGE_ALLOW_DRY) - ld));
      lo = Math.max(lo, Math.min(0, -(tr.widthRight[j] - halfW + (hz & 2 ? allow : EDGE_ALLOW_DRY)) - ld));
    }
    this.roomLo = lo;
    this.roomHi = hi;
  }

  private planTraffic(s: number, v: number, myOff: number, wander: number, me: VehicleState, others: readonly VehicleState[], aGrip: number): number {
    const tr = this.track;
    const halfW = this.halfWidth;
    const len = this.def.visual.length;
    const sep = 2 * halfW + 0.6;
    const offLo = this.envLo;
    const offHi = this.envHi;
    let sideLo = offLo;
    let sideHi = offHi;
    let carLo = -Infinity;
    let carHi = Infinity;
    let alongsideAheadV = Infinity;
    let alongsideLevelV = Infinity;
    let nOb = 0;
    let clear = true;
    for (const o of others) {
      if (o.id === me.id) continue;
      let rec = this.others.get(o.id);
      if (!rec) {
        rec = { hint: -1, off: 0, rate: 0, t: -1, side: 0, brk: 0 };
        this.others.set(o.id, rec);
      }
      rec.hint = tr.project(o.position.x, o.position.z, _tp, rec.hint);
      let ds = _tp.s - s;
      if (ds > tr.length / 2) ds -= tr.length;
      if (ds < -tr.length / 2) ds += tr.length;
      const oOff = _tp.d - this.lineOffsetAt(_tp.s);
      // lateral rate of the other car relative to the line (smoothed)
      const tdt = this.time - rec.t;
      if (rec.t >= 0 && tdt > 0 && tdt < 0.2) rec.rate += ((oOff - rec.off) / tdt - rec.rate) * Math.min(1, tdt * 8);
      else rec.rate = 0;
      // how hard it is braking right now (filtered): a leader on the brakes closes the gap faster than its speed says
      rec.brk += (Math.max(0, -o.localAccel.z) - rec.brk) * Math.min(1, Math.max(0, tdt) * 6);
      rec.off = oOff;
      rec.t = this.time;
      // nitro: a car alongside, or ahead in this lane within reach of a boosted car, rules a shot out
      if (ds > -len && ds < NITRO_CLEAR_AHEAD && (ds < len + 0.6 || Math.abs(oOff - myOff) < sep * 1.4)) clear = false;
      if (ds < -(len + 12) || ds > 90) {
        rec.side = 0;
        continue;
      }
      const vO = o.velocity.x * _tp.tx + o.velocity.z * _tp.tz;
      // alongside (overlapping), or about to be: a faster car right behind gets its space too
      const behindReach = len + 0.6 + Math.max(0, vO - v) * 0.7;
      if ((ds >= 0 && ds < len + 0.6) || (ds < 0 && ds > -behindReach)) {
        if (Math.abs(oOff - myOff) < sep * 0.8 && ds < -len * 0.7) continue; // directly behind us: their problem
        if (oOff >= myOff) {
          sideHi = Math.min(sideHi, oOff - sep);
          carHi = Math.min(carHi, oOff - sep);
        } else {
          sideLo = Math.max(sideLo, oOff + sep);
          carLo = Math.max(carLo, oOff + sep);
        }
        if (ds > 0) alongsideAheadV = Math.min(alongsideAheadV, vO);
        if (ds > -len * 0.6) alongsideLevelV = Math.min(alongsideLevelV, vO);
        continue;
      }
      if (ds < 0) {
        rec.side = 0;
        continue;
      }
      if (nOb >= 16) continue;
      const gap = ds - len;
      const closing = v - vO;
      const ttc = closing > 0.05 ? gap / closing : Infinity;
      if (ttc > 3.5 && gap > 4 + v * 0.5) {
        rec.side = 0;
        continue;
      }
      // where it will be when we get there (its lateral drift, up to a second ahead)
      const pred = oOff + rec.rate * Math.min(1, ttc);
      this.obLo[nOb] = Math.min(oOff, pred) - sep;
      this.obHi[nOb] = Math.max(oOff, pred) + sep;
      this.obGap[nOb] = gap;
      this.obV[nOb] = vO;
      this.obBrk[nOb] = rec.brk;
      this.obTtc[nOb] = ttc;
      this.obId[nOb] = o.id;
      // the room we'd have to get alongside: from here until we overlap it (once alongside, the
      // alongside rules make it leave room, which is how an inside pass under braking works)
      this.strictRoom(s, Math.min(100, gap + len));
      this.obRoomLo[nOb] = this.roomLo;
      this.obRoomHi[nOb] = this.roomHi;
      nOb++;
    }
    this.nOb = nOb;
    this.nitroClear = clear;

    let cap = Infinity;
    this.brakeReq = 0;
    this.capHard = Infinity;
    const lo = sideLo;
    const hi = sideHi;
    this.dbgSideLo = lo;
    this.dbgSideHi = hi;
    this.forceMove = myOff > carHi + 0.1 || myOff < carLo - 0.1;
    const prev = this.planTarget;
    if (lo > hi) {
      // squeezed between cars (or a car and the track edge): hold the lane; the car behind yields,
      // and so does a car pinned against the edge unless it is clearly ahead
      this.planTarget = Math.max(offLo, Math.min(offHi, myOff));
      if (alongsideAheadV < Infinity) cap = Math.max(0, alongsideAheadV - 2);
      const pinned = hi === offHi || lo === offLo;
      if (pinned && alongsideLevelV < Infinity) cap = Math.min(cap, Math.max(0, alongsideLevelV - 3));
    } else {
      const pref = Math.max(lo, Math.min(hi, wander));
      let best = NaN;
      let bestCost = Infinity;
      const tryCand = (c: number) => {
        if (c < lo - 1e-6 || c > hi + 1e-6) return;
        let cost = Math.abs(c - pref) + 0.8 * Math.abs(c - prev);
        for (let k = 0; k < nOb; k++) {
          const oLo = this.obLo[k];
          const oHi = this.obHi[k];
          if (c > oLo && c < oHi) return;
          const oC = (oLo + oHi) / 2;
          const gap = this.obGap[k];
          if (Math.abs(myOff - oC) < sep * 0.5) {
            // right behind it: pulling out either way is fine unless we are about to touch
            if (gap < 1.5 + v * 0.12) return;
          } else if ((myOff - oC) * (c - oC) < 0 && gap < 6 + v * 0.5) {
            // switching to its other side means cutting across its lane: only well behind it
            return;
          }
          // the pass must fit beside it all the way through the passing zone
          const side = c >= oHi ? 1 : -1;
          if (side > 0 ? this.obRoomHi[k] < oHi + 0.05 : this.obRoomLo[k] > oLo - 0.05) {
            if (this.obTtc[k] < 3 || this.obGap[k] < 4 + v * 0.5) return;
          }
          // stick to the side we committed to for this car
          const committed = this.others.get(this.obId[k])!.side;
          if (committed !== 0 && committed !== side) cost += 3;
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = c;
        }
      };
      tryCand(pref);
      tryCand(Math.max(lo, Math.min(hi, prev)));
      for (let k = 0; k < nOb; k++) {
        // aim a little clear of the blocked band (it already includes a safety margin), so small
        // drifts of the other car don't flip us back to following; fall back to the band edge
        tryCand(Math.max(lo, this.obLo[k] - 0.35));
        tryCand(Math.min(hi, this.obHi[k] + 0.35));
        tryCand(this.obLo[k] - 0.05);
        tryCand(this.obHi[k] + 0.05);
      }
      this.planTarget = Number.isNaN(best) ? Math.max(lo, Math.min(hi, myOff)) : best;
      // remember which side we are passing each car on
      for (let k = 0; k < nOb; k++) {
        const rec = this.others.get(this.obId[k])!;
        if (this.planTarget >= this.obHi[k]) rec.side = 1;
        else if (this.planTarget <= this.obLo[k]) rec.side = -1;
      }
    }
    // follow anything still in our path (current offset or planned one)
    const target = this.planTarget;
    for (let k = 0; k < nOb; k++) {
      const tk = Math.max(this.obRoomLo[k], Math.min(this.obRoomHi[k], target));
      const vO = this.obV[k];
      if (this.softFollow) {
        const lo = this.obLo[k];
        const hi = this.obHi[k];
        const clrMe = Math.max(lo - myOff, myOff - hi) + 0.25;
        const clrTk = Math.max(lo - tk, tk - hi);
        if (clrMe > 0 && clrTk >= 0) continue; // clear of its lane
        const gap = this.obGap[k];
        const vOp = Math.max(0, vO);
        if (clrTk >= 0) {
          // the plan takes us round it, but we are still inside its lane: a pass that fails for lack of room must not end
          // in a panic stop on the asphalt edge, so until we are out of the lane the firm gap law applies
          this.capHard = Math.min(this.capHard, this.gapCap(gap, vOp, this.obTtc[k]));
          continue;
        }
        const closing = v - vOp;
        if (closing > 0.3) {
          // the deceleration that matches its speed just before the safe gap is gone, plus what it is braking by itself
          // (brake in proportion, not in a panic)
          const d = gap - (1.5 + 0.06 * vOp) - closing * 0.25;
          const aReq = (closing * closing) / (2 * Math.max(d, 0.4)) + LEADER_BRAKE_WEIGHT * this.obBrk[k];
          if (aReq > BRAKE_DEAD_BAND) this.brakeReq = Math.max(this.brakeReq, Math.min(1, (BRAKE_MARGIN * aReq) / this.brakeGain));
        }
        cap = Math.min(cap, this.followCap(gap, vOp, aGrip));
        continue;
      }
      // (a quarter metre of the safety margin may be used before we count as being in its path)
      const inPath = (myOff > this.obLo[k] + 0.25 && myOff < this.obHi[k] - 0.25) || (tk > this.obLo[k] && tk < this.obHi[k]);
      if (!inPath) continue;
      cap = Math.min(cap, this.gapCap(this.obGap[k], vO, this.obTtc[k]));
    }
    return cap;
  }

  /** The firm gap law: the speed from which a fixed gap (2.5 m + 0.3 s) behind a car that is in the way can still be held. */
  private gapCap(gap: number, vO: number, ttc: number): number {
    const desired = 2.5 + 0.3 * Math.max(0, vO);
    let c = vO + (gap - desired) * 0.9;
    if (ttc < 0.8) c = Math.min(c, vO - 1);
    return Math.max(0, c);
  }

  /**
   * Speed cap for a car `gap` metres ahead doing vO: the highest speed from which a comfortable brake (a share of what
   * the tyres can give, so less in the wet) still brings us to its speed before we are closer than the hold gap.
   */
  private followCap(gap: number, vO: number, aGrip: number): number {
    const wetLoss = this.wetness > 0 ? 1 - Math.min(1, this.wetMu) : 0;
    const tau = FOLLOW_TIME_GAP + FOLLOW_TIME_GAP_WET * wetLoss;
    const gHold = 2.2 + tau * vO;
    const b = Math.max(2, FOLLOW_COMFORT * aGrip);
    const tR = FOLLOW_REACTION;
    if (gap > gHold) return vO + b * (Math.sqrt(tR * tR + (2 * (gap - gHold)) / b) - tR);
    return vO - Math.min(4, 0.8 * (gHold - gap));
  }

  // ── line sampling helpers ──────────────────────────────────────────────────
  private lineOffsetAt(s: number): number {
    const line = this.line;
    const f = this.track.wrapS(s) / line.step;
    const i = Math.floor(f) % line.n;
    const b = (i + 1) % line.n;
    const t = f - Math.floor(f);
    return line.d[i] * (1 - t) + line.d[b] * t;
  }
}

function fract(x: number): number {
  return x - Math.floor(x);
}
