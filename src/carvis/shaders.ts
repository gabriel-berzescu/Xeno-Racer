import { DMG_FRAG_PARS, DMG_FRAG_PAINT, DMG_VERT_NORMAL, DMG_VERT_PARS } from './damageShader';

/**
 * GLSL injected into MeshPhysicalMaterial for the car body. The body mesh carries per-vertex zone
 * signed distances (aZ0..aZ3, see blueprint.ts) which are interpolated across triangles and
 * thresholded per fragment, giving crisp anti-aliased window cut-outs, trim, lamps, panel gaps…
 * from a ~3 cm mesh.
 */

/** Standalone livery sampler for the far-LOD material (needs vObjPos / vObjNrm varyings). */
export const FAR_FRAG_PARS = /* glsl */ `
uniform sampler2D uSide;
uniform sampler2D uTop;
uniform sampler2D uEnd;
uniform vec4 uRange;
varying vec3 vObjPos;
varying vec3 vObjNrm;
vec3 liveryColor() {
  vec3 an = abs(vObjNrm);
  vec3 w = pow(an, vec3(9.0));
  w /= (w.x + w.y + w.z + 1e-5);
  float lz = uRange.x - uRange.y;
  float s = vObjPos.x >= 0.0 ? (uRange.x - vObjPos.z) / lz : (vObjPos.z - uRange.y) / lz;
  float us = vObjPos.x >= 0.0 ? 0.5 * s : 0.5 + 0.5 * s;
  vec3 cs = texture2D(uSide, vec2(clamp(us, 0.001, 0.999), clamp(vObjPos.y / uRange.z, 0.002, 0.998))).rgb;
  vec3 ct = texture2D(uTop, vec2(0.5 + vObjPos.x / (2.0 * uRange.w), clamp((uRange.x - vObjPos.z) / lz, 0.002, 0.998))).rgb;
  float sg = vObjNrm.z > 0.0 ? 1.0 : -1.0;
  float ue = 0.5 + sg * vObjPos.x / (2.0 * uRange.w);
  ue = vObjNrm.z > 0.0 ? 0.5 * ue : 0.5 + 0.5 * ue;
  vec3 ce = texture2D(uEnd, vec2(clamp(ue, 0.001, 0.999), clamp(vObjPos.y / uRange.z, 0.002, 0.998))).rgb;
  return cs * w.x + ct * w.y + ce * w.z;
}
`;

export const BODY_VERT_PARS = /* glsl */ `
attribute vec4 aZ0;
attribute vec4 aZ1;
attribute vec4 aZ2;
attribute vec4 aZ3;
varying vec4 vZ0;
varying vec4 vZ1;
varying vec4 vZ2;
varying vec4 vZ3;
varying vec3 vObjPos;
varying vec3 vObjNrm;
${DMG_VERT_PARS}
`;

/** Replaces beginnormal_vertex: the crash-deformed point and normal (damageShader.ts). */
export const BODY_VERT_NORMAL = DMG_VERT_NORMAL;

export const BODY_VERT_BEGIN = /* glsl */ `
#include <begin_vertex>
transformed = dmgPos;
vZ0 = aZ0;
vZ1 = aZ1;
vZ2 = aZ2;
vZ3 = aZ3;
vObjPos = position;
vObjNrm = normal;
`;

