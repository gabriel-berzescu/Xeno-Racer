/**
 * The procedural city. Building lots line both sides of the circuit in rows behind the barriers and sidewalks (a front row on the
 * street, more rows climbing the hill behind it), a skyline of distant blocks fills the hillsides, and palms stand along the streets.
 *
 * Everything is merged geometry: a building is a handful of flat quads (a facade per street sample so that facades follow curved
 * streets, side and back walls, a roof) with uv in metres; the windows, shutters, shop fronts and plaster are drawn by the facade
 * shader (facade.ts) from a per-building seed. Finer geometry (cornices, parapets, chimneys, balconies, awnings) sits in a second
 * mesh per chunk that is only drawn near the camera; chunks far away drop their shadows and, beyond the haze, themselves.
 *
 * Lots are laid out in (s, d) street coordinates, so a row of lots tiles the street without gaps (fanning out on the outside of
 * a bend); a lot is kept only if it clears every road of the circuit, the water and the lots already placed.
 */
import * as THREE from 'three';
import { Noise2, clamp, mulberry32, smoothstep } from '../math';
import { resolveMark } from '../plan';
import type { CityDef, Mark, SideSel, SpeciesId } from '../types';
import type { TrackPoint } from '../../core/contracts';
import type { Ctx } from './ctx';
import { FACADE_KIND, makeFacadeMaterial } from './facade';
import { CityBuf, type Pt3, type Style, hash11, hipRoof, linear } from './cityBuf';
import { ARCH_REACH, emitArch, emitLandmark, placeLandmark } from './landmarks';
import { lerpS } from './road';
import type { Inst } from './trees';

// ── palette ─────────────────────────────────────────────────────────────────────

/** Mediterranean plasters: ochre, terracotta, cream, white and pastels (sRGB hex, weight). */
const WALLS: [number, number][] = [
  [0xdcae5e, 3], // ochre
  [0xe8c77a, 2], // warm yellow
  [0xc9744a, 2], // terracotta
  [0xd98b52, 1.5], // burnt orange
  [0xe2a38a, 2], // salmon
  [0xd9a0a0, 1], // rose
  [0xf0e2c4, 3], // cream
  [0xf3efe6, 3], // white
  [0xb4cbd6, 1], // pale blue
  [0xb9c3a2, 1], // sage
  [0xd8c39d, 2], // sand
  [0xc9c3b6, 1.5], // stone
  [0xa8523a, 0.7], // deep red
  [0xaad1bf, 0.6], // mint
];
const ROOFS = [0xb85a35, 0xc4683c, 0xa84e2e, 0xb06a48, 0x9d5a3f, 0x8c6b55];
const WALL_TOTAL = WALLS.reduce((a, w) => a + w[1], 0);

// ── lots ────────────────────────────────────────────────────────────────────────

type Pt = [number, number];

interface Lot {
  /** A landmark's footprint: kept clear of lots, drawn elsewhere. */
  skip?: boolean;
  sgn: 1 | -1;
  s0: number;
  s1: number;
  d0: number;
  d1: number;
  floors: number;
  tile: boolean;
  style: Style;
  roofCol: [number, number, number];
  hip: number;
  /** Footprint corners (front-left, front-right, back-right, back-left) on the map, for overlap tests. */
  quad: Pt[];
}

/** Do two convex quads overlap (separating axis test, with a margin)? */
function quadsOverlap(a: Pt[], b: Pt[], margin: number): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      let nx = -(q[1] - p[1]);
      let nz = q[0] - p[0];
      const l = Math.hypot(nx, nz) || 1;
      nx /= l;
      nz /= l;
      let minA = Infinity;
      let maxA = -Infinity;
      let minB = Infinity;
      let maxB = -Infinity;
      for (const c of a) {
        const d = c[0] * nx + c[1] * nz;
        if (d < minA) minA = d;
        if (d > maxA) maxA = d;
      }
      for (const c of b) {
        const d = c[0] * nx + c[1] * nz;
        if (d < minB) minB = d;
        if (d > maxB) maxB = d;
      }
      if (maxA + margin < minB || maxB + margin < minA) return false;
    }
  }
  return true;
}

class LotGrid {
  private readonly cell = 32;
  private readonly map = new Map<number, number[]>();
  readonly lots: Lot[] = [];
  private key(ix: number, iz: number): number {
    return ix * 100003 + iz;
  }
  add(lot: Lot): void {
    const id = this.lots.length;
    this.lots.push(lot);
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const [x, z] of lot.quad) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    for (let ix = Math.floor(x0 / this.cell); ix <= Math.floor(x1 / this.cell); ix++) {
      for (let iz = Math.floor(z0 / this.cell); iz <= Math.floor(z1 / this.cell); iz++) {
        const k = this.key(ix, iz);
        const a = this.map.get(k);
        if (a) a.push(id);
        else this.map.set(k, [id]);
      }
    }
  }
  overlaps(q: Pt[], margin: number): boolean {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const [x, z] of q) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    const seen = new Set<number>();
    for (let ix = Math.floor((x0 - margin) / this.cell); ix <= Math.floor((x1 + margin) / this.cell); ix++) {
      for (let iz = Math.floor((z0 - margin) / this.cell); iz <= Math.floor((z1 + margin) / this.cell); iz++) {
        const a = this.map.get(this.key(ix, iz));
        if (!a) continue;
        for (const id of a) {
          if (seen.has(id)) continue;
          seen.add(id);
          if (quadsOverlap(q, this.lots[id].quad, margin)) return true;
        }
      }
    }
    return false;
  }
  /** Is (x, z) within `margin` (up to one cell) of a lot's footprint? (The bounding circle of each lot, in the cells around the point.) */
  near(x: number, z: number, margin: number): boolean {
    const ix = Math.floor(x / this.cell);
    const iz = Math.floor(z / this.cell);
    for (let jx = ix - 1; jx <= ix + 1; jx++) {
      for (let jz = iz - 1; jz <= iz + 1; jz++) {
        const a = this.map.get(this.key(jx, jz));
        if (!a) continue;
        for (const id of a) {
          const c = this.circle(id);
          if (Math.hypot(x - c[0], z - c[1]) < c[2] + margin) return true;
        }
      }
    }
    return false;
  }
  private readonly circles = new Map<number, [number, number, number]>();
  private circle(id: number): [number, number, number] {
    let c = this.circles.get(id);
    if (!c) {
      const q = this.lots[id].quad;
      let cx = 0;
      let cz = 0;
      for (const p of q) {
        cx += p[0] / q.length;
        cz += p[1] / q.length;
      }
      let r = 0;
      for (const p of q) r = Math.max(r, Math.hypot(p[0] - cx, p[1] - cz));
      c = [cx, cz, r];
      this.circles.set(id, c);
    }
    return c;
  }
}

