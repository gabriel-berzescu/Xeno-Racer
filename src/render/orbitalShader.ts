/**
 * The sky inside an orbital ring (owner: render): the part of the sky dome's fragment shader that is compiled only for a circuit in a
 * habitat (XR_ORBITAL; see orbital.ts for the world and skyShader.ts for where this is used).
 *
 * Nothing here is a picture: every pixel of sky is a ray from the eye, and the ring is geometry it is tested against. The floor is a
 * cylinder about an axis along world x; the air lies on it in a shell, under a glass canopy (a second cylinder inside the first) and
 * between two glass walls at the rims (two planes). A ray ends on the land of the far floor, or leaves through glass into space:
 *
 *   land       the inside of the ring, as far as the zenith and down the other side: meadow, forest, water, towns and cloud from a
 *              few octaves of the shared noise (it tiles round the ring), lit by the sun where that land is in its day, with the
 *              lights of the towns where it is in its night, a sunset along the line between, and the sun's glint on its lakes
 *   space      the stars (they turn with the phase of the ring's day), the sun, and the planet: a banded, flattened globe and its
 *              rings, each in the other's shadow
 *   glass      the ribs and rails of the rim wall and the arches of the canopy, where the ray goes through them
 *   air        the haze of the scene's own fog over the length of air on the way (so the land the terrain mesh ends in and the land
 *              drawn here fade alike), and the thin blue of a few kilometres of air where the way is short
 *
 * The cost is a dozen texture reads on a pixel of land and a few on the planet; nothing is marched.
 */
