/**
 * Wiper model — the pure logic behind the cockpit wiper's sound. No Web Audio and no DOM, so the main thread, the
 * AudioWorklet DSP, the offline lab and the unit tests all share it.
 *
 *   WiperFeed      what the renderer tells the audio every frame: is the blade on screen, the windscreen pass's own clock
 *                  (the clock the shader draws the blade with) and the blade's place in its schedule
 *   SweepCommand   one sweep (out stroke + back stroke) for the worklet: an ABSOLUTE audio-clock frame, and the details that
 *                  make each sweep a little different from the last
 *   WiperPlanner   frame by frame: lay the picture's clock over the audio clock, and post every sweep a little ahead of time
 *
 * Sync. The schedule is a pure function of the droplet pass's clock (render/wet/droplets.ts: wiperState). The planner takes the
 * clock of each rendered frame together with the audio clock read at the same moment, keeps a smoothed offset between the two
 * and converts the start of the next sweep into an AudioContext frame number; the worklet then plays the whole sweep (swish,
 * motor, the thunks at the reversal and the park) from that one anchor, sample-accurately. Frame jitter, a hitch or a late
 * message can therefore not smear the strokes: a sweep that arrives late is simply joined part-way through, and a sweep that
 * is posted but has not started yet is moved (same id) whenever the offset between the clocks has changed under it (a long
 * frame makes the picture's clock fall behind the audio's). Only the sweep that is under way during a hitch stays where the
 * audio had it.
 */
import { Rng, clamp, clamp01, fin, lerp, smoothstep } from './dsp/util';

/** What the audio needs of the renderer's wiper (structurally a subset of render/wet/droplets.ts' WiperFeed). */
export interface WiperFeed {
  /** The blade is on screen this frame (cockpit view, the pass running, raining). */
  readonly drawn: boolean;
  /** The droplet pass's clock (seconds) as of the frame just rendered. */
  readonly time: number;
  readonly rain: number;
  readonly state: {
    /** Seconds into the cycle at `time`; a sweep starts at phase 0. */
    readonly phase: number;
    /** Seconds per cycle (two strokes plus the pause). */
    readonly period: number;
    /** Seconds per stroke. */
    readonly strokeTime: number;
  };
}

/** How far ahead of its start a sweep is posted to the worklet (s). */
export const WIPER_LOOKAHEAD_S = 0.28;
/** A sweep with less than this left is not joined (all that remains would be a stray thunk). */
export const WIPER_MIN_JOIN_S = 0.03;
/** A jump of the droplet clock bigger than this between two frames is a restart, not time passing (s). */
export const WIPER_MAX_STEP_S = 0.5;
/** The measured offset between the two clocks is followed slowly (frame to frame noise averaged out) unless it jumps. */
export const WIPER_OFFSET_ALPHA = 0.08;
export const WIPER_OFFSET_SNAP_S = 0.03;
/** A sweep that is already posted but not yet started is moved when the offset has taken its start more than this far off (s). */
export const WIPER_REISSUE_S = 0.004;
/** The motor keeps turning through a pause shorter than this (the storm's), and stops at the park position otherwise (s). */
export const WIPER_MOTOR_HOLD_DWELL_S = 0.6;
/** Prototype thunks per kind in the worklet's bank. */
export const WIPER_THUNK_VARIANTS = 6;
/** Seconds the picture may go without telling the audio about the blade before the sound is stopped. */
export const WIPER_STALE_S = 0.15;
/** How long after a frame is rendered it reaches the eye (about two refreshes of a 60 Hz screen), for the planner's `lead` (s). */
export const WIPER_DISPLAY_LATENCY_S = 0.03;

/** One sweep, as posted to the worklet. Plain numbers only (it is structured-cloned onto the audio thread). */
export interface SweepCommand {
  /**
   * Which sweep this is (1, 2, 3, ... from the planner; 0 = anonymous). Posting a sweep again with the same id moves one that has
   * not started yet (the planner does it when its idea of the offset between the clocks changes after a hitch); one that is
   * playing or has played is left alone.
   */
  id: number;
  /** AudioContext frame at which the blade leaves the park position. May be in the past: the voice joins part-way through. */
  f0: number;
  /** Frames per stroke. */
  strokeN: number;
  /** Pause (s) before the next sweep when the wiper keeps running; a short one keeps the motor turning. */
  dwell: number;
  /** Water on the glass, 0 (damp) .. 1 (a sheet). */
  wet: number;
  /** Linear gain on the whole sweep (the details below are small variations, drawn per sweep). */
  level: number;
  /** Pitch ratio of the motor and gear whine. */
  pitch: number;
  /** Brightness ratio of the swish. */
  bright: number;
  /** Linear gains of the swish on the out and on the back stroke. */
  outGain: number;
  backGain: number;
  /** The thunk at the far end (reversal) and the one at the park position: which prototype, and how hard. */
  revIdx: number;
  revGain: number;
  parkIdx: number;
  parkGain: number;
  /** A rubber squeak (kind 0) or chatter (kind 1) on one stroke: 0 = none. `sqStroke` 0 = out, 1 = back; `sqAt` 0..1 along it. */
  sqOn: number;
  sqStroke: number;
  sqAt: number;
  sqKind: number;
  sqFreq: number;
  sqLevel: number;
  /** Seconds. */
  sqDur: number;
  /** Seeds the voice's per-sweep randomness (squelch ticks, the whine's drift). */
  seed: number;
  /** Diagnostics only (the worklet ignores it): the droplet clock (s) at the start of this sweep. */
  cs: number;
}

