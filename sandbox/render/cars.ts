/**
 * Sandbox cars (owner: render): box-built placeholder car visuals with camera anchors, and a
 * synthetic VehicleState generator (circles, figure eights, donuts, wall scrapes) so the effects and
 * the camera rig can be exercised without the physics engine.
 */
import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  Matrix4,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { bodyCgZ, type CarDefinition, type GroundSample, type TrackFrame, type TrackRuntime, type VehicleState, type WheelState } from '../../src/core/contracts';

export interface Anchors {
  hood: Object3D;
  bumper: Object3D;
  cockpit: Object3D;
  chase: Object3D;
}

export class PlaceholderCar {
  readonly root = new Group();
  readonly anchors: Anchors;
  private readonly wheelMeshes: Mesh[] = [];
  private readonly origin = new Vector3();
  private readonly offset = new Vector3();

  constructor(readonly def: CarDefinition, color = '#c22') {
    const v = def.visual;
    this.root.name = `car.${def.id}`;
    const paint = new MeshPhysicalMaterial({
      color,
      metalness: 0.55,
      roughness: 0.32,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
    });
    const dark = new MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.35, metalness: 0.2 });
    const tire = new MeshStandardMaterial({ color: 0x111113, roughness: 0.9 });
    const rim = new MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.3, metalness: 0.9 });

    const bodyH = v.height * 0.52;
    const body = new Mesh(new BoxGeometry(v.width, bodyH, v.length), paint);
    const zc = (v.wheelbase + 2 * v.frontOverhang - v.length) / 2;
    body.position.set(0, v.rideHeight + bodyH / 2, zc);
    body.castShadow = true;
    body.receiveShadow = true;
    this.root.add(body);

    const cabinH = v.height - v.rideHeight - bodyH;
    const cabin = new Mesh(new BoxGeometry(v.width * 0.82, cabinH, v.length * 0.42), dark);
    cabin.position.set(0, v.rideHeight + bodyH + cabinH / 2, zc - v.length * 0.06);
    cabin.castShadow = true;
    this.root.add(cabin);

    const nose = new Mesh(new SphereGeometry(0.5, 12, 8), paint);
    nose.scale.set(v.width / 1.0, 0.18, 0.7);
    nose.position.set(0, v.rideHeight + bodyH * 0.8, zc + v.length * 0.5 - 0.3);
    nose.castShadow = true;
    this.root.add(nose);

    if (v.wing > 0.1) {
      const wing = new Mesh(new BoxGeometry(v.width * 0.95, 0.04, 0.32 + v.wing * 0.2), dark);
      wing.position.set(0, v.height * (0.82 + v.wing * 0.12), zc - v.length * 0.5 + 0.2);
      wing.castShadow = true;
      this.root.add(wing);
      for (const s of [-1, 1]) {
        const strut = new Mesh(new BoxGeometry(0.04, v.height * 0.3, 0.2), dark);
        strut.position.set(s * v.width * 0.3, v.height * 0.7, wing.position.z);
        strut.castShadow = true;
        this.root.add(strut);
      }
    }

    const half = v.wheelbase / 2;
    const wheelPos = [
      [v.trackFront / 2, v.wheelRadiusFront, half, v.wheelRadiusFront, v.tireWidthFront],
      [-v.trackFront / 2, v.wheelRadiusFront, half, v.wheelRadiusFront, v.tireWidthFront],
      [v.trackRear / 2, v.wheelRadiusRear, -half, v.wheelRadiusRear, v.tireWidthRear],
      [-v.trackRear / 2, v.wheelRadiusRear, -half, v.wheelRadiusRear, v.tireWidthRear],
    ];
    for (const [x, y, z, r, w] of wheelPos) {
      const holder = new Group();
      holder.position.set(x, y, z);
      const tireMesh = new Mesh(new CylinderGeometry(r, r, w, 24), tire);
      tireMesh.rotation.z = Math.PI / 2;
      tireMesh.castShadow = true;
      tireMesh.receiveShadow = true;
      const rimMesh = new Mesh(new CylinderGeometry(r * 0.66, r * 0.66, w + 0.01, 16), rim);
      rimMesh.rotation.z = Math.PI / 2;
      const spin = new Group();
      spin.add(tireMesh, rimMesh);
      holder.add(spin);
      this.root.add(holder);
      this.wheelMeshes.push(spin as unknown as Mesh);
      (spin as Group).userData.holder = holder;
    }

    const hood = new Object3D();
    hood.position.set(0, v.height * 0.62, v.wheelbase / 2 + v.frontOverhang - 1.0);
    const bumper = new Object3D();
    bumper.position.set(0, 0.55, v.wheelbase / 2 + v.frontOverhang + 0.04);
    const cockpit = new Object3D();
    cockpit.position.set(v.seat.x, v.seat.y + 0.72, v.seat.z + 0.1);
    const chase = new Object3D();
    chase.position.set(0, v.height + 1.5, -(v.length / 2 + 5.2));
    this.root.add(hood, bumper, cockpit, chase);
    this.anchors = { hood, bumper, cockpit, chase };
  }

  /** Pose the visual from a vehicle state (chassis, steering, wheel spin). */
  update(state: VehicleState): void {
    const v = this.def.visual;
    // body origin = CG - q * (0, cgHeight, bodyCgZ)
    this.offset.set(0, v.cgHeight, bodyCgZ(v)).applyQuaternion(state.quaternion);
    this.root.position.copy(state.position).sub(this.offset);
    this.root.quaternion.copy(state.quaternion);
    for (let i = 0; i < 4; i++) {
      const w = state.wheels[i];
      const spin = this.wheelMeshes[i] as unknown as Group;
      const holder = spin.userData.holder as Group;
      holder.rotation.y = w.steerAngle;
      // compression -> ride height change (approx)
      holder.position.y = (i < 2 ? v.wheelRadiusFront : v.wheelRadiusRear) + (0.5 - w.compression) * 0.04;
      spin.rotation.x = w.spin;
    }
    this.root.updateMatrixWorld(true);
  }
}

