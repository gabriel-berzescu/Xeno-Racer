/**
 * The drives the Taccola is measured with, shared by tests/taccola.test.ts (which holds it to numbers) and tests/probes/taccola-probe.test.ts
 * (which prints the tables): a standing start to 300 km/h, the grip at a steady speed in the gear for it, a stop from speed with its peak
 * and how straight the car stays, a bend held with a player's aids, a lift in a corner, a power slide, the active wing coming up at speed,
 * and an AI lap with the tyres' temperatures. They take any car, so the Vanta GT and the LMP-X are measured the same way beside it.
 */
import { Quaternion, Vector3 } from 'three';
import { AIDriver } from '../../src/ai';
import { carAssists } from '../../src/core/aids';
import type { Assists, CarDefinition, Difficulty, TrackPoint } from '../../src/core/contracts';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { PhysicsWorld, SteeringFilter, createFlatTrack, type Vehicle } from '../../src/physics';
import { loadTrackRuntime } from '../../src/track';
import { DT, G, setup, type Ground } from './car-metrics';

/** The aids an AI driver races with (and the four-cars guard drives): ABS, the traction control low, no stability control. */
export const AI_AIDS: Assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
/** The aids a player has by default (Standard): ABS, the traction control low, the stability control, a little steering assist. */
export const STANDARD: Assists = carAssists(DEFAULT_SETTINGS.assists);
/** Nothing but the automatic gearbox and clutch. */
export const BARE: Assists = { abs: false, tcs: 'off', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };

const _f = new Vector3();
const _l = new Vector3();
/** Body slip (rad, signed: + = the velocity points to the left of the nose). */
export function bodySlip(car: Vehicle): number {
  const st = car.state;
  _f.set(0, 0, 1).applyQuaternion(st.quaternion);
  _l.set(1, 0, 0).applyQuaternion(st.quaternion);
  return Math.atan2(st.velocity.dot(_l), st.velocity.dot(_f));
}

/** The gear that has the engine under its upshift speed at `kmh`. */
export function gearFor(def: CarDefinition, kmh: number): number {
  const d = def.physics.drivetrain;
  const rpm = (g: number) => (kmh / 3.6 / def.physics.tireRear.radius) * d.gears[g - 1] * d.finalDrive * (60 / (2 * Math.PI));
  let g = 1;
  while (g < d.gears.length && rpm(g) > d.upshiftRpm * 0.97) g++;
  return g;
}

/** A car on a wide flat plane at `kmh` in the gear for it, warm, with `assists`. */
export function atSpeed(def: CarDefinition, kmh: number, assists: Assists, ground: Ground = {}, temp = 1) {
  const surface = ground.surface ?? 'asphalt';
  const world = new PhysicsWorld(createFlatTrack({ surface, winter: ground.winter ?? false, wall: 6000, halfWidth: 6000 }));
  world.wetness = ground.wetness ?? 0;
  const car = world.addVehicle(def);
  car.assists = { ...assists };
  car.gear = gearFor(def, kmh);
  car.placeOnGround(new Vector3(), new Quaternion(), kmh / 3.6);
  car.setTemperatures(temp);
  return { world, car };
}

export interface Start {
  t100: number;
  t200: number;
  t300: number;
  vmax: number;
  /** The engine speed (rpm) and the gear at the end of the run: where the top speed is reached. */
  rpm: number;
  gear: number;
  /** The seconds of the first second in which a driven wheel slipped past 0.2: bursts the traction control has to cut. */
  burst: number;
  /** The most the engine ran ahead of the driveline with the clutch fully in (a slipping clutch), as a share. */
  slip: number;
}

