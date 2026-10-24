/**
 * The Dieci's engine (headless): a 2004-style 3.0 L V10 (flat crank, even firing, five pulses a turn) to 19,300 rpm, no turbo and nothing
 * electric, its two banks straight out through short open periscopes. What the shared engine code gives it is measured here with the same
 * analysis the browser report uses:
 *
 *  - the V10: every line of its exhaust on a multiple of 5 x rpm/60, its 5th, 10th and 15th orders the strong ones; loudness measured over
 *    its own revs; no clipping at the limiter and nothing folded back off the engine-order grid up to Nyquist at 44.1 and 48 kHz.
 *  - the short open exhaust (EngineSoundProfile.exhaustSystem 'short'): its ends reflect little, so the scream rises to the limiter where
 *    a close-ratio 7-speed keeps the engine, steady and through every gear of a drive through the real physics.
 *  - the gearbox as the game drives it (the real physics, whose gearbox shuts the throttle for a shift and blips it for a downshift): a
 *    short ignition cut on an upshift, not the Volta's seamless flick; the blipped downshifts under braking; the pops of the overrun; the
 *    traction control's cut heard as missed firings at the pedal's load (EngineSoundProfile.ignitionCut), a stutter and not a lull.
 *  - the open cockpit's helmet, as the Volta has it, and the ordinary nitro, which the voice does not hear.
 */
