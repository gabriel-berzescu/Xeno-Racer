/**
 * The megacity (`CityDef.style === 'neon'`): towers of dark glass and concrete on both sides of the circuit, megatowers beyond them
 * to the horizon, a spire and an arcology, and the signs and lines of light that carry the picture after dark.
 *
 * The street rows are laid out in (s, d) street coordinates as the harbour town's are (city.ts), but a lot here is a tower's
 * footprint: 24 to 60 m of street front, a pavement's width behind the barrier, pushed back where the pits, a stand or a TV camera
 * hold the ground. Behind the rows and in the middle of the circuit megatowers stand on two street grids, taller toward the middle
 * of town. A tower is a stack of prisms on a convex footprint (a podium, a shaft, setbacks or a taper, a crown); what is on its walls
 * is drawn by the shader (cyberFacade.ts). Signs are slabs with a lit face: blades standing out from the facades, panels on them and
 * on the side walls that face the traffic, billboards on the roofs, banners high on the megatowers.
 *
 * Geometry is merged per cell of a grid on the map: the street rows (they cast shadows when near), the megatowers (they never do), and
 * the roofs' plant (drawn near the camera only). The aircraft warning lights are one draw call of points.
 */
import * as THREE from 'three';
import { Noise2, clamp, mulberry32, smoothstep } from '../math';
import { resolveMark } from '../plan';
import type { CityDef, Mark } from '../types';
import type { TrackPoint } from '../../core/contracts';
import type { Ctx } from './ctx';
import { CityBuf, type Style, hash11, linear } from './cityBuf';
import { LotGrid, Occluders, type CityResult, type Pt } from './cityLots';
import { CYBER_FLAG, CYBER_KIND, makeBeaconMaterial, makeCyberMaterial } from './cyberFacade';
import { emitArcology, emitSpire, placeArcology, placeSpire, type MegaPlace } from './megaLandmarks';
import { centroid, inset, pickWeighted, plainStyle, roof, scaled, seedOf, signStyle, slab, tank, walls } from './megaSolids';
import { lerpS } from './road';

// ── palette ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Curtain-wall glass (what it reflects at normal incidence, sRGB hex): steel blues, a teal black, bronze, graphite. */
const GLASS = [0x4a5a68, 0x3d4c5a, 0x33454a, 0x52545c, 0x5a4e44, 0x2c3138, 0x5c7080, 0x3a4458, 0x44505e];
/** Cast concrete, from near black to a warm grey. */
const CONCRETE = [0x2a2f3a, 0x33363c, 0x3a3a3c, 0x26282c, 0x40423f, 0x1e2126, 0x4a4640, 0x2f3338];
/** How often each light is a tower's accent (teal, pink, violet, cold white, amber). */
const ACCENT_W = [3, 2.4, 2, 2.2, 0.8];

// ── towers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Tower {
  /** The footprint; a street lot's first edge is its street front and its last the side wall that faces the traffic. */
  quad: Pt[];
  /** The floor datum (the ground at the front) and how far down the foundations go. */
  yRef: number;
  yBot: number;
  /** Height above the datum (m), without masts. */
  h: number;
  glass: boolean;
  col: [number, number, number];
  seed: number;
  lit: number;
  accent: number;
  flags: number;
  /** Podium height (0: none). */
  gH: number;
  /** 0 a slab, 1 stepped, 2 tapered, 3 a shaft under a crown box. */
  arche: number;
  street: boolean;
  /** Distance from the nearest barrier (m), and the unit vector toward the road. */
  away: number;
  rx: number;
  rz: number;
}

interface Tier {
  q0: Pt[];
  q1: Pt[];
  y0: number;
  y1: number;
  gH: number;
}

