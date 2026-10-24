/**
 * Dieci — a 2004-rules single-seater (CarVisualSpec.formulaEra 2004): a narrow monocoque under high cockpit sides, rising into a high
 * pointed nose the front wing hangs from; undercut sidepods with rounded inlets, chimneys and the periscope exhausts on their tops; a tall
 * airbox over the driver's head, the roll hoop round its mouth, flowing into a deep engine cover with no fin; a gearbox ending in the
 * crash structure. Only the solid shapes are sculpted here; the wings, the bargeboards, the floor and the suspension and everything else
 * thin are parts (formula04Parts.ts), since the sculpted mesh holds nothing under two cells.
 *
 * The cockpit is a real opening in the tub (no glass: the glass index is empty), its walls bare carbon; the two LED lamps sit in the tip
 * of the nose; the rain light is a part, so the four lamps the damage model knows are given to it (info.lamps): the LEDs, and the rain
 * light's two halves as the tail lamps (the car has no other rear light). The periscopes are sculpted with the sidepods they stand on,
 * so a dent moves the two alike.
 */
import type { BlueprintFactory } from '../blueprint';
import { curve } from '../curve';
import { defaultLoft, sdLoft } from '../loft';
import { sdRoundBox, sdRoundCone, sdRoundRect2, smax, smin, ssub } from '../sdf';
import { addFormula04FarParts, addFormula04Parts, frame04 } from './formula04Parts';
import { frontZ } from './probe';

type V3 = [number, number, number];

/** An exhaust stack sculpted on the body: a round cone from inside the bodywork up to a flat mouth facing `dir`, and how far a point is from its mouth's rim. */
function stack(at: V3, dir: V3, len: number, r0: number, r1: number, mouthR: number) {
  const b: V3 = [at[0] - dir[0] * len, at[1] - dir[1] * len, at[2] - dir[2] * len];
  return {
    field: (ax: number, y: number, z: number): number => {
      const d = sdRoundCone(ax, y, z, b[0], b[1], b[2], r0, at[0], at[1], at[2], r1);
      return smax(d, (ax - at[0]) * dir[0] + (y - at[1]) * dir[1] + (z - at[2]) * dir[2], 0.012);
    },
    mouth: (ax: number, y: number, z: number): number => {
      const px = ax - at[0], py = y - at[1], pz = z - at[2];
      const t = px * dir[0] + py * dir[1] + pz * dir[2];
      const rx = px - dir[0] * t, ry = py - dir[1] * t, rz = pz - dir[2] * t;
      return Math.max(Math.sqrt(rx * rx + ry * ry + rz * rz) - mouthR, -t - 0.02);
    },
  };
}

