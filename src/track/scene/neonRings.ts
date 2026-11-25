/**
 * The rings of a megacity circuit: a great ring of light standing across the road, that the cars drive through. A box-section frame
 * of dark steel carries three tubes: one on the face the cars come toward, one on the face they leave by and one inside, over the
 * road. The lower part of the circle is under the ground, so what stands is a tall arch that reads as a ring; its feet are outside
 * the barriers, on plinths.
 *
 * The ring at the start line stands a little past the start-light gantry and is wide enough to hold it: seen from the grid the
 * gantry and its lights are inside the ring, in front of it.
 */
import * as THREE from 'three';
import { resolveMark } from '../plan';
import type { TrackRuntimeImpl } from '../runtime';
import type { Mark, NeonDef } from '../types';
import type { Ctx } from './ctx';
import type { GeoBuf } from './geom';
import { type NeonKit, type RGB, fv, nquad, nv, rgb } from './neonKit';

/** The ring's inner radius is the half-distance between the walls plus this (m), and its centre this share of the radius above the road. */
const CLEAR = 3.6;
const RISE = 0.3;
/** The frame's section: radial thickness and depth along the road (m). */
const THICK = 0.85;
const DEPTH = 1.0;
const SEGS = 64;
/** A ring within this distance of the start-light gantry stands this far past it (m). */
const GANTRY_NEAR = 4;
const GANTRY_PAST = 1.3;
/** The default colour: the cold white of the palette. */
const RING_COLOR = 0xcfe4ff;

interface RingPlace {
  s: number;
  /** Centre of the circle. */
  cx: number;
  cy: number;
  cz: number;
  /** Left and forward (horizontal unit vectors). */
  lx: number;
  lz: number;
  tx: number;
  tz: number;
  /** Inner radius. */
  R: number;
  /** Where the frame's mid-line meets the ground: left, right (lateral offset from the centre, ground height). */
  feet: [{ x: number; y: number }, { x: number; y: number }];
  /** The road between the walls at the ring: offsets of the walls from the centre line (left +). */
  wl: number;
  wr: number;
}

const _p = new THREE.Vector3();

function placeRing(rt: TrackRuntimeImpl, at: Mark): RingPlace {
  let s = resolveMark(rt.plan.marks, rt.length, at);
  const gantry = rt.def.scenery?.gantry;
  if (gantry !== undefined) {
    const g = resolveMark(rt.plan.marks, rt.length, gantry);
    const d = rt.wrapS(s - g + rt.length / 2) - rt.length / 2;
    if (Math.abs(d) < GANTRY_NEAR) s = rt.wrapS(g + GANTRY_PAST);
  }
  const k = Math.round(s / rt.spacing) % rt.count;
  const wl = rt.L.wall[k];
  const wr = rt.R.wall[k];
  const R = (wl + wr) / 2 + CLEAR;
  rt.pointAt(s, (wl - wr) / 2, _p);
  const place: RingPlace = { s, cx: _p.x, cy: _p.y + RISE * R, cz: _p.z, lx: rt.HLX[k], lz: rt.HLZ[k], tx: rt.HTX[k], tz: rt.HTZ[k], R, feet: [{ x: 0, y: 0 }, { x: 0, y: 0 }], wl, wr };
  const rm = R + THICK / 2;
  for (const side of [0, 1]) {
    const sg = side === 0 ? 1 : -1;
    let gy = _p.y;
    let x = 0;
    for (let it = 0; it < 3; it++) {
      const dy = Math.min(rm * 0.9, Math.max(0, place.cy - gy));
      x = sg * Math.sqrt(rm * rm - dy * dy);
      gy = rt.heightXZ(place.cx + place.lx * x, place.cz + place.lz * x);
    }
    place.feet[side].x = x;
    place.feet[side].y = gy;
  }
  return place;
}

