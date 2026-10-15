/**
 * Cockpit wiper audio (headless, Node): the planner that lays the picture's clock over the audio clock and posts each sweep ahead
 * of time, the main-thread WiperSystem lifecycle, the wiper DSP voice (timing to the sample, the layers, levels against the cabin
 * rain, click-free starts and stops), and the worklet glue. The browser report (sandbox/audio.html?test=1&only=wiper) measures
 * the same things through the real graph.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { clickScore, hasNonFinite, peakAbs, powerSpectrum, rms, strongestPeak, welch, bandPower } from '../src/audio/analysis';
import { WeatherVoice } from '../src/audio/dsp/weather-voice';
import { WIPER_CAL, WiperVoice, buildWiperBank, getWiperBank, type WiperTrim } from '../src/audio/dsp/wiper-voice';
import { STREAM } from '../src/audio/weather-model';
import {
  type SweepCommand,
  WIPER_LOOKAHEAD_S,
  WIPER_MIN_JOIN_S,
  WIPER_STALE_S,
  WIPER_THUNK_VARIANTS,
  type WiperFeed,
  WiperPlanner,
  drawSweepDetails,
  makeSweepCommand,
  motorStops,
  squeakChance,
  wetGlass,
} from '../src/audio/wiper-model';
import { WIPER_NODE_KEEP_S, WiperSystem, type WiperHost, type WiperNodeLike } from '../src/audio/wiper';
import { Rng } from '../src/audio/dsp/util';
import { WIPER, type WiperFeed as RenderFeed, makeWiperFeed, wiperState, wiperStateInto } from '../src/render/wet/droplets';
import { simulateWiper, sweepTimes } from '../sandbox/audio/wiper-sim';

const SR = 48000;
const STROKE_N = Math.round(WIPER.OUT * SR);
const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-9));

// ── helpers ──────────────────────────────────────────────────────────────────

const ALL_OFF: WiperTrim = { swish: 0, tick: 0, whine: 0, buzz: 0, thunk: 0, squeak: 0 };
const only = (...k: (keyof WiperTrim)[]): WiperTrim => {
  const t = { ...ALL_OFF };
  for (const n of k) t[n] = 1;
  return t;
};

function cmd(over: Partial<SweepCommand> = {}): SweepCommand {
  return { ...makeSweepCommand(), f0: SR, strokeN: STROKE_N, ...over };
}

interface Rendered {
  l: Float32Array;
  r: Float32Array;
  v: WiperVoice;
}

/** Render the voice for `seconds` in 128-sample quanta, as the worklet does. `at(frame, voice)` runs before each quantum. */
function renderVoice(sweeps: SweepCommand[], seconds: number, trim?: Partial<WiperTrim>, at?: (frame: number, v: WiperVoice) => void, seed = 1, frame0 = 0): Rendered {
  const v = new WiperVoice(SR, seed);
  if (trim) Object.assign(v.trim, trim);
  for (const c of sweeps) v.queueSweep(c);
  const n = Math.floor(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let o = 0; o < n; o += 128) {
    at?.(frame0 + o, v);
    v.process(l.subarray(o, o + 128), r.subarray(o, o + 128), Math.min(128, n - o), frame0 + o);
  }
  return { l, r, v };
}

function mono(l: Float32Array, r: Float32Array): Float32Array {
  const m = new Float32Array(l.length);
  for (let i = 0; i < m.length; i++) m[i] = 0.5 * (l[i] + r[i]);
  return m;
}

function chanRms(l: Float32Array, r: Float32Array, a: number, b: number): number {
  return Math.max(rms(l, a, b), rms(r, a, b));
}

/** First sample at or after `from` whose magnitude (either channel) exceeds `thresh`; -1 if none before `to`. */
function firstAbove(l: Float32Array, r: Float32Array, from: number, to: number, thresh = 1e-9): number {
  for (let i = Math.max(0, from); i < Math.min(to, l.length); i++) if (Math.abs(l[i]) > thresh || Math.abs(r[i]) > thresh) return i;
  return -1;
}

/** Strongest spectral line in [f0, f1] Hz of the nfft samples from `start`, parabolic interpolation. */
function peakHz(x: Float32Array, start: number, nfft: number, f0: number, f1: number): number {
  return strongestPeak(powerSpectrum(x, start, nfft), SR, f0, f1).freq;
}

function pct(a: number[], p: number): number {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}

// ── the model ────────────────────────────────────────────────────────────────

describe('wiper model: per-sweep details', () => {
  it('wetness and the chance of a squeak follow the rain: a film in the "rain" preset, a sheet in a storm', () => {
    expect(wetGlass(0)).toBe(0);
    expect(wetGlass(0.55)).toBeGreaterThan(0.55);
    expect(wetGlass(0.55)).toBeLessThan(0.75);
    expect(wetGlass(1)).toBe(1);
    expect(wetGlass(Number.NaN)).toBe(0);
    for (let r = 0; r < 1; r += 0.05) expect(wetGlass(r + 0.05)).toBeGreaterThanOrEqual(wetGlass(r));
    // drier glass squeaks more
    expect(squeakChance(0.2)).toBeGreaterThan(squeakChance(0.55));
    expect(squeakChance(0.55)).toBeGreaterThan(squeakChance(1) * 4);
    expect(squeakChance(0.55)).toBeGreaterThan(0.2);
    expect(squeakChance(0.55)).toBeLessThan(0.45);
    expect(squeakChance(1)).toBeLessThan(0.08);
    // the motor stops at the park position in the rain, keeps turning through a storm's pause
    expect(motorStops(WIPER.DWELL_LIGHT)).toBe(true);
    expect(motorStops(WIPER.DWELL_STORM)).toBe(false);
  });

  it('every sweep is a little different, within bounds, and the same for the same seed', () => {
    const draw = (seed: number, rain: number, n: number): SweepCommand[] => {
      const rng = new Rng(seed);
      return Array.from({ length: n }, () => drawSweepDetails(makeSweepCommand(), rng, rain));
    };
    const a = draw(5, 1, 300);
    for (const c of a) {
      for (const k of Object.keys(c) as (keyof SweepCommand)[]) expect(Number.isFinite(c[k]), k).toBe(true);
      expect(Math.abs(db(c.level))).toBeLessThanOrEqual(1.81);
      expect(Math.abs(c.pitch - 1)).toBeLessThanOrEqual(0.0351);
      expect(Math.abs(c.bright - 1)).toBeLessThanOrEqual(0.101);
      expect(c.revIdx).toBeGreaterThanOrEqual(0);
      expect(c.revIdx).toBeLessThan(WIPER_THUNK_VARIANTS);
      expect(c.parkIdx).toBeGreaterThanOrEqual(0);
      expect(c.parkIdx).toBeLessThan(WIPER_THUNK_VARIANTS);
      expect(c.revGain).toBeGreaterThanOrEqual(0.85);
      expect(c.revGain).toBeLessThanOrEqual(1.15);
      expect(c.sqAt).toBeGreaterThanOrEqual(0.55);
      expect(c.sqAt).toBeLessThanOrEqual(0.9);
      expect(c.sqFreq).toBeGreaterThanOrEqual(2000);
      expect(c.sqFreq).toBeLessThanOrEqual(3600);
      expect(c.sqDur).toBeGreaterThanOrEqual(0.07);
      expect(c.sqDur).toBeLessThanOrEqual(0.18);
    }
    // spread: the whine moves by a few tenths of a semitone from sweep to sweep, all thunks get used, the odd one squeaks
    const sd = (xs: number[]): number => {
      const m = xs.reduce((s, x) => s + x, 0) / xs.length;
      return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
    };
    expect(sd(a.map((c) => c.pitch))).toBeGreaterThan(0.008);
    expect(sd(a.map((c) => db(c.level)))).toBeGreaterThan(0.4);
    expect(new Set(a.map((c) => c.revIdx)).size).toBe(WIPER_THUNK_VARIANTS);
    expect(new Set(a.map((c) => c.parkIdx)).size).toBe(WIPER_THUNK_VARIANTS);
    expect(new Set(a.map((c) => c.pitch.toFixed(7))).size).toBeGreaterThan(295);
    for (let i = 1; i < a.length; i++) expect(a[i].pitch === a[i - 1].pitch && a[i].level === a[i - 1].level && a[i].revIdx === a[i - 1].revIdx).toBe(false);
    expect(draw(5, 1, 50)).toEqual(a.slice(0, 50));
    expect(draw(6, 1, 50)).not.toEqual(a.slice(0, 50));
    // squeaks: about a third of the sweeps on the "rain" preset's film of water, hardly any in a storm
    const share = (rain: number): number => draw(11, rain, 4000).filter((c) => c.sqOn).length / 4000;
    expect(share(0.55)).toBeGreaterThan(0.27);
    expect(share(0.55)).toBeLessThan(0.4);
    expect(share(1)).toBeLessThan(0.07);
    expect(share(0.2)).toBeGreaterThan(share(0.55));
    // ... and they come late in a stroke, more often on the way back
    const sq = draw(12, 0.55, 4000).filter((c) => c.sqOn);
    expect(sq.filter((c) => c.sqStroke === 1).length / sq.length).toBeGreaterThan(0.55);
    expect(sq.some((c) => c.sqKind === 0) && sq.some((c) => c.sqKind === 1)).toBe(true);
  });
});

// ── the planner: the picture's clock laid over the audio clock ───────────────

