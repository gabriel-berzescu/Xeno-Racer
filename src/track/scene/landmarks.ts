/**
 * Landmarks of the harbour city, built from the same stone / tile / copper shading as the blocks: the cathedral at the hairpin (a
 * nave, a pair of bell towers, a dome on a drum) and the castle on the hill over the tunnel (a crenellated curtain wall, towers and a
 * keep). Each is placed on the harbour map, or on the road by mark (the castle stands on the tunnel's cap).
 */
import * as THREE from 'three';
import type { LandmarkDef } from '../types';
import { resolveMark } from '../plan';
import type { TrackRuntimeImpl } from '../runtime';
import { CityBuf, type Pt3, type Style, hipRoof, linear } from './cityBuf';
import { FACADE_KIND } from './facade';

export interface LandmarkPlace {
  def: LandmarkDef;
  /** World position of the centre of the front, facing vector (horizontal unit) and the lateral axis. */
  x: number;
  z: number;
  fx: number;
  fz: number;
  /** Ground level at the front (m), and the lowest the foundations must reach. */
  y: number;
  /** The footprint on the map (a convex quad), for keeping the street lots away. */
  quad: [number, number][];
}

/** Where a landmark stands and which way it faces. */
export function placeLandmark(rt: TrackRuntimeImpl, lm: LandmarkDef): LandmarkPlace | null {
  const k = lm.scale ?? 1;
  let x: number;
  let z: number;
  let fx: number;
  let fz: number;
  let y: number;
  if (lm.at) {
    const s = resolveMark(rt.plan.marks, rt.length, lm.at);
    const i = Math.round(s / rt.spacing) % rt.count;
    const d = lm.d ?? 0;
    x = rt.X[i] + rt.HLX[i] * d;
    z = rt.Z[i] + rt.HLZ[i] * d;
    // facing: across the road by default (the wall of a castle runs along it); `yaw` turns it (degrees)
    const a = ((lm.yaw ?? 90) * Math.PI) / 180;
    const tx = rt.HTX[i];
    const tz = rt.HTZ[i];
    fx = tx * Math.cos(a) + tz * Math.sin(a);
    fz = -tx * Math.sin(a) + tz * Math.cos(a);
    // a castle crowns the ground there (the hill over the tunnel); its walls are drawn from 11 m below the crest
    y = lm.kind === 'castle' ? Math.max(rt.Y[i], rt.fieldHeight(x, z) - 11) : rt.Y[i];
  } else {
    const e = lm.e ?? 0;
    const n = lm.n ?? 0;
    x = -e;
    z = n;
    // compass heading on the map (east = -x)
    const yc = ((lm.yaw ?? 0) * Math.PI) / 180;
    fx = -Math.sin(yc);
    fz = Math.cos(yc);
    y = rt.fieldHeight(x, z);
  }
  // footprint of the main mass (depth backwards from the front, width across)
  const [w, dpt, front] = lm.kind === 'cathedral' ? [30, 74, 6] : lm.kind === 'castle' ? [18, 112, 9] : [10, 10, 5];
  const tx = fz;
  const tz = -fx;
  const P = (a: number, b: number): [number, number] => [x + tx * a * k + fx * b * k, z + tz * a * k + fz * b * k];
  const quad: [number, number][] = [P(-w / 2, front), P(w / 2, front), P(w / 2, -dpt), P(-w / 2, -dpt)];
  if (lm.kind === 'castle') {
    // the castle runs along the lateral axis
    const long = [P(-dpt / 2, w / 2), P(dpt / 2, w / 2), P(dpt / 2, -w / 2), P(-dpt / 2, -w / 2)] as [number, number][];
    return { def: lm, x, z, fx, fz, y, quad: long };
  }
  return { def: lm, x, z, fx, fz, y, quad };
}

// ── small solids ──────────────────────────────────────────────────────────────────────────────

/** A style for the stone shader; `flood` is how strongly the floodlights wash it after dark (0..1). */
function style(col: number, seed: number, rows = 0, firstRow = 0, w = 10, flood = 0): Style {
  const c = [0, 0, 0];
  linear(col, c);
  return { col: [c[0], c[1], c[2]], seed, floors: rows, gH: firstRow, w, lit: flood };
}

