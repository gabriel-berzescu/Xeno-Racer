/**
 * Mechanical damage: how a hard crash changes the way a car drives (Settings: Damage, Full). Pure data and arithmetic, no
 * three.js, like src/core/damage.ts, whose CarDamage keeps one MechState per car and folds every hit into it:
 *
 *   hit (closing speed, where it landed) ──CarDamage──► MechState ──mechanicalEffects──► MechEffects
 *                                                          │                                 ├─► Vehicle.setDamage   (physics)
 *                                                          └─ mechanicalReport ─► HudDamage  ├─► AIDriver.setDamage  (the AI adapts)
 *                                                                                            └─► the wheels the car visual draws
 *
 * Forgiving thresholds, realistic consequences. A hit counts from the dent threshold up (2.6 m/s of closing speed) and
 * grows with the square of the speed above it, so the bumps of a pack race (1.3 to 3.2 m/s) and every light graze do nothing
 * you could measure, a 60 km/h side swipe of a wall (6 m/s) next to nothing, and a real crash (a head-on hit from 60 km/h,
 * 14 m/s; a 25 degree one at 150 km/h and more, 17 m/s and up) a good deal. The energy of a hit is shared out by where it
 * landed: the nose and the tail, and the wheels along each flank (the nearer axle takes more). Every part wears as
 * 1 - exp(-energy), so it saturates, repeated hits add up, and nothing ever gets worse than the limits below:
 *
 *   nose   front downforce (the splitter and bumper) down to 64 %, and, from about a third of the way to wrecked, up to
 *          9 % of the engine's power (a cracked radiator, a tired engine)
 *   tail   rear downforce (wing, diffuser) down to 60 %, a trace of toe-out on both rear wheels
 *   flank  on the wheels of that side: toe-out up to 1.4 degrees at the front (the car pulls towards the damaged side and
 *          scrubs), 0.5 degrees at the rear (nervous), and up to 1.4 degrees of camber error (less grip, a push to the side)
 *
 * The consequences are all losses, in bounded amounts: a badly damaged car is slower and trickier, never undrivable.
 *
 * Wheel order is the physics': 0 front left, 1 front right, 2 rear left, 3 rear right. Angles are radians, positive to the
 * left like a steering angle, which makes a toed-out left wheel positive and a toed-out right wheel negative.
 */

const DEG = Math.PI / 180;

export const MECH_TUNING = {
  /** closing speed (m/s) below which a hit does nothing to the mechanics: the dent threshold (DAMAGE_TUNING.dentMin) */
  onset: 2.6,
  /** the hit energy is ((strength - onset) / ref)^2: one unit of it is 63 % damage on the part that takes it all */
  ref: 12,
  /** front and rear downforce lost at full damage (a share of the aero area) */
  aeroFront: 0.4,
  aeroRear: 0.4,
  /** engine power lost at full front damage, which only starts to cost power from `powerFrom` (a share of the way to wrecked) */
  power: 0.1,
  powerFrom: 0.3,
  /** toe-out (rad) of a wheel at full damage: the front wheels, the rear wheels, and what a battered tail adds to both rear wheels */
  toeFront: 1.5 * DEG,
  toeRear: 0.5 * DEG,
  toeRearEnd: 0.2 * DEG,
  /** camber change (rad) of a wheel at full damage (the top of the wheel leans outwards) */
  camber: 1.5 * DEG,
  /** a tyre that stands off its best camber loses this share of its grip per degree squared of the error */
  camberGrip: 0.03,
  /** and pushes towards the lean with this share of its load per degree */
  camberThrust: 0.02,
} as const;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** How much damage a part shows for the hit energy it took: 0 sound, saturating towards 1 (wrecked). */
export function wear(energy: number): number {
  return energy > 0 ? 1 - Math.exp(-energy) : 0;
}

/**
 * The energy a hit of this closing speed (m/s) puts into the mechanics: nothing up to MECH_TUNING.onset, then rising with the
 * square of the speed above it, so the onset is smooth.
 */
export function hitEnergy(strength: number): number {
  const x = (strength - MECH_TUNING.onset) / MECH_TUNING.ref;
  return x > 0 ? x * x : 0;
}

/** What a hit of one closing speed does on a part that takes all of it, as a wear 0..1 (for the calibration tables and the tests). */
export function hitWear(strength: number): number {
  return wear(hitEnergy(strength));
}

/** A car's mechanical damage so far: the hit energy taken by the nose, the tail and each wheel (a fold over the hits, in order). */
export class MechState {
  front = 0;
  rear = 0;
  /** FL FR RL RR: the suspension and steering of each corner */
  readonly wheel: [number, number, number, number] = [0, 0, 0, 0];
  /** counts every change, so a reader knows when to look again */
  version = 0;

  reset(): void {
    if (this.pristine) return;
    this.front = this.rear = 0;
    this.wheel.fill(0);
    this.version++;
  }

  /** Nothing has bent. */
  get pristine(): boolean {
    return this.front === 0 && this.rear === 0 && this.wheel[0] === 0 && this.wheel[1] === 0 && this.wheel[2] === 0 && this.wheel[3] === 0;
  }

