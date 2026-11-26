/**
 * The coast of an island circuit (headless; see `OceanDef`): how far a point of the map is inside the land, measured from the road.
 *
 * The land of such a circuit is the ground beside its road: as far as a width keyed along the lap, on each side. So the coast is a
 * distance field of the centreline, and it is baked once into a grid (a nearest-sample search per node) that the terrain function
 * reads with a bilinear fetch: the terrain is evaluated a few hundred thousand times while a scene is built.
 */
import type { OceanDef } from './types';

/** What the coast says about a point: `d` metres inside the land (negative: in the water), and the shore it belongs to. */
export interface CoastSample {
  d: number;
  /** How wide the land is there, from the centreline (m): a causeway is narrow. */
  width: number;
  /** How steeply the land rises from the waterline (rise/run). */
  rise: number;
  /** The sea bed off that shore: its depth far out (m) and how fast it gets there (rise/run). */
  bed: number;
  slope: number;
}

export type CoastFn = (x: number, z: number, out: CoastSample) => CoastSample;

export interface CoastInput {
  ocean: OceanDef;
  /** Centreline samples (0..N) and their headings. */
  X: Float64Array;
  Z: Float64Array;
  PHI: Float64Array;
  N: number;
  spacing: number;
  /** Per sample: the land's width on the left and on the right of the centreline (m), and the rise of the shore. */
  left: Float64Array;
  right: Float64Array;
  riseL: Float64Array;
  riseR: Float64Array;
}

const CELL = 16;

export function makeCoast(c: CoastInput): CoastFn {
  const { ocean, X, Z, PHI, N } = c;
  const step = Math.max(1, Math.round(8 / c.spacing));
  const sx: number[] = [];
  const sz: number[] = [];
  const si: number[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let widest = 0;
  for (let i = 0; i < N; i += step) {
    sx.push(X[i]);
    sz.push(Z[i]);
    si.push(i);
    if (X[i] < minX) minX = X[i];
    if (X[i] > maxX) maxX = X[i];
    if (Z[i] < minZ) minZ = Z[i];
    if (Z[i] > maxZ) maxZ = Z[i];
    widest = Math.max(widest, c.left[i], c.right[i]);
  }
  const pad = widest + 160;
  const x0 = minX - pad;
  const z0 = minZ - pad;
  const nx = Math.ceil((maxX + pad - x0) / CELL) + 1;
  const nz = Math.ceil((maxZ + pad - z0) / CELL) + 1;
  const D = new Float32Array(nx * nz);
  const W = new Float32Array(nx * nz);
  const RISE = new Float32Array(nx * nz);
  const SIDE = new Uint8Array(nx * nz);
  const ns = sx.length;
  for (let jz = 0; jz < nz; jz++) {
    const pz = z0 + jz * CELL;
    for (let jx = 0; jx < nx; jx++) {
      const px = x0 + jx * CELL;
      let best = Infinity;
      let bk = 0;
      for (let k = 0; k < ns; k++) {
        const dx = px - sx[k];
        const dz = pz - sz[k];
        const d2 = dx * dx + dz * dz;
        if (d2 < best) {
          best = d2;
          bk = k;
        }
      }
      const i = si[bk];
      // (the left of the road is (cos phi, -sin phi) on the map)
      const lat = (px - sx[bk]) * Math.cos(PHI[i]) - (pz - sz[bk]) * Math.sin(PHI[i]);
      const onLeft = lat >= 0;
      const width = onLeft ? c.left[i] : c.right[i];
      const k = jz * nx + jx;
      D[k] = width - Math.sqrt(best);
      W[k] = width;
      RISE[k] = onLeft ? c.riseL[i] : c.riseR[i];
      SIDE[k] = onLeft ? 0 : 1;
    }
  }
  const bedL = ocean.bed.left;
  const bedR = ocean.bed.right;
  const outer = ocean.outside === 'R' ? bedR : bedL;
  return (x, z, out) => {
    let fx = (x - x0) / CELL;
    let fz = (z - z0) / CELL;
    // the open sea beyond the map carries on from the map's edge, further out by as much as the point is beyond it; it belongs to the
    // outside of the circuit, whichever side of the road that is
    let far = 0;
    if (fx < 0 || fz < 0 || fx > nx - 1.001 || fz > nz - 1.001) {
      const cx = Math.min(nx - 1.001, Math.max(0, fx));
      const cz = Math.min(nz - 1.001, Math.max(0, fz));
      far = Math.hypot(fx - cx, fz - cz) * CELL;
      fx = cx;
      fz = cz;
    }
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const k = iz * nx + ix;
    out.d = (D[k] * (1 - tx) + D[k + 1] * tx) * (1 - tz) + (D[k + nx] * (1 - tx) + D[k + nx + 1] * tx) * tz;
    const kn = k + (tx > 0.5 ? 1 : 0) + (tz > 0.5 ? nx : 0);
    out.width = (W[k] * (1 - tx) + W[k + 1] * tx) * (1 - tz) + (W[k + nx] * (1 - tx) + W[k + nx + 1] * tx) * tz;
    out.rise = (RISE[k] * (1 - tx) + RISE[k + 1] * tx) * (1 - tz) + (RISE[k + nx] * (1 - tx) + RISE[k + nx + 1] * tx) * tz;
    const bed = far > 0 ? outer : SIDE[kn] ? bedR : bedL;
    out.d -= far;
    out.bed = bed[0];
    out.slope = bed[1];
    return out;
  };
}
