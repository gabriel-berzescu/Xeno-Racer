/**
 * The five boats of an island circuit's fleet (fleet.ts), from an outrigger canoe to a three-masted ship. Six thousand years on,
 * and people still sail because they like to: the hulls are seed pods without a seam, pointed at both ends; the masts bend aft
 * like blades of grass; the sails are membranes, each a single leaf from boom to masthead, in the colour its owner chose. They
 * are the children of the great ship in the sky (fleetShip.ts), which has their shape.
 *
 * A boat's frame: the bow at +x, up +y, starboard +z, the waterline at y = 0, metres. One geometry per kind; the instances differ by
 * the colour of their sails and of their hull, by how much sail they carry and by its trim (see fleetKit.ts).
 */
import { mulberry32 } from '../math';
import type { BoatKind } from '../types';
import { FleetBuf, KIND, type RGB, type SurfaceFn, type V3, figure, lamp, lin, patch, solid, span, tube } from './fleetKit';

const WHITE = lin(0xf6f3ea);
const BOOT = lin(0x18262b);
const DECK = lin(0xd8ccb0);
const HOUSE = lin(0xefeade);
const SPAR = lin(0xe6e0d0);
const GLASS = lin(0x2c444c);
const NET = lin(0x3a4347);
const SKIN = [lin(0xe2b48e), lin(0xb98258), lin(0x7c563a), lin(0xf0caa6)];
const SHIRTS = [lin(0xf4f1ea), lin(0xe8523a), lin(0x2f8fd8), lin(0xf2c230), lin(0x2fbf9a), lin(0xf08ab0), lin(0x30343c), lin(0xf59a3c), lin(0x8a6cf0), lin(0xdfe8ee)];

/** The lights a boat carries after dark: a riding light at the masthead, lanterns, and the red and the green of her sides. */
const RIDING = lin(0xfff3de);
const LANTERN = lin(0xffb056);
const PORT = lin(0xff3a28);
const STARBOARD = lin(0x38ff8c);

const ease = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

// ── hulls ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface HullSpec {
  /** Length, beam, freeboard amidships and draught (m). */
  L: number;
  B: number;
  F: number;
  draft: number;
  /** Where it is widest (0 the stern .. 1 the bow), and how full the ends are (the higher, the fuller). */
  wide?: number;
  fore?: number;
  aft?: number;
  /** How much the deck's edge rises to the bow and to the stern (shares of the freeboard), and how far the ends lean out (m). */
  sheerBow: number;
  sheerStern: number;
  rakeBow: number;
  rakeStern: number;
  /** Where its middle is (a catamaran has two, an outrigger a float). */
  x0?: number;
  z0?: number;
  /** Stations along it. */
  n: number;
  /** A float has no colour of its own and no deck worth the name. */
  plain?: boolean;
}

interface Hull {
  /** The height of the deck at x (m over the water) and its half breadth there. */
  deckAt: (x: number) => number;
  halfAt: (x: number) => number;
}

