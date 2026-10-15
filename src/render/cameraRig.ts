/**
 * Camera rig (owner: render) — chase, chase-far, hood, bumper, cockpit, tv, orbit.
 *
 *   export function createCameraRig(track: TrackRuntime | null, tvCameras: TrackScene['tvCameras']): CameraRig
 *
 * How it works
 *  - Frame-rate independence: every filter that moves the camera is the exact solution of its ODE over
 *    the step, assuming the target moves linearly between two frames ("first-order hold"); the stick
 *    filter, whose time constant depends on the stick, is integrated in ~4 ms substeps. The same drive
 *    at 30, 60 or 144 Hz gives the same camera path (tested to < 3 mm). Shake envelopes and the car-size
 *    estimate use plain exponential decay 1 - exp(-dt/tau). dt is clamped to [TUNING.dtMin, TUNING.dtMax].
 *  - Chase cameras follow the car's translation rigidly (no distance lag); only the swing (heading,
 *    pitch) and the small G-force offsets are smoothed. During slides the heading blends from the car's
 *    yaw toward its velocity heading, so the car rotates under a camera that keeps looking down the road.
 *  - Hood/bumper/cockpit cameras sit on the car-visual anchors behind a "mount" filter: a critically damped
 *    spring on the camera's offset from the anchor that ignores steady motion (zero lag at a constant
 *    yaw rate) and only absorbs fast changes, so suspension micro-jitter is filtered without the view
 *    swimming against the bodywork.
 *  - Shake is deterministic band-limited noise (sums of sines at incommensurate frequencies, no
 *    Math.random) plus under-damped impact oscillators. setShake() scales all of it.
 *  - update() allocates nothing: every temporary is preallocated at module or instance level.
 *
 * Stick conventions (InputFrame, already corrected for invertLookY by the input module):
 *    look.x +1 = stick right, look.y +1 = stick up = "look up".
 *  In every mode the stick moves the VIEW DIRECTION: stick right turns the view right, stick up tilts it up.
 *  For cameras that orbit the car (chase, orbit) that means stick right swings the camera to the car's
 *  LEFT side (looking right across the car), stick up lowers the camera (looking up at the car) and stick
 *  down raises it (looking down on the car).
 *
 * Car frame: +Z forward, +Y up, +X LEFT. A positive yaw angle turns +Z toward +X, i.e. to the left;
 * yaw = atan2(dir.x, dir.z) for a world direction.
 *
 * Car size: wheelbase / track / ground height come from the wheel hubs and contact points (always
 * consistent with state.position); roof height comes from anchors.chase (it sits on the roof). Anchors
 * that are not posed yet (e.g. still at the origin before the first CarVisual.update) are detected and
 * ignored; anchor-mounted cameras then place the anchor's local position on the car from VehicleState.
 */
import { Euler, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { CameraMode, GroundSample, TrackPoint, TrackRuntime, VehicleState } from '../core/contracts';
import type { CameraRig, CameraTarget, TrackScene } from '../core/systems';

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/** Cycle order of next(). */
export const CAMERA_MODES: CameraMode[] = ['chase', 'chase-far', 'hood', 'bumper', 'cockpit', 'tv', 'orbit'];

// ═════════════════════════════════════════════════════════════════════════════
// TUNING — every number worth tweaking. SI units, angles in radians unless the name ends in Deg.
// Mutable on purpose so a sandbox can tweak it live.
// ═════════════════════════════════════════════════════════════════════════════
export const TUNING = {
  // ── rig-wide ───────────────────────────────────────────────────────────────
  /** dt clamp (s). */
  dtMin: 1 / 500,
  dtMax: 0.1,
  /** Base vertical FOV (deg) until setFov() is called. */
  fovDefaultDeg: 62,
  /** Clip planes (m). The cockpit uses the smaller near plane. */
  near: 0.12,
  nearCockpit: 0.05,
  far: 6000,
  /** A jump larger than this (m) plus 3 frames of the car's own travel = teleport -> hard cut. */
  teleportDistance: 30,

  // ── car size ───────────────────────────────────────────────────────────────
  /** Reference car (Vanta GT): the distances below frame this car. */
  refWheelbase: 2.7,
  refRoofHeight: 1.22, // roof above ground (m)
  refCgHeight: 0.46,
  /** 0 = same framing for every car, 1 = distances proportional to the car's size. */
  sizeInfluence: 0.75,

  // ── chase / chase-far ──────────────────────────────────────────────────────
  chaseDistance: 5.8, // m behind the CG
  chaseHeight: 1.55, // m above the CG
  chaseFarDistance: 8.8,
  chaseFarHeight: 2.6,
  chaseFarFovDeg: 3, // extra FOV in chase-far
  /** Heading swing: critically damped spring stiffness (rad/s); higher = tighter. */
  swingOmega: 6.5,
  /** 0..1: share of the steady corner lag (2·yawRate/swingOmega) cancelled. 0 = classic lagging spring. */
  swingLead: 0.35,
  /** The chase frame pitches with the ground slope along the heading (rad/s stiffness, clamp rad). */
  pitchOmega: 3.5,
  maxSlope: 0.5,
  /** Heading = carYaw + w·slip. w rises from 0 at slipBlendStart to slipBlendMax at slipBlendFull, */
  slipBlendMax: 0.75,
  slipBlendStart: 3 * DEG,
  slipBlendFull: 30 * DEG,
  /** falls back to 0 between these slip angles (spins, reversing: stay behind the car), */
  slipBackStart: 100 * DEG,
  slipBackEnd: 150 * DEG,
  /** and is scaled by the horizontal speed (m/s): 0 below slipSpeedMin, 1 above slipSpeedFull. */
  slipSpeedMin: 2,
  slipSpeedFull: 9,
  /** Look target: ahead of the CG along the heading (m), growing with speed up to lookAheadSpeed (m/s). */
  lookAheadMin: 3,
  lookAheadMax: 9,
  lookAheadSpeed: 70,
  lookAheadTau: 0.4,
  /** Look target height above the roof (m). */
  lookAboveRoof: 0.25,
  /** Speed FOV: up to +speedFovMaxDeg, smoothstep between speedFovStart and speedFovFull (m/s). */
  speedFovMaxDeg: 14,
  speedFovStart: 8,
  speedFovFull: 90,
  speedFovTau: 0.35,
  /** Longitudinal G: the camera pulls back under acceleration / moves in under braking (m per m/s²). */
  accelPull: 0.035,
  accelPullMax: 0.45,
  brakePushMax: 0.6,
  accelOmega: 5,
  /** Lateral G bank (rad per m/s², + = bank INTO the corner) and accel pitch (+ = view up when accelerating). */
  latRoll: 0.2 * DEG,
  latRollMax: 2.5 * DEG,
  accelPitch: 0.07 * DEG,
  accelPitchMax: 1.2 * DEG,
  dynOmega: 4,
  /** Track constraints (only with a TrackRuntime): min height above the drivable surface (m), */
  groundClearance: 0.35,
  /** how far the camera may be beyond a barrier face (m), */
  wallMargin: 0.2,
  /** and the wall push only acts while the car is within this distance (m) of that wall. */
  wallCarNear: 6,
  /** Ground/wall corrections attack fast and release slowly (s). */
  clampAttackTau: 0.03,
  clampReleaseTau: 0.3,
  /** Right stick in chase: yaw ±, view pitch up (camera lowers) / down (camera rises). */
  chaseLookYaw: 120 * DEG,
  chaseLookPitchUp: 10 * DEG,
  chaseLookPitchDown: 35 * DEG,
  /** Stick following time constant (s, stick deflected ≥ 0.2) and auto-centre after release (s, stick
   *  centred; settles in ~3τ ≈ 0.5 s). Blends continuously between the two with the deflection. */
  lookTau: 0.09,
  lookReturnTau: 0.17,
  /** Seconds to swing into / out of the rear view (look.back). */
  backTime: 0.25,

  // ── hood / bumper / cockpit ────────────────────────────────────────────────
  interiorFovDeg: 10,
  interiorSpeedFovDeg: 4,
  /** Mount filter stiffness (rad/s) for orientation and position: absorbs jitter above ~5-10 Hz. */
  mountOmegaRot: 26,
  mountOmegaPos: 35,
  /** Cockpit head motion: m per m/s² of G, travel limits (m), spring (rad/s, damping ratio). */
  headGain: 0.0045,
  headMaxLat: 0.05,
  headMaxLong: 0.06,
  headMaxVert: 0.035,
  headOmega: 15,
  headZeta: 0.75,
  /** Cockpit look-into-corner: limit, per full steering lock, per rad/s of yaw rate (s), per rad of slip. */
  cornerLookMax: 12 * DEG,
  cornerLookSteer: 6 * DEG,
  cornerLookYawRate: 0.22,
  cornerLookSlip: 0.3,
  cornerLookOmega: 6,
  /** Fraction of the cockpit roll (relative to gravity) cancelled to steady the horizon. */
  rollCompensation: 0.3,
  /** Right stick in hood/bumper/cockpit, and the cockpit look-back head turn + shift toward the centreline. */
  cockpitLookYaw: 100 * DEG,
  cockpitLookPitch: 35 * DEG,
  cockpitBackYaw: 160 * DEG,
  cockpitBackShift: 0.22,

  // ── shake (everything × setShake() × shakeByMode) ──────────────────────────
  shakeByMode: { chase: 1, 'chase-far': 0.75, hood: 0.7, bumper: 0.9, cockpit: 0.8, tv: 0, orbit: 0.3 } as Record<CameraMode, number>,
  /** Continuous speed shake: fades in between these speeds (m/s); peak rotation (rad) / position (m). */
  speedShakeStart: 45,
  speedShakeFull: 90,
  speedShakeRot: 0.16 * DEG,
  speedShakePos: 0.012,
  /** Curb buzz (any wheel on 'curb' and in contact). */
  curbShakeRot: 0.35 * DEG,
  curbShakePos: 0.012,
  /** Suspension shake: sum of |suspensionVelocity| (m/s) above the dead zone × gain -> 0..1. */
  suspShakeDead: 0.25,
  suspShakeGain: 0.6,
  suspShakeRot: 0.3 * DEG,
  suspShakePos: 0.015,
  /** Scrape rumble (state.scrape). */
  scrapeShakeRot: 0.25 * DEG,
  scrapeShakePos: 0.008,
  /** Impact kick: closing speed (m/s) for a full kick; initial offset velocity (m/s) and angular rate (rad/s). */
  impactRef: 14,
  impactPos: 2.4,
  impactRot: 0.9,
  /** Impact oscillator (rad/s, damping ratio): rings ~3 Hz and dies out in ~0.4 s. */
  impactOmega: 18,
  impactZeta: 0.4,
  /** TV operator sway amplitude (rad, × setShake). */
  tvSway: 0.05 * DEG,

  // ── tv ─────────────────────────────────────────────────────────────────────
  /** Leave the current camera after the car passed it by this much (m) or got this far away (m), */
  tvLeaveBehind: 35,
  tvLeaveDistance: 260,
  /** but only pick cameras the car has passed by less than this (m) and that are closer than this (m). */
  tvEnterBehind: 15,
  tvEnterDistance: 220,
  /** Never keep (or fall back to) a camera the car passed by more than this (m): the track scene keeps
   *  trees out of each camera's view only this far past it. */
  tvMaxBehind: 200,
  /** A camera only covers the road up to this far before it (m along the track): on switchbacks a
   *  camera can be close in 3D to a different leg of the road, seen through the forest between. */
  tvTrackAhead: 225,
  /** Choice cost: a camera ahead costs its distance ahead (m); one the car already passed costs
   *  tvBehindBias + tvBehindPenalty × distance behind, so a camera ahead within ~tvBehindBias m wins. */
  tvBehindBias: 60,
  tvBehindPenalty: 4,
  /** Minimum time on a camera (s). */
  tvMinDwell: 2.5,
  /** When no camera qualifies, only switch to one at least this much closer (distance ratio). */
  tvSwitchCloser: 0.75,
  /** Operator pan: exponential (s) + max angular speed (rad/s); aim leads the car by velocity × tvLead (s). */
  tvPanTau: 0.12,
  tvPanMaxRate: 2.4,
  tvLead: 0.12,
  /** Zoom: car bounding diameter / frame height, FOV clamp (deg), smoothing (s). */
  tvFrameFraction: 0.24,
  tvFovMinDeg: 5,
  tvFovMaxDeg: 50,
  tvFovTau: 0.25,
  /** Fallback when there is no track / no TV camera: fixed height above, behind the car's travel. */
  tvFallbackDistance: 13,
  tvFallbackHeight: 4.5,
  tvFallbackFovDeg: 40,
  tvFallbackTau: 1.5,

  // ── orbit ──────────────────────────────────────────────────────────────────
  orbitDistance: 7,
  /** rad/s at full stick deflection. */
  orbitRate: 2.2,
  orbitElevMin: -8 * DEG,
  orbitElevMax: 75 * DEG,
  /** Angle on entering orbit: 145° = front three-quarter view of the car's right side. */
  orbitStartYaw: 145 * DEG,
  orbitStartElev: 10 * DEG,
  orbitInputTau: 0.08,
  /** The orbit frame follows the car's yaw with this time constant (s). */
  orbitHeadingTau: 0.8,
  /** After this long without input (s) and above orbitDriftSpeed (m/s), drift back behind the car (τ s). */
  orbitIdleTime: 4,
  orbitDriftSpeed: 5,
  orbitDriftTau: 6,
};

type TvCameras = TrackScene['tvCameras'];
type Anchors = CameraTarget['anchors'];

// ─────────────────────────────────────────────────────────────────────────────
// Small math (pure, allocation-free)
// ─────────────────────────────────────────────────────────────────────────────

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
function ease(t: number): number {
  return t * t * (3 - 2 * t);
}
/** Finite or 0. */
function fin(x: number): number {
  return Number.isFinite(x) ? x : 0;
}
function wrapPi(a: number): number {
  a %= TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  else if (a <= -Math.PI) a += TWO_PI;
  return a;
}
/** Signed distance along a closed loop of length L, in (-L/2, L/2]. */
function wrapSigned(d: number, L: number): number {
  d %= L;
  if (d > L / 2) d -= L;
  else if (d <= -L / 2) d += L;
  return d;
}
/** Exponential smoothing factor for one step. */
function expK(h: number, tau: number): number {
  return tau > 1e-6 ? 1 - Math.exp(-h / tau) : 1;
}
function finiteVec(v: Vector3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}
function finiteQuat(q: Quaternion): boolean {
  return Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w);
}
/** Band-limited, deterministic noise in [-1, 1] around frequency f (Hz): three incommensurate sines. */
function wob(t: number, f: number, seed: number): number {
  const w = t * f * TWO_PI;
  return 0.513 * (Math.sin(w + seed) + 0.6 * Math.sin(1.618034 * w + 1.7 * seed + 1.3) + 0.35 * Math.sin(2.718282 * w + 2.3 * seed + 0.4));
}