/** Water on the glass, 0..1, from the rain: a film in the "rain" preset, a sheet in a storm. */
export function wetGlass(rain: number): number {
  return clamp01(Math.pow(clamp01(fin(rain, 0)), 0.8) * 1.05);
}

/** Chance that a sweep carries a rubber squeak or chatter: drier glass squeaks, a sheet of water does not. */
export function squeakChance(rain: number): number {
  return lerp(0.4, 0.04, smoothstep(0.4, 0.95, fin(rain, 0)));
}

/** Pause between sweeps (s) above which the motor stops at the park position. */
export function motorStops(dwell: number): boolean {
  return dwell > WIPER_MOTOR_HOLD_DWELL_S;
}

export function makeSweepCommand(): SweepCommand {
  return {
    id: 0,
    f0: 0,
    strokeN: 20160,
    dwell: 2.4,
    wet: 0.6,
    level: 1,
    pitch: 1,
    bright: 1,
    outGain: 1,
    backGain: 1,
    revIdx: 0,
    revGain: 1,
    parkIdx: 0,
    parkGain: 1,
    sqOn: 0,
    sqStroke: 1,
    sqAt: 0.8,
    sqKind: 0,
    sqFreq: 2600,
    sqLevel: 1,
    sqDur: 0.12,
    seed: 1,
    cs: 0,
  };
}

const DB = (x: number): number => Math.pow(10, x / 20);

/**
 * The details of one sweep, drawn from `rng` (always the same number of draws, so a seed gives the same run whatever the rain).
 * Small enough that every sweep is recognisably the same wiper, large enough that a storm's non-stop wiping is never a loop:
 * the whine moves by a few tenths of a semitone, the level by about a dB, the thunks differ in pitch and weight, and the odd
 * stroke squeaks or chatters when the glass is not wet enough to be silent.
 */
export function drawSweepDetails(c: SweepCommand, rng: Rng, rain: number): SweepCommand {
  const g = (): number => clamp(rng.g() / 1.7321, -1, 1); // bell-shaped on [-1, 1] (a third of a unit deviation)
  c.level = DB(1.8 * g());
  c.pitch = 1 + 0.035 * g();
  c.bright = 1 + 0.1 * g();
  c.outGain = DB(0.4 + 1.2 * g());
  c.backGain = DB(-0.6 + 1.2 * g());
  c.revIdx = Math.min(WIPER_THUNK_VARIANTS - 1, Math.floor(rng.u() * WIPER_THUNK_VARIANTS));
  c.revGain = 0.86 + 0.28 * rng.u();
  c.parkIdx = Math.min(WIPER_THUNK_VARIANTS - 1, Math.floor(rng.u() * WIPER_THUNK_VARIANTS));
  c.parkGain = 0.8 + 0.34 * rng.u();
  const sq = rng.u();
  const where = rng.u();
  const at = rng.u();
  const kind = rng.u();
  const freq = rng.u();
  const lvl = rng.u();
  const dur = rng.u();
  c.sqOn = sq < squeakChance(rain) ? 1 : 0;
  // the squeak comes when the blade slows: late in a stroke, and more often on the way back (the first stroke has cleared the water)
  c.sqStroke = where < 0.65 ? 1 : 0;
  c.sqAt = 0.55 + 0.35 * at;
  c.sqKind = kind < 0.55 ? 0 : 1;
  c.sqFreq = 2000 + 1600 * freq;
  c.sqLevel = 0.6 + 0.4 * lvl;
  c.sqDur = 0.07 + 0.11 * dur;
  c.seed = 1 + Math.floor(rng.u() * 1e9);
  return c;
}

