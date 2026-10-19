/**
 * What a body style module provides to the builder. Pure data/functions, worker-safe.
 *
 * Zone layout written by `zones()` (16 floats per vertex, four vec4 attributes aZ0..aZ3):
 *   z0: win   trim   carbon  grille      signed distances in metres, negative = inside the zone
 *   z1: head  drlU   tail    rev          drlU = signed offset across the DRL strip (see shapes.strip2)
 *   z2: panelA panelB panelC panelD       signed distances to shut-line outlines (|sd| small = a gap line)
 *   z3: ao    part   stopU   ext          ao 0..1; part id of static parts; stopU = signed offset across the brake-only strip;
 *                                         ext = along-strip extent (negative inside) shared by the DRL and the brake strip
 */
import type { CarVisualSpec } from '../core/contracts';
import type { FieldFn } from './sdf';
import type { PartBuilder } from './parts';

export const ZONE_STRIDE = 16;

/** Part ids stored in z3.y for static (non-SDF) geometry. */
export const PART = {
  body: 0,
  carbon: 1,
  plastic: 2,
  chrome: 3,
  rubber: 4,
  accent: 5,
  mirrorGlass: 6,
  titanium: 7,
  lampRed: 8,
  lampWhite: 9,
  paintDark: 10,
  silver: 11,
  lampAmber: 12,
  /** LED light bar: a dark housing with a lens that lights with the headlamps (the Mammoth's roof bar). */
  lightBar: 13,
  /** textured black plastic (bolted flares, rock sliders, bumper steps): a moulded grain on the matte black. */
  rugged: 14,
  /** the livery's accent colour on hardware that must not crumple in a crash (tow hooks, the spare's ring, the badge's X): satin, not clearcoat */
  signal: 15,
  // wheel parts (wheel shader)
  tire: 20,
  rimFace: 22,
  rimBarrel: 23,
  disc: 24,
  hub: 25,
  blurDisc: 26,
  nut: 27,
  discHat: 28,
  caliper: 29,
  shield: 30,
} as const;

export interface Blueprint {
  /** Polygonization bounds (m, body frame). */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /** Outer body field, x-symmetric. Negative inside. */
  body: FieldFn;
  /** Zone fields at a surface point (unit normal n). Writes ZONE_STRIDE floats at out[o..]; leave ao/part for the builder. */
  zones(x: number, y: number, z: number, nx: number, ny: number, nz: number, out: Float32Array, o: number): void;
  /** Static, non-SDF geometry (wings, splitters, mirrors, exhaust tips…). */
  parts?(b: PartBuilder): void;
  /** Numbers the main thread needs that were measured on the sculpted surface. */
  info?: BlueprintInfo;
  /** Named sub-fields for tests / debugging only. */
  debug?: Record<string, FieldFn>;
}

export interface BlueprintInfo {
  /** headlight projector sphere: |x|, y, z, radius */
  projector: [number, number, number, number];
}

export type BlueprintFactory = (spec: CarVisualSpec) => Blueprint;
