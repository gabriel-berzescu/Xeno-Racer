/**
 * Racing line and speed profile.
 *
 * The line is the minimum-curvature path inside the track limits, found by iterative Laplacian
 * relaxation of lateral offsets (coarse-to-fine). The speed profile is the classic quasi-steady
 * three-pass solution: corner speed from the lateral friction limit (with downforce), then forward
 * (traction/power) and backward (braking) integration under a friction circle.
 */
import type { CarDefinition, TrackRuntime } from '../core/contracts';
import { peakPower } from '../physics/engine';

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
}

/** Quasi-steady speed profile for one car on one line. */
export function computeSpeedProfile(track: TrackRuntime, line: RacingLine, def: CarDefinition, o: ProfileOptions): SpeedProfile {
  const n = line.n;
  const ph = def.physics;
  const m = ph.chassis.mass;
  const mu = Math.min(ph.tireFront.mu, ph.tireRear.mu) * 0.95 * o.gripUse;
  const cDown = (0.5 * RHO * (ph.aero.liftAreaFront + ph.aero.liftAreaRear)) / m;
  const cDrag = (0.5 * RHO * ph.aero.dragArea) / m;
  const power = peakPower(ph.engine).watts * ph.drivetrain.efficiency * 0.92;
  const vTop = (def.stats.topSpeedKmh / 3.6) * 0.995;
  const a = ph.chassis.cgToFrontAxle;
  const L = ph.chassis.wheelbase;
  const drivenFrac = ph.drivetrain.layout === 'FWD' ? (L - a) / L * 0.92 : ph.drivetrain.layout === 'RWD' ? (a / L) * 1.1 : 1;
  const v = new Float32Array(n);
  const latMax = (vv: number) => mu * (G + cDown * vv * vv);
  for (let i = 0; i < n; i++) {
    const k = Math.abs(line.k[i]);
    const den = k - mu * cDown;
    // bank helps (or hurts) the corner: positive bank raises the left edge, good for right turns
    const j = Math.min(track.count - 1, Math.round((i * line.step) / track.spacing));
    const bankHelp = -Math.sign(line.k[i]) * Math.sin(track.bank[j]) * G;
    const vmax = den > 1e-6 ? Math.sqrt(Math.max(1, mu * G + bankHelp) / den) : vTop;
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
      const trac = mu * 1.05 * G * drivenFrac + mu * cDown * vi * vi * drivenFrac;
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
      const cap = (mu * 1.05 * G + mu * cDown * vi * vi) * o.brakeUse;
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
