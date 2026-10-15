import { describe, expect, it } from 'vitest';
import type { TimeOfDay, Weather } from '../src/core/contracts';
import { WEATHER_WATER } from '../src/core/contracts';
import { lightningStrength, solveEnvironment } from '../src/render/environment';
import { WEATHER } from '../src/render/presets';

const TODS: TimeOfDay[] = ['dawn', 'morning', 'noon', 'golden', 'dusk', 'night'];
const WET: Weather[] = ['rain', 'storm'];
const DRY: Weather[] = ['clear', 'cloudy', 'overcast'];
const finite = (a: ArrayLike<number>) => Array.from(a).every((x) => Number.isFinite(x));
const lum = (c: ArrayLike<number>) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;

describe('wet-weather environment', () => {
  it('keeps the dry presets exactly dry: no deck, no rain haze, no extra darkness', async () => {
    for (const w of DRY) {
      const p = WEATHER[w];
      expect(p.deck, w).toBe(0);
      expect(p.rainFog, w).toBe(0);
      expect(p.darken, w).toBe(0);
      expect(WEATHER_WATER[w].wetness, w).toBe(0);
      for (const t of TODS) {
        const s = await solveEnvironment({ timeOfDay: t, weather: w });
        expect(s.deck).toBe(0);
        expect(s.rainFog).toBe(0);
        expect(Math.abs(s.glow[0]) + Math.abs(s.glow[1]) + Math.abs(s.glow[2])).toBe(0);
      }
    }
  }, 120000);

  it('solves finite numbers for every time of day under rain and storm', async () => {
    for (const w of WET) {
      for (const t of TODS) {
        const s = await solveEnvironment({ timeOfDay: t, weather: w });
        const tag = `${t}/${w}`;
        expect(s.deck, tag).toBe(1);
        expect(finite(s.deckLo), tag).toBe(true);
        expect(finite(s.deckHi), tag).toBe(true);
        expect(finite(s.glow), tag).toBe(true);
        expect(finite(s.fogTable), tag).toBe(true);
        expect(s.rainFog, tag).toBeGreaterThan(0);
        expect(s.stars, tag).toBe(0);
        expect(s.darkness, tag).toBeGreaterThanOrEqual(0);
        expect(s.darkness, tag).toBeLessThanOrEqual(1);
      }
    }
  }, 120000);

  it('has no sun to speak of, no shadows and a darker, hazier storm than rain', async () => {
    for (const t of TODS) {
      const clear = await solveEnvironment({ timeOfDay: t, weather: 'clear' });
      const rain = await solveEnvironment({ timeOfDay: t, weather: 'rain' });
      const storm = await solveEnvironment({ timeOfDay: t, weather: 'storm' });
      expect(rain.shadowIntensity, t).toBeLessThan(0.1);
      expect(storm.shadowIntensity, t).toBeLessThanOrEqual(rain.shadowIntensity);
      expect(rain.lightIntensity, t).toBeLessThan(clear.lightIntensity * 0.2 + 1e-6);
      expect(storm.rainFog, t).toBeGreaterThan(rain.rainFog);
      expect(lum(storm.deckHi), t).toBeLessThan(lum(rain.deckHi));
      expect(storm.darkness, t).toBeGreaterThanOrEqual(rain.darkness);
    }
  }, 120000);

  it('turns the headlights on for a noon storm but not for a noon drizzle', async () => {
    const rain = await solveEnvironment({ timeOfDay: 'noon', weather: 'rain' });
    const storm = await solveEnvironment({ timeOfDay: 'noon', weather: 'storm' });
    expect(rain.darkness).toBeLessThan(0.25);
    expect(storm.darkness).toBeGreaterThan(0.3);
  }, 60000);

  it('keeps a faint warm glow under the deck at dusk and none at noon', async () => {
    const dusk = await solveEnvironment({ timeOfDay: 'dusk', weather: 'rain' });
    const noon = await solveEnvironment({ timeOfDay: 'noon', weather: 'rain' });
    expect(dusk.glow[0] - dusk.glow[2]).toBeGreaterThan(0);
    expect(Math.abs(noon.glow[0] - noon.glow[2])).toBeLessThan(Math.abs(dusk.glow[0] - dusk.glow[2]));
  }, 60000);

  it('dumps the solved numbers on demand', async () => {
    if (!process.env.DUMP) return;
    const f = (c: ArrayLike<number>) => Array.from(c).map((x) => x.toFixed(3)).join(', ');
    for (const w of ['overcast', 'rain', 'storm'] as Weather[]) {
      for (const t of TODS) {
        const s = await solveEnvironment({ timeOfDay: t, weather: w });
        console.log(
          `${t.padEnd(8)} ${w.padEnd(8)} exp ${s.exposure.toFixed(2)} dark ${s.darkness.toFixed(2)} amb [${f(s.skyAmbient)}] haze [${f(s.haze)}] deckLo [${f(s.deckLo)}] deckHi [${f(s.deckHi)}] glow [${f(s.glow)}] fog [${f(s.fogColor)}] sunI ${s.lightIntensity.toFixed(3)} fogD ${s.fogDensity.toExponential(2)} lin ${s.rainFog.toExponential(2)}`,
        );
      }
    }
  }, 120000);
});

describe('lightning strength', () => {
  it('falls with the distance of the strike and stays inside 0..1', () => {
    let prev = Infinity;
    for (let d = 1; d <= 14; d += 0.5) {
      const s = lightningStrength(d);
      expect(s).toBeGreaterThan(0.1);
      expect(s).toBeLessThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(prev + 1e-12);
      prev = s;
    }
    expect(lightningStrength(2.5)).toBeGreaterThan(0.8);
    expect(lightningStrength(10)).toBeLessThan(0.3);
    expect(Number.isFinite(lightningStrength(Number.NaN))).toBe(true);
  });
});
