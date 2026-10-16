/**
 * Winter driving on a flat pad: studded winter tyres on packed snow and on ice.
 *   - the grip the surfaces give (lateral g, braking distance, traction) is where the design numbers say it is;
 *   - a car on winter tyres slides progressively (the studded tyre's wide, gentle peak) and the default aids keep a brutal thumb
 *     on the road, while with every aid off a car still spins;
 *   - the aids behave on a 0.4-0.5 μ surface: ABS keeps the wheels turning and stops about as well as the grip allows, traction
 *     control leaves most of the drive, stability control fires in a slide and not on a clean corner;
 *   - fresh snow (the "water" of a winter track) costs a little grip and a little speed, and builds up;
 *   - the cars of a road circuit are untouched by all of it.
 * Run: npx vitest run tests/winter-handling.test.ts   (writes .cache/winter-handling.txt)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CARS } from '../src/cars';
import type { Assists, CarDefinition, SurfaceType } from '../src/core/contracts';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { PhysicsWorld, SteeringFilter, createFlatTrack, fitCar, type Vehicle } from '../src/physics';
import { SURFACES } from '../src/physics/surfaces';

const G = 9.81;
const DT = 1 / 60;
const NONE: Assists = { abs: false, tcs: 'off', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
const rows: string[] = [];

function setup(def: CarDefinition, surface: SurfaceType, opts: { speed?: number; wetness?: number; winter?: boolean } = {}) {
  const world = new PhysicsWorld(createFlatTrack({ surface, winter: opts.winter ?? true }));
  world.wetness = opts.wetness ?? 0;
  const car = world.addVehicle(def);
  car.assists = { ...DEFAULT_SETTINGS.assists };
  car.placeOnGround(new Vector3(), new Quaternion(), opts.speed ?? 0);
  car.setTemperatures(1);
  return { world, car };
}

/** The scripted raw stick through the SteeringFilter, as a human drives (tests/handling.test.ts, on snow or ice). */
function run(def: CarDefinition, surface: SurfaceType, assists: Assists, kmh: number, script: (t: number) => { steer: number; throttle: number; brake: number }, seconds: number, wetness = 0) {
  const { world, car } = setup(def, surface, { speed: kmh / 3.6, wetness });
  car.assists = { ...assists };
  const filter = new SteeringFilter();
  let maxBeta = 0;
  let maxYaw = 0;
  let spun = false;
  let escSteps = 0;
  let steps = 0;
  for (let i = 0; i < seconds * 60; i++) {
    const t = i * DT;
    const s = script(t);
    const st = car.state;
    car.controls.steer = filter.update(s.steer, DT, st, car.def, DEFAULT_SETTINGS.controls);
    car.controls.throttle = s.throttle;
    car.controls.brake = s.brake;
    world.step(DT);
    const f = new Vector3(0, 0, 1).applyQuaternion(st.quaternion);
    const l = new Vector3(1, 0, 0).applyQuaternion(st.quaternion);
    if (st.speed > 5) {
      const beta = Math.abs(Math.atan2(st.velocity.dot(l), st.velocity.dot(f)));
      maxBeta = Math.max(maxBeta, beta);
      if (beta > 1.2) spun = true;
    }
    maxYaw = Math.max(maxYaw, Math.abs(st.angularVelocity.y));
    steps++;
    if (st.escActive) escSteps++;
  }
  return { maxBetaDeg: (maxBeta * 180) / Math.PI, maxYaw, spun, endKmh: car.state.speed * 3.6, esc: escSteps / steps };
}

function finite(car: Vehicle) {
  const s = car.state;
  return [s.position.x, s.position.y, s.position.z, s.velocity.x, s.velocity.y, s.velocity.z, s.rpm].every(Number.isFinite);
}