/** Seconds from a standstill to 100, 200 and 300 km/h flat out with the AI's aids, and the top speed; from a grid start (held 2 s against the clutch) if `grid`. */
export function standingStart(def: CarDefinition, grid = false, nitro = 0, seconds = 60, tcs: Assists['tcs'] = 'low'): Start {
  const { world, car } = setup(def, {}, 0, { ...AI_AIDS, tcs });
  world.simulate(1);
  if (grid) {
    car.holdOnGrid = true;
    car.controls.throttle = 1;
    world.simulate(2);
    car.holdOnGrid = false;
  }
  car.controls.throttle = 1;
  car.nitro = nitro;
  const t0 = world.time;
  const r: Start = { t100: 0, t200: 0, t300: 0, vmax: 0, rpm: 0, gear: 0, burst: 0, slip: 0 };
  let gear = car.state.gear;
  let shifted = 0;
  const d = def.physics.drivetrain;
  while (world.time - t0 < seconds) {
    world.step(DT);
    const st = car.state;
    const kmh = st.forwardSpeed * 3.6;
    r.vmax = Math.max(r.vmax, kmh);
    if (!r.t100 && kmh >= 100) r.t100 = world.time - t0;
    if (!r.t200 && kmh >= 200) r.t200 = world.time - t0;
    if (!r.t300 && kmh >= 300) r.t300 = world.time - t0;
    if (world.time - t0 < 1 && Math.max(st.wheels[2].slipRatio, st.wheels[3].slipRatio) > 0.2) r.burst += DT;
    if (st.gear !== gear) {
      gear = st.gear;
      shifted = world.time;
    }
    if (st.clutch < 0.01 && kmh > 60 && world.time - shifted > 0.15) {
      const wheel = (car.wheels[2].omega + car.wheels[3].omega) / 2;
      r.slip = Math.max(r.slip, st.rpm / ((wheel * d.gears[st.gear - 1] * d.finalDrive * 60) / (2 * Math.PI)) - 1);
    }
  }
  r.rpm = car.state.rpm;
  r.gear = car.state.gear;
  return r;
}

/**
 * What a car holds sideways at a steady `kmh`: no aids, the gear for the speed from the start, the pedals holding the speed while the
 * road wheels are wound on over 18 s; the best lateral acceleration (g, filtered over a third of a second) within 3 % of the speed.
 * `temp` is how warm the tyres start (1 = at their optimum, 0 = at the air's temperature).
 */
export function latAt(def: CarDefinition, kmh: number, ground: Ground = {}, temp = 1): number {
  const { world, car } = atSpeed(def, kmh, BARE, ground, temp);
  const v0 = kmh / 3.6;
  const lock = Math.min(def.physics.chassis.maxSteer, (20 * Math.PI) / 180);
  let integral = 0.5;
  let filt = 0;
  let best = 0;
  const frames = 18 * 60;
  for (let i = 0; i < frames; i++) {
    const s = car.state;
    const err = v0 - s.forwardSpeed;
    integral = Math.min(1, Math.max(0, integral + err * 0.8 * DT));
    car.controls.throttle = Math.min(1, Math.max(0, integral + 0.4 * err));
    car.controls.brake = err < -2 ? Math.min(0.5, (-err - 2) * 0.1) : 0;
    car.controls.steer = -(Math.min(1, (i / frames) * 1.15) * lock) / def.physics.chassis.maxSteer;
    world.step(DT);
    filt += (Math.abs(s.localAccel.x) / G - filt) * (1 - Math.exp(-DT / 0.3));
    if (i > 60 && filt > best && Math.abs(s.forwardSpeed - v0) < 0.03 * v0) best = filt;
  }
  return best;
}

export interface Stop {
  /** Metres from the pedal to rest. */
  distance: number;
  /** The hardest deceleration over a tenth of a second (g). */
  peakG: number;
  /** The most body slip on the way (degrees), and the most the car left its line sideways (m). */
  slipDeg: number;
  drift: number;
}

/**
 * A stop from `kmh` with `assists`: flat out for a second in the gear for the speed first if `flatOut` (the active wing then opens, and
 * the stop begins with it lying flat), then the full pedal to rest, the wheel straight.
 */
export function stopFrom(def: CarDefinition, kmh: number, assists: Assists = AI_AIDS, ground: Ground = {}, flatOut = true): Stop {
  const { world, car } = atSpeed(def, kmh, assists, ground);
  if (flatOut) {
    car.controls.throttle = 1;
    world.simulate(1);
  }
  car.controls.throttle = 0;
  car.controls.brake = 1;
  const z0 = car.p.z;
  const x0 = car.p.x;
  const v: number[] = [car.state.forwardSpeed];
  const r: Stop = { distance: 0, peakG: 0, slipDeg: 0, drift: 0 };
  while (car.state.forwardSpeed > 1 && v.length < 1500) {
    world.step(DT);
    v.push(car.state.forwardSpeed);
    if (car.state.speed > 5) r.slipDeg = Math.max(r.slipDeg, (Math.abs(bodySlip(car)) * 180) / Math.PI);
    r.drift = Math.max(r.drift, Math.abs(car.p.x - x0));
  }
  for (let i = 6; i < v.length; i++) r.peakG = Math.max(r.peakG, (v[i - 6] - v[i]) / (6 * DT) / G);
  r.distance = car.p.z - z0;
  return r;
}

