/**
 * Pipeline pieces for the postprocessing composer (owner: render).
 */
import { Pass } from 'postprocessing';
import type { Camera, Scene, Texture, WebGLRenderer } from 'three';
import { HalfFloatType, LinearFilter, RGBAFormat, ShaderMaterial, Vector2, Vector3, WebGLRenderTarget } from 'three';

/**
 * Uniforms shared by every particle material (effects.ts). The render system keeps them current:
 * lighting from the environment, the composer's stable scene depth for soft intersections, fog.
 */
export const particleUniforms = {
  uDepth: { value: null as Texture | null },
  uHasDepth: { value: 0 },
  uResolution: { value: new Vector2(1, 1) },
  uNearFar: { value: new Vector2(0.1, 4000) },
  /** Unit vector toward the sun (world). */
  uSunDir: { value: new Vector3(0, 1, 0) },
  /** Sun radiance-ish colour: light colour * intensity. */
  uSunLight: { value: new Vector3(1, 1, 1) },
  /** Sky irradiance-mean radiance seen by an up-facing white surface. */
  uSkyAmb: { value: new Vector3(0.2, 0.25, 0.35) },
  uGroundAmb: { value: new Vector3(0.05, 0.05, 0.04) },
  uFogColor: { value: new Vector3(0.5, 0.6, 0.7) },
  uFogDensity: { value: 0.0002 },
  /** Rain-haze extinction (1/m), the Beer-Lambert part of the fog; 0 when dry. */
  uFogLin: { value: 0 },
  /** Exposure-aware flare: how much night glow to add to emissive particles. */
  uExposure: { value: 1 },
  /** Distances (view depth, m) over which smoke and spray fade in from the camera, so a puff never fills the lens. A mirror
   *  looks back along the plume of its own car and raises them. */
  uNearFade: { value: new Vector2(0.3, 3.6) },
  /** Opacity scale of smoke and spray (1 = as emitted). */
  uAlphaMul: { value: 1 },
};

/**
 * Renders the particle scene (smoke, dust, sparks, flames, debris) on top of the shaded scene, after
 * ambient occlusion and before bloom / tone mapping, so particles are lit in HDR and glow through
 * bloom. Particles do their own depth test against the composer's stable depth copy (soft edges).
 */
export class ParticlePass extends Pass {
  private depthTexture: Texture | null = null;

  constructor(scene: Scene, camera: Camera) {
    super('ParticlePass', scene, camera);
    this.needsSwap = false;
    this.needsDepthTexture = true;
  }

  override set mainCamera(value: Camera) {
    this.camera = value;
  }

  override getDepthTexture(): Texture {
    return this.depthTexture as Texture;
  }

  override setDepthTexture(depthTexture: Texture | null): void {
    this.depthTexture = depthTexture;
    particleUniforms.uDepth.value = depthTexture;
    particleUniforms.uHasDepth.value = depthTexture ? 1 : 0;
  }

  override setSize(width: number, height: number): void {
    particleUniforms.uResolution.value.set(width, height);
  }

  override render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget): void {
    if (this.scene.children.length === 0) return;
    const cam = this.camera as { near?: number; far?: number };
    particleUniforms.uNearFar.value.set(cam.near ?? 0.1, cam.far ?? 4000);
    renderer.setRenderTarget(this.renderToScreen ? null : inputBuffer);
    renderer.render(this.scene, this.camera);
  }
}

const shaftsVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const shaftsFragment = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 sunUv;
uniform float strength;
uniform vec3 tint;
uniform float lo;
uniform float hi;
uniform float seed;
varying vec2 vUv;

