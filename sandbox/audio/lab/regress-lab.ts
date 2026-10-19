/**
 * Engine regression gate (Node): a SHA-256 of what every car's engine voice renders in a fixed set of scenarios, to prove that work on one
 * car's sound left the others bit-for-bit as they were. The hash covers the output AND every debug tap (exhaust, intake, mech, block, turbo,
 * whine, events), so a change anywhere in the voice shows, however far below hearing.
 *
 *   node sandbox/audio/lab/run.mjs regress-lab.ts record <label>            writes .cache/audio-lab/regress-<label>.json
 *   node sandbox/audio/lab/run.mjs regress-lab.ts compare <labelA> <labelB> [--only id,id]   lists the scenarios whose hash differs
 *
 * Record on the commit to protect (a worktree at it will do), record again after the work, and compare: every car that is not the one being
 * worked on must come out identical. The scenarios exercise full and lite quality, interior and exterior, the idle, the overrun and its pops,
 * a shift, a backfire, the limiter, Doppler, a sleep and a wake, and the promotion from lite to full.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CARS } from '../../../src/cars';
import type { CarDefinition } from '../../../src/core/contracts';
import { makeControlVector, readEngineInputs, writeEngineControls } from '../../../src/audio/controls';
import { EngineVoice, calibratedExhaustGain, createEngineDebug, type EngineDebug } from '../../../src/audio/dsp/engine-voice';
import { DriveSim } from '../drive-sim';

const SR = 48000;
const outDir = resolve('.cache/audio-lab');
mkdirSync(outDir, { recursive: true });
const args = process.argv.slice(2);
const cmd = args[0] ?? 'record';

const TAPS = ['exhaust', 'intake', 'mech', 'block', 'turbo', 'whine', 'events'] as const;

interface Entry {
  hash: string;
  rmsDb: number;
}
type Book = Record<string, Entry>;

function hashOf(sig: Float32Array, dbg: EngineDebug | null): Entry {
  const h = createHash('sha256');
  h.update(Buffer.from(sig.buffer, sig.byteOffset, sig.byteLength));
  if (dbg) for (const k of TAPS) h.update(Buffer.from(dbg[k].buffer, dbg[k].byteOffset, dbg[k].byteLength));
  let s = 0;
  for (let i = 0; i < sig.length; i++) s += sig[i] * sig[i];
  return { hash: h.digest('hex').slice(0, 20), rmsDb: 10 * Math.log10(s / Math.max(sig.length, 1) + 1e-20) };
}

/** Render with the taps wired to the block being rendered (the voice writes them from index 0 of each call). */
function renderTapped(v: EngineVoice, sig: Float32Array, off: number, len: number, dbg: EngineDebug): void {
  v.debug = {
    exhaust: dbg.exhaust.subarray(off),
    intake: dbg.intake.subarray(off),
    mech: dbg.mech.subarray(off),
    block: dbg.block.subarray(off),
    turbo: dbg.turbo.subarray(off),
    whine: dbg.whine.subarray(off),
    events: dbg.events.subarray(off),
  };
  v.process(sig.subarray(off), len);
}

function setup(car: CarDefinition, seed: number, quality: number, interior: number, rpm: number, thr: number, load: number): EngineVoice {
  const v = new EngineVoice(SR, car.sound, seed);
  const e = car.physics.engine;
  Object.assign(v.inp, { rpm, throttle: thr, load, idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, redlineRpm: e.redlineRpm, quality, interior, boost: car.sound.turbo ? Math.min(1, thr * 0.9) : 0, driveOmega: 90 * thr, gear: 3 });
  return v;
}

function steadyHash(car: CarDefinition, quality: number, interior: number, rpm: number, thr: number, load: number, secs: number): Entry {
  const v = setup(car, 7, quality, interior, rpm, thr, load);
  const n = Math.floor(secs * SR);
  const sig = new Float32Array(n);
  const dbg = createEngineDebug(n);
  v.debug = dbg;
  v.process(sig, n);
  return hashOf(sig, dbg);
}

/** The drive through the gears of the lab's run3, at 60 control frames a second. */
function run3Hash(car: CarDefinition, quality: number, interior: number): Entry {
  const e = car.physics.engine;
  const sim = new DriveSim(car, { gear: 1, rpm: e.idleRpm + 0.38 * (e.redlineRpm - e.idleRpm) });
  const v = new EngineVoice(SR, car.sound, 1);
  const n = Math.floor(8 * SR);
  const sig = new Float32Array(n);
  const dbg = createEngineDebug(n);
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
    v.inp.quality = quality;
    renderTapped(v, sig, f * spf, Math.min(spf, n - f * spf), dbg);
  }
  return hashOf(sig, dbg);
}