export interface Slide {
  /** The most body slip (degrees), whether the car spun (past 69 degrees), and the speed at the end (km/h). */
  slipDeg: number;
  spun: boolean;
  endKmh: number;
  /** The share of the frames in which the stability control worked. */
  esc: number;
}

/**
 * A script of a raw stick and pedals against time through the SteeringFilter, as a player's thumb drives, from `kmh` in the gear for it
 * (the speed held for 1.5 s first), with `assists`.
 */
export function drive(def: CarDefinition, kmh: number, assists: Assists, script: (t: number, car: Vehicle) => { steer: number; throttle: number; brake: number }, seconds: number, ground: Ground = {}, temp = 1): Slide {
  const { world, car } = atSpeed(def, kmh, assists, ground, temp);
  for (let i = 0; i < 90; i++) {
    car.controls.throttle = car.state.forwardSpeed < kmh / 3.6 ? 1 : 0.5;
    world.step(DT);
  }
  // (the settling drive may have opened an active wing: the script starts with what the car has)
  const filter = new SteeringFilter();
  let slip = 0;
  let esc = 0;
  const frames = Math.round(seconds * 60);
  for (let i = 0; i < frames; i++) {
    const s = script(i * DT, car);
    car.controls.steer = filter.update(s.steer, DT, car.state, car.def, DEFAULT_SETTINGS.controls);
    car.controls.throttle = s.throttle;
    car.controls.brake = s.brake;
    world.step(DT);
    if (car.state.speed > 5) slip = Math.max(slip, Math.abs(bodySlip(car)));
    if (car.state.escActive) esc++;
  }
  return { slipDeg: (slip * 180) / Math.PI, spun: slip > 1.2, endKmh: car.state.forwardSpeed * 3.6, esc: esc / frames };
}

/** A steady bend as a player takes it: the stick held at `stick` for 4.5 s at `pedal`, from `kmh`. */
export function bend(def: CarDefinition, kmh: number, pedal = 1, assists: Assists = STANDARD, stick = 0.5, ground: Ground = {}): Slide {
  return drive(def, kmh, assists, (t) => ({ steer: t < 0.3 ? 0 : stick, throttle: pedal, brake: 0 }), 4.5, ground);
}

/** The pedal that holds `kmh`: a little of it in proportion to the speed missing, at most `cap` (a driver keeping a corner's speed, not accelerating out of it). */
function holdSpeed(car: Vehicle, kmh: number, cap = 0.6): number {
  return Math.min(cap, Math.max(0, 0.12 + 0.25 * (kmh / 3.6 - car.state.forwardSpeed)));
}

/** A lift in a corner: the stick at `stick` with the pedal holding the speed for 2.5 s, then the pedal let go for 2.5 s with the stick held. */
export function liftOff(def: CarDefinition, kmh: number, assists: Assists = STANDARD, stick = 0.5, ground: Ground = {}): Slide {
  return drive(def, kmh, assists, (t, car) => ({ steer: t < 0.3 ? 0 : stick, throttle: t < 2.5 ? holdSpeed(car, kmh) : 0, brake: 0 }), 5, ground);
}

export interface PowerSlide {
  /** Seconds from the floored pedal to 10 and to 30 degrees of body slip (-1: never), the most slip and whether the car spun. */
  t10: number;
  t30: number;
  slipDeg: number;
  spun: boolean;
  /**
   * Whether a driver catches it, and the most slip (degrees) on the way: the pedal eased to a sixth and the stick turned into the slide once
   * it passes 10 degrees, as far as the slide is wide, the car then back under 5 degrees without passing 50.
   */
  caught: boolean;
  caughtDeg: number;
}

