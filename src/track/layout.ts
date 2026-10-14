/**
 * Polygon layout: author a circuit as a closed polygon of corner vertices (in MAP coordinates:
 * east right, north up, metres) with a radius per vertex. Every vertex becomes a clothoid corner;
 * the straights are whatever remains of the polygon edges, so the loop closes exactly by construction.
 *
 * Map -> world: x = -east, z = north (heading phi = 0 points north; left turns are counter-clockwise).
 */
import { DEG } from './math';
import { cornerTangents } from './plan';
import type { PlanEl, TurnEl } from './types';

export interface Vtx extends Partial<Omit<TurnEl, 'k' | 'n' | 'a' | 'r'>> {
  /** East / north in metres (map frame). */
  e: number;
  n: number;
  /** Corner radius (m). */
  r: number;
  name?: string;
}

export interface LayoutOptions {
  /** Distance (m) from the exit of the last corner to the start/finish line. */
  sfAfterLastCorner: number;
  /** Throw on overlapping corners (default true). Design tools pass false to inspect the numbers. */
  strict?: boolean;
}

function wrapPi(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export interface LayoutReport {
  plan: PlanEl[];
  /** Start/finish line in world coordinates (x, z) with heading phi (0 = +Z). Pass to TrackDef.start. */
  start: { x: number; z: number; phi: number };
  corners: { name: string; angDeg: number; r: number; ts: number; te: number }[];
  /** Straight lengths by name (for diagnostics). */
  straights: { name: string; len: number }[];
}

export function polyPlan(verts: Vtx[], opts: LayoutOptions): PlanEl[] {
  return polyLayout(verts, opts).plan;
}

export function polyLayout(verts: Vtx[], opts: LayoutOptions): LayoutReport {
  const n = verts.length;
  const P = verts.map((v) => ({ x: -v.e, z: v.n }));
  // heading of edge i: from vertex i to i+1
  const edgePhi: number[] = [];
  const edgeLen: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = P[i];
    const b = P[(i + 1) % n];
    edgePhi.push(Math.atan2(b.x - a.x, b.z - a.z));
    edgeLen.push(Math.hypot(b.x - a.x, b.z - a.z));
  }
  const turns: { angDeg: number; ts: number; te: number }[] = [];
  for (let i = 0; i < n; i++) {
    const phiIn = edgePhi[(i - 1 + n) % n];
    const phiOut = edgePhi[i];
    const th = wrapPi(phiOut - phiIn);
    const angDeg = th / DEG;
    const v = verts[i];
    const tg = cornerTangents(angDeg, v.r, v.r2, v.ls, v.lsIn, v.lsOut);
    turns.push({ angDeg, ts: tg.ts, te: tg.te });
  }
  const names = verts.map((v, i) => v.name ?? `T${i + 1}`);
  const plan: PlanEl[] = [];
  const straights: { name: string; len: number }[] = [];
  // straight between corner i and i+1 (edge i)
  const sLen = (i: number) => edgeLen[i] - turns[i].te - turns[(i + 1) % n].ts;
  const last = n - 1;
  const mainTotal = sLen(last);
  if (mainTotal < opts.sfAfterLastCorner + 20 && opts.strict !== false) throw new Error(`main straight too short (${mainTotal.toFixed(0)} m)`);
  plan.push({ k: 'S', n: 'main', len: mainTotal - opts.sfAfterLastCorner });
  straights.push({ name: 'main', len: mainTotal });
  for (let i = 0; i < n; i++) {
    const { r, name: _n, e: _e, n: _nn, ...rest } = verts[i];
    void _n;
    void _e;
    void _nn;
    plan.push({ k: 'T', n: names[i], a: turns[i].angDeg, r, ...(rest as object) } as TurnEl);
    if (i < last) {
      const len = sLen(i);
      if (len < -0.01 && opts.strict !== false) throw new Error(`corners ${names[i]} and ${names[i + 1]} overlap by ${(-len).toFixed(1)} m`);
      straights.push({ name: `S${i + 1}`, len });
      if (len > 0.5) plan.push({ k: 'S', n: `S${i + 1}`, len });
    }
  }
  plan.push({ k: 'S', n: 'main0', len: opts.sfAfterLastCorner });
  const corners = verts.map((v, i) => ({ name: names[i], angDeg: turns[i].angDeg, r: v.r, ts: turns[i].ts, te: turns[i].te }));
  const lastP = P[last];
  const phiMain = edgePhi[last];
  const along = turns[last].te + opts.sfAfterLastCorner;
  const start = { x: lastP.x + Math.sin(phiMain) * along, z: lastP.z + Math.cos(phiMain) * along, phi: phiMain };
  return { plan, straights, corners, start };
}