function tiersOf(t: Tower): Tier[] {
  const h1 = hash11(t.seed * 131.7);
  const h2 = hash11(t.seed * 211.3);
  const h3 = hash11(t.seed * 317.9);
  const top = t.yRef + t.h;
  const tiers: Tier[] = [];
  let q = t.quad;
  let y = t.yBot;
  if (t.gH > 0) {
    tiers.push({ q0: q, q1: q, y0: y, y1: t.yRef + t.gH, gH: t.gH });
    y = t.yRef + t.gH;
    if (h1 > 0.4) q = inset(q, 1.2 + 2.6 * h2);
  }
  const span = top - y;
  if (t.arche === 1) {
    const ya = y + span * (0.48 + 0.2 * h2);
    const yb = y + span * (0.8 + 0.1 * h3);
    tiers.push({ q0: q, q1: q, y0: y, y1: ya, gH: 0 });
    q = inset(q, 2.5 + 3.5 * h3);
    tiers.push({ q0: q, q1: q, y0: ya, y1: yb, gH: 0 });
    q = inset(q, 2.2 + 3 * h1);
    tiers.push({ q0: q, q1: q, y0: yb, y1: top, gH: 0 });
  } else if (t.arche === 2) {
    const ya = y + span * (0.5 + 0.1 * h2);
    const yb = y + span * 0.88;
    const qa = scaled(q, 0.84 + 0.08 * h3);
    tiers.push({ q0: q, q1: qa, y0: y, y1: ya, gH: 0 });
    const qb = scaled(qa, 0.78 + 0.08 * h1);
    tiers.push({ q0: qa, q1: qb, y0: ya, y1: yb, gH: 0 });
    const qc = inset(qb, 1.2);
    tiers.push({ q0: qc, q1: scaled(qc, 0.8), y0: yb, y1: top, gH: 0 });
  } else if (t.arche === 3) {
    const ya = y + span * (0.86 + 0.06 * h2);
    tiers.push({ q0: q, q1: q, y0: y, y1: ya, gH: 0 });
    q = inset(q, 2 + 3 * h3);
    tiers.push({ q0: q, q1: q, y0: ya, y1: top, gH: 0 });
  } else {
    tiers.push({ q0: q, q1: q, y0: y, y1: top, gH: 0 });
  }
  return tiers;
}

/** A point of a quad by its two parameters (0..1 along the first edge, 0..1 from it to the opposite one). */
function inQuad(q: Pt[], a: number, b: number): Pt {
  const x0 = q[0][0] + (q[1][0] - q[0][0]) * a;
  const z0 = q[0][1] + (q[1][1] - q[0][1]) * a;
  const x1 = q[3][0] + (q[2][0] - q[3][0]) * a;
  const z1 = q[3][1] + (q[2][1] - q[3][1]) * a;
  return [x0 + (x1 - x0) * b, z0 + (z1 - z0) * b];
}

/** An edge of a footprint: its ends, its length, its unit direction and its outward normal. */
function edgeOf(q: Pt[], k: number): { a: Pt; b: Pt; len: number; tx: number; tz: number; nx: number; nz: number } {
  const a = q[k];
  const b = q[(k + 1) % q.length];
  const c = centroid(q);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const tx = (b[0] - a[0]) / len;
  const tz = (b[1] - a[1]) / len;
  let nx = -tz;
  let nz = tx;
  if ((a[0] - c[0]) * nx + (a[1] - c[1]) * nz < 0) {
    nx = -nx;
    nz = -nz;
  }
  return { a, b, len, tx, tz, nx, nz };
}

interface Emit {
  base: CityBuf;
  detail: CityBuf | null;
  /** x, y, z and phase per aircraft warning light (a phase of 2 is a steady lamp). */
  beacons: number[];
  rnd: () => number;
}

