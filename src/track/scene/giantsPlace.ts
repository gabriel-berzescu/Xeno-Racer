/**
 * Where the giants of an old wood stand (headless: no textures, no scene). Three kinds: the rows close behind the barriers of a
 * road that runs through a grove, so that the road is driven between pillars; the wood itself, scattered at a spacing that opens
 * out toward the edge of each grove; and the lone ones, placed by hand. Under them, young trees (the game's own conifers, given to
 * the tree system) and ferns.
 *
 * No trunk stands on the road or its run-off, in a TV camera's line of sight, on a lamp mast or on anything another builder has
 * claimed (`blocked`), and the tips of the roots keep clear of the barrier's face.
 */
import { Vector3 } from 'three';
import { mulberry32, smoothstep } from '../math';
import { resolveMark } from '../plan';
import type { TrackRuntimeImpl } from '../runtime';
import type { GiantWoodDef, GiantsDef } from '../types';

export interface Giant {
  x: number;
  /** The ground at its foot. */
  y: number;
  z: number;
  /** Height (m), the radius of the trunk above the flare of its roots (m) and how far the roots reach from the axis at the ground (m). */
  h: number;
  r: number;
  root: number;
  yaw: number;
  seed: number;
  /** Metres from the trunk's axis to the nearest barrier's face (behind it), and to the centre line of the road. */
  back: number;
  road: number;
  kind: 'row' | 'wood' | 'lone';
}

/** A young tree under the giants (for the game's tree system) or a fern. */
export interface Under {
  x: number;
  y: number;
  z: number;
  /** Height (m). */
  s: number;
}

/** Asks whether ground is taken: `ground` for anything built there, `view` for a TV camera's line of sight (tall things only). */
export interface Blocked {
  ground(x: number, z: number, margin: number): boolean;
  view(x: number, z: number, margin: number): boolean;
}

/** How far the buttress roots reach, in trunk radii. */
export const ROOT_REACH = 1.75;

const DEFAULTS = {
  spacing: 30,
  height: [90, 130] as [number, number],
  girth: [6, 11] as [number, number],
  rowSpacing: [24, 38] as [number, number],
  rowGap: [1.2, 4] as [number, number],
  young: 1.6,
  ferns: 9,
};

/** How much of the full wood stands at (x, z): 0 outside every grove and in a glade, up to 1. */
export function woodDensity(wood: GiantWoodDef, x: number, z: number): number {
  let d = 0;
  for (const g of wood.groves) {
    const t = Math.hypot(x - g.x, z - g.z) / g.r;
    if (t < 1) d = Math.max(d, (g.density ?? 1) * (1 - smoothstep(0.66, 1, t)));
  }
  if (d > 0) for (const g of wood.glades ?? []) d *= smoothstep(g.r * 0.85, g.r * 1.2, Math.hypot(x - g.x, z - g.z));
  return d;
}

/** Where (x, z) stands to the road: metres behind the nearest barrier's face (negative on the road side of it) and from the centre line. */
export function roadSide(rt: TrackRuntimeImpl, x: number, z: number): { back: number; road: number } {
  const i = rt.nearestSample(x, z);
  const dx = x - rt.X[i];
  const dz = z - rt.Z[i];
  const road = Math.hypot(dx, dz);
  const left = dx * rt.HLX[i] + dz * rt.HLZ[i] >= 0;
  return { back: road - (left ? rt.L : rt.R).wall[i], road };
}

