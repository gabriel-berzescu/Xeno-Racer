import { writeFileSync } from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { it } from 'vitest';
import { getCar } from '../src/cars';
import { PhysicsWorld, createFlatTrack } from '../src/physics';
it.skipIf(!process.env.CAR)('probe launch (set CAR=<id>)', () => {
  const def = getCar(process.env.CAR ?? 'vanta-gt');
  const world = new PhysicsWorld(createFlatTrack());
  const car = world.addVehicle(def);
  car.assists = { abs: true, tcs: (process.env.TCS as any) ?? 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
  car.placeOnGround(new Vector3(), new Quaternion(), 0);
  car.setTemperatures(1);
  world.simulate(1);
  car.controls.throttle = 1;
  const rows: string[] = [];
  for (let i = 0; i < 60 * 6; i++) {
    world.step(1 / 60);
    if (i % 12 === 0) {
      const s = car.state; const rl = s.wheels[2];
      rows.push(`t=${(i / 60).toFixed(2)} v=${(s.forwardSpeed * 3.6).toFixed(1)} rpm=${s.rpm.toFixed(0)} g=${s.gear} thr=${s.throttle.toFixed(2)} clutch=${s.clutch.toFixed(2)} boost=${s.boost.toFixed(2)} kRL=${rl.slipRatio.toFixed(3)} loadR=${(rl.load).toFixed(0)} fxR=${rl.forceLong.toFixed(0)} ax=${(s.localAccel.z / 9.81).toFixed(2)}g tcs=${s.tcsActive}`);
    }
  }
  writeFileSync('.cache/probe.txt', rows.join('\n'));
});
