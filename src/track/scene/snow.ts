/**
 * The look of a winter circuit: snow terrain (which is also the ground of the shoulders and the snowbanks), the road of packed snow
 * and ice, the frozen lake. Everything is procedural, built on MeshStandardMaterial with shader patches like the other tracks'
 * materials (src/track/scene/materials.ts, terrainMat.ts), and cheap: a handful of noise reads and no texture sets.
 *
 *   - Snow: a cold white that goes blue where the wind has scooped it, long ridges (sastrugi) lying along the wind that show as a
 *     slight relief in the light, a glitter of crystals near the camera that catch the sun, a dirty grey where the plough has been.
 *     The sky does the blue shadows: the ambient light of a clear winter sky is blue, the sun low and warm.
 *   - Fresh snow (the "water" of a winter track, `uWet`) whitens and softens it all, road included.
 *   - The road: packed snow, with the racing line polished by the tyres (darker, glossier) and two tracks of grooves; on the lake the
 *     road is black ice scratched white by the studs, its extent read from a texture along s (the very stretches the physics calls ice).
 *   - The lake: black ice (a mirror at a low angle), frosted patches, snow drifted along the wind and piled towards the shore, cracks that
 *     are white lines. Its extent is a baked mask of the terrain's own (src/track/terrain.ts iceMask).
 */
import * as THREE from 'three';
import type { LakeDef } from '../types';
import { SURF_CODE } from '../types';
import type { Ctx } from './ctx';
import type { TrackMaterials } from './materials';

// ─────────────────────────────────────────────────────────────────────────────
// Shared GLSL
// ─────────────────────────────────────────────────────────────────────────────

const SNOW_COMMON = /* glsl */ `
uniform sampler2D uNoise;
uniform sampler2D uCracks;
uniform float uWet;
const vec2 SN_WIND = vec2(0.8192, 0.5736);
float snHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// Height of the wind-packed snow in metres: long ridges across the wind (2 m wide, tens of metres long), finer ripples, grain.
float snowHeight(vec2 p) {
  vec2 q = vec2(dot(p, SN_WIND), dot(p, vec2(-SN_WIND.y, SN_WIND.x)));
  float r = texture2D(uNoise, q * vec2(0.0023, 0.031) + 0.41).b * 0.62 + texture2D(uNoise, q * vec2(0.0051, 0.083) + 0.12).a * 0.38;
  float g = texture2D(uNoise, p * 0.41).a;
  return r * 0.2 + g * 0.012;
}
// A bump from the screen-space derivatives of a height in metres (unnormalised surface vectors: the slope comes out right at any distance).
vec3 snowBump(vec3 pos, vec3 N, float h, float k) {
  vec3 sx = dFdx(pos);
  vec3 sy = dFdy(pos);
  vec3 r1 = cross(sy, N);
  vec3 r2 = cross(N, sx);
  float det = dot(sx, r1);
  vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return normalize(abs(det) * N - k * grad);
}
`;

/** The glitter of snow crystals: added after the lights, where the sun reaches the surface. `gSparkle` 0 = none. */
const SNOW_SPARKLE = /* glsl */ `
#include <lights_fragment_end>
#if NUM_DIR_LIGHTS > 0
  if (gSparkle > 0.0 && camDist < 40.0) {
    vec3 Ld = directionalLights[0].direction;
    vec3 Vv = normalize(vViewPosition);
    vec3 Hh = normalize(Ld + Vv);
    vec2 cell = floor(vWPos.xz * 34.0);
    float rr = snHash(cell);
    vec3 gn = normalize(normal + (vec3(snHash(cell + 3.7), snHash(cell + 9.1), snHash(cell + 1.3)) - 0.5) * 1.3);
    float sp = pow(max(dot(gn, Hh), 0.0), 240.0) * step(0.86, rr);
    float lit = smoothstep(0.01, 0.1, dot(reflectedLight.directDiffuse, vec3(0.3333)));
    // (xrSunVG: the share of the sun's disc the terrain leaves visible here, set by the lights block: a ridge between the sun and the snow puts the glitter out)
    reflectedLight.directSpecular += directionalLights[0].color * sp * 2.4 * lit * gSparkle * xrSunVG * (1.0 - smoothstep(12.0, 40.0, camDist));
  }
#endif
`;