/** The floodlight masts of the circuit (x, z pairs): they stand a little behind the barriers, where the rows want to stand too. */
export function lampMasts(rt: TrackRuntimeImpl): number[] {
  const out: number[] = [];
  for (const L of rt.def.scenery?.lamps ?? []) {
    const i0 = Math.round(resolveMark(rt.plan.marks, rt.length, L.from) / rt.spacing);
    let i1 = Math.round(resolveMark(rt.plan.marks, rt.length, L.to) / rt.spacing);
    if (i1 <= i0) i1 += rt.count;
    const step = Math.max(1, Math.round(L.spacing / rt.spacing));
    let n = 0;
    for (let i = i0; i <= i1; i += step, n++) {
      const sides = L.side === 'B' ? (L.stagger ? [n % 2 ? 1 : -1] : [1, -1]) : [L.side === 'L' ? 1 : -1];
      for (const sgn of sides) {
        const k = ((i % rt.count) + rt.count) % rt.count;
        const d = (sgn > 0 ? rt.L : rt.R).wall[k] + (L.gap ?? 1.6);
        out.push(rt.X[k] + sgn * rt.HLX[k] * d, rt.Z[k] + sgn * rt.HLZ[k] * d);
      }
    }
  }
  return out;
}

/** A grid over points on the map, for "is anything within r of here". */
class Near {
  private readonly cells = new Map<number, number[]>();
  constructor(private readonly cell: number) {}
  private key(ix: number, iz: number): number {
    return ix * 73856093 + iz * 19349663;
  }
  add(x: number, z: number, r: number): void {
    const k = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    const l = this.cells.get(k);
    if (l) l.push(x, z, r);
    else this.cells.set(k, [x, z, r]);
  }
  /** Is a point already here nearer than `gap` plus its own radius and `r`? */
  hit(x: number, z: number, r: number, gap: number, reach: number): boolean {
    const n = Math.ceil(reach / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    for (let ix = cx - n; ix <= cx + n; ix++) {
      for (let iz = cz - n; iz <= cz + n; iz++) {
        const l = this.cells.get(this.key(ix, iz));
        if (!l) continue;
        for (let i = 0; i < l.length; i += 3) {
          const d = r + l[i + 2] + gap;
          if ((x - l[i]) * (x - l[i]) + (z - l[i + 1]) * (z - l[i + 1]) < d * d) return true;
        }
      }
    }
    return false;
  }
}

/** The giants of a circuit, in the order rows, wood, lone. `share` (0..1) thins the wood away from the road on the lower quality tiers. */
export function placeGiants(rt: TrackRuntimeImpl, def: GiantsDef, blocked: Blocked, share = 1): Giant[] {
  const wood = def.wood;
  const out: Giant[] = [];
  const seed = def.seed ?? 1;
  const rnd = mulberry32(seed ^ 0x51ed270b);
  const sea = rt.terrain.lakeLevel ?? -1e9;
  const [h0, h1] = wood?.height ?? DEFAULTS.height;
  const [g0, g1] = wood?.girth ?? DEFAULTS.girth;
  const near = new Near(32);
  const masts = lampMasts(rt);
  const mastNear = new Near(32);
  for (let i = 0; i < masts.length; i += 2) mastNear.add(masts[i], masts[i + 1], 0.3);

  /** A girth and the height that goes with it: the thick ones are the tall ones, more or less. */
  const size = (bias: number): { h: number; r: number } => {
    const t = Math.pow(rnd(), bias);
    const girth = g0 + (g1 - g0) * t;
    return { h: h0 + (h1 - h0) * Math.min(1, Math.max(0, 0.6 * t + 0.4 * rnd() + (rnd() - 0.5) * 0.1)), r: girth / 2 };
  };
  const stand = (x: number, z: number, h: number, r: number, kind: Giant['kind']): Giant => {
    const side = roadSide(rt, x, z);
    const g: Giant = { x, y: rt.heightFast(x, z), z, h, r, root: r * ROOT_REACH, yaw: rnd() * Math.PI * 2, seed: Math.floor(rnd() * 0x7fffffff), back: side.back, road: side.road, kind };
    out.push(g);
    near.add(x, z, r);
    return g;
  };
  /** May a trunk of radius r stand at (x, z), its roots `gap` metres or more behind the barrier? */
  const free = (x: number, z: number, r: number, gap: number): boolean => {
    const root = r * ROOT_REACH;
    if (roadSide(rt, x, z).back < root + gap) return false;
    if (rt.heightFast(x, z) < sea + 1.6) return false;
    if (mastNear.hit(x, z, root, 0.5, root + 2)) return false;
    return !blocked.ground(x, z, root * 0.7 + 1) && !blocked.view(x, z, r + 0.5);
  };

  if (wood) {
    // ── the rows behind the barriers ──────────────────────────────────────────────────────────────────────────────────────────────
    const [s0, s1] = wood.rowSpacing ?? DEFAULTS.rowSpacing;
    const [gap0, gap1] = wood.rowGap ?? DEFAULTS.rowGap;
    for (const sgn of [1, -1]) {
      const S = sgn > 0 ? rt.L : rt.R;
      let s = rnd() * s1;
      while (s < rt.length) {
        const k = Math.round(s / rt.spacing) % rt.count;
        const { h, r } = size(0.8);
        const gap = gap0 + (gap1 - gap0) * rnd();
        const d = S.wall[k] + gap + r * ROOT_REACH;
        const x = rt.X[k] + sgn * rt.HLX[k] * d;
        const z = rt.Z[k] + sgn * rt.HLZ[k] * d;
        const dens = woodDensity(wood, x, z);
        if (dens < 0.3) {
          s += 6;
          continue;
        }
        // (on the inside of a bend the row's own trunks close up: they keep three metres of air between their roots' reach)
        if (!free(x, z, r, gap - 0.3) || near.hit(x, z, r * 1.5, 3, 40)) {
          s += 3;
          continue;
        }
        stand(x, z, h, r, 'row');
        s += (s0 + (s1 - s0) * rnd()) / (0.45 + 0.55 * dens);
      }
    }

    // ── the wood ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const g of wood.groves) {
      minX = Math.min(minX, g.x - g.r);
      maxX = Math.max(maxX, g.x + g.r);
      minZ = Math.min(minZ, g.z - g.r);
      maxZ = Math.max(maxZ, g.z + g.r);
    }
    const spacing = wood.spacing ?? DEFAULTS.spacing;
    const C = 8;
    const cand: number[] = [];
    for (let z = minZ; z <= maxZ; z += C) for (let x = minX; x <= maxX; x += C) cand.push(x + (rnd() - 0.5) * C, z + (rnd() - 0.5) * C);
    // (darts thrown in a shuffled order: the first to land keeps its place)
    for (let i = cand.length / 2 - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      for (const o of [0, 1]) {
        const t = cand[i * 2 + o];
        cand[i * 2 + o] = cand[j * 2 + o];
        cand[j * 2 + o] = t;
      }
    }
    const e = 3;
    for (let i = 0; i < cand.length; i += 2) {
      const x = cand[i];
      const z = cand[i + 1];
      const pick = rnd();
      const { h, r } = size(1.5);
      const jitter = 0.82 + 0.36 * rnd();
      const dens = woodDensity(wood, x, z);
      if (dens < 0.06) continue;
      // (the wood stands back from the barriers a little further than the rows do, and thins out with the quality tier away from the road)
      if (!free(x, z, r, 6)) continue;
      const far = roadSide(rt, x, z).road;
      if (share < 1 && far > 60 && pick > share + (1 - share) * smoothstep(140, 60, far)) continue;
      if (near.hit(x, z, 0, (spacing / Math.sqrt(dens)) * jitter - r, spacing / Math.sqrt(0.06) + 12)) continue;
      const sx = (rt.heightFast(x + e, z) - rt.heightFast(x - e, z)) / (2 * e);
      const sz = (rt.heightFast(x, z + e) - rt.heightFast(x, z - e)) / (2 * e);
      if (Math.hypot(sx, sz) > 0.85) continue;
      stand(x, z, h, r, 'wood');
    }
  }

