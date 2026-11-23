/**
 * The megacity's one building material (megacity.ts): glass curtain walls, brutalist concrete, podiums of shop fronts, flat roofs,
 * illuminated signs and strips of light, all drawn procedurally on plain quads whose uv is in metres.
 *
 * The city is dark and its lights carry the picture: a share of the windows is lit (uneven from floor to floor and from tower to
 * tower), thin lines of light run along crowns, edges and floors, and the signs are rows of xeno-glyphs (strokes switched on at random
 * between the nodes of a small lattice: no writing system, no font), some of them scrolling, stuttering or swept by a scan line. One
 * clock (uTime) drives every animation. By day nothing glows: the windows are dark glass, the signs unlit panels. Far away the window
 * grid and the glyphs fade to their mean, and a line thinner than a pixel keeps its energy instead of flickering.
 *
 * Vertex attributes (beside position / normal / uv / color), through CityBuf's `Style`:
 *   aFa  x kind (CYBER_KIND), y seed (0..1), z `floors`, w `gH`
 *   aFb  x `w`, y `lit`, z `a`, w `b`
 * and what each kind reads from them:
 *   glass, concrete  color = the wall's tint, floors = height of the wall's top above the datum (m), gH = height of the podium (0: none),
 *                    w = the wall's width (m), lit = share of lit windows, a = accent (0 teal, 1 pink, 2 violet, 3 cold white, 4 amber),
 *                    b = flags (1 crown band, 2 edge strips, 4 floor bands, 8 vertical lines)
 *   roof             w, floors = the roof's two sides (m; 0 = no parapet drawn)
 *   plain            color, lit = metalness
 *   sign             color = its light, w and floors = width and height (m), gH = glyph height (m), a = SIGN_MODE, b = 1 for a light box
 *   light            color = its light, lit = strength, a = 0 steady, 1 an aircraft warning light, 2 breathing
 */
import * as THREE from 'three';
import type { Ctx } from './ctx';

export const CYBER_KIND = { glass: 0, concrete: 1, roof: 2, plain: 3, sign: 4, light: 5 } as const;
export const CYBER_FLAG = { crown: 1, edges: 2, bands: 4, lines: 8 } as const;
/** What a sign shows: lines of glyphs, the same scrolling up, one column written downward, a screen, one big mark over a line. */
export const SIGN_MODE = { lines: 0, scroll: 1, column: 2, screen: 3, mark: 4 } as const;

/** The city's lights, linear RGB, in the order of the accent index: teal, hot pink, violet, cold white, amber. */
export const ACCENTS: readonly (readonly [number, number, number])[] = [
  [0.03, 1.0, 0.66],
  [1.6, 0.07, 0.32],
  [0.85, 0.22, 1.7],
  [0.62, 0.78, 1.0],
  [1.15, 0.52, 0.08],
];

const glVec = (c: readonly number[]): string => `vec3(${c.map((x) => x.toFixed(3)).join(', ')})`;

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
uniform float uSign;
uniform float uWet;
uniform float uTime;
varying vec4 vFa;
varying vec4 vFb;
varying vec2 vFuv;
varying vec3 vFw;

float cHash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float cHash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

// the seed, snapped to the middle of its step of 1 / 1024 (megaSolids.ts stores it there): interpolated across a triangle it comes
// back a few bits off, and a hash of it would then flip from pixel to pixel wherever it is compared with a threshold
float cSeed() { return (floor(vFa.y * 1024.0) + 0.5) / 1024.0; }

vec3 gCAlbedo;
float gCRough;
float gCMetal;
vec3 gCEmit;

vec3 cAccent(float i) {
  if (i < 0.5) return ${glVec(ACCENTS[0])};
  if (i < 1.5) return ${glVec(ACCENTS[1])};
  if (i < 2.5) return ${glVec(ACCENTS[2])};
  if (i < 3.5) return ${glVec(ACCENTS[3])};
  return ${glVec(ACCENTS[4])};
}

// a window's light: tungsten, cold white, and now and then a room in teal, pink or violet. warm: 0 an office tower .. 1 flats
vec3 cWinLight(float h, float warm) {
  float w = mix(0.1, 0.62, warm);
  if (h < w) return vec3(1.0, 0.6, 0.28);
  if (h < 0.935) return vec3(0.62, 0.78, 1.0);
  if (h < 0.965) return vec3(0.08, 1.0, 0.7);
  if (h < 0.985) return vec3(1.4, 0.12, 0.34);
  return vec3(0.7, 0.24, 1.5);
}

// coverage of a line of half-width hw by a pixel fw wide, d from the line's centre: thinner than a pixel it keeps its energy
float cLine(float d, float hw, float fw) {
  float h = max(hw, 0.75 * fw);
  return clamp((h - abs(d)) / max(1.5 * fw, 1e-4) + 0.5, 0.0, 1.0) * (hw / h);
}

