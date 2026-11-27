/**
 * One giant of the old wood, as geometry (headless: arrays only). Something between a giant sequoia and a kauri, a little stranger:
 * a column that hardly tapers, fluted, standing on buttress roots that reach nearly twice its radius; no bough for the first thirty
 * or forty metres, then a crown of heavy limbs that sag and turn up at their ends, each carrying pads of foliage and beards of
 * lichen; a rounded top, or a dead spike where the lightning has been.
 *
 * Two buffers: bark (the trunk, the roots, the limbs) and leaf (the pads' cards and dark cores, the lichen). Every vertex above
 * the reach of the shadow maps carries the number of a probe (giantsShade.ts): the share of the sun it sees is worked out there.
 */
import { mulberry32 } from '../math';
import type { Giant } from './giantsPlace';
import { NO_PROBE, type ShadeModel } from './giantsShade';

/** A growable vertex buffer: position, normal, uv, colour, the probe of its sunlight and (leaves) how far the wind moves it. */
export class GBuf {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  probe: number[] = [];
  wind: number[] = [];
  idx: number[] = [];
  n = 0;
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, r: number, g: number, b: number, probe: number, wind = 0): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(r, g, b);
    this.probe.push(probe);
    this.wind.push(wind);
    return this.n++;
  }
  get tris(): number {
    return this.idx.length / 3;
  }
}

/** How much of a giant is built, by how near the road it stands. */
export interface GiantLod {
  /** Sides of the trunk and metres between its rings above the first bough. */
  sides: number;
  step: number;
  /** Limbs, their segments and sides, pads of foliage on each, cards on a pad, sides of a pad's core, beards of lichen per limb. */
  boughs: number;
  bSegs: number;
  bSides: number;
  pads: number;
  cards: number;
  core: number;
  beards: number;
}

export const GIANT_LODS: GiantLod[] = [
  { sides: 24, step: 18, boughs: 13, bSegs: 3, bSides: 5, pads: 3, cards: 5, core: 6, beards: 0.6 },
  { sides: 12, step: 24, boughs: 10, bSegs: 2, bSides: 4, pads: 2, cards: 4, core: 5, beards: 0.25 },
  { sides: 8, step: 32, boughs: 7, bSegs: 2, bSides: 3, pads: 2, cards: 2, core: 4, beards: 0 },
];

/** The pads of a giant built in part are fewer and larger: the crown is as full from far away. */
const PAD_GROW = [1, 1.28, 1.6];
/** The bark tile is this wide and this high on the trunk (m). */
const BARK_U = 2.6;
const BARK_V = 5.2;
/** The first ring of a trunk that takes its sunlight from a probe (m above its foot): below it the shadow maps do the work. */
export const PROBE_FROM = 14;

/** Tiles of the leaf atlas: two pads of foliage, the beard of lichen, a fern. */
export const LEAF_TILES = 4;
function tileU(i: number): [number, number] {
  const w = 1 / LEAF_TILES;
  return [(i + 0.03) * w, (i + 0.97) * w];
}
const PAD_U = [tileU(0), tileU(1)];
const BEARD_U = tileU(2);
export const FERN_U = tileU(3);

/** The shape of one trunk: radius at an angle and a height, and where its axis is at a height. */
export interface TrunkShape {
  rho(th: number, h: number): number;
  /** How deep in the fire scar a place on the bark is, 0..1. */
  scar(th: number, h: number): number;
  /** Mean radius at a height (no lobes). */
  mean(h: number): number;
  axis(h: number): [number, number];
  /** First bough and the top of the foliage (m above the foot); `snag`: the last of the trunk stands bare above it. */
  first: number;
  top: number;
  snag: boolean;
  /** The reach of the crown from the axis (m). */
  crown: number;
}

