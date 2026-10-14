/**
 * Vehicle-dynamics validation: every car must behave like its real-world counterpart class.
 * Run: npx vitest run tests/physics.test.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CARS, getCar } from '../src/cars';
import type { CarDefinition } from '../src/core/contracts';
import { PhysicsWorld, createFlatTrack, type Vehicle } from '../src/physics';

const G = 9.81;
const DT = 1 / 60;

function setup(def: CarDefinition, opts: Parameters<typeof createFlatTrack>[0] = {}, speed = 0) {
  const track = createFlatTrack(opts);
  const world = new PhysicsWorld(track);
  const car = world.addVehicle(def);
  car.assists = { abs: true, tcs: 'off', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
  car.placeOnGround(new Vector3(0, 0, 0), new Quaternion(), speed);
  car.setTemperatures(1);
  return { world, car };
}

function finite(car: Vehicle) {
  const s = car.state;
  return [s.position.x, s.position.y, s.position.z, s.velocity.x, s.velocity.y, s.velocity.z, s.rpm].every(Number.isFinite);
}

/** Full-throttle standing start. Returns 0-100 time, 0-200 time (if reached), top speed. */
function dragRun(def: CarDefinition, seconds = 70) {
  const { world, car } = setup(def);
  car.assists.tcs = 'low';
  world.simulate(1);
  let t100: number | null = null;
  let t200: number | null = null;
  let quarter: number | null = null;
  const t0 = world.time;
  let vmax = 0;
  const z0 = car.p.z;
  car.controls.throttle = 1;
  while (world.time - t0 < seconds) {
    world.step(DT);
    const kmh = car.state.forwardSpeed * 3.6;
    vmax = Math.max(vmax, kmh);
    if (t100 === null && kmh >= 100) t100 = world.time - t0;
    if (t200 === null && kmh >= 200) t200 = world.time - t0;
    if (quarter === null && car.p.z - z0 >= 402.3) quarter = world.time - t0;
    if (!finite(car)) throw new Error('NaN during drag run');
  }
  return { t100, t200, quarter, vmax };
}

/** Braking from 100 km/h to rest with full pedal. */
function brakeRun(def: CarDefinition, abs: boolean) {
  const v0 = 100 / 3.6;
  const { world, car } = setup(def, {}, v0);
  car.assists.abs = abs;
  world.simulate(0.3); // settle at speed (coasting)
  car.placeOnGround(new Vector3(0, 0, car.p.z), new Quaternion(), v0);
  car.setTemperatures(1);
  const z0 = car.p.z;
  car.controls.brake = 1;
  let t = 0;
  while (car.state.forwardSpeed > 0.3 && t < 20) {
    world.step(DT);
    t += DT;
  }
  return { distance: car.p.z - z0, time: t };
}

/**
 * Skidpad: drive a circle of radius R, slowly raising the target speed; the highest sustained
 * lateral acceleration before the car can no longer hold the line is the grip limit.
 */
function skidpad(def: CarDefinition, R = 60) {
  const { world, car } = setup(def);
  car.assists.tcs = 'high';
  // start on the circle, tangent along +Z, circle center at (+R, 0, 0) (turning left)
  const center = new Vector3(R, 0, 0);
  let vTarget = 8;
  let best = 0;
  let lastGood = 0;
  const fwd = new Vector3();
  const left = new Vector3();
  for (let i = 0; i < 60 * 90; i++) {
    const s = car.state;
    fwd.set(0, 0, 1).applyQuaternion(s.quaternion);
    left.set(1, 0, 0).applyQuaternion(s.quaternion);
    // pure pursuit on the circle
    const rel = new Vector3().subVectors(s.position, center);
    rel.y = 0;
    const dist = rel.length();
    const ang = Math.atan2(rel.z, rel.x);
    const lookAng = ang - 9 / R; // lookahead along the direction of travel (counter-clockwise from above is -angle here)
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
    world.step(DT);
    vTarget += 0.06 * DT * 10;
    const lat = Math.abs(s.localAccel.x) / G;
    const onLine = Math.abs(dist - R) < 3;
    if (onLine && i > 120) {
      best = Math.max(best, lat);
      lastGood = s.forwardSpeed;
    }
    if (dist - R > 12) break; // ran wide: limit passed
    if (!finite(car)) throw new Error('NaN during skidpad');
  }
  return { latG: best, speedKmh: lastGood * 3.6 };
}

