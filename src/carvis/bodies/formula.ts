/**
 * Volta — a 2026-rules single-seater: a narrow monocoque ending in a two-stage nose, an open cockpit under the halo, sidepods with
 * letterbox inlets and a deep undercut, an engine cover rising to the airbox and roll hoop, and a gearbox ending in the crash structure.
 * Only the solid shapes are sculpted here; the wings, the halo, the floor, the suspension and everything else thin are parts
 * (formulaParts.ts), since the sculpted mesh holds nothing under two cells.
 *
 * The cockpit is a real opening in the tub (no glass: the glass index is empty), its walls bare carbon; the two LED headlamps sit in the
 * face of the step in the nose; the rain light and the endplate lights are parts, so the four lamps the damage model knows are given
 * to it (info.lamps) rather than read off the mesh.
 */
import type { BlueprintFactory } from '../blueprint';
import { curve } from '../curve';
import { eyePoint, formulaPoints } from '../layouts';
import { defaultLoft, sdLoft } from '../loft';
import { sdRoundBox, sdRoundRect2, smax, smin, ssub } from '../sdf';
import { addFormulaFarParts, addFormulaParts, formulaMoving } from './formulaParts';
import { frontZ } from './probe';

export const makeFormula: BlueprintFactory = (s) => {
  const zF = s.wheelbase / 2;
  const zR = -s.wheelbase / 2;
  const zNose = zF + s.frontOverhang;
  const zTail = -(s.wheelbase / 2 + (s.length - s.wheelbase - s.frontOverhang));
  const hw = s.width / 2;
  const hk = s.height / 0.95;
  // (the cockpit's reference: 5 cm behind the driver's eye)
  const sz = eyePoint(s)[2] - 0.05;
  const zero = curve([zTail - 1, 0, zNose + 1, 0]);
  const flat = (v: number) => curve([zTail - 1, v, zNose + 1, v]);
  const pts = formulaPoints(s);

  // the monocoque: from behind the driver's head to the step of the nose; low and narrow, its top rounded off, its sides tucked in at the foot
  const tubF = zF + 0.62;
  const tubR = sz - 0.6;
  const tub = defaultLoft(
    {
      yb: curve([tubR, 0.07, sz + 0.5, 0.07, zF - 0.5, 0.1, zF - 0.15, 0.17, zF + 0.2, 0.235, tubF, 0.27], 0.05),
      yt: curve([tubR, 0.665 * hk, sz - 0.35, 0.645 * hk, sz, 0.625 * hk, sz + 0.55, 0.645 * hk, zF - 0.5, 0.66 * hk, zF - 0.1, 0.645 * hk, zF + 0.2, 0.59 * hk, zF + 0.45, 0.515 * hk, tubF, 0.465 * hk], 0.05),
      w: curve([tubR, 0.27, sz, 0.28, sz + 0.55, 0.272, zF - 0.5, 0.235, zF - 0.1, 0.195, zF + 0.2, 0.165, zF + 0.45, 0.143, tubF, 0.132], 0.05),
      crown: flat(0.055),
      tum: flat(0.035),
      tumY: 0.4,
      bar: flat(0.025),
      yw: 0.3,
      rTop: 0.075,
      rBot: 0.04,
      rEnd: 0.045,
      zf: tubF,
      zr: tubR,
      kf: 0.12,
      yRef: 0.35,
    },
    zero,
  );
  // the lower stage of the nose: a narrower snout that runs on under the step to the front wing
  const snout = defaultLoft(
    {
      yb: curve([zF + 0.15, 0.22, zF + 0.6, 0.2, zNose - 0.15, 0.155, zNose, 0.14], 0.04),
      yt: curve([zF + 0.15, 0.42 * hk, zF + 0.6, 0.345 * hk, zNose - 0.15, 0.285 * hk, zNose, 0.25 * hk], 0.04),
      w: curve([zF + 0.15, 0.12, zF + 0.6, 0.104, zNose - 0.15, 0.085, zNose, 0.07], 0.04),
      crown: flat(0.03),
      rTop: 0.045,
      rBot: 0.035,
      rEnd: 0.045,
      zf: zNose,
      zr: zF + 0.15,
      kf: 0.35,
      yRef: 0.2,
    },
    zero,
  );
  // the engine cover: from the cockpit's back to the gearbox, falling away behind the airbox, its rear face raked where the tailpipe leaves it
  const coverF = sz - 0.1;
  const coverR = zR - 0.38;
  const cover = defaultLoft(
    {
      yb: curve([coverF, 0.07, zR + 0.4, 0.07, zR, 0.12, coverR, 0.2], 0.05),
      yt: curve([coverF, 0.68 * hk, sz - 0.6, 0.72 * hk, sz - 1.0, 0.7 * hk, zR + 0.55, 0.6 * hk, zR + 0.2, 0.535 * hk, zR - 0.1, 0.505 * hk, coverR, 0.49 * hk], 0.06),
      w: curve([coverF, 0.27, sz - 0.6, 0.26, sz - 1.1, 0.225, zR + 0.55, 0.17, zR + 0.2, 0.13, zR - 0.1, 0.105, coverR, 0.095], 0.06),
      crown: flat(0.08),
      tum: flat(0.05),
      tumY: 0.45,
      bar: flat(0.02),
      yw: 0.3,
      rTop: 0.09,
      rBot: 0.04,
      rEnd: 0.07,
      zf: coverF,
      zr: coverR,
      kr: 0.3,
      yRef: 0.4,
    },
    zero,
  );
  // the airbox under the roll hoop: a narrow blade up to the car's full height behind the driver's head, its front raked back
  const boxF = sz - 0.32;
  const boxR = sz - 1.45;
  const airbox = defaultLoft(
    {
      yb: flat(0.5),
      yt: curve([boxF, 0.9 * hk, sz - 0.42, 0.95 * hk, sz - 0.62, 0.95 * hk, sz - 0.9, 0.865 * hk, sz - 1.2, 0.765 * hk, boxR, 0.7 * hk], 0.04),
      w: curve([boxF, 0.075, sz - 0.45, 0.095, sz - 0.8, 0.12, boxR, 0.15], 0.05),
      crown: flat(0.03),
      tum: flat(0.02),
      tumY: 0.7,
      rTop: 0.05,
      rBot: 0.05,
      rEnd: 0.04,
      zf: boxF,
      zr: boxR,
      kf: 0.35,
      yRef: 0.8,
    },
    zero,
  );
  // the sidepods, about a line 0.36 m out: an overhanging upper lip over the inlet, a deep undercut, falling away to the coke bottle
  const podX = 0.36;
  const podF = sz + 0.42;
  const podR = zR + 0.3;
  const pod = defaultLoft(
    {
      yb: curve([podF, 0.2, sz, 0.17, zR + 1, 0.14, podR, 0.14], 0.05),
      yt: curve([podF, 0.56 * hk, sz + 0.2, 0.585 * hk, sz - 0.4, 0.56 * hk, sz - 0.9, 0.47 * hk, zR + 0.6, 0.36 * hk, podR, 0.27 * hk], 0.06),
      w: curve([podF, 0.13, sz + 0.1, 0.145, sz - 0.5, 0.14, sz - 1.0, 0.105, zR + 0.6, 0.07, podR, 0.04], 0.06),
      crown: flat(0.02),
      tum: flat(0.05),
      tumY: 0.42,
      bar: flat(0.06),
      yw: 0.4,
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
  // the gearbox and the crash structure: a tapering box to the tail, the rain light on its tip
  const gearF = zR + 0.3;
  const gearbox = defaultLoft(
    {
      yb: curve([gearF, 0.16, zR - 0.4, 0.22, zTail, 0.26], 0.04),
      yt: curve([gearF, 0.44 * hk, zR - 0.3, 0.42 * hk, zR - 0.6, 0.39 * hk, zTail, 0.36 * hk], 0.04),
      w: curve([gearF, 0.13, zR, 0.11, zR - 0.5, 0.075, zTail, 0.055], 0.04),
      crown: flat(0.02),
      rTop: 0.04,
      rBot: 0.03,
      rEnd: 0.025,
      zf: gearF,
      zr: zTail,
    },
    zero,
  );

  // the cockpit opening: a rounded slot in plan, cut down to the seat
  const wellZ = sz + 0.09;
  const well = (ax: number, y: number, z: number): number => Math.max(sdRoundRect2(ax, z - wellZ, 0.205, 0.41, 0.12), 0.34 - y);
  // the sidepods' letterbox inlets and the airbox's mouth, each cut at least two cells inside the skin round it (the pod's side and top,
  // the airbox's sides and top): a thinner wall tore into shards at the lip
  const inlet = (ax: number, y: number, z: number): number => sdRoundBox(ax - 0.36, y - 0.46 * hk, z - (podF + 0.04), 0.075, 0.054, 0.15, 0.04);
  const mouth = (ax: number, y: number, z: number): number => sdRoundBox(ax, y - 0.81 * hk, z - (boxF + 0.03), 0.032, 0.05, 0.1, 0.028);

  const base = (ax: number, y: number, z: number): number => {
    let d = smin(sdLoft(tub, ax, y, z), sdLoft(snout, ax, y, z), 0.04);
    d = smin(d, sdLoft(cover, ax, y, z), 0.1);
    d = smin(d, sdLoft(airbox, ax, y, z), 0.08);
    const px = ax > podX ? ax - podX : podX - ax;
    d = smin(d, sdLoft(pod, px, y, z), 0.1);
    d = smin(d, sdLoft(gearbox, ax, y, z), 0.06);
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

  // the LED headlamps in the face of the nose's step, where the beams come from
  const led = pts.noseLed;
  const ledZ = frontZ(body, led[0], led[1]);
  const lamp = (ax: number, y: number, z: number): number => Math.max(sdRoundRect2(ax - led[0], y - led[1], 0.032, 0.014, 0.008), zF + 0.42 - z);

  const zones = (x: number, y: number, z: number, _nx: number, ny: number, nz: number, out: Float32Array, o: number): void => {
    const ax = x < 0 ? -x : x;
    // black: the underside at the floor
    out[o + 1] = Math.min(y - (s.rideHeight + 0.055), Math.max(y - 0.16, ny + 0.6));
    // bare carbon: the cockpit's walls and floor, and the undercut below the sidepods and the chassis behind the front wheels
    out[o + 2] = Math.min(well(ax, y, z) - 0.012, Math.max(y - 0.18, z - (zF - 0.35)));
    // the dark mouths of the inlets
    out[o + 3] = Math.min(inlet(ax, y, z), mouth(ax, y, z)) - 0.01;
    out[o + 4] = lamp(ax, y, z);
    // shut lines: the nose cone's joint ahead of the front bulkhead, the engine cover's front edge over the sidepods
    out[o + 8] = z - (zF - 0.12);
    out[o + 9] = Math.max(Math.abs(z - (sz - 0.48)), 0.6 * hk - y);
    void nz;
  };

  const L = { c: [led[0], led[1], ledZ] as [number, number, number], r: 0.06 };
  const T = { c: pts.wingLed, r: 0.09 };
  return {
    bounds: { min: [-hw - 0.05, 0.02, zTail - 0.2], max: [hw + 0.05, s.height + 0.12, zNose + 0.12] },
    body,
    zones,
    parts: (b) => addFormulaParts(b, s),
    farParts: (b) => addFormulaFarParts(b, s),
    moving: formulaMoving(s),
    info: {
      projector: [led[0], led[1], ledZ - 0.002, 0.011],
      lamps: [L, { c: [-L.c[0], L.c[1], L.c[2]], r: L.r }, T, { c: [-T.c[0], T.c[1], T.c[2]], r: T.r }],
    },
    debug: {
      tub: (x, y, z) => sdLoft(tub, Math.abs(x), y, z),
      well: (x, y, z) => well(Math.abs(x), y, z),
      base: (x, y, z) => base(Math.abs(x), y, z),
    },
  };
};
