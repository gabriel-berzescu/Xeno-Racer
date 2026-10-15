/**
 * Shared materials. PBR textures + small shader patches (onBeforeCompile) for tile-breaking, road paint and splatting.
 */
import * as THREE from 'three';
import type { Ctx } from './ctx';
import { makeTerrainMaterial } from './terrainMat';
import type { PbrSet } from './textures';
import { WET_HELPERS_GLSL, WET_UNIFORMS_GLSL } from './wet';

export interface TrackMaterials {
  road: THREE.MeshStandardMaterial;
  curb: THREE.MeshStandardMaterial;
  gravel: THREE.MeshStandardMaterial;
  concrete: THREE.MeshStandardMaterial;
  runoffAsphalt: THREE.MeshStandardMaterial;
  terrain: THREE.MeshStandardMaterial;
  terrainStrip: THREE.MeshStandardMaterial;
  all: THREE.Material[];
}

function cloneTex(t: THREE.Texture, repeat: number): THREE.Texture {
  const c = t.clone();
  c.wrapS = c.wrapT = THREE.RepeatWrapping;
  c.repeat.set(1 / repeat, 1 / repeat);
  c.anisotropy = t.anisotropy;
  c.needsUpdate = true;
  return c;
}

function pbr(ctx: Ctx, set: PbrSet, tile: number, o: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  const diff = cloneTex(set.diff, tile);
  const nor = cloneTex(set.nor, tile);
  const rough = cloneTex(set.rough, tile);
  ctx.disposables.push(diff, nor, rough);
  return new THREE.MeshStandardMaterial({
    map: diff,
    normalMap: nor,
    roughnessMap: rough,
    roughness: 1,
    metalness: 0,
    normalScale: new THREE.Vector2(1, 1),
    ...o,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Road
// ─────────────────────────────────────────────────────────────────────────────

const ROAD_VERT_DECL = /* glsl */ `
attribute vec4 aTrack;
attribute float aLine;
varying vec4 vTrack;
varying float vLine;
varying vec3 vWPos;
`;

const ROAD_FRAG_DECL = /* glsl */ `
uniform sampler2D uNoise;
uniform sampler2D uCracks;
uniform vec3 uAvg;
uniform float uLen;
uniform float uRich;
uniform float uCenter;
uniform vec4 uGrid;     // slot row pitch, stagger, lateral offset, slot count
varying vec4 vTrack;
varying float vLine;
varying vec3 vWPos;
float gPaint;
float gRubber;
float gPatch;
// wet weather: water film, standing water and the 1 - gloss flag written to alpha for the screen-space reflections
float gWet = 0.0;
float gPuddle = 0.0;
float gGloss = 0.0;
${WET_UNIFORMS_GLSL}
${WET_HELPERS_GLSL}
vec3 flattenTex(sampler2D t, vec2 uv, vec3 avg, float lod) {
  vec3 c = texture2D(t, uv).rgb;
  vec3 low = textureLod(t, uv, lod).rgb;
  return c * avg / max(low, vec3(0.004));
}
`;

// high-pass the normal map too: its low-frequency undulation would repeat as visible bands in the sun glare.
// Wet: standing water is flat and a film keeps only part of the asphalt grain; rain rings run over the puddles.
const ROAD_NORMAL = /* glsl */ `
#if defined( USE_NORMALMAP_TANGENTSPACE )
  vec3 nA = texture2D(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
  vec3 nL = textureLod(normalMap, vNormalMapUv, 5.0).xyz * 2.0 - 1.0;
  vec2 nxy = (nA.xy - nL.xy) * normalScale;
  if (gWet > 0.001) {
    nxy *= 1.0 - 0.95 * gPuddle - 0.4 * (1.0 - gPuddle) * gWet;
    float ripAmt = uRain * (1.0 - smoothstep(6.0, 22.0, length(vViewPosition)));
    if (ripAmt > 0.01) {
      vec3 rp = wRipple(vWPos.xz, uWTime, uRain);
      nxy += rp.xy * (0.5 * gPuddle + 0.03 * gWet * (1.0 - gPuddle)) * ripAmt;
    }
  }
  vec3 mapN = normalize(vec3(nxy, 1.0));
  normal = normalize( tbn * mapN );
#endif
`;

function roadFragment(markings: boolean): string {
  return /* glsl */ `
  float tS = vTrack.x;
  float tD = vTrack.y;
  float edgeDist = tD >= 0.0 ? vTrack.z - tD : vTrack.w + tD;   // metres inside the asphalt edge
  vec4 n0 = texture2D(uNoise, vWPos.xz * 0.0041);
  vec4 n1 = texture2D(uNoise, vWPos.xz * 0.0173 + 0.37);
  vec4 n2 = texture2D(uNoise, vWPos.xz * 0.071 + 0.71);
  vec3 albedo = flattenTex(map, vMapUv, uAvg, 5.0);
  albedo *= 1.3;
  if (uRich > 0.5) {
    vec3 alb2 = flattenTex(map, vMapUv * 0.29 + vec2(0.37, 0.11), uAvg, 5.0) * 1.3;
    albedo = mix(albedo, alb2, smoothstep(0.3, 0.7, n1.g) * 0.5);
    albedo *= 0.8 + 0.4 * n0.r;
    albedo *= vec3(1.0 + 0.07 * (n1.b - 0.5), 1.0, 1.0 - 0.06 * (n1.b - 0.5));
    // repaired patches: darker, smoother
    gPatch = smoothstep(0.66, 0.68, n0.b * 0.55 + n1.r * 0.45);
    albedo = mix(albedo, albedo * vec3(0.70, 0.72, 0.75), gPatch);
    // tar seams and cracks
    float crk = texture2D(uCracks, vWPos.xz * 0.11).r;
    albedo *= mix(1.0, crk, 0.7 * smoothstep(0.3, 0.75, n0.g));
  } else {
    gPatch = 0.0;
  }
  gRubber = 0.0;
  ${
    markings
      ? /* glsl */ `
  // rubbered-in racing line (wide band + two thin tyre tracks), fades towards the edge
  float dr = tD - vLine;
  float rubber = exp(-dr * dr * 0.45) * (0.55 + 0.45 * n2.g);
  rubber += 0.6 * exp(-pow(abs(dr) - 0.9, 2.0) * 16.0) * (0.35 + 0.65 * n2.b);
  gRubber = clamp(rubber, 0.0, 1.0) * smoothstep(0.1, 0.8, edgeDist);
  albedo *= 1.0 - 0.42 * gRubber;
  // clean, dusty edges away from the racing line
  albedo *= 1.0 + 0.16 * (1.0 - smoothstep(0.0, 2.2, edgeDist)) * (1.0 - gRubber);
`
      : ''
  }
  vec3 paintCol = vec3(0.72, 0.72, 0.70);
  gPaint = 0.0;
  ${
    markings
      ? /* glsl */ `
  float aa = fwidth(edgeDist) * 1.2 + 0.002;
  float lineMask = 1.0 - smoothstep(0.075 - aa, 0.075 + aa, abs(edgeDist - 0.32));
  gPaint = lineMask * (0.8 + 0.2 * n2.r);
  if (uCenter > 0.5) {
    float cl = 1.0 - smoothstep(0.07 - aa, 0.07 + aa, abs(tD));
    gPaint = max(gPaint, cl * step(mod(tS, 12.0), 4.0) * (0.8 + 0.2 * n2.r));
  }
  // start / finish: checkered band centered on s = 0
  float sw = tS > uLen * 0.5 ? tS - uLen : tS;
  if (abs(sw) < 0.4 && edgeDist > 0.0) {
    float chk = mod(floor(tD / 0.4) + floor((sw + 0.4) / 0.4), 2.0);
    gPaint = 1.0;
    paintCol = mix(vec3(0.02), vec3(0.72), chk);
  }
  // grid slots: boxes behind the line (two-wide stagger)
  float tb = -sw - 8.0;                      // distance behind pole position (>= 0 on the grid)
  if (tb > -4.0 && tb < uGrid.w * 8.0 * 0.5 + 4.0) {
    for (int par = 0; par < 2; par++) {
      float cen = par == 0 ? 0.0 : uGrid.y;
      float lo = tb - cen;
      float cell = floor(lo / uGrid.x + 0.5);
      if (cell >= 0.0 && cell < uGrid.w * 0.5) {
        float ls = lo - cell * uGrid.x;                       // -4 .. 4 around the slot centre
        float dc = par == 0 ? uGrid.z : -uGrid.z;
        float ld = tD - dc;
        float ax = abs(ld);
        float az = abs(ls + 0.6);
        // an open box: side lines + rear (T) line + front tick marks
        float side = (1.0 - smoothstep(0.06 - aa, 0.06 + aa, abs(ax - 1.15))) * step(az, 2.9);
        float rear = (1.0 - smoothstep(0.06 - aa, 0.06 + aa, abs(ls - 2.3))) * step(ax, 1.15);
        float front = (1.0 - smoothstep(0.06 - aa, 0.06 + aa, abs(ls + 3.5))) * step(ax, 0.5);
        gPaint = max(gPaint, max(side, max(rear, front)) * 0.9);
      }
    }
  }
`
      : ''
  }
  gPaint = clamp(gPaint, 0.0, 1.0);
  gWet = 0.0;
  gPuddle = 0.0;
  gGloss = 0.0;
  if (uWet > 0.001) {
    gWet = uWet * (1.0 - 0.92 * wTunnelDry(tS));
    if (gWet > 0.001) {
      // standing water: a low-frequency depth field (blobs of 3-14 m), stretched along the road, with a bias toward
      // the gutters (the crown drains there), the wheel ruts and the repaired patches
      float pf = n1.r * 0.34 + n1.g * 0.30 + n2.r * 0.20 + n1.b * 0.16;
      vec4 nl = texture2D(uNoise, vec2(tS * 0.0125, tD * 0.065) + 0.37);
      pf = mix(pf, nl.g * 0.55 + n1.g * 0.45, 0.2);
      float bias = 0.12 * (1.0 - smoothstep(0.0, 2.2, edgeDist)) * (0.4 + 0.6 * n2.g) + 0.08 * gRubber + 0.08 * gPatch;
      float fine = (n2.b - 0.5) * 0.06 + (n2.a - 0.5) * 0.04;
      float thr = mix(0.8, 0.52, gWet);
      gPuddle = smoothstep(thr, thr + 0.014, pf + bias + fine);
      albedo *= mix(1.0, 0.6, gWet);
      albedo = mix(albedo, albedo * 0.62, gPuddle);
      paintCol *= mix(1.0, 0.86, gWet);
      gGloss = clamp(0.5 * gWet + 0.55 * gPuddle, 0.0, 1.0);
    }
  }
  diffuseColor.rgb = mix(albedo, paintCol, gPaint);
  diffuseColor.a = 1.0;
`;
}

const WET_ROUGHNESS = /* glsl */ `
#include <roughnessmap_fragment>
roughnessFactor = clamp(mix(roughnessFactor, 0.6, gPaint) - 0.1 * gRubber + 0.05 * gPatch, 0.22, 1.0);
if (gWet > 0.001) {
  // the film fills the asphalt texture (glossy but not a mirror), standing water is a mirror
  roughnessFactor = mix(mix(roughnessFactor, 0.16 + 0.3 * roughnessFactor, gWet), 0.02, gPuddle);
}
`;

// street lamps lighting the wet road (diffuse + the long specular streak); radiance is added like an emissive
const WET_LAMPS_FRAGMENT = /* glsl */ `
#include <emissivemap_fragment>
if (gWet > 0.001) {
  vec3 Nw = inverseTransformDirection(normal, viewMatrix);
  vec3 Vw = normalize(cameraPosition - vWPos);
  totalEmissiveRadiance += roadLamps(Nw, Vw, diffuseColor.rgb, roughnessFactor, gPuddle) * gWet;
}
`;

// The environment map holds only the sky, but a wet road mirrors the whole horizon: trees, stands and hills hide much
// of the bright haze just above it. Dim the sky reflection toward the horizon so standing water is no brighter than
// the picture's real sky (instead of a white sheet when the camera looks along the road).
const WET_ENV_OCCLUSION = /* glsl */ `
#include <aomap_fragment>
if (gWet > 0.001) {
  vec3 Rw = inverseTransformDirection(reflect(-geometryViewDir, geometryNormal), viewMatrix);
  float horizonOcc = mix(0.32, 1.0, smoothstep(0.02, 0.35, Rw.y));
  reflectedLight.indirectSpecular *= mix(1.0, horizonOcc, gWet);
  // Wet asphalt throws a headlight beam away from the driver instead of scattering it back: the pool in front of a
  // car is far dimmer than on a dry road (and standing water, over dark asphalt, hardly scatters at all). Under a
  // rain deck the only direct light left on the road is the cars' headlights.
  reflectedLight.directDiffuse *= 1.0 - gWet * (0.25 + 0.27 * gPuddle) * (1.0 - 0.75 * gPaint);
}
`;

export function makeRoadMaterial(ctx: Ctx, tile: number, markings: boolean): THREE.MeshStandardMaterial {
  const mat = pbr(ctx, ctx.tex.asphalt, tile, { color: 0xffffff, envMapIntensity: 0.9 });
  mat.name = markings ? 'road' : 'runoffAsphalt';
  mat.normalScale.set(1.15, 1.15);
  const rt = ctx.rt;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNoise = { value: ctx.tex.noise };
    shader.uniforms.uCracks = { value: ctx.tex.cracks };
    shader.uniforms.uAvg = { value: ctx.tex.asphalt.avg.clone() };
    shader.uniforms.uLen = { value: rt.length };
    shader.uniforms.uRich = { value: ctx.q.rich ? 1 : 0 };
    shader.uniforms.uCenter = { value: rt.def.centerLine ? 1 : 0 };
    shader.uniforms.uGrid = { value: new THREE.Vector4(8, 4, 3.2, rt.grid.length) };
    shader.uniforms.uWet = ctx.wet.uWet;
    shader.uniforms.uRain = ctx.wet.uRain;
    shader.uniforms.uWTime = ctx.wet.uWTime;
    shader.uniforms.uTunnel = ctx.wet.uTunnel;
    shader.uniforms.uLamp = ctx.wet.uLamp;
    shader.uniforms.uLampCol = ctx.wet.uLampCol;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + ROAD_VERT_DECL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vTrack = aTrack; vLine = aLine; vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + ROAD_FRAG_DECL)
      .replace('#include <map_fragment>', roadFragment(markings))
      .replace('#include <normal_fragment_maps>', ROAD_NORMAL)
      .replace('#include <roughnessmap_fragment>', WET_ROUGHNESS)
      .replace('#include <emissivemap_fragment>', WET_LAMPS_FRAGMENT)
      .replace('#include <aomap_fragment>', WET_ENV_OCCLUSION)
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n gl_FragColor.a = 1.0 - gGloss;');
  };
  mat.customProgramCacheKey = () => (markings ? 'road-marked-v4' : 'road-plain-v4');
  // the shader handles wetness itself (puddles, ripples, gloss flag); only the reflection strength follows here
  mat.userData.wetShader = true;
  const envBase = mat.envMapIntensity;
  ctx.envListeners.push((env) => {
    mat.envMapIntensity = envBase * (1 + 0.45 * env.wetness);
  });
  return mat;
}

// ─────────────────────────────────────────────────────────────────────────────
// Curb stripes
// ─────────────────────────────────────────────────────────────────────────────

export function makeCurbTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d')!;
  // v increases along s: first half red, second half white (one stripe pair per repeat)
  g.fillStyle = '#a8121a';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#cfcdc6';
  g.fillRect(0, 64, 64, 64);
  // soft grain + edge scuffs
  const img = g.getImageData(0, 0, 64, 128);
  let seed = 1234;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = 0.93 + rnd() * 0.12;
    img.data[i] *= n;
    img.data[i + 1] *= n;
    img.data[i + 2] *= n;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function makeMaterials(ctx: Ctx): TrackMaterials {
  const rt = ctx.rt;
  const tile = rt.length / Math.round(rt.length / 3.6);
  const road = makeRoadMaterial(ctx, tile, true);
  const runoffAsphalt = makeRoadMaterial(ctx, 3.6, false);
  const curbTex = makeCurbTexture();
  ctx.disposables.push(curbTex);
  const curb = new THREE.MeshStandardMaterial({ map: curbTex, roughness: 0.62, metalness: 0, envMapIntensity: 0.8 });
  curb.name = 'curb';
  const gravel = pbr(ctx, ctx.tex.gravel, 2.6, { color: 0xffffff, normalScale: new THREE.Vector2(1.4, 1.4), vertexColors: true });
  gravel.name = 'gravel';
  const concrete = pbr(ctx, ctx.tex.concreteFloor, 4.2, { color: 0x9a9a96, vertexColors: true });
  concrete.name = 'concrete';
  const terrain = makeTerrainMaterial(ctx);
  const terrainStrip = makeTerrainMaterial(ctx);
  terrainStrip.polygonOffset = true;
  terrainStrip.polygonOffsetFactor = -2;
  terrainStrip.polygonOffsetUnits = -2;
  const all = [road, curb, gravel, concrete, runoffAsphalt, terrain, terrainStrip];
  return { road, curb, gravel, concrete, runoffAsphalt, terrain, terrainStrip, all };
}
