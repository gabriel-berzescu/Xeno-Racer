/** Per-layer level and centroid at a steady point: node sandbox/audio/lab/run.mjs layers-lab.ts --car lmp --rpm 2100 --load 1 */
import { CARS } from '../../../src/cars';
import { EngineVoice, createEngineDebug } from '../../../src/audio/dsp/engine-voice';
import { spectralCentroid, welch, rms } from '../../../src/audio/analysis';

const SR = 48000;
const args = process.argv.slice(2);
const opt = (n: string, d: string): string => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const car = CARS.find((c) => c.id.startsWith(opt('car', 'lmp')))!;
const rpm = +opt('rpm', '2100');
const load = +opt('load', '1');
const interior = +opt('interior', '0');
const e = car.physics.engine;
const v = new EngineVoice(SR, car.sound, 21);
Object.assign(v.inp, { rpm, throttle: load < 0.2 ? 0 : 1, load, idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, redlineRpm: e.redlineRpm, boost: car.sound.turbo && load > 0.5 ? 0.9 : 0, interior });
const n = Math.floor(2.4 * SR);
const x = new Float32Array(n);
const d = createEngineDebug(n);
v.debug = d;
v.process(x, n);
const a = Math.floor(1.0 * SR);
console.log(`${car.id} rpm ${rpm} load ${load}: total rms ${(20 * Math.log10(rms(x, a, n))).toFixed(1)} dB, centroid ${spectralCentroid(welch(x, 16384, a, n), SR, 40, 12000).toFixed(0)} Hz`);
for (const k of ['exhaust', 'intake', 'mech', 'block', 'turbo', 'whine', 'events'] as const) {
  const s = d[k];
  console.log(`  ${k.padEnd(8)} rms ${(20 * Math.log10(rms(s, a, n) + 1e-9)).toFixed(1).padStart(6)} dB  centroid ${spectralCentroid(welch(s, 16384, a, n), SR, 40, 12000).toFixed(0).padStart(5)} Hz`);
}
