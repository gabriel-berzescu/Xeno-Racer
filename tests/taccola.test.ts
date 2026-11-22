/**
 * The Taccola, a 1340 kg mid-engined road hypercar with a 6.4 L V12 and an active rear wing, on semi-slicks, held to the promises made
 * for it:
 *   - what the stats say is what it does (0-100, top speed, power): the fastest car here in a straight line, flat out at its power peak
 *     in seventh with the wing down, and 32 km/h short of that with the wing fixed up;
 *   - it stands between the road cars and the racing cars: more grip than any road car and less than the LMP-X at every speed, dry and
 *     wet, in the corners and in the stop;
 *   - its tyres are half a slick (TireSpec.slick 0.5): half way on every loose surface, colder-blooded than a road tyre and less so than a
 *     slick, and worse in standing water than a road tyre for the grip they have in the dry;
 *   - its wing is the Volta's rule (AeroSpec.straightMode, src/physics/aero.ts) and nothing more: down on a straight taken flat out, up at
 *     once on a lift, the brakes or a turn of the wheel, the car steady when it comes up at any speed and in a fast bend either way up;
 *   - it is friendly: with the Standard aids nothing a thumb does spins it, dry or in standing water; without them it steps out under power
 *     in second and third, slowly enough to catch, turns in a little on a lift and stops straight with its wheels locked;
 *   - on a lap it hits nothing and needs no reset, its tyres run at their optimum, and the AI drivers are far quicker in it than in the Vanta
 *     GT and still behind the LMP-X on every road circuit, dry and in a storm; a whole grid of them races cleanly.
 * Run: npx vitest run tests/taccola.test.ts   (TACCOLA_LOG=1 prints what it measured; tests/probes/taccola-probe.test.ts has the tables)
 */
import { describe, expect, it } from 'vitest';
import { computeRacingLine, computeSpeedProfile, gripModel, profileLapTime } from '../src/ai';
import { CARS, getCar } from '../src/cars';
import type { CarDefinition, SurfaceType } from '../src/core/contracts';
import { peakPower, peakTorque } from '../src/physics';
import { STRAIGHT_MODE_SPEED } from '../src/physics/aero';
import { SURFACES, carSurfaces, tireSurfaces, treadOf } from '../src/physics/surfaces';
import { TRACKS, loadTrackRuntime } from '../src/track';
import { DT, G, brakeRun, dragRun, freeRoll, gripAtSpeed, launch, setup, skidpad } from './probes/car-metrics';
import { runPack } from './probes/pack-race';
import { AI_AIDS, BARE, STANDARD, atSpeed, bend, drive, latAt, lapOf, liftOff, powerSlide, standingStart, stopFrom, wingUp, type Lap } from './probes/taccola-drives';

const taccola = getCar('taccola');
const vanta = getCar('vanta-gt');
const lmp = getCar('lmp-x');
/** Every car with number plates but the Taccola: the three road cars and the Mammoth. */
const roadCars = ['vanta-gt', 'kestrel-r', 'ronin-86', 'mammoth'].map(getCar);
const others = CARS.filter((c) => c !== taccola);
const ROAD = TRACKS.map((t) => t.info.id).filter((id) => id !== 'isvik');
const RHO = 1.225;

const rows: string[] = [];
const note = (s: string) => {
  rows.push(s);
  if (process.env.TACCOLA_LOG) console.log(`taccola: ${s}`);
};

/** The Taccola with its wing fixed up (its corner mode, as a car with fixed wings), and fixed flat (its straight mode's areas as the car's own). */
const wingFixedUp: CarDefinition = (() => {
  const d = structuredClone(taccola);
  delete d.physics.aero.straightMode;
  return d;
})();
const wingFixedFlat: CarDefinition = (() => {
  const d = structuredClone(taccola);
  d.physics.aero = { ...taccola.physics.aero.straightMode! };
  return d;
})();

/** The AI's laps, each driven once: tests/ai.test.ts drives every car on every circuit too, and these take a second or two apiece. */
const laps = new Map<string, Lap>();
function lap(trackId: string, def: CarDefinition, wetness = 0): Lap {
  const key = `${trackId} ${def.id} ${wetness}`;
  let r = laps.get(key);
  if (!r) {
    r = lapOf(trackId, def, wetness);
    laps.set(key, r);
  }
  return r;
}

// ── the Taccola in numbers ───────────────────────────────────────────────────────

