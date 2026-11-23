/**
 * A tunnel of a megacity circuit: hoops of light round the lining, one every few metres in the circuit's colours in turn (at speed
 * they flash past three or four a second), each with its glow on the lining and on the road, and an arch of light round each mouth.
 * The lines at the foot of the walls are the wall strips' own (neonStrips.ts).
 *
 * The section is the lining's (rocks.ts, buildTunnels: 18 segments from the foot of the left wall over the crown to the right one),
 * so a hoop lies on the lining it lights.
 */
import * as THREE from 'three';
import type { TrackRuntimeImpl } from '../runtime';
import type { GeoBuf } from './geom';
import { type NeonKit, type RGB, nquad, nv, rgb } from './neonKit';

/** The lining's section (rocks.ts). */
const NR = 18;
/** A hoop: a rib standing this far out of the lining (m), this wide along the road. */
const RIB = 0.26;
const RIB_W = 0.24;
/** The portal's rim (rocks.ts): how far it stands out of the wall. */
const RIM_OUT = 0.55;
const RIM_W = 0.8;
/** The cold white of the palette: the arch of light round a mouth. */
const PORTAL_COLOR = 0xcfe4ff;

interface Section {
  cx: number;
  cy: number;
  cz: number;
  lx: number;
  lz: number;
  tx: number;
  tz: number;
  /** Half-width between the walls. */
  a: number;
}

const _p = new THREE.Vector3();

function sectionAt(rt: TrackRuntimeImpl, s: number, out: Section): Section {
  const k = Math.round(rt.wrapS(s) / rt.spacing) % rt.count;
  const wl = rt.L.wall[k];
  const wr = rt.R.wall[k];
  rt.pointAt(s, (wl - wr) / 2, _p);
  out.cx = _p.x;
  out.cy = _p.y;
  out.cz = _p.z;
  out.lx = rt.HLX[k];
  out.lz = rt.HLZ[k];
  out.tx = rt.HTX[k];
  out.tz = rt.HTZ[k];
  out.a = (wl + wr) / 2;
  return out;
}

/** Point j of the section grown by `grow` (the portal's arches), as (lateral, height); the lining itself is grow 0 with its feet 0.2 m down. */
function arch(a: number, j: number, grow: number, out: [number, number]): void {
  const ang = (Math.PI * j) / NR;
  out[0] = Math.cos(ang) * (a + grow);
  out[1] = j === 0 || j === NR ? 0 : 2.1 + (3.5 + grow) * Math.sin(ang);
}

/** The lining's inward normal at point j, as (lateral, height). */
function inward(j: number, out: [number, number]): void {
  const ang = (Math.PI * j) / NR;
  const nx = -Math.cos(ang);
  const ny = j === 0 || j === NR ? 0 : -Math.sin(ang) * 0.9;
  const n = Math.hypot(nx, ny) || 1;
  out[0] = nx / n;
  out[1] = ny / n;
}

const _xy: [number, number] = [0, 0];
const _n: [number, number] = [0, 0];
const _sec: Section = { cx: 0, cy: 0, cz: 0, lx: 0, lz: 0, tx: 0, tz: 0, a: 0 };

