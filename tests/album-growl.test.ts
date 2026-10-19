/**
 * The growl bass, second round: a pitch envelope (pEnv, pEnvTime) and a stereo width (width, widthFreq). Both are off by default and then
 * the growl must be what it always was, sample for sample: the golden hashes below were taken before either existed.
 */
import { describe, expect, it } from 'vitest';
import { defineTrack } from '../src/audio/album/song';
import { FLAG } from '../src/audio/album/instrument';
import { GROWL_PRESETS, GrowlBass } from '../src/audio/album/instruments/bass';
import { growlHashes, makeCtx, playScript } from '../sandbox/album/lab/golden-renders';
import { SINE_GROWL, crossings, diveOffset, predictedCycles } from '../sandbox/album/lab/growl-dive-lab';
import { bandStat } from '../sandbox/album/lab/growl-width-lab';
import { hasNonFinite, rms } from '../src/audio/analysis';

const SR = 48000;

function renderBlocks(r: { frames: number; render(l: Float32Array, r: Float32Array, n: number): number }, frames: number, block: number): [Float32Array, Float32Array] {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  const bl = new Float32Array(block);
  const br = new Float32Array(block);
  let pos = 0;
  while (pos < frames) {
    const m = r.render(bl, br, Math.min(block, frames - pos));
    if (m === 0) break;
    L.set(bl.subarray(0, m), pos);
    R.set(br.subarray(0, m), pos);
    pos += m;
  }
  return [L, R];
}

// The hashes of the growl rendered by sandbox/album/lab/golden-renders.ts, taken before the pitch envelope and the width existed. If you
// change the growl on purpose, run `node sandbox/album/run.mjs sandbox/album/lab/golden-renders.ts` and paste what it prints here.
const GROWL_GOLDEN: Record<string, string> = {
  'dubstep-growl': '23c7500958e4584e',
  wub: '02945a307dbcb078',
  yoi: '7ae7d83466520e85',
  riddim: '63fe7a00ced159a5',
  neuro: '82c07a523b265e80',
  screech: 'dd2c2b9d19759836',
  'dubstep-growl beat-synced': 'b4021e7b732d106e',
  'wub with glide': '9ac9bedcd2a665c5',
  'riddim square lfo': '3ea94647401a1c58',
  'dubstep-growl with envelope and comb': '546dcb7e6a3cd538',
};

describe('the growl with the new options off', () => {
  it('renders sample for sample what it rendered before the pitch envelope and the width existed', () => {
    expect(growlHashes()).toEqual(GROWL_GOLDEN);
  });
});

// ── pitch envelope ───────────────────────────────────────────────────────────────────────────────────────

/** The growl as a plain sine (no FM, no formants, no distortion) playing the given notes; returns its output and the times of its cycles. */
function dive(opts: Record<string, unknown>, events: Parameters<typeof playScript>[2], seconds: number): { t: number[]; l: Float64Array } {
  const ctx = makeCtx(SR, 120);
  const g = new GrowlBass(ctx, { ...SINE_GROWL, ...opts } as never);
  const { l } = playScript(g, ctx, events, seconds);
  return { t: crossings(l, SR, Math.round(0.001 * SR)), l };
}
/** The frequency of the cycle that contains time `at`. */
function freqAt(t: number[], at: number): number {
  let i = 0;
  while (i + 2 < t.length && t[i + 1] < at) i++;
  return 1 / (t[i + 1] - t[i]);
}
const cents = (a: number, b: number): number => 1200 * Math.log2(a / b);

