/**
 * Laps a circuit with the AI driver while the circuit is being designed: lap times, top speed, impacts, time off the road, and the
 * speed each corner is taken at.
 *   TRACKLAPS=xenon [CARS=vanta-gt,lmp-x] [WET=0,1] [DIFF=alien] npx vitest run tests/probes/track-laps.test.ts   -> .cache/laps-<id>.txt
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Matrix4, Vector3 } from 'three';
import { describe, it } from 'vitest';
import { AIDriver, profileLapTime } from '../../src/ai';
import { CARS, getCar } from '../../src/cars';
import type { Difficulty, TrackPoint } from '../../src/core/contracts';
import { PhysicsWorld } from '../../src/physics';
import { loadTrackRuntime } from '../../src/track';
import type { TrackRuntimeImpl } from '../../src/track';

const id = process.env.TRACKLAPS ?? '';
const DT = 1 / 60;
const fmt = (x: number): string => {
  const c = Math.round(x * 100);
  return `${Math.floor(c / 6000)}:${((c % 6000) / 100).toFixed(2).padStart(5, '0')}`;
};

describe.runIf(id !== '')('track laps', () => {
  it('laps it', () => {
    const track = loadTrackRuntime(id) as TrackRuntimeImpl;
    const cars = (process.env.CARS ?? CARS.map((c) => c.id).join(',')).split(',');
    const wets = (process.env.WET ?? '0').split(',').map(Number);
    const difficulty = (process.env.DIFF ?? 'alien') as Difficulty;
    const lines: string[] = [`${track.info.name}: ${track.length.toFixed(0)} m, ${difficulty}`];
    for (const wetness of wets) {
      for (const carId of cars) {
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
        let hint = track.project(car.p.x, car.p.z, tp, -1);
        let prevS = tp.s;
        let crossings = 0;
        let lapStart = 0;
        const lapTimes: number[] = [];
        let resets = 0;
        let offTrack = 0;
        let maxSpeed = 0;
        let lastImpact = 0;
        const hits: string[] = [];
        // the slowest and the fastest the car was in each corner, and before it on the straight, on the timed laps
        const minV = track.corners.map(() => Infinity);
        const maxBefore = track.corners.map(() => 0);
        const limit = est * 3.5 + 30;
        while (world.time < limit && lapTimes.length < 2) {
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
          const v = car.state.speed;
          maxSpeed = Math.max(maxSpeed, v);
          if (car.state.impactCount !== lastImpact) {
            lastImpact = car.state.impactCount;
            hits.push(`${car.state.lastImpact.kind}@${tp.s.toFixed(0)} (${car.state.lastImpact.strength.toFixed(1)})`);
          }
          if (crossings >= 1) {
            track.corners.forEach((c, k) => {
              if (tp.s >= c.sStart && tp.s <= c.sEnd) minV[k] = Math.min(minV[k], v);
              const before = track.wrapS(c.sStart - tp.s);
              if (before < 200) maxBefore[k] = Math.max(maxBefore[k], v);
            });
          }
          if (tp.s - prevS < -track.length / 2) {
            crossings++;
            if (crossings >= 2) lapTimes.push(world.time - lapStart);
            lapStart = world.time;
          }
          prevS = tp.s;
        }
        lines.push(
          `${wetness ? `wet ${wetness}` : 'dry'}  ${carId.padEnd(10)} est ${fmt(est)}  laps ${lapTimes.map(fmt).join(' ')}  vmax ${(maxSpeed * 3.6).toFixed(0)}  resets ${resets}  hits ${hits.length}${hits.length ? ' [' + hits.slice(0, 6).join(', ') + ']' : ''}  off ${offTrack.toFixed(1)}s`,
        );
        lines.push('      ' + track.corners.map((c, k) => `${c.name} ${(maxBefore[k] * 3.6).toFixed(0)}>${(minV[k] * 3.6).toFixed(0)}`).join('  '));
      }
    }
    mkdirSync('.cache', { recursive: true });
    writeFileSync(`.cache/laps-${id}.txt`, lines.join('\n') + '\n');
    console.info(lines.join('\n'));
  }, 900000);
});