/** A tower: its tiers, its roofs, its mast and lamps, the plant on its roof, its signs. Returns the height of the top of its shaft. */
function emitTower(t: Tower, e: Emit): number {
  const { base, detail, rnd } = e;
  const kind = t.glass ? CYBER_KIND.glass : CYBER_KIND.concrete;
  const st: Style = { col: t.col, seed: t.seed, floors: 0, gH: 0, w: 1, lit: t.lit, a: t.accent, b: t.flags };
  const tiers = tiersOf(t);
  const last = tiers.length - 1;
  tiers.forEach((tr, i) => {
    // (only the top of the tower wears the crown band)
    walls(base, tr.q0, tr.q1, tr.y0, tr.y1, t.yRef, { ...st, gH: tr.gH, b: i === last ? t.flags : t.flags & ~CYBER_FLAG.crown }, kind);
    roof(base, tr.q1, tr.y1, st);
  });
  const top = tiers[last].y1;
  const tq = tiers[last].q1;
  const tc = centroid(tq);
  const shaft = tiers[t.gH > 0 && tiers.length > 1 ? 1 : 0];
  const metal = plainStyle([0.05, 0.052, 0.056], 0.6);

  // a mast with its warning light on the taller ones; lamps on the corners of the tallest
  const hm = hash11(t.seed * 419.3);
  if (t.h > 60 && hm < (t.h > 170 ? 0.85 : 0.45)) {
    const mh = clamp(t.h * (0.12 + 0.14 * hash11(t.seed * 523.1)), 9, 60);
    const mw = t.h > 170 ? 0.9 : 0.4;
    base.box(tc[0], top + mh * 0.3, tc[1], mw, mh * 0.3, mw, 1, 0, metal, CYBER_KIND.plain);
    base.box(tc[0], top + mh * 0.8, tc[1], mw * 0.45, mh * 0.2, mw * 0.45, 1, 0, metal, CYBER_KIND.plain);
    e.beacons.push(tc[0], top + mh + 0.5, tc[1], hash11(t.seed * 617.9));
    if (mh > 30) e.beacons.push(tc[0], top + mh * 0.6, tc[1], 2);
  } else if (t.h > 110) {
    e.beacons.push(tc[0], top + 1.5, tc[1], hash11(t.seed * 617.9));
  }
  if (t.h > 190) for (const k of [0, 2]) e.beacons.push(tq[k][0], top + 1, tq[k][1], 2);

  // the roof's plant: air handlers, a tank, a lift housing
  if (detail && t.away < 420) {
    const n = 2 + Math.floor(rnd() * 4);
    const ed = edgeOf(tq, 0);
    for (let i = 0; i < n; i++) {
      const p = inQuad(tq, 0.2 + 0.6 * rnd(), 0.2 + 0.6 * rnd());
      const r = rnd();
      if (r < 0.2 && !t.glass) tank(detail, p[0], p[1], top, top + 2.6 + rnd() * 1.6, 1.4 + rnd() * 1.1, metal);
      else detail.box(p[0], top + 0.9 + r * 0.8, p[1], 1.2 + rnd() * 2.4, 0.9 + r * 0.8, 0.9 + rnd() * 1.6, ed.tx, ed.tz, r > 0.7 ? plainStyle([0.1, 0.1, 0.105], 0.3) : metal, CYBER_KIND.plain);
    }
  }
  if (!t.street) {
    // a megatower near the circuit: a banner of light high on the wall that faces the road
    if (t.away < 520 && t.h > 90 && rnd() < 0.42) {
      let best = 0;
      let bd = -Infinity;
      for (let k = 0; k < 4; k++) {
        const ed = edgeOf(shaft.q0, k);
        const d = ed.nx * t.rx + ed.nz * t.rz;
        if (d > bd) {
          bd = d;
          best = k;
        }
      }
      const ed = edgeOf(shaft.q0, best);
      const tall = rnd() < 0.6;
      const w = tall ? 5 + rnd() * 5 : Math.min(ed.len * 0.6, 14 + rnd() * 14);
      const h = tall ? Math.min((shaft.y1 - shaft.y0) * 0.5, 26 + rnd() * 34) : w * (0.55 + 0.5 * rnd());
      const u = tall ? (rnd() < 0.5 ? 0.14 : 0.86) : 0.5;
      const yc = shaft.y1 - h / 2 - 3 - rnd() * (shaft.y1 - shaft.y0) * 0.2;
      slab(base, ed.a[0] + ed.tx * ed.len * u + ed.nx * 0.5, yc, ed.a[1] + ed.tz * ed.len * u + ed.nz * 0.5, ed.tx, ed.tz, w, h, ed.nx, ed.nz, 0.5, signStyle(w, h, rnd), CYBER_KIND.sign);
    }
    return shaft.y1;
  }

  // ── a street tower's signs ──────────────────────────────────────────────────────────────────────────────────────────────────
  const front = edgeOf(shaft.q0, 0);
  const pod = edgeOf(t.quad, 0);
  const y0 = shaft.y0;
  const room = shaft.y1 - y0;
  // how far the podium stands out in front of the shaft: a blade reaches past it
  const step = Math.max(0, (pod.a[0] - front.a[0]) * front.nx + (pod.a[1] - front.a[1]) * front.nz);
  // blades standing out from the facade, written downward
  const blades = rnd() < 0.62 ? (rnd() < 0.35 ? 2 : 1) : 0;
  for (let i = 0; i < blades; i++) {
    const w = 1.5 + rnd() * 1.5;
    const h = Math.min(room * 0.7, 7 + rnd() * 13);
    if (h < 5) continue;
    const u = blades === 2 ? (i ? 0.84 : 0.16) : 0.12 + 0.76 * rnd();
    const out = step + 0.5 + w / 2;
    const yc = y0 + 1.5 + rnd() * Math.min(10, Math.max(0, room - h - 3)) + h / 2;
    const sg = signStyle(w, h, rnd);
    slab(base, front.a[0] + front.tx * front.len * u + front.nx * out, yc, front.a[1] + front.tz * front.len * u + front.nz * out, front.nx, front.nz, w, h, front.tx, front.tz, 0.34, sg, CYBER_KIND.sign, sg);
    // the two arms that hold it
    for (const ya of [yc + h * 0.38, yc - h * 0.38]) {
      base.box(front.a[0] + front.tx * front.len * u + front.nx * (step + 0.25) * 0.5, ya, front.a[1] + front.tz * front.len * u + front.nz * (step + 0.25) * 0.5, (step + 0.25) * 0.5, 0.08, 0.08, front.nx, front.nz, metal, CYBER_KIND.plain, true);
    }
  }
  // a panel on the facade
  if (room > 16 && rnd() < 0.4) {
    const w = Math.min(front.len * 0.62, 7 + rnd() * 13);
    const h = Math.min(room * 0.5, w * (0.45 + 0.55 * rnd()));
    const u = 0.3 + 0.4 * rnd();
    const yc = y0 + 2.5 + rnd() * Math.max(0, Math.min(26, room - h - 5)) + h / 2;
    slab(base, front.a[0] + front.tx * front.len * u + front.nx * 0.3, yc, front.a[1] + front.tz * front.len * u + front.nz * 0.3, front.tx, front.tz, w, h, front.nx, front.nz, 0.4, signStyle(w, h, rnd), CYBER_KIND.sign);
  }
  // a big one on the side wall that faces the traffic
  if (room > 26 && rnd() < 0.36) {
    const side = edgeOf(shaft.q0, 3);
    const w = Math.min(side.len * 0.7, 8 + rnd() * 12);
    const h = Math.min(room * 0.45, w * (0.7 + 0.9 * rnd()));
    const yc = shaft.y1 - 4 - rnd() * room * 0.25 - h / 2;
    slab(base, side.a[0] + side.tx * side.len * 0.5 + side.nx * 0.3, yc, side.a[1] + side.tz * side.len * 0.5 + side.nz * 0.3, side.tx, side.tz, w, h, side.nx, side.nz, 0.4, signStyle(w, h, rnd), CYBER_KIND.sign);
  }
  // a billboard on the roof of a lower one, on a frame, facing the street
  if (t.h < 62 && rnd() < 0.3) {
    const ed = edgeOf(tq, 0);
    const w = Math.min(ed.len * 0.8, 9 + rnd() * 11);
    const h = 3.6 + rnd() * 3.4;
    const cx = ed.a[0] + ed.tx * ed.len * 0.5 - ed.nx * 1.2;
    const cz = ed.a[1] + ed.tz * ed.len * 0.5 - ed.nz * 1.2;
    slab(base, cx, top + 1.6 + h / 2, cz, ed.tx, ed.tz, w, h, ed.nx, ed.nz, 0.3, signStyle(w, h, rnd), CYBER_KIND.sign);
    for (const k of [-0.4, 0, 0.4]) {
      base.box(cx + ed.tx * w * k - ed.nx * 0.3, top + (1.6 + h) / 2, cz + ed.tz * w * k - ed.nz * 0.3, 0.12, (1.6 + h) / 2, 0.12, ed.tx, ed.tz, metal, CYBER_KIND.plain, false);
      // a strut back to the roof
      base.box(cx + ed.tx * w * k - ed.nx * 1.4, top + 0.12, cz + ed.tz * w * k - ed.nz * 1.4, 0.1, 0.12, 1.1, ed.tx, ed.tz, metal, CYBER_KIND.plain, true);
    }
  }
  return shaft.y1;
}

