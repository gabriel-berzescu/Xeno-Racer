/**
 * Audio DSP tests (headless, Node): the engine model is plain TypeScript, so the real synthesis code
 * that runs in the AudioWorklet is exercised here directly and measured with the same analysis
 * routines the browser report uses.
 */
import { describe, expect, it } from 'vitest';
import { CARS } from '../src/cars';
import type { EngineSoundProfile } from '../src/core/contracts';
import {
  chirpDeviation,
  clickScore,
  hasNonFinite,
  harmonicShare,
  offGridLines,
  peakAbs,
  rms,
  spectralCentroid,
  strongestPeak,
  welch,
} from '../src/audio/analysis';
import { bankFiringIntervals, buildLayout } from '../src/audio/dsp/engine-layout';
import {
  EngineVoice,
  calibratedExhaustGain,
  createEngineDebug,
  exhaustTargetDb,
  measureExhaustSweepRms,
} from '../src/audio/dsp/engine-voice';

const SR = 48000;

function setSteady(v: EngineVoice, rpm: number, thr: number, load: number, limiterRpm = 8000): void {
  Object.assign(v.inp, { rpm, throttle: thr, load, idleRpm: 900, limiterRpm, redlineRpm: limiterRpm * 0.97, boost: 0, quality: 2 });
}

function render(v: EngineVoice, seconds: number): Float32Array {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  v.process(out, n);
  return out;
}

const profileOf = (id: string): EngineSoundProfile => CARS.find((c) => c.id === id)!.sound;

describe('engine layout (firing order, banks, headers)', () => {
  it('crossplane V8 has the uneven per-bank pulse pattern that burbles; flat-plane is even', () => {
    const cross = buildLayout({ cylinders: 8, layout: 'v', crankType: 'crossplane', displacement: 5, turbo: false, exhaustOpenness: 0.5, brightness: 0.5, gearWhine: 0, crackle: 0 });
    const flat = buildLayout({ cylinders: 8, layout: 'v', crankType: 'flat', displacement: 5, turbo: false, exhaustOpenness: 0.5, brightness: 0.5, gearWhine: 0, crackle: 0 });
    // crossplane: each bank fires 90 / 180 / 270 / 180 degree gaps (sums to 720)
    for (const b of [0, 1]) {
      const iv = bankFiringIntervals(cross, b);
      expect(iv.reduce((a, c) => a + c, 0)).toBe(720);
      expect(new Set(iv).size).toBeGreaterThan(1);
      expect(iv.slice().sort((a, c) => a - c)).toEqual([90, 180, 180, 270]);
    }
    for (const b of [0, 1]) expect(new Set(bankFiringIntervals(flat, b))).toEqual(new Set([180]));
  });

  it('V10 / V12 / I4 / I6 fire at even intervals; boxer fires bank by bank with unequal headers', () => {
    const mk = (cylinders: 4 | 6 | 8 | 10 | 12, layout: 'inline' | 'v' | 'flat', crank: 'flat' | 'crossplane' | 'boxer'): EngineSoundProfile => ({ cylinders, layout, crankType: crank, displacement: 3, turbo: false, exhaustOpenness: 0.5, brightness: 0.5, gearWhine: 0, crackle: 0 });
    const v10 = buildLayout(mk(10, 'v', 'flat'));
    expect(v10.cyl.map((c) => c.fireDeg)).toEqual([0, 72, 144, 216, 288, 360, 432, 504, 576, 648]);
    expect(new Set(bankFiringIntervals(v10, 0))).toEqual(new Set([144]));
    const i4 = buildLayout(mk(4, 'inline', 'flat'));
    expect(i4.banks).toBe(1);
    expect(i4.groups).toHaveLength(1);
    const boxer = buildLayout(mk(4, 'flat', 'boxer'));
    expect(boxer.banks).toBe(2);
    expect(bankFiringIntervals(boxer, 0)).toEqual([180, 540]); // two pulses, then silence from this bank
    expect(boxer.groups.map((g) => Math.round(g.lenM * 100)).sort()).toEqual([Math.round(boxer.groups[0].lenM * 100), Math.round(boxer.groups[1].lenM * 100)].sort());
    expect(Math.abs(boxer.groups[0].lenM - boxer.groups[1].lenM)).toBeGreaterThan(0.3); // unequal-length headers
  });

  it('intake pulsation is strong on an I4 and almost flat on a V10', () => {
    const i4 = buildLayout({ cylinders: 4, layout: 'inline', crankType: 'flat', displacement: 2, turbo: false, exhaustOpenness: 0.5, brightness: 0.5, gearWhine: 0, crackle: 0 });
    const v10 = buildLayout(profileOf('lmp-x'));
    expect(i4.intakeDepth).toBeGreaterThan(v10.intakeDepth + 0.15);
  });

  it('the event table is sorted and complete', () => {
    for (const c of CARS) {
      const L = buildLayout(c.sound);
      expect(L.evPhase.length).toBe(L.cylinders * 5);
      for (let i = 1; i < L.evPhase.length; i++) expect(L.evPhase[i]).toBeGreaterThanOrEqual(L.evPhase[i - 1]);
      expect(L.firingHzPerRpm).toBeCloseTo(c.sound.cylinders / 2 / 60, 12);
    }
  });
});

