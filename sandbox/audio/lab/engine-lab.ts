/**
 * Engine lab (Node). Renders each car's engine through scenarios and prints measurements.
 *
 *   node sandbox/audio/lab/run.mjs engine-lab.ts steady [--car lmp-x] [--rpm 3000] [--load 1]
 *   node sandbox/audio/lab/run.mjs engine-lab.ts run3   [--car all]
 *   node sandbox/audio/lab/run.mjs engine-lab.ts cpu
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CARS } from '../../../src/cars';
import type { CarDefinition } from '../../../src/core/contracts';
import { CTL, makeControlVector, readEngineInputs, writeEngineControls } from '../../../src/audio/controls';
import { EngineVoice, createEngineDebug, exhaustTargetDb, measureExhaustSweepRms } from '../../../src/audio/dsp/engine-voice';
import {
  chirpDeviation,
  harmonicShare,
  hasNonFinite,
  peakAbs,
  rmsDb,
  spectralCentroid,
  strongestPeak,
  welch,
} from '../../../src/audio/analysis';
import { encodeWav16 } from '../../../src/audio/wav';
import { DriveSim } from '../drive-sim';
import { psdPng, spectrogramPng, waveformPng } from './png';

const SR = 48000;
const outDir = resolve('.cache/audio-lab');
mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
const cmd = args[0] ?? 'steady';
function opt(name: string, def: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}
const carSel = opt('car', 'all');
const cars: CarDefinition[] = carSel === 'all' ? CARS : CARS.filter((c) => c.id === carSel || c.id.startsWith(carSel));

function mkVoice(car: CarDefinition, seed = 1): EngineVoice {
  return new EngineVoice(SR, car.sound, seed);
}

function db(x: number): string {
  return (20 * Math.log10(Math.max(x, 1e-9))).toFixed(1);
}

/** Render a run through the gears. */
function run3(car: CarDefinition, seconds: number, seed = 1): { sig: Float32Array; dbg: ReturnType<typeof createEngineDebug>; marks: string[] } {
  const e = car.physics.engine;
  const startRpm = e.idleRpm + 0.38 * (e.redlineRpm - e.idleRpm);
  const sim = new DriveSim(car, { gear: 1, rpm: startRpm });
  const voice = mkVoice(car, seed);
  const n = Math.floor(seconds * SR);
  const sig = new Float32Array(n);
  const dbg = createEngineDebug(n);
  const vec = makeControlVector();
  const fps = 60;
  const spf = Math.round(SR / fps);
  let lifted = -1;
  const marks: string[] = [];
  let lastShift = 0;
  // pre-roll one second at idle-ish before launch is skipped on purpose: we start rolling
  for (let f = 0; f * spf < n; f++) {
    const t = f / fps;
    const full = lifted < 0;
    if (full && sim.st.gear === 3 && sim.st.rpm > 0.9 * e.limiterRpm) lifted = t;
    if (lifted >= 0 && t > lifted + 1.9 && t < lifted + 2.1) {
      // short blip back to throttle to hear re-pickup
    }
    const thr = lifted < 0 ? 1 : 0;
    sim.step(1 / fps, thr, 0);
    if (sim.st.shiftCount !== lastShift) {
      lastShift = sim.st.shiftCount;
      marks.push(`shift@${t.toFixed(2)}s`);
    }
    writeEngineControls(vec, sim.st);
    readEngineInputs(vec, voice.inp);
    voice.inp.interior = 0;
    const off = f * spf;
    const len = Math.min(spf, n - off);
    voice.debug = {
      exhaust: dbg.exhaust.subarray(off),
      intake: dbg.intake.subarray(off),
      mech: dbg.mech.subarray(off),
      block: dbg.block.subarray(off),
      turbo: dbg.turbo.subarray(off),
      whine: dbg.whine.subarray(off),
      events: dbg.events.subarray(off),
    };
    voice.process(sig.subarray(off), len);
  }
  if (lifted >= 0) marks.push(`lift@${lifted.toFixed(2)}s`);
  return { sig, dbg, marks };
}

