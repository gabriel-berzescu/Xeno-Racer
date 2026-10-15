/**
 * Screen-space reflections for wet roads (owner: render).
 *
 * The road shader (src/track/scene/materials.ts) writes `1 - gloss` into the alpha channel of the HDR scene
 * buffer: 1 everywhere (dry, or not a reflective surface), lower on wet asphalt, down to 0 in a puddle. This
 * pass reads that flag and blends into every flagged pixel the colour its mirror ray finds, with a Fresnel
 * weight, so puddles mirror trees, barriers, lamp heads, brake lights and the sky and a damp road smears them
 * into soft streaks. Where a ray finds nothing the pixel keeps the image-based sky reflection the forward pass
 * already added.
 *
 *   1. half-res copy of the scene with a mip chain (the glossy lookups),
 *   2. ray march of the depth buffer -> reflection colour + confidence (full resolution: puddles stay sharp),
 *   3. full-res composite: a small gloss-dependent blur of (2) hides the march noise, Fresnel-weighted mix,
 *      alpha reset to 1.
 *
 * Cost is proportional to the number of flagged pixels; the pass is disabled while the track is dry.
 */
import { Pass } from 'postprocessing';
import type { Camera, PerspectiveCamera, Texture, WebGLRenderer } from 'three';
import { HalfFloatType, LinearFilter, LinearMipmapLinearFilter, Matrix4, RGBAFormat, ShaderMaterial, Vector2, Vector3, WebGLRenderTarget } from 'three';

const vertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const copyFragment = /* glsl */ `
uniform sampler2D tScene;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  // 2x2 box: a stable, mild pre-filter for the mip chain (bright lamps do not fizz)
  vec3 c = texture2D(tScene, vUv + uTexel * vec2(-0.5, -0.5)).rgb;
  c += texture2D(tScene, vUv + uTexel * vec2(0.5, -0.5)).rgb;
  c += texture2D(tScene, vUv + uTexel * vec2(-0.5, 0.5)).rgb;
  c += texture2D(tScene, vUv + uTexel * vec2(0.5, 0.5)).rgb;
  gl_FragColor = vec4(min(c * 0.25, vec3(60.0)), 1.0);
}
`;

const traceFragment = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBlur;
uniform sampler2D tDepth;
uniform mat4 uProj;
uniform mat4 uInvProj;
uniform vec2 uRes;       // resolution in pixels
uniform vec2 uNearFar;
uniform vec3 uUp;        // world up in view space
uniform float uStride;   // pixels per march step
uniform float uMaxDist;  // metres: pixels further than this are left alone
uniform float uSeed;
varying vec2 vUv;

float linZ(float d) {
  float n = uNearFar.x;
  float f = uNearFar.y;
  return n * f / (f - d * (f - n));
}

float depthAt(ivec2 p) {
  return texelFetch(tDepth, p, 0).r;
}

vec3 viewPos(vec2 uv, float d) {
  vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}

float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

