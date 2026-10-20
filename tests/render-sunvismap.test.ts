import { describe, expect, it } from 'vitest';
import type { WebGLRenderer } from 'three';
import type { TerrainSource } from '../src/core/systems';
import { xrSunVisUniform } from '../src/render/shaderPatches';
import { SunVisMap } from '../src/render/sunVisMap';
import { SHADE_HAZE_GLOW } from '../src/render/sunVisibility';

const DEG = Math.PI / 180;
const R = 0.0135;

function sun(elDeg: number, azDeg: number): [number, number, number] {
  const e = elDeg * DEG;
  const a = azDeg * DEG;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
}

/** A circuit on flat ground with a ridge across x = 1000: toward +X at 3 degrees the sun is behind it for everything within a kilometre or so. */
function ridge(id: string, h = 100): TerrainSource {
  return {
    id,
    height: (x) => 10 + h * Math.exp(-(((x - 1000) / 60) ** 2)),
    extent: { minX: -4000, maxX: 4000, minZ: -4000, maxZ: 4000 },
    focus: { minX: -300, maxX: 300, minZ: -300, maxZ: 300 },
  };
}

/** The renderer is only asked what the GPU filters (the half-float fallback); the atlas is data until a draw uploads it. */
function map(floatLinear = true): SunVisMap {
  return new SunVisMap({ extensions: { has: () => floatLinear } } as unknown as WebGLRenderer);
}

