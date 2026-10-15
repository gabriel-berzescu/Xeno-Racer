/**
 * AI racing driver. Uses the same CarControls as the player.
 *
 * - Steering: path tracking on the racing line (curvature feedforward + lateral / heading feedback
 *   over a speed-dependent preview), with yaw-rate damping and countersteer for real slides.
 * - Speed: the line's speed profile with anticipation, corrected for driving off the line.
 * - Traffic: plans a lateral offset from the racing line around nearby cars — gives room to cars
 *   alongside, commits to a passing side, follows at a time gap when there's no way by.
 * - Asks for a reset when stuck or facing the wrong way.
 */
import { Vector3 } from 'three';
import type { CarControls, CarDefinition, Difficulty, TrackPoint, TrackRuntime, VehicleState } from '../core/contracts';
import { SURFACES, wetGripFactor } from '../physics/surfaces';
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
  /** Water on the track (0..1): slower corners, earlier braking, wheels kept off the kerbs. */
  wetness?: number;
}

export class AIDriver {
  readonly line: RacingLine;
  readonly profile: SpeedProfile;
  readonly skill: Skill;
  /** Set when the car is stuck or facing the wrong way; the game resets it to the track. */
  needsReset = false;
  /** Current track position (updated every update). */
  s = 0;
  /** Asphalt grip factor for the weather (1 when dry). */
  private readonly wetMu: number;
  d = 0;

  private hint = -1;
  private offset = 0;
  private prevOffset: number | null = null;
  private stuckTime = 0;
  private wrongTime = 0;
  private wanderPhase: number;
  private readonly paceJitter: number;
  private readonly halfWidth: number;
  private time = 0;
  debug = '';
  /** Traffic planner state for probes. */
  get debugTraffic(): string {
    return `off=${this.offset.toFixed(2)} plan=${this.planTarget.toFixed(2)} env=[${this.envLo.toFixed(1)},${this.envHi.toFixed(1)}] ${this.dbgPlan}`;
  }
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
    const wet = opts.wetness ?? 0;
    // in the wet, painted kerbs are ice: keep the wheels on the asphalt
    this.line = computeRacingLine(track, { edgeMargin: this.halfWidth - 0.25 + (wet > 0 ? 0.45 : 0) });
    this.profile = computeSpeedProfile(track, this.line, def, { gripUse: base.gripUse, brakeUse: base.brakeUse, wetness: wet });
    const tireWet = Math.min(def.physics.tireFront.wetGrip ?? 0.72, def.physics.tireRear.wetGrip ?? 0.72);
    this.wetMu = wetGripFactor(wet, tireWet, SURFACES.asphalt, 0);
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

    // ── traffic: plan a lateral offset (relative to the racing line) around the cars nearby ──
    const lineD = this.lineOffsetAt(s);
    const myOff = _tp.d - lineD;
    const myWL = _tp.widthLeft;
    const myWR = _tp.widthRight;
    const myD = _tp.d;
    const myTx = _tp.tx;
    const myTz = _tp.tz;
    const wander = this.skill.wander * Math.sin(this.time * 0.35 + this.wanderPhase);
    this.offsetEnvelope(s, v);
    const speedCap = this.planTraffic(s, v, myOff, wander, me, others);
    // move the offset toward the plan: low-pass, then a lateral rate limit
    const kOff = 1 - Math.exp(-dt * 2.2);
    const want = this.offset + (this.planTarget - this.offset) * kOff;
    const rate = (1.2 + 0.05 * v) * dt;
    this.offset += Math.max(-rate, Math.min(rate, want - this.offset));

