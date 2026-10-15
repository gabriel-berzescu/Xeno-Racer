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
 *
 * Cockpit only: a single wiper sweeps the glass (intermittent in rain, continuous in a storm). Its schedule is a
 * pure function of time, so every point of the glass knows when the blade last passed over it: drops there are
 * gone and come back one by one as the rain refills the glass.
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
uniform float uWiper;     // 1 = the wiper runs (cockpit, raining)
varying vec2 vUv;

// ---- wiper -------------------------------------------------------------------------------------
// One blade on an arm, pivoting below the dashboard, sweeping from its park angle up across the glass and back.
const float W_OUT = 0.42;            // seconds per stroke
const float W_A0 = 0.21;             // park angle (rad, from +x)
const float W_A1 = 2.45;             // far end of the sweep
const float W_R0 = 0.16;             // blade from this far from the pivot ...
const float W_R1 = 1.02;             // ... to this far (picture heights)

vec2 wiperPivot() { return vec2(uAspect * 0.47, 0.2); }
// pause between sweeps: a few seconds in light rain, none in a storm
float wiperDwell() { return mix(2.4, 0.12, smoothstep(0.6, 0.95, uRain)); }
float wiperPeriod() { return 2.0 * W_OUT + wiperDwell(); }

// blade angle now
float wiperAngle(float t) {
  float ph = mod(t, wiperPeriod());
  float s = ph < W_OUT ? ph / W_OUT : ph < 2.0 * W_OUT ? 2.0 - ph / W_OUT : 0.0;
  return W_A0 + (W_A1 - W_A0) * (0.5 - 0.5 * cos(3.14159265 * s));
}

// seconds since the blade last swept the point p (large when it never reaches it)
float sinceWiped(vec2 p, float t) {
  if (uWiper < 0.5) return 1e4;
  vec2 d = p - wiperPivot();
  float r = length(d);
  if (r < W_R0 || r > W_R1) return 1e4;
  float a = atan(d.y, d.x);
  if (a < W_A0 || a > W_A1) return 1e4;
  // when in a stroke the blade is at this angle (inverse of the eased sweep)
  float s = acos(clamp(1.0 - 2.0 * (a - W_A0) / (W_A1 - W_A0), -1.0, 1.0)) / 3.14159265;
  float P = wiperPeriod();
  float ph = mod(t, P);
  float tOut = s * W_OUT;
  float tBack = (2.0 - s) * W_OUT;
  float last = ph >= tBack ? tBack : ph >= tOut ? tOut : tBack - P;
  return ph - last;
}

// a drop sitting where the blade passed comes back only once the rain has had time to put it there
float wipeKeep(vec2 c, float h) {
  float since = sinceWiped(c, uTime);
  if (since > 50.0) return 1.0;
  float refill = mix(4.0, 1.4, uRain);
  return step(refill * h, since);
}

// the blade itself: a dark rubber strip on a thin arm (only drawn on the glass, the dash hides the rest)
vec4 wiperBlade(vec2 uv) {
  if (uWiper < 0.5) return vec4(0.0);
  float a = wiperAngle(uTime);
  vec2 dir = vec2(cos(a), sin(a));
  vec2 d = uv - wiperPivot();
  float along = dot(d, dir);
  float across = abs(d.x * dir.y - d.y * dir.x);
  if (along < 0.0 || along > W_R1 + 0.01) return vec4(0.0);
  // about 2 cm of rubber a metre from the eye, a little out of focus (the eye is on the road)
  float w = along > W_R0 ? 0.0105 : 0.007;
  float soft = max(2.5 * uPx, 0.0022);
  float cov = 1.0 - smoothstep(w - soft, w + soft, across);
  float tip = 1.0 - smoothstep(W_R1 - soft, W_R1 + soft, along);
  return vec4(vec3(0.012, 0.012, 0.014) + uSky * 0.04 * smoothstep(0.0, w, d.x * dir.y - d.y * dir.x), cov * tip);
}

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
  float h;     // a per-drop random number (stable for the drop's life)
};