/** A hull without a seam: a pod pointed at both ends, a dark boot below the waterline, a deck with a little crown. */
function hull(buf: FleetBuf, h: HullSpec): Hull {
  const wide = h.wide ?? 0.46;
  const x0 = h.x0 ?? 0;
  const z0 = h.z0 ?? 0;
  const half = (t: number): number => (h.B / 2) * (t >= wide ? 1 - Math.pow((t - wide) / (1 - wide), h.fore ?? 2.1) : 1 - Math.pow((wide - t) / wide, h.aft ?? 2.6));
  const sheer = (t: number): number => h.F * (1 + (t >= wide ? h.sheerBow * ((t - wide) / (1 - wide)) ** 2 : h.sheerStern * ((wide - t) / wide) ** 2));
  const keel = (t: number): number => -h.draft * Math.pow(Math.max(0, 4 * t * (1 - t)), 0.55);
  const rake = (t: number): number => h.rakeBow * ease((t - 0.6) / 0.4) - h.rakeStern * ease((0.4 - t) / 0.4);
  /** The line where the boot ends, over the water. */
  const BOOT_Y = Math.min(0.14, h.F * 0.16);
  const VW = 0.36;
  // round the girth: v = -1 is the deck's edge to port, 0 the keel, 1 the deck's edge to starboard, and |v| = VW the top of the boot at every station
  const side: SurfaceFn = (t, v, o) => {
    const yk = keel(t);
    const hd = sheer(t);
    // how far up the section the boot's line is, as the section's own parameter
    const kw = Math.min(0.9, (BOOT_Y - yk) / (hd - yk));
    const sw = (Math.acos(1 - Math.pow(kw, 1 / 1.1)) * 2) / Math.PI;
    const a = Math.abs(v);
    const s = a <= VW ? (a / VW) * sw : sw + ((a - VW) / (1 - VW)) * (1 - sw);
    const k = Math.pow(1 - Math.cos((s * Math.PI) / 2), 1.1);
    o[0] = x0 - h.L / 2 + h.L * t + rake(t) * k;
    o[1] = yk + (hd - yk) * k;
    o[2] = z0 + Math.sign(v) * half(t) * Math.pow(Math.sin((s * Math.PI) / 2), 0.72);
  };
  const us = span(h.n);
  const E = 0.012;
  const vs = h.plain ? [-1, -0.5, 0, 0.5, 1] : [-1, -0.64, -VW - E, -VW, 0, VW, VW + E, 0.64, 1];
  const top = solid(0, !h.plain);
  patch(buf, us, vs, side, (_t, v) => (h.plain ? { c: WHITE } : Math.abs(v) <= VW + E / 2 ? { c: BOOT } : { c: WHITE, rig: top }));
  const crown = h.B * 0.035;
  const deck: SurfaceFn = (t, w, o) => {
    o[0] = x0 - h.L / 2 + h.L * t + rake(t);
    o[1] = sheer(t) + crown * (1 - w * w) * (half(t) / (h.B / 2));
    o[2] = z0 + w * half(t);
  };
  patch(buf, us, h.plain ? [-1, 1] : [-1, 0, 1], deck, () => ({ c: h.plain ? WHITE : DECK }), { flip: true });
  const tOf = (x: number): number => Math.min(1, Math.max(0, (x - x0 + h.L / 2) / h.L));
  return { deckAt: (x) => sheer(tOf(x)) + crown * 0.6, halfAt: (x) => half(tOf(x)) };
}

/** A deckhouse: a low blister with a band of glass round it, lit from inside after dark. */
function house(buf: FleetBuf, cx: number, y0: number, cz: number, a: number, b: number, c: number, sides = 10): void {
  const f: SurfaceFn = (u, v, o) => {
    const an = u * Math.PI * 2;
    const el = (v * Math.PI) / 2;
    o[0] = cx + a * Math.cos(an) * Math.cos(el);
    o[1] = y0 + c * Math.sin(el);
    o[2] = cz + b * Math.sin(an) * Math.cos(el);
  };
  patch(buf, span(sides), [0, 0.2, 0.52, 0.8, 1], f, (_u, v) => (v > 0.2 && v < 0.52 ? { c: GLASS, rig: solid(-0.9, false, 0.12) } : { c: HOUSE }), { flip: true, cells: true });
}

// ── rigs ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface SailSpec {
  /** The luff: its foot and its head (x, y), and how it bends on the way (1: straight; more: the head curls aft). */
  foot: [number, number];
  head: [number, number];
  bend?: number;
  /** The chord (m) at a height (0 the foot .. 1 the head), and the belly as a share of it. */
  chord: (t: number) => number;
  camber?: number;
  nu: number;
  nt: number;
}

/** The luff of a sail at t. */
function luffOf(s: SailSpec, t: number): [number, number] {
  return [s.foot[0] + (s.head[0] - s.foot[0]) * Math.pow(Math.max(0, t), s.bend ?? 1), s.foot[1] + (s.head[1] - s.foot[1]) * t];
}

/** A membrane from its luff aft: the vertices lie on the luff and carry how far along the chord and how far out in the belly they belong. */
function sail(buf: FleetBuf, s: SailSpec): void {
  const camber = s.camber ?? 0.1;
  const along = (u: number, t: number): number => u * s.chord(t);
  const belly = (u: number, t: number): number => camber * s.chord(t) * 4 * u * (1 - u) * (0.62 + 0.38 * Math.sin(Math.PI * t));
  const f: SurfaceFn = (u, t, o) => {
    const l = luffOf(s, t);
    o[0] = l[0] - along(u, t);
    o[1] = l[1];
    o[2] = belly(u, t);
  };
  patch(
    buf,
    span(s.nu),
    span(s.nt),
    f,
    // red: how pale (toward the head, and a pale line down the luff); green: its shade
    (u, t) => ({ c: [0.04 + 0.36 * t * t + 0.25 * Math.max(0, 1 - u * 5), 0.94 + 0.06 * u, 0], rig: [KIND.sail, along(u, t), belly(u, t), 0] }),
    {
      flip: true,
      store: (_u, t) => {
        const l = luffOf(s, t);
        return [l[0], l[1], 0];
      },
    },
  );
}

