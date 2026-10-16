/**
 * Driving aids that live above the physics (owner: game): the colours of the driving line, the braking assist and the assist
 * presets. Pure: no DOM, no WebGL, nothing of the game's state, so the render system (what colour a stretch of line is), the game
 * (what the assist does to the pedals) and the menus (the presets) all work from the same numbers, and tests/aids.test.ts holds
 * them to what they promise.
 *
 * Both aids read one thing: the speed the driving line asks of the car at a point of the road (src/ai/guide.ts, which is the AI's
 * racing line and speed profile worked out for the player's own car and the water on the road). From that speed, the distance to
 * the point and what the car can brake at, the deceleration needed to be at the right speed there follows (`neededDecel`). The line
 * is coloured by how much of the car's braking that is (`lineUrgency`); the assist brakes the car back to the speed of the line (`brakeDemand`, `BrakeAssist`).
 */
import type { Assists, CameraMode, LineMode, PlayerAssists, Seat, Settings } from './contracts';

export const LINE_MODES: readonly LineMode[] = ['off', 'braking', 'full'];

const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// ─────────────────────────────────────────────────────────────────────────────
// How much braking a point of the line asks for
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A car this much over the speed of the line (a share of it, plus a little in m/s) is still on it: the profile keeps clear of the
 * tyres' limit by more than that, and a thumbstick does not hold a speed to the last km/h.
 */
export const SPEED_TOLERANCE = 0.01;
export const SPEED_DEADBAND = 0.3;
/**
 * A point closer than this counts as this far: what is under the nose says nothing about what lies ahead (a car a metre past the
 * speed of a point a metre away would need a hundred g), and a few metres is what a driver's eye can't separate anyway.
 */
export const MIN_DISTANCE = 8;

/**
 * Where the line asks for all the car has (a target this share of its top speed or more) no corner asks for anything: a slipstream
 * or a descent can lift a car a few per cent past its top speed there, and the brakes are no cure for that. Up to this share over
 * the top speed it is let be.
 */
const PLATEAU = 0.985;
const DRAFT = 1.12;

/** The speed a car may have where the line asks for `target` m/s, for a car whose top speed is `top` (m/s): the line's own, and a margin. */
export function allowedSpeed(target: number, top = Infinity): number {
  const a = target * (1 + SPEED_TOLERANCE) + SPEED_DEADBAND;
  return target >= PLATEAU * top ? Math.max(a, DRAFT * top) : a;
}

/** The deceleration (m/s^2) that brings `speed` down to the line's `target` speed in `dist` metres; 0 when the car is no faster than the line allows. */
export function neededDecel(speed: number, target: number, dist: number, top = Infinity): number {
  const allowed = allowedSpeed(target, top);
  if (!(speed > allowed)) return 0;
  return (speed * speed - allowed * allowed) / (2 * Math.max(dist, MIN_DISTANCE));
}

/**
 * How hard the line says to brake at a point `dist` metres ahead where it asks for `target` m/s, for a car doing `speed` that can be
 * braked at `brakeAccel` m/s^2 (what the line's speed profile brakes at): 0 = nothing to do, 1 = brake now, as hard as the profile
 * does, above 1 = harder than that (the car is later than the profile). A car that brakes as the line says keeps this at about 1
 * along the whole braking zone and sees it fall to 0 as it gets there; one that has braked more than it needed sees it fall sooner.
 */
export function lineUrgency(speed: number, target: number, dist: number, brakeAccel: number, top = Infinity): number {
  return neededDecel(speed, target, dist, top) / Math.max(brakeAccel, 1);
}

/**
 * The colour stops of the line by urgency: green to keep going, amber to lift or brake soon, red to brake. Each is the urgency, the
 * colour in sRGB (what the screen shows) and a gain on it in linear light: red is a dark colour (a fifth of green's luminance), and
 * left alone it would be the dimmest of the three, at night above all, where the grade pulls the dim parts of the picture towards grey.
 */
const LOOK_STOPS: readonly (readonly [number, number, number, number, number])[] = [
  [0, 0x2e, 0xe5, 0x7d, 1],
  [0.14, 0x2e, 0xe5, 0x7d, 1],
  [0.4, 0xff, 0xc4, 0x1f, 1],
  [0.72, 0xff, 0x7a, 0x1c, 1.15],
  [1, 0xff, 0x2d, 0x3b, 1.4],
];