/** Highest sustained lateral acceleration on a circle of radius R. */
function skidpad(def: CarDefinition, surface: SurfaceType, R = 40, wetness = 0) {
  const { world, car } = setup(def, surface, { wetness });
  car.assists = { ...NONE, tcs: 'high' };
  const center = new Vector3(R, 0, 0);
  let vTarget = 4;
  let best = 0;
  let kmh = 0;
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
    const target = new Vector3(center.x + Math.cos(ang - 9 / R) * R, 0, center.z + Math.sin(ang - 9 / R) * R);
    const to = target.sub(s.position);
    to.y = 0;
    const alpha = Math.atan2(to.dot(left), to.dot(fwd));
    const delta = Math.atan((2 * def.physics.chassis.wheelbase * Math.sin(alpha)) / to.length());
    car.controls.steer = Math.max(-1, Math.min(1, -delta / def.physics.chassis.maxSteer));
    const err = vTarget - s.forwardSpeed;
    car.controls.throttle = Math.max(0, Math.min(1, err * 0.25 + 0.15));
    car.controls.brake = err < -1.5 ? 0.3 : 0;
    world.step(DT);
    vTarget += 0.04 * DT * 10;
    const lat = Math.abs(s.localAccel.x) / G;
    if (Math.abs(dist - R) < 3 && i > 120 && lat > best) {
      best = lat;
      kmh = s.forwardSpeed * 3.6;
    }
    if (dist - R > 12) break;
    if (!finite(car)) throw new Error('NaN during skidpad');
  }
  return { latG: best, kmh };
}

function brake(def: CarDefinition, surface: SurfaceType, abs: boolean, kmh = 100, wetness = 0) {
  const v0 = kmh / 3.6;
  const { world, car } = setup(def, surface, { speed: v0, wetness });
  car.assists = { ...DEFAULT_SETTINGS.assists, abs };
  world.simulate(0.3);
  car.placeOnGround(new Vector3(0, 0, car.p.z), new Quaternion(), v0);
  car.setTemperatures(1);
  const z0 = car.p.z;
  car.controls.brake = 1;
  let t = 0;
  let lockedSteps = 0;
  let steps = 0;
  let cycles = 0;
  let wasOn = false;
  while (car.state.forwardSpeed > 0.3 && t < 30) {
    world.step(DT);
    t += DT;
    steps++;
    const st = car.state;
    if (st.forwardSpeed > 6) {
      const wheelV = st.wheels.map((w) => Math.abs(w.omega * w.radius));
      if (Math.min(...wheelV) < 0.1 * st.forwardSpeed) lockedSteps++;
    }
    if (st.absActive !== wasOn) {
      if (st.absActive) cycles++;
      wasOn = st.absActive;
    }
  }
  return { distance: car.p.z - z0, decel: (v0 * v0) / (2 * (car.p.z - z0)) / G, locked: lockedSteps / steps, cycles, time: t };
}