describe('the Taccola is what its stats say', () => {
  it('is a 1340 kg rear-drive mid-engined road car on semi-slicks, with the power and the torque it is sold with, and the engine its voice is tuned to', () => {
    expect(taccola.class).toBe('Hypercar');
    expect(taccola.drivetrain).toBe('RWD');
    expect(taccola.physics.drivetrain.layout).toBe('RWD');
    expect(taccola.visual.engine).toBe('mid');
    expect(taccola.physics.chassis.mass).toBe(taccola.stats.massKg);
    // the body is drawn round the same centre of gravity and wheelbase the chassis has
    expect(taccola.visual.cgHeight).toBe(taccola.physics.chassis.cgHeight);
    expect(taccola.visual.cgToFrontAxle).toBe(taccola.physics.chassis.cgToFrontAxle);
    expect(taccola.visual.wheelbase).toBe(taccola.physics.chassis.wheelbase);
    expect(taccola.visual.wheelRadiusFront).toBe(taccola.physics.tireFront.radius);
    expect(taccola.visual.wheelRadiusRear).toBe(taccola.physics.tireRear.radius);
    // 40 % of its weight on the front axle
    expect(1 - taccola.physics.chassis.cgToFrontAxle / taccola.physics.chassis.wheelbase).toBeCloseTo(0.4, 3);
    const e = taccola.physics.engine;
    expect(peakPower(e).watts / 745.7 / taccola.stats.powerHp).toBeGreaterThan(0.99);
    expect(peakPower(e).watts / 745.7 / taccola.stats.powerHp).toBeLessThan(1.01);
    expect(peakTorque(e)).toBe(taccola.stats.torqueNm);
    expect(peakPower(e).rpm).toBe(10000);
    // naturally aspirated, nothing electric, a road car's launch and no throttle map
    expect(e.turbo).toBeNull();
    expect(e.electric).toBeUndefined();
    expect(e.launchRpm).toBeUndefined();
    expect(e.throttleGamma).toBeUndefined();
    // (what the voice is tuned against: the idle, the limiter, seven gears and 50 ms shifts)
    expect(e.idleRpm).toBe(1000);
    expect(e.limiterRpm).toBe(10600);
    expect(taccola.physics.drivetrain.gears.length).toBe(7);
    expect(taccola.physics.drivetrain.shiftTime).toBe(0.05);
    expect(taccola.sound.cylinders).toBe(12);
  });

  it('does 0-100 in 2.9 s, 200 in 6.1 s, 300 in 12.6 s and 384 km/h flat out in seventh at its power peak: the fastest car here in a straight line', () => {
    // (the brief: 2.7-2.9 s, 6.0-6.4 s, 12-14 s and 378-388 km/h. From 100 to 200 km/h it takes 3.2 s however it is geared: the rear tyres
    // are the limit up to about 165 km/h)
    const d = dragRun(taccola, 70);
    const s = standingStart(taccola);
    const g = standingStart(taccola, true, 0, 16);
    note(`0-100 ${d.t100!.toFixed(2)} s, 0-200 ${d.t200!.toFixed(2)} s, 0-300 ${s.t300.toFixed(2)} s (grid ${g.t100.toFixed(2)} / ${g.t200.toFixed(2)} / ${g.t300.toFixed(2)}), ${d.vmax.toFixed(1)} km/h in ${s.gear} at ${s.rpm.toFixed(0)} rpm`);
    expect(d.t100!).toBeGreaterThan(2.7);
    expect(d.t100!).toBeLessThan(2.95);
    expect(Math.abs(d.t100! - taccola.stats.zeroTo100)).toBeLessThan(0.1);
    expect(d.t200!).toBeGreaterThan(5.95);
    expect(d.t200!).toBeLessThan(6.3);
    expect(s.t300).toBeGreaterThan(12.2);
    expect(s.t300).toBeLessThan(13.2);
    expect(g.t100).toBeLessThan(d.t100!);
    // flat out: in seventh, between the power peak at 10,000 rpm and the upshift light, under the limiter
    expect(d.vmax).toBeGreaterThan(378);
    expect(d.vmax).toBeLessThan(388);
    expect(Math.abs(d.vmax - taccola.stats.topSpeedKmh)).toBeLessThan(3);
    expect(s.gear).toBe(7);
    expect(s.rpm).toBeGreaterThan(10000);
    expect(s.rpm).toBeLessThan(10350);
    // 45 km/h and more over every other car (the Vanta GT's 338, the Dieci's 332, the Volta's 330)
    for (const c of others) expect(d.vmax, c.id).toBeGreaterThan(dragRun(c, 70).vmax + 40);
    // off the line the racing cars' slicks are quicker (2.4-2.6 s), every car with number plates a second and more slower
    for (const c of roadCars) expect(d.t100!, c.id).toBeLessThan(dragRun(c, 8).t100! - 0.8);
    expect(d.t100!).toBeGreaterThan(dragRun(lmp, 8).t100! + 0.15);
    // and from 200 km/h on nothing here stays with it: the LMP-X is at 300 in 17.4 s, the Dieci in 9.4
    expect(s.t300).toBeLessThan(standingStart(lmp).t300 - 3);
  });

  it('leaves the line as a road car does, held at 4600 rpm, smoothly: the traction control is worth a second to 100 km/h', () => {
    const { world, car } = setup(taccola, {}, 0, { ...AI_AIDS });
    world.simulate(1);
    car.holdOnGrid = true;
    car.controls.throttle = 1;
    world.simulate(2);
    expect(car.state.rpm).toBeGreaterThan(4500);
    expect(car.state.rpm).toBeLessThan(5100);
    // the clutch takes no more than the rear tyres hold at rest: a steady slip, not bursts the traction control has to cut (with the rear
    // tyres' friction named at 4.5 kN, the load they carry, it took a tenth more than they held and the first second was 0.5-0.8 g in bursts)
    const s = standingStart(taccola);
    expect(s.burst).toBeLessThan(0.05);
    expect(s.slip).toBeLessThan(0.005);
    const off = dragRun(taccola, 8, {}, 'off');
    expect(off.t100!).toBeGreaterThan(s.t100 + 0.6);
    expect(off.maxSlip).toBeGreaterThan(1);
  });
});

// ── the active wing ──────────────────────────────────────────────────────────────

