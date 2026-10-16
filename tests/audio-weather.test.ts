/**
 * Wet-weather audio (headless, Node): the pure model (sanitising, rain profile, wet-road mapping, thunder
 * plan + scheduler), the rain / thunder DSP, the wet chassis (and proof that dry stays exactly dry), the
 * main-thread WeatherSystem lifecycle, and the worklet glue. The browser report (sandbox/audio.html?test=1&only=weather)
 * measures the same things through the real graph and adds CPU numbers.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CARS } from '../src/cars';
import { bandPower, clickScore, hasNonFinite, peakAbs, rms, spectralCentroid, strongestPeak, welch } from '../src/audio/analysis';
import { CarFrame } from '../src/audio/carsound';
import { ChassisMapper } from '../src/audio/chassis-controls';
import { CTL, CTL_LEN, makeControlVector } from '../src/audio/controls';
import { ChassisVoice, makeChassisInputs, readChassisInputs } from '../src/audio/dsp/chassis-voice';
import { WeatherVoice, buildProtoBank } from '../src/audio/dsp/weather-voice';
import { WetRoad, getWetTables } from '../src/audio/dsp/wet-road';
import { makeListener } from '../src/audio/spatial';
import { makeSquealLevels, slushLevel, tireSqueal, wetFilm } from '../src/audio/tires';
import { WEATHER_FADE_OUT_S, WeatherSystem, type WeatherNodeLike } from '../src/audio/weather';
import {
  N_STREAMS,
  STREAM,
  THUNDER_INTERVAL_MAX,
  THUNDER_INTERVAL_MIN,
  THUNDER_MAX_LOBES,
  THUNDER_MIN_RAIN,
  type ThunderEvent,
  ThunderScheduler,
  WCTL,
  WCTL_LEN,
  makeRainProfile,
  makeThunderPlan,
  makeWeatherControlVector,
  makeWeatherInputs,
  makeWetRoadLevels,
  planThunder,
  rainProfile,
  readWeatherInputs,
  sanitizeWeather,
  thunderDelay,
  thunderEnvelope,
  thunderInterval,
  wetRoad,
} from '../src/audio/weather-model';
import { makeVehicleState } from '../sandbox/audio/drive-sim';
import type { WheelState } from '../src/core/contracts';

const SR = 48000;
const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-9));

// ── helpers ──────────────────────────────────────────────────────────────────

function renderRain(sec: number, setup: (v: WeatherVoice, t: number) => void, seed = 1, every = 0.05): { l: Float32Array; r: Float32Array; v: WeatherVoice } {
  const v = new WeatherVoice(SR, seed);
  const n = Math.floor(sec * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  let next = 0;
  for (let o = 0; o < n; o += 128) {
    const t = o / SR;
    if (t >= next) {
      setup(v, t);
      next = t + every;
    }
    v.process(l, r, Math.min(128, n - o), o);
  }
  return { l, r, v };
}

function mono(l: Float32Array, r: Float32Array): Float32Array {
  const m = new Float32Array(l.length);
  for (let i = 0; i < m.length; i++) m[i] = (l[i] + r[i]) * 0.5;
  return m;
}

function share(x: Float32Array, a: number, b: number, from: number, to: number, nfft = 8192): number {
  const psd = welch(x, nfft, from, to);
  return bandPower(psd, SR, a, b) / bandPower(psd, SR, 20, 20000);
}

function corr(l: Float32Array, r: Float32Array, from: number): number {
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = from; i < l.length; i++) {
    sab += l[i] * r[i];
    saa += l[i] * l[i];
    sbb += r[i] * r[i];
  }
  return sab / Math.sqrt(saa * sbb + 1e-18);
}

/** Coefficient of variation of the RMS envelope in 5 ms windows. */
function envCv(x: Float32Array, from: number): number {
  const w = Math.floor(0.005 * SR);
  const e: number[] = [];
  for (let s = from; s + w <= x.length; s += w) e.push(rms(x, s, s + w));
  const m = e.reduce((a, b) => a + b, 0) / e.length;
  const sd = Math.sqrt(e.reduce((a, b) => a + (b - m) ** 2, 0) / e.length);
  return sd / m;
}

// ── sanitising, control layout ───────────────────────────────────────────────

describe('weather inputs', () => {
  it('sanitizeWeather clamps to 0..1 and turns NaN / Infinity into 0', () => {
    expect(sanitizeWeather(0.55, 0.75)).toEqual({ rain: 0.55, wetness: 0.75 });
    expect(sanitizeWeather(-3, 7)).toEqual({ rain: 0, wetness: 1 });
    expect(sanitizeWeather(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ rain: 0, wetness: 0 });
    expect(sanitizeWeather(Number.NEGATIVE_INFINITY, Number.NaN)).toEqual({ rain: 0, wetness: 0 });
  });

  it('readWeatherInputs sanitises the vector the worklet receives', () => {
    const v = makeWeatherControlVector();
    const o = makeWeatherInputs();
    v[WCTL.RAIN] = 5;
    v[WCTL.INTERIOR] = Number.NaN;
    v[WCTL.SPEED] = Number.POSITIVE_INFINITY;
    v[WCTL.GAIN] = -2;
    readWeatherInputs(v, o);
    expect(o).toEqual({ rain: 1, interior: 0, speed: 0, gain: 0 });
    v[WCTL.SPEED] = 999;
    v[WCTL.GAIN] = 1;
    readWeatherInputs(v, o);
    expect(o.speed).toBe(200);
    expect(WCTL_LEN).toBeGreaterThan(Math.max(...Object.values(WCTL)));
  });

  it('the new car-control slots fit the vector and do not collide with the chassis fields', () => {
    expect(CTL.WET).toBeGreaterThan(CTL.CH_QUALITY);
    expect(CTL.SLUSH0 + 3).toBeLessThan(CTL_LEN);
    expect(CTL.SLUSH0).toBe(CTL.WET + 1);
    const o = makeChassisInputs();
    const v = makeControlVector();
    v[CTL.WET] = 2;
    v[CTL.SLUSH0 + 2] = 0.7;
    v[CTL.SLUSH0 + 3] = Number.NaN;
    readChassisInputs(v, o);
    expect(o.wet).toBe(1);
    expect(o.slush[2]).toBeCloseTo(0.7, 6);
    expect(o.slush[3]).toBe(0);
  });
});

// ── rain profile ─────────────────────────────────────────────────────────────

describe('rainProfile: intensity -> drop streams and bed levels', () => {
  const P = makeRainProfile();
  const snap = (rain: number, interior = 0, speedN = 0.5): { rate: number[]; bedHi: number; bedLo: number; bedCabin: number; wind: number } => {
    rainProfile(rain, interior, speedN, P);
    return { rate: Array.from(P.rate), bedHi: P.bedHi, bedLo: P.bedLo, bedCabin: P.bedCabin, wind: P.wind };
  };

  it('is exactly zero when dry', () => {
    for (const interior of [0, 1]) {
      const z = snap(0, interior, 1);
      expect(z.rate.every((x) => x === 0)).toBe(true);
      expect(z.bedHi + z.bedLo + z.bedCabin + z.wind).toBe(0);
    }
  });

  it('rises monotonically with the rain', () => {
    let prev = snap(0);
    for (let r = 0.05; r <= 1.0001; r += 0.05) {
      const cur = snap(r);
      for (let s = 0; s < STREAM.DRUM; s++) expect(cur.rate[s]).toBeGreaterThanOrEqual(prev.rate[s]);
      expect(cur.bedHi).toBeGreaterThanOrEqual(prev.bedHi);
      expect(cur.bedLo).toBeGreaterThanOrEqual(prev.bedLo);
      expect(cur.wind).toBeGreaterThanOrEqual(prev.wind);
      prev = cur;
    }
    let pc = snap(0, 1);
    for (let r = 0.05; r <= 1.0001; r += 0.05) {
      const cur = snap(r, 1);
      for (let s = STREAM.DRUM; s < N_STREAMS; s++) expect(cur.rate[s]).toBeGreaterThanOrEqual(pc.rate[s]);
      expect(cur.bedCabin).toBeGreaterThanOrEqual(pc.bedCabin);
      pc = cur;
    }
  });

  it('light rain is patter, a downpour is dense: far more drops, and the dense layers (grains, bed) grow faster than the big drops', () => {
    const light = snap(0.2);
    const heavy = snap(1);
    expect(heavy.rate[STREAM.TICK]).toBeGreaterThan(light.rate[STREAM.TICK] * 4);
    expect(heavy.rate[STREAM.GRAIN] / light.rate[STREAM.GRAIN]).toBeGreaterThan(heavy.rate[STREAM.PLINK] / light.rate[STREAM.PLINK]);
    expect(heavy.bedHi / light.bedHi).toBeGreaterThan(heavy.rate[STREAM.PLINK] / light.rate[STREAM.PLINK]);
    expect(snap(0.55).wind).toBeLessThan(0.05); // only a storm blows
    expect(snap(1).wind).toBe(1);
  });

  it('the exterior set cross-fades into the cabin set with the interior flag', () => {
    const out = snap(0.7, 0);
    const mid = snap(0.7, 0.5);
    const inn = snap(0.7, 1);
    expect(out.rate[STREAM.DRUM] + out.rate[STREAM.GLASS] + out.bedCabin).toBe(0);
    expect(inn.rate[STREAM.GRAIN] + inn.rate[STREAM.PLINK] + inn.bedHi + inn.bedLo).toBe(0);
    expect(mid.rate[STREAM.PLINK]).toBeCloseTo(out.rate[STREAM.PLINK] * 0.5, 9);
    expect(mid.rate[STREAM.DRUM]).toBeCloseTo(inn.rate[STREAM.DRUM] * 0.5, 9);
  });

  it('windscreen ticks come faster with speed', () => {
    expect(snap(0.6, 1, 1).rate[STREAM.GLASS]).toBeGreaterThan(snap(0.6, 1, 0).rate[STREAM.GLASS] * 1.5);
  });
});

