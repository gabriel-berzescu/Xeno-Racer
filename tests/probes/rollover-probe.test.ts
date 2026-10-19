/**
 * Does it roll? A tall 4x4 can be tipped by things a low car shrugs off: the push of a wall on its flank, ground that grips a sliding
 * tyre. This drives a car into the left wall of a flat plane at a speed and an angle (the nose turned `yaw` degrees towards the wall, the
 * car moving the way it was heading before the turn, which makes the hit a slide for the big angles), and into loose ground, and
 * reports the largest roll, whether the car ended on its wheels and how many wheels left the ground at the worst.
 *
 *   ROLL=wall,loose,slide  [CAR=mammoth,vanta-gt]  npx vitest run tests/probes/rollover-probe.test.ts   -> .cache/rollover.txt
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { describe, it } from 'vitest';
import { CARS, getCar } from '../../src/cars';
import type { CarDefinition, SurfaceType } from '../../src/core/contracts';
import { PhysicsWorld, createFlatTrack } from '../../src/physics';
import { DEFAULT_SETTINGS } from '../../src/core/settings';

const DT = 1 / 60;
const which = (process.env.ROLL ?? '').split(',').filter(Boolean);
const cars = process.env.CAR ? process.env.CAR.split(',').map(getCar) : CARS;

/** The car at x = 0 doing `kmh` along +Z, then turned `yawDeg` to the left (towards the +X wall) while its velocity stays: a slide of `yawDeg` degrees. */
function slide(def: CarDefinition, kmh: number, yawDeg: number, opts: { surface?: SurfaceType; wall?: number; seconds?: number; brake?: number; bank?: boolean } = {}) {
  const world = new PhysicsWorld(createFlatTrack({ wall: opts.wall ?? 12, surface: opts.surface, ...(opts.bank ? { winter: true, softWalls: true } : {}) }));
  const car = world.addVehicle(def);
  car.assists = { ...DEFAULT_SETTINGS.assists, esc: false };
  car.placeOnGround(new Vector3(), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (yawDeg * Math.PI) / 180), 0);
  car.setTemperatures(1);
  car.v.set(0, 0, kmh / 3.6);
  for (const w of car.wheels) w.omega = kmh / 3.6 / w.radius;
  let maxRoll = 0;
  let worstUp = 0;
  let minUpY = 1;
  let impacts = 0;
  const ax = new Vector3();
  const ay = new Vector3();
  for (let i = 0; i < (opts.seconds ?? 5) * 60; i++) {
    car.controls.brake = opts.brake ?? 0;
    world.step(DT);
    ax.set(1, 0, 0).applyQuaternion(car.state.quaternion);
    ay.set(0, 1, 0).applyQuaternion(car.state.quaternion);
    maxRoll = Math.max(maxRoll, (Math.asin(Math.max(-1, Math.min(1, Math.abs(ax.y)))) * 180) / Math.PI);
    minUpY = Math.min(minUpY, ay.y);
    worstUp = Math.max(worstUp, car.state.wheels.filter((w) => !w.contact).length);
    impacts = car.state.impactCount;
    if (!Number.isFinite(car.p.x + car.p.y + car.p.z)) throw new Error('NaN');
  }
  return { maxRoll, minUpY, wheelsUp: worstUp, upright: ay.y > 0.9, impacts, speed: car.state.speed * 3.6 };
}

describe.skipIf(which.length === 0)('rollover probe', () => {
  it('runs', () => {
    const out: string[] = [];
    const say = (s: string) => out.push(s);
    if (which.includes('wall')) {
      say('── into the left wall (12 m away), nose turned yawDeg towards it, velocity along +Z ──');
      for (const c of cars)
        for (const kmh of [60, 100, 150, 200])
          for (const yaw of [10, 25, 45, 70, 90]) {
            const r = slide(c, kmh, yaw);
            say(`${c.id.padEnd(10)} ${String(kmh).padStart(3)} km/h yaw ${String(yaw).padStart(2)}: roll ${r.maxRoll.toFixed(0).padStart(3)} deg, upright ${r.upright ? 'yes' : 'NO '} (min up ${r.minUpY.toFixed(2)}), wheels up ${r.wheelsUp}, hits ${r.impacts}, ends at ${r.speed.toFixed(0)} km/h`);
          }
    }
    if (which.includes('loose')) {
      say('── sliding sideways (yaw 90) onto loose ground and kerbs, no walls near ──');
      for (const c of cars)
        for (const surface of ['asphalt', 'grass', 'gravel', 'sand', 'dirt', 'curb'] as const)
          for (const kmh of [60, 100, 150]) {
            const r = slide(c, kmh, 90, { surface, wall: 400, seconds: 6 });
            say(`${c.id.padEnd(10)} ${surface.padEnd(7)} ${String(kmh).padStart(3)} km/h: roll ${r.maxRoll.toFixed(0).padStart(3)} deg, upright ${r.upright ? 'yes' : 'NO '}, wheels up ${r.wheelsUp}`);
          }
    }
    if (which.includes('bank')) {
      say('── into a snowbank (soft wall, winter tyres on packed snow), nose turned yawDeg towards it ──');
      for (const c of cars)
        for (const kmh of [60, 100, 150])
          for (const yaw of [10, 25, 45, 90]) {
            const r = slide(c, kmh, yaw, { surface: 'snow', bank: true, seconds: 8 });
            say(`${c.id.padEnd(10)} ${String(kmh).padStart(3)} km/h yaw ${String(yaw).padStart(2)}: roll ${r.maxRoll.toFixed(0).padStart(3)} deg, upright ${r.upright ? 'yes' : 'NO '} (min up ${r.minUpY.toFixed(2)}), wheels up ${r.wheelsUp}, hits ${r.impacts}, ends at ${r.speed.toFixed(0)} km/h`);
          }
    }
    mkdirSync('.cache', { recursive: true });
    writeFileSync('.cache/rollover.txt', out.join('\n') + '\n');
  }, 1800000);
});