// McGuire & Mara, "Efficient GPU Screen-Space Ray Tracing": a DDA in pixel space with perspective-correct depth
// interpolation. View space looks down -z. Returns true on a hit.
bool traceRay(vec3 csOrig, vec3 csDir, float maxDist, float stride, float jitter, float thick, out vec2 hitPixel, out float travelled) {
  float nearZ = -uNearFar.x;
  float rayLen = ((csOrig.z + csDir.z * maxDist) > nearZ) ? (nearZ - csOrig.z) / csDir.z : maxDist;
  vec3 csEnd = csOrig + csDir * rayLen;
  vec4 H0 = uProj * vec4(csOrig, 1.0);
  vec4 H1 = uProj * vec4(csEnd, 1.0);
  float k0 = 1.0 / H0.w;
  float k1 = 1.0 / H1.w;
  float qz0 = csOrig.z * k0;
  float qz1 = csEnd.z * k1;
  vec2 P0 = (H0.xy * k0 * 0.5 + 0.5) * uRes;
  vec2 P1 = (H1.xy * k1 * 0.5 + 0.5) * uRes;
  P1 += vec2((dot(P1 - P0, P1 - P0) < 0.0001) ? 0.01 : 0.0);
  vec2 delta = P1 - P0;
  bool permute = false;
  if (abs(delta.x) < abs(delta.y)) {
    permute = true;
    delta = delta.yx;
    P0 = P0.yx;
    P1 = P1.yx;
  }
  float stepDir = sign(delta.x);
  float invdx = stepDir / delta.x;
  float dqz = (qz1 - qz0) * invdx;
  float dk = (k1 - k0) * invdx;
  vec2 dP = vec2(stepDir, delta.y * invdx);
  dP *= stride;
  dqz *= stride;
  dk *= stride;
  P0 += dP * jitter;
  qz0 += dqz * jitter;
  k0 += dk * jitter;

  vec2 P = P0;
  float qz = qz0;
  float k = k0;
  float end = P1.x * stepDir;
  float prevZMax = csOrig.z;
  float rayZMin = prevZMax;
  float rayZMax = prevZMax;
  float sceneZ = rayZMax - 100.0;
  float steps = 0.0;
  hitPixel = vec2(-1.0);
  for (int i = 0; i < SSR_STEPS; i++) {
    if ((P.x * stepDir) > end) break;
    rayZMin = prevZMax;
    rayZMax = (dqz * 0.5 + qz) / (dk * 0.5 + k);
    prevZMax = rayZMax;
    if (rayZMin > rayZMax) {
      float t = rayZMin;
      rayZMin = rayZMax;
      rayZMax = t;
    }
    hitPixel = permute ? P.yx : P;
    ivec2 ip = ivec2(hitPixel);
    if (ip.x < 0 || ip.y < 0 || ip.x >= int(uRes.x) || ip.y >= int(uRes.y)) {
      hitPixel = vec2(-1.0);
      return false;
    }
    sceneZ = -linZ(depthAt(ip));
    // behind the surface, but not further than the thickness: a hit
    if (rayZMax >= sceneZ - thick && rayZMin <= sceneZ) {
      // never count the sky (depth 1) as a surface: the ray just ran out into the distance
      if (sceneZ > -uNearFar.y * 0.999) {
        // bisect between the previous step and this one so the hit does not depend on the jitter
        vec2 lo = P - dP;
        float qlo = qz - dqz;
        float klo = k - dk;
        vec2 hi = P;
        float qhi = qz;
        float khi = k;
        for (int j = 0; j < 5; j++) {
          vec2 mid = (lo + hi) * 0.5;
          float qm = (qlo + qhi) * 0.5;
          float km = (klo + khi) * 0.5;
          vec2 pm = permute ? mid.yx : mid;
          float sz = -linZ(depthAt(ivec2(pm)));
          if (qm / km < sz) {
            hi = mid;
            qhi = qm;
            khi = km;
          } else {
            lo = mid;
            qlo = qm;
            klo = km;
          }
        }
        hitPixel = permute ? hi.yx : hi;
        travelled = steps * stride;
        return true;
      }
    }
    P += dP;
    qz += dqz;
    k += dk;
    steps += 1.0;
  }
  travelled = steps * stride;
  return false;
}

