/**
 * Loudness lab (Node): how loud each car's engine is, in the units a listener would compare them in. K-weighted loudness after ITU-R BS.1770
 * (the two-stage filter: a head-related high shelf and a 38 Hz high-pass, then mean square), over a drive through the gears and over steady
 * wide-open-throttle rpm points, exterior and cockpit, plus the plain RMS and the crest factor. "LUFS-ish": the absolute gating of the
 * standard is dropped, the engine is never silent, and the figures are for comparing cars, not for broadcast.
 *
 *   node sandbox/audio/lab/run.mjs loud-lab.ts [--car all]
 */
import { CARS } from '../../../src/cars';
import type { CarDefinition } from '../../../src/core/contracts';
import { makeControlVector, readEngineInputs, writeEngineControls } from '../../../src/audio/controls';
import { EngineVoice } from '../../../src/audio/dsp/engine-voice';
import { DriveSim } from '../drive-sim';

const SR = 48000;
const args = process.argv.slice(2);
function opt(name: string, def: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}
const sel = opt('car', 'all');
const cars: CarDefinition[] = sel === 'all' ? CARS : CARS.filter((c) => c.id.startsWith(sel));

/** BS.1770 K-weighting at 48 kHz (the coefficients of the standard): stage 1 a high shelf (+4 dB above ~1.7 kHz), stage 2 the RLB high-pass. */
function kWeight(x: Float32Array): Float64Array {
  const y = new Float64Array(x.length);
  const b1 = [1.53512485958697, -2.69169618940638, 1.19839281085285];
  const a1 = [1, -1.69065929318241, 0.73248077421585];
  const b2 = [1, -2, 1];
  const a2 = [1, -1.99004745483398, 0.99007225036621];
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  let u1 = 0;
  let u2 = 0;
  let v1 = 0;
  let v2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s = x[i];
    const p = b1[0] * s + b1[1] * x1 + b1[2] * x2 - a1[1] * y1 - a1[2] * y2;
    x2 = x1;
    x1 = s;
    y2 = y1;
    y1 = p;
    const q = b2[0] * p + b2[1] * u1 + b2[2] * u2 - a2[1] * v1 - a2[2] * v2;
    u2 = u1;
    u1 = p;
    v2 = v1;
    v1 = q;
    y[i] = q;
  }
  return y;
}

/** Integrated K-weighted loudness (LUFS-ish) of x[from..], and the loudest 3 s window (short-term). */
function lufs(x: Float32Array, from = 0): { integrated: number; shortMax: number } {
  const k = kWeight(x);
  let s = 0;
  for (let i = from; i < k.length; i++) s += k[i] * k[i];
  const integrated = -0.691 + 10 * Math.log10(s / Math.max(1, k.length - from) + 1e-20);
  const win = Math.min(3 * SR, k.length - from);
  let shortMax = -200;
  const hop = Math.floor(0.25 * SR);
  for (let a = from; a + win <= k.length; a += hop) {
    let e = 0;
    for (let i = a; i < a + win; i++) e += k[i] * k[i];
    shortMax = Math.max(shortMax, -0.691 + 10 * Math.log10(e / win + 1e-20));
  }
  return { integrated, shortMax };
}

function rmsDb(x: Float32Array, from = 0): number {
  let s = 0;
  for (let i = from; i < x.length; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / Math.max(1, x.length - from) + 1e-20);
}
function peakDb(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return 20 * Math.log10(p + 1e-12);
}

function run3(car: CarDefinition, interior: number, secs = 8): Float32Array {
  const e = car.physics.engine;
  const sim = new DriveSim(car, { gear: 1, rpm: e.idleRpm + 0.38 * (e.redlineRpm - e.idleRpm) });
  const v = new EngineVoice(SR, car.sound, 1);
  const n = Math.floor(secs * SR);
  const sig = new Float32Array(n);
  const vec = makeControlVector();
  const spf = Math.round(SR / 60);
  let lifted = -1;
  for (let f = 0; f * spf < n; f++) {
    const t = f / 60;
    if (lifted < 0 && sim.st.gear === 3 && sim.st.rpm > 0.9 * e.limiterRpm) lifted = t;
    sim.step(1 / 60, lifted < 0 ? 1 : 0, 0);
    writeEngineControls(vec, sim.st);
    readEngineInputs(vec, v.inp);
    v.inp.interior = interior;
    v.process(sig.subarray(f * spf), Math.min(spf, n - f * spf));
  }
  return sig;
}

function steadyWot(car: CarDefinition, frac: number, interior: number): Float32Array {
  const e = car.physics.engine;
  const v = new EngineVoice(SR, car.sound, 3);
  Object.assign(v.inp, { rpm: e.redlineRpm * frac, throttle: 1, load: 1, pedal: 1, idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, redlineRpm: e.redlineRpm, interior, boost: car.sound.turbo ? 0.9 : 0 });
  const sig = new Float32Array(Math.floor(4 * SR));
  v.process(sig, sig.length);
  return sig;
}

const f1 = (x: number): string => x.toFixed(1).padStart(6);
for (const interior of [0, 1]) {
  console.log(interior ? '--- COCKPIT ---' : '--- EXTERIOR ---');
  console.log('car         run3: LUFS  short-max   RMS   peak | WOT steady LUFS at 40 / 60 / 80 / 97 % of redline');
  for (const car of cars) {
    const r = run3(car, interior);
    const a = lufs(r, Math.floor(0.3 * SR));
    const steady = [0.4, 0.6, 0.8, 0.97].map((fr) => lufs(steadyWot(car, fr, interior), Math.floor(1.5 * SR)).integrated);
    console.log(`${car.id.padEnd(10)}  ${f1(a.integrated)} ${f1(a.shortMax)}  ${f1(rmsDb(r, Math.floor(0.3 * SR)))} ${f1(peakDb(r))}   | ${steady.map(f1).join('')}`);
  }
}