// ── wet road mapping ─────────────────────────────────────────────────────────

describe('wetRoad: speed / wetness / surface -> hiss, spray, brightness', () => {
  const L = makeWetRoadLevels();
  const at = (wet: number, paved: number, speed: number, interior = 0): { hiss: number; spray: number; step: number; roarCut: number; splashRate: number } => {
    wetRoad(wet, paved, speed, interior, L);
    return { ...L };
  };

  it('a dry road, or no wheel on a wettable surface, adds nothing', () => {
    for (const z of [at(0, 1, 50), at(0.8, 0, 50), at(Number.NaN, 1, 50)]) {
      expect(z.hiss + z.spray + z.roarCut + z.splashRate).toBe(0);
      expect(z.step).toBe(1);
    }
  });

  it('hiss grows steeply with speed (about +9.6 dB per doubling) and with wetness', () => {
    const h = (v: number): number => at(0.75, 1, v).hiss;
    expect(db(h(40) / h(20))).toBeGreaterThan(8.5);
    expect(db(h(40) / h(20))).toBeLessThan(11);
    expect(h(60)).toBeGreaterThan(h(40));
    expect(at(1, 1, 40).hiss).toBeGreaterThan(at(0.75, 1, 40).hiss);
    expect(at(0.3, 1, 40).hiss).toBeLessThan(at(0.75, 1, 40).hiss);
    // below walking pace there is no sizzle
    expect(at(0.75, 1, 0.5).hiss).toBe(0);
  });

  it('spray builds later than hiss (steeper in speed); the road roar eases off with the water', () => {
    const r = (v: number): number => at(0.75, 1, v).spray / at(0.75, 1, v).hiss;
    expect(r(60)).toBeGreaterThan(r(25));
    expect(at(1, 1, 40).roarCut).toBeGreaterThan(at(0.4, 1, 40).roarCut);
    expect(at(1, 1, 40).roarCut).toBeLessThan(0.4);
  });

  it('brighter with speed, duller in the cabin; puddles only when it is really wet and fast', () => {
    expect(at(0.75, 1, 60).step).toBeGreaterThan(at(0.75, 1, 10).step);
    expect(at(0.75, 1, 40, 1).step).toBeLessThan(at(0.75, 1, 40, 0).step);
    expect(at(0.75, 1, 40, 1).hiss).toBeLessThan(at(0.75, 1, 40, 0).hiss);
    expect(at(0.2, 1, 40).splashRate).toBe(0);
    expect(at(0.75, 1, 5).splashRate).toBe(0);
    expect(at(1, 1, 50).splashRate).toBeGreaterThan(0.5);
  });
});

// ── thunder ──────────────────────────────────────────────────────────────────

