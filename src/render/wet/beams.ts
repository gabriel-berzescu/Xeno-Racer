/**
 * Light in the rain (owner: render): headlight beams and lamp halos.
 *
 * Rain scatters light: a headlight beam becomes a visible hazy cone and a street lamp wears a soft halo.
 * Both are cheap additive meshes in the particle pass:
 *   - BeamField: one open cone per lit car (instanced), denser where the view ray runs down the axis,
 *     fading along its length and where the road or a wall cuts it (soft depth test).
 *   - HaloField: a camera-facing glow on every lamp head near the camera.
 * Their strength follows the rain and the darkness, so a dry night looks exactly as before.
 */
import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  OneFactor,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import { particleCommon } from '../fx/particleShaders';
import { particleUniforms } from '../post';

const beamVertex = /* glsl */ `
attribute vec3 aN;
attribute float aI;
varying float vAxial;
varying vec3 vN;
varying vec3 vView;
varying float vInt;

void main() {
  vec3 ax = normalize(instanceMatrix[0].xyz);
  vec3 ay = normalize(instanceMatrix[1].xyz);
  vec3 az = normalize(instanceMatrix[2].xyz);
  vec3 nw = ax * aN.x + ay * aN.y + az * aN.z;
  vN = (viewMatrix * vec4(nw, 0.0)).xyz;
  vec4 wp = instanceMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * wp;
  vView = mv.xyz;
  vAxial = position.z;
  vInt = aI;
  gl_Position = projectionMatrix * mv;
}
`;

const beamFragment = /* glsl */ `
uniform vec3 uColor;
varying float vAxial;
varying vec3 vN;
varying vec3 vView;
varying float vInt;

void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(-vView);
  // denser where the view ray runs along the axis (the normal faces the eye), thin at the silhouette
  float facing = clamp(abs(dot(n, v)), 0.0, 1.0);
  // (pow of a negative base is NaN, and one NaN pixel blacks out the whole frame through the bloom: keep it >= 0)
  float axial = pow(max(1.0 - vAxial, 0.0), 2.2) * smoothstep(0.0, 0.05, vAxial);
  float depthV = -vView.z;
  float a = vInt * pow(facing, 1.4) * smoothstep(0.0, 0.2, facing) * axial;
  a *= smoothstep(0.0, 1.4, sceneViewDepth() - depthV);   // the road and walls cut the beam
  a *= smoothstep(0.6, 4.0, depthV);                        // nothing in front of the lens
  if (a < 0.0005) discard;
  float fk = 1.0 - exp(-uFogDensity * uFogDensity * depthV * depthV - uFogLin * depthV);
  gl_FragColor = vec4(uColor * (1.0 - fk) * a, a);
}
`;

const haloVertex = /* glsl */ `
attribute float aI;
varying vec2 vP;
varying float vInt;
varying float vDepth;

void main() {
  vec3 c = instanceMatrix[3].xyz;
  float size = instanceMatrix[0].x;
  vec4 mv = viewMatrix * vec4(c, 1.0);
  vDepth = -mv.z;
  vP = position.xy * 2.0;
  vInt = aI;
  mv.xy += vP * size;
  gl_Position = projectionMatrix * mv;
}
`;

const haloFragment = /* glsl */ `
uniform vec3 uColor;
varying vec2 vP;
varying float vInt;
varying float vDepth;

void main() {
  float r2 = dot(vP, vP);
  if (r2 >= 1.0) discard;
  float g = (exp(-r2 * 9.0) + 0.2 * exp(-r2 * 3.0)) * (1.0 - r2) * (1.0 - r2);
  // fade when something solid is in front of the lamp
  float vis = smoothstep(-1.5, 2.5, sceneViewDepth() - vDepth);
  float a = g * vInt * vis;
  if (a < 0.0005) discard;
  float fk = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth - uFogLin * vDepth);
  gl_FragColor = vec4(uColor * (1.0 - fk) * a, a);
}
`;

const additive = {
  blending: CustomBlending,
  blendEquation: AddEquation,
  blendSrc: OneFactor,
  blendDst: OneFactor,
  blendSrcAlpha: OneFactor,
  blendDstAlpha: OneFactor,
  depthTest: false,
  depthWrite: false,
  transparent: true,
  toneMapped: false,
  fog: false,
};

function shared() {
  const U = particleUniforms;
  return {
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
  };
}

const HALF_ANGLE = 0.2;

