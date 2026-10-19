/**
 * Nitro (src/core/nitro.ts): the tank's rules (two shots a lap, refilled by a new lap and by nothing else), what a shot does to a
 * car's acceleration, and an AI pack that fires its shots on the straights without crashing more than it does without them.
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { getCar } from '../src/cars';
import { NITRO_PER_LAP, NITRO_SECONDS, NitroTank } from '../src/core/nitro';
import { PhysicsWorld, createFlatTrack } from '../src/physics';
import { runPack } from './probes/pack-race';

const DT = 1 / 60;

/** Run the tank for `seconds` on lap `crossings`. */
function burn(t: NitroTank, seconds: number, crossings: number, running = true): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) t.update(DT, crossings, running);
}

describe('nitro tank', () => {
  it('starts with two shots and fires them one at a time', () => {
    const t = new NitroTank();
    t.update(DT, 1, true);
    expect(t.charges).toBe(NITRO_PER_LAP);
    expect(NITRO_PER_LAP).toBe(2);
    expect(t.fire()).toBe(true);
    expect(t.charges).toBe(1);
    expect(t.active).toBe(true);
    // a second press while the first shot burns is nothing
    expect(t.fire()).toBe(false);
    expect(t.charges).toBe(1);
  });

  it('burns for NITRO_SECONDS, ramping the level in and out', () => {
    const t = new NitroTank();
    t.update(DT, 1, true);
    t.fire();
    t.update(DT, 1, true);
    expect(t.level).toBeGreaterThan(0);
    expect(t.level).toBeLessThan(1);
    burn(t, 0.5, 1);
    expect(t.level).toBe(1);
    burn(t, NITRO_SECONDS - 0.5 - 2 * DT, 1);
    expect(t.active).toBe(true);
    burn(t, 3 * DT, 1);
    expect(t.active).toBe(false);
    burn(t, 0.5, 1);
    expect(t.level).toBe(0);
  });

  it('allows only two shots a lap, and a new lap fills the tank again', () => {
    const t = new NitroTank();
    t.update(DT, 1, true);
    t.fire();
    burn(t, NITRO_SECONDS + 0.1, 1);
    expect(t.fire()).toBe(true);
    burn(t, NITRO_SECONDS + 0.1, 1);
    expect(t.charges).toBe(0);
    expect(t.fire()).toBe(false);
    // across the line: lap 2
    t.update(DT, 2, true);
    expect(t.charges).toBe(2);
    expect(t.fire()).toBe(true);
  });

  it('does not carry an unused shot into the next lap', () => {
    const t = new NitroTank();
    t.update(DT, 1, true);
    t.update(DT, 2, true);
    expect(t.charges).toBe(2);
  });

  it('is not filled by backing over the line and driving across it again', () => {
    const t = new NitroTank();
    t.update(DT, 1, true);
    t.fire();
    burn(t, NITRO_SECONDS + 0.1, 1);
    t.fire();
    burn(t, NITRO_SECONDS + 0.1, 1);
    t.update(DT, 0, true); // backwards over the line
    t.update(DT, 1, true); // and forwards again
    expect(t.charges).toBe(0);
  });

  it('a shot burning across the line goes on burning, and the new lap still gets two', () => {
    const t = new NitroTank();
    t.update(DT, 1, true);
    t.fire();
    t.fire(); // (refused: the first is burning)
    burn(t, 1, 1);
    t.update(DT, 2, true);
    expect(t.active).toBe(true);
    expect(t.charges).toBe(2);
  });

  it('fires nothing before the start or after the flag', () => {
    const t = new NitroTank();
    expect(t.fire()).toBe(false); // (never updated: on the grid)
    t.update(DT, 0, false);
    expect(t.ready).toBe(false);
    expect(t.fire()).toBe(false);
    expect(t.charges).toBe(2);
  });

  it('puts the shot out when the car is not racing, and on cancel', () => {
    const t = new NitroTank();
    t.update(DT, 1, true);
    t.fire();
    burn(t, 1, 1);
    t.update(DT, 1, false);
    expect(t.active).toBe(false);
    expect(t.level).toBe(0);
    t.update(DT, 1, true);
    t.fire();
    burn(t, 1, 1);
    t.cancel();
    expect(t.active).toBe(false);
    expect(t.level).toBe(0);
    expect(t.charges).toBe(0);
    t.refill();
    expect(t.charges).toBe(2);
  });
});

describe('nitro in the physics', () => {
  /** Speed gained (m/s) by a car at full throttle for `seconds` from `v0`, with the nitro at `nitro` and the pedal at `throttle`. */
  function gain(carId: string, v0: number, nitro: number, throttle = 1, seconds = NITRO_SECONDS): number {
    const world = new PhysicsWorld(createFlatTrack({}));
    const car = world.addVehicle(getCar(carId));
    car.assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
    car.placeOnGround(new Vector3(0, 0, 0), new Quaternion(), v0);
    car.setTemperatures(1);
    car.controls.throttle = throttle;
    world.simulate(0.5);
    const start = car.state.forwardSpeed;
    car.nitro = nitro;
    for (let i = 0; i < Math.round(seconds / DT); i++) world.step(DT);
    expect(Number.isFinite(car.state.forwardSpeed)).toBe(true);
    return car.state.forwardSpeed - start;
  }

  it('a shot makes every kind of car gain a good deal more speed', () => {
    for (const id of ['vanta-gt', 'kestrel-r', 'ronin-86', 'lmp-x']) {
      const plain = gain(id, 120 / 3.6, 0);
      const boosted = gain(id, 120 / 3.6, 1);
      // (more torque and the bottle's push: about half as much again, and more where the car is short of power)
      expect(boosted, id).toBeGreaterThan(plain * 1.4);
      expect(boosted - plain, id).toBeGreaterThan(6);
    }
  });

  it('pushes nothing when the driver lifts', () => {
    const plain = gain('vanta-gt', 150 / 3.6, 0, 0);
    const boosted = gain('vanta-gt', 150 / 3.6, 1, 0);
    expect(boosted).toBeCloseTo(plain, 1);
  });

  it('shows in the vehicle state for the flames and the camera', () => {
    const world = new PhysicsWorld(createFlatTrack({}));
    const car = world.addVehicle(getCar('vanta-gt'));
    car.placeOnGround(new Vector3(0, 0, 0), new Quaternion(), 20);
    car.nitro = 0.6;
    world.step(DT);
    expect(car.state.nitro).toBeCloseTo(0.6, 6);
  });
});

describe('AI drivers and nitro', () => {
  it('fire their shots, two a lap at most, finish faster and crash no more', () => {
    const laps = 2;
    const n = 6;
    const plain = runPack('aurelia', 'mixed', 'pro', n, laps, false, { seed: 3 });
    const boosted = runPack('aurelia', 'mixed', 'pro', n, laps, false, { seed: 3, nitro: true });
    expect(boosted.finished).toBe(n);
    // (two shots on the run from the grid to the line, and two on each lap)
    const most = NITRO_PER_LAP * (laps + 1);
    // (a driver stuck behind another holds its fire: nobody ahead in its lane is one of the conditions)
    for (const s of boosted.nitroPerCar!) {
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(most);
    }
    expect(boosted.nitroShots!).toBeGreaterThanOrEqual(n * laps);
    expect(boosted.winnerTime).toBeLessThan(plain.winnerTime);
    expect(boosted.resets).toBe(0);
    expect(boosted.walls).toBeLessThanOrEqual(plain.walls + 1);
    expect(boosted.offTrack).toBeLessThanOrEqual(plain.offTrack + 2);
  }, 300000);
});
