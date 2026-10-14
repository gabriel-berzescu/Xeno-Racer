import { describe, expect, it } from 'vitest';
import type { TimeOfDay, Weather } from '../src/core/contracts';
import { solveEnvironment } from '../src/render/environment';

const TODS: TimeOfDay[] = ['dawn', 'morning', 'noon', 'golden', 'dusk', 'night'];
const WEATHERS: Weather[] = ['clear', 'cloudy', 'overcast'];

const finite = (a: ArrayLike<number>) => Array.from(a).every((x) => Number.isFinite(x));

describe('environment solver', () => {
  it('produces finite, sane numbers for every time of day and weather', async () => {
    for (const timeOfDay of TODS) {
      for (const weather of WEATHERS) {
        const s = await solveEnvironment({ timeOfDay, weather });
        const tag = `${timeOfDay}/${weather}`;
        expect(finite(s.sunDir), tag).toBe(true);
        expect(Math.hypot(...s.sunDir), tag).toBeCloseTo(1, 5);
        expect(finite(s.lightColor), tag).toBe(true);
        expect(Math.max(...s.lightColor), tag).toBeLessThanOrEqual(1.0001);
        expect(s.lightIntensity, tag).toBeGreaterThanOrEqual(0);
        expect(s.fogDensity, tag).toBeGreaterThan(0);
        expect(s.exposure, tag).toBeGreaterThan(0);
        expect(finite(s.fogTable), tag).toBe(true);
        expect(s.fogTable.length, tag).toBe(24);
        expect(finite(s.ground), tag).toBe(true);
        expect(finite(s.hemiSky), tag).toBe(true);
        expect(s.darkness, tag).toBeGreaterThanOrEqual(0);
        expect(s.darkness, tag).toBeLessThanOrEqual(1);
        expect(s.shadowIntensity, tag).toBeGreaterThanOrEqual(0);
      }
    }
  }, 60000);

  it('orders darkness: noon brightest, night darkest', async () => {
    const d = async (t: TimeOfDay) => (await solveEnvironment({ timeOfDay: t, weather: 'clear' })).darkness;
    expect(await d('noon')).toBe(0);
    expect(await d('night')).toBe(1);
    expect(await d('dusk')).toBeGreaterThan(await d('golden'));
    expect(await d('dawn')).toBeGreaterThan(await d('morning'));
  });

  it('makes the sun warmer and dimmer toward the horizon', async () => {
    const noon = await solveEnvironment({ timeOfDay: 'noon', weather: 'clear' });
    const golden = await solveEnvironment({ timeOfDay: 'golden', weather: 'clear' });
    const dusk = await solveEnvironment({ timeOfDay: 'dusk', weather: 'clear' });
    const br = (c: number[]) => c[2] / c[0];
    expect(br(golden.lightColor)).toBeLessThan(br(noon.lightColor));
    expect(br(dusk.lightColor)).toBeLessThan(br(golden.lightColor));
    expect(golden.lightIntensity).toBeLessThan(noon.lightIntensity);
    expect(golden.sunDir[1]).toBeLessThan(noon.sunDir[1]);
    // golden hour light is orange: r > g > b
    expect(golden.lightColor[0]).toBeGreaterThan(golden.lightColor[1]);
    expect(golden.lightColor[1]).toBeGreaterThan(golden.lightColor[2]);
  });

  it('overcast kills direct light, softens shadows and thickens fog', async () => {
    const clear = await solveEnvironment({ timeOfDay: 'noon', weather: 'clear' });
    const over = await solveEnvironment({ timeOfDay: 'noon', weather: 'overcast' });
    expect(over.lightIntensity).toBeLessThan(clear.lightIntensity * 0.2);
    expect(over.shadowIntensity).toBeLessThan(clear.shadowIntensity * 0.4);
    expect(over.fogDensity).toBeGreaterThan(clear.fogDensity);
    expect(over.sunRadiance[0]).toBeLessThan(clear.sunRadiance[0] * 0.2);
  });

  it('uses the moon at night: stars on, cool light, true sun below the horizon', async () => {
    const n = await solveEnvironment({ timeOfDay: 'night', weather: 'clear' });
    expect(n.stars).toBeGreaterThan(0.9);
    expect(n.lightColor[2]).toBeGreaterThan(n.lightColor[0]);
    expect(n.trueSunDir[1]).toBeLessThan(0);
    expect(n.sunDir[1]).toBeGreaterThan(0.3);
  });

  it('caches by (timeOfDay, weather)', async () => {
    const a = await solveEnvironment({ timeOfDay: 'morning', weather: 'cloudy' });
    const b = await solveEnvironment({ timeOfDay: 'morning', weather: 'cloudy' });
    expect(b).toBe(a);
  });
});