describe('engine voice: pitch, level, character', () => {
  for (const car of CARS) {
    it(`${car.id}: fundamental sits exactly on the firing frequency at every rpm`, () => {
      const e = car.physics.engine;
      for (const rpm of [e.idleRpm * 1.6, e.limiterRpm * 0.5, e.redlineRpm * 0.95]) {
        const v = new EngineVoice(SR, car.sound, 3);
        setSteady(v, rpm, 1, 1, e.limiterRpm);
        const x = render(v, 2.4);
        const psd = welch(x, 32768, Math.floor(1.2 * SR), x.length);
        const f = (car.sound.cylinders / 2) * (rpm / 60);
        const pk = strongestPeak(psd, SR, f * 0.9, f * 1.1);
        expect(Math.abs(pk.freq - f) / f).toBeLessThan(0.005);
        expect(pk.prominenceDb).toBeGreaterThan(12);
        expect(hasNonFinite(x)).toBe(false);
        expect(peakAbs(x)).toBeLessThan(1);
      }
    });
  }

  it('flat-plane V10 is a clean harmonic comb (scream); the boxer is much lumpier (rumble)', () => {
    const share = (id: string, rpmFrac: number): number => {
      const car = CARS.find((c) => c.id === id)!;
      const e = car.physics.engine;
      const v = new EngineVoice(SR, car.sound, 5);
      setSteady(v, e.limiterRpm * rpmFrac, 1, 1, e.limiterRpm);
      const x = render(v, 2.4);
      const f = (car.sound.cylinders / 2) * ((e.limiterRpm * rpmFrac) / 60);
      return harmonicShare(welch(x, 32768, Math.floor(1.2 * SR), x.length), SR, f, Math.max(1.5, f * 0.012), 40, 5000);
    };
    const v10 = share('lmp-x', 0.7);
    const boxer = share('ronin-86', 0.7);
    expect(v10).toBeGreaterThan(0.8);
    expect(boxer).toBeLessThan(v10 - 0.3);
  });

  // Pipe resonances make the centroid wander between neighbouring rpm values (harmonics crossing formants),
  // so the trend is judged on means over ten rpm points, like a spectrogram reads.
  it('spectral centroid rises with rpm and with load (means over ten rpm points)', () => {
    for (const car of CARS) {
      const e = car.physics.engine;
      const sweep = (load: number): { c: number[]; r: number[] } => {
        const c: number[] = [];
        const r: number[] = [];
        for (let k = 0; k < 10; k++) {
          const rpm = e.idleRpm * 1.3 + ((e.redlineRpm * 0.97 - e.idleRpm * 1.3) * k) / 9;
          const v = new EngineVoice(SR, car.sound, 21);
          Object.assign(v.inp, { rpm, throttle: load, load, idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, redlineRpm: e.redlineRpm, boost: car.sound.turbo ? 0.9 * load : 0 });
          const x = render(v, 2.2);
          c.push(spectralCentroid(welch(x, 16384, Math.floor(1.0 * SR), x.length), SR, 40, 12000));
          r.push(rms(x, Math.floor(1.0 * SR), x.length));
        }
        return { c, r };
      };
      const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
      const wot = sweep(1);
      const part = sweep(0.3);
      expect(mean(wot.c.slice(5)), `${car.id}: upper-half rpm brighter than lower half`).toBeGreaterThan(mean(wot.c.slice(0, 5)) * 1.1);
      expect(mean(wot.c), `${car.id}: full load brighter than part throttle`).toBeGreaterThan(mean(part.c) * 1.05);
      expect(mean(wot.r), `${car.id}: full load louder than part throttle`).toBeGreaterThan(mean(part.r) * 1.5);
      // and louder with rpm at full load
      expect(mean(wot.r.slice(5))).toBeGreaterThan(mean(wot.r.slice(0, 5)) * 1.3);
    }
  });

  it('is deterministic per seed and differs between seeds', () => {
    const car = CARS[0];
    const run = (seed: number): Float32Array => {
      const v = new EngineVoice(SR, car.sound, seed);
      setSteady(v, 4000, 1, 1);
      return render(v, 0.4);
    };
    const a = run(1);
    const b = run(1);
    const c = run(2);
    expect(Array.from(a.subarray(2000, 2100))).toEqual(Array.from(b.subarray(2000, 2100)));
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - c[i]);
    expect(diff).toBeGreaterThan(1);
  });

  it('survives hostile inputs (rpm 0, huge rpm, over-range throttle, sudden jumps) without NaN or blow-up', () => {
    const car = CARS[2];
    const v = new EngineVoice(SR, car.sound, 4);
    const out = new Float32Array(128);
    const cases = [
      { rpm: 0, throttle: 1, load: 1 },
      { rpm: 20000, throttle: 5, load: 3 },
      { rpm: 900, throttle: -2, load: -1 },
      { rpm: 7000, throttle: 1, load: 1, limiter: 1 },
      { rpm: 300, throttle: 0, load: 0 },
    ];
    let worst = 0;
    for (const c of cases) {
      Object.assign(v.inp, c, { idleRpm: 800, limiterRpm: 7600, redlineRpm: 7400, boost: 2 });
      for (let i = 0; i < 400; i++) {
        v.inp.rpm = c.rpm + (i % 7) * 100; // jittery control stream
        v.process(out, 128);
        expect(hasNonFinite(out)).toBe(false);
        worst = Math.max(worst, peakAbs(out));
      }
    }
    expect(worst).toBeLessThan(2);
  });

  it('Doppler time-scale shifts the whole firing series by the same ratio', () => {
    const car = CARS[0];
    const at = (ts: number): number => {
      const v = new EngineVoice(SR, car.sound, 6);
      setSteady(v, 4800, 1, 1);
      v.inp.timeScale = ts;
      const x = render(v, 2.4);
      const f = (car.sound.cylinders / 2) * (4800 / 60) * ts;
      return strongestPeak(welch(x, 32768, Math.floor(1.2 * SR), x.length), SR, f * 0.85, f * 1.15).freq;
    };
    const f1 = at(1);
    const f2 = at(1.25);
    expect(f2 / f1).toBeCloseTo(1.25, 2);
  });

  it('result is sample-rate independent (44.1 / 48 / 96 kHz: same pitch, similar level)', () => {
    const car = CARS[3];
    const res = [44100, 48000, 96000].map((sr) => {
      const v = new EngineVoice(sr, car.sound, 8);
      setSteady(v, 6000, 1, 1, 9500);
      const n = Math.floor(2.4 * sr);
      const x = new Float32Array(n);
      v.process(x, n);
      const psd = welch(x, 32768 * (sr / 48000 > 1.5 ? 2 : 1), Math.floor(1.2 * sr), n);
      const f = (car.sound.cylinders / 2) * (6000 / 60);
      return { f: strongestPeak(psd, sr, f * 0.9, f * 1.1).freq, r: 20 * Math.log10(rms(x, Math.floor(1.2 * sr), n)) };
    });
    for (const r of res) expect(Math.abs(r.f - 500) / 500).toBeLessThan(0.006);
    expect(Math.max(...res.map((r) => r.r)) - Math.min(...res.map((r) => r.r))).toBeLessThan(3.5);
  });

  it('lite quality is close in level to full; off is silent', () => {
    const car = CARS[1];
    const lvl = (q: number): number => {
      const v = new EngineVoice(SR, car.sound, 2);
      setSteady(v, 4500, 1, 1, 7000);
      v.inp.quality = q;
      const x = render(v, 2);
      return 20 * Math.log10(rms(x, SR, x.length) + 1e-12);
    };
    expect(Math.abs(lvl(1) - lvl(2))).toBeLessThan(5);
    expect(lvl(0)).toBeLessThan(-200);
  });
});

