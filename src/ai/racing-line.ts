/**
 * Racing line and speed profile.
 *
 * The line is the minimum-curvature path inside the track limits, found by iterative Laplacian
 * relaxation of lateral offsets (coarse-to-fine). The speed profile is the classic quasi-steady
 * three-pass solution: corner speed from the lateral friction limit (with downforce), then forward
 * (traction/power) and backward (braking) integration under a friction circle.
 */
import type { CarDefinition, GroundSample, SurfaceType, TrackRuntime } from '../core/contracts';
import type { MechEffects } from '../core/mechanical';
import { Vector3 } from 'three';
import { fitCar } from '../physics/compound';
import { peakPower } from '../physics/engine';
import { SURFACES, carSurfaces, wetGripFactor, type SurfaceProps } from '../physics/surfaces';
import type { VehicleSpec } from '../physics/spec';
import { awdTractionShare } from '../physics/traction';

const G = 9.81;
const RHO = 1.225;

export interface RacingLine {
  /** Number of points (closed loop). Point i sits at centerline s = i * step. */
  n: number;
  step: number;
  /** Lateral offset from the centerline (+ = left). */
  d: Float32Array;
  x: Float32Array;
  z: Float32Array;
  /** Signed curvature of the line (1/m, + = left). */
  k: Float32Array;
  /** Path distance from point i to i+1 along the line. */
  ds: Float32Array;
}

export interface SpeedProfile {
  v: Float32Array; // target speed at each line point (m/s)
}

export interface LineOptions {
  /** Distance kept from the asphalt edge by the car's centerline (m). Negative = use curbs. */
  edgeMargin: number;
  /** Target point spacing (m). */
  step?: number;
}

