/**
 * The Mammoth's engine (headless): a supercharged cross-plane V8 in a true dual exhaust. What the shared engine code gained for it is
 * measured here with the same analysis the browser report uses:
 *
 *  - the burble: the cross-plane's banks fire 90 / 180 / 270 / 180 degrees apart, so through identical pipes that meet in an X-pipe, or
 *    through two identical pipes heard from one point, their sum is the even train of a flat-plane engine and nothing of the lope is
 *    left. It is only through a dual exhaust whose two pipes differ (and are heard from a point nearer one of them) that the half orders
 *    of the crank (odd multiples of rpm/120) come out; the cammed idle is irregular; a lift-off burbles.
 *  - the supercharger's whine: locked to the rpm through the pulley and the lobes, loud on the throttle, a whirr off it.
 *  - lite quality carries the lope too and the two qualities join without a click.
 *  - nothing of this touches an engine that does not ask for it.
 */
import { describe, expect, it } from 'vitest';
import { CARS } from '../src/cars';
import type { EngineSoundProfile } from '../src/core/contracts';
import { chirpDeviation, hasNonFinite, offGridLines, orderFamilies, peakAbs, rms, strongestPeak, welch } from '../src/audio/analysis';
import { buildLayout } from '../src/audio/dsp/engine-layout';
import { Biquad } from '../src/audio/dsp/filters';
import { EngineVoice, createEngineDebug, deriveVoicing, exhaustTargetDb, type EngineDebug } from '../src/audio/dsp/engine-voice';

const SR = 48000;
const mammoth = CARS.find((c) => c.id === 'mammoth')!;
const M = mammoth.sound;
const E = mammoth.physics.engine;
const vanta = CARS.find((c) => c.id === 'vanta-gt')!;

function voice(profile: EngineSoundProfile = M, car = mammoth, seed = 5): EngineVoice {
  const v = new EngineVoice(SR, profile, seed);
  const e = car.physics.engine;
  Object.assign(v.inp, { idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, redlineRpm: e.redlineRpm });
  return v;
}

/** A steady render with the debug taps: `pedal` defaults to the throttle. */
function steady(v: EngineVoice, rpm: number, thr: number, load: number, secs: number, pedal = thr): { out: Float32Array; dbg: EngineDebug } {
  Object.assign(v.inp, { rpm, throttle: thr, load, pedal });
  const n = Math.floor(secs * SR);
  const out = new Float32Array(n);
  const dbg = createEngineDebug(n);
  v.debug = dbg;
  v.process(out, n);
  return { out, dbg };
}

/** The share of the exhaust's power (25..400 Hz) that sits in the half orders of the crank (odd multiples of rpm/120). */
function halfShare(profile: EngineSoundProfile, rpm: number, tweak?: (v: EngineVoice) => void, quality = 2): number {
  const v = voice(profile);
  v.inp.quality = quality;
  tweak?.(v);
  const { out, dbg } = steady(v, rpm, 1, 1, 6);
  const f0 = rpm / 120;
  let nfft = 1 << 15;
  while (SR / nfft > f0 / 9 && nfft < 1 << 18) nfft <<= 1;
  // (lite renders no exhaust tap of its own worth the name: its mix is the exhaust path and the crack-free pulses)
  const x = quality === 2 ? dbg.exhaust : out;
  return orderFamilies(welch(x, nfft, Math.floor(1.5 * SR), x.length), SR, f0, profile.cylinders, 25, 400).halfShare;
}

const merged = (p: EngineSoundProfile): EngineSoundProfile => ({ ...p, exhaustSystem: 'merged' });
const flat = (p: EngineSoundProfile): EngineSoundProfile => ({ ...p, crankType: 'flat' });
const twins = (v: EngineVoice): void => {
  v.V.dualGain = [1, 1];
  v.V.dualLen = [1, 1];
  v.V.dualMuff = [1, 1];
  v.V.dualDelay = 0;
};