// ─────────────────────────────────────────────────────────────────────────────
// Snow terrain (ground, shoulders, snowbanks, the frozen lake)
// ─────────────────────────────────────────────────────────────────────────────

const GROUND_VERT_DECL = /* glsl */ `
attribute float aSurf;
attribute float aEdge;
varying vec3 vWPos;
varying vec3 vWNormal;
varying float vSurf;
varying float vEdge;
`;

const GROUND_FRAG_DECL = /* glsl */ `
${SNOW_COMMON}
uniform sampler2D uIceMask;
uniform vec4 uIceRect;
uniform vec2 uRockRange;
uniform vec4 uCanopy;
uniform vec3 uCanopyCol;
varying vec3 vWPos;
varying vec3 vWNormal;
varying float vSurf;
varying float vEdge;
float gRough;
float gSparkle;
float gHeight;
float camDist;
`;

const GROUND_MAP = /* glsl */ `
  vec2 wuv = vWPos.xz;
  camDist = length(vViewPosition);
  float gFar = smoothstep(50.0, 320.0, camDist);
  vec4 n0 = texture2D(uNoise, wuv * 0.00093 + 0.13);
  vec4 n1 = texture2D(uNoise, wuv * 0.0037 + 0.31);
  vec4 n2 = texture2D(uNoise, wuv * 0.0173 + 0.62);
  float slope = 1.0 - clamp(normalize(vWNormal).y, 0.0, 1.0);
  gHeight = snowHeight(wuv);
  float hSoft = clamp(gHeight * 4.6, 0.0, 1.0);

  // snow: a clean cold white, a little blue where the wind has scooped it
  vec3 snow = vec3(0.80, 0.85, 0.93) * (0.93 + 0.14 * n0.r) * (0.96 + 0.08 * n2.b);
  snow *= mix(vec3(0.93, 0.965, 1.02), vec3(1.0), hSoft);
  // plough-dirty at the road's edge and on the packed shoulder (vSurf 0.5)
  float dirty = 0.0;
  if (vEdge > 0.0) dirty = smoothstep(5.0, 0.0, vEdge) * 0.5;
  dirty = max(dirty, step(0.25, vSurf) * step(vSurf, 0.75) * 0.45);
  snow = mix(snow, snow * vec3(0.72, 0.745, 0.79), dirty);
  gRough = 0.93;
  gSparkle = 1.0 - dirty;

  // bare ground on the steep slopes and the wind-scoured crests
  float bare = smoothstep(uRockRange.x, uRockRange.y, slope + 0.06 * (n1.g - 0.5) + 0.03 * (n2.r - 0.5));
  vec3 rock = vec3(0.11, 0.105, 0.10) * (0.8 + 0.4 * n2.g);
  vec3 col = mix(snow, rock, bare * 0.92);
  gSparkle *= 1.0 - bare;

  // far hillsides read as forest: a dark canopy under its snow, clumpy at a distance
  if (uCanopy.x > 0.0) {
    float forestMask = mix(1.0, smoothstep(0.42, 0.7, n0.g * 0.55 + n1.b * 0.45), uCanopy.w);
    float cw = uCanopy.x * smoothstep(uCanopy.y, uCanopy.z, camDist) * (1.0 - bare * 0.85) * forestMask;
    vec3 cCan = uCanopyCol * (0.8 + 0.4 * n1.g) * (0.9 + 0.2 * n2.r) * mix(vec3(0.9, 1.0, 1.0), vec3(1.1, 1.0, 1.0), n0.g);
    cCan *= mix(1.0, 0.55 + 0.9 * texture2D(uNoise, wuv * 0.0443 + 0.3).r, smoothstep(150.0, 650.0, camDist));
    col = mix(col, cCan, cw);
    gSparkle *= 1.0 - cw;
  }

  // the frozen lake: black ice, frosted patches, drifts of snow blown along the wind and piled towards the shore, white cracks
  vec2 iuv = (wuv - uIceRect.xy) * uIceRect.zw;
  float ice = textureLod(uIceMask, clamp(iuv, 0.0, 1.0), 0.0).r * step(0.0, iuv.x) * step(iuv.x, 1.0) * step(0.0, iuv.y) * step(iuv.y, 1.0);
  float iceK = smoothstep(0.3, 0.6, ice);
  if (iceK > 0.001) {
    float crackLod = clamp(log2(camDist * 0.057), 0.0, 5.0);
    vec2 q = vec2(dot(wuv, SN_WIND), dot(wuv, vec2(-SN_WIND.y, SN_WIND.x)));
    float dn = textureLod(uNoise, q * vec2(0.0031, 0.011) + 0.2, 0.0).g * 0.55 + textureLod(uNoise, q * vec2(0.0087, 0.029) + 0.7, 0.0).b * 0.45;
    float shoreSnow = 1.0 - smoothstep(0.55, 0.95, ice);
    float drift = smoothstep(0.58 - 0.2 * shoreSnow, 0.7 - 0.2 * shoreSnow, dn);
    float frost = smoothstep(0.42, 0.62, n1.b * 0.6 + n2.a * 0.4);
    float cr = textureLod(uCracks, wuv * 0.043, crackLod).r;
    float cr2 = textureLod(uCracks, wuv * 0.0113 + 0.37, crackLod).r;
    float crack = clamp((1.0 - cr) + (1.0 - cr2) * 0.8, 0.0, 1.0);
    vec3 black = mix(vec3(0.020, 0.040, 0.060), vec3(0.060, 0.095, 0.130), n1.g);
    vec3 frosted = vec3(0.42, 0.52, 0.62) * (0.85 + 0.3 * n2.r);
    vec3 iceCol = mix(black, frosted, frost * 0.7);
    iceCol = mix(iceCol, vec3(0.78, 0.86, 0.93), crack * 0.55);
    iceCol = mix(iceCol, snow, drift);
    float iceRough = mix(mix(0.07, 0.35, frost), 0.93, drift);
    col = mix(col, iceCol, iceK);
    gRough = mix(gRough, iceRough, iceK);
    gHeight = mix(gHeight, gHeight * drift * 0.8, iceK);
    gSparkle *= 1.0 - iceK * (1.0 - drift);
  }
  // fresh snow whitens and softens everything
  col = mix(col, vec3(0.9, 0.93, 0.98), uWet * 0.38 * (1.0 - 0.5 * iceK));
  gRough = mix(gRough, 0.95, uWet * 0.6);
  diffuseColor.rgb *= col;
`;

