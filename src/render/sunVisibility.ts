/**
 * Sun visibility map (owner: render). Pure maths, no three.js: where terrain hides the sun.
 *
 * The cascaded shadow maps (shadows.ts) only reach a few hundred metres and only carry what casts into them: the terrain does not.
 * So a low sun that has set behind a ridge two kilometres away would still glint on the cars and light the grass. This module
 * answers the question the cascades cannot, for the whole height field, with one texture lookup per fragment.
 *
 * What is stored: the HORIZON HEIGHT. For the sun's direction (azimuth a, elevation E) a ray from a point (x, y, z) climbs
 * `tan E` metres per horizontal metre toward the sun, so it clears the terrain T unless, somewhere along the way, the ground
 * stands above it:
 *
 *     lit  <=>  y >= H(x, z),    H(x, z) = max over u > 0 of [ T(p + u a) - u tan E ]
 *
 * H depends on the column (x, z) only, not on y, so ONE 2D texture holds the answer for every height: a road at ground level, a
 * car roof, a tree top, the sun-facing flank of a far hill (H is below it), a lake (H is above it in the shadow of a ridge), and
 * the air along a view ray. Computing H is a running maximum along lines parallel to the sun's azimuth (H(p) = max(T(p + s a),
 * H(p + s a)) - s tan E): one pass over the grid, no marching per texel. The grid is therefore laid out in the SUN'S FRAME (u along
 * the sun, v across), so the sweep is a plain scan of every row, with no interpolation between rows to blur a narrow ridge, and
 * the height field is sampled exactly where the grid has its nodes.
 *
 * The sun is a disc, not a point: the disc's lower limb is at E - r and its upper limb at E + r (r = the drawn disc's angular
 * radius, sky.ts). Two sweeps run at once, one per limb, and the visible share of the disc comes out of where a point stands
 * between them. Each sweep stores not only its height H but the DISTANCE u to the ground that sets it, which is the slope of the
 * horizon line in height: an occluder at distance u gives H(tan s) = Z - u tan s, a straight line in the elevation. So the map
 * holds, per node, the two lines the disc's limbs are cut by,
 *
 *     lower limb: H_lo and 1/(u_lo dt)         upper limb: H_hi and 1/(u_hi dt)         (dt = tan(E + r) - tan(E - r))
 *
 * and a point at height y sees the disc between q = 0 (the whole disc) and q = 1 (none of it) with
 *
 *     q = max( (H_lo - y) / (u_lo dt),  1 + (H_hi - y) / (u_hi dt) )
 *
 * which is the horizon's elevation across the disc, taken from the ground that is highest against the lower limb and the ground
 * that is highest against the upper one (they are one and the same for a single ridge, and two different hills for the road at
 * the foot of a bank with a far mountain behind: then the near one sets the dark edge and the far one the light edge, and the
 * share between is the share of the disc above the higher of the two horizons, which a plain "between the two heights" would
 * get badly wrong). The penumbra comes out of the geometry: a ridge `D` metres away has `H_lo - H_hi = D dt`, 27 m of height for a
 * ridge 1 km away and 0.5 m for an embankment at 20 m. The visible share at q is the area of the disc above a straight horizon
 * (smoothstep is within 2 % of it).
 *
 * Two grids: a COARSE one over all the terrain that is drawn (it is what hides the sun; nothing beyond it exists), and a FINE
 * one around the circuit (the fragments the player looks at), whose rows start where the coarse map left off: its far field is
 * the coarse map's, its near field is its own. Four floats per node: H_lo - yRef, H_hi - yRef, 1/(u_lo dt), 1/(u_hi dt).
 *
 * The GLSL that samples the same data lives in shaderPatches.ts (SUNVIS_PARS); `sampleSunVisibility` below is its CPU twin
 * (the cascade shadow pass is skipped while the car stands in the terrain's shade, the tests and the probes read it).
 */

export interface SunRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** What the map is made from. */
export interface SunTerrain {
  /** Ground height (m) at a world position: the natural terrain and the road's carve. Defined everywhere, but only `extent` is drawn. */
  height(x: number, z: number): number;
  /** The ground that exists (is drawn): hides the sun inside it, and nothing beyond. */
  extent: SunRect;
  /** The circuit: the area that needs the fine map (the grid takes a margin around it). */
  focus: SunRect;
}

