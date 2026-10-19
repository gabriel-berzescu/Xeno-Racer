/**
 * Driver aids against a slippery surface: ABS must be able to let a locked wheel go again, and the driveline must not
 * be able to lock the driven axle (engine braking, a downshift) where ABS has no say. And all-wheel drive (the Mammoth is the first
 * car to have it): the centre differential, the aids and the driver watching the front axle too.
 * Run: npx vitest run tests/driveline-aids.test.ts
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { AIDriver } from '../src/ai';
import { getCar } from '../src/cars';
import type { Assists, CarDefinition } from '../src/core/contracts';
import { PhysicsWorld, createFlatTrack, type DifferentialSpec } from '../src/physics';
import { awdTractionShare } from '../src/physics/traction';
import { loadTrackRuntime } from '../src/track';

const DT = 1 / 60;

function setup(carId: string, speedKmh: number, gripScale: number) {
  const world = new PhysicsWorld(createFlatTrack());
  const car = world.addVehicle(getCar(carId));
  car.assists = { abs: true, tcs: 'off', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
  car.placeOnGround(new Vector3(0, 0, 0), new Quaternion(), speedKmh / 3.6);
  car.setTemperatures(1);
  car.gripScale = gripScale;
  return { world, car };
}

describe('driver aids on a slippery road', () => {
  it('ABS lets a locked wheel go again when the surface cannot carry the minimum brake pressure', () => {
    // 0.2 of the vanta's front brake torque (660 Nm) is more than a wheel on a very slippery surface can transmit:
    // an ABS that stops at 20 % pressure leaves it locked for the whole stop
    const { world, car } = setup('vanta-gt', 110, 0.25);
    world.simulate(0.3);
    car.controls.brake = 1;
    let locked = 0;
    let samples = 0;
    for (let i = 0; i < 90; i++) {
      world.step(DT);
      if (i < 15) continue; // the first quarter second may lock
      samples++;
      if (car.state.speed > 8 && car.state.wheels[0].slipRatio < -0.85) locked++;
    }
    expect(samples).toBeGreaterThan(50);
    expect(locked / samples).toBeLessThan(0.1);
  });

  it('a clumsy downshift cannot lock the driven axle on a wet road', () => {
    // 4th to 2nd at 120 km/h with the revs far too low: the clutch has to spin the engine up through the rear tyres.
    // Without a limit on the back-torque it drags them to a slip ratio of -0.3 (nearly three times the peak) for half a second
    const { world, car } = setup('vanta-gt', 120, 0.4);
    car.assists.autoShift = false;
    car.gear = 4;
    world.simulate(0.4);
    car.gear = 2;
    let worst = 0;
    for (let i = 0; i < 60; i++) {
      world.step(DT);
      const w = car.state.wheels;
      worst = Math.min(worst, w[2].slipRatio, w[3].slipRatio);
    }
    expect(worst).toBeGreaterThan(-0.2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// All-wheel drive
// ─────────────────────────────────────────────────────────────────────────────

/** The Mammoth with its physics edited: a variant to ask a question of one part of the driveline at a time. */
function mammothWith(edit: (p: CarDefinition['physics']) => void): CarDefinition {
  const def = structuredClone(getCar('mammoth'));
  edit(def.physics);
  return def;
}

const OPEN: DifferentialSpec = { type: 'open', preload: 0, powerLock: 0, coastLock: 0 };
const LOCKED: DifferentialSpec = { type: 'locked', preload: 0, powerLock: 1, coastLock: 1 };
const LSD: DifferentialSpec = { type: 'lsd', preload: 120, powerLock: 0.35, coastLock: 0.2 };

function awdSetup(def: CarDefinition, kmh: number, assists: Partial<Assists> = {}) {
  const world = new PhysicsWorld(createFlatTrack());
  const car = world.addVehicle(def);
  car.assists = { abs: true, tcs: 'off', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true, ...assists };
  car.placeOnGround(new Vector3(0, 0, 0), new Quaternion(), kmh / 3.6);
  car.setTemperatures(1);
  return { world, car };
}

/** Mean tyre force (N) of the front pair and of the rear pair, the front's share of the two, and the mean slip ratio of all four, over `seconds` from now. */
function axleForces(world: PhysicsWorld, car: ReturnType<typeof awdSetup>['car'], seconds: number) {
  let f = 0;
  let r = 0;
  let k = 0;
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    world.step(DT);
    const w = car.state.wheels;
    f += w[0].forceLong + w[1].forceLong;
    r += w[2].forceLong + w[3].forceLong;
    k += (Math.abs(w[0].slipRatio) + Math.abs(w[1].slipRatio) + Math.abs(w[2].slipRatio) + Math.abs(w[3].slipRatio)) / 4;
  }
  return { front: f / n, rear: r / n, slip: k / n, share: f / (f + r) };
}