// A strip of light along a wall's edge, from a to b metres in from it (m: the distance from the edge). Far away it is the
// edge's own pixel, whichever row that falls in: a strip placed by its centre is drawn in one row and missed in the next.
float cEdge(float m, float a, float b, float fw) {
  float far = clamp((b - m) / max(2.0 * fw, 1e-4) + 1.0, 0.0, 1.0) * min(1.0, pow(0.6 / max(fw, 1e-4), 0.6));
  float near = clamp((b - m) / max(fw, 1e-4) + 0.5, 0.0, 1.0) * clamp((m - a) / max(fw, 1e-4) + 0.5, 0.0, 1.0);
  return mix(near, far, smoothstep(0.5, 1.0, fw / (b - a)));
}

// What shows through a lit pane: the ceiling's lamps, the room dimmer below them, blinds down to a height of their own, and dark
// shapes against the light (desks, shelves, people). p: 0..1 across the pane and up it; nz: noise at the scale of a room; fw: a
// pixel in pane heights.
float cRoom(vec2 p, vec2 id, vec4 nz, float fw) {
  float h1 = cHash12(id + 3.1);
  float h2 = cHash12(id + 7.7);
  float g = mix(0.14, 0.62, smoothstep(0.0, 0.9, p.y)) * (0.5 + nz.r);
  g += 0.8 * (1.0 - smoothstep(0.025, 0.06 + fw, abs(p.y - 0.9))) * step(0.3, h1) * step(0.3, fract(p.x * 2.0 + h1));
  float blind = step(1.0 - max(0.0, h2 - 0.4) * 1.5, p.y);
  g *= mix(1.0, 0.4 + 0.1 * step(0.5, fract(p.y * 22.0)), blind);
  float sil = 1.0 - smoothstep(0.0, 0.14, p.y - 0.14 - 0.3 * nz.g);
  g *= mix(1.0, 0.45, sil * (1.0 - blind));
  g *= 0.6 + 0.55 * h1;
  return mix(g, 0.36, smoothstep(0.08, 0.3, fw));
}

// A xeno-glyph: strokes between the nodes of a 3 x 4 lattice, switched on by the glyph's hash, and a diagonal in a few of its cells.
// q: 0..1 across the glyph's box (2 : 3, so the lattice is square); aa: a pixel in lattice units.
float cGlyph(vec2 q, vec2 id, float aa) {
  vec2 g = q * vec2(2.0, 3.0);
  float row = clamp(floor(g.y + 0.5), 0.0, 3.0);
  float col = clamp(floor(g.x), 0.0, 1.0);
  float dh = length(vec2(max(max(col - g.x, g.x - col - 1.0), 0.0), g.y - row));
  float onH = step(0.44, cHash12(id + vec2(row * 3.17 + col * 17.3, 1.7)));
  float colv = clamp(floor(g.x + 0.5), 0.0, 2.0);
  float rowv = clamp(floor(g.y), 0.0, 2.0);
  float dv = length(vec2(g.x - colv, max(max(rowv - g.y, g.y - rowv - 1.0), 0.0)));
  float onV = step(0.44, cHash12(id + vec2(colv * 5.71 + rowv * 13.9, 4.1)));
  vec2 c = clamp(floor(g), vec2(0.0), vec2(1.0, 2.0));
  vec2 f = g - c;
  float hd = cHash12(id + c * 7.7 + 9.3);
  float dd = (hd < 0.5 ? abs(f.x - f.y) : abs(f.x + f.y - 1.0)) * 0.7071;
  dd = max(dd, max(max(-f.x, f.x - 1.0), max(-f.y, f.y - 1.0)));
  float onD = step(fract(hd * 7.0), 0.22);
  float d = min(min(mix(9.0, dh, onH), mix(9.0, dv, onV)), mix(9.0, dd, onD));
  return 1.0 - smoothstep(0.13 - aa, 0.13 + aa, d);
}

// Lines of glyphs gs high from p = (0, 0) rightward and upward; cols: the glyphs a full line holds. fw: a pixel in metres.
float cText(vec2 p, float gs, float cols, float seed, float fw) {
  vec2 cell = vec2(gs * 0.92, gs * 1.5);
  vec2 id = floor(p / cell);
  vec2 q = (p - id * cell - vec2(gs * 0.13, gs * 0.25)) / vec2(gs * 0.667, gs);
  // (a glyph in seven is a space)
  float ink = cGlyph(q, id + seed * 97.0, 3.0 * fw / gs) * step(0.14, cHash12(id + seed * 97.0 + 31.7));
  // lines of different lengths, ragged on the right
  ink *= step(0.0, id.x) * step(id.x + 0.5, max(2.0, cols * mix(0.45, 1.0, cHash12(vec2(id.y, seed * 53.0)))));
  // glyphs under some five pixels settle on their mean
  return mix(ink, 0.24, smoothstep(0.12, 0.3, fw / gs));
}

