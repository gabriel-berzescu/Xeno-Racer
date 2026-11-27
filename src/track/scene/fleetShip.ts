/**
 * The great ship in the sky of an island circuit (`FleetDef.ship`): the ship that brought the cars. Six thousand years is a long
 * time to keep anything, and what kept the cars was a seed: a hull two kilometres long, pointed at the stern and round at the bow,
 * thin as a leaf, with one edge all the way round it and its ends lifted a little, the way the ends of a canoe are. The boats on the
 * water under it are its own shape made small (fleetBoats.ts).
 *
 * And it is a sailing ship, as they are. Nothing crosses six thousand years in a hurry: what crosses them is light on a sail. On its
 * back stand three leaves, the tallest a membrane half a kilometre high, what is left set of the sails that brought it; the sun
 * comes through them as it comes through the sails on the lagoon, and from the beach it is a three-master hull up in the sky, the
 * mirage of the ships at anchor under it (`GreatShipDef.masts`: 0 takes them away).
 *
 * It is seen from below and from the side, three or four kilometres off, so what there is to see is its belly: pale, in three
 * shades between its lines; a line of the lift light along the keel, which shows by day (it is what holds the ship up) and is warm
 * where the hold is; and after dark a line of light all round the edge and two rows of ports. A few of its tenders hang under it and
 * beside it, which is how the eye learns how large it is.
 *
 * One mesh in the fleet's lit material (fleetKit.ts): the scene's sun on it and the scene's haze in front of it, at every hour.
 */
import type { GreatShipDef } from '../types';
import { FleetBuf, KIND, type SurfaceFn, type V3, lamp, lin, patch, scaled, solid, span } from './fleetKit';
import { compass, yawOf } from './fleetPlan';

const PEARL = lin(0xe9e5dc);
const PORTS = lin(0x9db0bd);
const LIFT = lin(0xd2e7ff);
const HOLD = lin(0xffc88a);
const SEAM = lin(0xc9dfe2);
const WHITE_LAMP = lin(0xfff3de);
const RED_LAMP = lin(0xff3a28);
const GREEN_LAMP = lin(0x38ff8c);

const ease = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** The plan of a seed: nothing at the stern (0), fullest five eighths of the way forward, round at the bow (1). */
const FULLEST = 1.25 / (1.25 + 0.72);
const LEAF_MAX = Math.pow(FULLEST, 1.25) * Math.pow(1 - FULLEST, 0.72);
function leaf(s: number): number {
  return (Math.pow(Math.max(0, s), 1.25) * Math.pow(Math.max(0, 1 - s), 0.72)) / LEAF_MAX;
}

/** Half the beam, the height of the back over the edge and the depth of the belly under it, as shares of the length. */
const HALF_BEAM = 0.105;
const BACK = 0.034;
const BELLY = 0.024;

interface Body {
  lower: SurfaceFn;
  upper: SurfaceFn;
}

/** A hull of length L about the origin of its own frame (the bow at +x, starboard +z, the lowest of its belly near y = 0). */
function body(L: number): Body {
  // the edge's own line: the stern lifts a good deal, the bow a little
  const sheer = (s: number): number => L * (0.058 * Math.max(0, (0.55 - s) / 0.55) ** 2 + 0.016 * Math.max(0, (s - 0.55) / 0.45) ** 2 + BELLY);
  const thick = (s: number): number => Math.pow(leaf(s), 0.75);
  return {
    lower: (s, v, o) => {
      o[0] = L * (s - 0.5);
      o[1] = sheer(s) - L * BELLY * thick(s) * (1 - Math.abs(v) ** 2);
      o[2] = L * HALF_BEAM * leaf(s) * v;
    },
    upper: (s, v, o) => {
      o[0] = L * (s - 0.5);
      o[1] = sheer(s) + L * BACK * thick(s) * (1 - Math.abs(v) ** 2.4);
      o[2] = L * HALF_BEAM * leaf(s) * v;
    },
  };
}

