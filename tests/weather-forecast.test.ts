/**
 * Weather that changes during a race (headless, Node): the forecast rules, the plan of a race (deterministic in its seed), the
 * director that turns the leader's progress into the sky, the rain and the water on the road (lag, drying, bounds), the replay's
 * weather log, how the setup screen offers and builds a forecast, and the audio voices that are armed behind the loading screen.
 */
import { describe, expect, it } from 'vitest';
import { WEATHER_WATER, type Forecast, type RaceMode, type Weather, type WeatherState } from '../src/core/contracts';
import { DRY_BELOW, FORECASTS, forecastAllowed, forecastOptions, FORECAST_MIN_LAPS, sanitizeForecast, wetnessBars } from '../src/core/forecast';
import {
  CALL_PROGRESS,
  CALL_SECONDS,
  DRY_RATE,
  DRY_TAU,
  evaluate,
  fixedState,
  makePlan,
  nearestWeather,
  planDuration,
  startState,
  stepWetness,
  trackCondition,
  WET_RECORD,
  WET_RISE_TAU,
  WeatherDirector,
  WeatherLog,
  wetnessTarget,
  type WeatherPlan,
} from '../src/game/weather';
import { WeatherSystem, type WeatherNodeLike } from '../src/audio/weather';
import { WiperSystem, type WiperHost, type WiperNodeLike } from '../src/audio/wiper';
import { WCTL } from '../src/audio/weather-model';
import { CARS } from '../src/cars';
import { buildRaceConfig, defaultSetup, forecastNow, forecastOffered, newForecastSeed, OPTION_LABELS } from '../src/ui/model';
import { FORECAST_LABEL, formatConditions } from '../src/ui/format';
import type { TrackInfo } from '../src/core/contracts';

const DRY: Weather[] = ['clear', 'cloudy', 'overcast'];
const WET: Weather[] = ['rain', 'storm'];
const ALL: Weather[] = [...DRY, ...WET];
const MODES: RaceMode[] = ['race', 'timeTrial', 'freeRoam'];

const TRACKS: TrackInfo[] = [
  { id: 'a', name: 'A', location: '', description: '', difficulty: 2, defaultLaps: 3, defaultTimeOfDay: 'golden', lengthHint: 4800, color: '#fff' },
  { id: 'b', name: 'B', location: '', description: '', difficulty: 3, defaultLaps: 4, defaultTimeOfDay: 'night', lengthHint: 5200, color: '#fff' },
];

/** Run a director for `seconds` at 60 Hz with the leader past the call, recording the state every `every` seconds. */
function run(plan: WeatherPlan, seconds: number, every = 1): { t: number; s: WeatherState }[] {
  const d = new WeatherDirector(plan);
  const out: { t: number; s: WeatherState }[] = [];
  const dt = 1 / 60;
  const steps = Math.round(seconds / dt);
  const stride = Math.round(every / dt);
  for (let i = 0; i <= steps; i++) {
    d.update(dt, 0.99, i * dt);
    if (i % stride === 0) out.push({ t: i * dt, s: { ...d.state } });
  }
  return out;
}

const rainLater = (seed: number, weather: Weather = 'clear'): WeatherPlan => makePlan({ forecast: 'rainLater', weather, mode: 'race', laps: 3, seed })!;
const clearing = (seed: number, weather: Weather = 'rain'): WeatherPlan => makePlan({ forecast: 'clearing', weather, mode: 'race', laps: 3, seed })!;

