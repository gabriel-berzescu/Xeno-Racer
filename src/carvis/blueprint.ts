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
  /** LED light bar: a dark housing, and a lens (the vertices flagged with zone channel 14 < 0) that lights with the headlamps: the Mammoth's roof bar and bumper pods. */
  lightBar: 13,
  /** textured black plastic (bolted flares, rock sliders, bumper steps): a moulded grain on the matte black. */
  rugged: 14,
  /** the livery's accent colour on hardware that must not crumple in a crash (tow hooks, the spare's ring, the badge's X): satin, not clearcoat */
  signal: 15,
  /**
   * the single-seater's halo: titanium under the livery's paint, so it takes the livery like the body but never crumples; its central
   * pillar is flagged with zone channel 14 < 0 (the cockpit view can tell it from the hoop)
   */
  halo: 16,
  /**
   * a red LED lens (the single-seater's rear-wing endplate lights): lit as a rear light with the tail lamps, pulsing while the electric
   * boost deploys, dark when the tail lamp of its side is broken; it crumples with the endplate it is on
   */
  ledRed: 17,
  /**
   * the single-seater's rain light, a red lamp block on the tip of its crash structure: steady in the wet and in the dark, never a brake
   * light, dimmed by each broken tail lamp; it crumples with the crash structure (the other cars' lamp blocks, PART.lampRed, are rigid)
   */
  rainLight: 18,
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
  /**
   * What the far LOD keeps of the parts (absent: nothing): a few coarse pieces that hold the silhouette when the car is a speck and in
   * the shadow it casts (the single-seater's wings, halo and helmet). Their baked colour is the livery's for PART.body and PART.halo,
   * dark for everything else.
   */
  farParts?(b: PartBuilder): void;
  /** Parts that move with the car's state, each drawn as a mesh of its own (absent: none). */
  moving?: MovingPart[];
  /** Numbers the main thread needs that were measured on the sculpted surface. */
  info?: BlueprintInfo;
  /** Named sub-fields for tests / debugging only. */
  debug?: Record<string, FieldFn>;
}

/**
 * A part posed every frame by a hinge (the active aero's wing flaps): built like the static parts, in the body frame as it stands at
 * rest, and turned about `axis` through `pivot` by `angle` rad times what drives it (`aero`: VehicleState.aeroOpen, 0 corner mode ..
 * 1 straight mode).
 */
export interface MovingPart {
  name: string;
  drive: 'aero';
  pivot: [number, number, number];
  axis: [number, number, number];
  angle: number;
  build(b: PartBuilder): void;
}

export interface BlueprintInfo {
  /** headlight projector sphere: |x|, y, z, radius */
  projector: [number, number, number, number];
  /**
   * Where the four lamps are when they are not sculpted zones the damage model can find on the body (absent: found on the mesh):
   * headL, headR, tailL, tailR, each a centre and a radius.
   */
  lamps?: Array<{ c: [number, number, number]; r: number }>;
}

export type BlueprintFactory = (spec: CarVisualSpec) => Blueprint;