/** Across the belly from the keel (0) to the edge (1): the lines are where one band ends and the next begins. */
const KEEL = 0.03;
const SEAM_IN = 0.36;
const SEAM_OUT = 0.385;
const PORTS_IN = 0.7;
const PORTS_OUT = 0.735;
const EDGE = 0.955;
const BELLY_ROWS = [0, KEEL, 0.12, 0.24, SEAM_IN, SEAM_OUT, 0.5, 0.6, PORTS_IN, PORTS_OUT, 0.82, 0.9, EDGE, 1];

function mirrored(half: number[]): number[] {
  return [...half.slice(1).reverse().map((v) => -v), ...half];
}

/** Where her masts stand (0 the stern .. 1 the bow), and the height and the chord of the leaf on each, as shares of her length. */
const MASTS: [number, number, number][] = [
  [0.77, 0.17, 0.056],
  [0.56, 0.235, 0.068],
  [0.36, 0.15, 0.05],
];

/**
 * A leaf: a membrane standing on her back in the plane of her keel, its luff bending aft toward the head as the masts of the boats
 * do, drawn from both sides (the ship's material shows the outside of things only, and a membrane is all outside).
 */
function emitLeaf(buf: FleetBuf, foot: [number, number], height: number, chord: number, L: number): void {
  const luff = (t: number): number => foot[0] - height * 0.27 * Math.pow(t, 1.7);
  // nearly its full chord at the foot, fullest a third of the way up, round to a point
  const wide = (t: number): number => chord * (t < 0.3 ? 0.8 + 0.2 * Math.sin(((t / 0.3) * Math.PI) / 2) : 0.02 + 0.98 * Math.pow(Math.max(0, 1 - ((t - 0.3) / 0.7) ** 2), 0.62));
  const f: SurfaceFn = (u, t, o) => {
    o[0] = luff(t) - u * wide(t);
    o[1] = foot[1] + height * t;
    o[2] = 0.07 * wide(t) * 4 * u * (1 - u) * (0.62 + 0.38 * Math.sin(Math.PI * t));
  };
  // (a batten every 0.6 % of her length: a vein of the leaf every dozen metres)
  const paint = (u: number, t: number): { c: [number, number, number]; rig: [number, number, number, number] } => ({ c: [u, t, (height * t) / (L * 0.006) / 32], rig: [KIND.sail, 0, 0, 0] });
  patch(buf, span(6), span(16), f, paint, { flip: true });
  patch(buf, span(6), span(16), f, paint);
}

/** The ship in its own frame. */
function emitShip(buf: FleetBuf, L: number, masts: number): void {
  const b = body(L);
  const NS = 120;
  const us = span(NS);
  patch(
    buf,
    us,
    mirrored(BELLY_ROWS),
    b.lower,
    (s, v) => {
      const a = Math.abs(v);
      const cell = Math.floor(s * NS);
      if (a < KEEL) {
        // the lift light: it fades toward the ends, and is warm under the hold
        const k = ease((s - 0.05) / 0.12) * ease((0.975 - s) / 0.07);
        const hold = s > 0.5 && s < 0.6;
        return { c: hold ? HOLD : LIFT, rig: [KIND.lift, (hold ? 1.25 : 0.8) * k, 0, 0] };
      }
      if (a > EDGE) return { c: PEARL, rig: solid(1.5, false, 0.4) };
      // the ports: runs of them of uneven length, as decks have rooms
      if (a > PORTS_IN && a < PORTS_OUT && s > 0.1 && s < 0.94) return cell % 9 === 4 || cell % 5 === 0 ? { c: PEARL } : { c: PORTS, rig: solid(-1.1, false, 0.2) };
      if (a > SEAM_IN && a < SEAM_OUT && s > 0.16 && s < 0.9) return { c: SEAM, rig: solid(0.55, false, 0.3) };
      // three shades between the lines, and a faint rib every eighth of a kilometre
      const shade = (a < SEAM_IN ? 0.9 : a < PORTS_IN ? 0.97 : 1.03) * (cell % 8 === 0 ? 0.955 : 1);
      return { c: scaled(PEARL, shade) };
    },
    { cells: true },
  );
  patch(buf, span(60), mirrored([0, 0.35, 0.65, 0.88, 1]), b.upper, () => ({ c: scaled(PEARL, 1.05) }), { flip: true });
  const p: V3 = [0, 0, 0];
  // her sails: leaves on her back like the leaves of the ships under her, the tallest amidships (see the head of the file)
  for (let i = 0; i < masts; i++) {
    const [s, h, c] = masts === 1 ? MASTS[1] : MASTS[Math.min(MASTS.length - 1, Math.round((i * (MASTS.length - 1)) / (masts - 1)))];
    b.upper(s, 0, p);
    emitLeaf(buf, [p[0], p[1] + L * 0.008], L * h, L * c, L);
  }
  // her lights: white at the ends, red and green at the beam
  b.lower(1, 0, p);
  lamp(buf, [p[0], p[1], p[2]], 3.2, WHITE_LAMP);
  b.lower(0, 0, p);
  lamp(buf, [p[0], p[1], p[2]], 3.2, WHITE_LAMP);
  b.lower(FULLEST, -1, p);
  lamp(buf, [p[0], p[1], p[2]], 2.6, RED_LAMP);
  b.lower(FULLEST, 1, p);
  lamp(buf, [p[0], p[1], p[2]], 2.6, GREEN_LAMP);
}

