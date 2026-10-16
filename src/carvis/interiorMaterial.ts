/**
 * Interior material: one patched MeshPhysicalMaterial switching on the part id (aZ3.y) baked into
 * the cabin / driver / steering-wheel meshes.
 */
import { Color, DoubleSide, MeshPhysicalMaterial, Vector3, Vector4, type IUniform, type WebGLProgramParametersWithUniforms } from 'three';

export interface InteriorUniforms {
  [k: string]: IUniform;
  uAccent: IUniform<Color>;
  uPrimary: IUniform<Color>;
  uSeat: IUniform<Color>;
  uLight: IUniform<number>;
  /** soft window light on the cabin (by day, fading out at night): a Fresnel-weighted lift that outlines the dark glossy parts */
  uFill: IUniform<number>;
  uScreen: IUniform<number>;
  /** rpm 0..1, gear (-1 R, 0 N, 1..), speed km/h, over-rev flash 0/1 */
  uCluster: IUniform<Vector4>;
  uScreenC: IUniform<Vector3>;
}

export function createInteriorUniforms(): InteriorUniforms {
  return {
    uAccent: { value: new Color('#ff6a1a') },
    uPrimary: { value: new Color('#1c2c5a') },
    uSeat: { value: new Color(0.03, 0.03, 0.035) },
    uLight: { value: 0.45 },
    uFill: { value: 0 },
    uScreen: { value: 1 },
    uCluster: { value: new Vector4(0, 0, 0, 0) },
    uScreenC: { value: new Vector3(0.36, 0.8, 0.5) },
  };
}

