/**
 * A tiny longitudinal drivetrain simulator that produces plausible VehicleState sequences from a
 * car's real physics spec (torque curve, gear ratios, shift time, turbo spool, rev limiter). It is
 * NOT the game's physics — it exists so the audio can be exercised, measured and auditioned
 * before / without the real vehicle model.
 */
import { Quaternion, Vector3 } from 'three';
import type { CarDefinition, SurfaceType, VehicleState, WheelState } from '../../src/core/contracts';

function makeWheel(): WheelState {
  return {
    hub: new Vector3(),
    contactPoint: new Vector3(),
    contactNormal: new Vector3(0, 1, 0),
    steerAngle: 0,
    spin: 0,
    omega: 0,
    radius: 0.34,
    width: 0.25,
    compression: 0.3,
    suspensionVelocity: 0,
    contact: true,
    surface: 'asphalt',
    load: 4000,
    slipRatio: 0,
    slipAngle: 0,
    forceLong: 0,
    forceLat: 0,
    skid: 0,
    tempC: 80,
    brakeTempC: 200,
  };
}

export function makeVehicleState(id = 0): VehicleState {
  return {
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
    brake: 0,
    handbrake: 0,
    clutch: 0,
    rpm: 900,
    idleRpm: 900,
    redlineRpm: 6800,
    limiterRpm: 7000,
    gear: 1,
    gearCount: 6,
    engineLoad: 0,
    boost: 0,
    revLimiter: false,
    absActive: false,
    tcsActive: false,
    escActive: false,
    shiftCount: 0,
    backfireCount: 0,
    impactCount: 0,
    lastImpact: { strength: 0, point: new Vector3(), normal: new Vector3(0, 0, 1), kind: 'wall' },
    scrape: 0,
    scrapePoint: new Vector3(),
    wheels: [makeWheel(), makeWheel(), makeWheel(), makeWheel()],
    airborne: false,
  };
}

