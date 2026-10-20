/**
 * Xeno-Racer — shared contracts.
 *
 * Every subsystem (physics, track, render, car visuals, audio, input, UI, AI, game) talks to the
 * others ONLY through the types in this file. Change it only in coordination with the owner (see
 * ARCHITECTURE.md).
 *
 * CONVENTIONS — read before writing a single line:
 *  - Units are SI: meters, seconds, kilograms, newtons, radians, m/s. RPM only in fields named *rpm*.
 *  - World frame: right-handed, +Y up (three.js). Gravity is (0, -9.81, 0).
 *  - Car local frame: +Z forward, +Y up, +X LEFT. The car's right is -X.
 *    Car models are built facing +Z (same as glTF and Object3D.lookAt for non-camera objects).
 *  - Track frame: s = distance along the centerline from the start/finish line, in [0, length).
 *    d = lateral offset from the centerline, positive = LEFT of the driving direction.
 *  - Steering INPUT: -1 = full left, +1 = full right (stick convention).
 *    Wheel steerAngle in telemetry is a rotation about the chassis +Y axis, so a wheel turned to the
 *    LEFT has a POSITIVE steerAngle. (Right stick input -> negative steerAngle.)
 *  - Wheel order everywhere: 0 = front-left, 1 = front-right, 2 = rear-left, 3 = rear-right.
 *  - Wheel spin: rotation about the chassis +X axis; it increases when the car rolls forward.
 *    Visual wheel orientation = chassisQuat * rotY(steerAngle) * rotX(spin).
 *  - Physics runs at a fixed rate (1000 Hz by default); everything else runs per rendered frame.
 */
import type { Object3D, Quaternion, Vector3 } from 'three';
import type { VehicleSpec } from '../physics/spec';

// ─────────────────────────────────────────────────────────────────────────────
// Surfaces
// ─────────────────────────────────────────────────────────────────────────────

export type SurfaceType =
  | 'asphalt' // racing surface
  | 'curb' // painted rumble strips (raised, ridged — the ridges are in the height)
  | 'concrete' // painted runoff / pit concrete
  | 'grass'
  | 'gravel' // gravel trap: low grip, huge rolling drag
  | 'sand'
  | 'dirt'
  | 'snow' // packed snow (the winter road): about half the grip of dry asphalt
  | 'ice' // studded ice (a frozen lake)
  | 'deepsnow'; // loose snow off the road and the foot of a snowbank: soft, draggy, bogs a car down

// ─────────────────────────────────────────────────────────────────────────────
// Track (owner: track)
// ─────────────────────────────────────────────────────────────────────────────

/** Filled in place by TrackRuntime.groundAt. */
export interface GroundSample {
  /** World Y of the drivable surface at (x, z). Includes curb ridges, bumps, terrain. */
  height: number;
  /** Unit surface normal (written in place). */
  normal: Vector3;
  surface: SurfaceType;
}

/** Filled in place by TrackRuntime.project. */
export interface TrackPoint {
  /** Distance along centerline, [0, length). */
  s: number;
  /** Signed lateral offset from the centerline, + = left. */
  d: number;
  /** Index of the nearest centerline sample — pass back as `hint` next call. */
  segment: number;
  /** Asphalt half-widths at s (m, positive). */
  widthLeft: number;
  widthRight: number;
  /** Distance from centerline to the barrier faces at s (m, positive). The car must stay within. */
  wallLeft: number;
  wallRight: number;
  /** How soft the barrier on each side is at s: 0 = a hard wall (concrete, steel, tyres), 1 = a snowbank that takes a car in and slows it. Absent = 0. */
  softLeft?: number;
  softRight?: number;
  /** Unit horizontal tangent (direction of travel) at s. */
  tx: number;
  tz: number;
  /** Unit horizontal left vector at s: (tz, -tx). */
  lx: number;
  lz: number;
  /** Centerline surface height at s. */
  y: number;
}

export interface TrackFrame {
  position: Vector3; // centerline point on the road surface
  tangent: Vector3; // unit, direction of travel (3D, follows slope)
  normal: Vector3; // unit road normal (includes banking)
  left: Vector3; // unit, across the road surface toward the left edge (normal x tangent)
  widthLeft: number;
  widthRight: number;
  wallLeft: number;
  wallRight: number;
  curvature: number; // signed horizontal curvature 1/m, + = turning left
  bank: number; // rad, + = left edge higher
}

export interface GridSlot {
  /** Position of the car's center of mass when resting on the grid (on the surface + cg height is added by game). */
  position: Vector3; // point on the road surface
  /** Car orientation: +Z along the direction of travel, +Y along the road normal. */
  quaternion: Quaternion;
  s: number;
  d: number;
}

export interface TrackInfo {
  id: string;
  name: string;
  location: string; // fictional place
  description: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  defaultLaps: number;
  defaultTimeOfDay: TimeOfDay;
  /** Approximate length in meters (exact value is TrackRuntime.length). */
  lengthHint: number;
  /** Accent color for menus. */
  color: string;
  /** Lit for racing after dark (the menus only pick a night attract race on these). */
  floodlit?: boolean;
  /**
   * A winter circuit: snow and ice under studded winter tyres, snowbanks for barriers, cold air. Precipitation is snow there (the
   * 'rain' and 'storm' weathers are snowfall and a blizzard), and the "water" on the track is fresh snow.
   */
  winter?: boolean;
}

