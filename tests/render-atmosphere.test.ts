import { describe, expect, it } from 'vitest';
import { computeSkyModel, lutElevation, lutPhi, lutU, lutV, sunTransmittance } from '../src/render/atmosphere';

const deg = Math.PI / 180;

describe('sky LUT parameterisation', () => {
  it('round-trips elevation and azimuth', () => {
    for (const el of [-0.05, 0, 0.02, 0.3, 1.0, Math.PI / 2]) expect(lutElevation(lutV(el))).toBeCloseTo(el, 6);
    for (const phi of [0, 0.01, 0.5, 2, Math.PI]) expect(lutPhi(lutU(phi))).toBeCloseTo(phi, 6);
  });
});

describe('atmosphere model', () => {
  it('has a blue noon sky and a neutral-warm sun', async () => {
    const m = await computeSkyModel({ sunElevation: 60 * deg });
    // blue dominates the zenith
    expect(m.zenith[2]).toBeGreaterThan(m.zenith[0] * 1.5);
    expect(m.zenith[2]).toBeGreaterThan(m.zenith[1]);
    // sun barely reddened at noon
    const t = m.sunTransmittance;
    expect(t[0]).toBeGreaterThan(0.7);
    expect(t[2]).toBeGreaterThan(0.4);
    expect(t[0]).toBeGreaterThan(t[2]);
  });

  it('reddens the sun toward the horizon', async () => {
    const hi = sunTransmittance(60 * deg);
    const mid = sunTransmittance(10 * deg);
    const low = sunTransmittance(1 * deg);
    expect(mid[2] / mid[0]).toBeLessThan(hi[2] / hi[0]);
    expect(low[2] / low[0]).toBeLessThan(mid[2] / mid[0]);
    expect(low[0]).toBeLessThan(hi[0]);
    // below the horizon the planet blocks the sun
    expect(sunTransmittance(-5 * deg)).toEqual([0, 0, 0]);
  });

  it('is brighter toward the sun at the horizon during golden hour', async () => {
    const m = await computeSkyModel({ sunElevation: 9 * deg });
    const lum = (c: number[]) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
    expect(lum(m.horizonSun)).toBeGreaterThan(lum(m.horizonAway) * 1.5);
    expect(m.fogTable.length).toBe(24);
    // the fog table must be brightest toward the sun at golden hour
    expect(m.fogTable[0] + m.fogTable[1]).toBeGreaterThan(m.fogTable[21] + m.fogTable[22]);
  });

  it('finite and positive everywhere', async () => {
    const m = await computeSkyModel({ sunElevation: 3 * deg, width: 64, height: 32 });
    for (let i = 0; i < m.lut.length; i++) {
      expect(Number.isFinite(m.lut[i])).toBe(true);
      expect(m.lut[i]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('print values (informational)', () => {
  it('dumps', async () => {
    const fmt = (c: number[]) => c.map((x) => x.toFixed(4)).join(', ');
    for (const el of [64, 24, 9, 3, 0.8, -2.5]) {
      const t0 = performance.now();
      const m = await computeSkyModel({ sunElevation: el * deg });
      const ms = performance.now() - t0;
      console.log(`sunEl ${el}: ${ms.toFixed(0)}ms zenith [${fmt(m.zenith)}] hSun [${fmt(m.horizonSun)}] hAway [${fmt(m.horizonAway)}] meanCos [${fmt(m.skyMeanCos)}] T [${fmt(m.sunTransmittance)}]`);
    }
  });
});
