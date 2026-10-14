/** UI sounds, music, master chain, CPU cost and the real-time smoke test (browser). */
import { PerspectiveCamera, Vector3 } from 'three';
import { CARS, getCar } from '../../src/cars';
import { chroma, hasNonFinite, peakAbs, rms, spectrogram, strongestPeak, welch } from '../../src/audio/analysis';
import { ChassisVoice } from '../../src/audio/dsp/chassis-voice';
import { EngineVoice } from '../../src/audio/dsp/engine-voice';
import { MUSIC_INFO, createAudioSystem, type AudioSystemInternals, buildMasterGraph } from '../../src/audio';
import { MenuMusic } from '../../src/audio/music';
import type { UiSound } from '../../src/core/contracts';
import { UI_SOUND_LIST } from '../../src/audio/ui-sounds';
import { DEFAULT_VOLUMES, SR, renderMusic, renderScene, renderUiSound } from './harness';
import { DriveSim } from './drive-sim';
import { steppedCar, tireCar, impactCar } from './scenarios';
import { Checks, analyseSegment, db, envelope, mono, median } from './report-util';

// ── UI sounds ──────────────────────────────────────────────────────────────────

export interface UiRow {
  sound: UiSound;
  peakDb: number;
  rmsDb: number;
  durationMs: number;
  dominantHz: number;
  centroid: number;
}

export async function uiChecks(checks: Checks): Promise<UiRow[]> {
  const rows: UiRow[] = [];
  const psds: Record<string, Float64Array> = {};
  for (const s of UI_SOUND_LIST) {
    const r = await renderUiSound(s, 3.2, true);
    const m = mono(r);
    const env = envelope(m, r.sr, 5);
    const peak = peakAbs(m);
    let last = 0;
    for (let i = 0; i < env.length; i++) if (db(env[i] / Math.max(peak, 1e-9)) > -40) last = i;
    const psd = welch(m, 16384, 0, Math.min(m.length, Math.floor((last + 4) * 0.005 * r.sr) + 2048));
    psds[s] = psd;
    const a = analyseSegment(m, r.sr, 0, Math.min(3, (last + 4) * 0.005) + 0.05, 16384);
    const pk = strongestPeak(psd, r.sr, 150, 6000);
    rows.push({ sound: s, peakDb: db(peak), rmsDb: db(rms(m, 0, Math.floor((last + 1) * 0.005 * r.sr))), durationMs: (last + 1) * 5, dominantHz: pk.freq, centroid: a.centroid });
    checks.add(`ui '${s}': no NaN, peak between -22 and -0.5 dBFS`, !hasNonFinite(r.left) && db(peak) < -0.5 && db(peak) > -22, db(peak), '-22..-0.5 dBFS');
    checks.add(`ui '${s}': finishes within 3 s`, (last + 1) * 5 < 3000, (last + 1) * 5, '< 3000 ms');
  }
  const row = (s: UiSound): UiRow => rows.find((x) => x.sound === s)!;
  checks.add("ui 'countdown': 880 Hz start-light beep", Math.abs(row('countdown').dominantHz - 880) / 880 < 0.02, row('countdown').dominantHz, '880 Hz +-2 %');
  checks.add("ui 'countdown': short and crisp", row('countdown').durationMs < 330 && row('countdown').durationMs > 90, row('countdown').durationMs, '90..330 ms');
  checks.add("ui 'go': higher pitch than the countdown beep", row('go').dominantHz > row('countdown').dominantHz * 1.25, `${row('countdown').dominantHz.toFixed(0)} -> ${row('go').dominantHz.toFixed(0)} Hz`, '> 1.25 x');
  checks.add("ui 'go': longer than a countdown beep", row('go').durationMs > row('countdown').durationMs * 1.5, `${row('countdown').durationMs} -> ${row('go').durationMs} ms`, '> 1.5 x');
  checks.add("ui 'error': low and dissonant", row('error').centroid < 900, row('error').centroid, 'centroid < 900 Hz');
  checks.add("ui 'move' is the quietest and shortest", row('move').peakDb < row('select').peakDb - 3 && row('move').durationMs < 150, `${row('move').peakDb.toFixed(1)} dB, ${row('move').durationMs} ms`, '3 dB under select, < 150 ms');
  checks.add('ui: celebratory sounds last longer (finish > bestLap > lap > select)', row('finish').durationMs > row('bestLap').durationMs && row('bestLap').durationMs > row('lap').durationMs && row('lap').durationMs > row('select').durationMs, UI_SOUND_LIST.map((s) => `${s}:${row(s).durationMs}`).join(' '), 'ordered');
  // select contains the A5 + E6 perfect fifth
  const selPsd = psds.select;
  const p880 = strongestPeak(selPsd, SR, 800, 960).powerDb;
  const p1318 = strongestPeak(selPsd, SR, 1240, 1400).powerDb;
  const floor = median(Array.from(selPsd.slice(Math.floor((2200 / SR) * 16384), Math.floor((2600 / SR) * 16384))).map((x) => 10 * Math.log10(x + 1e-14)));
  checks.add("ui 'select': contains the fifth A5 + E6 (880 / 1318 Hz)", p880 > floor + 12 && p1318 > floor + 12, `${(p880 - floor).toFixed(0)} / ${(p1318 - floor).toFixed(0)} dB above floor`, '> 12 dB');
  // all sounds are distinct
  let maxCorr = 0;
  const names = UI_SOUND_LIST;
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = psds[names[i]];
      const b = psds[names[j]];
      let sab = 0;
      let saa = 0;
      let sbb = 0;
      for (let k = 4; k < 4000; k++) {
        const x = Math.log(a[k] + 1e-14);
        const y = Math.log(b[k] + 1e-14);
        sab += x * y;
        saa += x * x;
        sbb += y * y;
      }
      maxCorr = Math.max(maxCorr, sab / Math.sqrt(saa * sbb));
    }
  }
  checks.add('ui: all nine sounds are spectrally distinct', maxCorr < 0.995, maxCorr, 'max pairwise log-spectrum correlation < 0.995');
  return rows;
}