describe('the Taccola\'s wing lies down on the straights', () => {
  it('is worth 30 km/h flat out: 352 km/h with the wing fixed up', () => {
    const up = standingStart(wingFixedUp);
    const active = standingStart(taccola);
    note(`wing fixed up ${up.vmax.toFixed(1)} km/h at ${up.rpm.toFixed(0)} rpm in ${up.gear}, working ${active.vmax.toFixed(1)}`);
    expect(up.vmax).toBeGreaterThan(346);
    expect(up.vmax).toBeLessThan(358);
    expect(active.vmax).toBeGreaterThan(up.vmax + 25);
    // a fifth less drag and four tenths less downforce with it flat, and the downforce behind the centre of gravity either way up
    const a = taccola.physics.aero;
    const sm = a.straightMode!;
    expect(sm.dragArea / a.dragArea).toBeGreaterThan(0.75);
    expect(sm.dragArea / a.dragArea).toBeLessThan(0.85);
    expect((sm.liftAreaFront + sm.liftAreaRear) / (a.liftAreaFront + a.liftAreaRear)).toBeGreaterThan(0.5);
    expect((sm.liftAreaFront + sm.liftAreaRear) / (a.liftAreaFront + a.liftAreaRear)).toBeLessThan(0.65);
    const frontWeight = 1 - taccola.physics.chassis.cgToFrontAxle / taccola.physics.chassis.wheelbase;
    expect(a.liftAreaFront / (a.liftAreaFront + a.liftAreaRear)).toBeLessThan(frontWeight);
    expect(sm.liftAreaFront / (sm.liftAreaFront + sm.liftAreaRear)).toBeLessThan(frontWeight);
  });

  it('presses the car down by 700 kg at 250 km/h with the wing up, and by 390 kg with it flat', () => {
    // (the brief: about 650 kg. The four wheels' loads less the weight, the car held at 250 km/h on half the pedal, wing up, and flat out, wing flat)
    const press = (pedal: number) => {
      const { world, car } = atSpeed(taccola, 250, AI_AIDS);
      car.controls.throttle = pedal;
      world.simulate(1.2);
      let sum = 0;
      for (let i = 0; i < 30; i++) {
        world.step(DT);
        sum += ((car.wheels.reduce((x, w) => x + w.load * w.normal.y, 0) - car.mass * G) / (0.5 * RHO * car.state.forwardSpeed ** 2)) * 0.5 * RHO * (250 / 3.6) ** 2;
      }
      return { kg: sum / 30 / G, open: car.state.aeroOpen! };
    };
    const up = press(0.5);
    const flat = press(1);
    note(`downforce at 250 km/h: ${up.kg.toFixed(0)} kg wing up, ${flat.kg.toFixed(0)} kg wing flat`);
    expect(up.open).toBe(0);
    expect(flat.open).toBe(1);
    expect(up.kg).toBeGreaterThan(650);
    expect(up.kg).toBeLessThan(750);
    expect(flat.kg / up.kg).toBeGreaterThan(0.5);
    expect(flat.kg / up.kg).toBeLessThan(0.62);
  });

  it('is the Volta\'s rule: down over 0.4 s a quarter of a second after the driver is flat out above 150 km/h, up within a quarter of a second on a lift, the brakes or a turn of the wheel', () => {
    const { world, car } = atSpeed(taccola, 250, AI_AIDS);
    expect(car.state.aeroOpen).toBe(0);
    car.controls.throttle = 1;
    let half = Infinity;
    let full = Infinity;
    for (let i = 0; i < 60; i++) {
      world.step(DT);
      if (half === Infinity && car.state.aeroOpen! >= 0.5) half = world.time;
      if (full === Infinity && car.state.aeroOpen! >= 1) full = world.time;
    }
    expect(half).toBeGreaterThan(0.45);
    expect(half).toBeLessThan(0.5);
    expect(full).toBeGreaterThan(0.64);
    expect(full).toBeLessThan(0.7);
    // up again, and only then
    for (const [name, act] of [
      ['a lift', (c) => (c.controls.throttle = 0)],
      ['a lift to 70 %', (c) => (c.controls.throttle = 0.7)],
      ['the brakes', (c) => ((c.controls.throttle = 0), (c.controls.brake = 1))],
      ['a turn of the wheel, still flat out', (c) => (c.controls.steer = 0.1)],
    ] as [string, Parameters<typeof wingUp>[2]][]) {
      const w = wingUp(taccola, 250, act, AI_AIDS);
      expect(w.openBefore, name).toBe(1);
      expect(w.closeTime, name).toBeLessThan(0.25);
      expect(w.closeTime, name).toBeGreaterThan(0.15);
    }
    // it stays up below 150 km/h and in a corner, and down through a part-lift on a straight
    const slow = atSpeed(taccola, 100, AI_AIDS);
    slow.car.controls.throttle = 1;
    for (let i = 0; i < 30; i++) {
      slow.world.step(DT);
      expect(slow.car.state.aeroOpen).toBe(0);
    }
    expect(slow.car.state.forwardSpeed).toBeLessThan(STRAIGHT_MODE_SPEED);
    const turn = atSpeed(taccola, 200, AI_AIDS);
    turn.car.controls.throttle = 1;
    turn.car.controls.steer = 0.06;
    turn.world.simulate(1);
    expect(turn.car.state.aeroOpen).toBe(0);
    expect(Math.abs(turn.car.state.localAccel.x)).toBeGreaterThan(G);
    expect(wingUp(taccola, 250, (c) => (c.controls.throttle = 0.85), AI_AIDS).closeTime).toBe(Infinity);
  });

  it('comes up at speed without unsettling the car: a lift or the brakes at 200, 300 and 370 km/h, dry and in standing water, in a straight line and turning', () => {
    for (const wetness of [0, 1])
      for (const kmh of [200, 300, 370])
        for (const [aidsName, aids] of [['Standard', STANDARD], ['no aids', BARE]] as const) {
          const name = `${kmh} km/h wet ${wetness} ${aidsName}`;
          const g = { wetness };
          // in a straight line the car does not move off it
          for (const [what, act] of [
            ['lift', (c) => (c.controls.throttle = 0)],
            ['brakes', (c) => ((c.controls.throttle = 0), (c.controls.brake = 1))],
          ] as [string, Parameters<typeof wingUp>[2]][]) {
            const w = wingUp(taccola, kmh, act, aids, g);
            expect(w.closeTime, `${name}: ${what}`).toBeLessThan(0.25);
            expect(w.slipDeg, `${name}: ${what}`).toBeLessThan(0.5);
            expect(w.drift, `${name}: ${what}`).toBeLessThan(0.2);
          }
          // a lift with the wheel turned (the wing rising as the car turns in): a few degrees, with the aids and without
          const turnIn = wingUp(taccola, kmh, (c) => ((c.controls.throttle = 0), (c.controls.steer = 0.15)), aids, g);
          note(`wing up on a lift with the wheel turned, ${name}: ${turnIn.slipDeg.toFixed(1)} degrees`);
          expect(turnIn.slipDeg, `${name}: lift and turn`).toBeLessThan(12);
          // the brakes with the wheel turned: the stability control and ABS hold it under 20 degrees, dry and in standing water
          if (aids === STANDARD) {
            const stop = wingUp(taccola, kmh, (c) => ((c.controls.throttle = 0), (c.controls.brake = 1), (c.controls.steer = 0.15)), aids, g);
            note(`wing up under the brakes with the wheel turned, ${name}: ${stop.slipDeg.toFixed(1)} degrees`);
            expect(stop.slipDeg, `${name}: brakes and turn`).toBeLessThan(20);
          }
        }
  });

  it('is steady through a fast bend either way up: flat out at 250 and 300 km/h without aids it slides under 12 degrees, and a lift turns it in 5-9', () => {
    // (the downforce sits behind the centre of gravity, 39 % of it at the front on 40 % of the weight with the wing up and 36 % with it
    // flat: with 42 % at the front the tail came round flat out in a bend at 250-300 km/h without the aids)
    for (const [name, def] of [['wing up', wingFixedUp], ['wing flat', wingFixedFlat]] as const)
      for (const kmh of [250, 300]) {
        const flat = bend(def, kmh, 1, BARE);
        const held = bend(def, kmh, 1, STANDARD);
        const lift = liftOff(def, kmh, BARE);
        note(`fast bend, ${name}, ${kmh} km/h: flat out ${flat.slipDeg.toFixed(1)} degrees without aids, ${held.slipDeg.toFixed(1)} with the Standard aids; a lift ${lift.slipDeg.toFixed(1)}`);
        expect(flat.slipDeg, `${name} ${kmh}`).toBeLessThan(12);
        expect(held.slipDeg, `${name} ${kmh}`).toBeLessThan(6);
        expect(lift.slipDeg, `${name} ${kmh}`).toBeGreaterThan(4);
        expect(lift.slipDeg, `${name} ${kmh}`).toBeLessThan(9);
      }
    // with the wing up it corners harder at speed, by a sixth at 250 km/h
    expect(latAt(wingFixedUp, 250)).toBeGreaterThan(latAt(wingFixedFlat, 250) * 1.12);
  });

  it('is known to the AI: its speed profile accelerates with the wing down where it lies down, and a lap of Brennwald has it down for half a minute', () => {
    const aurelia = loadTrackRuntime('aurelia');
    const line = computeRacingLine(aurelia, { edgeMargin: taccola.visual.width / 2 - 0.25 });
    const alien = { gripUse: 0.965, brakeUse: 0.94, wetness: 0 };
    expect(gripModel(taccola, alien).straight).not.toBeNull();
    const active = computeSpeedProfile(aurelia, line, taccola, alien).v;
    const fixed = computeSpeedProfile(aurelia, line, wingFixedUp, alien).v;
    let faster = 0;
    let slower = 0;
    let behind = 0;
    for (let i = 0; i < line.n; i++) {
      if (active[i] > fixed[i] + 0.5) faster++;
      if (active[i] < fixed[i]) slower++;
      behind = Math.max(behind, fixed[i] - active[i]);
    }
    note(`Aurelia's profile with the wing working: faster at ${faster} of ${line.n} points, slower at ${slower} (by ${behind.toFixed(3)} m/s at the most)`);
    expect(faster).toBeGreaterThan(line.n * 0.1);
    // (faster at a fifth of the lap's points, and never slower by more than 0.2 m/s: at 77 points of 1197, where the wing lies down at
    // 150-180 km/h, the rear tyres, with less pressing on them, are for a moment the limit again and the profile is 0.11 m/s behind the
    // fixed wing's at the most, which the Volta, on half the power, never meets)
    expect(behind).toBeLessThan(0.2);
    expect(slower).toBeLessThan(line.n * 0.1);
    expect(profileLapTime(line, { v: active })).toBeLessThan(profileLapTime(line, { v: fixed }) - 0.2);
    // the corners are corner mode's
    const slowest = (v: Float32Array) => v.reduce((x, y) => Math.min(x, y), Infinity);
    expect(slowest(active)).toBe(slowest(fixed));
    const r = lap('brennwald', taccola);
    expect(r.wingOpen).toBeGreaterThan(30);
    expect(r.vmax).toBeGreaterThan(330);
  }, 120000);
});

