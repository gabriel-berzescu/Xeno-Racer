/**
 * Surface probes: locate the body surface along an axis-aligned line so zone features (lamps,
 * vents, handles…) can be anchored on the actual sculpted surface instead of guessed coordinates.
 */
import type { FieldFn } from '../sdf';

/** Highest y at (x, z) where the body surface is (scanning down from y1). */
export function topY(f: FieldFn, x: number, z: number, y1 = 1.6, y0 = 0.05): number {
  let y = y1;
  const step = 0.02;
  while (y > y0 && f(x, y, z) > 0) y -= step;
  if (y <= y0) return y0;
  let lo = y, hi = y + step;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    if (f(x, m, z) < 0) lo = m;
    else hi = m;
  }
  return lo;
}

/** Outermost |x| at (y, z) (scanning inward from x1). */
export function sideX(f: FieldFn, y: number, z: number, x1 = 1.5): number {
  let x = x1;
  const step = 0.02;
  while (x > 0 && f(x, y, z) > 0) x -= step;
  if (x <= 0) return 0;
  let lo = x, hi = x + step;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    if (f(m, y, z) < 0) lo = m;
    else hi = m;
  }
  return lo;
}

/** Front-most z at (x, y). */
export function frontZ(f: FieldFn, x: number, y: number, z1 = 3.2): number {
  let z = z1;
  const step = 0.02;
  while (z > -3 && f(x, y, z) > 0) z -= step;
  let lo = z, hi = z + step;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    if (f(x, y, m) < 0) lo = m;
    else hi = m;
  }
  return lo;
}

/** Rear-most z at (x, y). */
export function rearZ(f: FieldFn, x: number, y: number, z1 = -3.2): number {
  let z = z1;
  const step = 0.02;
  while (z < 3 && f(x, y, z) > 0) z += step;
  let lo = z, hi = z - step;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    if (f(x, y, m) < 0) lo = m;
    else hi = m;
  }
  return lo;
}

/** Distance to a polyline of round-cone segments (3D "blade"), points are flat [x,y,z,r,...]. */
export function sdBlade(pts: ArrayLike<number>, x: number, y: number, z: number): number {
  let d = 1e9;
  for (let i = 0; i + 7 < pts.length; i += 4) {
    const ax = pts[i], ay = pts[i + 1], az = pts[i + 2], ra = pts[i + 3];
    const bx = pts[i + 4], by = pts[i + 5], bz = pts[i + 6], rb = pts[i + 7];
    const pax = x - ax, pay = y - ay, paz = z - az;
    const bax = bx - ax, bay = by - ay, baz = bz - az;
    const l2 = bax * bax + bay * bay + baz * baz;
    let h = (pax * bax + pay * bay + paz * baz) / l2;
    h = h < 0 ? 0 : h > 1 ? 1 : h;
    const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
    const dd = Math.sqrt(dx * dx + dy * dy + dz * dz) - (ra + (rb - ra) * h);
    if (dd < d) d = dd;
  }
  return d;
}