const toLinear = (c: number): number => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};

/** The stops in linear light (the scene is lit and tone mapped in linear), computed once. */
const STOPS_LINEAR = LOOK_STOPS.map(([u, r, g, b, k]) => [u, toLinear(r) * k, toLinear(g) * k, toLinear(b) * k] as const);

/** The colour for an urgency, in linear light (0..1 per channel), written to `out[at..at + 2]`. Urgency above 1 is as red as 1. */
export function lineColor(urgency: number, out: { [i: number]: number }, at = 0): void {
  const u = clamp(urgency, 0, 1);
  let k = 1;
  while (k < STOPS_LINEAR.length - 1 && u > STOPS_LINEAR[k][0]) k++;
  const a = STOPS_LINEAR[k - 1];
  const b = STOPS_LINEAR[k];
  const t = (u - a[0]) / (b[0] - a[0]);
  out[at] = a[1] + (b[1] - a[1]) * t;
  out[at + 1] = a[2] + (b[2] - a[2]) * t;
  out[at + 2] = a[3] + (b[3] - a[3]) * t;
}

/** How much of the line shows where it has this urgency: all of it in Full, only the stretches that ask for a lift or the brake in Braking zones. */
export function lineShows(mode: LineMode, urgency: number): number {
  if (mode === 'full') return 1;
  if (mode === 'braking') return smoothstep(0.1, 0.3, urgency);
  return 0;
}

/**
 * The line starts this far ahead of the car's middle and is all there this far ahead of it (m): the nose of the car is about 2.3 m
 * out, so it comes out from under the car like a beam, and nothing of it is behind.
 */
export const LINE_FROM = 1;
export const LINE_FULL = 9;

/** How far ahead the line is drawn (m) for a car doing `speed` m/s: a corner has to show up before the braking for it begins. */
export function lineRange(speed: number): number {
  return clamp(70 + 2.4 * Math.max(0, speed), 100, 320);
}

/**
 * How much of the line is there `dist` metres ahead of the car (negative: behind it): it comes out in front of the car and fades into the
 * distance. `lead` is how much further out it starts (see lineLead).
 */
export function lineFade(dist: number, range: number, lead = 0): number {
  return smoothstep(LINE_FROM + lead, LINE_FULL + lead, dist) * (1 - smoothstep(range * 0.5, range, dist));
}

/**
 * Metres of the line left out in front of the car for a camera, and how wide it is drawn there (a share of its width). A lens low on
 * the bumper sees the road ahead of the car at a grazing angle, so the nearest metres of a ribbon a metre wide would be a wedge across
 * the whole bottom of the picture: there the line starts a little further out and is drawn narrower. A hood camera sees it past the bonnet.
 */
export function lineLead(mode: CameraMode): number {
  return mode === 'bumper' || mode === 'hood' ? 1 : 0;
}

export function lineWidth(mode: CameraMode): number {
  return mode === 'bumper' ? 0.55 : mode === 'hood' ? 0.8 : 1;
}

/** The cameras the line is drawn in: the ones that look along the car's own road (not the TV, orbit, replay or photo views). */
export function lineShownIn(mode: CameraMode): boolean {
  return mode === 'chase' || mode === 'chase-far' || mode === 'hood' || mode === 'bumper' || mode === 'cockpit';
}

// ─────────────────────────────────────────────────────────────────────────────
// The braking assist
// ─────────────────────────────────────────────────────────────────────────────

/** The speed the driving line asks of the car at a distance along the track, and the car's top speed (see allowedSpeed). */
export interface SpeedLine {
  targetAt(s: number): number;
  readonly topSpeed?: number;
}

/** A racing line as the painter needs it: a closed loop of `n` lateral offsets (m, + = left of the centre line), `step` metres apart along the track. */
export interface LineShape {
  n: number;
  step: number;
  d: ArrayLike<number>;
}

