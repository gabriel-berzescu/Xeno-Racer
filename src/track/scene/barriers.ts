/**
 * Barriers standing exactly on the wall line: armco / guardrail, tyre walls, concrete walls with ad panels,
 * catch fencing. Extruded along the barrier line, ground-following, merged per chunk and material.
 */
import * as THREE from 'three';
import { BAR_CODE } from '../types';
import type { SideArrays, TrackRuntimeImpl } from '../runtime';
import type { Ctx } from './ctx';
import { GeoBuf } from './geom';
import { type AdAtlas, makeAdAtlas, makeFenceTexture, makeTireTextures } from './propTextures';

const CHUNK = 150;

export type MatKey = 'steel' | 'post' | 'tire' | 'concrete' | 'ads' | 'fence' | 'fencePost' | 'guard' | 'reflector' | 'standSeat' | 'crowd' | 'roof' | 'facade' | 'plain';

export interface BarrierMaterials {
  steel: THREE.MeshStandardMaterial;
  post: THREE.MeshStandardMaterial;
  guard: THREE.MeshStandardMaterial;
  reflector: THREE.MeshStandardMaterial;
  tire: THREE.MeshStandardMaterial;
  concrete: THREE.MeshStandardMaterial;
  ads: THREE.MeshStandardMaterial;
  fence: THREE.MeshStandardMaterial;
  fencePost: THREE.MeshStandardMaterial;
  atlas: AdAtlas;
}

