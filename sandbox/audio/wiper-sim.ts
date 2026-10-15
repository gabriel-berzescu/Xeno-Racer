/**
 * A simulated game loop for the cockpit wiper: frames of uneven length advance the droplet pass's clock exactly as the game
 * does (dt clamped to 0.0005..0.05 s, ticked only while the blade is drawn), the planner is fed the feed that
 * `XenoRenderSystem.wiper` would give, and the sweeps it posts are collected. Shared by the Node lab, the browser sandbox
 * (previews and report) and the unit tests, so all of them exercise the very planner the game runs.
 */
import { WiperPlanner, type SweepCommand } from '../../src/audio/wiper-model';
import { makeWiperFeed, wiperStateInto } from '../../src/render/wet/droplets';

export interface WiperSimOptions {
  seconds: number;
  /** The shader's uRain (a function of wall time for a weather that changes). */
  rain: number | ((t: number) => number);
  sampleRate?: number;
  fps?: number;
  /** Frame-time jitter: a frame lasts (1 / fps) * (1 + jitter * u), u uniform in [-1, 1]. */
  jitter?: number;
  /** Long frames: wall time (s) at which one happens, and how long it lasts (s). */
  hitches?: [number, number][];
  seed?: number;
  /** The droplet pass's clock when the simulation starts. */
  clock0?: number;
  /** Is the blade drawn (cockpit view) at wall time t? Default: always. */
  drawn?: (t: number) => boolean;
  /** Passed to the planner as `lead` (display latency - output latency). */
  lead?: number;
  /** The audio clock reads wall time + audioSkew (nothing may depend on the two agreeing). */
  audioSkew?: number;
  /** The audio clock only ticks in steps of this many seconds (a browser's currentTime moves in hardware-buffer steps). */
  audioQuantum?: number;
  plannerSeed?: number;
}

export interface WiperSimFrame {
  /** Wall time at the end of the frame (the audio clock reads this + audioSkew), and the droplet clock of that frame. */
  w: number;
  d: number;
  /** The droplet clock without the pass's 3600 s wrap (always increasing while the blade is drawn). */
  du: number;
  drawn: boolean;
}

export interface WiperSimResult {
  sweeps: SweepCommand[];
  /** Wall time at which each sweep was posted (parallel to `sweeps`). */
  postedAt: number[];
  frames: WiperSimFrame[];
  /** Wall times at which the planner reported a jump of the clock (what was posted no longer fits the picture). */
  resyncs: number[];
  /** Wall times at which the blade went out of view (the system stops the sound). */
  hidden: number[];
  /** Wall time at which the droplet clock reaches `d` (linear along the drawn frames, at rate 1 before the first and after the last); NaN in a gap. */
  wallAt(d: number): number;
  /** How many times a posted sweep that had not started was moved (after a hitch). */
  moves: number;
  planner: WiperPlanner;
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function simulateWiper(o: WiperSimOptions): WiperSimResult {
  const sr = o.sampleRate ?? 48000;
  const fps = o.fps ?? 60;
  const jitter = o.jitter ?? 0;
  const lead = o.lead ?? 0;
  const skew = o.audioSkew ?? 0;
  const q = o.audioQuantum ?? 0;
  const rnd = rng(o.seed ?? 1);
  const planner = new WiperPlanner(sr, o.plannerSeed ?? 1);
  const feed = makeWiperFeed();
  const sweeps: SweepCommand[] = [];
  const postedAt: number[] = [];
  const frames: WiperSimFrame[] = [];
  const resyncs: number[] = [];
  const hidden: number[] = [];
  const hitches = (o.hitches ?? []).slice().sort((a, b) => a[0] - b[0]);
  let hi = 0;
  let w = 0;
  let d = o.clock0 ?? 0;
  let du = d;
  let wasDrawn = false;
  while (w < o.seconds) {
    let dtw = (1 / fps) * (1 + jitter * (2 * rnd() - 1));
    while (hi < hitches.length && hitches[hi][0] <= w + dtw) dtw += hitches[hi++][1];
    w += dtw;
    const drawn = o.drawn ? o.drawn(w) : true;
    if (drawn) {
      const step = Math.min(0.05, Math.max(0.0005, dtw));
      d += step;
      du += step;
      if (d > 3600) d -= 3600;
    }
    const rain = typeof o.rain === 'function' ? o.rain(w) : o.rain;
    feed.drawn = drawn;
    feed.time = d;
    feed.rain = rain;
    wiperStateInto(feed.state, d, rain);
    frames.push({ w, d, du, drawn });
    if (drawn) {
      const clock = w + skew;
      const now = q > 0 ? Math.floor(clock / q) * q : clock;
      planner.step(feed, now, lead, (c, isNew) => {
        if (!isNew) return; // a sweep moved: the same command object, its f0 updated
        sweeps.push(c);
        postedAt.push(w);
      });
      if (planner.resynced) resyncs.push(w);
    } else {
      if (wasDrawn) hidden.push(w);
      planner.reset();
    }
    wasDrawn = drawn;
  }
  const wallAt = (target: number): number => {
    const first = frames[0];
    const last = frames[frames.length - 1];
    if (!first) return Number.NaN;
    // the pass's clock wraps at 3600 s: the target is a clock value, so look for it in the lap the run is in
    for (let k = 0; ; k++) {
      const t = target + 3600 * k;
      if (t > last.du + 1) return Number.NaN;
      if (t < first.du - 1) continue;
      if (t < first.du) return first.w + (t - first.du);
      if (t > last.du) return last.w + (t - last.du);
      for (let i = 1; i < frames.length; i++) {
        const a = frames[i - 1];
        const b = frames[i];
        if (a.drawn && b.drawn && a.du <= t && t <= b.du && b.du > a.du) return a.w + ((t - a.du) / (b.du - a.du)) * (b.w - a.w);
      }
      return Number.NaN; // in a gap (the blade was out of view)
    }
  };
  return { sweeps, postedAt, frames, resyncs, hidden, wallAt, moves: planner.moves, planner };
}

/** The key instants of a sweep, in seconds of the audio clock. */
export function sweepTimes(c: SweepCommand, sr: number): { start: number; reversal: number; park: number } {
  return { start: c.f0 / sr, reversal: (c.f0 + c.strokeN) / sr, park: (c.f0 + 2 * c.strokeN) / sr };
}