describe('WiperPlanner: the sweeps land on the stroke boundaries of the picture\'s blade', () => {
  /** Largest |audio time of the sweep start - when the picture's clock reaches it| over the sweeps `pick` selects. */
  function worstError(sim: ReturnType<typeof simulateWiper>, skew = 0, lead = 0, pick: (i: number) => boolean = () => true): number {
    let worst = 0;
    sim.sweeps.forEach((c, i) => {
      if (!pick(i)) return;
      const truth = sim.wallAt(c.cs) + skew + lead;
      worst = Math.max(worst, Math.abs(c.f0 / SR - truth));
    });
    return worst;
  }

  for (const [name, rain, period] of [
    ['"rain" preset (a 2.4 s pause)', 0.55, 3.24],
    ['storm (a 0.12 s pause)', 1, 0.96],
  ] as const) {
    it(`${name}: every sweep is posted exactly once, ahead of its start, and starts when the picture's blade does (jittery frames)`, () => {
      const seconds = 60;
      const sim = simulateWiper({ seconds, rain, fps: 60, jitter: 0.35, seed: 3, clock0: 0.123 });
      const expected = Math.floor((seconds - 0.123) / period);
      expect(sim.sweeps.length).toBeGreaterThanOrEqual(expected);
      expect(sim.sweeps.length).toBeLessThanOrEqual(expected + 2);
      // each cycle once: the clock-time starts are an arithmetic progression of the period
      for (let i = 1; i < sim.sweeps.length; i++) expect(sim.sweeps[i].cs - sim.sweeps[i - 1].cs).toBeCloseTo(period, 6);
      // lands on the picture's blade, to well under a millisecond (a steady clock: nothing to correct)
      expect(worstError(sim)).toBeLessThan(0.001);
      // and every sweep after the first was posted before it began, by no more than the look-ahead + a frame
      sim.sweeps.forEach((c, i) => {
        if (i === 0) return;
        const lead = c.f0 / SR - sim.postedAt[i];
        expect(lead).toBeGreaterThan(0);
        expect(lead).toBeLessThanOrEqual(WIPER_LOOKAHEAD_S + 0.001);
      });
      // the stroke length and the pause the voice is given are the picture's
      for (const c of sim.sweeps) {
        expect(c.strokeN).toBe(STROKE_N);
        expect(c.dwell).toBeCloseTo(period - 2 * WIPER.OUT, 9);
        expect(c.wet).toBeCloseTo(wetGlass(rain), 9);
      }
    });
  }

  it('reversal and park instants (what the thunks hit) are the shader\'s turn-round and rest instants', () => {
    // the blade of the picture at the planned reversal instant is at the far end, at the planned park instant back at its park angle
    for (const rain of [0.55, 1]) {
      const sim = simulateWiper({ seconds: 20, rain, fps: 60, jitter: 0.2, seed: 8 });
      const s = makeWiperFeed().state;
      for (const c of sim.sweeps) {
        const t = sweepTimes(c, SR);
        // droplet clock at those audio instants (the audio clock is the wall clock here)
        const dev = (tAudio: number): number => {
          let d = Number.NaN;
          for (let i = 1; i < sim.frames.length; i++) {
            const a = sim.frames[i - 1];
            const b = sim.frames[i];
            if (a.w <= tAudio && tAudio <= b.w) d = a.d + ((tAudio - a.w) / (b.w - a.w)) * (b.d - a.d);
          }
          return d;
        };
        const dRev = dev(t.reversal);
        const dPark = dev(t.park);
        if (!Number.isFinite(dRev) || !Number.isFinite(dPark)) continue;
        wiperStateInto(s, dRev, rain);
        expect(s.angle).toBeGreaterThan(WIPER.A1 - 0.01); // at the far end
        wiperStateInto(s, dPark, rain);
        expect(s.angle).toBeLessThan(WIPER.A0 + 0.01); // back at rest
      }
    }
  });

  it('does not depend on the audio clock agreeing with anything: any skew, and a step-wise clock', () => {
    const base = simulateWiper({ seconds: 30, rain: 1, fps: 60, jitter: 0.3, seed: 4 });
    const skewed = simulateWiper({ seconds: 30, rain: 1, fps: 60, jitter: 0.3, seed: 4, audioSkew: 123.456 });
    expect(worstError(skewed, 123.456)).toBeLessThan(0.001);
    expect(skewed.sweeps.map((c) => c.f0 - Math.round(123.456 * SR))).toEqual(base.sweeps.map((c) => c.f0));
    // `lead` shifts the sound by exactly that much
    const led = simulateWiper({ seconds: 30, rain: 1, fps: 60, jitter: 0.3, seed: 4, lead: 0.03 });
    expect(worstError(led, 0, 0.03)).toBeLessThan(0.001);
    // an audio clock that only moves in 10 ms steps (currentTime): the smoothed offset keeps the error to about the step
    const steps = simulateWiper({ seconds: 60, rain: 1, fps: 60, jitter: 0.3, seed: 4, audioQuantum: 0.01 });
    expect(worstError(steps, 0, 0, (i) => i > 3)).toBeLessThan(0.0105);
    // ... and cannot drift: the first and last sweeps are off by about the same
    const err = (i: number): number => steps.sweeps[i].f0 / SR - steps.wallAt(steps.sweeps[i].cs);
    expect(Math.abs(err(steps.sweeps.length - 1) - err(3))).toBeLessThan(0.0105);
  });

  it('a long frame (the game clamps dt to 50 ms, so the picture falls behind) is followed: sweeps not yet started are moved onto the blade, the one under way is off by what was lost', () => {
    const hitches: [number, number][] = [
      [10.3, 0.2],
      [25.1, 0.45],
    ];
    const sim = simulateWiper({ seconds: 40, rain: 1, fps: 60, jitter: 0.2, seed: 9, hitches });
    expect(sim.moves).toBeGreaterThan(0);
    sim.sweeps.forEach((c, i) => {
      const startWall = sim.wallAt(c.cs);
      const err = Math.abs(c.f0 / SR - startWall);
      // under way (or about to start) at a hitch: the picture lost the time the long frame took beyond its 50 ms clamp
      const hit = hitches.find(([at, len]) => startWall < at + len + 0.1 && startWall + 2 * WIPER.OUT > at);
      if (hit) expect(err, `sweep ${i} under way at the hitch at ${hit[0]}`).toBeLessThan(hit[1] + 0.025 - 0.05 + 0.004);
      else expect(err, `sweep ${i}`).toBeLessThan(0.002);
    });
    // no sweep was lost or doubled across them
    for (let i = 1; i < sim.sweeps.length; i++) expect(sim.sweeps[i].cs - sim.sweeps[i - 1].cs).toBeCloseTo(0.96, 6);
    // ids count the sweeps; a moved sweep keeps its id
    sim.sweeps.forEach((c, i) => expect(c.id).toBe(i + 1));
  });

  it('a steady clock never moves a posted sweep; a long frame moves the ones still to come once, by what was lost', () => {
    const calm = simulateWiper({ seconds: 40, rain: 1, fps: 60, jitter: 0.4, seed: 5 });
    expect(calm.moves).toBe(0);
    const quant = simulateWiper({ seconds: 40, rain: 1, fps: 60, jitter: 0.4, seed: 5, audioQuantum: 0.01 });
    expect(quant.moves).toBeLessThan(3); // 10 ms steps of the audio clock do not make the planner nervous
    const hit = simulateWiper({ seconds: 20, rain: 1, fps: 60, jitter: 0.1, seed: 5, hitches: [[10.3, 0.3]] });
    expect(hit.moves).toBeGreaterThan(0);
    expect(hit.moves).toBeLessThan(8);
  });

  it('comes into view part-way through a sweep: that sweep is joined where the picture\'s blade is', () => {
    for (const [clock0, stroke] of [
      [0.2, 'out'],
      [0.6, 'back'],
    ] as const) {
      const sim = simulateWiper({ seconds: 2, rain: 0.55, fps: 60, jitter: 0, seed: 1, clock0 });
      const first = sim.sweeps[0];
      const w0 = sim.frames[0].w; // the first frame the blade was drawn
      const d0 = sim.frames[0].d;
      expect(wiperState(d0, 0.55).stroke).toBe(stroke);
      // the sweep began (clock0 + one frame) earlier than the frame it was posted on
      expect(first.f0 / SR).toBeCloseTo(w0 - wiperState(d0, 0.55).phase, 3);
      expect(first.f0 / SR).toBeLessThan(w0);
    }
    // joining when only the pause remains posts nothing until the next sweep is within the look-ahead
    const sim = simulateWiper({ seconds: 4, rain: 0.55, fps: 60, jitter: 0, seed: 1, clock0: 1.0 });
    expect(sim.postedAt[0]).toBeGreaterThan(3.24 - 1.0 - WIPER_LOOKAHEAD_S - 0.05);
    expect(sim.sweeps[0].f0 / SR).toBeGreaterThan(sim.postedAt[0]);
    // a sweep with almost nothing left is not worth joining
    const late = simulateWiper({ seconds: 1, rain: 0.55, fps: 60, jitter: 0, seed: 1, clock0: 2 * WIPER.OUT - WIPER_MIN_JOIN_S * 0.5 });
    expect(late.sweeps.length).toBe(0);
  });

  it('no sound while the blade is out of view; it picks up again where the picture is when it comes back', () => {
    const sim = simulateWiper({ seconds: 20, rain: 1, fps: 60, jitter: 0.2, seed: 2, drawn: (t) => !(t > 6.0 && t < 11.0) });
    expect(sim.hidden.length).toBe(1);
    expect(sim.hidden[0]).toBeGreaterThan(6.0);
    for (const t of sim.postedAt) expect(t < 6.0 + 0.02 || t > 11.0 - 0.02).toBe(true);
    // while it is hidden the picture's clock stands still; the sweeps before and after are one period of the clock apart
    const before = sim.sweeps.filter((_, i) => sim.postedAt[i] < 6).pop()!;
    const after = sim.sweeps.find((_, i) => sim.postedAt[i] > 11)!;
    expect(after.f0 / SR + 2 * WIPER.OUT).toBeGreaterThan(11); // the first one back is the sweep under way (or the next)
    expect(((after.cs - before.cs) / 0.96) % 1).toBeCloseTo(0, 6);
    expect(worstError(sim, 0, 0, (i) => sim.postedAt[i] > 11.2)).toBeLessThan(0.001);
  });

  it('a jump of the clock (the pass restarted, 3600 s wrapped, the rain changed) re-plans once, without a double or a gap', () => {
    // the 3600 s wrap of the droplet clock
    const wrap = simulateWiper({ seconds: 6, rain: 1, fps: 60, jitter: 0, seed: 1, clock0: 3598.5 });
    expect(wrap.resyncs.length).toBe(1);
    expect(wrap.resyncs[0]).toBeGreaterThan(1.4);
    expect(wrap.resyncs[0]).toBeLessThan(1.6);
    for (let i = 1; i < wrap.sweeps.length; i++) if (wrap.postedAt[i - 1] > wrap.resyncs[0]) expect(wrap.sweeps[i].f0).toBeGreaterThan(wrap.sweeps[i - 1].f0);
    // after the jump, the sweeps are on the picture's blade again
    const worst = Math.max(...wrap.sweeps.map((c, i) => (wrap.postedAt[i] >= wrap.resyncs[0] ? Math.abs(c.f0 / SR - wrap.wallAt(c.cs)) : 0)));
    expect(worst).toBeLessThan(0.001);
    // the rain changes from the preset to the storm: the period changes, so the whole schedule does
    const rainy = simulateWiper({ seconds: 12, rain: (t) => (t < 6 ? 0.55 : 1), fps: 60, jitter: 0, seed: 1 });
    expect(rainy.resyncs.length).toBe(1);
    expect(rainy.sweeps.filter((c) => c.dwell > 1).length).toBeGreaterThanOrEqual(2);
    expect(rainy.sweeps.filter((c) => c.dwell < 0.2).length).toBeGreaterThanOrEqual(4);
  });

  it('garbage in, nothing out: NaN clocks, zero periods, a dead audio clock', () => {
    const p = new WiperPlanner(SR, 1);
    const f = makeWiperFeed();
    const post = vi.fn();
    wiperStateInto(f.state, 1, 1);
    f.drawn = true;
    f.time = Number.NaN;
    expect(p.step(f, 0, 0, post)).toBe(0);
    f.time = 1;
    expect(p.step(f, Number.NaN, 0, post)).toBe(0);
    const bad: WiperFeed = { drawn: true, time: 1, rain: 1, state: { phase: 0.1, period: 0, strokeTime: 0.42 } };
    expect(p.step(bad, 0, 0, post)).toBe(0);
    expect(post).not.toHaveBeenCalled();
    // a NaN lead is ignored
    f.time = 1;
    expect(p.step(f, 5, Number.NaN, post)).toBeGreaterThanOrEqual(0);
    for (const [c] of post.mock.calls) for (const k of Object.keys(c) as (keyof SweepCommand)[]) expect(Number.isFinite(c[k])).toBe(true);
  });

  it('the details vary from sweep to sweep (storm: no loop) and are repeatable for a seed', () => {
    const a = simulateWiper({ seconds: 70, rain: 1, fps: 60, jitter: 0.2, seed: 1, plannerSeed: 7 });
    const b = simulateWiper({ seconds: 70, rain: 1, fps: 60, jitter: 0.2, seed: 1, plannerSeed: 7 });
    const c = simulateWiper({ seconds: 70, rain: 1, fps: 60, jitter: 0.2, seed: 1, plannerSeed: 8 });
    expect(a.sweeps.length).toBeGreaterThan(65);
    expect(a.sweeps.map((x) => [x.pitch, x.level, x.revIdx, x.parkIdx, x.seed])).toEqual(b.sweeps.map((x) => [x.pitch, x.level, x.revIdx, x.parkIdx, x.seed]));
    expect(a.sweeps.map((x) => x.pitch)).not.toEqual(c.sweeps.map((x) => x.pitch));
    expect(new Set(a.sweeps.map((x) => x.pitch)).size).toBe(a.sweeps.length);
    expect(new Set(a.sweeps.map((x) => `${x.revIdx}/${x.parkIdx}`)).size).toBeGreaterThan(12);
  });
});

