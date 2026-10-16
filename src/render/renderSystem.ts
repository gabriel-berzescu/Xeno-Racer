/**
 * RenderSystem implementation (owner: render).
 *
 * Pipeline (all HDR, RGBA16F):
 *   shadow cascades -> RenderPass (sky, track, cars; sun + image based light)
 *   -> N8AO (optional, half-res) -> ParticlePass (soft smoke / dust / sparks / flames)
 *   -> EffectPass A: speed blur + chromatic aberration, bloom, tone map + grade + vignette + dither
 *   -> EffectPass B: SMAA or FXAA on the perceptually encoded image (optional)
 */
import {
  BloomEffect,
  BlendFunction,
  EffectComposer,
  EffectPass,
  FXAAEffect,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  TextureEffect,
  type Pass,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import {
  Camera,
  Color,
  FogExp2,
  HalfFloatType,
  HemisphereLight,
  MeshDepthMaterial,
  NoToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Quaternion,
  Scene,
  SRGBColorSpace,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import type {
  EnvironmentSettings,
  EnvironmentState,
  GraphicsSettings,
  QualityLevel,
  SplitLayout,
  Weather,
  WeatherState,
} from '../core/contracts';
import { WEATHER_WATER } from '../core/contracts';
import { splitGeometry, splitGraphics, type Rect, type SplitGeometry } from '../core/split';
import type { RenderSystem } from '../core/systems';
import { FOG_TABLE_SIZE } from './atmosphere';
import { casterKinds } from './casters';
import { blendInto, cloneSolution, solveEnvironment, type EnvSolution } from './environment';
import { FinalEffect, SpeedEffect } from './effects-post';
import { ParticlePass, particleUniforms, ShaftsPass } from './post';
import { MirrorSystem, type MirrorFrame } from './mirrors';
import { DropletPass, makeWiperFeed, makeWiperState, wiperStateInto, type WiperFeed } from './wet/droplets';
import { SSRPass } from './wet/ssr';
import { installShaderPatches, XR_LAMPS, xrFogUniform, xrLampColUniform, xrLampUniform, xrLampUpUniform } from './shaderPatches';
import { SHADOW_OFF, shadowConfigFor, SunShadows } from './shadows';
import { SkyDome } from './sky';

export interface RenderStats {
  fps: number;
  /** Smoothed wall-clock interval between render() calls. */
  frameMs: number;
  /** Draw calls of the last frame, all passes (shadow cascades, AO, post) included. */
  drawCalls: number;
  triangles: number;
  /** Smoothed CPU time spent inside render(). */
  cpuMs: number;
  /** Smoothed GPU time of the whole frame (0 when timer queries are unavailable). */
  gpuMs: number;
  /** Raw GPU time of the most recent resolved frame query (ms). */
  gpuMsRaw: number;
  /** Internal render resolution. */
  width: number;
  height: number;
  cascades: number;
  /** Analytic estimate of render-target + shadow-map memory (MB). */
  gpuMemMB: number;
  /** Per-pass GPU ms (smoothed); only filled while profiling is on (debug.profile = true). */
  passMs: Record<string, number>;
}

/**
 * One view of a split-screen frame (renderViews): the camera, the car it films (the sun's cascades, the street lamps and the rain
 * on the glass are fitted around it), that car's speed (blur, drops) and where the driver sits.
 */
export interface ViewSpec {
  camera: PerspectiveCamera;
  focus: Vector3;
  /** m/s. */
  speed: number;
  /** The rain on the glass is the windscreen and its wiper (true), a lens on the bodywork (false), or guessed from the camera's distance to the car (null). */
  cockpit: boolean | null;
}

/** What createEffects / the sandbox may use beyond the public contract. */
export interface XenoRenderSystem extends RenderSystem {
  readonly stats: RenderStats;
  readonly graphics: GraphicsSettings;
  /** Scene of soft particles rendered after AO with depth-aware fading (see ParticlePass). */
  readonly particleScene: Scene;
  readonly sky: SkyDome;
  readonly sun: SunShadows;
  readonly debug: {
    final: FinalEffect | null;
    bloom: BloomEffect | null;
    speed: SpeedEffect | null;
    shafts: ShaftsPass | null;
    ao: N8AOPostPass | null;
    composer: EffectComposer;
    /** Per-pass GPU timing into stats.passMs (replaces the whole-frame query while on). */
    profile: boolean;
  };
  /**
   * `forecastTo` makes the weather one that changes: the sky will move between the weather of `e` and this one (rain later: a dry
   * `e` and a wet `forecastTo`; clearing: the other way round), driven by setWeatherState() every frame. Both looks are solved
   * here, and the shadow cascades and the headlights are fitted for the darkest and the sunniest of the two, so that nothing the
   * change needs is built, switched or compiled once the race is on. Without it the weather is fixed.
   */
  setEnvironment(e: EnvironmentSettings, forecastTo?: Weather | null): Promise<void>;
  /**
   * What the weather is doing this frame (see WeatherState). The rain and the water on the track are the renderer's `env.rain`
   * and `env.wetness` at once, for the effects, the track scene and the cars; in a race whose weather changes the sky, the light,
   * the fog and the exposure follow `sky` on the next render() (the environment map is captured again now and then, never more
   * than once a second, and the light it gives is scaled in between so that the picture does not step).
   */
  setWeatherState(s: WeatherState): void;
  /** This race's weather changes (setEnvironment was given a `forecastTo`). */
  readonly changing: boolean;
  /** Pin the cloud animation clock (deterministic screenshots). */
  setCloudTime(t: number): void;
  /**
   * Lightning: a brief flash of the cloud deck, the ambient light, the haze and the rain (one or two flickers over
   * ~0.35 s). `strength` 0..1 (a close, big strike = 1; the caller scales it down with distance); `bearing` is the
   * azimuth of the strike in radians (0 = +Z, increasing toward +X, like the time-of-day azimuth) and defaults to
   * a random direction. Stronger at night (the same strike is brighter against a dark scene). Costs only a few
   * uniform writes while it lasts.
   */
  lightning(strength: number, bearing?: number): void;
  /**
   * Compile every shader program the scene and the particle scene need right now. A program is built the first time
   * an object is drawn, which stalls that frame (seconds for a whole track). Call it while a loading screen is up,
   * once the track and the cars are in the scene. setEnvironment() already calls it by itself when a change between
   * dry and wet swaps the shadow programs of a scene that is built (so the first frame of the race does not stall).
   */
  precompile(): Promise<void>;
  /**
   * render() right now, whatever the frame cap. For a hidden warm-up frame behind a loading screen: precompile() can't
   * reach the shadow-map depth programs and the post-processing chain, which are built by the first real frame.
   */
  renderNow(camera: PerspectiveCamera, dt: number, speed: number): void;
  /** Camera of the last render() call. */
  readonly camera: PerspectiveCamera;
  readonly solution: EnvSolution | null;
  /**
   * The cockpit wiper as the last render() drew it: is the blade on screen, the windscreen pass's clock and rain, and where the
   * blade is in its schedule. Read-only; the same object is refilled on every read (so read it right after render()). The audio
   * follows it, so the swish and the thunks land on the picture's blade.
   */
  readonly wiper: WiperFeed;
  /**
   * Which rain-on-glass look the camera gets while it rides on the focus car: true = from the driver's seat (windscreen
   * and wiper), false = a camera on the bodywork (hood, bumper: drops on its lens), null = guess from the camera's
   * distance to the focus (the default; a hood camera can sit as close to the car's centre as a cockpit eye).
   */
  setCockpitView(on: boolean | null): void;
  /**
   * The rear-view mirrors for this frame (the game calls it every frame, like setCockpitView): real glass in the cockpit
   * view, the HUD strip in the hood and bumper views, nothing when off. See src/render/mirrors.ts. Attaching a car's
   * mirrors (the first call with a new `rig`) swaps in the glass shader, so call it before precompile().
   */
  setMirrors(f: MirrorFrame): void;
  /** The HUD mirror strip is on screen (or fading in): the DOM HUD keeps its toasts clear of it. */
  readonly mirrorStrip: boolean;
  /**
   * Split screen: cut the canvas into two views of one layout (null = one view over all of it again). The buffers of the post
   * chain take the size of one view, the graphics are trimmed for the split (src/core/split.ts splitGraphics), and from then on
   * frames are drawn with renderViews(). Call it behind a loading screen, before precompile().
   */
  setSplit(layout: SplitLayout | null): void;
  /** The layout of the split screen, or null while the screen is whole. */
  readonly split: SplitLayout | null;
  /** The two views' rectangles in CSS pixels (y from the top), or null while the screen is whole. */
  readonly splitView: SplitGeometry | null;
  /**
   * Draw a split-screen frame: view 0, then view 1, each through the whole post chain into its half of the canvas. `prepare(i)` is
   * called right before view i is drawn: it is where the game points everything that depends on the camera at it (the track scene,
   * the effects, which of the cars shows its interior and its headlight beams). `dt` is the frame's, once, for the sky, the weather
   * and the clocks of each view's glass.
   */
  renderViews(dt: number, views: readonly ViewSpec[], prepare: (index: number) => void): void;
  /** renderViews() right now, whatever the frame cap, for the hidden warm-up frame (see renderNow). */
  renderViewsNow(dt: number, views: readonly ViewSpec[], prepare: (index: number) => void): void;
  /** The wiper of a view as the last frame drew it (see `wiper`, which is the whole screen's one view's). */
  wiperOf(view: 0 | 1): WiperFeed;
}

interface Tier {
  /** Screen-space reflections on wet roads: march steps and pixels per step (null = off). */
  ssr: { steps: number; stride: number } | null;
  pmrem: number;
  skyHigh: boolean;
  bloomLevels: number;
  bloomScale: number;
  ao: 'Performance' | 'Low' | 'Medium';
  speedTaps: number;
  smaa: SMAAPreset;
}

function tierFor(q: QualityLevel): Tier {
  switch (q) {
    case 'low':
      return { ssr: null, pmrem: 128, skyHigh: false, bloomLevels: 5, bloomScale: 0.3, ao: 'Performance', speedTaps: 6, smaa: SMAAPreset.LOW };
    case 'medium':
      return { ssr: { steps: 28, stride: 7 }, pmrem: 128, skyHigh: true, bloomLevels: 6, bloomScale: 0.4, ao: 'Performance', speedTaps: 8, smaa: SMAAPreset.MEDIUM };
    case 'high':
      return { ssr: { steps: 40, stride: 5 }, pmrem: 256, skyHigh: true, bloomLevels: 8, bloomScale: 0.5, ao: 'Low', speedTaps: 10, smaa: SMAAPreset.HIGH };
    default:
      return { ssr: { steps: 56, stride: 4 }, pmrem: 256, skyHigh: true, bloomLevels: 8, bloomScale: 0.5, ao: 'Medium', speedTaps: 12, smaa: SMAAPreset.ULTRA };
  }
}

/** Hard cap on drawing-buffer pixels: keeps every render target well inside a 6 GB laptop GPU's budget. */
const MAX_PIXELS = 5.4e6;
const MIN_SCALE = 0.4;
/** Weather shadow strength below which the sun's cascaded shadow maps are not rendered at all. */
const SHADOWLESS_BELOW = 0.06;

/** Luminance of a linear colour. */
const lumOf = (c: readonly number[]): number => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const yieldToBrowser = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * What a view keeps from one frame to the next: the rain on its glass and the blade across it, the clock of its droplet pass, and the
 * camera rotation its motion blur follows. A whole screen has one; a split screen two (the passes are shared, the state is swapped).
 */
class ViewState {
  /** The rain on the glass: wet within seconds of the first drops, dry again only slowly. */
  glass = 0;
  /** The driver has put the wipers on. */
  wiperOn = false;
  /** The rain the wipers are set for: the blade's schedule and its sound are built on it, so it changes only while the blade is parked. */
  wipeRain = 0;
  /** Seconds a change of the wiper setting has waited for the blade to be parked. */
  wipeWait = 0;
  /** The clock of the droplet pass while this view is drawn. */
  dropClock = 0;
  /** What the droplet pass did the last time this view was drawn (the wiper's sound follows it). */
  dropsOn = false;
  dropsLens = false;
  readonly prevQuat = new Quaternion();
  havePrevQuat = false;
  readonly pan = new Vector2();
}

interface GpuTimer {
  gl: WebGL2RenderingContext;
  ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
  free: WebGLQuery[];
  pending: { q: WebGLQuery; name: string | null }[];
  active: WebGLQuery | null;
}

class RenderSystemImpl implements XenoRenderSystem {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly particleScene = new Scene();
  readonly env: EnvironmentState = {
    settings: { timeOfDay: 'golden', weather: 'clear' },
    sunDirection: new Vector3(0, 1, 0),
    sunIntensity: 1,
    darkness: 0,
    fogColor: '#9fb4c8',
    rain: 0,
    wetness: 0,
  };
  readonly stats: RenderStats = { fps: 0, frameMs: 16.7, drawCalls: 0, triangles: 0, cpuMs: 0, gpuMs: 0, gpuMsRaw: 0, width: 0, height: 0, cascades: 0, gpuMemMB: 0, passMs: {} };
  readonly sky: SkyDome;
  readonly sun: SunShadows;
  camera: PerspectiveCamera = new PerspectiveCamera(60, 1, 0.1, 4000);
  solution: EnvSolution | null = null;

  graphics: GraphicsSettings;
  private tier: Tier;
  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly particlePass: ParticlePass;
  private aoPass: N8AOPostPass | null = null;
  private passes: Pass[] = [];
  private finalEffect: FinalEffect | null = null;
  private bloomEffect: BloomEffect | null = null;
  private speedEffect: SpeedEffect | null = null;
  private shaftsPass: ShaftsPass | null = null;
  private shaftsBlend: TextureEffect | null = null;
  private ssrPass: SSRPass | null = null;
  private dropletPass: DropletPass | null = null;
  private readonly wiperOut: WiperFeed = makeWiperFeed();
  private cockpitView: boolean | null = null;
  /** The views: one, and a second while the screen is split. */
  private readonly views: ViewState[] = [new ViewState(), new ViewState()];
  /** The two rectangles of a split screen (null: one view over the canvas). */
  private splitGeo: SplitGeometry | null = null;
  /** The graphics the pipeline is built from: the player's, trimmed while the screen is split. */
  private effective: GraphicsSettings;
  private aaEffect: SMAAEffect | FXAAEffect | null = null;
  private pipelineKey = '';
  private flashAmp = 0;
  private flashT = 0;
  private flashDirX = 0;
  private flashDirZ = 1;
  private flashApplied = false;
  /** Street-lamp heads from the track scene (see updateLamps). */
  private lampHeads: Float32Array | null = null;
  private lampScanT = 0;
  private readonly lampD2 = new Float64Array(XR_LAMPS);
  private readonly lampIx = new Int32Array(XR_LAMPS);
  private readonly lampV = new Vector3();
  /** Set when an environment change swapped the shadow configuration (every shadow-receiving program differs). */
  private shadowProgramsChanged = false;
  /** The lamps updateLamps picked (how many; their heads are in lampIx), so a mirror camera can re-express them in its own view. */
  private lampN = 0;
  private lampLit = false;
  /** True during the hidden warm-up frame (renderNow). */
  private warming = false;
  /** The pipeline was rebuilt in a race that rain can come to: the next frame draws its wet-weather passes once (see render). */
  private rewarm = false;
  /** This frame draws the wet-weather passes whatever the weather: the warm-up frame, or the first one after a rebuild. */
  private warmPasses = false;
  /** The depth materials the warm-up frame built the shadow pass's programs with (see renderNow). */
  private warmDepth: MeshDepthMaterial[] = [];
  private readonly mirrors: MirrorSystem;
  /** The weather this frame (setWeatherState): the rain and the water are `env`'s at once, the sky waits for render(). */
  private readonly wx: WeatherState = { sky: 0, rain: 0, wetness: 0 };
  /**
   * A race whose weather changes: the two looks it moves between, and the blend of them that is on screen (rewritten in place).
   * `sky` and `rain` are what the blend was made for; `cap` is what the environment map was last captured for.
   */
  private fc: {
    dry: EnvSolution;
    wet: EnvSolution;
    mix: EnvSolution;
    sky: number;
    rain: number;
    cap: { sky: number; at: number; ambient: number };
  } | null = null;
  /** Seconds of render time (the environment map is captured at most once a second). */
  private clock = 0;
  /** Light of the environment map now over the light it was captured with: it carries the picture between two captures. */
  private envScale = 1;
  /** Do the shadow maps matter (is there a sun)? When not, a race that keeps its cascades through the rain stops drawing them. */
  private shadowsLive = true;
  private readonly wipeState = makeWiperState();

  private readonly hemi = new HemisphereLight(0xffffff, 0x444444, 1);
  private readonly fog = new FogExp2(0x9fb4c8, 0.0002);
  private readonly pmrem: PMREMGenerator;
  private readonly envScene = new Scene();
  private envTarget: WebGLRenderTarget | null = null;
  private envToken = 0;
  /** Stand-in for the composer's buffers while precompiling (see precompile). */
  private compileTarget: WebGLRenderTarget | null = null;

  private cssW = 1280;
  private cssH = 720;
  private pixelRatio = 1;
  private readonly focus = new Vector3();
  private frameIndex = 0;
  private lastStart = 0;
  private lastRenderEnd = 0;
  private readonly curQuat = new Quaternion();
  private readonly dq = new Quaternion();
  private gpu: GpuTimer | null = null;
  profiling = false;
  private disposed = false;
  private cameraNear = 0;
  private cameraFar = 0;
  private baseExposure = 1;
  private readonly onContextRestored: () => void;
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, g: GraphicsSettings) {
    const patches = installShaderPatches();

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    const r = this.renderer;
    // Reading back every shader's info logs on its first use is a synchronous round trip to the GPU process per program:
    // the error reports are for development, a shipped build skips them
    r.debug.checkShaderErrors = !import.meta.env.PROD;
    r.outputColorSpace = SRGBColorSpace;
    r.toneMapping = NoToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    r.shadowMap.autoUpdate = false;
    r.info.autoReset = false;
    r.setClearColor(0x000000, 1);

    this.graphics = { ...g };
    this.effective = this.graphics;
    this.tier = tierFor(g.quality);

    this.scene.name = 'xr.scene';
    this.scene.fog = this.fog;
    this.sky = new SkyDome();
    this.scene.add(this.sky.mesh);
    this.envScene.add(this.sky.envMesh);
    this.sun = new SunShadows(patches.csm);
    this.scene.add(this.sun.group);
    this.scene.add(this.hemi);
    this.particleScene.name = 'xr.particles';
    this.mirrors = new MirrorSystem(r, this.scene, this.particleScene, { setView: (cam) => this.setLampView(cam), time: (name) => this.timeBegin(name) });

    this.pmrem = new PMREMGenerator(r);

    const floatOk = r.extensions.has('EXT_color_buffer_float') || r.extensions.has('EXT_color_buffer_half_float');
    this.composer = new EffectComposer(r, {
      depthBuffer: true,
      stencilBuffer: false,
      multisampling: 0,
      frameBufferType: floatOk ? HalfFloatType : UnsignedByteType,
    });
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.particlePass = new ParticlePass(this.particleScene, this.camera);

    this.initGpuTimer();
    // three restores its own resources after a lost context; the baked environment map has to be redone
    this.onContextRestored = () => {
      if (this.solution && !this.disposed) {
        this.captureEnvironment(this.solution);
        this.sun.markDirty();
        // (a changing weather: the map was just captured for the sky as it is now)
        if (this.fc) {
          this.fc.cap = { sky: this.fc.sky, at: this.clock, ambient: lumOf(this.fc.mix.skyAmbient) };
          this.envScale = 1;
        }
      }
    };
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.canvas = canvas;

    this.cssW = canvas.clientWidth || window.innerWidth || 1280;
    this.cssH = canvas.clientHeight || window.innerHeight || 720;
    this.applyGraphicsInternal(true);
  }

  // ───────────────────────────── public API ─────────────────────────────

  async setEnvironment(e: EnvironmentSettings, forecastTo: Weather | null = null): Promise<void> {
    const token = ++this.envToken;
    const sol = await solveEnvironment(e, yieldToBrowser);
    // the other end of a weather that changes: the same light, the other weather (cached, so a restart costs nothing)
    const other = forecastTo && forecastTo !== e.weather ? await solveEnvironment({ ...e, weather: forecastTo }, yieldToBrowser) : null;
    if (token !== this.envToken || this.disposed) return;
    this.fc = null;
    // (a forecast has to join a dry weather and a wet one: anything else is just the start weather)
    if (other && (other.deck > 0) !== (sol.deck > 0)) this.applyForecast(sol, other);
    else this.applySolution(sol);
    // Dry <-> wet swaps the shadow programs of everything that receives shadows. With a track already in the scene
    // that is a multi-second compile: take it now, under the caller's loading screen, not in the first frame.
    if (this.shadowProgramsChanged) {
      this.shadowProgramsChanged = false;
      if (this.scene.children.length > 0) await this.precompile();
    }
  }

  async precompile(): Promise<void> {
    if (this.disposed) return;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    try {
      // The scene and particles are drawn into the composer's linear buffers, never straight to the canvas, and a
      // program's variant depends on its target (output colour space, tone mapping): compile against a stand-in
      // target, or every program would be compiled a second time, for the canvas, and never used. compileAsync picks
      // the programs synchronously, so the target only has to be set around the calls.
      this.compileTarget ??= new WebGLRenderTarget(1, 1, { depthBuffer: false });
      r.setRenderTarget(this.compileTarget);
      const pending = [r.compileAsync(this.scene, this.camera), r.compileAsync(this.particleScene, this.camera), r.compileAsync(this.mirrors.flareScene, this.camera)];
      // the HUD mirror strip is the one thing drawn straight to the canvas (after the post chain), so it is compiled for it
      r.setRenderTarget(null);
      const hud = this.mirrors.compileScene;
      pending.push(r.compileAsync(hud.scene, hud.camera));
      r.setRenderTarget(prev);
      await Promise.all(pending);
      // A program looks up its uniform and attribute locations the first time something is drawn with it: one synchronous
      // call per uniform, tens of ms for the big lit shaders. The warm-up frame only reaches what it sees, so smoke, skid
      // marks or a car coming into view would pay in the race: do it for every program now, behind the loading screen.
      for (const p of r.info.programs ?? []) {
        p.getUniforms();
        p.getAttributes();
      }
    } catch {
      // the first frame compiles whatever is still missing
      r.setRenderTarget(prev);
    }
  }

  renderNow(camera: PerspectiveCamera, dt: number, speed: number): void {
    this.lastStart = 0;
    // the hidden warm-up frame draws every mirror once too, so their targets and passes exist before the race
    this.mirrors.forceNext();
    this.warmFrame(() => this.render(camera, dt, speed));
  }

  renderViewsNow(dt: number, views: readonly ViewSpec[], prepare: (index: number) => void): void {
    this.lastStart = 0;
    this.warmFrame(() => this.renderViews(dt, views, prepare));
  }

  private warmFrame(draw: () => void): void {
    this.warming = true;
    // The shadow pass of this frame draws one caster of every kind of depth program wherever it stands, each with a depth material
    // of its own (see casterKinds). three.js draws all that has no alpha test with one shared depth material, and it picks the
    // program for it again only when the kind of draw changes (instanced or not): which programs get built then depends on the
    // order in which the casters happen to be drawn, and the one a race needs may only come when the car gets to a fence.
    const kinds = this.sun.cascadeCount > 0 ? casterKinds(this.scene) : [];
    const saved = kinds.map((o) => ({ culled: o.frustumCulled, depth: o.customDepthMaterial }));
    const depth = kinds.map(() => new MeshDepthMaterial());
    kinds.forEach((o, i) => {
      o.frustumCulled = false;
      o.customDepthMaterial = depth[i];
    });
    try {
      draw();
    } finally {
      this.warming = false;
      kinds.forEach((o, i) => {
        o.frustumCulled = saved[i].culled;
        o.customDepthMaterial = saved[i].depth;
      });
      // (these keep the programs they built alive, until the next warm-up has built the same again: a program with no material
      // left is deleted, and built again when the race needs it)
      for (const m of this.warmDepth) m.dispose();
      this.warmDepth = depth;
    }
  }

  applyGraphics(g: GraphicsSettings): void {
    this.graphics = { ...g };
    this.applyGraphicsInternal(false);
  }

  setFocus(p: Vector3): void {
    this.focus.copy(p);
  }

  setCockpitView(on: boolean | null): void {
    this.cockpitView = on;
  }

  setMirrors(f: MirrorFrame): void {
    this.mirrors.setFrame(f);
  }

  get mirrorStrip(): boolean {
    return this.mirrors.stripShown;
  }

  resize(width: number, height: number): void {
    this.cssW = Math.max(1, Math.floor(width));
    this.cssH = Math.max(1, Math.floor(height));
    if (this.splitGeo) this.splitGeo = splitGeometry(this.cssW, this.cssH, this.splitGeo.layout);
    this.updateSize();
  }

  setSplit(layout: SplitLayout | null): void {
    const was = this.splitGeo !== null;
    this.splitGeo = layout ? splitGeometry(this.cssW, this.cssH, layout) : null;
    if (was) this.endViews();
    this.sun.select(0);
    if (!layout) this.sun.releaseSecond();
    for (const v of this.views) v.havePrevQuat = false;
    // the graphics are trimmed for the split (or given back), the buffers take the size of a view, a pipeline whose passes differ is rebuilt
    this.applyGraphicsInternal(false);
  }

  get split(): SplitLayout | null {
    return this.splitGeo ? this.splitGeo.layout : null;
  }

  get splitView(): SplitGeometry | null {
    return this.splitGeo;
  }

  setCloudTime(t: number): void {
    this.sky.setTime(t);
  }

  setWeatherState(s: WeatherState): void {
    const wx = this.wx;
    wx.sky = Math.min(1, Math.max(0, s.sky));
    wx.rain = Math.min(1, Math.max(0, s.rain));
    wx.wetness = Math.min(1, Math.max(0, s.wetness));
    // the rain and the water reach everyone who reads them at once (the effects, the track scene, the cars); the sky waits for render()
    this.env.rain = wx.rain;
    this.env.wetness = wx.wetness;
  }

  get changing(): boolean {
    return this.fc !== null;
  }

  lightning(strength: number, bearing?: number): void {
    // a flash only belongs to storm-strength rain (a strike scheduled for a storm that has since eased, or a race that has not
    // got there yet, shows nothing)
    if (!(strength > 0.01) || this.env.rain < 0.7) return;
    this.flashAmp = Math.min(1, strength);
    this.flashT = 0;
    const az = bearing !== undefined && Number.isFinite(bearing) ? bearing : Math.random() * Math.PI * 2;
    this.flashDirX = Math.sin(az);
    this.flashDirZ = Math.cos(az);
  }

  /** Flash envelope: a sharp strike, a fast fall-off and a weaker second flicker. */
  private flashLevel(t: number): number {
    const u = (t - 0.16) / 0.045;
    return Math.exp(-t / 0.05) * Math.min(1, t / 0.012) + 0.6 * Math.exp(-u * u);
  }

  /** Apply the flash (or restore the baseline once it is over). */
  private updateFlash(dt: number): void {
    const sol = this.solution;
    if (!sol) return;
    const active = this.flashAmp > 0;
    if (!active && !this.flashApplied) return;
    let f = 0;
    if (active) {
      this.flashT += dt;
      f = this.flashLevel(this.flashT) * this.flashAmp;
      if (this.flashT > 0.5) {
        this.flashAmp = 0;
        f = 0;
      }
    }
    const dark = sol.darkness;
    // dark scenes lift far more (the exposure is high and the ambient light tiny)
    const gain = f * (2.2 + 5 * dark);
    const add = f * 0.55 / Math.max(sol.exposure, 0.5);
    this.sky.setFlash(f, add * 0.92, add * 0.96, add * 1.06, this.flashDirX, this.flashDirZ);
    this.hemi.intensity = 1 + gain;
    this.scene.environmentIntensity = sol.envIntensity * this.envScale * (1 + gain);
    const haze = 1 + f * (1.5 + 2 * dark);
    const fa = xrFogUniform.value;
    for (let k = 0; k < FOG_TABLE_SIZE; k++) {
      fa[(k + 1) * 4] = sol.fogTable[k * 3] * haze;
      fa[(k + 1) * 4 + 1] = sol.fogTable[k * 3 + 1] * haze;
      fa[(k + 1) * 4 + 2] = sol.fogTable[k * 3 + 2] * haze;
    }
    const dk = (FOG_TABLE_SIZE + 1) * 4;
    fa[dk] = sol.deckHi[0] * haze;
    fa[dk + 1] = sol.deckHi[1] * haze;
    fa[dk + 2] = sol.deckHi[2] * haze;
    this.fog.color.setRGB(sol.fogColor[0] * haze, sol.fogColor[1] * haze, sol.fogColor[2] * haze);
    const pu = particleUniforms;
    const rainLift = 1 + f * (3 + 6 * dark);
    pu.uSkyAmb.value.set(sol.skyAmbient[0] * rainLift, sol.skyAmbient[1] * rainLift, sol.skyAmbient[2] * rainLift);
    pu.uFogColor.value.set(sol.fogColor[0] * haze, sol.fogColor[1] * haze, sol.fogColor[2] * haze);
    this.flashApplied = f > 0.001;
  }

  get wiper(): WiperFeed {
    const f = this.wiperOut;
    const p = this.dropletPass;
    if (!p) {
      f.drawn = false;
      return f;
    }
    return p.wiperFeed(f);
  }

  wiperOf(view: 0 | 1): WiperFeed {
    const f = this.wiperOut;
    const v = this.views[view];
    // (as DropletPass.wiperFeed: the pass ran, with the blade, on the windscreen)
    f.drawn = v.dropsOn && v.wiperOn && !v.dropsLens;
    f.time = v.dropClock;
    f.rain = v.wipeRain;
    wiperStateInto(f.state, f.time, f.rain);
    return f;
  }

  get debug(): XenoRenderSystem['debug'] {
    const self = this;
    return {
      final: this.finalEffect,
      bloom: this.bloomEffect,
      speed: this.speedEffect,
      shafts: this.shaftsPass,
      ao: this.aoPass,
      composer: this.composer,
      get profile() {
        return self.profiling;
      },
      set profile(v: boolean) {
        self.profiling = v;
        if (!v) self.stats.passMs = {};
      },
    };
  }

  render(camera: PerspectiveCamera, dt: number, speed: number): void {
    if (this.disposed) return;
    const t0 = performance.now();
    dt = this.beginFrame(t0, dt);
    if (dt < 0) return;

    this.setCamera(camera);
    camera.updateMatrixWorld();
    if (!Number.isFinite(speed)) speed = 0;
    this.frameIndex++;
    this.prepareView(this.views[0], camera, this.focus, this.cockpitView, speed, dt, dt);

    this.renderer.info.reset();
    this.beginGpu();
    this.composer.render(dt);
    // The mirrors after the picture: this frame's shadow maps are done (no mirror pass draws them again) and the glass in
    // the next picture shows what is drawn here, a frame behind, which a mirror does not show.
    this.mirrors.setWeather(this.views[0].glass);
    this.mirrors.render(camera, dt, this.stats.height, this.pixelRatio, this.cssW, this.cssH);
    this.mirrors.drawStrip(this.cssW, this.cssH, this.pixelRatio);
    this.endGpu();
    this.endFrame(t0);
  }

  renderViews(dt: number, specs: readonly ViewSpec[], prepare: (index: number) => void): void {
    if (this.disposed || specs.length === 0) return;
    const geo = this.splitGeo;
    if (!geo) {
      // the screen is whole: the first view is all of it
      prepare(0);
      this.focus.copy(specs[0].focus);
      this.cockpitView = specs[0].cockpit;
      this.render(specs[0].camera, dt, specs[0].speed);
      return;
    }
    const t0 = performance.now();
    dt = this.beginFrame(t0, dt);
    if (dt < 0) return;
    this.frameIndex++;
    this.focus.copy(specs[0].focus);

    this.renderer.info.reset();
    this.beginGpu();
    const n = Math.min(2, specs.length);
    // The cascades of both views are fitted before the first is drawn: the lights move now, and the one pass over the scene's matrices
    // that the first view's draw makes serves the second view too (nothing moves between the views, only what is shown in each).
    let due = 0;
    for (let i = 0; i < n; i++) {
      this.sun.select(i === 0 ? 0 : 1);
      if (this.fitSun(specs[i].focus)) due |= 1 << i;
    }
    try {
      for (let i = 0; i < n; i++) {
        const spec = specs[i];
        // what depends on the camera is pointed at it just before it is drawn (the track scene, the effects, the cars' interiors)
        prepare(i);
        this.sun.select(i === 0 ? 0 : 1);
        this.renderer.shadowMap.needsUpdate = (due & (1 << i)) !== 0;
        this.setCamera(spec.camera);
        spec.camera.updateMatrixWorld();
        // (the sky, the weather and the clocks of the glass move once a frame: the second view only re-aims the lamps)
        const v = this.views[i];
        const speed = Number.isFinite(spec.speed) ? spec.speed : 0;
        this.updateDroplets(v, spec.camera, spec.focus, spec.cockpit, dt, speed);
        this.updateLamps(spec.camera, spec.focus, i === 0 ? dt : 0);
        this.updateSpeedEffects(v, spec.camera, dt, speed);
        this.updateShafts(spec.camera);
        if (this.finalEffect) this.finalEffect.seed = (this.frameIndex % 64) / 64;
        this.aimView(geo.views[i]);
        this.scene.matrixWorldAutoUpdate = i === 0;
        this.composer.render(dt);
      }
    } finally {
      // (whatever happens in a view, the scene's matrices update again and the canvas is whole again)
      this.scene.matrixWorldAutoUpdate = true;
      this.endViews();
    }
    this.endGpu();
    this.endFrame(t0);
  }

  /**
   * The start of a frame, whatever the number of views: the frame cap, the clocks, and everything that moves once a frame (the sky,
   * the weather, the lightning). Returns the frame's dt, or -1 when the cap skips the frame.
   */
  private beginFrame(t0: number, dt: number): number {
    // frame cap
    const cap = this.graphics.maxFps;
    if (cap > 0 && this.lastStart > 0 && t0 - this.lastStart < 1000 / cap - 1.2) return -1;

    const interval = this.lastStart > 0 ? t0 - this.lastStart : 16.7;
    this.lastStart = t0;
    const s = this.stats;
    s.frameMs += (Math.min(interval, 250) - s.frameMs) * 0.08;
    s.fps = 1000 / Math.max(s.frameMs, 0.01);

    // never let a bad number from the caller reach the GPU: one NaN pixel is smeared over the whole
    // frame by the bloom blur
    dt = Number.isFinite(dt) && dt > 0 ? Math.min(Math.max(dt, 1 / 500), 0.25) : 1 / 60;

    // A pipeline rebuilt in the middle of a race (a change of the graphics settings) has new wet-weather passes, and a pass builds
    // its programs when it is first drawn: so the first frame after the rebuild draws them once, as the warm-up frame does (nothing
    // of them shows while there is no rain on the glass or water on the road), and the rain does not find them unbuilt.
    this.warmPasses = this.warming || this.rewarm;
    this.rewarm = false;

    this.sky.update(dt);
    this.updateWeatherLook(dt);
    this.updateFlash(dt);
    // (the warm-up frame runs the wet-road reflections too wherever rain can come, so their programs are built behind the loading screen)
    if (this.ssrPass) this.ssrPass.enabled = this.env.wetness > 0.02 || (this.warmPasses && this.wetPossible);
    return dt;
  }

  /**
   * What a view needs settled before it is drawn: the rain on its glass, the street lamps and the sun's cascades around the car it
   * films, the camera blur and the sun shafts. `lampDt` is 0 for the second view of a frame (the lamp search has its own clock).
   */
  private prepareView(v: ViewState, camera: PerspectiveCamera, focus: Vector3, cockpit: boolean | null, speed: number, dt: number, lampDt: number): void {
    this.updateDroplets(v, camera, focus, cockpit, dt, speed);
    this.updateLamps(camera, focus, lampDt);
    this.renderer.shadowMap.needsUpdate = this.fitSun(focus);
    this.updateSpeedEffects(v, camera, dt, speed);
    this.updateShafts(camera);
    if (this.finalEffect) this.finalEffect.seed = (this.frameIndex % 64) / 64;
  }

  /**
   * Fit the cascades of the sun's set in use around `focus`: true when a shadow map has to be drawn with this view.
   * A race whose weather changes keeps its cascades through the rain (taking them away would change every program) and fades
   * their strength to nothing: with no sun to cast them the maps are not drawn at all, and drawn at once when it comes back.
   * (The first draw of the shadow pass makes the maps and builds its depth programs, and nothing sampling a map that does not
   * exist can be drawn at all: so the hidden warm-up frame draws them whatever the sky, and so does any frame that finds a map
   * missing, as after a change of the shadow quality in the middle of a storm.)
   */
  private fitSun(focus: Vector3): boolean {
    const mapsReady = this.sun.mapsReady;
    if (!mapsReady) this.sun.markDirty();
    const sunny = !this.fc || this.warming || !mapsReady || (this.solution?.shadowIntensity ?? 1) >= 0.004;
    if (sunny && !this.shadowsLive) this.sun.markDirty();
    this.shadowsLive = sunny;
    return this.sun.update(focus, this.frameIndex) && sunny;
  }

  private endFrame(t0: number): void {
    const s = this.stats;
    const info = this.renderer.info.render;
    s.drawCalls = info.calls;
    s.triangles = info.triangles;
    const cpu = performance.now() - t0;
    s.cpuMs += (cpu - s.cpuMs) * 0.1;
    this.pollGpu();
    this.lastRenderEnd = performance.now();
  }

  /** Aim the final pass at one view's rectangle of the canvas (the post chain itself works at the size of a view). */
  private aimView(r: Rect): void {
    const y = this.cssH - (r.y + r.h);
    this.renderer.setViewport(r.x, y, r.w, r.h);
    this.renderer.setScissor(r.x, y, r.w, r.h);
    this.renderer.setScissorTest(true);
  }

  /** The whole canvas again. */
  private endViews(): void {
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, this.cssW, this.cssH);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.envToken++;
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.composer.removeAllPasses();
    this.disposePipeline();
    this.aoPass?.dispose();
    this.aoPass = null;
    for (const m of this.warmDepth) m.dispose();
    this.warmDepth = [];
    this.renderPass.dispose();
    this.particlePass.dispose();
    this.compileTarget?.dispose();
    this.mirrors.dispose();
    this.composer.dispose();
    this.sky.dispose();
    this.sun.dispose();
    this.envTarget?.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
  }

  // ───────────────────────────── internals ─────────────────────────────

  private setCamera(camera: PerspectiveCamera): void {
    const changed = camera !== this.camera || camera.near !== this.cameraNear || camera.far !== this.cameraFar;
    if (!changed) return;
    this.camera = camera;
    this.cameraNear = camera.near;
    this.cameraFar = camera.far;
    this.composer.setMainCamera(camera);
    this.particlePass.mainCamera = camera;
    if (this.aoPass) this.aoPass.camera = camera;
    // (a new camera on a whole screen starts the blur over; the two views of a split screen each keep their own history)
    if (!this.splitGeo) this.views[0].havePrevQuat = false;
  }

  private computePixelRatio(): number {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    let pr = Math.min(dpr, 2) * Math.min(Math.max(this.effective.renderScale, 0.5), 1.5);
    const pixels = this.cssW * this.cssH * pr * pr;
    if (pixels > MAX_PIXELS) pr *= Math.sqrt(MAX_PIXELS / pixels);
    return Math.max(MIN_SCALE, pr);
  }

  private updateSize(): void {
    const pr = this.computePixelRatio();
    this.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.cssW, this.cssH, false);
    this.sizeComposer();
    // (the size the scene is drawn at: the canvas, or one view of it)
    const sz = this.splitGeo
      ? new Vector2(Math.floor(this.splitGeo.views[0].w * pr), Math.floor(this.splitGeo.views[0].h * pr))
      : this.renderer.getDrawingBufferSize(new Vector2());
    this.stats.width = sz.x;
    this.stats.height = sz.y;
    this.stats.gpuMemMB = this.estimateMemoryMB();
  }

  /**
   * The post chain works at the size of a view: all of the canvas, or one half of it while the screen is split. (The composer sizes
   * its buffers by resizing the renderer, so the canvas is put back to its own size afterwards.)
   */
  private sizeComposer(): void {
    const g = this.splitGeo;
    if (!g) {
      this.composer.setSize(this.cssW, this.cssH, false);
      return;
    }
    this.composer.setSize(g.views[0].w, g.views[0].h, false);
    this.renderer.setSize(this.cssW, this.cssH, false);
  }

  /** Rough but honest: every full-screen target the pipeline allocates, plus the shadow maps. */
  private estimateMemoryMB(): number {
    const g = this.effective;
    const px = this.stats.width * this.stats.height;
    let bytes = px * (8 * 2 + 4 * 2 + 4); // two RGBA16F buffers, their depth, the stable depth copy
    if (g.ambientOcclusion) bytes += px * 0.25 * 8 * 3 + px * 0.25 * 4;
    if (g.bloom) bytes += px * this.tier.bloomScale * this.tier.bloomScale * 8 * 1.34;
    if (g.antialias === 'smaa') bytes += px * 6;
    if (this.tier.ssr) bytes += px * 8 + px * 0.25 * 8 * 1.34; // wet-road reflections: the reflection buffer + the half-res mip chain
    const cfg = this.sun.config;
    bytes += cfg.count * cfg.mapSize * cfg.mapSize * 4;
    bytes += 6 * this.tier.pmrem * this.tier.pmrem * 8 * 1.6; // PMREM cubeUV target
    bytes += 1.5e6; // sky LUT, noise and particle atlas
    return Math.round((bytes / 1048576) * 10) / 10;
  }

  private applyGraphicsInternal(first: boolean): void {
    // (the player's graphics, trimmed while the screen is split)
    const g = (this.effective = this.splitGeo ? splitGraphics(this.graphics) : this.graphics);
    this.tier = tierFor(g.quality);
    this.sky.setQuality(this.tier.skyHigh);
    this.mirrors.setTier(g.quality);

    this.configureShadows();

    this.updateSize();
    this.rebuildPipeline(first);
    if (this.solution) this.applyExposure();
  }

  /** Is there a sun to cast shadows at some point of this weather (a changing one: at either end of it)? */
  private shadowsWanted(sol: EnvSolution): boolean {
    const fc = this.fc;
    return (fc ? Math.max(fc.dry.shadowIntensity, fc.wet.shadowIntensity) : sol.shadowIntensity) >= SHADOWLESS_BELOW;
  }

  /** Rain can come in this race: the weather changes, or it is wet already. */
  private get wetPossible(): boolean {
    return this.fc !== null || this.env.rain > 0 || this.env.wetness > 0;
  }

  /** Cascades follow the graphics setting, unless the weather has no sun to cast them (rain, storm) at any point of the race. */
  private configureShadows(): void {
    const g = this.effective;
    const shadowless = this.solution !== null && !this.shadowsWanted(this.solution);
    const cfg = shadowless ? SHADOW_OFF : shadowConfigFor(g.shadows, g.quality);
    this.sun.configure(cfg);
    this.stats.cascades = this.sun.cascadeCount;
    // The shadow-receiving programs differ with the cascade count, so this may recompile materials.
    this.renderer.shadowMap.enabled = cfg.count > 0;
  }

  private pipelineSignature(): string {
    const g = this.effective;
    return [g.quality, g.antialias, g.ambientOcclusion ? 1 : 0, g.bloom ? 1 : 0, g.motionBlur ? 1 : 0].join('|');
  }

  private disposePipeline(): void {
    for (const p of this.passes) {
      if (p === this.renderPass || p === this.particlePass || p === this.aoPass) continue;
      p.dispose();
    }
    this.passes = [];
    this.finalEffect = null;
    this.bloomEffect = null;
    this.speedEffect = null;
    this.shaftsPass = null;
    this.shaftsBlend = null;
    this.ssrPass = null;
    this.dropletPass = null;
    this.aaEffect = null;
  }

  private rebuildPipeline(force: boolean): void {
    const key = this.pipelineSignature();
    if (!force && key === this.pipelineKey) return;
    this.pipelineKey = key;
    const g = this.effective;
    const tier = this.tier;
    const composer = this.composer;

    composer.removeAllPasses();
    this.disposePipeline();

    const passes: Pass[] = [this.renderPass];

    // wet-road reflections: right after the scene, before AO and the particles (it reads the road's gloss flag)
    if (tier.ssr) {
      this.ssrPass = new SSRPass(tier.ssr.steps, tier.ssr.stride);
      this.ssrPass.enabled = this.env.wetness > 0.02;
      passes.push(this.ssrPass);
    }

    if (g.ambientOcclusion) {
      if (!this.aoPass) {
        const dummy = new Scene(); // keeps N8AO's transparency auto-detection from allocating extra targets
        const ao = new N8AOPostPass(dummy, this.camera, 64, 64);
        ao.autoDetectTransparency = false;
        ao.configuration.transparencyAware = false;
        ao.scene = this.scene;
        ao.autosetGamma = false;
        ao.configuration.gammaCorrection = false;
        ao.configuration.halfRes = true;
        ao.configuration.aoRadius = 1.3;
        ao.configuration.distanceFalloff = 1.0;
        ao.configuration.intensity = 4.2;
        ao.configuration.color = new Color(0.02, 0.03, 0.05);
        this.aoPass = ao;
      }
      this.aoPass.camera = this.camera;
      this.aoPass.setQualityMode(tier.ao);
      this.aoPass.configuration.halfRes = true;
      passes.push(this.aoPass);
    } else if (this.aoPass) {
      this.aoPass.dispose();
      this.aoPass = null;
    }

    passes.push(this.particlePass);

    // rain on the windscreen / lens: only while the camera is in or on the car and it rains
    this.dropletPass = new DropletPass();
    passes.push(this.dropletPass);

    // Sun shafts: a half-resolution pass of its own (skipped while no low sun is in front of the
    // camera); its texture is added inside effect pass A below
    if (g.bloom && g.quality !== 'low') {
      const sp = new ShaftsPass(g.quality === 'ultra' ? 24 : g.quality === 'high' ? 20 : 16);
      sp.enabled = false;
      this.shaftsPass = sp;
      this.shaftsBlend = new TextureEffect({ texture: sp.target.texture, blendFunction: BlendFunction.ADD });
      this.shaftsBlend.blendMode.opacity.value = 0;
      passes.push(sp);
    }

    // Effect pass A: [speed] [bloom] final
    const effects = [];
    if (g.motionBlur) {
      this.speedEffect = new SpeedEffect(tier.speedTaps);
      effects.push(this.speedEffect);
    }
    if (g.bloom) {
      this.bloomEffect = new BloomEffect({
        blendFunction: BlendFunction.ADD,
        luminanceThreshold: 1.6,
        luminanceSmoothing: 0.4,
        mipmapBlur: true,
        intensity: 0.42,
        radius: 0.72,
        levels: tier.bloomLevels,
        resolutionScale: tier.bloomScale,
      });
      effects.push(this.bloomEffect);
    }
    if (this.shaftsBlend) effects.push(this.shaftsBlend);
    this.finalEffect = new FinalEffect();
    this.mirrors.bindGrade(this.finalEffect);
    effects.push(this.finalEffect);
    const passA = new EffectPass(this.camera, ...effects);
    passA.encodeOutput = false;
    passes.push(passA);

    if (g.antialias !== 'off') {
      let aa: SMAAEffect | FXAAEffect;
      if (g.antialias === 'smaa') {
        aa = new SMAAEffect({ preset: tier.smaa });
      } else {
        aa = new FXAAEffect();
        (aa as FXAAEffect).samples = g.quality === 'low' ? 8 : 12;
      }
      this.aaEffect = aa;
      const passB = new EffectPass(this.camera, aa);
      passB.encodeOutput = false;
      if (aa instanceof SMAAEffect) {
        // The lookup textures decode asynchronously; skip the pass until they exist.
        passB.enabled = false;
        (aa as unknown as { addEventListener(type: string, fn: () => void): void }).addEventListener('load', () => {
          passB.enabled = true;
        });
      }
      passes.push(passB);
    }

    this.instrument(this.renderPass, 'scene+shadows');
    if (this.ssrPass) this.instrument(this.ssrPass, 'ssr');
    if (this.aoPass) this.instrument(this.aoPass, 'ao');
    this.instrument(this.particlePass, 'particles');
    if (this.dropletPass) this.instrument(this.dropletPass, 'droplets');
    if (this.shaftsPass) this.instrument(this.shaftsPass, 'shafts (half-res)');
    this.instrument(passA, 'post');
    if (passes.length > 0 && this.aaEffect) this.instrument(passes[passes.length - 1], 'aa');
    for (const p of passes) composer.addPass(p);
    this.passes = passes;
    composer.setMainCamera(this.camera);
    if (this.aoPass) this.aoPass.camera = this.camera;

    // (a rebuild in the middle of a race: the new wet-weather passes are drawn once on the next frame, see render)
    // (new passes are sized to the canvas: a split screen sizes them to a view)
    if (this.splitGeo) this.sizeComposer();
    this.rewarm = !force && this.wetPossible;
    if (this.solution) this.applyExposure();
  }

  /** Push the solved exposure and grade into the pipeline. */
  private applyExposure(): void {
    const sol = this.solution!;
    const f = this.finalEffect;
    if (f) {
      f.exposure = sol.exposure;
      f.setWarmth(sol.warmth);
      // full strength only after dark (dusk and a daytime storm stay in colour)
      const d = Math.min(1, Math.max(0, (sol.darkness - 0.6) / 0.4));
      f.night = 0.8 * d * d * (3 - 2 * d);
    }
    this.baseExposure = sol.exposure;
    if (this.bloomEffect) {
      const thr = 1.6 / sol.exposure;
      this.bloomEffect.luminanceMaterial.threshold = thr;
      this.bloomEffect.luminanceMaterial.smoothing = thr * 0.5;
      this.bloomEffect.intensity = 0.42;
    }
    particleUniforms.uExposure.value = sol.exposure;
    if (this.shaftsPass) {
      // sun glow window: bright sky near the sun, relative to the display white point
      this.shaftsPass.setWindow(0.9 / sol.exposure, 2.6 / sol.exposure);
      const w = sol.lightColor;
      this.shaftsPass.tint.set(w[0], w[1] * 0.92 + 0.08, w[2] * 0.8 + 0.12);
    }
  }

  private readonly _camPos = new Vector3();

  /** Windscreen drops (cockpit) or lens drops (hood, bumper): the camera is within a few metres of the focus car. */
  /**
   * After dark the street lamps nearest to the focus car light every lit material (shaderPatches, 3.). The track scene
   * publishes the lamp heads in userData.xrLamps; the lookup is repeated every couple of seconds (track changes).
   */
  private updateLamps(camera: PerspectiveCamera, focus: Vector3, dt: number): void {
    const col = xrLampColUniform.value;
    const slots = xrLampUniform.value;
    this.lampScanT -= dt;
    if (this.lampScanT <= 0) {
      this.lampScanT = 2;
      let found: Float32Array | null = null;
      this.scene.traverse((o) => {
        if (!found && o.userData && o.userData.xrLamps) found = o.userData.xrLamps as Float32Array;
      });
      this.lampHeads = found;
    }
    const lamps = this.lampHeads;
    const dark = this.solution ? this.solution.darkness : 0;
    if (!lamps || dark <= 0.45) {
      this.lampLit = false;
      if (col[3] !== 0) {
        col.fill(0);
        for (let j = 0; j < XR_LAMPS; j++) slots[4 * j + 3] = 0;
      }
      return;
    }
    this.lampLit = true;
    // same switch-on and colour as the wet road's own lamp lighting (track/scene/wet.ts)
    const k = Math.min(1, (dark - 0.45) / 0.4);
    col[0] = 7.5 * k;
    col[1] = 6.1 * k;
    col[2] = 4.4 * k;
    col[3] = 1;
    // around the car being filmed (the subject of a TV shot can be far from the camera; in the chase and cockpit
    // views it is right there anyway)
    const cx = focus.x;
    const cz = focus.z;
    const dist = this.lampD2;
    const idx = this.lampIx;
    let n = 0;
    for (let i = 0; i < lamps.length; i += 3) {
      const dx = lamps[i] - cx;
      const dz = lamps[i + 2] - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > 95 * 95 || (n === XR_LAMPS && d2 >= dist[XR_LAMPS - 1])) continue;
      let j = n < XR_LAMPS ? n++ : XR_LAMPS - 1;
      while (j > 0 && dist[j - 1] > d2) {
        dist[j] = dist[j - 1];
        idx[j] = idx[j - 1];
        j--;
      }
      dist[j] = d2;
      idx[j] = i;
    }
    this.lampN = n;
    this.setLampView(camera);
  }

  /**
   * Express the lamps updateLamps picked in `camera`'s view space (the lamp slots are view-space uniforms). The mirror passes
   * call it for their own cameras, and updateLamps again for the main one afterwards.
   */
  private setLampView(camera: PerspectiveCamera): void {
    const lamps = this.lampHeads;
    if (!this.lampLit || !lamps) return;
    const slots = xrLampUniform.value;
    const idx = this.lampIx;
    const v = this.lampV;
    const n = this.lampN;
    for (let j = 0; j < XR_LAMPS; j++) {
      if (j < n) {
        v.set(lamps[idx[j]], lamps[idx[j] + 1], lamps[idx[j] + 2]).applyMatrix4(camera.matrixWorldInverse);
        slots[4 * j] = v.x;
        slots[4 * j + 1] = v.y;
        slots[4 * j + 2] = v.z;
        slots[4 * j + 3] = 46;
      } else slots[4 * j + 3] = 0;
    }
    v.set(0, 1, 0).transformDirection(camera.matrixWorldInverse);
    xrLampUpUniform.value.set([v.x, v.y, v.z]);
  }

  /** `focus` is the car the camera rides on, `cockpitHint` how the rain on the glass is seen (see ViewSpec.cockpit). */
  private updateDroplets(v: ViewState, camera: PerspectiveCamera, focus: Vector3, cockpitHint: boolean | null, dt: number, speed: number): void {
    const p = this.dropletPass;
    if (!p) return;
    const rain = this.env.rain;
    // The glass wets within seconds of the first drops and dries more slowly than the rain stops: so the first drops are drops, and
    // the last ones do not vanish.
    v.glass += (rain - v.glass) * (1 - Math.exp(-dt / (rain > v.glass ? 2.5 : 16)));
    if (rain === 0 && v.glass < 5e-4) v.glass = 0;
    camera.getWorldPosition(this._camPos);
    const d = this._camPos.distanceTo(focus);
    const interior = d < 3.4;
    const live = v.glass > 0.004 && interior;
    // (a warm-up frame runs the pass wherever the camera is, so that its program is built before the rain, wherever rain can
    // come: with no drops to show there it leaves the picture as it is)
    p.enabled = live || (this.warmPasses && this.wetPossible);
    v.dropsOn = p.enabled;
    if (!p.enabled) return;
    // (the pass is shared by the views: its clock is this view's while it is drawn)
    p.setClock(v.dropClock);
    this.updateWiper(v, p.clock, dt);
    p.rain = v.wipeRain;
    p.glass = live ? v.glass : 0;
    p.wiper = v.wiperOn;
    p.speed = speed;
    const cockpit = cockpitHint ?? d < 1.4;
    p.lens = !cockpit;
    v.dropsLens = p.lens;
    p.strength = cockpit ? 1 : 0.7;
    const sol = this.solution;
    if (sol) {
      const k = sol.exposure > 0 ? 1.0 : 1.0;
      p.sky.r = sol.skyAmbient[0] * k;
      p.sky.g = sol.skyAmbient[1] * k;
      p.sky.b = sol.skyAmbient[2] * k;
    }
    p.tick(dt);
    v.dropClock = p.clock;
  }

  /**
   * The driver's wipers: on once the glass is beaded (and off when it is clear), and set for the rain on the glass as it is, in
   * steps. The setting is the rain the blade's schedule and its sound are built on, and a different one is a different period,
   * which would put the blade somewhere else at once and make the sound start over: so a change is made while the blade is parked,
   * in the schedule it leaves and in the one it joins (or after a few seconds, if that does not come).
   */
  private updateWiper(v: ViewState, clock: number, dt: number): void {
    const g = v.glass;
    const on = v.wiperOn ? g >= 0.05 : g > 0.2;
    const rain = on && (!v.wiperOn || Math.abs(g - v.wipeRain) > 0.1) ? g : v.wipeRain;
    if (on === v.wiperOn && rain === v.wipeRain) {
      v.wipeWait = 0;
      return;
    }
    v.wipeWait += dt;
    const s = this.wipeState;
    const parkedNow = !v.wiperOn || wiperStateInto(s, clock, v.wipeRain).stroke === 'parked';
    const parkedNext = !on || wiperStateInto(s, clock, rain).stroke === 'parked';
    if ((parkedNow && parkedNext) || v.wipeWait > 6) {
      v.wiperOn = on;
      v.wipeRain = rain;
      v.wipeWait = 0;
    }
  }

  private readonly _sunWorld = new Vector3();
  private readonly _sunNdc = new Vector3();
  private readonly _camFwd = new Vector3();

  /** Position the sun shafts on screen and switch the pass on only when it can be seen. */
  private updateShafts(camera: PerspectiveCamera): void {
    const pass = this.shaftsPass;
    const blend = this.shaftsBlend;
    const sol = this.solution;
    if (!pass || !blend || !sol) return;
    const sd = sol.sunDir;
    // (the hidden warm-up frame runs the pass wherever the sun can show, now or after a change of weather, so that its two
    // programs are built behind the loading screen and not when the sun first comes into view)
    if (this.warmPasses && !sol.tod.moon && sd[1] > -0.02 && (this.fc || sol.weather.overcast <= 0.83)) {
      pass.strength = 0.001;
      pass.enabled = true;
      blend.blendMode.opacity.value = 0;
      return;
    }
    // (the shafts are faded out by the cloud before they are cut: overcast 0.83 is where `clear` below reaches 0)
    if (sol.tod.moon || sd[1] < -0.02 || sol.weather.overcast > 0.83) {
      pass.enabled = false;
      blend.blendMode.opacity.value = 0;
      return;
    }
    camera.getWorldDirection(this._camFwd);
    const facing = this._camFwd.x * sd[0] + this._camFwd.y * sd[1] + this._camFwd.z * sd[2];
    this._sunWorld.set(sd[0], sd[1], sd[2]).multiplyScalar(5000).add(camera.position);
    this._sunNdc.copy(this._sunWorld).project(camera);
    const off = Math.max(Math.abs(this._sunNdc.x), Math.abs(this._sunNdc.y));
    // strongest for a low sun in front of the lens; fades as it leaves the frame or climbs
    const low = 1 - smoothstep(0.28, 0.62, sd[1]);
    const inFront = smoothstep(0.25, 0.8, facing);
    const onScreen = 1 - smoothstep(1.0, 2.2, off);
    const clear = 1 - sol.weather.overcast * 1.2;
    const k = 0.5 * low * inFront * onScreen * Math.max(0, clear) * Math.max(0.35, sol.weather.sun);
    pass.strength = k;
    pass.sunUv.set(this._sunNdc.x * 0.5 + 0.5, this._sunNdc.y * 0.5 + 0.5);
    pass.setSeed((this.frameIndex % 8) * 0.31);
    const on = k > 0.02;
    pass.enabled = on;
    blend.blendMode.opacity.value = on ? 1 : 0;
  }

  /** Set the environment of a fixed weather, or the first look of a changing one (`sol` is then its blend): everything, once. */
  private applySolution(sol: EnvSolution): void {
    const hadShadows = this.sun.cascadeCount > 0;
    this.solution = sol;
    if (this.effective.shadows !== 'off' && hadShadows !== this.shadowsWanted(sol)) {
      this.configureShadows();
      this.shadowProgramsChanged = true;
    }
    this.applyLook(sol);
    this.sun.setDirection(new Vector3(sol.sunDir[0], sol.sunDir[1], sol.sunDir[2]));
    this.envScale = 1;
    this.captureEnvironment(sol);

    // public state
    const env = this.env;
    env.settings = { ...sol.settings };
    env.sunDirection.set(sol.sunDir[0], sol.sunDir[1], sol.sunDir[2]);
    if (!this.fc) {
      const w = WEATHER_WATER[sol.settings.weather];
      this.wx.sky = sol.deck > 0 ? 1 : 0;
      this.wx.rain = w.rain;
      this.wx.wetness = w.wetness;
    }
    env.rain = this.wx.rain;
    env.wetness = this.wx.wetness;
    // the rain is on the glass from the start (a changing weather starts with the glass as dry or as wet as its first weather)
    for (const v of this.views) {
      v.glass = env.rain;
      v.wiperOn = v.glass > 0.2;
      v.wipeRain = env.rain;
      v.wipeWait = 0;
    }
    const e = sol.exposure;
    const toDisplay = (x: number) => 1 - Math.exp(-x * e * 1.1);
    env.fogColor = '#' + new Color().setRGB(toDisplay(sol.fogColor[0]), toDisplay(sol.fogColor[1]), toDisplay(sol.fogColor[2])).getHexString();
  }

  /** A weather that changes: from now on the look is a blend of the two ends, starting from the end `start` is. */
  private applyForecast(start: EnvSolution, other: EnvSolution): void {
    const startWet = start.deck > 0;
    const dry = startWet ? other : start;
    const wet = startWet ? start : other;
    const mix = cloneSolution(dry);
    const w = WEATHER_WATER[start.settings.weather];
    this.wx.sky = startWet ? 1 : 0;
    this.wx.rain = w.rain;
    this.wx.wetness = w.wetness;
    this.fc = { dry, wet, mix, sky: this.wx.sky, rain: this.wx.rain, cap: { sky: this.wx.sky, at: 0, ambient: 1 } };
    blendInto(mix, dry, wet, this.wx.sky, this.wx.rain);
    this.applySolution(mix);
    this.fc.cap.ambient = lumOf(mix.skyAmbient);
  }

  /**
   * What follows the look of the weather and may change every frame of a changing one: the sky, fog, light, particles and
   * exposure. Cheap (uniforms and colours); the sky LUT, the cascades and the environment map are not touched.
   */
  private applyLook(sol: EnvSolution): void {
    this.solution = sol;
    this.sky.apply(sol);

    // fog
    this.fog.density = sol.fogDensity;
    this.fog.color.setRGB(sol.fogColor[0], sol.fogColor[1], sol.fogColor[2]);
    const fa = xrFogUniform.value;
    const hl = Math.hypot(sol.sunDir[0], sol.sunDir[2]);
    fa[0] = hl > 1e-5 ? sol.sunDir[0] / hl : 1;
    fa[1] = hl > 1e-5 ? sol.sunDir[2] / hl : 0;
    fa[2] = sol.rainFog;
    fa[3] = 1 + sol.deck;
    for (let k = 0; k < FOG_TABLE_SIZE; k++) {
      fa[(k + 1) * 4] = sol.fogTable[k * 3];
      fa[(k + 1) * 4 + 1] = sol.fogTable[k * 3 + 1];
      fa[(k + 1) * 4 + 2] = sol.fogTable[k * 3 + 2];
      fa[(k + 1) * 4 + 3] = 0;
    }
    const dk = (FOG_TABLE_SIZE + 1) * 4;
    fa[dk] = sol.deckHi[0];
    fa[dk + 1] = sol.deckHi[1];
    fa[dk + 2] = sol.deckHi[2];
    fa[dk + 3] = 0;

    // lights
    this.sun.setLight(sol.lightColor, sol.lightIntensity);
    this.sun.setShadowIntensity(sol.shadowIntensity);
    this.hemi.color.setRGB(sol.hemiSky[0], sol.hemiSky[1], sol.hemiSky[2]);
    this.hemi.groundColor.setRGB(sol.hemiGround[0], sol.hemiGround[1], sol.hemiGround[2]);
    this.hemi.intensity = 1;

    // particles share the same lighting
    const pu = particleUniforms;
    pu.uSunDir.value.set(sol.sunDir[0], sol.sunDir[1], sol.sunDir[2]);
    pu.uSunLight.value.set(sol.lightColor[0] * sol.lightIntensity, sol.lightColor[1] * sol.lightIntensity, sol.lightColor[2] * sol.lightIntensity);
    pu.uSkyAmb.value.set(sol.skyAmbient[0], sol.skyAmbient[1], sol.skyAmbient[2]);
    pu.uGroundAmb.value.set(sol.ground[0], sol.ground[1], sol.ground[2]);
    pu.uFogColor.value.set(sol.fogColor[0], sol.fogColor[1], sol.fogColor[2]);
    pu.uFogDensity.value = sol.fogDensity;
    pu.uFogLin.value = sol.rainFog;

    this.applyExposure();

    const env = this.env;
    env.sunIntensity = sol.lightIntensity;
    env.darkness = sol.darkness;
    env.peakDarkness = this.fc ? Math.max(this.fc.dry.darkness, this.fc.wet.darkness) : sol.darkness;
  }

  /** setWeatherState's sky, on screen: blend the two looks and apply the result. Runs at the top of every render(). */
  private updateWeatherLook(dt: number): void {
    this.clock += dt;
    const fc = this.fc;
    if (!fc) return;
    const wx = this.wx;
    if (Math.abs(wx.sky - fc.sky) < 1e-4 && Math.abs(wx.rain - fc.rain) < 1e-4) return;
    fc.sky = wx.sky;
    fc.rain = wx.rain;
    blendInto(fc.mix, fc.dry, fc.wet, wx.sky, wx.rain);
    this.applyLook(fc.mix);
    this.refreshEnvironment(fc);
  }

  /**
   * The environment map is the one thing of the look that is not a few uniforms: capturing it is a cube render and a convolution.
   * So it is captured again when the sky has moved on and at most once a second, and the light it gives is scaled in between by
   * how much the sky's light has changed since the capture (the colour of the reflections steps a little, the brightness does not).
   */
  private refreshEnvironment(fc: NonNullable<RenderSystemImpl['fc']>): void {
    const sol = fc.mix;
    const ambient = lumOf(sol.skyAmbient);
    if (Math.abs(fc.sky - fc.cap.sky) >= 0.012 && this.clock - fc.cap.at >= 1) {
      this.captureEnvironment(sol);
      fc.cap.sky = fc.sky;
      fc.cap.at = this.clock;
      fc.cap.ambient = ambient;
    }
    this.envScale = fc.cap.ambient > 1e-9 ? ambient / fc.cap.ambient : 1;
    this.scene.environmentIntensity = sol.envIntensity * this.envScale;
  }

  private captureEnvironment(sol: EnvSolution): void {
    this.sky.setShowSun(false);
    this.envTarget?.dispose();
    this.envTarget = this.pmrem.fromScene(this.envScene, 0, 0.1, 100, { size: this.tier.pmrem });
    this.sky.setShowSun(true);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = sol.envIntensity;
  }

  private updateSpeedEffects(v: ViewState, camera: PerspectiveCamera, dt: number, speed: number): void {
    const fx = this.speedEffect;
    if (!fx) return;
    const sn = smoothstep(34, 92, Math.max(0, speed));
    fx.radial = sn * sn * 0.62 + sn * 0.1;
    fx.ca = sn * sn * 0.0055;

    // camera rotation blur (shutter ~ 1/90 s): rate of turn -> screen-space smear
    camera.getWorldQuaternion(this.curQuat);
    if (v.havePrevQuat) {
      this.dq.copy(v.prevQuat).invert().multiply(this.curQuat);
      if (this.dq.w < 0) {
        this.dq.x = -this.dq.x;
        this.dq.y = -this.dq.y;
        this.dq.z = -this.dq.z;
        this.dq.w = -this.dq.w;
      }
      const yawRate = (2 * this.dq.y) / dt;
      const pitchRate = (2 * this.dq.x) / dt;
      const vfov = (camera.fov * Math.PI) / 180;
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
      const shutter = 0.011;
      let px = (Math.abs(yawRate) * shutter) / hfov;
      let py = (Math.abs(pitchRate) * shutter) / vfov;
      // ignore hard cuts
      if (Math.abs(this.dq.y) > 0.12 || Math.abs(this.dq.x) > 0.12) {
        px = 0;
        py = 0;
      }
      const k = 1 - Math.exp(-dt / 0.045);
      v.pan.x += (Math.min(px, 0.03) - v.pan.x) * k;
      v.pan.y += (Math.min(py, 0.03) - v.pan.y) * k;
    }
    v.prevQuat.copy(this.curQuat);
    v.havePrevQuat = true;
    fx.pan.set(v.pan.x, v.pan.y);
    fx.seed = (this.frameIndex % 16) * 0.37;
  }

  // ───────────────────────────── GPU timing ─────────────────────────────

  private initGpuTimer(): void {
    try {
      const gl = this.renderer.getContext() as WebGL2RenderingContext;
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as GpuTimer['ext'] | null;
      if (ext) this.gpu = { gl, ext, free: [], pending: [], active: null };
    } catch {
      this.gpu = null;
    }
  }

  /** Wrap a pass so its GPU time can be queried while profiling (no cost otherwise). */
  private instrument(p: Pass, name: string): void {
    const tagged = p as Pass & { __xrName?: string; __xrWrapped?: boolean };
    tagged.__xrName = name;
    if (tagged.__xrWrapped) return;
    tagged.__xrWrapped = true;
    const orig = p.render.bind(p);
    p.render = (...args: Parameters<Pass['render']>) => {
      const t = this.gpu;
      if (!this.profiling || !t || t.pending.length > 24) {
        orig(...args);
        return;
      }
      const q = t.free.pop() ?? t.gl.createQuery();
      if (!q) {
        orig(...args);
        return;
      }
      t.gl.beginQuery(t.ext.TIME_ELAPSED_EXT, q);
      orig(...args);
      t.gl.endQuery(t.ext.TIME_ELAPSED_EXT);
      t.pending.push({ q, name: tagged.__xrName ?? name });
    };
  }

  /** While profiling, start a GPU timer named `name` and hand back the function that stops it (null otherwise). */
  private timeBegin(name: string): (() => void) | null {
    const t = this.gpu;
    if (!this.profiling || !t || t.pending.length > 24) return null;
    const q = t.free.pop() ?? t.gl.createQuery();
    if (!q) return null;
    t.gl.beginQuery(t.ext.TIME_ELAPSED_EXT, q);
    return () => {
      t.gl.endQuery(t.ext.TIME_ELAPSED_EXT);
      t.pending.push({ q, name });
    };
  }

  private beginGpu(): void {
    const t = this.gpu;
    if (!t || this.profiling || t.pending.length > 4) return;
    const q = t.free.pop() ?? t.gl.createQuery();
    if (!q) return;
    t.gl.beginQuery(t.ext.TIME_ELAPSED_EXT, q);
    t.active = q;
  }

  private endGpu(): void {
    const t = this.gpu;
    if (!t || !t.active) return;
    t.gl.endQuery(t.ext.TIME_ELAPSED_EXT);
    t.pending.push({ q: t.active, name: null });
    t.active = null;
  }

  private pollGpu(): void {
    const t = this.gpu;
    if (!t) return;
    const { gl, ext } = t;
    while (t.pending.length > 0) {
      const { q, name } = t.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      t.pending.shift();
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      if (!disjoint) {
        const ms = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
        const s = this.stats;
        if (name === null) {
          s.gpuMsRaw = ms;
          s.gpuMs = s.gpuMs === 0 ? ms : s.gpuMs + (ms - s.gpuMs) * 0.1;
        } else {
          const prev = s.passMs[name];
          s.passMs[name] = prev === undefined ? ms : prev + (ms - prev) * 0.1;
        }
      }
      t.free.push(q);
    }
  }
}

export async function createRenderSystem(canvas: HTMLCanvasElement, g: GraphicsSettings): Promise<XenoRenderSystem> {
  const sys = new RenderSystemImpl(canvas, g);
  await sys.setEnvironment({ timeOfDay: 'golden', weather: 'clear' });
  return sys;
}

export type { Camera };