// ── signs ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
void cSign(float fw) {
  float W = max(vFb.x, 0.2);
  float H = max(vFa.z, 0.2);
  float rS = cSeed();
  float mode = vFb.z;
  float gs = max(vFa.w, 0.2);
  vec3 col = vColor.rgb;
  vec2 p = vFuv;
  float edge = min(min(p.x, W - p.x), min(p.y, H - p.y));
  float mrg = min(0.1 * min(W, H), 0.5);
  float inside = smoothstep(mrg * 0.45, mrg * 0.55 + fw, edge);
  float t = uTime;
  float ink = 0.0;
  float back = 0.05;
  vec3 light = col;
  if (mode < 1.5) {
    // lines of writing, top line first; mode 1 scrolls them up
    float scroll = mode > 0.5 ? t * gs * 0.3 : 0.0;
    ink = cText(vec2(p.x - mrg, p.y - (H - mrg) - scroll), gs, floor((W - 2.0 * mrg) / (gs * 0.92)), rS, fw);
  } else if (mode < 2.5) {
    // one column written downward
    float ch = gs * 1.22;
    float n = floor((H - p.y - mrg) / ch);
    vec2 q = vec2((p.x - 0.5 * (W - gs * 0.667)) / (gs * 0.667), 1.0 - ((H - p.y - mrg) - n * ch - gs * 0.11) / gs);
    ink = cGlyph(q, vec2(n, 3.0) + rS * 97.0, 3.0 * fw / gs) * step(0.0, n) * step(p.y, H - mrg) * step(mrg + gs * 0.2, p.y);
    ink = mix(ink, 0.24, smoothstep(0.12, 0.3, fw / gs));
  } else if (mode < 3.5) {
    // a screen: a slow wash of two lights, a mark that changes every few seconds
    float tt = t * 0.25 + rS * 40.0;
    float wash = 0.5 + 0.5 * sin(p.y / H * 2.6 + p.x / W * 1.9 - tt * 0.7);
    light = mix(col, cAccent(mod(floor(rS * 50.0) + 2.0, 5.0)), wash);
    back = 0.1 + 0.12 * wash;
    float ms = min(H * 0.6, W * 0.8);
    vec2 q = (p - vec2(0.5 * W - 0.333 * ms, H * 0.3)) / vec2(ms * 0.667, ms);
    ink = cGlyph(q, vec2(floor(tt * 0.8), 5.0) + rS * 97.0, 3.0 * fw / ms);
    ink = mix(ink, 0.2, smoothstep(0.12, 0.3, fw / ms));
    // a ticker along the bottom
    float ls = max(H * 0.09, 0.3);
    ink = max(ink, 0.8 * cText(vec2(p.x + t * ls * 1.4, p.y - H * 0.07), ls, 1e4, rS + 0.6, fw) * step(H * 0.07, p.y) * step(p.y, H * 0.07 + ls * 1.5));
    // the diodes, close up
    vec2 dq = fract(p / 0.16) - 0.5;
    float dots = 1.0 - smoothstep(0.3, 0.42, max(abs(dq.x), abs(dq.y)));
    float dl = smoothstep(0.2, 0.6, fw / 0.16);
    back *= mix(dots, 0.6, dl);
    ink *= mix(dots, 0.6, dl) * 1.6;
  } else {
    // a mark: one big glyph over a line of small ones
    float ms = min(H * 0.56, W * 0.8);
    vec2 q = (p - vec2(0.5 * W - 0.333 * ms, H * 0.36)) / vec2(ms * 0.667, ms);
    float big = cGlyph(q, vec2(7.0, 9.0) + rS * 97.0, 3.0 * fw / ms);
    float bq = max(abs(q.x - 0.5) - 0.62, abs(q.y - 0.5) - 0.56);
    big = mix(big, 0.3 * step(bq, 0.0), smoothstep(0.12, 0.3, fw / ms));
    float ls = max(H * 0.11, 0.25);
    float cols = floor((W - 2.0 * mrg) / (ls * 0.92));
    float line = cText(vec2(p.x - 0.5 * (W - cols * ls * 0.92), p.y - H * 0.1), ls, cols, rS + 0.3, fw) * step(H * 0.1, p.y) * step(p.y, H * 0.1 + ls * 1.5);
    ink = max(big, line * 0.8);
  }
  // some tubes are on their way out and stutter for a second or two; some panels are swept by a slow line
  float fl = cHash11(rS * 77.7);
  float k = 1.0;
  if (fl < 0.16) k -= 0.7 * step(0.78, cHash11(floor(t * 0.6) + rS * 31.0)) * step(0.5, cHash11(floor(t * 13.0) + rS * 13.0));
  else if (fl > 0.72) k += 0.7 * (1.0 - smoothstep(0.0, 0.05, abs(fract(p.y / max(H, 8.0) - t * 0.1 - rS) - 0.5)));
  float box = step(0.5, vFb.w);
  float e = mix(ink * 2.3 + back, (1.0 - ink) * 0.6 + 0.04, box);
  gCEmit = light * e * inside * k * uSign;
  // by day: a dark panel with its glyphs painted on it, or a pale acrylic box with dark ones
  vec3 dark = mix(vec3(0.028, 0.03, 0.034), col * 0.16 + 0.07, ink * 0.85);
  vec3 pale = mix(vec3(0.5, 0.52, 0.54) + col * 0.08, vec3(0.05), ink * 0.9);
  gCAlbedo = mix(vec3(0.03, 0.032, 0.036), mix(dark, pale, box), inside);
  gCRough = 0.32;
  gCMetal = 0.0;
}

