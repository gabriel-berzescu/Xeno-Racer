/**
 * The city's one building material: Mediterranean facades, tile and flat roofs, all shaded procedurally on cheap geometry.
 *
 * A facade is a plain quad whose uv is in metres (u along the wall, v up from the floor datum); the fragment shader draws the
 * windows, shutters, balconies, shop fronts and plaster from a per-building seed, so neighbours never repeat. At night a share of
 * the windows is lit (steady, in warm and cool tones) and the shop fronts glow. Far away the window grid fades to its average, so
 * a distant hillside of blocks is a soft, lit texture instead of shimmering pixels.
 *
 * Vertex attributes (in addition to position / normal / uv / color = wall colour):
 *   aFa  x kind (0 wall, 1 tile roof, 2 flat roof, 3 side wall, 4 trim, 5 awning, 6 metal roof, 7 stone), y seed (0..1), z floors, w ground-floor height (m)
 *        (stone: z = rows of tall windows, w = height of the first row, aFb.x = the wall's width)
 *   aFb  x lot width (m), y share of lit windows, z, w reserved
 */
import * as THREE from 'three';
import type { Ctx } from './ctx';

export const FACADE_KIND = { wall: 0, tile: 1, flat: 2, side: 3, trim: 4, awning: 5, metal: 6, stone: 7 } as const;

const VERT_DECL = /* glsl */ `
attribute vec4 aFa;
attribute vec4 aFb;
varying vec4 vFa;
varying vec4 vFb;
varying vec2 vFuv;
varying vec3 vFw;
`;

