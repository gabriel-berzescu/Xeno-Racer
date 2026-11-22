/**
 * The Taccola's V12 on the bench (Node): what its voice measures steady, flat out, at each engine speed, for the profile in the roster or
 * a variant of it.
 *
 *   node sandbox/audio/lab/run.mjs taccola-lab.ts orders [--patch '{"exhaustSystem":"merged"}'] [--voicing '{"Rc":0.5}'] [--interior 1] [--car taccola] [--rpm 3000,6000] [--thr 1] [--quality 2]
 *        the lines of the crank's orders (1.5, 3, 4.5, 6, 9, 12, 15, 18) against the 6th, the firing line, every 1000 rpm, the level and
 *        the spectral centroid, the share of the power on the multiples of the 3rd order and on the odd ones of them (the 3rd, 9th, 15th:
 *        what two banks that are not twins add), and each layer against the whole (the exhaust, the intake, the block, the mechanics)
 *   node sandbox/audio/lab/run.mjs taccola-lab.ts sweep [--from 3000] [--step 125] [--patch ...] [--voicing ...] [--interior 1]
 *        the level steady at every `step` rpm from `from` to the limiter: the line fitted to it (dB per 1000 rpm) with the rms and the
 *        furthest point about it, the rms about the parabola fitted to it (the ripple, without the curve of the rise), the worst step up
 *        of 1500 rpm, the deepest sag (the most the level falls from any point to a later one) and the levels themselves
 *   node sandbox/audio/lab/run.mjs taccola-lab.ts grid [--Rc 0.2,0.45] [--Ro 0.15,0.3] [--k 0.8,1] [--from 4000] [--step 200] ...
 *        the sweep for every combination of the closed end's reflection, the open end's (x what the openness gives) and the pipes'
 *        length (x what the openness gives)
 *
 * `--patch` is merged into the profile (so its loudness is calibrated as the game would); `--voicing` is written over the derived voicing
 * of the voice after it is built (its loudness then is the unpatched profile's: for trying a number before it is given a field).
 * `--pfile` and `--vfile` read the same from a JSON file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CARS } from '../../../src/cars';
import type { EngineSoundProfile } from '../../../src/core/contracts';
import { bandPower, offGridLines, peakAbs, rms, spectralCentroid, welch } from '../../../src/audio/analysis';
import { EngineVoice, createEngineDebug, type EngineDebug, type Voicing } from '../../../src/audio/dsp/engine-voice';
import { Canvas } from './png';

const SR = process.argv.includes('--sr') ? +process.argv[process.argv.indexOf('--sr') + 1] : 48000;
const outDir = resolve('.cache/audio-lab');
mkdirSync(outDir, { recursive: true });
const args = process.argv.slice(2);
const cmd = args[0] ?? 'orders';
function opt(name: string, def: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}
/** A JSON object given on the command line, or in a file. */
function json<T>(name: string, file: string): Partial<T> {
  const f = opt(file, '');
  if (f && existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')) as Partial<T>;
  return JSON.parse(opt(name, '{}')) as Partial<T>;
}
const car = CARS.find((c) => c.id === opt('car', 'taccola'))!;
const E = car.physics.engine;
const P: EngineSoundProfile = { ...car.sound, ...json<EngineSoundProfile>('patch', 'pfile') };
const voicing = json<Voicing>('voicing', 'vfile');
const interior = +opt('interior', '0');
const thr = +opt('thr', '1');
const quality = +opt('quality', '2');
const db = (x: number): number => 20 * Math.log10(x + 1e-12);
const pdb = (x: number): number => 10 * Math.log10(x + 1e-20);

function voice(seed = 5): EngineVoice {
  const v = new EngineVoice(SR, P, seed);
  Object.assign(v.V, voicing);
  Object.assign(v.inp, { idleRpm: E.idleRpm, limiterRpm: E.limiterRpm, redlineRpm: E.redlineRpm, interior, quality });
  return v;
}

function steady(rpm: number, secs: number, seed = 5): { out: Float32Array; dbg: EngineDebug } {
  const v = voice(seed);
  Object.assign(v.inp, { rpm, throttle: thr, load: +opt('load', String(thr)), pedal: thr, boost: 0 });
  const n = Math.floor(secs * SR);
  const out = new Float32Array(n);
  const dbg = createEngineDebug(n);
  v.debug = dbg;
  v.process(out, n);
  return { out, dbg };
}

interface Sweep {
  xs: number[];
  ys: number[];
  slope: number;
  sd: number;
  dev: number;
  sd2: number;
  worst: number;
  sag: number;
}

/** Least squares of y on the powers of x up to `deg` (1 or 2): the rms of what is left and the furthest point, and the slope of the line. */
function fit(xs: number[], ys: number[], deg: 1 | 2): { sd: number; dev: number; slope: number } {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const u = xs.map((x) => x - mx);
  const S = (p: number): number => u.reduce((a, x) => a + x ** p, 0);
  const T = (p: number): number => u.reduce((a, x, i) => a + x ** p * ys[i], 0);
  let c0: number;
  let c1: number;
  let c2 = 0;
  if (deg === 1) {
    c1 = T(1) / S(2);
    c0 = T(0) / n;
  } else {
    // the normal equations in the centred powers (their first moment is 0)
    const s2 = S(2);
    const s3 = S(3);
    const s4 = S(4);
    const A = [
      [n, 0, s2],
      [0, s2, s3],
      [s2, s3, s4],
    ];
    const b = [T(0), T(1), T(2)];
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const f = A[j][i] / A[i][i];
        for (let k = i; k < 3; k++) A[j][k] -= f * A[i][k];
        b[j] -= f * b[i];
      }
    }
    c2 = b[2] / A[2][2];
    c1 = (b[1] - A[1][2] * c2) / A[1][1];
    c0 = (b[0] - A[0][2] * c2) / A[0][0];
  }
  let se = 0;
  let dev = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (c0 + c1 * u[i] + c2 * u[i] * u[i]);
    se += r * r;
    dev = Math.max(dev, Math.abs(r));
  }
  return { sd: Math.sqrt(se / n), dev, slope: c1 };
}

