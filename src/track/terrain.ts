/**
 * Analytic natural terrain T(x, z): rolling hills, lake basin, bumps and far mountains.
 * The final ground = T + E, where E (see runtime.ts) carves the terrain around the road corridor.
 * Pure math (headless).
 */
import type { CoastFn, CoastSample } from './coast';
import { Noise2, smoothstep } from './math';
import type { LakeDef, MapRect, RingFloor, TerrainParams } from './types';

export interface TerrainFn {
  (x: number, z: number): number;
  /** Water surface elevation (if the track has a lake or a sea). */
  lakeLevel: number | null;
  /** Signed distance (m) from (x, z) to the sea's edge: negative in the water, positive on land; Infinity without a sea. */
  seaDistance: (x: number, z: number) => number;
  /** How much of a frozen lake the ground at (x, z) is: 1 on the ice plateau .. 0 on the land (a ragged shore between); 0 without a frozen lake. */
  iceMask: (x: number, z: number) => number;
}

/** Signed distance to an axis-aligned rectangle (negative inside). */
export function rectDistance(e: number, n: number, r: MapRect): number {
  const hx = (r[2] - r[0]) / 2;
  const hy = (r[3] - r[1]) / 2;
  const dx = Math.abs(e - (r[0] + r[2]) / 2) - hx;
  const dy = Math.abs(n - (r[1] + r[3]) / 2) - hy;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

/**
 * What the floor of an orbital ring adds to the ground at (x, z): the rise of the cylinder away from its lowest line (none under the
 * circuit, the true circle from `full` metres on), and the bank the floor ends in at each rim. Beyond a rim there is no ground: the
 * function falls away steeply there (the terrain tiles stop at the rims).
 */
export function ringRise(ring: RingFloor, x: number, z: number): number {
  const c = Math.min(Math.abs(z - ring.z), ring.radius * 0.999);
  let h = (ring.radius - Math.sqrt(ring.radius * ring.radius - c * c)) * smoothstep(ring.flat, ring.full, c);
  const edge = Math.min(x - ring.rims[0], ring.rims[1] - x);
  h += ring.berm * (1 - smoothstep(0, ring.bermW, edge));
  if (edge < 0) h -= Math.min(400, -edge * 4);
  return h;
}

export interface TerrainBounds {
  cx: number;
  cz: number;
  halfW: number;
  halfH: number;
}

export function makeTerrain(p: TerrainParams, b: TerrainBounds, ice?: LakeDef | null, coast?: CoastFn | null): TerrainFn {
  const n1 = new Noise2(p.seed);
  const n2 = new Noise2(p.seed * 31 + 7);
  const n3 = new Noise2(p.seed * 131 + 11);
  const lake = p.lake;
  const cosR = lake ? Math.cos(lake.rot) : 1;
  const sinR = lake ? Math.sin(lake.rot) : 0;
  const cosI = ice ? Math.cos(ice.rot) : 1;
  const sinI = ice ? Math.sin(ice.rot) : 0;
  const bumps = p.bumps ?? [];
  const tilts = p.tilts ?? [];
  const mt = p.mountains;
  const sea = p.sea;
  const ring = p.ring;
  const ocean = coast ? p.ocean : undefined;
  const warp = ocean?.warp ?? [34, 300];
  const islets = ocean?.islets ?? [];
  const cs: CoastSample = { d: 0, width: 0, rise: 0.07, bed: 10, slope: 0.05 };
  // the sea on the layout's map (east = -x, north = +z): water minus the land standing in it
  const seaDistance = (x: number, z: number): number => {
    if (!sea) return Infinity;
    let w = Infinity;
    for (const r of sea.water) w = Math.min(w, rectDistance(-x, z, r));
    let l = Infinity;
    for (const r of sea.land) l = Math.min(l, rectDistance(-x, z, r));
    return Math.max(w, -l);
  };

  // a frozen lake: 1 on the flat ice, falling to 0 over the ragged shore (an ellipse whose outline is warped by noise)
  const iceMask = (x: number, z: number): number => {
    if (!ice) return 0;
    const dx = x - ice.x;
    const dz = z - ice.z;
    const wqx = dx + 40 * n3.noise(x / 210 + 2.2, z / 210 + 6.6) + 18 * n3.noise(x / 70, z / 70);
    const wqz = dz + 40 * n3.noise(x / 210 - 8.1, z / 210 + 4.4) + 18 * n3.noise(x / 70 + 4, z / 70 - 5);
    const u = (wqx * cosI + wqz * sinI) / ice.rx;
    const v = (-wqx * sinI + wqz * cosI) / ice.rz;
    const q = Math.sqrt(u * u + v * v);
    const shoreW = ice.shore / Math.min(ice.rx, ice.rz);
    return 1 - smoothstep(1 - shoreW, 1 + shoreW, q);
  };

  const fn = ((x: number, z: number): number => {
    let h = p.base;
    // broad hills: domain-warped fbm
    const wx = x + 90 * n3.noise(x / 700, z / 700);
    const wz = z + 90 * n3.noise(x / 700 + 31.7, z / 700 - 12.3);
    h += p.hillAmp * n1.fbm(wx / p.hillScale, wz / p.hillScale, 4);
    h += p.detailAmp * n2.fbm(x / p.detailScale, z / p.detailScale, 3);
    for (let i = 0; i < tilts.length; i++) {
      const tl = tilts[i];
      let v = tl.h0 + tl.gx * (x - tl.x0) + tl.gz * (z - tl.z0);
      const k2 = tl.soft * tl.soft;
      v = 0.5 * (v + tl.lo + Math.sqrt((v - tl.lo) * (v - tl.lo) + k2));
      v = 0.5 * (v + tl.hi - Math.sqrt((v - tl.hi) * (v - tl.hi) + k2));
      h += v;
    }
    for (let i = 0; i < bumps.length; i++) {
      const bp = bumps[i];
      const dx = x - bp.x;
      const dz = z - bp.z;
      h += bp.h * Math.exp(-(dx * dx + dz * dz) / (bp.r * bp.r));
    }
    if (lake) {
      const dx = x - lake.x;
      const dz = z - lake.z;
      // warp the shoreline with noise for an organic outline
      const wqx = dx + 55 * n3.noise(x / 260 + 5.5, z / 260 + 9.1) + 25 * n3.noise(x / 90, z / 90);
      const wqz = dz + 55 * n3.noise(x / 260 - 3.3, z / 260 + 1.7) + 25 * n3.noise(x / 90 + 7, z / 90 - 3);
      const u = (wqx * cosR + wqz * sinR) / lake.rx;
      const v = (-wqx * sinR + wqz * cosR) / lake.rz;
      const q = Math.sqrt(u * u + v * v);
      const shoreW = lake.shore / Math.min(lake.rx, lake.rz);
      const m = 1 - smoothstep(1 - shoreW, 1 + shoreW, q);
      if (m > 0) {
        const bowl = lake.level - lake.depth * (1 - Math.min(q, 1) * Math.min(q, 1)) * (1 - Math.min(q, 1) * 0.3);
        // pull the surrounding land slightly down toward the shoreline
        h = h + (bowl - h) * m;
      }
    }
    if (ice) {
      // the ice is a plateau: dead flat at its level inside, the ground blends into it over the shore
      const m = iceMask(x, z);
      if (m > 0) h += (ice.level - h) * m;
    }
    if (mt) {
      const dx = Math.max(0, Math.abs(x - b.cx) - b.halfW);
      const dz = Math.max(0, Math.abs(z - b.cz) - b.halfH);
      const dist = Math.sqrt(dx * dx + dz * dz);
      const k = smoothstep(mt.start, mt.full, dist);
      if (k > 0) {
        const r = n2.ridged(x / mt.scale + 3.1, z / mt.scale - 7.7, 5);
        const base = 0.25 + 0.75 * r;
        h += mt.amp * k * k * base + 0.18 * mt.amp * k * (0.5 + 0.5 * n1.noise(x / (mt.scale * 3), z / (mt.scale * 3)));
      }
    }
    if (ring) h += ringRise(ring, x, z);
    if (ocean && coast) {
      // an island: the land is capped by the shore's profile (it rises from the waterline), and beyond the coast the bed falls away
      coast(x, z, cs);
      // (the coast wanders: bays and points. Never by more than half the land there is beside the road: a causeway hardly at all)
      const wk = Math.min(warp[0], 0.45 * Math.max(0, cs.width - 16)) / 1.36;
      const d = cs.d + wk * (n3.noise(x / warp[1] + 13.7, z / warp[1] - 4.2) + 0.36 * n3.noise(x / (warp[1] * 0.31) - 6.1, z / (warp[1] * 0.31) + 9.9));
      if (d >= 0) {
        // a berm above the wash, then the shore's own slope
        const shore = ocean.level + Math.min(d, 9) * 0.085 + d * cs.rise;
        if (shore < h) h = shore;
      } else {
        h = ocean.level - cs.bed * (1 - Math.exp((d * cs.slope) / cs.bed));
      }
      for (let i = 0; i < islets.length; i++) {
        const it = islets[i];
        const dx = x - it.x;
        const dz = z - it.z;
        const r = Math.sqrt(dx * dx + dz * dz);
        if (r > it.r + 90) continue;
        // (a ragged outline, and a top that is not a table)
        const rr = it.r * (1 + 0.22 * n3.noise(x / (it.r * 0.9) + 3.3, z / (it.r * 0.9) - 7.1));
        const di = rr - r;
        const sheer = it.sheer ?? 0.5;
        const top = it.h * (0.82 + 0.18 * n2.noise(x / 23 + 1.9, z / 23 + 5.5));
        const hi = di >= 0 ? ocean.level + top * smoothstep(0, rr * (1 - 0.8 * sheer), di) + Math.min(di, 4) * 0.12 : ocean.level + di * 0.3;
        if (hi > h) h = hi;
      }
    }
    if (sea) {
      const sd = seaDistance(x, z);
      // (a far hill that reaches the water comes down to it over twice its height, in a slope and not a cliff)
      const lev = Math.max(sea.levelled, 2.2 * (h - sea.quay));
      if (sd < lev) {
        // the ground is levelled to the quay around the water, and drops into a basin (a little deeper away from the quay)
        const k = 1 - smoothstep(0, lev, sd);
        h += (sea.quay - h) * k;
        if (sd < 2) {
          const m = 1 - smoothstep(-2, 2, sd);
          h += (sea.level - 3 - Math.min(-sd, 60) * 0.1 - h) * m;
        }
      }
    }
    return h;
  }) as TerrainFn;
  fn.lakeLevel = lake ? lake.level : sea ? sea.level : ocean ? ocean.level : null;
  fn.seaDistance = seaDistance;
  fn.iceMask = iceMask;
  return fn;
}
