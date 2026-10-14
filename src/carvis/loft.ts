/**
 * "Lofted" body section: a swept rounded cross-section driven by profile curves along Z, with
 * optional tilted end planes (windscreen / fascia rake). Cars are x-symmetric, so evaluation takes
 * |x|. The result is an *approximate* SDF whose gradient is normalised (slope-corrected) so the
 * polygonizer's culling bound holds.
 */
import type { Curve } from './curve';
import { clamp01, smax } from './sdf';

export interface Loft {
  /** Bottom / top surface heights along z (top at the centreline). */
  yb: Curve;
  yt: Curve;
  /** Half-width at the widest part of the section, along z. */
  w: Curve;
  /** How much lower the top surface is at the section's outer edge (crown), along z. */
  crown: Curve;
  /** Tumblehome: inward lean of the side wall at the very top, along z. */
  tum: Curve;
  /** Height where the tumblehome starts (below it the wall is vertical). */
  tumY: number;
  /** Barrel tuck: inward offset of the wall at the bottom (y = yb), along z, and the height of the widest point. */
  bar: Curve;
  yw: number;
  /** Corner radii: top shoulder, bottom edge, end planes. */
  rTop: number;
  rBot: number;
  rEnd: number;
  /** Front/rear end planes: z = zf - kf*(y - yRef) and z = zr + kr*(y - yRef). */
  zf: number;
  zr: number;
  kf: number;
  kr: number;
  yRef: number;
}

export function defaultLoft(p: Partial<Loft> & Pick<Loft, 'yb' | 'yt' | 'w' | 'zf' | 'zr'>, c0: Curve): Loft {
  return {
    crown: c0,
    tum: c0,
    bar: c0,
    yw: 0.5,
    tumY: 0.5,
    rTop: 0.12,
    rBot: 0.08,
    rEnd: 0.15,
    kf: 0,
    kr: 0,
    yRef: 0,
    ...p,
  };
}

export function sdLoft(L: Loft, ax: number, y: number, z: number): number {
  const yt = L.yt.at(z);
  const yb = L.yb.at(z);
  const w = L.w.at(z);
  const sTop = L.yt.slope(z);
  const sBot = L.yb.slope(z);
  const sW = L.w.slope(z);
  const cr = L.crown.at(z);
  const tu = L.tum.at(z);

  // side wall with tumblehome: the wall leans in quadratically up to the roofline and keeps leaning
  // linearly above it, so the field (and its slope normalisation) stays continuous through y = yt
  const span = yt - L.tumY > 0.03 ? yt - L.tumY : 0.03;
  const t = (y - L.tumY) / span;
  let gT = 0;
  let dgT = 0;
  if (t > 0) {
    if (t <= 1) {
      gT = t * t;
      dgT = 2 * t;
    } else {
      gT = 1 + 2 * (t - 1);
      dgT = 2;
    }
  }
  let dxdy = (tu * dgT) / span;
  let xEdge = w - tu * gT;
  if (y < L.yw) {
    const ba = L.bar.at(z);
    if (ba !== 0) {
      const hh = L.yw - yb > 0.05 ? L.yw - yb : 0.05;
      let u = (L.yw - y) / hh;
      if (u > 1.3) u = 1.3;
      xEdge -= ba * u * u;
      dxdy += (2 * ba * u) / hh;
    }
  }
  const dSide = (ax - xEdge) / Math.sqrt(1 + sW * sW + dxdy * dxdy);

  // crowned top
  const wx = ax / (w > 0.05 ? w : 0.05);
  const topY = yt - cr * wx * wx;
  const dyc = (2 * cr * ax) / ((w > 0.05 ? w : 0.05) * (w > 0.05 ? w : 0.05));
  const dTop = (y - topY) / Math.sqrt(1 + sTop * sTop + dyc * dyc);

  // flat-ish bottom
  const dBot = (yb - y) / Math.sqrt(1 + sBot * sBot);

  let d = smax(dSide, dTop, L.rTop);
  d = smax(d, dBot, L.rBot);

  // end planes
  const dF = (z - (L.zf - L.kf * (y - L.yRef))) / Math.sqrt(1 + L.kf * L.kf);
  const dR = (L.zr + L.kr * (y - L.yRef) - z) / Math.sqrt(1 + L.kr * L.kr);
  d = smax(d, dF, L.rEnd);
  d = smax(d, dR, L.rEnd);
  return d;
}

/** Plan-view rounded rectangle footprint extruded vertically (used to round noses/tails in plan). */
export function sdFootprint(ax: number, z: number, hw: number, zFront: number, zRear: number, rFront: number, rRear: number): number {
  // front corner
  const zc = (zFront + zRear) * 0.5;
  const hl = (zFront - zRear) * 0.5;
  const dz = z - zc;
  const r = dz > 0 ? rFront : rRear;
  const qx = ax - hw + r;
  const qz = (dz < 0 ? -dz : dz) - hl + r;
  const ox = qx > 0 ? qx : 0, oz = qz > 0 ? qz : 0;
  return Math.sqrt(ox * ox + oz * oz) + Math.min(Math.max(qx, qz), 0) - r;
}

export function unit(v: number): number {
  return clamp01(v);
}
