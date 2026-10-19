/**
 * Envelopes and LFOs. Times are in seconds; exponential segments use "T60" semantics: a decay time of `t` means the segment
 * has covered 99.9 % of its distance (60 dB) after `t` seconds, which makes the numbers behave like a mixing engineer expects.
 */
import { Noise, sinCyc } from './core';

/** Per-sample multiplier that covers 99.9 % of the distance to the target in `t` seconds. */
export function t60Coef(t: number, sr: number): number {
  return Math.exp(-6.907755 / Math.max(t * sr, 1));
}

export const ENV_IDLE = 0;
export const ENV_ATTACK = 1;
export const ENV_DECAY = 2;
export const ENV_RELEASE = 3;

/** Attack (linear) / decay (exponential towards sustain) / release (exponential). Re-gating continues from the current level. */
export class Adsr {
  value = 0;
  stage = ENV_IDLE;
  private aInc = 1;
  private dCoef = 0;
  private rCoef = 0;
  sus = 0.7;
  /** Level below which a release or a sustain-less decay ends the voice. */
  floor = 1e-4;
  set(attack: number, decay: number, sustain: number, release: number, sr: number): this {
    this.aInc = 1 / Math.max(attack * sr, sr * 0.0005);
    this.dCoef = t60Coef(decay, sr);
    this.rCoef = t60Coef(release, sr);
    this.sus = sustain;
    return this;
  }
  gateOn(): void {
    this.stage = ENV_ATTACK;
  }
  gateOff(): void {
    if (this.stage !== ENV_IDLE) this.stage = ENV_RELEASE;
  }
  kill(): void {
    this.stage = ENV_IDLE;
    this.value = 0;
  }
  get active(): boolean {
    return this.stage !== ENV_IDLE;
  }
  /**
   * Writes the next n levels into out[0..n) (the same sequence n calls of next() produce, in tight per-stage loops). Returns the
   * index at which the envelope ended (out[index..] are 0), or -1 if it is still running.
   */
  fill(out: Float64Array, n: number): number {
    let i = 0;
    let v = this.value;
    let st = this.stage;
    let idle = -1;
    while (i < n) {
      if (st === ENV_ATTACK) {
        const inc = this.aInc;
        while (i < n) {
          v += inc;
          if (v >= 1) {
            v = 1;
            out[i++] = 1;
            st = ENV_DECAY;
            break;
          }
          out[i++] = v;
        }
      } else if (st === ENV_DECAY) {
        const sus = this.sus;
        const k = this.dCoef;
        if (sus <= 0) {
          const fl = this.floor;
          while (i < n) {
            v *= k;
            if (v < fl) {
              v = 0;
              st = ENV_IDLE;
              idle = i;
              out[i++] = 0;
              break;
            }
            out[i++] = v;
          }
        } else {
          while (i < n) {
            v = sus + (v - sus) * k;
            out[i++] = v;
          }
        }
      } else if (st === ENV_RELEASE) {
        const k = this.rCoef;
        const fl = this.floor;
        while (i < n) {
          v *= k;
          if (v < fl) {
            v = 0;
            st = ENV_IDLE;
            idle = i;
            out[i++] = 0;
            break;
          }
          out[i++] = v;
        }
      } else {
        // idle (or sustain-less hold): silent
        if (idle < 0 && st === ENV_IDLE) idle = i;
        v = 0;
        while (i < n) out[i++] = 0;
      }
    }
    this.value = v;
    this.stage = st;
    return idle;
  }
  /** Advances one sample and returns the level. */
  next(): number {
    switch (this.stage) {
      case ENV_ATTACK:
        this.value += this.aInc;
        if (this.value >= 1) {
          this.value = 1;
          this.stage = ENV_DECAY;
        }
        break;
      case ENV_DECAY:
        this.value = this.sus + (this.value - this.sus) * this.dCoef;
        if (this.sus <= 0 && this.value < this.floor) {
          this.value = 0;
          this.stage = ENV_IDLE;
        }
        break;
      case ENV_RELEASE:
        this.value *= this.rCoef;
        if (this.value < this.floor) {
          this.value = 0;
          this.stage = ENV_IDLE;
        }
        break;
      default:
        break;
    }
    return this.value;
  }
}

export type LfoShape = 'sine' | 'tri' | 'saw' | 'ramp' | 'square' | 'sh' | 'smooth';

/**
 * Low-frequency oscillator, output in [-1, 1]. Advance with `advance(cycles)` (cycles of phase, not seconds) and read
 * `value(shape)`. 'sh' holds a random value per cycle, 'smooth' glides between them.
 */
export class Lfo {
  phase = 0;
  private held = 0;
  private prev = 0;
  private readonly rng: Noise;
  constructor(seed = 1, phase = 0) {
    this.rng = new Noise(seed);
    this.phase = phase;
    this.held = this.rng.next();
    this.prev = this.held;
  }
  advance(cycles: number): void {
    let p = this.phase + cycles;
    if (p >= 1) {
      // may cross several cycles on a very high rate; one new random value is enough
      p -= Math.floor(p);
      this.prev = this.held;
      this.held = this.rng.next();
    }
    this.phase = p;
  }
  value(shape: LfoShape): number {
    const p = this.phase;
    switch (shape) {
      case 'sine':
        return sinCyc(p);
      case 'tri':
        return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
      case 'saw':
        return 2 * p - 1;
      case 'ramp':
        return 1 - 2 * p;
      case 'square':
        return p < 0.5 ? 1 : -1;
      case 'sh':
        return this.held;
      default: {
        const s = p * p * (3 - 2 * p);
        return this.prev + (this.held - this.prev) * s;
      }
    }
  }
}

/** Linear ramp helper for per-segment parameter smoothing: call `to(target, n)` then `next()` n times. */
export class Ramp {
  value = 0;
  private step = 0;
  to(target: number, n: number): void {
    this.step = n > 0 ? (target - this.value) / n : 0;
    if (n <= 0) this.value = target;
  }
  next(): number {
    this.value += this.step;
    return this.value;
  }
  snap(v: number): void {
    this.value = v;
    this.step = 0;
  }
}
