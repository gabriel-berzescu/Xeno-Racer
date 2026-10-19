/**
 * Procedural wheel + tire + brake geometry. Pure numeric (worker-safe).
 *
 * Wheel-local frame: +X is the axle, pointing OUTWARD for the left-hand wheel; the wheel spins about X.
 * One merged mesh (tire, rim barrel, spokes, hub, brake disc, blur disc) is drawn with the wheel
 * shader, which switches on the `part` id in zone channel z3.y. The caliper + dust shield are a
 * separate non-spinning mesh.
 */
import type { QualityLevel } from '../core/contracts';
import { PART } from './blueprint';
import { PartBuilder, frameFromAxis, type Frame, type V3 } from './parts';

export type WheelStyle = 'multi' | 'split5' | 'six' | 'centerlock' | 'beadlock';

export interface WheelParams {
  R: number; // tire outer radius
  W: number; // tire section width
  rimR: number; // rim bead-seat radius
  style: WheelStyle;
  quality: QualityLevel;
}

export interface WheelLayout {
  /** x of the outer face of the spokes */
  xOut: number;
  /** x of the brake disc centre plane */
  xDisc: number;
  discInner: number;
  discOuter: number;
  discHalf: number;
}

const SEGS: Record<QualityLevel, number> = { low: 32, medium: 48, high: 64, ultra: 72 };

export function wheelLayout(p: WheelParams): WheelLayout {
  const xo = 0.43 * p.W;
  const dish = p.style === 'centerlock' ? 0.016 : p.style === 'six' ? 0.045 : p.style === 'multi' ? 0.03 : p.style === 'beadlock' ? 0.04 : 0.026;
  const xOut = xo - dish;
  const discOuter = Math.min(p.rimR - 0.04, 0.215);
  return { xOut, xDisc: xOut - 0.062, discInner: 0.1, discOuter, discHalf: 0.014 };
}

function circle(n: number): number[] {
  const a: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    a.push(Math.cos(t), Math.sin(t));
  }
  return a;
}

/** Revolve a (x, r) profile about the X axis. */
function revolveX(pb: PartBuilder, prof: ReadonlyArray<readonly [number, number]>, segs: number, caps = false): number {
  const base = pb.vertexCount;
  const unit = circle(segs);
  const rings: V3[][] = [];
  for (const [x, r] of prof) {
    const ring: V3[] = [];
    for (let i = 0; i < segs; i++) ring.push([x, unit[i * 2] * r, unit[i * 2 + 1] * r]);
    rings.push(ring);
  }
  pb.loft(rings, { capStart: caps, capEnd: caps });
  return base;
}

function setZ(pb: PartBuilder, v0: number, v1: number, channel: number, value: number): void {
  for (let i = v0; i < v1; i++) pb.zon[i * 16 + channel] = value;
}

/** spoke outline along a (possibly swept) centreline, in (radial, tangential) coordinates */
function spokePoly(r0: number, r1: number, w0: number, w1: number, sweep: number, pow = 1, n = 9): number[] {
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const r = r0 + (r1 - r0) * t;
    const w = w0 + (w1 - w0) * Math.pow(t, pow);
    const c = sweep * t * t;
    left.push(r, c + w);
    right.push(r, c - w);
  }
  const out: number[] = [];
  for (let i = 0; i < left.length; i += 2) out.push(left[i], left[i + 1]);
  // rounded tip
  const tipW = w1;
  const cEnd = sweep;
  for (let k = 1; k < 4; k++) {
    const a = (k / 4) * Math.PI;
    out.push(r1 + Math.sin(a) * tipW * 0.5, cEnd + Math.cos(a) * tipW);
  }
  for (let i = right.length - 2; i >= 0; i -= 2) out.push(right[i], right[i + 1]);
  // rounded root
  for (let k = 1; k < 4; k++) {
    const a = (k / 4) * Math.PI;
    out.push(r0 - Math.sin(a) * w0 * 0.6, 0 - Math.cos(a) * w0);
  }
  return out;
}

