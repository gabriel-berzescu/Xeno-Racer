/**
 * Transition effects: risers, downlifters and whooshes (swept noise and tones whose length is the length of the note you
 * write), impacts (sub boom + thump + crack) and zaps / sirens. They are one-shots: place a note or a hit and its length in
 * beats sets how long the sweep takes: `riser.hit(30, '', 1, 0, 8)` is an 8-beat riser starting at bar 30.
 */
import { Noise, TAU, clamp, dbToLin, mtof, sinCyc, tanh3 } from '../dsp/core';
import { t60Coef } from '../dsp/env';
import { Svf } from '../dsp/filters';
import { Ctx, FLAG, Instrument, ParamBase, ParamSpecs, PresetDef, pickWord, resolveOpts } from '../instrument';

// ─────────────────────────────────────────────────────────────────────────────
// Riser / downlifter / whoosh
// ─────────────────────────────────────────────────────────────────────────────

export const RISER_SPECS = {
  level: { default: 0, min: -40, max: 12, unit: 'dB', doc: 'Trim in dB on top of the preset\'s calibrated loudness (0 = as calibrated; the fader is the channel\'s `gain` in the mix).' },
  startHz: { default: 220, min: 40, max: 12000, unit: 'Hz', curve: 'exp', doc: 'Centre of the noise band at the start of the sweep.' },
  endHz: { default: 9000, min: 100, max: 18000, unit: 'Hz', curve: 'exp', doc: 'Centre of the noise band at the end of the sweep.' },
  q: { default: 1.6, min: 0.4, max: 10, doc: 'Narrowness of the noise band (higher = more whistle-like).' },
  noise: { default: 0.9, min: 0, max: 1.5, doc: 'Level of the swept noise.' },
  tone: { default: 0.35, min: 0, max: 1.5, doc: 'Level of the pitched sweep (a saw stack rising with the noise).' },
  toneStart: { default: 110, min: 30, max: 4000, unit: 'Hz', curve: 'exp', doc: 'Pitch of the tone at the start.' },
  toneEnd: { default: 1760, min: 60, max: 8000, unit: 'Hz', curve: 'exp', doc: 'Pitch of the tone at the end.' },
  detune: { default: 18, min: 0, max: 60, unit: 'cents', doc: 'Detune of the tone voices (thickness).' },
  width: { default: 1, min: 0, max: 1, doc: 'Stereo width of the noise.' },
  curve: { default: 2, min: 0.5, max: 5, doc: 'Shape of the build: 1 linear, 2 accelerating, higher = most of the rise at the very end.' },
  swell: { default: 2.2, min: 0.5, max: 5, doc: 'Shape of the loudness build (higher = quieter for longer, then a rush).' },
  tail: { default: 30, min: 2, max: 400, unit: 'ms', doc: 'Fade-out at the end of the sweep (short = cut on the downbeat).' },
  drive: { default: 3, min: 0, max: 24, unit: 'dB', doc: 'Saturation.' },
} satisfies ParamSpecs;

export interface RiserOpts {
  preset?: string;
  name?: string;
  /** 'up' (riser), 'down' (downlifter) or 'swell' (whoosh: up then down). */
  direction?: 'up' | 'down' | 'swell';
  [param: string]: unknown;
}

interface RiserVoice {
  on: boolean;
  t: number;
  dur: number;
  g: number;
  fl: Svf;
  fr: Svf;
  tonePh: Float64Array;
  lp: number;
  lpR: number;
}