// ── music ──────────────────────────────────────────────────────────────────────

export interface MusicReport {
  rmsDb: number;
  peakDb: number;
  inKeyPct: number;
  topPitchClasses: string;
  bassRoots: string;
  tempoLagS: number;
  bpm: number;
}

const PC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Chroma from tonal peaks only (drums / noise are broadband and do not vote). */
export function tonalChroma(psd: Float64Array, sr: number, fLo: number, fHi: number): Float64Array {
  const nfft = (psd.length - 1) * 2;
  const df = sr / nfft;
  const out = new Float64Array(12);
  const a = Math.max(8, Math.floor(fLo / df));
  const b = Math.min(psd.length - 8, Math.ceil(fHi / df));
  for (let i = a; i <= b; i++) {
    if (!(psd[i] > psd[i - 1] && psd[i] >= psd[i + 1])) continue;
    const nb: number[] = [];
    for (let k = -20; k <= 20; k++) if (Math.abs(k) > 3) nb.push(psd[i + k] ?? 0);
    nb.sort((p, q) => p - q);
    const med = nb[nb.length >> 1] || 1e-18;
    if (psd[i] < med * 16) continue; // 12 dB above the local floor
    const l = Math.log(psd[i - 1] + 1e-30);
    const c = Math.log(psd[i] + 1e-30);
    const r = Math.log(psd[i + 1] + 1e-30);
    const d = l - 2 * c + r;
    const off = d !== 0 ? (0.5 * (l - r)) / d : 0;
    const f = (i + off) * df;
    const midi = 69 + 12 * Math.log2(f / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    out[pc] += psd[i];
  }
  return out;
}

export async function musicChecks(checks: Checks): Promise<MusicReport> {
  const secs = 20;
  const r = await renderMusic(secs, 8, true);
  const m = mono(r);
  const a = Math.floor(1 * r.sr);
  const lvl = db(rms(m, a, m.length));
  const pk = db(peakAbs(m));
  checks.add('music: no NaN / no clipping', !hasNonFinite(r.left) && pk < -1, pk, 'peak < -1 dBFS');
  checks.add('music: sensible level (RMS)', lvl > -30 && lvl < -11, lvl, '-30..-11 dBFS');

  // key: pitch classes of tonal peaks
  const psd = welch(m, 32768, a, m.length);
  const ch = tonalChroma(psd, r.sr, 60, 2400);
  const total = ch.reduce((s, v) => s + v, 0) || 1;
  const inKey = [0, 2, 4, 5, 7, 8, 9, 11].reduce((s, p) => s + ch[p], 0) / total;
  const ranked = Array.from(ch.keys()).sort((p, q) => ch[q] - ch[p]);
  const top = ranked.slice(0, 4);
  checks.add('music: stays in A minor (C major set + G# leading tone)', inKey > 0.93, inKey * 100, '> 93 % of tonal energy in {C D E F G G# A B}');
  checks.add('music: tonal centre is A (A, C or E among the strongest pitch classes)', top.includes(9) && top.includes(0) && top.includes(4), top.map((p) => PC[p]).join(' '), 'top-4 contains A, C and E');

  // chord progression: bass root per bar
  const barS = MUSIC_INFO.barSeconds;
  const expected = [9, 5, 0, 7, 9, 5, 2, 4];
  const found: number[] = [];
  for (let b = 0; b < 8; b++) {
    const t0 = 0.05 + b * barS + 0.5; // skip the first beat (kick)
    const p = welch(m, 32768, Math.floor(t0 * r.sr), Math.floor((t0 + barS - 0.9) * r.sr));
    const c = tonalChroma(p, r.sr, 28, 130);
    let best = 0;
    for (let k = 1; k < 12; k++) if (c[k] > c[best]) best = k;
    found.push(best);
  }
  const hits = found.filter((f, i) => f === expected[i]).length;
  checks.add('music: bass follows the chord progression Am-F-C-G-Am-F-Dm-E', hits >= 7, `${found.map((p) => PC[p]).join(' ')} (expected ${expected.map((p) => PC[p]).join(' ')})`, '>= 7 of 8 bars');

  // tempo: low-frequency envelope autocorrelation (kick on 1 and 3 -> 2 beats = 1.25 s)
  const sg = spectrogram(m, r.sr, 1024, 256);
  const env = new Float64Array(sg.frames);
  for (let f = 0; f < sg.frames; f++) {
    let s = 0;
    for (let b = 1; b < 12; b++) s += Math.pow(10, sg.db[f * sg.bins + b] / 10);
    env[f] = Math.log(s + 1e-12);
  }
  let mean = 0;
  for (const v of env) mean += v;
  mean /= env.length;
  const hop = 256 / r.sr;
  let bestLag = 0;
  let bestV = -1;
  for (let lag = Math.floor(0.5 / hop); lag < Math.floor(2.6 / hop); lag++) {
    let s = 0;
    let n = 0;
    for (let i = 0; i + lag < env.length; i++) {
      s += (env[i] - mean) * (env[i + lag] - mean);
      n++;
    }
    const v = s / Math.max(n, 1);
    if (v > bestV) {
      bestV = v;
      bestLag = lag;
    }
  }
  const lagS = bestLag * hop;
  const beats = lagS / (60 / MUSIC_INFO.bpm);
  checks.add('music: rhythm locks to 96 BPM (pulse period is a whole number of beats)', Math.abs(beats - Math.round(beats)) < 0.06 && Math.round(beats) >= 1, `${lagS.toFixed(3)} s = ${beats.toFixed(2)} beats`, 'integer number of beats');

  // on/off crossfade
  const sr = SR;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 12 * sr, sampleRate: sr });
  const graph = buildMasterGraph(ctx, DEFAULT_VOLUMES, { raw: true });
  const music = new MenuMusic(ctx, graph.musicBus, { startBar: 8 });
  music.renderUntil(12);
  graph.musicBus.gain.value = 1;
  // gate: off until 1 s, fade in over 1.8 s, hold, fade out from 7 s over 1.4 s
  const buf = await (async () => {
    graph.setMusicGate(0, 0.001);
    ctx.suspend(1).then(() => {
      graph.setMusicGate(1, 1.8);
      ctx.resume();
    });
    ctx.suspend(7).then(() => {
      graph.setMusicGate(0, 1.4);
      ctx.resume();
    });
    return ctx.startRendering();
  })();
  const L = buf.getChannelData(0);
  const win = (t0: number, t1: number): number => db(rms(L, Math.floor(t0 * sr), Math.floor(t1 * sr)));
  const silentBefore = win(0.1, 0.9);
  const rise = [win(1.0, 1.5), win(1.5, 2.0), win(2.0, 2.5), win(2.5, 2.8)];
  const hold = win(3.5, 6.5);
  const fall = [win(7.0, 7.5), win(7.5, 8.0), win(8.0, 8.4)];
  const silentAfter = win(9.5, 11.5);
  checks.add('music: crossfade in is silent then smooth rise', silentBefore < -80 && rise.every((v, i) => i === 0 || v > rise[i - 1] - 0.5) && rise[3] > rise[0] + 6, `${silentBefore.toFixed(0)} | ${rise.map((x) => x.toFixed(1)).join(' ')} dB`, 'silent, then monotonic rise');
  checks.add('music: holds a steady level', hold > rise[3] - 1, hold, 'not below the end of the fade-in');
  checks.add('music: crossfade out reaches silence', fall.every((v, i) => i === 0 || v < fall[i - 1] + 0.5) && silentAfter < -60, `${fall.map((x) => x.toFixed(1)).join(' ')} | ${silentAfter.toFixed(0)} dB`, 'monotonic fall, then < -60 dB');
  return { rmsDb: lvl, peakDb: pk, inKeyPct: inKey * 100, topPitchClasses: top.map((p) => PC[p]).join(' '), bassRoots: found.map((p) => PC[p]).join(' '), tempoLagS: lagS, bpm: MUSIC_INFO.bpm };
}