export const orbitalSkyChunk = /* glsl */ `
uniform vec4 uRing;        // radius of the floor, its level under the circuit, the z of its lowest line, the height of the canopy (m)
uniform vec2 uRims;        // world x of the two rims
uniform vec2 uSkyRot;      // cos, sin of the phase of the ring's day: the stars turn by it
uniform vec4 uPlanet;      // direction to the planet, radiance of its sunlit cloud tops
uniform vec3 uPlanetPole;
uniform vec3 uLandSun;     // sunlight on the ring's land: radiance per unit albedo at normal incidence
uniform vec3 uLandAmb;     // the light of its sky
uniform float uLandLights; // the lights of its towns at night
uniform vec3 uStructure;   // ambient light on the white structure of the glass
uniform float uFogDens;    // the scene's fog density (exp2)
uniform vec3 uLocalLight;  // the scene's directional light (radiance per unit albedo at normal incidence): the land next to the terrain mesh is lit as the mesh is
uniform vec3 uLocalAmb;    // and the scene's ambient light on the ground

const float TWO_PI = 6.28318530718;

// how much of a pixel 'foot' metres wide a line of half-width hw covers; the lines stand every 'period' metres
float lineCover(float x, float period, float hw, float foot) {
  float dd = abs(fract(x / period + 0.5) - 0.5) * period;
  float f = max(foot, 1e-3);
  return clamp((min(dd + 0.5 * f, hw) - max(dd - 0.5 * f, -hw)) / f, 0.0, 1.0);
}

// x: how much of the sun a place on the ring sees (its own land is in the way near the ends of its day), y: the sine of the sun's height there.
// q = the place from the axis (y, z), px = its world x.
vec2 ringSun(vec2 q, float px) {
  float R = uRing.x;
  float ndl = dot(-q, uTrueSunDir.yz) / length(q);
  float sx = uTrueSunDir.x;
  float toRim = sx < 0.0 ? px - uRims.x : uRims.y - px;
  float thr = toRim * (1.0 - sx * sx) / (max(abs(sx), 0.05) * 2.0 * R);
  return vec2(smoothstep(thr, thr + 0.04, ndl), ndl - thr);
}

// points of light on the land that is in its night: one to a cell of 90 m where the density says so, never drawn smaller than a
// pixel (the way the stars are), and melting into an even glow where a pixel holds many of them
float landLights(vec2 au, float foot, float dens) {
  vec2 g = au / 90.0;
  vec2 ip = floor(g);
  vec2 fp = g - ip;
  vec3 h = hash33(vec3(ip, 7.0));
  float on = step(1.0 - dens, h.x);
  vec2 sp = 0.2 + 0.6 * h.yz;
  vec2 dv = fp - sp;
  const float base = 0.09;
  float s = max(base, foot * (0.6 / 90.0));
  float amp = (base * base) / (s * s);
  float point = on * exp(-dot(dv, dv) / (s * s)) * amp * (0.4 + 1.6 * h.y);
  return mix(point, dens * 0.0254, smoothstep(0.3, 0.8, s));
}

// ---- the planet ------------------------------------------------------------------------------
// x: how much light the rings stop at r planet radii from the centre, y: how bright they are there
vec2 planetRings(float r) {
  float fine = texture2D(uNoise, vec2(r * 2.3, 0.37)).r;
  float finer = texture2D(uNoise, vec2(r * 9.0, 0.81)).g;
  float c = smoothstep(1.235, 1.27, r) * (1.0 - smoothstep(1.515, 1.53, r));
  float b = smoothstep(1.525, 1.545, r) * (1.0 - smoothstep(1.94, 1.955, r));
  float a = smoothstep(2.025, 2.04, r) * (1.0 - smoothstep(2.255, 2.27, r)) * smoothstep(0.003, 0.009, abs(r - 2.212));
  float f = 1.0 - smoothstep(0.0, 0.01, abs(r - 2.33));
  float op = c * (0.1 + 0.22 * fine) + b * (0.72 + 0.28 * finer) * (0.8 + 0.2 * fine) + a * (0.45 + 0.25 * fine) + f * 0.12;
  float br = c * 0.4 + b * (0.78 + 0.22 * finer) + a * (0.6 + 0.1 * fine) + f * 0.5;
  return vec2(op, br);
}

// rgb: radiance, a: how much of what is behind it the planet hides
vec4 planet(vec3 d) {
  vec3 P = uPlanet.xyz;
  float ca = dot(d, P);
  if (ca < 0.94) return vec4(0.0);
  const float TA = 0.1228;                       // the globe is 7 degrees in radius
  vec3 c = (d - P * ca) / (TA * ca);             // where the ray passes the planet, in planet radii, across the line of sight
  vec3 K = uPlanetPole;
  vec3 S = uTrueSunDir;
  const float OB = 1.109;                        // flattened by a tenth along the pole
  vec3 c2 = c + K * (dot(c, K) * (OB - 1.0));
  vec3 p2 = P + K * (dot(P, K) * (OB - 1.0));
  float A = dot(p2, p2);
  float B = dot(c2, p2);
  float disc = B * B - A * (dot(c2, c2) - 1.0);
  float tGlobe = 1e9;
  vec4 col = vec4(0.0);
  float pk = dot(P, K);
  float sk = dot(S, K);
  if (disc > 0.0) {
    tGlobe = (-B - sqrt(disc)) / A;
    vec3 h = c + P * tGlobe;
    float hk = dot(h, K);
    vec3 n = normalize(h + K * (hk * (OB * OB - 1.0)));
    vec3 hs = h + K * (hk * (OB - 1.0));         // on the unit sphere: hs.K is the sine of the latitude
    float sl = dot(hs, K);
    // bands: belts and zones by latitude, pulled about a little along them
    vec3 e1 = normalize(cross(K, P));
    float lon = atan(dot(hs, e1), -dot(hs, P));
    float streak = texture2D(uNoise, vec2(lon * 0.11 + 0.2, sl * 1.7)).r;
    float bands = 0.5 + 0.26 * sin(sl * 19.0 + 2.4 * streak) + 0.16 * sin(sl * 43.0 + 1.3 + 3.0 * streak) + 0.1 * sin(sl * 8.0 - 0.6);
    vec3 alb = mix(vec3(0.66, 0.5, 0.31), vec3(0.95, 0.84, 0.62), clamp(bands, 0.0, 1.0));
    alb = mix(alb, vec3(0.6, 0.6, 0.52), smoothstep(0.72, 0.97, abs(sl)));
    float ndl = dot(n, S);
    float light = smoothstep(-0.06, 0.22, ndl) * (0.3 + 0.7 * max(ndl, 0.0)) * (0.55 + 0.45 * pow(max(dot(n, -P), 0.0), 0.5));
    // the shadow of the rings on the globe
    float lam = -hk / sk;
    if (lam > 0.0) light *= 1.0 - 0.8 * planetRings(length(h + S * lam)).x;
    float edge = smoothstep(0.0, 0.02, disc / A);
    col = vec4(alb * light * edge, edge);
  }
  // the rings: the plane across the pole. In front of the globe where they pass nearer than it, and in its shadow behind it
  float tRing = -dot(c, K) / pk;
  vec3 rp = c + P * tRing;
  float rr = length(rp);
  if (rr > 1.2 && rr < 2.36 && tRing < tGlobe) {
    vec2 pr = planetRings(rr);
    vec3 s2 = S + K * (sk * (OB - 1.0));
    float A2 = dot(s2, s2);
    float B2 = dot(rp, s2);
    float d2 = B2 * B2 - A2 * (dot(rp, rp) - 1.0);
    float shade = B2 < 0.0 ? 1.0 - smoothstep(0.0, 0.03, d2) : 1.0;
    // lit from the side the sun is on; seen from the other side the light comes through them, fainter
    float face = sk * -pk > 0.0 ? 1.0 : 0.35;
    vec3 rc = mix(vec3(0.72, 0.64, 0.52), vec3(0.93, 0.87, 0.74), pr.y) * pr.y * shade * face * (0.7 + 0.3 * abs(sk));
    col = vec4(mix(col.rgb, rc, pr.x), max(col.a, pr.x));
  }
  return vec4(col.rgb * uPlanet.w, col.a);
}

// ---- space -----------------------------------------------------------------------------------
vec3 orbitalSpace(vec3 d) {
  vec4 pl = planet(d);
  vec3 c = pl.rgb;
  if (uStars > 0.01) {
    vec3 ds = vec3(d.x, d.y * uSkyRot.x - d.z * uSkyRot.y, d.y * uSkyRot.y + d.z * uSkyRot.x);
    c += (stars(ds) * 2.4 + galaxy(ds) * 0.07) * uStars * (1.0 - pl.a);
  }
  float mus = dot(d, uTrueSunDir);
  if (uShowSun > 0.5 && mus > 0.0) {
    float x = length(cross(d, uTrueSunDir)) / uSunRadius;
    float disc = 1.0 - smoothstep(0.96, 1.03, x);
    float limb = 0.5 + 0.5 * sqrt(max(1.0 - x * x, 0.0));
    float halo = exp(-max(x - 1.0, 0.0) * 0.55) * 0.045 + exp(-max(x - 1.0, 0.0) * 0.07) * 0.006;
    c += uSunRadiance * (disc * limb + halo);
  }
  return c;
}

// ---- the land of the ring --------------------------------------------------------------------
// au = (metres round the ring from its lowest line, world x); gx, gy = how au changes per pixel; q = the place from the axis (y, z)
vec3 ringLand(vec2 au, vec2 gx, vec2 gy, vec2 q, vec3 d) {
  float R = uRing.x;
  float k = 1.0 / (TWO_PI * R);
  #define LAND(N, off) textureGrad(uNoise, au * (k * N) + off, gx * (k * N), gy * (k * N))
  // (each octave is read where the finer one pushes it: value noise on a lattice shows the lattice, as square blobs, until it is warped)
  #define LANDW(N, off, push) textureGrad(uNoise, (au + push) * (k * N) + off, gx * (k * N), gy * (k * N))
  vec4 e = LAND(940.0, vec2(0.29, 0.83));                              // 150 m
  vec4 c = LANDW(236.0, vec2(0.61, 0.43), (e.ra - 0.5) * 90.0);        // 600 m
  vec4 b = LANDW(58.0, vec2(0.37, 0.19), (c.ra - 0.5) * 420.0);        // 2.4 km
  vec4 a = LANDW(14.0, vec2(0.13, 0.71), (b.ra - 0.5) * 1700.0);       // 10 km
  // lakes (none near the circuit, where the terrain mesh is the land), forest and meadow, the pale roofs of towns
  // (the outlines come from the two fbm channels of the noise, R and A: the other two are cells, and would show as blocks)
  vec4 f = LANDW(31.0, vec2(0.83, 0.37), (b.ar - 0.5) * 900.0);        // 4.5 km
  float water = (1.0 - smoothstep(0.3, 0.35, a.r * 0.5 + b.a * 0.3 + c.r * 0.14 + e.a * 0.06)) * smoothstep(3000.0, 6500.0, abs(au.x));
  float forest = smoothstep(0.42, 0.6, a.a * 0.34 + b.r * 0.34 + c.a * 0.22 + e.r * 0.1);
  float town = smoothstep(0.56, 0.66, f.r * 0.5 + f.a * 0.2 + c.r * 0.3) * (1.0 - water) * smoothstep(2500.0, 5500.0, abs(au.x));
  vec3 meadow = mix(vec3(0.1, 0.15, 0.05), vec3(0.165, 0.185, 0.075), c.r * 0.6 + e.a * 0.4);
  vec3 woods = mix(vec3(0.028, 0.058, 0.02), vec3(0.045, 0.082, 0.03), c.a * 0.5 + e.r * 0.5);
  vec3 alb = mix(meadow, woods, forest);
  alb = mix(alb, vec3(0.4, 0.38, 0.34), town * (0.3 + 0.5 * e.a));
  alb = mix(alb, vec3(0.012, 0.03, 0.055), water);

  vec2 ls = ringSun(q, au.y);
  float lit = ls.x;
  float ndl = max(ls.y, 0.0);
  vec3 nrm = vec3(0.0, -q.x, -q.y) / length(q);
  // the sun is low and red on the land along the line between day and night
  vec3 sun = uLandSun * mix(vec3(1.0, 0.42, 0.18), vec3(1.0), smoothstep(0.0, 0.2, ls.y)) * lit;
  vec3 amb = uLandAmb * (0.2 + 0.8 * lit);
  // the land next to the circuit is in the scene's own light (the terrain mesh ends there, and the two are one meadow); round the
  // ring the hour is another, and the light is that hour's
  float far = smoothstep(4500.0, 15000.0, abs(au.x));
  vec3 direct = mix(uLocalLight * max(dot(nrm, uSunDir), 0.0), sun * (ndl + 0.04), far);
  amb = mix(uLocalAmb, amb, far);
  sun = mix(uLocalLight, sun, far);
  vec3 col = alb * (direct + amb);
  // the sun's glint on a lake
  float gl = pow(max(dot(reflect(-uTrueSunDir, nrm), -d), 0.0), 260.0);
  col += uLandSun * (water * lit * gl * 5.0);
  // the weather of that land, seen from over it
  vec2 w = uWind * uTime * 6.0;
  vec4 cw = LAND(410.0, w * 5.0 + vec2(0.73, 0.21));
  vec4 cm = LANDW(104.0, w * 2.3 + vec2(0.09, 0.61), (cw.ra - 0.5) * 260.0);
  float cl = LANDW(26.0, w + vec2(0.55, 0.07), (cm.ra - 0.5) * 1100.0).r * 0.46 + cm.a * 0.34 + cw.r * 0.2;
  float cth = mix(0.76, 0.4, uCoverage);
  // (the land next to the circuit is under the sky's own clouds: none is painted on it, and it meets the terrain mesh as one meadow)
  float cloud = smoothstep(cth, cth + 0.17, cl) * smoothstep(7000.0, 16000.0, abs(au.x));
  vec3 ccol = 0.8 * (sun * (0.3 + 0.7 * ndl) + amb * (0.3 + 0.7 * lit));
  col = mix(col, ccol, cloud * 0.92);
  // the lights of the towns, and of the houses scattered between them, where it is night
  // (the roads: a wide net pulled out of true by the noise; 54 meshes of it go round the ring)
  vec2 rw = au + (b.ra - 0.5) * 1100.0;
  float rp = TWO_PI * R / 54.0;
  float road = max(1.0 - smoothstep(0.0, 45.0, abs(fract(rw.x / rp + 0.5) - 0.5) * rp), 1.0 - smoothstep(0.0, 45.0, abs(fract(rw.y / 1490.0 + 0.5) - 0.5) * 1490.0));
  float dens = town * (0.3 + 0.5 * c.a) + road * (0.18 + 0.3 * f.a) + 0.07 * smoothstep(0.5, 0.75, c.a * 0.6 + b.r * 0.4);
  dens = clamp(dens, 0.0, 0.9) * (1.0 - water) * smoothstep(2500.0, 5500.0, abs(au.x));
  float foot = max(length(gx), length(gy));
  col += vec3(1.0, 0.74, 0.42) * (uLandLights * 30.0 * landLights(au, foot, dens) * (1.0 - lit) * (1.0 - 0.9 * cloud));
  #undef LAND
  #undef LANDW
  return col;
}

// ---- the glass -------------------------------------------------------------------------------
// the wall of a rim where the ray goes out through it at p, t metres away: ribs every 240 m, rails every 200 m of height, mullions
vec3 rimGlass(vec3 col, vec3 p, vec3 d, float t, float pix) {
  float R = uRing.x;
  vec2 q = vec2(p.y - (uRing.y + R), p.z - uRing.z);
  float h = R - length(q);
  float arc = atan(q.y, -q.x) * R;
  float inc = abs(d.x);
  float foot = t * pix / max(inc, 0.06);
  float s = max(lineCover(arc, 240.0, 3.0, foot), 0.8 * lineCover(h, 200.0, 1.3, foot));
  s = max(s, 0.16 * max(lineCover(arc, 40.0, 0.3, foot), lineCover(h, 40.0, 0.3, foot)));
  s = max(s, 1.0 - smoothstep(10.0, 12.0, h));
  vec2 ls = ringSun(q, p.x);
  float facing = max(-sign(d.x) * uTrueSunDir.x, 0.0);
  vec3 body = 0.72 * (uStructure + uLandSun * (facing * ls.x) * mix(vec3(1.0, 0.5, 0.25), vec3(1.0), smoothstep(0.0, 0.2, ls.y)));
  // the glass itself: a faint tint, and the haze of the inside mirrored in it where it is seen along its length
  float sheen = 0.025 + 0.45 * pow(1.0 - inc, 6.0);
  col = mix(col * vec3(0.95, 0.975, 0.985), uHaze * 0.8, sheen);
  return mix(col, body, s);
}

// the canopy where the ray goes up through it: arches from rim to rim every 480 m, spines along the ring between them
vec3 canopyGlass(vec3 col, vec3 p, vec3 d, float t, float pix) {
  float R = uRing.x;
  vec2 q = vec2(p.y - (uRing.y + R), p.z - uRing.z);
  float arc = atan(q.y, -q.x) * R;
  float inc = abs(dot(d.yz, q)) / length(q);
  float foot = t * pix / max(inc, 0.05);
  float s = max(lineCover(arc, 480.0, 4.0, foot), lineCover(p.x - uRims.y, 745.0, 4.0, foot));
  s = max(s, 0.14 * max(lineCover(arc, 120.0, 0.6, foot), lineCover(p.x - uRims.y, 124.17, 0.6, foot)));
  vec2 ls = ringSun(q, p.x);
  vec3 body = 0.6 * (uStructure * 0.7 + uLandSun * (0.22 * ls.x) * mix(vec3(1.0, 0.5, 0.25), vec3(1.0), smoothstep(0.0, 0.2, ls.y)));
  col = mix(col, uHaze * 0.7, 0.12 * pow(1.0 - inc, 3.0));
  return mix(col, body, s * 0.7);
}

// ---- the sky of the ring ---------------------------------------------------------------------
vec3 orbitalSky(vec3 d) {
  float R = uRing.x;
  float Rc = R - uRing.w;
  float pix = length(fwidth(d));
  vec3 o = cameraPosition;
  o.x = clamp(o.x, uRims.x + 4.0, uRims.y - 4.0);
  vec2 q0 = vec2(o.y - (uRing.y + R), o.z - uRing.z);
  // (the eye is in the air: over the floor and under the canopy, wherever the camera is)
  float l0 = length(q0);
  float lc = clamp(l0, Rc + 30.0, R - 1.0);
  q0 *= lc / l0;
  vec2 dq = d.yz;
  float a = max(dot(dq, dq), 1e-9);
  float b = dot(q0, dq);
  float tFloor = (-b + sqrt(max(b * b - a * (lc - R) * (lc + R), 0.0))) / a;
  float dc = b * b - a * (lc - Rc) * (lc + Rc);
  float sq = sqrt(max(dc, 0.0));
  bool hollow = dc > 0.0 && b < 0.0;
  float tIn = (-b - sq) / a;
  float tOut = (-b + sq) / a;
  float tRim = abs(d.x) > 1e-6 ? ((d.x > 0.0 ? uRims.y : uRims.x) - o.x) / d.x : 1e12;

  // the land where the ray would meet the floor, and how that place moves from pixel to pixel (taken here, outside the branches)
  vec2 ql = q0 + dq * tFloor;
  float lx = o.x + d.x * tFloor;
  vec2 au = vec2(atan(ql.y, -ql.x) * R, lx);
  vec2 dqx = dFdx(ql);
  vec2 dqy = dFdy(ql);
  float iq = R / dot(ql, ql);
  vec2 gx = vec2((ql.y * dqx.x - ql.x * dqx.y) * iq, dFdx(lx));
  vec2 gy = vec2((ql.y * dqy.x - ql.x * dqy.y) * iq, dFdy(lx));

  // what the ray meets: the land (tHit), the glass of a rim (tWall), the canopy on the way up (tCan); and the air on the way
  float tHit = -1.0;
  float tWall = -1.0;
  float tCan = -1.0;
  float air;
  if (!hollow) {
    if (tRim < tFloor) { tWall = tRim; air = tRim; } else { tHit = tFloor; air = tFloor; }
  } else if (tRim < tIn) {
    tWall = tRim;
    air = tRim;
  } else {
    tCan = tIn;
    if (tRim < tOut) air = tIn;                                               // out through the open side of the ring
    else if (tRim < tFloor) { tWall = tRim; air = tIn + (tRim - tOut); }      // under the far canopy, and out through its rim
    else { tHit = tFloor; air = tIn + (tFloor - tOut); }                      // the land of the far side
  }

  vec3 col = tHit > 0.0 ? ringLand(au, gx, gy, ql, d) : orbitalSpace(d);
  vec3 eye = vec3(o.x, q0.x + uRing.y + R, q0.y + uRing.z);
  if (tWall > 0.0) col = rimGlass(col, eye + d * tWall, d, tWall, pix);
  if (tCan > 0.0) col = canopyGlass(col, eye + d * tCan, d, tCan, pix);

  // the air: the scene's haze over the way through it, and the blue of thin air (land the terrain mesh could have been keeps to the
  // scene's fog alone, so that the two meet without a line)
  float f = uFogDens * air;
  float T = exp(-f * f);
  float thin = 1.0 - exp(-air / 8400.0);
  float A = (1.0 - T) + thin * T * (tHit > 0.0 ? smoothstep(6000.0, 15000.0, tHit) : 1.0);
  return col * T + atmosphere(d) * A;
}
`;