function rotPoly(poly: number[], ang: number): number[] {
  const c = Math.cos(ang), s = Math.sin(ang);
  const o: number[] = [];
  for (let i = 0; i < poly.length; i += 2) o.push(poly[i] * c - poly[i + 1] * s, poly[i] * s + poly[i + 1] * c);
  return o;
}

/** A hex bolt head: a six-sided prism standing out of the wheel along +x, only its outer face capped (the rest is never seen). */
function hexBolt(pb: PartBuilder, x0: number, y: number, z: number, r0: number, r1: number, h: number): void {
  const ring = (x: number, r: number): V3[] => {
    const o: V3[] = [];
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      o.push([x, y + Math.cos(a) * r, z + Math.sin(a) * r]);
    }
    return o;
  };
  pb.loft([ring(x0, r0), ring(x0 + h, r1)], { capEnd: true });
}

/** How tall the lugs of the all-terrain tyre stand over the floor of its grooves (m). */
const AT_LUG = 0.017;

/** Lug blocks per row round the tyre, by quality. */
const AT_PITCH: Record<QualityLevel, number> = { low: 18, medium: 21, high: 24, ultra: 28 };

/**
 * One lug: a prism whose cross-section (the closed polygon `poly` in (x, r); the first `nTop` points are the top surface, the rest
 * is the base sunk into the carcass) is swept between two angles, the section sheared by `skew` (rad per metre across the tyre) so
 * the block leans. `rnd` is a per-block number the shader uses to vary the wear. Smooth normals round the edges a little, the
 * base ring is darkened (ambient occlusion) so the grooves read as deep.
 */
function addLug(pb: PartBuilder, poly: ReadonlyArray<readonly [number, number]>, nTop: number, th0: number, th1: number, skew: number, rnd: number, rimR: number, h: number): void {
  const np = poly.length;
  const ring = (th: number): V3[] =>
    poly.map(([x, r]) => {
      const a = th + skew * x;
      return [x, Math.cos(a) * r, Math.sin(a) * r] as V3;
    });
  const v0 = pb.vertexCount;
  pb.loft([ring(th0), ring(th1)], { capStart: true, capEnd: true });
  const v1 = pb.vertexCount;
  setZ(pb, v0, v1, 13, 21);
  // how far up the block a point is (0 base .. 1 top), for the dust and the occlusion; the ends' caps repeat the two rings
  const mark = (vi: number, q: number): void => {
    const top = q < nTop ? 1 : 0;
    pb.zon[vi * 16 + 0] = rnd;
    pb.zon[vi * 16 + 1] = top;
    pb.zon[vi * 16 + 12] = 0.32 + 0.68 * top;
  };
  for (let r = 0; r < 2; r++) for (let q = 0; q < np; q++) mark(v0 + r * np + q, q);
  let o = v0 + 2 * np;
  for (let c = 0; c < 2; c++) {
    mark(o, 0);
    pb.zon[o * 16 + 1] = 0.5;
    pb.zon[o * 16 + 12] = 0.7;
    for (let q = 0; q < np; q++) mark(o + 1 + q, q);
    o += 1 + np;
  }
  void rimR;
  void h;
}

/**
 * An all-terrain tyre: a smooth carcass (its crown is the floor of the grooves) carrying real lugs, so the silhouette is cut
 * like a saw: a centre row of blocks, two staggered rows beside it and shoulder blocks that wrap over the edge and bite
 * into the sidewall, each row angled and out of step with the next. Carcass vertices carry zone channel 14 = -1 so the shader
 * knows not to paint its own grooves on them.
 */
