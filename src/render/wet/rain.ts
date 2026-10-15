/**
 * Falling rain (owner: render): GPU streaks in a camera-local box.
 *
 * Every drop lives at a fixed random spot inside a box of a few tens of metres that follows the camera;
 * the vertex shader makes it fall (fall speed + wind), wraps it back into the box (so the rain is endless
 * and costs no CPU), and draws it as a motion-blurred streak: the drop's velocity RELATIVE TO THE CAMERA times
 * a shutter time. A stationary camera sees near-vertical streaks; at 300 km/h the same rain rakes toward the
 * lens in long radial lines, exactly like the real thing.
 *
 * Streaks are deliberately faint (energy conserving: thinner than a pixel means dimmer, a long smear spreads
 * its light), tinted by the sky light so they vanish against a bright sky and show against dark ground, and
 * lit by the nearest headlights, brake lights and lamps (lights.ts) so they sparkle in a beam at night.
 */
import { CustomBlending, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, OneFactor, OneMinusSrcAlphaFactor, AddEquation, PlaneGeometry, ShaderMaterial, Vector3 } from 'three';
import { particleCommon } from '../fx/particleShaders';
import { particleUniforms } from '../post';
import { LIGHTS_GLSL, lightUniforms } from './lights';

const rainVertex = /* glsl */ `
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
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogLin;
uniform vec2 uResolution;
${LIGHTS_GLSL}
varying vec2 vUv;
varying vec3 vCol;
varying float vA;
varying float vDepth;

vec3 rainFog(vec3 col, float dist) {
  float k = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist - uFogLin * dist);
  return mix(col, uFogColor, k);
}

void main() {
  // terminal velocity varies a little with drop size
  float k = 0.86 + 0.28 * aSeed.w;
  vec3 vDrop = uDropVel * k;
  vec3 p = aSeed.xyz * uBoxSize + uDropVel * (k * uTime);
  vec3 wp = uBoxMin + mod(p - uBoxMin, uBoxSize);

  // the streak: where the drop was a shutter time ago, relative to the camera
  vec3 vrel = vDrop - uCamVel;
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
  float t = position.y + 0.5;
  vec4 c = mix(c0, c1, t);
  float depthV = c.w;

  // a drop is a couple of millimetres wide: never thinner than a pixel on screen, dimmer instead
  float pxPerM = 0.5 * uResolution.y * projectionMatrix[1][1] / max(depthV, 0.1);
  float physPx = 0.0028 * pxPerM * (0.6 + 0.8 * aSeed.w);
  float wPx = max(0.8, physPx);
  vec2 offPx = nPx * (position.x * 2.0 * wPx * 1.6);
  gl_Position = vec4(c.xy + offPx / (0.5 * uResolution) * c.w, c.z, c.w);

  float fadeFar = 1.0 - smoothstep(0.5 * uFar, uFar, depthV);
  float fadeNear = smoothstep(0.6, 4.5, depthV);
  vec3 q = (wp - uBoxMin) / uBoxSize;
  vec3 e3 = min(q, 1.0 - q);
  float boxFade = smoothstep(0.0, 0.1, min(e3.x, min(e3.y, e3.z)));
  float thin = clamp(physPx * 2.2 + 0.3, 0.0, 1.0);
  float smear = 1.0 / (1.0 + lenPx * 0.014);
  // against the sky a drop is nearly invisible: it only shows against the dark ground and trees
  float skyK = smoothstep(-0.03, 0.22, (wp.y - uCamPos.y) / max(depthV, 1.0));
  vA = uAlpha * thin * smear * fadeFar * fadeNear * boxFade * (1.0 - 0.7 * skyK);

  vec3 mid = 0.5 * (wp + pTail);
  // lit drops: long smears spread their light, so a streak ripping past the lens is not a laser line
  vec3 col = uSkyAmb * 1.7 + xrLights(mid) * (uLightGain / (1.0 + lenPx * 0.03));
  vCol = rainFog(col, depthV);
  vUv = vec2(position.x * 2.0, t);
  vDepth = depthV;
}
`;

const rainFragment = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
varying float vA;
varying float vDepth;

void main() {
  float across = exp(-vUv.x * vUv.x * 3.0);
  float along = smoothstep(0.0, 0.08, vUv.y) * (1.0 - smoothstep(0.25, 1.0, vUv.y));
  float a = vA * across * along;
  if (a < 0.002) discard;
  // the world occludes it
  a *= smoothstep(-0.05, 0.3, sceneViewDepth() - vDepth);
  gl_FragColor = vec4(vCol * a, a);
}
`;

/** Box dimensions (m): the rain exists in front of the camera, a little behind it and around. */
const BOX = new Vector3(46, 28, 46);
/** How far ahead of the camera (along its horizontal view direction) the box is centred. */
const AHEAD = 13;

export class RainField {
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
    this.max = max;
    const base = new PlaneGeometry(1, 1);
    const geom = new InstancedBufferGeometry();
    geom.index = base.index;
    geom.setAttribute('position', base.getAttribute('position'));
    geom.setAttribute('uv', base.getAttribute('uv'));
    // deterministic scatter (xorshift32)
    const seed = new Float32Array(max * 4);
    let s = 0x9e3779b9;
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
      name: 'xr.fx.rain',
      uniforms: {
        uDepth: U.uDepth,
        uHasDepth: U.uHasDepth,
        uResolution: U.uResolution,
        uNearFar: U.uNearFar,
        uSkyAmb: U.uSkyAmb,
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
        uShutter: { value: 1 / 55 },
        uAlpha: { value: 0.2 },
        uFar: { value: 42 },
        uLightGain: { value: 1 },
      },
      vertexShader: rainVertex,
      fragmentShader: particleCommon + rainFragment,
      // premultiplied "over": a streak the colour of the sky behind it disappears
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
    this.mesh.name = 'xr.fx.rain';
    this.mesh.visible = false;
  }

  /**
   * @param rain      0..1 precipitation
   * @param shelter   0..1 how much roof is overhead (tunnel): fades the rain out
   * @param night     0..1 darkness: lights matter more, the sky tint matters less
   */
  update(dt: number, cx: number, cy: number, cz: number, fx: number, fz: number, camVx: number, camVy: number, camVz: number, rain: number, windX: number, windZ: number, shelter: number, night: number): void {
    const density = Math.max(0, Math.min(1, rain)) * (1 - shelter);
    if (density < 0.01) {
      this.mesh.visible = false;
      this.geom.instanceCount = 0;
      return;
    }
    this.mesh.visible = true;
    this.time += dt;
    if (this.time > 2400) this.time -= 2400;
    const fl = Math.hypot(fx, fz) || 1;
    const ax = fx / fl, az = fz / fl;
    this.boxMin.set(cx + ax * AHEAD - BOX.x / 2, cy + 1.5 - BOX.y / 2, cz + az * AHEAD - BOX.z / 2);
    const fall = 7.4 + 1.4 * rain;
    this.dropVel.set(windX * 0.9, -fall, windZ * 0.9);
    this.camVel.set(camVx, camVy, camVz);
    this.camPos.set(cx, cy, cz);
    const u = this.material.uniforms;
    u.uTime.value = this.time;
    // heavier rain is both denser and a little more visible
    u.uAlpha.value = (0.12 + 0.08 * rain) * (1 - shelter);
    u.uLightGain.value = 1;
    void night;
    this.geom.instanceCount = Math.floor(this.max * density);
  }

  dispose(): void {
    this.geom.dispose();
    this.material.dispose();
  }
}
