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
 *  - with `sharp` (off unless asked for) the vertices are placed by dual contouring instead: each one where the tangent planes of the
 *    surface at its cell's edge crossings meet, in the least-squares sense. A crease or a corner that crosses the grid at any angle
 *    then comes out as the straight line it is, where the cell centroids stepped along it from one face to the other.
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
  /**
   * Dual contouring (default false: surface nets, every mesh as it always was): the vertices sit on the creases and the corners of the
   * field instead of beside them. For a body with crisp edges that are meant to be seen.
   */
  sharp?: boolean;
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

  // ── dual contouring: where the surface crosses a grid edge, and its normal there (once per edge) ──
  const sharp = o.sharp === true;
  const edgeAt = new Map<number, number>();
  let ecap = 1 << 14;
  let edata = new Float32Array(ecap * 6);
  let ecount = 0;
  // (the normals are taken from four points under a millimetre round a point: wider, and more of them straddle a crease)
  const ge = h * 0.03;
  /** The crossing of the edge from node (i, j, k) along `axis`, whose ends have the values fa and fb: its index into `edata`. */
  const hermite = (i: number, j: number, k: number, axis: number, fa: number, fb: number): number => {
    const key = (i + sx * j + sxy * k) * 3 + axis;
    const known = edgeAt.get(key);
    if (known !== undefined) return known;
    const x0 = ox + i * h, y0 = oy + j * h, z0 = oz + k * h;
    const ax = axis === 0 ? h : 0, ay = axis === 1 ? h : 0, az = axis === 2 ? h : 0;
    let t = fa / (fa - fb);
    // one secant step on the field itself: a crease between the two samples bends it away from the straight line through them
    const f = field(x0 + ax * t, y0 + ay * t, z0 + az * t);
    if (f !== 0) {
      if (f < 0 === fa < 0) t += (1 - t) * (f / (f - fb));
      else t *= fa / (fa - f);
    }
    const px = x0 + ax * t, py = y0 + ay * t, pz = z0 + az * t;
    const ta = field(px + ge, py - ge, pz - ge);
    const tb = field(px - ge, py - ge, pz + ge);
    const tc = field(px - ge, py + ge, pz - ge);
    const td = field(px + ge, py + ge, pz + ge);
    evals += 5;
    let gx = ta - tb - tc + td, gy = -ta - tb + tc + td, gz = -ta + tb - tc + td;
    const gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (gl > 1e-12) {
      gx /= gl;
      gy /= gl;
      gz /= gl;
    } else {
      gx = axis === 0 ? 1 : 0;
      gy = axis === 1 ? 1 : 0;
      gz = axis === 2 ? 1 : 0;
    }
    if (ecount === ecap) {
      ecap *= 2;
      const e2 = new Float32Array(ecap * 6);
      e2.set(edata);
      edata = e2;
    }
    const e = ecount++;
    edata[e * 6] = px;
    edata[e * 6 + 1] = py;
    edata[e * 6 + 2] = pz;
    edata[e * 6 + 3] = gx;
    edata[e * 6 + 4] = gy;
    edata[e * 6 + 5] = gz;
    edgeAt.set(key, e);
    return e;
  };
  const cellEdges = new Int32Array(12);

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
        if (sharp) {
          // the crossings of this cell's edges, their mean, and the point nearest to all their tangent planes: with c the mean, the
          // least squares of n.(x - p) over the crossings, held to c by a small weight where the planes do not say (a flat patch
          // leaves two directions free, a crease one)
          let ne = 0;
          let cx = 0, cy = 0, cz = 0;
          for (let e = 0; e < 12; e++) {
            const a = EA[e], b = EB[e];
            const fa = cv[a], fb = cv[b];
            if (fa < 0 === fb < 0) continue;
            const id = hermite(i + CX[a], j + CY[a], k + CZ[a], e >> 2, fa, fb);
            cellEdges[ne++] = id;
            cx += edata[id * 6];
            cy += edata[id * 6 + 1];
            cz += edata[id * 6 + 2];
          }
          cx /= ne;
          cy /= ne;
          cz /= ne;
          let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0, b0 = 0, b1 = 0, b2 = 0;
          for (let q = 0; q < ne; q++) {
            const id = cellEdges[q] * 6;
            const ux = edata[id + 3], uy = edata[id + 4], uz = edata[id + 5];
            const r = ux * (edata[id] - cx) + uy * (edata[id + 1] - cy) + uz * (edata[id + 2] - cz);
            a00 += ux * ux;
            a01 += ux * uy;
            a02 += ux * uz;
            a11 += uy * uy;
            a12 += uy * uz;
            a22 += uz * uz;
            b0 += ux * r;
            b1 += uy * r;
            b2 += uz * r;
          }
          // Up to three rounds. A round solves for the point: twice at most, first with the planes all but free to find the line or the
          // point they meet in (the weight a 250th of theirs), and, if that lands outside the cell (normals that disagree where two
          // features meet), held firmly to the mean. Then it looks at the field there. A face that cuts a corner off the cell between
          // two samples crosses none of its edges, so no crossing saw it, and the point is on the other face's plane beyond the crease,
          // in the air or in the body: when the point is off the surface and the surface nearest to it faces a way none of the crossings
          // did, that face's tangent plane joins the others and the point is solved again, which puts it on the crease.
          const x0 = ox + i * h, y0 = oy + j * h, z0 = oz + k * h;
          let qx = cx, qy = cy, qz = cz;
          let f1 = 0;
          for (let round = 0; round < 3; round++) {
            for (let pass = 0; pass < 2; pass++) {
              const lam = (pass === 0 ? 0.004 : 0.2) * ne;
              const m00 = a00 + lam, m11 = a11 + lam, m22 = a22 + lam;
              const c00 = m11 * m22 - a12 * a12, c01 = a02 * a12 - a01 * m22, c02 = a01 * a12 - a02 * m11;
              const det = m00 * c00 + a01 * c01 + a02 * c02;
              if (det <= 1e-12) break;
              const c11 = m00 * m22 - a02 * a02, c12 = a01 * a02 - m00 * a12, c22 = m00 * m11 - a01 * a01;
              const tx = cx + (c00 * b0 + c01 * b1 + c02 * b2) / det;
              const ty = cy + (c01 * b0 + c11 * b1 + c12 * b2) / det;
              const tz = cz + (c02 * b0 + c12 * b1 + c22 * b2) / det;
              qx = tx;
              qy = ty;
              qz = tz;
              const slack = 0.02 * h;
              if (tx >= x0 - slack && tx <= x0 + h + slack && ty >= y0 - slack && ty <= y0 + h + slack && tz >= z0 - slack && tz <= z0 + h + slack) break;
            }
            // never outside its own cell (the quads between neighbours would fold)
            qx = qx < x0 ? x0 : qx > x0 + h ? x0 + h : qx;
            qy = qy < y0 ? y0 : qy > y0 + h ? y0 + h : qy;
            qz = qz < z0 ? z0 : qz > z0 + h ? z0 + h : qz;
            f1 = field(qx, qy, qz);
            evals++;
            if (round === 2) break;
            const sa = field(qx + ge, qy - ge, qz - ge);
            const sb = field(qx - ge, qy - ge, qz + ge);
            const sc = field(qx - ge, qy + ge, qz - ge);
            const sd = field(qx + ge, qy + ge, qz + ge);
            evals += 4;
            let wx = sa - sb - sc + sd, wy = -sa - sb + sc + sd, wz = -sa + sb - sc + sd;
            const wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
            const wm = wl / (4 * ge);
            if (wm < 0.35) break;
            const dist = f1 / wm;
            if ((dist < 0 ? -dist : dist) < 0.04 * h) break;
            wx /= wl;
            wy /= wl;
            wz /= wl;
            let seen = false;
            for (let q = 0; q < ne; q++) {
              const id = cellEdges[q] * 6;
              if (wx * edata[id + 3] + wy * edata[id + 4] + wz * edata[id + 5] > 0.94) {
                seen = true;
                break;
              }
            }
            if (seen) break;
            // the plane through the foot of the point on that face
            const wgt = 0.5 * ne;
            const r = wx * (qx - wx * dist - cx) + wy * (qy - wy * dist - cy) + wz * (qz - wz * dist - cz);
            a00 += wgt * wx * wx;
            a01 += wgt * wx * wy;
            a02 += wgt * wx * wz;
            a11 += wgt * wy * wy;
            a12 += wgt * wy * wz;
            a22 += wgt * wz * wz;
            b0 += wgt * wx * r;
            b1 += wgt * wy * r;
            b2 += wgt * wz * r;
          }
          // the normal there (from four points under a millimetre round it, not the centimetre the smooth meshes use: beside a crease the wider four
          // straddle it and tip a flat face's normal towards the next one), and one Newton step onto the surface
          const fa = field(qx + ge, qy - ge, qz - ge);
          const fb = field(qx - ge, qy - ge, qz + ge);
          const fc = field(qx - ge, qy + ge, qz - ge);
          const fd = field(qx + ge, qy + ge, qz + ge);
          evals += 4;
          const tx = fa - fb - fc + fd;
          const ty = -fa - fb + fc + fd;
          const tz = -fa + fb - fc + fd;
          const g2 = tx * tx + ty * ty + tz * tz;
          if (g2 > 1e-20) {
            const gl = Math.sqrt(g2);
            nxv = tx / gl;
            nyv = ty / gl;
            nzv = tz / gl;
            const gm = gl / (4 * ge);
            if (gm > 0.35) {
              let st = f1 / gm;
              const lim1 = 0.5 * h;
              if (st > lim1) st = lim1;
              else if (st < -lim1) st = -lim1;
              qx -= nxv * st;
              qy -= nyv * st;
              qz -= nzv * st;
            }
          }
          px = qx;
          py = qy;
          pz = qz;
        } else if (doProject) {
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

  /** A quad round a grid edge: as `quad`, but a bent one is split along its fold. */
  const emit = (a: number, b: number, c: number, d: number, flip: boolean): void => {
    if (!sharp) {
      quad(a, b, c, d, flip);
      return;
    }
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) {
      const t = b;
      b = d;
      d = t;
    }
    // A quad with two opposite corners on a crease and one on each face is bent along that diagonal: split along the other and both
    // triangles cut the corner off the crease, a tooth. The diagonal that is the crease lies in the surface, so the field at its
    // middle is nothing; the other's middle is in the air or in the body. Where both lie in the surface, the shorter, as ever.
    const fac = field((pos[a * 3] + pos[c * 3]) * 0.5, (pos[a * 3 + 1] + pos[c * 3 + 1]) * 0.5, (pos[a * 3 + 2] + pos[c * 3 + 2]) * 0.5);
    const fbd = field((pos[b * 3] + pos[d * 3]) * 0.5, (pos[b * 3 + 1] + pos[d * 3 + 1]) * 0.5, (pos[b * 3 + 2] + pos[d * 3 + 2]) * 0.5);
    evals += 2;
    const sag = (fac < 0 ? -fac : fac) - (fbd < 0 ? -fbd : fbd);
    const alongAC = sag < -0.02 * h ? true : sag > 0.02 * h ? false : d2(a, c) <= d2(b, d);
    if (alongAC) {
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
          emit(cellVert[ci - nx - nx * ny], cellVert[ci - nx * ny], cellVert[ci], cellVert[ci - nx], !in0);
        }
        // y edge: (i,j,k) -> (i,j+1,k); u=z, v=x: cells (i-1,j,k-1),(i-1,j,k)... order c(-1,-1),c(0,-1),c(0,0),c(-1,0) in (z,x)
        if (in0 !== vals[base + sx] < 0) {
          emit(cellVert[ci - 1 - nx * ny], cellVert[ci - 1], cellVert[ci], cellVert[ci - nx * ny], !in0);
        }
        // z edge: (i,j,k) -> (i,j,k+1); u=x, v=y: c(-1,-1),c(0,-1),c(0,0),c(-1,0) in (x,y)
        if (in0 !== vals[base + sxy] < 0) {
          emit(cellVert[ci - 1 - nx], cellVert[ci - nx], cellVert[ci], cellVert[ci - 1], !in0);
        }
      }
    }
  }
  /**
   * Dual contouring's hard edges. A vertex on a crease carries the normal of the fillet there, between the two faces, and a face shaded
   * from it to its own normal one cell away shows the mesh's diagonals as a saw-tooth along the crease. So the triangles round each
   * vertex are sorted into smoothing groups, as a modelling tool does: two that share an edge are in one group when their planes are
   * within 55 degrees of each other. A vertex whose triangles are all one group keeps the field's own normal (every vertex of a smooth
   * surface, and of a fillet of 4 cm or more at this cell size: a body keeps its edges either well over 55 degrees or rounder than that); one with several is copied, a copy to a group, each with the mean
   * normal of its group's triangles: a face is smooth up to its edge, and the edge is a line.
   */
  if (sharp) {
    const HARD_COS = 0.574;
    const nt = icount / 3;
    const tn = new Float32Array(nt * 3);
    for (let t = 0; t < nt; t++) {
      const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
      const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
      const wx = pos[c * 3] - pos[a * 3], wy = pos[c * 3 + 1] - pos[a * 3 + 1], wz = pos[c * 3 + 2] - pos[a * 3 + 2];
      let tx = uy * wz - uz * wy, ty = uz * wx - ux * wz, tz = ux * wy - uy * wx;
      // (the winding may run either way round: the triangle's normal is the one on the side of its corners' own)
      if (tx * (nor[a * 3] + nor[b * 3] + nor[c * 3]) + ty * (nor[a * 3 + 1] + nor[b * 3 + 1] + nor[c * 3 + 1]) + tz * (nor[a * 3 + 2] + nor[b * 3 + 2] + nor[c * 3 + 2]) < 0) {
        tx = -tx;
        ty = -ty;
        tz = -tz;
      }
      // (left at its length, twice the triangle's area: a group's mean is weighted by area)
      tn[t * 3] = tx;
      tn[t * 3 + 1] = ty;
      tn[t * 3 + 2] = tz;
    }
    // the triangles round each vertex
    const nv0 = vcount;
    const start = new Uint32Array(nv0 + 1);
    for (let q = 0; q < icount; q++) start[idx[q] + 1]++;
    for (let v = 0; v < nv0; v++) start[v + 1] += start[v];
    const fan = new Uint32Array(icount);
    const fill = start.slice(0, nv0);
    for (let q = 0; q < icount; q++) fan[fill[idx[q]]++] = q;
    const group = new Int32Array(32);
    const un = new Float32Array(32 * 3);
    const find = (q: number): number => group[q];
    for (let v = 0; v < nv0; v++) {
      const s0 = start[v], n = start[v + 1] - s0;
      if (n < 2 || n > 32) continue;
      // Sorted by their planes: all one group unless two of them are more than the angle apart, and then those two are the seeds of
      // two groups and every other joins the nearer; a group that still holds two as far apart is split again (a corner has three
      // faces). Sorting by which triangles share an edge would let one triangle that straddles a crease, where the mesh missed it,
      // join the two faces into one group.
      for (let q = 0; q < n; q++) {
        const tq = (fan[s0 + q] / 3) | 0;
        const l = Math.sqrt(tn[tq * 3] * tn[tq * 3] + tn[tq * 3 + 1] * tn[tq * 3 + 1] + tn[tq * 3 + 2] * tn[tq * 3 + 2]) || 1;
        un[q * 3] = tn[tq * 3] / l;
        un[q * 3 + 1] = tn[tq * 3 + 1] / l;
        un[q * 3 + 2] = tn[tq * 3 + 2] / l;
        group[q] = 0;
      }
      let groups = 1;
      for (let g = 0; g < groups && groups < 4; g++) {
        let bi = -1, bj = -1, bd = HARD_COS;
        for (let q = 0; q < n; q++) {
          if (group[q] !== g) continue;
          for (let r = q + 1; r < n; r++) {
            if (group[r] !== g) continue;
            const d = un[q * 3] * un[r * 3] + un[q * 3 + 1] * un[r * 3 + 1] + un[q * 3 + 2] * un[r * 3 + 2];
            if (d < bd) {
              bd = d;
              bi = q;
              bj = r;
            }
          }
        }
        if (bi < 0) continue;
        const ng = groups++;
        for (let q = 0; q < n; q++) {
          if (group[q] !== g) continue;
          const di = un[q * 3] * un[bi * 3] + un[q * 3 + 1] * un[bi * 3 + 1] + un[q * 3 + 2] * un[bi * 3 + 2];
          const dj = un[q * 3] * un[bj * 3] + un[q * 3 + 1] * un[bj * 3 + 1] + un[q * 3 + 2] * un[bj * 3 + 2];
          if (dj > di) group[q] = ng;
        }
        // (the group that was split is looked at again)
        g--;
      }
      if (groups < 2) {
        // One face. Its normal is the field's, taken from four points a centimetre round the vertex: beside a crease they straddle
        // it, and the vertex of a flat face is given a normal tipped towards the next one, a fringe along every edge on a glossy
        // paint. The mean plane of its own triangles knows nothing of the crease: where the two are more than 12 degrees apart,
        // that is the normal (a smooth surface's are within a few degrees of each other).
        let mx = 0, my = 0, mz = 0;
        for (let r = 0; r < n; r++) {
          const tr = (fan[s0 + r] / 3) | 0;
          mx += tn[tr * 3];
          my += tn[tr * 3 + 1];
          mz += tn[tr * 3 + 2];
        }
        const ml = Math.sqrt(mx * mx + my * my + mz * mz);
        if (ml > 1e-12 && nor[v * 3] * mx + nor[v * 3 + 1] * my + nor[v * 3 + 2] * mz < 0.978 * ml) {
          nor[v * 3] = mx / ml;
          nor[v * 3 + 1] = my / ml;
          nor[v * 3 + 2] = mz / ml;
        }
        continue;
      }
      // a copy to a group (the first group keeps the vertex itself), each with its triangles' mean normal
      for (let q = 0; q < groups; q++) {
        let mx = 0, my = 0, mz = 0;
        let gx = 0, gy = 0, gz = 0, gn = 0;
        for (let r = 0; r < n; r++) {
          if (find(r) !== q) continue;
          const cr = fan[s0 + r];
          const tr = (cr / 3) | 0;
          mx += tn[tr * 3];
          my += tn[tr * 3 + 1];
          mz += tn[tr * 3 + 2];
          const r1 = idx[tr * 3 + ((cr + 1) % 3)] * 3, r2 = idx[tr * 3 + ((cr + 2) % 3)] * 3;
          gx += pos[r1] + pos[r2];
          gy += pos[r1 + 1] + pos[r2 + 1];
          gz += pos[r1 + 2] + pos[r2 + 2];
          gn += 2;
        }
        let ml = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
        mx /= ml;
        my /= ml;
        mz /= ml;
        ml = 1;
        // (the field's own normal a fifth of the way from the vertex to the middle of its group's triangles, where it is that face's
        // alone: the mean of the triangles' planes is a few degrees off it on a curved face, and a glossy paint shows each such fan)
        {
          const sxq = pos[v * 3] + 0.2 * (gx / gn - pos[v * 3]), syq = pos[v * 3 + 1] + 0.2 * (gy / gn - pos[v * 3 + 1]), szq = pos[v * 3 + 2] + 0.2 * (gz / gn - pos[v * 3 + 2]);
          const fa = field(sxq + ge, syq - ge, szq - ge);
          const fb = field(sxq - ge, syq - ge, szq + ge);
          const fc = field(sxq - ge, syq + ge, szq - ge);
          const fd = field(sxq + ge, syq + ge, szq + ge);
          evals += 4;
          const tx = fa - fb - fc + fd, ty = -fa - fb + fc + fd, tz = -fa + fb - fc + fd;
          const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
          if (tl > 1e-12 && (tx * mx + ty * my + tz * mz) / tl > 0.966) {
            mx = tx / tl;
            my = ty / tl;
            mz = tz / tl;
          }
        }
        let w = v;
        if (q !== find(0)) {
          if (vcount === vcap) {
            vcap *= 2;
            const p2 = new Float32Array(vcap * 3);
            p2.set(pos);
            pos = p2;
            const n2 = new Float32Array(vcap * 3);
            n2.set(nor);
            nor = n2;
          }
          w = vcount++;
          pos[w * 3] = pos[v * 3];
          pos[w * 3 + 1] = pos[v * 3 + 1];
          pos[w * 3 + 2] = pos[v * 3 + 2];
          for (let r = 0; r < n; r++) if (find(r) === q) idx[fan[s0 + r]] = w;
        }
        nor[w * 3] = mx / ml;
        nor[w * 3 + 1] = my / ml;
        nor[w * 3 + 2] = mz / ml;
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
