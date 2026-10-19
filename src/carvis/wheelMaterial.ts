/**
 * Wheel shader: one patched MeshPhysicalMaterial handles tire, rim, spokes, brake disc (heat glow),
 * motion-blur disc and the (mirrored) caliper. Per-instance data comes from `instanceColor`:
 *   r = wheel angular speed (rad/s)   g = brake disc temperature (°C)   b = 1 -> mirror in z (right-side caliper)
 */
import { Color, DoubleSide, MeshPhysicalMaterial, Vector3, type IUniform, type Texture, type WebGLProgramParametersWithUniforms } from 'three';

export interface WheelUniforms {
  [k: string]: IUniform;
  uRimColor: IUniform<Color>;
  uRimMetal: IUniform<number>;
  uRimRough: IUniform<number>;
  uRimCC: IUniform<number>;
  uNutColor: IUniform<Color>;
  uCaliper: IUniform<Color>;
  uSlick: IUniform<number>;
  uTireText: IUniform<Texture | null>;
  uAccent: IUniform<Color>;
  uTread: IUniform<number>;
  uWet: IUniform<number>;
}

export function createWheelUniforms(): WheelUniforms {
  return {
    uRimColor: { value: new Color(0.1, 0.1, 0.11) },
    uRimMetal: { value: 1 },
    uRimRough: { value: 0.32 },
    uRimCC: { value: 0 },
    uNutColor: { value: new Color(0.7, 0.7, 0.72) },
    uCaliper: { value: new Color(0.7, 0.02, 0.02) },
    uSlick: { value: 0 },
    uTireText: { value: null },
    uAccent: { value: new Color(1, 1, 1) },
    uTread: { value: 1 },
    uWet: { value: 0 },
  };
}

const VERT_PARS = /* glsl */ `
attribute vec4 aZ0;
attribute vec4 aZ3;
varying vec4 vZ0;
varying vec4 vZ3;
varying vec3 vObjPos;
varying vec3 vInst;
`;
const VERT_NORMAL = /* glsl */ `
#include <beginnormal_vertex>
#ifdef USE_INSTANCING_COLOR
  vec3 wInst = instanceColor;
#else
  vec3 wInst = vec3(0.0);
#endif
vInst = wInst;
if (wInst.z > 0.5) objectNormal = vec3(-objectNormal.x, -objectNormal.y, objectNormal.z);
`;
const VERT_BEGIN = /* glsl */ `
#include <begin_vertex>
if (wInst.z > 0.5) transformed.z = -transformed.z;
vZ0 = aZ0;
vZ3 = aZ3;
vObjPos = position;
`;

const FRAG_PARS = /* glsl */ `
uniform vec3 uRimColor;
uniform float uRimMetal;
uniform float uRimRough;
uniform float uRimCC;
uniform vec3 uNutColor;
uniform vec3 uCaliper;
uniform float uSlick;
uniform sampler2D uTireText;
uniform vec3 uAccent;
uniform float uTread;
uniform float uWet;
varying vec4 vZ0;
varying vec4 vZ3;
varying vec3 vObjPos;
varying vec3 vInst;

float bayer4(vec2 p) {
  // interleaved gradient noise: a static screen-space dither that reads as grain rather than a grid
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 discGlow(float T) {
  float t1 = smoothstep(340.0, 540.0, T);
  float t2 = smoothstep(540.0, 740.0, T);
  float t3 = smoothstep(740.0, 920.0, T);
  return vec3(0.9, 0.05, 0.0) * t1 * t1 + vec3(2.6, 0.75, 0.05) * t2 + vec3(1.6, 1.5, 0.9) * t3;
}
vec3 perturbNormalH(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection) {
  vec3 vSigmaX = normalize(dFdx(surf_pos.xyz));
  vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
  vec3 vN = surf_norm;
  vec3 R1 = cross(vSigmaY, vN);
  vec3 R2 = cross(vN, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDirection;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
`;