/**
 * Headless-safe description of a built track (no DOM, no WebGL). Physics, AI, HUD, game and
 * effects use this. Centerline arrays are sampled every `spacing` meters; sample i is at
 * s = i * spacing and the loop is closed (sample `count` == sample 0).
 */
export interface TrackRuntime {
  readonly info: TrackInfo;
  readonly length: number;
  readonly spacing: number;
  readonly count: number;
  readonly px: Float32Array; readonly py: Float32Array; readonly pz: Float32Array;
  readonly tx: Float32Array; readonly ty: Float32Array; readonly tz: Float32Array;
  readonly nx: Float32Array; readonly ny: Float32Array; readonly nz: Float32Array;
  readonly lx: Float32Array; readonly ly: Float32Array; readonly lz: Float32Array;
  readonly widthLeft: Float32Array; readonly widthRight: Float32Array;
  readonly wallLeft: Float32Array; readonly wallRight: Float32Array;
  readonly curvature: Float32Array;
  readonly bank: Float32Array;
  /** s of the sector 1→2 and 2→3 boundaries. */
  readonly sectors: readonly [number, number];
  /** Starting grid, index 0 = pole. At least 12 slots, behind the start line, staggered two-wide. */
  readonly grid: readonly GridSlot[];
  /** Axis-aligned XZ bounds of everything drivable (for minimap / shadows). */
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number };

  /** Ground under (x, z). Fast (called ~16k times/s). Returns the segment hint to pass next time. */
  groundAt(x: number, z: number, out: GroundSample, hint?: number): number;
  /** Project a world XZ position onto the track. Returns the segment hint. */
  project(x: number, z: number, out: TrackPoint, hint?: number): number;
  /** World position on the road surface at (s, d). */
  pointAt(s: number, d: number, out: Vector3): Vector3;
  /** Interpolated centerline frame at s. */
  frameAt(s: number, out: TrackFrame): TrackFrame;
  /** Wrap any s into [0, length). */
  wrapS(s: number): number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vehicle (owner: physics)
// ─────────────────────────────────────────────────────────────────────────────

/** What a driver (human or AI) feeds the car each frame. */
export interface CarControls {
  /** -1 full left .. +1 full right (fraction of the car's max steering lock, already filtered). */
  steer: number;
  throttle: number; // 0..1
  brake: number; // 0..1
  handbrake: number; // 0..1
  clutch: number; // 0 = engaged, 1 = fully disengaged (pedal pressed)
  /** One-shot gear request for this frame: +1 up, -1 down, 0 none. Ignored with autoShift. */
  shift: -1 | 0 | 1;
}

export interface Assists {
  abs: boolean;
  tcs: 'off' | 'low' | 'high';
  /** Electronic stability control (yaw control by braking individual wheels). */
  esc: boolean;
  autoShift: boolean;
  /** 0..1 — helps catch slides with automatic counter-steer and limits steering to the grip limit. */
  steeringAssist: number;
  /** Automatic clutch (true for nearly everyone using a gamepad). */
  autoClutch: boolean;
}

/**
 * The driving line a human can have drawn on the road (src/core/aids.ts, src/render/drivingLine.ts): never, only where the
 * line says to lift or brake, or all along.
 */
export type LineMode = 'off' | 'braking' | 'full';

/**
 * Everything one human driver can switch on: the aids the car has (`Assists`, which the physics reads) and the two that live above
 * the physics, the driving line and the braking assist (src/core/aids.ts). Each human has a set of their own (`Settings.assists`,
 * `Settings.assists2`); the opponents drive with fixed aids.
 */
export interface PlayerAssists extends Assists {
  line: LineMode;
  /** The car brakes itself for a corner it arrives at too fast for the driving line's speed; the player still steers and accelerates, and can brake harder. */
  brakeAssist: boolean;
}

export interface WheelState {
  hub: Vector3; // world position of wheel center
  contactPoint: Vector3; // world position of the contact patch
  contactNormal: Vector3;
  steerAngle: number; // rad about chassis +Y (+ = pointing left)
  spin: number; // accumulated rotation about chassis +X (rad), grows when rolling forward
  omega: number; // rad/s, + = rolling forward
  radius: number;
  width: number;
  compression: number; // 0 = fully extended .. 1 = bump stop
  suspensionVelocity: number; // m/s, + = compressing
  contact: boolean;
  surface: SurfaceType;
  load: number; // vertical load N
  slipRatio: number;
  slipAngle: number; // rad
  forceLong: number; // N, tire frame (+ = forward)
  forceLat: number; // N, tire frame (+ = left)
  /** 0..1 — how hard the tire is sliding (squeal, smoke, skidmarks). */
  skid: number;
  tempC: number; // tread surface temperature
  brakeTempC: number; // disc temperature (glows above ~450 °C)
}

export type ImpactKind = 'wall' | 'car' | 'ground' | 'snow';

