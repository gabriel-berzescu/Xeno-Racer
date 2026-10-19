/**
 * How to make a mono growl wide without touching its mono sum or its lows: the side signal is the growl above `widthFreq` (a
 * Linkwitz-Riley 4th-order high-pass) decorrelated from itself, L = growl + w * S and R = growl - w * S. This script builds several
 * decorrelators, runs them on real growls and measures what each does, band by band: the side-to-mid ratio, the correlation of L and R,
 * the largest cross-correlation within +-1 ms (a decorrelator that leaves a sharp peak there sounds like a delay, not like width), how
 * much each side's spectrum is coloured against the mono growl (the comb filtering that any L = M + S sum has), the cost, and the mono sum.
 *
 *   node sandbox/album/run.mjs sandbox/album/lab/growl-width-lab.ts            the candidates
 *   node sandbox/album/run.mjs sandbox/album/lab/growl-width-lab.ts final      the growl as built (width 1, 0.5 and 0)
 */
import { Biquad } from '../../../src/audio/album/dsp/filters';
import { AllpassDelay, DelayLine } from '../../../src/audio/album/dsp/delay';
import { Rng, sinCyc } from '../../../src/audio/album/dsp/core';
import { fft, hann } from '../../../src/audio/analysis';
import { GrowlBass } from '../../../src/audio/album/instruments/bass';
import type { ScriptEvent } from './golden-renders';
import { makeCtx, playScript } from './golden-renders';

const SR = 48000;
const BPM = 140;

// ── material ─────────────────────────────────────────────────────────────────────────────────────────────

function notes(list: [number, number][], vel = 0.9): ScriptEvent[] {
  const ev: ScriptEvent[] = [];
  let beat = 0;
  for (const [note, beats] of list) {
    ev.push({ beat, kind: 'on', note, vel }, { beat: beat + beats - 0.05, kind: 'off', note });
    beat += beats;
  }
  return ev;
}
const LOW_LINE = notes([[29, 2], [33, 2], [36, 1], [38, 1], [41, 2], [33, 2], [29, 2], [31, 2], [36, 2], [34, 2]]); // F1 A1 C2 D2 F2 A1 F1 G1 C2 Bb1
const HIGH_LINE = notes([[48, 2], [52, 2], [55, 1], [57, 1], [60, 2], [55, 2], [52, 2], [48, 2]]); // C3 E3 G3 A3 C4 G3 E3 C3

export interface Material {
  name: string;
  x: Float64Array;
  opts: Record<string, unknown>;
  line: ScriptEvent[];
  seconds: number;
}

export function material(): Material[] {
  const out: Material[] = [];
  for (const [name, opts, line] of [
    ['dubstep-growl', { preset: 'dubstep-growl' }, LOW_LINE],
    ['wub', { preset: 'wub' }, LOW_LINE],
    ['yoi', { preset: 'yoi' }, LOW_LINE],
    ['riddim', { preset: 'riddim' }, LOW_LINE],
    ['screech', { preset: 'screech' }, HIGH_LINE],
  ] as [string, Record<string, unknown>, ScriptEvent[]][]) {
    const ctx = makeCtx(SR, BPM);
    const g = new GrowlBass(ctx, opts as never);
    const seconds = 10 * (60 / BPM) * 2 + 0.3;
    out.push({ name, x: playScript(g, ctx, line, seconds).l, opts, line, seconds });
  }
  return out;
}

// ── measuring ────────────────────────────────────────────────────────────────────────────────────────────

