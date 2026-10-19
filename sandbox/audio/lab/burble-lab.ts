/**
 * Burble lab (Node): how much of an engine's sound is the lope. A cross-plane V8 fires its two banks unevenly (90 / 180 / 270 / 180 degrees),
 * so what is special about it lives at the HALF ORDERS of the crank: spectral lines at odd multiples of rpm/120, between the firing lines at
 * multiples of 8 x rpm/120 (the 4th crank order is the firing frequency of a V8). A flat-plane V8, or any engine whose banks sum to an even
 * train, has next to nothing there.
 *
 *   node sandbox/audio/lab/run.mjs burble-lab.ts lines  [--car mammoth] [--rpms 650,900,1500,3000,6000] [--tap exhaust|mix] [--lite 1]
 *   node sandbox/audio/lab/run.mjs burble-lab.ts env    [--car mammoth] [--rpm 900]       the 720 degree envelope, pulse by pulse
 *
 * The variants compared are the car's own profile, the same with a flat-plane crank, the same with the banks merged, and the two together
 * (what a flat-plane, X-piped V8 does): the cross-plane's own lope is the difference between the first and the last.
 */
import { CARS } from '../../../src/cars';
import type { CarDefinition, EngineSoundProfile } from '../../../src/core/contracts';
import { EngineVoice, createEngineDebug } from '../../../src/audio/dsp/engine-voice';
import { welch } from '../../../src/audio/analysis';
import { Biquad } from '../../../src/audio/dsp/filters';

const SR = 48000;
const args = process.argv.slice(2);
const cmd = args[0] ?? 'lines';
function opt(name: string, def: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}
const car: CarDefinition = CARS.find((c) => c.id === opt('car', 'mammoth') || c.id.startsWith(opt('car', 'mammoth')))!;
const tap = opt('tap', 'exhaust');
const quality = +opt('lite', '0') ? 1 : 2;

interface Variant {
  name: string;
  patch: Partial<EngineSoundProfile>;
}
const variants: Variant[] = [
  { name: 'cross+dual', patch: {} },
  { name: 'cross+merged', patch: { exhaustSystem: 'merged' } },
  { name: 'flat+dual', patch: { crankType: 'flat' } },
  { name: 'flat+merged', patch: { crankType: 'flat', exhaustSystem: 'merged' } },
];

/** Experiments: --delay ms --gains l,r --len l,r --muff l,r override the dual exhaust's two pipes (what the voicing sets, read live by the voice). */
function tune(v: EngineVoice): void {
  const pair = (name: string): [number, number] | null => {
    const a = opt(name, '');
    return a ? (a.split(',').map(Number) as [number, number]) : null;
  };
  const g = pair('gains');
  if (g) v.V.dualGain = g;
  const l = pair('len');
  if (l) v.V.dualLen = l;
  const m = pair('muff');
  if (m) v.V.dualMuff = m;
  const d = opt('delay', '');
  if (d) v.V.dualDelay = +d / 1000;
  if (args.includes('--nowobble')) v.V.idleWobble = 0; // phase-locked measurements at idle: the crank clock must run steady
}

function render(profile: EngineSoundProfile, rpm: number, thr: number, load: number, secs: number, seed = 5): { sig: Float32Array; ph0: number } {
  const v = new EngineVoice(SR, profile, seed);
  tune(v);
  const e = car.physics.engine;
  Object.assign(v.inp, { rpm, throttle: thr, load, idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, redlineRpm: e.redlineRpm, quality, interior: 0, boost: 0, driveOmega: 0 });
  const n = Math.floor(secs * SR);
  const sig = new Float32Array(n);
  const dbg = createEngineDebug(n);
  v.debug = dbg;
  const ph0 = (v as unknown as { ph: number }).ph;
  v.process(sig, n);
  return { sig: tap === 'mix' ? sig : dbg.exhaust, ph0 };
}

/** Power at the three families of lines (firing, half-order, whole-order), in a band, from a long Welch PSD. */
function lineFamilies(x: Float32Array, rpm: number, fLo: number, fHi: number): { fire: number; half: number; whole: number; between: number } {
  const f0 = rpm / 120;
  let nfft = 1 << 15;
  while (SR / nfft > f0 / 9 && nfft < 1 << 18) nfft <<= 1;
  const a = Math.floor(1.5 * SR);
  const psd = welch(x, nfft, a, x.length);
  const df = SR / nfft;
  let fire = 0;
  let half = 0;
  let whole = 0;
  let between = 0;
  const tol = 0.13 * f0;
  for (let i = Math.floor(fLo / df); i <= Math.min(psd.length - 1, Math.ceil(fHi / df)); i++) {
    const f = i * df;
    const m = Math.round(f / f0);
    const d = Math.abs(f - m * f0);
    if (m < 1) continue;
    if (d > tol) {
      between += psd[i];
      continue;
    }
    if (m % 8 === 0) fire += psd[i];
    else if (m % 2 === 1) half += psd[i];
    else whole += psd[i];
  }
  return { fire, half, whole, between };
}

const db = (x: number): number => 10 * Math.log10(Math.max(x, 1e-30));