function sweep(from: number, step: number, secs: number): Sweep {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let rpm = from; rpm <= E.limiterRpm; rpm += step) {
    xs.push(rpm / 1000);
    ys.push(db(rms(steady(rpm, secs).out, Math.floor(0.4 * secs * SR))));
  }
  const n = xs.length;
  const line = fit(xs, ys, 1);
  const k = Math.round(1500 / step);
  let worst = 99;
  for (let i = 0; i + k < n; i++) worst = Math.min(worst, ys[i + k] - ys[i]);
  let sag = 0;
  let best = -999;
  for (const y of ys) {
    best = Math.max(best, y);
    sag = Math.min(sag, y - best);
  }
  return { xs, ys, slope: line.slope, sd: line.sd, dev: line.dev, sd2: fit(xs, ys, 2).sd, worst, sag };
}

const head = (): void => console.log(`${car.id} ${JSON.stringify(P)} voicing ${JSON.stringify(voicing)} interior ${interior} throttle ${thr} quality ${quality}`);

if (cmd === 'orders') {
  const orders = [1.5, 3, 4.5, 6, 7.5, 9, 12, 15, 18, 21, 24];
  head();
  console.log(`   rpm   rms dB  peak  centroid 6th dB | ${orders.map((o) => String(o).padStart(5)).join('')} | lines%  odd%   exh  int  blk mech whine (dB re out)`);
  const rpms = opt('rpm', '').split(',').filter(Boolean).map(Number);
  const list = rpms.length ? rpms : [1000, 1500, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 10600];
  for (const rpm of list) {
    const r = steady(rpm, 3.4);
    const dbg = r.dbg;
    // (--tap exhaust: one layer alone, in place of the whole voice)
    const tap = opt('tap', '') as '' | 'exhaust' | 'intake' | 'block' | 'mech' | 'induction';
    const out = tap ? dbg[tap]! : r.out;
    const a = Math.floor(1.0 * SR);
    const psd = welch(out, 32768, a, out.length);
    const p = (o: number): number => bandPower(psd, SR, (o * rpm * 0.985) / 60, (o * rpm * 1.015) / 60);
    const six = pdb(p(6));
    let even = 0;
    let odd = 0;
    for (let o = 3; (o * rpm) / 60 < 12000; o += 3) {
      if (o % 6 === 0) even += p(o);
      else odd += p(o);
    }
    const total = bandPower(psd, SR, 40, 12000);
    const lv = db(rms(out, a));
    const layer = (x: Float32Array): string => (db(rms(x, a)) - lv).toFixed(0).padStart(5);
    console.log(
      `${String(rpm).padStart(6)} ${lv.toFixed(1).padStart(7)} ${peakAbs(out, a).toFixed(2).padStart(6)} ${spectralCentroid(psd, SR).toFixed(0).padStart(8)} ${(lv + pdb(p(6) / bandPower(psd, SR, 20, 22000))).toFixed(1).padStart(6)} | ${orders.map((o) => ((o * rpm) / 60 < 20000 ? (pdb(p(o)) - six).toFixed(0) : '-').padStart(5)).join('')} | ${((100 * (even + odd)) / total).toFixed(0).padStart(5)} ${((100 * odd) / (even + odd)).toFixed(1).padStart(6)} ${layer(dbg.exhaust)}${layer(dbg.intake)}${layer(dbg.block)}${layer(dbg.mech)}${layer(dbg.whine)}`,
    );
  }
} else if (cmd === 'sweep') {
  const from = +opt('from', '3000');
  const step = +opt('step', '125');
  const s = sweep(from, step, 1.2);
  head();
  console.log(`sweep ${from}..${E.limiterRpm} rpm: slope ${s.slope.toFixed(2)} dB/1000 rpm, rms about the line ${s.sd.toFixed(2)} dB (furthest ${s.dev.toFixed(2)}), about the parabola ${s.sd2.toFixed(2)} dB, worst step up of 1500 rpm ${s.worst.toFixed(2)} dB, deepest sag ${s.sag.toFixed(2)} dB`);
  const rows: string[] = [];
  for (let i = 0; i < s.xs.length; i += Math.max(1, Math.round(+opt('show', '500') / step))) rows.push(`${(s.xs[i] * 1000).toFixed(0)}:${s.ys[i].toFixed(1)}`);
  console.log(rows.join('  '));
} else if (cmd === 'grid') {
  const list = (name: string, def: string): number[] => opt(name, def).split(',').map(Number);
  const from = +opt('from', '4000');
  const step = +opt('step', '200');
  const base = voice().V;
  const lens = { Ls: base.Ls, Lm: base.Lm, Lc: base.Lc, Lq: base.Lq, Lt: base.Lt };
  // (the open end's reflection as the openness gives it, before any exhaust system scales it)
  const ro0 = 0.95 + (0.88 - 0.95) * P.exhaustOpenness;
  head();
  console.log(`sweep ${from}..${E.limiterRpm} by ${step}`);
  console.log('   Rc    Ro     k | slope  line  parab  worst1500   sag');
  for (const Rc of list('Rc', '0.2,0.45,0.66'))
    for (const ro of list('Ro', '0.45,0.7,0.88'))
      for (const k of list('k', '0.65,0.8,1')) {
        Object.assign(voicing, { Rc, Ro: ro0 * ro, Ls: lens.Ls * k, Lm: lens.Lm * k, Lc: lens.Lc * k, Lq: lens.Lq * k, Lt: lens.Lt * k });
        const s = sweep(from, step, 0.8);
        console.log(`${Rc.toFixed(2).padStart(5)} ${ro.toFixed(2).padStart(5)} ${k.toFixed(2).padStart(5)} | ${s.slope.toFixed(2).padStart(5)} ${s.sd.toFixed(2).padStart(5)} ${s.sd2.toFixed(2).padStart(6)} ${s.worst.toFixed(2).padStart(9)} ${s.sag.toFixed(2).padStart(7)}`);
      }
} else if (cmd === 'map') {
  // the level and the lines of the 3rd, 6th, 9th, 12th, 15th and 18th orders at every `step` rpm, drawn against the engine speed
  const from = +opt('from', '1000');
  const step = +opt('step', '100');
  const tag = opt('tag', 'map');
  const series: { o: number; c: [number, number, number]; y: number[] }[] = [
    { o: 0, c: [255, 255, 255], y: [] },
    { o: 6, c: [255, 220, 60], y: [] },
    { o: 12, c: [255, 140, 40], y: [] },
    { o: 18, c: [240, 60, 60], y: [] },
    { o: 3, c: [80, 220, 255], y: [] },
    { o: 9, c: [90, 230, 110], y: [] },
    { o: 15, c: [110, 130, 255], y: [] },
  ];
  const xs: number[] = [];
  for (let rpm = from; rpm <= E.limiterRpm; rpm += step) {
    const r = steady(rpm, 1.1);
    const tap = opt('tap', '') as '' | 'exhaust' | 'intake' | 'block' | 'mech' | 'induction';
    const out = tap ? r.dbg[tap]! : r.out;
    const a = Math.floor(0.4 * SR);
    const psd = welch(out, 16384, a, out.length);
    xs.push(rpm);
    // (each line as its share of the whole power, under the level)
    const lv = db(rms(out, a));
    const total = bandPower(psd, SR, 20, 22000);
    for (const s of series) s.y.push(s.o === 0 ? lv : lv + pdb(bandPower(psd, SR, (s.o * rpm * 0.98) / 60, (s.o * rpm * 1.02) / 60) / total));
  }
  const W = 1200;
  const H = 560;
  const dbHi = +opt('top', '-5');
  const dbLo = dbHi - 60;
  const cv = new Canvas(W, H);
  const xOf = (rpm: number): number => ((rpm - from) / (E.limiterRpm - from)) * (W - 1);
  const yOf = (d: number): number => ((dbHi - d) / (dbHi - dbLo)) * (H - 1);
  for (let d = Math.ceil(dbLo / 5) * 5; d <= dbHi; d += 5) cv.line(0, yOf(d), W, yOf(d), d % 10 === 0 ? [70, 70, 84] : [30, 30, 40]);
  for (let r = Math.ceil(from / 1000) * 1000; r <= E.limiterRpm; r += 1000) cv.line(xOf(r), 0, xOf(r), H, [70, 70, 84]);
  for (const s of series) for (let i = 1; i < xs.length; i++) for (const dy of s.o === 0 ? [-1, 0, 1] : [0]) cv.line(xOf(xs[i - 1]), yOf(s.y[i - 1]) + dy, xOf(xs[i]), yOf(s.y[i]) + dy, s.c);
  const file = resolve(outDir, `taccola-${tag}.png`);
  writeFileSync(file, cv.png());
  head();
  console.log(`${file}: ${from}..${E.limiterRpm} rpm left to right (a line every 1000), ${dbLo}..${dbHi} dB (a line every 5); white the level, yellow / orange / red the 6th / 12th / 18th orders, cyan / green / blue the 3rd / 9th / 15th`);
} else if (cmd === 'offgrid') {
  // the tonal lines off the engine-order grid (rpm/120) at one engine speed, in the whole voice and in each layer: what folds back
  const rpm = +opt('rpm', String(E.redlineRpm * 0.97));
  const v = voice(+opt('seed', '17'));
  Object.assign(v.inp, { rpm, throttle: 1, load: 1, pedal: 1, boost: 0, driveOmega: 0 });
  const n = Math.floor(3.2 * SR);
  const out = new Float32Array(n);
  const dbg = createEngineDebug(n);
  v.debug = dbg;
  v.process(out, n);
  head();
  const taps: [string, Float32Array][] = [['out', out], ['exhaust', dbg.exhaust], ['intake', dbg.intake], ['induction', dbg.induction!], ['block', dbg.block], ['mech', dbg.mech], ['whine', dbg.whine]];
  const top = offGridLines(welch(out, 65536, Math.floor(1.2 * SR), n), SR, rpm / 120, { fLo: 1000, fHi: 0.49 * SR, prominenceDb: 14, floorDb: 80 });
  console.log(`${rpm} rpm at ${SR} Hz: ${top.count} off the grid in the voice ${JSON.stringify(top.lines.slice(0, 6))}`);
  for (const [name, x] of taps) {
    const off = offGridLines(welch(x, 65536, Math.floor(1.2 * SR), n), SR, rpm / 120, { fLo: 1000, fHi: 0.49 * SR, prominenceDb: 14, floorDb: 80 });
    console.log(`  ${name.padEnd(10)} ${db(rms(x, SR)).toFixed(1).padStart(6)} dB  ${off.count} ${JSON.stringify(off.lines.slice(0, 6).map((l) => ({ hz: +l.hz.toFixed(1), db: +l.db.toFixed(1) })))}`);
  }
  // (--hz: how much of each layer is within 4 Hz of one frequency, against the whole voice there)
  const hz = +opt('hz', '0');
  if (hz > 0) {
    const at = (x: Float32Array): number => pdb(bandPower(welch(x, 65536, Math.floor(1.2 * SR), n), SR, hz - 4, hz + 4));
    const ref = at(out);
    const rest = out.map((s, i) => s - dbg.exhaust[i] - dbg.intake[i] - dbg.block[i] - dbg.mech[i] - dbg.whine[i] - dbg.events[i] - dbg.turbo[i]);
    console.log(`  at ${hz} Hz against the voice: ${[...taps.slice(1), ['events', dbg.events] as [string, Float32Array], ['the rest', rest] as [string, Float32Array]].map(([name, x]) => `${name} ${(at(x) - ref).toFixed(1)}`).join(', ')} dB`);
  }
} else console.log('usage: taccola-lab.ts orders | sweep | grid | map | offgrid');
