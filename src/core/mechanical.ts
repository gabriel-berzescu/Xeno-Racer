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
 *   nose   front downforce (the splitter and bumper) down to 60 %, and, from about a third of the way to wrecked, up to
 *          10 % of the engine's power (a cracked radiator, a tired engine)
 *   tail   rear downforce (wing, diffuser) down to 60 %, a trace of toe-out on both rear wheels
 *   flank  on the wheels of that side: toe-out up to 1.5 degrees at the front (the car pulls towards the damaged side and
 *          scrubs), 0.5 degrees at the rear (nervous), and up to 1.5 degrees of camber error (less grip, a push to the side)
 *
 * The consequences are all losses, in bounded amounts: a badly damaged car is slower and trickier, never undrivable.
 * (Measured in the game, Vanta GT on Aurelia: a 25 degree hit of the barrier at 100 km/h bends the front left wheel by a third
 * of a degree, at 150 km/h by 0.8 and takes a fifth of the front downforce, at 200 km/h it is bent as far as it goes; a head-on
 * hit at 60 km/h is half a degree and a seventh of the front downforce, at 100 km/h 1.3 degrees, a third of the front downforce
 * and 9 % of the power. Tests and probes: tests/damage-mech.test.ts, tests/probes/damage-*.test.ts.)
 *
 * That is the most a hit can do, to a car that has all of it to lose. A car is only hurt in the ways it has, and what it has is read
 * off the car itself (mechanicalProfile) and kept with its record (MechState.profile), so that the physics, the AI and the HUD can never
 * disagree about it:
 *
 *   downforce  an axle loses it only if it has some worth the name (MECH_TUNING.aeroMin: 0.1 m^2 of lift area per tonne of car, 3 % of its
 *              weight pressed down at 250 km/h). The Vanta GT (0.22 and 0.32 m^2) and the LMP-X (1.55 and 2.05) have; the Kestrel R and the
 *              Ronin 86 (0.02 to 0.08: a splitter lip and a ducktail, 6 to 24 kgf at 250 km/h) do not, there is nothing there to lose; and the
 *              Mammoth's is not downforce at all but lift (-0.10 and -0.06 m^2: a brick with a light bar), which damage must not touch, since
 *              60 % of a lift is less lift, a car that gets better in a crash (it used to: 180 N less lift at 250 km/h, 1.4 % more peak grip
 *              on its front tyres)
 *   engine     a tired engine comes with a smashed nose where the radiator is in it: the front-engined cars (Vanta GT, Kestrel R, Ronin 86,
 *              Mammoth). The LMP-X is mid-engined, its radiators are in its side pods, so a nose hit leaves its engine alone
 *   wheels     toe and camber: every car has wheels, all of it
 *
 * The HUD keeps to the same rule (mechanicalReport): a zone lights for what a hit cost this car there, each loss as a share of the worst it can be. The
 * nose by its downforce where the car has any (that loss is linear in the wear), else by its engine (which only starts to tire a third of the way
 * to wrecked, so a Mammoth's nose can be dented and leave the indicator dark, as it leaves the engine); the tail by its downforce, else by the
 * trace of toe it puts in the rear wheels (against the worst a wheel can be bent, 1.5 degrees: a seventh of the way, "Light" at the very most);
 * a flank by the wheels of that side.
 *
 * Wheel order is the physics': 0 front left, 1 front right, 2 rear left, 3 rear right. Angles are radians, positive to the
 * left like a steering angle, which makes a toed-out left wheel positive and a toed-out right wheel negative.
 */

import type { CarDefinition, HudDamage } from './contracts';

const DEG = Math.PI / 180;

export const MECH_TUNING = {
  /** closing speed (m/s) below which a hit does nothing to the mechanics: the dent threshold (DAMAGE_TUNING.dentMin) */
  onset: 2.6,
  /** the hit energy is ((strength - onset) / ref)^2: one unit of it is 63 % damage on the part that takes it all */
  ref: 12,
  /** front and rear downforce lost at full damage (a share of the aero area) */
  aeroFront: 0.4,
  aeroRear: 0.4,
  /**
   * the lift area per tonne of car (m^2/t) from which an axle has downforce worth losing (mechanicalProfile): 0.1 presses 3 % of the weight
   * down at 250 km/h. The roster sits well to either side of it: 0.15 to 2.2 for the Vanta GT and the LMP-X, 0.02 to 0.06 for the Kestrel R and
   * the Ronin 86, below zero (lift) for the Mammoth.
   */
  aeroMin: 0.1,
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

/**
 * What a hit can take from one car: the ways in which this car can be hurt at its nose and its tail (a hit to its wheels bends them on every
 * car). Read off the car by mechanicalProfile, and kept with its record, so a car is never damaged in a way it does not have.
 */
export interface MechProfile {
  /** the front / rear axle has downforce worth losing (a lift area of MECH_TUNING.aeroMin per tonne or more; lift, or next to nothing, is not) */
  readonly frontAero: boolean;
  readonly rearAero: boolean;
  /** the radiator is in the nose (the engine is in front), so a heavy nose hit tires the engine */
  readonly noseEngine: boolean;
}

/** A car that has all of it to lose: what a record kept without a car is (the tests'), and what every car was before it had a profile. */
export const FULL_CAR: MechProfile = Object.freeze({ frontAero: true, rearAero: true, noseEngine: true });

/**
 * What can be taken from this car, from its own numbers and nobody's name: downforce on the axles whose lift area is at least aeroMin per
 * tonne (a car with lift, or a lip, has none to lose), and an engine that a smashed nose can tire only where it sits in front of the cabin
 * (its radiator is behind the grille; a mid-engined car cools through its sides).
 */
export function mechanicalProfile(car: Pick<CarDefinition, 'physics' | 'visual'>): MechProfile {
  const tonnes = car.physics.chassis.mass / 1000;
  const { liftAreaFront, liftAreaRear } = car.physics.aero;
  return {
    frontAero: liftAreaFront >= MECH_TUNING.aeroMin * tonnes,
    rearAero: liftAreaRear >= MECH_TUNING.aeroMin * tonnes,
    noseEngine: car.visual.engine === 'front',
  };
}

/** A car's mechanical damage so far: the hit energy taken by the nose, the tail and each wheel (a fold over the hits, in order). */
export class MechState {
  front = 0;
  rear = 0;
  /** FL FR RL RR: the suspension and steering of each corner */
  readonly wheel: [number, number, number, number] = [0, 0, 0, 0];
  /** counts every change, so a reader knows when to look again */
  version = 0;

  /** `profile`: what this car can lose (mechanicalProfile); without one the record is a car that has everything. */
  constructor(readonly profile: MechProfile = FULL_CAR) {}

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

/**
 * The effects of a MechState, for the car it belongs to (its profile): a car that has no downforce at an axle keeps its aero exactly as
 * it is there, one with the engine behind the cabin keeps its power. Pass `out` to reuse an object.
 */
export function mechanicalEffects(m: MechState, out: MechEffects = neutralEffects()): MechEffects {
  const T = MECH_TUNING;
  const P = m.profile;
  const f = wear(m.front);
  const r = wear(m.rear);
  out.aeroFront = P.frontAero ? 1 - T.aeroFront * f : 1;
  out.aeroRear = P.rearAero ? 1 - T.aeroRear * r : 1;
  out.power = P.noseEngine ? 1 - T.power * smooth(T.powerFrom, 1, f) : 1;
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

/**
 * What the HUD draws: how hurt each part is, 0..1, for the car it belongs to. A part lights for what its damage cost this car, as a share of
 * the worst that can be, so the indicator never shows a loss the car does not have (see the header):
 *   nose   its downforce, where the car has any (the loss is linear in the wear: the wear itself), else its engine, which only starts to tire at
 *          `powerFrom` (a hit that dents a Mammoth's bumper without reaching its radiator leaves the nose dark, as it leaves the engine)
 *   tail   its downforce likewise, else the trace of toe-out it puts in the rear wheels, measured against the worst a wheel can be bent
 *          (the front wheels' toe, 1.5 degrees): a seventh of the way at the most, which a driver puts a word to as "Light"
 *   flank  the wheels of that side, as ever
 */
export function mechanicalReport(m: MechState, out: HudDamage): void {
  const T = MECH_TUNING;
  const P = m.profile;
  const f = wear(m.front);
  const r = wear(m.rear);
  out.front = P.frontAero ? f : P.noseEngine ? smooth(T.powerFrom, 1, f) : 0;
  out.rear = P.rearAero ? r : (T.toeRearEnd / T.toeFront) * r;
  out.left = wear(m.wheel[0] + m.wheel[2]);
  out.right = wear(m.wheel[1] + m.wheel[3]);
  for (let i = 0; i < 4; i++) out.wheels[i] = wear(m.wheel[i]);
}

/**
 * The level from which the HUD shows a part. Under a twentieth the car drives as it did (a tenth of a degree of toe, not a
 * pull a driver could feel against a thumbstick's dead zone), so a few taps are not a damaged car: a single hit of 5.3 m/s, 19 km/h
 * of closing speed, on a part that takes all of it, is the smallest that shows (the tail of a car without a wing, which can only
 * be knocked a seventh as far, needs 10.8 m/s, 39 km/h; the nose of a car that can only lose its engine, 11.2 m/s).
 */
export const DAMAGE_SHOWN = 0.05;

/** The worst part of a report, 0..1 (the pause screen puts a word to it). */
export function reportWorst(d: HudDamage): number {
  return Math.max(d.front, d.rear, d.left, d.right, d.wheels[0], d.wheels[1], d.wheels[2], d.wheels[3]);
}

const scratch: HudDamage = { front: 0, rear: 0, left: 0, right: 0, wheels: [0, 0, 0, 0] };

/** The worst part of the car, 0..1: what decides whether the HUD has anything to show. */
export function mechanicalWorst(m: MechState): number {
  mechanicalReport(m, scratch);
  return reportWorst(scratch);
}

/** The share of the energy of a flank hit that goes to the front axle: 1 at the front axle and ahead of it, 0 at the rear axle and behind it. */
export function axleShare(z: number, wheelbase: number): number {
  if (!(wheelbase > 0)) return 0.5;
  return clamp01((z + wheelbase / 2) / wheelbase);
}
