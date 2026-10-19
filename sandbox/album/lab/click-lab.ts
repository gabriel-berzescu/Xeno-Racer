/**
 * Measures the synth's attack click (click, clickDecay, clickTone, clickKeytrack): where its spectrum sits, how fast it dies, how loud it is
 * next to the body of the presets, that it survives a dark filter and a slow attack, where it starts, and what it costs.
 *   node sandbox/album/run.mjs sandbox/album/lab/click-lab.ts
 */
import { Synth } from '../../../src/audio/album/instruments/synth';
import type { SynthOpts } from '../../../src/audio/album/instruments/synth';
import { welch } from '../../../src/audio/analysis';
import type { ScriptEvent } from './golden-renders';
import { makeCtx, playScript } from './golden-renders';

const SR = 48000;
const BPM = 120;

/** A synth with no oscillator output at all: what it plays is the click alone. */
export const CLICK_ONLY: SynthOpts = { layers: [{ wave: 'sine', level: 0 }], filter: 'off', mono: true, attack: 0.001, sustain: 1, release: 0.01, voices: 4 };

/** `count` notes of one pitch, half a beat apart (the click noise is different in every one). */
export function repeated(note: number, count: number, vel = 0.8, spacing = 0.5): ScriptEvent[] {
  const ev: ScriptEvent[] = [];
  for (let i = 0; i < count; i++) ev.push({ beat: i * spacing, kind: 'on', note, vel }, { beat: i * spacing + spacing * 0.5, kind: 'off', note });
  return ev;
}

/**
 * The centre of the band-pass a noise burst went through. The power spectral density (per Hz, averaged over all the bursts of the signal) is
 * smoothed over a sixth of an octave; its peak is the centre, and so is the geometric mean of the two half-power points (a band-pass of
 * constant Q is symmetric in log frequency, so the two agree).
 */
export function spectrumCentre(x: ArrayLike<number>): { peak: number; geo: number } {
  const nfft = 4096;
  const psd = welch(x, nfft);
  const df = SR / nfft;
  const sm = new Float64Array(psd.length);
  for (let i = 1; i < psd.length; i++) {
    const w = Math.max(1, Math.round(i * 0.08));
    let a = 0;
    let n = 0;
    for (let j = Math.max(1, i - w); j <= Math.min(psd.length - 1, i + w); j++) {
      a += psd[j];
      n++;
    }
    sm[i] = a / n;
  }
  let best = 2;
  for (let i = 3; i < psd.length; i++) if (sm[i] > sm[best]) best = i;
  const half = sm[best] / 2;
  let lo = best;
  while (lo > 1 && sm[lo] > half) lo--;
  let hi = best;
  while (hi < psd.length - 1 && sm[hi] > half) hi++;
  return { peak: best * df, geo: Math.sqrt(lo * df * hi * df) };
}

export function clickAlone(opts: Record<string, unknown>, note: number, count = 40, vel = 0.8): Float64Array {
  const ctx = makeCtx(SR, BPM);
  const s = new Synth(ctx, { ...CLICK_ONLY, click: 1, ...opts } as SynthOpts);
  return playScript(s, ctx, repeated(note, count, vel), count * 0.25 + 0.3).l;
}

export function rmsOf(x: ArrayLike<number>, a: number, b: number): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-12));

