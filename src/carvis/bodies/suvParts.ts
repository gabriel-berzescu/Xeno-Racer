/**
 * The Mammoth's bolt-ons, built with the PartBuilder: everything that must stay rigid in a crash and that a 2.7 cm SDF mesh could not
 * carve crisply (fender flares with their bolts, rock sliders, skid plates, tow hooks, the snorkel, the light bar, the rack, the
 * spare wheel, the side-exit pipes, the grille bars). Pure numeric / worker-safe.
 *
 * Frames used by `extrude` (polygon (a, b) in the plane, pushed along w = u x v):
 *   plan plate  u = +x, v = +z -> w = -y (a plate seen from above, thickness grows downward from `o`)
 *   side plate  u = +z, v = +y -> w = -x (a plate on a flank: `o.x` is its OUTER face on the left side)
 *   face plate  u = +x, v = +y -> w = +z (a plate on a nose or tail, pushed forward)
 */
import type { CarVisualSpec } from '../../core/contracts';
import { PART } from '../blueprint';
import { addDoorMirrors } from '../mirrorParts';
import type { PartBuilder, V3 } from '../parts';
import { roundPoly } from '../shapes';

/** Numbers the body (suv.ts) and its parts share. */
export interface SuvDims {
  zF: number;
  zR: number;
  zNose: number;
  zTail: number;
  zTg: number;
  zFas: number;
  hw: number;
  slab: number;
  yRoof: number;
  yHood: number;
  yFend: number;
  rF: number;
  rR: number;
  archHz: (R: number) => number;
  archTop: (R: number) => number;
  lampX: number;
  lampY: number;
  zWsBase: number;
  zWsTop: number;
  kWs: number;
  /** the grille pocket: centre height, half height, half width */
  grilleY: number;
  grilleHy: number;
  grilleHx: number;
}

const PI = Math.PI;

/** A rounded rectangle polygon centred on (cx, cy). */
function rrect(hx: number, hy: number, r: number, cx = 0, cy = 0, seg = 3): number[] {
  return roundPoly([cx - hx, cy - hy, cx + hx, cy - hy, cx + hx, cy + hy, cx - hx, cy + hy], r, seg);
}

/** A hexagon-headed bolt on a surface: base at `p`, standing out along unit `n`. */
function bolt(b: PartBuilder, p: V3, n: V3, r: number, h: number): void {
  b.cylinder(p, [p[0] + n[0] * h, p[1] + n[1] * h, p[2] + n[2] * h], r, r * 0.92, 6, true);
}

/**
 * The outline of a wheel opening as a path of (z, y, outward normal z, outward normal y): up the front edge, round the top-front
 * corner, across the top, round the top-rear corner and down the rear edge. `yLo` is where the path starts and ends.
 */
function archPath(zc: number, hz: number, top: number, rc: number, yLo: number, arcSteps = 7): Array<[number, number, number, number]> {
  const p: Array<[number, number, number, number]> = [];
  p.push([zc + hz, yLo, 1, 0], [zc + hz, top - rc, 1, 0]);
  for (let k = 1; k <= arcSteps; k++) {
    const a = (k / arcSteps) * (PI / 2);
    p.push([zc + hz - rc + rc * Math.cos(a), top - rc + rc * Math.sin(a), Math.cos(a), Math.sin(a)]);
  }
  for (let k = 0; k <= arcSteps; k++) {
    const a = PI / 2 + (k / arcSteps) * (PI / 2);
    p.push([zc - hz + rc + rc * Math.cos(a), top - rc + rc * Math.sin(a), Math.cos(a), Math.sin(a)]);
  }
  p.push([zc - hz, yLo, -1, 0]);
  return p;
}