/** A 4th-order Butterworth band-pass (two 4th-order sections), for measuring only. */
function band(x: Float64Array, lo: number, hi: number): Float64Array {
  const y = Float64Array.from(x);
  const q = [0.5411961, 1.306563];
  if (lo > 0) for (const qq of q) new Biquad().highpass(lo, qq, SR).block(y, y.length);
  if (hi < SR / 2) for (const qq of q) new Biquad().lowpass(hi, qq, SR).block(y, y.length);
  return y;
}
// the Biquad objects above are one-shot, so block() on a fresh object is fine; but a section must keep its state across the whole signal:
function bandFiltered(x: Float64Array, lo: number, hi: number): Float64Array {
  const y = Float64Array.from(x);
  const q = [0.5411961, 1.306563, 0.5411961, 1.306563]; // 8th order edges: the skirts of a gentler filter would let the neighbouring band's side into a band of the low end
  const stages: Biquad[] = [];
  if (lo > 0) for (const qq of q) stages.push(new Biquad().highpass(lo, qq, SR));
  if (hi < SR / 2) for (const qq of q) stages.push(new Biquad().lowpass(hi, qq, SR));
  for (const s of stages) s.block(y, y.length);
  return y;
}
void band;

export interface BandStat {
  sideMidDb: number;
  corr: number;
}
export function bandStat(l: Float64Array, r: Float64Array, lo: number, hi: number, from = 0): BandStat {
  const a = bandFiltered(l, lo, hi);
  const b = bandFiltered(r, lo, hi);
  let ll = 0;
  let rr = 0;
  let lr = 0;
  let mm = 0;
  let ss = 0;
  for (let i = from; i < a.length; i++) {
    ll += a[i] * a[i];
    rr += b[i] * b[i];
    lr += a[i] * b[i];
    const m = (a[i] + b[i]) * 0.5;
    const s = (a[i] - b[i]) * 0.5;
    mm += m * m;
    ss += s * s;
  }
  return { sideMidDb: 10 * Math.log10((ss + 1e-30) / (mm + 1e-30)), corr: lr / Math.sqrt(ll * rr + 1e-30) };
}

/** Largest |normalised cross-correlation| of the two band-limited channels within +-1 ms. */
export function maxXcorr(l: Float64Array, r: Float64Array, lo: number, hi: number): number {
  const a = bandFiltered(l, lo, hi);
  const b = bandFiltered(r, lo, hi);
  const lag = Math.round(0.001 * SR);
  let ea = 0;
  let eb = 0;
  for (let i = 0; i < a.length; i++) {
    ea += a[i] * a[i];
    eb += b[i] * b[i];
  }
  let best = 0;
  for (let d = -lag; d <= lag; d++) {
    let s = 0;
    for (let i = Math.max(0, d); i < Math.min(a.length, a.length + d); i++) s += a[i] * b[i - d];
    best = Math.max(best, Math.abs(s) / Math.sqrt(ea * eb + 1e-30));
  }
  return best;
}

/**
 * How much a side's spectrum differs from the mono growl's, in dB, over the steady stretches of a growl: for windows of 0.25 s the
 * magnitudes at the growl's harmonics (k * f0 between 200 Hz and 8 kHz) of L against the same of the mono growl. Returns the mean
 * standard deviation over the windows and the largest |dB| seen: the comb filtering of L = M + w S, which is the price of any width
 * made by adding a decorrelated copy to one side and taking it from the other.
 */
export function colouration(mono: Float64Array, l: Float64Array, r: Float64Array, f0: number, from: number, to: number): { std: number; worst: number; ildMean: number; ildStd: number } {
  const N = 4096;
  const win = hann(N);
  const df = SR / N;
  const stds: number[] = [];
  const ilds: number[] = [];
  let worst = 0;
  for (let s = from; s + N <= to; s += N / 2) {
    const mag = (x: Float64Array): Float64Array => {
      const re = new Float64Array(N);
      const im = new Float64Array(N);
      for (let i = 0; i < N; i++) re[i] = x[s + i] * win[i];
      fft(re, im);
      const m = new Float64Array(N / 2);
      for (let i = 0; i < N / 2; i++) m[i] = Math.hypot(re[i], im[i]);
      return m;
    };
    const mm = mag(mono);
    const ml = mag(l);
    const mr = mag(r);
    let top = 0;
    for (const v of mm) top = Math.max(top, v);
    const d: number[] = [];
    for (let k = Math.ceil(200 / f0); k * f0 < 8000; k++) {
      const b = Math.round((k * f0) / df);
      let pm = 0;
      let pl = 0;
      let pr = 0;
      for (let j = b - 2; j <= b + 2; j++) {
        pm = Math.max(pm, mm[j]);
        pl = Math.max(pl, ml[j]);
        pr = Math.max(pr, mr[j]);
      }
      if (pm > top * 0.01) {
        d.push(20 * Math.log10(pl / pm));
        ilds.push(20 * Math.log10(pl / pr));
      }
    }
    if (d.length < 5) continue;
    const mean = d.reduce((p, v) => p + v, 0) / d.length;
    stds.push(Math.sqrt(d.reduce((p, v) => p + (v - mean) * (v - mean), 0) / d.length));
    for (const v of d) worst = Math.max(worst, Math.abs(v));
  }
  const im = ilds.reduce((p, v) => p + v, 0) / Math.max(1, ilds.length);
  return {
    std: stds.reduce((p, v) => p + v, 0) / Math.max(1, stds.length),
    worst,
    ildMean: im,
    ildStd: Math.sqrt(ilds.reduce((p, v) => p + (v - im) * (v - im), 0) / Math.max(1, ilds.length)),
  };
}