export const ASSIST = {
  /** Below this speed (m/s) the assist leaves the brakes alone: it slows a car for a corner, it never stops one. */
  minSpeed: 5,
  /** Seconds the brakes need to bite: the speed of the line is read this far ahead of the car, so the assist starts that much sooner. */
  lag: 0.3,
  /** The stretch of the line (m) over which the slope of its speed is read: how fast the line asks the car to slow down where the car is. */
  slopeSpan: 16,
  /** A car this far over the line's speed (m/s) gets all of the brake the line's own pace asks for; between 0 and this the brake grows in. */
  onset: 1.5,
  /** How fast a car over the line's speed is brought back to it (1/s): a car 2 m/s over gets 6 m/s^2 more than the line's own pace asks. */
  catchUp: 3,
  /** With no ABS to hold the wheels the pedal is never more than this share of what the tyres can use. */
  noAbsShare: 0.8,
  /** Seconds the pedal takes to follow a demand that grows, and one that falls. */
  rise: 0.07,
  fall: 0.2,
  /** A pedal below this is no pedal at all. */
  floor: 0.03,
  /** The throttle is gone when the car is this far over the line's speed (m/s), or when the assist adds this much brake: less of either lifts it in proportion. */
  cutOver: 0.35,
  lift: 0.2,
};

/**
 * The deceleration (m/s^2) the brakes should give here: none while the car is within the speed of the line (it is where it should
 * be, and brakes when the line does), and from the moment it is over it the pace the line itself slows down at there (that is how
 * a driver who is on time brakes) plus what it takes to bring the car back to the line's speed. The speed of the line is read
 * `lag` seconds ahead of the car, the time the brakes take to bite.
 */
export function brakeDemand(line: SpeedLine, s: number, speed: number, out: BrakeCall): BrakeCall {
  const at = s + speed * ASSIST.lag;
  const v0 = line.targetAt(at);
  const over = speed - allowedSpeed(v0, line.topSpeed);
  out.over = over > 0 ? over : 0;
  out.demand = 0;
  if (!(over > 0)) return out;
  const v1 = line.targetAt(at + ASSIST.slopeSpan);
  const pace = Math.max(0, (v0 * v0 - v1 * v1) / (2 * ASSIST.slopeSpan));
  out.demand = pace * smoothstep(0, ASSIST.onset, over) + ASSIST.catchUp * over;
  return out;
}

/** What the car's speed against the line's calls for: the deceleration to ask of the brakes (m/s^2) and how far over the line's speed the car is (m/s). */
export interface BrakeCall {
  demand: number;
  over: number;
}

/**
 * The pedal (0..1) that gives `need` m/s^2 on a car whose full pedal gives `gain` m/s^2 and that drag already slows by `drag`.
 * `grip` is the most the tyres can brake at here: with no ABS the pedal stays short of locking the wheels.
 */
export function pedalFor(need: number, drag: number, gain: number, grip: number, abs: boolean): number {
  const p = clamp((need - drag * 0.8) / Math.max(gain, 1), 0, 1);
  return abs ? p : Math.min(p, (ASSIST.noAbsShare * grip) / Math.max(gain, 1));
}

export interface AssistInput {
  /** The car's forward speed (m/s); a car that rolls back, or is not racing, gets no brake. */
  speed: number;
  /** The pedal the driver is pressing (0..1), and the handbrake. */
  pedal: number;
  handbrake: number;
  /** The assist may act (the race is on and this is the driver's own car). */
  active: boolean;
  /** brakeDemand() of this moment: the deceleration wanted from the brakes (m/s^2), and how far over the line's speed the car is (m/s). */
  need: number;
  over: number;
  /** m/s^2: what drag takes off by itself, what a full pedal gives, what the tyres can use on this road. */
  drag: number;
  gain: number;
  grip: number;
  abs: boolean;
}

/**
 * The braking assist: brakes for a corner the car arrives at too fast. It follows the deceleration the line asks for, smoothed (the
 * pedal rises quickly and falls slowly, so it does not chatter around the line's speed), and only ever adds to what the driver is
 * doing: the pedal that comes out is the larger of the driver's and the assist's, so a driver who brakes properly is never fought,
 * and one who brakes harder keeps the harder brake.
 */