/** Evenly spaced samples (z, y, nz, ny) along a path from archPath, one every `step` metres. */
function resample(path: Array<[number, number, number, number]>, step: number): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  let carry = step * 0.5;
  for (let i = 0; i + 1 < path.length; i++) {
    const [z0, y0, nz0, ny0] = path[i];
    const [z1, y1, nz1, ny1] = path[i + 1];
    const len = Math.hypot(z1 - z0, y1 - y0);
    let t = carry;
    while (t <= len) {
      const f = t / len;
      const nz = nz0 + (nz1 - nz0) * f, ny = ny0 + (ny1 - ny0) * f;
      const nl = Math.hypot(nz, ny) || 1;
      out.push([z0 + (z1 - z0) * f, y0 + (y1 - y0) * f, nz / nl, ny / nl]);
      t += step;
    }
    carry = t - len;
  }
  return out;
}

/**
 * A fender flare: a black textured band round a wheel opening, standing 7 cm proud of the door skin with a chamfered outer edge
 * and a row of hex bolts down its flat top. It is a sweep of one section along the outline of the opening.
 */
function addFlare(b: PartBuilder, side: 1 | -1, zc: number, R: number, d: SuvDims): void {
  const hz = d.archHz(R), top = d.archTop(R);
  const path = archPath(zc, hz, top, 0.2, 0.6);
  // the section (b outward from the edge of the opening, a out of the door skin), with its corners chamfered
  const sec: Array<[number, number]> = [
    [-0.014, -0.012],
    [-0.014, 0.062],
    [-0.007, 0.074],
    [0.066, 0.074],
    [0.084, 0.06],
    [0.098, 0.024],
    [0.102, -0.012],
  ];
  const rings: V3[][] = [];
  for (const [z, y, nz, ny] of path) {
    rings.push(sec.map(([bb, a]) => [side * (d.slab + a), y + ny * bb, z + nz * bb] as V3));
  }
  b.setPart(PART.rugged);
  b.loft(rings, { capStart: true, capEnd: true });
  // the bolts: hex heads in the middle of the flat top
  b.setPart(PART.silver);
  for (const [z, y, nz, ny] of resample(path, 0.13)) {
    const bb = 0.036;
    bolt(b, [side * (d.slab + 0.0735), y + ny * bb, z + nz * bb], [side, 0, 0], 0.0085, 0.0095);
  }
}

/** A rock slider: a rounded black rail low under the door sill, with its end caps and three feet. */
function addSlider(b: PartBuilder, side: 1 | -1, z0: number, z1: number): void {
  const x = 0.975;
  // section in (z, y) pushed along x: a tube-ish bar 11 cm wide (out from the sill), 7 cm tall
  b.setPart(PART.rugged);
  const poly = rrect((z1 - z0) / 2, 0.036, 0.03, (z0 + z1) / 2, 0.36);
  b.extrude(poly, { o: [side * (x + 0.075), 0, 0], u: [0, 0, 1], v: [0, 1, 0] }, side * 0.15, 0.022, 2);
  // orange end caps
  b.setPart(PART.signal);
  for (const z of [z0 + 0.004, z1 - 0.004]) {
    b.extrude(rrect(0.006, 0.03, 0.01, z, 0.36), { o: [side * (x + 0.0745), 0, 0], u: [0, 0, 1], v: [0, 1, 0] }, side * 0.145, 0.004, 1);
  }
  // feet up into the sill
  b.setPart(PART.rugged);
  for (const z of [z0 + 0.18, (z0 + z1) / 2, z1 - 0.18]) b.box([side * (x - 0.01), 0.4, z], 0.03, 0.032, 0.045);
}

/**
 * Orange recovery loop: a tube ring in the (y, z) plane (hole facing sideways), open on the bumper side where two short rods
 * run into a bracket plate on the bumper. `dir` is +1 on the nose (the ring stands out forward), -1 on the tail.
 */
