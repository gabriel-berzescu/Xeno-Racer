/**
 * Pop lab (Node): what a backfire and a flat upshift sound like, on their own.
 *
 *   node sandbox/audio/lab/run.mjs pop-lab.ts [--car kestrel-r] [--tag before]
 *
 * pop:   full throttle at 5500 rpm, one backfire at 1.0 s, rendered with and without it over six seeds: the energy the pop adds in
 *        the 120 ms after it, band by band (the pop draws from the voice's random stream, so the two renders part ways after it and
 *        their samples cannot be subtracted).
 * shift: a flat upshift at 1.0 s from 6500 rpm, as the physics does it (the applied throttle cut for 80 ms while the driver keeps the
 *        pedal down), with and without the backfire the physics may add; the 2-5 kHz energy is followed in 10 ms frames against the
 *        same window of steady driving, which is where a hiss or a crack on a shift shows.
 * WAVs of each go to .cache/audio-lab/pop-<car>-<tag>-*.wav.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CARS } from '../../../src/cars';
import type { CarDefinition } from '../../../src/core/contracts';
import { EngineVoice } from '../../../src/audio/dsp/engine-voice';
import { bandPower, peakAbs, welch } from '../../../src/audio/analysis';
import { encodeWav16 } from '../../../src/audio/wav';

const SR = 48000;
const outDir = resolve('.cache/audio-lab');
mkdirSync(outDir, { recursive: true });
const args = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const carSel = opt('car', 'all');
const tag = opt('tag', 'now');
const cars: CarDefinition[] = carSel === 'all' ? CARS : CARS.filter((c) => c.id === carSel || c.id.startsWith(carSel));
const db = (x: number): string => (10 * Math.log10(Math.max(x, 1e-20))).toFixed(1);

interface Frame {
  rpm: number;
  thr: number;
  pedal: number;
  load: number;
  gear: number;
  shift: number;
  bf: number;
}

/** Renders the voice frame by frame (60 fps controls), like the game feeds it. */
function render(car: CarDefinition, seconds: number, at: (t: number) => Frame, seed = 5): Float32Array {
  const v = new EngineVoice(SR, car.sound, seed);
  const e = car.physics.engine;
  const i = v.inp;
  i.idleRpm = e.idleRpm;
  i.limiterRpm = e.limiterRpm;
  i.redlineRpm = e.redlineRpm;
  i.interior = 0;
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  const spf = SR / 60;
  for (let f = 0; f * spf < n; f++) {
    const s = at(f / 60);
    i.rpm = s.rpm;
    i.throttle = s.thr;
    (i as unknown as { pedal?: number }).pedal = s.pedal;
    i.load = s.load;
    i.boost = car.sound.turbo ? 0.95 * s.load + 0.05 : 0;
    i.gear = s.gear;
    i.shiftCount = s.shift;
    i.backfireCount = s.bf;
    const off = Math.round(f * spf);
    const len = Math.min(Math.round((f + 1) * spf) - off, n - off);
    if (len > 0) v.process(out.subarray(off, off + len), len);
  }
  return out;
}

/** Energy in 2-5 kHz, 10 ms frames, as dB over the same frames of the reference. */
function hiss(x: Float32Array, ref: Float32Array, t0: number, t1: number): string {
  const out: string[] = [];
  const w = 480;
  let worst = -99;
  for (let a = Math.floor(t0 * SR); a + 2048 <= Math.floor(t1 * SR); a += w) {
    const p = bandPower(welch(x, 1024, a, a + 2048), SR, 2000, 5000);
    const r = bandPower(welch(ref, 1024, a, a + 2048), SR, 2000, 5000);
    const d = 10 * Math.log10(Math.max(p, 1e-20) / Math.max(r, 1e-20));
    worst = Math.max(worst, d);
    out.push(d.toFixed(0));
  }
  return `peak +${worst.toFixed(1)} dB | ${out.join(' ')}`;
}

