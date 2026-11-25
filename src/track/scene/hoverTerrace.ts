/**
 * The hovering grandstands of an orbital circuit (`HoverDef.terraces`): a shallow white hull the shape of a river pebble, a deck
 * behind a glass balustrade, tiers of spectators, and a thin canopy that floats over them, held by nothing. Under the hull, and
 * under the canopy, a ring of pale light: that is what holds them up, and at night it lies on the ground as a faint pool.
 *
 * A terrace is a group of three meshes (the solid parts, the crowd, the glass) that rides the air: a slow bob and drift of a few
 * decimetres, a roll of a fraction of a degree. It casts a shadow, so by day one sees at a glance that nothing stands under it.
 * The pools of all the terraces are one mesh on the ground.
 *
 * Where it hangs: beside the road at a mark, beyond the barrier, and then further out and higher until no part of it is over the
 * run-off, in a TV camera's line of sight to the road or over a camera, and its keel is clear of the ground (and of the lake).
 */
import * as THREE from 'three';
import type { TrackPoint } from '../../core/contracts';
import { resolveMark } from '../plan';
import type { HoverTerraceDef } from '../types';
import type { Ctx } from './ctx';
import { GeoBuf } from './geom';
import { type Facing, GLOW, HoverBuf, type HoverMats, type Node, type RGB, lin, surface } from './hoverKit';

// the palette: white composite, a warm grey deck, a brushed gold line
const HULL = lin(0xebe8df);
const KEEL = lin(0xd9d6cc);
const DECK = lin(0xb4b0a6);
const SEAT = lin(0x8792ad);
const GOLD = lin(0xc7a35c);
const ROOF = lin(0xf1eee6);
const CEIL = lin(0xe2ded4);
/** The lift light (a white with a breath of blue in it) and the warm white of the lines. */
const LIFT = lin(0xdcebff);
const WARM = lin(0xffe9c4);

/** The hull's outline: a superellipse of this exponent (2 = an ellipse, more = a rounder rectangle). */
const SHAPE = 3.4;
const SEGS = 72;
/** The promenades in front of and behind the seats, a row's depth and rise, the walkway behind a tier and its rise (m). */
const FRONT = 2.0;
const REAR = 1.8;
const ROW = 0.9;
const RISE = 0.45;
const WALK = 1.1;
const WALK_RISE = 0.5;
const WALL = 0.35;
/** The hull's rim band (m). */
const RIM = 0.42;
/** No tree stands within this distance behind a hull (m). */
const GLADE = 34;
/** The least air under the keel (m). */
const CLEAR = 4.5;
/** Glass and spectators are not drawn beyond these distances (m): a few pixels of them, three draw calls a terrace. */
const GLASS_RANGE = 520;
const CROWD_RANGE = 1100;

export interface TvCam {
  position: THREE.Vector3;
  s: number;
}

interface Place {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Half length, half depth (m). */
  a: number;
  b: number;
  bend: number;
  /** The keel under the deck (m). */
  keel: number;
  /** From the barrier to the front edge as it came out (m), and the air under the keel (m). */
  gap: number;
  clear: number;
}

/** A point of the outline: angle t round it, at r of the way out. */
function outline(t: number, a: number, b: number, r: number, out: { u: number; v: number }): void {
  const c = Math.cos(t);
  const s = Math.sin(t);
  out.u = r * a * Math.sign(c) * Math.pow(Math.abs(c), 2 / SHAPE);
  out.v = r * b * Math.sign(s) * Math.pow(Math.abs(s), 2 / SHAPE);
}

/** The outline's outward direction at a point (u, v) of it (not unit). */
function outward(u: number, v: number, a: number, b: number, out: { u: number; v: number }): void {
  out.u = (Math.sign(u) * Math.pow(Math.abs(u) / a, SHAPE - 1)) / a;
  out.v = (Math.sign(v) * Math.pow(Math.abs(v) / b, SHAPE - 1)) / b;
  const l = Math.hypot(out.u, out.v) || 1;
  out.u /= l;
  out.v /= l;
}

