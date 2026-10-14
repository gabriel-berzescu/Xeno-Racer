/**
 * AI racing driver: follows the racing line with pure pursuit + slide correction, tracks the speed
 * profile with anticipation, overtakes by shifting its line, avoids running into cars it cannot
 * pass, and asks for a reset when stuck. Uses the same CarControls as the player.
 */
import { Vector3 } from 'three';
import type { CarControls, CarDefinition, Difficulty, TrackPoint, TrackRuntime, VehicleState } from '../core/contracts';
import { computeRacingLine, computeSpeedProfile, type RacingLine, type SpeedProfile } from './racing-line';

export interface Skill {
  gripUse: number;
  brakeUse: number;
  pace: number;
  /** Amplitude (m) of slow line wander. */
  wander: number;
}

export const SKILL: Record<Difficulty, Skill> = {
  rookie: { gripUse: 0.8, brakeUse: 0.72, pace: 0.95, wander: 0.55 },
  amateur: { gripUse: 0.86, brakeUse: 0.8, pace: 0.97, wander: 0.35 },
  pro: { gripUse: 0.92, brakeUse: 0.88, pace: 0.99, wander: 0.18 },
  alien: { gripUse: 0.965, brakeUse: 0.94, pace: 1, wander: 0.06 },
};

const _tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
const _f = new Vector3();
const _l = new Vector3();

export interface AIDriverOptions {
  difficulty: Difficulty;
  /** Per-driver variation seed. */
  seed: number;
}

export class AIDriver {
  readonly line: RacingLine;
  readonly profile: SpeedProfile;
  readonly skill: Skill;
  /** Set when the car is stuck or facing the wrong way; the game resets it to the track. */
  needsReset = false;
  /** Current track position (updated every update). */
  s = 0;
  d = 0;

  private hint = -1;
  private offset = 0;
  private stuckTime = 0;
  private wrongTime = 0;
  private wanderPhase: number;
  private readonly paceJitter: number;
  private readonly otherHints = new Map<number, number>();
  private readonly halfWidth: number;
  private time = 0;
  debug = '';
  private readonly up = new Vector3();

  constructor(
    readonly track: TrackRuntime,
    readonly def: CarDefinition,
    opts: AIDriverOptions,
  ) {
    const base = SKILL[opts.difficulty];
    const r = fract(Math.sin(opts.seed * 12.9898) * 43758.5453);
    this.paceJitter = 1 - 0.018 * r;
    this.wanderPhase = r * 100;
    this.skill = base;
    this.halfWidth = def.visual.width / 2;
    this.line = computeRacingLine(track, { edgeMargin: this.halfWidth - 0.25 });
    this.profile = computeSpeedProfile(track, this.line, def, { gripUse: base.gripUse, brakeUse: base.brakeUse });
  }

  /** Target speed at track position s (m/s), with this driver's pace. */
  targetSpeed(s: number): number {
    const line = this.line;
    const f = this.track.wrapS(s) / line.step;
    const i = Math.floor(f) % line.n;
    const b = (i + 1) % line.n;
    const t = f - Math.floor(f);
    return (this.profile.v[i] * (1 - t) + this.profile.v[b] * t) * this.skill.pace * this.paceJitter;
  }

