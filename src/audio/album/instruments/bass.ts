/**
 * Bass instruments: SubBass (clean sine/triangle low end), DarkBass (distorted darksynth saw/square bass), ReeseBass (detuned
 * saws with phase movement), GrowlBass (dubstep: FM + wavefolder + formant filters + tempo-synced wobble) and AcidBass (the
 * 303: saw/square into a resonant ladder with envelope, accent and slide).
 *
 * All are monophonic with last-note priority; a note with the slide flag (~) glides into the next without retriggering.
 * The distorting ones run their non-linear stages at twice the sample rate to keep the highs clean.
 */
import { Noise, Rng, TAU, clamp, dbToLin, fold, mtof, sinCyc, tanh3 } from '../dsp/core';
import { Adsr, ENV_IDLE } from '../dsp/env';
import { Downsampler2x, Upsampler2x } from '../dsp/delay';
import { Ladder, Svf } from '../dsp/filters';
import { SideDecorrelator } from '../dsp/side';
import { polyBlep } from '../dsp/osc';
import { BLOCK, Ctx, FLAG, Instrument, LFO_SHAPES, ParamBase, ParamSpecs, PresetDef, pickWord, resolveOpts } from '../instrument';
import { MonoTracker } from './mono';

/** Shared base: mono, no parts, hit = a short note. */
abstract class BassBase<S extends ParamSpecs> extends ParamBase<S> implements Instrument {
  readonly stereo: boolean = false;
  /** A `~` note glides from the note right before it (no rest between); anywhere else the mark does nothing. */
  readonly slides = 'tie' as const;
  protected readonly sr: number;
  protected readonly ctx: Ctx;
  protected readonly mono: MonoTracker;
  protected readonly aenv = new Adsr();
  protected readonly fenv = new Adsr();
  protected readonly rng: Rng;
  protected readonly noise: Noise;
  protected readonly src = new Float64Array(BLOCK);
  protected readonly srcR = new Float64Array(BLOCK);
  protected readonly buf2 = new Float64Array(128);
  protected readonly buf2R = new Float64Array(128);
  protected readonly outBuf = new Float64Array(BLOCK);
  protected readonly outBufR = new Float64Array(BLOCK);
  protected readonly ae = new Float64Array(BLOCK);
  protected readonly fe = new Float64Array(BLOCK);
  private readonly pending: { at: number; note: number }[] = [];
  protected tick = 0;
  constructor(label: string, specs: S, ctx: Ctx, opts: Record<string, unknown>) {
    super(label, specs, opts);
    this.ctx = ctx;
    this.sr = ctx.sr;
    this.mono = new MonoTracker(ctx.sr);
    this.rng = new Rng(ctx.seed);
    this.noise = new Noise(ctx.seed ^ 0x2545f491);
  }
  /** Called when a note (re)starts the envelopes. */
  protected abstract trigger(note: number, vel: number, flags: number): void;
  /** Called when the note ends. */
  protected release(): void {
    this.aenv.gateOff();
    this.fenv.gateOff();
  }
  protected abstract glideTime(): number;
  protected slideTime(): number {
    return 0.06;
  }
  noteOn(note: number, vel: number, _dur: number, flags: number): void {
    const retrigger = this.mono.noteOn(note, vel, flags, this.glideTime(), this.slideTime());
    if (retrigger) this.trigger(note, vel, flags);
    else this.slideTrigger(note, vel, flags);
  }
  /** A legato (slide) note: envelopes keep running; subclasses may adjust. */
  protected slideTrigger(_note: number, vel: number, _flags: number): void {
    this.mono.vel = vel;
  }
  noteOff(note: number): void {
    const r = this.mono.noteOff(note);
    if (r === 'release') this.release();
  }
  hit(_part: string, vel: number, dur: number, flags: number): void {
    this.noteOn(36, vel, dur, flags);
    this.pending.push({ at: this.tick + Math.max(1, dur), note: 36 });
  }
  protected serviceHits(n: number): void {
    this.tick += n;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].at <= this.tick) {
        this.noteOff(this.pending[i].note);
        this.pending.splice(i, 1);
      }
    }
  }
  active(): boolean {
    return this.mono.active;
  }
  abstract process(l: Float64Array, r: Float64Array, n: number): void;
}

/** Runs the amp envelope for n samples into `ae`, returns the index where it ended (or -1). */
function runEnv(env: Adsr, out: Float64Array, n: number): number {
  let idle = -1;
  for (let i = 0; i < n; i++) {
    out[i] = env.next();
    if (idle < 0 && env.stage === ENV_IDLE) {
      idle = i;
      out[i] = 0;
    }
  }
  return idle;
}

// ─────────────────────────────────────────────────────────────────────────────
// SubBass
// ─────────────────────────────────────────────────────────────────────────────

export const SUB_SPECS = {
  level: { default: 0, min: -40, max: 12, unit: 'dB', doc: 'Trim in dB on top of the preset\'s calibrated loudness (0 = as calibrated; the fader is the channel\'s `gain` in the mix).' },
  shape: { default: 0, min: 0, max: 1, doc: '0 = pure sine, 1 = triangle (a little more body).' },
  harmonics: { default: 0.25, min: 0, max: 1, doc: 'Saturation that adds 2nd/3rd harmonics so the bass is audible on small speakers.' },
  tone: { default: 900, min: 80, max: 4000, unit: 'Hz', curve: 'exp', doc: 'Low-pass on top of the harmonics.' },
  attack: { default: 0.004, min: 0.0005, max: 1, unit: 's', doc: 'Attack time.' },
  decay: { default: 5, min: 0.05, max: 8, unit: 's', doc: 'Decay time towards the sustain level.' },
  sustain: { default: 1, min: 0, max: 1, doc: 'Sustain level (0 with a short decay gives a 808-style boom).' },
  release: { default: 0.1, min: 0.005, max: 3, unit: 's', doc: 'Release time.' },
  glide: { default: 0, min: 0, max: 1, unit: 's', doc: 'Portamento between successive notes.' },
  pEnv: { default: 0, min: -24, max: 24, unit: 'semitones', doc: 'Pitch drop at the start of every note (808 boom: 12).' },
  pEnvTime: { default: 0.05, min: 0.005, max: 0.5, unit: 's', doc: 'Time constant of the pitch drop.' },
  velocity: { default: 0.4, min: 0, max: 1, doc: 'How much velocity changes the level.' },
} satisfies ParamSpecs;