describe('engine voice: dynamics and events', () => {
  const car = CARS[1]; // turbo I4 with crackle
  it('rpm sweep: pitch follows the commanded rpm within 1.2 % and has no clicks', () => {
    const e = car.physics.engine;
    const lo = e.idleRpm * 1.4;
    const hi = e.redlineRpm * 0.97;
    const secs = 4;
    const v = new EngineVoice(SR, car.sound, 3);
    setSteady(v, lo, 1, 1, e.limiterRpm);
    const n = secs * SR;
    const x = new Float32Array(n);
    for (let f = 0; f * 800 < n; f++) {
      v.inp.rpm = lo + (hi - lo) * Math.min(1, (f / 60) / (secs - 0.2));
      v.process(x.subarray(f * 800), Math.min(800, n - f * 800));
    }
    const fire = (t: number): number => (car.sound.cylinders / 2) * ((lo + (hi - lo) * Math.min(1, t / (secs - 0.2))) / 60);
    const d = chirpDeviation(x, SR, fire, 0.5, secs - 0.3, { boxMs: 50, fitMs: 150, stepMs: 50 });
    let se = 0;
    for (const r of d.relDev) se += r * r;
    expect(Math.sqrt(se / d.relDev.length)).toBeLessThan(0.012);
    expect(clickScore(x.subarray(Math.floor(0.4 * SR)), 96).score).toBeLessThan(40);
  });

  it('a backfire counter increment produces a pop that stands out; no pop without it', () => {
    const e = car.physics.engine;
    const v = new EngineVoice(SR, car.sound, 11);
    setSteady(v, e.redlineRpm * 0.7, 0, 0, e.limiterRpm);
    const warm = render(v, 1.2);
    const calm = peakAbs(warm, Math.floor(0.8 * SR), warm.length);
    v.inp.backfireCount += 1;
    const x = render(v, 0.3);
    expect(peakAbs(x)).toBeGreaterThan(calm * 1.7);
  });

  it('a shift (counter increment) dips the load and adds a transient', () => {
    const e = car.physics.engine;
    const v = new EngineVoice(SR, car.sound, 12);
    setSteady(v, e.redlineRpm * 0.85, 1, 1, e.limiterRpm);
    render(v, 1.0);
    v.inp.shiftCount += 1;
    const x = render(v, 0.4);
    const early = rms(x, 0, Math.floor(0.06 * SR));
    const later = rms(x, Math.floor(0.3 * SR), x.length);
    expect(early).toBeLessThan(later * 0.95 + 1e-3); // not louder during the cut than after recovery
    expect(hasNonFinite(x)).toBe(false);
  });

  it('rev limiter flag makes the output stutter (envelope variation)', () => {
    const cov = (lim: number): number => {
      const v = new EngineVoice(SR, car.sound, 13);
      setSteady(v, car.physics.engine.limiterRpm, 1, 1, car.physics.engine.limiterRpm);
      v.inp.limiter = lim;
      const x = render(v, 2.2);
      const w = Math.floor(0.005 * SR);
      const env: number[] = [];
      for (let s = Math.floor(0.6 * SR); s + w < x.length; s += w) env.push(rms(x, s, s + w));
      const m = env.reduce((a, b) => a + b, 0) / env.length;
      return Math.sqrt(env.reduce((a, b) => a + (b - m) ** 2, 0) / env.length) / m;
    };
    expect(cov(1)).toBeGreaterThan(cov(0) * 1.6);
  });

  it('turbo whistle appears with boost (narrow-band energy rise) and only on turbo engines', () => {
    const spec = (profile: EngineSoundProfile, boost: number): Float64Array => {
      const v = new EngineVoice(SR, profile, 14);
      setSteady(v, 5000, 1, 1, 7000);
      v.inp.boost = boost;
      const x = render(v, 2.4);
      return welch(x, 16384, Math.floor(1.2 * SR), x.length);
    };
    const rise = (profile: EngineSoundProfile): number => {
      const a = spec(profile, 0);
      const b = spec(profile, 1);
      let best = -99;
      for (let i = Math.floor((1500 / SR) * 16384); i < Math.floor((7500 / SR) * 16384); i++) best = Math.max(best, 10 * Math.log10((b[i] + 1e-14) / (a[i] + 1e-14)));
      return best;
    };
    expect(rise(profileOf('kestrel-r'))).toBeGreaterThan(12);
    expect(rise(profileOf('ronin-86'))).toBeLessThan(8); // NA engine: boost input changes nothing audible
  });

  it("the blow-off valve vents when the driver lifts, not on a flat upshift's ignition cut (the throttle body stays open)", () => {
    // the blow-off has no debug tap of its own: it is what is left of the output once the layers are taken away
    const blowOff = (pedal: number): number => {
      const v = new EngineVoice(SR, profileOf('kestrel-r'), 17);
      setSteady(v, 6000, 1, 1, 7000);
      v.inp.boost = 1;
      v.inp.pedal = 1;
      render(v, 1.0);
      // the torque goes: the applied throttle and the load drop to nothing, and the pedal either follows (a lift) or stays down (a shift)
      v.inp.throttle = 0;
      v.inp.load = 0;
      v.inp.pedal = pedal;
      const n = Math.floor(0.3 * SR);
      const dbg = createEngineDebug(n);
      v.debug = dbg;
      const x = new Float32Array(n);
      v.process(x, n);
      let e = 0;
      for (let i = 0; i < n; i++) {
        const r = x[i] - (dbg.exhaust[i] + dbg.intake[i] + dbg.mech[i] + dbg.block[i] + dbg.turbo[i] + dbg.whine[i] + dbg.events[i]);
        e += r * r;
      }
      return e / n;
    };
    const lift = blowOff(0);
    const shift = blowOff(1);
    expect(lift).toBeGreaterThan(shift * 20);
    // and a voice that is not told the pedal (-1) takes the applied throttle for it, as before
    const v = new EngineVoice(SR, profileOf('kestrel-r'), 17);
    expect(v.inp.pedal).toBe(-1);
  });

  it('interior mix is darker than the exterior mix', () => {
    const cent = (interior: number): number => {
      const v = new EngineVoice(SR, car.sound, 15);
      setSteady(v, 4500, 1, 1, 7000);
      v.inp.interior = interior;
      const x = render(v, 2.2);
      return spectralCentroid(welch(x, 16384, Math.floor(1.0 * SR), x.length), SR, 40, 12000);
    };
    expect(cent(1)).toBeLessThan(cent(0));
  });

  it('debug taps add up to the output (layers are the mix)', () => {
    const v = new EngineVoice(SR, CARS[0].sound, 16);
    setSteady(v, 5000, 1, 1);
    const n = 8192;
    const dbg = createEngineDebug(n);
    v.debug = dbg;
    const x = new Float32Array(n);
    v.process(x, n);
    let diff = 0;
    let tot = 0;
    for (let i = 4096; i < n; i++) {
      const sum = dbg.exhaust[i] + dbg.intake[i] + dbg.mech[i] + dbg.block[i] + dbg.turbo[i] + dbg.whine[i] + dbg.events[i];
      diff += (sum - x[i]) ** 2;
      tot += x[i] ** 2;
    }
    expect(diff / tot).toBeLessThan(0.05); // within the DC blocker / BOV / cabin filter differences
  });
});