export const makeFormula04: BlueprintFactory = (s) => {
  const { zF, zR, zNose, zTail, hk, eye, sz, pts } = frame04(s);
  const hw = s.width / 2;
  const zero = curve([zTail - 1, 0, zNose + 1, 0]);
  const flat = (v: number) => curve([zTail - 1, v, zNose + 1, v]);
  // (the cockpit's sides are set from the driver's eye, just above them: the rim beside the helmet is 10 cm under the eye)
  const ey = eye[1];

  // the monocoque and the high nose, one piece: narrow at the cockpit, its sides high round the driver, its top falling gently from the
  // front of the cockpit (62.5 cm up there with the eye at 73, 58.5 over the front axle) and narrowing to a rounded tip 33 cm off the
  // ground, its underside level from the front axle on
  const tubR = sz - 0.55;
  const tub = defaultLoft(
    {
      yb: curve([tubR, 0.07, sz + 0.45, 0.07, zF - 0.75, 0.1, zF - 0.3, 0.22, zF + 0.05, 0.275, zF + 0.5, 0.29, zNose - 0.1, 0.29, zNose, 0.285], 0.05),
      yt: curve([tubR, ey - 0.1, sz - 0.3, ey - 0.085, sz, ey - 0.07, sz + 0.3, ey - 0.08, sz + 0.58, ey - 0.105, zF - 0.5, 0.62 * hk, zF, 0.585 * hk, zF + 0.5, 0.48 * hk, zNose - 0.15, 0.405 * hk, zNose, 0.375 * hk], 0.05),
      w: curve([tubR, 0.27, sz, 0.285, sz + 0.55, 0.265, zF - 0.5, 0.225, zF, 0.175, zF + 0.45, 0.13, zNose - 0.15, 0.095, zNose, 0.08], 0.05),
      crown: curve([tubR, 0.05, zF, 0.05, zNose, 0.03], 0.05),
      tum: flat(0.035),
      tumY: 0.42,
      bar: flat(0.025),
      yw: 0.3,
      rTop: 0.06,
      rBot: 0.035,
      rEnd: 0.045,
      zf: zNose,
      zr: tubR,
      yRef: 0.33,
    },
    zero,
  );
  // the engine cover: from the cockpit's back down to the gearbox, deep and flat-sided (the rules of 2004 asked for side area there, and
  // no fin), narrowing to a tight coke bottle at the rear axle
  const coverF = sz - 0.1;
  const coverR = zR - 0.3;
  const cover = defaultLoft(
    {
      yb: curve([coverF, 0.07, zR + 0.45, 0.07, zR, 0.13, coverR, 0.2], 0.05),
      yt: curve([coverF, 0.68 * hk, sz - 0.5, 0.79 * hk, sz - 0.9, 0.76 * hk, zR + 0.5, 0.7 * hk, zR, 0.555 * hk, coverR, 0.47 * hk], 0.06),
      w: curve([coverF, 0.27, sz - 0.5, 0.25, sz - 0.9, 0.21, zR + 0.5, 0.165, zR, 0.12, coverR, 0.095], 0.06),
      crown: flat(0.05),
      tum: curve([coverF, 0.1, sz - 0.9, 0.09, zR + 0.5, 0.07, zR, 0.04, coverR, 0.03], 0.06),
      tumY: 0.42,
      bar: flat(0.02),
      yw: 0.3,
      rTop: 0.07,
      rBot: 0.04,
      rEnd: 0.06,
      zf: coverF,
      zr: coverR,
      kr: 0.3,
      yRef: 0.4,
    },
    zero,
  );
  // the airbox right behind the driver's head, its mouth framed by the roll hoop, 95 cm up, flowing back into the engine cover; its front
  // leans back a little, and its foot stands 2 cm behind the cockpit's opening, which would otherwise cut a sliver off it
  const boxF = sz - 0.265;
  const boxR = sz - 1.2;
  const airbox = defaultLoft(
    {
      yb: flat(0.52),
      yt: curve([boxF, 0.94 * hk, sz - 0.36, 0.95 * hk, sz - 0.55, 0.94 * hk, sz - 0.8, 0.875 * hk, sz - 1.0, 0.79 * hk, boxR, 0.71 * hk], 0.04),
      w: curve([boxF, 0.115, sz - 0.45, 0.12, sz - 0.8, 0.125, boxR, 0.13], 0.05),
      crown: flat(0.035),
      tum: flat(0.02),
      tumY: 0.75,
      rTop: 0.055,
      rBot: 0.05,
      rEnd: 0.045,
      zf: boxF,
      zr: boxR,
      kf: 0.19,
      yRef: 0.75,
    },
    zero,
  );
  // the sidepods, about a line 0.335 m out: an overhanging upper lip over a rounded inlet, a deep undercut, falling away to the coke bottle
  const podX = 0.335;
  const podF = sz + 0.44;
  const podR = zR + 0.25;
  const pod = defaultLoft(
    {
      yb: curve([podF, 0.22, sz, 0.18, zR + 1, 0.15, podR, 0.14], 0.05),
      yt: curve([podF, 0.55 * hk, sz + 0.2, 0.575 * hk, sz - 0.3, 0.565 * hk, zR + 0.95, 0.52 * hk, zR + 0.6, 0.47 * hk, zR + 0.3, 0.37 * hk, podR, 0.31 * hk], 0.06),
      w: curve([podF, 0.16, sz + 0.15, 0.163, sz - 0.45, 0.152, zR + 0.8, 0.12, zR + 0.5, 0.09, podR, 0.05], 0.06),
      crown: flat(0.02),
      tum: flat(0.05),
      tumY: 0.42,
      bar: flat(0.07),
      yw: 0.42,
      rTop: 0.08,
      rBot: 0.05,
      rEnd: 0.08,
      zf: podF,
      zr: podR,
      kf: -0.3,
      yRef: 0.35,
    },
    zero,
  );
  // the gearbox and the crash structure: a box tapering to the tail, rising to carry the rain light on its tip 40 cm up
  const gearF = zR + 0.35;
  const gearbox = defaultLoft(
    {
      yb: curve([gearF, 0.15, zR, 0.17, zR - 0.25, 0.25, zTail, 0.325], 0.04),
      yt: curve([gearF, 0.47 * hk, zR, 0.45 * hk, zR - 0.3, 0.45 * hk, zTail, 0.49 * hk], 0.04),
      w: curve([gearF, 0.13, zR, 0.11, zR - 0.25, 0.08, zTail, 0.065], 0.04),
      crown: flat(0.015),
      rTop: 0.035,
      rBot: 0.03,
      rEnd: 0.02,
      zf: gearF,
      zr: zTail,
    },
    zero,
  );
  // the periscopes: a stack each side on the sidepod's top next to the engine cover, its oval mouth facing up and back (formula04Points);
  // and a chimney further forward on each sidepod's shoulder, angled out
  const per = stack(pts.periscope.at, pts.periscope.dir, 0.17, 0.068, 0.05, 0.03);
  const cd = Math.hypot(0.32, 0.9, -0.28);
  const chim = stack([0.405, 0.585 * hk, sz - 0.55], [0.32 / cd, 0.9 / cd, -0.28 / cd], 0.12, 0.05, 0.036, 0.018);

  // the cockpit opening: a rounded slot in plan from just ahead of the steering wheel to behind the helmet, cut down to the seat
  const wellZ = sz + 0.19;
  const well = (ax: number, y: number, z: number): number => Math.max(sdRoundRect2(ax, z - wellZ, 0.2, 0.39, 0.13), 0.34 - y);
  // the sidepods' inlets and the airbox's mouth, each cut at least two cells inside the skin round it (the pod's side and top, the tub's
  // side, the airbox's sides and top): a thinner wall tears into shards at the lip
  const inlet = (ax: number, y: number, z: number): number => sdRoundBox(ax - 0.378, y - 0.39 * hk, z - (podF + 0.04), 0.067, 0.095, 0.15, 0.045);
  const mouth = (ax: number, y: number, z: number): number => sdRoundBox(ax, y - 0.8 * hk, z - boxF, 0.055, 0.085, 0.1, 0.03);

  const base = (ax: number, y: number, z: number): number => {
    let d = sdLoft(tub, ax, y, z);
    d = smin(d, sdLoft(cover, ax, y, z), 0.1);
    d = smin(d, sdLoft(airbox, ax, y, z), 0.08);
    const px = ax > podX ? ax - podX : podX - ax;
    d = smin(d, sdLoft(pod, px, y, z), 0.1);
    d = smin(d, sdLoft(gearbox, ax, y, z), 0.06);
    d = smin(d, per.field(ax, y, z), 0.07);
    d = smin(d, chim.field(ax, y, z), 0.04);
    // clip to the overall length
    d = smax(d, z - zNose, 0.02);
    d = smax(d, zTail - z, 0.02);
    return d;
  };
  const body = (x: number, y: number, z: number): number => {
    const ax = x < 0 ? -x : x;
    let d = base(ax, y, z);
    d = ssub(d, well(ax, y, z), 0.022);
    d = ssub(d, inlet(ax, y, z), 0.03);
    d = ssub(d, mouth(ax, y, z), 0.015);
    return d;
  };

  // the LED lamps in the tip of the nose, where the beams come from
  const led = pts.noseLed;
  const ledZ = frontZ(body, led[0], led[1]);
  const lamp = (ax: number, y: number, z: number): number => Math.max(sdRoundRect2(ax - led[0], y - led[1], 0.014, 0.008, 0.005), zNose - 0.07 - z);

  const zones = (x: number, y: number, z: number, _nx: number, ny: number, nz: number, out: Float32Array, o: number): void => {
    const ax = x < 0 ? -x : x;
    const pm = Math.min(per.mouth(ax, y, z), chim.mouth(ax, y, z));
    // black: the underside at the floor, and the soot round the mouths of the periscopes and the chimneys
    out[o + 1] = Math.min(y - (s.rideHeight + 0.055), Math.max(y - 0.16, ny + 0.6), pm - 0.014);
    // bare carbon: the cockpit's walls and floor, and the undercut below the sidepods and the chassis behind the front wheels
    out[o + 2] = Math.min(well(ax, y, z) - 0.012, Math.max(y - 0.18, z - (zF - 0.35)));
    // the dark mouths of the inlets, the airbox, the periscopes and the chimneys
    out[o + 3] = Math.min(inlet(ax, y, z) - 0.01, mouth(ax, y, z) - 0.01, pm);
    out[o + 4] = lamp(ax, y, z);
    // shut lines: the nose cone's joint ahead of the front bulkhead, the engine cover's front edge round the airbox over the sidepods
    out[o + 8] = z - (zF - 0.05);
    out[o + 9] = Math.max(Math.abs(z - (sz - 0.48)), 0.6 * hk - y);
    void nz;
  };

  const L = { c: [led[0], led[1], ledZ] as V3, r: 0.06 };
  const rain = pts.rainLight;
  return {
    bounds: { min: [-hw - 0.05, 0.02, zTail - 0.2], max: [hw + 0.05, s.height + 0.12, zNose + 0.12] },
    body,
    zones,
    parts: (b) => addFormula04Parts(b, s),
    farParts: (b) => addFormula04FarParts(b, s),
    info: {
      projector: [led[0], led[1], ledZ - 0.002, 0.009],
      lamps: [L, { c: [-L.c[0], L.c[1], L.c[2]], r: L.r }, { c: [0.03, rain[1], rain[2]], r: 0.06 }, { c: [-0.03, rain[1], rain[2]], r: 0.06 }],
    },
    debug: {
      tub: (x, y, z) => sdLoft(tub, Math.abs(x), y, z),
      well: (x, y, z) => well(Math.abs(x), y, z),
      base: (x, y, z) => base(Math.abs(x), y, z),
    },
  };
};
