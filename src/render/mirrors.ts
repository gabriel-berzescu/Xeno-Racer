/**
 * Rear-view mirrors (owner: render): the live glass of the cockpit view and the HUD mirror strip of the hood and bumper
 * views.
 *
 * Real mirrors. Each piece of glass on the player's car (CarMirrors, src/carvis/mirrors.ts) gets a small render target
 * and a camera at the viewer's eye mirrored in the glass plane, looking out through the glass as through a window
 * (mirrorMath.ts): what it renders is exactly what a mirror would show, it moves with the head, and it holds the glass
 * and nothing else. The target is HDR linear like the main buffer, and the glass shader (mirrorGlass.ts) is an ordinary
 * object of the scene: it shows that radiance, so the post chain grades the mirror like the rest of the picture. A mirror
 * is drawn only while its glass is in front of the camera and facing it, and at a rate and resolution that follow the
 * quality tier (see mirrorTier). The prototype has no rear-view mirror; its dash display shows the rear camera.
 *
 * Virtual mirror. In the hood and bumper views the rear camera (the car's tail, looking back) is drawn as a strip at the
 * top centre of the canvas after the post chain, graded by the same code as the final effect.
 *
 * What a mirror render needs that the main one does not. It runs after the composer, so the frame's shadow maps are done
 * and no mirror draws them again; the glass in the next picture shows it, a frame behind, which a mirror does not show.
 * The mirror glass is hidden while any mirror draws (a mirror never sees another's, and a target is never read while it
 * is written), and so are the car's seats and driver (a mirror looks back from in front of them); the player's own car is
 * drawn with its coarse body and the other cars switch to theirs sooner. The street lamps' view-space slots follow the
 * camera, and the particle scene (spray, smoke, rain) is drawn in against the mirror's own depth. Every program a mirror
 * uses is one the scene already has (any non-canvas render target selects the same variants) plus the two glass shaders and
 * the strip, which precompile() builds with the rest.
 *
 * What it costs: a mirror pass draws the scene again, and the terrain behind the car is most of it. The tiers trade rate
 * and resolution for that; a pass skips the scene graph's matrix update (the picture's own render just did it).
 */
import {
  Color,
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NormalBlending,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  RedFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Uniform,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Object3D,
  type Texture,
  type WebGLRenderer,
} from 'three';
import type { CarMirrorGlass, CarMirrors, MirrorLamps, QualityLevel } from '../core/contracts';
import type { FinalEffect } from './effects-post';
import { glassFragment, glassVertex, stripFragment, stripVertex } from './mirrorGlass';
import {
  applyWindowView,
  drawsOnFrame,
  makeQuad,
  makeWindowView,
  quadFromMatrix,
  quadPixelSize,
  quadSeenBy,
  sizeStillFits,
  targetSize,
  windowView,
  type MirrorQuad,
} from './mirrorMath';
import { particleUniforms } from './post';
import { LampFlares } from './mirrorFlares';

export type MirrorMode = 'off' | 'real' | 'virtual';

/** What the game wants this frame (the game calls it every frame, like setCockpitView). */
export interface MirrorFrame {
  mode: MirrorMode;
  /** The player's car's mirrors (CarVisual.mirrors). */
  rig: CarMirrors | null;
  /** The HUD is up (not paused, no clean photo mode, the race running): the strip may show. */
  hud: boolean;
  /** The lit headlamps of the cars that face the player, for the glare in the glass at night (empty by day). */
  lamps?: MirrorLamps | null;
}

export interface MirrorTier {
  /** Redraw every `rate`-th frame (the interior mirror, the display) and every `doorRate`-th (the door mirrors, the strip). The two
   *  groups fall on different frames, so on a half rate no frame draws more than one of them. */
  rate: number;
  doorRate: number;
  /** Render-target size relative to the glass's size on screen. */
  scale: number;
  /** Draw the particle scene (spray, smoke, rain) into the mirrors. */
  particles: boolean;
  /** Largest render target edge (px). */
  maxPx: number;
}

