/**
 * Fixed-rate physics world: steps every vehicle at `hz`, resolves car-to-car contacts, computes
 * slipstream, and publishes interpolated VehicleStates once per rendered frame.
 */
import { Quaternion, Vector3 } from 'three';
import type { CarDefinition, TrackRuntime, VehicleState } from '../core/contracts';
import { fitCar } from './compound';
import { Vehicle } from './vehicle';

const _d = new Vector3();
const _n = new Vector3();
const _pc = new Vector3();
const _ra = new Vector3();
const _rb = new Vector3();
const _va = new Vector3();
const _vb = new Vector3();
const _t1 = new Vector3();
const _t2 = new Vector3();
const _fa = new Vector3();
const _la = new Vector3();
const _fb = new Vector3();
const _lb = new Vector3();
const _ca = new Vector3();
const _cb = new Vector3();
const _corner = new Vector3();

export interface PhysicsWorldOptions {
  /** Substep rate (Hz). Default 1000. */
  hz?: number;
  /** Max substeps per frame before time is dropped (spiral-of-death guard). */
  maxSubsteps?: number;
}

export class PhysicsWorld {
  readonly hz: number;
  readonly dt: number;
  readonly vehicles: Vehicle[] = [];
  /** Simulated time (s). */
  time = 0;
  /** Set to pause the simulation (states keep publishing). */
  paused = false;
  private acc = 0;
  private readonly maxSub: number;
  private nextId = 0;
  /** Car-to-car contacts this frame (for debugging/tests). */
  carContacts = 0;
  private wet = 0;

  /** Water on the track, 0 (dry) .. 1 (standing water): applies to every car, present and future. */
  get wetness(): number {
    return this.wet;
  }
  set wetness(w: number) {
    this.wet = Math.min(1, Math.max(0, w));
    for (const v of this.vehicles) v.wetness = this.wet;
  }

  constructor(
    readonly track: TrackRuntime,
    opts: PhysicsWorldOptions = {},
  ) {
    this.hz = opts.hz ?? 1000;
    this.dt = 1 / this.hz;
    this.maxSub = opts.maxSubsteps ?? Math.ceil(this.hz / 15);
  }

  addVehicle(def: CarDefinition): Vehicle {
    // (a winter circuit puts every car on studded winter tyres; the car itself is returned on a road circuit)
    const v = new Vehicle(this.nextId++, fitCar(def, this.track), this.track);
    v.wetness = this.wet;
    this.vehicles.push(v);
    return v;
  }

  removeVehicle(v: Vehicle): void {
    const i = this.vehicles.indexOf(v);
    if (i >= 0) this.vehicles.splice(i, 1);
  }

  get states(): VehicleState[] {
    return this.vehicles.map((v) => v.state);
  }

  /** Advance by a frame's worth of real time. */
  step(frameDt: number): void {
    const vs = this.vehicles;
    const fdt = Math.min(Math.max(frameDt, 0), 0.1);
    if (this.paused) {
      for (const v of vs) v.publish(1, 0);
      return;
    }
    for (const v of vs) v.beginFrame(fdt);
    this.computeSlipstream();
    this.acc += fdt;
    let n = 0;
    this.carContacts = 0;
    while (this.acc >= this.dt && n < this.maxSub) {
      for (const v of vs) v.substep(this.dt);
      if (vs.length > 1) this.collideCars();
      this.acc -= this.dt;
      this.time += this.dt;
      n++;
    }
    if (n >= this.maxSub) this.acc = 0;
    const alpha = this.acc / this.dt;
    for (const v of vs) v.publish(alpha, fdt);
  }

