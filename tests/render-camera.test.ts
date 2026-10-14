/**
 * Camera rig tests (owner: render). Headless: three.js math + Object3D only, no DOM / WebGL.
 *
 * A synthetic car (Vanta GT dimensions, carvis anchor layout) is driven along analytic paths, so the
 * same scenario can be sampled at any frame rate.
 */
import { readFileSync } from 'node:fs';
import { Euler, Group, Object3D, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { CameraMode, GroundSample, TrackPoint, TrackRuntime, VehicleState, WheelState } from '../src/core/contracts';
import type { CameraRig, CameraTarget, TrackScene } from '../src/core/systems';
import { CAMERA_MODES, TUNING, createCameraRig } from '../src/render/cameraRig';

const DEG = Math.PI / 180;

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic car: Vanta GT (src/cars) + carvis anchor layout. Body frame: origin on the ground between
// the axles, +Z forward, +X left. The CG sits at (0, CG_H, CG_Z) in that frame.
// ─────────────────────────────────────────────────────────────────────────────

const CG_H = 0.46;
const WB = 2.7;
const CG_Z = 1.431 - WB / 2;
const TRACK_F = 1.67;
const TRACK_R = 1.63;
const R_WHEEL = 0.35;
const ANCHOR_LAYOUT = {
  hood: [0, 0.98, 1.35],
  bumper: [0, 0.38, 2.37],
  cockpit: [0.36, 1.04, -0.25],
  chase: [0, 1.22, -0.2],
} as const;
/** Wheel hubs relative to the CG (car frame), FL FR RL RR. */
const HUBS = [
  new Vector3(TRACK_F / 2, R_WHEEL - CG_H, WB / 2 - CG_Z),
  new Vector3(-TRACK_F / 2, R_WHEEL - CG_H, WB / 2 - CG_Z),
  new Vector3(TRACK_R / 2, R_WHEEL - CG_H, -WB / 2 - CG_Z),
  new Vector3(-TRACK_R / 2, R_WHEEL - CG_H, -WB / 2 - CG_Z),
];

function makeWheel(): WheelState {
  return {
    hub: new Vector3(),
    contactPoint: new Vector3(),
    contactNormal: new Vector3(0, 1, 0),
    steerAngle: 0,
    spin: 0,
    omega: 0,
    radius: R_WHEEL,
    width: 0.27,
    compression: 0.4,
    suspensionVelocity: 0,
    contact: true,
    surface: 'asphalt',
    load: 3600,
    slipRatio: 0,
    slipAngle: 0,
    forceLong: 0,
    forceLat: 0,
    skid: 0,
    tempC: 80,
    brakeTempC: 200,
  };
}

function makeState(): VehicleState {
  return {
    id: 0,
    position: new Vector3(0, CG_H, 0),
    quaternion: new Quaternion(),
    velocity: new Vector3(),
    angularVelocity: new Vector3(),
    speed: 0,
    forwardSpeed: 0,
    localAccel: new Vector3(),
    steer: 0,
    throttle: 0,
    brake: 0,
    handbrake: 0,
    clutch: 0,
    rpm: 900,
    idleRpm: 900,
    redlineRpm: 7800,
    limiterRpm: 8000,
    gear: 1,
    gearCount: 7,
    engineLoad: 0,
    boost: 0,
    revLimiter: false,
    absActive: false,
    tcsActive: false,
    escActive: false,
    shiftCount: 0,
    backfireCount: 0,
    impactCount: 0,
    lastImpact: { strength: 0, point: new Vector3(), normal: new Vector3(0, 1, 0), kind: 'wall' },
    scrape: 0,
    scrapePoint: new Vector3(),
    wheels: [makeWheel(), makeWheel(), makeWheel(), makeWheel()],
    airborne: false,
  };
}

interface Car {
  state: VehicleState;
  root: Group;
  target: CameraTarget;
}

function makeCar(): Car {
  const root = new Group();
  const anchors = { hood: new Object3D(), bumper: new Object3D(), cockpit: new Object3D(), chase: new Object3D() };
  for (const k of ['hood', 'bumper', 'cockpit', 'chase'] as const) {
    anchors[k].position.fromArray(ANCHOR_LAYOUT[k]);
    root.add(anchors[k]);
  }
  const state = makeState();
  return { state, root, target: { state, anchors } };
}

interface Pose {
  p: Vector3; // CG, world
  yaw: number; // car heading, + = left
  pitch: number;
  roll: number;
  v: Vector3; // world velocity
  a: Vector3; // world acceleration
  yawRate: number;
  airborne: boolean;
}
function newPose(): Pose {
  return { p: new Vector3(0, CG_H, 0), yaw: 0, pitch: 0, roll: 0, v: new Vector3(), a: new Vector3(), yawRate: 0, airborne: false };
}
type Scenario = (t: number, o: Pose) => void;

/** Left-hand circle; slipDeg > 0 = nose pointing into the corner (a drift). */
const circle =
  (R: number, v: number, slipDeg = 0): Scenario =>
  (t, o) => {
    const w = v / R;
    const psi = w * t;
    o.p.set(-R * Math.cos(psi), CG_H, R * Math.sin(psi));
    o.v.set(v * Math.sin(psi), 0, v * Math.cos(psi));
    o.a.set(v * w * Math.cos(psi), 0, -v * w * Math.sin(psi));
    o.yaw = psi + slipDeg * DEG;
    o.pitch = 0;
    o.roll = 0;
    o.yawRate = w;
    o.airborne = false;
  };

/** Straight along +Z at x, starting at z0; the car may be yawed (yawDeg) relative to its travel. */
const straight =
  (v: number, z0 = 0, x = 0, yawDeg = 0): Scenario =>
  (t, o) => {
    o.p.set(x, CG_H, z0 + v * t);
    o.v.set(0, 0, v);
    o.a.set(0, 0, 0);
    o.yaw = yawDeg * DEG;
    o.pitch = 0;
    o.roll = 0;
    o.yawRate = 0;
    o.airborne = false;
  };

/** Varied drive: curvature, speed (25 -> 61 m/s over 6 s) and slip (±20°) all change continuously. */
const wiggle: Scenario = (t, o) => {
  const x = 30 * Math.sin(0.35 * t) + 4 * Math.sin(0.9 * t);
  const dx = 10.5 * Math.cos(0.35 * t) + 3.6 * Math.cos(0.9 * t);
  const ddx = -3.675 * Math.sin(0.35 * t) - 3.24 * Math.sin(0.9 * t);
  const z = 25 * t + 3 * t * t;
  const dz = 25 + 6 * t;
  const ddz = 6;
  o.p.set(x, CG_H, z);
  o.v.set(dx, 0, dz);
  o.a.set(ddx, 0, ddz);
  o.yaw = Math.atan2(dx, dz) + 0.35 * Math.sin(0.6 * t);
  o.pitch = 0;
  o.roll = 0;
  o.yawRate = (dz * ddx - dx * ddz) / (dx * dx + dz * dz) + 0.21 * Math.cos(0.6 * t);
  o.airborne = false;
};

const _e = new Euler();
const _t = new Vector3();
const _up = new Vector3();
const _qi = new Quaternion();

function applyPose(car: Car, o: Pose, poseRoot = true): void {
  const s = car.state;
  _e.set(o.pitch, o.yaw, o.roll, 'YXZ');
  s.quaternion.setFromEuler(_e);
  s.position.copy(o.p);
  s.velocity.copy(o.v);
  s.angularVelocity.set(0, o.yawRate, 0);
  s.speed = o.v.length();
  s.forwardSpeed = o.v.dot(_t.set(0, 0, 1).applyQuaternion(s.quaternion));
  _qi.copy(s.quaternion).invert();
  s.localAccel.copy(o.a).applyQuaternion(_qi);
  s.airborne = o.airborne;
  _up.set(0, 1, 0).applyQuaternion(s.quaternion);
  for (let i = 0; i < 4; i++) {
    const w = s.wheels[i];
    w.hub.copy(HUBS[i]).applyQuaternion(s.quaternion).add(s.position);
    w.contactPoint.copy(w.hub).addScaledVector(_up, -R_WHEEL);
    w.contact = !o.airborne;
  }
  if (poseRoot) {
    car.root.quaternion.copy(s.quaternion);
    car.root.position.copy(s.position).sub(_t.set(0, CG_H, CG_Z).applyQuaternion(s.quaternion));
    car.root.updateMatrixWorld(true);
  }
}

interface Look {
  x: number;
  y: number;
  back: boolean;
}
const NO_LOOK: Look = { x: 0, y: 0, back: false };

interface DriveOpts {
  t0?: number;
  /** Also update at t0 itself (frame i = 0), so runs at different rates share their first frame. */
  fromT0?: boolean;
  look?: (t: number) => Look;
  /** Mutate the pose / state before the update (events, overrides). */
  before?: (t: number, o: Pose, car: Car) => void;
  after?: (t: number, i: number) => void;
  poseRoot?: boolean;
}

/** Drive `seconds` at `hz`; frame i is at t0 + i/hz (i = 1..n). Returns the final time. */
function drive(rig: CameraRig, car: Car, sc: Scenario, hz: number, seconds: number, opts: DriveOpts = {}): number {
  const dt = 1 / hz;
  const n = Math.round(seconds * hz);
  const t0 = opts.t0 ?? 0;
  const o = newPose();
  let t = t0;
  for (let i = opts.fromT0 ? 0 : 1; i <= n; i++) {
    t = t0 + i * dt;
    sc(t, o);
    applyPose(car, o, opts.poseRoot ?? true);
    opts.before?.(t, o, car);
    rig.update(dt, car.target, opts.look ? opts.look(t) : NO_LOOK);
    opts.after?.(t, i);
  }
  return t;
}

/** Straight fake track: s = z, d = x, flat ground at y = 0, walls at ±wall. Records the hints it gets. */
function fakeTrack(length = 5000, wall = 10) {
  const hints: number[] = [];
  const f32 = new Float32Array(2);
  const wrap = (s: number) => ((s % length) + length) % length;
  const rt = {
    info: { id: 'fake', name: 'Fake', location: '', description: '', difficulty: 1, defaultLaps: 1, defaultTimeOfDay: 'noon', lengthHint: length, color: '#fff' },
    length,
    spacing: 5,
    count: Math.floor(length / 5),
    px: f32, py: f32, pz: f32, tx: f32, ty: f32, tz: f32, nx: f32, ny: f32, nz: f32, lx: f32, ly: f32, lz: f32,
    widthLeft: f32, widthRight: f32, wallLeft: f32, wallRight: f32, curvature: f32, bank: f32,
    sectors: [length / 3, (2 * length) / 3],
    grid: [],
    bounds: { minX: -50, maxX: 50, minZ: 0, maxZ: length, minY: 0, maxY: 0 },
    groundAt(x: number, z: number, out: GroundSample, hint?: number): number {
      hints.push(hint ?? -1);
      out.height = 0;
      out.normal.set(0, 1, 0);
      out.surface = 'asphalt';
      return Math.floor(wrap(z) / 5);
    },
    project(x: number, z: number, out: TrackPoint, hint?: number): number {
      hints.push(hint ?? -1);
      out.s = wrap(z);
      out.d = x;
      out.segment = Math.floor(out.s / 5);
      out.widthLeft = 7;
      out.widthRight = 7;
      out.wallLeft = wall;
      out.wallRight = wall;
      out.tx = 0;
      out.tz = 1;
      out.lx = 1;
      out.lz = 0;
      out.y = 0;
      return out.segment;
    },
    pointAt(s: number, d: number, out: Vector3): Vector3 {
      return out.set(d, 0, s);
    },
    frameAt(_s: number, out: unknown) {
      return out;
    },
    wrapS: wrap,
  };
  return { track: rt as unknown as TrackRuntime, hints };
}

function tvCams(from: number, to: number, step: number, x = 15, y = 6): TrackScene['tvCameras'] {
  const cams: TrackScene['tvCameras'] = [];
  for (let s = from; s <= to; s += step) cams.push({ position: new Vector3(x, y, s), s });
  return cams;
}

function forwardOf(rig: CameraRig): Vector3 {
  return new Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion);
}
function carAxes(car: Car) {
  const q = car.state.quaternion;
  return { F: new Vector3(0, 0, 1).applyQuaternion(q), L: new Vector3(1, 0, 0).applyQuaternion(q), U: new Vector3(0, 1, 0).applyQuaternion(q) };
}
function quatAngle(a: Quaternion, b: Quaternion): number {
  return 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));
}
function camOk(rig: CameraRig): boolean {
  const c = rig.camera;
  return [c.position.x, c.position.y, c.position.z, c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w, c.fov, c.near, c.far].every(Number.isFinite);
}
function pose(rig: CameraRig) {
  return { p: rig.camera.position.clone(), q: rig.camera.quaternion.clone(), fov: rig.camera.fov, near: rig.camera.near };
}
/** Signed angle (rad) of a horizontal direction, + = left of +Z. */
function yawOf(v: Vector3): number {
  return Math.atan2(v.x, v.z);
}
function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
/** Camera roll relative to the horizon (rad). */
function rollOf(rig: CameraRig): number {
  const r = new Vector3(1, 0, 0).applyQuaternion(rig.camera.quaternion);
  const u = new Vector3(0, 1, 0).applyQuaternion(rig.camera.quaternion);
  return Math.atan2(r.y, u.y);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('camera rig: API', () => {
  it('creates the camera with the default projection', () => {
    const rig = createCameraRig(null, []);
    expect(rig.camera.fov).toBe(62);
    expect(rig.camera.near).toBe(0.12);
    expect(rig.camera.far).toBe(6000);
    expect(rig.camera.aspect).toBeCloseTo(16 / 9, 9);
    expect(rig.mode).toBe('chase');
  });

  it('CAMERA_MODES is the cycle order and next() walks it', () => {
    expect(CAMERA_MODES).toEqual(['chase', 'chase-far', 'hood', 'bumper', 'cockpit', 'tv', 'orbit']);
    const rig = createCameraRig(null, []);
    const seen: CameraMode[] = [];
    for (let i = 0; i < 7; i++) seen.push(rig.next());
    expect(seen).toEqual(['chase-far', 'hood', 'bumper', 'cockpit', 'tv', 'orbit', 'chase']);
    rig.mode = 'tv';
    expect(rig.mode).toBe('tv');
    rig.setMode('cockpit');
    expect(rig.mode).toBe('cockpit');
  });

  it('setAspect / setFov apply (FOV is the base the modes add to)', () => {
    const rig = createCameraRig(null, []);
    rig.setAspect(2.5);
    expect(rig.camera.aspect).toBe(2.5);
    expect(rig.camera.projectionMatrix.elements[0]).toBeCloseTo(1 / (Math.tan(31 * DEG) * 2.5), 6);
    rig.setFov(80);
    const car = makeCar();
    drive(rig, car, straight(0), 60, 0.5);
    expect(rig.camera.fov).toBeCloseTo(80, 6);
    rig.setMode('cockpit');
    drive(rig, car, straight(0), 60, 0.5);
    expect(rig.camera.fov).toBeCloseTo(80 + TUNING.interiorFovDeg, 6);
  });
});

describe('chase camera', () => {
  for (const hz of [60, 144]) {
    for (const slip of [0, 30]) {
      it(`circle R=60 m, 25 m/s, slip ${slip}°, ${hz} Hz: finite, 3-12 m from the car, no jitter`, () => {
        const car = makeCar();
        const rig = createCameraRig(null, []);
        rig.setShake(1);
        const ps: Vector3[] = [];
        const qs: Quaternion[] = [];
        drive(rig, car, circle(60, 25, slip), hz, 8, {
          after: (t) => {
            expect(camOk(rig)).toBe(true);
            const d = rig.camera.position.distanceTo(car.state.position);
            expect(d).toBeGreaterThan(3);
            expect(d).toBeLessThan(12);
            if (t > 1) {
              ps.push(rig.camera.position.clone());
              qs.push(rig.camera.quaternion.clone());
            }
          },
        });
        const { aMax, alphaMax } = secondDifferences(ps, qs, 1 / hz);
        // The car itself accelerates at v²/R = 10.4 m/s²; the camera rides a ~60 m circle with it.
        expect(aMax).toBeLessThan(14);
        expect(alphaMax).toBeLessThan(0.5);
      });
    }
  }

  for (const hz of [60, 144]) {
    it(`varied drive (curvature, speed, slip all changing), ${hz} Hz: second differences stay small`, () => {
      const car = makeCar();
      const rig = createCameraRig(null, []);
      rig.setShake(1);
      const ps: Vector3[] = [];
      const qs: Quaternion[] = [];
      const cps: Vector3[] = [];
      drive(rig, car, wiggle, hz, 6, {
        after: (t) => {
          expect(camOk(rig)).toBe(true);
          if (t > 0.5) {
            ps.push(rig.camera.position.clone());
            qs.push(rig.camera.quaternion.clone());
            cps.push(car.state.position.clone());
          }
        },
      });
      const cam = secondDifferences(ps, qs, 1 / hz);
      const carA = secondDifferences(cps, [], 1 / hz).aMax;
      // a jittering camera (alternating ±1 mm per frame) would show > 80 m/s² at 144 Hz
      expect(cam.aMax).toBeLessThan(1.5 * carA + 4);
      expect(cam.alphaMax).toBeLessThan(3);
    });
  }

  it('follows translation rigidly: no distance lag at constant speed on a straight', () => {
    const rest = makeCar();
    const rigRest = createCameraRig(null, []);
    rigRest.setShake(0);
    drive(rigRest, rest, straight(0), 60, 2);
    const d0 = rigRest.camera.position.distanceTo(rest.state.position);
    expect(d0).toBeGreaterThan(5.5);
    expect(d0).toBeLessThan(6.6);

    for (const v of [30, 60, 85]) {
      const car = makeCar();
      const rig = createCameraRig(null, []);
      rig.setShake(1); // speed shake on: still only millimetres
      let dMin = Infinity;
      let dMax = 0;
      drive(rig, car, straight(v), 60, 5, {
        after: (t) => {
          if (t < 2) return;
          const d = rig.camera.position.distanceTo(car.state.position);
          dMin = Math.min(dMin, d);
          dMax = Math.max(dMax, d);
        },
      });
      expect(Math.abs(dMax - d0) / d0).toBeLessThan(0.02);
      expect(Math.abs(dMin - d0) / d0).toBeLessThan(0.02);
      // and it is behind the car, not dragged behind it
      const { F } = carAxes(car);
      expect(rig.camera.position.clone().sub(car.state.position).dot(F)).toBeLessThan(-5);
    }
  });

  it('in a slide the heading sits between the car yaw and the velocity heading', () => {
    // straight-line slide: travelling +Z, nose yawed 30° left
    const car = makeCar();
    const rig = createCameraRig(null, []);
    rig.setShake(0);
    drive(rig, car, straight(25, 0, 0, 30), 60, 3);
    const h = yawOf(forwardOf(rig)); // velocity heading = 0, car yaw = +30°
    expect(h).toBeGreaterThan(3 * DEG);
    expect(h).toBeLessThan(27 * DEG);
    // the camera's offset (car -> camera) points back along that same blended heading
    const off = rig.camera.position.clone().sub(car.state.position).negate();
    expect(Math.abs(wrapPi(yawOf(off) - h))).toBeLessThan(1 * DEG);

    // drifting on a circle: also between (with the swing's small corner lag)
    const car2 = makeCar();
    const rig2 = createCameraRig(null, []);
    rig2.setShake(0);
    drive(rig2, car2, circle(60, 25, 30), 60, 6);
    const velYaw = yawOf(car2.state.velocity);
    const carYaw = yawOf(carAxes(car2).F);
    const camYaw = yawOf(forwardOf(rig2));
    const toVel = wrapPi(camYaw - velYaw);
    const toCar = wrapPi(carYaw - camYaw);
    expect(toVel).toBeGreaterThan(-1 * DEG);
    expect(toCar).toBeGreaterThan(5 * DEG);
    expect(toVel + toCar).toBeCloseTo(30 * DEG, 6);
  });

  it('the swing is smoothed: lags a quick heading flick, settles critically damped, lags a little in corners', () => {
    // straight at 20 m/s, then the car's heading turns 25° left in 0.25 s (no slip), then straight again
    const ang = 25 * DEG;
    const flickHeading = (t: number) => {
      const u = Math.min(1, Math.max(0, (t - 1) / 0.25));
      return ang * u * u * (3 - 2 * u);
    };
    const path: Vector3[] = [new Vector3(0, CG_H, 0)];
    const dtp = 1e-3;
    for (let i = 1; i <= 4000; i++) {
      const psi = flickHeading((i - 0.5) * dtp);
      path.push(path[i - 1].clone().add(new Vector3(Math.sin(psi), 0, Math.cos(psi)).multiplyScalar(20 * dtp)));
    }
    const flick: Scenario = (t, o) => {
      const i = Math.min(4000, Math.round(t / dtp));
      const psi = flickHeading(t);
      o.p.copy(path[i]);
      o.v.set(20 * Math.sin(psi), 0, 20 * Math.cos(psi));
      o.a.set(0, 0, 0);
      o.yaw = psi;
      o.pitch = 0;
      o.roll = 0;
      o.yawRate = 0;
      o.airborne = false;
    };
    const rig = createCameraRig(null, []);
    rig.setShake(0);
    let atEnd = 0;
    let maxHeading = -Infinity;
    drive(rig, makeCar(), flick, 120, 4, {
      after: (t) => {
        const hdg = yawOf(forwardOf(rig));
        if (Math.abs(t - 1.25) < 1e-6) atEnd = hdg;
        maxHeading = Math.max(maxHeading, hdg);
        if (t > 3.5) expect(Math.abs(hdg - ang)).toBeLessThan(0.3 * DEG);
      },
    });
    expect(atEnd).toBeGreaterThan(0.1 * ang); // follows...
    expect(atEnd).toBeLessThan(0.6 * ang); // ...but lags: not glued to the car
    expect(maxHeading).toBeLessThan(ang + 1.5 * DEG); // no visible overshoot

    // steady corner: lag = 2·(1 - swingLead)·yawRate/swingOmega behind the car's heading
    const car = makeCar();
    const rig2 = createCameraRig(null, []);
    rig2.setShake(0);
    drive(rig2, car, circle(60, 25), 60, 6);
    const lag = wrapPi(yawOf(carAxes(car).F) - yawOf(forwardOf(rig2)));
    const expected = (2 * (1 - TUNING.swingLead) * (25 / 60)) / TUNING.swingOmega;
    expect(lag).toBeGreaterThan(0.8 * expected);
    expect(lag).toBeLessThan(1.2 * expected);
  });

  it('without slip the heading is the car yaw (low speed and reversing too)', () => {
    for (const v of [1, 20, -8]) {
      const car = makeCar();
      const rig = createCameraRig(null, []);
      rig.setShake(0);
      drive(rig, car, straight(v, 0, 0, 10), 60, 3); // yawed 10° but moving along Z: v>0 = 10° slip
      const camYaw = yawOf(forwardOf(rig));
      if (v === 20) expect(camYaw).toBeLessThan(10 * DEG);
      else expect(Math.abs(wrapPi(camYaw - 10 * DEG))).toBeLessThan(0.5 * DEG); // slow / reversing: car yaw
      const { F } = carAxes(car);
      expect(rig.camera.position.clone().sub(car.state.position).dot(F)).toBeLessThan(-4); // behind the car
    }
  });

  it('FOV widens with speed (up to ~+14° near 90 m/s), smoothly', () => {
    const fovAt = (v: number) => {
      const car = makeCar();
      const rig = createCameraRig(null, []);
      rig.setShake(0);
      drive(rig, car, straight(v), 60, 3);
      return rig.camera.fov;
    };
    const f10 = fovAt(10);
    const f45 = fovAt(45);
    const f90 = fovAt(90);
    expect(f10).toBeLessThan(62.2);
    expect(f45).toBeGreaterThan(f10 + 3);
    expect(f90).toBeGreaterThan(f45 + 3);
    expect(f90).toBeCloseTo(62 + TUNING.speedFovMaxDeg, 1);
    expect(fovAt(90)).toBeLessThan(62 + TUNING.speedFovMaxDeg + 0.01);

    // a sudden stop eases the FOV back instead of popping
    const car = makeCar();
    const rig = createCameraRig(null, []);
    rig.setShake(0);
    drive(rig, car, straight(80), 60, 3);
    const before = rig.camera.fov;
    drive(rig, car, straight(0, 240), 60, 1 / 60);
    expect(before - rig.camera.fov).toBeLessThan(1.5);
    drive(rig, car, straight(0, 240), 60, 2);
    expect(rig.camera.fov).toBeLessThan(62.5);
  });

  it('pulls back under acceleration, moves in under braking, banks gently with lateral G', () => {
    const run = (ax: number, az: number) => {
      const car = makeCar();
      const rig = createCameraRig(null, []);
      rig.setShake(0);
      drive(rig, car, straight(30), 60, 2, { before: (_t, _o, c) => c.state.localAccel.set(ax, 0, az) });
      return { d: rig.camera.position.distanceTo(car.state.position), roll: rollOf(rig) };
    };
    const cruise = run(0, 0);
    const accel = run(0, 8);
    const brake = run(0, -15);
    const left = run(12, 0);
    expect(accel.d - cruise.d).toBeGreaterThan(0.15);
    expect(accel.d - cruise.d).toBeLessThan(0.5);
    expect(cruise.d - brake.d).toBeGreaterThan(0.3);
    expect(cruise.d - brake.d).toBeLessThan(0.7);
    expect(Math.abs(cruise.roll)).toBeLessThan(0.01 * DEG);
    expect(left.roll).toBeGreaterThan(1 * DEG); // banks into a left-hander
    expect(Math.abs(left.roll)).toBeLessThanOrEqual(TUNING.latRollMax + 1e-9);
  });

  it('right stick: right = view turns right (camera swings to the car’s left), auto-centres in ~0.5 s', () => {
    const car = makeCar();
    const rig = createCameraRig(null, []);
    rig.setShake(0);
    const sc = straight(20);
    drive(rig, car, sc, 60, 1);
    const t = drive(rig, car, sc, 60, 1, { t0: 1, look: () => ({ x: 1, y: 0, back: false }) });
    const { F, L } = carAxes(car);
    const off = rig.camera.position.clone().sub(car.state.position);
    expect(off.dot(L)).toBeGreaterThan(3); // on the car's left side...
    expect(forwardOf(rig).dot(L)).toBeLessThan(-0.3); // ...looking right
    // released: back behind the car within ~0.6 s
    drive(rig, car, sc, 60, 0.6, { t0: t });
    const off2 = rig.camera.position.clone().sub(car.state.position);
    expect(off2.dot(F)).toBeLessThan(-5);
    expect(Math.abs(off2.dot(L))).toBeLessThan(0.6);

    // stick down = look down = camera rises; stick up = look up = camera lowers
    const h0 = rig.camera.position.y;
    drive(rig, car, sc, 60, 1, { t0: t + 0.6, look: () => ({ x: 0, y: -1, back: false }) });
    expect(rig.camera.position.y - h0).toBeGreaterThan(2);
    drive(rig, car, sc, 60, 1, { t0: t + 1.6, look: () => ({ x: 0, y: 1, back: false }) });
    expect(rig.camera.position.y).toBeLessThan(h0 - 0.5);
  });

  it('look.back swings smoothly (≈0.25 s) to the front of the car looking back', () => {
    for (const mode of ['chase', 'chase-far'] as const) {
      const car = makeCar();
      const rig = createCameraRig(null, []);
      rig.setShake(0);
      rig.setMode(mode);
      const sc = straight(30);
      drive(rig, car, sc, 60, 1);
      let prev = rig.camera.position.clone().sub(car.state.position);
      let maxStep = 0;
      let moving = 0;
      let sawSide = false;
      const t = drive(rig, car, sc, 60, 1, {
        t0: 1,
        look: () => ({ x: 0, y: 0, back: true }),
        after: () => {
          const off = rig.camera.position.clone().sub(car.state.position);
          const step = off.angleTo(prev); // swing around the car this frame
          maxStep = Math.max(maxStep, step);
          if (step > 0.5 * DEG) moving++;
          prev = off;
          if (Math.abs(off.dot(carAxes(car).L)) > 3) sawSide = true;
        },
      });
      const { F } = carAxes(car);
      const off = rig.camera.position.clone().sub(car.state.position);
      expect(off.dot(F)).toBeGreaterThan(4); // in front of the car
      expect(forwardOf(rig).dot(F)).toBeLessThan(-0.9); // looking back
      expect(sawSide).toBe(true); // it swung round, it did not cut
      expect(maxStep).toBeLessThan(20 * DEG); // fast whip (peak ~18°/frame at 60 Hz), never a jump
      expect(moving / 60).toBeGreaterThan(0.2); // the swing lasts ~0.25 s
      // and back again
      drive(rig, car, sc, 60, 0.5, { t0: t });
      expect(rig.camera.position.clone().sub(car.state.position).dot(F)).toBeLessThan(-4);
    }
  });
});

describe('frame-rate independence', () => {
  // Same drive (speed 25 -> 61 m/s, curvature and ±20° slip changing, speed shake on) sampled at
  // 30 / 60 / 144 Hz from a shared first frame; compared along the whole run at the instants all three
  // rates hit (every 1/6 s). Measured: < 0.7 mm and < 0.04° in every mode.
  const cases: { mode: CameraMode; stick: boolean; label: string }[] = [
    ...(['chase', 'chase-far', 'hood', 'bumper', 'cockpit', 'orbit'] as const).map((mode) => ({ mode, stick: true, label: `${mode} + stick` })),
    { mode: 'tv', stick: false, label: 'tv fallback' },
    { mode: 'orbit', stick: false, label: 'orbit idle (drift back behind the car)' },
  ];
  for (const { mode, stick, label } of cases) {
    it(`${label}: 30 / 60 / 144 Hz trajectories agree`, () => {
      const runs = [30, 60, 144].map((hz) => {
        const car = makeCar();
        const rig = createCameraRig(fakeTrack(5000, 60).track, []); // barriers clear of the path (|x| ≤ 34 m)
        rig.setShake(1);
        rig.setMode(mode);
        const samples: ReturnType<typeof pose>[] = [];
        drive(rig, car, wiggle, hz, 6, {
          fromT0: true,
          // analog stick play (kept clear of the orbit's ground clamp, which is tested on its own)
          look: stick ? (t) => ({ x: 0.6 * Math.sin(1.3 * t), y: -0.15 * Math.sin(0.9 * t), back: false }) : undefined,
          after: (t) => {
            if (Math.abs(t * 6 - Math.round(t * 6)) < 1e-6) samples.push(pose(rig));
          },
        });
        return samples;
      });
      expect(runs.map((r) => r.length)).toEqual([37, 37, 37]);
      let dp = 0;
      let dq = 0;
      let df = 0;
      for (let r = 1; r < runs.length; r++) {
        for (let k = 0; k < runs[0].length; k++) {
          dp = Math.max(dp, runs[r][k].p.distanceTo(runs[0][k].p));
          dq = Math.max(dq, quatAngle(runs[r][k].q, runs[0][k].q));
          df = Math.max(df, Math.abs(runs[r][k].fov - runs[0][k].fov));
        }
      }
      expect(dp).toBeLessThan(0.003);
      expect(dq).toBeLessThan(0.15 * DEG);
      expect(df).toBeLessThan(0.01);
    });
  }

  it('pressed against a barrier: within 2 cm across rates (the 0.03 s clamp attack is sub-frame at 30 Hz)', () => {
    for (const mode of ['chase', 'chase-far', 'orbit'] as const) {
      const runs = [30, 60, 144].map((hz) => {
        const rig = createCameraRig(fakeTrack(5000, 10).track, []);
        rig.setShake(1);
        rig.setMode(mode);
        const samples: ReturnType<typeof pose>[] = [];
        let pressed = 0;
        drive(rig, makeCar(), straight(30, 0, 8.5), hz, 6, {
          fromT0: true,
          look: (t) => ({ x: Math.sin(1.1 * t), y: mode === 'orbit' ? 0.5 * Math.sin(0.8 * t) : 0, back: false }),
          after: (t) => {
            if (rig.camera.position.x > 10.1) pressed++;
            if (Math.abs(t * 6 - Math.round(t * 6)) < 1e-6) samples.push(pose(rig));
          },
        });
        return { samples, pressed };
      });
      expect(runs[0].pressed).toBeGreaterThan(30); // the clamp really was engaged
      let dp = 0;
      let dq = 0;
      for (let r = 1; r < runs.length; r++) {
        for (let k = 0; k < runs[0].samples.length; k++) {
          dp = Math.max(dp, runs[r].samples[k].p.distanceTo(runs[0].samples[k].p));
          dq = Math.max(dq, quatAngle(runs[r].samples[k].q, runs[0].samples[k].q));
        }
      }
      expect(dp).toBeLessThan(0.02);
      expect(dq).toBeLessThan(0.15 * DEG);
    }
  });

  it('tv: operator pan and zoom on one camera agree at 30 / 60 / 144 Hz', () => {
    const cam = [{ position: new Vector3(12, 5, 300), s: 300 }];
    const runs = [30, 60, 144].map((hz) => {
      const rig = createCameraRig(fakeTrack().track, cam);
      rig.setShake(0);
      rig.setMode('tv');
      const samples: ReturnType<typeof pose>[] = [];
      drive(rig, makeCar(), straight(30, 100), hz, 10, {
        fromT0: true,
        after: (t) => {
          if (Math.abs(t * 6 - Math.round(t * 6)) < 1e-6) samples.push(pose(rig));
        },
      });
      return samples;
    });
    let dq = 0;
    let df = 0;
    for (let r = 1; r < runs.length; r++) {
      for (let k = 0; k < runs[0].length; k++) {
        dq = Math.max(dq, quatAngle(runs[r][k].q, runs[0][k].q));
        df = Math.max(df, Math.abs(runs[r][k].fov - runs[0][k].fov));
      }
    }
    expect(dq).toBeLessThan(0.15 * DEG);
    expect(df).toBeLessThan(0.05);
  });
});

describe('hard cuts', () => {
  const setups: { name: string; mode: CameraMode; track: boolean; cams: boolean }[] = [
    { name: 'chase', mode: 'chase', track: true, cams: false },
    { name: 'chase-far', mode: 'chase-far', track: false, cams: false },
    { name: 'hood', mode: 'hood', track: false, cams: false },
    { name: 'bumper', mode: 'bumper', track: false, cams: false },
    { name: 'cockpit', mode: 'cockpit', track: false, cams: false },
    { name: 'tv (cameras)', mode: 'tv', track: true, cams: true },
    { name: 'tv (fallback)', mode: 'tv', track: false, cams: false },
    { name: 'orbit', mode: 'orbit', track: true, cams: false },
  ];
  const at = (t: number): Look => ({ x: t > 1.2 ? 0.4 : 0, y: 0, back: t > 0.6 && t < 0.9 });
  for (const s of setups) {
    it(`snap() is an exact hard cut: ${s.name}`, () => {
      const make = () => {
        const rig = createCameraRig(s.track ? fakeTrack().track : null, s.cams ? tvCams(0, 3000, 100) : []);
        rig.setShake(0);
        rig.setMode(s.mode);
        return rig;
      };
      const a = make();
      const carA = makeCar();
      // build up state: driving, sliding, stick and look-back history (orbit: no stick, keeps its angle)
      drive(a, carA, wiggle, 60, 2, { look: s.mode === 'orbit' ? undefined : at });
      // teleport somewhere else and hard-cut
      const look: Look = { x: s.mode === 'orbit' ? 0 : 0.4, y: 0, back: false };
      const sc = circle(80, 18, 12);
      const o = newPose();
      sc(7.3, o);
      applyPose(carA, o);
      a.snap();
      a.update(1 / 60, carA.target, look);
      const b = make();
      const carB = makeCar();
      applyPose(carB, o);
      b.update(1 / 60, carB.target, look);
      expect(a.camera.position.distanceTo(b.camera.position)).toBeLessThan(1e-9);
      expect(quatAngle(a.camera.quaternion, b.camera.quaternion)).toBeLessThan(1e-6);
      expect(Math.abs(a.camera.fov - b.camera.fov)).toBeLessThan(1e-9);
      // zero residual velocity: a stationary car stays framed identically on the next frame
      o.v.set(0, 0, 0);
      o.a.set(0, 0, 0);
      o.yawRate = 0;
      applyPose(carA, o);
      a.snap();
      a.update(1 / 60, carA.target, NO_LOOK);
      const p1 = pose(a);
      a.update(1 / 60, carA.target, NO_LOOK);
      expect(a.camera.position.distanceTo(p1.p)).toBeLessThan(1e-9);
      expect(quatAngle(a.camera.quaternion, p1.q)).toBeLessThan(1e-6);
    });
  }

  it('setMode() is an exact hard cut into every mode, and a teleport without snap() is cut too', () => {
    for (const m of CAMERA_MODES) {
      const cams = tvCams(0, 3000, 100);
      const a = createCameraRig(fakeTrack().track, cams);
      a.setShake(0);
      const carA = makeCar();
      drive(a, carA, wiggle, 60, 2, { look: (t) => ({ x: Math.sin(t), y: 0.3, back: false }) });
      const o = newPose();
      wiggle(2.4, o);
      applyPose(carA, o);
      a.setMode(m === 'chase' ? 'orbit' : m);
      if (m === 'chase') {
        a.update(1 / 60, carA.target, NO_LOOK);
        a.setMode('chase');
      }
      a.update(1 / 60, carA.target, NO_LOOK);
      const b = createCameraRig(fakeTrack().track, cams);
      b.setShake(0);
      b.setMode(m);
      const carB = makeCar();
      applyPose(carB, o);
      b.update(1 / 60, carB.target, NO_LOOK);
      expect(a.camera.position.distanceTo(b.camera.position)).toBeLessThan(1e-9);
      expect(quatAngle(a.camera.quaternion, b.camera.quaternion)).toBeLessThan(1e-6);
      expect(a.camera.fov).toBeCloseTo(b.camera.fov, 9);
    }
    // teleport (reset) without snap(): the chase camera re-frames instantly instead of swinging
    const rig = createCameraRig(null, []);
    rig.setShake(0);
    const car = makeCar();
    drive(rig, car, circle(60, 25), 60, 3);
    const o = newPose();
    straight(0, 0, 900, 120)(0, o);
    applyPose(car, o);
    rig.update(1 / 60, car.target, NO_LOOK);
    const { F } = carAxes(car);
    const off = rig.camera.position.clone().sub(car.state.position);
    expect(off.dot(F)).toBeLessThan(-5);
  });
});

describe('shake', () => {
  type Ev = 'curb' | 'impact' | 'scrape' | 'suspension';
  const runEv = (ev: Ev | null, shake: number, mode: CameraMode = 'chase') => {
    const car = makeCar();
    const rig = createCameraRig(null, []);
    rig.setShake(shake);
    rig.setMode(mode);
    const out: { p: Vector3; q: Quaternion }[] = [];
    drive(rig, car, straight(30), 60, 3, {
      before: (t, _o, c) => {
        const s = c.state;
        const on = t >= 1 && t < 2;
        if (ev === 'curb') for (let i = 0; i < 4; i++) s.wheels[i].surface = on && (i === 0 || i === 2) ? 'curb' : 'asphalt';
        if (ev === 'scrape') s.scrape = on ? 0.8 : 0;
        if (ev === 'suspension') for (let i = 0; i < 4; i++) s.wheels[i].suspensionVelocity = on ? 0.6 * Math.sin(40 * t + i) : 0;
        if (ev === 'impact' && t >= 1 && s.impactCount === 0) {
          s.impactCount = 1;
          s.lastImpact.strength = 12;
          s.lastImpact.normal.set(1, 0, 0); // wall on the right pushes the car left
        }
      },
      after: () => out.push({ p: rig.camera.position.clone(), q: rig.camera.quaternion.clone() }),
    });
    return out;
  };
  const deviation = (a: { p: Vector3; q: Quaternion }[], b: { p: Vector3; q: Quaternion }[], from: number, to: number) => {
    let dp = 0;
    let dq = 0;
    for (let i = Math.round(from * 60); i < Math.round(to * 60); i++) {
      dp = Math.max(dp, a[i].p.distanceTo(b[i].p));
      dq = Math.max(dq, quatAngle(a[i].q, b[i].q));
    }
    return { dp, dq };
  };

  for (const ev of ['curb', 'impact', 'scrape', 'suspension'] as const) {
    it(`${ev} shakes the camera, and setShake(0) removes it completely`, () => {
      const base1 = runEv(null, 1);
      const with1 = runEv(ev, 1);
      const d1 = deviation(with1, base1, 1, 2.2);
      expect(d1.dp > 0.002 || d1.dq > 0.03 * DEG).toBe(true);
      expect(d1.dp).toBeLessThan(0.3);
      expect(d1.dq).toBeLessThan(4 * DEG);
      // gone again ~1 s after the event
      const tail = deviation(with1, base1, 2.9, 3);
      expect(tail.dp).toBeLessThan(0.03 * d1.dp + 1e-5);
      expect(tail.dq).toBeLessThan(0.03 * d1.dq + 1e-6);
      // user shake 0: bit-identical to no event at all
      const base0 = runEv(null, 0);
      const with0 = runEv(ev, 0);
      const d0 = deviation(with0, base0, 0, 3);
      expect(d0.dp).toBe(0);
      expect(d0.dq).toBe(0);
    });
  }

  it('the impact kick is proportional to strength and decays in ~0.4 s', () => {
    const sc = straight(20);
    const baseline: Vector3[] = [];
    const base = createCameraRig(null, []);
    drive(base, makeCar(), sc, 120, 2, { after: () => baseline.push(base.camera.position.clone()) });
    const peak = (strength: number) => {
      const car = makeCar();
      const rig = createCameraRig(null, []);
      let m = 0;
      let late = 0;
      drive(rig, car, sc, 120, 2, {
        before: (t, _o, c) => {
          if (t >= 0.5 && c.state.impactCount === 0) {
            c.state.impactCount = 1;
            c.state.lastImpact.strength = strength;
            c.state.lastImpact.normal.set(0, 0, -1); // head-on: pushed backwards
          }
        },
        after: (t, i) => {
          const d = rig.camera.position.distanceTo(baseline[i - 1]);
          if (t < 1) m = Math.max(m, d);
          if (t > 1.1) late = Math.max(late, d); // 0.6 s after the hit
        },
      });
      return { m, late };
    };
    const small = peak(3);
    const big = peak(12);
    expect(big.m).toBeGreaterThan(3 * small.m);
    expect(big.m).toBeGreaterThan(0.03);
    expect(big.late).toBeLessThan(0.05 * big.m);
  });

  it('continuous speed shake only above ~45 m/s, low frequency', () => {
    const wobble = (v: number) => {
      const car = makeCar();
      const rig = createCameraRig(null, []);
      rig.setShake(1);
      const rolls: number[] = [];
      drive(rig, car, straight(v), 60, 4, { after: (t) => t > 1 && rolls.push(rollOf(rig)) });
      return Math.max(...rolls) - Math.min(...rolls);
    };
    expect(wobble(30)).toBeLessThan(1e-9);
    expect(wobble(85)).toBeGreaterThan(0.05 * DEG);
    expect(wobble(85)).toBeLessThan(0.6 * DEG);
  });
});

describe('tv camera', () => {
  const tvRun = (cams: TrackScene['tvCameras'], sc: Scenario, seconds: number, hz = 60) => {
    const { track } = fakeTrack(5000);
    const rig = createCameraRig(track, cams);
    rig.setShake(0);
    rig.setMode('tv');
    const car = makeCar();
    const cuts: { t: number; to: number; carZ: number }[] = [];
    const frames: { t: number; idx: number; fov: number; d: number; aimErr: number }[] = [];
    let cur = -1;
    drive(rig, car, sc, hz, seconds, {
      after: (t) => {
        expect(camOk(rig)).toBe(true);
        const idx = cams.findIndex((c) => c.position.equals(rig.camera.position));
        expect(idx).toBeGreaterThanOrEqual(0);
        if (idx !== cur) {
          cuts.push({ t, to: idx, carZ: car.state.position.z });
          cur = idx;
        }
        const toCar = car.state.position.clone().sub(rig.camera.position);
        const d = toCar.length();
        frames.push({ t, idx, fov: rig.camera.fov, d, aimErr: forwardOf(rig).angleTo(toCar.normalize()) });
      },
    });
    return { cuts, frames };
  };

  it('picks the nearest camera ahead, cuts ~35 m after passing, then the next one ahead', () => {
    const cams = tvCams(0, 3000, 100);
    const { cuts, frames } = tvRun(cams, straight(30, 20), 25);
    expect(cuts[0].to).toBe(1); // s=0 was passed 20 m ago; s=100 is the nearest ahead
    expect(cuts.length).toBeGreaterThan(5);
    for (let i = 1; i < cuts.length; i++) {
      expect(cuts[i].to).toBe(cuts[i - 1].to + 1);
      const passedBy = cuts[i].carZ - cams[cuts[i - 1].to].s;
      expect(passedBy).toBeGreaterThanOrEqual(TUNING.tvLeaveBehind);
      expect(passedBy).toBeLessThan(TUNING.tvLeaveBehind + 1);
      expect(cuts[i].t - cuts[i - 1].t).toBeGreaterThanOrEqual(TUNING.tvMinDwell);
    }
    // framing: the car's bounding diameter (~5.1 m) stays ~20-28% of the frame height, except where the
    // 5°..50° zoom clamp makes that impossible (car closer than ~23 m or farther than ~230 m)
    const R = 0.5 * Math.hypot(WB * 1.7, TRACK_F + 0.3, 1.22);
    const dNear = (1.1 * R) / (TUNING.tvFrameFraction * Math.tan((TUNING.tvFovMaxDeg * DEG) / 2));
    const dFar = R / (1.1 * TUNING.tvFrameFraction * Math.tan((TUNING.tvFovMinDeg * DEG) / 2));
    let checked = 0;
    for (const f of frames) {
      const sinceCut = f.t - cuts.filter((c) => c.t <= f.t).slice(-1)[0].t;
      if (sinceCut < 1 || f.d < dNear || f.d > dFar) continue;
      const frac = R / (f.d * Math.tan((f.fov * DEG) / 2));
      expect(frac).toBeGreaterThan(0.2);
      expect(frac).toBeLessThan(0.28);
      checked++;
    }
    expect(checked).toBeGreaterThan(200);
    // the operator keeps the car in the middle of the frame (pan lag + lead)
    for (const f of frames) if (f.d > 25) expect(f.aimErr).toBeLessThan(6 * DEG);
  });

  it('never flickers: minimum dwell with dense cameras, hysteresis around the leave threshold', () => {
    // dense cameras at high speed: would cut every 0.3 s without the dwell
    const dense = tvCams(0, 4000, 20);
    const { cuts } = tvRun(dense, straight(70, 10), 20);
    expect(cuts.length).toBeGreaterThan(5);
    for (let i = 1; i < cuts.length; i++) expect(cuts[i].t - cuts[i - 1].t).toBeGreaterThanOrEqual(TUNING.tvMinDwell);
    // with several candidates it takes the one the car is approaching, not one it just passed
    for (const c of cuts) {
      expect(dense[c.to].s).toBeGreaterThan(c.carZ);
      expect(dense[c.to].s - c.carZ).toBeLessThanOrEqual(20);
    }

    // between two far-apart cameras (neither within reach): no A-B-A ping-pong
    const far = [
      { position: new Vector3(15, 6, 0), s: 0 },
      { position: new Vector3(-15, 6, 500), s: 500 },
    ];
    const between: Scenario = (t, o) => {
      o.p.set(0, CG_H, 250 + 20 * Math.sin(1.1 * t));
      o.v.set(0, 0, 22 * Math.cos(1.1 * t));
      o.a.set(0, 0, 0);
      o.yaw = 0;
      o.pitch = 0;
      o.roll = 0;
      o.yawRate = 0;
      o.airborne = false;
    };
    expect(tvRun(far, between, 30).cuts.length).toBe(1);

    // car hovering around the 35 m leave line of camera A (s=100): exactly one cut, to B, and no way back
    const two = [
      { position: new Vector3(15, 6, 100), s: 100 },
      { position: new Vector3(-15, 6, 250), s: 250 },
    ];
    const hover: Scenario = (t, o) => {
      if (t < 4) {
        o.p.set(0, CG_H, 20 + 27.5 * t);
        o.v.set(0, 0, 27.5);
      } else {
        const u = t - 4;
        o.p.set(0, CG_H, 130 + 6 * Math.sin(1.5 * u));
        o.v.set(0, 0, 9 * Math.cos(1.5 * u));
      }
      o.a.set(0, 0, 0);
      o.yaw = 0;
      o.pitch = 0;
      o.roll = 0;
      o.yawRate = 0;
      o.airborne = false;
    };
    const r = tvRun(two, hover, 25);
    expect(r.cuts.map((c) => c.to)).toEqual([0, 1]);

    // parked next to a camera: stays on it
    const parked = tvRun(tvCams(0, 3000, 100), straight(0, 120), 15);
    expect(parked.cuts.length).toBe(1);
  });

  it('falls back to a camera behind the car without a track or without TV cameras', () => {
    for (const withTrack of [false, true]) {
      const rig = createCameraRig(withTrack ? fakeTrack().track : null, []);
      rig.setShake(1);
      rig.setMode('tv');
      const car = makeCar();
      drive(rig, car, wiggle, 60, 5, {
        after: () => {
          expect(camOk(rig)).toBe(true);
          const d = rig.camera.position.distanceTo(car.state.position);
          expect(d).toBeGreaterThan(8);
          expect(d).toBeLessThan(25);
          expect(rig.camera.position.y).toBeGreaterThan(car.state.position.y + 2);
        },
      });
      const toCar = car.state.position.clone().sub(rig.camera.position).normalize();
      expect(forwardOf(rig).angleTo(toCar)).toBeLessThan(3 * DEG);
    }
  });
});

describe('hood / bumper / cockpit', () => {
  it('hood is rigidly tied to the body: anchor position and body orientation, no lag at a steady yaw rate', () => {
    for (const mode of ['hood', 'bumper'] as const) {
      const car = makeCar();
      const rig = createCameraRig(null, []);
      rig.setShake(0);
      rig.setMode(mode);
      const wp = new Vector3();
      const wq = new Quaternion();
      const face = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
      drive(rig, car, circle(40, 22), 60, 4, {
        after: (t) => {
          if (t < 1) return;
          car.target.anchors[mode].getWorldPosition(wp);
          car.target.anchors[mode].getWorldQuaternion(wq);
          expect(rig.camera.position.distanceTo(wp)).toBeLessThan(0.02);
          expect(quatAngle(rig.camera.quaternion, wq.multiply(face))).toBeLessThan(0.1 * DEG);
        },
      });
      expect(rig.camera.near).toBe(0.12);
    }
  });

  it('the mount filter absorbs high-frequency body jitter', () => {
    const car = makeCar();
    const rig = createCameraRig(null, []);
    rig.setShake(0);
    rig.setMode('hood');
    const ys: number[] = [];
    const ay: number[] = [];
    const camPitch: number[] = [];
    const bodyPitch: number[] = [];
    const wp = new Vector3();
    drive(rig, car, straight(30), 144, 3, {
      before: (t, o, c) => {
        // 25 Hz, ±1 cm heave + ±0.3° pitch buzz on the body
        o.p.y = CG_H + 0.01 * Math.sin(2 * Math.PI * 25 * t);
        o.pitch = 0.3 * DEG * Math.sin(2 * Math.PI * 25 * t + 1);
        applyPose(c, o);
      },
      after: (t) => {
        if (t < 1) return;
        ys.push(rig.camera.position.y);
        car.target.anchors.hood.getWorldPosition(wp);
        ay.push(wp.y);
        camPitch.push(Math.asin(forwardOf(rig).y));
        bodyPitch.push(Math.asin(carAxes(car).F.y));
      },
    });
    const amp = (a: number[]) => Math.max(...a) - Math.min(...a);
    expect(amp(ys)).toBeLessThan(0.55 * amp(ay));
    expect(amp(ys)).toBeGreaterThan(0.05 * amp(ay)); // filtered, not frozen
    expect(amp(camPitch)).toBeLessThan(0.55 * amp(bodyPitch));
    expect(amp(camPitch)).toBeGreaterThan(0.05 * amp(bodyPitch));
  });

  it('cockpit: near plane 0.05, interior FOV, head moves against the G-force', () => {
    const car = makeCar();
    const rig = createCameraRig(null, []);
    rig.setShake(0);
    rig.setFov(62);
    rig.setMode('cockpit');
    drive(rig, car, straight(10), 60, 1);
    expect(rig.camera.near).toBe(0.05);
    expect(rig.camera.fov).toBeGreaterThanOrEqual(62 + TUNING.interiorFovDeg);
    expect(rig.camera.fov).toBeLessThan(62 + TUNING.interiorFovDeg + 0.2);
    const eye = new Vector3();
    const local = () => {
      car.target.anchors.cockpit.getWorldPosition(eye);
      return rig.camera.position.clone().sub(eye).applyQuaternion(car.state.quaternion.clone().invert());
    };
    const atRest = local();
    // hard braking: head pitches forward a few cm
    drive(rig, car, straight(10), 60, 1, { t0: 1, before: (_t, _o, c) => c.state.localAccel.set(0, 0, -14) });
    const braking = local();
    expect(braking.z - atRest.z).toBeGreaterThan(0.03);
    expect(braking.z - atRest.z).toBeLessThan(TUNING.headMaxLong + 0.01);
    // left-hander: head goes right (toward the outside)
    drive(rig, car, straight(10), 60, 1, { t0: 2, before: (_t, _o, c) => c.state.localAccel.set(12, 0, 0) });
    expect(local().x - atRest.x).toBeLessThan(-0.03);
    // back to an exterior camera restores the near plane
    rig.setMode('chase');
    drive(rig, car, straight(10), 60, 0.1, { t0: 3 });
    expect(rig.camera.near).toBe(0.12);
  });

  it('cockpit looks into corners (≤ 12°) and steadies 30% of the roll', () => {
    const car = makeCar();
    const rig = createCameraRig(null, []);
    rig.setShake(0);
    rig.setMode('cockpit');
    drive(rig, car, circle(35, 18), 60, 3, { before: (_t, _o, c) => (c.state.steer = -0.5) });
    const f = forwardOf(rig).applyQuaternion(car.state.quaternion.clone().invert());
    const lookYaw = Math.atan2(f.x, f.z);
    expect(lookYaw).toBeGreaterThan(3 * DEG); // looks left, into the left-hander
    expect(lookYaw).toBeLessThan(TUNING.cornerLookMax + 0.5 * DEG);

    const car2 = makeCar();
    const rig2 = createCameraRig(null, []);
    rig2.setShake(0);
    rig2.setMode('cockpit');
    drive(rig2, car2, straight(0), 60, 1, { before: (_t, o, c) => { o.roll = 10 * DEG; applyPose(c, o); } });
    expect(rollOf(rig2)).toBeCloseTo(-10 * DEG * (1 - TUNING.rollCompensation), 2);
  });

  it('look.back: cockpit turns the head round smoothly; hood/bumper cut to a rear camera', () => {
    const car = makeCar();
    const rig = createCameraRig(null, []);
    rig.setShake(0);
    rig.setMode('cockpit');
    drive(rig, car, straight(20), 60, 1);
    let prevQ = rig.camera.quaternion.clone();
    let maxStep = 0;
    drive(rig, car, straight(20), 60, 0.6, {
      t0: 1,
      look: () => ({ x: 0, y: 0, back: true }),
      after: () => {
        maxStep = Math.max(maxStep, quatAngle(prevQ, rig.camera.quaternion));
        prevQ = rig.camera.quaternion.clone();
      },
    });
    const { F } = carAxes(car);
    expect(forwardOf(rig).dot(F)).toBeLessThan(-0.85);
    expect(maxStep).toBeLessThan(25 * DEG);

    for (const mode of ['hood', 'bumper'] as const) {
      rig.setMode(mode);
      drive(rig, car, straight(20), 60, 0.3, { t0: 2, look: () => ({ x: 0, y: 0, back: true }) });
      const off = rig.camera.position.clone().sub(car.state.position);
      expect(off.dot(F)).toBeLessThan(-2); // behind the tail
      expect(forwardOf(rig).dot(F)).toBeLessThan(-0.95);
      drive(rig, car, straight(20), 60, 0.3, { t0: 2.3 });
      expect(forwardOf(rig).dot(F)).toBeGreaterThan(0.95);
    }
  });
});

describe('orbit', () => {
  it('stick orbits at ~2.2 rad/s, pitch clamps to −8°…+75°, no auto-return while slow', () => {
    const car = makeCar();
    const rig = createCameraRig(fakeTrack().track, []);
    rig.setShake(0);
    rig.setMode('orbit');
    drive(rig, car, straight(0), 60, 0.5);
    const az = () => {
      const off = rig.camera.position.clone().sub(car.state.position);
      return Math.atan2(off.x, off.z);
    };
    const a0 = az();
    drive(rig, car, straight(0), 60, 0.5, { t0: 0.5, look: () => ({ x: 1, y: 0, back: false }) });
    const swept = wrapPi(az() - a0);
    expect(swept).toBeLessThan(-0.8); // stick right = view turns right = camera azimuth decreases
    expect(swept).toBeGreaterThan(-1.15);
    // keeps the angle after release (no auto-return when slow); only the 0.08 s input easing's tail moves it
    drive(rig, car, straight(0), 60, 0.5, { t0: 1 });
    const a1 = az();
    drive(rig, car, straight(0), 60, 6, { t0: 1.5 });
    expect(Math.abs(wrapPi(az() - a1))).toBeLessThan(0.002);
    // stick down = look down: camera climbs to the +75° limit
    drive(rig, car, straight(0), 60, 2, { t0: 7, look: () => ({ x: 0, y: -1, back: false }) });
    const off = rig.camera.position.clone().sub(car.state.position);
    const pivot = car.state.position.y + 0.35 * (1.22 - CG_H);
    const elev = Math.atan2(rig.camera.position.y - pivot, Math.hypot(off.x, off.z));
    expect(elev).toBeCloseTo(TUNING.orbitElevMax, 2);
    // stick up = look up: camera dives to −8°, but stays 0.35 m above the (fake) ground
    drive(rig, car, straight(0), 60, 3, { t0: 9, look: () => ({ x: 0, y: 1, back: false }) });
    expect(rig.camera.position.y).toBeGreaterThan(TUNING.groundClearance - 0.01);
    expect(rig.camera.position.y).toBeLessThan(0.5);
  });

  it('drifts back behind the car after ~4 s idle above 5 m/s, following its heading', () => {
    const car = makeCar();
    const rig = createCameraRig(null, []);
    rig.setShake(0);
    rig.setMode('orbit');
    drive(rig, car, circle(80, 20), 60, 30);
    const { F } = carAxes(car);
    const off = rig.camera.position.clone().sub(car.state.position).normalize();
    expect(off.dot(F)).toBeLessThan(-0.85);
    const d = rig.camera.position.distanceTo(car.state.position);
    expect(d).toBeGreaterThan(6);
    expect(d).toBeLessThan(8.5);
  });
});

describe('track constraints', () => {
  it('pushes the camera back inside the barrier when the car is next to it (not when the car is outside)', () => {
    const wall = 10;
    const look = () => ({ x: 1, y: 0, back: false }); // view right = camera swings out to the left wall
    const ys: number[] = [];
    const run = (track: TrackRuntime | null, carX: number) => {
      const rig = createCameraRig(track, []);
      rig.setShake(0);
      const car = makeCar();
      drive(rig, car, straight(10, 0, carX), 60, 3, { look, after: () => ys.push(rig.camera.position.y) });
      return rig.camera.position.x;
    };
    const free = run(null, 8.5);
    expect(free).toBeGreaterThan(wall + 2); // without a track it would be beyond the barrier
    const clamped = run(fakeTrack(5000, wall).track, 8.5);
    expect(clamped).toBeLessThan(wall + TUNING.wallMargin + 0.02);
    // pit lane / outside the barrier: no interference
    const outside = run(fakeTrack(5000, wall).track, 14);
    expect(outside).toBeGreaterThan(14 + 3);
    expect(Math.min(...ys)).toBeGreaterThan(TUNING.groundClearance - 0.01);
  });

  it('reuses query hints (only the first queries per channel start without one)', () => {
    const { track, hints } = fakeTrack();
    const rig = createCameraRig(track, []);
    const car = makeCar();
    drive(rig, car, wiggle, 60, 3);
    expect(hints.length).toBeGreaterThan(400);
    expect(hints.filter((h) => h < 0).length).toBeLessThanOrEqual(3);
  });
});

describe('robustness', () => {
  for (const withTrack of [false, true]) {
    it(`every mode works ${withTrack ? 'with a fake track + TV cameras' : 'with track = null'}`, () => {
      for (const mode of CAMERA_MODES) {
        const rig = createCameraRig(withTrack ? fakeTrack().track : null, withTrack ? tvCams(0, 3000, 120) : []);
        rig.setShake(1);
        rig.setMode(mode);
        const car = makeCar();
        drive(rig, car, wiggle, 60, 4, {
          look: (t) => ({ x: Math.sin(t * 1.3), y: Math.cos(t * 0.7), back: t > 2 && t < 2.5 }),
          after: () => {
            expect(camOk(rig)).toBe(true);
            const d = rig.camera.position.distanceTo(car.state.position);
            expect(d).toBeLessThan(mode === 'tv' && withTrack ? 300 : 25);
            if (mode !== 'tv') expect(d).toBeGreaterThan(mode === 'cockpit' || mode === 'hood' || mode === 'bumper' ? 0.1 : 2);
          },
        });
      }
    });
  }

  it('never produces NaN: zero velocity, upside down, nose-up, airborne, teleports, bad dt, NaN state', () => {
    for (const mode of CAMERA_MODES) {
      const rig = createCameraRig(fakeTrack().track, tvCams(0, 3000, 150));
      rig.setShake(1);
      rig.setMode(mode);
      const car = makeCar();
      const o = newPose();
      const step = (dt: number, l: Look = NO_LOOK) => {
        applyPose(car, o);
        rig.update(dt, car.target, l);
        expect(camOk(rig)).toBe(true);
      };
      // at rest
      for (let i = 0; i < 30; i++) step(1 / 60);
      // upside down, airborne, falling
      o.roll = Math.PI;
      o.airborne = true;
      o.v.set(0, -3, 0);
      for (let i = 0; i < 30; i++) step(1 / 60, { x: 1, y: -1, back: true });
      // nose straight up, then down
      o.roll = 0;
      o.pitch = -Math.PI / 2;
      o.v.set(0, 5, 0);
      for (let i = 0; i < 30; i++) step(1 / 60);
      o.pitch = Math.PI / 2;
      o.v.set(0, -5, 0);
      for (let i = 0; i < 30; i++) step(1 / 60);
      // tumbling + teleports every few frames
      o.airborne = false;
      for (let i = 0; i < 60; i++) {
        o.pitch = i * 0.3;
        o.roll = i * 0.17;
        o.yaw = i * 0.9;
        if (i % 7 === 0) o.p.set(((i * 997) % 2000) - 1000, CG_H, (i * 389) % 3000);
        o.v.set(Math.sin(i) * 40, 0, Math.cos(i) * 40);
        step(1 / 60);
      }
      // silly dt values
      for (const dt of [0, -1, NaN, 1e-9, 5]) step(dt);
      // a NaN vehicle state: the camera keeps its last good pose
      const before = pose(rig);
      car.state.position.set(NaN, 0, 0);
      rig.update(1 / 60, car.target, NO_LOOK);
      expect(camOk(rig)).toBe(true);
      expect(rig.camera.position.equals(before.p)).toBe(true);
      // and recovers with a hard cut
      step(1 / 60);
    }
  });

  it('works before the car visual posed its anchors (still at rest at the origin)', () => {
    const o = newPose();
    for (const mode of ['chase', 'hood', 'bumper', 'cockpit'] as const) {
      const rig = createCameraRig(null, []);
      rig.setShake(0);
      rig.setMode(mode);
      const car = makeCar();
      straight(0, 300, 500, 70)(0, o);
      applyPose(car, o, false); // root (and anchors) never moved: they sit at the origin
      rig.update(1 / 60, car.target, NO_LOOK);
      expect(camOk(rig)).toBe(true);
      const { F } = carAxes(car);
      const off = rig.camera.position.clone().sub(car.state.position);
      if (mode === 'chase') {
        expect(off.length()).toBeGreaterThan(4);
        expect(off.length()).toBeLessThan(8);
        expect(off.dot(F)).toBeLessThan(-4);
      } else {
        expect(off.length()).toBeLessThan(3);
        expect(forwardOf(rig).dot(F)).toBeGreaterThan(0.95);
      }
    }
  });

  it('update() is written allocation-free (no `new`, closures or Math.random in the rig methods)', () => {
    const src = readFileSync(new URL('../src/render/cameraRig.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const start = src.indexOf('class CameraRigImpl');
    const end = src.indexOf('export function createCameraRig');
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, end).split('\n');
    const ctor = body.findIndex((l) => l.includes('constructor('));
    const ctorEnd = body.findIndex((l, i) => i > ctor && /^ {2}\}/.test(l));
    body.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (i >= ctor && i <= ctorEnd) return; // the constructor may allocate
      if (/\bnew\s+[A-Z]/.test(code)) expect(code).toMatch(/^\s*(private |readonly )+\w+(: [\w<>]+)? = /); // field initialisers only
      expect(code).not.toMatch(/=>/);
      expect(code).not.toMatch(/Math\.random/);
    });
    expect(src).not.toMatch(/Math\.random/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/** Max |second difference| of positions (as m/s²) and of the rotation rate (rad/s²). */
function secondDifferences(ps: Vector3[], qs: Quaternion[], h: number): { aMax: number; alphaMax: number } {
  let aMax = 0;
  for (let i = 1; i + 1 < ps.length; i++) {
    const a = ps[i + 1].clone().sub(ps[i].clone().multiplyScalar(2)).add(ps[i - 1]).length() / (h * h);
    aMax = Math.max(aMax, a);
  }
  const rate = (a: Quaternion, b: Quaternion): Vector3 => {
    const d = a.clone().invert().multiply(b);
    if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
    const s = Math.hypot(d.x, d.y, d.z);
    const ang = 2 * Math.atan2(s, d.w);
    return s > 1e-12 ? new Vector3(d.x, d.y, d.z).multiplyScalar(ang / s / h) : new Vector3();
  };
  let alphaMax = 0;
  for (let i = 1; i + 1 < qs.length; i++) {
    const w0 = rate(qs[i - 1], qs[i]);
    const w1 = rate(qs[i], qs[i + 1]);
    alphaMax = Math.max(alphaMax, w1.sub(w0).length() / h);
  }
  return { aMax, alphaMax };
}
