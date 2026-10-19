/**
 * Supercharger lab (Node): the whine of a blower-driven engine, measured three ways.
 *
 *   node sandbox/audio/lab/run.mjs blower-lab.ts [--car mammoth] [--interior 1]
 *
 *  pitch   the strongest line of the blower tap against rpm/60 x ratio x lobes (the lock to the crank), its harmonics, and its level against the
 *          exhaust, at idle, on and off the pedal, and through the rev range
 *  smr     how audible it is: the power of each partial of the whine against everything else of the mix (exhaust, block, intake, ...) within one ERB
 *          of it (the width of the ear's critical band: 24.7 (4.37 f/kHz + 1) Hz), in dB. A tone is heard in a noise from about -5 dB up; the
 *          partials that matter are the strongest ones (the fundamental at low rpm, the 2nd when the exhaust's own lines crowd the top)
 *  sweep   a spectrogram of the blower tap alone through a rev sweep with a lift and a tip-in (.cache/audio-lab/blower-sweep.png)
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CARS } from '../../../src/cars';
import { EngineVoice, createEngineDebug } from '../../../src/audio/dsp/engine-voice';
import { strongestPeak, welch } from '../../../src/audio/analysis';
import { spectrogramPng } from './png';

const SR = 48000;
const args = process.argv.slice(2);
function opt(name: string, def: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}
const car = CARS.find((c) => c.id.startsWith(opt('car', 'mammoth')))!;
const interior = +opt('interior', '0');
const sc = car.sound.supercharger;
if (!sc) throw new Error(`${car.id} has no supercharger`);
const e = car.physics.engine;
const fB = (rpm: number): number => (rpm / 60) * sc.ratio * sc.lobes;

function render(rpm: number, pedal: number, secs = 6): { mix: Float32Array; dbg: ReturnType<typeof createEngineDebug> } {
  const v = new EngineVoice(SR, car.sound, 7);
  Object.assign(v.inp, { rpm, throttle: pedal, load: pedal < 0.2 ? 0.06 : pedal, pedal, idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, redlineRpm: e.redlineRpm, interior });
  const n = Math.floor(secs * SR);
  const mix = new Float32Array(n);
  const dbg = createEngineDebug(n);
  v.debug = dbg;
  v.process(mix, n);
  return { mix, dbg };
}
const rmsDb = (x: Float32Array, from: number): number => {
  let s = 0;
  for (let i = from; i < x.length; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / (x.length - from) + 1e-20);
};

console.log(`${car.id}: ${sc.ratio} x ${sc.lobes} lobes: fundamental ${fB(650).toFixed(0)} Hz at 650 rpm, ${fB(3000).toFixed(0)} at 3000, ${fB(6000).toFixed(0)} at 6000 (${interior ? 'cockpit' : 'exterior'})`);
console.log('--- pitch and level ---');
for (const [rpm, pedal] of [[e.idleRpm, 0], [3000, 0], [3000, 0.3], [3000, 1], [1500, 1], [4500, 1], [6000, 1]] as number[][]) {
  const { mix, dbg } = render(rpm, pedal);
  const psd = welch(dbg.turbo, 32768, 2 * SR, dbg.turbo.length);
  const pk = strongestPeak(psd, SR, fB(rpm) * 0.9, fB(rpm) * 1.1);
  const harm = [2, 3, 4].map((k) => (strongestPeak(psd, SR, fB(rpm) * k * 0.97, fB(rpm) * k * 1.03).powerDb - pk.powerDb).toFixed(0));
  console.log(
    `${String(rpm).padStart(5)} rpm pedal ${pedal.toFixed(1)}: ${pk.freq.toFixed(1).padStart(7)} Hz (want ${fB(rpm).toFixed(1)}, ${(((pk.freq - fB(rpm)) / fB(rpm)) * 100).toFixed(2)} %), ` +
      `partials 2/3/4 ${harm.join('/')} dB, whine ${rmsDb(dbg.turbo, 2 * SR).toFixed(1)} dBFS, exhaust ${rmsDb(dbg.exhaust, 2 * SR).toFixed(1)}, mix ${rmsDb(mix, 2 * SR).toFixed(1)}`,
  );
}
console.log('--- audibility: partial power vs the rest of the mix within one ERB (dB) ---');
for (const rpm of [1500, 2000, 3000, 4000, 5000, 6000]) {
  const { mix, dbg } = render(rpm, 1);
  const nfft = 32768;
  const df = SR / nfft;
  const pMix = welch(mix, nfft, 2 * SR, mix.length);
  const pWh = welch(dbg.turbo, nfft, 2 * SR, mix.length);
  const cells: string[] = [];
  for (const k of [1, 2, 3, 4]) {
    const f = fB(rpm) * k;
    const erb = 24.7 * ((4.37 * f) / 1000 + 1);
    let w = 0;
    let m = 0;
    for (let i = Math.max(1, Math.floor((f - erb / 2) / df)); i <= Math.ceil((f + erb / 2) / df); i++) {
      w += pWh[i];
      m += Math.max(pMix[i] - pWh[i], 0);
    }
    cells.push(`${String(Math.round(f)).padStart(5)} Hz ${(10 * Math.log10(w / Math.max(m, 1e-30))).toFixed(0).padStart(4)}`);
  }
  console.log(`${String(rpm).padStart(5)} rpm wide open: ${cells.join('   ')}`);
}
{
  const v = new EngineVoice(SR, car.sound, 9);
  const secs = 8;
  const n = secs * SR;
  const sig = new Float32Array(n);
  const dbg = createEngineDebug(n);
  const spf = 800;
  Object.assign(v.inp, { idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, redlineRpm: e.redlineRpm, interior });
  for (let f = 0; f * spf < n; f++) {
    const t = (f * spf) / SR;
    const wot = t < 5.5 || t > 7;
    v.inp.rpm = t < 0.5 ? 700 : t < 5.5 ? 700 + 5300 * ((t - 0.5) / 5) : Math.max(1500, 6000 - (t - 5.5) * 2500);
    v.inp.throttle = v.inp.load = v.inp.pedal = wot ? 1 : 0;
    v.debug = { exhaust: dbg.exhaust.subarray(f * spf), intake: dbg.intake.subarray(f * spf), mech: dbg.mech.subarray(f * spf), block: dbg.block.subarray(f * spf), turbo: dbg.turbo.subarray(f * spf), whine: dbg.whine.subarray(f * spf), events: dbg.events.subarray(f * spf) };
    v.process(sig.subarray(f * spf), Math.min(spf, n - f * spf));
  }
  writeFileSync(resolve('.cache/audio-lab', 'blower-sweep.png'), spectrogramPng(dbg.turbo, SR, [{ nfft: 4096, hop: 256, fMax: 6000, grid: 500, height: 420 }]));
  console.log('wrote .cache/audio-lab/blower-sweep.png (the blower tap through idle -> wide open 700..6000 rpm, a lift at 5.5 s, a tip-in at 7 s)');
}
