/**
 * Spatial audio math (pure, allocation-free): listener from a camera matrix, where a car's sound
 * should be placed, Doppler time-scale, air absorption, and level-of-detail tiers.
 */
import { clamp, smoothstep } from './dsp/util';

export const SPEED_OF_SOUND = 343;

export interface ListenerState {
  px: number;
  py: number;
  pz: number;
  /** forward (the camera looks down -Z) */
  fx: number;
  fy: number;
  fz: number;
  ux: number;
  uy: number;
  uz: number;
  vx: number;
  vy: number;
  vz: number;
}

export function makeListener(): ListenerState {
  return { px: 0, py: 0, pz: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0, vx: 0, vy: 0, vz: 0 };
}

/** Fill a listener from a column-major 4x4 world matrix (three.js Object3D.matrixWorld.elements). */
export function listenerFromMatrix(e: ArrayLike<number>, vx: number, vy: number, vz: number, out: ListenerState): void {
  out.px = e[12];
  out.py = e[13];
  out.pz = e[14];
  // -Z column = forward, +Y column = up (normalised: the camera may carry scale)
  let fx = -e[8];
  let fy = -e[9];
  let fz = -e[10];
  let l = Math.hypot(fx, fy, fz) || 1;
  out.fx = fx / l;
  out.fy = fy / l;
  out.fz = fz / l;
  let ux = e[4];
  let uy = e[5];
  let uz = e[6];
  l = Math.hypot(ux, uy, uz) || 1;
  out.ux = ux / l;
  out.uy = uy / l;
  out.uz = uz / l;
  out.vx = Number.isFinite(vx) ? vx : 0;
  out.vy = Number.isFinite(vy) ? vy : 0;
  out.vz = Number.isFinite(vz) ? vz : 0;
  fx = fy = fz = ux = uy = uz = 0;
}

export interface SpatialOut {
  /** Where to put the panner. */
  x: number;
  y: number;
  z: number;
  distance: number;
  /** Doppler time scale (>1 = approaching = pitch up). */
  timeScale: number;
  /** Air-absorption low-pass cutoff in Hz. */
  lpHz: number;
}

export function makeSpatialOut(): SpatialOut {
  return { x: 0, y: 0, z: 0, distance: 0, timeScale: 1, lpHz: 20000 };
}

/**
 * Compute where a car's sound sits relative to the listener. The player's own car is pulled
 * towards a point just ahead of the camera whenever the camera is close (cockpit / hood / chase),
 * so it stays centred and stable, and lets go smoothly for trackside / orbit cameras.
 */
export function computeSpatial(
  L: ListenerState,
  cx: number,
  cy: number,
  cz: number,
  cvx: number,
  cvy: number,
  cvz: number,
  isPlayer: boolean,
  out: SpatialOut,
): void {
  const dx = cx - L.px;
  const dy = cy - L.py;
  const dz = cz - L.pz;
  const d = Math.hypot(dx, dy, dz);
  out.distance = d;
  let x = cx;
  let y = cy;
  let z = cz;
  if (isPlayer) {
    const w = 1 - smoothstep(2.5, 7.5, d);
    x += (L.px + L.fx * 2.2 - cx) * w;
    y += (L.py + L.fy * 2.2 - cy) * w;
    z += (L.pz + L.fz * 2.2 - cz) * w;
  }
  out.x = x;
  out.y = y;
  out.z = z;
  // Doppler: f_obs / f_src = (c + v_listener . u) / (c + v_source . u), u = listener -> source
  let ts = 1;
  if (d > 0.5) {
    const inv = 1 / d;
    const ux = dx * inv;
    const uy = dy * inv;
    const uz = dz * inv;
    const vs = cvx * ux + cvy * uy + cvz * uz; // source moving away (+)
    const vl = L.vx * ux + L.vy * uy + L.vz * uz; // listener moving toward the source (+)
    ts = (SPEED_OF_SOUND + vl) / Math.max(SPEED_OF_SOUND + vs, 60);
    // attached cameras (chase / cockpit) have ~no relative motion; fade the effect in with distance
    ts = 1 + (ts - 1) * smoothstep(3, 12, d);
  }
  out.timeScale = clamp(ts, 0.7, 1.4);
  out.lpHz = clamp(18000 / (1 + d / 32), 2200, 18000);
}

export type Lod = 0 | 1 | 2;

/** Distances (m) for the tiers. Up to MAX_FULL_AI opponents get the full model. */
export const LOD_FULL_RADIUS = 80;
export const LOD_LITE_RADIUS = 150;
export const MAX_FULL_AI = 4;

/**
 * Assign tiers: the player is always full; the nearest AI cars inside LOD_FULL_RADIUS are full
 * (max MAX_FULL_AI), the rest inside LOD_LITE_RADIUS are lite, beyond that they are off.
 * `distances` holds one entry per AI car; `out` receives the tier per car.
 */
export function assignLod(distances: ArrayLike<number>, n: number, out: Lod[], order: number[]): void {
  order.length = n;
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => distances[a] - distances[b]);
  let full = 0;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    const d = distances[i];
    if (d > LOD_LITE_RADIUS) out[i] = 0;
    else if (d <= LOD_FULL_RADIUS && full < MAX_FULL_AI) {
      out[i] = 2;
      full++;
    } else out[i] = 1;
  }
}

/** Fade-out near the culling radius so voices never pop off. */
export function lodFade(d: number): number {
  return 1 - smoothstep(LOD_LITE_RADIUS * 0.8, LOD_LITE_RADIUS, d);
}