const FRAG_DECL = /* glsl */ `
uniform sampler2D uNoise;
uniform float uNight;
uniform float uWet;
varying vec4 vFa;
varying vec4 vFb;
varying vec2 vFuv;
varying vec3 vFw;

float fHash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float fHash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

// outputs of the facade / roof shading
vec3 gFAlbedo;
float gFRough;
float gFMetal;
vec3 gFEmit;

// shutter and door colours: green, blue, brown, cream, red, grey
vec3 fShutter(float h) {
  if (h < 0.28) return vec3(0.10, 0.27, 0.15);
  if (h < 0.5) return vec3(0.12, 0.22, 0.42);
  if (h < 0.7) return vec3(0.22, 0.12, 0.07);
  if (h < 0.82) return vec3(0.62, 0.56, 0.44);
  if (h < 0.93) return vec3(0.42, 0.09, 0.07);
  return vec3(0.30, 0.31, 0.30);
}
// lit-window colours: tungsten, warm white, television blue, green, rose
vec3 fLit(float h) {
  if (h < 0.50) return vec3(1.00, 0.62, 0.30);
  if (h < 0.76) return vec3(1.00, 0.80, 0.55);
  if (h < 0.88) return vec3(0.52, 0.68, 1.00);
  if (h < 0.94) return vec3(0.70, 1.00, 0.62);
  return vec3(1.00, 0.46, 0.38);
}
// awning colours
vec3 fAwning(float h) {
  if (h < 0.25) return vec3(0.62, 0.08, 0.06);
  if (h < 0.5) return vec3(0.07, 0.24, 0.38);
  if (h < 0.7) return vec3(0.10, 0.34, 0.16);
  if (h < 0.85) return vec3(0.82, 0.66, 0.22);
  return vec3(0.78, 0.74, 0.66);
}

// signed distance to a window opening centred at the origin: half width a, half height b, optionally with a round arch on top
float fWin(vec2 p, float a, float b, float arch) {
  float d = max(abs(p.x) - a, abs(p.y) - b);
  if (arch > 0.5 && p.y > b - a) d = length(vec2(p.x, p.y - (b - a))) - a;
  return d;
}

// ground floor: shop fronts, a doorway, or an arcade
void fGround(float W, float rS, float gH, vec3 plaster, vec4 n2, vec3 frameCol, vec3 shutCol, float groundKind) {
  float u = vFuv.x;
  float v = vFuv.y;
  float Wb = W / max(1.0, floor(W / mix(3.4, 5.2, fHash11(rS * 47.1)) + 0.5));
  float ib = floor(u / Wb);
  float x = (fract(u / Wb) - 0.5) * Wb;
  float hb = fHash12(vec2(ib, rS * 91.0));
  vec3 stone = mix(plaster, vec3(0.42, 0.38, 0.33), 0.55);
  float openH = gH - 0.95;
  gFAlbedo = plaster;
  gFRough = 0.9;
  gFMetal = 0.0;
  gFEmit = vec3(0.0);
  if (v < 0.55) {
    gFAlbedo = stone * (0.85 + 0.15 * n2.r);
  } else if (groundKind < 0.62) {
    // shop front: a glazed opening under an awning and a sign band
    float a = Wb * 0.5 - 0.35;
    float d = max(abs(x) - a, max(0.55 - v, v - openH));
    float closed = step(0.8, hb);
    if (d < 0.0) {
      float k = clamp(-d / 0.1, 0.0, 1.0);
      if (closed > 0.5) {
        float sl = 0.82 + 0.18 * step(0.5, fract(v * 14.0));
        gFAlbedo = mix(frameCol, vec3(0.28, 0.29, 0.28) * sl, k);
        gFRough = 0.55;
        gFMetal = 0.5 * k;
      } else {
        // glazing with a lit interior at night: brighter toward the ceiling
        float inner = 0.55 + 0.45 * smoothstep(0.55, openH, v);
        gFAlbedo = mix(frameCol, vec3(0.02, 0.025, 0.03), k);
        gFRough = mix(0.5, 0.08, k);
        float sh = fHash12(vec2(ib, rS * 57.0));
        vec3 lc = sh < 0.7 ? vec3(1.0, 0.74, 0.44) : (sh < 0.86 ? vec3(0.62, 0.78, 1.0) : vec3(1.0, 0.5, 0.42));
        gFEmit = lc * (0.3 + 0.6 * fHash12(vec2(ib, rS * 71.0))) * inner * uNight * k;
      }
    } else if (v > openH && v < openH + 0.42) {
      float stripe = step(0.5, fract(u / 0.42));
      gFAlbedo = fAwning(fHash12(vec2(ib, rS * 13.0))) * mix(0.78, 1.0, stripe) * (0.9 + 0.2 * n2.r);
      gFRough = 0.8;
    } else if (v >= openH + 0.42) {
      gFAlbedo = mix(vec3(0.07, 0.07, 0.08), plaster, 0.25);
      gFEmit = vec3(0.9, 0.75, 0.5) * 0.25 * uNight * step(abs(x), a - 0.2) * step(0.5, hb);
    } else if (d < 0.1) {
      gFAlbedo = frameCol * 0.9;
    }
  } else if (groundKind < 0.9) {
    // a doorway at one bay, grilled windows at the others
    float isDoor = step(abs(ib - floor(W / Wb * 0.5)), 0.5);
    float a = mix(0.46, 0.62, isDoor);
    float top = mix(2.3, 2.5, isDoor);
    float bot = mix(0.95, 0.0, isDoor);
    float d = fWin(vec2(x, v - (top + bot) * 0.5), a, (top - bot) * 0.5, 1.0);
    if (d < 0.0) {
      float k = clamp(-d / 0.08, 0.0, 1.0);
      vec3 dc = isDoor > 0.5 ? shutCol * 0.85 : vec3(0.03, 0.035, 0.04);
      gFAlbedo = mix(frameCol, dc, k);
      gFRough = isDoor > 0.5 ? 0.6 : 0.1;
      if (isDoor < 0.5) {
        float gr = step(0.55, fract(x / 0.14)) * k;
        gFAlbedo = mix(gFAlbedo, vec3(0.03), gr * 0.9);
        gFEmit = fLit(fHash12(vec2(ib, rS * 5.0))) * 0.5 * step(fHash12(vec2(ib, rS * 9.0)), 0.5) * uNight * k * (1.0 - gr);
      } else {
        gFEmit = vec3(1.0, 0.7, 0.4) * 0.06 * uNight;
      }
    } else if (d < 0.2) {
      gFAlbedo = stone * 1.2;
    } else {
      gFAlbedo = mix(plaster, stone, 0.35);
    }
  } else {
    // arcade: dark arches
    float a = Wb * 0.5 - 0.5;
    float d = fWin(vec2(x, v - (gH - 0.3) * 0.5), a, (gH - 0.3) * 0.5, 1.0);
    if (d < 0.0) {
      gFAlbedo = vec3(0.025, 0.022, 0.02);
      gFEmit = vec3(1.0, 0.66, 0.36) * 0.4 * uNight * step(0.5, hb) * (0.5 + 0.5 * smoothstep(0.0, 1.2, -d));
      gFRough = 0.5;
    } else if (d < 0.25) {
      gFAlbedo = stone * 1.15;
    }
  }
}

void fWall(float aa) {
  float u = vFuv.x;
  float v = vFuv.y;
  float rS = vFa.y;
  float W = max(vFb.x, 3.0);
  float gH = vFa.w;
  bool blind = vFa.x > 2.5;
  vec3 wall = vColor.rgb;

  // per-building style, all from the seed
  float pitch = mix(2.5, 3.9, fHash11(rS * 3.1));
  float nb = max(1.0, floor(W / pitch + 0.5));
  float Wp = W / nb;
  float Hf = mix(3.0, 3.5, fHash11(rS * 5.7));
  float wwf = mix(0.40, 0.56, fHash11(rS * 7.3));
  float whf = mix(0.50, 0.64, fHash11(rS * 9.1));
  float arch = fHash11(rS * 11.7) < 0.27 ? 1.0 : 0.0;
  float shutKind = fHash11(rS * 13.3) < 0.55 ? (fHash11(rS * 31.3) < 0.55 ? 1.0 : 2.0) : 0.0;
  vec3 shutCol = fShutter(fHash11(rS * 19.1));
  vec3 frameCol = mix(vec3(0.82, 0.78, 0.68), vec3(0.20, 0.13, 0.08), step(0.62, fHash11(rS * 37.7)));
  float balcony = fHash11(rS * 23.7);
  float ornate = step(0.4, fHash11(rS * 41.9));
  float groundKind = fHash11(rS * 43.3);
  float litFrac = vFb.y * uNight;

  // plaster: low-frequency tone, mottling, grime near the ground
  vec4 n1 = texture2D(uNoise, vec2(u * 0.071 + rS * 7.7, v * 0.071 + rS * 3.1));
  vec4 n2 = texture2D(uNoise, vec2(u * 0.23 + rS * 1.3, v * 0.23 - rS * 4.7));
  float tone = 0.88 + 0.22 * n1.r + 0.12 * (n2.g - 0.5);
  vec3 plaster = wall * tone;
  plaster *= 1.0 - 0.22 * (1.0 - smoothstep(0.0, 2.2, v)) * (0.5 + 0.5 * n2.b);

  gFAlbedo = plaster;
  gFRough = 0.9;
  gFMetal = 0.0;
  gFEmit = vec3(0.0);

  // distance: 0 near .. 1 far (a window cell under ~6 px): the grid fades to its mean
  float lod = smoothstep(0.16, 0.42, max(fwidth(u) / Wp, fwidth(v) / Hf));

  if (v < 0.0) {
    // stone plinth where the street climbs away from the floor datum
    float c = 0.5 + 0.5 * fHash12(vec2(floor(u / 1.2), floor(v / 0.45)));
    gFAlbedo = mix(vec3(0.34, 0.31, 0.27), vec3(0.5, 0.46, 0.4), c) * (0.9 + 0.2 * n2.r);
    gFRough = 0.95;
  } else if (v < gH && !blind) {
    fGround(W, rS, gH, plaster, n2, frameCol, shutCol, groundKind);
  } else {
    // upper floors
    float vv = blind ? v : v - gH;
    float fl = floor(vv / Hf);
    float ix = floor(u / Wp);
    vec2 cellId = vec2(ix, fl) + rS * 91.7;
    float present = blind ? step(0.62, fHash12(cellId + 5.3)) : 1.0;
    float a = wwf * Wp * 0.5;
    float hh = Hf * whf * 0.5;
    float yb = Hf * 0.2;
    float isBal = (balcony < 0.34 && fl > 0.5 && mod(fl, 2.0) < 0.5) || (balcony >= 0.34 && balcony < 0.5 && fl > 0.5 && fl < 1.5) ? 1.0 : 0.0;
    if (isBal > 0.5) {
      hh *= 1.25;
      yb -= Hf * 0.04;
    }
    vec2 p = vec2((fract(u / Wp) - 0.5) * Wp, fract(vv / Hf) * Hf - (yb + hh));
    float d = fWin(p, a, hh, arch);
    float aaw = max(aa, 0.02);
    if (present > 0.5) {
      float glass = 1.0 - smoothstep(-aaw, aaw, d);
      float inFrame = glass * smoothstep(-0.10, -0.06, d);
      float cellH = fHash12(cellId);
      // darker streaks run down from the sills; stone surround and sill
      float streak = smoothstep(a + 0.12, a - 0.1, abs(p.x)) * smoothstep(-1.4, 0.0, p.y + hh) * step(p.y, -hh);
      vec3 alb = plaster * (1.0 - 0.14 * streak * (0.4 + 0.6 * n2.g));
      float surround = (1.0 - smoothstep(0.0, 0.18, d)) * ornate;
      alb = mix(alb, plaster * 1.18 + 0.03, surround * 0.75);
      float sill = step(abs(p.x), a + 0.12) * step(-hh - 0.1, p.y) * step(p.y, -hh);
      alb = mix(alb, plaster * 1.25 + 0.04, sill * 0.85);
      alb *= 1.0 - 0.18 * step(abs(p.x), a + 0.12) * step(-hh - 0.5, p.y) * step(p.y, -hh - 0.1);
      // the room: a lit window shows a warm ceiling, dimmer toward the floor
      float lit = step(fHash12(cellId + 17.3), litFrac);
      vec3 lc = fLit(fHash12(cellId + 29.1)) * mix(0.55, 1.25, fHash12(cellId + 3.7));
      float inner = 0.7 + 0.3 * smoothstep(-hh, hh, p.y);
      vec3 glassCol = mix(vec3(0.025, 0.035, 0.05), vec3(0.2, 0.17, 0.14), step(0.9, cellH) * 0.8);
      float rough = 0.9;
      vec3 emit = vec3(0.0);
      vec3 c = mix(alb, mix(glassCol, frameCol, inFrame), glass);
      float shut = 0.0;
      float leaf = 0.0;
      if (shutKind > 0.5 && !blind) {
        float one = fHash12(cellId + 61.0);
        float closed = shutKind < 1.5 ? step(0.18, one) : step(0.82, one);
        if (closed > 0.5) {
          shut = glass;
          float slat = 0.8 + 0.2 * step(0.5, fract(p.y * 17.0));
          c = mix(c, shutCol * slat * (0.9 + 0.2 * n2.r), glass);
          lit = 0.0;
        } else {
          float dx = abs(p.x) - a - 0.04;
          leaf = step(0.0, dx) * step(dx, a * 0.55) * step(abs(p.y), hh);
          c = mix(c, shutCol * (0.9 + 0.2 * n2.r), leaf);
        }
      }
      rough = mix(0.9, shut > 0.5 ? 0.7 : mix(0.07, 0.5, inFrame), glass);
      float bar = step(abs(p.x), 0.03) + step(abs(p.y - hh * 0.25), 0.03);
      c = mix(c, frameCol, glass * (1.0 - inFrame) * (1.0 - shut) * min(1.0, bar) * 0.9);
      emit = lc * inner * lit * (1.0 - inFrame) * (1.0 - 0.5 * min(1.0, bar)) * glass * (1.0 - shut);
      if (isBal > 0.5) {
        // balcony: a slab under the window and railing bars in front of it
        float slab = step(abs(p.x), a + 0.3) * step(-hh - 0.2, p.y) * step(p.y, -hh + 0.02);
        c = mix(c, plaster * 0.82, slab);
        float rail = step(abs(p.x), a + 0.3) * step(-hh + 0.02, p.y) * step(p.y, -hh + 1.0);
        float bars = step(0.6, fract(p.x / 0.12)) + step(abs(p.y + hh - 1.0), 0.035);
        c = mix(c, vec3(0.025), rail * min(1.0, bars) * 0.9);
      }
      gFAlbedo = c;
      gFRough = rough;
      gFEmit = emit;
    } else {
      gFAlbedo = plaster;
    }
  }

  // far away: the window grid fades to its mean
  float litMean = litFrac * 0.17;
  gFAlbedo = mix(gFAlbedo, mix(plaster, plaster * 0.55, 0.22), lod * 0.85);
  gFEmit = mix(gFEmit, vec3(1.0, 0.68, 0.38) * litMean * 1.1, lod);
  gFRough = mix(gFRough, 0.9, lod);
}

// dressed stone: coursed ashlar blocks and rows of tall pointed windows (cathedral, castle, towers)
void fStone() {
  float u = vFuv.x;
  float v = vFuv.y;
  float rS = vFa.y;
  vec3 col = vColor.rgb;
  float row = floor(v / 0.3);
  float bu = u / 0.75 + 0.5 * mod(row, 2.0) + fHash11(row * 3.7 + rS * 11.0) * 3.0;
  float blk = fHash12(vec2(floor(bu), row) + rS * 17.0);
  vec4 n2 = texture2D(uNoise, vec2(u * 0.11 + rS * 3.0, v * 0.11));
  vec3 t = col * (0.8 + 0.32 * blk) * (0.88 + 0.24 * n2.g);
  // joints
  float jx = smoothstep(0.0, 0.05, fract(bu)) * smoothstep(1.0, 0.95, fract(bu));
  float jy = smoothstep(0.0, 0.07, fract(v / 0.3)) * smoothstep(1.0, 0.93, fract(v / 0.3));
  t *= 0.7 + 0.3 * jx * jy;
  t *= 1.0 - 0.2 * (1.0 - smoothstep(0.0, 3.0, v)) * (0.5 + 0.5 * n2.b);
  // rows of tall pointed windows
  float W = max(vFb.x, 3.0);
  float nb = max(1.0, floor(W / 4.6 + 0.5));
  float Wp = W / nb;
  float rows = vFa.z;
  float pitchV = 6.2;
  float vv = v - vFa.w;
  float emit = 0.0;
  vec3 emitCol = vec3(0.0);
  gFRough = 0.92;
  if (rows > 0.5 && vv > 0.0 && vv < rows * pitchV) {
    float fl = floor(vv / pitchV);
    vec2 p = vec2((fract(u / Wp) - 0.5) * Wp, fract(vv / pitchV) * pitchV - 3.0);
    float d = fWin(p, 0.5, 1.7, 1.0);
    float cellH = fHash12(vec2(floor(u / Wp), fl) + rS * 33.0);
    float glass = 1.0 - smoothstep(-0.03, 0.03, d);
    float rim = 1.0 - smoothstep(0.0, 0.25, d + 0.12);
    t = mix(t, t * 1.2, rim * (1.0 - glass) * 0.5);
    if (glass > 0.0) {
      // stained glass by day: deep blues, reds and ambers; by night a faint glow behind it
      vec3 gc = cellH < 0.33 ? vec3(0.04, 0.08, 0.2) : (cellH < 0.66 ? vec3(0.2, 0.04, 0.04) : vec3(0.28, 0.17, 0.04));
      t = mix(t, gc, glass);
      gFRough = mix(gFRough, 0.15, glass);
      emit = glass;
      emitCol = gc * 3.0 * (0.4 + 0.6 * cellH);
    }
  }
  float lod = smoothstep(0.1, 0.3, max(fwidth(u), fwidth(v)) / 0.4);
  gFAlbedo = mix(t, col * 0.8, lod);
  gFEmit = emitCol * emit * uNight * 0.6 * (1.0 - lod);
  // floodlit monuments: the share of lit windows (aFb.y) is, for dressed stone, how strongly the floodlights wash it after dark
  gFEmit += gFAlbedo * vFb.y * uNight * 0.42;
  gFMetal = 0.0;
}

void fRoof(bool tile) {
  float u = vFuv.x;
  float v = vFuv.y;
  float rS = vFa.y;
  vec4 n1 = texture2D(uNoise, vec2(u * 0.05 + rS * 5.0, v * 0.05 + rS * 2.0));
  vec4 n2 = texture2D(uNoise, vec2(u * 0.31, v * 0.31) + rS);
  vec3 col = vColor.rgb;
  float lod = smoothstep(0.1, 0.35, max(fwidth(u), fwidth(v)) / 0.22);
  if (tile) {
    // curved clay tiles in staggered rows, lighter where the sun has bleached them, mossy in the damp
    float row = floor(v / 0.28);
    float tu = u / 0.2 + 0.5 * mod(row, 2.0);
    float h = fHash12(vec2(floor(tu), row) + rS * 51.0);
    float fy = fract(v / 0.28);
    float fx = fract(tu);
    vec3 t = col * mix(0.72, 1.12, h);
    t *= 0.78 + 0.22 * smoothstep(0.0, 0.3, fy) * (1.0 - 0.25 * smoothstep(0.7, 1.0, fy));
    t *= 1.0 - 0.18 * smoothstep(0.35, 0.5, abs(fx - 0.5));
    t = mix(t, t * vec3(0.78, 0.9, 0.7), smoothstep(0.62, 0.78, n1.g) * 0.6);
    t *= 0.9 + 0.2 * n2.r;
    gFAlbedo = mix(t, col * 0.85, lod);
    gFRough = 0.82;
  } else {
    // flat roof: bitumen and gravel with stains
    vec3 t = vec3(0.17, 0.165, 0.155) * (0.8 + 0.4 * n1.r) * (0.9 + 0.2 * n2.g);
    t = mix(t, vec3(0.3, 0.29, 0.27), smoothstep(0.65, 0.8, n1.b) * 0.7);
    gFAlbedo = t;
    gFRough = 0.92;
  }
  gFMetal = 0.0;
  gFEmit = vec3(0.0);
}
`;