// ── master chain ───────────────────────────────────────────────────────────────

export async function masterChecks(checks: Checks): Promise<{ hotPeak: number; hotRms: number }> {
  // a violent mix: 12 engines at WOT + tires + crash + UI + music, all faders up
  const cars = [] as ReturnType<typeof steppedCar>[];
  for (let i = 0; i < 12; i++) {
    const car = CARS[i % 4];
    const c = steppedCar(car, [{ t: 0, rpm: car.physics.engine.limiterRpm * 0.95, throttle: 1, speed: 50 }], i === 0);
    c.state.position.set((i % 3) * 3 - 3, 0.5, -(3 + i * 2));
    cars.push(c);
  }
  const crash = impactCar(CARS[0], [{ t: 1.5, kind: 'wall', strength: 30 }, { t: 2.1, kind: 'car', strength: 25 }, { t: 3.0, kind: 'wall', strength: 28 }], (t) => (t > 1.5 ? 0.9 : 0), 50);
  const res = await renderScene({
    seconds: 5,
    cars: [...cars, { ...crash, isPlayer: false }],
    volumes: { master: 1, engine: 1, effects: 1, music: 1, ui: 1 },
    raw: false,
    extra: (ctx, graph) => {
      const music = new MenuMusic(ctx, graph.musicBus, { startBar: 16 });
      graph.setMusicGate(1, 0.01);
      music.renderUntil(5);
      // a deliberately hostile signal straight into the master: DC of +4 (way over full scale)
      const dc = ctx.createConstantSource();
      dc.offset.value = 4;
      const gate = ctx.createGain();
      gate.gain.setValueAtTime(0, 0);
      gate.gain.setValueAtTime(1, 4.0);
      gate.gain.setValueAtTime(0, 4.2);
      dc.connect(gate);
      gate.connect(graph.master);
      dc.start(0);
    },
  });
  const pk = Math.max(peakAbs(res.left), peakAbs(res.right));
  const loud = db(Math.max(rms(res.left, SR, res.left.length), rms(res.right, SR, res.right.length)));
  checks.add('master: nothing leaves the destination above full scale (12 cars + crash + music + 4x DC attack)', pk <= 1.0, pk, '<= 1.0');
  checks.add('master: the hot mix is loud but not squashed to the rails', loud > -24 && loud < -3, loud, '-24..-3 dBFS RMS');
  checks.add('master: no NaN', !hasNonFinite(res.left) && !hasNonFinite(res.right));

  // bus routing: engine fader to zero silences engines but not tires; master to zero silences all
  const tires = tireCar(CARS[0], () => 35, (_t, w) => ({ skid: w === 1 ? 0.8 : 0, slipAngle: w === 1 ? 0.25 : 0.01 }));
  const withVol = async (v: typeof DEFAULT_VOLUMES): Promise<number> => {
    const r = await renderScene({ seconds: 2, cars: [{ ...tires, interior: 1 }], volumes: v, raw: true });
    return db(rms(mono(r), Math.floor(1 * r.sr), mono(r).length));
  };
  const all = await withVol(DEFAULT_VOLUMES);
  const noEngine = await withVol({ ...DEFAULT_VOLUMES, engine: 0 });
  const noEffects = await withVol({ ...DEFAULT_VOLUMES, effects: 0 });
  const noMaster = await withVol({ ...DEFAULT_VOLUMES, master: 0 });
  checks.add('master: effects fader controls tires/road, engine fader does not', noEngine > all - 6 && noEffects < all - 6, `all ${all.toFixed(1)} | no engine ${noEngine.toFixed(1)} | no effects ${noEffects.toFixed(1)}`, 'engine=0 keeps squeal; effects=0 removes it');
  checks.add('master: master fader at 0 is silent', noMaster < -90, noMaster, '< -90 dBFS');
  return { hotPeak: db(pk), hotRms: loud };
}

