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

export type Surf = 'asphalt' | 'curb' | 'concrete' | 'grass' | 'gravel' | 'sand' | 'dirt';
export const SURF_CODE: Record<Surf, number> = { asphalt: 0, curb: 1, concrete: 2, grass: 3, gravel: 4, sand: 5, dirt: 6 };
export const SURF_NAME: Surf[] = ['asphalt', 'curb', 'concrete', 'grass', 'gravel', 'sand', 'dirt'];

export type BarrierKind = 'none' | 'armco' | 'tires' | 'concrete' | 'fence' | 'guardrail' | 'rock' | 'cable' | 'hedge' | 'tunnel';
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
};
export const BAR_NAME: BarrierKind[] = ['none', 'armco', 'tires', 'concrete', 'fence', 'guardrail', 'rock', 'cable', 'hedge', 'tunnel'];

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

export interface TerrainParams {
  seed: number;
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
  tunnels?: TunnelDef[];
  zones: Zone[];
  sectors: [Mark, Mark];
  terrain: TerrainParams;
  /** Visual-only configuration consumed by the scene builder. */
  scenery?: SceneryDef;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenery (visual only; no effect on the physics)
// ─────────────────────────────────────────────────────────────────────────────

export type SpeciesId = 'oak' | 'poplar' | 'pine' | 'birch';

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
  /** Seat tier height/depth (m). */
  rise?: number;
  depth?: number;
}

export interface SceneryDef {
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
  lamps?: { from: Mark; to: Mark; spacing: number; side: 'L' | 'R' | 'B' }[];
  /** Large advertising boards [corner name, side, offset]. */
  boards?: { at: Mark; side: 'L' | 'R'; gap: number; brand: number }[];
  /** Braking-distance boards before corners (metres before the corner start). */
  brakeBoards?: { corner: string; dist: number[] }[];
  /** TV camera marks (default: auto from the corners). */
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