export class SubBass extends BassBase<typeof SUB_SPECS> {
  private ph = 0;
  private lp = 0;
  constructor(ctx: Ctx, input?: Record<string, unknown> | string) {
    const o = resolveOpts('sub bass', SUB_PRESETS, input ?? 'sub-sine', SUB_SPECS, []);
    super('SubBass', SUB_SPECS, ctx, o);
  }
  protected glideTime(): number {
    return this.params.glide;
  }
  protected trigger(): void {
    const p = this.params;
    this.aenv.set(p.attack, p.decay, p.sustain, p.release, this.sr);
    this.aenv.gateOn();
    if (!this.aenv.active) this.aenv.value = 0;
  }
  process(l: Float64Array, _r: Float64Array, n: number): void {
    this.serviceHits(n);
    if (!this.mono.active) return;
    const p = this.params;
    const sr = this.sr;
    this.mono.advance(n);
    let semis = this.mono.slideNote;
    if (p.pEnv !== 0) semis += p.pEnv * Math.exp(-(this.mono.age / sr) / p.pEnvTime);
    const dt = mtof(semis) / sr;
    const idle = runEnv(this.aenv, this.ae, n);
    const shape = p.shape;
    const h = 1 + 4 * p.harmonics;
    const norm = 1 / tanh3(h);
    const toneK = 1 - Math.exp((-TAU * p.tone) / sr);
    const velG = 1 - p.velocity + p.velocity * Math.pow(this.mono.vel, 1.3);
    const g = dbToLin(p.level + (-10)) * velG * 0.8;
    let ph = this.ph;
    let lp = this.lp;
    const end = idle >= 0 ? idle : n;
    for (let i = 0; i < n; i++) {
      ph += dt;
      if (ph >= 1) ph -= 1;
      const s = sinCyc(ph);
      const tri = ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
      let y = s + shape * (tri - s);
      y = tanh3(y * h) * norm;
      lp += toneK * (y - lp);
      if (i < end) l[i] += lp * this.ae[i] * g;
    }
    this.ph = ph;
    this.lp = lp;
    if (idle >= 0) this.mono.active = false;
  }
}

export const SUB_PRESETS: Record<string, PresetDef> = {
  'sub-sine': { doc: 'Pure, clean sine sub with a touch of harmonics. The default low end.', opts: { level: -0.5, shape: 0, harmonics: 0.2 } },
  'sub-saturated': { doc: 'Sub with strong harmonics: stays audible on laptop speakers and phones.', opts: { level: -1.5, shape: 0.3, harmonics: 0.7, tone: 1500 } },
  'sub-tri': { doc: 'Triangle sub: a rounder, fuller low end.', opts: { level: 1, shape: 1, harmonics: 0.15 } },
  '808-sub': { doc: '808-style boom: pitch drop at the start and a long decay (set a note length of 1-2 beats).', opts: { level: 5.5, shape: 0, harmonics: 0.35, pEnv: 10, pEnvTime: 0.05, decay: 1.2, sustain: 0.0, release: 0.3, attack: 0.002 } },
};

// ─────────────────────────────────────────────────────────────────────────────
// DarkBass (darksynth)
// ─────────────────────────────────────────────────────────────────────────────

export const DARK_SPECS = {
  level: { default: 0, min: -40, max: 12, unit: 'dB', doc: 'Trim in dB on top of the preset\'s calibrated loudness (0 = as calibrated; the fader is the channel\'s `gain` in the mix).' },
  cutoff: { default: 700, min: 40, max: 9000, unit: 'Hz', curve: 'exp', doc: 'Filter cutoff before the envelope opens it.' },
  res: { default: 0.25, min: 0, max: 1, doc: 'Filter resonance.' },
  envAmt: { default: 3.2, min: -4, max: 6, unit: 'octaves', doc: 'How far the filter envelope opens the cutoff on every note (the "pluck" of a rolling bass).' },
  envDecay: { default: 0.22, min: 0.02, max: 3, unit: 's', doc: 'How fast the filter closes again.' },
  envSustain: { default: 0.15, min: 0, max: 1, doc: 'Filter envelope sustain level.' },
  drive: { default: 16, min: 0, max: 42, unit: 'dB', doc: 'Saturation before the filter: the growl.' },
  clip: { default: 8, min: 0, max: 36, unit: 'dB', doc: 'Saturation after the filter: weight and aggression.' },
  bias: { default: 0.12, min: -0.6, max: 0.6, doc: 'Asymmetry of the saturation (even harmonics, a thicker sound).' },
  detune: { default: 9, min: 0, max: 40, unit: 'cents', doc: 'Detune between the two saws.' },
  saw: { default: 1, min: 0, max: 1, doc: 'Level of the saw pair.' },
  square: { default: 0.5, min: 0, max: 1, doc: 'Level of the square wave (a hollow body under the saws).' },
  pw: { default: 0.5, min: 0.05, max: 0.95, doc: 'Pulse width of the square.' },
  sub: { default: 0.5, min: 0, max: 1, doc: 'Level of a clean sine sub (not distorted).' },
  keytrack: { default: 0.3, min: 0, max: 1, doc: 'How much the cutoff follows the pitch.' },
  glide: { default: 0, min: 0, max: 1, unit: 's', doc: 'Portamento between successive notes (slide-flagged notes always glide).' },
  attack: { default: 0.002, min: 0.0005, max: 1, unit: 's', doc: 'Amplitude attack.' },
  decay: { default: 0.6, min: 0.02, max: 6, unit: 's', doc: 'Amplitude decay to the sustain level.' },
  sustain: { default: 1, min: 0, max: 1, doc: 'Amplitude sustain level.' },
  release: { default: 0.06, min: 0.005, max: 2, unit: 's', doc: 'Amplitude release.' },
  tone: { default: 7500, min: 500, max: 18000, unit: 'Hz', curve: 'exp', doc: 'Low-pass at the end of the chain.' },
  velocity: { default: 0.5, min: 0, max: 1, doc: 'How much velocity changes the level.' },
  velFilter: { default: 0.6, min: 0, max: 3, unit: 'octaves', doc: 'Extra filter opening at full velocity.' },
} satisfies ParamSpecs;

