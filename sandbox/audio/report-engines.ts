/** Engine checks for the offline report (browser; runs the real worklet voices). */
import { CARS } from '../../src/cars';
import type { CarDefinition } from '../../src/core/contracts';
import { chirpDeviation, clickScore, offGridLines } from '../../src/audio/analysis';
import { renderScene } from './harness';
import { rampCar, steppedCar, type Segment } from './scenarios';
import { Checks, analyseSegment, db, envelope, harmonicShare, hasNonFinite, mono, peakAbs, peakNear, rms, spectralCentroid, strongestPeak, welch } from './report-util';

export interface EngineSteadyRow {
  rpm: number;
  load: number;
  expectedHz: number;
  measuredHz: number;
  errPct: number;
  prominenceDb: number;
  rmsDb: number;
  peakDb: number;
  centroid: number;
  harmonicPct: number;
  /** Level of the half-firing-frequency line relative to the firing line (dB): rumble / uneven pulses. */
  subHarmonicDb: number;
}

export async function steadyTable(car: CarDefinition, interior = 0): Promise<EngineSteadyRow[]> {
  const e = car.physics.engine;
  const rpms = [Math.round(e.idleRpm * 1.35), Math.round(e.limiterRpm * 0.4), Math.round(e.limiterRpm * 0.7), Math.round(e.redlineRpm * 0.97)];
  const loads = [1, 0.3]; // full throttle vs part throttle (0.3 keeps clear of the overrun regime)
  const segs: Segment[] = [];
  const meta: { rpm: number; load: number; t0: number }[] = [];
  let t = 0;
  for (const load of loads) {
    for (const rpm of rpms) {
      segs.push({ t, rpm, throttle: load, load, speed: 25, gear: 3 });
      meta.push({ rpm, load, t0: t });
      t += 2;
    }
  }
  const scene = steppedCar(car, segs);
  const r = await renderScene({ seconds: t, cars: [{ ...scene, interior }], raw: true });
  const m = mono(r);
  const rows: EngineSteadyRow[] = [];
  for (const mt of meta) {
    const s = analyseSegment(m, r.sr, mt.t0 + 1.0, mt.t0 + 2.0);
    const fire = (car.sound.cylinders / 2) * (mt.rpm / 60);
    const pk = peakNear(s.psd, r.sr, fire, 0.12);
    rows.push({
      rpm: mt.rpm,
      load: mt.load,
      expectedHz: fire,
      measuredHz: pk.freq,
      errPct: ((pk.freq - fire) / fire) * 100,
      prominenceDb: pk.prominenceDb,
      rmsDb: s.rmsDb,
      peakDb: s.peakDb,
      centroid: s.centroid,
      harmonicPct: harmonicShare(s.psd, r.sr, fire, Math.max(1.5, fire * 0.012), 40, 5000) * 100,
      subHarmonicDb: peakNear(s.psd, r.sr, fire / 2, 0.08).powerDb - pk.powerDb,
    });
  }
  if (hasNonFinite(r.left) || hasNonFinite(r.right)) rows.push({ rpm: -1, load: -1, expectedHz: 0, measuredHz: 0, errPct: 0, prominenceDb: 0, rmsDb: 0, peakDb: 0, centroid: 0, harmonicPct: 0, subHarmonicDb: 0 });
  return rows;
}

export interface EngineReport {
  id: string;
  steady: EngineSteadyRow[];
  sweep: { rmsErrPct: number; maxErrPct: number; click: number; envJumpDb: number; peakDb: number };
  pops: { count: number; minRatioDb: number };
  shift: { transientDb: number };
  limiter: { modDepthDb: number };
  turbo?: { whistleLowHz: number; whistleHighHz: number; promLowDb: number; promHighDb: number };
  interior: { extRmsDb: number; intRmsDb: number; extCentroid: number; intCentroid: number; extHarm: number; intHarm: number };
}

