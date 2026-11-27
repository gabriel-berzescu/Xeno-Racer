/**
 * Xenon Ring (headless): the layout brief as numbers, the megacity's light in the air, the circuit in the menus and in the Xeno Cup,
 * and a pack of twelve racing on it. The generic track checks (closed loop, continuity, widths, grid, design limits) run for it in
 * tests/track.test.ts like for every circuit; this file is what is particular to it.
 */
import { describe, expect, it } from 'vitest';
import { CARS } from '../src/cars';
import { buildView, CALENDAR, championshipDef, createChampionship, isPlayable, lapsFor, roundConfig, roundForecast } from '../src/game/championship';
import { blendInto, cloneSolution, envKey, solveEnvironment } from '../src/render/environment';
import { TRACKS, loadTrackRuntime } from '../src/track';
import type { TrackRuntimeImpl } from '../src/track/runtime';
import { BAR_CODE, SURF_CODE } from '../src/track/types';
import { formatConditions, trackCode } from '../src/ui/format';
import { runPack } from './probes/pack-race';

const rt = loadTrackRuntime('xenon') as TrackRuntimeImpl;
const info = TRACKS.find((t) => t.info.id === 'xenon')!.info;
const L = rt.length;
const N = rt.count;
const h = rt.spacing;
const DEG = Math.PI / 180;
const at = (s: number): number => Math.round((((s % L) + L) % L) / h) % N;
const yAt = (s: number): number => rt.py[at(s)];
const corner = (name: string) => {
  const c = rt.corners.find((k) => k.name === name);
  expect(c, `corner ${name} exists`).toBeDefined();
  return c!;
};
const lum = (c: ArrayLike<number>, o = 0): number => 0.2126 * c[o] + 0.7152 * c[o + 1] + 0.0722 * c[o + 2];

