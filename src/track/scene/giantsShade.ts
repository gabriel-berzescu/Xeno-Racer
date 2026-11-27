/**
 * The shade of the old wood (headless: arrays only).
 *
 * The sun's cascades are fitted for casters up to 35 m above the car: whatever stands higher on the way to the sun is in front of
 * a cascade's near plane and casts nothing into it, and the crowns of the giants are a hundred metres up. So the wood's shade is
 * made in two parts, both of them worked out again whenever the light moves (on a great ring it does not move during a race):
 *
 *  - The ground, the road and the cars, by the cascades, from casters that are not the trees but stand in for them: a prism for
 *    each trunk and a slab for each limb's foliage, every vertex of which has been slid down the sun's own ray to twenty metres
 *    above the ground (`slideToSun`). A point moved along the ray to the sun casts its shadow where it did before, and now it is
 *    inside every cascade.
 *  - The trees themselves, above that height, by a number per vertex: the share of the sun a probe sees (`ShadeModel.solve`) past
 *    the other trunks (which hide it) and the pads of foliage (which dim it by the length of the way through them). The materials
 *    multiply the direct light by it.
 */

/** A vertex with this probe takes its light as it comes (the shadow maps shade it). */
export const NO_PROBE = -1;

/** How high above the ground the stand-in casters end up (m): above a car, a barrier and a lamp mast, inside every cascade. */
export const PROXY_HEIGHT = 20;

/** Light lost per metre of the way through a pad of foliage (as an optical depth). */
const PAD_DENSITY = 0.17;
const CELL = 24;
/** The texture of holes the pads' stand-ins are cut with is this many texels square; its first texel is solid (the trunks'). */
export const HOLES = 32;

export class ShadeModel {
  /** Pads of foliage: x, y, z, horizontal radius, vertical radius, tree. */
  pads: number[] = [];
  /** Trunks: x, z, the ground at its foot, height, radius at the foot and near the top, tree. */
  trunks: number[] = [];
  /** Probes: x, y, z, the trunk's radius there (0: a point), tree, its own pad (or -1). */
  probes: number[] = [];
  private grid: Map<number, number[]> | null = null;
  private tgrid: Map<number, number[]> | null = null;
  private top = 0;

  addPad(x: number, y: number, z: number, rh: number, rv: number, tree: number): number {
    this.pads.push(x, y, z, rh, rv, tree);
    this.grid = null;
    return this.pads.length / 6 - 1;
  }
  addTrunk(x: number, z: number, y0: number, h: number, r0: number, r1: number, tree: number): void {
    this.trunks.push(x, z, y0, h, r0, r1, tree);
    this.grid = null;
  }
  addProbe(x: number, y: number, z: number, rad: number, tree: number, pad: number): number {
    this.probes.push(x, y, z, rad, tree, pad);
    return this.probes.length / 6 - 1;
  }
  get probeCount(): number {
    return this.probes.length / 6;
  }

  private key(ix: number, iz: number): number {
    return ix * 73856093 + iz * 19349663;
  }

