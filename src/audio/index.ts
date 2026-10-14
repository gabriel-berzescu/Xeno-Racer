/**
 * Xeno-Racer audio — public entry point.
 *
 *   createAudioSystem(volumes): AudioSystem          (see core/systems.ts)
 *
 * Web Audio graph:  per-source -> buses (engine, effects, music, ui) -> master -> gentle
 * compressor -> soft limiter -> destination.  Engines / tires / wind / impacts are synthesised in an
 * AudioWorklet (engine.worklet.ts); UI sounds and music use native nodes.
 */
import type * as THREE from 'three';
import type { AudioSettings, EngineSoundProfile, UiSound } from '../core/contracts';
import type { AudioSystem, CarSound, CreateAudioSystem } from '../core/systems';
import workletUrl from './engine.worklet.ts?worker&url';
import { CarSoundImpl, type CarHost } from './carsound';
import { type MasterGraph, buildMasterGraph } from './graph';
import { MenuMusic } from './music';
import { type ListenerState, type Lod, assignLod, listenerFromMatrix, makeListener } from './spatial';
import { UiSynth } from './ui-sounds';

export { CarSoundImpl, createCarNodes, setPannerPosition } from './carsound';
export type { CarHost, CarNodes } from './carsound';
export { buildMasterGraph, volumeCurve } from './graph';
export type { MasterGraph } from './graph';
export { MenuMusic, MUSIC_INFO } from './music';
export { UiSynth, UI_SOUND_LIST } from './ui-sounds';
export { calibratedExhaustGain } from './dsp/engine-voice';

/** URL of the bundled worklet module (differs between `vite dev` and `vite build`). */
export const AUDIO_WORKLET_URL: string = workletUrl;

/** Load the worklet processors into a context (live or offline). */
export function loadAudioWorklet(ctx: BaseAudioContext): Promise<void> {
  return ctx.audioWorklet.addModule(workletUrl);
}

interface SystemOptions {
  /** Use this context instead of creating a real-time one (offline rendering / tests). */
  ctx?: BaseAudioContext;
}

type Win = Window & { webkitAudioContext?: typeof AudioContext };

const GESTURE_EVENTS = ['pointerdown', 'mousedown', 'keydown', 'touchend', 'click'] as const;

class AudioSystemImpl implements AudioSystem, CarHost {
  readonly ctx: BaseAudioContext;
  readonly graph: MasterGraph;
  readonly listener: ListenerState = makeListener();
  workletReady = false;
  paused = false;
  /** Resolves when the worklet module is loaded (cars create their voices then). */
  readonly ready: Promise<void>;

  private ui_: UiSynth;
  private music: MenuMusic | null = null;
  private musicWanted = false;
  private cars = new Set<CarSoundImpl>();
  private seed = 1;
  private owned: boolean;
  private lastResumeTry = -10;
  private resumePending: Promise<void> | null = null;
  private uiQueue: { s: UiSound; at: number }[] = [];
  private gestureHandler: (() => void) | null = null;
  private clock = 0;
  private lodDist: number[] = [];
  private lodOut: Lod[] = [];
  private lodOrder: number[] = [];
  private aiList: CarSoundImpl[] = [];
  private disposed = false;
  private musicStopTimer: ReturnType<typeof setTimeout> | null = null;
  // watchdog: no update() for a while (hidden tab, debugger) -> mute the cars instead of droning forever
  private lastUpdateAt = 0;
  private stale = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(v: AudioSettings, opts: SystemOptions = {}) {
    this.owned = !opts.ctx;
    if (opts.ctx) this.ctx = opts.ctx;
    else {
      const Ctor = window.AudioContext ?? (window as Win).webkitAudioContext;
      this.ctx = new Ctor!({ latencyHint: 'interactive' });
    }
    this.graph = buildMasterGraph(this.ctx, v);
    this.ui_ = new UiSynth(this.ctx, this.graph.uiBus);
    this.ready = this.ctx.audioWorklet
      .addModule(workletUrl)
      .then(() => {
        this.workletReady = true;
      })
      .catch((e: unknown) => {
        console.warn('[audio] worklet failed to load; engines will be silent:', e);
      });
    if (this.owned) {
      this.ctx.addEventListener('statechange', () => this.onState());
      this.installGestureHooks();
      this.lastUpdateAt = performance.now();
      this.watchdog = setInterval(() => this.checkStale(), 250);
    }
  }

