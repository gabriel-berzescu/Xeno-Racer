/**
 * Trackside infrastructure: grandstands with crowds, the pit building + pit lane, the start-light gantry,
 * marshal posts, lamp posts, advertising and braking boards, waving flags. Everything is procedural.
 */
import * as THREE from 'three';
import type { EnvironmentState } from '../../core/contracts';
import { resolveMark } from '../plan';
import type { StandDef } from '../types';
import { type BarrierMaterials, type Row, type MatKey, addBox, extrude, getBuf, rowAtD } from './barriers';
import type { Ctx } from './ctx';
import { GeoBuf } from './geom';
import { type TrackMaterials, makeRoadMaterial } from './materials';
import { makeBoardTexture, makeChevronTexture, makeCrowdTexture, makeFacadeTexture, makeFlagTexture, makeSeatTexture, makeSignTexture, makeTowerTextures, makeWarnTexture } from './propTextures';

export interface PropResult {
  group: THREE.Group;
  setStartLights(state: number | null): void;
  tvCameras: { position: THREE.Vector3; s: number }[];
}

interface PropMats {
  seat: THREE.MeshStandardMaterial;
  crowd: THREE.MeshStandardMaterial;
  roof: THREE.MeshStandardMaterial;
  teal: THREE.MeshStandardMaterial;
  facade: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  tower: THREE.MeshStandardMaterial;
  plain: THREE.MeshStandardMaterial;
  white: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  orange: THREE.MeshStandardMaterial;
  sign: THREE.MeshStandardMaterial;
  chevL: THREE.MeshStandardMaterial;
  chevR: THREE.MeshStandardMaterial;
  warn: THREE.MeshStandardMaterial;
  mirror: THREE.MeshStandardMaterial;
}

function makePropMats(ctx: Ctx): PropMats {
  const seatTex = makeSeatTexture();
  const crowd = makeCrowdTexture(0);
  const facadeTex = makeFacadeTexture();
  const sign = makeSignTexture(ctx.rt.info.name, ctx.rt.info.location);
  ctx.disposables.push(seatTex, crowd, facadeTex, sign);
  const seat = new THREE.MeshStandardMaterial({ map: seatTex, roughness: 0.75, metalness: 0.05 });
  const crowdMat = new THREE.MeshStandardMaterial({ map: crowd, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.95, metalness: 0, vertexColors: true });
  const roof = new THREE.MeshStandardMaterial({ color: 0xe6e8ea, roughness: 0.5, metalness: 0.25, side: THREE.DoubleSide });
  const teal = new THREE.MeshStandardMaterial({ color: 0x16e0bd, roughness: 0.45, metalness: 0.2, emissive: 0x16e0bd, emissiveIntensity: 0 });
  const facade = new THREE.MeshStandardMaterial({ map: facadeTex, roughness: 0.55, metalness: 0.1 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x35566f, roughness: 0.12, metalness: 0.55, envMapIntensity: 1.3, emissive: 0xffd9a0, emissiveIntensity: 0 });
  const tt = makeTowerTextures();
  ctx.disposables.push(tt.map, tt.emissive);
  const tower = new THREE.MeshStandardMaterial({ map: tt.map, roughness: 0.18, metalness: 0.45, envMapIntensity: 1.25, emissive: 0xffe2b8, emissiveMap: tt.emissive, emissiveIntensity: 0 });
  const plain = new THREE.MeshStandardMaterial({ color: 0xc4c6c6, roughness: 0.75, metalness: 0.1 });
  const white = new THREE.MeshStandardMaterial({ color: 0xeceeee, roughness: 0.6, metalness: 0.05 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.6, metalness: 0.4 });
  const orange = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.6, metalness: 0.05 });
  const signMat = new THREE.MeshStandardMaterial({ map: sign, roughness: 0.5, emissive: 0xffffff, emissiveMap: sign, emissiveIntensity: 0 });
  // road signs (only built when the track defines them)
  const road = ctx.rt.def.scenery?.roadSigns;
  const sheet = (tex: THREE.Texture, alphaTest = 0): THREE.MeshStandardMaterial => {
    ctx.disposables.push(tex);
    const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45, metalness: 0.1, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.04, alphaTest, side: alphaTest ? THREE.DoubleSide : THREE.FrontSide });
    ctx.disposables.push(m);
    ctx.nightGlow.push({ mat: m, day: 0.04, night: 0.3 });
    return m;
  };
  const chevL = sheet(road?.chevrons ? makeChevronTexture(1) : new THREE.Texture());
  const chevR = sheet(road?.chevrons ? makeChevronTexture(-1) : new THREE.Texture());
  const warn = sheet(road?.warn ? makeWarnTexture() : new THREE.Texture(), 0.5);
  const mirror = new THREE.MeshStandardMaterial({ color: 0xe8eef2, metalness: 1, roughness: 0.06, envMapIntensity: 1.6 });
  ctx.disposables.push(mirror);
  ctx.nightGlow.push({ mat: teal, day: 0, night: 1.4 }, { mat: glass, day: 0, night: 0.9 }, { mat: tower, day: 0, night: 1.1 }, { mat: signMat, day: 0.0, night: 0.9 });
  return { seat, crowd: crowdMat, roof, teal, facade, glass, tower, plain, white, dark, orange, sign: signMat, chevL, chevR, warn, mirror };
}

// ── generic helpers ───────────────────────────────────────────────────────────────

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Oriented box with local axes (ax, ay, az), half extents h, flat-shaded; optional uv scale per face (metres per repeat). */
function obox(buf: GeoBuf, c: THREE.Vector3, hx: number, hy: number, hz: number, ax: THREE.Vector3, ay: THREE.Vector3, az: THREE.Vector3, uvM = 0, color = 1): void {
  const faces: { n: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3; w: number; h: number; d: number }[] = [
    { n: ax.clone(), u: az.clone().negate(), v: ay.clone(), w: hz, h: hy, d: hx },
    { n: ax.clone().negate(), u: az.clone(), v: ay.clone(), w: hz, h: hy, d: hx },
    { n: ay.clone(), u: ax.clone(), v: az.clone(), w: hx, h: hz, d: hy },
    { n: ay.clone().negate(), u: ax.clone(), v: az.clone().negate(), w: hx, h: hz, d: hy },
    { n: az.clone(), u: ax.clone(), v: ay.clone(), w: hx, h: hy, d: hz },
    { n: az.clone().negate(), u: ax.clone().negate(), v: ay.clone(), w: hx, h: hy, d: hz },
  ];
  for (const f of faces) {
    const cc = c.clone().addScaledVector(f.n, f.d);
    const ids: number[] = [];
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = cc.clone().addScaledVector(f.u, su * f.w).addScaledVector(f.v, sv * f.h);
      const id = buf.v(p.x, p.y, p.z, f.n.x, f.n.y, f.n.z, uvM ? (su * f.w + f.w) / uvM : 0, uvM ? (sv * f.h + f.h) / uvM : 0);
      void color;
      ids.push(id);
    }
    const P = buf.pos;
    _a.set(P[ids[0] * 3], P[ids[0] * 3 + 1], P[ids[0] * 3 + 2]);
    _b.set(P[ids[1] * 3], P[ids[1] * 3 + 1], P[ids[1] * 3 + 2]);
    _c.set(P[ids[2] * 3], P[ids[2] * 3 + 1], P[ids[2] * 3 + 2]);
    _n.crossVectors(_b.sub(_a), _c.sub(_a));
    if (_n.dot(f.n) >= 0) buf.quad(ids[0], ids[1], ids[2], ids[3]);
    else buf.quad(ids[0], ids[3], ids[2], ids[1]);
  }
}