  /** Run exactly `seconds` of simulation as fast as possible (tests, headless AI). */
  simulate(seconds: number, onFrame?: (t: number) => void, frameDt = 1 / 60): void {
    const frames = Math.round(seconds / frameDt);
    for (let i = 0; i < frames; i++) {
      onFrame?.(this.time);
      this.step(frameDt);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────

  /** Drag reduction behind another car, mild downforce loss in its wake. */
  private computeSlipstream(): void {
    const vs = this.vehicles;
    for (const a of vs) {
      a.dragMul = 1;
      a.downforceMul = 1;
      const sa = a.state;
      if (sa.forwardSpeed < 15) continue;
      _fa.set(0, 0, 1).applyQuaternion(sa.quaternion);
      _la.set(1, 0, 0).applyQuaternion(sa.quaternion);
      let best = 0;
      for (const b of vs) {
        if (b === a) continue;
        _d.subVectors(b.state.position, sa.position);
        const ahead = _d.dot(_fa);
        if (ahead < 3 || ahead > 45) continue;
        const lat = Math.abs(_d.dot(_la));
        if (lat > 2.6) continue;
        const k = (1 - ahead / 45) * (1 - lat / 2.6);
        if (k > best) best = k;
      }
      a.dragMul = 1 - 0.38 * best;
      a.downforceMul = 1 - 0.22 * best;
    }
  }

  /** Oriented-box contacts in the ground plane between every pair of cars. */
  private collideCars(): void {
    const vs = this.vehicles;
    for (let i = 0; i < vs.length; i++) {
      for (let j = i + 1; j < vs.length; j++) this.collidePair(vs[i], vs[j]);
    }
  }

  private collidePair(A: Vehicle, B: Vehicle): void {
    const ha = A.spec.chassis.hullHalf;
    const hb = B.spec.chassis.hullHalf;
    const oa = A.spec.chassis.hullOffset;
    const ob = B.spec.chassis.hullOffset;
    _ca.set(oa.x, oa.y, oa.z).applyQuaternion(A.q).add(A.p);
    _cb.set(ob.x, ob.y, ob.z).applyQuaternion(B.q).add(B.p);
    const ra = Math.hypot(ha.x, ha.z);
    const rb = Math.hypot(hb.x, hb.z);
    const dx = _cb.x - _ca.x;
    const dz = _cb.z - _ca.z;
    if (dx * dx + dz * dz > (ra + rb) * (ra + rb)) return;
    if (Math.abs(_cb.y - _ca.y) > ha.y + hb.y) return;

    // horizontal axes of both boxes
    _fa.set(0, 0, 1).applyQuaternion(A.q);
    _fa.y = 0;
    _fa.normalize();
    _la.set(_fa.z, 0, -_fa.x);
    _fb.set(0, 0, 1).applyQuaternion(B.q);
    _fb.y = 0;
    _fb.normalize();
    _lb.set(_fb.z, 0, -_fb.x);

    // SAT over 4 axes
    let minOverlap = Infinity;
    let axisIdx = -1;
    const axes = [_fa, _la, _fb, _lb];
    for (let k = 0; k < 4; k++) {
      const ax = axes[k];
      const projA = ha.z * Math.abs(ax.dot(_fa)) + ha.x * Math.abs(ax.dot(_la));
      const projB = hb.z * Math.abs(ax.dot(_fb)) + hb.x * Math.abs(ax.dot(_lb));
      const dist = Math.abs(dx * ax.x + dz * ax.z);
      const overlap = projA + projB - dist;
      if (overlap <= 0) return;
      if (overlap < minOverlap) {
        minOverlap = overlap;
        axisIdx = k;
      }
    }
    // normal from A to B
    _n.copy(axes[axisIdx]);
    if (dx * _n.x + dz * _n.z < 0) _n.negate();

    // contact point: deepest corner of the incident box
    let best = Infinity;
    if (axisIdx < 2) {
      // A's face: B's corner furthest against n
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          _corner.copy(_cb).addScaledVector(_fb, sz * hb.z).addScaledVector(_lb, sx * hb.x);
          const d = _corner.x * _n.x + _corner.z * _n.z;
          if (d < best) {
            best = d;
            _pc.copy(_corner);
          }
        }
    } else {
      best = -Infinity;
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          _corner.copy(_ca).addScaledVector(_fa, sz * ha.z).addScaledVector(_la, sx * ha.x);
          const d = _corner.x * _n.x + _corner.z * _n.z;
          if (d > best) {
            best = d;
            _pc.copy(_corner);
          }
        }
    }
    _pc.y = (Math.max(_ca.y - ha.y, _cb.y - hb.y) + Math.min(_ca.y + ha.y, _cb.y + hb.y)) / 2;
    this.carContacts++;
    resolvePair(A, B, _pc, _n, minOverlap);
  }
}