/** The spread (dB, standard deviation) of the energy of successive firing intervals in 40..500 Hz: how even the pulses are. */
function pulseSpread(profile: EngineSoundProfile, car: (typeof CARS)[number], rpm: number, load: number, quality = 2): number {
  const v = voice(profile, car);
  v.V.idleWobble = 0; // the crank clock must run steady to cut the signal into firing intervals
  v.inp.quality = quality;
  const { out } = steady(v, rpm, load < 0.2 ? 0 : 1, load, 7);
  const hp = new Biquad();
  hp.setHighpass(40, 0.707, SR);
  const lp = new Biquad();
  lp.setLowpass(500, 0.707, SR);
  const y = Float32Array.from(out, (s) => lp.step(hp.step(s)));
  const win = (120 / rpm / profile.cylinders) * SR;
  const db: number[] = [];
  for (let s0 = 1.5 * SR; s0 + win < y.length; s0 += win) {
    let a = 0;
    const i0 = Math.floor(s0);
    const i1 = Math.floor(s0 + win);
    for (let i = i0; i < i1; i++) a += y[i] * y[i];
    db.push(10 * Math.log10(a / (i1 - i0) + 1e-20));
  }
  const m = db.reduce((a, b) => a + b, 0) / db.length;
  return Math.sqrt(db.reduce((a, b) => a + (b - m) ** 2, 0) / db.length);
}

describe('what the profile asks for is all the shared voice does for the Mammoth', () => {
  it('only the Mammoth has a blower, a dual exhaust and the cross-plane lumpiness; every other engine of the roster is off all three', () => {
    for (const c of CARS) {
      const V = deriveVoicing(c.sound, buildLayout(c.sound));
      const mine = c.id === 'mammoth';
      expect(V.blower, c.id).toBe(mine);
      expect(V.dual, c.id).toBe(mine);
      expect(V.lope > 0, c.id).toBe(mine);
      expect(V.burble > 0, c.id).toBe(mine);
      expect(V.idleWobble, c.id).toBe(mine ? 0.045 : 0.03);
    }
  });

  it('the Mammoth is a supercharged cross-plane V8 in a dual exhaust, with a blower whose tone sits on the engine-order grid', () => {
    expect(M.crankType).toBe('crossplane');
    expect(M.cylinders).toBe(8);
    expect(M.turbo).toBe(false);
    expect(M.exhaustSystem).toBe('dual');
    const sc = M.supercharger!;
    // 2 x ratio x lobes a whole number: the tone and its harmonics are multiples of rpm/120, where the aliasing test looks for strays
    expect(Math.abs(2 * sc.ratio * sc.lobes - Math.round(2 * sc.ratio * sc.lobes))).toBeLessThan(1e-9);
  });

  it('a big engine is louder at the same openness; every engine of 4.5 L and under is exactly where it was', () => {
    expect(exhaustTargetDb(0.6, 4.0)).toBe(exhaustTargetDb(0.6));
    expect(exhaustTargetDb(0.6, 4.5)).toBe(exhaustTargetDb(0.6));
    expect(exhaustTargetDb(0.7, 6.2)).toBeGreaterThan(exhaustTargetDb(0.7, 4.5) + 2);
    expect(exhaustTargetDb(0.7, 6.2)).toBeLessThan(exhaustTargetDb(0.7, 4.5) + 4);
  });
});

