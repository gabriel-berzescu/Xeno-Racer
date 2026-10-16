/**
 * Driver aids against a slippery surface: ABS must be able to let a locked wheel go again, and the driveline must not
 * be able to lock the driven axle (engine braking, a downshift) where ABS has no say.
 * Run: npx vitest run tests/driveline-aids.test.ts
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { getCar } from '../src/cars';
import { PhysicsWorld, createFlatTrack } from '../src/physics';

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
