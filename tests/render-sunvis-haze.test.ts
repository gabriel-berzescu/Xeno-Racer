import { ShaderChunk, ShaderLib, UniformsLib } from 'three';
import { describe, expect, it } from 'vitest';
import type { TimeOfDay, Weather } from '../src/core/contracts';
import { FOG_TABLE_SIZE } from '../src/render/atmosphere';
import { blendInto, cloneSolution, solveEnvironment } from '../src/render/environment';
import { installShaderPatches, sunVisTexture, xrFogSunUniform, xrSunVisTexUniform, xrSunVisUniform } from '../src/render/shaderPatches';
import { SHADE_HAZE_GLOW, sunlitHaze } from '../src/render/sunVisibility';

const TODS: TimeOfDay[] = ['dawn', 'morning', 'noon', 'golden', 'dusk', 'night'];
const WEATHERS: Weather[] = ['clear', 'cloudy', 'overcast', 'rain', 'storm'];
const chunks = () => ShaderChunk as unknown as Record<string, string>;
const lum = (a: Float32Array, k: number): number => a[k * 3] * 0.2126 + a[k * 3 + 1] * 0.7152 + a[k * 3 + 2] * 0.0722;

describe("the haze split into the sun's in-scatter and the sky's", () => {
  it('is part of every solution: never more than the haze itself, never negative, finite', async () => {
    for (const winter of [false, true]) {
      for (const timeOfDay of TODS) {
        for (const weather of WEATHERS) {
          const s = await solveEnvironment({ timeOfDay, weather, winter });
          const tag = `${winter ? 'winter ' : ''}${timeOfDay}/${weather}`;
          expect(s.fogTableSun.length, tag).toBe(FOG_TABLE_SIZE * 3);
          for (let i = 0; i < s.fogTable.length; i++) {
            expect(Number.isFinite(s.fogTableSun[i]), tag).toBe(true);
            expect(s.fogTableSun[i], tag).toBeGreaterThanOrEqual(0);
            expect(s.fogTableSun[i], tag).toBeLessThanOrEqual(s.fogTable[i] + 1e-7);
          }
        }
      }
    }
  }, 120000);

  it('is what the sun scatters toward the eye: a glow toward the sun, less of the haze away from it', async () => {
    for (const timeOfDay of ['golden', 'dusk', 'dawn'] as const) {
      const s = await solveEnvironment({ timeOfDay, weather: 'clear' });
      const share = (k: number): number => lum(s.fogTableSun, k) / lum(s.fogTable, k);
      // entry 0 is toward the sun, the last away from it
      expect(share(0), timeOfDay).toBeGreaterThan(share(FOG_TABLE_SIZE - 1));
      expect(share(0), timeOfDay).toBeGreaterThan(0.85);
      // and the sky's own part is there everywhere: without the sun the haze is dimmer, not gone
      for (let k = 0; k < FOG_TABLE_SIZE; k++) expect(lum(s.fogTable, k) - lum(s.fogTableSun, k), `${timeOfDay} ${k}`).toBeGreaterThan(0);
    }
  });

  it("follows the weather as the haze does: through a forecast's blend and a clone", async () => {
    const dry = await solveEnvironment({ timeOfDay: 'golden', weather: 'clear' });
    const wet = await solveEnvironment({ timeOfDay: 'golden', weather: 'rain' });
    const mix = cloneSolution(dry);
    expect(mix.fogTableSun).not.toBe(dry.fogTableSun);
    expect(Array.from(mix.fogTableSun)).toEqual(Array.from(dry.fogTableSun));
    blendInto(mix, dry, wet, 0, 0);
    expect(Array.from(mix.fogTableSun)).toEqual(Array.from(dry.fogTableSun));
    blendInto(mix, dry, wet, 1, 0.55);
    for (let i = 0; i < mix.fogTableSun.length; i++) expect(mix.fogTableSun[i]).toBeCloseTo(wet.fogTableSun[i], 6);
    // half way the table and its sun part stay in step: the sun's part is never more than the whole
    blendInto(mix, dry, wet, 0.4, 0.2);
    for (let i = 0; i < mix.fogTableSun.length; i++) expect(mix.fogTableSun[i]).toBeLessThanOrEqual(mix.fogTable[i] + 1e-7);
  });

  it("keeps the old colour where the ray is in the sun and only the sky's part (and the glow's) where none of it is", async () => {
    const s = await solveEnvironment({ timeOfDay: 'dusk', weather: 'clear' });
    for (let k = 0; k < FOG_TABLE_SIZE; k++) {
      for (let c = 0; c < 3; c++) {
        const total = s.fogTable[k * 3 + c];
        const sun = s.fogTableSun[k * 3 + c];
        // the sun's whole share: exactly the colour the fog had (bit for bit: nothing is added and taken away), whatever the glow
        expect(sunlitHaze(total, sun, 1)).toBe(total);
        expect(sunlitHaze(total, sun, 1, 0.7)).toBe(total);
        // none of it, and no glow: the sky's part alone, no sun in the haze
        expect(sunlitHaze(total, sun, 0, 0)).toBeCloseTo(total - sun, 9);
        // the glow of the sky above the ridge lights the shadowed air from the side: a share of the sun's part stays, never more than it
        expect(sunlitHaze(total, sun, 0)).toBeCloseTo(total - sun * (1 - SHADE_HAZE_GLOW), 9);
        expect(sunlitHaze(total, sun, 0)).toBeLessThanOrEqual(total);
        // in between: monotone
        expect(sunlitHaze(total, sun, 0.5)).toBeGreaterThanOrEqual(sunlitHaze(total, sun, 0.25));
      }
    }
    // a hill in front of a hidden sun stays far darker than the sunlit haze toward it (the glow is a fifth, not the whole)
    const lumSun = lum(s.fogTableSun, 0);
    const lumAll = lum(s.fogTable, 0);
    const shaded = sunlitHaze(lumAll, lumSun, 0);
    expect(shaded).toBeLessThan(lumAll * 0.5);
    expect(shaded).toBeGreaterThan(lumAll - lumSun);
  });
});

