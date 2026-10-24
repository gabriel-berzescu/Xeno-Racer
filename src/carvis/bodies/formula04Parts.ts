/**
 * The Dieci's parts (worker-safe, PartBuilder): everything on the 2004 single-seater too thin for the sculpted mesh, built with the
 * Volta's toolkit (formulaParts.ts).
 *
 * - the front wing hung under the high nose on two pylons: a mainplane dipped into a spoon in the middle, two flaps over its outer
 *   parts rising to the tips, big flat endplates with footplates;
 * - the bargeboards between the front wheels and the sidepods, a keel under the chassis, the flip-ups ahead of the rear wheels;
 * - the rear wing: two elements a metre across between big flat endplates, its top 83 cm up, and a beam wing under it at the axle's
 *   height; nothing on it moves (no flaps open in 2004);
 * - a flat floor with the large diffuser of the years before 2005, five strakes under it;
 * - pushrod suspension at both ends (wishbones, pushrods, track rods and toe links, the driveshafts), its arms ending inside the 13-inch
 *   rims at the drums there (wheels.ts, style 'formula04');
 * - the chimneys on the sidepods' shoulders;
 * - the mirrors on their stalks from the sidepods, the rain light, the T-camera on the airbox;
 * - and what the far LOD keeps of all that (`addFormula04FarParts`).
 *
 * The periscope exhausts are not here: they are sculpted with the sidepods (bodies/formula04.ts), so they dent with them.
 */
import type { CarVisualSpec } from '../../core/contracts';
import { PART } from '../blueprint';
import { eyePoint, formula04Points } from '../layouts';
import { addDoorMirrors } from '../mirrorParts';
import { cross, dot3, norm3, sub3, type PartBuilder, type V3 } from '../parts';
import { roundPoly } from '../shapes';
import { edges, element, plate, plates, rods, type Section } from './formulaParts';

/** Where everything is, from the spec (body frame: +z forward, +x left, y up). */
export function frame04(s: CarVisualSpec) {
  const zF = s.wheelbase / 2;
  const zR = -s.wheelbase / 2;
  const zNose = zF + s.frontOverhang;
  const zTail = -(s.wheelbase / 2 + (s.length - s.wheelbase - s.frontOverhang));
  const hk = s.height / 0.95;
  const eye = eyePoint(s);
  // (the cockpit's reference: 5 cm behind the driver's eye)
  const sz = eye[2] - 0.05;
  return { zF, zR, zNose, zTail, hk, eye, sz, pts: formula04Points(s) };
}

/** The mouth of a chimney: the middle of the left one (the right one is mirrored), its axis, and two ways square to it. */
export interface Mouth04 {
  at: V3;
  dir: V3;
  /** across the mouth (the short half-axis of an oval mouth) */
  u: V3;
  /** along the car in the mouth's plane (the long half-axis) */
  v: V3;
  /** the half-axes along v and along u */
  a: number;
  b: number;
}

function mouthFrame(at: V3, dir: V3, a: number, b: number): Mouth04 {
  const v = norm3([-dir[0] * dir[2], -dir[1] * dir[2], 1 - dir[2] * dir[2]]);
  return { at, dir, u: cross(dir, v), v, a, b };
}

/**
 * The mouth of the left chimney (the right one is mirrored), on the sidepod's shoulder 40 cm out and 55 cm behind the cockpit's
 * reference: 6.8 cm across inside its lip, facing up, out and a little back.
 */
export function chimney04(s: CarVisualSpec): Mouth04 {
  const { hk, sz } = frame04(s);
  const d = Math.hypot(0.32, 0.9, 0.28);
  return mouthFrame([0.405, 0.585 * hk, sz - 0.55], [0.32 / d, 0.9 / d, -0.28 / d], 0.034, 0.034);
}

/** A ring round a mouth (`sg` +1 the left one, -1 the right one), its half-axes grown by `grow`, `t` along the axis from the mouth's plane. */
function mouthRing(m: Mouth04, grow: number, t: number, sg: number): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < 24; i++) {
    const c = Math.cos((i / 24) * Math.PI * 2) * (m.b + grow), sn = Math.sin((i / 24) * Math.PI * 2) * (m.a + grow);
    const x = m.at[0] + m.dir[0] * t + m.u[0] * c + m.v[0] * sn;
    out.push([sg * x, m.at[1] + m.dir[1] * t + m.u[1] * c + m.v[1] * sn, m.at[2] + m.dir[2] * t + m.u[2] * c + m.v[2] * sn]);
  }
  return out;
}