/** The ground the rings' feet stand on. */
export function reserveRings(ctx: Ctx, def: NeonDef): void {
  for (const ring of def.rings ?? []) {
    const p = placeRing(ctx.rt, ring.at);
    for (const f of p.feet) {
      const fx = p.cx + p.lx * f.x;
      const fz = p.cz + p.lz * f.x;
      ctx.reserved.push((x, z, m) => (x - fx) * (x - fx) + (z - fz) * (z - fz) < (2.8 + m) * (2.8 + m));
    }
  }
}

/**
 * One band of a ring: the section's segment (r0, z0) - (r1, z1) (radius, offset along the road) swept from angle a0 to a1, facing
 * (nr, nz) in the section. With a colour it is a tube's face, without one a face of the frame.
 */
function band(buf: GeoBuf, p: RingPlace, a0: number, a1: number, r0: number, z0: number, r1: number, z1: number, nr: number, nz: number, col: RGB | null): void {
  let prevA = -1;
  let prevB = -1;
  let pnx = 0;
  let pny = 0;
  let pnz = 0;
  for (let i = 0; i <= SEGS; i++) {
    const a = a0 + ((a1 - a0) * i) / SEGS;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const nx = p.lx * ca * nr + p.tx * nz;
    const ny = sa * nr;
    const nzz = p.lz * ca * nr + p.tz * nz;
    const x0 = p.cx + p.lx * ca * r0 + p.tx * z0;
    const y0 = p.cy + sa * r0;
    const zz0 = p.cz + p.lz * ca * r0 + p.tz * z0;
    const x1 = p.cx + p.lx * ca * r1 + p.tx * z1;
    const y1 = p.cy + sa * r1;
    const zz1 = p.cz + p.lz * ca * r1 + p.tz * z1;
    const A = col ? nv(buf, x0, y0, zz0, nx, ny, nzz, col) : fv(buf, x0, y0, zz0, nx, ny, nzz);
    const B = col ? nv(buf, x1, y1, zz1, nx, ny, nzz, col) : fv(buf, x1, y1, zz1, nx, ny, nzz);
    if (prevA >= 0) nquad(buf, prevA, A, B, prevB, pnx + nx, pny + ny, pnz + nzz);
    prevA = A;
    prevB = B;
    pnx = nx;
    pny = ny;
    pnz = nzz;
  }
}

/** An upright box: centre of its base (x, y, z), half sizes along left (hl) and forward (ht), height. */
function plinth(buf: GeoBuf, p: RingPlace, x: number, y: number, z: number, hl: number, ht: number, height: number): void {
  const faces: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const [fl, ft] of faces) {
    // the face at +-hl along left, or +-ht along forward
    const nx = p.lx * fl + p.tx * ft;
    const nz = p.lz * fl + p.tz * ft;
    const ux = fl !== 0 ? p.tx * ht : p.lx * hl;
    const uz = fl !== 0 ? p.tz * ht : p.lz * hl;
    const ox = x + (fl !== 0 ? p.lx * hl * fl : p.tx * ht * ft);
    const oz = z + (fl !== 0 ? p.lz * hl * fl : p.tz * ht * ft);
    const a = fv(buf, ox - ux, y, oz - uz, nx, 0, nz);
    const b = fv(buf, ox + ux, y, oz + uz, nx, 0, nz);
    const c = fv(buf, ox + ux, y + height, oz + uz, nx, 0, nz);
    const d = fv(buf, ox - ux, y + height, oz - uz, nx, 0, nz);
    nquad(buf, a, b, c, d, nx, 0, nz);
  }
  const top = y + height;
  const a = fv(buf, x - p.lx * hl - p.tx * ht, top, z - p.lz * hl - p.tz * ht, 0, 1, 0);
  const b = fv(buf, x + p.lx * hl - p.tx * ht, top, z + p.lz * hl - p.tz * ht, 0, 1, 0);
  const c = fv(buf, x + p.lx * hl + p.tx * ht, top, z + p.lz * hl + p.tz * ht, 0, 1, 0);
  const d = fv(buf, x - p.lx * hl + p.tx * ht, top, z - p.lz * hl + p.tz * ht, 0, 1, 0);
  nquad(buf, a, b, c, d, 0, 1, 0);
}

