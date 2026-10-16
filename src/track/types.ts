/**
 * Track definition types (headless). A track is authored as:
 *   - a PLAN made of straights and turns (clothoid transitions => curvature-continuous centerline),
 *     closed exactly by solving the lengths of a few "free" straights,
 *   - an ELEVATION profile (PVIs with parabolic vertical curves),
 *   - bank / width keys (smoothly interpolated),
 *   - ZONES painting curbs, runoff bands and barriers per side along s,
 *   - terrain parameters and scenery lists (consumed by the visual builders).
 */
import type { TrackInfo } from '../core/contracts';

export type Surf = 'asphalt' | 'curb' | 'concrete' | 'grass' | 'gravel' | 'sand' | 'dirt' | 'snow' | 'ice' | 'deepsnow';
export const SURF_CODE: Record<Surf, number> = { asphalt: 0, curb: 1, concrete: 2, grass: 3, gravel: 4, sand: 5, dirt: 6, snow: 7, ice: 8, deepsnow: 9 };
export const SURF_NAME: Surf[] = ['asphalt', 'curb', 'concrete', 'grass', 'gravel', 'sand', 'dirt', 'snow', 'ice', 'deepsnow'];

export type BarrierKind = 'none' | 'armco' | 'tires' | 'concrete' | 'fence' | 'guardrail' | 'rock' | 'cable' | 'hedge' | 'tunnel' | 'snowbank';
export const BAR_CODE: Record<BarrierKind, number> = {
  none: 0,
  armco: 1,
  tires: 2,
  concrete: 3,
  fence: 4, // concrete wall topped with catch fencing
  guardrail: 5,
  rock: 6,
  cable: 7,
  hedge: 8,
  tunnel: 9,
  snowbank: 10, // a heap of ploughed snow: a soft barrier that slows a car and does not bounce it
};
export const BAR_NAME: BarrierKind[] = ['none', 'armco', 'tires', 'concrete', 'fence', 'guardrail', 'rock', 'cable', 'hedge', 'tunnel', 'snowbank'];
/** How soft a barrier is by kind code (TrackPoint.softLeft / softRight): 0 = a wall, 1 = a snowbank. */
export const BAR_SOFT: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];

export type CurbKind = 'none' | 'apex' | 'exit' | 'chicane';
export const CURB_CODE: Record<CurbKind, number> = { none: 0, apex: 1, exit: 2, chicane: 3 };
/** Curb relief by kind code (0 none, 1 apex ridged, 2 exit shallow, 3 chicane serrated): base ramp height and ridge amplitude (m). Sum <= 0.04. */
export const CURB_BASE = [0, 0.01, 0.008, 0.012];
export const CURB_AMP = [0, 0.016, 0.008, 0.016];
/** Ridge period along s (m) and maximum lateral ramp width (m) of a curb. */
export const RIDGE_PERIOD = 0.6;
export const CURB_RAMP_MAX = 0.5;
/** Lateral ramp width for a curb of width cw. */
export function curbRamp(cw: number): number {
  return Math.min(CURB_RAMP_MAX, cw * 0.4);
}

/** A mark in plan coordinates: 'T1' (start of element), 'T1/a' (arc start), 'T1/m', 'T1/b' (arc end), 'T1/e' (end), or [mark, offsetMeters]. */
export type Mark = string | readonly [string, number];

export interface Band {
  surf: Surf;
  w: number;
}

export type SideSel = 'L' | 'R' | 'B';

export interface StraightEl {
  k: 'S';
  n: string;
  len: number;
  /** The loop is closed by solving the length of the free straights (need at least two, non parallel). */
  free?: boolean;
}

export interface TurnEl {
  k: 'T';
  n: string;
  /** Signed degrees, + = left. 'auto' takes whatever closes the loop to +-360. */
  a: number | 'auto';
  r: number;
  /** Optional exit radius (compound / decreasing-radius corner). */
  r2?: number;
  /** Clothoid length at each end (m). Default depends on radius. */
  ls?: number;
  /** Per-end overrides (0 = no transition, to join two arcs of equal radius seamlessly). */
  lsIn?: number;
  lsOut?: number;
  /** Curb overrides ('none' to suppress). Defaults: apex on the inside, exit on the outside. */
  curbIn?: CurbKind;
  curbOut?: CurbKind;
  /** Where the corner "zone" (curbs, runoff styling) starts/ends relative to the turn's start/end. */
  zoneBefore?: number;
  zoneAfter?: number;
  /** Runoff styling for the corner zone: sides relative to the corner (inside/outside). */
  inside?: SideStyle;
  outside?: SideStyle;
}
export type PlanEl = StraightEl | TurnEl;

