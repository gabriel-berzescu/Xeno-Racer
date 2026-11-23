/**
 * The hologram of a megacity circuit (`NeonDef.hologram`): a ring of light hovering over a stretch of the road (the Halo, the banked
 * carousel: the cars drive round under it). Two bands, one over each edge of the road and a little higher than the other, drawn as
 * light alone: additive, see-through, rows of segments like a display's with a scan-line shimmer over them, brighter where a band is
 * seen edge-on (a sheet of light, not a painted wall). The outer band turns one way and the inner one the other: the turning is a
 * scroll of the pattern from one clock. They follow the road's own line and climb, well over the lamps and the fences, so nothing
 * the city builds beside the road can stand in them, and they fade out at both ends. One draw call.
 */
import * as THREE from 'three';
import type { EnvironmentState } from '../../core/contracts';
import { resolveMark } from '../plan';
import type { NeonDef } from '../types';
import type { Ctx } from './ctx';

/** Metres of road per row of the bands, and the length the bands fade in and out over at their ends. */
const STEP = 3;
const FADE = 45;
/** Radiance of the brightest segments at night (scene units). */
const LEVEL = 0.6;

const VERT = /* glsl */ `
attribute vec4 aBand;   // metres per segment, turning speed (segments / s), which band, 0 at the ends of the band .. 1
varying vec2 vUv;
varying vec4 vBand;
varying vec3 vN;
varying vec3 vV;
varying float vDist;
void main() {
  vUv = uv;
  vBand = aBand;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = cameraPosition - wp.xyz;
  vec4 mv = viewMatrix * wp;
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uLevel;
uniform float uHaze;
uniform vec3 uColA;
uniform vec3 uColB;
varying vec2 vUv;
varying vec4 vBand;
varying vec3 vN;
varying vec3 vV;
varying float vDist;
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  float u = vUv.x / vBand.x + uTime * vBand.y;
  float v = vUv.y;
  // three rows of segments, each with its own rhythm, between two lines of light
  float row = floor(v * 3.0);
  float fv = fract(v * 3.0);
  float grain = row == 1.0 ? 1.0 : 3.0;
  float cu = u * grain + row * 7.0;
  float id = floor(cu);
  float fu = fract(cu);
  float h = hash(vec2(mod(id, 509.0), row + vBand.z * 5.0));
  float lit = step(row == 1.0 ? 0.45 : 0.62, h);
  float seg = lit * smoothstep(0.0, 0.06, fu) * (1.0 - smoothstep(0.9, 0.96, fu)) * smoothstep(0.12, 0.2, fv) * (1.0 - smoothstep(0.8, 0.88, fv));
  // some segments breathe
  seg *= 0.55 + 0.45 * sin(uTime * (0.6 + 2.0 * h) + h * 40.0);
  float lines = exp(-pow((v - 0.035) / 0.016, 2.0)) + exp(-pow((v - 0.965) / 0.016, 2.0));
  // the scan lines of the display, drifting up, and a slow swell that travels round the band
  float scan = 0.72 + 0.28 * sin(v * 150.0 - uTime * 5.0);
  float swell = 0.75 + 0.25 * sin(vUv.x * 0.045 - uTime * 0.35 + vBand.z * 2.0);
  // a sheet of light: more of it along the line of sight where it is seen edge-on
  float facing = abs(dot(normalize(vN), normalize(vV)));
  float sheet = 0.55 / (0.25 + facing);
  float a = (seg * 0.75 + lines * 0.9 + 0.035) * scan * swell * sheet * vBand.w;
  vec3 col = mix(uColA, uColB, smoothstep(0.2, 0.8, 0.5 + 0.5 * sin(vUv.x * 0.021 + uTime * 0.11 + vBand.z * 3.1)));
  gl_FragColor = vec4(col * (a * uLevel * exp(-vDist * uHaze)), 1.0);
}
`;

export function buildHologram(ctx: Ctx, def: NeonDef): THREE.Mesh | null {
  const h = def.hologram;
  if (!h) return null;
  const rt = ctx.rt;
  const s0 = resolveMark(rt.plan.marks, rt.length, h.from);
  let len = resolveMark(rt.plan.marks, rt.length, h.to) - s0;
  if (len <= 0) len += rt.length;
  const height = h.height ?? 13;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const band: number[] = [];
  const idx: number[] = [];
  const p = new THREE.Vector3();
  // a band: `out` m beyond the edge of the asphalt on one side (sgn: left 1, right -1), from y0 to y1 over the road's middle
  const add = (sgn: 1 | -1, out: number, y0: number, y1: number, cell: number, speed: number, id: number): void => {
    const base = pos.length / 3;
    const rows = Math.max(2, Math.ceil(len / STEP));
    for (let i = 0; i <= rows; i++) {
      const along = (len * i) / rows;
      const s = rt.wrapS(s0 + along);
      const k = Math.min(rt.count - 1, Math.round(s / rt.spacing));
      const d = sgn * ((sgn > 0 ? rt.L.W[k] : rt.R.W[k]) + out);
      rt.pointAt(s, 0, p);
      const y = p.y;
      rt.pointAt(s, d, p);
      const ends = Math.min(1, along / FADE, (len - along) / FADE);
      const fade = ends * ends * (3 - 2 * ends);
      for (const [yy, v] of [[y0, 0], [y1, 1]] as const) {
        pos.push(p.x, y + yy, p.z);
        nor.push(rt.HLX[k], 0, rt.HLZ[k]);
        uv.push(along, v);
        band.push(cell, speed, id, fade);
      }
    }
    for (let i = 0; i < rows; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  };
  // (on the outside of a bend the road is banked up toward the band: the outer one is the lower and the taller of the two)
  const turn = rt.curvature[Math.min(rt.count - 1, Math.round(rt.wrapS(s0 + len / 2) / rt.spacing))] > 0 ? 1 : -1;
  add(turn > 0 ? -1 : 1, 2.2, height, height + 4.6, 5.2, 0.5, 0);
  add(turn > 0 ? 1 : -1, 3.2, height + 4.4, height + 7.4, 3.9, -0.7, 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aBand', new THREE.Float32BufferAttribute(band, 4));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const colors = h.colors ?? [0xb45cff, 0x16e0bd];
  const uniforms = {
    uTime: { value: 0 },
    uLevel: { value: 0 },
    uHaze: { value: 0.0005 },
    uColA: { value: new THREE.Color(colors[0]) },
    uColB: { value: new THREE.Color(colors[1]) },
  };
  const mat = new THREE.ShaderMaterial({ name: 'neonHologram', uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneFactor;
  mat.blendSrcAlpha = THREE.ZeroFactor;
  mat.blendDstAlpha = THREE.OneFactor;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'neon_hologram';
  mesh.renderOrder = 4;
  ctx.disposables.push(geo, mat);
  ctx.updaters.push((dt) => {
    uniforms.uTime.value += dt;
  });
  ctx.envListeners.push((env: EnvironmentState) => {
    // a hologram is washed out by daylight: it comes up with the dusk
    const kk = Math.min(1, Math.max(0, (env.darkness - 0.3) / 0.5));
    uniforms.uLevel.value = LEVEL * kk;
    uniforms.uHaze.value = 0.0005 + 0.002 * env.rain;
    mesh.visible = kk > 0.01;
  });
  return mesh;
}