/**
 * Power oversteer without the traction control: a corner at `kmh` held in `gear` with the stick at `stick` for 1.5 s, then the pedal to
 * the floor (no aids at all, the gear held). How quickly the tail comes round, and whether a driver who eases off and steers into it
 * catches it.
 */
export function powerSlide(def: CarDefinition, kmh: number, gear: number, stick = 0.5, ground: Ground = {}): PowerSlide {
  const FLOOR = 1.5;
  const run = (catchIt: boolean) => {
    const { world, car } = atSpeed(def, kmh, { ...BARE, autoShift: false }, ground);
    car.gear = gear;
    car.placeOnGround(new Vector3(), new Quaternion(), kmh / 3.6);
    car.setTemperatures(1);
    const filter = new SteeringFilter();
    let t10 = -1;
    let t30 = -1;
    let slip = 0;
    let catching = false;
    let prevBeta = 0;
    let late = 0;
    const frames = 7 * 60;
    for (let i = 0; i < frames; i++) {
      const t = i * DT;
      const beta = bodySlip(car);
      const deg = (Math.abs(beta) * 180) / Math.PI;
      if (catchIt && t > FLOOR && deg > 10) catching = true;
      let raw = t > 0.3 ? stick : 0;
      let pedal = t > FLOOR ? 1 : holdSpeed(car, kmh, 0.4);
      if (catching) {
        // (the stick towards where the car is going, as far over as the slide is wide and as it is still growing, all of it from 12 degrees,
        // and let go as the tail swings back, so that it is not thrown the other way; the pedal eased, not dropped)
        raw = Math.max(-1, Math.min(1, -(beta + 0.25 * ((beta - prevBeta) / DT)) / 0.21));
        pedal = deg > 6 ? 0.16 : 0.3;
      }
      prevBeta = beta;
      car.controls.steer = filter.update(raw, DT, car.state, car.def, DEFAULT_SETTINGS.controls);
      car.controls.throttle = pedal;
      world.step(DT);
      if (car.state.speed > 4) {
        slip = Math.max(slip, deg);
        if (i >= frames - 60) late = Math.max(late, deg);
        if (t > FLOOR && t10 < 0 && deg > 10) t10 = t - FLOOR;
        if (t > FLOOR && t30 < 0 && deg > 30) t30 = t - FLOOR;
      }
    }
    // (caught: straight again over the last second)
    return { t10, t30, slip, recovered: late < 5 };
  };
  const free = run(false);
  const held = run(true);
  return { t10: free.t10, t30: free.t30, slipDeg: free.slip, spun: free.slip > 69, caught: held.recovered && held.slip < 50, caughtDeg: held.slip };
}

export interface WingChange {
  /** Where the wing stood (0 up .. 1 flat) when the driver acted, and the seconds until it was fully up again. */
  openBefore: number;
  closeTime: number;
  /** The most body slip (degrees) and yaw rate (rad/s) in the 3 s after, and how far the car moved sideways from where it was (m). */
  slipDeg: number;
  yaw: number;
  drift: number;
}

/**
 * The wing coming up at speed: flat out at `kmh` for 1.5 s (the wing lies flat), then `act` (a lift, the brakes, a turn of the wheel)
 * for 3 s with `assists`.
 */
export function wingUp(def: CarDefinition, kmh: number, act: (car: Vehicle, t: number) => void, assists: Assists = STANDARD, ground: Ground = {}): WingChange {
  const { world, car } = atSpeed(def, kmh, assists, ground);
  car.controls.throttle = 1;
  world.simulate(1.5);
  const r: WingChange = { openBefore: car.state.aeroOpen ?? 0, closeTime: Infinity, slipDeg: 0, yaw: 0, drift: 0 };
  const t0 = world.time;
  const x0 = car.p.x;
  for (let i = 0; i < 180; i++) {
    act(car, i * DT);
    world.step(DT);
    if (r.closeTime === Infinity && (car.state.aeroOpen ?? 0) === 0) r.closeTime = world.time - t0;
    if (car.state.speed > 5) r.slipDeg = Math.max(r.slipDeg, (Math.abs(bodySlip(car)) * 180) / Math.PI);
    r.yaw = Math.max(r.yaw, Math.abs(car.state.angularVelocity.y));
    r.drift = Math.max(r.drift, Math.abs(car.p.x - x0));
  }
  return r;
}