describe('which forecasts make sense', () => {
  it('rain later wants a dry start, clearing a wet one, and stable always goes', () => {
    for (const w of ALL) {
      for (const m of MODES) {
        expect(forecastAllowed('stable', w, m, 3), `stable ${w} ${m}`).toBe(true);
        expect(forecastAllowed('rainLater', w, m, 3), `rainLater ${w} ${m}`).toBe(m !== 'timeTrial' && DRY.includes(w));
        expect(forecastAllowed('clearing', w, m, 3), `clearing ${w} ${m}`).toBe(m !== 'timeTrial' && WET.includes(w));
      }
    }
  });

  it('a race needs a couple of laps for the weather to do anything; free roam has no laps to count', () => {
    expect(FORECAST_MIN_LAPS).toBe(2);
    expect(forecastAllowed('rainLater', 'clear', 'race', 1)).toBe(false);
    expect(forecastAllowed('rainLater', 'clear', 'race', 2)).toBe(true);
    expect(forecastAllowed('clearing', 'storm', 'race', 0)).toBe(false);
    expect(forecastAllowed('rainLater', 'clear', 'race', Number.NaN)).toBe(false);
    expect(forecastAllowed('rainLater', 'clear', 'freeRoam', 0)).toBe(true);
  });

  it('sanitizeForecast turns anything that does not fit into stable, and passes what does', () => {
    expect(sanitizeForecast(undefined, 'clear', 'race', 3)).toBe('stable');
    expect(sanitizeForecast('rainLater', 'clear', 'race', 3)).toBe('rainLater');
    expect(sanitizeForecast('rainLater', 'rain', 'race', 3)).toBe('stable');
    expect(sanitizeForecast('clearing', 'clear', 'race', 3)).toBe('stable');
    expect(sanitizeForecast('clearing', 'storm', 'timeTrial', 3)).toBe('stable');
    expect(sanitizeForecast('nonsense' as Forecast, 'clear', 'race', 3)).toBe('stable');
  });

  it('the setup offers stable first and then only what fits', () => {
    expect(forecastOptions('clear', 'race', 3)).toEqual(['stable', 'rainLater']);
    expect(forecastOptions('storm', 'race', 3)).toEqual(['stable', 'clearing']);
    expect(forecastOptions('rain', 'timeTrial', 3)).toEqual(['stable']);
    expect(forecastOptions('overcast', 'race', 1)).toEqual(['stable']);
    expect(FORECASTS[0]).toBe('stable');
  });
});

describe('the plan of a race', () => {
  it('is the same for the same seed (a restart repeats the weather) and differs between seeds', () => {
    for (const seed of [1, 2, 99, 123456]) {
      expect(rainLater(seed)).toEqual(rainLater(seed));
      expect(clearing(seed)).toEqual(clearing(seed));
    }
    const plans = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) plans.add(JSON.stringify(rainLater(seed)));
    expect(plans.size).toBe(30);
  });

  it('has no plan for a stable or an impossible forecast', () => {
    expect(makePlan({ forecast: undefined, weather: 'clear', mode: 'race', laps: 3 })).toBeNull();
    expect(makePlan({ forecast: 'stable', weather: 'clear', mode: 'race', laps: 3 })).toBeNull();
    expect(makePlan({ forecast: 'rainLater', weather: 'storm', mode: 'race', laps: 3 })).toBeNull();
    expect(makePlan({ forecast: 'rainLater', weather: 'clear', mode: 'timeTrial', laps: 0 })).toBeNull();
    expect(makePlan({ forecast: 'rainLater', weather: 'clear', mode: 'race', laps: 1 })).toBeNull();
  });

  it('keeps its numbers in the ranges of the brief, over many seeds', () => {
    let storms = 0;
    const clearings = new Set<Weather>();
    for (let seed = 1; seed <= 400; seed++) {
      const p = rainLater(seed, DRY[seed % 3]);
      expect(p.from).toBe(DRY[seed % 3]);
      expect(p.dry).toBe(p.from);
      expect(WET).toContain(p.to);
      expect(p.wet).toBe(p.to);
      expect('progress' in p.at).toBe(true);
      const at = (p.at as { progress: number }).progress;
      expect(at).toBeGreaterThanOrEqual(CALL_PROGRESS[0]);
      expect(at).toBeLessThanOrEqual(CALL_PROGRESS[1]);
      expect(p.lead).toBeGreaterThanOrEqual(30);
      expect(p.lead).toBeLessThanOrEqual(42);
      expect(p.span).toBeGreaterThanOrEqual(60);
      expect(p.span).toBeLessThanOrEqual(120);
      expect(p.peak).toBe(WEATHER_WATER[p.to].rain);
      if (p.to === 'storm') storms++;

      const c = clearing(seed, WET[seed % 2]);
      expect(c.from).toBe(WET[seed % 2]);
      expect(c.wet).toBe(c.from);
      expect(DRY).toContain(c.to);
      expect(c.dry).toBe(c.to);
      expect(c.peak).toBe(WEATHER_WATER[c.from].rain);
      clearings.add(c.to);
    }
    // a storm is the exception, not the rule; every kind of clearing turns up
    expect(storms).toBeGreaterThan(60);
    expect(storms).toBeLessThan(200);
    expect(clearings.size).toBe(3);
  });

  it('free roam has no race distance: the call comes from the clock, within the first minutes', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const p = makePlan({ forecast: 'rainLater', weather: 'cloudy', mode: 'freeRoam', laps: 0, seed })!;
      expect('seconds' in p.at).toBe(true);
      const s = (p.at as { seconds: number }).seconds;
      expect(s).toBeGreaterThanOrEqual(CALL_SECONDS[0]);
      expect(s).toBeLessThanOrEqual(CALL_SECONDS[1]);
    }
  });
});

