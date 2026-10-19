/**
 * Burble lab (Node): how much of an engine's sound is the lope. A cross-plane V8 fires its two banks unevenly (90 / 180 / 270 / 180 degrees),
 * so what is special about it lives at the HALF ORDERS of the crank: spectral lines at odd multiples of rpm/120, between the firing lines at
 * multiples of 8 x rpm/120 (the 4th crank order is the firing frequency of a V8). A flat-plane V8, or any engine whose banks sum to an even
 * train, has next to nothing there.
 *
 *   node sandbox/audio/lab/run.mjs burble-lab.ts lines  [--car mammoth] [--rpms 650,900,1500,3000,6000] [--tap exhaust|mix] [--lite 1]
 *   node sandbox/audio/lab/run.mjs burble-lab.ts env    [--car mammoth] [--rpms 880,1500]  the 720 degree envelope of the cycle, harmonic by harmonic
 *   node sandbox/audio/lab/run.mjs burble-lab.ts spread [--interior 1] [--lite 1]    how unevenly the firing pulses of every car (and variant) sound
 *                                                                                    at idle and at 2500 rpm wide open: level spread, dB std
 *   node sandbox/audio/lab/run.mjs burble-lab.ts mod    [--interior 1]               the loudness fluctuation of every car's idle: modulation of
 *                                                                                    the envelope of 60..800 Hz at the crank's order rates, %
 *
 * The variants compared are the car's own profile, the same with a flat-plane crank, the same with the banks merged, and the two together
 * (what a flat-plane, X-piped V8 does): the cross-plane's own lope is the difference between the first and the last.
 */
import { CARS } from '../../../src/cars';
import type { CarDefinition, EngineSoundProfile } from '../../../src/core/contracts';
import { EngineVoice, createEngineDebug } from '../../../src/audio/dsp/engine-voice';
import { fft, orderFamilies, welch } from '../../../src/audio/analysis';
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
  const fl = opt('floor', '');
  if (fl) v.V.dualFloor = +fl;
  const ro = opt('ro', '');
  if (ro) v.V.Ro = +ro;
  const rcv = opt('rc', '');
  if (rcv) v.V.Rc = +rcv;
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

/**
 * Mean power per line of the three families of lines (firing, half-order, whole-order), in a band, from a long Welch PSD: the band holds
 * more half-order lines than firing lines, so the families are compared line for line, not summed.
 */
function lineFamilies(x: Float32Array, rpm: number, fLo: number, fHi: number): { fire: number; half: number; whole: number; between: number; share: number } {
  const f0 = rpm / 120;
  let nfft = 1 << 15;
  while (SR / nfft > f0 / 9 && nfft < 1 << 18) nfft <<= 1;
  const L = orderFamilies(welch(x, nfft, Math.floor(1.5 * SR), x.length), SR, f0, car.sound.cylinders, fLo, fHi);
  return {
    fire: L.fire / Math.max(L.lines.fire, 1),
    half: L.half / Math.max(L.lines.half, 1),
    whole: L.whole / Math.max(L.lines.whole, 1),
    between: L.between,
    share: L.halfShare,
  };
}

const db = (x: number): number => 10 * Math.log10(Math.max(x, 1e-30));

