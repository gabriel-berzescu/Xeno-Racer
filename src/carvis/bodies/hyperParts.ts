/**
 * The Taccola's parts (bodies/hyper.ts sculpts the body they stand on): the splitter, the diffuser's strakes, the four tailpipes in the
 * fascia, the mirrors, and the active wing on its two arms, which is one moving part.
 */
import type { CarVisualSpec } from '../../core/contracts';
import { PART, type MovingPart } from '../blueprint';
import { airfoilPoly } from '../aero';
import { addDoorMirrors } from '../mirrorParts';
import type { PartBuilder } from '../parts';
import { curve, type Curve } from '../curve';
import { roundPoly } from '../shapes';

type V3 = [number, number, number];

/** The lengths the body and its parts share (body frame: the origin on the ground at the middle of the wheelbase, +z forward). */
export function hyperFrame(s: CarVisualSpec): { zF: number; zR: number; zNose: number; zTail: number; hw: number; hk: number } {
  const zF = s.wheelbase / 2;
  return { zF, zR: -zF, zNose: zF + s.frontOverhang, zTail: -(zF + (s.length - s.wheelbase - s.frontOverhang)), hw: s.width / 2, hk: s.height / 1.17 };
}

/**
 * Where the Taccola carries what other modules look for (body frame, +x the left):
 *   - sideIntakeZ: the wall the flank's facet ends in, with the side intake's mouth in it;
 *   - exhausts: the mouths of the four tailpipes, a cluster in the middle of the fascia (src/render/effects.ts blows the flames there);
 *   - headlamp: where the left lamp's beam starts.
 */
export function hyperPoints(s: CarVisualSpec): { sideIntakeZ: number; exhausts: V3[]; headlamp: V3 } {
  const { zNose, zTail } = hyperFrame(s);
  return {
    sideIntakeZ: -0.62,
    exhausts: [-0.225, -0.075, 0.075, 0.225].map((x) => [x, 0.52, zTail + 0.01] as V3),
    headlamp: [0.74, 0.5, zNose - 0.16],
  };
}

/**
 * The car's half width along its length: the low body's wall (bodies/hyper.ts), upright from 30 to 60 cm off the ground, which is the
 * flank from one wheel to the other and what the scallop is cut into.
 */
export function hyperFlank(s: CarVisualSpec): Curve {
  const { zF, zR, zNose, zTail } = hyperFrame(s);
  return curve([zTail, 0.86, zTail + 0.12, 0.935, zTail + 0.4, 0.985, zR, 1.0, zR + 0.5, 0.99, -0.5, 0.945, 0.2, 0.93, 0.8, 0.95, zF, 0.985, zF + 0.4, 0.975, zNose - 0.35, 0.965, zNose - 0.15, 0.9, zNose - 0.05, 0.83, zNose, 0.72], 0.04);
}

/**
 * The scallop down each flank (ax = |x|; negative inside the cut). Under a lip that climbs a little to the rear the flank is undercut:
 * an upper face runs in under the lip, dropping 3 cm in 10, to a line 5 cm inside the flank behind the front wheel's arch (it opens
 * out of the arch: the air from the wheel well runs down it) and 18 cm inside where it ends. From that line a lower face curves out
 * and down, meeting the flank again 20 cm below as a tangent (the flank's own curve, hyperFlank, so it leaves no edge wherever the
 * flank is): a crisp shoulder over a soft hollow. It ends in a wall that leans forward
 * at the top, a brow over the intake's mouth; the mesh in that wall is a part (addHyperParts).
 *
 * Its sizes are the mesher's: nothing in it is thinner than two cells, its two edges (the lip, 73 degrees, and the line at the bottom
 * of the undercut) are hard, and the lower face's curve is never tighter than 13 cm, so it leaves the flank without an edge.
 */