function addTowHook(b: PartBuilder, x: number, y0: number, zBase: number, dir: 1 | -1): void {
  const r = 0.05, rt = 0.0125, gap = 0.6;
  const zc = zBase + dir * 0.07;
  const ring: V3[] = [];
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    const a = gap + (i / steps) * (2 * PI - 2 * gap);
    // a = 0 points at the bumper, PI/2 up, PI out
    ring.push([x, y0 + r * Math.sin(a), zc - dir * r * Math.cos(a)]);
  }
  const first = ring[0], last = ring[ring.length - 1];
  b.setPart(PART.signal);
  b.tube(ring, rt, 8, true);
  b.tube([[x, first[1], zBase - dir * 0.015], first], rt, 8, false);
  b.tube([last, [x, last[1], zBase - dir * 0.015]], rt, 8, false);
  b.setPart(PART.rugged);
  b.box([x, y0, zBase + dir * 0.004], 0.045, 0.07, 0.01);
}

/** Hex-headed fasteners in a row: `n` bolts from (x0, y0, z0) to (x1, y1, z1), standing out along `dir`. */
function boltRow(b: PartBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, n: number, r: number, dir: V3): void {
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    bolt(b, [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t], dir, r, r * 1.1);
  }
}

/** The LED light bar across the front of the roof: a black housing with cooling fins, a lens of LED pockets, four feet. */
function addLightBar(b: PartBuilder, d: SuvDims): void {
  // (on the roof, its rear feet a hand behind the windscreen header)
  const zb = d.zWsTop - 0.075;
  const yb = d.yRoof + 0.053;
  const half = 0.66;
  b.setPart(PART.lightBar);
  b.extrude(rrect(0.04, 0.036, 0.014, zb, yb), { o: [half, 0, 0], u: [0, 0, 1], v: [0, 1, 0] }, half * 2, 0.008, 2);
  // the lens: a plate on the front face, flagged (zone channel 14 = -1) so the shader lights it
  b.setPart(PART.lightBar).setZone(14, -1);
  b.extrude(rrect(half - 0.03, 0.026, 0.012, 0, yb), { o: [0, 0, zb + 0.035], u: [1, 0, 0], v: [0, 1, 0] }, 0.01, 0.003, 1);
  b.setPart(PART.lightBar);
  // cooling fins along the top, feet on the roof
  for (let i = 0; i < 15; i++) b.box([-half + 0.06 + i * ((half * 2 - 0.12) / 14), yb + 0.04, zb - 0.004], 0.0035, 0.007, 0.03);
  b.setPart(PART.rugged);
  for (const x of [-0.52, -0.2, 0.2, 0.52]) b.box([x, d.yRoof + 0.006, zb], 0.028, 0.012, 0.032);
}

/** A low roof rack: two rails, nine slats, ten feet. Black textured, with orange end blocks. */
function addRack(b: PartBuilder, d: SuvDims): void {
  const y = d.yRoof + 0.028;
  const zA = 0.1, zB = -1.95;
  b.setPart(PART.rugged);
  for (const sg of [-1, 1]) {
    b.tube([[sg * 0.7, y, zA], [sg * 0.7, y, zB]], 0.014, 8, true);
    for (let i = 0; i < 5; i++) b.box([sg * 0.7, d.yRoof + 0.01, zA + (zB - zA) * (i / 4)], 0.022, 0.014, 0.028);
  }
  for (let i = 0; i < 9; i++) b.box([0, y + 0.004, zA - 0.03 - i * ((zA - zB - 0.06) / 8)], 0.7, 0.008, 0.014);
  b.setPart(PART.signal);
  for (const sg of [-1, 1]) for (const z of [zA, zB]) b.box([sg * 0.7, y, z + (z === zA ? 0.012 : -0.012)], 0.016, 0.016, 0.012);
}

