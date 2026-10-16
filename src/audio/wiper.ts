/**
 * WiperSystem — the main-thread half of the cockpit wiper's sound.
 *
 *   feed(f)     once per rendered frame (the game hands over `XenoRenderSystem.wiper`): while the blade is on screen it lays the
 *               picture's clock over the audio clock and posts each sweep to the worklet a little ahead of its start
 *               (wiper-model.ts: WiperPlanner); the moment the blade leaves the picture (another camera, no rain) the sound is
 *               faded out, and nothing is posted
 *   update(dt)  once per audio frame: stops the sound when the picture has stopped telling us about the blade (a replay, the menu,
 *               a hitch), when the game is paused or the rain is over, and drops the worklet node a few seconds after the last sweep,
 *               so a dry race or an outside view carries no wiper node and costs nothing
 *   sleep()     pause / hidden tab: silence at once
 *
 * The node factory is injectable so the lifecycle and the scheduling can be unit-tested without Web Audio.
 */
import type { MasterGraph } from './graph';
import { type SweepCommand, WIPER_STALE_S, type WiperFeed, WiperPlanner } from './wiper-model';

/** What the system needs from a wiper node (the real one wraps an AudioWorkletNode). */
export interface WiperNodeLike {
  /** Play a sweep (an absolute audio-clock frame; see SweepCommand). */
  sweep(c: SweepCommand): void;
  /** Fade out whatever sounds and forget everything queued. */
  stop(): void;
  /** 0 = silent (pause), 1 = normal. */
  gain(g: number): void;
  dispose(): void;
}

export interface WiperNodeOptions {
  seed: number;
  /** Offline mode: sweeps played from the start of the render (their f0 are context frames). */
  sweeps?: SweepCommand[];
}

export interface WiperNode extends WiperNodeLike {
  node: AudioWorkletNode;
  out: GainNode;
}

