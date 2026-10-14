/** Off-grid (aliasing / inharmonic) line finder: node sandbox/audio/lab/run.mjs alias-lab.ts */
import { CARS } from '../../../src/cars';
import { EngineVoice, createEngineDebug } from '../../../src/audio/dsp/engine-voice';
import { offGridLines, welch } from '../../../src/audio/analysis';

const SR = 48000;
for (const car of CARS) {
  const e = car.physics.engine;
  for (const frac of [0.97, 0.6]) {
    const rpm = e.redlineRpm * frac;
    const v = new EngineVoice(SR, car.sound, 17);
    v.V.turbo = false;
    Object.assign(v.inp, { rpm, throttle: 1, load: 1, idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, redlineRpm: e.redlineRpm, driveOmega: 0 });
    const n = Math.floor(3.2 * SR);
    const x = new Float32Array(n);
    const dbg = createEngineDebug(n);
    v.debug = dbg;
    v.process(x, n);
    const base = rpm / 120;
    const off = offGridLines(welch(x, 65536, Math.floor(1.2 * SR), n), SR, base, { prominenceDb: 14, floorDb: 50 });
    console.log(`${car.id} @${Math.round(rpm)} rpm (cycle ${base.toFixed(1)} Hz): ${off.count} off-grid`, off.lines.slice(0, 5).map((l) => `${l.hz.toFixed(1)}Hz(${l.hz / base > 0 ? (l.hz / base).toFixed(2) : ''}x) ${l.db.toFixed(1)}dB`).join(' | '));
    if (off.count) {
      for (const k of ['exhaust', 'intake', 'mech', 'block', 'turbo', 'whine', 'events'] as const) {
        const o = offGridLines(welch(dbg[k], 65536, Math.floor(1.2 * SR), n), SR, base, { prominenceDb: 14, floorDb: 60 });
        if (o.count) console.log(`    layer ${k}: ${o.count} off-grid, e.g. ${o.lines.slice(0, 3).map((l) => `${l.hz.toFixed(1)}Hz ${l.db.toFixed(0)}dB`).join(', ')}`);
      }
    }
  }
}