/** What an overlander carries on the rack: two orange recovery boards strapped down on the left, a black cargo box on the right. */
function addRackGear(b: PartBuilder, d: SuvDims): void {
  const yb = d.yRoof + 0.04;
  // recovery boards: a plate, a ladder of ribs and two black straps each
  for (const x of [0.5, 0.17]) {
    const zc = -0.9;
    b.setPart(PART.signal);
    b.extrude(rrect(0.14, 0.56, 0.03, x, zc), { o: [0, yb + 0.014, 0], u: [1, 0, 0], v: [0, 0, 1] }, 0.012, 0.003, 1);
    for (let i = 0; i < 11; i++) b.box([x, yb + 0.017, zc - 0.5 + i * 0.1], 0.125, 0.007, 0.018);
    b.setPart(PART.rugged);
    for (const dz of [-0.3, 0.3]) b.box([x, yb + 0.0165, zc + dz], 0.15, 0.0085, 0.02);
  }
  // cargo box: a black lidded box with two orange latches
  b.setPart(PART.rugged);
  b.extrude(rrect(0.25, 0.31, 0.04, -0.4, -1.57), { o: [0, yb + 0.16, 0], u: [1, 0, 0], v: [0, 0, 1] }, 0.14, 0.02, 2);
  b.setPart(PART.signal);
  for (const z of [-1.4, -1.74]) b.box([-0.15, yb + 0.085, z], 0.005, 0.02, 0.022);
}

/** The snorkel: a 7 cm pipe up the right A-pillar (it follows the screen's rake) to a forward-facing ram head over the roof edge. */
function addSnorkel(b: PartBuilder, d: SuvDims): void {
  const yr = d.yRoof;
  // z of the pillar's edge at height y
  const zp = (y: number): number => d.zWsBase - d.kWs * (y - d.yFend);
  const path: V3[] = [];
  const r: number[] = [];
  const pts: Array<[number, number, number, number]> = [
    // x, y, z, radius
    [-0.965, 1.3, zp(1.3) + 0.045, 0.03],
    [-0.99, 1.42, zp(1.42) + 0.02, 0.031],
    [-0.985, 1.58, zp(1.58) + 0.012, 0.031],
    [-0.968, 1.72, zp(1.72) + 0.012, 0.031],
    [-0.952, yr - 0.03, zp(yr - 0.03) + 0.012, 0.032],
    [-0.948, yr + 0.03, zp(yr) + 0.0, 0.034],
    [-0.948, yr + 0.08, zp(yr) + 0.014, 0.038],
    [-0.948, yr + 0.112, zp(yr) + 0.05, 0.046],
    [-0.948, yr + 0.116, zp(yr) + 0.092, 0.056],
    [-0.948, yr + 0.112, zp(yr) + 0.127, 0.058],
  ];
  for (const [x, y, z, rr] of pts) {
    path.push([x, y, z]);
    r.push(rr);
  }
  b.setPart(PART.rugged);
  b.tube(path, r, 14, false);
  // clamps to the pillar
  for (const [x, y, z] of [pts[2], pts[3], pts[4]]) b.box([x * 0.985, y, z], 0.04, 0.012, 0.03);
}

/** The spare wheel on the tailgate: a lugged tyre, a black cover with an orange ring and the X, and its carrier. */
function addSpare(b: PartBuilder, d: SuvDims, R: number, W: number): void {
  const y0 = 1.17;
  const zFace = d.zTg - 0.012;
  const o: V3 = [0, y0, zFace];
  const axis: V3 = [0, 0, -1];
  // tyre: a donut with a squarish shoulder
  b.setPart(PART.rubber);
  b.lathe(o, axis, [0.3, 0.004, 0.395, 0.01, R - 0.012, 0.03, R, 0.06, R, W - 0.06, R - 0.012, W - 0.03, 0.395, W - 0.008, 0.3, W], 48, false);
  // tread lugs: two staggered rows
  const n = 28;
  for (const [row, t0] of [[0, 0.085], [1, W - 0.085]] as Array<[number, number]>) {
    for (let i = 0; i < n; i++) {
      const a = ((i + row * 0.5) / n) * 2 * PI;
      const ca = Math.cos(a), sa = Math.sin(a);
      const c: V3 = [ca * (R + 0.004), y0 + sa * (R + 0.004), zFace - t0];
      b.box(c, 0.028, 0.009, 0.045, { o: [0, 0, 0], u: [-sa, ca, 0], v: [ca, sa, 0] });
    }
  }
  // the cover: a shallow black dome with an orange ring, bolted on
  b.setPart(PART.rugged);
  b.lathe(o, axis, [0, W + 0.003, 0.14, W + 0.0025, 0.26, W - 0.004, 0.3, W - 0.006, 0.305, W], 40, false);
  b.setPart(PART.signal);
  b.lathe(o, axis, [0.268, W - 0.0005, 0.268, W + 0.0035, 0.288, W + 0.0035, 0.288, W - 0.0005], 40, false);
  // the X (the badge's, big): two bars across the cover
  for (const sgn of [-1, 1]) {
    const ang = sgn * (PI / 4);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    b.extrude(roundPoly([-0.165, -0.034, 0.165, -0.034, 0.165, 0.034, -0.165, 0.034], 0.016), { o: [0, y0, zFace - W - 0.002], u: [ca, sa, 0], v: [-sa, ca, 0] }, -0.006, 0.002, 1);
  }
  // carrier: a hinge block and an arm on the tailgate behind it
  b.setPart(PART.rugged);
  b.box([0, y0, d.zTg - 0.006], 0.07, 0.07, 0.008);
}

