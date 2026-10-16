/**
 * AI validation: an AI car must lap every track cleanly at a sensible pace, and a pack of them must race cleanly in the rain.
 * Run: npx vitest run tests/ai.test.ts   (writes .cache/ai-laps-{dry,storm}.txt)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { AIDriver, profileLapTime } from '../src/ai';
import { CARS, getCar } from '../src/cars';
import type { Difficulty, TrackPoint } from '../src/core/contracts';
import { PhysicsWorld } from '../src/physics';
import { TRACKS, loadTrackRuntime } from '../src/track';
import { runPack } from './probes/pack-race';

const DT = 1 / 60;

function lapTest(trackId: string, carId: string, difficulty: Difficulty, laps = 2, wetness = 0) {
  const track = loadTrackRuntime(trackId);
  const def = getCar(carId);
  const world = new PhysicsWorld(track);
  world.wetness = wetness;
  const car = world.addVehicle(def);
  car.assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
  const slot = track.grid[0];
  car.placeOnGround(slot.position, slot.quaternion, 0);
  car.setTemperatures(1);
  const ai = new AIDriver(track, def, { difficulty, seed: 1, wetness });
  const est = profileLapTime(ai.line, ai.profile) / ai.skill.pace;
  const tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
  let hint = -1;
  hint = track.project(car.p.x, car.p.z, tp, hint);
  let prevS = tp.s;
  let crossings = 0;
  let lapStart = 0;
  const lapTimes: number[] = [];
  let resets = 0;
  let impacts = 0;
  let offTrack = 0;
  let maxSpeed = 0;
  const limit = est * (laps + 1.5) + 30;
  while (world.time < limit && lapTimes.length < laps) {
    ai.update(DT, car.state, world.states, car.controls, true);
    if (ai.needsReset) {
      resets++;
      const f = track.frameAt(track.wrapS(ai.s), { position: new Vector3(), tangent: new Vector3(), normal: new Vector3(), left: new Vector3(), widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, curvature: 0, bank: 0 });
      const q = car.q.clone();
      q.setFromRotationMatrix(new Matrix4().makeBasis(f.left, f.normal, f.tangent));
      car.placeOnGround(f.position, q, 0);
      ai.onReset();
    }
    world.step(DT);
    hint = track.project(car.p.x, car.p.z, tp, hint);
    if (Math.abs(tp.d) > Math.max(tp.widthLeft, tp.widthRight) + 1.5) offTrack += DT;
    maxSpeed = Math.max(maxSpeed, car.state.speed);
    let ds = tp.s - prevS;
    if (ds < -track.length / 2) {
      crossings++;
      if (crossings >= 2) lapTimes.push(world.time - lapStart);
      lapStart = world.time;
    }
    prevS = tp.s;
    impacts = car.state.impactCount;
  }
  const temps = car.state.wheels.map((w) => w.tempC.toFixed(0)).join('/');
  const brakes = car.state.wheels.map((w) => w.brakeTempC.toFixed(0)).join('/');
  return { est, lapTimes, resets, impacts, offTrack, maxSpeed: maxSpeed * 3.6, length: track.length, temps, brakes };
}

describe('AI driver', () => {
  for (const [label, wetness] of [['dry', 0], ['storm', 1]] as const)
  it(`laps every track with every car (${label})`, () => {
    const rows: string[] = [];
    const fails: string[] = [];
    for (const t of TRACKS) {
      for (const c of CARS) {
        const r = lapTest(t.info.id, c.id, 'alien', 2, wetness);
        const fmt = (x: number) => { const c = Math.round(x * 100); return `${Math.floor(c / 6000)}:${((c % 6000) / 100).toFixed(2).padStart(5, '0')}`; };
        rows.push(
          `${t.info.id.padEnd(9)} ${c.id.padEnd(10)} len ${r.length.toFixed(0)} m  est ${fmt(r.est)}  laps ${r.lapTimes.map(fmt).join(' ')}  vmax ${r.maxSpeed.toFixed(0)}  resets ${r.resets}  impacts ${r.impacts}  off ${r.offTrack.toFixed(1)}s  tires ${r.temps}C  brakes ${r.brakes}C`,
        );
        if (r.lapTimes.length < 2 || r.resets > 0) fails.push(`${t.info.id}/${c.id}`);
      }
    }
    mkdirSync('.cache', { recursive: true });
    writeFileSync(`.cache/ai-laps-${label}.txt`, rows.join('\n') + '\n');
    expect(fails).toEqual([]);
  }, 600000);
});

describe('AI pack racing in the rain', () => {
  // A mixed 12-car grid of pros on the Brennwald Ring in standing water. With the old drivers and drive-line aids this is
  // where the pack went off: cars that braked for the one ahead locked up (ABS could not let a wheel go on the kerb, the
  // clutch dragged the driven axle), slid across the road and had to be reset.
  it('a mixed grid keeps to the road on Brennwald in a storm', () => {
    let off = 0;
    let resets = 0;
    const seeds = [0, 1, 2];
    for (const seed of seeds) {
      const r = runPack('brennwald', 'mixed', 'pro', 12, 1, false, { seed, wetness: 1 });
      expect(r.finished).toBe(12);
      off += r.offTrack;
      resets += r.resets;
    }
    // (the old drivers: 14 s per race and a reset in two races of three)
    expect(resets).toBe(0);
    expect(off / seeds.length).toBeLessThan(9);
  }, 300000);
});

