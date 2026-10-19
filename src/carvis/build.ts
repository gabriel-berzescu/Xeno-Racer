/**
 * Geometry builder: blueprint -> interleaved vertex data. Pure numeric (runs in a Worker or inline).
 */
import type { CarVisualSpec, QualityLevel } from '../core/contracts';
import { BLUEPRINTS } from './bodies';
import { PART, ZONE_STRIDE, type Blueprint, type BlueprintInfo } from './blueprint';
import { VERTEX_STRIDE, partToData, type PartData } from './build-shared';
import { makeInterior, type InteriorData } from './interior';
import { PartBuilder } from './parts';
import { polygonize } from './polygonize';
import { buildCaliper, buildWheel, styleForBody, type WheelParams } from './wheels';

export { VERTEX_STRIDE, partToData };
export type { PartData };

export interface BodyData {
  info?: BlueprintInfo;
  /** interleaved [px py pz nx ny nz z0.. z15] */
  vertices: Float32Array;
  index: Uint32Array;
  /** triangles that touch a window region (for the transparent glass pass) */
  glassIndex: Uint32Array;
  /** triangles of the opaque pass (everything except those fully inside glass) */
  paintIndex: Uint32Array;
  /** baked per-vertex colours (far LOD only): paint = white, glass/trim dark, lamps coloured, AO applied */
  colors?: Float32Array;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  stats: { evals: number; vertices: number; triangles: number; bodyTriangles: number; bodyVertices: number; ms: number };
}

export const CELL_SIZE: Record<QualityLevel, number> = { low: 0.045, medium: 0.034, high: 0.027, ultra: 0.027 };
export const LOD2_CELL = 0.085;

/**
 * A 4.9 x 2 x 1.8 m slab-sided box has half as much surface again as the 4.3 m coupes the budgets (110k triangles near, 10k far) were set
 * for, and nearly all of it is flat: its meshes are a little coarser so the same budgets hold. (1 for every other body: exact.)
 */
export function cellScale(style: CarVisualSpec['style']): number {
  return style === 'suv' ? 1.13 : 1;
}

const AO_H = [0.035, 0.1, 0.2, 0.36];
const AO_W = [0.45, 0.3, 0.2, 0.1];

export interface BodyBuildOptions {
  cell: number;
  parts: boolean;
  /** bake per-vertex colours instead of relying on the zone shader (far LOD) */
  colors?: boolean;
}