/** Build the worklet node (stereo, into the effects bus). The worklet module must already be loaded. */
export function createWiperNode(ctx: BaseAudioContext, g: MasterGraph, o: WiperNodeOptions): WiperNode {
  const node = new AudioWorkletNode(ctx, 'xr-wiper', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { seed: o.seed, sweeps: o.sweeps },
  });
  const out = ctx.createGain();
  out.gain.value = 1;
  node.connect(out);
  out.connect(g.effectsBus);
  return {
    node,
    out,
    sweep(c: SweepCommand): void {
      node.port.postMessage({ type: 'sweep', ...c });
    },
    stop(): void {
      node.port.postMessage({ type: 'stop' });
    },
    gain(v: number): void {
      node.port.postMessage({ type: 'gain', gain: v });
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

export interface WiperHost {
  /** True once the worklet module is loaded (nodes can be created). */
  ready(): boolean;
  /** The audio context is running (its clock ticks). */
  running(): boolean;
  /** Paused / hidden tab: no sound. */
  muted(): boolean;
  /** The weather's rain target, 0 when dry. */
  rain(): number;
  /** The audio clock (AudioContext.currentTime), seconds. */
  now(): number;
  /** Seconds to shift the sound for the delays between the audio clock and the picture (display latency - output latency). */
  lead(): number;
  /** Build a node; the default wraps createWiperNode on the system's context. */
  makeNode(seed: number): WiperNodeLike | null;
}

/** Seconds the node is kept after the last sweep (toggling the camera back and forth does not rebuild it every time). */
export const WIPER_NODE_KEEP_S = 4;
/** Posted sweeps remembered for diagnostics. */
const LOG_N = 24;

export interface WiperLogEntry {
  /** Audio clock when the sweep was posted, and the sweep itself (f0 in context frames, cs the droplet clock at its start). */
  postedAt: number;
  droplet: number;
  cmd: SweepCommand;
}

export class WiperSystem {
  /** Called with every sweep as it is posted (tests, probes). */
  onSweep: ((c: SweepCommand) => void) | null = null;
  /** The last few posted sweeps, newest last (read through window.__GAME__.audio.wiper.log to compare against the picture). */
  readonly log: WiperLogEntry[] = [];
  private node: WiperNodeLike | null = null;
  /** Keep the voice alive (silent) whether or not the blade is on screen (see arm). */
  private armed = false;
  private failed = false;
  private playing = false;
  private age = 0;
  private idle = 0;
  private disposed = false;
  private readonly planner: WiperPlanner;
  private readonly seed: number;
  /** Callbacks handed to the planner every frame, made once (nothing is allocated per frame). */
  private readonly post: (c: SweepCommand, isNew: boolean) => void;
  private readonly resync: () => void;
  private feedTime = 0;

  constructor(
    private readonly host: WiperHost,
    readonly sampleRate: number,
    seed = 1,
  ) {
    this.seed = seed;
    this.planner = new WiperPlanner(sampleRate, seed);
    this.post = (c, isNew) => {
      this.node?.sweep(c);
      if (isNew) this.note(c, this.feedTime);
    };
    this.resync = () => this.node?.stop();
  }

  /**
   * Have the worklet voice built and waiting for a race that rain is coming to: building it costs the audio thread tens of
   * milliseconds (the blade's sounds are synthesised), a dropout that is better heard behind a loading screen than at the first
   * sweep of the race.
   */
  arm(on: boolean): void {
    this.armed = on;
  }

  /** Is a wiper node alive? */
  get active(): boolean {
    return this.node !== null;
  }

  /** Is the blade being followed right now (sweeps are being posted)? */
  get following(): boolean {
    return this.playing;
  }

  /** Sweeps posted so far, and how many times a posted sweep that had not started yet was moved (after a hitch). */
  get sweeps(): number {
    return this.planner.count;
  }
  get moves(): number {
    return this.planner.moves;
  }

  /** Smoothed offset between the audio clock and the droplet clock (diagnostics). */
  get offset(): number {
    return this.planner.offset;
  }

  feed(f: WiperFeed): void {
    if (this.disposed) return;
    this.age = 0;
    const h = this.host;
    const want = f.drawn && f.rain > 0.02 && h.rain() > 0 && !h.muted() && h.running();
    if (!want) {
      this.halt();
      return;
    }
    if (!this.node) {
      if (this.failed || !h.ready()) return;
      try {
        this.node = h.makeNode(this.seed);
      } catch (e) {
        this.failed = true;
        console.warn('[audio] could not create the wiper voice:', e);
      }
      if (!this.node) return;
      this.idle = 0;
    }
    this.playing = true;
    this.feedTime = f.time;
    this.planner.step(f, h.now(), h.lead(), this.post, this.resync);
  }

  update(dt: number): void {
    if (this.disposed) return;
    if (!(dt > 0) || !Number.isFinite(dt)) dt = 0;
    this.age += dt;
    if (this.playing && (this.age > WIPER_STALE_S || this.host.muted() || !(this.host.rain() > 0))) this.halt();
    if (this.armed && !this.node && !this.failed && this.host.ready()) {
      try {
        this.node = this.host.makeNode(this.seed);
      } catch (e) {
        this.failed = true;
        console.warn('[audio] could not create the wiper voice:', e);
      }
    }
    if (this.node && !this.playing && !this.armed) {
      this.idle += dt;
      if (this.idle >= WIPER_NODE_KEEP_S) this.drop();
    } else this.idle = 0;
  }

  /** Pause / hidden tab: silence at once. */
  sleep(): void {
    this.halt();
  }

  private halt(): void {
    if (this.playing) {
      this.node?.stop();
      this.playing = false;
      this.idle = 0;
    }
    this.planner.reset();
  }

  private note(c: SweepCommand, droplet: number): void {
    const e: WiperLogEntry = { postedAt: this.host.now(), droplet, cmd: c };
    if (this.log.length >= LOG_N) this.log.shift();
    this.log.push(e);
    this.onSweep?.(c);
  }

  private drop(): void {
    this.node?.dispose();
    this.node = null;
    this.playing = false;
  }

  dispose(): void {
    this.disposed = true;
    this.drop();
  }
}