// ── CPU ────────────────────────────────────────────────────────────────────────

export interface CpuReport {
  quantumBudgetUs: number;
  dspUs: Record<string, number>;
  graphUsPerQuantum: Record<string, number>;
  race12UsPerQuantum: number;
  race12Pct: number;
}

function timeDsp(make: () => { process: (b: Float32Array, n: number) => void }, iters = 6000): number {
  const v = make();
  const buf = new Float32Array(128);
  for (let i = 0; i < 1500; i++) v.process(buf, 128);
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) v.process(buf, 128);
  return ((performance.now() - t0) / iters) * 1000;
}

export async function cpuChecks(checks: Checks): Promise<CpuReport> {
  const budget = (128 / SR) * 1e6;
  const dsp: Record<string, number> = {};
  for (const car of CARS) {
    const mk = (q: number) => () => {
      const v = new EngineVoice(SR, car.sound, 5);
      const e = car.physics.engine;
      Object.assign(v.inp, { rpm: e.limiterRpm * 0.7, throttle: 1, load: 1, boost: 1, idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, quality: q, driveOmega: 140 });
      return v;
    };
    dsp[`engine full / ${car.id}`] = timeDsp(mk(2));
    dsp[`engine lite / ${car.id}`] = timeDsp(mk(1));
  }
  // second channel allocated once so the timing loop does not allocate
  const chR = new Float32Array(128);
  const mkCh = (q: number, stereo: boolean) => () => {
    const v = new ChassisVoice(SR, 3);
    v.inp.quality = q;
    v.inp.speed = 50;
    v.inp.surf.set([0.5, 0.25, 0.25, 0, 0, 0]);
    v.inp.tire.set([0.4, 0.8, 0.5, 1000, 0.4, 0.8, 0.5, 900, 0, 0, 0, 1000, 0, 0, 0, 1000]);
    v.inp.curb[0] = 1;
    return { process: (b: Float32Array, n: number): void => v.process(b, stereo ? chR : null, n) };
  };
  dsp['chassis full stereo (player)'] = timeDsp(mkCh(2, true));
  dsp['chassis lite mono (opponent)'] = timeDsp(mkCh(1, false));

  const fullVals = CARS.map((c) => dsp[`engine full / ${c.id}`]);
  const liteVals = CARS.map((c) => dsp[`engine lite / ${c.id}`]);
  const maxFull = Math.max(...fullVals);
  const maxLite = Math.max(...liteVals);
  checks.add('cpu: full engine voice < 100 us per 128-frame quantum (DSP only)', maxFull < 100, maxFull, '< 100 us (3.7 % of the 2.67 ms budget)');
  checks.add('cpu: lite engine voice < 45 us per quantum', maxLite < 45, maxLite, '< 45 us');
  // realistic mix: the roster cycles through the four cars (player = first car)
  const mix = (list: number[], n: number, from: number): number => {
    let s = 0;
    for (let i = 0; i < n; i++) s += list[(from + i) % list.length];
    return s;
  };
  const race12Dsp = fullVals[0] + dsp['chassis full stereo (player)'] + mix(fullVals, 4, 1) + 4 * dsp['chassis lite mono (opponent)'] + mix(liteVals, 7, 1) + 7 * dsp['chassis lite mono (opponent)'];
  checks.add('cpu: 12-car race (player + 4 full + 7 lite) DSP cost < 20 % of the quantum budget', race12Dsp < budget * 0.2, `${race12Dsp.toFixed(0)} us (${((race12Dsp / budget) * 100).toFixed(1)} %)`, '< 20 % (timing noise margin)');

  // end-to-end through the real graph (worklet scheduling + panners + buses), offline
  const graphUs: Record<string, number> = {};
  // steady-state cost: marginal time between a short and a long render, so that JIT warm-up of the
  // freshly compiled worklet (a few hundred ms per context) is not counted
  const SHORT = 2.5;
  const LONG = 8.5;
  const Q = Math.ceil(((LONG - SHORT) * SR) / 128);
  const mkCars = (nPlayer: number, nFull: number, nLite: number): ReturnType<typeof steppedCar>[] => {
    const out: ReturnType<typeof steppedCar>[] = [];
    const add = (lod: 0 | 1 | 2, isPlayer: boolean, i: number): void => {
      const car = CARS[i % 4];
      const c = steppedCar(car, [{ t: 0, rpm: car.physics.engine.limiterRpm * 0.7, throttle: 1, speed: 40 }], isPlayer);
      c.lod = lod;
      c.state.position.set(((i * 7) % 11) - 5, 0.5, -(5 + i * 4));
      out.push(c);
    };
    let k = 0;
    for (let i = 0; i < nPlayer; i++) add(2, true, k++);
    for (let i = 0; i < nFull; i++) add(2, false, k++);
    for (let i = 0; i < nLite; i++) add(1, false, k++);
    return out;
  };
  // best of N repetitions: other processes on a shared machine only ever make a measurement slower
  const timeCfg = async (cars: ReturnType<typeof steppedCar>[], reps = 1): Promise<number> => {
    const t = async (secs: number): Promise<number> => (await renderScene({ seconds: secs, cars, raw: true, staticSpatial: true })).renderMs;
    let best = Infinity;
    for (let i = 0; i < reps; i++) {
      const a = await t(SHORT);
      const b = await t(LONG);
      best = Math.min(best, b - a);
    }
    return best;
  };
  const base = await timeCfg([]);
  const t1p = await timeCfg(mkCars(1, 0, 0), 3);
  const t1f = await timeCfg(mkCars(0, 1, 0), 3);
  const t1l = await timeCfg(mkCars(0, 0, 1), 3);
  const t12 = await timeCfg(mkCars(1, 4, 7));
  const t12f = await timeCfg(mkCars(1, 11, 0));
  const t12off = await timeCfg(mkCars(0, 0, 12).map((c) => ({ ...c, lod: 0 as const })));
  const us = (t: number, n: number): number => ((t - base) / Q / Math.max(n, 1)) * 1000;
  graphUs['player voice (engine + stereo chassis + panners)'] = us(t1p, 1);
  graphUs['opponent full'] = us(t1f, 1);
  graphUs['opponent lite'] = us(t1l, 1);
  graphUs['race of 12 (1 + 4 full + 7 lite), total'] = us(t12, 1);
  graphUs['12 full voices (worst case), total'] = us(t12f, 1);
  graphUs['sleeping voice (lod 0): per-node floor'] = us(t12off, 12);
  graphUs['empty graph baseline'] = (base / Q) * 1000;
  void SHORT;
  const race12 = graphUs['race of 12 (1 + 4 full + 7 lite), total'];
  checks.add('cpu: 12-car race through the full graph < 25 % of the quantum budget (offline render, end to end)', race12 < budget * 0.25, `${race12.toFixed(0)} us (${((race12 / budget) * 100).toFixed(1)} %)`, '< 25 %');
  checks.add('cpu: lite opponent is cheaper than a full one', graphUs['opponent lite'] < graphUs['opponent full'], `${graphUs['opponent lite'].toFixed(1)} < ${graphUs['opponent full'].toFixed(1)} us`, 'lite < full');
  return { quantumBudgetUs: budget, dspUs: dsp, graphUsPerQuantum: graphUs, race12UsPerQuantum: race12, race12Pct: (race12 / budget) * 100 };
}

