/**
 * Bit-identity guard for the four cars that were in the game before the Mammoth (Vanta GT, Kestrel R, Ronin 86, LMP-X).
 *
 * The Mammoth brought an all-terrain tyre trait, an AWD traction model and a good deal of per-car handling into code the other
 * four share (vehicle.ts, surfaces.ts, the AI's speed profile and driver). None of it may move them by a single bit. This probe
 * drives each of the four through a fixed set of scenarios and writes the full state (position, orientation, velocities, every
 * wheel's speed, load, forces, temperatures, the engine and the controls the AI chose) at fixed times to a JSON file; run on the
 * commit before a change and again after it, the two files must be equal number for number.
 *
 *   FOURCARS=record  FOURCARS_FILE=.cache/four-cars-before.json  npx vitest run tests/probes/four-cars.test.ts
 *   FOURCARS=compare FOURCARS_FILE=.cache/four-cars-before.json  npx vitest run tests/probes/four-cars.test.ts
 *
 * (`record` writes the file, `compare` reads it, runs everything again and fails at the first number that differs, saying where.
 * Without FOURCARS the probe is skipped: it takes about a minute and it is a guard for a change, not a property of the game.)
 *
 * Scenarios:
 *   - open-loop drives (fixed stick, throttle, brake and handbrake against time, no feedback) on a flat plane of each surface the
 *     game has, dry and wet, with the default aids and with none: the whole tyre, surface, drivetrain and aid code;
 *   - one AI lap of Aurelia (dry and in the rain) and of Isvik (winter tyres): the speed profile, the driver, the governor;
 *   - a pack of eight (two of each car) from the grid on Aurelia and on Isvik for a while: traffic, contacts, the lot.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { AIDriver } from '../../src/ai';
import { getCar } from '../../src/cars';
import type { Assists, SurfaceType } from '../../src/core/contracts';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { PhysicsWorld, createFlatTrack, type Vehicle } from '../../src/physics';
import { loadTrackRuntime } from '../../src/track';

const MODE = process.env.FOURCARS ?? '';
const FILE = process.env.FOURCARS_FILE ?? '.cache/four-cars.json';
const DT = 1 / 60;
const IDS = ['vanta-gt', 'kestrel-r', 'ronin-86', 'lmp-x'];
const NONE: Assists = { abs: false, tcs: 'off', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
const AI_ASSISTS: Assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
const SURFACES_TESTED: SurfaceType[] = ['asphalt', 'curb', 'concrete', 'grass', 'dirt', 'gravel', 'sand', 'snow', 'ice', 'deepsnow'];
const WINTER: SurfaceType[] = ['snow', 'ice', 'deepsnow'];

type Run = number[][];

/** Everything about a car that the physics decides, as a flat list of numbers. */
function snapshot(t: number, v: Vehicle): number[] {
  const out: number[] = [t, v.p.x, v.p.y, v.p.z, v.q.x, v.q.y, v.q.z, v.q.w, v.v.x, v.v.y, v.v.z, v.w.x, v.w.y, v.w.z];
  const st = v.state;
  out.push(st.rpm, st.gear, st.throttle, st.brake, st.steer, st.clutch, st.boost, st.engineLoad, st.impactCount, st.absActive ? 1 : 0, st.tcsActive ? 1 : 0, st.escActive ? 1 : 0, st.backfireCount, st.shiftCount);
  for (const wh of v.wheels) out.push(wh.omega, wh.spin, wh.load, wh.fx, wh.fy, wh.kappa, wh.alpha, wh.compression, wh.tempC, wh.brakeTempC, wh.rho, wh.skid);
  const c = v.controls;
  out.push(c.steer, c.throttle, c.brake, c.handbrake);
  return out;
}

/** The open-loop script: nothing in it depends on the car, so any change in the car shows in the state and nowhere else. */
function script(t: number) {
  const steer = t < 2 ? 0 : t < 4 ? 0.5 * Math.sin((t - 2) * Math.PI) : t < 6 ? -0.4 : 0.3 * Math.sin(t * 4);
  const throttle = t < 5 ? 1 : t < 7 ? 0 : 0.7;
  const brake = t >= 4.5 && t < 5.8 ? 1 : 0;
  const handbrake = t >= 7 && t < 7.5 ? 0.8 : 0;
  return { steer, throttle, brake, handbrake };
}

function openLoop(id: string, surface: SurfaceType, wetness: number, assists: Assists): Run {
  const def = getCar(id);
  const world = new PhysicsWorld(createFlatTrack({ surface, winter: WINTER.includes(surface) }));
  world.wetness = wetness;
  const car = world.addVehicle(def);
  car.assists = { ...assists };
  car.placeOnGround(new Vector3(), new Quaternion(), 0);
  car.setTemperatures(1);
  const run: Run = [];
  for (let i = 0; i < 10 * 60; i++) {
    const s = script(i * DT);
    car.controls.steer = s.steer;
    car.controls.throttle = s.throttle;
    car.controls.brake = s.brake;
    car.controls.handbrake = s.handbrake;
    world.step(DT);
    if (i % 30 === 29) run.push(snapshot(world.time, car));
  }
  return run;
}

