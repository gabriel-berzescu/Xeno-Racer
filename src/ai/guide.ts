/**
 * The driving guide of a human: the AI's racing line and speed profile, worked out for the human's own car and the water on the road
 * (owner: ai). It is what the driving line draws and what the braking assist follows (src/core/aids.ts): where the line runs, the
 * speed it asks of the car at every point, and how hard the car can brake at that pace.
 *
 * The line and the profile are the AI's own (racing-line.ts), with a driver's share of the tyres' grip and the brakes that a person
 * at the wheel of a pad can use (a little less than the AI drivers' best, so that the speeds the line asks for can be held).
 * When the water on the road changes, or the car is damaged (Damage: Full), the profile is worked out again in slices over a few
 * frames, nothing stalls, and the old speeds blend into the new ones over a second or two, so a colour never jumps. The line itself
 * moves from the dry racing line to the wet one (which keeps the wheels off the painted kerbs) the way the AI's does.
 *
 * On a winter circuit it is the winter driver's line and profile: the car on its studded tyres, the grip under each point of the line
 * (packed snow, the ice of a frozen lake), the fresh snow that lies on it as the "water" on the road, and the line that keeps clear of
 * the snowbanks. What the car can brake at is that of the ground it is on: half of asphalt on snow, two fifths on ice.
 */
import type { CarDefinition, TrackRuntime } from '../core/contracts';
import { cloneEffects, isNeutral, type MechEffects } from '../core/mechanical';
import type { SpeedLine } from '../core/aids';
import { fitCar } from '../physics/compound';
import type { SurfaceProps } from '../physics/surfaces';
import { brakeModel, computeRacingLine, damageFactors, ProfileJob, roadSurface, type BrakeModel, type ProfileOptions, type RacingLine } from './racing-line';

/** The share of the tyres' grip and of the braking the line asks of a driver (the AI's pro asks 0.92 and 0.88, the alien 0.965 and 0.94). */
export const GUIDE_SKILL = { gripUse: 0.84, brakeUse: 0.8 };

/** The water on the road has to move this far before the speeds are worked out again (the AI drivers use the same step). */
const WET_STEP = 0.02;
/** A change in what damage costs the car (see damageFactors) smaller than this is not worth working the profile out again. */
const DAMAGE_STEP = 0.002;
/** Steps of the profile's work done per frame (about 40 to 80 ns each, so 0.1 ms or less), and seconds the old speeds take to give way to the new ones. */
const SLICE = 1500;
const BLEND_SECONDS = 1.5;
/** Seconds the line takes to move from the dry racing line to the wet one (the AI drivers take two). */
const LINE_SECONDS = 2;

const smooth01 = (x: number): number => x * x * (3 - 2 * x);

export interface GuideOptions {
  /** Water on the road at the start (0..1). */
  wetness?: number;
  /** The weather may change during this race: the wet racing line is made now, behind the loading screen, not when the rain comes. */
  weatherMayChange?: boolean;
  gripUse?: number;
  brakeUse?: number;
}

export class DrivingGuide implements SpeedLine {
  /** The racing line on a dry road and on a wet one (the same object when the weather cannot change). */
  readonly dry: RacingLine;
  readonly wet: RacingLine;
  /** Where the line is between the two: 0 = the dry line, 1 = the wet one. */
  lineBlend = 0;
  /** How the car brakes at the pace of the line, for the water the speeds were worked out for. */
  brake: BrakeModel;
  /** The speed the line asks of the car (m/s) at each of its points: the profile in use, blending towards a newer one. */
  readonly speeds: Float32Array;
  readonly length: number;