describe('all-wheel drive: the centre differential', () => {
  it('divides the drive by the front split with an open centre, and towards the grip with a limited-slip one', () => {
    const open = mammothWith((p) => {
      p.drivetrain.centerDiff = { ...OPEN };
      p.drivetrain.diff = { ...OPEN };
    });
    const lsd = mammothWith((p) => {
      p.drivetrain.centerDiff = { ...LSD };
      p.drivetrain.diff = { ...OPEN };
    });
    const share = (def: CarDefinition) => {
      const { world, car } = awdSetup(def, 70);
      car.controls.throttle = 0.45;
      world.simulate(2.5);
      return axleForces(world, car, 0.6);
    };
    const o = share(open);
    const l = share(lsd);
    // an open centre sends 40 % of the torque forward whatever the tyres can use (less what the front wheels' own rolling takes)
    expect(o.share).toBeGreaterThan(0.36);
    expect(o.share).toBeLessThan(0.43);
    // a clutch pack lets the axles turn alike, so each tyre pair gives force in proportion to its load: the front, a little lighter under
    // power than at rest, carries about half
    expect(l.share).toBeGreaterThan(o.share + 0.04);
    expect(l.share).toBeLessThan(0.55);
  });

  it('sends the drive away from an axle that has no grip, a lot more with a limited-slip centre than an open one', () => {
    // (a front tyre of 0.3 grip: the front axle on ice and the rear on asphalt)
    const slipperyFront = (centre: DifferentialSpec) =>
      mammothWith((p) => {
        p.tireFront = { ...p.tireFront, mu: 0.3 };
        p.drivetrain.centerDiff = centre;
      });
    const speedAt = (def: CarDefinition) => {
      const { world, car } = awdSetup(def, 0);
      world.simulate(0.5);
      car.controls.throttle = 1;
      world.simulate(2.5);
      return car.state.forwardSpeed;
    };
    const open = speedAt(slipperyFront({ ...OPEN }));
    const lsd = speedAt(slipperyFront({ ...LSD }));
    const locked = speedAt(slipperyFront({ ...LOCKED }));
    expect(lsd).toBeGreaterThan(open * 1.2);
    expect(locked).toBeGreaterThanOrEqual(lsd * 0.97);
  });

  it('does not wind up on tyres of different sizes: a locked centre rolls as free as an open one', () => {
    // 0.40 m wheels at the front and 0.45 m at the rear turn 12 % apart when the car rolls. A centre that compared the wheels' angular speeds
    // would hold them together for good, at slip ratios of +/-6 % and a force of several kN pulling each axle against the other.
    const sized = (centre: DifferentialSpec) =>
      mammothWith((p) => {
        p.tireFront = { ...p.tireFront, radius: 0.4 };
        p.tireRear = { ...p.tireRear, radius: 0.45 };
        p.drivetrain.centerDiff = centre;
      });
    const run = (def: CarDefinition) => {
      const { world, car } = awdSetup(def, 100);
      car.controls.throttle = 0.12;
      world.simulate(3);
      return axleForces(world, car, 1);
    };
    const open = run(sized({ ...OPEN }));
    const locked = run(sized({ ...LOCKED }));
    const lsd = run(sized({ type: 'lsd', preload: 400, powerLock: 0.6, coastLock: 0.6 }));
    for (const r of [open, locked, lsd]) {
      expect(r.slip).toBeLessThan(0.02);
      expect(Math.abs(r.front)).toBeLessThan(1500);
      expect(Math.abs(r.rear)).toBeLessThan(2500);
    }
    // and the forces are the open centre's, not a fight between the axles
    expect(Math.abs(locked.front - open.front)).toBeLessThan(500);
    expect(Math.abs(locked.rear - open.rear)).toBeLessThan(500);
  });

  it('lets the front wheels roll when the handbrake locks the rear ones, even with a locked centre', () => {
    const locked = mammothWith((p) => {
      p.drivetrain.centerDiff = { ...LOCKED };
      // (a lever that does lock the rear tyres: the Mammoth's own, 2200 Nm, holds them at their peak slip but no further)
      p.brakes.handbrakeTorque = 6000;
    });
    const { world, car } = awdSetup(locked, 80);
    world.simulate(0.4);
    car.controls.handbrake = 1;
    world.simulate(1.2);
    const w = car.state.wheels;
    const v = car.state.forwardSpeed;
    // (the rear wheels are held, the front ones keep turning at the speed of the road)
    expect(v).toBeGreaterThan(8);
    expect(Math.abs(w[2].omega * w[2].radius) / v).toBeLessThan(0.25);
    expect(Math.abs(w[3].omega * w[3].radius) / v).toBeLessThan(0.25);
    expect((w[0].omega * w[0].radius) / v).toBeGreaterThan(0.85);
    expect((w[1].omega * w[1].radius) / v).toBeGreaterThan(0.85);
  });
});