Drop noDrop() {
  Drop o;
  o.cov = 0.0;
  o.q = vec2(0.0);
  o.c = vec2(0.0);
  o.R = 1.0;
  o.h = 0.0;
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
  o.h = m.z;
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
    o.head.h = n.y;
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
  if (uWiper > 0.5 && wipeKeep(dr.c, dr.h) < 0.5) return col;
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
  if (uWiper > 0.5 && sinceWiped(uv, uTime) < 1.2) return col;
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

  // a faint veil of mist over the whole glass (thinner where the blade has just been)
  float veil = (0.012 + 0.03 * uRain) * (uWiper > 0.5 ? 0.4 + 0.6 * smoothstep(0.0, 2.0, sinceWiped(uv, t)) : 1.0);
  col = mix(col, vec3(dot(col, vec3(0.3333))) * 0.92 + uSky * 0.25, veil * mask);
  vec4 blade = wiperBlade(uv);
  col = mix(col, blade.rgb, blade.a * mask);
  gl_FragColor = vec4(col, 1.0);
}
`;

// ── the wiper's schedule in TypeScript ──────────────────────────────────────────────────────────────────────────────
// The picture is the shader above. This mirrors its three schedule functions (wiperDwell, wiperPeriod, wiperAngle) so that
// other systems (the audio) can follow the very same blade from the pass's own clock. tests/wiper-schedule.test.ts parses the
// GLSL and checks that the two agree at thousands of (time, rain) samples: a change to the shader's schedule that is not
// copied here fails the build.

/** The wiper's constants: W_OUT, W_A0, W_A1 and the dwell mix of the shader. */
export const WIPER = {
  /** Seconds per stroke (out, and again back). */
  OUT: 0.42,
  /** Park angle (rad from +x) and far end of the sweep. */
  A0: 0.21,
  A1: 2.45,
  /** Pause between sweeps in light rain, and in a storm (seconds). */
  DWELL_LIGHT: 2.4,
  DWELL_STORM: 0.12,
  /** The pause shrinks from DWELL_LIGHT to DWELL_STORM between these two rain values (smoothstep edges). */
  RAIN_LO: 0.6,
  RAIN_HI: 0.95,
} as const;

export type WiperStroke = 'out' | 'back' | 'parked';

/** Where the blade is in its schedule at one instant. */
export interface WiperState {
  /** 'out' (park -> far end), 'back' (far end -> park) or 'parked' (the pause between sweeps). */
  stroke: WiperStroke;
  /** Seconds into the cycle: mod(time, period). A sweep starts at phase 0; the back stroke ends at 2 * strokeTime. */
  phase: number;
  /** Seconds per cycle: two strokes plus the pause. */
  period: number;
  /** The pause between sweeps (seconds). */
  dwell: number;
  /** Seconds per stroke. */
  strokeTime: number;
  /** The shader's `s`: eased-sweep input 0..1 (rises during the out stroke, falls during the back stroke, 0 when parked). */
  s: number;
  /** Where the blade is across its sweep, 0 = park end .. 1 = far end (the cosine-eased s). */
  angle01: number;
  /** Blade angle in radians: exactly the shader's wiperAngle(time). */
  angle: number;
  /** Progress through the current stroke (or through the pause when parked), 0..1. */
  progress: number;
  /** Blade speed as a share of its peak, sin(pi * s): 0 when parked or at either end, 1 at mid-stroke. */
  speed01: number;
}

/** What the audio follows: the blade's clock and schedule, and whether the blade is on screen at all. */
export interface WiperFeed {
  /** The blade is drawn this frame: windscreen variant of the pass (cockpit, not hood or bumper), running, raining. */
  drawn: boolean;
  /** The droplet pass's clock (seconds) as of the frame just rendered: the shader's uTime. */
  time: number;
  /** The shader's uRain. */
  rain: number;
  state: WiperState;
}

function glslSmoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Pause between sweeps: a few seconds in light rain, almost none in a storm (the shader's wiperDwell). */
export function wiperDwell(rain: number): number {
  const k = glslSmoothstep(WIPER.RAIN_LO, WIPER.RAIN_HI, rain);
  return WIPER.DWELL_LIGHT * (1 - k) + WIPER.DWELL_STORM * k;
}

/** Seconds per cycle (the shader's wiperPeriod). */
export function wiperPeriod(rain: number): number {
  return 2 * WIPER.OUT + wiperDwell(rain);
}

export function makeWiperState(): WiperState {
  return { stroke: 'parked', phase: 0, period: wiperPeriod(0), dwell: wiperDwell(0), strokeTime: WIPER.OUT, s: 0, angle01: 0, angle: WIPER.A0, progress: 0, speed01: 0 };
}

export function makeWiperFeed(): WiperFeed {
  return { drawn: false, time: 0, rain: 0, state: makeWiperState() };
}

/** Fill `out` with the blade's state at `time` (the pass's clock) for the given rain. Allocation-free. */
export function wiperStateInto(out: WiperState, time: number, rain: number): WiperState {
  const t = time >= 0 && Number.isFinite(time) ? time : 0;
  const r = rain >= 0 ? rain : 0;
  const dwell = wiperDwell(r);
  const period = 2 * WIPER.OUT + dwell;
  // mod(t, period)
  const ph = t - period * Math.floor(t / period);
  let s = 0;
  let stroke: WiperStroke = 'parked';
  let progress = 0;
  if (ph < WIPER.OUT) {
    s = ph / WIPER.OUT;
    stroke = 'out';
    progress = s;
  } else if (ph < 2 * WIPER.OUT) {
    s = 2 - ph / WIPER.OUT;
    stroke = 'back';
    progress = ph / WIPER.OUT - 1;
  } else progress = dwell > 0 ? (ph - 2 * WIPER.OUT) / dwell : 0;
  const a01 = 0.5 - 0.5 * Math.cos(3.14159265 * s);
  out.stroke = stroke;
  out.phase = ph;
  out.period = period;
  out.dwell = dwell;
  out.strokeTime = WIPER.OUT;
  out.s = s;
  out.angle01 = a01;
  out.angle = WIPER.A0 + (WIPER.A1 - WIPER.A0) * a01;
  out.progress = progress;
  out.speed01 = Math.sin(Math.PI * s);
  return out;
}

/** The blade's state at `time` for the given rain (see WiperState). */
export function wiperState(time: number, rain: number): WiperState {
  return wiperStateInto(makeWiperState(), time, rain);
}

export class DropletPass extends Pass {
  private readonly material: ShaderMaterial;
  private depthTexture: Texture | null = null;
  private camera3: PerspectiveCamera | null = null;
  private time = 0;
  rain = 0;
  speed = 0;
  lens = false;
  strength = 1;
  /** The cockpit's wiper runs (only drawn on the windscreen variant, never on the lens). */
  wiper = true;
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
        uWiper: { value: 0 },
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

  /** The pass's clock (seconds): what the shader's uTime is fed with. */
  get clock(): number {
    return this.time;
  }

  /**
   * The wiper as seen by the frame just rendered: is the blade on screen (the same condition as the shader's uWiper, and
   * only while the pass runs), the clock and rain it was drawn with, and its place in the schedule. Allocation-free.
   */
  wiperFeed(out: WiperFeed): WiperFeed {
    out.drawn = this.enabled && this.wiper && !this.lens;
    out.time = this.time;
    out.rain = this.rain;
    wiperStateInto(out.state, this.time, this.rain);
    return out;
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
    u.uWiper.value = this.wiper && !this.lens ? 1 : 0;
    (u.uSky.value as Vector3).set(this.sky.r, this.sky.g, this.sky.b);
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);
  }

  override dispose(): void {
    this.material.dispose();
    super.dispose();
  }
}