  update(dt: number, me: VehicleState, others: readonly VehicleState[], c: CarControls, racing: boolean): void {
    const tr = this.track;
    const line = this.line;
    const def = this.def;
    this.time += dt;
    this.hint = tr.project(me.position.x, me.position.z, _tp, this.hint);
    const s = _tp.s;
    this.s = s;
    this.d = _tp.d;
    const v = Math.max(0, me.forwardSpeed);
    _f.set(0, 0, 1).applyQuaternion(me.quaternion);
    _l.set(1, 0, 0).applyQuaternion(me.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(me.quaternion);

    if (!racing) {
      // on the grid: hold revs, wheels straight
      c.steer = 0;
      c.throttle = 0.35 + 0.15 * Math.sin(this.time * 3 + this.wanderPhase);
      c.brake = 0;
      c.handbrake = 0;
      return;
    }

    // ── traffic: find the car we are about to hit, decide which side to pass ──
    let lineD = this.lineOffsetAt(s);
    let targetOffset = this.skill.wander * Math.sin(this.time * 0.35 + this.wanderPhase);
    let speedCap = Infinity;
    for (const o of others) {
      if (o.id === me.id) continue;
      const h = this.otherHints.get(o.id) ?? -1;
      this.otherHints.set(o.id, tr.project(o.position.x, o.position.z, _tp, h));
      let ds = _tp.s - s;
      if (ds > tr.length / 2) ds -= tr.length;
      if (ds < -tr.length / 2) ds += tr.length;
      if (ds <= 0 || ds > 40) continue;
      const theirD = _tp.d;
      const myPlannedD = lineD + this.offset;
      const closing = v - Math.max(0, o.forwardSpeed);
      if (Math.abs(theirD - myPlannedD) > 2.4 || (closing < 0.5 && ds > 12)) continue;
      // pass on the side with more room
      const roomLeft = _tp.widthLeft - (theirD + this.halfWidth * 2 + 0.6);
      const roomRight = _tp.widthRight + (theirD - this.halfWidth * 2 - 0.6);
      const side = roomLeft > roomRight ? 1 : -1;
      const room = Math.max(roomLeft, roomRight);
      if (room > 0.4) targetOffset = theirD + side * (this.halfWidth * 2 + 0.7) - lineD;
      else if (ds < 18) speedCap = Math.min(speedCap, Math.max(0, o.forwardSpeed - 0.5 + (ds - 8) * 0.25));
      if (ds < 7 && Math.abs(theirD - myPlannedD) < 1.9) speedCap = Math.min(speedCap, Math.max(0, o.forwardSpeed - 1));
    }
    const kOff = 1 - Math.exp(-dt * 1.6);
    this.offset += (targetOffset - this.offset) * kOff;

    // ── steering: pure pursuit from the rear axle toward a lookahead point on the (offset) line ──
    const L = def.physics.chassis.wheelbase;
    const b = L - def.physics.chassis.cgToFrontAxle;
    const look = Math.min(70, Math.max(8, 6 + 0.8 * v));
    const st = s + look;
    const tx = this.lineXAt(st, true);
    const tz = this.lineZ;
    const rx = me.position.x - _f.x * b;
    const rz = me.position.z - _f.z * b;
    const dx = tx - rx;
    const dz = tz - rz;
    const dist = Math.hypot(dx, dz) || 1;
    const xl = dx * _l.x + dz * _l.z;
    const zf = dx * _f.x + dz * _f.z;
    const alpha = Math.atan2(xl, zf);
    const kappa = (2 * Math.sin(alpha)) / dist;
    // kinematic angle + the slip angle the front tires need for this lateral acceleration
    const ph = def.physics;
    const aLat = v * v * kappa;
    const muG = 9.81 * ph.tireFront.mu;
    let delta = Math.atan(L * kappa) + ph.tireFront.peakSlipAngle * Math.max(-1.2, Math.min(1.2, aLat / muG)) * 0.85;
    // yaw-rate tracking: steer against yaw rate that differs from what the arc asks for
    const yawRate = me.angularVelocity.x * this.up.x + me.angularVelocity.y * this.up.y + me.angularVelocity.z * this.up.z;
    if (v > 6) delta += 0.2 * (kappa * v - yawRate);
    // slide correction: point the front wheels along the direction of travel
    const vel = me.velocity;
    const vLat = vel.x * _l.x + vel.z * _l.z;
    const vLong = vel.x * _f.x + vel.z * _f.z;
    if (vLong > 4) {
      const beta = Math.atan2(vLat, vLong);
      if (Math.abs(beta) > 0.04) delta += 0.55 * beta;
    }
    const maxSteer = def.physics.chassis.maxSteer;
    this.debug = `alpha=${alpha.toFixed(3)} dist=${dist.toFixed(1)} kap=${(kappa * 1000).toFixed(2)} yawErr=${(kappa * v - yawRate).toFixed(3)} delta=${delta.toFixed(3)} tgt=(${tx.toFixed(1)},${tz.toFixed(1)}) look=${look.toFixed(1)}`;
    c.steer = Math.max(-1, Math.min(1, -delta / maxSteer));
    c.handbrake = 0;

    // ── speed: track the profile slightly ahead; brake early for slower points ahead ──
    let vT = this.targetSpeed(s + v * 0.3 + 2);
    // anticipate: the slowest requirement within the next ~1.2 s, discounted by distance
    const brakeCap = 9.81 * Math.min(def.physics.tireFront.mu, def.physics.tireRear.mu) * this.skill.brakeUse * 0.9;
    for (let k = 1; k <= 6; k++) {
      const ahead = v * 0.2 * k + 4;
      const va = this.targetSpeed(s + ahead);
      const allowed = Math.sqrt(va * va + 2 * brakeCap * Math.max(0, ahead - v * 0.12));
      if (allowed < vT) vT = allowed;
    }
    if (speedCap < vT) vT = speedCap;
    // off the asphalt: back off a bit
    if (Math.abs(_tp.d) > Math.max(_tp.widthLeft, _tp.widthRight) + 0.5) vT *= 0.8;
    const e = vT - v;
    if (e >= 0) {
      c.throttle = Math.min(1, 0.3 + 0.35 * e);
      c.brake = 0;
    } else {
      c.throttle = Math.max(0, 0.3 + 0.35 * e);
      c.brake = e < -0.8 ? Math.min(1, (-e - 0.8) * 0.22) : 0;
    }
    // big slide: ease off
    let slip = 0;
    for (const w of me.wheels) slip = Math.max(slip, Math.abs(w.slipAngle));
    if (slip > 0.25) c.throttle *= 0.5;

    // ── stuck / wrong-way detection ──
    const tangentDot = _f.x * _tp.tx + _f.z * _tp.tz;
    if (v < 1.5) this.stuckTime += dt;
    else this.stuckTime = 0;
    if (tangentDot < -0.2 && v < 10) this.wrongTime += dt;
    else this.wrongTime = 0;
    if (this.stuckTime > 3 || this.wrongTime > 2.5) this.needsReset = true;
  }

  /** Called by the game after it resets the car to the track. */
  onReset(): void {
    this.needsReset = false;
    this.stuckTime = 0;
    this.wrongTime = 0;
    this.offset = 0;
    this.hint = -1;
  }

  // ── line sampling helpers ──────────────────────────────────────────────────
  private lineZ = 0;
  /** X of the line point at s (with the current overtaking offset when `withOffset`); Z → this.lineZ. */
  private lineXAt(s: number, withOffset: boolean): number {
    const line = this.line;
    const f = this.track.wrapS(s) / line.step;
    const i = Math.floor(f) % line.n;
    const b = (i + 1) % line.n;
    const t = f - Math.floor(f);
    let x = line.x[i] * (1 - t) + line.x[b] * t;
    let z = line.z[i] * (1 - t) + line.z[b] * t;
    if (withOffset && this.offset !== 0) {
      const tr = this.track;
      const j = Math.min(tr.count - 1, Math.round(this.track.wrapS(s) / tr.spacing));
      // keep the offset line within the asphalt
      const d0 = line.d[i] * (1 - t) + line.d[b] * t;
      const hi = tr.widthLeft[j] - this.halfWidth + 0.2;
      const lo = -(tr.widthRight[j] - this.halfWidth + 0.2);
      const dd = Math.max(lo, Math.min(hi, d0 + this.offset)) - d0;
      x += tr.lx[j] * dd;
      z += tr.lz[j] * dd;
    }
    this.lineZ = z;
    return x;
  }

  private lineOffsetAt(s: number): number {
    const line = this.line;
    const f = this.track.wrapS(s) / line.step;
    const i = Math.floor(f) % line.n;
    const b = (i + 1) % line.n;
    const t = f - Math.floor(f);
    return line.d[i] * (1 - t) + line.d[b] * t;
  }
}

function fract(x: number): number {
  return x - Math.floor(x);
}
