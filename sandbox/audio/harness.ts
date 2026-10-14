/**
 * Offline render harness (browser). Runs the REAL audio stack — AudioWorklet voices, panners,
 * buses, master chain — inside an OfflineAudioContext, driven by recorded control frames so the
 * result is deterministic. Used by the ?test=1 report and the preview WAV renderer.
 */
import type { AudioSettings, EngineSoundProfile, VehicleState } from '../../src/core/contracts';
import { AUDIO_WORKLET_URL, MenuMusic, UiSynth, createCarNodes, buildMasterGraph, type MasterGraph } from '../../src/audio';
import { CarFrame, applySpatial } from '../../src/audio/carsound';
import { CTL_LEN } from '../../src/audio/controls';
import { type ListenerState, type Lod, type SpatialOut, makeListener, makeSpatialOut } from '../../src/audio/spatial';
import type { UiSound } from '../../src/core/contracts';

export const DEFAULT_VOLUMES: AudioSettings = { master: 1, engine: 1, effects: 1, music: 1, ui: 1 };
export const SR = 48000;

export interface SceneCar {
  profile: EngineSoundProfile;
  isPlayer: boolean;
  state: VehicleState;
  /** Advance the state for the control frame at time t (dt = 1/fps). */
  step: (t: number, dt: number, st: VehicleState) => void;
  lod?: Lod;
  interior?: number | ((t: number) => number);
  seed?: number;
}

export interface SceneOptions {
  seconds: number;
  sr?: number;
  fps?: number;
  cars: SceneCar[];
  listener?: (t: number, L: ListenerState) => void;
  volumes?: AudioSettings;
  /** Bypass compressor + limiter (pure DSP measurements). */
  raw?: boolean;
  /** Set panner / filter values once (no per-frame automation) — for CPU timing. */
  staticSpatial?: boolean;
  /** Extra graph work before rendering (UI sounds, music...). */
  extra?: (ctx: OfflineAudioContext, graph: MasterGraph) => void;
}

export interface SceneResult {
  left: Float32Array;
  right: Float32Array;
  sr: number;
  renderMs: number;
  quanta: number;
}

let renderCounter = 0;
function progress(stage: string): void {
  (window as unknown as Record<string, unknown>).__AUDIO_STAGE__ = `render #${renderCounter} ${stage} @${Math.round(performance.now())}`;
}

