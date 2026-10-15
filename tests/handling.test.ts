/**
 * Gamepad drivability: brutal stick inputs with the default assists must stay catchable, while
 * assists off must still let a car slide (so the sim keeps its teeth).
 * Run: npx vitest run tests/handling.test.ts   (writes .cache/handling.txt)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CARS } from '../src/cars';
import type { Assists, CarDefinition } from '../src/core/contracts';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { PhysicsWorld, SteeringFilter, createFlatTrack } from '../src/physics';

const DT = 1 / 60;

/** Drive with a scripted raw stick (as a human would) through the SteeringFilter. */
function run(def: CarDefinition, assists: Assists, kmh: number, script: (t: number) => { steer: number; throttle: number; brake: number }, seconds: number, wetness = 0) {
  const world = new PhysicsWorld(createFlatTrack());
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