export interface Lap {
  /** The lap from the first crossing of the line to the second (s), as car-metrics' aiLap takes it (a standing start on warm tyres), and the one after it. */
  lap: number;
  next: number;
  resets: number;
  impacts: number;
  /** Substeps in which the plank or a lip of the body touched the road. */
  floor: number;
  /** Seconds more than half a metre past the edge of the asphalt. */
  offEdge: number;
  /** The hardest the car slowed over a fifth of a second (g), and the fastest it went (km/h). */
  brakeG: number;
  vmax: number;
  /** The tread temperatures over the later lap (C): the mean, the lowest and the highest, front and rear. */
  tempFront: [number, number, number];
  tempRear: [number, number, number];
  /** The hottest brake disc over the two laps (C). */
  disc: number;
  /** Seconds of the later lap with an active wing more than half way down. */
  wingOpen: number;
}

/** Two laps of an AI driver alone on a circuit, as car-metrics' aiLap drives them, with what the tyres, the brakes and the wing did. */
export function lapOf(trackId: string, def: CarDefinition, wetness = 0, difficulty: Difficulty = 'alien', temp = 1): Lap {
  const track = loadTrackRuntime(trackId);
  const world = new PhysicsWorld(track);
  world.wetness = wetness;
  const car = world.addVehicle(def);
  car.assists = { ...AI_AIDS };
  const slot = track.grid[0];
  car.placeOnGround(slot.position, slot.quaternion, 0);
  car.setTemperatures(temp);
  const ai = new AIDriver(track, def, { difficulty, seed: 1, wetness });
  const tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
  let hint = track.project(car.p.x, car.p.z, tp, -1);
  let prev = tp.s;
  let crossings = 0;
  let lapStart = 0;
  const r: Lap = { lap: Number.NaN, next: Number.NaN, resets: 0, impacts: 0, floor: 0, offEdge: 0, brakeG: 0, vmax: 0, tempFront: [0, 999, 0], tempRear: [0, 999, 0], disc: 0, wingOpen: 0 };
  const speeds: number[] = [];
  let n = 0;
  while (world.time < 900 && crossings < 3) {
    ai.update(DT, car.state, world.states, car.controls, true);
    if (ai.needsReset) {
      r.resets++;
      ai.onReset();
    }
    world.step(DT);
    const st = car.state;
    speeds.push(st.forwardSpeed);
    if (speeds.length > 12) r.brakeG = Math.max(r.brakeG, (speeds[speeds.length - 13] - st.forwardSpeed) / (12 * DT) / G);
    r.vmax = Math.max(r.vmax, st.speed * 3.6);
    for (const w of st.wheels) r.disc = Math.max(r.disc, w.brakeTempC);
    hint = track.project(car.p.x, car.p.z, tp, hint);
    if (tp.d > tp.widthLeft + 0.5 || tp.d < -tp.widthRight - 0.5) r.offEdge += DT;
    if (crossings === 2) {
      const f = (st.wheels[0].tempC + st.wheels[1].tempC) / 2;
      const b = (st.wheels[2].tempC + st.wheels[3].tempC) / 2;
      r.tempFront[0] += f;
      r.tempRear[0] += b;
      r.tempFront[1] = Math.min(r.tempFront[1], st.wheels[0].tempC, st.wheels[1].tempC);
      r.tempFront[2] = Math.max(r.tempFront[2], st.wheels[0].tempC, st.wheels[1].tempC);
      r.tempRear[1] = Math.min(r.tempRear[1], st.wheels[2].tempC, st.wheels[3].tempC);
      r.tempRear[2] = Math.max(r.tempRear[2], st.wheels[2].tempC, st.wheels[3].tempC);
      n++;
      if ((st.aeroOpen ?? 0) > 0.5) r.wingOpen += DT;
    }
    if (tp.s - prev < -track.length / 2) {
      crossings++;
      if (crossings === 2) r.lap = world.time - lapStart;
      if (crossings === 3) r.next = world.time - lapStart;
      lapStart = world.time;
    }
    prev = tp.s;
  }
  if (n > 0) {
    r.tempFront[0] /= n;
    r.tempRear[0] /= n;
  }
  r.impacts = car.state.impactCount;
  r.floor = car.debugGroundHits;
  return r;
}
