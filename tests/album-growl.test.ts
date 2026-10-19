/**
 * The growl bass, second round: a pitch envelope (pEnv, pEnvTime) and a stereo width (width, widthFreq). Both are off by default and then
 * the growl must be what it always was, sample for sample: the golden hashes below were taken before either existed.
 */
import { describe, expect, it } from 'vitest';
import { defineTrack } from '../src/audio/album/song';
import { FLAG } from '../src/audio/album/instrument';
import { GrowlBass } from '../src/audio/album/instruments/bass';
import { growlHashes, makeCtx, playScript } from '../sandbox/album/lab/golden-renders';
import { SINE_GROWL, crossings, diveOffset, predictedCycles } from '../sandbox/album/lab/growl-dive-lab';

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
