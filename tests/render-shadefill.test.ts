import { describe, expect, it } from 'vitest';
import type { TimeOfDay, Weather } from '../src/core/contracts';
import { solveEnvironment } from '../src/render/environment';
import { coveredByShade, FILL_AWAY_SIDE, FILL_AWAY_VIEW, FILL_SUN_SIDE, fillViewScale, shadeFillLook, sunSlant } from '../src/render/shadeFill';
import { computeSunVisibility, sampleSunVisibility, type SunTerrain } from '../src/render/sunVisibility';

const TODS: TimeOfDay[] = ['dawn', 'morning', 'noon', 'golden', 'dusk', 'night'];
const WEATHERS: Weather[] = ['clear', 'cloudy', 'overcast', 'rain', 'storm'];
const lum = (c: readonly number[]): number => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
const DEG = Math.PI / 180;

function sun(elDeg: number, azDeg: number): [number, number, number] {
  const e = elDeg * DEG;
  const a = azDeg * DEG;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
}

describe('the shade fill: what the terrain takes of the sun, given back as soft light', () => {
  it('is the share `gain` of the sun a surface at an average slant loses, as the mean of what the hemisphere light gives over the sphere', async () => {
    const s = await solveEnvironment({ timeOfDay: 'golden', weather: 'clear' });
    const input = { lightColor: s.lightColor, lightIntensity: s.lightIntensity, glow: [s.fogTable[0], s.fogTable[1], s.fogTable[2]] as const, sunDir: s.sunDir, gain: 0.7 };
    const look = shadeFillLook(input);
    const lost = (lum(s.lightColor) * s.lightIntensity * sunSlant(s.sunDir[1])) / Math.PI;
    // the mean outgoing luminance of a white diffuse surface over every orientation (three's hemisphere light: mix(ground, sky, 0.5 n.axis + 0.5), over pi)
    const axis = look.axis;
    const al = Math.hypot(axis[0], axis[1], axis[2]);
    let sum = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n;
      const r = Math.sqrt(1 - y * y);
      const phi = i * Math.PI * (3 - Math.sqrt(5));
      const dot = (r * Math.cos(phi) * axis[0] + y * axis[1] + r * Math.sin(phi) * axis[2]) / al;
      const w = 0.5 * dot + 0.5;
      const irr = [0, 1, 2].map((c) => look.ground[c] + (look.sky[c] - look.ground[c]) * w);
      sum += lum(irr) / Math.PI;
    }
    expect(sum / n).toBeCloseTo(0.7 * lost, 3);
    // spread 1.6 : 0.4, a quarter of it on the side that turns from the sun
    expect(lum(look.sky) / lum(look.ground)).toBeCloseTo(FILL_SUN_SIDE / FILL_AWAY_SIDE, 5);
  });

  it('gives back less of a sun that stood low: it hardly lit the ground even when it shone', () => {
    // the slant of what a racing picture shows: the ground catches sin(elevation), what stands on it about a quarter
    expect(sunSlant(Math.sin(1 * DEG))).toBeLessThan(sunSlant(Math.sin(4 * DEG)));
    expect(sunSlant(Math.sin(4 * DEG))).toBeLessThan(sunSlant(Math.sin(8.5 * DEG)));
    expect(sunSlant(Math.sin(8.5 * DEG))).toBeLessThan(sunSlant(Math.sin(30 * DEG)));
    expect(sunSlant(Math.sin(70 * DEG))).toBeLessThanOrEqual(0.5);
    expect(sunSlant(-0.2)).toBeGreaterThan(0);
  });

  it('is nothing where there is no sun to give back or no gain, and follows the gain linearly', async () => {
    const s = await solveEnvironment({ timeOfDay: 'golden', weather: 'clear' });
    const base = { lightColor: s.lightColor, lightIntensity: s.lightIntensity, glow: [s.fogTable[0], s.fogTable[1], s.fogTable[2]] as const, sunDir: s.sunDir, gain: 1 };
    const none = shadeFillLook({ ...base, lightIntensity: 0 });
    expect(none.sky).toEqual([0, 0, 0]);
    expect(none.ground).toEqual([0, 0, 0]);
    expect(shadeFillLook({ ...base, gain: 0 }).sky).toEqual([0, 0, 0]);
    const one = shadeFillLook(base);
    const two = shadeFillLook({ ...base, gain: 2 });
    for (let c = 0; c < 3; c++) expect(two.sky[c]).toBeCloseTo(2 * one.sky[c], 9);
    // the sun at winter's blue hour is below the horizon: its light is 0, and so is the fill
    const w = await solveEnvironment({ timeOfDay: 'dusk', weather: 'clear', winter: true });
    expect(w.lightIntensity).toBe(0);
    expect(shadeFillLook({ lightColor: w.lightColor, lightIntensity: w.lightIntensity, glow: [w.fogTable[0], w.fogTable[1], w.fogTable[2]], sunDir: w.sunDir, gain: 1 }).sky).toEqual([0, 0, 0]);
  });

  it('faces the glow: its axis points at the sun and a little up, and its colour is warmer than the sky overhead', async () => {
    for (const tod of ['dawn', 'golden', 'dusk'] as const) {
      const s = await solveEnvironment({ timeOfDay: tod, weather: 'clear' });
      const look = shadeFillLook({ lightColor: s.lightColor, lightIntensity: s.lightIntensity, glow: [s.fogTable[0], s.fogTable[1], s.fogTable[2]], sunDir: s.sunDir, gain: 0.7 });
      const hl = Math.hypot(s.sunDir[0], s.sunDir[2]);
      expect(look.axis[0] * (s.sunDir[0] / hl) + look.axis[2] * (s.sunDir[2] / hl), tod).toBeGreaterThan(0.9);
      expect(look.axis[1], tod).toBeGreaterThan(0);
      // warmer than the ambient light the shade has otherwise (red over blue, against the sky's)
      expect(look.sky[0] / look.sky[2], tod).toBeGreaterThan(s.skyAmbient[0] / s.skyAmbient[2]);
      // never a deep red: a quarter of the way to grey, so that the road is not painted with it
      expect(look.sky[1] / look.sky[0], tod).toBeGreaterThan(0.3);
    }
  });

  it('is finite and never negative for every time of day and weather', async () => {
    for (const timeOfDay of TODS) {
      for (const weather of WEATHERS) {
        const s = await solveEnvironment({ timeOfDay, weather });
        const look = shadeFillLook({ lightColor: s.lightColor, lightIntensity: s.lightIntensity, glow: [s.fogTable[0], s.fogTable[1], s.fogTable[2]], sunDir: s.sunDir, gain: 0.7 });
        for (const v of [...look.sky, ...look.ground, ...look.axis]) expect(Number.isFinite(v), `${timeOfDay}/${weather}`).toBe(true);
        for (const v of [...look.sky, ...look.ground]) expect(v, `${timeOfDay}/${weather}`).toBeGreaterThanOrEqual(0);
      }
    }
  }, 120000);
});