export const BODY_FRAG_PARS = /* glsl */ `
uniform sampler2D uSide;
uniform sampler2D uTop;
uniform sampler2D uEnd;
uniform vec4 uRange;      // zNose, zTail, yMax, halfWidth
uniform vec3 uPrimary;
uniform vec3 uSecond;
uniform vec3 uAccent;
uniform float uFlake;
uniform float uFinish;
uniform float uBrake;
uniform float uTail;
uniform float uHead;
uniform float uDrl;
uniform float uRev;
uniform float uInterior;
uniform float uInteriorCarbon;
uniform float uGlassAlpha;
uniform vec3 uGlassTint;
uniform vec4 uProj;       // headlight projector: |x|, y, z, radius
uniform vec3 uTrimTint;
uniform float uDbg;
uniform float uWet;       // rain on the car: 0 dry .. 1 soaked (EnvironmentState.wetness)
uniform float uSpd;       // speed (m/s): water beads are blown into streaks along the airflow

varying vec4 vZ0;
varying vec4 vZ1;
varying vec4 vZ2;
varying vec4 vZ3;
varying vec3 vObjPos;
varying vec3 vObjNrm;

float zmask(float sd) {
  float w = fwidth(sd) * 0.8 + 1e-4;
  return 1.0 - smoothstep(-w, w, sd);
}
float zline(float sd, float halfW) {
  float w = fwidth(sd) * 0.8 + 1e-4;
  return 1.0 - smoothstep(halfW - w, halfW + w, abs(sd));
}
float thinLine(float u, float ext, float halfW) {
  float w = fwidth(u) * 0.8 + 1e-4;
  return (1.0 - smoothstep(halfW - w, halfW + w, abs(u))) * zmask(ext);
}
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
vec3 liveryColor() {
  vec3 an = abs(vObjNrm);
  vec3 w = pow(an, vec3(9.0));
  w /= (w.x + w.y + w.z + 1e-5);
  float lz = uRange.x - uRange.y;
  float s = vObjPos.x >= 0.0 ? (uRange.x - vObjPos.z) / lz : (vObjPos.z - uRange.y) / lz;
  float us = vObjPos.x >= 0.0 ? 0.5 * s : 0.5 + 0.5 * s;
  vec3 cs = texture2D(uSide, vec2(clamp(us, 0.001, 0.999), clamp(vObjPos.y / uRange.z, 0.002, 0.998))).rgb;
  vec3 ct = texture2D(uTop, vec2(0.5 + vObjPos.x / (2.0 * uRange.w), clamp((uRange.x - vObjPos.z) / lz, 0.002, 0.998))).rgb;
  float sg = vObjNrm.z > 0.0 ? 1.0 : -1.0;
  float ue = 0.5 + sg * vObjPos.x / (2.0 * uRange.w);
  ue = vObjNrm.z > 0.0 ? 0.5 * ue : 0.5 + 0.5 * ue;
  vec3 ce = texture2D(uEnd, vec2(clamp(ue, 0.001, 0.999), clamp(vObjPos.y / uRange.z, 0.002, 0.998))).rgb;
  return cs * w.x + ct * w.y + ce * w.z;
}
// ---- water on the paint and glass: a jittered grid of small domes, stretched along the airflow ----------------
vec2 wHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
// returns (slope.xy, mask) of one dome per grid cell; dens is the share of cells that hold a drop
vec3 wetBead(vec2 p, float dens) {
  vec2 id = floor(p);
  vec2 f = fract(p);
  vec2 h = wHash22(id);
  float on = step(h.x, dens);
  vec2 c = 0.28 + 0.44 * wHash22(id + 7.3);
  float r = 0.16 + 0.17 * h.y;
  vec2 d = f - c;
  float dd = length(d);
  float m = smoothstep(r, r * 0.55, dd) * on;
  vec2 s = (dd > 1e-4 ? d / dd : vec2(0.0)) * smoothstep(0.0, r, dd) * m;
  return vec3(s, m);
}
// object-space coordinates on the surface plane (flow runs along the car's z), in ~1.8 cm cells
vec2 beadUV(vec3 p, vec3 n, float stretch) {
  vec3 an = abs(n);
  vec2 uv = p.xy;
  if (an.y > an.x && an.y > an.z) uv = vec2(p.x, p.z / stretch);
  else if (an.x > an.z) uv = vec2(p.z / stretch, p.y);
  return uv * 55.0;
}
vec3 gBead = vec3(0.0);
vec2 planarUV(vec3 p, vec3 n) {
  vec3 a = abs(n);
  if (a.y > a.x && a.y > a.z) return p.xz;
  if (a.x > a.z) return p.zy;
  return p.xy;
}
// carbon-fibre 2x2 twill shading: returns (albedo scale, roughness offset)
vec2 carbon(vec2 uv, float px) {
  // px = weave cells per pixel; past ~half a cell the weave can only alias, so fade to its mean
  float aa = smoothstep(0.3, 0.7, px);
  uv *= 135.0;
  vec2 cell = floor(uv);
  vec2 f = fract(uv);
  float twill = mod(cell.x + cell.y, 4.0);
  float dir = step(2.0, twill);
  float tow = dir > 0.5 ? abs(f.x - 0.5) * 2.0 : abs(f.y - 0.5) * 2.0;
  float glint = dir > 0.5 ? 1.0 : 0.0;
  float line = smoothstep(0.82, 1.0, tow);
  float base = mix(0.05, 0.11, glint);
  return mix(vec2(base * (1.0 - 0.5 * line), 0.05 + 0.25 * line), vec2(0.076, 0.075), aa);
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
${DMG_FRAG_PARS}
`;

