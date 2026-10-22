/**
 * The Volta's engine (headless): a 2026-rules 1.6 L turbo V6 (90 degrees, flat crank, even firing) with an electric motor geared to its
 * crankshaft, the MGU-K. What the shared engine code gained for it is measured here with the same analysis the browser report uses:
 *
 *  - the MGU-K's whine: locked to the crank on its 14th order, a murmur while it turns free, faint while it harvests (a lift, the brakes),
 *    strong while it deploys, which is only while a nitro shot burns; the nitro reaches it through the control vector (CTL.NITRO).
 *  - nothing of this touches an engine that does not ask for it.
 */
import { describe, expect, it } from 'vitest';
import { CARS } from '../src/cars';
import type { EngineSoundProfile } from '../src/core/contracts';
import { chirpDeviation, hasNonFinite, offGridLines, peakAbs, rms, strongestPeak, welch } from '../src/audio/analysis';
import { CTL, makeControlVector, readEngineInputs, writeEngineControls } from '../src/audio/controls';
import { buildLayout } from '../src/audio/dsp/engine-layout';
import { EngineVoice, createEngineDebug, deriveVoicing, type EngineDebug } from '../src/audio/dsp/engine-voice';
import { makeVehicleState } from '../sandbox/audio/drive-sim';

const SR = 48000;
const volta = CARS.find((c) => c.id === 'volta')!;
const P = volta.sound;
const E = volta.physics.engine;
/** The order of the crank the MGU-K whines at (3.5 turns of the motor a crank turn x 4 pole pairs). */
const ORDER = 14;
const fWhine = (rpm: number): number => (rpm / 60) * ORDER;

function voice(profile: EngineSoundProfile = P, car = volta, seed = 5): EngineVoice {
  const v = new EngineVoice(SR, profile, seed);
  const e = car.physics.engine;
  Object.assign(v.inp, { idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, redlineRpm: e.redlineRpm });
  return v;
}

/** A steady render with the debug taps: `pedal` follows the throttle, the boost is the turbo's at that throttle. */
function steady(v: EngineVoice, rpm: number, thr: number, load: number, secs: number, nitro = 0): { out: Float32Array; dbg: EngineDebug } {
  Object.assign(v.inp, { rpm, throttle: thr, load, pedal: thr, boost: 0.9 * thr, nitro });
  const n = Math.floor(secs * SR);
  const out = new Float32Array(n);
  const dbg = createEngineDebug(n);
  v.debug = dbg;
  v.process(out, n);
  return { out, dbg };
}

/** Power (sum of the PSD bins) within [lo, hi] Hz. */
function band(psd: Float64Array, nfft: number, lo: number, hi: number): number {
  let s = 0;
  for (let i = Math.max(1, Math.floor((lo / SR) * nfft)); i <= Math.min(psd.length - 1, Math.ceil((hi / SR) * nfft)); i++) s += psd[i];
  return s;
}

/**
 * How far the whine stands over the rest of the engine in its own critical band (one ERB around its line), dB: what decides whether it is
 * heard. Above 0 it is heard; 10 dB and more, it is plain.
 */
function whineOverMix(out: Float32Array, whine: Float32Array, rpm: number, from = 1.2): number {
  const nfft = 16384;
  const a = Math.floor(from * SR);
  const rest = out.map((x, i) => x - whine[i]);
  const f = fWhine(rpm);
  const erb = 24.7 * ((4.37 * f) / 1000 + 1);
  const pw = band(welch(whine, nfft, a, out.length), nfft, f - erb / 2, f + erb / 2);
  const pr = band(welch(rest, nfft, a, out.length), nfft, f - erb / 2, f + erb / 2);
  return 10 * Math.log10(pw / pr);
}

const db = (x: number): number => 20 * Math.log10(x + 1e-12);

describe('what the profile asks for is all the shared voice does for the Volta', () => {
  it('only the Volta has an electric motor; it has no blower, no dual exhaust and none of the cross-plane lumpiness', () => {
    for (const c of CARS) {
      const V = deriveVoicing(c.sound, buildLayout(c.sound));
      expect(V.electric > 0, c.id).toBe(c.id === 'volta');
    }
    const V = deriveVoicing(P, buildLayout(P));
    expect(V.blower).toBe(false);
    expect(V.dual).toBe(false);
    expect(V.lope).toBe(0);
    expect(V.burble).toBe(0);
    expect(V.idleWobble).toBe(0.03);
  });
});