/** Steady-state render at fixed rpm/throttle/load. Returns the analysed tail. */
function steady(car: CarDefinition, rpm: number, thr: number, load: number, interior = 0, seconds = 3): { sig: Float32Array; dbg: ReturnType<typeof createEngineDebug> } {
  const voice = mkVoice(car, 7);
  const vi = voice.inp;
  const e = car.physics.engine;
  vi.rpm = rpm;
  vi.throttle = thr;
  vi.load = load;
  vi.idleRpm = e.idleRpm;
  vi.limiterRpm = e.limiterRpm;
  vi.redlineRpm = e.redlineRpm;
  vi.interior = interior;
  vi.boost = car.sound.turbo ? Math.min(1, thr * 0.9) : 0;
  const n = Math.floor(seconds * SR);
  const sig = new Float32Array(n);
  const dbg = createEngineDebug(n);
  voice.debug = dbg;
  voice.process(sig, n);
  return { sig, dbg };
}

function analyseSteady(car: CarDefinition, rpm: number, thr: number, load: number, interior = 0): string {
  const { sig, dbg } = steady(car, rpm, thr, load, interior, 3.2);
  const a = Math.floor(1.6 * SR);
  const b = sig.length;
  const psd = welch(sig, 32768, a, b);
  const fFire = (car.sound.cylinders / 2) * (rpm / 60);
  const pk = strongestPeak(psd, SR, fFire * 0.9, fFire * 1.1);
  const centroid = spectralCentroid(psd, SR, 40, 12000);
  const hs = harmonicShare(psd, SR, fFire, Math.max(1.5, fFire * 0.012), 40, 5000);
  const layers = (['exhaust', 'intake', 'mech', 'block', 'turbo', 'whine', 'events'] as const)
    .map((k) => `${k.slice(0, 3)}${db(Math.sqrt(dbg[k].subarray(a).reduce((s, v) => s + v * v, 0) / (b - a)))}`)
    .join(' ');
  return (
    `${car.id.padEnd(9)} rpm${String(rpm).padStart(5)} thr${thr.toFixed(2)} ld${load.toFixed(2)} | ` +
    `fire ${fFire.toFixed(1).padStart(6)}Hz found ${pk.freq.toFixed(1).padStart(6)} (${(((pk.freq - fFire) / fFire) * 100).toFixed(2)}%) prom ${pk.prominenceDb.toFixed(0)}dB | ` +
    `rms ${rmsDb(sig, a, b).toFixed(1)} pk ${db(peakAbs(sig, a, b))} cen ${centroid.toFixed(0)}Hz harm ${(hs * 100).toFixed(0)}% | ${layers}` +
    (hasNonFinite(sig) ? '  NONFINITE!' : '')
  );
}