describe('the sky and the rain after the call', () => {
  it('rain later: the cloud closes in first, the first drops fall about 35 s after the call, and the rain builds to its peak', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const p = rainLater(seed);
      const o = { sky: 0, rain: 0 };
      evaluate(p, 0, o);
      expect(o).toEqual({ sky: 0, rain: 0 });
      // sky ahead of the rain
      evaluate(p, p.lead, o);
      expect(o.rain).toBe(0);
      expect(o.sky).toBeGreaterThan(0.45);
      // the sky is closed well before the rain peaks
      evaluate(p, p.lead + p.span * 0.5, o);
      expect(o.sky).toBe(1);
      expect(o.rain).toBeGreaterThan(0.3 * p.peak);
      expect(o.rain).toBeLessThan(0.7 * p.peak);
      evaluate(p, planDuration(p) + 1, o);
      expect(o.sky).toBe(1);
      expect(o.rain).toBeCloseTo(p.peak, 9);
    }
  });

  it('clearing: the rain eases away first, the deck lifts after it, and the sky ends dry', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const p = clearing(seed, WET[seed % 2]);
      const o = { sky: 0, rain: 0 };
      evaluate(p, 0, o);
      expect(o.sky).toBe(1);
      expect(o.rain).toBeCloseTo(p.peak, 9);
      // while the rain is still falling the deck is hardly lifting
      evaluate(p, p.lead + p.span * 0.2, o);
      expect(o.sky).toBeGreaterThan(0.95);
      // the rain is over before the sky is
      evaluate(p, p.lead + p.span, o);
      expect(o.rain).toBeCloseTo(0, 9);
      expect(o.sky).toBeGreaterThan(0.2);
      evaluate(p, planDuration(p) + 1, o);
      expect(o.sky).toBe(0);
      expect(o.rain).toBe(0);
    }
  });

  it('only ever moves one way and stays within 0..1', () => {
    for (let seed = 1; seed <= 25; seed++) {
      for (const p of [rainLater(seed), clearing(seed)]) {
        const o = { sky: 0, rain: 0 };
        let prev = { sky: p.forecast === 'rainLater' ? 0 : 1, rain: p.forecast === 'rainLater' ? 0 : p.peak };
        for (let u = 0; u <= planDuration(p) + 20; u += 0.5) {
          evaluate(p, u, o);
          expect(o.sky).toBeGreaterThanOrEqual(0);
          expect(o.sky).toBeLessThanOrEqual(1);
          expect(o.rain).toBeGreaterThanOrEqual(0);
          expect(o.rain).toBeLessThanOrEqual(1);
          const dir = p.forecast === 'rainLater' ? 1 : -1;
          expect((o.sky - prev.sky) * dir).toBeGreaterThanOrEqual(-1e-12);
          expect((o.rain - prev.rain) * dir).toBeGreaterThanOrEqual(-1e-12);
          prev = { sky: o.sky, rain: o.rain };
        }
      }
    }
  });
});