/** The mast a sail is set on: from the deck up its luff, tapering. */
function mast(buf: FleetBuf, s: SailSpec, deckY: number, r0: number, sides = 5): void {
  const path: V3[] = [[s.foot[0], deckY, 0]];
  const rad: number[] = [r0];
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 1.015;
    const l = luffOf(s, t);
    path.push([l[0], l[1], 0]);
    rad.push(r0 * (1 - 0.72 * (i / n)));
  }
  tube(buf, path, rad, sides, SPAR);
}

/** A leaf: nearly its full chord at the foot, fullest a third of the way up, round to a small head. */
function leaf(c: number, foot = 0.8, peak = 0.3, head = 0.08): (t: number) => number {
  return (t) => (t < peak ? c * (foot + (1 - foot) * Math.sin(((t / peak) * Math.PI) / 2)) : c * (head + (1 - head) * Math.sqrt(Math.max(0, 1 - ((t - peak) / (1 - peak)) ** 2))));
}
/** A headsail: a triangle, a little hollow. */
function jib(c: number): (t: number) => number {
  return (t) => c * Math.pow(1 - t, 0.9);
}

/** Lanterns on a line from a to b, hanging `sag` m low in the middle. */
function lanterns(buf: FleetBuf, a: V3, b: V3, n: number, sag: number, r: number): void {
  for (let i = 1; i < n; i++) {
    const t = i / n;
    lamp(buf, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t], r, LANTERN, 0.55 + 0.25 * ((i * 7) % 3));
  }
}

/** The people aboard: `n` of them on a deck, standing or sitting, wherever `place` puts them. */
function crew(buf: FleetBuf, seed: number, n: number, place: (i: number, rnd: () => number) => [number, number, number, boolean?]): void {
  const rnd = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const [x, y, z, sitting] = place(i, rnd);
    figure(buf, x, y, z, sitting ? 0.95 + 0.1 * rnd() : 1.6 + 0.25 * rnd(), SHIRTS[Math.floor(rnd() * SHIRTS.length)], SKIN[Math.floor(rnd() * SKIN.length)], rnd() * 6.28);
  }
}

// ── the five ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface BoatClass {
  kind: BoatKind;
  /** Length, beam and draught (m), and the height of the masthead over the water. */
  length: number;
  beam: number;
  draft: number;
  height: number;
  /** How far it rolls at anchor (rad) and heels under sail. */
  roll: number;
  heel: number;
  /** The chance that its sails are a strong colour and not a pale one. */
  bright: number;
  build: (buf: FleetBuf) => void;
}

/**
 * The outrigger canoe: a slim hull and a float to starboard on two bent arms, under a crab claw (the oldest sail of this kind of sea:
 * a membrane between two spars that meet at the bow).
 */