// ── the main-thread system ───────────────────────────────────────────────────

class MockNode implements WiperNodeLike {
  log: string[] = [];
  sweeps: SweepCommand[] = [];
  disposed = 0;
  stops = 0;
  gains: number[] = [];
  sweep(c: SweepCommand): void {
    this.sweeps.push(c);
    this.log.push('sweep');
  }
  stop(): void {
    this.stops++;
    this.log.push('stop');
  }
  gain(g: number): void {
    this.gains.push(g);
  }
  dispose(): void {
    this.disposed++;
  }
}

interface Rig {
  sys: WiperSystem;
  nodes: MockNode[];
  host: { ready: boolean; running: boolean; muted: boolean; rain: number; now: number; lead: number };
  /** One game frame: advance the clocks by dt, tick the droplet pass's clock, hand the feed to the system, then the audio update. */
  frame: (dt?: number, drawn?: boolean, rain?: number) => void;
  feed: RenderFeed;
}

function makeRig(): Rig {
  const nodes: MockNode[] = [];
  const host = { ready: true, running: true, muted: false, rain: 1, now: 100, lead: 0 };
  const h: WiperHost = {
    ready: () => host.ready,
    running: () => host.running,
    muted: () => host.muted,
    rain: () => host.rain,
    now: () => host.now,
    lead: () => host.lead,
    makeNode: () => {
      const n = new MockNode();
      nodes.push(n);
      return n;
    },
  };
  const sys = new WiperSystem(h, SR, 3);
  const feed = makeWiperFeed();
  let clock = 0;
  return {
    sys,
    nodes,
    host,
    feed,
    frame(dt = 1 / 60, drawn = true, rain = 1): void {
      host.now += dt;
      if (drawn) clock += dt;
      feed.drawn = drawn;
      feed.time = clock;
      feed.rain = rain;
      wiperStateInto(feed.state, clock, rain);
      sys.feed(feed);
      sys.update(dt);
    },
  };
}

