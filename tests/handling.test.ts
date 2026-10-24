/**
 * Gamepad drivability: brutal stick inputs with the default assists must stay catchable, while
 * assists off must still let a car slide (so the sim keeps its teeth).
 * Run: npx vitest run tests/handling.test.ts   (writes .cache/handling.txt)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CARS, getCar } from '../src/cars';
import type { Assists, CarDefinition } from '../src/core/contracts';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { PhysicsWorld, SteeringFilter, createFlatTrack, type FlatTrackOptions } from '../src/physics';
import { gripAtSpeed } from './probes/car-metrics';

const DT = 1 / 60;

/** Drive with a scripted raw stick (as a human would) through the SteeringFilter. */
function run(def: CarDefinition, assists: Assists, kmh: number, script: (t: number) => { steer: number; throttle: number; brake: number }, seconds: number, wetness = 0, ground: FlatTrackOptions = {}) {
  const world = new PhysicsWorld(createFlatTrack(ground));
  world.wetness = wetness;
  const car = world.addVehicle(def);
  car.assists = { ...assists };
  car.placeOnGround(new Vector3(), new Quaternion(), kmh / 3.6);
  car.setTemperatures(1);
  // hold speed for a moment
  const filter = new SteeringFilter();
  let maxBeta = 0;
  let maxYaw = 0;
  let spun = false;
  for (let i = 0; i < seconds * 60; i++) {
    const t = i * DT;
    const s = script(t);
    const st = car.state;
    car.controls.steer = filter.update(s.steer, DT, st, def, DEFAULT_SETTINGS.controls);
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
  }
  return { maxBetaDeg: (maxBeta * 180) / Math.PI, maxYaw, spun, endKmh: car.state.speed * 3.6 };
}

