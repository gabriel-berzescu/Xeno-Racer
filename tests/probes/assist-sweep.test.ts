import { writeFileSync } from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { it } from 'vitest';
import { getCar } from '../../src/cars';
import type { Assists, ControlSettings } from '../../src/core/contracts';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import { PhysicsWorld, SteeringFilter, createFlatTrack } from '../../src/physics';
it.skipIf(!process.env.SWEEP)('assist sweep', () => {
  const rows: string[] = [];
  const scripts: Record<string, [number, (t: number) => { steer: number; throttle: number; brake: number }]> = {
    flick110: [110, (t) => ({ steer: t < 0.6 ? -1 : t < 1.4 ? 1 : 0, throttle: t < 1.4 ? 0 : 1, brake: 0 })],
    panic130: [130, (t) => ({ steer: t > 0.3 ? 0.8 : 0, throttle: 0, brake: t > 0.3 ? 1 : 0 })],
    exit60: [60, (t) => ({ steer: t < 2 ? 0.7 : 0.2, throttle: t > 0.5 ? 1 : 0.2, brake: 0 })],
  };
  for (const carId of ['vanta-gt', 'ronin-86', 'lmp-x']) {
    const def = getCar(carId);
    for (const esc of [false, true]) for (const sa of [0.35, 0.5, 0.65]) for (const sens of [0.6, 0.8]) {
      const a: Assists = { ...DEFAULT_SETTINGS.assists, esc, steeringAssist: sa };
      const c: ControlSettings = { ...DEFAULT_SETTINGS.controls, speedSensitivity: sens };
      const res: string[] = [];
      for (const [name, [kmh, script]] of Object.entries(scripts)) {
        const world = new PhysicsWorld(createFlatTrack());
        const car = world.addVehicle(def);
        car.assists = a;
        car.placeOnGround(new Vector3(), new Quaternion(), kmh / 3.6);
        car.setTemperatures(1);
        const f = new SteeringFilter();
        let maxB = 0;
        for (let i = 0; i < 240; i++) {
          const s = script(i / 60);
          car.controls.steer = f.update(s.steer, 1 / 60, car.state, def, c);
          car.controls.throttle = s.throttle; car.controls.brake = s.brake;
          world.step(1 / 60);
          const st = car.state;
          if (st.speed > 5) {
            const fw = new Vector3(0, 0, 1).applyQuaternion(st.quaternion), l = new Vector3(1, 0, 0).applyQuaternion(st.quaternion);
            maxB = Math.max(maxB, Math.abs(Math.atan2(st.velocity.dot(l), st.velocity.dot(fw))));
          }
        }
        res.push(`${name} ${(maxB * 57.3).toFixed(0).padStart(3)}°${maxB > 1.2 ? '!' : ' '}`);
      }
      rows.push(`${carId.padEnd(9)} esc=${esc ? 1 : 0} assist=${sa} sens=${sens}  ${res.join('  ')}`);
    }
  }
  writeFileSync('.cache/sweep.txt', rows.join('\n'));
});
