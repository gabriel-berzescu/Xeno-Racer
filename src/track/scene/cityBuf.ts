/**
 * Geometry buffer for the city shader (facade.ts): flat quads and boxes with the per-building attributes, a hip roof, and the helpers
 * the city and the landmarks share.
 */
import * as THREE from 'three';
import { FACADE_KIND } from './facade';

const _c = new THREE.Color();
export function linear(hex: number, out: number[], k = 1): void {
  _c.set(hex);
  out[0] = _c.r * k;
  out[1] = _c.g * k;
  out[2] = _c.b * k;
}

export function hash11(p: number): number {
  p = (p * 0.1031) % 1;
  p *= p + 33.33;
  p *= p + p;
  return p - Math.floor(p);
}

// ── geometry buffer ─────────────────────────────────────────────────────────────

/** What a building tells the shader about itself. */
export interface Style {
  col: [number, number, number];
  seed: number;
  floors: number;
  gH: number;
  /** Width of the facade the pattern fits (m). */
  w: number;
  lit: number;
}

export class CityBuf {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  fa: number[] = [];
  fb: number[] = [];
  idx: number[] = [];
  n = 0;
  get empty(): boolean {
    return this.idx.length === 0;
  }
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, st: Style, kind: number): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(st.col[0], st.col[1], st.col[2]);
    this.fa.push(kind, st.seed, st.floors, st.gH);
    this.fb.push(st.w, st.lit, 0, 0);
    return this.n++;
  }
  /** A quad whose winding is chosen to face `n`; p and uv are four [x, y, z] / [u, v] corners in order around it. */
  quad(p: number[][], uv: number[][], n: number[], st: Style, kind: number): void {
    const ax = p[1][0] - p[0][0];
    const ay = p[1][1] - p[0][1];
    const az = p[1][2] - p[0][2];
    const bx = p[3][0] - p[0][0];
    const by = p[3][1] - p[0][1];
    const bz = p[3][2] - p[0][2];
    const gx = ay * bz - az * by;
    const gy = az * bx - ax * bz;
    const gz = ax * by - ay * bx;
    const flip = gx * n[0] + gy * n[1] + gz * n[2] < 0;
    const base = this.n;
    for (let k = 0; k < 4; k++) this.v(p[k][0], p[k][1], p[k][2], n[0], n[1], n[2], uv[k][0], uv[k][1], st, kind);
    if (flip) this.idx.push(base, base + 3, base + 2, base, base + 2, base + 1);
    else this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  /** A triangle facing n. */
  tri(p: number[][], uv: number[][], n: number[], st: Style, kind: number): void {
    const ax = p[1][0] - p[0][0];
    const ay = p[1][1] - p[0][1];
    const az = p[1][2] - p[0][2];
    const bx = p[2][0] - p[0][0];
    const by = p[2][1] - p[0][1];
    const bz = p[2][2] - p[0][2];
    const flip = (ay * bz - az * by) * n[0] + (az * bx - ax * bz) * n[1] + (ax * by - ay * bx) * n[2] < 0;
    const base = this.n;
    for (let k = 0; k < 3; k++) this.v(p[k][0], p[k][1], p[k][2], n[0], n[1], n[2], uv[k][0], uv[k][1], st, kind);
    if (flip) this.idx.push(base, base + 2, base + 1);
    else this.idx.push(base, base + 1, base + 2);
  }
  /** An axis-aligned-in-the-frame box: centre c, half extents (hx along t, hy up, hz along o), frame vectors t and o (horizontal unit). */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, tx: number, tz: number, st: Style, kind: number, top = true): void {
    // o is t rotated by 90 degrees about up
    const ox = -tz;
    const oz = tx;
    const P = (sx: number, sy: number, sz: number): number[] => [cx + tx * hx * sx + ox * hz * sz, cy + hy * sy, cz + tz * hx * sx + oz * hz * sz];
    const faces: [number[], number[]][] = [
      [[tx, 0, tz], [1, 0, 0]],
      [[-tx, 0, -tz], [-1, 0, 0]],
      [[ox, 0, oz], [0, 0, 1]],
      [[-ox, 0, -oz], [0, 0, -1]],
    ];
    for (const [n, a] of faces) {
      const px = a[0];
      const pz = a[2];
      // the face's four corners; its width is the box's extent along the other horizontal axis
      const pts: number[][] = px !== 0
        ? [P(px, -1, -1), P(px, -1, 1), P(px, 1, 1), P(px, 1, -1)]
        : [P(-1, -1, pz), P(1, -1, pz), P(1, 1, pz), P(-1, 1, pz)];
      const fw = px !== 0 ? hz * 2 : hx * 2;
      this.quad(pts, [[0, 0], [fw, 0], [fw, hy * 2], [0, hy * 2]], n, { ...st, w: fw }, kind);
    }
    if (top) this.quad([P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1)], [[0, 0], [hx * 2, 0], [hx * 2, hz * 2], [0, hz * 2]], [0, 1, 0], st, kind);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aFa', new THREE.Float32BufferAttribute(this.fa, 4));
    g.setAttribute('aFb', new THREE.Float32BufferAttribute(this.fb, 4));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}


