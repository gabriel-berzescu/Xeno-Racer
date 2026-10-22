/**
 * The Volta's parts (worker-safe, PartBuilder): everything on the single-seater too thin for the sculpted mesh.
 *
 * - the front wing: a mainplane with a raised neutral section under the nose, two flaps that sweep up to simple endplates;
 * - the rear wing: a mainplane, a two-element flap, plain endplates with the LED strips on their trailing edges, on two pylons
 *   either side of the tailpipe (the 2026 car has no beam wing);
 * - the flaps of both wings are not here but in `formulaMoving`: each wing's flaps are a mesh of their own the car turns open on the
 *   straights (VehicleState.aeroOpen);
 * - the halo, painted in the livery, its central pillar flagged;
 * - a flat floor with an edge wing, the floor boards ahead of the sidepods, a small diffuser;
 * - pushrod suspension at both ends (wishbones, pushrods, track rods and toe links, the driveshafts), ending at the closing drums
 *   inside the wheels (wheels.ts, style 'formula'): static, as they would barely move over 6 cm of travel;
 * - the mirrors on their stalks, the rain light, the tailpipe, the T-camera on the roll hoop and a small fin;
 * - and what the far LOD keeps of all that (`addFormulaFarParts`).
 */
import type { CarVisualSpec } from '../../core/contracts';
import { airfoilPoly } from '../aero';
import { PART, type MovingPart } from '../blueprint';
import { eyePoint, formulaPoints } from '../layouts';
import { addDoorMirrors } from '../mirrorParts';
import { norm3, type Frame, type PartBuilder, type V3 } from '../parts';
import { roundPoly } from '../shapes';

/** One section of a wing element: where its quarter chord is (body frame), its chord and its incidence (negative: the trailing edge up). */
interface Section {
  x: number;
  y: number;
  z: number;
  chord: number;
  inc: number;
}

/** A wing element: an inverted aerofoil (the camber down, so it makes downforce) lofted across the car through `secs`, capped at the ends. */
function element(b: PartBuilder, secs: readonly Section[], thick: number, camber: number, n = 12): void {
  const rings: V3[][] = secs.map((sc) => {
    const p = airfoilPoly(sc.chord, thick, camber, sc.inc, n);
    const ring: V3[] = [];
    for (let i = 0; i < p.length; i += 2) ring.push([sc.x, sc.y + p[i + 1], sc.z + p[i]]);
    return ring;
  });
  b.loft(rings, { capStart: true, capEnd: true });
}

/** Leading and trailing edge of a section: [z, y] each (the section's quarter chord at its z, y). */
function edges(sc: Section): { le: [number, number]; te: [number, number] } {
  const c = Math.cos(sc.inc), s = Math.sin(sc.inc);
  const a = 0.25 * sc.chord, t = 0.75 * sc.chord;
  return { le: [sc.z + a * c, sc.y + a * s], te: [sc.z - t * c, sc.y - t * s] };
}

/** A flat plate in the (z, y) plane, `poly` its outline as [z, y, ...], from x = `x0` towards -x by `thick`. */
function plate(b: PartBuilder, poly: readonly number[], x0: number, thick: number, bevel = 0.002): void {
  const f: Frame = { o: [x0, 0, 0], u: [0, 0, 1], v: [0, 1, 0] };
  b.extrude(poly, f, thick, bevel, 1);
}

/** The same plate on both sides of the car, its outer face at |x| = `xOut`. */
function plates(b: PartBuilder, poly: readonly number[], xOut: number, thick: number): void {
  plate(b, poly, xOut, thick);
  plate(b, poly, -xOut + thick, thick);
}

/** A rod between two points and its mirror image across the centre line. */
function rods(b: PartBuilder, a: V3, c: V3, r: number, segs = 8): void {
  b.cylinder(a, c, r, r, segs, true);
  b.cylinder([-a[0], a[1], a[2]], [-c[0], c[1], c[2]], r, r, segs, true);
}

/** A Catmull-Rom curve through `p`, `k` points per span (the ends kept). */
function smooth(p: readonly V3[], k: number): V3[] {
  const out: V3[] = [];
  const at = (i: number): V3 => p[Math.min(p.length - 1, Math.max(0, i))];
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let j = 0; j < k; j++) {
      const t = j / k, t2 = t * t, t3 = t2 * t;
      const q: number[] = [0, 0, 0];
      for (let a = 0; a < 3; a++) q[a] = 0.5 * (2 * p1[a] + (-p0[a] + p2[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t3);
      out.push([q[0], q[1], q[2]]);
    }
  }
  out.push(p[p.length - 1]);
  return out;
}