describe('Xenon Ring layout', () => {
  it('is a closed clockwise loop of 4.6-5.0 km made of the named corners, in order', () => {
    expect(rt.plan.closureError).toBeLessThan(0.01);
    expect(rt.plan.totalTurn / DEG).toBeCloseTo(-360, 1);
    expect(L).toBeGreaterThan(4600);
    expect(L).toBeLessThan(5000);
    expect(rt.corners.map((c) => c.name)).toEqual(['Chrome', 'Flux1', 'Flux2', 'Spire', 'Halo', 'Halo2', 'Arcade', 'Arcade2', 'Synapse1', 'Synapse2', 'Kernel', 'Ghost1', 'Ghost2', 'Neon']);
    for (let i = 1; i < rt.corners.length; i++) expect(rt.corners[i].sStart).toBeGreaterThan(rt.corners[i - 1].sEnd - 1e-6);
    expect(Math.abs(info.lengthHint - L)).toBeLessThan(5);
  });

  it('has the Strip, the longest straight, across the line and the heaviest braking of the lap at its end', () => {
    const chrome = corner('Chrome');
    const neon = corner('Neon');
    const strip = chrome.sStart + (L - neon.sEnd);
    expect(strip).toBeGreaterThan(900);
    // no other straight comes near it
    for (let i = 1; i < rt.corners.length; i++) expect(rt.corners[i].sStart - rt.corners[i - 1].sEnd).toBeLessThan(strip - 200);
    expect(chrome.dir).toBe(-1);
    expect(chrome.angle / DEG).toBeCloseTo(90, 0);
    expect(chrome.radius).toBeLessThanOrEqual(50);
    // and the last corner gives onto it: a right of 90 degrees, 260 m before the line
    expect(neon.dir).toBe(-1);
    expect(neon.angle / DEG).toBeCloseTo(90, 0);
    expect(L - neon.sEnd).toBeCloseTo(260, 0);
  });

  it('goes down to the lower city through the Flux esses and the Spire, and climbs back all the way from the Halo', () => {
    // a left and a right of the same size, close together, downhill
    const f1 = corner('Flux1');
    const f2 = corner('Flux2');
    expect([f1.dir, f2.dir]).toEqual([1, -1]);
    expect(f1.angle).toBeCloseTo(f2.angle, 6);
    expect(f2.sStart - f1.sEnd).toBeLessThan(80);
    expect(yAt(f2.sEnd)).toBeLessThan(yAt(f1.sStart) - 6);
    // the Spire: long and fast
    const spire = corner('Spire');
    expect(spire.dir).toBe(-1);
    expect(spire.radius).toBeGreaterThanOrEqual(160);
    expect(spire.sEnd - spire.sStart).toBeGreaterThan(300);
    // the top of the lap is on the Strip, the bottom on the Datastream, 30 m and more below
    let iMax = 0;
    let iMin = 0;
    for (let i = 0; i < N; i++) {
      if (rt.py[i] > rt.py[iMax]) iMax = i;
      if (rt.py[i] < rt.py[iMin]) iMin = i;
    }
    const sMax = iMax * h;
    const sMin = iMin * h;
    expect(sMax > corner('Neon').sEnd || sMax < corner('Chrome').sStart).toBe(true);
    expect(sMin).toBeGreaterThan(spire.sEnd);
    expect(sMin).toBeLessThan(corner('Halo').sStart);
    expect(rt.py[iMax] - rt.py[iMin]).toBeGreaterThan(30);
    // from the Halo to the line the road never goes down by more than a hand
    for (let s = corner('Halo').sStart; s < L - 300; s += 20) expect(yAt(s + 20), `s=${s.toFixed(0)}`).toBeGreaterThan(yAt(s) - 0.05);
  });

  it('runs the Datastream straight through the Conduit: 300 m and more of tunnel on the fastest stretch, well clear of the Halo', () => {
    expect(rt.tunnelSpans).toHaveLength(1);
    const [a, b] = rt.tunnelSpans[0];
    expect(b - a).toBeGreaterThan(300);
    expect(a).toBeGreaterThan(corner('Spire').sEnd + 100);
    expect(corner('Halo').sStart - b).toBeGreaterThan(150);
    for (let s = a - 100; s < b + 100; s += 5) expect(Math.abs(rt.curvature[at(s)])).toBeLessThan(1e-9);
    // tunnel walls on both sides all the way through
    for (let s = a + 2; s < b - 2; s += 5) {
      expect(rt.L.barrier[at(s)]).toBe(BAR_CODE.tunnel);
      expect(rt.R.barrier[at(s)]).toBe(BAR_CODE.tunnel);
    }
  });

  it('has the Halo: one banked arc of 180 degrees, climbing as it turns', () => {
    const a = corner('Halo');
    const b = corner('Halo2');
    expect([a.dir, b.dir]).toEqual([-1, -1]);
    expect((a.angle + b.angle) / DEG).toBeCloseTo(180, 0);
    expect(b.sStart - a.sEnd).toBeLessThan(0.5);
    expect(a.radius).toBe(b.radius);
    // the same curvature and 8 degrees of bank from the first apex to the last (the outside, the left, is the high side)
    for (let s = a.sArcA + 5; s < b.sArcB - 5; s += 10) {
      expect(rt.curvature[at(s)], `s=${s.toFixed(0)}`).toBeCloseTo(-1 / a.radius, 5);
      expect(rt.bank[at(s)] / DEG, `s=${s.toFixed(0)}`).toBeCloseTo(8, 1);
    }
    expect(yAt(b.sEnd) - yAt(a.sStart)).toBeGreaterThan(5);
  });

  it('has a hairpin to pass at (Arcade), a right-left and a left-right taken in one breath (Synapse, Ghost) and a slow right between them (Kernel)', () => {
    const a = corner('Arcade');
    const b = corner('Arcade2');
    expect([a.dir, b.dir]).toEqual([1, 1]);
    expect((a.angle + b.angle) / DEG).toBeCloseTo(165, 0);
    expect(a.radius).toBeLessThan(30);
    expect(b.sStart - a.sEnd).toBeLessThan(0.5);
    // a straight to brake from
    expect(a.sStart - corner('Halo2').sEnd).toBeGreaterThan(250);
    const s1 = corner('Synapse1');
    const s2 = corner('Synapse2');
    expect([s1.dir, s2.dir]).toEqual([-1, 1]);
    expect(s2.sStart - s1.sEnd).toBeLessThan(90);
    expect(Math.min(s1.radius, s2.radius)).toBeGreaterThanOrEqual(150);
    const g1 = corner('Ghost1');
    const g2 = corner('Ghost2');
    expect([g1.dir, g2.dir]).toEqual([1, -1]);
    expect(g2.sStart - g1.sEnd).toBeLessThan(30);
    const k = corner('Kernel');
    expect(k.dir).toBe(-1);
    expect(k.radius).toBeLessThan(100);
  });

  it('is a city circuit: a wall on both sides of every metre, asphalt or concrete to its foot, never a blade of grass', () => {
    const hard = [SURF_CODE.asphalt, SURF_CODE.concrete];
    for (let i = 0; i < N; i++) {
      for (const S of [rt.L, rt.R]) {
        expect(S.barrier[i], `barrier at ${i}`).not.toBe(BAR_CODE.none);
        if (S.b1W[i] > 0.05) expect(hard, `band at ${i}`).toContain(S.b1S[i]);
        if (S.b2W[i] > 0.05) expect(hard, `band at ${i}`).toContain(S.b2S[i]);
      }
    }
    expect(rt.def.paved).toBe(true);
    expect(rt.def.scenery?.city?.style).toBe('neon');
    // 13 to 15 m of road
    for (let i = 0; i < N; i += 10) {
      expect(rt.widthLeft[i] + rt.widthRight[i]).toBeGreaterThanOrEqual(13 - 1e-6);
      expect(rt.widthLeft[i] + rt.widthRight[i]).toBeLessThanOrEqual(15 + 1e-6);
    }
  });

  it('splits the lap into three sectors of a kilometre and more', () => {
    const [s1, s2] = rt.sectors;
    expect(s1).toBeCloseTo(corner('Spire').sEnd, 3);
    expect(s2).toBeCloseTo(corner('Arcade2').sEnd, 3);
    for (const len of [s1, s2 - s1, L - s2]) expect(len).toBeGreaterThan(1200);
  });
});