describe('WiperSystem: node lifecycle, sweeps, stopping cleanly', () => {
  const run = (rig: Rig, seconds: number, drawn = true, rain = 1): void => {
    for (let i = 0; i < Math.round(seconds * 60); i++) rig.frame(1 / 60, drawn, rain);
  };

  it('does nothing while the blade is not on screen, it is dry, the context is not running or the game is muted', () => {
    const rig = makeRig();
    run(rig, 2, false);
    expect(rig.nodes.length).toBe(0);
    run(rig, 2, true, 0); // no rain: the feed says it is drawn but dry
    expect(rig.nodes.length).toBe(0);
    rig.host.rain = 0; // the weather target says dry
    run(rig, 2, true, 1);
    expect(rig.nodes.length).toBe(0);
    rig.host.rain = 1;
    rig.host.running = false;
    run(rig, 2);
    expect(rig.nodes.length).toBe(0);
    rig.host.running = true;
    rig.host.muted = true;
    run(rig, 2);
    expect(rig.nodes.length).toBe(0);
    expect(rig.sys.active).toBe(false);
  });

  it('creates the node only once the blade is drawn in the rain and the worklet is loaded, then reuses it', () => {
    const rig = makeRig();
    rig.host.ready = false;
    run(rig, 1);
    expect(rig.nodes.length).toBe(0); // worklet not loaded yet
    rig.host.ready = true;
    run(rig, 0.1);
    expect(rig.nodes.length).toBe(1);
    expect(rig.sys.active).toBe(true);
    expect(rig.sys.following).toBe(true);
    run(rig, 5);
    expect(rig.nodes.length).toBe(1);
    expect(rig.nodes[0].sweeps.length).toBeGreaterThanOrEqual(5); // a sweep a second in a storm
  });

  it('posts each sweep once, ahead of its start, on the audio clock (frames of the context)', () => {
    const rig = makeRig();
    run(rig, 12);
    const n = rig.nodes[0];
    expect(n.sweeps.length).toBeGreaterThanOrEqual(11);
    for (let i = 1; i < n.sweeps.length; i++) expect(Math.abs((n.sweeps[i].f0 - n.sweeps[i - 1].f0) / SR - 0.96)).toBeLessThan(0.002);
    // the first sweep posted when the blade came into view is already under way (the clock started at 0): f0 is not in the future
    expect(n.sweeps[0].f0 / SR).toBeLessThanOrEqual(rig.host.now);
    // the log keeps the last few for diagnostics
    expect(rig.sys.log.length).toBeGreaterThan(5);
    expect(rig.sys.log[rig.sys.log.length - 1].cmd).toBe(n.sweeps[n.sweeps.length - 1]);
    expect(rig.sys.sweeps).toBe(n.sweeps.length);
    let seen = 0;
    rig.sys.onSweep = () => seen++;
    run(rig, 3);
    expect(seen).toBeGreaterThanOrEqual(2);
  });

  it('stops the sound the moment the blade leaves the picture (the camera), and never posts again until it is back', () => {
    const rig = makeRig();
    run(rig, 3);
    const n = rig.nodes[0];
    const posted = n.sweeps.length;
    expect(n.stops).toBe(0);
    run(rig, 0.1, false); // camera: chase
    expect(n.stops).toBe(1);
    run(rig, 3, false);
    expect(n.sweeps.length).toBe(posted);
    expect(n.stops).toBe(1); // once
    run(rig, 3, true);
    expect(rig.nodes.length).toBe(1); // the same node
    expect(n.sweeps.length).toBeGreaterThan(posted);
  });

  it('stops when the game pauses, when the rain is over and when the picture stops reporting', () => {
    const rig = makeRig();
    run(rig, 2);
    const n = rig.nodes[0];
    rig.host.muted = true;
    rig.sys.sleep();
    expect(n.stops).toBe(1);
    run(rig, 1); // frames keep arriving while paused: nothing is posted
    const posted = n.sweeps.length;
    run(rig, 1);
    expect(n.sweeps.length).toBe(posted);
    rig.host.muted = false;
    run(rig, 2);
    expect(n.sweeps.length).toBeGreaterThan(posted);
    // rain over (setWeather(0, 0)): the weather target goes to 0 while frames are still fed
    const before = n.stops;
    rig.host.rain = 0;
    rig.frame(1 / 60, true, 1);
    expect(n.stops).toBe(before + 1);
    rig.host.rain = 1;
    run(rig, 1);
    // the picture stops reporting (a replay, the menu, a long hitch): only the audio update runs
    const stops = n.stops;
    for (let i = 0; i < 60; i++) {
      rig.host.now += 1 / 60;
      rig.sys.update(1 / 60);
      if (i * (1 / 60) < WIPER_STALE_S - 0.03) expect(n.stops).toBe(stops);
    }
    expect(n.stops).toBe(stops + 1);
  });

  it('drops the node a few seconds after the blade has gone, and builds a new one when it comes back', () => {
    const rig = makeRig();
    run(rig, 2);
    run(rig, WIPER_NODE_KEEP_S - 0.5, false);
    expect(rig.sys.active).toBe(true);
    expect(rig.nodes[0].disposed).toBe(0);
    run(rig, 1.5, false);
    expect(rig.sys.active).toBe(false);
    expect(rig.nodes[0].disposed).toBe(1);
    run(rig, 5, false);
    expect(rig.nodes[0].disposed).toBe(1); // exactly once
    run(rig, 1);
    expect(rig.nodes.length).toBe(2);
    expect(rig.sys.active).toBe(true);
    // a short look away does not rebuild it
    run(rig, 1, false);
    run(rig, 1);
    expect(rig.nodes.length).toBe(2);
  });

  it('a clock jump silences what no longer fits the picture BEFORE the new sweeps go out', () => {
    const rig = makeRig();
    run(rig, 3);
    const n = rig.nodes[0];
    n.log.length = 0;
    // the pass is rebuilt (quality change): its clock restarts at 0
    rig.feed.time = 0;
    wiperStateInto(rig.feed.state, 0, 1);
    rig.host.now += 1 / 60;
    rig.sys.feed(rig.feed);
    const iStop = n.log.indexOf('stop');
    const iSweep = n.log.indexOf('sweep');
    expect(iStop).toBe(0);
    expect(iSweep).toBeGreaterThan(iStop);
  });

  it('survives a node factory that throws: warns once and does not retry every frame; dispose() ends everything', () => {
    let calls = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const host: WiperHost = {
      ready: () => true,
      running: () => true,
      muted: () => false,
      rain: () => 1,
      now: () => 10,
      lead: () => 0,
      makeNode: () => {
        calls++;
        throw new Error('no worklet');
      },
    };
    const sys = new WiperSystem(host, SR, 1);
    const f = makeWiperFeed();
    f.drawn = true;
    f.rain = 1;
    for (let i = 0; i < 120; i++) {
      f.time = i / 60;
      wiperStateInto(f.state, f.time, 1);
      sys.feed(f);
      sys.update(1 / 60);
    }
    expect(calls).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    expect(sys.active).toBe(false);
    const rig = makeRig();
    run(rig, 1);
    rig.sys.dispose();
    expect(rig.nodes[0].disposed).toBe(1);
    const posted = rig.nodes[0].sweeps.length;
    run(rig, 2);
    expect(rig.nodes[0].sweeps.length).toBe(posted);
  });

  it('is cheap: a frame costs microseconds', () => {
    const rig = makeRig();
    run(rig, 3);
    const t0 = performance.now();
    for (let i = 0; i < 20000; i++) rig.frame(1 / 60);
    const perFrameUs = ((performance.now() - t0) / 20000) * 1000;
    expect(perFrameUs).toBeLessThan(50);
  });
});

describe('index.ts: setWiper', () => {
  it('hands the feed to a system with a wiper and says no to one without (the silent fallback)', async () => {
    const { setWiper } = await import('../src/audio');
    const rig = makeRig();
    const fake = { wiper: rig.sys } as unknown as import('../src/core/systems').AudioSystem;
    rig.feed.drawn = true;
    rig.feed.rain = 1;
    expect(setWiper(fake, rig.feed)).toBe(true);
    expect(rig.nodes.length).toBe(1);
    expect(setWiper({} as import('../src/core/systems').AudioSystem, rig.feed)).toBe(false);
  });
});

// ── the voice ────────────────────────────────────────────────────────────────

describe('WiperVoice: silence, timing to the sample', () => {
  it('is silent (exact zeros) and asleep until the first sweep, and again after it', () => {
    const { l, r, v } = renderVoice([], 1);
    expect(peakAbs(l) + peakAbs(r)).toBe(0);
    expect(v.awake).toBe(false);
    const run = renderVoice([cmd()], 4);
    expect(peakAbs(run.l.subarray(0, SR - 1)) + peakAbs(run.r.subarray(0, SR - 1))).toBe(0); // nothing before f0
    expect(run.v.awake).toBe(false); // the sweep is over
    expect(peakAbs(run.l.subarray(Math.floor(3.5 * SR))) + peakAbs(run.r.subarray(Math.floor(3.5 * SR)))).toBe(0);
    expect(hasNonFinite(run.l) || hasNonFinite(run.r)).toBe(false);
  });

  it('every thunk starts on exactly the scheduled sample, whatever the alignment to the 128-sample quantum', () => {
    const rnd = new Rng(99);
    const starts = [0, 1, 127, 128, 129, 20160, 40320, 128 * 321, 128 * 321 + 64, SR + 37];
    for (let i = 0; i < 12; i++) starts.push(Math.floor(rnd.u() * 90000));
    for (const f0 of starts) {
      const c = cmd({ f0, revIdx: f0 % WIPER_THUNK_VARIANTS, parkIdx: (f0 + 3) % WIPER_THUNK_VARIANTS });
      const { l, r } = renderVoice([c], f0 / SR + 1.2, only('thunk'));
      const rev = c.f0 + c.strokeN;
      const park = c.f0 + 2 * c.strokeN;
      expect(firstAbove(l, r, c.f0, rev - 1), `silence before the reversal (f0 ${f0})`).toBe(-1);
      expect(firstAbove(l, r, rev - 50, rev + 400), `reversal (f0 ${f0})`).toBe(rev);
      expect(firstAbove(l, r, rev + 12000, park - 1), `silence between the thunks (f0 ${f0})`).toBe(-1);
      expect(firstAbove(l, r, park - 50, park + 400), `park (f0 ${f0})`).toBe(park);
    }
  });

  it('the swish and the motor start with the sweep (zero at the first sample, rising), and are gone with it', () => {
    const c = cmd();
    const { l, r } = renderVoice([c], 3, only('swish', 'whine', 'buzz'));
    const a = firstAbove(l, r, 0, 3 * SR, 1e-7);
    expect(a).toBeGreaterThanOrEqual(c.f0);
    expect(a).toBeLessThan(c.f0 + 0.03 * SR);
    expect(chanRms(l, r, c.f0 + 0.15 * SR, c.f0 + 0.25 * SR)).toBeGreaterThan(chanRms(l, r, c.f0, c.f0 + 0.02 * SR) * 5);
    // 1 s after the end (the motor has wound down): nothing
    expect(db(chanRms(l, r, c.f0 + 2 * STROKE_N + SR, 3 * SR))).toBeLessThan(-140);
  });
});

