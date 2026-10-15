/**
 * Cockpit wiper lab (Node, no browser): simulates the game loop, plans the sweeps exactly as the game does, renders the wiper
 * voice and the cabin rain, and measures the wiper against the rain: per layer, in dBFS and dB(A), against the roof drumming.
 *
 *   node sandbox/audio/lab/run.mjs wiper-lab.ts [--rain 0.55] [--seconds 16] [--speed 40] [--seed 1] [--wav] [--png]
 *
 * --wav writes wiper-only / rain-cabin / wiper-rain-cabin WAVs and --png the spectrograms to .cache/audio-lab/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { powerSpectrum, rms } from '../../../src/audio/analysis';
import { WeatherVoice } from '../../../src/audio/dsp/weather-voice';
import { WiperVoice, type WiperTrim } from '../../../src/audio/dsp/wiper-voice';
import { STREAM } from '../../../src/audio/weather-model';
import { encodeWav16 } from '../../../src/audio/wav';
import { simulateWiper, sweepTimes } from '../wiper-sim';
import { spectrogramPng } from './png';

const SR = 48000;
const args = process.argv.slice(2);
const opt = (n: string, d: string): string => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const flag = (n: string): boolean => args.includes(`--${n}`);
const rain = +opt('rain', '0.55');
const seconds = +opt('seconds', '16');
const speed = +opt('speed', '40');
const seed = +opt('seed', '1');

const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-9));

// ── A-weighting ──────────────────────────────────────────────────────────────

function aGain(f: number): number {
  const f2 = f * f;
  const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return ra * 1.2589;
}
const aCache = new Map<number, Float64Array>();
function aCurve(nfft: number): Float64Array {
  let c = aCache.get(nfft);
  if (!c) {
    c = new Float64Array(nfft / 2 + 1);
    for (let i = 1; i < c.length; i++) c[i] = aGain((i * SR) / nfft) ** 2;
    aCache.set(nfft, c);
  }
  return c;
}
/** A-weighted RMS (dB re full scale) of the nfft samples starting at `start`. */
function aDb(x: Float32Array, start: number, nfft: number): number {
  const psd = powerSpectrum(x, start, nfft);
  const w = aCurve(nfft);
  let s = 0;
  for (let i = 1; i < psd.length - 1; i++) s += psd[i] * w[i];
  return 10 * Math.log10((2 / nfft) * s + 1e-18);
}

// ── rendering ────────────────────────────────────────────────────────────────

interface Stereo {
  l: Float32Array;
  r: Float32Array;
}

function renderWiper(trim?: Partial<WiperTrim>): { out: Stereo; sim: ReturnType<typeof simulateWiper> } {
  const sim = simulateWiper({ seconds: seconds + 1, rain, sampleRate: SR, fps: 60, jitter: 0.3, seed, plannerSeed: seed });
  const v = new WiperVoice(SR, seed);
  if (trim) Object.assign(v.trim, trim);
  for (const c of sim.sweeps) v.queueSweep(c);
  const n = Math.floor(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let o = 0; o < n; o += 128) v.process(l.subarray(o, o + 128), r.subarray(o, o + 128), Math.min(128, n - o), o);
  return { out: { l, r }, sim };
}

function renderRain(only?: number[]): Stereo {
  const v = new WeatherVoice(SR, 7);
  Object.assign(v.inp, { rain, interior: 1, speed });
  if (only) {
    v.trim.hi = v.trim.lo = v.trim.wind = v.trim.cabin = v.trim.thunder = 0;
    v.trim.stream.fill(0);
    for (const s of only) v.trim.stream[s] = 1;
  }
  const n = Math.floor(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let o = 0; o < n; o += 128) v.process(l, r, Math.min(128, n - o), o);
  return { l, r };
}

function pct(a: number[], p: number): number {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}

interface Stats {
  rms: number;
  max100: number;
  p50_100: number;
  p90_100: number;
  a100max: number;
  a100p50: number;
  a100p90: number;
  a10max: number;
  a10p90: number;
  peak: number;
}

