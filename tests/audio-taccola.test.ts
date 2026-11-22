/**
 * The Taccola's engine (headless): a naturally aspirated 6.4 L 60-degree V12 to 10,600 rpm in a closed mid-engined road car, each bank
 * an inline six through its own exhaust to its own pair of tailpipes, an airbox of open trumpets under a scoop on the roof. What the
 * shared engine code gained for it is measured here with the same analysis the browser report uses:
 *
 *  - the V12: it fires every 60 degrees, six times a turn, so its firing line is the 6th order of the crank; each bank fires three times
 *    a turn, so every line of its exhaust is on a multiple of 3 x rpm/60 and nothing is on the half orders (a balanced six does not
 *    rumble); loudness measured over its own revs, with 3 dB taken off; no clipping at the limiter, nothing folded back.
 *  - the twin exhaust (EngineSoundProfile.exhaustSystem 'twin'): the two banks' systems are not quite twins, so the lines of one six
 *    (the 3rd, 9th, 15th orders) stand between the twelve's (the 6th, 12th, 18th), most through the middle of the revs; and its mufflers
 *    absorb what the pipes' ends send back, so the note rises to the limiter steady and through every gear of a drive.
 *  - the induction's note (EngineSoundProfile.induction): on the orders, following the throttle, far louder in the cockpit than outside,
 *    and adding to the exhaust instead of beating against it, so the cockpit rises to the limiter too.
 *  - the gearbox as the game drives it (the real physics, with the roster's gearing and with the gearing and the drag the physics was
 *    tuned to on its own branch): an upshift that breaks the note for about the gearbox's 50 ms, the blipped downshifts, a restrained
 *    crackle; its level against the other cars.
 *
 * TACCOLA_LOG=1 npx vitest run tests/audio-taccola.test.ts --reporter=verbose prints the numbers behind the bounds.
 */
import { Quaternion, Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { CARS } from '../src/cars';
import type { CarDefinition, EngineSoundProfile } from '../src/core/contracts';
import { bandPower, hasNonFinite, offGridLines, orderFamilies, peakAbs, rms, strongestPeak, welch } from '../src/audio/analysis';
import { CarFrame } from '../src/audio/carsound';
import { CTL, readEngineInputs } from '../src/audio/controls';
import { bankFiringIntervals, buildLayout } from '../src/audio/dsp/engine-layout';
import { EngineVoice, calibratedExhaustGain, createEngineDebug, deriveVoicing, exhaustTargetDb, measureExhaustSweepRms, profileTargetDb, type EngineDebug, type Voicing } from '../src/audio/dsp/engine-voice';
import { makeLimiterCurve, volumeCurve } from '../src/audio/graph';
import { makeListener } from '../src/audio/spatial';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { PhysicsWorld, createFlatTrack } from '../src/physics';

const SR = 48000;
const taccola = CARS.find((c) => c.id === 'taccola')!;
const P = taccola.sound;
const E = taccola.physics.engine;
const db = (x: number): number => 20 * Math.log10(x + 1e-12);
const pdb = (x: number): number => 10 * Math.log10(x + 1e-20);
const LOG = !!process.env.TACCOLA_LOG;
const log = (s: string): void => {
  if (LOG) console.log(s);
};

/**
 * The same car on the gearing and the drag its physics was tuned to on its own branch (closer ratios, a taller first, a CdA of 1.08):
 * what is claimed of a drive through the physics is claimed with the roster's car and with this one, so that it holds when the two meet.
 */
const retuned: CarDefinition = {
  ...taccola,
  physics: {
    ...taccola.physics,
    drivetrain: { ...taccola.physics.drivetrain, gears: [2.922, 2.219, 1.78, 1.461, 1.226, 1.04, 0.892] },
    aero: { ...taccola.physics.aero, dragArea: 1.08, straightMode: { ...taccola.physics.aero.straightMode!, dragArea: 0.86 } },
  },
};
const DRIVEN: [string, CarDefinition][] = [['the roster\'s car', taccola], ['retuned', retuned]];

function voice(profile: EngineSoundProfile = P, seed = 5, sr = SR): EngineVoice {
  const v = new EngineVoice(sr, profile, seed);
  Object.assign(v.inp, { idleRpm: E.idleRpm, limiterRpm: E.limiterRpm, redlineRpm: E.redlineRpm });
  return v;
}

/** A steady render with the debug taps, flat out unless told otherwise. */
function steady(v: EngineVoice, rpm: number, thr: number, load: number, secs: number, nitro = 0): { out: Float32Array; dbg: EngineDebug } {
  Object.assign(v.inp, { rpm, throttle: thr, load, pedal: thr, boost: 0, nitro });
  const n = Math.floor(secs * v.sr);
  const out = new Float32Array(n);
  const dbg = createEngineDebug(n);
  v.debug = dbg;
  v.process(out, n);
  return { out, dbg };
}

/** The power of the line on `order` of the crank (within 1.5 % of it). */
const line = (psd: Float64Array, rpm: number, order: number): number => bandPower(psd, SR, (order * rpm * 0.985) / 60, (order * rpm * 1.015) / 60);

/** Of the power on the multiples of the 3rd order up to 12 kHz, the share on the odd ones (the 3rd, 9th, 15th...: one bank's lines). */
function oddShare(x: Float32Array, rpm: number): number {
  const psd = welch(x, 32768, SR, x.length);
  let even = 0;
  let odd = 0;
  for (let o = 3; (o * rpm) / 60 < 12000; o += 3) {
    if (o % 6 === 0) even += line(psd, rpm, o);
    else odd += line(psd, rpm, o);
  }
  return odd / (even + odd);
}

/**
 * The level steady at every `step` rpm from `from` to the limiter: the slope of the line fitted to it (dB per 1000 rpm), the rms about that
 * line and about the parabola fitted to it (the ripple without the curve of the rise), the worst step up of 1500 rpm and the deepest sag
 * (the most the level falls from any point to a later one).
 */
function sweep(profile: EngineSoundProfile, interior: number, from = 4000, step = 150, mutate?: (v: EngineVoice) => void): { slope: number; line: number; parab: number; worst: number; sag: number; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let rpm = from; rpm <= E.limiterRpm; rpm += step) {
    const v = voice(profile);
    v.inp.interior = interior;
    mutate?.(v);
    xs.push(rpm / 1000);
    ys.push(db(rms(steady(v, rpm, 1, 1, 1.0).out, Math.floor(0.4 * SR))));
  }
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const u = xs.map((x) => x - mx);
  const S = (p: number): number => u.reduce((a, x) => a + x ** p, 0);
  const T = (p: number): number => u.reduce((a, x, i) => a + x ** p * ys[i], 0);
  const resid = (c0: number, c1: number, c2: number): number => Math.sqrt(u.reduce((a, x, i) => a + (ys[i] - c0 - c1 * x - c2 * x * x) ** 2, 0) / n);
  const slope = T(1) / S(2);
  // the parabola by least squares (the centred powers: their first moment is 0)
  const s2 = S(2);
  const s3 = S(3);
  const s4 = S(4);
  const t0 = T(0);
  const t1 = T(1);
  const t2 = T(2);
  // [n 0 s2; 0 s2 s3; s2 s3 s4] c = [t0 t1 t2]
  const det = n * (s2 * s4 - s3 * s3) + s2 * (0 * s3 - s2 * s2);
  const c0 = (t0 * (s2 * s4 - s3 * s3) + s2 * (t1 * s3 - s2 * t2)) / det;
  const c1 = (n * (t1 * s4 - s3 * t2) + s2 * (s2 * t1 * 0 + s3 * t0 - t1 * s2) - s2 * (0)) / det;
  const c2 = (n * (s2 * t2 - s3 * t1) + t0 * (0 * s3 - s2 * s2)) / det;
  const k = Math.round(1500 / step);
  let worst = 99;
  for (let i = 0; i + k < n; i++) worst = Math.min(worst, ys[i + k] - ys[i]);
  let sag = 0;
  let best = -999;
  for (const y of ys) {
    best = Math.max(best, y);
    sag = Math.min(sag, y - best);
  }
  return { slope, line: resid(t0 / n, slope, 0), parab: resid(c0, c1, c2), worst, sag, ys };
}