export function mirrorTier(q: QualityLevel): MirrorTier {
  switch (q) {
    case 'low':
      return { rate: 4, doorRate: 4, scale: 0.55, particles: false, maxPx: 384 };
    case 'medium':
      return { rate: 3, doorRate: 3, scale: 0.75, particles: true, maxPx: 512 };
    case 'high':
      return { rate: 2, doorRate: 2, scale: 0.9, particles: true, maxPx: 640 };
    default:
      return { rate: 1, doorRate: 1, scale: 1.1, particles: true, maxPx: 768 };
  }
}

/** Horizontal field of view of the rear camera (deg) for the HUD strip and the dash display. */
const STRIP_HFOV = 60;
const SCREEN_HFOV = 88;
/** HUD strip: width as a share of the screen, its limits (CSS px), aspect, top margin. */
const STRIP = { share: 0.3, min: 340, max: 720, aspect: 3.2, top: 14 };
const FAR = 6000;
/**
 * Spray in a mirror. A mirror looks back along the plume of its own car and the pack's, through the whole length of it: left
 * as it is, the water thrown by the rear wheels is a solid white wall that hides every car behind. So the puffs fade in
 * later (view depth from the mirror's eye, m), are thinner and a little dimmer: the plume still veils the road and the
 * cars in it, which show through as shapes and lamps. (Exported so the numbers can be tuned from a console.)
 */
export const SPRAY = { nearFrom: 7, nearTo: 18, alpha: 0.5, light: 0.8 };
/** Glass at least this convex is a door mirror (the redraw rate of door mirrors is tiered separately). */
const DOOR_CONVEX = 1.2;

/** A render target with a depth texture, plus (for the particle pass) a second depth texture it can read while drawing. */
class MirrorTarget {
  readonly color: WebGLRenderTarget;
  private copy: WebGLRenderTarget | null = null;
  w: number;
  h: number;

  constructor(
    private readonly renderer: WebGLRenderer,
    w: number,
    h: number,
    readonly name: string,
  ) {
    this.w = w;
    this.h = h;
    this.color = new WebGLRenderTarget(w, h, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture: new DepthTexture(w, h),
      generateMipmaps: false,
    });
    this.color.texture.name = 'xr.mirror.' + name;
  }

  get texture(): Texture {
    return this.color.texture;
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.color.setSize(w, h);
    this.copy?.setSize(w, h);
  }

  /** A stable copy of the depth just drawn: the particle shaders read it while drawing into the colour target. */
  depthCopy(): Texture {
    if (!this.copy) {
      this.copy = new WebGLRenderTarget(this.w, this.h, {
        type: UnsignedByteType,
        format: RedFormat,
        depthBuffer: true,
        stencilBuffer: false,
        depthTexture: new DepthTexture(this.w, this.h),
        generateMipmaps: false,
      });
      this.copy.texture.name = 'xr.mirror.depth.' + this.name;
    }
    // (a resize deallocates the target; initRenderTarget is a no-op while it exists and the copy needs it to exist)
    this.renderer.initRenderTarget(this.copy);
    this.renderer.copyTextureToTexture(this.color.depthTexture!, this.copy.depthTexture!);
    return this.copy.depthTexture!;
  }

  dispose(): void {
    this.color.depthTexture?.dispose();
    this.color.dispose();
    this.copy?.depthTexture?.dispose();
    this.copy?.dispose();
  }
}

interface GlassSlot {
  glass: CarMirrorGlass;
  material: ShaderMaterial;
  /** The material the car gave the glass, put back when the mirrors are detached. */
  placeholder: Mesh['material'];
  quad: MirrorQuad;
  cam: PerspectiveCamera;
  target: MirrorTarget | null;
  /** Its place in the rig (left, right, interior: the order the car lists them). */
  slot: number;
  /** Frames since the screen footprint was last measured. */
  measured: number;
}

const _eye = new Vector3();
const _warmEye = new Vector3();
const _sky = new Vector3();
const _ground = new Vector3();
const _sun = new Vector3();
const _size = { w: 0, h: 0 };
const _want = { w: 0, h: 0 };
const _wv = makeWindowView();

