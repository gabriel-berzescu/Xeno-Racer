import { describe, expect, it } from 'vitest';
import { createBodyMaterials, createBodyUniforms } from '../src/carvis/materials';
import { BODY_FRAG_BEADS, BODY_FRAG_NORMAL, BODY_FRAG_PARS, BODY_FRAG_ZONES } from '../src/carvis/shaders';
import { createWheelUniforms } from '../src/carvis/wheelMaterial';
import { createInteriorMaterial, createInteriorUniforms } from '../src/carvis/interiorMaterial';

describe('car visuals in the rain', () => {
  it('has rain uniforms that default to a dry car', () => {
    const u = createBodyUniforms();
    expect(u.uWet.value).toBe(0);
    expect(u.uSpd.value).toBe(0);
    expect(createWheelUniforms().uWet.value).toBe(0);
  });

  it('declares and uses the rain uniforms in the body shader', () => {
    expect(BODY_FRAG_PARS).toMatch(/uniform\s+float\s+uWet\b/);
    expect(BODY_FRAG_PARS).toMatch(/uniform\s+float\s+uSpd\b/);
    expect(BODY_FRAG_PARS).toContain('wetBead');
    expect(BODY_FRAG_ZONES).toContain('uWet');
    expect(BODY_FRAG_BEADS).toContain('gBead');
    // the bead tilt runs after the normal is built, for glass and paint alike
    expect(BODY_FRAG_BEADS).not.toContain('GLASS_PASS');
    expect(BODY_FRAG_NORMAL).not.toContain('gBead');
  });

  it('patches the beads into both the paint and the glass program', () => {
    const { paint, glass, uniforms } = createBodyMaterials();
    expect(uniforms.uWet).toBeDefined();
    for (const m of [paint, glass]) {
      const shader = { uniforms: {} as Record<string, unknown>, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>\n#include <normal_fragment_maps>\n#include <emissivemap_fragment>\n#include <lights_physical_fragment>\n#include <aomap_fragment>\n#include <opaque_fragment>' };
      m.onBeforeCompile(shader as never, null as never);
      expect(shader.uniforms.uWet).toBe(uniforms.uWet);
      expect(shader.fragmentShader).toContain('gBead.z > 0.01');
    }
    expect(glass.customProgramCacheKey()).not.toBe(paint.customProgramCacheKey());
  });

  it('lights the cabin through the glass only when asked (the car sets it by day): the default is unlit', () => {
    expect(createInteriorUniforms().uFill.value).toBe(0);
    const { material, uniforms } = createInteriorMaterial();
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: `#include <common>
#include <begin_vertex>`,
      fragmentShader: `#include <common>
#include <color_fragment>
#include <roughnessmap_fragment>
#include <metalnessmap_fragment>
#include <emissivemap_fragment>
#include <lights_physical_fragment>
#include <aomap_fragment>`,
    };
    material.onBeforeCompile(shader as never, null as never);
    expect(shader.uniforms.uFill).toBe(uniforms.uFill);
    expect(shader.fragmentShader).toMatch(/uniform\s+float\s+uFill\b/);
    expect(shader.fragmentShader).toContain('if (uFill > 0.0)');
    // a different shader needs a different program
    expect(material.customProgramCacheKey()).not.toBe('xr-interior-v1');
  });

  it('never takes pow() of an unclamped (1.0 - x) in the wet car code', () => {
    for (const src of [BODY_FRAG_PARS, BODY_FRAG_ZONES, BODY_FRAG_BEADS]) {
      const bad = src.match(/pow\(\s*1\.0\s*-\s*[^,]+,/g) ?? [];
      for (const b of bad) expect(/clamp\(|max\(|saturate\(/.test(b), b).toBe(true);
    }
  });
});
