/**
 * WeatherSystem — the main-thread half of the rain / storm ambience.
 *
 *   set(rain)      the target intensity from AudioSystem.setWeather(); 0 = dry
 *   update(...)    once a frame: creates the 'xr-weather' worklet node when rain starts (and only then), posts the
 *                  control vector (rain, cabin / open view, player speed, mute), ticks the thunder clock and
 *                  disposes the node a few seconds after the rain has stopped, so a dry race carries no weather
 *                  node and costs nothing
 *   sleep()        pause / hidden tab: the voice goes quiet at once and stops computing
 *
 * Thunder: ThunderScheduler decides when (every ~20-60 s in a storm); the sound starts a flash-to-bang
 * delay later (distance / 343 m/s), and `onStrike` tells whoever draws lightning when the flash happens, so
 * a renderer can sync a sky flash if it wants to (optional; the audio works without it).
 *
 * The node factory is injectable so the lifecycle can be unit-tested without Web Audio.
 */
import type { MasterGraph } from './graph';
import {
  type ThunderEvent,
  ThunderScheduler,
  WCTL,
  makeWeatherControlVector,
  thunderDelay,
  unit,
} from './weather-model';

/** What the system needs from a weather node (the real one wraps an AudioWorkletNode). */
export interface WeatherNodeLike {
  /** Send the control vector. */
  post(v: Float32Array): void;
  /** Start a thunder clap now. */
  thunder(ev: ThunderEvent): void;
  dispose(): void;
}

export interface WeatherNodeOptions {
  seed: number;
  /** Offline mode: pre-recorded control frames (WCTL_LEN floats each) played on the audio clock. */
  script?: { step: number; data: Float32Array };
  /** Offline mode: claps at fixed times (s). */
  thunders?: { t: number; ev: ThunderEvent }[];
}

export interface WeatherNode extends WeatherNodeLike {
  node: AudioWorkletNode;
  out: GainNode;
}