const FRAG_MAP = /* glsl */ `
  gFAlbedo = vColor.rgb;
  gFRough = 0.9;
  gFMetal = 0.0;
  gFEmit = vec3(0.0);
  float fKind = vFa.x;
  if (fKind < 0.5 || (fKind > 2.5 && fKind < 3.5)) fWall(max(fwidth(vFuv.x), fwidth(vFuv.y)));
  else if (fKind < 1.5) fRoof(true);
  else if (fKind < 2.5) fRoof(false);
  else if (fKind > 4.5 && fKind < 5.5) {
    // awning: coloured stripes along the wall
    gFAlbedo = vColor.rgb * mix(0.78, 1.0, step(0.5, fract(vFuv.x / 0.42)));
    gFRough = 0.8;
  } else if (fKind > 6.5) {
    fStone();
  } else if (fKind > 5.5) {
    // metal roof (domes, spires): patinated copper
    gFAlbedo = vColor.rgb * (0.85 + 0.3 * texture2D(uNoise, vFuv * 0.1).r);
    gFRough = 0.45;
    gFMetal = 0.5;
  } else {
    // trim, parapets, chimneys: plain plaster
    vec4 nt = texture2D(uNoise, vFw.xz * 0.2 + vFw.y * 0.13);
    gFAlbedo = vColor.rgb * (0.9 + 0.2 * nt.r);
    gFRough = 0.9;
  }
  gFAlbedo *= mix(1.0, 0.7, uWet);
  gFRough = mix(gFRough, gFRough * 0.55 + 0.04, uWet);
  diffuseColor.rgb = gFAlbedo;
`;

/** The facade material: one shader program for every building; the day / night state follows the environment. */
export function makeFacadeMaterial(ctx: Ctx): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, envMapIntensity: 0.85 });
  mat.name = 'facade';
  const uNight = { value: 0 };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNoise = { value: ctx.tex.noise };
    shader.uniforms.uNight = uNight;
    shader.uniforms.uWet = ctx.wet.uWet;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_DECL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFa = aFa; vFb = aFb; vFuv = uv; vFw = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    // the helpers read the vertex colour, which is declared after <common>
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <color_pars_fragment>', '#include <color_pars_fragment>\n' + FRAG_DECL)
      .replace('#include <color_fragment>', '')
      .replace('#include <map_fragment>', FRAG_MAP)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gFRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = gFMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += gFEmit * 2.2;');
  };
  mat.customProgramCacheKey = () => 'facade-v3';
  mat.userData.wetShader = true;
  ctx.envListeners.push((env) => {
    uNight.value = Math.min(1, Math.max(0, (env.darkness - 0.15) / 0.7));
  });
  return mat;
}