export function hyperGroove(s: CarVisualSpec): { cut(ax: number, y: number, z: number): number; wallZ(y: number): number; upperX(y: number, z: number): number; lowerX(y: number, z: number): number; sideAt(z: number): number } {
  const P = hyperPoints(s);
  const { zF } = hyperFrame(s);
  const flank = hyperFlank(s);
  const sideAt = (z: number): number => flank.at(z);
  const lipY = (z: number): number => 0.52 - 0.04 * z;
  const depth = (z: number): number => 0.05 + 0.08 * (1.02 - z);
  const wallZ = (y: number): number => P.sideIntakeZ + 0.5 * (y - 0.45);
  /** how far below the bottom of the undercut the lower face is back at the flank */
  const fall = 0.2;
  // where each face is at a height and a station: the cut is outboard of both. (Below where it meets the flank the lower face
  // curves on outwards, clear of the body: the cut ends there with no edge.)
  const upperX = (y: number, z: number): number => sideAt(z) + (y - lipY(z)) / 0.3;
  const lowerX = (y: number, z: number): number => {
    const D = depth(z);
    const t = (lipY(z) - 0.3 * D - y) / fall;
    if (t >= 1) return sideAt(z) + 0.5 * (t - 1) * (t - 1);
    return sideAt(z) - D * (t > 0 ? (1 - t) * (1 - t) : 1 - 2 * t);
  };
  const lowerSlope = (y: number, z: number): number => {
    const t = (lipY(z) - 0.3 * depth(z) - y) / fall;
    return t >= 1 ? (t - 1) / fall : (2 * depth(z) * (t > 0 ? 1 - t : 1)) / fall;
  };
  return {
    cut: (ax, y, z) => {
      const k = lowerSlope(y, z);
      // (it starts inside the front wheel's arch, 20 cm behind the axle, and ends in its wall)
      return Math.max((upperX(y, z) - ax) * (0.3 / 1.045), (lowerX(y, z) - ax) / Math.sqrt(1 + k * k), (wallZ(y) - z) / 1.118, z - (zF - 0.2));
    },
    wallZ,
    upperX,
    lowerX,
    sideAt,
  };
}

/**
 * The active wing (body frame, +x the left): one blade on two arms that turn about a hinge in the deck. In corner mode (at rest) the
 * arms stand up and the blade is pitched, its trailing edge high; in straight mode the arms lie down and the blade comes down flat
 * over the tail.
 */
export function hyperWing(s: CarVisualSpec): { pivot: V3; at: V3; halfSpan: number; chord: number; pitch: number; swing: number; armX: number } {
  const { zTail } = hyperFrame(s);
  return {
    // the hinge, in the floor of the deck's valleys
    pivot: [0, 0.7, zTail + 0.66],
    // the blade's quarter chord in corner mode
    at: [0, 0.95, zTail + 0.2],
    halfSpan: 0.86,
    chord: 0.32,
    // corner mode: the trailing edge up by this (rad)
    pitch: 0.3,
    // what the arms turn through into straight mode (rad about +x: negative brings the blade down and flat)
    swing: -0.3,
    armX: 0.4,
  };
}

/** The blade and its arms as they stand in corner mode. */
function addWing(b: PartBuilder, s: CarVisualSpec): void {
  const w = hyperWing(s);
  // the blade: an inverted aerofoil (the camber below), its trailing edge lifted
  b.setPart(PART.carbon);
  b.extrude(airfoilPoly(w.chord, 0.085, -0.09, -w.pitch, 18), { o: [w.halfSpan, w.at[1], w.at[2]], u: [0, 0, 1], v: [0, 1, 0] }, w.halfSpan * 2, 0.003, 2);
  // small end plates in the body's paint
  b.setPart(PART.body);
  for (const sg of [-1, 1]) {
    const plate = roundPoly([0.1, -0.035, 0.09, 0.01, -0.17, 0.085, -0.24, 0.08, -0.24, 0.0, -0.05, -0.05], 0.012);
    b.extrude(plate, { o: [sg * w.halfSpan + (sg > 0 ? 0.01 : 0), w.at[1], w.at[2]], u: [0, 0, 1], v: [0, 1, 0] }, 0.01, 0.002, 1);
  }
  // the arms: from the hinge up under the blade
  b.setPart(PART.carbon);
  for (const sg of [-1, 1]) {
    const dz = w.at[2] - w.pivot[2];
    const dy = w.at[1] - w.pivot[1];
    const arm = roundPoly([0.05, -0.02, 0.06, 0.03, dz + 0.1, dy - 0.02, dz - 0.04, dy - 0.03, dz - 0.06, dy - 0.07, -0.04, -0.03], 0.012);
    b.extrude(arm, { o: [sg * w.armX + 0.012, w.pivot[1], w.pivot[2]], u: [0, 0, 1], v: [0, 1, 0] }, 0.024, 0.004, 1);
  }
}

export function hyperMoving(s: CarVisualSpec): MovingPart[] {
  const w = hyperWing(s);
  return [{ name: 'wing', drive: 'aero', pivot: w.pivot, axis: [1, 0, 0], angle: w.swing, build: (b) => addWing(b, s) }];
}