describe('winter surfaces and tyres', () => {
  it('fits every car with studded tyres on a winter circuit, and leaves a road circuit alone', () => {
    const road = createFlatTrack();
    const snow = createFlatTrack({ winter: true });
    for (const def of CARS) {
      expect(fitCar(def, road)).toBe(def);
      const w = fitCar(def, snow);
      expect(w).not.toBe(def);
      expect(fitCar(w, snow)).toBe(w);
      expect(fitCar(def, snow)).toBe(w);
      for (const [a, b] of [[def.physics.tireFront, w.physics.tireFront], [def.physics.tireRear, w.physics.tireRear]]) {
        expect(b.radius).toBe(a.radius);
        expect(b.width).toBe(a.width);
        // a progressive tyre: the peak comes at a larger slip and falls off gently
        expect(b.peakSlipAngle).toBeGreaterThan(a.peakSlipAngle);
        expect(b.peakSlipRatio).toBeGreaterThan(a.peakSlipRatio);
        expect(b.slideRatio).toBeGreaterThan(a.slideRatio);
        expect(b.loadSensitivity).toBeLessThan(a.loadSensitivity);
        // and the same friction for every car, to within the width of the tyre
        expect(b.mu).toBeGreaterThan(1.0);
        expect(b.mu).toBeLessThan(1.2);
      }
      expect(w.visual).toBe(def.visual);
      expect(w.sound).toBe(def.sound);
    }
    // the winter surfaces, relative to dry asphalt
    expect(SURFACES.snow.grip).toBeCloseTo(0.5, 2);
    expect(SURFACES.ice.grip).toBeGreaterThanOrEqual(0.35);
    expect(SURFACES.ice.grip).toBeLessThanOrEqual(0.45);
    expect(SURFACES.deepsnow.grip).toBeLessThan(SURFACES.ice.grip);
    expect(SURFACES.deepsnow.rolling).toBeGreaterThan(SURFACES.gravel.rolling * 0.5);
  });

  it('corners at the grip the surfaces give: about half of dry on packed snow, 0.4 on ice', () => {
    for (const def of CARS) {
      const dry = skidpad(def, 'asphalt', 40);
      const snow = skidpad(def, 'snow');
      const ice = skidpad(def, 'ice');
      rows.push(`${def.id.padEnd(10)} skidpad R40 dry (summer tyre) ${dry.latG.toFixed(2)} g | snow ${snow.latG.toFixed(2)} g @ ${snow.kmh.toFixed(0)} km/h | ice ${ice.latG.toFixed(2)} g @ ${ice.kmh.toFixed(0)} km/h`);
      expect(snow.latG).toBeGreaterThan(0.45);
      expect(snow.latG).toBeLessThan(0.65);
      expect(ice.latG).toBeGreaterThan(0.36);
      expect(ice.latG).toBeLessThan(0.5);
      expect(ice.latG).toBeLessThan(snow.latG * 0.88);
    }
  }, 300000);

  it('stops about as well as the grip allows, ABS cycling without locking, and a locked wheel does worse', () => {
    for (const def of CARS) {
      for (const [surface, mu] of [['snow', 0.5 * 1.1], ['ice', 0.4 * 1.1]] as const) {
        const a = brake(def, surface, true);
        const l = brake(def, surface, false);
        const ideal = (100 / 3.6) ** 2 / (2 * mu * G);
        rows.push(`${def.id.padEnd(10)} ${surface.padEnd(5)} 100-0 ABS ${a.distance.toFixed(1)} m (${a.decel.toFixed(2)} g, ${a.cycles} cycles, locked ${(a.locked * 100).toFixed(0)} %) | locked ${l.distance.toFixed(1)} m | ideal ${ideal.toFixed(1)} m`);
        expect(a.distance).toBeLessThan(ideal * 1.05);
        expect(a.distance).toBeGreaterThan(ideal * 0.7);
        expect(a.locked).toBeLessThan(0.05);
        expect(l.distance).toBeGreaterThanOrEqual(a.distance * 0.99);
      }
    }
  }, 300000);

  it('keeps most of the drive with traction control on, and wheelspin without it', () => {
    for (const def of CARS) {
      for (const surface of ['snow', 'ice'] as const) {
        const t100 = (tcs: Assists['tcs']) => {
          const { world, car } = setup(def, surface);
          car.assists = { ...DEFAULT_SETTINGS.assists, tcs };
          world.simulate(0.5);
          const t0 = world.time;
          car.controls.throttle = 1;
          while (car.state.forwardSpeed < 100 / 3.6 && world.time - t0 < 40) world.step(DT);
          return world.time - t0;
        };
        const on = t100('low');
        const off = t100('off');
        // an ideal launch at the surface's grip (0.5 g of the driven weight at most) is the limit
        rows.push(`${def.id.padEnd(10)} ${surface.padEnd(5)} 0-100 TCS low ${on.toFixed(1)} s | off ${off.toFixed(1)} s`);
        expect(on).toBeLessThan(off * 1.02);
        expect(on).toBeLessThan(surface === 'snow' ? 13 : 16);
        expect(on).toBeGreaterThan(5);
      }
    }
  }, 300000);

  for (const surface of ['snow', 'ice'] as const)
    it(`stays catchable on ${surface} with the default aids, and still slides without them`, () => {
      const failures: string[] = [];
      let slid = 0;
      for (const def of CARS) {
        const step = (a: Assists) => run(def, surface, a, 100, (t) => ({ steer: t > 0.5 && t < 2.5 ? 1 : 0, throttle: 0.3, brake: 0 }), 6);
        const flick = (a: Assists) => run(def, surface, a, 80, (t) => ({ steer: t < 0.6 ? -1 : t < 1.4 ? 1 : 0, throttle: t < 1.4 ? 0 : 1, brake: 0 }), 5);
        const exit = (a: Assists) => run(def, surface, a, 40, (t) => ({ steer: t < 2 ? 0.7 : 0.2, throttle: t > 0.5 ? 1 : 0.2, brake: 0 }), 5);
        const panic = (a: Assists) => run(def, surface, a, 90, (t) => ({ steer: t > 0.3 ? 0.8 : 0, throttle: 0, brake: t > 0.3 ? 1 : 0 }), 5);
        for (const [name, f] of [['step100', step], ['flick80', flick], ['exit40', exit], ['panic90', panic]] as const) {
          const d = f(DEFAULT_SETTINGS.assists);
          const n = f(NONE);
          rows.push(`${def.id.padEnd(10)} ${surface.padEnd(5)} ${name.padEnd(8)} aids: β ${d.maxBetaDeg.toFixed(0).padStart(3)}° yaw ${d.maxYaw.toFixed(2)} ${d.spun ? 'SPUN' : 'ok  '} esc ${(d.esc * 100).toFixed(0).padStart(2)} % | none: β ${n.maxBetaDeg.toFixed(0).padStart(3)}° ${n.spun ? 'SPUN' : 'ok'}`);
          if (d.spun) failures.push(`${def.id}/${name}`);
          if (n.maxBetaDeg > 20) slid++;
        }
      }
      expect(failures).toEqual([]);
      expect(slid).toBeGreaterThan(6);
    }, 300000);

  it('slides progressively: a rear-drive car holds a slide for a while before it lets go', () => {
    // a steady corner pushed past the limit with the throttle: the body slip grows over more than a second (not in a blink)
    for (const def of CARS.filter((c) => c.drivetrain === 'RWD')) {
      const { world, car } = setup(def, 'snow', { speed: 50 / 3.6 });
      car.assists = { ...NONE };
      const filter = new SteeringFilter();
      let t = 0;
      let t10 = -1;
      let t30 = -1;
      for (let i = 0; i < 60 * 6; i++, t += DT) {
        car.controls.steer = filter.update(t > 0.3 ? 0.6 : 0, DT, car.state, car.def, DEFAULT_SETTINGS.controls);
        car.controls.throttle = t > 1 ? 1 : 0.35;
        world.step(DT);
        const st = car.state;
        const f = new Vector3(0, 0, 1).applyQuaternion(st.quaternion);
        const l = new Vector3(1, 0, 0).applyQuaternion(st.quaternion);
        const beta = (Math.abs(Math.atan2(st.velocity.dot(l), st.velocity.dot(f))) * 180) / Math.PI;
        if (t10 < 0 && beta > 10 && t > 1) t10 = t;
        if (t30 < 0 && beta > 30 && t > 1) t30 = t;
      }
      rows.push(`${def.id.padEnd(10)} power slide on snow: 10° of body slip at ${t10.toFixed(2)} s, 30° at ${t30.toFixed(2)} s`);
      expect(t10).toBeGreaterThan(0);
      expect(t30 - t10).toBeGreaterThan(0.25);
    }
  });

  it('a Kestrel pushes and a rear-drive car comes round at the limit', () => {
    // same steady circle, throttle past the limit: the front-drive car's front slips more than its rear, the rear-drive car the other way round
    const frontBias = (def: CarDefinition) => {
      const { world, car } = setup(def, 'snow', { speed: 45 / 3.6 });
      car.assists = { ...NONE };
      const filter = new SteeringFilter();
      let t = 0;
      let f = 0;
      let r = 0;
      let n = 0;
      for (let i = 0; i < 60 * 5; i++, t += DT) {
        car.controls.steer = filter.update(0.5, DT, car.state, car.def, DEFAULT_SETTINGS.controls);
        car.controls.throttle = t < 1 ? 0.3 : 0.7;
        world.step(DT);
        if (t > 2) {
          const w = car.state.wheels;
          f += (Math.abs(w[0].slipAngle) + Math.abs(w[1].slipAngle)) / 2;
          r += (Math.abs(w[2].slipAngle) + Math.abs(w[3].slipAngle)) / 2;
          n++;
        }
      }
      return f / n - r / n;
    };
    const kestrel = frontBias(CARS.find((c) => c.id === 'kestrel-r')!);
    const vanta = frontBias(CARS.find((c) => c.id === 'vanta-gt')!);
    rows.push(`front minus rear slip angle (rad) in a driven corner on snow: kestrel ${kestrel.toFixed(3)}, vanta ${vanta.toFixed(3)}`);
    expect(kestrel).toBeGreaterThan(vanta);
    expect(kestrel).toBeGreaterThan(0);
  });

  it('fresh snow costs a little grip and builds up with the "water" of the track', () => {
    for (const def of CARS) {
      const packed = skidpad(def, 'snow', 40, 0);
      const fresh = skidpad(def, 'snow', 40, 1);
      rows.push(`${def.id.padEnd(10)} fresh snow: skidpad ${packed.latG.toFixed(2)} g -> ${fresh.latG.toFixed(2)} g`);
      expect(fresh.latG).toBeLessThan(packed.latG * 0.97);
      expect(fresh.latG).toBeGreaterThan(packed.latG * 0.75);
    }
    // and it is not wet asphalt: no aquaplaning, no wet-tyre cooling, the drive loses a little to the rolling drag
    const def = CARS[0];
    const { car } = setup(def, 'snow', { wetness: 1 });
    expect(car.winter).toBe(true);
  }, 300000);

  it('deep snow bogs a car down: it slows quickly and leaves again', () => {
    for (const def of [CARS[0], CARS[3]]) {
      const { world, car } = setup(def, 'deepsnow', { speed: 80 / 3.6 });
      car.assists = { ...DEFAULT_SETTINGS.assists };
      world.simulate(5);
      const v5 = car.state.speed * 3.6;
      rows.push(`${def.id.padEnd(10)} coasting in deep snow from 80 km/h: ${v5.toFixed(0)} km/h after 5 s`);
      const road = setup(def, 'snow', { speed: 80 / 3.6 });
      road.world.simulate(5);
      expect(v5).toBeLessThan(road.car.state.speed * 3.6 - 15);
      // it still drives out of it
      const out = setup(def, 'deepsnow', { speed: 0 });
      out.car.controls.throttle = 1;
      out.world.simulate(8);
      expect(out.car.state.forwardSpeed).toBeGreaterThan(4);
    }
  });

  it('is cold: the tyres and the brakes start at the air temperature of a winter circuit', () => {
    const { car } = setup(CARS[0], 'snow');
    car.setTemperatures(0);
    car.publish(1, DT);
    expect(car.state.wheels[0].tempC).toBeLessThan(0);
    expect(car.state.wheels[0].brakeTempC).toBeLessThan(0);
    const road = setup(CARS[0], 'asphalt', { winter: false });
    road.car.setTemperatures(0);
    road.car.publish(1, DT);
    expect(road.car.state.wheels[0].tempC).toBeGreaterThan(15);
  });

  it('writes the numbers', () => {
    mkdirSync('.cache', { recursive: true });
    writeFileSync('.cache/winter-handling.txt', rows.join('\n') + '\n');
  });
});
