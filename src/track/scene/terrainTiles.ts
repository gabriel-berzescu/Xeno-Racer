/**
 * Terrain: an adaptive quadtree of height-field tiles around the circuit (128 m tiles near the road, up to
 * 1024 m tiles toward the mountains). Cells fully covered by the near-road strip meshes are left out, and each
 * tile has skirts so the seams between resolutions never show.
 */
import * as THREE from 'three';
import type { Ctx } from './ctx';
import { yieldFrame } from './ctx';
import type { TrackMaterials } from './materials';

interface Tile {
  x0: number;
  z0: number;
  size: number;
}

const ROOT = 1024;
/** How far beyond the circuit's bounds (m) the terrain tiles reach: past it there is no ground to see, or to hide the sun. */
export const REACH = 5000;

function cellsFor(size: number, res: number): number {
  const base = size <= 128 ? 28 : size >= 1024 ? 24 : 26;
  return Math.max(8, Math.round((base * res) / 2) * 2);
}

export async function buildTerrainTiles(ctx: Ctx, mats: TrackMaterials): Promise<THREE.Group> {
  const rt = ctx.rt;
  rt.ensureField();
  const group = new THREE.Group();
  group.name = 'terrain';
  const b = rt.bounds;
  // sparse list of centerline points for distance queries
  const pts: number[] = [];
  for (let i = 0; i < rt.count; i += 6) pts.push(rt.X[i], rt.Z[i]);
  const dist = (t: Tile): number => {
    const x1 = t.x0 + t.size;
    const z1 = t.z0 + t.size;
    let best = Infinity;
    for (let k = 0; k < pts.length; k += 2) {
      const dx = Math.max(t.x0 - pts[k], 0, pts[k] - x1);
      const dz = Math.max(t.z0 - pts[k + 1], 0, pts[k + 1] - z1);
      const d2 = dx * dx + dz * dz;
      if (d2 < best) best = d2;
    }
    return Math.sqrt(best);
  };
  const leaves: { t: Tile; d: number }[] = [];
  const visit = (t: Tile) => {
    const d = dist(t);
    const split = t.size > 128 && d < (t.size === 1024 ? 1000 : t.size === 512 ? 440 : 150);
    if (split) {
      const h = t.size / 2;
      visit({ x0: t.x0, z0: t.z0, size: h });
      visit({ x0: t.x0 + h, z0: t.z0, size: h });
      visit({ x0: t.x0, z0: t.z0 + h, size: h });
      visit({ x0: t.x0 + h, z0: t.z0 + h, size: h });
    } else leaves.push({ t, d });
  };
  const gx0 = Math.floor((b.minX - REACH) / ROOT) * ROOT;
  const gz0 = Math.floor((b.minZ - REACH) / ROOT) * ROOT;
  const gx1 = Math.ceil((b.maxX + REACH) / ROOT) * ROOT;
  const gz1 = Math.ceil((b.maxZ + REACH) / ROOT) * ROOT;
  for (let z = gz0; z < gz1; z += ROOT) for (let x = gx0; x < gx1; x += ROOT) visit({ x0: x, z0: z, size: ROOT });

  // Tiles are built individually, then merged per block of 4x4 (small) or 2x2 (large) same-size tiles: one draw call per block instead of
  // one per tile (the frustum-culling granularity stays coarse but the call count drops by ~5x).
  interface Group {
    size: number;
    parts: TileData[];
  }
  const groups = new Map<string, Group>();
  let n = 0;
  for (const { t, d } of leaves) {
    const td = buildTile(ctx, t, d);
    if (td) {
      const span = t.size * (t.size <= 256 ? 4 : 2);
      const key = `${t.size}_${Math.floor(t.x0 / span)}_${Math.floor(t.z0 / span)}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { size: t.size, parts: [] }));
      g.parts.push(td);
    }
    if (++n % 10 === 0) {
      ctx.progress(0.3 + 0.2 * (n / leaves.length), 'terrain');
      await yieldFrame();
    }
  }
  for (const [key, g] of groups) {
    const mesh = mergeTiles(g.parts, mats, !!ctx.urban);
    mesh.name = `tile_${g.size}_${key}`;
    group.add(mesh);
  }
  return group;
}

interface TileData {
  pos: Float32Array;
  nor: Float32Array;
  uv: Float32Array;
  col: Float32Array;
  urb: Float32Array;
  idx: number[];
  verts: number;
}

function mergeTiles(parts: TileData[], mats: TrackMaterials, urban: boolean): THREE.Mesh {
  let nv = 0;
  let ni = 0;
  for (const p of parts) {
    nv += p.verts;
    ni += p.idx.length;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const col = new Float32Array(nv * 3);
  const urb = new Float32Array(nv);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    pos.set(p.pos.subarray(0, p.verts * 3), vo * 3);
    nor.set(p.nor.subarray(0, p.verts * 3), vo * 3);
    uv.set(p.uv.subarray(0, p.verts * 2), vo * 2);
    col.set(p.col.subarray(0, p.verts * 3), vo * 3);
    urb.set(p.urb.subarray(0, p.verts), vo);
    for (let k = 0; k < p.idx.length; k++) idx[io + k] = p.idx[k] + vo;
    io += p.idx.length;
    vo += p.verts;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (urban) geo.setAttribute('aUrban', new THREE.BufferAttribute(urb, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  const mesh = new THREE.Mesh(geo, mats.terrain);
  mesh.receiveShadow = true;
  return mesh;
}

function buildTile(ctx: Ctx, t: Tile, dmin: number): TileData | null {
  const rt = ctx.rt;
  const cells = cellsFor(t.size, ctx.q.terrainRes);
  const c = t.size / cells;
  const nv = cells + 1;
  const ne = cells + 3; // heights with a one-vertex border for normals
  const H = new Float32Array(ne * ne);
  for (let jz = 0; jz < ne; jz++) {
    const z = t.z0 + (jz - 1) * c;
    for (let jx = 0; jx < ne; jx++) {
      const x = t.x0 + (jx - 1) * c;
      H[jz * ne + jx] = rt.heightFast(x, z);
    }
  }
  const useHoles = dmin < 120;
  let margin: Float32Array | null = null;
  let seg: Int32Array | null = null;
  if (useHoles) {
    margin = new Float32Array(nv * nv);
    seg = new Int32Array(nv * nv);
    for (let jz = 0; jz < nv; jz++) {
      for (let jx = 0; jx < nv; jx++) {
        margin[jz * nv + jx] = rt.stripMargin(t.x0 + jx * c, t.z0 + jz * c);
        seg[jz * nv + jx] = rt.lastSegment;
      }
    }
  }
  const N = rt.count;
  /** True when the four corner samples belong to the same stretch of road (not straddling the seam between two legs). */
  const sameLeg = (a: number, b: number, cc: number, d: number): boolean => {
    if (!seg) return true;
    const lim = 24 + Math.ceil(c * 2);
    for (const [p, q] of [[a, b], [a, cc], [a, d]] as const) {
      let df = seg[p] - seg[q];
      if (df < 0) df = -df;
      if (df > N / 2) df = N - df;
      if (df > lim) return false;
    }
    return true;
  };
  const skirt = Math.min(14, Math.max(1.5, t.size / 40));
  const nSkirt = 4 * cells;
  const total = nv * nv + nSkirt * 2;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const col = new Float32Array(total * 3).fill(1);
  const urb = new Float32Array(total);
  const idx: number[] = [];
  const setV = (k: number, x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    pos[k * 3] = x;
    pos[k * 3 + 1] = y;
    pos[k * 3 + 2] = z;
    nor[k * 3] = nx;
    nor[k * 3 + 1] = ny;
    nor[k * 3 + 2] = nz;
    uv[k * 2] = x;
    uv[k * 2 + 1] = z;
  };
  for (let jz = 0; jz < nv; jz++) {
    for (let jx = 0; jx < nv; jx++) {
      const hi = (jz + 1) * ne + (jx + 1);
      const hx = (H[hi - 1] - H[hi + 1]) / (2 * c);
      const hz = (H[hi - ne] - H[hi + ne]) / (2 * c);
      const inv = 1 / Math.sqrt(hx * hx + 1 + hz * hz);
      setV(jz * nv + jx, t.x0 + jx * c, H[hi], t.z0 + jz * c, hx * inv, inv, hz * inv);
      if (ctx.urban) urb[jz * nv + jx] = ctx.urban(t.x0 + jx * c, t.z0 + jz * c);
    }
  }
  // quads
  let quads = 0;
  for (let jz = 0; jz < cells; jz++) {
    for (let jx = 0; jx < cells; jx++) {
      const a = jz * nv + jx;
      const bq = a + 1;
      const cq = a + nv + 1;
      const dq = a + nv;
      // fully under the near-road strips: leave it out. Cells whose corners sit on different legs of the road (the medial
      // seam of a hairpin island, where two strips just meet) stay: a hairline of ground can fall between the strips there.
      if (margin && margin[a] < -0.01 && margin[bq] < -0.01 && margin[cq] < -0.01 && margin[dq] < -0.01 && sameLeg(a, bq, cq, dq)) continue;
      // +X right, +Z toward the viewer: CCW from above = (a, d, c) (b)
      idx.push(a, dq, cq, a, cq, bq);
      quads++;
    }
  }
  if (!quads) return null; // fully under the near-road strips
  // skirts along the four edges
  let sk = nv * nv;
  const edge = (indices: number[], flip: boolean) => {
    const base = sk;
    for (let k = 0; k < indices.length; k++) {
      const v = indices[k];
      setV(sk, pos[v * 3], pos[v * 3 + 1] - skirt, pos[v * 3 + 2], nor[v * 3], nor[v * 3 + 1], nor[v * 3 + 2]);
      urb[sk] = urb[v];
      sk++;
    }
    for (let k = 0; k + 1 < indices.length; k++) {
      const a = indices[k];
      const bq = indices[k + 1];
      const a2 = base + k;
      const b2 = base + k + 1;
      // both windings: the skirt must be visible whichever side the camera sees it from
      idx.push(a, bq, b2, a, b2, a2, a, b2, bq, a, a2, b2);
      void flip;
    }
  };
  const south: number[] = [];
  const north: number[] = [];
  const west: number[] = [];
  const east: number[] = [];
  for (let k = 0; k <= cells; k++) {
    south.push(k);
    north.push(cells * nv + k);
    west.push(k * nv);
    east.push(k * nv + cells);
  }
  edge(south, false);
  edge(north, true);
  edge(west, true);
  edge(east, false);
  return { pos, nor, uv, col, urb, idx, verts: sk };
}