describe('thunder: interval, scheduler, plan', () => {
  it('only a real storm thunders; the interval is 20-60 s at full intensity and stretches for a lighter one', () => {
    expect(thunderInterval(0.55, 0.5)).toBe(Number.POSITIVE_INFINITY);
    expect(thunderInterval(THUNDER_MIN_RAIN - 0.01, 0.5)).toBe(Number.POSITIVE_INFINITY);
    expect(thunderInterval(Number.NaN, 0.5)).toBe(Number.POSITIVE_INFINITY);
    expect(thunderInterval(1, 0)).toBe(THUNDER_INTERVAL_MIN);
    expect(thunderInterval(1, 0.999999)).toBeCloseTo(THUNDER_INTERVAL_MAX, 3);
    expect(thunderInterval(0.8, 0.5)).toBeGreaterThan(thunderInterval(1, 0.5) * 1.5);
    let prev = 0;
    for (let u = 0; u < 1; u += 0.1) {
      const t = thunderInterval(1, u);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it('flash-to-bang delay follows the speed of sound', () => {
    expect(thunderDelay(3.43)).toBeCloseTo(10, 6);
    expect(thunderDelay(0)).toBe(0);
  });

  it('the scheduler fires every ~20-60 s in a storm, never in lighter rain, and is deterministic per seed', () => {
    const run = (seed: number, rain: number, seconds: number): { t: number; ev: ThunderEvent }[] => {
      const s = new ThunderScheduler(seed);
      const out: { t: number; ev: ThunderEvent }[] = [];
      const dt = 1 / 60;
      for (let i = 0; i < seconds * 60; i++) {
        const ev = s.tick(dt, rain);
        if (ev) out.push({ t: i * dt, ev });
      }
      return out;
    };
    const storm = run(7, 1, 3600);
    expect(storm.length).toBeGreaterThan(60);
    expect(storm.length).toBeLessThan(150);
    expect(storm[0].t).toBeLessThan(45); // the first clap comes early
    for (let i = 1; i < storm.length; i++) {
      const gap = storm[i].t - storm[i - 1].t;
      expect(gap).toBeGreaterThanOrEqual(THUNDER_INTERVAL_MIN - 0.05);
      expect(gap).toBeLessThanOrEqual(THUNDER_INTERVAL_MAX + 0.05);
    }
    for (const { ev } of storm) {
      expect(ev.distanceKm).toBeGreaterThanOrEqual(2.5);
      expect(ev.distanceKm).toBeLessThanOrEqual(10);
      expect(ev.level).toBeGreaterThanOrEqual(0.55);
      expect(ev.level).toBeLessThanOrEqual(1);
      expect(Math.abs(ev.pan)).toBeLessThanOrEqual(0.8);
      expect(Number.isInteger(ev.seed) && ev.seed > 0).toBe(true);
    }
    expect(new Set(storm.map((e) => e.ev.seed)).size).toBe(storm.length);
    expect(run(7, 1, 600)).toEqual(storm.filter((e) => e.t < 600));
    expect(run(8, 1, 600)).not.toEqual(run(7, 1, 600));
    expect(run(7, 0.55, 3600)).toEqual([]); // the "rain" preset never thunders
    expect(run(7, 0, 3600)).toEqual([]);
  });

  it('a dry spell re-arms the clock; a paused game (no ticks) does not consume it', () => {
    const s = new ThunderScheduler(3);
    s.tick(1 / 60, 1);
    expect(Number.isNaN(s.timer)).toBe(false);
    s.tick(1 / 60, 0);
    expect(Number.isNaN(s.timer)).toBe(true);
    s.tick(1 / 60, 1);
    const t0 = s.timer;
    s.tick(0, 1); // dt = 0: nothing moves
    s.tick(Number.NaN, 1);
    expect(s.timer).toBe(t0);
  });

  const plans = [
    [2.5, 11],
    [4, 22],
    [6, 33],
    [9, 44],
    [10, 55],
    [14, 66],
    [1, 77],
  ] as const;

  it('a clap is a normalised rolling envelope: starts at zero, builds, peaks at 1, dies away', () => {
    const p = makeThunderPlan();
    for (const [d, seed] of plans) {
      planThunder(p, { distanceKm: d, level: 1, pan: 0, seed });
      expect(p.n).toBeGreaterThanOrEqual(4);
      expect(p.n).toBeLessThanOrEqual(THUNDER_MAX_LOBES);
      expect(p.dur).toBeGreaterThan(3);
      expect(p.dur).toBeLessThanOrEqual(12.5);
      expect(thunderEnvelope(p, 0)).toBe(0);
      expect(thunderEnvelope(p, -1)).toBe(0);
      let pk = 0;
      let tpk = 0;
      for (let t = 0; t <= p.dur; t += 0.01) {
        const e = thunderEnvelope(p, t);
        expect(e).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(e)).toBe(true);
        if (e > pk) {
          pk = e;
          tpk = t;
        }
      }
      expect(pk).toBeGreaterThan(0.97);
      expect(pk).toBeLessThan(1.03);
      expect(tpk).toBeGreaterThan(0.1); // not a step
      expect(thunderEnvelope(p, p.dur)).toBeLessThan(0.02); // ~-34 dB at the end: a natural tail
      expect(thunderEnvelope(p, p.dur * 0.5)).toBeGreaterThan(thunderEnvelope(p, p.dur));
    }
  });

  it('distance shapes the clap: farther is slower to build, longer and darker', () => {
    const peakTime = (d: number, seeds: number): { rise: number; dur: number; fc: number } => {
      const p = makeThunderPlan();
      let rise = 0;
      let dur = 0;
      let fc = 0;
      for (let s = 1; s <= seeds; s++) {
        planThunder(p, { distanceKm: d, level: 1, pan: 0, seed: s * 7919 });
        let pk = 0;
        let tpk = 0;
        for (let t = 0; t < 8; t += 0.02) {
          const e = thunderEnvelope(p, t);
          if (e > pk) {
            pk = e;
            tpk = t;
          }
        }
        rise += tpk / seeds;
        dur += p.dur / seeds;
        fc += p.fc0 / seeds;
      }
      return { rise, dur, fc };
    };
    const near = peakTime(2, 40);
    const far = peakTime(10, 40);
    expect(far.dur).toBeGreaterThan(near.dur + 2);
    expect(far.fc).toBeLessThan(near.fc * 0.7);
    expect(far.rise).toBeGreaterThanOrEqual(near.rise * 0.8); // the first lobe's attack grows with distance
  });

  it('planning is deterministic, seed-dependent and allocation-free (the plan owns its arrays)', () => {
    const a = makeThunderPlan();
    const b = makeThunderPlan();
    planThunder(a, { distanceKm: 5, level: 0.8, pan: 0.3, seed: 123 });
    planThunder(b, { distanceKm: 5, level: 0.8, pan: 0.3, seed: 123 });
    expect(Array.from(a.t)).toEqual(Array.from(b.t));
    expect(a.dur).toBe(b.dur);
    const t0 = a.t;
    planThunder(a, { distanceKm: 5, level: 0.8, pan: 0.3, seed: 124 });
    expect(a.t).toBe(t0); // same buffer reused
    expect(Array.from(a.t)).not.toEqual(Array.from(b.t));
    planThunder(a, { distanceKm: Number.NaN, level: 9, pan: -9, seed: Number.NaN });
    expect(a.level).toBe(1);
    expect(a.pan).toBe(-1);
    expect(Number.isFinite(a.dur)).toBe(true);
  });
});

// ── rain DSP ─────────────────────────────────────────────────────────────────

describe('drop waveform bank', () => {
  it('every drop is finite, unit energy, fades to zero and fits the event ring', () => {
    const b = buildProtoBank(SR);
    expect(hasNonFinite(b.data)).toBe(false);
    for (let k = 0; k < b.off.length; k++) {
      let e = 0;
      for (let i = 0; i < b.len[k]; i++) e += b.data[b.off[k] + i] ** 2;
      expect(e).toBeGreaterThan(0.98);
      expect(e).toBeLessThan(1.02);
      expect(b.len[k]).toBeLessThanOrEqual(3000);
      expect(Math.abs(b.data[b.off[k] + b.len[k] - 1])).toBeLessThan(0.05 * Math.max(...Array.from(b.data.subarray(b.off[k], b.off[k] + b.len[k])).map(Math.abs)));
    }
  });
});

describe('WeatherVoice: the rain bed', () => {
  it('is silent (exact zeros) and asleep while it is dry', () => {
    const { l, r, v } = renderRain(1, () => undefined);
    expect(peakAbs(l) + peakAbs(r)).toBe(0);
    expect(v.awake).toBe(false);
  });

  it('level follows the rain, sits in the calibrated windows, never clips', () => {
    const lv = (rain: number): number => {
      const { l, r } = renderRain(8, (v) => (v.inp.rain = rain));
      expect(hasNonFinite(l) || hasNonFinite(r)).toBe(false);
      expect(db(Math.max(peakAbs(l), peakAbs(r)))).toBeLessThan(-6);
      return db(Math.max(rms(l, 4 * SR, l.length), rms(r, 4 * SR, r.length)));
    };
    const a = lv(0.2);
    const b = lv(0.55);
    const c = lv(1);
    expect(b).toBeGreaterThan(a + 4);
    expect(c).toBeGreaterThan(b + 4);
    expect(b).toBeGreaterThan(-38);
    expect(b).toBeLessThan(-31);
    expect(c).toBeGreaterThan(-31.5);
    expect(c).toBeLessThan(-25);
    expect(a).toBeGreaterThan(-47);
  });

  it('broadband rain: centroid 2-5 kHz, no rumble, wide stereo', () => {
    const { l, r } = renderRain(8, (v) => (v.inp.rain = 0.55));
    const m = mono(l, r);
    const c = spectralCentroid(welch(m, 8192, 4 * SR, m.length), SR, 40, 12000);
    expect(c).toBeGreaterThan(2000);
    expect(c).toBeLessThan(5000);
    expect(share(m, 20, 150, 4 * SR, m.length)).toBeLessThan(0.01);
    expect(share(m, 1500, 8000, 4 * SR, m.length)).toBeGreaterThan(0.5);
    expect(Math.abs(corr(l, r, 4 * SR))).toBeLessThan(0.3);
  });

  it('light rain is patter, a downpour is a dense roar (envelope variation falls with the rain)', () => {
    const cv = (rain: number): number => {
      const { l, r } = renderRain(8, (v) => (v.inp.rain = rain));
      return envCv(mono(l, r), 4 * SR);
    };
    const light = cv(0.15);
    const mid = cv(0.55);
    const heavy = cv(1);
    expect(light).toBeGreaterThan(0.5);
    expect(light).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(heavy);
    expect(heavy).toBeLessThan(0.3);
  });

  it('the level wanders a little (gusts) but never jumps', () => {
    const { l, r } = renderRain(14, (v) => (v.inp.rain = 1));
    const m = mono(l, r);
    const lv: number[] = [];
    for (let t = 3; t + 1 <= 14; t++) lv.push(db(rms(m, Math.floor(t * SR), Math.floor((t + 1) * SR))));
    const spread = Math.max(...lv) - Math.min(...lv);
    expect(spread).toBeGreaterThan(0.2);
    expect(spread).toBeLessThan(6);
    expect(clickScore(m.subarray(4 * SR, 8 * SR), 96).score).toBeLessThan(40);
  });

  it('fades in over a few seconds, fades out, and goes fully silent afterwards', () => {
    const { l, r, v } = renderRain(16, (vv, t) => (vv.inp.rain = t < 1 ? 0 : t < 9 ? 1 : 0));
    const m = mono(l, r);
    const w = (a: number, b: number): number => db(rms(m, Math.floor(a * SR), Math.floor(b * SR)));
    expect(w(0, 0.9)).toBeLessThan(-120);
    const rise = [1, 1.7, 2.4, 3.1].map((t) => w(t, t + 0.5));
    const steady = w(6, 8.5);
    const fall = [9, 9.7, 10.4, 11.1].map((t) => w(t, t + 0.5));
    for (let i = 1; i < 4; i++) {
      expect(rise[i]).toBeGreaterThan(rise[i - 1] - 0.5);
      expect(fall[i]).toBeLessThan(fall[i - 1] + 0.5);
    }
    expect(rise[0]).toBeLessThan(steady - 8);
    expect(fall[3]).toBeLessThan(steady - 12);
    expect(w(14, 16)).toBeLessThan(-120);
    expect(v.awake).toBe(false);
  });

  it('pause (gain 0) silences it within a fraction of a second and it resumes cleanly', () => {
    const { l, r } = renderRain(8, (v, t) => {
      v.inp.rain = 0.8;
      v.inp.gain = t > 3 && t < 6 ? 0 : 1;
    });
    const m = mono(l, r);
    expect(db(rms(m, Math.floor(4.2 * SR), Math.floor(5.9 * SR)))).toBeLessThan(-100);
    expect(db(rms(m, Math.floor(7 * SR), Math.floor(8 * SR)))).toBeGreaterThan(-45);
    expect(hasNonFinite(m)).toBe(false);
  });
});

describe('WeatherVoice: in the cabin', () => {
  const cabin = (rain: number, speed = 40): { l: Float32Array; r: Float32Array } => renderRain(8, (v) => Object.assign(v.inp, { rain, interior: 1, speed }));
  const open = (rain: number): { l: Float32Array; r: Float32Array } => renderRain(8, (v) => (v.inp.rain = rain));

  it('is muffled (darker) and carries the drumming on the roof', () => {
    const o = mono(open(0.55).l, open(0.55).r);
    const cc = cabin(0.55);
    const c = mono(cc.l, cc.r);
    const cen = (x: Float32Array): number => spectralCentroid(welch(x, 8192, 4 * SR, x.length), SR, 40, 12000);
    expect(cen(c)).toBeLessThan(cen(o) * 0.6);
    expect(share(c, 8000, 16000, 4 * SR, c.length)).toBeLessThan(share(o, 8000, 16000, 4 * SR, o.length) * 0.2);
    expect(share(c, 150, 1000, 4 * SR, c.length)).toBeGreaterThan(share(o, 150, 1000, 4 * SR, o.length) * 2);
  });

  it('is a little quieter than outside but still clearly there (storm)', () => {
    const ext = renderRain(8, (v) => (v.inp.rain = 1));
    const inn = cabin(1);
    const d = db(rms(inn.l, 4 * SR, inn.l.length)) - db(rms(ext.l, 4 * SR, ext.l.length));
    expect(d).toBeGreaterThan(-5);
    expect(d).toBeLessThan(1);
  });

  it('windscreen ticks (2-5 kHz) get busier with the car speed', () => {
    const band = (speed: number): number => {
      const c = cabin(0.55, speed);
      const m = mono(c.l, c.r);
      return 10 * Math.log10(bandPower(welch(m, 8192, 4 * SR, m.length), SR, 2000, 5000));
    };
    expect(band(60)).toBeGreaterThan(band(5) + 1.5);
  });

  it('switching view cross-fades without a click or a level jump', () => {
    const { l, r } = renderRain(8, (v, t) => Object.assign(v.inp, { rain: 0.55, interior: t < 4 ? 0 : 1, speed: 30 }));
    const m = mono(l, r);
    expect(clickScore(m.subarray(Math.floor(3.5 * SR), Math.floor(5 * SR)), 96).score).toBeLessThan(40);
    const w = (a: number, b: number): number => db(rms(m, Math.floor(a * SR), Math.floor(b * SR)));
    expect(Math.abs(w(3, 3.9) - w(5.5, 6.4))).toBeLessThan(4);
    for (let t = 3.5; t < 5.5; t += 0.1) expect(Math.abs(w(t + 0.1, t + 0.2) - w(t, t + 0.1))).toBeLessThan(4);
  });
});

describe('WeatherVoice: thunder', () => {
  const clap = (ev: ThunderEvent, seconds = 14, rain = 1): { d: Float32Array; l: Float32Array; base: Float32Array } => {
    const make = (withClap: boolean): Float32Array => {
      const v = new WeatherVoice(SR, 3);
      v.inp.rain = rain;
      const n = seconds * SR;
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      for (let o = 0; o < n; o += 128) {
        if (withClap && o === 3 * SR - ((3 * SR) % 128)) v.triggerThunder(ev);
        v.process(l, r, Math.min(128, n - o), o);
      }
      return l;
    };
    const l = make(true);
    const base = make(false);
    const d = new Float32Array(l.length);
    for (let i = 0; i < d.length; i++) d[i] = l[i] - base[i];
    return { d, l, base };
  };
  const peak100 = (d: Float32Array, from: number): number => {
    let p = -999;
    for (let k = 0; k < 100; k++) p = Math.max(p, db(rms(d, Math.floor((from + k * 0.1) * SR), Math.floor((from + k * 0.1 + 0.1) * SR))));
    return p;
  };

  it('a clap is low rolling rumble: >= 85 % of its energy below 300 Hz, audible but never jarring', () => {
    const { d, base } = clap({ distanceKm: 5, level: 1, pan: 0, seed: 9 });
    expect(hasNonFinite(d)).toBe(false);
    const psd = welch(d, 16384, Math.floor(3.3 * SR), Math.floor(10 * SR));
    expect(bandPower(psd, SR, 20, 300) / bandPower(psd, SR, 20, 20000)).toBeGreaterThan(0.85);
    const pk = peak100(d, 3);
    expect(pk).toBeGreaterThan(-24);
    expect(pk).toBeLessThan(-14);
    expect(pk - db(rms(base, 8 * SR, 12 * SR))).toBeLessThan(12.5); // within ~12 dB of the storm it rolls over
  });

  it('it builds before it peaks, then decays naturally (40 dB down within 4-12 s of the onset)', () => {
    const { d } = clap({ distanceKm: 6, level: 1, pan: 0, seed: 21 }, 18);
    const env: number[] = [];
    for (let k = 0; k < 140; k++) env.push(db(rms(d, Math.floor((3 + k * 0.1) * SR), Math.floor((3.1 + k * 0.1) * SR))));
    const pk = Math.max(...env);
    const kPk = env.indexOf(pk);
    expect(kPk).toBeGreaterThanOrEqual(2);
    let last = 0;
    env.forEach((v, k) => {
      if (v > pk - 40) last = k;
    });
    expect(last * 0.1).toBeGreaterThan(4);
    expect(last * 0.1).toBeLessThan(12);
    expect(env[0]).toBeLessThan(pk - 8); // starts from near silence
  });

  it('the level parameter scales the clap (0.5 is about -6 dB) and the pan places it', () => {
    const full = clap({ distanceKm: 5, level: 1, pan: 0, seed: 9 }).d;
    const half = clap({ distanceKm: 5, level: 0.5, pan: 0, seed: 9 }).d;
    expect(peak100(half, 3) - peak100(full, 3)).toBeCloseTo(-6.02, 0);
    expect(Math.abs(peak100(half, 3) - peak100(full, 3) + 6.02)).toBeLessThan(0.5);
  });

  it('overlapping claps and a clap on a sleeping (dry) voice are safe', () => {
    const v = new WeatherVoice(SR, 5);
    v.inp.rain = 1;
    const l = new Float32Array(20 * SR);
    const r = new Float32Array(20 * SR);
    for (let o = 0; o < l.length; o += 128) {
      if (o === 128 * 100) v.triggerThunder({ distanceKm: 3, level: 1, pan: -1, seed: 1 });
      if (o === 128 * 200) v.triggerThunder({ distanceKm: 8, level: 1, pan: 1, seed: 2 });
      if (o === 128 * 300) v.triggerThunder({ distanceKm: 5, level: 1, pan: 0, seed: 3 }); // steals the oldest voice
      v.process(l, r, 128, o);
    }
    expect(hasNonFinite(l) || hasNonFinite(r)).toBe(false);
    expect(Math.max(peakAbs(l), peakAbs(r))).toBeLessThan(0.7);
    const dry = new WeatherVoice(SR, 5);
    dry.triggerThunder({ distanceKm: 3, level: 1, pan: 0, seed: 1 });
    const a = new Float32Array(2 * SR);
    const b = new Float32Array(2 * SR);
    dry.process(a, b, a.length);
    expect(peakAbs(a) + peakAbs(b)).toBe(0); // rain target 0: nothing to hear, nothing computed
  });

  it('a cabin clap is a touch softer and darker', () => {
    const f = (interior: number): number => {
      const v = new WeatherVoice(SR, 3);
      Object.assign(v.inp, { rain: 1, interior });
      v.trim.hi = v.trim.lo = v.trim.wind = v.trim.cabin = 0;
      v.trim.stream.fill(0);
      const n = 12 * SR;
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      for (let o = 0; o < n; o += 128) {
        if (o === 128 * 50) v.triggerThunder({ distanceKm: 4, level: 1, pan: 0, seed: 4 });
        v.process(l, r, Math.min(128, n - o), o);
      }
      return share(l, 150, 500, Math.floor(2 * SR), Math.floor(8 * SR), 16384);
    };
    expect(f(1)).toBeLessThan(f(0));
  });
});

describe('WeatherVoice: robustness and cost', () => {
  it('fuzz: random inputs, claps and pauses never produce NaN or runaway levels', () => {
    const v = new WeatherVoice(SR, 9);
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    let s = 987654;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) | 0;
      return (s >>> 0) / 4294967296;
    };
    let worst = 0;
    for (let b = 0; b < 8000; b++) {
      if (b % 40 === 0) {
        v.inp.rain = rnd() > 0.2 ? rnd() : 0;
        v.inp.interior = rnd() > 0.5 ? 1 : rnd();
        v.inp.speed = rnd() * 120;
        v.inp.gain = rnd() > 0.2 ? 1 : 0;
      }
      if (b % 700 === 0) v.triggerThunder({ distanceKm: 1 + rnd() * 12, level: rnd(), pan: rnd() * 2 - 1, seed: Math.floor(rnd() * 1e6) });
      v.process(l, r, 128);
      expect(hasNonFinite(l) || hasNonFinite(r)).toBe(false);
      worst = Math.max(worst, peakAbs(l), peakAbs(r));
    }
    expect(worst).toBeLessThan(0.8);
  });

  it('odd block sizes and offsets render the same as the standard 128 quantum (deterministic, no seams)', () => {
    const a = new WeatherVoice(SR, 4);
    const b = new WeatherVoice(SR, 4);
    a.inp.rain = b.inp.rain = 0.7;
    const n = 4000;
    const al = new Float32Array(n);
    const ar = new Float32Array(n);
    const bl = new Float32Array(n);
    const br = new Float32Array(n);
    a.process(al, ar, n);
    for (let o = 0; o < n; o += 128) b.process(bl, br, Math.min(128, n - o), o);
    for (let i = 0; i < n; i++) {
      expect(al[i]).toBe(bl[i]);
      expect(ar[i]).toBe(br[i]);
    }
  });

  // a CPU benchmark: retried, since one run can stall on a busy machine (parallel test workers, a game running)
  it('is cheap: a storm voice costs a small fraction of the 2.67 ms render quantum', { retry: 3 }, () => {
    const time = (rain: number, interior: number): number => {
      const v = new WeatherVoice(SR, 5);
      Object.assign(v.inp, { rain, interior, speed: 40 });
      const l = new Float32Array(128);
      const r = new Float32Array(128);
      for (let i = 0; i < 2500; i++) v.process(l, r, 128);
      let best = Infinity;
      for (let rep = 0; rep < 4; rep++) {
        const t0 = performance.now();
        for (let i = 0; i < 2000; i++) v.process(l, r, 128);
        best = Math.min(best, ((performance.now() - t0) / 2000) * 1000);
      }
      return best;
    };
    const budget = (128 / SR) * 1e6;
    expect(time(0.55, 0)).toBeLessThan(budget * 0.05);
    expect(time(1, 1)).toBeLessThan(budget * 0.05);
    expect(time(0, 0)).toBeLessThan(budget * 0.002); // dry: zero fill only
  });
});