/** Heavy horizontal bars across the grille pocket, with the X badge on the middle two. */
function addGrilleBars(b: PartBuilder, d: SuvDims): void {
  const zBack = d.zFas - 0.075;
  b.setPart(PART.rugged);
  for (const k of [-1.5, -0.5, 0.5, 1.5]) {
    b.extrude(rrect(d.grilleHx - 0.012, 0.027, 0.012, 0, d.grilleY + k * 0.088), { o: [0, 0, zBack], u: [1, 0, 0], v: [0, 1, 0] }, 0.052, 0.006, 1);
  }
  // the badge: a chrome ring, a black plate, an orange X
  const zb = d.zFas - 0.018;
  b.setPart(PART.chrome);
  b.cylinder([0, d.grilleY, zb], [0, d.grilleY, zb + 0.008], 0.082, 0.08, 32, true);
  b.setPart(PART.plastic);
  b.cylinder([0, d.grilleY, zb], [0, d.grilleY, zb + 0.0105], 0.068, 0.068, 32, true);
  b.setPart(PART.signal);
  for (const sgn of [-1, 1]) {
    const ang = sgn * (PI / 4);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    b.extrude(roundPoly([-0.052, -0.0095, 0.052, -0.0095, 0.052, 0.0095, -0.052, 0.0095], 0.004), { o: [0, d.grilleY, zb + 0.0105], u: [ca, sa, 0], v: [-sa, ca, 0] }, 0.003, 0.001, 1);
  }
}

/** Front skid plate and winch fairlead; a recovery plate under the tail. */
function addUnderguards(b: PartBuilder, d: SuvDims): void {
  const zN = d.zNose;
  b.setPart(PART.silver);
  const plate = roundPoly([-0.62, zN - 0.5, 0.62, zN - 0.5, 0.62, zN - 0.16, 0.5, zN - 0.04, -0.5, zN - 0.04, -0.62, zN - 0.16], 0.03);
  b.extrude(plate, { o: [0, 0.403, 0], u: [1, 0, 0], v: [0, 0, 1] }, 0.018, 0.004, 2);
  boltRow(b, -0.5, 0.403, zN - 0.44, 0.5, 0.403, zN - 0.44, 6, 0.01, [0, -1, 0]);
  boltRow(b, -0.44, 0.403, zN - 0.12, 0.44, 0.403, zN - 0.12, 5, 0.01, [0, -1, 0]);
  // the winch fairlead: a plate and a roller on the bumper face
  b.setPart(PART.rugged);
  b.box([0, 0.55, zN + 0.014], 0.2, 0.036, 0.012);
  b.setPart(PART.silver);
  b.cylinder([-0.12, 0.55, zN + 0.03], [0.12, 0.55, zN + 0.03], 0.018, 0.018, 12, true);
  // fog lamps in the bumper corners: a chrome bezel round a clear lens (not lit: the bumper is not a headlamp)
  for (const sg of [-1, 1]) {
    b.setPart(PART.chrome);
    b.cylinder([sg * 0.76, 0.585, zN - 0.004], [sg * 0.76, 0.585, zN + 0.009], 0.06, 0.058, 22, true);
    b.setPart(PART.lampWhite);
    b.cylinder([sg * 0.76, 0.585, zN + 0.004], [sg * 0.76, 0.585, zN + 0.0105], 0.046, 0.046, 22, true);
    // amber side markers on the fender tops, over the lamps
    b.setPart(PART.lampAmber);
    b.box([sg * 0.9, d.yFend + 0.004, zN - 0.28], 0.032, 0.006, 0.014);
  }
  // rear: a tow hitch receiver and its pin, and a recovery plate under the tail
  b.setPart(PART.rugged);
  b.box([0, 0.405, d.zTail + 0.1], 0.05, 0.05, 0.12);
  b.setPart(PART.silver);
  b.cylinder([-0.07, 0.405, d.zTail + 0.12], [0.07, 0.405, d.zTail + 0.12], 0.009, 0.009, 8, true);
  b.extrude(roundPoly([-0.5, d.zTail + 0.04, 0.5, d.zTail + 0.04, 0.5, d.zTail + 0.4, -0.5, d.zTail + 0.4], 0.04), { o: [0, 0.368, 0], u: [1, 0, 0], v: [0, 0, 1] }, 0.016, 0.004, 2);
}

