/**
 * Calibration of the winter surfaces and the studded tyres on a flat pad: what each car does on packed snow and on ice.
 *   WINTERCAL=skid|brake|accel|slide|bank|all npx vitest run tests/probes/winter-calib.test.ts
 * (writes .cache/winter-calib.txt)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { describe, it } from 'vitest';
import { CARS } from '../../src/cars';
import type { Assists, CarDefinition, SurfaceType } from '../../src/core/contracts';
import { PhysicsWorld, createFlatTrack, type Vehicle } from '../../src/physics';

const G = 9.81;
const DT = 1 / 60;
const which = process.env.WINTERCAL ?? '';
const on = (k: string) => which === 'all' || which.split(',').includes(k);

const ASSISTS: Assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };

function setup(def: CarDefinition, surface: SurfaceType, opts: { speed?: number; wetness?: number; winter?: boolean; flat?: Parameters<typeof createFlatTrack>[0] } = {}) {
  const track = createFlatTrack({ surface, winter: opts.winter ?? true, ...opts.flat });
  const world = new PhysicsWorld(track);
  world.wetness = opts.wetness ?? 0;
  const car = world.addVehicle(def);
  car.assists = { ...ASSISTS };
  car.placeOnGround(new Vector3(0, 0, 0), new Quaternion(), opts.speed ?? 0);
  car.setTemperatures(1);
  return { world, car };
}

/** Highest sustained lateral acceleration on a circle of radius R (tests/physics.test.ts skidpad, on a surface). */
function skidpad(def: CarDefinition, surface: SurfaceType, R: number, wetness = 0) {
  const { world, car } = setup(def, surface, { wetness });
  car.assists.tcs = 'high';
  const center = new Vector3(R, 0, 0);
  let vTarget = 4;
  let best = 0;
  let lastGood = 0;
  let slipF = 0;
  let slipR = 0;
  const fwd = new Vector3();
  const left = new Vector3();
  for (let i = 0; i < 60 * 120; i++) {
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
    world.step(DT);
    vTarget += 0.04 * DT * 10;
    const lat = Math.abs(s.localAccel.x) / G;
    const onLine = Math.abs(dist - R) < 3;
    if (onLine && i > 120 && lat > best) {
      best = lat;
      lastGood = s.forwardSpeed;
      slipF = (Math.abs(s.wheels[0].slipAngle) + Math.abs(s.wheels[1].slipAngle)) / 2;
      slipR = (Math.abs(s.wheels[2].slipAngle) + Math.abs(s.wheels[3].slipAngle)) / 2;
    }
    if (dist - R > 12) break;
  }
  return { latG: best, kmh: lastGood * 3.6, slipFdeg: (slipF * 180) / Math.PI, slipRdeg: (slipR * 180) / Math.PI };
}

function brakeRun(def: CarDefinition, surface: SurfaceType, abs: boolean, v0kmh = 100, wetness = 0) {
  const v0 = v0kmh / 3.6;
  const { world, car } = setup(def, surface, { speed: v0, wetness });
  car.assists.abs = abs;
  world.simulate(0.3);
  car.placeOnGround(new Vector3(0, 0, car.p.z), new Quaternion(), v0);
  car.setTemperatures(1);
  const z0 = car.p.z;
  car.controls.brake = 1;
  let t = 0;
  let absOn = 0;
  let steps = 0;
  let lockedSteps = 0;
  while (car.state.forwardSpeed > 0.3 && t < 30) {
    world.step(DT);
    t += DT;
    steps++;
    if (car.state.absActive) absOn++;
    const w = car.state.wheels;
    if (car.state.forwardSpeed > 5 && Math.abs(w[0].omega * w[0].radius) < 0.2 * car.state.forwardSpeed) lockedSteps++;
  }
  const d = car.p.z - z0;
  return { distance: d, time: t, decel: (v0 * v0) / (2 * d) / G, absShare: absOn / Math.max(1, steps), lockShare: lockedSteps / Math.max(1, steps) };
}