for (const car of cars) {
  const e = car.physics.engine;
  const d = car.physics.drivetrain;
  // ── pop ── (the pop draws from the voice's random stream, so the two renders part ways after it: compare energies, not samples)
  const steadyAt = (bf: number) => (t: number): Frame => ({ rpm: 5500, thr: 1, pedal: 1, load: 1, gear: 3, shift: 0, bf: t >= 1 ? bf : 0 });
  const BANDS = [[20, 300], [300, 1000], [1000, 2000], [2000, 5000], [5000, 16000]];
  const ex = BANDS.map(() => 0);
  const base = BANDS.map(() => 0);
  let pkWith = 0, pkRef = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const p0 = render(car, 1.3, steadyAt(0), seed);
    const p1 = render(car, 1.3, steadyAt(1), seed);
    const a = Math.floor(1.0 * SR), b = Math.floor(1.12 * SR);
    const w0 = welch(p0, 1024, a, b), w1 = welch(p1, 1024, a, b);
    BANDS.forEach(([lo, hi], k) => { ex[k] += Math.max(0, bandPower(w1, SR, lo, hi) - bandPower(w0, SR, lo, hi)); base[k] += bandPower(w0, SR, lo, hi); });
    pkWith = Math.max(pkWith, peakAbs(p1, a, b));
    pkRef = Math.max(pkRef, peakAbs(p0, a, b));
    if (seed === 1) writeFileSync(resolve(outDir, `pop-${car.id}-${tag}-pop.wav`), encodeWav16([p1.subarray(Math.floor(0.6 * SR))], SR));
  }
  const exTot = ex.reduce((x, y) => x + y, 0);
  const centroidEx = BANDS.reduce((acc, [lo, hi], k) => acc + Math.sqrt(lo * hi) * ex[k], 0) / Math.max(exTot, 1e-20);
  console.log(
    `${car.id.padEnd(10)} pop   peak ${(20 * Math.log10(pkWith)).toFixed(1)} dBFS (engine ${(20 * Math.log10(pkRef)).toFixed(1)}) | its energy by band: ` +
      BANDS.map(([lo, hi], k) => `${lo}-${hi}:${((ex[k] / exTot) * 100).toFixed(0)}% (+${(10 * Math.log10(1 + ex[k] / Math.max(base[k], 1e-20))).toFixed(1)}dB)`).join(' ') +
      ` | centre ${centroidEx.toFixed(0)} Hz`,
  );
  // ── shift ──
  const rpm0 = Math.min(6500, e.limiterRpm - 300);
  const ratio = d.gears[3] / d.gears[2];
  const shiftAt = (withShift: boolean, bf: number) => (t: number): Frame => {
    const cut = withShift && t >= 1 && t < 1.08;
    const after = withShift && t >= 1.04;
    const rpm = !withShift || t < 1.04 ? rpm0 + (t - 1) * 900 : rpm0 * ratio + Math.max(0, t - 1.08) * 700;
    return { rpm, thr: cut ? 0 : 1, pedal: 1, load: cut ? 0 : 1, gear: after ? 4 : 3, shift: withShift && t >= 1.08 ? 1 : 0, bf: t >= 1 ? bf : 0 };
  };
  const ref = render(car, 1.8, shiftAt(false, 0));
  const s0 = render(car, 1.8, shiftAt(true, 0));
  const s1 = render(car, 1.8, shiftAt(true, 1));
  console.log(`${car.id.padEnd(10)} shift          2-5 kHz ${hiss(s0, ref, 0.95, 1.6)}`);
  console.log(`${car.id.padEnd(10)} shift+backfire 2-5 kHz ${hiss(s1, ref, 0.95, 1.6)}`);
  writeFileSync(resolve(outDir, `pop-${car.id}-${tag}-shift.wav`), encodeWav16([s1], SR));
  void e;
}