// ─────────────────────────────────────────────────────────────────────────────
// Exact filters. `g` is the previous target, used for the first-order hold.
// ─────────────────────────────────────────────────────────────────────────────

interface Spring {
  x: number;
  v: number;
  g: number;
}
function spring(): Spring {
  return { x: 0, v: 0, g: 0 };
}
function springReset(s: Spring, target: number): void {
  s.x = target;
  s.v = 0;
  s.g = target;
}
/**
 * Critically damped spring, exact for a target moving linearly over the step. `lead` 0..1 is the share of
 * the target's own velocity the damper accepts: 0 = classic spring (steady lag 2·rate/ω while the target
 * moves at a constant rate), 1 = no steady lag (only changes of the target's rate are smoothed).
 */
function springStep(s: Spring, target: number, omega: number, lead: number, h: number): number {
  if (!(omega > 1e-3)) omega = 1e-3;
  const r = (target - s.g) / h;
  const c = (2 * (1 - lead) * r) / omega;
  const y0 = s.x - s.g + c;
  const yv = s.v - r;
  const b = yv + omega * y0;
  const e = Math.exp(-omega * h);
  s.x = target - c + (y0 + b * h) * e;
  s.v = r + (yv - omega * b * h) * e;
  s.g = target;
  return s.x;
}
/** Under-damped spring (zeta < 1), exact for a target moving linearly over the step. */
function oscStep(s: Spring, target: number, omega: number, zeta: number, h: number): number {
  if (!(omega > 1e-3)) omega = 1e-3;
  zeta = clamp(zeta, 0, 0.99);
  const r = (target - s.g) / h;
  const c = (2 * zeta * r) / omega;
  const y0 = s.x - s.g + c;
  const yv = s.v - r;
  const a = zeta * omega;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const e = Math.exp(-a * h);
  const cs = Math.cos(wd * h);
  const sn = Math.sin(wd * h);
  s.x = target - c + e * (y0 * cs + ((yv + a * y0) / wd) * sn);
  s.v = r + e * (yv * cs - ((a * yv + omega * omega * y0) / wd) * sn);
  s.g = target;
  return s.x;
}

