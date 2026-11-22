/**
 * Taccola — a mid-engined road hypercar. A beak of a nose between two fender pontoons, with an open channel each side of it that climbs
 * to the cowl; a teardrop canopy; a spine from the roof scoop to the tail (the jackdaw's nape) with a valley each side of it; a flank
 * cut under the shoulder by a facet that deepens into the intake ahead of the rear wheel; a full-width tail lamp over a meshed fascia
 * and a diffuser tunnel; and a wing on two arms that lies down on the straights (hyperParts.ts).
 */
import type { BlueprintFactory } from '../blueprint';
import { curve } from '../curve';
import { defaultLoft, sdFootprint, sdLoft } from '../loft';
import { dent, roundPoly, strip2 } from '../shapes';
import { sdCylinderX, sdEllipseRot2, sdPolygon2, sdRoundBox, sdRoundCone, sdRoundRect2, smax, smin, ssub } from '../sdf';
import { addHyperFarParts, addHyperParts, hyperFlank, hyperFrame, hyperGroove, hyperMoving } from './hyperParts';
import { frontZ } from './probe';

export const makeHyper: BlueprintFactory = (s) => {
  const { zF, zR, zNose, zTail, hw, hk } = hyperFrame(s);
  const rF = s.wheelRadiusFront, rR = s.wheelRadiusRear;
  const zero = curve([zTail - 1, 0, zNose + 1, 0]);
  const flat = (v: number): ReturnType<typeof curve> => curve([zTail - 1, v, zNose + 1, v]);

  // ── massing ───────────────────────────────────────────────────────────────
  // the low body: the whole plan of the car. Its top is the floor of the channels beside the beak (a bib 20 cm up at the nose, climbing
  // to the cowl), the shoulder along the doors, and the floor of the valleys beside the spine
  const low = defaultLoft(
    {
      yb: curve([zTail, 0.12, zTail + 0.6, 0.105, zR + 0.5, 0.095, zNose - 0.5, 0.095, zNose - 0.15, 0.1, zNose, 0.13], 0.04),
      yt: curve([zTail, 0.69, zTail + 0.3, 0.705, zR, 0.715, -0.8, 0.7, 0.0, 0.685, 0.9, 0.675, 1.1, 0.645, 1.4, 0.5, 1.7, 0.35, 2.0, 0.25, 2.2, 0.215, zNose, 0.2], 0.05),
      w: hyperFlank(s),
      crown: flat(0.03),
      // (the wall stands upright from 30 to 60 cm, where the groove is cut in it: it leans in above that and tucks under below)
      tum: flat(0.04),
      bar: flat(0.05),
      yw: 0.3,
      tumY: 0.6,
      rTop: 0.09,
      rBot: 0.08,
      rEnd: 0.08,
      zf: zNose,
      zr: zTail,
      kf: 0.3,
      kr: 0.1,
      yRef: 0.15,
    },
    zero,
  );

  // the fuselage: the beak of the nose, the cowl under the windscreen, and behind the cabin the spine that runs to the tail
  const fus = defaultLoft(
    {
      yb: flat(0.15),
      yt: curve([zTail, 0.76, zTail + 0.3, 0.805, -1.7, 0.875, -1.2, 0.95, -0.8, 1.0, 0.0, 0.9, 1.0, 0.705, 1.4, 0.645, 1.8, 0.57, 2.1, 0.495, zNose - 0.05, 0.4], 0.05),
      w: curve([zTail, 0.2, zTail + 0.4, 0.24, -1.5, 0.3, -1.0, 0.38, -0.5, 0.5, 0.4, 0.6, 1.0, 0.5, 1.3, 0.36, 1.6, 0.29, 1.9, 0.24, 2.2, 0.19, zNose, 0.11], 0.05),
      crown: flat(0.03),
      tum: flat(0.1),
      tumY: 0.3,
      rTop: 0.09,
      rBot: 0.04,
      rEnd: 0.09,
      zf: zNose,
      zr: zTail,
      kf: 0.55,
      kr: 0.12,
      yRef: 0.2,
    },
    zero,
  );

  // the canopy: a teardrop of glass, its windscreen raked 27 degrees from the road
  const canopy = defaultLoft(
    {
      yb: flat(0.6),
      yt: curve([-1.3, 0.93 * hk, -0.9, 1.02 * hk, -0.5, 1.09 * hk, -0.1, 1.12 * hk, 0.2, 1.12 * hk, 0.5, 1.1 * hk, 1.2, 1.06 * hk], 0.05),
      w: curve([-1.3, 0.36, -0.9, 0.48, -0.4, 0.6, 0.1, 0.66, 0.5, 0.66, 0.9, 0.62, 1.2, 0.58], 0.05),
      crown: flat(0.07),
      tum: flat(0.22),
      tumY: 0.66,
      rTop: 0.22,
      rBot: 0.1,
      rEnd: 0.14,
      zf: 1.18,
      zr: -1.3,
      kf: 1.95,
      kr: 0.6,
      yRef: 0.66,
    },
    zero,
  );

  // the fender pontoons, lofts about the wheels' lines: the front one peaks over the axle, the rear haunch behind it
  const podF = 0.79;
  const fenderF = defaultLoft(
    {
      // (behind its wheel only the shoulder runs on into the door: the pontoon's foot climbs out of the way of the door's tucked-in wall)
      yb: curve([zF - 0.82, 0.56, zF - 0.55, 0.36, zF - 0.4, 0.15, zNose, 0.15], 0.04),
      yt: curve([zF - 0.8, 0.655, zF - 0.45, 0.72, zF, 0.76, zF + 0.35, 0.705, zF + 0.7, 0.56, zF + 0.98, 0.37], 0.06),
      w: curve([zF - 0.8, 0.09, zF - 0.4, 0.2, zF, 0.23, zF + 0.4, 0.21, zF + 0.75, 0.16, zF + 0.98, 0.09], 0.05),
      crown: flat(0.05),
      tum: flat(0.03),
      tumY: 0.4,
      rTop: 0.12,
      rBot: 0.05,
      rEnd: 0.12,
      zf: zF + 0.98,
      zr: zF - 0.82,
      kf: 0.9,
      kr: 0.3,
      yRef: 0.2,
    },
    zero,
  );
  const podR = 0.79;
  const fenderR = defaultLoft(
    {
      yb: flat(0.15),
      yt: curve([zR + 0.9, 0.7, zR + 0.55, 0.79, zR + 0.1, 0.865, zR - 0.3, 0.86, zR - 0.65, 0.81, zTail, 0.755], 0.06),
      // (its flank stays just inside the low body's wall, which is the car's side from one wheel to the other: the pod is the height
      // over the wheel and no more)
      w: curve([zR + 0.9, 0.13, zR + 0.5, 0.185, zR, 0.2, zTail + 0.4, 0.185, zTail + 0.12, 0.135, zTail, 0.06], 0.05),
      crown: flat(0.05),
      tum: flat(0.03),
      tumY: 0.4,
      rTop: 0.13,
      rBot: 0.05,
      rEnd: 0.1,
      zf: zR + 0.86,
      zr: zTail,
      kf: 0,
      kr: 0.12,
      yRef: 0.45,
    },
    zero,
  );

  const archGap = 0.035;
  const archF = (ax: number, y: number, z: number): number => sdCylinderX(ax - 1.08, y - rF, z - zF, rF + archGap, 0.42, 0.02);
  const archR = (ax: number, y: number, z: number): number => sdCylinderX(ax - 1.05, y - rR, z - zR, rR + archGap, 0.42, 0.02);

  // the flank's groove (hyperParts.ts hyperGroove: its end wall carries the intake's mesh, a part)
  const groove = hyperGroove(s);

  const base = (ax: number, y: number, z: number): number => {
    let d = sdLoft(low, ax, y, z);
    d = smin(d, sdLoft(fus, ax, y, z), 0.09);
    d = smin(d, sdLoft(canopy, ax, y, z), 0.09);
    d = smin(d, sdLoft(fenderF, ax > podF ? ax - podF : podF - ax, y, z), 0.1);
    d = smin(d, sdLoft(fenderR, ax > podR ? ax - podR : podR - ax, y, z), 0.11);
    // the roof scoop, running back into the spine
    d = smin(d, sdRoundCone(ax, y, z, 0, 1.1 * hk, -0.3, 0.09, 0, 1.0 * hk, -1.05, 0.05), 0.07);
    // the plan of the car: its corners rounded
    d = smax(d, sdFootprint(ax, z, hw, zNose, zTail, 0.6, 0.3), 0.07);
    // (a hard cut: its edges are creases the mesher puts vertices on, where a blend would be a fillet narrower than a cell)
    d = Math.max(d, -groove.cut(ax, y, z));
    // (hard cuts: an arch's lip is an edge)
    d = Math.max(d, -archF(ax, y, z));
    d = Math.max(d, -archR(ax, y, z));
    return d;
  };
  const baseF = (x: number, y: number, z: number): number => base(x < 0 ? -x : x, y, z);

  // ── anchors on the surface ────────────────────────────────────────────────
  const zLamp = frontZ(baseF, 0.76, 0.5);
  // the lamps are regions of the front and the rear projections
  const headLamp = (ax: number, y: number, z: number): number => Math.max(sdEllipseRot2(ax, y, 0.77, 0.505, 0.14, 0.032, 0.36), 1.9 - z);
  const drlStrip = (ax: number, y: number): Float64Array => strip2(ax, y, 0.76, 0.548, 0.36, 0.17);
  const tailLamp = (ax: number, y: number, z: number, nz: number): number => Math.max(sdRoundRect2(ax, y - 0.66, 0.93, 0.014, 0.012), z - (zTail + 0.4), nz + 0.25);
  const stopStrip = (ax: number, y: number): Float64Array => strip2(ax, y, 0, 0.66, 0, 0.36);

  // the holes and pockets
  const fascia = (ax: number, y: number, z: number): number => sdRoundBox(ax, y - 0.52, z - zTail, 0.8, 0.105, 0.1, 0.035);
  // the diffuser's tunnel: its roof climbs from the floor to 40 cm at the tail
  const tunnel = (ax: number, y: number, z: number): number => Math.max((y - (0.34 - 0.36 * (z - zTail))) / 1.063, ax - 0.64, z - (zTail + 0.68));
  const scoopMouth = (ax: number, y: number, z: number): number => sdRoundBox(ax, y - 1.13 * hk, z + 0.19, 0.066, 0.04, 0.1, 0.03);
  const channelMesh = (ax: number, y: number, z: number): number => Math.max(sdRoundRect2(ax - 0.4, z - 1.98, 0.115, 0.2, 0.05), y - 0.4);
  const deckVent = (ax: number, y: number, z: number): number => Math.max(sdRoundRect2(ax - 0.4, z + 1.5, 0.085, 0.3, 0.04), 0.6 - y, y - 0.78);

  const features = (d: number, ax: number, y: number, z: number): number => {
    d = Math.max(d, -fascia(ax, y, z));
    d = Math.max(d, -tunnel(ax, y, z));
    d = Math.max(d, -scoopMouth(ax, y, z));
    d = dent(d, channelMesh(ax, y, z), 0.01, 0.04);
    d = dent(d, deckVent(ax, y, z), 0.012, 0.04);
    return d;
  };

  const body = (x: number, y: number, z: number): number => {
    const ax = x < 0 ? -x : x;
    return features(base(ax, y, z), ax, y, z);
  };

  // ── zone outlines ─────────────────────────────────────────────────────────
  // The canopy is glass from its belt up, but for a slim pillar each side of the windscreen (5.6 cm, along the line the screen's
  // plane turns into the side on: 57 cm out at its foot, 42 cm at the header, 12 cm to the left of the driver's eye), the roof panel
  // and a rail beside it, and its tail.
  const sideWin = roundPoly([1.2, 0.715, 1.2, 1.3, -0.22, 1.3, -0.62, 0.97 * hk, -0.76, 0.75], 0.03);
  const pillarX = (z: number): number => 0.42 + 0.197 * (z - 0.36);
  /** where the side glass begins, out from the centre line: outside the pillar, and behind the header outside the roof's rail */
  const sideFrom = (z: number): number => (z >= 0.36 ? pillarX(z) + 0.028 : Math.max(0.39, 0.448 - 0.5 * (0.36 - z)));

  const zones = (x: number, y: number, z: number, nx: number, ny: number, nz: number, out: Float32Array, o: number): void => {
    const ax = x < 0 ? -x : x;
    // glass: the windscreen wraps round into the side glass
    const ws = Math.max((ax - pillarX(z) + 0.028) * 0.981, 0.36 - z, 0.7 - y);
    const sw = Math.max(sdPolygon2(sideWin, z, y), (sideFrom(z) - ax) * 0.981);
    out[o] = Math.min(ws, sw);
    // black trim: the floor's edge, the inside of the arches
    const sill = y - 0.15;
    const arch = Math.min(archF(ax, y, z), archR(ax, y, z));
    out[o + 1] = Math.min(sill, arch - 0.02);
    // carbon: the sills and the bib under a line that rises to the tail, the floor of the channels beside the beak, the roof panel and
    // its scoop, the floor of the valleys beside the spine
    const lowLine = y - (0.225 + 0.2 * Math.min(1, Math.max(0, (-1.75 - z) / 0.5)));
    const channel = Math.max(ax - 0.57, 0.2 - ax, 1.12 - z, y - 0.52);
    const roof = Math.max(Math.abs(z + 0.35) - 0.72, ax - 0.36, 1.0 * hk - y);
    const deck = Math.max(ax - 0.56, 0.25 - ax, z + 0.85, y - 0.8, 0.6 - y);
    out[o + 2] = Math.min(lowLine, channel, roof, deck);
    // mesh: the channels' inlets, the side intakes' mouths, the vents, the fascia
    out[o + 3] = Math.min(channelMesh(ax, y, z), fascia(ax, y, z) - 0.004, scoopMouth(ax, y, z) - 0.003, deckVent(ax, y, z));
    // lamps
    out[o + 4] = headLamp(ax, y, z);
    out[o + 6] = tailLamp(ax, y, z, nz);
    out[o + 7] = Math.max(sdRoundRect2(ax, y - 0.45, 0.06, 0.016, 0.008), z - (zTail + 0.3), nz + 0.25);
    // shut lines: the door, the front clam, the engine cover
    out[o + 8] = Math.max(sdRoundRect2(z - 0.18, y - 0.48, 0.6, 0.42, 0.08), 0.6 - ax);
    out[o + 9] = Math.max(sdRoundRect2(ax, z - 1.75, 0.62, 0.58, 0.12), 0.4 - y);
    out[o + 10] = Math.max(sdRoundRect2(ax, z + 1.45, 0.24, 0.6, 0.08), 0.8 - y);
    out[o + 11] = 1;
    // thin LED strips: the DRL (front) and the brake bar (rear) share one signed-offset + extent pair
    if (z > 0) {
      const sd = drlStrip(ax, y);
      out[o + 5] = sd[0];
      out[o + 15] = Math.max(sd[1], 1.9 - z, 0.3 - nz);
    } else {
      const ss = stopStrip(ax, y);
      out[o + 5] = ss[0];
      out[o + 15] = Math.max(ss[1], z - (zTail + 0.4), 0.45 + nz);
    }
    out[o + 14] = 1;
    void nx;
    void ny;
  };

  return {
    bounds: { min: [-hw - 0.15, 0.02, zTail - 0.25], max: [hw + 0.15, s.height + 0.12, zNose + 0.25] },
    body,
    zones,
    parts: (b) => addHyperParts(b, s),
    farParts: (b) => addHyperFarParts(b, s),
    moving: hyperMoving(s),
    sharp: true,
    info: { projector: [0.7, 0.482, zLamp - 0.03, 0.024] },
    debug: {
      low: (x, y, z) => sdLoft(low, Math.abs(x), y, z),
      fus: (x, y, z) => sdLoft(fus, Math.abs(x), y, z),
      canopy: (x, y, z) => sdLoft(canopy, Math.abs(x), y, z),
      base: baseF,
    },
  };
};