const FRAG_ZONES = /* glsl */ `
int wPart = int(vZ3.y + 0.5);
float wOmega = abs(vInst.x);
float wTemp = vInst.y;
float wBlur = smoothstep(16.0, 40.0, wOmega);
float wDith = bayer4(gl_FragCoord.xy);
vec3 wCol = vec3(0.5);
float wRough = 0.5;
float wMetal = 0.0;
float wCC = 0.0;
vec3 wEmis = vec3(0.0);
float wHeight = 0.0;
float wAO = vZ3.x;

if (wPart == 20) {
  // tire
  float side = vZ0.z;
  float lat = vZ0.w;
  float u = vZ0.x;
  wCol = vec3(0.016);
  wRough = mix(0.88, 0.8, uSlick);
  if (side < 0.5) {
    // tread: circumferential grooves + sipes (fade out with distance)
    float fw = fwidth(lat) * 20.0;
    float fade = 1.0 - smoothstep(0.5, 2.0, fw);
    float g = 0.0;
    g = max(g, 1.0 - smoothstep(0.010, 0.026, abs(abs(lat) - 0.13)));
    g = max(g, 1.0 - smoothstep(0.010, 0.026, abs(abs(lat) - 0.31)));
    float sipe = (1.0 - smoothstep(0.03, 0.09, abs(fract(u * 70.0 + lat * 3.0) - 0.5))) * smoothstep(0.17, 0.2, abs(lat));
    float tread = max(g, sipe * 0.8);
    // (an all-terrain carcass has real lugs on it: its zone channel 14 is -1, and it paints no grooves of its own)
    tread *= step(0.0, vZ3.z);
    wHeight = -0.0016 * tread * fade * uTread;
    wCol *= 1.0 - 0.5 * tread * fade * uTread;
    wRough = mix(wRough, 0.95, tread * uTread * 0.5);
  } else {
    // sidewall: faint moulded ribs + lettering
    float f = vZ0.y;
    float rib = 1.0 - smoothstep(0.0, 0.02, abs(f - 0.9));
    wHeight = 0.0007 * rib;
    wCol = vec3(0.02);
    float ang = atan(vObjPos.y, vObjPos.z) * 0.15915494 + 0.5;
    float rr = max(length(vObjPos.yz), 0.05);
    float gAng = length(fwidth(vObjPos.yz)) / (6.2831853 * rr);
    float gRad = max(fwidth(vZ0.y), 1e-4);
    vec4 tt = textureGrad(uTireText, vec2(ang, clamp(f, 0.0, 1.0)), vec2(gAng, 0.0), vec2(0.0, gRad));
    float mk = tt.a;
    wCol = mix(wCol, mix(vec3(0.5), uAccent, uSlick), mk * 0.8);
    wRough = mix(wRough, 0.6, mk);
  }
} else if (wPart == 21) {
  // all-terrain lug blocks: black rubber, dusted on the tops the road has worn, darker down in the grooves (vZ0.y: 0 base .. 1 top)
  float tp = clamp(vZ0.y, 0.0, 1.0);
  float wear = smoothstep(0.75, 1.0, tp);
  wCol = vec3(0.017) + vec3(0.022, 0.021, 0.019) * wear * (0.55 + 0.45 * vZ0.x);
  wRough = 0.9 - 0.16 * wear;
  wHeight = 0.0004 * (hash12(floor(vObjPos.yz * 420.0)) - 0.5) * wear;
} else if (wPart == 22) {
  // rim spokes / lip
  if (wBlur > wDith) discard;
  wCol = uRimColor;
  wMetal = uRimMetal;
  wRough = uRimRough;
  wCC = uRimCC;
} else if (wPart == 23) {
  wCol = vec3(0.05, 0.05, 0.055);
  wMetal = 1.0;
  wRough = 0.38;
} else if (wPart == 24) {
  // brake disc
  float u = vZ0.x;
  float rr = vZ0.y;
  wCol = vec3(0.34, 0.34, 0.36);
  wMetal = 1.0;
  wRough = 0.42;
  // cross-drilled holes (two staggered rows), fade out when spinning fast
  vec2 g1 = vec2(fract(u * 36.0), fract(rr * 2.0));
  float row = step(0.5, fract(rr * 1.0));
  vec2 gq = vec2(fract(u * 36.0 + row * 0.5), fract(rr * 2.2 + 0.1));
  float hole = 1.0 - smoothstep(0.17, 0.25, length((gq - 0.5) * vec2(1.0, 1.3)));
  hole *= step(0.12, rr) * step(rr, 0.9);
  if (hole > 0.5 && wBlur < wDith) discard;
  // radial scoring + brake dust
  float score = 0.5 + 0.5 * sin(rr * 60.0 + u * 3.0);
  wCol *= 0.8 + 0.2 * score;
  wRough = 0.38 + 0.18 * score;
  float outer = smoothstep(0.7, 1.0, rr);
  wEmis = discGlow(wTemp) * (0.55 + 0.45 * outer);
  wCol = mix(wCol, vec3(0.08, 0.05, 0.04), smoothstep(450.0, 800.0, wTemp) * 0.7);
} else if (wPart == 25) {
  wCol = vec3(0.45, 0.46, 0.5);
  wMetal = 1.0;
  wRough = 0.3;
} else if (wPart == 26) {
  // motion-blur disc: only drawn when the wheel is spinning fast, and only partly covering so the
  // brake disc (and its heat glow) still shows through the "spoke smear"
  if (wBlur <= wDith) discard;
  float rr = vZ0.y;
  float cov = mix(0.45, 0.8, smoothstep(0.25, 0.95, rr));
  float n2 = bayer4(gl_FragCoord.yx * 0.9 + vec2(17.0, 31.0));
  if (n2 > cov) discard;
  float ang = atan(vObjPos.y, vObjPos.z);
  float streak = hash12(vec2(floor(ang * 30.0), 3.0));
  vec3 base = mix(uRimColor * 0.9 + vec3(0.03), vec3(0.025), smoothstep(0.2, 0.85, rr));
  wCol = base * (0.8 + 0.4 * streak);
  wMetal = 0.7;
  wRough = 0.5;
  wAO = 0.8;
} else if (wPart == 27) {
  wCol = uNutColor;
  wMetal = 1.0;
  wRough = 0.28;
} else if (wPart == 28) {
  wCol = vec3(0.035, 0.035, 0.04);
  wMetal = 0.6;
  wRough = 0.55;
} else if (wPart == 29) {
  // caliper
  wCol = uCaliper;
  wMetal = 0.0;
  wRough = 0.38;
  wCC = 0.8;
} else {
  // dust shield
  wCol = vec3(0.03, 0.03, 0.034);
  wMetal = 0.5;
  wRough = 0.6;
}
diffuseColor.rgb = wCol;
`;

