/**
 * Where the fleet of an island circuit lies and where it sails (fleet.ts): worked out from the def and the depth of the water, with
 * no scene, so that the test can ask the same questions the builder does.
 *
 * A boat at anchor lies where there is water enough for its kind under it and round it (it swings), off the road and off the
 * courses; where there is not, a smaller boat lies there instead, which is how the shallows of a lagoon fill with canoes and its
 * deep with ketches without anybody saying so. It lies head to wind, as its neighbours do: a fleet at anchor points one way.
 */
import { mulberry32 } from '../math';
import type { TrackRuntimeImpl } from '../runtime';
import type { BoatKind, FleetDef, MooringDef } from '../types';
import { BOATS, BOAT_KINDS } from './fleetBoats';
import { type RGB, lin } from './fleetKit';

/** Strong sail colours and pale ones, and the colours of hulls (most are white). */
const BRIGHT = [0xff6a55, 0xffb22e, 0x27c9c0, 0x8fe36a, 0xff86ad, 0xe23d28, 0x7d6bff, 0x4aa8ff, 0xffd94a, 0xff8a3a].map((h) => lin(h));
const PALE = [0xf6f1e6, 0xf6f1e6, 0xf3e7c9, 0xf7dcd0, 0xd9eee9, 0xe9e2f4].map((h) => lin(h));
const HULLS = [0xffffff, 0xffffff, 0xffffff, 0xffffff, 0xffffff, 0xf4ecd8, 0xdfe9ea, 0x22364a, 0x2a2d31, 0x1d4448, 0x6e2a26].map((h) => lin(h));

/** How many of a mooring's boats there are at each quality tier. */
const TIER_SHARE = [0.5, 0.75, 1, 1.15];

const DEG = Math.PI / 180;

/** The water a boat at anchor needs (m): its draught and half a metre, and never less than three quarters of one. */
export function waterAtAnchor(kind: BoatKind): number {
  return Math.max(0.75, BOATS[kind].draft + 0.5);
}
/** The water a boat under sail needs: a metre and a half under its keel. */
export function waterUnderSail(kind: BoatKind): number {
  return BOATS[kind].draft + 1.5;
}

/** A compass heading as a unit vector on the map (world x, z: x = -east). */
export function compass(deg: number): [number, number] {
  return [-Math.sin(deg * DEG), Math.cos(deg * DEG)];
}
/** The turn about the upright axis that points a boat's bow (+x) along (dx, dz). */
export function yawOf(dx: number, dz: number): number {
  return Math.atan2(-dz, dx);
}

export interface Berth {
  kind: BoatKind;
  x: number;
  z: number;
  /** The turn about the upright axis (rad) and the size (1: the kind's own). */
  yaw: number;
  scale: number;
  /** 0..1: where it is in its roll. */
  phase: number;
  /** How far its sails are furled (0: all set) and their trim (rad). */
  furl: number;
  trim: number;
  sail: RGB;
  hull: RGB;
}

export interface Sailor extends Berth {
  course: Course;
  /** Metres round the course at the start. */
  s: number;
}

export interface FleetPlan {
  /** Where the wind comes from (compass degrees). */
  wind: number;
  berths: Berth[];
  sailors: Sailor[];
  courses: Course[];
}

// ── courses ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A closed course round its marks, as points a fixed step apart. */
export class Course {
  readonly x: Float32Array;
  readonly z: Float32Array;
  readonly n: number;
  readonly length: number;
  readonly step: number;