export interface SunVisOptions {
  /** Cell of the coarse grid over `extent` (m). */
  coarseCell?: number;
  /** Cell of the fine grid around `focus` (m). */
  fineCell?: number;
  /** Margin around `focus` the fine grid covers (m). */
  fineMargin?: number;
  /** Largest grid in nodes, width x height (the cell grows to fit), and the most nodes in all. */
  maxCoarse?: [number, number, number];
  maxFine?: [number, number, number];
  /** Work that stays within this many ms between two calls of `yieldFn`. */
  sliceMs?: number;
}

/**
 * The two grids are packed into one atlas (sunVisMap.ts), the fine block above the coarse one, 16 bytes a node. A fine cell of 4 m
 * covers 4 km x 2.5 km; a circuit that needs more takes a larger cell (a 3.2 km square, the worst the five circuits make, 5.5 m).
 */
export const SUNVIS_DEFAULTS = {
  coarseCell: 40,
  fineCell: 4,
  fineMargin: 140,
  maxCoarse: [1024, 384, 120000] as [number, number, number],
  maxFine: [1024, 640, 330000] as [number, number, number],
  sliceMs: 10,
};

/** Height of "no ground here": far below anything, so that a sample of it never hides the sun. */
export const NO_GROUND = -1e4;
/** Shift (m) of the tested height: the ground it stands on is a polygon approximation of the analytic one. */
export const HEIGHT_BIAS = 0.12;
/** Floats per node. */
export const SUNVIS_STRIDE = 4;
/** The share of a circuit's surroundings (the fine grid's nodes inside its bounds) the sun must not reach for the map to be put to use. */
export const ACTIVE_SHADE = 0.005;
/**
 * The share of the sun's in-scatter that the air in the shade of a hill keeps: the sky above the ridge is bright, and its glow lights the
 * shadowed air from the side. Without it the haze in front of a hidden sun would be the sky's multiple scattering alone, a dead teal.
 */
export const SHADE_HAZE_GLOW = 0.25;

/** One grid of the map. Node (i, j) sits at sun-frame position (u0 + i cell, v0 + j cell); `data` holds SUNVIS_STRIDE floats per node. */
export interface SunVisGrid {
  u0: number;
  v0: number;
  cell: number;
  w: number;
  h: number;
  /** [H_lo - yRef, H_hi - yRef, 1/(u_lo dt), 1/(u_hi dt)] per node, row-major (u fast). */
  data: Float32Array;
  /** Where the grid is in `data` when it shares an atlas with another: the index of node (0, 0) and the floats between two rows (default 0 and 4 w). */
  base?: number;
  rowStride?: number;
}

export interface SunVisField {
  /** Unit horizontal vector toward the sun (x, z); the sun frame is u = x ax + z az, v = -x az + z ax. */
  ax: number;
  az: number;
  /** Elevation of the disc's centre and its angular radius (rad). */
  elevation: number;
  radius: number;
  /** False while the whole disc is below the horizon: nothing is lit. */
  sunUp: boolean;
  /** Reference height the stored heights are relative to (keeps half floats usable). */
  yRef: number;
  coarse: SunVisGrid | null;
  fine: SunVisGrid | null;
  /** The map hides the sun from somewhere that is drawn: a sun that is visible from everywhere (noon) leaves it switched off. */
  active: boolean;
  /** Share of the circuit's surroundings the sun does not reach at all, 0..1: for the logs and the probes. */
  shadedFine: number;
}

/** A unit vector toward the sun -> its azimuth frame and elevation. */
export function sunFrame(dir: readonly [number, number, number]): { ax: number; az: number; elevation: number } {
  const hl = Math.hypot(dir[0], dir[2]);
  const elevation = Math.atan2(dir[1], hl);
  return hl > 1e-6 ? { ax: dir[0] / hl, az: dir[2] / hl, elevation } : { ax: 1, az: 0, elevation };
}

