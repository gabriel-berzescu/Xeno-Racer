/** Spectral centroid vs rpm / load for each car (Node): node sandbox/audio/lab/run.mjs centroid-lab.ts */
import { CARS } from '../../../src/cars';
import { EngineVoice } from '../../../src/audio/dsp/engine-voice';
import { spectralCentroid, welch } from '../../../src/audio/analysis';

const SR = 48000;
for (const car of CARS) {
  const e = car.physics.engine;
  const row: string[] = [];
  for (const load of [1, 0.3]) {
    const cs: number[] = [];
    for (let k = 0; k < 10; k++) {
      const rpm = e.idleRpm * 1.3 + ((e.redlineRpm * 0.97 - e.idleRpm * 1.3) * k) / 9;
      const v = new EngineVoice(SR, car.sound, 21);
      Object.assign(v.inp, { rpm, throttle: load, load, idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, redlineRpm: e.redlineRpm, boost: car.sound.turbo ? 0.9 * load : 0 });
      const n = Math.floor(2.2 * SR);
      const x = new Float32Array(n);
      v.process(x, n);
      cs.push(spectralCentroid(welch(x, 16384, Math.floor(1.0 * SR), n), SR, 40, 12000));
    }
    const half = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
    row.push(`load ${load}: ${cs.map((c) => Math.round(c)).join(' ')}  | mean low-half ${Math.round(half(cs.slice(0, 5)))} high-half ${Math.round(half(cs.slice(5)))}`);
  }
  console.log(car.id + '\n  ' + row.join('\n  '));
}