/** The side-exit pipes: a short angled pipe through the sill, a chrome rim and a heat shield. The tip is where effects.ts blows its flames. */
function addExhaust(b: PartBuilder, s: CarVisualSpec, d: SuvDims): void {
  const y = s.rideHeight + 0.2;
  const z = -s.wheelbase / 2 + 0.6;
  const x = s.width / 2 - 0.02;
  const l = Math.hypot(0.9, 0.45);
  const dx = 0.9 / l, dz = -0.45 / l;
  for (const sg of [-1, 1]) {
    const tip: V3 = [sg * x, y, z];
    const at = (t: number): V3 => [tip[0] - sg * dx * t, y, tip[2] - dz * t];
    // heat shield on the sill (a slab on the door skin), then the pipe
    b.setPart(PART.rugged);
    b.extrude(rrect(0.13, 0.062, 0.03, z, y), { o: [sg * (d.slab + 0.008), 0, 0], u: [0, 0, 1], v: [0, 1, 0] }, sg * 0.012, 0.004, 1);
    b.setPart(PART.titanium);
    b.tube([at(0.16), at(0.02)], 0.042, 18, false);
    b.setPart(PART.chrome);
    b.tube([at(0.02), at(0)], [0.046, 0.05], 18, false);
    // the dark bore
    b.setPart(PART.plastic);
    b.tube([at(0.012), at(0.011)], 0.04, 18, true);
  }
}

/** Wipers parked along the foot of the windscreen: two arms and blades lying on the glass (in the plane of the screen). */
function addWipers(b: PartBuilder, d: SuvDims): void {
  const slope = Math.hypot(1, d.kWs);
  // up the screen (v) and out of the glass (w = u x v)
  const v: V3 = [0, 1 / slope, -d.kWs / slope];
  const zOn = (y: number): number => d.zWsBase - d.kWs * (y - d.yFend);
  b.setPart(PART.plastic);
  for (const sg of [-1, 1]) {
    // the blade: from the middle of the screen out towards the pillar, a little above the foot of the glass
    const y = 1.428;
    const x0 = sg * 0.1, x1 = sg * 0.56;
    const cx = (x0 + x1) / 2;
    b.box([cx, y, zOn(y) + 0.009], Math.abs(x1 - x0) / 2, 0.0065, 0.0045, { o: [0, 0, 0], u: [1, 0, 0], v });
    // the arm: from a pivot on the cowl up to the blade, slightly raised
    const px = sg * 0.42;
    b.tube([[px, 1.385, zOn(1.385) + 0.014], [px + sg * 0.08, y, zOn(y) + 0.016]], 0.0045, 6, false);
  }
}