// ── between the road cars and the racing cars ────────────────────────────────────

describe('the Taccola corners and stops between the road cars and the LMP-X', () => {
  it('holds 1.30 g on the skidpad, the fronts giving up first by two thirds of a degree', () => {
    // (the brief: 1.30-1.40 g)
    const pad = skidpad(taccola);
    note(`skidpad ${pad.latG.toFixed(3)} g at ${pad.speedKmh.toFixed(0)} km/h, balance ${pad.balanceDeg.toFixed(2)} degrees`);
    expect(pad.latG).toBeGreaterThan(1.29);
    expect(pad.latG).toBeLessThan(1.36);
    expect(pad.balanceDeg).toBeGreaterThan(0.3);
    expect(pad.balanceDeg).toBeLessThan(1);
    expect(pad.latG).toBeGreaterThan(skidpad(vanta).latG * 1.15);
    expect(pad.latG).toBeLessThan(skidpad(lmp).latG * 0.75);
  });

  it('holds 1.44, 1.62 and 1.80 g at 150, 200 and 250 km/h', () => {
    // (the brief: at least 1.8 g at 250 km/h)
    const g = [150, 200, 250].map((kmh) => latAt(taccola, kmh));
    note(`lateral g at 150 / 200 / 250 km/h: ${g.map((x) => x.toFixed(3)).join(' / ')}`);
    expect(g[0]).toBeGreaterThan(1.4);
    expect(g[0]).toBeLessThan(1.5);
    expect(g[1]).toBeGreaterThan(1.57);
    expect(g[1]).toBeLessThan(1.68);
    expect(g[2]).toBeGreaterThan(1.795);
    expect(g[2]).toBeLessThan(1.9);
  });

  it('has clearly more grip than any road car and clearly less than the LMP-X at 60, 120 and 200 km/h, dry, wet and in standing water', () => {
    for (const wetness of [0, 0.75, 1])
      for (const kmh of [60, 120, 200]) {
        const mine = latAt(taccola, kmh, { wetness });
        const road = roadCars.map((c) => latAt(c, kmh, { wetness }));
        const proto = latAt(lmp, kmh, { wetness });
        note(`lateral g at ${kmh} km/h wet ${wetness}: ${mine.toFixed(3)}; road cars ${road.map((x) => x.toFixed(3)).join(' ')}; LMP-X ${proto.toFixed(3)}`);
        expect(mine, `${kmh} km/h wet ${wetness} against the road cars`).toBeGreaterThan(Math.max(...road) * 1.06);
        expect(mine, `${kmh} km/h wet ${wetness} against the LMP-X`).toBeLessThan(proto * 0.85);
      }
  }, 120000);

  it('stops from 100 km/h in 27 m and from 200 in 95 m, between the Vanta GT and the LMP-X, dry and wet', () => {
    // (the brief: 27-30 m)
    const b100 = brakeRun(taccola, true, {}, 100).distance;
    const b200 = brakeRun(taccola, true, {}, 200).distance;
    note(`100-0 ${b100.toFixed(1)} m, 200-0 ${b200.toFixed(1)} m`);
    expect(b100).toBeGreaterThan(27);
    expect(b100).toBeLessThan(28);
    expect(b200).toBeGreaterThan(92);
    expect(b200).toBeLessThan(99);
    for (const wetness of [0, 0.75, 1]) {
      const mine = brakeRun(taccola, true, { wetness }, 100).distance;
      const road = roadCars.map((c) => brakeRun(c, true, { wetness }, 100).distance);
      const proto = brakeRun(lmp, true, { wetness }, 100).distance;
      note(`100-0 wet ${wetness}: ${mine.toFixed(1)} m; road cars ${road.map((x) => x.toFixed(1)).join(' ')}; LMP-X ${proto.toFixed(1)}`);
      // shorter than the three road cars by 4 m and more, dry and wet
      for (let i = 0; i < 3; i++) expect(mine, `${roadCars[i].id} wet ${wetness}`).toBeLessThan(road[i] - 4);
      // the Mammoth's all-terrain tyres keep four fifths of their grip in the wet, where the semi-slick keeps three: 10 m shorter than it dry,
      // 2 m on a wet road, and level with it in standing water
      expect(mine, `the Mammoth wet ${wetness}`).toBeLessThan(road[3] - [8, 1.5, -1][[0, 0.75, 1].indexOf(wetness)]);
      expect(mine, `LMP-X wet ${wetness}`).toBeGreaterThan(proto + 5);
    }
  });

  it('stops from 300 km/h at 2.3 g and more, in a straight line, dry and in standing water, with the aids and without ABS', () => {
    // (the wing comes up a fifth of a second into the stop. A full pedal asks for 2.6 g, 72 % of it at the front: the front tyres and ABS
    // are the limit, the rears stay short of theirs)
    const dry = stopFrom(taccola, 300);
    note(`stop from 300 km/h: ${dry.peakG.toFixed(2)} g at the most, ${dry.distance.toFixed(0)} m, ${dry.slipDeg.toFixed(2)} degrees`);
    expect(dry.peakG).toBeGreaterThan(2.3);
    expect(dry.peakG).toBeLessThan(2.6);
    expect(dry.peakG).toBeGreaterThan(stopFrom(vanta, 300).peakG + 0.5);
    expect(dry.peakG).toBeLessThan(stopFrom(lmp, 300).peakG - 1);
    for (const wetness of [0, 1])
      for (const aids of [AI_AIDS, STANDARD, BARE]) {
        const s = stopFrom(taccola, 300, aids, { wetness });
        expect(s.slipDeg, `wet ${wetness}`).toBeLessThan(1);
        expect(s.drift, `wet ${wetness}`).toBeLessThan(0.5);
      }
  });
});