/** A flat disc through a ring of points, facing `n`. */
function disc(b: PartBuilder, ring: V3[], n: V3): void {
  const w = cross(sub3(ring[1], ring[0]), sub3(ring[2], ring[0]));
  b.polygon3(dot3(w, n) > 0 ? ring : ring.slice().reverse(), n);
}

/**
 * A curved vertical fence (a bargeboard, a flip-up): a thin panel through `stations` (x, z, bottom y, top y), from front to back, its
 * faces along the line in plan, capped at both ends.
 */
export function fence(b: PartBuilder, stations: ReadonlyArray<readonly [number, number, number, number]>, thick: number): void {
  const n = stations.length;
  const rings: V3[][] = [];
  for (let i = 0; i < n; i++) {
    const [x, z, y0, y1] = stations[i];
    const a = stations[Math.max(0, i - 1)], c = stations[Math.min(n - 1, i + 1)];
    // the panel's normal in plan, across the line through its neighbours
    const t = norm3([c[0] - a[0], 0, c[1] - a[1]]);
    const nx = t[2] * thick * 0.5, nz = -t[0] * thick * 0.5;
    rings.push([
      [x + nx, y0, z + nz],
      [x + nx, y1, z + nz],
      [x - nx, y1, z - nz],
      [x - nx, y0, z - nz],
    ]);
  }
  b.loft(rings, { capStart: true, capEnd: true });
}

/** The same fence on both sides of the car (`stations` for the left one, +x). */
function fences(b: PartBuilder, stations: ReadonlyArray<readonly [number, number, number, number]>, thick: number): void {
  fence(b, stations, thick);
  fence(b, stations.map(([x, z, y0, y1]) => [-x, z, y0, y1] as const), thick);
}

// ── the front wing ─────────────────────────────────────────────────────────

/** The mainplane across the car: dipped into a spoon under the nose (7 cm off the ground), up to 13 cm under the flaps and out to the endplates. */
export function frontMain04(s: CarVisualSpec): Section[] {
  const { zNose } = frame04(s);
  const xs = [-0.688, -0.56, -0.43, -0.31, -0.24, -0.17, -0.09, 0, 0.09, 0.17, 0.24, 0.31, 0.43, 0.56, 0.688];
  return xs.map((x) => {
    const ax = Math.abs(x);
    // 0 in the spoon, 1 under the flaps (a smooth step between 12 and 31 cm out)
    const u = Math.min(1, Math.max(0, (ax - 0.12) / 0.19));
    const t = u * u * (3 - 2 * u);
    return { x, y: 0.072 + 0.056 * t + (0.008 * Math.max(0, ax - 0.31)) / 0.38, z: zNose - 0.083 - 0.06 * t, chord: 0.25 + 0.05 * t, inc: -0.04 - 0.06 * t };
  });
}

/** The two flaps of one side (sg = +1 left, -1 right), over the trailing edge of the element ahead of each, rising towards the tips. */
export function frontFlaps04(s: CarVisualSpec, sg: number): [Section[], Section[]] {
  const right = frontMain04(s).filter((m) => m.x >= 0);
  const mainAt = (ax: number): Section => {
    for (let i = 0; i < right.length - 1; i++) {
      const a = right[i], c = right[i + 1];
      if (ax <= c.x) {
        const t = (ax - a.x) / (c.x - a.x);
        return { x: ax, y: a.y + (c.y - a.y) * t, z: a.z + (c.z - a.z) * t, chord: a.chord + (c.chord - a.chord) * t, inc: a.inc + (c.inc - a.inc) * t };
      }
    }
    return right[right.length - 1];
  };
  const f1: Section[] = [];
  const f2: Section[] = [];
  for (const ax of [0.29, 0.4, 0.52, 0.63, 0.688]) {
    const rise = 0.04 * Math.max(0, (ax - 0.4) / 0.288) ** 1.4;
    const m = edges(mainAt(ax));
    // flap 1: its leading edge 1.2 cm over the mainplane's trailing edge and 5 mm ahead of it (the slot)
    const a1: Section = { x: sg * ax, y: 0, z: 0, chord: 0.15, inc: -0.4 };
    const e1 = edges(a1);
    a1.z = m.te[0] + 0.005 - e1.le[0];
    a1.y = m.te[1] + 0.012 + rise - e1.le[1];
    f1.push(a1);
    const t1 = edges(a1);
    const a2: Section = { x: sg * ax, y: 0, z: 0, chord: 0.11, inc: -0.72 };
    const e2 = edges(a2);
    a2.z = t1.te[0] + 0.022 - e2.le[0];
    a2.y = t1.te[1] + 0.01 + 0.5 * rise - e2.le[1];
    f2.push(a2);
  }
  if (sg < 0) {
    f1.reverse();
    f2.reverse();
  }
  return [f1, f2];
}