    // ── steering: path following on the (offset) racing line ──
    // Curvature feedforward from the line just ahead, plus feedback on lateral and course error
    // over a preview distance (a linearised pure pursuit that doesn't cut the inside of corners).
    const L = def.physics.chassis.wheelbase;
    const halfW = this.halfWidth;
    const dDes = lineD + Math.max(this.envLo, Math.min(this.envHi, this.offset));
    const ey = myD - dDes; // + = left of the planned path
    const fl = tr.wrapS(s) / line.step;
    const li = Math.floor(fl) % line.n;
    const lb = (li + 1) % line.n;
    let ptx = line.x[lb] - line.x[li];
    let ptz = line.z[lb] - line.z[li];
    const pl = Math.hypot(ptx, ptz) || 1;
    ptx /= pl;
    ptz /= pl;
    // body heading (not the course): a rotating car then sees its own yaw and countersteers,
    // which is what keeps a sliding RWD car stable
    const vel = me.velocity;
    const cx = _f.x;
    const cz = _f.z;
    // signed angle of the heading relative to the path (+ = pointing left), minus the planned drift
    // planned lateral drift: rate of the effective (edge-clamped) offset
    const offEff = dDes - lineD;
    const offVel = this.prevOffset === null ? 0 : (offEff - this.prevOffset) / Math.max(dt, 1e-3);
    this.prevOffset = offEff;
    // a turning car's nose points outward of its travel by the kinematic body slip (rear axle
    // tracks inside): add it back so a hairpin doesn't read as a heading error
    const yawRate = me.angularVelocity.x * this.up.x + me.angularVelocity.y * this.up.y + me.angularVelocity.z * this.up.z;
    const bRear = L - def.physics.chassis.cgToFrontAxle;
    const betaKin = Math.atan((bRear * yawRate) / Math.max(v, 5));
    const epsi = Math.atan2(cx * ptz - cz * ptx, cx * ptx + cz * ptz) + betaKin - Math.atan(offVel / Math.max(v, 5));
    // feedforward: mean line curvature over the next ~0.15 s, corrected for the lateral offset
    let kff = 0;
    for (let k = 1; k <= 3; k++) {
      const fi = Math.floor(tr.wrapS(s + v * 0.05 * k) / line.step) % line.n;
      kff += line.k[fi];
    }
    kff /= 3;
    kff /= Math.max(0.5, 1 - kff * offEff);
    const Lp = 7 + 0.5 * v;
    const kappa = kff - (2 * ey) / (Lp * Lp) - (2 * Math.sin(epsi)) / Lp;
    // kinematic angle + the slip angle the front tires need for this lateral acceleration
    const ph = def.physics;
    const aLat = v * v * kappa;
    const muG = 9.81 * ph.tireFront.mu * this.wetMu;
    let delta = Math.atan(L * kappa) + ph.tireFront.peakSlipAngle * Math.max(-1.2, Math.min(1.2, aLat / muG)) * 0.85;
    // yaw-rate tracking: steer against yaw rate that differs from what the path asks for
    // (gentler at hairpin speeds, where the loop through the tires would otherwise ring)
    if (v > 4) delta += (0.08 + 0.12 * Math.min(1, Math.max(0, (v - 8) / 14))) * (kappa * v - yawRate);
    // slide correction: point the front wheels along the direction of travel
    const vLat = vel.x * _l.x + vel.z * _l.z;
    const vLong = vel.x * _f.x + vel.z * _f.z;
    if (vLong > 4) {
      // only the slip beyond the kinematic body slip of a car turning at this yaw rate is a slide
      // (in a hairpin the rear axle tracks inside, so the CG velocity points in without sliding)
      const beta = Math.atan2(vLat, vLong) - Math.atan((bRear * yawRate) / vLong);
      if (Math.abs(beta) > 0.04) delta += 0.55 * (beta - 0.04 * Math.sign(beta));
    }
    const maxSteer = def.physics.chassis.maxSteer;
    this.debug = `lineD=${lineD.toFixed(2)} dDes=${dDes.toFixed(2)} ey=${ey.toFixed(2)} epsi=${epsi.toFixed(3)} kff=${(kff * 1000).toFixed(2)} kap=${(kappa * 1000).toFixed(2)} yawErr=${(kappa * v - yawRate).toFixed(3)} delta=${delta.toFixed(3)} Lp=${Lp.toFixed(1)}`;
    c.steer = Math.max(-1, Math.min(1, -delta / maxSteer));
    c.handbrake = 0;

