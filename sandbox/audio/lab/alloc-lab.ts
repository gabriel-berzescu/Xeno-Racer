/** Heap growth check for the DSP hot paths: node --expose-gc .cache/audio-lab/alloc-lab.bundle.mjs (via run.mjs) */
import { CARS } from '../../../src/cars';
import { ChassisVoice } from '../../../src/audio/dsp/chassis-voice';
import { EngineVoice } from '../../../src/audio/dsp/engine-voice';

const SR = 48000;
const gc = (globalThis as { gc?: () => void }).gc;
function heap(): number {
  gc?.();
  return process.memoryUsage().heapUsed / 1048576;
}
for (const car of CARS) {
  const v = new EngineVoice(SR, car.sound, 1);
  const e = car.physics.engine;
  const out = new Float32Array(128);
  Object.assign(v.inp, { rpm: e.limiterRpm * 0.7, throttle: 1, load: 1, boost: 1, idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, driveOmega: 150, limiter: 1 });
  for (let i = 0; i < 5000; i++) v.process(out, 128);
  const h0 = heap();
  for (let i = 0; i < 60000; i++) {
    v.inp.rpm = e.limiterRpm * (0.3 + 0.7 * Math.abs(Math.sin(i * 0.002)));
    if (i % 500 === 0) {
      v.inp.shiftCount++;
      v.inp.backfireCount++;
    }
    v.process(out, 128);
  }
  const h1 = heap();
  console.log(`${car.id.padEnd(9)} engine: heap ${h0.toFixed(2)} -> ${h1.toFixed(2)} MB over 60000 blocks (${((60000 * 128) / SR).toFixed(0)} s of audio)`);
}
const c = new ChassisVoice(SR, 1);
const l = new Float32Array(128);
const r = new Float32Array(128);
c.inp.speed = 50;
for (let i = 0; i < 5000; i++) c.process(l, r, 128);
const h0 = heap();
for (let i = 0; i < 60000; i++) {
  if (i % 400 === 0) {
    c.inp.impactCount++;
    c.inp.impactStrength = 25;
    c.inp.thumpCount++;
  }
  c.inp.tire[1] = Math.abs(Math.sin(i * 0.003));
  c.process(l, r, 128);
}
console.log(`chassis   : heap ${h0.toFixed(2)} -> ${heap().toFixed(2)} MB over 60000 blocks`);