export interface VehicleState {
  id: number;
  position: Vector3; // center of mass, world
  quaternion: Quaternion; // car frame -> world
  velocity: Vector3; // world, m/s
  angularVelocity: Vector3; // world, rad/s
  speed: number; // |velocity|
  forwardSpeed: number; // velocity along car +Z
  /** Acceleration in the car frame (x left, y up, z forward), m/s^2, lightly smoothed. */
  localAccel: Vector3;
  steer: number; // applied steering input -1..1 (after assists)
  throttle: number; // applied 0..1 (after TCS / limiter)
  /**
   * The driver's throttle pedal 0..1 (or the AI's). The throttle body follows it: the ignition cut of a flat upshift and the traction
   * control cut `throttle`, not this, so they do not blow a turbo's blow-off valve.
   */
  throttlePedal: number;
  brake: number; // applied 0..1 (after ABS)
  handbrake: number;
  clutch: number; // 0 engaged .. 1 open
  rpm: number;
  idleRpm: number;
  redlineRpm: number;
  limiterRpm: number;
  gear: number; // -1 = R, 0 = N, 1..gearCount
  gearCount: number;
  /** 0..1 fraction of available engine torque being produced (audio load). Negative-ish 0 on overrun. */
  engineLoad: number;
  /** Turbo boost 0..1 of max (0 for NA engines). */
  boost: number;
  revLimiter: boolean; // limiter cutting this frame
  absActive: boolean;
  tcsActive: boolean;
  escActive: boolean;
  /** Increments every completed gear change. */
  shiftCount: number;
  /** Increments on every overrun backfire pop (audio pop + exhaust flame). */
  backfireCount: number;
  /** Nitro burning now, 0..1 (src/core/nitro.ts): the exhaust flames and the camera's rush. Absent = 0. */
  nitro?: number;
  /** Increments on every distinct impact; read lastImpact when it changes. */
  impactCount: number;
  lastImpact: { strength: number; point: Vector3; normal: Vector3; kind: ImpactKind };
  /** 0..1 continuous scraping against a wall or the ground (sparks + grinding). */
  scrape: number;
  scrapePoint: Vector3;
  wheels: [WheelState, WheelState, WheelState, WheelState];
  /** All four wheels touching nothing? */
  airborne: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cars (owner: game/physics — data lives in src/cars)
// ─────────────────────────────────────────────────────────────────────────────

export type BodyStyle = 'gt' | 'hatch' | 'coupe' | 'prototype' | 'suv';

/** Everything the car-visual builder needs. Body geometry origin: on the ground, centered
 *  between the axles and between the wheels, +z forward. The center of mass sits at
 *  (0, cgHeight, bodyCgZ(spec)) relative to that origin. */
export interface CarVisualSpec {
  style: BodyStyle;
  length: number;
  width: number; // body width without mirrors
  height: number; // roof height above ground at rest
  wheelbase: number;
  trackFront: number; // distance between front tire centers
  trackRear: number;
  frontOverhang: number; // front axle -> front bumper
  wheelRadiusFront: number;
  wheelRadiusRear: number;
  tireWidthFront: number;
  tireWidthRear: number;
  rimRadiusFront: number;
  rimRadiusRear: number;
  rideHeight: number; // underbody above ground at rest
  cgHeight: number;
  cgToFrontAxle: number;
  /** Rear wing size 0 (none) .. 1 (big race wing). */
  wing: number;
  /** Engine position (affects intakes, vents, cockpit placement). */
  engine: 'front' | 'mid' | 'rear';
  exhaust: { count: 1 | 2 | 4; side: 'center' | 'split' | 'side' };
  /** Seat position relative to body origin, for cockpit camera / driver (left-hand drive). */
  seat: { x: number; y: number; z: number };
}

/**
 * Where the center of mass sits along the body, from the body origin (the middle of the wheelbase), +z forward. `cgToFrontAxle` is
 * measured back from the front axle, so a car heavier at the front has its center of mass ahead of the middle. Every conversion between
 * the physics frame (centred on the center of mass, the wheels at +cgToFrontAxle and -(wheelbase - cgToFrontAxle)) and the body frame
 * goes through this.
 */
export function bodyCgZ(v: { wheelbase: number; cgToFrontAxle: number }): number {
  return v.wheelbase / 2 - v.cgToFrontAxle;
}

/**
 * A piece of live mirror glass on the player's car (src/carvis/mirrors.ts), drawn into by the render system's mirror pass
 * (src/render/mirrors.ts). The car builds the meshes (a flat plane, local +Z the face the driver sees, local +X its right,
 * UV 0..1 over the glass) with a placeholder material and keeps them hidden outside the cockpit view; the render system
 * swaps in the glass shader.
 */
export interface CarMirrorGlass {
  /** 'reflect': a mirror, shows the road behind reflected in the glass plane. 'camera': a display showing the rear camera. */
  kind: 'reflect' | 'camera';
  mesh: Object3D;
  /** Half the glass width and height (m). */
  halfW: number;
  halfH: number;
  /** Field of view factor of a reflecting glass: 1 = flat, > 1 = convex (wider view, everything smaller), across and up. */
  convex: number;
  convexY: number;
}

export interface CarMirrors {
  glass: CarMirrorGlass[];
  /** The rear camera (child of the car root): looks out of the tail along its own -Z. Feeds the dash display and the HUD mirror. */
  rearCamera: Object3D;
  /** Set by the render system: the glass is drawn into this frame. While false (and until a render system attaches the mirrors) the cockpit shows a still mirror instead. */
  live: boolean;
  /** Interior parts every mirror leaves out (seats, headrests, the driver, the wheel): a mirror looks back from in front of them, and a view full of headrests is no view. */
  hide: Object3D[];
  /** The player's own car is drawn in the mirrors with its cheaper body: for every mirror pass `hide` (the full-detail body) goes out and `show` (the coarse level) comes in. */
  lowDetail: { hide: Object3D[]; show: Object3D[] };
}

/**
 * The lit headlamps of the cars that face the player, for the glare in the mirrors at night (the game fills it every frame,
 * src/game/headlamps.ts; the render system draws it, src/render/mirrorFlares.ts): x, y, z and strength (0..1) per lamp, the
 * first `n` entries used.
 */
export interface MirrorLamps {
  data: Float32Array;
  n: number;
}

export interface Livery {
  primary: string; // hex '#rrggbb'
  secondary: string;
  accent: string;
  pattern: 'solid' | 'stripes' | 'split' | 'arrow' | 'hoops' | 'shards';
  number: number;
  driver: string; // name shown in standings
  /** 0 = gloss, 0.5 = satin, 1 = matte */
  finish: number;
  metallic: boolean;
}

export type CylinderLayout = 'inline' | 'v' | 'flat';

export interface EngineSoundProfile {
  cylinders: 4 | 6 | 8 | 10 | 12;
  layout: CylinderLayout;
  /** Crossplane V8s burble (uneven exhaust pulses); flat-plane V8s scream. */
  crankType: 'flat' | 'crossplane' | 'boxer';
  displacement: number; // liters
  turbo: boolean;
  /** 0..1: muffled road car .. open race exhaust. */
  exhaustOpenness: number;
  /** 0..1: deep .. bright/raspy. */
  brightness: number;
  /** 0..1 gearbox whine (straight-cut gears ~0.8). */
  gearWhine: number;
  /** 0..1 likelihood/intensity of overrun pops & crackles. */
  crackle: number;
  /**
   * A belt-driven positive-displacement supercharger (absent: none): a Roots or twin-screw blower, no lag and no blow-off valve (that
   * is a turbo's). Its rotors turn `ratio` times for every crank turn (the pulley ratio: about 2.4 for the 2.4 L blowers of a Hellcat or
   * a TRX) and each lobe sends one pulse of air out of the discharge, so `lobes` is the pulses per rotor turn (the male lobes of a
   * twin-screw: 4; a Roots pair of 4-lobe rotors: 8). The whine is the tone of those pulses, rpm/60 x ratio x lobes Hz with its
   * harmonics: it climbs with the engine (1.03 kHz at 6200 rpm for 2.5 x 4, 108 Hz at a 650 rpm idle, where it is only a whirr),
   * is loud on the throttle and drops when the bypass valve opens off it. `level` 0..1 scales it (default 1). Keep 2 x ratio x lobes
   * a whole number (2.5 x 4 = 20) and the tone and its sidebands stay on the engine-order grid (rpm/120) where the aliasing test
   * looks for folded-back partials. `lobes` is rounded to a whole number. Heard in full quality only, as the turbo's whistle is.
   */
  supercharger?: { ratio: number; lobes: number; level?: number };
  /**
   * 'dual': a true dual exhaust, each bank of a V engine in its own pipe to its own tailpipe with no crossover (side exits, one per
   * side, on the Mammoth). The listener is nearer one tailpipe than the other and the two pipes are never quite twins (a muffler that damps
   * a little more, a pipe a hair longer), so the sum of the banks is no longer the even train of pulses it would be through identical pipes
   * heard from one point: a cross-plane V8's banks, which fire 90 / 180 / 270 / 180 degrees apart, come out as the burble (energy at the half
   * orders of the crank, rpm/120), strongest below 3000 rpm and fading as the pulses crowd into the roar. Absent or 'merged': the banks meet
   * in an X-pipe and one pipe goes on, which throws that difference away, so the same engine is smoother. The pipes are run in full quality;
   * a lite voice has the same lope as per-pulse strengths.
   */
  exhaustSystem?: 'merged' | 'dual';
}

export interface CarDefinition {
  id: string;
  name: string;
  maker: string; // fictional
  description: string;
  class: 'Road' | 'Sport' | 'GT' | 'Prototype' | 'SUV';
  drivetrain: 'FWD' | 'RWD' | 'AWD';
  /** Menu stats (computed/estimated). */
  stats: { powerHp: number; torqueNm: number; massKg: number; topSpeedKmh: number; zeroTo100: number };
  physics: VehicleSpec;
  visual: CarVisualSpec;
  sound: EngineSoundProfile;
  defaultLivery: Livery;
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment & graphics (owner: render)
// ─────────────────────────────────────────────────────────────────────────────

export type TimeOfDay = 'dawn' | 'morning' | 'noon' | 'golden' | 'dusk' | 'night';
export type Weather = 'clear' | 'cloudy' | 'overcast' | 'rain' | 'storm';

export interface EnvironmentSettings {
  timeOfDay: TimeOfDay;
  weather: Weather;
  /**
   * A winter circuit (`TrackInfo.winter`): the sun stays low all day, the ground is snow, 'rain' and 'storm' are snowfall and a
   * blizzard, and the night sky carries an aurora. Set by the game from the track.
   */
  winter?: boolean;
}

/** Live environment info other modules may read (e.g. headlights on at night). */
export interface EnvironmentState {
  settings: EnvironmentSettings;
  sunDirection: Vector3; // unit vector pointing TOWARD the sun
  sunIntensity: number;
  /** 0 = full day .. 1 = full night: drives headlights, emissive boosts, street lights. */
  darkness: number;
  fogColor: string;
  /** 0..1 precipitation intensity: rain particles, rain sound, wet glass. 0 when dry. */
  rain: number;
  /** 0..1 standing water on the track: tire grip, spray, the wet look of road and cars. */
  wetness: number;
  /**
   * The darkest `darkness` gets in this race. It only differs from `darkness` in a race whose weather changes (a storm is
   * coming): whatever has to be fitted before the start, like the player's headlights, is decided by this one. Absent = `darkness`.
   */
  peakDarkness?: number;
}

/** Rain and track water per weather preset (shared by render, physics, AI and audio). */
export const WEATHER_WATER: Record<Weather, { rain: number; wetness: number }> = {
  clear: { rain: 0, wetness: 0 },
  cloudy: { rain: 0, wetness: 0 },
  overcast: { rain: 0, wetness: 0 },
  rain: { rain: 0.55, wetness: 0.75 },
  storm: { rain: 1, wetness: 1 },
};

/**
 * How the weather of a race moves while it is run (the timeline is src/game/weather.ts). 'rainLater': it starts dry and rain
 * arrives part way through. 'clearing': it starts wet, the rain eases and stops, the cloud lifts and the track dries.
 * 'stable' (or no forecast at all): the weather in the settings, all race long.
 */
export type Forecast = 'stable' | 'rainLater' | 'clearing';

/** What the weather of a race that changes is doing right now. Fixed weather is just `WEATHER_WATER` and a constant sky. */
export interface WeatherState {
  /** 0 = the sky of the race's dry weather .. 1 = the sky of its wet weather (cloud deck, light, darkness). */
  sky: number;
  /** Rain falling, 0..1 (what `EnvironmentState.rain` carries). */
  rain: number;
  /** Water on the track, 0..1 (`EnvironmentState.wetness`). It follows the rain with a lag and dries more slowly than it wets. */
  wetness: number;
}

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface GraphicsSettings {
  quality: QualityLevel;
  /** Fraction of device pixels rendered (0.5 .. 1.5). */
  renderScale: number;
  shadows: 'off' | 'low' | 'high';
  ambientOcclusion: boolean;
  bloom: boolean;
  motionBlur: boolean;
  antialias: 'off' | 'fxaa' | 'smaa';
  /** 0..1 scenery / vegetation density. */
  vegetation: number;
  /** Cap the frame rate (0 = uncapped / vsync). */
  maxFps: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input (owner: input)
// ─────────────────────────────────────────────────────────────────────────────

export interface InputFrame {
  device: 'gamepad' | 'keyboard';
  gamepadId: string | null;
  /** Raw driving axes after deadzones / response curves (NOT vehicle-aware filtering). */
  steer: number; // -1..1
  throttle: number; // 0..1
  brake: number; // 0..1
  handbrake: number; // 0..1
  clutch: number; // 0..1
  /** Right stick look (-1..1). */
  lookX: number;
  lookY: number;
  /** Held buttons. */
  lookBack: boolean;
  /** One-shot edges (true for exactly one poll). */
  shiftUp: boolean;
  shiftDown: boolean;
  cameraNext: boolean;
  resetCar: boolean;
  pause: boolean;
  toggleHud: boolean;
  toggleTelemetry: boolean;
  /** D-pad right / N: skip to the next song of the race music. */
  nextTrack: boolean;
  /** Fire a nitro shot (src/core/nitro.ts). */
  nitro: boolean;
  /** Menu navigation edges, with auto-repeat while held. */
  nav: { up: boolean; down: boolean; left: boolean; right: boolean; confirm: boolean; back: boolean; tabLeft: boolean; tabRight: boolean };
  /** True on any button/key press this poll (used to unlock audio / dismiss title). */
  anyPressed: boolean;
}

export interface ControlSettings {
  /** Stick deadzone (radial-ish, applied to steer axis) 0..0.3 */
  steerDeadzone: number;
  /** 1 = linear, >1 = more precision near center. */
  steerLinearity: number;
  /** Triggers deadzone 0..0.2 */
  pedalDeadzone: number;
  /** Max steering at high speed is reduced by this much (0 = never, 1 = strong). */
  speedSensitivity: number;
  /** How fast the virtual steering wheel can turn (lock-to-lock per second multiplier 0.5..2). */
  steerSpeed: number;
  vibration: boolean;
  invertLookY: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings, race config, results (owner: game; edited by UI)
// ─────────────────────────────────────────────────────────────────────────────

export interface AudioSettings {
  master: number; // 0..1
  engine: number;
  effects: number;
  /** The menu theme (it plays on the menus, and on the results screen when the race music is off). */
  music: number;
  /** The race music: the album that plays, shuffled, while someone drives. 0 turns it off. */
  raceMusic: number;
  ui: number;
}

/** A song of the race music, as the "now playing" card and the pause menu show it. */
export interface NowPlaying {
  id: string;
  title: string;
  genre: string;
  /** The album's name, as the card prints it after "Xeno-Racer": "Vol. 1". */
  album: string;
}

export type CameraMode = 'chase' | 'chase-far' | 'hood' | 'bumper' | 'cockpit' | 'tv' | 'orbit';

/**
 * What a crash does to a car. 'off': cars stay pristine. 'visual': crumpled panels, scraped paint and broken lamps,
 * nothing more (src/core/damage.ts). 'full': all of that, and a hard hit also changes how the car drives: bent suspension,
 * lost downforce, a tired engine (src/core/mechanical.ts). The pack-racing bumps and light grazes stay cosmetic.
 */
export type DamageMode = 'off' | 'visual' | 'full';

/**
 * Rear-view mirrors. 'auto': real glass that reflects the road behind in the cockpit view, a HUD mirror strip at the
 * top of the screen in the hood and bumper views. 'off': no mirror view is rendered at all.
 */
export type MirrorMode = 'auto' | 'off';

/** Split screen (two players, one screen): player 1 sits in seat 0, player 2 in seat 1. */
export type Seat = 0 | 1;

/** How a split-screen race divides the screen: 'rows' = one wide view above the other (the default), 'columns' = side by side. */
export type SplitLayout = 'rows' | 'columns';

export interface Settings {
  graphics: GraphicsSettings;
  audio: AudioSettings;
  controls: ControlSettings;
  /** Player 1's aids (the one player's, in a single-player race). */
  assists: PlayerAssists;
  /** Split screen: player 2's aids (a save from before they existed starts from a copy of `assists`). */
  assists2: PlayerAssists;
  units: 'kmh' | 'mph';
  hud: { minimap: boolean; telemetry: boolean; ghost: boolean; standings: boolean; mirror: MirrorMode; spotter: boolean };
  camera: { fov: number; defaultMode: CameraMode; shake: number };
  damage: DamageMode;
  /** Nitro (src/core/nitro.ts) for every car on track, humans and AI. Off: no car has any, the gauge is hidden, E and B do nothing. */
  nitro: boolean;
  playerName: string;
  /** Split screen (src/core/split.ts): the second driver's name, and how the screen divides. */
  player2Name: string;
  split: { layout: SplitLayout };
}

export type RaceMode = 'race' | 'timeTrial' | 'freeRoam';
export type Difficulty = 'rookie' | 'amateur' | 'pro' | 'alien';

/** One slot of a championship round's grid. */
export interface ChampionshipGridSlot {
  /** Stable driver id within the championship. */
  id: string;
  name: string;
  isPlayer: boolean;
  /** Opponents: their season livery and AI variation seed (stable, so a driver's pace is too). */
  livery?: Livery;
  seed?: number;
}

/** Present on the races of a championship: which round this is and who starts where. */
export interface ChampionshipRoundInfo {
  /** "Xeno Cup". */
  name: string;
  /** 1-based. */
  round: number;
  rounds: number;
  /** The grid, pole first. All drivers use the player's car; opponents keep their identity all season. */
  grid: ChampionshipGridSlot[];
}

export interface RaceConfig {
  mode: RaceMode;
  trackId: string;
  carId: string;
  livery?: Partial<Livery>;
  laps: number;
  opponents: number; // 0..11
  difficulty: Difficulty;
  environment: EnvironmentSettings;
  startPosition: 'back' | 'middle' | 'pole';
  /**
   * Split screen: a second human drives on the same screen, in a car of their own (races and free roam; a time trial and a
   * championship are for one). `livery.driver` is their name. Absent = one player. The two start side by side at `startPosition`,
   * and `opponents` counts at most 10 (src/core/split.ts MAX_SPLIT_OPPONENTS).
   */
  player2?: { carId: string; livery?: Partial<Livery> };
  /**
   * Weather that changes during the race (see `Forecast`): `environment.weather` is the weather at the start. Races and free roam
   * only (a time trial stays as set), and only where it makes sense: rain later from a dry weather, clearing from a wet one
   * (`sanitizeForecast` in src/game/weather.ts). Absent = stable.
   */
  forecast?: Forecast;
  /** Decides when the change comes and how hard (so that a restart repeats it). Absent = 1. */
  forecastSeed?: number;
  /** Set for a round of a championship (mode is then always 'race'); `grid` overrides `startPosition`. */
  championship?: ChampionshipRoundInfo;
}

export interface RaceResultEntry {
  position: number;
  name: string;
  carId: string;
  isPlayer: boolean;
  totalTime: number | null; // null = DNF / not finished
  bestLap: number | null;
  gap: string; // "+1.234" / "+1 LAP" / "WINNER"
  laps: number;
  /** Championship rounds: points scored in this race (fastest-lap bonus included). */
  points?: number;
  /** Championship rounds: this driver took the fastest-lap point. */
  fastestLap?: boolean;
  /** Split screen: which of the two humans this row is (absent for an opponent; absent for the one player of a single-player race). */
  seat?: Seat;
}

/** The duel of a split-screen race: the two humans against each other (all of it in seat order). */
export interface SplitDuel {
  names: [string, string];
  /** Who finished ahead of the other: null when neither finished (or they tie). */
  winner: Seat | null;
  /** How far behind the winner the other one finished: "+3.241", "+1 LAP", or "" when it is no time (the other did not finish). */
  gap: string;
  /** Places in the whole race. */
  positions: [number, number];
  /** Each human's own laps, best lap and whether the lap set a new personal best for the track and car. */
  lapTimes: [number[], number[]];
  bestLap: [number | null, number | null];
  personalBest: [boolean, boolean];
  /** The car each drove (ids). */
  carIds: [string, string];
}

export interface RaceResults {
  config: RaceConfig;
  entries: RaceResultEntry[];
  /** Player 1's laps (the one player's, in a single-player race). */
  playerLapTimes: number[];
  personalBest: boolean; // player set a new best lap for this track+car
  /** Split screen: both humans, and who beat whom. */
  duel?: SplitDuel;
}

/**
 * Who is playing on what, for the screens that deal with the second player (the join step of the setup, the pause menu):
 * the game fills it from the input system and hands it to the UI.
 */
export interface PlayersInfo {
  /** The device each seat plays on ("Logitech Gamepad F310", "Keyboard"); null = nobody there yet. */
  devices: [string | null, string | null];
  /** Controllers connected right now (a second player needs another controller, or the keyboard). */
  pads: number;
  /** The second player has joined: their device is bound. */
  joined: boolean;
  /** A race is paused: the seat whose device drives the menu (the pad that paused it), null = either. */
  owner: Seat | null;
  /** A seat's controller was unplugged: the pause menu says whose. */
  missing: Seat | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Championship (owner: game computes everything; the UI only renders these view models)
// ─────────────────────────────────────────────────────────────────────────────

/** How long each race of a championship is, relative to the track's default lap count. */
export type ChampionshipLength = 'short' | 'standard' | 'long';

/** What the player chooses when starting a championship (the calendar itself is fixed). */
export interface ChampionshipSetup {
  carId: string;
  livery?: Partial<Livery>;
  difficulty: Difficulty;
  /** AI opponents, 1..11. */
  opponents: number;
  length: ChampionshipLength;
  /** Where the player starts round 1. */
  startPosition: 'back' | 'middle' | 'pole';
  /** Rounds 2+: gridded by the championship standings (leader on pole) or by the reverse of them. */
  grid: 'standings' | 'reverse';
}

/** One entry of the fixed calendar, as the setup screen previews it. */
export interface ChampionshipRoundDef {
  trackId: string;
  environment: EnvironmentSettings;
  /** The weather changes during this round (it runs at two laps or more). */
  forecast?: Forecast;
  /** Laps of this round for every race length. */
  laps: Record<ChampionshipLength, number>;
}

/** The fixed calendar and scoring rules. */
export interface ChampionshipDef {
  name: string;
  rounds: ChampionshipRoundDef[];
  /** Points for P1, P2, ...; everyone further back scores nothing. */
  points: number[];
  /** Bonus for the fastest lap of a race, if its driver finishes in the points. */
  fastestLapPoint: number;
}

export interface ChampionshipRow {
  /** Championship position, 1-based. */
  position: number;
  id: string;
  name: string;
  isPlayer: boolean;
  /** Livery colour (the player's chip is teal, as in the race tower). */
  color: string;
  points: number;
  /** Points behind the leader (0 for the leader). */
  gap: number;
  /** Per calendar round: points scored, or null if the round has not been raced yet. */
  roundPoints: (number | null)[];
  /** Per calendar round: finishing position, or null. */
  roundPositions: (number | null)[];
  /** Per calendar round: this driver took the fastest-lap point. */
  roundFastest: boolean[];
  wins: number;
  podiums: number;
  fastestLaps: number;
  /** Places gained (+) or lost (-) in the last completed round; null while there is nothing to compare. */
  move: number | null;
  /** Championship position before the last completed round (the roster order before any round was raced). */
  prevPosition: number;
  /** Points scored in the last completed round. */
  lastGain: number;
}

export interface ChampionshipRoundView {
  /** 0-based index in the calendar. */
  round: number;
  trackId: string;
  environment: EnvironmentSettings;
  /** The weather changes during this round. */
  forecast?: Forecast;
  laps: number;
  done: boolean;
  winner: { name: string; isPlayer: boolean } | null;
  /** The player's finish and points in a completed round. */
  playerPosition: number | null;
  playerPoints: number | null;
  fastestLap: { name: string; time: number; isPlayer: boolean } | null;
}

/** Everything the menus need to show a championship in progress (or just finished). */
export interface ChampionshipView {
  name: string;
  carId: string;
  difficulty: Difficulty;
  length: ChampionshipLength;
  opponents: number;
  grid: ChampionshipSetup['grid'];
  rounds: ChampionshipRoundView[];
  /** Rounds completed; the next one to race has this index (== rounds.length once the season is over). */
  done: number;
  complete: boolean;
  /** Standings, best first. */
  table: ChampionshipRow[];
  /** The player's row of `table`. */
  player: ChampionshipRow;
  /** The player's season so far. */
  season: { rounds: number; wins: number; podiums: number; fastestLaps: number; points: number; bestFinish: number | null };
}

// ─────────────────────────────────────────────────────────────────────────────
// HUD (owner: ui — the game fills HudState every frame)
// ─────────────────────────────────────────────────────────────────────────────

export interface HudStanding {
  position: number;
  name: string;
  gap: string; // "LEADER" / "+1.234" / "+1L"
  isPlayer: boolean;
  color: string;
  /** Split screen: which human this row is (every human has a row in both towers; `isPlayer` is true for both). */
  seat?: Seat;
}

export interface HudState {
  mode: RaceMode;
  units: 'kmh' | 'mph';
  speed: number; // m/s (UI converts)
  rpm: number;
  idleRpm: number;
  redlineRpm: number;
  limiterRpm: number;
  gear: number; // -1 R, 0 N
  throttle: number;
  brake: number;
  steer: number;
  /** 0..1 shift light progression (1 = shift now). */
  shiftLight: number;
  absActive: boolean;
  tcsActive: boolean;
  escActive: boolean;
  lap: number; // 1-based current lap
  totalLaps: number; // 0 = unlimited (free roam / time trial)
  position: number;
  totalCars: number;
  raceTime: number;
  lapTime: number;
  lastLap: number | null;
  bestLap: number | null;
  /** Live delta vs best lap (s, negative = faster). null if no reference. */
  delta: number | null;
  sector: number; // 0..2
  sectorDeltas: (number | null)[]; // per sector vs best, this lap
  standings: HudStanding[];
  /** Car markers for the minimap (world XZ). */
  cars: { x: number; z: number; heading: number; color: string; isPlayer: boolean; seat?: Seat }[];
  // (`isPlayer` is true for a human's car; in split screen both humans are on the map and `seat` says which, and the HUD of seat s
  // draws its own car as the player's.)
  gLat: number; // in g, + = left
  gLong: number; // in g, + = accelerating
  tires: { slip: number; tempC: number; load: number }[]; // FL FR RL RR, load as fraction of static
  /** Start lights: null = hidden, 0..5 = number of red lights lit, 6 = GO (all out). */
  countdown: number | null;
  wrongWay: boolean;
  /** Big centered message (e.g. "FINAL LAP"), null for none. */
  banner: string | null;
  /** Small toasts like "FASTEST LAP 1:32.481". */
  toast: string | null;
  showTelemetry: boolean;
  hudVisible: boolean;
  /** Set during a championship round ("Round 2 / 4"). The game keeps one object for the whole race. */
  championship?: { name: string; round: number; rounds: number } | null;
  /**
   * Cars alongside or closing within a car length, per side of the player's car: `left` / `right` 0 = nobody near ..
   * 1 = touching (already smoothed, safe to draw as it is), `leftAt` / `rightAt` where along the car it is, -1 = behind
   * .. +1 = ahead. Null = hidden: the setting is off, or the view is not the driver's (the TV and orbit cameras, where
   * the screen's left is not the car's), or the race has not started.
   */
  spotter?: { left: number; right: number; leftAt: number; rightAt: number } | null;
  /** The HUD mirror strip is on screen at the top centre: toasts and banners step below it. */
  mirror?: boolean;
  /** The conditions of a race whose weather changes (null or absent: stable weather, nothing to show). */
  weather?: HudWeather | null;
  /** The player's mechanical damage (Damage: Full), or null when the car is sound or the mode is not Full. */
  damage?: HudDamage | null;
  /** The braking assist is on the brakes right now: the pedal it adds on top of the driver's (0..1; 0 or absent: it is not acting). */
  brakeAssist?: number;
  /** The player's nitro (src/core/nitro.ts): shots left on this lap of `max`, and what is left of the shot burning (1..0; 0 = none). Absent: hidden. */
  nitro?: HudNitro | null;
}

/** The nitro gauge: shots left on this lap, of `max`, and the share left of the shot burning now (1 when fired, down to 0). */
export interface HudNitro {
  charges: number;
  max: number;
  burn: number;
}

/**
 * How badly each part of the player's car is hurt, 0 = sound .. 1 = as bad as it gets (src/core/mechanical.ts): what the HUD's
 * car outline tints, amber to red. The game keeps one object and rewrites it in place.
 */
export interface HudDamage {
  /**
   * The nose (the front downforce, on a car that has any, else the engine, on a car with its radiator in the nose), the tail (the rear
   * downforce, on a car that has any, else the rear wheels knocked a little out of line), and the two flanks (the suspension on that
   * side). A part lights only for what its damage costs this car: see mechanicalReport.
   */
  front: number;
  rear: number;
  left: number;
  right: number;
  /** The alignment of each wheel: FL FR RL RR. */
  wheels: [number, number, number, number];
}

/** The conditions chip of a race whose weather changes, and the broadcast notice that something is about to happen to it. */
export interface HudWeather {
  /** The sky as its nearest weather preset (for the icon). */
  sky: Weather;
  rain: number;
  wetness: number;
  /** What the track is like under the tyres: "Dry", "Damp", "Wet", "Very wet", "Soaked" ("Packed", "Dusted", "Fresh snow", ... on a winter circuit). */
  track: string;
  /** A winter circuit: the rain is snow, the storm a blizzard (the words and the icon). */
  winter?: boolean;
  forecast: Exclude<Forecast, 'stable'>;
  /** The change has begun (the call has been made); before it the weather is still the one the race started in. */
  called: boolean;
  /** A notice on screen right now ("Rain is coming" with a line under it), or null. The game keeps the same object while it shows. */
  notice: { kind: 'rain' | 'clearing'; title: string; sub: string } | null;
}

/** Minimap geometry, sent once per track. */
export interface MinimapTrack {
  points: { x: number; z: number }[]; // centerline, ~ every 5 m
  width: number; // typical road width (m)
  startIndex: number;
  sectorIndices: [number, number];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/** Everything the UI can ask the game to do. */
export type UIIntent =
  | { type: 'startRace'; config: RaceConfig }
  | { type: 'resume' }
  | { type: 'restart' }
  | { type: 'quitToMenu' }
  | { type: 'settingsChanged'; settings: Settings }
  | { type: 'previewCar'; carId: string; livery?: Partial<Livery> }
  | { type: 'previewTrack'; trackId: string }
  | { type: 'menuOpened'; screen: string }
  | { type: 'watchReplay' }
  /** Start a new championship (replacing any saved one) and its first round. The game calls `setRaceConfig()` and shows the loading screen. */
  | { type: 'startChampionship'; setup: ChampionshipSetup }
  /** Race the next round of the saved championship (the game shows the loading screen, as for `startChampionship`). */
  | { type: 'championshipNext' }
  /** Forget the saved championship (abandoned, or finished and seen). */
  | { type: 'championshipAbandon' }
  /**
   * The split-screen join step of the setup. 'join': listen for the second player (A on another controller, Enter for the keyboard);
   * 'cancel': stop listening; 'swap': player 1 and player 2 change devices; 'unbind': there is no second player any more (back to the
   * menu, or a one-player setup). The game answers with `setPlayers()`.
   */
  | { type: 'split'; action: 'join' | 'cancel' | 'swap' | 'unbind' }
  /** Skip to the next song of the race music (the pause menu's "Next track"). */
  | { type: 'nextTrack' };

export type UiSound = 'move' | 'select' | 'back' | 'error' | 'countdown' | 'go' | 'lap' | 'bestLap' | 'finish';