describe('all-wheel drive: the aids and the driver watch the front axle', () => {
  it('traction control trims the throttle for a spinning front axle', () => {
    // (a front tyre of 0.35 grip: the fronts spin long before the rears)
    const iceFront = mammothWith((p) => {
      p.tireFront = { ...p.tireFront, mu: 0.35 };
    });
    const launch = (tcs: Assists['tcs']) => {
      const { world, car } = awdSetup(iceFront, 0, { tcs });
      world.simulate(0.5);
      car.controls.throttle = 1;
      let spin = 0;
      let active = 0;
      for (let i = 0; i < 150; i++) {
        world.step(DT);
        spin = Math.max(spin, car.state.wheels[0].slipRatio, car.state.wheels[1].slipRatio);
        if (car.state.tcsActive) active++;
      }
      return { spin, active, v: car.state.forwardSpeed };
    };
    const off = launch('off');
    const on = launch('low');
    expect(off.spin).toBeGreaterThan(0.5);
    expect(on.spin).toBeLessThan(off.spin * 0.7);
    expect(on.active).toBeGreaterThan(20);
    expect(on.v).toBeGreaterThan(off.v * 0.95);
  });

  /** An AI driver at speed on Aurelia's straight; asks for the throttle with the wheels as they are, then with some of them given a slide and spin. */
  function throttleWith(carId: string, wheels: number[]) {
    const track = loadTrackRuntime('aurelia');
    const def = getCar(carId);
    const world = new PhysicsWorld(track);
    const car = world.addVehicle(def);
    car.assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
    const slot = track.grid[0];
    car.placeOnGround(slot.position, slot.quaternion, 0);
    car.setTemperatures(1);
    const ai = new AIDriver(track, def, { difficulty: 'alien', seed: 1 });
    for (let i = 0; i < 60 * 5; i++) {
      ai.update(DT, car.state, world.states, car.controls, true);
      world.step(DT);
    }
    // a dt of 0: the driver looks again at the same moment, so the only difference is the state of the wheels it is given
    ai.update(0, car.state, world.states, car.controls, true);
    const calm = car.controls.throttle;
    for (const i of wheels) {
      car.state.wheels[i].slipRatio = 0.5;
      car.state.wheels[i].slipAngle = 0.1;
    }
    ai.update(0, car.state, world.states, car.controls, true);
    return { calm, slipping: car.controls.throttle, speed: car.state.speed * 3.6 };
  }

  it('lifts for a spinning front axle in an all-wheel-drive car, as it does for a spinning rear one', () => {
    const front = throttleWith('mammoth', [0, 1]);
    const rear = throttleWith('mammoth', [2, 3]);
    expect(front.speed).toBeGreaterThan(40);
    expect(front.calm).toBeGreaterThan(0.6);
    expect(front.slipping).toBeLessThan(front.calm * 0.4);
    expect(rear.slipping).toBeLessThan(rear.calm * 0.4);
  });

  it('does not lift a rear-drive car for wheels it does not drive', () => {
    const front = throttleWith('vanta-gt', [0, 1]);
    const rear = throttleWith('vanta-gt', [2, 3]);
    expect(front.calm).toBeGreaterThan(0.6);
    expect(front.slipping).toBeGreaterThan(front.calm * 0.9);
    expect(rear.slipping).toBeLessThan(rear.calm * 0.4);
  });
});

describe('all-wheel drive: the share of its weight a car can put to work', () => {
  const physics = (edit: (p: CarDefinition['physics']) => void = () => undefined) => mammothWith(edit).physics;

  it('is all of it for a centre that can move the drive to where the load is (the Mammoth)', () => {
    expect(awdTractionShare(physics())).toBeCloseTo(1, 6);
  });

  it('falls for a centre that cannot, the more the split is off the loads', () => {
    const openAt = (fs: number) =>
      awdTractionShare(
        physics((p) => {
          p.drivetrain.centerDiff = { ...OPEN };
          p.drivetrain.frontSplit = fs;
        }),
      );
    // a front-heavy split with the car squatting under power: the fronts spin at 0.84 of the grip of the whole car
    expect(openAt(0.4)).toBeGreaterThan(0.8);
    expect(openAt(0.4)).toBeLessThan(0.9);
    expect(openAt(0.5)).toBeLessThan(openAt(0.4));
    expect(openAt(0.3)).toBeGreaterThan(openAt(0.4));
    expect(openAt(0.3)).toBeGreaterThan(0.97);
    // a locked centre goes anywhere
    expect(
      awdTractionShare(
        physics((p) => {
          p.drivetrain.centerDiff = { ...LOCKED };
          p.drivetrain.frontSplit = 0.6;
        }),
      ),
    ).toBeCloseTo(1, 6);
  });
});