/** A tender: the same seed, a twentieth of the size, with its own line of lift light. */
function emitTender(buf: FleetBuf, L: number, at: V3, turn: number): void {
  const b = body(L);
  const c = Math.cos(turn);
  const sn = Math.sin(turn);
  const place = (f: SurfaceFn): SurfaceFn => (s, v, o) => {
    f(s, v, o);
    const x = o[0];
    o[0] = at[0] + x * c + o[2] * sn;
    o[1] += at[1];
    o[2] = at[2] - x * sn + o[2] * c;
  };
  patch(
    buf,
    span(18),
    mirrored([0, 0.1, 0.55, 0.9, 1]),
    place(b.lower),
    (s, v) => {
      const a = Math.abs(v);
      if (a < 0.1) return { c: LIFT, rig: [KIND.lift, 0.8 * ease((s - 0.08) / 0.15) * ease((0.96 - s) / 0.1), 0, 0] };
      return a > 0.9 ? { c: PEARL, rig: solid(1.5, false, 0.4) } : { c: scaled(PEARL, 0.96) };
    },
    { cells: true },
  );
  patch(buf, span(18), mirrored([0, 0.6, 1]), place(b.upper), () => ({ c: scaled(PEARL, 1.05) }), { flip: true });
}

/** Where the tenders hang, in the ship's frame as shares of its length (forward, up, to starboard), their length and their turn. */
const TENDERS: [number, number, number, number, number][] = [
  [0.07, -0.085, 0.2, 0.07, 0.25],
  [-0.27, -0.04, -0.17, 0.052, -0.1],
  [0.33, -0.12, -0.06, 0.045, 0.5],
  [0.04, -0.14, 0.02, 0.034, -0.4],
  [-0.12, -0.2, 0.3, 0.03, 0.9],
];

/** The great ship and its tenders, in the world. */
export function greatShipBuffer(def: GreatShipDef): FleetBuf {
  const buf = new FleetBuf();
  const L = def.length;
  emitShip(buf, L, Math.max(0, Math.round(def.masts ?? 3)));
  for (const t of TENDERS) emitTender(buf, L * t[3], [L * t[0], L * t[1], L * t[2]], t[4]);
  // from its own frame to the world: turned to its heading, its keel at its altitude
  const [dx, dz] = compass(def.heading);
  const yaw = yawOf(dx, dz);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  for (let i = 0; i < buf.pos.length; i += 3) {
    const x = buf.pos[i];
    const z = buf.pos[i + 2];
    buf.pos[i] = def.x + x * c + z * s;
    buf.pos[i + 1] += def.altitude;
    buf.pos[i + 2] = def.z - x * s + z * c;
    const nx = buf.nor[i];
    const nz = buf.nor[i + 2];
    buf.nor[i] = nx * c + nz * s;
    buf.nor[i + 2] = -nx * s + nz * c;
  }
  return buf;
}