  private readonly gripUse: number;
  private readonly brakeUse: number;
  /** The water the profile in use (or the one it is blending to) was worked out for, and the latest water the guide was told of. */
  private wetness: number;
  private want: number;
  private dmg: MechEffects | null = null;
  private dmgGrip = 1;
  private dmgAero = 1;
  /** The car as it is fitted for this track (studded tyres on a winter circuit), and the surface its road is made of. */
  private readonly fit: CarDefinition;
  private readonly road: SurfaceProps;
  /** What the ground does to the grip at each point of the line, for the water the profile in use was worked out for (see ProfileJob.surfaceFactor). */
  private surf: Float32Array;
  private job: { work: ProfileJob; wet: number; brake: BrakeModel } | null = null;
  private stale = false;
  private blendT = 1;
  private from: Float32Array;
  private to: Float32Array;

  constructor(
    readonly track: TrackRuntime,
    readonly def: CarDefinition,
    opts: GuideOptions = {},
  ) {
    this.gripUse = opts.gripUse ?? GUIDE_SKILL.gripUse;
    this.brakeUse = opts.brakeUse ?? GUIDE_SKILL.brakeUse;
    const wet = Math.min(1, Math.max(0, opts.wetness ?? 0));
    // the same two lines the AI drivers of this car follow (cached, shared with them)
    const half = def.visual.width / 2 - 0.25;
    // (on a winter circuit the snowbank is no place for a wheel: the line keeps off the edge, wet or not, and the two lines are one)
    const winter = track.info.winter === true;
    this.dry = computeRacingLine(track, { edgeMargin: winter ? half + 0.45 : half });
    this.wet = winter ? this.dry : wet > 0 || opts.weatherMayChange ? computeRacingLine(track, { edgeMargin: half + 0.45 }) : this.dry;
    this.length = this.dry.n * this.dry.step;
    this.wetness = this.want = wet;
    this.lineBlend = wet > 0 ? 1 : 0;
    this.fit = fitCar(def, track);
    this.road = roadSurface(track);
    const first = new ProfileJob(track, this.line(wet), this.fit, this.options(wet));
    this.speeds = first.finish().v;
    this.surf = first.surfaceFactor;
    this.brake = brakeModel(this.fit, this.options(wet), this.road);
    this.from = new Float32Array(this.speeds.length);
    this.to = new Float32Array(this.speeds.length);
  }

  private line(wet: number): RacingLine {
    return wet > 0 ? this.wet : this.dry;
  }

  private options(wet: number): ProfileOptions {
    return { gripUse: this.gripUse, brakeUse: this.brakeUse, wetness: wet, damage: this.dmg };
  }

  /** The speed the line asks of the car (m/s) at track distance s. */
  targetAt(s: number): number {
    const n = this.speeds.length;
    const f = (((s % this.length) + this.length) % this.length) / this.dry.step;
    const i = Math.floor(f) % n;
    const t = f - Math.floor(f);
    return this.speeds[i] * (1 - t) + this.speeds[(i + 1) % n] * t;
  }

  /** The water on the road now (0..1). The speeds follow it, a few frames behind, when it has moved by a little. */
  setWetness(w: number): void {
    this.want = Math.min(1, Math.max(0, w));
  }

  /** The car's mechanical damage (src/game/mechsync.ts), or null for a sound car: less grip and downforce, so slower corners and earlier braking. */
  setDamage(e: MechEffects | null): void {
    const fx = e && !isNeutral(e) ? cloneEffects(e) : null;
    if (!fx && !this.dmg) return;
    const f = damageFactors(fx);
    if (Math.abs(f.grip - this.dmgGrip) < DAMAGE_STEP && Math.abs(f.aero - this.dmgAero) < DAMAGE_STEP) return;
    this.dmg = fx;
    this.dmgGrip = f.grip;
    this.dmgAero = f.aero;
    this.stale = true;
  }

  /** Bring everything up to date at once, no slices and no blends: for the moment the guide starts to be used after a pause. */
  settle(): void {
    for (let guard = 0; guard < 4; guard++) {
      if (this.blendT < 1) this.finishBlend();
      if (!this.job) this.startIfNeeded();
      if (!this.job) break;
      this.job.work.advance(Infinity);
      this.land();
    }
    if (this.blendT < 1) this.finishBlend();
    this.lineBlend = this.want > 0 ? 1 : 0;
  }