/** Events: shifts, a backfire, the limiter, a lift into the overrun, Doppler, a sleep and a wake. */
function eventsHash(car: CarDefinition, quality: number): Entry {
  const e = car.physics.engine;
  const v = setup(car, 11, quality, 0, e.redlineRpm * 0.7, 1, 1);
  const secs = 7;
  const n = Math.floor(secs * SR);
  const sig = new Float32Array(n);
  const dbg = createEngineDebug(n);
  const spf = 800;
  for (let f = 0; f * spf < n; f++) {
    const t = (f * spf) / SR;
    const i = v.inp;
    i.rpm = e.redlineRpm * (0.55 + 0.35 * Math.sin(t * 1.3) ** 2);
    if (t > 1.0 && t < 1.02) i.shiftCount = 1;
    if (t > 2.0 && t < 2.02) i.shiftCount = 2;
    if (t > 3.0 && t < 3.02) i.backfireCount = 1;
    i.limiter = t > 4.0 && t < 4.5 ? 1 : 0;
    const lift = t > 5.0;
    i.throttle = lift ? 0 : 1;
    i.load = lift ? 0 : 1;
    i.pedal = lift ? 0 : 1;
    i.boost = car.sound.turbo ? (lift ? 0.4 : 0.9) : 0;
    i.timeScale = t > 5.5 ? 1.2 : 1;
    const asleep = t > 6.0 && t < 6.3;
    i.quality = asleep ? 0 : quality;
    i.gain = asleep ? 0 : 1;
    renderTapped(v, sig, f * spf, Math.min(spf, n - f * spf), dbg);
  }
  return hashOf(sig, dbg);
}

/** A lite voice promoted to full after a second (and demoted again), as an opponent coming into range. */
function promotionHash(car: CarDefinition): Entry {
  const e = car.physics.engine;
  const v = setup(car, 5, 1, 0, e.redlineRpm * 0.75, 1, 1);
  const n = Math.floor(4 * SR);
  const sig = new Float32Array(n);
  const dbg = createEngineDebug(n);
  const spf = 1024;
  for (let f = 0; f * spf < n; f++) {
    const t = (f * spf) / SR;
    v.inp.quality = t < 1 ? 1 : t < 2.5 ? 2 : 1;
    renderTapped(v, sig, f * spf, Math.min(spf, n - f * spf), dbg);
  }
  return hashOf(sig, dbg);
}

function record(label: string): void {
  const book: Book = {};
  for (const car of CARS) {
    const id = car.id;
    const e = car.physics.engine;
    book[`${id}/exGain`] = { hash: String(calibratedExhaustGain(car.sound, SR)), rmsDb: 0 };
    book[`${id}/run3`] = run3Hash(car, 2, 0);
    book[`${id}/run3-cockpit`] = run3Hash(car, 2, 1);
    book[`${id}/run3-lite`] = run3Hash(car, 1, 0);
    book[`${id}/idle`] = steadyHash(car, 2, 0, e.idleRpm, 0, 0.06, 4);
    book[`${id}/idle-cockpit`] = steadyHash(car, 2, 1, e.idleRpm, 0, 0.06, 4);
    book[`${id}/idle-lite`] = steadyHash(car, 1, 0, e.idleRpm, 0, 0.06, 4);
    for (const interior of [0, 1]) {
      for (const [rpm, thr, load] of [
        [e.idleRpm * 1.5, 0.15, 0.2],
        [2500, 0.3, 0.3],
        [2500, 1, 1],
        [4000, 1, 1],
        [4000, 0, 0],
        [6000, 1, 1],
        [Math.round(e.redlineRpm * 0.97), 1, 1],
      ] as [number, number, number][]) {
        book[`${id}/steady-${interior ? 'cockpit' : 'ext'}-${Math.round(rpm)}-${thr}-${load}`] = steadyHash(car, 2, interior, rpm, thr, load, 3);
      }
    }
    for (const [rpm, thr, load] of [
      [2500, 1, 1],
      [4000, 0, 0],
      [Math.round(e.redlineRpm * 0.97), 1, 1],
    ] as [number, number, number][]) {
      book[`${id}/steady-lite-${Math.round(rpm)}-${thr}-${load}`] = steadyHash(car, 1, 0, rpm, thr, load, 3);
    }
    book[`${id}/events-full`] = eventsHash(car, 2);
    book[`${id}/events-lite`] = eventsHash(car, 1);
    book[`${id}/promotion`] = promotionHash(car);
  }
  const file = resolve(outDir, `regress-${label}.json`);
  writeFileSync(file, JSON.stringify(book, null, 1));
  console.log(`recorded ${Object.keys(book).length} scenarios -> ${file}`);
}

function compare(a: string, b: string): void {
  const load = (l: string): Book => {
    const f = existsSync(l) ? l : resolve(outDir, `regress-${l}.json`);
    return JSON.parse(readFileSync(f, 'utf8')) as Book;
  };
  const A = load(a);
  const B = load(b);
  const onlyArg = args.indexOf('--only');
  const only = onlyArg >= 0 ? args[onlyArg + 1].split(',') : null;
  const ids = [...new Set(Object.keys(A).map((k) => k.split('/')[0]))].filter((id) => !only || only.includes(id));
  let bad = 0;
  for (const id of ids) {
    const keys = Object.keys(A).filter((k) => k.startsWith(`${id}/`));
    const diff = keys.filter((k) => !B[k] || B[k].hash !== A[k].hash);
    bad += diff.length;
    console.log(`${id.padEnd(10)} ${keys.length - diff.length}/${keys.length} scenarios identical${diff.length ? `   DIFFERENT: ${diff.map((k) => k.slice(id.length + 1)).join(', ')}` : '   (bit-identical)'}`);
  }
  console.log(bad === 0 ? 'ALL IDENTICAL' : `${bad} scenario(s) differ`);
  process.exitCode = bad === 0 ? 0 : 1;
}

if (cmd === 'record') record(args[1] ?? 'now');
else if (cmd === 'compare') compare(args[1], args[2]);
else console.log('usage: regress-lab.ts record <label> | compare <labelA> <labelB> [--only id,id]');
