/**
 * Plan geometry: straights + turns with clothoid transitions, closed exactly by solving the lengths
 * of the "free" straights. Everything is arc-length parametrised, so samples come out evenly spaced.
 *
 * Heading convention: phi = 0 points along +Z; the horizontal tangent is (sin phi, cos phi); the
 * horizontal LEFT vector is (cos phi, -sin phi) = (tz, -tx). Curvature > 0 turns LEFT (phi grows).
 */
import { DEG, TAU, mod } from './math';
import type { Mark, PlanEl, TurnEl } from './types';

export interface Prim {
  n: string;
  kind: 'S' | 'in' | 'arc' | 'out';
  len: number;
  k0: number;
  k1: number;
  s0: number;
  phi0: number;
  free: boolean;
}

export interface CornerInfo {
  name: string;
  /** +1 left, -1 right. */
  dir: 1 | -1;
  angle: number; // radians, absolute
  radius: number;
  sStart: number;
  sArcA: number;
  sArcB: number;
  sEnd: number;
  el: TurnEl;
}

export interface PlanResult {
  prims: Prim[];
  length: number;
  marks: Map<string, number>;
  corners: CornerInfo[];
  closureError: number;
  /** Total heading change (rad). */
  totalTurn: number;
}

function defaultSpiral(r: number): number {
  return Math.max(10, Math.min(70, r * 0.55));
}

/** Primitives (clothoid in, arc/ramp, clothoid out) for one turn of signed angle `ang` (radians). */
export function turnPrims(name: string, ang: number, r1: number, r2: number, ls: number | undefined, lsIn?: number, lsOut?: number): Prim[] {
  const sg = ang >= 0 ? 1 : -1;
  const th = Math.abs(ang);
  const dflt = ls ?? defaultSpiral(Math.min(r1, r2));
  let lsA = lsIn ?? dflt;
  let lsB = lsOut ?? dflt;
  const kA = sg / r1;
  const kB = sg / r2;
  // Heading budget: in-spiral lsA/(2 r1), ramp La (1/r1 + 1/r2)/2, out-spiral lsB/(2 r2); keep the spirals under 70 % of it.
  const spiralTurn0 = lsA / (2 * r1) + lsB / (2 * r2);
  if (spiralTurn0 > th * 0.7) {
    const f = (th * 0.7) / spiralTurn0;
    lsA *= f;
    lsB *= f;
  }
  const spiralTurn = lsA / (2 * r1) + lsB / (2 * r2);
  const la = (2 * (th - spiralTurn)) / (1 / r1 + 1 / r2);
  const out: Prim[] = [];
  if (lsA > 0.01) out.push({ n: name, kind: 'in', len: lsA, k0: 0, k1: kA, s0: 0, phi0: 0, free: false });
  out.push({ n: name, kind: 'arc', len: la, k0: kA, k1: kB, s0: 0, phi0: 0, free: false });
  if (lsB > 0.01) out.push({ n: name, kind: 'out', len: lsB, k0: kB, k1: 0, s0: 0, phi0: 0, free: false });
  return out;
}

/**
 * Tangent lengths of a corner: distances from the corner start to the vertex (ts) and from the vertex to the
 * corner end (te), where the vertex is the intersection of the entering and exiting straights.
 */
export function cornerTangents(angDeg: number, r1: number, r2: number | undefined, ls: number | undefined, lsIn?: number, lsOut?: number): { ts: number; te: number; length: number } {
  const ang = Math.abs(angDeg) * DEG;
  const ps = turnPrims('c', ang, r1, r2 ?? r1, ls, lsIn, lsOut);
  layout(ps);
  const e = integrateEnd(ps);
  // Local frame: start at (0,0) heading +Z, curving LEFT (toward +X). The vertex lies on the Z axis.
  const sin = Math.sin(ang);
  const cos = Math.cos(ang);
  const u = -e.x / sin;
  const te = -u;
  const vz = e.z + u * cos;
  const length = ps.reduce((acc, p) => acc + p.len, 0);
  return { ts: vz, te, length };
}

function primsFor(plan: PlanEl[], dir: 1 | -1): Prim[] {
  // resolve the 'auto' angle
  let explicit = 0;
  let autoIdx = -1;
  plan.forEach((el, i) => {
    if (el.k !== 'T') return;
    if (el.a === 'auto') {
      if (autoIdx >= 0) throw new Error('only one auto turn allowed');
      autoIdx = i;
    } else explicit += el.a * DEG;
  });
  const autoAngle = dir * TAU - explicit;
  const prims: Prim[] = [];
  plan.forEach((el, i) => {
    if (el.k === 'S') {
      if (el.len > 1e-6) prims.push({ n: el.n, kind: 'S', len: el.len, k0: 0, k1: 0, s0: 0, phi0: 0, free: !!el.free });
      return;
    }
    const ang = i === autoIdx ? autoAngle : (el.a as number) * DEG;
    prims.push(...turnPrims(el.n, ang, el.r, el.r2 ?? el.r, el.ls, el.lsIn, el.lsOut));
  });
  return prims;
}

/** Heading at offset u into a primitive. */
function headingIn(p: Prim, u: number): number {
  return p.phi0 + p.k0 * u + ((p.k1 - p.k0) * u * u) / (2 * p.len);
}
function curvIn(p: Prim, u: number): number {
  return p.k0 + ((p.k1 - p.k0) * u) / p.len;
}