/** Block placed right after color_fragment: decides albedo / roughness / metalness / clearcoat / emission. */
export const BODY_FRAG_ZONES = /* glsl */ `
float winSd = vZ0.x;
#ifdef GLASS_PASS
  if (winSd > 0.004) discard;
#else
  if (winSd < -0.004) discard;
#endif

bool zBack = !gl_FrontFacing;
int zPart = int(vZ3.y + 0.5);
vec3 zCol = vec3(0.5);
float zRough = 0.4;
float zMetal = 0.0;
float zCC = 1.0;
float zCCRough = 0.03;
vec3 zEmis = vec3(0.0);
float zLine = 0.0;
float zFlake = 0.0;
float zAO = vZ3.x;
float zIsPaint = 1.0;
float zCarbon = 0.0;
// object-space metres per pixel (taken here, in uniform control flow, for the pattern anti-aliasing)
float zPx = length(fwidth(vObjPos));

#ifdef GLASS_PASS
  // dark tinted glass with a ceramic-frit border
  zCol = uGlassTint;
  diffuseColor.a = mix(uGlassAlpha, 1.0, smoothstep(-0.05, -0.022, winSd));
  zRough = 0.025;
  zMetal = 0.0;
  zCC = 0.0;
  zIsPaint = 0.0;
#else
  // ---------- paint ----------
  vec3 paint = liveryColor();
  float finishK = uFinish;
  float ccAmt = 1.0 - smoothstep(0.35, 0.9, finishK);
  zCCRough = mix(0.03, 0.34, smoothstep(0.0, 0.8, finishK));
  zRough = mix(0.34, 0.82, finishK);
  zMetal = uFlake * 0.85;
  zRough = mix(zRough, zRough + 0.06, uFlake);
  zCol = paint;
  zCC = ccAmt;
  zFlake = uFlake;

  if (zPart != 0) {
    vec2 puv = planarUV(vObjPos, vObjNrm);
    if (zPart == 1) {            // carbon
      zCarbon = 1.0;
      vec2 c = carbon(puv, zPx * 135.0);
      zCol = vec3(c.x);
      zRough = c.y;
      zMetal = 0.0;
      zCC = 1.0;
      zCCRough = 0.045;
      zFlake = 0.0;
    } else if (zPart == 2) {     // black plastic
      zCol = vec3(0.012, 0.012, 0.014);
      zRough = 0.55;
      zMetal = 0.0;
      zCC = 0.0;
      zFlake = 0.0;
    } else if (zPart == 3) {     // chrome
      zCol = vec3(0.93, 0.94, 0.96);
      zRough = 0.06;
      zMetal = 1.0;
      zCC = 0.0;
      zFlake = 0.0;
    } else if (zPart == 4) {     // rubber
      zCol = vec3(0.01);
      zRough = 0.92;
      zMetal = 0.0;
      zCC = 0.0;
      zFlake = 0.0;
    } else if (zPart == 5) {     // accent paint (secondary)
      zCol = uSecond;
    } else if (zPart == 6) {     // mirror glass
      zCol = vec3(0.7, 0.74, 0.78);
      zRough = 0.02;
      zMetal = 1.0;
      zCC = 0.0;
      zFlake = 0.0;
    } else if (zPart == 7) {     // burnt titanium exhaust
      float g = clamp(0.5 + 0.5 * sin(vObjPos.z * 40.0 + 2.0 * vObjNrm.y), 0.0, 1.0);
      zCol = mix(vec3(0.35, 0.25, 0.4), vec3(0.6, 0.5, 0.38), smoothstep(0.0, 1.0, abs(vObjNrm.y)));
      zRough = 0.28;
      zMetal = 1.0;
      zCC = 0.0;
      zFlake = 0.0;
    } else if (zPart == 8) {     // tail lamp block
      zCol = vec3(0.35, 0.0, 0.0);
      zRough = 0.1;
      zMetal = 0.0;
      zCC = 1.0;
      zEmis = vec3(1.0, 0.04, 0.02) * (uTail * 1.4 + uBrake * 7.0);
      zFlake = 0.0;
    } else if (zPart == 9) {     // white lamp
      zCol = vec3(0.7);
      zRough = 0.1;
      zEmis = vec3(1.0, 0.95, 0.85) * uRev * 8.0;
      zFlake = 0.0;
    } else if (zPart == 10) {    // accent colour 2 paint
      zCol = uAccent;
    } else if (zPart == 11) {    // brushed silver
      zCol = vec3(0.7);
      zRough = 0.32;
      zMetal = 1.0;
      zCC = 0.0;
      zFlake = 0.0;
    } else if (zPart == 12) {    // amber lamp
      zCol = vec3(0.3, 0.1, 0.0);
      zRough = 0.1;
      zCC = 1.0;
      zFlake = 0.0;
    }
    if (zPart == 1 || zPart == 2 || zPart == 3 || zPart == 4 || zPart == 6 || zPart == 7 || zPart == 8 || zPart == 9 || zPart == 11 || zPart == 12) zIsPaint = 0.0;
  } else {
    // ---------- sculpted-body zones ----------
    float mTrim = zmask(vZ0.y);
    float mCarbon = zmask(vZ0.z);
    float mGrille = zmask(vZ0.w);
    float mHead = zmask(vZ1.x);
    float mTail = zmask(vZ1.z);
    float mRev = zmask(vZ1.w);
    float frontSide = step(0.0, vObjPos.z);
    float mStop = thinLine(vZ1.y, vZ3.w, 0.0085) * (1.0 - frontSide);
    // crash damage: each lamp has its own output and crack (x > 0 is the left side)
    float lampLeft = vObjPos.x >= 0.0 ? 1.0 : 0.0;
    float hOut = mix(uLampOut.y, uLampOut.x, lampLeft);
    float tOut = mix(uLampOut.w, uLampOut.z, lampLeft);
    float hCrk = mix(uLampCrk.y, uLampCrk.x, lampLeft);
    float tCrk = mix(uLampCrk.w, uLampCrk.z, lampLeft);
    vec4 hHit = lampLeft > 0.5 ? uLampHit[0] : uLampHit[1];
    vec4 tHit = lampLeft > 0.5 ? uLampHit[2] : uLampHit[3];

    // window gasket (black rubber ring around the glass)
    float gasket = (1.0 - smoothstep(0.0, 0.016, winSd)) * step(-0.004, winSd);
    mTrim = max(mTrim, gasket);

    vec2 puv = planarUV(vObjPos, vObjNrm);
    // carbon
    if (mCarbon > 0.0) {
      zCarbon = mCarbon;
      vec2 c = carbon(puv, zPx * 135.0);
      zCol = mix(zCol, vec3(c.x), mCarbon);
      zRough = mix(zRough, c.y, mCarbon);
      zMetal = mix(zMetal, 0.0, mCarbon);
      zCCRough = mix(zCCRough, 0.045, mCarbon);
      zCC = mix(zCC, 1.0, mCarbon);
      zFlake *= (1.0 - mCarbon);
      zIsPaint *= (1.0 - mCarbon);
    }
    // black plastic trim
    zCol = mix(zCol, uTrimTint, mTrim);
    zRough = mix(zRough, 0.5, mTrim);
    zMetal = mix(zMetal, 0.0, mTrim);
    zCC = mix(zCC, 0.0, mTrim);
    zFlake *= (1.0 - mTrim);
    zIsPaint *= (1.0 - mTrim);
    // grille: black mesh
    if (mGrille > 0.0) {
      vec2 gp = puv * 70.0;
      vec2 gq = vec2(gp.x + gp.y, gp.x - gp.y) * 0.7071;
      vec2 gf = abs(fract(gq) - 0.5) * 2.0;
      float bar = smoothstep(0.62, 0.78, max(gf.x, gf.y));
      vec3 gc = mix(vec3(0.004), vec3(0.09, 0.09, 0.1), bar);
      zCol = mix(zCol, gc, mGrille);
      zRough = mix(zRough, 0.35, mGrille);
      zMetal = mix(zMetal, bar * 0.7, mGrille);
      zCC = mix(zCC, 0.0, mGrille);
      zAO *= mix(1.0, 0.25 + 0.75 * bar, mGrille);
      zFlake *= (1.0 - mGrille);
      zIsPaint *= (1.0 - mGrille);
    }
    // headlight: smoked glossy lens over a dark housing, with a bright projector and LED signature
    if (mHead > 0.0) {
      vec2 hp = puv * 55.0;
      float hexl = smoothstep(0.35, 0.5, abs(fract(hp.x + hp.y * 0.5) - 0.5)) * 0.5 + 0.5;
      zCol = mix(zCol, vec3(0.006, 0.007, 0.01) * hexl + vec3(0.01), mHead);
      zRough = mix(zRough, 0.1, mHead);
      zMetal = mix(zMetal, 0.0, mHead);
      zCC = mix(zCC, 1.0, mHead);
      zCCRough = mix(zCCRough, 0.05, mHead);
      zFlake *= (1.0 - mHead);
      zIsPaint *= (1.0 - mHead);
      // projector lens
      vec2 pp = vec2(abs(vObjPos.x), vObjPos.y) - uProj.xy;
      float pd = length(pp) - uProj.w;
      float pm = (1.0 - smoothstep(-0.004, 0.004, pd)) * mHead;
      float ring = (1.0 - smoothstep(0.0, 0.005, abs(pd + uProj.w * 0.3)));
      zEmis += vec3(0.95, 0.97, 1.0) * pm * (0.12 + uHead * 9.0) * hOut;
      zCol = mix(zCol, vec3(0.6, 0.65, 0.75), pm * 0.5);
      zEmis += vec3(0.9, 0.95, 1.0) * ring * mHead * (0.15 + uHead * 0.8) * hOut;
      if (hCrk > 0.0) lensDamage(mHead, hCrk, hOut, vObjPos, hHit.xyz, hHit.w, zPx, zCol, zRough, zCC, zEmis, uHead);
    }
    // DRL / LED signature
    float mDrl = thinLine(vZ1.y, vZ3.w, 0.0055) * frontSide;
    if (mDrl > 0.0) {
      zCol = mix(zCol, vec3(0.8, 0.85, 0.9), mDrl);
      zEmis += vec3(0.82, 0.92, 1.0) * mDrl * (uDrl * 3.2 + uHead * 2.2) * hOut;
      zCC = mix(zCC, 1.0, mDrl);
      zFlake *= (1.0 - mDrl);
      zIsPaint *= (1.0 - mDrl);
    }
    // taillight
    if (mTail > 0.0) {
      float seg = 0.55 + 0.45 * smoothstep(0.35, 0.65, abs(fract(vObjPos.x * 90.0) - 0.5) * 2.0);
      seg = mix(seg, 0.775, smoothstep(0.25, 0.6, zPx * 90.0)); // LED segments: fade before they alias
      vec3 lens = vec3(0.32, 0.0, 0.004);
      zCol = mix(zCol, lens, mTail);
      zRough = mix(zRough, 0.08, mTail);
      zMetal = mix(zMetal, 0.0, mTail);
      zCC = mix(zCC, 1.0, mTail);
      zCCRough = mix(zCCRough, 0.015, mTail);
      float core = smoothstep(0.0, -0.018, vZ1.z);
      zEmis += vec3(1.0, 0.035, 0.015) * mTail * (0.25 + 0.75 * core) * seg * (uTail * 1.2 + uBrake * 6.5) * tOut;
      zFlake *= (1.0 - mTail);
      zIsPaint *= (1.0 - mTail);
      if (tCrk > 0.0) lensDamage(mTail, tCrk, tOut, vObjPos, tHit.xyz, tHit.w, zPx, zCol, zRough, zCC, zEmis, uTail + uBrake * 4.0);
    }
    if (mStop > 0.0) {
      zCol = mix(zCol, vec3(0.3, 0.0, 0.0), mStop);
      zRough = mix(zRough, 0.08, mStop);
      zMetal = mix(zMetal, 0.0, mStop);
      zEmis += vec3(1.0, 0.03, 0.01) * mStop * (uTail * 0.5 + uBrake * 9.0) * tOut;
      zFlake *= (1.0 - mStop);
      zIsPaint *= (1.0 - mStop);
    }
    if (mRev > 0.0) {
      zCol = mix(zCol, vec3(0.16), mRev);
      zRough = mix(zRough, 0.06, mRev);
      zMetal = mix(zMetal, 0.0, mRev);
      zEmis += vec3(1.0, 0.97, 0.9) * mRev * uRev * 9.0 * tOut;
      zFlake *= (1.0 - mRev);
      zIsPaint *= (1.0 - mRev);
    }
    // panel gaps
    float l = max(max(zline(vZ2.x, 0.0014), zline(vZ2.y, 0.0014)), max(zline(vZ2.z, 0.0014), zline(vZ2.w, 0.0014)));
    zLine = l * (1.0 - mTrim) * (1.0 - mHead) * (1.0 - mTail);
    zCol *= 1.0 - 0.9 * zLine;
    zRough = mix(zRough, 0.6, zLine);
  }
#endif

${DMG_FRAG_PAINT}
if (zBack) {
  // cabin interior seen through the glass: dark headliner / door cards (carbon tub on the prototype)
  vec2 cuv = planarUV(vObjPos, vObjNrm);
  vec2 cb = carbon(cuv, zPx * 135.0);
  zCol = mix(vec3(0.018, 0.018, 0.021), vec3(cb.x * 0.9), uInteriorCarbon);
  zRough = mix(0.9, cb.y + 0.2, uInteriorCarbon);
  zMetal = 0.0;
  zCC = 0.0;
  zFlake = 0.0;
  zEmis = vec3(0.0);
  zAO *= uInterior;
}
#ifndef GLASS_PASS
if (uDbg > 0.5) {
  vec3 dc = vec3(0.72);
  dc = mix(dc, vec3(0.1, 0.3, 1.0), zmask(vZ0.x));
  dc = mix(dc, vec3(0.0), zmask(vZ0.y) * 0.85);
  dc = mix(dc, vec3(0.55, 0.3, 0.75), zmask(vZ0.z));
  dc = mix(dc, vec3(0.0, 0.8, 0.2), zmask(vZ0.w));
  dc = mix(dc, vec3(1.0, 0.85, 0.1), zmask(vZ1.x));
  dc = mix(dc, vec3(1.0), thinLine(vZ1.y, vZ3.w, 0.006) * step(0.0, vObjPos.z));
  dc = mix(dc, vec3(1.0, 0.1, 0.1), zmask(vZ1.z));
  dc = mix(dc, vec3(1.0, 0.5, 0.0), zmask(vZ1.w));
  dc = mix(dc, vec3(1.0, 0.0, 0.5), thinLine(vZ1.y, vZ3.w, 0.009) * (1.0 - step(0.0, vObjPos.z)));
  float ln = max(max(zline(vZ2.x, 0.004), zline(vZ2.y, 0.004)), max(zline(vZ2.z, 0.004), zline(vZ2.w, 0.004)));
  dc = mix(dc, vec3(0.0), ln);
  zCol = dc;
  zMetal = 0.0;
  zRough = 0.7;
  zCC = 0.0;
  zFlake = 0.0;
}
if (uDbg > 1.5) {
  zCol = vec3(0.0);
  zEmis = normalize(vObjNrm) * 0.5 + 0.5;
  zMetal = 0.0;
  zRough = 1.0;
  zCC = 0.0;
  zFlake = 0.0;
}
if (uDbg > 3.5) {
  // clay: one matte grey, to judge the forms and the crumple relief without the paint
  zCol = vec3(0.45);
  zEmis = vec3(0.0);
  zMetal = 0.0;
  zRough = 0.5;
  zCC = 0.0;
  zFlake = 0.0;
}
#endif
// ---------- rain ----------
gBead = vec3(0.0);
if (uWet > 0.001) {
  float pxW = length(fwidth(vObjPos));
  float beadFade = 1.0 - smoothstep(0.003, 0.009, pxW);
#ifdef GLASS_PASS
  // droplets on the glass: more of them, bigger, a little milky
  gBead = wetBead(beadUV(vObjPos, vObjNrm, 1.0 + uSpd * 0.06), 0.8 * uWet);
  float bm = gBead.z * beadFade;
  diffuseColor.a = mix(diffuseColor.a, 1.0, bm * 0.45 * uWet);
  zCol += bm * 0.012 * uWet;
#else
  float wp = uWet * zIsPaint;
  // a water film: darker, glossier, and (close up) beaded
  zCol *= 1.0 - 0.14 * wp;
  zRough = mix(zRough, 0.1 + 0.2 * zRough, wp);
  zCCRough = mix(zCCRough, 0.03, wp * 0.6);
  gBead = wetBead(beadUV(vObjPos, vObjNrm, 1.0 + uSpd * 0.05), 0.55 * uWet) * vec3(1.0, 1.0, beadFade * zIsPaint);
#endif
}
diffuseColor.rgb = zCol;
`;