function buildAllTerrainTire(pb: PartBuilder, p: WheelParams, segs: number): void {
  const { R, W, rimR } = p;
  const h = R - rimR;
  const gH = AT_LUG;
  // ── carcass ────────────────────────────────────────────────────────────────
  {
    const half: Array<[number, number]> = [
      [0, R - gH],
      [0.14 * W, R - gH],
      [0.3 * W, R - gH - 0.002],
      [0.4 * W, R - gH - 0.011],
    ];
    const steps = p.quality === 'low' ? 3 : p.quality === 'medium' ? 4 : 5;
    const rTop = R - 0.034;
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const r = rTop + (rimR + 0.006 - rTop) * f;
      const x = 0.5 * W * (0.9 + 0.1 * Math.sin(Math.PI * (0.14 + 0.86 * f)));
      half.push([x, r]);
    }
    const prof: Array<[number, number]> = [];
    const sw0 = 4;
    const inner = [half[half.length - 1], half[Math.min(sw0 + 4, half.length - 1)], half[sw0]];
    for (const [x, r] of inner) prof.push([-x, r]);
    for (let i = 3; i >= 1; i--) prof.push([-half[i][0], half[i][1]]);
    for (let i = 0; i < half.length; i++) prof.push(half[i]);
    const v0 = revolveX(pb, prof, segs);
    setZ(pb, v0, v0 + prof.length * segs, 13, PART.tire);
    setZ(pb, v0, v0 + prof.length * segs, 14, -1);
    for (let r = 0; r < prof.length; r++) {
      const [x, rad] = prof[r];
      const side = Math.abs(x) > 0.42 * W ? 1 : 0;
      const f = (rad - rimR) / h;
      for (let s = 0; s < segs; s++) {
        const i = v0 + r * segs + s;
        pb.zon[i * 16 + 0] = s / segs;
        pb.zon[i * 16 + 1] = f;
        pb.zon[i * 16 + 2] = side;
        pb.zon[i * 16 + 3] = x / W;
        pb.zon[i * 16 + 12] = side ? 0.55 + 0.45 * Math.min(1, Math.max(0, f * 1.6)) : 0.7;
      }
    }
  }

  // ── lugs ───────────────────────────────────────────────────────────────────
  // the crown of an ordinary tyre: the envelope the tops of the blocks follow
  const E = (ax: number): number => {
    const u = ax / W;
    if (u < 0.14) return R + 0.0008 - 0.0008 * (u / 0.14);
    if (u < 0.3) return R - 0.002 * ((u - 0.14) / 0.16);
    return R - 0.002 - 0.009 * ((u - 0.3) / 0.1);
  };
  const sink = gH + 0.006;
  const N = AT_PITCH[p.quality];
  const pitch = (Math.PI * 2) / N;
  const rows = p.quality === 'low' ? 1 : 2;
  let seed = 7;
  const rnd = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
  // centre row
  {
    const poly: Array<[number, number]> = [[-0.021, E(0.021)], [0, E(0)], [0.021, E(0.021)], [0.021, E(0.021) - sink], [-0.021, E(0.021) - sink]];
    for (let i = 0; i < N; i++) {
      const c = i * pitch;
      addLug(pb, poly, 3, c - pitch * 0.25, c + pitch * 0.25, 0, rnd(), rimR, h);
    }
  }
  // intermediate rows (skipped at low quality)
  if (rows > 1) {
    for (const sg of [-1, 1]) {
      const x0 = 0.034, x1 = 0.079;
      const poly: Array<[number, number]> = [[sg * x0, E(x0)], [sg * x1, E(x1)], [sg * x1, E(x1) - sink], [sg * x0, E(x0) - sink]];
      for (let i = 0; i < N; i++) {
        const c = (i + 0.5) * pitch;
        addLug(pb, poly, 2, c - pitch * 0.24, c + pitch * 0.24, sg * 1.8, rnd(), rimR, h);
      }
    }
  }
  // shoulder blocks: over the edge of the tread and down the sidewall
  for (const sg of [-1, 1]) {
    const top: Array<[number, number]> = [
      [0.09, E(0.09) - 0.001],
      [0.122, E(0.122) - 0.001],
      [0.145, R - 0.0235],
      [0.1645, R - 0.0475],
      [0.1715, R - 0.0745],
    ];
    // sunk by 2.3 cm on the crown, less down the sidewall, along the inward normal of the path
    const depth = [sink, sink, 0.019, 0.017, 0.017];
    const base: Array<[number, number]> = top.map(([x, r], i) => {
      const a = top[Math.max(i - 1, 0)], b = top[Math.min(i + 1, top.length - 1)];
      const tx = b[0] - a[0], tr = b[1] - a[1];
      const tl = Math.hypot(tx, tr) || 1;
      // outward normal of the path (x growing, r falling): (-tr, tx) / |t|
      return [x - (-tr / tl) * depth[i], r - (tx / tl) * depth[i]];
    });
    const poly: Array<[number, number]> = [...top, base[4], base[2], base[0]].map(([x, r]) => [sg * x, r] as [number, number]);
    for (let i = 0; i < N; i++) {
      const c = (i + (sg > 0 ? 0.25 : 0.75)) * pitch;
      addLug(pb, poly, top.length, c - pitch * 0.27, c + pitch * 0.27, sg * 1.2, rnd(), rimR, h);
    }
  }
}

