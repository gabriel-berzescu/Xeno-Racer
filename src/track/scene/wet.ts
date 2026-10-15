/**
 * Wet-weather response of the track scene (owner: track scene; driven by EnvironmentState.wetness / rain).
 *
 * Three layers, all zero-cost when dry:
 *  1. Shared uniforms (`WetUniforms`) that the road and terrain shaders read: film wetness, rain intensity,
 *     a ripple clock and the tunnel span (the road inside a tunnel stays dry).
 *  2. GLSL helpers: standing-water "depth field" and the expanding rain rings on puddles.
 *  3. A generic tint for every other material of the scene (concrete, steel, tyres, rock, foliage, facades...):
 *     wet surfaces are darker and glossier. Materials opt out with `userData.noWet`, or take over with
 *     `userData.wetShader` when their own shader handles wetness.
 */
import * as THREE from 'three';
import type { EnvironmentState } from '../../core/contracts';
import type { Ctx } from './ctx';

export interface WetUniforms {
  /** Film of water on the surface, 0 dry .. 1 flooded (EnvironmentState.wetness). */
  uWet: { value: number };
  /** Rain intensity (ring density on puddles). */
  uRain: { value: number };
  /** Seconds, advanced by the scene update (frozen while paused). */
  uWTime: { value: number };
  /** Tunnel spans along s (m): (from, to, from2, to2); negative = none. The road inside stays dry. */
  uTunnel: { value: THREE.Vector4 };
  /** The street lamps nearest to the camera (xyz = lamp head, w = reach in m; 0 = unused) and their colour. */
  uLamp: { value: THREE.Vector4[] };
  uLampCol: { value: THREE.Vector3 };
}

export const WET_LAMPS = 8;

export function createWetUniforms(): WetUniforms {
  return {
    uWet: { value: 0 },
    uRain: { value: 0 },
    uWTime: { value: 0 },
    uTunnel: { value: new THREE.Vector4(-1, -1, -1, -1) },
    uLamp: { value: Array.from({ length: WET_LAMPS }, () => new THREE.Vector4()) },
    uLampCol: { value: new THREE.Vector3(7.5, 6.1, 4.4) },
  };
}

/** GLSL declarations shared by the shaders that read WetUniforms. */
export const WET_UNIFORMS_GLSL = /* glsl */ `
uniform float uWet;
uniform float uRain;
uniform float uWTime;
uniform vec4 uTunnel;
uniform vec4 uLamp[${WET_LAMPS}];
uniform vec3 uLampCol;
`;

/**
 * GLSL helpers (need no uniforms of their own; roadLamps needs WET_UNIFORMS_GLSL and vWPos):
 *   wRipple(p, t, amount)   p in metres on the ground; returns (slope.xy, ring brightness)
 *   wTunnelDry(s)           1 inside a tunnel (soft at the portals), 0 outside
 * Rings live inside a grid of ~0.3 m cells (a ring never leaves its cell, so there are no seams); each cell
 * is active with probability `amount`, drops land every 1.2..3 s with a random phase, a ring lasts 0.7 s.
 */