function rotatedBounds(r: SunRect, ax: number, az: number): { u0: number; u1: number; v0: number; v1: number } {
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const x of [r.minX, r.maxX]) {
    for (const z of [r.minZ, r.maxZ]) {
      const u = x * ax + z * az;
      const v = -x * az + z * ax;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
  }
  return { u0, u1, v0, v1 };
}

interface GridPlan {
  u0: number;
  v0: number;
  cell: number;
  w: number;
  h: number;
}

function planGrid(b: { u0: number; u1: number; v0: number; v1: number }, cell: number, max: [number, number, number]): GridPlan {
  const du = b.u1 - b.u0;
  const dv = b.v1 - b.v0;
  // (the grid has a node's margin on every side, and a 3 node margin of cells beyond the span: w = span / cell + 3)
  const c = Math.max(cell, du / (max[0] - 3), dv / (max[1] - 3), Math.sqrt((du * dv) / max[2]));
  return { u0: b.u0 - c, v0: b.v0 - c, cell: c, w: Math.ceil(du / c) + 3, h: Math.ceil(dv / c) + 3 };
}

/** The sweep's result for a grid: for both limbs the height of the horizon and the distance of the ground that makes it. */
interface Swept extends GridPlan {
  hLo: Float32Array;
  uLo: Float32Array;
  hHi: Float32Array;
  uHi: Float32Array;
}

/** Bilinear read of a node array at fractional node coordinates; `outside` beyond the grid. */
function bilinear(a: Float32Array, w: number, h: number, fi: number, fj: number, outside: number): number {
  if (fi < 0 || fj < 0 || fi > w - 1 || fj > h - 1) return outside;
  const i = Math.min(Math.floor(fi), w - 2);
  const j = Math.min(Math.floor(fj), h - 2);
  const tx = fi - i;
  const ty = fj - j;
  const k = j * w + i;
  return (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - ty) + (a[k + w] * (1 - tx) + a[k + w + 1] * tx) * ty;
}

/**
 * Sweep a grid: the heights of the ground at its nodes, the running maxima toward the sun for both limbs.
 * `far` (optional) gives what lies beyond the sunward end of a row (from a coarser grid): [H_lo, u_lo, H_hi, u_hi].
 */
async function sweep(
  g: GridPlan,
  terrain: SunTerrain,
  ax: number,
  az: number,
  tanLo: number,
  tanHi: number,
  far: ((u: number, v: number, out: number[]) => void) | null,
  tick: () => Promise<void>,
): Promise<Swept> {
  const { w, h, cell } = g;
  const n = w * h;
  const hLo = new Float32Array(n);
  const uLo = new Float32Array(n);
  const hHi = new Float32Array(n);
  const uHi = new Float32Array(n);
  const row = new Float32Array(w);
  const e = terrain.extent;
  const sLo = cell * tanLo;
  const sHi = cell * tanHi;
  const f = [NO_GROUND, 1, NO_GROUND, 1];
  for (let j = 0; j < h; j++) {
    const v = g.v0 + j * cell;
    // the ground under every node of the row (the analytic height field, not an interpolation of a coarser one)
    for (let i = 0; i < w; i++) {
      const u = g.u0 + i * cell;
      const x = u * ax - v * az;
      const z = u * az + v * ax;
      row[i] = x >= e.minX && x <= e.maxX && z >= e.minZ && z <= e.maxZ ? terrain.height(x, z) : NO_GROUND;
    }
    // the running maximum toward the sun: H(i) = max(T(i + 1), H(i + 1)) - cell tan E, over the nodes strictly sunward of i;
    // `d` is the distance to the node that sets it
    let rLo = NO_GROUND;
    let dLo = 1;
    let rHi = NO_GROUND;
    let dHi = 1;
    if (far) {
      f[0] = NO_GROUND;
      f[1] = 1;
      f[2] = NO_GROUND;
      f[3] = 1;
      far(g.u0 + w * cell, v, f);
      rLo = f[0];
      dLo = f[1];
      rHi = f[2];
      dHi = f[3];
    }
    const o = j * w;
    for (let i = w - 1; i >= 0; i--) {
      rLo -= sLo;
      dLo += cell;
      rHi -= sHi;
      dHi += cell;
      hLo[o + i] = rLo;
      uLo[o + i] = dLo;
      hHi[o + i] = rHi;
      uHi[o + i] = dHi;
      const t = row[i];
      if (t > rLo) {
        rLo = t;
        dLo = 0;
      }
      if (t > rHi) {
        rHi = t;
        dHi = 0;
      }
    }
    await tick();
  }
  return { u0: g.u0, v0: g.v0, cell, w, h, hLo, uLo, hHi, uHi };
}