// ── wet chassis ──────────────────────────────────────────────────────────────

type Setup = (v: ChassisVoice, t: number) => void;

function runChassis(seconds: number, seed: number, stereo: boolean, setup: Setup): { l: Float32Array; r: Float32Array } {
  const v = new ChassisVoice(SR, seed);
  const n = Math.floor(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const blocks = Math.ceil(n / 128);
  for (let b = 0; b < blocks; b++) {
    const o = b * 128;
    if (b % 6 === 0) setup(v, o / SR);
    v.process(l.subarray(o), stereo ? r.subarray(o) : null, Math.min(128, n - o));
  }
  return { l, r };
}

/** Energy in 8 equal segments (a fingerprint of the waveform's loudness over time). */
function seg(x: Float32Array, k: number): number[] {
  const out: number[] = [];
  const w = Math.floor(x.length / k);
  for (let i = 0; i < k; i++) {
    let s = 0;
    for (let j = i * w; j < (i + 1) * w; j++) s += x[j] * x[j];
    out.push(s);
  }
  return out;
}

describe('dry stays exactly dry (wetness 0)', () => {
  // Energy fingerprints recorded from the chassis voice BEFORE any wet-weather code existed. The new code path must reproduce
  // them to ~1e-9 relative: no random draw, no filter, no gain may differ when it is dry.
  const GOLDEN: Record<string, { l: number[]; r: number[] }> = {
    roadHard: {
      l: [16.2983421771, 15.8706085086, 15.1881290757, 16.0234487569, 15.0240782665, 17.017040528, 17.0119565757, 16.5013168001],
      r: [15.2529929406, 15.3139288966, 15.3846335141, 16.2757919917, 15.0285948655, 15.5236187896, 15.5633525182, 15.6548750037],
    },
    mixed: {
      l: [254.655028369, 237.223482451, 291.818828496, 459.158598882, 2144.38599047, 2208.1375535, 622.431791691, 507.466287295],
      r: [302.020429461, 177.100938619, 207.705173911, 260.090989242, 522.386627284, 1839.05082033, 3974.18810726, 745.036470039],
    },
    liteMono: { l: [143.972871471, 139.33866431, 142.724826716, 141.394541352, 142.045166584, 142.097275345, 140.745646472, 143.229959663], r: [] },
    offroad: {
      l: [11.7252027561, 51.5192405574, 35.0251647612, 266.848796166, 179.63110364, 30.4662200796, 15.2820316566, 13.6345129726],
      r: [17.6447845504, 123.000927005, 77.3739769368, 94.4278800915, 77.6880182928, 26.8492691048, 21.9527471775, 19.612965198],
    },
  };
  const scenes: Record<string, { sec: number; seed: number; stereo: boolean; setup: Setup }> = {
    roadHard: {
      sec: 1.6,
      seed: 5,
      stereo: true,
      setup: (v) => {
        v.inp.speed = 40;
        v.inp.surf.set([1, 0, 0, 0, 0, 0]);
      },
    },
    mixed: {
      sec: 2.0,
      seed: 7,
      stereo: true,
      setup: (v, t) => {
        v.inp.speed = 30 + 20 * t;
        v.inp.surf.set([0.5, 0.25, 0.25, 0, 0, 0]);
        v.inp.curb.set([1, 0, 0, 1]);
        v.inp.interior = t > 1 ? 1 : 0;
        v.inp.tire.set([0.4, 0.8, 0.5, 1000, 0.3, 0.6, 0.2, 960, 0.1, 0.1, 0.0, 900, 0, 0, 0, 880]);
      },
    },
    liteMono: {
      sec: 1.6,
      seed: 9,
      stereo: false,
      setup: (v) => {
        v.inp.quality = 1;
        v.inp.speed = 60;
        v.inp.surf.set([0.75, 0.25, 0, 0, 0, 0]);
        v.inp.tire.set([0.4, 0.8, 0.5, 1000, 0, 0, 0, 1000, 0.2, 0.3, 0.1, 900, 0, 0, 0, 900]);
      },
    },
    offroad: {
      sec: 2.2,
      seed: 11,
      stereo: true,
      setup: (v, t) => {
        v.inp.speed = 35;
        v.inp.surf.set([0, 0, 0.3, 0.3, 0.2, 0.2]);
        v.inp.scrape = t > 0.8 && t < 1.4 ? 0.8 : 0;
        if (t > 0.5 && v.inp.thumpCount === 0) {
          v.inp.thumpCount = 1;
          v.inp.thumpStrength = 0.7;
          v.inp.thumpPan = 0.3;
        }
        if (t > 1.0 && v.inp.impactCount === 0) {
          v.inp.impactCount = 1;
          v.inp.impactKind = 0;
          v.inp.impactStrength = 18;
          v.inp.impactPan = -0.4;
        }
      },
    },
  };

  for (const [name, sc] of Object.entries(scenes)) {
    it(`${name}: matches the pre-weather chassis voice (energy per segment, 1e-9 relative)`, () => {
      const { l, r } = runChassis(sc.sec, sc.seed, sc.stereo, sc.setup);
      const g = GOLDEN[name];
      const sl = seg(l, 8);
      for (let i = 0; i < 8; i++) expect(Math.abs(sl[i] - g.l[i]) / g.l[i]).toBeLessThan(1e-9);
      if (sc.stereo) {
        const sr = seg(r, 8);
        for (let i = 0; i < 8; i++) expect(Math.abs(sr[i] - g.r[i]) / g.r[i]).toBeLessThan(1e-9);
      }
    });
  }

  it('a wet spell that ends leaves the dry sound behind (fully wet, then wetness back to 0: spectrum back to the dry one)', () => {
    const level = (wetAfter: boolean): number => {
      const { l } = runChassis(6, 5, true, (v, t) => {
        v.inp.speed = 40;
        v.inp.surf.set([1, 0, 0, 0, 0, 0]);
        v.inp.wet = wetAfter && t < 2 ? 1 : 0;
      });
      return share(l, 2000, 8000, 4 * SR, l.length) * 1e3;
    };
    expect(level(true)).toBeLessThan(level(false) * 1.25 + 0.05);
  });
});

describe('wet chassis: hiss, spray, squeal, slush', () => {
  const road = (speed: number, wet: number, interior = 0): ((v: ChassisVoice) => void) => (v) => {
    v.inp.speed = speed;
    v.inp.interior = interior;
    v.inp.surf.set([1, 0, 0, 0, 0, 0]);
    v.inp.wet = wet;
  };
  const hissDb = (x: Float32Array): number => 10 * Math.log10(bandPower(welch(x, 8192, SR, x.length), SR, 1500, 8000));

  it('a hiss rises out of the road noise and grows with speed and wetness', () => {
    const lv = (speed: number, wet: number, interior = 0): number => hissDb(runChassis(3, 3, true, road(speed, wet, interior)).l);
    expect(lv(20, 0.75) - lv(20, 0)).toBeGreaterThan(12);
    expect(lv(40, 0.75) - lv(40, 0)).toBeGreaterThan(6.5);
    expect(lv(40, 0.75) - lv(20, 0.75)).toBeGreaterThan(6);
    expect(lv(60, 0.75) - lv(40, 0.75)).toBeGreaterThan(3);
    expect(lv(40, 1)).toBeGreaterThan(lv(40, 0.5) + 1);
    // in the cabin it is softer than outside but still well above the dry cabin
    expect(lv(40, 0.75, 1)).toBeLessThan(lv(40, 0.75, 0) - 1);
    expect(lv(40, 0.75, 1) - lv(40, 0, 1)).toBeGreaterThan(4);
  });

  it('wet noise is finite, bounded, and the lite (mono) voice makes it too', () => {
    for (const q of [1, 2]) {
      const dry = runChassis(2, 3, q === 2, (v) => {
        v.inp.quality = q;
        road(50, 0)(v);
      });
      const wet = runChassis(2, 3, q === 2, (v) => {
        v.inp.quality = q;
        road(50, 0.9)(v);
      });
      expect(hasNonFinite(wet.l) || hasNonFinite(wet.r)).toBe(false);
      expect(peakAbs(wet.l)).toBeLessThan(0.7);
      expect(rms(wet.l, SR, wet.l.length)).toBeGreaterThan(rms(dry.l, SR, dry.l.length) * 1.1);
    }
  });

  it('a sudden change of wetness (0 -> 1) fades in without a click', () => {
    const { l } = runChassis(3, 3, true, (v, t) => {
      v.inp.speed = 45;
      v.inp.surf.set([1, 0, 0, 0, 0, 0]);
      v.inp.wet = t < 1 ? 0 : 1;
    });
    expect(clickScore(l.subarray(Math.floor(0.8 * SR), Math.floor(2.2 * SR)), 96).score).toBeLessThan(40);
    const w = (a: number, b: number): number => db(rms(l, Math.floor(a * SR), Math.floor(b * SR)));
    expect(w(1.0, 1.1)).toBeLessThan(w(2.5, 3));
  });

  it('puddles add the odd splash at speed on a soaked road, and only then', () => {
    const excursion = (wet: number, speed: number): number => {
      const { l } = runChassis(30, 3, true, (v) => road(speed, wet)(v));
      // a splash is a 50-200 ms swell: look at 100 ms windows against the steady level
      const w = Math.floor(0.1 * SR);
      const e: number[] = [];
      for (let s = 2 * SR; s + w <= l.length; s += w) e.push(db(rms(l, s, s + w)));
      const med = e.slice().sort((a, b) => a - b)[e.length >> 1];
      return Math.max(...e) - med;
    };
    expect(excursion(1, 50)).toBeGreaterThan(2);
    expect(excursion(1, 50)).toBeLessThan(9); // an accent, never a bang
    expect(excursion(0.2, 50)).toBeLessThan(1.5); // not wet enough for puddles
  });

  it('surfaces: pavement carries the most water, grass a little spray, an airborne car none', () => {
    const lvl = (surf: number[]): number => {
      const { l } = runChassis(3, 3, true, (v) => {
        v.inp.speed = 40;
        v.inp.surf.set(surf);
        v.inp.wet = 1;
      });
      return hissDb(l);
    };
    const dryGrass = (): number => {
      const { l } = runChassis(3, 3, true, (v) => {
        v.inp.speed = 40;
        v.inp.surf.set([0, 0, 1, 0, 0, 0]);
        v.inp.wet = 0;
      });
      return hissDb(l);
    };
    const asphalt = lvl([1, 0, 0, 0, 0, 0]);
    const grass = lvl([0, 0, 1, 0, 0, 0]);
    expect(asphalt).toBeGreaterThan(grass + 6);
    expect(grass).toBeGreaterThan(dryGrass());
    const flying = (wet: number): number =>
      hissDb(
        runChassis(3, 3, true, (v) => {
          v.inp.speed = 40;
          v.inp.surf.fill(0);
          v.inp.airborne = 1;
          v.inp.wet = wet;
        }).l,
      );
    expect(flying(1) - flying(0)).toBeLessThan(0.3); // nothing touches the water, only the wind blows
  });

  it('fuzz: random controls with random wetness never produce NaN or runaway levels', () => {
    const v = new ChassisVoice(SR, 9);
    const a = new Float32Array(128);
    const b = new Float32Array(128);
    let s = 424242;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) | 0;
      return (s >>> 0) / 4294967296;
    };
    let worst = 0;
    for (let k = 0; k < 4000; k++) {
      if (k % 6 === 0) {
        v.inp.speed = rnd() * 120;
        v.inp.interior = rnd();
        v.inp.wet = rnd() > 0.3 ? rnd() : 0;
        for (let i = 0; i < 6; i++) v.inp.surf[i] = rnd() > 0.5 ? rnd() : 0;
        for (let i = 0; i < 16; i++) v.inp.tire[i] = i % 4 === 3 ? 600 + rnd() * 1500 : rnd() * 1.3;
        for (let i = 0; i < 4; i++) v.inp.slush[i] = rnd() > 0.6 ? rnd() * 1.4 : 0;
        v.inp.quality = rnd() > 0.7 ? 1 : 2;
        v.inp.gain = rnd() > 0.1 ? 1 : 0;
      }
      v.process(a, b, 128);
      expect(hasNonFinite(a) || hasNonFinite(b)).toBe(false);
      worst = Math.max(worst, peakAbs(a), peakAbs(b));
    }
    expect(worst).toBeLessThan(3);
  });

  // a CPU benchmark: retried, since one run can stall on a busy machine (parallel test workers, a game running)
  it('the wet path adds little CPU per voice (a few microseconds per 128-sample quantum)', { retry: 3 }, () => {
    const time = (wet: number, stereo: boolean): number => {
      const v = new ChassisVoice(SR, 3);
      v.inp.quality = stereo ? 2 : 1;
      road(50, wet)(v);
      v.inp.quality = stereo ? 2 : 1;
      const a = new Float32Array(128);
      const b = new Float32Array(128);
      for (let i = 0; i < 2500; i++) v.process(a, stereo ? b : null, 128);
      let best = Infinity;
      for (let rep = 0; rep < 4; rep++) {
        const t0 = performance.now();
        for (let i = 0; i < 2000; i++) v.process(a, stereo ? b : null, 128);
        best = Math.min(best, ((performance.now() - t0) / 2000) * 1000);
      }
      return best;
    };
    const budget = (128 / SR) * 1e6;
    // measured ~2 us (full) / ~1 us (lite); the limit leaves room for a busy machine
    expect(time(0.75, true) - time(0, true)).toBeLessThan(budget * 0.008);
    expect(time(0.75, false) - time(0, false)).toBeLessThan(budget * 0.008);
  });
});