export async function engineReport(car: CarDefinition, checks: Checks): Promise<EngineReport> {
  const e = car.physics.engine;
  const id = car.id;
  const steady = await steadyTable(car);

  // pitch + level checks on the steady table
  for (const row of steady) {
    if (row.rpm < 0) {
      checks.add(`${id}: no NaN/Inf in steady renders`, false);
      continue;
    }
    const tag = `${id} @${row.rpm}rpm load ${row.load}`;
    const nearIdle = row.rpm < 1.6 * e.idleRpm;
    checks.add(`${tag}: fundamental at firing frequency`, Math.abs(row.errPct) < (nearIdle ? 1.0 : 0.5), row.errPct, nearIdle ? '|err| < 1.0 % (idle hunting)' : '|err| < 0.5 %');
    checks.add(`${tag}: firing line prominent`, row.prominenceDb > (row.load < 0.5 ? 8 : 12), row.prominenceDb, row.load < 0.5 ? '> 8 dB' : '> 12 dB');
    checks.add(`${tag}: no clipping`, row.peakDb < -0.5, row.peakDb, '< -0.5 dBFS');
  }
  checks.add(`${id}: no NaN/Inf in steady renders`, !steady.some((r) => r.rpm < 0));
  const wot = steady.filter((r) => r.load === 1 && r.rpm > 0);
  const light = steady.filter((r) => r.load === 0.3 && r.rpm > 0);
  // spectral centroid vs rpm and load. Pipe resonances make single-rpm centroids wander (harmonics crossing
  // formants), so the trend is read like a spectrogram: ten windows over a full-range ramp, means compared.
  {
    const lo = Math.round(e.idleRpm * 1.3);
    const hi = Math.round(e.redlineRpm * 0.97);
    const trace = async (thr: number): Promise<number[]> => {
      const rr = await renderScene({ seconds: 3.6, cars: [rampCar(car, lo, hi, 3.4, thr, true)], raw: true });
      const mm = mono(rr);
      const out: number[] = [];
      for (let k = 0; k < 10; k++) out.push(analyseSegment(mm, rr.sr, 0.2 + k * 0.32, 0.2 + (k + 1) * 0.32, 8192).centroid);
      return out;
    };
    const cw = await trace(1);
    const cp = await trace(0.3);
    const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
    checks.add(`${id}: spectral centroid rises with rpm (WOT ramp, upper half vs lower half)`, mean(cw.slice(5)) > mean(cw.slice(0, 5)) * 1.1, `${Math.round(mean(cw.slice(0, 5)))} -> ${Math.round(mean(cw.slice(5)))} Hz`, 'upper-half mean > 1.1 x lower-half mean');
    checks.add(`${id}: spectral centroid rises with load (full vs part throttle, mean over the rpm range)`, mean(cw) > mean(cp) * 1.05, `${Math.round(mean(cp))} -> ${Math.round(mean(cw))} Hz`, 'WOT mean > 1.05 x part-throttle mean');
  }
  checks.add(`${id}: louder at full load than at part throttle`, wot.every((r, i) => r.rmsDb > light[i].rmsDb + 1.5), wot.map((r, i) => (r.rmsDb - light[i].rmsDb).toFixed(1)).join(' '), '> +1.5 dB at every rpm point');
  checks.add(`${id}: WOT level sensible`, wot.every((r, i) => (i === 0 ? r.rmsDb > -38 : r.rmsDb > -26) && r.rmsDb < -8), wot.map((r) => r.rmsDb.toFixed(1)).join(' '), 'idle..: > -38, running: -26..-8 dBFS');

  // no aliasing whistles: at the highest rpm every tonal line above the structural modes sits on the
  // engine-order grid (turbo cars excluded: the whistle is a deliberate non-harmonic tone)
  if (!car.sound.turbo) {
    const rpmTop = Math.round(e.redlineRpm * 0.97);
    const ar = await renderScene({ seconds: 3.4, cars: [steppedCar(car, [{ t: 0, rpm: rpmTop, throttle: 1, boost: 0, speed: 0 }])], raw: true });
    const am = mono(ar);
    const off = offGridLines(welch(am, 65536, Math.floor(1.2 * ar.sr), am.length), ar.sr, rpmTop / 120, { fLo: 1000, prominenceDb: 14, floorDb: 60 });
    checks.add(`${id}: no aliasing whistles (tonal lines above 1 kHz sit on the engine-order grid)`, off.count <= 2 && (off.count === 0 || off.worstDb < -38), off.count === 0 ? 'no off-grid lines' : `${off.count} off-grid, worst ${off.worstDb.toFixed(1)} dB`, '<= 2 lines, each < -38 dB');
  }

  // smooth rpm sweep: pitch tracking + no clicks / zipper
  const secs = 5;
  const lo = Math.round(e.idleRpm * 1.4);
  const hi = Math.round(e.redlineRpm * 0.97);
  const sw = await renderScene({ seconds: secs, cars: [rampCar(car, lo, hi, secs - 0.2, 1)], raw: true });
  const sm = mono(sw);
  const rpmAt = (t: number): number => lo + (hi - lo) * Math.min(1, t / (secs - 0.2));
  // phase-locked deviation of the firing FUNDAMENTAL (higher orders are phase-noisy by design: the
  // per-event timing jitter and header interplay give the engine its natural roughness)
  const kHarm = 1;
  const tr = chirpDeviation(sm, sw.sr, (t) => kHarm * (car.sound.cylinders / 2) * (rpmAt(t) / 60), 0.5, secs - 0.3, { boxMs: 50, fitMs: 150, stepMs: 50 });
  let se = 0;
  let mx = 0;
  let n = 0;
  const lvMed = [...tr.level].sort((p, q) => p - q)[tr.level.length >> 1] || 0;
  let bias = 0;
  for (let i = 0; i < tr.relDev.length; i++) {
    if (tr.level[i] < 0.25 * lvMed) continue; // line too weak to measure
    const er = Math.abs(tr.relDev[i]);
    se += er * er;
    bias += tr.relDev[i];
    mx = Math.max(mx, er);
    n++;
  }
  void bias;
  const rmsErr = n ? Math.sqrt(se / n) * 100 : 99;
  const click = clickScore(sm.subarray(Math.floor(0.4 * sw.sr)), 96);
  const fireLo = (car.sound.cylinders / 2) * (lo / 60);
  const envMs = Math.min(80, Math.max(8, 4000 / fireLo)); // >= 4 firing periods so single pulses do not read as steps
  const envJ = envelope(sm, sw.sr, envMs, Math.floor(0.4 * sw.sr));
  let jump = 0;
  for (let i = 1; i < envJ.length; i++) jump = Math.max(jump, Math.abs(db(envJ[i] / Math.max(envJ[i - 1], 1e-9))));
  checks.add(`${id}: pitch follows rpm sweep (rms err)`, rmsErr < 1.2, rmsErr, '< 1.2 % (includes ~12 ms control smoothing lag)');
  checks.add(`${id}: pitch follows rpm sweep (max err)`, mx * 100 < 3, mx * 100, '< 3 %');
  checks.add(`${id}: rpm sweep has no clicks / zipper`, click.score < 40, click.score, '< 40 (2nd-diff peak / local rms)');
  checks.add(`${id}: rpm sweep envelope is smooth`, jump < 4, jump, `< 4 dB between ${envMs.toFixed(0)} ms windows (>= 4 firing periods)`);
  checks.add(`${id}: rpm sweep no NaN / clip`, !hasNonFinite(sw.left) && peakAbs(sm) < 0.99, db(peakAbs(sm)), '< 0 dBFS');

  // backfire pops: transient well above the local level
  const popT = [1.5, 2.1, 2.8];
  const popSegs: Segment[] = [
    { t: 0, rpm: e.redlineRpm * 0.8, throttle: 1, speed: 40 },
    { t: 1.0, rpm: e.redlineRpm * 0.75, throttle: 0, load: 0, speed: 40 },
    ...popT.map((t) => ({ t, rpm: e.redlineRpm * 0.7 - (t - 1) * 400, throttle: 0, load: 0, backfireTick: true, speed: 40 })),
  ];
  const popCar = steppedCar(car, popSegs);
  const pr = await renderScene({ seconds: 3.6, cars: [popCar], raw: true });
  const pm = mono(pr);
  let minRatio = 99;
  for (const t of popT) {
    const a = Math.floor((t + 0.002) * pr.sr);
    const peak = peakAbs(pm, a, a + Math.floor(0.05 * pr.sr));
    const before = rms(pm, Math.floor((t - 0.25) * pr.sr), Math.floor((t - 0.05) * pr.sr));
    minRatio = Math.min(minRatio, db(peak / Math.max(before, 1e-9)));
  }
  checks.add(`${id}: backfire pop stands out (peak vs local rms)`, minRatio > 7, minRatio, '> 7 dB');

  // shift clunk + dip
  const shiftSegs: Segment[] = [
    { t: 0, rpm: e.redlineRpm * 0.9, throttle: 1, speed: 45 },
    { t: 1.0, rpm: e.redlineRpm * 0.9, throttle: 0, load: 0, speed: 45 },
    { t: 1.12, rpm: e.redlineRpm * 0.7, throttle: 1, shiftTick: true, speed: 45 },
  ];
  const shR = await renderScene({ seconds: 2.2, cars: [steppedCar(car, shiftSegs)], raw: true });
  const shM = mono(shR);
  const dipRms = rms(shM, Math.floor(1.125 * shR.sr), Math.floor(1.19 * shR.sr));
  const preRms = rms(shM, Math.floor(0.6 * shR.sr), Math.floor(0.95 * shR.sr));
  checks.add(`${id}: torque-cut dip during the shift`, db(dipRms / preRms) < -4, db(dipRms / preRms), '< -4 dB vs before');
  const clunk = peakAbs(shM, Math.floor(1.12 * shR.sr), Math.floor(1.16 * shR.sr));
  checks.add(`${id}: shift clunk transient present`, db(clunk / Math.max(dipRms, 1e-9)) > 3, db(clunk / Math.max(dipRms, 1e-9)), '> 3 dB over the dip');

  // rev limiter stutter: envelope modulation in the 5-25 Hz band
  const limRpm = e.limiterRpm;
  const limOn: Segment[] = [{ t: 0, rpm: limRpm, throttle: 1, limiter: true, speed: 45 }];
  const limOff: Segment[] = [{ t: 0, rpm: limRpm, throttle: 1, limiter: false, speed: 45 }];
  const modDepth = async (segs: Segment[]): Promise<number> => {
    const lr = await renderScene({ seconds: 2.4, cars: [steppedCar(car, segs)], raw: true });
    const lm = mono(lr);
    const env = envelope(lm, lr.sr, 5, Math.floor(0.6 * lr.sr));
    // coefficient of variation of the 5 ms envelope
    let mean = 0;
    for (const v of env) mean += v;
    mean /= env.length;
    let v2 = 0;
    for (const v of env) v2 += (v - mean) * (v - mean);
    return Math.sqrt(v2 / env.length) / Math.max(mean, 1e-9);
  };
  const dOn = await modDepth(limOn);
  const dOff = await modDepth(limOff);
  checks.add(`${id}: rev limiter stutters (envelope variation)`, dOn > dOff * 1.8 && dOn > 0.2, `${dOn.toFixed(2)} vs ${dOff.toFixed(2)}`, 'limiter on > 1.8 x off and > 0.2');

  // turbo whistle
  let turbo: EngineReport['turbo'];
  if (car.sound.turbo) {
    const rpm = e.redlineRpm * 0.7;
    const mk = (boost: number): Segment[] => [{ t: 0, rpm, throttle: 1, boost, speed: 40 }];
    const spec = async (boost: number): Promise<{ psd: Float64Array; sr: number }> => {
      const rr = await renderScene({ seconds: 2.2, cars: [steppedCar(car, mk(boost))], raw: true });
      const mm = mono(rr);
      return { psd: welch(mm, 16384, Math.floor(1.0 * rr.sr), mm.length), sr: rr.sr };
    };
    const base = await spec(0);
    // the whistle is the narrow-band energy that appears when boost is added: biggest positive dB difference in 1.5-7.5 kHz
    const probe = async (boost: number): Promise<{ hz: number; prom: number }> => {
      const s2 = await spec(boost);
      const df = s2.sr / 16384;
      let best = 0;
      let bestD = -999;
      for (let i = Math.floor(1500 / df); i < Math.floor(7500 / df); i++) {
        const d = 10 * Math.log10((s2.psd[i] + 1e-14) / (base.psd[i] + 1e-14));
        if (d > bestD) {
          bestD = d;
          best = i;
        }
      }
      return { hz: best * df, prom: bestD };
    };
    const lowB = await probe(0.25);
    const highB = await probe(1);
    turbo = { whistleLowHz: lowB.hz, whistleHighHz: highB.hz, promLowDb: lowB.prom, promHighDb: highB.prom };
    checks.add(`${id}: turbo whistle appears with boost`, highB.prom > 12, highB.prom, '> +12 dB narrow-band rise vs no boost');
    checks.add(`${id}: turbo whistle pitch rises with boost`, highB.hz > lowB.hz * 1.2, `${lowB.hz.toFixed(0)} -> ${highB.hz.toFixed(0)} Hz`, 'high boost > 1.2 x low boost');
    // blow-off on lift: a noisy burst follows a throttle lift at high boost
    const lift: Segment[] = [
      { t: 0, rpm, throttle: 1, boost: 1, speed: 40 },
      { t: 1.0, rpm, throttle: 0, load: 0, boost: 0.8, speed: 40 },
    ];
    const lr = await renderScene({ seconds: 2.4, cars: [steppedCar(car, lift)], raw: true });
    const lm = mono(lr);
    const hf = (a: number, b: number): number => {
      const psd = welch(lm, 2048, Math.floor(a * lr.sr), Math.floor(b * lr.sr));
      const c = spectralCentroid(psd, lr.sr, 1000, 9000);
      return c;
    };
    void hf;
    const burst = rms(lm, Math.floor(1.03 * lr.sr), Math.floor(1.25 * lr.sr));
    const after = rms(lm, Math.floor(2.0 * lr.sr), Math.floor(2.35 * lr.sr));
    checks.add(`${id}: blow-off / flutter burst after lift`, burst > after * 1.1, db(burst / Math.max(after, 1e-9)), '> +0.8 dB vs later overrun');
  }

  // interior vs exterior: interior has more intake / mechanical (less harmonic exhaust purity)
  const rpmI = Math.round(e.limiterRpm * 0.7);
  const cmp: Segment[] = [{ t: 0, rpm: rpmI, throttle: 1, speed: 40 }];
  const ext = await renderScene({ seconds: 2.2, cars: [{ ...steppedCar(car, cmp), interior: 0 }], raw: true });
  const inn = await renderScene({ seconds: 2.2, cars: [{ ...steppedCar(car, cmp), interior: 1 }], raw: true });
  const sx = analyseSegment(mono(ext), ext.sr, 1.0, 2.2);
  const si = analyseSegment(mono(inn), inn.sr, 1.0, 2.2);
  const fire = (car.sound.cylinders / 2) * (rpmI / 60);
  const hx = harmonicShare(sx.psd, ext.sr, fire, Math.max(1.5, fire * 0.012), 40, 5000);
  const hi2 = harmonicShare(si.psd, inn.sr, fire, Math.max(1.5, fire * 0.012), 40, 5000);
  checks.add(`${id}: interior is darker than exterior (muffled exhaust path)`, si.centroid < sx.centroid, `${sx.centroid.toFixed(0)} -> ${si.centroid.toFixed(0)} Hz`, 'interior centroid < exterior');
  checks.add(`${id}: interior level comparable`, Math.abs(si.rmsDb - sx.rmsDb) < 8, si.rmsDb - sx.rmsDb, '|diff| < 8 dB');

  return {
    id,
    steady,
    sweep: { rmsErrPct: rmsErr, maxErrPct: mx * 100, click: click.score, envJumpDb: jump, peakDb: db(peakAbs(sm)) },
    pops: { count: popT.length, minRatioDb: minRatio },
    shift: { transientDb: db(clunk / Math.max(dipRms, 1e-9)) },
    limiter: { modDepthDb: db(dOn / Math.max(dOff, 1e-9)) },
    turbo,
    interior: { extRmsDb: sx.rmsDb, intRmsDb: si.rmsDb, extCentroid: sx.centroid, intCentroid: si.centroid, extHarm: hx * 100, intHarm: hi2 * 100 },
  };
}

export async function allEngines(checks: Checks): Promise<EngineReport[]> {
  const out: EngineReport[] = [];
  for (const car of CARS) out.push(await engineReport(car, checks));
  return out;
}