// ── the podium: shop fronts under a fascia of signs, and a band of light where the tower begins ─────────────────────────────────────
void cPodium(float fwu, float fwv, vec4 n2, vec4 n4, vec3 accent) {
  float u = vFuv.x;
  float v = vFuv.y;
  float rS = cSeed();
  float W = max(vFb.x, 2.0);
  float gH = vFa.w;
  float Wb = W / max(1.0, floor(W / mix(5.0, 8.5, cHash11(rS * 47.1)) + 0.5));
  float ib = floor(u / Wb);
  float x = (fract(u / Wb) - 0.5) * Wb;
  float hb = cHash12(vec2(ib, rS * 91.0));
  float sH = min(4.4, gH - 1.7);
  float a = Wb * 0.5 - 0.42;
  float fw = max(fwu, fwv);
  vec3 conc = vec3(0.06, 0.062, 0.068) * (0.9 + 0.2 * n2.r);
  gCAlbedo = conc;
  gCRough = 0.85;
  gCMetal = 0.0;
  gCEmit = vec3(0.0);
  float sh = cHash12(vec2(ib, rS * 57.0));
  vec3 lc = sh < 0.34 ? vec3(0.62, 0.78, 1.0) : (sh < 0.5 ? vec3(1.0, 0.6, 0.28) : cAccent(floor((sh - 0.5) / 0.167)));
  float open = step(0.16, hb);
  float inBay = 1.0 - smoothstep(a - fw, a + fw, abs(x));
  if (v < 0.4) {
    gCAlbedo = conc * 0.7;
  } else if (v < sH) {
    // the shop: glazing with the light of the room behind it, or a shutter
    float xm = mod(x + a, 1.7);
    float mul = max(cLine(min(xm, 1.7 - xm), 0.035, fwu), cLine(v - (sH - 0.9), 0.035, fwv));
    float slat = 0.75 + 0.25 * step(0.5, fract(v * 8.0));
    vec3 shut = vec3(0.075, 0.078, 0.082) * mix(slat, 0.87, smoothstep(0.02, 0.06, fwv));
    vec3 glassC = mix(vec3(0.018, 0.022, 0.028), vec3(0.05), mul);
    gCAlbedo = mix(conc, mix(shut, glassC, open), inBay);
    gCRough = mix(0.85, mix(0.5, 0.07, open), inBay);
    gCMetal = mix(0.0, mix(0.6, 0.0, open), inBay);
    // the room behind the glass: lamps on the ceiling, the light uneven and dimmer toward the floor, shelves along the back wall,
    // a counter and whatever stands in the window dark against it
    float lodS = smoothstep(0.1, 0.4, fw);
    float inner = (0.16 + 0.84 * smoothstep(0.4, sH, v)) * mix(0.45 + 1.1 * n4.r, 1.0, lodS);
    inner *= 1.0 - 0.22 * step(0.6, fract(v / 0.52)) * (1.0 - lodS);
    inner += 0.9 * (1.0 - smoothstep(0.04, 0.09 + fwv, abs(v - (sH - 0.42)))) * step(0.3, fract((x + a) / 1.1)) * (1.0 - lodS);
    float shape = 1.0 - smoothstep(0.0, 0.25, v - 0.95 - 0.4 * n4.g);
    inner *= mix(1.0, 0.5, shape * (1.0 - lodS));
    vec3 poster = mix(vec3(1.0), 0.6 + 0.4 * cAccent(floor(n4.b * 4.99)), smoothstep(0.55, 0.7, n4.a) * 0.6);
    // (a wall with a lit door instead of a shop window, in a bay out of five)
    float door = step(hb, 0.36) * step(0.16, hb);
    float inDoor = (1.0 - smoothstep(0.85 - fw, 0.85 + fw, abs(x - a * 0.35))) * step(v, 2.7);
    float glassK = mix(1.0, inDoor, door);
    gCAlbedo = mix(gCAlbedo, conc * 0.8, inBay * open * (1.0 - glassK));
    gCRough = mix(gCRough, 0.85, inBay * open * (1.0 - glassK));
    gCEmit = mix(lc, vec3(0.8, 0.86, 1.0), 0.55) * poster * (0.13 + 0.25 * cHash12(vec2(ib, rS * 71.0))) * inner * (1.0 - mul) * inBay * open * glassK * uSign;
  } else if (v < sH + 1.25) {
    // the fascia: the shop's name in light
    float gs = 0.66;
    float cols = floor((2.0 * a - 0.5) / (gs * 0.92));
    float ink = cText(vec2(x + a - 0.25, v - sH - 0.1), gs, cols, rS + ib * 0.013, fw) * step(sH + 0.1, v) * step(v, sH + 0.1 + gs * 1.5);
    ink *= inBay * open * step(cHash12(vec2(ib, rS * 33.0)), 0.82);
    vec3 sc = cAccent(floor(cHash12(vec2(ib, rS * 13.0)) * 5.0));
    gCAlbedo = mix(vec3(0.03, 0.032, 0.036), sc * 0.14 + 0.06, ink);
    gCRough = 0.4;
    gCEmit = sc * ink * 2.2 * uSign;
  } else {
    // panels up to the band of light under the tower
    float pj = cLine(min(fract(u / 2.4), 1.0 - fract(u / 2.4)) * 2.4, 0.02, fwu);
    gCAlbedo = vec3(0.05, 0.052, 0.058) * (0.92 + 0.16 * n2.g) * (1.0 - 0.4 * pj);
    gCRough = 0.6;
    gCMetal = 0.4;
    gCEmit = accent * cLine(v - (gH - 0.4), 0.1, fwv) * 1.5 * uSign;
  }
  // far away the shops are a dim line of mixed light at the foot of the tower
  float lodP = smoothstep(0.25, 0.7, fwu / 1.7);
  gCEmit = mix(gCEmit, vec3(0.6, 0.62, 0.7) * 0.16 * step(0.4, v) * step(v, sH) * uSign, lodP);
}