describe('WetRoad: tables and rendering', () => {
  it('the shared noise tables are unit-RMS, finite and loop seamlessly', () => {
    const t = getWetTables(SR);
    for (const x of [t.hiss, t.spray]) {
      expect(hasNonFinite(x)).toBe(false);
      expect(rms(x)).toBeGreaterThan(0.99);
      expect(rms(x)).toBeLessThan(1.01);
      // the step across the loop point is as ordinary as any other step
      let worst = 0;
      for (let i = 1000; i < x.length - 1; i += 997) worst = Math.max(worst, Math.abs(x[i + 1] - x[i]));
      expect(Math.abs(x[0] - x[x.length - 1])).toBeLessThan(worst * 1.5 + 0.5);
    }
    expect(getWetTables(SR)).toBe(t); // built once per sample rate
    expect(strongestPeak(welch(t.hiss, 8192), SR, 1500, 8000).prominenceDb).toBeLessThan(8); // noise, not a tone
    expect(spectralCentroid(welch(t.hiss, 8192), SR, 100, 16000)).toBeGreaterThan(3000);
    expect(spectralCentroid(welch(t.spray, 8192), SR, 100, 16000)).toBeLessThan(2000);
  });

  it('honours the car output-gain ramp and adds into the buffers (mono voice: everything to the left)', () => {
    const w = new WetRoad(SR, 1);
    const lv = makeWetRoadLevels();
    wetRoad(0.8, 1, 50, 0, lv);
    const slush = new Float64Array(4);
    // let the level ramps settle
    const a = new Float32Array(128);
    const b = new Float32Array(128);
    for (let i = 0; i < 20; i++) {
      w.prepare(lv, slush, 24, 128);
      a.fill(0);
      b.fill(0);
      w.render(a, b, 0, 1, 0);
    }
    expect(w.on).toBe(true);
    expect(rms(a)).toBeGreaterThan(1e-3);
    w.prepare(lv, slush, 24, 128);
    a.fill(0);
    b.fill(0);
    w.render(a, b, 0, 0, 0); // gain 0: nothing
    expect(peakAbs(a) + peakAbs(b)).toBe(0);
    w.prepare(lv, slush, 24, 128);
    a.fill(0);
    w.render(a, null, 0, 1, 0);
    expect(rms(a)).toBeGreaterThan(1e-3);
    // preexisting content is kept (render adds)
    a.fill(0.5);
    w.prepare(lv, slush, 24, 128);
    w.render(a, null, 0, 1, 0);
    expect(Math.abs(rms(a) - 0.5)).toBeLessThan(0.1);
  });

  it('turns itself off after the water is gone', () => {
    const w = new WetRoad(SR, 2);
    const lv = makeWetRoadLevels();
    const slush = new Float64Array(4);
    const a = new Float32Array(128);
    wetRoad(0.8, 1, 50, 0, lv);
    for (let i = 0; i < 10; i++) {
      w.prepare(lv, slush, 24, 128);
      w.render(a, null, 0, 1, 0);
    }
    expect(w.on).toBe(true);
    wetRoad(0, 1, 50, 0, lv);
    for (let i = 0; i < 5; i++) {
      w.prepare(lv, slush, 24, 128);
      w.render(a, null, 0, 1, 0);
    }
    expect(w.on).toBe(false);
  });
});

