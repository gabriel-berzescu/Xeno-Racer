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
import type { Quaternion, Vector3 } from 'three';
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
  | 'dirt';

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

export type ImpactKind = 'wall' | 'car' | 'ground';

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

export type BodyStyle = 'gt' | 'hatch' | 'coupe' | 'prototype';

/** Everything the car-visual builder needs. Body geometry origin: on the ground, centered
 *  between the axles and between the wheels. The center of mass sits at
 *  (0, cgHeight, cgToFrontAxle - wheelbase/2) relative to that origin. */
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
}

export interface CarDefinition {
  id: string;
  name: string;
  maker: string; // fictional
  description: string;
  class: 'Road' | 'Sport' | 'GT' | 'Prototype';
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
}

/** Rain and track water per weather preset (shared by render, physics, AI and audio). */
export const WEATHER_WATER: Record<Weather, { rain: number; wetness: number }> = {
  clear: { rain: 0, wetness: 0 },
  cloudy: { rain: 0, wetness: 0 },
  overcast: { rain: 0, wetness: 0 },
  rain: { rain: 0.55, wetness: 0.75 },
  storm: { rain: 1, wetness: 1 },
};

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
  music: number;
  ui: number;
}

export type CameraMode = 'chase' | 'chase-far' | 'hood' | 'bumper' | 'cockpit' | 'tv' | 'orbit';

export interface Settings {
  graphics: GraphicsSettings;
  audio: AudioSettings;
  controls: ControlSettings;
  assists: Assists;
  units: 'kmh' | 'mph';
  hud: { minimap: boolean; telemetry: boolean; ghost: boolean; standings: boolean };
  camera: { fov: number; defaultMode: CameraMode; shake: number };
  playerName: string;
}

export type RaceMode = 'race' | 'timeTrial' | 'freeRoam';
export type Difficulty = 'rookie' | 'amateur' | 'pro' | 'alien';

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
}

export interface RaceResults {
  config: RaceConfig;
  entries: RaceResultEntry[];
  playerLapTimes: number[];
  personalBest: boolean; // player set a new best lap for this track+car
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
  cars: { x: number; z: number; heading: number; color: string; isPlayer: boolean }[];
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
  | { type: 'watchReplay' };

export type UiSound = 'move' | 'select' | 'back' | 'error' | 'countdown' | 'go' | 'lap' | 'bestLap' | 'finish';
