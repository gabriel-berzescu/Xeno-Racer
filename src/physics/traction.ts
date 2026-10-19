/**
 * How much of a car's weight its drivetrain can put to work under power: the traction an AI driver (src/ai) can ask the driven
 * tyres for. A rear-drive or front-drive car has the weight of its driven axle (and a little more, for what the load transfer under
 * power gives it); that arithmetic lives with the AI because it has always been two lines. An all-wheel-drive car is the other case,
 * and it is not simply "all of it": the centre differential decides how the drive is divided between the axles, and the axles load
 * up differently as the car squats under power.
 *
 * The model, in a straight line at an acceleration a (in units of μ·g, so a = 1 is a car using all the grip of all four tyres):
 *   - the front axle carries  W·(b/L − a·μ·h/L)  and the rear  W·(a/L + a·μ·h/L)   (L wheelbase, a/b the CG to the front/rear axle,
 *     h the CG height: static split plus the transfer);
 *   - the drive is divided x : 1−x between the front and the rear axle. An open centre holds x at the car's front split. A centre
 *     with a clutch pack (or a lock) moves torque until the axles turn alike, which puts the drive where the loads are, within the range
 *     the pack can carry: front split ± its power lock (a locked centre: anywhere);
 *   - an axle spins when its share of the drive asks for more than its load can grip, so the car can accelerate at the least of
 *     (front axle load / x) and (rear axle load / (1−x)) over the weight; the best x in range is where the two meet, which is the
 *     split of the loads at full grip, if the centre can reach it.
 * The answer is the share of the car's weight that works for the car: 1 for a centre that reaches the loads' own split, less for
 * one that cannot (an open centre at 40:60 in a car that squats to 30:70 has its front tyres spinning at 0.84 of the grip of the whole car).
 *
 * The open differential at each axle is not counted: in a straight line both wheels of an axle carry the same load. In a corner the inner
 * wheel of an open axle limits it, which the AI takes care of by asking for a part of what this says (the friction circle, the winter
 * throttle limit).
 */
import type { VehicleSpec } from './spec';

/** The wheels' grip the model works out the squat at (a dry road): the transfer under power grows with the acceleration the grip allows. */
const MU_REF = 1;

export function awdTractionShare(ph: Pick<VehicleSpec, 'chassis' | 'drivetrain'>): number {
  const c = ph.chassis;
  const d = ph.drivetrain;
  const L = c.wheelbase;
  const a = c.cgToFrontAxle;
  const b = L - a;
  const k = c.cgHeight / L;
  const fs = d.frontSplit;
  const centre = d.centerDiff ?? { type: 'lsd' as const, preload: 50, powerLock: 0.3, coastLock: 0.3 };
  const reach = centre.type === 'open' ? 0 : centre.type === 'locked' ? 1 : centre.powerLock;
  const lo = Math.max(0, fs - reach);
  const hi = Math.min(1, fs + reach);
  // the front share that loads the tyres evenly at full grip, and the nearest share the centre can give
  const ideal = b / L - MU_REF * k;
  const x = ideal < lo ? lo : ideal > hi ? hi : ideal;
  // the acceleration (as a share of the grip) at which the front, and the rear, axle starts to spin with the drive divided x : 1-x
  const front = (MU_REF * (b / L)) / (x + MU_REF * k);
  const rearDen = 1 - x - MU_REF * k;
  const rear = rearDen > 1e-6 ? (MU_REF * (a / L)) / rearDen : Infinity;
  return Math.min(1, front / MU_REF, rear / MU_REF);
}
