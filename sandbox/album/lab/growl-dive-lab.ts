/**
 * Measures the growl's pitch envelope (pEnv, pEnvTime): the growl is set up as a plain sine (no FM, no formants, no distortion), the
 * positive-going zero crossings of its output are timed, and the time of the k-th crossing is compared with the time at which the
 * integral of the intended frequency reaches k cycles. The result is the pitch error over the whole dive, in cents, and the pitch
 * itself at the start and after one, two and three `pEnvTime`.
 *   node sandbox/album/run.mjs sandbox/album/lab/growl-dive-lab.ts
 */
import { GrowlBass } from '../../../src/audio/album/instruments/bass';
import { makeCtx, playScript } from './golden-renders';

const SR = 48000;
const BPM = 120;

/** A growl that is a sine at the pitch of the note (nothing else), so that its zero crossings are its cycles. */
export const SINE_GROWL = { preset: 'dubstep-growl', fmMix: 1, fmIndex: 0, lfoFm: 0, lfoDepth: 0, lfoVowel: 0, formant: 0, drive: 0, fold: 0, clip: 0, cutoff: 9000, res: 0, tone: 18000, sub: 0, attack: 0.0005, envAmt: 0, level: 0 };

/** Times (s) of the positive-going zero crossings of x, interpolated between samples (ripple far below the signal's peak is ignored). */
export function crossings(x: ArrayLike<number>, sr: number, from = 0): number[] {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const out: number[] = [];
  for (let i = Math.max(1, from); i < x.length; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      let local = 0;
      for (let j = i; j < Math.min(x.length, i + 64); j++) local = Math.max(local, Math.abs(x[j]));
      if (local > 0.2 * peak) out.push((i - 1 + -x[i - 1] / (x[i] - x[i - 1])) / sr);
    }
  }
  return out;
}

/** The dive as the instrument is documented to make it: semitones above the note, t seconds after the note started. */
export function diveOffset(pEnv: number, pEnvTime: number, t: number): number {
  if (t >= pEnvTime) return 0;
  const e5 = Math.exp(-5);
  return pEnv * ((Math.exp((-5 * t) / pEnvTime) - e5) / (1 - e5));
}

/** Times (s) at which a tone of frequency f0 * 2^(offset(t)/12) completes cycle 1, 2, 3 ... (starting at phase 0 at t = 0). */
export function predictedCycles(f0: number, offset: (t: number) => number, seconds: number, dt = 1e-6): number[] {
  const out: number[] = [];
  let theta = 0;
  let next = 1;
  for (let t = 0; t < seconds; t += dt) {
    const f = f0 * Math.pow(2, offset(t + dt / 2) / 12);
    const d = f * dt;
    if (theta + d >= next) {
      out.push(t + ((next - theta) / d) * dt);
      next++;
    }
    theta += d;
  }
  return out;
}

if (typeof process !== 'undefined' && process.argv[1] && /growl-dive-lab/.test(process.argv[1])) {
  const note = 45; // A2 = 110 Hz
  const f0 = 110;
  // the growl ends in a 28 Hz high-pass (DC): a zero crossing of its output comes earlier than the crossing of the tone it filters by
  // atan(28 / f) / (2 pi f) seconds, and the chain (the 2x filters, the ladder) adds a constant delay, found where the pitch is steady
  const lead = (f: number): number => Math.atan(28 / f) / (2 * Math.PI * f);
  process.stdout.write('pitch of the dive: the zero crossings of a sine growl against the integral of the intended frequency (the 28 Hz high-pass and the chain delay taken into account)\n');
  for (const [pEnv, pEnvTime] of [[12, 0.08], [12, 0.25], [-12, 0.08], [7, 0.5], [24, 0.04], [-24, 0.3], [3, 0.005], [12, 1]] as const) {
    const ctx = makeCtx(SR, BPM);
    const seconds = pEnvTime * 4 + 0.6;
    const g = new GrowlBass(ctx, { ...SINE_GROWL, pEnv, pEnvTime } as never);
    const { l } = playScript(g, ctx, [{ beat: 0, kind: 'on', note, vel: 1 }], seconds);
    const got = crossings(l, SR, Math.round(0.001 * SR));
    const off = (t: number): number => diveOffset(pEnv, pEnvTime, t);
    const cyc = predictedCycles(f0, off, seconds);
    const want = cyc.map((t) => t - lead(f0 * Math.pow(2, off(t) / 12)));
    const n = Math.min(got.length, want.length);
    const L0 = got[n - 1] - want[n - 1];
    let worstUs = 0;
    let worstCents = 0;
    for (let k = 0; k < n; k++) worstUs = Math.max(worstUs, Math.abs(got[k] - want[k] - L0) * 1e6);
    for (let k = 1; k < n; k++) worstCents = Math.max(worstCents, Math.abs(1200 * Math.log2((want[k] - want[k - 1]) / (got[k] - got[k - 1]))));
    // the frequency of the cycle that contains time t
    const freqAt = (t: number): number => {
      let i = 0;
      while (i + 1 < got.length && got[i + 1] < t) i++;
      return 1 / (got[i + 1] - got[i]);
    };
    const hz = (t: number): string => `${freqAt(t).toFixed(1)}`;
    const wantHz = (t: number): string => (f0 * Math.pow(2, off(t) / 12)).toFixed(1);
    process.stdout.write(
      `  pEnv ${String(pEnv).padStart(3)} st, pEnvTime ${String(pEnvTime).padEnd(5)} s: crossings within ${worstUs.toFixed(0)} us, every cycle within ${worstCents.toFixed(1)} cents of the integral; first cycle ${hz(0.002)} Hz (the dive starts at ${(f0 * Math.pow(2, pEnv / 12)).toFixed(1)} Hz); ` +
        `at 0.5 x ${hz(pEnvTime * 0.5)} (wanted ${wantHz(pEnvTime * 0.5)}), 1 x ${hz(pEnvTime * 1.02)} (the note: ${f0} Hz), 2 x ${hz(pEnvTime * 2)}\n`,
    );
  }
}