if (typeof process !== 'undefined' && process.argv[1] && /click-lab/.test(process.argv[1])) {
  process.stdout.write('where the click sits: the spectrum of 40 clicks, against clickTone * 2^(keytrack * (note - 60) / 12)\n');
  for (const [tone, key, note] of [[2500, 0.5, 60], [2500, 0.5, 48], [2500, 0.5, 84], [2500, 0, 84], [2500, 1, 72], [800, 0.5, 60], [6000, 0.5, 60], [6000, 1, 72], [400, 0, 60], [10000, 0, 60]] as const) {
    const x = clickAlone({ clickTone: tone, clickKeytrack: key }, note);
    const want = tone * Math.pow(2, (key * (note - 60)) / 12);
    const c = spectrumCentre(x);
    process.stdout.write(
      `  clickTone ${String(tone).padStart(5)} Hz, keytrack ${key}, note ${note}: wanted ${want.toFixed(0).padStart(5)} Hz; peak of the spectrum ${c.peak.toFixed(0).padStart(5)} Hz (${(1200 * Math.log2(c.peak / want)).toFixed(0).padStart(4)} cents), geometric mean of the half-power points ${c.geo.toFixed(0).padStart(5)} Hz (${(1200 * Math.log2(c.geo / want)).toFixed(0).padStart(4)} cents)\n`,
    );
  }

  process.stdout.write('\nhow it dies: rms in 1 ms windows, the time to fall 20 dB and 40 dB below the first millisecond (averaged over 40 notes), against ln(10) * tau and 2 ln(10) * tau\n');
  for (const tau of [0.003, 0.012, 0.05]) {
    const x = clickAlone({ clickDecay: tau }, 60);
    const win = Math.round(0.001 * SR);
    const hop = Math.round(0.25 * SR);
    const env: number[] = [];
    for (let w = 0; w < 400; w++) {
      let e = 0;
      for (let k = 0; k < 40; k++) e += Math.pow(rmsOf(x, k * hop + w * win, k * hop + (w + 1) * win), 2);
      env.push(Math.sqrt(e / 40));
    }
    const t20 = env.findIndex((v) => v < env[0] * 0.1);
    const t40 = env.findIndex((v) => v < env[0] * 0.01);
    process.stdout.write(`  tau ${tau} s: -20 dB after ${t20} ms (wanted ${(Math.LN10 * tau * 1000).toFixed(1)}), -40 dB after ${t40} ms (wanted ${(2 * Math.LN10 * tau * 1000).toFixed(1)})\n`);
  }

  process.stdout.write('\nhow loud: rms of the click alone (click 1, velocity 0.8) against the rms of the body of the same note without it, in the first 3 ms / 3 to 15 ms / 15 to 60 ms (dB)\n');
  const presets = ['pluck', 'dark-pluck', 'trance-pluck', 'arp-bright', 'fm-epiano', 'fm-bell', 'supersaw-chord', 'brass-stab', 'warm-pad', 'organ', 'saw-lead'];
  for (const preset of presets) {
    const ctx = makeCtx(SR, BPM);
    const body = playScript(new Synth(ctx, preset), ctx, [{ beat: 0, kind: 'on', note: 60, vel: 0.8 }, { beat: 2, kind: 'off', note: 60 }], 1).l;
    const ctx2 = makeCtx(SR, BPM);
    const both = playScript(new Synth(ctx2, { preset, click: 1 } as SynthOpts), ctx2, [{ beat: 0, kind: 'on', note: 60, vel: 0.8 }, { beat: 2, kind: 'off', note: 60 }], 1).l;
    const click = both.map((v, i) => v - body[i]);
    const row: string[] = [];
    for (const [a, b] of [[0, 0.003], [0.003, 0.015], [0.015, 0.06]]) {
      const ia = Math.round(a * SR);
      const ib = Math.round(b * SR);
      row.push(`${(db(rmsOf(click, ia, ib)) - db(rmsOf(body, ia, ib))).toFixed(1).padStart(6)}`);
    }
    process.stdout.write(`  ${preset.padEnd(16)} ${row.join(' ')}   (body rms in the first 3 ms ${db(rmsOf(body, 0, Math.round(0.003 * SR))).toFixed(1)} dB, whole note ${db(rmsOf(body, 0, SR)).toFixed(1)} dB)\n`);
  }

  process.stdout.write('\na dark patch and a slow attack: rms above 2 kHz (a crude high-pass) in the first 30 ms with and without the click\n');
  const hpRms = (x: Float64Array, a: number, b: number): number => {
    const y = new Float64Array(x.length);
    for (let i = 2; i < x.length; i++) y[i] = x[i] - 2 * x[i - 1] + x[i - 2];
    return rmsOf(y, a, b);
  };
  for (const [label, opts] of [
    ['dark pluck (cutoff 150 Hz, no filter envelope)', { preset: 'pluck', cutoff: 150, envAmt: 0, keytrack: 0, velFilter: 0 }],
    ['pad with a 0.7 s attack', { preset: 'warm-pad', attack: 0.7 }],
  ] as [string, SynthOpts][]) {
    const run = (click: number): Float64Array => {
      const ctx = makeCtx(SR, BPM);
      return playScript(new Synth(ctx, { ...opts, click } as SynthOpts), ctx, [{ beat: 0, kind: 'on', note: 60, vel: 0.8 }, { beat: 2, kind: 'off', note: 60 }], 1).l;
    };
    const off = run(0);
    const on = run(0.6);
    const w = Math.round(0.03 * SR);
    process.stdout.write(`  ${label.padEnd(48)} without ${db(hpRms(off, 0, w)).toFixed(1)} dB, with ${db(hpRms(on, 0, w)).toFixed(1)} dB; whole signal rms in the first 3 ms ${db(rmsOf(off, 0, 144)).toFixed(1)} -> ${db(rmsOf(on, 0, 144)).toFixed(1)} dB\n`);
  }

  process.stdout.write('\nwhere it starts: the first sample of the click against the frame of the note, at 137 BPM (the frames are rounded as the engine does)\n');
  {
    const ctx = makeCtx(SR, 137);
    const fpb = (SR * 60) / 137;
    const ev: ScriptEvent[] = [];
    const frames: number[] = [];
    for (let k = 1; k < 8; k++) {
      ev.push({ beat: k, kind: 'on', note: 60, vel: 0.8 }, { beat: k + 0.5, kind: 'off', note: 60 });
      frames.push(Math.round(k * fpb));
    }
    const x = playScript(new Synth(ctx, { ...CLICK_ONLY, click: 1 } as SynthOpts), ctx, ev, 8 * (60 / 137)).l;
    const offsets = frames.map((f) => {
      let i = f - 20;
      while (i < f + 200 && Math.abs(x[i]) < 1e-9) i++;
      return i - f;
    });
    process.stdout.write(`  first click sample minus note frame: ${offsets.join(' ')}\n`);
  }

  process.stdout.write('\ncost, ms per second of audio (best of 5): a sixteenth-note pluck arpeggio at 128 BPM\n');
  for (const [label, click] of [['click off', 0], ['click 0.5', 0.5]] as const) {
    let best = Infinity;
    for (let rep = 0; rep < 5; rep++) {
      const ctx = makeCtx(SR, 128);
      const s = new Synth(ctx, { preset: 'pluck', click } as SynthOpts);
      const l = new Float64Array(64);
      const r = new Float64Array(64);
      const sixteenth = Math.round((SR * 60) / 128 / 4 / 64);
      const notes = [57, 60, 64, 69, 64, 60];
      const seconds = 10;
      const blocks = Math.round((seconds * SR) / 64);
      const t0 = performance.now();
      for (let b = 0; b < blocks; b++) {
        if (b % sixteenth === 0) s.noteOn(notes[Math.floor(b / sixteenth) % notes.length], 0.8, 0, 0);
        l.fill(0);
        r.fill(0);
        s.process(l, r, 64);
      }
      best = Math.min(best, (performance.now() - t0) / seconds);
    }
    process.stdout.write(`  ${label.padEnd(12)} ${best.toFixed(2)} ms/s\n`);
  }
}