export interface MirrorHooks {
  /** Set everything that depends on the camera a render is about to use (the street lamps' view-space slots). */
  setView(camera: PerspectiveCamera): void;
  /** While profiling: start a GPU timer for a pass and get the function that stops it (null when not profiling). */
  time?(name: string): (() => void) | null;
}

/**
 * The cars switch to their cheap level at this fraction of the usual distance in the mirrors (a LOD divides its distance
 * by the camera's zoom, which the mirror cameras never use for their own projection): a car seen in a few hundred pixels
 * does not need 70k triangles.
 */
const LOD_ZOOM = 0.3;
/**
 * The interior mirror shows the traffic small, a few cars of it a few metres off: its cars take the cheap level from about
 * 7 m on (the door mirrors and the rear camera show a car alongside or close behind large, and keep the detailed one longer).
 */
const LOD_ZOOM_INTERIOR = 0.12;

export class MirrorSystem {
  private frame: MirrorFrame = { mode: 'off', rig: null, hud: false };
  private tier: MirrorTier = mirrorTier('high');
  private rig: CarMirrors | null = null;
  private slots: GlassSlot[] = [];
  private rear: MirrorTarget | null = null;
  private readonly rearCam = new PerspectiveCamera(60, 3, 0.25, FAR);
  private readonly hiddenGlass: Array<{ mesh: Object3D; visible: boolean }> = [];
  /** Per pass: draw calls and triangles of the last frame it ran, and a running mean of the time the CPU spent issuing it (debug: what a mirror costs). */
  readonly passInfo: Record<string, { calls: number; tris: number; cpuMs: number }> = {};

  // the HUD strip
  private readonly hudScene = new Scene();
  private readonly hudCam = new PerspectiveCamera();
  private readonly hudMat: ShaderMaterial;
  private readonly hudMesh: Mesh;
  private hudAlpha = 0;
  private hudWant = false;
  private readonly hudRect = { x: 0, y: 0, w: 0, h: 0 };

  private readonly flares = new LampFlares();

