/**
 * Mammoth — a 4x4 built like a bunker: a G-Wagen's ruler-straight slab sides, flat glass and square shoulders, with a Ram TRX's
 * attitude on top (a tall black grille with heavy bars, a hood that sits between raised fenders, huge squared arches under bolted
 * flares, a bumper made of steel and a light bar on the roof).
 *
 * Where the other bodies are lofted swoops this one is mostly boxes: every panel is a plane, and what makes it read as a truck
 * and not a crate is the radii (3-6 cm, tight enough to catch a highlight and big enough for a 2.7 cm mesh to hold), the stance
 * (a 4.9 m box on 85 cm tyres) and the parts bolted on top (see suvParts.ts: flares, steps, snorkel, rack, tow hooks, the spare).
 */
import type { BlueprintFactory } from '../blueprint';
import { curve } from '../curve';
import { defaultLoft, sdFootprint, sdLoft } from '../loft';
import type { PartBuilder } from '../parts';
import { dent, roundPoly, strip2 } from '../shapes';
import { sdCircle2, sdPolygon2, sdRoundBox, sdRoundRect2, sdSegment2, smax, smin, ssub } from '../sdf';
import { frontZ } from './probe';
import { addSuvParts, type SuvDims } from './suvParts';

export const makeSuv: BlueprintFactory = (s) => {
  const zF = s.wheelbase / 2;
  const zR = -s.wheelbase / 2;
  const zNose = zF + s.frontOverhang;
  const zTail = -(s.wheelbase / 2 + (s.length - s.wheelbase - s.frontOverhang));
  const hw = s.width / 2;
  const rF = s.wheelRadiusFront, rR = s.wheelRadiusRear;

  // ── the box ───────────────────────────────────────────────────────────────
  /** door skin (half width): the flares stand 7 cm proud of it and carry the tyres' outer faces under them */
  const slab = hw - 0.05;
  const yBot = s.rideHeight + 0.012;
  const yRoof = s.height;
  /** hood height, and the fender tops that stand a little above it */
  const yHood = 1.32;
  const yFend = 1.37;
  /** the tailgate plane: the spare wheel's thickness ahead of the tail, so tyre and bumper end together */
  const zTg = zTail + 0.335;
  /** the upper fascia (grille, lamps) sits behind the bumper face */
  const zFas = zNose - 0.075;
  /** the windscreen: an almost-upright plane (28 degrees off vertical) from the cowl to the header */
  const zWsBase = 0.7;
  const zWsTop = 0.45;
  const kWs = (zWsBase - zWsTop) / (yRoof - yFend);
  const zero = curve([zTail, 0, zNose, 0]);

  const tub = defaultLoft(
    {
      yb: curve([zTail, yBot, zNose, yBot + 0.02], 0.04),
      yt: curve([zTail, yFend, zNose, yFend], 0.05),
      w: curve([zTail, slab, zNose, slab], 0.05),
      crown: curve([zTail, 0.006, zNose, 0.006]),
      tum: zero,
      bar: curve([zTail, 0.02, zNose, 0.02]),
      yw: 0.62,
      tumY: 1.0,
      rTop: 0.035,
      rBot: 0.05,
      rEnd: 0.05,
      zf: zFas,
      zr: zTg,
      kf: 0,
      kr: 0,
      yRef: 0.8,
    },
    zero,
  );

  const cabin = defaultLoft(
    {
      yb: curve([-3, 1.2, 3, 1.2]),
      yt: curve([-3, yRoof, 3, yRoof]),
      w: curve([-3, slab - 0.02, 3, slab - 0.02]),
      crown: curve([-3, 0.014, 3, 0.014]),
      tum: curve([-3, 0.04, 3, 0.04]),
      tumY: 1.38,
      rTop: 0.07,
      rBot: 0.1,
      rEnd: 0.06,
      zf: zWsBase,
      zr: zTg,
      kf: kWs,
      kr: 0,
      yRef: yFend,
    },
    zero,
  );

  // ── arches: big squared openings, a hand taller than the tyre so the long-travel suspension has somewhere to go ──
  const archHz = (R: number): number => R + 0.085;
  const archTop = (R: number): number => 2 * R + 0.115;
  const archCut = (ax: number, y: number, z: number, zc: number, R: number): number => sdRoundBox(ax - 0.95, y - (archTop(R) - 1.0), z - zc, 0.4, 1.0, archHz(R), 0.2);

  /** a plan-view rounded rectangle (centre zc, half length hz, half width hx, corner radius r) between two heights, edges rounded by re */
  const slabBox = (ax: number, y: number, z: number, zc: number, hz: number, hx: number, yc: number, hy: number, r: number, re: number): number => {
    const plan = sdRoundRect2(ax, z - zc, hx, hz, r);
    const vert = Math.abs(y - yc) - hy;
    return smax(plan, vert, re);
  };

  const base = (ax: number, y: number, z: number): number => {
    let d = smin(sdLoft(tub, ax, y, z), sdLoft(cabin, ax, y, z), 0.02);
    // the hood sits between the fenders: a 4.5 cm step the length of the engine bay
    d = ssub(d, sdRoundBox(ax, y - (yHood + 0.4), z - (zWsBase + 0.04 + (zNose + 0.3 - zWsBase - 0.04) / 2), 0.67, 0.4, (zNose + 0.3 - zWsBase - 0.04) / 2, 0.02), 0.012);
    // steel bumpers, proud of the fascia
    d = smin(d, slabBox(ax, y, z, zNose - 0.2, 0.2, slab, 0.585, 0.175, 0.14, 0.06), 0.03);
    d = smin(d, slabBox(ax, y, z, zTail + 0.2, 0.2, slab, 0.55, 0.19, 0.12, 0.05), 0.03);
    // a power dome down the middle of the hood
    d = smin(d, sdRoundBox(ax, y - (yHood + 0.018), z - 1.55, 0.3, 0.03, 0.58, 0.03), 0.04);
    d = ssub(d, archCut(ax, y, z, zF, rF), 0.05);
    d = ssub(d, archCut(ax, y, z, zR, rR), 0.05);
    return d;
  };
  const baseF = (x: number, y: number, z: number): number => base(x < 0 ? -x : x, y, z);

  // ── anchors on the surface ────────────────────────────────────────────────
  const lampX = 0.775;
  const lampY = 1.12;
  const projZ = frontZ(baseF, lampX, lampY);
  const grilleHx = 0.6;
  const grilleY = 1.03;
  const grilleHy = 0.19;

  // (an eyelid of body paint cuts the top inner part of each lamp: a squint that lowers towards the grille)
  const lid = (ax: number, y: number): number => (y - (lampY + 0.058 - 0.36 * (lampX - ax))) * 0.94;
  const headLamp = (ax: number, y: number, z: number): number => Math.max(sdCircle2(ax - lampX, y - lampY, 0.112), lid(ax, y), zFas - 0.2 - z);
  const tailLamp = (ax: number, y: number, z: number): number => Math.max(sdRoundRect2(ax - 0.87, y - 1.12, 0.065, 0.24, 0.025), z - (zTg + 0.1));

  const features = (d: number, ax: number, y: number, z: number): number => {
    // the grille: a deep black pocket the bars sit in
    d = ssub(d, sdRoundBox(ax, y - grilleY, z - zFas, grilleHx, grilleHy, 0.1, 0.03), 0.02);
    // a louvred vent in each front wing, behind the flare
    d = ssub(d, sdRoundBox(ax - (slab + 0.02), y - 1.09, z - 0.77, 0.06, 0.11, 0.07, 0.02), 0.01);
    // two air intakes in the bumper face, either side of the winch
    d = ssub(d, sdRoundBox(ax - 0.36, y - 0.5, z - zNose, 0.18, 0.04, 0.05, 0.02), 0.01);
    // the body-side groove: one crisp horizontal line the length of the doors
    d = dent(d, Math.max(Math.abs(y - 0.93) - 0.014, 0.7 - ax), 0.008, 0.012);
    // door handles
    d = dent(d, Math.max(sdSegment2(z, y, -0.2, 1.1, -0.04, 1.1) - 0.028, 0.7 - ax), 0.01, 0.03);
    d = dent(d, Math.max(sdSegment2(z, y, -0.8, 1.1, -0.64, 1.1) - 0.028, 0.7 - ax), 0.01, 0.03);
    return d;
  };

  const body = (x: number, y: number, z: number): number => {
    const ax = x < 0 ? -x : x;
    return features(base(ax, y, z), ax, y, z);
  };

  // ── glass ───────────────────────────────────────────────────────────────────
  const yGlass0 = 1.405;
  const yGlass1 = yRoof - 0.1;
  const frontDoorWin = roundPoly([0.6, yGlass0, 0.44, yGlass1, -0.24, yGlass1, -0.24, yGlass0], 0.03);
  const rearDoorWin = roundPoly([-0.36, yGlass0, -0.36, yGlass1, -1.18, yGlass1, -1.18, yGlass0], 0.03);
  const quarterWin = roundPoly([-1.3, yGlass0, -1.3, yGlass1, -2.04, yGlass1, -2.04, yGlass0], 0.03);
  const windscreen = roundPoly([-0.1, 1.4, 0.84, 1.4, 0.8, yRoof - 0.085, -0.1, yRoof - 0.085], 0.05);
  const rearGlass = roundPoly([-0.1, 1.5, 0.74, 1.5, 0.72, yRoof - 0.1, -0.1, yRoof - 0.1], 0.05);

  const zones = (x: number, y: number, z: number, nx: number, ny: number, nz: number, out: Float32Array, o: number): void => {
    const ax = x < 0 ? -x : x;
    // windows
    const w1 = Math.max(sdPolygon2(frontDoorWin, z, y), 0.5 - ax);
    const w2 = Math.max(sdPolygon2(rearDoorWin, z, y), 0.5 - ax);
    const w3 = Math.max(sdPolygon2(quarterWin, z, y), 0.5 - ax);
    const ws = Math.max(sdPolygon2(windscreen, ax, y), 0.25 - z);
    const rg = Math.max(sdPolygon2(rearGlass, ax, y), z - (zTg + 0.12));
    out[o] = Math.min(w1, w2, w3, ws, rg);
    // black plastic: lower cladding, both bumpers, arch interiors, pillars, the cowl
    const sill = Math.max(y - 0.5, 0.6 - ax);
    const bumperF = Math.max(y - 0.9, zFas - 0.012 - z);
    const bumperR = Math.max(y - 0.74, z - (zTg + 0.012));
    const arch = Math.min(archCut(ax, y, z, zF, rF), archCut(ax, y, z, zR, rR));
    const pillarB = Math.max(Math.abs(z + 0.3) - 0.06, 0.5 - ax, y - (yRoof - 0.06), 1.3 - y);
    const cowl = Math.max(Math.abs(z - 0.74) - 0.05, ax - 0.8, 1.27 - y, y - 1.4);
    out[o + 1] = Math.min(sill, bumperF, bumperR, arch - 0.02, pillarB, cowl);
    out[o + 2] = 1;
    // grilles: the radiator pocket, a bumper intake
    const grille = sdRoundBox(ax, y - grilleY, z - (zFas - 0.005), grilleHx + 0.005, grilleHy + 0.005, 0.1, 0.03);
    // (and the dome's air intake: a black band across its front face)
    const intake = Math.max(sdRoundRect2(ax, y - (yHood + 0.026), 0.22, 0.022, 0.01), 2.0 - z);
    const bumperVent = Math.max(sdRoundRect2(ax - 0.36, y - 0.5, 0.185, 0.045, 0.022), zNose - 0.06 - z);
    const wingVent = Math.max(sdRoundRect2(z - 0.77, y - 1.09, 0.07, 0.115, 0.02), 0.9 - ax);
    out[o + 3] = Math.min(grille, intake, bumperVent, wingVent);
    out[o + 4] = headLamp(ax, y, z);
    out[o + 6] = tailLamp(ax, y, z);
    out[o + 7] = Math.max(sdRoundRect2(ax - 0.74, y - 0.56, 0.06, 0.03, 0.012), z - (zTail + 0.06));
    // shut lines: the two doors, the bonnet, the tailgate
    out[o + 8] = Math.max(sdRoundRect2(z - 0.155, y - 1.1, 0.445, 0.7, 0.05), 0.55 - ax);
    out[o + 9] = Math.max(sdRoundRect2(z + 0.745, y - 1.1, 0.455, 0.7, 0.05), 0.55 - ax);
    out[o + 10] = Math.max(sdRoundRect2(ax, z - 1.5, 0.68, 0.76, 0.04), 1.27 - y);
    out[o + 11] = Math.max(sdRoundRect2(ax, y - 1.1, 0.94, 0.7, 0.04), z - (zTg + 0.06));
    // thin LED strips: the DRL halo ring round each lens (front), a vertical brake line in the tail lamp (rear)
    if (z > 0) {
      out[o + 5] = Math.hypot(ax - lampX, y - lampY) - 0.128;
      out[o + 15] = Math.max(zFas - 0.2 - z, 0.45 - nz, lid(ax, y) + 0.004);
    } else {
      const ss = strip2(ax, y, 0.87, 1.12, Math.PI / 2, 0.2);
      out[o + 5] = ss[0];
      out[o + 15] = Math.max(ss[1], z - (zTg + 0.1), 0.45 + nz);
    }
    out[o + 14] = 1;
  };

  const dims: SuvDims = { zF, zR, zNose, zTail, zTg, zFas, hw, slab, yRoof, yHood, yFend, rF, rR, archHz, archTop, lampX, lampY, zWsBase, zWsTop, kWs, grilleY, grilleHy, grilleHx };
  const parts = (b: PartBuilder): void => addSuvParts(b, s, dims);

  void smax;
  void rR;
  return {
    bounds: { min: [-hw - 0.15, 0.02, zTail - 0.2], max: [hw + 0.15, s.height + 0.2, zNose + 0.2] },
    body,
    zones,
    parts,
    info: { projector: [lampX, lampY, projZ - 0.03, 0.05] },
    debug: { base: baseF, foot: (x, _y, z) => sdFootprint(Math.abs(x), z, slab, zNose, zTail, 0.14, 0.1) },
  };
};