export async function renderScene(o: SceneOptions): Promise<SceneResult> {
  renderCounter++;
  progress('start');
  const sr = o.sr ?? SR;
  const fps = o.fps ?? 60;
  const frames = Math.ceil(o.seconds * fps);
  const length = Math.ceil(o.seconds * sr);
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: sr });
  progress('addModule');
  await ctx.audioWorklet.addModule(AUDIO_WORKLET_URL);
  progress('addModule done');
  const graph = buildMasterGraph(ctx, o.volumes ?? DEFAULT_VOLUMES, { raw: o.raw });
  const listener = makeListener();
  const step = Math.round(sr / fps);

  // 1) record control + spatial frames for every car and the listener
  const listenerFrames = new Float32Array(frames * 9);
  interface Rec {
    car: SceneCar;
    frame: CarFrame;
    script: Float32Array;
    sp: Float32Array; // x y z lpHz distance px py pz
  }
  const recs: Rec[] = o.cars.map((car) => ({
    car,
    frame: new CarFrame(car.isPlayer),
    script: new Float32Array(frames * CTL_LEN),
    sp: new Float32Array(frames * 8),
  }));
  for (let k = 0; k < frames; k++) {
    const t = k / fps;
    const dt = 1 / fps;
    o.listener?.(t, listener);
    listenerFrames.set([listener.px, listener.py, listener.pz, listener.fx, listener.fy, listener.fz, listener.ux, listener.uy, listener.uz], k * 9);
    for (const r of recs) {
      r.car.step(t, dt, r.car.state);
      const interior = typeof r.car.interior === 'function' ? r.car.interior(t) : r.car.interior ?? 0;
      r.frame.compute(r.car.state, dt, listener, interior, r.car.lod ?? 2, false);
      r.script.set(r.frame.vec, k * CTL_LEN);
      const sp = r.frame.sp;
      const p = r.car.state.position;
      r.sp.set([sp.x, sp.y, sp.z, sp.lpHz, sp.distance, p.x, p.y, p.z], k * 8);
    }
  }

  // 2) build the nodes with their scripts and schedule the spatial automation
  const tmp: SpatialOut = makeSpatialOut();
  let seed = 1;
  for (const r of recs) {
    const nodes = createCarNodes(ctx, graph, {
      profile: r.car.profile,
      isPlayer: r.car.isPlayer,
      seed: r.car.seed ?? seed++,
      script: { step, data: r.script },
    });
    for (let k = 0; k < (o.staticSpatial ? 1 : frames); k++) {
      const b = k * 8;
      tmp.x = r.sp[b];
      tmp.y = r.sp[b + 1];
      tmp.z = r.sp[b + 2];
      tmp.lpHz = r.sp[b + 3];
      tmp.distance = r.sp[b + 4];
      applySpatial(nodes, tmp, r.sp[b + 5], r.sp[b + 6], r.sp[b + 7], o.staticSpatial ? undefined : k / fps);
    }
  }
  const L = ctx.listener;
  for (let k = 0; k < (o.staticSpatial ? 0 : frames); k++) {
    const t = k / fps;
    const b = k * 9;
    L.positionX.setValueAtTime(listenerFrames[b], t);
    L.positionY.setValueAtTime(listenerFrames[b + 1], t);
    L.positionZ.setValueAtTime(listenerFrames[b + 2], t);
    L.forwardX.setValueAtTime(listenerFrames[b + 3], t);
    L.forwardY.setValueAtTime(listenerFrames[b + 4], t);
    L.forwardZ.setValueAtTime(listenerFrames[b + 5], t);
    L.upX.setValueAtTime(listenerFrames[b + 6], t);
    L.upY.setValueAtTime(listenerFrames[b + 7], t);
    L.upZ.setValueAtTime(listenerFrames[b + 8], t);
  }
  o.extra?.(ctx, graph);

  // 3) render
  progress('startRendering');
  const t0 = performance.now();
  const buf = await ctx.startRendering();
  progress('rendered');
  const renderMs = performance.now() - t0;
  return {
    left: buf.getChannelData(0).slice(),
    right: buf.getChannelData(1).slice(),
    sr,
    renderMs,
    quanta: Math.ceil(length / 128),
  };
}

/** Render a UI sound on its own (through the ui bus + master). */
export async function renderUiSound(kind: UiSound, seconds = 3, raw = true): Promise<SceneResult> {
  const sr = SR;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(seconds * sr), sampleRate: sr });
  const graph = buildMasterGraph(ctx, DEFAULT_VOLUMES, { raw });
  const ui = new UiSynth(ctx, graph.uiBus);
  ui.play(kind, 0.02);
  const t0 = performance.now();
  const buf = await ctx.startRendering();
  return { left: buf.getChannelData(0).slice(), right: buf.getChannelData(1).slice(), sr, renderMs: performance.now() - t0, quanta: 0 };
}

/** Render the menu music (full band by default: starts in the groove block). */
export async function renderMusic(seconds: number, startBar = 8, raw = true): Promise<SceneResult> {
  const sr = SR;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(seconds * sr), sampleRate: sr });
  const graph = buildMasterGraph(ctx, DEFAULT_VOLUMES, { raw });
  const music = new MenuMusic(ctx, graph.musicBus, { startBar });
  graph.setMusicGate(1, 0.01);
  music.renderUntil(seconds);
  const t0 = performance.now();
  const buf = await ctx.startRendering();
  return { left: buf.getChannelData(0).slice(), right: buf.getChannelData(1).slice(), sr, renderMs: performance.now() - t0, quanta: 0 };
}
