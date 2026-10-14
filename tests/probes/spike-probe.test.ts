import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { AIDriver } from '../../src/ai';
import { getCar } from '../../src/cars';
import { PhysicsWorld } from '../../src/physics';
import { loadTrackRuntime } from '../../src/track';
it.skipIf(!process.env.SPIKE)('spike probe', () => {
  const [t0, t1] = process.env.SPIKE!.split(',').map(Number);
  const track = loadTrackRuntime('aurelia');
  const def = getCar(process.env.AICAR ?? 'vanta-gt');
  const world = new PhysicsWorld(track);
  const car = world.addVehicle(def);
  car.assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
  car.placeOnGround(track.grid[0].position, track.grid[0].quaternion, 0);
  car.setTemperatures(1);
  const ai = new AIDriver(track, def, { difficulty: 'alien', seed: 1 });
  const rows: string[] = [];
  let frameAcc = 0;
  while (world.time < t1) {
    const fine = world.time >= t0;
    const dt = fine ? 0.001 : 1 / 60;
    frameAcc += dt;
    if (!fine || frameAcc >= 1 / 60) { ai.update(1 / 60, car.state, world.states, car.controls, true); frameAcc = 0; }
    world.step(dt);
    if (fine) {
      const w = (car as any).wheels as any[];
      rows.push(`t=${world.time.toFixed(3)} yaw=${car.w.y.toFixed(3)} gh=${car.debugGroundHits} ` + w.map((x, i) => `[${i} ${x.contact ? 'c' : 'A'} L=${x.load.toFixed(0)} fx=${x.fx.toFixed(0)} fy=${x.fy.toFixed(0)} cmp=${x.compression.toFixed(3)} cv=${x.compVel.toFixed(2)} bot=${x.bottom.toFixed(3)} ${x.surface} n=${x.normal.x.toFixed(2)},${x.normal.y.toFixed(2)},${x.normal.z.toFixed(2)} om=${x.omega.toFixed(0)}]`).join(' '));
    }
  }
  writeFileSync('.cache/spike.txt', rows.join('\n'));
});
