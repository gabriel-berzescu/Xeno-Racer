/**
 * A lone AI car lapping a circuit with mechanical damage on it (shared by the damage probes and tests): the lap times against a
 * sound car, the walls it touches, the time it spends off the road and the resets it needs.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { AIDriver } from '../../src/ai';
import { getCar } from '../../src/cars';
import type { Difficulty, TrackFrame, TrackPoint } from '../../src/core/contracts';
import type { MechEffects } from '../../src/core/mechanical';
import { PhysicsWorld } from '../../src/physics';
import { loadTrackRuntime } from '../../src/track';

const DT = 1 / 60;

export interface LapResult {
  /** each completed lap (s), the first from the standing start */
  lapTimes: number[];
  resets: number;
  /** wall hits (impacts that were not with the ground) */
  walls: number;
  /** seconds with the car well off the asphalt */
  off: number;
  /** the strongest wall hit (m/s) */
  worstHit: number;
  maxSpeedKmh: number;
}

export interface LapOptions {
  laps?: number;
  diff?: Difficulty;
  /** tell the AI about the damage (AIDriver.setDamage); false drives it as if it knew nothing */
  adapt?: boolean;
  /** wetness of the road */
  wetness?: number;
  seed?: number;
}

/** Laps `trackId` in `carId` with `fx` on the car from the start. */
export function damagedLaps(trackId: string, carId: string, fx: MechEffects | null, o: LapOptions = {}): LapResult {
  const laps = o.laps ?? 3;
  const track = loadTrackRuntime(trackId);
  const def = getCar(carId);
  const world = new PhysicsWorld(track);
  world.wetness = o.wetness ?? 0;
  const car = world.addVehicle(def);
  car.assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
  const slot = track.grid[0];
  car.placeOnGround(slot.position, slot.quaternion, 0);
  car.setTemperatures(1);
  const ai = new AIDriver(track, def, { difficulty: o.diff ?? 'alien', seed: o.seed ?? 1, wetness: o.wetness ?? 0 });
  if (fx) {
    car.setDamage(fx);
    if (o.adapt !== false) ai.setDamage(fx, 0);
  }
  const frame: TrackFrame = { position: new Vector3(), tangent: new Vector3(), normal: new Vector3(), left: new Vector3(), widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, curvature: 0, bank: 0 };
  const tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
  let hint = track.project(car.p.x, car.p.z, tp, -1);
  let prevS = tp.s;
  let crossings = 0;
  let lapStart = 0;
  const res: LapResult = { lapTimes: [], resets: 0, walls: 0, off: 0, worstHit: 0, maxSpeedKmh: 0 };
  let seen = car.state.impactCount;
  const limit = 400 * (laps + 1);
  while (world.time < limit && res.lapTimes.length < laps) {
    ai.update(DT, car.state, world.states, car.controls, true);
    if (ai.needsReset) {
      res.resets++;
      track.frameAt(track.wrapS(ai.s), frame);
      const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(frame.left, frame.normal, frame.tangent));
      car.placeOnGround(frame.position, q, 0);
      ai.onReset();
    }
    world.step(DT);
    const st = car.state;
    if (st.impactCount !== seen) {
      seen = st.impactCount;
      if (st.lastImpact.kind === 'wall') {
        res.walls++;
        res.worstHit = Math.max(res.worstHit, st.lastImpact.strength);
      }
    }
    hint = track.project(car.p.x, car.p.z, tp, hint);
    if (Math.abs(tp.d) > Math.max(tp.widthLeft, tp.widthRight) + 0.8) res.off += DT;
    res.maxSpeedKmh = Math.max(res.maxSpeedKmh, st.speed * 3.6);
    const ds = tp.s - prevS;
    if (ds < -track.length / 2) {
      crossings++;
      // (the first crossing is the start line: a lap runs from one crossing to the next)
      if (crossings >= 2) res.lapTimes.push(world.time - lapStart);
      lapStart = world.time;
    }
    prevS = tp.s;
  }
  return res;
}

export const fmtLap = (x: number): string => {
  const c = Math.round(x * 100);
  return `${Math.floor(c / 6000)}:${((c % 6000) / 100).toFixed(2).padStart(5, '0')}`;
};
