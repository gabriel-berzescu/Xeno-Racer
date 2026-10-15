/**
 * Rain on the windscreen / camera lens (owner: render): a full-screen pass that runs only while the camera is
 * inside the car (cockpit) or on its bodywork (hood, bumper) and it is raining.
 *
 * Procedural drops, no state. Every drop is evaluated analytically in its own frame, so it can act as a real tiny
 * lens: it shows a small, flipped, wide-angle picture of the scene around it (dark ground above, bright sky
 * below), with a dim outline on its lower side and a glint of sky light on its upper rim. Four grids of resting
 * beads (mist, small, medium, large) swell and burst; at speed the airflow stretches them along the glass and a
 * few bigger drops run up it, leaving a thin wet trail. In the cockpit the effect is limited to the windscreen by
 * DEPTH: the dashboard and pillars are within ~1.5 m of the eye, the world is further away. The lens variant
 * (hood, bumper) covers the whole picture more sparsely and defocused.
 */
import { Pass } from 'postprocessing';
import type { Camera, PerspectiveCamera, Texture, WebGLRenderer, WebGLRenderTarget } from 'three';
import { ShaderMaterial, Vector2, Vector3 } from 'three';

const vertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const fragment = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 uNearFar;
uniform float uAspect;
uniform float uPx;        // one pixel, in picture heights
uniform float uTime;
uniform float uRain;      // 0..1
uniform float uSpeed;     // m/s
uniform float uLens;      // 0 = windscreen (depth mask), 1 = lens (everywhere)
uniform float uStrength;  // optical strength of a drop
uniform vec3 uSky;        // sky light colour (glints)
varying vec2 vUv;

