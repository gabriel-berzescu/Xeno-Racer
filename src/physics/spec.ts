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
  /** Fraction of dry grip kept on fully wet asphalt (≈0.55 slick .. 0.8 treaded road tire). Default 0.72. */
  wetGrip?: number;
  /**
   * 0..1 how much of an all-terrain tyre it is (absent: 0, a road or race tyre): open blocks and deep voids that bite into grass,
   * dirt, gravel, sand and deep snow, where a road tyre skates on the top. Paid for on paved surfaces through a lower `mu`.
   */
  offroad?: number;
  /**
   * 0..1 how much of a racing slick it is (absent: 0, a road or an all-terrain tyre): a smooth face of soft rubber with no tread at all.
   * It is the other end of the scale from `offroad` (a tyre with both nets them off against each other), and its price is the ground
   * that is not a road: on grass, dirt, gravel, sand and deep snow there is nothing for the rubber's adhesion to work on and no tread to
   * key into the ground, so it keeps a good deal less of its grip than a road tyre does, far less on wet turf and dirt, and a wide smooth
   * tyre digs into gravel and sand. Paved ground (asphalt, kerb, concrete), packed snow and ice are the same for every tyre. A winter
   * circuit's studded tyre (src/physics/compound.ts) replaces it entirely. See `SLICK_LOSS`, src/physics/surfaces.ts.
   */
  slick?: number;
  /**
   * How many times the thermal size of a standard road tyre this one is (absent: 1). The tread's temperature is fed by the work of the
   * tyre, per newton and per metre of slide, and the rubber and the surface it has to carry that heat are what a tyre of the common
   * 235-305 mm width has. A tall 315 mm tyre under a 2.4 t car works with more than twice the force and has about twice the rubber and
   * the surface: the same work warms it correspondingly less, and it settles in the same working window instead of far above it.
   */
  heatScale?: number;
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
  /**
   * An electric motor geared to the crankshaft (absent: none), a 2026 MGU-K. It deploys only while a nitro shot burns, and on a car
   * that has one it is the nitro: no push from a bottle and no extra engine torque. Up to `powerKw` and `torqueNm` at the crank, the power
   * full up to `fullToKmh` and tapering above it to nothing at `zeroAtKmh` (the 2026 rule made simpler: 350 kW to 290 km/h, then
   * 1800 - 5 v kW with v in km/h, cut at 345; electricPower says where the rule itself differs).
   */
  electric?: { powerKw: number; torqueNm: number; fullToKmh: number; zeroAtKmh: number };
  /**
   * The engine speed the launch control holds a standing start at on a full throttle, rpm (absent: half the redline, at most 4600 and at
   * least 900 over the idle, a road car's). That would hold a racing V10 that idles at 4000 at 4900, barely off its idle; a 2004
   * single-seater left the line at about 10,000. On a part throttle it is as much less as a road car's, and on a winter circuit, on studs,
   * every car is held at a road car's (Vehicle.launchRpm).
   */
  launchRpm?: number;
  /**
   * The engine's throttle map (absent: none, the throttle is the pedal). A pedal p opens the throttle to p^throttleGamma, as a racing
   * engine's drive-by-wire map opens it less for a small pedal: with 1.3 a third of the pedal is a quarter of the throttle, and half of it
   * four tenths. The traction control, the stability control and the limiter cut what it opens; VehicleState.throttle reads that, and
   * VehicleState.throttlePedal what the map opens for the pedal before they cut it.
   */
  throttleGamma?: number;
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
  /**
   * An active aero's low-drag mode (absent: fixed wings): the same three areas with the front-wing flaps and the rear-wing flap laid
   * flat for a straight (about a fifth less drag and a quarter less downforce on a 2026 single-seater). The areas above are the corner
   * mode; the car moves between the two with `VehicleState.aeroOpen`, opening on a straight under full throttle and closing at once on
   * a lift, the brakes or a turn of the wheel.
   */
  straightMode?: { dragArea: number; liftAreaFront: number; liftAreaRear: number };
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
