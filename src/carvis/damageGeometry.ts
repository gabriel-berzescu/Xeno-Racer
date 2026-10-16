/**
 * The car body as the damage model needs to see it: where an obstacle really touches the sculpted surface, and where
 * the lamps are. Both are read off the polygonized mesh, so they follow any change to a body style.
 */
import type { CarVisualSpec } from '../core/contracts';
import type { DamageGeometry, GlassSpot, LampSpot, V3 } from '../core/damage';
import { VERTEX_STRIDE, type BodyData } from './build';

/** Vertical band of the body where crashes land: bumper to beltline, as a share of the roof height. */
export const DAMAGE_BAND: readonly [number, number] = [0.27, 0.64];

/** Offsets in a vertex record: position 0..2, normal 3..5, then the zone record (blueprint.ts). */
const Z_WINDOW = 6;
const Z_HEAD = 6 + 4;
const Z_TAIL = 6 + 6;
const Z_PART = 6 + 13;

/**
 * Surface point of the body that an obstacle pressing along -n touches, near p: the most protruding vertex in the damage
 * band within `reach` (plan distance) of p. A flat nose is a tie, broken by closeness to p, so a corner hit lands on the
 * corner and not mid-bumper.
 */
export function bodySurfacePoint(vertices: Float32Array, count: number, p: V3, n: V3, band: readonly [number, number], reach = 0.6): V3 {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r2 = reach * reach;
    let bestScore = -Infinity;
    let found = false;
    for (let i = 0; i < count; i++) {
      const o = i * VERTEX_STRIDE;
      const y = vertices[o + 1];
      if (y < band[0] || y > band[1]) continue;
      const dx = vertices[o] - p[0];
      const dz = vertices[o + 2] - p[2];
      if (dx * dx + dz * dz > r2) continue;
      const score = -(vertices[o] * n[0] + y * n[1] + vertices[o + 2] * n[2]);
      if (score > bestScore) {
        bestScore = score;
        found = true;
      }
    }
    if (!found) {
      reach *= 2.2;
      continue;
    }
    // near-ties: the closest to p
    let bd = Infinity;
    let bi = -1;
    for (let i = 0; i < count; i++) {
      const o = i * VERTEX_STRIDE;
      const y = vertices[o + 1];
      if (y < band[0] || y > band[1]) continue;
      const dx = vertices[o] - p[0];
      const dz = vertices[o + 2] - p[2];
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const score = -(vertices[o] * n[0] + y * n[1] + vertices[o + 2] * n[2]);
      if (score < bestScore - 0.035) continue;
      if (d2 < bd) {
        bd = d2;
        bi = i;
      }
    }
    if (bi >= 0) {
      const o = bi * VERTEX_STRIDE;
      return [vertices[o], vertices[o + 1], vertices[o + 2]];
    }
  }
  return [p[0], Math.min(Math.max(p[1], band[0]), band[1]), p[2]];
}

/** Mean position and extent of the vertices inside a lamp zone on one side of the car (zone signed distance < 0). */
function lampCentroid(vertices: Float32Array, count: number, field: number, side: 1 | -1): LampSpot | null {
  let sx = 0, sy = 0, sz = 0, n = 0;
  for (let i = 0; i < count; i++) {
    const o = i * VERTEX_STRIDE;
    if (vertices[o + field] >= 0 || vertices[o + Z_PART] > 0.5) continue;
    if (vertices[o] * side <= 0.05) continue;
    sx += vertices[o];
    sy += vertices[o + 1];
    sz += vertices[o + 2];
    n++;
  }
  if (n < 4) return null;
  const c: V3 = [sx / n, sy / n, sz / n];
  let r = 0;
  for (let i = 0; i < count; i++) {
    const o = i * VERTEX_STRIDE;
    if (vertices[o + field] >= 0 || vertices[o + Z_PART] > 0.5 || vertices[o] * side <= 0.05) continue;
    r = Math.max(r, Math.hypot(vertices[o] - c[0], vertices[o + 1] - c[1], vertices[o + 2] - c[2]));
  }
  return { c, r: Math.max(0.08, r) };
}

/** Lamps in the order the model expects: headL, headR, tailL, tailR. A missing one falls back to a spot on the nose or tail. */
export function findLamps(vertices: Float32Array, count: number, spec: CarVisualSpec): LampSpot[] {
  const zNose = spec.wheelbase / 2 + spec.frontOverhang;
  const zTail = -(spec.length - spec.wheelbase / 2 - spec.frontOverhang);
  const fallback = (side: number, z: number, y: number): LampSpot => ({ c: [side * (spec.width / 2 - 0.3), y, z], r: 0.2 });
  return [
    lampCentroid(vertices, count, Z_HEAD, 1) ?? fallback(1, zNose - 0.25, 0.65),
    lampCentroid(vertices, count, Z_HEAD, -1) ?? fallback(-1, zNose - 0.25, 0.65),
    lampCentroid(vertices, count, Z_TAIL, 1) ?? fallback(1, zTail + 0.1, 0.8),
    lampCentroid(vertices, count, Z_TAIL, -1) ?? fallback(-1, zTail + 0.1, 0.8),
  ];
}

/** The glass of one side of the car as points on it (x y z nx ny nz each) and the box round them. */
interface GlassPatch {
  pts: number[];
  min: V3;
  max: V3;
}