function proa(buf: FleetBuf): void {
  hull(buf, { L: 7.4, B: 0.92, F: 0.52, draft: 0.25, sheerBow: 0.85, sheerStern: 0.7, rakeBow: 0.55, rakeStern: 0.45, n: 7 });
  hull(buf, { L: 4.6, B: 0.4, F: 0.24, draft: 0.14, sheerBow: 0.5, sheerStern: 0.5, rakeBow: 0.3, rakeStern: 0.3, x0: -0.2, z0: 2.75, n: 4, plain: true });
  for (const x of [1.25, -1.5]) {
    tube(buf, [[x, 0.5, 0], [x - 0.05, 0.8, 0.9], [x - 0.12, 0.72, 1.9], [x - 0.2, 0.26, 2.75]], [0.05, 0.05, 0.045, 0.04], 3, SPAR);
  }
  // the claw: the upper spar from the tack at the bow to the peak, the boom below it, the membrane between and a hollow leech
  const tack: [number, number] = [3.0, 0.78];
  const peak: [number, number] = [-1.25, 7.6];
  const clew: [number, number] = [-4.0, 2.7];
  const tb = (clew[1] - tack[1]) / (peak[1] - tack[1]);
  const spec: SailSpec = {
    foot: tack,
    head: peak,
    bend: 1.22,
    nu: 3,
    nt: 7,
    camber: 0.12,
    chord: (t) => {
      const lx = luffOf(spec, t)[0];
      if (t <= tb) return Math.max(0, lx - (tack[0] + (clew[0] - tack[0]) * (t / tb)));
      const s = (t - tb) / (1 - tb);
      return Math.max(0, lx - (clew[0] + (peak[0] - clew[0]) * s + 0.95 * Math.sin(Math.PI * s)));
    },
  };
  sail(buf, spec);
  mast(buf, spec, 0.6, 0.06, 4);
  // the boom goes with the sail: a ribbon along its foot
  for (let i = 0; i < 3; i++) {
    const t0 = (tb * i) / 3;
    const t1 = (tb * (i + 1)) / 3;
    const a = luffOf(spec, t0);
    const b = luffOf(spec, t1);
    const n: V3 = [0, 0, 1];
    const k = buf.v([a[0], a[1] - 0.06, 0], n, SPAR, [KIND.sail, spec.chord(t0), 0, 1]);
    buf.v([b[0], b[1] - 0.06, 0], n, SPAR, [KIND.sail, spec.chord(t1), 0, 1]);
    buf.v([b[0], b[1] + 0.06, 0], n, SPAR, [KIND.sail, spec.chord(t1), 0, 1]);
    buf.v([a[0], a[1] + 0.06, 0], n, SPAR, [KIND.sail, spec.chord(t0), 0, 1]);
    buf.tri(k, k + 1, k + 2);
    buf.tri(k, k + 2, k + 3);
  }
  crew(buf, 11, 2, (i) => [i === 0 ? -1.9 : 0.1, 0.28, 0, true]);
  lamp(buf, [peak[0], peak[1] + 0.15, 0], 0.26, RIDING);
  lamp(buf, [-3.3, 1.05, 0], 0.22, LANTERN);
}

/** The catamaran: two slim hulls, a net between them, a pod to sit in, one tall leaf and a small headsail. */
function cat(buf: FleetBuf): void {
  for (const z of [-2.9, 2.9]) hull(buf, { L: 11.8, B: 1.3, F: 0.98, draft: 0.4, sheerBow: 0.4, sheerStern: 0.12, rakeBow: 0.9, rakeStern: 0.5, z0: z, n: 8 });
  for (const x of [1.7, -3.7]) tube(buf, [[x, 1.02, -2.9], [x, 1.14, 0], [x, 1.02, 2.9]], [0.12, 0.13, 0.12], 4, SPAR);
  buf.quad([-3.7, 1.04, -2.35], [-3.7, 1.04, 2.35], [1.7, 1.04, 2.35], [1.7, 1.04, -2.35], NET);
  house(buf, -1.5, 1.04, 0, 2.1, 1.3, 1.05, 8);
  const main: SailSpec = { foot: [1.7, 2.3], head: [-0.5, 17.2], bend: 1.6, chord: leaf(5.2), nu: 4, nt: 8 };
  sail(buf, main);
  mast(buf, main, 1.1, 0.11);
  const top = luffOf(main, 0.74);
  sail(buf, { foot: [5.4, 1.25], head: top, chord: jib(3.3), camber: 0.08, nu: 3, nt: 5 });
  tube(buf, [[1.7, 1.1, 0], [5.4, 1.2, 0]], [0.07, 0.05], 3, SPAR);
  crew(buf, 23, 4, (i, rnd) => (i < 2 ? [-3.1 + rnd() * 0.5, 1.04, i === 0 ? -1.5 : 1.3, true] : [0.4 + rnd() * 0.8, 1.04, i === 2 ? 1.7 : -1.6, false]));
  lamp(buf, [main.head[0], main.head[1] + 0.3, 0], 0.3, RIDING);
  lamp(buf, [-5.6, 1.5, -2.9], 0.24, LANTERN);
  lamp(buf, [-5.6, 1.5, 2.9], 0.24, LANTERN);
}