    // ── speed: track the profile slightly ahead; brake early for slower points ahead ──
    let vT = this.targetSpeedOff(s + v * 0.3 + 2, this.offset);
    // anticipate: the slowest requirement within the next ~1.2 s, discounted by distance
    const brakeCap = 9.81 * Math.min(def.physics.tireFront.mu, def.physics.tireRear.mu) * this.wetMu * this.skill.brakeUse * 0.9;
    for (let k = 1; k <= 6; k++) {
      const ahead = v * 0.2 * k + 4;
      const va = this.targetSpeedOff(s + ahead, this.offset);
      const allowed = Math.sqrt(va * va + 2 * brakeCap * Math.max(0, ahead - v * 0.12));
      if (allowed < vT) vT = allowed;
    }
    if (speedCap < vT) vT = speedCap;
    // off the asphalt: back off a bit
    if (myD > myWL + 0.5 || myD < -myWR - 0.5) vT *= 0.8;
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
    const tangentDot = _f.x * myTx + _f.z * myTz;
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
    this.prevOffset = null;
    this.planTarget = 0;
    this.hint = -1;
  }

  /** Target speed at s when driving `off` meters beside the racing line: tighter radius on the inside. */
  private targetSpeedOff(s: number, off: number): number {
    const v = this.targetSpeed(s);
    if (Math.abs(off) < 0.05) return v;
    const line = this.line;
    const i = Math.floor(this.track.wrapS(s) / line.step) % line.n;
    const k = line.k[i];
    const kd = k * off;
    // inside: a parallel path has a tighter radius; outside: the path gets pinched against the
    // track edge at entry and exit, which costs nearly as much
    let scale = Math.sqrt(Math.max(0.5, 1 - (kd > 0 ? kd : -0.7 * kd)));
    scale *= 1 - 0.012 * Math.min(4, Math.abs(off)) * Math.min(1, Math.abs(k) * 60);
    return v * scale;
  }

  /**
   * Lateral planning in "offset from the racing line" space. Cars alongside are hard limits (never
   * steer into a car beside you); cars ahead that we would reach soon are blocked intervals, and
   * we pick the free offset closest to the preferred one, with hysteresis so the choice of side
   * doesn't flicker. Returns a speed cap for following when there is no gap.
   */
  private planTarget = 0;
  private dbgPlan = '';
  /** Per-car tracking of the others: projection hint, last offset, lateral rate, committed pass side. */
  private readonly others = new Map<number, { hint: number; off: number; rate: number; t: number; side: number }>();
  private readonly obLo = new Float64Array(16);
  private readonly obHi = new Float64Array(16);
  private readonly obGap = new Float64Array(16);
  private readonly obV = new Float64Array(16);
  private readonly obTtc = new Float64Array(16);
  private readonly obId = new Int32Array(16);
  private readonly obRoomLo = new Float64Array(16);
  private readonly obRoomHi = new Float64Array(16);
  private envLo = 0;
  private envHi = 0;
  /**
   * Offsets (from the racing line) that keep the car on the asphalt over the preview distance.
   * Edge limits further ahead are relaxed by a slope, so an offset path blends into the edge
   * gradually instead of being clipped with a kink. Sets envLo / envHi.
   */
  private offsetEnvelope(s: number, v: number): void {
    const tr = this.track;
    const halfW = this.halfWidth;
    const W = 10 + 1.0 * v;
    let lo = -Infinity;
    let hi = Infinity;
    for (let x = 0; x <= W; x += 4) {
      const sa = tr.wrapS(s + x);
      const j = Math.min(tr.count - 1, Math.round(sa / tr.spacing));
      const ld = this.lineOffsetAt(sa);
      const slack = 0.05 * x;
      hi = Math.min(hi, Math.max(0, tr.widthLeft[j] - halfW + 0.2 - ld) + slack);
      lo = Math.max(lo, Math.min(0, -(tr.widthRight[j] - halfW + 0.2) - ld) - slack);
    }
    this.envLo = lo;
    this.envHi = hi;
  }

  /** Tightest offset limits (no slack) over [s, s + dist]: the room a pass actually has. */
  private roomLo = 0;
  private roomHi = 0;
  private strictRoom(s: number, dist: number): void {
    const tr = this.track;
    const halfW = this.halfWidth;
    let lo = -Infinity;
    let hi = Infinity;
    for (let x = 0; x <= dist; x += 4) {
      const sa = tr.wrapS(s + x);
      const j = Math.min(tr.count - 1, Math.round(sa / tr.spacing));
      const ld = this.lineOffsetAt(sa);
      hi = Math.min(hi, Math.max(0, tr.widthLeft[j] - halfW + 0.2 - ld));
      lo = Math.max(lo, Math.min(0, -(tr.widthRight[j] - halfW + 0.2) - ld));
    }
    this.roomLo = lo;
    this.roomHi = hi;
  }

  private planTraffic(s: number, v: number, myOff: number, wander: number, me: VehicleState, others: readonly VehicleState[]): number {
    const tr = this.track;
    const halfW = this.halfWidth;
    const len = this.def.visual.length;
    const sep = 2 * halfW + 0.6;
    const offLo = this.envLo;
    const offHi = this.envHi;
    let sideLo = offLo;
    let sideHi = offHi;
    let alongsideAheadV = Infinity;
    let alongsideLevelV = Infinity;
    let nOb = 0;
    for (const o of others) {
      if (o.id === me.id) continue;
      let rec = this.others.get(o.id);
      if (!rec) {
        rec = { hint: -1, off: 0, rate: 0, t: -1, side: 0 };
        this.others.set(o.id, rec);
      }
      rec.hint = tr.project(o.position.x, o.position.z, _tp, rec.hint);
      let ds = _tp.s - s;
      if (ds > tr.length / 2) ds -= tr.length;
      if (ds < -tr.length / 2) ds += tr.length;
      const oOff = _tp.d - this.lineOffsetAt(_tp.s);
      // lateral rate of the other car relative to the line (smoothed)
      const tdt = this.time - rec.t;
      if (rec.t >= 0 && tdt > 0 && tdt < 0.2) rec.rate += ((oOff - rec.off) / tdt - rec.rate) * Math.min(1, tdt * 8);
      else rec.rate = 0;
      rec.off = oOff;
      rec.t = this.time;
      if (ds < -(len + 12) || ds > 90) {
        rec.side = 0;
        continue;
      }
      const vO = o.velocity.x * _tp.tx + o.velocity.z * _tp.tz;
      // alongside (overlapping), or about to be: a faster car right behind gets its space too
      const behindReach = len + 0.6 + Math.max(0, vO - v) * 0.7;
      if ((ds >= 0 && ds < len + 0.6) || (ds < 0 && ds > -behindReach)) {
        if (Math.abs(oOff - myOff) < sep * 0.8 && ds < -len * 0.7) continue; // directly behind us: their problem
        if (oOff >= myOff) sideHi = Math.min(sideHi, oOff - sep);
        else sideLo = Math.max(sideLo, oOff + sep);
        if (ds > 0) alongsideAheadV = Math.min(alongsideAheadV, vO);
        if (ds > -len * 0.6) alongsideLevelV = Math.min(alongsideLevelV, vO);
        continue;
      }
      if (ds < 0) {
        rec.side = 0;
        continue;
      }
      if (nOb >= 16) continue;
      const gap = ds - len;
      const closing = v - vO;
      const ttc = closing > 0.05 ? gap / closing : Infinity;
      if (ttc > 3.5 && gap > 4 + v * 0.5) {
        rec.side = 0;
        continue;
      }
      // where it will be when we get there (its lateral drift, up to a second ahead)
      const pred = oOff + rec.rate * Math.min(1, ttc);
      this.obLo[nOb] = Math.min(oOff, pred) - sep;
      this.obHi[nOb] = Math.max(oOff, pred) + sep;
      this.obGap[nOb] = gap;
      this.obV[nOb] = vO;
      this.obTtc[nOb] = ttc;
      this.obId[nOb] = o.id;
      // the room we'd have to get alongside: from here until we overlap it (once alongside, the
      // alongside rules make it leave room, which is how an inside pass under braking works)
      this.strictRoom(s, Math.min(100, gap + len));
      this.obRoomLo[nOb] = this.roomLo;
      this.obRoomHi[nOb] = this.roomHi;
      nOb++;
    }

    let cap = Infinity;
    const lo = sideLo;
    const hi = sideHi;
    const prev = this.planTarget;
    if (lo > hi) {
      // squeezed between cars (or a car and the track edge): hold the lane; the car behind yields,
      // and so does a car pinned against the edge unless it is clearly ahead
      this.planTarget = Math.max(offLo, Math.min(offHi, myOff));
      if (alongsideAheadV < Infinity) cap = Math.max(0, alongsideAheadV - 2);
      const pinned = hi === offHi || lo === offLo;
      if (pinned && alongsideLevelV < Infinity) cap = Math.min(cap, Math.max(0, alongsideLevelV - 3));
    } else {
      const pref = Math.max(lo, Math.min(hi, wander));
      let best = NaN;
      let bestCost = Infinity;
      const tryCand = (c: number) => {
        if (c < lo - 1e-6 || c > hi + 1e-6) return;
        let cost = Math.abs(c - pref) + 0.8 * Math.abs(c - prev);
        for (let k = 0; k < nOb; k++) {
          const oLo = this.obLo[k];
          const oHi = this.obHi[k];
          if (c > oLo && c < oHi) return;
          const oC = (oLo + oHi) / 2;
          const gap = this.obGap[k];
          if (Math.abs(myOff - oC) < sep * 0.5) {
            // right behind it: pulling out either way is fine unless we are about to touch
            if (gap < 1.5 + v * 0.12) return;
          } else if ((myOff - oC) * (c - oC) < 0 && gap < 6 + v * 0.5) {
            // switching to its other side means cutting across its lane: only well behind it
            return;
          }
          // the pass must fit beside it all the way through the passing zone
          const side = c >= oHi ? 1 : -1;
          if (side > 0 ? this.obRoomHi[k] < oHi + 0.05 : this.obRoomLo[k] > oLo - 0.05) {
            if (this.obTtc[k] < 3 || this.obGap[k] < 4 + v * 0.5) return;
          }
          // stick to the side we committed to for this car
          const committed = this.others.get(this.obId[k])!.side;
          if (committed !== 0 && committed !== side) cost += 3;
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = c;
        }
      };
      tryCand(pref);
      tryCand(Math.max(lo, Math.min(hi, prev)));
      for (let k = 0; k < nOb; k++) {
        // aim a little clear of the blocked band (it already includes a safety margin), so small
        // drifts of the other car don't flip us back to following; fall back to the band edge
        tryCand(Math.max(lo, this.obLo[k] - 0.35));
        tryCand(Math.min(hi, this.obHi[k] + 0.35));
        tryCand(this.obLo[k] - 0.05);
        tryCand(this.obHi[k] + 0.05);
      }
      this.planTarget = Number.isNaN(best) ? Math.max(lo, Math.min(hi, myOff)) : best;
      // remember which side we are passing each car on
      for (let k = 0; k < nOb; k++) {
        const rec = this.others.get(this.obId[k])!;
        if (this.planTarget >= this.obHi[k]) rec.side = 1;
        else if (this.planTarget <= this.obLo[k]) rec.side = -1;
      }
    }
    // follow anything still in our path (current offset or planned one)
    const target = this.planTarget;
    let dbg = `side=[${lo.toFixed(1)},${hi.toFixed(1)}] ob=`;
    for (let k = 0; k < nOb; k++) dbg += `(${this.obLo[k].toFixed(1)}..${this.obHi[k].toFixed(1)} g${this.obGap[k].toFixed(0)} room${this.obRoomLo[k].toFixed(1)}/${this.obRoomHi[k].toFixed(1)} side${this.others.get(this.obId[k])!.side})`;
    this.dbgPlan = dbg;
    for (let k = 0; k < nOb; k++) {
      const tk = Math.max(this.obRoomLo[k], Math.min(this.obRoomHi[k], target));
      // (a quarter metre of the safety margin may be used before we count as being in its path)
      const inPath = (myOff > this.obLo[k] + 0.25 && myOff < this.obHi[k] - 0.25) || (tk > this.obLo[k] && tk < this.obHi[k]);
      if (!inPath) continue;
      const vO = this.obV[k];
      const desired = 2.5 + 0.3 * Math.max(0, vO);
      let c = vO + (this.obGap[k] - desired) * 0.9;
      if (this.obTtc[k] < 0.8) c = Math.min(c, vO - 1);
      cap = Math.min(cap, Math.max(0, c));
    }
    this.dbgPlan += ` cap=${cap === Infinity ? "-" : (cap * 3.6).toFixed(0)}`;
    return cap;
  }

  // ── line sampling helpers ──────────────────────────────────────────────────
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
