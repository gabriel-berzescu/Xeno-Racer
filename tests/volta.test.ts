/**
 * The Volta's own mechanisms, each behind a field of the car's data that no other car has, held to what they promise:
 *   - active aero (AeroSpec.straightMode, src/physics/aero.ts): the flaps open over 0.4 s on a straight taken flat out above 150 km/h and
 *     close within 0.25 s on a lift, the brakes or a turn of the wheel; in straight mode the car has less drag and less downforce, the
 *     damage still takes its share of what is left, and a replay shows where the flaps stood. A car with fixed wings has no flaps at all.
 * Run: npx vitest run tests/volta.test.ts
 */
import { describe, expect, it } from 'vitest';
import { CARS, getCar } from '../src/cars';
import type { Assists, CarDefinition } from '../src/core/contracts';
import { neutralEffects, type MechEffects } from '../src/core/mechanical';
import { ReplayPlayer, ReplayRecorder } from '../src/game/replay';
import { PhysicsWorld, createFlatTrack } from '../src/physics';
import { DT, dragRun, setup } from './probes/car-metrics';

const volta = getCar('volta');
const others = CARS.filter((c) => c !== volta);
/** The aids an AI driver races with (and the four-cars guard drives): ABS, the traction control low, no stability control. */
const AIDS: Assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
const G = 9.81;
const RHO = 1.225;

/** The Volta with its wings fixed in corner mode: everything else the same. */
const fixedWings: CarDefinition = (() => {
  const d = structuredClone(volta);
  delete d.physics.aero.straightMode;
  return d;
})();

/** A Volta at `kmh` on the flat, flat out for `seconds` (the flaps open), with the damage `fx` if any. */
function flatOut(kmh: number, seconds = 1, fx: MechEffects | null = null) {
  const { world, car } = setup(volta, {}, kmh / 3.6, { ...AIDS });
  car.setDamage(fx);
  car.controls.throttle = 1;
  for (let i = 0; i < Math.round(seconds / DT); i++) world.step(DT);
  return { world, car };
}

/** Seconds from now until the flaps are fully shut, stepping the world (Infinity if they are not within 2 s). */
function timeToClose(world: PhysicsWorld, car: ReturnType<typeof flatOut>['car']): number {
  const t0 = world.time;
  for (let i = 0; i < 120; i++) {
    world.step(DT);
    if (car.state.aeroOpen === 0) return world.time - t0;
  }
  return Infinity;
}

/** The air's push on the wheels over the next half second (the four loads less the weight), per unit of dynamic pressure: the lift area at work (m^2). */
function liftArea(world: PhysicsWorld, car: ReturnType<typeof flatOut>['car']): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < 30; i++) {
    world.step(DT);
    const q = 0.5 * RHO * car.state.forwardSpeed ** 2;
    sum += (car.wheels.reduce((a, w) => a + w.load * w.normal.y, 0) - car.mass * G) / q;
    n++;
  }
  return sum / n;
}