describe("the MGU-K's whine", () => {
  it('is locked to the crank: its strongest line sits on the 14th order at 5000, 8000 and 11,000 rpm, deploying and harvesting', () => {
    for (const rpm of [5000, 8000, 11000]) {
      for (const [thr, nitro] of [
        [1, 1],
        [0, 0],
      ]) {
        const x = steady(voice(), rpm, thr, thr, 3, nitro).dbg.electric!;
        const pk = strongestPeak(welch(x, 32768, Math.floor(1.2 * SR), x.length), SR, fWhine(rpm) * 0.8, fWhine(rpm) * 1.2);
        expect(Math.abs(pk.freq - fWhine(rpm)) / fWhine(rpm), `@${rpm} thr ${thr}`).toBeLessThan(0.001);
        expect(pk.prominenceDb, `@${rpm} thr ${thr}`).toBeGreaterThan(30);
      }
    }
  });

  it('follows the nitro: deploying it stands 10 dB or more over the rest of the engine in its band; on the throttle without a shot it is under it', () => {
    for (const rpm of [5000, 8000, 11000]) {
      const deploy = steady(voice(), rpm, 1, 1, 3, 1);
      const free = steady(voice(), rpm, 1, 1, 3, 0);
      expect(whineOverMix(deploy.out, deploy.dbg.electric!, rpm), `deploying @${rpm}`).toBeGreaterThan(10);
      expect(whineOverMix(free.out, free.dbg.electric!, rpm), `turning free @${rpm}`).toBeLessThan(0);
      // the shot is worth 20 dB and more of whine
      expect(db(rms(deploy.dbg.electric!, SR)) - db(rms(free.dbg.electric!, SR)), `@${rpm}`).toBeGreaterThan(20);
    }
  });

  it('is faint while it harvests: a lift at 8000 rpm whines 8 to 16 dB under a shot, and over the quieter engine is still heard', () => {
    const lift = steady(voice(), 8000, 0, 0, 3);
    const shot = steady(voice(), 8000, 1, 1, 3, 1);
    const under = db(rms(shot.dbg.electric!, SR)) - db(rms(lift.dbg.electric!, SR));
    expect(under).toBeGreaterThan(8);
    expect(under).toBeLessThan(16);
    expect(whineOverMix(lift.out, lift.dbg.electric!, 8000)).toBeGreaterThan(3);
  });

  it('deploys only as far as the throttle asks: with the shot burning and the throttle shut it is the faint whine of a lift', () => {
    const shut = rms(steady(voice(), 8000, 0, 0, 3, 1).dbg.electric!, SR);
    const lift = rms(steady(voice(), 8000, 0, 0, 3, 0).dbg.electric!, SR);
    expect(Math.abs(db(shut) - db(lift))).toBeLessThan(0.5);
  });

  it('hears the nitro from the vehicle state, through the control vector', () => {
    const st = makeVehicleState();
    Object.assign(st, { rpm: 9000, throttle: 1, throttlePedal: 1, engineLoad: 1, boost: 0.9, idleRpm: E.idleRpm, limiterRpm: E.limiterRpm, redlineRpm: E.redlineRpm, gear: 5 });
    const level = (nitro: number | undefined): number => {
      st.nitro = nitro;
      const vec = makeControlVector();
      writeEngineControls(vec, st);
      const v = new EngineVoice(SR, P, 5);
      readEngineInputs(vec, v.inp);
      expect(v.inp.nitro).toBe(nitro ?? 0);
      const n = 3 * SR;
      const dbg = createEngineDebug(n);
      v.debug = dbg;
      v.process(new Float32Array(n), n);
      return db(rms(dbg.electric!, SR));
    };
    expect(level(1) - level(undefined)).toBeGreaterThan(20);
    expect(level(1) - level(0.5)).toBeGreaterThan(3);
    expect(CTL.NITRO).toBe(64);
  });

  it('answers a change of the rpm at once: through a fast sweep with the shot burning it stays within 1.2 % of the 14th order', () => {
    const v = voice();
    const lo = 5000;
    const hi = 12000;
    const secs = 4;
    const n = secs * SR;
    const dbg = createEngineDebug(n);
    const out = new Float32Array(n);
    Object.assign(v.inp, { throttle: 1, load: 1, pedal: 1, boost: 0.9, nitro: 1 });
    const spf = 800;
    const rpmAt = (t: number): number => lo + (hi - lo) * Math.min(1, t / (secs - 0.2));
    for (let f = 0; f * spf < n; f++) {
      v.inp.rpm = rpmAt((f * spf) / SR);
      v.debug = { exhaust: dbg.exhaust.subarray(f * spf), intake: dbg.intake.subarray(f * spf), mech: dbg.mech.subarray(f * spf), block: dbg.block.subarray(f * spf), turbo: dbg.turbo.subarray(f * spf), whine: dbg.whine.subarray(f * spf), events: dbg.events.subarray(f * spf), electric: dbg.electric!.subarray(f * spf) };
      v.process(out.subarray(f * spf), Math.min(spf, n - f * spf));
    }
    const d = chirpDeviation(dbg.electric!, SR, (t) => fWhine(rpmAt(t)), 0.6, secs - 0.4, { boxMs: 30, fitMs: 120, stepMs: 50 });
    let se = 0;
    for (const r of d.relDev) se += r * r;
    expect(Math.sqrt(se / d.relDev.length)).toBeLessThan(0.012);
  });

  it('sits on the engine-order grid with the shot burning: at the top of the revs nothing off it, the turbo aside', () => {
    for (const frac of [0.97, 0.6]) {
      const rpm = E.redlineRpm * frac;
      const v = voice(P, volta, 17);
      v.V.turbo = false; // (the turbo's whistle is a deliberate non-harmonic tone)
      const { out } = steady(v, rpm, 1, 1, 3.2, 1);
      const off = offGridLines(welch(out, 65536, Math.floor(1.2 * SR), out.length), SR, rpm / 120, { fLo: 1000, prominenceDb: 14, floorDb: 60 });
      expect(off.count, `@${Math.round(rpm)}: ${JSON.stringify(off.lines.slice(0, 4))}`).toBeLessThanOrEqual(2);
      if (off.count > 0) expect(off.worstDb).toBeLessThan(-38);
    }
  });

  it('exists only where the profile asks for it, and `electric` scales it', () => {
    expect(peakAbs(steady(voice({ ...P, electric: undefined }), 8000, 1, 1, 2, 1).dbg.electric!)).toBe(0);
    const full = rms(steady(voice(), 8000, 1, 1, 3, 1).dbg.electric!, SR);
    const half = rms(steady(voice({ ...P, electric: 0.5 }), 8000, 1, 1, 3, 1).dbg.electric!, SR);
    expect(db(half) - db(full)).toBeCloseTo(-6, 0);
  });

  it('every other engine ignores the nitro: its voice is the same to the bit with a shot burning', () => {
    for (const c of CARS.filter((c) => c.id !== 'volta')) {
      const run = (nitro: number): Float32Array => steady(voice(c.sound, c, 3), c.physics.engine.redlineRpm * 0.8, 1, 1, 0.5, nitro).out;
      const a = run(0);
      const b = run(1);
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
      expect(diff, c.id).toBe(0);
    }
  });

  it('is louder in the cockpit than outside, as the whine of a motor beside the driver is', () => {
    const v = voice();
    v.inp.interior = 1;
    const inside = rms(steady(v, 8000, 1, 1, 3, 1).dbg.electric!, SR);
    expect(inside).toBeGreaterThan(1.6 * rms(steady(voice(), 8000, 1, 1, 3, 1).dbg.electric!, SR));
  });

  it('is rendered in full quality only, and fades in after a promotion from lite instead of starting at its old level', () => {
    const v = voice();
    v.inp.quality = 1;
    expect(peakAbs(steady(v, 8000, 1, 1, 2, 1).dbg.electric!)).toBe(0);
    v.inp.quality = 2;
    const { dbg } = steady(v, 8000, 1, 1, 0.6, 1);
    const early = rms(dbg.electric!, 0, Math.floor(0.002 * SR));
    const late = rms(dbg.electric!, Math.floor(0.4 * SR));
    expect(early).toBeLessThan(0.15 * late);
    expect(late).toBeGreaterThan(0);
  });

  it('survives hostile inputs, the nitro among them, without NaN or blow-up', () => {
    const v = voice();
    const out = new Float32Array(128);
    let worst = 0;
    for (const quality of [2, 1]) {
      for (const c of [
        { rpm: 0, throttle: 1, load: 1, pedal: 1, nitro: 1 },
        { rpm: 20000, throttle: 5, load: 3, pedal: 9, nitro: 7 },
        { rpm: 3000, throttle: -2, load: -1, pedal: -0.5, nitro: -3 },
        { rpm: 12500, throttle: 1, load: 1, pedal: 1, limiter: 1, nitro: NaN },
      ]) {
        Object.assign(v.inp, c, { boost: 2, quality });
        for (let i = 0; i < 400; i++) {
          v.inp.rpm = c.rpm + (i % 7) * 100;
          v.inp.interior = (i >> 4) & 1;
          v.process(out, 128);
          expect(hasNonFinite(out)).toBe(false);
          worst = Math.max(worst, peakAbs(out));
        }
      }
    }
    expect(worst).toBeLessThan(6);
  });
});