export function trunkShape(g: Giant): TrunkShape {
  const rnd = mulberry32(g.seed);
  const H = g.h;
  const r = g.r;
  const nL = 5 + Math.floor(rnd() * 3);
  const lobes: [number, number, number][] = [];
  for (let i = 0; i < nL; i++) lobes.push([((i + 0.6 * rnd()) / nL) * Math.PI * 2, 0.5 + 0.5 * rnd(), 0.16 + 0.16 * rnd()]);
  const lobe = (th: number): number => {
    let v = 0;
    for (const [a, w, s] of lobes) {
      let d = th - a;
      d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
      v = Math.max(v, w * Math.exp(-(d * d) / (s * s)));
    }
    return v;
  };
  const twist = (rnd() - 0.5) * 0.009;
  const ph = rnd() * 6.28;
  const leanA = rnd() * 6.28;
  const lean = 0.012 + 0.022 * rnd();
  const snag = rnd() < 0.28;
  const mean = (h: number): number => {
    const t = Math.min(1, Math.max(0, h / H));
    const tip = Math.min(1, Math.max(0, (t - 0.8) / 0.2));
    return r * (1 - 0.5 * Math.pow(t, 1.25)) * (1 - 0.9 * tip * tip * (3 - 2 * tip));
  };
  // the flare of the roots: two thirds of a radius more at the ground, gone a radius and a half up; under the ground they run on outward
  const flare = (h: number): number => (h >= 0 ? r * 0.68 * Math.exp(-h / (0.5 * r + 0.6)) : r * 0.68 - h * 0.6);
  // a fire went through, centuries ago: on two trunks in five a black hollow at the foot, narrowing upward to a point
  const scarred = rnd() < 0.4;
  const scarA = rnd() * 6.28;
  const scarH = 7 + 9 * rnd();
  const scarW = 0.45 + 0.35 * rnd();
  const scar = (th: number, h: number): number => {
    if (!scarred || h >= scarH) return 0;
    let d = th - scarA;
    d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
    const w = scarW * (1 - Math.max(0, h) / scarH);
    const t = Math.min(1, Math.max(0, 1 - Math.abs(d) / w));
    return t * t * (3 - 2 * t);
  };
  const first = Math.min(46, Math.max(30, H * (0.3 + 0.1 * rnd())));
  return {
    rho: (th, h) => mean(h) * (1 + 0.13 * Math.exp(-Math.max(0, h) / 34) * (lobe(th + twist * h) - 0.45) + 0.02 * Math.sin(3 * th + ph + h * 0.07) - 0.2 * scar(th, h)) + flare(h) * (0.16 + 0.84 * lobe(th)),
    scar,
    mean,
    axis: (h) => {
      const k = (Math.max(0, h) * Math.max(0, h)) / H;
      return [Math.cos(leanA) * lean * k, Math.sin(leanA) * lean * k];
    },
    first,
    top: snag ? H * (0.86 + 0.05 * rnd()) : H,
    snag,
    crown: 8 + 0.07 * H + r,
  };
}

/** The heights of a trunk's rings (m above its foot): close together where the roots flare, a ring at 9, 14 and 20 m on every trunk. */
function ringHeights(H: number, lod: GiantLod, li: number): number[] {
  const low = li === 0 ? [-2.5, 0, 0.45, 1.1, 2.1, 3.5, 5.5, 9, 14, 20, 28] : li === 1 ? [-2, 0, 1.1, 3.5, 9, 14, 20, 30] : [-2, 0, 3.5, 9, 14, 20];
  const out = [...low];
  let h = low[low.length - 1] + lod.step;
  while (h < H * 0.94) {
    out.push(h);
    h += lod.step;
  }
  out.push(H * 0.97, H);
  return out;
}

