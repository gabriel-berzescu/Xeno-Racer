/**
 * GLSL for crash damage on the car body (see src/core/damage.ts for the model that fills the uniforms).
 *
 * The code is always in the program and driven by uniforms, never by defines: a car that is hit for the first time
 * mid-race must not trigger a shader compile. A pristine car costs one uniform test per vertex and per fragment.
 *
 *   dents   a fixed table of crumpled patches (centre, radius, push direction, depth, slide axis, stretch). The vertex
 *           shader pushes the sheet in and wrinkles it; the fragment shader adds the creases the mesh is too coarse for.
 *   marks   a fixed table of scraped-paint capsules: streaks along the slide, rubber smudges, transferred paint.
 *   lamps   output and crack state of the four lamp lenses.
 *   cracks  a fixed table of stars of cracks on the glass (the glass pass only).
 *
 * Everything is a function of the material position (`vObjPos`, the undeformed mesh), so patterns move with the sheet.
 */
import { MAX_CRACKS, MAX_DENTS, MAX_MARKS } from '../core/damage';

/** Noise, shared by both stages. */
const NOISE = /* glsl */ `
float dmgHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float dmgNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(dmgHash(i), dmgHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(dmgHash(i + vec3(0.0, 1.0, 0.0)), dmgHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(dmgHash(i + vec3(0.0, 0.0, 1.0)), dmgHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(dmgHash(i + vec3(0.0, 1.0, 1.0)), dmgHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}
float dmgRidge(float n) {
  return 1.0 - abs(2.0 * n - 1.0);
}
`;

/** Dent table and the frame of a point in a dent. */
const DENT_COMMON = /* glsl */ `
#define DMG_DENTS ${MAX_DENTS}
uniform vec4 uDent[ DMG_DENTS * 3 ];   // per dent: (centre, radius) (push direction, depth) (slide axis, stretch)
uniform float uDentN;
${NOISE}
// How far dent i pushes the sheet in at material point p (metres; 0 outside). The obstacle is a plane: all the sheet within
// the depth of the crush is shoved back towards it, most in the middle of the contact and fading out to its radius.
// Also returned: the depth s of p behind the contact face, its plane coordinates u (along the slide, across: vertical for a
// wall or a bumper, squeezed so the crush reaches the hood), the normalised radius rr and a seed for this dent.
float dentPush(vec3 p, vec4 A, vec4 B, vec4 C, out float s, out vec2 u, out float rr, out float seed) {
  vec3 q = p - A.xyz;
  s = dot(q, B.xyz);
  vec3 lat = q - B.xyz * s;
  u = vec2(dot(lat, C.xyz) / C.w, dot(lat, cross(B.xyz, C.xyz)) * 0.65);
  rr = length(u) / A.w;
  seed = 0.0;
  // most of the car is nowhere near the dent: leave before the noise
  if (rr >= 1.0 || s >= B.w * 1.4) return 0.0;
  seed = dmgHash(A.xyz * 7.13);
  float wr = 1.0 - smoothstep(0.62, 1.0, rr);
  // the crushed depth varies a little over the contact, as no wall and no bumper is dead flat
  float depth = B.w * (1.0 + 0.4 * (dmgNoise(p * 4.0 + seed * 9.0) - 0.5) + 0.12 * (dmgNoise(p * 9.0 + seed * 3.0) - 0.5));
  return 0.85 * max(depth - s, 0.0) * wr;
}
// dentPush without the wobble of the crush depth, for the fragment stage: there it only scales the fine creasing, and it runs
// per pixel, where the two noises are a large share of the cost of a damaged car.
float dentPushLite(vec3 p, vec4 A, vec4 B, vec4 C, out float s, out float seed) {
  vec3 q = p - A.xyz;
  s = dot(q, B.xyz);
  vec3 lat = q - B.xyz * s;
  float rr = length(vec2(dot(lat, C.xyz) / C.w, dot(lat, cross(B.xyz, C.xyz)) * 0.65)) / A.w;
  seed = 0.0;
  if (rr >= 1.0 || s >= B.w * 1.4) return 0.0;
  seed = dmgHash(A.xyz * 7.13);
  return 0.85 * max(B.w - s, 0.0) * (1.0 - smoothstep(0.62, 1.0, rr));
}
`;