// ── the rear wing ──────────────────────────────────────────────────────────

/** The two elements of the rear wing, a metre across: the mainplane, and the flap over its trailing edge; the flap's top 83 cm up. */
export function rearWing04(s: CarVisualSpec): [Section[], Section[]] {
  const { zR, hk } = frame04(s);
  const xs = [-0.494, -0.3, 0, 0.3, 0.494];
  const main: Section[] = xs.map((x) => ({ x, y: 0.71 * hk, z: zR - 0.19, chord: 0.24, inc: -0.12 }));
  const flap: Section[] = main.map((m) => {
    const e = edges(m);
    const a: Section = { x: m.x, y: 0, z: 0, chord: 0.15, inc: -0.6 };
    const ea = edges(a);
    a.z = e.te[0] + 0.012 - ea.le[0];
    a.y = e.te[1] + 0.013 - ea.le[1];
    return a;
  });
  return [main, flap];
}

/** The beam wing under the rear wing, at the axle's height: one element curving up a little towards its ends. */
function beamWing04(s: CarVisualSpec): Section[] {
  const { zR, hk } = frame04(s);
  return [-0.488, -0.36, -0.2, 0, 0.2, 0.36, 0.488].map((x) => {
    const u = Math.abs(x) / 0.488;
    return { x, y: (0.41 + 0.04 * u * u) * hk, z: zR - 0.11, chord: 0.2, inc: -0.16 };
  });
}

/** The rear-wing endplate's outline in (z, y): a flat plate from the diffuser's side up past the flap, 42 cm long and 54.5 tall. */
function rearEndplate04(s: CarVisualSpec): number[] {
  const { zR, zTail, hk } = frame04(s);
  const zb = zTail - 0.008;
  return roundPoly([zR - 0.07, 0.3 * hk, zR - 0.07, 0.775 * hk, zR - 0.13, 0.845 * hk, zb, 0.845 * hk, zb, 0.3 * hk], [0.02, 0.03, 0.02, 0.02, 0.02]);
}

// ── everything ─────────────────────────────────────────────────────────────