if (cmd === 'lines') {
  const rpms = opt('rpms', '650,900,1500,3000,4500,6000').split(',').map(Number);
  const load = +opt('load', '1');
  const thr = load < 0.2 ? 0 : 1;
  const fHi = +opt('fhi', '700');
  const fLo = +opt('flo', '25');
  console.log(`${car.id}, ${tap} tap, ${quality === 2 ? 'full' : 'lite'}, load ${load}, band ${fLo}..${fHi} Hz.  half = odd multiples of rpm/120, whole = other even multiples, fire = multiples of 8; dB re the firing lines`);
  console.log('variant        ' + rpms.map((r) => `${r}rpm`.padStart(24)).join(''));
  for (const v of variants) {
    const profile = { ...car.sound, ...v.patch };
    const cells = rpms.map((rpm) => {
      const { sig } = render(profile, rpm, thr, load, 6);
      const L = lineFamilies(sig, rpm, fLo, fHi);
      return `half ${db(L.half / L.fire).toFixed(1).padStart(6)} whole ${db(L.whole / L.fire).toFixed(1).padStart(6)} `.padStart(24);
    });
    console.log(v.name.padEnd(15) + cells.join(''));
  }
} else if (cmd === 'env') {
  // The 720 degree envelope, what the ear takes for the lope: the energy of the (band-limited) exhaust in 16 slices of the crank cycle,
  // phase-locked on the crank clock (the voice's phase is known: steady rpm, no wobble above 1.35 x idle), averaged over every cycle of
  // the render. Then the modulation of that pattern, per harmonic m of the 720 degree cycle: |sum E_b e^(-2 pi i m b / 16)| 2 / sum E_b,
  // in percent. m = 8 is the firing pulse itself (the even train); odd m are the half orders of the crank, the lope.
  const rpms = opt('rpms', '880,1500,3000,6000').split(',').map(Number);
  const fLo = +opt('flo', '40');
  const fHi = +opt('fhi', '300');
  const load = +opt('load', '1');
  console.log(`${car.id}, ${tap} tap, ${quality === 2 ? 'full' : 'lite'}, load ${load}, band ${fLo}..${fHi} Hz: modulation of the 16-slice cycle energy per harmonic m (%), and the spread of the 8 pulses (dB std)`);
  console.log('variant        rpm   ' + [1, 2, 3, 4, 5, 6, 7].map((m) => `m${m}`.padStart(6)).join('') + '   odd(rms) even(rms)  pulses');
  for (const rpm of rpms) {
    for (const v of variants) {
      const profile = { ...car.sound, ...v.patch };
      const { sig, ph0 } = render(profile, rpm, load < 0.2 ? 0 : 1, load, 10);
      const hp = new Biquad();
      hp.setHighpass(fLo, 0.707, SR);
      const lp = new Biquad();
      lp.setLowpass(fHi, 0.707, SR);
      const bins = new Float64Array(16);
      const cnt = new Float64Array(16);
      const a = Math.floor(1.5 * SR);
      for (let n = 0; n < sig.length; n++) {
        const y = lp.step(hp.step(sig[n]));
        if (n < a) continue;
        const ph = (ph0 + (n * rpm) / (120 * SR)) % 1;
        const b = Math.floor(ph * 16) % 16;
        bins[b] += y * y;
        cnt[b]++;
      }
      const e = Array.from(bins, (s2, i2) => s2 / Math.max(cnt[i2], 1));
      const sum = e.reduce((p2, q) => p2 + q, 0);
      const mod = (m: number): number => {
        let re = 0;
        let im = 0;
        for (let b = 0; b < 16; b++) {
          re += e[b] * Math.cos((2 * Math.PI * m * b) / 16);
          im -= e[b] * Math.sin((2 * Math.PI * m * b) / 16);
        }
        return (2 * Math.hypot(re, im)) / sum;
      };
      const ms = [1, 2, 3, 4, 5, 6, 7].map(mod);
      const rmsOf = (xs: number[]): number => Math.sqrt(xs.reduce((p2, q) => p2 + q * q, 0) / xs.length);
      // the 8 pulses: the energy of the two slices round each firing
      const pulses = Array.from({ length: 8 }, (_, k) => e[(2 * k) % 16] + e[(2 * k + 1) % 16]);
      const pdb = pulses.map((x) => 10 * Math.log10(x / (sum / 8) + 1e-12));
      const mean = pdb.reduce((p2, q) => p2 + q, 0) / 8;
      const std = Math.sqrt(pdb.reduce((p2, q) => p2 + (q - mean) ** 2, 0) / 8);
      console.log(
        `${v.name.padEnd(14)} ${String(rpm).padStart(5)} ` +
          ms.map((x) => (100 * x).toFixed(1).padStart(6)).join('') +
          `   ${(100 * rmsOf([ms[0], ms[2], ms[4], ms[6]])).toFixed(1).padStart(8)} ${(100 * rmsOf([ms[1], ms[3], ms[5]])).toFixed(1).padStart(8)}  ${std.toFixed(2).padStart(6)}`,
      );
    }
  }
}