export interface Pt3 {
  x: number;
  y: number;
  z: number;
}

/** A hip roof over a (nearly) rectangular footprint [front-left, front-right, back-right, back-left]: ridge along the longer axis. */
export function hipRoof(buf: CityBuf, q: Pt3[], yEave: number, slope: number, st: Style): void {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cz = (q[0].z + q[1].z + q[2].z + q[3].z) / 4;
  // axes: along the front edge (a), and front to back (b)
  const ax = (q[1].x - q[0].x + q[2].x - q[3].x) / 2;
  const az = (q[1].z - q[0].z + q[2].z - q[3].z) / 2;
  const bx = (q[3].x - q[0].x + q[2].x - q[1].x) / 2;
  const bz = (q[3].z - q[0].z + q[2].z - q[1].z) / 2;
  const la = Math.hypot(ax, az);
  const lb = Math.hypot(bx, bz);
  const alongA = la >= lb;
  const half = Math.min(la, lb) / 2;
  const rise = Math.max(1.2, half * slope * 2);
  const yR = yEave + rise;
  // ridge end points
  const long = alongA ? [ax / la, az / la] : [bx / lb, bz / lb];
  const halfLong = Math.max(la, lb) / 2;
  const reach = Math.max(0, halfLong - half);
  const R0: Pt3 = { x: cx - long[0] * reach, y: yR, z: cz - long[1] * reach };
  const R1: Pt3 = { x: cx + long[0] * reach, y: yR, z: cz + long[1] * reach };
  const E = (p: Pt3): number[] => [p.x, yEave, p.z];
  const R = (p: Pt3): number[] => [p.x, p.y, p.z];
  const slopeLen = Math.hypot(half, rise);
  // each face: a quad or triangle with normal from its plane
  const face = (pts: number[][]): void => {
    const [p0, p1, p2] = pts;
    const ux = p1[0] - p0[0];
    const uy = p1[1] - p0[1];
    const uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0];
    const vy = p2[1] - p0[1];
    const vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    // u along the first edge, v up the slope
    const eu = Math.hypot(ux, uz);
    const uvs = pts.map((p) => [Math.hypot(p[0] - p0[0], p[2] - p0[2]) * 0 + ((p[0] - p0[0]) * ux + (p[2] - p0[2]) * uz) / Math.max(1e-3, eu), ((p[1] - yEave) / Math.max(0.01, rise)) * slopeLen]);
    if (pts.length === 4) buf.quad(pts, uvs, [nx, ny, nz], st, FACADE_KIND.tile);
    else buf.tri(pts, uvs, [nx, ny, nz], st, FACADE_KIND.tile);
  };
  if (reach < 0.5) {
    const apex: number[] = [cx, yR, cz];
    for (let k = 0; k < 4; k++) face([E(q[k]), E(q[(k + 1) % 4]), apex]);
  } else if (alongA) {
    face([E(q[0]), E(q[1]), R(R1), R(R0)]);
    face([E(q[2]), E(q[3]), R(R0), R(R1)]);
    face([E(q[3]), E(q[0]), R(R0)]);
    face([E(q[1]), E(q[2]), R(R1)]);
  } else {
    // ridge from front to back: slopes on the left and right, hips at the front and back
    face([E(q[0]), E(q[3]), R(R1), R(R0)]);
    face([E(q[2]), E(q[1]), R(R0), R(R1)]);
    face([E(q[1]), E(q[0]), R(R0)]);
    face([E(q[3]), E(q[2]), R(R1)]);
  }
}