function newPatch(): GlassPatch {
  return { pts: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

/**
 * The windows, read off the mesh where the window field is inside the glass: front (the windscreen and the canopy ahead of the
 * driver), rear, left and right. Which one a vertex belongs to follows the way it faces; glass that faces up is shared out at
 * the middle of the cabin.
 */
export function findGlass(vertices: Float32Array, count: number): { front: GlassPatch; rear: GlassPatch; left: GlassPatch; right: GlassPatch } {
  const inside = (depth: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      const o = i * VERTEX_STRIDE;
      if (vertices[o + Z_WINDOW] < -depth && vertices[o + Z_PART] <= 0.5) out.push(o);
    }
    return out;
  };
  // well inside the glass, so a star of cracks never starts on the frame (a car with only a sliver of window falls back to the rim)
  let at = inside(0.03);
  if (at.length < 40) at = inside(0.008);
  let zMin = Infinity;
  let zSum = 0;
  let zN = 0;
  for (const o of at) {
    if (vertices[o + 5] >= 0.25) zMin = Math.min(zMin, vertices[o + 2]);
    zSum += vertices[o + 2];
    zN++;
  }
  // the split between front and rear for glass that faces up: just behind the windscreen's foot when there is one
  const zSplit = zMin < Infinity ? zMin - 0.15 : zN ? zSum / zN : 0;
  const g = { front: newPatch(), rear: newPatch(), left: newPatch(), right: newPatch() };
  for (const o of at) {
    const x = vertices[o], z = vertices[o + 2];
    const nx = vertices[o + 3], nz = vertices[o + 5];
    const patch = Math.abs(nx) >= 0.4 ? (x > 0 ? g.left : g.right) : nz >= 0.25 ? g.front : nz <= -0.25 ? g.rear : z >= zSplit ? g.front : g.rear;
    patch.pts.push(x, vertices[o + 1], z, nx, vertices[o + 4], nz);
    for (let k = 0; k < 3; k++) {
      patch.min[k] = Math.min(patch.min[k], vertices[o + k]);
      patch.max[k] = Math.max(patch.max[k], vertices[o + k]);
    }
  }
  return g;
}

const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);

/** The point of a patch nearest to (u, v) in the plane of axes a and b (0 x, 1 y, 2 z), as a spot on window `id`. */
function nearestOnPatch(patch: GlassPatch, id: number, a: number, b: number, u: number, v: number): GlassSpot | null {
  const pts = patch.pts;
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < pts.length; i += 6) {
    const d2 = (pts[i + a] - u) ** 2 + (pts[i + b] - v) ** 2;
    if (d2 < bd) {
      bd = d2;
      best = i;
    }
  }
  if (best < 0) return null;
  return { id, c: [pts[best], pts[best + 1], pts[best + 2]], n: [pts[best + 3], pts[best + 4], pts[best + 5]] };
}

/**
 * The windows a hit shakes. From the front (pushing back along the car) the windscreen cracks low down, on the side the hit was
 * on; from behind the rear glass does; beside the cabin the glass of that side cracks at the height of the hit along the car.
 * A hit at the nose that only brushes the side pushes nowhere near a window.
 */
export function glassPointsOf(glass: ReturnType<typeof findGlass>, p: V3, d: V3): GlassSpot[] {
  const out: GlassSpot[] = [];
  const ends: [GlassPatch, number, boolean][] = [[glass.front, 0, d[2] < -0.5], [glass.rear, 1, d[2] > 0.5]];
  for (const [patch, id, hit] of ends) {
    if (!hit || patch.pts.length === 0) continue;
    const x = clamp(p[0] * 0.6, patch.min[0] * 0.7, patch.max[0] * 0.7);
    const y = patch.min[1] + 0.3 * (patch.max[1] - patch.min[1]);
    const s = nearestOnPatch(patch, id, 0, 1, x, y);
    if (s) out.push(s);
  }
  if (Math.abs(d[0]) > 0.6) {
    const patch = d[0] < 0 ? glass.left : glass.right;
    const id = d[0] < 0 ? 2 : 3;
    if (patch.pts.length > 0 && p[2] > patch.min[2] - 0.4 && p[2] < patch.max[2] + 0.4) {
      const z = clamp(p[2], patch.min[2] + 0.12, patch.max[2] - 0.12);
      const y = patch.min[1] + 0.5 * (patch.max[1] - patch.min[1]);
      const s = nearestOnPatch(patch, id, 2, 1, z, y);
      if (s) out.push(s);
    }
  }
  return out;
}

/** Axis-aligned box round a part's vertices (min xyz, max xyz): here the interior, which the crushed sheet must not enter. */
export function partBounds(vertices: Float32Array): [V3, V3] {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += VERTEX_STRIDE) {
    for (let k = 0; k < 3; k++) {
      const v = vertices[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return [min, max];
}

/** Damage geometry for a body mesh. The scans run on first use (a car that is never hit never pays for them). */
export function makeDamageGeometry(body: BodyData, spec: CarVisualSpec): DamageGeometry {
  const count = body.stats.bodyVertices;
  const band: [number, number] = [DAMAGE_BAND[0] * spec.height, DAMAGE_BAND[1] * spec.height];
  let lamps: LampSpot[] | null = null;
  let glass: ReturnType<typeof findGlass> | null = null;
  return {
    surfacePoint: (p, n) => bodySurfacePoint(body.vertices, count, p, n, band),
    glassPoints: (p, d) => glassPointsOf((glass ??= findGlass(body.vertices, count)), p, d),
    get lamps(): readonly LampSpot[] {
      return (lamps ??= findLamps(body.vertices, count, spec));
    },
  };
}