// ── tire mapping with water ──────────────────────────────────────────────────

function wheel(over: Partial<WheelState> = {}): WheelState {
  const w = makeVehicleState().wheels[0];
  Object.assign(w, { contact: true, surface: 'asphalt', load: 4500, slipAngle: 0.01, slipRatio: 0, skid: 0, radius: 0.34, omega: 100 }, over);
  return w;
}

describe('tireSqueal on a wet road', () => {
  const lv = makeSquealLevels();
  const at = (over: Partial<WheelState>, wet: number, speed = 35, idx = 0): typeof lv => {
    tireSqueal(wheel(over), idx, speed, lv, wet);
    return { ...lv };
  };

  it('wet = 0 is exactly the dry mapping', () => {
    const cases: Partial<WheelState>[] = [{}, { skid: 0.5, slipAngle: 0.2 }, { skid: 1, slipAngle: 0.3, slipRatio: 0.4 }, { surface: 'curb', skid: 0.6 }, { surface: 'grass', skid: 1 }, { contact: false, skid: 1 }];
    for (const c of cases) {
      const a = at(c, 0);
      tireSqueal(wheel(c), 0, 35, lv); // omitted wet argument
      expect({ ...lv }).toEqual(a);
      expect(a.slush).toBe(0);
    }
  });

  it('water lubricates: less shriek, more hiss', () => {
    const dry = at({ skid: 0.55, slipAngle: 0.17 }, 0);
    const wet = at({ skid: 0.55, slipAngle: 0.17 }, 0.75);
    expect(wet.tone).toBeLessThan(dry.tone * 0.6);
    expect(wet.scrub).toBeGreaterThan(dry.scrub);
    const dryH = at({ skid: 1, slipAngle: 0.3 }, 0);
    const wetH = at({ skid: 1, slipAngle: 0.3 }, 0.75);
    expect(wetH.howl).toBeLessThan(dryH.howl * 0.75);
    expect(at({ skid: 0.55, slipAngle: 0.17 }, 1).tone).toBeLessThan(wet.tone);
  });

  it('wheelspin and lock-up (longitudinal slip) lose the screech almost completely and turn into slush', () => {
    const lat = at({ skid: 0.5, slipAngle: 0.2, slipRatio: 0 }, 0.75);
    const lon = at({ skid: 0.5, slipAngle: 0.01, slipRatio: 0.5 }, 0.75);
    const dryLon = at({ skid: 0.5, slipAngle: 0.01, slipRatio: 0.5 }, 0);
    expect(lon.tone).toBeLessThan(dryLon.tone * 0.35);
    expect(lon.tone).toBeLessThan(lat.tone);
    expect(lon.slush).toBeGreaterThan(lat.slush);
    expect(lon.slush).toBeGreaterThan(0.4);
    expect(lon.slush).toBeLessThanOrEqual(1.2);
  });

  it('a standing start with the wheels spinning is slushy even though the car has hardly moved', () => {
    const w = wheel({ slipRatio: 0.6, skid: 0.9, omega: 60 }); // 20 m/s of wheel surface speed, car at 1 m/s
    tireSqueal(w, 2, 1, lv, 0.75);
    expect(lv.slush).toBeGreaterThan(0.4);
    // while it rolls grippy at walking pace there is no slush
    tireSqueal(wheel({ omega: 3 }), 2, 1, lv, 0.75);
    expect(lv.slush).toBe(0);
  });

  it('only wet-able surfaces slosh; gripping tires and tires in the air do not', () => {
    expect(wetFilm('asphalt')).toBe(1);
    expect(wetFilm('grass')).toBe(0);
    expect(wetFilm('gravel')).toBe(0);
    expect(at({ surface: 'grass', slipRatio: 0.6, skid: 1 }, 1).slush).toBe(0);
    expect(at({ slipRatio: 0.01, slipAngle: 0.02 }, 1).slush).toBe(0);
    expect(slushLevel(wheel({ contact: false, slipRatio: 0.6 }), 30, 1)).toBe(0);
    expect(slushLevel(wheel({ slipRatio: 0.6 }), 30, 0)).toBe(0);
  });

  it('wetter means more slush, and the number stays bounded', () => {
    const a = at({ slipRatio: 0.6, skid: 1 }, 0.3).slush;
    const b = at({ slipRatio: 0.6, skid: 1 }, 1).slush;
    expect(b).toBeGreaterThan(a);
    expect(at({ slipRatio: 5, slipAngle: 1, skid: 1, load: 90000 }, 1).slush).toBeLessThanOrEqual(1.2);
  });
});