export function addFormula04Parts(b: PartBuilder, s: CarVisualSpec): void {
  const { zF, zR, zNose, hk, sz, pts } = frame04(s);

  // front wing: the mainplane, its flaps, the endplates with their footplates, and the two pylons up into the nose
  b.setPart(PART.carbon);
  element(b, frontMain04(s), 0.08, -0.07);
  for (const sg of [1, -1]) {
    const [f1, f2] = frontFlaps04(s, sg);
    b.setPart(PART.carbon);
    element(b, f1, 0.09, -0.08);
    b.setPart(PART.accent);
    element(b, f2, 0.09, -0.08);
  }
  b.setPart(PART.body);
  const fe = roundPoly([zNose - 0.045, 0.115, zNose - 0.06, 0.245, zNose - 0.2, 0.315, zNose - 0.44, 0.322, zNose - 0.565, 0.275, zNose - 0.565, 0.115], [0.01, 0.04, 0.06, 0.04, 0.02, 0.01]);
  plates(b, fe, 0.7, 0.012);
  b.setPart(PART.carbon);
  for (const sg of [1, -1]) b.box([sg * 0.673, 0.119, zNose - 0.3], 0.017, 0.004, 0.25);
  const py = roundPoly([zNose - 0.085, 0.08, zNose - 0.07, 0.315, zNose - 0.235, 0.315, zNose - 0.255, 0.08], 0.012);
  plates(b, py, 0.07, 0.01);

  // the keel under the chassis that the lower wishbones hang from
  plate(b, roundPoly([zF + 0.32, 0.29, zF + 0.32, 0.215, zF - 0.32, 0.19, zF - 0.42, 0.24], 0.015), 0.012, 0.024);

  // the floor: a flat plate between the wheels, coke-bottle shaped at the back; the bargeboards on its leading edge; the flip-ups ahead
  // of the rear wheels; the large diffuser between tall fences, five strakes under it
  {
    const side: Array<[number, number]> = [
      [zF - 0.33, 0.26],
      [zF - 0.45, 0.45],
      [zF - 0.7, 0.58],
      [zF - 1.0, 0.64],
      [zR + 0.85, 0.64],
      [zR + 0.55, 0.56],
      [zR + 0.4, 0.5],
      [zR + 0.33, 0.48],
    ];
    const outline: number[] = [];
    for (const [z, x] of side) outline.push(z, x);
    for (let i = side.length - 1; i >= 0; i--) outline.push(side[i][0], -side[i][1]);
    b.extrude(roundPoly(outline, 0.03), { o: [0, s.rideHeight + 0.002, 0], u: [0, 0, 1], v: [1, 0, 0] }, 0.014, 0.003, 1);
    const ey = s.rideHeight + 0.016;
    fences(b, [[0.39, zF - 0.4, ey, ey + 0.07], [0.425, zF - 0.6, ey, 0.24 * hk], [0.468, zF - 0.85, ey, 0.33 * hk], [0.505, zF - 1.05, ey, 0.31 * hk], [0.52, zF - 1.14, ey, 0.21 * hk]], 0.008);
    fences(b, [[0.5, zR + 0.62, ey, ey + 0.03], [0.535, zR + 0.5, ey, 0.2 * hk], [0.565, zR + 0.39, ey, 0.4 * hk]], 0.008);
    const z0 = zR + 0.33, z1 = zR - 0.45;
    const y0 = s.rideHeight + 0.016, y1 = 0.28 * hk;
    const d = norm3([0, y1 - y0, z1 - z0]);
    const nrm: V3 = [0, -d[2], d[1]];
    b.box([0, (y0 + y1) / 2 + 0.006 * nrm[1], (z0 + z1) / 2 + 0.006 * nrm[2]], 0.48, 0.006, Math.hypot(y1 - y0, z1 - z0) / 2, { o: [0, 0, 0], u: [1, 0, 0], v: nrm });
    plates(b, [z0, y0, z1, y0, z1, y1 + 0.07, z0, y0 + 0.06], 0.495, 0.01);
    // (the strakes stand under the ramp from its start to its trailing edge: the three in the middle reach nearly to the ground at the
    // back, the outer two stop 8 cm over it)
    for (const x of [-0.3, -0.12, 0, 0.12, 0.3]) plate(b, [z0 - 0.06, y0 + 0.002, z1, y0 + 0.002 + (Math.abs(x) > 0.2 ? 0.08 : 0.03), z1, y1 - 0.01], x + 0.005, 0.01, 0.0015);
  }

  // the rear wing: two elements between big flat endplates painted in the livery, and the beam wing under it
  {
    const [main, flap] = rearWing04(s);
    b.setPart(PART.carbon);
    element(b, main, 0.1, -0.08);
    b.setPart(PART.accent);
    element(b, flap, 0.1, -0.08);
    b.setPart(PART.carbon);
    element(b, beamWing04(s), 0.1, -0.06);
    b.setPart(PART.body);
    plates(b, rearEndplate04(s), 0.506, 0.012);
  }

  // suspension: pushrod at both ends, each arm ending at the drum inside its 13-inch rim (the ball joints 11.5 cm over and under the axle,
  // the track rod's end 6 cm ahead of it and the toe link's 10 cm behind: the arms do not steer, and further out the track rod's stood in
  // the front tyre at full lock and the toe link's in the rear one)
  b.setPart(PART.carbon);
  {
    const R = s.wheelRadiusFront;
    const k = 0.7 * s.rimRadiusFront;
    const xf = s.trackFront / 2 - 0.43 * s.tireWidthFront - 0.015;
    const lo: V3 = [xf, R - k, zF];
    const up: V3 = [xf - 0.01, R + k, zF - 0.02];
    rods(b, lo, [0.02, 0.205, zF + 0.28], 0.012);
    rods(b, lo, [0.02, 0.2, zF - 0.28], 0.012);
    rods(b, up, [0.13, 0.47 * hk, zF + 0.24], 0.012);
    rods(b, up, [0.15, 0.47 * hk, zF - 0.26], 0.012);
    rods(b, [xf - 0.025, R - k + 0.02, zF + 0.02], [0.1, 0.56 * hk, zF - 0.14], 0.013);
    rods(b, [0.12, 0.37 * hk, zF + 0.1], [xf, 0.36 * hk, zF + 0.06], 0.01);
    const Rr = s.wheelRadiusRear;
    const kr = 0.7 * s.rimRadiusRear;
    const xr = s.trackRear / 2 - 0.43 * s.tireWidthRear - 0.014;
    const rlo: V3 = [xr, Rr - kr, zR];
    const rup: V3 = [xr - 0.01, Rr + kr, zR - 0.02];
    rods(b, rlo, [0.09, 0.2, zR + 0.3], 0.012);
    rods(b, rlo, [0.09, 0.22, zR - 0.22], 0.012);
    rods(b, rup, [0.08, 0.42 * hk, zR + 0.28], 0.012);
    rods(b, rup, [0.08, 0.41 * hk, zR - 0.22], 0.012);
    rods(b, [xr - 0.02, Rr - kr + 0.02, zR + 0.02], [0.07, 0.45 * hk, zR - 0.1], 0.013);
    rods(b, [0.09, 0.3, zR - 0.22], [xr, 0.31, zR - 0.1], 0.01);
    b.setPart(PART.plastic);
    rods(b, [0.08, Rr, zR], [xr, Rr, zR], 0.022, 12);
  }

  // the chimneys on the sidepods' shoulders, angled out: a short stack painted with the sidepod, from 9 cm down in it to an open top,
  // a grille 15 mm down inside the lip (it is a part, as the sculpted mesh holds nothing under two cells)
  {
    const m = chimney04(s);
    for (const sg of [1, -1]) {
      b.setPart(PART.body);
      b.loft([mouthRing(m, 0.012, -0.09, sg), mouthRing(m, 0.008, -0.04, sg), mouthRing(m, 0.004, -0.003, sg), mouthRing(m, 0.002, 0, sg), mouthRing(m, 0, -0.002, sg), mouthRing(m, 0, -0.015, sg)]);
      b.setZone(3, -1);
      disc(b, mouthRing(m, 0, -0.015, sg), [sg * m.dir[0], m.dir[1], m.dir[2]]);
      b.clearZones();
    }
  }

  // mirrors on their stalks from the front of the sidepods (carvis/mirrorLayout.ts)
  addDoorMirrors(b, s);

  // the rain light on the crash structure's tip: an upright red block, 8.5 cm across and 11.5 tall
  b.setPart(PART.rainLight);
  b.box(pts.rainLight, 0.0425, 0.0575, 0.005);

  // the T-camera on the airbox, black
  b.setPart(PART.plastic);
  b.box([0, 0.95 * hk + 0.012, sz - 0.36], 0.014, 0.018, 0.022);
  b.box([0, 0.95 * hk + 0.038, sz - 0.36], 0.11, 0.014, 0.028);
}