export function makeBarrierMaterials(ctx: Ctx): BarrierMaterials {
  const steel = new THREE.MeshStandardMaterial({ color: 0xb4babe, metalness: 0.88, roughness: 0.42, side: THREE.DoubleSide, envMapIntensity: 1.1 });
  const post = new THREE.MeshStandardMaterial({ color: 0x777c80, metalness: 0.7, roughness: 0.55, envMapIntensity: 0.9 });
  const guard = new THREE.MeshStandardMaterial({ color: 0xc4c7c8, metalness: 0.85, roughness: 0.4, side: THREE.DoubleSide, envMapIntensity: 1.1 });
  const reflector = new THREE.MeshStandardMaterial({ color: 0xff8a1a, roughness: 0.4, emissive: 0xff7000, emissiveIntensity: 0.15 });
  const tt = makeTireTextures();
  tt.map.repeat.set(1, 1);
  const tire = new THREE.MeshStandardMaterial({ map: tt.map, bumpMap: tt.bump, bumpScale: 2.2, roughness: 0.92, metalness: 0, color: 0xffffff });
  const cw = ctx.tex.concreteWall;
  const cmap = cw.diff.clone();
  const cnor = cw.nor.clone();
  const crough = cw.rough.clone();
  for (const t of [cmap, cnor, crough]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / 3.2, 1 / 3.2);
    t.needsUpdate = true;
  }
  const concrete = new THREE.MeshStandardMaterial({ map: cmap, normalMap: cnor, roughnessMap: crough, roughness: 1, color: 0xf0efe9 });
  const atlas = makeAdAtlas();
  const ads = new THREE.MeshStandardMaterial({ map: atlas.map, roughness: 0.55, metalness: 0, emissive: 0xffffff, emissiveMap: atlas.map, emissiveIntensity: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const ft = makeFenceTexture();
  ft.repeat.set(1, 1);
  const fence = new THREE.MeshStandardMaterial({ map: ft, color: 0xcfd3d6, metalness: 0.6, roughness: 0.5, transparent: false, alphaTest: 0.35, side: THREE.DoubleSide });
  const fencePost = new THREE.MeshStandardMaterial({ color: 0x8c9296, metalness: 0.7, roughness: 0.5 });
  ctx.disposables.push(tt.map, tt.bump, cmap, cnor, crough, atlas.map, ft);
  ctx.nightGlow.push({ mat: ads, day: 0, night: 0.55 });
  return { steel, post, guard, reflector, tire, concrete, ads, fence, fencePost, atlas };
}

// ─────────────────────────────────────────────────────────────────────────────

export interface Row {
  s: number;
  /** base point at the wall line (ground) */
  x: number;
  y: number;
  z: number;
  /** outward horizontal unit vector */
  ox: number;
  oz: number;
  /** tangent (direction of travel) horizontal unit vector */
  tx: number;
  tz: number;
}

export function rowAtD(rt: TrackRuntimeImpl, sgn: 1 | -1, i: number, dOut: number): Row {
  const s = i * rt.spacing;
  const ox = sgn * rt.HLX[i];
  const oz = sgn * rt.HLZ[i];
  const x = rt.X[i] + ox * dOut;
  const z = rt.Z[i] + oz * dOut;
  const y = rt.heightSD(s, sgn * dOut);
  return { s, x, y, z, ox, oz, tx: rt.HTX[i], tz: rt.HTZ[i] };
}

function rowAt(rt: TrackRuntimeImpl, S: SideArrays, sgn: 1 | -1, i: number): Row {
  const s = i * rt.spacing;
  const wall = S.wall[i];
  const ox = sgn * rt.HLX[i];
  const oz = sgn * rt.HLZ[i];
  const x = rt.X[i] + ox * wall;
  const z = rt.Z[i] + oz * wall;
  const y = rt.heightSD(s, sgn * wall);
  return { s, x, y, z, ox, oz, tx: rt.HTX[i], tz: rt.HTZ[i] };
}

/** One profile segment: (q0,y0) -> (q1,y1), q measured outward from the front face (m), y above the ground. */
interface Seg {
  q0: number;
  y0: number;
  q1: number;
  y1: number;
  /** v coordinate range for UVs (metres of texture space) */
  v0?: number;
  v1?: number;
  /** override normal (outward component, up component); default from the segment direction */
  n?: [number, number];
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Extrude profile segments along the rows; each segment gets its own vertices and a flat profile normal. */
export function extrude(buf: GeoBuf, rows: Row[], segs: Seg[], uScale: number, vScale: number, flipNormals = false): void {
  for (const sg of segs) {
    // profile normal: perpendicular to the segment pointing toward the road/up side
    let nq: number;
    let ny: number;
    if (sg.n) {
      nq = sg.n[0];
      ny = sg.n[1];
    } else {
      const dq = sg.q1 - sg.q0;
      const dy = sg.y1 - sg.y0;
      const len = Math.hypot(dq, dy) || 1;
      // rotate (dq,dy) by +90 deg: (-dy, dq); the profile runs front-bottom -> top -> back, so this points outward/up-left
      nq = -dy / len;
      ny = dq / len;
    }
    if (flipNormals) {
      nq = -nq;
      ny = -ny;
    }
    const base = buf.count;
    const v0 = (sg.v0 ?? sg.y0) * vScale;
    const v1 = (sg.v1 ?? sg.y1) * vScale;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const u = (row.s - rows[0].s) * uScale;
      for (const [q, y, v] of [
        [sg.q0, sg.y0, v0],
        [sg.q1, sg.y1, v1],
      ] as const) {
        buf.v(row.x + row.ox * q, row.y + y, row.z + row.oz * q, row.ox * nq, ny, row.oz * nq, u, v);
      }
    }
    for (let r = 0; r + 1 < rows.length; r++) {
      const a = base + r * 2;
      const b = a + 1;
      const c = base + (r + 1) * 2 + 1;
      const d = base + (r + 1) * 2;
      // choose the winding whose geometric normal agrees with the intended normal
      const P = buf.pos;
      _a.set(P[a * 3], P[a * 3 + 1], P[a * 3 + 2]);
      _b.set(P[b * 3], P[b * 3 + 1], P[b * 3 + 2]);
      _c.set(P[d * 3], P[d * 3 + 1], P[d * 3 + 2]);
      _n.crossVectors(_b.sub(_a), _c.sub(_a));
      const rr = rows[r];
      const want = rr.ox * nq * _n.x + ny * _n.y + rr.oz * nq * _n.z;
      if (want >= 0) buf.quad(a, b, c, d);
      else buf.quad(a, d, c, b);
    }
  }
}

export function addBox(buf: GeoBuf, row: Row, q: number, y: number, hq: number, hy: number, ht: number): void {
  // box centred at outward offset q and height y; half sizes: hq (outward), hy (vertical), ht (along the tangent)
  const pos = (cq: number, cy: number, ct: number): [number, number, number] => [row.x + row.ox * (q + cq) + row.tx * ct, row.y + y + cy, row.z + row.oz * (q + cq) + row.tz * ct];
  const faceDefs: { n: [number, number, number]; v: [number, number, number][] }[] = [
    { n: [row.ox, 0, row.oz], v: [[1, -1, -1], [1, -1, 1], [1, 1, 1], [1, 1, -1]] },
    { n: [-row.ox, 0, -row.oz], v: [[-1, -1, 1], [-1, -1, -1], [-1, 1, -1], [-1, 1, 1]] },
    { n: [row.tx, 0, row.tz], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { n: [-row.tx, 0, -row.tz], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
    { n: [0, 1, 0], v: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
  ];
  for (const f of faceDefs) {
    const ids = f.v.map((c) => {
      const p = pos(c[0] * hq, c[1] * hy, c[2] * ht);
      return buf.v(p[0], p[1], p[2], f.n[0], f.n[1], f.n[2], 0, 0);
    });
    const P = buf.pos;
    _a.set(P[ids[0] * 3], P[ids[0] * 3 + 1], P[ids[0] * 3 + 2]);
    _b.set(P[ids[1] * 3], P[ids[1] * 3 + 1], P[ids[1] * 3 + 2]);
    _c.set(P[ids[2] * 3], P[ids[2] * 3 + 1], P[ids[2] * 3 + 2]);
    _n.crossVectors(_b.sub(_a), _c.sub(_a));
    if (_n.x * f.n[0] + _n.y * f.n[1] + _n.z * f.n[2] >= 0) buf.quad(ids[0], ids[1], ids[2], ids[3]);
    else buf.quad(ids[0], ids[3], ids[2], ids[1]);
  }
}

// ── builders per kind ─────────────────────────────────────────────────────────────

const W_PROFILE: Seg[] = [
  { q0: 0.0, y0: 0.43, q1: -0.05, y1: 0.5, n: [-0.7, 0.7] },
  { q0: -0.05, y0: 0.5, q1: 0.0, y1: 0.57, n: [-0.7, -0.7] },
  { q0: 0.0, y0: 0.57, q1: -0.05, y1: 0.64, n: [-0.7, 0.7] },
  { q0: -0.05, y0: 0.64, q1: 0.0, y1: 0.71, n: [-0.7, -0.7] },
];
// Note: the rail's front face is at q = -0.05 .. 0 (toward the road is negative q): the wall distance refers to q = -0.05

function armco(bufs: Map<MatKey, GeoBuf>, rows: Row[], guard: boolean): void {
  const rail = getBuf(bufs, guard ? 'guard' : 'steel');
  // shift so the most forward point of the rail sits exactly on the wall line
  const segs = W_PROFILE.map((s) => ({ ...s, q0: s.q0 + 0.05, q1: s.q1 + 0.05 }));
  extrude(rail, rows, segs, 1, 1);
  const post = rail;
  for (let r = 0; r < rows.length; r++) {
    const i = Math.round(rows[r].s);
    if (i % 4 === 0) addBox(post, rows[r], 0.2, 0.44, 0.045, 0.46, 0.05);
    if (guard && i % 8 === 0) addBox(getBuf(bufs, 'reflector'), rows[r], 0.0, 0.58, 0.012, 0.05, 0.1);
  }
}

function tires(bufs: Map<MatKey, GeoBuf>, rows: Row[]): void {
  const buf = getBuf(bufs, 'tire');
  const H = 1.5;
  // texture space: one tire = 0.66 m  => 4 tires per 2.64 m
  const segs: Seg[] = [
    { q0: 0, y0: -0.2, q1: 0, y1: H - 0.18, v0: -0.2, v1: H - 0.18, n: [-1, 0] },
    { q0: 0, y0: H - 0.18, q1: 0.2, y1: H, v0: H - 0.18, v1: H, n: [-0.6, 0.8] },
    { q0: 0.2, y0: H, q1: 0.9, y1: H, v0: H, v1: H, n: [0, 1] },
    { q0: 0.9, y0: H, q1: 1.1, y1: H - 0.25, v0: H, v1: H - 0.25, n: [0.6, 0.8] },
    { q0: 1.1, y0: H - 0.25, q1: 1.1, y1: -0.2, v0: 0, v1: 0, n: [1, 0] },
  ];
  extrude(buf, rows, segs, 1 / 2.64, 1 / 2.64, false);
}

let adCounter = 0;

function concreteWall(bufs: Map<MatKey, GeoBuf>, rows: Row[], atlas: AdAtlas, withAds: boolean, height = 1.08): void {
  const buf = getBuf(bufs, 'concrete');
  const H = height;
  const segs: Seg[] = [
    { q0: 0, y0: -0.25, q1: 0, y1: 0.0, v0: -0.25, v1: 0, n: [-1, 0] },
    { q0: 0, y0: 0.0, q1: 0.13, y1: 0.28, v0: 0, v1: 0.31, n: [-0.91, 0.41] },
    { q0: 0.13, y0: 0.28, q1: 0.19, y1: H - 0.08, v0: 0.31, v1: H, n: [-1, 0.07] },
    { q0: 0.19, y0: H - 0.08, q1: 0.28, y1: H, v0: H, v1: H + 0.09, n: [-0.7, 0.7] },
    { q0: 0.28, y0: H, q1: 0.42, y1: H, v0: H + 0.09, v1: H + 0.23, n: [0, 1] },
    { q0: 0.42, y0: H, q1: 0.42, y1: -0.25, v0: 0, v1: 0, n: [1, 0] },
  ];
  extrude(buf, rows, segs, 1, 1);
  if (!withAds) return;
  // ad panels on the vertical face, 3 rows (3 m) each, 0.75 m tall
  const ab = getBuf(bufs, 'ads');
  const cols = atlas.cols;
  const nr = atlas.rows;
  for (let r = 0; r + 3 < rows.length; r += 3) {
    const k = adCounter++ % atlas.count;
    // text must read left-to-right for a driver looking at the wall: on the right-hand wall u runs against s
    const rightSide = rows[0].ox * rows[0].tz - rows[0].oz * rows[0].tx < 0;
    const uA = (k % cols) / cols;
    const uB = (k % cols + 1) / cols;
    const u0 = rightSide ? uB : uA;
    const u1 = rightSide ? uA : uB;
    const v1 = 1 - Math.floor(k / cols) / nr;
    const v0 = 1 - (Math.floor(k / cols) + 1) / nr;
    const yb = 0.3;
    const yt = H - 0.1;
    const qb = 0.13 + (0.19 - 0.13) * ((yb - 0.28) / (H - 0.08 - 0.28)) - 0.012;
    const qt = 0.13 + (0.19 - 0.13) * ((yt - 0.28) / (H - 0.08 - 0.28)) - 0.012;
    const base = ab.count;
    for (let j = 0; j <= 3; j++) {
      const row = rows[r + j];
      const t = j / 3;
      for (const [q, y, v] of [
        [qb, yb, v0],
        [qt, yt, v1],
      ] as const) {
        ab.v(row.x + row.ox * q, row.y + y, row.z + row.oz * q, -row.ox * 0.99, 0.1, -row.oz * 0.99, u0 + (u1 - u0) * t, v);
      }
    }
    for (let j = 0; j < 3; j++) {
      const a = base + j * 2;
      const b = a + 1;
      const c = base + (j + 1) * 2 + 1;
      const d = base + (j + 1) * 2;
      const rr = rows[r + j];
      const P = ab.pos;
      _a.set(P[a * 3], P[a * 3 + 1], P[a * 3 + 2]);
      _b.set(P[b * 3], P[b * 3 + 1], P[b * 3 + 2]);
      _c.set(P[d * 3], P[d * 3 + 1], P[d * 3 + 2]);
      _n.crossVectors(_b.sub(_a), _c.sub(_a));
      if (-rr.ox * _n.x - rr.oz * _n.z >= 0) ab.quad(a, b, c, d);
      else ab.quad(a, d, c, b);
    }
  }
}

function catchFence(bufs: Map<MatKey, GeoBuf>, rows: Row[]): void {
  const mesh = getBuf(bufs, 'fence');
  const yb = 1.05;
  const yt = 5.4;
  const lean = -0.9; // top leans toward the road (negative q)
  const q0 = 0.3;
  const base = mesh.count;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const u = row.s;
    for (const [q, y, v] of [
      [q0, yb, 0],
      [q0 + lean, yt, (yt - yb) / 1.0],
    ] as const) {
      mesh.v(row.x + row.ox * q, row.y + y, row.z + row.oz * q, -row.ox, 0, -row.oz, u * 1.0, v);
    }
  }
  for (let r = 0; r + 1 < rows.length; r++) {
    const a = base + r * 2;
    mesh.quad(a, a + 2, a + 3, a + 1);
  }
  const pb = getBuf(bufs, 'fencePost');
  for (let r = 0; r < rows.length; r++) {
    const i = Math.round(rows[r].s);
    if (i % 5 !== 0) continue;
    // inclined post: two stacked boxes approximating the lean
    const row = rows[r];
    for (let k = 0; k < 4; k++) {
      const t = (k + 0.5) / 4;
      addBox(pb, row, q0 + 0.05 + lean * t, yb + (yt - yb) * t, 0.045, (yt - yb) / 8 + 0.02, 0.045);
    }
  }
}

export function getBuf(m: Map<MatKey, GeoBuf>, k: MatKey): GeoBuf {
  let b = m.get(k);
  if (!b) {
    b = new GeoBuf();
    m.set(k, b);
  }
  return b;
}

// ─────────────────────────────────────────────────────────────────────────────

export function buildBarriers(ctx: Ctx, mats: BarrierMaterials): THREE.Group {
  const rt = ctx.rt;
  const N = rt.count;
  const group = new THREE.Group();
  group.name = 'barriers';
  const order: MatKey[] = ['steel', 'guard', 'post', 'reflector', 'tire', 'concrete', 'ads', 'fence', 'fencePost'];
  for (const sgn of [1, -1] as const) {
    const S = sgn > 0 ? rt.L : rt.R;
    // contiguous runs of equal barrier kind
    const flags = ctx.rockFlags ? (sgn > 0 ? ctx.rockFlags.L : ctx.rockFlags.R) : null;
    const kindAt = (k: number) => (flags && flags[k] ? 0 : S.barrier[k]);
    let i = 0;
    while (i < N) {
      const kind = kindAt(i);
      let j = i;
      while (j + 1 < N && kindAt(j + 1) === kind) j++;
      if (kind === BAR_CODE.armco || kind === BAR_CODE.guardrail || kind === BAR_CODE.tires || kind === BAR_CODE.concrete || kind === BAR_CODE.fence) {
        for (let a = i; a <= j; a += CHUNK) {
          const b = Math.min(j, a + CHUNK);
          if (b <= a) continue;
          const rows: Row[] = [];
          for (let k = a; k <= b + 1 && k <= N; k++) rows.push(rowAt(rt, S, sgn, k));
          const bufs = new Map<MatKey, GeoBuf>();
          if (kind === BAR_CODE.armco) armco(bufs, rows, false);
          else if (kind === BAR_CODE.guardrail) armco(bufs, rows, true);
          else if (kind === BAR_CODE.tires) tires(bufs, rows);
          else if (kind === BAR_CODE.concrete) concreteWall(bufs, rows, mats.atlas, true);
          else if (kind === BAR_CODE.fence) {
            concreteWall(bufs, rows, mats.atlas, true, 1.0);
            catchFence(bufs, rows);
          }
          for (const key of order) {
            const buf = bufs.get(key);
            if (!buf || buf.empty) continue;
            const mesh = new THREE.Mesh(buf.build(), mats[key as keyof BarrierMaterials] as THREE.Material);
            mesh.castShadow = key !== 'ads' && key !== 'reflector' && key !== 'post' && key !== 'fencePost';
            mesh.receiveShadow = true;
            mesh.name = `bar_${key}_${sgn > 0 ? 'L' : 'R'}_${a}`;
            group.add(mesh);
          }
        }
      }
      i = j + 1;
    }
  }
  return group;
}
