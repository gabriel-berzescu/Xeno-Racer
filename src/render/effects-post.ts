/**
 * Custom full-screen effects for the `postprocessing` composer (owner: render).
 *
 *  - SpeedEffect: tasteful screen-edge radial blur + camera-rotation blur + chromatic aberration.
 *    A convolution effect (it samples neighbours of the HDR scene), so it must be first in its pass.
 *  - FinalEffect: exposure, tone mapping (AgX with a punchy look, or ACES), warm colour grade,
 *    vignette, sRGB encode and dithering. Always the last effect before anti-aliasing; the passes it
 *    lives in run with ENCODE_OUTPUT off, so the whole chain downstream (SMAA / FXAA) sees
 *    perceptually encoded colour, which is what those filters are designed for.
 */
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';
import { Uniform, Vector2, Vector3 } from 'three';

const speedFragment = /* glsl */ `
uniform float radial;
uniform float ca;
uniform vec2 pan;
uniform vec2 center;
uniform float seed;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 p = uv - center;
  float r = length(p * vec2(aspect, 1.0));
  float edge = smoothstep(0.16, 0.88, r);
  vec2 blurVec = -p * (radial * edge * 0.09) + pan * (0.35 + 0.65 * edge);
  float blurLen = length(blurVec);
  float caAmt = ca * edge;
  if (blurLen < 0.0005 && caAmt < 0.0004) {
    outputColor = inputColor;
    return;
  }
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + seed);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < TAPS; i++) {
    float t = (float(i) + jitter) / float(TAPS) - 0.5;
    vec2 o = uv + blurVec * t;
    if (caAmt > 0.0004) {
      vec2 co = p * caAmt;
      acc += vec3(textureLod(inputBuffer, o + co, 0.0).r, textureLod(inputBuffer, o, 0.0).g, textureLod(inputBuffer, o - co, 0.0).b);
    } else {
      acc += textureLod(inputBuffer, o, 0.0).rgb;
    }
  }
  outputColor = vec4(acc / float(TAPS), inputColor.a);
}
`;

export class SpeedEffect extends Effect {
  constructor(taps = 10) {
    super('SpeedEffect', speedFragment, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.CONVOLUTION,
      defines: new Map([['TAPS', String(taps)]]),
      uniforms: new Map<string, Uniform>([
        ['radial', new Uniform(0)],
        ['ca', new Uniform(0)],
        ['pan', new Uniform(new Vector2())],
        ['center', new Uniform(new Vector2(0.5, 0.5))],
        ['seed', new Uniform(0)],
      ]),
    });
  }
  set radial(v: number) {
    this.uniforms.get('radial')!.value = v;
  }
  set ca(v: number) {
    this.uniforms.get('ca')!.value = v;
  }
  get pan(): Vector2 {
    return this.uniforms.get('pan')!.value as Vector2;
  }
  get center(): Vector2 {
    return this.uniforms.get('center')!.value as Vector2;
  }
  set seed(v: number) {
    this.uniforms.get('seed')!.value = v;
  }
  /** True when the effect currently does anything (lets the caller skip it entirely). */
  get active(): boolean {
    return (this.uniforms.get('radial')!.value as number) > 0.001 || (this.uniforms.get('ca')!.value as number) > 0.0004 || this.pan.lengthSq() > 2.5e-7;
  }
}

/**
 * Exposure, tone mapping and grade as GLSL: `xrGrade(linear scene colour)` gives display-linear colour, and `srgbEncode`
 * encodes it. The final effect below runs it on the whole picture; the HUD mirror (mirrors.ts) runs the same code on its
 * own small picture, so both agree on exposure, the night shift, AgX, the warm grade and the contrast curve. The uniform
 * names are the final effect's, so the mirror can share its Uniform objects and follow every change it gets.
 */
