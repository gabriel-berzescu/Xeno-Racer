/**
 * The Volta, an 800 kg single-seater on slicks, held to the promises made for it:
 *   - what the stats say is what it does (0-100, top speed, power), with the wings open and shut and with a nitro shot burning;
 *   - it corners like nothing else here, more the faster it goes (the skidpad, the lateral g at 150, 200 and 250 km/h), stops in the
 *     length of the downforce it has, and keeps its share of that in the rain;
 *   - on a lap it never strikes its floor, hits nothing and needs no reset, and the AI drivers are quicker in it than in the LMP-X, and a
 *     whole grid of them races cleanly.
 * And its own mechanisms, each behind a field of the car's data that no other car has:
 *   - active aero (AeroSpec.straightMode, src/physics/aero.ts): the flaps open over 0.4 s on a straight taken flat out above 150 km/h, a
 *     quarter of a second after the driver is (not while a governor pumps the throttle), and close within 0.25 s on a lift, the brakes or a
 *     turn of the wheel (and not on a part-lift or in a gentle bend); in straight mode the car has less drag and less downforce, the damage
 *     still takes its share of what is left, and a replay shows where the flaps stood. A car with fixed wings has no flaps at all;
 *   - the electric nitro (EngineSpec.electric): a shot deploys the MGU-K, whose power follows the 2026 rule (350 kW to 290 km/h, then
 *     1800 - 5 v kW, nothing from 345 km/h) through the gearbox, with no push from a bottle and no extra engine torque; the clutch holds it,
 *     the limiter cuts it. Every other car keeps the bottle's push and the engine's extra torque;
 *   - the AI knows the flaps: its speed profile accelerates the Volta in straight mode where they open (faster on the straights, the same
 *     in the corners and the braking zones), an AI lap has them open on the straights and shut under braking and in the corners, and with
 *     the nitro off the driver is the one it always was. No other car's profile has a straight mode.
 * Run: npx vitest run tests/volta.test.ts   (MAMMOTH=all CAR=volta,lmp-x tests/probes/mammoth-probe.test.ts prints the full table)
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { AIDriver, computeRacingLine, computeSpeedProfile, gripModel, profileLapTime } from '../src/ai';
import { CARS, getCar } from '../src/cars';
import type { Assists, CarDefinition } from '../src/core/contracts';
import { neutralEffects, type MechEffects } from '../src/core/mechanical';
import { ReplayPlayer, ReplayRecorder } from '../src/game/replay';
import { PhysicsWorld, createFlatTrack, electricPower, peakPower, peakTorque } from '../src/physics';
import { TRACKS, loadTrackRuntime } from '../src/track';
import { DT, aiLap, brakeRun, dragRun, gripAtSpeed, setup, skidpad } from './probes/car-metrics';
import { runPack } from './probes/pack-race';

const volta = getCar('volta');
const lmp = getCar('lmp-x');
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

/** Flat out at `kmh` in top gear for a second (the flaps open), then the full pedal to rest: the hardest deceleration over a tenth of a second (g). */
function stopFrom(kmh: number): number {
  const { world, car } = setup(volta, {}, kmh / 3.6, { ...AIDS });
  car.gear = volta.physics.drivetrain.gears.length;
  car.controls.throttle = 1;
  world.simulate(1);
  car.controls.throttle = 0;
  car.controls.brake = 1;
  const v: number[] = [car.state.forwardSpeed];
  while (car.state.forwardSpeed > 1 && v.length < 600) {
    world.step(DT);
    v.push(car.state.forwardSpeed);
  }
  let peak = 0;
  for (let i = 6; i < v.length; i++) peak = Math.max(peak, (v[i - 6] - v[i]) / (6 * DT) / G);
  return peak;
}

// ── the Volta in numbers ─────────────────────────────────────────────────────────

