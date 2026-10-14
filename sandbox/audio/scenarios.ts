/**
 * Scenario builders for the offline harness and the interactive bench: each returns a SceneCar
 * (profile + mutable VehicleState + a per-frame step function).
 */
import { Quaternion } from 'three';
import type { CarDefinition, ImpactKind, SurfaceType, VehicleState } from '../../src/core/contracts';
import { DriveSim, makeVehicleState } from './drive-sim';
import type { SceneCar } from './harness';

export interface Segment {
  /** Segment start (s). */
  t: number;
  rpm: number;
  throttle: number;
  /** Physics-style engineLoad (fraction of peak torque). Defaults to throttle. */
  load?: number;
  boost?: number;
  limiter?: boolean;
  shiftTick?: boolean;
  backfireTick?: boolean;
  /** Speed (m/s) used for wheel omega (gear whine) — defaults to rpm-derived. */
  speed?: number;
  gear?: number;
}

function setEngine(st: VehicleState, car: CarDefinition, s: Segment): void {
  const e = car.physics.engine;
  st.rpm = s.rpm;
  st.idleRpm = e.idleRpm;
  st.redlineRpm = e.redlineRpm;
  st.limiterRpm = e.limiterRpm;
  st.throttle = s.throttle;
  st.engineLoad = s.load ?? s.throttle;
  st.boost = s.boost ?? (car.sound.turbo ? Math.min(1, s.throttle * 0.95) : 0);
  st.revLimiter = !!s.limiter;
  st.gear = s.gear ?? 3;
  const speed = s.speed ?? 0;
  st.speed = speed;
  st.forwardSpeed = speed;
  st.velocity.set(0, 0, speed);
  for (const w of st.wheels) w.omega = speed / w.radius;
}

/** Piecewise-constant engine states (the voice does its own smoothing). */
export function steppedCar(car: CarDefinition, segments: Segment[], isPlayer = true): SceneCar {
  const st = makeVehicleState();
  st.gearCount = car.physics.drivetrain.gears.length;
  for (const w of st.wheels) w.radius = car.physics.tireRear.radius;
  setEngine(st, car, segments[0]);
  let idx = -1;
  return {
    profile: car.sound,
    isPlayer,
    state: st,
    step: (t, _dt, s) => {
      let k = idx;
      while (k + 1 < segments.length && segments[k + 1].t <= t + 1e-9) k++;
      if (k !== idx) {
        idx = k;
        const seg = segments[k];
        setEngine(s, car, seg);
        if (seg.shiftTick) s.shiftCount++;
        if (seg.backfireTick) s.backfireCount++;
      }
    },
  };
}

/** A smooth rpm ramp at fixed throttle (for pitch-tracking / smoothness checks). */
export function rampCar(car: CarDefinition, rpm0: number, rpm1: number, seconds: number, throttle = 1, withTurbo = true): SceneCar {
  const st = makeVehicleState();
  for (const w of st.wheels) w.radius = car.physics.tireRear.radius;
  setEngine(st, car, { t: 0, rpm: rpm0, throttle });
  return {
    profile: car.sound,
    isPlayer: true,
    state: st,
    step: (t, _dt, s) => {
      const k = Math.min(1, t / seconds);
      setEngine(s, car, { t, rpm: rpm0 + (rpm1 - rpm0) * k, throttle, boost: withTurbo && car.sound.turbo ? 0.9 * throttle : 0 });
    },
  };
}

/** Full-throttle run through the gears, lift and coast (uses the car's real spec through DriveSim). */
export function run3Car(car: CarDefinition, opts: { startRpmFraction?: number; seed?: number; isPlayer?: boolean } = {}): SceneCar & { sim: DriveSim; liftTime: () => number } {
  const e = car.physics.engine;
  const startRpm = e.idleRpm + (opts.startRpmFraction ?? 0.38) * (e.redlineRpm - e.idleRpm);
  const sim = new DriveSim(car, { gear: 1, rpm: startRpm, seed: opts.seed });
  let lifted = -1;
  return {
    profile: car.sound,
    isPlayer: opts.isPlayer ?? true,
    state: sim.st,
    sim,
    liftTime: () => lifted,
    step: (t, dt) => {
      if (lifted < 0 && sim.st.gear === 3 && sim.st.rpm > 0.9 * e.limiterRpm) lifted = t;
      sim.step(dt, lifted < 0 ? 1 : 0, 0);
    },
  };
}

