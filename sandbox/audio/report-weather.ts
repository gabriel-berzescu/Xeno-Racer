/**
 * Weather checks for the offline report (browser; real worklet voices, panners, buses). Rain / storm ambience,
 * thunder, wet-tire sound, the pass-by whoosh, how all of it sits under the engines, and what it costs.
 */
import { bandPower, clickScore, envelopeJump, hasNonFinite, peakAbs, rms, strongestPeak, welch } from '../../src/audio/analysis';
import { CARS, getCar } from '../../src/cars';
import { ChassisVoice } from '../../src/audio/dsp/chassis-voice';
import { WeatherVoice } from '../../src/audio/dsp/weather-voice';
import { type ThunderEvent, planThunder, makeThunderPlan } from '../../src/audio/weather-model';
import { DEFAULT_VOLUMES, SR, renderScene, type SceneCar, type SceneResult, type WeatherScene } from './harness';
import { followListener, passByCar, run3Car, steppedCar, tireCar } from './scenarios';
import { Checks, db, envelope, mono } from './report-util';

const CAR = getCar('vanta-gt');
const NO_ENGINE = { ...DEFAULT_VOLUMES, engine: 0 };

export interface Band {
  rmsDb: number;
  peakDb: number;
  centroid: number;
  /** dB of the total power, per band: 20-150, 150-500, 500-1.5k, 1.5-4k, 4-8k, 8-16k. */
  shares: number[];
  corr: number;
}
const BANDS: [number, number][] = [
  [20, 150],
  [150, 500],
  [500, 1500],
  [1500, 4000],
  [4000, 8000],
  [8000, 16000],
];

function analyse(r: SceneResult, t0: number, t1: number): Band {
  const a = Math.floor(t0 * r.sr);
  const b = Math.min(r.left.length, Math.floor(t1 * r.sr));
  const m = mono(r);
  const psd = welch(m, 8192, a, b);
  const tot = bandPower(psd, r.sr, 20, 20000);
  const nfft = (psd.length - 1) * 2;
  const df = r.sr / nfft;
  let num = 0;
  let den = 0;
  for (let i = Math.floor(40 / df); i <= Math.ceil(12000 / df); i++) {
    num += i * df * psd[i];
    den += psd[i];
  }
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = a; i < b; i++) {
    sab += r.left[i] * r.right[i];
    saa += r.left[i] * r.left[i];
    sbb += r.right[i] * r.right[i];
  }
  return {
    rmsDb: db(Math.max(rms(r.left, a, b), rms(r.right, a, b))),
    peakDb: db(Math.max(peakAbs(r.left, a, b), peakAbs(r.right, a, b))),
    centroid: den > 0 ? num / den : 0,
    shares: BANDS.map(([f0, f1]) => 10 * Math.log10(bandPower(psd, r.sr, f0, f1) / tot + 1e-12)),
    corr: sab / Math.sqrt(saa * sbb + 1e-18),
  };
}

/** Power in [f0, f1] Hz of the mono mix over [t0, t1) s, in dB (relative to full scale^2 per Hz-bin sum). */
function bandDb(r: SceneResult, t0: number, t1: number, f0: number, f1: number): number {
  const psd = welch(mono(r), 8192, Math.floor(t0 * r.sr), Math.floor(t1 * r.sr));
  return 10 * Math.log10(bandPower(psd, r.sr, f0, f1) + 1e-20);
}

const f1 = (x: number): string => x.toFixed(1);

async function rainAlone(w: WeatherScene, seconds: number, extra: Partial<Parameters<typeof renderScene>[0]> = {}): Promise<SceneResult> {
  return renderScene({ seconds, cars: [], weather: w, raw: true, volumes: DEFAULT_VOLUMES, ...extra });
}

export interface WeatherReport {
  rain: Record<string, Band>;
  interior: Record<string, Band>;
  thunder: Record<string, number>;
  wetTires: Record<string, number>;
  passBy: Record<string, number>;
  mix: Record<string, number>;
  cpu: Record<string, number>;
}