describe('ChassisMapper / CarFrame with water', () => {
  it('writes the wetness and the per-wheel slush into the vector; dry writes zeros', () => {
    const m = new ChassisMapper();
    const st = makeVehicleState();
    st.speed = 20;
    for (const [i, w] of st.wheels.entries()) {
      w.slipRatio = i >= 2 ? 0.55 : 0;
      w.skid = i >= 2 ? 0.9 : 0;
      w.omega = i >= 2 ? 150 : 60;
    }
    const v = makeControlVector();
    m.update(st, 1 / 60, v, 0.8);
    expect(v[CTL.WET]).toBeCloseTo(0.8, 6);
    expect(v[CTL.SLUSH0 + 2]).toBeGreaterThan(0.3);
    expect(v[CTL.SLUSH0 + 3]).toBeGreaterThan(0.3);
    expect(v[CTL.SLUSH0]).toBe(0);
    m.update(st, 1 / 60, v, 0);
    expect(v[CTL.WET]).toBe(0);
    expect([0, 1, 2, 3].map((i) => v[CTL.SLUSH0 + i])).toEqual([0, 0, 0, 0]);
  });

  it('CarFrame.compute passes the wetness through (and defaults to dry)', () => {
    const f = new CarFrame(true);
    const st = makeVehicleState();
    st.speed = 30;
    const L = makeListener();
    f.compute(st, 1 / 60, L, 0, 2, false);
    expect(f.vec[CTL.WET]).toBe(0);
    f.compute(st, 1 / 60, L, 0, 2, false, 0.6);
    expect(f.vec[CTL.WET]).toBeCloseTo(0.6, 6);
  });
});

// ── WeatherSystem lifecycle (mock node, no Web Audio) ────────────────────────

class MockNode implements WeatherNodeLike {
  posts: Float32Array[] = [];
  thunders: ThunderEvent[] = [];
  disposed = 0;
  post(v: Float32Array): void {
    this.posts.push(Float32Array.from(v));
  }
  thunder(ev: ThunderEvent): void {
    this.thunders.push(ev);
  }
  dispose(): void {
    this.disposed++;
  }
}

function makeSystem(ready = true): { sys: WeatherSystem; nodes: MockNode[]; setReady: (r: boolean) => void; made: () => number } {
  const nodes: MockNode[] = [];
  let isReady = ready;
  const sys = new WeatherSystem(
    {
      ready: () => isReady,
      makeNode: () => {
        const n = new MockNode();
        nodes.push(n);
        return n;
      },
    },
    5,
  );
  return { sys, nodes, setReady: (r) => (isReady = r), made: () => nodes.length };
}

describe('WeatherSystem: node lifecycle, controls, thunder', () => {
  const run = (sys: WeatherSystem, seconds: number, interior = 0, speed = 30, muted = false, dt = 1 / 60): void => {
    for (let i = 0; i < Math.round(seconds / dt); i++) sys.update(dt, interior, speed, muted);
  };

  it('dry: no node is ever created and nothing is posted', () => {
    const { sys, nodes } = makeSystem();
    sys.set(0);
    run(sys, 30);
    expect(nodes.length).toBe(0);
    expect(sys.active).toBe(false);
  });

  it('creates the node only while it rains, waits for the worklet to load, and ignores nonsense', () => {
    const { sys, nodes, setReady } = makeSystem(false);
    sys.set(Number.NaN);
    run(sys, 1);
    expect(nodes.length).toBe(0);
    sys.set(0.55);
    run(sys, 1);
    expect(nodes.length).toBe(0); // worklet not ready yet
    setReady(true);
    run(sys, 0.1);
    expect(nodes.length).toBe(1);
    expect(sys.active).toBe(true);
    run(sys, 1);
    expect(nodes.length).toBe(1); // reused
  });

  it('posts rain / cabin / speed / gain every frame and goes quiet while muted', () => {
    const { sys, nodes } = makeSystem();
    sys.set(0.55);
    run(sys, 0.5, 0, 25);
    const n = nodes[0];
    const last = n.posts[n.posts.length - 1];
    expect(last[WCTL.RAIN]).toBeCloseTo(0.55, 6);
    expect(last[WCTL.INTERIOR]).toBe(0);
    expect(last[WCTL.SPEED]).toBeCloseTo(25, 6);
    expect(last[WCTL.GAIN]).toBe(1);
    run(sys, 0.2, 1, 60);
    expect(n.posts[n.posts.length - 1][WCTL.INTERIOR]).toBe(1);
    expect(n.posts[n.posts.length - 1][WCTL.SPEED]).toBeCloseTo(60, 6);
    run(sys, 0.1, 1, 60, true);
    const count = n.posts.length;
    expect(n.posts[count - 1][WCTL.GAIN]).toBe(0);
    run(sys, 1, 1, 60, true); // still muted: no more traffic
    expect(n.posts.length).toBe(count);
    run(sys, 0.1);
    expect(n.posts[n.posts.length - 1][WCTL.GAIN]).toBe(1);
    sys.sleep();
    expect(n.posts[n.posts.length - 1][WCTL.GAIN]).toBe(0);
    const c2 = n.posts.length;
    sys.sleep(); // already asleep
    expect(n.posts.length).toBe(c2);
  });

  it('keeps the node for the fade-out, then disposes it exactly once; a new rain reuses a fading node', () => {
    const { sys, nodes } = makeSystem();
    sys.set(1);
    run(sys, 1);
    sys.set(0);
    run(sys, WEATHER_FADE_OUT_S - 0.5);
    expect(sys.active).toBe(true);
    expect(nodes[0].disposed).toBe(0);
    run(sys, 1);
    expect(sys.active).toBe(false);
    expect(nodes[0].disposed).toBe(1);
    run(sys, 5);
    expect(nodes[0].disposed).toBe(1);
    expect(nodes.length).toBe(1);
    // rain again: a fresh node
    sys.set(0.6);
    run(sys, 0.1);
    expect(nodes.length).toBe(2);
    // rain returns while fading out: the same node carries on
    sys.set(0);
    run(sys, 2);
    sys.set(0.8);
    run(sys, 6);
    expect(nodes.length).toBe(2);
    expect(nodes[1].disposed).toBe(0);
  });

  it('a storm thunders every 20-60 s, the sound arrives after the flash-to-bang delay, and a flash callback fires', () => {
    const { sys, nodes } = makeSystem();
    const strikes: { at: number; delay: number; km: number }[] = [];
    let now = 0;
    sys.onStrike = (s) => strikes.push({ at: now, delay: s.delaySeconds, km: s.distanceKm });
    sys.set(1);
    const dt = 1 / 60;
    const heard: number[] = [];
    for (let i = 0; i < 600 * 60; i++) {
      now = i * dt;
      const before = nodes[0]?.thunders.length ?? 0;
      sys.update(dt, 0, 30, false);
      if ((nodes[0]?.thunders.length ?? 0) > before) heard.push(now);
    }
    expect(strikes.length).toBeGreaterThan(8);
    expect(strikes.length).toBeLessThan(26);
    for (let i = 1; i < strikes.length; i++) {
      const gap = strikes[i].at - strikes[i - 1].at;
      expect(gap).toBeGreaterThan(THUNDER_INTERVAL_MIN - 0.1);
      expect(gap).toBeLessThan(THUNDER_INTERVAL_MAX + 0.1);
    }
    // every clap that has had time to arrive was delivered to the node `delay` seconds after its flash
    const arrived = strikes.filter((s) => s.at + s.delay < 598);
    expect(heard.length).toBeGreaterThanOrEqual(arrived.length);
    arrived.forEach((s, i) => expect(Math.abs(heard[i] - (s.at + s.delay))).toBeLessThan(0.05));
    expect(sys.strikes).toBe(strikes.length);
  });

  it('the "rain" preset does not thunder; a paused game does not advance the clock; dry resets it', () => {
    const a = makeSystem();
    a.sys.set(0.55);
    run(a.sys, 400);
    expect(a.nodes[0].thunders.length).toBe(0);
    expect(a.sys.strikes).toBe(0);
    const b = makeSystem();
    b.sys.set(1);
    run(b.sys, 400, 0, 30, true); // paused the whole time
    expect(b.sys.strikes).toBe(0);
    run(b.sys, 5);
    expect(b.sys.strikes).toBe(0); // the first clap is not due yet
    const c = makeSystem();
    c.sys.set(1);
    run(c.sys, 100);
    const n = c.sys.strikes;
    expect(n).toBeGreaterThan(0);
    c.sys.set(0);
    c.sys.set(1);
    run(c.sys, 1);
    expect(c.nodes[0].thunders.length).toBeLessThanOrEqual(n);
  });

  it('survives a node factory that throws: warns once, does not retry every frame', () => {
    let calls = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sys = new WeatherSystem({
      ready: () => true,
      makeNode: () => {
        calls++;
        throw new Error('no worklet');
      },
    });
    sys.set(1);
    run(sys, 5);
    expect(calls).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    expect(sys.active).toBe(false);
    sys.dispose();
    run(sys, 1);
  });

  it('dispose() drops the node and stops everything', () => {
    const { sys, nodes } = makeSystem();
    sys.set(1);
    run(sys, 1);
    sys.dispose();
    expect(nodes[0].disposed).toBe(1);
    const posts = nodes[0].posts.length;
    run(sys, 1);
    expect(nodes[0].posts.length).toBe(posts);
  });
});