/**
 * Lays the renderer's wiper clock over the audio clock and posts each sweep ahead of its start.
 *
 *   step(feed, audioNow, lead, post, onResync)
 *                                      once per rendered frame; calls post(sweep) for every sweep that starts within the
 *                                      look-ahead (and for the one in progress when the blade first comes into view);
 *                                      onResync() first, if the clock jumped
 *
 * `audioNow` is the audio clock (AudioContext.currentTime) read at the moment the frame was rendered; `lead` shifts the sound
 * for the delays between the two: the picture reaches the eye a little after it is rendered, the sound reaches the ear
 * outputLatency after it is scheduled (lead = display latency - output latency; 0 offline).
 */
export class WiperPlanner {
  /** Audio seconds = droplet-clock seconds + offset (smoothed). */
  offset = 0;
  /** Set by step(): the clock jumped (restarted, wrapped or the rain changed): what was posted no longer matches the picture. */
  resynced = false;
  /** Sweeps posted so far, and how many times a posted sweep was moved. */
  count = 0;
  moves = 0;
  private have = false;
  private lastD = 0;
  private lastRain = 0;
  private lastPeriod = 0;
  private postedCs = Number.NEGATIVE_INFINITY;
  private seq = 0;
  /** Posted sweeps that have not started yet (by the picture's clock): they follow the offset until they do. */
  private pending: SweepCommand[] = [];
  private readonly rng: Rng;

  constructor(
    readonly sampleRate: number,
    seed = 1,
  ) {
    this.rng = new Rng(seed * 2654435761 + 17);
  }

  /** Forget the clocks (the wiper went away): the next frame starts afresh. */
  reset(): void {
    this.have = false;
    this.postedCs = Number.NEGATIVE_INFINITY;
    this.pending.length = 0;
  }

  step(feed: WiperFeed, audioNow: number, lead: number, post: (c: SweepCommand, isNew: boolean) => void, onResync?: () => void): number {
    this.resynced = false;
    const st = feed.state;
    const d = feed.time;
    if (!(d >= 0) || !Number.isFinite(d) || !(st.period > 0) || !(st.strokeTime > 0) || !Number.isFinite(audioNow) || !Number.isFinite(st.phase)) return 0;
    if (this.have) {
      const dd = d - this.lastD;
      if (!(dd >= 0) || dd > WIPER_MAX_STEP_S || Math.abs(feed.rain - this.lastRain) > 1e-6 || Math.abs(st.period - this.lastPeriod) > 1e-9) {
        this.have = false;
        this.postedCs = Number.NEGATIVE_INFINITY;
        this.pending.length = 0;
        this.resynced = true;
        onResync?.(); // before anything new is posted: the caller silences what no longer fits the picture
      }
    }
    const cand = audioNow + (Number.isFinite(lead) ? lead : 0) - d;
    if (!this.have || Math.abs(cand - this.offset) > WIPER_OFFSET_SNAP_S) this.offset = cand;
    else this.offset += WIPER_OFFSET_ALPHA * (cand - this.offset);
    this.have = true;
    this.lastD = d;
    this.lastRain = feed.rain;
    this.lastPeriod = st.period;

    // sweeps already posted whose start is still ahead follow the offset (a hitch moves it; the sound stays on the picture)
    const sr = this.sampleRate;
    let keep = 0;
    for (let i = 0; i < this.pending.length; i++) {
      const c = this.pending[i];
      if (c.cs <= d + 0.001) continue; // started by the picture's clock: leave it be
      const f0 = Math.round((c.cs + this.offset) * sr);
      if (Math.abs(f0 - c.f0) > WIPER_REISSUE_S * sr) {
        c.f0 = f0;
        post(c, false);
        this.moves++;
      }
      this.pending[keep++] = c;
    }
    this.pending.length = keep;

    const out = st.strokeTime;
    const cs0 = d - st.phase;
    let n = 0;
    for (let k = 0; k < 3; k++) {
      const cs = cs0 + k * st.period;
      if (cs + 2 * out <= d + WIPER_MIN_JOIN_S) continue; // over (or about to be)
      if (cs - d > WIPER_LOOKAHEAD_S) break; // too early to post
      if (cs <= this.postedCs + 0.5 * st.period) continue; // posted already
      const c = this.command(cs, feed);
      post(c, true);
      if (cs > d) this.pending.push(c);
      this.postedCs = cs;
      n++;
    }
    this.count += n;
    return n;
  }

  private command(cs: number, feed: WiperFeed): SweepCommand {
    const st = feed.state;
    const c = makeSweepCommand();
    c.id = ++this.seq;
    c.cs = cs;
    c.f0 = Math.round((cs + this.offset) * this.sampleRate);
    c.strokeN = Math.max(1, Math.round(st.strokeTime * this.sampleRate));
    c.dwell = Math.max(0, st.period - 2 * st.strokeTime);
    c.wet = wetGlass(feed.rain);
    return drawSweepDetails(c, this.rng, feed.rain);
  }
}