describe('the terrain shade in the shader patches', () => {
  it("multiplies the sun, and only the sun, by the terrain's share, outside the shadow test, and spares the cascade taps where it is nil", () => {
    const r = installShaderPatches();
    expect(r.sunVis).toBe(true);
    const src = chunks().lights_fragment_begin;
    expect(src).toContain('xrSunVG = xrSunVisAt( cameraPosition + ( vec4( geometryPosition, 0.0 ) * viewMatrix ).xyz );');
    // light 0 only (the other lights of the unrolled loop are the cascades', which are skipped)
    expect(src).toMatch(/#if UNROLLED_LOOP_INDEX == 0\s*\n\s*directLight\.color \*= xrSunVG;\s*\n\s*#endif/);
    // (and before the shadow test, which a material that does not receive shadows skips)
    const at = src.indexOf('directLight.color *= xrSunVG;');
    expect(at).toBeGreaterThan(0);
    expect(src.indexOf('directLight.color *= ( directLight.visible && receiveShadow )', at)).toBeGreaterThan(at);
    // the cascade early-out comes after the derivatives the quad needs
    const pars = chunks().shadowmap_pars_fragment;
    expect(pars.indexOf('if ( xrSunVG < 0.002 ) return 1.0;')).toBeGreaterThan(pars.indexOf('xrPlaneGradient( dFdx( s0 )'));
    expect(pars.indexOf('if ( xrSunVG < 0.002 ) return 1.0;')).toBeLessThan(pars.indexOf('float result = 0.0;'));
  });

  it('is the old code, with no lookup at all, while the strength is 0 (noon, no map, a rain deck)', () => {
    installShaderPatches();
    const pars = chunks().lights_pars_begin;
    expect(pars).toContain('float xrSunVisAt( vec3 p )');
    expect(pars).toMatch(/vec4 s0 = xrSunVis\[ 0 \];\s*\n\s*if \( s0\.w <= 0\.0 \) return 1\.0;/);
    const fogPars = chunks().fog_pars_fragment;
    expect(fogPars).toContain('float xrSunVisAt( vec3 p )');
    // the haze: the old colour unless the map is on and there is fog to see; the exp2 factor is the stock one
    expect(fogPars).toContain('if ( xrSunVis[ 0 ].w > 0.0 && F > 0.012 )');
    expect(chunks().fog_fragment).toContain('xrFogColorLit( normalize( vFogDir ), vFogDepth, length( vFogDir ), fogFactor )');
    expect(chunks().fog_fragment).toContain('fogDensity * fogDensity * vFogDepth * vFogDepth');
    // one definition of the function per program, whichever chunk comes first
    expect((fogPars.match(/#ifndef XR_SUNVIS_PARS/g) ?? []).length).toBe(1);
  });

  it('is part of the uniform table of every lit or fogged built-in material, one set for all', () => {
    installShaderPatches();
    const lib = ShaderLib as unknown as Record<string, { uniforms: Record<string, { value: unknown }> }>;
    for (const key of ['standard', 'physical', 'lambert', 'phong', 'toon']) {
      expect(lib[key].uniforms.xrSunVis, key).toBe(xrSunVisUniform);
      expect(lib[key].uniforms.xrSunVisTex, key).toBe(xrSunVisTexUniform);
      expect(lib[key].uniforms.xrFogSun, key).toBe(xrFogSunUniform);
    }
    expect(lib.basic.uniforms.xrSunVis).toBe(xrSunVisUniform);
    const libU = UniformsLib as unknown as Record<string, Record<string, unknown>>;
    expect(libU.fog.xrSunVisTex).toBe(xrSunVisTexUniform);
    expect(libU.lights.xrSunVis).toBe(xrSunVisUniform);
    expect(xrSunVisUniform.value.length).toBe(7 * 4);
    expect(xrFogSunUniform.value.length).toBe(8 * 4);
    // three clones the textures of a built-in material's uniforms: this one answers with itself, so that a later map reaches them all
    expect(xrSunVisTexUniform.value).toBe(sunVisTexture);
    expect(sunVisTexture.clone()).toBe(sunVisTexture);
  });
});
