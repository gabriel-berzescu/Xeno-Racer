/**
 * The Volta's own mechanisms, each behind a field of the car's data that no other car has, held to what they promise:
 *   - active aero (AeroSpec.straightMode, src/physics/aero.ts): the flaps open over 0.4 s on a straight taken flat out above 150 km/h and
 *     close within 0.25 s on a lift, the brakes or a turn of the wheel; in straight mode the car has less drag and less downforce, the
 *     damage still takes its share of what is left, and a replay shows where the flaps stood. A car with fixed wings has no flaps at all;
 *   - the electric nitro (EngineSpec.electric): a shot deploys the MGU-K, whose power follows the 2026 rule (350 kW to 290 km/h, then
 *     1800 - 5 v kW, nothing from 345 km/h) through the gearbox, with no push from a bottle and no extra engine torque; the clutch holds it,
 *     the limiter cuts it. Every other car keeps the bottle's push and the engine's extra torque.
 * Run: npx vitest run tests/volta.test.ts
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CARS, getCar } from '../src/cars';
import type { Assists, CarDefinition } from '../src/core/contracts';
import { neutralEffects, type MechEffects } from '../src/core/mechanical';
import { ReplayPlayer, ReplayRecorder } from '../src/game/replay';
import { PhysicsWorld, createFlatTrack, electricPower } from '../src/physics';
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

// ── the electric nitro ───────────────────────────────────────────────────────────

/** A car at `kmh` in the gear that has its engine nearest 11,000 rpm from below, flat out with the flaps open, then `seconds` with the nitro at `nitro`. */
function shot(def: CarDefinition, kmh: number, nitro: number, seconds = 0.25) {
  const { world, car } = setup(def, {}, kmh / 3.6, { ...AIDS });
  const d = def.physics.drivetrain;
  const rpmIn = (g: number) => (kmh / 3.6 / def.physics.tireRear.radius) * d.gears[g - 1] * d.finalDrive * (60 / (2 * Math.PI));
  let g = 1;
  while (g < d.gears.length && rpmIn(g) > 11000) g++;
  car.gear = g;
  car.placeOnGround(new Vector3(), new Quaternion(), kmh / 3.6);
  car.setTemperatures(1);
  car.controls.throttle = 1;
  world.simulate(0.6);
  car.nitro = nitro;
  const v0 = car.state.forwardSpeed;
  world.simulate(seconds);
  return { world, car, gear: car.gear, dv: car.state.forwardSpeed - v0, v: (car.state.forwardSpeed + v0) / 2 };
}

/** The Volta with the clutch held open (no automatic clutch) at `kmh`, flat out for a second with the nitro at `nitro`. */
function clutchOpen(def: CarDefinition, kmh: number, nitro: number) {
  const { world, car } = setup(def, {}, kmh / 3.6, { ...AIDS, autoClutch: false });
  car.controls.clutch = 1;
  car.controls.throttle = 1;
  car.nitro = nitro;
  let maxRpm = 0;
  for (let i = 0; i < 60; i++) {
    world.step(DT);
    maxRpm = Math.max(maxRpm, car.state.rpm);
  }
  return { car, maxRpm };
}