  constructor(
    readonly kind: BoatKind,
    marks: [number, number][],
    readonly speed: number,
  ) {
    // the polygon of the marks with every corner rounded as wide as its two legs allow (nearly half of the shorter one is given to
    // the turn: a course four marks long and narrow is two reaches and two half circles), then points equally far apart along it
    const px: number[] = [];
    const pz: number[] = [];
    const m = marks.length;
    for (let i = 0; i < m; i++) {
      const a = marks[(i + m - 1) % m];
      const b = marks[i];
      const c = marks[(i + 1) % m];
      const la = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const lc = Math.hypot(c[0] - b[0], c[1] - b[1]);
      const ux = (b[0] - a[0]) / la;
      const uz = (b[1] - a[1]) / la;
      const vx = (c[0] - b[0]) / lc;
      const vz = (c[1] - b[1]) / lc;
      const turn = Math.acos(Math.min(1, Math.max(-1, ux * vx + uz * vz)));
      if (turn < 1e-3) {
        px.push(b[0]);
        pz.push(b[1]);
        continue;
      }
      // the turn begins and ends this far from the mark; its centre is on the inside
      const reach = 0.48 * Math.min(la, lc);
      const r = reach / Math.tan(turn / 2);
      const left = ux * vz - uz * vx > 0 ? 1 : -1;
      const cx = b[0] - ux * reach - uz * left * r;
      const cz = b[1] - uz * reach + ux * left * r;
      const a0 = Math.atan2(b[1] - uz * reach - cz, b[0] - ux * reach - cx);
      const steps = Math.max(2, Math.ceil((turn * r) / 0.4));
      for (let k = 0; k <= steps; k++) {
        const an = a0 + (left * turn * k) / steps;
        px.push(cx + r * Math.cos(an));
        pz.push(cz + r * Math.sin(an));
      }
    }
    const k = px.length;
    const cum = [0];
    for (let i = 0; i < k; i++) cum.push(cum[i] + Math.hypot(px[(i + 1) % k] - px[i], pz[(i + 1) % k] - pz[i]));
    this.length = cum[k];
    this.n = Math.max(8, Math.round(this.length / 2));
    this.step = this.length / this.n;
    this.x = new Float32Array(this.n);
    this.z = new Float32Array(this.n);
    let j = 0;
    for (let i = 0; i < this.n; i++) {
      const s = i * this.step;
      while (j + 1 < k && cum[j + 1] < s) j++;
      const f = (s - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]);
      this.x[i] = px[j] + (px[(j + 1) % k] - px[j]) * f;
      this.z[i] = pz[j] + (pz[(j + 1) % k] - pz[j]) * f;
    }
  }

  /** Where a boat is `s` m round the course (x, z) and which way it is going (a unit vector), into `out`. */
  at(s: number, out: { x: number; z: number; tx: number; tz: number }): void {
    const n = this.n;
    const u = (((s / this.step) % n) + n) % n;
    const i = Math.floor(u) % n;
    const f = u - Math.floor(u);
    const i1 = (i + 1) % n;
    const i2 = (i + 2) % n;
    out.x = this.x[i] + (this.x[i1] - this.x[i]) * f;
    out.z = this.z[i] + (this.z[i1] - this.z[i]) * f;
    // the heading turns evenly from one step to the next
    const ax = this.x[i1] - this.x[i];
    const az = this.z[i1] - this.z[i];
    const bx = this.x[i2] - this.x[i1];
    const bz = this.z[i2] - this.z[i1];
    const tx = ax + (bx - ax) * f;
    const tz = az + (bz - az) * f;
    const l = Math.hypot(tx, tz) || 1;
    out.tx = tx / l;
    out.tz = tz / l;
  }
}

/** The boom's angle (rad) by how far off the wind a boat points (degrees): sheeted in close-hauled, squared off on a run. */
const TRIM: [number, number][] = [
  [0, 0.05],
  [30, 0.06],
  [45, 0.2],
  [90, 0.75],
  [135, 1.15],
  [180, 1.45],
];

export interface PointOfSail {
  /** The boom's angle (rad; above 0 to starboard: the wind is on the port side). */
  trim: number;
  /** How far it heels (rad; above 0 to starboard, the way the boom lies). */
  heel: number;
  /** The share of its speed it makes (it crawls through the eye of the wind). */
  drive: number;
}

/**
 * How a boat of a kind going along (tx, tz) carries its sails in a wind from `wind` (compass degrees), into `out`. With the wind
 * dead astern the boom stays on the side `out` has it on (a boat does not gybe for nothing).
 */
