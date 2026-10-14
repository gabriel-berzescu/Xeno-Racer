/**
 * Sky dome shader (owner: render).
 *
 * A fullscreen triangle pinned to the far plane (depth == 1), drawn after the opaque pass so only
 * visible sky pixels run it. Atmosphere = one fetch into the CPU-baked LUT (atmosphere.ts); on top:
 * sun disc, a cumulus-style 2D cloud layer with cheap self-shadowing, a stretched cirrus layer,
 * stars, a faint galaxy band and a lit moon. No ray marching, no volumetrics.
 */

export const skyVertexShader = /* glsl */ `
varying vec3 vDir;
void main() {
  gl_Position = vec4(position.xy, 1.0, 1.0);
  vec4 p = inverse(projectionMatrix) * vec4(position.xy, 1.0, 1.0);
  vec3 v = p.xyz / p.w;
  vDir = v * mat3(viewMatrix);
}
`;

export const skyFragmentShader = /* glsl */ `
uniform sampler2D uLut;
uniform sampler2D uNoise;
uniform vec3 uSunDir;
uniform vec2 uSunAz;
uniform float uLutE0;
uniform float uSkyScale;
uniform vec3 uSunRadiance;
uniform float uSunRadius;
uniform vec3 uGround;
uniform float uOvercast;
uniform float uShowSun;
uniform vec3 uCloudLight;
uniform vec3 uCloudAmb;
uniform vec3 uHaze;
uniform float uCoverage;
uniform float uSoft;
uniform float uCloudDark;
uniform float uCirrus;
uniform float uTime;
uniform vec2 uWind;
uniform float uStars;
uniform vec3 uMoonDir;
uniform float uMoonVis;
uniform vec3 uTrueSunDir;
uniform vec3 uMoonLight;
uniform float uQuality;
varying vec3 vDir;

const float PI = 3.14159265359;

float sat(float x) { return clamp(x, 0.0, 1.0); }
float lum3(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

// ---- atmosphere ------------------------------------------------------------------------------
vec3 atmosphere(vec3 d) {
  float el = asin(clamp(d.y, -1.0, 1.0));
  vec2 h = d.xz;
  float hl = length(h);
  float phi = 0.0;
  if (hl > 1e-5) {
    vec2 hn = h / hl;
    float cr = abs(hn.x * uSunAz.y - hn.y * uSunAz.x);
    phi = atan(cr, dot(hn, uSunAz));
  }
  float u = sqrt(phi / PI);
  float v = sqrt(clamp((el + uLutE0) / (1.57079632679 + uLutE0), 0.0, 1.0));
  vec3 c = texture2D(uLut, vec2(u, v)).rgb * uSkyScale;
  // overcast: converge toward a neutral luminance-matched grey
  c = mix(c, vec3(lum3(c)), uOvercast);
  return c;
}

// ---- clouds ----------------------------------------------------------------------------------
float cloudField(vec2 uv, vec2 w) {
  float n1 = texture2D(uNoise, uv * 0.30 + w * 0.5).r;
  float n2 = texture2D(uNoise, uv * 0.85 + w * 0.8 + vec2(0.37, 0.11)).g;
  float f = n1 * 0.66 + n2 * 0.22;
  if (uQuality > 0.5) {
    float n3 = texture2D(uNoise, uv * 2.4 - w * 0.6 + vec2(0.71, 0.53)).b;
    float n4 = texture2D(uNoise, uv * 6.5 + w * 1.2 + vec2(0.13, 0.29)).a;
    f += n3 * 0.08 + n4 * 0.04;
  } else {
    f += 0.06;
  }
  return f;
}

// returns premultiplied-ish: rgb colour, a coverage
vec4 cumulus(vec3 d, float mu) {
  vec2 uv = d.xz / (d.y + 0.13);
  vec2 w = uWind * uTime;
  float dens = cloudField(uv, w);
  float thr = mix(0.80, 0.34, uCoverage);
  float mask = smoothstep(thr, thr + uSoft + 0.03, dens);
  if (mask < 0.002) return vec4(0.0);

  float thick = smoothstep(thr, thr + 0.30, dens);
  float shade = 0.55;
  if (uQuality > 0.5) {
    float dens2 = cloudField(uv + uSunAz * 0.035, w);
    shade = clamp(0.62 - (dens2 - dens) * 4.5, 0.0, 1.0);
  }
  float fwd = pow(max(mu, 0.0), 6.0);
  // light that reaches the viewer through the cloud: strong on thin edges, forward scattered near the sun
  vec3 through = uCloudLight * shade * (1.0 - 0.72 * thick * uCloudDark) * (1.0 + 2.2 * fwd);
  vec3 amb = uCloudAmb * (1.0 - 0.38 * thick * uCloudDark);
  vec3 col = (through + amb) * 0.92;
  float edge = mask * (1.0 - thick);
  col += uCloudLight * edge * (0.25 + 1.6 * fwd);

  float hf = smoothstep(0.0, 0.30, d.y);
  col = mix(uHaze, col, hf);
  float a = mask * smoothstep(0.0, 0.075, d.y);
  return vec4(col, a);
}

vec4 cirrus(vec3 d, float mu) {
  vec2 uv = d.xz / (d.y + 0.34);
  vec2 r = vec2(uv.x * 0.82 + uv.y * 0.57, -uv.x * 0.57 + uv.y * 0.82);
  vec2 c = vec2(r.x * 0.45, r.y * 1.9);
  vec2 w = uWind * uTime * 0.35;
  float n = texture2D(uNoise, c * 0.55 + w).r * 0.5 + texture2D(uNoise, c * 1.9 + w * 1.5 + 0.31).a * 0.5;
  float m = smoothstep(0.56, 0.95, n) * uCirrus;
  float fwd = pow(max(mu, 0.0), 8.0);
  vec3 col = uCloudLight * (0.55 + 1.5 * fwd) + uCloudAmb * 0.9;
  col = mix(uHaze, col, smoothstep(0.0, 0.25, d.y));
  float a = m * smoothstep(0.0, 0.14, d.y) * 0.5;
  return vec4(col, a);
}

// ---- night sky -------------------------------------------------------------------------------
vec3 stars(vec3 d) {
  vec3 p = d * 190.0;
  vec3 ip = floor(p);
  vec3 fp = fract(p);
  vec3 h = hash33(ip);
  float on = step(0.972, h.x);
  vec3 sp = 0.28 + 0.44 * hash33(ip + 7.7);
  float dist = length(fp - sp);
  float mag = h.y * h.y * h.y;
  float px = length(fwidth(p)) * 0.7;
  float base = 0.05 + mag * 0.07;
  float s = max(base, px);
  float amp = (base * base) / (s * s);
  float v = on * exp(-(dist * dist) / (s * s)) * amp * (0.35 + 5.0 * mag);
  vec3 tint = mix(vec3(1.0, 0.82, 0.62), vec3(0.72, 0.82, 1.0), h.z);
  return tint * v;
}

vec3 galaxy(vec3 d) {
  vec3 gn = normalize(vec3(0.34, 0.80, -0.50));
  float gb = dot(d, gn);
  float band = exp(-(gb * gb) / 0.022);
  float n1 = texture2D(uNoise, d.xz * 2.1 + d.y * 0.7).r;
  float n2 = texture2D(uNoise, d.zy * 3.7 + 0.3).g;
  float dust = smoothstep(0.35, 0.8, n1 * 0.6 + n2 * 0.5);
  float core = exp(-pow(dot(d, normalize(vec3(-0.6, 0.35, 0.7))) * 1.2 - 1.2, 2.0) * 3.0);
  return vec3(0.46, 0.52, 0.74) * band * (0.15 + 0.85 * dust) * (0.55 + 1.2 * core);
}

vec3 moon(vec3 d, float vis) {
  float sinT = length(cross(d, uMoonDir));
  float mu = dot(d, uMoonDir);
  const float R = 0.0155;
  vec3 col = vec3(0.0);
  // halo
  float ang = sinT;
  col += uMoonLight * (0.016 * exp(-ang / 0.018) + 0.003 * exp(-ang / 0.09)) * step(0.0, mu);
  if (mu > 0.0 && sinT < R) {
    vec3 upRef = abs(uMoonDir.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 mx = normalize(cross(upRef, uMoonDir));
    vec3 my = cross(uMoonDir, mx);
    vec2 q = vec2(dot(d, mx), dot(d, my)) / R;
    float r2 = dot(q, q);
    float z = sqrt(max(1.0 - r2, 0.0));
    vec3 n = mx * q.x + my * q.y - uMoonDir * z;
    float lit = clamp(dot(n, uTrueSunDir) * 1.15 + 0.06, 0.0, 1.0);
    float tex = texture2D(uNoise, q * 0.22 + 0.5).r * 0.5 + texture2D(uNoise, q * 0.7 + 0.2).g * 0.5;
    float maria = mix(0.55, 1.0, smoothstep(0.25, 0.7, tex));
    float edge = 1.0 - smoothstep(0.93, 1.0, sqrt(r2));
    col += uMoonLight * lit * maria * edge * 2.6;
  }
  return col * vis;
}

void main() {
  vec3 d = normalize(vDir);
  float mu = dot(d, uSunDir);

  vec3 col = atmosphere(d);

  // sun disc + halo
  if (uShowSun > 0.5 && mu > 0.0) {
    float sinT = length(cross(d, uSunDir));
    float x = sinT / uSunRadius;
    float disc = 1.0 - smoothstep(0.96, 1.03, x);
    float limb = 0.5 + 0.5 * sqrt(max(1.0 - x * x, 0.0));
    float halo = exp(-max(x - 1.0, 0.0) * 0.55) * 0.045 + exp(-max(x - 1.0, 0.0) * 0.07) * 0.006;
    col += uSunRadiance * (disc * limb + halo);
  }

  // night: stars, galaxy, moon
  if (uStars > 0.01) {
    float horizonFade = smoothstep(0.0, 0.25, d.y);
    col += (stars(d) * 2.4 + galaxy(d) * 0.07) * uStars * horizonFade;
  }
  if (uMoonVis > 0.01) col += moon(d, uMoonVis);

  // clouds (high cirrus first, cumulus over it)
  if (d.y > -0.02) {
    if (uCirrus > 0.01 && uQuality > 0.5) {
      vec4 ci = cirrus(d, mu);
      col = mix(col, ci.rgb, ci.a);
    }
    if (uCoverage > 0.01) {
      vec4 cu = cumulus(d, mu);
      col = mix(col, cu.rgb, cu.a);
    }
  }

  // below the horizon: ground fill (only ever visible in reflections / environment capture)
  col = mix(col, uGround, smoothstep(0.012, -0.045, d.y));

  gl_FragColor = vec4(col, 1.0);
}
`;