describe('the fill follows where the camera looks', () => {
  it('is whole looking at the sun, FILL_AWAY_VIEW of it looking away, and monotonic in between', () => {
    // the sun toward +X: a camera looking along +X looks at it, along -X away from it
    expect(fillViewScale(1, 0, 1, 0)).toBeCloseTo(1, 9);
    expect(fillViewScale(-1, 0, 1, 0)).toBeCloseTo(FILL_AWAY_VIEW, 9);
    expect(fillViewScale(0, 1, 1, 0)).toBeGreaterThan(FILL_AWAY_VIEW);
    expect(fillViewScale(0, 1, 1, 0)).toBeLessThan(1);
    let prev = 0;
    for (let a = 180; a >= 0; a -= 5) {
      const r = (a * Math.PI) / 180;
      const s = fillViewScale(Math.cos(r), Math.sin(r), 1, 0);
      expect(s, `${a} degrees from the sun`).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = s;
    }
    // symmetric: left or right of the sun is the same, and a longer vector means nothing
    expect(fillViewScale(0.3, 0.4, 1, 0)).toBeCloseTo(fillViewScale(0.3, -0.4, 1, 0), 12);
    expect(fillViewScale(3, 4, 2, 0)).toBeCloseTo(fillViewScale(0.6, 0.8, 1, 0), 12);
    // the pitch does not count (only the two horizontal components do), and a camera pointing straight up has no side: the middle
    expect(fillViewScale(0, 0, 1, 0)).toBeCloseTo((1 + FILL_AWAY_VIEW) / 2, 9);
    expect(fillViewScale(1, 0, 0, 0)).toBeCloseTo((1 + FILL_AWAY_VIEW) / 2, 9);
  });
});

describe('the cascades while the terrain hides the sun', () => {
  const world = (ridgeX: number, h: number): SunTerrain => ({
    height: (x) => 10 + h * Math.exp(-(((x - ridgeX) / 80) ** 2)),
    extent: { minX: -4000, maxX: 4000, minZ: -4000, maxZ: 4000 },
    focus: { minX: -300, maxX: 300, minZ: -300, maxZ: 300 },
  });

  it('are not needed where the ridge hides the sun from the whole ring they cover, and are where any part of it is lit', async () => {
    // sun toward +X at 3 degrees; a 200 m ridge 1.2 km away is 9.5 degrees high
    const f = await computeSunVisibility(world(1200, 200), sun(3, 90), 0.0135);
    const vis = (x: number, y: number, z: number): number => sampleSunVisibility(f, x, y, z);
    // the car at the foot of the ridge, the tallest caster 55 m up: all of it, and the ring 150 m around, in the shade
    expect(coveredByShade(vis, 0, 10 + 55, 0, 150)).toBe(true);
    // a car whose ring reaches the sunward side of the ridge (the ground beyond it is in the open)
    expect(coveredByShade(vis, 1150, 10 + 55, 0, 150)).toBe(false);
    // up high enough the sun shows over the ridge: not in the shade
    expect(coveredByShade(vis, 0, 400, 0, 150)).toBe(false);
    // the threshold is the share of the disc that counts as sun: in the middle of the penumbra a hundredth of it is far exceeded, and the whole of it never is
    const mid = 10 + 200 - 1200 * Math.tan(3 * DEG) + 5;
    expect(vis(0, mid, 0)).toBeGreaterThan(0.01);
    expect(coveredByShade(vis, 0, mid, 0, 100)).toBe(false);
    expect(coveredByShade(vis, 0, mid, 0, 100, 1)).toBe(true);
  });
});