// ── the builder ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const _tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
const _v = new THREE.Vector3();

interface Cell {
  rows: CityBuf;
  sky: CityBuf;
  detail: CityBuf;
}

export function buildMegacity(ctx: Ctx, cd: CityDef): CityResult {
  const rt = ctx.rt;
  const N = rt.count;
  const L = rt.length;
  const h = rt.spacing;
  const seed = cd.seed ?? 77;
  const rnd = mulberry32(seed ^ 0x3c6ef372);
  const rndDec = mulberry32(seed ^ 0x1b873593);
  const noise = new Noise2(seed * 5 + 3);
  const grid = new LotGrid<{ quad: Pt[] }>();
  const sidewalk = cd.sidewalk ?? [4, 8];
  const heights = cd.heights ?? [25, 110];
  const tmpC = [0, 0, 0];

  // ── where no tower stands beside the road: the open stretches per side, the tunnels' mouths ───────────────────────────────────
  const markSpan = (arr: Uint8Array, from: Mark, to: Mark): void => {
    const i0 = Math.round(resolveMark(rt.plan.marks, L, from) / h);
    let i1 = Math.round(resolveMark(rt.plan.marks, L, to) / h);
    if (i1 < i0) i1 += N;
    for (let i = i0; i <= i1; i++) arr[((i % N) + N) % N] = 1;
  };
  const openL = new Uint8Array(N + 1);
  const openR = new Uint8Array(N + 1);
  for (const o of cd.open ?? []) {
    if (o.side !== 'R') markSpan(openL, o.from, o.to);
    if (o.side !== 'L') markSpan(openR, o.from, o.to);
  }
  for (const [a, b] of rt.tunnelSpans) {
    for (let i = Math.floor((a - 25) / h); i <= Math.ceil((b + 25) / h); i++) {
      openL[((i % N) + N) % N] = 1;
      openR[((i % N) + N) % N] = 1;
    }
  }
  const isOpen = (sgn: 1 | -1, s: number): boolean => (sgn > 0 ? openL : openR)[Math.round(rt.wrapS(s) / h) % N] === 1;
  const wallAt = (sgn: 1 | -1, s: number): number => lerpS(rt, sgn > 0 ? rt.L.wall : rt.R.wall, s);
  const kappaAt = (s: number): number => lerpS(rt, rt.curvature, s);
  const floorSpans = (cd.floors ?? []).map((f) => ({ a: resolveMark(rt.plan.marks, L, f.from), b: resolveMark(rt.plan.marks, L, f.to), min: f.min, max: f.max, side: f.side }));

  /** Does a footprint clear every road (this leg and the others) and the places other builders hold? */
  const clear = (q: Pt[], roadGap: number, hold: number): boolean => {
    const c = centroid(q);
    const pts: Pt[] = [c];
    for (let k = 0; k < q.length; k++) {
      const a = q[k];
      const b = q[(k + 1) % q.length];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
      for (let j = 0; j < n; j++) {
        const x = a[0] + ((b[0] - a[0]) * j) / n;
        const z = a[1] + ((b[1] - a[1]) * j) / n;
        pts.push([x, z], [(x + c[0]) / 2, (z + c[1]) / 2]);
      }
    }
    for (const [x, z] of pts) {
      rt.project(x, z, _tp, -1);
      if (Math.abs(_tp.d) < (_tp.d >= 0 ? _tp.wallLeft : _tp.wallRight) + roadGap) return false;
      for (const r of ctx.reserved) if (r(x, z, hold)) return false;
    }
    return true;
  };

  // ── choices ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const mkTower = (quad: Pt[], yRef: number, yBot: number, hgt: number, street: boolean, away: number, rx: number, rz: number): Tower => {
    const glass = rnd() < (street ? 0.58 : 0.7);
    const pal = glass ? GLASS : CONCRETE;
    linear(pal[Math.floor(rnd() * pal.length)], tmpC, 1);
    // most towers are nearly dark, a few are lit from top to bottom
    const r = rnd();
    const lit = r < 0.18 ? 0.015 + 0.03 * rnd() : clamp(0.05 + 0.36 * rnd() * rnd() + (r > 0.92 ? 0.22 : 0), 0.04, 0.6);
    let flags = 0;
    if (rnd() < (street ? 0.4 : 0.6)) flags |= CYBER_FLAG.crown;
    if (rnd() < 0.3) flags |= CYBER_FLAG.edges;
    if (rnd() < 0.34) flags |= CYBER_FLAG.bands;
    if (glass && rnd() < 0.14) flags |= CYBER_FLAG.lines;
    const ar = rnd();
    const arche = street ? (ar < 0.42 ? 0 : ar < 0.72 ? 1 : ar < 0.94 ? 3 : 2) : hgt < 70 ? (ar < 0.6 ? 0 : 3) : ar < 0.34 ? 1 : ar < 0.66 ? 2 : ar < 0.82 ? 0 : 3;
    const gH = street || away < 160 ? (rnd() < 0.6 ? 6.6 + rnd() * 1.6 : 9 + rnd() * 4) : 0;
    return { quad, yRef, yBot, h: hgt, glass, col: [tmpC[0], tmpC[1], tmpC[2]], seed: seedOf(rnd()), lit, accent: pickWeighted(ACCENT_W, rnd()), flags, gH, arche, street, away, rx, rz };
  };

  // ── the landmarks take their ground first ────────────────────────────────────────────────────────────────────────────────────────
  const places: MegaPlace[] = [];
  for (const lm of cd.landmarks ?? []) {
    const p = lm.kind === 'spire' ? placeSpire(rt, lm) : lm.kind === 'arcology' ? placeArcology(rt, lm) : null;
    if (!p) continue;
    places.push(p);
    grid.add({ quad: p.quad });
  }

  // ── the street rows ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const streetTowers: Tower[] = [];
  for (const side of [1, -1] as const) {
    let s = rnd() * 14;
    let prevH = -100;
    while (s < L - 12) {
      if (isOpen(side, s) || isOpen(side, s + 10)) {
        s += 8;
        continue;
      }
      const zone = 0.5 + 0.5 * noise.noise(s / 300 + 40, side * 5.1);
      let w = 24 + rnd() * (20 + 18 * zone);
      while (w > 20 && isOpen(side, s + w)) w -= 5;
      if (isOpen(side, s + w) || s + w > L - 2) {
        s += 8;
        continue;
      }
      if (rnd() < 0.09) {
        // a side street
        s += 9 + rnd() * 8;
        continue;
      }
      const s1 = s + w;
      let front = 0;
      for (let ss = s; ss <= s1 + 0.01; ss += 2) front = Math.max(front, wallAt(side, ss));
      const sw = sidewalk[0] + (sidewalk[1] - sidewalk[0]) * rnd();
      const setback = rnd() < 0.7 ? 0 : rnd() < 0.7 ? 2 + rnd() * 4 : 8 + rnd() * 8;
      const depth = 24 + rnd() * 20;
      let kmax = 0;
      for (let ss = s; ss <= s1 + 0.01; ss += 3) kmax = Math.max(kmax, side * kappaAt(ss));
      let placed = false;
      // (where the pits, a stand or a camera hold the ground beside the road, the tower stands behind them)
      for (const push of [0, 14, 28, 44, 60, 78]) {
        const d0 = front + sw + setback + push;
        let d1 = d0 + depth;
        if (kmax > 1e-4) {
          // the inside of a bend: the offset curve shrinks to a point at 1 / kappa
          const reach = 0.7 / kmax;
          if (d0 > reach - 14) break;
          d1 = Math.min(d1, reach);
        }
        const corner = (ss: number, d: number): Pt => {
          rt.pointAt(ss, side * d, _v);
          return [_v.x, _v.z];
        };
        const quad: Pt[] = [corner(s, d0), corner(s1, d0), corner(s1, d1), corner(s, d1)];
        const area = (quad[1][0] - quad[0][0]) * (quad[3][1] - quad[0][1]) - (quad[1][1] - quad[0][1]) * (quad[3][0] - quad[0][0]);
        const frontLen = Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]);
        const backLen = Math.hypot(quad[2][0] - quad[3][0], quad[2][1] - quad[3][1]);
        if (Math.abs(area) < 250 || backLen < frontLen * 0.5 || frontLen < 14) break;
        if (!clear(quad, 3, 1.5) || grid.overlaps(quad, 1.5)) continue;
        // how tall: by district, never the same as the neighbour
        const ss = rt.wrapS(s + w / 2);
        const zh = smoothstep(-0.5, 0.6, noise.noise(ss / 420 + 9, side * 2.3));
        let lo = heights[0] + (heights[1] - heights[0]) * 0.3 * zh;
        let hi = heights[0] + (heights[1] - heights[0]) * (0.4 + 0.6 * zh);
        for (const f of floorSpans) {
          const inside = f.a <= f.b ? ss >= f.a && ss <= f.b : ss >= f.a || ss <= f.b;
          if (inside && (!f.side || f.side === 'B' || (f.side === 'L') === side > 0)) {
            lo = f.min * 4;
            hi = f.max * 4;
          }
        }
        let hgt = lo + (hi - lo) * Math.pow(rnd(), 1.3);
        if (Math.abs(hgt - prevH) < 9) hgt += hgt + 16 > hi + 8 ? -16 : 16;
        hgt = Math.max(18, hgt);
        prevH = hgt;
        rt.pointAt(s, side * d0, _v);
        const ya = _v.y;
        rt.pointAt(s1, side * d0, _v);
        const yRef = Math.max(ya, _v.y);
        let yBot = Math.min(ya, _v.y);
        for (const [x, z] of quad) yBot = Math.min(yBot, rt.heightFast(x, z));
        const i = Math.round(ss / h) % N;
        const t = mkTower(quad, yRef, yBot - 1.5, hgt, true, d0 - front, -side * rt.HLX[i], -side * rt.HLZ[i]);
        streetTowers.push(t);
        grid.add(t);
        placed = true;
        break;
      }
      // an alley between most neighbours, a party wall between some
      s = placed ? s1 + (rnd() < 0.3 ? 0 : 1.5 + rnd() * 3.5) : s + 8;
    }
  }

  // ── the megatowers: on two street grids (one turned), beyond the rows and in the middle of the circuit ─────────────────────────────
  const skyTowers: Tower[] = [];
  const skyGrid = new LotGrid<{ quad: Pt[] }>();
  if (cd.skyline) {
    const sk = cd.skyline;
    const b = rt.bounds;
    const top = sk.top ?? 320;
    const mx = (b.minX + b.maxX) / 2;
    const mz = (b.minZ + b.maxZ) / 2;
    const half = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) / 2;
    const pitch = 74;
    const density = sk.density * (ctx.q.tier === 0 ? 0.6 : 1);
    for (const th of [0, 0.42]) {
      const cs = Math.cos(th);
      const sn = Math.sin(th);
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
          const px = a * cs - c * sn + (rnd() - 0.5) * 8;
          const pz = a * sn + c * cs + (rnd() - 0.5) * 8;
          // each grid owns the districts where the domain noise has its sign
          if ((noise.noise(px / 460 + 3, pz / 460 - 8) > 0 ? 0 : 1) !== (th === 0 ? 0 : 1)) continue;
          rt.project(px, pz, _tp, -1);
          const wall = _tp.d >= 0 ? _tp.wallLeft : _tp.wallRight;
          const away = Math.abs(_tp.d) - wall;
          if (away < 22 || away > sk.reach) continue;
          if (away < 90 && isOpen(_tp.d >= 0 ? 1 : -1, _tp.s)) continue;
          const fall = 1 - smoothstep(sk.reach * 0.5, sk.reach, away);
          // squares and low blocks here and there: the town is not one wall
          const town = smoothstep(-0.7, -0.1, noise.noise(px / 210 + 9, pz / 210 - 4));
          if (rnd() > density * fall * (0.35 + 0.65 * town)) continue;
          // taller toward the middle of town, by districts
          const core = 1 - smoothstep(half * 0.45, half + sk.reach * 0.75, Math.hypot(px - mx, pz - mz));
          const dn = smoothstep(-0.6, 0.7, noise.noise(px / 420 + 17, pz / 420 - 5));
          const hgt = 48 + (top - 48) * core * (0.25 + 0.75 * dn) * (0.3 + 0.7 * Math.pow(rnd(), 1.4));
          const slabLike = rnd() < 0.18;
          const big = hgt > 190 ? 8 : 0;
          const wx = slabLike ? 20 + rnd() * 6 : 30 + big + rnd() * 20;
          const wz = slabLike ? 46 + rnd() * 14 : 30 + big + rnd() * 20;
          const yaw = th + (rnd() < 0.5 ? 0 : Math.PI / 2);
          const ys = Math.sin(yaw);
          const yc = Math.cos(yaw);
          const q: Pt[] = [
            [px - (yc * wx) / 2 - (ys * wz) / 2, pz + (ys * wx) / 2 - (yc * wz) / 2],
            [px + (yc * wx) / 2 - (ys * wz) / 2, pz - (ys * wx) / 2 - (yc * wz) / 2],
            [px + (yc * wx) / 2 + (ys * wz) / 2, pz - (ys * wx) / 2 + (yc * wz) / 2],
            [px - (yc * wx) / 2 + (ys * wz) / 2, pz + (ys * wx) / 2 + (yc * wz) / 2],
          ];
          if (grid.overlaps(q, 7) || skyGrid.overlaps(q, 9)) continue;
          if (!clear(q, 12, 8)) continue;
          let yMin = Infinity;
          let yMax = -Infinity;
          for (const [x, z] of q) {
            const y = rt.fieldHeight(x, z);
            yMin = Math.min(yMin, y);
            yMax = Math.max(yMax, y);
          }
          // toward the road: from the tower's centre to its foot on the centre line
          rt.pointAt(_tp.s, 0, _v);
          const dl = Math.hypot(_v.x - px, _v.z - pz) || 1;
          const t = mkTower(q, yMax, yMin - 1.5, hgt, false, away, (_v.x - px) / dl, (_v.z - pz) / dl);
          skyTowers.push(t);
          skyGrid.add(t);
        }
      }
    }
  }

  // nothing else is planted where a tower stands
  ctx.reserved.push((x, z, margin) => grid.near(x, z, margin) || skyGrid.near(x, z, margin));

  // the ground: how close the towers are (the terrain shader lays pavement and their light at their feet)
  {
    const b = rt.bounds;
    const cell = 8;
    const reach = (cd.skyline?.reach ?? 300) + 120;
    const x0 = b.minX - reach;
    const z0 = b.minZ - reach;
    const nx = Math.ceil((b.maxX + reach - x0) / cell) + 1;
    const nz = Math.ceil((b.maxZ + reach - z0) / cell) + 1;
    const raster = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = x0 + i * cell;
        const z = z0 + j * cell;
        raster[j * nx + i] = grid.near(x, z, 9) || skyGrid.near(x, z, 9) ? 1 : grid.near(x, z, 24) || skyGrid.near(x, z, 24) ? 0.5 : 0;
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

  // ── geometry, per cell of the map ────────────────────────────────────────────────────────────────────────────────────────────────
  const CELL = 360;
  const cells = new Map<string, Cell>();
  const cellAt = (x: number, z: number): Cell => {
    const key = `${Math.floor(x / CELL)}_${Math.floor(z / CELL)}`;
    let c = cells.get(key);
    if (!c) {
      c = { rows: new CityBuf(), sky: new CityBuf(), detail: new CityBuf() };
      cells.set(key, c);
    }
    return c;
  };
  const beacons: number[] = [];
  const occ = new Occluders();
  const withDetail = ctx.q.tier >= 1;
  for (const t of streetTowers) {
    const c = centroid(t.quad);
    const cl = cellAt(c[0], c[1]);
    occ.add(t.quad, emitTower(t, { base: cl.rows, detail: withDetail ? cl.detail : null, beacons, rnd: rndDec }));
  }
  for (const t of skyTowers) {
    const c = centroid(t.quad);
    const cl = cellAt(c[0], c[1]);
    occ.add(t.quad, emitTower(t, { base: cl.sky, detail: withDetail ? cl.detail : null, beacons, rnd: rndDec }));
  }
  for (const p of places) {
    const cl = cellAt(p.x, p.z);
    const top = p.kind === 'spire' ? emitSpire(cl.sky, beacons, rt, p) : emitArcology(cl.sky, beacons, rt, p, rndDec);
    occ.add(p.quad, top, 1);
  }

  // ── meshes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const group = new THREE.Group();
  group.name = 'megacity';
  const cyber = makeCyberMaterial(ctx);
  ctx.disposables.push(cyber.mat);
  interface Rec {
    mesh: THREE.Mesh;
    cx: number;
    cz: number;
    r: number;
    /** 0 the street rows, 1 the megatowers, 2 the roofs' plant. */
    layer: number;
  }
  const recs: Rec[] = [];
  const add = (buf: CityBuf, name: string, layer: number): void => {
    if (buf.empty) return;
    const geo = buf.build();
    geo.computeBoundingBox();
    const mesh = new THREE.Mesh(geo, cyber.mat);
    mesh.name = name;
    mesh.castShadow = layer === 0;
    mesh.receiveShadow = true;
    group.add(mesh);
    ctx.disposables.push(geo);
    const bs = geo.boundingSphere!;
    recs.push({ mesh, cx: bs.center.x, cz: bs.center.z, r: bs.radius, layer });
  };
  for (const [key, c] of cells) {
    add(c.rows, `mega_rows_${key}`, 0);
    add(c.sky, `mega_sky_${key}`, 1);
    add(c.detail, `mega_detail_${key}`, 2);
  }
  if (beacons.length) {
    const n = beacons.length / 4;
    const pos = new Float32Array(n * 3);
    const ph = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = beacons[i * 4];
      pos[i * 3 + 1] = beacons[i * 4 + 1];
      pos[i * 3 + 2] = beacons[i * 4 + 2];
      ph[i] = beacons[i * 4 + 3];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    geo.computeBoundingSphere();
    const mat = makeBeaconMaterial(ctx, cyber.sign);
    const pts = new THREE.Points(geo, mat);
    pts.name = 'mega_beacons';
    group.add(pts);
    ctx.disposables.push(geo, mat);
    ctx.envListeners.push(() => {
      pts.visible = cyber.sign.value > 0.02;
    });
  }
  const cam = new THREE.Vector3();
  ctx.updaters.push((_dt, camera) => {
    camera.getWorldPosition(cam);
    for (const r of recs) {
      const d = Math.max(0, Math.hypot(r.cx - cam.x, r.cz - cam.z) - r.r);
      if (r.layer === 0) {
        r.mesh.visible = d < 3200;
        r.mesh.castShadow = d < 230;
      } else if (r.layer === 1) r.mesh.visible = d < 3600;
      else r.mesh.visible = d < 380;
    }
  });

  return { group, occluders: occ.build() };
}