function hoop(kit: NeonKit, s: number, col: RGB, lamps: number[]): void {
  const rt = kit.rt;
  const f = sectionAt(rt, s, _sec);
  // (the crown of the lining is 5.6 m over the road)
  lamps.push(f.cx, f.cy + 5.6 - RIB, f.cz);
  const tb = kit.tunnelTube;
  // the rib: the two faces across the road, and the one that looks at the axis
  const ring: number[][] = [[], [], [], []];
  for (let j = 0; j <= NR; j++) {
    arch(f.a, j, 0, _xy);
    inward(j, _n);
    const y = j === 0 || j === NR ? -0.2 : _xy[1];
    const qx = _xy[0] + _n[0] * RIB;
    const qy = y + _n[1] * RIB;
    for (const side of [0, 1]) {
      const z = (side === 0 ? -1 : 1) * (RIB_W / 2);
      const tn = side === 0 ? -1 : 1;
      // face across the road: lining point, inner point
      const A = nv(tb, f.cx + f.lx * _xy[0] + f.tx * z, f.cy + y, f.cz + f.lz * _xy[0] + f.tz * z, f.tx * tn, 0, f.tz * tn, col);
      const B = nv(tb, f.cx + f.lx * qx + f.tx * z, f.cy + qy, f.cz + f.lz * qx + f.tz * z, f.tx * tn, 0, f.tz * tn, col);
      // inner face
      const C = nv(tb, f.cx + f.lx * qx + f.tx * z, f.cy + qy, f.cz + f.lz * qx + f.tz * z, f.lx * _n[0], _n[1], f.lz * _n[0], col);
      ring[side * 2].push(A, B);
      ring[side * 2 + 1].push(C);
    }
  }
  for (let j = 0; j < NR; j++) {
    for (const side of [0, 1]) {
      const r = ring[side * 2];
      const tn = side === 0 ? -1 : 1;
      nquad(tb, r[j * 2], r[j * 2 + 2], r[j * 2 + 3], r[j * 2 + 1], f.tx * tn, 0, f.tz * tn);
    }
    inward(j, _n);
    nquad(tb, ring[1][j], ring[3][j], ring[3][j + 1], ring[1][j + 1], f.lx * _n[0], _n[1] - 1e-3, f.lz * _n[0]);
  }
  // its light on the lining, and on the road under it
  const gb = kit.tunnelGlow;
  let prevL: number[] = [];
  let prevF: number[] = [];
  const FCOLS = 8;
  for (let r = 0; r < ALONG.length; r++) {
    const g = sectionAt(rt, s + ALONG[r], _sec);
    const rowL: number[] = [];
    for (let j = 0; j <= NR; j++) {
      arch(g.a, j, 0, _xy);
      inward(j, _n);
      const y = (j === 0 || j === NR ? -0.2 : _xy[1]) + _n[1] * 0.04;
      const x = _xy[0] + _n[0] * 0.04;
      rowL.push(nv(gb, g.cx + g.lx * x, g.cy + y, g.cz + g.lz * x, 0, 1, 0, col, ALONG_SHARE[r] * LINING_LEVEL));
    }
    const rowF: number[] = [];
    for (let c = 0; c <= FCOLS; c++) {
      const d = -(g.a - 0.3) + ((g.a - 0.3) * 2 * c) / FCOLS;
      const k = Math.round(rt.wrapS(s + ALONG[r]) / rt.spacing) % rt.count;
      const mid = (rt.L.wall[k] - rt.R.wall[k]) / 2;
      rt.pointAt(s + ALONG[r], mid + d, _p);
      rowF.push(nv(gb, _p.x, _p.y + 0.03, _p.z, 0, 1, 0, col, ALONG_SHARE[r] * FLOOR_LEVEL));
    }
    if (prevL.length) {
      for (let j = 0; j < NR; j++) gb.quad(prevL[j], prevL[j + 1], rowL[j + 1], rowL[j]);
      // (the lining is seen from inside only, and the sheet is drawn from both sides)
      for (let c = 0; c < FCOLS; c++) nquad(gb, prevF[c], prevF[c + 1], rowF[c + 1], rowF[c], 0, 1, 0);
    }
    prevL = rowL;
    prevF = rowF;
  }
}

/** The glow of a hoop along the tunnel: offsets (m) and the share of the light there. */
const ALONG = [-7, -3, -0.9, 0, 0.9, 3, 7];
const ALONG_SHARE = [0, 0.14, 0.6, 1, 0.6, 0.14, 0];
const LINING_LEVEL = 1.5;
const FLOOR_LEVEL = 0.8;