  private index(): void {
    const grid = new Map<number, number[]>();
    const tgrid = new Map<number, number[]>();
    const put = (m: Map<number, number[]>, x: number, z: number, r: number, i: number): void => {
      for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
        for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
          const k = this.key(ix, iz);
          const l = m.get(k);
          if (l) l.push(i);
          else m.set(k, [i]);
        }
      }
    };
    let top = 0;
    for (let i = 0; i < this.pads.length; i += 6) {
      put(grid, this.pads[i], this.pads[i + 2], this.pads[i + 3], i);
      top = Math.max(top, this.pads[i + 1] + this.pads[i + 4]);
    }
    for (let i = 0; i < this.trunks.length; i += 7) {
      put(tgrid, this.trunks[i], this.trunks[i + 1], this.trunks[i + 4], i);
      top = Math.max(top, this.trunks[i + 2] + this.trunks[i + 3]);
    }
    this.grid = grid;
    this.tgrid = tgrid;
    this.top = top;
  }

  /** The share of the sun (unit vector toward it: sx, sy, sz) seen from a point, past the trunks and through the pads. */
  private seen(px: number, py: number, pz: number, sx: number, sy: number, sz: number, tree: number, self: number, ownTrunk: boolean, stamp: Int32Array, tstamp: Int32Array, id: number): number {
    const grid = this.grid!;
    const tgrid = this.tgrid!;
    const pads = this.pads;
    const trunks = this.trunks;
    // as far as the ray is under the tops of the trees (and no further than a kilometre: a sun on the horizon)
    const sh = Math.hypot(sx, sz);
    const tMax = Math.min(1000, sy > 1e-4 ? (this.top - py) / sy : 1000);
    if (tMax <= 0) return 1;
    let tau = 0;
    const reach = tMax * sh;
    const steps = Math.max(1, Math.ceil(reach / (CELL * 0.5)));
    let lastKey = NaN;
    for (let k = 0; k <= steps; k++) {
      const t = (tMax * k) / steps;
      const ix = Math.floor((px + sx * t) / CELL);
      const iz = Math.floor((pz + sz * t) / CELL);
      const key = this.key(ix, iz);
      if (key === lastKey) continue;
      lastKey = key;
      const tl = tgrid.get(key);
      if (tl) {
        for (let n = 0; n < tl.length; n++) {
          const i = tl[n];
          if (tstamp[i / 7] === id) continue;
          tstamp[i / 7] = id;
          if (!ownTrunk && trunks[i + 6] === tree) continue;
          // the nearest the ray comes to the trunk's axis, on the map
          const dx = trunks[i] - px;
          const dz = trunks[i + 1] - pz;
          const tc = sh > 1e-6 ? (dx * sx + dz * sz) / (sh * sh) : 0;
          if (tc <= 0 || tc > tMax) continue;
          const y = py + sy * tc - trunks[i + 2];
          if (y < 0 || y > trunks[i + 3]) continue;
          const r = trunks[i + 4] + (trunks[i + 5] - trunks[i + 4]) * Math.min(1, y / (trunks[i + 3] * 0.8));
          const ex = dx - sx * tc;
          const ez = dz - sz * tc;
          if (ex * ex + ez * ez < r * r) return 0;
        }
      }
      const pl = grid.get(key);
      if (pl) {
        for (let n = 0; n < pl.length; n++) {
          const i = pl[n];
          if (stamp[i / 6] === id) continue;
          stamp[i / 6] = id;
          if (i === self * 6) continue;
          // the pad as a sphere: heights stretched by its flatness
          const rh = pads[i + 3];
          const f = rh / pads[i + 4];
          const ox = px - pads[i];
          const oy = (py - pads[i + 1]) * f;
          const oz = pz - pads[i + 2];
          const dy = sy * f;
          const a = sx * sx + dy * dy + sz * sz;
          const b = ox * sx + oy * dy + oz * sz;
          const c = ox * ox + oy * oy + oz * oz - rh * rh;
          const disc = b * b - a * c;
          if (disc <= 0) continue;
          const sq = Math.sqrt(disc);
          const t1 = Math.max(0, (-b - sq) / a);
          const t2 = (-b + sq) / a;
          if (t2 > t1) tau += (t2 - t1) * PAD_DENSITY;
        }
      }
      if (tau > 5) return 0;
    }
    return Math.exp(-tau);
  }

  /**
   * The share of the sun at every probe: two numbers each, for the two flanks of a trunk as the sun sees it (a point probe has the
   * same number twice). `sun`: unit vector toward the light.
   */
  solve(sx: number, sy: number, sz: number, out?: Float32Array): Float32Array {
    if (!this.grid) this.index();
    const n = this.probeCount;
    const res = out && out.length === n * 2 ? out : new Float32Array(n * 2);
    const stamp = new Int32Array(this.pads.length / 6).fill(-1);
    const tstamp = new Int32Array(this.trunks.length / 7).fill(-1);
    const sh = Math.hypot(sx, sz) || 1;
    // level and square to the sun: from one flank of a trunk to the other
    const qx = -sz / sh;
    const qz = sx / sh;
    const P = this.probes;
    let id = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      const rad = P[o + 3];
      if (rad <= 0) {
        // a point: a pad (the way out of itself does not count) or a limb
        const v = this.seen(P[o], P[o + 1], P[o + 2], sx, sy, sz, P[o + 4], P[o + 5], true, stamp, tstamp, id++);
        res[i * 2] = v;
        res[i * 2 + 1] = v;
      } else {
        // a ring of a trunk: its two flanks on the sunny side, a little off the bark
        for (let k = 0; k < 2; k++) {
          const side = k === 0 ? -1 : 1;
          const x = P[o] + (qx * side * 0.7 + (sx / sh) * 0.75) * (rad + 0.4);
          const z = P[o + 2] + (qz * side * 0.7 + (sz / sh) * 0.75) * (rad + 0.4);
          res[i * 2 + k] = this.seen(x, P[o + 1], z, sx, sy, sz, P[o + 4], -1, false, stamp, tstamp, id++);
        }
      }
    }
    return res;
  }

  /**
   * Write the sunlight of every vertex of a buffer from the probes' (`seen`: what solve returned): a vertex of a trunk's ring takes
   * its share between the ring's two flanks, by where it stands across the sun.
   */
  paint(pos: ArrayLike<number>, probe: ArrayLike<number>, seen: Float32Array, sx: number, sz: number, out: Float32Array): void {
    const sh = Math.hypot(sx, sz) || 1;
    const qx = -sz / sh;
    const qz = sx / sh;
    const P = this.probes;
    for (let i = 0; i < out.length; i++) {
      const p = probe[i];
      if (p < 0) {
        out[i] = 1;
        continue;
      }
      const o = p * 6;
      const rad = P[o + 3];
      let w = 0.5;
      if (rad > 0) w = Math.min(1, Math.max(0, 0.5 + (0.5 * ((pos[i * 3] - P[o]) * qx + (pos[i * 3 + 2] - P[o + 2]) * qz)) / (rad * 0.7)));
      out[i] = seen[p * 2] * (1 - w) + seen[p * 2 + 1] * w;
    }
  }

  /**
   * The stand-in casters, where the trees are: a five-sided prism for each trunk and a crooked square for each pad of foliage (uv:
   * a place in the texture of holes; a trunk's is the one solid texel).
   */
  casters(): { pos: Float32Array; uv: Float32Array; idx: Uint32Array } {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    let n = 0;
    const T = this.trunks;
    const SIDES = 5;
    for (let i = 0; i < T.length; i += 7) {
      const levels = [0, 0.45, 0.85, 1];
      const base = n;
      for (const l of levels) {
        const y = T[i + 2] + T[i + 3] * l;
        const r = (T[i + 4] + (T[i + 5] - T[i + 4]) * Math.min(1, l / 0.8)) * (l === 1 ? 0.4 : 1) * (l === 0 ? 1.3 : 1);
        for (let k = 0; k < SIDES; k++) {
          const a = (k / SIDES) * Math.PI * 2 + i;
          pos.push(T[i] + Math.cos(a) * r, y, T[i + 1] + Math.sin(a) * r);
          uv.push(0.5 / HOLES, 0.5 / HOLES);
          n++;
        }
      }
      for (let l = 0; l + 1 < levels.length; l++) {
        for (let k = 0; k < SIDES; k++) {
          const a = base + l * SIDES + k;
          const b = base + l * SIDES + ((k + 1) % SIDES);
          idx.push(a, a + SIDES, b, b, a + SIDES, b + SIDES);
        }
      }
    }
    const P = this.pads;
    for (let i = 0; i < P.length; i += 6) {
      const base = n;
      // (a place of its own in the texture of holes, and corners of its own: no two pads let the same light through)
      const u0 = ((i * 0.618034) % 1) * 4;
      const v0 = ((i * 0.381966) % 1) * 4;
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + i;
        const rh = P[i + 3] * (0.95 + 0.4 * (((i + k * 7) * 0.7548777) % 1));
        pos.push(P[i] + Math.cos(a) * rh, P[i + 1] + P[i + 4] * (k % 2 ? 0.25 : -0.25), P[i + 2] + Math.sin(a) * rh);
        uv.push(u0 + Math.cos(a) * rh * 0.11, v0 + Math.sin(a) * rh * 0.11);
        n++;
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return { pos: new Float32Array(pos), uv: new Float32Array(uv), idx: new Uint32Array(idx) };
  }
}