vec3 hash13(float p) {
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

float linZ(float d) {
  float n = uNearFar.x;
  float f = uNearFar.y;
  return n * f / (f - d * (f - n));
}

// a drop seen from the camera: coverage, position inside it (-1..1, y up), centre and radius (picture heights)
struct Drop {
  float cov;
  vec2 q;
  vec2 c;
  float R;
};

Drop noDrop() {
  Drop o;
  o.cov = 0.0;
  o.q = vec2(0.0);
  o.c = vec2(0.0);
  o.R = 1.0;
  return o;
}

// A grid of resting beads that swell, hold and burst. Cells are made taller by the stretch, so the circle of a
// drop in cell space becomes a vertical oval on the glass (the airflow pulls the water up the screen).
Drop beads(vec2 uv, float t, float cells, float live, float stretch, float slide, float rLo, float rHi, float seed) {
  float tall = max(stretch, 1.0);
  // the whole pattern creeps up the glass at 'slide' (heights per second): bigger drops are the ones the air pushes
  vec2 p = vec2(uv.x * cells, (uv.y - slide * t) * cells / tall);
  vec2 id = floor(p);
  vec2 idw = vec2(id.x, mod(id.y, 251.0));
  vec3 n = hash13(idw.x * 107.45 + idw.y * 3543.654 + seed);
  if (n.x > live) return noDrop();
  vec3 m = hash13(idw.x * 29.19 + idw.y * 177.7 + seed * 5.3);
  float age = fract(t * (0.02 + 0.045 * m.x) + n.z);
  float grow = smoothstep(0.0, 0.3, age) * (1.0 - smoothstep(0.93, 1.0, age));
  float r = mix(rLo, rHi, m.y) * grow;
  if (r < 0.03) return noDrop();
  // the centre keeps the biggest possible drop inside its own cell, so nothing is clipped by a neighbour
  vec2 c = rHi + (1.0 - 2.0 * rHi) * n.yz;
  vec2 d = fract(p) - c;
  float rho = length(d) / r;
  if (rho >= 1.25) return noDrop();
  Drop o;
  o.q = d / r;
  o.c = (id + c) * vec2(1.0, tall) / cells + vec2(0.0, slide * t);
  o.R = r / cells;
  float aa = clamp(uPx / o.R, 0.06, 0.7);
  o.cov = 1.0 - smoothstep(1.0 - aa, 1.0, rho);
  return o;
}

// A bigger drop that runs along the glass (down slowly when the car is slow, up fast at speed), plus the thin
// wet line it leaves behind.
struct Runner {
  Drop head;
  float tc;     // trail coverage
  float tq;     // across the trail, -1..1
  float tw;     // trail half width (picture heights)
};

Runner runner(vec2 uv, vec2 sh, float t, float vel, float live, float cw, float seed) {
  Runner o;
  o.head = noDrop();
  o.tc = 0.0;
  o.tq = 0.0;
  o.tw = 0.0022;
  vec2 u = uv + sh;
  float cx = u.x / cw;
  float id = floor(cx);
  vec3 n = hash13(id * 17.13 + 3.7 + seed);
  if (n.x > live) return o;
  float lane = (n.y - 0.5) * cw * 0.5;
  float P = 1.5;
  float v = vel * (0.55 + 0.9 * n.z);
  float ph = fract(n.z * 9.0 + t * v / P);
  float yp = ph * P - 0.25;
  float x0 = (id + 0.5) * cw + lane;
  float wk = 0.0035 * (0.5 + n.y);
  float wobHead = sin((yp + n.z * 6.0) * 14.0) * wk;
  float wobHere = sin((u.y + n.z * 6.0) * 14.0) * wk;
  // the head
  float sr = 1.0 + 4.0 * clamp(abs(v) / 0.42, 0.0, 1.0);
  float R = 0.0055 + 0.0045 * fract(n.x * 91.7 + n.y * 13.1);
  vec2 q = vec2(u.x - (x0 + wobHead), u.y - yp) / vec2(R, R * sr);
  float rho = length(q);
  if (rho < 1.25) {
    o.head.q = q;
    o.head.c = vec2(x0 + wobHead, yp) - sh;
    o.head.R = R;
    float aa = clamp(uPx / R, 0.06, 0.7);
    o.head.cov = 1.0 - smoothstep(1.0 - aa, 1.0, rho);
  }
  // the trail lies behind the head (opposite to its motion)
  float behind = v >= 0.0 ? yp - u.y : u.y - yp;
  float tl = 0.06 + 0.8 * abs(v);
  float dxT = u.x - (x0 + wobHere);
  o.tc = step(0.0, behind) * (1.0 - smoothstep(0.0, tl, behind)) * (1.0 - smoothstep(0.5 * o.tw, o.tw, abs(dxT)));
  o.tq = dxT / o.tw;
  return o;
}

vec3 sceneAt(vec2 pos) {
  return texture2D(tScene, vec2(pos.x / uAspect, pos.y)).rgb;
}

// One drop over the picture: a flipped, wide-angle view of the scene around the drop.
vec3 applyDrop(vec3 col, Drop dr, float M, float mask) {
  if (dr.cov < 0.004) return col;
  float rho2 = dot(dr.q, dr.q);
  float rho = sqrt(rho2);
  float h = sqrt(max(1.0 - rho2, 0.0));
  // rays bend more and more toward the rim: the picture is squeezed there (a cheap hemisphere lens)
  vec2 qn = dr.q / (h + 0.35);
  vec2 pos = dr.c - qn * (dr.R * M * uStrength);
  vec3 refr = sceneAt(pos);
  if (uLens > 0.5) {
    // out of focus: a wider, softer picture
    float bl = dr.R * 0.8;
    refr = 0.4 * refr + 0.15 * (sceneAt(pos + vec2(bl, 0.0)) + sceneAt(pos - vec2(bl, 0.0)) + sceneAt(pos + vec2(0.0, bl)) + sceneAt(pos - vec2(0.0, bl)));
  }
  float crisp = smoothstep(1.4, 4.5, dr.R / uPx);
  vec2 qd = dr.q / max(rho, 1e-3);
  float toLight = clamp(dot(qd, vec2(-0.5, 0.85)), 0.0, 1.0);
  float away = clamp(dot(qd, vec2(0.5, -0.85)), 0.0, 1.0);
  float rim = smoothstep(0.62, 1.0, rho);
  float low = smoothstep(0.2, -0.9, dr.q.y);
  vec2 hp = dr.q - vec2(-0.32, 0.4);
  // the water is a little dim toward its lower edge and picks up sky light on top
  refr *= 1.0 - crisp * 0.22 * low;
  refr += uSky * crisp * 0.2 * (1.0 - low);
  // darker outline on the lower side, sky glint on the upper rim and a small specular spot
  refr *= 1.0 - crisp * 0.55 * rim * (0.3 + 0.7 * away);
  refr += uSky * crisp * (1.8 * rim * toLight * toLight + 2.6 * exp(-dot(hp, hp) * 26.0) * h);
  return mix(col, refr, dr.cov * mask);
}

// The wet line behind a running drop: a thin cylindrical lens.
vec3 applyTrail(vec3 col, vec2 uv, float cov, float qx, float w, float mask) {
  if (cov < 0.004) return col;
  vec3 refr = sceneAt(uv - vec2(qx * w * 5.0 * uStrength, 0.0));
  float edge = smoothstep(0.5, 1.0, abs(qx));
  refr = refr * (1.0 - 0.25 * edge) + uSky * 0.12 * edge * step(0.0, qx);
  return mix(col, refr, cov * 0.55 * mask);
}

void main() {
  float d = texture2D(tDepth, vUv).r;
  float z = linZ(d);
  // windscreen: everything beyond the cockpit (dashboard / pillars sit within ~1.5 m); sky counts (depth 1)
  float mask = mix(smoothstep(1.3, 2.4, z), 1.0, uLens);
  vec3 clean = texture2D(tScene, vUv).rgb;
  if (mask < 0.01 || uRain < 0.02) {
    gl_FragColor = vec4(clean, 1.0);
    return;
  }
  vec2 uv = vec2(vUv.x * uAspect, vUv.y);
  float fast = smoothstep(2.0, 30.0, uSpeed);
  float vel = mix(-0.025, 0.42, fast);
  float amount = clamp(0.15 + uRain * 0.6, 0.0, 1.0) * (1.0 - 0.45 * uLens);
  float sk = mix(1.0, 0.75, uLens);
  float t = uTime;

  vec3 col = clean;
  // coarse to fine: the finest layer is laid down last, on top of the others' picture of the scene
  col = applyDrop(col, beads(uv, t, 10.0, amount * 0.12 * (1.0 - 0.6 * fast), 1.0 + 0.8 * fast, 0.09 * fast, 0.1 * sk, 0.26 * sk, 11.0), 8.0, mask);
  col = applyDrop(col, beads(uv, t * 1.1, 24.0, amount * 0.35, 1.0 + 2.0 * fast, 0.035 * fast, 0.14 * sk, 0.32 * sk, 23.0), 6.5, mask);
  col = applyDrop(col, beads(uv, t * 1.2, 52.0, amount * 0.55, 1.0 + 1.6 * fast, 0.0, 0.16 * sk, 0.36 * sk, 37.0), 5.0, mask);
  col = applyDrop(col, beads(uv, t * 1.3, 120.0, amount * 0.3, 1.0 + 0.6 * fast, 0.0, 0.2 * sk, 0.36 * sk, 53.0), 3.5, mask);

  Runner r = runner(uv, vec2(0.0), t, vel, amount * 0.85, 0.085, 0.0);
  col = applyTrail(col, uv, r.tc, r.tq, r.tw, mask);
  col = applyDrop(col, r.head, 6.5, mask);
  r = runner(uv, vec2(0.31, 0.0), t * 1.07, vel, amount * 0.6, 0.14, 7.0);
  col = applyTrail(col, uv, r.tc, r.tq, r.tw, mask);
  col = applyDrop(col, r.head, 6.5, mask);

  // a faint veil of mist over the whole glass
  col = mix(col, vec3(dot(col, vec3(0.3333))) * 0.92 + uSky * 0.25, (0.012 + 0.03 * uRain) * mask);
  gl_FragColor = vec4(col, 1.0);
}
`;

export class DropletPass extends Pass {
  private readonly material: ShaderMaterial;
  private depthTexture: Texture | null = null;
  private camera3: PerspectiveCamera | null = null;
  private time = 0;
  rain = 0;
  speed = 0;
  lens = false;
  strength = 1;
  readonly sky = { r: 0.1, g: 0.1, b: 0.1 };

  constructor() {
    super('DropletPass');
    this.needsSwap = true;
    this.needsDepthTexture = true;
    this.material = new ShaderMaterial({
      name: 'xr.droplets',
      uniforms: {
        tScene: { value: null as Texture | null },
        tDepth: { value: null as Texture | null },
        uNearFar: { value: new Vector2(0.05, 4000) },
        uAspect: { value: 16 / 9 },
        uPx: { value: 1 / 900 },
        uTime: { value: 0 },
        uRain: { value: 0 },
        uSpeed: { value: 0 },
        uLens: { value: 0 },
        uStrength: { value: 1 },
        uSky: { value: new Vector3(0.1, 0.1, 0.1) },
      },
      vertexShader: vertex,
      fragmentShader: fragment,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.fullscreenMaterial = this.material;
    this.enabled = false;
  }

  override set mainCamera(value: Camera) {
    this.camera3 = value as PerspectiveCamera;
  }

  override getDepthTexture(): Texture {
    return this.depthTexture as Texture;
  }

  override setDepthTexture(depthTexture: Texture | null): void {
    this.depthTexture = depthTexture;
    this.material.uniforms.tDepth.value = depthTexture;
  }

  /** Advance the drop animation (call once per frame while enabled). */
  tick(dt: number): void {
    this.time += dt;
    if (this.time > 3600) this.time -= 3600;
  }

  override render(renderer: WebGLRenderer, inputBuffer: WebGLRenderTarget, outputBuffer: WebGLRenderTarget): void {
    const cam = this.camera3;
    if (!cam || !this.depthTexture) return;
    const u = this.material.uniforms;
    u.tScene.value = inputBuffer.texture;
    (u.uNearFar.value as Vector2).set(cam.near, cam.far);
    u.uAspect.value = cam.aspect;
    u.uPx.value = 1 / Math.max(1, inputBuffer.height);
    u.uTime.value = this.time;
    u.uRain.value = this.rain;
    u.uSpeed.value = this.speed;
    u.uLens.value = this.lens ? 1 : 0;
    u.uStrength.value = this.strength;
    (u.uSky.value as Vector3).set(this.sky.r, this.sky.g, this.sky.b);
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
  }

  override dispose(): void {
    this.material.dispose();
    super.dispose();
  }
}
