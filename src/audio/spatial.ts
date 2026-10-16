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

// ─────────────────────────────────────────────────────────────────────────────
// Split screen: two people listening to one game
//
// WebAudio has one listener (seat 0's camera drives it). The second player's camera cannot be a second listener, so what the
// second player would hear is re-expressed in the first listener's frame: a sound that is 2 m ahead and 1 m to the right of
// seat 1's camera is put 2 m ahead and 1 m to the right of seat 0's. Each human's own car is worked out against their own
// camera (it sits just ahead of it, the way the single player's does); an opponent is heard by whichever human is nearer to it.
// ─────────────────────────────────────────────────────────────────────────────

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Gain of each human's car (engine and chassis voices) while two listen: two equal voices add up to twice the power of one, so
 * each gets 1/sqrt(2) of its level (0.7071) and a little more, because the two are never equally loud at the same moment and a
 * player should still hear their own car clearly. tests/audio-split.test.ts holds the measurement behind it: the real engine and
 * chassis synthesis in a standing start, mixed as the master graph does, against one untrimmed voice. Untrimmed, a Vanta GT beside
 * a second car is 2.3 dB (another Vanta), 1.6 dB (a Kestrel) and 3.9 dB (the LMP-X prototype) louder, with peaks up to 5.4 dB
 * higher; at 0.72 it is -0.5, -1.2 and +1.0 dB, and the peaks stay under the limiter's knee.
 */
export const SPLIT_PLAYER_TRIM = 0.72;

/**
 * The two human engines are told apart by a slight turn about the listener's up axis: seat 0's car 15 degrees to the left of
 * where it is, seat 1's 15 degrees to the right (2.3 dB between the channels with the equal-power panner). It holds for the
 * cameras that ride with the car and fades out between 10 and 30 m, so that a trackside camera still hears the car where it is.
 */
export const SPLIT_SEPARATION_DEG = 15;
const SEPARATION_RAD = (SPLIT_SEPARATION_DEG * Math.PI) / 180;

/** The orthonormal frame of a listener: right, up and forward (right = forward x up, as a camera looking down -Z has +X). */
interface Frame {
  rx: number;
  ry: number;
  rz: number;
  ux: number;
  uy: number;
  uz: number;
  fx: number;
  fy: number;
  fz: number;
}

function makeFrame(): Frame {
  return { rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, fx: 0, fy: 0, fz: -1 };
}

const _from = makeFrame();
const _to = makeFrame();

/** `b` = the frame of `L` (forward kept, up made square to it, both of unit length). */
function frameOf(L: ListenerState, b: Frame): Frame {
  let fx = L.fx;
  let fy = L.fy;
  let fz = L.fz;
  const fl = Math.hypot(fx, fy, fz);
  if (fl > 1e-9) {
    fx /= fl;
    fy /= fl;
    fz /= fl;
  } else {
    fx = 0;
    fy = 0;
    fz = -1;
  }
  let ux = L.ux;
  let uy = L.uy;
  let uz = L.uz;
  const d = ux * fx + uy * fy + uz * fz;
  ux -= d * fx;
  uy -= d * fy;
  uz -= d * fz;
  let ul = Math.hypot(ux, uy, uz);
  if (ul < 1e-6) {
    // looking straight along the up vector: any direction square to forward will do
    if (Math.abs(fy) < 0.9) {
      ux = -fx * fy;
      uy = fx * fx + fz * fz;
      uz = -fz * fy;
    } else {
      ux = 1;
      uy = 0;
      uz = 0;
      const e = ux * fx + uy * fy + uz * fz;
      ux -= e * fx;
      uy -= e * fy;
      uz -= e * fz;
    }
    ul = Math.hypot(ux, uy, uz) || 1;
  }
  ux /= ul;
  uy /= ul;
  uz /= ul;
  b.fx = fx;
  b.fy = fy;
  b.fz = fz;
  b.ux = ux;
  b.uy = uy;
  b.uz = uz;
  b.rx = fy * uz - fz * uy;
  b.ry = fz * ux - fx * uz;
  b.rz = fx * uy - fy * ux;
  return b;
}

/** Which of two listeners hears a sound at this place: the nearer one; at an equal distance seat 0. */
export function nearestListener(l0: ListenerState, l1: ListenerState, x: number, y: number, z: number): 0 | 1 {
  const d0 = (x - l0.px) * (x - l0.px) + (y - l0.py) * (y - l0.py) + (z - l0.pz) * (z - l0.pz);
  const d1 = (x - l1.px) * (x - l1.px) + (y - l1.py) * (y - l1.py) + (z - l1.pz) * (z - l1.pz);
  return d1 < d0 ? 1 : 0;
}