const VERT_PARS = /* glsl */ `
attribute vec4 aZ0;
attribute vec4 aZ3;
varying vec4 vZ0;
varying float vAO;
flat varying float vPart;
varying vec3 vObjPos;
`;
const VERT_BEGIN = /* glsl */ `
#include <begin_vertex>
vZ0 = aZ0;
vAO = aZ3.x;
vPart = aZ3.y;
vObjPos = position;
`;
const FRAG_PARS = /* glsl */ `
uniform vec3 uAccent;
uniform vec3 uPrimary;
uniform vec3 uSeat;
uniform float uLight;
uniform float uFill;
uniform float uScreen;
uniform vec4 uCluster;
uniform vec3 uScreenC;
varying vec4 vZ0;
varying float vAO;
flat varying float vPart;
varying vec3 vObjPos;
float seg7(vec2 p, int d) {
  int m = d == 0 ? 0x3F : d == 1 ? 0x06 : d == 2 ? 0x5B : d == 3 ? 0x4F : d == 4 ? 0x66 : d == 5 ? 0x6D : d == 6 ? 0x7D : d == 7 ? 0x07 : d == 8 ? 0x7F : d == 9 ? 0x6F : d == 10 ? 0x54 : d == 11 ? 0x50 : 0;
  float t = 0.1;
  float lit = 0.0;
  if ((m & 1) != 0 && abs(p.y - 0.94) < t && abs(p.x - 0.5) < 0.34) lit = 1.0;
  if ((m & 2) != 0 && abs(p.x - 0.9) < t && abs(p.y - 0.73) < 0.2) lit = 1.0;
  if ((m & 4) != 0 && abs(p.x - 0.9) < t && abs(p.y - 0.27) < 0.2) lit = 1.0;
  if ((m & 8) != 0 && abs(p.y - 0.06) < t && abs(p.x - 0.5) < 0.34) lit = 1.0;
  if ((m & 16) != 0 && abs(p.x - 0.1) < t && abs(p.y - 0.27) < 0.2) lit = 1.0;
  if ((m & 32) != 0 && abs(p.x - 0.1) < t && abs(p.y - 0.73) < 0.2) lit = 1.0;
  if ((m & 64) != 0 && abs(p.y - 0.5) < t && abs(p.x - 0.5) < 0.34) lit = 1.0;
  return lit;
}
float digitCell(vec2 sp, float u0, float w, int d) {
  vec2 p = vec2((sp.x - u0) / w, (sp.y + 0.92) / 1.0);
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 0.0;
  return seg7(p, d);
}
float ihash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
`;
const FRAG_ZONES = /* glsl */ `
int ip = int(vPart + 0.5);
vec3 iCol = vec3(0.03);
float iRough = 0.7;
float iMetal = 0.0;
float iCC = 0.0;
vec3 iEmis = vec3(0.0);
float iAO = vAO;
float visorM = 1.0 - smoothstep(-fwidth(vZ0.x) * 0.8 - 1e-4, fwidth(vZ0.x) * 0.8 + 1e-4, vZ0.x);
float screenM = 1.0 - smoothstep(-fwidth(vZ0.y) * 0.8 - 1e-4, fwidth(vZ0.y) * 0.8 + 1e-4, vZ0.y);
float cscreenM = 1.0 - smoothstep(-fwidth(vZ0.z) * 0.8 - 1e-4, fwidth(vZ0.z) * 0.8 + 1e-4, vZ0.z);
float ventM = 1.0 - smoothstep(-fwidth(vZ0.w) * 0.8 - 1e-4, fwidth(vZ0.w) * 0.8 + 1e-4, vZ0.w);
float grain = 0.8 + 0.4 * ihash(floor(vObjPos * 260.0));
if (ip == 40) { iCol = uSeat * grain; iRough = 0.78; }
else if (ip == 41) { iCol = uAccent * 0.8; iRough = 0.6; }
else if (ip == 42) { iCol = vec3(0.016) * grain; iRough = 0.9; }
else if (ip == 43) { iCol = vec3(0.02) * grain; iRough = 0.5; }
else if (ip == 44) { iCol = vec3(0.025) * grain; iRough = 0.7; }
else if (ip == 45) { iCol = vec3(0.012) * grain; iRough = 0.95; }
else if (ip == 46) {
  iCol = mix(uAccent, vec3(0.012, 0.014, 0.02), visorM);
  iRough = mix(0.22, 0.03, visorM);
  iMetal = visorM;
  iCC = 1.0 - visorM;
}
else if (ip == 48) { iCol = mix(vec3(0.02, 0.022, 0.03), uPrimary * 0.5, step(0.0, sin(vObjPos.y * 38.0)) * 0.0); iRough = 0.8; }
else if (ip == 49) { iCol = vec3(0.01); iRough = 0.7; }
else if (ip == 50) { iCol = vec3(0.35, 0.0, 0.02); iRough = 0.6; }
else if (ip == 51) { iCol = vec3(0.012) * grain; iRough = 0.65; }
else if (ip == 52) { iCol = vec3(0.55); iRough = 0.35; iMetal = 1.0; }
else if (ip == 56) {
  vec2 sp = vObjPos.xy * 90.0;
  float bar = step(0.5, fract(sp.x * 0.5)) * step(0.5, fract(sp.y * 0.7));
  iCol = vec3(0.01);
  iEmis = (vec3(0.08, 0.75, 0.6) * (0.4 + 0.6 * bar) + vec3(0.8, 0.1, 0.2) * step(0.9, fract(sp.x * 0.07))) * uScreen * 0.7;
  iRough = 0.1;
}
else if (ip == 54) { iCol = vec3(0.03); iRough = 0.5; iMetal = 0.6; }
else if (ip == 55) { iCol = vec3(0.01); iRough = 0.8; }
else if (ip == 1) { iCol = vec3(0.04) * grain; iRough = 0.35; iCC = 0.6; }
else if (ip == 3) { iCol = vec3(0.5); iRough = 0.3; iMetal = 1.0; }

if (screenM > 0.001) {
  // instrument cluster: tach bar, gear, speed
  vec2 sp = vec2(-(vObjPos.x - uScreenC.x) / 0.17, (vObjPos.y - uScreenC.y) / 0.045);
  vec3 sc = vec3(0.006, 0.012, 0.014);
  float rpm = clamp(uCluster.x, 0.0, 1.0);
  if (sp.y > 0.2 && sp.y < 0.95 && abs(sp.x) < 0.95) {
    float f = (sp.x + 0.95) / 1.9;
    float n = floor(f * 30.0);
    float cf = fract(f * 30.0);
    float seg = step(0.14, cf) * step(cf, 0.86);
    float on = step(n + 0.5, rpm * 30.0) * seg;
    vec3 sc2 = f < 0.6 ? vec3(0.1, 0.9, 0.35) : (f < 0.82 ? vec3(1.0, 0.7, 0.08) : vec3(1.0, 0.1, 0.06));
    float all = step(0.5, uCluster.w);
    sc += sc2 * (max(on, all * seg) + 0.035 * seg);
  }
  int g = int(uCluster.y + 0.5);
  int gd = uCluster.y < -0.5 ? 11 : g <= 0 ? 10 : min(g, 9);
  sc += vec3(0.6, 0.9, 1.0) * digitCell(sp, -0.9, 0.3, gd);
  int sv = int(max(uCluster.z, 0.0) + 0.5);
  float sl = 0.0;
  if (sv >= 100) sl += digitCell(sp, -0.32, 0.3, (sv / 100) % 10);
  if (sv >= 10) sl += digitCell(sp, 0.04, 0.3, (sv / 10) % 10);
  sl += digitCell(sp, 0.4, 0.3, sv % 10);
  sc += vec3(0.95, 0.97, 1.0) * sl;
  iCol = mix(iCol, vec3(0.01), screenM);
  iRough = mix(iRough, 0.12, screenM);
  iEmis += sc * uScreen * 1.3 * screenM;
}

if (cscreenM > 0.001) {
  vec2 cp = vec2(vObjPos.x / 0.12, (vObjPos.z - 0.0) * 18.0);
  float rowsB = step(0.5, fract(cp.y * 1.3)) * step(abs(cp.x), 0.9);
  float map = step(length(vec2(cp.x * 1.4 + 0.2, fract(cp.y) - 0.5)), 0.5);
  vec3 cs = vec3(0.02, 0.05, 0.07) + vec3(0.1, 0.45, 0.6) * (0.35 + 0.5 * rowsB) + vec3(0.9, 0.2, 0.3) * map * 0.5;
  iCol = mix(iCol, vec3(0.01), cscreenM);
  iEmis += cs * uScreen * 0.55 * cscreenM;
}
if (ventM > 0.001) {
  vec2 vp = vObjPos.xz;
  float slats = smoothstep(0.35, 0.65, abs(fract(vp.x * 90.0) - 0.5) * 2.0);
  iCol = mix(iCol, mix(vec3(0.004), vec3(0.3, 0.3, 0.33), slats), ventM);
  iMetal = mix(iMetal, 0.8 * slats, ventM);
  iRough = mix(iRough, 0.35, ventM);
}
diffuseColor.rgb = iCol;
`;