export const BODY_FRAG_ROUGH = /* glsl */ `
roughnessFactor = zRough;
`;
export const BODY_FRAG_METAL = /* glsl */ `
metalnessFactor = zMetal;
`;

/** after normal_fragment_maps: flake sparkle on the base layer + panel-gap bump */
export const BODY_FRAG_NORMAL = /* glsl */ `
#ifndef GLASS_PASS
{
  // (the crumple relief is finer than the mesh, so it fades out before it can only alias)
  float hgt = -0.00022 * zLine + dmgRelief * (1.0 - smoothstep(0.004, 0.012, zPx));
  vec2 dH = vec2(dFdx(hgt), dFdy(hgt));
  vec3 nl = perturbNormalH(-vViewPosition, normal, dH, faceDirection);
  float px = length(fwidth(vObjPos));
  normal = nl;
  nonPerturbedNormal = nl;
  vec3 fc = floor(vObjPos * 420.0);
  vec3 fh = hash33(fc) * 2.0 - 1.0;
  float fade = 1.0 - smoothstep(0.0012, 0.0035, px);
  vec3 ft = fh - normal * dot(fh, normal);
  normal = normalize(normal + ft * 0.24 * zFlake * fade);
}
#endif
`;

/** after BODY_FRAG_NORMAL: water beads tilt the shading normal (they scatter the reflection into sparkle) */
export const BODY_FRAG_BEADS = /* glsl */ `
if (uWet > 0.001 && gBead.z > 0.01) {
  vec3 tV = normalize(dFdx(-vViewPosition));
  vec3 bV = normalize(dFdy(-vViewPosition));
  float tilt = 0.55 * gBead.z;
  normal = normalize(normal - (tV * gBead.x + bV * gBead.y) * tilt);
}
`;