/** The sloop: one hull, a low house, a tall leaf and a headsail. */
function sloop(buf: FleetBuf): void {
  const h = hull(buf, { L: 15.6, B: 4.1, F: 1.25, draft: 1.1, sheerBow: 0.5, sheerStern: 0.18, rakeBow: 1.5, rakeStern: 1.0, n: 10 });
  house(buf, 1.3, h.deckAt(1.3) - 0.08, 0, 3.5, 1.35, 0.85);
  const main: SailSpec = { foot: [2.0, 2.75], head: [-1.2, 23.5], bend: 1.6, chord: leaf(6.6), nu: 4, nt: 9 };
  sail(buf, main);
  mast(buf, main, h.deckAt(2.0), 0.14);
  sail(buf, { foot: [8.0, h.deckAt(8.0) + 0.25], head: luffOf(main, 0.8), chord: jib(4.9), camber: 0.08, nu: 3, nt: 6 });
  crew(buf, 37, 5, (i, rnd) => (i < 4 ? [-3.2 - i * 0.75, h.deckAt(-4) - 0.35, (i % 2 ? 1 : -1) * (0.75 + 0.3 * rnd()), i > 0] : [5.2, h.deckAt(5.2), 0.5, false]));
  lamp(buf, [main.head[0], main.head[1] + 0.35, 0], 0.32, RIDING);
  lamp(buf, [-7.9, h.deckAt(-7.9) + 0.9, 0], 0.26, LANTERN);
  lamp(buf, [6.2, h.deckAt(6.2) + 0.25, -h.halfAt(6.2)], 0.17, PORT);
  lamp(buf, [6.2, h.deckAt(6.2) + 0.25, h.halfAt(6.2)], 0.17, STARBOARD);
}

/** The ketch: two masts, the taller ahead, a long house, lanterns from stem to stern over the mastheads. */
function ketch(buf: FleetBuf): void {
  const h = hull(buf, { L: 33, B: 7.3, F: 2.3, draft: 1.6, sheerBow: 0.55, sheerStern: 0.25, rakeBow: 3.3, rakeStern: 2.1, n: 12 });
  house(buf, 0.2, h.deckAt(0.2) - 0.1, 0, 6.6, 2.35, 1.6, 12);
  house(buf, -10.9, h.deckAt(-10.9) - 0.1, 0, 2.3, 1.7, 1.25, 8);
  const main: SailSpec = { foot: [6.4, 5.0], head: [1.6, 40.5], bend: 1.6, chord: leaf(12), nu: 5, nt: 9 };
  const mizzen: SailSpec = { foot: [-8.2, 4.6], head: [-11.6, 30], bend: 1.6, chord: leaf(8.4), nu: 4, nt: 8 };
  for (const s of [main, mizzen]) {
    sail(buf, s);
    mast(buf, s, h.deckAt(s.foot[0]), 0.26);
  }
  const bow: V3 = [18.6, h.deckAt(16.5) + 0.5, 0];
  sail(buf, { foot: [bow[0] - 0.6, bow[1]], head: luffOf(main, 0.82), chord: jib(9), camber: 0.08, nu: 4, nt: 6 });
  crew(buf, 53, 11, (i, rnd) => {
    // along the rails amidships and aft, and two at the bow
    if (i >= 9) return [12.5 + (i - 9) * 1.4, h.deckAt(13), i === 9 ? -0.8 : 0.9, false];
    const x = -15 + rnd() * 9 + (i % 3) * 6.5;
    return [x, h.deckAt(x) - 0.05, (i % 2 ? 1 : -1) * (h.halfAt(x) - 0.55), rnd() < 0.3];
  });
  const stern: V3 = [-17.6, h.deckAt(-16) + 1.2, 0];
  const mh: V3 = [main.head[0], main.head[1] + 0.4, 0];
  const zh: V3 = [mizzen.head[0], mizzen.head[1] + 0.4, 0];
  lanterns(buf, bow, mh, 8, 1.5, 0.27);
  lanterns(buf, mh, zh, 5, 3.2, 0.27);
  lanterns(buf, zh, stern, 6, 1.2, 0.27);
  lamp(buf, mh, 0.38, RIDING);
  lamp(buf, zh, 0.34, RIDING);
  lamp(buf, stern, 0.3, LANTERN);
  lamp(buf, [12, h.deckAt(12) + 0.3, -h.halfAt(12)], 0.2, PORT);
  lamp(buf, [12, h.deckAt(12) + 0.3, h.halfAt(12)], 0.2, STARBOARD);
}