// ── real-time smoke test ───────────────────────────────────────────────────────

export interface RtReport {
  ran: boolean;
  unlocked: boolean;
  engineRmsDb: number;
  pausedRmsDb: number;
  musicRmsDb: number;
  baseLatencyMs: number;
  note?: string;
}

export async function realtimeChecks(checks: Checks): Promise<RtReport> {
  const out: RtReport = { ran: false, unlocked: false, engineRmsDb: -999, pausedRmsDb: -999, musicRmsDb: -999, baseLatencyMs: 0 };
  let sys: AudioSystemInternals | null = null;
  try {
    sys = createAudioSystem({ master: 1, engine: 1, effects: 1, music: 1, ui: 1 }) as unknown as AudioSystemInternals;
    await sys.unlock();
    await sys.ready;
    out.unlocked = sys.unlocked;
    out.baseLatencyMs = ((sys.ctx as AudioContext).baseLatency ?? 0) * 1000;
    if (!sys.unlocked) {
      out.note = 'AudioContext could not start (no user activation / no output device); real-time checks skipped';
      checks.add('realtime: AudioContext unlocks', false, 'suspended', undefined, out.note);
      return out;
    }
    const an = sys.ctx.createAnalyser();
    an.fftSize = 4096;
    sys.graph.limiter.connect(an);
    const data = new Float32Array(an.fftSize);
    const level = (): number => {
      an.getFloatTimeDomainData(data);
      return db(rms(data));
    };
    const car = getCar('lmp-x');
    const sound = sys.createCarSound(car.sound, true);
    const sim = new DriveSim(car, { gear: 1, rpm: 4000 });
    const cam = new PerspectiveCamera();
    cam.position.set(0, 1.2, 4);
    const vel = new Vector3();
    let tPrev = performance.now();
    let maxEngine = -999;
    const tick = (): void => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - tPrev) / 1000);
      tPrev = now;
      sim.step(dt, 1, 0);
      sim.st.position.set(0, 0.5, 0);
      sound.update(sim.st, dt);
      sys!.setListener(cam, vel);
      sys!.update(dt);
    };
    const timer = setInterval(tick, 16);
    await new Promise((r) => setTimeout(r, 1800));
    for (let i = 0; i < 8; i++) {
      maxEngine = Math.max(maxEngine, level());
      await new Promise((r) => setTimeout(r, 60));
    }
    out.engineRmsDb = maxEngine;
    out.ran = true;
    checks.add('realtime: engine voice produces sound through the message path', maxEngine > -45, maxEngine, '> -45 dBFS');
    checks.add('realtime: AudioContext is running and the clock advances', sys.ctx.currentTime > 0.5, sys.ctx.currentTime, '> 0.5 s');
    // pause
    sys.setPaused(true);
    await new Promise((r) => setTimeout(r, 700));
    const paused = level();
    out.pausedRmsDb = paused;
    checks.add('realtime: pause mutes the cars', paused < -70, paused, '< -70 dBFS');
    // UI sound still audible while paused
    sys.ui('go');
    await new Promise((r) => setTimeout(r, 120));
    let uiLvl = -999;
    for (let i = 0; i < 6; i++) {
      uiLvl = Math.max(uiLvl, level());
      await new Promise((r) => setTimeout(r, 25));
    }
    checks.add('realtime: UI sounds still play while paused', uiLvl > -50, uiLvl, '> -50 dBFS');
    sys.setPaused(false);
    // music
    sys.setMusic(true);
    await new Promise((r) => setTimeout(r, 2600));
    clearInterval(timer);
    sound.dispose();
    await new Promise((r) => setTimeout(r, 300));
    let mus = -999;
    for (let i = 0; i < 8; i++) {
      mus = Math.max(mus, level());
      await new Promise((r) => setTimeout(r, 60));
    }
    out.musicRmsDb = mus;
    checks.add('realtime: music fades in', mus > -50, mus, '> -50 dBFS');
    sys.setMusic(false);
  } catch (e) {
    checks.add('realtime: smoke test ran without exceptions', false, String(e));
    out.note = String(e);
  } finally {
    sys?.dispose();
  }
  return out;
}

void chroma;
void tireCar;