/** Flat textured quad (uv 0..1) facing `normal`, with `right` as the direction text reads left-to-right. */
function panel(buf: GeoBuf, c: THREE.Vector3, halfW: number, halfH: number, right: THREE.Vector3, up: THREE.Vector3, normal: THREE.Vector3): void {
  const ids: number[] = [];
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const p = c.clone().addScaledVector(right, sx * halfW).addScaledVector(up, sy * halfH);
    ids.push(buf.v(p.x, p.y, p.z, normal.x, normal.y, normal.z, (sx + 1) / 2, (sy + 1) / 2));
  }
  const P = buf.pos;
  _a.set(P[ids[0] * 3], P[ids[0] * 3 + 1], P[ids[0] * 3 + 2]);
  _b.set(P[ids[1] * 3], P[ids[1] * 3 + 1], P[ids[1] * 3 + 2]);
  _c.set(P[ids[2] * 3], P[ids[2] * 3 + 1], P[ids[2] * 3 + 2]);
  _n.crossVectors(_b.sub(_a), _c.sub(_a));
  if (_n.dot(normal) >= 0) buf.quad(ids[0], ids[1], ids[2], ids[3]);
  else buf.quad(ids[0], ids[3], ids[2], ids[1]);
}

function rowsAlong(ctx: Ctx, sgn: 1 | -1, i0: number, i1: number, dOutFn: (i: number) => number, step = 2): Row[] {
  const rt = ctx.rt;
  const rows: Row[] = [];
  for (let i = i0; i <= i1; i += step) rows.push(rowAtD(rt, sgn, i, dOutFn(((i % rt.count) + rt.count) % rt.count)));
  const last = rows[rows.length - 1];
  if (last.s < i1 * rt.spacing - 1e-6) rows.push(rowAtD(rt, sgn, i1, dOutFn(((i1 % rt.count) + rt.count) % rt.count)));
  return rows;
}

function markToIndex(ctx: Ctx, m: import('../types').Mark): number {
  const rt = ctx.rt;
  return Math.round(resolveMark(rt.plan.marks, rt.length, m) / rt.spacing);
}

type Bufs = Map<string, GeoBuf>;
function buf(bufs: Bufs, key: string): GeoBuf {
  let b = bufs.get(key);
  if (!b) {
    b = new GeoBuf();
    bufs.set(key, b);
  }
  return b;
}

// ── grandstand ───────────────────────────────────────────────────────────────────

function standRows(ctx: Ctx, def: StandDef, i0: number, i1: number): Row[] {
  const rt = ctx.rt;
  const sgn: 1 | -1 = def.side === 'L' ? 1 : -1;
  const S = sgn > 0 ? rt.L : rt.R;
  const N = rt.count;
  // rows must be contiguous in s even across the lap seam: rowAtD wraps via modular index
  const rows: Row[] = [];
  for (let i = i0; i <= i1; i += 2) {
    const k = ((i % N) + N) % N;
    const r = rowAtD(rt, sgn, k, S.wall[k] + def.gap);
    r.s = i * rt.spacing; // continuous along the structure
    rows.push(r);
  }
  return rows;
}

function buildStand(ctx: Ctx, def: StandDef, bufs: Bufs, mats: PropMats): void {
  const rt = ctx.rt;
  const sMid = markToIndex(ctx, def.at);
  const half = Math.round(def.length / rt.spacing / 2);
  const rows = standRows(ctx, def, sMid - half, sMid + half);
  if (rows.length < 3) return;
  const rise = def.rise ?? 0.46;
  const depth = def.depth ?? 0.84;
  const R = def.rows;
  const y0 = 0.8;
  const treads: Parameters<typeof extrude>[2] = [];
  const risers: Parameters<typeof extrude>[2] = [];
  risers.push({ q0: 0, y0: -3.5, q1: 0, y1: y0 - rise, n: [-1, 0], v0: -3.5, v1: y0 - rise });
  for (let r = 0; r < R; r++) {
    const y = y0 + r * rise;
    risers.push({ q0: r * depth, y0: y - rise, q1: r * depth, y1: y, n: [-1, 0], v0: y - rise, v1: y });
    treads.push({ q0: r * depth, y0: y, q1: (r + 1) * depth, y1: y, n: [0, 1], v0: 0, v1: 1 });
  }
  const yTop = y0 + (R - 1) * rise;
  risers.push({ q0: R * depth, y0: yTop, q1: R * depth, y1: -3.5, n: [1, 0], v0: yTop, v1: -3.5 });
  extrude(buf(bufs, 'seat'), rows, treads, 1 / 8, 1, false);
  extrude(buf(bufs, 'concrete'), rows, risers, 1, 1, false);
  // crowd: a standing strip per row
  const cb = buf(bufs, 'crowd');
  for (let r = 0; r < R; r++) {
    const y = y0 + r * rise;
    const q = r * depth + depth * 0.5;
    const shade = 0.8 + 0.2 * (r / R);
    const base = cb.count;
    for (let k = 0; k < rows.length; k++) {
      const row = rows[k];
      const u = (row.s - rows[0].s) / 8 + r * 0.37;
      for (const [yy, v] of [[y - 0.05, 0], [y + 1.18, 1]] as const) {
        cb.v(row.x + row.ox * q, row.y + yy, row.z + row.oz * q, -row.ox, 0.05, -row.oz, u, v);
        cb.color(shade, shade, shade);
      }
    }
    for (let k = 0; k + 1 < rows.length; k++) {
      const a = base + k * 2;
      cb.quad(a, a + 2, a + 3, a + 1);
      cb.quad(a, a + 1, a + 3, a + 2);
    }
  }
  // roof
  if (def.roof !== false) {
    const rf = buf(bufs, 'roof');
    const q0 = Math.min(R - 1, 4) * depth;
    const q1 = R * depth + 1.5;
    const yF = y0 + Math.min(R - 1, 4) * rise + 5.6;
    const yB = y0 + (R - 1) * rise + 6.4;
    const segs: Parameters<typeof extrude>[2] = [
      { q0: q0, y0: yF, q1: q1, y1: yB, n: [-(yB - yF) / Math.hypot(q1 - q0, yB - yF), (q1 - q0) / Math.hypot(q1 - q0, yB - yF)], v0: 0, v1: 1 },
      { q0: q1, y0: yB, q1: q0, y1: yF - 0.0, n: [(yB - yF) / Math.hypot(q1 - q0, yB - yF), -(q1 - q0) / Math.hypot(q1 - q0, yB - yF)], v0: 0, v1: 1 },
      { q0: q0, y0: yF - 0.55, q1: q0, y1: yF + 0.1, n: [-1, 0], v0: 0, v1: 1 },
    ];
    extrude(rf, rows, segs, 1, 1, false);
    // teal fascia
    extrude(buf(bufs, 'teal'), rows, [{ q0: q0 - 0.02, y0: yF - 0.5, q1: q0 - 0.02, y1: yF + 0.05, n: [-1, 0], v0: 0, v1: 1 }], 1, 1, false);
    // columns
    const pb = buf(bufs, 'plain');
    for (let k = 0; k < rows.length; k++) {
      const row = rows[k];
      const i = Math.round(row.s / rt.spacing);
      if (i % 14 === 0) {
        addBox(pb, row, q0 + 0.2, (yF - 0.4 - 3.5) / 2 - 1.7 + 0.0, 0.22, (yF - 0.4 + 3.5) / 2 - 0.0, 0.22);
        addBox(pb, row, q1 - 0.4, (yB - 0.4 - 3.5) / 2 - 1.7, 0.22, (yB - 0.4 + 3.5) / 2, 0.22);
      }
    }
  }
  // end caps
  for (const idx of [0, rows.length - 1]) {
    const row = rows[idx];
    const sgnT = idx === 0 ? -1 : 1;
    const cap = buf(bufs, 'concrete');
    const T = new THREE.Vector3(row.tx * sgnT, 0, row.tz * sgnT);
    const O = new THREE.Vector3(row.ox, 0, row.oz);
    const base = cap.count;
    // stepped end silhouette
    for (let r = 0; r <= R; r++) {
      const yy = y0 + Math.min(r, R - 1) * rise + (r === R ? 0 : 0);
      const q = r * depth;
      for (const y of [-3.5, yy]) {
        cap.v(row.x + O.x * q, row.y + y, row.z + O.z * q, T.x, 0, T.z, q / 3, y / 3);
      }
    }
    for (let r = 0; r < R; r++) {
      const a = base + r * 2;
      cap.quad(a, a + 2, a + 3, a + 1);
      cap.quad(a, a + 1, a + 3, a + 2);
    }
  }
  // reserve the ground
  const depthTot = R * depth + 12;
  for (let k = 0; k < rows.length; k += 6) {
    const row = rows[k];
    const cx = row.x + row.ox * depthTot * 0.5;
    const cz = row.z + row.oz * depthTot * 0.5;
    const rr = depthTot * 0.5 + 10;
    ctx.reserved.push((x, z, m) => (x - cx) * (x - cx) + (z - cz) * (z - cz) < (rr + m) * (rr + m));
  }
}

