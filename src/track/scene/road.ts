/**
 * Road surface meshes: asphalt (chunked), curbs with the 3D ridge profile, runoff strips (gravel / concrete /
 * asphalt / grass) and the shoulder that joins the far terrain.
 */
import * as THREE from 'three';
import { smootherstep } from '../math';
import type { SideArrays, TrackRuntimeImpl } from '../runtime';
import { CURB_BASE, RIDGE_PERIOD, curbRamp } from '../types';
import type { Ctx } from './ctx';
import { GeoBuf, type SurfacePoint, samplePoint } from './geom';
import type { TrackMaterials } from './materials';

const CHUNK = 160;

/** Interpolate a per-sample array at s. */
export function lerpS(rt: TrackRuntimeImpl, arr: ArrayLike<number>, s: number): number {
  const f = rt.wrapS(s) / rt.spacing;
  let i = Math.floor(f);
  if (i >= rt.count) i = rt.count - 1;
  const t = f - i;
  return arr[i] * (1 - t) + arr[i + 1] * t;
}

/** Estimated racing line (lateral offset per sample): wide on entry, apex late, track out on exit. */
export function racingLine(rt: TrackRuntimeImpl): Float32Array {
  const N = rt.count;
  const L = rt.length;
  const keys: { s: number; v: number }[] = [];
  const cs = rt.corners;
  const amp = (c: { radius: number }, w: number) => Math.min(w * 0.62, 3.4) * Math.min(1, 80 / Math.max(40, c.radius) + 0.25);
  const wAt = (s: number) => lerpS(rt, rt.L.W, s);
  for (let k = 0; k < cs.length; k++) {
    const c = cs[k];
    const sApex = c.sArcA + (c.sArcB - c.sArcA) * 0.6;
    keys.push({ s: sApex, v: c.dir * amp(c, wAt(sApex)) });
    const n = cs[(k + 1) % cs.length];
    // middle of the straight between this corner and the next: outside of both
    let gap = n.sStart - c.sEnd;
    if (gap < 0) gap += L;
    const sMid = (c.sEnd + gap / 2) % L;
    const a = -c.dir * amp(c, wAt(sMid)) * 0.8;
    const b = -n.dir * amp(n, wAt(sMid)) * 0.8;
    keys.push({ s: sMid, v: (a + b) / 2 });
  }
  keys.sort((p, q) => p.s - q.s);
  const out = new Float32Array(N + 1);
  const ext: { s: number; v: number }[] = [];
  for (const off of [-1, 0, 1]) for (const k of keys) ext.push({ s: k.s + off * L, v: k.v });
  let j = 0;
  for (let i = 0; i <= N; i++) {
    const s = i * rt.spacing;
    while (j < ext.length - 2 && ext[j + 1].s <= s) j++;
    const a = ext[j];
    const b = ext[j + 1];
    const t = (s - a.s) / Math.max(1e-6, b.s - a.s);
    out[i] = a.v + (b.v - a.v) * smootherstep(0, 1, t);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

const _p: SurfacePoint = { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 };

function asphaltChunk(ctx: Ctx, mat: THREE.Material, i0: number, i1: number, line: Float32Array): THREE.Mesh {
  const rt = ctx.rt;
  const h = rt.spacing;
  const NA = 10;
  const buf = new GeoBuf();
  for (let i = i0; i <= i1; i++) {
    const s = i * h;
    const wl = rt.L.W[i];
    const wr = rt.R.W[i];
    for (let k = 0; k <= NA; k++) {
      const d = -wr + (wl + wr) * (k / NA);
      samplePoint(rt, s, d, _p);
      buf.v(_p.x, _p.y, _p.z, _p.nx, _p.ny, _p.nz, d, s);
      buf.track(s, d, wl, wr, line[i]);
    }
  }
  const rows = i1 - i0;
  for (let r = 0; r < rows; r++) {
    const a = r * (NA + 1);
    const b = (r + 1) * (NA + 1);
    for (let k = 0; k < NA; k++) buf.quad(a + k, b + k, b + k + 1, a + k + 1);
  }
  const mesh = new THREE.Mesh(buf.build(), mat);
  mesh.receiveShadow = true;
  mesh.name = `asphalt_${i0}`;
  return mesh;
}

// ── backing ribbon ─────────────────────────────────────────────────────────────

/**
 * A dark ribbon 0.3 m under the whole road corridor (asphalt, curbs, runoff strips). The meshes above it are cut from
 * different vertex sets, so hairline T-junction cracks between them would otherwise let the sky shine through as
 * sparkling pixels; this puts something dark and cheap behind them. It is never visible except through such a crack.
 */
function backingMesh(ctx: Ctx, mat: THREE.Material, i0: number, i1: number): THREE.Mesh {
  const rt = ctx.rt;
  const h = rt.spacing;
  const buf = new GeoBuf();
  const step = 2;
  const outerK = rt.xfadeEnd + 5 - 0.6;
  const cols = 9;
  const rows: number[] = [];
  for (let i = i0; i < i1; i += step) rows.push(i);
  rows.push(i1);
  const p = new THREE.Vector3();
  for (const i of rows) {
    const k = Math.min(rt.count - 1, i);
    const s = i * h;
    const dl = rt.L.wall[k] + outerK;
    const dr = rt.R.wall[k] + outerK;
    for (let c = 0; c < cols; c++) {
      const d = -dr + ((dl + dr) * c) / (cols - 1);
      rt.pointAt(s, d, p);
      buf.v(p.x, rt.heightSD(s, d) - 0.3, p.z, 0, 1, 0, 0, 0);
    }
  }
  for (let r = 0; r + 1 < rows.length; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const cc = a + cols + 1;
      const d = a + cols;
      buf.quad(a, d, cc, b);
      buf.quad(a, b, cc, d); // both windings: visible from above whatever the orientation
    }
  }
  const m = new THREE.Mesh(buf.build(), mat);
  m.name = `backing_${i0}`;
  m.castShadow = false;
  m.receiveShadow = false;
  return m;
}

// ── runoff strips ──────────────────────────────────────────────────────────────

type MatKey = 'terrainStrip' | 'gravel' | 'concrete' | 'runoffAsphalt';
const SURF_TO_MAT: MatKey[] = ['runoffAsphalt', 'concrete', 'concrete', 'terrainStrip', 'gravel', 'terrainStrip', 'terrainStrip'];
// SURF codes: 0 asphalt 1 curb 2 concrete 3 grass 4 gravel 5 sand 6 dirt

interface RowData {
  s: number;
  d: Float32Array;
  p: Float32Array; // x y z nx ny nz per lateral index
  w: Float32Array; // u of each lateral index (m beyond the asphalt edge)
  cell: Uint8Array; // surface code per cell
}

function sideStrips(ctx: Ctx, mats: TrackMaterials, i0: number, i1: number, sgn: 1 | -1, bufs: Map<MatKey, GeoBuf>): void {
  const rt = ctx.rt;
  const S: SideArrays = sgn > 0 ? rt.L : rt.R;
  const h = rt.spacing;
  let max1 = 0;
  let max2 = 0;
  for (let i = i0; i <= i1; i++) {
    max1 = Math.max(max1, S.b1W[i]);
    max2 = Math.max(max2, S.b2W[i]);
  }
  const n1 = max1 > 0.05 ? Math.max(2, Math.ceil(max1 / 1.25)) : 0;
  const n2 = max2 > 0.05 ? Math.max(2, Math.ceil(max2 / 1.6)) : 0;
  const outer = rt.xfadeEnd + 5;
  const nOut = Math.max(3, Math.ceil(outer / 2.2));
  const J = n1 + n2 + nOut; // cells
  const rows: RowData[] = [];
  for (let i = i0; i <= i1; i++) {
    const s = i * h;
    const w = S.W[i];
    const cw = S.curbW[i];
    const b1 = S.b1W[i];
    const b2 = S.b2W[i];
    const uWall = cw + b1 + b2;
    const row: RowData = { s, d: new Float32Array(J + 1), p: new Float32Array((J + 1) * 6), w: new Float32Array(J + 1), cell: new Uint8Array(J) };
    let j = 0;
    const setU = (u: number) => {
      row.w[j] = u;
      row.d[j] = sgn * (w + u);
      samplePoint(rt, s, row.d[j], _p);
      row.p.set([_p.x, _p.y, _p.z, _p.nx, _p.ny, _p.nz], j * 6);
      j++;
    };
    // band 1 (u from cw to cw + b1)
    for (let k = 0; k < n1; k++) setU(cw + (b1 * k) / n1);
    // band 2
    for (let k = 0; k < n2; k++) setU(cw + b1 + (b2 * k) / n2);
    if (n1 + n2 === 0) setU(cw);
    // beyond the wall: uniform cells
    for (let k = 0; k <= nOut; k++) setU(uWall + (outer * k) / nOut);
    // the band boundary vertex between band1 and band2 is the first vertex of band 2; between band 2 and outside the wall vertex
    const beyond = rt.def.paved ? 2 : rt.farSurf;
    for (let c = 0; c < J; c++) row.cell[c] = c < n1 ? S.b1S[i] : c < n1 + n2 ? S.b2S[i] : beyond;
    rows.push(row);
  }
  // vertex caches per buffer
  const caches = new Map<MatKey, Map<number, number>>();
  const vert = (key: MatKey, r: number, j: number, cellSurf: number): number => {
    let buf = bufs.get(key);
    if (!buf) {
      buf = new GeoBuf();
      bufs.set(key, buf);
    }
    let cache = caches.get(key);
    if (!cache) {
      cache = new Map();
      caches.set(key, cache);
    }
    const id = r * 256 + j;
    let v = cache.get(id);
    if (v !== undefined) return v;
    const row = rows[r];
    const o = j * 6;
    v = buf.v(row.p[o], row.p[o + 1], row.p[o + 2], row.p[o + 3], row.p[o + 4], row.p[o + 5], row.p[o], row.p[o + 2]);
    // shading: darker at the barrier foot, slightly lighter / dustier right at the asphalt edge
    const i = i0 + r;
    const uWall = S.curbW[i] + S.b1W[i] + S.b2W[i];
    const u = row.w[j];
    const toWall = uWall - u;
    let m = 1;
    if (toWall < 1.6 && toWall > -0.5) m *= 0.84 + 0.16 * smootherstep(-0.5, 1.6, toWall);
    if (cellSurf === 6) m *= 0.95;
    // sidewalks: a warmer, lighter stone than the runoff concrete, with the paving's own joints from the texture
    if (rt.def.paved && u > uWall - 0.01) buf.color(m * 1.1, m * 1.04, m * 0.92);
    else buf.color(m, m, m);
    if (key === 'terrainStrip') {
      buf.surface(cellSurf === 6 ? 1 : cellSurf === 5 ? 0.6 : cellSurf === 7 ? 0.5 : 0);
      // distance beyond the asphalt edge: drives the mown stripes in the terrain shader (grass bands only)
      buf.edge(rt.def.winter ? Math.max(0.01, u) : rt.def.mowing === false || cellSurf === 6 || cellSurf === 5 ? -1 : Math.max(0.01, u));
    }
    cache.set(id, v);
    return v;
  };
  for (let r = 0; r + 1 < rows.length; r++) {
    for (let c = 0; c < J; c++) {
      const surf = rows[r].cell[c];
      const key = SURF_TO_MAT[surf] ?? 'terrainStrip';
      if (key === 'terrainStrip' && rt.tunnelMask[i0 + r]) continue;
      const wA = Math.abs(rows[r].w[c + 1] - rows[r].w[c]);
      const wB = Math.abs(rows[r + 1].w[c + 1] - rows[r + 1].w[c]);
      if (wA < 0.01 && wB < 0.01) continue;
      const A = vert(key, r, c, surf);
      const B = vert(key, r, c + 1, surf);
      const C = vert(key, r + 1, c + 1, surf);
      const D = vert(key, r + 1, c, surf);
      const buf = bufs.get(key)!;
      // A,B inner->outer at row r; D,C at row r+1. Left side: d grows outward (like the asphalt): quad(A, D, C, B)
      if (sgn > 0) buf.quad(A, D, C, B);
      else buf.quad(A, B, C, D);
    }
  }
  void mats;
}

// ── curbs ──────────────────────────────────────────────────────────────────────

function curbMesh(ctx: Ctx, mats: TrackMaterials, i0: number, i1: number): THREE.Mesh | null {
  const rt = ctx.rt;
  const h = rt.spacing;
  const ds = RIDGE_PERIOD / 4;
  const buf = new GeoBuf();
  const s0 = i0 * h;
  const s1 = i1 * h;
  const kStart = Math.ceil(s0 / ds - 1e-6);
  const kEnd = Math.floor(s1 / ds + 1e-6);
  const tmp = new THREE.Vector3();
  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  for (const S of [rt.L, rt.R]) {
    const sgn = S === rt.L ? 1 : -1;
    // vertices at 4 lateral stations for each row; skip rows where the curb is absent
    let prev: { p: Float32Array; u: Float32Array } | null = null;
    let prevS = 0;
    let rowsInRun = 0;
    for (let k = kStart; k <= kEnd; k++) {
      const s = k * ds;
      const cw = lerpS(rt, S.curbW, s);
      if (cw < 0.06) {
        prev = null;
        rowsInRun = 0;
        continue;
      }
      const w = lerpS(rt, S.W, s);
      const rw = curbRamp(cw);
      const us = [0, rw, cw - rw, cw];
      const p = new Float32Array(12);
      for (let j = 0; j < 4; j++) {
        rt.pointAt(s, sgn * (w + us[j]), tmp);
        p[j * 3] = tmp.x;
        p[j * 3 + 1] = tmp.y;
        p[j * 3 + 2] = tmp.z;
      }
      if (prev) {
        for (let j = 0; j < 3; j++) {
          // quad between prev row and this row, lateral j..j+1; emit non-shared vertices with a flat normal
          const a = [prev.p[j * 3], prev.p[j * 3 + 1], prev.p[j * 3 + 2]];
          const b = [prev.p[(j + 1) * 3], prev.p[(j + 1) * 3 + 1], prev.p[(j + 1) * 3 + 2]];
          const c = [p[(j + 1) * 3], p[(j + 1) * 3 + 1], p[(j + 1) * 3 + 2]];
          const d = [p[j * 3], p[j * 3 + 1], p[j * 3 + 2]];
          va.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
          vb.set(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
          vc.crossVectors(va, vb);
          if (sgn > 0) vc.negate(); // keep the normal pointing up on both sides
          nrm.copy(vc).normalize();
          if (nrm.y < 0) nrm.negate();
          const uA = prev.u[j] / Math.max(0.05, prevCw(prev));
          const uB = prev.u[j + 1] / Math.max(0.05, prevCw(prev));
          const uC = us[j + 1] / cw;
          const uD = us[j] / cw;
          const i0v = buf.v(a[0], a[1], a[2], nrm.x, nrm.y, nrm.z, uA, prevS / 2.4);
          const i1v = buf.v(b[0], b[1], b[2], nrm.x, nrm.y, nrm.z, uB, prevS / 2.4);
          const i2v = buf.v(c[0], c[1], c[2], nrm.x, nrm.y, nrm.z, uC, s / 2.4);
          const i3v = buf.v(d[0], d[1], d[2], nrm.x, nrm.y, nrm.z, uD, s / 2.4);
          // winding so that the face normal is +Y
          const fn = new THREE.Vector3().crossVectors(vb, va); // d-a x b-a
          if (fn.y >= 0) buf.quad(i0v, i3v, i2v, i1v);
          else buf.quad(i0v, i1v, i2v, i3v);
        }
      }
      prev = { p, u: Float32Array.from(us) };
      prevS = s;
      rowsInRun++;
    }
  }
  void CURB_BASE;
  if (buf.empty) return null;
  const m = new THREE.Mesh(buf.build(), mats.curb);
  m.receiveShadow = true;
  m.name = `curb_${i0}`;
  return m;
}
function prevCw(prev: { u: Float32Array }): number {
  return prev.u[3];
}

// ─────────────────────────────────────────────────────────────────────────────

export function buildRoad(ctx: Ctx, mats: TrackMaterials): THREE.Group {
  const rt = ctx.rt;
  const N = rt.count;
  const group = new THREE.Group();
  group.name = 'road';
  const line = racingLine(rt);
  const backing = new THREE.MeshBasicMaterial({ color: 0x1c1f18 });
  ctx.disposables.push(backing);
  for (let i0 = 0; i0 < N; i0 += CHUNK) {
    const i1 = Math.min(N, i0 + CHUNK);
    group.add(asphaltChunk(ctx, mats.road, i0, i1, line));
    group.add(backingMesh(ctx, backing, i0, i1));
    const bufs = new Map<MatKey, GeoBuf>();
    sideStrips(ctx, mats, i0, i1, 1, bufs);
    sideStrips(ctx, mats, i0, i1, -1, bufs);
    for (const [key, buf] of bufs) {
      if (buf.empty) continue;
      const m = new THREE.Mesh(buf.build(), mats[key]);
      m.receiveShadow = true;
      m.name = `${key}_${i0}`;
      // the strips overlap the far terrain tiles slightly: win the depth test
      const mm = m.material as THREE.Material;
      void mm;
      group.add(m);
    }
    const curb = curbMesh(ctx, mats, i0, i1);
    if (curb) group.add(curb);
  }
  return group;
}
