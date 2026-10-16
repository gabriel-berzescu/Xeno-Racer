/**
 * Ronin 86 — compact classically proportioned 2+2 sports coupe: low nose, short deck, ducktail.
 */
import type { BlueprintFactory } from '../blueprint';
import { PART } from '../blueprint';
import { curve } from '../curve';
import { defaultLoft, sdFootprint, sdLoft } from '../loft';
import type { PartBuilder } from '../parts';
import { dent, roundPoly, strip2 } from '../shapes';
import { sdCylinderX, sdEllipseRot2, sdEllipsoid, sdPolygon2, sdRoundBox, sdRoundRect2, sdSegment2, smax, smin, ssub } from '../sdf';
import { addDiffuserStrakes, addWing } from '../aero';
import { addDoorMirrors } from '../mirrorParts';
import { frontZ, rearZ, sideX } from './probe';

export const makeCoupe: BlueprintFactory = (s) => {
  const zF = s.wheelbase / 2;
  const zR = -s.wheelbase / 2;
  const zNose = zF + s.frontOverhang;
  const zTail = -(s.wheelbase / 2 + (s.length - s.wheelbase - s.frontOverhang));
  const hw = s.width / 2;
  const roofK = s.height / 1.3;
  const zero = curve([zTail, 0, zNose, 0]);

  const lower = defaultLoft(
    {
      yb: curve([zTail, 0.32, zTail + 0.4, 0.2, zTail + 0.8, 0.12, zNose - 0.45, 0.12, zNose - 0.1, 0.14, zNose, 0.22], 0.04),
      yt: curve(
        [
          zTail, 0.935, zTail + 0.12, 0.955, zR - 0.45, 0.965, zR, 0.955, -0.8, 0.93, -0.2, 0.905, 0.3, 0.9, 0.5, 0.895, 1.0, 0.84, zF, 0.79, zF + 0.4, 0.745, zNose - 0.3, 0.7, zNose - 0.1, 0.64, zNose, 0.46,
        ],
        0.05,
      ),
      w: curve(
        [
          zTail, 0.7, zTail + 0.1, 0.8, zTail + 0.3, 0.86, zTail + 0.55, 0.88, zR, 0.895, zR + 0.4, 0.885, 0, 0.865, zF - 0.5, 0.88, zF, 0.895, zNose - 0.55, 0.865, zNose - 0.35, 0.82, zNose - 0.2, 0.75, zNose - 0.07, 0.6, zNose, 0.42,
        ],
        0.05,
      ),
      crown: curve([zTail, 0.035, zNose, 0.04]),
      tum: curve([zTail, 0.05, zNose, 0.05]),
      bar: curve([zTail, 0.08, zNose, 0.08]),
      yw: 0.56,
      tumY: 0.5,
      rTop: 0.1,
      rBot: 0.06,
      rEnd: 0.115,
      zf: zNose,
      zr: zTail,
      kf: 0.32,
      kr: 0.1,
      yRef: 0.2,
    },
    zero,
  );

  const cabin = defaultLoft(
    {
      yb: curve([-3, 0.82, 3, 0.82]),
      yt: curve(
        [-2.0, 0.96, -1.85, 0.99 * roofK, -1.55, 1.07 * roofK, -1.25, 1.16 * roofK, -0.95, 1.245 * roofK, -0.6, 1.296 * roofK, -0.3, 1.3 * roofK, 0.0, 1.29 * roofK, 0.4, 1.27 * roofK, 1.2, 1.25 * roofK],
        0.04,
      ),
      w: curve([-2.0, 0.66, -1.6, 0.78, -1.2, 0.82, -0.5, 0.835, 0, 0.83, 0.35, 0.815, 0.6, 0.76, 0.8, 0.7], 0.05),
      crown: curve([-2.2, 0.045, 1, 0.045]),
      tum: curve([-2.2, 0.22, 1, 0.22]),
      tumY: 0.92,
      rTop: 0.18,
      rBot: 0.1,
      rEnd: 0.1,
      zf: 0.5,
      zr: -3,
      kf: 1.65,
      kr: 0,
      yRef: 0.9,
    },
    zero,
  );

  const rF = s.wheelRadiusFront, rR = s.wheelRadiusRear;
  const archGap = 0.04;
  const footW = hw + 0.03;

  const base = (ax: number, y: number, z: number): number => {
    let d = smin(sdLoft(lower, ax, y, z), sdLoft(cabin, ax, y, z), 0.1);
    d = smin(d, sdEllipsoid(ax - 0.75, y - 0.55, z - zF, 0.165, 0.24, 0.5), 0.15);
    d = smin(d, sdEllipsoid(ax - 0.75, y - 0.58, z - zR, 0.17, 0.27, 0.55), 0.16);
    d = smax(d, sdFootprint(ax, z, footW, zNose, zTail, 0.45, 0.32), 0.085);
    // ducktail
    d = smin(d, sdRoundBox(ax, y - 0.955, z - (zTail + 0.15), 0.6, 0.022, 0.15, 0.02), 0.05);
    const cf = sdCylinderX(ax - 0.94, y - rF, z - zF, rF + archGap, 0.42, 0.02);
    const cr = sdCylinderX(ax - 0.94, y - rR, z - zR, rR + archGap, 0.42, 0.02);
    d = ssub(d, cf, 0.07);
    d = ssub(d, cr, 0.07);
    return d;
  };
  const baseF = (x: number, y: number, z: number): number => base(x < 0 ? -x : x, y, z);

  const zMouth = frontZ(baseF, 0, 0.3);
  const zFog = frontZ(baseF, 0.62, 0.26) - 0.03;
  const gillZ = zF - 0.42;
  const gillX = sideX(baseF, 0.6, gillZ);
  const projZ = frontZ(baseF, 0.58, 0.63);

  const headLamp = (ax: number, y: number, z: number): number => Math.max(sdEllipseRot2(ax, y, 0.62, 0.635, 0.21, 0.04, 0.35), 1.9 - z);
  const drlStrip = (ax: number, y: number): Float64Array => strip2(ax, y, 0.62, 0.664, 0.35, 0.185);
  const tailLamp = (ax: number, y: number, z: number): number => Math.max(sdEllipseRot2(ax, y, 0.55, 0.86, 0.26, 0.036, 0.1), z - (zTail + 0.45));
  const stopStrip = (ax: number, y: number): Float64Array => strip2(ax, y, 0, 0.58, 0, 0.1);

  const features = (d: number, ax: number, y: number, z: number): number => {
    d = ssub(d, sdRoundBox(ax, y - 0.3, z - (zMouth - 0.02), 0.36, 0.075, 0.14, 0.05), 0.035);
    d = ssub(d, sdRoundBox(ax - 0.62, y - 0.26, z - zFog, 0.09, 0.05, 0.1, 0.04), 0.035);
    d = dent(d, Math.max(sdSegment2(z, y, -0.5, 0.78, -0.3, 0.78) - 0.028, 0.7 - ax), 0.008, 0.04);
    d = ssub(d, sdRoundBox(ax - (gillX + 0.008), y - 0.6, z - gillZ, 0.09, 0.04, 0.12, 0.025), 0.03);
    d = dent(d, Math.max(sdRoundRect2(ax - 0.42, z - 1.45, 0.07, 0.24, 0.04), 0.65 - y), 0.01, 0.045);
    return d;
  };

  const body = (x: number, y: number, z: number): number => {
    const ax = x < 0 ? -x : x;
    return features(base(ax, y, z), ax, y, z);
  };

  const doorWin = roundPoly([0.36, 0.93, -0.06, 1.14, -0.5, 1.255, -0.88, 1.2, -0.92, 0.935], 0.03);
  const quarterWin = roundPoly([-0.98, 0.945, -0.98, 1.19, -1.3, 1.1, -1.55, 1.0, -1.55, 0.965], 0.025);
  const windshield = roundPoly([0.49, 0.68, 0.49, -0.68, -0.06, -0.55, -0.06, 0.55], 0.06);
  const rearGlass = roundPoly([-1.1, 0.54, -1.1, -0.54, -1.72, -0.48, -1.72, 0.48], 0.06);

  const zones = (x: number, y: number, z: number, nx: number, ny: number, nz: number, out: Float32Array, o: number): void => {
    const ax = x < 0 ? -x : x;
    const sw = Math.max(sdPolygon2(doorWin, z, y), 0.42 - ax);
    const qw = Math.max(sdPolygon2(quarterWin, z, y), 0.42 - ax);
    const ws = Math.max(sdPolygon2(windshield, z, ax), 0.7 - y);
    const rg = Math.max(sdPolygon2(rearGlass, z, ax), 0.7 - y);
    out[o] = Math.min(sw, qw, ws, rg);
    const sill = Math.max(y - 0.23, 0.62 - ax, Math.abs(z) - 0.92);
    const splitter = Math.max(y - 0.17, z - (zNose - 0.4));
    const diffuser = Math.max(y - 0.36, z - (zTail + 0.5));
    const arch = Math.min(sdCylinderX(ax - 0.94, y - rF, z - zF, rF + archGap, 0.42, 0.02), sdCylinderX(ax - 0.94, y - rR, z - zR, rR + archGap, 0.42, 0.02));
    const pillarB = Math.max(Math.abs(z + 0.95) - 0.04, 0.5 - ax, y - 1.22, 0.93 - y);
    out[o + 1] = Math.min(sill, splitter, diffuser, arch - 0.02, pillarB);
    out[o + 2] = 1;
    const mouth = sdRoundBox(ax, y - 0.3, z - (zMouth - 0.02), 0.37, 0.085, 0.15, 0.05) - 0.005;
    const fog = sdRoundBox(ax - 0.62, y - 0.26, z - zFog, 0.1, 0.06, 0.11, 0.04) - 0.005;
    const gill = sdRoundBox(ax - (gillX + 0.008), y - 0.6, z - gillZ, 0.1, 0.05, 0.13, 0.025) - 0.004;
    const vent = Math.max(sdRoundRect2(ax - 0.42, z - 1.45, 0.07, 0.24, 0.04), 0.65 - y);
    out[o + 3] = Math.min(mouth, fog, gill, vent);
    out[o + 4] = headLamp(ax, y, z);
    out[o + 6] = tailLamp(ax, y, z);
    out[o + 7] = Math.max(sdRoundRect2(ax, y - 0.46, 0.06, 0.028, 0.01), z - (zTail + 0.7));
    out[o + 8] = Math.max(sdRoundRect2(z + 0.02, y - 0.62, 0.5, 0.4, 0.06), 0.55 - ax);
    out[o + 9] = Math.max(sdRoundRect2(ax, z - 1.35, 0.78, 0.8, 0.1), 0.6 - y);
    out[o + 10] = Math.max(sdRoundRect2(ax, z + 1.95, 0.62, 0.16, 0.06), 0.84 - y);
    out[o + 11] = 1;
    // thin LED strips: the DRL (front) and the brake bar (rear) share one signed-offset + extent pair
    if (z > 0) {
      const sd = drlStrip(ax, y);
      out[o + 5] = sd[0];
      out[o + 15] = Math.max(sd[1], 1.9 - z, 0.45 - nz);
    } else {
      const ss = stopStrip(ax, y);
      out[o + 5] = ss[0];
      out[o + 15] = Math.max(ss[1], z - (zTail + 0.5), 0.45 + nz);
    }
    out[o + 14] = 1;
  };

  const parts = (b: PartBuilder): void => {
    {
      const poly = roundPoly([0.0, zNose + 0.045, 0.55, zNose + 0.025, 0.8, zNose - 0.2, 0.82, zNose - 0.4, -0.82, zNose - 0.4, -0.8, zNose - 0.2, -0.55, zNose + 0.025], 0.03);
      b.setPart(PART.plastic);
      b.extrude(poly, { o: [0, 0.13, 0], u: [1, 0, 0], v: [0, 0, 1] }, 0.016, 0.004, 2);
    }
    // small wing: a cambered blade on two angled stands over the ducktail
    {
      const zS = zTail + 0.13;
      addWing(b, {
        halfSpan: 0.56,
        y: 1.015,
        z: zS,
        chord: 0.2 + 0.25 * s.wing,
        thick: 0.07,
        camber: 0.06,
        incidence: 0.1,
        plate: { up: 0.07, down: 0.015, len: 0.26, part: PART.body, thickness: 0.01 },
        pylons: [{ x: -0.36, bottomY: 0.95, bottomZ: zS + 0.03, width: 0.03 }, { x: 0.36, bottomY: 0.95, bottomZ: zS + 0.03, width: 0.03 }],
      });
    }
    // split exhaust: one each side
    for (const x of [-0.46, 0.46]) {
      b.setPart(PART.titanium);
      b.cylinder([x, 0.33, zTail + 0.1], [x, 0.33, zTail - 0.05], 0.044, 0.048, 20, false);
      b.setPart(PART.plastic);
      b.cylinder([x, 0.33, zTail + 0.07], [x, 0.33, zTail + 0.06], 0.04, 0.04, 20, true);
    }
    addDiffuserStrakes(b, [-0.24, -0.12, 0.12, 0.24], 0.27, 0.4, zTail + 0.02, zTail + 0.3, 0.04);
    // mirrors: housing, stalk and glass face, set where the live mirror glass sits (carvis/mirrorLayout.ts)
    addDoorMirrors(b, s);
  };

  void rearZ;
  return {
    bounds: { min: [-hw - 0.15, 0.02, zTail - 0.2], max: [hw + 0.15, s.height + 0.12, zNose + 0.2] },
    body,
    zones,
    parts,
    info: { projector: [0.56, 0.63, projZ - 0.03, 0.026] },
  };
};