describe('the water on the road', () => {
  it('settles to the weather presets own pairs: 0.55 rain -> 0.75, a storm -> 1, nothing -> 0', () => {
    expect(wetnessTarget(0)).toBe(0);
    expect(wetnessTarget(WEATHER_WATER.rain.rain)).toBeCloseTo(WEATHER_WATER.rain.wetness, 9);
    expect(wetnessTarget(WEATHER_WATER.storm.rain)).toBeCloseTo(WEATHER_WATER.storm.wetness, 9);
    let prev = 0;
    for (let r = 0; r <= 1.0001; r += 0.01) {
      const w = wetnessTarget(r);
      expect(w).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = w;
    }
    expect(wetnessTarget(-1)).toBe(0);
    expect(wetnessTarget(7)).toBe(1);
  });

  it('lags the rain: dry at the first drops, damp after half a minute, wet over about a lap, soaked after two', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const p = rainLater(seed, 'clear');
      const states = run(p, 400, 1);
      const at = (u: number): WeatherState => states[Math.round(u)].s;
      // the water follows the rain, never leads it
      for (const { s } of states) expect(s.wetness).toBeLessThanOrEqual(wetnessTarget(s.rain) + 1e-9);
      // a road that has not seen rain is dry
      expect(at(Math.floor(p.lead)).wetness).toBeLessThan(0.01);
      // half a minute after the first drops: damp, not wet
      const onset = Math.ceil(p.lead);
      expect(at(onset + 30).wetness).toBeLessThan(0.3);
      // about a lap (100 s) after the first drops it has taken most of its water
      const target = wetnessTarget(p.peak);
      expect(at(onset + 110).wetness).toBeGreaterThan(0.55 * target);
      expect(at(onset + 110).wetness).toBeLessThan(0.98 * target);
      // two laps on, it is done
      expect(at(onset + 240).wetness).toBeGreaterThan(0.97 * target);
    }
  });

  it('dries a good deal more slowly than it wets, and is dry in the end', () => {
    // wetting: from dry to 0.65 under the rain of the preset
    let w = 0;
    let tWet = 0;
    while (w < 0.65 && tWet < 2000) {
      w = stepWetness(w, 0.75, 0.25);
      tWet += 0.25;
    }
    // drying: from 0.75 down to 0.1 with no rain
    w = 0.75;
    let tDry = 0;
    while (w > 0.1 && tDry < 5000) {
      w = stepWetness(w, 0, 0.25);
      tDry += 0.25;
    }
    expect(tDry).toBeGreaterThan(3 * tWet);
    expect(tDry).toBeGreaterThan(180);
    expect(tDry).toBeLessThan(600);
    // and the road does end up dry: not an exponential that never quite gets there
    let t = 0;
    w = 1;
    while (w > 0 && t < 20000) {
      w = stepWetness(w, 0, 0.5);
      t += 0.5;
    }
    expect(w).toBe(0);
    expect(t).toBeLessThan(900);
    // the constants say so too
    expect(DRY_TAU).toBeGreaterThan(WET_RISE_TAU * 5);
    expect(DRY_RATE).toBeGreaterThan(0);
  });

  it('is a stable step: any dt gives a value between where it was and where it is heading', () => {
    for (const dt of [0.001, 1 / 60, 0.5, 5, 100, 1e5]) {
      for (const w of [0, 0.2, 0.75, 1]) {
        for (const target of [0, 0.3, 0.75, 1]) {
          const n = stepWetness(w, target, dt);
          expect(Number.isFinite(n)).toBe(true);
          expect(n).toBeGreaterThanOrEqual(Math.min(w, target) - 1e-12);
          expect(n).toBeLessThanOrEqual(Math.max(w, target) + 1e-12);
        }
      }
    }
    // no time, no change; a nonsense step changes nothing
    expect(stepWetness(0.4, 1, 0)).toBe(0.4);
    expect(stepWetness(0.4, 1, -3)).toBe(0.4);
    expect(stepWetness(0.4, 1, Number.NaN)).toBe(0.4);
  });

  it('the track condition words and the wet record threshold', () => {
    expect(trackCondition(0)).toBe('Dry');
    expect(trackCondition(0.1)).toBe('Damp');
    expect(trackCondition(0.4)).toBe('Wet');
    expect(trackCondition(0.75)).toBe('Very wet');
    expect(trackCondition(1)).toBe('Soaked');
    // the rain preset is a wet road, the storm a soaked one
    expect(trackCondition(WEATHER_WATER.rain.wetness)).toBe('Very wet');
    expect(trackCondition(WEATHER_WATER.storm.wetness)).toBe('Soaked');
    // a damp road is not a wet lap, a wet one is
    expect(WET_RECORD).toBeGreaterThan(0.04);
    expect(WET_RECORD).toBeLessThan(0.25);
  });

  it('the HUD meter agrees with the word: no bar while the track is called dry, then one per fifth, all five when soaked', () => {
    expect(trackCondition(DRY_BELOW - 1e-6)).toBe('Dry');
    expect(trackCondition(DRY_BELOW)).toBe('Damp');
    expect(wetnessBars(0)).toBe(0);
    expect(wetnessBars(DRY_BELOW - 1e-6)).toBe(0);
    expect(wetnessBars(DRY_BELOW)).toBe(1);
    expect(wetnessBars(0.2)).toBe(1);
    expect(wetnessBars(0.2001)).toBe(2);
    expect(wetnessBars(0.5)).toBe(3);
    expect(wetnessBars(WEATHER_WATER.rain.wetness)).toBe(4);
    expect(wetnessBars(1)).toBe(5);
    expect(wetnessBars(7)).toBe(5);
    // a wetter road never lights fewer bars
    let last = 0;
    for (let w = 0; w <= 1; w += 0.005) {
      const n = wetnessBars(w);
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
  });
});