export const GRADE_GLSL = /* glsl */ `
uniform float exposure;
uniform float tmMode;
uniform float saturation;
uniform float lookPower;
uniform float lookSat;
uniform float contrast;
uniform vec3 tint;
uniform float night;

const mat3 REC2020_TO_SRGB = mat3(
  vec3( 1.6605, -0.1246, -0.0182),
  vec3(-0.5876,  1.1329, -0.1006),
  vec3(-0.0728, -0.0083,  1.1187));
const mat3 SRGB_TO_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164),
  vec3(0.3293, 0.9195, 0.0880),
  vec3(0.0433, 0.0113, 0.8956));
const mat3 AGX_INSET = mat3(
  vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
  vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
  vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
const mat3 AGX_OUTSET = mat3(
  vec3( 1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
  vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
  vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));

vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 agxTonemap(vec3 c) {
  c = SRGB_TO_REC2020 * c;
  c = AGX_INSET * c;
  c = max(c, vec3(1e-10));
  c = log2(c);
  c = (c - (-12.47393)) / (4.026069 - (-12.47393));
  c = clamp(c, 0.0, 1.0);
  c = agxContrast(c);
  // look: power (contrast) + saturation, applied in the AgX log domain
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = pow(max(c, vec3(0.0)), vec3(lookPower));
  c = vec3(luma) + lookSat * (c - vec3(luma));
  c = AGX_OUTSET * c;
  c = pow(max(c, vec3(0.0)), vec3(2.2));
  c = REC2020_TO_SRGB * c;
  return clamp(c, 0.0, 1.0);
}

vec3 rrtOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesTonemap(vec3 c) {
  const mat3 IN = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 OUT = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  c = IN * (c / 0.6);
  c = rrtOdtFit(c);
  return clamp(OUT * c, 0.0, 1.0);
}

vec3 srgbEncode(vec3 c) {
  return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
}

vec3 xrGrade(vec3 scene) {
  vec3 c = max(scene, vec3(0.0)) * exposure;
  // mesopic vision at night: the dim parts of the scene lose their colour and drift blue (the rods take over),
  // while whatever the floodlights and headlights reach keeps it. Without this, moonlit grass reads bright green.
  if (night > 0.001) {
    float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float m = night * (1.0 - smoothstep(0.015, 0.3, L));
    c = mix(c, L * vec3(0.7, 0.82, 1.2), m);
  }
  c = (tmMode < 0.5) ? agxTonemap(c) : acesTonemap(c);

  // grade (display-linear)
  c *= tint;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = vec3(l) + saturation * (c - vec3(l));
  c = max(c, vec3(0.0));
  // gentle S-curve about mid grey
  return mix(c, c * c * (3.0 - 2.0 * c), contrast);
}
`;

const finalFragment = /* glsl */ `
${GRADE_GLSL}
uniform float vignette;
uniform float dither;
uniform float seed;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = xrGrade(inputColor.rgb);

  // vignette
  vec2 q = (uv - 0.5) * vec2(aspect, 1.0);
  float r = length(q) / (0.5 * sqrt(aspect * aspect + 1.0));
  float vig = 1.0 - vignette * smoothstep(0.35, 1.05, r) * smoothstep(0.35, 1.05, r);
  c *= vig;

  c = srgbEncode(clamp(c, 0.0, 1.0));

  // triangular-PDF dither (one LSB) to kill banding in the sky gradient
  float n1 = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float n2 = fract(52.9829189 * fract(dot(gl_FragCoord.xy + vec2(seed * 17.0, 3.0), vec2(0.00583715, 0.06711056))));
  c += (n1 + n2 - 1.0) * dither / 255.0;

  outputColor = vec4(c, inputColor.a);
}
`;

export type ToneMapMode = 'agx' | 'aces';

export class FinalEffect extends Effect {
  constructor() {
    super('FinalEffect', finalFragment, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, Uniform>([
        ['exposure', new Uniform(1)],
        ['tmMode', new Uniform(0)],
        ['saturation', new Uniform(1.12)],
        ['lookPower', new Uniform(1.22)],
        ['lookSat', new Uniform(1.32)],
        ['contrast', new Uniform(0.12)],
        ['tint', new Uniform(new Vector3(1, 1, 1))],
        ['night', new Uniform(0)],
        ['vignette', new Uniform(0.28)],
        ['dither', new Uniform(1)],
        ['seed', new Uniform(0)],
      ]),
    });
  }
  private u(name: string): Uniform {
    return this.uniforms.get(name)!;
  }
  set exposure(v: number) {
    this.u('exposure').value = v;
  }
  get exposure(): number {
    return this.u('exposure').value as number;
  }
  set mode(m: ToneMapMode) {
    this.u('tmMode').value = m === 'aces' ? 1 : 0;
  }
  set saturation(v: number) {
    this.u('saturation').value = v;
  }
  set contrast(v: number) {
    this.u('contrast').value = v;
  }
  set vignette(v: number) {
    this.u('vignette').value = v;
  }
  set lookPower(v: number) {
    this.u('lookPower').value = v;
  }
  set lookSat(v: number) {
    this.u('lookSat').value = v;
  }
  set seed(v: number) {
    this.u('seed').value = v;
  }
  /** Night (mesopic) colour shift of the dim parts of the scene, 0..1. */
  set night(v: number) {
    this.u('night').value = v;
  }
  /** Warm (+1) / cool (-1) grade. */
  setWarmth(w: number): void {
    (this.u('tint').value as Vector3).set(1 + 0.055 * w, 1 + 0.012 * w, 1 - 0.07 * w);
  }
}
