/**
 * The sky of a great ring (owner: render): the part of the sky dome's fragment shader that is compiled only for a circuit on an
 * Orbital (XR_ARCH; see orbital.ts for the world and skyShader.ts for where this is used).
 *
 * A great ring is millions of kilometres across: its floor is flat as far as the eye can tell, its air is a whole atmosphere, and
 * its sky is the ordinary one. What is not ordinary is the rest of the ring: a band of land and sea that leaves the horizon to the
 * north, goes up over the zenith 3.7 million kilometres away and comes down to the south, half of it in its day and half in its
 * night. It is beyond the air and in front of the stars, like a moon, and like a moon it is drawn here: a ray from the eye meets
 * the floor of the ring again (the eye is on that floor, so there is nothing to solve: t = 2 R dy / (dy^2 + dz^2)), and what it
 * meets is a world seen from space: ocean, shelf seas, land, weather, the line between day and night, the sun's glint on the sea,
 * the lights of the night side. Its own air lies over it as a veil, thicker where it is seen at a slant; ours reddens and dims it
 * toward the horizon, where it stands like a pillar a few degrees wide, and overhead it is a thread no wider than the moon.
 *
 * A dozen texture reads on a pixel of the arch, none anywhere else.
 */
export const archSkyChunk = /* glsl */ `
uniform vec4 uRing;        // radius of the floor (m); the rest is a habitat ring's
uniform vec2 uRims;        // world x of the two edges of the band
uniform vec3 uLandSun;     // sunlight on the ring's land: radiance per unit albedo at normal incidence
uniform vec3 uLandAmb;     // the light of its own sky
uniform float uLandLights; // the lights of its night side

const float ARCH_TWO_PI = 6.28318530718;

// rgb: the radiance of the arch as it reaches the eye through the air here; a: how much of what is behind it it hides
vec4 archOf(vec3 d) {
  float R = uRing.x;
  float q = max(dot(d.yz, d.yz), 1e-9);
  float dy = max(d.y, 0.0);
  float t = 2.0 * R * dy / q;                          // to where the ray meets the floor again
  float lx = cameraPosition.x + d.x * t;               // where across the band that is
  // the angle round the ring from here: 0 at our feet to the north, pi overhead, 2 pi at our feet to the south
  float turn = 2.0 * atan(dy, d.z);
  // A pixel of sky is some 4000 km of the ring's turn at any height (the turn runs at twice the angle), while across the band it is
  // a few hundred near the horizon and as many overhead: seen so slantwise, the weather of a world is hairlines, and drawn as it
  // is it would be a column of dashes. What the eye can have of it is its largest shapes: oceans, continents and the great cloud
  // masses, tens of thousands of kilometres long. So the land is drawn long (four times as far round the ring as across it: what
  // is then seen is about round), read from the texture at the pixel's longer side, and an octave says less and less as a pixel
  // comes to hold a whole feature of it (OCT): nothing finer than a few pixels is ever drawn.
  vec2 uv = vec2(turn / (ARCH_TWO_PI * 4.0), lx / (ARCH_TWO_PI * R));
  float fp = max(length(dFdx(uv)), length(dFdy(uv)));
  vec2 gx = vec2(fp, 0.0);
  vec2 gy = vec2(0.0, fp);
  float fw = max(abs(dFdx(lx)) + abs(dFdy(lx)), 1.0);
  if (d.y < 0.006) return vec4(0.0);
  float cover = clamp((lx - uRims.x) / fw + 0.5, 0.0, 1.0) * clamp((uRims.y - lx) / fw + 0.5, 0.0, 1.0);
  if (cover <= 0.0) return vec4(0.0);

  #define ARCH(N, off) textureGrad(uNoise, uv * N + off, gx * N, gy * N)
  #define OCT(N) (1.0 - smoothstep(0.02, 0.06, fp * N))
  // (each octave is read where the coarser one pushes it: value noise on a lattice shows the lattice until it is warped; the
  // outlines come from the two fbm channels of the noise, R and A)
  vec4 a = ARCH(148.0, vec2(0.13, 0.71));                                   // oceans and continents
  vec4 b = ARCH(444.0, vec2(0.37, 0.19) + (a.ra - 0.5) * 0.6);
  float kb = OCT(444.0);
  float lh = a.r * 0.62 + mix(0.19, b.a * 0.38, kb);
  float land = smoothstep(0.53, 0.58, lh);
  float shelf = smoothstep(0.44, 0.53, lh) * (1.0 - land);
  float dry = smoothstep(0.36, 0.66, a.a * 0.7 + mix(0.15, b.r * 0.3, kb));
  vec3 ground = mix(vec3(0.03, 0.07, 0.022), vec3(0.2, 0.165, 0.09), dry);
  ground = mix(ground, vec3(0.5, 0.5, 0.52), smoothstep(0.66, 0.74, lh));    // the snow of the high ranges
  vec3 sea = mix(vec3(0.006, 0.024, 0.065), vec3(0.02, 0.17, 0.19), shelf);
  vec3 alb = mix(sea, ground, land);

  // that land's own hour: its floor faces the axis, which from here is this way
  vec3 n = vec3(0.0, cos(turn), -sin(turn));
  float ndl = dot(n, uTrueSunDir);
  float lit = smoothstep(-0.03, 0.09, ndl);
  // the sun is low and red along the line between day and night
  vec3 sun = uLandSun * mix(vec3(1.0, 0.4, 0.16), vec3(1.0), smoothstep(0.0, 0.3, ndl)) * lit;
  vec3 amb = uLandAmb * (0.12 + 0.88 * lit);
  float cosl = max(ndl, 0.0);
  vec3 col = alb * (sun * cosl + amb);
  // the sun's glint on the sea
  float gl = pow(max(dot(reflect(-uTrueSunDir, n), -d), 0.0), 140.0);
  col += uLandSun * ((1.0 - land) * lit * gl * 2.2);

  // the weather of that world, seen from over it: the cloud masses of whole oceans
  vec2 w = uWind * uTime * 0.004;
  vec4 w1 = ARCH(204.0, w + vec2(0.73, 0.21));
  vec4 w2 = ARCH(512.0, w * 2.0 + vec2(0.09, 0.61) + (w1.ra - 0.5) * 0.7);
  float cl = w1.r * 0.6 + mix(0.2, w2.a * 0.4, OCT(512.0));
  float cloud = smoothstep(0.4, 0.68, cl);
  vec3 ccol = 0.84 * (sun * (0.25 + 0.75 * cosl) + amb);
  col = mix(col, ccol, cloud * 0.93);

  // the lights of the night side: few, on the coasts
  float coast = land * (1.0 - smoothstep(0.575, 0.63, lh));
  float dens = coast * smoothstep(0.4, 0.65, a.a);
  col += vec3(1.0, 0.72, 0.4) * (uLandLights * dens * (1.0 - lit) * (1.0 - cloud));

  // its own air over it: a veil of blue where that land is in its day, thicker the more slantwise it is seen (the ray meets the
  // far floor at the angle it left this one: d.y)
  float slant = 1.0 / max(d.y, 0.03);
  float veil = 1.0 - exp(-0.24 * slant);
  // (it goes out with the day too: warm and dim along the line between day and night, as the land under it is)
  float dayk = smoothstep(-0.02, 0.22, ndl);
  vec3 air = uLandSun * vec3(0.24, 0.37, 0.62) * mix(vec3(1.0, 0.5, 0.3), vec3(1.0), dayk) * dayk * (0.4 + 0.6 * cosl) + uLandAmb * 0.6 * dayk;
  col = mix(col, air, veil * 0.9);
  #undef ARCH
  #undef OCT

  // our own air on the way out: it takes the blue first (a rising moon is orange), and nearly all of it at the horizon
  vec3 T = exp(-vec3(0.05, 0.085, 0.165) * slant);
  float through = exp(-0.035 * slant);
  return vec4(col * T * cover, cover * (1.0 - 0.6 * (1.0 - through)));
}
`;