export function addHyperParts(b: PartBuilder, s: CarVisualSpec): void {
  const { zNose, zTail } = hyperFrame(s);
  const P = hyperPoints(s);
  // front splitter: a carbon blade under the nose, a hand's width ahead of it
  {
    const poly = roundPoly([0.0, zNose + 0.045, 0.6, zNose + 0.03, 0.87, zNose - 0.05, 0.99, zNose - 0.3, 0.99, zNose - 0.72, -0.99, zNose - 0.72, -0.99, zNose - 0.3, -0.87, zNose - 0.05, -0.6, zNose + 0.03], 0.04);
    b.setPart(PART.carbon);
    b.extrude(poly, { o: [0, 0.1, 0], u: [1, 0, 0], v: [0, 0, 1] }, 0.014, 0.004, 2);
  }
  // the diffuser's strakes: fins in the tunnel, tall at the tail and running out along its roof
  b.setPart(PART.carbon);
  for (const x of [-0.46, -0.2, 0.2, 0.46]) {
    const fin = [zTail + 0.02, 0.105, zTail + 0.02, 0.32, zTail + 0.62, 0.11, zTail + 0.62, 0.105];
    b.extrude(fin, { o: [x + 0.005, 0, 0], u: [0, 0, 1], v: [0, 1, 0] }, 0.01, 0.0015, 1);
  }
  // four tailpipes, a cluster in the middle of the fascia
  for (const e of P.exhausts) {
    b.setPart(PART.titanium);
    b.cylinder([e[0], e[1], e[2] + 0.12], [e[0], e[1], e[2]], 0.05, 0.053, 24, false);
    b.setPart(PART.plastic);
    b.cylinder([e[0], e[1], e[2] + 0.07], [e[0], e[1], e[2] + 0.06], 0.047, 0.047, 24, true);
  }
  // the side intakes' mesh: a panel in the wall each groove ends in, cut to the V of the groove
  {
    const g = hyperGroove(s);
    const out = g.sideAt(g.wallZ(0.45)) - 0.012;
    const inner = (y: number): number => Math.max(g.upperX(y, g.wallZ(y)), g.lowerX(y, g.wallZ(y)));
    // the heights where the two faces reach the flank
    const solve = (f: (y: number) => number, lo: number, hi: number): number => {
      for (let i = 0; i < 40; i++) {
        const m = (lo + hi) / 2;
        if (f(lo) < 0 === f(m) < 0) lo = m;
        else hi = m;
      }
      return (lo + hi) / 2;
    };
    const yTop = solve((y) => g.upperX(y, g.wallZ(y)) - out, 0.45, 0.75);
    const yBot = solve((y) => g.lowerX(y, g.wallZ(y)) - out, 0.05, 0.45);
    const up = 1 / 1.118, fwd = 0.5 / 1.118;
    for (const sg of [1, -1]) {
      const poly: number[] = [];
      const n = 14;
      for (let i = 0; i <= n; i++) {
        const y = yBot + ((yTop - yBot) * i) / n;
        poly.push(sg * (inner(y) - 0.006), (y - 0.45) / up);
      }
      poly.push(sg * out, (yTop - 0.45) / up, sg * out, (yBot - 0.45) / up);
      b.setPart(PART.body);
      b.setZone(3, -1);
      // (the wall's own normal looks forward and down: the panel stands 8 mm ahead of it)
      b.extrude(poly, { o: [0, 0.45 - 0.008 * fwd, g.wallZ(0.45) + 0.008 * up], u: [1, 0, 0], v: [0, up, fwd] }, 0.002, 0, 1);
      b.clearZones();
    }
  }
  addDoorMirrors(b, s);
}

/** What a far Taccola keeps: the wing as a slab on its arms (it makes its outline and its shadow). */
export function addHyperFarParts(b: PartBuilder, s: CarVisualSpec): void {
  const w = hyperWing(s);
  b.setPart(PART.carbon);
  b.box([0, w.at[1], w.at[2] - 0.08], w.halfSpan, 0.02, w.chord * 0.5);
  for (const sg of [-1, 1]) b.box([sg * w.armX, (w.at[1] + w.pivot[1]) * 0.5, (w.at[2] + w.pivot[2]) * 0.5], 0.012, (w.at[1] - w.pivot[1]) * 0.5, 0.05);
}