export class DarkBass extends BassBase<typeof DARK_SPECS> {
  private readonly up = new Upsampler2x();
  private readonly down = new Downsampler2x();
  private readonly lad = new Ladder();
  private ph = [0, 0, 0];
  private subPh = 0;
  private lp = 0;
  private hpX = 0;
  private hpY = 0;
  constructor(ctx: Ctx, input?: Record<string, unknown> | string) {
    const o = resolveOpts('dark bass', DARK_PRESETS, input ?? 'darksynth-bass', DARK_SPECS, []);
    super('DarkBass', DARK_SPECS, ctx, o);
  }
  protected glideTime(): number {
    return this.params.glide;
  }
  protected trigger(_note: number, vel: number): void {
    const p = this.params;
    this.aenv.set(p.attack, p.decay, p.sustain, p.release, this.sr);
    this.fenv.set(0.001, p.envDecay, p.envSustain, p.release, this.sr);
    this.aenv.gateOn();
    this.fenv.gateOn();
    if (this.fenv.stage !== 0) this.fenv.value = 0;
    void vel;
  }
  process(l: Float64Array, _r: Float64Array, n: number): void {
    this.serviceHits(n);
    if (!this.mono.active) return;
    const p = this.params;
    const sr = this.sr;
    this.mono.advance(n);
    const f0 = mtof(this.mono.slideNote);
    const src = this.src;
    const dtc = (f0 * Math.pow(2, p.detune / 1200)) / sr;
    const dta = (f0 * Math.pow(2, -p.detune / 1200)) / sr;
    const dtq = f0 / sr;
    const gSaw = p.saw * 0.5;
    const gSq = p.square * 0.5;
    let [pa, pb, pc] = this.ph;
    const duty = p.pw;
    for (let i = 0; i < n; i++) {
      pa += dtc;
      if (pa >= 1) pa -= 1;
      pb += dta;
      if (pb >= 1) pb -= 1;
      pc += dtq;
      if (pc >= 1) pc -= 1;
      let sa = 2 * pa - 1;
      if (pa < dtc) {
        const x = pa / dtc;
        sa -= x + x - x * x - 1;
      } else if (pa > 1 - dtc) {
        const x = (pa - 1) / dtc;
        sa -= x * x + x + x + 1;
      }
      let sb = 2 * pb - 1;
      if (pb < dta) {
        const x = pb / dta;
        sb -= x + x - x * x - 1;
      } else if (pb > 1 - dta) {
        const x = (pb - 1) / dta;
        sb -= x * x + x + x + 1;
      }
      let sq = pc < duty ? 1 : -1;
      sq += polyBlep(pc, dtq);
      let t2 = pc - duty;
      if (t2 < 0) t2 += 1;
      sq -= polyBlep(t2, dtq);
      src[i] = (sa + sb) * gSaw + sq * gSq;
    }
    this.ph = [pa, pb, pc];
    const idle = runEnv(this.aenv, this.ae, n);
    for (let i = 0; i < n; i++) this.fe[i] = this.fenv.next();
    // ── 2x: drive -> ladder -> clip ──────────────────────────────────────────
    const b2 = this.buf2;
    this.up.process(src, n, b2);
    const driveG = dbToLin(p.drive);
    const clipG = dbToLin(p.clip);
    const bias = p.bias;
    const dc0 = tanh3(bias);
    const normD = 1 / Math.sqrt(driveG * 0.35 + 0.65);
    const normC = 1 / tanh3(clipG * 0.9);
    const velOct = p.velFilter * this.mono.vel;
    const keyOct = (p.keytrack * (this.mono.slideNote - 36)) / 12;
    const lad = this.lad;
    lad.drive = 1;
    for (let c0 = 0; c0 < 2 * n; c0 += 32) {
      const c1 = Math.min(2 * n, c0 + 32);
      const fi = this.fe[Math.min(n - 1, c0 >> 1)];
      const fc = clamp(p.cutoff * Math.pow(2, p.envAmt * fi + keyOct + velOct), 30, sr * 0.9);
      lad.set(fc, p.res, sr * 2);
      for (let j = c0; j < c1; j++) {
        let x = tanh3(b2[j] * driveG * 0.6 + bias) - dc0;
        x *= normD;
        x = lad.process(x) * (1 + 0.5 * p.res);
        x = tanh3(x * clipG) * normC;
        b2[j] = x;
      }
    }
    const out = this.outBuf;
    this.down.process(b2, n, out);
    // ── sub, tone, DC, amplitude ─────────────────────────────────────────────
    const velG = 1 - p.velocity + p.velocity * Math.pow(this.mono.vel, 1.3);
    const g = dbToLin(p.level + (-4.5)) * velG * 0.55;
    const toneK = 1 - Math.exp((-TAU * p.tone) / sr);
    let lp = this.lp;
    let sph = this.subPh;
    const sdt = f0 / sr;
    const hpR = 1 - (TAU * 28) / sr;
    let hx = this.hpX;
    let hy = this.hpY;
    const end = idle >= 0 ? idle : n;
    for (let i = 0; i < n; i++) {
      sph += sdt;
      if (sph >= 1) sph -= 1;
      lp += toneK * (out[i] - lp);
      let y = lp + sinCyc(sph) * p.sub * 0.55;
      const hp = y - hx + hpR * hy;
      hx = y;
      hy = hp;
      y = hp;
      if (i < end) l[i] += y * this.ae[i] * g;
    }
    this.lp = lp;
    this.subPh = sph;
    this.hpX = hx;
    this.hpY = hy;
    if (idle >= 0) this.mono.active = false;
  }
}

export const DARK_PRESETS: Record<string, PresetDef> = {
  'darksynth-bass': { doc: 'The rolling, distorted 16th-note bass of Carpenter Brut / Perturbator: saw pair + square, heavy drive, a filter that pops open on every note.', opts: { level: 0 } },
  'dark-growl': { doc: 'Meaner and more open: more drive, more resonance, slower filter.', opts: { level: -0.5, drive: 24, clip: 12, res: 0.4, envAmt: 2.6, envDecay: 0.32, cutoff: 600, bias: 0.2 } },
  'dark-sustain': { doc: 'A held, buzzing bass for half-time sections: the filter stays mostly open.', opts: { level: -0.5, cutoff: 900, envAmt: 1.2, envDecay: 0.5, envSustain: 0.5, drive: 18, release: 0.12, decay: 2 } },
  'dark-pluck': { doc: 'Short, tight bass notes with a very quick filter snap.', opts: { level: 6, envAmt: 3.8, envDecay: 0.1, envSustain: 0, decay: 0.2, sustain: 0.2, release: 0.04, cutoff: 500, drive: 14 } },
  'dark-clean': { doc: 'Cleaner, warmer (less distortion): for verses and intros.', opts: { level: 3.5, drive: 6, clip: 3, bias: 0.05, cutoff: 500, envAmt: 2, res: 0.15, square: 0.3 } },
};

// ─────────────────────────────────────────────────────────────────────────────
// ReeseBass
// ─────────────────────────────────────────────────────────────────────────────

export const REESE_SPECS = {
  level: { default: 0, min: -40, max: 12, unit: 'dB', doc: 'Trim in dB on top of the preset\'s calibrated loudness (0 = as calibrated; the fader is the channel\'s `gain` in the mix).' },
  detune: { default: 18, min: 1, max: 60, unit: 'cents', doc: 'Detune of the saws (the beating that makes the reese).' },
  drift: { default: 0.5, min: 0, max: 1, doc: 'Slow movement of the detune (the phase-shifting "swirl").' },
  driftRate: { default: 0.22, min: 0.02, max: 4, unit: 'Hz', curve: 'exp', doc: 'Speed of the swirl.' },
  cutoff: { default: 900, min: 80, max: 8000, unit: 'Hz', curve: 'exp', doc: 'Filter cutoff.' },
  res: { default: 0.22, min: 0, max: 0.9, doc: 'Filter resonance.' },
  envAmt: { default: 1.2, min: -4, max: 6, unit: 'octaves', doc: 'Filter envelope amount.' },
  envDecay: { default: 0.5, min: 0.02, max: 4, unit: 's', doc: 'Filter envelope decay.' },
  envSustain: { default: 0.5, min: 0, max: 1, doc: 'Filter envelope sustain.' },
  drive: { default: 9, min: 0, max: 36, unit: 'dB', doc: 'Saturation after the filter.' },
  width: { default: 0.8, min: 0, max: 1, doc: 'Stereo width of the saws (the sub stays centred).' },
  sub: { default: 0.6, min: 0, max: 1, doc: 'Clean sine sub level.' },
  glide: { default: 0.03, min: 0, max: 1, unit: 's', doc: 'Portamento (slide-flagged notes glide at least 60 ms).' },
  attack: { default: 0.01, min: 0.0005, max: 2, unit: 's', doc: 'Attack.' },
  decay: { default: 1, min: 0.02, max: 6, unit: 's', doc: 'Decay.' },
  sustain: { default: 1, min: 0, max: 1, doc: 'Sustain.' },
  release: { default: 0.15, min: 0.005, max: 3, unit: 's', doc: 'Release.' },
  tone: { default: 9000, min: 500, max: 18000, unit: 'Hz', curve: 'exp', doc: 'Low-pass at the end.' },
  velocity: { default: 0.4, min: 0, max: 1, doc: 'How much velocity changes the level.' },
} satisfies ParamSpecs;

