/**
 * Main-thread side of a car's sound: node graph (worklet voice -> distance filter -> panner -> bus)
 * and the per-frame VehicleState -> control-vector mapping. The DSP itself lives in the worklet.
 */
import type { CarSound } from '../core/systems';
import type { EngineSoundProfile, Seat, VehicleState } from '../core/contracts';
import { ChassisMapper } from './chassis-controls';
import { CTL, makeControlVector, writeEngineControls } from './controls';
import { calibratedExhaustGain } from './dsp/engine-voice';
import type { MasterGraph } from './graph';
import { type ListenerState, type Lod, type SpatialOut, type SplitPlace, SPLIT_PLAYER_TRIM, computeSpatial, lodFade, makeSpatialOut, makeSplitPlace, chooseHearer, placeSplit } from './spatial';

export interface CarNodes {
  node: AudioWorkletNode;
  engineLp: BiquadFilterNode;
  enginePanner: PannerNode;
  chLp: BiquadFilterNode;
  chGain: GainNode | null;
  chPanner: PannerNode | null;
  dispose(): void;
}

export interface CarNodeOptions {
  profile: EngineSoundProfile;
  isPlayer: boolean;
  seed: number;
  /** Offline mode: pre-recorded control frames played on the audio clock. */
  script?: { step: number; data: Float32Array };
}

function makePanner(ctx: BaseAudioContext, ref: number, rolloff: number): PannerNode {
  const p = ctx.createPanner();
  p.panningModel = 'equalpower';
  p.distanceModel = 'inverse';
  p.refDistance = ref;
  p.maxDistance = 600;
  p.rolloffFactor = rolloff;
  p.coneInnerAngle = 360;
  p.coneOuterAngle = 360;
  p.coneOuterGain = 1;
  return p;
}