// ── the lines of light a wall carries: a band under its top, strips up its edges, a band every few floors, lines up its modules ─────
vec3 cWallLights(float u, float v, float W, float Wp, float Hf, float fl, float fy, vec3 accent, float fwu, float fwv) {
  float flags = floor(vFb.w + 0.5);
  float rS = cSeed();
  vec3 e = vec3(0.0);
  if (mod(flags, 2.0) > 0.5) e += accent * cEdge(vFa.z - v, 0.6, 1.4, fwv) * 1.5;
  if (mod(floor(flags / 2.0), 2.0) > 0.5) e += accent * cEdge(min(u, W - u), 0.18, 0.44, fwu) * 1.25;
  if (mod(floor(flags / 4.0), 2.0) > 0.5) {
    float k = 4.0 + floor(cHash11(rS * 67.1) * 9.0);
    e += accent * step(mod(fl, k), 0.5) * cLine(fy - 0.3, 0.1, fwv) * 1.25;
  }
  if (mod(floor(flags / 8.0), 2.0) > 0.5) {
    float pw = Wp * (2.0 + floor(cHash11(rS * 71.9) * 3.0));
    float mu = mod(u + 0.5 * pw, pw);
    e += accent * cLine(min(mu, pw - mu), 0.08, fwu) * 0.9;
  }
  return e * uSign;
}