/** A small lip over the top of the tailgate glass, in body paint: it carries the roof's line a hand's width past the tail. */
function addRoofLip(b: PartBuilder, d: SuvDims): void {
  // the high-mount stop lamp: a thin red lens under the lip (lit like the tail lamps: dim with the lights, bright on the brake)
  b.setPart(PART.lampRed);
  b.box([0, d.yRoof - 0.07, d.zTg - 0.003], 0.26, 0.011, 0.004);
  b.setPart(PART.body);
  const y = d.yRoof - 0.052;
  b.extrude(roundPoly([-0.82, d.zTg + 0.012, 0.82, d.zTg + 0.012, 0.82, d.zTg - 0.075, 0.74, d.zTg - 0.09, -0.74, d.zTg - 0.09, -0.82, d.zTg - 0.075], 0.02), { o: [0, y + 0.012, 0], u: [1, 0, 0], v: [0, 0, 1] }, 0.012, 0.004, 1);
}

/** Hood pins at the four corners of the dome's flat (the rally touch), and mud flaps behind the rear wheels. */
function addHoodPins(b: PartBuilder, d: SuvDims): void {
  b.setPart(PART.silver);
  for (const sg of [-1, 1]) {
    for (const z of [1.18, 1.95]) {
      const x = sg * 0.46;
      b.cylinder([x, d.yHood - 0.004, z], [x, d.yHood + 0.016, z], 0.011, 0.009, 10, true);
      b.tube([[x, d.yHood + 0.016, z], [x + sg * 0.03, d.yHood + 0.024, z]], 0.0028, 6, true);
    }
  }
}

function addMudFlaps(b: PartBuilder, s: CarVisualSpec, d: SuvDims): void {
  b.setPart(PART.rubber);
  for (const sg of [-1, 1]) {
    // hung from the rear edge of the arch, behind the tyre: a thin black plate with a heavier lower lip
    const x = sg * (s.trackRear / 2);
    const z = d.zR - d.archHz(d.rR) + 0.014;
    b.box([x, 0.56, z], 0.15, 0.24, 0.006);
    b.box([x, 0.335, z + 0.002], 0.15, 0.03, 0.01);
  }
}

/** Door hinges and handles: the exposed hardware that makes a flat door read as a door. */
function addHardware(b: PartBuilder, d: SuvDims): void {
  b.setPart(PART.rugged);
  for (const sg of [-1, 1]) {
    for (const y of [0.62, 1.58]) b.box([sg * (d.slab + 0.008), y, 0.655], 0.012, 0.045, 0.02);
    for (const z of [-0.12, -0.72]) b.box([sg * (d.slab + 0.016), 1.12, z], 0.014, 0.022, 0.065);
  }
}

export function addSuvParts(b: PartBuilder, s: CarVisualSpec, d: SuvDims): void {
  const { zF, zR, zNose, zTail } = d;

  // ── fender flares ──────────────────────────────────────────────────────────
  for (const side of [1, -1] as const) {
    addFlare(b, side, zF, d.rF, d);
    addFlare(b, side, zR, d.rR, d);
  }

  // ── rock sliders ─────────────────────────────────────────────────────────────
  addSlider(b, 1, -0.78, 0.84);
  addSlider(b, -1, -0.78, 0.84);

  // ── tow hooks (orange: the livery accent) ────────────────────────────────────
  for (const sg of [-1, 1]) {
    addTowHook(b, sg * 0.56, 0.5, zNose, 1);
    addTowHook(b, sg * 0.56, 0.47, zTail, -1);
  }

  addGrilleBars(b, d);
  addUnderguards(b, d);
  addLightBar(b, d);
  addRack(b, d);
  addRackGear(b, d);
  addSnorkel(b, d);
  addSpare(b, d, d.rR, s.tireWidthRear);
  addExhaust(b, s, d);
  addHardware(b, d);
  addRoofLip(b, d);
  addWipers(b, d);
  addHoodPins(b, d);
  addMudFlaps(b, s, d);

  // mirrors: housing, stalk and glass face, set where the live mirror glass sits (carvis/mirrorLayout.ts)
  addDoorMirrors(b, s);
  void zR;
}
