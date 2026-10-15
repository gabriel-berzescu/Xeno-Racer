import { LIGHTS_GLSL } from '../wet/lights';

/**
 * Particle shaders (owner: render). All run in the particle pass (post.ts) after the scene has been
 * shaded: they read the composer's stable depth copy (uDepth) for soft intersections, light
 * themselves from the shared environment uniforms and output HDR so bloom picks up the bright ones.
 */

/** Shared GLSL: depth linearisation, scene-depth lookup, fog. Requires particleUniforms to be declared. */
export const particleCommon = /* glsl */ `
uniform sampler2D uDepth;
uniform float uHasDepth;
uniform vec2 uResolution;
uniform vec2 uNearFar;
uniform vec3 uSunDir;
uniform vec3 uSunLight;
uniform vec3 uSkyAmb;
uniform vec3 uGroundAmb;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogLin;

const float PI = 3.14159265359;

float sceneViewDepth() {
  if (uHasDepth < 0.5) return 1.0e6;
  float d = texture2D(uDepth, gl_FragCoord.xy / uResolution).r;
  float n = uNearFar.x;
  float f = uNearFar.y;
  return n * f / (f - d * (f - n));
}

vec3 applyFog(vec3 col, float dist) {
  float k = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist - uFogLin * dist);
  return mix(col, uFogColor, k);
}
`;

// ───────────────────────────── soft smoke / dust puffs ─────────────────────────────

export const puffVertex = /* glsl */ `
attribute vec4 aA;   // world centre xyz, radius
attribute vec4 aB;   // rotation, alpha, age01, atlas tile
attribute vec4 aC;   // albedo rgb, seed
varying vec2 vP;
varying vec4 vB;
varying vec3 vCol;
varying float vSeed;
varying vec3 vView;
varying float vR;
#ifdef LIT
${LIGHTS_GLSL}
varying vec3 vLit;
#endif

void main() {
  vec4 mv = viewMatrix * vec4(aA.xyz, 1.0);
  vView = mv.xyz;
  vR = aA.w;
  vP = position.xy * 2.0;
  vB = aB;
  vCol = aC.rgb;
  vSeed = aC.a;
#ifdef LIT
  vLit = xrLights(aA.xyz);
#endif
  mv.xy += vP * aA.w;
  gl_Position = projectionMatrix * mv;
}
`;

export const puffFragment = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uSoftness;
varying vec2 vP;
varying vec4 vB;
varying vec3 vCol;
varying float vSeed;
varying vec3 vView;
varying float vR;
#ifdef LIT
varying vec3 vLit;
#endif