/** Build the worklet node (stereo ambience -> effects bus). The worklet module must already be loaded. */
export function createWeatherNode(ctx: BaseAudioContext, g: MasterGraph, o: WeatherNodeOptions): WeatherNode {
  const node = new AudioWorkletNode(ctx, 'xr-weather', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { seed: o.seed, script: o.script, thunders: o.thunders },
  });
  const out = ctx.createGain();
  out.gain.value = 1;
  node.connect(out);
  out.connect(g.effectsBus);
  return {
    node,
    out,
    post(v: Float32Array): void {
      node.port.postMessage(v);
    },
    thunder(ev: ThunderEvent): void {
      node.port.postMessage({ type: 'thunder', ev });
    },
    dispose(): void {
      try {
        node.port.postMessage('dispose');
        node.port.close();
      } catch {
        /* ignore */
      }
      for (const n of [node, out]) {
        try {
          n.disconnect();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/** What a flash tells the renderer: when it happens relative to the bang, and how big. */
export interface StrikeInfo {
  /** Seconds between the flash (now) and the thunder reaching the listener. */
  delaySeconds: number;
  distanceKm: number;
  /** 0..1 */
  level: number;
}

export interface WeatherHost {
  /** True once the worklet module is loaded (nodes can be created). */
  ready(): boolean;
  /** Build a node; the default wraps createWeatherNode on the system's context. */
  makeNode(seed: number): WeatherNodeLike | null;
}

/** Seconds the node is kept after the rain stops (the voice fades out in ~3 s). */
export const WEATHER_FADE_OUT_S = 4;

export class WeatherSystem {
  /** Called when a lightning strike happens (the thunder follows `delaySeconds` later). Optional. */
  onStrike: ((s: StrikeInfo) => void) | null = null;
  private target = 0;
  /** The precipitation is snow (a winter circuit): the voice makes the wind and no drops, and there is no thunder. */
  private snow = false;
  /** Keep the voice alive (asleep) while it is not raining, for a race that rain is coming to (see arm). */
  private armed = false;
  private node: WeatherNodeLike | null = null;
  private failed = false;
  private idle = 0;
  private readonly sched: ThunderScheduler;
  private readonly vec = makeWeatherControlVector();
  private pending: { t: number; ev: ThunderEvent }[] = [];
  private lastGain = -1;
  private disposed = false;
  private seed: number;

  constructor(
    private readonly host: WeatherHost,
    seed = 1,
  ) {
    this.seed = seed;
    this.sched = new ThunderScheduler(seed);
  }

  /** The current rain target, 0..1. */
  get rain(): number {
    return this.target;
  }

  /** Is a weather node alive (rain, or still fading out)? */
  get active(): boolean {
    return this.node !== null;
  }

  /** Strikes scheduled so far (for diagnostics / tests). */
  get strikes(): number {
    return this.sched.count;
  }

  /**
   * Have the worklet voice built and waiting, silent, for a race whose rain is still to come. A voice is built where it is first
   * needed, which costs the audio thread tens of milliseconds (the drop prototypes are synthesised): a dropout, harmless behind a
   * loading screen but not as the rain arrives in the middle of a race.
   */
  arm(on: boolean): void {
    this.armed = on;
  }

  /** Snow instead of rain (see WCTL.SNOW). */
  setSnow(on: boolean): void {
    this.snow = on;
  }

  set(rain: number): void {
    const r = unit(rain);
    if (r === this.target) return;
    this.target = r;
    if (r === 0) {
      this.sched.reset();
      this.pending.length = 0;
    }
  }

  update(dt: number, interior: number, speed: number, muted: boolean): void {
    if (this.disposed) return;
    if (!(dt > 0) || !Number.isFinite(dt)) dt = 0;
    if ((this.target > 0 || this.armed) && !this.node && !this.failed) {
      if (!this.host.ready()) return;
      try {
        this.node = this.host.makeNode(this.seed);
      } catch (e) {
        this.failed = true;
        console.warn('[audio] could not create the weather voice:', e);
      }
      if (!this.node) return;
      this.idle = 0;
      this.lastGain = -1;
    }
    const node = this.node;
    if (!node) return;

    const gain = muted ? 0 : 1;
    // nothing changes while muted and already told so
    if (!(muted && this.lastGain === 0)) {
      const v = this.vec;
      v[WCTL.RAIN] = this.target;
      v[WCTL.INTERIOR] = unit(interior);
      v[WCTL.SPEED] = Number.isFinite(speed) ? speed : 0;
      v[WCTL.GAIN] = gain;
      v[WCTL.SNOW] = this.snow ? 1 : 0;
      node.post(v);
    }
    this.lastGain = gain;

    if (!muted && this.target > 0) {
      const ev = this.snow ? null : this.sched.tick(dt, this.target);
      if (ev) this.strike(ev);
      for (let i = this.pending.length - 1; i >= 0; i--) {
        const p = this.pending[i];
        p.t -= dt;
        if (p.t <= 0) {
          this.pending.splice(i, 1);
          node.thunder(p.ev);
        }
      }
    }

    if (this.target === 0 && !this.armed) {
      this.idle += dt;
      if (this.idle >= WEATHER_FADE_OUT_S) this.drop();
    } else this.idle = 0;
  }

  /** Flash now, thunder after the flash-to-bang delay. */
  private strike(ev: ThunderEvent): void {
    const delay = thunderDelay(ev.distanceKm);
    this.onStrike?.({ delaySeconds: delay, distanceKm: ev.distanceKm, level: ev.level });
    this.pending.push({ t: delay, ev });
  }

  /** Start a clap right away (bench / debugging). Needs a live node, i.e. rain > 0. */
  trigger(ev: ThunderEvent): void {
    this.node?.thunder(ev);
  }

  /** Pause / hidden tab: silence the voice immediately. */
  sleep(): void {
    const node = this.node;
    if (!node || this.lastGain === 0) return;
    const v = this.vec;
    v[WCTL.GAIN] = 0;
    node.post(v);
    this.lastGain = 0;
  }

  private drop(): void {
    this.node?.dispose();
    this.node = null;
    this.pending.length = 0;
    this.lastGain = -1;
  }

  dispose(): void {
    this.disposed = true;
    this.drop();
  }
}
