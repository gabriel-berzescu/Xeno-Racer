/**
 * Race replays: every car's visible state recorded at 30 Hz into flat float buffers, and played
 * back into stand-in VehicleStates that drive the normal car visuals, effects and sounds.
 */
import { Quaternion, Vector3 } from 'three';
import type { SurfaceType, VehicleState, WheelState } from '../core/contracts';

const SURFACES: SurfaceType[] = ['asphalt', 'curb', 'concrete', 'grass', 'gravel', 'sand', 'dirt'];
const HEAD = 24;
const WHEEL = 14;
export const REPLAY_STRIDE = HEAD + 4 * WHEEL;
const RATE = 30;
const MAX_SECONDS = 600;

export class ReplayRecorder {
  readonly cars: number;
  readonly data: Float32Array;
  frames = 0;
  private lastT = -Infinity;
  readonly t0: number;

  constructor(cars: number, t0: number) {
    this.cars = cars;
    this.t0 = t0;
    this.data = new Float32Array(MAX_SECONDS * RATE * cars * REPLAY_STRIDE + 1);
  }

  get duration(): number {
    return Math.max(0, (this.frames - 1) / RATE);
  }

  capture(t: number, states: readonly VehicleState[]): void {
    if (t - this.lastT < 1 / RATE - 1e-4) return;
    if ((this.frames + 1) * this.cars * REPLAY_STRIDE >= this.data.length) return;
    this.lastT = t;
    let o = this.frames * this.cars * REPLAY_STRIDE;
    const d = this.data;
    for (let c = 0; c < this.cars; c++) {
      const s = states[c];
      d[o] = s.position.x;
      d[o + 1] = s.position.y;
      d[o + 2] = s.position.z;
      d[o + 3] = s.quaternion.x;
      d[o + 4] = s.quaternion.y;
      d[o + 5] = s.quaternion.z;
      d[o + 6] = s.quaternion.w;
      d[o + 7] = s.velocity.x;
      d[o + 8] = s.velocity.y;
      d[o + 9] = s.velocity.z;
      d[o + 10] = s.rpm;
      d[o + 11] = s.throttle;
      d[o + 12] = s.brake;
      d[o + 13] = s.gear;
      d[o + 14] = s.steer;
      d[o + 15] = s.forwardSpeed;
      d[o + 16] = s.engineLoad;
      d[o + 17] = s.boost;
      d[o + 18] = s.shiftCount;
      d[o + 19] = s.backfireCount;
      d[o + 20] = s.impactCount;
      d[o + 21] = s.lastImpact.strength;
      d[o + 22] = s.scrape;
      d[o + 23] = (s.revLimiter ? 1 : 0) + (s.airborne ? 2 : 0);
      let w = o + HEAD;
      for (const wh of s.wheels) {
        d[w] = wh.hub.x;
        d[w + 1] = wh.hub.y;
        d[w + 2] = wh.hub.z;
        d[w + 3] = wh.contactPoint.x;
        d[w + 4] = wh.contactPoint.y;
        d[w + 5] = wh.contactPoint.z;
        d[w + 6] = wh.steerAngle;
        d[w + 7] = wh.spin;
        d[w + 8] = wh.compression;
        d[w + 9] = wh.skid;
        d[w + 10] = SURFACES.indexOf(wh.surface);
        d[w + 11] = wh.contact ? 1 : 0;
        d[w + 12] = wh.brakeTempC;
        d[w + 13] = wh.omega;
        w += WHEEL;
      }
      o += REPLAY_STRIDE;
    }
    this.frames++;
  }
}

const _qa = new Quaternion();
const _qb = new Quaternion();

/** Writes interpolated replay frames into persistent stand-in states. */
export class ReplayPlayer {
  readonly states: VehicleState[];

  constructor(
    readonly rec: ReplayRecorder,
    templates: readonly VehicleState[],
  ) {
    this.states = templates.map((t) => cloneState(t));
  }

  /** Apply time t (seconds from the start of the recording). */
  apply(t: number): void {
    const r = this.rec;
    const f = Math.max(0, Math.min(r.frames - 1.001, t * RATE));
    const i = Math.floor(f);
    const k = f - i;
    const d = r.data;
    for (let c = 0; c < r.cars; c++) {
      const a = (i * r.cars + c) * REPLAY_STRIDE;
      const b = ((i + 1) * r.cars + c) * REPLAY_STRIDE;
      const s = this.states[c];
      const L = (j: number) => d[a + j] + (d[b + j] - d[a + j]) * k;
      s.position.set(L(0), L(1), L(2));
      _qa.set(d[a + 3], d[a + 4], d[a + 5], d[a + 6]);
      _qb.set(d[b + 3], d[b + 4], d[b + 5], d[b + 6]);
      s.quaternion.slerpQuaternions(_qa, _qb, k);
      s.velocity.set(L(7), L(8), L(9));
      s.speed = s.velocity.length();
      s.rpm = L(10);
      s.throttle = L(11);
      s.brake = L(12);
      s.gear = Math.round(d[a + 13]);
      s.steer = L(14);
      s.forwardSpeed = L(15);
      s.engineLoad = L(16);
      s.boost = L(17);
      s.shiftCount = d[a + 18];
      s.backfireCount = d[a + 19];
      if (d[a + 20] !== s.impactCount) {
        s.impactCount = d[a + 20];
        s.lastImpact.strength = d[a + 21];
        s.lastImpact.point.copy(s.position);
      }
      s.scrape = L(22);
      s.scrapePoint.copy(s.position);
      s.revLimiter = (d[a + 23] & 1) === 1;
      s.airborne = (d[a + 23] & 2) === 2;
      for (let wi = 0; wi < 4; wi++) {
        const wa = a + HEAD + wi * WHEEL;
        const wb = b + HEAD + wi * WHEEL;
        const W = (j: number) => d[wa + j] + (d[wb + j] - d[wa + j]) * k;
        const wh = s.wheels[wi];
        wh.hub.set(W(0), W(1), W(2));
        wh.contactPoint.set(W(3), W(4), W(5));
        wh.steerAngle = W(6);
        wh.spin = W(7);
        wh.compression = W(8);
        wh.skid = W(9);
        wh.surface = SURFACES[d[wa + 10]] ?? 'asphalt';
        wh.contact = d[wa + 11] > 0.5;
        wh.brakeTempC = W(12);
        wh.omega = W(13);
      }
    }
  }
}

function cloneWheel(w: WheelState): WheelState {
  return { ...w, hub: w.hub.clone(), contactPoint: w.contactPoint.clone(), contactNormal: w.contactNormal.clone() };
}

function cloneState(s: VehicleState): VehicleState {
  return {
    ...s,
    position: s.position.clone(),
    quaternion: s.quaternion.clone(),
    velocity: s.velocity.clone(),
    angularVelocity: s.angularVelocity.clone(),
    localAccel: new Vector3(),
    lastImpact: { ...s.lastImpact, point: s.lastImpact.point.clone(), normal: s.lastImpact.normal.clone() },
    scrapePoint: s.scrapePoint.clone(),
    wheels: [cloneWheel(s.wheels[0]), cloneWheel(s.wheels[1]), cloneWheel(s.wheels[2]), cloneWheel(s.wheels[3])],
  };
}