/** A quad of a plain buffer wound so that it faces (nx, ny, nz). */
function gquad(buf: GeoBuf, a: number, b: number, c: number, d: number, nx: number, ny: number, nz: number): void {
  const P = buf.pos;
  const ux = P[b * 3] - P[a * 3];
  const uy = P[b * 3 + 1] - P[a * 3 + 1];
  const uz = P[b * 3 + 2] - P[a * 3 + 2];
  const vx = P[d * 3] - P[a * 3];
  const vy = P[d * 3 + 1] - P[a * 3 + 1];
  const vz = P[d * 3 + 2] - P[a * 3 + 2];
  if ((uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz >= 0) buf.quad(a, b, c, d);
  else buf.quad(a, d, c, b);
}

/** The hull's own frame, bent round a centre `rb` m in front of it (0: straight): u along the hull, v from front to back. */
class Bent {
  constructor(readonly rb: number) {}
  x(u: number, v: number): number {
    return this.rb ? (this.rb + v) * Math.sin(u / this.rb) : u;
  }
  z(u: number, v: number): number {
    return this.rb ? (this.rb + v) * Math.cos(u / this.rb) - this.rb : v;
  }
  /** The direction (du, dv) at u. */
  dx(u: number, du: number, dv: number): number {
    if (!this.rb) return du;
    const f = u / this.rb;
    return du * Math.cos(f) + dv * Math.sin(f);
  }
  dz(u: number, du: number, dv: number): number {
    if (!this.rb) return dv;
    const f = u / this.rb;
    return -du * Math.sin(f) + dv * Math.cos(f);
  }
}

function depthOf(tiers: number, rows: number): number {
  return FRONT + tiers * rows * ROW + (tiers - 1) * WALK + WALL + REAR;
}

const _tp = {} as TrackPoint;
const _o = { u: 0, v: 0 };

function place(ctx: Ctx, def: HoverTerraceDef, cams: readonly TvCam[]): Place {
  const rt = ctx.rt;
  const s = resolveMark(rt.plan.marks, rt.length, def.at);
  const k = Math.round(s / rt.spacing) % rt.count;
  const sgn = def.side === 'L' ? 1 : -1;
  const S = sgn > 0 ? rt.L : rt.R;
  const tiers = def.tiers ?? 3;
  const rows = def.rows ?? 2;
  const a = def.length / 2;
  const b = depthOf(tiers, rows) / 2;
  const bend = def.curve ?? 0;
  const keel = RIM + Math.min(2.6, Math.max(1.5, 0.19 * 2 * b));
  // local x (u) runs against the road's direction on the left of it and along it on the right, so that local z (v) points away from it
  const yawOff = ((def.yaw ?? 0) * Math.PI) / 180;
  const ux = -sgn * rt.HTX[k];
  const uz = -sgn * rt.HTZ[k];
  const yaw = Math.atan2(-uz, ux) + yawOff;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const ox = sgn * rt.HLX[k];
  const oz = sgn * rt.HLZ[k];
  const bent = new Bent(bend);
  const lake = rt.def.terrain.lake;
  const p: Place = { x: 0, y: 0, z: 0, yaw, a, b, bend, keel, gap: def.gap, clear: 0 };
  // the footprint: the outline and a ring inside it, in the world
  const N = 28;
  const fx = new Float64Array(N * 2);
  const fz = new Float64Array(N * 2);
  let ground = -Infinity;
  let gap = def.gap;
  for (let it = 0; it < 30; it++, gap += 2.5) {
    const d = S.wall[k] + gap + b;
    p.x = rt.X[k] + ox * d;
    p.z = rt.Z[k] + oz * d;
    let ok = true;
    ground = -Infinity;
    for (let i = 0; i < N * 2; i++) {
      outline((i / N) * Math.PI * 2, a, b, i < N ? 1 : 0.5, _o);
      const lx = bent.x(_o.u, _o.v);
      const lz = bent.z(_o.u, _o.v);
      // (a rotation by yaw about +y: local x to (cos, 0, -sin), local z to (sin, 0, cos))
      const wx = p.x + lx * cy + lz * sy;
      const wz = p.z - lx * sy + lz * cy;
      fx[i] = wx;
      fz[i] = wz;
      rt.project(wx, wz, _tp);
      // never over the road or its run-off: 3 m behind the barrier at the least
      if (Math.abs(_tp.d) < (_tp.d >= 0 ? _tp.wallLeft : _tp.wallRight) + 3) ok = false;
      // nor between a TV camera and its stretch of road, nor over a camera
      if (ok && ctx.viewReserved.some((r) => r(wx, wz, 2))) ok = false;
      if (ok) for (const c of cams) if ((c.position.x - wx) * (c.position.x - wx) + (c.position.z - wz) * (c.position.z - wz) < 49) ok = false;
      if (!ok) break;
      let g = rt.heightXZ(wx, wz);
      if (lake) g = Math.max(g, lake.level);
      ground = Math.max(ground, g);
    }
    if (ok) break;
  }
  p.y = Math.max(rt.py[k] + def.height, ground + keel + CLEAR);
  p.gap = gap;
  p.clear = p.y - keel - ground;
  // the ground under it, and the way to the road, stay clear of trees and of whatever else asks
  const hx = cy;
  const hz = -sy;
  const half = Math.max(0, a - b);
  ctx.reserved.push((x, z, m) => {
    for (let q = 0; q < 3; q++) {
      // (the hull, the stretch between it and the barrier, and a glade behind it: its outline stands against the sky, not in the trees)
      const off = q === 0 ? 0 : q === 1 ? -(b + gap / 2) : b + GLADE / 2;
      const ccx = p.x + ox * off;
      const ccz = p.z + oz * off;
      const r = (q === 0 ? b + 7 : q === 1 ? gap / 2 + 3 : GLADE / 2 + 4) + m;
      const t = Math.max(-half, Math.min(half, (x - ccx) * hx + (z - ccz) * hz));
      const dx = x - (ccx + hx * t);
      const dz = z - (ccz + hz * t);
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  });
  return p;
}

/** The solid parts, the crowd and the glass of one terrace, in its own frame (the deck at y = 0). */
function shape(def: HoverTerraceDef, p: Place, solid: HoverBuf, crowd: GeoBuf, glass: GeoBuf): void {
  const { a, b } = p;
  const bent = new Bent(p.bend);
  const tiers = def.tiers ?? 3;
  const rows = def.rows ?? 2;
  const o = { u: 0, v: 0 };
  const ring = (t: number, aa: number, bb: number, r: number, y: number, n: Node, cv = 0): void => {
    outline(t, aa, bb, r, o);
    n.x = bent.x(o.u, o.v + cv);
    n.y = y;
    n.z = bent.z(o.u, o.v + cv);
  };
  const ang = (i: number): number => (i / SEGS) * Math.PI * 2;
  /**
   * How far the outline is from the middle at each angle, measured square to the outline (m): a band between two rings that are
   * w / reach apart in r is w metres wide all the way round (rings a constant r apart are five times wider at the ends of a hull
   * than along its sides).
   */
  const reach = (aa: number, bb: number): Float64Array => {
    const out = new Float64Array(SEGS);
    const od = { u: 0, v: 0 };
    for (let i = 0; i < SEGS; i++) {
      outline(ang(i), aa, bb, 1, o);
      outward(o.u, o.v, aa, bb, od);
      out[i] = o.u * od.u + o.v * od.v;
    }
    return out;
  };
  const HR = reach(a, b);
  const UP: RGB = [0, 1, 0];
  const DOWN: RGB = [0, -1, 0];
  const OUT: Facing = { cx: 0, cz: 0 };

  // ── the hull ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  // the keel: steep at the rim, flat in the middle, with the ring of light two thirds of the way out and its wash on the keel
  const hb = p.keel - RIM;
  const KR = [1, 0.985, 0.95, 0.88, 0.8, 0.73, 0, 0, 0, 0, 0.58, 0.48, 0.3, 0];
  const KG = [0, 0, 0, 0, 0.01, 0.035, 0.1, 1, 1, 0.1, 0.035, 0.012, 0, 0];
  // (the ring of light: 0.36 m wide, round r = 0.66; rows 6 to 9 are its two edges and a finger of wash on either side)
  const KB = [0.18 + 0.05, 0.18, -0.18, -0.18 - 0.05];
  surface(solid, SEGS, KR.length - 1, true, DOWN, (i, j, n) => {
    const r = j >= 6 && j <= 9 ? 0.66 + KB[j - 6] / HR[i % SEGS] : KR[j];
    ring(ang(i), a, b, r, -RIM - hb * Math.sqrt(1 - Math.pow(r, 3.2)), n);
    n.c = r > 0.9 ? HULL : KEEL;
    n.g = KG[j] > 0 ? LIFT : null;
    n.mode = GLOW.lift;
    n.k = KG[j];
  });
  // the rim: white, a gold line that is a line of warm light after dark, white
  const rim: [number, number, RGB, number][] = [
    [0, -0.15, HULL, 0],
    [-0.15, -0.23, GOLD, 0.8],
    [-0.23, -RIM, HULL, 0],
  ];
  for (const [y0, y1, c, k] of rim) {
    surface(solid, SEGS, 1, true, OUT, (i, j, n) => {
      ring(ang(i), a, b, 1, j === 0 ? y0 : y1, n);
      n.c = c;
      n.g = k > 0 ? WARM : null;
      n.mode = GLOW.night;
      n.k = k;
    });
  }
  // the deck, with a white coping
  const DR = [0, 0.6, 0, 0, 1];
  surface(solid, SEGS, DR.length - 1, true, UP, (i, j, n) => {
    ring(ang(i), a, b, j === 2 || j === 3 ? 1 - 0.34 / HR[i % SEGS] : DR[j], 0, n);
    n.c = j >= 3 ? HULL : DECK;
  });
  // the balustrade: glass all the way round, under a gold rail
  const ga = a - 0.3;
  const gb = b - 0.3;
  {
    const base = glass.count;
    const od = { u: 0, v: 0 };
    for (let i = 0; i <= SEGS; i++) {
      outline(ang(i), ga, gb, 1, o);
      outward(o.u, o.v, ga, gb, od);
      const nx = bent.dx(o.u, od.u, od.v);
      const nz = bent.dz(o.u, od.u, od.v);
      for (const y of [0.02, 1.08]) glass.v(bent.x(o.u, o.v), y, bent.z(o.u, o.v), nx, 0, nz, i / SEGS, y);
    }
    for (let i = 0; i < SEGS; i++) {
      const q = base + i * 2;
      gquad(glass, q, q + 2, q + 3, q + 1, glass.nor[q * 3], 0, glass.nor[q * 3 + 2]);
    }
  }
  const rail: [number, number, number, number, Facing][] = [
    [0.03, 1.08, 0.03, 1.13, OUT],
    [-0.03, 1.13, 0.03, 1.13, UP],
  ];
  for (const [d0, y0, d1, y1, ref] of rail) {
    surface(solid, SEGS, 1, true, ref, (i, j, n) => {
      const d = j === 0 ? d0 : d1;
      ring(ang(i), ga + d, gb + d, 1, j === 0 ? y0 : y1, n);
      n.c = GOLD;
    });
  }
  // (the rail's inner face, toward the deck)
  surface(solid, SEGS, 1, true, { cx: 0, cz: 0, inward: true }, (i, j, n) => {
    ring(ang(i), ga - 0.03, gb - 0.03, 1, j === 0 ? 1.08 : 1.13, n);
    n.c = GOLD;
  });

  // ── the seats ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  const v0 = -b + FRONT;
  const vWall = v0 + tiers * rows * ROW + (tiers - 1) * WALK;
  const vEnd = vWall + WALL;
  const top = tiers * rows * RISE + (tiers - 1) * WALK_RISE;
  // the block's half length: its corners stay 1.3 m inside the rim
  const vMax = Math.max(-v0, vEnd);
  const ue = a * Math.pow(Math.max(0.05, 1 - Math.pow(vMax / b, SHAPE)), 1 / SHAPE) - 1.3;
  const nu = p.bend ? Math.max(2, Math.ceil((2 * ue) / 6)) : 1;
  /** A band swept along the hull from u0 to u1: the profile's segment (va, ya) - (vb, yb), facing (nv, ny) in the profile's plane. */
  const band = (u0: number, u1: number, va: number, ya: number, vb: number, yb: number, nv: number, ny: number, c: RGB, g: RGB | null = null, k = 1): void => {
    let pa = -1;
    let pb = -1;
    for (let i = 0; i <= nu; i++) {
      const u = u0 + ((u1 - u0) * i) / nu;
      const nx = bent.dx(u, 0, nv);
      const nz = bent.dz(u, 0, nv);
      const A = solid.v(bent.x(u, va), ya, bent.z(u, va), nx, ny, nz, c, g, GLOW.night, k);
      const B = solid.v(bent.x(u, vb), yb, bent.z(u, vb), nx, ny, nz, c, g, GLOW.night, k);
      if (pa >= 0) solid.fquad(pa, A, B, pb, nx, ny, nz);
      pa = A;
      pb = B;
    }
  };
  /** A flat face across the hull at u, facing along it (su): four points (v, y) of the profile's plane. */
  const cap = (u: number, su: number, pts: [number, number][], c: RGB): void => {
    const nx = bent.dx(u, su, 0);
    const nz = bent.dz(u, su, 0);
    const ids = pts.map(([v, y]) => solid.v(bent.x(u, v), y, bent.z(u, v), nx, 0, nz, c));
    solid.fquad(ids[0], ids[1], ids[2], ids[3], nx, 0, nz);
  };
  const pane = (va: number, y0: number, y1: number): void => {
    const base = glass.count;
    for (let i = 0; i <= nu; i++) {
      const u = -ue + (2 * ue * i) / nu;
      for (const y of [y0, y1]) glass.v(bent.x(u, va), y, bent.z(u, va), bent.dx(u, 0, -1), 0, bent.dz(u, 0, -1), i / nu, y);
    }
    for (let i = 0; i < nu; i++) {
      const q = base + i * 2;
      gquad(glass, q, q + 2, q + 3, q + 1, glass.nor[q * 3], 0, glass.nor[q * 3 + 2]);
    }
  };
  let yPrev = 0;
  let row = 0;
  for (let t = 0; t < tiers; t++) {
    const vt = v0 + t * (rows * ROW + WALK);
    for (let r = 0; r < rows; r++, row++) {
      const va = vt + r * ROW;
      const y = t * (rows * RISE + WALK_RISE) + (r + 1) * RISE;
      band(-ue, ue, va, yPrev, va, y, -1, 0, HULL);
      band(-ue, ue, va, y, va + ROW, y, 0, 1, SEAT);
      // the spectators of the row: a strip of the stands' crowd
      const shade = 0.78 + 0.22 * (row / (tiers * rows));
      const base = crowd.count;
      const nc = Math.max(nu, 2);
      for (let i = 0; i <= nc; i++) {
        const u = -ue + 0.3 + ((2 * ue - 0.6) * i) / nc;
        const vv = va + ROW * 0.55;
        for (const [yy, tv] of [[y - 0.05, 0], [y + 1.18, 1]] as const) {
          crowd.v(bent.x(u, vv), yy, bent.z(u, vv), bent.dx(u, 0, -1), 0.05, bent.dz(u, 0, -1), u / 8 + row * 0.37, tv);
          crowd.color(shade, shade, shade);
        }
      }
      for (let i = 0; i < nc; i++) {
        const q = base + i * 2;
        gquad(crowd, q, q + 2, q + 3, q + 1, crowd.nor[q * 3], 0, crowd.nor[q * 3 + 2]);
      }
      yPrev = y;
    }
    if (t < tiers - 1) {
      // the walkway behind the tier, half a metre up, behind a pane of glass
      const vw = vt + rows * ROW;
      const yw = yPrev + WALK_RISE;
      band(-ue, ue, vw, yPrev, vw, yw, -1, 0, HULL);
      band(-ue, ue, vw, yw, vw + WALK, yw, 0, 1, DECK);
      pane(vw + 0.07, yw, yw + 0.92);
      band(-ue, ue, vw + 0.07, yw + 0.92, vw + 0.07, yw + 0.96, -1, 0, GOLD);
      yPrev = yw;
    }
  }
  // the back wall, a line of warm light under its coping
  const wallTop = top + 1.25;
  band(-ue, ue, vWall, top, vWall, wallTop - 0.16, -1, 0, HULL);
  band(-ue, ue, vWall, wallTop - 0.16, vWall, wallTop - 0.1, -1, 0, GOLD, WARM, 0.8);
  band(-ue, ue, vWall, wallTop - 0.1, vWall, wallTop, -1, 0, HULL);
  band(-ue, ue, vWall, wallTop, vEnd, wallTop, 0, 1, HULL);
  band(-ue, ue, vEnd, wallTop, vEnd, 0, 1, 0, HULL);
  // the cheeks: a wall at each end of the block, its top a straight line from the front of the seats to the top of the back wall
  const CHEEK = 0.3;
  const slope = Math.atan2(wallTop - 0.95, vEnd - v0);
  for (const su of [-1, 1]) {
    const u0 = su * ue;
    const u1 = su * (ue + CHEEK);
    const pts: [number, number][] = [
      [v0, 0],
      [vEnd, 0],
      [vEnd, wallTop],
      [v0, 0.95],
    ];
    cap(u1, su, pts, HULL);
    cap(u0, -su, pts, HULL);
    band(u0, u1, v0, 0.95, vEnd, wallTop, -Math.sin(slope), Math.cos(slope), HULL);
    band(u0, u1, v0, 0, v0, 0.95, -1, 0, HULL);
    band(u0, u1, vEnd, 0, vEnd, wallTop, 1, 0, HULL);
  }

  // ── the canopy ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  // a thin lens over the seats, higher at the front; nothing carries it. Under its edge a line of the lift light, and a wash of
  // warm light on its ceiling after dark
  const cFront = v0 - 1.5;
  const cBack = vEnd + 1.1;
  const cv = (cFront + cBack) / 2;
  const cb = (cBack - cFront) / 2;
  const ca = Math.min(a - 0.8, ue + CHEEK + 2.4);
  const yMid = top + 3.7;
  const TILT = 1.1;
  const EDGE = 0.045;
  const tilt = (v: number): number => (TILT * (cv - v)) / (2 * cb);
  const CO: Facing = { cx: bent.x(0, cv), cz: bent.z(0, cv) };
  const TR = [0, 0.4, 0.68, 0.86, 0.96, 1];
  surface(solid, SEGS, TR.length - 1, true, UP, (i, j, n) => {
    const r = TR[j];
    ring(ang(i), ca, cb, r, 0, n, cv);
    outline(ang(i), ca, cb, r, o);
    n.y = yMid + tilt(cv + o.v) + EDGE + 0.4 * Math.sqrt(1 - Math.pow(r, 2.6));
    n.c = ROOF;
  });
  surface(solid, SEGS, 1, true, CO, (i, j, n) => {
    ring(ang(i), ca, cb, 1, 0, n, cv);
    outline(ang(i), ca, cb, 1, o);
    n.y = yMid + tilt(cv + o.v) + (j === 0 ? EDGE : -EDGE);
    n.c = GOLD;
    n.g = WARM;
    n.mode = GLOW.night;
    n.k = 0.5;
  });
  const BR = [1, 0, 0, 0, 0, 0.7, 0.35, 0];
  const BL = [0, 0, 0.4, 0.4, 0, 0, 0, 0];
  const BW = [0.03, 0.07, 0, 0, 0.1, 0.085, 0.065, 0.055];
  // (the line of light under the edge: 0.2 m wide, 0.42 m in from it; rows 1 to 4 are its edges, each doubled for a crisp line)
  const CR = reach(ca, cb);
  const BB = [0.31, 0.32, 0.52, 0.53];
  surface(solid, SEGS, BR.length - 1, true, DOWN, (i, j, n) => {
    const r = j >= 1 && j <= 4 ? 1 - BB[j - 1] / CR[i % SEGS] : BR[j];
    ring(ang(i), ca, cb, r, 0, n, cv);
    outline(ang(i), ca, cb, r, o);
    n.y = yMid + tilt(cv + o.v) - EDGE - 0.12 * Math.sqrt(1 - Math.pow(r, 2.2));
    n.c = CEIL;
    if (BL[j] > 0) {
      n.g = LIFT;
      n.mode = GLOW.lift;
      n.k = BL[j];
    } else {
      n.g = WARM;
      n.mode = GLOW.night;
      n.k = BW[j];
    }
  });
}

/** The light a hull throws on the ground under it: rings of the footprint, fading out. */
const POOL_R = [0, 0.45, 0.8, 1.15, 1.6];
const POOL_K = [1, 0.85, 0.5, 0.16, 0];
const POOL_SEGS = 28;

function pool(ctx: Ctx, p: Place, buf: GeoBuf): void {
  const rt = ctx.rt;
  const bent = new Bent(p.bend);
  const lake = rt.def.terrain.lake;
  const cy = Math.cos(p.yaw);
  const sy = Math.sin(p.yaw);
  const base = buf.count;
  const o = { u: 0, v: 0 };
  for (let j = 0; j < POOL_R.length; j++) {
    for (let i = 0; i < POOL_SEGS; i++) {
      outline((i / POOL_SEGS) * Math.PI * 2, p.a, p.b, POOL_R[j], o);
      const lx = bent.x(o.u, o.v);
      const lz = bent.z(o.u, o.v);
      const wx = p.x + lx * cy + lz * sy;
      const wz = p.z - lx * sy + lz * cy;
      let g = rt.heightXZ(wx, wz);
      if (lake) g = Math.max(g, lake.level);
      buf.v(wx, g + 0.08, wz, 0, 1, 0, 0, 0);
      buf.color(LIFT[0] * POOL_K[j], LIFT[1] * POOL_K[j], LIFT[2] * POOL_K[j]);
    }
  }
  for (let j = 0; j + 1 < POOL_R.length; j++) {
    for (let i = 0; i < POOL_SEGS; i++) {
      const a0 = base + j * POOL_SEGS + i;
      const a1 = base + j * POOL_SEGS + ((i + 1) % POOL_SEGS);
      buf.quad(a0, a1, a1 + POOL_SEGS, a0 + POOL_SEGS);
    }
  }
}

export interface Terraces {
  group: THREE.Group;
  triangles: number;
  /** Where they hang: centre (x, y of the deck, z), half length, half depth (for the builders that come after, and the probes). */
  places: { x: number; y: number; z: number; a: number; b: number; yaw: number; gap: number; clear: number }[];
}

export function buildTerraces(ctx: Ctx, defs: readonly HoverTerraceDef[], mats: HoverMats, cams: readonly TvCam[]): Terraces {
  const group = new THREE.Group();
  group.name = 'hover_terraces';
  const pools = new GeoBuf();
  let triangles = 0;
  const items: { g: THREE.Group; crowd: THREE.Mesh; glass: THREE.Mesh; p: Place; ph: number }[] = [];
  defs.forEach((def, n) => {
    const p = place(ctx, def, cams);
    const solid = new HoverBuf();
    const crowd = new GeoBuf();
    const glass = new GeoBuf();
    shape(def, p, solid, crowd, glass);
    pool(ctx, p, pools);
    const g = new THREE.Group();
    g.name = `hover_terrace_${n}`;
    g.position.set(p.x, p.y, p.z);
    g.rotation.order = 'YXZ';
    g.rotation.y = p.yaw;
    const sm = new THREE.Mesh(solid.build(), mats.solid);
    sm.name = 'hover_solid';
    sm.castShadow = true;
    sm.receiveShadow = true;
    const cm = new THREE.Mesh(crowd.build(), mats.crowd);
    cm.name = 'hover_crowd';
    cm.receiveShadow = true;
    const gg = glass.build();
    gg.deleteAttribute('uv');
    const gm = new THREE.Mesh(gg, mats.glass);
    gm.name = 'hover_glass';
    gm.renderOrder = 2;
    g.add(sm, cm, gm);
    group.add(g);
    triangles += solid.triangles + crowd.idx.length / 3 + glass.idx.length / 3;
    items.push({ g, crowd: cm, glass: gm, p, ph: (n * 0.618 + 0.13) % 1 });
  });
  let poolMesh: THREE.Mesh | null = null;
  if (!pools.empty) {
    const geo = pools.build();
    geo.deleteAttribute('uv');
    geo.deleteAttribute('normal');
    poolMesh = new THREE.Mesh(geo, mats.pool);
    poolMesh.name = 'hover_pools';
    poolMesh.renderOrder = 3;
    group.add(poolMesh);
    triangles += pools.idx.length / 3;
    const pm = poolMesh;
    ctx.envListeners.push((env) => {
      pm.visible = env.darkness > 0.17;
    });
  }
  // they ride the air: a bob of a few decimetres over twenty seconds and more, a drift, a roll one cannot quite see
  let clock = 0;
  ctx.updaters.push((dt, camera) => {
    clock += dt;
    const cam = camera.position;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const p = it.p;
      const w = clock * 6.2831853;
      const f = it.ph * 6.2831853;
      const bob = 0.21 * Math.sin(w / 23 + f) + 0.07 * Math.sin(w / 8.7 + f * 2.3);
      const dx = 0.16 * Math.sin(w / 37 + f * 1.7);
      const dz = 0.13 * Math.sin(w / 29 + f * 3.1);
      it.g.position.set(p.x + dx, p.y + bob, p.z + dz);
      it.g.rotation.x = 0.0035 * Math.sin(w / 17 + f * 4.3);
      it.g.rotation.z = 0.0028 * Math.sin(w / 21 + f * 5.9);
      const d2 = (cam.x - p.x) * (cam.x - p.x) + (cam.z - p.z) * (cam.z - p.z);
      it.glass.visible = d2 < GLASS_RANGE * GLASS_RANGE;
      it.crowd.visible = d2 < CROWD_RANGE * CROWD_RANGE;
    }
  });
  return { group, triangles, places: items.map((it) => ({ x: it.p.x, y: it.p.y, z: it.p.z, a: it.p.a, b: it.p.b, yaw: it.p.yaw, gap: it.p.gap, clear: it.p.clear })) };
}