function accelRun(def: CarDefinition, surface: SurfaceType, tcs: Assists['tcs'], wetness = 0) {
  const { world, car } = setup(def, surface, { wetness });
  car.assists.tcs = tcs;
  world.simulate(0.5);
  const t0 = world.time;
  car.controls.throttle = 1;
  let t100: number | null = null;
  let t60: number | null = null;
  let maxSlip = 0;
  let spinShare = 0;
  let n = 0;
  while (world.time - t0 < 25) {
    world.step(DT);
    const kmh = car.state.forwardSpeed * 3.6;
    if (t60 === null && kmh >= 60) t60 = world.time - t0;
    if (t100 === null && kmh >= 100) {
      t100 = world.time - t0;
      break;
    }
    const w = car.state.wheels;
    const drv = def.drivetrain === 'FWD' ? [w[0], w[1]] : [w[2], w[3]];
    for (const x of drv) maxSlip = Math.max(maxSlip, x.slipRatio);
    if (kmh > 5) {
      n++;
      if (drv[0].slipRatio > 0.3 || drv[1].slipRatio > 0.3) spinShare++;
    }
  }
  return { t60, t100, maxSlip, spin: n ? spinShare / n : 0, tcsOn: car.state.tcsActive };
}

/** A steady circle at `frac` of the limit, then the throttle goes to the floor (RWD slides, FWD pushes): peak body slip and the stick it takes. */
function throttleSlide(def: CarDefinition, surface: SurfaceType, R: number, vKmh: number, steering: number) {
  const { world, car } = setup(def, surface);
  car.assists.tcs = 'off';
  car.assists.steeringAssist = steering;
  const center = new Vector3(R, 0, 0);
  const fwd = new Vector3();
  const left = new Vector3();
  let maxBeta = 0;
  let maxYaw = 0;
  let spun = false;
  let wide = 0;
  let t = 0;
  car.placeOnGround(new Vector3(0, 0, 0), new Quaternion(), vKmh / 3.6);
  car.setTemperatures(1);
  for (let i = 0; i < 60 * 8; i++, t += DT) {
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
    const err = vKmh / 3.6 - s.forwardSpeed;
    car.controls.throttle = t < 2 ? Math.max(0, Math.min(1, err * 0.25 + 0.15)) : 1;
    car.controls.brake = 0;
    world.step(DT);
    if (t > 2.2) {
      const beta = Math.abs(Math.atan2(s.velocity.dot(left), s.velocity.dot(fwd)));
      maxBeta = Math.max(maxBeta, beta);
      maxYaw = Math.max(maxYaw, Math.abs(s.angularVelocity.y));
      if (beta > 1.2) spun = true;
      wide = Math.max(wide, dist - R);
    }
  }
  return { betaDeg: (maxBeta * 180) / Math.PI, yaw: maxYaw, spun, wide, endKmh: car.state.speed * 3.6 };
}

/** Hit a snowbank: speed (km/h) and angle (deg) to the bank; what is left of the car's speed, how deep it got, the peak g and what the damage system would see. */
function bankHit(def: CarDefinition, kmh: number, angDeg: number, soft: boolean) {
  const { world, car } = setup(def, 'snow', { flat: { wall: 6, softWalls: soft, halfWidth: 5 } });
  car.assists = { ...ASSISTS, abs: false, tcs: 'off' };
  const a = (angDeg * Math.PI) / 180;
  // heading toward +x (left wall at x = +6 for a car pointing at an angle to +z)
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), a);
  car.placeOnGround(new Vector3(0, 0, 0), q, kmh / 3.6);
  car.setTemperatures(1);
  car.controls.throttle = 0;
  let peakG = 0;
  let maxPen = 0;
  let impacts = 0;
  let strength = 0;
  let kind = '';
  let t = 0;
  const seen = car.state.impactCount;
  let vAfter = 0;
  let outBounce = 0;
  for (let i = 0; i < 60 * 6; i++, t += DT) {
    world.step(DT);
    const s = car.state;
    peakG = Math.max(peakG, Math.hypot(s.localAccel.x, s.localAccel.z) / G);
    maxPen = Math.max(maxPen, s.position.x - 6 + 1.0);
    if (s.impactCount !== seen && s.lastImpact.strength > strength) {
      strength = s.lastImpact.strength;
      kind = s.lastImpact.kind;
    }
    impacts = s.impactCount - seen;
    vAfter = s.speed * 3.6;
    outBounce = Math.min(outBounce, s.velocity.x);
  }
  return { vAfter, peakG, pen: maxPen, impacts, strength, kind, xEnd: car.state.position.x, outBounce };
}

