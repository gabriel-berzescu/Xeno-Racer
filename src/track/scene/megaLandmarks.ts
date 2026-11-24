/**
 * The megacity's two landmarks (megacity.ts).
 *
 * The Spire: the tallest tower of the city, eight-sided, tapering in four stages to a lantern and a needle, with lines of light up
 * its chamfered corners. It stands beside the road at a mark, `d` metres to the left of it.
 *
 * The arcology: a megastructure built over a tunnel, three stepped tiers the length of it and two pylons. Its end walls stand a
 * metre and a half behind the planes of the tunnel's portals (rocks.ts builds those, and the mound over the tube that this building
 * encloses), with a recess the size of the portal wall cut into them, so that the portals read as the mouths of the building.
 */
import type { LandmarkDef } from '../types';
import { resolveMark } from '../plan';
import type { TrackRuntimeImpl } from '../runtime';
import type { CityBuf, Style } from './cityBuf';
import type { Pt } from './cityLots';
import { ACCENTS, CYBER_FLAG, CYBER_KIND, SIGN_MODE } from './cyberFacade';
import { centroid, lightStyle, plainStyle, roof, seedOf, signStyle, slab, walls } from './megaSolids';

export interface MegaPlace {
  kind: 'spire' | 'arcology';
  def: LandmarkDef;
  /** The centre on the map, the unit vector along the road there and the one to its left. */
  x: number;
  z: number;
  tx: number;
  tz: number;
  lx: number;
  lz: number;
  /** The floor datum, and how far down the foundations go. */
  y: number;
  yBot: number;
  height: number;
  /** The footprint, for keeping the towers away. */
  quad: Pt[];
  /** The arcology: half its length and half its width (m), the half-width of the tunnel's mouth, the road's height at each end. */
  halfLen: number;
  halfWid: number;
  mouth: number;
  roadY: [number, number];
}

const SPIRE_HALF = 36;

function ground(rt: TrackRuntimeImpl, q: Pt[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x, z] of q) {
    const y = rt.heightFast(x, z);
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  return [lo, hi];
}

export function placeSpire(rt: TrackRuntimeImpl, lm: LandmarkDef): MegaPlace | null {
  if (!lm.at) return null;
  const s = resolveMark(rt.plan.marks, rt.length, lm.at);
  const i = Math.round(s / rt.spacing) % rt.count;
  const d = lm.d ?? -145;
  const x = rt.X[i] + rt.HLX[i] * d;
  const z = rt.Z[i] + rt.HLZ[i] * d;
  const tx = rt.HTX[i];
  const tz = rt.HTZ[i];
  const lx = rt.HLX[i];
  const lz = rt.HLZ[i];
  const r = SPIRE_HALF + 3;
  const quad: Pt[] = [[-r, -r], [r, -r], [r, r], [-r, r]].map(([a, b]) => [x + tx * a + lx * b, z + tz * a + lz * b] as Pt);
  const [lo, hi] = ground(rt, quad);
  return { kind: 'spire', def: lm, x, z, tx, tz, lx, lz, y: hi, yBot: lo - 2, height: lm.height ?? 400, quad, halfLen: r, halfWid: r, mouth: 0, roadY: [hi, hi] };
}