/** Two-body impulse with restitution, friction and positional correction. */
function resolvePair(A: Vehicle, B: Vehicle, P: Vector3, n: Vector3, pen: number): void {
  _ra.subVectors(P, A.p);
  _rb.subVectors(P, B.p);
  _va.crossVectors(A.w, _ra).add(A.v);
  _vb.crossVectors(B.w, _rb).add(B.v);
  const vrel = _t1.subVectors(_vb, _va);
  const vn = vrel.dot(n);
  if (vn < 0) {
    const kA = angularTerm(A, _ra, n);
    const kB = angularTerm(B, _rb, n);
    const k = A.invMass + B.invMass + kA + kB;
    const e = 0.18;
    const j = (-(1 + e) * vn) / k;
    applyImpulse(A, _ra, n, -j);
    applyImpulse(B, _rb, n, j);
    // friction
    _va.crossVectors(A.w, _ra).add(A.v);
    _vb.crossVectors(B.w, _rb).add(B.v);
    const vr = _t1.subVectors(_vb, _va);
    vr.addScaledVector(n, -vr.dot(n));
    const vt = vr.length();
    if (vt > 1e-4) {
      const t = _t2.copy(vr).multiplyScalar(1 / vt);
      const kt = A.invMass + B.invMass + angularTerm(A, _ra, t) + angularTerm(B, _rb, t);
      const jt = Math.min(vt / kt, 0.3 * j);
      applyImpulse(A, _ra, t, jt);
      applyImpulse(B, _rb, t, -jt);
    }
    const strength = -vn;
    if (strength > 1.0) {
      for (const V of [A, B]) {
        const st = V.state;
        st.impactCount++;
        st.lastImpact.strength = strength;
        st.lastImpact.point.copy(P);
        st.lastImpact.normal.copy(n);
        if (V === A) st.lastImpact.normal.negate();
        st.lastImpact.kind = 'car';
      }
    }
  }
  if (pen > 0.005) {
    const total = A.invMass + B.invMass;
    const corr = (pen - 0.005) * 0.3;
    A.p.addScaledVector(n, (-corr * A.invMass) / total);
    B.p.addScaledVector(n, (corr * B.invMass) / total);
  }
}

const _x = new Vector3();
const _y = new Vector3();
function angularTerm(V: Vehicle, r: Vector3, n: Vector3): number {
  _x.crossVectors(r, n);
  invInertiaWorld(V, _x);
  _y.crossVectors(_x, r);
  return n.dot(_y);
}
const _imp = new Vector3();
function applyImpulse(V: Vehicle, r: Vector3, n: Vector3, j: number): void {
  V.v.addScaledVector(n, j * V.invMass);
  _imp.crossVectors(r, n).multiplyScalar(j);
  invInertiaWorld(V, _imp);
  V.w.add(_imp);
}
const _qi = new Quaternion();
function invInertiaWorld(V: Vehicle, vec: Vector3): void {
  const I = V.spec.chassis.inertia;
  _qi.copy(V.q).invert();
  vec.applyQuaternion(_qi);
  vec.x /= I.x;
  vec.y /= I.y;
  vec.z /= I.z;
  vec.applyQuaternion(V.q);
}