export const DMG_VERT_PARS = /* glsl */ `
${DENT_COMMON}
uniform vec3 uCabinMin;                // the interior's box: the sheet is stopped at it, so panels never go through the cabin
uniform vec3 uCabinMax;
// How far the point p can travel along the unit direction d before it enters the cabin box (1e3 if it never does).
float cabinRoom(vec3 p, vec3 d) {
  vec3 dd = vec3(abs(d.x) < 1e-5 ? 1e-5 : d.x, abs(d.y) < 1e-5 ? 1e-5 : d.y, abs(d.z) < 1e-5 ? 1e-5 : d.z);
  vec3 t1 = (uCabinMin - p) / dd;
  vec3 t2 = (uCabinMax - p) / dd;
  vec3 tn = min(t1, t2);
  vec3 tf = max(t1, t2);
  float tNear = max(max(tn.x, tn.y), tn.z);
  float tFar = min(min(tf.x, tf.y), tf.z);
  if (tFar < max(tNear, 0.0)) return 1e3;
  return max(tNear, 0.0);
}
// How far one dent moves the point p of a surface with normal nrm: shoved in along the push, and, where the sheet runs
// along the push, shortened, so it buckles across it.
float dmgBump = 1.0;
vec3 dentDisp(vec3 p, vec3 nrm, vec4 A, vec4 B, vec4 C) {
  float s, rr, seed;
  vec2 u;
  float push = dentPush(p, A, B, C, s, u, rr, seed);
  vec3 d = B.xyz;
  // a crushed bonnet or boot buckles up into a tent behind the contact face (the push is along the car, the sheet faces up;
  // a hit on the flank does not lift the roof)
  float tent = 0.0;
  if (nrm.y > 0.5 && abs(d.z) > 0.55 && abs(d.y) < 0.5 && rr < 1.1 && s > -0.06) {
    float Lh = 0.3 + 2.4 * B.w;
    float t = clamp(s / Lh, 0.0, 1.0);
    tent = 0.62 * B.w * sin(3.14159 * pow(t, 0.8)) * (1.0 - smoothstep(0.35, 1.1, rr)) * dmgBump;
  }
  if (push <= 0.0) return vec3(0.0, tent, 0.0);
  push = min(push, max(cabinRoom(p, d) - 0.015, 0.0));
  float along = 1.0 - abs(dot(nrm, d));
  float lam = 0.13 + 0.06 * seed;
  float fold = 2.0 * dmgRidge(fract((s + push) / lam + seed + 1.5 * dmgNoise(p * 4.0 + seed * 5.0))) - 1.0;
  // creases in all directions: ridges of noise, so the sheet is faceted between them rather than lumpy
  float crinkle = 2.0 * dmgRidge(dmgNoise(p * 9.0 + seed * 7.0)) - 1.0;
  // shallow dents stay smooth; the folds and crinkles come with the crush
  float deep = smoothstep(0.03, 0.11, push);
  return d * push + nrm * (dmgBump * push * deep * (0.36 * along * fold + 0.1 * (0.4 + 0.6 * (1.0 - along)) * crinkle)) + vec3(0.0, tent, 0.0);
}
vec3 dmgDeform(vec3 p, vec3 nrm) {
  vec3 x = p;
  for (int i = 0; i < DMG_DENTS; i++) {
    if (float(i) >= uDentN) break;
    x += dentDisp(x, nrm, uDent[3 * i], uDent[3 * i + 1], uDent[3 * i + 2]);
  }
  return x;
}
// The deformed surface normal by finite differences along two tangents (x0 = the deformed point itself).
vec3 dmgNormalAt(vec3 p, vec3 n, vec3 x0) {
  vec3 a = abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(n, a));
  vec3 t2 = cross(n, t1);
  vec3 x1 = dmgDeform(p + t1 * 0.012, n);
  vec3 x2 = dmgDeform(p + t2 * 0.012, n);
  vec3 nn = cross(x1 - x0, x2 - x0);
  float l = length(nn);
  return l > 1e-12 ? nn * (sign(dot(nn, n)) / l) : n;
}
// Body panels and the splitter crumple; mirror glass, exhaust tips and lamp blocks do not.
float dmgPartWeight(float part) {
  float pr = floor(part + 0.5);
  return (pr < 0.5 || pr == 1.0 || pr == 5.0 || pr == 10.0) ? 1.0 : 0.0;
}
// Thin plates (the splitter) are pushed back but never billow: only the sculpted body gets folds and crinkles.
float dmgBumpWeight(float part) {
  return part < 0.5 ? 1.0 : 0.0;
}
`;

