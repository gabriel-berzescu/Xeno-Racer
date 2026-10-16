import { REVISION, ShaderChunk, ShaderLib } from 'three';
import { describe, expect, it } from 'vitest';
import { installShaderPatches, MAX_CASCADES, xrCsmUniform, xrFogUniform } from '../src/render/shaderPatches';

const chunks = () => ShaderChunk as unknown as Record<string, string>;

describe('three.js shader patches', () => {
  it('targets the three.js revision the chunk layout was written against', () => {
    // If this fails after an upgrade, re-check the layout assumptions in shaderPatches.ts.
    expect(REVISION).toBe('186');
  });

  it('applies the cascade shadow and fog patches', () => {
    const r = installShaderPatches();
    expect(r.csm).toBe(true);
    expect(r.fog).toBe(true);
    expect(chunks().lights_fragment_begin).toContain('xrCascadeShadow()');
    expect(chunks().shadowmap_pars_fragment).toContain('xrCascadeTap');
    expect(chunks().shadowmap_pars_fragment).toContain('#define XR_CSM 1');
    expect(chunks().fog_fragment).toContain('xrFogColor');
    expect(chunks().fog_vertex).toContain('vFogDir');
  });

  it('keeps stock behaviour for a single shadow-casting light', () => {
    installShaderPatches();
    // the cascade branch is only entered through XR_CSM, which is defined for more than one shadow light
    expect(chunks().shadowmap_pars_fragment).toMatch(/#if NUM_DIR_LIGHT_SHADOWS > 1 && defined\( SHADOWMAP_TYPE_PCF \)\s*\n\s*#define XR_CSM 1/);
    expect(chunks().lights_fragment_begin).toContain('getShadow( directionalShadowMap[ i ]');
  });

  it('is idempotent', () => {
    installShaderPatches();
    const before = chunks().lights_fragment_begin;
    installShaderPatches();
    expect(chunks().lights_fragment_begin).toBe(before);
  });

  it('registers the shared uniforms on every lit / fogged built-in material', () => {
    installShaderPatches();
    const lib = ShaderLib as unknown as Record<string, { uniforms: Record<string, { value: unknown }> }>;
    for (const key of ['standard', 'physical', 'lambert', 'phong', 'toon']) {
      expect(lib[key].uniforms.xrCsm, key).toBe(xrCsmUniform);
      expect(lib[key].uniforms.xrFog, key).toBe(xrFogUniform);
    }
    expect(lib.basic.uniforms.xrFog).toBe(xrFogUniform);
    expect(xrCsmUniform.value.length).toBe(MAX_CASCADES * 4);
    expect(xrFogUniform.value.length).toBe(10 * 4);
  });

  it('keeps braces out of the unrolled directional loop body (three unrolls it with a regex)', () => {
    installShaderPatches();
    const src = chunks().lights_fragment_begin;
    const start = src.indexOf('#pragma unroll_loop_start', src.indexOf('DirectionalLight directionalLight;'));
    const end = src.indexOf('#pragma unroll_loop_end', start);
    const body = src.slice(start, end);
    const inner = body.slice(body.indexOf('{') + 1, body.lastIndexOf('}'));
    expect(inner.includes('{') || inner.includes('}')).toBe(false);
  });
});

describe('rain haze in the fog patch', () => {
  it('adds the Beer-Lambert term through xrFog[0].z, which is 0 when dry', () => {
    installShaderPatches();
    expect(chunks().fog_fragment).toContain('xrFog[ 0 ].z * vFogDepth');
    // the exp2 term is untouched: with the new term at 0 the factor is exactly the stock one
    expect(chunks().fog_fragment).toContain('fogDensity * fogDensity * vFogDepth * vFogDepth');
  });

  it('fades far scenery into the rain deck by elevation, only when the deck mode (xrFog[0].w = 2) is on, and by how much of the sky the deck covers in between', () => {
    installShaderPatches();
    const pars = chunks().fog_pars_fragment;
    expect(pars).toContain('uniform vec4 xrFog[ 10 ]');
    // the mode is 1 + the share of the sky under the deck: a changing weather moves it smoothly from 1 to 2 and back
    expect(pars).toContain('float deck = clamp( xrFog[ 0 ].w - 1.0, 0.0, 1.0 );');
    expect(pars).toContain('if ( deck > 0.001 )');
    expect(pars).toContain('xrFog[ 9 ].rgb');
    expect(pars).toContain('* deck );');
  });
});
