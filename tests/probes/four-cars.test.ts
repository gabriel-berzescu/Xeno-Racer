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
 * The same guard works for any other car or cars: FOURCARS_IDS=mammoth (a comma-separated list of car ids) drives those instead, in the
 * same scenarios (the pack is then eight of them, or of the list in turn). It is what proves that a change to code every car shares,
 * the mechanical damage for one, leaves an undamaged car exactly as it was; the file of the four is the file of the four.
 *
 * The LMP-X is on racing slicks since tests/slicks.test.ts: a file recorded before them differs from now in the LMP-X's runs that leave
 * the paved ground (12 of the open-loop drives, on grass, dirt, gravel and sand; its AI laps and the packs it is in that touch the grass)
 * and in nothing else: Vanta, Kestrel and Ronin, and the LMP-X on asphalt, kerb, concrete, snow, ice and deep snow, are bit for bit
 * what they were. Record a new file on the commit before the next change.
 *
 * The stability control counts the downforce (src/physics/vehicle.ts: its yaw ceiling is the lateral acceleration the car has when that is
 * more than the weight alone allows, and its reference takes less understeer for a car the downforce presses down): a file recorded before
 * that differs in the open-loop drives with the default aids (ESC on), each from the first time ESC steps in, at 2.5-4.5 s (the Kestrel
 * R's and the Ronin 86's, whose lips press them down by a few kilos, by up to 42 mm; the others' by up to 1.5 m over the slides), and in
 * nothing else: the drives with no aids, the AI laps and the packs (the AI drives with ESC off) are bit for bit what they were.
 *
 * Scenarios:
 *   - open-loop drives (fixed stick, throttle, brake and handbrake against time, no feedback) on a flat plane of each surface the
 *     game has, dry and wet, with the default aids and with none: the whole tyre, surface, drivetrain and aid code;
 *   - one AI lap of Aurelia (dry and in the rain) and of Isvik (winter tyres): the speed profile, the driver, the governor;
 *   - a pack of eight (two of each car) from the grid on Aurelia and on Isvik for a while: traffic, contacts, the lot.
 *
 * The AI's look-ahead braking counts the downforce in clean air (brakeReach, src/ai/driver.ts): a file recorded before that differs in
 * the AI laps where that braking held a car back, the LMP-X's and the Volta's from their first big stop (12-16 s) and the other cars'
 * only on Isvik's snow (the Vanta GT's, Kestrel R's and Ronin 86's from 78 s, by 2-22 cm; the Mammoth's, whose lift counts against it,
 * from 72 s, and from 11 s in the snowfall), and in the packs; the open-loop drives are what they were.
 *
 * The AI's steering counts the downforce in clean air (the slip angle of the front tyres, src/ai/driver.ts): a file recorded before that
 * differs in the AI laps of Aurelia, every car's from the first second or two (the road cars' and the Mammoth's by up to 23 cm, the
 * LMP-X's by 4.4 m, the Volta's by 61 m: it no longer runs wide in the fast bends), and in the packs of Aurelia and Brennwald; on Isvik, a
 * winter circuit where the steering counts the weight alone, and in the open-loop drives everything is what it was.
 *
 * The stability control counts the water (its ceiling under the weight takes what the water leaves the tyres, as the tyre forces do): a
 * file recorded before that differs in the open-loop drives with the default aids on wet asphalt, every car's, and the Mammoth's on wet
 * grass, each from the first time ESC steps in (2.5-3.0 s; the Ronin 86 by up to 0.3 m, the others by 2.5-7.7 m over the drive), and in
 * nothing else: on wet grass and gravel the others' stability control
 * decides the same to the bit, on snow (whose "water" is fresh snow, which the ceiling counted already) and in every drive with no aids,
 * every AI lap and every pack (the AI drives with ESC off) everything is what it was.
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
const IDS = (process.env.FOURCARS_IDS ?? 'vanta-gt,kestrel-r,ronin-86,lmp-x').split(',');
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
    const def = getCar(IDS[i % IDS.length]);
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