describe('growl pitch envelope (pEnv, pEnvTime)', () => {
  const A2 = 45; // 110 Hz

  it('has the parameters, with their ranges, and checks them', () => {
    const g = new GrowlBass(makeCtx(SR, 120), 'dubstep-growl');
    expect(g.specs.pEnv).toMatchObject({ default: 0, min: -24, max: 24, unit: 'semitones' });
    expect(g.specs.pEnvTime).toMatchObject({ default: 0.08, min: 0.005, max: 1, unit: 's' });
    expect(() => new GrowlBass(makeCtx(SR, 120), { preset: 'wub', pEnv: 25 } as never)).toThrow(/parameter "pEnv" is 25, outside its range -24 \.\. 24/);
    expect(() => new GrowlBass(makeCtx(SR, 120), { preset: 'wub', pEnvTime: 2 } as never)).toThrow(/parameter "pEnvTime" is 2/);
    expect(() => defineTrack({ id: 't-pe', title: 'pe', genre: 'Test', bpm: 120, bars: 2 }, (s) => void s.growl({ preset: 'wub', pEnv: 12, pEnvTime: 0.1 })).build(SR)).not.toThrow();
  });

  it('starts pEnv semitones away and is on the pitch of the note when pEnvTime is over (a dive and a rise)', () => {
    for (const pEnv of [12, -12, 7, 24, -24]) {
      const T = 1; // slow enough to read the first cycle: it lasts 4.5 to 36 ms
      const { t } = dive({ pEnv, pEnvTime: T }, [{ beat: 0, kind: 'on', note: A2, vel: 1 }], 2.6);
      const start = 110 * Math.pow(2, pEnv / 12);
      // the first cycle is close to the start pitch (the pitch moves a little during it; a 27 Hz cycle is 36 ms long: not read here)
      const first = freqAt(t, 0.002);
      if (Math.abs(pEnv) < 24 || pEnv > 0) expect(Math.abs(cents(first, start)), `pEnv ${pEnv}: first cycle ${first.toFixed(1)} Hz, the start is ${start.toFixed(1)} Hz`).toBeLessThan(260);
      expect(Math.sign(first - 110), `pEnv ${pEnv}`).toBe(Math.sign(pEnv));
      // later on it follows the curve (within a quarter of a semitone)...
      for (const at of [0.2, 0.5, 0.8]) {
        expect(Math.abs(cents(freqAt(t, at), 110 * Math.pow(2, diveOffset(pEnv, T, at) / 12))), `pEnv ${pEnv} at ${at} s`).toBeLessThan(25);
      }
      // ...and from pEnvTime on it is the note itself, within 1.5 cents
      for (const at of [1.05, 1.5, 2.2]) expect(Math.abs(cents(freqAt(t, at), 110)), `pEnv ${pEnv} after pEnvTime, at ${at} s`).toBeLessThan(1.5);
    }
  });

  it('follows the documented curve cycle by cycle, also when it is fast (exponential in semitones, exactly on pitch at pEnvTime)', () => {
    const lead = (f: number): number => Math.atan(28 / f) / (2 * Math.PI * f); // the 28 Hz DC high-pass at the end of the growl leads a tone by this
    for (const [pEnv, T] of [[12, 0.08], [-12, 0.08], [24, 0.04], [7, 0.25]] as const) {
      const seconds = T * 4 + 0.5;
      const { t } = dive({ pEnv, pEnvTime: T }, [{ beat: 0, kind: 'on', note: A2, vel: 1 }], seconds);
      const off = (x: number): number => diveOffset(pEnv, T, x);
      const want = predictedCycles(110, off, seconds, 4e-6).map((x) => x - lead(110 * Math.pow(2, off(x) / 12)));
      const n = Math.min(t.length, want.length);
      const delay = t[n - 1] - want[n - 1]; // the chain's own delay, constant, found where the pitch is steady
      let worst = 0;
      for (let k = 0; k < n; k++) worst = Math.max(worst, Math.abs(t[k] - want[k] - delay));
      expect(worst * 1e6, `pEnv ${pEnv}, pEnvTime ${T}: crossings off by ${(worst * 1e6).toFixed(0)} us`).toBeLessThan(150);
      expect(Math.abs(cents(freqAt(t, T * 1.5), 110)), `pEnv ${pEnv}`).toBeLessThan(2);
    }
  });

  it('dives each new note, but not a tied (slid) one', () => {
    const ev = (slide: boolean): Parameters<typeof playScript>[2] => [
      { beat: 0, kind: 'on', note: A2, vel: 1 },
      { beat: 2, kind: 'on', note: A2 + 5, vel: 1, flags: slide ? FLAG.SLIDE : 0 }, // D3, 146.8 Hz, at 1 s
      { beat: 4, kind: 'off', note: A2 + 5 },
    ];
    const tied = dive({ pEnv: 12, pEnvTime: 0.2 }, ev(true), 2.2);
    const fresh = dive({ pEnv: 12, pEnvTime: 0.2 }, ev(false), 2.2);
    const d3 = 110 * Math.pow(2, 5 / 12);
    // a retriggered note starts an octave up again; a tied one glides to the new pitch from the old one without a trace of the dive
    expect(freqAt(fresh.t, 1.003), 'a new note dives from an octave up').toBeGreaterThan(d3 * 1.5);
    let highest = 0;
    for (let at = 1.0; at < 1.6; at += 0.01) highest = Math.max(highest, freqAt(tied.t, at));
    expect(highest, 'a tied note only glides').toBeLessThan(d3 * 1.01);
    expect(Math.abs(cents(freqAt(tied.t, 1.8), d3))).toBeLessThan(1.5);
    expect(Math.abs(cents(freqAt(fresh.t, 1.8), d3))).toBeLessThan(1.5);
    expect(freqAt(tied.t, 0.003), 'the first note did dive').toBeGreaterThan(110 * 1.7);
  });

  it("dives the growl's own sub with the rest, so that the two never beat", () => {
    // a sine carrier plus the sub at the same level: both start in phase and, diving together, stay in phase; a sub that kept the note's
    // pitch would drift against the carrier and beat. The level of the sum is read cycle by cycle.
    const { l, t } = dive({ pEnv: 12, pEnvTime: 0.3, sub: 1 }, [{ beat: 0, kind: 'on', note: A2, vel: 1 }], 0.9);
    const peaks: number[] = [];
    for (let k = 1; k + 1 < t.length && t[k + 1] < 0.7; k++) {
      let pk = 0;
      for (let i = Math.round(t[k] * SR); i < Math.round(t[k + 1] * SR); i++) pk = Math.max(pk, Math.abs(l[i]));
      peaks.push(pk);
    }
    expect(peaks.length).toBeGreaterThan(40);
    expect(Math.max(...peaks) / Math.min(...peaks), 'the level of the sum from cycle to cycle').toBeLessThan(1.25);
    // the crossings of the sum stay near the carrier's own (the sub is added after the growl's filters, a third of a millisecond ahead of the
    // carrier, which moves the crossings by a fraction of that: a sub on the wrong pitch would move them by milliseconds)
    const carrier = dive({ pEnv: 12, pEnvTime: 0.3, sub: 0 }, [{ beat: 0, kind: 'on', note: A2, vel: 1 }], 0.9);
    const n = Math.min(t.length, carrier.t.length);
    let worst = 0;
    for (let k = 4; k < n; k++) worst = Math.max(worst, Math.abs(t[k] - carrier.t[k]));
    expect(worst * 1e6, 'zero crossings with and without the sub').toBeLessThan(300);
    // and the measure does see a beat: the same dive plus a sub that kept the pitch of the note
    const beat: number[] = [];
    let ph = 0;
    let lastPeak = 0;
    for (let i = 0; i < SR * 0.6; i++) {
      ph += (110 * Math.pow(2, diveOffset(12, 0.3, i / SR) / 12)) / SR;
      const x = Math.sin(2 * Math.PI * ph) + 0.55 * Math.sin((2 * Math.PI * 110 * i) / SR);
      lastPeak = Math.max(lastPeak, Math.abs(x));
      if (i % 600 === 599) {
        beat.push(lastPeak);
        lastPeak = 0;
      }
    }
    expect(Math.max(...beat) / Math.min(...beat), 'a sub that keeps the pitch beats against the dive').toBeGreaterThan(1.8);
  });

  it('leaves pEnv 0 alone whatever pEnvTime says, and can be automated', () => {
    const render = (extra: Record<string, unknown>): Float64Array => {
      const ctx = makeCtx(SR, 140);
      const g = new GrowlBass(ctx, { preset: 'dubstep-growl', ...extra } as never);
      return playScript(g, ctx, [{ beat: 0, kind: 'on', note: 33, vel: 0.8 }, { beat: 2, kind: 'off', note: 33 }], 1.5).l;
    };
    const plain = render({});
    expect(Buffer.compare(Buffer.from(plain.buffer), Buffer.from(render({ pEnv: 0, pEnvTime: 0.5 }).buffer))).toBe(0);
    expect(Buffer.compare(Buffer.from(plain.buffer), Buffer.from(render({ pEnv: 5 }).buffer))).not.toBe(0);
    // automation through the song: a dive that grows from note to note
    const def = defineTrack({ id: 't-pe2', title: 'pe2', genre: 'Test', bpm: 120, bars: 5, tail: 0.2 }, (s) => {
      const g = s.growl({ ...SINE_GROWL, preset: 'dubstep-growl', pEnvTime: 0.5 } as never, { name: 'g' });
      g.play(s.notes('A2:16 | A2:16 | A2:16 | A2:16 | A2:16', { free: true }), 0, 5);
      g.auto('pEnv', [[0, 0], [4, 12]]);
      s.master.raw = true;
    });
    const r = def.build(SR).toRenderer();
    const [l] = renderBlocks(r, r.frames, 4096);
    const firstCycles: number[] = [];
    for (let bar = 0; bar < 5; bar++) {
      const from = Math.round(bar * 2 * SR);
      const t = crossings(l.subarray(from, from + Math.round(0.3 * SR)), SR, Math.round(0.001 * SR));
      firstCycles.push(freqAt(t, 0.003));
    }
    const shown = firstCycles.map((v) => v.toFixed(0)).join(' ');
    for (let i = 1; i < 5; i++) expect(firstCycles[i], `first cycle of each bar: ${shown}`).toBeGreaterThan(firstCycles[i - 1] * 1.04);
    expect(firstCycles[0], shown).toBeLessThan(115);
    expect(firstCycles[4], shown).toBeGreaterThan(170);
  });
});

