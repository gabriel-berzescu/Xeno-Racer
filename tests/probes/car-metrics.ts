/**
 * Measurements of one car on a flat plane, shared by the Mammoth probe and the tests that hold it to numbers: the standing start,
 * the stop from 100 km/h, the skidpad (with the body's roll and pitch), the same on any surface, and a launch on snow.
 * They are the drives of tests/physics.test.ts and tests/winter-handling.test.ts with the extra readings a heavy 4x4 needs:
 * how far the body leans over, squats under power and dives under the brakes, how fast it is still going after a spell on gravel.
 */
import { Quaternion, Vector3 } from 'three';
import type { Assists, CarDefinition, SurfaceType } from '../../src/core/contracts';
import { PhysicsWorld, SteeringFilter, createFlatTrack, type Vehicle } from '../../src/physics';
import { DEFAULT_SETTINGS } from '../../src/core/settings';

export const G = 9.81;
export const DT = 1 / 60;
const WINTER_SURFACES: SurfaceType[] = ['snow', 'ice', 'deepsnow'];
export const NO_AIDS: Assists = { abs: false, tcs: 'off', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };

export interface Ground {
  surface?: SurfaceType;
  /** Studded winter tyres and cold air; defaults to true on snow, ice and deep snow. */
  winter?: boolean;
  wetness?: number;
}

export function setup(def: CarDefinition, ground: Ground = {}, speed = 0, assists: Assists = { ...NO_AIDS }) {
  const surface = ground.surface ?? 'asphalt';
  const track = createFlatTrack({ surface, winter: ground.winter ?? WINTER_SURFACES.includes(surface) });
  const world = new PhysicsWorld(track);
  world.wetness = ground.wetness ?? 0;
  const car = world.addVehicle(def);
  car.assists = { ...assists };
  car.placeOnGround(new Vector3(0, 0, 0), new Quaternion(), speed);
  car.setTemperatures(1);
  return { world, car };
}

export function finite(car: Vehicle): boolean {
  const s = car.state;
  return [s.position.x, s.position.y, s.position.z, s.velocity.x, s.velocity.y, s.velocity.z, s.rpm].every(Number.isFinite);
}

const _ax = new Vector3();
const _az = new Vector3();
/** Body roll (deg, + = the left side up) and pitch (deg, + = nose up) of the car relative to a level plane. */
export function attitude(car: Vehicle): { rollDeg: number; pitchDeg: number } {
  _ax.set(1, 0, 0).applyQuaternion(car.state.quaternion);
  _az.set(0, 0, 1).applyQuaternion(car.state.quaternion);
  return { rollDeg: (Math.asin(Math.max(-1, Math.min(1, _ax.y))) * 180) / Math.PI, pitchDeg: (Math.asin(Math.max(-1, Math.min(1, _az.y))) * 180) / Math.PI };
}

export interface DragResult {
  t60: number | null;
  t100: number | null;
  t200: number | null;
  quarter: number | null;
  vmax: number;
  /** Largest nose-up pitch (deg) in the first three seconds of the start: the squat. */
  squatDeg: number;
  /** Highest slip ratio of any wheel in the first three seconds. */
  maxSlip: number;
}

/** Full-throttle standing start, as tests/physics.test.ts has it (traction control low unless told). */
export function dragRun(def: CarDefinition, seconds = 70, ground: Ground = {}, tcs: Assists['tcs'] = 'low'): DragResult {
  const { world, car } = setup(def, ground);
  car.assists.tcs = tcs;
  world.simulate(1);
  const t0 = world.time;
  const z0 = car.p.z;
  const r: DragResult = { t60: null, t100: null, t200: null, quarter: null, vmax: 0, squatDeg: 0, maxSlip: 0 };
  car.controls.throttle = 1;
  while (world.time - t0 < seconds) {
    world.step(DT);
    const kmh = car.state.forwardSpeed * 3.6;
    r.vmax = Math.max(r.vmax, kmh);
    if (r.t60 === null && kmh >= 96.56) r.t60 = world.time - t0;
    if (r.t100 === null && kmh >= 100) r.t100 = world.time - t0;
    if (r.t200 === null && kmh >= 200) r.t200 = world.time - t0;
    if (r.quarter === null && car.p.z - z0 >= 402.3) r.quarter = world.time - t0;
    if (world.time - t0 < 3) {
      r.squatDeg = Math.max(r.squatDeg, attitude(car).pitchDeg);
      for (const w of car.state.wheels) r.maxSlip = Math.max(r.maxSlip, w.slipRatio);
    }
    if (!finite(car)) throw new Error('NaN during drag run');
  }
  return r;
}