  private skid: Object3D | null | undefined;
  private frameIndex = 0;
  private rain = 0;
  private time = 0;
  private warmup = false;
  private disposed = false;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly particleScene: Scene,
    private readonly hooks: MirrorHooks,
  ) {
    this.hudMat = new ShaderMaterial({
      name: 'xr.mirror.strip',
      uniforms: {
        uMap: new Uniform<Texture | null>(null),
        uSize: new Uniform(new Vector2(1, 1)),
        uAlpha: new Uniform(0),
        uFlip: new Uniform(1),
        uPx: new Uniform(1),
        // the final effect's grade, shared by reference once bindGrade() has it
        exposure: new Uniform(1),
        tmMode: new Uniform(0),
        saturation: new Uniform(1.12),
        lookPower: new Uniform(1.22),
        lookSat: new Uniform(1.32),
        contrast: new Uniform(0.12),
        tint: new Uniform(new Vector3(1, 1, 1)),
        night: new Uniform(0),
      },
      vertexShader: stripVertex,
      fragmentShader: stripFragment,
      transparent: true,
      blending: NormalBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.hudMesh = new Mesh(new PlaneGeometry(2, 2), this.hudMat);
    this.hudMesh.frustumCulled = false;
    this.hudScene.add(this.hudMesh);
  }

  // ───────────────────────────── configuration ─────────────────────────────

  setTier(q: QualityLevel): void {
    this.tier = mirrorTier(q);
    // the targets are sized for the tier; they are rebuilt at the next draw
    for (const g of this.slots) this.dropTarget(g);
    this.rear?.dispose();
    this.rear = null;
  }

  /** What to do this frame. Cheap: the glass is swapped in only when the car's rig is new. */
  setFrame(f: MirrorFrame): void {
    this.frame = f;
    if (f.rig !== this.rig) this.attach(f.rig);
    // the car hides its live glass while no mirror draws into it (the setting is off, or this is not the cockpit view)
    if (this.rig) this.rig.live = f.mode === 'real';
    this.hudWant = f.mode === 'virtual' && f.hud && f.rig !== null;
  }

  /** Share the final effect's exposure, tone mapping and grade with the HUD strip (the effect is rebuilt with the pipeline). */
  bindGrade(fe: FinalEffect | null): void {
    if (!fe) return;
    const u = this.hudMat.uniforms;
    for (const k of ['exposure', 'tmMode', 'saturation', 'lookPower', 'lookSat', 'contrast', 'tint', 'night']) {
      const shared = fe.uniforms.get(k);
      if (shared) u[k] = shared;
    }
  }

  setWeather(rain: number): void {
    this.rain = rain;
  }

  /** The HUD strip is on screen (or fading in): the DOM HUD steps its toasts aside. */
  get stripShown(): boolean {
    return this.hudWant && this.hudAlpha > 0.05;
  }

  /** The scene of the strip, for precompile(): its shader must be built behind the loading screen like the rest. */
  get compileScene(): { scene: Scene; camera: PerspectiveCamera } {
    return { scene: this.hudScene, camera: this.hudCam };
  }

  /** The scene of the lamp glare sprites, for precompile() (built against the same target as the scene and the particles). */
  get flareScene(): Scene {
    return this.flares.compileScene;
  }

  /** Ask for every mirror to draw once, whatever the view (the hidden warm-up frame compiles and allocates everything). */
  forceNext(): void {
    this.warmup = true;
  }

  private attach(rig: CarMirrors | null): void {
    this.detach();
    this.rig = rig;
    if (!rig) return;
    let k = 0;
    for (const g of rig.glass) {
      const screen = g.kind === 'camera';
      const mat = new ShaderMaterial({
        name: screen ? 'xr.mirror.screen' : 'xr.mirror.glass',
        defines: screen ? { XR_SCREEN: '' } : {},
        uniforms: {
          uMap: new Uniform<Texture | null>(null),
          uTint: new Uniform(screen ? new Color(0.95, 0.97, 1.0) : g.convex >= DOOR_CONVEX ? new Color(0.78, 0.82, 0.86) : new Color(0.88, 0.9, 0.93)),
          uRain: new Uniform(0),
          uTime: new Uniform(0),
          uSize: new Uniform(new Vector2(g.halfW * 2, g.halfH * 2)),
        },
        vertexShader: glassVertex,
        fragmentShader: glassFragment,
        toneMapped: false,
        fog: false,
      });
      const mesh = g.mesh as Mesh;
      const placeholder = mesh.material;
      mesh.material = mat;
      const cam = new PerspectiveCamera(60, 1, 0.1, FAR);
      cam.zoom = g.kind !== 'camera' && g.convex < DOOR_CONVEX ? LOD_ZOOM_INTERIOR : LOD_ZOOM;
      this.slots.push({ glass: g, material: mat, placeholder, quad: makeQuad(), cam, target: null, slot: k++, measured: 999 });
    }
  }

  private detach(): void {
    this.skid = undefined;
    for (const g of this.slots) {
      this.dropTarget(g);
      (g.glass.mesh as Mesh).material = g.placeholder;
      g.material.dispose();
    }
    this.slots = [];
    this.rig = null;
  }

  private dropTarget(g: GlassSlot): void {
    g.target?.dispose();
    g.target = null;
    g.measured = 999;
  }

  // ───────────────────────────── per frame ─────────────────────────────

  /**
   * Draw this frame's mirror views. Call after the composer has rendered: the frame's shadow maps are done by then and no
   * mirror pass draws them again, and the glass in the next picture reads what is drawn here. `height` is the drawing
   * buffer's height.
   */
  render(main: PerspectiveCamera, dt: number, height: number, pixelRatio: number, cssW: number, cssH: number): void {
    if (this.disposed) return;
    this.frameIndex++;
    this.time += dt;
    // the strip fades
    const aim = this.hudWant ? 1 : 0;
    this.hudAlpha += (aim - this.hudAlpha) * (1 - Math.exp(-dt / 0.16));
    if (Math.abs(this.hudAlpha - aim) < 0.004) this.hudAlpha = aim;

    const warm = this.warmup;
    this.warmup = false;
    const rig = this.rig;
    if (!rig) return;
    const mode = this.frame.mode;
    if (mode === 'off' && !warm) return;
    const lamps = this.frame.lamps;
    this.flares.set(lamps ? lamps.data : null, lamps ? lamps.n : 0);

    // The picture's own render call has just updated every matrix in the scene (a full walk over thousands of nodes, about a
    // millisecond), and nothing has moved since: the mirror passes skip it.
    const scene = this.scene;
    scene.matrixWorldAutoUpdate = false;
    this.hideGlass();
    let drawn = false;
    if (mode === 'real' || warm) drawn = this.renderGlass(main, height, warm) || drawn;
    if (mode === 'virtual' || warm) drawn = this.renderStrip(rig, pixelRatio, cssW, cssH, warm) || drawn;
    this.showGlass();
    scene.matrixWorldAutoUpdate = true;
    if (drawn) {
      this.renderer.setRenderTarget(null);
      this.hooks.setView(main);
    }
    // rain and the clock for the glass shaders
    for (const g of this.slots) {
      const u = g.material.uniforms;
      u.uRain.value = this.rain;
      u.uTime.value = this.time;
    }
  }

  /**
   * What a mirror pass leaves out or swaps: the glass (a mirror never sees another, and a target is never read while it
   * is written), the car's interior, and the player's full-detail body for its coarse one. The glass entries come first,
   * in slot order, so renderGlass can read the car's own state back from them.
   */
  private hideGlass(): void {
    const list = this.hiddenGlass;
    list.length = 0;
    const put = (o: Object3D, visible: boolean): void => {
      list.push({ mesh: o, visible: o.visible });
      o.visible = visible;
    };
    for (const g of this.slots) put(g.glass.mesh, false);
    // (tyre marks are a dynamic mesh of tens of thousands of triangles: too much for a few pixels of road)
    const skid = (this.skid ??= this.scene.getObjectByName('xr.fx.skidmarks') ?? null);
    if (skid) put(skid, false);
    const rig = this.rig;
    if (!rig) return;
    for (const o of rig.hide) put(o, false);
    for (const o of rig.lowDetail.hide) put(o, false);
    for (const o of rig.lowDetail.show) put(o, true);
  }

  private showGlass(): void {
    // (in reverse: an object listed twice ends up as it began)
    for (let i = this.hiddenGlass.length - 1; i >= 0; i--) this.hiddenGlass[i].mesh.visible = this.hiddenGlass[i].visible;
    this.hiddenGlass.length = 0;
  }

  private renderGlass(main: PerspectiveCamera, height: number, force: boolean): boolean {
    let any = false;
    let rearSlot: GlassSlot | null = null;
    main.getWorldPosition(_eye);
    for (let i = 0; i < this.slots.length; i++) {
      const g = this.slots[i];
      const e = g.glass;
      // (hideGlass cleared `visible` for the draw: the car's own state is in hiddenGlass)
      if (!this.hiddenGlass[i].visible && !force) continue;
      quadFromMatrix(e.mesh.matrixWorld, e.halfW, e.halfH, g.quad);
      let eye = _eye;
      if (force) {
        // the warm-up frame draws every mirror from a viewer 0.7 m in front of it, whatever the camera happens to see
        eye = _warmEye.copy(g.quad.center).addScaledVector(g.quad.normal, 0.7);
      } else if (!quadSeenBy(main, g.quad)) continue;
      if (e.kind === 'camera') {
        rearSlot = g;
        continue;
      }
      // render target size from the glass's footprint on screen, re-measured about once a second
      if (!g.target || g.measured > 60) {
        g.measured = 0;
        quadPixelSize(main, g.quad, height, _size);
        targetSize(_size.w, _size.h, this.tier.scale, 48, this.tier.maxPx, _want);
        if (!g.target) g.target = new MirrorTarget(this.renderer, _want.w, _want.h, 'g' + i);
        else if (!sizeStillFits(g.target.w, _want.w) || !sizeStillFits(g.target.h, _want.h)) g.target.resize(_want.w, _want.h);
        // a warm-up frame measured a glass nobody was looking at: measure again on the first real frame
        if (force) g.measured = 999;
      }
      g.measured++;
      const door = e.convex >= DOOR_CONVEX;
      if (!force && !drawsOnFrame(this.frameIndex, door ? this.tier.doorRate : this.tier.rate, door ? 1 : 0)) continue;
      if (!windowView(eye, g.quad, e.convex, FAR, _wv, e.convexY)) continue;
      applyWindowView(g.cam, _wv);
      this.draw(g.target!, g.cam);
      (g.material.uniforms.uMap as Uniform<Texture | null>).value = g.target!.texture;
      any = true;
    }
    if (rearSlot) any = this.renderRearFor(rearSlot, force) || any;
    return any;
  }

  /** The dash display: the rear camera, in the display's own aspect. */
  private renderRearFor(g: GlassSlot, force: boolean): boolean {
    const e = g.glass;
    if (!force && !drawsOnFrame(this.frameIndex, this.tier.rate, 0)) {
      (g.material.uniforms.uMap as Uniform<Texture | null>).value = this.rear?.texture ?? null;
      return false;
    }
    const w = Math.min(this.tier.maxPx, Math.max(96, Math.round((e.halfW * 2 * 3000 * this.tier.scale) / 8) * 8));
    const h = Math.max(48, Math.round((w * e.halfH) / e.halfW / 8) * 8);
    this.ensureRear(w, h);
    this.poseRear(w / h, SCREEN_HFOV);
    this.draw(this.rear!, this.rearCam);
    (g.material.uniforms.uMap as Uniform<Texture | null>).value = this.rear!.texture;
    return true;
  }

  private renderStrip(rig: CarMirrors, pixelRatio: number, cssW: number, cssH: number, force: boolean): boolean {
    if (!force && this.hudAlpha <= 0.004 && !this.hudWant) return false;
    const w = Math.min(STRIP.max, Math.max(STRIP.min, cssW * STRIP.share));
    const h = w / STRIP.aspect;
    this.hudRect.w = w;
    this.hudRect.h = h;
    this.hudRect.x = (cssW - w) / 2;
    this.hudRect.y = cssH - STRIP.top - h;
    if (!force && !drawsOnFrame(this.frameIndex, this.tier.doorRate, 0)) return false;
    const px = Math.min(this.tier.maxPx * 1.6, Math.round((w * pixelRatio * this.tier.scale) / 8) * 8);
    const py = Math.max(48, Math.round((px / STRIP.aspect) / 8) * 8);
    this.ensureRear(px, py);
    this.poseRear(px / py, STRIP_HFOV, rig);
    this.draw(this.rear!, this.rearCam);
    this.hudMat.uniforms.uMap.value = this.rear!.texture;
    return true;
  }

  private ensureRear(w: number, h: number): void {
    if (!this.rear) this.rear = new MirrorTarget(this.renderer, w, h, 'rear');
    else if (this.rear.w !== w || this.rear.h !== h) this.rear.resize(w, h);
  }

  private poseRear(aspect: number, hfov: number, rig: CarMirrors | null = this.rig): void {
    const cam = this.rearCam;
    const a = rig?.rearCamera;
    if (a) {
      a.updateWorldMatrix(true, false);
      a.matrixWorld.decompose(cam.position, cam.quaternion, cam.scale);
      cam.scale.set(1, 1, 1);
    }
    cam.aspect = aspect;
    cam.fov = (2 * Math.atan(Math.tan((hfov * Math.PI) / 360) / aspect) * 180) / Math.PI;
    cam.near = 0.3;
    cam.far = FAR;
    cam.zoom = 1;
    cam.updateProjectionMatrix();
    cam.zoom = LOD_ZOOM; // after the projection: only the cars' level of detail reads it
    cam.updateMatrixWorld(true);
  }

  /** One mirror pass: the scene, then the particles, into `t`. */
  private draw(t: MirrorTarget, cam: PerspectiveCamera): void {
    const r = this.renderer;
    const end = this.hooks.time?.('mirror ' + t.name) ?? null;
    const cpu0 = performance.now();
    const info = r.info.render;
    const calls0 = info.calls;
    const tris0 = info.triangles;
    this.hooks.setView(cam);
    r.setRenderTarget(t.color);
    r.clear(true, true, false);
    r.render(this.scene, cam);
    if (this.flares.n > 0) {
      // the lamps' glare, over the picture and under the spray (which veils it)
      this.flares.fit(t.w, t.h);
      r.setRenderTarget(t.color);
      r.render(this.flares.scene, cam);
    }
    if (this.tier.particles && this.particleScene.children.length > 0) {
      const depth = t.depthCopy();
      const prevDepth = particleUniforms.uDepth.value;
      const prevHas = particleUniforms.uHasDepth.value;
      const prevW = particleUniforms.uResolution.value.x;
      const prevH = particleUniforms.uResolution.value.y;
      const nearFade = particleUniforms.uNearFade.value;
      const prevNearX = nearFade.x;
      const prevNearY = nearFade.y;
      const prevAlpha = particleUniforms.uAlphaMul.value;
      nearFade.set(SPRAY.nearFrom, SPRAY.nearTo);
      particleUniforms.uAlphaMul.value = SPRAY.alpha;
      _sky.copy(particleUniforms.uSkyAmb.value);
      _ground.copy(particleUniforms.uGroundAmb.value);
      _sun.copy(particleUniforms.uSunLight.value);
      particleUniforms.uSkyAmb.value.multiplyScalar(SPRAY.light);
      particleUniforms.uGroundAmb.value.multiplyScalar(SPRAY.light);
      particleUniforms.uSunLight.value.multiplyScalar(SPRAY.light);
      particleUniforms.uDepth.value = depth;
      particleUniforms.uHasDepth.value = 1;
      particleUniforms.uResolution.value.set(t.w, t.h);
      particleUniforms.uNearFar.value.set(cam.near, cam.far);
      r.setRenderTarget(t.color);
      r.render(this.particleScene, cam);
      particleUniforms.uDepth.value = prevDepth;
      particleUniforms.uHasDepth.value = prevHas;
      particleUniforms.uResolution.value.set(prevW, prevH);
      nearFade.set(prevNearX, prevNearY);
      particleUniforms.uAlphaMul.value = prevAlpha;
      particleUniforms.uSkyAmb.value.copy(_sky);
      particleUniforms.uGroundAmb.value.copy(_ground);
      particleUniforms.uSunLight.value.copy(_sun);
    }
    end?.();
    const rec = (this.passInfo[t.name] ??= { calls: 0, tris: 0, cpuMs: -1 });
    rec.calls = info.calls - calls0;
    rec.tris = info.triangles - tris0;
    const cpu = performance.now() - cpu0;
    rec.cpuMs = rec.cpuMs < 0 ? cpu : rec.cpuMs + (cpu - rec.cpuMs) * 0.1;
  }

  /**
   * Draw the HUD strip onto the canvas, after the composer. `cssW`/`cssH` are the canvas size in CSS px, `pixelRatio` the
   * drawing buffer's pixels per CSS pixel.
   */
  drawStrip(cssW: number, cssH: number, pixelRatio: number): void {
    const rc = this.hudRect;
    if (this.hudAlpha <= 0.004 || rc.w <= 0 || !this.hudMat.uniforms.uMap.value) return;
    const r = this.renderer;
    const u = this.hudMat.uniforms;
    (u.uSize.value as Vector2).set(rc.w * pixelRatio, rc.h * pixelRatio);
    u.uAlpha.value = this.hudAlpha;
    u.uPx.value = pixelRatio;
    r.setRenderTarget(null);
    r.setViewport(rc.x, rc.y, rc.w, rc.h);
    r.render(this.hudScene, this.hudCam);
    r.setViewport(0, 0, cssW, cssH);
  }

  dispose(): void {
    this.disposed = true;
    this.detach();
    this.rear?.dispose();
    this.flares.dispose();
    this.hudMat.dispose();
    this.hudMesh.geometry.dispose();
  }
}