export class Riser extends ParamBase<typeof RISER_SPECS> implements Instrument {
  readonly stereo = true;
  private readonly voices: RiserVoice[] = [];
  private readonly dir: 'up' | 'down' | 'swell';
  private readonly sr: number;
  private readonly nz: Noise;
  private readonly nzR: Noise;
  constructor(ctx: Ctx, input?: RiserOpts | string) {
    const o = resolveOpts('riser', RISER_PRESETS, input ?? 'riser', RISER_SPECS, ['direction']);
    super('Riser', RISER_SPECS, o);
    this.sr = ctx.sr;
    this.dir = pickWord('riser', 'direction', o.direction, ['up', 'down', 'swell'] as const, 'up');
    this.nz = new Noise(ctx.seed);
    this.nzR = new Noise(ctx.seed ^ 0x6a09e667);
    for (let i = 0; i < 3; i++) this.voices.push({ on: false, t: 0, dur: 1, g: 1, fl: new Svf(), fr: new Svf(), tonePh: new Float64Array(4), lp: 0, lpR: 0 });
  }
  noteOn(_note: number, vel: number, dur: number, flags: number): void {
    this.hit('', vel, dur, flags);
  }
  noteOff(): void {}
  hit(_part: string, vel: number, dur: number, flags: number): void {
    let v = this.voices.find((x) => !x.on);
    if (!v) v = this.voices[0];
    v.on = true;
    v.t = 0;
    v.dur = Math.max(dur, this.sr * 0.15);
    v.g = (flags & FLAG.ACCENT ? 1.15 : 1) * (0.4 + 0.6 * vel);
    v.fl.reset();
    v.fr.reset();
    v.tonePh.fill(0);
    v.lp = 0;
    v.lpR = 0;
  }
  process(l: Float64Array, r: Float64Array, n: number): void {
    const p = this.params;
    const sr = this.sr;
    const out = dbToLin(p.level + (-3));
    const drive = dbToLin(p.drive);
    const norm = 0.8 / tanh3(drive);
    const tailN = (p.tail / 1000) * sr;
    for (const v of this.voices) {
      if (!v.on) continue;
      let t = v.t;
      for (let i = 0; i < n; i += 16) {
        const c1 = Math.min(n, i + 16);
        // progress and sweep position at the start of this chunk
        const x = Math.min(1, t / v.dur);
        let sw: number; // sweep position 0..1 (noise centre / tone pitch)
        let amp: number;
        switch (this.dir) {
          case 'down':
            sw = 1 - Math.pow(x, 1 / p.curve) ;
            amp = Math.pow(1 - x, 1.4);
            break;
          case 'swell': {
            const half = x < 0.5 ? x * 2 : (1 - x) * 2;
            sw = Math.pow(half, 1 / p.curve);
            amp = Math.sin(Math.PI * x);
            amp *= amp;
            break;
          }
          default:
            sw = Math.pow(x, p.curve);
            amp = Math.pow(x, p.swell) * 0.98 + 0.02;
        }
        const fc = p.startHz * Math.pow(p.endHz / p.startHz, sw);
        v.fl.set(fc, p.q, sr);
        v.fr.set(fc * 1.03, p.q, sr);
        const tf = p.toneStart * Math.pow(p.toneEnd / p.toneStart, sw);
        const remain = v.dur - t;
        const endFade = remain < tailN ? Math.max(0, remain / tailN) : 1;
        const startFade = Math.min(1, t / (0.004 * sr));
        const gNoise = p.noise * amp * 1.4;
        const gTone = p.tone * amp * 0.25;
        const w = p.width;
        for (let k = i; k < c1; k++) {
          const nl = this.nz.next();
          const nr = this.nzR.next();
          v.fl.step(nl);
          v.fr.step(nr);
          let a = v.fl.k * v.fl.bp;
          let b = v.fr.k * v.fr.bp;
          // narrow towards mono when width < 1
          const m = (a + b) * 0.5;
          a = m + (a - m) * w;
          b = m + (b - m) * w;
          // pitched component: 4 detuned saws
          let tone = 0;
          for (let q = 0; q < 4; q++) {
            const f = (tf * Math.pow(2, ((q - 1.5) * p.detune) / 1200)) / sr;
            let ph = v.tonePh[q] + f;
            if (ph >= 1) ph -= 1;
            v.tonePh[q] = ph;
            let y = 2 * ph - 1;
            if (ph < f) {
              const xx = ph / f;
              y -= xx + xx - xx * xx - 1;
            } else if (ph > 1 - f) {
              const xx = (ph - 1) / f;
              y -= xx * xx + xx + xx + 1;
            }
            tone += y * 0.25;
          }
          // keep the tone below the noise sweep's brightness
          v.lp += 0.25 * (tone - v.lp);
          const g = v.g * endFade * startFade;
          l[k] += tanh3((a * gNoise + v.lp * gTone * 2) * g * drive) * norm * out;
          r[k] += tanh3((b * gNoise + v.lp * gTone * 2) * g * drive) * norm * out;
          t++;
        }
      }
      v.t = t;
      if (t >= v.dur) v.on = false;
    }
  }
  active(): boolean {
    return this.voices.some((v) => v.on);
  }
}

