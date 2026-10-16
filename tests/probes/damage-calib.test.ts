/**
 * Calibration of the mechanical damage (Damage: Full): what a given state of the car does to how it drives, on a flat test track and
 * on the circuits. On demand only:
 *
 *   DMGCAL=pull npx vitest run tests/probes/damage-calib.test.ts       how far a damaged car wanders with the wheel centred, and the
 *                                                                      steering it takes to go straight (wheel angle, stick)
 *   DMGCAL=grip ...                                                    skidpad, top speed and 0-100 of the damaged car
 *   DMGCAL=lap  [DMGTRACK=aurelia] [DMGCARS=vanta-gt,lmp-x] ...        AI laps of a damaged car, lap time against the sound car
 *
 * Output goes to .cache/damage-calib-<what>.txt.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { describe, it } from 'vitest';
import { getCar } from '../../src/cars';
import type { CarDefinition } from '../../src/core/contracts';
import { MECH_TUNING, MechState, mechanicalEffects, type MechEffects } from '../../src/core/mechanical';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { PhysicsWorld, createFlatTrack, type Vehicle } from '../../src/physics';
import { damagedLaps, fmtLap } from './damage-lap';

const DEG = Math.PI / 180;
const G = 9.81;
const what = process.env.DMGCAL ?? '';

/** A damage state made the way a crash makes it: energy straight into the parts (wear 0..1 each, 1 = as bad as it gets). */
export function state(parts: { front?: number; rear?: number; wheels?: [number, number, number, number] }): MechEffects {
  const m = new MechState();
  const e = (w: number): number => -Math.log(1 - Math.min(w, 0.999999));
  m.front = e(parts.front ?? 0);
  m.rear = e(parts.rear ?? 0);
  const w = parts.wheels ?? [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) m.wheel[i] = e(w[i]);
  return mechanicalEffects(m);
}

/** The state a real crash left (the hit energies of the record, see .cache/dmg/mech/table-*.json from the live crash table). */
function crash(front: number, rear: number, wheel: [number, number, number, number]): MechEffects {
  const m = new MechState();
  m.front = front;
  m.rear = rear;
  for (let i = 0; i < 4; i++) m.wheel[i] = wheel[i];
  return mechanicalEffects(m);
}

const SCENARIOS: [string, MechEffects][] = [
  ['sound', state({})],
  // what real crashes of the Vanta GT into Aurelia's left barrier left in the record (closing speeds in m/s)
  ['crash 25deg 60 km/h (5.8)', crash(0.036, 0.002, [0.036, 0, 0.002, 0])],
  ['crash 25deg 100 km/h (11+13)', crash(0.253, 0.344, [0.253, 0, 0.344, 0])],
  ['crash 25deg 150 km/h (17)', crash(0.747, 0, [0.747, 0, 0, 0])],
  ['crash 25deg 200 km/h (23+28)', crash(3.699, 0, [3.699, 0, 0, 0])],
  ['crash head-on 60 km/h (14)', crash(0.419, 0, [0.419, 0, 0, 0])],
  ['crash head-on 100 km/h (26)', crash(1.919, 0, [1.919, 0, 0, 0])],
  ['FL wheel 0.3', state({ wheels: [0.3, 0, 0, 0] })],
  ['FL wheel 0.6', state({ wheels: [0.6, 0, 0, 0] })],
  ['FL wheel 1.0', state({ wheels: [1, 0, 0, 0] })],
  ['left flank 0.6 (FL+RL)', state({ wheels: [0.6, 0, 0.6, 0] })],
  ['RL wheel 1.0', state({ wheels: [0, 0, 1, 0] })],
  ['nose 0.6', state({ front: 0.6 })],
  ['nose 1.0', state({ front: 1 })],
  ['tail 1.0', state({ rear: 1 })],
  ['everything 1.0', state({ front: 1, rear: 1, wheels: [1, 1, 1, 1] })],
  ['FL corner crash', state({ front: 0.6, wheels: [0.6, 0, 0, 0] })],
];

function carAt(def: CarDefinition, kmh: number, fx: MechEffects | null) {
  const world = new PhysicsWorld(createFlatTrack());
  const car = world.addVehicle(def);
  car.assists = { ...DEFAULT_SETTINGS.assists };
  car.placeOnGround(new Vector3(), new Quaternion(), kmh / 3.6);
  car.setTemperatures(1);
  if (fx) car.setDamage(fx);
  world.simulate(0.4);
  return { world, car };
}

/** Lateral position (m) of the car after `secs` at a held steering fraction and throttle that keeps the speed. */
function wander(def: CarDefinition, kmh: number, fx: MechEffects | null, steer: number, secs = 4): { lat: number; yawDeg: number; kmh: number } {
  const { world, car } = carAt(def, kmh, fx);
  const x0 = car.p.x;
  const hold = (kmh / 3.6) * 0.9;
  for (let i = 0; i < secs * 60; i++) {
    car.controls.steer = steer;
    car.controls.throttle = Math.min(1, Math.max(0, 0.25 + (hold - car.state.forwardSpeed) * 0.3));
    car.controls.brake = 0;
    world.step(1 / 60);
  }
  const f = new Vector3(0, 0, 1).applyQuaternion(car.state.quaternion);
  return { lat: car.p.x - x0, yawDeg: Math.atan2(f.x, f.z) / DEG, kmh: car.state.speed * 3.6 };
}