// ── the crossover and the decorrelators ───────────────────────────────────────────────────────────────────

/**
 * The high-pass half of a Linkwitz-Riley crossover: 4th order is two Butterworth 2nd-order high-passes in series (-6 dB at fc, 24 dB/oct),
 * 8th order is a Butterworth 4th-order pair in series (-6 dB at fc, 48 dB/oct).
 */
export class Lr4High {
  private readonly stages: Biquad[] = [];
  constructor(fc: number, sr: number, order: 4 | 8 = 4) {
    const qs = order === 4 ? [Math.SQRT1_2, Math.SQRT1_2] : [0.5411961, 1.306563, 0.5411961, 1.306563];
    for (const q of qs) this.stages.push(new Biquad().highpass(fc, q, sr));
  }
  process(x: number): number {
    for (const s of this.stages) x = s.process(x);
    return x;
  }
}

export interface Decorrelator {
  process(x: number): number;
}

/** One tap of a delay that is modulated slowly (chorus-style): the side is the high band 10 ms later, drifting by a couple of ms. */
class ModDelay implements Decorrelator {
  private readonly line = new DelayLine(2048);
  private ph = 0;
  constructor(
    private readonly baseMs: number,
    private readonly depthMs: number,
    private readonly rate: number,
  ) {}
  process(x: number): number {
    this.line.write(x);
    this.ph += this.rate / SR;
    if (this.ph >= 1) this.ph -= 1;
    const d = ((this.baseMs + this.depthMs * sinCyc(this.ph)) * SR) / 1000;
    return this.line.tapCubic(Math.max(1, d));
  }
}

/** A chain of second-order all-passes at staggered frequencies: no delay line, a static phase response that winds through the band. */
class AllpassChain implements Decorrelator {
  private readonly stages: Biquad[] = [];
  constructor(freqs: number[], q: number) {
    for (const f of freqs) this.stages.push(new Biquad().allpass(f, q, SR));
  }
  process(x: number): number {
    for (const s of this.stages) x = s.process(x);
    return x;
  }
}

/** Schroeder all-pass sections with delay lines (the reverb's diffusers): the side is smeared over some ten milliseconds. */
class SchroederChain implements Decorrelator {
  private readonly stages: AllpassDelay[] = [];
  constructor(msList: number[], g: number) {
    for (const ms of msList) this.stages.push(new AllpassDelay((ms * SR) / 1000, g));
  }
  process(x: number): number {
    for (const s of this.stages) x = s.process(x);
    return x;
  }
}

