/**
 * Signed-distance-field toolkit used to sculpt the car bodies.
 *
 * Everything is a plain function of numbers (no vectors, no allocation) so the hot loop of the
 * polygonizer stays monomorphic and fast. Convention: negative = inside. All lengths in metres.
 * Worker-safe: no three.js import here.
 */

export type FieldFn = (x: number, y: number, z: number) => number;

// ─────────────────────────────────────────────────────────────────────────────
// scalar helpers
// ─────────────────────────────────────────────────────────────────────────────

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function smoothstep(e0: number, e1: number, v: number): number {
  const t = clamp01((v - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Cubic (C2) smooth minimum. `k` is the blend width in metres. */
export function smin(a: number, b: number, k: number): number {
  const d = a - b;
  const ad = d < 0 ? -d : d;
  if (ad >= k) return a < b ? a : b;
  const h = (k - ad) / k;
  return (a < b ? a : b) - (h * h * h * k) / 6;
}
/** Cubic (C2) smooth maximum. */
export function smax(a: number, b: number, k: number): number {
  const d = a - b;
  const ad = d < 0 ? -d : d;
  if (ad >= k) return a > b ? a : b;
  const h = (k - ad) / k;
  return (a > b ? a : b) + (h * h * h * k) / 6;
}
/** `base` with `cut` carved out, blended over `k`. */
export function ssub(base: number, cut: number, k: number): number {
  return smax(base, -cut, k);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3D primitives (point already in the primitive's local frame)
// ─────────────────────────────────────────────────────────────────────────────

export function sdSphere(x: number, y: number, z: number, r: number): number {
  return Math.sqrt(x * x + y * y + z * z) - r;
}

/** Cheap ellipsoid bound (iq). Good enough as a body-panel blob; not an exact distance. */
export function sdEllipsoid(x: number, y: number, z: number, rx: number, ry: number, rz: number): number {
  const ax = x / rx, ay = y / ry, az = z / rz;
  const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
  const bx = ax / rx, by = ay / ry, bz = az / rz;
  const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
  if (k1 < 1e-12) return -Math.min(rx, ry, rz);
  return (k0 * (k0 - 1)) / k1;
}

/** Axis-aligned box with half extents (hx,hy,hz). */
export function sdBox(x: number, y: number, z: number, hx: number, hy: number, hz: number): number {
  const qx = Math.abs(x) - hx, qy = Math.abs(y) - hy, qz = Math.abs(z) - hz;
  const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0, oz = qz > 0 ? qz : 0;
  const inner = Math.max(qx, qy, qz);
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + (inner < 0 ? inner : 0);
}

/** Box whose *outer* half extents are (hx,hy,hz), edges rounded with radius r. */
export function sdRoundBox(x: number, y: number, z: number, hx: number, hy: number, hz: number, r: number): number {
  const qx = Math.abs(x) - hx + r, qy = Math.abs(y) - hy + r, qz = Math.abs(z) - hz + r;
  const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0, oz = qz > 0 ? qz : 0;
  const inner = Math.max(qx, qy, qz);
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + (inner < 0 ? inner : 0) - r;
}

/** Capsule between a and b with radius r. */
export function sdCapsule(
  x: number, y: number, z: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r: number,
): number {
  const pax = x - ax, pay = y - ay, paz = z - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const h = clamp01((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz));
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}

/** Capsule whose radius varies linearly from ra at a to rb at b (round cone). */
export function sdRoundCone(
  x: number, y: number, z: number,
  ax: number, ay: number, az: number, ra: number,
  bx: number, by: number, bz: number, rb: number,
): number {
  const pax = x - ax, pay = y - ay, paz = z - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  const h = clamp01((pax * bax + pay * bay + paz * baz) / l2);
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - mix(ra, rb, h);
}

/** Cylinder along X, centered at origin, radius r (in the YZ plane) and half length hl, rounded by rr. */
export function sdCylinderX(x: number, y: number, z: number, r: number, hl: number, rr: number): number {
  const dr = Math.sqrt(y * y + z * z) - r + rr;
  const dl = Math.abs(x) - hl + rr;
  const ox = dr > 0 ? dr : 0, oy = dl > 0 ? dl : 0;
  return Math.min(Math.max(dr, dl), 0) + Math.sqrt(ox * ox + oy * oy) - rr;
}

/** Elliptic "tube" along Z (cross-section ellipse a×b), finite half-length hl with rounded ends. Approximate. */
export function sdEllipseTubeZ(x: number, y: number, z: number, a: number, b: number, hl: number, rr: number): number {
  const e = sdEllipse2(x, y, a, b);
  const dl = Math.abs(z) - hl + rr;
  const ox = e + rr > 0 ? e + rr : 0, oy = dl > 0 ? dl : 0;
  return Math.min(Math.max(e + rr, dl), 0) + Math.sqrt(ox * ox + oy * oy) - rr;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2D helpers (used for outlines, panel lines, decals — evaluated per vertex, not per grid sample)
// ─────────────────────────────────────────────────────────────────────────────

export function sdCircle2(x: number, y: number, r: number): number {
  return Math.sqrt(x * x + y * y) - r;
}

/** Approximate ellipse distance (gradient-normalised implicit function). */
export function sdEllipse2(x: number, y: number, a: number, b: number): number {
  const ax = x / a, by = y / b;
  const k0 = Math.sqrt(ax * ax + by * by);
  const cx = ax / a, cy = by / b;
  const k1 = Math.sqrt(cx * cx + cy * cy);
  if (k1 < 1e-12) return -Math.min(a, b);
  return (k0 * (k0 - 1)) / k1;
}

/** Ellipse (semi-axes a,b) centred at (cx,cy), rotated by `ang` radians. */
export function sdEllipseRot2(x: number, y: number, cx: number, cy: number, a: number, b: number, ang: number): number {
  const dx = x - cx, dy = y - cy;
  const c = Math.cos(ang), s = Math.sin(ang);
  return sdEllipse2(dx * c + dy * s, -dx * s + dy * c, a, b);
}

export function sdRect2(x: number, y: number, hx: number, hy: number): number {
  const qx = Math.abs(x) - hx, qy = Math.abs(y) - hy;
  const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0;
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0);
}

/** Rounded rectangle, *outer* half extents hx,hy, corner radius r. */
export function sdRoundRect2(x: number, y: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(x) - hx + r, qy = Math.abs(y) - hy + r;
  const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0;
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance from (x,y) to the segment a→b. */
export function sdSegment2(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  const dx = pax - bax * h, dy = pay - bay * h;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Rounded segment / "stadium" — signed. */
export function sdStadium2(x: number, y: number, ax: number, ay: number, bx: number, by: number, r: number): number {
  return sdSegment2(x, y, ax, ay, bx, by) - r;
}

/**
 * Signed distance to a closed polygon given as a flat [x0,y0,x1,y1,...] array (any winding).
 * Negative inside. O(n) — only for per-vertex zone fields.
 */
export function sdPolygon2(poly: ArrayLike<number>, x: number, y: number): number {
  const n = poly.length >> 1;
  let d = (x - poly[0]) * (x - poly[0]) + (y - poly[1]) * (y - poly[1]);
  let s = 1;
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const ex = poly[j * 2] - poly[i * 2], ey = poly[j * 2 + 1] - poly[i * 2 + 1];
    const wx = x - poly[i * 2], wy = y - poly[i * 2 + 1];
    const t = clamp01((wx * ex + wy * ey) / (ex * ex + ey * ey));
    const bx = wx - ex * t, by = wy - ey * t;
    const dd = bx * bx + by * by;
    if (dd < d) d = dd;
    const c1 = y >= poly[i * 2 + 1];
    const c2 = y < poly[j * 2 + 1];
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hash noise (for vertex-level wobble and the like)
// ─────────────────────────────────────────────────────────────────────────────

export function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