/** Right after beginnormal_vertex: the deformed point and normal. */
export const DMG_VERT_NORMAL = /* glsl */ `
#include <beginnormal_vertex>
vec3 dmgPos = position;
if (uDentN > 0.5) {
  float dmgW = dmgPartWeight(aZ3.y);
  if (dmgW > 0.5) {
    dmgBump = dmgBumpWeight(aZ3.y);
    dmgPos = dmgDeform(position, objectNormal);
    // most of the car is nowhere near a dent: its normal stays, without the two extra evaluations
    if (dmgPos != position) objectNormal = dmgNormalAt(position, objectNormal, dmgPos);
  }
}
`;

export const DMG_FRAG_PARS = /* glsl */ `
${DENT_COMMON}
#define DMG_MARKS ${MAX_MARKS}
uniform vec4 uMark[ DMG_MARKS * 3 ];   // per mark: (centre, half length) (axis, half width) (wear, kind, colour, seed)
uniform float uMarkN;
uniform vec4 uLampOut;                 // light output of headL, headR, tailL, tailR: 1 intact, 0 dark
uniform vec4 uLampCrk;                 // crack of the lens, 0..1
uniform vec4 uLampHit[ 4 ];            // where the lens was hit (xyz), seed
uniform float uDmgBase;                // what shows under the paint: 0 steel, 1 carbon
#define DMG_CRACKS ${MAX_CRACKS}
uniform vec4 uCrack[ DMG_CRACKS * 2 ]; // per crack of the glass: (centre, reach) (surface normal, seed)
uniform float uCrackN;
vec2 gShard = vec2(0.0);               // tilt of the glass shard under this pixel (a cracked window), for the normal

float dmgHash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 dmgHash22(vec2 p) {
  return vec2(dmgHash2(p), dmgHash2(p + 17.31));
}
// Value noise on a surface: half the lookups of the 3D one, which is plenty where the pattern lies in a plane.
float dmgNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(dmgHash2(i), dmgHash2(i + vec2(1.0, 0.0)), f.x), mix(dmgHash2(i + vec2(0.0, 1.0)), dmgHash2(i + vec2(1.0, 1.0)), f.x), f.y);
}

// Crumple relief of every dent at material point p (metres, as a bump height) on a sheet with normal nrm, the share of the
// sheet that is crushed (area, 0..1) and a mask of the sharpest creases where the paint cracks off.
float dentRelief(vec3 p, vec3 nrm, out float area, out float crease) {
  float h = 0.0;
  area = 0.0;
  crease = 0.0;
  for (int i = 0; i < DMG_DENTS; i++) {
    if (float(i) >= uDentN) break;
    vec4 A = uDent[3 * i];
    vec4 B = uDent[3 * i + 1];
    vec4 C = uDent[3 * i + 2];
    float s, seed;
    float push = dentPushLite(p, A, B, C, s, seed);
    if (push <= 0.0) continue;
    // the rim of a dent and the whole of a shallow one: the creasing and the cracked paint start deeper than this, so only the
    // darkening of the sheet is left, without the noise
    if (push <= 0.02) {
      area = max(area, smoothstep(0.01, 0.1, push));
      continue;
    }
    // shallow dents stay smooth: the fine creasing comes with the crush
    float amp = min(push, 0.16) / 0.16 * smoothstep(0.02, 0.1, push);
    // dent frame: d = push, t = slide, b = across
    vec3 pr = p - A.xyz;
    vec3 t = C.xyz;
    vec3 b = cross(B.xyz, t);
    float ct = dot(pr, t);
    float cb = dot(pr, b);
    float cd = s;
    // folds across the push: creases at constant depth, wobbling along the slide and with height
    float x1 = (s + push) / 0.06 + 2.2 * dmgNoise2(vec2(ct, cb) * 6.0 + cd * vec2(3.6, 4.8) + seed * 9.0);
    float pleat = dmgRidge(fract(x1));
    // crinkles: creases in all directions, stretched across the push
    float c1 = dmgRidge(dmgNoise2(vec2(ct, cb) * 14.0 + cd * vec2(14.4, 19.2) + seed * 19.0));
    float along = 1.0 - abs(dot(nrm, B.xyz));
    h += (along * (pleat - 0.5) * 0.9 + (c1 - 0.5) * 0.4) * 0.03 * amp;
    area = max(area, smoothstep(0.01, 0.1, push));
    // the paint cracks along the sharpest folds of a real crush, in hairlines
    crease = max(crease, smoothstep(0.92, 0.99, pleat) * along * smoothstep(0.07, 0.17, push));
  }
  return h;
}

// Voronoi edges in (angle, log radius) space round a point: a shattered lens, small shards at the hit growing outwards.
// scale sets how fast the rings grow with the distance (per metre); cid is the shard the point is in.
float crackEdge(vec2 d, float seed, float scale, out vec2 cid) {
  float r = length(d);
  float a = atan(d.y, d.x + 1e-6);
  const float N = 14.0;
  vec2 g = vec2(a * (N / 6.2831853), log2(r * scale + 1.0) * 2.7 + seed * 5.0);
  vec2 ig = floor(g);
  vec2 fg = fract(g);
  float m1 = 8.0;
  float m2 = 8.0;
  cid = ig;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      vec2 cell = vec2(mod(ig.x + o.x + N, N), ig.y + o.y);
      vec2 h = dmgHash22(cell + seed * 13.0);
      vec2 rv = o + h - fg;
      float dd = dot(rv, rv);
      if (dd < m1) {
        m2 = m1;
        m1 = dd;
        cid = cell;
      } else if (dd < m2) m2 = dd;
    }
  }
  return sqrt(m2) - sqrt(m1);
}
float lensCrack(vec2 d, float seed) {
  vec2 cid;
  return crackEdge(d, seed, 60.0, cid);
}

// Stars of cracks on the glass at material point p (px = metres per pixel). x: crack line, y: frosted glass, zw: tilt of the
// shard under the pixel. A star is what a stone leaves in a windscreen: a pit, spokes running out from it, wandering a little,
// each its own length and some forking, and ragged rings that join them, some arcs missing.
vec4 glassCracks(vec3 p, float px) {
  // (PI is three's own define)
  const float NS = 11.0;
  float line = 0.0;
  float frost = 0.0;
  vec2 tilt = vec2(0.0);
  for (int i = 0; i < DMG_CRACKS; i++) {
    if (float(i) >= uCrackN) break;
    vec4 A = uCrack[2 * i];
    vec4 B = uCrack[2 * i + 1];
    vec3 q = p - A.xyz;
    float r = length(q);
    float reach = A.w;
    if (r > reach * 1.2) continue;
    float seed = B.w;
    // the plane of the glass at the crack: the star is drawn in it
    vec3 n = B.xyz;
    vec3 t1 = abs(n.y) < 0.9 ? normalize(cross(n, vec3(0.0, 1.0, 0.0))) : vec3(1.0, 0.0, 0.0);
    vec3 t2 = cross(n, t1);
    vec2 d = vec2(dot(q, t1), dot(q, t2));
    float a = atan(d.y, d.x + 1e-6);
    float iu = floor((a + PI) / (2.0 * PI) * NS);
    // line half width: about a millimetre close up, and never much under a pixel at a distance
    float w = 0.0006 + 0.3 * px;
    float fade = 1.0 - smoothstep(reach * 0.95, reach * 1.2, r);
    float ln = 0.0;
    // spokes: one in each sector at its own angle, wandering as it runs out; some fork
    for (int k = -1; k <= 1; k++) {
      float ik = iu + float(k);
      float key = mod(ik + NS, NS);
      float sa = (ik + 0.1 + 0.8 * dmgHash2(vec2(key, seed * 17.3))) / NS * 2.0 * PI - PI;
      float wob = 0.06 * (dmgNoise2(vec2(r * 16.0, key * 3.7 + seed * 9.0)) - 0.5);
      float da = a - sa - wob;
      float reachK = reach * (0.55 + 0.5 * dmgHash2(vec2(key + 29.0, seed * 5.7)));
      float spoke = (1.0 - smoothstep(w * 0.5, w * 1.2, r * abs(sin(da)))) * step(0.0, cos(da)) * (1.0 - smoothstep(reachK * 0.8, reachK, r));
      ln = max(ln, spoke);
      // a fork: leaves the spoke part of the way out, off to one side, and stops soon
      float hb = dmgHash2(vec2(key + 57.0, seed * 3.3));
      float rb = reachK * (0.22 + 0.3 * hb);
      float ang = sa + (hb < 0.5 ? -1.0 : 1.0) * (0.35 + 0.5 * dmgHash2(vec2(key + 71.0, seed)));
      vec2 dir = vec2(cos(ang), sin(ang));
      vec2 pp = d - vec2(cos(sa), sin(sa)) * rb;
      float along = dot(pp, dir);
      float fork = (1.0 - smoothstep(w * 0.5, w * 1.2, abs(pp.x * dir.y - pp.y * dir.x))) * step(0.0, along) * (1.0 - smoothstep(reachK * 0.2, reachK * 0.3, along)) * step(0.45, hb);
      ln = max(ln, fork);
    }
    // the piece between two spokes the pixel is in, and its rings: ragged arcs, some missing
    float saI = (iu + 0.1 + 0.8 * dmgHash2(vec2(mod(iu + NS, NS), seed * 17.3))) / NS * 2.0 * PI - PI;
    float seg = a >= saI ? iu : iu - 1.0;
    float band = 0.0;
    for (int j = 0; j < 4; j++) {
      float present = step(0.3, dmgHash2(vec2(seg + 40.0 + float(j) * 5.0, seed * 11.0)));
      float rho = reach * 0.14 * pow(1.65, float(j)) * (0.88 + 0.24 * dmgHash2(vec2(seg * 1.7 + float(j) * 13.0, seed * 3.1)));
      // a crack ring is a chain of short straight pieces, not a circle
      rho *= 1.0 + 0.16 * (dmgNoise2(vec2(a * 4.5 + float(j) * 7.0, seed * 5.0)) - 0.5);
      ln = max(ln, (1.0 - smoothstep(w * 0.5, w * 1.2, abs(r - rho))) * present);
      band += present * step(rho, r);
    }
    // the pit at the point of impact, and the lighter and darker stretches of a crack
    ln = max(ln * (0.6 + 0.4 * dmgNoise2(d * 55.0 + seed * 31.0)), 1.0 - smoothstep(0.004, 0.011, r));
    line = max(line, ln * fade);
    // the laminate whitens round the impact
    frost = max(frost, (1.0 - smoothstep(0.0, reach * 0.22, r)) * fade);
    vec2 h = dmgHash22(vec2(seg, band) + seed * 7.0) * 2.0 - 1.0;
    tilt += h * fade * smoothstep(0.012, 0.05, r);
  }
  return vec4(line, frost, tilt);
}

// A damaged lamp lens: crack lines and frosted shards round the hit, and, when the lamp is dead, a knocked-out middle.
// glow is how brightly the lamp is lit right now: cracks catch the light.
void lensDamage(float mask, float crack, float lit, vec3 p, vec3 hit, float seed, float px, inout vec3 col, inout float rough, inout float cc, inout vec3 emis, float glow) {
  vec2 d = (p - hit).xy;
  float r = length(d);
  float reach = 0.03 + 0.15 * crack;
  float spread = 1.0 - smoothstep(reach * 0.75, reach * 1.25, r);
  float e = lensCrack(d, seed);
  float line = (1.0 - smoothstep(0.0, 0.05 + 9.0 * px, e)) * spread;
  float shard = spread * smoothstep(0.0, 0.45, e);
  col = mix(col, col + vec3(0.06, 0.065, 0.07), shard * 0.8 * mask);
  rough = mix(rough, 0.3, spread * 0.8 * mask);
  col = mix(col, vec3(0.72, 0.75, 0.8), line * 0.8 * mask);
  emis += vec3(1.0, 0.95, 0.9) * line * mask * lit * glow * 1.5;
  if (crack > 0.97) {
    float hole = 1.0 - smoothstep(reach * 0.12, reach * 0.5, r);
    col = mix(col, vec3(0.004), hole * mask);
    cc = mix(cc, 0.0, hole * mask);
    rough = mix(rough, 0.7, hole * mask);
  }
}

// Scraped paint, rubber and transferred paint at material point p. nrm is the surface normal there (undeformed).
void dmgMarks(vec3 p, vec3 nrm, inout vec3 col, inout float rough, inout float metal, inout float cc, inout float ccRough, inout float flake, inout float isPaint, float carbonMask) {
  for (int i = 0; i < DMG_MARKS; i++) {
    if (float(i) >= uMarkN) break;
    vec4 A = uMark[3 * i];
    vec4 B = uMark[3 * i + 1];
    vec4 C = uMark[3 * i + 2];
    vec3 t = B.xyz;
    vec3 q = p - A.xyz;
    float along = dot(q, t);
    float uc = clamp(along, -A.w, A.w);
    float dd = length(q - t * uc);
    float hw = B.w;
    if (dd > hw * 1.5) continue;
    vec3 sideAxis = normalize(cross(nrm, t) + vec3(1e-5));
    float across = dot(q - t * along, sideAxis);
    float seed = C.w;
    float rag = dmgNoise2(vec2(along, across) * 9.0 + seed * vec2(7.0, 3.0));
    float core = 1.0 - smoothstep(0.3 * hw, hw * (0.6 + 0.7 * rag), dd);
    // (the ragged edge is out of reach here: nothing below changes the pixel. The same where even the strongest scratching,
    // 1.1 x 1.25 of the wear, stays under the lowest threshold of the looks below, 0.05)
    if (C.x * core * 1.4 <= 0.05) continue;
    // fine scratches run along the slide: noise stretched along t
    float lineN = dmgNoise2(vec2(along * 5.0 + seed * 13.0, across * 340.0 + seed * 5.0));
    float lineF = dmgNoise2(vec2(along * 11.0 - seed * 9.0, across * 900.0 + seed * 3.0));
    float blotch = dmgNoise2(vec2(along, across) * 26.0 + seed * 3.0);
    float streak = smoothstep(0.35, 0.85, lineN);
    float W = C.x * core * (0.3 + 0.8 * streak) * (0.55 + 0.7 * blotch);
    float kind = C.y;
    if (kind < 0.5) {
      // light scuffs: the clearcoat dulls and a few pale hairlines show
      float k = smoothstep(0.06, 0.32, W);
      cc *= 1.0 - 0.6 * k;
      ccRough = mix(ccRough, 0.5, k);
      float hair = smoothstep(0.62, 0.9, lineF) * k;
      col = mix(col, col * 1.3 + 0.025, hair * 0.6);
      rough = mix(rough, max(rough, 0.55), k * 0.6);
    } else if (kind < 1.5) {
      // scrape: the clearcoat goes, then the paint down to primer, then bare metal (or frayed carbon)
      float kc = smoothstep(0.05, 0.18, W);
      float kp = smoothstep(0.2, 0.4, W);
      float km = smoothstep(0.5, 0.72, W);
      cc *= 1.0 - kc;
      ccRough = mix(ccRough, 0.5, kc);
      vec3 primer = vec3(0.34, 0.33, 0.3) * (0.85 + 0.3 * lineF);
      col = mix(col, primer, kp);
      rough = mix(rough, 0.62, kp);
      flake *= 1.0 - kp;
      isPaint *= 1.0 - kp;
      if (uDmgBase > 0.5 || carbonMask > 0.5) {
        // carbon: the weave frays and shows pale fibres
        float fibre = smoothstep(0.45, 0.85, lineF);
        col = mix(col, mix(col, vec3(0.22, 0.22, 0.23), 0.6) + fibre * 0.12, km);
        rough = mix(rough, 0.5 + 0.2 * lineN, km);
      } else {
        vec3 steel = vec3(0.62, 0.63, 0.65) * (0.75 + 0.5 * lineF);
        col = mix(col, steel, km);
        // scuffed steel is dull: a rough lobe reads as metal outdoors, a mirror would only show the dark road
        rough = mix(rough, 0.5 + 0.2 * lineN, km);
        metal = mix(metal, 0.9, km);
      }
    } else if (kind < 2.5) {
      // tyre rubber: a black smear with a matt, dry look
      float k = smoothstep(0.08, 0.36, W);
      col = mix(col, vec3(0.012), k * 0.93);
      rough = mix(rough, 0.86, k);
      metal = mix(metal, 0.0, k);
      cc *= 1.0 - k;
      ccRough = mix(ccRough, 0.6, k);
      flake *= 1.0 - k;
      isPaint *= 1.0 - k;
    } else {
      // paint of the other car, smeared over ours
      float c24 = C.z;
      float cr = floor(c24 / 65536.0);
      float cg = floor((c24 - cr * 65536.0) / 256.0);
      float cb = c24 - cr * 65536.0 - cg * 256.0;
      vec3 other = pow(vec3(cr, cg, cb) / 255.0, vec3(2.2));
      float k = smoothstep(0.1, 0.4, W);
      col = mix(col, other, k * 0.92);
      rough = mix(rough, 0.5, k);
      cc *= 1.0 - 0.7 * k;
      ccRough = mix(ccRough, 0.4, k);
      flake *= 1.0 - k;
    }
  }
}
`;