void main() {
  ivec2 fp = ivec2(gl_FragCoord.xy);
  vec4 sc = texelFetch(tScene, fp, 0);
  float gloss = 1.0 - sc.a;
  if (gloss < 0.02) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec2 uv = (vec2(fp) + 0.5) / uRes;
  float d = texelFetch(tDepth, fp, 0).r;
  vec3 P = viewPos(uv, d);
  float dist = -P.z;
  if (d >= 0.99999 || dist > uMaxDist) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // surface normal from the depth neighbourhood (the smaller depth step per axis, so edges do not bend it)
  // (a wide footprint, 6 px: the road mesh is made of ~1 m facets and a 1-px normal would print them into the reflection)
  vec2 px = 6.0 / uRes;
  vec3 Pr = viewPos(uv + vec2(px.x, 0.0), texelFetch(tDepth, fp + ivec2(6, 0), 0).r);
  vec3 Pl = viewPos(uv - vec2(px.x, 0.0), texelFetch(tDepth, fp - ivec2(6, 0), 0).r);
  vec3 Pu = viewPos(uv + vec2(0.0, px.y), texelFetch(tDepth, fp + ivec2(0, 6), 0).r);
  vec3 Pd = viewPos(uv - vec2(0.0, px.y), texelFetch(tDepth, fp - ivec2(0, 6), 0).r);
  vec3 dx = abs(Pr.z - P.z) < abs(P.z - Pl.z) ? Pr - P : P - Pl;
  vec3 dy = abs(Pu.z - P.z) < abs(P.z - Pd.z) ? Pu - P : P - Pd;
  vec3 N = normalize(cross(dx, dy));
  if (dot(N, P) > 0.0) N = -N;
  // a road is nearly flat: lean on the true up vector where the depth-derived normal gets noisy (grazing, far)
  N = normalize(mix(N, uUp, clamp(0.5 + dist / 100.0, 0.0, 0.92)));

  vec3 V = normalize(P);
  vec3 R = reflect(V, N);
  vec3 refl = vec3(0.0);
  float conf = 0.0;
  if (R.z < -0.02) {
    float jitter = 0.5 + (ign(gl_FragCoord.xy + uSeed) - 0.5) * 0.3;
    float thick = 0.5 + 0.025 * dist;
    vec2 hp;
    float travelled;
    vec3 origin = P + N * (0.03 + 0.0015 * dist);
    if (traceRay(origin, R, min(uMaxDist * 1.5, 400.0), uStride, jitter, thick, hp, travelled)) {
      vec2 huv = (hp + 0.5) / uRes;
      float edge = smoothstep(0.0, 0.07, min(min(huv.x, 1.0 - huv.x), min(huv.y, 1.0 - huv.y)));
      // rougher surfaces smear more, and the smear grows with the distance the reflected light travelled
      float lod = (1.0 - gloss) * (1.5 + clamp(travelled / 90.0, 0.0, 3.5)) * 1.6;
      refl = textureLod(tBlur, huv, lod).rgb;
      conf = edge * (1.0 - smoothstep(0.55, 1.0, travelled / (uRes.y * 0.6)));
    }
  }
  gl_FragColor = vec4(refl, conf);
}
`;

const compositeFragment = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tRefl;
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform vec2 uRes;
uniform vec3 uUp;
uniform float uStrength;
uniform float uDebug;
varying vec2 vUv;

vec3 viewPos(vec2 uv, float d) {
  vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}

void main() {
  vec4 sc = texture2D(tScene, vUv);
  float gloss = 1.0 - sc.a;
  if (gloss < 0.02) {
    gl_FragColor = vec4(sc.rgb, 1.0);
    return;
  }
  // a gloss-dependent cross filter over the reflections: the march noise averages out, a mirror stays sharp
  float rough = 1.0 - gloss;
  vec2 o = (0.3 + 5.0 * rough * rough + 1.5 * rough) / uRes;
  vec4 r0 = texture2D(tRefl, vUv);
  vec4 r1 = texture2D(tRefl, vUv + vec2(o.x, 0.0));
  vec4 r2 = texture2D(tRefl, vUv - vec2(o.x, 0.0));
  vec4 r3 = texture2D(tRefl, vUv + vec2(0.0, o.y * 1.8));
  vec4 r4 = texture2D(tRefl, vUv - vec2(0.0, o.y * 1.8));
  float cw = r0.a * 2.0 + r1.a + r2.a + r3.a + r4.a;
  vec3 refl = (r0.rgb * (r0.a * 2.0) + r1.rgb * r1.a + r2.rgb * r2.a + r3.rgb * r3.a + r4.rgb * r4.a) / max(cw, 1e-4);
  float conf = cw / 6.0;

  float d = texture2D(tDepth, vUv).r;
  vec3 P = viewPos(vUv, d);
  float NoV = clamp(dot(uUp, -normalize(P)), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(clamp(1.0 - NoV, 0.0, 1.0), 5.0);

  if (uDebug > 0.5) {
    gl_FragColor = vec4(uDebug < 1.5 ? vec3(conf) : refl, 1.0);
    return;
  }
  // standing water mirrors, a damp road only glosses
  float w = fres * smoothstep(0.08, 0.55, gloss) * conf * uStrength;
  gl_FragColor = vec4(mix(sc.rgb, refl, clamp(w, 0.0, 0.95)), 1.0);
}
`;

export class SSRPass extends Pass {
  private readonly copyMaterial: ShaderMaterial;
  private readonly traceMaterial: ShaderMaterial;
  private readonly compositeMaterial: ShaderMaterial;
  private readonly blur: WebGLRenderTarget;
  private readonly refl: WebGLRenderTarget;
  private depthTexture: Texture | null = null;
  private camera3: PerspectiveCamera | null = null;
  private readonly res = new Vector2(1, 1);
  private readonly up = new Vector3(0, 1, 0);
  private frame = 0;
  /** Reflection strength multiplier. */
  strength = 1;

