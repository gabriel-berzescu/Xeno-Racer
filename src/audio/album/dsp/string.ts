/**
 * Plucked-string waveguide: extended Karplus-Strong (Jaffe & Smith 1983) with
 *   - a one-zero loop filter whose coefficient sets the brightness / decay of the highs and whose gain sets the decay time,
 *   - a first-order all-pass for exact tuning,
 *   - a pluck excitation made from low-passed noise shaped by a comb filter (pick position) and a pick-stiffness filter,
 *   - an output comb (pickup position), and
 *   - fast damping on release (the picking hand stopping the string), or a stronger loop loss for palm muting.
 * One instance is one string; it needs no memory outside its own buffers.
 */
import { Noise } from './core';

export interface PluckParams {
  /** Seconds for the string to fall 60 dB (open string, at the fundamental). */
  decay: number;
  /** 0..1: how well the high harmonics survive (0 = dull, 1 = bright and metallic). */
  bright: number;
  /** Pick position along the string, 0.05..0.5 of its length (comb in the excitation). */
  pickPos: number;
  /** 0..1: pick hardness, i.e. how much high-frequency energy the pluck carries. */
  pickHard: number;
  /** Pickup position, 0.05..0.4 of the string length from the bridge (output comb; 0 = off). */
  pickup: number;
  /** Palm mute (strong, dark damping). */
  mute: boolean;
  /** Pitch bend at the start in semitones (positive = starts sharp), fading in 40 ms (string tension). */
  attackBend: number;
}

export class KsString {
  private readonly buf: Float64Array;
  private readonly mask: number;
  private wp = 0;
  private N = 100;
  private S = 0.4;
  private rho = 0.999;
  private apC = 0;
  private apX = 0;
  private apY = 0;
  private lpPrev = 0;
  private readonly exc: Float64Array;
  private readonly tmp: Float64Array;
  private excLen = 0;
  private excPos = 0;
  private pickupOff = 0;
  private releasing = false;
  private relRho = 0.5;
  private readonly noise: Noise;
  private readonly sr: number;
  private bendSemis = 0;
  private bendT = 0;
  private baseT = 100;
  private slideSemis = 0;
  private slideLeft = 0;
  private slideStep = 0;
  active = false;
  /** Samples since the pluck. */
  age = 0;
  freq = 0;
  /** Energy follower for voice stealing. */
  level = 0;

  constructor(sr: number, lowestHz = 30, seed = 1) {
    this.sr = sr;
    this.noise = new Noise(seed);
    let n = 64;
    const maxN = Math.ceil(sr / lowestHz) + 8;
    while (n < maxN + 4) n <<= 1;
    this.buf = new Float64Array(n);
    this.mask = n - 1;
    this.exc = new Float64Array(maxN + 8);
    this.tmp = new Float64Array(maxN + 8);
  }

  /** Total loop delay in samples for a given fundamental and loop-filter coefficient. */
  private retune(freq: number): void {
    const T = this.sr / freq - this.S; // delay the delay line + all-pass must provide
    const N = Math.max(2, Math.floor(T - 0.5));
    const d = T - N; // in [0.5, 1.5)
    this.N = N;
    this.apC = (1 - d) / (1 + d);
  }

