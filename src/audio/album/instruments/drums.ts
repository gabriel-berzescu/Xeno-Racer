/**
 * Electronic drums: kick, snare, clap, hi-hat, toms, cymbals and small percussion, plus the DrumKit that groups them into
 * one channel with named parts. Every drum is synthesised per hit (no samples); cymbals play back a buffer that is built once
 * from modal synthesis (dsp/cymbal.ts).
 *
 * Parameters are documented in the *_SPECS tables below (they feed the README and the automation validator); presets are in
 * DRUM_PRESETS. Velocity changes loudness and brightness. Flags: ACCENT/GHOST scale the hit, OPEN selects the open hat.
 */
import { Noise, TAU, dbToLin, sinCyc, tanh3 } from '../dsp/core';
import { t60Coef } from '../dsp/env';
import { Svf } from '../dsp/filters';
import { pulseBL } from '../dsp/osc';
import { CYMBAL_RECIPES, CymbalBuffer, renderCymbal } from '../dsp/cymbal';
import { BLOCK, Ctx, FLAG, Instrument, ParamBase, ParamSpecs, PresetDef, resolveOpts } from '../instrument';

// ─────────────────────────────────────────────────────────────────────────────
// shared base
// ─────────────────────────────────────────────────────────────────────────────

/** Base class of the single-sound drums: mono, no sustained notes, `hit` and `noteOn` both trigger. */
export abstract class DrumBase<S extends ParamSpecs> extends ParamBase<S> implements Instrument {
  readonly stereo: boolean = false;
  readonly parts: readonly string[];
  protected readonly sr: number;
  protected readonly noise: Noise;
  constructor(label: string, specs: S, ctx: Ctx, opts: Record<string, unknown>, part: string) {
    super(label, specs, opts);
    this.sr = ctx.sr;
    this.noise = new Noise(ctx.seed);
    this.parts = [part];
  }
  abstract trigger(vel: number, dur: number, flags: number, note: number): void;
  abstract process(l: Float64Array, r: Float64Array, n: number): void;
  abstract active(): boolean;
  noteOn(note: number, vel: number, dur: number, flags: number): void {
    this.trigger(vel, dur, flags, note);
  }
  noteOff(): void {}
  hit(_part: string, vel: number, dur: number, flags: number): void {
    this.trigger(vel, dur, flags, 60);
  }
}

