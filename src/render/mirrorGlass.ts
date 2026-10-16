/**
 * The two mirror shaders (owner: render).
 *
 *  - Glass: the material of the live mirror glass in the cockpit. It is an ordinary object of the scene, drawn in the HDR
 *    buffer, so it shows the mirror render target's linear radiance (scaled by the glass's reflectance) and the whole
 *    post chain (bloom, tone mapping, the night grade, SMAA) treats it like every other pixel: headlights behind you
 *    bloom in it, a low sun flares in it, the picture is graded like the windscreen's. In rain it grows water beads on
 *    its face. `XR_SCREEN` makes the dash display of the prototype: a camera feed with a pixel grid, brighter than glass.
 *  - Strip: the HUD mirror (hood and bumper views). It is drawn on the canvas after the post chain, so it grades its own
 *    picture with the same exposure, tone mapping and grade code as the final effect (GRADE_GLSL), in a chamfered frame
 *    like the rest of the HUD.
 *
 * Both sample the target flipped horizontally: a mirror image.
 */
import { GRADE_GLSL } from './effects-post';

export const glassVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const glassFragment = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uTint;      // reflectance (how much of the road's light the glass returns)
uniform float uRain;     // 0..1
uniform float uTime;
uniform vec2 uSize;      // glass size in metres
varying vec2 vUv;

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

// A grid of water beads. Each is a tiny lens: inside it the picture is turned around and shrunk (it shows a wider field,
// upside down), so it reads as a drop, not as a ring. Returns xy = the shift of the sample point in uv, z = coverage,
// w = a thin bright edge.
vec4 beads(vec2 uv, vec2 scale, float cells, float density, float seed) {
  vec2 q = uv * scale * cells;
  vec2 id = floor(q);
  vec2 f = fract(q) - 0.5;
  vec3 h = hash33(vec3(id, seed));
  if (h.x > density) return vec4(0.0);
  // a bead swells, holds and bursts
  float age = fract(uTime * (0.03 + 0.05 * h.y) + h.z);
  float grow = smoothstep(0.0, 0.25, age) * (1.0 - smoothstep(0.9, 1.0, age));
  vec2 c = (h.yz - 0.5) * 0.3;
  vec2 d = f - c;
  float r = (0.17 + 0.1 * h.x / max(density, 1e-3)) * grow;
  float l = length(d) / max(r, 1e-3);
  float m = 1.0 - smoothstep(0.86, 1.0, l);
  // the lens samples the scene on the far side of its centre, 1.6 radii out: turned around and wider
  vec2 shift = -d / (scale * cells) * 2.6 * m;
  float edge = smoothstep(0.72, 0.97, l) * m;
  return vec4(shift, m, edge);
}

void main() {
  vec2 uv = vec2(1.0 - vUv.x, vUv.y);
  vec3 rain = vec3(0.0);
  float edge = 0.0;
  if (uRain > 0.02) {
    // beads are laid out in glass metres so they stay round on a wide mirror: about 2.5 mm to a cell at the finest layer
    vec2 scale = uSize * 24.0;
    vec4 a = beads(vUv, scale, 1.0, 0.12 * uRain, 3.0);
    vec4 b = beads(vUv + 0.37, scale, 2.0, 0.28 * uRain, 11.0);
    vec4 c = beads(vUv + 0.71, scale, 4.5, 0.45 * uRain, 23.0);
    uv += (a.xy + b.xy + c.xy) * vec2(-1.0, 1.0);
    rain = vec3(max(a.z, max(b.z, c.z)));
    edge = max(a.w, max(b.w, c.w));
  }
  vec3 col = texture2D(uMap, clamp(uv, 0.002, 0.998)).rgb;
  col = min(col, vec3(48.0));
#ifdef XR_SCREEN
  // a display: a faint pixel grid, a little cooler and brighter than a mirror, with the camera's vignette
  vec2 g = fract(vUv * vec2(160.0, 64.0));
  float grid = 0.9 + 0.1 * smoothstep(0.0, 0.25, min(g.x, g.y));
  vec2 e = abs(vUv * 2.0 - 1.0);
  float vig = 1.0 - 0.45 * smoothstep(0.55, 1.15, length(e * vec2(0.9, 1.0)));
  col = col * grid * vig * 1.15 + vec3(0.002, 0.004, 0.006);
#else
  vec2 e = abs(vUv * 2.0 - 1.0);
  // the glass darkens toward its rim, where it curves away
  float edgeDark = 1.0 - 0.3 * smoothstep(0.72, 1.0, max(e.x, e.y));
  col *= edgeDark;
#endif
  col = col * uTint;
  // beads: the water darkens its own edge a little and catches a trace of sky light on it
  col = col * (1.0 - 0.3 * edge) + vec3(0.03, 0.035, 0.04) * edge * uTint;
  gl_FragColor = vec4(col, 1.0);
}
`;

export const stripVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const stripFragment = /* glsl */ `
uniform sampler2D uMap;
uniform vec2 uSize;     // the strip on the canvas, in drawing-buffer pixels
uniform float uAlpha;   // 0..1 fade
uniform float uFlip;
uniform float uPx;      // one CSS pixel in drawing-buffer pixels (the frame scales with the picture)
varying vec2 vUv;
${GRADE_GLSL}

void main() {
  vec2 pos = vUv * uSize;
  float u = uPx;
  // chamfered frame: distance to the nearest edge or corner cut, in pixels
  vec2 q = min(pos, uSize - pos);
  float cut = 14.0 * u;
  float edge = min(min(q.x, q.y), (q.x + q.y - cut) * 0.70710678);
  float aa = 0.8;
  float inside = clamp(edge / aa + 0.5, 0.0, 1.0);
  if (inside <= 0.0) discard;

  float border = 2.5 * u;
  vec2 uvm = vec2(mix(vUv.x, 1.0 - vUv.x, uFlip), vUv.y);
  vec3 scene = min(texture2D(uMap, uvm).rgb, vec3(48.0));
  vec3 col = xrGrade(scene);
  // mirror glass is a little darker than the world, and darkens toward its edges
  vec2 e = abs(vUv * 2.0 - 1.0);
  col *= 0.92 - 0.25 * smoothstep(0.7, 1.0, max(e.x, e.y * 1.4));

  // bezel: dark, with a faint highlight on its inner edge and a teal line along the top like the HUD panels
  float bez = 1.0 - smoothstep(border - aa, border + aa, edge);
  vec3 frame = vec3(0.016, 0.019, 0.026);
  frame += vec3(0.5) * smoothstep(border * 1.5, border * 0.9, edge) * smoothstep(border * 0.4, border * 0.9, edge) * 0.12;
  col = mix(col, frame, bez);
  float teal = smoothstep(uSize.y - 3.0 * u - aa, uSize.y - 3.0 * u + aa, pos.y) * (1.0 - smoothstep(0.0, 0.7, vUv.x));
  col = mix(col, vec3(0.086, 0.878, 0.741), teal * 0.9);

  gl_FragColor = vec4(srgbEncode(clamp(col, 0.0, 1.0)), inside * uAlpha);
}
`;
