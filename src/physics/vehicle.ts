/**
 * Vehicle dynamics: a 6-DOF rigid chassis on four raycast suspensions, combined-slip tires with
 * relaxation, an implicitly solved drivetrain (engine ⇄ clutch ⇄ gearbox ⇄ limited-slip diff ⇄
 * wheels ⇄ brakes), aerodynamics with slipstream, tire/brake thermals, driver aids, and
 * impulse-based collisions with the track barriers and the ground.
 *
 * Frames: car +Z forward, +Y up, +X LEFT. Wheels: 0 FL, 1 FR, 2 RL, 3 RR.
 * Runs at a fixed substep (1 ms by default); see PhysicsWorld.
 */
import { Quaternion, Vector3 } from 'three';
import type {
  Assists,
  CarControls,
  CarDefinition,
  GroundSample,
  ImpactKind,
  SurfaceType,
  TrackPoint,
  TrackRuntime,
  VehicleState,
  WheelState,
} from '../core/contracts';
import { cloneEffects, isNeutral, type MechEffects } from '../core/mechanical';
import { NITRO_POWER, NITRO_THRUST_G } from '../core/nitro';
import { RADS_TO_RPM, RPM_TO_RADS, peakTorque, torqueAt } from './engine';
import type { DifferentialSpec, SuspensionSpec, TireSpec, VehicleSpec } from './spec';
import { tireSurfaces, wetGripFactor, type SurfaceProps } from './surfaces';
import { loadFactor, makeShape, shapeRatio, tempFactor, type TireShape } from './tire';

const GRAVITY = 9.81;
const AIR_DENSITY = 1.225;
const AMBIENT_C = 24;
/** Air temperature on a winter circuit: the tyres and the brakes cool towards it. */
const WINTER_AMBIENT_C = -6;
/**
 * A snowbank (a soft barrier, `TrackPoint.softLeft/Right`) takes a car in over this depth (m) beyond the barrier line. Inside it a
 * hull point meets a spring that stiffens with depth and a damper, and the bank only gives back a fraction of what it took (the
 * snow is packed, not bounced off); past it the bank is as hard as the ground below.
 */
const BANK_DEPTH = 3.5;
/** Stiffness (N/m per hull point) and damping (N·s/m) of a snowbank going in; coming out the snow gives back this share of the spring and holds on with its own damping. */
const BANK_STIFFNESS = 12000;
const BANK_DAMPING = 2600;
const BANK_UNLOAD = 0.06;
const BANK_OUT_DAMPING = 1800;
/** Friction of the car's flank sliding along a snowbank (the snow drags and heaps against it). */
const BANK_FRICTION = 0.25;
/** A hit of a snowbank counts for this share of its closing speed as an impact (damage, sound): it is a thump, not a crash. */
const BANK_IMPACT = 0.34;
/** Slip denominators never go below this speed (m/s) — keeps slip finite at standstill. */
const SLIP_VMIN = 3;
/** Static suspension compression as a fraction of travel. */
const STATIC_SAG = 0.38;
/** Road-wheel steering rack speed (rad/s). */
const RACK_SPEED = 4.2;
/**
 * Lowest brake pressure ABS holds on a locking wheel. It must be able to let go completely: a wheel locked on a
 * kerb or wet grass carries only a fraction of what a dry caliper at even 20 % would put on it, and stays locked.
 */
const ABS_MIN_PRESSURE = 0;
/**
 * Back-torque limit of the clutch (a slipper clutch) as a share of the grip torque of the driven tyres: engine braking and the
 * clutch dump of a clumsy downshift cannot drag the driven axle into a lock that ABS (brake pressure only) cannot cure.
 */
const SLIPPER_GRIP_SHARE = 0.5;

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// Shared scratch (physics is single-threaded and non-reentrant).
const _ax = new Vector3();
const _ay = new Vector3();
const _az = new Vector3();
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _r = new Vector3();
const _f = new Vector3();
const _t = new Vector3();
const _force = new Vector3();
const _torque = new Vector3();
const _q1 = new Quaternion();
const _ground: GroundSample = { height: 0, normal: new Vector3(0, 1, 0), surface: 'asphalt' };
const _gN = new Vector3();
const _tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, softLeft: 0, softRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };

/** Deterministic per-vehicle PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class WheelSim {
  readonly hub = new Vector3();
  readonly contactPt = new Vector3();
  readonly normal = new Vector3(0, 1, 0);
  readonly fwd = new Vector3(0, 0, 1);
  readonly lat = new Vector3(1, 0, 0);
  readonly shape: TireShape;
  readonly tanPeakAlpha: number;
  /** The ground as this tyre meets it (src/physics/surfaces.ts: SURFACES itself for a road tyre, softened loose ground for an all-terrain one, worsened for a racing slick). */
  readonly surfaces: Record<SurfaceType, SurfaceProps>;
  /** The thermal size of the tyre (TireSpec.heatScale): the tread warms by the work of the tyre divided by it. */
  readonly heatScale: number;
  /** Spring pre-compression at full extension (m); may be negative (slack droop). */
  readonly springPre: number;
  driveWeight = 0;

  compression = 0;
  compVel = 0;
  bottom = 0;
  suspForce = 0;
  prevGroundH = Number.NaN;
  contact = false;
  surface: SurfaceType = 'asphalt';
  hint = -1;

  steer = 0;
  /** Mechanical damage (Vehicle.setDamage): toe added to the steering angle, and what a camber error does to the tyre. */
  toe = 0;
  camberGrip = 1;
  camberThrust = 0;
  omega = 0;
  spin = 0;
  tanAlphaF = 0;
  load = 0;
  fx = 0;
  fy = 0;
  kappa = 0;
  alpha = 0;
  rho = 0;
  vLong = 0;
  vLat = 0;
  implicitD = 0;
  rollingTorque = 0;
  brakeTorque = 0;
  absFactor = 1;
  /** Friction force (N) the tyre could give at its peak right now (mu * load), for the driveline back-torque limit. */
  peakF = 0;
  escBrake = 0;
  skid = 0;
  tempC: number;
  brakeTempC: number;

  constructor(
    readonly index: number,
    readonly front: boolean,
    readonly left: boolean,
    /** Car-frame mount: lateral x, longitudinal z, and wheel-center y at full extension. */
    readonly mx: number,
    readonly mz: number,
    readonly yExt: number,
    readonly tire: TireSpec,
    readonly susp: SuspensionSpec,
    staticLoad: number,
    /** Height above the contact patch where horizontal tire forces act on the body (roll center). */
    readonly rcHeight: number,
    ambient: number,
  ) {
    this.shape = makeShape(tire.slideRatio);
    this.tanPeakAlpha = Math.tan(tire.peakSlipAngle);
    this.surfaces = tireSurfaces(tire);
    this.heatScale = tire.heatScale ?? 1;
    this.springPre = staticLoad / susp.spring - STATIC_SAG * susp.travel;
    this.tempC = tire.optimalTemp - 0.35 * tire.tempWindow;
    this.brakeTempC = ambient + 60;
  }

  get radius() {
    return this.tire.radius;
  }
}

export class Vehicle {
  readonly spec: VehicleSpec;
  readonly state: VehicleState;
  readonly wheels: WheelSim[];

  controls: CarControls = { steer: 0, throttle: 0, brake: 0, handbrake: 0, clutch: 0, shift: 0 };
  assists: Assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
  /** Held on the grid: brakes on, clutch open (rev freely), released at GO. */
  holdOnGrid = false;
  /** Track grip multiplier (e.g. dusty/cold). */
  gripScale = 1;
  /** 0..1 water on the track (set by the world): wet grip, aquaplaning, tread cooling. On a winter circuit it is fresh snow. */
  wetness = 0;
  /** A winter circuit (studded tyres, cold air, snowbanks), and its air temperature (°C). */
  readonly winter: boolean;
  private readonly ambient: number;
  /** Set each frame by the world: slipstream / dirty air. */
  dragMul = 1;
  downforceMul = 1;
  /** Nitro burning, 0..1 (set each frame by the game from the car's NitroTank, src/core/nitro.ts): more torque and a push forward. */
  nitro = 0;
  /** Mechanical damage (setDamage): the share of the front and rear downforce and of the engine's torque that is left. */
  private aeroFrontMul = 1;
  private aeroRearMul = 1;
  private powerMul = 1;
  /** The mean toe of the front wheels (rad, + = pointing left): the steering angle that goes straight is the rack's minus this. */
  private toeMean = 0;
  /** The mechanical damage the car carries now, or null when it is sound. */
  private damage: MechEffects | null = null;

  // rigid body
  readonly p = new Vector3();
  readonly q = new Quaternion();
  readonly v = new Vector3();
  readonly w = new Vector3();
  readonly mass: number;
  readonly invMass: number;
  private readonly inertia: Vector3;
  private readonly invInertia: Vector3;
  private readonly prevP = new Vector3();
  private readonly prevQ = new Quaternion();
  private readonly frameV = new Vector3();
  private readonly accelSmoothed = new Vector3();