/** Where everything is, from the spec (body frame: +z forward, +x left, y up). */
function frame(s: CarVisualSpec) {
  const zF = s.wheelbase / 2;
  const zR = -s.wheelbase / 2;
  const zNose = zF + s.frontOverhang;
  const zTail = -(s.wheelbase / 2 + (s.length - s.wheelbase - s.frontOverhang));
  const hk = s.height / 0.95;
  // (the cockpit's reference: 5 cm behind the driver's eye)
  const sz = eyePoint(s)[2] - 0.05;
  return { zF, zR, zNose, zTail, hk, sz, pts: formulaPoints(s) };
}

// ── the front wing ─────────────────────────────────────────────────────────

/** The mainplane across the car: high in the middle where the nose sits on it, low and flat out to the endplates. */
function frontMain(s: CarVisualSpec): Section[] {
  const { zNose } = frame(s);
  const xs = [-0.86, -0.62, -0.36, -0.17, 0, 0.17, 0.36, 0.62, 0.86];
  const yOf = (ax: number): number => (ax < 0.17 ? 0.128 - (0.01 * ax) / 0.17 : ax < 0.36 ? 0.118 - (0.03 * (ax - 0.17)) / 0.19 : ax < 0.62 ? 0.088 - (0.01 * (ax - 0.36)) / 0.26 : 0.078 + (0.004 * (ax - 0.62)) / 0.24);
  return xs.map((x) => {
    const ax = Math.abs(x);
    return { x, y: yOf(ax), z: zNose - 0.085 - 0.015 * Math.max(0, ax - 0.6) / 0.26, chord: 0.3 - 0.02 * Math.min(1, ax / 0.86), inc: -0.05 - 0.05 * Math.min(1, ax / 0.62) };
  });
}