if (cmd === 'lines') {
  const rpms = opt('rpms', '650,900,1500,3000,4500,6000').split(',').map(Number);
  const load = +opt('load', '1');
  const thr = load < 0.2 ? 0 : 1;
  const fHi = +opt('fhi', '700');
  const fLo = +opt('flo', '25');
  console.log(`${car.id}, ${tap} tap, ${quality === 2 ? 'full' : 'lite'}, load ${load}, band ${fLo}..${fHi} Hz.  per line: half = odd multiples of rpm/120, whole = other even multiples, fire = multiples of 8; dB re the firing lines`);
  console.log('variant        ' + rpms.map((r) => `${r}rpm`.padStart(30)).join(''));
  for (const v of variants) {
    const profile = { ...car.sound, ...v.patch };
    const cells = rpms.map((rpm) => {
      const { sig } = render(profile, rpm, thr, load, 6);
      const L = lineFamilies(sig, rpm, fLo, fHi);
      return `half ${db(L.half / L.fire).toFixed(1).padStart(6)} whole ${db(L.whole / L.fire).toFixed(1).padStart(6)} ${(100 * L.share).toFixed(1).padStart(4)}%`.padStart(30);
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

/** The cars and variants compared by `spread` and `mod`: every car of the roster, and the Mammoth's engine without what makes it a cross-plane in a dual exhaust. */
function allConfigs(): { name: string; car: CarDefinition; patch: Partial<EngineSoundProfile> }[] {
  const mam = CARS.find((c) => c.id === 'mammoth')!;
  return [
    ...CARS.map((c) => ({ name: c.id, car: c, patch: {} as Partial<EngineSoundProfile> })),
    { name: 'mammoth merged', car: mam, patch: { exhaustSystem: 'merged' } },
    { name: 'mammoth flat+merged', car: mam, patch: { exhaustSystem: 'merged', crankType: 'flat' } },
  ];
}

if (cmd === 'spread') {
  // the level of successive firing intervals in 40..500 Hz (a window one firing interval long on the crank clock, so the rpm must be steady and
  // the idle hunting off): the standard deviation of those levels in dB. Even pulses give a small number; a lumpy idle a large one.
  const interior = +opt('interior', '0');
  console.log(`${interior ? 'cockpit' : 'exterior'}, ${quality === 2 ? 'full' : 'lite'}: firing-pulse level spread, dB std (5-95 % range) in 40..500 Hz`);
  for (const c of allConfigs()) {
    const e = c.car.physics.engine;
    const cells: string[] = [];
    for (const [rpm, thr, load] of [[e.idleRpm, 0, 0.06], [2500, 1, 1]] as number[][]) {
      const v = new EngineVoice(SR, { ...c.car.sound, ...c.patch }, 5);
      v.V.idleWobble = 0;
      Object.assign(v.inp, { rpm, throttle: thr, load, pedal: thr, idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, redlineRpm: e.redlineRpm, interior, quality, boost: c.car.sound.turbo ? 0.9 * thr : 0 });
      const n = 10 * SR;
      const sig = new Float32Array(n);
      v.process(sig, n);
      const hp = new Biquad();
      hp.setHighpass(40, 0.707, SR);
      const lp = new Biquad();
      lp.setLowpass(500, 0.707, SR);
      const y = Float32Array.from(sig, (x) => lp.step(hp.step(x)));
      const win = (120 / rpm / c.car.sound.cylinders) * SR;
      const db: number[] = [];
      for (let s0 = 1.5 * SR; s0 + win < y.length; s0 += win) {
        let a = 0;
        const i0 = Math.floor(s0);
        const i1 = Math.floor(s0 + win);
        for (let i = i0; i < i1; i++) a += y[i] * y[i];
        db.push(10 * Math.log10(a / (i1 - i0) + 1e-20));
      }
      const m = db.reduce((a, b) => a + b, 0) / db.length;
      const sd = Math.sqrt(db.reduce((a, b) => a + (b - m) ** 2, 0) / db.length);
      const sorted = [...db].sort((a, b) => a - b);
      const range = sorted[Math.floor(0.95 * (sorted.length - 1))] - sorted[Math.floor(0.05 * (sorted.length - 1))];
      cells.push(`${Math.round(rpm)} rpm: ${sd.toFixed(2)} (${range.toFixed(1)})`.padEnd(24));
    }
    console.log(`${c.name.padEnd(21)} ${cells.join('')}`);
  }
} else if (cmd === 'mod') {
  // the loudness fluctuation of the idle: the envelope of 60..800 Hz (rectified, smoothed 5 ms) and its spectrum, as the depth of the modulation
  // (rms, % of the mean envelope) in bands: all of 1..30 Hz, round the half order rate rpm/120, the crank rate 2 x that, 3 x that, and the slow hunting
  const interior = +opt('interior', '0');
  console.log(`${interior ? 'cockpit' : 'exterior'}, idle (load 0.06): depth of the loudness modulation, %`);
  for (const c of allConfigs()) {
    const e = c.car.physics.engine;
    const rpm = e.idleRpm;
    const v = new EngineVoice(SR, { ...c.car.sound, ...c.patch }, 5);
    v.V.idleWobble = 0;
    Object.assign(v.inp, { rpm, throttle: 0, load: 0.06, pedal: 0, idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, redlineRpm: e.redlineRpm, interior, quality });
    const n = 20 * SR;
    const sig = new Float32Array(n);
    v.process(sig, n);
    const hp = new Biquad();
    hp.setHighpass(60, 0.707, SR);
    const lp = new Biquad();
    lp.setLowpass(800, 0.707, SR);
    const k = 1 - Math.exp(-1 / (0.005 * SR));
    const dec = 96;
    let env = 0;
    const ev: number[] = [];
    for (let i = 0; i < n; i++) {
      env += k * (Math.abs(lp.step(hp.step(sig[i]))) - env);
      if (i > 2 * SR && i % dec === 0) ev.push(env);
    }
    const N = 8192;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const mean = ev.reduce((a, b) => a + b, 0) / ev.length;
    for (let i = 0; i < N; i++) re[i] = (ev[i] / mean - 1) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    fft(re, im);
    const df = SR / dec / N;
    const f0 = rpm / 120;
    const band = (lo: number, hi: number): string => {
      let acc = 0;
      for (let i = Math.ceil(lo / df); i <= Math.floor(hi / df); i++) acc += re[i] ** 2 + im[i] ** 2;
      return (100 * Math.sqrt(acc / ((0.375 * N * N) / 2))).toFixed(1).padStart(5);
    };
    console.log(
      `${c.name.padEnd(21)} idle ${String(Math.round(rpm)).padStart(4)} rpm: 1-30 Hz ${band(1, 30)} | half-order rate ${f0.toFixed(1)} Hz ${band(f0 * 0.8, f0 * 1.2)} | crank rate ${(2 * f0).toFixed(1)} Hz ${band(1.6 * f0, 2.4 * f0)} | 3x ${band(2.4 * f0, 3.6 * f0)} | hunting 0.5-4 Hz ${band(0.5, 4)}`,
    );
  }
}
