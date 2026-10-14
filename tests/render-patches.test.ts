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
    expect(xrFogUniform.value.length).toBe(9 * 4);
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