  // powertrain
  private omegaE: number;
  private readonly engineInertia: number;
  private readonly clutchMax: number;
  private readonly torquePeak: number;
  gear = 1;
  private shifting = false;
  private shiftTimer = 0;
  private shiftTarget = 1;
  private shiftDuration = 0.1;
  private sinceShift = 10;
  private reverseTimer = 0;
  private boost = 0;
  private limiterCut = false;
  private clutchEngage = 1;
  private clutchLocked = false;
  private launching = false;
  /** Wheel torque (Nm) the driven tires can take at launch; launch clutch capacity = this / |G|. */
  private readonly launchCapacity: number;
  /**
   * AWD: the ratios that bring the two output shafts of the centre differential to the same speed when the car rolls, whatever the size
   * of the tyres of each axle (the shaft turns this many times as fast as the axle's wheels; mean tyre radius = 1). Both exactly 1 when
   * the tyres are the same size, and then the centre differential compares the wheel speeds as they are.
   */
  private readonly centerRatioF: number;
  private readonly centerRatioR: number;
  private lastClutchTorque = 0;
  private appliedThrottle = 0;
  private appliedBrake = 0;
  private engineLoad = 0;
  private tcsFactor = 1;
  private tcsI = 0;
  private tcsActive = false;
  private absActive = false;
  private escActive = false;
  private escThrottle = 1;
  private steerAngle = 0; // road-wheel angle at the axle center, + = left
  private prevThrottleIn = 0;
  private popBudget = 0;
  private popTimer = 0;
  private readonly rand: () => number;

  // collisions
  private hullHint = -1;
  private comHint = -1;
  private readonly hullPoints: Vector3[] = [];
  private readonly groundPoints: Vector3[] = [];
  private readonly hullRadiusXZ: number;
  private scrapeAcc = 0;
  private readonly scrapePt = new Vector3();
  private impactCooldown = 0;
  private readonly hullCenterLocal: Vector3;
  private readonly maxWheelForce: number;