export interface WheelScript {
  skid: number;
  slipAngle: number;
  slipRatio?: number;
  load?: number;
}

/** A coasting car whose wheels' slip / skid / surface follow a script (tire + road noise tests). */
export function tireCar(
  car: CarDefinition,
  speedAt: (t: number) => number,
  wheelsAt: (t: number, wheel: number) => WheelScript,
  surfaceAt: (t: number) => SurfaceType = () => 'asphalt',
  isPlayer = true,
): SceneCar {
  const st = makeVehicleState();
  for (const w of st.wheels) w.radius = 0.34;
  setEngine(st, car, { t: 0, rpm: 3000, throttle: 0.15, speed: speedAt(0) });
  return {
    profile: car.sound,
    isPlayer,
    state: st,
    step: (t, dt, s) => {
      const v = speedAt(t);
      setEngine(s, car, { t, rpm: 3000, throttle: 0.15, speed: v });
      void dt; // the car stays put: the listener is attached to it, like a chase / cockpit camera
      const surf = surfaceAt(t);
      for (let i = 0; i < 4; i++) {
        const w = s.wheels[i];
        const sc = wheelsAt(t, i);
        w.skid = sc.skid;
        w.slipAngle = sc.slipAngle;
        w.slipRatio = sc.slipRatio ?? 0;
        w.load = sc.load ?? 4500;
        w.surface = surf;
        w.contact = true;
      }
    },
  };
}

export interface ImpactEvent {
  t: number;
  kind: ImpactKind;
  strength: number;
  /** Impact point relative to the car (car-local, +X left). */
  localX?: number;
}

/** A parked car that receives scripted impacts / thumps / scrape. */
export function impactCar(car: CarDefinition, events: ImpactEvent[], scrapeAt: (t: number) => number = () => 0, speed = 0, isPlayer = true): SceneCar {
  const st = makeVehicleState();
  setEngine(st, car, { t: 0, rpm: car.physics.engine.idleRpm, throttle: 0, speed });
  st.quaternion.copy(new Quaternion());
  let next = 0;
  return {
    profile: car.sound,
    isPlayer,
    state: st,
    step: (t, _dt, s) => {
      s.scrape = scrapeAt(t);
      while (next < events.length && events[next].t <= t) {
        const ev = events[next++];
        s.impactCount++;
        s.lastImpact.strength = ev.strength;
        s.lastImpact.kind = ev.kind;
        s.lastImpact.point.set(ev.localX ?? 0, 0.5, 0).add(s.position);
      }
    },
  };
}

/** An opponent driving along +Z at constant speed (pass-by / Doppler / distance tests). */
export function passByCar(car: CarDefinition, startX: number, startZ: number, vx: number, vz: number, rpm: number, throttle = 1): SceneCar {
  const st = makeVehicleState();
  st.position.set(startX, 0.5, startZ);
  setEngine(st, car, { t: 0, rpm, throttle, speed: Math.hypot(vx, vz) });
  return {
    profile: car.sound,
    isPlayer: false,
    state: st,
    step: (_t, dt, s) => {
      setEngine(s, car, { t: 0, rpm, throttle, speed: Math.hypot(vx, vz) });
      s.position.x += vx * dt;
      s.position.z += vz * dt;
      s.velocity.set(vx, 0, vz);
    },
  };
}

/** A chase / cockpit listener that follows a moving car (position + velocity), looking along +Z. */
export function followListener(car: { state: VehicleState }, back = 5, height = 1.6): (t: number, L: import('../../src/audio/spatial').ListenerState) => void {
  return (_t, L) => {
    const p = car.state.position;
    L.px = p.x;
    L.py = p.y + height;
    L.pz = p.z - back;
    L.fx = 0;
    L.fy = 0;
    L.fz = 1;
    L.ux = 0;
    L.uy = 1;
    L.uz = 0;
    L.vx = car.state.velocity.x;
    L.vy = car.state.velocity.y;
    L.vz = car.state.velocity.z;
  };
}