// ── pit building + lane ──────────────────────────────────────────────────────────

function buildPits(ctx: Ctx, bufs: Bufs, mats: PropMats, road: TrackMaterials): void {
  const sc = ctx.rt.def.scenery;
  if (!sc?.pits) return;
  const rt = ctx.rt;
  const sgn: 1 | -1 = sc.pits.side === 'L' ? 1 : -1;
  const S = sgn > 0 ? rt.L : rt.R;
  const i0 = markToIndex(ctx, sc.pits.from);
  let i1 = markToIndex(ctx, sc.pits.to);
  if (i1 <= i0) i1 += rt.count;
  const N = rt.count;
  const laneW = 12.5;
  // pit lane strip
  {
    const lb = buf(bufs, 'pitlane');
    const NC = 6;
    for (let i = i0; i <= i1; i++) {
      const k = ((i % N) + N) % N;
      const wall = S.wall[k];
      for (let c = 0; c <= NC; c++) {
        const d = wall + 0.4 + (laneW * c) / NC;
        const r = rowAtD(rt, sgn, k, d);
        lb.v(r.x, r.y + 0.06, r.z, 0, 1, 0, r.x, r.z);
        lb.color(1, 1, 1);
      }
    }
    const rowsN = i1 - i0;
    for (let r = 0; r < rowsN; r++) {
      const a = r * (NC + 1);
      const b = (r + 1) * (NC + 1);
      for (let c = 0; c < NC; c++) {
        if (sgn > 0) lb.quad(a + c, b + c, b + c + 1, a + c + 1);
        else lb.quad(a + c, a + c + 1, b + c + 1, b + c);
      }
    }
  }
  // building
  const rows = standRowsPit(ctx, sgn, i0, i1, (k) => S.wall[k] + 0.4 + laneW + 0.8);
  const H = 7.6;
  const front: Parameters<typeof extrude>[2] = [{ q0: 0, y0: -0.4, q1: 0, y1: H, n: [-1, 0], v0: -0.4, v1: H }];
  extrude(buf(bufs, 'facade'), rows, front, 1 / 12, 1 / 8, false);
  const depth = 17;
  const roof: Parameters<typeof extrude>[2] = [
    { q0: -5.4, y0: H + 0.4, q1: depth, y1: H + 0.4, n: [0, 1], v0: 0, v1: 1 },
    { q0: depth, y0: H, q1: -5.4, y1: H, n: [0, -1], v0: 0, v1: 1 },
    { q0: -5.4, y0: H, q1: -5.4, y1: H + 0.4, n: [-1, 0], v0: 0, v1: 1 },
  ];
  extrude(buf(bufs, 'roof'), rows, roof, 1, 1, false);
  extrude(buf(bufs, 'teal'), rows, [{ q0: -5.42, y0: H + 0.05, q1: -5.42, y1: H + 0.36, n: [-1, 0], v0: 0, v1: 1 }], 1, 1, false);
  extrude(buf(bufs, 'concrete'), rows, [
    { q0: depth, y0: H, q1: depth, y1: -0.4, n: [1, 0], v0: H, v1: -0.4 },
  ], 1, 1, false);
  // columns along the overhang
  const pb = buf(bufs, 'plain');
  for (const row of rows) {
    const i = Math.round(row.s / rt.spacing);
    if (i % 12 === 0) addBox(pb, row, -4.9, H / 2 - 0.1, 0.18, H / 2 + 0.2, 0.18);
  }
  // control tower at the start line
  const nearLine = (r: Row) => {
    const sm = ((r.s % rt.length) + rt.length) % rt.length;
    return Math.min(sm, rt.length - sm);
  };
  const rowT = rows.reduce((best, r) => (nearLine(r) < nearLine(best) ? r : best), rows[0]);
  const tb = buf(bufs, 'tower');
  const ax = new THREE.Vector3(rowT.ox, 0, rowT.oz);
  const az = new THREE.Vector3(rowT.tx, 0, rowT.tz);
  const ay = new THREE.Vector3(0, 1, 0);
  const cTower = new THREE.Vector3(rowT.x + rowT.ox * 7, rowT.y + 7.8, rowT.z + rowT.oz * 7);
  obox(tb, cTower, 7, 7.8, 14, ax, ay, az, 7.8, 1);
  // roof: parapet, plant room, antenna mast, dish
  const wbT = buf(bufs, 'white');
  const dbT = buf(bufs, 'dark');
  const roofC = cTower.clone().add(new THREE.Vector3(0, 7.8, 0));
  obox(wbT, roofC.clone().add(new THREE.Vector3(0, 0.45, 0)), 7.15, 0.45, 14.15, ax, ay, az, 0, 1);
  obox(dbT, roofC.clone().add(new THREE.Vector3(0, 0.95, 0)).addScaledVector(ax, 1.5).addScaledVector(az, -5), 3, 0.5, 4, ax, ay, az, 0, 1);
  obox(dbT, roofC.clone().add(new THREE.Vector3(0, 0.8, 0)).addScaledVector(ax, -2.5).addScaledVector(az, 6.5), 2, 0.35, 2.6, ax, ay, az, 0, 1);
  obox(wbT, roofC.clone().add(new THREE.Vector3(0, 5.2, 0)).addScaledVector(ax, 3).addScaledVector(az, 2), 0.07, 4.2, 0.07, ax, ay, az, 0, 1);
  obox(wbT, roofC.clone().add(new THREE.Vector3(0, 8.1, 0)).addScaledVector(ax, 3).addScaledVector(az, 2), 0.04, 1.4, 0.04, ax, ay, az, 0, 1);
  // sign band on the tower
  const sb = buf(bufs, 'sign');
  const cs = new THREE.Vector3(rowT.x - rowT.ox * 0.08, rowT.y + 13.4, rowT.z - rowT.oz * 0.08);
  panel(sb, cs, 9.5, 1.45, az, ay, ax.clone().negate());
  // reserve ground behind the pits
  for (let k = 0; k < rows.length; k += 5) {
    const r = rows[k];
    const cx = r.x + r.ox * 10;
    const cz = r.z + r.oz * 10;
    ctx.reserved.push((x, z, m) => (x - cx) * (x - cx) + (z - cz) * (z - cz) < (16 + m) * (16 + m));
  }
  void mats;
  void road;
}

function standRowsPit(ctx: Ctx, sgn: 1 | -1, i0: number, i1: number, dOutFn: (k: number) => number): Row[] {
  const rt = ctx.rt;
  const N = rt.count;
  const rows: Row[] = [];
  for (let i = i0; i <= i1; i += 2) {
    const k = ((i % N) + N) % N;
    const r = rowAtD(rt, sgn, k, dOutFn(k));
    r.s = i * rt.spacing; // continuous along the structure (may exceed the lap length)
    rows.push(r);
  }
  return rows;
}