const FRAG_NORMAL = /* glsl */ `
{
  vec2 dH = vec2(dFdx(wHeight), dFdy(wHeight));
  normal = perturbNormalH(-vViewPosition, normal, dH, faceDirection);
  nonPerturbedNormal = normal;
}
`;

export function createWheelMaterial(uniforms: WheelUniforms = createWheelUniforms()): { material: MeshPhysicalMaterial; uniforms: WheelUniforms } {
  const mat = new MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.5, clearcoat: 0.5, clearcoatRoughness: 0.08, side: DoubleSide });
  mat.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <beginnormal_vertex>', VERT_NORMAL)
      .replace('#include <begin_vertex>', VERT_BEGIN);
    let f = shader.fragmentShader;
    f = f.replace('#include <common>', '#include <common>\n' + FRAG_PARS);
    f = f.replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_ZONES);
    f = f.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = wRough * (1.0 - 0.45 * uWet);');
    f = f.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = wMetal;');
    f = f.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + FRAG_NORMAL);
    f = f.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += wEmis;');
    f = f.replace(
      '#include <lights_physical_fragment>',
      `#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
  material.clearcoat = wCC;
  material.clearcoatRoughness = max(0.06, 0.0525) + geometryRoughness;
#endif`,
    );
    f = f.replace(
      '#include <aomap_fragment>',
      `{
  float ambientOcclusion = wAO;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif
}`,
    );
    shader.fragmentShader = f;
  };
  mat.customProgramCacheKey = () => 'xr-wheel-v3';
  return { material: mat, uniforms };
}

export { Vector3 };