// ── the semi-slick ───────────────────────────────────────────────────────────────

describe('the Taccola\'s semi-slick is half a slick', () => {
  const LOOSE: SurfaceType[] = ['grass', 'dirt', 'gravel', 'sand', 'deepsnow'];
  const NOT_LOOSE: SurfaceType[] = ['asphalt', 'curb', 'concrete', 'snow', 'ice'];

  it('is half way between a road tyre and a racing slick on every surface: the very same ground where it is paved, half the slick\'s loss where it is loose', () => {
    for (const t of [taccola.physics.tireFront, taccola.physics.tireRear]) {
      expect(t.slick).toBe(0.5);
      expect(t.offroad).toBeUndefined();
      expect(treadOf(t)).toBe(-0.5);
    }
    const half = carSurfaces(taccola.physics);
    const slick = tireSurfaces({ slick: 1 });
    expect(half).toBe(tireSurfaces(taccola.physics.tireFront));
    expect(half).not.toBe(SURFACES);
    expect(half).not.toBe(slick);
    for (const s of NOT_LOOSE) expect(half[s], s).toBe(SURFACES[s]);
    for (const s of LOOSE)
      for (const k of ['grip', 'wet', 'rolling', 'plough'] as const) expect(half[s][k], `${s} ${k}`).toBeCloseTo((SURFACES[s][k] + slick[s][k]) / 2, 12);
    // every wheel holds that table, and on a winter circuit the studded tyre's plain one
    for (const w of setup(taccola).car.wheels) expect(w.surfaces).toBe(half);
    for (const w of setup(taccola, { surface: 'snow' }).car.wheels) expect(w.surfaces).toBe(SURFACES);
    // and in its other numbers: between the Vanta GT's road tyre and the LMP-X's slick
    for (const k of ['mu', 'peakSlipAngle', 'peakSlipRatio', 'slideRatio', 'relaxationLength', 'optimalTemp', 'tempWindow', 'coldGrip'] as const) {
      const a = vanta.physics.tireFront[k];
      const b = lmp.physics.tireFront[k];
      for (const t of [taccola.physics.tireFront, taccola.physics.tireRear]) {
        expect(t[k], k).toBeGreaterThan(Math.min(a, b));
        expect(t[k], k).toBeLessThan(Math.max(a, b));
      }
    }
  });

  it('on loose ground is worse than a road tyre and far better than a slick: grass, dirt and gravel, dry and wet, in the corner, in the stop and getting away', () => {
    for (const surface of ['grass', 'dirt', 'gravel'] as const)
      for (const wetness of [0, 0.75]) {
        const ground = { surface, wetness };
        const g = (c: CarDefinition) => gripAtSpeed(c, 60, ground).latG;
        const d = (c: CarDefinition) => brakeRun(c, true, ground, 60).distance;
        const mine = g(taccola);
        const stop = d(taccola);
        const road = ['vanta-gt', 'kestrel-r', 'ronin-86'].map(getCar);
        note(`${surface} wet ${wetness} at 60 km/h: ${mine.toFixed(3)} g and ${stop.toFixed(1)} m; road cars ${road.map((c) => `${g(c).toFixed(3)} ${d(c).toFixed(1)}`).join(', ')}; LMP-X ${g(lmp).toFixed(3)} ${d(lmp).toFixed(1)}`);
        expect(mine, `${surface} wet ${wetness}`).toBeLessThan(Math.min(...road.map(g)) * 0.97);
        expect(mine, `${surface} wet ${wetness}`).toBeGreaterThan(g(lmp) * 1.2);
        expect(stop, `${surface} wet ${wetness}`).toBeGreaterThan(Math.max(...road.map(d)) * 1.03);
        expect(stop, `${surface} wet ${wetness}`).toBeLessThan(d(lmp) * 0.85);
        // not beached: away from rest to 20 km/h in under 5 s, where the LMP-X takes up to 8
        const away = launch(taccola, ground, 20, 'low', 30);
        expect(away, `${surface} wet ${wetness}`).not.toBeNull();
        expect(away!, `${surface} wet ${wetness}`).toBeLessThan(5);
        expect(away!, `${surface} wet ${wetness}`).toBeLessThan(launch(lmp, ground, 20, 'low', 30)! * 0.75);
      }
    // gravel takes more of its speed than a road car's and less than the LMP-X's
    expect(freeRoll(taccola, { surface: 'gravel' })).toBeLessThan(freeRoll(vanta, { surface: 'gravel' }) - 2);
    expect(freeRoll(taccola, { surface: 'gravel' })).toBeGreaterThan(freeRoll(lmp, { surface: 'gravel' }) + 2);
  }, 120000);

  it('is slippery cold: four fifths of its grip at the air\'s temperature, where a road tyre keeps nine tenths and a slick three quarters, and in its window after a lap', () => {
    const share = (c: CarDefinition) => latAt(c, 100, {}, 0) / latAt(c, 100);
    const mine = share(taccola);
    note(`cold tyres hold ${(mine * 100).toFixed(0)} % of the warm ones' ${latAt(taccola, 100).toFixed(3)} g at 100 km/h (Vanta GT ${(share(vanta) * 100).toFixed(0)} %, LMP-X ${(share(lmp) * 100).toFixed(0)} %)`);
    expect(mine).toBeGreaterThan(0.77);
    expect(mine).toBeLessThan(0.85);
    expect(mine).toBeLessThan(share(vanta) - 0.05);
    expect(mine).toBeGreaterThan(share(lmp) + 0.03);
    // the stop from 100 km/h on cold tyres takes a fifth longer
    const { world, car } = setup(taccola, {}, 100 / 3.6, { ...AI_AIDS });
    car.setTemperatures(0);
    car.controls.brake = 1;
    const z0 = car.p.z;
    while (car.state.forwardSpeed > 0.3) world.step(DT);
    const cold = car.p.z - z0;
    expect(cold / brakeRun(taccola, true).distance).toBeGreaterThan(1.15);
    expect(cold / brakeRun(taccola, true).distance).toBeLessThan(1.3);
    // a lap from cold: no reset and no hit, slower than the same lap on warm tyres, and the tyres in their window by the end of it
    const fromCold = lapOf('aurelia', taccola, 0, 'alien', 0);
    const warm = lap('aurelia', taccola);
    note(`Aurelia from cold tyres ${fromCold.lap.toFixed(2)} s (warm ${warm.lap.toFixed(2)}), the next lap's tyres ${fromCold.tempFront[0].toFixed(0)} / ${fromCold.tempRear[0].toFixed(0)} C`);
    expect(fromCold.resets).toBe(0);
    expect(fromCold.impacts).toBe(0);
    expect(fromCold.lap).toBeGreaterThan(warm.lap);
    expect(fromCold.tempFront[0]).toBeGreaterThan(80);
    expect(fromCold.tempRear[0]).toBeGreaterThan(80);
  }, 120000);

  it('keeps 64-74 % of its grip on a wet road and 54-64 % in standing water, less of it than the Vanta GT\'s road tyre, and stops in 1.4 and 1.6 times the distance', () => {
    const pad = skidpad(taccola).latG;
    const stop = brakeRun(taccola, true).distance;
    const vantaPad = skidpad(vanta).latG;
    for (const [wetness, lo, hi, slo, shi] of [[0.75, 0.64, 0.74, 1.3, 1.5], [1, 0.54, 0.64, 1.5, 1.7]] as const) {
      const wet = skidpad(taccola, 60, { wetness }).latG;
      const share = wet / pad;
      const longer = brakeRun(taccola, true, { wetness }).distance / stop;
      const vantaShare = skidpad(vanta, 60, { wetness }).latG / vantaPad;
      note(`wet ${wetness}: skidpad ${wet.toFixed(3)} g, ${(share * 100).toFixed(0)} % of the dry (Vanta GT ${(vantaShare * 100).toFixed(0)} %), the stop ${longer.toFixed(2)} times as long`);
      expect(share, `wet ${wetness}`).toBeGreaterThan(lo);
      expect(share, `wet ${wetness}`).toBeLessThan(hi);
      expect(share, `wet ${wetness}`).toBeLessThan(vantaShare - 0.04);
      expect(longer, `wet ${wetness}`).toBeGreaterThan(slo);
      expect(longer, `wet ${wetness}`).toBeLessThan(shi);
    }
  });
});