export const BODY_FRAG_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += zEmis;
#ifndef GLASS_PASS
if (uDbg > 2.5 && uDbg < 3.5) {
  // zebra reflection test: bright/dark bands in reflection space reveal any waviness of the surface
  vec3 rv = reflect(-normalize(vViewPosition), nonPerturbedNormal);
  vec3 rw = normalize((vec4(rv, 0.0) * viewMatrix).xyz);
  float band = step(0.5, fract(rw.y * 5.0 + rw.x * 1.5));
  totalEmissiveRadiance = vec3(band) * 0.9;
  diffuseColor.rgb = vec3(0.0);
}
#endif
`;

export const BODY_FRAG_PHYS = /* glsl */ `
#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
  material.clearcoat = zCC * clearcoat;
  material.clearcoatRoughness = max(zCCRough, 0.0525) + geometryRoughness;
  material.clearcoatRoughness = min(material.clearcoatRoughness, 1.0);
#endif
`;

export const BODY_FRAG_AO = /* glsl */ `
{
  float ambientOcclusion = zAO;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= mix(1.0, ambientOcclusion, 0.8);
  #endif
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif
}
`;

/** glass: keep reflections un-attenuated by alpha (premultiplied-style output). */
export const GLASS_OPAQUE = /* glsl */ `
#ifdef OPAQUE
diffuseColor.a = 1.0;
#endif
gl_FragColor = vec4( (totalDiffuse + totalEmissiveRadiance) * diffuseColor.a + totalSpecular, diffuseColor.a );
`;