describe('the Volta is what its stats say', () => {
  it('is an 800 kg rear-drive single-seater on slicks, with the power and the torque it is sold with', () => {
    expect(volta.class).toBe('Formula');
    expect(volta.drivetrain).toBe('RWD');
    expect(volta.physics.drivetrain.layout).toBe('RWD');
    expect(volta.physics.chassis.mass).toBe(volta.stats.massKg);
    expect(volta.physics.tireFront.slick).toBe(1);
    expect(volta.physics.tireRear.slick).toBe(1);
    const e = volta.physics.engine;
    expect(peakPower(e).watts / 745.7 / volta.stats.powerHp).toBeGreaterThan(0.99);
    expect(peakPower(e).watts / 745.7 / volta.stats.powerHp).toBeLessThan(1.01);
    expect(peakTorque(e)).toBe(volta.stats.torqueNm);
  });

  it('does 0-100 in 2.4 s, the slicks\' limit, 200 in 5.6 s and 330 km/h flat out with the wings open, 303 with them shut', () => {
    // (the brief: 2.6-2.8 s, about 5.5 s and about 330 km/h. The slicks that hold 2.39 g on the skidpad take the car to 100 in 2.42 s; 2.6-2.8
    // would want a tenth less grip at rest, and the skidpad would lose it too. From 100 to 200 km/h the engine alone, 421 kW, takes 3.15 s)
    const d = dragRun(volta, 70);
    expect(d.t100!).toBeGreaterThan(2.3);
    expect(d.t100!).toBeLessThan(2.55);
    expect(Math.abs(d.t100! - volta.stats.zeroTo100)).toBeLessThan(0.15);
    expect(d.t200!).toBeGreaterThan(5.4);
    expect(d.t200!).toBeLessThan(5.75);
    expect(Math.abs(d.vmax - volta.stats.topSpeedKmh)).toBeLessThan(4);
    const shut = dragRun(fixedWings, 70);
    expect(shut.vmax).toBeGreaterThan(296);
    expect(shut.vmax).toBeLessThan(310);
    // quicker than the LMP-X off the line (2.60 s), on 125 hp less, from 100 to 200 and flat out
    const l = dragRun(lmp, 70);
    expect(d.t100!).toBeLessThan(l.t100! - 0.1);
    expect(d.t200! - d.t100!).toBeLessThan(l.t200! - l.t100! - 0.05);
    expect(d.vmax).toBeGreaterThan(l.vmax + 6);
  });

  it('leaves the line at the slicks\' limit, smoothly: the traction control is worth 0.45 s, the nitro nothing', () => {
    // (with the traction control off the slicks spin up and the car is at 100 in 2.9 s; with it on, in 2.4 s whether the motor deploys or not)
    const off = dragRun(volta, 6, {}, 'off');
    const low = dragRun(volta, 6, {}, 'low');
    expect(off.t100!).toBeGreaterThan(low.t100! + 0.3);
    expect(off.maxSlip).toBeGreaterThan(1);
    // the launch control's clutch takes no more than the slicks hold at rest: the rear wheels run at a steady slip, not in bursts the traction
    // control has to cut (slicks whose friction fell still less with their load spun past 0.2 for 0.13 s of the first second at 0.07, 0.07 s at 0.1)
    {
      const { world, car } = setup(volta, {}, 0, { ...AIDS });
      world.simulate(1);
      car.controls.throttle = 1;
      let burst = 0;
      for (let i = 0; i < 60; i++) {
        world.step(DT);
        if (Math.max(car.state.wheels[2].slipRatio, car.state.wheels[3].slipRatio) > 0.2) burst += DT;
      }
      expect(burst).toBeLessThan(0.03);
    }
    const { world, car } = setup(volta, {}, 0, { ...AIDS });
    world.simulate(1);
    car.controls.throttle = 1;
    car.nitro = 1;
    const t0 = world.time;
    while (car.state.forwardSpeed < 100 / 3.6 && world.time - t0 < 6) world.step(DT);
    expect(Math.abs(world.time - t0 - low.t100!)).toBeLessThan(0.1);
  });
});