export function pointOfSail(kind: BoatKind, tx: number, tz: number, wind: number, out: PointOfSail): void {
  const [wx, wz] = compass(wind);
  const off = Math.acos(Math.min(1, Math.max(-1, tx * wx + tz * wz))) / DEG;
  // (the starboard side of a boat going along (tx, tz) is (-tz, tx))
  const stb = wx * -tz + wz * tx;
  const side = Math.abs(stb) > 0.1 || out.trim === 0 ? (stb > 0 ? -1 : 1) : Math.sign(out.trim);
  let mag = TRIM[TRIM.length - 1][1];
  for (let i = 0; i + 1 < TRIM.length; i++) {
    if (off <= TRIM[i + 1][0]) {
      mag = TRIM[i][1] + ((TRIM[i + 1][1] - TRIM[i][1]) * (off - TRIM[i][0])) / (TRIM[i + 1][0] - TRIM[i][0]);
      break;
    }
  }
  const ramp = (a: number, b: number): number => {
    const t = Math.min(1, Math.max(0, (off - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  out.trim = side * mag;
  out.heel = side * BOATS[kind].heel * Math.sin(off * DEG) * ramp(25, 55);
  out.drive = 0.35 + 0.65 * ramp(28, 68);
}

// ── the plan ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A line on the map with its length: the point `s` m along it and `d` m to its left. */
function lineOf(pts: [number, number][]): { length: number; at: (s: number, d: number) => [number, number] } {
  const cum = [0];
  for (let i = 0; i + 1 < pts.length; i++) cum.push(cum[i] + Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]));
  const length = cum[cum.length - 1];
  return {
    length,
    at: (s, d) => {
      const c = Math.min(length, Math.max(0, s));
      let i = 0;
      while (i + 2 < pts.length && cum[i + 1] < c) i++;
      const l = Math.max(1e-9, cum[i + 1] - cum[i]);
      const ux = (pts[i + 1][0] - pts[i][0]) / l;
      const uz = (pts[i + 1][1] - pts[i][1]) / l;
      return [pts[i][0] + ux * (c - cum[i]) - uz * d, pts[i][1] + uz * (c - cum[i]) + ux * d];
    },
  };
}

export function planFleet(rt: TrackRuntimeImpl, def: FleetDef, tier: number): FleetPlan {
  const rnd = mulberry32(((def.seed ?? rt.def.seed) ^ 0xf1ee7) >>> 0);
  const wind = def.wind ?? 90;
  const level = rt.def.terrain.ocean?.level ?? rt.terrain.lakeLevel ?? 0;
  const depth = (x: number, z: number): number => level - rt.heightFast(x, z);
  const courses = (def.courses ?? []).map((c) => new Course(c.kind, c.marks, c.speed ?? 2.4));
  const berths: Berth[] = [];

  /** Water enough under a boat of this kind and all round it (it swings), and off the road. */
  const fits = (kind: BoatKind, x: number, z: number): boolean => {
    const need = waterAtAnchor(kind);
    if (depth(x, z) < need) return false;
    const r = BOATS[kind].length * 0.55 + 1;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      if (depth(x + Math.cos(a) * r, z + Math.sin(a) * r) < need) return false;
    }
    return rt.stripMargin(x, z) > r + 4;
  };
  /** Room between it and every boat that lies there already, and off the courses. */
  const clear = (kind: BoatKind, x: number, z: number): boolean => {
    const len = BOATS[kind].length;
    for (const b of berths) {
      const d = 0.6 * (len + BOATS[b.kind].length) + 3;
      if ((b.x - x) * (b.x - x) + (b.z - z) * (b.z - z) < d * d) return false;
    }
    for (const c of courses) {
      const d = 0.55 * len + 0.5 * BOATS[c.kind].length + 6;
      for (let i = 0; i < c.n; i += 3) if ((c.x[i] - x) * (c.x[i] - x) + (c.z[i] - z) * (c.z[i] - z) < d * d) return false;
    }
    return true;
  };
  const dress = (kind: BoatKind): { sail: RGB; hull: RGB } => ({
    sail: rnd() < BOATS[kind].bright ? BRIGHT[Math.floor(rnd() * BRIGHT.length)] : PALE[Math.floor(rnd() * PALE.length)],
    hull: HULLS[Math.floor(rnd() * HULLS.length)],
  });
  const anchor = (kind: BoatKind, x: number, z: number, heading: number): void => {
    const [dx, dz] = compass(heading);
    // half of them keep all their sail up to watch under, a third some of it, the rest have furled
    const f = rnd();
    berths.push({
      kind,
      x,
      z,
      yaw: yawOf(dx, dz),
      scale: 0.92 + 0.2 * rnd(),
      phase: rnd(),
      furl: f < 0.5 ? 0 : f < 0.82 ? 0.2 + 0.35 * rnd() : 0.88,
      trim: (rnd() - 0.5) * 0.14,
      ...dress(kind),
    });
  };

  // the big ships first: the rest make room for them
  for (const b of def.berths ?? []) {
    if (fits(b.kind, b.x, b.z) && clear(b.kind, b.x, b.z)) anchor(b.kind, b.x, b.z, b.heading ?? wind + (rnd() - 0.5) * 10);
  }

  const share = TIER_SHARE[Math.min(3, Math.max(0, tier))];
  const moor = (m: MooringDef): void => {
    const line = lineOf(m.line);
    const count = Math.max(1, Math.round(m.count * share));
    const per = Math.max(1, m.group ?? 1);
    const groups = Math.max(1, Math.round(count / per));
    const kinds = BOAT_KINDS.filter((k) => (m.kinds[k] ?? 0) > 0);
    const total = kinds.reduce((s, k) => s + (m.kinds[k] ?? 0), 0);
    const pick = (): BoatKind => {
      let r = rnd() * total;
      for (const k of kinds) {
        r -= m.kinds[k] ?? 0;
        if (r <= 0) return k;
      }
      return kinds[kinds.length - 1];
    };
    // where each group lies along the line and to which side of it, and the few degrees by which it has swung off the wind
    const gs: { s: number; d: number; swing: number }[] = [];
    for (let g = 0; g < groups; g++) gs.push({ s: ((g + 0.2 + 0.6 * rnd()) / groups) * line.length, d: (rnd() * 2 - 1) * m.spread * (per > 1 ? 0.7 : 1), swing: (rnd() - 0.5) * 12 });
    const reach = 5 + 7 * Math.sqrt(per);
    for (let i = 0; i < count; i++) {
      const g = gs[i % groups];
      const want = pick();
      for (let attempt = 0; attempt < 24; attempt++) {
        let s = g.s;
        let d = g.d;
        if (per > 1 || attempt > 0) {
          const r = reach * (1 + attempt * 0.14) * Math.sqrt(rnd());
          const a = rnd() * Math.PI * 2;
          s += r * Math.cos(a) * 1.5;
          d = Math.min(m.spread, Math.max(-m.spread, d + r * Math.sin(a)));
        }
        const [x, z] = line.at(s, d);
        // a boat that draws too much for this water gives way to a smaller one
        let k = BOAT_KINDS.indexOf(want);
        while (k >= 0 && !fits(BOAT_KINDS[k], x, z)) k--;
        if (k < 0 || !clear(BOAT_KINDS[k], x, z)) continue;
        anchor(BOAT_KINDS[k], x, z, wind + g.swing + (rnd() - 0.5) * 9);
        break;
      }
    }
  };
  for (const m of def.moorings ?? []) moor(m);

  const sailors: Sailor[] = [];
  const at = { x: 0, z: 0, tx: 0, tz: 0 };
  (def.courses ?? []).forEach((c, ci) => {
    const course = courses[ci];
    const n = c.boats ?? 1;
    for (let j = 0; j < n; j++) {
      // (in company: the boats of a course keep within a third of it of each other)
      const s = ((j * 0.33) / n + 0.02 * rnd() + ci * 0.37) * course.length;
      course.at(s, at);
      sailors.push({ kind: c.kind, x: at.x, z: at.z, yaw: yawOf(at.tx, at.tz), scale: 0.96 + 0.1 * rnd(), phase: rnd(), furl: 0, trim: 0, ...dress(c.kind), course, s });
    }
  });

  return { wind, berths, sailors, courses };
}