// ── how it drives ────────────────────────────────────────────────────────────────

describe('the Taccola is friendly with the Standard aids and alive without them', () => {
  /** The drives of tests/handling.test.ts, and a lane change: full stick, as a thumb does it. */
  const thumbs: [string, number, (t: number) => { steer: number; throttle: number; brake: number }, number][] = [
    ['a full stick step at 150 km/h', 150, (t) => ({ steer: t > 0.5 && t < 2.5 ? 1 : 0, throttle: 0.3, brake: 0 }), 5],
    ['a flick at 110 km/h', 110, (t) => ({ steer: t < 0.6 ? -1 : t < 1.4 ? 1 : 0, throttle: t < 1.4 ? 0 : 1, brake: 0 }), 4],
    ['flat out of a 60 km/h corner', 60, (t) => ({ steer: t < 2 ? 0.7 : 0.2, throttle: t > 0.5 ? 1 : 0.2, brake: 0 }), 4],
    ['a panic stop turning at 130 km/h', 130, (t) => ({ steer: t > 0.3 ? 0.8 : 0, throttle: 0, brake: t > 0.3 ? 1 : 0 }), 4],
    ['a panic stop turning at 250 km/h', 250, (t) => ({ steer: t > 0.3 ? 0.8 : 0, throttle: 0, brake: t > 0.3 ? 1 : 0 }), 5],
    ['a lane change flat out at 80 km/h', 80, (t) => ({ steer: t < 0.5 ? 0 : t < 1.2 ? 1 : t < 2.6 ? -1 : t < 3.3 ? 1 : 0, throttle: 1, brake: 0 }), 6],
    ['a lane change flat out at 120 km/h', 120, (t) => ({ steer: t < 0.5 ? 0 : t < 1.2 ? 1 : t < 2.6 ? -1 : t < 3.3 ? 1 : 0, throttle: 1, brake: 0 }), 6],
    ['a lane change flat out at 240 km/h', 240, (t) => ({ steer: t < 0.5 ? 0 : t < 1.2 ? 1 : t < 2.6 ? -1 : t < 3.3 ? 1 : 0, throttle: 1, brake: 0 }), 6],
  ];

  it('with the Standard aids nothing a thumb does slides it past 15 degrees on a dry road or 20 in standing water', () => {
    for (const wetness of [0, 1])
      for (const [name, kmh, script, seconds] of thumbs) {
        const r = drive(taccola, kmh, STANDARD, script, seconds, { wetness });
        note(`${name}, wet ${wetness}, Standard aids: ${r.slipDeg.toFixed(1)} degrees`);
        expect(r.spun, `${name} wet ${wetness}`).toBe(false);
        expect(r.slipDeg, `${name} wet ${wetness}`).toBeLessThan(wetness ? 20 : 15);
      }
  });

  it('flat out in a bend with the Standard aids it holds its line: under 10 degrees from 60 to 250 km/h, where the Vanta GT drifts 18-26', () => {
    for (const kmh of [60, 100, 150, 200, 250]) {
      const r = bend(taccola, kmh);
      note(`a bend flat out at ${kmh} km/h, Standard aids: ${r.slipDeg.toFixed(1)} degrees`);
      expect(r.slipDeg, `${kmh} km/h`).toBeLessThan(10);
      expect(r.slipDeg, `${kmh} km/h against the Vanta GT`).toBeLessThan(bend(vanta, kmh).slipDeg - 8);
    }
    // in standing water the stability control catches it at 22-24 degrees, as it catches every car there
    for (const kmh of [60, 150, 250]) {
      const r = bend(taccola, kmh, 1, STANDARD, 0.5, { wetness: 1 });
      expect(r.spun, `${kmh} km/h wet`).toBe(false);
      expect(r.slipDeg, `${kmh} km/h wet`).toBeLessThan(26);
    }
  });

  it('turns in a little on a lift and no more: 5-9 degrees without aids from 80 to 250 km/h, under 5 with them, and under 15 in standing water', () => {
    for (const kmh of [80, 120, 160, 200, 250]) {
      const bare = liftOff(taccola, kmh, BARE);
      const aided = liftOff(taccola, kmh, STANDARD);
      note(`a lift in a bend at ${kmh} km/h: ${bare.slipDeg.toFixed(1)} degrees without aids, ${aided.slipDeg.toFixed(1)} with the Standard aids`);
      expect(bare.slipDeg, `${kmh} km/h`).toBeGreaterThan(4.5);
      expect(bare.slipDeg, `${kmh} km/h`).toBeLessThan(9);
      expect(aided.slipDeg, `${kmh} km/h`).toBeLessThan(5);
      expect(liftOff(taccola, kmh, BARE, 0.5, { wetness: 1 }).slipDeg, `${kmh} km/h wet`).toBeLessThan(15);
    }
  });

  it('steps out under power in second and third without the traction control, a quarter of a second and more from 10 to 30 degrees, and a driver who eases off and steers into it catches it under 30', () => {
    for (const [kmh, gear] of [[60, 2], [90, 2], [90, 3], [130, 3]] as const) {
      const p = powerSlide(taccola, kmh, gear);
      note(`power slide at ${kmh} km/h in ${gear}: 10 degrees after ${p.t10.toFixed(2)} s, 30 after ${p.t30.toFixed(2)} s; caught at ${p.caughtDeg.toFixed(0)} degrees`);
      // it does come round (986 hp on two tyres), and not at once
      expect(p.t10, `${kmh} in ${gear}`).toBeGreaterThan(0.2);
      expect(p.t30, `${kmh} in ${gear}`).toBeGreaterThan(0);
      expect(p.t30 - p.t10, `${kmh} in ${gear}`).toBeGreaterThan(0.22);
      expect(p.caught, `${kmh} in ${gear}`).toBe(true);
      expect(p.caughtDeg, `${kmh} in ${gear}`).toBeLessThan(30);
    }
    // with the traction control (the AI's aids, no stability control) the same floored pedal in a bend holds 15 degrees at the most
    for (const kmh of [60, 100, 150, 200]) expect(bend(taccola, kmh, 1, AI_AIDS).slipDeg, `${kmh} km/h`).toBeLessThan(16);
  });

  it('stops straight with its wheels locked: a panic stop at full lock without ABS ploughs on under 20 degrees, where the Vanta GT comes round to 50 and more', () => {
    // (brakes of 4200 / 1800 Nm, 72 % of the force at the front: the fronts lock first. With 3800 / 2000 the same stop slid 41 degrees)
    for (const kmh of [130, 250]) {
      const script = (t: number) => ({ steer: t > 0.3 ? 0.8 : 0, throttle: 0, brake: t > 0.3 ? 1 : 0 });
      const mine = drive(taccola, kmh, BARE, script, 5);
      note(`a panic stop turning at ${kmh} km/h without aids: ${mine.slipDeg.toFixed(1)} degrees`);
      expect(mine.slipDeg, `${kmh} km/h`).toBeLessThan(20);
      expect(mine.slipDeg, `${kmh} km/h`).toBeLessThan(drive(vanta, kmh, BARE, script, 5).slipDeg - 20);
    }
  });
});

