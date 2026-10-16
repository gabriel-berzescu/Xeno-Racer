/**
 * AI and changing weather: AIDriver.setWetness() makes a driver the one that would have been built for the new wetness,
 * and moves it there without jumps in its target speed or its line.
 * Run: npx vitest run tests/ai-weather.test.ts
 */
import { describe, expect, it } from 'vitest';
import { AIDriver } from '../src/ai';
import { getCar } from '../src/cars';
import type { CarControls } from '../src/core/contracts';
import { PhysicsWorld } from '../src/physics';
import { loadTrackRuntime } from '../src/track';

const DT = 1 / 60;

function setup(trackId: string, carId: string, wetness: number) {
  const track = loadTrackRuntime(trackId);
  const def = getCar(carId);
  const world = new PhysicsWorld(track);
  world.wetness = wetness;
  const car = world.addVehicle(def);
  car.assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
  car.placeOnGround(track.grid[0].position, track.grid[0].quaternion, 0);
  car.setTemperatures(1);
  const driver = (w: number) => new AIDriver(track, def, { difficulty: 'pro', seed: 7, wetness: w });
  return { track, def, world, car, driver };
}

const speeds = (ai: AIDriver, length: number) => Array.from({ length: Math.floor(length / 10) }, (_, i) => ai.targetSpeed(i * 10));