export function createInteriorMaterial(uniforms: InteriorUniforms = createInteriorUniforms()): { material: MeshPhysicalMaterial; uniforms: InteriorUniforms } {
  const mat = new MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06, side: DoubleSide });
  // street lamps at night (render's global lamp lighting has no shadows): only the light through the glass gets in
  mat.defines = { ...(mat.defines ?? {}), XR_LAMP_SCALE: '0.15' };
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + VERT_PARS).replace('#include <begin_vertex>', VERT_BEGIN);
    let f = shader.fragmentShader;
    f = f.replace('#include <common>', '#include <common>\n' + FRAG_PARS);
    f = f.replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_ZONES);
    f = f.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = iRough;');
    f = f.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = iMetal;');
    f = f.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
totalEmissiveRadiance += iEmis;
if (uFill > 0.0) {
  float fillFr = 1.0 - abs(dot(normal, normalize(vViewPosition)));
  totalEmissiveRadiance += vec3(0.8, 0.86, 0.95) * uFill * (0.2 + 0.8 * fillFr * fillFr) * (0.25 + 0.75 * iAO);
}`,
    );
    f = f.replace(
      '#include <lights_physical_fragment>',
      `#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
  material.clearcoat = iCC;
#endif`,
    );
    f = f.replace(
      '#include <aomap_fragment>',
      `{
  float ambientOcclusion = iAO * uLight;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif
}`,
    );
    shader.fragmentShader = f;
  };
  mat.customProgramCacheKey = () => 'xr-interior-v2';
  return { material: mat, uniforms };
}