// ── the public index: onLightning ───────────────────────────────────────────

describe('onLightning (optional flash hook)', () => {
  it('attaches a strike callback to a system with weather, and says no to one without', async () => {
    const { onLightning } = await import('../src/audio');
    const nodes: MockNode[] = [];
    const weather = new WeatherSystem(
      {
        ready: () => true,
        makeNode: () => {
          const n = new MockNode();
          nodes.push(n);
          return n;
        },
      },
      9,
    );
    const fake = { weather } as unknown as import('../src/core/systems').AudioSystem;
    const seen: number[] = [];
    expect(onLightning(fake, (s) => seen.push(s.delaySeconds))).toBe(true);
    weather.set(1);
    for (let i = 0; i < 60 * 120; i++) weather.update(1 / 60, 0, 30, false);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((d) => d > 7 && d < 31)).toBe(true); // 2.5-10 km at 343 m/s
    expect(onLightning(fake, null)).toBe(true);
    const n0 = seen.length;
    for (let i = 0; i < 60 * 200; i++) weather.update(1 / 60, 0, 30, false);
    expect(seen.length).toBe(n0); // detached
    // the silent fallback system has no weather
    expect(onLightning({} as import('../src/core/systems').AudioSystem, () => undefined)).toBe(false);
  });
});

// ── worklet glue ─────────────────────────────────────────────────────────────

describe('engine.worklet.ts: the xr-weather and xr-car processors', () => {
  type Proc = {
    port: { onmessage: ((e: { data: unknown }) => void) | null };
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  };
  const registered: Record<string, new (o: unknown) => Proc> = {};

  beforeAll(async () => {
    vi.stubGlobal('sampleRate', SR);
    vi.stubGlobal('currentFrame', 0);
    vi.stubGlobal('registerProcessor', (name: string, ctor: new (o: unknown) => Proc) => {
      registered[name] = ctor;
    });
    vi.stubGlobal(
      'AudioWorkletProcessor',
      class {
        port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage(): void {}, close(): void {} };
      },
    );
    await import('../src/audio/engine.worklet');
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const setFrame = (f: number): void => {
    (globalThis as unknown as { currentFrame: number }).currentFrame = f;
  };

  it('registers both processors', () => {
    expect(typeof registered['xr-car']).toBe('function');
    expect(typeof registered['xr-weather']).toBe('function');
  });

  it('xr-weather: silent until it rains, follows control messages, takes thunder and disposes', () => {
    const p = new registered['xr-weather']({ processorOptions: { seed: 3 } });
    const out = [[new Float32Array(128), new Float32Array(128)]];
    const render = (blocks: number): { l: Float32Array; r: Float32Array } => {
      const l = new Float32Array(blocks * 128);
      const r = new Float32Array(blocks * 128);
      for (let b = 0; b < blocks; b++) {
        expect(p.process([], out)).toBe(true);
        l.set(out[0][0], b * 128);
        r.set(out[0][1], b * 128);
      }
      return { l, r };
    };
    let x = render(50);
    expect(peakAbs(x.l) + peakAbs(x.r)).toBe(0);
    const v = makeWeatherControlVector();
    v[WCTL.RAIN] = 1;
    v[WCTL.GAIN] = 1;
    p.port.onmessage!({ data: v });
    render(1500); // fade in
    x = render(300);
    expect(db(rms(x.l))).toBeGreaterThan(-33);
    expect(db(rms(x.l))).toBeLessThan(-22);
    expect(hasNonFinite(x.l) || hasNonFinite(x.r)).toBe(false);
    // thunder message
    p.port.onmessage!({ data: { type: 'thunder', ev: { distanceKm: 4, level: 1, pan: 0, seed: 5 } } });
    const t = render(400);
    expect(db(rms(t.l))).toBeGreaterThan(db(rms(x.l)) + 2);
    // a mono output (no right channel) is tolerated
    expect(p.process([], [[new Float32Array(128)]])).toBe(true);
    // pause, then dispose
    v[WCTL.GAIN] = 0;
    p.port.onmessage!({ data: v });
    render(400);
    x = render(10);
    expect(peakAbs(x.l)).toBeLessThan(1e-3);
    p.port.onmessage!({ data: 'dispose' });
    expect(p.process([], out)).toBe(false);
  });

  it('xr-weather offline mode: a recorded control script and fixed-time thunder claps drive the voice', () => {
    const step = 800;
    const frames = 60;
    const data = new Float32Array(frames * WCTL_LEN);
    for (let k = 0; k < frames; k++) {
      data[k * WCTL_LEN + WCTL.RAIN] = 1;
      data[k * WCTL_LEN + WCTL.GAIN] = 1;
    }
    const p = new registered['xr-weather']({ processorOptions: { seed: 3, script: { step, data }, thunders: [{ t: 0.5, ev: { distanceKm: 3, level: 1, pan: 0, seed: 1 } }] } });
    const out = [[new Float32Array(128), new Float32Array(128)]];
    const l = new Float32Array(2 * SR);
    for (let b = 0; b < l.length / 128; b++) {
      setFrame(b * 128);
      p.process([], out);
      l.set(out[0][0], b * 128);
    }
    setFrame(0);
    expect(hasNonFinite(l)).toBe(false);
    expect(db(rms(l, SR, 2 * SR))).toBeGreaterThan(-35);
    // the clap at 0.5 s is there (low-frequency energy well above a render without it)
    const q = new registered['xr-weather']({ processorOptions: { seed: 3, script: { step, data } } });
    const l2 = new Float32Array(2 * SR);
    for (let b = 0; b < l2.length / 128; b++) {
      setFrame(b * 128);
      q.process([], out);
      l2.set(out[0][0], b * 128);
    }
    setFrame(0);
    const lo = (x: Float32Array): number => bandPower(welch(x, 8192, Math.floor(0.7 * SR), 2 * SR), SR, 20, 300);
    expect(lo(l)).toBeGreaterThan(lo(l2) * 2);
  });

  it('xr-car: the wet-road controls reach the chassis voice through the message path', () => {
    const profile = CARS[0].sound;
    const mk = (wet: number): number => {
      const p = new registered['xr-car']({ processorOptions: { profile, isPlayer: true, seed: 2, exGain: 1 } });
      const v = makeControlVector();
      v[CTL.SPEED] = 40;
      v[CTL.SURF_HARD] = 1;
      v[CTL.WET] = wet;
      p.port.onmessage!({ data: v });
      const out = [[new Float32Array(128)], [new Float32Array(128), new Float32Array(128)]];
      const ch = new Float32Array(2 * SR);
      for (let b = 0; b < ch.length / 128; b++) {
        p.process([], out);
        ch.set(out[1][0], b * 128);
      }
      return 10 * Math.log10(bandPower(welch(ch, 8192, SR, ch.length), SR, 1500, 8000));
    };
    expect(mk(0.75) - mk(0)).toBeGreaterThan(6);
  });
});

