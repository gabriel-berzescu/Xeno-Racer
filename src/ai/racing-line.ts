/**
 * Racing line and speed profile.
 *
 * The line is the minimum-curvature path inside the track limits, found by iterative Laplacian
 * relaxation of lateral offsets (coarse-to-fine). The speed profile is the classic quasi-steady
 * three-pass solution: corner speed from the lateral friction limit (with downforce), then forward
 * (traction/power) and backward (braking) integration under a friction circle.
 */
import type { CarDefinition, TrackRuntime } from '../core/contracts';
import type { MechEffects } from '../core/mechanical';
import { peakPower } from '../physics/engine';
import { SURFACES, wetGripFactor } from '../physics/surfaces';

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

/** Quasi-steady speed profile for one car on one line. */
export function computeSpeedProfile(track: TrackRuntime, line: RacingLine, def: CarDefinition, o: ProfileOptions): SpeedProfile {
  const n = line.n;
  const ph = def.physics;
  const m = ph.chassis.mass;
  const dmg = damageFactors(o.damage);
  // wet: the tires' wet grip on asphalt, and aquaplaning that grows with speed (relative to 0 m/s)
  const wet = o.wetness ?? 0;
  const tireWet = Math.min(ph.tireFront.wetGrip ?? 0.72, ph.tireRear.wetGrip ?? 0.72);
  const wet0 = wetGripFactor(wet, tireWet, SURFACES.asphalt, 0);
  const aqua = (vv: number) => (wet > 0 ? wetGripFactor(wet, tireWet, SURFACES.asphalt, vv) / wet0 : 1);
  const mu = Math.min(ph.tireFront.mu, ph.tireRear.mu) * 0.95 * o.gripUse * wet0 * dmg.grip;
  const cDown = ((0.5 * RHO * (ph.aero.liftAreaFront + ph.aero.liftAreaRear)) / m) * dmg.aero;
  const cDrag = (0.5 * RHO * ph.aero.dragArea) / m;
  const power = peakPower(ph.engine).watts * ph.drivetrain.efficiency * 0.92;
  const vTop = (def.stats.topSpeedKmh / 3.6) * 0.995;
  const a = ph.chassis.cgToFrontAxle;
  const L = ph.chassis.wheelbase;
  const drivenFrac = ph.drivetrain.layout === 'FWD' ? (L - a) / L * 0.92 : ph.drivetrain.layout === 'RWD' ? (a / L) * 1.1 : 1;
  const v = new Float32Array(n);
  const latMax = (vv: number) => mu * aqua(vv) * (G + cDown * vv * vv);
  for (let i = 0; i < n; i++) {
    const k = Math.abs(line.k[i]);
    // bank helps (or hurts) the corner: positive bank raises the left edge, good for right turns
    const j = Math.min(track.count - 1, Math.round((i * line.step) / track.spacing));
    const bankHelp = -Math.sign(line.k[i]) * Math.sin(track.bank[j]) * G;
    // closed form for a constant mu; one fixed-point pass picks up the aquaplaning at that speed
    let muC = mu;
    let vmax = vTop;
    for (let it = 0; it < (wet > 0 ? 2 : 1); it++) {
      const den = k - muC * cDown;
      vmax = den > 1e-6 ? Math.sqrt(Math.max(1, muC * G + bankHelp) / den) : vTop;
      muC = mu * aqua(Math.min(vmax, vTop));
    }
    v[i] = Math.min(vTop, vmax);
  }
  // friction-circle remainder for longitudinal acceleration at speed vv on curvature k
  const longAvail = (vv: number, k: number, cap: number) => {
    const lat = vv * vv * Math.abs(k);
    const lm = latMax(vv);
    const r = lat / lm;
    return r >= 1 ? 0 : cap * Math.sqrt(1 - r * r);
  };
  for (let pass = 0; pass < 3; pass++) {
    // forward: traction & power
    for (let t = 0; t < 2 * n; t++) {
      const i = t % n;
      const b = (i + 1) % n;
      const vi = v[i];
      const trac = (mu * 1.05 * G * drivenFrac + mu * cDown * vi * vi * drivenFrac) * aqua(vi);
      const pow = power / (m * Math.max(vi, 3));
      const acc = longAvail(vi, line.k[i], Math.min(trac, pow)) - cDrag * vi * vi - 0.12;
      const vn = Math.sqrt(Math.max(0, vi * vi + 2 * acc * line.ds[i]));
      if (vn < v[b]) v[b] = vn;
    }
    // backward: braking
    for (let t = 2 * n; t > 0; t--) {
      const i = t % n;
      const p = (i - 1 + n) % n;
      const vi = v[i];
      const cap = (mu * 1.05 * G + mu * cDown * vi * vi) * o.brakeUse * aqua(vi);
      const dec = longAvail(vi, line.k[i], cap) + cDrag * vi * vi;
      const vp = Math.sqrt(vi * vi + 2 * dec * line.ds[p]);
      if (vp < v[p]) v[p] = vp;
    }
  }
  return { v };
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