/**
 * After the normal is built: the shards of cracked glass each lie a little askew, so the reflection in a cracked window breaks
 * up into a mosaic. Glass pass only; gShard is set by DMG_FRAG_PAINT.
 */
export const DMG_FRAG_SHARDS = /* glsl */ `
#ifdef GLASS_PASS
{
  vec3 tS = normalize(dFdx(-vViewPosition));
  vec3 bS = normalize(dFdy(-vViewPosition));
  if (dot(gShard, gShard) > 1e-5) normal = normalize(normal - (tS * gShard.x + bS * gShard.y) * 0.06);
}
#endif
`;

/**
 * Inside the zone block, once the paint, trim and lamps are decided: marks, crumple colouring, and the broken lenses.
 * Declared variables follow BODY_FRAG_ZONES (zCol, zRough, zMetal, zCC, zCCRough, zFlake, zIsPaint, zAO, zEmis).
 */
export const DMG_FRAG_PAINT = /* glsl */ `
float dmgArea = 0.0;
float dmgCrease = 0.0;
float dmgRelief = 0.0;
gShard = vec2(0.0);
#ifdef GLASS_PASS
if (uCrackN > 0.5) {
  // cracked glass: pale lines that scatter the light, frosted shards, and every shard tilted a little (gShard)
  vec4 gc = glassCracks(vObjPos, zPx);
  zCol = mix(zCol, vec3(0.78, 0.81, 0.85), gc.x);
  diffuseColor.a = mix(diffuseColor.a, 1.0, max(gc.x * 0.95, gc.y * 0.22));
  zRough = mix(zRough, 0.3, max(gc.x, gc.y * 0.5));
  gShard = gc.zw;
}
#endif
#ifndef GLASS_PASS
if (uDentN > 0.5) dmgRelief = dentRelief(vObjPos, normalize(vObjNrm), dmgArea, dmgCrease);
if (uMarkN > 0.5) dmgMarks(vObjPos, normalize(vObjNrm), zCol, zRough, zMetal, zCC, zCCRough, zFlake, zIsPaint, zCarbon);
if (uDentN > 0.5) {
  // crushed sheet is dirtier and shadowed in its folds; the paint cracks off the sharpest creases
  zCol *= 1.0 - 0.16 * dmgArea;
  zAO *= 1.0 - 0.28 * dmgArea;
  // cracked paint: bare metal in the hairline, and a few flakes lifted beside it
  if (dmgCrease > 0.0) {
    float flake = dmgNoise(vObjPos * 34.0 + 3.0) * 0.6 + dmgNoise(vObjPos * 71.0) * 0.4;
    float chip = clamp(dmgCrease * (0.7 + 0.6 * smoothstep(0.55, 0.8, flake)), 0.0, 1.0);
    vec3 under = uDmgBase > 0.5 ? vec3(0.1) : vec3(0.42, 0.43, 0.45);
    zCol = mix(zCol, under, chip * 0.85);
    zRough = mix(zRough, 0.5, chip);
    zMetal = mix(zMetal, uDmgBase > 0.5 ? 0.0 : 0.9, chip);
    zCC *= 1.0 - chip;
    zFlake *= 1.0 - chip;
  }
}
#endif
`;