/** A sparse random-sign FIR ("velvet noise") with an exponentially falling envelope, normalised to unit energy. */
class VelvetFir implements Decorrelator {
  private readonly line = new DelayLine(4096);
  private readonly pos: number[] = [];
  private readonly amp: number[] = [];
  constructor(taps: number, ms: number, seed: number) {
    const rng = new Rng(seed);
    const n = Math.round((ms * SR) / 1000);
    let e = 0;
    for (let k = 0; k < taps; k++) {
      const p = Math.round(((k + 0.15 + 0.7 * rng.next()) * n) / taps);
      const a = (rng.next() < 0.5 ? -1 : 1) * Math.exp((-3 * p) / n);
      this.pos.push(p);
      this.amp.push(a);
      e += a * a;
    }
    const norm = 1 / Math.sqrt(e);
    for (let k = 0; k < taps; k++) this.amp[k] *= norm;
  }
  process(x: number): number {
    this.line.write(x);
    let y = 0;
    for (let k = 0; k < this.pos.length; k++) y += this.amp[k] * this.line.tap(this.pos[k]);
    return y;
  }
}

export interface Candidate {
  name: string;
  make(): Decorrelator;
}

export const CANDIDATES: Candidate[] = [
  { name: 'mod delay 10 ms +-2 ms, 0.35 Hz', make: () => new ModDelay(10, 2, 0.35) },
  { name: 'mod delay 7 ms +-1.5 ms, 0.6 Hz', make: () => new ModDelay(7, 1.5, 0.6) },
  { name: 'all-pass chain, 7 x Q 1.2, 250..6k', make: () => new AllpassChain([250, 420, 700, 1150, 1900, 3100, 5200], 1.2) },
  { name: 'all-pass chain, 8 x Q 3, 200..7k', make: () => new AllpassChain([200, 330, 540, 880, 1450, 2400, 3900, 6400], 3) },
  { name: 'schroeder 4 x (1.1 1.9 3.3 5.3 ms) g .6', make: () => new SchroederChain([1.1, 1.9, 3.3, 5.3], 0.6) },
  { name: 'schroeder 5 x (0.9 1.7 2.9 4.7 7.1 ms) g .55', make: () => new SchroederChain([0.9, 1.7, 2.9, 4.7, 7.1], 0.55) },
  { name: 'schroeder 3 x (1.7 2.9 4.7 ms) g .65', make: () => new SchroederChain([1.7, 2.9, 4.7], 0.65) },
  { name: 'schroeder 2 x (2.3 4.1 ms) g .7', make: () => new SchroederChain([2.3, 4.1], 0.7) },
  { name: 'velvet fir 24 taps / 14 ms', make: () => new VelvetFir(24, 14, 7) },
  { name: 'velvet fir 40 taps / 20 ms', make: () => new VelvetFir(40, 20, 11) },
];

// ── the run ──────────────────────────────────────────────────────────────────────────────────────────────

const BANDS: [string, number, number][] = [
  ['<120', 20, 120],
  ['120-200', 120, 200],
  ['200-400', 200, 400],
  ['400-800', 400, 800],
  ['.8-1.6k', 800, 1600],
  ['1.6-3.2k', 1600, 3200],
  ['3.2-6.4k', 3200, 6400],
  ['6.4-12k', 6400, 12000],
];

export function widen(x: Float64Array, make: () => Decorrelator, widthFreq: number, w: number, sideGain: number, order: 4 | 8 = 4): { l: Float64Array; r: Float64Array } {
  const hp = new Lr4High(widthFreq, SR, order);
  const d = make();
  const l = new Float64Array(x.length);
  const r = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const s = d.process(hp.process(x[i])) * sideGain * w;
    l[i] = x[i] + s;
    r[i] = x[i] - s;
  }
  return { l, r };
}