  constructor(steps = 40, stride = 5) {
    super('SSRPass');
    this.needsSwap = true;
    this.needsDepthTexture = true;
    this.blur = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
    });
    this.blur.texture.name = 'xr.ssr.blur';
    this.refl = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
    });
    this.refl.texture.name = 'xr.ssr.refl';
    const base = { vertexShader: vertex, depthTest: false, depthWrite: false, toneMapped: false, fog: false };
    this.copyMaterial = new ShaderMaterial({
      ...base,
      name: 'xr.ssr.copy',
      uniforms: { tScene: { value: null as Texture | null }, uTexel: { value: new Vector2(1, 1) } },
      fragmentShader: copyFragment,
    });
    this.traceMaterial = new ShaderMaterial({
      ...base,
      name: 'xr.ssr.trace',
      defines: { SSR_STEPS: steps },
      uniforms: {
        tScene: { value: null as Texture | null },
        tBlur: { value: this.blur.texture },
        tDepth: { value: null as Texture | null },
        uProj: { value: new Matrix4() },
        uInvProj: { value: new Matrix4() },
        uRes: { value: this.res },
        uNearFar: { value: new Vector2(0.1, 4000) },
        uUp: { value: new Vector3(0, 1, 0) },
        uStride: { value: stride },
        uMaxDist: { value: 260 },
        uSeed: { value: 0 },
      },
      fragmentShader: traceFragment,
    });
    this.compositeMaterial = new ShaderMaterial({
      ...base,
      name: 'xr.ssr.composite',
      uniforms: {
        tScene: { value: null as Texture | null },
        tRefl: { value: this.refl.texture },
        tDepth: { value: null as Texture | null },
        uInvProj: { value: new Matrix4() },
        uRes: { value: this.res },
        uUp: { value: new Vector3(0, 1, 0) },
        uStrength: { value: 1 },
        uDebug: { value: 0 },
      },
      fragmentShader: compositeFragment,
    });
    this.fullscreenMaterial = this.compositeMaterial;
  }

  override set mainCamera(value: Camera) {
    this.camera3 = value as PerspectiveCamera;
  }

  override getDepthTexture(): Texture {
    return this.depthTexture as Texture;
  }

  override setDepthTexture(depthTexture: Texture | null): void {
    this.depthTexture = depthTexture;
    this.traceMaterial.uniforms.tDepth.value = depthTexture;
    this.compositeMaterial.uniforms.tDepth.value = depthTexture;
  }

  override setSize(width: number, height: number): void {
    this.res.set(width, height);
    this.blur.setSize(Math.max(2, width >> 1), Math.max(2, height >> 1));
    this.refl.setSize(width, height);
    (this.copyMaterial.uniforms.uTexel.value as Vector2).set(1 / width, 1 / height);
  }

  override render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget, outputBuffer: WebGLRenderTarget): void {
    const cam = this.camera3;
    if (!cam || !this.depthTexture) return;

    // 1. half-resolution mip chain of the scene (the glossy lookups)
    this.copyMaterial.uniforms.tScene.value = inputBuffer.texture;
    this.fullscreenMaterial = this.copyMaterial;
    renderer.setRenderTarget(this.blur);
    renderer.render(this.scene, this.camera);

    // world up in view space = the rotation part of the view matrix applied to (0, 1, 0)
    const e = cam.matrixWorldInverse.elements;
    this.up.set(e[4], e[5], e[6]);
    const dbg = (globalThis as { __SSR_DEBUG__?: number }).__SSR_DEBUG__ ?? 0;

    // 2. march
    const t = this.traceMaterial.uniforms;
    t.tScene.value = inputBuffer.texture;
    (t.uProj.value as Matrix4).copy(cam.projectionMatrix);
    (t.uInvProj.value as Matrix4).copy(cam.projectionMatrixInverse);
    (t.uNearFar.value as Vector2).set(cam.near, cam.far);
    (t.uUp.value as Vector3).copy(this.up);
    t.uSeed.value = (this.frame++ % 8) * 7.31;
    this.fullscreenMaterial = this.traceMaterial;
    renderer.setRenderTarget(this.refl);
    renderer.render(this.scene, this.camera);

    // 3. composite
    const c = this.compositeMaterial.uniforms;
    c.tScene.value = inputBuffer.texture;
    (c.uInvProj.value as Matrix4).copy(cam.projectionMatrixInverse);
    (c.uUp.value as Vector3).copy(this.up);
    c.uStrength.value = this.strength;
    c.uDebug.value = dbg;
    this.fullscreenMaterial = this.compositeMaterial;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
  }

  override dispose(): void {
    this.blur.dispose();
    this.refl.dispose();
    this.copyMaterial.dispose();
    this.traceMaterial.dispose();
    this.compositeMaterial.dispose();
    super.dispose();
  }
}
