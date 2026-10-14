/**
 * Sparse surface-nets polygonizer for signed distance fields.
 *
 *  - an octree-style culling pass only evaluates the field near the surface (conservative Lipschitz
 *    bound), so a whole car costs ~10^5 evaluations instead of ~10^6;
 *  - vertices are the usual surface-nets cell centroids, then projected onto the true iso-surface
 *    with Newton steps, so the mesh has none of the stair-stepping of a raw voxel mesh;
 *  - normals come from the field gradient (tetrahedron stencil), which makes clearcoat reflections
 *    silky regardless of tessellation density.
 *
 * Pure numeric code, no three.js (runs in a Worker and in vitest).
 */
import type { FieldFn } from './sdf';

export interface PolygonizeOptions {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  /** Cell edge length (m). */
  cell: number;
  field: FieldFn;
  /** Safety factor on the Lipschitz bound used for culling (>= 1). */
  lipschitz?: number;
  /** Finite-difference step for normals (default 0.4 * cell). */
  gradStep?: number;
  /** Project vertices onto the surface (default true). */
  project?: boolean;
  /** Disable culling (tests only). */
  cull?: boolean;
}

export interface MeshOut {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  stats: { evals: number; cells: number; vertices: number; triangles: number };
}

const CX = [0, 1, 0, 1, 0, 1, 0, 1];
const CY = [0, 0, 1, 1, 0, 0, 1, 1];
const CZ = [0, 0, 0, 0, 1, 1, 1, 1];
// 12 cell edges as corner pairs
const EA = [0, 2, 4, 6, 0, 1, 4, 5, 0, 1, 2, 3];
const EB = [1, 3, 5, 7, 2, 3, 6, 7, 4, 5, 6, 7];

function ceilTo(v: number, m: number): number {
  return Math.max(m, Math.ceil(v / m) * m);
}