export function makeWheel(): WheelState {
  return {
    hub: new Vector3(),
    contactPoint: new Vector3(),
    contactNormal: new Vector3(0, 1, 0),
    steerAngle: 0,
    spin: 0,
    omega: 0,
    radius: 0.34,
    width: 0.28,
    compression: 0.5,
    suspensionVelocity: 0,
    contact: true,
    surface: 'asphalt',
    load: 4000,
    slipRatio: 0,
    slipAngle: 0,
    forceLong: 0,
    forceLat: 0,
    skid: 0,
    tempC: 80,
    brakeTempC: 200,
  };
}

export function makeState(id: number): VehicleState {
  return {
    id,
    position: new Vector3(),
    quaternion: new Quaternion(),
    velocity: new Vector3(),
    angularVelocity: new Vector3(),
    speed: 0,
    forwardSpeed: 0,
    localAccel: new Vector3(),
    steer: 0,
    throttle: 0,
    throttlePedal: 0,
    brake: 0,
    handbrake: 0,
    clutch: 0,
    rpm: 3000,
    idleRpm: 900,
    redlineRpm: 7800,
    limiterRpm: 8000,
    gear: 3,
    gearCount: 7,
    engineLoad: 0.5,
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

export type Pattern = 'circle' | 'drift' | 'eight' | 'donut' | 'wall' | 'cruise' | 'launch' | 'ring' | 'static' | 'lap';

const Y = new Vector3(0, 1, 0);
const _q = new Quaternion();
const _v = new Vector3();
const _m = new Matrix4();
const _q2 = new Quaternion();
const _n = new Vector3();
const _f = new Vector3();

/** Kinematic synthetic driver producing a plausible VehicleState. */
export class SyntheticCar {
  readonly state: VehicleState;
  private heading = 0; // velocity heading, rad, from +Z toward +X; left turn = increasing
  private slip = 0;
  private x = 0;
  private z = 0;
  private speed = 0;
  private time = 0;
  private dir = 1;
  private radius = 30;
  private cx = 0;
  private cz = 0;
  private backfireClock = 0;
  private impactClock = 0;
  private ringAngle = 0;
  private spinAcc = [0, 0, 0, 0];
  private yawRate = 0;
  private prevHeading = 0;
  private prevSpeed = 0;
  surfaceOverride: WheelState['surface'] | null = null;
  private readonly track: TrackRuntime | null;
  private s = 0;
  private d = 0;
  private readonly frame: TrackFrame = {
    position: new Vector3(), tangent: new Vector3(), normal: new Vector3(), left: new Vector3(),
    widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, curvature: 0, bank: 0,
  };
  private readonly gs: GroundSample = { height: 0, normal: new Vector3(0, 1, 0), surface: 'asphalt' };
  /** Body yaw about world +Y (from the chassis forward axis), rad. */
  get yaw(): number {
    _f.set(0, 0, 1).applyQuaternion(this.state.quaternion);
    return Math.atan2(_f.x, _f.z);
  }

  constructor(
    readonly id: number,
    readonly def: CarDefinition,
    readonly pattern: Pattern,
    opts: { x?: number; z?: number; heading?: number; speed?: number; radius?: number; dir?: number; phase?: number; track?: TrackRuntime; s?: number; d?: number } = {},
  ) {
    this.state = makeState(id);
    this.track = opts.track ?? null;
    this.s = opts.s ?? 0;
    this.d = opts.d ?? 0;
    this.x = opts.x ?? 0;
    this.z = opts.z ?? 0;
    this.heading = opts.heading ?? 0;
    this.speed = opts.speed ?? 20;
    this.radius = opts.radius ?? 30;
    this.dir = opts.dir ?? 1;
    this.time = opts.phase ?? 0;
    this.cx = this.x;
    this.cz = this.z;
    if (pattern === 'circle' || pattern === 'drift' || pattern === 'donut') {
      // start on the circle: centre is to the left (dir=1) of travel
      this.cx = this.x + Math.cos(this.heading) * this.radius * this.dir;
      this.cz = this.z - Math.sin(this.heading) * this.radius * this.dir;
    }
    this.prevHeading = this.heading;
    this.prevSpeed = this.speed;
  }

  step(dt: number): void {
    const s = this.state;
    const v = this.def.visual;
    this.time += dt;
    let targetSlip = 0;
    let rearSkid = 0;
    let frontSkid = 0;
    let steer = 0;
    let throttle = 0.5;
    let brake = 0;
    s.scrape = 0;
    let speed = this.speed;
    let turn = 0; // heading rate

    switch (this.pattern) {
      case 'cruise': {
        speed = this.speed;
        turn = 0;
        break;
      }
      case 'launch': {
        // standing-start burnout then accelerate
        const t = this.time % 7;
        if (t < 2.2) {
          speed = 3 + t * 2;
          rearSkid = 1;
          frontSkid = 0;
          throttle = 1;
        } else {
          speed = 7 + (t - 2.2) * 10;
          rearSkid = Math.max(0, 0.8 - (t - 2.2) * 0.5);
          throttle = 1;
        }
        break;
      }
      case 'circle': {
        speed = this.speed;
        turn = (speed / this.radius) * this.dir;
        steer = -this.dir * 0.35;
        frontSkid = 0.15;
        rearSkid = 0.1;
        break;
      }
      case 'drift': {
        speed = this.speed;
        turn = (speed / this.radius) * this.dir;
        targetSlip = this.dir * 0.52;
        rearSkid = 1;
        frontSkid = 0.55;
        steer = this.dir * 0.4; // counter-steer
        throttle = 0.9;
        break;
      }
      case 'eight': {
        const period = 2 * Math.PI * this.radius / this.speed * 0.55;
        if (Math.floor(this.time / period) % 2 === 0) this.dir = 1;
        else this.dir = -1;
        speed = this.speed;
        turn = (speed / this.radius) * this.dir;
        targetSlip = this.dir * 0.34;
        rearSkid = 0.85;
        frontSkid = 0.35;
        steer = this.dir * 0.3;
        break;
      }
      case 'donut': {
        speed = this.speed;
        turn = (speed / this.radius) * this.dir;
        targetSlip = this.dir * 1.05;
        rearSkid = 1;
        frontSkid = 0.9;
        steer = this.dir * 0.8;
        throttle = 1;
        break;
      }
      case 'wall': {
        // run along +X with the left side scraping a wall for a few seconds, repeating
        const cycle = 5;
        const t = this.time % cycle;
        turn = 0;
        speed = this.speed;
        if (t > 1 && t < 3.6) {
          s.scrape = 0.85;
          // scrape point: middle of the left flank, a little above the ground
          s.scrapePoint.set(this.x + Math.cos(this.heading) * (v.width / 2), 0.35, this.z - Math.sin(this.heading) * (v.width / 2));
          rearSkid = 0.2;
          frontSkid = 0.2;
        }
        if (t > 1 && t - dt <= 1) {
          s.impactCount++;
          s.lastImpact.strength = 0.8;
          s.lastImpact.kind = 'wall';
          s.lastImpact.point.set(this.x - v.width / 2, 0.5, this.z);
          s.lastImpact.normal.set(0, 0, -1);
        }
        break;
      }
      case 'ring': {
        // follow the sandbox ring road
        const R = 140;
        speed = this.speed;
        this.ringAngle += (speed / R) * dt;
        turn = 0;
        break;
      }
      case 'static':
        speed = 0;
        break;
    }

    if (this.pattern === 'lap' && this.track) {
      this.stepLap(dt);
      return;
    }

    // integrate
    this.slip += (targetSlip - this.slip) * Math.min(1, dt * 4);
    if (this.pattern === 'ring') {
      const R = 140;
      this.x = Math.cos(this.ringAngle) * R;
      this.z = Math.sin(this.ringAngle) * R;
      this.heading = Math.atan2(-Math.sin(this.ringAngle), Math.cos(this.ringAngle));
      // heading from velocity direction (-sin, cos) => atan2(x=-sin, z=cos)
      this.heading = Math.atan2(-Math.sin(this.ringAngle), Math.cos(this.ringAngle));
    } else if (this.pattern === 'donut') {
      // stay on a fixed small circle
      this.heading += turn * dt;
      this.x = this.cx - Math.cos(this.heading) * this.radius * this.dir;
      this.z = this.cz + Math.sin(this.heading) * this.radius * this.dir;
    } else {
      this.heading += turn * dt;
      this.x += Math.sin(this.heading) * speed * dt;
      this.z += Math.cos(this.heading) * speed * dt;
      if (this.pattern === 'wall') {
        // loop the run so it stays inside the pad
        if (this.x > 40) this.x = -40;
      }
      if (this.pattern === 'launch') {
        if (this.z > 40) this.z = -40;
      }
    }
    this.yawRate = (this.heading - this.prevHeading) / Math.max(dt, 1e-6);
    this.prevHeading = this.heading;

    const yaw = this.heading + this.slip;
    s.position.set(this.x, v.cgHeight + 0.0, this.z);
    s.quaternion.setFromAxisAngle(Y, yaw);
    // small body roll/pitch from lateral/long accel
    const latAcc = speed * Math.max(-1e3, Math.min(1e3, this.yawRate));
    const longAcc = (speed - this.prevSpeed) / Math.max(dt, 1e-6);
    this.prevSpeed = speed;
    _q.setFromAxisAngle(_v.set(0, 0, 1), -latAcc * 0.0016);
    s.quaternion.multiply(_q);
    _q.setFromAxisAngle(_v.set(1, 0, 0), -longAcc * 0.0012);
    s.quaternion.multiply(_q);

    s.velocity.set(Math.sin(this.heading) * speed, 0, Math.cos(this.heading) * speed);
    s.speed = speed;
    s.forwardSpeed = speed * Math.cos(this.slip);
    s.angularVelocity.set(0, this.yawRate, 0);
    s.localAccel.set(latAcc * (this.pattern === 'static' ? 0 : 1) * -1, 0, longAcc);
    s.steer = steer;
    s.throttle = throttle;
    s.brake = brake;

    // wheels
    const half = v.wheelbase / 2;
    const pos = [
      [v.trackFront / 2, half],
      [-v.trackFront / 2, half],
      [v.trackRear / 2, -half],
      [-v.trackRear / 2, -half],
    ];
    const skids = [frontSkid, frontSkid, rearSkid, rearSkid];
    // yaw-only frame for wheel positions
    _q.setFromAxisAngle(Y, yaw);
    for (let i = 0; i < 4; i++) {
      const w = s.wheels[i];
      _v.set(pos[i][0], 0, pos[i][1]).applyQuaternion(_q);
      w.contactPoint.set(this.x + _v.x, 0.0, this.z + _v.z);
      const radius = i < 2 ? v.wheelRadiusFront : v.wheelRadiusRear;
      w.hub.set(w.contactPoint.x, radius, w.contactPoint.z);
      w.contactNormal.set(0, 1, 0);
      w.radius = radius;
      w.width = i < 2 ? v.tireWidthFront : v.tireWidthRear;
      w.steerAngle = i < 2 ? -steer * 0.4 : 0;
      this.spinAcc[i] += ((rearSkid > 0.5 && i >= 2 ? speed * 1.6 + 20 : speed) / radius) * dt;
      w.spin = this.spinAcc[i];
      w.omega = (speed / radius) * 1;
      w.skid = skids[i] * (speed > 0.5 || this.pattern === 'launch' ? 1 : 0);
      w.surface = this.surfaceOverride ?? (Math.abs(this.x) < 46 && Math.abs(this.z) < 46 ? 'asphalt' : Math.abs(Math.hypot(this.x, this.z) - 140) < 9 ? 'asphalt' : 'grass');
      w.contact = true;
      w.compression = 0.5 + latAcc * 0.0006 * (i % 2 === 0 ? -1 : 1);
      w.suspensionVelocity = 0;
      w.slipAngle = this.slip * 0.8;
      w.slipRatio = i >= 2 && rearSkid > 0.5 ? 0.4 : 0.02;
    }

    // backfires on lift
    this.backfireClock += dt;
    if (this.pattern === 'cruise' || this.pattern === 'launch' || this.pattern === 'drift' || this.pattern === 'ring') {
      if (this.backfireClock > 1.3) {
        this.backfireClock = 0;
        s.backfireCount++;
      }
    }
    // occasional hard impact for debris testing
    this.impactClock += dt;
    s.rpm = 3000 + speed * 90;
    s.gear = 3;
  }

  /** Drive the real track centreline with slip proportional to cornering demand. */
  private stepLap(dt: number): void {
    const tr = this.track!;
    const s = this.state;
    const v = this.def.visual;
    const speed = this.speed;
    this.s = tr.wrapS(this.s + speed * dt);
    tr.frameAt(this.s, this.frame);
    const fr = this.frame;
    const kappa = fr.curvature;
    const lat = speed * speed * kappa;
    const demand = Math.min(1, Math.max(0, (Math.abs(lat) - 9) / 14));
    const target = Math.sign(kappa) * demand * 0.38;
    this.slip += (target - this.slip) * Math.min(1, dt * 3);
    const skidRear = Math.min(1, Math.abs(this.slip) / 0.12);
    const skidFront = skidRear * 0.35;

    // chassis frame: x = left, y = normal, z = tangent, then yaw by the slip angle about the normal
    _m.makeBasis(fr.left, fr.normal, fr.tangent);
    s.quaternion.setFromRotationMatrix(_m);
    _q2.setFromAxisAngle(Y, this.slip);
    s.quaternion.multiply(_q2);
    s.position.copy(fr.position).addScaledVector(fr.left, this.d).addScaledVector(fr.normal, v.cgHeight);
    s.velocity.copy(fr.tangent).multiplyScalar(speed);
    s.speed = speed;
    s.forwardSpeed = speed * Math.cos(this.slip);
    s.angularVelocity.copy(fr.normal).multiplyScalar(speed * kappa);
    this.yawRate = speed * kappa;
    s.localAccel.set(lat * Math.cos(this.slip), 0, 0.5);
    s.steer = -Math.sign(kappa) * demand * 0.3;
    s.throttle = 0.8;
    s.brake = 0;
    s.scrape = 0;

    const half = v.wheelbase / 2;
    const pos = [
      [v.trackFront / 2, half],
      [-v.trackFront / 2, half],
      [v.trackRear / 2, -half],
      [-v.trackRear / 2, -half],
    ];
    const skids = [skidFront, skidFront, skidRear, skidRear];
    for (let i = 0; i < 4; i++) {
      const w = s.wheels[i];
      _v.set(pos[i][0], 0, pos[i][1]).applyQuaternion(s.quaternion);
      const wx = s.position.x + _v.x, wz = s.position.z + _v.z;
      tr.groundAt(wx, wz, this.gs);
      w.contactPoint.set(wx, this.gs.height, wz);
      w.contactNormal.copy(this.gs.normal);
      w.surface = this.gs.surface;
      const radius = i < 2 ? v.wheelRadiusFront : v.wheelRadiusRear;
      w.radius = radius;
      w.width = i < 2 ? v.tireWidthFront : v.tireWidthRear;
      w.hub.copy(w.contactPoint).addScaledVector(w.contactNormal, radius);
      w.steerAngle = i < 2 ? s.steer * 0.5 : 0;
      this.spinAcc[i] += ((skids[i] > 0.5 ? speed * 1.3 : speed) / radius) * dt;
      w.spin = this.spinAcc[i];
      w.omega = speed / radius;
      w.skid = skids[i];
      w.contact = true;
      w.compression = 0.5 + lat * 0.0005 * (i % 2 === 0 ? -1 : 1);
      w.slipAngle = this.slip * 0.8;
      w.slipRatio = skids[i] > 0.5 ? 0.35 : 0.02;
      w.load = 4000;
      w.tempC = 85;
    }
    this.backfireClock += dt;
    if (this.backfireClock > 2.1) {
      this.backfireClock = 0;
      s.backfireCount++;
    }
    s.rpm = 3000 + speed * 90;
  }

  /** Teleport/reset for repeating demos. */
  place(x: number, z: number, heading: number): void {
    this.x = x;
    this.z = z;
    this.heading = heading;
    this.prevHeading = heading;
  }
}