function aiLap(id: string, trackId: string, wetness: number, seconds: number): Run {
  const track = loadTrackRuntime(trackId);
  const def = getCar(id);
  const world = new PhysicsWorld(track);
  world.wetness = wetness;
  const car = world.addVehicle(def);
  car.assists = { ...AI_ASSISTS };
  const slot = track.grid[0];
  car.placeOnGround(slot.position, slot.quaternion, 0);
  car.setTemperatures(1);
  const ai = new AIDriver(track, def, { difficulty: 'pro', seed: 7, wetness });
  const run: Run = [];
  let n = 0;
  while (world.time < seconds) {
    ai.update(DT, car.state, world.states, car.controls, true);
    if (ai.needsReset) ai.onReset();
    world.step(DT);
    if (++n % 60 === 0) run.push(snapshot(world.time, car));
  }
  return run;
}

function pack(trackId: string, wetness: number, seconds: number): Run {
  const track = loadTrackRuntime(trackId);
  const world = new PhysicsWorld(track);
  world.wetness = wetness;
  const cars: { v: Vehicle; ai: AIDriver }[] = [];
  for (let i = 0; i < 8; i++) {
    const def = getCar(IDS[i % 4]);
    const v = world.addVehicle(def);
    v.assists = { ...AI_ASSISTS };
    const g = track.grid[i];
    v.placeOnGround(g.position, g.quaternion, 0);
    v.setTemperatures(0.8);
    v.holdOnGrid = true;
    cars.push({ v, ai: new AIDriver(track, def, { difficulty: 'pro', seed: v.id * 17 + i, wetness }) });
  }
  const states = world.states;
  const run: Run = [];
  const goAt = 3;
  let racing = false;
  let n = 0;
  let contacts = 0;
  while (world.time < goAt + seconds) {
    if (!racing && world.time >= goAt) {
      racing = true;
      for (const c of cars) c.v.holdOnGrid = false;
    }
    for (const c of cars) {
      c.ai.update(DT, c.v.state, states, c.v.controls, racing);
      if (c.ai.needsReset) c.ai.onReset();
    }
    world.step(DT);
    contacts += world.carContacts;
    if (++n % 120 === 0) {
      const row: number[] = [world.time, contacts];
      for (const c of cars) row.push(...snapshot(world.time, c.v));
      run.push(row);
    }
  }
  return run;
}

function record(): Record<string, Run> {
  const runs: Record<string, Run> = {};
  for (const id of IDS) {
    for (const surface of SURFACES_TESTED) {
      const wets = surface === 'asphalt' || surface === 'grass' || surface === 'gravel' || surface === 'snow' ? [0, 0.75] : [0];
      for (const wet of wets) {
        runs[`open ${id} ${surface} wet${wet} default`] = openLoop(id, surface, wet, DEFAULT_SETTINGS.assists);
        runs[`open ${id} ${surface} wet${wet} none`] = openLoop(id, surface, wet, NONE);
      }
    }
  }
  for (const id of IDS) {
    runs[`ai ${id} aurelia dry`] = aiLap(id, 'aurelia', 0, 100);
    runs[`ai ${id} aurelia wet`] = aiLap(id, 'aurelia', 0.75, 100);
    runs[`ai ${id} isvik dry`] = aiLap(id, 'isvik', 0, 100);
    runs[`ai ${id} isvik snowfall`] = aiLap(id, 'isvik', 1, 60);
  }
  runs['pack aurelia'] = pack('aurelia', 0, 45);
  runs['pack isvik'] = pack('isvik', 0, 45);
  runs['pack brennwald wet'] = pack('brennwald', 1, 40);
  return runs;
}

describe('the four cars before the Mammoth', () => {
  it.skipIf(!MODE)(
    `${MODE || 'record or compare'} their state in fixed scenarios (FOURCARS=record|compare, FOURCARS_FILE)`,
    () => {
      const now = record();
      const count = Object.values(now).reduce((a, r) => a + r.length * r[0].length, 0);
      if (MODE === 'record') {
        mkdirSync('.cache', { recursive: true });
        writeFileSync(FILE, JSON.stringify(now));
        console.log(`four-cars: recorded ${Object.keys(now).length} runs, ${count} numbers -> ${FILE}`);
        return;
      }
      const before = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, Run>;
      const keys = Object.keys(before);
      expect(Object.keys(now).sort()).toEqual(keys.sort());
      const bad: string[] = [];
      let worst = 0;
      for (const key of keys) {
        const a = before[key];
        const b = now[key];
        if (a.length !== b.length) {
          bad.push(`${key}: ${a.length} samples before, ${b.length} now`);
          continue;
        }
        for (let i = 0; i < a.length && !bad.some((m) => m.startsWith(key + ' ')); i++) {
          for (let j = 0; j < a[i].length; j++) {
            // (JSON keeps no sign for a zero: -0 and 0 are the same number here)
            if (a[i][j] !== b[i][j] && !(Number.isNaN(a[i][j]) && Number.isNaN(b[i][j]))) {
              worst = Math.max(worst, Math.abs(a[i][j] - b[i][j]));
              bad.push(`${key} first differs at sample ${i} (t=${a[i][0]}) number ${j}: ${a[i][j]} -> ${b[i][j]}`);
              break;
            }
          }
        }
      }
      console.log(`four-cars: compared ${keys.length} runs, ${count} numbers: ${bad.length === 0 ? 'ALL BIT-IDENTICAL' : `${bad.length} runs differ`}`);
      expect(bad.slice(0, 12)).toEqual([]);
    },
    1800000,
  );
});
