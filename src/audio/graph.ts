/**
 * Master graph: per-source -> buses (engine, effects, music, ui) -> master -> gentle compressor ->
 * soft limiter -> destination. Works on any BaseAudioContext (live or offline).
 */
import type { AudioSettings } from '../core/contracts';

export interface MasterGraph {
  readonly ctx: BaseAudioContext;
  readonly engineBus: GainNode;
  readonly effectsBus: GainNode;
  readonly musicBus: GainNode;
  readonly uiBus: GainNode;
  readonly master: GainNode;
  readonly compressor: DynamicsCompressorNode;
  readonly limiter: WaveShaperNode;
  setVolumes(v: AudioSettings, immediate?: boolean): void;
  setPaused(p: boolean): void;
  /** Music level multiplier on top of the user volume (used for the on/off crossfade). */
  setMusicGate(g: number, seconds: number): void;
  dispose(): void;
}

/** Perceptual-ish slider curve: 0..1 -> gain. */
export function volumeCurve(x: number): number {
  const v = Math.min(Math.max(Number.isFinite(x) ? x : 0, 0), 1);
  return v * v;
}

/**
 * Transparent below ~0.8, then a smooth knee towards +-1: nothing can ever leave the destination
 * above full scale (inputs beyond +-1 clamp to the curve ends).
 */
export function makeLimiterCurve(points = 4097): Float32Array<ArrayBuffer> {
  const c = new Float32Array(points);
  const knee = 0.8;
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
    c[i] = Math.sign(x) * y;
  }
  return c;
}

export function buildMasterGraph(ctx: BaseAudioContext, v: AudioSettings, opts: { raw?: boolean } = {}): MasterGraph {
  const mk = (): GainNode => ctx.createGain();
  const engineBus = mk();
  const effectsBus = mk();
  const musicBus = mk();
  const uiBus = mk();
  const musicGate = mk();
  const master = mk();
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -12;
  compressor.knee.value = 14;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.16;
  const limiter = ctx.createWaveShaper();
  limiter.curve = makeLimiterCurve();
  limiter.oversample = '2x';

  engineBus.connect(master);
  effectsBus.connect(master);
  musicBus.connect(musicGate);
  musicGate.connect(master);
  uiBus.connect(master);
  if (opts.raw) {
    // analysis mode: no compressor / limiter in the path
    master.connect(ctx.destination);
  } else {
    master.connect(compressor);
    compressor.connect(limiter);
    limiter.connect(ctx.destination);
  }

  let vols = v;
  let paused = false;
  let carsMul = 1;
  const apply = (immediate: boolean): void => {
    const t = ctx.currentTime;
    const tc = immediate ? 0.001 : 0.04;
    master.gain.setTargetAtTime(volumeCurve(vols.master), t, tc);
    engineBus.gain.setTargetAtTime(volumeCurve(vols.engine) * carsMul, t, paused ? 0.06 : tc);
    effectsBus.gain.setTargetAtTime(volumeCurve(vols.effects) * carsMul, t, paused ? 0.06 : tc);
    musicBus.gain.setTargetAtTime(volumeCurve(vols.music), t, tc);
    uiBus.gain.setTargetAtTime(volumeCurve(vols.ui), t, tc);
  };
  // initial values without a ramp
  master.gain.value = volumeCurve(v.master);
  engineBus.gain.value = volumeCurve(v.engine);
  effectsBus.gain.value = volumeCurve(v.effects);
  musicBus.gain.value = volumeCurve(v.music);
  uiBus.gain.value = volumeCurve(v.ui);
  musicGate.gain.value = 0;

  return {
    ctx,
    engineBus,
    effectsBus,
    musicBus,
    uiBus,
    master,
    compressor,
    limiter,
    setVolumes(nv, immediate = false): void {
      vols = nv;
      apply(immediate);
    },
    setPaused(p): void {
      paused = p;
      carsMul = p ? 0 : 1;
      apply(false);
    },
    setMusicGate(g, seconds): void {
      const t = ctx.currentTime;
      musicGate.gain.cancelScheduledValues(t);
      musicGate.gain.setValueAtTime(musicGate.gain.value, t);
      musicGate.gain.linearRampToValueAtTime(g, t + Math.max(seconds, 0.01));
    },
    dispose(): void {
      for (const n of [engineBus, effectsBus, musicBus, uiBus, musicGate, master, compressor, limiter]) n.disconnect();
    },
  };
}
