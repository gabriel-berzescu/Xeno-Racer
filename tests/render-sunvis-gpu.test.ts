/**
 * The GPU side of the sun visibility map, without a GPU: the atlas SunVisMap lays out and the uniforms it writes are read back by a TS
 * transcription of the GLSL (xrSunVisAt in shaderPatches.ts: the same lookups, the same fade between the grids, the same maths) and
 * must give what the CPU sampler gives. This is what catches a wrong offset, a swapped row, a half-texel slip in the packing.
 */
import { describe, expect, it } from 'vitest';
import type { TerrainSource } from '../src/core/systems';
import { installShaderPatches, SUNVIS_PARS, sunVisTexture, xrSunVisUniform } from '../src/render/shaderPatches';
import { SunVisMap } from '../src/render/sunVisMap';
import { sampleSunVisibility, sunFrame } from '../src/render/sunVisibility';

const DEG = Math.PI / 180;
const R = 0.0135;

function sun(elDeg: number, azDeg: number): [number, number, number] {
  const e = elDeg * DEG;
  const a = azDeg * DEG;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)];
}

/** Hills: two ridges and a bank, so that the maps have shade, penumbrae and more than one occluder. */
function hills(): TerrainSource {
  return {
    id: 'test-hills',
    height: (x, z) => 20 + 140 * Math.exp(-(((x * 0.6 + z * 0.8 - 1800) / 220) ** 2)) + 60 * Math.exp(-(((x - 900) / 300) ** 2 + ((z + 400) / 500) ** 2)) + 5 * Math.exp(-(((x - 70) / 14) ** 2)),
    extent: { minX: -5000, maxX: 5000, minZ: -5000, maxZ: 5000 },
    focus: { minX: -300, maxX: 300, minZ: -300, maxZ: 300 },
  };
}

const fakeRenderer = { extensions: { has: (n: string): boolean => n === 'OES_texture_float_linear' } } as unknown as ConstructorParameters<typeof SunVisMap>[0];

/** `texture( xrSunVisTex, uv )` on an RGBA32F texture with LinearFilter and clamp-to-edge: bilinear between texel centres. */
function texel(data: Float32Array, w: number, h: number, u: number, v: number): [number, number, number, number] {
  const tx = u * w - 0.5;
  const ty = v * h - 0.5;
  const x0 = Math.floor(tx);
  const y0 = Math.floor(ty);
  const fx = tx - x0;
  const fy = ty - y0;
  const at = (x: number, y: number, c: number): number => data[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4 + c];
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) out[c] = (at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx) * (1 - fy) + (at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx) * fy;
  return out;
}

/** xrSunVisAt, line by line. */
function glslSunVisAt(x: number, y: number, z: number): number {
  const U = xrSunVisUniform.value;
  const tex = sunVisTexture.image as { data: Float32Array; width: number; height: number };
  const vec = (i: number): number[] => [U[i * 4], U[i * 4 + 1], U[i * 4 + 2], U[i * 4 + 3]];
  const s0 = vec(0);
  if (s0[3] <= 0) return 1;
  if (vec(5)[3] > 0.5) return 1 - s0[3];
  const u = x * s0[0] + z * s0[1];
  const v = x * -s0[1] + z * s0[0];
  const a = vec(1);
  const ffx = u * a[0] + a[1];
  const ffy = v * a[0] + a[2];
  const f2 = vec(2);
  const e = Math.min(Math.min(ffx, f2[0] - ffx), Math.min(ffy, f2[1] - ffy));
  const inv = vec(5);
  let n: number[];
  if (a[0] > 0 && e >= 0) {
    n = texel(tex.data, tex.width, tex.height, (ffx + f2[2]) * inv[0], (ffy + f2[3]) * inv[1]);
    const wf = Math.min(1, Math.max(0, e * a[3]));
    if (wf < 1) {
      const c3 = vec(3);
      const c4 = vec(4);
      const nc = texel(tex.data, tex.width, tex.height, (u * c3[0] + c3[1] + c4[2]) * inv[0], (v * c3[0] + c3[2] + c4[3]) * inv[1]);
      const s = wf * wf * (3 - 2 * wf);
      n = n.map((q, i) => nc[i] + (q - nc[i]) * s);
    }
  } else {
    const b = vec(3);
    const c4 = vec(4);
    const fcx = u * b[0] + b[1];
    const fcy = v * b[0] + b[2];
    if (Math.min(Math.min(fcx, c4[0] - fcx), Math.min(fcy, c4[1] - fcy)) < 0) return 1;
    n = texel(tex.data, tex.width, tex.height, (fcx + c4[2]) * inv[0], (fcy + c4[3]) * inv[1]);
  }
  const yy = y + inv[2] - s0[2];
  const q = Math.max((n[0] - yy) * n[2], 1 + (n[1] - yy) * n[3]);
  const c = 1 - Math.min(1, Math.max(0, q));
  return 1 + (c * c * (3 - 2 * c) - 1) * s0[3];
}