  get unlocked(): boolean {
    return this.ctx.state === 'running';
  }

  nextSeed(): number {
    return this.seed++;
  }

  // ── unlock ─────────────────────────────────────────────────────────────────

  private installGestureHooks(): void {
    // Real user gestures unlock audio even if the game only calls unlock() from gamepad polling.
    const h = (): void => {
      void this.unlock();
    };
    this.gestureHandler = h;
    for (const ev of GESTURE_EVENTS) window.addEventListener(ev, h, { capture: true, passive: true });
  }

  private removeGestureHooks(): void {
    const h = this.gestureHandler;
    if (!h) return;
    for (const ev of GESTURE_EVENTS) window.removeEventListener(ev, h, { capture: true });
    this.gestureHandler = null;
  }

  private onState(): void {
    if (this.ctx.state === 'running') {
      this.removeGestureHooks();
      // play the UI sound(s) that triggered the unlock, if they are fresh
      const now = performance.now();
      for (const q of this.uiQueue) if (now - q.at < 500) this.ui_.play(q.s);
      this.uiQueue.length = 0;
      if (this.musicWanted) this.startMusic();
    }
  }

  unlock(): Promise<void> {
    if (this.ctx.state === 'running') return Promise.resolve();
    if (this.resumePending) return this.resumePending;
    const ctx = this.ctx as AudioContext;
    if (typeof ctx.resume !== 'function') return Promise.resolve();
    // resume() may stay pending when the browser does not count the trigger as a user activation
    // (gamepad buttons); do not block callers on it, and let later calls try again.
    this.resumePending = new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        this.resumePending = null;
        resolve();
      };
      try {
        ctx.resume().then(finish, finish);
      } catch {
        finish();
      }
      setTimeout(finish, 300);
    });
    return this.resumePending;
  }

  // ── listener / frame update ────────────────────────────────────────────────

  setListener(camera: THREE.Camera, velocity: THREE.Vector3): void {
    camera.updateMatrixWorld();
    listenerFromMatrix(camera.matrixWorld.elements, velocity.x, velocity.y, velocity.z, this.listener);
  }

  private applyListener(): void {
    const L = this.listener;
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = L.px;
      l.positionY.value = L.py;
      l.positionZ.value = L.pz;
      l.forwardX.value = L.fx;
      l.forwardY.value = L.fy;
      l.forwardZ.value = L.fz;
      l.upX.value = L.ux;
      l.upY.value = L.uy;
      l.upZ.value = L.uz;
    } else {
      const old = l as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void;
      };
      old.setPosition(L.px, L.py, L.pz);
      old.setOrientation(L.fx, L.fy, L.fz, L.ux, L.uy, L.uz);
    }
  }

  private checkStale(): void {
    if (this.disposed || this.paused) return;
    const idle = performance.now() - this.lastUpdateAt > 600;
    if (idle && !this.stale) {
      this.stale = true;
      this.graph.setPaused(true);
      for (const c of this.cars) c.sleep();
    }
  }

  update(dt: number): void {
    if (this.disposed) return;
    this.lastUpdateAt = performance.now();
    if (this.stale) {
      this.stale = false;
      if (!this.paused) this.graph.setPaused(false);
    }
    this.clock += dt;
    // keep trying to resume: once the page has had a real activation, resume() is allowed from anywhere
    if (this.owned && this.ctx.state !== 'running' && this.clock - this.lastResumeTry > 0.5) {
      const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
      if (!ua || ua.hasBeenActive) {
        this.lastResumeTry = this.clock;
        void this.unlock();
      }
    }
    if (this.ctx.state !== 'running') return;
    this.applyListener();

    // level of detail for opponents
    this.aiList.length = 0;
    for (const c of this.cars) if (!c.isPlayer) this.aiList.push(c);
    const n = this.aiList.length;
    if (n > 0) {
      for (let i = 0; i < n; i++) this.lodDist[i] = this.aiList[i].distance;
      assignLod(this.lodDist, n, this.lodOut, this.lodOrder);
      for (let i = 0; i < n; i++) this.aiList[i].lod = this.lodOut[i];
    }
    this.music?.tick();
  }

  // ── cars ───────────────────────────────────────────────────────────────────

  createCarSound(profile: EngineSoundProfile, isPlayer: boolean): CarSound {
    const c = new CarSoundImpl(this, profile, isPlayer);
    this.cars.add(c);
    return c;
  }

  onDispose(car: CarSoundImpl): void {
    this.cars.delete(car);
  }

  // ── ui, volumes, pause, music ──────────────────────────────────────────────

  ui(sound: UiSound): void {
    if (this.disposed) return;
    if (this.ctx.state === 'running') this.ui_.play(sound);
    else {
      // remember it briefly: the same user gesture that unlocks audio often triggers the sound
      this.uiQueue.push({ s: sound, at: performance.now() });
      if (this.uiQueue.length > 3) this.uiQueue.shift();
      void this.unlock();
    }
  }

  setVolumes(v: AudioSettings): void {
    this.graph.setVolumes(v);
  }

  setPaused(p: boolean): void {
    if (p === this.paused) return;
    this.paused = p;
    this.graph.setPaused(p || this.stale);
    if (p) for (const c of this.cars) c.sleep();
  }

  private startMusic(): void {
    if (this.ctx.state !== 'running') return;
    if (!this.music) this.music = new MenuMusic(this.ctx, this.graph.musicBus);
    if (this.musicStopTimer) {
      clearTimeout(this.musicStopTimer);
      this.musicStopTimer = null;
    }
    this.music.start();
    this.graph.setMusicGate(1, 1.8);
  }

  setMusic(on: boolean): void {
    this.musicWanted = on;
    if (on) {
      if (this.ctx.state === 'running') this.startMusic();
      else void this.unlock();
    } else if (this.music) {
      this.graph.setMusicGate(0, 1.4);
      const m = this.music;
      if (this.musicStopTimer) clearTimeout(this.musicStopTimer);
      this.musicStopTimer = setTimeout(() => {
        if (!this.musicWanted) m.stop();
      }, 1600);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeGestureHooks();
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.musicStopTimer) clearTimeout(this.musicStopTimer);
    for (const c of [...this.cars]) c.dispose();
    this.music?.dispose();
    this.ui_.dispose();
    this.graph.dispose();
    if (this.owned) void (this.ctx as AudioContext).close().catch(() => undefined);
  }
}