void main() {
  float r2 = dot(vP, vP);
  if (r2 >= 1.0) discard;

  // noise lookup (rotating texture, per-particle atlas tile)
  float c = cos(vB.x), s = sin(vB.x);
  vec2 q = vec2(c * vP.x - s * vP.y, s * vP.x + c * vP.y) * 0.5 + 0.5;
  float tile = floor(vB.w + 0.5);
  vec2 off = vec2(mod(tile, 2.0), floor(tile * 0.5)) * 0.5;
  vec2 uv = off + clamp(q, 0.01, 0.99) * 0.5;
  vec4 n = texture2D(uAtlas, uv);

  // dissolve with age: density threshold rises, edges stay soft
  float age = vB.z;
  float rad = sqrt(r2);
  float dens = n.a * (0.82 + 0.36 * n.g);
  float thr = age * 0.74;
  float a = smoothstep(thr, thr + 0.38, dens);
  a *= 1.0 - smoothstep(0.5, 1.0, rad);
  a *= vB.y;

  // soft intersection with scene geometry (hard clip if the surface is in front)
  float z = sqrt(max(1.0 - r2, 0.0));
  float depthV = -vView.z;
  float fragZ = depthV - vR * z * 0.9;
  float sceneZ = sceneViewDepth();
  a *= smoothstep(0.0, vR * uSoftness, sceneZ - fragZ);
  // fade when very close to the camera so a puff never fills the lens
  a *= smoothstep(0.3, 3.6, depthV);
  if (a < 0.003) discard;

  // pseudo volume: gentle sphere normal roughened by the noise, lit by sun + sky
  vec3 nrmV = normalize(vec3(vP * 0.8, z) + (n.rgb - 0.5) * 0.9);
  vec3 nrmW = nrmV * mat3(viewMatrix);
  vec3 sunV = mat3(viewMatrix) * uSunDir;
  float wrap = clamp(dot(nrmV, sunV) * 0.38 + 0.62, 0.0, 1.0);
  vec3 amb = mix(uGroundAmb, uSkyAmb, clamp(nrmW.y * 0.5 + 0.5, 0.0, 1.0));
  vec3 viewDirW = normalize(vView) * mat3(viewMatrix);
  float fwd = pow(max(dot(viewDirW, uSunDir), 0.0), 5.0);
  float core = smoothstep(0.15, 0.95, dens) * (1.0 - age * 0.5);
  float variation = 0.9 + 0.2 * n.b;
  vec3 lit = vCol * variation * (uSunLight * (wrap / PI) * (1.0 - 0.3 * core) + amb * (1.0 - 0.18 * core));
  lit += uSunLight * (fwd * 0.09 * (1.0 - core * 0.6)) * vCol;
#ifdef LIT
  // water mist is brighter than smoke: its droplets scatter the whole sky toward the eye; headlights, brake
  // lights and lamps scatter in it too (softly, from every side)
  lit = lit * 1.9 + vCol * vLit * (0.55 + 0.45 * wrap) * (1.0 - 0.4 * core);
#endif
  lit = applyFog(lit, depthV);

  gl_FragColor = vec4(lit * a, a);
}
`;

// ───────────────────────────── water mist (spray) ─────────────────────────────
// Same billboards as the puffs (puffVertex with LIT), but a fine, flat haze instead of a billowing cloud: a smooth
// radial falloff with a little turbulence, lit by the whole sky and by nearby lights.

export const mistFragment = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uSoftness;
varying vec2 vP;
varying vec4 vB;
varying vec3 vCol;
varying float vSeed;
varying vec3 vView;
varying float vR;
varying vec3 vLit;

void main() {
  float r2 = dot(vP, vP);
  if (r2 >= 1.0) discard;
  float rad = sqrt(r2);
  float c = cos(vB.x), s = sin(vB.x);
  vec2 q = vec2(c * vP.x - s * vP.y, s * vP.x + c * vP.y) * 0.5 + 0.5;
  float tile = floor(vB.w + 0.5);
  vec2 off = vec2(mod(tile, 2.0), floor(tile * 0.5)) * 0.5;
  vec4 n = texture2D(uAtlas, off + clamp(q, 0.01, 0.99) * 0.5);
  // smooth body, thinning with age; the noise only roughens it
  float body = pow(1.0 - rad, 1.5) * (0.7 + 0.6 * n.g);
  float a = body * vB.y * (1.0 - 0.5 * vB.z);

  float z = sqrt(max(1.0 - r2, 0.0));
  float depthV = -vView.z;
  float fragZ = depthV - vR * z * 0.9;
  a *= smoothstep(0.0, vR * uSoftness, sceneViewDepth() - fragZ);
  a *= smoothstep(0.3, 3.6, depthV);
  if (a < 0.002) discard;

  vec3 amb = mix(uGroundAmb, uSkyAmb, 0.7);
  vec3 lit = vCol * (amb * 2.1 + uSunLight * (0.14 / PI)) + vCol * vLit * 0.7;
  lit = applyFog(lit, depthV);
  gl_FragColor = vec4(lit * a, a);
}
`;

// ───────────────────────────── sparks (stretched, additive) ─────────────────────────────

export const sparkVertex = /* glsl */ `
attribute vec4 aP;   // world position xyz, width (m)
attribute vec4 aV;   // world velocity xyz, trail length (m)
attribute vec4 aD;   // age01, brightness, seed, unused
varying vec2 vUv;
varying vec4 vD;
varying vec3 vView;
varying float vLen;
#ifdef DROP
${LIGHTS_GLSL}
varying vec3 vLit;
#endif

void main() {
#ifdef DROP
  vLit = xrLights(aP.xyz);
#endif
  vec3 p0 = (viewMatrix * vec4(aP.xyz, 1.0)).xyz;
  vec3 dirW = aV.xyz;
  float sp = length(dirW);
  vec3 tail = aP.xyz - (sp > 1e-4 ? dirW / sp : vec3(0.0, 1.0, 0.0)) * aV.w;
  vec3 p1 = (viewMatrix * vec4(tail, 1.0)).xyz;
  vec2 d2 = p1.xy - p0.xy;
  float dl = length(d2);
  vec2 dir = dl > 1e-5 ? d2 / dl : vec2(0.0, -1.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  // position.x in [-0.5, 0.5] across, position.y in [-0.5, 0.5] along (0 = head, 1 = tail)
  float along = position.y + 0.5;
  vec3 pv = mix(p0, p1, along);
  float w = aP.w * 0.5;
  pv.xy += nrm * position.x * 2.0 * w;
  // never thinner than a pixel at this depth
  vUv = vec2(position.x * 2.0, along);
  vD = aD;
  vView = pv;
  vLen = aV.w;
  gl_Position = projectionMatrix * vec4(pv, 1.0);
}
`;

