/**
 * ThunderVoice — one distant clap of thunder: low-pass filtered noise (decorrelated left / right) shaped
 * by a rolling multi-lobe envelope (see planThunder), the cutoff sweeping down as the sound travels, a
 * slow flutter on the level so it "rolls". Meant to be mixed under the rain: never a sharp crack.
 *
 * No allocation after construction; render() adds into the caller's buffers.
 */
import { type ThunderEvent, type ThunderPlan, makeThunderPlan, planThunder, thunderEnvelope } from '../weather-model';
import { SVF } from './filters';
import { Rng, clamp, lerp, ouStep, smoothCoef } from './util';

/** Linear gain that puts a level-1 clap at roughly -19 dBFS RMS (100 ms) at its loudest moment. */
export const THUNDER_GAIN = 0.31;

export class ThunderVoice {
  active = false;
  /** Seconds since the strike's sound began. */
  t = 0;
  readonly plan: ThunderPlan = makeThunderPlan();
  private rng = new Rng(3);
  private a1L = new SVF();
  private a2L = new SVF();
  private a1R = new SVF();
  private a2R = new SVF();
  private fl1 = 0;
  private fl2 = 0;
  private lastEnv = 0;
  private gL = 1;
  private gR = 1;
  private readonly sr: number;

  constructor(sr: number) {
    this.sr = sr;
  }

  trigger(ev: ThunderEvent): void {
    planThunder(this.plan, ev);
    this.rng.s = Math.imul(Math.floor(ev.seed) | 0, 0x9e3779b1) | 0 || 0x1234567;
    for (let i = 0; i < 4; i++) this.rng.u();
    this.t = 0;
    this.active = true;
    this.a1L.reset();
    this.a2L.reset();
    this.a1R.reset();
    this.a2R.reset();
    this.fl1 = 0;
    this.fl2 = 0;
    this.lastEnv = 0;
    const a = ((this.plan.pan + 1) * Math.PI) / 4;
    // equal-power but never fully one-sided: the rumble is wide
    this.gL = lerp(Math.SQRT1_2, Math.cos(a), 0.6);
    this.gR = lerp(Math.SQRT1_2, Math.sin(a), 0.6);
  }

  stop(): void {
    this.active = false;
  }

  /** Add `len` samples at `o` into outL / outR. `interior` (0..1) darkens and softens the clap. */
  render(outL: Float32Array, outR: Float32Array, o: number, len: number, interior: number, gain: number): void {
    if (!this.active) return;
    const p = this.plan;
    const dt = len / this.sr;
    if (this.t > p.dur) {
      this.active = false;
      return;
    }
    const rng = this.rng;
    // slow flutter makes the rumble roll: two Ornstein-Uhlenbeck processes (~7 Hz and ~1.8 Hz)
    const k1 = smoothCoef(0.14, dt);
    const k2 = smoothCoef(0.55, dt);
    this.fl1 = ouStep(this.fl1, k1, 1, rng.s2());
    this.fl2 = ouStep(this.fl2, k2, 1, rng.s2());
    const flutter = clamp(1 + 0.22 * this.fl1 + 0.16 * this.fl2, 0.35, 1.7);

    const fcT = p.fc1 + (p.fc0 - p.fc1) * Math.exp(-this.t / p.tauFc);
    const fc = fcT * lerp(1, 0.72, interior);
    this.a1L.set(fc, 0.72, this.sr);
    this.a2L.set(fc * 1.15, 0.6, this.sr);
    this.a1R.set(fc, 0.72, this.sr);
    this.a2R.set(fc * 1.15, 0.6, this.sr);
    // keep the loudness steady as the cutoff sweeps (noise power ~ bandwidth)
    const comp = Math.sqrt(this.sr / (2.4 * fc));
    const env1 = thunderEnvelope(p, this.t + dt);
    const env0 = this.lastEnv;
    this.lastEnv = env1;
    const amp = THUNDER_GAIN * p.level * comp * flutter * gain * lerp(1, 0.8, interior);
    const e0 = env0 * amp;
    const eStep = (env1 * amp - e0) / len;
    let e = e0;
    const gL = this.gL;
    const gR = this.gR;
    for (let i = 0; i < len; i++) {
      e += eStep;
      this.a1L.step(rng.s2());
      this.a2L.step(this.a1L.lp);
      this.a1R.step(rng.s2());
      this.a2R.step(this.a1R.lp);
      outL[o + i] += this.a2L.lp * e * gL;
      outR[o + i] += this.a2R.lp * e * gR;
    }
    this.t += dt;
  }
}