export function buildBody(bp: Blueprint, spec: CarVisualSpec, o: BodyBuildOptions): BodyData {
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t0 = now();
  const m = polygonize({ min: bp.bounds.min, max: bp.bounds.max, cell: o.cell, field: bp.body, lipschitz: 1.35 });

  // ── drop the flat underbody (never seen) and compact the vertex list ─────────
  const yFlat = spec.rideHeight + 0.02;
  const nOld = m.stats.vertices;
  const newId = new Int32Array(nOld).fill(-1);
  const keptTris: number[] = [];
  const isBottom = (v: number): boolean => m.positions[v * 3 + 1] < yFlat && m.normals[v * 3 + 1] < -0.8;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t], b = m.indices[t + 1], c = m.indices[t + 2];
    if (isBottom(a) && isBottom(b) && isBottom(c)) continue;
    keptTris.push(a, b, c);
  }
  let nb = 0;
  for (let i = 0; i < keptTris.length; i++) {
    const v = keptTris[i];
    if (newId[v] < 0) newId[v] = nb++;
  }
  const px = new Float32Array(nb * 3), pn = new Float32Array(nb * 3);
  for (let v = 0; v < nOld; v++) {
    const nv = newId[v];
    if (nv < 0) continue;
    px[nv * 3] = m.positions[v * 3];
    px[nv * 3 + 1] = m.positions[v * 3 + 1];
    px[nv * 3 + 2] = m.positions[v * 3 + 2];
    pn[nv * 3] = m.normals[v * 3];
    pn[nv * 3 + 1] = m.normals[v * 3 + 1];
    pn[nv * 3 + 2] = m.normals[v * 3 + 2];
  }
  const bodyIdx = new Uint32Array(keptTris.length);
  for (let i = 0; i < keptTris.length; i++) bodyIdx[i] = newId[keptTris[i]];

  let parts: PartBuilder | null = null;
  if (o.parts && bp.parts) {
    parts = new PartBuilder();
    bp.parts(parts);
  }
  const np = parts ? parts.vertexCount : 0;
  const total = nb + np;
  const vertices = new Float32Array(total * VERTEX_STRIDE);
  const colors = o.colors ? new Float32Array(total * 3) : undefined;
  const zbuf = new Float32Array(ZONE_STRIDE);
  const body = bp.body;
  for (let i = 0; i < nb; i++) {
    const x = px[i * 3], y = px[i * 3 + 1], z = px[i * 3 + 2];
    const nx = pn[i * 3], ny = pn[i * 3 + 1], nz = pn[i * 3 + 2];
    zbuf.fill(1);
    bp.zones(x, y, z, nx, ny, nz, zbuf, 0);
    // ambient occlusion from the body field itself + ground proximity
    let occ = 0;
    for (let k = 0; k < AO_H.length; k++) {
      const h = AO_H[k];
      let d = body(x + nx * h, y + ny * h, z + nz * h);
      if (d < 0) d = 0;
      occ += (AO_W[k] * (h - d)) / h;
    }
    let ao = 1 - 1.25 * occ;
    const g = y + 0.4 * ny;
    ao *= 0.5 + 0.5 * Math.min(1, Math.max(0, g / 0.45));
    zbuf[12] = Math.min(1, Math.max(0.05, ao));
    zbuf[13] = PART.body;
    const ov = i * VERTEX_STRIDE;
    vertices[ov] = x;
    vertices[ov + 1] = y;
    vertices[ov + 2] = z;
    vertices[ov + 3] = nx;
    vertices[ov + 4] = ny;
    vertices[ov + 5] = nz;
    for (let k = 0; k < ZONE_STRIDE; k++) vertices[ov + 6 + k] = zbuf[k];
  }
  // smooth the baked AO over the mesh graph so it never shows triangle-sized banding
  {
    const nbr = new Float32Array(nb);
    const cnt = new Uint16Array(nb);
    for (let pass = 0; pass < 3; pass++) {
      nbr.fill(0);
      cnt.fill(0);
      for (let t = 0; t < bodyIdx.length; t += 3) {
        const a = bodyIdx[t], b = bodyIdx[t + 1], c = bodyIdx[t + 2];
        const aa = vertices[a * VERTEX_STRIDE + 18], ab = vertices[b * VERTEX_STRIDE + 18], ac = vertices[c * VERTEX_STRIDE + 18];
        nbr[a] += ab + ac; cnt[a] += 2;
        nbr[b] += aa + ac; cnt[b] += 2;
        nbr[c] += aa + ab; cnt[c] += 2;
      }
      for (let i = 0; i < nb; i++) {
        const ov = i * VERTEX_STRIDE + 18;
        if (cnt[i] > 0) vertices[ov] = 0.4 * vertices[ov] + 0.6 * (nbr[i] / cnt[i]);
      }
    }
  }
  const index = new Uint32Array(bodyIdx.length + (parts ? parts.idx.length : 0));
  index.set(bodyIdx);
  if (parts) {
    for (let i = 0; i < np; i++) {
      const ov = (nb + i) * VERTEX_STRIDE;
      vertices[ov] = parts.pos[i * 3];
      vertices[ov + 1] = parts.pos[i * 3 + 1];
      vertices[ov + 2] = parts.pos[i * 3 + 2];
      vertices[ov + 3] = parts.nor[i * 3];
      vertices[ov + 4] = parts.nor[i * 3 + 1];
      vertices[ov + 5] = parts.nor[i * 3 + 2];
      for (let k = 0; k < ZONE_STRIDE; k++) vertices[ov + 6 + k] = parts.zon[i * ZONE_STRIDE + k];
    }
    for (let i = 0; i < parts.idx.length; i++) index[bodyIdx.length + i] = parts.idx[i] + nb;
  }

  // far-LOD vertex colours baked from the zone fields
  if (colors) {
    for (let i = 0; i < nb; i++) {
      const ov = i * VERTEX_STRIDE + 6;
      let r = 1, g = 1, b = 1;
      const set = (mk: number, cr: number, cg: number, cb: number): void => {
        r = r * (1 - mk) + cr * mk;
        g = g * (1 - mk) + cg * mk;
        b = b * (1 - mk) + cb * mk;
      };
      const mask = (sd: number): number => Math.min(1, Math.max(0, 0.5 - sd / 0.03));
      set(mask(vertices[ov + 1]), 0.02, 0.02, 0.022);
      set(mask(vertices[ov + 2]), 0.06, 0.06, 0.065);
      set(mask(vertices[ov + 3]), 0.025, 0.025, 0.028);
      set(mask(vertices[ov + 4]), 0.12, 0.13, 0.15);
      set(mask(vertices[ov + 6]), 0.45, 0.02, 0.02);
      set(mask(vertices[ov]), 0.02, 0.025, 0.03);
      const ao = vertices[ov + 12];
      colors[i * 3] = r * (0.4 + 0.6 * ao);
      colors[i * 3 + 1] = g * (0.4 + 0.6 * ao);
      colors[i * 3 + 2] = b * (0.4 + 0.6 * ao);
    }
    for (let i = nb; i < total; i++) {
      colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 0.05;
    }
  }

  // window triangle classification (z0.x = window signed distance)
  const win = (v: number): number => vertices[v * VERTEX_STRIDE + 6];
  const glass: number[] = [];
  const paint: number[] = [];
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    const wa = win(a), wb = win(b), wc = win(c);
    const mn = Math.min(wa, wb, wc), mx = Math.max(wa, wb, wc);
    if (mn < 0.012) glass.push(a, b, c);
    if (!(mx < -0.006)) paint.push(a, b, c);
  }
  return {
    vertices,
    index,
    glassIndex: new Uint32Array(glass),
    paintIndex: new Uint32Array(paint),
    colors,
    bounds: bp.bounds,
    info: bp.info,
    stats: { evals: m.stats.evals, vertices: total, triangles: index.length / 3, bodyTriangles: bodyIdx.length / 3, bodyVertices: nb, ms: now() - t0 },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Whole-car data set (what the worker returns)
// ─────────────────────────────────────────────────────────────────────────────

export interface WheelData {
  front: PartData;
  rear: PartData;
  caliperFront: PartData;
  caliperRear: PartData;
}

export interface CarData {
  /** player / close-up */
  lod0: BodyData;
  /** AI, near */
  lod1: BodyData;
  /** far */
  lod2: BodyData;
  wheels0: WheelData;
  wheels1: WheelData;
  interior: InteriorData;
}

export function buildWheels(spec: CarVisualSpec, quality: QualityLevel): WheelData {
  const style = styleForBody(spec.style);
  const mk = (R: number, W: number, rimR: number): WheelParams => ({ R, W, rimR, style, quality });
  const pf = mk(spec.wheelRadiusFront, spec.tireWidthFront, spec.rimRadiusFront);
  const pr = mk(spec.wheelRadiusRear, spec.tireWidthRear, spec.rimRadiusRear);
  const same = pf.R === pr.R && pf.W === pr.W && pf.rimR === pr.rimR;
  const front = partToData(buildWheel(pf));
  const rear = same ? front : partToData(buildWheel(pr));
  const caliperFront = partToData(buildCaliper(pf, true));
  const caliperRear = partToData(buildCaliper(pr, false));
  return { front, rear, caliperFront, caliperRear };
}

export async function buildCarData(spec: CarVisualSpec, quality: QualityLevel, cellOverride?: number): Promise<CarData> {
  const bp = BLUEPRINTS[spec.style](spec);
  const k = cellScale(spec.style);
  const cell0 = (cellOverride ?? CELL_SIZE[quality]) * k;
  const lod0 = buildBody(bp, spec, { cell: cell0, parts: true });
  const lod1 = buildBody(bp, spec, { cell: Math.max(cell0 * 1.3, 0.036), parts: true });
  const lod2 = buildBody(bp, spec, { cell: LOD2_CELL * k, parts: false, colors: true });
  const wheels0 = buildWheels(spec, quality);
  const wheels1 = buildWheels(spec, 'low');
  const interior = makeInterior(spec, quality);
  return { lod0, lod1, lod2, wheels0, wheels1, interior };
}