// ── walls: a glass curtain wall or brutalist concrete over the podium ───────────────────────────────────────────────────────────────
void cWall(bool concrete, float fwu, float fwv) {
  float u = vFuv.x;
  float v = vFuv.y;
  float rS = cSeed();
  float W = max(vFb.x, 2.0);
  float gH = vFa.w;
  vec3 tint = vColor.rgb;
  vec3 accent = cAccent(floor(vFb.z + 0.5));
  float litFrac = vFb.y * uNight;
  float warm = cHash11(rS * 61.0);
  vec4 n1 = texture2D(uNoise, vec2(u * 0.013 + rS * 7.7, v * 0.013 + rS * 3.1));
  vec4 n2 = texture2D(uNoise, vec2(u * 0.11 + rS * 1.3, v * 0.11 - rS * 4.7));
  vec4 n3 = texture2D(uNoise, vec2(u * 0.33 + rS, v * 0.011));
  vec4 n4 = texture2D(uNoise, vec2(u * 0.43 - rS * 2.9, v * 0.43 + rS * 5.3));
  gCEmit = vec3(0.0);
  if (v < gH) {
    cPodium(fwu, fwv, n2, n4, accent);
  } else if (v < 0.0) {
    // the foundation where the ground falls away from the datum
    gCAlbedo = vec3(0.055, 0.057, 0.062) * (0.9 + 0.2 * n2.r);
    gCRough = 0.9;
    gCMetal = 0.0;
  } else if (!concrete) {
    float nb = max(1.0, floor(W / mix(1.5, 3.3, cHash11(rS * 3.1)) + 0.5));
    float Wp = W / nb;
    float Hf = mix(3.6, 4.4, cHash11(rS * 5.7));
    float sp = mix(1.0, 2.0, cHash11(rS * 7.3));
    float variant = cHash11(rS * 11.7);
    float ix = floor(u / Wp);
    float fl = floor(v / Hf);
    float fx = u - ix * Wp;
    float fy = v - fl * Hf;
    float lod = smoothstep(0.18, 0.5, max(fwu / Wp, fwv / Hf));
    float mull = cLine(min(fx, Wp - fx), 0.06, fwu);
    float spand = 1.0 - smoothstep(sp - fwv, sp + fwv, fy);
    if (variant < 0.3) {
      // bands: the floors read as stripes
      mull *= 0.3;
    } else if (variant < 0.55) {
      // fins: a pier every third module from top to bottom
      float pm = mod(u, Wp * 3.0);
      mull = max(mull, cLine(min(pm, Wp * 3.0 - pm), 0.24, fwu));
      spand *= 0.55;
    }
    float solid = max(spand, mull);
    float pane = cHash12(vec2(ix, fl) + rS * 91.7);
    vec3 glass = tint * (0.8 + 0.4 * pane) * (0.88 + 0.24 * n1.r);
    vec3 frame = vec3(0.04, 0.043, 0.05) * (0.8 + 0.4 * n2.r);
    gCAlbedo = mix(glass, frame, solid);
    gCMetal = mix(0.8, 0.5, solid);
    gCRough = mix(0.12, 0.48, solid);
    // lit rooms: a run of modules is one room; some floors work late, most are dark
    float flH = cHash12(vec2(fl, rS * 57.3));
    float bias = mix(0.15 + 2.6 * flH * flH, 4.0, step(flH, 0.04));
    float room = floor(ix / (1.0 + floor(cHash12(vec2(fl, rS * 3.3)) * 3.0)));
    vec2 rid = vec2(room, fl) + rS * 17.3;
    float lit = step(cHash12(rid), litFrac * bias);
    float rb = cHash12(rid + 3.7);
    vec3 lc = cWinLight(cHash12(rid + 29.1), warm) * mix(0.2, 0.8, rb * rb);
    float inner = cRoom(vec2(fx / Wp, (fy - sp) / (Hf - sp)), vec2(ix, fl) + rS * 41.3, n4, fwv / (Hf - sp));
    vec3 emit = lc * inner * lit * (1.0 - solid);
    vec3 meanLc = mix(vec3(0.62, 0.78, 1.0), vec3(1.0, 0.6, 0.28), mix(0.1, 0.62, warm)) * 0.5;
    vec3 meanEmit = meanLc * min(1.0, litFrac * 1.0) * (1.0 - sp / Hf) * 0.36;
    gCEmit = mix(emit, meanEmit, lod);
    gCAlbedo = mix(gCAlbedo, mix(tint, frame, sp / Hf), lod);
    gCMetal = mix(gCMetal, 0.72, lod);
    gCRough = mix(gCRough, 0.22, lod);
    gCEmit += cWallLights(u, v, W, Wp, Hf, fl, fy, accent, fwu, fwv);
  } else {
    float nb = max(1.0, floor(W / mix(2.8, 4.6, cHash11(rS * 3.1)) + 0.5));
    float Wp = W / nb;
    float Hf = mix(3.3, 3.9, cHash11(rS * 5.7));
    float variant = cHash11(rS * 11.7);
    float ix = floor(u / Wp);
    float fl = floor(v / Hf);
    float fx = u - ix * Wp;
    float fy = v - fl * Hf;
    float lod = smoothstep(0.18, 0.5, max(fwu / Wp, fwv / Hf));
    // cast concrete: clouds of tone, the streaks the rain leaves, the joints of the formwork
    vec3 conc = tint * (0.76 + 0.36 * n1.r + 0.16 * (n2.g - 0.5));
    conc *= 1.0 - 0.3 * smoothstep(0.45, 0.8, n3.b) * (0.4 + 0.6 * n1.g);
    float joint = max(cLine(min(fx, Wp - fx), 0.025, fwu), cLine(min(fy, Hf - fy), 0.025, fwv));
    conc *= 1.0 - 0.4 * joint * (1.0 - lod);
    // windows: ribbons between piers, punched squares, or tall slots; a blind bay (a core) now and then
    float core = step(cHash12(vec2(floor(ix / 2.0), rS * 43.0)), 0.14);
    float d;
    float share;
    if (variant < 0.45) {
      d = max(abs(fy - Hf * 0.56) - Hf * 0.21, 0.32 - min(fx, Wp - fx));
      share = 0.42 * (1.0 - 0.64 / Wp);
    } else if (variant < 0.8) {
      d = max(abs(fx - Wp * 0.5) - Wp * 0.29, abs(fy - Hf * 0.55) - Hf * 0.24);
      share = 0.28;
    } else {
      d = max(abs(fx - Wp * 0.5) - Wp * 0.13, abs(fy - Hf * 0.5) - Hf * 0.38);
      share = 0.2;
    }
    float aa = max(max(fwu, fwv), 0.01);
    float win = (1.0 - smoothstep(-aa, aa, d)) * (1.0 - core);
    // (the reveal: the wall is half a metre thick, the top of the opening is in its own shade)
    float reveal = (1.0 - smoothstep(0.0, 0.14, -d)) * win;
    vec2 rid = vec2(floor(ix / (1.0 + floor(cHash12(vec2(fl, rS * 3.3)) * 2.0))), fl) + rS * 17.3;
    float flH = cHash12(vec2(fl, rS * 57.3));
    float lit = step(cHash12(rid), litFrac * (0.3 + 1.8 * flH));
    float rb = cHash12(rid + 3.7);
    vec3 lc = cWinLight(cHash12(rid + 29.1), 0.4 + 0.6 * warm) * mix(0.2, 0.8, rb * rb);
    // (the pane: the module's opening, whatever its shape)
    vec2 pq = variant < 0.45 ? vec2(fx / Wp, (fy - Hf * 0.35) / (Hf * 0.42)) : (variant < 0.8 ? vec2((fx - Wp * 0.21) / (Wp * 0.58), (fy - Hf * 0.31) / (Hf * 0.48)) : vec2((fx - Wp * 0.37) / (Wp * 0.26), (fy - Hf * 0.12) / (Hf * 0.76)));
    float inner = cRoom(clamp(pq, 0.0, 1.0), vec2(ix, fl) + rS * 41.3, n4, fwv / (Hf * 0.45));
    gCAlbedo = mix(conc, mix(vec3(0.02, 0.024, 0.03), vec3(0.012), reveal), win);
    gCRough = mix(0.9, 0.12, win * (1.0 - reveal));
    gCMetal = mix(0.0, 0.5, win * (1.0 - reveal));
    vec3 emit = lc * lit * win * (1.0 - 0.6 * reveal) * inner;
    vec3 meanLc = mix(vec3(0.62, 0.78, 1.0), vec3(1.0, 0.6, 0.28), mix(0.3, 0.62, warm)) * 0.5;
    vec3 meanEmit = meanLc * min(1.0, litFrac * 1.2) * share * 0.86 * 0.36;
    gCEmit = mix(emit, meanEmit, lod);
    gCAlbedo = mix(gCAlbedo, mix(tint * 0.9, vec3(0.02), share), lod);
    gCRough = mix(gCRough, 0.8, lod);
    gCMetal = mix(gCMetal, 0.1, lod);
    gCEmit += cWallLights(u, v, W, Wp, Hf, fl, fy, accent, fwu, fwv);
  }
  // the street's own light climbs the first floors: teal here, pink there
  float glow = exp(-max(v, 0.0) / 13.0) * step(0.0, v);
  gCEmit += mix(vec3(0.05, 0.5, 0.42), vec3(0.6, 0.08, 0.25), n1.g) * glow * 0.035 * uSign * (0.4 + gCAlbedo.g * 6.0);
}

