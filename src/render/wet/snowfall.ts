/**
 * Falling snow (owner: render): the same camera-local box as the rain (src/render/wet/rain.ts), with flakes where the rain has streaks.
 *
 * Every flake lives at a fixed random spot inside a box of a few tens of metres that follows the camera; the vertex shader makes it
 * fall (slowly, each at its own speed, swaying as it goes), wraps it back into the box and draws it as a soft white dot, stretched along
 * its motion relative to the camera by a shutter time: a stationary camera sees dots drifting down, at 150 km/h the same snow rakes
 * towards the lens in long soft lines, as it does through a windscreen. Lit like the snow on the ground (sky, ground bounce, the sun),
 * brighter than any rain, and fading into the haze of the fog with distance.
 *
 * It has the interface of the RainField, so the effects system drives either.
 */
import { CustomBlending, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, OneFactor, OneMinusSrcAlphaFactor, AddEquation, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';
import { particleCommon } from '../fx/particleShaders';
import { particleUniforms } from '../post';
import { LIGHTS_GLSL, lightUniforms } from './lights';

const snowVertex = /* glsl */ `
attribute vec4 aSeed;
uniform vec3 uBoxMin;
uniform vec3 uBoxSize;
uniform vec3 uDropVel;
uniform vec3 uCamVel;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uShutter;
uniform float uAlpha;
uniform float uFar;
uniform float uLightGain;
uniform vec3 uSkyAmb;
uniform vec3 uGroundAmb;
uniform vec3 uSunLight;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogLin;
uniform vec2 uResolution;
${LIGHTS_GLSL}
varying vec2 vLoc;
varying float vHalf;
varying vec3 vCol;
varying float vA;
varying float vDepth;

vec3 snowFog(vec3 col, float dist) {
  float k = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist - uFogLin * dist);
  return mix(col, uFogColor, k);
}

void main() {
  // each flake falls at its own speed, a lazy swirl of the air carries it sideways
  float k = 0.6 + 0.75 * aSeed.w;
  vec3 vDrop = uDropVel * k;
  vec3 p = aSeed.xyz * uBoxSize + uDropVel * (k * uTime);
  vec3 wp = uBoxMin + mod(p - uBoxMin, uBoxSize);
  float ph = aSeed.x * 61.0 + aSeed.z * 37.0;
  wp += vec3(sin(uTime * 0.7 + ph), 0.0, cos(uTime * 0.6 + ph * 1.3)) * (0.35 + 0.5 * aSeed.w);
  vec3 swirl = vec3(cos(uTime * 0.7 + ph), 0.0, -sin(uTime * 0.6 + ph * 1.3)) * 0.3;

  vec3 vrel = vDrop + swirl - uCamVel;
  vec3 pTail = wp - vrel * uShutter;
  vec3 v0 = (viewMatrix * vec4(wp, 1.0)).xyz;
  vec3 v1 = (viewMatrix * vec4(pTail, 1.0)).xyz;
  float zn = -0.25;
  if (v0.z > zn && v1.z > zn) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  if (v0.z > zn) v0 = mix(v0, v1, (zn - v0.z) / (v1.z - v0.z));
  if (v1.z > zn) v1 = mix(v1, v0, (zn - v1.z) / (v0.z - v1.z));
  vec4 c0 = projectionMatrix * vec4(v0, 1.0);
  vec4 c1 = projectionMatrix * vec4(v1, 1.0);
  vec2 s0 = c0.xy / c0.w * 0.5 * uResolution;
  vec2 s1 = c1.xy / c1.w * 0.5 * uResolution;
  vec2 d = s1 - s0;
  float lenPx = length(d);
  vec2 dirPx = lenPx > 0.01 ? d / lenPx : vec2(0.0, -1.0);
  vec2 nPx = vec2(-dirPx.y, dirPx.x);
  vec4 c = mix(c0, c1, 0.5);
  float depthV = c.w;

  // a flake is a few centimetres across: never smaller than a pixel and a bit, dimmer instead. The quad is a capsule in screen space,
  // the streak plus a cap of a radius at each end, so that a flake that hardly moves is a round soft dot and a fast one a rounded line.
  float pxPerM = 0.5 * uResolution.y * projectionMatrix[1][1] / max(depthV, 0.1);
  float physPx = 0.046 * pxPerM * (0.55 + 0.9 * aSeed.w);
  float wPx = max(1.2, physPx);
  float capPx = wPx;
  vec2 mid2 = 0.5 * (s0 + s1);
  vec2 sc = mid2 + dirPx * (position.y * (lenPx + 2.0 * capPx)) + nPx * (position.x * 2.0 * wPx);
  gl_Position = vec4(sc / (0.5 * uResolution) * c.w, c.z, c.w);
  vLoc = vec2(position.x * 2.0, position.y * (lenPx + 2.0 * capPx) / wPx);
  vHalf = 0.5 * lenPx / wPx;

  float fadeFar = 1.0 - smoothstep(0.45 * uFar, uFar, depthV);
  float fadeNear = smoothstep(0.5, 3.5, depthV);
  vec3 q = (wp - uBoxMin) / uBoxSize;
  vec3 e3 = min(q, 1.0 - q);
  float boxFade = smoothstep(0.0, 0.1, min(e3.x, min(e3.y, e3.z)));
  float thin = clamp(physPx * 1.6 + 0.35, 0.0, 1.0);
  float smear = 1.0 / (1.0 + lenPx * 0.01);
  // against a bright sky a flake is faint; against the dark of the trees and the shadowed snow it shows
  float skyK = smoothstep(-0.03, 0.22, (wp.y - uCamPos.y) / max(depthV, 1.0));
  vA = uAlpha * thin * smear * fadeFar * fadeNear * boxFade * (1.0 - 0.18 * skyK);

  vec3 mid = 0.5 * (wp + pTail);
  vec3 col = (uSkyAmb * 1.6 + uGroundAmb * 1.1 + uSunLight * 0.22) * 1.6 + xrLights(mid) * (uLightGain / (1.0 + lenPx * 0.02));
  vCol = snowFog(col, depthV);
  vDepth = depthV;
}
`;

const snowFragment = /* glsl */ `
varying vec2 vLoc;
varying float vHalf;
varying vec3 vCol;
varying float vA;
varying float vDepth;

void main() {
  // distance to the streak's axis in radii: round at the ends, so a still flake is a dot and a fast one a soft line
  float d = length(vec2(vLoc.x, max(abs(vLoc.y) - vHalf, 0.0)));
  float a = vA * exp(-d * d * 2.6) * (1.0 - smoothstep(0.75, 1.0, d));
  if (a < 0.002) discard;
  a *= smoothstep(-0.05, 0.3, sceneViewDepth() - vDepth);
  gl_FragColor = vec4(vCol * a, a);
}
`;

/** Box dimensions (m): the snow exists in front of the camera, a little behind it and around (wider and taller than the rain's: flakes hang about). */
const BOX = new Vector3(56, 30, 56);
/** How far ahead of the camera (along its horizontal view direction) the box is centred. */
const AHEAD = 15;

export class SnowField {
  readonly mesh: Mesh;
  readonly max: number;
  private readonly geom: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;
  private time = 0;
  private readonly boxMin = new Vector3();
  private readonly dropVel = new Vector3();
  private readonly camVel = new Vector3();
  private readonly camPos = new Vector3();

  constructor(max: number) {
    // (flakes are bigger and slower than drops: fewer of them make the same snowfall)
    this.max = Math.round(max * 0.9);
    const base = new PlaneGeometry(1, 1);
    const geom = new InstancedBufferGeometry();
    geom.index = base.index;
    geom.setAttribute('position', base.getAttribute('position'));
    geom.setAttribute('uv', base.getAttribute('uv'));
    const seed = new Float32Array(this.max * 4);
    let s = 0x2545f491;
    const rnd = (): number => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 4294967296;
    };
    for (let i = 0; i < seed.length; i++) seed[i] = rnd();
    const attr = new InstancedBufferAttribute(seed, 4);
    attr.setUsage(DynamicDrawUsage);
    geom.setAttribute('aSeed', attr);
    geom.instanceCount = 0;
    this.geom = geom;

    const U = particleUniforms;
    this.material = new ShaderMaterial({
      name: 'xr.fx.snow',
      uniforms: {
        uDepth: U.uDepth,
        uHasDepth: U.uHasDepth,
        uResolution: U.uResolution,
        uNearFar: U.uNearFar,
        uSkyAmb: U.uSkyAmb,
        uGroundAmb: U.uGroundAmb,
        uSunLight: U.uSunLight,
        uFogColor: U.uFogColor,
        uFogDensity: U.uFogDensity,
        uFogLin: U.uFogLin,
        ...lightUniforms,
        uBoxMin: { value: this.boxMin },
        uBoxSize: { value: BOX.clone() },
        uDropVel: { value: this.dropVel },
        uCamVel: { value: this.camVel },
        uCamPos: { value: this.camPos },
        uTime: { value: 0 },
        uShutter: { value: 1 / 50 },
        uAlpha: { value: 0.5 },
        uFar: { value: 64 },
        uLightGain: { value: 1 },
      },
      vertexShader: snowVertex,
      fragmentShader: particleCommon + snowFragment,
      // premultiplied "over", like the rain
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneMinusSrcAlphaFactor,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      side: DoubleSide,
      toneMapped: false,
      fog: false,
    });
    this.mesh = new Mesh(geom, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;
    this.mesh.name = 'xr.fx.snow';
    this.mesh.visible = false;
  }

  /** Same arguments as RainField.update: `rain` is the snowfall's strength 0..1. */
  update(dt: number, cx: number, cy: number, cz: number, fx: number, fz: number, camVx: number, camVy: number, camVz: number, rain: number, windX: number, windZ: number, shelter: number, night: number): void {
    const density = Math.max(0, Math.min(1, rain)) * (1 - shelter);
    if (density * this.max < 1) {
      this.mesh.visible = false;
      this.geom.instanceCount = 0;
      return;
    }
    this.mesh.visible = true;
    this.time += dt;
    if (this.time > 2400) this.time -= 2400;
    const fl = Math.hypot(fx, fz) || 1;
    const ax = fx / fl;
    const az = fz / fl;
    this.boxMin.set(cx + ax * AHEAD - BOX.x / 2, cy + 1.5 - BOX.y / 2, cz + az * AHEAD - BOX.z / 2);
    // snow falls at a metre or two a second and goes where the wind goes
    this.dropVel.set(windX * 0.6, -(1.15 + 0.45 * rain), windZ * 0.6);
    this.camVel.set(camVx, camVy, camVz);
    this.camPos.set(cx, cy, cz);
    const u = this.material.uniforms;
    u.uTime.value = this.time;
    u.uAlpha.value = (0.5 + 0.3 * rain) * (1 - shelter);
    u.uLightGain.value = 1;
    void night;
    this.geom.instanceCount = Math.floor(this.max * density);
  }

  dispose(): void {
    this.geom.dispose();
    this.material.dispose();
  }
}