describe('the Volta corners and stops like a single-seater', () => {
  it('holds 2.3-2.45 g on the skidpad, a little short of neutral', () => {
    // (the brief: 2.3-2.4 g)
    const pad = skidpad(volta);
    expect(pad.latG).toBeGreaterThan(2.3);
    expect(pad.latG).toBeLessThan(2.45);
    // (the fronts give up a little first: half a degree more slip angle than the rears)
    expect(pad.balanceDeg).toBeGreaterThan(0.2);
    expect(pad.balanceDeg).toBeLessThan(1.2);
    expect(pad.latG).toBeGreaterThan(skidpad(lmp).latG * 1.2);
  });

  it('holds 2.5, 3.1 and 3.7 g at 150, 200 and 250 km/h, a fifth more than the LMP-X', () => {
    // (the brief: 2.5, 3.0 and 3.6 g, give or take a tenth)
    for (const [kmh, lo, hi] of [[150, 2.4, 2.65], [200, 2.95, 3.3], [250, 3.5, 3.9]] as const) {
      const g = gripAtSpeed(volta, kmh);
      expect(g.latG, `${kmh} km/h`).toBeGreaterThan(lo);
      expect(g.latG, `${kmh} km/h`).toBeLessThan(hi);
      // (at 250 the drag of the wings and of the loaded tyres takes all the engine has: the figure is held at 240)
      expect(g.speedKmh, `${kmh} km/h`).toBeGreaterThan(kmh * 0.9);
      expect(g.latG, `${kmh} km/h against the LMP-X`).toBeGreaterThan(gripAtSpeed(lmp, kmh).latG * 1.12);
    }
  });

  it('stops from 100 km/h in 18-19.8 m, from 200 in 56-61 m, and from 300 at 4.2-4.6 g', () => {
    // (the brief: 18-20 m and 75-85 m, 4 g as in 2026 and up to 5 g in this tyre model. The grip that pulls 3.1 g sideways at 200 km/h stops the
    // car from there in 58 m, the LMP-X in 65: a stop of 75-85 m from 200 wants brakes of under half the torque, which stop it from 100 in 20 m
    // but from 300 at 2.4 g. From 300 these brakes, not the tyres, have the last word: a full pedal asks for 4.0 g, the drag adds the rest)
    const b100 = brakeRun(volta, true, {}, 100);
    const b200 = brakeRun(volta, true, {}, 200);
    expect(b100.distance).toBeGreaterThan(18);
    expect(b100.distance).toBeLessThan(19.8);
    expect(b200.distance).toBeGreaterThan(56);
    expect(b200.distance).toBeLessThan(61);
    const peak = stopFrom(300);
    expect(peak).toBeGreaterThan(4.2);
    expect(peak).toBeLessThan(4.6);
    const l100 = brakeRun(lmp, true, {}, 100).distance;
    const l200 = brakeRun(lmp, true, {}, 200).distance;
    expect(b100.distance).toBeLessThan(l100 - 0.5);
    expect(b200.distance).toBeLessThan(l200 - 4);
  });

  it('keeps 60-70 % of its grip on a wet road and 50-60 % in standing water, and stops in 1.3-1.75 times the distance', () => {
    const pad = skidpad(volta).latG;
    const stop = brakeRun(volta, true).distance;
    for (const [wetness, lo, hi, slo, shi] of [[0.75, 0.6, 0.7, 1.3, 1.5], [1, 0.5, 0.6, 1.5, 1.75]] as const) {
      const share = skidpad(volta, 60, { wetness }).latG / pad;
      const longer = brakeRun(volta, true, { wetness }).distance / stop;
      expect(share, `wet ${wetness}`).toBeGreaterThan(lo);
      expect(share, `wet ${wetness}`).toBeLessThan(hi);
      expect(longer, `wet ${wetness}`).toBeGreaterThan(slo);
      expect(longer, `wet ${wetness}`).toBeLessThan(shi);
    }
  });
});

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

  it('opens over 0.4 s on a straight taken flat out above 150 km/h, a quarter of a second after the driver is flat out', () => {
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
    // (a quarter of a second flat out on the straight, then the 0.4 s the rule allows for the change, at an even pace)
    expect(half).toBeGreaterThan(0.45);
    expect(half).toBeLessThan(0.5);
    expect(full).toBeGreaterThan(0.64);
    expect(full).toBeLessThan(0.7);
    expect(car.state.aeroOpen).toBe(1);
  });

  it('stays shut while the throttle is pumped, as a governor does on a wet road, and opens once it is held', () => {
    const { world, car } = setup(volta, {}, 200 / 3.6, { ...AIDS });
    // (the AI's governor in standing water with the rear tyres spinning: 0.4-0.6 of the throttle and back to full every 2-6 frames)
    for (let i = 0; i < 90; i++) {
      car.controls.throttle = i % 6 < 3 ? 1 : 0.5;
      world.step(DT);
      expect(car.state.aeroOpen, `frame ${i}`).toBe(0);
    }
    car.controls.throttle = 1;
    world.simulate(1);
    expect(car.state.aeroOpen).toBe(1);
  });

  it('closes within 0.25 s on a lift, the brakes or a turn of the wheel', () => {
    const cases: [string, (c: ReturnType<typeof flatOut>['car']) => void][] = [
      ['a lift to 70 %', (c) => (c.controls.throttle = 0.7)],
      ['a lift', (c) => (c.controls.throttle = 0)],
      ['a touch of the brakes, still flat out', (c) => (c.controls.brake = 0.1)],
      ['the brakes', (c) => ((c.controls.throttle = 0), (c.controls.brake = 1))],
      // (2.4 degrees at the road wheel: a corner of 1.5 g at 250 km/h)
      ['a turn of the wheel, still flat out', (c) => (c.controls.steer = 0.1)],
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

  it('stays open through a part-lift and a gentle bend, so a driver holding a speed does not have them flapping', () => {
    const cases: [string, (c: ReturnType<typeof flatOut>['car']) => void][] = [
      ['easing to 85 %', (c) => (c.controls.throttle = 0.85)],
      // (0.24 degrees: a bend of a fifth of a g at 250 km/h, which the bare v^2 δ / L would take for one of 0.7 g)
      ['a bend', (c) => (c.controls.steer = 0.01)],
    ];
    for (const [name, act] of cases) {
      const { world, car } = flatOut(250, 1);
      act(car);
      for (let i = 0; i < 60; i++) {
        world.step(DT);
        expect(car.state.aeroOpen, name).toBe(1);
      }
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
    // 22 % less drag: 27 km/h more flat out on the flat (the engine alone)
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
    // and then a good deal quicker: 200 km/h in 4.15-4.5 s, 1.2 s sooner, and 15 km/h more flat out, up to the cut at 345 (the brief: about 4.7 s
    // and 343 km/h; the tyres set the start, the boost or not, and they reach 100 in 2.4 s)
    expect(boosted.t200).toBeLessThan(plain.t200 - 1);
    expect(boosted.t200).toBeGreaterThan(4.15);
    expect(boosted.t200).toBeLessThan(4.5);
    expect(boosted.vmax).toBeGreaterThan(plain.vmax + 12);
    expect(boosted.vmax).toBeGreaterThan(342);
    expect(boosted.vmax).toBeLessThan(345.5);
  });
});

// ── the AI and the flaps ─────────────────────────────────────────────────────────

describe('the AI knows the flaps', () => {
  const aurelia = loadTrackRuntime('aurelia');
  const line = computeRacingLine(aurelia, { edgeMargin: volta.visual.width / 2 - 0.25 });
  const alien = { gripUse: 0.965, brakeUse: 0.94, wetness: 0 };

  it('has a speed profile that accelerates in straight mode where the flaps open, and corners and brakes in corner mode', () => {
    const active = computeSpeedProfile(aurelia, line, volta, alien).v;
    const fixed = computeSpeedProfile(aurelia, line, fixedWings, alien).v;
    let faster = 0;
    let top = 0;
    let topFixed = 0;
    for (let i = 0; i < line.n; i++) {
      // never slower, anywhere
      expect(active[i], `point ${i}`).toBeGreaterThanOrEqual(fixed[i]);
      if (active[i] > fixed[i] + 1) faster++;
      top = Math.max(top, active[i]);
      topFixed = Math.max(topFixed, fixed[i]);
    }
    // faster on the straights: a fifth of the lap 1 m/s or more, and more at the end of the longest
    expect(faster).toBeGreaterThan(line.n * 0.2);
    expect(top).toBeGreaterThan(topFixed + 2.5);
    expect(profileLapTime(line, { v: active })).toBeLessThan(profileLapTime(line, { v: fixed }) - 0.5);
    // the same in the slow corners: their speed is corner mode's
    const slowest = (v: Float32Array) => v.reduce((a, b) => Math.min(a, b), Infinity);
    expect(slowest(active)).toBe(slowest(fixed));
    // on snow the tyres, not the engine, limit the car (the driver holds the throttle to what they take) and the flaps stay shut: the profile
    // at Isvik is the fixed wings', point for point
    const isvik = loadTrackRuntime('isvik');
    const snowLine = computeRacingLine(isvik, { edgeMargin: volta.visual.width / 2 - 0.25 + 0.45 });
    const onSnow = { ...alien, gripUse: alien.gripUse + 0.06 };
    expect(Array.from(computeSpeedProfile(isvik, snowLine, volta, onSnow).v)).toEqual(Array.from(computeSpeedProfile(isvik, snowLine, fixedWings, onSnow).v));
  });

  it('gives no other car a straight mode, and a straight mode that is the corner mode changes the profile not by a bit', () => {
    for (const def of others) expect(gripModel(def, alien).straight, def.id).toBeNull();
    expect(gripModel(volta, alien).straight).not.toBeNull();
    const same = structuredClone(volta);
    same.physics.aero.straightMode = { dragArea: volta.physics.aero.dragArea, liftAreaFront: volta.physics.aero.liftAreaFront, liftAreaRear: volta.physics.aero.liftAreaRear };
    expect(Array.from(computeSpeedProfile(aurelia, line, same, alien).v)).toEqual(Array.from(computeSpeedProfile(aurelia, line, fixedWings, alien).v));
  });

  it('laps with the flaps open on the straights and shut under braking and in the corners', () => {
    const world = new PhysicsWorld(aurelia);
    const car = world.addVehicle(volta);
    car.assists = { ...AIDS };
    const slot = aurelia.grid[0];
    car.placeOnGround(slot.position, slot.quaternion, 0);
    car.setTemperatures(1);
    const ai = new AIDriver(aurelia, volta, { difficulty: 'alien', seed: 1 });
    let open = 0;
    let braking = 0;
    let cornering = 0;
    let shutAfter = 0;
    let checked = 0;
    let opened = 0;
    let last = 0;
    while (world.time < 90) {
      ai.update(DT, car.state, world.states, car.controls, true);
      world.step(DT);
      const st = car.state;
      const o = st.aeroOpen!;
      if (o === 1) open += DT;
      if (o > 0 && last === 0) opened++;
      last = o;
      braking = car.controls.brake > 0 ? braking + DT : 0;
      cornering = Math.abs(st.localAccel.x) > 1.5 * G ? cornering + DT : 0;
      // a quarter of a second into the brakes or into a corner of 1.5 g, they are shut
      if (braking > 0.25 || cornering > 0.25) {
        checked++;
        if (o !== 0) shutAfter++;
      }
      expect(ai.needsReset).toBe(false);
    }
    expect(open).toBeGreaterThan(25);
    expect(checked).toBeGreaterThan(600);
    expect(shutAfter).toBe(0);
    // (about once per straight: no fluttering)
    expect(opened).toBeLessThan(25);
  });

  it('drives as it always did with the nitro off: a driver never handed a shot never asks for one, and one that is never given it drives the same', () => {
    const drive = (ready: boolean) => {
      const world = new PhysicsWorld(aurelia);
      const car = world.addVehicle(volta);
      car.assists = { ...AIDS };
      const slot = aurelia.grid[0];
      car.placeOnGround(slot.position, slot.quaternion, 0);
      car.setTemperatures(1);
      const ai = new AIDriver(aurelia, volta, { difficulty: 'alien', seed: 1 });
      const controls: number[] = [];
      let asked = 0;
      while (world.time < 30) {
        // (a shot ready but never fired: the game's tank refusing it)
        ai.nitroReady = ready;
        ai.update(DT, car.state, world.states, car.controls, true);
        if (ai.wantNitro) asked++;
        controls.push(car.controls.steer, car.controls.throttle, car.controls.brake);
        world.step(DT);
      }
      return { controls, asked };
    };
    const off = drive(false);
    const ready = drive(true);
    expect(off.asked).toBe(0);
    expect(ready.asked).toBeGreaterThan(0);
    expect(ready.controls).toEqual(off.controls);
  });
});

// ── the Volta on a lap ───────────────────────────────────────────────────────────

describe('the Volta on a lap', () => {
  // The AI drivers' laps (alien, standing start): the character of the car in lap times. tests/ai.test.ts has all six cars on all five circuits,
  // dry and in a storm, and holds every one of them to two clean laps; here what the promise gives.
  it('never strikes its floor, hits nothing and needs no reset, on any circuit at full speed', () => {
    // (6 cm of travel at 5 cm off the ground: with 5 cm at 4 cm the floor struck the road in Brennwald's compression at 308 km/h)
    for (const t of TRACKS) {
      const r = aiLap(t.info.id, volta);
      expect(r.resets, t.info.id).toBe(0);
      expect(r.impacts, t.info.id).toBe(0);
      expect(r.floor, `${t.info.id}: floor touches`).toBe(0);
    }
  }, 300000);

  it('is quicker than the LMP-X, dry and in a storm, and level with it on the studded tyres of Isvik', () => {
    // (by 1.4-5.9 % on these laps, as on the second laps of tests/ai.test.ts: the brief asked 7-12 %, which the engine alone, with the LMP-X's
    // power for its weight, does not give; with 25 % more torque it would still be 6-9 % on the road circuits and 2.6 % on Isvik)
    for (const trackId of ['aurelia', 'brennwald'])
      for (const wetness of [0, 1]) {
        const v = aiLap(trackId, volta, wetness);
        const l = aiLap(trackId, lmp, wetness);
        expect(v.resets, `${trackId} wet ${wetness}`).toBe(0);
        expect(v.lap, `${trackId} wet ${wetness}`).toBeLessThan(l.lap * 0.99);
      }
    const v = aiLap('isvik', volta).lap;
    const l = aiLap('isvik', lmp).lap;
    expect(Math.abs(v / l - 1)).toBeLessThan(0.02);
  }, 300000);
});

describe('a whole grid of Voltas', () => {
  // The one-make race the game sets up, single-seaters wheel to wheel at 300 km/h: no wall hit, no reset (48 races of twelve on Aurelia,
  // Kuroyama and Brennwald, dry and wet, are in the stream's notes: PACKSEEDS=1 CAR=volta tests/probes/pack.test.ts)
  it('races Aurelia dry and Brennwald in a storm without a wall hit or a reset', () => {
    for (const [trackId, seed, wetness] of [['aurelia', 0, 0], ['brennwald', 1, 1]] as const) {
      const r = runPack(trackId, 'volta', 'pro', 12, 1, false, { seed, wetness });
      expect(r.finished, `finished, ${trackId}`).toBe(12);
      expect(r.walls, `wall hits, ${trackId}`).toBe(0);
      expect(r.resets, `resets, ${trackId}`).toBe(0);
      expect(r.offTrack / 12, `seconds off the road per car, ${trackId}`).toBeLessThan(1);
    }
  }, 600000);
});