  /**
   * Take a hit of energy `u` (hitEnergy). `wFront`..`wRight` is how it divides over the four zones of the body (they sum to
   * 1, src/core/damage.ts zoneWeights), `axle` how much of what the flanks took goes to the front axle (1) and how much to the rear (0).
   */
  add(u: number, wFront: number, wRear: number, wLeft: number, wRight: number, axle: number): void {
    if (!(u > 0)) return;
    this.front += u * wFront;
    this.rear += u * wRear;
    this.wheel[0] += u * wLeft * axle;
    this.wheel[1] += u * wRight * axle;
    this.wheel[2] += u * wLeft * (1 - axle);
    this.wheel[3] += u * wRight * (1 - axle);
    this.version++;
  }
}

/** What the mechanical damage does to the driving of a car, in the units the physics and the AI work in. Neutral = a sound car. */
export interface MechEffects {
  /** multipliers on the downforce area of the front and rear axle, 1 = sound */
  aeroFront: number;
  aeroRear: number;
  /** multiplier on the engine's torque, 1 = sound */
  power: number;
  /** toe change of each wheel (rad), added to its steering angle */
  toe: [number, number, number, number];
  /** camber change of each wheel (rad); positive = the top leans out */
  camber: [number, number, number, number];
  /** multiplier on the peak grip of each tyre, from its camber error */
  camberGrip: [number, number, number, number];
  /** lateral force of each tyre per newton of its load, from its camber error (positive pushes to the left) */
  camberThrust: [number, number, number, number];
}

export function neutralEffects(): MechEffects {
  return { aeroFront: 1, aeroRear: 1, power: 1, toe: [0, 0, 0, 0], camber: [0, 0, 0, 0], camberGrip: [1, 1, 1, 1], camberThrust: [0, 0, 0, 0] };
}

export function cloneEffects(e: MechEffects): MechEffects {
  const four = (a: readonly number[]): [number, number, number, number] => [a[0], a[1], a[2], a[3]];
  return { aeroFront: e.aeroFront, aeroRear: e.aeroRear, power: e.power, toe: four(e.toe), camber: four(e.camber), camberGrip: four(e.camberGrip), camberThrust: four(e.camberThrust) };
}

/** True when the effects change nothing (a sound car). */
export function isNeutral(e: MechEffects | null | undefined): boolean {
  if (!e) return true;
  if (e.aeroFront !== 1 || e.aeroRear !== 1 || e.power !== 1) return false;
  for (let i = 0; i < 4; i++) if (e.toe[i] !== 0 || e.camber[i] !== 0 || e.camberGrip[i] !== 1 || e.camberThrust[i] !== 0) return false;
  return true;
}

/** The effects of a MechState. Pass `out` to reuse an object. */
export function mechanicalEffects(m: MechState, out: MechEffects = neutralEffects()): MechEffects {
  const T = MECH_TUNING;
  const f = wear(m.front);
  const r = wear(m.rear);
  out.aeroFront = 1 - T.aeroFront * f;
  out.aeroRear = 1 - T.aeroRear * r;
  out.power = 1 - T.power * smooth(T.powerFrom, 1, f);
  for (let i = 0; i < 4; i++) {
    const w = wear(m.wheel[i]);
    const sign = (i & 1) === 0 ? 1 : -1; // + = the left side
    const frontAxle = i < 2;
    const toeOut = frontAxle ? T.toeFront * w : T.toeRear * w + T.toeRearEnd * r;
    out.toe[i] = sign * toeOut + 0; // (+ 0: a sound wheel is 0, not -0)
    const camber = T.camber * w;
    out.camber[i] = camber;
    const deg = camber / DEG;
    out.camberGrip[i] = 1 - T.camberGrip * deg * deg;
    out.camberThrust[i] = sign * T.camberThrust * deg + 0;
  }
  return out;
}

/** What the HUD draws: how hurt each part is, 0..1. */
export function mechanicalReport(m: MechState, out: { front: number; rear: number; left: number; right: number; wheels: [number, number, number, number] }): void {
  out.front = wear(m.front);
  out.rear = wear(m.rear);
  out.left = wear(m.wheel[0] + m.wheel[2]);
  out.right = wear(m.wheel[1] + m.wheel[3]);
  for (let i = 0; i < 4; i++) out.wheels[i] = wear(m.wheel[i]);
}

/** The wear of a part from which the HUD shows it (under a fiftieth the car drives as it did: a few taps are not a damaged car). */
export const DAMAGE_SHOWN = 0.02;

/** The worst part of the car, 0..1 (the HUD lights the indicator by it, the tests read it). */
export function mechanicalWorst(m: MechState): number {
  let w = Math.max(wear(m.front), wear(m.rear), wear(m.wheel[0] + m.wheel[2]), wear(m.wheel[1] + m.wheel[3]));
  for (let i = 0; i < 4; i++) w = Math.max(w, wear(m.wheel[i]));
  return w;
}

/** The share of the energy of a flank hit that goes to the front axle: 1 at the front axle and ahead of it, 0 at the rear axle and behind it. */
export function axleShare(z: number, wheelbase: number): number {
  if (!(wheelbase > 0)) return 0.5;
  return clamp01((z + wheelbase / 2) / wheelbase);
}