interface Lag {
  x: number;
  g: number;
}
function lag(): Lag {
  return { x: 0, g: 0 };
}
function lagReset(s: Lag, target: number): void {
  s.x = target;
  s.g = target;
}
/** First-order lag x' = (target - x)/tau, exact for a target moving linearly over the step. */
function lagStep(s: Lag, target: number, tau: number, h: number): number {
  if (!(tau > 1e-6)) {
    s.x = target;
    s.g = target;
    return target;
  }
  const r = (target - s.g) / h;
  const e = Math.exp(-h / tau);
  s.x = target - r * tau + (s.x - s.g + r * tau) * e;
  s.g = target;
  return s.x;
}
/** lagStep that also returns the exact integral of x over the step (for integrating a smoothed rate). */
function lagStepIntegral(s: Lag, target: number, tau: number, h: number): number {
  const g0 = s.g;
  if (!(tau > 1e-6)) {
    s.x = target;
    s.g = target;
    return 0.5 * (g0 + target) * h;
  }
  const r = (target - g0) / h;
  const e = Math.exp(-h / tau);
  const a = s.x - g0 + r * tau;
  s.x = target - r * tau + a * e;
  s.g = target;
  return g0 * h + 0.5 * r * h * h - r * tau * h + a * tau * (1 - e);
}
/** Asymmetric exponential envelope. */
function envStep(x: number, target: number, tauUp: number, tauDown: number, h: number): number {
  return x + (target - x) * expK(h, target > x ? tauUp : tauDown);
}
/** Free critically damped decay of an offset `y` with velocity `v` (vector, in place). */
function damp3(y: Vector3, v: Vector3, w: number, h: number): void {
  const e = Math.exp(-w * h);
  let b = v.x + w * y.x;
  y.x = (y.x + b * h) * e;
  v.x = (v.x - w * b * h) * e;
  b = v.y + w * y.y;
  y.y = (y.y + b * h) * e;
  v.y = (v.y - w * b * h) * e;
  b = v.z + w * y.z;
  y.z = (y.z + b * h) * e;
  v.z = (v.z - w * b * h) * e;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preallocated temporaries (update() is synchronous, so instances can share them)
// ─────────────────────────────────────────────────────────────────────────────

const WORLD_UP = new Vector3(0, 1, 0);
const AX_X = new Vector3(1, 0, 0);
const AX_Y = new Vector3(0, 1, 0);
const AX_Z = new Vector3(0, 0, 1);
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _F = new Vector3();
const _U = new Vector3();
const _L = new Vector3();
const _D = new Vector3();
const _tgt = new Vector3();
const _aPos = new Vector3();
const _mPos = new Vector3();
const _q1 = new Quaternion();
const _q2 = new Quaternion();
const _aQuat = new Quaternion();
const _mQuat = new Quaternion();
const _euler = new Euler();
const _bx = new Vector3();
const _by = new Vector3();
const _bz = new Vector3();
const _m4 = new Matrix4();

/** Camera orientation looking along (fx, fy, fz) with `up` as the roll reference. False if degenerate. */
function lookQuat(fx: number, fy: number, fz: number, up: Vector3, out: Quaternion): boolean {
  const fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
  if (!(fl > 1e-9)) return false;
  _bz.set(-fx / fl, -fy / fl, -fz / fl); // camera +Z points backward
  _bx.crossVectors(up, _bz);
  const xl = _bx.length();
  if (!(xl > 1e-6)) return false;
  _bx.multiplyScalar(1 / xl);
  _by.crossVectors(_bz, _bx);
  _m4.makeBasis(_bx, _by, _bz);
  out.setFromRotationMatrix(_m4);
  return true;
}

function makeTrackPoint(): TrackPoint {
  return { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// The rig
// ─────────────────────────────────────────────────────────────────────────────

class CameraRigImpl implements CameraRig {
  readonly camera: PerspectiveCamera;
  private _mode: CameraMode = 'chase';
  private readonly track: TrackRuntime | null;
  private readonly tvCams: TvCameras;
  private fovBase = TUNING.fovDefaultDeg;
  private shake = 1;

  private first = true;
  private snapPending = false;
  /** The current mode was just entered: per-mode state (orbit angles, TV choice) starts over. */
  private entered = true;
  private time = 0;

  // ── car kinematics, refreshed every update ──
  private readonly qCar = new Quaternion();
  private readonly qInv = new Quaternion();
  private readonly cF = new Vector3(0, 0, 1);
  private readonly cU = new Vector3(0, 1, 0);
  private carYaw = 0;
  private yawRate = 0;
  private velYaw = 0;
  private slip = 0;
  private hSpeed = 0;
  private speed = 0;
  private readonly prevPos = new Vector3();
  private prevYaw = 0;
  private hasPrev = false;
  private readonly groundN = new Vector3(0, 1, 0);
  private groundNOk = false;

  // ── car size (smoothed) ──
  private szScale = 1;
  private szRoof = TUNING.refRoofHeight - TUNING.refCgHeight; // roof above the CG
  private szBelow = TUNING.refCgHeight; // ground below the CG
  private szMidZ = 0; // mid-axle z relative to the CG (car frame)
  private szRadius = 2.6; // bounding radius
  private anchorsOk = false;
  private seatSide = 1; // +1 = driver on the left (LHD)

  // ── track queries ──
  private readonly gs: GroundSample = { height: 0, normal: new Vector3(0, 1, 0), surface: 'asphalt' };
  private readonly tpCar: TrackPoint = makeTrackPoint();
  private readonly tpCam: TrackPoint = makeTrackPoint();
  private carHint = -1;
  private camHint = -1;
  private groundHint = -1;
  private carSOk = false;
  private readonly lift: Lag = lag();
  private readonly wallPush: Lag = lag();

  // ── shared look state (stick + rear view) ──
  private readonly fovSpd: Lag = lag();
  private readonly lkYaw: Lag = lag();
  private readonly lkPitch: Lag = lag();
  private lkPrevX = 0;
  private lkPrevY = 0;
  private backBlend = 0;
  private backSign = 1;

  // ── chase ──
  private readonly swYaw = spring();
  private readonly swPitch = spring();
  private readonly swPull = spring();
  private readonly swRoll = spring();
  private readonly swPfx = spring();
  private readonly lookAhead: Lag = lag();

  // ── hood / bumper / cockpit ──
  private rearActive = false;
  private readonly mrPrev = new Quaternion();
  private readonly mrRate = new Vector3();
  private readonly mrE = new Vector3();
  private readonly mrEv = new Vector3();
  private mrStage = 0;
  private readonly mpPrev = new Vector3();
  private readonly mpVel = new Vector3();
  private readonly mpY = new Vector3();
  private readonly mpYv = new Vector3();
  private mpStage = 0;
  private readonly hdX = spring();
  private readonly hdY = spring();
  private readonly hdZ = spring();
  private readonly swCorner = spring();

  // ── tv ──
  private tvIdx = -1;
  private tvDwell = 0;
  private tvChoiceOk = false;
  /** Seconds the current TV camera's view of the car has been blocked by terrain. */
  private tvBlocked = 0;
  private tvLosTimer = 0;
  private readonly losGs: GroundSample = { height: 0, normal: new Vector3(0, 1, 0), surface: 'asphalt' };
  private readonly tvYaw: Lag = lag(); // unwrapped
  private readonly tvPitch: Lag = lag();
  private readonly tvFov: Lag = lag();
  private tvFbActive = false;
  private readonly tvFbYaw: Lag = lag();

  // ── orbit ──
  private orbYaw = TUNING.orbitStartYaw;
  private orbElev = TUNING.orbitStartElev;
  private readonly orbRateYaw: Lag = lag();
  private readonly orbRateElev: Lag = lag();
  private orbIdle = 0;
  private orbDriftPrev = 0;
  private readonly orbBase: Lag = lag();
  private readonly orbDist: Lag = lag();

  // ── shake ──
  private envCurb = 0;
  private envSusp = 0;
  private envScr = 0;
  private suspPrev = -1;
  private suspStale = 0;
  private lastImpact = 0;
  private readonly ipx = spring();
  private readonly ipy = spring();
  private readonly ipz = spring();
  private readonly irx = spring();
  private readonly iry = spring();
  private readonly irz = spring();
  /** Shake in camera space: rotation (x pitch, y yaw, z roll; rad) and offset (x right, y up, z back; m). */
  private readonly shR = new Vector3();
  private readonly shP = new Vector3();

  // ── output of the mode functions ──
  private readonly outPos = new Vector3();
  private readonly outQuat = new Quaternion();
  private outFov = TUNING.fovDefaultDeg;
  private outNear = TUNING.near;
  private outShake = 1;

  constructor(track: TrackRuntime | null, tvCameras: TvCameras) {
    this.track = track;
    this.tvCams = Array.isArray(tvCameras) ? tvCameras : [];
    this.camera = new PerspectiveCamera(TUNING.fovDefaultDeg, 16 / 9, TUNING.near, TUNING.far);
    this.camera.name = 'camera-rig';
  }

  // ── public API ─────────────────────────────────────────────────────────────

  get mode(): CameraMode {
    return this._mode;
  }
  set mode(m: CameraMode) {
    this.setMode(m);
  }

  setMode(m: CameraMode): void {
    if (m === this._mode || CAMERA_MODES.indexOf(m) < 0) return;
    this._mode = m;
    this.entered = true; // hard cut + per-mode reset on the next update
  }

  next(): CameraMode {
    const i = CAMERA_MODES.indexOf(this._mode);
    this.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length]);
    return this._mode;
  }

  snap(): void {
    this.snapPending = true;
  }

  setFov(deg: number): void {
    if (Number.isFinite(deg)) this.fovBase = clamp(deg, 20, 120);
  }

  setShake(amount: number): void {
    if (Number.isFinite(amount)) this.shake = clamp(amount, 0, 1);
  }

  setAspect(aspect: number): void {
    if (!(Number.isFinite(aspect) && aspect > 0)) return;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number, target: CameraTarget, look: { x: number; y: number; back: boolean }): void {
    const T = TUNING;
    const h = clamp(Number.isFinite(dt) ? dt : 1 / 60, T.dtMin, T.dtMax);
    const st = target.state;
    const lx = look ? clamp(fin(look.x), -1, 1) : 0;
    const ly = look ? clamp(fin(look.y), -1, 1) : 0;
    const back = look ? look.back === true : false;

    if (!this.readCar(st)) {
      // Non-finite vehicle state: keep the last good pose, hard-cut once the state is valid again.
      this.snapPending = true;
      return;
    }
    let cut = this.first || this.snapPending || this.entered;
    if (!cut && this.hasPrev && st.position.distanceTo(this.prevPos) > T.teleportDistance + this.speed * h * 3) cut = true;
    if (cut) {
      this.carHint = -1;
      this.camHint = -1;
      this.groundHint = -1;
    }
    // Yaw rate from our own yaw (robust in replays, where angularVelocity is not restored).
    this.yawRate = !cut && this.hasPrev ? wrapPi(this.carYaw - this.prevYaw) / h : 0;
    this.prevPos.copy(st.position);
    this.prevYaw = this.carYaw;
    this.hasPrev = true;

    this.estimateSize(st, target.anchors, h, cut);
    this.projectCar(st);
    this.updateShake(h, cut, st);
    const kFov = smoothstep(T.speedFovStart, T.speedFovFull, this.speed);
    if (cut) lagReset(this.fovSpd, kFov);
    else lagStep(this.fovSpd, kFov, T.speedFovTau, h);

    switch (this._mode) {
      case 'chase':
        this.chase(h, cut, st, false, lx, ly, back);
        break;
      case 'chase-far':
        this.chase(h, cut, st, true, lx, ly, back);
        break;
      case 'hood':
      case 'bumper':
      case 'cockpit':
        this.interior(h, cut, st, target.anchors, lx, ly, back);
        break;
      case 'tv':
        this.tvMode(h, cut, st);
        break;
      case 'orbit':
        this.orbit(h, cut, st, lx, ly);
        break;
    }

    const ok = this.finish();
    this.first = false;
    this.entered = false;
    this.snapPending = !ok;
  }

  // ── per-frame car analysis ─────────────────────────────────────────────────

  private readCar(st: VehicleState): boolean {
    const p = st.position;
    const v = st.velocity;
    if (!finiteVec(p) || !finiteVec(v) || !finiteQuat(st.quaternion)) return false;
    const q = this.qCar.copy(st.quaternion);
    if (q.lengthSq() < 1e-12) q.identity();
    q.normalize();
    this.qInv.copy(q).invert();
    const F = this.cF.set(0, 0, 1).applyQuaternion(q);
    const U = this.cU.set(0, 1, 0).applyQuaternion(q);
    const fh = Math.sqrt(F.x * F.x + F.z * F.z);
    if (fh > 0.2) this.carYaw = Math.atan2(F.x, F.z);
    else if (!this.hasPrev) {
      // nose (almost) straight up or down: the roof points along the old heading
      const sg = F.y >= 0 ? 1 : -1;
      this.carYaw = Math.atan2(F.x - sg * U.x, F.z - sg * U.z);
    } // else: keep the previous yaw
    this.speed = v.length();
    this.hSpeed = Math.sqrt(v.x * v.x + v.z * v.z);
    if (this.hSpeed > 0.3) {
      this.velYaw = Math.atan2(v.x, v.z);
      this.slip = wrapPi(this.velYaw - this.carYaw);
    } else {
      this.velYaw = this.carYaw;
      this.slip = 0;
    }
    // Plane of the contact patches: the road slope without the body's pitch/roll.
    this.groundNOk = false;
    const w = st.wheels;
    let nc = 0;
    let near = true;
    for (let i = 0; i < 4; i++) {
      if (w[i].contact) nc++;
      if (!(w[i].contactPoint.distanceToSquared(p) < 25)) near = false;
    }
    if (nc >= 3 && near) {
      _v1.subVectors(w[1].contactPoint, w[2].contactPoint); // FR - RL
      _v2.subVectors(w[0].contactPoint, w[3].contactPoint); // FL - RR
      const n = this.groundN.crossVectors(_v1, _v2);
      const l = n.length();
      if (l > 1e-6) {
        n.multiplyScalar(1 / l);
        if (n.dot(U) < 0) n.negate();
        this.groundNOk = n.y > 0.2;
      }
    }
    return true;
  }

  private estimateSize(st: VehicleState, anchors: Anchors, h: number, cut: boolean): void {
    const T = TUNING;
    const P = st.position;
    const qi = this.qInv;
    let zf = 0;
    let zr = 0;
    let xl = 0;
    let xr = 0;
    let gy = 0;
    let ok = true;
    for (let i = 0; i < 4; i++) {
      const w = st.wheels[i];
      _v1.copy(w.hub).sub(P).applyQuaternion(qi);
      _v2.copy(w.contactPoint).sub(P).applyQuaternion(qi);
      if (!(_v1.lengthSq() < 16) || !(_v2.lengthSq() < 16)) {
        ok = false;
        break;
      }
      if (i < 2) zf += _v1.z * 0.5;
      else zr += _v1.z * 0.5;
      if ((i & 1) === 0) xl += _v1.x * 0.5;
      else xr += _v1.x * 0.5;
      gy += _v2.y * 0.25;
    }
    const wb = zf - zr;
    const trk = xl - xr;
    ok = ok && wb > 1.4 && wb < 4.5 && trk > 0.8 && trk < 2.8 && gy < -0.05 && gy > -1.5;
    const wheelbase = ok ? wb : T.refWheelbase;
    const below = ok ? -gy : T.refCgHeight;
    const midZ = ok ? (zf + zr) * 0.5 : 0;
    const width = ok ? trk + 0.3 : 1.95;
    // Roof height from the chase anchor (on the roof). Rejected when the anchors are not posed yet.
    let roof = T.refRoofHeight - T.refCgHeight;
    anchors.chase.getWorldPosition(_v1);
    anchors.chase.getWorldQuaternion(_q1);
    _v1.sub(P).applyQuaternion(qi);
    const posed = _v1.lengthSq() < 36 && Math.abs(_q1.dot(this.qCar)) > 0.995;
    if (posed && _v1.y + below > 0.5 && _v1.y + below < 2.8) roof = _v1.y;
    this.anchorsOk = posed;
    // Seat side from the cockpit anchor (x > 0 = left-hand drive).
    if (posed) {
      anchors.cockpit.getWorldPosition(_v1);
      _v1.sub(P).applyQuaternion(qi);
      this.seatSide = _v1.x < -0.05 ? -1 : 1;
    } else this.seatSide = anchors.cockpit.position.x < -0.05 ? -1 : 1;
    const height = roof + below;
    const scale = clamp((0.6 * wheelbase) / T.refWheelbase + (0.4 * height) / T.refRoofHeight, 0.7, 1.6);
    const len = wheelbase * 1.7;
    const radius = 0.5 * Math.sqrt(len * len + width * width + height * height);
    const k = cut ? 1 : expK(h, 0.4);
    this.szScale += (scale - this.szScale) * k;
    this.szRoof += (roof - this.szRoof) * k;
    this.szBelow += (below - this.szBelow) * k;
    this.szMidZ += (midZ - this.szMidZ) * k;
    this.szRadius += (radius - this.szRadius) * k;
  }

  private projectCar(st: VehicleState): void {
    const tr = this.track;
    this.carSOk = false;
    if (!tr) return;
    const hint = tr.project(st.position.x, st.position.z, this.tpCar, this.carHint);
    this.carHint = Number.isFinite(hint) ? hint : -1;
    const tp = this.tpCar;
    this.carSOk = Number.isFinite(tp.s) && Number.isFinite(tp.d) && Number.isFinite(tp.wallLeft) && Number.isFinite(tp.wallRight);
  }

  /** Slope (rad, + = uphill) of the ground under the car along the horizontal direction (hx, 0, hz). */
  private slopeAlong(hx: number, hz: number): number {
    const T = TUNING;
    const n = this.groundNOk ? this.groundN : this.cU;
    const w = this.groundNOk ? 1 : smoothstep(0.15, 0.5, n.y);
    if (w <= 0) return 0;
    return clamp(Math.atan2(-(n.x * hx + n.z * hz), Math.max(n.y, 1e-3)), -T.maxSlope, T.maxSlope) * w;
  }

  // ── shake ──────────────────────────────────────────────────────────────────

  private updateShake(h: number, cut: boolean, st: VehicleState): void {
    const T = TUNING;
    if (!this.first) this.time += h; // noise clock = time since the first update
    const t = this.time;
    let curb = 0;
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const w = st.wheels[i];
      if (w.contact && w.surface === 'curb') curb += 0.5;
      const sv = w.suspensionVelocity;
      if (Number.isFinite(sv)) sum += sv < 0 ? -sv : sv;
    }
    const curbT = Math.min(1, curb) * clamp(this.speed / 25, 0.25, 1);
    // Replays do not restore suspensionVelocity: a bit-identical non-zero sum is stale data.
    if (sum > 0 && sum === this.suspPrev) this.suspStale += h;
    else this.suspStale = 0;
    this.suspPrev = sum;
    const suspT = this.suspStale > 0.3 ? 0 : clamp((sum - T.suspShakeDead) * T.suspShakeGain, 0, 1);
    const scrT = clamp(fin(st.scrape), 0, 1);
    if (cut) {
      this.envCurb = curbT;
      this.envSusp = suspT;
      this.envScr = scrT;
      springReset(this.ipx, 0);
      springReset(this.ipy, 0);
      springReset(this.ipz, 0);
      springReset(this.irx, 0);
      springReset(this.iry, 0);
      springReset(this.irz, 0);
      this.lastImpact = st.impactCount;
    } else {
      this.envCurb = envStep(this.envCurb, curbT, 0.04, 0.12, h);
      this.envSusp = envStep(this.envSusp, suspT, 0.02, 0.15, h);
      this.envScr = envStep(this.envScr, scrT, 0.03, 0.2, h);
      if (st.impactCount !== this.lastImpact) {
        this.lastImpact = st.impactCount;
        this.kick(st);
      }
      const w = T.impactOmega;
      const z = T.impactZeta;
      oscStep(this.ipx, 0, w, z, h);
      oscStep(this.ipy, 0, w, z, h);
      oscStep(this.ipz, 0, w, z, h);
      oscStep(this.irx, 0, w, z, h);
      oscStep(this.iry, 0, w, z, h);
      oscStep(this.irz, 0, w, z, h);
    }
    let rp = this.irx.x;
    let ry = this.iry.x;
    let rr = this.irz.x;
    let px = this.ipx.x;
    let py = this.ipy.x;
    const pz = this.ipz.x;
    const ks = smoothstep(T.speedShakeStart, T.speedShakeFull, this.speed);
    if (ks > 0) {
      const a = ks * T.speedShakeRot;
      const b = ks * T.speedShakePos;
      rp += a * wob(t, 1.3, 0.3);
      ry += 0.6 * a * wob(t, 0.9, 1.9);
      rr += 1.2 * a * wob(t, 1.1, 3.7);
      px += 0.6 * b * wob(t, 1.7, 5.1);
      py += b * wob(t, 2.1, 6.6);
    }
    if (this.envCurb > 1e-4) {
      const a = this.envCurb * T.curbShakeRot;
      const b = this.envCurb * T.curbShakePos;
      rp += 0.4 * a * wob(t, 17.3, 8.2);
      rr += a * wob(t, 19.7, 9.4);
      px += 0.3 * b * wob(t, 14.9, 10.8);
      py += b * wob(t, 23.1, 12.5);
    }
    if (this.envSusp > 1e-4) {
      const a = this.envSusp * T.suspShakeRot;
      const b = this.envSusp * T.suspShakePos;
      rp += a * wob(t, 7.7, 13.3);
      rr += 0.5 * a * wob(t, 6.3, 14.1);
      py += b * wob(t, 9.1, 15.9);
    }
    if (this.envScr > 1e-4) {
      const a = this.envScr * T.scrapeShakeRot;
      const b = this.envScr * T.scrapeShakePos;
      rp += 0.5 * a * wob(t, 21.7, 17.2);
      ry += 0.3 * a * wob(t, 2.3, 20.6);
      rr += a * (wob(t, 26.3, 18.4) + 0.6 * wob(t, 3.1, 19.9));
      px += 0.6 * b * wob(t, 18.1, 21.3);
      py += b * wob(t, 29.9, 22.7);
    }
    this.shR.set(rp, ry, rr);
    this.shP.set(px, py, pz);
  }

  /** Impact: kick the oscillators. The camera lags the shove (offset against the contact normal). */
  private kick(st: VehicleState): void {
    const T = TUNING;
    const amp = Math.min(1.5, Math.max(0, fin(st.lastImpact.strength)) / T.impactRef);
    if (!(amp > 0)) return;
    const n = st.lastImpact.normal;
    _v1.set(fin(n.x), fin(n.y), fin(n.z));
    const l = _v1.length();
    if (l > 1e-6) _v1.multiplyScalar(1 / l);
    else _v1.set(0, 1, 0);
    _q1.copy(this.camera.quaternion).invert();
    _v1.applyQuaternion(_q1); // camera space: x right, y up, z back
    const vp = amp * T.impactPos;
    const vr = amp * T.impactRot;
    this.ipx.v -= _v1.x * vp;
    this.ipy.v -= _v1.y * vp;
    this.ipz.v -= _v1.z * vp;
    this.irx.v -= (_v1.y + 0.6 * _v1.z + 0.25) * vr; // nod
    this.iry.v += 0.3 * _v1.x * vr;
    this.irz.v += _v1.x * vr; // the top of the "camera pole" lags the shove
  }

  // ── track constraints ──────────────────────────────────────────────────────

  /** Keep `C` inside the barriers (when the car is near them) and above the ground. */
  private constrain(C: Vector3, h: number, cut: boolean): void {
    const tr = this.track;
    if (!tr) return;
    const T = TUNING;
    let pushT = 0;
    let dirX = 0;
    let dirZ = 0;
    if (this.carSOk) {
      const hint = tr.project(C.x, C.z, this.tpCam, this.camHint);
      this.camHint = Number.isFinite(hint) ? hint : -1;
      const tc = this.tpCam;
      const tcar = this.tpCar;
      if (Number.isFinite(tc.d) && Number.isFinite(tc.wallLeft) && Number.isFinite(tc.wallRight) && Number.isFinite(tc.lx) && Number.isFinite(tc.lz)) {
        // How much the car is "at" each wall: fades in over the last 1.5 m of wallCarNear and out again
        // once the car itself is beyond the barrier (pit lane, run-off), so the push is continuous.
        const nearL =
          smoothstep(tcar.wallLeft - T.wallCarNear, tcar.wallLeft - T.wallCarNear + 1.5, tcar.d) *
          (1 - smoothstep(tcar.wallLeft + T.wallMargin, tcar.wallLeft + T.wallMargin + 1, tcar.d));
        const nearR =
          smoothstep(tcar.wallRight - T.wallCarNear, tcar.wallRight - T.wallCarNear + 1.5, -tcar.d) *
          (1 - smoothstep(tcar.wallRight + T.wallMargin, tcar.wallRight + T.wallMargin + 1, -tcar.d));
        const exL = tc.d - (tc.wallLeft + T.wallMargin);
        const exR = -tc.d - (tc.wallRight + T.wallMargin);
        if (exL > 0) pushT -= exL * nearL;
        if (exR > 0) pushT += exR * nearR;
        dirX = tc.lx;
        dirZ = tc.lz;
      }
    }
    // Corrections attack fast and release slowly (first-order-hold lags, like every other filter).
    const wp = this.wallPush;
    if (cut) lagReset(wp, pushT);
    else {
      const growing = pushT * wp.x >= 0 && Math.abs(pushT) > Math.abs(wp.x);
      lagStep(wp, pushT, growing ? T.clampAttackTau : T.clampReleaseTau, h);
    }
    if (wp.x !== 0) {
      C.x += dirX * wp.x;
      C.z += dirZ * wp.x;
    }
    const hint = tr.groundAt(C.x, C.z, this.gs, this.groundHint);
    this.groundHint = Number.isFinite(hint) ? hint : -1;
    const gh = this.gs.height;
    if (Number.isFinite(gh)) {
      const liftT = Math.max(0, gh + T.groundClearance - C.y);
      if (cut) lagReset(this.lift, liftT);
      else lagStep(this.lift, liftT, liftT > this.lift.x ? T.clampAttackTau : T.clampReleaseTau, h);
      C.y += Math.max(0, this.lift.x);
    }
  }

  // ── stick ──────────────────────────────────────────────────────────────────

  /** lkYaw: + = view turns left; lkPitch: + = view tilts up. backBlend 0..1 (linear, eased by users). */
  private stepLook(h: number, cut: boolean, lx: number, ly: number, back: boolean, yawMax: number, pitchUp: number, pitchDown: number): void {
    const T = TUNING;
    const yT = -lx * yawMax;
    const pT = ly >= 0 ? ly * pitchUp : ly * pitchDown;
    if (cut) {
      lagReset(this.lkYaw, yT);
      lagReset(this.lkPitch, pT);
      this.lkPrevX = lx;
      this.lkPrevY = ly;
      this.backBlend = back ? 1 : 0;
      this.backSign = yT >= 0 ? 1 : -1;
      return;
    }
    if (back && this.backBlend <= 0) this.backSign = this.lkYaw.x >= 0 ? 1 : -1; // latch the swing side
    // The time constant blends continuously from "returning" (stick centred) to "following"
    // (deflected). That blend is nonlinear in the stick, so the stick is interpolated across the frame
    // and the filter integrated in ~4 ms substeps: the same motion at any frame rate.
    const dRet = T.lookReturnTau - T.lookTau;
    const n = Math.min(16, Math.ceil(h / 0.004));
    const hs = h / n;
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      const fm = (i - 0.5) / n;
      const sx = this.lkPrevX + (lx - this.lkPrevX) * f;
      const sy = this.lkPrevY + (ly - this.lkPrevY) * f;
      const mx = Math.abs(this.lkPrevX + (lx - this.lkPrevX) * fm);
      const my = Math.abs(this.lkPrevY + (ly - this.lkPrevY) * fm);
      lagStep(this.lkYaw, -sx * yawMax, T.lookReturnTau - dRet * smoothstep(0.02, 0.2, mx), hs);
      lagStep(this.lkPitch, sy >= 0 ? sy * pitchUp : sy * pitchDown, T.lookReturnTau - dRet * smoothstep(0.02, 0.2, my), hs);
    }
    this.lkPrevX = lx;
    this.lkPrevY = ly;
    this.backBlend = clamp(this.backBlend + (back ? h : -h) / T.backTime, 0, 1);
  }

  // ── chase / chase-far ──────────────────────────────────────────────────────

  private chase(h: number, cut: boolean, st: VehicleState, far: boolean, lx: number, ly: number, back: boolean): void {
    const T = TUNING;
    const P = st.position;

    // 1. Heading: car yaw, blended toward the velocity heading as the slip angle grows.
    const aSlip = Math.abs(this.slip);
    const w =
      T.slipBlendMax *
      smoothstep(T.slipBlendStart, T.slipBlendFull, aSlip) *
      (1 - smoothstep(T.slipBackStart, T.slipBackEnd, aSlip)) *
      smoothstep(T.slipSpeedMin, T.slipSpeedFull, this.hSpeed);
    const yawT = this.carYaw + w * this.slip;
    if (cut) springReset(this.swYaw, yawT);
    else springStep(this.swYaw, this.swYaw.g + wrapPi(yawT - this.swYaw.g), T.swingOmega, T.swingLead, h);
    const psi = this.swYaw.x;
    const hx = Math.sin(psi);
    const hz = Math.cos(psi);

    // 2. Pitch of the frame: the ground slope along the heading (not the body's dive/squat).
    const thT = this.slopeAlong(hx, hz);
    if (cut) springReset(this.swPitch, thT);
    else springStep(this.swPitch, thT, T.pitchOmega, 1, h);
    const th = this.swPitch.x;
    const ct = Math.cos(th);
    const sth = Math.sin(th);
    _F.set(hx * ct, sth, hz * ct);
    _U.set(-hx * sth, ct, -hz * sth);
    _L.set(hz, 0, -hx);

    // 3. Stick + rear view.
    this.stepLook(h, cut, lx, ly, back, T.chaseLookYaw, T.chaseLookPitchUp, T.chaseLookPitchDown);
    const eb = ease(this.backBlend);
    const yawOff = this.lkYaw.x + (this.backSign * Math.PI - this.lkYaw.x) * eb;
    const viewPitch = this.lkPitch.x * (1 - eb);

    // 4. Distance and height (car size, longitudinal G).
    const sizeF = 1 + T.sizeInfluence * (this.szScale - 1);
    const dist0 = (far ? T.chaseFarDistance : T.chaseDistance) * sizeF;
    const refRoof = T.refRoofHeight - T.refCgHeight;
    const hgt = this.szRoof + ((far ? T.chaseFarHeight : T.chaseHeight) - refRoof) * sizeF;
    const az = fin(st.localAccel.z);
    const ax = fin(st.localAccel.x);
    const pullT = clamp(az * T.accelPull, -T.brakePushMax, T.accelPullMax);
    if (cut) springReset(this.swPull, pullT);
    else springStep(this.swPull, pullT, T.accelOmega, 0, h);
    const dist = Math.max(1, dist0 + this.swPull.x * (far ? 1.25 : 1));
    const r0 = Math.sqrt(dist * dist + hgt * hgt);
    const e0 = Math.atan2(hgt, dist);
    const e = clamp(e0 - viewPitch, -5 * DEG, 75 * DEG);

    // 5. Position: rigid on the car, swung by the smoothed frame + look offsets.
    const ca = Math.cos(yawOff);
    const sa = Math.sin(yawOff);
    _D.copy(_F).multiplyScalar(ca).addScaledVector(_L, sa); // view direction (horizontal-ish)
    const C = this.outPos;
    C.copy(P)
      .addScaledVector(_D, -r0 * Math.cos(e))
      .addScaledVector(_U, r0 * Math.sin(e));

    // 6. Look target: ahead along the view direction, a bit above the roof.
    const laT = T.lookAheadMin + (T.lookAheadMax - T.lookAheadMin) * smoothstep(0, T.lookAheadSpeed, this.speed);
    if (cut) lagReset(this.lookAhead, laT);
    else lagStep(this.lookAhead, laT, T.lookAheadTau, h);
    const elevF = clamp(1 - Math.max(0, e - e0) / (40 * DEG), 0.2, 1);
    _tgt.copy(P)
      .addScaledVector(_D, this.lookAhead.x * elevF)
      .addScaledVector(_U, this.szRoof + T.lookAboveRoof);

    // 7. Ground / barriers.
    this.constrain(C, h, cut);

    // 8. Orientation: look at the target with a level horizon.
    const fx = _tgt.x - C.x;
    const fy = _tgt.y - C.y;
    const fz = _tgt.z - C.z;
    if (!lookQuat(fx, fy, fz, WORLD_UP, this.outQuat) && !lookQuat(fx, fy, fz, _U, this.outQuat)) this.outQuat.copy(this.camera.quaternion);

    // 9. G-force bank (lateral) and pitch (longitudinal), faded when looking sideways.
    const rollT = clamp(ax * T.latRoll, -T.latRollMax, T.latRollMax);
    const pfxT = clamp(az * T.accelPitch, -T.accelPitchMax, T.accelPitchMax);
    if (cut) {
      springReset(this.swRoll, rollT);
      springReset(this.swPfx, pfxT);
    } else {
      springStep(this.swRoll, rollT, T.dynOmega, 0, h);
      springStep(this.swPfx, pfxT, T.dynOmega, 0, h);
    }
    const fxs = Math.cos(yawOff);
    _euler.set(this.swPfx.x * fxs, 0, this.swRoll.x * fxs, 'XYZ');
    _q1.setFromEuler(_euler);
    this.outQuat.multiply(_q1);

    this.outFov = this.fovBase + (far ? T.chaseFarFovDeg : 0) + T.speedFovMaxDeg * this.fovSpd.x;
    this.outNear = T.near;
    this.outShake = T.shakeByMode[this._mode];
  }

  // ── hood / bumper / cockpit ────────────────────────────────────────────────

  /** World pose of an anchor; falls back to its local position placed on the car when not posed. */
  private anchorPose(anchor: Object3D, st: VehicleState, outP: Vector3, outQ: Quaternion): void {
    anchor.getWorldPosition(outP);
    anchor.getWorldQuaternion(outQ);
    if (finiteVec(outP) && finiteQuat(outQ) && outP.distanceToSquared(st.position) < 36 && Math.abs(outQ.dot(this.qCar)) > 0.995) return;
    // Not posed yet (e.g. at rest at the origin before the first CarVisual.update): body origin is on
    // the ground between the axles; place the anchor's local offset from there.
    const ap = anchor.position;
    outP.set(fin(ap.x), fin(ap.y) - this.szBelow, fin(ap.z) + this.szMidZ).applyQuaternion(this.qCar).add(st.position);
    outQ.copy(this.qCar);
  }

  /**
   * Mount filter, orientation. The camera's rotational offset from the body (`mrE`, body frame) is a
   * critically damped spring kicked by CHANGES of the body's angular velocity: steady rotation passes
   * with zero lag, jitter is absorbed.
   */
  private mountRot(qb: Quaternion, h: number, cut: boolean, out: Quaternion): void {
    const T = TUNING;
    if (!cut) {
      _q1.copy(this.mrPrev).invert().multiply(qb); // body rotation over this frame, body frame
      if (_q1.w < 0) _q1.set(-_q1.x, -_q1.y, -_q1.z, -_q1.w);
      const s = Math.sqrt(_q1.x * _q1.x + _q1.y * _q1.y + _q1.z * _q1.z);
      const ang = 2 * Math.atan2(s, _q1.w);
      if (!(ang < 0.6)) cut = true; // teleport / tumble / NaN: re-anchor
      else {
        const f = (s > 1e-12 ? ang / s : 2) / h;
        _v1.set(_q1.x * f, _q1.y * f, _q1.z * f); // angular velocity over the frame
        if (this.mrStage === 0) {
          this.mrRate.copy(_v1);
          this.mrStage = 1;
        } else {
          _v2.subVectors(_v1, this.mrRate);
          if (_v2.lengthSq() > 625) cut = true; // > 25 rad/s step: discontinuity, not motion
          else {
            this.mrEv.sub(_v2);
            this.mrRate.copy(_v1);
          }
        }
      }
    }
    if (cut) {
      this.mrE.set(0, 0, 0);
      this.mrEv.set(0, 0, 0);
      this.mrStage = 0;
    } else {
      damp3(this.mrE, this.mrEv, T.mountOmegaRot, h);
      const l = this.mrE.length();
      if (l > 0.12) this.mrE.multiplyScalar(0.12 / l);
    }
    this.mrPrev.copy(qb);
    const l = this.mrE.length();
    if (l > 1e-9) {
      _v3.copy(this.mrE).multiplyScalar(1 / l);
      _q2.setFromAxisAngle(_v3, l);
      out.copy(qb).multiply(_q2);
    } else out.copy(qb);
  }

  /** Mount filter, position (world frame), same principle as mountRot. */
  private mountPos(p: Vector3, h: number, cut: boolean, out: Vector3): void {
    const T = TUNING;
    if (!cut) {
      _v1.subVectors(p, this.mpPrev);
      if (!(_v1.lengthSq() < 100)) cut = true;
      else {
        _v1.multiplyScalar(1 / h);
        if (this.mpStage === 0) {
          this.mpVel.copy(_v1);
          this.mpStage = 1;
        } else {
          _v2.subVectors(_v1, this.mpVel);
          const lim = 60 * h + 8;
          if (_v2.lengthSq() > lim * lim) cut = true; // > ~6 g in one frame: a hitch, not motion
          else {
            this.mpYv.sub(_v2);
            this.mpVel.copy(_v1);
          }
        }
      }
    }
    if (cut) {
      this.mpY.set(0, 0, 0);
      this.mpYv.set(0, 0, 0);
      this.mpStage = 0;
    } else {
      damp3(this.mpY, this.mpYv, T.mountOmegaPos, h);
      const l = this.mpY.length();
      if (l > 0.08) this.mpY.multiplyScalar(0.08 / l);
    }
    this.mpPrev.copy(p);
    out.copy(p).add(this.mpY);
  }

  private interior(h: number, cut: boolean, st: VehicleState, anchors: Anchors, lx: number, ly: number, back: boolean): void {
    const T = TUNING;
    const mode = this._mode;
    const cockpit = mode === 'cockpit';
    // hood / bumper: look.back cuts to a rear-facing camera on the roof, the tail in the bottom of the picture (the bumper
    // anchor mirrored to the tail sat under the rear deck, behind the diffuser: most of the frame was the car's own body)
    const rear = !cockpit && back;
    let mcut = cut;
    if (rear !== this.rearActive) {
      this.rearActive = rear;
      mcut = true;
    }
    const anchor = mode === 'hood' ? anchors.hood : mode === 'bumper' ? anchors.bumper : anchors.cockpit;
    this.anchorPose(rear ? anchors.chase : anchor, st, _aPos, _aQuat);
    if (rear) {
      _v1.copy(_aPos).sub(st.position).applyQuaternion(this.qInv);
      _v1.y += 0.14;
      _aPos.copy(_v1).applyQuaternion(this.qCar).add(st.position);
      _q1.setFromAxisAngle(AX_Y, Math.PI);
      _aQuat.multiply(_q1);
    }
    this.mountRot(_aQuat, h, mcut, _mQuat);
    this.mountPos(_aPos, h, mcut, _mPos);

    // Stick (+ cockpit look-back head turn).
    this.stepLook(h, cut, lx, ly, cockpit && back, T.cockpitLookYaw, T.cockpitLookPitch, T.cockpitLookPitch);
    const eb = ease(this.backBlend);
    let yaw = this.lkYaw.x;
    const pitch = this.lkPitch.x * (1 - eb);
    if (cockpit) {
      // Look into corners: steering intent, yaw rate and slip (toward where the car is going).
      const aSlip = Math.abs(this.slip);
      const slipW = smoothstep(T.slipSpeedMin, T.slipSpeedFull, this.hSpeed) * (1 - smoothstep(T.slipBackStart, T.slipBackEnd, aSlip));
      const cT = clamp(
        -fin(st.steer) * T.cornerLookSteer + this.yawRate * T.cornerLookYawRate + this.slip * slipW * T.cornerLookSlip,
        -T.cornerLookMax,
        T.cornerLookMax,
      );
      if (cut) springReset(this.swCorner, cT);
      else springStep(this.swCorner, cT, T.cornerLookOmega, 0, h);
      yaw += this.swCorner.x * (1 - Math.min(1, Math.abs(this.lkYaw.x) / (20 * DEG)));
      // over the inside shoulder: right shoulder for a left-hand-drive seat
      const backYaw = -this.seatSide * T.cockpitBackYaw;
      yaw += (backYaw - yaw) * eb;
    }

    // Orientation: filtered body → face +Z → yaw → pitch.
    _q1.setFromAxisAngle(AX_Y, Math.PI + yaw);
    _q2.setFromAxisAngle(AX_X, pitch);
    this.outQuat.copy(_mQuat).multiply(_q1).multiply(_q2);
    if (cockpit) {
      // Partial horizon stabilisation against roll (relative to gravity), faded out past 45°.
      _v1.set(1, 0, 0).applyQuaternion(this.outQuat);
      _v2.set(0, 1, 0).applyQuaternion(this.outQuat);
      const roll = Math.atan2(_v1.y, _v2.y);
      const fade = 1 - smoothstep(45 * DEG, 90 * DEG, Math.abs(roll));
      const comp = clamp(-T.rollCompensation * roll * fade, -12 * DEG, 12 * DEG);
      _q1.setFromAxisAngle(AX_Z, comp);
      this.outQuat.multiply(_q1);
    }

    // Position: filtered anchor + cockpit head motion (against the G-force) + look-back head shift.
    this.outPos.copy(_mPos);
    if (cockpit) {
      const g = T.headGain;
      const tx = clamp(-fin(st.localAccel.x) * g, -T.headMaxLat, T.headMaxLat);
      const ty = clamp(-fin(st.localAccel.y) * g * 0.6, -T.headMaxVert, T.headMaxVert);
      const tz = clamp(-fin(st.localAccel.z) * g, -T.headMaxLong, T.headMaxLong);
      if (cut) {
        springReset(this.hdX, tx);
        springReset(this.hdY, ty);
        springReset(this.hdZ, tz);
      } else {
        oscStep(this.hdX, tx, T.headOmega, T.headZeta, h);
        oscStep(this.hdY, ty, T.headOmega, T.headZeta, h);
        oscStep(this.hdZ, tz, T.headOmega, T.headZeta, h);
      }
      _v1.set(this.hdX.x - this.seatSide * T.cockpitBackShift * eb, this.hdY.x + 0.04 * eb, this.hdZ.x - 0.06 * eb).applyQuaternion(_mQuat);
      this.outPos.add(_v1);
    }
    this.outFov = this.fovBase + T.interiorFovDeg + T.interiorSpeedFovDeg * this.fovSpd.x;
    this.outNear = cockpit ? T.nearCockpit : T.near;
    this.outShake = T.shakeByMode[mode];
  }

  // ── tv ─────────────────────────────────────────────────────────────────────

  /**
   * Best camera for car position s: nearest by track distance, preferring cameras ahead. When no camera
   * qualifies (enter thresholds), returns the nearest in 3D and sets tvChoiceOk = false.
   */
  /** True when the terrain doesn't block the line from camera C to the car at P. */
  private tvLineOfSight(C: Vector3, P: Vector3): boolean {
    const tr = this.track;
    if (!tr) return true;
    const tx = P.x;
    const ty = P.y + 0.6;
    const tz = P.z;
    const len = Math.hypot(tx - C.x, ty - C.y, tz - C.z);
    const n = Math.min(24, Math.max(6, Math.ceil(len / 12)));
    let hint = -1;
    // skip the ends: the camera sits on its mast, the car on the road
    for (let k = 1; k < n; k++) {
      const f = 0.04 + (0.9 * k) / n;
      const x = C.x + (tx - C.x) * f;
      const y = C.y + (ty - C.y) * f;
      const z = C.z + (tz - C.z) * f;
      hint = tr.groundAt(x, z, this.losGs, hint);
      if (this.losGs.height > y - 0.25) return false;
    }
    return true;
  }

  private tvChoose(carS: number, P: Vector3, L: number): number {
    const T = TUNING;
    const cams = this.tvCams;
    let best = -1;
    let bestCost = Infinity;
    let near = -1;
    let nearD = Infinity;
    for (let i = 0; i < cams.length; i++) {
      const c = cams[i];
      const ds = wrapSigned(c.s - carS, L);
      const d3 = c.position.distanceTo(P);
      // a camera that can't see the car (a hill in the way), or that covers another stretch of road
      // (closer in 3D across a switchback), is never a choice
      if (ds > T.tvTrackAhead || ds < -T.tvMaxBehind || !this.tvLineOfSight(c.position, P)) continue;
      if (d3 < nearD) {
        nearD = d3;
        near = i;
      }
      if (!(ds >= -T.tvEnterBehind) || !(d3 <= T.tvEnterDistance)) continue;
      const cost = ds >= 0 ? ds : T.tvBehindBias - ds * T.tvBehindPenalty;
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    }
    this.tvChoiceOk = best >= 0;
    return best >= 0 ? best : near;
  }

  /** Current camera lost sight of the car for a moment: cut to another one (or the fallback). */
  private tvCheckBlocked(h: number, P: Vector3): boolean {
    this.tvLosTimer -= h;
    if (this.tvLosTimer > 0) return this.tvBlocked > 0.5;
    this.tvLosTimer = 0.2;
    const ok = this.tvLineOfSight(this.tvCams[this.tvIdx].position, P);
    this.tvBlocked = ok ? 0 : this.tvBlocked + 0.2;
    return this.tvBlocked > 0.5;
  }

  private tvMode(h: number, cut: boolean, st: VehicleState): void {
    const T = TUNING;
    const cams = this.tvCams;
    const n = cams.length;
    const tr = this.track;
    if (!tr || n === 0 || !this.carSOk || !(tr.length > 0)) {
      this.tvFallback(h, cut, st);
      return;
    }
    const P = st.position;
    const L = tr.length;
    const carS = this.tpCar.s;
    this.tvDwell += h;
    let camCut = cut || this.tvIdx < 0 || this.tvIdx >= n;
    const wasFallback = this.tvFbActive;
    if (camCut || wasFallback) {
      const best = this.tvChoose(carS, P, L);
      if (best < 0 || (wasFallback && !camCut && !this.tvChoiceOk)) {
        // no TV camera can see the car: the trackside follow shot until one can
        this.tvFallback(h, camCut && !wasFallback, st);
        return;
      }
      this.tvIdx = best;
      camCut = true;
      this.tvBlocked = 0;
    } else {
      const c = cams[this.tvIdx];
      const ds = wrapSigned(c.s - carS, L);
      const d3 = c.position.distanceTo(P);
      const blocked = this.tvCheckBlocked(h, P);
      const passed = ds < -T.tvMaxBehind;
      if (blocked || passed || ds > T.tvTrackAhead || (this.tvDwell >= T.tvMinDwell && (ds < -T.tvLeaveBehind || d3 > T.tvLeaveDistance))) {
        const best = this.tvChoose(carS, P, L);
        if (best < 0) {
          this.tvFallback(h, true, st);
          return;
        }
        // nothing qualifies: stay unless the fallback is clearly closer (no A-B-A ping-pong)
        if (best !== this.tvIdx && (blocked || passed || this.tvChoiceOk || cams[best].position.distanceTo(P) < T.tvSwitchCloser * d3)) {
          this.tvIdx = best;
          camCut = true;
          this.tvBlocked = 0;
        }
      }
    }
    this.tvFbActive = false;
    if (camCut) this.tvDwell = 0;
    const cp = cams[this.tvIdx].position;
    if (!finiteVec(cp)) {
      this.tvFallback(h, cut, st);
      return;
    }
    this.outPos.copy(cp);

    // Operator pan: exponential follow of the (slightly led) car, with a max angular speed.
    _v1.copy(P).addScaledVector(st.velocity, T.tvLead);
    _v1.y += 0.3;
    const dx = _v1.x - cp.x;
    const dy = _v1.y - cp.y;
    const dz = _v1.z - cp.z;
    const dh = Math.sqrt(dx * dx + dz * dz);
    const yawT = dh > 1e-6 ? Math.atan2(dx, dz) : this.tvYaw.x;
    const pitchT = Math.atan2(dy, Math.max(dh, 1e-6));
    if (camCut) {
      lagReset(this.tvYaw, yawT);
      lagReset(this.tvPitch, pitchT);
    } else {
      const y0 = this.tvYaw.x;
      const p0 = this.tvPitch.x;
      lagStep(this.tvYaw, this.tvYaw.g + wrapPi(yawT - this.tvYaw.g), T.tvPanTau, h);
      lagStep(this.tvPitch, pitchT, T.tvPanTau, h);
      const sy = this.tvYaw.x - y0;
      const sp = this.tvPitch.x - p0;
      const cpch = Math.cos(p0);
      const mag = Math.sqrt(sy * sy * cpch * cpch + sp * sp);
      const lim = T.tvPanMaxRate * h;
      if (mag > lim) {
        // the operator cannot swing faster than this
        const f = lim / mag;
        this.tvYaw.x = y0 + sy * f;
        this.tvPitch.x = p0 + sp * f;
      }
      this.tvPitch.x = clamp(this.tvPitch.x, -1.45, 1.45);
    }
    const cpi = Math.cos(this.tvPitch.x);
    const fx = Math.sin(this.tvYaw.x) * cpi;
    const fy = Math.sin(this.tvPitch.x);
    const fz = Math.cos(this.tvYaw.x) * cpi;
    if (!lookQuat(fx, fy, fz, WORLD_UP, this.outQuat)) this.outQuat.copy(this.camera.quaternion);
    const sw = T.tvSway * this.shake;
    if (sw > 0) {
      _euler.set(sw * wob(this.time, 0.23, 30.1), sw * wob(this.time, 0.17, 31.7), 0, 'XYZ');
      _q1.setFromEuler(_euler);
      this.outQuat.multiply(_q1);
    }

    // Zoom: keep the car's bounding diameter at tvFrameFraction of the frame height. Like a real
    // operator it anticipates: framed for where the car will be one zoom time constant from now.
    _v2.copy(P).addScaledVector(st.velocity, T.tvFovTau);
    const D = Math.max(0.5, _v2.distanceTo(cp));
    const fovT = clamp((2 * Math.atan(this.szRadius / (T.tvFrameFraction * D))) / DEG, T.tvFovMinDeg, T.tvFovMaxDeg);
    if (camCut) lagReset(this.tvFov, fovT);
    else lagStep(this.tvFov, fovT, T.tvFovTau, h);
    this.outFov = this.tvFov.x;
    this.outNear = T.near;
    this.outShake = T.shakeByMode.tv;
  }

  /** No track or no TV cameras: a fixed-height camera orbiting slowly into place behind the car's travel. */
  private tvFallback(h: number, cut: boolean, st: VehicleState): void {
    const T = TUNING;
    const P = st.position;
    const first = cut || !this.tvFbActive;
    this.tvFbActive = true;
    this.tvIdx = -1;
    const hdg = this.hSpeed > 3 ? this.velYaw : this.carYaw;
    if (first) lagReset(this.tvFbYaw, hdg);
    else lagStep(this.tvFbYaw, this.tvFbYaw.g + wrapPi(hdg - this.tvFbYaw.g), T.tvFallbackTau, h);
    const a = this.tvFbYaw.x;
    const sizeF = 1 + T.sizeInfluence * (this.szScale - 1);
    const d = T.tvFallbackDistance * sizeF;
    const C = this.outPos;
    const tr = this.track;
    const tc = this.tpCar;
    let onRoad = false;
    if (tr && this.carSOk && Number.isFinite(tc.s) && Number.isFinite(tc.wallLeft) && Number.isFinite(tc.wallRight)) {
      // over the road itself, a car-length or three back along the track: it follows the bends and
      // can't end up inside the trees or behind a hillside the way a heading-based offset can
      const lat = clamp(tc.d * 0.5, -(tc.wallRight - 1.5), tc.wallLeft - 1.5);
      tr.pointAt(tr.wrapS(tc.s - d), lat, _v1);
      _v1.y += T.tvFallbackHeight;
      // (a road point implausibly far from the car means the track doesn't loop there: use the heading)
      onRoad = Number.isFinite(_v1.x) && _v1.distanceTo(P) < 3 * d + 10;
    }
    if (onRoad) {
      // (a smooth function of the car's track position already: no extra lag, which would make
      // the shot depend on the frame rate)
      C.copy(_v1);
    } else {
      C.set(P.x - Math.sin(a) * d, P.y + T.tvFallbackHeight, P.z - Math.cos(a) * d);
      this.constrain(C, h, first);
    }
    if (!lookQuat(P.x - C.x, P.y + 0.3 - C.y, P.z - C.z, WORLD_UP, this.outQuat)) this.outQuat.copy(this.camera.quaternion);
    this.outFov = T.tvFallbackFovDeg;
    this.outNear = T.near;
    this.outShake = T.shakeByMode.tv;
  }

  // ── orbit ──────────────────────────────────────────────────────────────────

  private orbit(h: number, cut: boolean, st: VehicleState, lx: number, ly: number): void {
    const T = TUNING;
    const P = st.position;
    if (this.entered) {
      this.orbYaw = T.orbitStartYaw;
      this.orbElev = T.orbitStartElev;
      this.orbIdle = 0;
    }
    // Stick → angular rates (lightly smoothed) → angles. Same view convention as everywhere:
    // stick right turns the view right, stick up tilts it up (camera goes down).
    const ryT = -lx * T.orbitRate;
    const reT = -ly * T.orbitRate;
    let dYaw: number;
    let dElev: number;
    if (cut) {
      lagReset(this.orbRateYaw, ryT);
      lagReset(this.orbRateElev, reT);
      dYaw = this.entered ? 0 : ryT * h; // no time passes on the entry frame
      dElev = this.entered ? 0 : reT * h;
    } else {
      // exact integral of the smoothed rate over the step
      dYaw = lagStepIntegral(this.orbRateYaw, ryT, T.orbitInputTau, h);
      dElev = lagStepIntegral(this.orbRateElev, reT, T.orbitInputTau, h);
    }
    this.orbYaw = wrapPi(this.orbYaw + dYaw);
    this.orbElev = clamp(this.orbElev + dElev, T.orbitElevMin, T.orbitElevMax);
    // Idle clock: starts at 0 on entering orbit (no time passes on the entry frame).
    if (this.entered || Math.abs(lx) + Math.abs(ly) > 0.05) this.orbIdle = 0;
    else this.orbIdle += h;
    // Idle above the drift speed: ease (over ~1 s) into a slow return behind the car. The drift
    // strength is integrated with the trapezoid rule so the result does not depend on the frame rate.
    const drift =
      smoothstep(T.orbitIdleTime, T.orbitIdleTime + 1, this.orbIdle) * smoothstep(T.orbitDriftSpeed - 1, T.orbitDriftSpeed + 1, this.speed);
    const driftAvg = cut ? 0 : 0.5 * (drift + this.orbDriftPrev);
    this.orbDriftPrev = drift;
    if (driftAvg > 0) {
      const k = 1 - Math.exp((-h * driftAvg) / T.orbitDriftTau);
      this.orbYaw -= this.orbYaw * k;
      this.orbElev += (T.orbitStartElev - this.orbElev) * k;
    }
    // The orbit frame follows the car's heading smoothly.
    if (cut) lagReset(this.orbBase, this.carYaw);
    else lagStep(this.orbBase, this.orbBase.g + wrapPi(this.carYaw - this.orbBase.g), T.orbitHeadingTau, h);
    const sizeF = 1 + T.sizeInfluence * (this.szScale - 1);
    if (cut) lagReset(this.orbDist, T.orbitDistance * sizeF);
    else lagStep(this.orbDist, T.orbitDistance * sizeF, 0.5, h);
    const a = this.orbBase.x + this.orbYaw;
    const d = this.orbDist.x;
    const ce = Math.cos(this.orbElev);
    const pivotY = P.y + this.szRoof * 0.35;
    const C = this.outPos;
    C.set(P.x - Math.sin(a) * ce * d, pivotY + Math.sin(this.orbElev) * d, P.z - Math.cos(a) * ce * d);
    this.constrain(C, h, cut);
    if (!lookQuat(P.x - C.x, pivotY - C.y, P.z - C.z, WORLD_UP, this.outQuat)) this.outQuat.copy(this.camera.quaternion);
    this.outFov = this.fovBase;
    this.outNear = T.near;
    this.outShake = T.shakeByMode.orbit;
  }

  // ── output ─────────────────────────────────────────────────────────────────

  /** Apply shake, guard against NaN, write the camera. False = pose rejected (camera unchanged). */
  private finish(): boolean {
    const amt = this.shake * this.outShake;
    if (amt > 0) {
      _euler.set(this.shR.x * amt, this.shR.y * amt, this.shR.z * amt, 'XYZ');
      _q1.setFromEuler(_euler);
      this.outQuat.multiply(_q1);
      _v1.copy(this.shP).multiplyScalar(amt).applyQuaternion(this.outQuat);
      this.outPos.add(_v1);
    }
    if (!finiteVec(this.outPos) || !finiteQuat(this.outQuat) || !Number.isFinite(this.outFov)) return false;
    const cam = this.camera;
    cam.position.copy(this.outPos);
    cam.quaternion.copy(this.outQuat).normalize();
    const fov = clamp(this.outFov, 1, 150);
    let proj = false;
    if (Math.abs(cam.fov - fov) > 1e-7) {
      cam.fov = fov;
      proj = true;
    }
    if (cam.near !== this.outNear) {
      cam.near = this.outNear;
      proj = true;
    }
    if (cam.far !== TUNING.far) {
      cam.far = TUNING.far;
      proj = true;
    }
    if (proj) cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    return true;
  }
}

/** See CreateCameraRig in src/core/systems.ts. */
export function createCameraRig(track: TrackRuntime | null, tvCameras: TrackScene['tvCameras']): CameraRig {
  return new CameraRigImpl(track, tvCameras);
}