describe('WiperVoice: what each layer does', () => {
  it('the swish swells and dies with the blade\'s speed (sin(pi u)) on each stroke, brighter at mid-stroke', () => {
    const cmds = Array.from({ length: 6 }, (_, i) => cmd({ f0: SR + i * 3 * SR, wet: 0.65, seed: i + 1 }));
    const { l, r } = renderVoice(cmds, 20, only('swish'));
    const us = [0.04, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.96];
    const win = Math.round(0.016 * SR);
    const env = us.map((u) => {
      let e = 0;
      let n = 0;
      for (const c of cmds) {
        for (const back of [0, 1]) {
          const a = Math.round(c.f0 + (back + u) * c.strokeN - win / 2);
          const x = chanRms(l, r, a, a + win);
          e += x * x;
          n++;
        }
      }
      return Math.sqrt(e / n);
    });
    // proportional to v^1.25 (v = sin(pi u)), v at the middle of each window
    const model = us.map((u) => Math.pow(Math.sin(Math.PI * u), 1.25));
    const scale = env[5] / model[5];
    for (let i = 0; i < us.length; i++) expect(Math.abs(db(env[i]) - db(model[i] * scale)), `u=${us[i]}`).toBeLessThan(2);
    // the ends are quiet, the middle is not: 30 dB between u = 0.04 and 0.5
    expect(db(env[5]) - db(env[0])).toBeGreaterThan(20);
    // brighter mid-stroke: the share of 2-5 kHz against 0.3-1 kHz
    const tilt = (u: number): number => {
      let hi = 0;
      let lo = 0;
      for (const c of cmds) {
        for (const back of [0, 1]) {
          const a = Math.round(c.f0 + (back + u) * c.strokeN - 512);
          const psd = welch(mono(l, r), 1024, a, a + 1024, 0.5);
          hi += bandPower(psd, SR, 2000, 5000);
          lo += bandPower(psd, SR, 300, 1000);
        }
      }
      return 10 * Math.log10(hi / lo);
    };
    expect(tilt(0.5)).toBeGreaterThan(tilt(0.1) + 3);
    expect(tilt(0.5)).toBeGreaterThan(tilt(0.9) + 3);
  });

  it('the swish moves across the cabin with the blade: park end right, far end left, the two strokes mirror each other', () => {
    const c = cmd({ wet: 0.65 });
    const { l, r } = renderVoice([c], 3, only('swish'));
    const balance = (u: number, back: number): number => {
      const a = Math.round(c.f0 + (back + u) * c.strokeN - 1000);
      return db(rms(l, a, a + 2000)) - db(rms(r, a, a + 2000));
    };
    // balance = left minus right (dB): on the way out the blade goes from the right to the left of the cabin (the balance rises) ...
    expect(balance(0.7, 0) - balance(0.3, 0)).toBeGreaterThan(1.2);
    expect(balance(0.3, 0)).toBeLessThan(0); // near the park end it is on the right
    expect(balance(0.7, 0)).toBeGreaterThan(0); // near the far end on the left
    // ... and on the way back from the left to the right (it falls)
    expect(balance(0.3, 1) - balance(0.7, 1)).toBeGreaterThan(1.2);
  });

  it('the thunks: a soft low knock with a small click, shorter than a tenth of a second, the park one lower and softer', () => {
    const bank = buildWiperBank(SR);
    expect(bank.rev.length).toBe(WIPER_THUNK_VARIANTS);
    expect(bank.park.length).toBe(WIPER_THUNK_VARIANTS);
    expect(getWiperBank(SR)).toBe(getWiperBank(SR)); // built once per sample rate
    const share = (x: Float32Array, f0: number, f1: number): number => {
      const psd = powerSpectrum(x, 0, 2048);
      return bandPower(psd, SR, f0, f1) / bandPower(psd, SR, 20, 24000);
    };
    const centroid = (x: Float32Array): number => {
      const psd = powerSpectrum(x, 0, 4096);
      let num = 0;
      let den = 0;
      for (let i = 2; i < psd.length - 1; i++) {
        num += i * psd[i];
        den += psd[i];
      }
      return (num / den) * (SR / 4096);
    };
    let cRev = 0;
    let cPark = 0;
    for (let i = 0; i < WIPER_THUNK_VARIANTS; i++) {
      for (const x of [bank.rev[i], bank.park[i]]) {
        expect(hasNonFinite(x)).toBe(false);
        expect(peakAbs(x)).toBeCloseTo(1, 5);
        // a knock: nearly all of the energy is below 400 Hz, a little click above 1 kHz (but not nothing, not a tick)
        expect(share(x, 20, 400)).toBeGreaterThan(0.75);
        const click = share(x, 1000, 5000);
        expect(click).toBeGreaterThan(1e-4);
        expect(click).toBeLessThan(0.06);
        // it dies away: 20 dB down within 90 ms, nothing left by the end of the prototype, no cut-off click
        const env = (a: number, b: number): number => db(rms(x, Math.round(a * SR), Math.round(b * SR)));
        expect(env(0.09, 0.1)).toBeLessThan(env(0, 0.01) - 20);
        expect(Math.abs(x[x.length - 1])).toBeLessThan(0.002);
      }
      cRev += centroid(bank.rev[i]);
      cPark += centroid(bank.park[i]);
    }
    expect(cPark / WIPER_THUNK_VARIANTS).toBeLessThan((cRev / WIPER_THUNK_VARIANTS) * 0.95);
    // and the park one is softer for equal gains
    expect(WIPER_CAL.park).toBeLessThan(WIPER_CAL.rev);
  });

  it('the whine: a muffled tone near 440 Hz that rises and falls a few percent through each stroke, scales with `pitch`', () => {
    const f = (c: SweepCommand, u: number, back = 0): number => {
      const { l, r } = renderVoice([c], 3, only('whine'));
      const x = mono(l, r);
      return peakHz(x, Math.round(c.f0 + (back + u) * c.strokeN - 2048), 4096, 360, 560);
    };
    const base = cmd({ pitch: 1 });
    const mid = f(base, 0.5);
    const end = f(base, 0.97);
    expect(mid).toBeGreaterThan(425);
    expect(mid).toBeLessThan(480);
    // it rises toward the middle of the stroke and falls back toward the turn
    expect(mid / end).toBeGreaterThan(1.015);
    expect(mid / end).toBeLessThan(1.07);
    expect(f(base, 0.5, 1)).toBeGreaterThan(f(base, 0.97, 1) * 1.015);
    // +3 % of pitch is +3 % of Hz
    expect(f(cmd({ pitch: 1.03 }), 0.5) / mid).toBeCloseTo(1.03, 1);
    // muffled: the overtones are a lot weaker than the tone
    const { l, r } = renderVoice([base], 3, only('whine'));
    const psd = welch(mono(l, r), 4096, Math.round(base.f0 + 0.35 * STROKE_N), Math.round(base.f0 + 0.65 * STROKE_N));
    expect(bandPower(psd, SR, 1500, 8000) / bandPower(psd, SR, 300, 600)).toBeLessThan(0.01);
  });

  it('the motor winds down at the park position in the rain, and keeps turning through a storm\'s 0.12 s pause', () => {
    const quiet = (rain: number): { gap: number; stroke: number; after: number } => {
      const dwell = rain > 0.8 ? 0.12 : 2.4;
      const c1 = cmd({ f0: SR, dwell });
      const c2 = cmd({ f0: SR + 2 * STROKE_N + Math.round(dwell * SR), dwell });
      const { l, r } = renderVoice([c1, c2], 6, only('whine', 'buzz'));
      const e = (a: number, b: number): number => db(chanRms(l, r, Math.round(a), Math.round(b)));
      const end1 = c1.f0 + 2 * STROKE_N;
      return { gap: e(end1 + 0.03 * SR, end1 + 0.1 * SR), stroke: e(c1.f0 + 0.15 * SR, c1.f0 + 0.27 * SR), after: e(end1 + 0.5 * SR, end1 + 0.9 * SR) };
    };
    const storm = quiet(1);
    expect(storm.gap).toBeGreaterThan(storm.stroke - 9); // the load is off, the motor is not
    const rain = quiet(0.55);
    expect(rain.after).toBeLessThan(rain.stroke - 60); // wound down well before half a second is over
    expect(rain.gap).toBeLessThan(rain.stroke - 3); // already falling in the first 100 ms
  });

  it('an occasional squeak or chatter at the scheduled place, faint against the swish', () => {
    const base = cmd({ wet: 0.5 });
    for (const [kind, hz] of [
      [0, 2400],
      [1, 2800],
    ] as const) {
      const c = { ...base, sqOn: 1, sqStroke: 1, sqAt: 0.7, sqKind: kind, sqFreq: hz, sqLevel: 1, sqDur: 0.12 };
      const sq = renderVoice([c], 3, only('squeak'));
      const sw = renderVoice([c], 3, only('swish'));
      const at = Math.round(c.f0 + (1 + 0.7) * c.strokeN);
      expect(firstAbove(sq.l, sq.r, c.f0, at - 8, 1e-9), `nothing before the squeak (kind ${kind})`).toBe(-1);
      const a = firstAbove(sq.l, sq.r, at - 8, at + 4000, 1e-7);
      expect(a).toBeGreaterThanOrEqual(at - 8);
      expect(a).toBeLessThan(at + 2500);
      expect(db(chanRms(sq.l, sq.r, at + Math.round(0.14 * SR), at + Math.round(0.3 * SR)))).toBeLessThan(-110); // over after ~0.12 s
      if (kind === 0) expect(Math.abs(peakHz(mono(sq.l, sq.r), at + 600, 4096, 1500, 4500) - hz) / hz).toBeLessThan(0.15);
      // faint: the loudest 10 ms of the squeak is well below the loudest of the swish
      const peak10 = (x: Rendered): number => {
        let p = 0;
        for (let s = c.f0; s + 480 < c.f0 + 2 * STROKE_N; s += 240) p = Math.max(p, chanRms(x.l, x.r, s, s + 480));
        return db(p);
      };
      expect(peak10(sq)).toBeLessThan(peak10(sw) - 4);
      expect(peak10(sq)).toBeGreaterThan(peak10(sw) - 22);
    }
    // and none when the sweep says so
    const none = renderVoice([{ ...base, sqOn: 0 }], 3, only('squeak'));
    expect(peakAbs(none.l) + peakAbs(none.r)).toBe(0);
  });

  it('squelch ticks ride the swish, more of them on wetter glass', () => {
    const count = (wet: number): number => {
      const { l, r } = renderVoice(
        Array.from({ length: 4 }, (_, i) => cmd({ f0: SR + i * 3 * SR, wet, seed: i + 1 })),
        14,
        only('tick'),
      );
      let n = 0;
      let quiet = true;
      const x = mono(l, r);
      for (let i = 0; i < x.length; i++) {
        if (Math.abs(x[i]) > 4e-4 && quiet) {
          n++;
          quiet = false;
        } else if (Math.abs(x[i]) < 5e-5) quiet = true;
      }
      return n;
    };
    expect(count(0.1)).toBeGreaterThan(5);
    expect(count(1)).toBeGreaterThan(count(0.1) * 1.8);
  });

  it('each sweep differs from the last: pitch, the thunks and the swish\'s noise (a storm\'s non-stop wiping is no loop)', () => {
    const sim = simulateWiper({ seconds: 12, rain: 1, fps: 60, jitter: 0.1, seed: 2, plannerSeed: 21 });
    const { l, r } = renderVoice(sim.sweeps, 11, only('whine'));
    const x = mono(l, r);
    const pitches = sim.sweeps.slice(1, 9).map((c) => peakHz(x, Math.round(c.f0 + 0.5 * c.strokeN - 2048), 4096, 360, 560));
    expect(new Set(pitches.map((p) => p.toFixed(0))).size).toBeGreaterThanOrEqual(5);
    expect(Math.max(...pitches) / Math.min(...pitches)).toBeGreaterThan(1.012);
    expect(Math.max(...pitches) / Math.min(...pitches)).toBeLessThan(1.08);
    // the swish of two sweeps is not the same noise: waveforms are uncorrelated
    const sw = renderVoice(sim.sweeps, 11, only('swish'));
    const a = sim.sweeps[2];
    const b = sim.sweeps[3];
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let i = 0; i < a.strokeN; i++) {
      const p = sw.l[a.f0 + i];
      const q = sw.l[b.f0 + i];
      sab += p * q;
      saa += p * p;
      sbb += q * q;
    }
    expect(Math.abs(sab / Math.sqrt(saa * sbb))).toBeLessThan(0.1);
    // the knocks differ too (different prototypes and weights)
    const th = renderVoice(sim.sweeps, 11, only('thunk'));
    const peaks = sim.sweeps.slice(1, 9).map((c) => peakAbs(th.l.subarray(c.f0 + c.strokeN, c.f0 + c.strokeN + 4000)));
    expect(new Set(peaks.map((p) => p.toFixed(4))).size).toBeGreaterThanOrEqual(6);
  });
});