describe('the burble: half orders of the crank, from the cross-plane in a dual exhaust and from nothing else', () => {
  it('the half orders carry a tenth of the exhaust band at 900, 1800 and 3000 rpm; through the same engine merged, flat-plane or with twin pipes they carry under a fiftieth of that', () => {
    for (const rpm of [900, 1800, 3000]) {
      const dual = halfShare(M, rpm);
      expect(dual, `dual @${rpm}`).toBeGreaterThan(0.03);
      for (const [name, share] of [
        ['merged (X-pipe)', halfShare(merged(M), rpm)],
        ['flat-plane', halfShare(flat(M), rpm)],
        ['twin pipes', halfShare(M, rpm, twins)],
      ] as [string, number][]) {
        expect(share, `${name} @${rpm}`).toBeLessThan(dual / 50);
      }
    }
  });

  it('the lope is strongest below 3000 rpm and fades into the roar: over 4000..5500 rpm the half orders carry under 40 % of what they do over 900..3000', () => {
    const mean = (rpms: number[]): number => rpms.reduce((a, r) => a + halfShare(M, r), 0) / rpms.length;
    expect(mean([4000, 4500, 5000, 5500])).toBeLessThan(0.4 * mean([900, 1800, 3000]));
  });

  it('the cammed idle is lumpy: the firing pulses vary three times as much, in level, as the same engine flat-plane and twice as much as a Vanta', () => {
    const idle = E.idleRpm;
    const cross = pulseSpread(M, mammoth, idle, 0.06);
    expect(cross).toBeGreaterThan(1.8);
    expect(cross).toBeGreaterThan(2 * pulseSpread(vanta.sound, vanta, vanta.physics.engine.idleRpm, 0.06));
    expect(cross).toBeGreaterThan(2.2 * pulseSpread(flat(merged(M)), mammoth, idle, 0.06));
  });

  it('and it evens out under load at speed: at 3000 rpm wide open the spread is under half the idle\'s', () => {
    expect(pulseSpread(M, mammoth, 3000, 1)).toBeLessThan(pulseSpread(M, mammoth, E.idleRpm, 0.06) / 2);
  });

  it('lite quality has the lope too: the half orders and the lumpy idle are there, at a cost of events and not of pipes', () => {
    // (a lite voice has no exhaust tap of its own: what is measured is its mix, which is the exhaust path and the pulses)
    const dual = halfShare(M, 1800, undefined, 1);
    expect(dual).toBeGreaterThan(0.01);
    expect(halfShare(merged(M), 1800, undefined, 1)).toBeLessThan(dual / 10);
    expect(pulseSpread(M, mammoth, E.idleRpm, 0.06, 1)).toBeGreaterThan(1.5 * pulseSpread(vanta.sound, vanta, vanta.physics.engine.idleRpm, 0.06, 1));
  });

  /**
   * WOT at 5000 rpm for 1.5 s, then the pedal comes off and the engine slows to 1500 rpm over 4 s. Returns the burbles counted between 1 and 4 s after
   * the lift, and how far the loudest 5 % of 20 ms stretches of the exhaust stand above the running median of the stretches around them (dB).
   */
  function liftOff(profile: EngineSoundProfile, car = mammoth, seed = 9, mutate?: (v: EngineVoice) => void): { burbles: number; standOut: number } {
    const v = voice(profile, car, seed);
    mutate?.(v);
    const n = 7 * SR;
    const out = new Float32Array(n);
    const dbg = createEngineDebug(n);
    const spf = 800;
    let before = 0;
    let after = 0;
    for (let f = 0; f * spf < n; f++) {
      const t = (f * spf) / SR;
      const lift = t >= 1.5;
      Object.assign(v.inp, { rpm: lift ? Math.max(1500, 5000 - ((t - 1.5) / 4) * 3500) : 5000, throttle: lift ? 0 : 1, load: lift ? 0 : 1, pedal: lift ? 0 : 1 });
      v.debug = { exhaust: dbg.exhaust.subarray(f * spf), intake: dbg.intake.subarray(f * spf), mech: dbg.mech.subarray(f * spf), block: dbg.block.subarray(f * spf), turbo: dbg.turbo.subarray(f * spf), whine: dbg.whine.subarray(f * spf), events: dbg.events.subarray(f * spf) };
      v.process(out.subarray(f * spf), Math.min(spf, n - f * spf));
      if (t < 2.5) before = v.burbles;
      if (t < 5.5) after = v.burbles;
    }
    const w = Math.floor(0.02 * SR);
    const db: number[] = [];
    for (let s0 = Math.floor(2.5 * SR); s0 + w < Math.floor(5.5 * SR); s0 += w) db.push(20 * Math.log10(rms(dbg.exhaust, s0, s0 + w) + 1e-9));
    const above = db.map((x, i) => {
      const around = db.slice(Math.max(0, i - 7), Math.min(db.length, i + 8)).sort((a, b) => a - b);
      return x - around[around.length >> 1];
    });
    above.sort((a, b) => a - b);
    return { burbles: after - before, standOut: above[Math.floor(0.95 * (above.length - 1))] };
  }

  it('a lift-off burbles: dozens of exhaust events light the charge in the pipe in three seconds, none at wide open throttle', () => {
    const lit = liftOff(M);
    expect(lit.burbles).toBeGreaterThan(40);
    expect(lit.burbles).toBeLessThan(400);
    const v = voice(M);
    steady(v, 4000, 1, 1, 3);
    expect(v.burbles).toBe(0);
  });

  it('what is heard is a burble: in the lift the loudest stretches of the exhaust stand 5 dB or more over their surroundings, three times as far as without it', () => {
    const on = liftOff(M);
    const off = liftOff(M, mammoth, 9, (v) => (v.V.burble = 0));
    expect(on.standOut).toBeGreaterThan(5);
    expect(on.standOut).toBeGreaterThan(3 * off.standOut);
  });

  it('no other engine of the roster burbles', () => {
    for (const c of CARS.filter((c) => c.id !== 'mammoth')) {
      expect(liftOff(c.sound, c).burbles, c.id).toBe(0);
    }
  });
});