/** A vertical cylinder (a round tower or a drum): its wall is one unbroken stone surface of circumference 2 pi r. */
function cylinder(buf: CityBuf, x: number, z: number, y0: number, y1: number, r: number, segs: number, st: Style, kind: number): void {
  const circ = Math.PI * 2 * r;
  const s2 = { ...st, w: circ };
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    buf.quad(
      [[x + Math.cos(a0) * r, y0, z + Math.sin(a0) * r], [x + Math.cos(a1) * r, y0, z + Math.sin(a1) * r], [x + Math.cos(a1) * r, y1, z + Math.sin(a1) * r], [x + Math.cos(a0) * r, y1, z + Math.sin(a0) * r]],
      [[a0 * r, 0], [a1 * r, 0], [a1 * r, y1 - y0], [a0 * r, y1 - y0]],
      [Math.cos(am), 0, Math.sin(am)],
      s2,
      kind,
    );
  }
}

/** A cone (a spire): from radius r at y0 to a point at y1. */
function cone(buf: CityBuf, x: number, z: number, y0: number, y1: number, r: number, segs: number, st: Style, kind: number): void {
  const slant = Math.hypot(r, y1 - y0);
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const ny = r / slant;
    const nr = (y1 - y0) / slant;
    buf.tri(
      [[x + Math.cos(a0) * r, y0, z + Math.sin(a0) * r], [x + Math.cos(a1) * r, y0, z + Math.sin(a1) * r], [x, y1, z]],
      [[a0 * r, 0], [a1 * r, 0], [(a0 + a1) * r * 0.5, slant]],
      [Math.cos(am) * nr, ny, Math.sin(am) * nr],
      st,
      kind,
    );
  }
}

/** A dome: a sphere cap of radius r resting at y0. */
function dome(buf: CityBuf, x: number, z: number, y0: number, r: number, rings: number, segs: number, st: Style): void {
  for (let j = 0; j < rings; j++) {
    const p0 = (j / rings) * (Math.PI / 2);
    const p1 = ((j + 1) / rings) * (Math.PI / 2);
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      const pt = (a: number, p: number): number[] => [x + Math.cos(a) * Math.sin(p) * r, y0 + Math.cos(p) * r, z + Math.sin(a) * Math.sin(p) * r];
      const am = (a0 + a1) / 2;
      const pm = (p0 + p1) / 2;
      const n = [Math.cos(am) * Math.sin(pm), Math.cos(pm), Math.sin(am) * Math.sin(pm)];
      if (j === rings - 1) buf.tri([pt(a0, p0), pt(a1, p0), pt(0, p1)], [[a0 * r, p0 * r], [a1 * r, p0 * r], [(a0 + a1) * r * 0.5, p1 * r]], n, st, FACADE_KIND.metal);
      else buf.quad([pt(a0, p0), pt(a1, p0), pt(a1, p1), pt(a0, p1)], [[a0 * r, p0 * r], [a1 * r, p0 * r], [a1 * r, p1 * r], [a0 * r, p1 * r]], n, st, FACADE_KIND.metal);
    }
  }
}

// ── the cathedral ─────────────────────────────────────────────────────────────────────────────────