describe('WiperVoice: levels against the cabin rain', () => {
  const cabinRain = (rain: number, only?: number[]): { l: Float32Array; r: Float32Array } => {
    const v = new WeatherVoice(SR, 7);
    Object.assign(v.inp, { rain, interior: 1, speed: 40 });
    if (only) {
      v.trim.hi = v.trim.lo = v.trim.wind = v.trim.cabin = v.trim.thunder = 0;
      v.trim.stream.fill(0);
      for (const s of only) v.trim.stream[s] = 1;
    }
    const n = 14 * SR;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let o = 0; o < n; o += 128) v.process(l, r, Math.min(128, n - o), o);
    return { l, r };
  };
  const windows = (x: { l: Float32Array; r: Float32Array }, from: number, to: number, win = 4800): number[] => {
    const out: number[] = [];
    for (let a = from; a + win <= to; a += win >> 1) out.push(db(chanRms(x.l, x.r, a, a + win)));
    return out;
  };

  for (const [name, rain] of [
    ['"rain" preset', 0.55],
    ['storm', 1],
  ] as const) {
    it(`${name}: all layers together are never louder than the roof drumming, and not lost under it either`, () => {
      const sim = simulateWiper({ seconds: 14, rain, fps: 60, jitter: 0.2, seed: 5, plannerSeed: 3 });
      const w = renderVoice(sim.sweeps, 14);
      expect(hasNonFinite(w.l) || hasNonFinite(w.r)).toBe(false);
      const drum = cabinRain(rain, [STREAM.DRUM]);
      const wip = windows(w, 2 * SR, 14 * SR);
      const dru = windows(drum, 2 * SR, 14 * SR);
      const drumMedian = pct(dru, 0.5);
      // the loudest 100 ms of the wiper: below the median 100 ms of the roof drumming (flat RMS), within 8 dB of it
      expect(Math.max(...wip), `${Math.max(...wip).toFixed(1)} vs drum median ${drumMedian.toFixed(1)}`).toBeLessThan(drumMedian);
      expect(Math.max(...wip)).toBeGreaterThan(drumMedian - 8);
      // and well under the whole cabin rain
      const total = windows(cabinRain(rain), 2 * SR, 14 * SR);
      expect(Math.max(...wip)).toBeLessThan(pct(total, 0.5) - 3);
      // peak sample: far below full scale
      expect(db(Math.max(peakAbs(w.l), peakAbs(w.r)))).toBeLessThan(-18);
    });
  }

  it('the layers keep their order: thunks and swish lead, the motor sits low, ticks and squeaks are detail', () => {
    const sim = simulateWiper({ seconds: 20, rain: 1, fps: 60, jitter: 0, seed: 1, plannerSeed: 1 });
    const lvl = (t: Partial<WiperTrim>): number => {
      const x = renderVoice(sim.sweeps, 20, t);
      return Math.max(...windows(x, 2 * SR, 20 * SR));
    };
    const swish = lvl(only('swish'));
    const thunk = lvl(only('thunk'));
    const whine = lvl(only('whine'));
    const tick = lvl(only('tick'));
    expect(whine).toBeLessThan(swish - 6);
    expect(whine).toBeLessThan(thunk - 5);
    expect(tick).toBeLessThan(swish - 12);
    expect(Math.abs(swish - thunk)).toBeLessThan(6); // the two main layers sit together
    // in the rain the storm's swish is louder than a film's: more water
    const rainSim = simulateWiper({ seconds: 20, rain: 0.55, fps: 60, jitter: 0, seed: 1, plannerSeed: 1 });
    const swishRain = Math.max(...windows(renderVoice(rainSim.sweeps, 20, only('swish')), 2 * SR, 20 * SR));
    expect(swish).toBeGreaterThan(swishRain + 0.8);
  });
});