/** One control frame of a drive through the real physics: the control vector the game makes, and the road speed. */
interface Frame {
  vec: Float32Array;
  kmh: number;
}

/**
 * A car on a flat plane through the real physics at `hz` frames a second, the gearbox shifting itself, heard from 6 m behind it by a
 * listener that moves with it (the chase camera) or from its cockpit: `pedal(t, kmh)` gives the throttle and the brake. `startKmh` in
 * `gear` places it rolling.
 */
function drive(car: CarDefinition, hz: number, secs: number, pedal: (t: number, kmh: number) => { thr: number; brk: number }, startKmh = 0, gear = 1, interior = 0): Frame[] {
  const world = new PhysicsWorld(createFlatTrack());
  const v = world.addVehicle(car);
  // (the gear before the car is placed, so that the engine is placed at the revs of that gear)
  v.gear = gear;
  v.placeOnGround(new Vector3(), new Quaternion(), startKmh / 3.6);
  v.setTemperatures(1);
  const cf = new CarFrame(true);
  const L = makeListener();
  const frames: Frame[] = [];
  for (let f = 0; f < secs * hz; f++) {
    const c = pedal(f / hz, v.state.speed * 3.6);
    v.controls.throttle = c.thr;
    v.controls.brake = c.brk;
    world.step(1 / hz);
    const st = v.state;
    L.px = st.position.x;
    L.py = st.position.y + 1;
    L.pz = st.position.z - 6;
    L.vx = st.velocity.x;
    L.vy = st.velocity.y;
    L.vz = st.velocity.z;
    cf.compute(st, 1 / hz, L, interior, 2, false);
    frames.push({ vec: cf.vec.slice(), kmh: st.speed * 3.6 });
  }
  return frames;
}