const GROUND_NORMAL = /* glsl */ `
  normal = snowBump(-vViewPosition, normal, gHeight, (1.0 - gFar) * 0.9);
`;

/** A baked mask of the frozen lake for the terrain shader: R8, 1 on the ice, 0 on the land. */
export function buildIceMask(ctx: Ctx): { tex: THREE.DataTexture; rect: THREE.Vector4 } {
  const rt = ctx.rt;
  const lake: LakeDef | null = rt.iceLake;
  const size = 256;
  const data = new Uint8Array(size * size);
  let rect: THREE.Vector4;
  if (lake) {
    const R = Math.max(lake.rx, lake.rz) * 1.2 + lake.shore * 2 + 40;
    const x0 = lake.x - R;
    const z0 = lake.z - R;
    const cell = (2 * R) / size;
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) data[j * size + i] = Math.round(255 * rt.terrain.iceMask(x0 + (i + 0.5) * cell, z0 + (j + 0.5) * cell));
    }
    rect = new THREE.Vector4(x0, z0, 1 / (2 * R), 1 / (2 * R));
  } else rect = new THREE.Vector4(0, 0, 1, 1);
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  ctx.disposables.push(tex);
  return { tex, rect };
}

/** A mask with no ice on it: for what stands on the lake and is snow all the same (the snowbanks at its side). */
export function noIceMask(ctx: Ctx): { tex: THREE.DataTexture; rect: THREE.Vector4 } {
  const tex = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  ctx.disposables.push(tex);
  return { tex, rect: new THREE.Vector4(0, 0, 1, 1) };
}

