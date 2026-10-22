/**
 * The Volta's engine (headless): a 2026-rules 1.6 L turbo V6 (90 degrees, flat crank, even firing) with an electric motor geared to its
 * crankshaft, the MGU-K. What the shared engine code gained for it is measured here with the same analysis the browser report uses:
 *
 *  - the V6: three pulses a turn, every line of its exhaust on a multiple of 3 x rpm/60; louder and brighter with the revs, its loudness
 *    measured over its own revs on boost; no muffler and a wastegate wide open flat out (the harmonics past the turbine, the rasp); no
 *    blow-off valve; a seamless shift; no clipping at the limiter.
 *  - the MGU-K's whine: locked to the crank on its 14th order, a murmur while it turns free, faint while it harvests (a lift, the brakes),
 *    strong while it deploys, which is only while a nitro shot burns; the nitro reaches it through the control vector (CTL.NITRO).
 *  - the open cockpit (CarVisualSpec.openCockpit): its cockpit views hear the car through a helmet, not a closed cabin (no muffled exhaust
 *    path, no cabin boom, the airbox and the wind louder), and the rain drums on no roof.
 *  - nothing of this touches an engine that does not ask for it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CARS } from '../src/cars';
import type { EngineSoundProfile } from '../src/core/contracts';
import { bandPower, chirpDeviation, hasNonFinite, offGridLines, orderFamilies, peakAbs, rms, spectralCentroid, strongestPeak, welch } from '../src/audio/analysis';
import { CarSoundImpl, type CarHost } from '../src/audio/carsound';
import { CTL, makeControlVector, readEngineInputs, writeEngineControls } from '../src/audio/controls';
import { ChassisVoice } from '../src/audio/dsp/chassis-voice';
import { bankFiringIntervals, buildLayout } from '../src/audio/dsp/engine-layout';
import { EngineVoice, calibratedExhaustGain, createEngineDebug, deriveVoicing, exhaustTargetDb, measureExhaustSweepRms, type EngineDebug } from '../src/audio/dsp/engine-voice';
import { makeLimiterCurve, volumeCurve } from '../src/audio/graph';
import { DEFAULT_SETTINGS } from '../src/core/settings';
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
  it('only the Volta has an electric motor and a racing engine\'s fields; it has no blower, no dual exhaust and none of the cross-plane lumpiness', () => {
    for (const c of CARS) {
      const V = deriveVoicing(c.sound, buildLayout(c.sound));
      expect(V.electric > 0, c.id).toBe(c.id === 'volta');
      if (c.id === 'volta') continue;
      // (the five other engines take the old path everywhere: none of the fields is there)
      const s = c.sound;
      expect([s.electric, s.limiterRpm, s.idleLiftTo, s.blowOff, s.shiftDip, s.wastegate], c.id).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
      expect([V.wastegate, V.blowOff, V.shiftDip, V.idleLiftTo], c.id).toEqual([0, true, 0.07, 2.2]);
    }
    const V = deriveVoicing(P, buildLayout(P));
    expect(V.blower).toBe(false);
    expect(V.dual).toBe(false);
    expect(V.lope).toBe(0);
    expect(V.burble).toBe(0);
    expect(V.idleWobble).toBe(0.03);
  });
});

describe('the 2026 V6', () => {
  it('fires evenly three times a turn: 120 degrees apart, each bank every 240', () => {
    const L = buildLayout(P);
    expect(L.cylinders).toBe(6);
    expect(L.banks).toBe(2);
    expect(L.cyl.map((c) => c.fireDeg)).toEqual([0, 120, 240, 360, 480, 600]);
    for (const b of [0, 1]) expect(bankFiringIntervals(L, b)).toEqual([240, 240, 240]);
    expect(L.firingHzPerRpm * 60).toBeCloseTo(3, 12);
    expect(P.displacement).toBe(1.6);
    expect(P.turbo).toBe(true);
    // one central tailpipe: the banks merge
    expect(deriveVoicing(P, L).dual).toBe(false);
  });

  it('every line of its exhaust is a firing line, a multiple of 3 x rpm/60: 99 % and more of the power in the lines at 5000, 8000 and 11,000 rpm', () => {
    for (const rpm of [5000, 8000, 11000]) {
      const { dbg } = steady(voice(), rpm, 1, 1, 5);
      const f0 = rpm / 120;
      let nfft = 1 << 15;
      while (SR / nfft > f0 / 9 && nfft < 1 << 18) nfft <<= 1;
      const of = orderFamilies(welch(dbg.exhaust, nfft, Math.floor(1.5 * SR), dbg.exhaust.length), SR, f0, 6, 40, 6000);
      expect(of.fire / (of.fire + of.half + of.whole), `@${rpm}`).toBeGreaterThan(0.99);
      // and the strongest line of the whole voice near the firing frequency sits on it
      const { out } = steady(voice(), rpm, 1, 1, 2.4);
      const f = 3 * (rpm / 60);
      const pk = strongestPeak(welch(out, 32768, Math.floor(1.2 * SR), out.length), SR, f * 0.9, f * 1.1);
      expect(Math.abs(pk.freq - f) / f, `@${rpm}`).toBeLessThan(0.002);
      expect(pk.prominenceDb, `@${rpm}`).toBeGreaterThan(12);
    }
  });

  it('is louder with the revs: flat out, 8 dB and more louder at 11,000 rpm than at 5000, and no step up of 1500 rpm quieter by more than 1.5 dB', () => {
    const at = (rpm: number): number => db(rms(steady(voice(), rpm, 1, 1, 2.4).out, SR));
    const lv = [5000, 6500, 8000, 9500, 11000].map(at);
    expect(lv[4] - lv[0]).toBeGreaterThan(8);
    for (let k = 1; k < lv.length; k++) expect(lv[k] - lv[k - 1], JSON.stringify(lv)).toBeGreaterThan(-1.5);
  });

  it('is a hard, high rasp flat out: over 8750..12,000 rpm its centroid is over 2 kHz and a fifth of its power above 3 kHz, where the wastegate puts it', () => {
    const g = calibratedExhaustGain(P, SR);
    const at = (profile: EngineSoundProfile): { centroid: number; high: number } => {
      let centroid = 0;
      let high = 0;
      const rpms = [8750, 10000, 11000, 12000];
      for (const rpm of rpms) {
        const v = new EngineVoice(SR, profile, 5, g);
        Object.assign(v.inp, { idleRpm: E.idleRpm, limiterRpm: E.limiterRpm, redlineRpm: E.redlineRpm });
        const { out } = steady(v, rpm, 1, 1, 2.4);
        const psd = welch(out, 16384, Math.floor(1.0 * SR), out.length);
        centroid += spectralCentroid(psd, SR, 40, 12000) / rpms.length;
        high += bandPower(psd, SR, 3000, 12000) / bandPower(psd, SR, 40, 12000) / rpms.length;
      }
      return { centroid, high };
    };
    const open = at(P);
    const shut = at({ ...P, wastegate: undefined });
    expect(open.centroid).toBeGreaterThan(2050);
    expect(open.high).toBeGreaterThan(0.2);
    // the turbine alone rounds the pulses off: 150 Hz and more lower, and a fifth less above 3 kHz
    expect(shut.centroid).toBeLessThan(open.centroid - 150);
    expect(shut.high).toBeLessThan(0.8 * open.high);
  });

  it('the wastegate opens only on boost: off it, the voice is the same to the bit with it or without it', () => {
    const g = calibratedExhaustGain(P, SR);
    const run = (profile: EngineSoundProfile): Float32Array => {
      const v = new EngineVoice(SR, profile, 5, g);
      Object.assign(v.inp, { idleRpm: E.idleRpm, limiterRpm: E.limiterRpm, redlineRpm: E.redlineRpm, rpm: 11000, throttle: 1, load: 1, pedal: 1, boost: 0 });
      const out = new Float32Array(SR);
      v.process(out, SR);
      return out;
    };
    const a = run(P);
    const b = run({ ...P, wastegate: undefined });
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
    expect(diff).toBe(0);
  });

  it('its loudness is measured as it is driven, over its own revs on boost: on its target there, and 3 dB and more under the gain the nominal 2800..8000 rpm off boost would give it', () => {
    expect(P.limiterRpm).toBe(E.limiterRpm);
    const g = calibratedExhaustGain(P, SR);
    expect(Math.abs(db(measureExhaustSweepRms(P, SR, g)) - exhaustTargetDb(P.exhaustOpenness, P.displacement))).toBeLessThan(0.6);
    expect(db(g) - db(calibratedExhaustGain({ ...P, limiterRpm: undefined }, SR))).toBeLessThan(-3);
  });

  /** Flat out at the limiter, its cut chopping, as the game drives it: the load of 312 Nm of 380 and full boost (the controls.ts mapping). */
  function atLimiter(seed: number): Float32Array {
    const v = voice(P, volta, seed);
    Object.assign(v.inp, { rpm: E.limiterRpm, throttle: 1, load: 0.5 * (312 / 380) + 0.5, pedal: 1, boost: 1, limiter: 1 });
    const n = Math.floor(2.4 * SR);
    const out = new Float32Array(n);
    v.process(out, n);
    return out.subarray(Math.floor(0.3 * SR));
  }

  it("does not clip at the limiter: its peak stays under 1.4 through the cut, and after the game's gains at the default volumes under the knee of the soft limiter", () => {
    // (the voice is the raw engine; the graph turns it down by the equal-power panner, the engine bus and the master before the limiter)
    const a = DEFAULT_SETTINGS.audio;
    const toMaster = Math.SQRT1_2 * volumeCurve(a.engine) * volumeCurve(a.master);
    const curve = makeLimiterCurve();
    for (const seed of [1, 2, 3, 4, 5]) {
      const x = atLimiter(seed);
      expect(hasNonFinite(x)).toBe(false);
      const pk = peakAbs(x);
      expect(pk, `seed ${seed}`).toBeLessThan(1.4);
      const m = pk * toMaster;
      expect(m, `seed ${seed}`).toBeLessThan(0.8);
      // (below the knee the curve passes the signal untouched)
      expect(curve[Math.round(((m + 1) / 2) * (curve.length - 1))]).toBeCloseTo(m, 2);
    }
    // and in the terms of tests/audio-dsp.test.ts (off boost, at 0.97 of the redline) under full scale
    const v = voice(P, volta, 3);
    Object.assign(v.inp, { rpm: E.redlineRpm * 0.97, throttle: 1, load: 1, pedal: 1, boost: 0 });
    const out = new Float32Array(Math.floor(2.4 * SR));
    v.process(out, out.length);
    expect(peakAbs(out, Math.floor(0.3 * SR))).toBeLessThan(1);
  });

  it('has no blow-off valve: a lift at full boost vents nothing, where the same engine with one blows off twenty times the energy', () => {
    const vent = (profile: EngineSoundProfile): number => {
      const v = voice(profile, volta, 17);
      steady(v, 10000, 1, 1, 1.0);
      Object.assign(v.inp, { throttle: 0, load: 0, pedal: 0, boost: 1 });
      const n = Math.floor(0.3 * SR);
      const dbg = createEngineDebug(n);
      v.debug = dbg;
      const x = new Float32Array(n);
      v.process(x, n);
      // the blow-off has no tap of its own: it is what is left of the output once the layers are taken away
      let e = 0;
      for (let i = 0; i < n; i++) {
        const r = x[i] - (dbg.exhaust[i] + dbg.intake[i] + dbg.mech[i] + dbg.block[i] + dbg.turbo[i] + dbg.whine[i] + dbg.events[i] + dbg.electric![i]);
        e += r * r;
      }
      return e / n;
    };
    expect(P.blowOff).toBe(false);
    expect(vent({ ...P, blowOff: undefined })).toBeGreaterThan(20 * vent(P));
  });

  it("shifts seamlessly: an upshift dips the exhaust by 3 dB for 15 ms at most, where a road car's gearbox (70 ms) dips it for 50 ms and more", () => {
    const dipMs = (profile: EngineSoundProfile, seed: number): number => {
      const v = voice(profile, volta, seed);
      const ref = rms(steady(v, 10000, 1, 1, 1).dbg.exhaust, Math.floor(0.5 * SR));
      v.inp.shiftCount += 1;
      const { dbg } = steady(v, 10000, 1, 1, 0.2);
      const w = Math.floor(0.002 * SR);
      let ms = 0;
      for (let s = 0; s + w <= dbg.exhaust.length; s += w) if (rms(dbg.exhaust, s, s + w) < 0.7 * ref) ms += 2;
      return ms;
    };
    for (const seed of [1, 2, 3]) {
      expect(dipMs(P, seed)).toBeLessThanOrEqual(15);
      expect(dipMs({ ...P, shiftDip: undefined }, seed)).toBeGreaterThan(50);
    }
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

describe('the open cockpit: the driver hears the car through a helmet, not a closed cabin', () => {
  it('the Volta has an open cockpit, and no other car of the roster does', () => {
    for (const c of CARS) expect(c.visual.openCockpit === true, c.id).toBe(c.id === 'volta');
  });

  /** The engine at `rpm` flat out from outside (interior 0), from a closed cabin and from the helmet (interior 1). */
  function views(rpm: number): Record<'outside' | 'cabin' | 'helmet', { out: Float32Array; dbg: EngineDebug }> {
    const at = (interior: number, helmet: boolean): { out: Float32Array; dbg: EngineDebug } => {
      const v = voice();
      v.helmet = helmet;
      v.inp.interior = interior;
      return steady(v, rpm, 1, 1, 2.4);
    };
    return { outside: at(0, false), cabin: at(1, false), helmet: at(1, true) };
  }
  /** The share of the voice in 80..110 Hz, where a closed cabin booms (its resonance at 95 Hz). */
  const boomShare = (x: Float32Array): number => {
    const psd = welch(x, 16384, SR, x.length);
    return bandPower(psd, SR, 80, 110) / bandPower(psd, SR, 40, 12000);
  };

  it('hears the exhaust straight: within 4 dB of outside where the cabin takes 5.5 dB and more off it, and the airbox above the helmet louder than in a cabin', () => {
    for (const rpm of [6250, 10625]) {
      const w = views(rpm);
      const ex = (k: keyof typeof w): number => db(rms(w[k].dbg.exhaust, SR));
      expect(ex('outside') - ex('helmet'), `@${rpm}`).toBeLessThan(4);
      expect(ex('outside') - ex('cabin'), `@${rpm}`).toBeGreaterThan(5.5);
      expect(db(rms(w.helmet.dbg.intake, SR)) - db(rms(w.cabin.dbg.intake, SR)), `@${rpm}`).toBeGreaterThan(1.5);
    }
  });

  it("has no cabin to boom: the share of the voice about 95 Hz is two thirds of the closed cabin's or less", () => {
    for (const rpm of [6250, 10625]) {
      const w = views(rpm);
      expect(boomShare(w.helmet.out), `@${rpm}`).toBeLessThan((2 / 3) * boomShare(w.cabin.out));
    }
  });

  it("is the exterior to the bit when the camera is outside, and a closed car's voice is a cabin's unless it is told otherwise", () => {
    expect(new EngineVoice(SR, P, 1).helmet).toBe(false);
    expect(new ChassisVoice(SR, 1).helmet).toBe(false);
    const run = (helmet: boolean): Float32Array => {
      const v = voice();
      v.helmet = helmet;
      return steady(v, 9000, 1, 1, 1).out;
    };
    const a = run(false);
    const b = run(true);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
    expect(diff).toBe(0);
  });

  /** The chassis at `kmh` on a dry road (or in the air: the wind alone), as heard from `interior`, through a helmet or not: its left channel. */
  function chassis(kmh: number, interior: number, helmet: boolean, airborne = 0): Float32Array {
    const c = new ChassisVoice(SR, 5);
    c.helmet = helmet;
    Object.assign(c.inp, { speed: kmh / 3.6, interior, airborne });
    const n = 2 * SR;
    const l = new Float32Array(n);
    c.process(l, new Float32Array(n), n);
    return l;
  }

  it('the wind is heard as outside the car, not muffled as in a cabin: as loud as outside, 4 dB and more louder than a cabin and a third brighter', () => {
    const cen = (x: Float32Array): number => spectralCentroid(welch(x, 8192, SR, x.length), SR, 40, 12000);
    for (const kmh of [150, 300]) {
      // (in the air the road and the tyres are all but gone: what is left is the wind)
      const out = chassis(kmh, 0, false, 1);
      const cab = chassis(kmh, 1, false, 1);
      const hel = chassis(kmh, 1, true, 1);
      expect(Math.abs(db(rms(hel, SR)) - db(rms(out, SR))), `${kmh} km/h`).toBeLessThan(1.5);
      expect(db(rms(hel, SR)) - db(rms(cab, SR)), `${kmh} km/h`).toBeGreaterThan(4);
      expect(cen(hel), `${kmh} km/h`).toBeGreaterThan(cen(cab) * 1.3);
      // and on the road, the tyres beside the helmet and the road under it, no quieter than outside
      expect(db(rms(chassis(kmh, 1, true), SR)) - db(rms(chassis(kmh, 0, false), SR)), `${kmh} km/h`).toBeGreaterThan(0);
    }
  });

  it('the sound of an open car hears its cockpit views from the car, and the rain drums on no roof: interior 1, under a roof 0', () => {
    const host = {
      ctx: { sampleRate: SR },
      workletReady: false,
      paused: false,
      wetness: 0,
      secondListener: null,
      nextSeed: () => 1,
      onDispose: () => undefined,
    } as unknown as CarHost;
    const open = new CarSoundImpl(host, P, true, 0, true);
    const closed = new CarSoundImpl(host, CARS[3].sound, true, 0);
    for (const on of [true, false]) {
      open.setInterior(on);
      closed.setInterior(on);
      expect(open.interior).toBe(on ? 1 : 0);
      expect(open.cabin).toBe(0);
      expect(closed.interior).toBe(on ? 1 : 0);
      expect(closed.cabin).toBe(closed.interior);
    }
  });

  describe('through the worklet', () => {
    type Proc = { port: { onmessage: ((e: { data: unknown }) => void) | null }; process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };
    const registered: Record<string, new (o: unknown) => Proc> = {};
    beforeAll(async () => {
      vi.stubGlobal('sampleRate', SR);
      vi.stubGlobal('currentFrame', 0);
      vi.stubGlobal('registerProcessor', (name: string, ctor: new (o: unknown) => Proc) => {
        registered[name] = ctor;
      });
      vi.stubGlobal(
        'AudioWorkletProcessor',
        class {
          port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage(): void {}, close(): void {} };
        },
      );
      await import('../src/audio/engine.worklet');
    });
    afterAll(() => {
      vi.unstubAllGlobals();
    });

    it('the processor options tell both voices: the cockpit view of an open car is a helmet, its exterior is what it was', () => {
      const render = (openCockpit: boolean | undefined, interior: number): Float32Array => {
        const p = new registered['xr-car']({ processorOptions: { profile: P, isPlayer: true, seed: 2, exGain: 20, openCockpit } });
        const v = makeControlVector();
        v[CTL.RPM] = 9000;
        v[CTL.THROTTLE] = 1;
        v[CTL.LOAD] = 1;
        v[CTL.PEDAL] = 1;
        v[CTL.IDLE_RPM] = E.idleRpm;
        v[CTL.LIMITER_RPM] = E.limiterRpm;
        v[CTL.REDLINE_RPM] = E.redlineRpm;
        v[CTL.SPEED] = 70;
        v[CTL.SURF_HARD] = 1;
        v[CTL.INTERIOR] = interior;
        v[CTL.CH_INTERIOR] = interior;
        p.port.onmessage!({ data: v });
        const out = [[new Float32Array(128)], [new Float32Array(128), new Float32Array(128)]];
        const x = new Float32Array(SR);
        for (let b = 0; b < x.length / 128; b++) {
          p.process([], out);
          for (let i = 0; i < 128; i++) x[b * 128 + i] = out[0][0][i] + out[1][0][i];
        }
        return x;
      };
      const same = (a: Float32Array, b: Float32Array): boolean => a.every((x, i) => x === b[i]);
      expect(same(render(true, 0), render(undefined, 0))).toBe(true);
      expect(same(render(false, 1), render(undefined, 1))).toBe(true);
      expect(same(render(true, 1), render(undefined, 1))).toBe(false);
    });
  });
});