export interface BrakeResult {
  distance: number;
  time: number;
  /** Largest nose-down pitch (deg): the dive. */
  diveDeg: number;
}

/** Full pedal from `kmh` to rest. */
export function brakeRun(def: CarDefinition, abs = true, ground: Ground = {}, kmh = 100): BrakeResult {
  const v0 = kmh / 3.6;
  const { world, car } = setup(def, ground, v0);
  car.assists.abs = abs;
  world.simulate(0.3);
  car.placeOnGround(new Vector3(0, 0, car.p.z), new Quaternion(), v0);
  car.setTemperatures(1);
  const z0 = car.p.z;
  car.controls.brake = 1;
  let t = 0;
  let dive = 0;
  while (car.state.forwardSpeed > 0.3 && t < 30) {
    world.step(DT);
    t += DT;
    dive = Math.max(dive, -attitude(car).pitchDeg);
  }
  return { distance: car.p.z - z0, time: t, diveDeg: dive };
}

export interface PadResult {
  latG: number;
  speedKmh: number;
  /** Body roll (deg, absolute) at the moment of the best lateral g. */
  rollDeg: number;
  /** Largest absolute roll over the whole run. */
  maxRollDeg: number;
  /** Front minus rear mean slip angle (deg) over the last stretch before the limit: > 0 pushes (understeer), < 0 comes round. */
  balanceDeg: number;
  /** Lowest wheel load (N) over the run, as a share of its static load: 0 means a wheel left the ground. */
  minLoadShare: number;
}

/** Skidpad: a circle of radius R left with the target speed creeping up; the best sustained lateral acceleration is the grip. */
export function skidpad(def: CarDefinition, R = 60, ground: Ground = {}, tcs: Assists['tcs'] = 'high'): PadResult {
  const { world, car } = setup(def, ground);
  car.assists.tcs = tcs;
  const center = new Vector3(R, 0, 0);
  const wb = def.physics.chassis.wheelbase;
  const winter = (ground.winter ?? WINTER_SURFACES.includes(ground.surface ?? 'asphalt')) === true;
  let vTarget = winter ? 4 : 8;
  const creep = winter ? 0.04 : 0.06;
  const r: PadResult = { latG: 0, speedKmh: 0, rollDeg: 0, maxRollDeg: 0, balanceDeg: 0, minLoadShare: 1 };
  const fwd = new Vector3();
  const left = new Vector3();
  const rel = new Vector3();
  const target = new Vector3();
  const staticLoad = [0, 1, 2, 3].map((i) => car.staticLoad(i));
  let bal = 0;
  let balN = 0;
  for (let i = 0; i < 60 * (winter ? 120 : 90); i++) {
    const s = car.state;
    fwd.set(0, 0, 1).applyQuaternion(s.quaternion);
    left.set(1, 0, 0).applyQuaternion(s.quaternion);
    rel.subVectors(s.position, center);
    rel.y = 0;
    const dist = rel.length();
    const ang = Math.atan2(rel.z, rel.x);
    target.set(center.x + Math.cos(ang - 9 / R) * R, 0, center.z + Math.sin(ang - 9 / R) * R);
    const to = target.sub(s.position);
    to.y = 0;
    const alpha = Math.atan2(to.dot(left), to.dot(fwd));
    const delta = Math.atan((2 * wb * Math.sin(alpha)) / to.length());
    car.controls.steer = Math.max(-1, Math.min(1, -delta / def.physics.chassis.maxSteer));
    const err = vTarget - s.forwardSpeed;
    car.controls.throttle = Math.max(0, Math.min(1, err * 0.25 + 0.15));
    car.controls.brake = err < -1.5 ? 0.3 : 0;
    world.step(DT);
    vTarget += creep * DT * 10;
    const lat = Math.abs(s.localAccel.x) / G;
    const onLine = Math.abs(dist - R) < 3;
    const roll = Math.abs(attitude(car).rollDeg);
    if (onLine && i > 120) {
      r.maxRollDeg = Math.max(r.maxRollDeg, roll);
      for (let w = 0; w < 4; w++) r.minLoadShare = Math.min(r.minLoadShare, s.wheels[w].load / staticLoad[w]);
      if (lat > r.latG) {
        r.latG = lat;
        r.speedKmh = s.forwardSpeed * 3.6;
        r.rollDeg = roll;
      }
      const w = s.wheels;
      if (lat > 0.8 * r.latG) {
        bal += (Math.abs(w[0].slipAngle) + Math.abs(w[1].slipAngle)) / 2 - (Math.abs(w[2].slipAngle) + Math.abs(w[3].slipAngle)) / 2;
        balN++;
      }
    }
    if (dist - R > 12) break;
    if (!finite(car)) throw new Error('NaN during skidpad');
  }
  r.balanceDeg = balN > 0 ? ((bal / balN) * 180) / Math.PI : 0;
  return r;
}