export function polygonize(o: PolygonizeOptions): MeshOut {
  const h = o.cell;
  const field = o.field;
  const lip = o.lipschitz ?? 1.25;
  const doCull = o.cull !== false;
  const doProject = o.project !== false;
  const gh = o.gradStep ?? h * 0.4;
  const T = 16;
  const nx = ceilTo((o.max[0] - o.min[0]) / h, T);
  const ny = ceilTo((o.max[1] - o.min[1]) / h, T);
  const nz = ceilTo((o.max[2] - o.min[2]) / h, T);
  const sx = nx + 1, sy = ny + 1, sz = nz + 1;
  const sxy = sx * sy;
  const ox = o.min[0], oy = o.min[1], oz = o.min[2];
  const vals = new Float32Array(sx * sy * sz);
  vals.fill(NaN);
  const active = new Uint8Array(nx * ny * nz);
  let evals = 0;

  const sample = (i: number, j: number, k: number): number => {
    const idx = i + sx * j + sxy * k;
    let v = vals[idx];
    if (v !== v) {
      v = field(ox + i * h, oy + j * h, oz + k * h);
      vals[idx] = v;
      evals++;
    }
    return v;
  };

  const cullR = 0.8660254 * h * lip;
  const visit = (i0: number, j0: number, k0: number, size: number): void => {
    const half = size >> 1;
    if (doCull) {
      const c = sample(i0 + half, j0 + half, k0 + half);
      if ((c < 0 ? -c : c) > size * cullR) return;
    }
    if (size === 2) {
      for (let dk = 0; dk <= 2; dk++) for (let dj = 0; dj <= 2; dj++) for (let di = 0; di <= 2; di++) sample(i0 + di, j0 + dj, k0 + dk);
      for (let dk = 0; dk < 2; dk++) for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) active[i0 + di + nx * (j0 + dj + ny * (k0 + dk))] = 1;
      return;
    }
    visit(i0, j0, k0, half);
    visit(i0 + half, j0, k0, half);
    visit(i0, j0 + half, k0, half);
    visit(i0 + half, j0 + half, k0, half);
    visit(i0, j0, k0 + half, half);
    visit(i0 + half, j0, k0 + half, half);
    visit(i0, j0 + half, k0 + half, half);
    visit(i0 + half, j0 + half, k0 + half, half);
  };
  for (let k = 0; k < nz; k += T) for (let j = 0; j < ny; j += T) for (let i = 0; i < nx; i += T) visit(i, j, k, T);

  // ── vertices ───────────────────────────────────────────────────────────────
  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  let vcap = 1 << 15;
  let pos = new Float32Array(vcap * 3);
  let nor = new Float32Array(vcap * 3);
  let vcount = 0;
  const cv = new Float64Array(8);
  let activeCells = 0;

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const rowBase = nx * (j + ny * k);
      for (let i = 0; i < nx; i++) {
        if (active[rowBase + i] === 0) continue;
        activeCells++;
        const base = i + sx * j + sxy * k;
        cv[0] = vals[base];
        cv[1] = vals[base + 1];
        cv[2] = vals[base + sx];
        cv[3] = vals[base + sx + 1];
        cv[4] = vals[base + sxy];
        cv[5] = vals[base + sxy + 1];
        cv[6] = vals[base + sxy + sx];
        cv[7] = vals[base + sxy + sx + 1];
        let mask = 0;
        for (let c = 0; c < 8; c++) if (cv[c] < 0) mask |= 1 << c;
        if (mask === 0 || mask === 255) continue;
        let sxp = 0, syp = 0, szp = 0, cnt = 0;
        for (let e = 0; e < 12; e++) {
          const a = EA[e], b = EB[e];
          const fa = cv[a], fb = cv[b];
          if (fa < 0 === fb < 0) continue;
          const t = fa / (fa - fb);
          sxp += CX[a] + (CX[b] - CX[a]) * t;
          syp += CY[a] + (CY[b] - CY[a]) * t;
          szp += CZ[a] + (CZ[b] - CZ[a]) * t;
          cnt++;
        }
        const lx = sxp / cnt, ly = syp / cnt, lz = szp / cnt;
        let px = ox + (i + lx) * h, py = oy + (j + ly) * h, pz = oz + (k + lz) * h;
        let nxv = 0, nyv = 0, nzv = 0;
        if (doProject) {
          // 1) exact f at the centroid + gradient of the trilinear interpolant
          const f0 = field(px, py, pz);
          evals++;
          const gx = ((1 - ly) * (1 - lz) * (cv[1] - cv[0]) + ly * (1 - lz) * (cv[3] - cv[2]) + (1 - ly) * lz * (cv[5] - cv[4]) + ly * lz * (cv[7] - cv[6])) / h;
          const gy = ((1 - lx) * (1 - lz) * (cv[2] - cv[0]) + lx * (1 - lz) * (cv[3] - cv[1]) + (1 - lx) * lz * (cv[6] - cv[4]) + lx * lz * (cv[7] - cv[5])) / h;
          const gz = ((1 - lx) * (1 - ly) * (cv[4] - cv[0]) + lx * (1 - ly) * (cv[5] - cv[1]) + (1 - lx) * ly * (cv[6] - cv[2]) + lx * ly * (cv[7] - cv[3])) / h;
          let g2 = gx * gx + gy * gy + gz * gz;
          let qx = px, qy = py, qz = pz;
          if (g2 > 0.12) {
            // keep the Newton step modest where the field is flat (gradient << 1)
            let s = f0 / g2;
            const lim0 = 0.6 * h / Math.sqrt(g2);
            if (s > lim0) s = lim0;
            else if (s < -lim0) s = -lim0;
            qx -= gx * s;
            qy -= gy * s;
            qz -= gz * s;
          }
          // 2) exact f + tetrahedron gradient at the projected point
          const f1 = field(qx, qy, qz);
          const fa = field(qx + gh, qy - gh, qz - gh);
          const fb = field(qx - gh, qy - gh, qz + gh);
          const fc = field(qx - gh, qy + gh, qz - gh);
          const fd = field(qx + gh, qy + gh, qz + gh);
          evals += 5;
          const tx = fa - fb - fc + fd;
          const ty = -fa - fb + fc + fd;
          const tz = -fa + fb - fc + fd;
          g2 = tx * tx + ty * ty + tz * tz;
          if (g2 > 1e-20) {
            const gl = Math.sqrt(g2);
            nxv = tx / gl;
            nyv = ty / gl;
            nzv = tz / gl;
            // Newton: true gradient magnitude is gl / (4*gh)
            const gm = gl / (4 * gh);
            if (gm > 0.35) {
              let s = f1 / gm;
              const lim1 = 0.6 * h;
              if (s > lim1) s = lim1;
              else if (s < -lim1) s = -lim1;
              qx -= nxv * s;
              qy -= nyv * s;
              qz -= nzv * s;
            }
          }
          // keep the vertex near its cell
          const dx = qx - px, dy = qy - py, dz = qz - pz;
          const dd = dx * dx + dy * dy + dz * dz;
          const lim = 0.9 * h;
          if (dd > lim * lim) {
            const s = lim / Math.sqrt(dd);
            qx = px + dx * s;
            qy = py + dy * s;
            qz = pz + dz * s;
          }
          px = qx;
          py = qy;
          pz = qz;
        } else {
          // central differences of the cell corners (cheap)
          nxv = (cv[1] + cv[3] + cv[5] + cv[7] - cv[0] - cv[2] - cv[4] - cv[6]) * 0.25;
          nyv = (cv[2] + cv[3] + cv[6] + cv[7] - cv[0] - cv[1] - cv[4] - cv[5]) * 0.25;
          nzv = (cv[4] + cv[5] + cv[6] + cv[7] - cv[0] - cv[1] - cv[2] - cv[3]) * 0.25;
          const gl = Math.sqrt(nxv * nxv + nyv * nyv + nzv * nzv) || 1;
          nxv /= gl;
          nyv /= gl;
          nzv /= gl;
        }
        if (vcount === vcap) {
          vcap *= 2;
          const p2 = new Float32Array(vcap * 3);
          p2.set(pos);
          pos = p2;
          const n2 = new Float32Array(vcap * 3);
          n2.set(nor);
          nor = n2;
        }
        pos[vcount * 3] = px;
        pos[vcount * 3 + 1] = py;
        pos[vcount * 3 + 2] = pz;
        nor[vcount * 3] = nxv;
        nor[vcount * 3 + 1] = nyv;
        nor[vcount * 3 + 2] = nzv;
        cellVert[rowBase + i] = vcount++;
      }
    }
  }

  // ── faces ──────────────────────────────────────────────────────────────────
  let icap = 1 << 16;
  let idx = new Uint32Array(icap);
  let icount = 0;
  const pushTri = (a: number, b: number, c: number): void => {
    if (icount + 3 > icap) {
      icap *= 2;
      const n2 = new Uint32Array(icap);
      n2.set(idx);
      idx = n2;
    }
    idx[icount++] = a;
    idx[icount++] = b;
    idx[icount++] = c;
  };
  const d2 = (a: number, b: number): number => {
    const dx = pos[a * 3] - pos[b * 3], dy = pos[a * 3 + 1] - pos[b * 3 + 1], dz = pos[a * 3 + 2] - pos[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };
  const quad = (a: number, b: number, c: number, d: number, flip: boolean): void => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) {
      const t = b;
      b = d;
      d = t;
    }
    // split along the shorter diagonal
    if (d2(a, c) <= d2(b, d)) {
      pushTri(a, b, c);
      pushTri(a, c, d);
    } else {
      pushTri(a, b, d);
      pushTri(b, c, d);
    }
  };

  for (let k = 1; k < nz; k++) {
    for (let j = 1; j < ny; j++) {
      const rowBase = nx * (j + ny * k);
      for (let i = 1; i < nx; i++) {
        const ci = rowBase + i;
        if (active[ci] === 0) continue;
        const base = i + sx * j + sxy * k;
        const v0 = vals[base];
        const in0 = v0 < 0;
        // x edge: corner (i,j,k) -> (i+1,j,k); cells around: (i,j-1,k-1),(i,j,k-1),(i,j,k),(i,j-1,k)
        if (in0 !== vals[base + 1] < 0) {
          quad(cellVert[ci - nx - nx * ny], cellVert[ci - nx * ny], cellVert[ci], cellVert[ci - nx], !in0);
        }
        // y edge: (i,j,k) -> (i,j+1,k); u=z, v=x: cells (i-1,j,k-1),(i-1,j,k)... order c(-1,-1),c(0,-1),c(0,0),c(-1,0) in (z,x)
        if (in0 !== vals[base + sx] < 0) {
          quad(cellVert[ci - 1 - nx * ny], cellVert[ci - 1], cellVert[ci], cellVert[ci - nx * ny], !in0);
        }
        // z edge: (i,j,k) -> (i,j,k+1); u=x, v=y: c(-1,-1),c(0,-1),c(0,0),c(-1,0) in (x,y)
        if (in0 !== vals[base + sxy] < 0) {
          quad(cellVert[ci - 1 - nx], cellVert[ci - nx], cellVert[ci], cellVert[ci - 1], !in0);
        }
      }
    }
  }

  return {
    positions: pos.slice(0, vcount * 3),
    normals: nor.slice(0, vcount * 3),
    indices: idx.slice(0, icount),
    stats: { evals, cells: activeCells, vertices: vcount, triangles: icount / 3 },
  };
}
