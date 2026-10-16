/**
 * Kestrel R — aggressive modern hot hatch: tall greenhouse, short hood, flared arches, big
 * intakes, roof spoiler, centre exhaust.
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

export const makeHatch: BlueprintFactory = (s) => {
  const zF = s.wheelbase / 2;
  const zR = -s.wheelbase / 2;
  const zNose = zF + s.frontOverhang;
  const zTail = -(s.wheelbase / 2 + (s.length - s.wheelbase - s.frontOverhang));
  const hw = s.width / 2;
  const roofK = s.height / 1.44;
  const zero = curve([zTail, 0, zNose, 0]);

  const lower = defaultLoft(
    {
      yb: curve([zTail, 0.36, zTail + 0.35, 0.22, zTail + 0.8, 0.14, zNose - 0.5, 0.14, zNose - 0.1, 0.16, zNose, 0.27], 0.04),
      yt: curve(
        [
          zTail, 1.04, zTail + 0.2, 1.05, zR - 0.4, 1.02, zR, 1.0, -0.8, 0.98, -0.2, 0.97, 0.3, 0.965, 0.55, 0.955, 1.0, 0.91, zF, 0.865, zF + 0.45, 0.815, zNose - 0.3, 0.765, zNose - 0.1, 0.71, zNose, 0.5,
        ],
        0.05,
      ),
      w: curve(
        [
          zTail, 0.74, zTail + 0.12, 0.81, zTail + 0.3, 0.87, zTail + 0.55, 0.905, zR, 0.925, zR + 0.4, 0.915, -0.5, 0.905, 0, 0.9, zF - 0.6, 0.91, zF, 0.925, zNose - 0.6, 0.9, zNose - 0.4, 0.865, zNose - 0.2, 0.79, zNose - 0.05, 0.63, zNose, 0.46,
        ],
        0.05,
      ),
      crown: curve([zTail, 0.03, zNose, 0.04]),
      tum: curve([zTail, 0.05, zNose, 0.05]),
      bar: curve([zTail, 0.08, zNose, 0.08]),
      yw: 0.58,
      tumY: 0.5,
      rTop: 0.1,
      rBot: 0.06,
      rEnd: 0.115,
      zf: zNose + 0.04,
      zr: zTail - 0.02,
      kf: 0.3,
      kr: 0.08,
      yRef: 0.2,
    },
    zero,
  );

  const cabin = defaultLoft(
    {
      yb: curve([-3, 0.85, 3, 0.85]),
      yt: curve(
        [-2.2, 1.0, -2.1, 1.07 * roofK, -2.0, 1.15 * roofK, -1.9, 1.235 * roofK, -1.78, 1.31 * roofK, -1.64, 1.375 * roofK, -1.45, 1.42 * roofK, -1.2, 1.44 * roofK, -0.4, 1.44 * roofK, 0.0, 1.43 * roofK, 0.5, 1.41 * roofK, 1.2, 1.4 * roofK],
        0.04,
      ),
      w: curve([-2.2, 0.66, -2.0, 0.76, -1.7, 0.83, -1.3, 0.87, -0.6, 0.88, 0, 0.875, 0.4, 0.85, 0.65, 0.78, 0.9, 0.7], 0.05),
      crown: curve([-2.2, 0.04, 1, 0.04]),
      tum: curve([-2.2, 0.2, 1, 0.2]),
      tumY: 0.98,
      rTop: 0.16,
      rBot: 0.1,
      rEnd: 0.1,
      zf: 0.55,
      zr: -3,
      kf: 1.73,
      kr: 0,
      yRef: 0.95,
    },
    zero,
  );

  const rF = s.wheelRadiusFront, rR = s.wheelRadiusRear;
  const archGap = 0.04;
  const footW = hw + 0.03;

  const base = (ax: number, y: number, z: number): number => {
    let d = smin(sdLoft(lower, ax, y, z), sdLoft(cabin, ax, y, z), 0.1);
    // flared arches: raise/widen the shoulder over each wheel
    d = smin(d, sdEllipsoid(ax - 0.77, y - 0.56, z - zF, 0.17, 0.25, 0.5), 0.15);
    d = smin(d, sdEllipsoid(ax - 0.77, y - 0.6, z - zR, 0.17, 0.28, 0.5), 0.15);
    d = smax(d, sdFootprint(ax, z, footW, zNose, zTail, 0.45, 0.28), 0.08);
    const cf = sdCylinderX(ax - 0.95, y - rF, z - zF, rF + archGap, 0.42, 0.02);
    const cr = sdCylinderX(ax - 0.95, y - rR, z - zR, rR + archGap, 0.42, 0.02);
    d = ssub(d, cf, 0.07);
    d = ssub(d, cr, 0.07);
    return d;
  };
  const baseF = (x: number, y: number, z: number): number => base(x < 0 ? -x : x, y, z);

  const zMouth = frontZ(baseF, 0, 0.3);
  const zUpperGrille = frontZ(baseF, 0, 0.58);
  const zSideIntake = frontZ(baseF, 0.72, 0.28) - 0.03;
  const gillZ = zF - 0.5;
  const gillX = sideX(baseF, 0.62, gillZ);
  const projZ = frontZ(baseF, 0.6, 0.655);
  const tailPlaneZ = rearZ(baseF, 0.0, 0.5);

  const headLamp = (ax: number, y: number, z: number): number => Math.max(sdEllipseRot2(ax, y, 0.66, 0.665, 0.22, 0.045, 0.25), 1.92 - z);
  const drlStrip = (ax: number, y: number): Float64Array => strip2(ax, y, 0.65, 0.69, 0.25, 0.185);
  const tailLamp = (ax: number, y: number, z: number): number => Math.max(sdEllipseRot2(ax, y, 0.63, 0.9, 0.3, 0.075, 0.32), z - (zTail + 0.6));
  const stopStrip = (ax: number, y: number): Float64Array => strip2(ax, y, 0, 0.56, 0, 0.12);

  const features = (d: number, ax: number, y: number, z: number): number => {
    // lower mouth + upper slot grille
    d = ssub(d, sdRoundBox(ax, y - 0.31, z - (zMouth - 0.02), 0.52, 0.085, 0.14, 0.05), 0.035);
    d = ssub(d, sdRoundBox(ax, y - 0.58, z - (zUpperGrille - 0.01), 0.42, 0.028, 0.08, 0.02), 0.03);
    // large corner intakes
    d = ssub(d, sdRoundBox(ax - 0.7, y - 0.28, z - zSideIntake, 0.15, 0.07, 0.1, 0.04), 0.035);
    // lamp recesses
    // door handles (front + rear)
    d = dent(d, Math.max(sdSegment2(z, y, -0.25, 0.82, -0.05, 0.82) - 0.03, 0.74 - ax), 0.008, 0.04);
    d = dent(d, Math.max(sdSegment2(z, y, -0.98, 0.82, -0.8, 0.82) - 0.03, 0.74 - ax), 0.008, 0.04);
    // fender gill
    d = ssub(d, sdRoundBox(ax - (gillX + 0.01), y - 0.62, z - gillZ, 0.1, 0.06, 0.1, 0.03), 0.03);
    // bonnet vent
    d = dent(d, Math.max(sdRoundRect2(ax - 0.5, z - 1.7, 0.12, 0.14, 0.04), 0.7 - y), 0.01, 0.045);
    return d;
  };

  const body = (x: number, y: number, z: number): number => {
    const ax = x < 0 ? -x : x;
    return features(base(ax, y, z), ax, y, z);
  };

  const frontDoorWin = roundPoly([0.42, 0.99, -0.12, 1.34, -0.5, 1.395, -0.62, 1.39, -0.66, 0.99], 0.05);
  const rearDoorWin = roundPoly([-0.74, 0.99, -0.72, 1.375, -1.1, 1.385, -1.34, 1.34, -1.24, 0.99], 0.045);
  const quarterWin = roundPoly([-1.34, 1.0, -1.42, 1.27, -1.6, 1.2, -1.74, 1.1, -1.76, 1.0], 0.04);
  const windshield = roundPoly([0.54, 0.7, 0.54, -0.7, -0.28, -0.56, -0.28, 0.56], 0.06);
  const rearGlass = roundPoly([-1.66, 0.64, -1.66, -0.64, -2.05, -0.57, -2.05, 0.57], 0.07);

  const zones = (x: number, y: number, z: number, nx: number, ny: number, nz: number, out: Float32Array, o: number): void => {
    const ax = x < 0 ? -x : x;
    const w1 = Math.max(sdPolygon2(frontDoorWin, z, y), 0.46 - ax);
    const w2 = Math.max(sdPolygon2(rearDoorWin, z, y), 0.46 - ax);
    const w3 = Math.max(sdPolygon2(quarterWin, z, y), 0.46 - ax);
    const ws = Math.max(sdPolygon2(windshield, z, ax), 0.9 - y);
    const rg = Math.max(sdPolygon2(rearGlass, z, ax), 1.0 - y);
    out[o] = Math.min(w1, w2, w3, ws, rg);
    const sill = Math.max(y - 0.24, 0.66 - ax, Math.abs(z + 0.0) - 1.02);
    const splitter = Math.max(y - 0.2, z - (zNose - 0.45));
    const diffuser = Math.max(y - 0.44, z - (zTail + 0.55));
    const arch = Math.min(sdCylinderX(ax - 0.95, y - rF, z - zF, rF + archGap, 0.42, 0.02), sdCylinderX(ax - 0.95, y - rR, z - zR, rR + archGap, 0.42, 0.02));
    const pillarB = Math.max(Math.abs(z + 0.68) - 0.045, 0.5 - ax, y - 1.4, 0.98 - y);
    out[o + 1] = Math.min(sill, splitter, diffuser, arch - 0.02, pillarB);
    out[o + 2] = Math.min(Math.max(Math.abs(z - zNose + 0.4) - 0.03, ax - 0.6, y - 0.26), 1);
    const mouth = sdRoundBox(ax, y - 0.31, z - (zMouth - 0.02), 0.53, 0.095, 0.15, 0.05) - 0.005;
    const upper = sdRoundBox(ax, y - 0.58, z - (zUpperGrille - 0.01), 0.43, 0.035, 0.09, 0.02) - 0.004;
    const corner = sdRoundBox(ax - 0.7, y - 0.28, z - zSideIntake, 0.16, 0.08, 0.11, 0.04) - 0.005;
    const gill = sdRoundBox(ax - (gillX + 0.01), y - 0.62, z - gillZ, 0.11, 0.07, 0.11, 0.03) - 0.004;
    const vent = Math.max(sdRoundRect2(ax - 0.5, z - 1.7, 0.12, 0.14, 0.04), 0.7 - y);
    out[o + 3] = Math.min(mouth, upper, corner, gill, vent);
    out[o + 4] = headLamp(ax, y, z);
    out[o + 6] = tailLamp(ax, y, z);
    out[o + 7] = Math.max(sdRoundRect2(ax, y - 0.46, 0.06, 0.03, 0.01), z - (zTail + 0.7));
    out[o + 8] = Math.max(sdRoundRect2(z + 0.38, y - 0.64, 0.45, 0.4, 0.06), 0.55 - ax);
    out[o + 9] = Math.max(sdRoundRect2(ax, z - 1.35, 0.78, 0.82, 0.1), 0.6 - y);
    out[o + 10] = Math.max(sdRoundRect2(ax, y - 0.95, 0.72, 0.02, 0.01), -(z - (zTail + 0.45)));
    out[o + 11] = Math.max(sdRoundRect2(z + 1.0, y - 0.64, 0.38, 0.4, 0.06), 0.55 - ax);
    // thin LED strips: the DRL (front) and the brake bar (rear) share one signed-offset + extent pair
    if (z > 0) {
      const sd = drlStrip(ax, y);
      out[o + 5] = sd[0];
      out[o + 15] = Math.max(sd[1], 1.92 - z, 0.45 - nz);
    } else {
      const ss = stopStrip(ax, y);
      out[o + 5] = ss[0];
      out[o + 15] = Math.max(ss[1], z - (zTail + 0.6), 0.45 + nz);
    }
    out[o + 14] = 1;
  };

  const parts = (b: PartBuilder): void => {
    // front splitter lip
    {
      const poly = roundPoly([0.0, zNose + 0.045, 0.6, zNose + 0.03, 0.84, zNose - 0.2, 0.86, zNose - 0.4, -0.86, zNose - 0.4, -0.84, zNose - 0.2, -0.6, zNose + 0.03], 0.03);
      b.setPart(PART.carbon);
      b.extrude(poly, { o: [0, 0.135, 0], u: [1, 0, 0], v: [0, 0, 1] }, 0.016, 0.004, 2);
    }
    // roof spoiler: a cambered blade overhanging the glass, with small raked end plates
    {
      const wing = 0.5 + 1.2 * s.wing;
      addWing(b, {
        halfSpan: 0.62,
        y: 1.262 * roofK,
        z: -1.9,
        chord: 0.26 * wing,
        thick: 0.14,
        camber: 0.05,
        incidence: -0.12,
        plate: { up: 0.055, down: 0.02, len: 0.26, part: PART.body, thickness: 0.012 },
        part: PART.body,
      });
    }
    // twin centre exhaust
    for (const x of [-0.16, 0.16]) {
      b.setPart(PART.titanium);
      b.cylinder([x, 0.33, zTail + 0.1], [x, 0.33, zTail - 0.06], 0.05, 0.054, 20, false);
      b.setPart(PART.plastic);
      b.cylinder([x, 0.33, zTail + 0.07], [x, 0.33, zTail + 0.06], 0.046, 0.046, 20, true);
    }
    addDiffuserStrakes(b, [-0.3, -0.18, 0.18, 0.3], 0.28, 0.42, zTail + 0.02, zTail + 0.3, 0.04);
    // mirrors: housing, stalk and glass face, set where the live mirror glass sits (carvis/mirrorLayout.ts)
    addDoorMirrors(b, s);
  };

  void tailPlaneZ;
  return {
    bounds: { min: [-hw - 0.15, 0.02, zTail - 0.2], max: [hw + 0.15, s.height + 0.12, zNose + 0.2] },
    body,
    zones,
    parts,
    info: { projector: [0.58, 0.655, projZ - 0.03, 0.03] },
  };
};