function stats(s: Stereo, from = Math.floor(2 * SR)): Stats {
  const ch = [s.l, s.r];
  const rmsAll = Math.max(rms(s.l, from, s.l.length), rms(s.r, from, s.r.length));
  const w100 = 4096;
  const w10 = 512;
  const m100: number[] = [];
  const a100: number[] = [];
  const a10: number[] = [];
  for (let a = from; a + w100 <= s.l.length; a += w100 >> 1) {
    m100.push(db(Math.max(rms(s.l, a, a + w100), rms(s.r, a, a + w100))));
    a100.push(Math.max(aDb(s.l, a, w100), aDb(s.r, a, w100)));
  }
  for (let a = from; a + w10 <= s.l.length; a += w10 >> 1) a10.push(Math.max(aDb(s.l, a, w10), aDb(s.r, a, w10)));
  let peak = 0;
  for (const c of ch) for (let i = from; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  return {
    rms: db(rmsAll),
    max100: Math.max(...m100),
    p50_100: pct(m100, 0.5),
    p90_100: pct(m100, 0.9),
    a100max: Math.max(...a100),
    a100p50: pct(a100, 0.5),
    a100p90: pct(a100, 0.9),
    a10max: Math.max(...a10),
    a10p90: pct(a10, 0.9),
    peak: db(peak),
  };
}

const f1 = (x: number): string => x.toFixed(1).padStart(6);
function row(name: string, s: Stats): void {
  console.log(
    `${name.padEnd(30)} rms ${f1(s.rms)}  peak ${f1(s.peak)} | 100ms flat max ${f1(s.max100)} p50 ${f1(s.p50_100)} | dB(A) 100ms max ${f1(s.a100max)} p50 ${f1(s.a100p50)} p90 ${f1(s.a100p90)} | dB(A) 10ms max ${f1(s.a10max)} p90 ${f1(s.a10p90)}`,
  );
}

// ── run ──────────────────────────────────────────────────────────────────────

const only = (k: keyof WiperTrim): Partial<WiperTrim> => ({ swish: 0, tick: 0, whine: 0, buzz: 0, thunk: 0, squeak: 0, [k]: 1 });
console.log(`rain ${rain}, ${seconds} s, car speed ${speed} m/s (cabin), seed ${seed}`);

const all = renderWiper();
const nSw = all.sim.sweeps.length;
console.log(`${nSw} sweeps planned (period ${(all.sim.sweeps.length > 1 ? (all.sim.sweeps[1].f0 - all.sim.sweeps[0].f0) / SR : 0).toFixed(3)} s)`);
console.log('\n── wiper layers (per channel, from 2 s) ──');
row('ALL', stats(all.out));
for (const k of ['swish', 'tick', 'whine', 'buzz', 'thunk', 'squeak'] as const) row(`  ${k} only`, stats(renderWiper(only(k)).out));

console.log('\n── cabin rain references ──');
const rainAll = renderRain();
const drum = renderRain([STREAM.DRUM]);
row('cabin rain total', stats(rainAll));
row('roof drumming only', stats(drum));
row('drum+patter+glass', stats(renderRain([STREAM.DRUM, STREAM.PATTER, STREAM.GLASS])));

const sw = stats(all.out);
const dr = stats(drum);
const tot = stats(rainAll);
console.log('\n── wiper against the rain (positive = wiper louder) ──');
console.log(`loudest 100 ms of the wiper vs median 100 ms of the drumming: flat ${(sw.max100 - dr.p50_100).toFixed(1)} dB, dB(A) ${(sw.a100max - dr.a100p50).toFixed(1)} dB`);
console.log(`loudest 100 ms of the wiper vs median 100 ms of the whole cabin rain: flat ${(sw.max100 - tot.p50_100).toFixed(1)} dB, dB(A) ${(sw.a100max - tot.a100p50).toFixed(1)} dB`);
console.log(`loudest 10 ms of the wiper vs 90th percentile 10 ms of the drumming: dB(A) ${(sw.a10max - dr.a10p90).toFixed(1)} dB`);

// ── timing of the thunks against the schedule ───────────────────────────────
{
  const thunk = renderWiper(only('thunk'));
  const x = new Float32Array(thunk.out.l.length);
  for (let i = 0; i < x.length; i++) x[i] = thunk.out.l[i] + thunk.out.r[i];
  const env = new Float32Array(x.length);
  let e = 0;
  const k = 1 - Math.exp(-1 / (0.002 * SR));
  for (let i = 0; i < x.length; i++) {
    e += k * (Math.abs(x[i]) - e);
    env[i] = e;
  }
  const errs: number[] = [];
  for (const c of all.sim.sweeps) {
    const t = sweepTimes(c, SR);
    for (const [kind, tt] of [['rev', t.reversal], ['park', t.park]] as const) {
      const a = Math.floor((tt - 0.01) * SR);
      const b = Math.floor((tt + 0.06) * SR);
      if (a < 0 || b >= env.length) continue;
      let pk = 0;
      for (let i = a; i < b; i++) pk = Math.max(pk, env[i]);
      let on = a;
      for (let i = a; i < b; i++) if (env[i] > 0.25 * pk) { on = i; break; }
      errs.push(((on / SR - tt) * 1000));
      void kind;
    }
  }
  console.log(`\nthunk onsets vs scheduled instants: mean ${(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(2)} ms, min ${Math.min(...errs).toFixed(2)}, max ${Math.max(...errs).toFixed(2)} (n=${errs.length})`);
}

// ── audibility: the wiper against the cabin rain, band by band ──────────────
if (flag('bands')) {
  const bands: [number, number][] = [[80, 160], [160, 315], [315, 630], [630, 1250], [1250, 2500], [2500, 5000], [5000, 10000]];
  const bandDb = (x: Float32Array, a: number, n: number, f0: number, f1: number): number => {
    const psd = powerSpectrum(x, a, n);
    let e = 0;
    for (let i = 1; i < psd.length - 1; i++) {
      const f = (i * SR) / n;
      if (f >= f0 && f < f1) e += psd[i];
    }
    return 10 * Math.log10((2 / n) * e + 1e-18);
  };
  const wl = all.out.l;
  const rl = rainAll.l;
  const rainOnlyBands = (a: number, n: number): number[] => bands.map(([f0, f1]) => bandDb(rl, a, n, f0, f1));
  console.log('\nwiper minus cabin rain per band (dB; > 0 = the wiper is the louder one in that band), mean over events');
  console.log('                       ' + bands.map(([a, b]) => `${a}-${b}`.padStart(11)).join(''));
  const acc: Record<string, number[][]> = { 'mid-stroke (swish)': [], 'reversal thunk': [], 'park thunk': [] };
  const nfft = 4096;
  for (const c of all.sim.sweeps) {
    const wins: [string, number][] = [
      ['mid-stroke (swish)', Math.round(c.f0 + 0.5 * c.strokeN - nfft / 2)],
      ['mid-stroke (swish)', Math.round(c.f0 + 1.5 * c.strokeN - nfft / 2)],
      ['reversal thunk', Math.round(c.f0 + c.strokeN - 256)],
      ['park thunk', Math.round(c.f0 + 2 * c.strokeN - 256)],
    ];
    for (const [k, a] of wins) {
      if (a < 2 * SR || a + nfft >= wl.length) continue;
      const n = k.startsWith('mid') ? nfft : 2048;
      const wb = bands.map(([f0, f1]) => bandDb(wl, a, n, f0, f1));
      const rb = bands.map(([f0, f1]) => bandDb(rl, a, n, f0, f1));
      acc[k].push(wb.map((v, i) => v - rb[i]));
    }
  }
  for (const [k, rows] of Object.entries(acc)) {
    if (!rows.length) continue;
    const mean = bands.map((_, i) => rows.reduce((s, r) => s + r[i], 0) / rows.length);
    console.log(`  ${k.padEnd(20)} ${mean.map((v) => v.toFixed(1).padStart(11)).join('')}   (n=${rows.length})`);
  }
  void rainOnlyBands;
}

// ── detail: the shape of each layer ─────────────────────────────────────────
if (flag('detail')) {
  const band = (x: Float32Array, a: number, n: number, f0: number, f1: number): number => {
    const psd = powerSpectrum(x, a, n);
    let s = 0;
    let tot = 0;
    for (let i = 1; i < psd.length - 1; i++) {
      const f = (i * SR) / n;
      tot += psd[i];
      if (f >= f0 && f < f1) s += psd[i];
    }
    return 10 * Math.log10(s / (tot + 1e-30) + 1e-12);
  };
  const centroid = (x: Float32Array, a: number, n: number): number => {
    const psd = powerSpectrum(x, a, n);
    let num = 0;
    let den = 0;
    for (let i = 2; i < psd.length - 1; i++) {
      num += i * psd[i];
      den += psd[i];
    }
    return (num / (den + 1e-30)) * (SR / n);
  };
  // the swish through a stroke: average over every stroke of every sweep, in 20 ms windows at fractions of the stroke
  const sw = renderWiper(only('swish'));
  const mono = new Float32Array(sw.out.l.length);
  for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (sw.out.l[i] + sw.out.r[i]);
  console.log('\nswish through a stroke (mean over strokes): flat dB, centroid, share of power <500 / 500-2k / 2-5k / >5k (dB)');
  for (const u of [0.05, 0.12, 0.25, 0.4, 0.5, 0.6, 0.75, 0.88, 0.95]) {
    let e = 0;
    let c = 0;
    const sh = [0, 0, 0, 0];
    let n = 0;
    for (const cmd of sw.sim.sweeps) {
      for (const back of [0, 1]) {
        const a = Math.round(cmd.f0 + (back + u) * cmd.strokeN - 512);
        if (a < 0 || a + 1024 > mono.length) continue;
        e += rms(mono, a, a + 1024) ** 2;
        c += centroid(mono, a, 1024);
        sh[0] += 10 ** (band(mono, a, 1024, 0, 500) / 10);
        sh[1] += 10 ** (band(mono, a, 1024, 500, 2000) / 10);
        sh[2] += 10 ** (band(mono, a, 1024, 2000, 5000) / 10);
        sh[3] += 10 ** (band(mono, a, 1024, 5000, 24000) / 10);
        n++;
      }
    }
    console.log(`  u=${u.toFixed(2)}  ${f1(db(Math.sqrt(e / n)))} dB  centroid ${(c / n).toFixed(0).padStart(5)} Hz   ${sh.map((x) => f1(10 * Math.log10(x / n + 1e-12))).join(' ')}`);
  }
  // the thunks: one sweep per variant is not available from the planner, so use whatever the run drew
  const th = renderWiper(only('thunk'));
  const tm = new Float32Array(th.out.l.length);
  for (let i = 0; i < tm.length; i++) tm[i] = 0.5 * (th.out.l[i] + th.out.r[i]);
  console.log('\nthunks: peak dBFS, time to fall 20 dB / 40 dB below the peak envelope, share of the first 60 ms below 300 Hz / 300-1k / 1-4k / >4k');
  for (const cmd of th.sim.sweeps.slice(0, 4)) {
    for (const [kind, f] of [['rev ', cmd.f0 + cmd.strokeN], ['park', cmd.f0 + 2 * cmd.strokeN]] as const) {
      let pk = 0;
      for (let i = f; i < f + 9000; i++) pk = Math.max(pk, Math.abs(tm[i]));
      // envelope in 2 ms bins
      const env: number[] = [];
      for (let i = f; i < f + 9600; i += 96) env.push(db(rms(tm, i, i + 96)));
      const ep = Math.max(...env);
      const t20 = env.findIndex((v, k) => k > env.indexOf(ep) && v < ep - 20) * 2;
      const t40 = env.findIndex((v, k) => k > env.indexOf(ep) && v < ep - 40) * 2;
      console.log(`  ${kind} idx ${kind === 'rev ' ? cmd.revIdx : cmd.parkIdx}  peak ${f1(db(pk))}  -20 dB after ${t20} ms, -40 dB after ${t40} ms   ${[[0, 300], [300, 1000], [1000, 4000], [4000, 24000]].map(([a, b]) => f1(band(tm, f, 2048, a, b))).join(' ')}`);
    }
  }
  // the whine's pitch through the first sweep (strongest line in 300-700 Hz, 85 ms windows)
  const wh = renderWiper(only('whine'));
  const wm = new Float32Array(wh.out.l.length);
  for (let i = 0; i < wm.length; i++) wm[i] = 0.5 * (wh.out.l[i] + wh.out.r[i]);
  const cmd0 = wh.sim.sweeps[0];
  console.log('\nwhine pitch through the first sweep (Hz, strongest line 300-700 Hz):');
  const line: string[] = [];
  for (let t = 0.05; t < 0.95; t += 0.07) {
    const a = Math.round(cmd0.f0 + t * SR - 1024);
    const psd = powerSpectrum(wm, a, 2048);
    let best = 0;
    for (let i = Math.floor((300 * 2048) / SR); i < (700 * 2048) / SR; i++) if (psd[i] > psd[best] || best === 0) best = i;
    const l = Math.log(psd[best - 1] + 1e-30);
    const c = Math.log(psd[best] + 1e-30);
    const r = Math.log(psd[best + 1] + 1e-30);
    const off = (0.5 * (l - r)) / (l - 2 * c + r);
    line.push(`${t.toFixed(2)}s:${(((best + off) * SR) / 2048).toFixed(0)}`);
  }
  console.log('  ' + line.join('  '));
}

// ── files ────────────────────────────────────────────────────────────────────
if (flag('wav') || flag('png')) {
  const dir = resolve('.cache/audio-lab');
  mkdirSync(dir, { recursive: true });
  const mix: Stereo = { l: new Float32Array(all.out.l.length), r: new Float32Array(all.out.l.length) };
  for (let i = 0; i < mix.l.length; i++) {
    mix.l[i] = all.out.l[i] + rainAll.l[i];
    mix.r[i] = all.out.r[i] + rainAll.r[i];
  }
  const tag = `r${Math.round(rain * 100)}`;
  if (flag('wav')) {
    writeFileSync(resolve(dir, `wiper-only-${tag}.wav`), encodeWav16([all.out.l, all.out.r], SR));
    writeFileSync(resolve(dir, `rain-cabin-${tag}.wav`), encodeWav16([rainAll.l, rainAll.r], SR));
    writeFileSync(resolve(dir, `wiper-rain-cabin-${tag}.wav`), encodeWav16([mix.l, mix.r], SR));
  }
  if (flag('png')) {
    const panels = [
      { nfft: 4096, hop: 256, fMax: 1500, grid: 100, height: 200 },
      { nfft: 1024, hop: 128, fMax: 8000, grid: 1000, height: 260 },
    ];
    const mono = (s: Stereo): Float32Array => {
      const m = new Float32Array(s.l.length);
      for (let i = 0; i < m.length; i++) m[i] = 0.5 * (s.l[i] + s.r[i]);
      return m;
    };
    const w0 = Math.floor(0.0 * SR);
    const w1 = Math.floor(Math.min(seconds, 9) * SR);
    writeFileSync(resolve(dir, `wiper-only-${tag}.png`), spectrogramPng(mono(all.out).subarray(w0, w1), SR, panels, { dbTop: -30, dbRange: 85 }));
    writeFileSync(resolve(dir, `wiper-rain-cabin-${tag}.png`), spectrogramPng(mono(mix).subarray(w0, w1), SR, panels, { dbTop: -30, dbRange: 85 }));
  }
  console.log(`\nfiles in ${dir}`);
}