/** A round tube along a path (the limbs), closed at its far end by its own taper. `probe`: the sunlight of all of it. */
function tube(b: GBuf, path: number[], radius: number[], sides: number, shade: number, probe: number, vScale: number): void {
  const n = radius.length;
  const base = b.n;
  let ux = 0;
  let uy = 1;
  let uz = 0;
  let len = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1) * 3;
    const c = Math.min(n - 1, i + 1) * 3;
    let tx = path[c] - path[a];
    let ty = path[c + 1] - path[a + 1];
    let tz = path[c + 2] - path[a + 2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    if (i > 0) len += Math.hypot(path[i * 3] - path[i * 3 - 3], path[i * 3 + 1] - path[i * 3 - 2], path[i * 3 + 2] - path[i * 3 - 1]);
    // a reference square to the tangent, carried along so that the tube does not twist
    const d = ux * tx + uy * ty + uz * tz;
    ux -= tx * d;
    uy -= ty * d;
    uz -= tz * d;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    // v = u x t: the ring then turns the same way round as a trunk's
    const vx = uy * tz - uz * ty;
    const vy = uz * tx - ux * tz;
    const vz = ux * ty - uy * tx;
    for (let j = 0; j <= sides; j++) {
      const an = (j / sides) * Math.PI * 2;
      const cs = Math.cos(an);
      const sn = Math.sin(an);
      const nx = ux * cs + vx * sn;
      const ny = uy * cs + vy * sn;
      const nz = uz * cs + vz * sn;
      // (the underside of a limb is in its own shade)
      const k = shade * (0.72 + 0.28 * Math.max(0, ny * 0.5 + 0.5));
      b.v(path[i * 3] + nx * radius[i], path[i * 3 + 1] + ny * radius[i], path[i * 3 + 2] + nz * radius[i], nx, ny, nz, (j / sides) * 2, len / vScale, k, k, k, probe);
    }
  }
  const row = sides + 1;
  for (let i = 0; i + 1 < n; i++) {
    for (let j = 0; j < sides; j++) {
      const a = base + i * row + j;
      b.idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
    }
  }
}

/**
 * A pad of foliage: a dark core (what shows between the cards is shade, not sky) and cards lying on and round it, most of them
 * nearly level, as the sprays of a conifer lie. Lit from above in its colours: the underside is dark.
 */