// ── the far LOD ────────────────────────────────────────────────────────────

/**
 * What a far Dieci keeps: both wings as slabs, the front one on a pylon up to the nose and the rear one between its endplates over the
 * beam wing, the floor and the helmet (they make its outline and its shadow).
 */
export function addFormula04FarParts(b: PartBuilder, s: CarVisualSpec): void {
  const { zF, zR, zNose, hk, eye } = frame04(s);
  b.setPart(PART.carbon);
  b.box([0, 0.105, zNose - 0.17], 0.69, 0.022, 0.14);
  for (const sg of [1, -1]) b.box([sg * 0.48, 0.2, zNose - 0.37], 0.2, 0.025, 0.07);
  // one pylon up into the nose where the near car has two, or the wing hangs under it in the air side-on
  b.box([0, 0.2, zNose - 0.19], 0.012, 0.11, 0.12);
  b.box([0, 0.71 * hk, zR - 0.23], 0.494, 0.025, 0.12);
  b.box([0, 0.79 * hk, zR - 0.4], 0.494, 0.025, 0.07);
  b.box([0, 0.43 * hk, zR - 0.13], 0.488, 0.02, 0.1);
  b.extrude([zF - 0.33, 0.26, zF - 0.7, 0.58, zR + 0.85, 0.64, zR + 0.33, 0.48, zR + 0.33, -0.48, zR + 0.85, -0.64, zF - 0.7, -0.58, zF - 0.33, -0.26], { o: [0, s.rideHeight + 0.002, 0], u: [0, 0, 1], v: [1, 0, 0] }, 0.014);
  b.setPart(PART.body);
  for (const sg of [1, -1]) {
    b.box([sg * 0.694, 0.215, zNose - 0.3], 0.006, 0.1, 0.26);
    b.box([sg * 0.5, 0.572 * hk, zR - 0.28], 0.006, 0.27 * hk, 0.21);
  }
  b.ellipsoid([eye[0], eye[1] - 0.03, eye[2] - 0.07], 0.11, 0.135, 0.145, 10, 6);
}
