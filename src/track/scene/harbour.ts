/**
 * The harbour: the sea, the quay walls and aprons along its edge, the piers and the east mole, bollards.
 * The shapes come from TerrainParams.sea (rectangles on the harbour map: the terrain sinks into water inside them and is levelled to
 * the quay around them), so the ground and the meshes always agree. Boats, cranes and the lighthouse are in harbourProps.ts.
 */
import * as THREE from 'three';
import type { MapRect } from '../types';
import { rectDistance } from '../terrain';
import type { Ctx } from './ctx';
import { makeWaterMaterial } from './water';

/** Map frame (east, north) to world. */
export const toWorld = (e: number, n: number): [number, number] => [-e, n];

export interface QuaySegment {
  /** World endpoints along the edge, the unit normal pointing into the water, and the segment's length (m). */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  nx: number;
  nz: number;
  len: number;
}

export interface HarbourResult {
  group: THREE.Group;
  /** The quay edges (water on the side the normal points to), for the boats and bollards. */
  quays: QuaySegment[];
}

const _col = new THREE.Color();

/** Push a quad (vertex indices in order around it) with the winding that faces (nx, ny, nz). */
function quadFacing(pos: number[], idx: number[], a: number, b: number, c: number, d: number, nx: number, ny: number, nz: number): void {
  const ax = pos[b * 3] - pos[a * 3];
  const ay = pos[b * 3 + 1] - pos[a * 3 + 1];
  const az = pos[b * 3 + 2] - pos[a * 3 + 2];
  const bx = pos[d * 3] - pos[a * 3];
  const by = pos[d * 3 + 1] - pos[a * 3 + 1];
  const bz = pos[d * 3 + 2] - pos[a * 3 + 2];
  const g = (ay * bz - az * by) * nx + (az * bx - ax * bz) * ny + (ax * by - ay * bx) * nz;
  if (g >= 0) idx.push(a, b, c, a, c, d);
  else idx.push(a, d, c, a, c, b);
}