function report(label: string, mats: Material[], build: (x: Float64Array, m: Material) => { l: Float64Array; r: Float64Array }): void {
  const acc: BandStat[] = BANDS.map(() => ({ sideMidDb: 0, corr: 0 }));
  let high = { sideMidDb: 0, corr: 0 };
  let xc = 0;
  let col = 0;
  let colWorst = 0;
  let monoErr = 0;
  let all = { sideMidDb: 0, corr: 0 };
  let ildMean = 0;
  let ildStd = 0;
  let peakGrow = 0;
  let rmsGrow = 0;
  let balance = 0;
  for (const m of mats) {
    const { l, r } = build(m.x, m);
    BANDS.forEach(([, lo, hi], i) => {
      const s = bandStat(l, r, lo, hi);
      acc[i].sideMidDb += s.sideMidDb / mats.length;
      acc[i].corr += s.corr / mats.length;
    });
    const h = bandStat(l, r, 200, 16000);
    high = { sideMidDb: high.sideMidDb + h.sideMidDb / mats.length, corr: high.corr + h.corr / mats.length };
    const a = bandStat(l, r, 0, SR);
    all = { sideMidDb: all.sideMidDb + a.sideMidDb / mats.length, corr: all.corr + a.corr / mats.length };
    xc += maxXcorr(l, r, 200, 16000) / mats.length;
    for (let i = 0; i < l.length; i++) monoErr = Math.max(monoErr, Math.abs((l[i] + r[i]) * 0.5 - m.x[i]));
    // the colouration: a steady stretch of a note (the second note of the line, 2 beats of F1 .. A1: f0 of A1 = 55 Hz), measured on the whole material's harmonics
    const c = colouration(m.x, l, r, 55, Math.round(1.0 * SR), Math.round(1.8 * SR));
    col += c.std / mats.length;
    colWorst = Math.max(colWorst, c.worst);
    ildMean += c.ildMean / mats.length;
    ildStd += c.ildStd / mats.length;
    let pm = 0;
    let pl = 0;
    let em = 0;
    let el = 0;
    let er = 0;
    for (let i = 0; i < l.length; i++) {
      pm = Math.max(pm, Math.abs(m.x[i]));
      pl = Math.max(pl, Math.abs(l[i]), Math.abs(r[i]));
      em += m.x[i] * m.x[i];
      el += l[i] * l[i];
      er += r[i] * r[i];
    }
    peakGrow += (20 * Math.log10(pl / pm)) / mats.length;
    rmsGrow += (10 * Math.log10((el + er) / 2 / em)) / mats.length;
    balance += (10 * Math.log10(el / er)) / mats.length;
  }
  const f = (v: number): string => v.toFixed(1).padStart(6);
  process.stdout.write(
    `${label.padEnd(46)} side/mid dB by band ${acc.map((b) => f(b.sideMidDb)).join('')} | >200 Hz ${f(high.sideMidDb)} | whole ${f(all.sideMidDb)}\n` +
      `${''.padEnd(46)} correlation       ${acc.map((b) => b.corr.toFixed(3).padStart(6)).join('')} | >200 Hz ${high.corr.toFixed(3).padStart(6)} | whole ${all.corr.toFixed(3)}\n` +
      `${''.padEnd(46)} max xcorr within 1 ms (>200 Hz) ${xc.toFixed(3)}; colouration of a side: harmonics ${col.toFixed(1)} dB std, up to ${colWorst.toFixed(1)} dB; L/R level difference of a harmonic: mean ${ildMean.toFixed(2)} dB, spread ${ildStd.toFixed(1)} dB\n` +
      `${''.padEnd(46)} each side against the mono growl: peak ${peakGrow >= 0 ? '+' : ''}${peakGrow.toFixed(1)} dB, rms ${rmsGrow >= 0 ? '+' : ''}${rmsGrow.toFixed(1)} dB; L against R over the whole growl ${balance.toFixed(2)} dB; mono sum error ${monoErr.toExponential(1)}\n`,
  );
}

