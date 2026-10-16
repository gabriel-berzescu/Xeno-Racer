/**
 * The built things of a winter circuit: red wooden cabins (the fishing village, the paddock), garages, tents, containers and a timing
 * tower, the poles that mark the lane across the ice, the reeds of the shore, and the spectators in their parkas. All procedural, merged
 * per material, standing on the ground the runtime gives.
 */
import * as THREE from 'three';
import { mulberry32 } from '../math';
import { resolveMark } from '../plan';
import type { WinterSceneryDef } from '../types';
import { SURF_CODE } from '../types';
import type { Ctx } from './ctx';

// ─────────────────────────────────────────────────────────────────────────────
// A vertex buffer with a colour per vertex, flat faces, oriented boxes
// ─────────────────────────────────────────────────────────────────────────────

export class WBuf {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  n = 0;
  v(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, c: readonly [number, number, number]): number {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(c[0], c[1], c[2]);
    return this.n++;
  }
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }
  get empty(): boolean {
    return this.idx.length === 0;
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

type Rgb = readonly [number, number, number];
const WHITE: Rgb = [1, 1, 1];
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _cr = new THREE.Vector3();
const _pp = new THREE.Vector3();

/** A flat quad: centre c, half sizes hu, hv along the unit vectors tu, tv, facing n (uv in metres divided by uvM, else 0..1). */
function face(b: WBuf, c: THREE.Vector3, tu: THREE.Vector3, tv: THREE.Vector3, hu: number, hv: number, n: THREE.Vector3, col: Rgb, uvM: number): void {
  const ids: number[] = [];
  for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    _pp.copy(c).addScaledVector(tu, su * hu).addScaledVector(tv, sv * hv);
    ids.push(b.v(_pp, n, uvM ? (su * hu + hu) / uvM : (su + 1) / 2, uvM ? (sv * hv + hv) / uvM : (sv + 1) / 2, col));
  }
  _e1.copy(tu).multiplyScalar(2 * hu);
  _e2.copy(tv).multiplyScalar(2 * hv);
  _cr.crossVectors(_e1, _e2);
  if (_cr.dot(n) >= 0) b.quad(ids[0], ids[1], ids[2], ids[3]);
  else b.quad(ids[0], ids[3], ids[2], ids[1]);
}

/**
 * An oriented box: centre c, half sizes (hx, hy, hz) along the unit axes (ax, ay, az), flat-shaded; no bottom unless asked.
 * With `uvM` the faces carry uv in metres / uvM, the vertical direction of a side face along v (boards run up and down).
 */
export function obox(b: WBuf, c: THREE.Vector3, hx: number, hy: number, hz: number, ax: THREE.Vector3, ay: THREE.Vector3, az: THREE.Vector3, col: Rgb = WHITE, uvM = 0, bottom = false): void {
  const n = new THREE.Vector3();
  const cc = new THREE.Vector3();
  const faces: [THREE.Vector3, THREE.Vector3, THREE.Vector3, number, number, number][] = [
    // axis (the normal), tangent u, tangent v, half extent along the axis, half u, half v
    [ax, az, ay, hx, hz, hy],
    [ay, ax, az, hy, hx, hz],
    [az, ax, ay, hz, hx, hy],
  ];
  for (let k = 0; k < 3; k++) {
    for (const sgn of [-1, 1]) {
      if (k === 1 && sgn < 0 && !bottom) continue;
      const [axis, tu, tv, hn, hu, hv] = faces[k];
      n.copy(axis).multiplyScalar(sgn);
      cc.copy(c).addScaledVector(axis, sgn * hn);
      face(b, cc.clone(), tu, tv, hu, hv, n.clone(), col, uvM);
    }
  }
}

/** A triangle with a flat normal. */
function tri(b: WBuf, p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, n: THREE.Vector3, col: Rgb): void {
  const a = b.v(p0, n, 0, 0, col);
  const bb = b.v(p1, n, 1, 0, col);
  const c = b.v(p2, n, 0.5, 1, col);
  _e1.subVectors(p1, p0);
  _e2.subVectors(p2, p0);
  _cr.crossVectors(_e1, _e2);
  if (_cr.dot(n) >= 0) b.idx.push(a, bb, c);
  else b.idx.push(a, c, bb);
}

