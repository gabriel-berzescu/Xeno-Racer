/**
 * What every kind of city shares (the harbour town of city.ts, the megacity of megacity.ts): the grid its lots are kept in, so that a
 * footprint can ask whether it overlaps one already placed, and the buildings as the TV director sees them.
 */
import type * as THREE from 'three';

export type Pt = [number, number];

/** Do two convex quads overlap (separating axis test, with a margin)? */
export function quadsOverlap(a: Pt[], b: Pt[], margin: number): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      let nx = -(q[1] - p[1]);
      let nz = q[0] - p[0];
      const l = Math.hypot(nx, nz) || 1;
      nx /= l;
      nz /= l;
      let minA = Infinity;
      let maxA = -Infinity;
      let minB = Infinity;
      let maxB = -Infinity;
      for (const c of a) {
        const d = c[0] * nx + c[1] * nz;
        if (d < minA) minA = d;
        if (d > maxA) maxA = d;
      }
      for (const c of b) {
        const d = c[0] * nx + c[1] * nz;
        if (d < minB) minB = d;
        if (d > maxB) maxB = d;
      }
      if (maxA + margin < minB || maxB + margin < minA) return false;
    }
  }
  return true;
}

export class LotGrid<T extends { quad: Pt[] }> {
  private readonly cell = 32;
  private readonly map = new Map<number, number[]>();
  readonly lots: T[] = [];
  private key(ix: number, iz: number): number {
    return ix * 100003 + iz;
  }
  add(lot: T): void {
    const id = this.lots.length;
    this.lots.push(lot);
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const [x, z] of lot.quad) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    for (let ix = Math.floor(x0 / this.cell); ix <= Math.floor(x1 / this.cell); ix++) {
      for (let iz = Math.floor(z0 / this.cell); iz <= Math.floor(z1 / this.cell); iz++) {
        const k = this.key(ix, iz);
        const a = this.map.get(k);
        if (a) a.push(id);
        else this.map.set(k, [id]);
      }
    }
  }
  overlaps(q: Pt[], margin: number): boolean {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const [x, z] of q) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    const seen = new Set<number>();
    for (let ix = Math.floor((x0 - margin) / this.cell); ix <= Math.floor((x1 + margin) / this.cell); ix++) {
      for (let iz = Math.floor((z0 - margin) / this.cell); iz <= Math.floor((z1 + margin) / this.cell); iz++) {
        const a = this.map.get(this.key(ix, iz));
        if (!a) continue;
        for (const id of a) {
          if (seen.has(id)) continue;
          seen.add(id);
          if (quadsOverlap(q, this.lots[id].quad, margin)) return true;
        }
      }
    }
    return false;
  }
  /** Is (x, z) within `margin` (up to one cell) of a lot's footprint? (The bounding circle of each lot, in the cells around the point.) */
  near(x: number, z: number, margin: number): boolean {
    const ix = Math.floor(x / this.cell);
    const iz = Math.floor(z / this.cell);
    for (let jx = ix - 1; jx <= ix + 1; jx++) {
      for (let jz = iz - 1; jz <= iz + 1; jz++) {
        const a = this.map.get(this.key(jx, jz));
        if (!a) continue;
        for (const id of a) {
          const c = this.circle(id);
          if (Math.hypot(x - c[0], z - c[1]) < c[2] + margin) return true;
        }
      }
    }
    return false;
  }
  private readonly circles = new Map<number, [number, number, number]>();
  private circle(id: number): [number, number, number] {
    let c = this.circles.get(id);
    if (!c) {
      const q = this.lots[id].quad;
      let cx = 0;
      let cz = 0;
      for (const p of q) {
        cx += p[0] / q.length;
        cz += p[1] / q.length;
      }
      let r = 0;
      for (const p of q) r = Math.max(r, Math.hypot(p[0] - cx, p[1] - cz));
      c = [cx, cz, r];
      this.circles.set(id, c);
    }
    return c;
  }
}

export interface CityResult {
  group: THREE.Group;
  /** Every building as a TV-camera occluder (see `OCC_STRIDE`). */
  occluders: Float32Array;
}

/**
 * A building as the TV director sees it: centre x, z and radius on the map, roof height, then the four corners of its footprint
 * (x, z each) pulled 0.6 m in, so that a line of sight that only grazes a corner still counts as clear.
 */
export const OCC_STRIDE = 12;

export class Occluders {
  private readonly v: number[] = [];
  add(quad: readonly (readonly [number, number])[], top: number, inset = 0.6): void {
    let cx = 0;
    let cz = 0;
    for (const [x, z] of quad) {
      cx += x / quad.length;
      cz += z / quad.length;
    }
    let r = 0;
    const pts: number[] = [];
    for (const [x, z] of quad) {
      const dx = x - cx;
      const dz = z - cz;
      const l = Math.hypot(dx, dz);
      const k = l > inset * 2 ? (l - inset) / l : 0.5;
      pts.push(cx + dx * k, cz + dz * k);
      r = Math.max(r, l * k);
    }
    if (pts.length !== 8 || !Number.isFinite(top)) return;
    this.v.push(cx, cz, r, top, ...pts);
  }
  build(): Float32Array {
    return new Float32Array(this.v);
  }
}

/** The occluders within `radius` of (x, z): what a TV camera there could ever have between itself and a car. */
export function occludersNear(all: Float32Array, x: number, z: number, radius: number): Float32Array {
  const keep: number[] = [];
  for (let o = 0; o + OCC_STRIDE <= all.length; o += OCC_STRIDE) {
    if (Math.hypot(all[o] - x, all[o + 1] - z) <= radius + all[o + 2]) for (let k = 0; k < OCC_STRIDE; k++) keep.push(all[o + k]);
  }
  return new Float32Array(keep);
}