export const sparkFragment = /* glsl */ `
varying vec2 vUv;
varying vec4 vD;
varying vec3 vView;
varying float vLen;
#ifdef DROP
varying vec3 vLit;
#endif

void main() {
  float across = exp(-vUv.x * vUv.x * 3.2);
  float along = pow(1.0 - vUv.y, 1.6) * smoothstep(0.0, 0.06, vUv.y + 0.02);
  float life = 1.0 - vD.x;
  float heat = life * life;
  vec3 hot = vec3(1.0, 0.95, 0.75);
  vec3 mid = vec3(1.0, 0.52, 0.12);
  vec3 cool = vec3(0.7, 0.12, 0.03);
  vec3 col = mix(cool, mix(mid, hot, smoothstep(0.55, 1.0, heat)), smoothstep(0.0, 0.5, heat));
  float depthV = -vView.z;
  float sceneZ = sceneViewDepth();
  float vis = smoothstep(-0.04, 0.1, sceneZ - depthV);
  float a = across * along * vis;
  if (a < 0.004) discard;
#ifdef DROP
  // flying water: a pale streak that catches the sky light (and any lamp or headlight), blended over the scene
  float da = a * vD.y * (1.0 - vD.x * 0.7);
  vec3 dc = uSkyAmb * 2.4 + vLit * 0.9;
  dc = applyFog(dc, depthV);
  gl_FragColor = vec4(dc * da, da);
#else
  gl_FragColor = vec4(col * vD.y * a * (0.4 + 1.6 * heat), a);
#endif
}
`;

// ───────────────────────────── flames (backfire) ─────────────────────────────

export const flameVertex = /* glsl */ `
attribute vec4 aP;   // tip position xyz, width
attribute vec4 aV;   // direction xyz (unit, world), length
attribute vec4 aD;   // age01, brightness, seed, flash
varying vec2 vUv;
varying vec4 vD;
varying vec3 vView;

void main() {
  vec3 p0 = (viewMatrix * vec4(aP.xyz, 1.0)).xyz;
  vec3 p1 = (viewMatrix * vec4(aP.xyz + aV.xyz * aV.w, 1.0)).xyz;
  float w = aP.w * (1.0 + 0.7 * aD.w);
  vec2 d2 = p1.xy - p0.xy;
  float dl = length(d2);
  vec2 dir = dl > 1e-5 ? d2 / dl : vec2(0.0, 1.0);
  // a flame pointing at the camera collapses to a line: keep a minimum on-screen extent so it reads as a glow
  float L = max(dl, w * 2.4);
  vec2 nrm = vec2(-dir.y, dir.x);
  float along = position.y + 0.5;
  vec3 pv = vec3(p0.xy + dir * (along * L), mix(p0.z, p1.z, along));
  pv.xy += nrm * position.x * 2.0 * w;
  vUv = vec2(position.x * 2.0, along);
  vD = aD;
  vView = pv;
  gl_Position = projectionMatrix * vec4(pv, 1.0);
}
`;

export const flameFragment = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec4 vD;
varying vec3 vView;

