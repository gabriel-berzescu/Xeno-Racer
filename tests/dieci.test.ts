/**
 * The Dieci, a 640 kg single-seater of 2004 with a 3.0 L V10, held to the promises made for it:
 *   - what the stats say is what it does (0-100, top speed, power), and its launch control holds the engine at the speed its data names
 *     (EngineSpec.launchRpm, 10,000 rpm), where every other car is held where it always was;
 *   - it corners harder than anything here, the more the faster it goes (the skidpad, the lateral g at 150, 200 and 250 km/h), stops in the
 *     length of the grip it has, at up to 5 g from 300 km/h, and keeps its share of that in the rain; flat out at the limit of a bend from
 *     150 to 240 km/h it has more power than its rear tyres hold and steps out, and the default aids catch it;
 *   - its nitro is the ordinary bottle: more torque and a push, which the clutch holds and seventh gear's limiter cuts;
 *   - on a lap it never strikes its floor, hits nothing and needs no reset, dry or in a storm, the AI drivers are 4-7 % quicker in it than in
 *     the Volta on the road circuits and quicker than in the LMP-X everywhere, and a whole grid of them races cleanly.
 * Run: npx vitest run tests/dieci.test.ts
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { getCar } from '../src/cars';
import { carAssists } from '../src/core/aids';
import type { Assists, CarDefinition } from '../src/core/contracts';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { PhysicsWorld, SteeringFilter, createFlatTrack, peakPower, peakTorque } from '../src/physics';
import { TRACKS } from '../src/track';
import { DT, G, aiLap, brakeRun, dragRun, setup, skidpad, type Ground } from './probes/car-metrics';
import { runPack } from './probes/pack-race';

const dieci = getCar('dieci');
const volta = getCar('volta');
const lmp = getCar('lmp-x');
/** The aids an AI driver races with (and the four-cars guard drives): ABS, the traction control low, no stability control. */
const AIDS: Assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
const ROAD = TRACKS.map((t) => t.info.id).filter((id) => id !== 'isvik');

/** The highest engine speed while the clutch slips in the first second of a standing start flat out on `ground`, and the speed it is held at on a grid. */
function launchRpm(def: CarDefinition, ground: Ground = {}) {
  const { world, car } = setup(def, ground, 0, { ...AIDS });
  world.simulate(1);
  car.controls.throttle = 1;
  let slipping = 0;
  for (let i = 0; i < 60; i++) {
    world.step(DT);
    if (car.state.clutch > 0.01) slipping = Math.max(slipping, car.state.rpm);
  }
  const grid = setup(def, ground, 0, { ...AIDS });
  grid.world.simulate(1);
  grid.car.holdOnGrid = true;
  grid.car.controls.throttle = 1;
  grid.world.simulate(2);
  return { slipping, held: grid.car.state.rpm };
}

/** Seconds from a standstill to 100, 200 and 300 km/h flat out, and the top speed; from a grid start (revved against the clutch for 2 s) if `grid`. */
function standingStart(def: CarDefinition, grid: boolean, nitro = 0, seconds = 45) {
  const { world, car } = setup(def, {}, 0, { ...AIDS });
  world.simulate(1);
  if (grid) {
    car.holdOnGrid = true;
    car.controls.throttle = 1;
    world.simulate(2);
    car.holdOnGrid = false;
  }
  car.controls.throttle = 1;
  car.nitro = nitro;
  const t0 = world.time;
  let t100 = 0;
  let t200 = 0;
  let t300 = 0;
  let vmax = 0;
  let slip = 0;
  let gear = car.state.gear;
  let shifted = 0;
  const d = def.physics.drivetrain;
  while (world.time - t0 < seconds) {
    world.step(DT);
    const st = car.state;
    const kmh = st.forwardSpeed * 3.6;
    vmax = Math.max(vmax, kmh);
    if (!t100 && kmh >= 100) t100 = world.time - t0;
    if (!t200 && kmh >= 200) t200 = world.time - t0;
    if (!t300 && kmh >= 300) t300 = world.time - t0;
    if (st.gear !== gear) {
      gear = st.gear;
      shifted = world.time;
    }
    // (the engine against the driveline while the clutch is fully in, past the launch and a tenth of a second after a shift: the 30 ms
    // ignition cut leaves the engine 1000 rpm over the next gear's speed for a frame or two as the clutch takes it back)
    if (st.clutch < 0.01 && kmh > 60 && world.time - shifted > 0.1) {
      const wheel = (car.wheels[2].omega + car.wheels[3].omega) / 2;
      slip = Math.max(slip, st.rpm / ((wheel * d.gears[st.gear - 1] * d.finalDrive * 60) / (2 * Math.PI)) - 1);
    }
  }
  return { t100, t200, t300, vmax, slip };
}