export class BrakeAssist {
  /** The pedal the assist is holding right now (0..1), before the driver's is taken into account. */
  level = 0;
  /** What it adds to the driver's pedal this frame (0 when the driver is braking at least as hard). */
  added = 0;
  /** How much of the driver's throttle is taken away (0..1): a car over the line's speed does not get power on top of the brakes. */
  cut = 0;

  reset(): void {
    this.level = 0;
    this.added = 0;
    this.cut = 0;
  }

  /** Move on by `dt` seconds. Returns the pedal the car should get: the driver's, or the assist's if that is more. */
  step(dt: number, i: AssistInput): number {
    const on = i.active && i.speed > ASSIST.minSpeed && i.handbrake < 0.3;
    let want = on ? pedalFor(i.need, i.drag, i.gain, i.grip, i.abs) : 0;
    if (want < ASSIST.floor) want = 0;
    const tau = want > this.level ? ASSIST.rise : ASSIST.fall;
    this.level += (want - this.level) * (1 - Math.exp(-dt / tau));
    if (this.level < 0.002) this.level = 0;
    this.added = Math.max(0, this.level - i.pedal);
    this.cut = on ? smoothstep(0, ASSIST.cutOver, i.over) : 0;
    return Math.max(i.pedal, this.level);
  }

  /** The throttle the car gets while the assist is at work: the driver's, lifted as the car goes over the line's speed and as the brake it adds grows. */
  throttle(throttle: number): number {
    return throttle * (1 - Math.max(this.cut, clamp(this.added / ASSIST.lift, 0, 1)));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Assist sets and presets
// ─────────────────────────────────────────────────────────────────────────────

export type AssistPreset = 'pro' | 'standard' | 'beginner';
export const ASSIST_PRESET_IDS: readonly AssistPreset[] = ['pro', 'standard', 'beginner'];

/**
 * Pro: nothing helps, the gearbox is manual (the clutch is still automatic: a pad has no pedal for it). Standard: what the game
 * starts with. Beginner: everything on, for someone who is learning to drive or is young.
 */
export const ASSIST_PRESETS: Readonly<Record<AssistPreset, Readonly<PlayerAssists>>> = {
  pro: { abs: false, tcs: 'off', esc: false, autoShift: false, steeringAssist: 0, autoClutch: true, line: 'off', brakeAssist: false },
  standard: { abs: true, tcs: 'low', esc: true, autoShift: true, steeringAssist: 0.35, autoClutch: true, line: 'off', brakeAssist: false },
  beginner: { abs: true, tcs: 'high', esc: true, autoShift: true, steeringAssist: 0.65, autoClutch: true, line: 'full', brakeAssist: true },
};

/** Which preset a set of aids is exactly, or 'custom'. */
export function matchAssistPreset(a: PlayerAssists): AssistPreset | 'custom' {
  for (const id of ASSIST_PRESET_IDS) {
    const p = ASSIST_PRESETS[id];
    // (a slider that was nudged and brought back is still the preset: the steps of the slider are twentieths)
    if (a.abs === p.abs && a.tcs === p.tcs && a.esc === p.esc && a.autoShift === p.autoShift && a.autoClutch === p.autoClutch && a.line === p.line && a.brakeAssist === p.brakeAssist && Math.abs(a.steeringAssist - p.steeringAssist) < 0.01) return id;
  }
  return 'custom';
}

/** Put a preset into a set of aids, in place. */
export function applyAssistPreset(a: PlayerAssists, id: AssistPreset): void {
  Object.assign(a, ASSIST_PRESETS[id]);
}

/** The aids the physics reads, out of a set of a human's: a copy of the six the car has (the line and the braking assist are not the car's). */
export function carAssists(a: PlayerAssists): Assists {
  return { abs: a.abs, tcs: a.tcs, esc: a.esc, autoShift: a.autoShift, steeringAssist: a.steeringAssist, autoClutch: a.autoClutch };
}

/** The set of aids of the human in this seat: player 1's `assists`, player 2's `assists2`. */
export function assistsOfSeat(s: Pick<Settings, 'assists' | 'assists2'>, seat: Seat): PlayerAssists {
  return seat === 1 ? s.assists2 : s.assists;
}