void main() {
  float age = vD.x;
  float u = vUv.y;               // 0 at the tip, 1 at the far end
  float taper = mix(1.0, 0.18, u);
  float x = vUv.x / taper;
  // window to exactly zero at the quad's edges: in HDR even a small tail would clip to white and
  // show the quad's rectangle
  float win = (1.0 - smoothstep(0.55, 1.0, abs(vUv.x))) * (1.0 - smoothstep(0.75, 1.0, u));
  float body = exp(-x * x * 3.0) * smoothstep(1.0, 0.0, u) * win;
  vec2 nuv = vec2(vUv.x * 0.35 + vD.z * 3.1, u * 0.9 - age * 1.4 + vD.z * 7.0);
  float flick = texture2D(uAtlas, fract(nuv) * 0.5).b;
  body *= 0.65 + 0.7 * flick;
  float fade = (1.0 - smoothstep(0.35, 1.0, age)) * smoothstep(0.0, 0.06, age + 0.05);
  // temperature: blue-white at the tip, orange body, red end
  vec3 blue = vec3(0.45, 0.62, 1.0);
  vec3 white = vec3(1.0, 0.92, 0.78);
  vec3 orange = vec3(1.0, 0.42, 0.06);
  vec3 red = vec3(0.7, 0.08, 0.02);
  vec3 col = mix(blue, white, smoothstep(0.0, 0.18, u));
  col = mix(col, orange, smoothstep(0.12, 0.45, u));
  col = mix(col, red, smoothstep(0.5, 1.0, u));
  float flash = vD.w * exp(-(u * u * 6.0 + vUv.x * vUv.x * 3.0)) * (1.0 - smoothstep(0.0, 0.35, age)) * win;
  float depthV = -vView.z;
  float vis = smoothstep(-0.05, 0.12, sceneViewDepth() - depthV);
  float a = (body * fade + flash) * vis;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col * vD.y * (body * fade + flash * 1.8) * vis, a);
}
`;

// ───────────────────────────── debris chips ─────────────────────────────

export const chipVertex = /* glsl */ `
attribute vec4 aA;   // world position xyz, size
attribute vec4 aB;   // rotation, unused, unused, unused
attribute vec4 aC;   // colour rgb, alpha
varying vec2 vP;
varying vec4 vC;
varying vec3 vView;

void main() {
  vec4 mv = viewMatrix * vec4(aA.xyz, 1.0);
  vView = mv.xyz;
  float c = cos(aB.x), s = sin(aB.x);
  vec2 p = position.xy * 2.0;
  vP = p;
  vC = aC;
  mv.xy += vec2(c * p.x - s * p.y, s * p.x + c * p.y) * aA.w;
  gl_Position = projectionMatrix * mv;
}
`;

export const chipFragment = /* glsl */ `
varying vec2 vP;
varying vec4 vC;
varying vec3 vView;

void main() {
  float m = max(abs(vP.x), abs(vP.y));
  if (m > 0.95) discard;
  float depthV = -vView.z;
  if (sceneViewDepth() < depthV - 0.03) discard;
  vec3 lit = vC.rgb * (uSunLight * 0.22 + uSkyAmb * 0.9);
  lit = applyFog(lit, depthV);
  gl_FragColor = vec4(lit, vC.a);
}
`;

// ───────────────────────────── round glows (muzzle flashes, scrape flares) ─────────────────────────────

export const glowVertex = /* glsl */ `
attribute vec4 aA;   // world position xyz, size (radius)
attribute vec4 aB;   // age01, intensity, unused, unused
attribute vec4 aC;   // colour rgb, unused
varying vec2 vP;
varying vec4 vB;
varying vec3 vCol;
varying vec3 vView;
varying float vR;

void main() {
  vec4 mv = viewMatrix * vec4(aA.xyz, 1.0);
  vView = mv.xyz;
  vP = position.xy * 2.0;
  vB = aB;
  vCol = aC.rgb;
  float r = aA.w * (0.75 + 0.5 * aB.x);
  vR = r;
  mv.xy += vP * r;
  gl_Position = projectionMatrix * mv;
}
`;

export const glowFragment = /* glsl */ `
varying vec2 vP;
varying vec4 vB;
varying vec3 vCol;
varying vec3 vView;
varying float vR;

void main() {
  float d2 = dot(vP, vP);
  if (d2 >= 1.0) discard;
  float life = 1.0 - vB.x;
  float g = pow(1.0 + 16.0 * d2, -1.5) * (1.0 - d2) * (1.0 - d2) * life * life;
  float depthV = -vView.z;
  // a glow sits on or inside surfaces: fade only when the surface is clearly in front of it
  float vis = smoothstep(-vR * 0.9, vR * 0.4, sceneViewDepth() - depthV);
  float a = g * vis;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vCol * (vB.y * a), a);
}
`;