/** The ship: three masts, three great leaves and two headsails, a gallery and a great cabin, forty people at her rails. */
function tall(buf: FleetBuf): void {
  const h = hull(buf, { L: 84, B: 13.6, F: 4.8, draft: 3.6, sheerBow: 0.6, sheerStern: 0.32, rakeBow: 8, rakeStern: 4.6, n: 18 });
  house(buf, 9.5, h.deckAt(9.5) - 0.2, 0, 13.5, 3.9, 2.7, 14);
  house(buf, -16.5, h.deckAt(-16.5) - 0.2, 0, 8.5, 4.2, 3.3, 12);
  const fore: SailSpec = { foot: [23.5, 11], head: [16.5, 76], bend: 1.6, chord: leaf(21.5), nu: 5, nt: 10 };
  const main: SailSpec = { foot: [-1.5, 11.5], head: [-9.5, 84], bend: 1.6, chord: leaf(22.5), nu: 5, nt: 10 };
  const mizzen: SailSpec = { foot: [-27, 11], head: [-33.5, 68], bend: 1.6, chord: leaf(17.5), nu: 5, nt: 10 };
  for (const s of [fore, main, mizzen]) {
    sail(buf, s);
    mast(buf, s, h.deckAt(s.foot[0]), 0.55, 6);
  }
  const bow: V3 = [48.5, h.deckAt(42) + 0.6, 0];
  sail(buf, { foot: [bow[0] - 1, bow[1]], head: luffOf(fore, 0.86), chord: jib(17.5), camber: 0.08, nu: 4, nt: 7 });
  sail(buf, { foot: [37.5, h.deckAt(37.5) + 0.8], head: luffOf(fore, 0.6), chord: jib(11.5), camber: 0.08, nu: 4, nt: 6 });
  crew(buf, 71, 40, (i, rnd) => {
    if (i >= 34) return [30 + (i - 34) * 2.2 + rnd(), h.deckAt(32), (rnd() - 0.5) * 4, false];
    const x = -36 + (i % 17) * 3.6 + rnd() * 2;
    return [x, h.deckAt(x) - 0.08, (i < 17 ? 1 : -1) * (h.halfAt(x) - 0.7), rnd() < 0.15];
  });
  const stern: V3 = [-45, h.deckAt(-40) + 2.2, 0];
  const heads = [fore, main, mizzen].map((s): V3 => [s.head[0], s.head[1] + 0.8, 0]);
  lanterns(buf, bow, heads[0], 14, 3, 0.36);
  lanterns(buf, heads[0], heads[1], 6, 5, 0.36);
  lanterns(buf, heads[1], heads[2], 6, 5, 0.36);
  lanterns(buf, heads[2], stern, 12, 2.5, 0.36);
  for (const p of heads) lamp(buf, p, 0.55, RIDING);
  lamp(buf, stern, 0.45, LANTERN);
  for (const x of [26, -4, -30]) {
    lamp(buf, [x, h.deckAt(x) + 0.4, -h.halfAt(x)], 0.3, PORT);
    lamp(buf, [x, h.deckAt(x) + 0.4, h.halfAt(x)], 0.3, STARBOARD);
  }
}

export const BOAT_KINDS: BoatKind[] = ['proa', 'cat', 'sloop', 'ketch', 'tall'];

export const BOATS: Record<BoatKind, BoatClass> = {
  proa: { kind: 'proa', length: 7.4, beam: 3.4, draft: 0.25, height: 7.8, roll: 0.045, heel: 0.1, bright: 0.85, build: proa },
  cat: { kind: 'cat', length: 11.8, beam: 7.1, draft: 0.4, height: 17.5, roll: 0.022, heel: 0.05, bright: 0.72, build: cat },
  sloop: { kind: 'sloop', length: 15.6, beam: 4.1, draft: 1.1, height: 24, roll: 0.03, heel: 0.17, bright: 0.45, build: sloop },
  ketch: { kind: 'ketch', length: 33, beam: 7.3, draft: 1.6, height: 41, roll: 0.016, heel: 0.12, bright: 0.3, build: ketch },
  tall: { kind: 'tall', length: 84, beam: 13.6, draft: 3.6, height: 85, roll: 0.007, heel: 0.07, bright: 0.15, build: tall },
};

/** One boat of a kind, as a buffer (the scene builds its geometry from it; the test counts its triangles). */
export function boatBuffer(kind: BoatKind): FleetBuf {
  const buf = new FleetBuf();
  BOATS[kind].build(buf);
  return buf;
}
