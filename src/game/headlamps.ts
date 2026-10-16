/**
 * Headlamps for the mirrors: where the lit lamps of the cars that face the player are, and how strongly. Pure numbers (no
 * three.js), so tests can pin them; the render system turns the list into glare sprites (src/render/mirrorFlares.ts).
 *
 * A mirror shows a following car as a small image, and at that size the lamps of the car are a pixel or two: what the eye
 * reads at night is the glare around them. So the lamps are drawn as soft glows of their own, brightest on the car that
 * is square behind you and gone on a car that is beside you (its lamps point down the road, not at you) or ahead.
 *
 * Car frame: +Z forward, +X left, +Y up (VehicleState.quaternion).
 */
import type { MirrorLamps } from '../core/contracts';
import type { SpotterBody } from './spotter';

export const HEADLAMPS = {
  /** Lamps per frame at most (two per car, a full grid of twelve). */
  max: 24,
  /** How far in from the nose and from the flank the lamps sit (m), and their height above the car's reference point. */
  inset: 0.45,
  sideInset: 0.34,
  up: 0.2,
  /** Full strength on a car that faces the viewer squarely; none from the side. Cosine of the angle between the car's
   *  heading and the line to the viewer. */
  faceFrom: 0.08,
  faceTo: 0.6,
  /** Fades with distance (m, centre to centre). */
  fadeFrom: 140,
  fadeTo: 340,
} as const;

export function makeMirrorLamps(): MirrorLamps {
  return { data: new Float32Array(HEADLAMPS.max * 4), n: 0 };
}

function smoothstep(a: number, b: number, x: number): number {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

/**
 * Fill `out` with the lit headlamps of every car in `bodies` except `skip`, as seen from `eye`. `head` is how far the
 * lamps are lit (0 by day .. 1 at night). `output[i]` is car i's light output (CarDamageControl.lamps: head left, head
 * right, ..., each 0..1), so a broken lamp does not glare. Returns the number of lamps written.
 */
export function collectHeadlamps(
  out: MirrorLamps,
  bodies: readonly SpotterBody[],
  skip: number,
  eye: { x: number; z: number },
  head: number,
  output?: ReadonlyArray<ArrayLike<number> | undefined>,
): number {
  out.n = 0;
  if (head <= 0.01) return 0;
  const d = out.data;
  let n = 0;
  for (let i = 0; i < bodies.length && n + 2 <= HEADLAMPS.max; i++) {
    if (i === skip) continue;
    const b = bodies[i];
    const { x, y, z, w } = b.quaternion;
    // heading and left of the car on the ground (the car's +Z and +X rotated by its orientation)
    const fx = 2 * (x * z + w * y);
    const fz = 1 - 2 * (x * x + y * y);
    const lx = 1 - 2 * (y * y + z * z);
    const lz = 2 * (x * z - w * y);
    const px = b.position.x;
    const pz = b.position.z;
    const dx = eye.x - px;
    const dz = eye.z - pz;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.5) continue;
    const face = (fx * dx + fz * dz) / (Math.hypot(fx, fz) * dist || 1);
    const k = smoothstep(HEADLAMPS.faceFrom, HEADLAMPS.faceTo, face) * (1 - smoothstep(HEADLAMPS.fadeFrom, HEADLAMPS.fadeTo, dist)) * head;
    if (k <= 0.004) continue;
    const fl = Math.hypot(fx, fz) || 1;
    const nose = b.halfLength - HEADLAMPS.inset;
    const side = Math.max(0.1, b.halfWidth - HEADLAMPS.sideInset);
    const ax = (fx / fl) * nose;
    const az = (fz / fl) * nose;
    const ll = Math.hypot(lx, lz) || 1;
    const sx = (lx / ll) * side;
    const sz = (lz / ll) * side;
    const yy = b.position.y + HEADLAMPS.up;
    const lamp = output?.[i];
    const kl = k * (lamp ? lamp[0] : 1);
    const kr = k * (lamp ? lamp[1] : 1);
    if (kl > 0.004) {
      d[n * 4] = px + ax + sx;
      d[n * 4 + 1] = yy;
      d[n * 4 + 2] = pz + az + sz;
      d[n * 4 + 3] = kl;
      n++;
    }
    if (kr > 0.004) {
      d[n * 4] = px + ax - sx;
      d[n * 4 + 1] = yy;
      d[n * 4 + 2] = pz + az - sz;
      d[n * 4 + 3] = kr;
      n++;
    }
  }
  out.n = n;
  return n;
}