describe('WiperVoice: stopping, starting and joining without a click', () => {
  /** Largest sample-to-sample step relative to the local level (a step that stands out of the signal around it is a click). */
  const worstStep = (x: Float32Array, from: number, to: number): number => clickScore(x.subarray(from, to), 96).score;

  it('starts and ends smoothly (no click at the first or the last sample of a sweep, swish + motor)', () => {
    const c = cmd({ f0: SR + 100 });
    const { l, r } = renderVoice([c], 3.5, only('swish', 'whine', 'buzz', 'tick'));
    const m = mono(l, r);
    expect(worstStep(m, c.f0 - 200, c.f0 + 6000)).toBeLessThan(60);
    expect(worstStep(m, c.f0 + 2 * STROKE_N - 6000, c.f0 + 2 * STROKE_N + 20000)).toBeLessThan(60);
  });

  it('abort() fades everything out in about 30 ms, no click, and the voice is then wiped clean and ready', () => {
    const c = cmd({ f0: 2000, dwell: 0.12 });
    const abortAt = 2000 + Math.round(0.3 * SR) - 0;
    const { l, r, v } = renderVoice([c, { ...c, f0: c.f0 + 2 * STROKE_N + Math.round(0.12 * SR) }], 3, undefined, (frame, voice) => {
      if (frame === Math.floor(abortAt / 128) * 128) voice.abort();
    });
    const at = Math.floor(abortAt / 128) * 128;
    const before = chanRms(l, r, at - 960, at);
    expect(before).toBeGreaterThan(1e-4);
    // 25 ms later it is down by 40 dB, 80 ms later nothing is left
    expect(db(chanRms(l, r, at + 1200, at + 1440))).toBeLessThan(db(before) - 40);
    expect(db(chanRms(l, r, at + 4000, 3 * SR))).toBeLessThan(-150);
    expect(v.awake).toBe(false);
    expect(v.pending).toBe(0);
    // no jump: the step at the abort is no bigger than the signal's own
    const m = mono(l, r);
    expect(worstStep(m, at - 2000, at + 4000)).toBeLessThan(60);
    // ready for the next sweep: a new one plays normally
    const next = renderVoice([{ ...c, f0: 1000 }], 2.5, undefined, (frame, voice) => {
      if (frame === 128 * 40) voice.abort();
      if (frame === 128 * 200) voice.queueSweep(cmd({ f0: 128 * 400 }));
    });
    expect(chanRms(next.l, next.r, 128 * 400 + 8000, 128 * 400 + 14000)).toBeGreaterThan(1e-4);
  });

  it('abort() on a voice that is not playing is free and leaves it ready', () => {
    const { l, r } = renderVoice([], 1, undefined, (frame, v) => {
      if (frame === 128 * 10) v.abort();
      if (frame === 128 * 20) v.queueSweep(cmd({ f0: 128 * 30 }));
    });
    expect(peakAbs(l.subarray(0, 128 * 30)) + peakAbs(r.subarray(0, 128 * 30))).toBe(0);
    expect(chanRms(l, r, 128 * 30 + 6000, 128 * 30 + 12000)).toBeGreaterThan(1e-4);
  });

  it('a sweep that arrives late joins where the blade is, with a short fade-in, and its thunks still land on time', () => {
    // posted 0.3 s after its start (back-dated): the voice picks it up mid-way through the out stroke
    const c = cmd({ f0: 1000 });
    const lateAt = 1000 + Math.round(0.3 * SR);
    const late = renderVoice([], 3, undefined, (frame, v) => {
      if (frame === Math.floor(lateAt / 128) * 128) v.queueSweep(c);
    });
    const ref = renderVoice([c], 3);
    // the reversal thunk is on its sample
    const lt = renderVoice([], 3, only('thunk'), (frame, v) => {
      if (frame === Math.floor(lateAt / 128) * 128) v.queueSweep(c);
    });
    expect(firstAbove(lt.l, lt.r, lateAt, lateAt + 3 * SR)).toBe(c.f0 + c.strokeN);
    // after the fade the level matches the on-time render (same blade position: same swish envelope)
    const a = c.f0 + Math.round(0.36 * SR);
    expect(Math.abs(db(chanRms(late.l, late.r, a, a + 1500)) - db(chanRms(ref.l, ref.r, a, a + 1500)))).toBeLessThan(2.5);
    // nothing before it joined
    expect(peakAbs(late.l.subarray(0, Math.floor(lateAt / 128) * 128 - 1)) + peakAbs(late.r.subarray(0, Math.floor(lateAt / 128) * 128 - 1))).toBe(0);
    // faded in: the first 5 ms are well under the level 50 ms in
    const j = Math.floor(lateAt / 128) * 128;
    expect(chanRms(late.l, late.r, j, j + 240)).toBeLessThan(chanRms(late.l, late.r, j + 2400, j + 2640) * 0.5);
    expect(worstStep(mono(late.l, late.r), j - 200, j + 6000)).toBeLessThan(60);
    // a sweep that is already over is ignored, one with a sliver left too
    const over = renderVoice([], 3, undefined, (frame, v) => {
      if (frame === 128 * 700) v.queueSweep(cmd({ f0: 128 * 700 - 2 * STROKE_N - 4000 }));
    });
    expect(peakAbs(over.l) + peakAbs(over.r)).toBe(0);
  });

  it('the same sweep posted again (same id) is moved if it has not started, and left alone once it has', () => {
    const c = cmd({ id: 7, f0: SR });
    const moved = { ...c, f0: SR + 4800 }; // 100 ms later
    const x = renderVoice([c, moved], 3, only('thunk'));
    // queued twice under one id: one sweep, at the later start
    const rev = moved.f0 + moved.strokeN;
    expect(firstAbove(x.l, x.r, 0, 3 * SR)).toBe(rev);
    // moved while it is under way (the message arrives after the start): ignored, the sweep plays where it began
    const late = renderVoice([c], 3, only('thunk'), (frame, v) => {
      if (frame === 128 * 600) v.queueSweep(moved);
    });
    expect(firstAbove(late.l, late.r, 0, 3 * SR)).toBe(c.f0 + c.strokeN);
    // a sweep that is over cannot come back
    const backAt = 128 * 400;
    const over = renderVoice([c], 4, only('thunk'), (frame, v) => {
      if (frame === backAt) v.queueSweep({ ...c, f0: backAt + 4000 });
    });
    expect(firstAbove(over.l, over.r, c.f0 + 2 * c.strokeN + 12000, 4 * SR)).toBe(-1);
    // anonymous commands (id 0) are never merged
    const two = renderVoice([cmd({ f0: SR }), cmd({ f0: 2 * SR })], 4, only('thunk'));
    expect(firstAbove(two.l, two.r, SR + STROKE_N + 12000, 2 * SR + STROKE_N - 1)).toBe(SR + 2 * STROKE_N);
    expect(firstAbove(two.l, two.r, 2 * SR + STROKE_N - 2, 4 * SR)).toBe(2 * SR + STROKE_N);
  });

  it('abort() silences a knock that was still to come, and a sweep posted right after it plays once the fade is over', () => {
    const c = cmd({ f0: 1000, id: 1 });
    const turn = c.f0 + c.strokeN;
    const x = renderVoice([c], 2, only('thunk'), (frame, v) => {
      if (frame === Math.floor((turn - 3000) / 128) * 128) v.abort();
    });
    expect(peakAbs(x.l.subarray(turn - 100, turn + 6000)) + peakAbs(x.r.subarray(turn - 100, turn + 6000))).toBe(0);
    // the resync case: stop, then the sweep that matches the picture, under way already
    const y = renderVoice([c], 3, only('thunk', 'swish'), (frame, v) => {
      if (frame === 128 * 100) {
        v.abort();
        v.queueSweep({ ...c, id: 2, f0: 128 * 100 - 6000 }); // under way for 125 ms
      }
    });
    // the new sweep is there after the fade (its swish), joined, with its own knock on its own frame
    expect(chanRms(y.l, y.r, 128 * 100 + 4000, 128 * 100 + 9000)).toBeGreaterThan(1e-4);
    const turn2 = 128 * 100 - 6000 + c.strokeN;
    expect(firstAbove(y.l, y.r, turn2 - 300, turn2 + 3000, 3e-4)).toBeGreaterThanOrEqual(turn2 - 20);
    expect(hasNonFinite(y.l) || hasNonFinite(y.r)).toBe(false);
  });

  it('a squeak starts on the sample it is scheduled for', () => {
    for (const f0 of [SR, SR + 31, SR + 100, SR + 127]) {
      const c = cmd({ f0, sqOn: 1, sqStroke: 0, sqAt: 0.6, sqKind: 0, sqFreq: 2600, sqLevel: 1, sqDur: 0.12 });
      const at = Math.round(c.f0 + 0.6 * c.strokeN);
      const x = renderVoice([c], 2, only('squeak'));
      const first = firstAbove(x.l, x.r, 0, 2 * SR, 1e-9);
      expect(first).toBeGreaterThanOrEqual(at);
      expect(first).toBeLessThan(at + 8); // the swell starts from zero: a few samples to rise above 1e-9
    }
  });

  it('pause (gain 0) goes quiet within a fraction of a second and comes back cleanly', () => {
    const sim = simulateWiper({ seconds: 8, rain: 1, fps: 60, jitter: 0, seed: 1 });
    const { l, r } = renderVoice(sim.sweeps, 8, undefined, (frame, v) => {
      v.inp.gain = frame > 3 * SR && frame < 5 * SR ? 0 : 1;
    });
    expect(db(chanRms(l, r, Math.round(3.3 * SR), Math.round(4.9 * SR)))).toBeLessThan(-100);
    expect(db(chanRms(l, r, Math.round(5.5 * SR), 8 * SR))).toBeGreaterThan(-60);
    expect(worstStep(mono(l, r), Math.round(2.8 * SR), Math.round(3.4 * SR))).toBeLessThan(60);
    expect(hasNonFinite(l) || hasNonFinite(r)).toBe(false);
  });

  it('fuzz: random commands (garbage included), aborts and pauses never produce NaN or runaway levels', () => {
    const rnd = new Rng(4242);
    const v = new WiperVoice(SR, 9);
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    let worst = 0;
    const junk = (): number => [Number.NaN, Number.POSITIVE_INFINITY, -5, 1e9, 0, 0.5][Math.floor(rnd.u() * 6)];
    for (let b = 0; b < 6000; b++) {
      const frame = b * 128;
      if (b % 90 === 0) {
        const c = cmd({ f0: frame + Math.floor(rnd.u() * 20000) - 4000, strokeN: Math.round(0.2 * SR + rnd.u() * 0.4 * SR) });
        for (const k of ['dwell', 'wet', 'level', 'pitch', 'bright', 'outGain', 'backGain', 'revIdx', 'revGain', 'parkIdx', 'parkGain', 'sqAt', 'sqKind', 'sqFreq', 'sqLevel', 'sqDur'] as const) {
          if (rnd.u() < 0.1) (c as unknown as Record<string, number>)[k] = junk();
        }
        c.sqOn = rnd.u() < 0.5 ? 1 : 0;
        c.sqStroke = rnd.u() < 0.5 ? 1 : 0;
        v.queueSweep(c);
      }
      if (b % 700 === 350) v.abort();
      if (b % 40 === 0) v.inp.gain = rnd.u() > 0.15 ? 1 : 0;
      v.process(l, r, 128, frame);
      expect(hasNonFinite(l) || hasNonFinite(r)).toBe(false);
      worst = Math.max(worst, peakAbs(l), peakAbs(r));
    }
    expect(worst).toBeLessThan(0.5);
    // a command with a garbage start or length is dropped, not queued
    const w = new WiperVoice(SR, 1);
    w.queueSweep({ ...cmd(), f0: Number.NaN });
    w.queueSweep({ ...cmd(), strokeN: 0 });
    expect(w.pending).toBe(0);
  });

  it('is deterministic for a seed and cheap: a quantum costs a few microseconds with a sweep playing, nothing when asleep', () => {
    const a = renderVoice([cmd()], 3, undefined, undefined, 5);
    const b = renderVoice([cmd()], 3, undefined, undefined, 5);
    for (let i = 0; i < a.l.length; i += 97) {
      expect(a.l[i]).toBe(b.l[i]);
      expect(a.r[i]).toBe(b.r[i]);
    }
    const c = renderVoice([cmd()], 3, undefined, undefined, 6);
    let diff = 0;
    for (let i = 0; i < a.l.length; i += 7) diff += Math.abs(a.l[i] - c.l[i]);
    expect(diff).toBeGreaterThan(0);
    const time = (playing: boolean): number => {
      const v = new WiperVoice(SR, 1);
      const l = new Float32Array(128);
      const r = new Float32Array(128);
      const sweeps = Array.from({ length: 40 }, (_, i) => cmd({ f0: i * 2 * STROKE_N + 100, dwell: 0.001 }));
      if (playing) for (const s of sweeps) v.queueSweep(s);
      const quanta = Math.floor((38 * 2 * STROKE_N) / 128);
      for (let i = 0; i < 800; i++) v.process(l, r, 128, i * 128);
      let best = Infinity;
      for (let rep = 0; rep < 4; rep++) {
        const t0 = performance.now();
        for (let i = 0; i < 2000; i++) v.process(l, r, 128, (800 + rep * 2000 + i) * 128 + 0 * quanta);
        best = Math.min(best, ((performance.now() - t0) / 2000) * 1000);
      }
      return best;
    };
    const budget = (128 / SR) * 1e6;
    expect(time(true)).toBeLessThan(budget * 0.06);
    expect(time(false)).toBeLessThan(budget * 0.002);
  });
});

