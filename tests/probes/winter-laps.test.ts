/**
 * Single-car AI laps on a winter circuit, with how the car is driven: lap times, the body slip it runs (how much it slides), how much of the lap it
 * spends counter-steering and how much, wall hits, resets, time off the road.
 *   WINTERLAPS=1 [TRACK=isvik] [CAR=vanta-gt,...] [DIFF=pro,alien] [WET=0,1] [LAPS=2] npx vitest run tests/probes/winter-laps.test.ts   -> .cache/winter-laps.txt
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Matrix4, Vector3 } from 'three';
import { describe, it } from 'vitest';
import { AIDriver, profileLapTime } from '../../src/ai';
import { CARS, getCar } from '../../src/cars';
import type { Difficulty, TrackPoint } from '../../src/core/contracts';
import { PhysicsWorld } from '../../src/physics';
import { loadTrackRuntime } from '../../src/track';

const DT = 1 / 60;
const fmt = (x: number) => {
  const c = Math.round(x * 100);
  return `${Math.floor(c / 6000)}:${((c % 6000) / 100).toFixed(2).padStart(5, '0')}`;
};

export function winterLap(trackId: string, carId: string, difficulty: Difficulty, laps: number, wetness: number, assists = { abs: true, tcs: 'low' as const, esc: false, autoShift: true, steeringAssist: 0, autoClutch: true }) {
  const track = loadTrackRuntime(trackId);
  const def = getCar(carId);
  const world = new PhysicsWorld(track);
  world.wetness = wetness;
  const car = world.addVehicle(def);
  car.assists = { ...assists };
  const slot = track.grid[0];
  car.placeOnGround(slot.position, slot.quaternion, 0);
  car.setTemperatures(1);
  const ai = new AIDriver(track, def, { difficulty, seed: 1, wetness });
  const est = profileLapTime(ai.line, ai.profile) / ai.skill.pace;
  const tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
  let hint = track.project(car.p.x, car.p.z, tp, -1);
  let prevS = tp.s;
  let crossings = 0;
  let lapStart = 0;
  const lapTimes: number[] = [];
  let resets = 0;
  let walls = 0;
  let offTrack = 0;
  let maxSpeed = 0;
  let lastImpact = 0;
  // slide statistics over the timed laps
  let tCount = 0;
  let betaSum = 0;
  let betaMax = 0;
  let slideT = 0;
  let counterT = 0;
  let counterSum = 0;
  let counterMax = 0;
  let cornerT = 0;
  let escT = 0;
  let tcsT = 0;
  let absT = 0;
  const f = new Vector3();
  const l = new Vector3();
  const limit = est * (laps + 1.5) + 30;
  while (world.time < limit && lapTimes.length < laps) {
    ai.update(DT, car.state, world.states, car.controls, true);
    if (ai.needsReset) {
      resets++;
      const fr = track.frameAt(track.wrapS(ai.s), { position: new Vector3(), tangent: new Vector3(), normal: new Vector3(), left: new Vector3(), widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, curvature: 0, bank: 0 });
      const q = car.q.clone();
      q.setFromRotationMatrix(new Matrix4().makeBasis(fr.left, fr.normal, fr.tangent));
      car.placeOnGround(fr.position, q, 0);
      ai.onReset();
    }
    world.step(DT);
    const st = car.state;
    hint = track.project(car.p.x, car.p.z, tp, hint);
    if (Math.abs(tp.d) > Math.max(tp.widthLeft, tp.widthRight) + 1.5) offTrack += DT;
    maxSpeed = Math.max(maxSpeed, st.speed);
    if (st.impactCount !== lastImpact) {
      lastImpact = st.impactCount;
      walls++;
    }
    if (crossings >= 1 && st.speed > 8) {
      f.set(0, 0, 1).applyQuaternion(st.quaternion);
      l.set(1, 0, 0).applyQuaternion(st.quaternion);
      const beta = Math.atan2(st.velocity.dot(l), st.velocity.dot(f));
      const yaw = st.angularVelocity.y;
      tCount++;
      betaSum += Math.abs(beta);
      betaMax = Math.max(betaMax, Math.abs(beta));
      const deg = Math.abs(beta) * (180 / Math.PI);
      if (deg > 6) slideT++;
      if (Math.abs(yaw) > 0.12) cornerT++;
      // counter-steer: the stick against the way the car is turning (stick left = -1 and left yaw = +) while the car is sliding
      if (deg > 4 && Math.abs(yaw) > 0.08 && car.controls.steer * yaw > 0) {
        counterT++;
        counterSum += Math.abs(car.controls.steer);
        counterMax = Math.max(counterMax, Math.abs(car.controls.steer));
      }
      if (st.escActive) escT++;
      if (st.tcsActive) tcsT++;
      if (st.absActive) absT++;
    }
    const ds = tp.s - prevS;
    if (ds < -track.length / 2) {
      crossings++;
      if (crossings >= 2) lapTimes.push(world.time - lapStart);
      lapStart = world.time;
    }
    prevS = tp.s;
  }
  const n = Math.max(1, tCount);
  return {
    est,
    lapTimes,
    resets,
    walls,
    offTrack,
    vmax: maxSpeed * 3.6,
    betaMean: (betaSum / n) * (180 / Math.PI),
    betaMax: betaMax * (180 / Math.PI),
    slidePct: (100 * slideT) / n,
    counterPct: (100 * counterT) / n,
    counterMean: counterT ? counterSum / counterT : 0,
    counterMax,
    cornerPct: (100 * cornerT) / n,
    escPct: (100 * escT) / n,
    tcsPct: (100 * tcsT) / n,
    absPct: (100 * absT) / n,
    length: track.length,
  };
}

describe.runIf(!!process.env.WINTERLAPS)('winter AI laps', () => {
  it('drives', () => {
    const tracks = (process.env.TRACK ?? 'isvik').split(',');
    const cars = (process.env.CAR ?? CARS.map((c) => c.id).join(',')).split(',');
    const diffs = (process.env.DIFF ?? 'pro,alien').split(',') as Difficulty[];
    const wets = (process.env.WET ?? '0').split(',').map(Number);
    const laps = +(process.env.LAPS ?? 2);
    const rows: string[] = [];
    for (const t of tracks)
      for (const w of wets)
        for (const d of diffs)
          for (const c of cars) {
            const r = winterLap(t, c, d, laps, w);
            rows.push(
              `${t} ${c.padEnd(10)} ${d.padEnd(6)} wet ${w}  est ${fmt(r.est)}  laps ${r.lapTimes.map(fmt).join(' ')}  vmax ${r.vmax.toFixed(0)}  resets ${r.resets} walls ${r.walls} off ${r.offTrack.toFixed(1)}s | body slip mean ${r.betaMean.toFixed(1)} max ${r.betaMax.toFixed(0)} deg, sliding >6deg ${r.slidePct.toFixed(0)} % of the lap | counter-steer ${r.counterPct.toFixed(1)} % of the lap (mean ${(r.counterMean * 100).toFixed(0)} % of lock, max ${(r.counterMax * 100).toFixed(0)} %) | tcs ${r.tcsPct.toFixed(0)} % abs ${r.absPct.toFixed(0)} %`,
            );
          }
    mkdirSync('.cache', { recursive: true });
    writeFileSync(`.cache/winter-laps${process.env.TAG ? '-' + process.env.TAG : ''}.txt`, rows.join('\n') + '\n');
  }, 1800000);
});

it('is a probe', () => {});