/** The two flaps of one side (sg = +1 left, -1 right), each over the trailing edge of the element ahead of it, rising at the tips. */
function frontFlaps(s: CarVisualSpec, sg: number): [Section[], Section[]] {
  const main = frontMain(s);
  const xs = [0.2, 0.4, 0.62, 0.85];
  const mainAt = (ax: number): Section => {
    // the mainplane section at |x| = ax, straight between its sections
    const right = main.filter((m) => m.x >= 0);
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
  for (const ax of xs) {
    const rise = 0.035 * Math.max(0, (ax - 0.45) / 0.4) ** 1.5;
    const m = edges(mainAt(ax));
    // flap 1: its leading edge 1.2 cm over the mainplane's trailing edge and 4 mm ahead of it (the slot)
    const a1: Section = { x: sg * ax, y: 0, z: 0, chord: 0.16, inc: -0.42 };
    const e1 = edges({ ...a1, y: 0, z: 0 });
    a1.z = m.te[0] + 0.004 - e1.le[0];
    a1.y = m.te[1] + 0.012 + rise - e1.le[1];
    f1.push(a1);
    const t1 = edges(a1);
    const a2: Section = { x: sg * ax, y: 0, z: 0, chord: 0.12, inc: -0.72 };
    const e2 = edges({ ...a2, y: 0, z: 0 });
    a2.z = t1.te[0] + 0.025 - e2.le[0];
    a2.y = t1.te[1] + 0.01 + 0.4 * rise - e2.le[1];
    f2.push(a2);
  }
  if (sg < 0) {
    f1.reverse();
    f2.reverse();
  }
  return [f1, f2];
}

// ── the rear wing ──────────────────────────────────────────────────────────

function rearMain(s: CarVisualSpec): Section[] {
  const { zTail, hk } = frame(s);
  return [-0.51, -0.3, 0, 0.3, 0.51].map((x) => ({ x, y: (0.765 + 0.012 * Math.abs(x)) * hk, z: zTail + 0.29, chord: 0.24, inc: -0.1 }));
}

function rearFlaps(s: CarVisualSpec): [Section[], Section[]] {
  const main = rearMain(s);
  const f1: Section[] = [];
  const f2: Section[] = [];
  for (const m of main) {
    const e = edges(m);
    const a1: Section = { x: m.x, y: 0, z: 0, chord: 0.17, inc: -0.48 };
    const e1 = edges(a1);
    a1.z = e.te[0] - 0.005 - e1.le[0];
    a1.y = e.te[1] + 0.012 - e1.le[1];
    f1.push(a1);
    const t1 = edges(a1);
    const a2: Section = { x: m.x, y: 0, z: 0, chord: 0.11, inc: -0.78 };
    const e2 = edges(a2);
    a2.z = t1.te[0] + 0.03 - e2.le[0];
    a2.y = t1.te[1] + 0.01 - e2.le[1];
    f2.push(a2);
  }
  return [f1, f2];
}

/** The rear-wing endplate's outline in (z, y): a plain plate from under the mainplane to over the flap, its trailing edge where the LEDs are. */
function rearEndplate(s: CarVisualSpec): number[] {
  const { zTail, hk, pts } = frame(s);
  const zTe = pts.wingLed[2] + 0.002;
  return roundPoly(
    [zTail + 0.33, 0.69 * hk, zTail + 0.37, 0.8 * hk, zTail + 0.3, 0.935 * hk, zTail + 0.15, 0.975 * hk, zTe, 0.975 * hk, zTe, 0.68 * hk, zTail + 0.12, 0.655 * hk],
    [0.03, 0.06, 0.1, 0.06, 0.01, 0.01, 0.06],
  );
}

// ── the halo ───────────────────────────────────────────────────────────────

/** The halo's hoop, from the left rear mount over the front to the right one, and its central pillar (top, foot). */
export function haloPath(s: CarVisualSpec): { hoop: V3[]; pillar: [V3, V3] } {
  const { hk, sz } = frame(s);
  const left: V3[] = [
    [0.255, 0.585 * hk, sz - 0.36],
    [0.262, 0.7 * hk, sz - 0.27],
    [0.255, 0.8 * hk, sz - 0.14],
    [0.235, 0.855 * hk, sz + 0.02],
    [0.19, 0.875 * hk, sz + 0.16],
    [0.11, 0.882 * hk, sz + 0.26],
  ];
  const apex: V3 = [0, 0.885 * hk, sz + 0.3];
  const ctrl: V3[] = [...left, apex, ...left.slice().reverse().map((p) => [-p[0], p[1], p[2]] as V3)];
  return { hoop: smooth(ctrl, 4), pillar: [[0, 0.878 * hk, sz + 0.285], [0, 0.63 * hk, sz + 0.57]] };
}

function addHalo(b: PartBuilder, s: CarVisualSpec, segs: number, k = 1): void {
  const { hoop, pillar } = haloPath(s);
  b.setPart(PART.halo);
  b.tube(k > 1 ? hoop.filter((_, i) => i % k === 0 || i === hoop.length - 1) : hoop, 0.024, segs, true);
  b.setPart(PART.halo).setZone(14, -1);
  b.cylinder(pillar[0], pillar[1], 0.022, 0.03, segs, true);
  b.clearZones();
}

// ── everything static ──────────────────────────────────────────────────────

export function addFormulaParts(b: PartBuilder, s: CarVisualSpec): void {
  const { zF, zR, zNose, zTail, hk, sz, pts } = frame(s);

  // front wing: the mainplane and the endplates (the flaps move: formulaMoving)
  b.setPart(PART.carbon);
  element(b, frontMain(s), 0.08, -0.07);
  b.setPart(PART.carbon);
  const fe = roundPoly([zNose - 0.04, 0.035, zNose - 0.06, 0.13, zNose - 0.28, 0.17, zNose - 0.46, 0.29, zNose - 0.53, 0.3, zNose - 0.53, 0.04], [0.01, 0.03, 0.06, 0.03, 0.01, 0.01]);
  plates(b, fe, 0.877, 0.012);

  // rear wing: the mainplane, the endplates, two pylons either side of the tailpipe, and the LEDs on the endplates' trailing edges
  b.setPart(PART.carbon);
  element(b, rearMain(s), 0.1, -0.08);
  b.setPart(PART.accent);
  plates(b, rearEndplate(s), 0.527, 0.012);
  b.setPart(PART.carbon);
  const py = roundPoly([zTail + 0.43, 0.36 * hk, zTail + 0.35, 0.765 * hk, zTail + 0.22, 0.76 * hk, zTail + 0.22, 0.35 * hk], 0.015);
  plates(b, py, 0.062, 0.014);
  b.setPart(PART.ledRed);
  const wl = pts.wingLed;
  for (const sg of [1, -1]) b.box([sg * wl[0], wl[1], wl[2] - 0.003], 0.0075, 0.085 * hk, 0.006);

  // the halo
  addHalo(b, s, 14);

  // the floor: a flat plate between the wheels with an edge wing, the floor boards ahead of the sidepods, a small diffuser
  b.setPart(PART.carbon);
  {
    const side: Array<[number, number]> = [
      [zF - 0.38, 0.2],
      [zF - 0.6, 0.48],
      [zF - 0.85, 0.62],
      [zF - 1.3, 0.68],
      [zR + 0.8, 0.68],
      [zR + 0.5, 0.6],
      [zR + 0.36, 0.52],
      [zR + 0.25, 0.5],
    ];
    const outline: number[] = [];
    for (const [z, x] of side) outline.push(z, x);
    for (let i = side.length - 1; i >= 0; i--) outline.push(side[i][0], -side[i][1]);
    b.extrude(roundPoly(outline, 0.03), { o: [0, s.rideHeight + 0.002, 0], u: [0, 0, 1], v: [1, 0, 0] }, 0.014, 0.003, 1);
    const ey = s.rideHeight + 0.016;
    for (const sg of [1, -1]) b.box([sg * 0.672, ey + 0.022, (zF - 1.0 + zR + 0.75) / 2], 0.005, 0.022, (zF - 1.0 - (zR + 0.75)) / 2);
    // floor boards: two curved fences each side, their trailing edges turned out so they push the front wheels' wake off the floor
    const boards: Array<[number, number, number, number]> = [
      // x, front z, rear z, height at the back
      [0.45, zF - 0.55, zF - 0.95, 0.2],
      [0.6, zF - 0.7, zF - 1.05, 0.14],
    ];
    for (const [x, z0, z1, h] of boards) {
      const len = z0 - z1;
      const prof = roundPoly([0, 0, 0, 0.05, -0.35 * len, 0.13 * (h / 0.2), -0.7 * len, 0.18 * (h / 0.2), -len, h, -len, 0], 0.012);
      for (const sg of [1, -1]) {
        const yaw = -sg * 0.12;
        const u = norm3([Math.sin(yaw), 0, Math.cos(yaw)]);
        b.extrude(prof, { o: [sg * x, ey, z0], u, v: [0, 1, 0] }, 0.008, 0.002, 1);
      }
    }
    // the diffuser: a ramp up to the gearbox between two fences, three strakes under it
    const z0 = zR + 0.25, z1 = zR - 0.36;
    const y0 = s.rideHeight + 0.016, y1 = 0.25 * hk;
    const d = norm3([0, y1 - y0, z1 - z0]);
    const nrm: V3 = [0, -d[2], d[1]];
    b.box([0, (y0 + y1) / 2 + 0.006 * nrm[1], (z0 + z1) / 2 + 0.006 * nrm[2]], 0.47, 0.006, Math.hypot(y1 - y0, z1 - z0) / 2, { o: [0, 0, 0], u: [1, 0, 0], v: nrm });
    plates(b, [z0, y0, z1, y0, z1, y1 + 0.06, z0, y0 + 0.05], 0.485, 0.01);
    for (const x of [-0.24, 0, 0.24]) plate(b, [z0 - 0.05, y0 + 0.002, z1, y0 + 0.002, z1, y1 - 0.01], x + 0.005, 0.01, 0.0015);
  }

  // suspension: pushrod at both ends, each arm ending at the closing drum inside its wheel
  b.setPart(PART.carbon);
  {
    const xf = s.trackFront / 2 - 0.43 * s.tireWidthFront - 0.015;
    const lo: V3 = [xf, 0.17, zF];
    const up: V3 = [xf - 0.01, 0.52, zF - 0.02];
    rods(b, lo, [0.15, 0.265, zF + 0.27], 0.012);
    rods(b, lo, [0.17, 0.25, zF - 0.28], 0.012);
    rods(b, up, [0.13, 0.5, zF + 0.24], 0.012);
    rods(b, up, [0.15, 0.5, zF - 0.26], 0.012);
    rods(b, [xf - 0.025, 0.2, zF + 0.02], [0.11, 0.6 * hk, zF - 0.12], 0.013);
    rods(b, [0.15, 0.36, zF + 0.16], [xf, 0.37, zF + 0.14], 0.01);
    const xr = s.trackRear / 2 - 0.43 * s.tireWidthRear - 0.014;
    const rlo: V3 = [xr, 0.17, zR];
    const rup: V3 = [xr - 0.01, 0.53, zR - 0.02];
    rods(b, rlo, [0.09, 0.2, zR + 0.3], 0.012);
    rods(b, rlo, [0.09, 0.22, zR - 0.22], 0.012);
    rods(b, rup, [0.08, 0.44, zR + 0.28], 0.012);
    rods(b, rup, [0.08, 0.43, zR - 0.22], 0.012);
    rods(b, [xr - 0.02, 0.2, zR + 0.02], [0.07, 0.47, zR - 0.1], 0.013);
    rods(b, [0.09, 0.3, zR - 0.25], [xr, 0.31, zR - 0.18], 0.01);
    b.setPart(PART.plastic);
    rods(b, [0.08, s.wheelRadiusRear, zR], [xr, s.wheelRadiusRear, zR], 0.022, 12);
  }

  // mirrors on their stalks (carvis/mirrorLayout.ts)
  addDoorMirrors(b, s);

  // the rain light on the crash structure's tip
  b.setPart(PART.rainLight);
  b.box(pts.rainLight, 0.032, 0.018, 0.005);

  // the tailpipe over the crash structure
  {
    const e = pts.exhaust;
    b.setPart(PART.titanium);
    b.cylinder([0, e[1], e[2] + 0.16], [0, e[1], e[2]], 0.04, 0.043, 20, false);
    b.setPart(PART.plastic);
    b.cylinder([0, e[1], e[2] + 0.012], [0, e[1], e[2] + 0.008], 0.036, 0.036, 20, true);
  }

  // the T-camera on top of the roll hoop, and a small fin on the engine cover
  b.setPart(PART.signal);
  b.box([0, 0.95 * hk + 0.02, sz - 0.52], 0.026, 0.02, 0.05);
  b.setPart(PART.body);
  plate(b, roundPoly([sz - 0.95, 0.86 * hk, sz - 1.75, 0.63 * hk, sz - 1.75, 0.5 * hk, sz - 0.95, 0.75 * hk], 0.02), 0.004, 0.008);
}

// ── the moving flaps ───────────────────────────────────────────────────────

/**
 * The active aero: each wing's flaps as one mesh on a hinge at their trailing edge. In straight mode they turn by `angle` (the
 * leading edges rising): the front flaps flatten a little, the rear flap opens wide, the gap under it showing as on a real car.
 */
export function formulaMoving(s: CarVisualSpec): MovingPart[] {
  const [, l2] = frontFlaps(s, 1);
  const fPivot = edges(l2[0]).te;
  const [r1, r2] = rearFlaps(s);
  const rPivot = edges(r2[2]).te;
  return [
    {
      name: 'frontFlaps',
      drive: 'aero',
      pivot: [0, fPivot[1], fPivot[0]],
      axis: [1, 0, 0],
      angle: -0.17,
      build: (b) => {
        for (const sg of [1, -1]) {
          const [f1, f2] = frontFlaps(s, sg);
          b.setPart(PART.carbon);
          element(b, f1, 0.09, -0.08);
          b.setPart(PART.body);
          element(b, f2, 0.09, -0.08);
        }
      },
    },
    {
      name: 'rearFlaps',
      drive: 'aero',
      pivot: [0, rPivot[1], rPivot[0]],
      axis: [1, 0, 0],
      angle: -0.45,
      build: (b) => {
        b.setPart(PART.carbon);
        element(b, r1, 0.1, -0.08);
        b.setPart(PART.accent);
        element(b, r2, 0.1, -0.08);
      },
    },
  ];
}

// ── the far LOD ────────────────────────────────────────────────────────────

/** What a far Volta keeps: both wings as slabs (the rear one on a pylon), the halo, the helmet and the floor (they make its outline and its shadow). */
export function addFormulaFarParts(b: PartBuilder, s: CarVisualSpec): void {
  const { zF, zR, zNose, zTail, hk } = frame(s);
  b.setPart(PART.carbon);
  b.box([0, 0.1, zNose - 0.19], 0.86, 0.022, 0.2);
  b.box([0, 0.2, zNose - 0.43], 0.86, 0.022, 0.08);
  for (const sg of [1, -1]) b.box([sg * 0.871, 0.17, zNose - 0.3], 0.006, 0.13, 0.26);
  b.box([0, 0.78 * hk, zTail + 0.28], 0.51, 0.025, 0.12);
  b.box([0, 0.9 * hk, zTail + 0.07], 0.51, 0.03, 0.08);
  // one pylon down to the gearbox where the near car has two, or the wing hangs in the air side-on
  b.box([0, 0.55 * hk, zTail + 0.32], 0.015, 0.21 * hk, 0.1);
  b.extrude([zF - 0.4, 0.2, zF - 0.85, 0.62, zR + 0.8, 0.68, zR + 0.25, 0.5, zR + 0.25, -0.5, zR + 0.8, -0.68, zF - 0.85, -0.62, zF - 0.4, -0.2], { o: [0, s.rideHeight + 0.002, 0], u: [0, 0, 1], v: [1, 0, 0] }, 0.014);
  for (const sg of [1, -1]) b.box([sg * 0.521, 0.8 * hk, zTail + 0.12], 0.007, 0.18 * hk, 0.25);
  addHalo(b, s, 6, 3);
  const eye = eyePoint(s);
  b.setPart(PART.body);
  b.ellipsoid([eye[0], eye[1] - 0.03, eye[2] - 0.07], 0.11, 0.135, 0.145, 10, 6);
}