// ─────────────────────────────────────────────────────────────────────────────
// Buffers per material
// ─────────────────────────────────────────────────────────────────────────────

export interface WinterBufs {
  wall: WBuf;
  trim: WBuf;
  snow: WBuf;
  glass: WBuf;
  dark: WBuf;
  stone: WBuf;
  fabric: WBuf;
  metal: WBuf;
}

export function newBufs(): WinterBufs {
  return { wall: new WBuf(), trim: new WBuf(), snow: new WBuf(), glass: new WBuf(), dark: new WBuf(), stone: new WBuf(), fabric: new WBuf(), metal: new WBuf() };
}

/** Wall colours: Falu red (the red of Swedish country houses) in a few weatherings, ochre, a dull grey-brown. */
const WALL_COLORS: Rgb[] = [
  [0.64, 0.17, 0.12],
  [0.58, 0.15, 0.11],
  [0.7, 0.2, 0.14],
  [0.52, 0.14, 0.1],
  [0.64, 0.17, 0.12],
  [0.74, 0.55, 0.2],
  [0.4, 0.3, 0.24],
];

/** A frame of axes at a place: ax along the road, az towards it (the front), ay up. */
export interface Frame {
  p: THREE.Vector3;
  ax: THREE.Vector3;
  ay: THREE.Vector3;
  az: THREE.Vector3;
}

const SNOW_COL: Rgb = [0.93, 0.95, 1];