/** How much nearer the other listener has to be (as a share of the distance) before an opponent changes ears: no flip-flopping on the half way line. */
export const HEARER_HYSTERESIS = 0.9;

/** Which listener hears an opponent at this place: the one that has it now (`current`) until the other is clearly nearer. */
export function chooseHearer(l0: ListenerState, l1: ListenerState, x: number, y: number, z: number, current: 0 | 1): 0 | 1 {
  const d0 = (x - l0.px) * (x - l0.px) + (y - l0.py) * (y - l0.py) + (z - l0.pz) * (z - l0.pz);
  const d1 = (x - l1.px) * (x - l1.px) + (y - l1.py) * (y - l1.py) + (z - l1.pz) * (z - l1.pz);
  const h2 = HEARER_HYSTERESIS * HEARER_HYSTERESIS;
  return current === 0 ? (d1 < d0 * h2 ? 1 : 0) : d0 < d1 * h2 ? 0 : 1;
}

/**
 * Move a point from the frame of listener `from` to the frame of listener `to`: the same distance ahead, to the right and above,
 * seen from the other head. With `swing` radians (positive = to the right) the point is first turned about the up axis of
 * `from`, which is how the two human voices are told apart. Writes `out` (which may not be the input) and returns it.
 */
export function transplant(from: ListenerState, to: ListenerState, x: number, y: number, z: number, swing: number, out: Vec3): Vec3 {
  if (from === to && swing === 0) {
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  }
  const a = frameOf(from, _from);
  const dx = x - from.px;
  const dy = y - from.py;
  const dz = z - from.pz;
  let right = dx * a.rx + dy * a.ry + dz * a.rz;
  const up = dx * a.ux + dy * a.uy + dz * a.uz;
  let ahead = dx * a.fx + dy * a.fy + dz * a.fz;
  if (swing !== 0) {
    const c = Math.cos(swing);
    const s = Math.sin(swing);
    const r2 = right * c + ahead * s;
    ahead = ahead * c - right * s;
    right = r2;
  }
  const b = from === to ? a : frameOf(to, _to);
  out.x = to.px + right * b.rx + up * b.ux + ahead * b.fx;
  out.y = to.py + right * b.ry + up * b.uy + ahead * b.fy;
  out.z = to.pz + right * b.rz + up * b.uz + ahead * b.fz;
  return out;
}

/** The turn (radians) that sets a human car apart from the other's at this distance from the ear: left for seat 0, right for seat 1. */
export function separationSwing(seat: 0 | 1, distance: number): number {
  const w = 1 - smoothstep(10, 30, distance);
  return (seat === 1 ? SEPARATION_RAD : -SEPARATION_RAD) * w;
}

/** Where a car's sound goes while two people listen (see CarSoundImpl.update): the engine's panner and the car's own place. */
export interface SplitPlace {
  x: number;
  y: number;
  z: number;
  cx: number;
  cy: number;
  cz: number;
}

export function makeSplitPlace(): SplitPlace {
  return { x: 0, y: 0, z: 0, cx: 0, cy: 0, cz: 0 };
}

const _pt: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * `sp` is computeSpatial's answer for the car against the listener `heard` (the human's own for a human's car, the nearer one for
 * an opponent); this puts the engine's panner (`sp.x..z`) and the car (`carX..Z`, for the chassis voice of an opponent) where the
 * real listener, `ref` (seat 0's), hears them. A human's car also gets the left / right swing of its seat.
 */
export function placeSplit(ref: ListenerState, heard: ListenerState, seat: 0 | 1, isPlayer: boolean, sp: SpatialOut, carX: number, carY: number, carZ: number, out: SplitPlace): SplitPlace {
  const swing = isPlayer ? separationSwing(seat, sp.distance) : 0;
  transplant(heard, ref, sp.x, sp.y, sp.z, swing, _pt);
  out.x = _pt.x;
  out.y = _pt.y;
  out.z = _pt.z;
  transplant(heard, ref, carX, carY, carZ, 0, _pt);
  out.cx = _pt.x;
  out.cy = _pt.y;
  out.cz = _pt.z;
  return out;
}