/**
 * Slide every vertex down the ray from the sun (unit vector toward it: sx, sy, sz) until it stands `PROXY_HEIGHT` above the ground
 * under it (`ground(x, z)`: the land, or the sea). A vertex already that low stays. Its shadow falls where it did.
 *
 * The ray is walked from the vertex, eight metres of the map at a time, to the first place where it is that low: under a low sun it
 * crosses half the headland on its way down, and what it meets first (the hill, the cliff's edge) is where its shadow falls.
 */
export function slideToSun(base: Float32Array, out: Float32Array, sx: number, sy: number, sz: number, ground: (x: number, z: number) => number): void {
  // (a light on the horizon would send them out of the world: no lower than three degrees)
  const lowest = 0.052;
  if (sy < lowest) {
    const k = Math.sqrt((1 - lowest * lowest) / Math.max(1e-9, sx * sx + sz * sz));
    sx *= k;
    sz *= k;
    sy = lowest;
  }
  const sh = Math.hypot(sx, sz);
  const dt = sh > 0.02 ? 8 / sh : 1e9;
  for (let i = 0; i < base.length; i += 3) {
    const x = base[i];
    const y = base[i + 1];
    const z = base[i + 2];
    let t = 0;
    // how far over the height it is to end at: positive while it has further to go
    let over = y - ground(x, z) - PROXY_HEIGHT;
    while (over > 0) {
      // (if the ground were level from here on it would be there in over / sy: never step past that)
      const step = Math.min(dt, over / sy);
      const next = y - sy * (t + step) - ground(x - sx * (t + step), z - sz * (t + step)) - PROXY_HEIGHT;
      if (next <= 0) {
        // between the two: halved six times (the ground between them may be a cliff's edge, which no straight line finds)
        let lo = t;
        let hi = t + step;
        for (let k = 0; k < 6; k++) {
          const mid = (lo + hi) / 2;
          if (y - sy * mid - ground(x - sx * mid, z - sz * mid) - PROXY_HEIGHT > 0) lo = mid;
          else hi = mid;
        }
        t = (lo + hi) / 2;
        break;
      }
      t += step;
      over = next;
      if (step < 0.05) break;
    }
    out[i] = x - sx * t;
    out[i + 1] = y - sy * t;
    out[i + 2] = z - sz * t;
  }
}

/**
 * The ground for slideToSun, remembered: heights on a grid of `cell` metres, each asked of `ground` once, read between the four
 * nearest. The rays of a wood cross the same ground many thousands of times.
 */
export function rememberedGround(ground: (x: number, z: number) => number, cell = 6): (x: number, z: number) => number {
  const seen = new Map<number, number>();
  const at = (ix: number, iz: number): number => {
    const k = ix * 65537 + iz;
    let h = seen.get(k);
    if (h === undefined) {
      h = ground(ix * cell, iz * cell);
      seen.set(k, h);
    }
    return h;
  };
  return (x, z) => {
    const fx = x / cell;
    const fz = z / cell;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    return (at(ix, iz) * (1 - tx) + at(ix + 1, iz) * tx) * (1 - tz) + (at(ix, iz + 1) * (1 - tx) + at(ix + 1, iz + 1) * tx) * tz;
  };
}