/** A gabled cabin: planks, corner boards, a snow-laden roof, a chimney, a door and lit windows. Front faces +az. */
export function cabin(bufs: WinterBufs, f: Frame, w: number, d: number, h: number, rnd: () => number, wallCol?: Rgb): void {
  const { p, ax, ay, az } = f;
  const P = (x: number, y: number, z: number) => p.clone().addScaledVector(ax, x).addScaledVector(ay, y).addScaledVector(az, z);
  const col = wallCol ?? WALL_COLORS[(rnd() * WALL_COLORS.length) | 0];
  // a stone foundation, the walls
  obox(bufs.stone, P(0, 0.2, 0), w / 2 + 0.1, 0.4, d / 2 + 0.1, ax, ay, az, [0.52, 0.5, 0.48]);
  obox(bufs.wall, P(0, 0.4 + h / 2, 0), w / 2, h / 2, d / 2, ax, ay, az, col, 2.4);
  const top = 0.4 + h;
  const phi = (30 + rnd() * 8) * (Math.PI / 180);
  const tn = Math.tan(phi);
  const rise = (d / 2) * tn;
  // the gable ends
  for (const sx of [-1, 1]) {
    const n = ax.clone().multiplyScalar(sx);
    tri(bufs.wall, P(sx * w / 2, top, -d / 2), P(sx * w / 2, top, d / 2), P(sx * w / 2, top + rise, 0), n, col);
  }
  // corner boards, the door, the windows
  const trim = bufs.trim;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) obox(trim, P(sx * (w / 2 - 0.05), 0.4 + h / 2, sz * (d / 2 - 0.05)), 0.075, h / 2, 0.075, ax, ay, az);
  obox(trim, P(0, top - 0.04, d / 2 + 0.01), w / 2 + 0.02, 0.07, 0.05, ax, ay, az);
  const dx = (rnd() < 0.5 ? -1 : 1) * (w / 2 - 1.3);
  obox(bufs.dark, P(dx, 0.4 + 1.0, d / 2 + 0.02), 0.45, 1.0, 0.03, ax, ay, az, [0.2, 0.13, 0.09]);
  obox(trim, P(dx, 0.4 + 2.04, d / 2 + 0.03), 0.58, 0.06, 0.04, ax, ay, az);
  for (const sx of [-1, 1]) obox(trim, P(dx + sx * 0.54, 0.4 + 1.0, d / 2 + 0.03), 0.06, 1.0, 0.04, ax, ay, az);
  // a step and a little snow on it
  obox(bufs.stone, P(dx, 0.3, d / 2 + 0.5), 0.8, 0.12, 0.45, ax, ay, az, [0.5, 0.48, 0.46]);
  obox(bufs.snow, P(dx, 0.44, d / 2 + 0.5), 0.74, 0.05, 0.4, ax, ay, az, SNOW_COL);
  const nWin = w > 6 ? 3 : 2;
  for (let k = 0; k < nWin; k++) {
    const wx = -w / 2 + (w * (k + 0.5)) / nWin;
    if (Math.abs(wx - dx) < 1.1) continue;
    const wy = 0.4 + h * 0.58;
    obox(trim, P(wx, wy, d / 2 + 0.02), 0.56, 0.62, 0.025, ax, ay, az);
    obox(bufs.glass, P(wx, wy, d / 2 + 0.045), 0.46, 0.52, 0.01, ax, ay, az, [1, 0.8, 0.5]);
    obox(trim, P(wx, wy, d / 2 + 0.055), 0.03, 0.52, 0.012, ax, ay, az);
    obox(trim, P(wx, wy, d / 2 + 0.055), 0.46, 0.03, 0.012, ax, ay, az);
    // a window box of snow
    obox(bufs.snow, P(wx, wy - 0.66, d / 2 + 0.07), 0.5, 0.04, 0.07, ax, ay, az, SNOW_COL);
  }
  // a window in each gable end
  for (const sx of [-1, 1]) obox(bufs.glass, P(sx * (w / 2 + 0.02), 0.4 + h * 0.58, 0), 0.01, 0.4, 0.4, ax, ay, az, [1, 0.8, 0.5]);
  // the roof: dark boards under a thick layer of snow
  const ov = 0.42;
  for (const sz of [-1, 1]) {
    const dir = az.clone().multiplyScalar(sz * Math.cos(phi)).addScaledVector(ay, -Math.sin(phi)); // down the slope, toward the eave
    const up = ay.clone().multiplyScalar(Math.cos(phi)).addScaledVector(az, sz * Math.sin(phi));
    const ridge = P(0, top + rise, 0);
    const eave = P(0, top - ov * tn, sz * (d / 2 + ov));
    const mid = ridge.clone().add(eave).multiplyScalar(0.5);
    const half = ridge.distanceTo(eave) / 2;
    obox(bufs.dark, mid.clone().addScaledVector(up, 0.03), w / 2 + ov * 0.7, 0.03, half, ax, up, dir, [0.2, 0.17, 0.15], 0, true);
    const sn = 0.14 + 0.1 * rnd();
    obox(bufs.snow, mid.clone().addScaledVector(up, 0.06 + sn / 2), w / 2 + ov * 0.9, sn / 2, half + 0.06, ax, up, dir, SNOW_COL);
  }
  // the ridge capped with a heap of snow, a chimney with its own cap
  obox(bufs.snow, P(0, top + rise + 0.2, 0), w / 2 + 0.3, 0.12, 0.28, ax, ay, az, SNOW_COL);
  const cx = (rnd() < 0.5 ? -1 : 1) * w * 0.25;
  obox(bufs.stone, P(cx, top + rise + 0.2, -d * 0.12), 0.26, 0.7, 0.26, ax, ay, az, [0.45, 0.2, 0.16]);
  obox(bufs.snow, P(cx, top + rise + 0.93, -d * 0.12), 0.32, 0.07, 0.32, ax, ay, az, SNOW_COL);
}

