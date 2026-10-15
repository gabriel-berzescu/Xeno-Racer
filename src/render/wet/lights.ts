/**
 * Light list for lit particles (owner: render).
 *
 * Rain, spray and mist are lit in their vertex shaders from a short list of nearby light sources: headlight
 * cones, tail and brake lights, lamp heads. Every frame the effects system fills the list with the sources
 * closest to the camera; the shaders sum them per particle (see LIGHTS_GLSL).
 */
import { Vector4 } from 'three';

export const MAX_LIGHTS = 12;

/** Uniforms shared by every material that uses LIGHTS_GLSL. */
export const lightUniforms = {
  /** xyz = position, w = reach in metres (0 = unused slot). */
  uLP: { value: Array.from({ length: MAX_LIGHTS }, () => new Vector4()) },
  /** rgb = colour * intensity, w = cone cosine (>= 1: omnidirectional). */
  uLC: { value: Array.from({ length: MAX_LIGHTS }, () => new Vector4()) },
  /** xyz = cone axis (unit), w = cone edge softness (cosine units). */
  uLD: { value: Array.from({ length: MAX_LIGHTS }, () => new Vector4()) },
};

export const LIGHTS_GLSL = /* glsl */ `
#define XR_LIGHTS ${MAX_LIGHTS}
uniform vec4 uLP[XR_LIGHTS];
uniform vec4 uLC[XR_LIGHTS];
uniform vec4 uLD[XR_LIGHTS];

// Radiance a small scattering particle at world position p gets from the light list.
vec3 xrLights(vec3 p) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < XR_LIGHTS; i++) {
    float reach = uLP[i].w;
    if (reach <= 0.0) continue;
    vec3 d = p - uLP[i].xyz;
    float r2 = dot(d, d);
    if (r2 > reach * reach) continue;
    float dist = sqrt(r2);
    float att = 1.0 / (1.0 + r2 / (reach * reach * 0.012)) * (1.0 - smoothstep(reach * 0.55, reach, dist));
    float cone = 1.0;
    if (uLC[i].w < 0.999) {
      float c = dot(d / max(dist, 1e-3), uLD[i].xyz);
      cone = smoothstep(uLC[i].w, uLC[i].w + uLD[i].w, c);
    }
    acc += uLC[i].rgb * (att * cone);
  }
  return acc;
}
`;

export interface LightSource {
  x: number;
  y: number;
  z: number;
  reach: number;
  r: number;
  g: number;
  b: number;
  /** Cone axis and cosine of the half angle; cone >= 1 means omnidirectional. */
  dx: number;
  dy: number;
  dz: number;
  cone: number;
  soft: number;
  /** Squared distance to the camera, filled by the collector for sorting. */
  d2: number;
}

export function makeSource(): LightSource {
  return { x: 0, y: 0, z: 0, reach: 0, r: 0, g: 0, b: 0, dx: 0, dy: 0, dz: 1, cone: 1, soft: 0, d2: 0 };
}

/** Collects candidate lights over a frame, keeps the nearest MAX_LIGHTS and uploads them. */
export class LightCollector {
  private readonly pool: LightSource[] = [];
  private readonly picked: LightSource[] = [];
  private used = new Uint8Array(64);
  private count = 0;

  /** Start a frame. */
  begin(): void {
    this.count = 0;
  }

  /** Add a source (copied). Returns the slot for further tweaking. */
  add(x: number, y: number, z: number, reach: number, r: number, g: number, b: number, dx = 0, dy = 0, dz = 1, cone = 1, soft = 0.1): LightSource {
    let s = this.pool[this.count];
    if (!s) {
      s = makeSource();
      this.pool[this.count] = s;
    }
    this.count++;
    s.x = x;
    s.y = y;
    s.z = z;
    s.reach = reach;
    s.r = r;
    s.g = g;
    s.b = b;
    s.dx = dx;
    s.dy = dy;
    s.dz = dz;
    s.cone = cone;
    s.soft = soft;
    s.d2 = 0;
    return s;
  }

  /** Pick the sources that matter most for the camera and write the uniforms. */
  commit(cx: number, cy: number, cz: number): void {
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const s = this.pool[i];
      const dx = s.x - cx, dy = s.y - cy, dz = s.z - cz;
      // a light matters by its brightness over its distance; the camera-distance sort keeps the nearest ones
      s.d2 = (dx * dx + dy * dy + dz * dz) / Math.max(0.05, (s.r + s.g + s.b) * (s.reach / 10));
    }
    const picked = this.picked;
    picked.length = 0;
    if (this.used.length < n) this.used = new Uint8Array(n * 2);
    const used = this.used;
    used.fill(0, 0, n);
    // partial selection sort: at most MAX_LIGHTS passes over a short list
    for (let k = 0; k < Math.min(MAX_LIGHTS, n); k++) {
      let best = -1;
      let bd = Infinity;
      for (let i = 0; i < n; i++) {
        if (!used[i] && this.pool[i].d2 < bd) {
          bd = this.pool[i].d2;
          best = i;
        }
      }
      if (best < 0) break;
      used[best] = 1;
      picked.push(this.pool[best]);
    }
    const P = lightUniforms.uLP.value;
    const C = lightUniforms.uLC.value;
    const D = lightUniforms.uLD.value;
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const s = picked[i];
      if (!s) {
        P[i].set(0, 0, 0, 0);
        C[i].set(0, 0, 0, 1);
        continue;
      }
      P[i].set(s.x, s.y, s.z, s.reach);
      C[i].set(s.r, s.g, s.b, s.cone);
      D[i].set(s.dx, s.dy, s.dz, s.soft);
    }
  }
}