export function placeArcology(rt: TrackRuntimeImpl, lm: LandmarkDef): MegaPlace | null {
  const spans = rt.tunnelSpans;
  if (!spans.length) return null;
  // the tunnel the mark is in, or the first
  let span = spans[0];
  if (lm.at) {
    const s = resolveMark(rt.plan.marks, rt.length, lm.at);
    for (const sp of spans) if (s >= sp[0] && s <= sp[1]) span = sp;
  }
  const N = rt.count;
  const ia = ((Math.round(span[0] / rt.spacing) % N) + N) % N;
  const ib = ((Math.round(span[1] / rt.spacing) % N) + N) % N;
  // (a building is straight: so must the tunnel be)
  if (rt.HTX[ia] * rt.HTX[ib] + rt.HTZ[ia] * rt.HTZ[ib] < 0.999) return null;
  const mid = (k: number): Pt => {
    const dm = (rt.L.wall[k] - rt.R.wall[k]) / 2;
    return [rt.X[k] + rt.HLX[k] * dm, rt.Z[k] + rt.HLZ[k] * dm];
  };
  const pa = mid(ia);
  const pb = mid(ib);
  const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
  const tx = (pb[0] - pa[0]) / len;
  const tz = (pb[1] - pa[1]) / len;
  const lx = rt.HLX[ia];
  const lz = rt.HLZ[ia];
  const x = (pa[0] + pb[0]) / 2;
  const z = (pa[1] + pb[1]) / 2;
  const halfLen = len / 2 - 1.5;
  const halfWid = (lm.width ?? 160) / 2;
  const mouth = Math.max((rt.L.wall[ia] + rt.R.wall[ia]) / 2, (rt.L.wall[ib] + rt.R.wall[ib]) / 2);
  const quad: Pt[] = [[-halfLen, -halfWid], [halfLen, -halfWid], [halfLen, halfWid], [-halfLen, halfWid]].map(([a, b]) => [x + tx * a + lx * b, z + tz * a + lz * b] as Pt);
  const [lo] = ground(rt, quad);
  const roadY: [number, number] = [rt.Y[ia], rt.Y[ib]];
  return { kind: 'arcology', def: lm, x, z, tx, tz, lx, lz, y: (roadY[0] + roadY[1]) / 2, yBot: Math.min(lo, roadY[0], roadY[1]) - 2.5, height: lm.height ?? 96, quad, halfLen, halfWid, mouth, roadY };
}

/** One upright wall from a to b, facing (nx, nz), its pattern fitted to a wall `W` wide that this piece starts `u0` along. */
function face(buf: CityBuf, a: Pt, b: Pt, y0: number, y1: number, yRef: number, u0: number, W: number, nx: number, nz: number, st: Style, kind: number): void {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  buf.quad(
    [[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]],
    [[u0, y0 - yRef], [u0 + len, y0 - yRef], [u0 + len, y1 - yRef], [u0, y1 - yRef]],
    [nx, 0, nz],
    { ...st, w: W },
    kind,
  );
}

/** A strip of light on a wall: from a to b (map points) at heights ya and yb, `w` wide, `out` m off the wall along (nx, nz). */
function strip(buf: CityBuf, a: Pt, ya: number, b: Pt, yb: number, w: number, nx: number, nz: number, out: number, st: Style): void {
  // across the strip: horizontal, square to the normal
  const ux = -nz * (w / 2);
  const uz = nx * (w / 2);
  const ox = nx * out;
  const oz = nz * out;
  buf.quad(
    [[a[0] + ox - ux, ya, a[1] + oz - uz], [a[0] + ox + ux, ya, a[1] + oz + uz], [b[0] + ox + ux, yb, b[1] + oz + uz], [b[0] + ox - ux, yb, b[1] + oz - uz]],
    [[0, 0], [w, 0], [w, 1], [0, 1]],
    [nx, 0, nz],
    st,
    CYBER_KIND.light,
  );
}