describe('gamepad handling', () => {
  for (const [label, wetness] of [['dry', 0], ['storm', 1]] as const)
  it(`stays catchable with default assists, still slides without them (${label})`, () => {
    const rows: string[] = [];
    const defaults = DEFAULT_SETTINGS.assists;
    const none: Assists = { abs: false, tcs: 'off', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
    const failures: string[] = [];
    for (const def of CARS) {
      // 1. full stick step at 150 km/h, held for 2 s, then released
      const step = (a: Assists) => run(def, a, 150, (t) => ({ steer: t > 0.5 && t < 2.5 ? 1 : 0, throttle: 0.3, brake: 0 }), 5, wetness);
      // 2. flick left-right at 110 km/h (Scandinavian flick)
      const flick = (a: Assists) => run(def, a, 110, (t) => ({ steer: t < 0.6 ? -1 : t < 1.4 ? 1 : 0, throttle: t < 1.4 ? 0 : 1, brake: 0 }), 4, wetness);
      // 3. full throttle out of a 60 km/h corner
      const exit = (a: Assists) => run(def, a, 60, (t) => ({ steer: t < 2 ? 0.7 : 0.2, throttle: t > 0.5 ? 1 : 0.2, brake: 0 }), 4, wetness);
      // 4. panic brake while turning at 130
      const panic = (a: Assists) => run(def, a, 130, (t) => ({ steer: t > 0.3 ? 0.8 : 0, throttle: 0, brake: t > 0.3 ? 1 : 0 }), 4, wetness);
      const tests: [string, (a: Assists) => ReturnType<typeof run>][] = [['step150', step], ['flick110', flick], ['exit60', exit], ['panic130', panic]];
      for (const [name, f] of tests) {
        const d = f(defaults);
        const n = f(none);
        rows.push(
          `${def.id.padEnd(10)} ${name.padEnd(9)} assists: β ${d.maxBetaDeg.toFixed(1).padStart(5)}° yaw ${d.maxYaw.toFixed(2)} ${d.spun ? 'SPUN' : 'ok  '} | none: β ${n.maxBetaDeg.toFixed(1).padStart(5)}° yaw ${n.maxYaw.toFixed(2)} ${n.spun ? 'SPUN' : 'ok'}`,
        );
        if (d.spun) failures.push(`${def.id}/${name}`);
      }
    }
    mkdirSync('.cache', { recursive: true });
    writeFileSync(`.cache/handling-${label}.txt`, rows.join('\n') + '\n');
    expect(failures).toEqual([]);
  }, 300000);
});

describe('the stability control on a car with wings', () => {
  // ESC's ceiling is the yaw rate the tyres hold under the weight, or the lateral acceleration the car has when it turns harder than that,
  // and its reference takes less understeer for a car the downforce presses down. With the weight alone the default aids held the LMP-X
  // to 2.67 g at 250 km/h where its tyres hold 3.02, and the Volta to 2.27 g at 225 km/h where they hold 3.71 at 241. With the downforce
  // counted as the weight is, a ceiling that knew nothing of the water, the two slid 40-60 degrees in a stop at full lock from 250 km/h in
  // standing water and the Volta spun in a lane change there.
  const winged = [getCar('lmp-x'), getCar('volta')];
  const aids = DEFAULT_SETTINGS.assists;

  it('lets it turn at 250 km/h as hard as its tyres hold it', () => {
    for (const def of winged) {
      const on = gripAtSpeed(def, 250, {}, 18, 20, { ...aids });
      const off = gripAtSpeed(def, 250, {}, 18, 20, { ...aids, esc: false });
      // (the Volta gives up a few km/h on the turn-in, where ESC still steps in, and holds what its tyres hold there: 3.60 g at 235 km/h)
      expect(on.latG / off.latG, def.id).toBeGreaterThan(0.95);
    }
  }, 120000);

  it('still catches it in standing water at 250 km/h: a stop at full lock, and a lane change flat out', () => {
    const wide: FlatTrackOptions = { wall: 6000, halfWidth: 6000 };
    for (const def of winged)
      for (const wetness of [0.75, 1]) {
        const stop = (a: Assists) => run(def, a, 250, (t) => ({ steer: t > 0.3 ? 1 : 0, throttle: 0, brake: t > 0.3 ? 1 : 0 }), 4, wetness, wide);
        const on = stop({ ...aids });
        const off = stop({ ...aids, esc: false });
        const name = `${def.id} wet ${wetness}`;
        expect(on.maxBetaDeg, `${name}: stop`).toBeLessThan(25);
        expect(on.maxBetaDeg, `${name}: stop`).toBeLessThan(off.maxBetaDeg);
        const lane = run(def, { ...aids }, 240, (t) => ({ steer: t < 0.5 ? 0 : t < 1.2 ? 1 : t < 2.6 ? -1 : t < 3.3 ? 1 : 0, throttle: 1, brake: 0 }), 6, wetness, wide);
        expect(lane.maxBetaDeg, `${name}: lane change`).toBeLessThan(25);
      }
  }, 120000);
});

describe('the stability control in standing water', () => {
  // ESC's ceiling counts what the water leaves the tyres, as the tyre forces do. With the dry ceiling a road car on a wet road could turn
  // at a rate its tyres no longer held before ESC called it a slide: with the default aids the Vanta GT slid 45 degrees in a lane change
  // flat out from 80 km/h at wetness 1, and 34 at 0.75 (14 and 15 now).
  const aids = DEFAULT_SETTINGS.assists;

  it('holds a road car in a lane change flat out on a wet road', () => {
    for (const id of ['vanta-gt', 'kestrel-r', 'ronin-86', 'mammoth']) {
      const def = getCar(id);
      for (const wetness of [0.75, 1])
        for (const kmh of [80, 120])
          for (const stick of [0.6, 1]) {
            const lane = run(def, { ...aids }, kmh, (t) => ({ steer: t < 0.5 ? 0 : t < 1.2 ? stick : t < 2.6 ? -stick : t < 3.3 ? stick : 0, throttle: 1, brake: 0 }), 6, wetness);
            expect(lane.maxBetaDeg, `${id} wet ${wetness} ${kmh} km/h stick ${stick}`).toBeLessThan(20);
          }
    }
  }, 120000);
});
