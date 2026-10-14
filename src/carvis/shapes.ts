/**
 * 2D shape helpers for zone outlines (windows, panel lines…). Evaluated per vertex only.
 */
import { sdPolygon2 } from './sdf';

/** Round the corners of a closed polygon (flat [x,y,...]) with tangent arcs of radius r (scalar or per-vertex). */
export function roundPoly(pts: readonly number[], r: number | readonly number[], seg = 6): number[] {
  const n = pts.length >> 1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const px = pts[((i + n - 1) % n) * 2], py = pts[((i + n - 1) % n) * 2 + 1];
    const cx = pts[i * 2], cy = pts[i * 2 + 1];
    const nx = pts[((i + 1) % n) * 2], ny = pts[((i + 1) % n) * 2 + 1];
    const rad = typeof r === 'number' ? r : r[i];
    if (rad <= 1e-6) {
      out.push(cx, cy);
      continue;
    }
    let ax = px - cx, ay = py - cy, bx = nx - cx, by = ny - cy;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    ax /= la; ay /= la; bx /= lb; by /= lb;
    const cosT = Math.max(-1, Math.min(1, ax * bx + ay * by));
    const theta = Math.acos(cosT);
    if (theta < 1e-3 || Math.PI - theta < 1e-3) {
      out.push(cx, cy);
      continue;
    }
    let t = rad / Math.tan(theta / 2);
    const tmax = 0.5 * Math.min(la, lb);
    let rr = rad;
    if (t > tmax) {
      t = tmax;
      rr = t * Math.tan(theta / 2);
    }
    const t1x = cx + ax * t, t1y = cy + ay * t;
    const t2x = cx + bx * t, t2y = cy + by * t;
    // arc center along the bisector
    let mx = ax + bx, my = ay + by;
    const lm = Math.hypot(mx, my);
    mx /= lm; my /= lm;
    const dc = rr / Math.sin(theta / 2);
    const ox = cx + mx * dc, oy = cy + my * dc;
    let a0 = Math.atan2(t1y - oy, t1x - ox);
    let a1 = Math.atan2(t2y - oy, t2x - ox);
    let da = a1 - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    for (let s = 0; s <= seg; s++) {
      const a = a0 + (da * s) / seg;
      out.push(ox + Math.cos(a) * rr, oy + Math.sin(a) * rr);
    }
  }
  return out;
}

/** Polygon signed distance with mirror: returns sd for |x| via the polygon defined for x>0. */
export function polyField(poly: readonly number[]): (a: number, b: number) => number {
  const p = poly;
  return (a, b) => sdPolygon2(p, a, b);
}

/** Conformal surface dent: pushes the iso-surface inward by `depth` inside region (sd<0), blended over `soft`. */
export function dent(d: number, sdRegion: number, depth: number, soft: number): number {
  if (sdRegion >= 0) return d;
  let t = -sdRegion / soft;
  if (t > 1) t = 1;
  return d + depth * (t * t * (3 - 2 * t));
}

const _strip = new Float64Array(2);

/**
 * "Thin strip" encoding for LED lines: returns the signed offset `u` perpendicular to a strip whose
 * centre is (cx,cy), rotated by `ang`, plus the along-strip extent `e` (negative = inside the length).
 * Unlike a distance field, `u` is linear across the strip, so interpolating it over a triangle keeps a
 * 6 mm line crisp on a 3 cm mesh. Results land in the returned (shared) 2-array: [u, e].
 */
export function strip2(x: number, y: number, cx: number, cy: number, ang: number, halfLen: number): Float64Array {
  const dx = x - cx, dy = y - cy;
  const c = Math.cos(ang), s = Math.sin(ang);
  _strip[0] = -dx * s + dy * c;
  _strip[1] = Math.abs(dx * c + dy * s) - halfLen;
  return _strip;
}
