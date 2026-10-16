/**
 * Proximity spotter: which side of the player's car has another car alongside or closing within about a car length,
 * and how close it is. Pure numbers (no three.js, no DOM), so the HUD can be driven from it and tests can pin it.
 *
 * Every other car is placed in the player's own horizontal frame (+x left, +z ahead) and the gaps between the two
 * bodies are measured on their footprints, not between their centres: a car that has turned broadside is longer
 * across than it is along. The threat of one car is the product of a lateral and a longitudinal window,
 *
 *   lateral       full up to a half-metre gap, gone at four metres (about one lane away)
 *   longitudinal  full while the bodies overlap along the track, then falling off over a car length behind
 *                 (longer when it is closing fast, so a car diving past you is seen early) and
 *                 about a metre and a half ahead
 *
 * and cars that sit right behind in your own lane never count (they are in the mirror, not beside you).
 *
 * Both windows are smoothstep ramps, never a hard threshold, and the per-side output follows the target with a quick
 * attack and a slow release, so a car hovering at the edge of the window gives a steady dim glow instead of flicker.
 */

export interface SpotterBody {
  position: { x: number; y: number; z: number };
  /** Orientation, car frame +Z forward, +X left (VehicleState.quaternion). */
  quaternion: { x: number; y: number; z: number; w: number };
  velocity: { x: number; y: number; z: number };
  /** Footprint half sizes (m): along and across the car. */
  halfLength: number;
  halfWidth: number;
}

export interface SpotterSide {
  /** 0 = nothing near .. 1 = touching; smoothed. */
  level: number;
  /** Where along the player's car the nearest car is, -1 = back (behind) .. +1 = front (ahead); smoothed. */
  at: number;
}

export interface SpotterState {
  left: SpotterSide;
  right: SpotterSide;
}

export const SPOTTER = {
  /** Lateral window, as the gap between the two bodies (m): full up to `latFull`, gone at `latNone`. */
  latFull: 0.5,
  latNone: 4,
  /** A car this far into the player's lane (m of lateral overlap) or more is behind or ahead, not beside. */
  sameLaneOverlap: 0.9,
  /** Longitudinal windows (m of gap between the bodies along the track). */
  behind: 4.6,
  ahead: 1.5,
  /** The behind window grows by this many seconds of closing speed, up to `closeMax` m/s. */
  closeSeconds: 0.35,
  closeMax: 20,
  /** Cars further than this (m, centre to centre) cannot matter. */
  cullLong: 26,
  cullLat: 12,
  /** The aid is silent below this speed and fully on from `speedFull` (m/s). */
  speedMin: 2,
  speedFull: 8,
  /** Display smoothing (s). */
  attack: 0.05,
  release: 0.32,
  atTau: 0.12,
  /** Longitudinal offset (m) that moves the glow to the end of its track. */
  atRange: 6,
} as const;

export function makeSpotter(): SpotterState {
  return { left: { level: 0, at: 0 }, right: { level: 0, at: 0 } };
}