void cRoof() {
  vec4 n1 = texture2D(uNoise, vFw.xz * 0.019);
  vec4 n2 = texture2D(uNoise, vFw.xz * 0.23);
  vec3 t = vec3(0.04, 0.041, 0.045) * (0.65 + 0.7 * n1.r) * (0.85 + 0.3 * n2.g);
  // the seams of the membrane, a parapet round the edge
  float W = vFb.x;
  float D = vFa.z;
  float fw = max(fwidth(vFuv.x), fwidth(vFuv.y));
  float seam = cLine(min(fract(vFuv.x / 5.0), 1.0 - fract(vFuv.x / 5.0)) * 5.0, 0.03, fw);
  t *= 1.0 - 0.3 * seam;
  if (W > 0.5) {
    float edge = min(min(vFuv.x, W - vFuv.x), min(vFuv.y, D - vFuv.y));
    t = mix(vec3(0.085, 0.087, 0.09) * (0.8 + 0.4 * n2.r), t, smoothstep(0.55, 0.6 + fw, edge));
  }
  gCAlbedo = t;
  gCRough = 0.9;
  gCMetal = 0.0;
  gCEmit = vec3(0.0);
}
`;

const FRAG_MAP = /* glsl */ `
  gCAlbedo = vColor.rgb;
  gCRough = 0.9;
  gCMetal = 0.0;
  gCEmit = vec3(0.0);
  {
    float cKind = vFa.x;
    float cfu = fwidth(vFuv.x);
    float cfv = fwidth(vFuv.y);
    if (cKind < 0.5) cWall(false, cfu, cfv);
    else if (cKind < 1.5) cWall(true, cfu, cfv);
    else if (cKind < 2.5) cRoof();
    else if (cKind < 3.5) {
      // plant, frames, masts: painted metal
      gCAlbedo = vColor.rgb * (0.8 + 0.4 * texture2D(uNoise, vFw.xz * 0.21 + vFw.y * 0.17).r);
      gCRough = 0.62;
      gCMetal = vFb.y;
    } else if (cKind < 4.5) cSign(max(cfu, cfv));
    else {
      // a strip or a lamp: its light, steady, blinking (an aircraft warning light: on for a third of its 2.4 s) or breathing
      float k = 1.0;
      if (vFb.z > 1.5) k = 0.62 + 0.38 * sin(uTime * 0.9 + vFa.y * 6.283);
      else if (vFb.z > 0.5) {
        float f = fract(uTime / 2.4 + vFa.y);
        k = smoothstep(0.0, 0.06, f) * (1.0 - smoothstep(0.3, 0.4, f));
      }
      gCEmit = vColor.rgb * vFb.y * k * uSign;
      gCAlbedo = mix(vec3(0.42), vColor.rgb, 0.3) * 0.5;
      gCRough = 0.4;
    }
  }
  gCAlbedo *= mix(1.0, 0.78, uWet);
  gCRough = mix(gCRough, gCRough * 0.55 + 0.03, uWet);
  diffuseColor.rgb = gCAlbedo;
