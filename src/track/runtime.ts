/**
 * TrackRuntimeImpl: the headless, allocation-free track queries that the physics stands on.
 *
 * Coordinates: the centerline is an arc-length parametrised polyline of N segments (samples i..i+1,
 * N+1 entries with sample N == sample 0). Between samples the world position of (s, d) is the
 * BILINEAR map  P(t, d) = P_i + t (P_{i+1} - P_i) + d (L_i + t (L_{i+1} - L_i))  with L the unit
 * horizontal left vector at the samples. That map is inverted EXACTLY (a quadratic in t), so
 * pointAt -> project round-trips to float precision, and the patches tile the plane without gaps.
 *
 * Heights: centerline height is a cubic Hermite spline between samples; across the road the surface
 * is bank + crown; beyond the asphalt a curb (ramp + ridges), runoff bands, then the terrain
 * (cross-faded into the baked field T + E a few metres behind the barrier).
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { GridSlot, GroundSample, SurfaceType, TrackFrame, TrackInfo, TrackPoint, TrackRuntime } from '../core/contracts';
import { clamp, hermite, hermiteSlope, smootherstep, smoothstep } from './math';
import type { CornerInfo, PlanResult } from './plan';
import type { Channels, SideChannels } from './profile';
import type { TerrainFn } from './terrain';
import type { LakeDef, TrackDef } from './types';
import { BAR_SOFT, CURB_RAMP_MAX, RIDGE_PERIOD, SURF_CODE, SURF_NAME, curbRamp } from './types';

export { RIDGE_PERIOD, CURB_RAMP_MAX };
const XFADE_START = 1.5; // metres beyond the barrier face where the profile starts blending into the terrain

/** Trapezoid ridge profile of period 1: rises 0..0.25, flat to 0.5, falls to 0.75, valley to 1. */
export function ridgeProfile(phase: number): number {
  if (phase < 0.25) return phase * 4;
  if (phase < 0.5) return 1;
  if (phase < 0.75) return 1 - (phase - 0.5) * 4;
  return 0;
}
function ridgeSlope(phase: number): number {
  if (phase < 0.25) return 4;
  if (phase < 0.5) return 0;
  if (phase < 0.75) return -4;
  return 0;
}

export interface SideArrays {
  W: Float64Array; // asphalt half width
  C: Float64Array; // crown amount (m)
  E: Float64Array; // outward slope at the asphalt edge
  curbW: Float64Array;
  curbK: Uint8Array;
  curbH0: Float64Array;
  curbH1: Float64Array;
  b1W: Float64Array;
  b1S: Uint8Array;
  b2W: Float64Array;
  b2S: Uint8Array;
  bowl1: Float64Array;
  bowl2: Float64Array;
  barrier: Uint8Array;
  cross: Float64Array;
  wall: Float64Array; // distance from the centerline to the barrier face
}

export interface RuntimeParts {
  def: TrackDef;
  plan: PlanResult;
  length: number;
  N: number;
  spacing: number;
  X: Float64Array;
  Z: Float64Array;
  PHI: Float64Array;
  KAPPA: Float64Array;
  Y: Float64Array;
  BANK: Float64Array;
  WL: Float64Array;
  WR: Float64Array;
  ch: Channels;
  crown: number;
  terrain: TerrainFn;
  /** The frozen lake of a winter circuit, placed in the world. */
  iceLake?: LakeDef | null;
  info: TrackInfo;
  sectors: [number, number];
}

