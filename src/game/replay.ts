/**
 * Race replays: every car's visible state recorded at 30 Hz into flat float buffers, and played
 * back into stand-in VehicleStates that drive the normal car visuals, effects and sounds.
 */
import { Quaternion, Vector3 } from 'three';
import type { ImpactKind, SurfaceType, VehicleState, WheelState } from '../core/contracts';
import type { DamageEvent, StampedEvent } from '../core/damage';

// (every surface, the winter ones too: a replay at Isvik had its wheels on asphalt, with the sound and the spray of asphalt)
const SURFACES: SurfaceType[] = ['asphalt', 'curb', 'concrete', 'grass', 'gravel', 'sand', 'dirt', 'snow', 'ice', 'deepsnow'];
const IMPACT_KINDS: ImpactKind[] = ['wall', 'car', 'ground'];
/**
 * Floats per car before the wheels. 0..23 the pose and the drivetrain; 24..30 the last impact (world point, normal, kind), 31..33
 * the scrape point: the sparks and the debris of a replay are thrown where the car really touched, not from its middle; 34 the
 * throttle pedal (a replayed upshift is not a lift for the blow-off valve); 35 the nitro burning (its flames).
 */
const HEAD = 36;
const WHEEL = 14;
export const REPLAY_STRIDE = HEAD + 4 * WHEEL;
const RATE = 30;
const MAX_SECONDS = 600;

export class ReplayRecorder {
  readonly cars: number;
  readonly data: Float32Array;
  /**
   * Each car's crash damage as it happened: the events the car's visual took, stamped with the replay frame they fall
   * after. Playback rebuilds the damage of any moment from these (CarDamage.syncTo), so it builds up as the replay
   * plays and a seek or a restart shows the damage of that moment, whatever the car looks like at the end.
   */
  readonly damage: StampedEvent[][];
  frames = 0;
  /**
   * Frames per second. The buffer holds MAX_SECONDS at RATE; when a long race fills it, every other frame is dropped
   * and recording goes on at half the rate, so the replay always runs from the start to the flag.
   */
  rate = RATE;
  private lastT = -Infinity;
  readonly t0: number;

  constructor(cars: number, t0: number) {
    this.cars = cars;
    this.t0 = t0;
    this.data = new Float32Array(MAX_SECONDS * RATE * cars * REPLAY_STRIDE + 1);
    this.damage = Array.from({ length: cars }, () => []);
  }

  /** A crash event of car `car`, happening now: between the last captured frame and the next one. */
  addDamage(car: number, e: DamageEvent): void {
    this.damage[car]?.push({ f: this.frames - 0.5, e });
  }

  get duration(): number {
    return Math.max(0, (this.frames - 1) / this.rate);
  }

  capture(t: number, states: readonly VehicleState[]): void {
    if (t - this.lastT < 1 / this.rate - 1e-4) return;
    if ((this.frames + 1) * this.cars * REPLAY_STRIDE >= this.data.length) this.halve();
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
      const li = s.lastImpact;
      d[o + 24] = li.point.x;
      d[o + 25] = li.point.y;
      d[o + 26] = li.point.z;
      d[o + 27] = li.normal.x;
      d[o + 28] = li.normal.y;
      d[o + 29] = li.normal.z;
      d[o + 30] = IMPACT_KINDS.indexOf(li.kind);
      d[o + 31] = s.scrapePoint.x;
      d[o + 32] = s.scrapePoint.y;
      d[o + 33] = s.scrapePoint.z;
      d[o + 34] = s.throttlePedal;
      d[o + 35] = s.nitro ?? 0;
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

  /** Keep every other frame (0, 2, 4...) and halve the rate; the damage timeline is stamped in frames, so it follows. */
  private halve(): void {
    const n = this.cars * REPLAY_STRIDE;
    const kept = Math.ceil(this.frames / 2);
    for (let k = 1; k < kept; k++) this.data.copyWithin(k * n, 2 * k * n, (2 * k + 1) * n);
    this.frames = kept;
    this.rate /= 2;
    for (const list of this.damage) for (const ev of list) ev.f /= 2;
  }
}

const _qa = new Quaternion();
const _qb = new Quaternion();

/** Writes interpolated replay frames into persistent stand-in states. */
export class ReplayPlayer {
  readonly states: VehicleState[];
  /** The (fractional) recorded frame the last apply() showed: what the damage timeline is read at. */
  frame = 0;

  constructor(
    readonly rec: ReplayRecorder,
    templates: readonly VehicleState[],
  ) {
    this.states = templates.map((t) => cloneState(t));
  }

  /** Apply time t (seconds from the start of the recording). */
  apply(t: number): void {
    const r = this.rec;
    const f = Math.max(0, Math.min(r.frames - 1.001, t * r.rate));
    this.frame = f;
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
      s.throttlePedal = L(34);
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
        s.lastImpact.point.set(d[a + 24], d[a + 25], d[a + 26]);
        s.lastImpact.normal.set(d[a + 27], d[a + 28], d[a + 29]);
        s.lastImpact.kind = IMPACT_KINDS[d[a + 30]] ?? 'wall';
      }
      s.scrape = L(22);
      s.scrapePoint.set(d[a + 31], d[a + 32], d[a + 33]);
      s.nitro = L(35);
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
  // (the suspension's velocity is not recorded: the stand-in carries none, not the one the template had when the replay began, which
  // the sound would have taken for a wheel hitting a kerb at that very moment, over and over, for the whole replay)
  return { ...w, hub: w.hub.clone(), contactPoint: w.contactPoint.clone(), contactNormal: w.contactNormal.clone(), suspensionVelocity: 0 };
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