describe('loudness calibration', () => {
  it('every profile lands its sweep-average exhaust on the openness-dependent target', () => {
    for (const c of CARS) {
      const g = calibratedExhaustGain(c.sound, SR);
      const db = 20 * Math.log10(measureExhaustSweepRms(c.sound, SR, g));
      expect(Math.abs(db - exhaustTargetDb(c.sound.exhaustOpenness, c.sound.displacement)), c.id).toBeLessThan(0.6);
    }
  });

  it('also holds for profiles that are not in the roster (crossplane V8, flat-6, V12, I6)', () => {
    const odd: EngineSoundProfile[] = [
      { cylinders: 8, layout: 'v', crankType: 'crossplane', displacement: 6.2, turbo: false, exhaustOpenness: 0.3, brightness: 0.35, gearWhine: 0.05, crackle: 0.8 },
      { cylinders: 6, layout: 'flat', crankType: 'flat', displacement: 3.8, turbo: true, exhaustOpenness: 0.55, brightness: 0.6, gearWhine: 0.2, crackle: 0.4 },
      { cylinders: 12, layout: 'v', crankType: 'flat', displacement: 6.5, turbo: false, exhaustOpenness: 0.9, brightness: 0.8, gearWhine: 0.1, crackle: 0.3 },
      { cylinders: 6, layout: 'inline', crankType: 'flat', displacement: 3, turbo: true, exhaustOpenness: 0.2, brightness: 0.4, gearWhine: 0.3, crackle: 0.1 },
    ];
    for (const p of odd) {
      const g = calibratedExhaustGain(p, SR);
      const db = 20 * Math.log10(measureExhaustSweepRms(p, SR, g));
      expect(Math.abs(db - exhaustTargetDb(p.exhaustOpenness, p.displacement))).toBeLessThan(0.8);
      const v = new EngineVoice(SR, p, 1);
      setSteady(v, 5000, 1, 1, 7500);
      const x = render(v, 1.5);
      expect(hasNonFinite(x)).toBe(false);
      expect(peakAbs(x)).toBeLessThan(1);
    }
  });
});