function cathedral(buf: CityBuf, rt: TrackRuntimeImpl, pl: LandmarkPlace): void {
  const k = pl.def.scale ?? 1;
  const { x, z, fx, fz } = pl;
  const tx = fz;
  const tz = -fx;
  const P = (a: number, b: number): [number, number] => [x + (tx * a + fx * b) * k, z + (tz * a + fz * b) * k];
  // the ground: the lowest point under the footprint carries the foundations, the front sets the floor
  let low = Infinity;
  for (const [qx, qz] of pl.quad) low = Math.min(low, rt.fieldHeight(qx, qz));
  const yG = low - 2.5;
  const yF = Math.max(pl.y, low) + 0.9;
  const stone = style(0xe6d4ac, 0.31, 0, 0, 10, 0.9);
  const stone2 = style(0xdac8a0, 0.57, 0, 0, 10, 0.9);
  const dark = style(0x3a2f26, 0.77, 0, 0, 10);
  const rows = (r: number, first: number, seed: number): Style => style(0xe6d4ac, seed, r, first, 10, 0.9);
  const box = (a: number, b: number, y0: number, y1: number, hw: number, hd: number, st: Style, top = true): void => {
    const [px, pz] = P(a, b);
    buf.box(px, ((y0 + y1) / 2), pz, hw * k, ((y1 - y0) / 2), hd * k, tx, tz, st, FACADE_KIND.stone, top);
  };
  const H = (h: number): number => yF + h * k;
  // steps and the platform
  box(0, -30, yG, yF, 17, 40, stone2);
  // the facade between the towers, the nave, the transept
  box(0, -3.5, yG, H(24), 6.2, 3.5, rows(0, 0, 0.12));
  box(0, -36, yG, H(19), 12, 29, rows(1, 7, 0.44), false);
  // the front: a pointed portal over the steps, three tall lancets over it, buttresses at the corners and a cornice under the gable
  box(0, 0.35, yF, H(7.2), 2.3, 0.4, dark);
  {
    const [lx, lz] = P(-2.3, 0.78);
    const [rx, rz] = P(2.3, 0.78);
    const top = H(7.2);
    buf.tri([[lx, top, lz], [rx, top, rz], [(lx + rx) / 2, top + 2.8 * k, (lz + rz) / 2]], [[0, 0], [4.6 * k, 0], [2.3 * k, 2.8 * k]], [fx, 0, fz], dark, FACADE_KIND.stone);
  }
  box(0, 0.18, H(11.5), H(17.5), 5.9, 0.2, rows(1, 1.5, 0.35));
  for (const sa of [-1, 1]) box(sa * 6.0, 0.3, yF, H(24), 0.55, 0.35, stone2);
  box(0, 0.35, H(23.2), H(24.3), 6.7, 0.45, stone2);
  // the bell towers: dressed stone with a belfry of tall windows near the top
  for (const sx of [-1, 1]) {
    box(sx * 9.5, -3.5, yG, H(46), 3.6, 3.6, rows(2, 29, 0.21 + 0.08 * sx));
    // string courses under the belfry and under the spire
    box(sx * 9.5, -3.5, H(27.4), H(28.2), 3.9, 3.9, stone2);
    box(sx * 9.5, -3.5, H(45.2), H(46), 3.9, 3.9, stone2);
    const [px, pz] = P(sx * 9.5, -3.5);
    cone(buf, px, pz, H(46), H(60), 5.1 * k, 8, style(0xb85a35, 0.7), FACADE_KIND.tile);
  }
  // the facade's gable and the nave's roof
  {
    const [lx, lz] = P(-6.2, 0.02);
    const [rx, rz] = P(6.2, 0.02);
    const top = H(24);
    buf.tri([[lx, top, lz], [rx, top, rz], [(lx + rx) / 2, top + 5 * k, (lz + rz) / 2]], [[0, 0], [12.4 * k, 0], [6.2 * k, 5 * k]], [fx, 0, fz], stone, FACADE_KIND.stone);
    const c = P(-12, -7);
    const d = P(12, -7);
    const e = P(12, -65);
    const f = P(-12, -65);
    const q: Pt3[] = [{ x: c[0], y: H(19), z: c[1] }, { x: d[0], y: H(19), z: d[1] }, { x: e[0], y: H(19), z: e[1] }, { x: f[0], y: H(19), z: f[1] }];
    hipRoof(buf, q, H(19), 0.3, style(0xb85a35, 0.9));
  }
  // the crossing: a drum with windows and a dome of green copper under a lantern
  {
    const [px, pz] = P(0, -33);
    cylinder(buf, px, pz, H(19), H(27), 7.6 * k, 16, rows(1, 2.5, 0.63), FACADE_KIND.stone);
    dome(buf, px, pz, H(27), 7.9 * k, 5, 16, style(0x3f8f78, 0.4));
    cylinder(buf, px, pz, H(27) + 7.8 * k, H(31) + 7.8 * k, 1.5 * k, 8, stone, FACADE_KIND.stone);
    cone(buf, px, pz, H(31) + 7.8 * k, H(35) + 7.8 * k, 2 * k, 8, style(0x3f8f78, 0.4), FACADE_KIND.metal);
  }
}

// ── an arch across the street ────────────────────────────────────────────────────────────────────