  private finishBlend(): void {
    this.blendT = 1;
    this.speeds.set(this.to);
  }

  /** Move on by `dt` seconds: a share of the profile's work, the blend of the old speeds into the new, the line between dry and wet. */
  update(dt: number): void {
    if (this.job && this.job.work.advance(SLICE)) this.land();
    if (!this.job && this.blendT >= 1) this.startIfNeeded();
    if (this.blendT < 1) {
      this.blendT = Math.min(1, this.blendT + dt / BLEND_SECONDS);
      if (this.blendT >= 1) this.finishBlend();
      else {
        const a = smooth01(this.blendT);
        const v = this.speeds;
        for (let i = 0; i < v.length; i++) v[i] = this.from[i] + (this.to[i] - this.from[i]) * a;
      }
    }
    // (any water at all puts the line on the wet one, as the AI's)
    const aim = this.want > 0 ? 1 : 0;
    const step = dt / LINE_SECONDS;
    this.lineBlend = aim > this.lineBlend ? Math.min(aim, this.lineBlend + step) : Math.max(aim, this.lineBlend - step);
  }

  /** The car's top speed (m/s) as the line takes it: where the line asks for all of it, no corner asks for anything. */
  get topSpeed(): number {
    return this.brake.top;
  }

  /**
   * What the ground does to the grip the line works with, at the car's place `s` and over the stretch it brakes on from there (the worst of
   * it, as the AI drivers look): 1 on asphalt, 0.5 on packed snow, 0.4 on ice (with the fresh snow that lies on it taken in).
   */
  private surfaceAt(s: number, speed: number): number {
    const f = this.surf;
    const n = f.length;
    const step = this.dry.step;
    const i0 = Math.floor((((s % this.length) + this.length) % this.length) / step + 0.5);
    let k = f[i0 % n];
    const reach = Math.round((8 + 1.3 * Math.max(0, speed)) / step);
    for (let x = 1; x <= reach; x++) {
      const v = f[(i0 + x) % n];
      if (v < k) k = v;
    }
    return k;
  }

  /**
   * The deceleration (m/s^2) the line brakes at when the car is doing `speed` (at track distance `s`, if the ground matters): the pace
   * its colours measure the car's braking against.
   */
  brakeAt(speed: number, s?: number): number {
    return this.brake.profile(speed, s === undefined ? 1 : this.surfaceAt(s, speed));
  }

  /** The most the car's tyres can brake at on the ground it is on at track distance `s` (m/s^2): where a pedal with no ABS stops short of locking the wheels. */
  brakeGripAt(speed: number, s: number): number {
    return this.brake.grip(speed, this.surfaceAt(s, speed));
  }

  /** The line at track distance s: its lateral offset from the centre line (m, + = left), between the dry line and the wet one. */
  offsetAt(s: number): number {
    const d = this.dry;
    const f = (((s % this.length) + this.length) % this.length) / d.step;
    const i = Math.floor(f) % d.n;
    const j = (i + 1) % d.n;
    const t = f - Math.floor(f);
    const a = d.d[i] * (1 - t) + d.d[j] * t;
    if (this.wet === d || this.lineBlend <= 0) return a;
    const w = this.wet.d[i] * (1 - t) + this.wet.d[j] * t;
    return a + (w - a) * smooth01(this.lineBlend);
  }

  private startIfNeeded(): void {
    if (Math.abs(this.want - this.wetness) < WET_STEP && !this.stale) return;
    const wet = this.want;
    this.stale = false;
    const o = this.options(wet);
    this.job = { work: new ProfileJob(this.track, this.line(wet), this.fit, o), wet, brake: brakeModel(this.fit, o, this.road) };
  }

  /** The profile that was being worked out is finished: the old speeds start to blend into it. */
  private land(): void {
    const job = this.job!;
    this.job = null;
    this.from.set(this.speeds);
    this.to.set(job.work.speeds);
    this.blendT = 0;
    this.wetness = job.wet;
    this.brake = job.brake;
    this.surf = job.work.surfaceFactor;
  }
}