// ── gantry ───────────────────────────────────────────────────────────────────────

function buildGantry(ctx: Ctx, bufs: Bufs, mats: PropMats, group: THREE.Group): (state: number | null) => void {
  const sc = ctx.rt.def.scenery;
  if (!sc?.gantry) return () => {};
  const rt = ctx.rt;
  const i0 = markToIndex(ctx, sc.gantry);
  const k = ((i0 % rt.count) + rt.count) % rt.count;
  const ax = new THREE.Vector3(rt.HLX[k], 0, rt.HLZ[k]); // left
  const az = new THREE.Vector3(rt.HTX[k], 0, rt.HTZ[k]); // forward
  const ay = new THREE.Vector3(0, 1, 0);
  const wl = rt.L.wall[k];
  const wr = rt.R.wall[k];
  const pb = buf(bufs, 'plain');
  const dark = buf(bufs, 'dark');
  const centerD = (wl - wr) / 2;
  const span = wl + wr + 3.4;
  const pivot = new THREE.Vector3();
  rt.pointAt(k * rt.spacing, centerD, pivot);
  const gy = Math.max(rt.heightSD(k * rt.spacing, wl + 1.2), rt.heightSD(k * rt.spacing, -(wr + 1.2)));
  const beamY = gy + 8.4;
  for (const side of [-1, 1]) {
    const d = side > 0 ? wl + 1.2 : -(wr + 1.2);
    const p = new THREE.Vector3();
    rt.pointAt(k * rt.spacing, d, p);
    const py = rt.heightSD(k * rt.spacing, d);
    obox(pb, new THREE.Vector3(p.x, (py + beamY) / 2 - 0.2, p.z), 0.55, (beamY - py) / 2 + 0.4, 0.55, ax, ay, az, 0, 1);
    obox(dark, new THREE.Vector3(p.x, py + 0.25, p.z), 0.9, 0.25, 0.9, ax, ay, az, 0, 1);
  }
  // main truss beam
  const bc = new THREE.Vector3(pivot.x, beamY, pivot.z);
  obox(pb, bc, span / 2, 0.45, 0.55, ax, ay, az, 0, 1);
  obox(pb, bc.clone().add(new THREE.Vector3(0, 0.95, 0)), span / 2, 0.08, 0.55, ax, ay, az, 0, 1);
  // vertical struts
  for (let i = -Math.floor(span / 4); i <= Math.floor(span / 4); i++) {
    const c = bc.clone().addScaledVector(ax, i * 2 + 0.5).add(new THREE.Vector3(0, 0.48, 0));
    obox(pb, c, 0.05, 0.48, 0.05, ax, ay, az, 0, 1);
  }
  // sign panel above the beam, facing the oncoming cars (-forward)
  const sb = buf(bufs, 'sign');
  const sg = bc.clone().add(new THREE.Vector3(0, 2.3, 0)).addScaledVector(az, -0.1);
  obox(buf(bufs, 'dark'), sg.clone().addScaledVector(az, 0.1), Math.min(7, span * 0.45) + 0.12, 1.17, 0.05, ax, ay, az, 0, 1);
  panel(sb, sg.clone().addScaledVector(az, -0.0), Math.min(7, span * 0.45), 1.05, ax.clone().negate(), ay, az.clone().negate());
  // light housing
  const hs = bc.clone().add(new THREE.Vector3(0, -0.85, 0)).addScaledVector(az, -0.7);
  obox(dark, hs, 3.9, 0.62, 0.3, ax, ay, az, 0, 1);
  // 5 columns x 2 lights
  const geo = new THREE.CylinderGeometry(0.21, 0.21, 0.06, 20);
  geo.rotateX(Math.PI / 2); // axis along z
  ctx.disposables.push(geo);
  const lightMats: THREE.MeshStandardMaterial[] = [];
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(ax.clone().negate(), ay, az.clone().negate()));
  // basis maps local +z to -forward (facing the oncoming cars)
  for (let c = 0; c < 5; c++) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x1a0505, roughness: 0.4, metalness: 0, emissive: 0xff1a10, emissiveIntensity: 0 });
    lightMats.push(mat);
    for (const row of [0, 1]) {
      const mesh = new THREE.Mesh(geo, mat);
      const off = (c - 2) * 1.5;
      mesh.position.copy(hs).addScaledVector(ax, -off).addScaledVector(az, -0.34).add(new THREE.Vector3(0, row === 0 ? 0.25 : -0.28, 0));
      mesh.quaternion.copy(q);
      group.add(mesh);
    }
  }
  ctx.disposables.push(...lightMats);
  void mats;
  // timing loop / flag poles: skip
  return (state: number | null) => {
    const n = state === null || state >= 6 ? 0 : Math.max(0, Math.min(5, state));
    lightMats.forEach((m, i) => {
      const on = i < n;
      m.emissiveIntensity = on ? 3.2 : 0;
      m.color.setHex(on ? 0xff2a1a : 0x1a0505);
    });
  };
}

// ── marshal posts, lamps, boards, flags ──────────────────────────────────────────

interface FlagSys {
  add(position: THREE.Vector3, yaw: number, tex: THREE.Texture, w: number, h: number): void;
  finish(): THREE.Group;
}

function makeFlags(ctx: Ctx): FlagSys {
  const shared = { uTime: { value: 0 } };
  const items: { p: THREE.Vector3; yaw: number; tex: THREE.Texture; w: number; h: number }[] = [];
  const group = new THREE.Group();
  group.name = 'flags';
  return {
    add(position, yaw, tex, w, h) {
      items.push({ p: position.clone(), yaw, tex, w, h });
    },
    finish() {
      const byTex = new Map<THREE.Texture, typeof items>();
      for (const it of items) {
        const l = byTex.get(it.tex) ?? [];
        l.push(it);
        byTex.set(it.tex, l);
      }
      for (const [tex, list] of byTex) {
        const geo = new THREE.PlaneGeometry(1, 1, 12, 6);
        geo.translate(0.5, 0, 0);
        const mat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.8, metalness: 0 });
        mat.onBeforeCompile = (shader) => {
          shader.uniforms.uTime = shared.uTime;
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nuniform float uTime;')
            .replace(
              '#include <begin_vertex>',
              `#include <begin_vertex>
#ifdef USE_INSTANCING
  float ph = instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 0.4;
#else
  float ph = 0.0;
#endif
  float wv = sin(position.x * 7.0 - uTime * 6.0 + ph) * 0.5 + sin(position.x * 12.0 - uTime * 9.0 + ph * 1.7) * 0.2;
  transformed.z += wv * 0.08 * position.x;
  transformed.y += cos(position.x * 5.0 - uTime * 5.0 + ph) * 0.02 * position.x;`,
            );
        };
        mat.customProgramCacheKey = () => 'flag-wave';
        const mesh = new THREE.InstancedMesh(geo, mat, list.length);
        const m4 = new THREE.Matrix4();
        const q = new THREE.Quaternion();
        list.forEach((it, i) => {
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), it.yaw);
          m4.compose(it.p, q, new THREE.Vector3(it.w, it.h, 1));
          mesh.setMatrixAt(i, m4);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.frustumCulled = false;
        mesh.castShadow = false;
        group.add(mesh);
        ctx.disposables.push(geo, mat);
      }
      ctx.updaters.push((dt, camera, time) => {
        shared.uTime.value = time;
      });
      return group;
    },
  };
}

