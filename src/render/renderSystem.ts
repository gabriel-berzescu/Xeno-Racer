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
} from '../core/contracts';
import { WEATHER_WATER } from '../core/contracts';
import type { RenderSystem } from '../core/systems';
import { FOG_TABLE_SIZE } from './atmosphere';
import { solveEnvironment, type EnvSolution } from './environment';
import { FinalEffect, SpeedEffect } from './effects-post';
import { ParticlePass, particleUniforms, ShaftsPass } from './post';
import { DropletPass } from './wet/droplets';
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

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const yieldToBrowser = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

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
  private readonly prevQuat = new Quaternion();
  private readonly curQuat = new Quaternion();
  private readonly dq = new Quaternion();
  private havePrevQuat = false;
  private readonly pan = new Vector2();
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
    r.outputColorSpace = SRGBColorSpace;
    r.toneMapping = NoToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    r.shadowMap.autoUpdate = false;
    r.info.autoReset = false;
    r.setClearColor(0x000000, 1);

    this.graphics = { ...g };
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
      }
    };
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.canvas = canvas;

    this.cssW = canvas.clientWidth || window.innerWidth || 1280;
    this.cssH = canvas.clientHeight || window.innerHeight || 720;
    this.applyGraphicsInternal(true);
  }

  // ───────────────────────────── public API ─────────────────────────────

  async setEnvironment(e: EnvironmentSettings): Promise<void> {
    const token = ++this.envToken;
    const sol = await solveEnvironment(e, yieldToBrowser);
    if (token !== this.envToken || this.disposed) return;
    this.applySolution(sol);
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
      const pending = [r.compileAsync(this.scene, this.camera), r.compileAsync(this.particleScene, this.camera)];
      r.setRenderTarget(prev);
      await Promise.all(pending);
    } catch {
      // the first frame compiles whatever is still missing
      r.setRenderTarget(prev);
    }
  }

  renderNow(camera: PerspectiveCamera, dt: number, speed: number): void {
    this.lastStart = 0;
    this.render(camera, dt, speed);
  }

  applyGraphics(g: GraphicsSettings): void {
    this.graphics = { ...g };
    this.applyGraphicsInternal(false);
  }

  setFocus(p: Vector3): void {
    this.focus.copy(p);
  }

  resize(width: number, height: number): void {
    this.cssW = Math.max(1, Math.floor(width));
    this.cssH = Math.max(1, Math.floor(height));
    this.updateSize();
  }

  setCloudTime(t: number): void {
    this.sky.setTime(t);
  }

  lightning(strength: number, bearing?: number): void {
    if (!(strength > 0.01)) return;
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
    this.scene.environmentIntensity = sol.envIntensity * (1 + gain);
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

    // frame cap
    const cap = this.graphics.maxFps;
    if (cap > 0 && this.lastStart > 0 && t0 - this.lastStart < 1000 / cap - 1.2) return;

    const interval = this.lastStart > 0 ? t0 - this.lastStart : 16.7;
    this.lastStart = t0;
    const s = this.stats;
    s.frameMs += (Math.min(interval, 250) - s.frameMs) * 0.08;
    s.fps = 1000 / Math.max(s.frameMs, 0.01);

    this.setCamera(camera);
    camera.updateMatrixWorld();
    // never let a bad number from the caller reach the GPU: one NaN pixel is smeared over the whole
    // frame by the bloom blur
    dt = Number.isFinite(dt) && dt > 0 ? Math.min(Math.max(dt, 1 / 500), 0.25) : 1 / 60;
    if (!Number.isFinite(speed)) speed = 0;

    this.sky.update(dt);
    this.updateFlash(dt);
    if (this.ssrPass) this.ssrPass.enabled = this.env.wetness > 0.02;
    this.updateDroplets(camera, dt, speed);
    this.updateLamps(camera, dt);
    this.frameIndex++;
    this.renderer.shadowMap.needsUpdate = this.sun.update(this.focus, this.frameIndex);
    this.updateSpeedEffects(camera, dt, speed);
    this.updateShafts(camera);
    if (this.finalEffect) this.finalEffect.seed = (this.frameIndex % 64) / 64;

    this.renderer.info.reset();
    this.beginGpu();
    this.composer.render(dt);
    this.endGpu();

    const info = this.renderer.info.render;
    s.drawCalls = info.calls;
    s.triangles = info.triangles;
    const cpu = performance.now() - t0;
    s.cpuMs += (cpu - s.cpuMs) * 0.1;
    this.pollGpu();
    this.lastRenderEnd = performance.now();
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
    this.renderPass.dispose();
    this.particlePass.dispose();
    this.compileTarget?.dispose();
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
    this.havePrevQuat = false;
  }

  private computePixelRatio(): number {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    let pr = Math.min(dpr, 2) * Math.min(Math.max(this.graphics.renderScale, 0.5), 1.5);
    const pixels = this.cssW * this.cssH * pr * pr;
    if (pixels > MAX_PIXELS) pr *= Math.sqrt(MAX_PIXELS / pixels);
    return Math.max(MIN_SCALE, pr);
  }

  private updateSize(): void {
    const pr = this.computePixelRatio();
    this.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.cssW, this.cssH, false);
    this.composer.setSize(this.cssW, this.cssH, false);
    const sz = this.renderer.getDrawingBufferSize(new Vector2());
    this.stats.width = sz.x;
    this.stats.height = sz.y;
    this.stats.gpuMemMB = this.estimateMemoryMB();
  }

  /** Rough but honest: every full-screen target the pipeline allocates, plus the shadow maps. */
  private estimateMemoryMB(): number {
    const g = this.graphics;
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
    const g = this.graphics;
    this.tier = tierFor(g.quality);
    this.sky.setQuality(this.tier.skyHigh);

    this.configureShadows();

    this.updateSize();
    this.rebuildPipeline(first);
    if (this.solution) this.applyExposure();
  }

  /** Cascades follow the graphics setting, unless the weather has no sun to cast them (rain, storm). */
  private configureShadows(): void {
    const g = this.graphics;
    const shadowless = this.solution !== null && this.solution.shadowIntensity < SHADOWLESS_BELOW;
    const cfg = shadowless ? SHADOW_OFF : shadowConfigFor(g.shadows, g.quality);
    this.sun.configure(cfg);
    this.stats.cascades = this.sun.cascadeCount;
    // The shadow-receiving programs differ with the cascade count, so this may recompile materials.
    this.renderer.shadowMap.enabled = cfg.count > 0;
  }

  private pipelineSignature(): string {
    const g = this.graphics;
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
    const g = this.graphics;
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
  private updateLamps(camera: PerspectiveCamera, dt: number): void {
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
      if (col.w !== 0) {
        col.set(0, 0, 0, 0);
        for (const sl of slots) sl.w = 0;
      }
      return;
    }
    // same switch-on and colour as the wet road's own lamp lighting (track/scene/wet.ts)
    const k = Math.min(1, (dark - 0.45) / 0.4);
    col.set(7.5 * k, 6.1 * k, 4.4 * k, 1);
    // around the car being filmed (the subject of a TV shot can be far from the camera; in the chase and cockpit
    // views it is right there anyway)
    const cx = this.focus.x;
    const cz = this.focus.z;
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
    const v = this.lampV;
    for (let j = 0; j < XR_LAMPS; j++) {
      if (j < n) {
        v.set(lamps[idx[j]], lamps[idx[j] + 1], lamps[idx[j] + 2]).applyMatrix4(camera.matrixWorldInverse);
        slots[j].set(v.x, v.y, v.z, 46);
      } else slots[j].w = 0;
    }
    xrLampUpUniform.value.set(0, 1, 0).transformDirection(camera.matrixWorldInverse);
  }

  private updateDroplets(camera: PerspectiveCamera, dt: number, speed: number): void {
    const p = this.dropletPass;
    if (!p) return;
    const rain = this.env.rain;
    camera.getWorldPosition(this._camPos);
    const d = this._camPos.distanceTo(this.focus);
    const interior = d < 3.4;
    p.enabled = rain > 0.02 && interior;
    if (!p.enabled) return;
    p.rain = rain;
    p.speed = speed;
    p.lens = d >= 1.4;
    p.strength = d < 1.4 ? 1 : 0.7;
    const sol = this.solution;
    if (sol) {
      const k = sol.exposure > 0 ? 1.0 : 1.0;
      p.sky.r = sol.skyAmbient[0] * k;
      p.sky.g = sol.skyAmbient[1] * k;
      p.sky.b = sol.skyAmbient[2] * k;
    }
    p.tick(dt);
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
    if (sol.tod.moon || sd[1] < -0.02 || sol.weather.overcast > 0.6) {
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

  private applySolution(sol: EnvSolution): void {
    const hadShadows = this.sun.cascadeCount > 0;
    this.solution = sol;
    this.sky.apply(sol);
    if (this.graphics.shadows !== 'off' && hadShadows !== sol.shadowIntensity >= SHADOWLESS_BELOW) {
      this.configureShadows();
      this.shadowProgramsChanged = true;
    }

    // fog
    this.fog.density = sol.fogDensity;
    this.fog.color.setRGB(sol.fogColor[0], sol.fogColor[1], sol.fogColor[2]);
    const fa = xrFogUniform.value;
    const hl = Math.hypot(sol.sunDir[0], sol.sunDir[2]);
    fa[0] = hl > 1e-5 ? sol.sunDir[0] / hl : 1;
    fa[1] = hl > 1e-5 ? sol.sunDir[2] / hl : 0;
    fa[2] = sol.rainFog;
    fa[3] = sol.deck > 0 ? 2 : 1;
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
    this.sun.setDirection(new Vector3(sol.sunDir[0], sol.sunDir[1], sol.sunDir[2]));
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

    this.captureEnvironment(sol);
    this.applyExposure();

    // public state
    const env = this.env;
    env.settings = { ...sol.settings };
    env.sunDirection.set(sol.sunDir[0], sol.sunDir[1], sol.sunDir[2]);
    env.sunIntensity = sol.lightIntensity;
    env.darkness = sol.darkness;
    env.rain = WEATHER_WATER[sol.settings.weather].rain;
    env.wetness = WEATHER_WATER[sol.settings.weather].wetness;
    const e = sol.exposure;
    const toDisplay = (x: number) => 1 - Math.exp(-x * e * 1.1);
    env.fogColor = '#' + new Color().setRGB(toDisplay(sol.fogColor[0]), toDisplay(sol.fogColor[1]), toDisplay(sol.fogColor[2])).getHexString();
  }

  private captureEnvironment(sol: EnvSolution): void {
    this.sky.setShowSun(false);
    this.envTarget?.dispose();
    this.envTarget = this.pmrem.fromScene(this.envScene, 0, 0.1, 100, { size: this.tier.pmrem });
    this.sky.setShowSun(true);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = sol.envIntensity;
  }

  private updateSpeedEffects(camera: PerspectiveCamera, dt: number, speed: number): void {
    const fx = this.speedEffect;
    if (!fx) return;
    const sn = smoothstep(34, 92, Math.max(0, speed));
    fx.radial = sn * sn * 0.62 + sn * 0.1;
    fx.ca = sn * sn * 0.0055;

    // camera rotation blur (shutter ~ 1/90 s): rate of turn -> screen-space smear
    camera.getWorldQuaternion(this.curQuat);
    if (this.havePrevQuat) {
      this.dq.copy(this.prevQuat).invert().multiply(this.curQuat);
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
      this.pan.x += (Math.min(px, 0.03) - this.pan.x) * k;
      this.pan.y += (Math.min(py, 0.03) - this.pan.y) * k;
    }
    this.prevQuat.copy(this.curQuat);
    this.havePrevQuat = true;
    fx.pan.set(this.pan.x, this.pan.y);
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