/** How far an arch reaches to each side of the road, beyond the barrier (m): over the sidewalk and into the blocks. */
export const ARCH_REACH = 6.5;
/** Height of the top of an arch above the road (m): clear of the catch fences (5.4 m) and the lamp arms. */
const ARCH_TOP = 12.4;

/**
 * A stone arch across the street, a passage between two blocks: a level wall with a segmental opening over the road (springing above
 * the catch fences), a soffit, a ring of voussoirs along the curve and a cornice on top. Its ends stand on the sidewalks and sink into
 * the blocks behind them.
 */
export function emitArch(buf: CityBuf, rt: TrackRuntimeImpl, s: number, depth = 5.5, rise = 3.4): void {
  const sw = rt.wrapS(s);
  const k = Math.round(sw / rt.spacing) % rt.count;
  const tx = rt.HTX[k];
  const tz = rt.HTZ[k];
  const lx = rt.HLX[k];
  const lz = rt.HLZ[k];
  const p0 = rt.pointAt(sw, 0, new THREE.Vector3());
  const roadY = p0.y;
  const uA = -(rt.R.wall[k] + 0.7);
  const uB = rt.L.wall[k] + 0.7;
  const eR = rt.R.wall[k] + ARCH_REACH;
  const eL = rt.L.wall[k] + ARCH_REACH;
  const ySpring = roadY + 6.2;
  const yTop = roadY + ARCH_TOP;
  const yBot = roadY - 2.5;
  const half = depth / 2;
  const W = (u: number, y: number, t: number): number[] => [p0.x + lx * u + tx * t, y, p0.z + lz * u + tz * t];
  const stone = style(0xcdbf9a, 0.41, 0, 0, 10, 0.35);
  const ring = style(0xb9aa85, 0.63, 0, 0, 10, 0.35);
  const shade = style(0xa89a7c, 0.27, 0, 0, 10, 0.45);
  const kind = FACADE_KIND.stone;
  // the opening: a circular segment over the road
  const c = (uB - uA) / 2;
  const uc = (uA + uB) / 2;
  const R = (c * c + rise * rise) / (2 * rise);
  const J = 16;
  const us: number[] = [];
  const ys: number[] = [];
  for (let j = 0; j <= J; j++) {
    const u = uA + ((uB - uA) * j) / J;
    us.push(u);
    ys.push(ySpring + Math.sqrt(Math.max(0, R * R - (u - uc) * (u - uc))) - (R - rise));
  }
  for (const sg of [1, -1]) {
    const n = [tx * sg, 0, tz * sg];
    const face = (pts: [number, number][], t: number, st: Style): void => buf.quad(pts.map(([u, y]) => W(u, y, t)), pts.map(([u, y]) => [u - uA, y - yBot]), n, st, kind);
    // the abutments and the spandrels over the opening, then the voussoirs (standing a little proud of the wall)
    face([[uB, yBot], [eL, yBot], [eL, yTop], [uB, yTop]], sg * half, stone);
    face([[-eR, yBot], [uA, yBot], [uA, yTop], [-eR, yTop]], sg * half, stone);
    for (let j = 0; j < J; j++) {
      face([[us[j], ys[j]], [us[j + 1], ys[j + 1]], [us[j + 1], yTop], [us[j], yTop]], sg * half, stone);
      face([[us[j], ys[j]], [us[j + 1], ys[j + 1]], [us[j + 1], ys[j + 1] + 0.6], [us[j], ys[j] + 0.6]], sg * (half + 0.04), ring);
    }
  }
  // the soffit, and the inner faces of the piers
  for (let j = 0; j < J; j++) {
    const du = us[j + 1] - us[j];
    const dy = ys[j + 1] - ys[j];
    const len = Math.hypot(du, dy) || 1;
    let nu = dy / len;
    let ny = -du / len;
    if (ny > 0) {
      nu = -nu;
      ny = -ny;
    }
    buf.quad([W(us[j], ys[j], -half), W(us[j + 1], ys[j + 1], -half), W(us[j + 1], ys[j + 1], half), W(us[j], ys[j], half)], [[0, 0], [0, len], [depth, len], [depth, 0]], [lx * nu, ny, lz * nu], shade, kind);
  }
  for (const [u, sg] of [[uB, -1], [uA, 1]] as const) {
    buf.quad([W(u, yBot, -half), W(u, yBot, half), W(u, ySpring, half), W(u, ySpring, -half)], [[0, 0], [depth, 0], [depth, ySpring - yBot], [0, ySpring - yBot]], [lx * sg, 0, lz * sg], shade, kind);
  }
  // the cornice, which is also the roof: a slab a little deeper than the wall
  const uMid = (eL - eR) / 2;
  const m = W(uMid, yTop + 0.25, 0);
  buf.box(m[0], m[1], m[2], (eL + eR) / 2 + 0.2, 0.4, half + 0.3, lx, lz, stone, kind, true);
}

