/**
 * Terrain splat material: grass / moss / dirt / rock blended by slope and noise in world space, with
 * tile-breaking and distance fading. Built on MeshStandardMaterial via onBeforeCompile.
 */
import * as THREE from 'three';
import type { Ctx } from './ctx';

const VERT_DECL = /* glsl */ `
attribute float aSurf;
attribute float aEdge;
varying vec3 vWPos;
varying vec3 vWNormal;
varying float vSurf;
varying float vEdge;
`;

const FRAG_DECL = /* glsl */ `
uniform sampler2D uGrass;
uniform sampler2D uGrassN;
uniform sampler2D uMoss;
uniform sampler2D uDirt;
uniform sampler2D uDirtN;
uniform sampler2D uRock;
uniform sampler2D uRockN;
uniform sampler2D uNoise;
uniform float uLayers;
uniform vec3 uTint;
uniform vec2 uRockRange;
uniform vec3 uDirtSlope;
uniform vec3 uRockTint;
uniform vec4 uCanopy;
uniform vec3 uCanopyCol;
uniform vec3 uAvgGrass;
uniform vec3 uAvgDry;
uniform vec3 uAvgDirt;
uniform vec3 uAvgRock;
uniform float uWet;
varying vec3 vWPos;
varying vec3 vWNormal;
varying float vSurf;
varying float vEdge;
float gWRock;
float gWDirt;
float gWMoss;
float gWGrass;
float gFar;
vec4 gN0;
vec4 gN1;
vec4 gN2;
vec4 gN3;
vec4 gN4;
vec4 gN5;
vec3 unpackN(vec4 t, float k) { vec3 n = t.xyz * 2.0 - 1.0; n.xy *= k; return n; }
vec3 flattenTex(sampler2D t, vec2 uv, vec3 avg, float lod) {
  vec3 c = texture2D(t, uv).rgb;
  vec3 low = textureLod(t, uv, lod).rgb;
  return c * avg / max(low, vec3(0.01));
}
`;

/** Large-scale meadow colour variation (shared with the grass tufts so they match the ground they stand on). */
export const GRASS_MACRO_GLSL = /* glsl */ `
vec3 xrGrassMacro(vec4 n0, vec4 n1, vec4 n2, vec4 n3, vec3 tint) {
  float hueN = n1.r * 0.5 + n2.g * 0.3 + n3.b * 0.2;
  // lush <-> sun-bleached patches at field, meadow and lawn scales
  return tint * mix(vec3(0.68, 1.0, 0.72), vec3(1.1, 1.04, 0.88), smoothstep(0.3, 0.85, hueN)) * (0.9 + 0.2 * n0.r) * mix(0.9, 1.1, n3.g);
}
`;