export function buildWheel(p: WheelParams): PartBuilder {
  const pb = new PartBuilder();
  const segs = SEGS[p.quality];
  const { R, W, rimR } = p;
  const lay = wheelLayout(p);
  const xo = 0.43 * W;
  const h = R - rimR;

  // ── tire ──────────────────────────────────────────────────────────────────
  if (p.style === 'beadlock') buildAllTerrainTire(pb, p, segs);
  else {
    const half: Array<[number, number]> = [
      [0, R + 0.0008],
      [0.14 * W, R],
      [0.3 * W, R - 0.002],
      [0.4 * W, R - 0.011],
    ];
    const steps = p.quality === 'low' ? 4 : p.quality === 'medium' ? 5 : 7;
    const rTop = R - 0.026;
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const r = rTop + (rimR + 0.006 - rTop) * f;
      const x = 0.5 * W * (0.9 + 0.1 * Math.sin(Math.PI * (0.14 + 0.86 * f)));
      half.push([x, r]);
    }
    const prof: Array<[number, number]> = [];
    // inner side: a coarse sidewall (hidden behind the rim from almost every angle) + the tread edge
    const sw0 = 4; // first sidewall index in `half`
    const inner = [half[half.length - 1], half[Math.min(sw0 + 4, half.length - 1)], half[sw0]];
    for (const [x, r] of inner) prof.push([-x, r]);
    for (let i = 3; i >= 1; i--) prof.push([-half[i][0], half[i][1]]);
    for (let i = 0; i < half.length; i++) prof.push(half[i]);
    const v0 = revolveX(pb, prof, segs);
    const nv = prof.length * segs;
    setZ(pb, v0, v0 + nv, 13, PART.tire);
    // region flag: tread vs sidewall, and radial/angle params for the shader
    const np = prof.length;
    for (let r = 0; r < np; r++) {
      const [x, rad] = prof[r];
      const side = Math.abs(x) > 0.42 * W ? 1 : 0;
      const f = (rad - rimR) / h;
      for (let s = 0; s < segs; s++) {
        const i = v0 + r * segs + s;
        pb.zon[i * 16 + 0] = s / segs; // u around
        pb.zon[i * 16 + 1] = f; // radial fraction
        pb.zon[i * 16 + 2] = side;
        pb.zon[i * 16 + 3] = x / W; // lateral
        // darker near the bead
        pb.zon[i * 16 + 12] = side ? 0.55 + 0.45 * Math.min(1, Math.max(0, f * 1.6)) : 1;
      }
    }
  }

  // ── rim barrel (inner surface visible between the spokes) ────────────────
  {
    const prof: Array<[number, number]> = [
      [-xo + 0.004, rimR + 0.012],
      [-xo + 0.012, rimR - 0.012],
      [-0.3 * xo, rimR - 0.032],
      [0.4 * xo, rimR - 0.03],
      [xo - 0.014, rimR - 0.008],
      [xo - 0.006, rimR + 0.008],
      [xo + 0.001, rimR + 0.0125],
      [xo + 0.0065, rimR + 0.009],
      [xo + 0.0075, rimR + 0.002],
      [xo + 0.004, rimR - 0.003],
    ];
    const v0 = revolveX(pb, prof, segs);
    setZ(pb, v0, v0 + prof.length * segs, 13, PART.rimBarrel);
    setZ(pb, v0, v0 + prof.length * segs, 12, 0.5);
  }

  // ── spokes ────────────────────────────────────────────────────────────────
  const xOut = lay.xOut;
  const dpt = p.style === 'centerlock' ? 0.026 : p.style === 'beadlock' ? 0.032 : 0.021;
  const frame: Frame = { o: [xOut - dpt, 0, 0], u: [0, 1, 0], v: [0, 0, 1] };
  const rIn = 0.05;
  const rEnd = rimR - 0.006;
  const addSpoke = (poly: number[]): void => {
    const v0 = pb.vertexCount;
    pb.extrude(poly, frame, dpt, 0.0035, p.quality === 'ultra' ? 3 : 2);
    setZ(pb, v0, pb.vertexCount, 13, PART.rimFace);
    setZ(pb, v0, pb.vertexCount, 12, 0.85);
  };
  switch (p.style) {
    case 'multi': {
      const n = 10;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2;
        addSpoke(rotPoly(spokePoly(rIn, rEnd, 0.0125, 0.0105, 0.016, 1, 8), ang));
      }
      break;
    }
    case 'split5': {
      const n = 5;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2;
        const rs = rIn + (rEnd - rIn) * 0.55;
        addSpoke(rotPoly(spokePoly(rIn, rs + 0.012, 0.021, 0.018, 0, 1, 5), ang));
        for (const sgn of [-1, 1]) {
          const branch = spokePoly(rs, rEnd, 0.0165, 0.012, 0, 1, 6).map((v, k) => v);
          // diverge: add tangential offset growing with radius
          for (let k = 0; k < branch.length; k += 2) {
            const t = Math.max(0, (branch[k] - rs) / (rEnd - rs));
            branch[k + 1] += sgn * (0.012 + 0.048 * t);
          }
          addSpoke(rotPoly(branch, ang));
        }
      }
      break;
    }
    case 'six': {
      const n = 6;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2;
        addSpoke(rotPoly(spokePoly(rIn, rEnd, 0.016, 0.034, 0, 1.6, 8), ang));
      }
      break;
    }
    case 'beadlock': {
      // eight heavy wedge spokes, narrow at the hub and broad where they meet the barrel
      const n = 8;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2;
        addSpoke(rotPoly(spokePoly(0.07, rEnd, 0.027, 0.05, 0, 1.3, 4), ang));
      }
      break;
    }
    case 'centerlock': {
      const n = 5;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2;
        addSpoke(rotPoly(spokePoly(0.045, rEnd, 0.03, 0.062, 0.03, 1.2, 8), ang));
      }
      break;
    }
  }
  // rim lip ring: thin annulus at the spoke tips so the lip reads as a polished edge
  {
    const prof: Array<[number, number]> = [
      [xo + 0.0005, rimR + 0.0105],
      [xo - 0.001, rimR - 0.004],
      [xOut - dpt * 0.5, rimR - 0.007],
    ];
    const v0 = revolveX(pb, prof, segs);
    setZ(pb, v0, v0 + prof.length * segs, 13, PART.rimFace);
    setZ(pb, v0, v0 + prof.length * segs, 12, 0.9);
  }

  // beadlock: a broad retaining ring on the outer lip, held by a ring of bolts (the 4x4's look: raw hardware on the rim's face)
  if (p.style === 'beadlock') {
    const ring: Array<[number, number]> = [
      [xo - 0.018, rimR - 0.036],
      [xo + 0.001, rimR - 0.036],
      [xo + 0.0045, rimR - 0.03],
      [xo + 0.0045, rimR + 0.004],
      [xo + 0.001, rimR + 0.0115],
      [xo - 0.018, rimR + 0.0115],
    ];
    const rs = Math.min(segs, 48);
    const v0 = revolveX(pb, ring, rs);
    setZ(pb, v0, v0 + ring.length * rs, 13, PART.rimFace);
    setZ(pb, v0, v0 + ring.length * rs, 12, 0.9);
    const nb = p.quality === 'low' ? 12 : p.quality === 'medium' ? 18 : 24;
    for (let i = 0; i < nb; i++) {
      const a = ((i + 0.5) / nb) * Math.PI * 2;
      const cy = Math.cos(a) * (rimR - 0.0125), cz = Math.sin(a) * (rimR - 0.0125);
      const nv0 = pb.vertexCount;
      hexBolt(pb, xo + 0.004, cy, cz, 0.0078, 0.0072, 0.0085);
      setZ(pb, nv0, pb.vertexCount, 13, PART.nut);
    }
  }

  // ── hub, centre cap, lug nuts ─────────────────────────────────────────────
  {
    const x0 = xOut - dpt;
    const prof: Array<[number, number]> = [
      [x0 - 0.02, 0.066],
      [x0 - 0.002, 0.066],
      [xOut + 0.001, 0.062],
      [xOut + 0.0065, 0.056],
      [xOut + 0.008, 0.044],
      [xOut + 0.0095, 0.0],
    ];
    const v0 = revolveX(pb, prof, 40);
    // (the beadlock's centre cap is satin black like its spokes: a polished one only reflected the white of the studio)
    setZ(pb, v0, v0 + prof.length * 40, 13, p.style === 'beadlock' ? PART.rimFace : PART.hub);
    setZ(pb, v0, v0 + prof.length * 40, 12, 0.9);
    if (p.style === 'centerlock') {
      // big knurled centre-lock nut
      const nProf: Array<[number, number]> = [
        [xOut + 0.001, 0.05],
        [xOut + 0.028, 0.05],
        [xOut + 0.032, 0.042],
        [xOut + 0.034, 0.0],
      ];
      const nv0 = revolveX(pb, nProf, 6);
      setZ(pb, nv0, nv0 + nProf.length * 6, 13, PART.nut);
    } else {
      // (the beadlock's eight nuts sit on the roots of its eight spokes)
      const bl = p.style === 'beadlock';
      const nn = bl ? 8 : 5;
      for (let i = 0; i < nn; i++) {
        const a = (i / nn) * Math.PI * 2 + (bl ? 0 : 0.31);
        const rn = bl ? 0.083 : 0.052;
        const cy = Math.cos(a) * rn, cz = Math.sin(a) * rn;
        const nv0 = pb.vertexCount;
        if (bl) hexBolt(pb, xOut + 0.004, cy, cz, 0.0105, 0.0095, 0.0085);
        else pb.cylinder([xOut + 0.004, cy, cz], [xOut + 0.0125, cy, cz], 0.0105, 0.0095, 6, true);
        setZ(pb, nv0, pb.vertexCount, 13, PART.nut);
      }
    }
  }

  // ── brake disc + hat ──────────────────────────────────────────────────────
  {
    const { xDisc, discInner, discOuter, discHalf } = lay;
    const discSegs = Math.max(40, Math.floor(segs * 0.7));
    for (const sgn of [-1, 1]) {
      const v0 = revolveX(pb, [[xDisc + sgn * discHalf, discInner], [xDisc + sgn * discHalf, discOuter]], discSegs);
      setZ(pb, v0, v0 + 2 * discSegs, 13, PART.disc);
      // polar coords for the drilled/vented pattern in the shader
      for (let r = 0; r < 2; r++) {
        for (let s = 0; s < discSegs; s++) {
          const i = v0 + r * discSegs + s;
          pb.zon[i * 16 + 0] = s / discSegs;
          pb.zon[i * 16 + 1] = r;
          pb.zon[i * 16 + 12] = sgn > 0 ? 0.55 : 0.4;
        }
      }
    }
    // outer + inner edge
    for (const rad of [discOuter, discInner]) {
      const v0 = revolveX(pb, [[xDisc - discHalf, rad], [xDisc + discHalf, rad]], discSegs);
      setZ(pb, v0, v0 + 2 * discSegs, 13, PART.disc);
      setZ(pb, v0, v0 + 2 * discSegs, 1, 0.5);
      setZ(pb, v0, v0 + 2 * discSegs, 12, 0.5);
    }
    // hat
    const v0 = revolveX(pb, [[xDisc + discHalf, discInner - 0.005], [xDisc + 0.004, discInner - 0.015], [xOut - dpt - 0.006, 0.085], [xOut - dpt - 0.002, 0.0]], 40);
    setZ(pb, v0, v0 + 4 * 40, 13, PART.discHat);
    setZ(pb, v0, v0 + 4 * 40, 12, 0.4);
  }

  // ── motion-blur disc (visible only when the wheel is spinning fast) ───────
  {
    const v0 = revolveX(pb, [[xOut + 0.0045, 0.0], [xOut + 0.0015, rimR - 0.012], [xo - 0.002, rimR + 0.004]], 32);
    setZ(pb, v0, v0 + 3 * 32, 13, PART.blurDisc);
    for (let r = 0; r < 3; r++) for (let s = 0; s < 32; s++) pb.zon[(v0 + r * 32 + s) * 16 + 1] = r === 0 ? 0 : r === 1 ? (rimR - 0.012) / rimR : 1;
    setZ(pb, v0, v0 + 3 * 32, 12, 0.9);
  }
  return pb;
}