export function buildHarbour(ctx: Ctx): HarbourResult | null {
  const rt = ctx.rt;
  const sea = rt.def.terrain.sea;
  if (!sea) return null;
  const group = new THREE.Group();
  group.name = 'harbour';
  const sd = rt.terrain.seaDistance;
  const level = sea.level;
  const quayY = sea.quay;

  // ── the sea ──────────────────────────────────────────────────────────────────────────────────
  // a grid over each water rectangle, fine near the shore and coarse offshore; the colour follows the distance to the shore
  {
    const shallow = new THREE.Color(0.1, 0.3, 0.3);
    const deep = new THREE.Color(0.012, 0.07, 0.1);
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    for (const r of sea.water) {
      // lines across (east) and along (north), denser near the rectangle's edges that face land
      const lines = (a: number, b: number): number[] => {
        const out: number[] = [a];
        const span = b - a;
        const step = (x: number): number => Math.max(6, Math.min(400, Math.abs(x) * 0.35));
        // from both ends inward
        let x = a;
        const head: number[] = [];
        while (x < a + span / 2) {
          x += step(x - a + 6);
          head.push(x);
        }
        x = b;
        const tail: number[] = [];
        while (x > a + span / 2) {
          x -= step(b - x + 6);
          tail.push(x);
        }
        return [a, ...head.filter((v) => v < a + span / 2), ...tail.filter((v) => v >= a + span / 2).reverse(), b].filter((v, i, arr) => i === 0 || v > arr[i - 1] + 0.5);
      };
      const ee = lines(r[0], r[2]);
      const nn = lines(r[1], r[3]);
      const base = pos.length / 3;
      for (const n of nn) {
        for (const e of ee) {
          const [x, z] = toWorld(e, n);
          pos.push(x, level, z);
          nor.push(0, 1, 0);
          uv.push(x, z);
          const dist = Math.max(0, -sd(x, z));
          _col.copy(shallow).lerp(deep, Math.sqrt(Math.min(1, dist / 160)));
          col.push(_col.r, _col.g, _col.b, 1);
        }
      }
      const w = ee.length;
      for (let j = 0; j + 1 < nn.length; j++) {
        for (let i = 0; i + 1 < ee.length; i++) {
          const a = base + j * w + i;
          quadFacing(pos, idx, a, a + 1, a + w + 1, a + w, 0, 1, 0);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mat = makeWaterMaterial(ctx, 31, 9.1);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'sea';
    mesh.renderOrder = 5;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    group.add(mesh);
    ctx.disposables.push(geo);
  }

  // ── quay edges: where a rectangle's edge has water on one side and land on the other ─────────────────
  const quays: QuaySegment[] = [];
  const b = rt.bounds;
  const near = (x: number, z: number): boolean => x > b.minX - 1800 && x < b.maxX + 1800 && z > b.minZ - 1800 && z < b.maxZ + 1800;
  const rects: MapRect[] = [...sea.water, ...sea.land];
  for (const r of rects) {
    const edges: [number, number, number, number, number, number][] = [
      [r[0], r[1], r[2], r[1], 0, -1],
      [r[0], r[3], r[2], r[3], 0, 1],
      [r[0], r[1], r[0], r[3], -1, 0],
      [r[2], r[1], r[2], r[3], 1, 0],
    ];
    for (const [e0, n0, e1, n1, ne, nn] of edges) {
      const len = Math.hypot(e1 - e0, n1 - n0);
      const steps = Math.max(1, Math.round(len / 6));
      let runStart = -1;
      const flush = (k: number): void => {
        if (runStart < 0) return;
        const ta = runStart / steps;
        const tb = k / steps;
        const [xa, za] = toWorld(e0 + (e1 - e0) * ta, n0 + (n1 - n0) * ta);
        const [xb, zb] = toWorld(e0 + (e1 - e0) * tb, n0 + (n1 - n0) * tb);
        // the normal points to the water side
        const q: QuaySegment = { x0: xa, z0: za, x1: xb, z1: zb, nx: 0, nz: 0, len: Math.hypot(xb - xa, zb - za) };
        quays.push(q);
        const [px, pz] = toWorld(e0 + (e1 - e0) * ((ta + tb) / 2), n0 + (n1 - n0) * ((ta + tb) / 2));
        const [ox, oz] = [-ne, nn];
        // the rectangle's outward direction in world is (-ne, nn); the water is on the side where sd < 0
        const out = sd(px + ox * 2, pz + oz * 2) < 0 ? 1 : -1;
        q.nx = ox * out;
        q.nz = oz * out;
        runStart = -1;
      };
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const [px, pz] = toWorld(e0 + (e1 - e0) * t, n0 + (n1 - n0) * t);
        const [ox, oz] = [-ne, nn];
        const a = sd(px + ox * 2, pz + oz * 2);
        const c = sd(px - ox * 2, pz - oz * 2);
        const isQuay = near(px, pz) && (a < 0) !== (c < 0);
        if (isQuay && runStart < 0) runStart = k;
        if (!isQuay && runStart >= 0) flush(k - 1);
      }
      flush(steps);
    }
  }

  // ── walls, coping and aprons ───────────────────────────────────────────────────────────────────────
  const wallPos: number[] = [];
  const wallNor: number[] = [];
  const wallUv: number[] = [];
  const wallIdx: number[] = [];
  const topPos: number[] = [];
  const topNor: number[] = [];
  const topUv: number[] = [];
  const topIdx: number[] = [];
  const copePos: number[] = [];
  const copeIdx: number[] = [];
  const apronDepth = 20;
  const yBot = level - 1.6;
  for (const q of quays) {
    const dx = (q.x1 - q.x0) / q.len;
    const dz = (q.z1 - q.z0) / q.len;
    const m = Math.max(1, Math.round(q.len / 8));
    // wall: a vertical sheet from the quay top to below the water, facing the water
    {
      const base = wallPos.length / 3;
      for (let k = 0; k <= m; k++) {
        const t = k / m;
        const x = q.x0 + (q.x1 - q.x0) * t;
        const z = q.z0 + (q.z1 - q.z0) * t;
        wallPos.push(x, quayY, z, x, yBot, z);
        wallNor.push(q.nx, 0, q.nz, q.nx, 0, q.nz);
        wallUv.push(t * q.len, quayY, t * q.len, yBot);
      }
      for (let k = 0; k < m; k++) {
        const a = base + k * 2;
        quadFacing(wallPos, wallIdx, a, a + 1, a + 3, a + 2, q.nx, 0, q.nz);
      }
    }
    // apron: a paved strip inland of the edge
    {
      const base = topPos.length / 3;
      for (let k = 0; k <= m; k++) {
        const t = k / m;
        const x = q.x0 + (q.x1 - q.x0) * t;
        const z = q.z0 + (q.z1 - q.z0) * t;
        topPos.push(x, quayY + 0.04, z, x - q.nx * apronDepth, quayY + 0.04, z - q.nz * apronDepth);
        topNor.push(0, 1, 0, 0, 1, 0);
        topUv.push(x, z, x - q.nx * apronDepth, z - q.nz * apronDepth);
      }
      for (let k = 0; k < m; k++) {
        const a = base + k * 2;
        quadFacing(topPos, topIdx, a, a + 1, a + 3, a + 2, 0, 1, 0);
      }
    }
    // coping: a lighter stone band along the edge
    {
      const base = copePos.length / 3;
      for (let k = 0; k <= m; k++) {
        const t = k / m;
        const x = q.x0 + (q.x1 - q.x0) * t;
        const z = q.z0 + (q.z1 - q.z0) * t;
        copePos.push(x + q.nx * 0.12, quayY + 0.09, z + q.nz * 0.12, x - q.nx * 0.7, quayY + 0.09, z - q.nz * 0.7);
      }
      for (let k = 0; k < m; k++) {
        const a = base + k * 2;
        quadFacing(copePos, copeIdx, a, a + 1, a + 3, a + 2, 0, 1, 0);
      }
    }
  }
  const mk = (pos: number[], nor: number[] | null, uv: number[] | null, idx: number[]): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (nor) g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    if (!nor) g.computeVertexNormals();
    g.computeBoundingSphere();
    ctx.disposables.push(g);
    return g;
  };
  const repeat = (t: THREE.Texture, k: number): THREE.Texture => {
    const c = t.clone();
    c.wrapS = c.wrapT = THREE.RepeatWrapping;
    c.repeat.set(1 / k, 1 / k);
    c.needsUpdate = true;
    ctx.disposables.push(c);
    return c;
  };
  const cw = ctx.tex.concreteWall;
  const wallMat = new THREE.MeshStandardMaterial({ map: repeat(cw.diff, 3.2), normalMap: repeat(cw.nor, 3.2), roughnessMap: repeat(cw.rough, 3.2), roughness: 1, color: 0x8b8a84, side: THREE.DoubleSide });
  const cf = ctx.tex.concreteFloor;
  const apronMat = new THREE.MeshStandardMaterial({ map: repeat(cf.diff, 4.2), normalMap: repeat(cf.nor, 4.2), roughnessMap: repeat(cf.rough, 4.2), roughness: 1, color: 0xb0aea6, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  const copeMat = new THREE.MeshStandardMaterial({ color: 0x9e9a90, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 });
  ctx.disposables.push(wallMat, apronMat, copeMat);
  if (wallIdx.length) {
    const wm = new THREE.Mesh(mk(wallPos, wallNor, wallUv, wallIdx), wallMat);
    wm.name = 'quay_wall';
    wm.castShadow = true;
    wm.receiveShadow = true;
    group.add(wm);
  }
  if (topIdx.length) {
    const am = new THREE.Mesh(mk(topPos, topNor, topUv, topIdx), apronMat);
    am.name = 'quay_apron';
    am.receiveShadow = true;
    group.add(am);
    const cm = new THREE.Mesh(mk(copePos, null, null, copeIdx), copeMat);
    cm.name = 'quay_coping';
    cm.receiveShadow = true;
    group.add(cm);
  }

  // piers: the land rectangles inside the water get a paved top (the terrain is levelled there, but coarsely)
  {
    const pos: number[] = [];
    const idx: number[] = [];
    const uv: number[] = [];
    for (const r of sea.land) {
      const [x0, z0] = toWorld(r[0], r[1]);
      const [x1, z1] = toWorld(r[2], r[3]);
      // only land that stands in the sea (its centre is closer to water than to anything else): skip the big shores
      if (Math.min(Math.abs(r[2] - r[0]), Math.abs(r[3] - r[1])) > 120) continue;
      const base = pos.length / 3;
      const y = quayY + 0.05;
      pos.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
      uv.push(x0, z0, x1, z0, x1, z1, x0, z1);
      quadFacing(pos, idx, base, base + 1, base + 2, base + 3, 0, 1, 0);
    }
    if (idx.length) {
      const nor: number[] = [];
      for (let i = 0; i < pos.length / 3; i++) nor.push(0, 1, 0);
      const pm = new THREE.Mesh(mk(pos, nor, uv, idx), apronMat);
      pm.name = 'pier_tops';
      pm.receiveShadow = true;
      group.add(pm);
    }
  }

  return { group, quays };
}

/** Helper for scenery on the map: distance to the sea (negative in the water). */
export function seaDistanceMap(sea: { water: MapRect[]; land: MapRect[] }, e: number, n: number): number {
  let w = Infinity;
  for (const r of sea.water) w = Math.min(w, rectDistance(e, n, r));
  let l = Infinity;
  for (const r of sea.land) l = Math.min(l, rectDistance(e, n, r));
  return Math.max(w, -l);
}