export class TrackRuntimeImpl implements TrackRuntime {
  readonly info: TrackInfo;
  readonly length: number;
  readonly spacing: number;
  readonly count: number;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly tx: Float32Array;
  readonly ty: Float32Array;
  readonly tz: Float32Array;
  readonly nx: Float32Array;
  readonly ny: Float32Array;
  readonly nz: Float32Array;
  readonly lx: Float32Array;
  readonly ly: Float32Array;
  readonly lz: Float32Array;
  readonly widthLeft: Float32Array;
  readonly widthRight: Float32Array;
  readonly wallLeft: Float32Array;
  readonly wallRight: Float32Array;
  readonly curvature: Float32Array;
  readonly bank: Float32Array;
  readonly sectors: readonly [number, number];
  readonly grid: readonly GridSlot[];
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number };

  // ── extras for the scene builder ──────────────────────────────────────────────
  readonly def: TrackDef;
  readonly plan: PlanResult;
  readonly corners: CornerInfo[];
  /** Centerline sample found by the last stripMargin() call (scene building: lets tiles detect the seam between two road legs). */
  lastSegment = 0;
  readonly terrain: TerrainFn;
  readonly X: Float64Array;
  readonly Z: Float64Array;
  readonly Y: Float64Array;
  readonly M: Float64Array; // dy/ds
  readonly HTX: Float64Array;
  readonly HTZ: Float64Array;
  readonly HLX: Float64Array;
  readonly HLZ: Float64Array;
  readonly TB: Float64Array;
  readonly DTB: Float64Array;
  readonly KAP: Float64Array;
  readonly L: SideArrays;
  readonly R: SideArrays;
  /** Surface code of the road itself per sample (asphalt; on a winter circuit packed snow, with ice on a frozen lake). */
  readonly roadSurf: Uint8Array;
  /** Surface code of the ground beyond the barriers (grass; deep snow on a winter circuit). */
  readonly farSurf: number;
  /** The frozen lake of a winter circuit, placed in the world (null without one). */
  readonly iceLake: LakeDef | null;

  private readonly N: number;
  private readonly crown: number;
  /** Metres beyond the barrier face where the terrain blend completes. */
  readonly xfadeEnd: number;
  /** Largest barrier distance (from the centerline) anywhere on the lap. */
  maxWall = 0;
  /** 1 on samples inside a tunnel (terrain is not carved there; the hill closes over the road). */
  readonly tunnelMask: Uint8Array;
  /** Samples that do not carve the terrain (inside tunnels, away from the portals). */
  private readonly carveSkip: Uint8Array;
  /** Tunnel spans in s (m): [from, to]. */
  readonly tunnelSpans: [number, number][] = [];

  // spatial grid (CSR)
  private gMinX = 0;
  private gMinZ = 0;
  private gCell = 40;
  private gNx = 1;
  private gNz = 1;
  private gStart: Int32Array = new Int32Array(0);
  private gItems: Int32Array = new Int32Array(0);

  // baked terrain-carve field
  private fReady = false;
  private fMinX = 0;
  private fMinZ = 0;
  private fCell = 6;
  private fNx = 0;
  private fNz = 0;
  private fE: Float32Array = new Float32Array(0);
  /** Distance (m) over which the road carves the surrounding terrain. */
  readonly carveReach: number;

  // scratch (all queries are allocation-free)
  private _t = 0;
  private _d = 0;
  private _h = 0;
  private _hs = 0;
  private _hd = 0;
  private _surf = 0;
  private _fd = false;
  private _bd = 0;

  constructor(p: RuntimeParts) {
    const N = p.N;
    this.N = N;
    this.info = p.info;
    this.def = p.def;
    this.plan = p.plan;
    this.corners = p.plan.corners;
    this.terrain = p.terrain;
    this.length = p.length;
    this.spacing = p.spacing;
    this.count = N;
    this.sectors = p.sectors;
    this.crown = p.crown;
    this.carveReach = p.def.terrain.reach;
    this.xfadeEnd = p.def.terrain.xfade ?? 5.5;
    const n1 = N + 1;
    this.X = p.X;
    this.Z = p.Z;
    this.Y = p.Y;
    this.KAP = p.KAPPA;
    this.M = new Float64Array(n1);
    this.HTX = new Float64Array(n1);
    this.HTZ = new Float64Array(n1);
    this.HLX = new Float64Array(n1);
    this.HLZ = new Float64Array(n1);
    this.TB = new Float64Array(n1);
    this.DTB = new Float64Array(n1);

    this.px = new Float32Array(n1);
    this.py = new Float32Array(n1);
    this.pz = new Float32Array(n1);
    this.tx = new Float32Array(n1);
    this.ty = new Float32Array(n1);
    this.tz = new Float32Array(n1);
    this.nx = new Float32Array(n1);
    this.ny = new Float32Array(n1);
    this.nz = new Float32Array(n1);
    this.lx = new Float32Array(n1);
    this.ly = new Float32Array(n1);
    this.lz = new Float32Array(n1);
    this.widthLeft = new Float32Array(n1);
    this.widthRight = new Float32Array(n1);
    this.wallLeft = new Float32Array(n1);
    this.wallRight = new Float32Array(n1);
    this.curvature = new Float32Array(n1);
    this.bank = new Float32Array(n1);

    const h = p.spacing;
    for (let i = 0; i <= N; i++) {
      const ip = i === 0 ? N - 1 : i - 1;
      const inx = i === N ? 1 : i + 1;
      this.M[i] = (p.Y[inx] - p.Y[ip]) / (2 * h);
      this.TB[i] = Math.tan(p.BANK[i]);
    }
    for (let i = 0; i <= N; i++) {
      const ip = i === 0 ? N - 1 : i - 1;
      const inx = i === N ? 1 : i + 1;
      this.DTB[i] = (this.TB[inx] - this.TB[ip]) / (2 * h);
    }

    const mkSide = (c: SideChannels, W: Float64Array, sign: 1 | -1): SideArrays => {
      const Cc = new Float64Array(n1);
      const E = new Float64Array(n1);
      const wall = new Float64Array(n1);
      for (let i = 0; i <= N; i++) {
        const bankFade = 1 - Math.min(1, Math.abs(p.BANK[i]) / 0.045);
        Cc[i] = (this.crown * W[i] * 0.5) * bankFade;
        E[i] = sign * this.TB[i] - (2 * Cc[i]) / W[i];
        wall[i] = W[i] + c.curbW[i] + c.b1W[i] + c.b2W[i];
      }
      return { W, C: Cc, E, curbW: c.curbW, curbK: c.curbK, curbH0: c.curbH0, curbH1: c.curbH1, b1W: c.b1W, b1S: c.b1S, b2W: c.b2W, b2S: c.b2S, bowl1: c.bowl1, bowl2: c.bowl2, barrier: c.barrier, cross: c.cross, wall };
    };
    this.L = mkSide(p.ch.L, p.WL, 1);
    this.R = mkSide(p.ch.R, p.WR, -1);
    this.roadSurf = p.ch.road;
    this.farSurf = SURF_CODE[p.def.winter?.ground ?? (p.def.winter ? 'deepsnow' : 'grass')];
    this.iceLake = p.iceLake ?? null;

    // Frames
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i <= N; i++) {
      const phi = p.PHI[i];
      const sp = Math.sin(phi);
      const cp = Math.cos(phi);
      this.HTX[i] = sp;
      this.HTZ[i] = cp;
      this.HLX[i] = cp;
      this.HLZ[i] = -sp;
      const m = this.M[i];
      const inv = 1 / Math.sqrt(1 + m * m);
      const ca = inv;
      const sa = m * inv;
      const bk = p.BANK[i];
      const cb = Math.cos(bk);
      const sb = Math.sin(bk);
      // n0 = t3 x hl
      const n0x = -sa * sp;
      const n0y = ca;
      const n0z = -sa * cp;
      this.px[i] = p.X[i];
      this.py[i] = p.Y[i];
      this.pz[i] = p.Z[i];
      this.tx[i] = ca * sp;
      this.ty[i] = sa;
      this.tz[i] = ca * cp;
      this.lx[i] = cb * cp + sb * n0x;
      this.ly[i] = sb * n0y;
      this.lz[i] = cb * -sp + sb * n0z;
      this.nx[i] = cb * n0x - sb * cp;
      this.ny[i] = cb * n0y;
      this.nz[i] = cb * n0z - sb * -sp;
      this.widthLeft[i] = p.WL[i];
      this.widthRight[i] = p.WR[i];
      this.wallLeft[i] = this.L.wall[i];
      this.wallRight[i] = this.R.wall[i];
      this.curvature[i] = p.KAPPA[i];
      this.bank[i] = bk;
      const wl = this.L.wall[i];
      const wr = this.R.wall[i];
      for (const dd of [wl, -wr]) {
        const x = p.X[i] + dd * cp;
        const z = p.Z[i] - dd * sp;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      if (p.Y[i] < minY) minY = p.Y[i];
      if (p.Y[i] > maxY) maxY = p.Y[i];
    }
    this.bounds = { minX, maxX, minZ, maxZ, minY, maxY };

    for (let i = 0; i < N; i++) this.maxWall = Math.max(this.maxWall, this.L.wall[i], this.R.wall[i]);
    this.tunnelMask = new Uint8Array(N + 1);
    this.carveSkip = new Uint8Array(N + 1);
    for (const tn of p.def.tunnels ?? []) {
      const nm = (m: import('./types').Mark) => (typeof m === 'string' ? m : m[0]);
      const off = (m: import('./types').Mark) => (typeof m === 'string' ? 0 : m[1]);
      const s0 = (((p.plan.marks.get(nm(tn.from)) ?? 0) + off(tn.from)) % p.length + p.length) % p.length;
      const s1 = (((p.plan.marks.get(nm(tn.to)) ?? 0) + off(tn.to)) % p.length + p.length) % p.length;
      this.tunnelSpans.push([s0, s1]);
      for (let i = Math.ceil(s0 / p.spacing); i <= Math.floor(s1 / p.spacing) && i < N; i++) this.tunnelMask[i] = 1;
      for (let i = Math.ceil((s0 + 12) / p.spacing); i <= Math.floor((s1 - 12) / p.spacing) && i < N; i++) this.carveSkip[i] = 1;
    }
    this.buildGrid();
    this.grid = this.buildStartGrid();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Spatial grid + nearest sample
  // ───────────────────────────────────────────────────────────────────────────

  private buildGrid(): void {
    const N = this.N;
    const cell = 40;
    const minX = this.bounds.minX - 80;
    const minZ = this.bounds.minZ - 80;
    const nx = Math.ceil((this.bounds.maxX + 80 - minX) / cell) + 1;
    const nz = Math.ceil((this.bounds.maxZ + 80 - minZ) / cell) + 1;
    const counts = new Int32Array(nx * nz + 1);
    const cellOf = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      const cx = Math.floor((this.X[i] - minX) / cell);
      const cz = Math.floor((this.Z[i] - minZ) / cell);
      const c = cz * nx + cx;
      cellOf[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < nx * nz; c++) counts[c + 1] += counts[c];
    const fill = counts.slice(0, nx * nz);
    const items = new Int32Array(N);
    for (let i = 0; i < N; i++) items[fill[cellOf[i]]++] = i;
    this.gMinX = minX;
    this.gMinZ = minZ;
    this.gCell = cell;
    this.gNx = nx;
    this.gNz = nz;
    this.gStart = counts;
    this.gItems = items;
  }

  /** Index of the centerline sample nearest to (x, z). Global (grid) search. */
  nearestSample(x: number, z: number): number {
    const X = this.X;
    const Z = this.Z;
    const N = this.N;
    const nx = this.gNx;
    const nz = this.gNz;
    const cell = this.gCell;
    const fx = (x - this.gMinX) / cell;
    const fz = (z - this.gMinZ) / cell;
    if (fx < -0.5 || fz < -0.5 || fx > nx + 0.5 || fz > nz + 0.5) {
      // far outside: coarse brute force, then refine
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < N; i += 8) {
        const dx = X[i] - x;
        const dz = Z[i] - z;
        const dd = dx * dx + dz * dz;
        if (dd < bd) {
          bd = dd;
          best = i;
        }
      }
      let b2 = best;
      for (let k = -8; k <= 8; k++) {
        const i = (best + k + N) % N;
        const dx = X[i] - x;
        const dz = Z[i] - z;
        const dd = dx * dx + dz * dz;
        if (dd < bd) {
          bd = dd;
          b2 = i;
        }
      }
      return b2;
    }
    const cx = Math.min(nx - 1, Math.max(0, Math.floor(fx)));
    const cz = Math.min(nz - 1, Math.max(0, Math.floor(fz)));
    const start = this.gStart;
    const items = this.gItems;
    let best = -1;
    let bd = Infinity;
    const maxR = Math.max(nx, nz);
    for (let r = 0; r <= maxR; r++) {
      const z0 = cz - r;
      const z1 = cz + r;
      const x0 = cx - r;
      const x1 = cx + r;
      for (let gz = z0; gz <= z1; gz++) {
        if (gz < 0 || gz >= nz) continue;
        const edgeRow = gz === z0 || gz === z1;
        const step = edgeRow || r === 0 ? 1 : x1 - x0;
        for (let gx = x0; gx <= x1; gx += step) {
          if (gx < 0 || gx >= nx) continue;
          const c = gz * nx + gx;
          for (let k = start[c], ke = start[c + 1]; k < ke; k++) {
            const i = items[k];
            const dx = X[i] - x;
            const dz = Z[i] - z;
            const dd = dx * dx + dz * dz;
            if (dd < bd) {
              bd = dd;
              best = i;
            }
          }
          if (step === 0) break;
        }
      }
      if (best >= 0) {
        const lim = r * cell;
        if (bd <= lim * lim) break;
      }
    }
    return best < 0 ? 0 : best;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Projection (bilinear patch inverse)
  // ───────────────────────────────────────────────────────────────────────────

  /** Solve patch i for the point; writes this._t and this._d. */
  private solve(i: number, x: number, z: number): void {
    const X = this.X;
    const Z = this.Z;
    const HLX = this.HLX;
    const HLZ = this.HLZ;
    const j = i + 1;
    const ax = X[j] - X[i];
    const az = Z[j] - Z[i];
    const bx = HLX[i];
    const bz = HLZ[i];
    const cx = HLX[j] - bx;
    const cz = HLZ[j] - bz;
    const qx = x - X[i];
    const qz = z - Z[i];
    const A = ax * cz - az * cx;
    const B = ax * bz - az * bx - (qx * cz - qz * cx);
    const C = -(qx * bz - qz * bx);
    let t: number;
    if (B > -1e-9 && B < 1e-9) {
      t = 0;
    } else {
      const t0 = -C / B;
      if (A > -1e-12 && A < 1e-12) {
        t = t0;
      } else {
        const disc = B * B - 4 * A * C;
        if (disc < 0) t = t0;
        else {
          const sq = Math.sqrt(disc);
          const qq = -0.5 * (B + (B >= 0 ? sq : -sq));
          const r1 = qq / A;
          const r2 = qq !== 0 ? C / qq : t0;
          t = Math.abs(r1 - t0) < Math.abs(r2 - t0) ? r1 : r2;
        }
      }
    }
    if (t !== t) t = 0;
    const lx = bx + t * cx;
    const lz = bz + t * cz;
    this._t = t;
    this._d = ((qx - t * ax) * lx + (qz - t * az) * lz) / (lx * lx + lz * lz);
  }

  /** Find the patch containing (x, z); returns segment index, sets this._t (clamped) and this._d. */
  private locate(x: number, z: number, hint: number): number {
    const N = this.N;
    let i = hint >= 0 && hint < N ? hint | 0 : this.nearestSample(x, z);
    let steps = 0;
    let fallbacks = 0;
    for (;;) {
      this.solve(i, x, z);
      const t = this._t;
      if (t > 1) i = i + 1 >= N ? 0 : i + 1;
      else if (t < 0) i = i - 1 < 0 ? N - 1 : i - 1;
      else break;
      if (++steps > 96) {
        if (++fallbacks > 1) {
          this.solve(i, x, z);
          this._t = this._t < 0 ? 0 : this._t > 1 ? 1 : this._t;
          break;
        }
        i = this.nearestSample(x, z);
        steps = 0;
      }
    }
    // A stale hint can latch onto the wrong leg of a hairpin (a bilinear patch covers every lateral offset):
    // re-check globally whenever the result lies outside the barrier corridor of the patch it found.
    {
      const d = this._d;
      const wall = d >= 0 ? this.L.wall[i] : this.R.wall[i];
      const ad = d < 0 ? -d : d;
      if (ad > wall + 3 && hint >= 0) {
        const g = this.nearestSample(x, z);
        let dseg = g - i;
        if (dseg < 0) dseg = -dseg;
        if (dseg > 2 && dseg < N - 2) {
          const d0 = this._d;
          const t0 = this._t;
          let k = g;
          steps = 0;
          for (;;) {
            this.solve(k, x, z);
            const tt = this._t;
            if (tt > 1) k = k + 1 >= N ? 0 : k + 1;
            else if (tt < 0) k = k - 1 < 0 ? N - 1 : k - 1;
            else break;
            if (++steps > 96) break;
          }
          const nd = this._d < 0 ? -this._d : this._d;
          if (nd < ad && this._t >= 0 && this._t <= 1) return k;
          this._d = d0;
          this._t = t0;
        }
      }
    }
    return i;
  }

  project(x: number, z: number, out: TrackPoint, hint = -1): number {
    const i = this.locate(x, z, hint);
    const t = this._t;
    const j = i + 1;
    const om = 1 - t;
    out.s = (i + t) * this.spacing;
    if (out.s >= this.length) out.s -= this.length;
    out.d = this._d;
    out.segment = t < 0.5 ? i : j >= this.N ? 0 : j;
    out.widthLeft = this.L.W[i] * om + this.L.W[j] * t;
    out.widthRight = this.R.W[i] * om + this.R.W[j] * t;
    out.wallLeft = this.L.wall[i] * om + this.L.wall[j] * t;
    out.wallRight = this.R.wall[i] * om + this.R.wall[j] * t;
    out.softLeft = BAR_SOFT[this.L.barrier[i]];
    out.softRight = BAR_SOFT[this.R.barrier[i]];
    let tx = this.HTX[i] * om + this.HTX[j] * t;
    let tz = this.HTZ[i] * om + this.HTZ[j] * t;
    const inv = 1 / Math.sqrt(tx * tx + tz * tz);
    tx *= inv;
    tz *= inv;
    out.tx = tx;
    out.tz = tz;
    out.lx = tz;
    out.lz = -tx;
    out.y = hermite(this.Y[i], this.M[i], this.Y[j], this.M[j], this.spacing, t);
    return out.segment;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Ground height
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Evaluate the cross-section at patch (i, t), lateral offset d, world (x, z).
   * Sets _h (height), _hs (dh/ds), _hd (dh/dd), _surf, and _fd (true when beyond the analytic zone).
   */
  private evalAt(i: number, t: number, d: number, x: number, z: number, s: number): number {
    const j = i + 1;
    const om = 1 - t;
    const sp = this.spacing;
    const yc = hermite(this.Y[i], this.M[i], this.Y[j], this.M[j], sp, t);
    const mc = hermiteSlope(this.Y[i], this.M[i], this.Y[j], this.M[j], sp, t);
    const tb = this.TB[i] * om + this.TB[j] * t;
    const dtb = this.DTB[i] * om + this.DTB[j] * t;
    const left = d >= 0;
    const S = left ? this.L : this.R;
    const ad = left ? d : -d;
    const w = S.W[i] * om + S.W[j] * t;
    this._fd = false;
    if (ad <= w) {
      const cc = S.C[i] * om + S.C[j] * t;
      const q = d / w;
      this._h = yc + d * tb - cc * q * q;
      this._hd = tb - (2 * cc * d) / (w * w);
      this._hs = mc + d * dtb;
      this._surf = this.roadSurf[t < 0.5 ? i : j];
      return this._h;
    }
    const u = ad - w;
    const sgn = left ? 1 : -1;
    const cc = S.C[i] * om + S.C[j] * t;
    const e = S.E[i] * om + S.E[j] * t;
    const hEdge = yc + sgn * w * tb - cc;
    const cw = S.curbW[i] * om + S.curbW[j] * t;
    const b1 = S.b1W[i] * om + S.b1W[j] * t;
    const b2 = S.b2W[i] * om + S.b2W[j] * t;
    const cross = S.cross[i] * om + S.cross[j] * t;
    // shoulder rollover from the edge slope to the cross-fall
    let off: number;
    let doff: number;
    {
      const x3 = u / 3;
      if (x3 < 1) {
        const f = 3 * (x3 * x3 * x3 - 0.5 * x3 * x3 * x3 * x3);
        off = e * u + (cross - e) * f;
        doff = e + (cross - e) * (x3 * x3 * (3 - 2 * x3));
      } else {
        off = e * u + (cross - e) * (1.5 + (u - 3));
        doff = cross;
      }
    }
    let hsExtra = 0;
    let surf: number;
    const uWall = cw + b1 + b2;
    if (cw > 0.02 && u < cw) {
      surf = 1;
      const rw = curbRamp(cw);
      const a1 = u / rw;
      const a2 = (cw - u) / rw;
      const in1 = a1 >= 1 ? 1 : a1 * a1 * (3 - 2 * a1);
      const in2 = a2 >= 1 ? 1 : a2 * a2 * (3 - 2 * a2);
      const lat = in1 * in2;
      const dlat = (a1 < 1 ? (6 * a1 * (1 - a1)) / rw : 0) * in2 - in1 * (a2 < 1 ? (6 * a2 * (1 - a2)) / rw : 0);
      const base = S.curbH0[i] * om + S.curbH0[j] * t;
      const amp = S.curbH1[i] * om + S.curbH1[j] * t;
      let ph = s / RIDGE_PERIOD;
      ph -= Math.floor(ph);
      const rp = ridgeProfile(ph);
      const hc = base + amp * rp;
      off += lat * hc;
      doff += dlat * hc;
      hsExtra = (lat * amp * ridgeSlope(ph)) / RIDGE_PERIOD;
    } else {
      const u1 = u - cw;
      if (u1 < b1) surf = S.b1S[i];
      else if (u1 < b1 + b2) surf = S.b2S[i];
      else surf = this.farSurf;
      // gravel beds sit slightly lower than the surroundings (smooth fractions: never a step)
      const f1 = S.bowl1[i] * om + S.bowl1[j] * t;
      const f2 = S.bowl2[i] * om + S.bowl2[j] * t;
      if (f1 > 0.001 && b1 > 0.05) {
        off -= this.bowl(u, cw, cw + b1, f1);
        doff -= this._bd;
      }
      if (f2 > 0.001 && b2 > 0.05) {
        off -= this.bowl(u, cw + b1, cw + b1 + b2, f2);
        doff -= this._bd;
      }
    }
    const ext = hEdge + off;
    this._surf = surf;
    const dsx = mc + d * dtb + hsExtra;
    // beyond the analytic zone: cross-fade to the baked terrain
    const uf = uWall + XFADE_START;
    if (u > uf) {
      this.ensureField();
      const wgt = smoothstep(uf, uWall + this.xfadeEnd, u);
      const hf = this.fieldHeight(x, z);
      this._h = ext + (hf - ext) * wgt;
      this._fd = true;
      this._surf = this.farSurf;
      this._hs = dsx;
      this._hd = sgn * doff;
      return this._h;
    }
    this._h = ext;
    this._hs = dsx;
    this._hd = sgn * doff;
    return ext;
  }

  /** Depth of a gravel bed between u0 and u1 at u (positive = lower); derivative in this._bd. */
  private bowl(u: number, u0: number, u1: number, f: number): number {
    const ra = clamp((u - u0) / 0.8, 0, 1);
    const rb = clamp((u1 - u) / 0.8, 0, 1);
    const sa = ra * ra * (3 - 2 * ra);
    const sb = rb * rb * (3 - 2 * rb);
    const depth = 0.04 * f;
    this._bd = depth * ((ra > 0 && ra < 1 ? (6 * ra * (1 - ra)) / 0.8 : 0) * sb - sa * (rb > 0 && rb < 1 ? (6 * rb * (1 - rb)) / 0.8 : 0));
    return depth * sa * sb;
  }

  groundAt(x: number, z: number, out: GroundSample, hint = -1): number {
    const i = this.locate(x, z, hint);
    const t = this._t;
    const d = this._d;
    const s = (i + t) * this.spacing;
    const h = this.evalAt(i, t, d, x, z, s);
    out.height = h;
    out.surface = SURF_NAME[this._surf] as SurfaceType;
    if (this._fd) {
      // blended / field zone: central differences of the scalar height
      const e = 0.6;
      const hx = (this.heightXZ(x + e, z, i) - this.heightXZ(x - e, z, i)) / (2 * e);
      const hz = (this.heightXZ(x, z + e, i) - this.heightXZ(x, z - e, i)) / (2 * e);
      const inv = 1 / Math.sqrt(hx * hx + 1 + hz * hz);
      out.normal.set(-hx * inv, inv, -hz * inv);
      return i;
    }
    const j = i + 1;
    const om = 1 - t;
    const kd = Math.max(0.2, 1 - (this.KAP[i] * om + this.KAP[j] * t) * d);
    const txx = this.HTX[i] * om + this.HTX[j] * t;
    const tzz = this.HTZ[i] * om + this.HTZ[j] * t;
    const lxx = this.HLX[i] * om + this.HLX[j] * t;
    const lzz = this.HLZ[i] * om + this.HLZ[j] * t;
    const hx = (this._hs * txx) / kd + this._hd * lxx;
    const hz = (this._hs * tzz) / kd + this._hd * lzz;
    const inv = 1 / Math.sqrt(hx * hx + 1 + hz * hz);
    out.normal.set(-hx * inv, inv, -hz * inv);
    return i;
  }

  /**
   * How far (x, z) lies beyond the outer edge of the near-road strip meshes (wall + xfadeEnd + 5 m). Negative = inside.
   * Scene-building helper (not for the hot physics path).
   */
  stripMargin(x: number, z: number, hint = -1): number {
    const i = this.locate(x, z, hint);
    this.lastSegment = i;
    const t = this._t;
    const d = this._d;
    const S = d >= 0 ? this.L : this.R;
    const wall = S.wall[i] * (1 - t) + S.wall[i + 1] * t;
    const m = (d < 0 ? -d : d) - (wall + this.xfadeEnd + 5 - 0.3);
    // over a tunnel the terrain tiles leave the corridor + 12.5 m to the tunnel cap mesh
    if (this.tunnelMask[i]) return (d < 0 ? -d : d) - (wall + 12.5);
    return m;
  }

  /** Ground height anywhere; skips the road projection when far from every road (terrain building). */
  heightFast(x: number, z: number): number {
    const i = this.nearestSample(x, z);
    const dx = this.X[i] - x;
    const dz = this.Z[i] - z;
    const lim = this.maxWall + this.xfadeEnd + 12;
    if (dx * dx + dz * dz > lim * lim) return this.fieldHeight(x, z);
    return this.heightXZ(x, z, i);
  }

  /**
   * The ground as it is drawn, for questions asked of a whole region (the sun visibility map asks a few hundred thousand): the road's
   * own surface within reach of the road (where the baked field is not what is drawn: a road in a cutting is below it) and the
   * baked field everywhere else, which is nearly everywhere and which heightFast would reach only after a ring search for the nearest
   * road sample. A point is near the road when a grid cell of the spatial grid within the corridor's reach of it holds a sample.
   */
  drawnHeight(x: number, z: number): number {
    const cell = this.gCell;
    const cx = Math.floor((x - this.gMinX) / cell);
    const cz = Math.floor((z - this.gMinZ) / cell);
    // (heightFast's corridor: maxWall + xfadeEnd + 12 m from the road; a road sample within it is in a cell at most this many cells away)
    const r = Math.ceil((this.maxWall + this.xfadeEnd + 12) / cell);
    const nx = this.gNx;
    const nz = this.gNz;
    const x0 = Math.max(0, cx - r);
    const x1 = Math.min(nx - 1, cx + r);
    if (x0 <= x1) {
      const start = this.gStart;
      for (let gz = Math.max(0, cz - r), z1 = Math.min(nz - 1, cz + r); gz <= z1; gz++) {
        // (the cells are laid out row by row: the samples of a run of cells in a row are a run of the item list)
        if (start[gz * nx + x1 + 1] > start[gz * nx + x0]) return this.heightFast(x, z);
      }
    }
    return this.fieldHeight(x, z);
  }

  /** Scalar ground height at (x, z); `hint` speeds up the search. */
  heightXZ(x: number, z: number, hint = -1): number {
    const i = this.locate(x, z, hint);
    return this.evalAt(i, this._t, this._d, x, z, (i + this._t) * this.spacing);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // pointAt / frameAt / wrapS
  // ───────────────────────────────────────────────────────────────────────────

  wrapS(s: number): number {
    const L = this.length;
    if (s >= 0 && s < L) return s;
    s -= Math.floor(s / L) * L;
    return s >= L ? 0 : s;
  }

  /** World XZ of (s, d) via the same bilinear patch map used by project(). Returns segment index; xz in _px/_pz. */
  private patchXZ(s: number, d: number, out: Vector3): number {
    const f = this.wrapS(s) / this.spacing;
    let i = Math.floor(f);
    if (i >= this.N) i = this.N - 1;
    const t = f - i;
    const j = i + 1;
    const om = 1 - t;
    out.x = this.X[i] * om + this.X[j] * t + d * (this.HLX[i] * om + this.HLX[j] * t);
    out.z = this.Z[i] * om + this.Z[j] * t + d * (this.HLZ[i] * om + this.HLZ[j] * t);
    this._t = t;
    return i;
  }

  pointAt(s: number, d: number, out: Vector3): Vector3 {
    const i = this.patchXZ(s, d, out);
    out.y = this.evalAt(i, this._t, d, out.x, out.z, this.wrapS(s));
    return out;
  }

  /** Height at (s, d) (same function as groundAt would give at the point's XZ). */
  heightSD(s: number, d: number): number {
    const v = TMP_V;
    const i = this.patchXZ(s, d, v);
    return this.evalAt(i, this._t, d, v.x, v.z, this.wrapS(s));
  }

  frameAt(s: number, out: TrackFrame): TrackFrame {
    const f = this.wrapS(s) / this.spacing;
    let i = Math.floor(f);
    if (i >= this.N) i = this.N - 1;
    const t = f - i;
    const j = i + 1;
    const om = 1 - t;
    out.position.set(
      this.px[i] * om + this.px[j] * t,
      hermite(this.Y[i], this.M[i], this.Y[j], this.M[j], this.spacing, t),
      this.pz[i] * om + this.pz[j] * t,
    );
    out.tangent.set(this.tx[i] * om + this.tx[j] * t, this.ty[i] * om + this.ty[j] * t, this.tz[i] * om + this.tz[j] * t).normalize();
    out.normal.set(this.nx[i] * om + this.nx[j] * t, this.ny[i] * om + this.ny[j] * t, this.nz[i] * om + this.nz[j] * t).normalize();
    out.left.set(this.lx[i] * om + this.lx[j] * t, this.ly[i] * om + this.ly[j] * t, this.lz[i] * om + this.lz[j] * t).normalize();
    out.widthLeft = this.L.W[i] * om + this.L.W[j] * t;
    out.widthRight = this.R.W[i] * om + this.R.W[j] * t;
    out.wallLeft = this.L.wall[i] * om + this.L.wall[j] * t;
    out.wallRight = this.R.wall[i] * om + this.R.wall[j] * t;
    out.curvature = this.KAP[i] * om + this.KAP[j] * t;
    out.bank = this.bank[i] * om + this.bank[j] * t;
    return out;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Baked terrain field (T + E)
  // ───────────────────────────────────────────────────────────────────────────

  /** Natural terrain + the road carve. */
  fieldHeight(x: number, z: number): number {
    const T = this.terrain(x, z);
    if (!this.fReady) return T;
    const fx = (x - this.fMinX) / this.fCell;
    const fz = (z - this.fMinZ) / this.fCell;
    if (fx < 0 || fz < 0 || fx >= this.fNx - 1 || fz >= this.fNz - 1) return T;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const E = this.fE;
    const nx = this.fNx;
    const k = iz * nx + ix;
    const e00 = E[k];
    const e10 = E[k + 1];
    const e01 = E[k + nx];
    const e11 = E[k + nx + 1];
    const e = (e00 * (1 - tx) + e10 * tx) * (1 - tz) + (e01 * (1 - tx) + e11 * tx) * tz;
    return T + e;
  }

  get fieldReady(): boolean {
    return this.fReady;
  }

  /** Build the carve field E (idempotent). ~30-60 ms. */
  ensureField(): void {
    if (this.fReady) return;
    const N = this.N;
    const reach = this.carveReach;
    const falloff = this.def.terrain.falloff ?? reach;
    const support = reach + 30;
    const cell = Math.max(3, Math.min(8, Math.round((reach / 14) * 2) / 2));
    const minX = this.bounds.minX - support;
    const minZ = this.bounds.minZ - support;
    const nx = Math.ceil((this.bounds.maxX + support - minX) / cell) + 2;
    const nz = Math.ceil((this.bounds.maxZ + support - minZ) / cell) + 2;
    const num = new Float32Array(nx * nz);
    const den = new Float32Array(nx * nz);
    const dmin = new Float32Array(nx * nz).fill(1e9);
    const step = Math.max(1, Math.round(4 / this.spacing));
    const eps2 = 16;
    const sup2 = support * support;
    for (let i = 0; i < N; i += step) {
      if (this.carveSkip[i]) continue;
      for (const sgn of [1, -1] as const) {
        const S = sgn > 0 ? this.L : this.R;
        const dd = sgn * (S.wall[i] + (XFADE_START + this.xfadeEnd) / 2);
        const px = this.X[i] + dd * this.HLX[i];
        const pz = this.Z[i] + dd * this.HLZ[i];
        const hext = this.extOnly(i, dd, px, pz);
        const delta = hext - this.terrain(px, pz);
        const cx0 = Math.max(0, Math.floor((px - support - minX) / cell));
        const cx1 = Math.min(nx - 1, Math.ceil((px + support - minX) / cell));
        const cz0 = Math.max(0, Math.floor((pz - support - minZ) / cell));
        const cz1 = Math.min(nz - 1, Math.ceil((pz + support - minZ) / cell));
        for (let cz = cz0; cz <= cz1; cz++) {
          const wz = minZ + cz * cell - pz;
          for (let cx = cx0; cx <= cx1; cx++) {
            const wx = minX + cx * cell - px;
            const r2 = wx * wx + wz * wz;
            if (r2 > sup2) continue;
            const r = Math.sqrt(r2);
            const win = 1 - r / support;
            const w = (win * win) / (r2 + eps2);
            const k = cz * nx + cx;
            num[k] += w * delta;
            den[k] += w;
            if (r < dmin[k]) dmin[k] = r;
          }
        }
      }
    }
    const E = new Float32Array(nx * nz);
    for (let k = 0; k < E.length; k++) {
      if (den[k] > 0) {
        const kk = 1 - smootherstep(0, falloff, dmin[k]);
        E[k] = (num[k] / den[k]) * kk;
      }
    }
    this.fMinX = minX;
    this.fMinZ = minZ;
    this.fCell = cell;
    this.fNx = nx;
    this.fNz = nz;
    this.fE = E;
    this.fReady = true;
  }

  /** Analytic profile extension height (no terrain blend) at lateral offset dd of sample i. */
  private extOnly(i: number, dd: number, x: number, z: number): number {
    // evalAt with u inside the analytic zone only (the caller picks dd = wall + 3.5 which is in the cross-fade
    // zone, so evaluate manually without the blend):
    const left = dd >= 0;
    const S = left ? this.L : this.R;
    const sgn = left ? 1 : -1;
    const ad = left ? dd : -dd;
    const w = S.W[i];
    const u = ad - w;
    const yc = this.Y[i];
    const tb = this.TB[i];
    const cc = S.C[i];
    const e = S.E[i];
    const cross = S.cross[i];
    const hEdge = yc + sgn * w * tb - cc;
    const x3 = u / 3;
    let off: number;
    if (x3 < 1) off = e * u + (cross - e) * 3 * (x3 * x3 * x3 - 0.5 * x3 * x3 * x3 * x3);
    else off = e * u + (cross - e) * (1.5 + (u - 3));
    void x;
    void z;
    return hEdge + off;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Starting grid
  // ───────────────────────────────────────────────────────────────────────────

  private buildStartGrid(): GridSlot[] {
    const slots: GridSlot[] = [];
    const f: TrackFrame = {
      position: new Vector3(),
      tangent: new Vector3(),
      normal: new Vector3(),
      left: new Vector3(),
      widthLeft: 0,
      widthRight: 0,
      wallLeft: 0,
      wallRight: 0,
      curvature: 0,
      bank: 0,
    };
    const count = 20;
    const mat = new Matrix4();
    for (let k = 0; k < count; k++) {
      const row = k >> 1;
      const odd = k & 1;
      const s = this.wrapS(-(8 + row * 8 + odd * 4));
      const d = odd ? -3.2 : 3.2;
      this.frameAt(s, f);
      const pos = new Vector3();
      this.pointAt(s, d, pos);
      // orientation: x = left, y = normal, z = tangent
      const q = new Quaternion();
      mat.makeBasis(f.left, f.normal, f.tangent);
      q.setFromRotationMatrix(mat);
      slots.push({ position: pos, quaternion: q, s, d });
    }
    return slots;
  }
}

const TMP_V = new Vector3();