function pad(b: GBuf, rnd: () => number, cx: number, cy: number, cz: number, rh: number, rv: number, lod: GiantLod, tint: [number, number, number], probe: number, deep: number): void {
  // the core
  const sides = lod.core;
  const u = PAD_U[0][0] + (PAD_U[0][1] - PAD_U[0][0]) * 0.46;
  const yaw = rnd() * 6.28;
  const top = b.v(cx, cy + rv * 0.5, cz, 0, 1, 0, u, 0.5, tint[0] * 0.5 * deep, tint[1] * 0.5 * deep, tint[2] * 0.5 * deep, probe, 0.1);
  const bot = b.v(cx, cy - rv * 0.62, cz, 0, -1, 0, u, 0.5, tint[0] * 0.2 * deep, tint[1] * 0.2 * deep, tint[2] * 0.2 * deep, probe, 0.1);
  const ring = b.n;
  for (let i = 0; i < sides; i++) {
    const a = yaw + (i / sides) * Math.PI * 2;
    const k = 0.34 * deep;
    b.v(cx + Math.cos(a) * rh * 0.7, cy - rv * 0.12, cz + Math.sin(a) * rh * 0.7, Math.cos(a) * 0.8, 0.6, Math.sin(a) * 0.8, u, 0.5, tint[0] * k, tint[1] * k, tint[2] * k, probe, 0.1);
  }
  for (let i = 0; i < sides; i++) {
    const a = ring + i;
    const c = ring + ((i + 1) % sides);
    b.idx.push(top, c, a, bot, a, c);
  }
  // the cards
  const GOLD = 2.399963;
  for (let i = 0; i < lod.cards; i++) {
    const a = yaw + i * GOLD + (rnd() - 0.5) * 0.6;
    const out = i === 0 ? 0.1 : 0.45 + 0.45 * rnd();
    const px = cx + Math.cos(a) * rh * out;
    const pz = cz + Math.sin(a) * rh * out;
    const py = cy + rv * (i === 0 ? 0.55 : 0.5 - 0.65 * out + 0.3 * rnd());
    // the card's plane: level, tipped outward and down by a quarter of a turn at most, rolled a little
    const tip = (i === 0 ? 0.1 : 0.3 + 0.9 * out * rnd()) * (rnd() < 0.85 ? 1 : -0.5);
    const half = rh * (0.52 + 0.2 * rnd()) * (lod.cards <= 2 ? 1.35 : lod.cards <= 4 ? 1.12 : 1);
    const ox = Math.cos(a);
    const oz = Math.sin(a);
    // axes: e1 outward and down, e2 square to it and level
    const e1x = ox * Math.cos(tip);
    const e1y = -Math.sin(tip);
    const e1z = oz * Math.cos(tip);
    const roll = (rnd() - 0.5) * 0.5;
    const e2x = -oz * Math.cos(roll);
    const e2y = Math.sin(roll);
    const e2z = ox * Math.cos(roll);
    const [u0, u1] = PAD_U[rnd() < 0.5 ? 0 : 1];
    const fu = rnd() < 0.5;
    const fv = rnd() < 0.5;
    const base = b.n;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const x = px + (e1x * sx + e2x * sy) * half;
      const y = py + (e1y * sx + e2y * sy) * half;
      const z = pz + (e1z * sx + e2z * sy) * half;
      // soft normals: away from a point under the pad, and upward
      let nx = x - cx;
      let ny = y - (cy - rv * 1.6);
      let nz = z - cz;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx = (nx / nl) * 0.7;
      ny = (ny / nl) * 0.7 + 0.3;
      nz = (nz / nl) * 0.7;
      const l2 = Math.hypot(nx, ny, nz);
      // light: the top and the rim are in the open, the middle and the underside are not
      const hgt = Math.min(1, Math.max(0, (y - (cy - rv * 0.6)) / (rv * 1.3)));
      const k = (0.5 + 0.5 * hgt) * (0.8 + 0.2 * Math.min(1, Math.hypot(x - cx, z - cz) / rh)) * deep * (0.9 + 0.2 * rnd());
      b.v(x, y, z, nx / l2, ny / l2, nz / l2, u0 + (u1 - u0) * ((fu ? -sx : sx) * 0.5 + 0.5), 0.02 + 0.96 * ((fv ? -sy : sy) * 0.5 + 0.5), tint[0] * k, tint[1] * k, tint[2] * k, probe, 0.25);
    }
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/** A beard of lichen hanging from a limb: a card in the plane of the limb, fixed along its top, free below. */
function beard(b: GBuf, x: number, y: number, z: number, dx: number, dz: number, w: number, h: number, k: number, probe: number, flip: boolean): void {
  const base = b.n;
  const [u0, u1] = BEARD_U;
  for (const [sx, sy] of [[-1, 1], [1, 1], [1, 0], [-1, 0]]) {
    const u = (flip ? -sx : sx) * 0.5 + 0.5;
    b.v(x + dx * sx * w, y - (1 - sy) * h, z + dz * sx * w, -dz * 0.5, 0.7, dx * 0.5, u0 + (u1 - u0) * u, 0.02 + 0.96 * sy, k, k, k * 0.96, probe, sy > 0.5 ? 0 : 1);
  }
  b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * Build one giant into the two buffers and tell the shade model what it is made of (a trunk and pads: what hides the sun from the
 * others) and where its sunlight is to be probed.
 */
export function emitGiant(g: Giant, li: number, bark: GBuf, leaf: GBuf, shade: ShadeModel, tree: number): void {
  const lod = GIANT_LODS[li];
  const sh = trunkShape(g);
  const rnd = mulberry32(g.seed ^ 0x2545f491);
  const H = g.h;
  const cy = Math.cos(g.yaw);
  const sy = Math.sin(g.yaw);
  /** A point of the tree (its own x, height, z) in the world. */
  const wx = (x: number, z: number): number => g.x + x * cy - z * sy;
  const wz = (x: number, z: number): number => g.z + x * sy + z * cy;

  // ── the trunk ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const rings = ringHeights(H, lod, li);
  const S = lod.sides;
  const nU = Math.max(3, Math.round((2 * Math.PI * g.r) / BARK_U));
  const base = bark.n;
  // a bark of its own: redder or greyer, lighter or darker
  const warm = 0.9 + 0.2 * rnd();
  const tone: [number, number, number] = [(0.92 + 0.16 * rnd()) * warm, 0.94 + 0.1 * rnd(), (0.96 + 0.1 * rnd()) / warm];
  const mossA = rnd() * 6.28;
  const uOff = rnd();
  const vOff = rnd();
  shade.addTrunk(g.x, g.z, g.y, sh.snag ? H : H * 0.97, g.r, sh.mean(H * 0.8), tree);
  for (let k = 0; k < rings.length; k++) {
    const h = rings[k];
    const [ax, az] = sh.axis(h);
    const probe = h >= PROBE_FROM ? shade.addProbe(wx(ax, az), g.y + h, wz(ax, az), sh.mean(h), tree, -1) : NO_PROBE;
    // shade painted into the bark: the foot stands in its own roots' shade, the crown shades the trunk inside it; the dead top is bleached
    const foot = 0.55 + 0.45 * Math.min(1, Math.max(0, h) / 5);
    const under = 1 - 0.34 * Math.min(1, Math.max(0, (h - sh.first * 0.8) / (sh.first * 0.5)));
    const dead = sh.snag ? Math.min(1, Math.max(0, (h - sh.top) / (H - sh.top + 1e-3) + 0.25)) : 0;
    for (let i = 0; i <= S; i++) {
      const th = (i / S) * Math.PI * 2;
      const e = 0.02;
      const rho = sh.rho(th, h);
      const dth = (sh.rho(th + e, h) - sh.rho(th - e, h)) / (2 * e);
      const dh = (sh.rho(th, h + 0.25) - sh.rho(th, h - 0.25)) / 0.5;
      const c = Math.cos(th);
      const s = Math.sin(th);
      let nx = rho * c + dth * s;
      let ny = -rho * Math.max(-1.2, Math.min(1.2, dh));
      let nz = rho * s - dth * c;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const x = ax + rho * c;
      const z = az + rho * s;
      // between two roots the bark is in a fold: darker; moss up the foot on one side
      const fold = 0.72 + 0.28 * Math.min(1, (rho - sh.mean(h)) / (0.5 * g.r * Math.exp(-Math.max(0, h) / (0.5 * g.r + 0.6)) + 0.3) + 0.35);
      const moss = Math.max(0, 1 - Math.max(0, h) / (7 + 5 * Math.sin(th * 2 + mossA))) * (0.5 + 0.5 * Math.cos(th - mossA));
      // (and no two patches of it the same: the tile of bark repeats, the light on it does not)
      const char = sh.scar(th, h);
      const k0 = foot * under * (h < 12 ? fold : 1) * (0.84 + 0.3 * rnd()) * (1 - 0.86 * char);
      const cr = k0 * tone[0] * (1 - 0.42 * moss) * (1 + 0.5 * dead);
      const cg = k0 * tone[1] * (1 - 0.1 * moss) * (1 + 0.75 * dead);
      const cb = k0 * tone[2] * (1 - 0.5 * moss) * (1 + 1.0 * dead);
      bark.v(wx(x, z), g.y + h, wz(x, z), nx * cy - nz * sy, ny, nx * sy + nz * cy, (i / S) * nU + uOff, h / BARK_V + vOff, cr, cg, cb, probe);
    }
  }
  const row = S + 1;
  for (let k = 0; k + 1 < rings.length; k++) {
    for (let i = 0; i < S; i++) {
      const a = base + k * row + i;
      bark.idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
    }
  }

  // ── the crown: limbs, pads, lichen ────────────────────────────────────────────────────────────────────────────────────────────
  const tint: [number, number, number] = [0.86 + 0.24 * rnd(), 0.9 + 0.18 * rnd(), 0.84 + 0.3 * rnd()];
  const nB = lod.boughs + Math.floor(rnd() * 3);
  const GOLD = 2.399963;
  const az0 = rnd() * 6.28;
  const span = sh.top * 0.95 - sh.first;
  const path: number[] = [];
  const rad: number[] = [];
  for (let i = 0; i < nB; i++) {
    // the first limb or two stand alone, well under the rest
    const u = i === 0 ? 0 : Math.pow((i + 0.3 + 0.5 * rnd()) / nB, 0.85);
    const hb = sh.first + span * u;
    const a = az0 + i * GOLD + (rnd() - 0.5) * 0.7;
    // the crown's outline: widest a third of the way up, a rounded top
    const env = sh.crown * (u < 0.3 ? 0.74 + 0.26 * Math.sin((Math.PI / 2) * (u / 0.3)) : 0.3 + 0.7 * Math.pow(Math.cos((Math.PI / 2) * ((u - 0.3) / 0.7)), 0.8));
    const L = env * (0.82 + 0.36 * rnd());
    const droop = (0.34 - 0.2 * u) * (0.6 + 0.8 * rnd());
    const rise = 0.14 + 0.5 * u * (0.6 + 0.8 * rnd());
    const [ax, az] = sh.axis(hb);
    const r0 = sh.mean(hb);
    const rb = Math.min(1.25, Math.max(0.28, 0.035 * L + 0.14 * r0));
    const ox = Math.cos(a);
    const oz = Math.sin(a);
    const at = (t: number): [number, number, number] => {
      const out = r0 * 0.7 + L * t * (1 - 0.1 * t);
      const up = L * (rise * t * t - droop * Math.sin(Math.PI * t) * (1 - t) * 0.9);
      return [ax + ox * out, hb + up, az + oz * out];
    };
    path.length = 0;
    rad.length = 0;
    for (let j = 0; j <= lod.bSegs; j++) {
      const t = j / lod.bSegs;
      const p = at(t);
      path.push(wx(p[0], p[2]), g.y + p[1], wz(p[0], p[2]));
      rad.push(rb * (1 - 0.78 * t));
    }
    const mid = at(0.5);
    const bp = shade.addProbe(wx(mid[0], mid[2]), g.y + mid[1] + rb + 0.5, wz(mid[0], mid[2]), 0, tree, -1);
    tube(bark, path, rad, lod.bSides, 0.7 * (0.9 + 0.2 * rnd()), bp, BARK_V);
    // pads along the outer half of the limb, and one beyond its tip
    const nP = lod.pads;
    for (let j = 0; j < nP; j++) {
      const t = nP === 1 ? 0.9 : nP === 2 ? 0.52 + 0.53 * j : 0.4 + (0.65 * j) / (nP - 1);
      const p = at(Math.min(1, t));
      const rh = Math.min(9, Math.max(3.8, L * (0.33 + 0.14 * rnd()))) * PAD_GROW[li] * (t > 1 ? 0.85 : 1);
      const rv = rh * (0.44 + 0.14 * rnd());
      const side = (rnd() - 0.5) * rh * 0.9;
      const px = p[0] + ox * Math.max(0, t - 1) * L - oz * side;
      const pz = p[2] + oz * Math.max(0, t - 1) * L + ox * side;
      const py = p[1] + rv * (0.35 + 0.5 * rnd());
      const X = wx(px, pz);
      const Z = wz(px, pz);
      const pi = shade.addPad(X, g.y + py, Z, rh, rv, tree);
      const pp = shade.addProbe(X, g.y + py + rv * 0.3, Z, 0, tree, pi);
      // (the pads low in the crown and near the trunk have the rest of the crown over them)
      pad(leaf, rnd, X, g.y + py, Z, rh, rv, lod, tint, pp, 0.78 + 0.22 * Math.min(1, u * 1.4 + 0.25 * j));
    }
    // beards of lichen under the limb
    const nBe = Math.floor(lod.beards * (1.3 - u) + rnd());
    for (let j = 0; j < nBe; j++) {
      const t = 0.3 + 0.5 * rnd();
      const p = at(t);
      const w = 1.6 + 2.2 * rnd();
      const cyw = ox * cy - oz * sy;
      const czw = ox * sy + oz * cy;
      beard(leaf, wx(p[0], p[2]), g.y + p[1] - rb * (1 - 0.7 * t) * 0.6, wz(p[0], p[2]), cyw, czw, w, 4 + 7 * rnd(), 0.5 + 0.25 * rnd(), bp, rnd() < 0.5);
    }
  }
  // pads close in to the trunk all the way up the crown: an old giant is clothed, not a pole with a wreath round it
  const nI = [7, 4, 2][li];
  for (let i = 0; i < nI; i++) {
    const h = sh.first + span * (0.1 + (0.86 * (i + rnd())) / nI);
    const a = az0 + 2 + i * GOLD + (rnd() - 0.5);
    const [ax, az] = sh.axis(h);
    const rh = (3.2 + 2.4 * rnd()) * PAD_GROW[li];
    const rv = rh * 0.5;
    const d = sh.mean(h) + rh * (0.35 + 0.4 * rnd());
    const X = wx(ax + Math.cos(a) * d, az + Math.sin(a) * d);
    const Z = wz(ax + Math.cos(a) * d, az + Math.sin(a) * d);
    const pi = shade.addPad(X, g.y + h, Z, rh, rv, tree);
    const pp = shade.addProbe(X, g.y + h + rv * 0.3, Z, 0, tree, pi);
    pad(leaf, rnd, X, g.y + h, Z, rh, rv, lod, tint, pp, 0.74);
  }
  // the top: pads round the leader (a dead top has them under the spike)
  const nT = [5, 4, 3][li];
  for (let i = 0; i < nT; i++) {
    const a = az0 + 1 + i * GOLD;
    const t = i / nT;
    const h = sh.top * (0.985 - 0.085 * t);
    const [ax, az] = sh.axis(h);
    const d = i === 0 && !sh.snag ? 0 : sh.crown * (0.12 + 0.2 * t);
    const rh = (4.2 + 2.2 * rnd()) * PAD_GROW[li];
    const rv = rh * 0.5;
    const X = wx(ax + Math.cos(a) * d, az + Math.sin(a) * d);
    const Z = wz(ax + Math.cos(a) * d, az + Math.sin(a) * d);
    const pi = shade.addPad(X, g.y + h, Z, rh, rv, tree);
    const pp = shade.addProbe(X, g.y + h + rv * 0.3, Z, 0, tree, pi);
    pad(leaf, rnd, X, g.y + h, Z, rh, rv, lod, tint, pp, 1);
  }
  // sprays on the trunk itself, under the first limb (the near trees only)
  if (li === 0) {
    const n = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const h = sh.first * (0.62 + 0.3 * rnd());
      const a = rnd() * 6.28;
      const [ax, az] = sh.axis(h);
      const d = sh.mean(h) + 0.6;
      const X = wx(ax + Math.cos(a) * d, az + Math.sin(a) * d);
      const Z = wz(ax + Math.cos(a) * d, az + Math.sin(a) * d);
      const rh = 1.6 + 1.2 * rnd();
      const pp = shade.addProbe(X, g.y + h, Z, 0, tree, -1);
      pad(leaf, rnd, X, g.y + h, Z, rh, rh * 0.5, GIANT_LODS[1], tint, pp, 0.8);
    }
  }
}

/** A fern: three arching fronds' worth of cards crossed at its foot, lit from above. */
export function emitFern(b: GBuf, x: number, y: number, z: number, s: number, yaw: number, k: number): void {
  const [u0, u1] = FERN_U;
  for (let i = 0; i < 2; i++) {
    const a = yaw + i * (Math.PI / 2) + 0.3;
    const dx = Math.cos(a) * s * 0.75;
    const dz = Math.sin(a) * s * 0.75;
    const base = b.n;
    for (const [sx, sy] of [[-1, 0], [1, 0], [1, 1], [-1, 1]]) {
      const c = k * (0.55 + 0.45 * sy);
      b.v(x + dx * sx, y - 0.1 + sy * s, z + dz * sx, dx * sx * 0.25, 0.9, dz * sx * 0.25, u0 + (u1 - u0) * (sx * 0.5 + 0.5), 0.02 + 0.96 * sy, c * 0.92, c, c * 0.8, NO_PROBE, sy * 0.35);
    }
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}