describe('the sun visibility map of a race', () => {
  it('is made for a circuit and a sun, answers like the shaders, and is kept for the next call with the same pair', async () => {
    const m = map();
    expect(m.on).toBe(false);
    expect(m.visibilityAt(0, 10, 0)).toBe(1);
    await m.update(ridge('a'), sun(3, 90), R);
    expect(m.field?.active).toBe(true);
    expect(m.on).toBe(true);
    expect(m.lastMs).toBeGreaterThan(0);
    expect(m.atlas.bytes).toBeGreaterThan(0);
    expect(m.visibilityAt(0, 10, 0)).toBe(0);
    expect(m.visibilityAt(0, 160, 0)).toBe(1);
    // the same circuit and sun: not made again
    const f = m.field;
    await m.update(ridge('a'), sun(3, 90), R);
    expect(m.field).toBe(f);
    // another hour on the same circuit is another map
    await m.update(ridge('a'), sun(40, 90), R);
    expect(m.field).not.toBe(f);
    expect(m.field?.active).toBe(false);
    expect(m.on).toBe(false);
    expect(m.visibilityAt(0, 10, 0)).toBe(1);
  });

  it('says nothing about a circuit while the next one is made, and nothing once it is unloaded', async () => {
    const m = map();
    await m.update(ridge('a'), sun(3, 90), R);
    expect(m.on).toBe(true);
    const next = m.update(ridge('b', 60), sun(3, 90), R);
    // (the old map was made for another ground: no shade from it while the new one is on its way)
    expect(m.field).toBeNull();
    expect(m.on).toBe(false);
    expect(xrSunVisUniform.value[3]).toBe(0);
    await next;
    expect(m.on).toBe(true);
    await m.update(null, sun(3, 90), R);
    expect(m.field).toBeNull();
    expect(m.on).toBe(false);
    expect(xrSunVisUniform.value[3]).toBe(0);
  });

  it('a newer call overtakes an older one in progress', async () => {
    const m = map();
    let slices = 0;
    // an old map that is made slowly (ground that takes a moment to ask, and a yield between the slices of work) and a new one asked for meanwhile
    const old = ridge('slow');
    const ground = old.height;
    let spin = 0;
    old.height = (x, z) => {
      for (let k = 0; k < 400; k++) spin += Math.sqrt(k + 1 + Math.abs(x) * 1e-9);
      return ground(x, z);
    };
    const slow = m.update(old, sun(3, 90), R, async () => {
      slices++;
      await new Promise((r) => setTimeout(r, 1));
    });
    // (a 20 m ridge a kilometre away is 1.1 degrees high: the sun at 3 degrees clears it from the road, the slow map's 100 m one does not)
    const fast = m.update(ridge('fast', 20), sun(3, 90), R);
    await Promise.all([slow, fast]);
    expect(slices).toBeGreaterThan(0);
    expect(spin).toBeGreaterThan(0);
    // the map in use is the one asked for last
    expect(m.field).not.toBeNull();
    expect(m.field?.active).toBe(false);
    expect(m.visibilityAt(0, 10, 0)).toBe(1);
  });

  it('survives a terrain that fails: no stale shade, and the next call makes its map', async () => {
    const m = map();
    await m.update(ridge('a'), sun(3, 90), R);
    expect(m.on).toBe(true);
    const bad: TerrainSource = { ...ridge('bad'), height: () => { throw new Error('no ground'); } };
    await expect(m.update(bad, sun(3, 90), R)).rejects.toThrow('no ground');
    // (the map of the circuit before it is not this one's: gone, and the shaders were told)
    expect(m.field).toBeNull();
    expect(m.on).toBe(false);
    expect(xrSunVisUniform.value[3]).toBe(0);
    // and asking again for the same pair is not mistaken for work in progress
    await m.update(ridge('bad'), sun(3, 90), R);
    expect(m.on).toBe(true);
    expect(m.visibilityAt(0, 10, 0)).toBe(0);
  });

  it('lets the weather through as it likes: a rain deck casts no shade, an overcast sky a faint one', async () => {
    const m = map();
    await m.update(ridge('a'), sun(3, 90), R);
    expect(xrSunVisUniform.value[3]).toBe(1);
    m.setWeather(0.5);
    expect(m.on).toBe(true);
    expect(xrSunVisUniform.value[3]).toBe(0.5);
    expect(m.visibilityAt(0, 10, 0)).toBeCloseTo(0.5, 9);
    expect(m.visibilityAt(0, 160, 0)).toBe(1);
    m.setWeather(0);
    expect(m.on).toBe(false);
    expect(xrSunVisUniform.value[3]).toBe(0);
    expect(m.visibilityAt(0, 10, 0)).toBe(1);
    m.setWeather(7);
    expect(m.on).toBe(true);
    expect(xrSunVisUniform.value[3]).toBe(1);
  });

  it('keeps the glow of the shadowed haze in the uniform block, clamped to 0..1', async () => {
    const m = map();
    expect(m.hazeGlow).toBe(SHADE_HAZE_GLOW);
    await m.update(ridge('a'), sun(3, 90), R);
    expect(xrSunVisUniform.value[24]).toBeCloseTo(SHADE_HAZE_GLOW, 7);
    m.hazeGlow = 0.6;
    expect(xrSunVisUniform.value[24]).toBeCloseTo(0.6, 7);
    m.hazeGlow = 9;
    expect(m.hazeGlow).toBe(1);
    m.hazeGlow = -1;
    expect(m.hazeGlow).toBe(0);
  });

  it('is made of half floats where the GPU does not filter 32-bit ones, and answers the same', async () => {
    const full = map(true);
    const half = map(false);
    await full.update(ridge('a'), sun(3, 90), R);
    await half.update(ridge('a'), sun(3, 90), R);
    // (the CPU's grids read the atlas in place, half the bytes of it)
    expect(half.atlas.bytes).toBe(full.atlas.bytes / 2);
    expect(half.on).toBe(true);
    expect(half.visibilityAt(0, 10, 0)).toBe(0);
    expect(half.visibilityAt(0, 160, 0)).toBe(1);
  });

  it('a sun below the horizon is the dark sun: everything in shade without a lookup, and nothing for the moon at night', async () => {
    const m = map();
    await m.update(ridge('a'), sun(-2, 90), R);
    expect(m.field?.sunUp).toBe(false);
    expect(m.on).toBe(true);
    expect(m.visibilityAt(0, 500, 0)).toBe(0);
    expect(xrSunVisUniform.value[23]).toBe(1);
    // the light-casting body of a night is the moon at 42 degrees: no hill hides it from a circuit, the map is idle
    await m.update(ridge('a'), sun(42, 150), R);
    expect(m.on).toBe(false);
    expect(m.visibilityAt(0, 10, 0)).toBe(1);
  });
});
