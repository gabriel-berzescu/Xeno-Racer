import { describe, expect, it } from 'vitest';
import {
  computeSunVisibility,
  discShare,
  HAZE_TAPS,
  hazeSunShare,
  sampleSunVisibility,
  sunFrame,
  type SunTerrain,
  type SunVisField,
} from '../src/render/sunVisibility';

const DEG = Math.PI / 180;
/** The drawn sun's angular radius (sky.ts). */
const R = 0.0135;

/** Unit vector toward a sun at an elevation and an azimuth (degrees from +Z toward +X, like the time-of-day presets). */
function sun(elDeg: number, azDeg: number): [number, number, number] {
  const e = elDeg * DEG;
  const a = azDeg * DEG;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
}

/** Flat ground at 10 m with a long ridge across x = ridgeX (a Gaussian `h` m high and `width` m wide), running along z. */
function ridgeWorld(ridgeX: number, h: number, width = 60): SunTerrain {
  return {
    height: (x) => 10 + h * Math.exp(-(((x - ridgeX) / width) ** 2)),
    extent: { minX: -4000, maxX: 4000, minZ: -4000, maxZ: 4000 },
    focus: { minX: -300, maxX: 300, minZ: -300, maxZ: 300 },
  };
}

describe('sun visibility map: the horizon height', () => {
  it('a point behind a ridge is dark and a point above its shadow line is lit', async () => {
    // sun toward +X (azimuth 90) at 3 degrees; a 100 m ridge 1 km away stands 5.7 degrees high
    const f = await computeSunVisibility(ridgeWorld(1000, 100), sun(3, 90), R);
    expect(f.sunUp).toBe(true);
    expect(f.active).toBe(true);
    // the road at the foot of the hill, on the ground: in the shadow
    expect(sampleSunVisibility(f, 0, 10, 0)).toBe(0);
    expect(sampleSunVisibility(f, 0, 12, 40)).toBe(0);
    // the line of the ridge's top, through the sun's lower limb: 110 - 1000 tan(3 - 0.77 deg) = 71 m; well above it: sun
    expect(sampleSunVisibility(f, 0, 150, 0)).toBe(1);
    expect(sampleSunVisibility(f, 0, 110, 0)).toBe(1);
    // the sunward side of the ridge is in the open
    expect(sampleSunVisibility(f, 1300, 10, 0)).toBe(1);
    expect(sampleSunVisibility(f, 1150, 10, 0)).toBe(1);
  });

  it('the penumbra grows with the distance to the ridge, and rises monotonically with height', async () => {
    const f = await computeSunVisibility(ridgeWorld(1000, 100), sun(3, 90), R);
    // heights of the lit line (lower limb) and of the dark line (upper limb) at x = 0: Hlo, Hhi
    const hLo = 110 - 1000 * Math.tan(3 * DEG - R);
    const hHi = 110 - 1000 * Math.tan(3 * DEG + R);
    // (a ridge 1 km away: the disc is 1.55 degrees across, 27 m of height at that distance)
    expect(hLo - hHi).toBeGreaterThan(26);
    let prev = -1;
    let seen = 0;
    for (let y = hHi - 10; y < hLo + 10; y += 0.5) {
      const v = sampleSunVisibility(f, 0, y, 0);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
      if (v > 0.01 && v < 0.99) seen++;
    }
    expect(seen).toBeGreaterThan(40);
    // the midpoint of the penumbra sees half the disc
    expect(sampleSunVisibility(f, 0, (hLo + hHi) / 2 - 0.12, 0)).toBeCloseTo(0.5, 1);
    // closer to the ridge the lit line is higher, so a point at a fixed height is darker the nearer it stands
    let last = 2;
    for (const x of [-800, -400, 0, 400, 800, 950]) {
      const v = sampleSunVisibility(f, x, 60, 0);
      expect(v).toBeLessThanOrEqual(last + 1e-9);
      last = v;
    }
    // the penumbra of a ridge 100 m away is a hundredth of that of one at 1 km
    const near = await computeSunVisibility(ridgeWorld(100, 20), sun(3, 90), R);
    const nearLo = 30 - 100 * Math.tan(3 * DEG - R);
    const nearHi = 30 - 100 * Math.tan(3 * DEG + R);
    expect(nearLo - nearHi).toBeLessThan(6);
    expect(sampleSunVisibility(near, 0, nearHi - 1, 0)).toBe(0);
    expect(sampleSunVisibility(near, 0, nearLo + 1, 0)).toBe(1);
  });

  it('agrees with a march along the sun ray where a near bank and a far mountain set the two edges of the disc', async () => {
    // the road at the foot of a 6 m bank 60 m sunward, with a mountain 4.7 km behind it: the bank sets the dark edge, the mountain the light edge
    const world: SunTerrain = {
      height: (x) => 10 + 6 * Math.exp(-(((x - 60) / 9) ** 2)) + 300 * Math.exp(-(((x - 4700) / 500) ** 2)),
      extent: { minX: -4000, maxX: 7000, minZ: -4000, maxZ: 4000 },
      focus: { minX: -300, maxX: 300, minZ: -300, maxZ: 300 },
    };
    const E = 3.6 * DEG;
    const f = await computeSunVisibility(world, sun(3.6, 90), R);
    // the visible area of a disc of radius R above a horizon at angle `a` (rad), exactly
    const disc = (a: number): number => {
      const h = Math.max(-1, Math.min(1, (a - E) / R));
      return (Math.acos(h) - h * Math.sqrt(1 - h * h)) / Math.PI;
    };
    const march = (y: number): number => {
      let a = -Math.PI / 2;
      for (let u = 2; u < 9000; u += u < 400 ? 1 : 4) a = Math.max(a, Math.atan2(world.height(u, 0) - y, u));
      return disc(a);
    };
    let worst = 0;
    for (let y = 9; y < 120; y += 1.5) {
      worst = Math.max(worst, Math.abs(sampleSunVisibility(f, 0, y, 0) - march(y + 0.12)));
    }
    // (the disc area against a smoothstep is within 0.02; the rest is the two-line model against the true envelope)
    expect(worst).toBeLessThan(0.07);
    // a single-ridge model ("between the two limb heights") would have said the bank's penumbra is the mountain's: check that is not what the map does
    const road = sampleSunVisibility(f, 0, 10.6, 0);
    expect(Math.abs(road - march(10.72))).toBeLessThan(0.07);
  });

  it('a sun overhead lights everything, and the map is then switched off', async () => {
    const f = await computeSunVisibility(ridgeWorld(1000, 100), sun(80, 90), R);
    for (const [x, y] of [[0, 10], [900, 12], [1000, 100], [-500, 10]]) expect(sampleSunVisibility(f, x, y, 0)).toBe(1);
    expect(f.active).toBe(false);
    expect(f.shadedFine).toBe(0);
  });

  it('flat ground is lit at any elevation the disc is above the horizon, and dark below it', async () => {
    const flat: SunTerrain = { height: () => 5, extent: { minX: -2000, maxX: 2000, minZ: -2000, maxZ: 2000 }, focus: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 } };
    for (const el of [1.5, 4, 20, 60]) {
      const f = await computeSunVisibility(flat, sun(el, 37), R);
      expect(sampleSunVisibility(f, 12, 5, -30), `${el} deg`).toBe(1);
    }
    // the whole disc below the horizon: nothing is lit, wherever the point is
    const night = await computeSunVisibility(flat, sun(-1.6, 252), R);
    expect(night.sunUp).toBe(false);
    expect(sampleSunVisibility(night, 0, 1000, 0)).toBe(0);
    // half the disc above the horizon: the sun still counts
    expect((await computeSunVisibility(flat, sun(0.4, 252), R)).sunUp).toBe(true);
  });

  it('works for any azimuth of the sun (the grid is in the sun frame)', async () => {
    // a ridge 1 km from the origin toward the sun, whatever the sun's azimuth: rotate the world
    for (const az of [0, 33, 90, 145, 210, 262, 301]) {
      const a = az * DEG;
      const dx = Math.sin(a);
      const dz = Math.cos(a);
      const t: SunTerrain = {
        height: (x, z) => 10 + 100 * Math.exp(-((((x * dx + z * dz) - 1000) / 60) ** 2)),
        extent: { minX: -4000, maxX: 4000, minZ: -4000, maxZ: 4000 },
        focus: { minX: -300, maxX: 300, minZ: -300, maxZ: 300 },
      };
      const f = await computeSunVisibility(t, sun(3, az), R);
      expect(sampleSunVisibility(f, 0, 10, 0), `az ${az}`).toBe(0);
      expect(sampleSunVisibility(f, 0, 150, 0), `az ${az}`).toBe(1);
      expect(sampleSunVisibility(f, 1300 * dx, 10, 1300 * dz), `az ${az}`).toBe(1);
      // a hundred metres across the sun's line is the same shadow (the ridge is straight)
      expect(sampleSunVisibility(f, -100 * dz, 10, 100 * dx), `az ${az}`).toBe(0);
    }
  });

  it('is deterministic, and the fine grid joins the coarse one without a seam', async () => {
    const t = ridgeWorld(1500, 140);
    const a = await computeSunVisibility(t, sun(4, 90), R);
    const b = await computeSunVisibility(t, sun(4, 90), R);
    expect(Array.from(a.fine!.data.subarray(0, 4000))).toEqual(Array.from(b.fine!.data.subarray(0, 4000)));
    expect(a.coarse!.cell).toBeGreaterThan(a.fine!.cell * 5);
    // walk along a line across the fine grid's edge (x from -650 to -300, z from -440 to 440): no step bigger than the penumbra allows
    let prev = sampleSunVisibility(a, -900, 30, 0);
    let worst = 0;
    for (let x = -900; x <= 900; x += 1) {
      const v = sampleSunVisibility(a, x, 30, 0);
      worst = Math.max(worst, Math.abs(v - prev));
      prev = v;
    }
    expect(worst).toBeLessThan(0.02);
  });

  it('a hill that is lower than the sun is no shade at all', async () => {
    // 20 m hill 2 km away: 0.6 degrees; the sun's lower limb is at 8.5 - 0.77 degrees
    const f = await computeSunVisibility(ridgeWorld(2000, 20), sun(8.5, 90), R);
    expect(sampleSunVisibility(f, 0, 10, 0)).toBe(1);
    // (its own lee is in its shade, 120 m of it: nowhere near the circuit)
    expect(f.shadedFine).toBe(0);
    expect(sampleSunVisibility(f, 1930, 10, 0)).toBe(0);
    // and a flat world needs no map at all
    const flat: SunTerrain = { height: () => 5, extent: { minX: -2000, maxX: 2000, minZ: -2000, maxZ: 2000 }, focus: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 } };
    expect((await computeSunVisibility(flat, sun(8.5, 90), R)).active).toBe(false);
  });

  it('the disc share is a smoothstep between the two limbs (q = 0: the whole disc, q = 1: none of it)', () => {
    expect(discShare(-1)).toBe(1);
    expect(discShare(0)).toBe(1);
    expect(discShare(0.5)).toBe(0.5);
    expect(discShare(1)).toBe(0);
    expect(discShare(7)).toBe(0);
    for (let q = 0; q < 1; q += 0.05) expect(discShare(q + 0.05)).toBeLessThanOrEqual(discShare(q));
  });

  it('frames the sun by its azimuth', () => {
    const fr = sunFrame(sun(10, 90));
    expect(fr.ax).toBeCloseTo(1, 6);
    expect(fr.az).toBeCloseTo(0, 6);
    expect(fr.elevation).toBeCloseTo(10 * DEG, 6);
    expect(sunFrame([0, 1, 0]).elevation).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe('the haze: the sun part of the fog follows the sunlit share of the view ray', () => {
  const density = 2 / 9000;

  async function dusk(): Promise<SunVisField> {
    return computeSunVisibility(ridgeWorld(2400, 520, 400), sun(3, 90), R);
  }

  it('a ray that stays in the ridge shadow has no sun in-scatter, one in the open has all of it', async () => {
    const f = await dusk();
    // from the road toward the ridge, a little above the ground: the whole way in shade
    const shaded = hazeSunShare(f, 0, 12, 0, 1, 0, 0, 2400, 2400, density, 0);
    expect(shaded).toBe(0);
    // from the sunward side of the ridge, or in a world with no hill, the ray is in the sun: the old fog colour
    expect(hazeSunShare(f, 3000, 12, 0, 1, 0, 0, 1500, 1500, density, 0)).toBe(1);
    const open = await computeSunVisibility(ridgeWorld(2400, 5, 40), sun(3, 90), R);
    expect(hazeSunShare(open, 0, 12, 0, 1, 0, 0, 2400, 2400, density, 0)).toBe(1);
  });

  it('a ray that climbs out of the shadow is lit for the part beyond its shadow line, and brighter the steeper it climbs', async () => {
    const f = await dusk();
    let prev = -1;
    for (const el of [0, 4, 8, 11, 12.2, 13, 16, 24]) {
      const e = el * DEG;
      const share = hazeSunShare(f, 0, 12, 0, Math.cos(e), Math.sin(e), 0, 6000 * Math.cos(e), 6000, density, 0);
      expect(share).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = share;
    }
    expect(prev).toBeGreaterThan(0.9);
  });

  it('too little fog to see changes nothing, and the taps are spread by the fog they carry', async () => {
    const f = await dusk();
    expect(hazeSunShare(f, 0, 12, 0, 1, 0, 0, 3, 3, density, 0)).toBe(1);
    expect(HAZE_TAPS).toBeGreaterThanOrEqual(4);
    // rain haze (Beer-Lambert) moves the taps nearer, never out of range
    const share = hazeSunShare(f, 0, 12, 0, 1, 0, 0, 2400, 2400, density, 0.0016);
    expect(share).toBeGreaterThanOrEqual(0);
    expect(share).toBeLessThanOrEqual(1);
  });
});