function curve(c: [number, number][], x: number): number {
  if (x <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (x <= c[i][0]) {
      const t = (x - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
      return c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t;
    }
  }
  return c[c.length - 1][1];
}

export interface DriveOptions {
  gear?: number;
  speed?: number; // m/s
  rpm?: number;
  seed?: number;
}

export class DriveSim {
  readonly st: VehicleState;
  private v: number;
  private gear: number;
  private rpm: number;
  private boost = 0;
  private shifting = 0;
  private shiftTo = 1;
  private limCut = 0;
  private tSinceLift = 9;
  private seed: number;
  private z = 0;
  private lastLoad = 0;

  constructor(readonly car: CarDefinition, opts: DriveOptions = {}) {
    this.st = makeVehicleState();
    const e = car.physics.engine;
    const d = car.physics.drivetrain;
    this.gear = opts.gear ?? 1;
    this.v = opts.speed ?? 0;
    this.rpm = opts.rpm ?? e.idleRpm;
    this.seed = (opts.seed ?? 1234) | 0;
    this.st.idleRpm = e.idleRpm;
    this.st.redlineRpm = e.redlineRpm;
    this.st.limiterRpm = e.limiterRpm;
    this.st.gearCount = d.gears.length;
    this.st.rpm = this.rpm;
    for (const w of this.st.wheels) w.radius = car.physics.tireRear.radius;
    this.rpm = Math.max(e.idleRpm, this.rpmFromSpeed(this.v, this.gear));
    if (opts.rpm !== undefined && opts.speed === undefined) this.v = this.speedFromRpm(opts.rpm, this.gear);
    this.sync(0, 0, 0, 0);
  }

  private rnd(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) | 0;
    return (this.seed >>> 0) / 4294967296;
  }

  private ratio(g: number): number {
    const d = this.car.physics.drivetrain;
    return d.gears[g - 1] * d.finalDrive;
  }
  private rpmFromSpeed(v: number, g: number): number {
    const r = this.car.physics.tireRear.radius;
    return ((v / r) * this.ratio(g) * 60) / (2 * Math.PI);
  }
  private speedFromRpm(rpm: number, g: number): number {
    const r = this.car.physics.tireRear.radius;
    return (((rpm * 2 * Math.PI) / 60) * r) / this.ratio(g);
  }

  /** Advance by dt seconds (internally sub-stepped at 1 kHz). */
  step(dt: number, throttle: number, brake = 0, autoShift = true): void {
    const n = Math.max(1, Math.round(dt * 1000));
    const h = dt / n;
    const car = this.car;
    const eng = car.physics.engine;
    const drv = car.physics.drivetrain;
    const mass = car.physics.chassis.mass;
    const rw = car.physics.tireRear.radius;
    const nG = drv.gears.length;
    let load = 0;
    let torque = 0;
    for (let k = 0; k < n; k++) {
      // gear change in progress
      if (this.shifting > 0) {
        this.shifting -= h;
        const target = this.rpmFromSpeed(this.v, this.shiftTo);
        this.rpm += (target - this.rpm) * Math.min(1, h / 0.035);
        if (this.shifting <= 0) {
          this.gear = this.shiftTo;
          this.st.shiftCount++;
          this.rpm = Math.max(eng.idleRpm, this.rpmFromSpeed(this.v, this.gear));
        }
      } else {
        const rpmDrive = this.rpmFromSpeed(this.v, this.gear);
        // engine follows the driveline (clutch engaged); never below idle (slip)
        this.rpm += (Math.max(eng.idleRpm, rpmDrive) - this.rpm) * Math.min(1, h / 0.012);
        if (autoShift) {
          if (this.rpm > drv.upshiftRpm && this.gear < nG && throttle > 0.3) {
            this.shifting = drv.shiftTime;
            this.shiftTo = this.gear + 1;
          } else if (this.rpm < drv.downshiftRpm && this.gear > 1 && throttle < 0.9) {
            this.shifting = drv.shiftTime;
            this.shiftTo = this.gear - 1;
          }
        }
      }

      // limiter
      const overLimit = this.rpm >= eng.limiterRpm;
      if (overLimit) this.limCut = 0.045;
      if (this.limCut > 0) this.limCut -= h;
      const cut = this.limCut > 0;

      // turbo boost
      if (eng.turbo) {
        const spoolOk = Math.min(1, Math.max(0, (this.rpm - eng.turbo.spoolRpm * 0.6) / (eng.turbo.spoolRpm * 0.9)));
        const target = throttle * spoolOk * (cut ? 0.4 : 1);
        const tau = target > this.boost ? eng.turbo.spoolTime : 0.45;
        this.boost += ((target - this.boost) / tau) * h;
      } else this.boost = 0;

      // engine torque
      const full = curve(eng.torqueCurve, this.rpm) * (eng.turbo ? eng.turbo.baseFraction + (1 - eng.turbo.baseFraction) * this.boost : 1);
      const thr = this.shifting > 0 || cut ? 0 : throttle;
      if (thr > 0.01) torque = full * thr;
      else torque = -eng.engineBraking * Math.min(1.3, this.rpm / eng.limiterRpm);
      load = this.shifting > 0 || cut ? 0 : thr > 0.01 ? thr * (full / curve(eng.torqueCurve, this.rpm) > 0 ? 1 : 1) : 0;

      // vehicle
      let fDrive = this.shifting > 0 ? 0 : (torque * this.ratio(this.gear) * drv.efficiency) / rw;
      const fTraction = mass * 9.81 * 1.25 + (car.physics.aero.liftAreaFront + car.physics.aero.liftAreaRear) * 0.5 * 1.2 * this.v * this.v;
      if (fDrive > fTraction) fDrive = fTraction;
      const fDrag = 0.5 * 1.2 * car.physics.aero.dragArea * this.v * this.v + mass * 9.81 * 0.012 * (this.v > 0.1 ? 1 : 0);
      const fBrake = brake * 1.6 * mass * 9.81 * (this.v > 0.1 ? 1 : 0);
      this.v = Math.max(0, this.v + ((fDrive - fDrag - fBrake) / mass) * h);
    }
    // overrun backfires
    if (throttle < 0.05 && this.rpm > 4200 && this.shifting <= 0) this.tSinceLift += dt;
    else this.tSinceLift = throttle > 0.05 ? 0 : this.tSinceLift;
    if (this.tSinceLift > 0.03 && this.tSinceLift < 1.6 && this.rpm > 4200) {
      if (this.rnd() < car.sound.crackle * dt * 5) this.st.backfireCount++;
    }
    this.lastLoad = load;
    const accel = ((torque * this.ratio(this.gear)) / rw / mass) * 0.9;
    this.sync(dt, throttle, brake, accel);
    void car;
  }

  private sync(dt: number, throttle: number, brake: number, accel: number): void {
    const st = this.st;
    const e = this.car.physics.engine;
    st.throttle = this.shifting > 0 ? 0 : throttle;
    st.brake = brake;
    st.rpm = this.rpm;
    st.gear = this.shifting > 0 ? 0 : this.gear;
    st.clutch = this.shifting > 0 ? 1 : 0;
    st.engineLoad = this.lastLoad;
    st.boost = this.boost;
    st.revLimiter = this.limCut > 0;
    st.speed = this.v;
    st.forwardSpeed = this.v;
    this.z += this.v * dt;
    st.position.set(0, 0.5, this.z);
    st.velocity.set(0, 0, this.v);
    st.localAccel.set(0, 0, accel);
    for (const w of st.wheels) {
      w.omega = this.v / w.radius;
      w.spin += w.omega * dt;
    }
    void e;
  }

  setSurface(s: SurfaceType): void {
    for (const w of this.st.wheels) w.surface = s;
  }
}