/** The arch of light on the rim of a mouth: `face` is -1 at the entry (the wall looks back along the road), +1 at the exit. */
function portal(kit: NeonKit, s: number, face: 1 | -1, col: RGB): void {
  const rt = kit.rt;
  const f = sectionAt(rt, s, _sec);
  const fx = f.tx * face;
  const fz = f.tz * face;
  const tb = kit.tube(s);
  const g0 = 0.28;
  const g1 = 0.5;
  const z0 = RIM_OUT;
  const z1 = RIM_OUT + 0.08;
  const P = (buf: GeoBuf, x: number, y: number, z: number, nx: number, ny: number, nz: number, k = 1): number =>
    nv(buf, f.cx + f.lx * x + fx * z, f.cy + y, f.cz + f.lz * x + fz * z, f.lx * nx + fx * nz, ny, f.lz * nx + fz * nz, col, k);
  const rows: number[][] = [];
  for (let j = 0; j <= NR; j++) {
    const ang = (Math.PI * j) / NR;
    const rx = Math.cos(ang);
    const ry = Math.sin(ang);
    arch(f.a, j, g0, _xy);
    const ax = _xy[0];
    const ay = _xy[1];
    arch(f.a, j, g1, _xy);
    const bx = _xy[0];
    const by = _xy[1];
    rows.push([P(tb, ax, ay, z1, 0, 0, 1), P(tb, bx, by, z1, 0, 0, 1), P(tb, ax, ay, z0, -rx, -ry, 0), P(tb, ax, ay, z1, -rx, -ry, 0), P(tb, bx, by, z0, rx, ry, 0), P(tb, bx, by, z1, rx, ry, 0)]);
  }
  for (let j = 0; j < NR; j++) {
    const a = rows[j];
    const b = rows[j + 1];
    const ang = (Math.PI * (j + 0.5)) / NR;
    const rx = Math.cos(ang);
    const ry = Math.sin(ang);
    nquad(tb, a[0], b[0], b[1], a[1], fx, 0, fz);
    nquad(tb, a[2], b[2], b[3], a[3], -f.lx * rx, -ry, -f.lz * rx);
    nquad(tb, a[4], b[4], b[5], a[5], f.lx * rx, ry, f.lz * rx);
  }
  // its light on the wall round the mouth
  const gb = kit.glow(s);
  const GROW = [RIM_W + 0.02, 1.5, 2.9];
  const SHARE = [0.9, 0.4, 0];
  let prev: number[] = [];
  for (let r = 0; r < GROW.length; r++) {
    const row: number[] = [];
    for (let j = 0; j <= NR; j++) {
      arch(f.a, j, GROW[r], _xy);
      row.push(P(gb, _xy[0], _xy[1], 0.03, 0, 0, 1, SHARE[r]));
    }
    if (prev.length) for (let j = 0; j < NR; j++) nquad(gb, prev[j], prev[j + 1], row[j + 1], row[j], fx, 0, fz);
    prev = row;
  }
}

/**
 * Builds the hoops and the portals. Returns the crown of every hoop (x, y, z each): the hoops light the cars that pass under them as
 * the street lamps do outside (see addLampHeads in neon.ts).
 */
export function buildTunnelNeon(kit: NeonKit): number[] {
  const lamps: number[] = [];
  const hoops = kit.def.hoops;
  if (!hoops) return lamps;
  const rt = kit.rt;
  const every = Math.max(6, hoops.every ?? 24);
  const colors = (hoops.colors?.length ? hoops.colors : [PORTAL_COLOR]).map(rgb);
  const white = rgb(hoops.portal ?? PORTAL_COLOR);
  for (const [s0, s1] of rt.tunnelSpans) {
    let n = 0;
    for (let s = s0 + every / 2; s < s1 - 4; s += every, n++) hoop(kit, s, colors[n % colors.length], lamps);
    portal(kit, s0, -1, white);
    portal(kit, s1, 1, white);
  }
  return lamps;
}