  pluck(freq: number, vel: number, p: PluckParams, slideFrom = 0, slideTime = 0.05): void {
    const sr = this.sr;
    this.freq = freq;
    // loop filter: S = 0.5 (dull) .. 0.08 (bright); rho from the requested decay time
    this.S = 0.5 - 0.42 * Math.min(1, Math.max(0, p.bright));
    const decay = p.mute ? 0.16 : p.decay;
    if (p.mute) this.S = 0.5;
    this.rho = Math.pow(10, -3 / (Math.max(decay, 0.02) * freq));
    this.baseT = sr / freq;
    this.slideSemis = slideFrom;
    this.slideLeft = slideFrom !== 0 ? Math.round(slideTime * sr) : 0;
    this.slideStep = this.slideLeft > 0 ? slideFrom / this.slideLeft : 0;
    this.bendSemis = p.attackBend;
    this.bendT = 0;
    this.retune(slideFrom !== 0 ? freq * Math.pow(2, slideFrom / 12) : freq * Math.pow(2, p.attackBend / 12));
    // excitation: the string is pulled into a triangle whose peak sits at the pick position and released (so the harmonics fall
    // off as 1/n^2 and the pick-position comb comes out by itself). A rounded pick = a smoothed corner; a hard pick keeps the
    // corner sharp (more high harmonics). A little noise and a short pick-scrape burst give the attack its bite.
    const len = Math.min(this.exc.length - 2, Math.max(4, Math.round(sr / freq)));
    const ex = this.exc;
    const nz = this.noise;
    const beta = Math.min(0.5, Math.max(0.04, p.pickPos));
    for (let i = 0; i < len; i++) {
      const x = (i + 0.5) / len;
      ex[i] = x < beta ? x / beta : (1 - x) / (1 - beta);
    }
    const hard = Math.min(1, 0.1 + 0.9 * Math.pow(p.pickHard, 1.2) * (0.5 + 0.5 * vel));
    // zero-phase smoothing (a pass forward and a pass back) with a one-pole: k near 1 = barely smoothed
    const k = 0.04 + 0.96 * Math.pow(hard, 2);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      lp += k * (ex[i] - lp);
      ex[i] = lp;
    }
    lp = 0;
    for (let i = len - 1; i >= 0; i--) {
      lp += k * (ex[i] - lp);
      ex[i] = lp;
    }
    const tmp = this.tmp;
    const scrapeN = Math.min(len, Math.round(0.003 * sr));
    let prevN = 0;
    for (let i = 0; i < len; i++) {
      const w = nz.next();
      let v = ex[i] + 0.03 * w;
      if (i < scrapeN) {
        // pick scrape: high-passed noise that dies within 3 ms
        const hp = w - prevN;
        v += 0.16 * hard * (0.4 + 0.6 * vel) * hp * (1 - i / scrapeN);
      }
      prevN = w;
      tmp[i] = v;
    }
    let mean = 0;
    for (let i = 0; i < len; i++) mean += tmp[i];
    mean /= len;
    let peak = 1e-9;
    for (let i = 0; i < len; i++) {
      tmp[i] -= mean;
      peak = Math.max(peak, Math.abs(tmp[i]));
    }
    const amp = (0.25 + 0.75 * vel) / peak;
    for (let i = 0; i < len; i++) ex[i] = tmp[i] * amp;
    this.excLen = len;
    this.excPos = 0;
    this.pickupOff = p.pickup > 0 ? Math.max(1, Math.round(p.pickup * (sr / freq))) : 0;
    this.releasing = false;
    // clear the delay line so that a restruck string does not carry the old tone (the hand/pick stops it)
    this.buf.fill(0);
    this.wp = 0;
    this.apX = 0;
    this.apY = 0;
    this.lpPrev = 0;
    this.age = 0;
    this.level = vel;
    this.active = true;
  }

  /** Starts damping the string (note end): the loop gain drops so the string dies within `time` seconds. */
  damp(time: number): void {
    if (!this.active || this.releasing) return;
    this.releasing = true;
    this.relRho = Math.pow(10, -3 / (Math.max(time, 0.004) * this.freq));
  }

  /** Adds n samples of this string into out (with the pickup comb applied). */
  process(out: Float64Array, n: number, start = 0): void {
    if (!this.active) return;
    const buf = this.buf;
    const mask = this.mask;
    let wp = this.wp;
    let apX = this.apX;
    let apY = this.apY;
    let lpPrev = this.lpPrev;
    const S = this.S;
    const rho = this.releasing ? this.relRho : this.rho;
    const ex = this.exc;
    let excPos = this.excPos;
    const excLen = this.excLen;
    let N = this.N;
    let c = this.apC;
    const pOff = this.pickupOff;
    let peak = 0;
    for (let i = start; i < n; i++) {
      // pitch movements (slides, string-tension bend) re-tune once per 32 samples
      if (((i - start) & 31) === 0 && (this.slideLeft > 0 || this.bendSemis !== 0)) {
        if (this.slideLeft > 0) {
          this.slideSemis -= this.slideStep * 32;
          this.slideLeft -= 32;
          if (this.slideLeft <= 0) {
            this.slideSemis = 0;
            this.slideLeft = 0;
          }
        }
        this.bendT += 32;
        const bend = this.bendSemis * Math.exp(-this.bendT / (0.04 * this.sr));
        if (Math.abs(bend) < 0.004) this.bendSemis = 0;
        const semis = this.slideSemis + bend;
        this.retune(this.freq * Math.pow(2, semis / 12));
        N = this.N;
        c = this.apC;
      }
      const yN = buf[(wp - N) & mask];
      // loop filter (one zero) and loop gain
      const v = rho * ((1 - S) * yN + S * lpPrev);
      lpPrev = yN;
      // all-pass tuning
      const a = c * v + apX - c * apY;
      apX = v;
      apY = a;
      let x = a;
      if (excPos < excLen) x += ex[excPos++];
      buf[wp & mask] = x + 1e-24;
      // output: the string displacement read through the pickup comb
      let o = x;
      if (pOff > 0) o -= buf[(wp - pOff) & mask];
      wp = (wp + 1) & mask;
      out[i] += o;
      const ao = o < 0 ? -o : o;
      if (ao > peak) peak = ao;
    }
    this.wp = wp;
    this.apX = apX;
    this.apY = apY;
    this.lpPrev = lpPrev;
    this.excPos = excPos;
    this.age += n - start;
    this.level = Math.max(peak, this.level * 0.9);
    if (this.age > this.sr * 0.05 && peak < 1e-5) this.active = false;
  }

  reset(): void {
    this.active = false;
    this.buf.fill(0);
  }
}