/**
 * Node arrays -> the stored form: heights relative to yRef, and the slopes of the two horizon lines as 1 / (u dt). (A node's ground
 * is never nearer than one cell, so the slope is finite; an embankment 4 m away has a penumbra of 0.1 m of height, which the
 * ground's own slope along the sun turns into a metre or two of lawn, and the bilinear read into four.)
 */
function pack(g: Swept, yRef: number, dt: number): SunVisGrid {
  const n = g.w * g.h;
  const data = new Float32Array(n * SUNVIS_STRIDE);
  for (let k = 0; k < n; k++) {
    const o = k * SUNVIS_STRIDE;
    data[o] = g.hLo[k] - yRef;
    data[o + 1] = g.hHi[k] - yRef;
    data[o + 2] = 1 / (g.uLo[k] * dt);
    data[o + 3] = 1 / (g.uHi[k] * dt);
  }
  return { u0: g.u0, v0: g.v0, cell: g.cell, w: g.w, h: g.h, data };
}

/**
 * Make the map for a terrain and a sun. Deterministic. `yieldFn` (a loading screen's) is awaited between slices of `sliceMs`
 * of work, so a heavy track costs the frames of the loading screen and not a freeze.
 */
export async function computeSunVisibility(
  terrain: SunTerrain,
  dir: readonly [number, number, number],
  radius: number,
  opts: SunVisOptions = {},
  yieldFn?: () => Promise<void>,
): Promise<SunVisField> {
  const o = { ...SUNVIS_DEFAULTS, ...opts };
  const { ax, az, elevation } = sunFrame(dir);
  const field: SunVisField = { ax, az, elevation, radius, sunUp: elevation + radius > 0.0004, yRef: 0, coarse: null, fine: null, active: false, shadedFine: 0 };
  const fc = terrain.focus;
  field.yRef = terrain.height((fc.minX + fc.maxX) / 2, (fc.minZ + fc.maxZ) / 2);
  if (!field.sunUp) {
    // the whole disc is below the horizon: no light, and no sun in the haze either
    field.active = true;
    field.shadedFine = 1;
    return field;
  }
  // the lower limb never goes below a hair above the horizontal (a limb at the horizon would see no ground at all)
  const tanLo = Math.tan(Math.max(elevation - radius, 0.0008));
  const tanHi = Math.tan(Math.min(elevation + radius, 1.5));
  const dt = tanHi - tanLo;

  let last = performance.now();
  const tick = async (): Promise<void> => {
    if (!yieldFn) return;
    const now = performance.now();
    if (now - last < o.sliceMs) return;
    await yieldFn();
    last = performance.now();
  };

  // coarse: everything that is drawn
  const cb = rotatedBounds(terrain.extent, ax, az);
  const cp = planGrid(cb, o.coarseCell, o.maxCoarse);
  const coarse = await sweep(cp, terrain, ax, az, tanLo, tanHi, null, tick);

  // fine: the circuit and a margin, whose rows start from the coarse map's far field
  const m = o.fineMargin;
  const focus: SunRect = { minX: fc.minX - m, maxX: fc.maxX + m, minZ: fc.minZ - m, maxZ: fc.maxZ + m };
  const fb = rotatedBounds(focus, ax, az);
  const fp = planGrid(fb, o.fineCell, o.maxFine);
  const farFromCoarse = (u: number, v: number, out: number[]): void => {
    const fi = (u - coarse.u0) / coarse.cell;
    const fj = (v - coarse.v0) / coarse.cell;
    out[0] = bilinear(coarse.hLo, coarse.w, coarse.h, fi, fj, NO_GROUND);
    out[1] = bilinear(coarse.uLo, coarse.w, coarse.h, fi, fj, 1);
    out[2] = bilinear(coarse.hHi, coarse.w, coarse.h, fi, fj, NO_GROUND);
    out[3] = bilinear(coarse.uHi, coarse.w, coarse.h, fi, fj, 1);
  };
  const fine = await sweep(fp, terrain, ax, az, tanLo, tanHi, farFromCoarse, tick);

  field.coarse = pack(coarse, field.yRef, dt);
  field.fine = pack(fine, field.yRef, dt);

  // how much of the circuit's surroundings does the sun not reach? (nodes inside the focus rect only)
  let shaded = 0;
  let n = 0;
  const stepI = Math.max(1, Math.floor(fine.w / 160));
  const stepJ = Math.max(1, Math.floor(fine.h / 160));
  for (let j = 0; j < fine.h; j += stepJ) {
    for (let i = 0; i < fine.w; i += stepI) {
      const u = fine.u0 + i * fine.cell;
      const v = fine.v0 + j * fine.cell;
      const x = u * ax - v * az;
      const z = u * az + v * ax;
      if (x < fc.minX || x > fc.maxX || z < fc.minZ || z > fc.maxZ) continue;
      n++;
      const k = j * fine.w + i;
      // a node is in the shade where its ground stands below the height at which the sun's upper limb shows
      const ground = terrain.height(x, z);
      if (fine.hHi[k] > ground + HEIGHT_BIAS) shaded++;
    }
  }
  field.shadedFine = n > 0 ? shaded / n : 0;
  // Does the map hide the sun from the circuit? The sun is "visible" from a circuit while under ACTIVE_SHADE of its surroundings are out of
  // its reach: nothing is changed there, the picture is the old one bit for bit (what a hill hides from another hill far away, the back
  // side of a far mountain, is not worth touching a noon or a morning for).
  field.active = field.shadedFine >= ACTIVE_SHADE;
  return field;
}