export type AudioSystemInternals = AudioSystemImpl;

/** Silent stand-in used when Web Audio is unavailable: the game keeps running, just without sound. */
function createSilentAudioSystem(): AudioSystem {
  const silentCar: CarSound = { update: () => undefined, setInterior: () => undefined, dispose: () => undefined };
  return {
    unlock: () => Promise.resolve(),
    unlocked: false,
    setListener: () => undefined,
    createCarSound: () => silentCar,
    ui: () => undefined,
    setVolumes: () => undefined,
    setPaused: () => undefined,
    setMusic: () => undefined,
    update: () => undefined,
    dispose: () => undefined,
  };
}

/** The game-facing factory — exactly `CreateAudioSystem` from core/systems.ts. Never throws. */
export function createAudioSystem(v: AudioSettings): AudioSystem {
  try {
    return new AudioSystemImpl(v);
  } catch (e) {
    console.warn('[audio] Web Audio is not available; running without sound:', e);
    return createSilentAudioSystem();
  }
}

// Compile-time proof that the factory matches the contract (breaks the build if either side drifts).
const contractCheck: CreateAudioSystem = createAudioSystem;
void contractCheck;

/** Internal / test factory: build the system on an existing (e.g. offline) context. */
export function createAudioSystemOn(ctx: BaseAudioContext, v: AudioSettings): AudioSystemImpl {
  return new AudioSystemImpl(v, { ctx });
}