/** The light a ring throws on the road under it: offsets along the road (m) and the share of the light there. */
const UNDER = [-11, -6, -2.5, 0, 2.5, 6, 11];
const UNDER_SHARE = [0, 0.28, 0.8, 1, 0.8, 0.28, 0];
const UNDER_LEVEL = 0.5;
const LIFT = 0.03;

function underRing(kit: NeonKit, p: RingPlace, col: RGB): void {
  const rt = kit.rt;
  const buf = kit.glow(p.s);
  const cols = Math.max(4, Math.ceil((p.wl + p.wr) / 2.4));
  let prev: number[] = [];
  for (let r = 0; r < UNDER.length; r++) {
    const s = rt.wrapS(p.s + UNDER[r]);
    const k = kit.index(s);
    const wl = rt.L.wall[k] - 0.25;
    const wr = rt.R.wall[k] - 0.25;
    const row: number[] = [];
    for (let c = 0; c <= cols; c++) {
      const d = -wr + ((wl + wr) * c) / cols;
      rt.pointAt(s, d, _p);
      // a little less at the walls, where the strips' own light lies
      const edge = 0.75 + 0.25 * Math.sin((Math.PI * c) / cols);
      row.push(nv(buf, _p.x, _p.y + LIFT, _p.z, 0, 1, 0, col, UNDER_SHARE[r] * UNDER_LEVEL * edge));
    }
    if (prev.length) for (let c = 0; c < cols; c++) nquad(buf, prev[c], prev[c + 1], row[c + 1], row[c], 0, 1, 0);
    prev = row;
  }
}

export function buildRings(kit: NeonKit): void {
  const rt = kit.rt;
  for (const ring of kit.def.rings ?? []) {
    const p = placeRing(rt, ring.at);
    const col = rgb(ring.color ?? RING_COLOR);
    const inner = ring.inner === undefined ? col : rgb(ring.inner);
    const R = p.R;
    const ro = R + THICK;
    const rm = R + THICK / 2;
    // from 1.2 m under the ground at the left foot round to 1.2 m under it at the right one
    const under = (f: { y: number }): number => Math.asin(Math.min(0.95, Math.max(-0.2, (p.cy - f.y + 1.2) / rm)));
    const a0 = -under(p.feet[0]);
    const a1 = Math.PI + under(p.feet[1]);
    const hd = DEPTH / 2;
    const frame = kit.frame;
    band(frame, p, a0, a1, R, -hd, R, hd, -1, 0, null);
    band(frame, p, a0, a1, ro, -hd, ro, hd, 1, 0, null);
    band(frame, p, a0, a1, R, -hd, ro, -hd, 0, -1, null);
    band(frame, p, a0, a1, R, hd, ro, hd, 0, 1, null);
    const tube = kit.tube(p.s);
    // the tubes on the two faces (toward the cars that come, and after them) ...
    const t0 = R + 0.22;
    const t1 = R + 0.62;
    const out = 0.08;
    for (const f of [-1, 1]) {
      const z = f * hd;
      const zf = f * (hd + out);
      band(tube, p, a0, a1, t0, zf, t1, zf, 0, f, col);
      band(tube, p, a0, a1, t0, z, t0, zf, -1, 0, col);
      band(tube, p, a0, a1, t1, z, t1, zf, 1, 0, col);
    }
    // ... and the one inside, over the road
    const ri = R - out;
    band(tube, p, a0, a1, ri, -0.17, ri, 0.17, -1, 0, inner);
    band(tube, p, a0, a1, ri, -0.17, R, -0.17, 0, -1, inner);
    band(tube, p, a0, a1, ri, 0.17, R, 0.17, 0, 1, inner);
    for (const f of p.feet) plinth(frame, p, p.cx + p.lx * f.x, f.y - 0.4, p.cz + p.lz * f.x, 1.2, 0.95, 1.3);
    underRing(kit, p, col);
  }
}
