/**
 * The side signal that makes a mono source wide without touching its mono sum or its low end (the growl bass uses it).
 *
 * L = M + w * S and R = M - w * S, where M is the source itself and S is the part of M above a corner frequency, decorrelated from M:
 * the mono sum (L + R) / 2 is M whatever w is, and the lows, where S is silent, stay in the middle. S is made in two steps:
 *
 *   1. a Linkwitz-Riley 8th-order high-pass (two Butterworth 4th-order high-passes in series: -6 dB at the corner, 48 dB per octave
 *      below it, and, like every Linkwitz-Riley filter, flat when added to its complementary low-pass); at 120 Hz with a 200 Hz corner
 *      the side is 47 dB under the mid, so the correlation of L and R below 120 Hz is 1.000;
 *   2. a chain of four Schroeder all-pass sections (delays of 1.1, 1.9, 3.3 and 5.3 ms, feedback 0.6): their magnitude is exactly 1, so
 *      S is as loud as the high band of M, but their phase winds through the band in a way that no two neighbouring partials share,
 *      which is what decorrelates it. There is nothing to modulate: the image does not move.
 *
 * (sandbox/album/lab/growl-width-lab.ts compares this with a slowly modulated delay, with chains of second-order all-passes and with a
 * sparse random FIR: the stereo numbers are the same to a tenth of a dB, this one is the cheapest and the only one without a moving
 * comb.) Everything works on blocks, in place, and allocates nothing after the constructor.
 */
import { Biquad } from './filters';

/** Butterworth 4th-order Q factors, twice: the 8th-order Linkwitz-Riley high-pass. */
const HP_Q = [0.5411961, 1.306563, 0.5411961, 1.306563];
/** The delays (ms) of the all-pass sections: unrelated lengths, so that their phase responses do not repeat together. */
const SECTION_MS = [1.1, 1.9, 3.3, 5.3];
const SECTION_G = 0.6;

export class SideDecorrelator {
  private readonly hp: Biquad[] = HP_Q.map(() => new Biquad());
  private readonly bufs: Float64Array[];
  private readonly pos: number[];
  private corner = -1;
  constructor(private readonly sr: number) {
    this.bufs = SECTION_MS.map((ms) => new Float64Array(Math.max(1, Math.round((ms * sr) / 1000))));
    this.pos = SECTION_MS.map(() => 0);
  }
  /** Moves the corner of the high-pass (no work when it has not changed). */
  setCorner(fc: number): void {
    if (fc === this.corner) return;
    this.corner = fc;
    for (let i = 0; i < HP_Q.length; i++) this.hp[i].highpass(fc, HP_Q[i], this.sr);
  }
  /** Writes the side signal of x[0..n) (unit gain above the corner) into out[0..n); x and out may be the same array. */
  process(x: Float64Array, n: number, out: Float64Array): void {
    if (out !== x) for (let i = 0; i < n; i++) out[i] = x[i];
    for (let k = 0; k < this.hp.length; k++) this.hp[k].block(out, n);
    const g = SECTION_G;
    for (let s = 0; s < this.bufs.length; s++) {
      const buf = this.bufs[s];
      const len = buf.length;
      let p = this.pos[s];
      for (let i = 0; i < n; i++) {
        const d = buf[p];
        const v = out[i] - g * d;
        buf[p] = v;
        out[i] = d + g * v;
        if (++p >= len) p = 0;
      }
      this.pos[s] = p;
    }
  }
  /** Forgets everything (the voice that fed it has ended): the next note starts from silence. */
  clear(): void {
    for (const b of this.hp) b.reset();
    for (const b of this.bufs) b.fill(0);
    this.pos.fill(0);
  }
}