/** Visible share of the sun's disc (0..1) for q in [0, 1] (0 = the horizon is below the disc, 1 = above it): a smoothstep of the area of a disc above a straight horizon. */
export function discShare(q: number): number {
  const c = q < 0 ? 1 : q > 1 ? 0 : 1 - q;
  return c * c * (3 - 2 * c);
}

type Node4 = { a: number; b: number; c: number; d: number };
const _g: Node4 = { a: 0, b: 0, c: 0, d: 0 };
const _g2: Node4 = { a: 0, b: 0, c: 0, d: 0 };

/** Bilinear (H_lo - yRef, H_hi - yRef, 1/(u_lo dt), 1/(u_hi dt)) of a grid at sun-frame position (u, v); false outside its nodes. */
export function readGrid(g: SunVisGrid, u: number, v: number, out: Node4): boolean {
  const fi = (u - g.u0) / g.cell;
  const fj = (v - g.v0) / g.cell;
  if (fi < 0.0 || fj < 0.0 || fi > g.w - 1 || fj > g.h - 1) return false;
  const i = Math.min(Math.floor(fi), g.w - 2);
  const j = Math.min(Math.floor(fj), g.h - 2);
  const tx = fi - i;
  const ty = fj - j;
  const d = g.data;
  const s = g.rowStride ?? SUNVIS_STRIDE * g.w;
  const k = (g.base ?? 0) + j * s + SUNVIS_STRIDE * i;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  out.a = d[k] * w00 + d[k + 4] * w10 + d[k + s] * w01 + d[k + s + 4] * w11;
  out.b = d[k + 1] * w00 + d[k + 5] * w10 + d[k + s + 1] * w01 + d[k + s + 5] * w11;
  out.c = d[k + 2] * w00 + d[k + 6] * w10 + d[k + s + 2] * w01 + d[k + s + 6] * w11;
  out.d = d[k + 3] * w00 + d[k + 7] * w10 + d[k + s + 3] * w01 + d[k + s + 7] * w11;
  return true;
}

/** How far inside its fine grid's edge (in nodes) the map stops trusting it and fades to the coarse one. */
export const FINE_BLEND_NODES = 6;

/**
 * The share of the sun's disc a point at world position (x, y, z) sees: 1 in the open, 0 behind a hill. The CPU twin of the GLSL in
 * shaderPatches.ts (same maths, same fade between the grids).
 */