function coneGeometry(segments = 20): BufferGeometry {
  // every triangle owns its apex vertex (carrying the normal of its own mid-segment), so the interpolated normal is
  // right all the way to the apex and the facing term fades the silhouette to nothing
  const g = new BufferGeometry();
  const pos: number[] = [];
  const nor: number[] = [];
  const cosT = Math.cos(HALF_ANGLE);
  const sinT = Math.sin(HALF_ANGLE);
  const nAt = (a: number): number[] => [Math.cos(a) * cosT, Math.sin(a) * cosT, -sinT];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    pos.push(0, 0, 0, Math.cos(a0), Math.sin(a0), 1, Math.cos(a1), Math.sin(a1), 1);
    nor.push(...nAt((a0 + a1) / 2), ...nAt(a0), ...nAt(a1));
  }
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('aN', new BufferAttribute(new Float32Array(nor), 3));
  return g;
}

export const MAX_BEAMS = 12;
export const MAX_HALOS = 24;

export class BeamField {
  readonly mesh: InstancedMesh;
  private readonly intensity: InstancedBufferAttribute;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();
  private readonly p = new Vector3();
  private readonly fwd = new Vector3(0, 0, 1);
  private readonly up = new Vector3(0, 1, 0);
  private count = 0;

  constructor() {
    const geo = coneGeometry();
    this.intensity = new InstancedBufferAttribute(new Float32Array(MAX_BEAMS), 1);
    this.intensity.setUsage(DynamicDrawUsage);
    geo.setAttribute('aI', this.intensity);
    const mat = new ShaderMaterial({
      ...additive,
      name: 'xr.fx.beams',
      uniforms: { ...shared(), uColor: { value: new Vector3(1, 0.93, 0.8) } },
      vertexShader: beamVertex,
      fragmentShader: particleCommon + beamFragment,
      side: DoubleSide,
    });
    this.mesh = new InstancedMesh(geo, mat, MAX_BEAMS);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.name = 'xr.fx.beams';
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  begin(): void {
    this.count = 0;
  }

  /** A beam from (x,y,z) along unit direction (dx,dy,dz), `length` metres long, with the given strength. */
  add(x: number, y: number, z: number, dx: number, dy: number, dz: number, length: number, strength: number): void {
    if (this.count >= MAX_BEAMS || strength < 0.0003) return;
    // orientation: local +z along the beam
    this.p.set(dx, dy, dz).normalize();
    this.q.setFromUnitVectors(this.fwd, this.p);
    const r = Math.tan(HALF_ANGLE) * length;
    this.s.set(r, r, length);
    this.p.set(x, y, z);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(this.count, this.m);
    (this.intensity.array as Float32Array)[this.count] = strength;
    this.count++;
  }

  end(): void {
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.intensity.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as ShaderMaterial).dispose();
    this.mesh.dispose();
  }
}

export class HaloField {
  readonly mesh: InstancedMesh;
  private readonly intensity: InstancedBufferAttribute;
  private readonly m = new Matrix4();
  private readonly s = new Vector3();
  private readonly p = new Vector3();
  private readonly q = new Quaternion();
  private count = 0;

  constructor() {
    const geo = new PlaneGeometry(1, 1);
    this.intensity = new InstancedBufferAttribute(new Float32Array(MAX_HALOS), 1);
    this.intensity.setUsage(DynamicDrawUsage);
    geo.setAttribute('aI', this.intensity);
    const mat = new ShaderMaterial({
      ...additive,
      name: 'xr.fx.halos',
      uniforms: { ...shared(), uColor: { value: new Vector3(1, 0.8, 0.52) } },
      vertexShader: haloVertex,
      fragmentShader: particleCommon + haloFragment,
      side: DoubleSide,
    });
    this.mesh = new InstancedMesh(geo, mat, MAX_HALOS);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.name = 'xr.fx.halos';
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  begin(): void {
    this.count = 0;
  }

  /** A halo of the given radius (m) at a lamp head. */
  add(x: number, y: number, z: number, radius: number, strength: number): void {
    if (this.count >= MAX_HALOS || strength < 0.0003) return;
    this.p.set(x, y, z);
    this.s.set(radius, radius, 1);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(this.count, this.m);
    (this.intensity.array as Float32Array)[this.count] = strength;
    this.count++;
  }

  end(): void {
    this.mesh.count = this.count;
    this.mesh.visible = this.count > 0;
    if (this.count > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.intensity.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as ShaderMaterial).dispose();
    this.mesh.dispose();
  }
}