  // ── the lone ones ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  for (const l of def.lone ?? []) {
    const r = (l.girth ?? g0 + (g1 - g0) * 0.7) / 2;
    stand(l.x, l.z, l.height ?? h0 + (h1 - h0) * 0.7, r, 'lone');
  }
  return out;
}

/**
 * What grows under the giants: young trees of their own kind between the trunks (none within reach of a barrier or in a camera's
 * line of sight), and ferns at the feet of the trunks that stand near the road and along the back of its barriers.
 */
export function placeUnder(rt: TrackRuntimeImpl, def: GiantsDef, giants: Giant[], blocked: Blocked, share = 1): { young: Under[]; ferns: Under[] } {
  const young: Under[] = [];
  const ferns: Under[] = [];
  const wood = def.wood;
  if (!wood) return { young, ferns };
  const rnd = mulberry32((def.seed ?? 1) ^ 0x3c6ef372);
  const sea = rt.terrain.lakeLevel ?? -1e9;
  const perGiant = (wood.young ?? DEFAULTS.young) * share;
  const fernsPer = (wood.ferns ?? DEFAULTS.ferns) * share;
  const trunks = new Near(32);
  for (const g of giants) trunks.add(g.x, g.z, g.root);
  const taken = new Near(16);
  const p = new Vector3();
  for (const g of giants) {
    if (g.kind === 'lone') continue;
    const n = Math.floor(perGiant + rnd());
    for (let k = 0; k < n; k++) {
      const a = rnd() * Math.PI * 2;
      const d = g.root + 4 + rnd() * 16;
      const x = g.x + Math.cos(a) * d;
      const z = g.z + Math.sin(a) * d;
      const s = 9 + 19 * Math.pow(rnd(), 1.7);
      if (woodDensity(wood, x, z) < 0.05) continue;
      // (a young tree's boughs are a third of its height long: it stands that far behind the barrier, and three metres more)
      if (roadSide(rt, x, z).back < 3 + s * 0.32) continue;
      const y = rt.heightFast(x, z);
      if (y < sea + 1.2) continue;
      if (trunks.hit(x, z, 0, 2.5, 24) || taken.hit(x, z, 0, 5, 12)) continue;
      if (blocked.ground(x, z, 4) || blocked.view(x, z, 4.5)) continue;
      taken.add(x, z, 0);
      young.push({ x, y: y - 0.15, z, s });
    }
    // ferns: at the feet of the trunks within sight of the road
    if (g.road < 90) {
      const m = Math.floor(fernsPer * (g.kind === 'row' ? 1 : 0.5) + rnd());
      for (let k = 0; k < m; k++) {
        const a = rnd() * Math.PI * 2;
        const d = g.root * (0.75 + 0.9 * rnd() * rnd()) + rnd() * 3;
        const x = g.x + Math.cos(a) * d;
        const z = g.z + Math.sin(a) * d;
        if (roadSide(rt, x, z).back < 1.3 || blocked.ground(x, z, 0.8)) continue;
        const y = rt.heightFast(x, z);
        if (y < sea + 0.8) continue;
        ferns.push({ x, y, z, s: 1.3 + 1.5 * rnd() });
      }
    }
  }
  // ferns along the back of the barriers, where the road runs through the wood
  for (const sgn of [1, -1]) {
    const S = sgn > 0 ? rt.L : rt.R;
    for (let s = rnd() * 3; s < rt.length; s += (1.6 + 3.2 * rnd()) / Math.max(0.2, share)) {
      const k = Math.round(s / rt.spacing) % rt.count;
      const d = S.wall[k] + 1.5 + 9 * rnd() * rnd();
      rt.pointAt(s, sgn * d, p);
      if (woodDensity(wood, p.x, p.z) < 0.3 || p.y < sea + 0.8) continue;
      if (roadSide(rt, p.x, p.z).back < 1.3 || blocked.ground(p.x, p.z, 0.8)) continue;
      ferns.push({ x: p.x, y: p.y, z: p.z, s: 1.0 + 1.4 * rnd() });
    }
  }
  return { young, ferns };
}