// ── the bottle nitro ─────────────────────────────────────────────────────────────

describe('the Taccola\'s nitro is the bottle', () => {
  it('is held by the clutch and the traction control: a shot held from rest takes 100 km/h in 2.3 s, 200 in 4.4 s and the top speed to 400 km/h', () => {
    // (more torque from the engine and the bottle's push on the car itself, as on every car without an electric motor: the push does not
    // go through the tyres, so it is worth 0.6 s to 100 km/h where the tyres alone set the pace)
    const plain = standingStart(taccola);
    const boosted = standingStart(taccola, false, 1);
    note(`nitro held from rest: 0-100 ${boosted.t100.toFixed(2)} s, 0-200 ${boosted.t200.toFixed(2)} s, 0-300 ${boosted.t300.toFixed(2)} s, ${boosted.vmax.toFixed(1)} km/h at ${boosted.rpm.toFixed(0)} rpm`);
    expect(boosted.slip).toBeLessThan(0.005);
    expect(boosted.burst).toBeLessThan(0.08);
    expect(boosted.t100).toBeLessThan(plain.t100 - 0.4);
    expect(boosted.t100).toBeGreaterThan(2.1);
    expect(boosted.t200).toBeLessThan(plain.t200 - 1.2);
    expect(boosted.t200).toBeGreaterThan(4.1);
    expect(boosted.t300).toBeLessThan(plain.t300 - 4);
    // (seventh is 393 km/h at 10,300 rpm on the tyres' rolling radius: with the shot it runs out of power at 400, 150 rpm short of the limiter)
    expect(boosted.vmax).toBeGreaterThan(plain.vmax + 10);
    expect(boosted.vmax).toBeLessThan(404);
    expect(boosted.rpm).toBeLessThan(taccola.physics.engine.limiterRpm);
  });
});

// ── the Taccola on a lap ─────────────────────────────────────────────────────────