function buildMarshals(ctx: Ctx, bufs: Bufs, flags: FlagSys, flagTex: THREE.Texture): void {
  const sc = ctx.rt.def.scenery;
  if (!sc?.marshals) return;
  const rt = ctx.rt;
  const wb = buf(bufs, 'white');
  const ob = buf(bufs, 'orange');
  const db = buf(bufs, 'dark');
  for (const name of sc.marshals) {
    const c = rt.corners.find((k) => k.name === name);
    if (!c) continue;
    const sApex = c.sArcA + (c.sArcB - c.sArcA) * 0.5;
    const i = Math.round(sApex / rt.spacing);
    const sgn: 1 | -1 = c.dir > 0 ? -1 : 1; // outside of the corner
    const S = sgn > 0 ? rt.L : rt.R;
    const k = i % rt.count;
    const dOut = S.wall[k] + 3.2;
    const row = rowAtD(rt, sgn, k, dOut);
    const ax = new THREE.Vector3(row.ox, 0, row.oz);
    const az = new THREE.Vector3(row.tx, 0, row.tz);
    const ay = new THREE.Vector3(0, 1, 0);
    const base = new THREE.Vector3(row.x, row.y, row.z);
    // pad, hut, roof, orange band, door
    obox(db, base.clone().add(new THREE.Vector3(0, 0.1, 0)), 1.5, 0.1, 1.9, ax, ay, az, 0, 1);
    obox(wb, base.clone().add(new THREE.Vector3(0, 1.35, 0)).addScaledVector(ax, 0.3), 0.85, 1.25, 1.1, ax, ay, az, 0, 1);
    obox(ob, base.clone().add(new THREE.Vector3(0, 2.0, 0)).addScaledVector(ax, -0.58), 0.05, 0.2, 1.12, ax, ay, az, 0, 1);
    obox(db, base.clone().add(new THREE.Vector3(0, 1.0, 0)).addScaledVector(ax, -0.56), 0.04, 0.75, 0.5, ax, ay, az, 0, 1);
    obox(wb, base.clone().add(new THREE.Vector3(0, 2.62, 0)).addScaledVector(ax, 0.05), 1.15, 0.07, 1.4, ax, ay, az, 0, 1);
    // flag pole + yellow flag
    const pole = base.clone().addScaledVector(ax, 1.9).addScaledVector(az, 1.4);
    obox(db, pole.clone().add(new THREE.Vector3(0, 2.6, 0)), 0.04, 2.6, 0.04, ax, ay, az, 0, 1);
    const fp = pole.clone().add(new THREE.Vector3(0, 4.4, 0));
    flags.add(fp, Math.atan2(-az.z, az.x) + Math.PI * 0.5, flagTex, 1.5, 0.95);
    // reserve
    const cx = row.x;
    const cz = row.z;
    ctx.reserved.push((x, z, m) => (x - cx) * (x - cx) + (z - cz) * (z - cz) < (5 + m) * (5 + m));
  }
}