void main() {
  vec2 toSun = sunUv - vUv;
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + seed);
  vec2 stepv = toSun * (0.92 / float(SHAFT_TAPS));
  vec2 p = vUv + stepv * jitter;
  vec3 acc = vec3(0.0);
  float decay = 1.0;
  for (int i = 0; i < SHAFT_TAPS; i++) {
    p += stepv;
    vec3 s = textureLod(tInput, p, 0.0).rgb;
    float l = max(s.r, max(s.g, s.b));
    // only sky glow near the sun feeds the shafts; geometry in front of it blocks them
    float w = smoothstep(lo, hi, l);
    acc += min(s, vec3(hi * 2.5)) * w * decay;
    decay *= 0.965;
  }
  float falloff = 1.0 / (1.0 + 2.2 * length(toSun));
  gl_FragColor = vec4(acc / float(SHAFT_TAPS) * falloff * strength * tint, 1.0);
}
`;

/** 5-tap separable blur (binomial weights) that hides the march jitter of the shafts. */
const shaftsBlurFragment = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 dir;
varying vec2 vUv;
void main() {
  vec3 c = textureLod(tInput, vUv, 0.0).rgb * 0.375;
  c += (textureLod(tInput, vUv + dir, 0.0).rgb + textureLod(tInput, vUv - dir, 0.0).rgb) * 0.25;
  c += (textureLod(tInput, vUv + 2.0 * dir, 0.0).rgb + textureLod(tInput, vUv - 2.0 * dir, 0.0).rgb) * 0.0625;
  gl_FragColor = vec4(c, 1.0);
}
`;

/**
 * Sun shafts (crepuscular rays): a radial march from every half-resolution pixel toward the sun's
 * screen position, accumulating bright sky glow so trees, hills and cars in front of a low sun cut
 * it into beams. Renders into its own small target; the post pass adds that texture, so the pass
 * costs a fraction of a full-resolution one and nothing at all while the sun is out of view.
 */
export class ShaftsPass extends Pass {
  readonly target: WebGLRenderTarget;
  readonly sunUv = new Vector2(0.5, 0.5);
  readonly tint = new Vector3(1, 0.8, 0.55);
  strength = 0;
  private readonly material: ShaderMaterial;
  private readonly blurMaterial: ShaderMaterial;
  private readonly tmp: WebGLRenderTarget;

  constructor(taps = 24) {
    super('ShaftsPass');
    this.needsSwap = false;
    this.target = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
    });
    this.target.texture.name = 'xr.shafts';
    this.tmp = this.target.clone();
    this.tmp.texture.name = 'xr.shafts.tmp';
    this.blurMaterial = new ShaderMaterial({
      name: 'xr.shafts.blur',
      uniforms: { tInput: { value: null }, dir: { value: new Vector2() } },
      vertexShader: shaftsVertex,
      fragmentShader: shaftsBlurFragment,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.material = new ShaderMaterial({
      name: 'xr.shafts',
      defines: { SHAFT_TAPS: taps },
      uniforms: {
        tInput: { value: null },
        sunUv: { value: this.sunUv },
        strength: { value: 0 },
        tint: { value: this.tint },
        lo: { value: 1 },
        hi: { value: 2.5 },
        seed: { value: 0 },
      },
      vertexShader: shaftsVertex,
      fragmentShader: shaftsFragment,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.fullscreenMaterial = this.material;
  }

  /** Brightness window (scene units, pre-exposure) that counts as sun glow. */
  setWindow(lo: number, hi: number): void {
    this.material.uniforms.lo.value = lo;
    this.material.uniforms.hi.value = hi;
  }

  setSeed(v: number): void {
    this.material.uniforms.seed.value = v;
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
    this.tmp.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
  }

  override render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget): void {
    this.material.uniforms.strength.value = this.strength;
    this.material.uniforms.tInput.value = inputBuffer.texture;
    this.fullscreenMaterial = this.material;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    // blur: target -> tmp (horizontal) -> target (vertical)
    const bu = this.blurMaterial.uniforms;
    const w = this.target.width;
    const h = this.target.height;
    this.fullscreenMaterial = this.blurMaterial;
    bu.tInput.value = this.target.texture;
    (bu.dir.value as Vector2).set(1.25 / w, 0);
    renderer.setRenderTarget(this.tmp);
    renderer.render(this.scene, this.camera);
    bu.tInput.value = this.tmp.texture;
    (bu.dir.value as Vector2).set(0, 1.25 / h);
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    this.fullscreenMaterial = this.material;
  }

  override dispose(): void {
    this.target.dispose();
    this.tmp.dispose();
    this.material.dispose();
    this.blurMaterial.dispose();
    super.dispose();
  }
}
