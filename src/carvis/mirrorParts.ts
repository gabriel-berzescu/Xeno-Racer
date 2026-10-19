/**
 * Door mirrors for the car bodies (worker-safe, built with the PartBuilder like the rest of the static parts): an
 * egg-shaped housing, a stalk to the door and the glass face on its rear side, turned toward the driver as
 * mirrorLayout sets it. This is what every camera but the cockpit sees; in the cockpit the live glass (mirrors.ts)
 * sits a millimetre in front of the glass face drawn here.
 */
import type { CarVisualSpec } from '../core/contracts';
import { PART } from './blueprint';
import { glassOutline, mirrorLayout, type MirrorPose, type V3 } from './mirrorLayout';
import type { PartBuilder } from './parts';

/** The live glass is inset from the glass face by this much (a frame is left around it), as a share of the glass. */
export const GLASS_INSET = 0.95;

/** A point in the glass's own frame: a along its right, b along its up, t along its normal (negative = behind the glass). */
export function inGlassFrame(m: MirrorPose, a: number, b: number, t: number): V3 {
  return [
    m.pos[0] + m.right[0] * a + m.up[0] * b + m.normal[0] * t,
    m.pos[1] + m.right[1] * a + m.up[1] * b + m.normal[1] * t,
    m.pos[2] + m.right[2] * a + m.up[2] * b + m.normal[2] * t,
  ];
}

/** Both door mirrors of a car. */
export function addDoorMirrors(b: PartBuilder, spec: CarVisualSpec): void {
  const L = mirrorLayout(spec);
  addDoorMirror(b, L.left, L.housing.depth, L.housing.carbon, L.housing.black);
  addDoorMirror(b, L.right, L.housing.depth, L.housing.carbon, L.housing.black);
}

/** One housing + stalk + glass face. `depth` is how far the housing reaches forward of the glass. */
export function addDoorMirror(b: PartBuilder, m: MirrorPose, depth: number, carbon: boolean, black = false): void {
  const side = m.pos[0] >= 0 ? 1 : -1;
  const hw = m.halfW;
  const hh = m.halfH;
  const unit = glassOutline(1, 1, 28, 3.4);
  const at = (sx: number, sy: number, t: number): V3[] => unit.map(([x, y]) => inGlassFrame(m, x * hw * sx, y * hh * sy, t));

  // the housing: a half egg behind the glass, a little wider and taller than the glass so it leaves a rim
  const rings: V3[][] = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const phi = (i / steps) * (Math.PI / 2);
    const c = Math.cos(phi);
    rings.push(at(1.07 * c, 1.14 * c, -depth * Math.sin(phi)));
  }
  b.setPart(carbon ? PART.carbon : black ? PART.rugged : PART.body);
  b.loft(rings);

  // the face: a black frame, the glass in it
  b.setPart(PART.plastic);
  b.polygon3(at(1.07, 1.14, 0.0006), m.normal);
  b.setPart(PART.mirrorGlass);
  b.polygon3(at(GLASS_INSET, GLASS_INSET, 0.0016), m.normal);

  // stalk from the door to the housing
  b.setPart(PART.plastic);
  const door: V3 = [side * (Math.abs(m.pos[0]) - 0.155), m.pos[1] - 0.075, m.pos[2] - depth * 0.25];
  const base = inGlassFrame(m, 0, -hh * 0.8, -depth * 0.35);
  b.cylinder(door, base, 0.011, 0.015, 10, false);
}