describe('winter calibration', () => {
  const rows: string[] = [];
  const out = () => {
    mkdirSync('.cache', { recursive: true });
    writeFileSync('.cache/winter-calib.txt', rows.join('\n') + '\n');
    console.info('\n' + rows.join('\n'));
  };
  it.runIf(on('skid'))('skidpad', () => {
    for (const surface of ['snow', 'ice'] as const)
      for (const def of CARS) {
        for (const R of [30, 60]) {
          const p = skidpad(def, surface, R);
          rows.push(`${surface.padEnd(5)} ${def.id.padEnd(10)} R${R}: ${p.latG.toFixed(2)} g @ ${p.kmh.toFixed(0)} km/h  slip F ${p.slipFdeg.toFixed(1)} R ${p.slipRdeg.toFixed(1)} deg`);
        }
      }
    out();
  }, 600000);
  it.runIf(on('brake'))('braking', () => {
    for (const surface of ['snow', 'ice'] as const)
      for (const def of CARS) {
        const a = brakeRun(def, surface, true);
        const l = brakeRun(def, surface, false);
        const mu = SURF_MU[surface];
        rows.push(`${surface.padEnd(5)} ${def.id.padEnd(10)} 100-0 ABS ${a.distance.toFixed(1)} m (${a.decel.toFixed(2)} g, abs ${(a.absShare * 100).toFixed(0)}%, locked ${(a.lockShare * 100).toFixed(0)}%) | locked ${l.distance.toFixed(1)} m (${l.decel.toFixed(2)} g) | ideal @ mu ${mu}: ${((100 / 3.6) ** 2 / (2 * mu * G)).toFixed(1)} m`);
      }
    out();
  }, 300000);
  it.runIf(on('accel'))('acceleration', () => {
    for (const surface of ['snow', 'ice'] as const)
      for (const def of CARS) {
        const a = accelRun(def, surface, 'low');
        const b = accelRun(def, surface, 'off');
        rows.push(`${surface.padEnd(5)} ${def.id.padEnd(10)} 0-60 ${a.t60?.toFixed(2)} 0-100 ${a.t100?.toFixed(2)} s TCS low (max slip ${a.maxSlip.toFixed(2)}, spin ${(a.spin * 100).toFixed(0)}%) | TCS off 0-100 ${b.t100?.toFixed(2)} (spin ${(b.spin * 100).toFixed(0)}%)`);
      }
    out();
  }, 300000);
  it.runIf(on('slide'))('throttle slide', () => {
    for (const surface of ['snow', 'ice'] as const)
      for (const def of CARS) {
        const R = 50;
        const g = SURF_MU[surface] * 0.95;
        const v = Math.sqrt(0.8 * g * G * R) * 3.6;
        const a = throttleSlide(def, surface, R, v, 0);
        const b = throttleSlide(def, surface, R, v, 1);
        rows.push(`${surface.padEnd(5)} ${def.id.padEnd(10)} R${R} @ ${v.toFixed(0)} km/h then full throttle: body slip ${a.betaDeg.toFixed(0)} deg yaw ${a.yaw.toFixed(2)} ${a.spun ? 'SPUN' : 'ok'} wide ${a.wide.toFixed(1)} m | with steering assist: beta ${b.betaDeg.toFixed(0)} ${b.spun ? 'SPUN' : 'ok'} wide ${b.wide.toFixed(1)}`);
      }
    out();
  }, 300000);
  it.runIf(on('bank'))('snowbank hits', () => {
    for (const def of [CARS[0], CARS[3]]) {
      for (const [kmh, ang] of [[60, 15], [100, 15], [100, 30], [150, 20], [60, 90], [100, 60]] as const) {
        const s = bankHit(def, kmh, ang, true);
        const h = bankHit(def, kmh, ang, false);
        rows.push(`${def.id.padEnd(10)} ${String(kmh).padStart(3)} km/h @ ${String(ang).padStart(2)} deg: SNOW left ${s.vAfter.toFixed(0)} km/h peak ${s.peakG.toFixed(1)} g depth ${s.pen.toFixed(2)} m impact ${s.strength.toFixed(1)} (${s.kind}) rebound ${s.outBounce.toFixed(1)} m/s | HARD left ${h.vAfter.toFixed(0)} km/h peak ${h.peakG.toFixed(1)} g impact ${h.strength.toFixed(1)} rebound ${h.outBounce.toFixed(1)}`);
      }
    }
    out();
  }, 300000);
});

const SURF_MU: Record<string, number> = { snow: 0.5 * 1.1, ice: 0.4 * 1.1 };
export type { Vehicle };