/** The steering fraction that keeps the car going straight (bisection on the heading after a few seconds). */
function trimSteer(def: CarDefinition, kmh: number, fx: MechEffects | null): number {
  let lo = -0.12;
  let hi = 0.12;
  for (let k = 0; k < 11; k++) {
    const mid = (lo + hi) / 2;
    const r = wander(def, kmh, fx, mid, 3);
    // steer > 0 turns the car to the right (-x), so a car drifting left (x > 0) needs a positive trim
    if (r.yawDeg > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The raw stick deflection (0..1) that the game turns into a steering fraction f at this speed: the dead zone and the response
 * curve of the input (src/input/processing.ts), then the SteeringFilter's speed scaling.
 */
function stickFor(def: CarDefinition, kmh: number, f: number): number {
  const ch = def.physics.chassis;
  const tf = def.physics.tireFront;
  const c = DEFAULT_SETTINGS.controls;
  const v = kmh / 3.6;
  const gripAngle = (ch.wheelbase * tf.mu * G) / Math.max(v * v, 1) + tf.peakSlipAngle * 1.35;
  const limit = Math.min(1, gripAngle / ch.maxSteer);
  const scale = 1 + (limit - 1) * c.speedSensitivity;
  const processed = Math.min(1, Math.abs(f) / scale);
  const curved = Math.pow(processed, 1 / c.steerLinearity);
  return Math.abs(f) < 1e-4 ? 0 : c.steerDeadzone + (1 - c.steerDeadzone) * curved;
}

/** Holds the car on the line x = 0 heading +Z like a driver would (a pull is corrected, not ignored). */
function holdLine(car: Vehicle): number {
  const s = car.state;
  const f = new Vector3(0, 0, 1).applyQuaternion(s.quaternion);
  const heading = Math.atan2(f.x, f.z);
  return Math.max(-0.5, Math.min(0.5, 0.012 * s.position.x + 1.2 * heading + 0.25 * s.angularVelocity.y));
}

describe('damage calibration', () => {
  it.skipIf(what !== 'pull')('the pull of a damaged car and the steering that holds it straight', () => {
    const out: string[] = ['MECH_TUNING ' + JSON.stringify(MECH_TUNING), ''];
    for (const id of ['vanta-gt', 'kestrel-r', 'lmp-x']) {
      const def = getCar(id);
      out.push(`== ${id}`);
      for (const kmh of [100, 200]) {
        out.push(`  at ${kmh} km/h: scenario | drift in 4 s with the wheel centred (m, heading deg) | steering to hold straight: road wheel deg, stick %`);
        for (const [name, fx] of SCENARIOS) {
          const free = wander(def, kmh, fx, 0);
          const trim = trimSteer(def, kmh, fx);
          const wheelDeg = trim * def.physics.chassis.maxSteer / DEG;
          out.push(`    ${name.padEnd(26)} drift ${free.lat.toFixed(2).padStart(6)} m  heading ${free.yawDeg.toFixed(2).padStart(6)}°  | trim ${wheelDeg.toFixed(2).padStart(6)}° wheel  stick ${(100 * stickFor(def, kmh, trim)).toFixed(0).padStart(3)} %  (speed kept ${free.kmh.toFixed(0)})`);
        }
      }
    }
    mkdirSync('.cache', { recursive: true });
    writeFileSync('.cache/damage-calib-pull.txt', out.join('\n') + '\n');
    console.log(out.join('\n'));
  }, 600000);

  it.skipIf(what !== 'lap')('lap times of a damaged AI car, with and without the driver knowing', () => {
    const tracks = (process.env.DMGTRACK ?? 'aurelia').split(',');
    const cars = (process.env.DMGCARS ?? 'vanta-gt,lmp-x').split(',');
    const laps = +(process.env.DMGLAPS ?? 3);
    const out: string[] = [];
    for (const trackId of tracks) {
      for (const carId of cars) {
        const sound = damagedLaps(trackId, carId, null, { laps });
        const ref = sound.lapTimes.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, sound.lapTimes.length - 1);
        out.push(`== ${trackId} ${carId}: sound laps ${sound.lapTimes.map(fmtLap).join(' ')}  (reference ${fmtLap(ref)})  walls ${sound.walls} off ${sound.off.toFixed(1)}s resets ${sound.resets}`);
        for (const [name, fx] of SCENARIOS.slice(1)) {
          if (process.env.DMGONLY && !process.env.DMGONLY.split(',').some((p) => name.startsWith(p))) continue;
          const row = [`  ${name.padEnd(26)}`];
          for (const adapt of [false, true]) {
            const r = damagedLaps(trackId, carId, fx, { laps, adapt });
            const mean = r.lapTimes.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, r.lapTimes.length - 1);
            row.push(`${adapt ? 'driver knows' : 'driver blind'}: ${fmtLap(mean)} (${mean - ref >= 0 ? '+' : ''}${(mean - ref).toFixed(2)} s, ${(((mean - ref) / ref) * 100).toFixed(1)} %) walls ${r.walls} off ${r.off.toFixed(1)}s resets ${r.resets} laps ${r.lapTimes.length}`);
          }
          out.push(row.join(' | '));
        }
      }
    }
    mkdirSync('.cache', { recursive: true });
    writeFileSync('.cache/damage-calib-lap.txt', out.join('\n') + '\n');
    console.log(out.join('\n'));
  }, 3600000);

  it.skipIf(what !== 'grip')('grip, top speed and acceleration of a damaged car', () => {
    const out: string[] = [];
    for (const id of ['vanta-gt', 'kestrel-r', 'ronin-86', 'lmp-x']) {
      const def = getCar(id);
      out.push(`== ${id}`);
      for (const [name, fx] of SCENARIOS) {
        const t = topSpeed(def, fx);
        const acc = zeroTo(def, fx, 100);
        const pad = skidpad(def, fx, 60);
        out.push(`  ${name.padEnd(26)} 0-100 ${acc.toFixed(2)} s  top ${t.toFixed(0)} km/h  skidpad R60 ${pad.g.toFixed(2)} g @ ${pad.kmh.toFixed(0)} km/h`);
      }
    }
    mkdirSync('.cache', { recursive: true });
    writeFileSync('.cache/damage-calib-grip.txt', out.join('\n') + '\n');
    console.log(out.join('\n'));
  }, 900000);
});

function topSpeed(def: CarDefinition, fx: MechEffects | null): number {
  const world = new PhysicsWorld(createFlatTrack());
  const car = world.addVehicle(def);
  car.assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
  car.placeOnGround(new Vector3(), new Quaternion(), 0);
  car.setTemperatures(1);
  if (fx) car.setDamage(fx);
  car.controls.throttle = 1;
  let vmax = 0;
  for (let i = 0; i < 60 * 70; i++) {
    car.controls.steer = holdLine(car);
    world.step(1 / 60);
    vmax = Math.max(vmax, car.state.forwardSpeed * 3.6);
  }
  return vmax;
}

function zeroTo(def: CarDefinition, fx: MechEffects | null, kmh: number): number {
  const world = new PhysicsWorld(createFlatTrack());
  const car = world.addVehicle(def);
  car.assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
  car.placeOnGround(new Vector3(), new Quaternion(), 0);
  car.setTemperatures(1);
  if (fx) car.setDamage(fx);
  world.simulate(1);
  car.controls.throttle = 1;
  const t0 = world.time;
  for (let i = 0; i < 60 * 30; i++) {
    car.controls.steer = holdLine(car);
    world.step(1 / 60);
    if (car.state.forwardSpeed * 3.6 >= kmh) return world.time - t0;
  }
  return NaN;
}

/** Highest sustained lateral acceleration on a circle of radius R (the skidpad of tests/physics.test.ts, with the damage on). */
function skidpad(def: CarDefinition, fx: MechEffects | null, R: number): { g: number; kmh: number } {
  const world = new PhysicsWorld(createFlatTrack());
  const car = world.addVehicle(def);
  car.assists = { abs: true, tcs: 'high', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
  car.placeOnGround(new Vector3(), new Quaternion(), 0);
  car.setTemperatures(1);
  if (fx) car.setDamage(fx);
  const center = new Vector3(R, 0, 0);
  let vTarget = 8;
  let best = 0;
  let lastGood = 0;
  const fwd = new Vector3();
  const left = new Vector3();
  for (let i = 0; i < 60 * 150; i++) {
    const s = car.state;
    fwd.set(0, 0, 1).applyQuaternion(s.quaternion);
    left.set(1, 0, 0).applyQuaternion(s.quaternion);
    const rel = new Vector3().subVectors(s.position, center);
    rel.y = 0;
    const dist = rel.length();
    const ang = Math.atan2(rel.z, rel.x);
    const lookAng = ang - 9 / R;
    const target = new Vector3(center.x + Math.cos(lookAng) * R, 0, center.z + Math.sin(lookAng) * R);
    const to = target.sub(s.position);
    to.y = 0;
    const alpha = Math.atan2(to.dot(left), to.dot(fwd));
    const wb = def.physics.chassis.wheelbase;
    const delta = Math.atan((2 * wb * Math.sin(alpha)) / to.length());
    car.controls.steer = Math.max(-1, Math.min(1, -delta / def.physics.chassis.maxSteer));
    const err = vTarget - s.forwardSpeed;
    car.controls.throttle = Math.max(0, Math.min(1, err * 0.25 + 0.15));
    car.controls.brake = err < -1.5 ? 0.3 : 0;
    world.step(1 / 60);
    vTarget += 0.06 * (1 / 60) * 10;
    const lat = Math.abs(s.localAccel.x) / G;
    if (Math.abs(dist - R) < 3 && i > 120) {
      best = Math.max(best, lat);
      lastGood = s.forwardSpeed;
    }
    if (dist - R > 12) break;
  }
  return { g: best, kmh: lastGood * 3.6 };
}

export type { Vehicle };