describe('Xenon Ring in the menus', () => {
  it('is on the track list with its own name, place and colour: a megacity, raced at night by default, under lights', () => {
    expect(info.name).toBe('Xenon Ring');
    expect(trackCode(info.name)).toBe('XEN');
    expect(info.location).toMatch(/Megacity/);
    expect(info.megacity).toBe(true);
    expect(info.floodlit).toBe(true);
    expect(info.winter).toBeUndefined();
    expect(info.defaultTimeOfDay).toBe('night');
    expect(TRACKS.filter((t) => t.info.megacity).map((t) => t.info.id)).toEqual(['xenon']);
    expect(new Set(TRACKS.map((t) => t.info.color.toLowerCase())).size).toBe(TRACKS.length);
    expect(new Set(TRACKS.map((t) => trackCode(t.info.name))).size).toBe(TRACKS.length);
  });
});

describe('The light of the megacity in the air', () => {
  it('is its own environment after dark: a glow at the horizon and in the haze, a thicker air, hardly a star', async () => {
    const plain = await solveEnvironment({ timeOfDay: 'night', weather: 'clear' });
    const city = await solveEnvironment({ timeOfDay: 'night', weather: 'clear', megacity: true });
    expect(envKey(city.settings)).not.toBe(envKey(plain.settings));
    // the glow: violet (more red and far more blue than green), and the haze the towers fade into is brighter by it on every side
    expect(lum(city.city)).toBeGreaterThan(0);
    expect(city.city[2]).toBeGreaterThan(city.city[0]);
    expect(city.city[0]).toBeGreaterThan(city.city[1] * 2);
    for (let k = 0; k < city.fogTable.length; k += 3) for (let c = 0; c < 3; c++) expect(city.fogTable[k + c]).toBeCloseTo(plain.fogTable[k + c] + city.city[c], 6);
    expect(lum(city.fogColor)).toBeGreaterThan(lum(plain.fogColor) * 1.3);
    expect(lum(city.fogColor)).toBeLessThan(lum(plain.fogColor) * 3);
    expect(city.fogDensity).toBeGreaterThan(plain.fogDensity * 1.5);
    expect(city.stars).toBeLessThan(plain.stars * 0.3);
    expect(lum(city.skyAmbient)).toBeGreaterThan(lum(plain.skyAmbient));
    // the moon, the exposure and the dark are the night's own
    expect(city.lightIntensity).toBe(plain.lightIntensity);
    expect(city.exposure).toBe(plain.exposure);
    expect(city.darkness).toBe(1);
  });

  it('lights the underside of a rain deck, and the mist under it', async () => {
    const plain = await solveEnvironment({ timeOfDay: 'night', weather: 'rain' });
    const city = await solveEnvironment({ timeOfDay: 'night', weather: 'rain', megacity: true });
    expect(lum(city.deckLo)).toBeGreaterThan(lum(plain.deckLo) * 1.5);
    expect(lum(city.deckHi)).toBeGreaterThan(lum(plain.deckHi) * 1.5);
    expect(city.deckLo[2]).toBeGreaterThan(city.deckLo[1]);
    expect(lum(city.fogColor)).toBeGreaterThan(lum(plain.fogColor) * 2);
    expect(city.stars).toBe(0);
  });

  it('is off by day (an ordinary sky in a little more haze), comes on with the dusk, and is nobody else\'s', async () => {
    for (const timeOfDay of ['morning', 'noon', 'golden'] as const) {
      const plain = await solveEnvironment({ timeOfDay, weather: 'clear' });
      const city = await solveEnvironment({ timeOfDay, weather: 'clear', megacity: true });
      expect(city.city, timeOfDay).toEqual([0, 0, 0]);
      expect(Array.from(city.fogTable), timeOfDay).toEqual(Array.from(plain.fogTable));
      expect(city.skyAmbient, timeOfDay).toEqual(plain.skyAmbient);
      expect(city.fogDensity, timeOfDay).toBeGreaterThan(plain.fogDensity);
      expect(city.fogDensity, timeOfDay).toBeLessThan(plain.fogDensity * 1.5);
    }
    const dusk = await solveEnvironment({ timeOfDay: 'dusk', weather: 'cloudy', megacity: true });
    const night = await solveEnvironment({ timeOfDay: 'night', weather: 'cloudy', megacity: true });
    expect(lum(dusk.city)).toBeGreaterThan(0);
    expect(lum(dusk.city)).toBeLessThan(lum(night.city) * 0.6);
    // every other circuit's sky has none of it, at any hour
    for (const timeOfDay of ['dawn', 'noon', 'dusk', 'night'] as const) {
      for (const weather of ['clear', 'rain', 'storm'] as const) {
        expect((await solveEnvironment({ timeOfDay, weather })).city).toEqual([0, 0, 0]);
        expect((await solveEnvironment({ timeOfDay, weather, winter: true })).city).toEqual([0, 0, 0]);
      }
    }
  }, 60000);

  it('follows a weather that changes: the glow of a night that clears is at every moment between the two skies\'', async () => {
    const dry = await solveEnvironment({ timeOfDay: 'night', weather: 'cloudy', megacity: true });
    const wet = await solveEnvironment({ timeOfDay: 'night', weather: 'rain', megacity: true });
    const out = cloneSolution(dry);
    expect(blendInto(out, dry, wet, 0, 0).city).toEqual(dry.city);
    expect(blendInto(out, dry, wet, 1, 0.55).city).toEqual(wet.city);
    const mid = blendInto(out, dry, wet, 0.5, 0.3);
    for (let c = 0; c < 3; c++) {
      expect(mid.city[c]).toBeGreaterThanOrEqual(Math.min(dry.city[c], wet.city[c]) - 1e-12);
      expect(mid.city[c]).toBeLessThanOrEqual(Math.max(dry.city[c], wet.city[c]) + 1e-12);
    }
    // (the copy the blend writes into owns its glow: the dry solution is untouched)
    out.city[0] = 99;
    expect(dry.city[0]).not.toBe(99);
  });
});