// ── stereo width ─────────────────────────────────────────────────────────────────────────────────────────

/** Half-time growl notes (F1 A1 C2 D2 F2 A1 ...) for the width measurements. */
const LINE: Parameters<typeof playScript>[2] = [];
{
  let beat = 0;
  for (const [note, beats] of [[29, 2], [33, 2], [36, 1], [38, 1], [41, 2], [33, 2], [29, 2]] as const) {
    LINE.push({ beat, kind: 'on', note, vel: 0.9 }, { beat: beat + beats - 0.05, kind: 'off', note });
    beat += beats;
  }
}
const LINE_SECONDS = 12 * (60 / 140) + 0.3;

function growlLine(opts: Record<string, unknown>): { l: Float64Array; r: Float64Array } {
  const ctx = makeCtx(SR, 140);
  return playScript(new GrowlBass(ctx, opts as never), ctx, LINE, LINE_SECONDS);
}

describe('growl stereo width (width, widthFreq)', () => {
  it('is a mono source unless its options or its preset set a width (any value, 0 too)', () => {
    const ctx = makeCtx(SR, 140);
    expect(new GrowlBass(ctx, 'dubstep-growl').stereo).toBe(false);
    expect(new GrowlBass(ctx, { preset: 'wub', cutoff: 300 }).stereo).toBe(false);
    expect(new GrowlBass(ctx, { preset: 'wub', width: 0 }).stereo).toBe(true);
    expect(new GrowlBass(ctx, { preset: 'wub', width: 0.7 }).stereo).toBe(true);
    GROWL_PRESETS['test-wide'] = { doc: 'a preset that sets a width', opts: { width: 0.5 } };
    try {
      expect(new GrowlBass(ctx, 'test-wide').stereo).toBe(true);
      expect(new GrowlBass(ctx, { preset: 'test-wide', width: 0 }).params.width).toBe(0);
    } finally {
      delete GROWL_PRESETS['test-wide'];
    }
    // ranges
    const g = new GrowlBass(ctx, { preset: 'wub', width: 0 });
    expect(g.specs.width).toMatchObject({ default: 0, min: 0, max: 1 });
    expect(g.specs.widthFreq).toMatchObject({ default: 200, unit: 'Hz' });
    expect(() => new GrowlBass(ctx, { preset: 'wub', width: 1.5 } as never)).toThrow(/parameter "width" is 1.5, outside its range 0 \.\. 1/);
    expect(() => new GrowlBass(ctx, { preset: 'wub', width: 1, widthFreq: 5 } as never)).toThrow(/parameter "widthFreq" is 5/);
  });

  it('at width 0 is the mono growl on both sides, bit for bit, and as loud in the mix as the mono growl panned centre', () => {
    for (const preset of ['dubstep-growl', 'neuro', 'screech']) {
      const mono = growlLine({ preset });
      const wide = growlLine({ preset, width: 0 });
      expect(Buffer.compare(Buffer.from(mono.l.buffer), Buffer.from(wide.l.buffer)), `${preset}: left`).toBe(0);
      expect(Buffer.compare(Buffer.from(mono.l.buffer), Buffer.from(wide.r.buffer)), `${preset}: right`).toBe(0);
    }
    // through the channel strip: a mono source is panned with the constant-power law (a gain of cos(pi/4) * sqrt(2) = 1 at the centre),
    // a stereo one with the balance law (1 at the centre): the same level to the last bit of a double
    const mix = (width: number | undefined): { l: Float32Array; r: Float32Array } => {
      const def = defineTrack({ id: 't-gw', title: 'gw', genre: 'Test', bpm: 140, bars: 4, tail: 0.3, fadeOut: 0.01 }, (s) => {
        s.growl(width === undefined ? { preset: 'dubstep-growl' } : { preset: 'dubstep-growl', width }, { gain: -4 }).play(s.notes('F1:8 . . . . . . . A1:8 . . . . . . . | C2:8 . . . . . . . D2:8 . . . . . . .', { free: true }), 0, 4);
        s.master.raw = true;
      });
      const r = def.build(SR).toRenderer();
      const [l, rr] = renderBlocks(r, r.frames, 4096);
      return { l, r: rr };
    };
    const a = mix(undefined);
    const b = mix(0);
    expect(hasNonFinite(a.l) || hasNonFinite(b.l)).toBe(false);
    expect(rms(a.l, 0, a.l.length)).toBeGreaterThan(0.01);
    expect(rms(b.l, 0, b.l.length) / rms(a.l, 0, a.l.length)).toBeCloseTo(1, 9);
    expect(rms(b.r, 0, b.r.length) / rms(a.r, 0, a.r.length)).toBeCloseTo(1, 9);
    let worst = 0;
    for (let i = 0; i < a.l.length; i++) worst = Math.max(worst, Math.abs(a.l[i] - b.l[i]), Math.abs(a.r[i] - b.r[i]));
    expect(worst).toBeLessThan(1e-6);
  });

  it('keeps the mono sum and the lows: the correlation below 120 Hz is 1, the mono sum is the growl', () => {
    for (const preset of ['dubstep-growl', 'wub', 'yoi', 'riddim']) {
      const mono = growlLine({ preset });
      const wide = growlLine({ preset, width: 1 });
      let sumErr = 0;
      for (let i = 0; i < mono.l.length; i++) sumErr = Math.max(sumErr, Math.abs((wide.l[i] + wide.r[i]) * 0.5 - mono.l[i]));
      expect(sumErr, `${preset}: mono sum`).toBeLessThan(1e-12);
      const low = bandStat(wide.l, wide.r, 20, 120);
      expect(low.corr, `${preset}: correlation below 120 Hz`).toBeGreaterThan(0.999);
      expect(low.sideMidDb, `${preset}: side/mid below 120 Hz`).toBeLessThan(-40);
      const sub = bandStat(wide.l, wide.r, 20, 60);
      expect(sub.corr, `${preset}: correlation below 60 Hz`).toBeGreaterThan(0.99995);
    }
  });

  it('puts a decorrelated side above widthFreq, 4 to 5 dB under the mid at width 1 (the band edges are the Linkwitz-Riley corner)', () => {
    const wide = growlLine({ preset: 'dubstep-growl', width: 1 });
    for (const [lo, hi] of [[400, 800], [800, 1600], [1600, 3200], [3200, 6400]] as const) {
      const b = bandStat(wide.l, wide.r, lo, hi);
      expect(b.sideMidDb, `${lo}-${hi} Hz`).toBeGreaterThan(-5.5);
      expect(b.sideMidDb, `${lo}-${hi} Hz`).toBeLessThan(-3.2);
      expect(b.corr, `${lo}-${hi} Hz`).toBeGreaterThan(0.3);
      expect(b.corr, `${lo}-${hi} Hz`).toBeLessThan(0.65);
    }
    // at the corner itself the side is 6 dB down (about -10 dB against the mid in a 200-400 Hz band that starts there), further down below it
    const corner = bandStat(wide.l, wide.r, 200, 400);
    expect(corner.sideMidDb).toBeGreaterThan(-8);
    expect(corner.sideMidDb).toBeLessThan(-4);
    expect(bandStat(wide.l, wide.r, 120, 160).sideMidDb).toBeLessThan(-15);
    // width 0.5 is 6 dB less side
    const half = growlLine({ preset: 'dubstep-growl', width: 0.5 });
    expect(bandStat(half.l, half.r, 800, 1600).sideMidDb - bandStat(wide.l, wide.r, 800, 1600).sideMidDb).toBeCloseTo(-6.02, 1);
    // widthFreq moves the corner: at 800 Hz the 200-400 Hz band is nearly mono and the highs are as wide as before
    const high = growlLine({ preset: 'dubstep-growl', width: 1, widthFreq: 800 });
    expect(bandStat(high.l, high.r, 200, 400).sideMidDb).toBeLessThan(-35);
    expect(bandStat(high.l, high.r, 3200, 6400).sideMidDb).toBeGreaterThan(-5.5);
    // the left and right levels are balanced (the side has no preferred side)
    let el = 0;
    let er = 0;
    for (let i = 0; i < wide.l.length; i++) {
      el += wide.l[i] * wide.l[i];
      er += wide.r[i] * wide.r[i];
    }
    expect(Math.abs(10 * Math.log10(el / er))).toBeLessThan(0.6);
  });

  it('can be automated (the side grows with width), and says so when the growl is mono and the automation would do nothing', () => {
    const sideBars: number[] = [];
    const def = defineTrack({ id: 't-gw2', title: 'gw2', genre: 'Test', bpm: 140, bars: 5, tail: 0.3, fadeOut: 0.01 }, (s) => {
      const g = s.growl({ preset: 'wub', width: 0 }, { name: 'g' });
      g.play(s.notes('F1:16 | F1:16 | F1:16 | F1:16 | F1:16', { free: true }), 0, 5);
      g.auto('width', [[0, 0], [4, 1]]);
      s.master.raw = true;
    });
    const r = def.build(SR).toRenderer();
    const [l, rr] = renderBlocks(r, r.frames, 4096);
    const barFrames = Math.round(4 * (60 / 140) * SR);
    for (let bar = 0; bar < 5; bar++) {
      const a = Float64Array.from(l.subarray(bar * barFrames, (bar + 1) * barFrames));
      const b = Float64Array.from(rr.subarray(bar * barFrames, (bar + 1) * barFrames));
      sideBars.push(bandStat(a, b, 400, 6400, Math.round(0.1 * SR)).sideMidDb);
    }
    for (let i = 1; i < 5; i++) expect(sideBars[i], sideBars.map((v) => v.toFixed(1)).join(' ')).toBeGreaterThan(sideBars[i - 1] + 1);
    expect(sideBars[4]).toBeGreaterThan(-5.5);
    // a growl without a width is mono: automating the width would do nothing, so it is an error with the way out
    defineTrack({ id: 't-gw3', title: 'gw3', genre: 'Test', bpm: 140, bars: 4 }, (s) => {
      const mono = s.growl('wub', { name: 'mono' });
      expect(() => mono.auto('width', [[0, 0], [2, 1]])).toThrow(/automation path "mono.width": instrument "mono": this growl is mono, so "width" does nothing: give it a width when you make it/);
      expect(() => mono.ramp('widthFreq', 0, 2, 100, 300)).toThrow(/"widthFreq" does nothing/);
      expect(() => s.auto('mono.width', [[0, 1]])).toThrow(/this growl is mono/);
      expect(() => mono.auto('cutoff', [[0, 300], [2, 900]])).not.toThrow();
      const wide = s.growl({ preset: 'wub', width: 0 }, { name: 'wide' });
      expect(() => wide.auto('width', [[0, 0], [2, 1]])).not.toThrow();
      expect(() => wide.auto('widthFreq', [[0, 200], [2, 500]])).not.toThrow();
    }).build(SR);
  });

  it('stays finite and quiet at the extremes, with a dive, and ends with the note', () => {
    for (const o of [
      { preset: 'neuro', width: 1, widthFreq: 60, pEnv: 24, pEnvTime: 0.2 },
      { preset: 'riddim', width: 1, widthFreq: 1000, lfoRate: 16 },
      { preset: 'screech', width: 1, widthFreq: 120, glide: 0.1 },
      { preset: 'dubstep-growl', width: 0.3, comb: 0.9, drive: 40, fold: 1, clip: 30 },
    ]) {
      const { l, r } = growlLine(o);
      expect(hasNonFinite(l) || hasNonFinite(r), JSON.stringify(o)).toBe(false);
      let peak = 0;
      for (let i = 0; i < l.length; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
      expect(peak, JSON.stringify(o)).toBeLessThan(8);
      expect(rms(l, l.length - 2000, l.length) + rms(r, r.length - 2000, r.length), `${JSON.stringify(o)}: nothing left after the last note`).toBeLessThan(1e-4);
    }
  });
});