describe('active aero: the Volta opens its wings on the straights', () => {
  it('is the Volta\'s alone: every other car has fixed wings and no flaps in its state', () => {
    expect(volta.physics.aero.straightMode).toBeDefined();
    for (const def of others) {
      expect(def.physics.aero.straightMode, def.id).toBeUndefined();
      const { world, car } = setup(def, {}, 250 / 3.6, { ...AIDS });
      car.controls.throttle = 1;
      world.simulate(1);
      expect('aeroOpen' in car.state, def.id).toBe(false);
    }
  });

  it('opens over 0.4 s on a straight taken flat out above 150 km/h', () => {
    const { world, car } = setup(volta, {}, 250 / 3.6, { ...AIDS });
    expect(car.state.aeroOpen).toBe(0);
    car.controls.throttle = 1;
    let full = Infinity;
    let half = Infinity;
    for (let i = 0; i < 60; i++) {
      world.step(DT);
      if (half === Infinity && car.state.aeroOpen! >= 0.5) half = world.time;
      if (full === Infinity && car.state.aeroOpen! >= 1) full = world.time;
    }
    // (a frame to see the driver flat out, then the 0.4 s the rule allows for the change, at an even pace)
    expect(half).toBeGreaterThan(0.2);
    expect(half).toBeLessThan(0.25);
    expect(full).toBeGreaterThan(0.39);
    expect(full).toBeLessThan(0.45);
    expect(car.state.aeroOpen).toBe(1);
  });

  it('closes within 0.25 s on a lift, the brakes or a turn of the wheel', () => {
    const cases: [string, (c: ReturnType<typeof flatOut>['car']) => void][] = [
      ['a lift to 90 %', (c) => (c.controls.throttle = 0.9)],
      ['a lift', (c) => (c.controls.throttle = 0)],
      ['a touch of the brakes, still flat out', (c) => (c.controls.brake = 0.1)],
      ['the brakes', (c) => ((c.controls.throttle = 0), (c.controls.brake = 1))],
      ['a turn of the wheel, still flat out', (c) => (c.controls.steer = 0.05)],
    ];
    for (const [name, act] of cases) {
      const { world, car } = flatOut(250, 1);
      expect(car.state.aeroOpen, name).toBe(1);
      act(car);
      const t = timeToClose(world, car);
      expect(t, name).toBeLessThan(0.25);
      expect(t, name).toBeGreaterThan(0.15);
    }
  });

  it('stays in corner mode below 150 km/h, short of flat out and in a corner', () => {
    // flat out from 100 km/h: still under 150 half a second later, and shut all the way
    const slow = setup(volta, {}, 100 / 3.6, { ...AIDS });
    slow.car.controls.throttle = 1;
    for (let i = 0; i < 30; i++) {
      slow.world.step(DT);
      expect(slow.car.state.aeroOpen).toBe(0);
    }
    expect(slow.car.state.forwardSpeed * 3.6).toBeLessThan(150);
    // at 250 km/h on 90 % of the throttle
    const part = setup(volta, {}, 250 / 3.6, { ...AIDS });
    part.car.controls.throttle = 0.9;
    part.world.simulate(1);
    expect(part.car.state.aeroOpen).toBe(0);
    // flat out in a turn at 200 km/h (the wheel asks for 2 g)
    const turn = setup(volta, {}, 200 / 3.6, { ...AIDS });
    turn.car.controls.throttle = 1;
    turn.car.controls.steer = 0.05;
    turn.world.simulate(1);
    expect(turn.car.state.aeroOpen).toBe(0);
    expect(Math.abs(turn.car.state.localAccel.x)).toBeGreaterThan(G);
  });

  it('cuts the drag and the downforce by the straight mode\'s areas, and the damage still takes its share', () => {
    const a = volta.physics.aero;
    const sm = a.straightMode!;
    // a fifth less drag: 24 km/h more flat out on the flat (the engine alone)
    const active = dragRun(volta, 60);
    const fixed = dragRun(fixedWings, 60);
    expect(active.vmax).toBeGreaterThan(fixed.vmax + 15);
    // the lift area at work: corner mode on 90 % of the throttle, straight mode flat out
    const closed = setup(volta, {}, 250 / 3.6, { ...AIDS });
    closed.car.controls.throttle = 0.9;
    closed.world.simulate(1);
    expect(liftArea(closed.world, closed.car)).toBeCloseTo(a.liftAreaFront + a.liftAreaRear, 1);
    const open = flatOut(250, 1);
    const openArea = liftArea(open.world, open.car);
    expect(openArea).toBeCloseTo(sm.liftAreaFront + sm.liftAreaRear, 1);
    // damage that leaves half of the front and of the rear downforce: half of the straight mode's
    const fx: MechEffects = { ...neutralEffects(), aeroFront: 0.5, aeroRear: 0.5 };
    const hurt = flatOut(250, 1, fx);
    expect(hurt.car.state.aeroOpen).toBe(1);
    expect(liftArea(hurt.world, hurt.car) / openArea).toBeCloseTo(0.5, 1);
  });

  it('shows in a replay where the flaps stood, and gives a car with fixed wings none', () => {
    const world = new PhysicsWorld(createFlatTrack({}));
    const v = world.addVehicle(volta);
    const l = world.addVehicle(getCar('lmp-x'));
    const states = world.states;
    const rec = new ReplayRecorder(2, 0);
    v.state.aeroOpen = 0.2;
    rec.capture(0, states);
    v.state.aeroOpen = 1;
    rec.capture(1 / 30, states);
    rec.capture(2 / 30, states);
    const player = new ReplayPlayer(rec, states);
    player.apply(0.5 / 30);
    expect(player.states[0].aeroOpen).toBeCloseTo(0.6, 6);
    player.apply(1.5 / 30);
    expect(player.states[0].aeroOpen).toBeCloseTo(1, 6);
    expect('aeroOpen' in player.states[1]).toBe(false);
    expect('aeroOpen' in l.state).toBe(false);
  });
});