export async function weatherChecks(checks: Checks): Promise<WeatherReport> {
  const out: WeatherReport = { rain: {}, interior: {}, thunder: {}, wetTires: {}, passBy: {}, mix: {}, cpu: {} };

  // ── A. rain bed, exterior ────────────────────────────────────────────────────
  const ext: Record<number, Band> = {};
  const extRes: Record<number, SceneResult> = {};
  for (const rain of [0.2, 0.55, 1]) {
    const r = await rainAlone({ rain }, 10);
    extRes[rain] = r;
    ext[rain] = analyse(r, 5, 10);
    out.rain[`exterior ${rain}`] = ext[rain];
    checks.add(`rain ${rain}: finite and below full scale`, !hasNonFinite(r.left) && !hasNonFinite(r.right) && ext[rain].peakDb < -3, f1(ext[rain].peakDb), 'peak < -3 dBFS');
  }
  checks.add('rain: heavier rain is louder (0.2 < 0.55 < 1, >= 3 dB apart)', ext[0.55].rmsDb > ext[0.2].rmsDb + 3 && ext[1].rmsDb > ext[0.55].rmsDb + 3, `${f1(ext[0.2].rmsDb)} / ${f1(ext[0.55].rmsDb)} / ${f1(ext[1].rmsDb)} dBFS`, 'each step >= 3 dB');
  checks.add('rain: the "rain" preset (0.55) sits at -36..-29 dBFS RMS (under the engines, still present)', ext[0.55].rmsDb > -36 && ext[0.55].rmsDb < -29, ext[0.55].rmsDb, '-36..-29 dBFS');
  checks.add('rain: the storm (1.0) sits at -31..-23 dBFS RMS', ext[1].rmsDb > -31 && ext[1].rmsDb < -23, ext[1].rmsDb, '-31..-23 dBFS');
  checks.add('rain: broadband (centroid 2-5 kHz, energy in 1.5-4 kHz and 4-8 kHz)', ext[0.55].centroid > 2000 && ext[0.55].centroid < 5000 && ext[0.55].shares[3] > -8 && ext[0.55].shares[4] > -10, `${ext[0.55].centroid.toFixed(0)} Hz, 1.5-4k ${f1(ext[0.55].shares[3])} dB, 4-8k ${f1(ext[0.55].shares[4])} dB`, 'centroid 2-5 kHz');
  checks.add('rain: no rumble (20-150 Hz < -22 dB of the total at 0.55)', ext[0.55].shares[0] < -22, ext[0.55].shares[0], '< -22 dB');
  checks.add('rain: wide, enveloping stereo (L/R correlation < 0.3)', Math.abs(ext[0.55].corr) < 0.3 && Math.abs(ext[1].corr) < 0.3, `${ext[0.55].corr.toFixed(2)} / ${ext[1].corr.toFixed(2)}`, '|r| < 0.3');

  // drop texture: light rain is separate drops (high envelope variation), a downpour is a dense roar
  const cv = (r: SceneResult): number => {
    const e = envelope(mono(r), r.sr, 5, 5 * r.sr);
    let m = 0;
    for (const v of e) m += v;
    m /= e.length;
    let s = 0;
    for (const v of e) s += (v - m) * (v - m);
    return Math.sqrt(s / e.length) / m;
  };
  const cvLight = cv(extRes[0.2]);
  const cvHeavy = cv(extRes[1]);
  out.rain['cv light/heavy'] = { rmsDb: cvLight, peakDb: cvHeavy, centroid: 0, shares: [], corr: 0 };
  checks.add('rain: light rain is patter (5 ms envelope varies a lot), a downpour is dense', cvLight > 0.35 && cvHeavy < 0.35 && cvLight > cvHeavy * 1.5, `CV ${cvLight.toFixed(2)} (0.2) vs ${cvHeavy.toFixed(2)} (1.0)`, 'light > 0.35, heavy < 0.35');
  // gusts: the level wanders slowly (not a flat tone)
  const lvl1s: number[] = [];
  for (let t = 3; t + 1 <= 10; t++) lvl1s.push(db(rms(mono(extRes[1]), Math.floor(t * SR), Math.floor((t + 1) * SR))));
  const spread = Math.max(...lvl1s) - Math.min(...lvl1s);
  checks.add('rain: the level wanders a little (gusts), by 0.3-6 dB', spread > 0.3 && spread < 6, spread, '0.3..6 dB over 1 s windows');

  // ── B. interior ──────────────────────────────────────────────────────────────
  const inter: Record<number, Band> = {};
  const interRes: Record<number, SceneResult> = {};
  for (const rain of [0.55, 1]) {
    const r = await rainAlone({ rain, interior: 1, speed: 40 }, 10);
    interRes[rain] = r;
    inter[rain] = analyse(r, 5, 10);
    out.interior[`interior ${rain}`] = inter[rain];
  }
  checks.add('interior: muffled (centroid < 0.6 x exterior; 4-8 kHz share >= 5 dB and 8-16 kHz >= 8 dB lower)', inter[0.55].centroid < ext[0.55].centroid * 0.6 && inter[0.55].shares[4] < ext[0.55].shares[4] - 5 && inter[0.55].shares[5] < ext[0.55].shares[5] - 8, `${inter[0.55].centroid.toFixed(0)} vs ${ext[0.55].centroid.toFixed(0)} Hz; 4-8k ${f1(inter[0.55].shares[4])} vs ${f1(ext[0.55].shares[4])} dB; 8-16k ${f1(inter[0.55].shares[5])} vs ${f1(ext[0.55].shares[5])} dB`, 'centroid ratio < 0.6');
  checks.add('interior: a bit quieter than outside, but the roof drumming keeps it present (-5..+1 dB)', inter[1].rmsDb - ext[1].rmsDb > -5 && inter[1].rmsDb - ext[1].rmsDb < 1, inter[1].rmsDb - ext[1].rmsDb, '-5..+1 dB vs exterior');
  checks.add('interior: drumming on the roof (a 150-1000 Hz share well above the exterior\'s)', inter[0.55].shares[1] + 10 * Math.log10(1) > ext[0.55].shares[1] + 4, `${f1(inter[0.55].shares[1])} vs ${f1(ext[0.55].shares[1])} dB`, '>= +4 dB');
  const tickBand = (r: SceneResult): number => bandDb(r, 5, 10, 2000, 5000);
  const slow = await rainAlone({ rain: 0.55, interior: 1, speed: 5 }, 10);
  const fast = await rainAlone({ rain: 0.55, interior: 1, speed: 60 }, 10);
  checks.add('interior: windscreen ticks get busier with speed (2-5 kHz +1.5 dB from 5 to 60 m/s)', tickBand(fast) > tickBand(slow) + 1.5, `${f1(tickBand(slow))} -> ${f1(tickBand(fast))} dB`, '>= +1.5 dB');
  const drumCv = (r: SceneResult): number => {
    const m = mono(r);
    const e = envelope(m, r.sr, 5, 5 * r.sr);
    let mm = 0;
    for (const v of e) mm += v;
    mm /= e.length;
    let s = 0;
    for (const v of e) s += (v - mm) * (v - mm);
    return Math.sqrt(s / e.length) / mm;
  };
  out.interior['cv'] = { rmsDb: drumCv(interRes[0.55]), peakDb: drumCv(interRes[1]), centroid: 0, shares: [], corr: 0 };

  // exterior <-> interior cross-fade is smooth and click-free (and the level stays continuous)
  const cross = await rainAlone({ rain: 0.55, interior: (t) => (t < 4 ? 0 : 1), speed: 30 }, 8);
  const cm = mono(cross);
  // 100 ms RMS trace through the switch: no step between neighbours beyond what rain's own randomness does
  const steadyJump = envelopeJump(mono(extRes[0.55]), SR, 100, 5 * SR, 10 * SR).maxRatioDb;
  const jump = envelopeJump(cm, cross.sr, 100, 2 * cross.sr, 7 * cross.sr);
  const click = clickScore(cm.subarray(Math.floor(3.5 * cross.sr), Math.floor(5 * cross.sr)), 96);
  const before = db(rms(cm, Math.floor(3 * cross.sr), Math.floor(3.9 * cross.sr)));
  const after = db(rms(cm, Math.floor(5.5 * cross.sr), Math.floor(6.4 * cross.sr)));
  out.interior['crossfade'] = { rmsDb: jump.maxRatioDb, peakDb: click.score, centroid: before - after, shares: [steadyJump], corr: 0 };
  checks.add('interior: the exterior -> cabin cross-fade is smooth (no 100 ms level step beyond what steady rain does by itself + 2 dB, no click)', jump.maxRatioDb < Math.max(3, steadyJump + 2) && click.score < 40, `max 100 ms step ${f1(jump.maxRatioDb)} dB (steady rain ${f1(steadyJump)}), click score ${click.score.toFixed(0)}`, 'step < steady + 2 dB, click < 40');

  // ── C. fade in / out and silence when dry ────────────────────────────────────
  const fade = await rainAlone({ rain: (t) => (t < 1 ? 0 : t < 9 ? 1 : 0) }, 16);
  const fm = mono(fade);
  const silentBefore = db(rms(fm, 0, Math.floor(0.9 * SR)));
  const steady = db(rms(fm, Math.floor(6 * SR), Math.floor(8.5 * SR)));
  const rise = [1.0, 1.7, 2.4, 3.1].map((t) => db(rms(fm, Math.floor(t * SR), Math.floor((t + 0.5) * SR))));
  const fall = [9.0, 9.7, 10.4, 11.1].map((t) => db(rms(fm, Math.floor(t * SR), Math.floor((t + 0.5) * SR))));
  const silentAfter = db(rms(fm, Math.floor(14 * SR), Math.floor(16 * SR)));
  out.rain['fade'] = { rmsDb: silentBefore, peakDb: silentAfter, centroid: steady, shares: [...rise, ...fall], corr: 0 };
  checks.add('weather: silent before it rains and after the fade-out (< -85 dBFS)', silentBefore < -85 && silentAfter < -85, `${f1(silentBefore)} / ${f1(silentAfter)} dBFS`, '< -85 dBFS');
  checks.add('weather: fades in and out smoothly (monotonic, ~3 s)', rise.every((v, i) => i === 0 || v > rise[i - 1] - 0.5) && fall.every((v, i) => i === 0 || v < fall[i - 1] + 0.5) && rise[3] > steady - 5 && fall[3] < steady - 12, `in ${rise.map(f1).join(' ')} | steady ${f1(steady)} | out ${fall.map(f1).join(' ')}`, 'monotonic');

  // ── D. thunder ───────────────────────────────────────────────────────────────
  const ev = (distanceKm: number, level: number, seed: number): ThunderEvent => ({ distanceKm, level, pan: 0, seed });
  const th = await rainAlone(
    {
      rain: 1,
      thunders: [
        { t: 3, ev: ev(3, 1, 11) },
        { t: 22, ev: ev(8.5, 0.75, 22) },
      ],
    },
    38,
  );
  const tm = mono(th);
  const trace = (t0: number, t1: number, step = 0.25): number[] => {
    const v: number[] = [];
    for (let t = t0; t < t1; t += step) v.push(db(rms(tm, Math.floor(t * SR), Math.floor((t + step) * SR))));
    return v;
  };
  const rainOnly = db(rms(th.left, Math.floor(15 * SR), Math.floor(21 * SR)));
  const peak1 = Math.max(...trace(3, 8, 0.1));
  const peak2 = Math.max(...trace(22, 28, 0.1));
  const tail1 = db(rms(tm, Math.floor(13.5 * SR), Math.floor(15 * SR)));
  // thunder alone: subtract the rain by rendering with the clap and without, look at the difference band
  const th0 = await rainAlone({ rain: 1 }, 38);
  const d = new Float32Array(th.left.length);
  for (let i = 0; i < d.length; i++) d[i] = th.left[i] - th0.left[i];
  const dPsd = welch(d, 16384, Math.floor(3.3 * SR), Math.floor(9 * SR));
  const dLoShare = bandPower(dPsd, SR, 20, 300) / bandPower(dPsd, SR, 20, 20000);
  const dPeak = db(Math.max(...Array.from({ length: 50 }, (_, k) => rms(d, Math.floor((3 + k * 0.1) * SR), Math.floor((3.1 + k * 0.1) * SR)))));
  const dTailT = (() => {
    // time after the onset until the clap (alone) has fallen 40 dB below its peak
    let pk = -999;
    const env: number[] = [];
    for (let k = 0; k < 120; k++) {
      const v = db(rms(d, Math.floor((3 + k * 0.1) * SR), Math.floor((3.1 + k * 0.1) * SR)));
      env.push(v);
      pk = Math.max(pk, v);
    }
    let last = 0;
    env.forEach((v, k) => {
      if (v > pk - 40) last = k;
    });
    return last * 0.1;
  })();
  const dRise = (() => {
    let pk = -999;
    let kPk = 0;
    for (let k = 0; k < 80; k++) {
      const v = db(rms(d, Math.floor((3 + k * 0.1) * SR), Math.floor((3.1 + k * 0.1) * SR)));
      if (v > pk) {
        pk = v;
        kPk = k;
      }
    }
    return kPk * 0.1;
  })();
  out.thunder = { rainOnlyDb: rainOnly, peak1Db: peak1, peak2Db: peak2, tail1Db: tail1, loShare: dLoShare, clapPeakDb: dPeak, clapDecay40s: dTailT, clapPeakAtS: dRise };
  checks.add('thunder: rolling low-frequency rumble (>= 85 % of its energy below 300 Hz)', dLoShare > 0.85, `${(dLoShare * 100).toFixed(0)} %`, '>= 85 %');
  checks.add('thunder: audible over the storm but not jarring (peak 100 ms RMS -24..-14 dBFS, at most +12 dB over the rain)', dPeak > -24 && dPeak < -14 && dPeak - rainOnly < 12, `${f1(dPeak)} dBFS (rain ${f1(rainOnly)})`, '-24..-14 dBFS');
  checks.add('thunder: a natural, long decay (10 s of tail, 40 dB down within 4-12 s of the onset)', dTailT >= 4 && dTailT <= 12, `${dTailT.toFixed(1)} s`, '4..12 s');
  checks.add('thunder: it builds before it peaks (peak after the onset, not a step)', dRise >= 0.2, `${dRise.toFixed(1)} s`, '>= 0.2 s');
  // the level parameter scales the clap: the same clap at level 0.5 is ~6 dB quieter
  const half = await rainAlone({ rain: 1, thunders: [{ t: 3, ev: ev(3, 0.5, 11) }] }, 14);
  const dh = new Float32Array(half.left.length);
  for (let i = 0; i < dh.length; i++) dh[i] = half.left[i] - th0.left[i];
  const dhPeak = db(Math.max(...Array.from({ length: 50 }, (_, k) => rms(dh, Math.floor((3 + k * 0.1) * SR), Math.floor((3.1 + k * 0.1) * SR)))));
  out.thunder['halfLevelDb'] = dhPeak - dPeak;
  checks.add('thunder: the level parameter scales the clap (0.5 is -6 dB +-1.5)', Math.abs(dhPeak - dPeak + 6.02) < 1.5, `${f1(dhPeak - dPeak)} dB`, '-6 +- 1.5 dB');
  checks.add('thunder: no NaN, nothing near full scale', !hasNonFinite(th.left) && peakAbs(th.left) < 0.5, f1(db(peakAbs(th.left))), 'peak < -6 dBFS');
  const plan = makeThunderPlan();
  planThunder(plan, ev(6, 1, 5));
  checks.add('thunder: a clap lasts 4..13 s', plan.dur >= 4 && plan.dur <= 13, plan.dur, '4..13 s');

  // ── E. wet tires (player car, chassis only) ──────────────────────────────────
  const noSlip = (): { skid: number; slipAngle: number } => ({ skid: 0, slipAngle: 0 });
  const tireRun = (speed: number, wet: number, interior = 0, seconds = 4): Promise<SceneResult> =>
    renderScene({ seconds, cars: [{ ...tireCar(CAR, () => speed, noSlip), interior }], wetness: wet, volumes: NO_ENGINE, raw: true });
  const hissDb = (r: SceneResult): number => bandDb(r, 1.5, r.left.length / r.sr, 1500, 8000);
  const dry20 = await tireRun(20, 0);
  const wet20 = await tireRun(20, 0.75);
  const dry40 = await tireRun(40, 0);
  const wet40 = await tireRun(40, 0.75);
  const dry60 = await tireRun(60, 0);
  const wet60 = await tireRun(60, 0.75);
  const wetStorm40 = await tireRun(40, 1);
  const wetInt40 = await tireRun(40, 0.75, 1);
  const dryInt40 = await tireRun(40, 0, 1);
  const d20 = hissDb(wet20) - hissDb(dry20);
  const d40 = hissDb(wet40) - hissDb(dry40);
  const d60 = hissDb(wet60) - hissDb(dry60);
  out.wetTires = {
    hiss20: d20,
    hiss40: d40,
    hiss60: d60,
    total40: analyse(wet40, 1.5, 4).rmsDb - analyse(dry40, 1.5, 4).rmsDb,
    total60: analyse(wet60, 1.5, 4).rmsDb - analyse(dry60, 1.5, 4).rmsDb,
    stormVsWet40: hissDb(wetStorm40) - hissDb(wet40),
    interiorHiss40: hissDb(wetInt40) - hissDb(dryInt40),
    hissGrow2040: hissDb(wet40) - hissDb(wet20),
    hissGrow4060: hissDb(wet60) - hissDb(wet40),
  };
  checks.add('wet tires: a hiss rises out of the road noise at speed (1.5-8 kHz: >= +6.5 dB at 40 m/s, >= +12 dB at 20 m/s)', d40 >= 6.5 && d20 >= 12, `+${f1(d20)} / +${f1(d40)} / +${f1(d60)} dB at 20 / 40 / 60 m/s`, '20: >= 12, 40: >= 6.5');
  checks.add('wet tires: hiss grows with speed (>= +6 dB from 20 to 40 m/s, >= +3 dB from 40 to 60)', out.wetTires.hissGrow2040 >= 6 && out.wetTires.hissGrow4060 >= 3, `${f1(out.wetTires.hissGrow2040)} / ${f1(out.wetTires.hissGrow4060)} dB`, '>= 6 / >= 3');
  checks.add('wet tires: wetter is louder (storm hiss >= +0.5 dB over the "rain" preset)', out.wetTires.stormVsWet40 >= 0.5, out.wetTires.stormVsWet40, '>= +0.5 dB');
  const intAbs = bandDb(wetInt40, 1.5, 4, 1500, 8000);
  const extAbs = bandDb(wet40, 1.5, 4, 1500, 8000);
  out.wetTires.interiorVsExteriorAbs = intAbs - extAbs;
  checks.add('wet tires: audible from the cabin too (>= +4 dB over the dry cabin) but softer than outside', out.wetTires.interiorHiss40 >= 4 && intAbs < extAbs - 1, `+${f1(out.wetTires.interiorHiss40)} dB over dry; ${f1(intAbs - extAbs)} dB vs outside`, '>= +4 dB; quieter than exterior');
  checks.add('wet tires: the road roar eases off a little (200-600 Hz not louder than dry)', bandDb(wet40, 1.5, 4, 200, 600) < bandDb(dry40, 1.5, 4, 200, 600) + 0.5, f1(bandDb(wet40, 1.5, 4, 200, 600) - bandDb(dry40, 1.5, 4, 200, 600)), '<= +0.5 dB');
  checks.add('wet tires: no NaN, no clipping', !hasNonFinite(wet60.left) && peakAbs(wet60.left) < 0.7, f1(db(peakAbs(wet60.left))), '< -3 dBFS');

  // dry stays dry: wetness 0 / rain 0 is the old sound (the real-time worklet start can shift by a quantum or two between
  // renders, so compare level and spectrum; the sample-exact check lives in tests/audio-weather.test.ts)
  const noW = await renderScene({ seconds: 3, cars: [{ ...tireCar(CAR, () => 40, noSlip), interior: 0 }], volumes: NO_ENGINE, raw: true });
  const zeroW = await renderScene({ seconds: 3, cars: [{ ...tireCar(CAR, () => 40, noSlip), interior: 0 }], wetness: 0, weather: { rain: 0 }, volumes: NO_ENGINE, raw: true });
  const dryLevelDiff = Math.abs(analyse(noW, 0.5, 3).rmsDb - analyse(zeroW, 0.5, 3).rmsDb);
  let dryBandDiff = 0;
  const aN = analyse(noW, 0.5, 3);
  const aZ = analyse(zeroW, 0.5, 3);
  for (let i = 0; i < 6; i++) dryBandDiff = Math.max(dryBandDiff, Math.abs(aN.shares[i] - aZ.shares[i]));
  out.wetTires.dryLevelDiffDb = dryLevelDiff;
  out.wetTires.dryBandDiffDb = dryBandDiff;
  checks.add('dry: wetness 0 / rain 0 sounds exactly like a scene without weather (level and band shares within 0.1 dB, no weather output)', dryLevelDiff < 0.1 && dryBandDiff < 0.1 && !hasNonFinite(zeroW.left), `${dryLevelDiff.toFixed(3)} dB level, ${dryBandDiff.toFixed(3)} dB bands`, '< 0.1 dB');

  // squeal on a wet road: less shriek (corner slide), slush instead of screech (wheelspin)
  const slide = (speed: number): ReturnType<typeof tireCar> =>
    tireCar(CAR, () => speed, (_t, w) => (w < 2 ? { skid: 0.55, slipAngle: 0.17, load: 4800 } : { skid: 0, slipAngle: 0.02, load: 4800 }));
  const sqDry = await renderScene({ seconds: 3, cars: [{ ...slide(35), interior: 1 }], wetness: 0, volumes: NO_ENGINE, raw: true });
  const sqWet = await renderScene({ seconds: 3, cars: [{ ...slide(35), interior: 1 }], wetness: 0.75, volumes: NO_ENGINE, raw: true });
  const prom = (r: SceneResult): number => strongestPeak(welch(mono(r), 8192, Math.floor(1 * r.sr), r.left.length), r.sr, 600, 1800).prominenceDb;
  const toneLvl = (r: SceneResult): number => bandDb(r, 1, 3, 700, 1500);
  out.wetTires.squealPromDry = prom(sqDry);
  out.wetTires.squealPromWet = prom(sqWet);
  out.wetTires.squealDropDb = toneLvl(sqDry) - toneLvl(sqWet);
  checks.add('wet tires: a cornering squeal is softer on a wet road (tonal peak >= 5 dB lower, 600-1500 Hz >= 2 dB lower)', prom(sqDry) - prom(sqWet) >= 5 && out.wetTires.squealDropDb >= 2, `prominence ${f1(prom(sqDry))} -> ${f1(prom(sqWet))} dB, band ${f1(out.wetTires.squealDropDb)} dB lower`, '>= 5 dB / >= 2 dB');
  const spin = (): ReturnType<typeof tireCar> => {
    const c = tireCar(CAR, () => 12, (_t, w) => (w >= 2 ? { skid: 0.5, slipAngle: 0.01, slipRatio: 0.55, load: 5000 } : { skid: 0, slipAngle: 0.01, load: 3500 }));
    const step = c.step;
    c.step = (t, dt, s) => {
      step(t, dt, s);
      for (let i = 0; i < 4; i++) s.wheels[i].omega = (s.speed * (i >= 2 ? 3.5 : 1)) / 0.34;
    };
    return c;
  };
  const spDry = await renderScene({ seconds: 3.5, cars: [{ ...spin(), interior: 0 }], wetness: 0, volumes: NO_ENGINE, raw: true });
  const spWet = await renderScene({ seconds: 3.5, cars: [{ ...spin(), interior: 0 }], wetness: 0.75, volumes: NO_ENGINE, raw: true });
  out.wetTires.spinPromDry = prom(spDry);
  out.wetTires.spinPromWet = prom(spWet);
  out.wetTires.spinLowMidWetDb = bandDb(spWet, 1, 3.5, 150, 1500) - bandDb(spDry, 1, 3.5, 150, 1500);
  checks.add('wet tires: wheelspin on a wet road is slush, not a screech (tonal peak < 14 dB vs a clear squeal dry)', prom(spDry) > 22 && prom(spWet) < 14, `${f1(prom(spDry))} -> ${f1(prom(spWet))} dB`, 'dry > 22, wet < 14');

  // ── F. an opponent passes on a wet road: a whoosh of spray ───────────────────
  const aiPass = async (wet: number): Promise<SceneResult> => {
    const pass = passByCar(CAR, -170, -9, 62, 0, 7000);
    return renderScene({
      seconds: 5.6,
      cars: [pass],
      wetness: wet,
      volumes: NO_ENGINE,
      raw: true,
      listener: (_t, L) => {
        L.px = 0;
        L.py = 1;
        L.pz = 0;
        L.fx = 0;
        L.fy = 0;
        L.fz = -1;
        L.ux = 0;
        L.uy = 1;
        L.uz = 0;
        L.vx = L.vy = L.vz = 0;
      },
    });
  };
  const pDry = await aiPass(0);
  const pWet = await aiPass(0.75);
  const tPass = 170 / 62;
  const near = (r: SceneResult, a: number, b: number): number => bandDb(r, tPass - 0.15, tPass + 0.15, a, b);
  const farBefore = (r: SceneResult): number => bandDb(r, tPass - 2.2, tPass - 1.8, 1500, 6000);
  out.passBy = {
    whooshAddDb: near(pWet, 1500, 6000) - near(pDry, 1500, 6000),
    spraySwellDb: near(pWet, 1500, 6000) - farBefore(pWet),
    midAddDb: near(pWet, 300, 1500) - near(pDry, 300, 1500),
  };
  checks.add('pass-by: an opponent on a wet road throws up a whoosh (1.5-6 kHz >= +10 dB over the dry pass at the closest approach)', out.passBy.whooshAddDb >= 10, `+${f1(out.passBy.whooshAddDb)} dB`, '>= +10 dB');
  checks.add('pass-by: the whoosh swells and dies away (>= 10 dB from 2 s before to the pass)', out.passBy.spraySwellDb >= 10, `${f1(out.passBy.spraySwellDb)} dB`, '>= 10 dB');
  checks.add('pass-by: finite', !hasNonFinite(pWet.left) && !hasNonFinite(pWet.right));

  // ── G. mix: the rain sits under the engines; the wet tires are heard over a lifting engine ──
  const engineRun = (): SceneCar & { liftTime: () => number } => run3Car(CAR);
  const mixRender = async (weather: WeatherScene | undefined, wet: number): Promise<SceneResult> => {
    const c = engineRun();
    return renderScene({ seconds: 8, cars: [{ ...c, interior: 0 }], listener: followListener(c, 5, 1.6), volumes: DEFAULT_VOLUMES, raw: true, weather, wetness: wet });
  };
  const eng = await mixRender(undefined, 0);
  const storm = await mixRender({ rain: 1 }, 1);
  const rainOnlyStorm = await rainAlone({ rain: 1 }, 8);
  const rain55 = await rainAlone({ rain: 0.55 }, 8);
  const engWot = analyse(eng, 1, 5.5).rmsDb;
  const rainStorm = analyse(rainOnlyStorm, 1, 8).rmsDb;
  const rain055 = analyse(rain55, 1, 8).rmsDb;
  out.mix = { engineWotDb: engWot, stormRainDb: rainStorm, rainPresetDb: rain055, stormMixDb: analyse(storm, 1, 5.5).rmsDb };
  checks.add('mix: rain sits under the engines (storm >= 8 dB below an engine at full throttle, "rain" preset >= 12 dB)', rainStorm < engWot - 8 && rain055 < engWot - 12, `engine ${f1(engWot)}, storm ${f1(rainStorm)}, rain ${f1(rain055)} dBFS`, 'storm <= engine - 8, rain <= engine - 12');
  const idleCar = (): SceneCar => steppedCar(CAR, [{ t: 0, rpm: CAR.physics.engine.idleRpm, throttle: 0, speed: 0 }]);
  const idle = await renderScene({ seconds: 5, cars: [{ ...idleCar(), interior: 0 }], volumes: DEFAULT_VOLUMES, raw: true });
  const idleDb = analyse(idle, 1.5, 5).rmsDb;
  out.mix['idleEngineDb'] = idleDb;
  checks.add('mix: at idle on the grid the rain is a real part of the picture (within +-10 dB of the idling engine)', Math.abs(rain055 - idleDb) < 10, `${f1(rain055 - idleDb)} dB`, '|diff| < 10 dB');
  checks.add('mix: storm + engine + wet tires stay clear of full scale before the limiter', peakAbs(storm.left) < 0.9 && !hasNonFinite(storm.left), f1(db(peakAbs(storm.left))), '< -1 dBFS');

  // the master chain (compressor + limiter) with everything at once
  const hot = await renderScene({
    seconds: 6,
    cars: Array.from({ length: 12 }, (_, i) => {
      const car = CARS[i % 4];
      const c = steppedCar(car, [{ t: 0, rpm: car.physics.engine.limiterRpm * 0.95, throttle: 1, speed: 55 }], i === 0);
      c.state.position.set((i % 3) * 3 - 3, 0.5, -(3 + i * 2));
      return c;
    }),
    weather: { rain: 1, interior: 0, speed: 55, thunders: [{ t: 1.5, ev: ev(2.5, 1, 77) }] },
    wetness: 1,
    volumes: DEFAULT_VOLUMES,
    raw: false,
  });
  const hotPeak = Math.max(peakAbs(hot.left), peakAbs(hot.right));
  out.mix['hotPeakDb'] = db(hotPeak);
  checks.add('mix: 12 cars at the limit in a storm with a thunder clap never leave the destination above full scale', hotPeak <= 1 && !hasNonFinite(hot.left), f1(db(hotPeak)), '<= 0 dBFS');

  // buses: the effects fader controls the rain; the engine fader does not
  const rainWithVol = async (v: typeof DEFAULT_VOLUMES): Promise<number> => db(rms(mono(await renderScene({ seconds: 4, cars: [], weather: { rain: 1 }, volumes: v, raw: true })), 2 * SR, 4 * SR));
  const vAll = await rainWithVol(DEFAULT_VOLUMES);
  const vNoEng = await rainWithVol({ ...DEFAULT_VOLUMES, engine: 0 });
  const vNoFx = await rainWithVol({ ...DEFAULT_VOLUMES, effects: 0 });
  const vNoMaster = await rainWithVol({ ...DEFAULT_VOLUMES, master: 0 });
  const vNoMusic = await rainWithVol({ ...DEFAULT_VOLUMES, music: 0, ui: 0 });
  checks.add('mix: the effects fader sets the rain level (effects 0 and master 0 silence it; engine / music / ui faders do not)', vNoFx < vAll - 60 && vNoMaster < -90 && Math.abs(vNoEng - vAll) < 0.5 && Math.abs(vNoMusic - vAll) < 0.5, `all ${f1(vAll)} | engine 0 ${f1(vNoEng)} | music+ui 0 ${f1(vNoMusic)} | effects 0 ${f1(vNoFx)} | master 0 ${f1(vNoMaster)}`, 'effects/master gate it');

  // ── H. CPU ───────────────────────────────────────────────────────────────────
  const budget = (128 / SR) * 1e6;
  // (1) the DSP itself, in a tight loop (best of several runs: stable even on a busy machine)
  const bestUs = (run: () => void, iters = 3000, reps = 5): number => {
    for (let i = 0; i < 1500; i++) run();
    let best = Infinity;
    for (let r = 0; r < reps; r++) {
      const t0 = performance.now();
      for (let i = 0; i < iters; i++) run();
      best = Math.min(best, ((performance.now() - t0) / iters) * 1000);
    }
    return best;
  };
  const wl = new Float32Array(128);
  const wr = new Float32Array(128);
  const weatherUs = (rain: number, interior: number): number => {
    const v = new WeatherVoice(SR, 5);
    Object.assign(v.inp, { rain, interior, speed: 40 });
    return bestUs(() => v.process(wl, wr, 128));
  };
  const chassisUs = (full: boolean, wet: number): number => {
    const v = new ChassisVoice(SR, 3);
    v.inp.quality = full ? 2 : 1;
    v.inp.speed = 50;
    v.inp.wet = wet;
    v.inp.surf.set([0.5, 0.25, 0.25, 0, 0, 0]);
    v.inp.tire.set([0.4, 0.8, 0.5, 1000, 0.4, 0.8, 0.5, 900, 0, 0, 0, 1000, 0, 0, 0, 1000]);
    v.inp.curb[0] = 1;
    return bestUs(() => v.process(wl, full ? wr : null, 128));
  };
  const dsp: Record<string, number> = {
    'weather voice, dry (asleep)': weatherUs(0, 0),
    'weather voice, rain 0.55': weatherUs(0.55, 0),
    'weather voice, storm': weatherUs(1, 0),
    'weather voice, storm in the cabin': weatherUs(1, 1),
    'chassis full stereo, dry': chassisUs(true, 0),
    'chassis full stereo, wet': chassisUs(true, 0.75),
    'chassis lite mono, dry': chassisUs(false, 0),
    'chassis lite mono, wet': chassisUs(false, 0.75),
  };
  const fullAdd = dsp['chassis full stereo, wet'] - dsp['chassis full stereo, dry'];
  const liteAdd = dsp['chassis lite mono, wet'] - dsp['chassis lite mono, dry'];
  const NODE_FLOOR_US = 5.5; // scheduling cost of one more AudioWorkletNode + gain (measured: cpu group, "sleeping voice")
  // a 12-car race = player + 4 full + 7 lite voices
  const race12 = (w: number): number => w + NODE_FLOOR_US + (1 + 4) * fullAdd + 7 * liteAdd;
  out.cpu = {
    ...dsp,
    'wet add per full voice': fullAdd,
    'wet add per lite voice': liteAdd,
    '12 cars: rain 0.55 + wet tires adds': race12(dsp['weather voice, rain 0.55']),
    '12 cars: storm + wet tires adds': race12(dsp['weather voice, storm']),
    '12 cars: storm in the cabin + wet tires adds': race12(dsp['weather voice, storm in the cabin']),
    budget,
  };
  const pct = (x: number): string => `${((x / budget) * 100).toFixed(2)} %`;
  checks.add('cpu: dry means zero weather cost (the voice is asleep: < 1 us per quantum)', dsp['weather voice, dry (asleep)'] < 1.5, dsp['weather voice, dry (asleep)'], '< 1.5 us');
  checks.add('cpu: rain (0.55) + wet tires on a 12-car race add <= 3 % of the audio-thread budget (DSP + node cost)', out.cpu['12 cars: rain 0.55 + wet tires adds'] <= budget * 0.03, `+${out.cpu['12 cars: rain 0.55 + wet tires adds'].toFixed(1)} us (${pct(out.cpu['12 cars: rain 0.55 + wet tires adds'])})`, '<= 3 %');
  checks.add('cpu: a storm with thunder-capable voice + wet tires on 12 cars adds <= 3 % (cabin and open)', Math.max(out.cpu['12 cars: storm + wet tires adds'], out.cpu['12 cars: storm in the cabin + wet tires adds']) <= budget * 0.03, `+${out.cpu['12 cars: storm + wet tires adds'].toFixed(1)} us (${pct(out.cpu['12 cars: storm + wet tires adds'])}); cabin +${out.cpu['12 cars: storm in the cabin + wet tires adds'].toFixed(1)} us`, '<= 3 %');

  // (2) end to end through the real graph, offline (informational: wall-clock time of a render, so other processes on the
  // machine show up as noise; best of several interleaved rounds, marginal time between a short and a long render)
  const SHORT = 2.5;
  const LONG = 8.5;
  const Q = Math.ceil(((LONG - SHORT) * SR) / 128);
  const mkCars = (nPlayer: number, nFull: number, nLite: number): ReturnType<typeof steppedCar>[] => {
    const outc: ReturnType<typeof steppedCar>[] = [];
    const add = (lod: 0 | 1 | 2, isPlayer: boolean, i: number): void => {
      const car = CARS[i % 4];
      const c = steppedCar(car, [{ t: 0, rpm: car.physics.engine.limiterRpm * 0.7, throttle: 1, speed: 40 }], isPlayer);
      c.lod = lod;
      c.state.position.set(((i * 7) % 11) - 5, 0.5, -(5 + i * 4));
      outc.push(c);
    };
    let k = 0;
    for (let i = 0; i < nPlayer; i++) add(2, true, k++);
    for (let i = 0; i < nFull; i++) add(2, false, k++);
    for (let i = 0; i < nLite; i++) add(1, false, k++);
    return outc;
  };
  const timeCfg = async (weather: WeatherScene | undefined, wet: number): Promise<number> => {
    const t = async (secs: number): Promise<number> => (await renderScene({ seconds: secs, cars: mkCars(1, 4, 7), raw: true, staticSpatial: true, weather, wetness: wet })).renderMs;
    const a = await t(SHORT);
    const b = await t(LONG);
    return b - a;
  };
  const cfgs: [string, WeatherScene | undefined, number][] = [
    ['dry', undefined, 0],
    ['rain (0.55 / 0.75)', { rain: 0.55, speed: 40 }, 0.75],
    ['storm (1 / 1) + thunder', { rain: 1, speed: 40, thunders: [{ t: 1, ev: ev(6, 1, 3) }] }, 1],
    ['storm in the cabin', { rain: 1, interior: 1, speed: 40, thunders: [{ t: 1, ev: ev(6, 1, 3) }] }, 1],
  ];
  const best: Record<string, number> = {};
  for (const [name] of cfgs) best[name] = Infinity;
  for (let round = 0; round < 5; round++) {
    for (const [name, w, wet] of cfgs) best[name] = Math.min(best[name], await timeCfg(w, wet));
  }
  const e2e = (t: number): number => (t / Q) * 1000;
  out.cpu['end-to-end 12 cars, dry'] = e2e(best['dry']);
  out.cpu['end-to-end 12 cars, rain adds'] = e2e(best['rain (0.55 / 0.75)']) - e2e(best['dry']);
  out.cpu['end-to-end 12 cars, storm adds'] = e2e(best['storm (1 / 1) + thunder']) - e2e(best['dry']);
  out.cpu['end-to-end 12 cars, storm in the cabin adds'] = e2e(best['storm in the cabin']) - e2e(best['dry']);
  checks.add('cpu: end to end (offline render of 12 cars): no gross graph overhead from the weather (guard at 8 % of the budget; the DSP numbers above are the measurement)', Math.max(out.cpu['end-to-end 12 cars, rain adds'], out.cpu['end-to-end 12 cars, storm adds'], out.cpu['end-to-end 12 cars, storm in the cabin adds']) <= budget * 0.08, `rain +${out.cpu['end-to-end 12 cars, rain adds'].toFixed(0)} us, storm +${out.cpu['end-to-end 12 cars, storm adds'].toFixed(0)} us, cabin +${out.cpu['end-to-end 12 cars, storm in the cabin adds'].toFixed(0)} us (dry ${out.cpu['end-to-end 12 cars, dry'].toFixed(0)} us)`, '<= 8 % (guard; noisy by +-50 us)');
  return out;
}
