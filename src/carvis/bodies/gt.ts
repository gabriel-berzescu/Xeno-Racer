/**
 * Vanta GT — front-mid-engined grand tourer. Long hood, set-back cabin, fastback, muscular haunches.
 */
import type { BlueprintFactory } from '../blueprint';
import { PART } from '../blueprint';
import { curve } from '../curve';
import { defaultLoft, sdFootprint, sdLoft } from '../loft';
import type { PartBuilder } from '../parts';
import { dent, roundPoly, strip2 } from '../shapes';
import { sdCylinderX, sdEllipseRot2, sdEllipsoid, sdPolygon2, sdRoundBox, sdRoundRect2, sdSegment2, smax, smin, smoothstep, ssub } from '../sdf';
import { addDiffuserStrakes } from '../aero';
import { frontZ, rearZ, sdBlade, sideX, topY } from './probe';

export const makeGT: BlueprintFactory = (s) => {
  const zF = s.wheelbase / 2;
  const zR = -s.wheelbase / 2;
  const zNose = zF + s.frontOverhang;
  const zTail = -(s.wheelbase / 2 + (s.length - s.wheelbase - s.frontOverhang));
  const hw = s.width / 2;
  const roofK = s.height / 1.22;
  const zero = curve([zTail, 0, zNose, 0]);

  const lower = defaultLoft(
    {
      yb: curve([zTail, 0.24, zTail + 0.5, 0.16, zTail + 0.9, 0.12, zNose - 0.45, 0.12, zNose - 0.12, 0.13, zNose, 0.2], 0.04),
      yt: curve(
        [
          zTail, 0.985, zTail + 0.1, 0.99, zTail + 0.26, 0.975, zTail + 0.45, 0.968, zR - 0.5, 0.98, zR, 0.975, -0.9, 0.935, -0.3, 0.9, 0.2, 0.895, 0.45, 0.89, 1.0, 0.855, zF, 0.79, zF + 0.35, 0.735, zNose - 0.3, 0.685, zNose - 0.1, 0.62, zNose, 0.5,
        ],
        0.05,
      ),
      w: curve(
        [
          zTail, 0.72, zTail + 0.1, 0.83, zTail + 0.28, 0.905, zTail + 0.55, 0.955, zR - 0.2, 0.98, zR, 0.985, zR + 0.4, 0.975, -0.6, 0.955, 0, 0.95, zF - 0.6, 0.965, zF, 0.985, zNose - 0.6, 0.955, zNose - 0.4, 0.915, zNose - 0.22, 0.83, zNose - 0.07, 0.64, zNose, 0.42,
        ],
        0.05,
      ),
      crown: curve([zTail, 0.035, zNose, 0.045]),
      tum: curve([zTail, 0.06, zNose, 0.06]),
      bar: curve([zTail, 0.09, zNose, 0.09]),
      yw: 0.58,
      tumY: 0.45,
      rTop: 0.105,
      rBot: 0.06,
      rEnd: 0.12,
      zf: zNose,
      zr: zTail,
      kf: 0.35,
      kr: 0.12,
      yRef: 0.2,
    },
    zero,
  );

  const cabin = defaultLoft(
    {
      yb: curve([-3, 0.8, 3, 0.8]),
      yt: curve(
        [-2.0, 0.97, -1.9, 1.0 * roofK, -1.6, 1.045 * roofK, -1.3, 1.105 * roofK, -1.0, 1.185 * roofK, -0.7, 1.222 * roofK, -0.4, 1.222 * roofK, -0.1, 1.212 * roofK, 0.4, 1.2 * roofK, 1.2, 1.19 * roofK],
        0.04,
      ),
      w: curve([-1.95, 0.7, -1.6, 0.84, -1.2, 0.88, -0.6, 0.89, 0, 0.885, 0.3, 0.86, 0.55, 0.8, 0.8, 0.7], 0.05),
      crown: curve([-2, 0.05, 1, 0.05]),
      tum: curve([-2, 0.26, 1, 0.26]),
      tumY: 0.9,
      rTop: 0.2,
      rBot: 0.1,
      rEnd: 0.12,
      zf: 0.45,
      zr: -3,
      kf: 1.78,
      kr: 0,
      yRef: 0.88,
    },
    zero,
  );

  const rF = s.wheelRadiusFront, rR = s.wheelRadiusRear;
  const archGap = 0.04;
  const footW = hw + 0.02;

  // massing + arches + ducktail (no dents/pockets yet: used for anchoring features on the surface)
  const base = (ax: number, y: number, z: number): number => {
    let d = smin(sdLoft(lower, ax, y, z), sdLoft(cabin, ax, y, z), 0.14);
    d = smin(d, sdEllipsoid(ax - 0.78, y - 0.74, z - (zR - 0.05), 0.24, 0.26, 0.85), 0.2);
    // front fender volume: carries the shoulder over the tyre so the wheel never pokes out of the arch
    d = smin(d, sdEllipsoid(ax - 0.79, y - 0.6, z - (zF + 0.04), 0.2, 0.22, 0.58), 0.16);
    // character line: a raised band along the flank that climbs towards the rear haunch
    const yl = 0.73 - 0.06 * (z / 1.3);
    const band = smoothstep(yl - 0.035, yl + 0.035, y) * smoothstep(yl + 0.17, yl + 0.09, y) * smoothstep(0.66, 0.82, ax) * smoothstep(2.0, 1.5, z < 0 ? -z : z);
    d -= 0.011 * band;
    d = smax(d, sdFootprint(ax, z, footW, zNose, zTail, 0.5, 0.36), 0.09);
    const cf = sdCylinderX(ax - 0.98, y - rF, z - zF, rF + archGap, 0.42, 0.02);
    const cr = sdCylinderX(ax - 0.98, y - rR, z - zR, rR + archGap, 0.42, 0.02);
    d = ssub(d, cf, 0.07);
    d = ssub(d, cr, 0.07);
    return d;
  };
  const baseF = (x: number, y: number, z: number): number => base(x < 0 ? -x : x, y, z);

  // ── anchors on the surface ────────────────────────────────────────────────
  const zMouth = frontZ(baseF, 0, 0.3);
  // lamps are 2-D regions in the front/rear projection (independent of depth so the recess stays clean)
  const headLamp = (ax: number, y: number, z: number): number => Math.max(sdEllipseRot2(ax, y, 0.67, 0.648, 0.25, 0.04, 0.3), 1.86 - z);
  const drlStrip = (ax: number, y: number, _z: number): Float64Array => strip2(ax, y, 0.66, 0.672, 0.3, 0.19);
  const tailLamp = (ax: number, y: number, z: number): number => Math.max(sdEllipseRot2(ax, y, 0.52, 0.842, 0.31, 0.03, 0.07), z - (zTail + 0.5));
  const stopStrip = (ax: number, y: number): Float64Array => strip2(ax, y, 0, 0.832, 0, 0.2);
  const projZ = frontZ(baseF, 0.58, 0.635);
  const tailY = 0.835;
  const zSideIntake = frontZ(baseF, 0.8, 0.26) - 0.03;

  // fender gill (behind the front wheel)
  const gillZ = zF - 0.46;
  const gillX = sideX(baseF, 0.6, gillZ);

  const features = (d: number, ax: number, y: number, z: number): number => {
    // lower grille pocket
    d = ssub(d, sdRoundBox(ax, y - 0.3, z - (zMouth - 0.02), 0.44, 0.08, 0.14, 0.06), 0.02);
    // small side intakes at the lower corners
    d = ssub(d, sdRoundBox(ax - 0.8, y - 0.26, z - zSideIntake, 0.1, 0.055, 0.1, 0.035), 0.035);
    // lamp recesses
    // door handle recess
    d = dent(d, Math.max(sdSegment2(z, y, -0.5, 0.76, -0.3, 0.76) - 0.03, 0.7 - ax), 0.008, 0.04);
    // rear diffuser tunnel
    d = ssub(d, sdRoundBox(ax, y - 0.325, z - (zTail - 0.02), 0.38, 0.075, 0.3, 0.05), 0.04);
    // front fender gill
    d = ssub(d, sdRoundBox(ax - (gillX + 0.01), y - 0.6, z - gillZ, 0.1, 0.075, 0.13, 0.03), 0.03);
    // hood vents
    d = dent(d, Math.max(sdRoundRect2(ax - 0.5, z - 1.35, 0.075, 0.28, 0.04), 0.7 - y), 0.01, 0.045);
    return d;
  };

  const body = (x: number, y: number, z: number): number => {
    const ax = x < 0 ? -x : x;
    return features(base(ax, y, z), ax, y, z);
  };

  // ── zone outlines ─────────────────────────────────────────────────────────
  const doorWin = roundPoly([0.38, 0.93, -0.1, 1.13, -0.55, 1.175, -0.95, 1.14, -0.97, 0.935], 0.03);
  const quarterWin = roundPoly([-1.03, 0.945, -1.03, 1.135, -1.35, 1.06, -1.62, 0.99, -1.62, 0.965], 0.025);
  const windshield = roundPoly([0.45, 0.7, 0.45, -0.7, -0.09, -0.56, -0.09, 0.56], 0.06);
  const rearGlass = roundPoly([-1.1, 0.56, -1.1, -0.56, -1.78, -0.5, -1.78, 0.5], 0.06);

  const zones = (x: number, y: number, z: number, nx: number, ny: number, nz: number, out: Float32Array, o: number): void => {
    const ax = x < 0 ? -x : x;
    // windows
    const sw = Math.max(sdPolygon2(doorWin, z, y), 0.42 - ax);
    const qw = Math.max(sdPolygon2(quarterWin, z, y), 0.42 - ax);
    const ws = Math.max(sdPolygon2(windshield, z, ax), 0.7 - y);
    const rg = Math.max(sdPolygon2(rearGlass, z, ax), 0.7 - y);
    out[o] = Math.min(sw, qw, ws, rg);
    // trim: sills, splitter, diffuser, arch interiors, cowl strip
    const sill = Math.max(y - 0.22, 0.62 - ax, Math.abs(z) - 0.95);
    const splitter = Math.max(y - 0.17, z - (zNose - 0.45));
    const diffuser = Math.max(y - 0.46, z - (zTail + 0.55));
    const arch = Math.min(sdCylinderX(ax - 0.98, y - rF, z - zF, rF + archGap, 0.42, 0.02), sdCylinderX(ax - 0.98, y - rR, z - zR, rR + archGap, 0.42, 0.02));
    const cowl = Math.max(Math.abs(z - 0.49) - 0.02, ax - 0.74, 0.86 - y, y - 1.0);
    out[o + 1] = Math.min(sill, splitter, diffuser, arch - 0.02, cowl);
    // carbon roof insert
    out[o + 2] = Math.max(Math.abs(z + 0.65) - 0.42, ax - 0.5, 1.17 - y);
    // grille / vents
    const mouth = sdRoundBox(ax, y - 0.3, z - (zMouth - 0.02), 0.45, 0.09, 0.15, 0.06) - 0.005;
    const sideIntake = sdRoundBox(ax - 0.8, y - 0.26, z - zSideIntake, 0.11, 0.065, 0.11, 0.035) - 0.005;
    const gill = sdRoundBox(ax - (gillX + 0.01), y - 0.6, z - gillZ, 0.11, 0.085, 0.14, 0.03) - 0.004;
    const hoodVent = Math.max(sdRoundRect2(ax - 0.5, z - 1.35, 0.075, 0.28, 0.04), 0.7 - y);
    const tunnel = sdRoundBox(ax, y - 0.325, z - (zTail - 0.02), 0.39, 0.085, 0.31, 0.05) - 0.004;
    out[o + 3] = Math.min(mouth, sideIntake, gill, hoodVent, tunnel);
    // lamps
    out[o + 4] = headLamp(ax, y, z);
    out[o + 6] = tailLamp(ax, y, z);
    out[o + 7] = Math.max(sdRoundRect2(ax, y - 0.5, 0.075, 0.03, 0.01), z - (zTail + 0.9), -(z - (zTail - 0.1)));
    // panel lines
    out[o + 8] = Math.max(sdRoundRect2(z + 0.08, y - 0.63, 0.55, 0.4, 0.06), 0.55 - ax);
    out[o + 9] = Math.max(sdRoundRect2(ax, z - 1.3, 0.8, 0.82, 0.1), 0.55 - y);
    out[o + 10] = Math.max(sdRoundRect2(ax, z + 2.0, 0.78, 0.2, 0.06), 0.85 - y);
    out[o + 11] = 1;
    // brake-only lamp bar
    // thin LED strips: the DRL (front) and the brake bar (rear) share one signed-offset + extent pair
    if (z > 0) {
      const sd = drlStrip(ax, y, z);
      out[o + 5] = sd[0];
      out[o + 15] = Math.max(sd[1], 1.86 - z, 0.45 - nz);
    } else {
      const ss = stopStrip(ax, y);
      out[o + 5] = ss[0];
      out[o + 15] = Math.max(ss[1], z - (zTail + 0.5), 0.45 + nz);
    }
    out[o + 14] = 1;
  };

  const parts = (b: PartBuilder): void => {
    // front splitter: carbon plate
    {
      const poly = roundPoly([0.0, zNose + 0.05, 0.62, zNose + 0.03, 0.9, zNose - 0.22, 0.93, zNose - 0.42, -0.93, zNose - 0.42, -0.9, zNose - 0.22, -0.62, zNose + 0.03], 0.03);
      b.setPart(PART.carbon);
      b.extrude(poly, { o: [0, 0.128, 0], u: [1, 0, 0], v: [0, 0, 1] }, 0.018, 0.004, 2);
    }
    // rear diffuser strakes inside the tunnel
    addDiffuserStrakes(b, [-0.28, -0.14, 0, 0.14, 0.28], 0.26, 0.4, zTail + 0.02, zTail + 0.34, 0.05);
    // quad exhaust: two each side of the tunnel
    for (const x of [-0.64, -0.5, 0.5, 0.64]) {
      b.setPart(PART.titanium);
      b.cylinder([x, 0.33, zTail + 0.12], [x, 0.33, zTail - 0.045], 0.044, 0.048, 20, false);
      b.setPart(PART.plastic);
      b.cylinder([x, 0.33, zTail + 0.09], [x, 0.33, zTail + 0.08], 0.041, 0.041, 20, true);
    }
    // mirrors
    for (const sg of [-1, 1]) {
      b.setPart(PART.body);
      b.ellipsoid([sg * 0.98, 0.99, 0.3], 0.085, 0.052, 0.12, 20, 12);
      b.setPart(PART.carbon);
      b.ellipsoid([sg * 1.0, 0.99, 0.28], 0.075, 0.045, 0.098, 20, 12);
      b.setPart(PART.plastic);
      b.cylinder([sg * 0.8, 0.93, 0.32], [sg * 0.95, 0.975, 0.3], 0.014, 0.018, 8, false);
    }
  };

  return {
    bounds: { min: [-hw - 0.15, 0.02, zTail - 0.2], max: [hw + 0.15, s.height + 0.1, zNose + 0.2] },
    body,
    zones,
    parts,
    info: { projector: [0.58, 0.635, projZ - 0.03, 0.028] },
    debug: {
      lower: (x, y, z) => sdLoft(lower, Math.abs(x), y, z),
      cabin: (x, y, z) => sdLoft(cabin, Math.abs(x), y, z),
      haunch: (x, y, z) => sdEllipsoid(Math.abs(x) - 0.78, y - 0.74, z - (zR - 0.05), 0.24, 0.26, 0.85),
      fender: (x, y, z) => sdEllipsoid(Math.abs(x) - 0.79, y - 0.6, z - (zF + 0.04), 0.2, 0.22, 0.58),
      foot: (x, y, z) => sdFootprint(Math.abs(x), z, footW, zNose, zTail, 0.5, 0.36),
      base: baseF,
    },
  };
};
