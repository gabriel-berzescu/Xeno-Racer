/**
 * 1-D profile curves, baked into a fine lookup table so evaluation inside the SDF hot loop is a
 * couple of array reads. Control points go through a monotone cubic (PCHIP, no overshoot) and the
 * result is Gaussian-smoothed so the surface has no visible curvature kinks (they show up as
 * broken reflections on clearcoat paint).
 */

export type Pt = readonly [number, number];

export class Curve {
  readonly z0: number;
  readonly z1: number;
  readonly step: number;
  private readonly inv: number;
  private readonly n: number;
  private readonly v: Float32Array;

  /**
   * @param pts   control points (z, value), any order
   * @param sigma Gaussian smoothing radius in metres (0 = none)
   * @param step  table resolution in metres
   */
  constructor(pts: readonly Pt[], sigma = 0, step = 0.001) {
    const p = pts.slice().sort((a, b) => a[0] - b[0]);
    if (p.length === 0) throw new Error('Curve needs points');
    this.z0 = p[0][0];
    this.z1 = p[p.length - 1][0];
    this.step = step;
    this.inv = 1 / step;
    const n = Math.max(1, Math.round((this.z1 - this.z0) / step));
    this.n = n;
    const raw = new Float64Array(n + 1);
    // PCHIP tangents (Fritsch–Carlson)
    const m = p.length;
    const h = new Float64Array(Math.max(m - 1, 1));
    const del = new Float64Array(Math.max(m - 1, 1));
    for (let i = 0; i < m - 1; i++) {
      h[i] = p[i + 1][0] - p[i][0];
      del[i] = h[i] > 0 ? (p[i + 1][1] - p[i][1]) / h[i] : 0;
    }
    const d = new Float64Array(m);
    if (m === 1) d[0] = 0;
    else {
      d[0] = pchipEnd(h[0], h[Math.min(1, m - 2)], del[0], del[Math.min(1, m - 2)], m > 2);
      d[m - 1] = pchipEnd(h[m - 2], h[Math.max(m - 3, 0)], del[m - 2], del[Math.max(m - 3, 0)], m > 2);
      for (let i = 1; i < m - 1; i++) {
        if (del[i - 1] * del[i] > 0) {
          const w1 = 2 * h[i] + h[i - 1];
          const w2 = h[i] + 2 * h[i - 1];
          d[i] = (w1 + w2) / (w1 / del[i - 1] + w2 / del[i]);
        } else d[i] = 0;
      }
    }
    let seg = 0;
    for (let i = 0; i <= n; i++) {
      const z = this.z0 + i * step;
      while (seg < m - 2 && z > p[seg + 1][0]) seg++;
      if (m === 1) raw[i] = p[0][1];
      else {
        const hh = h[seg];
        const t = hh > 0 ? Math.min(1, Math.max(0, (z - p[seg][0]) / hh)) : 0;
        const t2 = t * t, t3 = t2 * t;
        raw[i] =
          (2 * t3 - 3 * t2 + 1) * p[seg][1] +
          (t3 - 2 * t2 + t) * hh * d[seg] +
          (-2 * t3 + 3 * t2) * p[seg + 1][1] +
          (t3 - t2) * hh * d[seg + 1];
      }
    }
    this.v = new Float32Array(n + 1);
    if (sigma > 0) {
      const rad = Math.ceil((sigma * 3) / step);
      const k = new Float64Array(rad * 2 + 1);
      let ks = 0;
      for (let i = -rad; i <= rad; i++) {
        const w = Math.exp(-0.5 * ((i * step) / sigma) ** 2);
        k[i + rad] = w;
        ks += w;
      }
      for (let i = 0; i <= n; i++) {
        let s = 0;
        for (let j = -rad; j <= rad; j++) {
          const idx = Math.min(n, Math.max(0, i + j));
          s += raw[idx] * k[j + rad];
        }
        this.v[i] = s / ks;
      }
    } else for (let i = 0; i <= n; i++) this.v[i] = raw[i];
  }

  /** Value at z (clamped at the ends). */
  at(z: number): number {
    const t = (z - this.z0) * this.inv;
    if (t <= 0) return this.v[0];
    if (t >= this.n) return this.v[this.n];
    const i = t | 0;
    const f = t - i;
    const a = this.v[i];
    return a + (this.v[i + 1] - a) * f;
  }

  /** Slope dv/dz at z (piecewise constant over a table cell). */
  slope(z: number): number {
    const t = (z - this.z0) * this.inv;
    if (t < 0 || t > this.n) return 0; // clamped region: the value is constant there
    let i = t | 0;
    if (i >= this.n) i = this.n - 1;
    // average over a few cells to avoid jitter
    const j0 = i > 2 ? i - 2 : 0;
    const j1 = i + 3 < this.n ? i + 3 : this.n;
    return (this.v[j1] - this.v[j0]) / ((j1 - j0) * this.step);
  }
}

function pchipEnd(h0: number, h1: number, d0: number, d1: number, hasThree: boolean): number {
  if (!hasThree) return d0;
  let d = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
  if (Math.sign(d) !== Math.sign(d0)) d = 0;
  else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(d) > 3 * Math.abs(d0)) d = 3 * d0;
  return d;
}

/** Shorthand: curve from flat [z,v,z,v,...] list. */
export function curve(flat: readonly number[], sigma = 0.03, step = 0.001): Curve {
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  return new Curve(pts, sigma, step);
}