/** A pavilion tent: white fabric walls, a four-sided roof, a coloured valance, white posts. */
export function tent(bufs: WinterBufs, f: Frame, w: number, d: number, rnd: () => number): void {
  const { p, ax, ay, az } = f;
  const P = (x: number, y: number, z: number) => p.clone().addScaledVector(ax, x).addScaledVector(ay, y).addScaledVector(az, z);
  const hw = 2.3 + rnd() * 0.5;
  const peak = hw + 1.5;
  const fabric = bufs.fabric;
  const white: Rgb = [0.93, 0.94, 0.96];
  const valance: Rgb = rnd() < 0.5 ? [0.09, 0.8, 0.68] : [0.9, 0.18, 0.39];
  const corners: [number, number][] = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
  for (let i = 0; i < 4; i++) {
    const [x0, z0] = corners[i];
    const [x1, z1] = corners[(i + 1) % 4];
    const mx = (x0 + x1) / 2;
    const mz = (z0 + z1) / 2;
    const n = ax.clone().multiplyScalar(mx).addScaledVector(az, mz).normalize();
    // a wall, the roof over it, the valance between
    const wallC = P(mx, hw / 2, mz);
    const tu = ax.clone().multiplyScalar(x1 - x0).addScaledVector(az, z1 - z0).normalize();
    face(fabric, wallC, tu, ay, Math.hypot(x1 - x0, z1 - z0) / 2, hw / 2, n, white, 0);
    tri(fabric, P(x0, hw, z0), P(x1, hw, z1), P(0, peak, 0), n.clone().multiplyScalar(0.5).addScaledVector(ay, 0.85).normalize(), white);
    face(fabric, P(mx, hw - 0.15, mz).addScaledVector(n, 0.01), tu, ay, Math.hypot(x1 - x0, z1 - z0) / 2, 0.15, n, valance, 0);
    // a heap of snow on the slope
    tri(bufs.snow, P(x0 * 0.82, hw + 0.06, z0 * 0.82), P(x1 * 0.82, hw + 0.06, z1 * 0.82), P(0, peak + 0.12, 0), n.clone().multiplyScalar(0.5).addScaledVector(ay, 0.85).normalize(), SNOW_COL);
  }
  for (const [x, z] of corners) obox(bufs.metal, P(x, hw / 2, z), 0.05, hw / 2, 0.05, ax, ay, az, [0.85, 0.86, 0.88]);
}

/** A shipping container (the colour given), a little snow on its roof. */
export function container(bufs: WinterBufs, f: Frame, color: Rgb, len = 6.06): void {
  const { p, ax, ay, az } = f;
  const P = (x: number, y: number, z: number) => p.clone().addScaledVector(ax, x).addScaledVector(ay, y).addScaledVector(az, z);
  obox(bufs.wall, P(0, 1.3 + 0.1, 0), len / 2, 1.3, 1.22, ax, ay, az, color, 2.4);
  obox(bufs.snow, P(0, 2.72, 0), len / 2 - 0.05, 0.05, 1.15, ax, ay, az, SNOW_COL);
  // the doors at one end
  obox(bufs.dark, P(len / 2 + 0.02, 1.3, 0), 0.02, 1.2, 1.1, ax, ay, az, [color[0] * 0.5, color[1] * 0.5, color[2] * 0.5]);
}

/** A two-storey timing tower: a red cabin with a long window band, a roof deck and a flagpole. */
export function tower(bufs: WinterBufs, f: Frame, rnd: () => number): void {
  const { p, ax, ay, az } = f;
  const P = (x: number, y: number, z: number) => p.clone().addScaledVector(ax, x).addScaledVector(ay, y).addScaledVector(az, z);
  cabin(bufs, f, 9, 5.5, 2.7, rnd, [0.6, 0.16, 0.12]);
  // an upper storey of glass, set on the roof ridge, and a deck
  obox(bufs.wall, P(0, 5.6, 0), 3.0, 0.9, 2.2, ax, ay, az, [0.55, 0.14, 0.11], 2.4, true);
  obox(bufs.glass, P(0, 5.7, 2.23), 2.7, 0.5, 0.03, ax, ay, az, [1, 0.82, 0.55]);
  obox(bufs.snow, P(0, 6.55, 0), 3.2, 0.1, 2.4, ax, ay, az, SNOW_COL);
  obox(bufs.metal, P(2.8, 8.2, -1.8), 0.04, 1.8, 0.04, ax, ay, az, [0.8, 0.8, 0.82]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Materials
// ─────────────────────────────────────────────────────────────────────────────

function plankTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(99);
  g.fillStyle = '#e9e9e9';
  g.fillRect(0, 0, 128, 128);
  // vertical boards, 8 cm wide at 1 m = 128 px / 2.4: dark joints, a grain, a little weathering
  const bw = 128 / 12;
  for (let i = 0; i < 12; i++) {
    const v = 218 + Math.floor(rnd() * 30);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(i * bw, 0, bw, 128);
    g.fillStyle = 'rgba(0,0,0,0.38)';
    g.fillRect(i * bw, 0, 1.6, 128);
    for (let k = 0; k < 14; k++) {
      g.fillStyle = `rgba(0,0,0,${0.03 + rnd() * 0.06})`;
      g.fillRect(i * bw + 2 + rnd() * (bw - 4), rnd() * 128, 0.8 + rnd() * 1.2, 8 + rnd() * 40);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export interface WinterMats {
  wall: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  snow: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  stone: THREE.MeshStandardMaterial;
  fabric: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
}

export function makeWinterMats(ctx: Ctx): WinterMats {
  const plank = plankTexture();
  ctx.disposables.push(plank);
  const wall = new THREE.MeshStandardMaterial({ map: plank, vertexColors: true, roughness: 0.82, metalness: 0 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xe9e6de, roughness: 0.7 });
  const snow = new THREE.MeshStandardMaterial({ color: 0xe8eef8, roughness: 0.95, vertexColors: true });
  const glass = new THREE.MeshStandardMaterial({ color: 0x202a33, roughness: 0.15, metalness: 0.2, emissive: 0xffb860, emissiveIntensity: 0.2, vertexColors: true });
  const dark = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, vertexColors: true });
  const stone = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, vertexColors: true });
  const fabric = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, vertexColors: true, side: THREE.DoubleSide });
  const metal = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.7, vertexColors: true });
  // (the trim has no vertex colours of its own: the buffers give it white)
  trim.vertexColors = true;
  const mats = { wall, trim, snow, glass, dark, stone, fabric, metal };
  for (const m of Object.values(mats)) {
    m.userData.noWet = true;
    ctx.disposables.push(m);
  }
  // the windows are warm and lit when it is dark, and a little even by day (a lamp inside)
  ctx.nightGlow.push({ mat: glass, day: 0.2, night: 2.6 });
  return mats;
}

