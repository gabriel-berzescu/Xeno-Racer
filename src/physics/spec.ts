/**
 * Vehicle physical specification. All values SI. Owned by physics.
 */

export interface TireSpec {
  radius: number; // m (unloaded)
  width: number; // m
  /** Rotating inertia of wheel + tire + brake disc + half shaft (kg·m²). */
  inertia: number;
  /** Peak friction coefficient at nominal load, optimal temperature, dry asphalt. */
  mu: number;
  /** Fraction mu falls per +100 % load above nominal (0.08 .. 0.25). */
  loadSensitivity: number;
  /** Load (N) at which mu is defined. */
  nominalLoad: number;
  /** Slip angle (rad) where lateral force peaks. */
  peakSlipAngle: number;
  /** Slip ratio where longitudinal force peaks. */
  peakSlipRatio: number;
  /** Force retained deep into a slide, as a fraction of peak (0.6 .. 0.9). */
  slideRatio: number;
  /** Carcass relaxation length (m) — transient slip build-up. */
  relaxationLength: number;
  /** Rolling resistance coefficient. */
  rollingResistance: number;
  /** Optimal tread temperature (°C) and half-width of the working window. */
  optimalTemp: number;
  tempWindow: number;
  /** Grip at a cold tire relative to optimal (0.85 road .. 0.7 slick). */
  coldGrip: number;
}

export interface SuspensionSpec {
  /** Total wheel travel (m). */
  travel: number;
  /** Wheel rate (N/m). */
  spring: number;
  /** Damping (N·s/m) in bump (compression) and rebound (extension). */
  bump: number;
  rebound: number;
  /** Anti-roll bar rate (N/m of wheel-to-wheel travel difference). */
  antiRoll: number;
  /** Static camber (rad, negative = top leaning in). */
  camber: number;
}

export interface EngineSpec {
  idleRpm: number;
  redlineRpm: number;
  limiterRpm: number;
  /** Full-load torque curve, [rpm, Nm] ascending. */
  torqueCurve: [number, number][];
  /** Closed-throttle engine braking torque at the limiter (Nm), scales ~linearly with rpm. */
  engineBraking: number;
  /** Crank + flywheel inertia (kg·m²). */
  inertia: number;
  turbo: null | {
    /** Torque at zero boost as a fraction of the full-boost curve (0.45 .. 0.7). */
    baseFraction: number;
    /** Spool time constant (s) at mid rpm. */
    spoolTime: number;
    /** Rpm below which the turbo barely builds boost. */
    spoolRpm: number;
  };
}

export interface DifferentialSpec {
  type: 'open' | 'lsd' | 'locked';
  /** Clutch-pack preload torque (Nm). */
  preload: number;
  /** Locking under drive (0 = open .. 1 = locked). */
  powerLock: number;
  /** Locking under engine braking. */
  coastLock: number;
}

export interface DrivetrainSpec {
  layout: 'FWD' | 'RWD' | 'AWD';
  gears: number[]; // forward ratios, 1st first
  reverse: number;
  finalDrive: number;
  efficiency: number; // 0.85 .. 0.95
  /** Time (s) torque is interrupted during a shift. */
  shiftTime: number;
  /** Autoshift points as fraction of redline / downshift target. */
  upshiftRpm: number;
  downshiftRpm: number;
  diff: DifferentialSpec;
  /** AWD only: fraction of torque to the front axle (center diff). */
  frontSplit: number;
  centerDiff?: DifferentialSpec;
  frontDiff?: DifferentialSpec;
}

export interface BrakeSpec {
  /** Max brake torque per front / rear wheel at full pedal (Nm). */
  frontTorque: number;
  rearTorque: number;
  handbrakeTorque: number; // per rear wheel
  /** Brake disc thermal mass (J/°C) per wheel — for brake temp / glow. */
  discHeatCapacity: number;
}

export interface AeroSpec {
  /** Drag coefficient × frontal area (m²). */
  dragArea: number;
  /** Downforce coefficient × area at the front / rear axle (m², + = downforce). */
  liftAreaFront: number;
  liftAreaRear: number;
}

export interface ChassisSpec {
  mass: number; // kg incl. driver & fuel
  /** Principal moments of inertia in the car frame (x = pitch, y = yaw, z = roll), kg·m². */
  inertia: { x: number; y: number; z: number };
  cgHeight: number; // above ground at static ride height
  wheelbase: number;
  cgToFrontAxle: number;
  trackFront: number;
  trackRear: number;
  /** Max road-wheel steering angle (rad) at full lock. */
  maxSteer: number;
  /** 0 = parallel steer, 1 = full Ackermann. */
  ackermann: number;
  /** Collision hull: half extents (m) of the body box, and its center offset from the CG (car frame). */
  hullHalf: { x: number; y: number; z: number };
  hullOffset: { x: number; y: number; z: number };
  /** Rest ride height: distance from wheel center to chassis attachment at full extension is derived. */
}

export interface VehicleSpec {
  chassis: ChassisSpec;
  engine: EngineSpec;
  drivetrain: DrivetrainSpec;
  brakes: BrakeSpec;
  aero: AeroSpec;
  tireFront: TireSpec;
  tireRear: TireSpec;
  suspFront: SuspensionSpec;
  suspRear: SuspensionSpec;
}