/** Non-spinning brake caliper + dust shield. In the wheel frame (+X outward), unrotated. */
export function buildCaliper(p: WheelParams, trailing: boolean): PartBuilder {
  const pb = new PartBuilder();
  const lay = wheelLayout(p);
  const { xDisc, discOuter, discHalf } = lay;
  // dust shield: dark plate behind the disc
  {
    const v0 = pb.vertexCount;
    pb.lathe([xDisc - discHalf - 0.012, 0, 0], [1, 0, 0], [0.0, 0.0, discOuter + 0.004, 0.0, discOuter + 0.004, -0.004], 40);
    setZ(pb, v0, pb.vertexCount, 13, PART.shield);
    setZ(pb, v0, pb.vertexCount, 12, 0.45);
  }
  // caliper: arc block straddling the disc rim
  const a0 = trailing ? Math.PI - 0.38 : 0.38; // arc centre angle (rad) from +Z toward +Y
  const spread = 0.78;
  const rIn = discOuter - 0.07;
  const rOut = discOuter + 0.03;
  const poly: number[] = [];
  const n = 10;
  for (let i = 0; i <= n; i++) {
    const a = a0 - spread / 2 + (spread * i) / n;
    poly.push(Math.cos(a) * rOut, Math.sin(a) * rOut);
  }
  for (let i = n; i >= 0; i--) {
    const a = a0 - spread / 2 + (spread * i) / n;
    poly.push(Math.cos(a) * rIn, Math.sin(a) * rIn);
  }
  // polygon is in (z, y): u=Z axis, v=Y axis => w = u x v = -X ; flip by using u=Y, v=Z mapping
  const poly2: number[] = [];
  for (let i = 0; i < poly.length; i += 2) poly2.push(poly[i + 1], poly[i]); // (y, z)
  const frame: Frame = { o: [xDisc - discHalf - 0.032, 0, 0], u: [0, 1, 0], v: [0, 0, 1] };
  const v0 = pb.vertexCount;
  pb.extrude(poly2, frame, 2 * discHalf + 0.064, 0.008, 3);
  setZ(pb, v0, pb.vertexCount, 13, PART.caliper);
  setZ(pb, v0, pb.vertexCount, 12, 0.85);
  return pb;
}

export function styleForBody(style: string): WheelStyle {
  switch (style) {
    case 'gt':
      return 'multi';
    case 'hatch':
      return 'split5';
    case 'coupe':
      return 'six';
    case 'suv':
      return 'beadlock';
    default:
      return 'centerlock';
  }
}

export { frameFromAxis };