describe('the electric nitro: a shot wakes the Volta\'s MGU-K', () => {
  const m = volta.physics.engine.electric!;

  it('deploys the 2026 rule\'s power: 350 kW to 290 km/h, then 1800 - 5 v kW, nothing from 345 km/h', () => {
    expect(m).toEqual({ powerKw: 350, torqueNm: 500, fullToKmh: 290, zeroAtKmh: 345 });
    for (const kmh of [-10, 0, 100, 200, 290]) expect(electricPower(m, kmh), `${kmh} km/h`).toBe(350000);
    for (const kmh of [291, 300, 320, 340, 344]) expect(electricPower(m, kmh), `${kmh} km/h`).toBeCloseTo((1800 - 5 * kmh) * 1000, 6);
    for (const kmh of [345, 346, 360, 400]) expect(electricPower(m, kmh), `${kmh} km/h`).toBe(0);
    // (the three numbers of the field are what shape it: a motor of 200 kW, full to 250 km/h and cut at 280)
    const other = { powerKw: 200, torqueNm: 300, fullToKmh: 250, zeroAtKmh: 280 };
    expect(electricPower(other, 250)).toBe(200000);
    expect(electricPower(other, 270)).toBeCloseTo(100000, 6);
    expect(electricPower(other, 280)).toBe(0);
    // and the other cars have no motor
    for (const def of others) expect(def.physics.engine.electric, def.id).toBeUndefined();
  });

  it('adds the motor\'s power at the wheels as the rule has it, through the gearbox', () => {
    const ph = volta.physics;
    const r = ph.tireRear.radius;
    const shares: number[] = [];
    for (const kmh of [250, 290, 300, 320, 330]) {
      const off = shot(volta, kmh, 0);
      const on = shot(volta, kmh, 1);
      expect(on.gear).toBe(off.gear);
      expect(on.car.state.aeroOpen).toBe(1);
      // what the car gains, as power: its mass and the wheels' and the engine's rotating inertia, brought up to speed together
      const G = ph.drivetrain.gears[on.gear - 1] * ph.drivetrain.finalDrive;
      const mEff = ph.chassis.mass + (2 * ph.tireFront.inertia) / ph.tireFront.radius ** 2 + (2 * ph.tireRear.inertia) / r ** 2 + (ph.engine.inertia * G * G) / (r * r);
      const gained = (mEff * (on.dv - off.dv) * on.v) / 0.25;
      const rule = ph.drivetrain.efficiency * electricPower(m, on.v * 3.6);
      expect(gained / rule, `${kmh} km/h`).toBeGreaterThan(0.85);
      expect(gained / rule, `${kmh} km/h`).toBeLessThan(1.02);
      shares.push(gained / rule);
    }
    // (the same share of it at every speed, the full power and the taper alike: the tyres' slip and the drag of the extra speed take the rest)
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThan(0.04);
  });

  it('gives nothing past the speed its field cuts it at: a shot there changes the car not by a bit', () => {
    // (a Volta whose motor is cut at 200 km/h, flat out at 250: the field's own number, where the real one's 345 is out of the car's reach)
    const cut = structuredClone(volta);
    cut.physics.engine.electric = { ...m, fullToKmh: 150, zeroAtKmh: 200 };
    const off = shot(cut, 250, 0, 1);
    const on = shot(cut, 250, 1, 1);
    expect(on.car.state.nitro).toBe(1);
    expect(on.car.p.toArray()).toEqual(off.car.p.toArray());
    expect(on.car.v.toArray()).toEqual(off.car.v.toArray());
    expect(on.car.state.rpm).toBe(off.car.state.rpm);
  });

  it('has no bottle to push the car: with the clutch held open a shot only spins the engine, and the limiter cuts the motor', () => {
    const off = clutchOpen(volta, 80, 0);
    const on = clutchOpen(volta, 80, 1);
    expect(on.car.v.toArray()).toEqual(off.car.v.toArray());
    expect(on.car.p.toArray()).toEqual(off.car.p.toArray());
    // the engine with the motor on it runs up against the limiter and no further (500 Nm more would take it far past)
    expect(on.maxRpm).toBeLessThan(volta.physics.engine.limiterRpm + 150);
    // every other car has its bottle: the same shot pushes it along at 0.3 g
    for (const def of others) {
      const plain = clutchOpen(def, 80, 0).car.state.forwardSpeed;
      const pushed = clutchOpen(def, 80, 1).car.state.forwardSpeed;
      expect(pushed - plain, def.id).toBeGreaterThan(2.6);
      expect(pushed - plain, def.id).toBeLessThan(3.1);
    }
  });

  it('is held by the clutch and the traction control: no slip once the clutch is in, the same launch, no limiter on the way to 340 km/h', () => {
    const run = (nitro: number) => {
      const { world, car } = setup(volta, {}, 0, { ...AIDS });
      world.simulate(1);
      car.controls.throttle = 1;
      car.nitro = nitro;
      const d = volta.physics.drivetrain;
      const t0 = world.time;
      let t100 = 0;
      let t200 = 0;
      let vmax = 0;
      let limiter = 0;
      let slip = 0;
      while (world.time - t0 < 45) {
        world.step(DT);
        const st = car.state;
        const kmh = st.forwardSpeed * 3.6;
        vmax = Math.max(vmax, kmh);
        if (!t100 && kmh >= 100) t100 = world.time - t0;
        if (!t200 && kmh >= 200) t200 = world.time - t0;
        if (st.revLimiter) limiter += DT;
        // (the engine against the driveline while the clutch is fully in: between shifts, past the launch)
        if (st.clutch < 0.01 && kmh > 60) {
          const wheel = (car.wheels[2].omega + car.wheels[3].omega) / 2;
          slip = Math.max(slip, st.rpm / ((wheel * d.gears[st.gear - 1] * d.finalDrive * 60) / (2 * Math.PI)) - 1);
        }
      }
      return { t100, t200, vmax, limiter, slip };
    };
    const plain = run(0);
    const boosted = run(1);
    expect(boosted.slip).toBeLessThan(0.005);
    expect(boosted.limiter).toBe(0);
    // traction-limited off the line, the boost or not
    expect(Math.abs(boosted.t100 - plain.t100)).toBeLessThan(0.2);
    // and then a good deal quicker: about 1.3 s to 200 km/h, 17 km/h more flat out (in reach of the cut at 345)
    expect(boosted.t200).toBeLessThan(plain.t200 - 1);
    expect(boosted.vmax).toBeGreaterThan(plain.vmax + 12);
    expect(boosted.vmax).toBeLessThan(345.5);
  });
});