export const RISER_PRESETS: Record<string, PresetDef> = {
  riser: { doc: 'Classic build-up: swept noise plus a rising tone. The note length is the length of the build (4-16 beats).', opts: { level: 1.5, direction: 'up' } },
  'riser-bright': { doc: 'Higher, whistling riser (narrow band, high start).', opts: { level: 1.5, direction: 'up', startHz: 700, endHz: 14000, q: 4, toneStart: 440, toneEnd: 3520, tone: 0.5 } },
  'riser-dark': { doc: 'Low, rumbling build with a growing tone: darksynth.', opts: { level: 0, direction: 'up', startHz: 90, endHz: 4000, q: 1.2, toneStart: 55, toneEnd: 880, tone: 0.5, drive: 8 } },
  downlifter: { doc: 'Falling sweep that fades away: for after a drop or into a break.', opts: { level: -2, direction: 'down', startHz: 120, endHz: 9000, tone: 0.3 } },
  whoosh: { doc: 'Swell up and back down (transitions between sections).', opts: { level: -6, direction: 'swell', startHz: 200, endHz: 7000, tone: 0.1, q: 1.2 } },
  'noise-wash': { doc: 'Pure noise swell (no tone): drum-roll style build or a big breath.', opts: { level: -2.5, direction: 'up', tone: 0, q: 0.8, startHz: 300, endHz: 12000 } },
};

// ─────────────────────────────────────────────────────────────────────────────
// Impact
// ─────────────────────────────────────────────────────────────────────────────

export const IMPACT_SPECS = {
  level: { default: 0, min: -40, max: 12, unit: 'dB', doc: 'Trim in dB on top of the preset\'s calibrated loudness (0 = as calibrated; the fader is the channel\'s `gain` in the mix).' },
  subHz: { default: 36, min: 20, max: 100, unit: 'Hz', curve: 'exp', doc: 'The pitch the sub boom settles on.' },
  drop: { default: 1.3, min: 0, max: 3, unit: 'octaves', doc: 'How far above `subHz` the boom starts.' },
  decay: { default: 2.2, min: 0.2, max: 6, unit: 's', doc: 'Length of the boom.' },
  thump: { default: 0.8, min: 0, max: 1.5, doc: 'Level of the low noise thump.' },
  crack: { default: 0.5, min: 0, max: 1.5, doc: 'Level of the high crack at the start.' },
  rumble: { default: 0.5, min: 0, max: 1, doc: 'Level of the slow, wide rumble tail.' },
  drive: { default: 8, min: 0, max: 30, unit: 'dB', doc: 'Saturation.' },
} satisfies ParamSpecs;

interface ImpactVoice {
  on: boolean;
  t: number;
  g: number;
  ph: number;
  lpA: number;
  lpB: number;
  lpC: number;
  lpD: number;
  lpE: number;
}