/** Compute the minimum-curvature racing line. Cached per track + margin. */
const cache = new Map<string, RacingLine>();
export function computeRacingLine(track: TrackRuntime, opts: LineOptions): RacingLine {
  const key = `${track.info.id}:${track.length.toFixed(1)}:${opts.edgeMargin.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const stride = Math.max(1, Math.round((opts.step ?? 4) / track.spacing));
  const n = Math.floor(track.count / stride);
  const step = (track.length / n);
  const cx = new Float64Array(n);
  const cz = new Float64Array(n);
  const lx = new Float64Array(n);
  const lz = new Float64Array(n);
  const lo = new Float64Array(n);
  const hi = new Float64Array(n);
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = Math.min(track.count - 1, Math.round((i * step) / track.spacing));
    cx[i] = track.px[j];
    cz[i] = track.pz[j];
    const l = Math.hypot(track.lx[j], track.lz[j]) || 1;
    lx[i] = track.lx[j] / l;
    lz[i] = track.lz[j] / l;
    hi[i] = Math.max(0, track.widthLeft[j] - opts.edgeMargin);
    lo[i] = -Math.max(0, track.widthRight[j] - opts.edgeMargin);
    if (hi[i] < lo[i]) hi[i] = lo[i] = (hi[i] + lo[i]) / 2;
  }
  // Minimum curvature: Gauss-Seidel on the bending energy Σ|P(i-1) - 2P(i) + P(i+1)|², whose
  // stationary point is P(i) = (-P(i-2) + 4P(i-1) + 4P(i+1) - P(i+2)) / 6, projected on each
  // point's lateral axis and clamped to the track limits. Coarse spans first so whole corners
  // converge quickly, then fine spans for the detail. A pinch of the membrane (length) term keeps
  // the line from wasting distance on long gentle sections.
  const px = (k: number) => cx[k] + d[k] * lx[k];
  const pz = (k: number) => cz[k] + d[k] * lz[k];
  for (const span of [32, 16, 8, 4, 2, 1]) {
    const iters = span >= 8 ? 250 : 500;
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < n; i++) {
        const a1 = (i - span + n) % n;
        const a2 = (i - 2 * span + 2 * n) % n;
        const b1 = (i + span) % n;
        const b2 = (i + 2 * span) % n;
        const bx = (-px(a2) + 4 * px(a1) + 4 * px(b1) - px(b2)) / 6;
        const bz = (-pz(a2) + 4 * pz(a1) + 4 * pz(b1) - pz(b2)) / 6;
        const mx = (px(a1) + px(b1)) / 2;
        const mz = (pz(a1) + pz(b1)) / 2;
        const tx = 0.93 * bx + 0.07 * mx;
        const tz = 0.93 * bz + 0.07 * mz;
        const move = (tx - px(i)) * lx[i] + (tz - pz(i)) * lz[i];
        let nd = d[i] + 0.8 * move;
        if (nd < lo[i]) nd = lo[i];
        else if (nd > hi[i]) nd = hi[i];
        d[i] = nd;
      }
    }
  }
  const line: RacingLine = {
    n,
    step,
    d: new Float32Array(n),
    x: new Float32Array(n),
    z: new Float32Array(n),
    k: new Float32Array(n),
    ds: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    line.d[i] = d[i];
    line.x[i] = cx[i] + d[i] * lx[i];
    line.z[i] = cz[i] + d[i] * lz[i];
  }
  for (let i = 0; i < n; i++) {
    const b = (i + 1) % n;
    line.ds[i] = Math.hypot(line.x[b] - line.x[i], line.z[b] - line.z[i]);
  }
  // curvature from the circle through neighbors 2 apart (less noisy), then smoothed
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 2 + n) % n;
    const b = (i + 2) % n;
    raw[i] = curvature3(line.x[a], line.z[a], line.x[i], line.z[i], line.x[b], line.z[b]);
  }
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -2; k <= 2; k++) s += raw[(i + k + n) % n] * (3 - Math.abs(k));
    line.k[i] = s / 9;
  }
  cache.set(key, line);
  return line;
}

/** Signed curvature of the circle through three points (+ = turning left). */
function curvature3(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const bcx = cx - bx;
  const bcz = cz - bz;
  const acx = cx - ax;
  const acz = cz - az;
  // with +X left and +Z forward, a left turn has positive (ab × bc)·(-y)… use the 2D cross in XZ
  const cross = abz * bcx - abx * bcz;
  const den = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(acx, acz);
  return den > 1e-9 ? (2 * cross) / den : 0;
}

/**
 * The surface under the racing line at each of its points (0 = the road's own: asphalt, or on a winter circuit packed snow and ice),
 * and what the table of surfaces says about each: the profile of a circuit whose road is not all one surface (the ice of a frozen
 * lake) works with the grip under each point. A circuit of plain asphalt costs nothing: one entry, every point on it.
 * (It is the track's, shared by every car, and it holds the plain table's numbers: a car on all-terrain tyres or on racing slicks reads
 * the surface names and works its own grip out of them, `carSurfaces`; see ProfileJob and the driver.)
 */
export interface LineSurfaces {
  /** Index into `props` per line point. */
  at: Uint8Array;
  props: SurfaceProps[];
  names: SurfaceType[];
  /** Grip multiplier of the surface under each point (1 on asphalt). */
  grip: Float32Array;
}

const surfCache = new Map<string, LineSurfaces>();
const _sp = new Vector3();
const _sg: GroundSample = { height: 0, normal: new Vector3(0, 1, 0), surface: 'asphalt' };

export function lineSurfaces(track: TrackRuntime, line: RacingLine): LineSurfaces {
  const key = `${track.info.id}:${track.length.toFixed(1)}:${line.n}:${line.d[0].toFixed(3)}:${line.d[line.n >> 1].toFixed(3)}`;
  let hit = surfCache.get(key);
  if (hit) return hit;
  const names: SurfaceType[] = [];
  const at = new Uint8Array(line.n);
  const grip = new Float32Array(line.n);
  for (let i = 0; i < line.n; i++) {
    // (the point on the line itself, and the surface the wheels see: the line stays inside the asphalt, so the road's)
    _sp.set(line.x[i], 0, line.z[i]);
    track.groundAt(line.x[i], line.z[i], _sg);
    let k = names.indexOf(_sg.surface);
    if (k < 0) {
      names.push(_sg.surface);
      k = names.length - 1;
    }
    at[i] = k;
    grip[i] = SURFACES[_sg.surface].grip;
  }
  hit = { at, names, props: names.map((n) => SURFACES[n]), grip };
  surfCache.set(key, hit);
  return hit;
}

/**
 * The grip of the surface under each point of the line for one car's tyres, relative to asphalt (`LineSurfaces.grip` is the track's, for
 * a road tyre): that very array for a car on road tyres, a table of its own for a car on all-terrain tyres, which keep more of their
 * grip on loose ground, or on racing slicks, which keep less (src/physics/surfaces.ts, `carSurfaces`). The line stays on the road, so the
 * two differ only where a circuit puts gravel or grass under it.
 */
export function carLineGrip(surf: LineSurfaces, ph: Pick<VehicleSpec, 'tireFront' | 'tireRear'>): Float32Array {
  const own = carSurfaces(ph);
  return own === SURFACES ? surf.grip : Float32Array.from(surf.at, (k) => own[surf.names[k]].grip);
}

/** The surface a road is made of, for the water on it: asphalt, or packed snow on a winter circuit (what fresh snow lies on). */
export const roadSurface = (track: Pick<TrackRuntime, 'info'>): SurfaceProps => SURFACES[track.info.winter ? 'snow' : 'asphalt'];

export interface ProfileOptions {
  /** Fraction of the car's real grip the driver dares to use (0.8 .. 1). */
  gripUse: number;
  /** Fraction of the braking capability used. */
  brakeUse: number;
  /** Water on the track (0..1): wet tire grip and aquaplaning at speed. */
  wetness?: number;
  /** Mechanical damage the car carries (src/core/mechanical.ts): less downforce and grip. Absent or null: a sound car. */
  damage?: MechEffects | null;
}

/**
 * How much of what the damage takes a driver gives up in the speed profile. The profile of a sound car already keeps clear of the
 * limit (its grip use, the margin on top, the load the tyres lose to their own sensitivity), so a car that lost a tenth of its
 * downforce still has the corner speeds of its profile in hand, in all but the fastest corners: a driver that gave up all of it would
 * lose two to six times what the damage really costs (measured on all four circuits with a lone car that was not told: the
 * physics alone costs 0.1 to 3 % of a lap, and the full adaptation 0.4 to 8 %). A quarter of it brakes earlier and carries less
 * speed in the corners the damage hurts, and leaves the driver a little more room for the traffic around it.
 */
const SHARE = 0.25;

/**
 * What a damaged car can still give, as the factors the speed profile and the driver work with: `grip` (the camber errors of the
 * tyres of the weaker axle) and `aero` (the downforce of the weaker end: the car is as loose or as tight as its worse end, so the
 * total is not the measure). A sound car, or none, is 1, 1. The engine's power is left out on purpose: the car loses it whether the
 * driver knows or not, and a driver on the throttle already has it flat out wherever the profile asks for more than the car has.
 */
export function damageFactors(fx: MechEffects | null | undefined): { grip: number; aero: number } {
  if (!fx) return { grip: 1, aero: 1 };
  const camber = Math.min((fx.camberGrip[0] + fx.camberGrip[1]) / 2, (fx.camberGrip[2] + fx.camberGrip[3]) / 2);
  return { grip: 1 - SHARE * (1 - camber), aero: 1 - SHARE * (1 - Math.min(fx.aeroFront, fx.aeroRear)) };
}

/**
 * What a car can do on a road, in the terms the speed profile works with: the tyres' grip with downforce, the water on the road and
 * the damage the car carries, drag, power and the share of the car's weight on the driven axle. Shared by the profile and by
 * everything that has to brake at the pace the profile does (the driving line's colours, the braking assist).
 */
export interface GripModel {
  /** Peak grip coefficient the profile uses (the weaker axle's, with the driver's share of it, the wet and the damage). */
  mu: number;
  /** Downforce per (m/s)^2, as an acceleration. */
  cDown: number;
  /** Drag per (m/s)^2, as an acceleration. */
  cDrag: number;
  /** Power at the driven wheels (W) and the car's top speed (m/s). */
  power: number;
  vTop: number;
  /** Share of the car's weight the driven axle carries (the traction the car has to put its power down with). */
  drivenFrac: number;
  mass: number;
  /** Aquaplaning: the grip left at speed vv as a share of the grip at rest (1 on a dry road). */
  aqua(vv: number): number;
  /** Lateral acceleration the tyres can give at speed vv. */
  latMax(vv: number): number;
}

export function gripModel(def: CarDefinition, o: ProfileOptions, road: SurfaceProps = SURFACES.asphalt): GripModel {
  const ph = def.physics;
  const m = ph.chassis.mass;
  const dmg = damageFactors(o.damage);
  // wet: the tires' wet grip on the road (water on asphalt, fresh snow on packed snow), and aquaplaning that grows with speed (relative to 0 m/s)
  const wet = o.wetness ?? 0;
  const tireWet = Math.min(ph.tireFront.wetGrip ?? 0.72, ph.tireRear.wetGrip ?? 0.72);
  const wet0 = wetGripFactor(wet, tireWet, road, 0);
  const aqua = (vv: number) => (wet > 0 ? wetGripFactor(wet, tireWet, road, vv) / wet0 : 1);
  const mu = Math.min(ph.tireFront.mu, ph.tireRear.mu) * 0.95 * o.gripUse * wet0 * dmg.grip;
  const cDown = ((0.5 * RHO * (ph.aero.liftAreaFront + ph.aero.liftAreaRear)) / m) * dmg.aero;
  const cDrag = (0.5 * RHO * ph.aero.dragArea) / m;
  const power = peakPower(ph.engine).watts * ph.drivetrain.efficiency * 0.92;
  const vTop = (def.stats.topSpeedKmh / 3.6) * 0.995;
  const a = ph.chassis.cgToFrontAxle;
  const L = ph.chassis.wheelbase;
  const drivenFrac = ph.drivetrain.layout === 'FWD' ? (L - a) / L * 0.92 : ph.drivetrain.layout === 'RWD' ? (a / L) * 1.1 : awdTractionShare(ph);
  const latMax = (vv: number) => mu * aqua(vv) * (G + cDown * vv * vv);
  return { mu, cDown, cDrag, power, vTop, drivenFrac, mass: m, aqua, latMax };
}

/**
 * How a car brakes on a road: the pace the speed profile brakes at, what the tyres give at the very most, what drag does by itself
 * and what a full pedal asks of the brakes. The driving line's colours and the braking assist are built on these.
 */
export interface BrakeModel {
  /**
   * Deceleration (m/s^2) the profile brakes at, in a straight line at speed vv: the share of the grip it uses, drag included. `k` is
   * what the ground under the car does to the grip of the model (`ProfileJob.surfaceFactor`: 1 on asphalt, 0.5 on packed snow, 0.4 on ice).
   */
  profile(vv: number, k?: number): number;
  /** The most the tyres can brake at at speed vv (m/s^2): all of their grip with the downforce, drag not included. `k` as above. */
  grip(vv: number, k?: number): number;
  /** Deceleration drag gives at speed vv (m/s^2). */
  drag(vv: number): number;
  /** Deceleration a full pedal gives if the tyres could take it (m/s^2): the brakes' own limit. */
  pedal: number;
  /** The car's top speed as the profile takes it (m/s). */
  top: number;
}

export function brakeModel(def: CarDefinition, o: ProfileOptions, road: SurfaceProps = SURFACES.asphalt): BrakeModel {
  const gm = gripModel(def, o, road);
  const ph = def.physics;
  // (the grip without the driver's margin: the profile's own mu has the 0.95 and the driver's share of the grip in it)
  const muFull = gm.mu / (0.95 * o.gripUse);
  return {
    profile: (vv, k = 1) => {
      const mu = gm.mu * k;
      return (mu * 1.05 * G + mu * gm.cDown * vv * vv) * o.brakeUse * gm.aqua(vv) + gm.cDrag * vv * vv;
    },
    grip: (vv, k = 1) => muFull * k * gm.aqua(vv) * (G + gm.cDown * vv * vv),
    drag: (vv) => gm.cDrag * vv * vv,
    pedal: ((2 * ph.brakes.frontTorque) / ph.tireFront.radius + (2 * ph.brakes.rearTorque) / ph.tireRear.radius) / ph.chassis.mass,
    top: gm.vTop,
  };
}

/**
 * The quasi-steady speed profile of one car on one line, worked out in slices: `advance(budget)` does that many steps of the work and
 * says whether it is finished. It is the arithmetic computeSpeedProfile always had, in the same order, so a profile worked out in
 * pieces is bit for bit the one worked out in one go (tests/aids.test.ts). A caller that must not stall a frame (the driving line,
 * when the rain comes) gives it a share of every frame; the AI drivers, who want the answer now, call computeSpeedProfile.
 */
export class ProfileJob {
  readonly speeds: Float32Array;
  done = false;
  private readonly n: number;
  private readonly gm: GripModel;
  private readonly brakeUse: number;
  private readonly wet: number;
  /**
   * What multiplies the grip model's own grip (`GripModel.mu`) at each point of the line: the surface's grip (1 on asphalt, 0.5 on packed
   * snow, 0.4 on ice) and what the water, or the fresh snow, does to that surface in comparison with the road's. 1 all round on asphalt.
   */
  readonly surfaceFactor: Float32Array;
  private readonly muAt: Float64Array;
  private readonly aquaAt: (i: number, vv: number) => number;
  /** 0 = the corner speeds, 1 = a forward pass, 2 = a backward pass; `t` counts the steps of the stage and `pass` the passes made. */
  private stage = 0;
  private t = 0;
  private pass = 0;

  constructor(
    private readonly track: TrackRuntime,
    private readonly line: RacingLine,
    def: CarDefinition,
    o: ProfileOptions,
  ) {
    this.n = line.n;
    // (on a winter circuit every car is on its studded tyres)
    def = fitCar(def, track);
    const road = roadSurface(track);
    this.gm = gripModel(def, o, road);
    this.brakeUse = o.brakeUse;
    this.wet = o.wetness ?? 0;
    this.speeds = new Float32Array(this.n);
    // the grip under each point: the surface's own, and what the water (fresh snow on a winter road) does to it
    const surf = lineSurfaces(track, line);
    const ph = def.physics;
    const tireWet = Math.min(ph.tireFront.wetGrip ?? 0.72, ph.tireRear.wetGrip ?? 0.72);
    const wet = this.wet;
    const wetRoad = wetGripFactor(wet, tireWet, road, 0);
    // (a car on all-terrain tyres or on slicks meets loose ground as its tyres do, `carSurfaces`; a car on road tyres gets the track's own table, to the bit)
    const own = carSurfaces(ph);
    const props = own === SURFACES ? surf.props : surf.names.map((n) => own[n]);
    const wet0s = props.map((sp) => wetGripFactor(wet, tireWet, sp, 0));
    this.surfaceFactor = new Float32Array(this.n);
    this.muAt = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      // (a road of one surface is the road's own: x / x is exactly 1, so the profile of a circuit of plain asphalt is the one it always was)
      const k = surf.at[i];
      // (the track's table keeps its grip as 32-bit floats: so does this one, and the same ground gives the same number for every car)
      const grip = own === SURFACES ? surf.grip[i] : Math.fround(props[k].grip);
      this.surfaceFactor[i] = (wet0s[k] / wetRoad) * grip;
      this.muAt[i] = this.gm.mu * (wet0s[k] / wetRoad) * grip;
    }
    this.aquaAt = (i, vv) => (wet > 0 ? wetGripFactor(wet, tireWet, props[surf.at[i]], vv) / wet0s[surf.at[i]] : 1);
  }

  /** The profile (finished, or as far as it has got). */
  get profile(): SpeedProfile {
    return { v: this.speeds };
  }

  /** Run to the end. */
  finish(): SpeedProfile {
    this.advance(Infinity);
    return this.profile;
  }

  /** Do up to `budget` steps of the work (a step is one point of the line in one pass, about 40 ns); true when the profile is finished. */
  advance(budget: number): boolean {
    const n = this.n;
    let left = budget;
    while (!this.done && left > 0) {
      if (this.stage === 0) {
        const end = Math.min(n, this.t + left);
        left -= end - this.t;
        for (; this.t < end; this.t++) this.corner(this.t);
        if (this.t < n) break;
        this.stage = 1;
        this.t = 0;
      } else if (this.stage === 1) {
        // forward: traction & power
        const end = Math.min(2 * n, this.t + left);
        left -= end - this.t;
        for (; this.t < end; this.t++) this.forward(this.t);
        if (this.t < 2 * n) break;
        this.stage = 2;
        this.t = 2 * n;
      } else {
        // backward: braking
        const end = Math.max(0, this.t - left);
        left -= this.t - end;
        for (; this.t > end; this.t--) this.backward(this.t);
        if (this.t > 0) break;
        if (++this.pass >= 3) this.done = true;
        else {
          this.stage = 1;
          this.t = 0;
        }
      }
    }
    return this.done;
  }

  /** The speed a corner allows at line point i. */
  private corner(i: number): void {
    const { track, line, gm } = this;
    const k = Math.abs(line.k[i]);
    // bank helps (or hurts) the corner: positive bank raises the left edge, good for right turns
    const j = Math.min(track.count - 1, Math.round((i * line.step) / track.spacing));
    const bankHelp = -Math.sign(line.k[i]) * Math.sin(track.bank[j]) * G;
    // closed form for a constant mu; one fixed-point pass picks up the aquaplaning at that speed
    const mu = this.muAt[i];
    let muC = mu;
    let vmax = gm.vTop;
    for (let it = 0; it < (this.wet > 0 ? 2 : 1); it++) {
      const den = k - muC * gm.cDown;
      vmax = den > 1e-6 ? Math.sqrt(Math.max(1, muC * G + bankHelp) / den) : gm.vTop;
      muC = mu * this.aquaAt(i, Math.min(vmax, gm.vTop));
    }
    this.speeds[i] = Math.min(gm.vTop, vmax);
  }

  /** Friction-circle remainder for longitudinal acceleration at speed vv on curvature k at line point i. */
  private longAvail(i: number, vv: number, k: number, cap: number): number {
    const lat = vv * vv * Math.abs(k);
    const lm = this.muAt[i] * this.aquaAt(i, vv) * (G + this.gm.cDown * vv * vv);
    const r = lat / lm;
    return r >= 1 ? 0 : cap * Math.sqrt(1 - r * r);
  }

  private forward(t: number): void {
    const { n, line, gm } = this;
    const v = this.speeds;
    const i = t % n;
    const b = (i + 1) % n;
    const vi = v[i];
    const mu = this.muAt[i];
    const trac = (mu * 1.05 * G * gm.drivenFrac + mu * gm.cDown * vi * vi * gm.drivenFrac) * this.aquaAt(i, vi);
    const pow = gm.power / (gm.mass * Math.max(vi, 3));
    const acc = this.longAvail(i, vi, line.k[i], Math.min(trac, pow)) - gm.cDrag * vi * vi - 0.12;
    const vn = Math.sqrt(Math.max(0, vi * vi + 2 * acc * line.ds[i]));
    if (vn < v[b]) v[b] = vn;
  }

  private backward(t: number): void {
    const { n, line, gm } = this;
    const v = this.speeds;
    const i = t % n;
    const p = (i - 1 + n) % n;
    const vi = v[i];
    const mu = this.muAt[i];
    const cap = (mu * 1.05 * G + mu * gm.cDown * vi * vi) * this.brakeUse * this.aquaAt(i, vi);
    const dec = this.longAvail(i, vi, line.k[i], cap) + gm.cDrag * vi * vi;
    const vp = Math.sqrt(vi * vi + 2 * dec * line.ds[p]);
    if (vp < v[p]) v[p] = vp;
  }
}

/** Quasi-steady speed profile for one car on one line. */
export function computeSpeedProfile(track: TrackRuntime, line: RacingLine, def: CarDefinition, o: ProfileOptions): SpeedProfile {
  return new ProfileJob(track, line, def, o).finish();
}

/** Estimated lap time for a profile (s). */
export function profileLapTime(line: RacingLine, prof: SpeedProfile): number {
  let t = 0;
  for (let i = 0; i < line.n; i++) {
    const b = (i + 1) % line.n;
    t += line.ds[i] / Math.max(1, (prof.v[i] + prof.v[b]) / 2);
  }
  return t;
}