/** Build the graph for one car. The worklet module must already be loaded into `ctx`. */
export function createCarNodes(ctx: BaseAudioContext, g: MasterGraph, o: CarNodeOptions): CarNodes {
  const node = new AudioWorkletNode(ctx, 'xr-car', {
    numberOfInputs: 0,
    numberOfOutputs: 2,
    outputChannelCount: [1, o.isPlayer ? 2 : 1],
    processorOptions: {
      profile: o.profile,
      isPlayer: o.isPlayer,
      seed: o.seed,
      exGain: calibratedExhaustGain(o.profile, ctx.sampleRate),
      script: o.script,
    },
  });
  const engineLp = ctx.createBiquadFilter();
  engineLp.type = 'lowpass';
  engineLp.Q.value = 0.6;
  engineLp.frequency.value = 18000;
  const enginePanner = makePanner(ctx, o.isPlayer ? 6 : 4, o.isPlayer ? 0.85 : 1.15);
  node.connect(engineLp, 0);
  engineLp.connect(enginePanner);
  enginePanner.connect(g.engineBus);

  const chLp = ctx.createBiquadFilter();
  chLp.type = 'lowpass';
  chLp.Q.value = 0.6;
  chLp.frequency.value = 18000;
  node.connect(chLp, 1);
  let chGain: GainNode | null = null;
  let chPanner: PannerNode | null = null;
  if (o.isPlayer) {
    chGain = ctx.createGain();
    chLp.connect(chGain);
    chGain.connect(g.effectsBus);
  } else {
    chPanner = makePanner(ctx, 4, 1.15);
    chLp.connect(chPanner);
    chPanner.connect(g.effectsBus);
  }
  return {
    node,
    engineLp,
    enginePanner,
    chLp,
    chGain,
    chPanner,
    dispose(): void {
      try {
        node.port.postMessage('dispose');
        node.port.close();
      } catch {
        /* ignore */
      }
      for (const n of [node, engineLp, enginePanner, chLp, chGain, chPanner]) {
        try {
          n?.disconnect();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/** Set a panner's position (AudioParam API, falling back to the legacy setter). `at` schedules (offline). */
export function setPannerPosition(p: PannerNode, x: number, y: number, z: number, at?: number): void {
  if (p.positionX) {
    if (at === undefined) {
      p.positionX.value = x;
      p.positionY.value = y;
      p.positionZ.value = z;
    } else {
      p.positionX.setValueAtTime(x, at);
      p.positionY.setValueAtTime(y, at);
      p.positionZ.setValueAtTime(z, at);
    }
  } else (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
}

/**
 * One frame of control: VehicleState + listener -> control vector + spatial placement. Shared by
 * the live CarSound and the offline test harness so both exercise exactly the same mapping.
 */
export class CarFrame {
  readonly vec = makeControlVector();
  readonly sp: SpatialOut = makeSpatialOut();
  private mapper = new ChassisMapper();
  /** The gain of a player's car (engine and chassis): 1, or SPLIT_PLAYER_TRIM while two people listen. Opponents follow their level of detail. */
  trim = 1;

  constructor(readonly isPlayer: boolean) {}

  compute(st: VehicleState, dt: number, listener: ListenerState, interior: number, lod: Lod, paused: boolean, wet = 0): void {
    const v = this.vec;
    writeEngineControls(v, st);
    this.mapper.update(st, dt, v, wet);
    const sp = this.sp;
    computeSpatial(listener, st.position.x, st.position.y, st.position.z, st.velocity.x, st.velocity.y, st.velocity.z, this.isPlayer, sp);
    v[CTL.TIMESCALE] = sp.timeScale;
    v[CTL.INTERIOR] = interior;
    v[CTL.CH_INTERIOR] = interior;
    let engineQ = 2;
    let chassisQ = 2;
    let gain = this.isPlayer ? this.trim : 1;
    if (!this.isPlayer) {
      engineQ = lod;
      chassisQ = lod > 0 ? 1 : 0;
      gain = lodFade(sp.distance);
    }
    if (paused) gain = 0;
    v[CTL.QUALITY] = engineQ;
    v[CTL.CH_QUALITY] = chassisQ;
    v[CTL.GAIN] = gain;
    v[CTL.CH_GAIN] = gain;
  }
}

/** Push spatial values into the nodes (live: immediate; offline: scheduled at `at`). */
export function applySpatial(n: CarNodes, sp: SpatialOut, px: number, py: number, pz: number, at?: number): void {
  setPannerPosition(n.enginePanner, sp.x, sp.y, sp.z, at);
  const setF = (p: AudioParam, v: number): void => {
    if (at === undefined) p.value = v;
    else p.setValueAtTime(v, at);
  };
  setF(n.engineLp.frequency, sp.lpHz);
  setF(n.chLp.frequency, sp.lpHz);
  if (n.chPanner) setPannerPosition(n.chPanner, px, py, pz, at);
  if (n.chGain) {
    // the player's own tires / wind are attached to the car; recede with distance for far cameras
    setF(n.chGain.gain, 1 / (1 + Math.max(0, sp.distance - 10) / 12));
  }
}

/** What the system exposes to its cars. */
export interface CarHost {
  readonly ctx: BaseAudioContext;
  readonly graph: MasterGraph;
  readonly listener: ListenerState;
  /** True once the worklet module has loaded (nodes can be created). */
  readonly workletReady: boolean;
  readonly paused: boolean;
  /** Water on the track, 0..1 (from setWeather); every car's tires and spray follow it. */
  readonly wetness: number;
  /**
   * Split screen: the listener of seat 1 while two people listen (and its camera has been given), else null. `listener` is seat 0's
   * and is the one WebAudio hears with, so with a second listener every sound is worked out for the listener that hears it and moved
   * into the first one's frame (see spatial.ts, placeSplit).
   */
  readonly secondListener: ListenerState | null;
  nextSeed(): number;
  onDispose(car: CarSoundImpl): void;
}

export class CarSoundImpl implements CarSound {
  /** Set by the system each frame (opponent LOD). The player is always 2. */
  lod: Lod = 2;
  distance = 0;
  /** Last speed (m/s) and interior flag, read by the system for the rain ambience. */
  speed = 0;
  private frame: CarFrame;
  private nodes: CarNodes | null = null;
  /** 1 while the camera is in the cabin (player only; set through setInterior). */
  interior = 0;
  private seed: number;
  private disposed = false;
  private failed = false;
  private offTick = 0;
  private wasSilent = false;
  /** Split screen: where this car's sound goes in the real listener's frame (rewritten in place every frame). */
  private readonly placed: SplitPlace = makeSplitPlace();
  /** Split screen: which human's ears an opponent is placed for (it keeps them until the other human is clearly nearer). */
  private heardBy: 0 | 1 = 0;

  /** `seat`: the human a player's car belongs to (split screen; opponents ignore it). */
  constructor(
    private host: CarHost,
    readonly profile: EngineSoundProfile,
    readonly isPlayer: boolean,
    readonly seat: Seat = 0,
  ) {
    this.seed = host.nextSeed();
    this.frame = new CarFrame(isPlayer);
  }

  /** Build the voice now, behind a loading screen, not on the first update (or at least cache its calibration). */
  prime(): void {
    if (!this.ensureNodes() && !this.failed) calibratedExhaustGain(this.profile, this.host.ctx.sampleRate);
  }

  private ensureNodes(): boolean {
    if (this.nodes) return true;
    if (this.failed || !this.host.workletReady) return false;
    try {
      this.nodes = createCarNodes(this.host.ctx, this.host.graph, { profile: this.profile, isPlayer: this.isPlayer, seed: this.seed });
      return true;
    } catch (e) {
      this.failed = true;
      console.warn('[audio] could not create car voice:', e);
      return false;
    }
  }

  update(st: VehicleState, dt: number): void {
    if (this.disposed) return;
    const f = this.frame;
    // Split screen: a human's car is heard by its own human, an opponent by the nearer of the two (each against that human's camera),
    // and the human's cars are turned down so that two voices are not twice as loud as one. Alone, none of this is touched.
    const host = this.host;
    const second = host.secondListener;
    let heard = host.listener;
    if (second !== null) {
      const pos = st.position;
      const at = this.isPlayer ? this.seat : (this.heardBy = chooseHearer(heard, second, pos.x, pos.y, pos.z, this.heardBy));
      if (at === 1) heard = second;
    } else this.heardBy = 0;
    f.trim = second !== null && this.isPlayer ? SPLIT_PLAYER_TRIM : 1;
    f.compute(st, dt, heard, this.interior, this.isPlayer ? 2 : this.lod, host.paused, host.wetness);
    this.distance = f.sp.distance;
    this.speed = Number.isFinite(st.speed) ? st.speed : 0;
    if (!this.ensureNodes()) return;
    const n = this.nodes!;
    const v = f.vec;
    // a fully-off / paused voice only needs an occasional refresh
    const silent = v[CTL.GAIN] < 0.001 || (v[CTL.QUALITY] === 0 && v[CTL.CH_QUALITY] === 0);
    if (silent) {
      if (this.wasSilent && this.offTick++ % 15 !== 0) return;
    } else this.offTick = 0;
    this.wasSilent = silent;
    n.node.port.postMessage(v);
    if (second === null) {
      applySpatial(n, f.sp, st.position.x, st.position.y, st.position.z);
      return;
    }
    // split screen: the sound worked out for `heard` goes into the real listener's frame (the engine's place into `sp`, the car's own
    // place, for an opponent's chassis voice, apart)
    const sp = f.sp;
    const p = placeSplit(host.listener, heard, this.seat, this.isPlayer, sp, st.position.x, st.position.y, st.position.z, this.placed);
    sp.x = p.x;
    sp.y = p.y;
    sp.z = p.z;
    applySpatial(n, sp, p.cx, p.cy, p.cz);
  }

  setInterior(on: boolean): void {
    this.interior = on ? 1 : 0;
  }

  /** Immediately silence (system pause): push a zero-gain vector so the voice goes to sleep. */
  sleep(): void {
    if (!this.nodes) return;
    const v = this.frame.vec;
    v[CTL.GAIN] = 0;
    v[CTL.CH_GAIN] = 0;
    this.nodes.node.port.postMessage(v);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.nodes?.dispose();
    this.nodes = null;
    this.host.onDispose(this);
  }
}