/** Velocity -> gain curve shared by the drums: `amount` 0 ignores velocity, 1 is a natural curve. */
function velGain(vel: number, flags: number, amount: number): number {
  let v = vel;
  if (flags & FLAG.ACCENT) v = Math.min(1, v * 1.1);
  if (flags & FLAG.GHOST) v *= 0.8;
  const curve = Math.pow(Math.max(v, 0.02), 1.5);
  return 1 - amount + amount * curve;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kick
// ─────────────────────────────────────────────────────────────────────────────

export const KICK_SPECS = {
  level: { default: 0, min: -30, max: 12, unit: 'dB', doc: 'Trim in dB on top of the preset\'s calibrated loudness (0 = as calibrated; the fader is the channel\'s `gain` in the mix).' },
  pitch: { default: 52, min: 28, max: 130, unit: 'Hz', curve: 'exp', doc: 'The note the kick settles on (its fundamental): 45-60 Hz for dark, heavy kicks, up to 80 for tight ones.' },
  sweep: { default: 2.3, min: 0, max: 4.5, unit: 'octaves', doc: 'How far above `pitch` the kick starts. 1 = soft 808, 2-3 = punchy, 3.5+ = psytrance zap.' },
  sweepTime: { default: 0.038, min: 0.004, max: 0.25, unit: 's', doc: 'Time constant of the pitch drop. Short = clicky/zappy, long = booming.' },
  punch: { default: 0.4, min: 0, max: 1, doc: 'Extra fast pitch snap and level in the first 8 ms: the chest thump.' },
  decay: { default: 0.36, min: 0.05, max: 1.8, unit: 's', doc: 'Amplitude decay (time to -60 dB). Shorter than the beat spacing keeps the bass clear.' },
  hold: { default: 0, min: 0, max: 0.4, unit: 's', doc: 'Time the level is held before it decays (808 booms).' },
  click: { default: 0.35, min: 0, max: 1, doc: 'Level of the beater click.' },
  clickTone: { default: 3200, min: 800, max: 9000, unit: 'Hz', curve: 'exp', doc: 'Pitch of the click: low = thud, high = tick.' },
  drive: { default: 10, min: 0, max: 36, unit: 'dB', doc: 'Saturation: harmonics, loudness and aggression.' },
  tone: { default: 9000, min: 400, max: 18000, unit: 'Hz', curve: 'exp', doc: 'Low-pass: lower values make a rounder kick.' },
  tail: { default: 0.15, min: 0, max: 1, doc: 'Level of a longer pure sub tone under the body.' },
  velocity: { default: 0.6, min: 0, max: 1, doc: 'How much velocity changes the level and the click (0 = every hit equally loud).' },
} satisfies ParamSpecs;

interface KickVoice {
  on: boolean;
  t: number;
  ph: number;
  ph2: number;
  fdev: number;
  pdev: number;
  amp: number;
  tailAmp: number;
  holdLeft: number;
  vel: number;
  clk: number;
  lpA: number;
  lpB: number;
  lp: number;
  choke: number;
  ampK: number;
  tailK: number;
  fEnd: number;
  g: number;
}

export class Kick extends DrumBase<typeof KICK_SPECS> {
  private readonly voices: KickVoice[] = [];
  constructor(ctx: Ctx, opts: Record<string, unknown> = {}) {
    super('Kick', KICK_SPECS, ctx, opts, 'kick');
    for (let i = 0; i < 4; i++)
      this.voices.push({ on: false, t: 0, ph: 0, ph2: 0, fdev: 0, pdev: 0, amp: 0, tailAmp: 0, holdLeft: 0, vel: 1, clk: 0, lpA: 0, lpB: 0, lp: 0, choke: 1, ampK: 0, tailK: 0, fEnd: 50, g: 1 });
  }
  trigger(vel: number, _dur: number, flags: number): void {
    const p = this.params;
    const sr = this.sr;
    // choke ringing voices so a re-trigger does not stack tails
    for (const o of this.voices) if (o.on) o.choke = Math.min(o.choke, 0.999);
    let v = this.voices.find((x) => !x.on);
    if (!v) {
      v = this.voices[0];
      for (const o of this.voices) if (o.t > v.t) v = o;
    }
    const g = velGain(vel, flags, p.velocity);
    v.on = true;
    v.t = 0;
    v.ph = 0;
    v.ph2 = 0;
    v.fEnd = p.pitch;
    v.fdev = p.pitch * (Math.pow(2, p.sweep) - 1);
    v.pdev = p.pitch * 2.2 * p.punch;
    v.amp = 1;
    v.tailAmp = p.tail * 0.8;
    v.holdLeft = Math.round(p.hold * sr);
    v.vel = g;
    v.clk = p.click * (0.4 + 0.6 * g);
    v.lpA = 0;
    v.lpB = 0;
    v.lp = 0;
    v.choke = 1;
    v.ampK = t60Coef(p.decay, sr);
    v.tailK = t60Coef(p.decay * 2.2 + 0.1, sr);
    v.g = g;
  }
  process(l: Float64Array, _r: Float64Array, n: number): void {
    const p = this.params;
    const sr = this.sr;
    const out = dbToLin(p.level + (-6));
    const drive = dbToLin(p.drive);
    const norm = 0.92 / tanh3(drive);
    const sweepK = Math.exp(-1 / (p.sweepTime * sr));
    const punchK = Math.exp(-1 / (0.0055 * sr));
    const clickK = Math.exp(-1 / (0.0011 * sr));
    const toneK = 1 - Math.exp((-TAU * p.tone) / sr);
    const cA = 1 - Math.exp((-TAU * p.clickTone * 1.7) / sr);
    const cB = 1 - Math.exp((-TAU * p.clickTone * 0.55) / sr);
    const punch = p.punch;
    const nz = this.noise;
    for (const v of this.voices) {
      if (!v.on) continue;
      let { ph, ph2, fdev, pdev, amp, tailAmp, holdLeft, clk, lpA, lpB, lp, choke, t } = v;
      const ampK = v.ampK;
      const tailK = v.tailK;
      const fEnd = v.fEnd;
      const gain = v.g;
      const choking = choke < 1;
      for (let i = 0; i < n; i++) {
        const f = fEnd + fdev + pdev;
        ph += f / sr;
        if (ph >= 1) ph -= Math.floor(ph);
        ph2 += fEnd / sr;
        if (ph2 >= 1) ph2 -= 1;
        const att = t < 24 ? t / 24 : 1; // 0.5 ms click-free attack
        let body = sinCyc(ph) * amp * (1 + 0.7 * punch * (pdev / (fEnd * 2.2 * punch + 1e-9)));
        body += sinCyc(ph2) * tailAmp;
        // click: band-passed noise burst
        let c = 0;
        if (clk > 1e-3) {
          const w = nz.next();
          lpA += cA * (w - lpA);
          lpB += cB * (w - lpB);
          c = (lpA - lpB) * clk * 2.2;
          clk *= clickK;
        }
        const x = (body + c) * att * gain;
        let y = tanh3(x * drive) * norm;
        lp += toneK * (y - lp);
        y = lp;
        if (choking) {
          choke -= 1 / (0.005 * sr);
          if (choke <= 0) {
            v.on = false;
            break;
          }
          y *= choke;
        }
        l[i] += y * out;
        fdev *= sweepK;
        pdev *= punchK;
        if (holdLeft > 0) holdLeft--;
        else amp *= ampK;
        tailAmp *= tailK;
        t++;
      }
      v.ph = ph;
      v.ph2 = ph2;
      v.fdev = fdev;
      v.pdev = pdev;
      v.amp = amp;
      v.tailAmp = tailAmp;
      v.holdLeft = holdLeft;
      v.clk = clk;
      v.lpA = lpA;
      v.lpB = lpB;
      v.lp = lp;
      v.choke = choke;
      v.t = t;
      if (v.on && amp < 4e-4 && tailAmp < 4e-4) v.on = false;
    }
  }
  active(): boolean {
    return this.voices.some((v) => v.on);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Snare
// ─────────────────────────────────────────────────────────────────────────────

export const SNARE_SPECS = {
  level: { default: 0, min: -30, max: 12, unit: 'dB', doc: 'Trim in dB on top of the preset\'s calibrated loudness (0 = as calibrated; the fader is the channel\'s `gain` in the mix).' },
  tune: { default: 190, min: 100, max: 420, unit: 'Hz', curve: 'exp', doc: 'Pitch of the drum body.' },
  body: { default: 0.7, min: 0, max: 1.5, doc: 'Level of the tonal body (the "thump").' },
  bodyDecay: { default: 0.11, min: 0.02, max: 0.6, unit: 's', doc: 'Decay of the body.' },
  noise: { default: 0.85, min: 0, max: 1.5, doc: 'Level of the noise (the snare wires).' },
  noiseDecay: { default: 0.2, min: 0.03, max: 1.2, unit: 's', doc: 'Decay of the noise. Long = big gated-reverb snare.' },
  noiseTone: { default: 4300, min: 1200, max: 10000, unit: 'Hz', curve: 'exp', doc: 'Centre of the noise band: lower = fatter, higher = crisper.' },
  noiseQ: { default: 0.9, min: 0.3, max: 5, doc: 'Narrowness of the noise band.' },
  snap: { default: 0.5, min: 0, max: 1.5, doc: 'The first crack: a very short loud burst of noise.' },
  tail: { default: 0, min: 0, max: 1, doc: 'Adds a slow noise tail behind the hit (a poor man\'s reverb).' },
  drive: { default: 6, min: 0, max: 30, unit: 'dB', doc: 'Saturation.' },
  velocity: { default: 0.7, min: 0, max: 1, doc: 'How much velocity changes level and brightness.' },
} satisfies ParamSpecs;

interface SnareVoice {
  on: boolean;
  t: number;
  ph1: number;
  ph2: number;
  bodyAmp: number;
  bodyAmp2: number;
  nAmp: number;
  snapAmp: number;
  tailAmp: number;
  g: number;
  flt: Svf;
  hpState: number;
  choke: number;
}

export class Snare extends DrumBase<typeof SNARE_SPECS> {
  private readonly voices: SnareVoice[] = [];
  constructor(ctx: Ctx, opts: Record<string, unknown> = {}) {
    super('Snare', SNARE_SPECS, ctx, opts, 'snare');
    for (let i = 0; i < 3; i++) this.voices.push({ on: false, t: 0, ph1: 0, ph2: 0, bodyAmp: 0, bodyAmp2: 0, nAmp: 0, snapAmp: 0, tailAmp: 0, g: 1, flt: new Svf(), hpState: 0, choke: 1 });
  }
  trigger(vel: number, _dur: number, flags: number): void {
    const p = this.params;
    for (const o of this.voices) if (o.on) o.choke = Math.min(o.choke, 0.999);
    let v = this.voices.find((x) => !x.on);
    if (!v) {
      v = this.voices[0];
      for (const o of this.voices) if (o.t > v.t) v = o;
    }
    const g = velGain(vel, flags, p.velocity);
    v.on = true;
    v.t = 0;
    v.ph1 = 0;
    v.ph2 = 0;
    v.bodyAmp = 1;
    v.bodyAmp2 = 1;
    v.nAmp = 1;
    v.snapAmp = 1;
    v.tailAmp = p.tail;
    v.g = g;
    v.flt.reset();
    v.flt.set(p.noiseTone * (0.8 + 0.4 * g), p.noiseQ, this.sr);
    v.hpState = 0;
    v.choke = 1;
  }
  process(l: Float64Array, _r: Float64Array, n: number): void {
    const p = this.params;
    const sr = this.sr;
    const out = dbToLin(p.level + (-4));
    const drive = dbToLin(p.drive);
    const norm = 0.9 / tanh3(drive);
    const bodyK = t60Coef(p.bodyDecay, sr);
    const bodyK2 = t60Coef(p.bodyDecay * 0.55, sr);
    const nK = t60Coef(p.noiseDecay, sr);
    const snapK = Math.exp(-1 / (0.006 * sr));
    const tailK = t60Coef(0.55, sr);
    const hpK = 1 - Math.exp((-TAU * 1300) / sr);
    const nz = this.noise;
    for (const v of this.voices) {
      if (!v.on) continue;
      let { t, ph1, ph2, bodyAmp, bodyAmp2, nAmp, snapAmp, tailAmp, hpState, choke } = v;
      const g = v.g;
      const flt = v.flt;
      for (let i = 0; i < n; i++) {
        const drop = 1 + 0.38 * Math.exp(-t / (0.022 * sr)) ;
        const f1 = p.tune * drop;
        ph1 += f1 / sr;
        if (ph1 >= 1) ph1 -= 1;
        ph2 += (p.tune * 1.67 * drop) / sr;
        if (ph2 >= 1) ph2 -= 1;
        const body = (sinCyc(ph1) * bodyAmp + 0.45 * sinCyc(ph2) * bodyAmp2) * p.body;
        const w = nz.next();
        flt.step(w);
        // band-passed noise plus a high-passed copy for air
        hpState += hpK * (w - hpState);
        const air = (w - hpState) * 0.35;
        const env = nAmp * (1 + 2.2 * p.snap * snapAmp) + p.tail * tailAmp * 0.9;
        const nse = (flt.bp * flt.k * 1.0 + air) * env * p.noise;
        let x = (body + nse * 0.7) * g;
        const att = t < 12 ? t / 12 : 1;
        x *= att;
        let y = tanh3(x * drive) * norm;
        if (choke < 1) {
          choke -= 1 / (0.006 * sr);
          if (choke <= 0) {
            v.on = false;
            break;
          }
          y *= choke;
        }
        l[i] += y * out;
        bodyAmp *= bodyK;
        bodyAmp2 *= bodyK2;
        nAmp *= nK;
        snapAmp *= snapK;
        tailAmp *= tailK;
        t++;
      }
      v.t = t;
      v.ph1 = ph1;
      v.ph2 = ph2;
      v.bodyAmp = bodyAmp;
      v.bodyAmp2 = bodyAmp2;
      v.nAmp = nAmp;
      v.snapAmp = snapAmp;
      v.tailAmp = tailAmp;
      v.hpState = hpState;
      v.choke = choke;
      if (v.on && bodyAmp < 3e-4 && nAmp < 3e-4 && tailAmp < 3e-4) v.on = false;
    }
  }
  active(): boolean {
    return this.voices.some((v) => v.on);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Clap
// ─────────────────────────────────────────────────────────────────────────────

export const CLAP_SPECS = {
  level: { default: 0, min: -30, max: 12, unit: 'dB', doc: 'Trim in dB on top of the preset\'s calibrated loudness (0 = as calibrated; the fader is the channel\'s `gain` in the mix).' },
  tone: { default: 1500, min: 600, max: 4000, unit: 'Hz', curve: 'exp', doc: 'Centre of the noise band.' },
  q: { default: 1.2, min: 0.4, max: 5, doc: 'Narrowness of the band.' },
  decay: { default: 0.16, min: 0.04, max: 0.8, unit: 's', doc: 'Length of the final tail.' },
  bursts: { default: 4, min: 1, max: 7, doc: 'Number of quick bursts before the tail (the "hands").' },
  spread: { default: 9, min: 3, max: 25, unit: 'ms', doc: 'Time between the bursts.' },
  drive: { default: 4, min: 0, max: 24, unit: 'dB', doc: 'Saturation.' },
  velocity: { default: 0.6, min: 0, max: 1, doc: 'How much velocity changes the level.' },
} satisfies ParamSpecs;

interface ClapVoice {
  on: boolean;
  t: number;
  g: number;
  flt: Svf;
  offsets: number[];
  tailAmp: number;
}

export class Clap extends DrumBase<typeof CLAP_SPECS> {
  private readonly voices: ClapVoice[] = [];
  constructor(ctx: Ctx, opts: Record<string, unknown> = {}) {
    super('Clap', CLAP_SPECS, ctx, opts, 'clap');
    for (let i = 0; i < 3; i++) this.voices.push({ on: false, t: 0, g: 1, flt: new Svf(), offsets: [], tailAmp: 0 });
  }
  trigger(vel: number, _dur: number, flags: number): void {
    const p = this.params;
    let v = this.voices.find((x) => !x.on);
    if (!v) {
      v = this.voices[0];
      for (const o of this.voices) if (o.t > v.t) v = o;
    }
    v.on = true;
    v.t = 0;
    v.g = velGain(vel, flags, p.velocity);
    v.flt.reset();
    v.flt.set(p.tone, p.q, this.sr);
    // burst onsets with a little deterministic jitter
    v.offsets = [];
    const nb = Math.round(p.bursts);
    for (let k = 0; k < nb; k++) v.offsets.push(Math.round(((k * p.spread + (this.noise.next() * 0.5) * p.spread * 0.25) / 1000) * this.sr));
    v.tailAmp = 1;
  }
  process(l: Float64Array, _r: Float64Array, n: number): void {
    const p = this.params;
    const sr = this.sr;
    const out = dbToLin(p.level + (-1));
    const drive = dbToLin(p.drive);
    const norm = 0.85 / tanh3(drive);
    const burstK = Math.exp(-1 / (0.0055 * sr));
    const tailK = t60Coef(p.decay, sr);
    const nz = this.noise;
    for (const v of this.voices) {
      if (!v.on) continue;
      const lastBurst = v.offsets[v.offsets.length - 1] ?? 0;
      for (let i = 0; i < n; i++) {
        const t = v.t;
        // sum of the burst envelopes
        let e = 0;
        for (let k = 0; k < v.offsets.length; k++) {
          const dt = t - v.offsets[k];
          if (dt >= 0 && dt < 0.04 * sr) e += Math.pow(burstK, dt) * (k === v.offsets.length - 1 ? 0.8 : 1);
        }
        // the tail starts with the last burst
        if (t >= lastBurst) e += 0.9 * v.tailAmp * (t === lastBurst ? 1 : 1);
        if (t >= lastBurst) v.tailAmp *= tailK;
        v.flt.step(nz.next());
        const x = v.flt.k * v.flt.bp * e * v.g * 1.4;
        l[i] += tanh3(x * drive) * norm * out;
        v.t = t + 1;
      }
      if (v.t > lastBurst + 8 && v.tailAmp < 3e-4) v.on = false;
    }
  }
  active(): boolean {
    return this.voices.some((v) => v.on);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hi-hat (metallic oscillators + noise)
// ─────────────────────────────────────────────────────────────────────────────

export const HAT_SPECS = {
  level: { default: 0, min: -30, max: 12, unit: 'dB', doc: 'Trim in dB on top of the preset\'s calibrated loudness (0 = as calibrated; the fader is the channel\'s `gain` in the mix).' },
  pitch: { default: 1, min: 0.5, max: 2, doc: 'Tunes the metallic cluster (1 = classic).' },
  decay: { default: 0.05, min: 0.01, max: 0.5, unit: 's', doc: 'Closed hat length.' },
  openDecay: { default: 0.38, min: 0.08, max: 1.6, unit: 's', doc: 'Open hat length (hits with the o flag).' },
  tone: { default: 7000, min: 2500, max: 12000, unit: 'Hz', curve: 'exp', doc: 'High-pass: lower = fuller, higher = thinner and brighter.' },
  bright: { default: 15000, min: 6000, max: 20000, unit: 'Hz', curve: 'exp', doc: 'Low-pass on top.' },
  noise: { default: 0.35, min: 0, max: 1, doc: 'Mix of white noise into the metallic sound (sizzle).' },
  velocity: { default: 0.7, min: 0, max: 1, doc: 'How much velocity changes level and brightness.' },
} satisfies ParamSpecs;

const HAT_RATIOS = [1, 1.4813, 1.8003, 2.5461, 2.6306, 3.8967]; // 205.3 Hz * these = the classic 808 set

interface HatVoice {
  on: boolean;
  open: boolean;
  t: number;
  ph: Float64Array;
  amp: number;
  g: number;
  hp: Svf;
  lp: number;
  choke: number;
  k: number;
}

export class Hat extends DrumBase<typeof HAT_SPECS> {
  private readonly voices: HatVoice[] = [];
  private readonly dtOsc = new Float64Array(6);
  constructor(ctx: Ctx, opts: Record<string, unknown> = {}) {
    super('Hat', HAT_SPECS, ctx, opts, 'hat');
    for (let i = 0; i < 4; i++) this.voices.push({ on: false, open: false, t: 0, ph: new Float64Array(6), amp: 0, g: 1, hp: new Svf(), lp: 0, choke: 1, k: 0 });
  }
  trigger(vel: number, _dur: number, flags: number): void {
    const p = this.params;
    const open = (flags & FLAG.OPEN) !== 0;
    // a closed hit chokes ringing open hats (and a new open hit chokes the previous one)
    for (const o of this.voices) if (o.on && (o.open || !open)) o.choke = Math.min(o.choke, 0.999);
    let v = this.voices.find((x) => !x.on);
    if (!v) {
      v = this.voices[0];
      for (const o of this.voices) if (o.t > v.t) v = o;
    }
    v.on = true;
    v.open = open;
    v.t = 0;
    for (let k = 0; k < 6; k++) v.ph[k] = (k * 0.37) % 1;
    v.amp = 1;
    v.g = velGain(vel, flags, p.velocity);
    v.hp.reset();
    v.hp.set(p.tone * (0.85 + 0.3 * v.g), 0.75, this.sr);
    v.lp = 0;
    v.choke = 1;
    v.k = t60Coef(open ? p.openDecay : p.decay, this.sr);
  }
  process(l: Float64Array, _r: Float64Array, n: number): void {
    const p = this.params;
    const sr = this.sr;
    const out = dbToLin(p.level + (5.5));
    const lpK = 1 - Math.exp((-TAU * p.bright) / sr);
    const base = 205.3 * p.pitch;
    const dt = this.dtOsc;
    for (let k = 0; k < 6; k++) dt[k] = (base * HAT_RATIOS[k] * 2.0) / sr;
    const nz = this.noise;
    const noiseMix = p.noise;
    for (const v of this.voices) {
      if (!v.on) continue;
      let { amp, lp, choke, t } = v;
      const k = v.k;
      const ph = v.ph;
      for (let i = 0; i < n; i++) {
        let m = 0;
        for (let j = 0; j < 6; j++) {
          let x = ph[j] + dt[j];
          if (x >= 1) x -= 1;
          ph[j] = x;
          m += pulseBL(x, dt[j], 0.5);
        }
        m *= 0.2;
        const mixed = m * (1 - noiseMix * 0.6) + nz.next() * noiseMix * 0.55;
        v.hp.step(mixed);
        lp += lpK * (v.hp.hp - lp);
        const att = t < 8 ? t / 8 : 1;
        let y = lp * amp * v.g * att * 1.5;
        if (choke < 1) {
          choke -= 1 / (0.004 * sr);
          if (choke <= 0) {
            v.on = false;
            break;
          }
          y *= choke;
        }
        l[i] += y * out;
        amp *= k;
        t++;
      }
      v.amp = amp;
      v.lp = lp;
      v.choke = choke;
      v.t = t;
      if (v.on && amp < 5e-4) v.on = false;
    }
  }
  active(): boolean {
    return this.voices.some((v) => v.on);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tom (pitched)
// ─────────────────────────────────────────────────────────────────────────────

export const TOM_SPECS = {
  level: { default: 0, min: -30, max: 12, unit: 'dB', doc: 'Trim in dB on top of the preset\'s calibrated loudness (0 = as calibrated; the fader is the channel\'s `gain` in the mix).' },
  pitch: { default: 110, min: 50, max: 400, unit: 'Hz', curve: 'exp', doc: 'Fundamental of the tom. A note given by the pattern transposes it (A2 = as set, one octave up = double).' },
  drop: { default: 0.5, min: 0, max: 2, unit: 'octaves', doc: 'How far above the pitch the tom starts (the dive).' },
  dropTime: { default: 0.06, min: 0.01, max: 0.3, unit: 's', doc: 'Time constant of the dive.' },
  decay: { default: 0.34, min: 0.05, max: 1.5, unit: 's', doc: 'Decay.' },
  click: { default: 0.4, min: 0, max: 1, doc: 'Stick attack.' },
  overtone: { default: 0.3, min: 0, max: 1, doc: 'Level of the inharmonic overtones (membrane modes).' },
  drive: { default: 3, min: 0, max: 24, unit: 'dB', doc: 'Saturation.' },
  velocity: { default: 0.7, min: 0, max: 1, doc: 'How much velocity changes the level.' },
} satisfies ParamSpecs;

interface TomVoice {
  on: boolean;
  t: number;
  ph: Float64Array;
  amp: number;
  g: number;
  pitch: number;
  clk: number;
  lp: number;
  choke: number;
}

export class Tom extends DrumBase<typeof TOM_SPECS> {
  private readonly voices: TomVoice[] = [];
  constructor(ctx: Ctx, opts: Record<string, unknown> = {}) {
    super('Tom', TOM_SPECS, ctx, opts, 'tom');
    for (let i = 0; i < 3; i++) this.voices.push({ on: false, t: 0, ph: new Float64Array(3), amp: 0, g: 1, pitch: 100, clk: 0, lp: 0, choke: 1 });
  }
  trigger(vel: number, _dur: number, flags: number, note: number): void {
    const p = this.params;
    let v = this.voices.find((x) => !x.on);
    if (!v) {
      v = this.voices[0];
      for (const o of this.voices) if (o.t > v.t) v = o;
    }
    v.on = true;
    v.t = 0;
    v.ph.fill(0);
    v.amp = 1;
    v.g = velGain(vel, flags, p.velocity);
    v.pitch = p.pitch * Math.pow(2, (note - 45) / 12); // A2 (45) plays the pitch as set
    v.clk = p.click * (0.5 + 0.5 * v.g);
    v.lp = 0;
    v.choke = 1;
  }
  process(l: Float64Array, _r: Float64Array, n: number): void {
    const p = this.params;
    const sr = this.sr;
    const out = dbToLin(p.level + (-5.5));
    const drive = dbToLin(p.drive);
    const norm = 0.9 / tanh3(drive);
    const aK = t60Coef(p.decay, sr);
    const dropK = Math.exp(-1 / (p.dropTime * sr));
    const clickK = Math.exp(-1 / (0.0015 * sr));
    const nz = this.noise;
    const ratios = [1, 1.593, 2.136];
    for (const v of this.voices) {
      if (!v.on) continue;
      let { amp, clk, lp, t } = v;
      let dev = v.pitch * (Math.pow(2, p.drop) - 1) * Math.exp(-v.t / (p.dropTime * sr));
      for (let i = 0; i < n; i++) {
        const f = v.pitch + dev;
        let body = 0;
        for (let m = 0; m < 3; m++) {
          v.ph[m] += (f * ratios[m]) / sr;
          if (v.ph[m] >= 1) v.ph[m] -= 1;
          body += sinCyc(v.ph[m]) * (m === 0 ? 1 : p.overtone * (m === 1 ? 0.45 : 0.25) * amp * amp);
        }
        const c = clk > 1e-3 ? nz.next() * clk * 0.7 : 0;
        clk *= clickK;
        const x = (body * amp + c) * v.g;
        const att = t < 16 ? t / 16 : 1;
        const y = tanh3(x * att * drive) * norm;
        lp += 0.5 * (y - lp);
        l[i] += lp * out;
        amp *= aK;
        dev *= dropK;
        t++;
      }
      v.amp = amp;
      v.clk = clk;
      v.lp = lp;
      v.t = t;
      if (amp < 4e-4) v.on = false;
    }
  }
  active(): boolean {
    return this.voices.some((v) => v.on);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cymbal (buffer playback)
// ─────────────────────────────────────────────────────────────────────────────

export const CYMBAL_SPECS = {
  level: { default: 0, min: -30, max: 12, unit: 'dB', doc: 'Trim in dB on top of the preset\'s calibrated loudness (0 = as calibrated; the fader is the channel\'s `gain` in the mix).' },
  decay: { default: 1, min: 0.2, max: 1, doc: 'Shortens the ring-out (1 = natural length, 0.3 = choked quickly).' },
  tone: { default: 0, min: -1, max: 1, doc: 'Brightness shift: negative = darker, positive = brighter.' },
  velocity: { default: 0.8, min: 0, max: 1, doc: 'How much velocity changes level and brightness.' },
} satisfies ParamSpecs;

const BUFFER_CACHE = new Map<string, CymbalBuffer>();
/** Renders (or fetches) a cymbal buffer. Cached per recipe name and sample rate: the output is deterministic. */
export function cymbalBuffer(recipe: string, sr: number): CymbalBuffer {
  const key = `${recipe}@${sr}`;
  let b = BUFFER_CACHE.get(key);
  if (!b) {
    const spec = CYMBAL_RECIPES[recipe];
    if (!spec) throw new Error(`unknown cymbal recipe "${recipe}". Known: ${Object.keys(CYMBAL_RECIPES).join(', ')}`);
    b = renderCymbal(sr, spec);
    BUFFER_CACHE.set(key, b);
  }
  return b;
}

interface CymVoice {
  on: boolean;
  pos: number;
  rate: number;
  g: number;
  lpL: number;
  lpR: number;
  lpK: number;
  choke: number;
  fade: number;
}

export class Cymbal extends ParamBase<typeof CYMBAL_SPECS> implements Instrument {
  readonly stereo = true;
  readonly parts: readonly string[];
  private readonly voices: CymVoice[] = [];
  private readonly buf: CymbalBuffer;
  private readonly sr: number;
  private readonly reverse: boolean;
  constructor(ctx: Ctx, opts: Record<string, unknown> = {}) {
    super('Cymbal', CYMBAL_SPECS, opts);
    this.sr = ctx.sr;
    const recipe = (opts.recipe as string) ?? 'crash';
    this.reverse = !!opts.reverse;
    this.buf = cymbalBuffer(recipe, ctx.sr);
    this.parts = [(opts.part as string) ?? 'cymbal'];
    for (let i = 0; i < 3; i++) this.voices.push({ on: false, pos: 0, rate: 1, g: 1, lpL: 0, lpR: 0, lpK: 1, choke: 1, fade: 1 });
  }
  noteOn(_note: number, vel: number, dur: number, flags: number): void {
    this.hit('', vel, dur, flags);
  }
  noteOff(): void {}
  hit(_part: string, vel: number, dur: number, flags: number): void {
    const p = this.params;
    // a new hit chokes the older ones quickly (a real cymbal is re-struck, not layered)
    for (const o of this.voices) if (o.on) o.choke = Math.min(o.choke, 0.999);
    let v = this.voices.find((x) => !x.on);
    if (!v) v = this.voices[0];
    const g = velGain(vel, flags, p.velocity);
    v.on = true;
    v.g = g;
    v.lpL = 0;
    v.lpR = 0;
    // softer hits are darker; `tone` shifts it
    const fc = 3500 * Math.pow(2, 2.6 * g + p.tone * 1.5);
    v.lpK = 1 - Math.exp((-TAU * Math.min(fc, this.sr * 0.45)) / this.sr);
    v.choke = 1;
    if (this.reverse) {
      // play the buffer backwards, stretched so that it ends exactly when the note ends
      v.rate = Math.max(0.25, Math.min(3, this.buf.l.length / Math.max(dur, 1)));
      v.pos = this.buf.l.length - 2;
    } else {
      v.rate = 1;
      v.pos = 0;
    }
    v.fade = 1;
    // a MUTE flag chokes the cymbal right away (hand on the cymbal)
    if (flags & FLAG.MUTE) v.fade = 0.9992;
  }
  process(l: Float64Array, r: Float64Array, n: number): void {
    const p = this.params;
    const out = dbToLin(p.level + (-2.5));
    const bl = this.buf.l;
    const br = this.buf.r;
    const len = bl.length;
    const decayMul = Math.pow(0.0005, (1 - p.decay) / (0.5 * this.sr)); // per-sample extra decay when decay < 1
    for (const v of this.voices) {
      if (!v.on) continue;
      let { pos, lpL, lpR, choke, fade } = v;
      const rate = v.rate;
      const rev = this.reverse;
      for (let i = 0; i < n; i++) {
        if (rev ? pos < 1 : pos >= len - 1) {
          v.on = false;
          break;
        }
        const i0 = pos | 0;
        const f = pos - i0;
        const a = bl[i0] + f * (bl[i0 + 1] - bl[i0]);
        const b = br[i0] + f * (br[i0 + 1] - br[i0]);
        lpL += v.lpK * (a - lpL);
        lpR += v.lpK * (b - lpR);
        let g = v.g * fade;
        if (choke < 1) {
          choke -= 1 / (0.012 * this.sr);
          if (choke <= 0) {
            v.on = false;
            break;
          }
          g *= choke;
        }
        l[i] += lpL * g * out;
        r[i] += lpR * g * out;
        pos += rev ? -rate : rate;
        fade *= decayMul;
      }
      v.pos = pos;
      v.lpL = lpL;
      v.lpR = lpR;
      v.choke = choke;
      v.fade = fade;
      if (v.fade < 1e-3) v.on = false;
    }
  }
  active(): boolean {
    return this.voices.some((v) => v.on);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Percussion
// ─────────────────────────────────────────────────────────────────────────────

export const PERC_SPECS = {
  level: { default: 0, min: -30, max: 12, unit: 'dB', doc: 'Trim in dB on top of the preset\'s calibrated loudness (0 = as calibrated; the fader is the channel\'s `gain` in the mix).' },
  tune: { default: 1, min: 0.4, max: 2.5, doc: 'Pitch multiplier of the percussion sound.' },
  decay: { default: 1, min: 0.2, max: 4, doc: 'Length multiplier of the sound.' },
  tone: { default: 1, min: 0.4, max: 2.5, doc: 'Brightness multiplier of the filtering.' },
  velocity: { default: 0.7, min: 0, max: 1, doc: 'How much velocity changes the level.' },
} satisfies ParamSpecs;

export type PercKind = 'rim' | 'clave' | 'cowbell' | 'shaker' | 'tambourine' | 'conga' | 'conga-hi' | 'block' | 'snap';

interface PercVoice {
  on: boolean;
  t: number;
  amp: number;
  g: number;
  ph: Float64Array;
  flt: Svf;
  flt2: Svf;
  note: number;
}

export class Perc extends DrumBase<typeof PERC_SPECS> {
  private readonly voices: PercVoice[] = [];
  private readonly kind: PercKind;
  constructor(ctx: Ctx, opts: Record<string, unknown> = {}) {
    super('Perc', PERC_SPECS, ctx, opts, 'perc');
    this.kind = ((opts.kind as PercKind) ?? 'rim') as PercKind;
    for (let i = 0; i < 4; i++) this.voices.push({ on: false, t: 0, amp: 0, g: 1, ph: new Float64Array(3), flt: new Svf(), flt2: new Svf(), note: 60 });
  }
  trigger(vel: number, _dur: number, flags: number, note: number): void {
    const p = this.params;
    let v = this.voices.find((x) => !x.on);
    if (!v) {
      v = this.voices[0];
      for (const o of this.voices) if (o.t > v.t) v = o;
    }
    v.on = true;
    v.t = 0;
    v.amp = 1;
    v.g = velGain(vel, flags, p.velocity);
    v.ph.fill(0);
    v.flt.reset();
    v.flt2.reset();
    v.note = note;
    const sr = this.sr;
    switch (this.kind) {
      case 'shaker':
        v.flt.set(7500 * p.tone, 1.1, sr);
        break;
      case 'tambourine':
        v.flt.set(6500 * p.tone, 0.9, sr);
        v.flt2.set(9500 * p.tone, 1.2, sr);
        break;
      case 'cowbell':
        v.flt.set(800 * p.tune * 1.3 * p.tone, 2.2, sr);
        break;
      case 'snap':
        v.flt.set(2600 * p.tone, 2.2, sr);
        break;
      default:
        break;
    }
  }
  process(l: Float64Array, _r: Float64Array, n: number): void {
    const p = this.params;
    const sr = this.sr;
    const out = dbToLin(p.level + (-3));
    const nz = this.noise;
    const kind = this.kind;
    for (const v of this.voices) {
      if (!v.on) continue;
      for (let i = 0; i < n; i++) {
        const t = v.t / sr;
        let y = 0;
        let k: number; // amplitude multiplier per sample
        switch (kind) {
          case 'rim': {
            const f = 1750 * p.tune;
            v.ph[0] += f / sr;
            v.ph[1] += (f * 2.7) / sr;
            y = (sinCyc(v.ph[0] % 1) * 0.7 + sinCyc(v.ph[1] % 1) * 0.35) * v.amp + nz.next() * 0.25 * Math.exp(-t / 0.002);
            k = Math.exp(-1 / (0.011 * p.decay * sr));
            break;
          }
          case 'clave': {
            const f = 2500 * p.tune;
            v.ph[0] += f / sr;
            y = sinCyc(v.ph[0] % 1) * v.amp;
            k = Math.exp(-1 / (0.02 * p.decay * sr));
            break;
          }
          case 'block': {
            const f = 880 * p.tune;
            v.ph[0] += f / sr;
            v.ph[1] += (f * 1.58) / sr;
            y = (sinCyc(v.ph[0] % 1) + 0.4 * sinCyc(v.ph[1] % 1)) * v.amp * 0.8;
            k = Math.exp(-1 / (0.035 * p.decay * sr));
            break;
          }
          case 'cowbell': {
            v.ph[0] += (540 * p.tune) / sr;
            v.ph[1] += (800 * p.tune) / sr;
            if (v.ph[0] >= 1) v.ph[0] -= 1;
            if (v.ph[1] >= 1) v.ph[1] -= 1;
            const sq = (v.ph[0] < 0.5 ? 1 : -1) + (v.ph[1] < 0.5 ? 1 : -1);
            v.flt.step(sq * 0.5);
            y = v.flt.k * v.flt.bp * v.amp * (t < 0.003 ? 1 : 0.55 + 0.45 * Math.exp(-t / 0.02)) * 1.6;
            k = Math.exp(-1 / (0.075 * p.decay * sr));
            break;
          }
          case 'conga':
          case 'conga-hi': {
            const base = (kind === 'conga' ? 190 : 330) * p.tune * Math.pow(2, (v.note - 60) / 12);
            const f = base * (1 + 0.28 * Math.exp(-t / 0.018));
            v.ph[0] += f / sr;
            v.ph[1] += (f * 1.9) / sr;
            y = (sinCyc(v.ph[0] % 1) + 0.18 * sinCyc(v.ph[1] % 1) * Math.exp(-t / 0.03)) * v.amp + nz.next() * 0.15 * Math.exp(-t / 0.003);
            k = Math.exp(-1 / (0.09 * p.decay * sr));
            break;
          }
          case 'shaker': {
            v.flt.step(nz.next());
            const env = Math.min(1, v.t / (0.006 * sr)) * v.amp;
            y = v.flt.hp * env * 0.9;
            k = Math.exp(-1 / (0.045 * p.decay * sr));
            break;
          }
          case 'tambourine': {
            v.flt.step(nz.next());
            v.flt2.step(nz.next());
            const jingle = Math.sin(v.t * 0.9) * 0.2 + 0.8;
            y = (v.flt.hp * 0.5 + v.flt2.hp * 0.7 * jingle) * v.amp * Math.min(1, v.t / (0.002 * sr)) * 0.9;
            k = Math.exp(-1 / (0.14 * p.decay * sr));
            break;
          }
          default: {
            // finger snap
            v.flt.step(nz.next());
            y = v.flt.k * v.flt.bp * v.amp * 2.2;
            k = Math.exp(-1 / (0.025 * p.decay * sr));
            break;
          }
        }
        l[i] += tanh3(y * v.g * 1.2) * 0.8 * out;
        v.amp *= k;
        v.t++;
      }
      if (v.amp < 4e-4) v.on = false;
    }
  }
  active(): boolean {
    return this.voices.some((v) => v.on);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// presets
// ─────────────────────────────────────────────────────────────────────────────

export type DrumType = 'kick' | 'snare' | 'clap' | 'hat' | 'tom' | 'cymbal' | 'perc';

export interface DrumPreset extends PresetDef {
  type: DrumType;
}

/** Every electronic drum preset. `opts` are parameter values (and, for cymbals / percussion, the `recipe` / `kind` choice). */
export const DRUM_PRESETS: Record<string, DrumPreset> = {
  // kicks
  'darksynth-kick': { type: 'kick', doc: 'Big, punchy 80s-style synthwave kick with a bright click and a long weighty tail. 90-130 BPM.', opts: { level: 0, pitch: 50, sweep: 2.4, sweepTime: 0.04, punch: 0.5, decay: 0.42, click: 0.5, clickTone: 3500, drive: 14, tone: 8000, tail: 0.25 } },
  'techno-kick': { type: 'kick', doc: 'Hard, saturated four-on-the-floor kick with a medium tail. 120-140 BPM.', opts: { level: -2, pitch: 54, sweep: 2.0, sweepTime: 0.03, punch: 0.3, decay: 0.5, click: 0.3, clickTone: 2800, drive: 20, tone: 7000, tail: 0.1 } },
  'psy-kick': { type: 'kick', doc: 'Goa / psytrance kick: very fast pitch zap, tight tail so the off-beat bass fits, strong click. 138-150 BPM.', opts: { level: -0.5, pitch: 47, sweep: 3.2, sweepTime: 0.02, punch: 0.75, decay: 0.21, click: 0.65, clickTone: 4500, drive: 22, tone: 9500, tail: 0.04 } },
  'punchy-kick': { type: 'kick', doc: 'Tight modern kick for dubstep / EDM: short, round, clean low end.', opts: { level: 3, pitch: 55, sweep: 2.1, sweepTime: 0.03, punch: 0.45, decay: 0.3, click: 0.35, clickTone: 3000, drive: 8, tone: 6500, tail: 0.12 } },
  'hard-kick': { type: 'kick', doc: 'Extremely distorted gabber-style kick.', opts: { level: -4, pitch: 60, sweep: 2.6, sweepTime: 0.03, punch: 0.8, decay: 0.45, click: 0.5, clickTone: 2600, drive: 32, tone: 6000, tail: 0.0 } },
  '808-kick': { type: 'kick', doc: 'Long sine boom with a soft click: half-time drops and sub-heavy bass music.', opts: { level: 1.5, pitch: 46, sweep: 1.0, sweepTime: 0.06, punch: 0.2, decay: 0.95, hold: 0.05, click: 0.1, clickTone: 1800, drive: 3, tone: 3000, tail: 0.4 } },
  'club-kick': { type: 'kick', doc: 'Clean, deep house-style kick.', opts: { level: 4.5, pitch: 52, sweep: 1.8, sweepTime: 0.035, punch: 0.35, decay: 0.34, click: 0.25, clickTone: 2600, drive: 5, tone: 6000, tail: 0.1 } },
  // snares
  'darksynth-snare': { type: 'snare', doc: 'Big 80s snare: fat body, long noise decay (pair it with fx.reverb({ gated: true }) for the full gated-reverb sound).', opts: { level: -0.5, tune: 185, body: 0.75, bodyDecay: 0.13, noise: 0.9, noiseDecay: 0.28, noiseTone: 3800, snap: 0.7, tail: 0.25, drive: 9 } },
  'tight-snare': { type: 'snare', doc: 'Short, punchy snare for fast music.', opts: { level: 4.5, tune: 200, body: 0.6, bodyDecay: 0.08, noise: 0.85, noiseDecay: 0.13, noiseTone: 4800, snap: 0.5, tail: 0, drive: 6 } },
  'trap-snare': { type: 'snare', doc: 'Crisp, high snare for half-time dubstep drops.', opts: { level: 0, tune: 230, body: 0.55, bodyDecay: 0.09, noise: 1.0, noiseDecay: 0.2, noiseTone: 5500, snap: 0.9, tail: 0.1, drive: 8 } },
  'heavy-snare': { type: 'snare', doc: 'Low, heavy snare with a lot of body.', opts: { level: -2, tune: 150, body: 1.0, bodyDecay: 0.18, noise: 0.8, noiseDecay: 0.25, noiseTone: 3300, snap: 0.6, tail: 0.3, drive: 12 } },
  // claps
  clap: { type: 'clap', doc: 'Classic synth clap.', opts: { level: 1.5, tone: 1500, decay: 0.16, bursts: 4, spread: 9, drive: 4 } },
  'big-clap': { type: 'clap', doc: 'Wide, long clap: layer under a snare.', opts: { level: -1.5, tone: 1300, q: 0.9, decay: 0.28, bursts: 5, spread: 11, drive: 6 } },
  'tight-clap': { type: 'clap', doc: 'Short clap for fast tempos.', opts: { level: 1.5, tone: 1800, decay: 0.09, bursts: 3, spread: 7, drive: 4 } },
  // hats
  'closed-hat': { type: 'hat', doc: 'Crisp closed hi-hat (use the o flag in a pattern for the open one).', opts: { level: -0.5, decay: 0.05, openDecay: 0.38, tone: 7000, noise: 0.35 } },
  'tight-hat': { type: 'hat', doc: 'Very short, bright hat for 16th-note patterns.', opts: { level: 3, decay: 0.03, openDecay: 0.25, tone: 8000, noise: 0.3, bright: 17000 } },
  'dark-hat': { type: 'hat', doc: 'Fuller, darker hat for synthwave.', opts: { level: -2.5, decay: 0.06, openDecay: 0.45, tone: 5500, noise: 0.45, bright: 12000, pitch: 0.85 } },
  // toms
  'synth-tom': { type: 'tom', doc: 'Electronic tom with a long dive (pitched: play notes).', opts: { level: -0.5, pitch: 110, drop: 0.9, dropTime: 0.08, decay: 0.4, click: 0.3, overtone: 0.15, drive: 4 } },
  'tom-low': { type: 'tom', doc: 'Low tom.', opts: { level: -0.5, pitch: 85, drop: 0.5, decay: 0.45, click: 0.4, overtone: 0.3 } },
  'tom-mid': { type: 'tom', doc: 'Mid tom.', opts: { level: 0, pitch: 125, drop: 0.5, decay: 0.38, click: 0.4, overtone: 0.3 } },
  'tom-high': { type: 'tom', doc: 'High tom.', opts: { level: 1, pitch: 180, drop: 0.45, decay: 0.3, click: 0.45, overtone: 0.3 } },
  // cymbals
  crash: { type: 'cymbal', doc: 'Crash cymbal (about 2.8 s).', opts: { level: 1.5, recipe: 'crash' } },
  'crash-dark': { type: 'cymbal', doc: 'Darker crash.', opts: { level: -0.5, recipe: 'crash-dark' } },
  splash: { type: 'cymbal', doc: 'Short splash.', opts: { level: 0.5, recipe: 'splash' } },
  china: { type: 'cymbal', doc: 'Trashy china.', opts: { level: 0, recipe: 'china' } },
  ride: { type: 'cymbal', doc: 'Ride with a clear ping.', opts: { level: 0.5, recipe: 'ride' } },
  'ride-bell': { type: 'cymbal', doc: 'Ride bell.', opts: { level: -1.5, recipe: 'ride-bell' } },
  'reverse-crash': { type: 'cymbal', doc: 'Reversed crash that swells up and ends exactly when the note ends: place a note of the length you want (e.g. 4 beats) so that it finishes on the downbeat.', opts: { level: 5, recipe: 'crash', reverse: true } },
  // percussion
  rim: { type: 'perc', doc: 'Rim shot.', opts: { level: 4.5, kind: 'rim' } },
  clave: { type: 'perc', doc: 'Clave.', opts: { level: -1, kind: 'clave' } },
  cowbell: { type: 'perc', doc: '808 cowbell.', opts: { level: 1.5, kind: 'cowbell' } },
  shaker: { type: 'perc', doc: 'Shaker.', opts: { level: -1, kind: 'shaker' } },
  tambourine: { type: 'perc', doc: 'Tambourine.', opts: { level: -3, kind: 'tambourine' } },
  conga: { type: 'perc', doc: 'Low conga (pitched: play notes around C4).', opts: { level: -2.5, kind: 'conga' } },
  'conga-hi': { type: 'perc', doc: 'High conga.', opts: { level: -2.5, kind: 'conga-hi' } },
  block: { type: 'perc', doc: 'Wood block.', opts: { level: 1, kind: 'block' } },
  snap: { type: 'perc', doc: 'Finger snap.', opts: { level: 4.5, kind: 'snap' } },
};

type Maker = (ctx: Ctx, opts: Record<string, unknown>) => Instrument;
const MAKERS: Record<DrumType, Maker> = {
  kick: (c, o) => new Kick(c, o),
  snare: (c, o) => new Snare(c, o),
  clap: (c, o) => new Clap(c, o),
  hat: (c, o) => new Hat(c, o),
  tom: (c, o) => new Tom(c, o),
  cymbal: (c, o) => new Cymbal(c, o),
  perc: (c, o) => new Perc(c, o),
};
const SPECS_OF: Record<DrumType, ParamSpecs> = { kick: KICK_SPECS, snare: SNARE_SPECS, clap: CLAP_SPECS, hat: HAT_SPECS, tom: TOM_SPECS, cymbal: CYMBAL_SPECS, perc: PERC_SPECS };
const STRUCT_OF: Record<DrumType, readonly string[]> = { kick: [], snare: [], clap: [], hat: [], tom: [], cymbal: ['recipe', 'reverse', 'part'], perc: ['kind'] };

export interface DrumOpts {
  preset?: string;
  [param: string]: unknown;
}

/** Builds one electronic drum of the given type from a preset name or an options object (`{ preset, ...overrides }`). */
export function makeDrum(type: DrumType, ctx: Ctx, input: DrumOpts | string | undefined): Instrument {
  const pool: Record<string, PresetDef> = {};
  for (const [k, v] of Object.entries(DRUM_PRESETS)) if (v.type === type) pool[k] = v;
  const names = Object.keys(pool);
  const defaults: Record<string, PresetDef> = { default: { doc: 'defaults', opts: {} }, ...pool };
  const o = resolveOpts(`${type} drum`, defaults, input === undefined ? 'default' : input, SPECS_OF[type], STRUCT_OF[type]);
  void names;
  return MAKERS[type](ctx, o);
}

// ─────────────────────────────────────────────────────────────────────────────
// DrumKit: several drums on one channel
// ─────────────────────────────────────────────────────────────────────────────

export interface KitPartSpec extends DrumOpts {
  /** Part level in dB inside the kit. */
  gain?: number;
  /** Pan -1..1 inside the kit. */
  pan?: number;
  /** Which kind of drum this part is, when the preset name does not say (e.g. a custom kick). */
  type?: DrumType;
  /** Choke group: parts of the same group cut each other off (hats). */
  choke?: string;
}

/**
 * Several electronic drums behind one channel. Part names are yours ('kick', 'snare', 'hatC', ...); each is built from a preset
 * name or `{ preset, ...overrides, gain, pan }`. Parameters are addressed as `part.param` (e.g. `kick.decay`, `snare.gain`).
 */
export class DrumKit implements Instrument {
  readonly stereo = true;
  readonly parts: readonly string[];
  readonly specs: ParamSpecs = {};
  readonly params: Record<string, number> = {};
  private readonly members: { name: string; type: DrumType; inst: Instrument; gl: number; gr: number; gainDb: number; pan: number; l: Float64Array; r: Float64Array }[] = [];
  /** A kit with a kick part keys the sidechain by default (on the kick hits only: see `keyed`). */
  readonly keysByDefault: boolean;
  private readonly byName = new Map<string, number>();
  constructor(ctx: Ctx, spec: Record<string, string | KitPartSpec>) {
    this.parts = Object.keys(spec);
    for (const [name, raw] of Object.entries(spec)) {
      const s: KitPartSpec = typeof raw === 'string' ? { preset: raw } : { ...raw };
      const presetName = s.preset;
      const preset = presetName ? DRUM_PRESETS[presetName] : undefined;
      if (presetName && !preset) throw new Error(`drum kit part "${name}": unknown preset "${presetName}". Presets: ${Object.keys(DRUM_PRESETS).join(', ')}`);
      const type = s.type ?? preset?.type;
      if (!type) throw new Error(`drum kit part "${name}": give a preset name or a type (kick, snare, clap, hat, tom, cymbal, perc)`);
      const { gain, pan, type: _t, choke: _c, ...rest } = s;
      void _t;
      void _c;
      const inst = makeDrum(type, { ...ctx, seed: ctx.seed + this.members.length * 101 }, rest as DrumOpts);
      const m = { name, type, inst, gl: 1, gr: 1, gainDb: gain ?? 0, pan: pan ?? 0, l: new Float64Array(BLOCK), r: new Float64Array(BLOCK) };
      this.byName.set(name, this.members.length);
      this.members.push(m);
      for (const [pn, sp] of Object.entries(inst.specs)) {
        this.specs[`${name}.${pn}`] = sp;
        this.params[`${name}.${pn}`] = inst.params[pn];
      }
      this.specs[`${name}.gain`] = { default: 0, min: -60, max: 12, unit: 'dB', doc: 'Part level inside the kit.' };
      this.specs[`${name}.pan`] = { default: 0, min: -1, max: 1, doc: 'Part pan inside the kit.' };
      this.params[`${name}.gain`] = m.gainDb;
      this.params[`${name}.pan`] = m.pan;
    }
    this.keysByDefault = this.members.some((m) => m.type === 'kick');
  }
  /** Only the kick parts trigger the sidechain on a keyed kit channel (not the snare and the hats). */
  keyed(part: string): boolean {
    const i = part === '' ? 0 : this.byName.get(part);
    return i !== undefined && this.members[i].type === 'kick';
  }
  setParam(name: string, value: number): void {
    const sp = this.specs[name];
    if (!sp) throw new Error(`DrumKit: unknown parameter "${name}". Valid: ${Object.keys(this.specs).join(', ')}`);
    const v = Math.min(sp.max, Math.max(sp.min, value));
    this.params[name] = v;
    const dot = name.indexOf('.');
    const part = name.slice(0, dot);
    const pn = name.slice(dot + 1);
    const m = this.members[this.byName.get(part) as number];
    if (pn === 'gain') m.gainDb = v;
    else if (pn === 'pan') m.pan = v;
    else m.inst.setParam(pn, v);
  }
  noteOn(note: number, vel: number, dur: number, flags: number): void {
    // a note pattern on a kit plays the first part
    this.members[0].inst.noteOn(note, vel, dur, flags);
  }
  noteOff(): void {}
  hit(part: string, vel: number, dur: number, flags: number): void {
    const i = part === '' ? 0 : this.byName.get(part);
    if (i === undefined) throw new Error(`DrumKit: no part "${part}". Parts: ${this.parts.join(', ')}`);
    this.members[i].inst.hit(part, vel, dur, flags);
  }
  process(l: Float64Array, r: Float64Array, n: number): void {
    for (const m of this.members) {
      if (!m.inst.active()) continue;
      m.l.fill(0, 0, n);
      m.r.fill(0, 0, n);
      m.inst.process(m.l, m.r, n);
      const g = dbToLin(m.gainDb);
      const a = (m.pan + 1) * 0.25 * Math.PI;
      if (m.inst.stereo) {
        const gl = g * (m.pan > 0 ? 1 - m.pan : 1);
        const gr = g * (m.pan < 0 ? 1 + m.pan : 1);
        for (let i = 0; i < n; i++) {
          l[i] += m.l[i] * gl;
          r[i] += m.r[i] * gr;
        }
      } else {
        const gl = g * Math.cos(a) * Math.SQRT2;
        const gr = g * Math.sin(a) * Math.SQRT2;
        for (let i = 0; i < n; i++) {
          l[i] += m.l[i] * gl;
          r[i] += m.l[i] * gr;
        }
      }
    }
  }
  active(): boolean {
    return this.members.some((m) => m.inst.active());
  }
}