/** A band of light round a polygon at height y, `hgt` high, `out` m off its walls. */
function ring(buf: CityBuf, q: Pt[], y: number, hgt: number, out: number, st: Style): void {
  const c = centroid(q);
  for (let k = 0; k < q.length; k++) {
    const a = q[k];
    const b = q[(k + 1) % q.length];
    const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let nx = -(b[1] - a[1]) / tl;
    let nz = (b[0] - a[0]) / tl;
    if ((a[0] - c[0]) * nx + (a[1] - c[1]) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    buf.quad(
      [[a[0] + nx * out, y, a[1] + nz * out], [b[0] + nx * out, y, b[1] + nz * out], [b[0] + nx * out, y + hgt, b[1] + nz * out], [a[0] + nx * out, y + hgt, a[1] + nz * out]],
      [[0, 0], [tl, 0], [tl, hgt], [0, hgt]],
      [nx, 0, nz],
      st,
      CYBER_KIND.light,
    );
  }
}

// ── the Spire ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Returns the height of the top of its lower shaft (what stands between a TV camera and a car). */
export function emitSpire(buf: CityBuf, beacons: number[], _rt: TrackRuntimeImpl, p: MegaPlace): number {
  const H = p.height;
  const oct = (half: number, ch: number): Pt[] => {
    const pts: [number, number][] = [[half, -half + ch], [half, half - ch], [half - ch, half], [-half + ch, half], [-half, half - ch], [-half, -half + ch], [-half + ch, -half], [half - ch, -half]];
    return pts.map(([a, b]) => [p.x + p.tx * a + p.lx * b, p.z + p.tz * a + p.lz * b] as Pt);
  };
  const glassCol: [number, number, number] = [0.052, 0.078, 0.11];
  const st: Style = { col: glassCol, seed: seedOf(0.613), floors: 0, gH: 0, w: 1, lit: 0.16, a: 0, b: CYBER_FLAG.lines };
  const teal = lightStyle(ACCENTS[0], 1.5);
  const violet = lightStyle(ACCENTS[2], 1.7, 2, 0.2);
  const k = SPIRE_HALF / 36;
  // [from, to] as shares of the height, the half-size and the chamfer at the bottom and at the top
  const stages: [number, number, number, number, number, number][] = [
    [0.085, 0.46, 29, 9, 24.5, 7.6],
    [0.46, 0.73, 21.5, 6.7, 16.5, 5.2],
    [0.73, 0.895, 14, 4.4, 10.5, 3.3],
  ];
  // the podium: three storeys of shop fronts and halls
  const pod = oct(36 * k, 11 * k);
  const yPod = p.y + H * 0.085;
  walls(buf, pod, pod, p.yBot, yPod, p.y, { ...st, gH: 11, lit: 0.4, b: CYBER_FLAG.bands }, CYBER_KIND.glass);
  roof(buf, pod, yPod, st);
  ring(buf, pod, yPod - 1.2, 0.7, 0.25, teal);
  for (const [f0, f1, h0, c0, h1, c1] of stages) {
    const q0 = oct(h0 * k, c0 * k);
    const q1 = oct(h1 * k, c1 * k);
    const y0 = p.y + H * f0;
    const y1 = p.y + H * f1;
    walls(buf, q0, q1, y0, y1, p.y, st, CYBER_KIND.glass);
    roof(buf, q1, y1, st);
    // lines of light up the chamfered corners (the odd walls of the octagon)
    const c = centroid(q0);
    for (let e = 1; e < 8; e += 2) {
      const a0: Pt = [(q0[e][0] + q0[(e + 1) % 8][0]) / 2, (q0[e][1] + q0[(e + 1) % 8][1]) / 2];
      const a1: Pt = [(q1[e][0] + q1[(e + 1) % 8][0]) / 2, (q1[e][1] + q1[(e + 1) % 8][1]) / 2];
      const nl = Math.hypot(a0[0] - c[0], a0[1] - c[1]) || 1;
      strip(buf, a0, y0, a1, y1, 1.5, (a0[0] - c[0]) / nl, (a0[1] - c[1]) / nl, 0.3, teal);
    }
    // a steady lamp on four corners of each setback
    for (let e = 0; e < 8; e += 2) beacons.push(q1[e][0], y1 + 1, q1[e][1], 2);
  }
  // the lantern: every room lit, between two rings of light
  const lan = oct(12 * k, 3.8 * k);
  const yl0 = p.y + H * 0.895;
  const yl1 = p.y + H * 0.95;
  walls(buf, lan, lan, yl0, yl1, p.y, { ...st, lit: 1.6, a: 3, b: CYBER_FLAG.crown }, CYBER_KIND.glass);
  ring(buf, lan, yl0 - 0.2, 1.1, 0.3, violet);
  ring(buf, lan, yl1 - 0.9, 1.1, 0.3, violet);
  const cap0 = oct(8 * k, 2.5 * k);
  const cap1 = oct(3 * k, 1 * k);
  roof(buf, lan, yl1, st);
  walls(buf, cap0, cap1, yl1, p.y + H, p.y, { ...st, lit: 0.5, b: 0 }, CYBER_KIND.glass);
  roof(buf, cap1, p.y + H, st);
  // the needle
  const metal = plainStyle([0.06, 0.063, 0.07], 0.7);
  const top = p.y + H;
  buf.box(p.x, top + 0.05 * H, p.z, 1.3, 0.05 * H, 1.3, p.tx, p.tz, metal, CYBER_KIND.plain);
  buf.box(p.x, top + 0.13 * H, p.z, 0.5, 0.03 * H, 0.5, p.tx, p.tz, metal, CYBER_KIND.plain);
  beacons.push(p.x, top + 0.16 * H + 0.6, p.z, 0.37, p.x, top + 0.1 * H, p.z, 2, p.x, top + 0.02 * H, p.z, 0.37);
  return p.y + H * 0.46;
}

// ── the arcology ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Returns the height of its first tier's roof. */
export function emitArcology(buf: CityBuf, beacons: number[], _rt: TrackRuntimeImpl, p: MegaPlace, rnd: () => number): number {
  const H = p.height;
  const hl = p.halfLen;
  const hw = p.halfWid;
  const P = (al: number, lat: number): Pt => [p.x + p.tx * al + p.lx * lat, p.z + p.tz * al + p.lz * lat];
  const yRef = p.y;
  const top1 = yRef + H * 0.6;
  const top2 = yRef + H * 0.84;
  const top3 = yRef + H;
  const conc: Style = { col: [0.034, 0.037, 0.045], seed: seedOf(0.287), floors: top1 - yRef, gH: 0, w: 1, lit: 0.2, a: 2, b: CYBER_FLAG.bands | CYBER_FLAG.crown };
  const dark = plainStyle([0.02, 0.021, 0.024], 0.1);
  const violet = lightStyle(ACCENTS[2], 1.5);
  const teal = lightStyle(ACCENTS[0], 1.5);

  // tier 1: the long walls
  for (const sgn of [1, -1]) {
    face(buf, P(-hl, hw * sgn), P(hl, hw * sgn), p.yBot, top1, yRef, 0, 2 * hl, p.lx * sgn, p.lz * sgn, conc, CYBER_KIND.concrete);
    // buttresses, a line of light up each
    const n = Math.max(2, Math.round((2 * hl) / 27));
    for (let i = 0; i <= n; i++) {
      const al = -hl + 3 + ((2 * hl - 6) * i) / n;
      const c = P(al, (hw + 1.1) * sgn);
      buf.box(c[0], (p.yBot + top1 - 5) / 2, c[1], 1.6, (top1 - 5 - p.yBot) / 2, 1.1, p.tx, p.tz, { ...conc, col: [0.028, 0.03, 0.036], b: 0, lit: 0 }, CYBER_KIND.plain);
      const a = P(al, hw * sgn);
      strip(buf, a, yRef + 9, a, top1 - 8, 0.45, p.lx * sgn, p.lz * sgn, 2.3, violet);
    }
  }
  // tier 1: the end walls, with the recess for the portal
  const nw = p.mouth + 12;
  for (const end of [0, 1]) {
    const sgn = end ? 1 : -1;
    const al = hl * sgn;
    const nx = p.tx * sgn;
    const nz = p.tz * sgn;
    const yLintel = p.roadY[end] + 9;
    const W = 2 * hw;
    face(buf, P(al, -hw), P(al, -nw), p.yBot, top1, yRef, 0, W, nx, nz, conc, CYBER_KIND.concrete);
    face(buf, P(al, nw), P(al, hw), p.yBot, top1, yRef, hw + nw, W, nx, nz, conc, CYBER_KIND.concrete);
    face(buf, P(al, -nw), P(al, nw), yLintel, top1, yRef, hw - nw, W, nx, nz, conc, CYBER_KIND.concrete);
    // the recess: its two cheeks, its ceiling, and the wall behind on either side of the tube
    const deep = 10;
    const ai = al - deep * sgn;
    for (const s2 of [1, -1]) {
      face(buf, P(al, nw * s2), P(ai, nw * s2), p.yBot, yLintel, yRef, 0, deep, -p.lx * s2, -p.lz * s2, dark, CYBER_KIND.plain);
      face(buf, P(ai, (p.mouth + 0.4) * s2), P(ai, nw * s2), p.yBot, yLintel, yRef, 0, 12, nx, nz, dark, CYBER_KIND.plain);
    }
    const c0 = P(al, -nw);
    const c1 = P(al, nw);
    const c2 = P(ai, nw);
    const c3 = P(ai, -nw);
    buf.quad([[c0[0], yLintel, c0[1]], [c1[0], yLintel, c1[1]], [c2[0], yLintel, c2[1]], [c3[0], yLintel, c3[1]]], [[0, 0], [2 * nw, 0], [2 * nw, deep], [0, deep]], [0, -1, 0], dark, CYBER_KIND.plain);
    // the mouth framed in light, and the arcology's mark over it
    const o = 0.35;
    strip(buf, P(al, -nw - 0.6), p.yBot + 2, P(al, -nw - 0.6), yLintel + 1.3, 0.5, nx, nz, o, violet);
    strip(buf, P(al, nw + 0.6), p.yBot + 2, P(al, nw + 0.6), yLintel + 1.3, 0.5, nx, nz, o, violet);
    const la = P(al + o * sgn, -nw - 0.85);
    const lb = P(al + o * sgn, nw + 0.85);
    buf.quad([[la[0], yLintel + 1.05, la[1]], [lb[0], yLintel + 1.05, lb[1]], [lb[0], yLintel + 1.55, lb[1]], [la[0], yLintel + 1.55, la[1]]], [[0, 0], [1, 0], [1, 1], [0, 1]], [nx, 0, nz], violet, CYBER_KIND.light);
    const sw = 2 * nw - 6;
    const sh = Math.min(15, top1 - yLintel - 12);
    const sc = P(al + 0.5 * sgn, 0);
    const sg = signStyle(sw, sh, rnd, SIGN_MODE.mark);
    slab(buf, sc[0], yLintel + 4.5 + sh / 2, sc[1], p.lx, p.lz, sw, sh, nx, nz, 0.6, { ...sg, col: [ACCENTS[0][0], ACCENTS[0][1], ACCENTS[0][2]], b: 0 }, CYBER_KIND.sign);
  }
  const q1: Pt[] = [P(-hl, -hw), P(hl, -hw), P(hl, hw), P(-hl, hw)];
  roof(buf, q1, top1, conc);

  // tier 2: glass, set back; tier 3: the ridge, with the crown
  const glass: Style = { col: [0.06, 0.085, 0.11], seed: seedOf(0.731), floors: 0, gH: 0, w: 1, lit: 0.34, a: 0, b: CYBER_FLAG.bands };
  const q2: Pt[] = [P(-hl + 22, -hw + 24), P(hl - 22, -hw + 24), P(hl - 22, hw - 24), P(-hl + 22, hw - 24)];
  walls(buf, q2, q2, top1, top2, yRef, glass, CYBER_KIND.glass);
  roof(buf, q2, top2, glass);
  const q3: Pt[] = [P(-hl + 66, -hw + 52), P(hl - 66, -hw + 52), P(hl - 66, hw - 52), P(-hl + 66, hw - 52)];
  walls(buf, q3, q3, top2, top3, yRef, { ...glass, seed: seedOf(0.411), lit: 0.5, a: 2, b: CYBER_FLAG.crown | CYBER_FLAG.edges }, CYBER_KIND.glass);
  roof(buf, q3, top3, glass);
  // two pylons on the second tier, a mast and its lamp on each
  for (const sgn of [1, -1]) {
    const c = (hl - 44) * sgn;
    const qa: Pt[] = [P(c - 11, -11), P(c + 11, -11), P(c + 11, 11), P(c - 11, 11)];
    const yt = top3 + H * 0.42;
    const qb: Pt[] = [P(c - 8.5, -8.5), P(c + 8.5, -8.5), P(c + 8.5, 8.5), P(c - 8.5, 8.5)];
    walls(buf, qa, qb, top2, yt, yRef, { ...glass, seed: seedOf(0.2 + 0.3 * (sgn + 1)), lit: 0.22, a: 0, b: CYBER_FLAG.crown | CYBER_FLAG.lines }, CYBER_KIND.glass);
    roof(buf, qb, yt, glass);
    const m = P(c, 0);
    buf.box(m[0], yt + 9, m[1], 0.5, 9, 0.5, p.tx, p.tz, plainStyle([0.06, 0.063, 0.07], 0.7), CYBER_KIND.plain);
    beacons.push(m[0], yt + 18.6, m[1], 0.8);
    ring(buf, qb, yt - 2.2, 0.8, 0.25, teal);
  }
  return top1;
}
