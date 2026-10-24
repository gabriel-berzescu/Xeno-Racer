/**
 * Interior material: one patched MeshPhysicalMaterial switching on the part id (aZ3.y) baked into
 * the cabin / driver / steering-wheel meshes.
 */
import { Color, DoubleSide, MeshPhysicalMaterial, Vector3, Vector4, type IUniform, type WebGLProgramParametersWithUniforms } from 'three';
import { WHEEL04, YOKE } from './interior';

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
  /** what else the single-seater's yoke shows: where the active aero stands (0..1), the electric boost deploying (0..1) */
  uYoke: IUniform<Vector4>;
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
    uYoke: { value: new Vector4(0, 0, 0, 0) },
  };
}

const VERT_PARS = /* glsl */ `
attribute vec4 aZ0;
attribute vec4 aZ3;
varying vec4 vZ0;
varying float vAO;
flat varying float vPart;
varying vec3 vObjPos;
varying float vHelm;
`;
const VERT_BEGIN = /* glsl */ `
#include <begin_vertex>
vZ0 = aZ0;
vAO = aZ3.x;
vPart = aZ3.y;
vObjPos = position;
vHelm = aZ3.z;
`;
/** A number as a GLSL float literal. */
const glf = (v: number): string => (Number.isInteger(v) ? v.toFixed(1) : String(v));
/** The body of w4Button (the colour of the 2004 wheel's button nearest a point, WHEEL04.buttons): one test per button. */
const W4_BUTTONS = WHEEL04.buttons
  .map(([x, y, k]) => `  d = distance(p, vec2(${glf(x)}, ${glf(y)})); if (d < best) { best = d; c = vec3(${WHEEL04.colours[k].map(glf).join(', ')}); }`)
  .join('\n');