export interface SideStyle {
  bands?: Band[];
  barrier?: BarrierKind;
  cross?: number;
}

export interface Zone {
  side: SideSel;
  from: Mark;
  to: Mark;
  curb?: CurbKind;
  curbW?: number;
  bands?: Band[];
  barrier?: BarrierKind;
  cross?: number;
}

export interface Pvi {
  at: Mark;
  /** Elevation of the vertex (m). Omit when `grade` is given. */
  y?: number;
  /** Alternative to `y`: constant grade (rise/run) from the previous PVI (sorted by s) to this one. */
  grade?: number;
  /** Vertical curve length (m), centered on the vertex. */
  vc?: number;
}
export interface Key {
  at: Mark;
  v: number;
}

export interface TerrainBump {
  x: number;
  z: number;
  r: number;
  h: number;
}

export interface LakeDef {
  x: number;
  z: number;
  rx: number;
  rz: number;
  rot: number; // radians
  /** Water surface elevation. */
  level: number;
  /** Maximum depth below the water surface. */
  depth: number;
  /** Shore softness (m). */
  shore: number;
}

/**
 * A frozen lake: a flat plateau at `level` (the ice) in an ellipse laid along the road at a mark; the ground blends into it over
 * `shore` metres. The road that crosses it is at `level` too (the elevation of the lake stretch is flat), and its surface is ice
 * (`WinterDef.patches`).
 */
export interface FrozenLakeDef {
  /** The middle of the lake: this mark of the circuit, `d` m to its left. */
  at: Mark;
  d?: number;
  /** Half-axes (m) of the ellipse along the road at the mark, and across it. */
  along: number;
  across: number;
  /** Ice surface elevation (m). */
  level: number;
  /** Shore softness (m). */
  shore: number;
}

/**
 * A winter circuit: the road is packed snow with stretches of something else (the ice of a frozen lake), the ground beyond the
 * barriers is deep snow. The physics reads the surfaces; the scene builds snow, ice and snowbanks (src/track/scene/winter.ts).
 */
export interface WinterDef {
  /** The surface of the road (default packed snow). */
  road?: Surf;
  /** Stretches of the road with another surface (ice). */
  patches?: { from: Mark; to: Mark; surf: Surf }[];
  /** The ground beyond the barriers (default deep snow). */
  ground?: Surf;
}

/** Linear tilt with soft floor/ceiling: contributes smoothClamp(h0 + gx (x - x0) + gz (z - z0), lo, hi). */
export interface Tilt {
  x0: number;
  z0: number;
  h0: number;
  gx: number;
  gz: number;
  lo: number;
  hi: number;
  soft: number;
}

/** An axis-aligned rectangle on the harbour map (east, north in metres): [east0, north0, east1, north1]. */
export type MapRect = readonly [number, number, number, number];

/**
 * A harbour: the sea as rectangles on the map (east, north; the map frame of the layout: east = -x, north = +z), with the land that
 * stands in it (piers, moles). The terrain drops into water inside and is levelled to the quay height around it.
 */
export interface SeaDef {
  /** Water surface and quay top elevation (m). */
  level: number;
  quay: number;
  water: MapRect[];
  land: MapRect[];
  /** How far from the water's edge the ground is levelled to the quay (m). */
  levelled: number;
}

export interface TerrainParams {
  seed: number;
  sea?: SeaDef;
  /** Large-scale slopes (mountain flanks, ridges). */
  tilts?: Tilt[];
  /** Mean ground level near the track (m). */
  base: number;
  /** Rolling hills. */
  hillAmp: number;
  hillScale: number;
  /** Small-scale roughness amplitude (m) and wavelength (m). */
  detailAmp: number;
  detailScale: number;
  lake?: LakeDef;
  /** A frozen lake (see FrozenLakeDef), placed by mark. */
  frozen?: FrozenLakeDef;
  bumps?: TerrainBump[];
  /** Bumps placed by track mark (resolved after the plan is built): lateral offset d, radius r, height h. */
  bumpsAt?: { at: Mark; d?: number; r: number; h: number }[];
  /** Far mountains: begin rising beyond `start` metres from the track bounds center. */
  mountains?: { start: number; full: number; amp: number; scale: number };
  /** Carve smoothing: how far the road's elevation influences the surrounding ground (m), and how far the effect is tracked. */
  reach: number;
  /** Optional lower-bound for the road cut/fill falloff (smaller = steeper embankments). */
  falloff?: number;
  /** Metres beyond the barrier where the profile finishes blending into the terrain (default 5.5; use more on steep ground). */
  xfade?: number;
}