export function resetSpotter(s: SpotterState): void {
  s.left.level = s.right.level = 0;
  s.left.at = s.right.at = 0;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

/** Heading of a car on the ground: (forward.x, forward.z), unit length, plus its left vector (= (forward.z, -forward.x)). */
function heading(q: SpotterBody['quaternion'], out: { fx: number; fz: number }): void {
  // q * (0, 0, 1)
  const fx = 2 * (q.x * q.z + q.w * q.y);
  const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
  const l = Math.hypot(fx, fz);
  if (l > 1e-6) {
    out.fx = fx / l;
    out.fz = fz / l;
  } else {
    // nose straight up or down: the roof points along the old heading, which a caller that cares has already lost
    out.fx = 0;
    out.fz = 1;
  }
}

const _me = { fx: 0, fz: 1 };
const _o = { fx: 0, fz: 1 };

export interface SpotterHit {
  /** 0..1 */
  level: number;
  /** +1 = on the left of the player, -1 = on the right (0 when level is 0). */
  side: number;
  /** Longitudinal offset of the other car's centre (m, + = ahead of the player's centre). */
  dz: number;
}

/**
 * How much one car matters to the player, and on which side. The player's heading is read from `me`, the other car's
 * from `other`. `speed` gating is the caller's (updateSpotter) business.
 */
export function threat(me: SpotterBody, other: SpotterBody, out: SpotterHit): SpotterHit {
  out.level = 0;
  out.side = 0;
  out.dz = 0;
  heading(me.quaternion, _me);
  heading(other.quaternion, _o);
  const rx = other.position.x - me.position.x;
  const rz = other.position.z - me.position.z;
  // player frame: left = (fz, -fx)
  const dx = rx * _me.fz - rz * _me.fx;
  const dz = rx * _me.fx + rz * _me.fz;
  const adx = Math.abs(dx);
  const adz = Math.abs(dz);
  if (adz > SPOTTER.cullLong || adx > SPOTTER.cullLat) return out;

  // the other body's half extents as seen along the player's axes (relative yaw)
  const c = Math.abs(_o.fx * _me.fx + _o.fz * _me.fz);
  const s = Math.abs(_o.fx * _me.fz - _o.fz * _me.fx);
  const hwO = c * other.halfWidth + s * other.halfLength;
  const hlO = s * other.halfWidth + c * other.halfLength;
  const gx = adx - (me.halfWidth + hwO); // lateral gap, negative = overlapping
  const gz = adz - (me.halfLength + hlO); // longitudinal gap, negative = overlapping

  // closing speed along the player's heading: > 0 = the other car is gaining on a car behind it / being caught
  const vz = (other.velocity.x - me.velocity.x) * _me.fx + (other.velocity.z - me.velocity.z) * _me.fz;
  let lon: number;
  if (gz <= 0) lon = 1;
  else if (dz < 0) {
    const closing = Math.min(Math.max(vz, 0), SPOTTER.closeMax) * SPOTTER.closeSeconds;
    lon = 1 - smoothstep(0, SPOTTER.behind + closing, gz);
  } else lon = 1 - smoothstep(0, SPOTTER.ahead, gz);
  if (lon <= 0) return out;

  let lat = 1 - smoothstep(SPOTTER.latFull, SPOTTER.latNone, gx);
  // longitudinally apart: a car in your own lane is ahead of or behind you, it is not beside you
  if (gz > 0) lat *= smoothstep(-SPOTTER.sameLaneOverlap, 0, gx);
  const level = lon * lat;
  if (level <= 0) return out;
  out.level = level;
  out.side = dx >= 0 ? 1 : -1;
  out.dz = dz;
  return out;
}

const _hit: SpotterHit = { level: 0, side: 0, dz: 0 };

/**
 * One frame: fold every other car into the two sides and smooth. `enabled` false (setting off, a view where the screen's
 * left and right are not the car's) fades everything out through the normal release.
 */
export function updateSpotter(state: SpotterState, me: SpotterBody, others: readonly SpotterBody[], dt: number, enabled = true): SpotterState {
  const speed = Math.hypot(me.velocity.x, me.velocity.z);
  const gate = enabled ? smoothstep(SPOTTER.speedMin, SPOTTER.speedFull, speed) : 0;
  let lSum = 0;
  let lMax = 0;
  let lAt = 0;
  let rSum = 0;
  let rMax = 0;
  let rAt = 0;
  if (gate > 0) {
    for (let i = 0; i < others.length; i++) {
      const o = others[i];
      if (o === me) continue;
      threat(me, o, _hit);
      if (_hit.level <= 0) continue;
      const w = _hit.level * _hit.level;
      const at = Math.max(-1, Math.min(1, _hit.dz / SPOTTER.atRange));
      if (_hit.side > 0) {
        lSum += w;
        lAt += w * at;
        if (_hit.level > lMax) lMax = _hit.level;
      } else {
        rSum += w;
        rAt += w * at;
        if (_hit.level > rMax) rMax = _hit.level;
      }
    }
  }
  follow(state.left, lMax * gate, lSum > 0 ? lAt / lSum : state.left.at, dt);
  follow(state.right, rMax * gate, rSum > 0 ? rAt / rSum : state.right.at, dt);
  return state;
}

function follow(side: SpotterSide, target: number, at: number, dt: number): void {
  const tau = target > side.level ? SPOTTER.attack : SPOTTER.release;
  // a glow that is (nearly) dark lights up where the car is instead of sliding in from wherever it was last seen
  const fresh = side.level < 0.04;
  side.level += (target - side.level) * (1 - Math.exp(-Math.max(dt, 0) / tau));
  if (side.level < 1e-4) side.level = 0;
  // its position only chases a car while there is something to show; once the level has faded it stays put
  if (target > 0.02) side.at = fresh ? at : side.at + (at - side.at) * (1 - Math.exp(-Math.max(dt, 0) / SPOTTER.atTau));
}