export class ReeseBass extends BassBase<typeof REESE_SPECS> {
  readonly stereo = true;
  private readonly flt = [new Svf(), new Svf()];
  private readonly ph = new Float64Array(6);
  private readonly lpS = [0, 0];
  private subPh = 0;
  private drift = 0;
  private readonly hp = [new Float64Array(2), new Float64Array(2)];
  constructor(ctx: Ctx, input?: Record<string, unknown> | string) {
    const o = resolveOpts('reese bass', REESE_PRESETS, input ?? 'reese', REESE_SPECS, []);
    super('ReeseBass', REESE_SPECS, ctx, o);
    for (let i = 0; i < 6; i++) this.ph[i] = this.rng.next();
  }
  protected glideTime(): number {
    return this.params.glide;
  }
  protected trigger(): void {
    const p = this.params;
    this.aenv.set(p.attack, p.decay, p.sustain, p.release, this.sr);
    this.fenv.set(0.003, p.envDecay, p.envSustain, p.release, this.sr);
    this.aenv.gateOn();
    this.fenv.gateOn();
  }
  process(l: Float64Array, r: Float64Array, n: number): void {
    this.serviceHits(n);
    if (!this.mono.active) return;
    const p = this.params;
    const sr = this.sr;
    this.mono.advance(n);
    const f0 = mtof(this.mono.slideNote);
    this.drift += (p.driftRate * n) / sr;
    if (this.drift >= 1) this.drift -= 1;
    const dv = p.detune * (1 + p.drift * 0.6 * sinCyc(this.drift)) * (1 + p.drift * 0.25 * sinCyc((this.drift * 2.7 + 0.3) % 1));
    // detune patterns per channel (cents multipliers)
    const patL = [-1, -0.12, 0.62];
    const patR = [-0.62, 0.12, 1];
    const bl = this.src;
    const br = this.srcR;
    bl.fill(0, 0, n);
    br.fill(0, 0, n);
    const w = p.width;
    for (let c = 0; c < 2; c++) {
      const pat = c === 0 ? patL : patR;
      const buf = c === 0 ? bl : br;
      for (let k = 0; k < 3; k++) {
        const dt = (f0 * Math.pow(2, (pat[k] * dv) / 1200)) / sr;
        let ph = this.ph[c * 3 + k];
        for (let i = 0; i < n; i++) {
          ph += dt;
          if (ph >= 1) ph -= 1;
          let y = 2 * ph - 1;
          if (ph < dt) {
            const x = ph / dt;
            y -= x + x - x * x - 1;
          } else if (ph > 1 - dt) {
            const x = (ph - 1) / dt;
            y -= x * x + x + x + 1;
          }
          buf[i] += y * 0.33;
        }
        this.ph[c * 3 + k] = ph;
      }
    }
    // narrow towards mono when width < 1
    if (w < 1) {
      for (let i = 0; i < n; i++) {
        const m = (bl[i] + br[i]) * 0.5;
        bl[i] = m + (bl[i] - m) * w;
        br[i] = m + (br[i] - m) * w;
      }
    }
    const idle = runEnv(this.aenv, this.ae, n);
    for (let i = 0; i < n; i++) this.fe[i] = this.fenv.next();
    const fc = clamp(p.cutoff * Math.pow(2, p.envAmt * this.fe[0] + (0.4 * (this.mono.slideNote - 36)) / 12), 50, sr * 0.45);
    const q = 0.6 + p.res * p.res * 10;
    const driveG = dbToLin(p.drive);
    const normC = 1 / tanh3(driveG * 0.8);
    const velG = 1 - p.velocity + p.velocity * Math.pow(this.mono.vel, 1.3);
    const g = dbToLin(p.level + (-6.5)) * velG * 0.55;
    const toneK = 1 - Math.exp((-TAU * p.tone) / sr);
    const sdt = f0 / sr;
    let sph = this.subPh;
    const end = idle >= 0 ? idle : n;
    const hpR = 1 - (TAU * 28) / sr;
    for (let c = 0; c < 2; c++) {
      const f = this.flt[c];
      f.set(fc, q, sr);
      const buf = c === 0 ? bl : br;
      let lp = this.lpS[c];
      let hx = this.hp[c][0];
      let hy = this.hp[c][1];
      let sp = sph;
      for (let i = 0; i < n; i++) {
        f.step(buf[i] * 1.4);
        let y = tanh3(f.lp * driveG) * normC;
        lp += toneK * (y - lp);
        sp += sdt;
        if (sp >= 1) sp -= 1;
        y = lp + sinCyc(sp) * p.sub * 0.5;
        const h = y - hx + hpR * hy;
        hx = y;
        hy = h;
        if (i < end) (c === 0 ? l : r)[i] += h * this.ae[i] * g;
      }
      this.lpS[c] = lp;
      this.hp[c][0] = hx;
      this.hp[c][1] = hy;
      if (c === 1) sph = sp;
    }
    this.subPh = sph;
    if (idle >= 0) this.mono.active = false;
  }
}