export interface TunnelDef {
  from: Mark;
  to: Mark;
  /** Colour the lining is multiplied by (default white: the grey tiled lining under cold lamps). */
  lining?: number;
  /** Portal concrete colour (default a sooty grey). A portal of its own colour is floodlit: it keeps a glow after dark. */
  portal?: number;
  /**
   * The ground over the tube is at least this high above the road (m) with a gently varying crown, instead of the rough crown that
   * stands out of the ground (default): for a hill the terrain already makes (trees and a castle stand on it).
   */
  cover?: number;
}

export interface TrackDef {
  info: TrackInfo;
  seed: number;
  /** +1 = counter-clockwise overall (net left turn), -1 = clockwise. */
  dir: 1 | -1;
  plan: PlanEl[];
  /** World position / heading of the start-finish line (the plan is built from there). Default: origin, heading +Z. */
  start?: { x: number; z: number; phi: number };
  pvi: Pvi[];
  /** Bank keys in degrees (+ = left edge higher). Interpolated with smootherstep between keys. */
  bank: Key[];
  /** Asphalt half-width keys (m). */
  widthL: Key[];
  widthR: Key[];
  /** Crown: edge cross-fall as a fraction (0.015 = 1.5 %). */
  crown?: number;
  defaults: { bandsL: Band[]; bandsR: Band[]; barrierL: BarrierKind; barrierR: BarrierKind; cross: number };
  /** Minimum width of runoff between the asphalt (incl. curb) and the barrier face (m). Default 3; mountain roads use 2. */
  minRunoff?: number;
  /** Painted curbs on corners (default true). */
  curbs?: boolean;
  /** Dashed centre line on the asphalt (mountain roads). */
  centerLine?: boolean;
  /** Mown stripes in the grass beside the track (default true). */
  mowing?: boolean;
  /** Pavement instead of grass beyond the barriers (a city: the sidewalks). */
  paved?: boolean;
  tunnels?: TunnelDef[];
  /** A winter circuit: snow, ice and snowbanks (the info says so too: `TrackInfo.winter`). */
  winter?: WinterDef;
  zones: Zone[];
  sectors: [Mark, Mark];
  terrain: TerrainParams;
  /** Visual-only configuration consumed by the scene builder. */
  scenery?: SceneryDef;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenery (visual only; no effect on the physics)
// ─────────────────────────────────────────────────────────────────────────────

export type SpeciesId = 'oak' | 'poplar' | 'pine' | 'birch' | 'palm';

export interface VegetationDef {
  species: [SpeciesId, number][];
  /** Maximum trees per 100 m^2 inside forests (before the quality / user scale). */
  density: number;
  /** Forest patches: noise threshold (lower = more forest) and patch size (m). */
  forestThreshold: number;
  forestScale: number;
  /** Keep this far (m) beyond the strip meshes, then ramp up over `ramp` metres. */
  clearance: number;
  ramp: number;
  /** Only place trees within this distance (m) of the strip meshes. */
  reach: number;
  /** Maximum ground slope (rise/run). */
  slopeMax: number;
  /** Tree height range (m) for the base species scale. */
  scale: number;
}

export interface StandDef {
  /** Where along the track (centre of the stand) and how long. */
  at: Mark;
  length: number;
  side: 'L' | 'R';
  /** Gap (m) between the barrier face and the stand's front row. */
  gap: number;
  rows: number;
  roof?: boolean;
  /** Advertising panels on the back wall (a stand seen from the other side, on a quay). */
  rearAds?: boolean;
  /** Seat tier height/depth (m). */
  rise?: number;
  depth?: number;
}

/** A hand-placed landmark on the harbour map (east, north in metres; yaw in degrees, 0 = facing north): see scene/landmarks.ts. */
export interface LandmarkDef {
  kind: 'cathedral' | 'castle' | 'lighthouse';
  /** On the map (east, north): `yaw` is then the compass direction the front faces. */
  e?: number;
  n?: number;
  /** Or on the road by mark, `d` metres to the left: `yaw` then turns the front away from the direction of travel (default 90). */
  at?: Mark;
  d?: number;
  yaw?: number;
  /** Uniform scale (default 1). */
  scale?: number;
}

/** A city lining the circuit: building rows along the streets, a skyline of blocks on the hillsides, palms and street furniture. */
export interface CityDef {
  seed?: number;
  /** Stretches of the circuit with no buildings beside the road (the quay, the tunnel hill ...). */
  open?: { from: Mark; to: Mark; side: SideSel }[];
  /** Pavement between the barrier and the facades (m): min, max. Default [3.2, 6]. */
  sidewalk?: [number, number];
  /** Storeys by stretch (default 3 to 6, in neighbourhoods). */
  floors?: { from: Mark; to: Mark; min: number; max: number; side?: SideSel }[];
  /** Rows of buildings behind the front row (default 2). */
  rows?: number;
  /** Distant blocks on the hillsides: how far from the circuit they reach (m) and how dense (0..1). */
  skyline?: { reach: number; density: number };
  /** Bunting strung across the road between two poles at these marks. */
  bunting?: Mark[];
  /** Palms along the streets. */
  palms?: { from: Mark; to: Mark; side: SideSel; spacing: number; /** Distance behind the barrier (m). */ gap?: number }[];
  /** Clumps of trees on open hillsides: an ellipse centred on the road at a mark, `along` the road and `across` it (half-extents, m). */
  groves?: { at: Mark; along: number; across: number; count: number; species: [SpeciesId, number][]; /** Ground this far above the road or more (m). */ minRise?: number }[];
  /** Stone arches across the street (a passage between two blocks) at these marks, `depth` m along the road (default 5.5). */
  arches?: { at: Mark; depth?: number }[];
  landmarks?: LandmarkDef[];
}

/** The harbour's dressing: boats at the quays, cranes, a lighthouse (positions on the map, see TerrainParams.sea). */
export interface HarbourDef {
  boats?: number;
  /** Cranes on the quays: map position and heading (degrees). */
  cranes?: { e: number; n: number; yaw?: number; scale?: number }[];
}

/** City road markings painted by the road shader (see makeRoadMaterial). Positions are marks along the circuit; `d` is the lateral offset (m, + = left). */
export type MarkingDef =
  | { kind: 'zebra'; at: Mark }
  | { kind: 'box'; at: Mark; len?: number }
  | { kind: 'arrow'; at: Mark; d: number; turn?: -1 | 0 | 1 }
  | { kind: 'manhole'; at: Mark; d: number };

export interface SceneryDef {
  /** Pedestrian crossings, yellow box junctions, lane arrows and manhole covers on the road. */
  markings?: MarkingDef[];
  city?: CityDef;
  harbour?: HarbourDef;
  vegetation?: VegetationDef;
  /** Stand rock faces on the uphill side of the road. */
  rockCuts?: boolean;
  stands?: StandDef[];
  /** Pit building along the start straight. */
  pits?: { from: Mark; to: Mark; side: 'L' | 'R' };
  /** Start-light gantry across the track at this mark. */
  gantry?: Mark;
  /** Corners that get a marshal post on the outside. */
  marshals?: string[];
  /** Lamp posts along the pit straight / at corners. */
  lamps?: {
    from: Mark;
    to: Mark;
    spacing: number;
    side: 'L' | 'R' | 'B';
    /** Pole height (m, default 13: a floodlight mast; city lamps are about 9) and arm length (default 2.2). All stretches share the first one's. */
    height?: number;
    arm?: number;
    /** Distance of the pole behind the barrier (m, default 1.6). */
    gap?: number;
    /** On both sides: alternate between them instead of facing pairs. */
    stagger?: boolean;
  }[];
  /** Large advertising boards [corner name, side, offset]. */
  boards?: { at: Mark; side: 'L' | 'R'; gap: number; brand: number }[];
  /** Braking-distance boards before corners (metres before the corner start). */
  brakeBoards?: { corner: string; dist: number[] }[];
  /** Extra TV camera platforms at these marks, beside the automatic ones (the corners, the start straight, long gaps): outside of a bend, else on the side with more room. */
  tvMarks?: Mark[];
  /**
   * Mountain-road signage. `chevrons`: yellow alignment boards on the outside of these corners (joined hairpin pairs
   * are named by their prefix, e.g. 'H1' for H1a + H1b); `warn`: hairpin warning triangles `dist` m before a corner;
   * `mirrors`: curve mirrors at the apex of these corners.
   */
  roadSigns?: { chevrons?: string[]; warn?: { corner: string; dist: number }[]; mirrors?: string[] };
  /** Pedestrian footbridges across the track (columns outside the barriers, advertising on both faces). */
  bridges?: { at: Mark; brand: number }[];
}