const FRAG_MAP = /* glsl */ `
  vec2 wuv = vWPos.xz;
  gN0 = texture2D(uNoise, wuv * 0.00093 + 0.13);
  gN1 = texture2D(uNoise, wuv * 0.0037 + 0.31);
  gN2 = texture2D(uNoise, wuv * 0.0173 + 0.62);
  gN3 = texture2D(uNoise, wuv * 0.057 + 0.77);
  vec2 ruv = mat2(0.8, -0.6, 0.6, 0.8) * wuv; // rotated copies break the noise tile's regularity
  gN4 = texture2D(uNoise, ruv * 0.0443 + 0.3);
  gN5 = texture2D(uNoise, ruv * 0.113 + 0.7);
  float camDist = length(vViewPosition);
  gFar = smoothstep(60.0, 300.0, camDist);
  float slope = 1.0 - clamp(normalize(vWNormal).y, 0.0, 1.0);
  gWRock = smoothstep(uRockRange.x, uRockRange.y, slope + 0.07 * (gN1.g - 0.5) + 0.04 * (gN2.r - 0.5));
  gWDirt = 0.0;
  gWMoss = 0.0;
  if (uLayers > 2.5) {
    float dirtPatch = smoothstep(0.78, 0.88, gN0.g * 0.6 + gN1.b * 0.4) * (1.0 - 0.8 * gFar);
    gWDirt = clamp(clamp(vSurf, 0.0, 1.0) + dirtPatch * 0.6 + smoothstep(uDirtSlope.x, uDirtSlope.y, slope) * uDirtSlope.z, 0.0, 1.0) * (1.0 - gWRock);
  }
  if (uLayers > 3.5) {
    gWMoss = smoothstep(0.4, 0.75, gN0.b * 0.5 + gN1.r * 0.5) * (1.0 - gWRock) * (1.0 - gWDirt) * 0.3 * (1.0 - 0.7 * gFar);
  }
  gWGrass = max(0.0, 1.0 - gWRock - gWDirt - gWMoss);

  // albedo: detail-only samples (the texture's own large-scale tone is divided out so it cannot tile visibly),
  // re-coloured by world-space noise at several scales
  vec3 grassNear = flattenTex(uGrass, wuv / 3.1, uAvgGrass, 4.0);
  vec3 grassMid = flattenTex(uGrass, wuv / 11.3 + vec2(0.37, 0.11), uAvgGrass, 4.0);
  vec3 cGrass = mix(grassNear, grassMid, 0.35 + 0.5 * gFar);
  cGrass *= xrGrassMacro(gN0, gN1, gN2, gN3, uTint);
  vec3 cRock = flattenTex(uRock, wuv / 6.5, uAvgRock, 4.0) * (0.85 + 0.3 * gN2.g) * uRockTint;
  // mown stripes parallel to the track in the grass beside it (only on strip meshes: vEdge > 0)
  if (vEdge > 0.0) {
    float band = floor(vEdge / 5.5);
    float mow = mix(0.9, 1.1, mod(band, 2.0)) ;
    float k = smoothstep(26.0, 6.0, vEdge);
    cGrass *= mix(1.0, mow, k);
  }
  vec3 col = cGrass * gWGrass + cRock * gWRock;
  if (uLayers > 2.5) {
    vec3 cDirt = flattenTex(uDirt, wuv / 4.2, uAvgDirt, 4.0) * (0.85 + 0.3 * gN2.b);
    col += cDirt * gWDirt;
  }
  if (uLayers > 3.5) {
    vec3 cDry = flattenTex(uMoss, wuv / 4.6 + 0.19, uAvgDry, 4.0) * mix(0.9, 1.1, gN1.b);
    col += cDry * gWMoss;
  }
  if (uCanopy.x > 0.0) {
    // far hillsides read as forest: a dark, clumpy canopy colour fades in with distance (real trees only exist near the road)
    // uCanopy.w = 0: forest everywhere (mountains); 1: patches of forest in meadow (noise mask)
    float forestMask = mix(1.0, smoothstep(0.42, 0.7, gN0.g * 0.55 + gN1.b * 0.45), uCanopy.w);
    float cw = uCanopy.x * smoothstep(uCanopy.y, uCanopy.z, camDist) * (1.0 - gWRock * 0.85) * forestMask;
    vec3 cCan = uCanopyCol * (0.8 + 0.4 * gN1.g) * (0.9 + 0.2 * gN2.r) * (0.9 + 0.2 * gN0.r) * mix(vec3(0.88, 1.0, 0.82), vec3(1.12, 1.0, 1.0), gN0.g);
    // tree-clump speckle, only visible from afar (up close the real trees and ground detail take over)
    cCan *= mix(1.0, 0.55 + 0.9 * mix(gN4.r, gN5.g, 0.5), smoothstep(150.0, 650.0, camDist));
    col = mix(col, cCan, cw);
  }
  // wet ground is darker: grass a little, bare earth and rock a lot
  col *= mix(1.0, 0.74 * gWGrass + 0.6 * gWRock + 0.5 * gWDirt + 0.68 * gWMoss, uWet);
  diffuseColor.rgb *= col;
`;

const FRAG_NORMAL = /* glsl */ `
#if defined( USE_NORMALMAP_TANGENTSPACE )
  vec3 nG = unpackN(texture2D(uGrassN, wuv / 3.1), 1.0) - unpackN(textureLod(uGrassN, wuv / 3.1, 4.0), 1.0);
  vec3 nR = unpackN(texture2D(uRockN, wuv / 6.5), 1.2) - unpackN(textureLod(uRockN, wuv / 6.5, 4.0), 1.2) * 0.6;
  vec2 nxy = nG.xy * gWGrass * (1.0 - 0.7 * gFar) + nR.xy * gWRock;
  if (uLayers > 2.5) nxy += (unpackN(texture2D(uDirtN, wuv / 4.2), 1.0).xy - unpackN(textureLod(uDirtN, wuv / 4.2, 4.0), 1.0).xy) * gWDirt;
  vec3 mapN = normalize(vec3(nxy, 1.0));
  normal = normalize( tbn * mapN );
#endif
`;

/** Multiplier on the meadow texture's average colour (turns the moss-field texture into grass). */
export function grassTint(ctx: Ctx): THREE.Vector3 {
  const t = LOOKS[ctx.rt.info.id]?.tint ?? DEFAULT_LOOK.tint;
  return new THREE.Vector3(...t);
}