/** The gear that has the engine under its upshift speed at `kmh`. */
function gearFor(def: CarDefinition, kmh: number): number {
  const d = def.physics.drivetrain;
  const rpm = (g: number) => (kmh / 3.6 / def.physics.tireRear.radius) * d.gears[g - 1] * d.finalDrive * (60 / (2 * Math.PI));
  let g = 1;
  while (g < d.gears.length && rpm(g) > d.upshiftRpm * 0.97) g++;
  return g;
}

/**
 * What a car holds sideways at a steady `kmh`, as car-metrics' gripAtSpeed has it (no aids, the wheel wound on over 18 s), but in the gear
 * for the speed from the start and with the speed held by a quicker integral. gripAtSpeed starts in first gear, and the Dieci is still short
 * of 250 km/h by the time its gearbox has climbed to fifth: the most it reads there is 4.15 g at 245 km/h.
 */
function latAt(def: CarDefinition, kmh: number): number {
  const world = new PhysicsWorld(createFlatTrack({ wall: 6000, halfWidth: 6000 }));
  const car = world.addVehicle(def);
  car.assists = { abs: false, tcs: 'off', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
  const v0 = kmh / 3.6;
  car.gear = gearFor(def, kmh);
  car.placeOnGround(new Vector3(), new Quaternion(), v0);
  car.setTemperatures(1);
  const lock = Math.min(def.physics.chassis.maxSteer, (20 * Math.PI) / 180);
  let integral = 0.5;
  let filt = 0;
  let best = 0;
  const frames = 18 * 60;
  for (let i = 0; i < frames; i++) {
    const s = car.state;
    const err = v0 - s.forwardSpeed;
    integral = Math.min(1, Math.max(0, integral + err * 0.8 * DT));
    car.controls.throttle = Math.min(1, Math.max(0, integral + 0.4 * err));
    car.controls.brake = err < -2 ? Math.min(0.5, (-err - 2) * 0.1) : 0;
    car.controls.steer = -(Math.min(1, (i / frames) * 1.15) * lock) / def.physics.chassis.maxSteer;
    world.step(DT);
    filt += (Math.abs(s.localAccel.x) / G - filt) * (1 - Math.exp(-DT / 0.3));
    if (i > 60 && filt > best && Math.abs(s.forwardSpeed - v0) < 0.03 * v0) best = filt;
  }
  return best;
}

/**
 * A steady bend at the limit, as a player takes it: the car settled at `kmh` in the gear for it for 1.5 s, then the stick held at 0.5 for
 * 4.5 s through the SteeringFilter at `pedal`, with the aids a player has by default (Standard: ABS, the traction control low, ESC, the
 * steering assist at 0.35). The most body slip (degrees), whether it spun, and the speed at the end.
 */
function bend(def: CarDefinition, kmh: number, pedal = 1): { slipDeg: number; spun: boolean; endKmh: number } {
  const world = new PhysicsWorld(createFlatTrack({ wall: 6000, halfWidth: 6000 }));
  const car = world.addVehicle(def);
  car.assists = carAssists(DEFAULT_SETTINGS.assists);
  car.gear = gearFor(def, kmh);
  car.placeOnGround(new Vector3(), new Quaternion(), kmh / 3.6);
  car.setTemperatures(1);
  for (let i = 0; i < 90; i++) {
    car.controls.throttle = car.state.forwardSpeed < kmh / 3.6 ? 1 : 0.5;
    world.step(DT);
  }
  const filter = new SteeringFilter();
  const fwd = new Vector3();
  const left = new Vector3();
  let slip = 0;
  for (let i = 0; i < 4.5 * 60; i++) {
    const st = car.state;
    car.controls.steer = filter.update(i * DT < 0.3 ? 0 : 0.5, DT, st, def, DEFAULT_SETTINGS.controls);
    car.controls.throttle = pedal;
    car.controls.brake = 0;
    world.step(DT);
    fwd.set(0, 0, 1).applyQuaternion(st.quaternion);
    left.set(1, 0, 0).applyQuaternion(st.quaternion);
    if (st.speed > 5) slip = Math.max(slip, Math.abs(Math.atan2(st.velocity.dot(left), st.velocity.dot(fwd))));
  }
  return { slipDeg: (slip * 180) / Math.PI, spun: slip > 1.2, endKmh: car.state.forwardSpeed * 3.6 };
}

/** Flat out at `kmh` in top gear for a second, then the full pedal to rest: the hardest deceleration over a tenth of a second (g). */
function stopFrom(def: CarDefinition, kmh: number): number {
  const { world, car } = setup(def, {}, kmh / 3.6, { ...AIDS });
  car.gear = def.physics.drivetrain.gears.length;
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

// ── the Dieci in numbers ─────────────────────────────────────────────────────────

describe('the Dieci is what its stats say', () => {
  it('is a 640 kg rear-drive single-seater of 2004 on grooved tyres, with the power and the torque it is sold with, and nothing electric', () => {
    expect(dieci.class).toBe('Formula');
    expect(dieci.drivetrain).toBe('RWD');
    expect(dieci.physics.drivetrain.layout).toBe('RWD');
    expect(dieci.visual.formulaEra).toBe(2004);
    expect(dieci.physics.chassis.mass).toBe(dieci.stats.massKg);
    // (four grooves leave no tread for loose ground: the slick's table of surfaces)
    expect(dieci.physics.tireFront.slick).toBe(1);
    expect(dieci.physics.tireRear.slick).toBe(1);
    const e = dieci.physics.engine;
    expect(peakPower(e).watts / 745.7 / dieci.stats.powerHp).toBeGreaterThan(0.99);
    expect(peakPower(e).watts / 745.7 / dieci.stats.powerHp).toBeLessThan(1.01);
    expect(peakTorque(e)).toBe(dieci.stats.torqueNm);
    // the V10's peak power at 18,500 rpm, under the 19,000 it shifts at and the 19,300 of its limiter
    expect(peakPower(e).rpm).toBe(18500);
    expect(e.electric).toBeUndefined();
    expect(e.turbo).toBeNull();
    expect(dieci.physics.aero.straightMode).toBeUndefined();
  });

  it('does 0-100 in 2.6 s, 200 in 4.7 s and 332 km/h flat out, a second and more ahead of the Volta past 100', () => {
    // (the brief: about 2.5 s, 4.5 s, 8.8 s to 300 and 330 km/h. The probe floors it from the idle, and the engine first revs past 8700 rpm
    // before the clutch bites: from a grid start, held at 10,000 rpm against the clutch as the game's countdown does, it is 2.48 s and 4.50 s.
    // To 300 it takes 9.4 s: the brief's drag, which sets the 332 km/h, leaves no more at 250-300 km/h; 8.8 s would want an eighth less of
    // it, a CdA of 1.1, and 345 km/h flat out)
    const d = dragRun(dieci, 70);
    expect(d.t100!).toBeGreaterThan(2.5);
    expect(d.t100!).toBeLessThan(2.75);
    expect(Math.abs(d.t100! - dieci.stats.zeroTo100)).toBeLessThan(0.15);
    expect(d.t200!).toBeGreaterThan(4.5);
    expect(d.t200!).toBeLessThan(4.8);
    expect(Math.abs(d.vmax - dieci.stats.topSpeedKmh)).toBeLessThan(4);
    const grid = standingStart(dieci, true);
    expect(grid.t100).toBeGreaterThan(2.4);
    expect(grid.t100).toBeLessThan(2.6);
    expect(grid.t200).toBeGreaterThan(4.35);
    expect(grid.t200).toBeLessThan(4.65);
    expect(grid.t300).toBeGreaterThan(9);
    expect(grid.t300).toBeLessThan(9.6);
    // traction-limited off the line, as the Volta is (2.42 s), and from 100 to 200 km/h 2.0 s where the Volta takes 3.2
    const v = dragRun(volta, 70);
    expect(Math.abs(d.t100! - v.t100!)).toBeLessThan(0.3);
    expect(d.t200! - d.t100!).toBeLessThan(v.t200! - v.t100! - 1);
  });

  it('leaves the line at its launch speed, 10,000 rpm, smoothly; every other car where it always was', () => {
    // the launch control holds the engine at EngineSpec.launchRpm on a full throttle, against the clutch on the grid and while it slips
    expect(dieci.physics.engine.launchRpm).toBe(10000);
    const own = launchRpm(dieci);
    expect(own.slipping).toBeGreaterThan(10000);
    expect(own.slipping).toBeLessThan(10450);
    expect(own.held).toBeGreaterThan(10000);
    expect(own.held).toBeLessThan(10450);
    // without the field it is held where a road car is: half the redline, at most 4600, and at least 900 over the idle (4900 for the V10)
    const plain = structuredClone(dieci);
    delete plain.physics.engine.launchRpm;
    const road = launchRpm(plain);
    expect(road.slipping).toBeGreaterThan(4900);
    expect(road.slipping).toBeLessThan(5350);
    // and so it is on a winter circuit, where on studs a launch at 10,000 rpm mostly slips the clutch (on ice the traction control is worth
    // 0.5 s to 100 km/h there, 13.7 s against 14.1 without it, and was worth less than nothing with 110 Nm of engine braking, 14.9 against
    // 14.2; held at 4900 it is worth 1.5 s, 12.5 against 14.0)
    const snow = launchRpm(dieci, { surface: 'snow' });
    expect(snow.held).toBeGreaterThan(4900);
    expect(snow.held).toBeLessThan(5350);
    // and no other car names one
    for (const id of ['vanta-gt', 'kestrel-r', 'ronin-86', 'lmp-x', 'mammoth', 'volta', 'taccola']) expect(getCar(id).physics.engine.launchRpm, id).toBeUndefined();
    // the launch control's clutch takes no more than the tyres hold at rest: the rear wheels run at a steady slip, not in bursts the traction
    // control has to cut; with the traction control off they spin up and the car is at 100 in 2.9 s
    const { world, car } = setup(dieci, {}, 0, { ...AIDS });
    world.simulate(1);
    car.controls.throttle = 1;
    let burst = 0;
    for (let i = 0; i < 60; i++) {
      world.step(DT);
      if (Math.max(car.state.wheels[2].slipRatio, car.state.wheels[3].slipRatio) > 0.2) burst += DT;
    }
    expect(burst).toBeLessThan(0.03);
    const off = dragRun(dieci, 6, {}, 'off');
    expect(off.t100!).toBeGreaterThan(dragRun(dieci, 6).t100! + 0.2);
    expect(off.maxSlip).toBeGreaterThan(1);
  });
});

describe('the Dieci corners and stops like a single-seater of 2004', () => {
  it('holds 2.55-2.72 g on the skidpad, a little short of neutral, a tenth more than the Volta', () => {
    // (the brief: 2.6-2.7 g)
    const pad = skidpad(dieci);
    expect(pad.latG).toBeGreaterThan(2.55);
    expect(pad.latG).toBeLessThan(2.72);
    // (the fronts give up a little first: about three quarters of a degree more slip angle than the rears)
    expect(pad.balanceDeg).toBeGreaterThan(0.3);
    expect(pad.balanceDeg).toBeLessThan(1.2);
    expect(pad.latG).toBeGreaterThan(skidpad(volta).latG * 1.06);
  });

  it('holds 2.7, 3.4 and 4.3 g at 150, 200 and 250 km/h, more than the Volta at every speed', () => {
    // (the brief: 2.7, 3.3 and 4.1 g, give or take a tenth. A grooved tyre loses more of its grip under load than the Volta's slick, a load
    // sensitivity of 0.2 to its 0.12: with 0.12 and the same mu the car pulled the same 4.3 g at 250 km/h but 2.53 g on the skidpad)
    for (const [kmh, lo, hi] of [[150, 2.55, 2.85], [200, 3.25, 3.6], [250, 4.05, 4.5]] as const) {
      const g = latAt(dieci, kmh);
      expect(g, `${kmh} km/h`).toBeGreaterThan(lo);
      expect(g, `${kmh} km/h`).toBeLessThan(hi);
      expect(g, `${kmh} km/h against the Volta`).toBeGreaterThan(latAt(volta, kmh) * 1.05);
    }
  });

  it('stops from 100 km/h in 17.5-19 m, from 200 in 52-57 m, and from 300 at 4.6-5.0 g', () => {
    // (the brief: 18-20 m, 58-60 m and 4.5-5 g. The grip that pulls 3.4 g sideways at 200 km/h stops the car from there in 55 m, at 4.2 g as it
    // passes 200, drag included: a tyre model whose braking and cornering share one friction circle, with ABS at each wheel's own limit. From
    // 300 the brakes, not the tyres, have the last word: a full pedal asks for 4.2 g, the drag adds the rest)
    const b100 = brakeRun(dieci, true, {}, 100);
    const b200 = brakeRun(dieci, true, {}, 200);
    expect(b100.distance).toBeGreaterThan(17.5);
    expect(b100.distance).toBeLessThan(19);
    expect(b200.distance).toBeGreaterThan(52);
    expect(b200.distance).toBeLessThan(57);
    const peak = stopFrom(dieci, 300);
    expect(peak).toBeGreaterThan(4.6);
    expect(peak).toBeLessThan(5);
    // shorter than the Volta's (18.8 and 57.9 m) and harder at the top (4.4 g)
    expect(b100.distance).toBeLessThan(brakeRun(volta, true, {}, 100).distance - 0.4);
    expect(b200.distance).toBeLessThan(brakeRun(volta, true, {}, 200).distance - 2);
    expect(peak).toBeGreaterThan(stopFrom(volta, 300) + 0.2);
  });

  it('flat out at the limit of a steady bend from 150 to 240 km/h it steps out 12-20 degrees with the default aids, caught, where the Volta holds under 5; four fifths of the pedal hold it at 200 km/h, and at 280 it stays planted flat out', () => {
    // (912 hp at 640 kg, twice the Volta's power for its weight on its engine alone: flat out, the rears give up sideways the grip they
    // spend pushing the car on. The traction control reads the rears' slip along the road, not across it, and the stability control catches
    // the slide and takes speed off; changing either would change every car. In the same bend at 100 and 150 km/h the Volta drifts 13-14
    // degrees and the LMP-X 14-15, the Vanta GT 25-26 and the Ronin 86 29-30)
    const rows: string[] = [];
    for (const kmh of [150, 200, 240]) {
      const d = bend(dieci, kmh);
      rows.push(`${kmh} km/h flat out ${d.slipDeg.toFixed(1)} (at ${d.endKmh.toFixed(0)} km/h after 4.5 s)`);
      expect(d.spun, `${kmh} km/h`).toBe(false);
      expect(d.slipDeg, `${kmh} km/h`).toBeGreaterThan(12);
      expect(d.slipDeg, `${kmh} km/h`).toBeLessThan(20);
    }
    for (const kmh of [200, 240]) {
      const v = bend(volta, kmh).slipDeg;
      rows.push(`the Volta at ${kmh} km/h flat out ${v.toFixed(1)}`);
      expect(v, `the Volta at ${kmh} km/h`).toBeLessThan(5);
    }
    const eased = bend(dieci, 200, 0.8).slipDeg;
    const fast = bend(dieci, 280).slipDeg;
    rows.push(`200 km/h at 0.8 of the pedal ${eased.toFixed(1)}, 280 km/h flat out ${fast.toFixed(1)}`);
    expect(eased).toBeLessThan(7);
    expect(fast).toBeLessThan(6);
    if (process.env.DIECI_BEND_LOG) console.log(`dieci bend (degrees of body slip): ${rows.join('; ')}`);
  });

  it('keeps 60-72 % of its grip on a wet road and 50-60 % in standing water, and stops in 1.25-1.65 times the distance', () => {
    const pad = skidpad(dieci).latG;
    const stop = brakeRun(dieci, true).distance;
    for (const [wetness, lo, hi, slo, shi] of [[0.75, 0.6, 0.72, 1.25, 1.45], [1, 0.5, 0.6, 1.4, 1.65]] as const) {
      const share = skidpad(dieci, 60, { wetness }).latG / pad;
      const longer = brakeRun(dieci, true, { wetness }).distance / stop;
      expect(share, `wet ${wetness}`).toBeGreaterThan(lo);
      expect(share, `wet ${wetness}`).toBeLessThan(hi);
      expect(longer, `wet ${wetness}`).toBeGreaterThan(slo);
      expect(longer, `wet ${wetness}`).toBeLessThan(shi);
    }
  });
});

// ── the bottle nitro ─────────────────────────────────────────────────────────────

describe('the Dieci\'s nitro is the bottle', () => {
  it('is held by the clutch and the traction control, takes 200 km/h a second sooner, and runs into seventh gear\'s limiter at 345', () => {
    // (more torque from the engine and a push from the bottle: no motor and no flaps. Off the line the tyres set the pace, the shot or not)
    const plain = standingStart(dieci, false);
    const boosted = standingStart(dieci, false, 1);
    expect(boosted.slip).toBeLessThan(0.005);
    expect(Math.abs(boosted.t100 - plain.t100)).toBeLessThan(0.6);
    expect(boosted.t200).toBeLessThan(plain.t200 - 0.8);
    expect(boosted.t200).toBeGreaterThan(3.4);
    expect(boosted.t200).toBeLessThan(3.8);
    // (seventh gear is 344 km/h at 19,000 rpm, its limiter cuts at 19,300: a tow's top speed, authentic gearing)
    expect(boosted.vmax).toBeGreaterThan(plain.vmax + 10);
    expect(boosted.vmax).toBeGreaterThan(342);
    expect(boosted.vmax).toBeLessThan(349.5);
  });
});

// ── the Dieci on a lap ───────────────────────────────────────────────────────────

describe('the Dieci on a lap', () => {
  // The AI drivers' laps (alien, standing start): the character of the car in lap times. tests/ai.test.ts has every car on all five circuits,
  // dry and in a storm, and holds every one of them to two clean laps; here what the promise gives.
  it('never strikes its floor, hits nothing and needs no reset, on any circuit at full speed, dry or in a storm', () => {
    // (6 cm of travel at 5 cm off the ground: at 332 km/h on the flat the plank is still 30 mm off the road)
    for (const t of TRACKS)
      for (const wetness of [0, 1]) {
        const r = aiLap(t.info.id, dieci, wetness);
        expect(r.resets, `${t.info.id} wet ${wetness}`).toBe(0);
        expect(r.impacts, `${t.info.id} wet ${wetness}`).toBe(0);
        expect(r.floor, `${t.info.id} wet ${wetness}: floor touches`).toBe(0);
      }
  }, 300000);

  it('is 4-7 % quicker than the Volta on the road circuits, dry and in a storm, and quicker than the LMP-X everywhere', () => {
    // (the brief: about 0.945 of the Volta's lap, a 2004 car against a 2026 one on its engine alone. 0.94 on these laps, dry and in a storm:
    // 0.92-0.93 on the fast Aurelia and Brennwald, 0.96 on the tight Kuroyama. On the studded tyres of Isvik grip, not power, sets the pace,
    // and the three cars are within 3.5 % of each other)
    for (const wetness of [0, 1]) {
      let mine = 0;
      let theirs = 0;
      for (const trackId of ROAD) {
        const d = aiLap(trackId, dieci, wetness);
        const v = aiLap(trackId, volta, wetness);
        const l = aiLap(trackId, lmp, wetness);
        expect(d.lap, `${trackId} wet ${wetness} against the Volta`).toBeLessThan(v.lap * 0.98);
        expect(d.lap, `${trackId} wet ${wetness} against the LMP-X`).toBeLessThan(l.lap * 0.95);
        mine += d.lap;
        theirs += v.lap;
      }
      expect(mine / theirs, `wet ${wetness}`).toBeGreaterThan(0.93);
      expect(mine / theirs, `wet ${wetness}`).toBeLessThan(0.96);
    }
    const d = aiLap('isvik', dieci).lap;
    expect(d).toBeLessThan(aiLap('isvik', volta).lap);
    expect(d).toBeLessThan(aiLap('isvik', lmp).lap);
  }, 300000);

  it('keeps to the asphalt in the fast bends', () => {
    for (const trackId of ['aurelia', 'brennwald']) expect(aiLap(trackId, dieci).offEdge, `${trackId}: seconds past the edge`).toBe(0);
  }, 300000);
});

describe('a whole grid of Diecis', () => {
  // The one-make race the game sets up, single-seaters of 900 hp wheel to wheel at 300 km/h: no wall hit and no reset in 48 races of twelve
  // on Aurelia, Kuroyama and Brennwald, dry and wet (PACKSEEDS=1 CAR=dieci SEEDS=0..7 tests/probes/pack.test.ts)
  it('races Aurelia dry and Brennwald in a storm without a wall hit or a reset, and its brake pumps in traffic held where they are', () => {
    // (a brake pump: a brake of 0.3 or more let off and taken back up within a quarter of a second. Alone on these laps the Dieci has none; in
    // traffic it has more than the Volta, 20 and 121 in these two races where twelve Voltas have 1 and 102, 6-20 and 118-138 over seeds 0-3
    // where they have 1-11 and 86-114. At Aurelia 16 of the 20 come in the first braking zone, at 480-580 m: the cars ahead drop in and out of
    // the AI's traffic window from one frame to the next, and with them the speed it caps the car at, so for a frame the car lets off the brake
    // onto the throttle, as twelve Voltas do there at seeds 1 and 3 on half the throttle. In the storm at Brennwald all but one come back on a
    // brake request for a car ahead, as all but two of the Volta's do)
    for (const [trackId, seed, wetness, pumps] of [['aurelia', 0, 0, 36], ['brennwald', 1, 1, 300]] as const) {
      const r = runPack(trackId, 'dieci', 'pro', 12, 1, false, { seed, wetness });
      expect(r.finished, `finished, ${trackId}`).toBe(12);
      expect(r.walls, `wall hits, ${trackId}`).toBe(0);
      expect(r.resets, `resets, ${trackId}`).toBe(0);
      expect(r.offTrack / 12, `seconds off the road per car, ${trackId}`).toBeLessThan(1);
      expect(r.brakePumps, `brake pumps, ${trackId}`).toBeLessThan(pumps);
    }
  }, 600000);
});
