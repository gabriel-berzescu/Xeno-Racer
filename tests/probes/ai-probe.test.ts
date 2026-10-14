import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { AIDriver } from '../../src/ai';
import { getCar } from '../../src/cars';
import type { TrackPoint } from '../../src/core/contracts';
import { PhysicsWorld } from '../../src/physics';
import { loadTrackRuntime } from '../../src/track';
it.skipIf(!process.env.AICAR)('ai probe', () => {
  const track = loadTrackRuntime(process.env.TRACK ?? 'aurelia');
  const def = getCar(process.env.AICAR!);
  const world = new PhysicsWorld(track);
  const car = world.addVehicle(def);
  car.assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
  const slot = track.grid[0];
  car.placeOnGround(slot.position, slot.quaternion, 0);
  car.setTemperatures(1);
  const ai = new AIDriver(track, def, { difficulty: (process.env.DIFF as any) ?? 'alien', seed: 1 });
  const tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
  const rows: string[] = [];
  let lastLog = -1e9; let hint = -1; let lastImp = 0;
  while (world.time < (+(process.env.SECS ?? 120))) {
    ai.update(1 / 60, car.state, world.states, car.controls, true);
    if (ai.needsReset) { rows.push(`!!! RESET at s=${ai.s.toFixed(0)}`); break; }
    world.step(1 / 60);
    hint = track.project(car.p.x, car.p.z, tp, hint);
    const st = car.state;
    const li = Math.floor(tp.s / ai.line.step) % ai.line.n;
    const imp = st.impactCount !== lastImp;
    const fine = process.env.FINE ? world.time > +process.env.FINE.split(',')[0] && world.time < +process.env.FINE.split(',')[1] : false;
    if (world.time - lastLog > (fine ? 0.04 : 0.5) || imp) {
      lastLog = world.time; lastImp = st.impactCount;
      const sa = st.wheels.map((w) => (w.slipAngle * 57.3).toFixed(0) + ':' + w.slipRatio.toFixed(2)).join('/');
      const yaw = st.angularVelocity.y;
      rows.push(`t=${world.time.toFixed(1)} s=${tp.s.toFixed(0)} d=${tp.d.toFixed(1)} lineD=${ai.line.d[li].toFixed(1)} wL=${tp.widthLeft.toFixed(1)} wR=${tp.widthRight.toFixed(1)} k=${(ai.line.k[li]*1000).toFixed(1)} v=${(st.forwardSpeed*3.6).toFixed(0)} vT=${(ai.targetSpeed(tp.s)*3.6).toFixed(0)} thr=${car.controls.throttle.toFixed(2)} brk=${car.controls.brake.toFixed(2)} steer=${car.controls.steer.toFixed(2)} g=${st.gear} slipA=${sa} gLat=${(st.localAccel.x/9.81).toFixed(2)} yaw=${yaw.toFixed(2)} abs=${st.absActive} gh=${car.debugGroundHits} wh=${car.debugWallHits} comp=${st.wheels.map((w) => (w.contact ? w.compression.toFixed(2) : 'air')).join('/')} y=${st.position.y.toFixed(2)} surf=${st.wheels[0].surface} ${ai.debug}${imp ? ' IMPACT ' + st.lastImpact.kind + ' ' + st.lastImpact.strength.toFixed(1) : ''}`);
    }
  }
  writeFileSync('.cache/ai-probe.txt', rows.join('\n'));
});