/** Speed (km/h) after coasting for `seconds` from `kmh` with no pedal on `ground`: drag, rolling resistance and ploughing. */
export function coast(def: CarDefinition, ground: Ground, kmh = 100, seconds = 4): number {
  const { world, car } = setup(def, ground, kmh / 3.6, { ...DEFAULT_SETTINGS.assists });
  world.simulate(seconds);
  return car.state.forwardSpeed * 3.6;
}

/** Time (s) from a standstill to `kmh` (null: not reached in `limit` s) with the default aids' traction control, on `ground`. */
export function launch(def: CarDefinition, ground: Ground, kmh = 100, tcs: Assists['tcs'] = 'low', limit = 40): number | null {
  const { world, car } = setup(def, ground, 0, { ...DEFAULT_SETTINGS.assists, tcs });
  world.simulate(0.5);
  const t0 = world.time;
  car.controls.throttle = 1;
  while (car.state.forwardSpeed < kmh / 3.6 && world.time - t0 < limit) world.step(DT);
  return car.state.forwardSpeed >= kmh / 3.6 ? world.time - t0 : null;
}

/** A hard flick through the steering filter: the rawest thumb a pad has. Returns the largest roll (deg), the lowest wheel load share and whether it spun. */
export function flick(def: CarDefinition, kmh = 110, assists: Assists = { ...DEFAULT_SETTINGS.assists }, ground: Ground = {}) {
  const { world, car } = setup(def, ground, kmh / 3.6, assists);
  const filter = new SteeringFilter();
  const staticLoad = [0, 1, 2, 3].map((i) => car.staticLoad(i));
  let maxRoll = 0;
  let minShare = 1;
  let spun = false;
  let wheelsUp = 0;
  for (let i = 0; i < 5 * 60; i++) {
    const t = i * DT;
    const raw = t < 0.6 ? -1 : t < 1.4 ? 1 : 0;
    car.controls.steer = filter.update(raw, DT, car.state, car.def, DEFAULT_SETTINGS.controls);
    car.controls.throttle = t < 1.4 ? 0 : 1;
    world.step(DT);
    maxRoll = Math.max(maxRoll, Math.abs(attitude(car).rollDeg));
    for (let w = 0; w < 4; w++) minShare = Math.min(minShare, car.state.wheels[w].load / staticLoad[w]);
    if (car.state.wheels.some((w) => !w.contact)) wheelsUp++;
    const f = new Vector3(0, 0, 1).applyQuaternion(car.state.quaternion);
    const l = new Vector3(1, 0, 0).applyQuaternion(car.state.quaternion);
    if (car.state.speed > 5 && Math.abs(Math.atan2(car.state.velocity.dot(l), car.state.velocity.dot(f))) > 1.2) spun = true;
  }
  return { maxRollDeg: maxRoll, minLoadShare: minShare, spun, wheelsUpFrames: wheelsUp };
}