if (typeof process !== 'undefined' && process.argv[1] && /growl-width-lab/.test(process.argv[1])) {
  const mats = material();
  const order: 4 | 8 = process.argv.includes('lr8') ? 8 : 4;
  process.stdout.write(`crossover: Linkwitz-Riley ${order}th order at 200 Hz\n`);
  process.stdout.write(`material: ${mats.map((m) => m.name).join(', ')}, ${(mats[0].x.length / SR).toFixed(1)} s each; band columns: ${BANDS.map(([n]) => n).join('  ')}\n\n`);
  if (process.argv[2] === 'final') {
    for (const w of [1, 0.5, 0]) {
      report(`growl as built, width ${w}`, mats, (_x, m) => {
        const ctx = makeCtx(SR, BPM);
        const g = new GrowlBass(ctx, { ...m.opts, width: w } as never);
        const { l, r } = playScript(g, ctx, m.line, m.seconds);
        return { l, r };
      });
    }
    // the low end finely, at width 1: correlation and side/mid in bands that end where the side begins
    process.stdout.write('\nlow end at width 1 (steep 8th-order band edges):\n');
    for (const [lo, hi] of [[20, 60], [60, 90], [90, 120], [20, 120], [120, 160], [160, 200]] as const) {
      let c = 0;
      let d = 0;
      for (const m of mats) {
        const ctx = makeCtx(SR, BPM);
        const g = new GrowlBass(ctx, { ...m.opts, width: 1 } as never);
        const { l, r } = playScript(g, ctx, m.line, m.seconds);
        const b = bandStat(l, r, lo, hi);
        c += b.corr / mats.length;
        d += b.sideMidDb / mats.length;
      }
      process.stdout.write(`  ${String(lo).padStart(3)}-${String(hi).padEnd(3)} Hz: correlation ${c.toFixed(4)}, side/mid ${d.toFixed(1)} dB\n`);
    }
    // cost: the growl alone against the growl with a width, a held note, best of 7
    process.stdout.write('\ncost, ms per second of audio (a held note, best of 7):\n');
    for (const [label, extra] of [['mono growl', {}], ['stereo growl, width 0', { width: 0 }], ['stereo growl, width 1', { width: 1 }], ['mono growl + pEnv', { pEnv: 12 }]] as const) {
      for (const preset of ['dubstep-growl', 'neuro']) {
        let best = Infinity;
        for (let rep = 0; rep < 7; rep++) {
          const ctx = makeCtx(SR, BPM);
          const g = new GrowlBass(ctx, { preset, ...extra } as never);
          g.noteOn(33, 0.9, 0, 0);
          const l = new Float64Array(64);
          const r = new Float64Array(64);
          const seconds = 6;
          const blocks = (seconds * SR) / 64;
          for (let b = 0; b < 300; b++) g.process(l, r, 64);
          const t0 = performance.now();
          for (let b = 0; b < blocks; b++) {
            ctx.transport.beat = (b * 64) / ((SR * 60) / BPM);
            l.fill(0);
            r.fill(0);
            g.process(l, r, 64);
          }
          best = Math.min(best, (performance.now() - t0) / seconds);
        }
        process.stdout.write(`  ${label.padEnd(24)} ${preset.padEnd(14)} ${best.toFixed(2)} ms/s\n`);
      }
    }
  } else {
    // each candidate gets the side gain that puts the side at -4.5 dB against the mid above 200 Hz at w = 1
    for (const c of CANDIDATES) {
      // calibrate on the first material
      const m0 = mats[0].x;
      const base = widen(m0, c.make, 200, 1, 1, order);
      const probe = bandStat(base.l, base.r, 200, 16000);
      const gain = Math.pow(10, (-4.5 - probe.sideMidDb) / 20);
      report(`${c.name} (gain ${gain.toFixed(2)})`, mats, (x) => widen(x, c.make, 200, 1, gain, order));
    }
    // cost: milliseconds per second of audio for the crossover plus the decorrelator
    process.stdout.write('\ncost of the high-pass + decorrelator + sums, ms per second of audio (best of 5):\n');
    const x = mats[0].x;
    for (const c of CANDIDATES) {
      let best = Infinity;
      for (let rep = 0; rep < 5; rep++) {
        const hp = new Lr4High(200, SR, order);
        const d = c.make();
        const l = new Float64Array(64);
        const r = new Float64Array(64);
        const t0 = performance.now();
        for (let o = 0; o + 64 <= x.length; o += 64) {
          for (let i = 0; i < 64; i++) {
            const m = x[o + i];
            const s = d.process(hp.process(m)) * 0.5;
            l[i] = m + s;
            r[i] = m - s;
          }
        }
        best = Math.min(best, (performance.now() - t0) / (x.length / SR));
      }
      process.stdout.write(`  ${c.name.padEnd(48)} ${best.toFixed(2)} ms/s\n`);
    }
  }
}