function buildLamps(ctx: Ctx, group: THREE.Group): void {
  const sc = ctx.rt.def.scenery;
  if (!sc?.lamps || !sc.lamps.length) return;
  const rt = ctx.rt;
  const list: { x: number; y: number; z: number; ox: number; oz: number }[] = [];
  for (const L of sc.lamps) {
    let i0 = markToIndex(ctx, L.from);
    let i1 = markToIndex(ctx, L.to);
    if (i1 <= i0) i1 += rt.count;
    const stepI = Math.max(1, Math.round(L.spacing / rt.spacing));
    for (let i = i0; i <= i1; i += stepI) {
      for (const sgn of (L.side === 'B' ? [1, -1] : [L.side === 'L' ? 1 : -1]) as (1 | -1)[]) {
        const S = sgn > 0 ? rt.L : rt.R;
        const k = ((i % rt.count) + rt.count) % rt.count;
        const r = rowAtD(rt, sgn, k, S.wall[k] + 1.6);
        list.push({ x: r.x, y: r.y, z: r.z, ox: r.ox, oz: r.oz });
      }
    }
  }
  if (!list.length) return;
  const poleG = new THREE.CylinderGeometry(0.09, 0.14, 13, 8);
  poleG.translate(0, 6.5, 0);
  const headG = new THREE.BoxGeometry(2.2, 0.14, 0.55);
  headG.translate(1.1, 13.0, 0); // arm extends toward +x (local); rotated to face the track
  const poleM = new THREE.MeshStandardMaterial({ color: 0x8a8f94, metalness: 0.7, roughness: 0.5 });
  const headM = new THREE.MeshStandardMaterial({ color: 0xdcdcdc, roughness: 0.4, emissive: 0xfff0d0, emissiveIntensity: 0 });
  const poles = new THREE.InstancedMesh(poleG, poleM, list.length);
  const heads = new THREE.InstancedMesh(headG, headM, list.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  list.forEach((l, i) => {
    // local +x should point toward the track = -outward
    q.setFromAxisAngle(up, Math.atan2(l.oz, -l.ox));
    m4.compose(new THREE.Vector3(l.x, l.y, l.z), q, new THREE.Vector3(1, 1, 1));
    poles.setMatrixAt(i, m4);
    heads.setMatrixAt(i, m4);
  });
  poles.castShadow = true;
  poles.frustumCulled = false;
  heads.frustumCulled = false;
  group.add(poles, heads);
  // lamp-head positions for the render module's lit rain / spray (read from the scene graph, no import needed)
  const lampHeads = new Float32Array(list.length * 3);
  list.forEach((l, i) => {
    lampHeads[i * 3] = l.x - l.ox * 1.1;
    lampHeads[i * 3 + 1] = l.y + 12.95;
    lampHeads[i * 3 + 2] = l.z - l.oz * 1.1;
  });
  group.userData.xrLamps = lampHeads;
  ctx.lamps = lampHeads;
  ctx.disposables.push(poleG, headG, poleM, headM);
  ctx.nightGlow.push({ mat: headM, day: 0, night: 6 });
  // light pools on the road (additive, night only)
  const poolG = new THREE.PlaneGeometry(1, 1);
  poolG.rotateX(-Math.PI / 2);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(64, 64, 2, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,240,212,1)');
  gr.addColorStop(0.45, 'rgba(255,230,192,0.45)');
  gr.addColorStop(1, 'rgba(255,220,180,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  const poolT = new THREE.CanvasTexture(c);
  poolT.colorSpace = THREE.SRGBColorSpace;
  const poolM = new THREE.MeshBasicMaterial({ map: poolT, transparent: true, depthWrite: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, fog: true });
  // additive colour, but keep the destination alpha: the wet-road shader stores its reflection flag there
  poolM.blending = THREE.CustomBlending;
  poolM.blendEquation = THREE.AddEquation;
  poolM.blendSrc = THREE.SrcAlphaFactor;
  poolM.blendDst = THREE.OneFactor;
  poolM.blendSrcAlpha = THREE.ZeroFactor;
  poolM.blendDstAlpha = THREE.OneFactor;
  const pools = new THREE.InstancedMesh(poolG, poolM, list.length);
  list.forEach((l, i) => {
    const px = l.x - l.ox * 7.5;
    const pz = l.z - l.oz * 7.5;
    const py = ctx.rt.heightXZ(px, pz) + 0.05;
    m4.compose(new THREE.Vector3(px, py, pz), new THREE.Quaternion(), new THREE.Vector3(22, 1, 22));
    pools.setMatrixAt(i, m4);
  });
  pools.frustumCulled = false;
  pools.renderOrder = 3;
  group.add(pools);
  ctx.disposables.push(poolG, poolT, poolM);
  ctx.envListeners.push((env: EnvironmentState) => {
    // in the rain the lamps stay quiet until it is really dark (a storm at noon only switches them on)
    // (a wet road is lit by the lamps themselves in its shader, with reflections: no painted pools there)
    poolM.opacity = env.wetness > 0 ? 0 : (0.55 * Math.max(0, env.darkness - 0.25)) / 0.75;
    pools.visible = poolM.opacity > 0.01;
  });
}

function buildBoards(ctx: Ctx, bufs: Bufs, mats: BarrierMaterials): void {
  const sc = ctx.rt.def.scenery;
  const rt = ctx.rt;
  const ab = buf(bufs, 'ads');
  const pb = buf(bufs, 'plain');
  const atlas = mats.atlas;
  for (const b of sc?.boards ?? []) {
    const i = markToIndex(ctx, b.at);
    const k = ((i % rt.count) + rt.count) % rt.count;
    const sgn: 1 | -1 = b.side === 'L' ? 1 : -1;
    const S = sgn > 0 ? rt.L : rt.R;
    const row = rowAtD(rt, sgn, k, S.wall[k] + b.gap);
    const ax = new THREE.Vector3(row.ox, 0, row.oz);
    const az = new THREE.Vector3(row.tx, 0, row.tz);
    const ay = new THREE.Vector3(0, 1, 0);
    const base = new THREE.Vector3(row.x, row.y, row.z);
    const W = 12;
    const Hh = 3;
    // legs
    for (const dz of [-W * 0.32, W * 0.32]) obox(pb, base.clone().add(new THREE.Vector3(0, 3.4, 0)).addScaledVector(az, dz), 0.15, 3.4, 0.15, ax, ay, az, 0, 0.6);
    // panel back + front
    obox(pb, base.clone().add(new THREE.Vector3(0, 6.3, 0)).addScaledVector(ax, 0.08), 0.06, Hh / 2 + 0.1, W / 2 + 0.1, ax, ay, az, 0, 0.55);
    const kk = b.brand % atlas.count;
    const u0 = (kk % atlas.cols) / atlas.cols;
    const u1 = (kk % atlas.cols + 1) / atlas.cols;
    const v1 = 1 - Math.floor(kk / atlas.cols) / atlas.rows;
    const v0 = 1 - (Math.floor(kk / atlas.cols) + 1) / atlas.rows;
    const fc = base.clone().add(new THREE.Vector3(0, 6.3, 0)).addScaledVector(ax, -0.0);
    const ids: number[] = [];
    for (const [sx, sy, u, v] of [[-1, -1, u0, v0], [1, -1, u1, v0], [1, 1, u1, v1], [-1, 1, u0, v1]] as const) {
      const p = fc.clone().addScaledVector(az, sx * W / 2).addScaledVector(ay, sy * Hh / 2);
      ids.push(ab.v(p.x, p.y, p.z, -ax.x, 0, -ax.z, u, v));
    }
    // face toward the track = -ax
    const P = ab.pos;
    _a.set(P[ids[0] * 3], P[ids[0] * 3 + 1], P[ids[0] * 3 + 2]);
    _b.set(P[ids[1] * 3], P[ids[1] * 3 + 1], P[ids[1] * 3 + 2]);
    _c.set(P[ids[2] * 3], P[ids[2] * 3 + 1], P[ids[2] * 3 + 2]);
    _n.crossVectors(_b.sub(_a), _c.sub(_a));
    if (_n.x * -ax.x + _n.z * -ax.z >= 0) ab.quad(ids[0], ids[1], ids[2], ids[3]);
    else ab.quad(ids[0], ids[3], ids[2], ids[1]);
    const cx = row.x;
    const cz = row.z;
    ctx.reserved.push((x, z, m) => (x - cx) * (x - cx) + (z - cz) * (z - cz) < (9 + m) * (9 + m));
  }
}

function buildBrakingBoards(ctx: Ctx, group: THREE.Group): void {
  const rt = ctx.rt;
  const marks = rt.def.scenery?.brakeBoards;
  if (!marks) return;
  const geo = new THREE.BoxGeometry(0.12, 1.5, 1.5);
  geo.translate(0, 1.5, 0);
  ctx.disposables.push(geo);
  for (const { corner, dist } of marks) {
    const c = rt.corners.find((k) => k.name === corner);
    if (!c) continue;
    for (const d of dist) {
      const s = c.sStart - d;
      const k = Math.round(rt.wrapS(s) / rt.spacing) % rt.count;
      // outside of the upcoming corner
      const sgn: 1 | -1 = c.dir > 0 ? -1 : 1;
      const S = sgn > 0 ? rt.L : rt.R;
      const r = rowAtD(rt, sgn, k, S.wall[k] + 1.3);
      const tex = makeBoardTexture(String(d));
      ctx.disposables.push(tex);
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0 });
      ctx.nightGlow.push({ mat, day: 0, night: 0.5 });
      ctx.disposables.push(mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(r.x, r.y, r.z);
      mesh.rotation.y = Math.atan2(r.oz, -r.ox);
      mesh.castShadow = true;
      group.add(mesh);
    }
  }
}

// ── footbridges ──────────────────────────────────────────────────────────────────

function buildBridges(ctx: Ctx, bufs: Bufs, mats: BarrierMaterials): void {
  const sc = ctx.rt.def.scenery;
  if (!sc?.bridges?.length) return;
  const rt = ctx.rt;
  const pb = buf(bufs, 'plain');
  const wb = buf(bufs, 'white');
  const tb = buf(bufs, 'teal');
  const ab = buf(bufs, 'ads');
  const db = buf(bufs, 'dark');
  const atlas = mats.atlas;
  const up = new THREE.Vector3(0, 1, 0);
  for (const br of sc.bridges) {
    const k = ((markToIndex(ctx, br.at) % rt.count) + rt.count) % rt.count;
    const s = k * rt.spacing;
    const wl = rt.L.wall[k] + 3.4;
    const wr = rt.R.wall[k] + 3.4;
    const rowL = rowAtD(rt, 1, k, wl);
    const rowR = rowAtD(rt, -1, k, wr);
    const l = new THREE.Vector3(rt.HLX[k], 0, rt.HLZ[k]);
    const t = new THREE.Vector3(rt.HTX[k], 0, rt.HTZ[k]);
    const roadY = rt.py[k];
    const deckY = Math.max(roadY, rowL.y, rowR.y) + 7.6;
    const span = wl + wr;
    const mid = new THREE.Vector3(rt.X[k], 0, rt.Z[k]).addScaledVector(l, (wl - wr) / 2);
    // columns (square, with a darker foot) on both sides
    for (const row of [rowL, rowR]) {
      const h = deckY - row.y;
      obox(pb, new THREE.Vector3(row.x, row.y + h / 2 - 0.5, row.z), 0.5, h / 2 + 0.5, 0.62, l, up, t, 0, 1);
      obox(db, new THREE.Vector3(row.x, row.y + 0.45, row.z), 0.62, 0.45, 0.74, l, up, t, 0, 1);
    }
    // girder (box section) + walkway slab + teal soffit stripe
    const gc = mid.clone().setY(deckY - 0.5);
    obox(wb, gc, span / 2 + 0.9, 0.55, 1.55, l, up, t, 0, 1);
    obox(pb, mid.clone().setY(deckY + 0.08), span / 2 + 0.9, 0.06, 1.7, l, up, t, 0, 1);
    obox(tb, mid.clone().setY(deckY - 1.1), span / 2 + 0.7, 0.07, 1.62, l, up, t, 0, 1);
    // railings on both edges of the deck
    for (const side of [-1, 1]) {
      obox(db, mid.clone().setY(deckY + 0.62).addScaledVector(t, side * 1.62), span / 2 + 0.85, 0.03, 0.025, l, up, t, 0, 1);
      obox(db, mid.clone().setY(deckY + 1.08).addScaledVector(t, side * 1.62), span / 2 + 0.85, 0.03, 0.025, l, up, t, 0, 1);
    }
    // advertising faces: toward the approaching drivers (-t) and toward the receding ones (+t)
    const kk = br.brand % atlas.count;
    const u0 = (kk % atlas.cols) / atlas.cols;
    const u1 = ((kk % atlas.cols) + 1) / atlas.cols;
    const v1 = 1 - Math.floor(kk / atlas.cols) / atlas.rows;
    const v0 = 1 - (Math.floor(kk / atlas.cols) + 1) / atlas.rows;
    for (const face of [-1, 1]) {
      const n = t.clone().multiplyScalar(face);
      // text reads left-to-right for a viewer looking against n: right = up x n
      const right = new THREE.Vector3().crossVectors(up, n).normalize();
      const c = mid.clone().setY(deckY + 0.55).addScaledVector(t, face * 1.66);
      const ids: number[] = [];
      const halfW = span / 2 + 0.5;
      const halfH = 0.62;
      for (const [sx, sy, u, v] of [[-1, -1, u0, v0], [1, -1, u1, v0], [1, 1, u1, v1], [-1, 1, u0, v1]] as const) {
        const p = c.clone().addScaledVector(right, sx * halfW).addScaledVector(up, sy * halfH);
        ids.push(ab.v(p.x, p.y, p.z, n.x, 0, n.z, u, v));
      }
      const P = ab.pos;
      _a.set(P[ids[0] * 3], P[ids[0] * 3 + 1], P[ids[0] * 3 + 2]);
      _b.set(P[ids[1] * 3], P[ids[1] * 3 + 1], P[ids[1] * 3 + 2]);
      _c.set(P[ids[2] * 3], P[ids[2] * 3 + 1], P[ids[2] * 3 + 2]);
      _n.crossVectors(_b.sub(_a), _c.sub(_a));
      if (_n.dot(n) >= 0) ab.quad(ids[0], ids[1], ids[2], ids[3]);
      else ab.quad(ids[0], ids[3], ids[2], ids[1]);
    }
    const cx = mid.x;
    const cz = mid.z;
    const rr = span / 2 + 8;
    ctx.reserved.push((x, z, m) => (x - cx) * (x - cx) + (z - cz) * (z - cz) < (rr + m) * (rr + m));
    void s;
  }
}

// ── mountain-road signage ────────────────────────────────────────────────────────

function disc(b: GeoBuf, c: THREE.Vector3, n: THREE.Vector3, r: number, segs = 20): void {
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n).normalize();
  const upv = new THREE.Vector3().crossVectors(n, right).normalize();
  const mid = b.v(c.x, c.y, c.z, n.x, n.y, n.z, 0.5, 0.5);
  const ring: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const p = c.clone().addScaledVector(right, Math.cos(a) * r).addScaledVector(upv, Math.sin(a) * r);
    ring.push(b.v(p.x, p.y, p.z, n.x, n.y, n.z, 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5));
  }
  for (let i = 0; i < segs; i++) b.tri(mid, ring[i], ring[(i + 1) % segs]);
}