import { Quaternion, Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { CARS } from '../src/cars';
import type { EngineSoundProfile } from '../src/core/contracts';
import { bandPower, hasNonFinite, offGridLines, orderFamilies, peakAbs, rms, strongestPeak, welch } from '../src/audio/analysis';
import { CarFrame } from '../src/audio/carsound';
import { CTL, readEngineInputs } from '../src/audio/controls';
import { bankFiringIntervals, buildLayout } from '../src/audio/dsp/engine-layout';
import { EngineVoice, calibratedExhaustGain, createEngineDebug, deriveVoicing, exhaustTargetDb, measureExhaustSweepRms, type EngineDebug, type Voicing } from '../src/audio/dsp/engine-voice';
import { makeLimiterCurve, volumeCurve } from '../src/audio/graph';
import { makeListener } from '../src/audio/spatial';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { PhysicsWorld, createFlatTrack } from '../src/physics';

const SR = 48000;
const dieci = CARS.find((c) => c.id === 'dieci')!;
const P = dieci.sound;
const E = dieci.physics.engine;
const db = (x: number): number => 20 * Math.log10(x + 1e-12);

function voice(profile: EngineSoundProfile = P, seed = 5, sr = SR): EngineVoice {
  const v = new EngineVoice(sr, profile, seed);
  Object.assign(v.inp, { idleRpm: E.idleRpm, limiterRpm: E.limiterRpm, redlineRpm: E.redlineRpm });
  return v;
}

/** A steady render with the debug taps, flat out unless told otherwise (no boost: the engine has no turbo). */
function steady(v: EngineVoice, rpm: number, thr: number, load: number, secs: number, nitro = 0): { out: Float32Array; dbg: EngineDebug } {
  Object.assign(v.inp, { rpm, throttle: thr, load, pedal: thr, boost: 0, nitro });
  const n = Math.floor(secs * v.sr);
  const out = new Float32Array(n);
  const dbg = createEngineDebug(n);
  v.debug = dbg;
  v.process(out, n);
  return { out, dbg };
}

/** One control frame of a drive through the real physics: the control vector the game makes, and the road speed. */
interface Frame {
  vec: Float32Array;
  kmh: number;
}

/**
 * The Dieci on a flat plane through the real physics at `hz` frames a second, the gearbox shifting itself, heard from 6 m behind it by a
 * listener that moves with it (the chase camera): `pedal(t, kmh)` gives the throttle and the brake. `startKmh` in `gear` places it rolling.
 */
function drive(hz: number, secs: number, pedal: (t: number, kmh: number) => { thr: number; brk: number }, startKmh = 0, gear = 1): Frame[] {
  const world = new PhysicsWorld(createFlatTrack());
  const car = world.addVehicle(dieci);
  // (the gear before the car is placed, so that the engine is placed at the revs of that gear)
  car.gear = gear;
  car.placeOnGround(new Vector3(), new Quaternion(), startKmh / 3.6);
  car.setTemperatures(1);
  const cf = new CarFrame(true);
  const L = makeListener();
  const frames: Frame[] = [];
  for (let f = 0; f < secs * hz; f++) {
    const c = pedal(f / hz, car.state.speed * 3.6);
    car.controls.throttle = c.thr;
    car.controls.brake = c.brk;
    world.step(1 / hz);
    const st = car.state;
    L.px = st.position.x;
    L.py = st.position.y + 1;
    L.pz = st.position.z - 6;
    L.vx = st.velocity.x;
    L.vy = st.velocity.y;
    L.vz = st.velocity.z;
    cf.compute(st, 1 / hz, L, 0, 2, false);
    frames.push({ vec: cf.vec.slice(), kmh: st.speed * 3.6 });
  }
  return frames;
}

/**
 * The voice fed the frames of a drive as the worklet is, one frame's worth of samples at a time; `held`: the shift's cut not bridged;
 * `asLoad`: the traction control's cut heard as a lighter load, not as missed firings.
 */
function hear(frames: Frame[], hz: number, seed = 1, held = false, asLoad = false): Float32Array {
  const v = voice(P, seed);
  if (held) v.V.bridgeCut = false;
  if (asLoad) v.V.ignitionCut = false;
  const spf = Math.round(SR / hz);
  const out = new Float32Array(frames.length * spf);
  frames.forEach((fr, f) => {
    readEngineInputs(fr.vec, v.inp);
    v.process(out.subarray(f * spf), spf);
  });
  return out;
}

/** The frames at which the shift counter steps. */
const shiftsOf = (frames: Frame[]): number[] => frames.map((_, f) => f).filter((f) => f > 0 && frames[f].vec[CTL.SHIFT_COUNT] > frames[f - 1].vec[CTL.SHIFT_COUNT]);

describe('what the profile asks for is all the shared voice does for the Dieci', () => {
  it('is a 2004 V10 to the limiter of the physics: no turbo, no blower, no electric motor; its racing fields agree with the physics and stay inside what the voice can take', () => {
    expect([P.cylinders, P.layout, P.crankType, P.displacement, P.turbo, P.exhaustSystem]).toEqual([10, 'v', 'flat', 3.0, false, 'short']);
    expect([P.electric, P.electricTaper, P.supercharger, P.blowOff, P.wastegate]).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(E.turbo).toBe(null);
    expect(E.electric).toBe(undefined);
    expect(P.limiterRpm).toBe(E.limiterRpm);
    // (the voice takes the rpm and the limiter up to 20,000 and the idle up to 5000; it bridges a shift's cut for 40 ms at most)
    expect(E.limiterRpm).toBeLessThanOrEqual(20000);
    expect(E.idleRpm).toBeLessThanOrEqual(5000);
    expect(dieci.physics.drivetrain.shiftTime).toBeLessThanOrEqual(0.04);
    const V = deriveVoicing(P, buildLayout(P));
    expect([V.turbo, V.blower, V.electric, V.dual, V.lope, V.burble, V.idleWobble]).toEqual([false, false, 0, false, 0, 0, 0.03]);
    expect([V.shiftDip, V.bridgeCut, V.idleLiftTo, V.ignitionCut]).toEqual([0.04, true, 1.4, true]);
  });

  it("only the Dieci has the short exhaust and the ignition cut: its pipes 0.65 of the merged exhaust's, its ends reflecting little, and nothing else of its voicing changed", () => {
    for (const c of CARS) expect(c.sound.exhaustSystem === 'short', c.id).toBe(c.id === 'dieci');
    // (and only the Dieci's traction control cuts the spark: every other engine hears it as a lighter load)
    for (const c of CARS) expect(deriveVoicing(c.sound, buildLayout(c.sound)).ignitionCut, c.id).toBe(c.id === 'dieci');
    const L = buildLayout(P);
    const s = deriveVoicing(P, L);
    const m = deriveVoicing({ ...P, exhaustSystem: undefined }, L);
    for (const k of ['Ls', 'Lm', 'Lc', 'Lq', 'Lt'] as const) expect(s[k] / m[k], k).toBeCloseTo(0.65, 12);
    expect(s.Rc).toBe(0.2);
    expect(s.Ro / m.Ro).toBeCloseTo(0.45, 12);
    for (const k of Object.keys(m) as (keyof Voicing)[]) {
      if (['Ls', 'Lm', 'Lc', 'Lq', 'Lt', 'Rc', 'Ro'].includes(k)) continue;
      expect(s[k], k).toEqual(m[k]);
    }
  });
});

describe('the 2004 V10', () => {
  it('fires evenly five times a turn: 72 degrees apart, each bank every 144', () => {
    const L = buildLayout(P);
    expect(L.cylinders).toBe(10);
    expect(L.banks).toBe(2);
    expect(L.cyl.map((c) => c.fireDeg)).toEqual([0, 72, 144, 216, 288, 360, 432, 504, 576, 648]);
    for (const b of [0, 1]) expect(bankFiringIntervals(L, b)).toEqual([144, 144, 144, 144, 144]);
    expect(L.firingHzPerRpm * 60).toBeCloseTo(5, 12);
  });

  const tops = [8000, 12000, 16000, Math.round(E.redlineRpm * 0.97)];

  it('every line of its exhaust is a firing line, a multiple of 5 x rpm/60: 85 % and more of the power in the lines from 8000 rpm to the top of its revs, the strongest line near the firing frequency on it', () => {
    for (const rpm of tops) {
      const { out, dbg } = steady(voice(), rpm, 1, 1, 5);
      const f0 = rpm / 120;
      let nfft = 1 << 15;
      while (SR / nfft > f0 / 9 && nfft < 1 << 18) nfft <<= 1;
      const of = orderFamilies(welch(dbg.exhaust, nfft, Math.floor(1.5 * SR), dbg.exhaust.length), SR, f0, 10, 40, 12000);
      expect(of.fire / (of.fire + of.half + of.whole), `@${rpm}`).toBeGreaterThan(0.85);
      const f = 5 * (rpm / 60);
      const pk = strongestPeak(welch(out, 32768, Math.floor(1.2 * SR), out.length), SR, f * 0.9, f * 1.1);
      expect(Math.abs(pk.freq - f) / f, `@${rpm}`).toBeLessThan(0.002);
      expect(pk.prominenceDb, `@${rpm}`).toBeGreaterThan(12);
    }
  });

  it('its strong lines are the 5th, 10th and 15th orders of the crank: the 10th and 15th within 12 dB of the 5th, the half orders between them 18 dB and more under it', () => {
    for (const rpm of tops) {
      const { out } = steady(voice(), rpm, 1, 1, 3);
      const psd = welch(out, 32768, Math.floor(1.0 * SR), out.length);
      const line = (order: number): number => 10 * Math.log10(bandPower(psd, SR, (order * rpm * 0.985) / 60, (order * rpm * 1.015) / 60) + 1e-20);
      const fifth = line(5);
      for (const o of [10, 15]) expect(line(o) - fifth, `order ${o} @${rpm}`).toBeGreaterThan(-12);
      for (const o of [2.5, 7.5, 12.5]) expect(line(o) - fifth, `order ${o} @${rpm}`).toBeLessThan(-18);
    }
  });

  it('rises to the limiter flat out: over 14,500 rpm..the limiter 0.4 dB and more every 1000 rpm, within 0.6 dB of that line and no step up of 1500 rpm quieter by 0.5 dB; through the merged exhaust the same engine ripples by 1.5 dB and more', () => {
    const band = (profile: EngineSoundProfile): { slope: number; sd: number; worst: number } => {
      const xs: number[] = [];
      const ys: number[] = [];
      for (let rpm = 14500; rpm <= E.limiterRpm; rpm += 125) {
        xs.push(rpm / 1000);
        ys.push(db(rms(steady(voice(profile), rpm, 1, 1, 1.2).out, Math.floor(0.5 * SR))));
      }
      const n = xs.length;
      const mx = xs.reduce((a, b) => a + b, 0) / n;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      let sxy = 0;
      let sxx = 0;
      for (let i = 0; i < n; i++) {
        sxy += (xs[i] - mx) * (ys[i] - my);
        sxx += (xs[i] - mx) ** 2;
      }
      const slope = sxy / sxx;
      let se = 0;
      for (let i = 0; i < n; i++) se += (ys[i] - (my + slope * (xs[i] - mx))) ** 2;
      let worst = 99;
      for (let i = 0; i + 12 < n; i++) worst = Math.min(worst, ys[i + 12] - ys[i]);
      return { slope, sd: Math.sqrt(se / n), worst };
    };
    const short = band(P);
    expect(short.slope, JSON.stringify(short)).toBeGreaterThan(0.4);
    expect(short.sd, JSON.stringify(short)).toBeLessThan(0.6);
    expect(short.worst, JSON.stringify(short)).toBeGreaterThan(-0.5);
    const merged = band({ ...P, exhaustSystem: 'merged' });
    expect(merged.sd, JSON.stringify(merged)).toBeGreaterThan(1.5);
    expect(merged.worst, JSON.stringify(merged)).toBeLessThan(-3);
  });

  it('its loudness is measured as it is driven, over its own revs: on its target there, and 4 dB and more under the gain the nominal 2800..8000 rpm would give it', () => {
    const g = calibratedExhaustGain(P, SR);
    expect(Math.abs(db(measureExhaustSweepRms(P, SR, g)) - exhaustTargetDb(P.exhaustOpenness, P.displacement))).toBeLessThan(0.6);
    expect(db(g) - db(calibratedExhaustGain({ ...P, limiterRpm: undefined }, SR))).toBeLessThan(-4);
  });

  it("does not clip at the limiter: its peak stays under 1.4 through the cut, and after the game's gains at the default volumes under the knee of the soft limiter", () => {
    const a = DEFAULT_SETTINGS.audio;
    const toMaster = Math.SQRT1_2 * volumeCurve(a.engine) * volumeCurve(a.master);
    const curve = makeLimiterCurve();
    // (flat out at the limiter as the game drives it: the load of 330 Nm of 375 and the throttle, the controls.ts mapping)
    const torqueAt = E.torqueCurve.find(([r]) => r === E.limiterRpm)![1];
    const peak = Math.max(...E.torqueCurve.map(([, t]) => t));
    for (const seed of [1, 2, 3, 4, 5]) {
      const v = voice(P, seed);
      Object.assign(v.inp, { rpm: E.limiterRpm, throttle: 1, load: 0.5 * (torqueAt / peak) + 0.5, pedal: 1, boost: 0, limiter: 1 });
      const x = new Float32Array(Math.floor(2.4 * SR));
      v.process(x, x.length);
      const y = x.subarray(Math.floor(0.3 * SR));
      expect(hasNonFinite(y)).toBe(false);
      const pk = peakAbs(y);
      expect(pk, `seed ${seed}`).toBeLessThan(1.4);
      const m = pk * toMaster;
      expect(m, `seed ${seed}`).toBeLessThan(0.8);
      expect(curve[Math.round(((m + 1) / 2) * (curve.length - 1))]).toBeCloseTo(m, 2);
    }
    // and in the terms of tests/audio-dsp.test.ts (at 0.97 of the redline) under full scale
    const { out } = steady(voice(P, 3), E.redlineRpm * 0.97, 1, 1, 2.4);
    expect(peakAbs(out, Math.floor(0.3 * SR))).toBeLessThan(1);
  });

  it('folds nothing back: at 44.1 and 48 kHz, at 0.97 of the redline, at the limiter and at 20,000 rpm, no line off the engine-order grid up to Nyquist', () => {
    for (const sr of [44100, 48000]) {
      for (const rpm of [E.redlineRpm * 0.97, E.limiterRpm, 20000]) {
        const v = voice(P, 17, sr);
        Object.assign(v.inp, { rpm, throttle: 1, load: 1, pedal: 1, boost: 0, driveOmega: 0 });
        const x = new Float32Array(Math.floor(3.2 * sr));
        v.process(x, x.length);
        const psd = welch(x, 65536, Math.floor(1.2 * sr), x.length);
        // (the terms of tests/audio-dsp.test.ts, and every line down to 80 dB under the loudest up to 0.49 of the sample rate)
        const near = offGridLines(psd, sr, rpm / 120, { fLo: 1000, prominenceDb: 14, floorDb: 60 });
        const all = offGridLines(psd, sr, rpm / 120, { fLo: 1000, fHi: 0.49 * sr, prominenceDb: 14, floorDb: 80 });
        expect(near.count, `${sr} Hz @${Math.round(rpm)}: ${JSON.stringify(near.lines.slice(0, 4))}`).toBe(0);
        expect(all.count, `${sr} Hz @${Math.round(rpm)}: ${JSON.stringify(all.lines.slice(0, 4))}`).toBe(0);
      }
    }
  });

  it('pops on the overrun: a backfire stands 7 dB and more over the overrun it pops in', () => {
    for (const seed of [1, 2, 3, 4]) {
      const v = voice(P, seed);
      steady(v, E.redlineRpm * 0.75, 0, 0, 1.2);
      const before = steady(v, E.redlineRpm * 0.7, 0, 0, 0.25).out;
      v.inp.backfireCount += 1;
      const after = steady(v, E.redlineRpm * 0.7, 0, 0, 0.05).out;
      expect(db(peakAbs(after) / rms(before, Math.floor(0.05 * SR))), `seed ${seed}`).toBeGreaterThan(7);
    }
  });

  it("its traction control cuts the spark: with the pedal down and 0.6 of the torque left it is 3 dB or less under flat out, where heard as a lighter load it is 4.5 dB and more under; the missed firings rasp between the lines and leave no tone of their own", () => {
    // (the pedal down, the throttle after the traction control, and the load the controls.ts mapping gives near the torque peak)
    const at = (rpm: number, thr: number, cut: boolean): { out: Float32Array; dbg: EngineDebug } => {
      const v = voice(P, 5);
      v.V.ignitionCut = cut;
      Object.assign(v.inp, { rpm, throttle: thr, load: thr * (0.5 * 0.95 + 0.5), pedal: 1, boost: 0 });
      const n = 3 * SR;
      const out = new Float32Array(n);
      const dbg = createEngineDebug(n);
      v.debug = dbg;
      v.process(out, n);
      return { out, dbg };
    };
    for (const rpm of [8000, 12000, 16000]) {
      const level = (r: { out: Float32Array }): number => db(rms(r.out, SR));
      const flat = level(at(rpm, 1, true));
      const cut = at(rpm, 0.6, true);
      expect(flat - level(cut), `@${rpm}`).toBeLessThan(3);
      expect(flat - level(at(rpm, 0.6, false)), `@${rpm}`).toBeGreaterThan(4.5);
      // a third and more of the exhaust's power between the firing lines, where flat out nine tenths and more is on them
      const f0 = rpm / 120;
      let nfft = 1 << 15;
      while (SR / nfft > f0 / 9 && nfft < 1 << 18) nfft <<= 1;
      const of = orderFamilies(welch(cut.dbg.exhaust, nfft, SR, cut.dbg.exhaust.length), SR, f0, 10, 40, 12000);
      expect(of.fire / (of.fire + of.half + of.whole + of.between), `@${rpm}`).toBeLessThan(0.8);
      const off = offGridLines(welch(cut.out, 65536, SR, cut.out.length), SR, f0, { fLo: 1000, prominenceDb: 14, floorDb: 60 });
      expect(off.count, `@${rpm}: ${JSON.stringify(off.lines.slice(0, 4))}`).toBeLessThanOrEqual(2);
    }
  });

  it('pops now and then in the cut: with the pedal down and 0.6 of the torque left a cut charge lights in the pipe at crackle x 24 a second times the share cut, on the first cut as on one after a lift-off, within 30 % over eight seeds and once at the least in each', () => {
    // (the pops counted where every pop goes through, the voice's firePop)
    const pops = (seed: number, lift: boolean, secs: number): number => {
      const v = voice(P, seed);
      const spy = v as unknown as { firePop(size: number): void };
      const fire = spy.firePop.bind(v);
      let n = 0;
      spy.firePop = (size) => {
        n++;
        fire(size);
      };
      steady(v, 12000, 1, 1, 2);
      if (lift) {
        steady(v, 12000, 0, 0, 1.5);
        steady(v, 12000, 1, 1, 0.5);
      }
      n = 0;
      Object.assign(v.inp, { throttle: 0.6, load: 0.6 * (0.5 * 0.95 + 0.5), pedal: 1 });
      v.process(new Float32Array(secs * SR), secs * SR);
      return n;
    };
    for (const [lift, secs] of [[false, 3], [true, 2]] as const) {
      const counts = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => pops(seed, lift, secs));
      const expected = 8 * P.crackle * 24 * 0.4 * secs;
      const total = counts.reduce((a, b) => a + b, 0);
      expect(total / expected, `${lift ? 'after a lift-off' : 'the first cut'}: ${counts.join(', ')}`).toBeGreaterThan(0.7);
      expect(total / expected, `${lift ? 'after a lift-off' : 'the first cut'}: ${counts.join(', ')}`).toBeLessThan(1.3);
      expect(Math.min(...counts), `${lift ? 'after a lift-off' : 'the first cut'}: ${counts.join(', ')}`).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('through the real physics, as the game drives it', () => {
  const rates = [60, 144];
  const runs = new Map<number, Frame[]>();
  beforeAll(() => {
    // flat out from a standstill on a flat plane for 12 s: 314 km/h in 7th
    for (const hz of rates) runs.set(hz, drive(hz, 12, () => ({ thr: 1, brk: 0 })));
  });

  it('rises through every gear: flat out from rest the 4th, 5th and 6th gears are louder at their top than at their bottom, and no gear from the 3rd on sags by 1 dB on its way up, at 60 and 144 frames a second', () => {
    for (const hz of rates) {
      const frames = runs.get(hz)!;
      const out = hear(frames, hz);
      const spf = Math.round(SR / hz);
      const shifts = shiftsOf(frames);
      expect(shifts.length, `${hz} Hz`).toBe(6);
      // each gear from 100 ms after the shift into it to 30 ms before the shift out of it, in 50 ms windows smoothed over three
      for (let g = 3; g <= 7; g++) {
        const a = (shifts[g - 2] - 3) * spf + Math.floor(0.1 * SR);
        const b = (g - 1 < shifts.length ? (shifts[g - 1] - 3) * spf : out.length) - Math.floor(0.03 * SR);
        const w = Math.floor(0.05 * SR);
        const lv: number[] = [];
        for (let i = a; i + w <= b; i += w) lv.push(db(rms(out, i, i + w)));
        const sm = lv.map((_, i) => (lv[Math.max(0, i - 1)] + lv[i] + lv[Math.min(lv.length - 1, i + 1)]) / 3);
        let best = -999;
        let sag = 0;
        for (const x of sm) {
          best = Math.max(best, x);
          sag = Math.min(sag, x - best);
        }
        expect(sag, `${hz} Hz, gear ${g}: ${sm.map((x) => x.toFixed(1)).join(' ')}`).toBeGreaterThan(-1);
        if (g >= 4 && g <= 6) {
          const q = Math.floor(lv.length / 4);
          const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
          expect(mean(lv.slice(-q)) - mean(lv.slice(0, q)), `${hz} Hz, gear ${g}`).toBeGreaterThan(0.3);
        }
      }
    }
  });

  it('stutters on the traction control, not into a lull: flat out from rest, the frames of 1st gear in which it cuts are 3 dB and more louder than the same frames heard as a lighter load', () => {
    const hz = 60;
    const frames = runs.get(hz)!;
    const spf = Math.round(SR / hz);
    // the frames in 1st with the pedal down, the clutch in and the throttle under it: the traction control (or the launch control) cutting
    const cutting = frames.map((_, f) => f).filter((f) => {
      const x = frames[f].vec;
      return x[CTL.GEAR] === 1 && x[CTL.PEDAL] > 0.95 && x[CTL.CLUTCH] < 0.05 && x[CTL.THROTTLE] >= 0.05 && x[CTL.THROTTLE] < 0.97 * x[CTL.PEDAL];
    });
    expect(cutting.length).toBeGreaterThanOrEqual(30);
    const power = (out: Float32Array): number => {
      let s = 0;
      for (const f of cutting) s += rms(out, f * spf, (f + 1) * spf) ** 2;
      return 10 * Math.log10(s / cutting.length);
    };
    expect(power(hear(frames, hz)) - power(hear(frames, hz, 1, false, true))).toBeGreaterThan(3);
  });

  it("upshifts with a short ignition cut, not the Volta's seamless flick: from 4th on each upshift is under -3 dB for 20 to 40 ms and 6 dB deep or more, at 60 and 144 frames a second (held as the frames come, 36 ms and more at 60)", () => {
    // the ms under -3 dB of each upshift (4 ms windows of the voice, against the 60 ms before the cut), and the deepest window; from the
    // shift into 4th on, where the traction control has nothing to cut around the shift
    const dips = (frames: Frame[], hz: number, held: boolean): { ms: number; deep: number }[] => {
      const out = hear(frames, hz, 1, held);
      const spf = Math.round(SR / hz);
      const w = Math.floor(0.004 * SR);
      return shiftsOf(frames)
        .filter((f) => frames[f].vec[CTL.GEAR] >= 4)
        .map((f) => {
          // (the cut is before the counter steps: the shift's frames start up to three frames earlier)
          const at = (f - 3) * spf;
          const ref = rms(out, at - Math.floor(0.06 * SR), at);
          let ms = 0;
          let deep = 0;
          for (let i = at; i < at + Math.floor(0.15 * SR); i += w) {
            const r = rms(out, i, i + w);
            if (r < 0.708 * ref) ms += 4;
            deep = Math.min(deep, db(r / ref));
          }
          return { ms, deep };
        });
    };
    for (const hz of rates) {
      const frames = runs.get(hz)!;
      const now = dips(frames, hz, false);
      expect(now.length, `${hz} Hz`).toBe(4);
      for (const d of now) {
        expect(d.ms, `${hz} Hz: ${JSON.stringify(now)}`).toBeGreaterThanOrEqual(20);
        expect(d.ms, `${hz} Hz: ${JSON.stringify(now)}`).toBeLessThanOrEqual(40);
        expect(d.deep, `${hz} Hz: ${JSON.stringify(now)}`).toBeLessThan(-6);
      }
      if (hz === 60) for (const d of dips(frames, hz, true)) expect(d.ms, `${hz} Hz, held as the frames come`).toBeGreaterThanOrEqual(36);
    }
  });

  it('blips its downshifts: braking hard from 300 km/h in 7th it changes down five times and more within 2 s, each with the throttle opened over the shift and the blip heard 3 dB and more over the overrun', () => {
    const hz = 60;
    let braking = true;
    const frames = drive(hz, 4.5, (t, kmh) => {
      if (kmh < 70) braking = false;
      return t < 1.5 ? { thr: 1, brk: 0 } : { thr: 0, brk: braking ? 1 : 0 };
    }, 300, 7);
    const out = hear(frames, hz, 2);
    const spf = Math.round(SR / hz);
    // (the gear changes halfway through a shift and the counter steps at its end)
    const downs = shiftsOf(frames).filter((f) => frames[f].vec[CTL.GEAR] < frames[Math.max(0, f - 6)].vec[CTL.GEAR]);
    expect(downs.length).toBeGreaterThanOrEqual(5);
    expect((downs[4] - downs[0]) / hz).toBeLessThan(2);
    for (const f of downs) {
      // the first frame of the shift with the throttle open (the gearbox's blip, the pedal up)
      let fb = -1;
      for (let k = f - 4; k <= f; k++) if (fb < 0 && frames[k].vec[CTL.THROTTLE] > 0.3 && frames[k].vec[CTL.PEDAL] < 0.05) fb = k;
      expect(fb, `the downshift at ${(f / hz).toFixed(2)} s`).toBeGreaterThan(0);
      // the loudest 30 ms of the 120 ms from it, against the overrun of the 60 ms before it
      const a = fb * spf;
      const ref = rms(out, a - Math.floor(0.08 * SR), a - Math.floor(0.02 * SR));
      let loud = 0;
      for (let i = a; i < a + Math.floor(0.12 * SR); i += Math.floor(0.01 * SR)) loud = Math.max(loud, rms(out, i, i + Math.floor(0.03 * SR)));
      expect(db(loud / ref), `the downshift at ${(f / hz).toFixed(2)} s`).toBeGreaterThan(3);
    }
  });
});

describe('the open cockpit and the nitro', () => {
  it('the helmet hears the exhaust straight: within 4 dB of outside where a closed cabin takes 5.5 dB and more off it, and has no cabin to boom', () => {
    const boomShare = (x: Float32Array): number => {
      const psd = welch(x, 16384, SR, x.length);
      return bandPower(psd, SR, 80, 110) / bandPower(psd, SR, 40, 12000);
    };
    expect(dieci.visual.openCockpit).toBe(true);
    for (const rpm of [9000, 17000]) {
      const at = (interior: number, helmet: boolean): { out: Float32Array; dbg: EngineDebug } => {
        const v = voice();
        v.helmet = helmet;
        v.inp.interior = interior;
        return steady(v, rpm, 1, 1, 2.4);
      };
      const outside = at(0, false);
      const cabin = at(1, false);
      const helmet = at(1, true);
      const ex = (r: { dbg: EngineDebug }): number => db(rms(r.dbg.exhaust, SR));
      expect(ex(outside) - ex(helmet), `@${rpm}`).toBeLessThan(4);
      expect(ex(outside) - ex(cabin), `@${rpm}`).toBeGreaterThan(5.5);
      expect(boomShare(helmet.out), `@${rpm}`).toBeLessThan((2 / 3) * boomShare(cabin.out));
    }
  });

  it("its nitro is the ordinary bottle's: the voice is the same to the bit with a shot burning", () => {
    const run = (nitro: number): Float32Array => steady(voice(P, 3), 16000, 1, 1, 0.5, nitro).out;
    const a = run(0);
    const b = run(1);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
    expect(diff).toBe(0);
  });
});