export const WET_HELPERS_GLSL = /* glsl */ `
float wHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 wHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 wRipple(vec2 p, float t, float amount) {
  vec3 acc = vec3(0.0);
  for (int k = 0; k < 2; k++) {
    float scale = k == 0 ? 3.1 : 5.3;
    vec2 q = p * scale + vec2(float(k) * 31.7, float(k) * 17.9);
    vec2 id = floor(q);
    vec2 f = fract(q);
    vec2 h = wHash22(id);
    float on = step(h.x, amount * 0.8);
    float period = 1.2 + 1.8 * h.y;
    float age = fract(t / period + wHash12(id + 3.1)) * period;
    float u = age / 0.7;
    if (on > 0.5 && u < 1.0) {
      vec2 c = 0.38 + 0.24 * wHash22(id + 11.3);
      vec2 dv = f - c;
      float d = length(dv);
      float sz = 0.55 + 0.45 * fract(h.x * 91.7 + h.y * 13.1);
      float r = 0.02 + u * 0.32 * sz;
      float x = (d - r) / (0.04 + 0.05 * u);
      float env = exp(-x * x) * (1.0 - u) * (1.0 - u) * smoothstep(0.0, 0.12, u);
      float slope = cos(x * 2.4) * env;
      acc.xy += (d > 1e-4 ? dv / d : vec2(0.0)) * slope;
      acc.z += env;
    }
  }
  return acc;
}
// Street lamps on a wet road: diffuse light on the dark asphalt plus the long specular streak a lamp leaves on a
// damp surface (Blinn-Phong, normalised; standing water is left to the screen-space reflections).
vec3 roadLamps(vec3 Nw, vec3 V, vec3 albedo, float rough, float puddle) {
  vec3 acc = vec3(0.0);
  float alpha = max(rough * rough, 0.03);
  float shin = min(2.0 / (alpha * alpha) - 2.0, 1500.0);
  float norm = (shin + 2.0) / (8.0 * 3.14159265);
  for (int i = 0; i < ${WET_LAMPS}; i++) {
    float R = uLamp[i].w;
    if (R <= 0.0) continue;
    vec3 L = uLamp[i].xyz - vWPos;
    float d2 = dot(L, L);
    if (d2 > R * R) continue;
    float d = sqrt(d2);
    L /= d;
    float NoL = max(dot(Nw, L), 0.0);
    if (NoL <= 0.0) continue;
    float att = 1.0 / (1.0 + d2 / (R * R * 0.08)) * (1.0 - smoothstep(0.55 * R, R, d));
    float cone = smoothstep(0.2, 0.65, L.y);
    vec3 E = uLampCol * (att * cone);
    vec3 H = normalize(L + V);
    float NoH = max(dot(Nw, H), 0.0);
    float VoH = max(dot(V, H), 0.0);
    float F = 0.02 + 0.98 * pow(clamp(1.0 - VoH, 0.0, 1.0), 5.0);
    acc += E * NoL * (albedo / 3.14159265 + norm * pow(NoH, shin) * F * (1.0 - puddle));
  }
  return acc;
}
float wTunnelDry(float s) {
  float k = 0.0;
  if (uTunnel.x >= 0.0) k = max(k, smoothstep(uTunnel.x - 4.0, uTunnel.x + 12.0, s) * (1.0 - smoothstep(uTunnel.y - 12.0, uTunnel.y + 4.0, s)));
  if (uTunnel.z >= 0.0) k = max(k, smoothstep(uTunnel.z - 4.0, uTunnel.z + 12.0, s) * (1.0 - smoothstep(uTunnel.w - 12.0, uTunnel.w + 4.0, s)));
  return k;
}
`;

const lampDist = new Float64Array(WET_LAMPS);
const lampIdx = new Int32Array(WET_LAMPS);

/** Per-material wetness response (see applyTint). */
export interface WetTint {
  mat: THREE.Material;
  /** Original values. */
  color: THREE.Color | null;
  roughness: number | null;
  envMapIntensity: number | null;
  /** Wet multipliers: albedo and roughness. */
  darken: number;
  gloss: number;
}

/** Default wet response: a darker, glossier surface. */
const DEFAULT_DARKEN = 0.78;
const DEFAULT_GLOSS = 0.72;

type Tintable = THREE.Material & { color?: THREE.Color; roughness?: number; envMapIntensity?: number };

/** Wetness-aware tint for one material. Safe to call twice (the second call is ignored). */
export function registerTint(ctx: Ctx, mat: THREE.Material, darken = DEFAULT_DARKEN, gloss = DEFAULT_GLOSS): void {
  const t = mat as Tintable;
  if (mat.userData.noWet || mat.userData.wetShader || mat.userData.wetTinted) return;
  if (t.color === undefined) return;
  mat.userData.wetTinted = true;
  ctx.wetTints.push({
    mat,
    color: t.color.clone(),
    roughness: typeof t.roughness === 'number' ? t.roughness : null,
    envMapIntensity: typeof t.envMapIntensity === 'number' ? t.envMapIntensity : null,
    darken,
    gloss,
  });
}