if (cmd === 'steady') {
  const rpmArg = opt('rpm', '');
  const loadArg = opt('load', '');
  for (const car of cars) {
    const e = car.physics.engine;
    const rpms = rpmArg ? [+rpmArg] : [e.idleRpm, 2500, 4000, 6000, Math.round(e.redlineRpm * 0.97)];
    const loads = loadArg ? [+loadArg] : [0.12, 1.0];
    for (const l of loads) {
      for (const r of rpms) console.log(analyseSteady(car, r, l < 0.2 ? 0 : 1, l));
    }
    console.log('');
  }
} else if (cmd === 'run3') {
  for (const car of cars) {
    const secs = +opt('secs', '8');
    const { sig, dbg, marks } = run3(car, secs);
    const wav = encodeWav16([sig], SR);
    writeFileSync(resolve(outDir, `run3-${car.id}.wav`), wav);
    const png = spectrogramPng(sig, SR, [
      { nfft: 4096, hop: 256, fMax: 1500, grid: 100, height: 300 },
      { nfft: 2048, hop: 256, fMax: 12000, grid: 1000, height: 300 },
    ]);
    writeFileSync(resolve(outDir, `run3-${car.id}.png`), png);
    console.log(
      `${car.id}: ${secs}s rms ${rmsDb(sig).toFixed(1)}dB peak ${db(peakAbs(sig))}dB nonfinite=${hasNonFinite(sig)} marks: ${marks.join(' ')}`,
    );
    void dbg;
  }
} else if (cmd === 'view') {
  // waveform + PSD of a steady state: node run.mjs engine-lab.ts view --car lmp-x --rpm 6000 --load 1 [--interior 1]
  for (const car of cars) {
    const rpm = +opt('rpm', '3000');
    const load = +opt('load', '1');
    const interior = +opt('interior', '0');
    const { sig, dbg } = steady(car, rpm, load < 0.2 ? 0 : 1, load, interior, 3.2);
    const tag = `${car.id}-${rpm}-${load}${interior ? '-int' : ''}`;
    writeFileSync(resolve(outDir, `wave-${tag}.png`), waveformPng(sig, SR, 2.0, 0.06, 3));
    const a = Math.floor(1.6 * SR);
    const colours: Record<string, [number, number, number]> = {
      mix: [255, 255, 255], exhaust: [255, 120, 80], intake: [90, 200, 255], mech: [120, 255, 120], block: [255, 220, 90], turbo: [255, 90, 220], whine: [160, 140, 255],
    };
    const series = [{ psd: welch(sig, 16384, a, sig.length), colour: colours.mix }];
    for (const k of ['exhaust', 'intake', 'mech', 'block', 'turbo', 'whine'] as const) series.push({ psd: welch(dbg[k], 16384, a, sig.length), colour: colours[k] });
    writeFileSync(resolve(outDir, `psd-${tag}.png`), psdPng(series, SR, 30, 16000, 35, -85));
    console.log(analyseSteady(car, rpm, load < 0.2 ? 0 : 1, load, interior));
    console.log('  wrote', tag, '(psd colours: white=mix orange=exhaust blue=intake green=mech yellow=block magenta=turbo violet=whine)');
  }
} else if (cmd === 'levels') {
  // layer balance at a reference condition (WOT, 70 % of limiter), relative to the exhaust layer
  const keys = ['exhaust', 'block', 'intake', 'mech', 'turbo', 'whine'] as const;
  for (const interior of [0, 1]) {
    console.log(interior ? '--- INTERIOR ---' : '--- EXTERIOR ---');
    if (!interior) for (const car of cars) { const v = new EngineVoice(SR, car.sound, 1); const g = v.V.exGain; const rc = measureExhaustSweepRms(car.sound, SR, 0, true); const rp = measureExhaustSweepRms(car.sound, SR, g, false); console.log(`    crack-only ${(20 * Math.log10(rc)).toFixed(1)} dBFS, pulses-only ${(20 * Math.log10(rp)).toFixed(1)} dBFS`); console.log(`  ${car.id.padEnd(9)} exGain ${g.toFixed(2)} sweep-mean exhaust ${(20 * Math.log10(measureExhaustSweepRms(car.sound, SR, g))).toFixed(2)} dBFS (target ${exhaustTargetDb(car.sound.exhaustOpenness, car.sound.displacement).toFixed(2)})`); }
    for (const car of cars) {
      const rpm = Math.round(car.physics.engine.limiterRpm * 0.7);
      const { sig, dbg } = steady(car, rpm, 1, 1, interior, 2.6);
      const a = Math.floor(1.2 * SR);
      const r = (x: Float32Array): number => Math.sqrt(x.subarray(a).reduce((p, v) => p + v * v, 0) / (x.length - a));
      const ex = r(dbg.exhaust);
      const rel = keys.map((k) => `${k.slice(0, 3)} ${(20 * Math.log10(Math.max(r(dbg[k]), 1e-9) / ex)).toFixed(1).padStart(6)}`).join(' | ');
      console.log(`${car.id.padEnd(9)} rpm${String(rpm).padStart(5)} total ${rmsDb(sig, a, sig.length).toFixed(1)}dB  exhaust ${(20 * Math.log10(ex)).toFixed(1)}dB | rel: ${rel}`);
    }
  }
} else if (cmd === 'scan') {
  // dynamics: idle / part throttle / overrun / WOT, total + layers (dB re the WOT total at 0.7 limiter)
  const keys = ['exhaust', 'block', 'intake', 'mech', 'turbo', 'whine'] as const;
  const interior = +opt('interior', '0');
  for (const car of cars) {
    const e = car.physics.engine;
    const conds: [string, number, number, number][] = [
      ['wot70', e.limiterRpm * 0.7, 1, 1],
      ['wot100', e.limiterRpm * 0.98, 1, 1],
      ['part50', e.limiterRpm * 0.5, 0.3, 0.3],
      ['cruise35', e.limiterRpm * 0.35, 0.15, 0.2],
      ['idle', e.idleRpm, 0, 0.06],
      ['overrun70', e.limiterRpm * 0.7, 0, 0],
      ['overrun40', e.limiterRpm * 0.4, 0, 0],
    ];
    let ref = 0;
    for (const [name, rpm, thr, load] of conds) {
      const { sig, dbg } = steady(car, rpm, thr, load, interior, 2.6);
      const a = Math.floor(1.2 * SR);
      const r = (x: Float32Array): number => Math.sqrt(x.subarray(a).reduce((p, v) => p + v * v, 0) / (x.length - a));
      const tot = r(sig);
      if (name === 'wot70') ref = tot;
      const lay = keys.map((k) => `${k.slice(0, 3)}${(20 * Math.log10(Math.max(r(dbg[k]), 1e-9) / ref)).toFixed(0).padStart(4)}`).join(' ');
      console.log(`${car.id.padEnd(9)} ${name.padEnd(9)} rpm${String(Math.round(rpm)).padStart(5)} total ${(20 * Math.log10(tot / ref)).toFixed(1).padStart(6)}dB (abs ${(20 * Math.log10(tot)).toFixed(1)}) | ${lay}`);
    }
    console.log('');
  }
} else if (cmd === 'cpu') {
  const quality = +opt('quality', '2');
  for (const car of cars) {
    const voice = mkVoice(car, 3);
    const vi = voice.inp;
    const e = car.physics.engine;
    vi.rpm = e.redlineRpm * 0.7;
    vi.throttle = 1;
    vi.load = 1;
    vi.boost = 1;
    vi.idleRpm = e.idleRpm;
    vi.limiterRpm = e.limiterRpm;
    vi.quality = quality;
    vi.driveOmega = 150;
    const buf = new Float32Array(128);
    for (let i = 0; i < 2000; i++) voice.process(buf, 128);
    const N = 20000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      vi.rpm = e.redlineRpm * (0.5 + 0.4 * Math.sin(i * 0.001));
      voice.process(buf, 128);
    }
    const dt = performance.now() - t0;
    const perQ = (dt / N) * 1000;
    console.log(`${car.id.padEnd(9)} quality ${quality}: ${perQ.toFixed(1)} us / 128-frame quantum (${((perQ / 2666.7) * 100).toFixed(1)}% of the 2.67 ms budget)`);
  }
} else {
  console.log('unknown command', cmd);
}
void CTL;