/** Ground look per track: where the rock shows, and the far-hill forest (strength, fade-in start / end, forest mask) and its colour. */
interface SnowLook {
  rockRange: [number, number];
  canopy: [number, number, number, number];
  canopyCol: [number, number, number];
}
const DEFAULT_SNOW: SnowLook = { rockRange: [0.3, 0.6], canopy: [0.85, 150, 900, 0.3], canopyCol: [0.075, 0.1, 0.095] };

export function makeSnowGround(ctx: Ctx, strip = false, ice: { tex: THREE.DataTexture; rect: THREE.Vector4 } = buildIceMask(ctx)): THREE.MeshStandardMaterial {
  const look = DEFAULT_SNOW;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.93, metalness: 0, envMapIntensity: 0.8 });
  mat.name = strip ? 'snowStrip' : 'snow';
  if (strip) {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;
  }
  const rockRange = new THREE.Vector2(...look.rockRange);
  const canopy = new THREE.Vector4(...look.canopy);
  const canopyCol = new THREE.Vector3(...look.canopyCol);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNoise = { value: ctx.tex.noise };
    shader.uniforms.uCracks = { value: ctx.tex.cracks };
    shader.uniforms.uIceMask = { value: ice.tex };
    shader.uniforms.uIceRect = { value: ice.rect };
    shader.uniforms.uRockRange = { value: rockRange };
    shader.uniforms.uCanopy = { value: canopy };
    shader.uniforms.uCanopyCol = { value: canopyCol };
    shader.uniforms.uWet = ctx.wet.uWet;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + GROUND_VERT_DECL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWNormal = normalize(mat3(modelMatrix) * objectNormal); vSurf = aSurf; vEdge = aEdge;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GROUND_FRAG_DECL)
      .replace('#include <map_fragment>', GROUND_MAP)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace('#include <normal_fragment_maps>', GROUND_NORMAL)
      .replace('#include <lights_fragment_end>', SNOW_SPARKLE);
    // gFar is declared in the map block (it is also the bump's fade): make it visible to the normal block
    shader.fragmentShader = shader.fragmentShader.replace('float gFar = smoothstep(50.0, 320.0, camDist);', 'gFar = smoothstep(50.0, 320.0, camDist);').replace('float gHeight;', 'float gHeight;\nfloat gFar;');
  };
  mat.customProgramCacheKey = () => 'snow-ground-v2' + (strip ? 's' : '');
  mat.userData.wetShader = true;
  return mat;
}

// ─────────────────────────────────────────────────────────────────────────────
// The road: packed snow, the polished racing line, ice
// ─────────────────────────────────────────────────────────────────────────────

const ROAD_VERT_DECL = /* glsl */ `
attribute vec4 aTrack;
attribute float aLine;
varying vec4 vTrack;
varying float vLine;
varying vec3 vWPos;
`;

const ROAD_FRAG_DECL = /* glsl */ `
${SNOW_COMMON}
uniform sampler2D uSurf;
uniform float uLen;
uniform vec4 uGrid;
varying vec4 vTrack;
varying float vLine;
varying vec3 vWPos;
float gRough;
float gSparkle;
float gHeight;
float camDist;
float gFar;
float gPaint;
`;

