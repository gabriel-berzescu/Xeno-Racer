/**
 * A lone car round a circuit whose "driver" only steers along the line, with the throttle flat out all the way and the brake never
 * touched, and what the braking assist makes of it (shared by the probe tests/probes/brake-assist.test.ts and tests/aids.test.ts).
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { AIDriver } from '../../src/ai';
import { getCar } from '../../src/cars';
import { ASSIST_PRESETS, carAssists, type AssistPreset } from '../../src/core/aids';
import type { Difficulty, TrackFrame, TrackPoint } from '../../src/core/contracts';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { DriverAids } from '../../src/game/driveraids';
import { PhysicsWorld, SteeringFilter } from '../../src/physics';
import { loadTrackRuntime } from '../../src/track';

const DT = 1 / 60;

export interface AssistLap {
  /** each completed lap (s), the first from the standing start */
  lapTimes: number[];
  resets: number;
  walls: number;
  /** excursions of the car's centre past the asphalt edge that lasted 0.3 s or more, with the track distance where each began */
  offs: { s: number; seconds: number }[];
  /** seconds with the car's centre beyond the asphalt edge, and more than 0.8 m beyond it */
  off: number;
  far: number;
  worstHit: number;
  maxKmh: number;
  /** the share of the lap time the assist spent on the brakes, and the most it added */
  assistShare: number;
  assistMax: number;
  finished: boolean;
}

export interface AssistLapOptions {
  laps?: number;
  wetness?: number;
  aids?: AssistPreset;
  steer?: Difficulty;
  assist?: boolean;
  /** the AI works the pedals too (a baseline for the same circuit: how clean its own driving is by the same measures) */
  ai?: boolean;
  /**
   * who steers: the AI's path follower (default), or a pad: a stick that chases a point of the guide's line a little ahead, through the
   * steering filter a human's stick goes through (src/physics/steering.ts)
   */
  pad?: boolean;
  seed?: number;
  /** the share of the grip and of the brakes the line asks for (default: the guide's own) */
  gripUse?: number;
  brakeUse?: number;
  /** called after every step of the physics with what the car and the aids are doing (for tracing a stretch of road) */
  onFrame?: (f: AssistFrame) => void;
}

export interface AssistFrame {
  t: number;
  /** track distance (m), speed (km/h) and the line's speed there (km/h) */
  s: number;
  kmh: number;
  lineKmh: number;
  /** lateral offset of the car, the asphalt edge on its side, and the line's offset (m) */
  d: number;
  edge: number;
  lineD: number;
  /** the throttle and brake the car applied (the pad's and the assist's together), and the pedal the assist added */
  throttle: number;
  brake: number;
  added: number;
  gear: number;
  steer: number;
  frontSlip: number;
  absActive: boolean;
}