`;

export interface CyberMaterial {
  mat: THREE.MeshStandardMaterial;
  /** The share of the night the signs and the strips are at (0 by day, 1 from dusk on). */
  sign: { value: number };
}

/** The megacity's material: one shader program for every tower, sign and strip; its lights follow the environment, its clock the frame. */
export function makeCyberMaterial(ctx: Ctx): CyberMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, envMapIntensity: 1 });
  mat.name = 'cyberFacade';
  const uNight = { value: 0 };
  const uSign = { value: 0 };
  const uTime = { value: 0 };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNoise = { value: ctx.tex.noise };
    shader.uniforms.uNight = uNight;
    shader.uniforms.uSign = uSign;
    shader.uniforms.uTime = uTime;
    shader.uniforms.uWet = ctx.wet.uWet;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_DECL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFa = aFa; vFb = aFb; vFuv = uv; vFw = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    // (the helpers read the vertex colour, which is declared after <common>)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <color_pars_fragment>', '#include <color_pars_fragment>\n' + FRAG_DECL)
      .replace('#include <color_fragment>', '')
      .replace('#include <map_fragment>', FRAG_MAP)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gCRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = gCMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += gCEmit * 2.2;');
  };
  mat.customProgramCacheKey = () => 'cyber-facade-v1';
  mat.userData.wetShader = true;
  ctx.envListeners.push((env) => {
    // the windows come on through the dusk as the town's do; the signs and the strips are switched on, earlier and all at once
    uNight.value = Math.min(1, Math.max(0, (env.darkness - 0.15) / 0.7));
    uSign.value = Math.min(1, Math.max(0, (env.darkness - 0.12) / 0.3));
  });
  // (the clock wraps every hour, well inside what a float keeps of a second's fraction)
  ctx.updaters.push((_dt, _camera, time) => {
    uTime.value = time % 3600;
  });
  return { mat, sign: uSign };
}

/**
 * The aircraft warning lights on the masts and the crowns: points, so that a lamp a kilometre away is still a dot of red instead of
 * a sub-pixel box. `aPhase` is each tower's own beat; a point is never drawn smaller than four pixels (a core and its glow).
 */
export function makeBeaconMaterial(ctx: Ctx, sign: { value: number }): THREE.PointsMaterial {
  const mat = new THREE.PointsMaterial({ color: new THREE.Color(2.2, 0.07, 0.04), size: 7, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true });
  mat.name = 'cyberBeacon';
  const uTime = { value: 0 };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uSign = sign;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPhase;\nuniform float uTime;\nuniform float uSign;\nvarying float vBeat;')
      .replace(
        'gl_PointSize = size;',
        /* glsl */ `gl_PointSize = size;
  {
    float f = fract(uTime / 2.4 + aPhase);
    // (a phase of 2 or more is a steady lamp)
    vBeat = uSign * (aPhase > 1.5 ? 0.55 : smoothstep(0.0, 0.06, f) * (1.0 - smoothstep(0.3, 0.4, f)));
  }`,
      )
      .replace('#include <fog_vertex>', 'gl_PointSize = clamp(gl_PointSize, 4.0, 30.0);\n#include <fog_vertex>');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vBeat;')
      .replace('#include <map_particle_fragment>', '{ float r = length(gl_PointCoord - 0.5) * 2.0; float g = 1.0 - smoothstep(0.0, 1.0, r); diffuseColor.a *= (0.25 * g + 0.75 * g * g * g * g) * vBeat; }');
  };
  mat.customProgramCacheKey = () => 'cyber-beacon-v1';
  ctx.updaters.push((_dt, _camera, time) => {
    uTime.value = time % 3600;
  });
  return mat;
}