// ─────────────────────────────────────────────────────────────────────────────
// Placement
// ─────────────────────────────────────────────────────────────────────────────

/** A frame beside the road: `back` metres behind the barrier of side `sgn` at sample k, the front towards the road, a little yaw. */
function frameBeside(ctx: Ctx, sgn: 1 | -1, k: number, back: number, yaw: number): Frame {
  const rt = ctx.rt;
  const S = sgn > 0 ? rt.L : rt.R;
  const kk = ((k % rt.count) + rt.count) % rt.count;
  const d = sgn * (S.wall[kk] + back);
  const p = new THREE.Vector3();
  rt.pointAt(kk * rt.spacing, d, p);
  // the ground under a building: the highest of its corners (it sits on a foundation), but not above what the road is
  p.y = Math.max(rt.heightSD(kk * rt.spacing, d), rt.fieldHeight(p.x, p.z)) - 0.15;
  const tx = rt.HTX[kk];
  const tz = rt.HTZ[kk];
  const ox = sgn * rt.HLX[kk];
  const oz = sgn * rt.HLZ[kk];
  const ay = new THREE.Vector3(0, 1, 0);
  const ax = new THREE.Vector3(tx, 0, tz).applyAxisAngle(ay, yaw);
  const az = new THREE.Vector3(-ox, 0, -oz).applyAxisAngle(ay, yaw);
  return { p, ax, ay, az };
}

interface Footprint {
  x: number;
  z: number;
  r: number;
}