/** `laps` laps of `trackId` in `carId`, with a driver that only steers. */
export function assistedLaps(trackId: string, carId: string, o: AssistLapOptions = {}): AssistLap {
  const laps = o.laps ?? 2;
  const wetness = o.wetness ?? 0;
  const track = loadTrackRuntime(trackId);
  const def = getCar(carId);
  const world = new PhysicsWorld(track);
  world.wetness = wetness;
  const car = world.addVehicle(def);
  // (a pad that never shifts needs the automatic gearbox, whatever the preset says)
  const aidsSet = { ...ASSIST_PRESETS[o.aids ?? 'beginner'], autoShift: true, brakeAssist: o.assist !== false, line: 'full' as const };
  car.assists = carAssists(aidsSet);
  const slot = track.grid[0];
  car.placeOnGround(slot.position, slot.quaternion, 0);
  car.setTemperatures(1);
  const steer = new AIDriver(track, def, { difficulty: o.steer ?? 'alien', seed: o.seed ?? 1, wetness });
  const stick = new SteeringFilter();
  const aim = new Vector3();
  let stuck = 0;
  const aids = new DriverAids(track, def, { wetness, gripUse: o.gripUse, brakeUse: o.brakeUse });
  aids.setAssists(aidsSet);
  const frame: TrackFrame = { position: new Vector3(), tangent: new Vector3(), normal: new Vector3(), left: new Vector3(), widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, curvature: 0, bank: 0 };
  const tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
  let hint = track.project(car.p.x, car.p.z, tp, -1);
  let prevS = tp.s;
  let crossings = 0;
  let lapStart = 0;
  const res: AssistLap = { lapTimes: [], resets: 0, walls: 0, offs: [], off: 0, far: 0, worstHit: 0, maxKmh: 0, assistShare: 0, assistMax: 0, finished: false };
  let seen = car.state.impactCount;
  let offFor = 0;
  let offAt = 0;
  let assistTime = 0;
  const limit = 480 * (laps + 1);
  const c = car.controls;
  while (world.time < limit && res.lapTimes.length < laps) {
    // the driver: steers along the line (the AI's path follower, or a stick chasing the line), foot flat on the throttle, never on the brake
    if (o.pad) {
      const st = car.state;
      const sp = Math.max(1, st.speed);
      // pure pursuit: the wheel angle of the circle through the car and a point of the line a look-ahead away, as a share of the lock,
      // pushed on the stick as far as the steering filter will let it count (a driver pushes further where the filter eases the lock)
      const look = 6 + 0.35 * sp;
      const s2 = track.wrapS(tp.s + look);
      track.pointAt(s2, aids.guide.offsetAt(s2), aim);
      const q = st.quaternion;
      const dx = aim.x - st.position.x;
      const dz = aim.z - st.position.z;
      const fx = 2 * (q.x * q.z + q.w * q.y);
      const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
      const lx = 1 - 2 * (q.y * q.y + q.z * q.z);
      const lz = 2 * (q.x * q.z - q.w * q.y);
      const alpha = Math.atan2(dx * lx + dz * lz, dx * fx + dz * fz);
      const ch = def.physics.chassis;
      const wheel = Math.atan((2 * ch.wheelbase * Math.sin(alpha)) / Math.max(look, 1)) / ch.maxSteer;
      const gripAngle = (ch.wheelbase * def.physics.tireFront.mu * 9.81) / Math.max(sp * sp, 1) + def.physics.tireFront.peakSlipAngle * 1.35;
      const scale = 1 + (Math.min(1, gripAngle / ch.maxSteer) - 1) * DEFAULT_SETTINGS.controls.speedSensitivity;
      c.steer = stick.update(-Math.max(-1, Math.min(1, wheel / scale)), DT, st, def, DEFAULT_SETTINGS.controls);
      stuck = sp < 1.5 || Math.abs(tp.d) > Math.max(tp.widthLeft, tp.widthRight) + 4 ? stuck + DT : 0;
    } else steer.update(DT, car.state, world.states, c, true);
    if (o.pad ? stuck > 4 : steer.needsReset) {
      res.resets++;
      track.frameAt(track.wrapS(o.pad ? tp.s : steer.s), frame);
      const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(frame.left, frame.normal, frame.tangent));
      car.placeOnGround(frame.position, q, 0);
      steer.onReset();
      stick.reset();
      aids.assist.reset();
      stuck = 0;
    }
    if (!o.ai) {
      c.throttle = 1;
      c.brake = 0;
      c.handbrake = 0;
      aids.update(DT, car.state, c, true, wetness);
    }
    if (aids.added > 0.02) {
      assistTime += DT;
      res.assistMax = Math.max(res.assistMax, aids.added);
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
    const edge = tp.d >= 0 ? tp.widthLeft : tp.widthRight;
    const out = Math.abs(tp.d) - edge;
    if (out > 0) {
      res.off += DT;
      if (out > 0.8) res.far += DT;
      if (offFor === 0) offAt = tp.s;
      offFor += DT;
    } else {
      if (offFor >= 0.3) res.offs.push({ s: Math.round(offAt), seconds: +offFor.toFixed(1) });
      offFor = 0;
    }
    res.maxKmh = Math.max(res.maxKmh, st.speed * 3.6);
    if (tp.s - prevS < -track.length / 2) {
      crossings++;
      // (the first crossing is the start line: a lap runs from one crossing to the next)
      if (crossings >= 2) res.lapTimes.push(world.time - lapStart);
      lapStart = world.time;
    }
    prevS = tp.s;
    if (o.onFrame) {
      const edgeNow = tp.d >= 0 ? tp.widthLeft : tp.widthRight;
      o.onFrame({
        t: world.time,
        s: tp.s,
        kmh: st.speed * 3.6,
        lineKmh: aids.guide.targetAt(tp.s) * 3.6,
        d: tp.d,
        edge: edgeNow,
        lineD: aids.guide.offsetAt(tp.s),
        throttle: st.throttle,
        brake: st.brake,
        added: aids.added,
        gear: st.gear,
        steer: c.steer,
        frontSlip: Math.max(Math.abs(st.wheels[0].slipAngle), Math.abs(st.wheels[1].slipAngle)),
        absActive: st.absActive,
      });
    }
  }
  if (offFor >= 0.3) res.offs.push({ s: Math.round(offAt), seconds: +offFor.toFixed(1) });
  res.finished = res.lapTimes.length >= laps;
  res.assistShare = world.time > 0 ? assistTime / world.time : 0;
  return res;
}

const fmt = (x: number): string => {
  const c = Math.round(x * 100);
  return `${Math.floor(c / 6000)}:${((c % 6000) / 100).toFixed(2).padStart(5, '0')}`;
};

export function describeLap(label: string, r: AssistLap): string {
  const offs = r.offs.length ? ' @' + r.offs.map((x) => `${x.s}m/${x.seconds}s`).join(',') : '';
  return `${label.padEnd(34)} laps ${r.lapTimes.length} ${r.lapTimes.map(fmt).join(' ').padEnd(16)} offs ${r.offs.length}${offs}  off ${r.off.toFixed(1)}s far ${r.far.toFixed(1)}s  walls ${r.walls} (worst ${r.worstHit.toFixed(0)} m/s)  resets ${r.resets}  vmax ${r.maxKmh.toFixed(0)}  assist ${(r.assistShare * 100).toFixed(0)}% max ${r.assistMax.toFixed(2)}`;
}