// ── end to end: the game loop -> the planner -> the voice ────────────────────

describe('the picture\'s blade and the sound, end to end', () => {
  it('the thunks of the rendered audio fall on the instants the picture\'s blade reaches the ends of its sweep (to a millisecond)', () => {
    for (const rain of [0.55, 1]) {
      const sim = simulateWiper({ seconds: 22, rain, fps: 60, jitter: 0.35, seed: 6, plannerSeed: 2 });
      const { l, r } = renderVoice(sim.sweeps, 20, only('thunk'));
      const x = mono(l, r);
      const state = makeWiperFeed().state;
      let n = 0;
      for (const c of sim.sweeps) {
        // the instants (wall = audio time) at which the picture's clock reaches the sweep's reversal and park
        for (const [what, offsetS] of [
          ['reversal', WIPER.OUT],
          ['park', 2 * WIPER.OUT],
        ] as const) {
          const tPicture = sim.wallAt(c.cs + offsetS);
          if (!Number.isFinite(tPicture) || tPicture < 1 || tPicture > 19) continue;
          // the onset of the knock in the audio: first sample above a hair, searched near the instant
          const a = Math.round((tPicture - 0.05) * SR);
          const onset = firstAbove(x, x, a, a + Math.round(0.1 * SR), 1e-7);
          expect(onset, `${what} of the sweep at ${c.cs.toFixed(2)} (rain ${rain})`).toBeGreaterThan(0);
          expect(Math.abs(onset / SR - tPicture), `${what} (rain ${rain})`).toBeLessThan(0.001);
          // and the picture's blade really is at that end then
          const d = sim.frames.find((f) => f.w >= tPicture)!.d;
          wiperStateInto(state, d, rain);
          n++;
        }
      }
      expect(n).toBeGreaterThan(rain < 0.8 ? 8 : 30);
    }
  });

  it('the swish swells with the picture\'s blade: its loudest instant is mid-stroke of the picture (+- 15 ms)', () => {
    const sim = simulateWiper({ seconds: 16, rain: 0.55, fps: 60, jitter: 0.3, seed: 6, plannerSeed: 4 });
    const { l, r } = renderVoice(sim.sweeps, 14, only('swish'));
    const x = mono(l, r);
    const k = 960; // 20 ms
    let checked = 0;
    for (const c of sim.sweeps) {
      for (const stroke of [0, 1]) {
        const mid = sim.wallAt(c.cs + (stroke + 0.5) * WIPER.OUT);
        if (!Number.isFinite(mid) || mid < 1.5 || mid > 13) continue;
        // smooth the energy over 40 ms and find its peak within the stroke
        let best = -1;
        let bestT = 0;
        for (let t = mid - 0.2; t < mid + 0.2; t += 0.004) {
          const a = Math.round(t * SR);
          const e = rms(x, a - k, a + k);
          if (e > best) {
            best = e;
            bestT = t;
          }
        }
        expect(Math.abs(bestT - mid)).toBeLessThan(0.04);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(6);
  });
});

// ── worklet glue ─────────────────────────────────────────────────────────────

describe('engine.worklet.ts: the xr-wiper processor', () => {
  type Proc = {
    port: { onmessage: ((e: { data: unknown }) => void) | null };
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  };
  const registered: Record<string, new (o: unknown) => Proc> = {};

  beforeAll(async () => {
    vi.stubGlobal('sampleRate', SR);
    vi.stubGlobal('currentFrame', 0);
    vi.stubGlobal('registerProcessor', (name: string, ctor: new (o: unknown) => Proc) => {
      registered[name] = ctor;
    });
    vi.stubGlobal(
      'AudioWorkletProcessor',
      class {
        port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage(): void {}, close(): void {} };
      },
    );
    await import('../src/audio/engine.worklet');
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const setFrame = (f: number): void => {
    (globalThis as unknown as { currentFrame: number }).currentFrame = f;
  };
  const renderProc = (p: Proc, from: number, quanta: number, stereo = true): { l: Float32Array; r: Float32Array } => {
    const l = new Float32Array(quanta * 128);
    const r = new Float32Array(quanta * 128);
    const out = stereo ? [[new Float32Array(128), new Float32Array(128)]] : [[new Float32Array(128)]];
    for (let b = 0; b < quanta; b++) {
      setFrame(from + b * 128);
      expect(p.process([], out)).toBe(true);
      l.set(out[0][0], b * 128);
      if (stereo) r.set(out[0][1], b * 128);
    }
    setFrame(0);
    return { l, r };
  };

  it('registers next to the others', () => {
    expect(typeof registered['xr-wiper']).toBe('function');
    expect(typeof registered['xr-weather']).toBe('function');
    expect(typeof registered['xr-car']).toBe('function');
  });

  it('plays sweeps that arrive as messages, on the context frame they name, and stops on request', () => {
    const p = new registered['xr-wiper']({ processorOptions: { seed: 2 } });
    let x = renderProc(p, 0, 100);
    expect(peakAbs(x.l) + peakAbs(x.r)).toBe(0); // idle
    const c = cmd({ f0: 128 * 150 + 17 });
    p.port.onmessage!({ data: { type: 'sweep', ...c } });
    x = renderProc(p, 128 * 100, 200);
    // the reversal knock is not yet due; the swish is there
    expect(chanRms(x.l, x.r, 128 * 60, 128 * 100)).toBeGreaterThan(1e-4);
    // the thunk lands on its frame (swish and motor are tiny at the turn: look for the knock's own onset)
    const turn = c.f0 + c.strokeN;
    const y = renderProc(p, turn - 128 * 4, 12);
    const peakAt = (() => {
      let pk = 0;
      let at = 0;
      for (let i = 0; i < y.l.length; i++) {
        const a = Math.abs(y.l[i]) + Math.abs(y.r[i]);
        if (a > pk) {
          pk = a;
          at = i;
        }
      }
      return at + (turn - 128 * 4);
    })();
    expect(peakAt).toBeGreaterThanOrEqual(turn);
    expect(peakAt).toBeLessThan(turn + 600);
    // stop: faded out within a few quanta, then silent
    p.port.onmessage!({ data: { type: 'stop' } });
    const z = renderProc(p, turn + 128 * 40, 60);
    expect(peakAbs(z.l.subarray(128 * 20)) + peakAbs(z.r.subarray(128 * 20))).toBeLessThan(1e-6);
    // gain and a mono output are tolerated; dispose ends it
    p.port.onmessage!({ data: { type: 'gain', gain: 0 } });
    p.port.onmessage!({ data: { type: 'gain', gain: Number.NaN } });
    renderProc(p, 0, 4, false);
    expect(p.process([], [[]])).toBe(true);
    p.port.onmessage!({ data: 'dispose' });
    expect(p.process([], [[new Float32Array(128), new Float32Array(128)]])).toBe(false);
  });

  it('offline mode: the sweeps in processorOptions play from the start of the render', () => {
    const sim = simulateWiper({ seconds: 5, rain: 1, fps: 60, jitter: 0, seed: 1 });
    const p = new registered['xr-wiper']({ processorOptions: { seed: 3, sweeps: sim.sweeps } });
    const x = renderProc(p, 0, Math.floor((4 * SR) / 128));
    expect(db(chanRms(x.l, x.r, SR, 3 * SR))).toBeGreaterThan(-60);
    expect(db(chanRms(x.l, x.r, SR, 3 * SR))).toBeLessThan(-30);
    expect(hasNonFinite(x.l) || hasNonFinite(x.r)).toBe(false);
  });
});