/** The voice of `car` fed the frames of a drive as the worklet is, one frame's worth of samples at a time; `held`: the shift's cut not bridged. */
function hear(frames: Frame[], hz: number, car: CarDefinition = taccola, seed = 1, held = false): Float32Array {
  const v = new EngineVoice(SR, car.sound, seed);
  v.helmet = car.visual.openCockpit === true;
  if (held) v.V.bridgeCut = false;
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

describe('what the profile asks for is all the shared voice does for the Taccola', () => {
  it('is a naturally aspirated V12 to the limiter of the physics in a closed car: no turbo, no blower, no electric motor, no ignition cut; its fields agree with the physics and stay inside what the voice can take', () => {
    expect([P.cylinders, P.layout, P.crankType, P.displacement, P.turbo, P.exhaustSystem]).toEqual([12, 'v', 'flat', 6.4, false, 'twin']);
    expect([P.electric, P.electricTaper, P.supercharger, P.blowOff, P.wastegate, P.ignitionCut]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(E.turbo).toBe(null);
    expect(E.electric).toBe(undefined);
    expect(taccola.visual.openCockpit).not.toBe(true);
    expect(P.limiterRpm).toBe(E.limiterRpm);
    expect(E.limiterRpm).toBeLessThanOrEqual(20000);
    expect(E.idleRpm).toBeLessThanOrEqual(5000);
    // (the voice bridges the throttle the gearbox shuts for an upshift for 40 ms at most: the physics shuts it for the first half and the
    // clutch takes the second, which a control frame shows as 33 to 35 ms of a 50 ms shift)
    expect(taccola.physics.drivetrain.shiftTime).toBeLessThanOrEqual(0.06);
    const V = deriveVoicing(P, buildLayout(P));
    expect([V.turbo, V.blower, V.electric, V.lope, V.burble, V.idleWobble, V.ignitionCut]).toEqual([false, false, 0, 0, 0, 0.03, false]);
    expect([V.dual, V.twinEx, V.induction, V.shiftDip, V.bridgeCut, V.idleLiftTo]).toEqual([true, true, 1, 0.05, true, 4]);
  });

  it("only the Taccola has the twin exhaust, the induction's note and twelve cylinders: its pipes as long as a merged exhaust's, straight through and absorbing, and nothing else of its voicing changed", () => {
    for (const c of CARS) {
      const V = deriveVoicing(c.sound, buildLayout(c.sound));
      const mine = c.id === 'taccola';
      expect(c.sound.exhaustSystem === 'twin', c.id).toBe(mine);
      expect(V.twinEx, c.id).toBe(mine);
      expect(V.induction > 0, c.id).toBe(mine);
      expect(c.sound.cylinders === 12, c.id).toBe(mine);
      // (and so only its block is the quiet one, and only its intake's hiss gives way to a note)
      expect(V.blockGain, c.id).toBe(mine ? 0.5 : 2.1);
      expect(V.intakeGain, c.id).toBe(mine ? 0.65 * 0.4 : c.sound.turbo ? 0.5 : 0.65);
    }
    const L = buildLayout(P);
    const t = deriveVoicing(P, L);
    const m = deriveVoicing({ ...P, exhaustSystem: undefined }, L);
    for (const k of ['Ls', 'Lm', 'Lc', 'Lq', 'Lt'] as const) expect(t[k], k).toBe(m[k]);
    expect([t.rc, t.rq, t.Rc]).toEqual([1.1, 0.03, 0.3]);
    expect(t.Ro / m.Ro).toBeCloseTo(0.05, 12);
    expect([t.dualLen, t.dualMuff, t.dualGain, t.dualDelay, t.dualFloor, t.dualFade]).toEqual([[1, 1], [1, 1], [1.18, 0.82], 0.00008, 0.4, [0.5, 1]]);
    const twinOnly: (keyof Voicing)[] = ['rc', 'rq', 'Rc', 'Ro', 'dual', 'twinEx', 'dualLen', 'dualMuff', 'dualGain', 'dualDelay', 'dualFloor', 'dualFade', 'liteGain'];
    for (const k of Object.keys(m) as (keyof Voicing)[]) {
      if (twinOnly.includes(k)) continue;
      expect(t[k], k).toEqual(m[k]);
    }
  });
});

describe('the V12', () => {
  it('fires evenly six times a turn: 60 degrees apart, each bank an inline six that fires every 120', () => {
    const L = buildLayout(P);
    expect(L.cylinders).toBe(12);
    expect(L.banks).toBe(2);
    expect(L.cyl.map((c) => c.fireDeg)).toEqual([0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660]);
    expect(L.bankCount).toEqual([6, 6]);
    for (const b of [0, 1]) expect(bankFiringIntervals(L, b)).toEqual([120, 120, 120, 120, 120, 120]);
    expect(L.firingHzPerRpm * 60).toBeCloseTo(6, 12);
    // (1060 Hz at the limiter)
    expect(L.firingHzPerRpm * E.limiterRpm).toBeCloseTo(1060, 6);
  });

  const revs = [3000, 5000, 7000, 9000, Math.round(E.redlineRpm * 0.97)];

  it("every line of its exhaust is on a multiple of 3 x rpm/60, a bank's firing: 90 % and more of the power on them from 3000 rpm to the top, the strongest low line the 6th order, and the half orders between them 25 dB and more under it", () => {
    for (const rpm of revs) {
      const { out, dbg } = steady(voice(), rpm, 1, 1, 5);
      const f0 = rpm / 120;
      let nfft = 1 << 15;
      while (SR / nfft > f0 / 9 && nfft < 1 << 18) nfft <<= 1;
      // (the multiples of 6 x f0 are those of the 3rd order of the crank)
      const of = orderFamilies(welch(dbg.exhaust, nfft, Math.floor(1.5 * SR), dbg.exhaust.length), SR, f0, 6, 40, 12000);
      expect(of.fire / (of.fire + of.half + of.whole + of.between), `@${rpm}`).toBeGreaterThan(0.9);
      const f = 6 * (rpm / 60);
      const psd = welch(out, 32768, Math.floor(1.2 * SR), out.length);
      const pk = strongestPeak(psd, SR, f * 0.9, f * 1.1);
      expect(Math.abs(pk.freq - f) / f, `@${rpm}`).toBeLessThan(0.002);
      expect(pk.prominenceDb, `@${rpm}`).toBeGreaterThan(12);
      const sixth = pdb(line(psd, rpm, 6));
      for (const o of [1.5, 4.5, 7.5]) expect(pdb(line(psd, rpm, o)) - sixth, `order ${o} @${rpm}`).toBeLessThan(-25);
    }
  });

  it('is two sixes singing together: through the middle of the revs the 3rd, 9th and 15th orders stand 8 to 26, 4 to 20 and 3 to 18 dB under the 6th, a tenth to four tenths of the power on the lines; at the top it is under half of that; through one merged pipe the same engine has under a fiftieth', () => {
    const rows: string[] = [];
    let mid = 0;
    for (const rpm of [4000, 5000, 6000]) {
      const { out } = steady(voice(), rpm, 1, 1, 3);
      const psd = welch(out, 32768, SR, out.length);
      const sixth = pdb(line(psd, rpm, 6));
      const rel = (o: number): number => pdb(line(psd, rpm, o)) - sixth;
      const share = oddShare(out, rpm);
      rows.push(`${rpm}: 3rd ${rel(3).toFixed(1)}, 9th ${rel(9).toFixed(1)}, 15th ${rel(15).toFixed(1)}, 12th ${rel(12).toFixed(1)}, 18th ${rel(18).toFixed(1)} dB, odd share ${share.toFixed(3)}`);
      expect(rel(3), `3rd @${rpm}`).toBeGreaterThan(-26);
      expect(rel(3), `3rd @${rpm}`).toBeLessThan(-8);
      expect(rel(9), `9th @${rpm}`).toBeGreaterThan(-20);
      expect(rel(9), `9th @${rpm}`).toBeLessThan(-4);
      expect(rel(15), `15th @${rpm}`).toBeGreaterThan(-18);
      expect(rel(15), `15th @${rpm}`).toBeLessThan(-3);
      // (and the twelve's own lines stay the strong ones: the 12th and the 18th within 8 dB of the 6th)
      for (const o of [12, 18]) expect(Math.abs(rel(o)), `order ${o} @${rpm}`).toBeLessThan(8);
      expect(share, `@${rpm}`).toBeGreaterThan(0.1);
      expect(share, `@${rpm}`).toBeLessThan(0.4);
      mid += share / 3;
      expect(oddShare(steady(voice({ ...P, exhaustSystem: 'merged' }), rpm, 1, 1, 3).out, rpm), `merged @${rpm}`).toBeLessThan(0.02);
    }
    for (const rpm of [9500, 10300]) {
      const share = oddShare(steady(voice(), rpm, 1, 1, 3).out, rpm);
      rows.push(`${rpm}: odd share ${share.toFixed(3)}`);
      expect(share, `@${rpm}`).toBeLessThan(0.5 * mid);
      expect(share, `@${rpm}`).toBeGreaterThan(0.03);
    }
    log(`taccola orders against the 6th:\n  ${rows.join('\n  ')}`);
  });

  it('rises to the limiter flat out: steady from 4000 rpm to the limiter 1.2 dB and more every 1000 rpm, within 0.5 dB rms of the parabola fitted to it, every step up of 1500 rpm louder by 0.4 dB and no point 0.5 dB under an earlier one; through one merged pipe the same engine ripples by 1.5 dB and more and falls 4 dB on its way up', () => {
    const twin = sweep(P, 0);
    const merged = sweep({ ...P, exhaustSystem: 'merged' }, 0);
    const show = (s: ReturnType<typeof sweep>): string => `slope ${s.slope.toFixed(2)} dB/1000 rpm, rms about the line ${s.line.toFixed(2)}, about the parabola ${s.parab.toFixed(2)}, worst step up of 1500 rpm ${s.worst.toFixed(2)}, deepest sag ${s.sag.toFixed(2)} dB`;
    log(`taccola sweep 4000 rpm..limiter: twin ${show(twin)}\n  merged ${show(merged)}`);
    expect(twin.slope, show(twin)).toBeGreaterThan(1.2);
    expect(twin.parab, show(twin)).toBeLessThan(0.5);
    expect(twin.worst, show(twin)).toBeGreaterThan(0.4);
    expect(twin.sag, show(twin)).toBeGreaterThan(-0.5);
    expect(merged.line, show(merged)).toBeGreaterThan(1.5);
    expect(merged.sag, show(merged)).toBeLessThan(-4);
  });

  it('its loudness is measured as it is driven, over its own revs, and 3 dB is taken off it: on its own target there, 3 dB under what its openness and its 6.4 L would give, and far under the gain the nominal 2200..6300 rpm would give it', () => {
    const g = calibratedExhaustGain(P, SR);
    expect(profileTargetDb(P)).toBeCloseTo(exhaustTargetDb(P.exhaustOpenness, P.displacement) - 3, 12);
    expect(Math.abs(db(measureExhaustSweepRms(P, SR, g)) - profileTargetDb(P))).toBeLessThan(0.6);
    const nominal = db(calibratedExhaustGain({ ...P, limiterRpm: undefined, loudnessDb: undefined }, SR));
    log(`taccola exhaust gain ${db(g).toFixed(1)} dB; over the nominal revs and with nothing taken off ${nominal.toFixed(1)} dB`);
    expect(db(g) - nominal).toBeLessThan(-6);
  });

  it("does not clip at the limiter: its peak stays under 1.4 through the cut, and after the game's gains at the default volumes under the knee of the soft limiter; under full scale at 0.97 of the redline, outside and in the cockpit", () => {
    const a = DEFAULT_SETTINGS.audio;
    const toMaster = Math.SQRT1_2 * volumeCurve(a.engine) * volumeCurve(a.master);
    const curve = makeLimiterCurve();
    // (flat out at the limiter as the game drives it: the load of the torque left there, the controls.ts mapping)
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
    for (const interior of [0, 1]) {
      const v = voice(P, 3);
      v.inp.interior = interior;
      expect(peakAbs(steady(v, E.redlineRpm * 0.97, 1, 1, 2.4).out, Math.floor(0.3 * SR)), `interior ${interior}`).toBeLessThan(1);
    }
  });

  it('folds nothing back: at 44.1 and 48 kHz, at 0.97 of the redline and at the limiter, outside and in the cockpit (where the induction is loudest), no line off the engine-order grid up to Nyquist', () => {
    for (const sr of [44100, 48000]) {
      for (const rpm of [E.redlineRpm * 0.97, E.limiterRpm]) {
        for (const interior of [0, 1]) {
          const v = voice(P, 17, sr);
          Object.assign(v.inp, { rpm, throttle: 1, load: 1, pedal: 1, boost: 0, driveOmega: 0, interior });
          // (6.5 s, six spectra averaged: on the one spectrum of 3.2 s a bin of the rasp between the lines can stand 14 dB over its
          // neighbours by chance, as one did at 44.1 kHz with this seed and with none of seven others)
          const x = new Float32Array(Math.floor(6.5 * sr));
          v.process(x, x.length);
          const psd = welch(x, 65536, Math.floor(1.2 * sr), x.length);
          const name = `${sr} Hz @${Math.round(rpm)} interior ${interior}`;
          const near = offGridLines(psd, sr, rpm / 120, { fLo: 1000, prominenceDb: 14, floorDb: 60 });
          const all = offGridLines(psd, sr, rpm / 120, { fLo: 1000, fHi: 0.49 * sr, prominenceDb: 14, floorDb: 80 });
          expect(near.count, `${name}: ${JSON.stringify(near.lines.slice(0, 4))}`).toBe(0);
          expect(all.count, `${name}: ${JSON.stringify(all.lines.slice(0, 4))}`).toBe(0);
        }
      }
    }
  });

  it("idles evenly at 1000 rpm: a hum on the firing line and its harmonics with one bank's lines under them and nothing on the half orders, its level over ten seconds within 2.5 dB from one two-turn cycle of the engine to another, where the Mammoth's cammed V8 lopes through twice the Taccola's and more", () => {
    // the level of each 720 degree cycle at the idle's revs, over ten seconds: the spread from the quietest to the loudest
    const spread = (car: CarDefinition): { lv: number; span: number; out: Float32Array } => {
      const e = car.physics.engine;
      const v = new EngineVoice(SR, car.sound, 4);
      Object.assign(v.inp, { idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, redlineRpm: e.redlineRpm });
      const { out } = steady(v, e.idleRpm, 0, 0.06, 12);
      const w = Math.floor((120 / e.idleRpm) * SR);
      const lv: number[] = [];
      for (let i = 2 * SR; i + w <= out.length; i += w) lv.push(db(rms(out, i, i + w)));
      return { lv: db(rms(out, 2 * SR)), span: Math.max(...lv) - Math.min(...lv), out };
    };
    const mine = spread(taccola);
    const mammoth = spread(CARS.find((c) => c.id === 'mammoth')!);
    const psd = welch(mine.out, 1 << 17, 2 * SR, mine.out.length);
    const sixth = pdb(line(psd, E.idleRpm, 6));
    for (const o of [1.5, 4.5, 7.5]) expect(pdb(line(psd, E.idleRpm, o)) - sixth, `order ${o}`).toBeLessThan(-20);
    expect(pdb(line(psd, E.idleRpm, 3)) - sixth).toBeLessThan(-6);
    log(`taccola idle ${mine.lv.toFixed(1)} dB, from cycle to cycle within ${mine.span.toFixed(2)} dB (the Mammoth ${mammoth.span.toFixed(2)})`);
    expect(mine.span).toBeLessThan(2.5);
    expect(mammoth.span).toBeGreaterThan(2 * mine.span);
  });

  /**
   * The backfires of eight lift-offs through the real physics, where the crackle of an overrun comes from (the physics counts a few after
   * a lift at high revs, as many as the profile's crackle gives, and the voice pops once for each): the car in its top gear at 0.8 of
   * its redline, flat out for a second and a half and off the pedal for two seconds, eight times over. How many each lift-off had.
   */
  const liftOffs = (car: CarDefinition): number[] => {
    const d = car.physics.drivetrain;
    const gear = d.gears.length;
    const kmh = ((0.8 * car.physics.engine.redlineRpm * 2 * Math.PI) / 60 / (d.gears[gear - 1] * d.finalDrive)) * car.physics.tireRear.radius * 3.6;
    const frames = drive(car, 60, 28, (t) => ({ thr: t % 3.5 < 1.5 ? 1 : 0, brk: 0 }), kmh, gear);
    const at = (f: number): number => frames[Math.min(f, frames.length - 1)].vec[CTL.BACKFIRE_COUNT];
    return [0, 1, 2, 3, 4, 5, 6, 7].map((k) => at(Math.round((3.5 * k + 3.5) * 60) - 1) - at(Math.round((3.5 * k + 1.5) * 60) - 1));
  };

  /**
   * The pops of a stop from 280 km/h in 6th, a second and a half flat out and then the brakes down to 70 km/h, counted where every pop
   * of the voice goes through: the lift-off's backfires and, for an exhaust that crackles enough, one after each blipped downshift.
   */
  const popsOfAStop = (car: CarDefinition): { pops: number; downshifts: number } => {
    let braking = true;
    const frames = drive(car, 60, 6, (t, kmh) => {
      if (kmh < 70) braking = false;
      return t < 1.5 ? { thr: 1, brk: 0 } : { thr: 0, brk: braking ? 1 : 0 };
    }, 280, 6);
    const v = new EngineVoice(SR, car.sound, 2);
    v.helmet = car.visual.openCockpit === true;
    const spy = v as unknown as { firePop(size: number): void };
    const fire = spy.firePop.bind(v);
    let pops = 0;
    spy.firePop = (size) => {
      pops++;
      fire(size);
    };
    const buf = new Float32Array(SR / 60);
    for (const fr of frames) {
      readEngineInputs(fr.vec, v.inp);
      v.process(buf, buf.length);
    }
    return { pops, downshifts: shiftsOf(frames).filter((f) => frames[f].vec[CTL.GEAR] < frames[Math.max(0, f - 6)].vec[CTL.GEAR]).length };
  };

  it("crackles with restraint on the overrun, a road car's exhaust: of eight lift-offs at speed none has more than one backfire and three and more have one, under half as many in all as the LMP-X's; braking down through five gears it pops twice at most, where the LMP-X and the Dieci pop after every downshift; a backfire stands 7 dB and more over the overrun it pops in", () => {
    const lmp = CARS.find((c) => c.id === 'lmp-x')!;
    const mine = liftOffs(taccola);
    const theirs = liftOffs(lmp);
    const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
    const stop = popsOfAStop(taccola);
    const stops = [lmp, CARS.find((c) => c.id === 'dieci')!].map(popsOfAStop);
    log(`taccola backfires on eight lift-offs: ${mine.join(' ')} (the LMP-X ${theirs.join(' ')}); a stop through ${stop.downshifts} downshifts: ${stop.pops} pops (the LMP-X ${stops[0].pops} in ${stops[0].downshifts}, the Dieci ${stops[1].pops} in ${stops[1].downshifts})`);
    expect(Math.max(...mine)).toBeLessThanOrEqual(1);
    expect(sum(mine)).toBeGreaterThanOrEqual(3);
    expect(sum(mine)).toBeLessThan(0.5 * sum(theirs));
    expect(stop.downshifts).toBeGreaterThanOrEqual(4);
    expect(stop.pops).toBeLessThanOrEqual(2);
    for (const s of stops) expect(s.pops).toBeGreaterThanOrEqual(s.downshifts);
    for (const seed of [1, 2, 3, 4]) {
      const v = voice(P, seed);
      steady(v, E.redlineRpm * 0.75, 0, 0, 1.2);
      const before = steady(v, E.redlineRpm * 0.7, 0, 0, 0.25).out;
      v.inp.backfireCount += 1;
      const after = steady(v, E.redlineRpm * 0.7, 0, 0, 0.05).out;
      expect(db(peakAbs(after) / rms(before, Math.floor(0.05 * SR))), `seed ${seed}`).toBeGreaterThan(7);
    }
  });

  it('a distant Taccola in lite quality is as loud as in full within 2 dB and keeps a bank heard over the other: the 3rd order 10 to 22 dB under the 6th', () => {
    for (const rpm of [3000, 6000, 9000]) {
      const at = (quality: number): Float32Array => {
        const v = voice();
        v.inp.quality = quality;
        return steady(v, rpm, 1, 1, 3).out;
      };
      const lite = at(1);
      expect(Math.abs(db(rms(lite, SR)) - db(rms(at(2), SR))), `@${rpm}`).toBeLessThan(2);
      const psd = welch(lite, 32768, SR, lite.length);
      const rel = pdb(line(psd, rpm, 3)) - pdb(line(psd, rpm, 6));
      expect(rel, `@${rpm}`).toBeLessThan(-10);
      expect(rel, `@${rpm}`).toBeGreaterThan(-28);
    }
  });
});

describe("the induction's note", () => {
  const tapOf = (rpm: number, thr: number, interior: number, profile: EngineSoundProfile = P, secs = 3): { out: Float32Array; dbg: EngineDebug } => {
    const v = voice(profile);
    v.inp.interior = interior;
    return steady(v, rpm, thr, thr, secs);
  };

  it('is on the orders of the crank: 99 % of its power on the multiples of 3 x rpm/60 at 4000, 7000 and 10,000 rpm, the lines of one bank between those of both', () => {
    for (const rpm of [4000, 7000, 10000]) {
      const x = tapOf(rpm, 1, 1).dbg.induction!;
      const f0 = rpm / 120;
      let nfft = 1 << 15;
      while (SR / nfft > f0 / 9 && nfft < 1 << 18) nfft <<= 1;
      const of = orderFamilies(welch(x, nfft, SR, x.length), SR, f0, 6, 40, 12000);
      expect(of.fire / (of.fire + of.half + of.whole + of.between), `@${rpm}`).toBeGreaterThan(0.99);
      const share = oddShare(x, rpm);
      expect(share, `@${rpm}`).toBeGreaterThan(0.05);
      expect(share, `@${rpm}`).toBeLessThan(0.3);
    }
  });

  it('follows the air the engine breathes: silent with the throttle shut, 10 dB and more under flat out at a third of the pedal, and louder with the revs', () => {
    const lv = (rpm: number, thr: number): number => db(rms(tapOf(rpm, thr, 1).dbg.induction!, SR));
    expect(lv(7000, 0)).toBeLessThan(-100);
    expect(lv(7000, 1) - lv(7000, 0.33)).toBeGreaterThan(10);
    expect(lv(10000, 1) - lv(5000, 1)).toBeGreaterThan(4);
  });

  it('is heard in the cockpit far more than outside, the scoop over the driver\'s head: 15 dB and more louder there, and from 6000 rpm flat out within 6 dB of the exhaust that comes through the cabin', () => {
    const rows: string[] = [];
    for (const rpm of [6000, 8000, 10000]) {
      const inside = tapOf(rpm, 1, 1);
      const outside = tapOf(rpm, 1, 0);
      const ind = db(rms(inside.dbg.induction!, SR));
      const exh = db(rms(inside.dbg.exhaust, SR));
      rows.push(`${rpm}: the note ${ind.toFixed(1)} dB in the cockpit (${db(rms(outside.dbg.induction!, SR)).toFixed(1)} outside), the exhaust through the cabin ${exh.toFixed(1)}, outside ${db(rms(outside.dbg.exhaust, SR)).toFixed(1)}`);
      expect(ind - db(rms(outside.dbg.induction!, SR)), `@${rpm}`).toBeGreaterThan(15);
      expect(Math.abs(ind - exh), `@${rpm}`).toBeLessThan(6);
      // (and outside it is far under the exhaust)
      expect(db(rms(outside.dbg.exhaust, SR)) - db(rms(outside.dbg.induction!, SR)), `@${rpm}`).toBeGreaterThan(15);
    }
    log(`taccola induction:\n  ${rows.join('\n  ')}`);
  });

  it('adds to the exhaust and does not beat against it: at every 150 rpm from 4000 rpm to the limiter the cockpit is louder with the note than without it, and it rises to the limiter (0.8 dB and more every 1000 rpm, within 0.6 dB rms of its parabola, no point 0.8 dB under an earlier one); outside the note never takes anything off', () => {
    const withNote = sweep(P, 1);
    const without = sweep({ ...P, induction: undefined }, 1);
    const gain = withNote.ys.map((y, i) => y - without.ys[i]);
    log(`taccola cockpit sweep: slope ${withNote.slope.toFixed(2)} dB/1000 rpm, about the parabola ${withNote.parab.toFixed(2)}, worst step ${withNote.worst.toFixed(2)}, sag ${withNote.sag.toFixed(2)} dB; the note adds ${Math.min(...gain).toFixed(1)}..${Math.max(...gain).toFixed(1)} dB`);
    expect(Math.min(...gain)).toBeGreaterThan(0.5);
    expect(withNote.slope).toBeGreaterThan(0.8);
    expect(withNote.parab).toBeLessThan(0.6);
    expect(withNote.sag).toBeGreaterThan(-0.8);
    const out = sweep(P, 0).ys;
    const outWithout = sweep({ ...P, induction: undefined }, 0, 4000, 150, (v) => (v.V.intakeGain = deriveVoicing(P, buildLayout(P)).intakeGain)).ys;
    const outGain = out.map((y, i) => y - outWithout[i]);
    log(`taccola outside: the note adds ${Math.min(...outGain).toFixed(2)}..${Math.max(...outGain).toFixed(2)} dB`);
    expect(Math.min(...outGain)).toBeGreaterThan(-0.2);
    expect(Math.max(...outGain)).toBeLessThan(2.5);
  });

  it('makes the cockpit a note and not a hiss: flat out from 5000 rpm 85 % and more of its power is on the lines, where without the note and with the whole of the intake\'s hiss under 70 % is', () => {
    const share = (x: Float32Array, rpm: number): number => {
      const psd = welch(x, 32768, SR, x.length);
      let on = 0;
      for (let o = 3; (o * rpm) / 60 < 12000; o += 3) on += line(psd, rpm, o);
      return on / bandPower(psd, SR, 40, 12000);
    };
    for (const rpm of [5000, 7000, 9000, 10300]) {
      expect(share(tapOf(rpm, 1, 1).out, rpm), `@${rpm}`).toBeGreaterThan(0.85);
      expect(share(tapOf(rpm, 1, 1, { ...P, induction: undefined }).out, rpm), `without @${rpm}`).toBeLessThan(0.7);
    }
  });

  it('exists only where the profile asks for it, `induction` scales it, and a lite voice does not render it', () => {
    for (const c of CARS.filter((c) => c.id !== 'taccola')) {
      const e = c.physics.engine;
      const v = new EngineVoice(SR, c.sound, 5);
      Object.assign(v.inp, { idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, redlineRpm: e.redlineRpm, interior: 1 });
      expect(peakAbs(steady(v, e.redlineRpm * 0.8, 1, 1, 0.5).dbg.induction!), c.id).toBe(0);
    }
    const full = db(rms(tapOf(8000, 1, 1).dbg.induction!, SR));
    expect(full - db(rms(tapOf(8000, 1, 1, { ...P, induction: 0.5 }).dbg.induction!, SR))).toBeCloseTo(6.02, 1);
    const v = voice();
    Object.assign(v.inp, { interior: 1, quality: 1 });
    expect(peakAbs(steady(v, 8000, 1, 1, 0.5).dbg.induction!)).toBe(0);
  });
});

describe('through the real physics, as the game drives it', () => {
  const rates = [60, 144];
  const runs = new Map<string, Frame[]>();
  const key = (name: string, hz: number): string => `${name}@${hz}`;
  beforeAll(() => {
    // flat out from a standstill on a flat plane for 16 s, up through the gears
    for (const [name, car] of DRIVEN) for (const hz of rates) runs.set(key(name, hz), drive(car, hz, 16, () => ({ thr: 1, brk: 0 })));
  });

  it('rises through every gear: flat out from rest every gear from the 3rd on that it runs out is louder at its top than at its bottom by 0.4 dB and more, and none sags by 0.5 dB on its way up, at 60 and 144 frames a second, outside and in the cockpit', () => {
    for (const [name, car] of DRIVEN)
      for (const hz of rates)
        for (const interior of [0, 1]) {
          const frames = interior ? drive(car, hz, 16, () => ({ thr: 1, brk: 0 }), 0, 1, 1) : runs.get(key(name, hz))!;
          const out = hear(frames, hz, car);
          const spf = Math.round(SR / hz);
          const shifts = shiftsOf(frames);
          expect(shifts.length, `${name}, ${hz} Hz`).toBeGreaterThanOrEqual(4);
          const rows: string[] = [];
          // each gear from 120 ms after the shift into it to 60 ms before the counter of the shift out of it, in 50 ms windows smoothed over three
          for (let k = 1; k + 1 < shifts.length; k++) {
            const g = frames[shifts[k]].vec[CTL.GEAR];
            if (g < 3) continue;
            const a = shifts[k] * spf + Math.floor(0.12 * SR);
            const b = shifts[k + 1] * spf - Math.floor(0.06 * SR) - Math.ceil(0.05 * SR);
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
            const q = Math.max(1, Math.floor(lv.length / 4));
            const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
            const rise = mean(lv.slice(-q)) - mean(lv.slice(0, q));
            rows.push(`gear ${g}: +${rise.toFixed(1)} dB, sag ${sag.toFixed(2)}`);
            const where = `${name}, ${hz} Hz, interior ${interior}, gear ${g}: ${sm.map((x) => x.toFixed(1)).join(' ')}`;
            expect(sag, where).toBeGreaterThan(-0.5);
            expect(rise, where).toBeGreaterThan(0.4);
          }
          expect(rows.length, `${name}, ${hz} Hz`).toBeGreaterThanOrEqual(2);
          log(`taccola gears, ${name}, ${hz} Hz, interior ${interior}: ${rows.join('; ')}`);
        }
  });

  /**
   * Each upshift of a drive into a gear `gears` accepts (4 ms windows of the voice): the ms within 250 ms of the start of the shift in which
   * the note is 3 dB and more under the lower of its level before the shift and its level after it (the revs fall by a sixth, and the note
   * with them), and the deepest window against the level before. `held`: the shift's cut not bridged.
   */
  const upshifts = (frames: Frame[], hz: number, car: CarDefinition, held: boolean, gears: (g: number) => boolean, interior = 0): { gear: number; ms: number; deep: number }[] => {
    const out = hear(frames, hz, car, 1, held);
    void interior;
    const spf = Math.round(SR / hz);
    const w = Math.floor(0.004 * SR);
    return shiftsOf(frames)
      .filter((f) => gears(frames[f].vec[CTL.GEAR]) && (f + 1) * spf + Math.floor(0.3 * SR) < out.length)
      .map((f) => {
        // (the cut is before the counter steps: the shift's frames start a shift's time earlier)
        const at = (f - Math.ceil(0.05 * hz) - 1) * spf;
        const before = rms(out, at - Math.floor(0.06 * SR), at);
        const after = rms(out, f * spf + Math.floor(0.15 * SR), f * spf + Math.floor(0.21 * SR));
        const ref = Math.min(before, after);
        let ms = 0;
        let deep = 0;
        for (let i = at; i < at + Math.floor(0.25 * SR); i += w) {
          const r = rms(out, i, i + w);
          if (r < 0.708 * ref) ms += 4;
          deep = Math.min(deep, db(r / before));
        }
        return { gear: frames[f].vec[CTL.GEAR], ms, deep };
      });
  };

  it("upshifts in the gearbox's 50 ms: from the 2-3 on the note breaks for 30 to 70 ms and 8 dB deep or more, at 60 and 144 frames a second, and in the cockpit, where the intake's hiss and the valve gear do not break, for 16 to 70 ms and 6 dB deep or more (held as the frames come and with a road car's dip it would be 80 ms and more)", () => {
    for (const [name, car] of DRIVEN)
      for (const hz of rates) {
        const frames = runs.get(key(name, hz))!;
        const now = upshifts(frames, hz, car, false, (g) => g >= 3);
        expect(now.length, `${name}, ${hz} Hz`).toBeGreaterThanOrEqual(3);
        log(`taccola upshifts, ${name}, ${hz} Hz: ${now.map((d) => `into ${d.gear}: ${d.ms} ms, ${d.deep.toFixed(1)} dB`).join('; ')}`);
        for (const d of now) {
          expect(d.ms, `${name}, ${hz} Hz: ${JSON.stringify(now)}`).toBeGreaterThanOrEqual(30);
          expect(d.ms, `${name}, ${hz} Hz: ${JSON.stringify(now)}`).toBeLessThanOrEqual(70);
          expect(d.deep, `${name}, ${hz} Hz: ${JSON.stringify(now)}`).toBeLessThan(-8);
        }
        // the cockpit, where the induction breaks with the exhaust
        const inside = drive(car, hz, 16, () => ({ thr: 1, brk: 0 }), 0, 1, 1);
        const cab = upshifts(inside, hz, car, false, (g) => g >= 3);
        log(`taccola upshifts in the cockpit, ${name}, ${hz} Hz: ${cab.map((d) => `into ${d.gear}: ${d.ms} ms, ${d.deep.toFixed(1)} dB`).join('; ')}`);
        for (const d of cab) {
          expect(d.ms, `cockpit, ${name}, ${hz} Hz: ${JSON.stringify(cab)}`).toBeGreaterThanOrEqual(16);
          expect(d.ms, `cockpit, ${name}, ${hz} Hz: ${JSON.stringify(cab)}`).toBeLessThanOrEqual(70);
          expect(d.deep, `cockpit, ${name}, ${hz} Hz: ${JSON.stringify(cab)}`).toBeLessThan(-6);
        }
        // as a road car's gearbox is heard (no shift dip of its own: the frames as they come, then 70 ms)
        const road: CarDefinition = { ...car, sound: { ...car.sound, shiftDip: undefined } };
        for (const d of upshifts(frames, hz, road, false, (g) => g >= 3)) expect(d.ms, `${name}, ${hz} Hz, a road car's dip`).toBeGreaterThanOrEqual(80);
      }
  });

  it('blips its downshifts: braking hard from 300 km/h in 6th it changes down four times and more, each with the throttle opened over the shift with the pedal up, and the blip heard 3 dB and more over the overrun', () => {
    for (const [name, car] of DRIVEN) {
      const hz = 60;
      let braking = true;
      const frames = drive(car, hz, 6, (t, kmh) => {
        if (kmh < 70) braking = false;
        return t < 1.5 ? { thr: 1, brk: 0 } : { thr: 0, brk: braking ? 1 : 0 };
      }, 300, 6);
      const out = hear(frames, hz, car, 2);
      const spf = Math.round(SR / hz);
      // (the gear changes halfway through a shift and the counter steps at its end)
      const downs = shiftsOf(frames).filter((f) => frames[f].vec[CTL.GEAR] < frames[Math.max(0, f - 6)].vec[CTL.GEAR]);
      expect(downs.length, name).toBeGreaterThanOrEqual(4);
      const rows: string[] = [];
      for (const f of downs) {
        // the first frame of the shift with the throttle open (the gearbox's blip, the pedal up)
        let fb = -1;
        for (let k = f - 5; k <= f; k++) if (fb < 0 && frames[k].vec[CTL.THROTTLE] > 0.3 && frames[k].vec[CTL.PEDAL] < 0.05) fb = k;
        expect(fb, `${name}: the downshift at ${(f / hz).toFixed(2)} s`).toBeGreaterThan(0);
        // the loudest 30 ms of the 120 ms from it, against the overrun of the 60 ms before it
        const a = fb * spf;
        const ref = rms(out, a - Math.floor(0.08 * SR), a - Math.floor(0.02 * SR));
        let loud = 0;
        for (let i = a; i < a + Math.floor(0.12 * SR); i += Math.floor(0.01 * SR)) loud = Math.max(loud, rms(out, i, i + Math.floor(0.03 * SR)));
        rows.push(`${(f / hz).toFixed(2)} s into ${frames[f].vec[CTL.GEAR]}: +${db(loud / ref).toFixed(1)} dB`);
        expect(db(loud / ref), `${name}: the downshift at ${(f / hz).toFixed(2)} s`).toBeGreaterThan(3);
      }
      log(`taccola downshifts, ${name}: ${rows.join('; ')}`);
    }
  });

  it('is as loud as a road car among racing cars should be: flat out from rest for 14 s, after the first 4 s, the engine alone from the chase camera is within 2.5 dB of the Vanta GT and of the Dieci and no louder than the LMP-X; in the cockpit within 2.5 dB of the Vanta GT and the LMP-X', () => {
    const level = (id: string, interior: number): number => {
      const car = CARS.find((c) => c.id === id)!;
      const out = hear(drive(car, 60, 14, () => ({ thr: 1, brk: 0 }), 0, 1, interior), 60, car);
      return db(rms(out, 4 * SR));
    };
    const ids = ['taccola', 'vanta-gt', 'dieci', 'lmp-x'];
    const outside = ids.map((id) => level(id, 0));
    const inside = ids.map((id) => level(id, 1));
    log(`taccola run level: outside ${ids.map((id, i) => `${id} ${outside[i].toFixed(1)}`).join(', ')} dB; in the cockpit ${ids.map((id, i) => `${id} ${inside[i].toFixed(1)}`).join(', ')} dB`);
    expect(Math.abs(outside[0] - outside[1])).toBeLessThan(2.5);
    expect(Math.abs(outside[0] - outside[2])).toBeLessThan(2.5);
    expect(outside[0]).toBeLessThan(outside[3]);
    expect(Math.abs(inside[0] - inside[1])).toBeLessThan(2.5);
    expect(Math.abs(inside[0] - inside[3])).toBeLessThan(2.5);
  });
});

describe('the closed cabin and the nitro', () => {
  it('its cockpit is a cabin, not a helmet: the exhaust comes through it 3 dB and more under what is heard outside (the other closed cars lose 5.5 dB and more: a twin exhaust has less of a ringing pipe for the cabin to take off), and the cabin booms about 95 Hz as a helmet would not', () => {
    const boomShare = (x: Float32Array): number => {
      const psd = welch(x, 16384, SR, x.length);
      return bandPower(psd, SR, 80, 110) / bandPower(psd, SR, 40, 12000);
    };
    for (const rpm of [5000, 9000]) {
      const at = (interior: number, helmet: boolean): { out: Float32Array; dbg: EngineDebug } => {
        const v = voice();
        v.helmet = helmet;
        v.inp.interior = interior;
        return steady(v, rpm, 1, 1, 2.4);
      };
      const outside = at(0, false);
      const cabin = at(1, false);
      const ex = (r: { dbg: EngineDebug }): number => db(rms(r.dbg.exhaust, SR));
      log(`taccola cabin @${rpm}: the exhaust ${(ex(outside) - ex(cabin)).toFixed(1)} dB under outside, the boom's share ${boomShare(cabin.out).toExponential(2)} (a helmet ${boomShare(at(1, true).out).toExponential(2)})`);
      expect(ex(outside) - ex(cabin), `@${rpm}`).toBeGreaterThan(3);
      expect(boomShare(cabin.out), `@${rpm}`).toBeGreaterThan(1.5 * boomShare(at(1, true).out));
    }
  });

  it("its nitro is the ordinary bottle's: the voice is the same to the bit with a shot burning", () => {
    const run = (nitro: number): Float32Array => steady(voice(P, 3), 9000, 1, 1, 0.5, nitro).out;
    const a = run(0);
    const b = run(1);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
    expect(diff).toBe(0);
  });
});