const FRAG_PARS = /* glsl */ `
#define YK_DX ${glf(YOKE.display.x)}
#define YK_DY ${glf(YOKE.display.y)}
#define YK_LX0 ${glf(YOKE.lights.x0)}
#define YK_LSTEP ${glf(YOKE.lights.step)}
#define W4_DX ${glf(WHEEL04.display.x)}
#define W4_DY ${glf(WHEEL04.display.y)}
#define W4_LX0 ${glf(WHEEL04.lights.x0)}
#define W4_LSTEP ${glf(WHEEL04.lights.step)}
#define W4_LN ${glf(WHEEL04.lights.n - 1)}
#define W4_L0 ${glf(WHEEL04.lights.on0)}
#define W4_LD ${glf(WHEEL04.lights.onStep)}
uniform vec3 uAccent;
uniform vec3 uPrimary;
uniform vec3 uSeat;
uniform float uLight;
uniform float uFill;
uniform float uScreen;
uniform vec4 uCluster;
uniform vec3 uScreenC;
uniform vec4 uYoke;
varying vec4 vZ0;
varying float vAO;
flat varying float vPart;
varying vec3 vObjPos;
varying float vHelm;
// the segments a digit lights: 0-9, 10 'n' (neutral), 11 'r' (reverse)
int seg7m(int d) {
  return d == 0 ? 0x3F : d == 1 ? 0x06 : d == 2 ? 0x5B : d == 3 ? 0x4F : d == 4 ? 0x66 : d == 5 ? 0x6D : d == 6 ? 0x7D : d == 7 ? 0x07 : d == 8 ? 0x7F : d == 9 ? 0x6F : d == 10 ? 0x54 : d == 11 ? 0x50 : 0;
}
float seg7(vec2 p, int d) {
  int m = seg7m(d);
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
// a digit in the box lo..hi (metres on the yoke's display), its bars bar m thick, their edges soft over a pixel
float yokeDigit(vec2 q, vec2 lo, vec2 hi, int d, float bar) {
  vec2 sz = hi - lo;
  vec2 p = (q - lo) / sz;
  vec2 aa = fwidth(p) * 0.7 + 1e-5;
  if (p.x < -0.05 || p.x > 1.05 || p.y < -0.05 || p.y > 1.05) return 0.0;
  int m = seg7m(d);
  vec2 t = 0.5 * bar / sz;
  float hx = 0.5 - 2.2 * t.x;
  float vy = 0.25 - 1.6 * t.y;
  float lit = 0.0;
  vec2 c[7] = vec2[7](vec2(0.5, 1.0 - t.y), vec2(1.0 - t.x, 0.75), vec2(1.0 - t.x, 0.25), vec2(0.5, t.y), vec2(t.x, 0.25), vec2(t.x, 0.75), vec2(0.5, 0.5));
  for (int i = 0; i < 7; i++) {
    if ((m & (1 << i)) == 0) continue;
    bool level = i == 0 || i == 3 || i == 6;
    vec2 h = level ? vec2(hx, t.y) : vec2(t.x, vy);
    vec2 e = abs(p - c[i]) - h;
    lit = max(lit, (1.0 - smoothstep(-aa.x, aa.x, e.x)) * (1.0 - smoothstep(-aa.y, aa.y, e.y)));
  }
  return lit;
}
// how much of the box lo..hi (metres on the yoke's display) covers this pixel, its edges soft over a pixel
float yokeBox(vec2 q, vec2 lo, vec2 hi) {
  vec2 aa = fwidth(q) * 0.7 + 1e-6;
  vec2 a = smoothstep(lo - aa, lo + aa, q) * (1.0 - smoothstep(hi - aa, hi + aa, q));
  return a.x * a.y;
}
// the colour of the 2004 wheel's button (or rotary switch's pointer) nearest p, in the wheel's own frame (WHEEL04.buttons)
vec3 w4Button(vec2 p) {
  vec3 c = vec3(0.5);
  float best = 1.0;
  float d;
${W4_BUTTONS}
  return c;
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
float helmM = 1.0 - smoothstep(-fwidth(vHelm) * 0.8 - 1e-4, fwidth(vHelm) * 0.8 + 1e-4, vHelm);
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
else if (ip == 48) {
  iCol = mix(vec3(0.02, 0.022, 0.03), uPrimary * 0.5, step(0.0, sin(vObjPos.y * 38.0)) * 0.0);
  iRough = 0.8;
  // (a driver whose helmet is a zone, the single-seater's: the helmet's paint and visor where channel 14 is under 0, cut smooth
  // round the neck; 1 on every other driver, so nothing changes there)
  if (helmM > 0.001) {
    iCol = mix(iCol, mix(uAccent, vec3(0.012, 0.014, 0.02), visorM), helmM);
    iRough = mix(iRough, mix(0.22, 0.03, visorM), helmM);
    iMetal = mix(iMetal, visorM, helmM);
    iCC = mix(iCC, 1.0 - visorM, helmM);
  }
}
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
else if (ip == 57) {
  // the single-seater's yoke display, in the wheel's own frame (+x the driver's right; metres from the display's centre): the gear in
  // the middle, the speed over the electric deployment on the left, the active aero's mode over the revs on the right
  vec2 q = vObjPos.xy - vec2(YK_DX, YK_DY);
  vec3 sc = vec3(0.004, 0.006, 0.012);
  sc += vec3(0.05, 0.055, 0.07) * (yokeBox(q, vec2(-0.0158, -0.028), vec2(-0.0146, 0.028)) + yokeBox(q, vec2(0.0146, -0.028), vec2(0.0158, 0.028)));
  int g = int(uCluster.y + 0.5);
  int gd = uCluster.y < -0.5 ? 11 : g <= 0 ? 10 : min(g, 9);
  sc += vec3(1.0, 0.98, 0.92) * yokeDigit(q, vec2(-0.0115, -0.021), vec2(0.0115, 0.022), gd, 0.0048);
  int sv = int(max(uCluster.z, 0.0) + 0.5);
  // (three digits as wide as the bar under them, the last 1.7 mm short of the divider)
  float sl = yokeDigit(q, vec2(-0.026, 0.004), vec2(-0.0175, 0.021), sv % 10, 0.0019);
  if (sv >= 10) sl += yokeDigit(q, vec2(-0.0362, 0.004), vec2(-0.0277, 0.021), (sv / 10) % 10, 0.0019);
  if (sv >= 100) sl += yokeDigit(q, vec2(-0.0464, 0.004), vec2(-0.0379, 0.021), (sv / 100) % 10, 0.0019);
  sc += vec3(0.85, 0.9, 1.0) * sl;
  // the electric deployment: a blue bar that fills while the boost burns (dark while it does not: not even the bar's soft left edge lit)
  float erb = yokeBox(q, vec2(-0.0465, -0.02), vec2(-0.0185, -0.011));
  float dep = clamp(uYoke.y, 0.0, 1.0);
  sc += erb * (vec3(0.006, 0.014, 0.04) + vec3(0.15, 0.4, 1.0) * step(q.x, -0.0465 + 0.028 * dep) * step(0.001, dep));
  // the active aero: a green box while the wings stand open, dark while they are in corner mode
  float aeb = yokeBox(q, vec2(0.0185, 0.006), vec2(0.0465, 0.021));
  sc += aeb * mix(vec3(0.01, 0.012, 0.014), vec3(0.15, 1.0, 0.3), smoothstep(0.4, 0.6, uYoke.x));
  // the revs, in ten steps
  float rf = (q.x - 0.0185) / 0.028;
  float seg = step(0.12, fract(rf * 10.0)) * yokeBox(q, vec2(0.0185, -0.02), vec2(0.0465, -0.011));
  vec3 rc = rf < 0.6 ? vec3(0.1, 0.9, 0.35) : rf < 0.85 ? vec3(1.0, 0.7, 0.08) : vec3(1.0, 0.1, 0.06);
  sc += rc * seg * (0.06 + step(floor(rf * 10.0) + 0.5, clamp(uCluster.x, 0.0, 1.0) * 10.0));
  iCol = vec3(0.01);
  iRough = 0.12;
  iEmis = sc * uScreen * 1.3;
}
else if (ip == 58) {
  // the shift lights over the display: fifteen from left to right, five green, five red, five blue, lit one by one as the revs climb
  // to the shift point, all of them blue on the limiter
  float li = clamp(floor((vObjPos.x - YK_LX0) / YK_LSTEP + 0.5), 0.0, 14.0);
  vec3 lc = li < 4.5 ? vec3(0.04, 1.0, 0.1) : li < 9.5 ? vec3(1.0, 0.02, 0.01) : vec3(0.08, 0.16, 1.0);
  float lim = step(0.5, uCluster.w);
  float on = max(step(0.62 + li * 0.022, clamp(uCluster.x, 0.0, 1.0)), lim);
  lc = mix(lc, vec3(0.08, 0.16, 1.0), lim);
  iCol = lc * 0.04;
  iRough = 0.2;
  iEmis = lc * (0.03 + 1.3 * on) * uScreen;
}
else if (ip == 59) {
  // the 2004 wheel's display, a backlit liquid crystal, in the wheel's own frame (metres from the display's centre): dark figures on a
  // lit yellow-green ground, the segments that are off faintly there; the revs as a bar graph of eight rising bars on the left (from half
  // the limiter's revs to all of them), the gear in the middle, the speed on the right
  vec2 q = vObjPos.xy - vec2(W4_DX, W4_DY);
  int g = int(uCluster.y + 0.5);
  int gd = uCluster.y < -0.5 ? 11 : g <= 0 ? 10 : min(g, 9);
  vec2 glo = vec2(-0.0065, -0.0125), ghi = vec2(0.0065, 0.0125);
  float ink = yokeDigit(q, glo, ghi, gd, 0.003);
  float ghost = yokeDigit(q, glo, ghi, 8, 0.003);
  // (the speed's three digits 5 x 12 mm, the leading ones blank under 100 and 10)
  int sv = int(max(uCluster.z, 0.0) + 0.5);
  vec2 s0 = vec2(0.0215, -0.0065), s1 = vec2(0.015, -0.0065), s2 = vec2(0.0085, -0.0065), sd = vec2(0.005, 0.012);
  ink += yokeDigit(q, s0, s0 + sd, sv % 10, 0.0014);
  ink += step(10.0, float(sv)) * yokeDigit(q, s1, s1 + sd, (sv / 10) % 10, 0.0014);
  ink += step(100.0, float(sv)) * yokeDigit(q, s2, s2 + sd, (sv / 100) % 10, 0.0014);
  ghost += yokeDigit(q, s0, s0 + sd, 8, 0.0014) + yokeDigit(q, s1, s1 + sd, 8, 0.0014) + yokeDigit(q, s2, s2 + sd, 8, 0.0014);
  float rf = clamp(uCluster.x, 0.0, 1.0);
  for (int k = 0; k < 8; k++) {
    float x0 = -0.0275 + 0.00225 * float(k);
    float bar = yokeBox(q, vec2(x0, -0.0065), vec2(x0 + 0.0016, -0.0035 + 0.0012 * float(k)));
    ghost += bar;
    ink += bar * step(0.5 + 0.0625 * float(k), rf);
  }
  ink = min(ink, 1.0);
  ghost = min(ghost, 1.0);
  float edge = max(abs(q.x) / 0.03, abs(q.y) / 0.016);
  vec3 lit = vec3(0.3, 0.42, 0.12) * (1.0 - 0.3 * smoothstep(0.7, 1.0, edge));
  iCol = vec3(0.01);
  iRough = 0.15;
  iEmis = lit * (1.0 - 0.92 * ink) * (1.0 - 0.14 * ghost * (1.0 - ink)) * uScreen * 1.3;
}
else if (ip == 60) {
  // the 2004 wheel's shift lights along its top edge: ten from left to right, four green, three red, three blue, lit one by one over the
  // last revs before the shift point (from 85 % of the limiter's), all of them blue on the limiter
  float li = clamp(floor((vObjPos.x - W4_LX0) / W4_LSTEP + 0.5), 0.0, W4_LN);
  vec3 lc = li < 3.5 ? vec3(0.04, 1.0, 0.1) : li < 6.5 ? vec3(1.0, 0.02, 0.01) : vec3(0.08, 0.16, 1.0);
  float lim = step(0.5, uCluster.w);
  float on = max(step(W4_L0 + li * W4_LD, clamp(uCluster.x, 0.0, 1.0)), lim);
  lc = mix(lc, vec3(0.08, 0.16, 1.0), lim);
  iCol = lc * 0.04;
  iRough = 0.2;
  iEmis = lc * (0.03 + 1.3 * on) * uScreen;
}
else if (ip == 61) {
  // the 2004 wheel's buttons and its rotary switches' pointers, each in its own colour (WHEEL04.buttons)
  iCol = w4Button(vObjPos.xy);
  iRough = 0.32;
  iCC = 0.5;
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