export const REESE_PRESETS: Record<string, PresetDef> = {
  reese: { doc: 'Classic reese: three detuned saws per side that beat and swirl, dark filter, a clean sub underneath. Melodic dubstep / DnB bass.', opts: { level: 0.5 } },
  'reese-wide': { doc: 'Wider, brighter reese for drops: more detune and drift, more drive.', opts: { level: -1, detune: 28, drift: 0.8, width: 1, cutoff: 1500, drive: 14, res: 0.3 } },
  'reese-dark': { doc: 'Dark, menacing, slow: low cutoff, little movement.', opts: { level: 1, detune: 12, drift: 0.3, cutoff: 500, envAmt: 0.6, drive: 7 } },
  'reese-neuro': { doc: 'Aggressive neuro bass: heavy drive, resonant filter.', opts: { level: -2.5, detune: 22, drift: 0.9, driftRate: 0.6, cutoff: 1100, res: 0.5, drive: 22, envAmt: 2, envDecay: 0.25 } },
  'rolling-bass': {
    doc: 'Goa / psytrance off-beat bass: short plucky notes (the filter snaps open and shut in 80 ms, release 40 ms) so that a sixteenth-note line stays separate, and narrow so that it sits tight under the kick. Play it on the three sixteenths after each kick (`.xxx.xxx.xxx.xxx`) with `duck: 1`.',
    opts: { level: 6.5, cutoff: 700, width: 0.4, envAmt: 2, envDecay: 0.08, decay: 0.15, sustain: 0.4, release: 0.04 },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// GrowlBass (dubstep)
// ─────────────────────────────────────────────────────────────────────────────

export const GROWL_SPECS = {
  level: { default: 0, min: -40, max: 12, unit: 'dB', doc: 'Trim in dB on top of the preset\'s calibrated loudness (0 = as calibrated; the fader is the channel\'s `gain` in the mix).' },
  cutoff: { default: 500, min: 40, max: 9000, unit: 'Hz', curve: 'exp', doc: 'Filter cutoff at the closed end of the wobble.' },
  res: { default: 0.4, min: 0, max: 1, doc: 'Filter resonance.' },
  lfoRate: { default: 1, min: 0.125, max: 16, unit: 'cycles/beat', curve: 'exp', doc: 'Wobble speed, locked to the tempo: 0.5 = half notes, 1 = quarter notes, 2 = eighths, 3 = eighth triplets, 4 = sixteenths. Changing it while a note sounds bends the speed; the wobble does not jump.' },
  lfoPhase: { default: 0, min: 0, max: 1, unit: 'cycles', doc: 'Where in its cycle the wobble is when a note starts (lfoSync "note") or on the beat (lfoSync "beat"). A sine at 0 starts half open and opens; 0.25 starts fully open and closes; 0.5 starts half open and closes; 0.75 starts closed and opens (saw: starts closed at 0, ramp and square: open).' },
  lfoDepth: { default: 2.6, min: 0, max: 6, unit: 'octaves', doc: 'How far the wobble opens the filter above `cutoff`.' },
  lfoFm: { default: 1.5, min: 0, max: 10, doc: 'How much the wobble moves the FM index (the "yoi" in the tone).' },
  lfoVowel: { default: 0.6, min: 0, max: 3, doc: 'How far the wobble moves through the vowels (formant filter).' },
  vowel: { default: 0, min: 0, max: 4, doc: 'Vowel position of the formant filter: 0 A, 1 E, 2 I, 3 O, 4 U.' },
  formant: { default: 0.5, min: 0, max: 1, doc: 'Mix of the formant (vowel) filter.' },
  fmMix: { default: 0.5, min: 0, max: 1, doc: 'Mix of the FM oscillator against the saws.' },
  fmRatio: { default: 1, min: 0.25, max: 8, doc: 'FM modulator ratio (1 / 2 / 3 harmonic, 1.5 / 2.5 gnarlier).' },
  fmIndex: { default: 3, min: 0, max: 12, doc: 'FM index (base brightness).' },
  drive: { default: 14, min: 0, max: 40, unit: 'dB', doc: 'Saturation before the filters.' },
  fold: { default: 0.25, min: 0, max: 1, doc: 'Wavefolder amount (harsh, metallic overtones).' },
  clip: { default: 6, min: 0, max: 30, unit: 'dB', doc: 'Saturation after the filters.' },
  comb: { default: 0, min: 0, max: 0.95, doc: 'Comb filter feedback (robotic, hollow resonance tuned to the note).' },
  sub: { default: 0.5, min: 0, max: 1, doc: 'Level of a clean sine sub under the growl.' },
  detune: { default: 12, min: 0, max: 40, unit: 'cents', doc: 'Detune between the two saws.' },
  envAmt: { default: 0, min: -4, max: 6, unit: 'octaves', doc: 'Extra filter opening at the start of each note.' },
  envDecay: { default: 0.15, min: 0.02, max: 3, unit: 's', doc: 'Decay of that opening.' },
  glide: { default: 0, min: 0, max: 1, unit: 's', doc: 'Portamento.' },
  pEnv: { default: 0, min: -24, max: 24, unit: 'semitones', doc: 'Pitch dive: every new note starts this far above (+) or below (-) its pitch and settles into it within `pEnvTime`, fast at first (the classic dive into the note). A tied (~) note is not re-enveloped; the growl\'s own sub dives with it. 0 = off.' },
  pEnvTime: { default: 0.08, min: 0.005, max: 1, unit: 's', doc: 'How long the dive takes: the offset falls exponentially in semitones (half of it is gone after a seventh of this time, 92 % after half of it) and is exactly gone when the time is up. A total, not a time constant like the synth\'s `pEnvTime`.' },
  attack: { default: 0.003, min: 0.0005, max: 1, unit: 's', doc: 'Attack.' },
  decay: { default: 1, min: 0.02, max: 6, unit: 's', doc: 'Decay.' },
  sustain: { default: 1, min: 0, max: 1, doc: 'Sustain.' },
  release: { default: 0.08, min: 0.005, max: 3, unit: 's', doc: 'Release.' },
  tone: { default: 9000, min: 500, max: 18000, unit: 'Hz', curve: 'exp', doc: 'Low-pass at the end.' },
  velocity: { default: 0.4, min: 0, max: 1, doc: 'How much velocity changes the level.' },
  width: { default: 0, min: 0, max: 1, doc: 'Stereo width: above `widthFreq` the growl gets a decorrelated side signal, L = growl + side and R = growl - side, so the mono sum is the growl itself. 0 = both sides the same as the mono growl, 1 = the side is 4.4 dB under the mid above `widthFreq` (about as wide as a mono source gets without sounding detached). Setting `width` in the options or the preset (any value, 0 too) makes the growl a stereo source; without it the growl is mono and this parameter does nothing (automating it is an error that says so).' },
  widthFreq: { default: 200, min: 60, max: 1000, unit: 'Hz', curve: 'exp', doc: 'Below this frequency the growl stays mono: the side signal starts here (a Linkwitz-Riley 8th-order high-pass: -6 dB at this frequency, 48 dB per octave below it).' },
} satisfies ParamSpecs;

/** The side signal is this much of the high band at width 1: -4.4 dB, in the middle of what a wide synth does (a supersaw chord is at about -2 dB). */
const SIDE_GAIN = 0.6;

/** The pitch dive of the growl is exp(-DIVE_K * t / pEnvTime), shifted so that it is exactly 0 at pEnvTime (DIVE_END is its value there). */
const DIVE_K = 5;
const DIVE_END = Math.exp(-DIVE_K);

/** The pitch offset in semitones `age` samples after a note started: `pEnv` at the start, exactly 0 from `span` samples on, exponential in between. */
function pitchDive(pEnv: number, age: number, span: number): number {
  if (age >= span) return 0;
  return pEnv * ((Math.exp((-DIVE_K * age) / span) - DIVE_END) / (1 - DIVE_END));
}

export interface GrowlOpts {
  name?: string;
  preset?: string;
  /** Wobble shape: 'sine' (default), 'tri', 'saw', 'ramp', 'square', 'smooth', 'sh' (random steps). */
  lfoShape?: 'sine' | 'tri' | 'saw' | 'ramp' | 'square' | 'smooth' | 'sh';
  /** 'note' (default): the wobble restarts at every note, so a note must last a cycle to show it; 'beat': locked to the song's beat grid (use it for rhythmic lines). */
  lfoSync?: 'note' | 'beat';
  [param: string]: unknown;
}

// vowel formants (F1, F2) in Hz: A E I O U
const VOWELS: [number, number][] = [
  [800, 1150],
  [400, 1700],
  [350, 2300],
  [450, 800],
  [325, 700],
];

export class GrowlBass extends BassBase<typeof GROWL_SPECS> {
  private readonly up = new Upsampler2x();
  private readonly down = new Downsampler2x();
  private readonly lad = new Ladder();
  private readonly f1 = new Svf();
  private readonly f2 = new Svf();
  private readonly shape: string;
  private readonly sync: 'note' | 'beat';
  private ph = [0, 0, 0, 0];
  private fb = 0;
  private subPh = 0;
  private lp = 0;
  private hpX = 0;
  private hpY = 0;
  private readonly combBuf = new Float64Array(4096);
  private combPos = 0;
  // the wobble's phase, in cycles. Note sync: cycles since the note started. Beat sync: the phase at the end of the last block, and the
  // offset that keeps the wobble on the beat grid (cycles = beat * rate + offset); a change of rate re-bases the offset so the phase goes on
  private lfoCyc = 0;
  private lfoOffset = 0;
  private lfoRateUsed = 0;
  private lfoNextBeat = -1;
  /** A growl is a stereo source only when its options or its preset set `width` (any value): the flag is fixed when it is built. */
  readonly stereo: boolean;
  private readonly side: SideDecorrelator | null;
  private readonly monoOut = new Float64Array(BLOCK);
  private readonly sideOut = new Float64Array(BLOCK);
  private sideGain = -1; // the side level at the end of the last block (-1: none yet)
  constructor(ctx: Ctx, input?: GrowlOpts | string) {
    const o = resolveOpts('growl bass', GROWL_PRESETS, input ?? 'dubstep-growl', GROWL_SPECS, ['lfoShape', 'lfoSync']);
    super('GrowlBass', GROWL_SPECS, ctx, o);
    this.shape = pickWord('growl bass', 'lfoShape', o.lfoShape, LFO_SHAPES, 'sine');
    this.sync = pickWord('growl bass', 'lfoSync', o.lfoSync, ['note', 'beat'] as const, 'note');
    this.stereo = o.width !== undefined;
    this.side = this.stereo ? new SideDecorrelator(ctx.sr) : null;
  }
  /** Automating the width of a growl that is mono (it was built without one) would do nothing: say so. */
  inertParam(name: string): string | null {
    if (this.stereo || (name !== 'width' && name !== 'widthFreq')) return null;
    return `this growl is mono, so "${name}" does nothing: give it a width when you make it (s.growl({ preset: 'dubstep-growl', width: 0 })) to make it a stereo source, then automate it`;
  }
  protected glideTime(): number {
    return this.params.glide;
  }
  protected trigger(): void {
    const p = this.params;
    this.aenv.set(p.attack, p.decay, p.sustain, p.release, this.sr);
    this.fenv.set(0.001, p.envDecay, 0, p.release, this.sr);
    this.aenv.gateOn();
    this.fenv.gateOn();
    if (this.sync === 'note') this.lfoCyc = 0;
  }
  /** The wobble's phase in cycles at the end of the last rendered block (for tests). */
  lfoCycles(): number {
    return this.lfoCyc;
  }
  private lfoAt(cycles: number): number {
    const idx = Math.floor(cycles);
    const ph = cycles - idx;
    switch (this.shape) {
      case 'tri':
        return ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
      case 'saw':
        return 2 * ph - 1;
      case 'ramp':
        return 1 - 2 * ph;
      case 'square':
        return ph < 0.5 ? 1 : -1;
      case 'sh':
        return hashRand(idx);
      case 'smooth': {
        const a = hashRand(idx);
        const b = hashRand(idx + 1);
        const s = ph * ph * (3 - 2 * ph);
        return a + (b - a) * s;
      }
      default:
        return sinCyc(ph);
    }
  }
  process(l: Float64Array, r: Float64Array, n: number): void {
    this.serviceHits(n);
    if (!this.mono.active) return;
    const p = this.params;
    const sr = this.sr;
    const spb = (sr * 60) / this.ctx.bpm;
    const age0 = this.mono.age; // samples since the note (re)started, at the first sample of this block
    this.mono.advance(n);
    // the pitch dive: its offset in semitones at the first sample of the block, and the ratio of the frequency from one sample to the next
    // (the oscillators and the sub glide through the block, they do not step; a tied note keeps its age, so it is not dived again)
    let o0 = 0;
    let ratio = 1;
    if (p.pEnv !== 0) {
      const span = p.pEnvTime * sr;
      o0 = pitchDive(p.pEnv, age0, span);
      const o1 = pitchDive(p.pEnv, age0 + n, span);
      if (o1 !== o0) ratio = Math.pow(2, (o1 - o0) / (12 * n));
    }
    const moving = ratio !== 1;
    const f0 = mtof(this.mono.slideNote + o0);
    const src = this.src;
    let dta = (f0 * Math.pow(2, p.detune / 1200)) / sr;
    let dtb = (f0 * Math.pow(2, -p.detune / 1200)) / sr;
    let dtf = f0 / sr;
    let [pa, pb, pf, pm] = this.ph;
    const beat0 = this.ctx.transport.beat;
    // the wobble's phase at the first sample of this block, in cycles (accumulated, so that a change of lfoRate never jumps the phase)
    const rate = p.lfoRate;
    let cycStart: number;
    if (this.sync === 'note') cycStart = this.lfoCyc;
    else {
      const contiguous = Math.abs((beat0 - this.lfoNextBeat) * spb) < 0.5;
      if (!contiguous) this.lfoOffset = 0;
      else if (rate !== this.lfoRateUsed) this.lfoOffset = this.lfoCyc - beat0 * rate;
      cycStart = beat0 * rate + this.lfoOffset;
    }
    const cycPerSample = rate / spb;
    this.lfoCyc = cycStart + n * cycPerSample;
    this.lfoRateUsed = rate;
    this.lfoNextBeat = beat0 + n / spb;
    const idle = runEnv(this.aenv, this.ae, n);
    for (let i = 0; i < n; i++) this.fe[i] = this.fenv.next();
    // per-16-sample LFO values (k-rate inside the block)
    const lfoAtI = (i: number): number => this.lfoAt(cycStart + i * cycPerSample + p.lfoPhase);
    // source: saw pair + FM voice (the FM index is modulated by the LFO per 16 samples)
    const fmR = p.fmRatio;
    let fb = this.fb;
    for (let i = 0; i < n; i++) {
      if ((i & 15) === 0) {
        // nothing: index is evaluated below from the same LFO value
      }
      pa += dta;
      if (pa >= 1) pa -= 1;
      pb += dtb;
      if (pb >= 1) pb -= 1;
      let sa = 2 * pa - 1;
      if (pa < dta) {
        const x = pa / dta;
        sa -= x + x - x * x - 1;
      } else if (pa > 1 - dta) {
        const x = (pa - 1) / dta;
        sa -= x * x + x + x + 1;
      }
      let sb = 2 * pb - 1;
      if (pb < dtb) {
        const x = pb / dtb;
        sb -= x + x - x * x - 1;
      } else if (pb > 1 - dtb) {
        const x = (pb - 1) / dtb;
        sb -= x * x + x + x + 1;
      }
      const lv = (i & 15) === 0 || i === 0 ? lfoAtI(i) : this.lastLfo;
      this.lastLfo = lv;
      const idx = Math.max(0, p.fmIndex + p.lfoFm * (lv * 0.5 + 0.5));
      pf += dtf;
      if (pf >= 1) pf -= 1;
      pm += dtf * fmR;
      if (pm >= 1) pm -= 1;
      const mod = sinCyc(pm);
      fb = mod;
      let x = pf + (idx / TAU) * mod;
      x -= Math.floor(x);
      const fm = sinCyc(x);
      src[i] = ((sa + sb) * 0.5) * (1 - p.fmMix) + fm * p.fmMix;
      if (moving) {
        dta *= ratio;
        dtb *= ratio;
        dtf *= ratio;
      }
    }
    this.ph = [pa, pb, pf, pm];
    this.fb = fb;
    // ── 2x chain ─────────────────────────────────────────────────────────────
    const b2 = this.buf2;
    this.up.process(src, n, b2);
    const driveG = dbToLin(p.drive);
    const clipG = dbToLin(p.clip);
    const foldA = p.fold;
    const normD = 1 / Math.sqrt(driveG * 0.3 + 0.7);
    const normC = 1 / tanh3(clipG * 0.9);
    const lad = this.lad;
    lad.drive = 1;
    const comb = p.comb;
    const combBuf = this.combBuf;
    const combMask = combBuf.length - 1;
    const combDelay = clamp(Math.round(((sr * 2) / f0) * 1), 8, combMask - 2);
    let cp = this.combPos;
    for (let c0 = 0; c0 < 2 * n; c0 += 32) {
      const c1 = Math.min(2 * n, c0 + 32);
      const ib = c0 >> 1;
      const lv = lfoAtI(Math.min(n - 1, ib));
      const l01 = lv * 0.5 + 0.5;
      const fc = clamp(p.cutoff * Math.pow(2, p.lfoDepth * l01 + p.envAmt * this.fe[Math.min(n - 1, ib)]), 40, sr * 0.9);
      lad.set(fc, p.res, sr * 2);
      const vp = clamp(p.vowel + p.lfoVowel * lv, 0, 4);
      const vi = Math.min(3, Math.floor(vp));
      const vf = vp - vi;
      const F1 = VOWELS[vi][0] * Math.pow(VOWELS[vi + 1][0] / VOWELS[vi][0], vf);
      const F2 = VOWELS[vi][1] * Math.pow(VOWELS[vi + 1][1] / VOWELS[vi][1], vf);
      this.f1.set(F1, 7, sr * 2);
      this.f2.set(F2, 9, sr * 2);
      const fm = p.formant;
      for (let j = c0; j < c1; j++) {
        let x = b2[j] * driveG * 0.5;
        if (foldA > 0) x = fold(x * (1 + 2.5 * foldA)) * 0.7 + x * 0.3;
        x = tanh3(x) * normD;
        if (fm > 0) {
          this.f1.step(x);
          this.f2.step(x);
          x = x * (1 - fm) + (this.f1.k * this.f1.bp + 0.8 * this.f2.k * this.f2.bp) * fm * 1.8;
        }
        x = lad.process(x) * (1 + 0.5 * p.res);
        if (comb > 0) {
          combBuf[cp & combMask] = x;
          x += comb * combBuf[(cp - combDelay) & combMask] * 0.7;
          cp++;
        }
        x = tanh3(x * clipG) * normC;
        b2[j] = x;
      }
    }
    this.combPos = cp;
    const out = this.outBuf;
    this.down.process(b2, n, out);
    const velG = 1 - p.velocity + p.velocity * Math.pow(this.mono.vel, 1.3);
    const g = dbToLin(p.level + (1)) * velG * 0.5;
    const toneK = 1 - Math.exp((-TAU * p.tone) / sr);
    let lp = this.lp;
    let sph = this.subPh;
    let sdt = f0 / sr; // the sub dives with the saws and the FM voice: they never beat
    const hpR = 1 - (TAU * 28) / sr;
    let hx = this.hpX;
    let hy = this.hpY;
    const end = idle >= 0 ? idle : n;
    const stereo = this.stereo;
    const mo = this.monoOut;
    for (let i = 0; i < n; i++) {
      sph += sdt;
      if (sph >= 1) sph -= 1;
      lp += toneK * (out[i] - lp);
      let y = lp + sinCyc(sph) * p.sub * 0.55;
      const h = y - hx + hpR * hy;
      hx = y;
      hy = h;
      y = h;
      if (stereo) mo[i] = i < end ? y * this.ae[i] * g : 0;
      else if (i < end) l[i] += y * this.ae[i] * g;
      if (moving) sdt *= ratio;
    }
    this.lp = lp;
    this.subPh = sph;
    this.hpX = hx;
    this.hpY = hy;
    if (stereo) this.widen(mo, l, r, n);
    if (idle >= 0) {
      this.mono.active = false;
      this.side?.clear();
    }
  }
  /**
   * The stereo stage: the growl above `widthFreq`, decorrelated, is the side. L = growl + w * side and R = growl - w * side, so the mono sum
   * is the growl and at width 0 both sides are the growl itself, bit for bit (the strip pans a stereo source with its balance law, which at the
   * centre is the unity gain the constant-power law gives a mono source).
   */
  private widen(mo: Float64Array, l: Float64Array, r: Float64Array, n: number): void {
    const p = this.params;
    const side = this.side as SideDecorrelator;
    const so = this.sideOut;
    side.setCorner(p.widthFreq);
    side.process(mo, n, so);
    const w1 = p.width * SIDE_GAIN;
    let w = this.sideGain < 0 ? w1 : this.sideGain; // the level glides across the block, so that automation never steps
    const dw = (w1 - w) / n;
    for (let i = 0; i < n; i++) {
      w += dw;
      const m = mo[i];
      const d = w * so[i];
      l[i] += m + d;
      r[i] += m - d;
    }
    this.sideGain = w1;
  }
  private lastLfo = 0;
}

function hashRand(i: number): number {
  let x = Math.imul(i | 0, 0x9e3779b1);
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  return ((x >>> 0) / 4294967296) * 2 - 1;
}

export const GROWL_PRESETS: Record<string, PresetDef> = {
  'dubstep-growl': { doc: 'The classic growl: saw + FM, vowel formants morphing with a quarter-note wobble, heavy distortion. Use on held bass notes of 1-2 beats in half-time drops.', opts: { level: 1 } },
  wub: { doc: 'Simple big "wub": saw pair, no formants, an eighth-note wobble on the filter (the cleanest, most predictable bass).', opts: { level: -2, fmMix: 0.15, formant: 0, lfoRate: 2, lfoDepth: 3.2, lfoFm: 0.5, lfoVowel: 0, drive: 10, fold: 0.1, res: 0.5, cutoff: 260 } },
  yoi: { doc: 'Talking "yoi-yoi" growl: vowels sweep strongly, slower wobble.', opts: { level: 1.5, formant: 0.85, lfoVowel: 2.4, lfoRate: 0.5, lfoDepth: 1.2, vowel: 0.3, fmMix: 0.4, drive: 16, res: 0.35, cutoff: 700 } },
  riddim: { doc: 'Riddim: square-wave gating wobble at triplet speed, folded and brutal.', opts: { level: 2, lfoRate: 3, lfoDepth: 3.6, fold: 0.5, drive: 20, formant: 0.3, lfoVowel: 0.5, fmMix: 0.3, res: 0.45, cutoff: 220 }, },
  neuro: { doc: 'Neuro-style: fast sample-and-hold movement, resonant and metallic (comb on).', opts: { level: -3, lfoRate: 4, lfoDepth: 2, lfoFm: 3.5, lfoVowel: 1.5, comb: 0.5, fmMix: 0.6, fmRatio: 1.5, drive: 24, fold: 0.35, res: 0.55, cutoff: 600, clip: 10 } },
  screech: { doc: 'High, bright, screaming FM lead-bass for melodic dubstep fills (play it around C3-C4).', opts: { level: 1, cutoff: 2600, lfoDepth: 1.5, lfoRate: 1, fmMix: 0.85, fmIndex: 5, lfoFm: 4, fmRatio: 2, formant: 0.6, vowel: 1.5, lfoVowel: 1, drive: 18, fold: 0.3, sub: 0.15, res: 0.5 } },
};

// ─────────────────────────────────────────────────────────────────────────────
// AcidBass (TB-303 style)
// ─────────────────────────────────────────────────────────────────────────────

export const ACID_SPECS = {
  level: { default: 0, min: -40, max: 12, unit: 'dB', doc: 'Trim in dB on top of the preset\'s calibrated loudness (0 = as calibrated; the fader is the channel\'s `gain` in the mix).' },
  cutoff: { default: 380, min: 60, max: 6000, unit: 'Hz', curve: 'exp', doc: 'Base cutoff: where the filter sits when closed. Sweep it up over a build-up.' },
  res: { default: 0.78, min: 0, max: 1, doc: 'Resonance: the squelch (0.9+ nearly self-oscillates).' },
  envMod: { default: 0.65, min: 0, max: 1, doc: 'How far every note opens the filter (0.5 gentle, 1 = wide open).' },
  decay: { default: 0.28, min: 0.05, max: 2, unit: 's', doc: 'How fast the filter closes after each note (short = plucky, long = open and wailing).' },
  accent: { default: 0.75, min: 0, max: 1, doc: 'Strength of accented notes (!): louder, a bigger filter sweep, shorter decay; consecutive accents build up.' },
  slide: { default: 0.06, min: 0.01, max: 0.5, unit: 's', doc: 'Glide time of slid notes (~).' },
  square: { default: 0, min: 0, max: 1, doc: 'Waveform: 0 = sawtooth, 1 = square (hollow).' },
  drive: { default: 7, min: 0, max: 36, unit: 'dB', doc: 'Overdrive after the filter (the dirty acid sound).' },
  tone: { default: 7000, min: 800, max: 18000, unit: 'Hz', curve: 'exp', doc: 'Low-pass after the overdrive.' },
  tune: { default: 0, min: -100, max: 100, unit: 'cents', doc: 'Fine tuning.' },
  release: { default: 0.02, min: 0.005, max: 1, unit: 's', doc: 'Amplitude release at the end of a note.' },
} satisfies ParamSpecs;

export class AcidBass extends BassBase<typeof ACID_SPECS> {
  private readonly lad = new Ladder();
  private readonly up = new Upsampler2x();
  private readonly down = new Downsampler2x();
  private ph = 0;
  private lp = 0;
  private acc = 0;
  private accentNow = false;
  private envMax = 1;
  private hpX = 0;
  private hpY = 0;
  private accCap = 0;
  constructor(ctx: Ctx, input?: Record<string, unknown> | string) {
    const o = resolveOpts('acid bass', ACID_PRESETS, input ?? 'acid-303', ACID_SPECS, []);
    super('AcidBass', ACID_SPECS, ctx, o);
    this.lad.setFeedbackHp(120, ctx.sr * 2);
  }
  protected glideTime(): number {
    return 0;
  }
  protected slideTime(): number {
    return this.params.slide;
  }
  protected trigger(_note: number, _vel: number, flags: number): void {
    const p = this.params;
    const acc = (flags & FLAG.ACCENT) !== 0;
    this.accentNow = acc;
    // the accent capacitor charges on consecutive accents and drains slowly
    this.accCap = acc ? this.accCap + (1 - this.accCap) * 0.45 : this.accCap * 0.5;
    this.aenv.set(0.002, 1.6, 0.8, p.release, this.sr);
    this.fenv.set(0.001, p.decay * (acc ? 1 - 0.45 * p.accent : 1), 0, 0.05, this.sr);
    this.aenv.gateOn();
    this.fenv.gateOn();
    this.fenv.value = 1;
    this.fenv.stage = 2;
  }
  protected slideTrigger(): void {
    // a slid note keeps both envelopes running (that is what makes the line glide and stay open)
  }
  process(l: Float64Array, _r: Float64Array, n: number): void {
    this.serviceHits(n);
    if (!this.mono.active) return;
    const p = this.params;
    const sr = this.sr;
    this.mono.advance(n);
    // the capacitor drains with time
    this.accCap *= Math.exp(-n / (0.35 * sr));
    const f0 = mtof(this.mono.slideNote + p.tune / 100);
    const dt = f0 / sr;
    const src = this.src;
    const sq = p.square;
    let ph = this.ph;
    for (let i = 0; i < n; i++) {
      ph += dt;
      if (ph >= 1) ph -= 1;
      let s = 2 * ph - 1;
      if (ph < dt) {
        const x = ph / dt;
        s -= x + x - x * x - 1;
      } else if (ph > 1 - dt) {
        const x = (ph - 1) / dt;
        s -= x * x + x + x + 1;
      }
      let q = ph < 0.5 ? 1 : -1;
      q += polyBlep(ph, dt);
      let t2 = ph - 0.5;
      if (t2 < 0) t2 += 1;
      q -= polyBlep(t2, dt);
      src[i] = s * (1 - sq) + q * sq * 0.8;
    }
    this.ph = ph;
    const idle = runEnv(this.aenv, this.ae, n);
    for (let i = 0; i < n; i++) this.fe[i] = this.fenv.next();
    const b2 = this.buf2;
    this.up.process(src, n, b2);
    const lad = this.lad;
    const acc = this.accentNow;
    const modOct = 0.4 + p.envMod * 4.2 + (acc ? p.accent * (0.8 + 1.6 * this.accCap) : 0);
    const driveG = dbToLin(p.drive);
    const normC = 1 / tanh3(driveG * 0.8);
    lad.drive = 1.4;
    for (let c0 = 0; c0 < 2 * n; c0 += 32) {
      const c1 = Math.min(2 * n, c0 + 32);
      const fe = this.fe[Math.min(n - 1, c0 >> 1)];
      const fc = clamp(p.cutoff * Math.pow(2, modOct * fe), 50, sr * 0.9);
      lad.set(fc, p.res, sr * 2);
      for (let j = c0; j < c1; j++) {
        lad.process(b2[j] * 1.2);
        // 18 dB/oct flavour: mostly the third stage
        const y = lad.y3 * 0.7 + lad.y4 * 0.3;
        b2[j] = tanh3(y * driveG * 0.9) * normC;
      }
    }
    const out = this.outBuf;
    this.down.process(b2, n, out);
    const toneK = 1 - Math.exp((-TAU * p.tone) / sr);
    let lp = this.lp;
    const g = dbToLin(p.level + (-5)) * (acc ? 0.62 : 0.46);
    const hpR = 1 - (TAU * 30) / sr;
    let hx = this.hpX;
    let hy = this.hpY;
    const end = idle >= 0 ? idle : n;
    for (let i = 0; i < n; i++) {
      lp += toneK * (out[i] - lp);
      const h = lp - hx + hpR * hy;
      hx = lp;
      hy = h;
      if (i < end) l[i] += h * this.ae[i] * g * (0.55 + 0.45 * this.mono.vel);
    }
    this.lp = lp;
    this.hpX = hx;
    this.hpY = hy;
    if (idle >= 0) this.mono.active = false;
  }
}

export const ACID_PRESETS: Record<string, PresetDef> = {
  'acid-303': { doc: 'The TB-303: sawtooth into a resonant ladder, filter envelope, accents (!) and slides (~). Write 16-step lines with ! and ~ for the squelch.', opts: { level: 1.5 } },
  'goa-acid': { doc: 'Goa / psytrance acid: high resonance, fast filter decay, strong accents, driven. For 16th-note lines at 140-148 BPM.', opts: { level: 0, cutoff: 420, res: 0.86, envMod: 0.8, decay: 0.19, accent: 0.9, drive: 11, slide: 0.05 } },
  'acid-soft': { doc: 'Gentle acid: less resonance, longer decay, lightly driven (verses, intros, slow builds).', opts: { level: 1.5, cutoff: 520, res: 0.5, envMod: 0.45, decay: 0.45, accent: 0.5, drive: 3 } },
  'acid-square': { doc: 'Hollow, squarer acid.', opts: { level: -0.5, square: 1, cutoff: 460, res: 0.7, envMod: 0.6, decay: 0.3, drive: 6 } },
  'acid-screamer': { doc: 'Wide-open screaming acid for peaks: very high resonance and a big envelope.', opts: { level: -1.5, cutoff: 600, res: 0.93, envMod: 1, decay: 0.22, accent: 1, drive: 16 } },
};
