/**
 * LMP-X — Le Mans prototype: closed canopy, sculpted fenders over exposed wheels, shark fin,
 * big rear wing, splitter and diffuser.
 */
import type { BlueprintFactory } from '../blueprint';
import { PART } from '../blueprint';
import { curve } from '../curve';
import { defaultLoft, sdLoft } from '../loft';
import type { PartBuilder } from '../parts';
import { dent, roundPoly, strip2 } from '../shapes';
import { sdCylinderX, sdEllipseRot2, sdEllipsoid, sdPolygon2, sdRoundBox, sdRoundRect2, smax, smin, ssub } from '../sdf';
import { addDiffuserStrakes, addWing, airfoilPoly } from '../aero';
import { frontZ, rearZ, topY } from './probe';

export const makePrototype: BlueprintFactory = (s) => {
  const zF = s.wheelbase / 2;
  const zR = -s.wheelbase / 2;
  const zNose = zF + s.frontOverhang;
  const zTail = -(s.wheelbase / 2 + (s.length - s.wheelbase - s.frontOverhang));
  const hw = s.width / 2;
  const hk = s.height / 1.05;
  const zero = curve([zTail - 1, 0, zNose + 1, 0]);

  // central tub / nose / engine cover
  const tub = defaultLoft(
    {
      yb: curve([zTail, 0.14, zTail + 0.4, 0.08, zTail + 0.9, 0.06, zNose - 0.5, 0.06, zNose - 0.1, 0.07, zNose, 0.12], 0.04),
      yt: curve(
        [
          zTail, 0.58 * hk, zTail + 0.3, 0.64 * hk, -1.5, 0.76 * hk, -1.0, 0.84 * hk, -0.5, 0.86 * hk, -0.1, 0.8 * hk, 0.3, 0.66 * hk, 0.9, 0.62 * hk, 1.3, 0.57 * hk, 1.7, 0.5 * hk, 2.05, 0.4 * hk, zNose - 0.2, 0.3 * hk, zNose, 0.2 * hk,
        ],
        0.06,
      ),
      w: curve([zTail, 0.34, zTail + 0.3, 0.48, -1.6, 0.58, -1.0, 0.63, -0.3, 0.62, 0.3, 0.55, 0.9, 0.46, 1.4, 0.4, 1.9, 0.34, zNose - 0.2, 0.26, zNose, 0.16], 0.06),
      crown: curve([zTail - 1, 0.05, zNose + 1, 0.05]),
      tum: curve([zTail - 1, 0.1, zNose + 1, 0.1]),
      bar: curve([zTail - 1, 0.04, zNose + 1, 0.04]),
      yw: 0.4,
      tumY: 0.3,
      rTop: 0.14,
      rBot: 0.05,
      rEnd: 0.16,
      zf: zNose,
      zr: zTail,
      kf: 0.28,
      kr: 0.1,
      yRef: 0.1,
    },
    zero,
  );

  const canopy = defaultLoft(
    {
      yb: curve([-3, 0.5, 3, 0.5]),
      yt: curve([-0.62, 0.78 * hk, -0.45, 0.93 * hk, -0.2, 1.02 * hk, 0.05, 1.05 * hk, 0.3, 1.02 * hk, 0.55, 0.96 * hk, 0.8, 0.9 * hk, 1.0, 0.85 * hk], 0.05),
      w: curve([-0.62, 0.34, -0.4, 0.46, -0.0, 0.53, 0.4, 0.5, 0.8, 0.44, 1.0, 0.4], 0.05),
      crown: curve([-1, 0.1, 2, 0.1]),
      tum: curve([-1, 0.2, 2, 0.2]),
      tumY: 0.62,
      rTop: 0.2,
      rBot: 0.1,
      rEnd: 0.12,
      zf: 1.38,
      zr: -0.62,
      kf: 1.05,
      kr: 0.5,
      yRef: 0.55,
    },
    zero,
  );

  const podX = 0.745;
  const frontPod = defaultLoft(
    {
      yb: curve([zF - 1.0, 0.12, zF + 1.0, 0.1], 0.04),
      yt: curve([zF - 0.95, 0.56 * hk, zF - 0.5, 0.7 * hk, zF - 0.05, 0.77 * hk, zF + 0.4, 0.72 * hk, zF + 0.75, 0.56 * hk, zF + 0.9, 0.42 * hk], 0.07),
      w: curve([zF - 1.0, 0.2, zF - 0.5, 0.235, zF + 0.3, 0.24, zF + 0.7, 0.215, zF + 0.9, 0.16], 0.05),
      crown: curve([zF - 1, 0.05, zF + 1, 0.05]),
      tum: curve([zF - 1, 0.03, zF + 1, 0.03]),
      bar: curve([zF - 1, 0.0, zF + 1, 0.0]),
      yw: 0.3,
      tumY: 0.4,
      rTop: 0.17,
      rBot: 0.06,
      rEnd: 0.2,
      zf: zF + 0.93,
      zr: zF - 0.98,
      kf: 0.35,
      kr: 0.1,
      yRef: 0.1,
    },
    zero,
  );
  const rearPod = defaultLoft(
    {
      yb: curve([zR - 1.0, 0.12, zR + 1.0, 0.1], 0.04),
      yt: curve([zR + 0.95, 0.6 * hk, zR + 0.5, 0.76 * hk, zR + 0.05, 0.88 * hk, zR - 0.45, 0.9 * hk, zR - 0.85, 0.82 * hk], 0.07),
      w: curve([zR + 1.0, 0.18, zR + 0.5, 0.235, zR - 0.4, 0.24, zR - 0.8, 0.2], 0.05),
      crown: curve([zR - 1, 0.05, zR + 1, 0.05]),
      tum: curve([zR - 1, 0.03, zR + 1, 0.03]),
      bar: curve([zR - 1, 0.0, zR + 1, 0.0]),
      yw: 0.3,
      tumY: 0.4,
      rTop: 0.17,
      rBot: 0.06,
      rEnd: 0.18,
      zf: zR + 0.98,
      zr: zTail - 0.1,
      kf: 0.3,
      kr: 0.2,
      yRef: 0.1,
    },
    zero,
  );

  const rF = s.wheelRadiusFront, rR = s.wheelRadiusRear;
  const archGap = 0.045;
  const wxF = s.trackFront / 2, wxR = s.trackRear / 2;

  const base = (ax: number, y: number, z: number): number => {
    let d = smin(sdLoft(tub, ax, y, z), sdLoft(canopy, ax, y, z), 0.12);
    // side pod between the wheels
    d = smin(d, sdRoundBox(ax - 0.62, y - 0.3, z - 0.05, 0.28, 0.21, 0.95, 0.12), 0.14);
    // front / rear fender pods: tapered lofts offset to the wheel line
    const px = ax > podX ? ax - podX : podX - ax;
    d = smin(d, sdLoft(frontPod, px, y, z), 0.12);
    d = smin(d, sdLoft(rearPod, px, y, z), 0.12);
    // clip to the overall length
    d = smax(d, z - zNose, 0.1);
    d = smax(d, zTail - z, 0.1);
    // exposed wheels: arch cut through the fender
    const cf = sdCylinderX(ax - 0.84, y - rF, z - zF, rF + archGap, 0.42, 0.03);
    const cr = sdCylinderX(ax - 0.84, y - rR, z - zR, rR + archGap, 0.42, 0.03);
    d = ssub(d, cf, 0.06);
    d = ssub(d, cr, 0.06);
    return d;
  };
  const baseF = (x: number, y: number, z: number): number => base(x < 0 ? -x : x, y, z);

  // lamp regions (front/rear projections)
  const zFender = frontZ(baseF, 0.74, 0.42);
  const headLamp = (ax: number, y: number, z: number): number => Math.max(sdRoundRect2(ax - 0.74, y - 0.43, 0.15, 0.06, 0.04), 2.0 - z);
  const drlStrip = (ax: number, y: number): Float64Array => strip2(ax - 0.74, y, 0, 0.5, 0, 0.14);
  const tailLamp = (ax: number, y: number, z: number): number => Math.max(sdRoundRect2(ax - 0.74, y - 0.62, 0.045, 0.19, 0.03), z - (zTail + 0.9));
  const stopStrip = (ax: number, y: number): Float64Array => strip2(ax, y, 0, 0.41, 0, 0.07);
  const projZ = zFender;

  const features = (d: number, ax: number, y: number, z: number): number => {
    // radiator duct slots on the front deck
    d = dent(d, Math.max(sdRoundRect2(ax - 0.62, z - 1.35, 0.1, 0.32, 0.05), 0.5 - y), 0.012, 0.05);
    return d;
  };

  const body = (x: number, y: number, z: number): number => {
    const ax = x < 0 ? -x : x;
    return features(base(ax, y, z), ax, y, z);
  };

  // canopy glass: windscreen + side glass within the canopy footprint
  const footprint = roundPoly([0.94, 0.4, 0.94, -0.4, -0.3, -0.52, -0.3, 0.52], 0.08);
  const pillarX = (z: number): number => 0.4 + 0.12 * Math.min(1, Math.max(0, (0.9 - z) / 0.9));

  const zones = (x: number, y: number, z: number, nx: number, ny: number, nz: number, out: Float32Array, o: number): void => {
    const ax = x < 0 ? -x : x;
    const pillar = Math.abs(ax - pillarX(z)) - 0.03;
    const spine = ax - 0.06;
    const sideGlass = Math.max(sdPolygon2(footprint, z, ax), 0.67 * hk - y, -pillar, z > 0.3 ? -1 : -spine, z < -0.25 ? 1 : -1);
    out[o] = sideGlass;
    // black: splitter area, floor, diffuser, arch interior
    const floor = y - 0.2;
    const diffuser = Math.max(y - 0.4, z - (zTail + 0.7));
    const arch = Math.min(sdCylinderX(ax - 0.84, y - rF, z - zF, rF + archGap, 0.42, 0.03), sdCylinderX(ax - 0.84, y - rR, z - zR, rR + archGap, 0.42, 0.03));
    const nose = Math.max(y - 0.26 * hk, z - 1.9);
    out[o + 1] = Math.min(Math.max(floor, ax - 0.2), diffuser, arch - 0.02, nose);
    out[o + 2] = 1;
    // air outlets / duct grilles
    const duct = Math.max(sdRoundRect2(ax - 0.62, z - 1.35, 0.11, 0.33, 0.05), 0.5 - y);
    const sideInlet = Math.max(sdRoundRect2(z + 0.15, y - 0.3, 0.5, 0.07, 0.05), 0.46 - ax);
    const engineVent = Math.max(sdRoundRect2(ax, z + 1.55, 0.3, 0.4, 0.08), 0.7 - y);
    out[o + 3] = Math.min(duct, sideInlet, engineVent);
    out[o + 4] = headLamp(ax, y, z);
    out[o + 6] = tailLamp(ax, y, z);
    out[o + 7] = 1;
    out[o + 8] = Math.max(sdRoundRect2(z + 0.0, y - 0.32, 0.7, 0.14, 0.05), 0.5 - ax);
    out[o + 9] = Math.max(sdRoundRect2(ax - 0.0, z - 1.5, 0.45, 0.8, 0.1), 0.45 - y);
    out[o + 10] = Math.max(sdRoundRect2(ax, z + 1.7, 0.4, 0.5, 0.08), 0.65 - y);
    out[o + 11] = 1;
    // thin LED strips: the DRL (front) and the brake bar (rear) share one signed-offset + extent pair
    if (z > 0) {
      const sd = drlStrip(ax, y);
      out[o + 5] = sd[0];
      out[o + 15] = Math.max(sd[1], 2.0 - z, 0.45 - nz);
    } else {
      const ss = stopStrip(ax, y);
      out[o + 5] = ss[0];
      out[o + 15] = Math.max(ss[1], z - (zTail + 0.9), 0.45 + nz);
    }
    out[o + 14] = 1;
  };

  const parts = (b: PartBuilder): void => {
    // front splitter + canard dive planes
    {
      const poly = roundPoly([0.0, zNose + 0.14, 0.5, zNose + 0.1, 0.86, zNose - 0.2, 0.97, zNose - 0.45, 0.97, zNose - 0.95, -0.97, zNose - 0.95, -0.97, zNose - 0.45, -0.86, zNose - 0.2, -0.5, zNose + 0.1], 0.03);
      b.setPart(PART.carbon);
      b.extrude(poly, { o: [0, 0.075, 0], u: [1, 0, 0], v: [0, 0, 1] }, 0.016, 0.004, 2);
      for (const sg of [-1, 1]) {
        const dp = roundPoly([0.0, 0.18, 0.0, -0.1, 0.1, -0.14, 0.12, 0.12], 0.015);
        b.extrude(dp.map((v, i) => (i % 2 === 0 ? v : v)), { o: [sg * 0.55, 0.16, zNose - 0.36], u: [0, 0, 1], v: [1, 0, 0] }, 0.012, 0.003, 2);
        // end plates
        b.box([sg * 0.97, 0.12, zNose - 0.58], 0.008, 0.045, 0.38);
      }
    }
    // rear wing: two-element plane on a central pylon, with big louvred end plates
    {
      const zW = zTail + 0.3;
      const yW = 0.9 * hk;
      addWing(b, {
        halfSpan: 0.92,
        y: yW,
        z: zW,
        chord: 0.4,
        thick: 0.085,
        camber: 0.1,
        incidence: 0.12,
        flap: { chord: 0.24, dz: -0.17, dy: 0.1, incidence: 0.42, thick: 0.07, camber: 0.1 },
        plate: { up: 0.2, down: 0.12, len: 0.62, part: PART.body },
        pylons: [{ x: 0, bottomY: 0.64 * hk, bottomZ: zW + 0.02, width: 0.06 }],
      });
      // beam wing under the main plane
      b.setPart(PART.carbon);
      b.extrude(airfoilPoly(0.16, 0.06, 0.05, 0.05, 12), { o: [0.56, 0.7 * hk, zTail + 0.05], u: [0, 0, 1], v: [0, 1, 0] }, 1.12, 0.003, 1);
    }
    // shark fin
    {
      const fin = roundPoly([-0.45, 0.0, -1.2, 0.0, -1.95, 0.0, -1.95, 0.22, -1.2, 0.3, -0.6, 0.22], 0.03);
      b.setPart(PART.body);
      b.extrude(fin, { o: [0.015, 0.0, 0.0], u: [0, 0, 1], v: [0, 1, 0] }, -0.03, 0.004, 2);
    }
    // diffuser strakes + twin exhaust
    {
      addDiffuserStrakes(b, [-0.42, -0.28, -0.14, 0, 0.14, 0.28, 0.42], 0.1, 0.34, zTail + 0.03, zTail + 0.52, 0.06);
      b.setPart(PART.carbon);
      b.box([0, 0.355, zTail + 0.28], 0.5, 0.007, 0.26);
      for (const x of [-0.1, 0.1]) {
        b.setPart(PART.titanium);
        b.cylinder([x, 0.52, zTail + 0.08], [x, 0.52, zTail - 0.04], 0.04, 0.043, 20, false);
        b.setPart(PART.plastic);
        b.cylinder([x, 0.52, zTail + 0.06], [x, 0.52, zTail + 0.05], 0.036, 0.036, 20, true);
      }
    }
    // mirrors on stalks off the fenders
    for (const sg of [-1, 1]) {
      b.setPart(PART.carbon);
      b.ellipsoid([sg * 0.74, 0.96 * hk, 0.62], 0.065, 0.04, 0.09, 16, 10);
      b.setPart(PART.plastic);
      b.cylinder([sg * 0.62, 0.84 * hk, 0.58], [sg * 0.72, 0.94 * hk, 0.62], 0.011, 0.014, 8, false);
    }
    // roof scoop (air box)
    {
      b.setPart(PART.carbon);
      b.ellipsoid([0, 1.045 * hk, -0.1], 0.13, 0.05, 0.28, 18, 10);
    }
  };

  void topY;
  void rearZ;
  void sdEllipsoid;
  void sdEllipseRot2;
  void wxF;
  void wxR;
  void dent;
  return {
    bounds: { min: [-hw - 0.2, 0.02, zTail - 0.2], max: [hw + 0.2, s.height + 0.12, zNose + 0.3] },
    body,
    zones,
    parts,
    info: { projector: [0.7, 0.43, projZ - 0.04, 0.03] },
    debug: {
      tub: (x, y, z) => sdLoft(tub, Math.abs(x), y, z),
      canopy: (x, y, z) => sdLoft(canopy, Math.abs(x), y, z),
      base: baseF,
    },
  };
};