// ─────────────────────────────────────────────────────────────────────────────
// Turtle front-end: specify corner deflections and edge lengths; two edges are solved so the loop closes.
// ─────────────────────────────────────────────────────────────────────────────

export interface TStep extends Partial<Omit<TurnEl, 'k' | 'n' | 'a' | 'r'>> {
  name?: string;
  /** Deflection in degrees (+ = left). 'auto' = whatever brings the total to +-360. */
  defl: number | 'auto';
  r: number;
  /** Distance from the previous vertex to this vertex (ignored for the first step). 'join' = zero-length straight between the corners. */
  len?: number | 'join';
  /** Edge length solved for closure (exactly two steps). */
  free?: boolean;
}

export interface TurtleOptions {
  /** Distance from the last vertex to the first vertex (the main straight, vertex to vertex). */
  mainLen: number;
  /** Map position of the first vertex (T1). */
  origin: { e: number; n: number };
  dir?: 1 | -1;
}

export function turtleVerts(steps: TStep[], opts: TurtleOptions): Vtx[] {
  const dir = opts.dir ?? 1;
  const n = steps.length;
  const sumFixed = steps.reduce((a, s) => a + (typeof s.defl === 'number' ? s.defl : 0), 0);
  const defl = steps.map((s) => (s.defl === 'auto' ? dir * 360 - sumFixed : s.defl));
  // compass headings: after vertex i the edge heading is 90 - sum(defl[0..i])
  const heading: number[] = [];
  let acc = 90;
  for (let i = 0; i < n; i++) {
    acc -= defl[i];
    heading.push(acc);
  }
  const hr = heading.map((h) => h * DEG);
  const tang = steps.map((s, i) => cornerTangents(Math.abs(defl[i]), s.r, s.r2, s.ls, s.lsIn, s.lsOut));
  const lens = steps.map((s, i) => (s.len === 'join' ? tang[i - 1].te + tang[i].ts : (s.len ?? 0)));
  const free = steps.map((s, i) => (s.free ? i : -1)).filter((i) => i >= 0);
  if (free.length !== 2) throw new Error('turtle layout needs exactly two free edges');
  // Edge into vertex i (i>=1) has heading[i-1].
  let ef = 0;
  let nf = 0;
  for (let i = 1; i < n; i++) {
    if (free.includes(i)) continue;
    ef += lens[i] * Math.sin(hr[i - 1]);
    nf += lens[i] * Math.cos(hr[i - 1]);
  }
  // closure: sum(edges) + mainLen * (1, 0) = 0  (last vertex lies mainLen west of V0 on the east-west line)
  const mainDirE = Math.sin(heading[n - 1] * DEG);
  const mainDirN = Math.cos(heading[n - 1] * DEG);
  // The main straight leaves the last vertex with heading[n-1] (should equal the entry heading, 90 deg).
  const a = free[0];
  const b = free[1];
  const sa = Math.sin(hr[a - 1]);
  const ca = Math.cos(hr[a - 1]);
  const sb = Math.sin(hr[b - 1]);
  const cb = Math.cos(hr[b - 1]);
  const rhsE = -ef - opts.mainLen * mainDirE;
  const rhsN = -nf - opts.mainLen * mainDirN;
  const det = sa * cb - sb * ca;
  if (Math.abs(det) < 0.15) throw new Error(`free edges nearly parallel (det ${det.toFixed(3)})`);
  lens[a] = (rhsE * cb - sb * rhsN) / det;
  lens[b] = (sa * rhsN - ca * rhsE) / det;
  if (lens[a] < 20 || lens[b] < 20) {
    // still return the geometry so the caller can print it
    // eslint-disable-next-line no-console
    console.warn(`turtle: free edges ${steps[a].name ?? a}=${lens[a].toFixed(0)} ${steps[b].name ?? b}=${lens[b].toFixed(0)}`);
  }
  const verts: Vtx[] = [];
  let e = opts.origin.e;
  let nn = opts.origin.n;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      e += lens[i] * Math.sin(hr[i - 1]);
      nn += lens[i] * Math.cos(hr[i - 1]);
    }
    const { name, defl: _d, r, len: _l, free: _f, ...rest } = steps[i];
    void _d;
    void _l;
    void _f;
    verts.push({ e, n: nn, r, name: name ?? `T${i + 1}`, ...rest });
  }
  return verts;
}