  constructor(
    readonly id: number,
    readonly def: CarDefinition,
    readonly track: TrackRuntime,
  ) {
    const s = def.physics;
    this.spec = s;
    const c = s.chassis;
    this.mass = c.mass;
    this.invMass = 1 / c.mass;
    this.inertia = new Vector3(c.inertia.x, c.inertia.y, c.inertia.z);
    this.invInertia = new Vector3(1 / c.inertia.x, 1 / c.inertia.y, 1 / c.inertia.z);
    this.rand = rng(0x9e3779b9 ^ (id * 7919));
    this.winter = track.info.winter === true;
    this.ambient = this.winter ? WINTER_AMBIENT_C : AMBIENT_C;

    const a = c.cgToFrontAxle;
    const b = c.wheelbase - a;
    const frontStatic = (c.mass * GRAVITY * b) / c.wheelbase / 2;
    const rearStatic = (c.mass * GRAVITY * a) / c.wheelbase / 2;
    const mk = (i: number, front: boolean, left: boolean) => {
      const tire = front ? s.tireFront : s.tireRear;
      const susp = front ? s.suspFront : s.suspRear;
      const track = front ? c.trackFront : c.trackRear;
      const yExt = tire.radius - c.cgHeight - STATIC_SAG * susp.travel;
      const rc = c.cgHeight * (front ? 0.16 : 0.24);
      return new WheelSim(i, front, left, (left ? 1 : -1) * track / 2, front ? a : -b, yExt, tire, susp, front ? frontStatic : rearStatic, rc, this.ambient);
    };
    this.wheels = [mk(0, true, true), mk(1, true, false), mk(2, false, true), mk(3, false, false)];
    const dt = s.drivetrain;
    const fs = dt.layout === 'FWD' ? 1 : dt.layout === 'RWD' ? 0 : dt.frontSplit;
    this.wheels[0].driveWeight = this.wheels[1].driveWeight = fs / 2;
    this.wheels[2].driveWeight = this.wheels[3].driveWeight = (1 - fs) / 2;

    this.engineInertia = s.engine.inertia;
    this.maxWheelForce = c.mass * GRAVITY * 2.5;
    this.torquePeak = peakTorque(s.engine);
    this.clutchMax = this.torquePeak * 1.7;
    {
      const front = (c.mass * GRAVITY * b) / c.wheelbase;
      const rear = (c.mass * GRAVITY * a) / c.wheelbase;
      const drivenLoad = dt.layout === 'FWD' ? front * 0.92 : dt.layout === 'RWD' ? rear * 1.12 : (front + rear) * 0.98;
      const tire = dt.layout === 'FWD' ? s.tireFront : s.tireRear;
      // (all-wheel drive: the grip of each axle on its own load, the front tyre's friction on the front axle and the rear's on the rear)
      this.launchCapacity =
        dt.layout === 'AWD'
          ? ((s.tireFront.mu * front + s.tireRear.mu * rear) * 0.98 * 1.15 * tire.radius) / dt.efficiency
          : (tire.mu * 1.15 * drivenLoad * tire.radius) / dt.efficiency;
    }
    {
      const rf = s.tireFront.radius;
      const rr = s.tireRear.radius;
      const rm = (rf + rr) / 2;
      this.centerRatioF = rf / rm;
      this.centerRatioR = rr / rm;
    }
    this.omegaE = s.engine.idleRpm * RPM_TO_RADS;

    // collision hull: 8 corners + 4 side midpoints (car frame, relative to CoM)
    const h = c.hullHalf;
    const o = c.hullOffset;
    this.hullCenterLocal = new Vector3(o.x, o.y, o.z);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) this.hullPoints.push(new Vector3(o.x + sx * h.x, o.y + sy * h.y, o.z + sz * h.z));
    this.hullPoints.push(new Vector3(o.x + h.x, o.y, o.z), new Vector3(o.x - h.x, o.y, o.z), new Vector3(o.x, o.y, o.z + h.z), new Vector3(o.x, o.y, o.z - h.z));
    this.hullRadiusXZ = Math.hypot(h.x, h.z) + Math.hypot(o.x, o.z);
    // Ground-contact points follow a real underbody: a flat skid plank between the axles, a nose
    // and tail lip a little higher, bumper corners rounded up and in; plus roof and shoulder points
    // for when the car is on its side or roof.
    const bottom = o.y - h.y;
    const top = o.y + h.y;
    const front = o.z + h.z;
    const rear = o.z - h.z;
    const halfW = h.x;
    const plankX = Math.max(0.2, halfW - 0.32);
    const plankZ = c.wheelbase * 0.38;
    const zMid = c.cgToFrontAxle - c.wheelbase / 2;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) this.groundPoints.push(new Vector3(sx * plankX, bottom, zMid + sz * plankZ));
    this.groundPoints.push(new Vector3(0, bottom + 0.035, front - 0.12), new Vector3(0, bottom + 0.07, rear + 0.12));
    for (const sx of [-1, 1]) {
      this.groundPoints.push(new Vector3(sx * (halfW - 0.18), bottom + 0.13, front - 0.25), new Vector3(sx * (halfW - 0.18), bottom + 0.16, rear + 0.25));
      this.groundPoints.push(new Vector3(sx * halfW, o.y, o.z)); // shoulders
      for (const sz of [-1, 1]) this.groundPoints.push(new Vector3(sx * (halfW - 0.15), top, o.z + sz * h.z * 0.45)); // roof
    }

    const ws = (): WheelState => ({
      hub: new Vector3(),
      contactPoint: new Vector3(),
      contactNormal: new Vector3(0, 1, 0),
      steerAngle: 0,
      spin: 0,
      omega: 0,
      radius: 0.33,
      width: 0.25,
      compression: 0,
      suspensionVelocity: 0,
      contact: false,
      surface: 'asphalt',
      load: 0,
      slipRatio: 0,
      slipAngle: 0,
      forceLong: 0,
      forceLat: 0,
      skid: 0,
      tempC: this.ambient,
      brakeTempC: this.ambient,
    });
    this.state = {
      id,
      position: new Vector3(),
      quaternion: new Quaternion(),
      velocity: new Vector3(),
      angularVelocity: new Vector3(),
      speed: 0,
      forwardSpeed: 0,
      localAccel: new Vector3(),
      steer: 0,
      throttle: 0,
      throttlePedal: 0,
      brake: 0,
      handbrake: 0,
      clutch: 0,
      rpm: s.engine.idleRpm,
      idleRpm: s.engine.idleRpm,
      redlineRpm: s.engine.redlineRpm,
      limiterRpm: s.engine.limiterRpm,
      gear: 1,
      gearCount: dt.gears.length,
      engineLoad: 0,
      boost: 0,
      revLimiter: false,
      absActive: false,
      tcsActive: false,
      escActive: false,
      shiftCount: 0,
      backfireCount: 0,
      impactCount: 0,
      lastImpact: { strength: 0, point: new Vector3(), normal: new Vector3(0, 1, 0), kind: 'wall' },
      scrape: 0,
      scrapePoint: new Vector3(),
      wheels: [ws(), ws(), ws(), ws()],
      airborne: false,
    };
    for (let i = 0; i < 4; i++) {
      this.state.wheels[i].radius = this.wheels[i].tire.radius;
      this.state.wheels[i].width = this.wheels[i].tire.width;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Placement
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Put the car at rest on the ground: `surfacePoint` is a point on the road under the CoM,
   * `quat` the orientation (+Z forward). Optional initial forward speed (m/s).
   */
  placeOnGround(surfacePoint: Vector3, quat: Quaternion, speed = 0): void {
    this.q.copy(quat).normalize();
    _ay.set(0, 1, 0).applyQuaternion(this.q);
    this.p.copy(surfacePoint).addScaledVector(_ay, this.spec.chassis.cgHeight);
    _az.set(0, 0, 1).applyQuaternion(this.q);
    this.v.copy(_az).multiplyScalar(speed);
    this.w.set(0, 0, 0);
    this.prevP.copy(this.p);
    this.prevQ.copy(this.q);
    this.frameV.copy(this.v);
    this.accelSmoothed.set(0, 0, 0);
    for (const wh of this.wheels) {
      wh.omega = speed / wh.radius;
      wh.compression = STATIC_SAG * wh.susp.travel;
      wh.compVel = 0;
      wh.prevGroundH = Number.NaN;
      wh.tanAlphaF = 0;
      wh.absFactor = 1;
      wh.hint = -1;
    }
    const rpm = Math.max(this.spec.engine.idleRpm, this.gear > 0 ? (speed / this.wheels[2].radius) * this.totalRatio(this.gear) * RADS_TO_RPM : 0);
    this.omegaE = rpm * RPM_TO_RADS;
    this.shifting = false;
    this.sinceShift = 10;
    this.limiterCut = false;
    this.clutchLocked = false;
    this.tcsFactor = 1;
    this.tcsI = 0;
    this.steerAngle = 0;
    this.hullHint = -1;
    this.comHint = -1;
    this.scrapeAcc = 0;
    if (this.gear === 0 || this.gear === -1) this.gear = 1;
    this.publish(1, 1 / 60);
  }

  /** Warm tires / brakes to racing temperature (after a formation lap) or reset to cold. */
  setTemperatures(tireFraction: number): void {
    const water = this.winter ? 0 : this.wetness;
    for (const wh of this.wheels) {
      // (in the wet the working window sits 30 °C lower — see the grip calculation)
      const optimal = Math.max(this.ambient + 5, wh.tire.optimalTemp - 30 * water);
      wh.tempC = this.ambient + (optimal - this.ambient) * tireFraction;
      wh.brakeTempC = this.ambient + 150 * tireFraction;
    }
  }

  /**
   * Mechanical damage (src/core/mechanical.ts): bent suspension (toe and camber per wheel), lost downforce at either axle and a
   * tired engine. null, or effects that change nothing, repairs the car. The values are read into plain fields here, so the
   * substep stays free of allocations and costs nothing on a sound car; call it when the damage changes, not every frame.
   */
  setDamage(e: MechEffects | null): void {
    const fx = e && !isNeutral(e) ? e : null;
    this.damage = fx && cloneEffects(fx);
    this.aeroFrontMul = fx ? fx.aeroFront : 1;
    this.aeroRearMul = fx ? fx.aeroRear : 1;
    this.powerMul = fx ? fx.power : 1;
    this.toeMean = fx ? 0.5 * (fx.toe[0] + fx.toe[1]) : 0;
    for (let i = 0; i < 4; i++) {
      const wh = this.wheels[i];
      wh.toe = fx ? fx.toe[i] : 0;
      wh.camberGrip = fx ? fx.camberGrip[i] : 1;
      wh.camberThrust = fx ? fx.camberThrust[i] : 0;
    }
  }

  /** The mechanical damage the car carries, or null when it is sound. */
  get mechanical(): MechEffects | null {
    return this.damage;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Per-frame logic (gearbox automation, backfires)
  // ───────────────────────────────────────────────────────────────────────────

  private totalRatio(gear: number): number {
    const d = this.spec.drivetrain;
    if (gear === 0) return 0;
    if (gear < 0) return -d.reverse * d.finalDrive;
    return d.gears[gear - 1] * d.finalDrive;
  }

  private requestShift(target: number): void {
    if (this.shifting || target === this.gear) return;
    const n = this.spec.drivetrain.gears.length;
    if (target > n || target < -1) return;
    this.shifting = true;
    this.shiftTimer = 0;
    this.shiftTarget = target;
    const intoReverse = target === -1 || this.gear === -1 || target === 0 || this.gear === 0;
    this.shiftDuration = intoReverse ? 0.25 : this.spec.drivetrain.shiftTime;
    // ignition-cut upshift at high rpm → now and then a pop for crackly exhausts (the lift-off is where they bang; at 0.8 x crackle
    // every other upshift of a hard run through the gears popped)
    if (target > this.gear && this.gear >= 1 && this.rpm() > 0.7 * this.spec.engine.redlineRpm && this.rand() < this.def.sound.crackle * 0.35) {
      this.state.backfireCount++;
    }
  }

  private rpm(): number {
    return this.omegaE * RADS_TO_RPM;
  }

  beginFrame(dt: number): void {
    const c = this.controls;
    const d = this.spec.drivetrain;
    const fwd = this.state.forwardSpeed;
    this.sinceShift += dt;

    if (this.assists.autoShift) {
      if (!this.shifting) {
        const rpm = this.rpm();
        const thr = c.throttle;
        const brk = c.brake;
        if (this.gear >= 0 && fwd < 0.6 && brk > 0.4 && thr < 0.05 && !this.holdOnGrid) {
          this.reverseTimer += dt;
          if (this.reverseTimer > 0.35) this.requestShift(-1);
        } else {
          this.reverseTimer = 0;
          if (this.gear === -1 && thr > 0.2 && fwd > -0.6) this.requestShift(1);
          else if (this.gear === 0) this.requestShift(1);
          else if (this.gear >= 1) {
            const airborne = this.state.airborne;
            if (rpm > d.upshiftRpm && this.gear < d.gears.length && this.sinceShift > 0.35 && !airborne) {
              this.requestShift(this.gear + 1);
            } else if (this.gear > 1) {
              const rpmLower = (rpm * d.gears[this.gear - 2]) / d.gears[this.gear - 1];
              const down = d.downshiftRpm + brk * 1300;
              if (rpm < down && rpmLower < d.upshiftRpm - 500 && this.sinceShift > 0.3) this.requestShift(this.gear - 1);
              else if (thr > 0.92 && rpmLower < d.upshiftRpm * 0.86 && rpm < this.spec.engine.redlineRpm * 0.6 && this.sinceShift > 0.6) this.requestShift(this.gear - 1);
            }
          }
        }
      }
    } else if (c.shift !== 0 && !this.shifting) {
      if (c.shift > 0) this.requestShift(this.gear === -1 ? 0 : this.gear + 1);
      else if (this.gear > 1) {
        // like a real sequential box, it refuses a downshift that would throw the engine past its limiter
        const rpmLower = (this.rpm() * d.gears[this.gear - 2]) / d.gears[this.gear - 1];
        if (rpmLower < this.spec.engine.redlineRpm * 1.02) this.requestShift(this.gear - 1);
      }
      else if (this.gear === 1) this.requestShift(0);
      else if (this.gear === 0 && Math.abs(fwd) < 2) this.requestShift(-1);
    }
    c.shift = 0;

    // overrun pops & crackles
    const crackle = this.def.sound.crackle;
    const rpm = this.rpm();
    const red = this.spec.engine.redlineRpm;
    const thrIn = this.gear === -1 && this.assists.autoShift ? c.brake : c.throttle;
    this.state.throttlePedal = thrIn;
    if (this.prevThrottleIn > 0.6 && thrIn < 0.08 && rpm > 0.55 * red && crackle > 0.05) {
      this.popBudget = Math.floor(crackle * (2 + this.rand() * 5));
      this.popTimer = 0.04 + this.rand() * 0.12;
    }
    if (thrIn < 0.1 && rpm > 0.38 * red && this.popBudget > 0) {
      this.popTimer -= dt;
      if (this.popTimer <= 0) {
        this.state.backfireCount++;
        this.popBudget--;
        this.popTimer = 0.035 + this.rand() * 0.2;
      }
    } else if (thrIn > 0.3) this.popBudget = 0;
    if (this.limiterCut && thrIn > 0.5 && this.rand() < crackle * dt * 6) this.state.backfireCount++;
    this.prevThrottleIn = thrIn;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Substep
  // ───────────────────────────────────────────────────────────────────────────

  substep(dt: number): void {
    const s = this.spec;
    const ch = s.chassis;
    const layout = s.drivetrain.layout;
    const c = this.controls;
    const as = this.assists;
    const wheels = this.wheels;
    const p = this.p;
    const v = this.v;
    const w = this.w;
    this.prevP.copy(p);
    this.prevQ.copy(this.q);

    const ax = _ax.set(1, 0, 0).applyQuaternion(this.q);
    const ay = _ay.set(0, 1, 0).applyQuaternion(this.q);
    const az = _az.set(0, 0, 1).applyQuaternion(this.q);
    const fwdSpeed = v.dot(az);

    // ── inputs ────────────────────────────────────────────────────────────────
    let throttle = clamp01(c.throttle);
    let brake = clamp01(c.brake);
    const handbrake = clamp01(c.handbrake);
    if (this.gear === -1 && as.autoShift) {
      const t = throttle;
      throttle = brake;
      brake = t;
    }
    if (this.holdOnGrid) brake = 1;

    // ── steering (rack-limited, Ackermann, optional counter-steer aid) ───────
    let target = -clamp(c.steer, -1, 1) * ch.maxSteer;
    if (as.steeringAssist > 0 && fwdSpeed > 3) {
      // front-axle travel direction relative to the chassis (+ = drifting toward the left)
      _v1.copy(az).multiplyScalar(ch.cgToFrontAxle);
      _v2.crossVectors(w, _v1).add(v);
      const vx = _v2.dot(ax);
      const vz = _v2.dot(az);
      const theta = Math.atan2(vx, Math.max(vz, 0.1));
      target += as.steeringAssist * smoothstep(3, 10, fwdSpeed) * theta;
    }
    target = clamp(target, -ch.maxSteer, ch.maxSteer);
    const maxStep = RACK_SPEED * dt;
    this.steerAngle += clamp(target - this.steerAngle, -maxStep, maxStep);
    const sa = this.steerAngle;
    if (Math.abs(sa) > 1e-4) {
      const L = ch.wheelbase;
      const R = L / Math.tan(Math.abs(sa));
      const half = ch.trackFront / 2;
      const inner = Math.atan(L / Math.max(R - half, 0.5));
      const outer = Math.atan(L / (R + half));
      const k = ch.ackermann;
      const aIn = Math.abs(sa) + k * (inner - Math.abs(sa));
      const aOut = Math.abs(sa) + k * (outer - Math.abs(sa));
      if (sa > 0) {
        wheels[0].steer = aIn;
        wheels[1].steer = aOut;
      } else {
        wheels[1].steer = -aIn;
        wheels[0].steer = -aOut;
      }
    } else {
      wheels[0].steer = wheels[1].steer = 0;
    }
    // bent suspension: the toe of each wheel (all zero on a sound car) turns it a little away from where the rack points it
    // (the rear wheels are not steered: their angle is the toe alone)
    wheels[0].steer += wheels[0].toe;
    wheels[1].steer += wheels[1].toe;
    wheels[2].steer = wheels[2].toe;
    wheels[3].steer = wheels[3].toe;

    // ── suspension geometry & forces ─────────────────────────────────────────
    let contacts = 0;
    for (let i = 0; i < 4; i++) {
      const wh = wheels[i];
      const ext = _v1.copy(p).addScaledVector(ax, wh.mx).addScaledVector(ay, wh.yExt).addScaledVector(az, wh.mz);
      // Tire envelope: a tire rides over small ridges rather than into them — sample the contact
      // patch region fore and aft, take the highest point and the mean normal.
      wh.hint = this.track.groundAt(ext.x, ext.z, _ground, wh.hint);
      const surface = _ground.surface;
      let h = _ground.height;
      const n = _gN.copy(_ground.normal);
      const reach = wh.radius * 0.38;
      const fx = az.x * reach;
      const fz = az.z * reach;
      this.track.groundAt(ext.x + fx, ext.z + fz, _ground, wh.hint);
      if (_ground.height > h) h = _ground.height;
      n.add(_ground.normal);
      this.track.groundAt(ext.x - fx, ext.z - fz, _ground, wh.hint);
      if (_ground.height > h) h = _ground.height;
      n.add(_ground.normal).normalize();
      // never trust a near-vertical face as a support plane
      if (n.y < 0.9) {
        n.y = 0.9;
        const k = Math.sqrt((1 - 0.81) / Math.max(1e-6, n.x * n.x + n.z * n.z));
        n.x *= k;
        n.z *= k;
      }
      const nu = n.dot(ay);
      const dist = n.y * (ext.y - h);
      const xReq = nu > 0.25 ? (wh.radius - dist) / nu : -1;
      let dh = Number.isNaN(wh.prevGroundH) ? 0 : (h - wh.prevGroundH) / dt;
      dh = clamp(dh, -5, 5);
      wh.prevGroundH = h;
      wh.normal.copy(n);
      wh.surface = surface;
      if (xReq > 0) {
        contacts++;
        const travel = wh.susp.travel;
        const comp = xReq < travel ? xReq : travel;
        wh.bottom = xReq - comp;
        wh.contact = true;
        wh.compression = comp;
        wh.hub.copy(ext).addScaledVector(ay, comp);
        wh.contactPt.copy(wh.hub).addScaledVector(n, -wh.radius);
        // mount velocity → compression rate (ground profile included through dh)
        _r.subVectors(ext, p);
        _v2.crossVectors(w, _r).add(v);
        wh.compVel = (n.y * (dh - _v2.y)) / nu;
        let spring = wh.susp.spring * (comp + wh.springPre);
        if (spring < 0) spring = 0;
        const damper = (wh.compVel > 0 ? wh.susp.bump : wh.susp.rebound) * wh.compVel;
        let stop = 0;
        if (wh.bottom > 0) stop = wh.susp.spring * 30 * Math.min(wh.bottom, 0.04) + wh.susp.bump * 6 * Math.max(0, wh.compVel);
        // a wheel can't push harder than ~10 g on its corner
        wh.suspForce = Math.min(spring + damper + stop, this.maxWheelForce);
      } else {
        wh.contact = false;
        wh.compression = 0;
        wh.compVel = 0;
        wh.bottom = 0;
        wh.suspForce = 0;
        wh.hub.copy(ext);
        wh.contactPt.copy(ext).addScaledVector(ay, -wh.radius);
      }
    }
    // anti-roll bars
    for (let axle = 0; axle < 2; axle++) {
      const l = wheels[axle * 2];
      const r = wheels[axle * 2 + 1];
      if (l.contact && r.contact) {
        const f = l.susp.antiRoll * (l.compression - r.compression);
        l.suspForce += f;
        r.suspForce -= f;
      }
    }

    // ── tire forces ─────────────────────────────────────────────────────────
    for (let i = 0; i < 4; i++) {
      const wh = wheels[i];
      const tire = wh.tire;
      wh.load = wh.contact && wh.suspForce > 0 ? wh.suspForce : 0;
      if (!wh.contact) {
        wh.fx = wh.fy = 0;
        wh.implicitD = 0;
        wh.rollingTorque = 2;
        wh.kappa *= 0.9;
        wh.alpha *= 0.9;
        wh.rho = 0;
        wh.skid = 0;
        wh.vLong = wh.vLat = 0;
        continue;
      }
      const n = wh.normal;
      // wheel heading → contact-plane basis
      const cs = Math.cos(wh.steer);
      const sn = Math.sin(wh.steer);
      const f = wh.fwd.copy(az).multiplyScalar(cs).addScaledVector(ax, sn);
      f.addScaledVector(n, -f.dot(n)).normalize();
      const l = wh.lat.crossVectors(n, f);
      _r.subVectors(wh.contactPt, p);
      const vc = _v2.crossVectors(w, _r).add(v);
      const vLong = vc.dot(f);
      const vLat = vc.dot(l);
      wh.vLong = vLong;
      wh.vLat = vLat;
      const surf = wh.surfaces[wh.surface];
      const wet = this.wetness > 0 ? wetGripFactor(this.wetness, tire.wetGrip ?? 0.72, surf, Math.abs(vLong)) : 1;
      // (wet-weather rubber works ~30 °C cooler than its dry window; on a winter circuit the "water" is snow and the tyre has no such window)
      const water = this.winter ? 0 : this.wetness;
      const tWork = wh.tempC + 30 * water;
      const mu = tire.mu * surf.grip * loadFactor(wh.load, tire) * tempFactor(tWork, tire) * this.gripScale * wet * wh.camberGrip;
      const aLong = Math.abs(vLong);
      const denom = aLong > SLIP_VMIN ? aLong : SLIP_VMIN;
      const kappa = (wh.omega * wh.radius - vLong) / denom;
      const tA = vLat / denom;
      // carcass relaxation on lateral slip, faded in above walking pace
      const k = aLong / tire.relaxationLength;
      wh.tanAlphaF += (tA - wh.tanAlphaF) * (1 - Math.exp(-dt * (k > 0.5 ? k : 0.5)));
      const blend = smoothstep(3, 8, aLong);
      const tAu = tA + (wh.tanAlphaF - tA) * blend;
      const sx = kappa / tire.peakSlipRatio;
      const sy = tAu / wh.tanPeakAlpha;
      const rho = Math.sqrt(sx * sx + sy * sy);
      const ratio = shapeRatio(rho, wh.shape);
      const F = mu * wh.load;
      wh.peakF = F;
      wh.fx = F * ratio * sx * 1.08;
      // (a camber error also pushes the tyre sideways, towards the lean)
      wh.fy = -F * ratio * sy + wh.camberThrust * wh.load;
      wh.implicitD = (wh.radius * wh.radius * F * ratio * 1.08) / tire.peakSlipRatio / denom;
      // (on a wet road the tread also has to push water aside, and on a winter one fresh snow aside)
      wh.rollingTorque = (tire.rollingResistance + surf.rolling + (surf.paved ? 0.004 * this.wetness : 0) + (surf.fresh !== undefined ? 0.016 * this.wetness : 0)) * wh.load * wh.radius + 2;
      wh.kappa = kappa;
      wh.alpha = Math.atan(tAu);
      wh.rho = rho;
      const vSlip = Math.hypot(wh.omega * wh.radius - vLong, vLat);
      wh.skid = smoothstep(0.85, 2.2, rho) * smoothstep(0.6, 3.5, vSlip);
      // tread temperature: sliding power + carcass flex − convection
      const pSlip = Math.abs(wh.fx * (wh.omega * wh.radius - vLong)) + Math.abs(wh.fy * vLat);
      const heat = (0.18 * pSlip + 0.006 * wh.load * aLong) / wh.heatScale;
      // (a water film cools the tread hard — slicks struggle to stay warm in the rain)
      const cool = (6 + 0.55 * aLong) * (1 + 1.1 * water) * (wh.tempC - this.ambient);
      wh.tempC += ((heat - cool) / 2600) * dt;
    }

    // ── driver aids ─────────────────────────────────────────────────────────
    const tire0 = wheels[0].tire;
    // TCS: trim throttle when driven wheels spin
    if (as.tcs !== 'off') {
      // PI control of the driven wheels' slip ratio, aiming just past the friction peak
      // (the rear tyre's peak, or for an all-wheel-drive car the smaller of the two: its front axle can be the one that spins)
      const pk = layout === 'AWD' ? Math.min(s.tireFront.peakSlipRatio, s.tireRear.peakSlipRatio) : s.tireRear.peakSlipRatio;
      const target = (as.tcs === 'high' ? 1.0 : 1.3) * pk;
      let slip = 0;
      for (const wh of wheels) if (wh.driveWeight > 0 && wh.contact) slip = Math.max(slip, wh.kappa * Math.sign(wh.vLong || 1));
      const err = (slip - target) / pk;
      this.tcsI = clamp(this.tcsI + dt * clamp(err, -3, 3) * (err > 0 ? 6 : 3), 0, 0.92);
      this.tcsFactor = 1 - clamp(this.tcsI + Math.max(0, err) * 0.3, 0, 0.92);
    } else {
      this.tcsFactor = 1;
      this.tcsI = 0;
    }
    this.tcsActive = this.tcsFactor < 0.96 && throttle > 0.1;

    // ABS: pulse brake pressure on locking wheels
    let absOn = false;
    for (const wh of wheels) {
      if (as.abs && brake > 0.05 && wh.contact && Math.abs(wh.vLong) > 2) {
        const lockSlip = -wh.kappa * Math.sign(wh.vLong);
        const pk = wh.tire.peakSlipRatio;
        if (lockSlip > pk * 1.35) wh.absFactor = Math.max(ABS_MIN_PRESSURE, wh.absFactor - dt * 16);
        else if (lockSlip < pk * 0.95) wh.absFactor = Math.min(1, wh.absFactor + dt * 7);
        if (wh.absFactor < 0.97) absOn = true;
      } else wh.absFactor = 1;
    }
    this.absActive = absOn;

    // ESC: yaw-rate control by braking single wheels
    for (const wh of wheels) wh.escBrake = 0;
    this.escThrottle = 1;
    this.escActive = false;
    if (as.esc && fwdSpeed > 8 && contacts >= 3) {
      const L = ch.wheelbase;
      const yaw = w.dot(ay);
      // (the most yaw rate the road can hold: the tyre's friction on the surface it is on, 1 on asphalt, half on packed snow)
      let gripSum = 0;
      let loadSum = 0;
      for (const wh of wheels) {
        if (!wh.contact) continue;
        const sf = wh.surfaces[wh.surface];
        gripSum += wh.load * sf.grip * (sf.fresh !== undefined ? 1 + (sf.fresh - 1) * this.wetness : 1);
        loadSum += wh.load;
      }
      const maxYaw = (tire0.mu * (loadSum > 0 ? gripSum / loadSum : 1) * GRAVITY) / fwdSpeed;
      // (the steering the car answers is the rack's plus the mean toe of the front wheels: a car pulling to one side is driven with
      // the wheel held the other way, and stability control must not mistake that steering for a turn the car is not making)
      const ref = clamp((fwdSpeed * (sa + this.toeMean)) / (L + 0.0022 * fwdSpeed * fwdSpeed), -maxYaw, maxYaw);
      const err = yaw - ref;
      const dead = 0.06 + 0.12 * Math.abs(ref);
      if (Math.abs(err) > dead) {
        const amount = clamp((Math.abs(err) - dead) * 3, 0, 1);
        this.escActive = true;
        if (Math.abs(yaw) > Math.abs(ref)) {
          // oversteer → brake the outer front (yaw > 0 is a left turn → outer is FR)
          const outer = yaw > 0 ? wheels[1] : wheels[0];
          outer.escBrake = amount * s.brakes.frontTorque * 0.7;
          this.escThrottle = 1 - amount * 0.7;
        } else {
          // understeer → brake the inner rear
          const inner = ref > 0 ? wheels[2] : wheels[3];
          inner.escBrake = amount * s.brakes.rearTorque * 0.6;
          this.escThrottle = 1 - amount * 0.4;
        }
      }
    }

    // ── powertrain ──────────────────────────────────────────────────────────
    this.solveDrivetrain(dt, throttle, brake, handbrake);

    // brake & tire thermals
    for (const wh of wheels) {
      const pBrake = wh.brakeTorque * Math.abs(wh.omega);
      const cap = s.brakes.discHeatCapacity * (wh.front ? 1 : 0.8);
      const cool = (6 + 1.6 * Math.abs(wh.vLong)) * (wh.brakeTempC - this.ambient) * 0.6;
      wh.brakeTempC += ((pBrake * 0.92 - cool) / cap) * dt;
      wh.spin += wh.omega * dt;
      if (wh.spin > 1e4 || wh.spin < -1e4) wh.spin %= Math.PI * 2;
    }

    // ── chassis forces ──────────────────────────────────────────────────────
    const F = _force.set(0, -this.mass * GRAVITY, 0);
    const T = _torque.set(0, 0, 0);
    for (const wh of wheels) {
      if (!wh.contact) continue;
      // vertical load at the contact patch
      _f.copy(wh.normal).multiplyScalar(wh.load);
      _r.subVectors(wh.contactPt, p);
      F.add(_f);
      T.add(_t.crossVectors(_r, _f));
      // horizontal tire forces, acting at the roll-center height
      _f.copy(wh.fwd).multiplyScalar(wh.fx).addScaledVector(wh.lat, wh.fy);
      _r.addScaledVector(ay, wh.rcHeight);
      F.add(_f);
      T.add(_t.crossVectors(_r, _f));
      // ploughing through gravel / sand
      const plough = wh.surfaces[wh.surface].plough;
      if (plough > 0) {
        _r.subVectors(wh.contactPt, p);
        _v2.crossVectors(w, _r).add(v);
        _f.copy(_v2).multiplyScalar(-plough * wh.load);
        F.add(_f);
        T.add(_t.crossVectors(_r, _f));
      }
    }
    // nitro: the bottle's push along the car, with the throttle, in a forward gear
    if (this.nitro > 0 && this.gear >= 1) {
      const push = this.nitro * NITRO_THRUST_G * GRAVITY * this.mass * clamp01(this.controls.throttle);
      if (push > 0) F.addScaledVector(az, push);
    }
    // aerodynamics
    const speed2 = v.lengthSq();
    if (speed2 > 0.01) {
      const sp = Math.sqrt(speed2);
      _f.copy(v).multiplyScalar(-0.5 * AIR_DENSITY * s.aero.dragArea * this.dragMul * sp);
      _r.copy(this.hullCenterLocal).applyQuaternion(this.q);
      F.add(_f);
      T.add(_t.crossVectors(_r, _f));
      const vf = fwdSpeed > 0 ? fwdSpeed : 0;
      const qd = 0.5 * AIR_DENSITY * vf * vf * this.downforceMul;
      if (qd > 0) {
        const dfF = qd * s.aero.liftAreaFront * this.aeroFrontMul;
        const dfR = qd * s.aero.liftAreaRear * this.aeroRearMul;
        _f.copy(ay).multiplyScalar(-dfF);
        _r.copy(az).multiplyScalar(ch.cgToFrontAxle);
        F.add(_f);
        T.add(_t.crossVectors(_r, _f));
        _f.copy(ay).multiplyScalar(-dfR);
        _r.copy(az).multiplyScalar(-(ch.wheelbase - ch.cgToFrontAxle));
        F.add(_f);
        T.add(_t.crossVectors(_r, _f));
      }
    }

    // ── integrate velocities ────────────────────────────────────────────────
    v.addScaledVector(F, this.invMass * dt);
    // angular, in the body frame (with the gyroscopic term)
    _q1.copy(this.q).invert();
    const wl = _v3.copy(w).applyQuaternion(_q1);
    const tl = T.applyQuaternion(_q1);
    const I = this.inertia;
    const gx = wl.y * I.z * wl.z - wl.z * I.y * wl.y;
    const gy = wl.z * I.x * wl.x - wl.x * I.z * wl.z;
    const gz = wl.x * I.y * wl.y - wl.y * I.x * wl.x;
    wl.x += ((tl.x - gx) / I.x) * dt;
    wl.y += ((tl.y - gy) / I.y) * dt;
    wl.z += ((tl.z - gz) / I.z) * dt;
    w.copy(wl).applyQuaternion(this.q);

    // ── collisions ──────────────────────────────────────────────────────────
    this.impactCooldown -= dt;
    this.scrapeAcc *= 1 - dt * 6;
    this.collideWalls(dt);
    this.collideGround(ay);

    // ── integrate positions ─────────────────────────────────────────────────
    p.addScaledVector(v, dt);
    const qx = this.q.x;
    const qy = this.q.y;
    const qz = this.q.z;
    const qw = this.q.w;
    const hx = 0.5 * dt * w.x;
    const hy = 0.5 * dt * w.y;
    const hz = 0.5 * dt * w.z;
    this.q.set(qx + hx * qw + hy * qz - hz * qy, qy + hy * qw + hz * qx - hx * qz, qz + hz * qw + hx * qy - hy * qx, qw - hx * qx - hy * qy - hz * qz).normalize();
  }

  /** Engine, clutch, gearbox, differential(s), brakes and wheel spin — solved implicitly. */
  private solveDrivetrain(dt: number, throttleIn: number, brakeIn: number, handbrake: number): void {
    const s = this.spec;
    const e = s.engine;
    const d = s.drivetrain;
    const wheels = this.wheels;
    const as = this.assists;

    // gear change state machine
    let shiftClutch = 1;
    let shiftThrottle = -1;
    if (this.shifting) {
      this.shiftTimer += dt;
      const phase = this.shiftTimer / this.shiftDuration;
      const upshift = this.shiftTarget > this.gear;
      if (phase >= 0.5 && this.gear !== this.shiftTarget) this.gear = this.shiftTarget;
      shiftClutch = phase < 0.5 ? 0 : clamp01((phase - 0.5) * 2);
      if (phase < 1) {
        if (upshift && this.gear !== this.shiftTarget) shiftThrottle = 0;
        else if (!upshift && this.gear >= 1) {
          // auto blip to rev-match the lower gear
          const carrier = this.drivenOmega();
          const targetRpm = Math.abs(carrier * this.totalRatio(this.shiftTarget)) * RADS_TO_RPM;
          shiftThrottle = this.rpm() < targetRpm ? 0.75 : 0;
        }
      } else {
        this.shifting = false;
        this.sinceShift = 0;
        this.state.shiftCount++;
      }
    }

    const G = this.totalRatio(this.gear);
    const rpm = this.rpm();

    // engine torque
    const idleThrottle = clamp((e.idleRpm + 80 - rpm) / 450, 0, 0.45);
    let th = throttleIn * this.tcsFactor * this.escThrottle;
    if (shiftThrottle >= 0) th = shiftThrottle;
    if (this.launching && !this.clutchLocked && G !== 0) {
      th *= clamp01(1 - (rpm - this.launchRpm(clamp01(throttleIn))) / 450);
    }
    this.launching = false;
    if (rpm > e.limiterRpm) this.limiterCut = true;
    else if (rpm < e.limiterRpm - 150) this.limiterCut = false;
    if (this.limiterCut) th = 0;
    if (th < idleThrottle) th = idleThrottle;
    let boostFactor = 1;
    if (e.turbo) {
      const tb = e.turbo;
      const thBoost = shiftThrottle >= 0 ? Math.max(th, throttleIn * 0.9) : th;
      const target = thBoost * smoothstep(tb.spoolRpm * 0.55, tb.spoolRpm * 1.35, rpm);
      const rate = target > this.boost ? (1 / tb.spoolTime) * (0.4 + 0.9 * clamp01(rpm / e.redlineRpm)) : 4;
      this.boost += (target - this.boost) * clamp01(rate * dt);
      boostFactor = tb.baseFraction + (1 - tb.baseFraction) * this.boost;
    }
    const nitroMul = this.nitro > 0 && this.gear >= 1 ? 1 + NITRO_POWER * this.nitro : 1;
    const full = torqueAt(e, rpm) * boostFactor * this.powerMul * nitroMul;
    const braking = e.engineBraking * clamp01(rpm / e.limiterRpm) + 0.015 * this.torquePeak;
    let Te = th * full - (1 - th) * braking;
    if (Te > 0) Te *= d.efficiency;
    this.appliedThrottle = th;
    this.engineLoad = full > 0 ? clamp01((th * full) / this.torquePeak) : 0;

    // clutch engagement
    let engage: number;
    if (G === 0) engage = 0;
    else if (as.autoClutch) {
      // Once engine and driveline turn together the clutch stays locked until the driveline drops
      // to idle. Below that it slips like a launch control: its torque capacity is capped near what
      // the driven tires can take, and the engine is held at a launch rpm.
      const carrierSigned = this.drivenOmega() * G;
      const carrierRpm = Math.abs(carrierSigned) * RADS_TO_RPM;
      if (this.clutchLocked) {
        if (carrierRpm < e.idleRpm * 1.02 || carrierSigned < 0) this.clutchLocked = false;
      } else if (carrierSigned > 0 && carrierRpm > e.idleRpm * 1.05 && carrierRpm > rpm * 0.9) this.clutchLocked = true;
      if (this.clutchLocked) engage = 1;
      else {
        const tIn = clamp01(throttleIn);
        const capFrac = (this.launchCapacity / Math.abs(G)) * (0.3 + 0.7 * tIn) / this.clutchMax;
        const launchRpm = Math.max(e.idleRpm + 900, this.launchRpm(tIn));
        engage = smoothstep(Math.max(launchRpm - 1300, e.idleRpm + 150), launchRpm - 150, rpm) * Math.min(1, capFrac);
        this.launching = tIn > 0.05;
      }
      if (handbrake > 0.3) engage *= 1 - handbrake;
    } else engage = 1 - clamp01(this.controls.clutch);
    if (this.holdOnGrid) engage = 0;
    engage *= shiftClutch;
    this.clutchEngage = engage;
    const clutchCap = engage * this.clutchMax;

    // brakes (+ ABS / ESC) and rolling resistance are friction torques
    for (const wh of wheels) {
      let tb = brakeIn * (wh.front ? s.brakes.frontTorque : s.brakes.rearTorque) * wh.absFactor + wh.escBrake;
      if (!wh.front) tb += handbrake * s.brakes.handbrakeTorque;
      wh.brakeTorque = tb;
    }
    this.appliedBrake = brakeIn;

    // free update: tire reaction torque (implicit in wheel speed) and engine torque
    const Ie = this.engineInertia;
    for (const wh of wheels) {
      const Ieff = wh.tire.inertia + dt * wh.implicitD;
      wh.omega += (dt * (-wh.fx * wh.radius)) / Ieff;
    }
    this.omegaE += (dt * Te) / Ie;

    // sequential impulses: clutch, differentials, brakes
    let lc = 0;
    const lb0 = [0, 0, 0, 0];
    const capC = clutchCap * dt;
    // (forward gears only) the clutch slips before the driveline can drag the driven tyres past a share of their grip
    let capOver = capC;
    if (G > 0) {
      let tq = 0;
      for (const wh of wheels) if (wh.driveWeight > 0 && wh.contact) tq += wh.peakF * wh.radius;
      capOver = Math.min(capC, ((SLIPPER_GRIP_SHARE * tq) / G) * dt);
    }
    const fl = wheels[0];
    const fr = wheels[1];
    const rl = wheels[2];
    const rr = wheels[3];
    const inFront = Math.abs(this.lastClutchTorque * G) * (fl.driveWeight * 2);
    const inRear = Math.abs(this.lastClutchTorque * G) * (rl.driveWeight * 2);
    const capFront = this.diffCap(d.layout === 'AWD' ? (d.frontDiff ?? { type: 'open', preload: 0, powerLock: 0, coastLock: 0 }) : d.diff, inFront, this.lastClutchTorque) * dt;
    const capRear = this.diffCap(d.diff, inRear, this.lastClutchTorque) * dt;
    // (the handbrake lets the centre go: it acts on the rear wheels only, and a centre that held the front axle to the locked rear one would
    // brake all four, so a handbrake turn needs it open; at half the lever it is)
    const capCenter = d.layout === 'AWD' ? this.diffCap(d.centerDiff ?? { type: 'lsd', preload: 50, powerLock: 0.3, coastLock: 0.3 }, Math.abs(this.lastClutchTorque * G), this.lastClutchTorque) * dt * (1 - clamp01(2 * handbrake)) : 0;
    let ldF = 0;
    let ldR = 0;
    let ldC = 0;
    const I0 = fl.tire.inertia + dt * fl.implicitD;
    const I1 = fr.tire.inertia + dt * fr.implicitD;
    const I2 = rl.tire.inertia + dt * rl.implicitD;
    const I3 = rr.tire.inertia + dt * rr.implicitD;
    const Iw = [I0, I1, I2, I3];
    for (let it = 0; it < 6; it++) {
      if (capC > 0) {
        let carrier = 0;
        let kInv = 1 / Ie;
        for (let i = 0; i < 4; i++) {
          const wt = wheels[i].driveWeight;
          if (wt > 0) {
            carrier += wt * wheels[i].omega;
            kInv += (G * G * wt * wt) / Iw[i];
          }
        }
        const delta = this.omegaE - G * carrier;
        let nl = lc + delta / kInv;
        nl = nl < -capOver ? -capOver : nl > capC ? capC : nl;
        const dl = nl - lc;
        lc = nl;
        this.omegaE -= dl / Ie;
        for (let i = 0; i < 4; i++) {
          const wt = wheels[i].driveWeight;
          if (wt > 0) wheels[i].omega += (G * wt * dl) / Iw[i];
        }
      }
      // axle differentials
      if (fl.driveWeight > 0 && capFront > 0) {
        const delta = fl.omega - fr.omega;
        let nl = ldF + delta / (1 / I0 + 1 / I1);
        nl = nl < -capFront ? -capFront : nl > capFront ? capFront : nl;
        const dl = nl - ldF;
        ldF = nl;
        fl.omega -= dl / I0;
        fr.omega += dl / I1;
      }
      if (rl.driveWeight > 0 && capRear > 0) {
        const delta = rl.omega - rr.omega;
        let nl = ldR + delta / (1 / I2 + 1 / I3);
        nl = nl < -capRear ? -capRear : nl > capRear ? capRear : nl;
        const dl = nl - ldR;
        ldR = nl;
        rl.omega -= dl / I2;
        rr.omega += dl / I3;
      }
      if (capCenter > 0) {
        // the speeds of the two output shafts (each axle's mean wheel speed times its ratio): a car on tyres of different sizes at the front
        // and the rear rolls with different wheel speeds, which a centre that compared the wheels themselves would fight for good
        const iF = this.centerRatioF;
        const iR = this.centerRatioR;
        const delta = (iF * (fl.omega + fr.omega)) / 2 - (iR * (rl.omega + rr.omega)) / 2;
        const kInv = 0.25 * (iF * iF * (1 / I0 + 1 / I1) + iR * iR * (1 / I2 + 1 / I3));
        let nl = ldC + delta / kInv;
        nl = nl < -capCenter ? -capCenter : nl > capCenter ? capCenter : nl;
        const dl = nl - ldC;
        ldC = nl;
        fl.omega -= (0.5 * iF * dl) / I0;
        fr.omega -= (0.5 * iF * dl) / I1;
        rl.omega += (0.5 * iR * dl) / I2;
        rr.omega += (0.5 * iR * dl) / I3;
      }
      // brakes + rolling resistance: friction toward zero wheel speed
      for (let i = 0; i < 4; i++) {
        const wh = wheels[i];
        const cap = (wh.brakeTorque + wh.rollingTorque) * dt;
        let nl = lb0[i] - wh.omega * Iw[i];
        nl = nl < -cap ? -cap : nl > cap ? cap : nl;
        wh.omega += (nl - lb0[i]) / Iw[i];
        lb0[i] = nl;
      }
    }
    this.lastClutchTorque = lc / dt;
    if (this.omegaE < 0) this.omegaE = 0;
  }

  /** Engine speed held by launch control for a given throttle. */
  private launchRpm(throttle: number): number {
    const e = this.spec.engine;
    return Math.max(e.idleRpm + 900, Math.min(0.5 * e.redlineRpm, 4600) * (0.55 + 0.45 * throttle));
  }

  /** Locking torque capacity of a differential for a given input torque. */
  private diffCap(diff: DifferentialSpec, inputTorque: number, signedClutch: number): number {
    if (diff.type === 'open') return 0;
    if (diff.type === 'locked') return 1e7;
    const lock = signedClutch >= 0 ? diff.powerLock : diff.coastLock;
    return diff.preload + lock * inputTorque;
  }

  /** Mean speed of the driven wheels weighted by torque split (the gearbox output / G). */
  private drivenOmega(): number {
    let c = 0;
    for (const wh of this.wheels) c += wh.driveWeight * wh.omega;
    return c;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Collisions
  // ───────────────────────────────────────────────────────────────────────────

  /** Single-body contact against static geometry at world point P with normal n. */
  /** Debug counters (not part of the contract). */
  debugGroundHits = 0;
  debugWallHits = 0;

  private resolveStatic(P: Vector3, n: Vector3, pen: number, restitution: number, friction: number, kind: ImpactKind): void {
    if (kind === 'ground') this.debugGroundHits++;
    else this.debugWallHits++;
    const v = this.v;
    const w = this.w;
    const r = _r.subVectors(P, this.p);
    const vp = _v2.crossVectors(w, r).add(v);
    const vn = vp.dot(n);
    if (vn < 0) {
      // effective mass along n
      const rn = _t.crossVectors(r, n);
      this.applyInvInertia(rn);
      _v3.crossVectors(rn, r);
      const k = this.invMass + n.dot(_v3);
      const j = (-(1 + restitution) * vn) / k;
      v.addScaledVector(n, j * this.invMass);
      w.addScaledVector(rn, j);
      // Coulomb friction
      _v2.crossVectors(w, r).add(v);
      const vnn = _v2.dot(n);
      _v2.addScaledVector(n, -vnn);
      const vt = _v2.length();
      if (vt > 1e-4) {
        const t = _v2.multiplyScalar(1 / vt);
        const rt = _v3.crossVectors(r, t);
        this.applyInvInertia(rt);
        const kt = this.invMass + t.dot(_f.crossVectors(rt, r));
        const jt = Math.min(vt / kt, friction * j);
        v.addScaledVector(t, -jt * this.invMass);
        w.addScaledVector(rt, -jt);
        const scr = clamp01(vt / 12) * clamp01(j * this.invMass * 20 + 0.3);
        if (scr > this.scrapeAcc) {
          this.scrapeAcc = scr;
          this.scrapePt.copy(P);
        }
      }
      const strength = -vn;
      const threshold = kind === 'ground' ? 2.2 : 1.2;
      if (strength > threshold && (this.impactCooldown <= 0 || strength > this.state.lastImpact.strength * 1.5)) {
        this.state.impactCount++;
        this.state.lastImpact.strength = strength;
        this.state.lastImpact.point.copy(P);
        this.state.lastImpact.normal.copy(n);
        this.state.lastImpact.kind = kind;
        this.impactCooldown = 0.12;
      }
    }
    if (pen > 0.004) this.p.addScaledVector(n, (pen - 0.004) * 0.25);
  }

  /**
   * A hull point in a snowbank: P is `pen` metres past the barrier line, n points back to the road. The bank is not a wall that
   * answers with an impulse but a body of packed snow that gives way:
   *   - a spring that stiffens with depth and a damper while the point moves in, so the car is slowed over a metre or more
   *     (a few g at a hard hit) instead of stopped in a millisecond;
   *   - on the way out only a fifth of that spring, and no damper: the snow stays packed, it does not throw the car back, it
   *     lets it go and pushes it gently towards the road;
   *   - the flank drags along it, heaping snow against it (the friction rises with how hard the car presses);
   *   - past BANK_DEPTH it is as hard as the frozen ground under it (an inelastic stop).
   * The hit registers as a `snow` impact at a third of its closing speed: a thump the damage model hardly feels.
   */
  private resolveBank(P: Vector3, n: Vector3, pen: number, dt: number): void {
    this.debugWallHits++;
    const v = this.v;
    const w = this.w;
    const r = _r.subVectors(P, this.p);
    const vp = _v2.crossVectors(w, r).add(v);
    const vn = vp.dot(n);
    const depth = pen < BANK_DEPTH ? pen : BANK_DEPTH;
    let F = BANK_STIFFNESS * depth * (1 + depth / BANK_DEPTH);
    if (vn < 0) F -= BANK_DAMPING * vn;
    else {
      F = F * BANK_UNLOAD - BANK_OUT_DAMPING * vn;
      if (F < 0) F = 0;
    }
    const j = F * dt;
    if (j > 0) {
      const rn = _t.crossVectors(r, n);
      this.applyInvInertia(rn);
      v.addScaledVector(n, j * this.invMass);
      w.addScaledVector(rn, j);
      // the flank drags along the snow
      const vt2 = vp.lengthSq() - vn * vn;
      if (vt2 > 1e-6) {
        const vt = Math.sqrt(vt2);
        // tangential direction of the contact point's velocity (vp is the velocity before this impulse)
        _v3.copy(vp).addScaledVector(n, -vn).multiplyScalar(1 / vt);
        const jt = Math.min(BANK_FRICTION * j * (vt / (vt + 0.4)), vt / (this.invMass + 1e-9) * 0.5);
        const rt = _t.crossVectors(r, _v3);
        this.applyInvInertia(rt);
        v.addScaledVector(_v3, -jt * this.invMass);
        w.addScaledVector(rt, -jt);
      }
    }
    const strength = -vn * BANK_IMPACT;
    if (strength > 1.0 && (this.impactCooldown <= 0 || strength > this.state.lastImpact.strength * 1.5)) {
      this.state.impactCount++;
      this.state.lastImpact.strength = strength;
      this.state.lastImpact.point.copy(P);
      this.state.lastImpact.normal.copy(n);
      this.state.lastImpact.kind = 'snow';
      this.impactCooldown = 0.12;
    }
    // the frozen ground under the bank
    if (pen > BANK_DEPTH) this.resolveStatic(P, n, pen - BANK_DEPTH, 0, 0.5, 'wall');
  }

  /** v ← I⁻¹_world · v (in place). */
  private applyInvInertia(vec: Vector3): void {
    _q1.copy(this.q).invert();
    vec.applyQuaternion(_q1);
    vec.x *= this.invInertia.x;
    vec.y *= this.invInertia.y;
    vec.z *= this.invInertia.z;
    vec.applyQuaternion(this.q);
  }

  private collideWalls(dt: number): void {
    const tr = this.track;
    this.comHint = tr.project(this.p.x, this.p.z, _tp, this.comHint);
    const margin = this.hullRadiusXZ + 0.3;
    if (_tp.d + margin < _tp.wallLeft && -_tp.d + margin < _tp.wallRight) return;
    const P = _v1;
    const n = _f;
    for (const hp of this.hullPoints) {
      P.copy(hp).applyQuaternion(this.q).add(this.p);
      tr.project(P.x, P.z, _tp, this.comHint);
      const penL = _tp.d - _tp.wallLeft;
      const penR = -_tp.d - _tp.wallRight;
      let pen = 0;
      let soft = 0;
      if (penL > 0) {
        n.set(-_tp.lx, 0, -_tp.lz);
        pen = penL;
        soft = _tp.softLeft ?? 0;
      } else if (penR > 0) {
        n.set(_tp.lx, 0, _tp.lz);
        pen = penR;
        soft = _tp.softRight ?? 0;
      } else continue;
      // copy n: resolveStatic uses _f as scratch
      const nx = n.x;
      const nz = n.z;
      _wallN.set(nx, 0, nz);
      if (soft > 0.5) this.resolveBank(P, _wallN, pen, dt);
      else this.resolveStatic(P, _wallN, pen, 0.22, 0.32, 'wall');
    }
  }

  private collideGround(ay: Vector3): void {
    const upright = ay.y;
    const tr = this.track;
    const P = _v1;
    for (let i = 0; i < this.groundPoints.length; i++) {
      const hp = this.groundPoints[i];
      const isTop = hp.y > this.hullCenterLocal.y - 0.05;
      if (isTop && upright > 0.5) continue; // roof/shoulders only touch when the car is on its side/roof
      P.copy(hp).applyQuaternion(this.q).add(this.p);
      this.hullHint = tr.groundAt(P.x, P.z, _ground, this.hullHint);
      const pen = (_ground.height - P.y) * _ground.normal.y;
      if (pen <= 0) continue;
      _groundN.copy(_ground.normal);
      // skid blocks slide easily; bodywork digs in
      this.resolveStatic(P, _groundN, pen, 0.1, isTop ? 0.55 : 0.28, 'ground');
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Output
  // ───────────────────────────────────────────────────────────────────────────

  /** Fill `state` (interpolated between the last two substeps by `alpha`). */
  publish(alpha: number, frameDt: number): void {
    const st = this.state;
    st.position.lerpVectors(this.prevP, this.p, alpha);
    st.quaternion.slerpQuaternions(this.prevQ, this.q, alpha);
    st.velocity.copy(this.v);
    st.angularVelocity.copy(this.w);
    st.speed = this.v.length();
    const az = _az.set(0, 0, 1).applyQuaternion(this.q);
    st.forwardSpeed = this.v.dot(az);
    // smoothed acceleration in the car frame
    if (frameDt > 0) {
      _v1.subVectors(this.v, this.frameV).multiplyScalar(1 / frameDt);
      _q1.copy(this.q).invert();
      _v1.applyQuaternion(_q1);
      const k = 1 - Math.exp(-frameDt / 0.06);
      this.accelSmoothed.lerp(_v1, k);
    }
    this.frameV.copy(this.v);
    st.localAccel.copy(this.accelSmoothed);
    const ch = this.spec.chassis;
    st.steer = clamp(-this.steerAngle / ch.maxSteer, -1, 1);
    st.throttle = this.appliedThrottle;
    st.brake = this.appliedBrake;
    st.handbrake = clamp01(this.controls.handbrake);
    st.clutch = 1 - this.clutchEngage;
    st.rpm = this.rpm();
    st.gear = this.gear;
    st.engineLoad = this.engineLoad;
    st.boost = this.boost;
    st.nitro = this.nitro;
    st.revLimiter = this.limiterCut;
    st.absActive = this.absActive;
    st.tcsActive = this.tcsActive;
    st.escActive = this.escActive;
    st.scrape = this.scrapeAcc > 0.02 ? this.scrapeAcc : 0;
    st.scrapePoint.copy(this.scrapePt);
    let air = true;
    const ax = _ax.set(1, 0, 0).applyQuaternion(st.quaternion);
    const ay = _ay.set(0, 1, 0).applyQuaternion(st.quaternion);
    const azi = _az.set(0, 0, 1).applyQuaternion(st.quaternion);
    for (let i = 0; i < 4; i++) {
      const wh = this.wheels[i];
      const o = st.wheels[i];
      if (wh.contact) air = false;
      o.hub.copy(st.position).addScaledVector(ax, wh.mx).addScaledVector(ay, wh.yExt + wh.compression).addScaledVector(azi, wh.mz);
      o.contactNormal.copy(wh.normal);
      o.contactPoint.copy(o.hub).addScaledVector(wh.contact ? wh.normal : ay, -wh.radius);
      o.steerAngle = wh.steer;
      o.spin = wh.spin;
      o.omega = wh.omega;
      o.compression = wh.compression / wh.susp.travel;
      o.suspensionVelocity = wh.compVel;
      o.contact = wh.contact;
      o.surface = wh.surface;
      o.load = wh.load;
      o.slipRatio = wh.kappa;
      o.slipAngle = wh.alpha;
      o.forceLong = wh.fx;
      o.forceLat = wh.fy;
      o.skid = wh.skid;
      o.tempC = wh.tempC;
      o.brakeTempC = wh.brakeTempC;
    }
    st.airborne = air;
  }

  /** Normalized combined slip of each tire (1 = at the peak) — for HUD / AI / audio. */
  slipUsage(i: number): number {
    return this.wheels[i].rho;
  }

  /** Static load on one wheel (N), for normalizing telemetry. */
  staticLoad(i: number): number {
    const c = this.spec.chassis;
    const a = c.cgToFrontAxle;
    const b = c.wheelbase - a;
    return (c.mass * GRAVITY * (i < 2 ? b : a)) / c.wheelbase / 2;
  }

  /** Drop all motion (used by resets). */
  stop(): void {
    this.v.set(0, 0, 0);
    this.w.set(0, 0, 0);
    for (const wh of this.wheels) wh.omega = 0;
  }
}

const _wallN = new Vector3();
const _groundN = new Vector3();