export class Impact extends ParamBase<typeof IMPACT_SPECS> implements Instrument {
  readonly stereo = true;
  private readonly voices: ImpactVoice[] = [];
  private readonly sr: number;
  private readonly nz: Noise;
  private readonly nz2: Noise;
  constructor(ctx: Ctx, input?: Record<string, unknown> | string) {
    const o = resolveOpts('impact', IMPACT_PRESETS, input ?? 'impact', IMPACT_SPECS, []);
    super('Impact', IMPACT_SPECS, o);
    this.sr = ctx.sr;
    this.nz = new Noise(ctx.seed);
    this.nz2 = new Noise(ctx.seed ^ 0x3c6ef372);
    for (let i = 0; i < 2; i++) this.voices.push({ on: false, t: 0, g: 1, ph: 0, lpA: 0, lpB: 0, lpC: 0, lpD: 0, lpE: 0 });
  }
  noteOn(_note: number, vel: number, dur: number, flags: number): void {
    this.hit('', vel, dur, flags);
  }
  noteOff(): void {}
  hit(_part: string, vel: number, _dur: number, flags: number): void {
    let v = this.voices.find((x) => !x.on);
    if (!v) v = this.voices[0];
    v.on = true;
    v.t = 0;
    v.ph = 0;
    v.g = (0.4 + 0.6 * vel) * (flags & FLAG.ACCENT ? 1.15 : 1);
    v.lpA = v.lpB = v.lpC = v.lpD = v.lpE = 0;
  }
  process(l: Float64Array, r: Float64Array, n: number): void {
    const p = this.params;
    const sr = this.sr;
    const out = dbToLin(p.level + (-5));
    const drive = dbToLin(p.drive);
    const norm = 0.85 / tanh3(drive);
    const subK = t60Coef(p.decay, sr);
    const dropK = Math.exp(-1 / (0.18 * sr));
    const thumpK = t60Coef(0.55, sr);
    const crackK = Math.exp(-1 / (0.012 * sr));
    const rumK = t60Coef(p.decay * 0.9, sr);
    const kThump = 1 - Math.exp((-TAU * 450) / sr);
    const kRum = 1 - Math.exp((-TAU * 140) / sr);
    const kCrack = 1 - Math.exp((-TAU * 2800) / sr);
    for (const v of this.voices) {
      if (!v.on) continue;
      let { t, ph, lpA, lpB, lpC, lpD, lpE } = v;
      for (let i = 0; i < n; i++) {
        const ts = t / sr;
        const f = p.subHz * (1 + (Math.pow(2, p.drop) - 1) * Math.exp(-t / (0.18 * sr)));
        ph += f / sr;
        if (ph >= 1) ph -= 1;
        const sub = sinCyc(ph) * Math.pow(subK, t);
        const w1 = this.nz.next();
        const w2 = this.nz2.next();
        lpA += kThump * (w1 - lpA);
        lpB += kThump * (lpA - lpB);
        const thump = lpB * 3.5 * Math.pow(thumpK, t);
        lpC += kCrack * (w1 - lpC);
        const crack = (w1 - lpC) * Math.exp(-t / (0.012 * sr));
        lpD += kRum * (w2 - lpD);
        lpE += kRum * (w1 - lpE);
        const rise = Math.min(1, ts / 0.12);
        const rum = rise * Math.pow(rumK, t);
        const a = sub * 1.1 + thump * p.thump + crack * p.crack * 0.6 + lpD * 7 * rum * p.rumble;
        const b = sub * 1.1 + thump * p.thump + crack * p.crack * 0.6 + lpE * 7 * rum * p.rumble;
        const att = Math.min(1, t / 20);
        l[i] += tanh3(a * v.g * drive * 0.5 * att) * norm * out;
        r[i] += tanh3(b * v.g * drive * 0.5 * att) * norm * out;
        t++;
      }
      v.t = t;
      v.ph = ph;
      v.lpA = lpA;
      v.lpB = lpB;
      v.lpC = lpC;
      v.lpD = lpD;
      v.lpE = lpE;
      if (t > p.decay * sr * 1.3) v.on = false;
    }
    void dropK;
    void crackK;
  }
  active(): boolean {
    return this.voices.some((v) => v.on);
  }
}

export const IMPACT_PRESETS: Record<string, PresetDef> = {
  impact: { doc: 'Big cinematic impact: pitch-dropping sub boom, low thump, crack and a rumbling tail. Land it on the first beat of a drop.', opts: { level: 0 } },
  'impact-short': { doc: 'Tighter impact for fast music.', opts: { level: 0.5, decay: 1.1, drop: 1, thump: 0.9, rumble: 0.25 } },
  'impact-deep': { doc: 'Very low and long, mostly sub.', opts: { level: -0.5, subHz: 30, decay: 3.2, drop: 1.6, crack: 0.2, rumble: 0.7 } },
  boom: { doc: 'Dry boom with no tail: for accents.', opts: { level: 1, decay: 0.7, rumble: 0, crack: 0.3, thump: 1 } },
};

// ─────────────────────────────────────────────────────────────────────────────
// Zap / siren
// ─────────────────────────────────────────────────────────────────────────────

export const ZAP_SPECS = {
  level: { default: 0, min: -40, max: 12, unit: 'dB', doc: 'Trim in dB on top of the preset\'s calibrated loudness (0 = as calibrated; the fader is the channel\'s `gain` in the mix).' },
  startHz: { default: 4000, min: 50, max: 12000, unit: 'Hz', curve: 'exp', doc: 'Pitch at the start.' },
  endHz: { default: 80, min: 20, max: 8000, unit: 'Hz', curve: 'exp', doc: 'Pitch at the end.' },
  time: { default: 0.18, min: 0.02, max: 3, unit: 's', doc: 'Time constant of the pitch move.' },
  decay: { default: 0.35, min: 0.04, max: 4, unit: 's', doc: 'Amplitude decay.' },
  fm: { default: 0, min: 0, max: 12, doc: 'FM amount (metallic / alien).' },
  sirenRate: { default: 0, min: 0, max: 8, unit: 'Hz', doc: 'Siren: pitch wobble speed (0 = off).' },
  sirenDepth: { default: 0, min: 0, max: 24, unit: 'semitones', doc: 'Siren: pitch wobble depth.' },
  drive: { default: 4, min: 0, max: 30, unit: 'dB', doc: 'Saturation.' },
} satisfies ParamSpecs;