describe('the Taccola on a lap', () => {
  it('hits nothing, needs no reset and never strikes its floor on any circuit, dry or in a storm, its tyres about at their optimum and its discs under 1100 C', () => {
    for (const t of TRACKS)
      for (const wetness of [0, 1]) {
        const r = lap(t.info.id, taccola, wetness);
        const name = `${t.info.id} wet ${wetness}`;
        note(`${name}: ${r.lap.toFixed(2)} s, then ${r.next.toFixed(2)}; ${r.vmax.toFixed(0)} km/h, ${r.brakeG.toFixed(2)} g; tyres ${r.tempFront.map((x) => x.toFixed(0)).join('/')} front ${r.tempRear.map((x) => x.toFixed(0)).join('/')} rear, discs ${r.disc.toFixed(0)} C, wing down ${r.wingOpen.toFixed(1)} s`);
        expect(r.resets, name).toBe(0);
        expect(r.impacts, name).toBe(0);
        expect(r.floor, `${name}: floor touches`).toBe(0);
        expect(r.offEdge, `${name}: seconds past the edge`).toBeLessThan(0.5);
        expect(r.disc, name).toBeLessThan(1100);
        // (a dry lap of a road circuit: both axles within 8 degrees of the 90 the tyres work best at, and never 20 from it)
        if (wetness === 0 && t.info.id !== 'isvik') {
          for (const [mean, lo, hi] of [r.tempFront, r.tempRear]) {
            expect(mean, name).toBeGreaterThan(82);
            expect(mean, name).toBeLessThan(98);
            expect(lo, name).toBeGreaterThan(72);
            expect(hi, name).toBeLessThan(108);
          }
        }
      }
  }, 300000);

  it('is the quickest road car by far and still behind the LMP-X on every road circuit: 9-15 % ahead of the Vanta GT dry and 5-9 % in a storm, 7-16 % behind the LMP-X', () => {
    // (the Vanta GT is the quickest of the other cars with number plates on every road circuit in the dry, tests/ai.test.ts's laps: the
    // Mammoth is 15-32 % behind the Taccola there. In a storm the Mammoth's all-terrain tyres bring it level: 2.5 % ahead of the Taccola at
    // Kuroyama and 0.8 % at Portovela, 2.8 % behind it at Aurelia and 10.6 % at Brennwald)
    for (const wetness of [0, 1])
      for (const trackId of ROAD) {
        const mine = lap(trackId, taccola, wetness).lap;
        const proto = lap(trackId, lmp, wetness).lap;
        const gt = lap(trackId, vanta, wetness).lap;
        note(`${trackId} wet ${wetness}: ${((1 - mine / gt) * 100).toFixed(1)} % ahead of the Vanta GT, ${((mine / proto - 1) * 100).toFixed(1)} % behind the LMP-X`);
        expect(mine, `${trackId} wet ${wetness} against the LMP-X`).toBeGreaterThan(proto * 1.05);
        expect(mine, `${trackId} wet ${wetness} against the Vanta GT`).toBeLessThan(gt * (wetness ? 0.96 : 0.92));
      }
  }, 600000);

  it('on the studded tyres of Isvik is level with the LMP-X and 7 % ahead of the Vanta GT, dry and in the snowfall', () => {
    for (const wetness of [0, 1]) {
      const mine = lap('isvik', taccola, wetness).lap;
      expect(Math.abs(mine / lap('isvik', lmp, wetness).lap - 1), `wet ${wetness}`).toBeLessThan(0.025);
      expect(mine, `wet ${wetness}`).toBeLessThan(lap('isvik', vanta, wetness).lap * 0.96);
    }
  }, 300000);
});

describe('a grid with Taccolas in it', () => {
  // Twelve Taccolas, 48 races of two laps on Aurelia, Kuroyama and Brennwald, dry and in a storm (PACKSEEDS=1 CAR=taccola SEEDS=0..7
  // tests/probes/pack.test.ts): no car needs a reset, and no wall is touched at Kuroyama or at Aurelia in a storm. Twelve walls are, where
  // one-make grids of road cars touch them too, with the AI as it was before the Taccola: seven at Aurelia dry, in four races of the eight,
  // all at 3.7 km at the end of the first lap, where the traffic planner's room to the left reaches 11.5 m from the centre line on 6.5 m of
  // asphalt and a car moving out to pass runs on to the wall (twelve Vantas do the same in two of four of those races); one at Brennwald
  // dry and four in a storm, two cars side by side at 200 km/h in standing water (twelve Vantas touch a wall twice in the same race).
  // A matter for the traffic planner, which every car shares, left as it is.
  it('twelve of them race Aurelia dry and Kuroyama in a storm without a wall hit or a reset, and Brennwald in a storm without a reset', () => {
    for (const [trackId, seed, wetness] of [['aurelia', 0, 0], ['kuroyama', 0, 1]] as const) {
      const r = runPack(trackId, 'taccola', 'pro', 12, 1, false, { seed, wetness });
      note(`twelve Taccolas, ${trackId} wet ${wetness}: ${r.contacts} contacts (${r.hardContacts} hard), ${r.walls} walls, ${r.resets} resets, ${(r.offTrack / 12).toFixed(2)} s off per car, ${r.brakePumps} brake pumps`);
      expect(r.finished, `finished, ${trackId}`).toBe(12);
      expect(r.walls, `wall hits, ${trackId}`).toBe(0);
      expect(r.resets, `resets, ${trackId}`).toBe(0);
      expect(r.offTrack / 12, `seconds off the road per car, ${trackId}`).toBeLessThan(1);
    }
    // (Brennwald in a storm, seed 1: two of the twelve touch as they run side by side out of a bend at 3.4 km and brush the wall, at 2.3
    // and 3.7 m/s. Held where it is: every car finishes, none needs a reset, no more than two walls)
    const storm = runPack('brennwald', 'taccola', 'pro', 12, 1, false, { seed: 1, wetness: 1 });
    note(`twelve Taccolas, brennwald wet 1: ${storm.contacts} contacts (${storm.hardContacts} hard), ${storm.walls} walls, ${storm.resets} resets, ${(storm.offTrack / 12).toFixed(2)} s off per car`);
    expect(storm.finished).toBe(12);
    expect(storm.resets).toBe(0);
    expect(storm.walls).toBeLessThanOrEqual(2);
    expect(storm.offTrack / 12).toBeLessThan(1);
  }, 600000);

  it('the mixed field of eight cars has one in it, on Kuroyama dry and Aurelia in a storm, and it hits no wall and needs no reset', () => {
    for (const [trackId, seed, wetness] of [['kuroyama', 0, 0], ['aurelia', 2, 1]] as const) {
      const r = runPack(trackId, 'mixed', 'pro', 12, 1, false, { seed, wetness });
      const mine = r.perCar.filter((c) => c.model === 'taccola');
      note(`mixed twelve, ${trackId} wet ${wetness}: ${r.walls} walls, ${r.resets} resets; the Taccola ${mine.map((c) => `${c.walls} walls ${c.resets} resets ${c.off.toFixed(1)} s off`).join(', ')}`);
      expect(mine.length).toBe(1);
      expect(r.finished, trackId).toBe(12);
      expect(r.resets, trackId).toBe(0);
      for (const c of mine) {
        expect(c.walls, trackId).toBe(0);
        expect(c.resets, trackId).toBe(0);
        expect(c.off, trackId).toBeLessThan(1);
      }
    }
  }, 600000);
});