describe('the director', () => {
  it('waits for the call: the state stays the start weather, whatever the clock does, until the leader gets there', () => {
    const p = rainLater(5);
    const at = (p.at as { progress: number }).progress;
    const d = new WeatherDirector(p);
    for (let i = 0; i < 600; i++) d.update(1 / 60, at - 0.01, i / 60);
    expect(d.called).toBe(false);
    expect(d.state).toEqual({ sky: 0, rain: 0, wetness: 0 });
    expect(d.drain().length).toBe(0);
    d.update(1 / 60, at, 10);
    expect(d.called).toBe(true);
    expect(d.state.sky).toBeGreaterThanOrEqual(0);
    const ev = d.drain();
    expect(ev.length).toBe(1);
    expect(ev[0].kind).toBe('call');
    expect(ev[0].notice.kind).toBe('rain');
    expect(ev[0].notice.title).toBe('Rain is coming');
    // the call is made once
    for (let i = 0; i < 300; i++) d.update(1 / 60, 0.9, 11 + i / 60);
    expect(d.drain().length).toBe(0);
  });

  it('the grid is behind the line: a leader at negative progress never calls it, and neither does a lap down', () => {
    const d = new WeatherDirector(rainLater(2));
    for (let i = 0; i < 100; i++) d.update(1 / 60, -0.05, 5);
    expect(d.called).toBe(false);
  });

  it('free roam is called by the clock', () => {
    const p = makePlan({ forecast: 'rainLater', weather: 'clear', mode: 'freeRoam', laps: 0, seed: 4 })!;
    const s = (p.at as { seconds: number }).seconds;
    const d = new WeatherDirector(p);
    d.update(1 / 60, Infinity, s - 0.5);
    expect(d.called).toBe(false);
    d.update(1 / 60, -1, s + 0.01);
    expect(d.called).toBe(true);
  });

  it('is deterministic: the same plan and the same inputs give the same weather, to the last digit', () => {
    const p = rainLater(77, 'overcast');
    const a = run(p, 300, 0.5);
    const b = run(p, 300, 0.5);
    expect(a).toEqual(b);
  });

  it('runs the same weather faster with a speed multiplier (a development flag)', () => {
    const p = rainLater(8);
    const slow = new WeatherDirector(p, 1);
    const fast = new WeatherDirector(p, 10);
    for (let i = 0; i < 6 * 60; i++) {
      slow.update(1 / 60, 0.9, i / 60);
      fast.update(1 / 60, 0.9, i / 60);
    }
    // 6 s at 10x = 60 s of weather
    expect(fast.elapsed).toBeCloseTo(60, 1);
    expect(slow.elapsed).toBeCloseTo(6, 1);
    const ref = run(p, 60, 60);
    expect(fast.state.sky).toBeCloseTo(ref[1].s.sky, 2);
    expect(fast.state.wetness).toBeCloseTo(ref[1].s.wetness, 1);
  });

  it('a step of any size lands on the same place (the frame rate does not change the weather)', () => {
    const p = rainLater(31);
    const fine = new WeatherDirector(p);
    const coarse = new WeatherDirector(p);
    for (let i = 0; i < 200 * 60; i++) fine.update(1 / 60, 0.9, 0);
    for (let i = 0; i < 200 * 2; i++) coarse.update(0.5, 0.9, 0);
    expect(coarse.state.sky).toBeCloseTo(fine.state.sky, 6);
    expect(coarse.state.rain).toBeCloseTo(fine.state.rain, 6);
    expect(coarse.state.wetness).toBeCloseTo(fine.state.wetness, 1);
  });

  it('starts a clearing race wet, with the rain of the start weather, and calls the clearing, then the stop', () => {
    const p = clearing(6, 'storm');
    const d = new WeatherDirector(p);
    expect(d.state).toEqual({ sky: 1, rain: 1, wetness: 1 });
    expect(startState(p)).toEqual({ sky: 1, rain: 1, wetness: 1 });
    const kinds: string[] = [];
    const wet: number[] = [];
    for (let i = 0; i < 700 * 60; i++) {
      d.update(1 / 60, i > 60 ? 0.9 : 0, i / 60);
      for (const e of d.drain()) kinds.push(e.kind + ':' + e.notice.title);
      if (i % 600 === 0) wet.push(d.state.wetness);
    }
    expect(kinds).toEqual(['call:Skies are clearing', 'stopped:The rain has stopped']);
    // dry in the end, and on the way down all the time
    expect(d.state.wetness).toBe(0);
    expect(d.state.rain).toBe(0);
    expect(d.state.sky).toBe(0);
    for (let i = 1; i < wet.length; i++) expect(wet[i]).toBeLessThanOrEqual(wet[i - 1] + 1e-12);
  });

  it('never leaves 0..1, whatever it is fed', () => {
    const d = new WeatherDirector(rainLater(9), 1000);
    for (let i = 0; i < 2000; i++) {
      d.update(i % 7 === 0 ? 3 : 1 / 60, Number.NaN > 0 ? 0 : 0.9, i);
      const s = d.state;
      for (const v of [s.sky, s.rain, s.wetness]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('a stable race has no director to speak of: nothing changes', () => {
    const d = new WeatherDirector(null);
    for (let i = 0; i < 100; i++) d.update(1, 0.9, i);
    expect(d.state).toEqual({ sky: 0, rain: 0, wetness: 0 });
    expect(d.called).toBe(false);
  });

  it('can be held at a state, for looking at it', () => {
    const d = new WeatherDirector(rainLater(3));
    d.hold({ sky: 0.5, rain: 0.2, wetness: 0.1 });
    for (let i = 0; i < 600; i++) d.update(1 / 60, 0.9, 0);
    expect(d.state).toEqual({ sky: 0.5, rain: 0.2, wetness: 0.1 });
  });

  it('fixed weather has the presets own state, and the icon follows the rain', () => {
    expect(fixedState('clear')).toEqual({ sky: 0, rain: 0, wetness: 0 });
    expect(fixedState('storm')).toEqual({ sky: 1, rain: 1, wetness: 1 });
    expect(fixedState('rain')).toEqual({ sky: 1, rain: WEATHER_WATER.rain.rain, wetness: WEATHER_WATER.rain.wetness });
    const p = rainLater(2, 'cloudy');
    expect(nearestWeather(p, { sky: 0.2, rain: 0, wetness: 0 })).toBe('cloudy');
    expect(nearestWeather(p, { sky: 0.9, rain: 0, wetness: 0 })).toBe('overcast');
    expect(nearestWeather(p, { sky: 1, rain: 0.3, wetness: 0.1 })).toBe('rain');
    expect(nearestWeather(p, { sky: 1, rain: 0.9, wetness: 0.5 })).toBe('storm');
  });
});

describe('the weather log of a replay', () => {
  it('plays back what was logged, interpolated, and holds the ends', () => {
    const log = new WeatherLog();
    const out: WeatherState = { sky: 0, rain: 0, wetness: 0 };
    expect(log.at(1, out)).toBe(false);
    log.sample(0, { sky: 0, rain: 0, wetness: 0 });
    log.sample(0.2, { sky: 1, rain: 1, wetness: 1 }); // closer than half a second: skipped
    log.sample(1, { sky: 0.5, rain: 0.2, wetness: 0.1 });
    log.sample(3, { sky: 1, rain: 0.6, wetness: 0.5 });
    expect(log.samples).toBe(3);
    expect(log.at(-5, out)).toBe(true);
    expect(out).toEqual({ sky: 0, rain: 0, wetness: 0 });
    log.at(0.5, out);
    expect(out.sky).toBeCloseTo(0.25, 9);
    expect(out.rain).toBeCloseTo(0.1, 9);
    log.at(2, out);
    expect(out.sky).toBeCloseTo(0.75, 9);
    expect(out.wetness).toBeCloseTo(0.3, 9);
    log.at(99, out);
    expect(out).toEqual({ sky: 1, rain: 0.6, wetness: 0.5 });
    log.reset();
    expect(log.samples).toBe(0);
  });
});

describe('the setup screen and the forecast', () => {
  const setup = (mode: 'race' | 'timeTrial' | 'freeRoam' | 'championship' = 'race', over: Partial<ReturnType<typeof defaultSetup>> = {}) => ({ ...defaultSetup(mode, TRACKS, CARS), ...over });

  it('starts stable, and a stable race carries no forecast and no seed', () => {
    const s = setup();
    expect(s.forecast).toBe('stable');
    const c = buildRaceConfig(s, TRACKS, CARS, 'Gabriel');
    expect(c.forecast).toBeUndefined();
    expect(c.forecastSeed).toBeUndefined();
    expect(Object.keys(c)).not.toContain('forecast');
    expect(c.environment).toEqual({ timeOfDay: 'golden', weather: 'clear' });
  });

  it('rain later from a dry weather goes into the config with a seed; the seed is the caller\'s when it gives one', () => {
    const s = setup('race', { forecast: 'rainLater', weather: 'cloudy', laps: 4 });
    const c = buildRaceConfig(s, TRACKS, CARS, 'X', 4242);
    expect(c.forecast).toBe('rainLater');
    expect(c.forecastSeed).toBe(4242);
    expect(c.environment.weather).toBe('cloudy');
    const r = buildRaceConfig(s, TRACKS, CARS, 'X');
    expect(Number.isInteger(r.forecastSeed)).toBe(true);
    expect(r.forecastSeed).toBeGreaterThan(0);
    // different races get different seeds
    const seeds = new Set<number>();
    for (let i = 0; i < 50; i++) seeds.add(newForecastSeed());
    expect(seeds.size).toBeGreaterThan(45);
  });

  it('a forecast that does not fit the weather, the mode or the laps is quietly stable', () => {
    // changed the weather after choosing: rain later from a storm makes no sense
    expect(buildRaceConfig(setup('race', { forecast: 'rainLater', weather: 'storm' }), TRACKS, CARS, 'X').forecast).toBeUndefined();
    expect(buildRaceConfig(setup('race', { forecast: 'clearing', weather: 'clear' }), TRACKS, CARS, 'X').forecast).toBeUndefined();
    expect(buildRaceConfig(setup('race', { forecast: 'clearing', weather: 'rain' }), TRACKS, CARS, 'X').forecast).toBe('clearing');
    // a time trial stays as set
    expect(buildRaceConfig(setup('timeTrial', { forecast: 'rainLater', weather: 'clear' }), TRACKS, CARS, 'X').forecast).toBeUndefined();
    // one lap is over before the sky has done anything
    expect(buildRaceConfig(setup('race', { forecast: 'rainLater', weather: 'clear', laps: 1 }), TRACKS, CARS, 'X').forecast).toBeUndefined();
    expect(buildRaceConfig(setup('race', { forecast: 'rainLater', weather: 'clear', laps: 2 }), TRACKS, CARS, 'X').forecast).toBe('rainLater');
    // free roam has no laps to count and may change
    expect(buildRaceConfig(setup('freeRoam', { forecast: 'rainLater', weather: 'clear' }), TRACKS, CARS, 'X').forecast).toBe('rainLater');
    // the championship's calendar is fixed
    expect(forecastNow(setup('championship', { forecast: 'rainLater', weather: 'clear' }))).toBe('stable');
  });

  it('the Forecast row offers what fits and follows the weather and the laps', () => {
    const s = setup('race', { weather: 'clear', laps: 3 });
    expect(forecastOffered(s, 'stable')).toBe(true);
    expect(forecastOffered(s, 'rainLater')).toBe(true);
    expect(forecastOffered(s, 'clearing')).toBe(false);
    s.weather = 'storm';
    expect(forecastOffered(s, 'rainLater')).toBe(false);
    expect(forecastOffered(s, 'clearing')).toBe(true);
    s.laps = 1;
    expect(forecastOffered(s, 'clearing')).toBe(false);
    expect(forecastOffered(setup('timeTrial', { weather: 'rain' }), 'clearing')).toBe(false);
  });

  it('remembers the choice from one visit to the next, and has the labels', () => {
    const a = setup('race', { forecast: 'clearing', weather: 'rain' });
    expect(defaultSetup('race', TRACKS, CARS, a).forecast).toBe('clearing');
    expect(OPTION_LABELS.forecast).toBe(FORECAST_LABEL);
    expect(FORECAST_LABEL.rainLater).toBe('Rain later');
    expect(FORECAST_LABEL.clearing).toBe('Clearing');
    expect(FORECAST_LABEL.stable).toBe('Stable');
    expect(formatConditions({ timeOfDay: 'golden', weather: 'clear' }, 'rainLater')).toBe('Golden hour  ·  Clear, rain later');
    expect(formatConditions({ timeOfDay: 'night', weather: 'rain' }, 'clearing')).toBe('Night  ·  Rain, clearing');
    expect(formatConditions({ timeOfDay: 'night', weather: 'rain' }, 'stable')).toBe('Night  ·  Rain');
    expect(formatConditions({ timeOfDay: 'night', weather: 'rain' })).toBe('Night  ·  Rain');
  });
});

describe('the audio voices that wait for the rain', () => {
  class MockWeatherNode implements WeatherNodeLike {
    posts: Float32Array[] = [];
    disposed = 0;
    post(v: Float32Array): void {
      this.posts.push(Float32Array.from(v));
    }
    thunder(): void {}
    dispose(): void {
      this.disposed++;
    }
  }

  it('a dry race has no rain voice; an armed one has it built (silent) before the first drop and keeps it', () => {
    const nodes: MockWeatherNode[] = [];
    const sys = new WeatherSystem({ ready: () => true, makeNode: () => (nodes.push(new MockWeatherNode()), nodes[nodes.length - 1]) }, 3);
    for (let i = 0; i < 600; i++) sys.update(1 / 60, 0, 30, false);
    expect(nodes.length).toBe(0);
    sys.arm(true);
    for (let i = 0; i < 60; i++) sys.update(1 / 60, 0, 30, false);
    expect(nodes.length).toBe(1);
    expect(sys.active).toBe(true);
    // no rain yet: the voice is told 0, and it is not dropped however long it takes
    for (let i = 0; i < 60 * 60; i++) sys.update(1 / 60, 0, 30, false);
    expect(nodes.length).toBe(1);
    expect(nodes[0].disposed).toBe(0);
    expect(nodes[0].posts[nodes[0].posts.length - 1][WCTL.RAIN]).toBe(0);
    // the first drops: the same node, no new one
    sys.set(0.05);
    for (let i = 0; i < 60; i++) sys.update(1 / 60, 0, 30, false);
    expect(nodes.length).toBe(1);
    expect(nodes[0].posts[nodes[0].posts.length - 1][WCTL.RAIN]).toBeCloseTo(0.05, 6);
    // the rain stops: still kept while armed
    sys.set(0);
    for (let i = 0; i < 20 * 60; i++) sys.update(1 / 60, 0, 30, false);
    expect(nodes[0].disposed).toBe(0);
    // disarmed, it goes the way it always did
    sys.arm(false);
    for (let i = 0; i < 6 * 60; i++) sys.update(1 / 60, 0, 30, false);
    expect(nodes[0].disposed).toBe(1);
    expect(sys.active).toBe(false);
  });

  it('an armed rain voice waits for the worklet to load, and fires no thunder while it is dry', () => {
    let ready = false;
    const nodes: MockWeatherNode[] = [];
    const sys = new WeatherSystem({ ready: () => ready, makeNode: () => (nodes.push(new MockWeatherNode()), nodes[nodes.length - 1]) }, 3);
    sys.arm(true);
    for (let i = 0; i < 120; i++) sys.update(1 / 60, 0, 0, false);
    expect(nodes.length).toBe(0);
    ready = true;
    sys.update(1 / 60, 0, 0, false);
    expect(nodes.length).toBe(1);
    let strikes = 0;
    sys.onStrike = () => strikes++;
    for (let i = 0; i < 10 * 60 * 60; i++) sys.update(1 / 60, 0, 0, false);
    expect(strikes).toBe(0);
    expect(sys.strikes).toBe(0);
  });

  class MockWiperNode implements WiperNodeLike {
    disposed = 0;
    sweep(): void {}
    stop(): void {}
    gain(): void {}
    dispose(): void {
      this.disposed++;
    }
  }

  it('an armed wiper voice is built ahead of the first sweep and kept while the blade is away', () => {
    const nodes: MockWiperNode[] = [];
    const host = { ready: true, running: true, muted: false, rain: 0, now: 1, lead: 0 };
    const h: WiperHost = {
      ready: () => host.ready,
      running: () => host.running,
      muted: () => host.muted,
      rain: () => host.rain,
      now: () => host.now,
      lead: () => host.lead,
      makeNode: () => (nodes.push(new MockWiperNode()), nodes[nodes.length - 1]),
    };
    const sys = new WiperSystem(h, 48000, 3);
    for (let i = 0; i < 300; i++) sys.update(1 / 60);
    expect(nodes.length).toBe(0);
    sys.arm(true);
    sys.update(1 / 60);
    expect(nodes.length).toBe(1);
    expect(sys.active).toBe(true);
    // a long time with no blade on screen: not dropped
    for (let i = 0; i < 120 * 60; i++) sys.update(1 / 60);
    expect(nodes[0].disposed).toBe(0);
    expect(sys.active).toBe(true);
    sys.arm(false);
    for (let i = 0; i < 6 * 60; i++) sys.update(1 / 60);
    expect(nodes[0].disposed).toBe(1);
    expect(sys.active).toBe(false);
  });
});