// ── the builder ─────────────────────────────────────────────────────────────────

interface Chunk {
  base: CityBuf;
  detail: CityBuf;
  far: boolean;
}

export interface CityResult {
  group: THREE.Group;
}

const _tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
const _v = new THREE.Vector3();

export function buildCity(ctx: Ctx): CityResult | null {
  const rt = ctx.rt;
  const cd: CityDef | undefined = rt.def.scenery?.city;
  if (!cd) return null;
  const N = rt.count;
  const L = rt.length;
  const h = rt.spacing;
  const rnd = mulberry32((cd.seed ?? 77) ^ 0x51ed270b);
  const noise = new Noise2((cd.seed ?? 77) * 3 + 11);
  const grid = new LotGrid();
  const sidewalk = cd.sidewalk ?? [3.2, 6];
  const rows = cd.rows ?? 2;
  const tun = rt.tunnelSpans;

  // ── where nothing stands: open stretches per side, the tunnel hills, the sea ───────────────
  const markSpan = (arr: Uint8Array, from: Mark, to: Mark, pad = 0): void => {
    const i0 = Math.round((resolveMark(rt.plan.marks, L, from) - pad) / h);
    let i1 = Math.round((resolveMark(rt.plan.marks, L, to) + pad) / h);
    if (i1 < i0) i1 += N;
    for (let i = i0; i <= i1; i++) arr[((i % N) + N) % N] = 1;
  };
  const openL = new Uint8Array(N + 1);
  const openR = new Uint8Array(N + 1);
  for (const o of cd.open ?? []) {
    if (o.side !== 'R') markSpan(openL, o.from, o.to);
    if (o.side !== 'L') markSpan(openR, o.from, o.to);
  }
  for (const [a, b] of tun) {
    for (let i = Math.floor((a - 25) / h); i <= Math.ceil((b + 25) / h); i++) {
      openL[((i % N) + N) % N] = 1;
      openR[((i % N) + N) % N] = 1;
    }
  }
  const isOpen = (sgn: 1 | -1, s: number): boolean => (sgn > 0 ? openL : openR)[Math.round(rt.wrapS(s) / h) % N] === 1;

  // ── floors by neighbourhood ─────────────────────────────────────────────────────────────────
  const spans = (cd.floors ?? []).map((f) => ({ a: resolveMark(rt.plan.marks, L, f.from), b: resolveMark(rt.plan.marks, L, f.to), min: f.min, max: f.max, side: f.side }));
  const floorsAt = (s: number, sgn: 1 | -1, row: number): number => {
    const ss = rt.wrapS(s);
    let lo = 2.2 + 1.6 * (0.5 + 0.5 * noise.noise(ss / 150, sgn * 3.7));
    let hi = lo + 2.2;
    for (const f of spans) {
      const inside = f.a <= f.b ? ss >= f.a && ss <= f.b : ss >= f.a || ss <= f.b;
      if (inside && (!f.side || f.side === 'B' || (f.side === 'L') === sgn > 0)) {
        lo = f.min;
        hi = f.max;
      }
    }
    return Math.max(1, Math.round(lo + (hi - lo) * rnd() + row * 0.9));
  };

  // ── choices ─────────────────────────────────────────────────────────────────────────────────
  const pickWall = (): number => {
    let r = rnd() * WALL_TOTAL;
    for (const [hex, w] of WALLS) {
      r -= w;
      if (r <= 0) return hex;
    }
    return WALLS[0][0];
  };
  const tmpC: number[] = [0, 0, 0];
  const mkStyle = (floors: number, w: number, hex: number): Style => {
    linear(hex, tmpC, 1);
    // the share of lit windows differs from block to block (a hotel, a quiet street)
    const lit = clamp(0.12 + 0.5 * rnd() * rnd() + 0.2 * rnd(), 0.08, 0.68);
    return { col: [tmpC[0], tmpC[1], tmpC[2]], seed: 0.02 + 0.96 * rnd(), floors, gH: 3.5 + 1.1 * rnd(), w, lit };
  };
  const roofColor = (): [number, number, number] => {
    linear(ROOFS[Math.floor(rnd() * ROOFS.length)], tmpC, 1);
    return [tmpC[0], tmpC[1], tmpC[2]];
  };

  const wallAt = (sgn: 1 | -1, s: number): number => lerpS(rt, sgn > 0 ? rt.L.wall : rt.R.wall, s);
  const kappaAt = (s: number): number => lerpS(rt, rt.curvature, s);

  /** Does the footprint clear every road (own side and other legs), the water, the reserved places? */
  const clear = (samples: Pt[]): boolean => {
    for (const [x, z] of samples) {
      if (rt.terrain.seaDistance(x, z) < 4) return false;
      rt.project(x, z, _tp, -1);
      const wall = _tp.d >= 0 ? _tp.wallLeft : _tp.wallRight;
      if (Math.abs(_tp.d) < wall + 2.4) return false;
      for (const r of ctx.reserved) if (r(x, z, 1)) return false;
    }
    return true;
  };

  // the landmarks (cathedral, castle): their footprints are taken before any street lot
  const places = (cd.landmarks ?? []).map((l) => placeLandmark(rt, l)).filter((p): p is NonNullable<typeof p> => !!p && p.def.kind !== 'lighthouse');
  for (const p of places) {
    const dummy: Style = { col: [1, 1, 1], seed: 0, floors: 0, gH: 0, w: 1, lit: 0 };
    grid.add({ skip: true, sgn: 1, s0: 0, s1: 0, d0: 0, d1: 0, floors: 0, tile: false, style: dummy, roofCol: [0, 0, 0], hip: 0, quad: p.quad });
  }

  // ── lot layout: rows along each side of the circuit ────────────────────────────────────────────
  const backD = [new Float32Array(N + 1), new Float32Array(N + 1)]; // back of the previous row per side
  for (const side of [1, -1] as const) {
    const si = side > 0 ? 0 : 1;
    for (let row = 0; row < rows; row++) {
      const prevBack = backD[si];
      const thisBack = new Float32Array(N + 1);
      let s = rnd() * 12;
      let prevFloors = -1;
      let prevWall = -1;
      let lastWasLot = false;
      while (s < L - 4) {
        const sMid0 = s + 6;
        if (isOpen(side, s) || isOpen(side, sMid0)) {
          s += 6;
          lastWasLot = false;
          continue;
        }
        // street style: narrow old-town lots or wide boulevard blocks
        const zone = noise.noise(s / 260 + 40, side * 5.1);
        const w = zone > 0.15 ? 12 + rnd() * 15 : 7.5 + rnd() * 8.5;
        if (row === 0 && lastWasLot && rnd() < 0.07) {
          // a side street
          s += 5 + rnd() * 3;
          lastWasLot = false;
          continue;
        }
        const s1 = s + w;
        // the front: behind the barrier and a sidewalk, or behind the row in front
        let front = 0;
        for (let ss = s; ss <= s1 + 0.01; ss += 2) front = Math.max(front, wallAt(side, ss));
        const sw = sidewalk[0] + (sidewalk[1] - sidewalk[0]) * rnd();
        const setback = row > 0 ? 0 : rnd() < 0.68 ? 0 : rnd() < 0.7 ? 1.5 + rnd() * 2.5 : 5 + rnd() * 5;
        let d0 = front + sw + setback;
        if (row > 0) {
          let pb = 0;
          for (let ss = s; ss <= s1 + 0.01; ss += 2) pb = Math.max(pb, prevBack[Math.round(rt.wrapS(ss) / h) % N]);
          d0 = Math.max(d0, pb + 3.5 + rnd() * 4);
        }
        const depth = (row === 0 ? 15 : 17) + rnd() * (row === 0 ? 10 : 14);
        let d1 = d0 + depth;
        // an inside corner: the offset curve shrinks to a point at 1 / kappa: stay well short of it
        let kmax = 0;
        for (let ss = s; ss <= s1 + 0.01; ss += 3) kmax = Math.max(kmax, side * kappaAt(ss));
        if (kmax > 1e-4) {
          const reach = 0.7 / kmax;
          if (d0 > reach - 4) {
            s += 6;
            lastWasLot = false;
            continue;
          }
          d1 = Math.min(d1, reach);
        }
        if (d1 - d0 < 7) {
          s += 6;
          lastWasLot = false;
          continue;
        }
        // footprint
        const m = Math.max(1, Math.ceil(w / 3));
        const samples: Pt[] = [];
        for (let k = 0; k <= m; k++) {
          const ss = s + (w * k) / m;
          for (const d of [d0, (d0 + d1) / 2, d1]) {
            rt.pointAt(ss, side * d, _v);
            samples.push([_v.x, _v.z]);
          }
        }
        const corner = (ss: number, d: number): Pt => {
          rt.pointAt(ss, side * d, _v);
          return [_v.x, _v.z];
        };
        const quad: Pt[] = [corner(s, d0), corner(s1, d0), corner(s1, d1), corner(s, d1)];
        // convex and not folded
        const area = (quad[1][0] - quad[0][0]) * (quad[3][1] - quad[0][1]) - (quad[1][1] - quad[0][1]) * (quad[3][0] - quad[0][0]);
        const frontLen = Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]);
        const backLen = Math.hypot(quad[2][0] - quad[3][0], quad[2][1] - quad[3][1]);
        if (Math.abs(area) < 40 || backLen < frontLen * 0.45 || frontLen < 5) {
          s += 6;
          lastWasLot = false;
          continue;
        }
        if (!clear(samples) || grid.overlaps(quad, 0.4)) {
          s += 5;
          lastWasLot = false;
          continue;
        }
        // neighbours never look alike: the storeys or the plaster must differ from the last lot's
        let floors = floorsAt(s + w / 2, side, row);
        let hex = pickWall();
        if (floors === prevFloors && hex === prevWall) floors = Math.max(1, floors + (rnd() < 0.5 ? -1 : 1));
        if (hex === prevWall) hex = pickWall();
        prevFloors = floors;
        prevWall = hex;
        const style = mkStyle(floors, w, hex);
        const tile = floors <= 5 && w < 19 ? rnd() < 0.72 : rnd() < 0.2;
        const lot: Lot = { sgn: side, s0: s, s1, d0, d1, floors, tile, style, roofCol: roofColor(), hip: 0.22 + 0.08 * rnd(), quad };
        grid.add(lot);
        for (let ss = s; ss <= s1 + 0.01; ss += 1) thisBack[Math.round(rt.wrapS(ss) / h) % N] = Math.max(thisBack[Math.round(rt.wrapS(ss) / h) % N], d1);
        s = s1;
        lastWasLot = true;
      }
      // the next row stands behind this one (or behind the street where this row has none)
      for (let i = 0; i < N; i++) backD[si][i] = Math.max(thisBack[i], 0);
    }
  }

  // the places where lots stand are not for trees
  ctx.reserved.push((x, z, margin) => grid.near(x, z, margin));

  // stone arches across the street: nothing else stands in their way (a TV camera platform there moves the arch to the next mark)
  const arches = (cd.arches ?? [])
    .map((a) => {
      const s = rt.wrapS(resolveMark(rt.plan.marks, L, a.at));
      const k = Math.round(s / h) % N;
      const p = rt.pointAt(s, 0, new THREE.Vector3());
      return { s, depth: a.depth ?? 5.5, x: p.x, z: p.z, tx: rt.HTX[k], tz: rt.HTZ[k], lx: rt.HLX[k], lz: rt.HLZ[k], reachL: rt.L.wall[k] + ARCH_REACH, reachR: rt.R.wall[k] + ARCH_REACH };
    })
    .filter((a) => !ctx.camSpots?.some(([cx, cz]) => Math.abs((cx - a.x) * a.tx + (cz - a.z) * a.tz) < a.depth / 2 + 3 && Math.abs((cx - a.x) * a.lx + (cz - a.z) * a.lz) < Math.max(a.reachL, a.reachR) + 3));
  ctx.reserved.push((x, z, margin) =>
    arches.some((a) => {
      const t = (x - a.x) * a.tx + (z - a.z) * a.tz;
      const u = (x - a.x) * a.lx + (z - a.z) * a.lz;
      return Math.abs(t) < a.depth / 2 + 1 + margin && u < a.reachL + margin && u > -a.reachR - margin;
    }),
  );

  // ── the skyline: blocks on the hillsides, beyond the rows ─────────────────────────────────────────
  // two street grids (one square to the harbour, one turned) tile the ground in patches; a block stands on a lattice point
  // where the town is dense enough, clear of the circuit, the water and the rows
  const farLots: Lot[] = [];
  const farGrid = new LotGrid();
  if (cd.skyline) {
    const sk = cd.skyline;
    const b = rt.bounds;
    const pitch = 31;
    for (const th of [0, 0.42]) {
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      // lattice coordinates (a, c) -> world (x, z) = (a cs - c sn, a sn + c cs)
      let a0 = Infinity;
      let a1 = -Infinity;
      let c0 = Infinity;
      let c1 = -Infinity;
      for (const [x, z] of [[b.minX - sk.reach, b.minZ - sk.reach], [b.maxX + sk.reach, b.minZ - sk.reach], [b.minX - sk.reach, b.maxZ + sk.reach], [b.maxX + sk.reach, b.maxZ + sk.reach]]) {
        const a = x * cs + z * sn;
        const c = -x * sn + z * cs;
        a0 = Math.min(a0, a);
        a1 = Math.max(a1, a);
        c0 = Math.min(c0, c);
        c1 = Math.max(c1, c);
      }
      for (let a = Math.floor(a0 / pitch) * pitch; a <= a1; a += pitch) {
        for (let c = Math.floor(c0 / pitch) * pitch; c <= c1; c += pitch) {
          const px = a * cs - c * sn + (rnd() - 0.5) * 3;
          const pz = a * sn + c * cs + (rnd() - 0.5) * 3;
          // each grid owns the patches where the domain noise has its sign
          if ((noise.noise(px / 330 + 3, pz / 330 - 8) > 0 ? 0 : 1) !== (th === 0 ? 0 : 1)) continue;
          rt.project(px, pz, _tp, -1);
          const wall = _tp.d >= 0 ? _tp.wallLeft : _tp.wallRight;
          const away = Math.abs(_tp.d) - wall;
          if (away < 14 || away > sk.reach) continue;
          if (rt.terrain.seaDistance(px, pz) < 24) continue;
          // the open stretches (the quay and its stands) keep their distance too
          if (away < 90 && isOpen(_tp.d >= 0 ? 1 : -1, _tp.s)) continue;
          let held = false;
          for (const r of ctx.reserved) if (r(px, pz, 8)) held = true;
          if (held) continue;
          const fall = 1 - smoothstep(sk.reach * 0.45, sk.reach, away);
          const town = smoothstep(-0.45, 0.25, noise.noise(px / 190 + 9, pz / 190 - 4));
          if (rnd() > sk.density * fall * (0.2 + 0.8 * town)) continue;
          const hx = (rt.fieldHeight(px + 6, pz) - rt.fieldHeight(px - 6, pz)) / 12;
          const hz = (rt.fieldHeight(px, pz + 6) - rt.fieldHeight(px, pz - 6)) / 12;
          if (Math.hypot(hx, hz) > 0.5) continue;
          const wx = 16 + rnd() * 9;
          const wz = 15 + rnd() * 9;
          const yaw = th + (rnd() < 0.5 ? 0 : Math.PI / 2);
          const ys = Math.sin(yaw);
          const yc = Math.cos(yaw);
          const q: Pt[] = [
            [px - (yc * wx) / 2 - (ys * wz) / 2, pz + (ys * wx) / 2 - (yc * wz) / 2],
            [px + (yc * wx) / 2 - (ys * wz) / 2, pz - (ys * wx) / 2 - (yc * wz) / 2],
            [px + (yc * wx) / 2 + (ys * wz) / 2, pz - (ys * wx) / 2 + (yc * wz) / 2],
            [px - (yc * wx) / 2 + (ys * wz) / 2, pz + (ys * wx) / 2 + (yc * wz) / 2],
          ];
          // clear of the rows and of each other, and of every road
          if (grid.overlaps(q, 3) || farGrid.overlaps(q, 2)) continue;
          let ok = true;
          for (const [qx, qz] of q) {
            rt.project(qx, qz, _tp, -1);
            const wl = _tp.d >= 0 ? _tp.wallLeft : _tp.wallRight;
            if (Math.abs(_tp.d) < wl + 10 || rt.terrain.seaDistance(qx, qz) < 16) ok = false;
          }
          if (!ok) continue;
          const floors = Math.max(2, Math.round(2.4 + 3.2 * rnd() + 2.6 * town));
          const style = mkStyle(floors, wx, pickWall());
          const lot: Lot = { sgn: 1, s0: 0, s1: wx, d0: 0, d1: wz, floors, tile: floors <= 5 && rnd() < 0.72, style, roofCol: roofColor(), hip: 0.22 + 0.08 * rnd(), quad: q };
          farGrid.add(lot);
          farLots.push(lot);
        }
      }
    }
  }

  // the town as a coarse raster (how built-up the ground is), for the terrain shader to turn grass into streets and yards
  {
    const b = rt.bounds;
    const cell = 8;
    const x0 = b.minX - 1300;
    const z0 = b.minZ - 1300;
    const nx = Math.ceil((b.maxX + 1300 - x0) / cell) + 1;
    const nz = Math.ceil((b.maxZ + 1300 - z0) / cell) + 1;
    const raster = new Float32Array(nx * nz);
    // the hills over the tunnels are parks: grass all round (the lots keep out of there anyway), not the yards' gravel
    const parks = tun.map(([a, b]) => {
      const p = new THREE.Vector3();
      rt.pointAt((a + b) / 2, 0, p);
      return { a, b, x: p.x, z: p.z, r: (b - a) / 2 + 130 };
    });
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = x0 + i * cell;
        const z = z0 + j * cell;
        let u = 0;
        if (rt.terrain.seaDistance(x, z) < 80) u = 1;
        else if (grid.near(x, z, 12) || farGrid.near(x, z, 12)) u = 1;
        else if (grid.near(x, z, 26) || farGrid.near(x, z, 26)) u = 0.55;
        if (u > 0) {
          for (const pk of parks) {
            if (Math.hypot(x - pk.x, z - pk.z) > pk.r) continue;
            rt.project(x, z, _tp, -1);
            if (_tp.s > pk.a - 30 && _tp.s < pk.b + 30 && Math.abs(_tp.d) < 80) u *= smoothstep(55, 80, Math.abs(_tp.d));
          }
        }
        raster[j * nx + i] = u;
      }
    }
    ctx.urban = (x: number, z: number): number => {
      const fx = (x - x0) / cell;
      const fz = (z - z0) / cell;
      if (fx < 0 || fz < 0 || fx >= nx - 1 || fz >= nz - 1) return 0;
      const ix = Math.floor(fx);
      const iz = Math.floor(fz);
      const tx = fx - ix;
      const tz = fz - iz;
      const k = iz * nx + ix;
      return (raster[k] * (1 - tx) + raster[k + 1] * tx) * (1 - tz) + (raster[k + nx] * (1 - tx) + raster[k + nx + 1] * tx) * tz;
    };
  }

  // ── emit geometry per chunk ───────────────────────────────────────────────────────────────────────────
  const chunks = new Map<string, Chunk>();
  const chunkFor = (key: string, far: boolean): Chunk => {
    let c = chunks.get(key);
    if (!c) {
      c = { base: new CityBuf(), detail: new CityBuf(), far };
      chunks.set(key, c);
    }
    return c;
  };

  for (const lot of grid.lots) {
    if (lot.skip) continue;
    const mid = rt.wrapS((lot.s0 + lot.s1) / 2);
    const key = `n${lot.sgn}_${Math.floor(mid / 160)}`;
    const c = chunkFor(key, false);
    emitStreetLot(rt, lot, c.base, c.detail);
  }
  if (places.length) {
    const lc = chunkFor('landmarks', false);
    for (const p of places) emitLandmark(lc.base, rt, p);
  }
  arches.forEach((a, i) => emitArch(chunkFor(`arch${i}`, false).base, rt, a.s, a.depth));
  for (const lot of farLots) {
    const q = lot.quad;
    const cx = (q[0][0] + q[2][0]) / 2;
    const cz = (q[0][1] + q[2][1]) / 2;
    emitFarLot(rt, lot, chunkFor(`f${Math.floor(cx / 240)}_${Math.floor(cz / 240)}`, true).base);
  }

  // ── meshes ────────────────────────────────────────────────────────────────────────────────────────
  const group = new THREE.Group();
  group.name = 'city';
  const mat = makeFacadeMaterial(ctx);
  ctx.disposables.push(mat);
  interface Rec {
    base: THREE.Mesh;
    detail: THREE.Mesh | null;
    cx: number;
    cy: number;
    cz: number;
    r: number;
    far: boolean;
  }
  const recs: Rec[] = [];
  for (const [key, c] of chunks) {
    const geo = c.base.build();
    geo.computeBoundingBox();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `city_${key}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    ctx.disposables.push(geo);
    let detail: THREE.Mesh | null = null;
    if (!c.detail.empty) {
      const dg = c.detail.build();
      detail = new THREE.Mesh(dg, mat);
      detail.name = `city_${key}_detail`;
      detail.castShadow = false;
      detail.receiveShadow = true;
      group.add(detail);
      ctx.disposables.push(dg);
    }
    const bs = geo.boundingSphere!;
    recs.push({ base: mesh, detail, cx: bs.center.x, cy: bs.center.y, cz: bs.center.z, r: bs.radius, far: c.far });
  }
  const cam = new THREE.Vector3();
  ctx.updaters.push((_dt, camera) => {
    camera.getWorldPosition(cam);
    for (const r of recs) {
      const dx = r.cx - cam.x;
      const dz = r.cz - cam.z;
      const d = Math.max(0, Math.hypot(dx, dz) - r.r);
      r.base.visible = d < (r.far ? 2600 : 3200);
      r.base.castShadow = d < (r.far ? 0 : 230);
      if (r.detail) r.detail.visible = d < 240;
    }
  });

  // palms along the streets go into the tree system
  if (cd.palms?.length) {
    const palms: Inst[] = [];
    for (const p of cd.palms) {
      const i0 = resolveMark(rt.plan.marks, L, p.from);
      let i1 = resolveMark(rt.plan.marks, L, p.to);
      if (i1 < i0) i1 += L;
      for (const side of p.side === 'B' ? [1, -1] : [p.side === 'L' ? 1 : -1]) {
        for (let s = i0 + 4; s < i1; s += p.spacing * (0.85 + 0.3 * rnd())) {
          const wall = wallAt(side as 1 | -1, s);
          rt.pointAt(s, side * (wall + (p.gap ?? 2.2)), _v);
          rt.project(_v.x, _v.z, _tp, -1);
          if (rt.terrain.seaDistance(_v.x, _v.z) < 3) continue;
          let blocked = false;
          for (const r of ctx.reserved) if (r(_v.x, _v.z, -0.5)) blocked = true;
          if (blocked) continue;
          palms.push({ x: _v.x, y: _v.y - 0.1, z: _v.z, yaw: rnd() * Math.PI * 2, s: 9 + rnd() * 5, tint: 0.92 + rnd() * 0.16, hue: (rnd() - 0.5) * 0.2, w: 0.9 + rnd() * 0.25 });
        }
      }
    }
    ctx.extraTrees = { ...(ctx.extraTrees ?? {}), palm: [...(ctx.extraTrees?.palm ?? []), ...palms] };
  }

  // groves on the open hillsides (the castle hill) go into the tree system too: clumps where the noise is high, on ground well above
  // the road (so not in the cut slopes at a tunnel's mouths), clear of the castle and of every lot
  if (cd.groves?.length) {
    const by: Partial<Record<SpeciesId, Inst[]>> = {};
    const height: Record<SpeciesId, [number, number]> = { oak: [7, 11], poplar: [12, 17], pine: [9, 14], birch: [8, 11], palm: [9, 13] };
    for (const gv of cd.groves) {
      const i0 = Math.round(resolveMark(rt.plan.marks, L, gv.at) / h) % N;
      const total = gv.species.reduce((a, [, w]) => a + w, 0);
      let placed = 0;
      for (let tries = 0; placed < gv.count && tries < gv.count * 40; tries++) {
        const r = Math.sqrt(rnd());
        const a = rnd() * Math.PI * 2;
        const u = Math.cos(a) * r * gv.along;
        const v = Math.sin(a) * r * gv.across;
        const x = rt.X[i0] + rt.HTX[i0] * u + rt.HLX[i0] * v;
        const z = rt.Z[i0] + rt.HTZ[i0] * u + rt.HLZ[i0] * v;
        if (noise.noise(x / 22 + 3, z / 22 - 7) < -0.15) continue;
        const y = rt.fieldHeight(x, z);
        rt.project(x, z, _tp, -1);
        const rise = y - rt.Y[Math.round(_tp.s / h) % N];
        // (nothing beside the road itself unless the ground is high there, over a tunnel)
        if (Math.abs(_tp.d) - (_tp.d >= 0 ? _tp.wallLeft : _tp.wallRight) < 10 && rise < 8) continue;
        if (rise < (gv.minRise ?? 8)) continue;
        const q: Pt[] = [[x - 1.5, z - 1.5], [x + 1.5, z - 1.5], [x + 1.5, z + 1.5], [x - 1.5, z + 1.5]];
        if (grid.overlaps(q, 5) || farGrid.overlaps(q, 3)) continue;
        let held = false;
        for (const rv of ctx.reserved) if (rv(x, z, 2)) held = true;
        if (held) continue;
        let pick = rnd() * total;
        let sp = gv.species[0][0];
        for (const [id, w] of gv.species) {
          sp = id;
          pick -= w;
          if (pick <= 0) break;
        }
        const [h0, h1] = height[sp];
        (by[sp] ??= []).push({ x, y: y - 0.2, z, yaw: rnd() * Math.PI * 2, s: h0 + (h1 - h0) * rnd(), tint: 0.78 + rnd() * 0.14, hue: -0.12 + rnd() * 0.16, w: 0.85 + rnd() * 0.3 });
        placed++;
      }
    }
    for (const sp of Object.keys(by) as SpeciesId[]) ctx.extraTrees = { ...(ctx.extraTrees ?? {}), [sp]: [...(ctx.extraTrees?.[sp] ?? []), ...by[sp]!] };
  }

  return { group };
}

// ── emitting buildings ──────────────────────────────────────────────────────────────────────────────


/** A street lot: facades along the street samples, side and back walls, the roof, and (in `detail`) cornice, parapet, chimneys, awnings, balconies. */
function emitStreetLot(rt: Ctx['rt'], lot: Lot, base: CityBuf, detail: CityBuf): void {
  const { sgn, s0, s1, d0, d1, style } = lot;
  const w = s1 - s0;
  const m = Math.max(1, Math.ceil(w / 3));
  const F: Pt3[] = [];
  const B: Pt3[] = [];
  for (let k = 0; k <= m; k++) {
    const s = s0 + (w * k) / m;
    rt.pointAt(s, sgn * d0, _v);
    F.push({ x: _v.x, y: _v.y, z: _v.z });
    rt.pointAt(s, sgn * d1, _v);
    B.push({ x: _v.x, y: _v.y, z: _v.z });
  }
  const Hf = 3 + 0.5 * hash11(style.seed * 5.7);
  let yRef = -Infinity;
  for (const p of F) yRef = Math.max(yRef, p.y);
  const yTop = yRef + style.gH + lot.floors * Hf + 0.4;
  // cumulative facade length for u
  const cum: number[] = [0];
  for (let k = 1; k <= m; k++) cum.push(cum[k - 1] + Math.hypot(F[k].x - F[k - 1].x, F[k].z - F[k - 1].z));
  const T = cum[m];
  const st: Style = { ...style, w: T };
  // facade: one quad per street sample
  for (let k = 0; k < m; k++) {
    const a = F[k];
    const b = F[k + 1];
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const tl = Math.hypot(tx, tz) || 1;
    // the normal faces the street
    const nx = (sgn > 0 ? -tz : tz) / tl;
    const nz = (sgn > 0 ? tx : -tx) / tl;
    const ua = sgn > 0 ? cum[k] : T - cum[k];
    const ub = sgn > 0 ? cum[k + 1] : T - cum[k + 1];
    base.quad(
      [[a.x, a.y - 0.3, a.z], [b.x, b.y - 0.3, b.z], [b.x, yTop, b.z], [a.x, yTop, a.z]],
      [[ua, a.y - 0.3 - yRef], [ub, b.y - 0.3 - yRef], [ub, yTop - yRef], [ua, yTop - yRef]],
      [nx, 0, nz],
      st,
      FACADE_KIND.wall,
    );
  }
  // side walls
  const sideStyle: Style = { ...style, w: Math.hypot(F[0].x - B[0].x, F[0].z - B[0].z) };
  for (const [k, outward] of [[0, -1], [m, 1]] as const) {
    const f = F[k];
    const b = B[k];
    const dx = b.x - f.x;
    const dz = b.z - f.z;
    const dl = Math.hypot(dx, dz) || 1;
    // outward along +/- the street direction
    const k2 = Math.min(m, k + 1);
    const k1 = Math.max(0, k - 1);
    const tx = F[k2].x - F[k1].x;
    const tz = F[k2].z - F[k1].z;
    const tl = Math.hypot(tx, tz) || 1;
    base.quad(
      [[f.x, f.y - 0.3, f.z], [b.x, b.y - 0.3, b.z], [b.x, yTop, b.z], [f.x, yTop, f.z]],
      [[0, f.y - 0.3 - yRef], [dl, b.y - 0.3 - yRef], [dl, yTop - yRef], [0, yTop - yRef]],
      [(tx / tl) * outward, 0, (tz / tl) * outward],
      sideStyle,
      FACADE_KIND.side,
    );
  }
  // back wall
  for (let k = 0; k < m; k++) {
    const a = B[k];
    const b = B[k + 1];
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const tl = Math.hypot(tx, tz) || 1;
    const nx = (sgn > 0 ? tz : -tz) / tl;
    const nz = (sgn > 0 ? -tx : tx) / tl;
    base.quad(
      [[a.x, a.y - 0.3, a.z], [b.x, b.y - 0.3, b.z], [b.x, yTop, b.z], [a.x, yTop, a.z]],
      [[cum[k], a.y - 0.3 - yRef], [cum[k + 1], b.y - 0.3 - yRef], [cum[k + 1], yTop - yRef], [cum[k], yTop - yRef]],
      [nx, 0, nz],
      st,
      FACADE_KIND.side,
    );
  }
  // roof
  const roofSt: Style = { ...style, col: lot.roofCol };
  const curved = (() => {
    // how far the facade strays from the straight chord between its ends
    const a = F[0];
    const b = F[m];
    const cl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    let dev = 0;
    for (const p of F) dev = Math.max(dev, Math.abs((p.x - a.x) * (b.z - a.z) - (p.z - a.z) * (b.x - a.x)) / cl);
    return dev;
  })();
  const flat = !lot.tile || curved > 0.7;
  if (flat) {
    for (let k = 0; k < m; k++) {
      base.quad(
        [[F[k].x, yTop, F[k].z], [F[k + 1].x, yTop, F[k + 1].z], [B[k + 1].x, yTop, B[k + 1].z], [B[k].x, yTop, B[k].z]],
        [[F[k].x, F[k].z], [F[k + 1].x, F[k + 1].z], [B[k + 1].x, B[k + 1].z], [B[k].x, B[k].z]],
        [0, 1, 0],
        st,
        FACADE_KIND.flat,
      );
    }
  } else {
    hipRoof(base, [F[0], F[m], B[m], B[0]], yTop, lot.hip, roofSt);
  }
  // detail: cornice, parapet, chimneys, awnings, balconies
  const trimSt: Style = { ...style, col: [style.col[0] * 0.95, style.col[1] * 0.92, style.col[2] * 0.88] };
  for (let k = 0; k < m; k++) {
    const a = F[k];
    const b = F[k + 1];
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const tl = Math.hypot(tx, tz) || 1;
    const nx = (sgn > 0 ? -tz : tz) / tl;
    const nz = (sgn > 0 ? tx : -tx) / tl;
    // cornice: a deep band at the top of the facade, 0.28 m out
    detail.quad(
      [[a.x + nx * 0.28, yTop - 0.5, a.z + nz * 0.28], [b.x + nx * 0.28, yTop - 0.5, b.z + nz * 0.28], [b.x + nx * 0.28, yTop + 0.05, b.z + nz * 0.28], [a.x + nx * 0.28, yTop + 0.05, a.z + nz * 0.28]],
      [[0, 0], [tl, 0], [tl, 0.55], [0, 0.55]],
      [nx, 0, nz],
      trimSt,
      FACADE_KIND.trim,
    );
    detail.quad(
      [[a.x, yTop - 0.5, a.z], [b.x, yTop - 0.5, b.z], [b.x + nx * 0.28, yTop - 0.5, b.z + nz * 0.28], [a.x + nx * 0.28, yTop - 0.5, a.z + nz * 0.28]],
      [[0, 0], [tl, 0], [tl, 0.28], [0, 0.28]],
      [0, -1, 0],
      trimSt,
      FACADE_KIND.trim,
    );
    if (flat) {
      // parapet along the front
      detail.quad(
        [[a.x, yTop, a.z], [b.x, yTop, b.z], [b.x, yTop + 0.55, b.z], [a.x, yTop + 0.55, a.z]],
        [[0, 0], [tl, 0], [tl, 0.55], [0, 0.55]],
        [nx, 0, nz],
        trimSt,
        FACADE_KIND.trim,
      );
      detail.quad(
        [[a.x, yTop + 0.55, a.z], [b.x, yTop + 0.55, b.z], [b.x - nx * 0.3, yTop + 0.55, b.z - nz * 0.3], [a.x - nx * 0.3, yTop + 0.55, a.z - nz * 0.3]],
        [[0, 0], [tl, 0], [tl, 0.3], [0, 0.3]],
        [0, 1, 0],
        trimSt,
        FACADE_KIND.trim,
      );
    }
  }
  if (flat) {
    // the other three sides of the parapet
    const ring: Pt3[] = [F[m], B[m], B[0], F[0]];
    for (let k = 0; k < 3; k++) {
      const a = ring[k];
      const b = ring[k + 1];
      const tx = b.x - a.x;
      const tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1;
      // outward = away from the lot's centre
      const cx = (F[0].x + F[m].x + B[0].x + B[m].x) / 4;
      const cz = (F[0].z + F[m].z + B[0].z + B[m].z) / 4;
      let nx = -tz / tl;
      let nz = tx / tl;
      if ((a.x - cx) * nx + (a.z - cz) * nz < 0) {
        nx = -nx;
        nz = -nz;
      }
      detail.quad([[a.x, yTop, a.z], [b.x, yTop, b.z], [b.x, yTop + 0.55, b.z], [a.x, yTop + 0.55, a.z]], [[0, 0], [tl, 0], [tl, 0.55], [0, 0.55]], [nx, 0, nz], trimSt, FACADE_KIND.trim);
      detail.quad(
        [[a.x, yTop + 0.55, a.z], [b.x, yTop + 0.55, b.z], [b.x - nx * 0.3, yTop + 0.55, b.z - nz * 0.3], [a.x - nx * 0.3, yTop + 0.55, a.z - nz * 0.3]],
        [[0, 0], [tl, 0], [tl, 0.3], [0, 0.3]],
        [0, 1, 0],
        trimSt,
        FACADE_KIND.trim,
      );
    }
  }
  // chimneys on pitched roofs, a lift housing or a tank on flat ones
  {
    const cx = (F[0].x + F[m].x + B[0].x + B[m].x) / 4;
    const cz = (F[0].z + F[m].z + B[0].z + B[m].z) / 4;
    const rr = hash11(style.seed * 71.3);
    const dx = (F[m].x - F[0].x) / 2;
    const dz = (F[m].z - F[0].z) / 2;
    const tl = Math.hypot(dx, dz) || 1;
    if (!flat) {
      for (let k = 0; k < (rr < 0.6 ? 1 : 2); k++) {
        const o = (k === 0 ? 0.3 : -0.35) * (0.6 + rr);
        detail.box(cx + dx * o, yTop + 1.3 + (hash11(style.seed * 9.1) * 0.4), cz + dz * o, 0.34, 1.1 + 0.2 * rr, 0.34, dx / tl, dz / tl, trimSt, FACADE_KIND.trim);
      }
    } else if (rr < 0.55) {
      detail.box(cx + dx * 0.25, yTop + 1.2, cz + dz * 0.25, 1.6, 1.2, 1.4, dx / tl, dz / tl, trimSt, FACADE_KIND.trim);
    }
  }
  // awnings over the shop fronts, balcony slabs on the upper floors (the same choices the shader makes from the seed)
  {
    const groundKind = hash11(style.seed * 43.3);
    const pitch = 2.5 + 1.4 * hash11(style.seed * 3.1);
    const nb = Math.max(1, Math.floor(T / pitch + 0.5));
    const Wp = T / nb;
    const at = (u: number): { x: number; y: number; z: number; nx: number; nz: number } => {
      // point at facade length u (from the street-direction start)
      const uu = sgn > 0 ? u : T - u;
      let k = 0;
      while (k < m - 1 && cum[k + 1] < uu) k++;
      const t = (uu - cum[k]) / Math.max(1e-6, cum[k + 1] - cum[k]);
      const a = F[k];
      const b = F[k + 1];
      const tx = b.x - a.x;
      const tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1;
      return { x: a.x + tx * t, y: a.y + (b.y - a.y) * t, z: a.z + tz * t, nx: (sgn > 0 ? -tz : tz) / tl, nz: (sgn > 0 ? tx : -tx) / tl };
    };
    if (groundKind < 0.62) {
      const Wb = T / Math.max(1, Math.floor(T / (3.4 + 1.8 * hash11(style.seed * 47.1)) + 0.5));
      const nbays = Math.round(T / Wb);
      for (let ib = 0; ib < nbays; ib++) {
        const hb = hash11(ib + style.seed * 91.0);
        if (hb >= 0.8) continue;
        const u = (ib + 0.5) * Wb;
        const p = at(u);
        const col = hash11(ib + style.seed * 13.0);
        const awn: [number, number, number] = col < 0.25 ? [0.62, 0.08, 0.06] : col < 0.5 ? [0.07, 0.24, 0.38] : col < 0.7 ? [0.1, 0.34, 0.16] : col < 0.85 ? [0.82, 0.66, 0.22] : [0.78, 0.74, 0.66];
        const aSt: Style = { ...style, col: [awn[0] * 0.9, awn[1] * 0.9, awn[2] * 0.9] };
        const hw = Wb * 0.5 - 0.3;
        const y0 = yRef + style.gH - 0.95 + 0.4;
        const tx = -p.nz;
        const tz = p.nx;
        detail.quad(
          [
            [p.x - tx * hw, y0 + 0.05, p.z - tz * hw],
            [p.x + tx * hw, y0 + 0.05, p.z + tz * hw],
            [p.x + tx * hw + p.nx * 1.0, y0 - 0.45, p.z + tz * hw + p.nz * 1.0],
            [p.x - tx * hw + p.nx * 1.0, y0 - 0.45, p.z - tz * hw + p.nz * 1.0],
          ],
          [[0, 0], [hw * 2, 0], [hw * 2, 1], [0, 1]],
          [p.nx * 0.45, 0.89, p.nz * 0.45],
          aSt,
          FACADE_KIND.awning,
        );
      }
    }
    const balcony = hash11(style.seed * 23.7);
    if (balcony < 0.5) {
      for (let fl = 1; fl < lot.floors; fl++) {
        const isBal = (balcony < 0.34 && fl % 2 === 0) || (balcony >= 0.34 && fl === 1);
        if (!isBal) continue;
        const yb = yRef + style.gH + fl * Hf + Hf * 0.16;
        for (let ix = 0; ix < nb; ix++) {
          const p = at((ix + 0.5) * Wp);
          const tx = -p.nz;
          const tz = p.nx;
          detail.box(p.x + p.nx * 0.5, yb, p.z + p.nz * 0.5, Wp * 0.3, 0.07, 0.5, tx, tz, trimSt, FACADE_KIND.trim);
        }
      }
    }
  }
}

/** A distant block: four walls and a roof, no detail geometry. */
function emitFarLot(rt: Ctx['rt'], lot: Lot, base: CityBuf): void {
  const q = lot.quad;
  const st = lot.style;
  const Hf = 3 + 0.5 * hash11(st.seed * 5.7);
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const [x, z] of q) {
    const y = rt.fieldHeight(x, z);
    yMin = Math.min(yMin, y);
    yMax = Math.max(yMax, y);
  }
  const yRef = yMax;
  const yTop = yRef + st.gH + lot.floors * Hf + 0.4;
  const yBot = yMin - 1.5;
  const wallSt: Style = { ...st };
  for (let k = 0; k < 4; k++) {
    const a = q[k];
    const b = q[(k + 1) % 4];
    const tx = b[0] - a[0];
    const tz = b[1] - a[1];
    const tl = Math.hypot(tx, tz) || 1;
    // outward: away from the centre
    const cx = (q[0][0] + q[2][0]) / 2;
    const cz = (q[0][1] + q[2][1]) / 2;
    let nx = -tz / tl;
    let nz = tx / tl;
    if ((a[0] - cx) * nx + (a[1] - cz) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const s2: Style = { ...wallSt, w: tl };
    base.quad(
      [[a[0], yBot, a[1]], [b[0], yBot, b[1]], [b[0], yTop, b[1]], [a[0], yTop, a[1]]],
      [[0, yBot - yRef], [tl, yBot - yRef], [tl, yTop - yRef], [0, yTop - yRef]],
      [nx, 0, nz],
      s2,
      k % 2 === 0 ? FACADE_KIND.wall : FACADE_KIND.side,
    );
  }
  const P = q.map((p) => ({ x: p[0], y: yTop, z: p[1] }));
  if (lot.tile) hipRoof(base, [P[0], P[1], P[2], P[3]], yTop, lot.hip, { ...st, col: lot.roofCol });
  else {
    base.quad([[q[0][0], yTop, q[0][1]], [q[1][0], yTop, q[1][1]], [q[2][0], yTop, q[2][1]], [q[3][0], yTop, q[3][1]]], [[q[0][0], q[0][1]], [q[1][0], q[1][1]], [q[2][0], q[2][1]], [q[3][0], q[3][1]]], [0, 1, 0], st, FACADE_KIND.flat);
  }
}