function buildRoadSigns(ctx: Ctx, bufs: Bufs): void {
  const rs = ctx.rt.def.scenery?.roadSigns;
  if (!rs) return;
  const rt = ctx.rt;
  const up = new THREE.Vector3(0, 1, 0);
  const wb = buf(bufs, 'white');
  const db = buf(bufs, 'dark');
  const ob = buf(bufs, 'orange');
  const mb = buf(bufs, 'mirror');
  const corner = (name: string) => rt.corners.find((k) => k.name === name);

  /** Sign face on two posts at arc position s, on the outside (sgn) of the road, facing the approaching driver. */
  const sign = (key: string, s: number, sgn: 1 | -1, gap: number, hw: number, hh: number, bottom: number, facing: number): void => {
    const k = ((Math.round(rt.wrapS(s) / rt.spacing) % rt.count) + rt.count) % rt.count;
    const S = sgn > 0 ? rt.L : rt.R;
    const row = rowAtD(rt, sgn, k, S.wall[k] + gap);
    const o = new THREE.Vector3(row.ox, 0, row.oz);
    const t = new THREE.Vector3(row.tx, 0, row.tz);
    const n = new THREE.Vector3().addScaledVector(o, -0.55).addScaledVector(t, -facing).normalize();
    const right = new THREE.Vector3().crossVectors(up, n).normalize();
    const base = new THREE.Vector3(row.x, row.y, row.z);
    const c = base.clone().addScaledVector(up, bottom + hh);
    for (const side of [-1, 1]) obox(db, base.clone().addScaledVector(right, side * hw * 0.55).addScaledVector(up, (bottom + hh) / 2), 0.03, (bottom + hh) / 2, 0.03, right, up, n, 0, 1);
    obox(db, c.clone().addScaledVector(n, -0.03), hw + 0.01, hh + 0.01, 0.015, right, up, n, 0, 1);
    panel(buf(bufs, key), c, hw, hh, right, up, n);
  };

  for (const name of rs.chevrons ?? []) {
    const a = corner(name + 'a') ?? corner(name);
    const b = corner(name + 'b') ?? a;
    if (!a || !b) continue;
    const sgn: 1 | -1 = a.dir > 0 ? -1 : 1;
    const sA = a.sArcA + 2;
    const sB = b.sArcB - 2;
    const n = Math.max(3, Math.round((sB - sA) / 7));
    for (let i = 0; i <= n; i++) sign(a.dir > 0 ? 'chevL' : 'chevR', sA + ((sB - sA) * i) / n, sgn, 0.6, 0.5, 0.375, 1.05, 0.8);
  }
  for (const w of rs.warn ?? []) {
    const c = corner(w.corner + 'a') ?? corner(w.corner);
    if (!c) continue;
    const sgn: 1 | -1 = c.dir > 0 ? -1 : 1;
    sign('warn', c.sStart - w.dist, sgn, 1.1, 0.48, 0.46, 1.55, 0.95);
  }
  for (const name of rs.mirrors ?? []) {
    const a = corner(name + 'a') ?? corner(name);
    if (!a) continue;
    const sgn: 1 | -1 = a.dir > 0 ? -1 : 1;
    const sApex = corner(name + 'a') ? a.sArcB : (a.sArcA + a.sArcB) / 2;
    const k = ((Math.round(rt.wrapS(sApex) / rt.spacing) % rt.count) + rt.count) % rt.count;
    const S = sgn > 0 ? rt.L : rt.R;
    const row = rowAtD(rt, sgn, k, S.wall[k] + 0.9);
    const o = new THREE.Vector3(row.ox, 0, row.oz);
    const t = new THREE.Vector3(row.tx, 0, row.tz);
    const base = new THREE.Vector3(row.x, row.y, row.z);
    const n = new THREE.Vector3().addScaledVector(o, -0.9).addScaledVector(t, -0.2).normalize();
    const right = new THREE.Vector3().crossVectors(up, n).normalize();
    // striped pole, two convex mirrors (one toward each approach)
    obox(wb, base.clone().addScaledVector(up, 1.45), 0.045, 1.45, 0.045, right, up, n, 0, 1);
    for (const hy of [0.4, 1.0, 1.6, 2.2]) obox(ob, base.clone().addScaledVector(up, hy), 0.048, 0.18, 0.048, right, up, n, 0, 1);
    for (const sx of [-1, 1]) {
      const nn = n.clone().addScaledVector(t, sx * 0.55).normalize();
      const c = base.clone().addScaledVector(up, 2.75).addScaledVector(t, sx * 0.04);
      disc(mb, c.clone().addScaledVector(nn, 0.03), nn, 0.36);
      disc(ob, c.clone(), nn, 0.42);
    }
  }
}

// ── TV cameras ───────────────────────────────────────────────────────────────────