function roadFragment(markings: boolean): string {
  return /* glsl */ `
  float tS = vTrack.x;
  float tD = vTrack.y;
  float edgeDist = tD >= 0.0 ? vTrack.z - tD : vTrack.w + tD;
  camDist = length(vViewPosition);
  gFar = smoothstep(40.0, 200.0, camDist);
  vec4 n0 = texture2D(uNoise, vWPos.xz * 0.0041);
  vec4 n1 = texture2D(uNoise, vWPos.xz * 0.0173 + 0.37);
  vec4 n2 = texture2D(uNoise, vWPos.xz * 0.071 + 0.71);
  float ice = texture2D(uSurf, vec2(tS / uLen, 0.5)).r;
  gHeight = snowHeight(vWPos.xz) * 0.35;

  // packed snow: a cold grey-white, harder and greyer than the powder beside it
  vec3 packed = vec3(0.64, 0.68, 0.75) * (0.9 + 0.2 * n0.r) * (0.94 + 0.12 * n2.b);
  // the racing line: a polished band and two tracks of grooves, darker and glossier
  float dr = tD - vLine;
  float band = exp(-dr * dr * 0.2) * (0.6 + 0.4 * n2.g);
  float track = 0.0;
  track += exp(-pow(abs(dr) - 0.95, 2.0) * 22.0) * (0.45 + 0.55 * n2.b);
  float polish = clamp(band * 0.55 + track * 0.7, 0.0, 1.0) * smoothstep(0.1, 0.9, edgeDist);
  vec3 col = packed;
  col = mix(col, col * vec3(0.56, 0.6, 0.68), polish);
  // loose, lighter snow along the edges where nothing drives
  col = mix(col, vec3(0.74, 0.78, 0.85), (1.0 - smoothstep(0.0, 1.7, edgeDist)) * (1.0 - polish) * 0.6);
  gRough = mix(0.88, 0.42, polish);

  // ice on the lake: clear and black, scratched white along the road by the studs
  float scratch = smoothstep(0.55, 0.9, texture2D(uNoise, vec2(tS * 0.021, tD * 0.37) + 0.3).a) * 0.55 + smoothstep(0.6, 0.95, texture2D(uNoise, vec2(tS * 0.0063, tD * 0.11)).b) * 0.4;
  vec3 iceCol = mix(vec3(0.020, 0.040, 0.058), vec3(0.070, 0.105, 0.14), n1.g);
  iceCol += vec3(0.5, 0.58, 0.66) * scratch * (0.25 + 0.75 * polish);
  col = mix(col, iceCol, ice);
  gRough = mix(gRough, mix(0.08, 0.3, scratch), ice);
  gSparkle = (1.0 - polish) * (1.0 - ice);

  // fresh snow: the road whitens (the line shows through where the cars have cleared it)
  float fresh = uWet * (1.0 - 0.5 * polish);
  col = mix(col, vec3(0.9, 0.93, 0.98), fresh * 0.55);
  gRough = mix(gRough, 0.95, fresh * 0.7);

  // paint: the start line, the grid boxes (a spray of orange on the snow)
  vec3 paintCol = vec3(0.9, 0.38, 0.1);
  gPaint = 0.0;
  ${
    markings
      ? /* glsl */ `
  float aa = fwidth(edgeDist) * 1.2 + 0.002;
  float sw = tS > uLen * 0.5 ? tS - uLen : tS;
  if (abs(sw) < 0.4 && edgeDist > 0.0) {
    float chk = mod(floor(tD / 0.4) + floor((sw + 0.4) / 0.4), 2.0);
    gPaint = 1.0;
    paintCol = mix(vec3(0.02), vec3(0.9), chk);
  }
  float tb = -sw - 8.0;
  if (tb > -4.0 && tb < uGrid.w * 8.0 * 0.5 + 4.0) {
    for (int par = 0; par < 2; par++) {
      float cen = par == 0 ? 0.0 : uGrid.y;
      float lo = tb - cen;
      float cell = floor(lo / uGrid.x + 0.5);
      if (cell >= 0.0 && cell < uGrid.w * 0.5) {
        float ls = lo - cell * uGrid.x;
        float dc = par == 0 ? uGrid.z : -uGrid.z;
        float ld = tD - dc;
        float ax = abs(ld);
        float az = abs(ls + 0.6);
        float side = (1.0 - smoothstep(0.07 - aa, 0.07 + aa, abs(ax - 1.15))) * step(az, 2.9);
        float rear = (1.0 - smoothstep(0.07 - aa, 0.07 + aa, abs(ls - 2.3))) * step(ax, 1.15);
        float front = (1.0 - smoothstep(0.07 - aa, 0.07 + aa, abs(ls + 3.5))) * step(ax, 0.5);
        if (max(side, max(rear, front)) > 0.0) {
          gPaint = max(gPaint, max(side, max(rear, front)) * 0.95);
          paintCol = vec3(0.9, 0.38, 0.1);
        }
      }
    }
  }
`
      : ''
  }
  gPaint = clamp(gPaint, 0.0, 1.0);
  diffuseColor.rgb = mix(col, paintCol, gPaint);
  diffuseColor.a = 1.0;
`;
}

