/**
 * Headlamp glare in the mirrors (owner: render).
 *
 * In a mirror a following car is a small picture and its lamps are a pixel or two, but at night the lamps are what the
 * eye sees of it: two soft white glows, and a car on your bumper fills the glass with them. The cars' own lamps are
 * emissive paint and render to those few pixels; so, in the mirror passes only, each lit lamp that faces the player also
 * gets a glow sprite: a camera-facing quad, added in HDR (so bloom and the exposure treat it like any lamp), never
 * smaller than a few pixels of the mirror's own render target, and hidden by whatever stands in front of it (the
 * mirror pass's depth buffer). Where the lamps are and how strongly they face the player comes from the game
 * (src/game/headlamps.ts).
 */
import {
  AddEquation,
  BufferAttribute,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  OneFactor,
  Scene,
  ShaderMaterial,
  Uniform,
  Vector2,
  Vector3,
} from 'three';
import { particleCommon } from './fx/particleShaders';
import { particleUniforms } from './post';

/** Most lamps a frame can hold (src/game/headlamps.ts fills at most this many). */
export const MAX_FLARES = 24;

export const flareVertex = /* glsl */ `
attribute vec4 aLamp;      // world position xyz, strength
uniform vec2 uRes;         // the render target's size, px
uniform float uRadius;     // glow radius at full strength, m
uniform float uMinPx;      // never smaller than this, px
varying vec2 vP;
varying float vK;
varying float vDepth;

void main() {
  // out of the lens, toward whoever is looking
  vec3 toCam = cameraPosition - aLamp.xyz;
  vec3 c = aLamp.xyz + toCam / max(length(toCam), 1.0e-3) * 0.3;
  vec4 mv = viewMatrix * vec4(c, 1.0);
  vDepth = -mv.z;
  // one pixel, in metres, at this depth (projectionMatrix[1][1] is the cotangent of half the vertical field of view)
  float perPx = 2.0 * max(vDepth, 0.1) / (projectionMatrix[1][1] * uRes.y);
  float size = max(uRadius * (0.55 + 0.45 * aLamp.w), uMinPx * perPx);
  vP = position.xy * 2.0;
  vK = aLamp.w;
  mv.xy += vP * size;
  gl_Position = projectionMatrix * mv;
}
`;

export const flareFragment = /* glsl */ `
uniform vec3 uColor;
varying vec2 vP;
varying float vK;
varying float vDepth;

void main() {
  float r2 = dot(vP, vP);
  if (r2 >= 1.0) discard;
  // a hot core in a soft halo
  float g = (exp(-r2 * 15.0) + 0.34 * exp(-r2 * 2.6)) * (1.0 - r2) * (1.0 - r2);
  float a = g * vK;
  if (a < 0.0004) discard;
  // haze and rain take light out of the beam on its way
  float fk = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth - uFogLin * vDepth);
  gl_FragColor = vec4(uColor * (1.0 - fk) * a, a);
}
`;

/** The lamp glows of one frame: a quad per lamp, instanced, in a scene of their own (drawn into each mirror pass). */
export class LampFlares {
  readonly scene = new Scene();
  private readonly lamps: InstancedBufferAttribute;
  private readonly geometry: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly mesh: Mesh;
  private count = 0;

  constructor() {
    const geo = new InstancedBufferGeometry();
    // a unit quad centred on the origin
    geo.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.lamps = new InstancedBufferAttribute(new Float32Array(MAX_FLARES * 4), 4);
    this.lamps.setUsage(DynamicDrawUsage);
    geo.setAttribute('aLamp', this.lamps);
    geo.instanceCount = 0;
    this.geometry = geo;
    const U = particleUniforms;
    this.material = new ShaderMaterial({
      name: 'xr.mirror.flare',
      uniforms: {
        uDepth: U.uDepth,
        uHasDepth: U.uHasDepth,
        uResolution: U.uResolution,
        uNearFar: U.uNearFar,
        uSunDir: U.uSunDir,
        uSunLight: U.uSunLight,
        uSkyAmb: U.uSkyAmb,
        uGroundAmb: U.uGroundAmb,
        uFogColor: U.uFogColor,
        uFogDensity: U.uFogDensity,
        uFogLin: U.uFogLin,
        uRes: new Uniform(new Vector2(1, 1)),
        uRadius: new Uniform(0.34),
        uMinPx: new Uniform(3.6),
        // HDR: a lamp is far brighter than the road it lights, whatever the exposure
        uColor: new Uniform(new Vector3(4.0, 3.6, 3.0)),
      },
      vertexShader: flareVertex,
      fragmentShader: particleCommon + flareFragment,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneFactor,
      depthTest: true,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
      fog: false,
      side: DoubleSide,
    });
    this.mesh = new Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'xr.mirror.flares';
    this.scene.add(this.mesh);
  }

  /** The lamps to draw this frame (x, y, z, strength per lamp). A copy: the caller's list is rewritten every frame. */
  set(data: Float32Array | null, n: number): void {
    const k = data ? Math.max(0, Math.min(MAX_FLARES, n)) : 0;
    if (k > 0 && data) {
      (this.lamps.array as Float32Array).set(data.subarray(0, k * 4));
      this.lamps.needsUpdate = true;
    }
    this.count = k;
    this.geometry.instanceCount = k;
  }

  /** Lamps in the list. */
  get n(): number {
    return this.count;
  }

  /** Tell the shader how big the render target it is about to be drawn into is (the glow keeps a minimum size in its pixels). */
  fit(width: number, height: number): void {
    (this.material.uniforms.uRes.value as Vector2).set(width, height);
  }

  /** For precompile(): the shader is built against a stand-in target behind the loading screen. */
  get compileScene(): Scene {
    return this.scene;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