function layout(prims: Prim[]): number {
  let s = 0;
  let phi = 0;
  for (const p of prims) {
    p.s0 = s;
    p.phi0 = phi;
    s += p.len;
    phi += (p.k0 + p.k1) * 0.5 * p.len;
  }
  return s;
}

/** Integrate the plan from (0,0,phi=0); returns the end point. Simpson, ~0.5 m steps. */
function integrateEnd(prims: Prim[]): { x: number; z: number; phi: number } {
  let x = 0;
  let z = 0;
  let phi = 0;
  for (const p of prims) {
    const n = Math.max(2, Math.ceil(p.len / 0.5));
    const h = p.len / n;
    for (let i = 0; i < n; i++) {
      const u0 = i * h;
      const a0 = headingIn(p, u0);
      const am = headingIn(p, u0 + h / 2);
      const a1 = headingIn(p, u0 + h);
      x += (h / 6) * (Math.sin(a0) + 4 * Math.sin(am) + Math.sin(a1));
      z += (h / 6) * (Math.cos(a0) + 4 * Math.cos(am) + Math.cos(a1));
    }
    phi = headingIn(p, p.len);
  }
  return { x, z, phi };
}

export function buildPlan(plan: PlanEl[], dir: 1 | -1): PlanResult {
  const prims = primsFor(plan, dir);
  let length = layout(prims);
  const free = prims.filter((p) => p.free);
  if (free.length === 1) throw new Error('plan needs zero (already closed) or at least two free straights');

  let err = Infinity;
  for (let iter = 0; iter < (free.length ? 6 : 0); iter++) {
    const e = integrateEnd(prims);
    err = Math.hypot(e.x, e.z);
    if (err < 1e-4) break;
    // Directions of free straights (heading is independent of lengths)
    const ux: number[] = [];
    const uz: number[] = [];
    for (const p of free) {
      ux.push(Math.sin(p.phi0));
      uz.push(Math.cos(p.phi0));
    }
    // minimal-norm solution of U * delta = -e
    let a = 0;
    let b = 0;
    let d = 0;
    for (let i = 0; i < free.length; i++) {
      a += ux[i] * ux[i];
      b += ux[i] * uz[i];
      d += uz[i] * uz[i];
    }
    const det = a * d - b * b;
    if (Math.abs(det) < 1e-9) throw new Error('free straights are parallel; cannot close the loop');
    // (U U^T)^-1 * (-e)
    const rx = -e.x;
    const rz = -e.z;
    const lx = (d * rx - b * rz) / det;
    const lz = (-b * rx + a * rz) / det;
    for (let i = 0; i < free.length; i++) free[i].len += ux[i] * lx + uz[i] * lz;
    for (const p of free) if (p.len < 5) throw new Error(`free straight '${p.n}' collapsed to ${p.len.toFixed(1)} m: redesign the plan`);
    length = layout(prims);
  }

  // marks and corners
  const marks = new Map<string, number>();
  const corners: CornerInfo[] = [];
  for (const el of plan) {
    const ps = prims.filter((p) => p.n === el.n);
    if (!ps.length) continue;
    const first = ps[0];
    const last = ps[ps.length - 1];
    marks.set(el.n, first.s0);
    marks.set(el.n + '/e', last.s0 + last.len);
    if (el.k === 'S') {
      marks.set(el.n + '/m', first.s0 + first.len / 2);
    } else {
      const arc = ps.find((p) => p.kind === 'arc')!;
      marks.set(el.n + '/a', arc.s0);
      marks.set(el.n + '/m', arc.s0 + arc.len / 2);
      marks.set(el.n + '/b', arc.s0 + arc.len);
      const turn = ps.reduce((acc, p) => acc + (p.k0 + p.k1) * 0.5 * p.len, 0);
      corners.push({
        name: el.n,
        dir: turn >= 0 ? 1 : -1,
        angle: Math.abs(turn),
        radius: Math.min(el.r, el.r2 ?? el.r),
        sStart: first.s0,
        sArcA: arc.s0,
        sArcB: arc.s0 + arc.len,
        sEnd: last.s0 + last.len,
        el,
      });
    }
  }
  const end = integrateEnd(prims);
  return { prims, length, marks, corners, closureError: Math.hypot(end.x, end.z), totalTurn: end.phi };
}

export function resolveMark(marks: Map<string, number>, length: number, m: Mark): number {
  const name = typeof m === 'string' ? m : m[0];
  const off = typeof m === 'string' ? 0 : m[1];
  const v = marks.get(name);
  if (v === undefined) throw new Error(`unknown mark '${name}'`);
  return mod(v + off, length);
}

/** Walks the plan at monotonically increasing s, returning heading / curvature and integrating positions. */
export class PlanSampler {
  private idx = 0;
  constructor(private readonly prims: Prim[], private readonly length: number) {}

  reset(): void {
    this.idx = 0;
  }
  private seek(s: number): Prim {
    const ps = this.prims;
    let i = this.idx;
    if (s < ps[i].s0) i = 0;
    while (i < ps.length - 1 && s >= ps[i].s0 + ps[i].len) i++;
    this.idx = i;
    return ps[i];
  }
  heading(s: number): number {
    const p = this.seek(Math.min(Math.max(s, 0), this.length));
    return headingIn(p, Math.min(Math.max(s - p.s0, 0), p.len));
  }
  curvature(s: number): number {
    const p = this.seek(Math.min(Math.max(s, 0), this.length));
    return curvIn(p, Math.min(Math.max(s - p.s0, 0), p.len));
  }
}
