/**
 * The event's name in the air (`HoverDef.banner`): a slim banner of light hovering high across the road, the letters drawn into a
 * canvas when the scene is built. It is light and nothing else: additive, see-through, faint by day and luminous after dark, and it
 * reads the right way round from both sides (two faces, back to back). One draw call.
 */
import * as THREE from 'three';
import type { EnvironmentState } from '../../core/contracts';
import { resolveMark } from '../plan';
import type { HoverDef } from '../types';
import type { Ctx } from './ctx';

const FONT = '"Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif';
/** Radiance of the letters by day and at night (scene units). */
const DAY = 0.55;
const NIGHT = 1.15;

/** White letters, widely spaced, between two hairlines; what follows the last `·` (the year) in the accent colour. */
function bannerTexture(text: string, accent: string): THREE.CanvasTexture {
  const W = 2048;
  const H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  const size = 62;
  g.font = `600 ${size}px ${FONT}`;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  const chars = [...text.toUpperCase()];
  const widths = chars.map((ch) => g.measureText(ch).width);
  // the widest letter-spacing that leaves a margin at both ends
  const natural = widths.reduce((a, b) => a + b, 0);
  const space = Math.max(0, Math.min(size * 0.42, (W * 0.9 - natural) / Math.max(1, chars.length - 1)));
  const total = natural + space * (chars.length - 1);
  const squeeze = Math.min(1, (W * 0.9) / total);
  const cut = chars.lastIndexOf('·');
  let x = (W - total * squeeze) / 2;
  chars.forEach((ch, i) => {
    g.fillStyle = cut >= 0 && i >= cut ? accent : '#ffffff';
    g.save();
    g.translate(x, H / 2 + 2);
    g.scale(squeeze, 1);
    g.fillText(ch, 0, 0);
    g.restore();
    x += (widths[i] + space) * squeeze;
  });
  // the hairlines, fading out toward the ends
  for (const y of [14, H - 16]) {
    const gr = g.createLinearGradient(0, 0, W, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(0.12, 'rgba(255,255,255,0.75)');
    gr.addColorStop(0.88, 'rgba(255,255,255,0.75)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, y, W, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

const VERT = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 p = position;
  p.y += 0.12 * sin(uTime * 0.27);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uLevel;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec3 t = texture2D(uMap, vUv).rgb;
  // the sheet the letters stand in: hardly there, a little more of it toward the middle, and a slow breath through all of it
  float ends = smoothstep(0.0, 0.1, vUv.x) * (1.0 - smoothstep(0.9, 1.0, vUv.x));
  float sheet = 0.035 * ends * (1.0 - abs(vUv.y - 0.5) * 1.2);
  float breath = 0.93 + 0.07 * sin(uTime * 0.6 + vUv.x * 5.0);
  gl_FragColor = vec4((t + vec3(0.8, 0.88, 1.0) * sheet) * (uLevel * breath), 1.0);
}
`;

export function buildBanner(ctx: Ctx, def: HoverDef): { mesh: THREE.Mesh; triangles: number } | null {
  const b = def.banner;
  if (!b) return null;
  const rt = ctx.rt;
  const s = resolveMark(rt.plan.marks, rt.length, b.at);
  const k = Math.round(s / rt.spacing) % rt.count;
  const width = b.width ?? 46;
  const tall = width / 16;
  const y0 = rt.py[k] + (b.height ?? 16);
  // across the road, over the middle of what lies between the barriers
  const mid = (rt.L.wall[k] - rt.R.wall[k]) / 2;
  const cx = rt.X[k] + rt.HLX[k] * mid;
  const cz = rt.Z[k] + rt.HLZ[k] * mid;
  const lx = rt.HLX[k];
  const lz = rt.HLZ[k];
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  // the face the cars come toward reads from their left to their right; the other face the other way round
  for (const face of [0, 1]) {
    const base = pos.length / 3;
    for (const [su, sv] of [[-1, 0], [1, 0], [1, 1], [-1, 1]] as const) {
      pos.push(cx + lx * su * (width / 2), y0 + sv * tall, cz + lz * su * (width / 2));
      // (left of the road is u = 0 for the cars that come: su = 1 is the left)
      uv.push(face === 0 ? (1 - su) / 2 : (1 + su) / 2, sv);
    }
    if (face === 0) idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    else idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  // the accent, lifted toward white so that it reads as light
  const ac = new THREE.Color(def.accent ?? rt.info.color).lerp(new THREE.Color(0xffffff), 0.35);
  const tex = bannerTexture(b.text, `#${ac.getHexString()}`);
  const uniforms = { uMap: { value: tex }, uLevel: { value: DAY }, uTime: { value: 0 } };
  const mat = new THREE.ShaderMaterial({ name: 'hoverBanner', uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, fog: false, toneMapped: false, side: THREE.FrontSide });
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneFactor;
  mat.blendSrcAlpha = THREE.ZeroFactor;
  mat.blendDstAlpha = THREE.OneFactor;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'hover_banner';
  mesh.renderOrder = 4;
  ctx.disposables.push(geo, mat, tex);
  ctx.updaters.push((dt) => {
    uniforms.uTime.value += dt;
  });
  ctx.envListeners.push((env: EnvironmentState) => {
    const kk = Math.min(1, Math.max(0, (env.darkness - 0.15) / 0.7));
    uniforms.uLevel.value = DAY + (NIGHT - DAY) * kk;
  });
  return { mesh, triangles: 4 };
}