/** Per-track ground look: rock and dirt slope ranges, rock tint and the far-hillside canopy (strength, fade-in start/end, forest mask). */
interface TerrainLook {
  tint: [number, number, number];
  rockRange: [number, number];
  dirtSlope: [number, number, number];
  rockTint: [number, number, number];
  canopy: [number, number, number, number];
  canopyCol: [number, number, number];
}

/** Lowland meadows with patches of forest on the far hills. */
const DEFAULT_LOOK: TerrainLook = {
  tint: [1.0, 1.62, 2.5],
  rockRange: [0.2, 0.4],
  dirtSlope: [0.16, 0.26, 0.45],
  rockTint: [1, 1, 1],
  canopy: [0.8, 260, 1100, 1],
  canopyCol: [0.05, 0.095, 0.035],
};

const LOOKS: Record<string, TerrainLook> = {
  // mountains: rock only where it is really steep (and dark); far hillsides take a forest-canopy colour
  kuroyama: {
    tint: [0.9, 1.35, 2.2],
    rockRange: [0.34, 0.68],
    dirtSlope: [0.36, 0.72, 0.3],
    rockTint: [0.62, 0.66, 0.6],
    canopy: [0.92, 90, 650, 0],
    canopyCol: [0.05, 0.085, 0.05],
  },
  // deep forest: the far hills are almost all canopy (a little broken up), darker and bluer than the meadow tracks
  brennwald: {
    tint: [0.95, 1.45, 2.3],
    rockRange: [0.3, 0.6],
    dirtSlope: [0.3, 0.6, 0.35],
    rockTint: [0.8, 0.8, 0.76],
    canopy: [0.9, 140, 800, 0.15],
    canopyCol: [0.045, 0.08, 0.04],
  },
};

export function makeTerrainMaterial(ctx: Ctx): THREE.MeshStandardMaterial {
  const t = ctx.tex;
  const dummyN = t.moss.nor.clone();
  dummyN.needsUpdate = true;
  ctx.disposables.push(dummyN);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    normalMap: dummyN,
    roughness: 0.93,
    metalness: 0,
    envMapIntensity: 0.7,
  });
  mat.name = 'terrain';
  const look = LOOKS[ctx.rt.info.id] ?? DEFAULT_LOOK;
  const tint = grassTint(ctx);
  const rockRange = new THREE.Vector2(...look.rockRange);
  const dirtSlope = new THREE.Vector3(...look.dirtSlope);
  const rockTint = new THREE.Vector3(...look.rockTint);
  const canopy = new THREE.Vector4(...look.canopy);
  const canopyCol = new THREE.Vector3(...look.canopyCol);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGrass = { value: t.moss.diff }; // lush meadow is the base layer
    shader.uniforms.uGrassN = { value: t.moss.nor };
    shader.uniforms.uMoss = { value: t.grass.diff }; // drier, browner grass patches
    shader.uniforms.uDirt = { value: t.dirt.diff };
    shader.uniforms.uDirtN = { value: t.dirt.nor };
    shader.uniforms.uRock = { value: t.rock.diff };
    shader.uniforms.uRockN = { value: t.rock.nor };
    shader.uniforms.uNoise = { value: t.noise };
    shader.uniforms.uLayers = { value: ctx.q.splatLayers };
    shader.uniforms.uTint = { value: tint };
    shader.uniforms.uRockRange = { value: rockRange };
    shader.uniforms.uDirtSlope = { value: dirtSlope };
    shader.uniforms.uRockTint = { value: rockTint };
    shader.uniforms.uCanopy = { value: canopy };
    shader.uniforms.uCanopyCol = { value: canopyCol };
    shader.uniforms.uAvgGrass = { value: t.moss.avg.clone() };
    shader.uniforms.uAvgDry = { value: t.grass.avg.clone() };
    shader.uniforms.uAvgDirt = { value: t.dirt.avg.clone() };
    shader.uniforms.uAvgRock = { value: t.rock.avg.clone() };
    shader.uniforms.uWet = ctx.wet.uWet;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_DECL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWNormal = normalize(mat3(modelMatrix) * objectNormal); vSurf = aSurf; vEdge = aEdge;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_DECL + GRASS_MACRO_GLSL)
      .replace('#include <map_fragment>', FRAG_MAP)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(0.95, 0.8, gWRock) * (1.0 - 0.16 * uWet);')
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL);
  };
  mat.customProgramCacheKey = () => 'terrain-splat-v9-' + ctx.q.splatLayers;
  mat.userData.wetShader = true;
  return mat;
}