describe('Xenon Ring in the Xeno Cup', () => {
  it('has one round of the calendar, the last one on the ground: a night in the rain that clears', () => {
    const tracks = TRACKS.map((t) => t.info);
    const def = championshipDef(tracks);
    const rounds = def.rounds.map((r, i) => ({ ...r, i })).filter((r) => r.trackId === 'xenon');
    expect(rounds.map((r) => [r.i, r.environment.timeOfDay, r.environment.weather, r.forecast ?? 'stable'])).toEqual([
      [5, 'night', 'rain', 'clearing'],
    ]);
    // (the megacity is the future the season goes into before it leaves the ground: the round after it is the ring at Saturn)
    expect(def.rounds[6].trackId).toBe('hyperion');
    for (const r of rounds) {
      expect(r.laps.standard).toBe(lapsFor(info.defaultLaps, 'standard'));
      expect(r.laps.short).toBeLessThanOrEqual(r.laps.standard);
    }
    const car = CARS[0];
    const state = createChampionship({
      setup: { carId: car.id, livery: { primary: '#16e0bd', driver: 'Gabriel' }, difficulty: 'pro', opponents: 7, length: 'standard', startPosition: 'back', grid: 'standings' },
      tracks,
      playerName: 'Gabriel',
      playerLivery: { ...car.defaultLivery, driver: 'Gabriel' },
      car,
      seed: 4242,
    });
    expect(isPlayable(state, TRACKS.map((t) => t.info.id), CARS.map((c) => c.id))).toBe(true);
    const rain = roundConfig(state, 5);
    expect(rain).toMatchObject({ trackId: 'xenon', environment: { timeOfDay: 'night', weather: 'rain' }, forecast: 'clearing', championship: { round: 6, rounds: 8 } });
    expect(Number.isInteger(rain.forecastSeed) && (rain.forecastSeed ?? 0) >= 1).toBe(true);
    expect(rain.laps).toBe(state.calendar[5].laps);
    expect(buildView(state).rounds[5]).toMatchObject({ trackId: 'xenon', forecast: 'clearing' });
    // the menus call it rain here (it is no winter circuit)
    expect(formatConditions(rain.environment, rain.forecast, info.winter)).not.toContain('Snow');
  });

  it('runs the clearing at every race length of the season, never on a one-lap race', () => {
    const def = championshipDef(TRACKS.map((t) => t.info));
    const r = CALENDAR[5];
    expect(r.trackId).toBe('xenon');
    for (const laps of Object.values(def.rounds[5].laps)) expect(roundForecast(r, laps)).toBe('clearing');
    expect(roundForecast(r, 1)).toBe('stable');
  });
});

describe('A pack on Xenon Ring', () => {
  it('twelve mixed cars race two laps, dry and in standing water, without a reset and hardly a wall', () => {
    for (const [seed, wetness] of [[0, 0], [1, 1]] as const) {
      const r = runPack('xenon', 'mixed', 'pro', 12, 2, false, { seed, wetness });
      expect(r.finished, `finished, seed ${seed} wet ${wetness}`).toBe(12);
      expect(r.resets, `resets, seed ${seed} wet ${wetness}`).toBe(0);
      expect(r.walls, `wall hits, seed ${seed} wet ${wetness}`).toBeLessThan(6);
      expect(r.offTrack, `seconds off the road, seed ${seed} wet ${wetness}`).toBeLessThan(10);
      // a place to pass: the Strip into Chrome, the straight into the Arcade hairpin
      expect(r.overtakes, `overtakes, seed ${seed} wet ${wetness}`).toBeGreaterThan(3);
    }
  }, 600000);
});
