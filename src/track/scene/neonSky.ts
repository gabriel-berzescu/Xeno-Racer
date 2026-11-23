/**
 * The traffic in the sky of a megacity: a few straight lanes high between the towers, crossing over the circuit, with small lights
 * moving along them both ways, white ahead and red behind. One instanced draw call of camera-facing sprites, additive, moved in the
 * vertex shader from one clock. It is meant to be noticed, not watched: a city that is alive up there.
 */
import * as THREE from 'three';
import type { EnvironmentState } from '../../core/contracts';
import { mulberry32 } from '../math';
import type { NeonDef } from '../types';
import type { Ctx } from './ctx';

/** Metres between two craft of a lane, on average, and their speed (m/s). */
const GAP = 85;
const SPEED = 34;
/** A lamp's size (m), and the least it is drawn at (radians of the view: a point of light never falls between the pixels). */
const SIZE = 1.1;
const MIN_ANGLE = 0.0017;
/** Radiance of a headlamp at night (scene units). */
const LEVEL = 3.2;

const VERT = /* glsl */ `
uniform float uTime;
uniform float uLevel;
uniform float uHaze;
attribute vec4 aFrom;   // where the lane starts (xyz), the craft's place along it at time 0 (w, m)
attribute vec4 aDir;    // the lane's direction (xyz), the craft's speed (w, m/s)
attribute vec3 aCraft;  // the lane's length (m), 0 = headlamp / 1 = tail lamp, how bright
varying vec2 vUv;
varying vec3 vCol;
void main() {
  float len = aCraft.x;
  float tail = aCraft.y;
  float u = mod(aFrom.w + aDir.w * uTime, len);
  vec3 p = aFrom.xyz + aDir.xyz * (u - tail * 7.0);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float dist = max(-mv.z, 1.0);
  // a headlamp is seen from ahead of the craft, a tail lamp from behind it
  float ahead = dot(normalize(cameraPosition - p), aDir.xyz);
  float seen = smoothstep(-0.2, 0.3, mix(ahead, -ahead, tail));
  // the lane fades in and out at its ends
  float ends = smoothstep(0.0, 160.0, u) * (1.0 - smoothstep(len - 160.0, len, u));
  float size = max(${SIZE.toFixed(2)}, dist * ${MIN_ANGLE.toFixed(4)});
  float spread = ${SIZE.toFixed(2)} / size;
  mv.xy += position.xy * size;
  gl_Position = projectionMatrix * mv;
  vec3 lamp = mix(vec3(0.82, 0.92, 1.0), vec3(1.0, 0.07, 0.05), tail);
  vCol = lamp * (uLevel * aCraft.z * seen * ends * spread * spread * exp(-dist * uHaze));
  vUv = position.xy;
}
`;

const FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
void main() {
  float d2 = dot(vUv, vUv);
  float a = exp(-d2 * 6.0) - 0.0025;
  if (a <= 0.0) discard;
  gl_FragColor = vec4(vCol * a, 1.0);
}
`;

export function buildSkyTraffic(ctx: Ctx, def: NeonDef): THREE.Mesh | null {
  const lanes = Math.min(8, Math.floor(def.skyLanes ?? 0));
  if (lanes <= 0) return null;
  const rt = ctx.rt;
  const b = rt.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const half = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 700;
  const rng = mulberry32((rt.def.seed ^ 0x51f15e) >>> 0);
  const from: number[] = [];
  const dir: number[] = [];
  const craft: number[] = [];
  const base = rng() * Math.PI;
  for (let k = 0; k < lanes; k++) {
    // lanes fan round the compass, each past the middle of the circuit at its own distance and height
    const ang = base + (Math.PI * (k + 0.2 + 0.6 * rng())) / lanes;
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    const off = (rng() - 0.5) * 0.55 * Math.min(b.maxX - b.minX, b.maxZ - b.minZ);
    const y = b.maxY + 60 + (150 * (k + rng() * 0.6)) / Math.max(1, lanes - 0.4);
    for (const way of [1, -1]) {
      // the two ways fly side by side, one a little over the other
      const px = cx - dz * (off + way * 9) - dx * way * half;
      const pz = cz + dx * (off + way * 9) - dz * way * half;
      const py = y + way * 5;
      const len = 2 * half;
      const n = Math.round(len / GAP);
      for (let i = 0; i < n; i++) {
        const u = ((i + 0.15 + 0.7 * rng()) / n) * len;
        const v = SPEED * (0.85 + 0.3 * rng());
        const bright = 0.55 + 0.45 * rng();
        for (const tail of [0, 1]) {
          from.push(px, py, pz, u);
          dir.push(dx * way, 0, dz * way, v);
          craft.push(len, tail, tail ? bright * 0.8 : bright);
        }
      }
    }
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute('aFrom', new THREE.InstancedBufferAttribute(new Float32Array(from), 4));
  geo.setAttribute('aDir', new THREE.InstancedBufferAttribute(new Float32Array(dir), 4));
  geo.setAttribute('aCraft', new THREE.InstancedBufferAttribute(new Float32Array(craft), 3));
  geo.instanceCount = from.length / 4;
  const uniforms = { uTime: { value: 0 }, uLevel: { value: 0 }, uHaze: { value: 0.0006 } };
  const mat = new THREE.ShaderMaterial({ name: 'neonSkyTraffic', uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, fog: false, toneMapped: false });
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneFactor;
  mat.blendSrcAlpha = THREE.ZeroFactor;
  mat.blendDstAlpha = THREE.OneFactor;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'neon_sky_traffic';
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  ctx.disposables.push(geo, mat);
  ctx.updaters.push((dt) => {
    uniforms.uTime.value += dt;
  });
  ctx.envListeners.push((env: EnvironmentState) => {
    // lamps in the sky show from dusk on; rain hides the far ones
    const k = Math.min(1, Math.max(0, (env.darkness - 0.3) / 0.5));
    uniforms.uLevel.value = LEVEL * k;
    uniforms.uHaze.value = 0.0005 + 0.0022 * env.rain;
    mesh.visible = k > 0.01;
  });
  return mesh;
}