function buildTvCameras(ctx: Ctx): { position: THREE.Vector3; s: number }[] {
  const rt = ctx.rt;
  const out: { position: THREE.Vector3; s: number }[] = [];
  const add = (s: number, d: number, h: number) => {
    const p = new THREE.Vector3();
    rt.pointAt(s, d, p);
    p.y += h;
    out.push({ position: p, s: rt.wrapS(s) });
  };
  // outside of the larger corners, looking at the apex
  const cs = rt.corners.filter((c) => c.angle > 0.35);
  const nCorner = Math.min(12, cs.length);
  for (let j = 0; j < nCorner; j++) {
    const c = cs[Math.floor((j * cs.length) / nCorner)];
    const sA = (c.sArcA + c.sArcB) / 2 - 20;
    const k = Math.round(rt.wrapS(sA) / rt.spacing) % rt.count;
    const sgn = c.dir > 0 ? -1 : 1;
    const S = sgn > 0 ? rt.L : rt.R;
    add(sA, sgn * (S.wall[k] + 6), 3.2);
  }
  // start straight cameras
  const k0 = 0;
  add(rt.length - 120, -(rt.R.wall[k0] + 9), 5);
  add(160, rt.L.wall[k0] + 6, 3.5);
  add(rt.length * 0.5, rt.R.wall[Math.floor(rt.count / 2)] * -1 - 5, 3);
  out.sort((a, b) => a.s - b.s);
  // long straights and fast sweepers between corner cameras: a camera covers ~220 m of road coming
  // toward it, so a gap much longer than that gets evenly spaced trackside cameras, on the side with more room
  const fill: number[] = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[i].s;
    const gap = rt.wrapS(out[(i + 1) % out.length].s - a) || rt.length;
    if (gap < 320) continue;
    const n = Math.ceil(gap / 260) - 1;
    for (let j = 1; j <= n; j++) fill.push(a + (gap * j) / (n + 1));
  }
  for (const sF of fill.slice(0, 24)) {
    const k = Math.round(rt.wrapS(sF) / rt.spacing) % rt.count;
    const left = rt.L.wall[k] >= rt.R.wall[k];
    add(sF, left ? rt.L.wall[k] + 6 : -(rt.R.wall[k] + 6), 3.4);
  }
  out.sort((a, b) => a.s - b.s);
  // keep each camera's view of its stretch of road clear of trees: corridors from the camera to
  // road points from ~240 m before it to 210 m past it (the stretch the TV director may use it for:
  // cars approaching, then leaving, see tvEnterDistance / tvMaxBehind in the camera rig)
  for (const cam of out) {
    const seg: number[] = [];
    let minX = cam.position.x, maxX = minX, minZ = cam.position.z, maxZ = minZ;
    const q = new THREE.Vector3();
    for (let ds = -240; ds <= 210; ds += 15) {
      rt.pointAt(rt.wrapS(cam.s + ds), 0, q);
      seg.push(q.x, q.z);
      minX = Math.min(minX, q.x);
      maxX = Math.max(maxX, q.x);
      minZ = Math.min(minZ, q.z);
      maxZ = Math.max(maxZ, q.z);
    }
    const cx = cam.position.x;
    const cz = cam.position.z;
    ctx.viewReserved.push((x, z, m) => {
      const r = 2.5 + m;
      if (x < minX - r || x > maxX + r || z < minZ - r || z > maxZ + r) return false;
      for (let i = 0; i < seg.length; i += 2) {
        const ex = seg[i] - cx;
        const ez = seg[i + 1] - cz;
        const t = Math.max(0, Math.min(1, ((x - cx) * ex + (z - cz) * ez) / (ex * ex + ez * ez || 1)));
        const dx = x - (cx + ex * t);
        const dz = z - (cz + ez * t);
        if (dx * dx + dz * dz < r * r) return true;
      }
      return false;
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

export function buildProps(ctx: Ctx, barrierMats: BarrierMaterials, roadMats: TrackMaterials): PropResult {
  const group = new THREE.Group();
  group.name = 'props';
  const sc = ctx.rt.def.scenery;
  const mats = makePropMats(ctx);
  const bufs: Bufs = new Map();
  const flags = makeFlags(ctx);
  const yellow = new THREE.CanvasTexture((() => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 40;
    const g = c.getContext('2d')!;
    g.fillStyle = '#f2c200';
    g.fillRect(0, 0, 64, 40);
    return c;
  })());
  yellow.colorSpace = THREE.SRGBColorSpace;
  ctx.disposables.push(yellow);

  for (const st of sc?.stands ?? []) buildStand(ctx, st, bufs, mats);
  buildPits(ctx, bufs, mats, roadMats);
  const setLights = buildGantry(ctx, bufs, mats, group);
  buildMarshals(ctx, bufs, flags, yellow);
  buildBoards(ctx, bufs, barrierMats);
  buildRoadSigns(ctx, bufs);
  buildBridges(ctx, bufs, barrierMats);
  buildLamps(ctx, group);
  buildBrakingBoards(ctx, group);

  // roof flags on stands
  const flagTex = [makeFlagTexture('xeno'), makeFlagTexture('teal'), makeFlagTexture('pink'), makeFlagTexture('checker')];
  ctx.disposables.push(...flagTex);
  let fi = 0;
  for (const st of sc?.stands ?? []) {
    if (st.roof === false) continue;
    const rt = ctx.rt;
    const sMid = markToIndex(ctx, st.at);
    const half = Math.round(st.length / rt.spacing / 2);
    const sgn: 1 | -1 = st.side === 'L' ? 1 : -1;
    const S = sgn > 0 ? rt.L : rt.R;
    for (let i = sMid - half + 10; i <= sMid + half - 10; i += 22) {
      const k = ((i % rt.count) + rt.count) % rt.count;
      const row = rowAtD(rt, sgn, k, S.wall[k] + st.gap + (st.rows - 1) * 0.84 + 0.5);
      const top = row.y + 0.8 + (st.rows - 1) * 0.46 + 6.4;
      flags.add(new THREE.Vector3(row.x, top + 0.3, row.z), Math.atan2(-row.tz, row.tx) + Math.PI * 0.5 + (fi % 2 ? Math.PI : 0), flagTex[fi++ % flagTex.length], 3.2, 2.0);
      // pole
      const pb = buf(bufs, 'dark');
      const ax = new THREE.Vector3(row.ox, 0, row.oz);
      obox(pb, new THREE.Vector3(row.x, top + 1.3, row.z), 0.05, 1.5, 0.05, ax, new THREE.Vector3(0, 1, 0), new THREE.Vector3(row.tx, 0, row.tz), 0, 1);
    }
  }
  group.add(flags.finish());

  // turn merged buffers into meshes
  const pitMat = makeRoadMaterial(ctx, 3.6, false);
  pitMat.polygonOffset = true;
  pitMat.polygonOffsetFactor = -8;
  pitMat.polygonOffsetUnits = -8;
  ctx.disposables.push(pitMat);
  const matFor: Record<string, THREE.Material> = {
    seat: mats.seat,
    concrete: barrierMats.concrete,
    crowd: mats.crowd,
    roof: mats.roof,
    teal: mats.teal,
    plain: mats.plain,
    facade: mats.facade,
    glass: mats.glass,
    tower: mats.tower,
    sign: mats.sign,
    white: mats.white,
    dark: mats.dark,
    orange: mats.orange,
    ads: barrierMats.ads,
    pitlane: pitMat,
    chevL: mats.chevL,
    chevR: mats.chevR,
    warn: mats.warn,
    mirror: mats.mirror,
  };
  for (const [key, b] of bufs) {
    if (b.empty) continue;
    const m = matFor[key];
    if (!m) continue;
    const mesh = new THREE.Mesh(b.build(), m);
    mesh.castShadow = key !== 'crowd' && key !== 'pitlane' && key !== 'ads' && key !== 'mirror';
    mesh.receiveShadow = true;
    mesh.name = `prop_${key}`;
    group.add(mesh);
  }
  return { group, setStartLights: setLights, tvCameras: buildTvCameras(ctx) };
}