export function sampleSunVisibility(f: SunVisField, x: number, y: number, z: number): number {
  if (!f.sunUp) return 0;
  if (!f.coarse) return 1;
  const u = x * f.ax + z * f.az;
  const v = -x * f.az + z * f.ax;
  let have = false;
  const r = _g;
  const fg = f.fine;
  if (fg) {
    const fi = (u - fg.u0) / fg.cell;
    const fj = (v - fg.v0) / fg.cell;
    // inside the nodes; weight 1 deeper than FINE_BLEND_NODES, fading to the coarse map toward the edge
    const e = Math.min(fi, fj, fg.w - 1 - fi, fg.h - 1 - fj);
    if (e >= 0 && readGrid(fg, u, v, r)) {
      have = true;
      const wf = Math.min(1, e / FINE_BLEND_NODES);
      if (wf < 1 && readGrid(f.coarse, u, v, _g2)) {
        const s = wf * wf * (3 - 2 * wf);
        r.a = _g2.a + (r.a - _g2.a) * s;
        r.b = _g2.b + (r.b - _g2.b) * s;
        r.c = _g2.c + (r.c - _g2.c) * s;
        r.d = _g2.d + (r.d - _g2.d) * s;
      }
    }
  }
  if (!have) {
    if (!readGrid(f.coarse, u, v, r)) return 1;
  }
  const yy = y + HEIGHT_BIAS - f.yRef;
  const q = Math.max((r.a - yy) * r.c, 1 + (r.b - yy) * r.d);
  return discShare(q);
}

/** Samples along a view ray for the sunlit share of the haze (the GLSL uses the same number). */
export const HAZE_TAPS = 5;
/** Below this fog factor the haze is too thin to be worth looking at. */
export const HAZE_MIN_FOG = 0.012;

/**
 * The share (0..1) of the sun's in-scatter along a view ray that is sunlit: the mean visibility of HAZE_TAPS points of the ray,
 * placed so that each carries the same share of the fog (the haze in front of a surface is mix(surface, fog, F) with
 * F = 1 - exp(-density^2 z^2 - rain z) over the planar depth z, so the in-scattered light of the ray is spread over z as dF/dz:
 * equal steps of F are equal shares of it). 1 when the whole ray is in the sun, 0 when none of it is.
 *
 * `depth` is the fragment's depth along the view axis (what the fog uses), `dist` its distance from the eye, `dir` the unit vector
 * toward it. The CPU twin of xrSunHaze in shaderPatches.ts.
 */
export function hazeSunShare(f: SunVisField, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number, depth: number, dist: number, density: number, rain: number): number {
  const d2 = density * density;
  const fog = 1 - Math.exp(-d2 * depth * depth - rain * depth);
  if (fog < HAZE_MIN_FOG) return 1;
  const stretch = dist / Math.max(depth, 1e-4);
  let sum = 0;
  for (let k = 0; k < HAZE_TAPS; k++) {
    const q = Math.min(0.999, ((k + 0.5) / HAZE_TAPS) * fog);
    const l = -Math.log(1 - q);
    // d2 z^2 + rain z = l
    const z = d2 > 1e-12 ? (-rain + Math.sqrt(rain * rain + 4 * d2 * l)) / (2 * d2) : l / Math.max(rain, 1e-6);
    const r = z * stretch;
    sum += sampleSunVisibility(f, cx + dx * r, cy + dy * r, cz + dz * r);
  }
  return sum / HAZE_TAPS;
}

/**
 * One channel of the haze colour with the sun's part scaled by the sunlit share of the view ray: `total` is the colour the fog table
 * gives (the sun's in-scatter plus the sky's), `sun` the sun's part of it, `share` what hazeSunShare says. Exactly `total` where the
 * ray is in the sun (share 1: the old colour bit for bit), the sky's part and `glow` of the sun's where none of it is (the glow of the
 * sky above the ridge lights the shadowed air from the side: SHADE_HAZE_GLOW). The CPU twin of xrFogColorLit.
 */
export function sunlitHaze(total: number, sun: number, share: number, glow = SHADE_HAZE_GLOW): number {
  const c = total - sun * (1 - share) * (1 - glow);
  return c > 0 ? c : 0;
}
