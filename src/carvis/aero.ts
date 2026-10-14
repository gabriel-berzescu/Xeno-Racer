/**
 * Aero parts built with PartBuilder: aerofoil wings (multi-element, with end plates and pylons),
 * diffuser strakes and splitters. Pure numeric / worker-safe.
 */
import { PART } from './blueprint';
import type { PartBuilder } from './parts';
import { roundPoly } from './shapes';

/** NACA-style cambered aerofoil in (z, y): leading edge at +z, centred on the quarter chord. Closed polygon. */
export function airfoilPoly(chord: number, thick: number, camber: number, incidenceRad = 0, n = 16): number[] {
  const up: number[] = [];
  const lo: number[] = [];
  const c = Math.cos(incidenceRad), s = Math.sin(incidenceRad);
  const rot = (z: number, y: number): [number, number] => [z * c - y * s, z * s + y * c];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = (1 - Math.cos(t * Math.PI)) / 2;
    const th = 5 * thick * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1015 * x * x * x * x);
    const yc = camber * (1 - Math.pow(2 * x - 1, 2)) * 0.25;
    const z = (0.25 - x) * chord;
    const [uz, uy] = rot(z, (yc + th) * chord);
    const [lz, ly] = rot(z, (yc - th) * chord);
    up.push(uz, uy);
    lo.push(lz, ly);
  }
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(up[i * 2], up[i * 2 + 1]);
  for (let i = n - 1; i >= 1; i--) out.push(lo[i * 2], lo[i * 2 + 1]);
  return out;
}

export interface WingOpts {
  /** half span (m) */
  halfSpan: number;
  /** quarter-chord position of the main plane */
  y: number;
  z: number;
  chord: number;
  thick?: number;
  camber?: number;
  /** incidence in radians (negative = trailing edge down is nose-up... see sign: + lifts the trailing edge) */
  incidence?: number;
  /** optional second element sitting above/behind the main plane */
  flap?: { chord: number; dz: number; dy: number; incidence: number; thick?: number; camber?: number };
  /** end plates: height (above/below the wing centre), length (chord direction) */
  plate?: { up: number; down: number; len: number; part?: number; thickness?: number };
  /** central or twin pylons dropping to the body: bottom y and style */
  pylons?: Array<{ x: number; bottomY: number; bottomZ: number; width?: number }>;
  /** part id of the wing planes */
  part?: number;
}

export function addWing(b: PartBuilder, o: WingOpts): void {
  const part = o.part ?? PART.carbon;
  const frame = (x: number, y: number, z: number): { o: [number, number, number]; u: [number, number, number]; v: [number, number, number] } => ({ o: [x, y, z], u: [0, 0, 1], v: [0, 1, 0] });
  const span = o.halfSpan * 2;
  const main = airfoilPoly(o.chord, o.thick ?? 0.075, o.camber ?? 0.07, o.incidence ?? 0.1, 18);
  b.setPart(part);
  // extrusion runs towards -x, so start at +halfSpan
  b.extrude(main, frame(o.halfSpan, o.y, o.z), span, 0.003, 2);
  if (o.flap) {
    const f = o.flap;
    const poly = airfoilPoly(f.chord, f.thick ?? 0.06, f.camber ?? 0.08, f.incidence, 16);
    b.extrude(poly, frame(o.halfSpan, o.y + f.dy, o.z + f.dz), span, 0.003, 2);
  }
  if (o.plate) {
    const p = o.plate;
    const th = p.thickness ?? 0.012;
    // slightly raked trapezoid with a sloped top edge, bigger towards the trailing edge
    const L = p.len;
    const poly = roundPoly(
      [
        L * 0.5, -p.down * 0.7,
        L * 0.5, p.up * 0.85,
        L * 0.12, p.up,
        -L * 0.5, p.up * 0.78,
        -L * 0.5, -p.down,
        L * 0.1, -p.down,
      ],
      0.018,
    );
    const mk = (xo: number): void => {
      b.setPart(p.part ?? PART.body);
      // the extrusion runs towards -x from the frame origin
      b.extrude(poly, frame(xo, o.y, o.z - L * 0.18), th, 0.002, 1);
    };
    mk(o.halfSpan + th);
    mk(-o.halfSpan);
    // louvres (little carbon vanes on the outside face)
    b.setPart(PART.carbon);
    for (const sg of [-1, 1]) {
      const x = sg * (o.halfSpan + th + 0.004);
      for (let i = 0; i < 3; i++) b.box([x, o.y + p.up * (0.25 + 0.2 * i), o.z - L * 0.3 - 0.02 * i], 0.003, 0.012, L * 0.22);
    }
  }
  if (o.pylons) {
    for (const p of o.pylons) {
      b.setPart(PART.carbon);
      const w = p.width ?? 0.05;
      // swept pylon: a tall thin aerofoil-section plate from the body up to the wing
      const poly = roundPoly([0.1, 0, 0.12, 0.05, -0.08, o.y - p.bottomY - 0.02, -0.12, o.y - p.bottomY - 0.02, -0.14, 0.04, -0.02, 0], 0.012);
      b.extrude(poly, { o: [p.x + w / 2, p.bottomY, p.bottomZ], u: [0, 0, 1], v: [0, 1, 0] }, w, 0.004, 1);
    }
  }
}

/** Vertical diffuser strakes inside a tunnel: x positions, floor/roof heights, z range. */
export function addDiffuserStrakes(b: PartBuilder, xs: number[], y0: number, y1: number, z0: number, z1: number, rise = 0.04): void {
  b.setPart(PART.carbon);
  for (const x of xs) {
    // a sloped plate: low at the front, its roof lifting towards the rear
    const poly = [z1, y0 + 0.01, z0, y0 + 0.005, z0, y1 - rise, z1, y1];
    b.extrude(poly, { o: [x + 0.006, 0, 0], u: [0, 0, 1], v: [0, 1, 0] }, 0.012, 0.0015, 1);
  }
}