describe('no aliasing whistles', () => {
  it('at the highest rpm every tonal line sits on the engine-order grid (no folded-back partials)', () => {
    for (const car of CARS) {
      const e = car.physics.engine;
      for (const frac of [0.97, 0.6]) {
        const rpm = e.redlineRpm * frac;
        const v = new EngineVoice(SR, car.sound, 17);
        v.V.turbo = false; // the turbo whistle is a deliberate non-harmonic tone
        Object.assign(v.inp, { rpm, throttle: 1, load: 1, idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, redlineRpm: e.redlineRpm, driveOmega: 0 });
        const x = render(v, 3.2);
        const psd = welch(x, 65536, Math.floor(1.2 * SR), x.length);
        // look above the engine-block structural modes (~100-450 Hz), which legitimately ring at their own frequencies
        const off = offGridLines(psd, SR, rpm / 120, { fLo: 1000, prominenceDb: 14, floorDb: 60 });
        // boxer / unequal headers are rough by design, but still harmonic in the engine orders; allow a couple of weak lines
        expect(off.count, `${car.id} @${Math.round(rpm)} rpm: off-grid lines ${JSON.stringify(off.lines.slice(0, 4))}`).toBeLessThanOrEqual(2);
        if (off.count > 0) expect(off.worstDb).toBeLessThan(-38);
      }
    }
  });

  it('the detector does catch a folded-back tone (sanity check of the test itself)', () => {
    const rpm = 6000;
    const base = rpm / 120;
    const x = new Float32Array(3 * SR);
    for (let i = 0; i < x.length; i++) {
      let s = 0;
      for (let k = 1; k <= 20; k++) s += Math.sin((2 * Math.PI * k * base * i) / SR) / k;
      x[i] = 0.1 * s + 0.01 * Math.sin((2 * Math.PI * 7211.3 * i) / SR); // an inharmonic "aliased" partial
    }
    const off = offGridLines(welch(x, 65536, SR, x.length), SR, base);
    expect(off.count).toBeGreaterThanOrEqual(1);
    expect(Math.abs(off.strongestHz - 7211.3)).toBeLessThan(2);
  });
});