describe('the sun visibility atlas and uniforms', () => {
  it('give the shader what the CPU sampler gives, over the fine grid, its blended edge and the coarse grid', async () => {
    const map = new SunVisMap(fakeRenderer);
    for (const [el, az] of [[3.5, 80], [8.5, 262], [0.9, 285], [5, 20]] as const) {
      await map.update(hills(), sun(el, az), R);
      map.setWeather(1);
      expect(map.field?.active, `${el}/${az}`).toBe(true);
      expect(xrSunVisUniform.value[3]).toBe(1);
      let worst = 0;
      let lit = 0;
      let dark = 0;
      let n = 0;
      // a spread of points: inside the circuit, around it (the blended edge of the fine grid), and far out (the coarse grid and past its end)
      for (let i = 0; i < 4000; i++) {
        const r = i < 1500 ? 300 : i < 3000 ? 700 : 5500;
        const x = Math.sin(i * 12.9898) * r * 1.3;
        const z = Math.cos(i * 78.233) * r;
        for (const y of [0, 22, 60, 200]) {
          const gpu = glslSunVisAt(x, y, z);
          const cpu = map.visibilityAt(x, y, z);
          worst = Math.max(worst, Math.abs(gpu - cpu));
          if (cpu > 0.99) lit++;
          if (cpu < 0.01) dark++;
          n++;
        }
      }
      // (the uniforms and the atlas are 32-bit floats, and the share changes by up to 14 per metre of height at the near edge of a bank: a few 1e-4 is rounding)
      expect(worst, `${el}/${az}`).toBeLessThan(5e-4);
      // (the comparison means something only where there is something to compare: shade, sun, and a penumbra between)
      expect(lit).toBeGreaterThan(n * 0.05);
      if (el < 10) expect(dark).toBeGreaterThan(n * 0.02);
    }
  });

  it('are the CPU sampler too: the share the shader reads is the one sampleSunVisibility computes before the weather', async () => {
    const map = new SunVisMap(fakeRenderer);
    await map.update(hills(), sun(5, 70), R);
    map.setWeather(1);
    const f = map.field!;
    for (let i = 0; i < 200; i++) {
      const x = Math.sin(i * 3.7) * 400;
      const z = Math.cos(i * 1.9) * 400;
      expect(map.visibilityAt(x, 40, z)).toBeCloseTo(sampleSunVisibility(f, x, 40, z), 6);
    }
  });

  it('let the weather through by its sun shadow strength: none under a rain deck, all of it in a clear sky', async () => {
    const map = new SunVisMap(fakeRenderer);
    // (a sun at 2 degrees: the ridge, 3.25 degrees high from here, hides its whole disc)
    await map.update(hills(), sun(2, 80), R);
    const f = map.field!;
    // a point in the shade of the ridge
    let px = 0;
    let pz = 0;
    for (let i = 0; i < 400 && sampleSunVisibility(f, px, 25, pz) > 0.01; i++) {
      px = Math.sin(i * 2.1) * 250;
      pz = Math.cos(i * 1.3) * 250;
    }
    expect(sampleSunVisibility(f, px, 25, pz)).toBeLessThan(0.01);
    map.setWeather(1);
    expect(map.visibilityAt(px, 25, pz)).toBeLessThan(0.01);
    expect(glslSunVisAt(px, 25, pz)).toBeLessThan(0.01);
    map.setWeather(0.5);
    expect(map.visibilityAt(px, 25, pz)).toBeCloseTo(0.5, 1);
    expect(glslSunVisAt(px, 25, pz)).toBeCloseTo(0.5, 1);
    map.setWeather(0);
    expect(map.visibilityAt(px, 25, pz)).toBe(1);
    expect(map.on).toBe(false);
    // the shader's switch: strength 0 is the old picture, with no lookup at all
    expect(xrSunVisUniform.value[3]).toBe(0);
    expect(glslSunVisAt(px, 25, pz)).toBe(1);
  });

  it('are switched off where the sun is seen from everywhere (a high sun over low hills): the old picture, bit for bit', async () => {
    const map = new SunVisMap(fakeRenderer);
    map.setWeather(1);
    await map.update(hills(), sun(63, 200), R);
    expect(map.field?.active).toBe(false);
    expect(map.on).toBe(false);
    expect(xrSunVisUniform.value[3]).toBe(0);
    for (const [x, y, z] of [[0, 20, 0], [900, 20, -400], [-1800, 30, 200]]) {
      expect(map.visibilityAt(x, y, z)).toBe(1);
      expect(glslSunVisAt(x, y, z)).toBe(1);
    }
  });

  it('say "dark" without a lookup while the whole disc is below the horizon, and stay unmade for a map that is not needed', async () => {
    const map = new SunVisMap(fakeRenderer);
    map.setWeather(1);
    await map.update(hills(), sun(-1.6, 252), R);
    expect(map.field?.sunUp).toBe(false);
    expect(map.visibilityAt(0, 500, 0)).toBe(0);
    expect(glslSunVisAt(0, 500, 0)).toBe(0);
    // the same terrain and sun again: the map in use is kept (no second pass over the terrain)
    const before = map.field;
    await map.update(hills(), sun(-1.6, 252), R);
    expect(map.field).toBe(before);
    // no terrain: no map
    await map.update(null, sun(3, 80), R);
    expect(map.field).toBeNull();
    expect(map.visibilityAt(0, 0, 0)).toBe(1);
  });

  it('hands the whole texture to every material by sharing it (clone() answers with itself)', () => {
    installShaderPatches();
    expect(sunVisTexture.clone()).toBe(sunVisTexture);
    expect(SUNVIS_PARS).toContain('uniform sampler2D xrSunVisTex;');
    const f = sunFrame(sun(8.5, 262));
    expect(f.elevation).toBeCloseTo(8.5 * DEG, 6);
  });
});