/** Everything a scene builder needs to keep clear of: the cabins, tents and containers. */
function reserve(ctx: Ctx, list: Footprint[]): void {
  if (!list.length) return;
  ctx.reserved.push((x, z, m) => {
    for (const f of list) {
      const dx = x - f.x;
      const dz = z - f.z;
      const r = f.r + m;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  });
}

/** Cabins, the paddock and the crowds of a winter circuit's scenery definition. Returns the group. */
export function buildBuildings(ctx: Ctx, def: WinterSceneryDef): THREE.Group {
  const rt = ctx.rt;
  const group = new THREE.Group();
  group.name = 'winterBuildings';
  const bufs = newBufs();
  const feet: Footprint[] = [];
  const keepOut = (x: number, z: number, r: number) => ctx.camSpots?.some(([cx, cz]) => (cx - x) * (cx - x) + (cz - z) * (cz - z) < (r + 14) * (r + 14)) ?? false;
  const markI = (m: import('../types').Mark) => Math.round(resolveMark(rt.plan.marks, rt.length, m) / rt.spacing);

  for (const c of def.cabins ?? []) {
    const rnd = mulberry32((c.seed ?? 7) * 7919 + markI(c.at));
    const sgn: 1 | -1 = c.side === 'L' ? 1 : -1;
    const rows = c.rows ?? 2;
    const i0 = markI(c.at);
    for (let k = 0; k < c.count; k++) {
      const row = k % rows;
      const along = ((k / c.count) * 2 - 1) * c.along + (rnd() - 0.5) * 6;
      const w = 4.4 + rnd() * 3.2;
      const d = 3.6 + rnd() * 1.8;
      const back = 5.4 + c.gap + row * (8 + rnd() * 5) + rnd() * 4 + d / 2;
      const f = frameBeside(ctx, sgn, i0 + Math.round(along), back, (rnd() - 0.5) * 0.5);
      if (keepOut(f.p.x, f.p.z, 8)) continue;
      cabin(bufs, f, w, d, 2.3 + rnd() * 0.5, rnd);
      feet.push({ x: f.p.x, z: f.p.z, r: Math.hypot(w, d) / 2 + 2 });
      // a woodshed or an outhouse beside some
      if (rnd() < 0.4) {
        const g2 = { p: f.p.clone().addScaledVector(f.ax, (rnd() < 0.5 ? -1 : 1) * (w / 2 + 2.4)).addScaledVector(f.az, -1), ax: f.ax, ay: f.ay, az: f.az };
        cabin(bufs, g2, 2.2 + rnd(), 2.0 + rnd() * 0.6, 2.0, rnd);
        feet.push({ x: g2.p.x, z: g2.p.z, r: 3 });
      }
    }
  }

  const pd = def.paddock;
  if (pd) {
    const rnd = mulberry32(4242);
    const sgn: 1 | -1 = pd.side === 'L' ? 1 : -1;
    let i0 = markI(pd.from);
    let i1 = markI(pd.to);
    if (i1 <= i0) i1 += rt.count;
    let i = i0 + 14;
    let n = 0;
    while (i < i1 - 10) {
      const kind = n % 6;
      const back = 5.4 + pd.gap;
      const f = frameBeside(ctx, sgn, i, back, 0);
      if (kind === 0 && n === 0) {
        // the timing tower at the start line end
        const t = frameBeside(ctx, sgn, i, back + 2, 0);
        tower(bufs, t, rnd);
        feet.push({ x: t.p.x, z: t.p.z, r: 8 });
        i += 18;
      } else if (kind === 1 || kind === 4) {
        const w = 10 + rnd() * 2;
        cabin(bufs, frameBeside(ctx, sgn, i + Math.round(w / 2), back + 1, 0), w, 6, 3.3, rnd, [0.6, 0.16, 0.12]);
        feet.push({ x: f.p.x, z: f.p.z, r: w / 2 + 3 });
        i += Math.round(w) + 3;
      } else if (kind === 2 || kind === 5) {
        const w = 7 + rnd() * 2;
        tent(bufs, frameBeside(ctx, sgn, i + Math.round(w / 2), back + 1, 0), w, 6.5, rnd);
        feet.push({ x: f.p.x, z: f.p.z, r: w / 2 + 3 });
        i += Math.round(w) + 3;
      } else {
        const cols: Rgb[] = [[0.1, 0.55, 0.5], [0.75, 0.28, 0.14], [0.2, 0.3, 0.5], [0.55, 0.57, 0.6]];
        container(bufs, frameBeside(ctx, sgn, i + 3, back + 1, 0), cols[(rnd() * cols.length) | 0]);
        feet.push({ x: f.p.x, z: f.p.z, r: 5 });
        i += 9;
      }
      n++;
    }
  }
  reserve(ctx, feet);

  const mats = makeWinterMats(ctx);
  for (const key of Object.keys(bufs) as (keyof WinterBufs)[]) {
    const b = bufs[key];
    if (b.empty) continue;
    const mesh = new THREE.Mesh(b.build(), mats[key]);
    mesh.castShadow = key !== 'glass';
    mesh.receiveShadow = true;
    mesh.name = `winter_${key}`;
    group.add(mesh);
    ctx.disposables.push(mesh.geometry);
  }
  void SURF_CODE;
  return group;
}