describe('vehicle physics', () => {
  it('rests at its static ride height without creeping', () => {
    for (const def of CARS) {
      const { world, car } = setup(def);
      world.simulate(3);
      const s = car.state;
      expect(Math.abs(s.position.y - def.physics.chassis.cgHeight)).toBeLessThan(0.02);
      expect(s.speed).toBeLessThan(0.05);
      const total = s.wheels.reduce((a, w) => a + w.load, 0);
      expect(Math.abs(total - def.physics.chassis.mass * G) / (def.physics.chassis.mass * G)).toBeLessThan(0.03);
      expect(s.rpm).toBeGreaterThan(def.physics.engine.idleRpm * 0.85);
    }
  });

  it('accelerates, brakes and corners like its class', () => {
    const rows: string[] = [];
    const checks: (() => void)[] = [];
    for (const def of CARS) {
      const drag = dragRun(def);
      const brakeAbs = brakeRun(def, true);
      const brakeLock = brakeRun(def, false);
      const pad = skidpad(def);
      rows.push(
        `${def.id.padEnd(10)} 0-100 ${drag.t100?.toFixed(2)}s  0-200 ${drag.t200?.toFixed(2) ?? '—'}s  1/4mi ${drag.quarter?.toFixed(2)}s  vmax ${drag.vmax.toFixed(0)} km/h | ` +
          `100-0 ABS ${brakeAbs.distance.toFixed(1)} m, locked ${brakeLock.distance.toFixed(1)} m | skidpad ${pad.latG.toFixed(2)} g @ ${pad.speedKmh.toFixed(0)} km/h`,
      );
      checks.push(() => {
        expect(drag.t100).not.toBeNull();
        expect(drag.t100!).toBeLessThan(def.stats.zeroTo100 * 1.6);
        expect(drag.t100!).toBeGreaterThan(def.stats.zeroTo100 * 0.6);
        expect(drag.vmax).toBeGreaterThan(def.stats.topSpeedKmh * 0.85);
        expect(drag.vmax).toBeLessThan(def.stats.topSpeedKmh * 1.15);
        expect(brakeAbs.distance).toBeGreaterThan(def.class === 'Prototype' ? 17 : 26);
        expect(brakeAbs.distance).toBeLessThan(45);
        expect(brakeLock.distance).toBeGreaterThan(brakeAbs.distance * 0.98);
        expect(pad.latG).toBeGreaterThan(0.85);
        expect(pad.latG).toBeLessThan(def.class === 'Prototype' ? 2.4 : 1.4);
      });
    }
    mkdirSync('.cache', { recursive: true });
    writeFileSync('.cache/physics-metrics.txt', rows.join('\n') + '\n');
    for (const c of checks) c();
  }, 300000);

  it('survives a wall impact without tunnelling or NaN', () => {
    const def = getCar('vanta-gt');
    const { world, car } = setup(def, { wall: 15 });
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (35 * Math.PI) / 180); // heading toward +X (left wall)
    car.placeOnGround(new Vector3(0, 0, 0), q, 100 / 3.6);
    let impacts = 0;
    let maxX = -Infinity;
    for (let i = 0; i < 60 * 4; i++) {
      world.step(DT);
      maxX = Math.max(maxX, car.p.x);
      impacts = car.state.impactCount;
      expect(finite(car)).toBe(true);
    }
    expect(impacts).toBeGreaterThan(0);
    expect(maxX).toBeLessThan(15);
    expect(car.state.position.y).toBeLessThan(3);
  });

  it('two cars collide and separate', () => {
    const def = getCar('kestrel-r');
    const track = createFlatTrack();
    const world = new PhysicsWorld(track);
    const a = world.addVehicle(def);
    const b = world.addVehicle(def);
    a.placeOnGround(new Vector3(0, 0, 0), new Quaternion(), 25);
    b.placeOnGround(new Vector3(0.6, 0, 12), new Quaternion(), 10);
    let contacts = 0;
    for (let i = 0; i < 60 * 3; i++) {
      world.step(DT);
      contacts += world.carContacts;
      expect(finite(a) && finite(b)).toBe(true);
    }
    expect(contacts).toBeGreaterThan(0);
    const gap = a.p.distanceTo(b.p);
    expect(gap).toBeGreaterThan(2);
  });

  it('runs fast enough for 12 cars at 1000 Hz', () => {
    const track = createFlatTrack();
    const world = new PhysicsWorld(track);
    for (let i = 0; i < 12; i++) {
      const car = world.addVehicle(CARS[i % CARS.length]);
      car.placeOnGround(new Vector3((i % 4) * 8 - 12, 0, Math.floor(i / 4) * 12), new Quaternion(), 30);
      car.controls.throttle = 0.7;
      car.controls.steer = 0.1;
    }
    const t0 = performance.now();
    world.simulate(5);
    const ms = performance.now() - t0;
    const perFrame = ms / (5 * 60);
    mkdirSync('.cache', { recursive: true });
    writeFileSync('.cache/physics-perf.txt', `12 cars: ${perFrame.toFixed(2)} ms of physics per 60 Hz frame
`);
    expect(perFrame).toBeLessThan(6);
  });
});