describe('AI driver and changing weather', () => {
  for (const [from, to] of [[0, 1], [1, 0], [0.3, 0.8]] as const) {
    it(`a driver built at ${from} and set to ${to} is the driver built at ${to}`, () => {
      const { track, driver } = setup('aurelia', 'vanta-gt', from);
      const built = driver(to);
      const set = driver(from);
      set.setWetness(to, 0);
      // the same speed profile and racing line, point for point
      expect(Array.from(set.profile.v)).toEqual(Array.from(built.profile.v));
      expect(Array.from(set.line.d)).toEqual(Array.from(built.line.d));
      expect(Array.from(set.line.k)).toEqual(Array.from(built.line.k));
      expect(speeds(set, track.length)).toEqual(speeds(built, track.length));
    });
  }

  for (const [from, to] of [[0, 1], [1, 0]] as const) {
    it(`and drives like it (${from} to ${to}, standing start, same inputs)`, () => {
      // one physical car, driven by the driver built for the new weather; a second driver, built for the old weather and
      // then told about the change, sees the same states and must answer with the same controls (and so is in the same
      // state in everything that depends on the water: the grip it assumes, how it follows, how it takes the lane)
      const { world, car, driver } = setup('brennwald', 'vanta-gt', to);
      const built = driver(to);
      const set = driver(from);
      set.setWetness(to, 0);
      const c2: CarControls = { steer: 0, throttle: 0, brake: 0, handbrake: 0, clutch: 0, shift: 0 };
      let worst = 0;
      let top = 0;
      for (let i = 0; i < 60 * 14; i++) {
        built.update(DT, car.state, world.states, car.controls, true);
        set.update(DT, car.state, world.states, c2, true);
        worst = Math.max(worst, Math.abs(c2.steer - car.controls.steer), Math.abs(c2.throttle - car.controls.throttle), Math.abs(c2.brake - car.controls.brake));
        world.step(DT);
        top = Math.max(top, car.state.speed);
      }
      expect(worst).toBe(0);
      expect(top).toBeGreaterThan(40); // (it did drive)
    }, 120000);
  }

  it('moves to the new conditions without a jump in the target speed or the line', () => {
    const { track, world, car, driver } = setup('kuroyama', 'lmp-x', 0);
    const ai = driver(0);
    const dry = speeds(ai, track.length);
    const dryLine = Array.from(ai.line.d);
    const wet = speeds(driver(1), track.length);
    const total = Math.max(...dry.map((v, i) => Math.abs(wet[i] - v)));
    expect(total).toBeGreaterThan(5); // (rain makes a real difference to the target speeds)

    ai.setWetness(1);
    // nothing has moved when the call returns
    expect(speeds(ai, track.length)).toEqual(dry);
    expect(Array.from(ai.line.d)).toEqual(dryLine);

    // then it moves, a little at a time, and gets there in a couple of seconds
    const c: CarControls = { steer: 0, throttle: 0, brake: 0, handbrake: 0, clutch: 0, shift: 0 };
    let prev = dry;
    let prevLine = dryLine;
    let worstStep = 0;
    let worstLineStep = 0;
    let lineMoved = 0;
    for (let i = 0; i < 60 * 2 + 5; i++) {
      ai.update(DT, car.state, world.states, c, false);
      const now = speeds(ai, track.length);
      worstStep = Math.max(worstStep, ...now.map((v, k) => Math.abs(v - prev[k])));
      prev = now;
      const line = Array.from(ai.line.d);
      worstLineStep = Math.max(worstLineStep, ...line.map((d, k) => Math.abs(d - prevLine[k])));
      lineMoved = Math.max(lineMoved, ...line.map((d, k) => Math.abs(d - dryLine[k])));
      prevLine = line;
    }
    expect(worstStep).toBeLessThan(0.02 * total);
    expect(lineMoved).toBeGreaterThan(0.2); // (the wet line keeps further from the kerbs)
    expect(worstLineStep).toBeLessThan(0.02 * lineMoved + 0.005);
    expect(speeds(ai, track.length)).toEqual(wet);
    expect(Array.from(ai.line.d)).toEqual(Array.from(driver(1).line.d));
  }, 120000);

  it('a change that arrives in the middle of another carries on from where the driver is', () => {
    const { track, world, car, driver } = setup('aurelia', 'ronin-86', 0);
    const ai = driver(0);
    const c: CarControls = { steer: 0, throttle: 0, brake: 0, handbrake: 0, clutch: 0, shift: 0 };
    ai.setWetness(1);
    for (let i = 0; i < 60; i++) ai.update(DT, car.state, world.states, c, false); // half way there
    const mid = speeds(ai, track.length);
    ai.setWetness(0.4);
    expect(speeds(ai, track.length)).toEqual(mid); // no jump when the target changes
    for (let i = 0; i < 60 * 2 + 5; i++) ai.update(DT, car.state, world.states, c, false);
    expect(speeds(ai, track.length)).toEqual(speeds(driver(0.4), track.length));
  }, 120000);

  it('asking for the wetness it already has changes nothing, and silly values are clamped', () => {
    const { track, driver } = setup('aurelia', 'kestrel-r', 0.5);
    const ai = driver(0.5);
    const before = speeds(ai, track.length);
    ai.setWetness(0.5);
    expect(speeds(ai, track.length)).toEqual(before);
    ai.setWetness(7, 0);
    expect(speeds(ai, track.length)).toEqual(speeds(driver(1), track.length));
    ai.setWetness(Number.NaN, 0);
    expect(speeds(ai, track.length)).toEqual(speeds(driver(0), track.length));
  }, 120000);

  it('a car keeps to the road while the rain comes in and goes again', () => {
    // wetness 0 -> 1 in steps of 0.05 every two seconds and back down again, announced to the track and to the driver
    const { track, world, car, driver } = setup('brennwald', 'vanta-gt', 0);
    const ai = driver(0);
    ai.prepareWeather();
    let worst = 0;
    let resets = 0;
    let top = 0;
    let dir = 1;
    for (let i = 0; i < 60 * 110; i++) {
      if (i % 120 === 0) {
        if (world.wetness >= 1) dir = -1;
        world.wetness = Math.min(1, Math.max(0, world.wetness + 0.05 * dir));
        ai.setWetness(world.wetness);
      }
      ai.update(DT, car.state, world.states, car.controls, true);
      if (ai.needsReset) resets++;
      world.step(DT);
      top = Math.max(top, car.state.speed);
      const j = Math.min(track.count - 1, Math.round(ai.s / track.spacing));
      worst = Math.max(worst, Math.abs(ai.d) - Math.max(track.widthLeft[j], track.widthRight[j]));
    }
    expect(resets).toBe(0);
    expect(worst).toBeLessThan(1); // (never more than a metre outside the asphalt)
    expect(top).toBeGreaterThan(50);
  }, 300000);
});