const ROAD_ROUGHNESS = /* glsl */ `
float roughnessFactor = mix(gRough, 0.6, gPaint);
`;

const ROAD_NORMAL = /* glsl */ `
  normal = snowBump(-vViewPosition, normal, gHeight, (1.0 - gFar) * 0.9 * (1.0 - 0.7 * gPaint));
`;

/** A strip along s (one texel per metre): R = how icy the road is there, from the surfaces the physics is built on. */
export function buildRoadSurfaceTexture(ctx: Ctx): THREE.DataTexture {
  const rt = ctx.rt;
  const n = rt.count;
  const data = new Uint8Array(n * 4);
  const ICE = SURF_CODE.ice;
  for (let i = 0; i < n; i++) data[i * 4] = rt.roadSurf[i] === ICE ? 255 : 0;
  // a little softening along s (the change of surface is a few metres of frosted ice)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const a = data[((i + n - 1) % n) * 4];
      const b = data[i * 4];
      const c = data[((i + 1) % n) * 4];
      data[i * 4 + 1] = Math.round((a + 2 * b + c) / 4);
    }
    for (let i = 0; i < n; i++) data[i * 4] = data[i * 4 + 1];
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  ctx.disposables.push(tex);
  return tex;
}

export function makeSnowRoad(ctx: Ctx, markings: boolean, surf: THREE.DataTexture = buildRoadSurfaceTexture(ctx)): THREE.MeshStandardMaterial {
  const rt = ctx.rt;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, envMapIntensity: 0.9 });
  mat.name = markings ? 'road' : 'runoffAsphalt';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNoise = { value: ctx.tex.noise };
    shader.uniforms.uCracks = { value: ctx.tex.cracks };
    shader.uniforms.uSurf = { value: surf };
    shader.uniforms.uLen = { value: rt.length };
    shader.uniforms.uGrid = { value: new THREE.Vector4(8, 4, 3.2, rt.grid.length) };
    shader.uniforms.uWet = ctx.wet.uWet;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + ROAD_VERT_DECL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vTrack = aTrack; vLine = aLine; vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + ROAD_FRAG_DECL)
      .replace('#include <map_fragment>', roadFragment(markings))
      .replace('#include <roughnessmap_fragment>', ROAD_ROUGHNESS)
      .replace('#include <normal_fragment_maps>', ROAD_NORMAL)
      .replace('#include <lights_fragment_end>', SNOW_SPARKLE);
  };
  mat.customProgramCacheKey = () => (markings ? 'snow-road-marked-v2' : 'snow-road-plain-v2');
  mat.userData.wetShader = true;
  return mat;
}

// ─────────────────────────────────────────────────────────────────────────────

/** The materials of a winter circuit, in the shape the road, terrain and barrier builders expect. */
export function makeWinterMaterials(ctx: Ctx): TrackMaterials {
  const ice = buildIceMask(ctx);
  const surf = buildRoadSurfaceTexture(ctx);
  const road = makeSnowRoad(ctx, true, surf);
  const runoffAsphalt = makeSnowRoad(ctx, false, surf);
  const terrain = makeSnowGround(ctx, false, ice);
  const terrainStrip = makeSnowGround(ctx, true, ice);
  // (no kerbs, gravel or concrete on a winter circuit: stand-ins, so that every table of the builders is full)
  const stand = (name: string) => {
    const m = new THREE.MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.9 });
    m.name = name;
    return m;
  };
  const curb = stand('curb');
  const gravel = stand('gravel');
  const concrete = stand('concrete');
  const all = [road, curb, gravel, concrete, runoffAsphalt, terrain, terrainStrip];
  return { road, curb, gravel, concrete, runoffAsphalt, terrain, terrainStrip, all };
}