// ── the castle ────────────────────────────────────────────────────────────────────────────────────

function castle(buf: CityBuf, pl: LandmarkPlace): void {
  const k = pl.def.scale ?? 1;
  const { x, z, fx, fz } = pl;
  // the lateral axis (the wall runs along it) is across the facing vector
  const tx = fz;
  const tz = -fx;
  const P = (a: number, b: number): [number, number] => [x + (tx * a + fx * b) * k, z + (tz * a + fz * b) * k];
  // it stands on the hill over the tunnel (`pl.y` is 11 m below the crest): the walls reach 3.5 m down into the hill, so their feet stay
  // above the tube's crown (5.6 m over the road) instead of showing inside the tunnel
  const yG = pl.y + 7.5;
  const yF = pl.y + 10.5;
  const stone = style(0xcbbf9f, 0.15, 0, 0, 10, 0.8);
  const wallSt = style(0xc4b896, 0.35, 0, 0, 10, 0.8);
  const box = (a: number, b: number, y0: number, y1: number, hw: number, hd: number, st: Style, top = true): void => {
    const [px, pz] = P(a, b);
    buf.box(px, (y0 + y1) / 2, pz, hw * k, (y1 - y0) / 2, hd * k, tx, tz, st, FACADE_KIND.stone, top);
  };
  const H = (h: number): number => yF + h * k;
  // the curtain wall with its battlement walk
  const len = 52;
  box(0, 0, yG, H(7), len, 1.1, wallSt);
  // merlons along both parapets
  for (let a = -len + 1; a < len; a += 2.4) {
    for (const b of [-0.85, 0.85]) box(a, b, H(7), H(8.3), 0.62, 0.3, stone);
  }
  // square towers at the ends and the thirds, with their own battlements
  for (const a of [-len, -len / 3, len / 3, len]) {
    box(a, 0, yG, H(14), 4.6, 4.6, style(0xcbbf9f, 0.2 + a * 0.001, 1, 6.5, 10, 0.8));
    for (const [pa, pb] of [[-3.9, 0], [3.9, 0], [0, -3.9], [0, 3.9]]) {
      for (let q = -2; q <= 2; q += 2) {
        const aa = a + (pa !== 0 ? pa : q * 1.1);
        const bb = pb !== 0 ? pb : q * 1.1;
        box(aa, bb, H(14), H(15.4), pa !== 0 ? 0.35 : 0.55, pb !== 0 ? 0.35 : 0.55, stone);
      }
    }
  }
  // the keep, taller, with a tiled hip roof and corner turrets
  box(0, 0, yG, H(26), 8.5, 8.5, style(0xd1c5a4, 0.52, 3, 5, 10, 0.8));
  for (const sa of [-1, 1]) {
    for (const sb of [-1, 1]) box(sa * 7.6, sb * 7.6, H(26), H(31), 1.5, 1.5, stone);
  }
  {
    const c = P(-6.2, -6.2);
    const d = P(6.2, -6.2);
    const e = P(6.2, 6.2);
    const f = P(-6.2, 6.2);
    hipRoof(buf, [{ x: c[0], y: H(26), z: c[1] }, { x: d[0], y: H(26), z: d[1] }, { x: e[0], y: H(26), z: e[1] }, { x: f[0], y: H(26), z: f[1] }], H(26), 0.45, style(0xa84e2e, 0.8));
  }
}

/** Emit every landmark's geometry into one buffer. */
export function emitLandmark(buf: CityBuf, rt: TrackRuntimeImpl, pl: LandmarkPlace): void {
  if (pl.def.kind === 'cathedral') cathedral(buf, rt, pl);
  else if (pl.def.kind === 'castle') castle(buf, pl);
}