export class Zap extends ParamBase<typeof ZAP_SPECS> implements Instrument {
  readonly stereo = false;
  private readonly voices: { on: boolean; t: number; ph: number; mp: number; g: number; hold: number }[] = [];
  private readonly sr: number;
  private readonly wave: 'saw' | 'sine' | 'square';
  constructor(ctx: Ctx, input?: (Record<string, unknown> & { wave?: 'saw' | 'sine' | 'square' }) | string) {
    const o = resolveOpts('zap', ZAP_PRESETS, input ?? 'zap', ZAP_SPECS, ['wave']);
    super('Zap', ZAP_SPECS, o);
    this.sr = ctx.sr;
    this.wave = pickWord('zap', 'wave', o.wave, ['saw', 'sine', 'square'] as const, 'saw');
    for (let i = 0; i < 3; i++) this.voices.push({ on: false, t: 0, ph: 0, mp: 0, g: 1, hold: 0 });
  }
  noteOn(_note: number, vel: number, dur: number, flags: number): void {
    this.hit('', vel, dur, flags);
  }
  noteOff(): void {}
  hit(_part: string, vel: number, dur: number, _flags: number): void {
    let v = this.voices.find((x) => !x.on);
    if (!v) v = this.voices[0];
    v.on = true;
    v.t = 0;
    v.ph = 0;
    v.mp = 0;
    v.g = 0.4 + 0.6 * vel;
    v.hold = dur;
  }
  process(l: Float64Array, _r: Float64Array, n: number): void {
    const p = this.params;
    const sr = this.sr;
    const out = dbToLin(p.level + (-9));
    const drive = dbToLin(p.drive);
    const norm = 0.8 / tanh3(drive);
    const aK = t60Coef(p.decay, sr);
    for (const v of this.voices) {
      if (!v.on) continue;
      let { t, ph, mp } = v;
      for (let i = 0; i < n; i++) {
        const ts = t / sr;
        let f = p.endHz + (p.startHz - p.endHz) * Math.exp(-ts / p.time);
        if (p.sirenRate > 0) f *= Math.pow(2, (p.sirenDepth * sinCyc((ts * p.sirenRate) % 1)) / 12);
        const dt = clamp(f / sr, 0, 0.45);
        ph += dt;
        if (ph >= 1) ph -= 1;
        let y: number;
        if (p.fm > 0) {
          mp += dt * 1.5;
          if (mp >= 1) mp -= 1;
          let x = ph + (p.fm / TAU) * sinCyc(mp) * Math.exp(-ts / 0.2);
          x -= Math.floor(x);
          y = sinCyc(x);
        } else if (this.wave === 'sine') y = sinCyc(ph);
        else if (this.wave === 'square') {
          y = ph < 0.5 ? 1 : -1;
          y *= 0.6;
        } else {
          y = 2 * ph - 1;
          if (ph < dt) {
            const xx = ph / dt;
            y -= xx + xx - xx * xx - 1;
          } else if (ph > 1 - dt) {
            const xx = (ph - 1) / dt;
            y -= xx * xx + xx + xx + 1;
          }
        }
        const a = Math.pow(aK, t) * Math.min(1, t / 40);
        l[i] += tanh3(y * a * v.g * drive * 0.7) * norm * out;
        t++;
      }
      v.t = t;
      v.ph = ph;
      v.mp = mp;
      if (Math.pow(aK, t) < 5e-4) v.on = false;
    }
  }
  active(): boolean {
    return this.voices.some((v) => v.on);
  }
}

export const ZAP_PRESETS: Record<string, PresetDef> = {
  zap: { doc: 'Laser zap: a fast falling saw.', opts: { level: 0.5, wave: 'saw' } },
  'zap-fm': { doc: 'Alien FM zap.', opts: { level: -0.5, wave: 'sine', fm: 6, startHz: 2400, endHz: 120, time: 0.25, decay: 0.5 } },
  siren: { doc: 'Wailing siren (long notes): a held pitch with a slow wobble.', opts: { level: -4, wave: 'saw', startHz: 700, endHz: 700, sirenRate: 0.7, sirenDepth: 7, decay: 4, time: 0.05, drive: 8 } },
  'pitch-fall': { doc: 'A long falling tone (tape-stop feel).', opts: { level: 1.5, wave: 'sine', startHz: 1200, endHz: 40, time: 0.8, decay: 1.4, drive: 2 } },
};

void mtof;