/** Apply (or, at wet = 0, restore) the wet look of every registered plain material. */
export function applyWetTints(tints: WetTint[], wet: number): void {
  for (const w of tints) {
    const m = w.mat as Tintable;
    if (w.color && m.color) {
      const k = 1 - (1 - w.darken) * wet;
      m.color.copy(w.color).multiplyScalar(k);
    }
    if (w.roughness !== null && typeof m.roughness === 'number') m.roughness = w.roughness * (1 - (1 - w.gloss) * wet);
    if (w.envMapIntensity !== null && typeof m.envMapIntensity === 'number') m.envMapIntensity = w.envMapIntensity * (1 + 0.5 * wet);
  }
}

/** Collect every plain lit material below `root` that has not claimed its own wet handling. */
export function tintScene(ctx: Ctx, root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const mm = mesh.material;
    if (!mm) return;
    for (const m of Array.isArray(mm) ? mm : [mm]) {
      const t = m as Tintable & { isMeshStandardMaterial?: boolean; isMeshLambertMaterial?: boolean; isMeshPhongMaterial?: boolean; isMeshPhysicalMaterial?: boolean };
      if (!(t.isMeshStandardMaterial || t.isMeshLambertMaterial || t.isMeshPhongMaterial || t.isMeshPhysicalMaterial)) continue;
      // lamps, glass and the lake keep their own look
      if (m.transparent && m.blending !== THREE.NormalBlending) continue;
      registerTint(ctx, m);
    }
  });
}

/**
 * Create the scene's wet state: uniforms, the tunnel span, the environment listener (wetness / rain) and the
 * ripple clock. Called once from the scene builder.
 */
export function setupWet(ctx: Ctx): WetUniforms {
  const u = ctx.wet;
  const spans = (ctx.rt as unknown as { tunnelSpans?: [number, number][] }).tunnelSpans ?? [];
  const v = u.uTunnel.value;
  if (spans[0]) {
    v.x = spans[0][0];
    v.y = spans[0][1];
  }
  if (spans[1]) {
    v.z = spans[1][0];
    v.w = spans[1][1];
  }
  let lastWet = -1;
  ctx.envListeners.push((env: EnvironmentState) => {
    u.uWet.value = env.wetness;
    u.uRain.value = env.rain;
    if (env.wetness !== lastWet) {
      lastWet = env.wetness;
      applyWetTints(ctx.wetTints, env.wetness);
    }
  });
  let darkness = 0;
  ctx.envListeners.push((env: EnvironmentState) => {
    darkness = env.darkness;
  });
  const cam = new THREE.Vector3();
  ctx.updaters.push((dt, camera) => {
    if (u.uWet.value <= 0) return;
    // only advance while it rains (the ripple clock keeps the cost of a dry scene at zero)
    u.uWTime.value += dt;
    // the lamps nearest to the camera light the wet road (see roadLamps); they are on once it gets dark
    const lamps = ctx.lamps;
    const slots = u.uLamp.value;
    if (!lamps || darkness <= 0.45) {
      for (const s of slots) s.w = 0;
      return;
    }
    camera.getWorldPosition(cam);
    const k = Math.min(1, (darkness - 0.45) / 0.4);
    u.uLampCol.value.set(7.5 * k, 6.1 * k, 4.4 * k);
    // keep the 8 nearest (insertion into a tiny sorted list; no allocation)
    const dist = lampDist;
    let n = 0;
    for (let i = 0; i < lamps.length; i += 3) {
      const dx = lamps[i] - cam.x;
      const dz = lamps[i + 2] - cam.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 80 * 80) continue;
      if (n < WET_LAMPS) {
        let j = n++;
        while (j > 0 && dist[j - 1] > d2) {
          dist[j] = dist[j - 1];
          lampIdx[j] = lampIdx[j - 1];
          j--;
        }
        dist[j] = d2;
        lampIdx[j] = i;
      } else if (d2 < dist[WET_LAMPS - 1]) {
        let j = WET_LAMPS - 1;
        while (j > 0 && dist[j - 1] > d2) {
          dist[j] = dist[j - 1];
          lampIdx[j] = lampIdx[j - 1];
          j--;
        }
        dist[j] = d2;
        lampIdx[j] = i;
      }
    }
    for (let j = 0; j < WET_LAMPS; j++) {
      if (j < n) slots[j].set(lamps[lampIdx[j]], lamps[lampIdx[j] + 1], lamps[lampIdx[j] + 2], 46);
      else slots[j].w = 0;
    }
  });
  return u;
}