if (cmd === 'sweep') {
  // rpm sweep at WOT with spectrogram + phase-locked deviation: node run.mjs engine-lab.ts sweep --car ronin
  for (const car of cars) {
    const e = car.physics.engine;
    const lo = Math.round(e.idleRpm * 1.4);
    const hi = Math.round(e.redlineRpm * 0.97);
    const secs = 5;
    const voice = mkVoice(car, 3);
    const vi = voice.inp;
    vi.throttle = 1;
    vi.load = 1;
    vi.idleRpm = e.idleRpm;
    vi.limiterRpm = e.limiterRpm;
    vi.boost = car.sound.turbo ? 0.9 : 0;
    const n = Math.floor(secs * SR);
    const sig = new Float32Array(n);
    const spf = 800;
    for (let f = 0; f * spf < n; f++) {
      const t = f / 60;
      vi.rpm = lo + (hi - lo) * Math.min(1, t / (secs - 0.2));
      voice.process(sig.subarray(f * spf), Math.min(spf, n - f * spf));
    }
    writeFileSync(resolve(outDir, `sweep-${car.id}.png`), spectrogramPng(sig, SR, [{ nfft: 4096, hop: 256, fMax: 1500, grid: 100, height: 360 }, { nfft: 2048, hop: 256, fMax: 8000, grid: 1000, height: 240 }]));
    const rpmAt = (t: number): number => lo + (hi - lo) * Math.min(1, t / (secs - 0.2));
    const fire = (t: number): number => (car.sound.cylinders / 2) * (rpmAt(t) / 60);
    for (const k of [1, 2, 4, 6]) {
      const d = chirpDeviation(sig, SR, (t) => k * fire(t), 0.5, secs - 0.3, { boxMs: 50, fitMs: 150, stepMs: 100 });
      const lv = [...d.level].sort((a, b) => a - b)[d.level.length >> 1];
      let se = 0;
      let c = 0;
      let ms = '';
      for (let i = 0; i < d.relDev.length; i++) {
        if (d.level[i] < 0.25 * lv) continue;
        se += d.relDev[i] ** 2;
        c++;
        if (i % 6 === 0) ms += `${(d.relDev[i] * 100).toFixed(1)} `;
      }
      console.log(`${car.id} harmonic ${k}x firing (${(k * fire(0.5)).toFixed(0)}..${(k * fire(secs - 0.3)).toFixed(0)} Hz): rms dev ${(Math.sqrt(se / Math.max(c, 1)) * 100).toFixed(2)}% | ${ms}`);
    }
  }
}