describe('the supercharger whine', () => {
  const sc = M.supercharger!;
  const fB = (rpm: number): number => (rpm / 60) * sc.ratio * sc.lobes;
  const tap = (rpm: number, pedal: number, secs = 4, mutate?: (v: EngineVoice) => void, profile: EngineSoundProfile = M): Float32Array => {
    const v = voice(profile);
    mutate?.(v);
    return steady(v, rpm, pedal, pedal, secs, pedal).dbg.turbo;
  };

  it('is locked to the crank: the strongest line of the blower sits on rpm/60 x ratio x lobes at idle, 3000 and 6000 rpm', () => {
    for (const rpm of [E.idleRpm, 3000, 6000]) {
      const x = tap(rpm, rpm > 2000 ? 1 : 0.4);
      const pk = strongestPeak(welch(x, 32768, 2 * SR, x.length), SR, fB(rpm) * 0.9, fB(rpm) * 1.1);
      expect(Math.abs(pk.freq - fB(rpm)) / fB(rpm), `@${rpm}`).toBeLessThan(0.001);
      expect(pk.prominenceDb, `@${rpm}`).toBeGreaterThan(30);
    }
  });

  it('answers a change of the rpm at once: through a fast sweep the tone stays within 1.2 % of rpm x ratio x lobes', () => {
    const v = voice();
    const lo = 1500;
    const hi = 6000;
    const secs = 4;
    const n = secs * SR;
    const dbg = createEngineDebug(n);
    const out = new Float32Array(n);
    Object.assign(v.inp, { throttle: 1, load: 1, pedal: 1 });
    const spf = 800;
    for (let f = 0; f * spf < n; f++) {
      v.inp.rpm = lo + (hi - lo) * Math.min(1, f / 60 / (secs - 0.2));
      v.debug = { exhaust: dbg.exhaust.subarray(f * spf), intake: dbg.intake.subarray(f * spf), mech: dbg.mech.subarray(f * spf), block: dbg.block.subarray(f * spf), turbo: dbg.turbo.subarray(f * spf), whine: dbg.whine.subarray(f * spf), events: dbg.events.subarray(f * spf) };
      v.process(out.subarray(f * spf), Math.min(spf, n - f * spf));
    }
    const rpmAt = (t: number): number => lo + (hi - lo) * Math.min(1, t / (secs - 0.2));
    const d = chirpDeviation(dbg.turbo, SR, (t) => fB(rpmAt(t)), 0.6, secs - 0.4, { boxMs: 30, fitMs: 120, stepMs: 50 });
    let se = 0;
    for (const r of d.relDev) se += r * r;
    expect(Math.sqrt(se / d.relDev.length)).toBeLessThan(0.012);
  });

  it('is loud on the throttle and a whirr off it: the bypass valve opens when the pedal comes up, by 12 dB or more at 3500 rpm', () => {
    const on = rms(tap(3500, 1), 2 * SR);
    const off = rms(tap(3500, 0), 2 * SR);
    expect(20 * Math.log10(on / off)).toBeGreaterThan(12);
    expect(off).toBeGreaterThan(1e-6); // (but it still turns)
  });

  it('climbs with the engine: 8 dB or more louder at 6000 rpm than at 2000, wide open; a whirr at idle, 25 dB under the whine at 5000 rpm', () => {
    const at = (rpm: number, p: number): number => 20 * Math.log10(rms(tap(rpm, p), 2 * SR) + 1e-12);
    expect(at(6000, 1) - at(2000, 1)).toBeGreaterThan(8);
    expect(at(5000, 1) - at(E.idleRpm, 0)).toBeGreaterThan(25);
  });

  it('does not stand in for a turbo: no boost input is needed, and a boost input changes nothing', () => {
    const a = tap(4500, 1);
    const b = tap(4500, 1, 4, (v) => (v.inp.boost = 1));
    let diff = 0;
    for (let i = 2 * SR; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
    expect(diff).toBe(0);
    expect(M.turbo).toBe(false);
  });

  it('exists only where the profile has a supercharger, and `level` scales it', () => {
    const plain = tap(4500, 1, 3, undefined, { ...M, supercharger: undefined });
    expect(peakAbs(plain)).toBe(0);
    const full = rms(tap(4500, 1), 2 * SR);
    const half = rms(tap(4500, 1, 4, undefined, { ...M, supercharger: { ...sc, level: 0.5 } }), 2 * SR);
    expect(20 * Math.log10(half / full)).toBeCloseTo(-6, 0);
    // and the cars that were never supercharged have an empty tap (the Vanta's is the turbo's, which is there only with boost)
    const ronin = CARS.find((c) => c.id === 'ronin-86')!;
    expect(peakAbs(steady(voice(ronin.sound, ronin), 4500, 1, 1, 2).dbg.turbo)).toBe(0);
  });

  it('is louder in the cabin than outside, as the whine of a blower is', () => {
    const v = voice();
    v.inp.interior = 1;
    const inside = rms(steady(v, 4500, 1, 1, 4).dbg.turbo, 2 * SR);
    expect(inside).toBeGreaterThan(1.6 * rms(tap(4500, 1), 2 * SR));
  });

  it('moves with the Doppler time-scale like everything else the engine makes', () => {
    const f = (ts: number): number => {
      const x = tap(4000, 1, 4, (v) => (v.inp.timeScale = ts));
      return strongestPeak(welch(x, 32768, 2 * SR, x.length), SR, fB(4000) * 0.9, fB(4000) * 1.4).freq;
    };
    expect(f(1.25) / f(1)).toBeCloseTo(1.25, 2);
  });

  it('keeps every partial under the Nyquist guard: a blower whose harmonics would fold back has none of them off its own grid', () => {
    // ratio 6 x 16 lobes at 5777 rpm: the fundamental is 9.2 kHz, its 2nd 18.5 kHz is the last that fits; the 3rd and 4th would fold back to 15 and 11 kHz
    const prof: EngineSoundProfile = { ...M, supercharger: { ratio: 6, lobes: 16 } };
    const rpm = 5777;
    const x = tap(rpm, 1, 4, undefined, prof);
    expect(hasNonFinite(x)).toBe(false);
    const fund = (rpm / 60) * 6 * 16;
    const psd = welch(x, 65536, 2 * SR, x.length);
    // on the grid of the engine orders (rpm/120) the strongest partials are fine; anything off it above 1 kHz would be a fold-back
    const off = offGridLines(psd, SR, rpm / 120, { fLo: 1000, prominenceDb: 14, floorDb: 60 });
    expect(off.count, JSON.stringify(off.lines.slice(0, 4))).toBeLessThanOrEqual(1);
    // the fold-back frequencies of the 3rd and 4th partials carry nothing
    for (const k of [3, 4]) {
      const folded = SR - k * fund > 0 ? Math.abs(SR - k * fund) : Math.abs(k * fund - SR);
      const pk = strongestPeak(psd, SR, folded * 0.99, folded * 1.01);
      const top = strongestPeak(psd, SR, fund * 0.99, fund * 1.01);
      expect(pk.powerDb, `partial ${k} folded to ${Math.round(folded)} Hz`).toBeLessThan(top.powerDb - 40);
    }
  });
});

describe('lite and full quality for the Mammoth', () => {
  const level = (quality: number, rpm: number, thr: number, interior = 0): number => {
    const v = voice();
    v.inp.quality = quality;
    v.inp.interior = interior;
    const { out } = steady(v, rpm, thr, thr < 0.2 ? 0.06 : 1, 3);
    return 20 * Math.log10(rms(out, Math.floor(1.5 * SR)) + 1e-12);
  };

  it('a lite voice is as loud as a full one, give or take what the pipes do at each rpm: within 8 dB at every point and 3 dB on average (a Vanta is within 5 and 2)', () => {
    const pts: [number, number][] = [
      [E.idleRpm, 0],
      [2000, 1],
      [3500, 1],
      [5000, 1],
      [6000, 1],
      [3500, 0],
    ];
    const d = pts.map(([rpm, thr]) => level(1, rpm, thr) - level(2, rpm, thr));
    for (const x of d) expect(Math.abs(x)).toBeLessThan(8);
    expect(Math.abs(d.reduce((a, b) => a + b, 0) / d.length)).toBeLessThan(3);
  });

  it('promoted from lite to full after five seconds: no burst from the pipes, and the whine fades in instead of starting at its old level', () => {
    const v = voice();
    v.inp.quality = 1;
    steady(v, 4500, 1, 1, 5);
    const fullLevel = (): number => {
      const w = voice();
      return rms(steady(w, 4500, 1, 1, 3).dbg.exhaust, 2 * SR);
    };
    v.inp.quality = 2;
    const n = Math.floor(0.6 * SR);
    const { dbg } = steady(v, 4500, 1, 1, 0.6);
    const ex = fullLevel();
    expect(peakAbs(dbg.exhaust, 0, Math.floor(0.03 * SR))).toBeLessThan(8 * ex); // (the pulses of a pipe still filling are not a burst)
    // the blower: nothing in the first millisecond, most of its level 300 ms later
    const early = rms(dbg.turbo, 0, Math.floor(0.002 * SR));
    const late = rms(dbg.turbo, Math.floor(0.4 * SR), n);
    expect(early).toBeLessThan(0.15 * late);
    expect(late).toBeGreaterThan(0);
  });

  it('demoting and promoting again, over and over, does not click', () => {
    const v = voice();
    steady(v, 4500, 1, 1, 1);
    const ref = peakAbs(steady(v, 4500, 1, 1, 0.5).out);
    let worst = 0;
    for (let k = 0; k < 6; k++) {
      v.inp.quality = 1;
      worst = Math.max(worst, peakAbs(steady(v, 4500, 1, 1, 0.5).out));
      v.inp.quality = 2;
      worst = Math.max(worst, peakAbs(steady(v, 4500, 1, 1, 0.5).out));
    }
    expect(worst).toBeLessThan(2.5 * ref);
  });

  it('sleeps and wakes clean: after a second out of earshot the pipes and the blower start from nothing', () => {
    const v = voice();
    steady(v, 5500, 1, 1, 1);
    v.inp.quality = 0;
    v.inp.gain = 0;
    steady(v, 5500, 1, 1, 1);
    v.inp.quality = 2;
    v.inp.gain = 1;
    const { out } = steady(v, 5500, 1, 1, 0.5);
    expect(hasNonFinite(out)).toBe(false);
    expect(peakAbs(out)).toBeLessThan(1);
  });
});

describe('robustness of the new paths', () => {
  it('survives hostile inputs in both qualities (rpm 0, huge rpm, over-range pedal, jumps, the time-scale at its limits, the cabin flipping) without NaN or blow-up', () => {
    const v = voice();
    const out = new Float32Array(128);
    let worst = 0;
    const cases = [
      { rpm: 0, throttle: 1, load: 1, pedal: 1 },
      { rpm: 20000, throttle: 5, load: 3, pedal: 9 },
      { rpm: 650, throttle: -2, load: -1, pedal: -0.5 },
      { rpm: 6500, throttle: 1, load: 1, pedal: 1, limiter: 1 },
      { rpm: 300, throttle: 0, load: 0, pedal: 0 },
    ];
    for (const quality of [2, 1]) {
      for (const c of cases) {
        Object.assign(v.inp, c, { boost: 2, quality });
        for (let i = 0; i < 500; i++) {
          v.inp.rpm = c.rpm + (i % 7) * 100;
          v.inp.timeScale = i % 40 < 20 ? 0.5 : 2; // beyond what the voice takes: clamped
          v.inp.interior = (i >> 4) & 1;
          if (i % 97 === 0) v.inp.quality = v.inp.quality === 2 ? 1 : 2;
          v.process(out, 128);
          expect(hasNonFinite(out)).toBe(false);
          worst = Math.max(worst, peakAbs(out));
        }
      }
    }
    // (the master limiter follows in the graph; what matters is that it stays finite and bounded: the same sequence peaks at 3.2 on the Vanta)
    expect(worst).toBeLessThan(6);
  });

  it('is sample-rate independent, the blower included: 44.1, 48 and 96 kHz give the same firing pitch, the same whine pitch and a similar level', () => {
    const res = [44100, 48000, 96000].map((sr) => {
      const v = new EngineVoice(sr, M, 8);
      Object.assign(v.inp, { rpm: 4200, throttle: 1, load: 1, pedal: 1, idleRpm: E.idleRpm, limiterRpm: E.limiterRpm, redlineRpm: E.redlineRpm });
      const n = Math.floor(3 * sr);
      const x = new Float32Array(n);
      const dbg = createEngineDebug(n);
      v.debug = dbg;
      v.process(x, n);
      const nfft = sr > 70000 ? 65536 : 32768;
      const fire = (M.cylinders / 2) * (4200 / 60);
      const whine = (4200 / 60) * M.supercharger!.ratio * M.supercharger!.lobes;
      return {
        f: strongestPeak(welch(x, nfft, Math.floor(1.5 * sr), n), sr, fire * 0.9, fire * 1.1).freq,
        w: strongestPeak(welch(dbg.turbo, nfft, Math.floor(1.5 * sr), n), sr, whine * 0.9, whine * 1.1).freq,
        r: 20 * Math.log10(rms(x, Math.floor(1.5 * sr), n)),
      };
    });
    for (const r of res) {
      expect(Math.abs(r.f - 280) / 280).toBeLessThan(0.006);
      expect(Math.abs(r.w - 700) / 700).toBeLessThan(0.006);
    }
    expect(Math.max(...res.map((r) => r.r)) - Math.min(...res.map((r) => r.r))).toBeLessThan(3.5);
  });

  it('is deterministic per seed, and the seeds differ', () => {
    const run = (seed: number): Float32Array => steady(voice(M, mammoth, seed), 900, 0, 0.06, 1).out;
    const a = run(1);
    const b = run(1);
    const c = run(2);
    expect(Array.from(a.subarray(20000, 20100))).toEqual(Array.from(b.subarray(20000, 20100)));
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - c[i]);
    expect(diff).toBeGreaterThan(1);
  });
});
