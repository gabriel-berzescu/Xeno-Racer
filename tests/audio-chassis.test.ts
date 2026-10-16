/** Tires, road noise, impacts and the control mapping that feeds them (headless). */
import { describe, expect, it } from 'vitest';
import { Quaternion } from 'three';
import { hasNonFinite, peakAbs, rms, spectralCentroid, strongestPeak, welch } from '../src/audio/analysis';
import { ChassisMapper, localLeft } from '../src/audio/chassis-controls';
import { CTL, CTL_LEN, TIRE_STRIDE, makeControlVector } from '../src/audio/controls';
import { ChassisVoice, impactNorm } from '../src/audio/dsp/chassis-voice';
import { TIRE_BASE_HZ, makeSquealLevels, slipToLimit, tireSqueal } from '../src/audio/tires';
import { makeVehicleState } from '../sandbox/audio/drive-sim';
import type { SurfaceType, WheelState } from '../src/core/contracts';

const SR = 48000;

function wheel(over: Partial<WheelState> = {}): WheelState {
  const w = makeVehicleState().wheels[0];
  Object.assign(w, { contact: true, surface: 'asphalt', load: 4500, slipAngle: 0.01, slipRatio: 0, skid: 0 }, over);
  return w;
}

describe('tire squeal mapping: informative progression', () => {
  const lv = makeSquealLevels();
  const at = (over: Partial<WheelState>, speed = 35, idx = 0): { scrub: number; tone: number; howl: number; pitch: number } => {
    tireSqueal(wheel(over), idx, speed, lv);
    return { ...lv };
  };

  it('grip is silent; scrub appears before any skid exists, then tone, then howl', () => {
    const grip = at({});
    expect(grip.scrub + grip.tone + grip.howl).toBe(0);
    const approach = at({ slipAngle: 0.11, skid: 0 });
    expect(approach.scrub).toBeGreaterThan(0.08);
    expect(approach.tone).toBe(0);
    const limit = at({ slipAngle: 0.14, skid: 0.35 });
    expect(limit.tone).toBeGreaterThan(0.35);
    expect(limit.howl).toBe(0);
    const slide = at({ slipAngle: 0.3, skid: 1 });
    expect(slide.howl).toBeGreaterThan(0.9);
    expect(slide.tone).toBeLessThan(limit.tone + 0.35); // the pure tone gives way to the ragged howl
    expect(slide.tone).toBeLessThan(0.6);
  });

  it('tone rises monotonically through the limit and scrub fades as the tone takes over', () => {
    let prevTone = -1;
    for (let s = 0; s <= 0.6; s += 0.05) {
      const t = at({ skid: s, slipAngle: 0.1 + s * 0.2 }).tone;
      expect(t).toBeGreaterThanOrEqual(prevTone - 1e-9);
      prevTone = t;
    }
    expect(at({ skid: 0.9, slipAngle: 0.3 }).scrub).toBeLessThan(at({ skid: 0.25, slipAngle: 0.14 }).scrub);
  });

  it('only asphalt, concrete and curb squeal', () => {
    for (const s of ['grass', 'gravel', 'sand', 'dirt'] as SurfaceType[]) {
      const r = at({ surface: s, skid: 1, slipAngle: 0.3 });
      expect(r.scrub + r.tone + r.howl).toBe(0);
    }
    expect(at({ surface: 'concrete', skid: 0.6 }).tone).toBeGreaterThan(0.2);
    expect(at({ surface: 'curb', skid: 0.6 }).tone).toBeLessThan(at({ surface: 'asphalt', skid: 0.6 }).tone);
    const air = at({ contact: false, skid: 1 });
    expect(air.scrub + air.tone + air.howl).toBe(0);
  });

  it('no squeal at walking pace; louder on a heavily loaded tire', () => {
    expect(at({ skid: 1 }, 0.4).howl).toBe(0);
    expect(at({ skid: 0.6, load: 8000 }).tone).toBeGreaterThan(at({ skid: 0.6, load: 2500 }).tone);
  });

  it('front and rear tires sing at different pitches; pitch rises with speed', () => {
    const f = at({ skid: 0.5 }, 35, 0).pitch;
    const r = at({ skid: 0.5 }, 35, 2).pitch;
    expect(f).toBeGreaterThan(r * 1.05);
    expect(at({ skid: 0.5 }, 50).pitch).toBeGreaterThan(at({ skid: 0.5 }, 12).pitch * 1.15);
    expect(TIRE_BASE_HZ[0]).toBeGreaterThan(TIRE_BASE_HZ[3]);
  });

  it('slipToLimit combines slip angle and ratio relative to the limits', () => {
    expect(slipToLimit(wheel({ slipAngle: 0, slipRatio: 0 }))).toBe(0);
    expect(slipToLimit(wheel({ slipAngle: 0.12, slipRatio: 0 }))).toBeCloseTo(1, 5);
    expect(slipToLimit(wheel({ slipAngle: 0.12, slipRatio: 0.11 }))).toBeCloseTo(Math.SQRT2, 5);
  });
});

describe('ChassisMapper: VehicleState -> control vector', () => {
  const run = (setup: (st: ReturnType<typeof makeVehicleState>) => void, frames = 1, dt = 1 / 60): Float32Array => {
    const m = new ChassisMapper();
    const st = makeVehicleState();
    const v = makeControlVector();
    setup(st);
    for (let i = 0; i < frames; i++) m.update(st, dt, v);
    return v;
  };

  it('surface weights are the fraction of wheels on each surface; curb flags per wheel', () => {
    const v = run((st) => {
      st.wheels[0].surface = 'curb';
      st.wheels[2].surface = 'curb';
      st.wheels[1].surface = 'grass';
    });
    expect(v[CTL.SURF_CURB]).toBeCloseTo(0.5);
    expect(v[CTL.SURF_GRASS]).toBeCloseTo(0.25);
    expect(v[CTL.SURF_HARD]).toBeCloseTo(0.25);
    expect([v[CTL.CURB_FL], v[CTL.CURB_FL + 1], v[CTL.CURB_FL + 2], v[CTL.CURB_FL + 3]]).toEqual([1, 0, 1, 0]);
    const air = run((st) => {
      st.airborne = true;
      for (const w of st.wheels) w.contact = false;
    });
    expect(air[CTL.AIRBORNE]).toBe(1);
    expect(air[CTL.SURF_HARD]).toBe(0);
  });

  it('per-wheel tire levels land in the vector at the right offsets', () => {
    const v = run((st) => {
      st.speed = 35;
      st.wheels[1].skid = 0.5;
      st.wheels[1].slipAngle = 0.2;
    });
    const b = CTL.TIRE0 + 1 * TIRE_STRIDE;
    expect(v[b + 1]).toBeGreaterThan(0.4); // tone of the front-right wheel
    expect(v[CTL.TIRE0 + 1]).toBe(0); // front-left silent
    expect(v[b + 3]).toBeGreaterThan(800);
  });

  it('suspension thumps are rate-limited per wheel and fire on landings', () => {
    const m = new ChassisMapper();
    const st = makeVehicleState();
    const v = makeControlVector();
    st.wheels[0].suspensionVelocity = 1.2;
    m.update(st, 0.02, v);
    const c1 = v[CTL.THUMP_COUNT];
    m.update(st, 0.02, v); // 20 ms later: still inside the 110 ms rate limit
    expect(v[CTL.THUMP_COUNT]).toBe(c1);
    for (let i = 0; i < 6; i++) m.update(st, 0.02, v);
    expect(v[CTL.THUMP_COUNT]).toBeGreaterThan(c1);
    // landing after a fall
    const m2 = new ChassisMapper();
    const s2 = makeVehicleState();
    const v2 = makeControlVector();
    s2.airborne = true;
    s2.velocity.set(0, -5, 20);
    m2.update(s2, 1 / 60, v2);
    const before = v2[CTL.THUMP_COUNT];
    s2.airborne = false;
    m2.update(s2, 1 / 60, v2);
    expect(v2[CTL.THUMP_COUNT]).toBe(before + 1);
    expect(v2[CTL.THUMP_STRENGTH]).toBeGreaterThan(0.4);
  });

  it('impacts: one event per impactCount change, kind and strength mapped, pan follows the car side', () => {
    const m = new ChassisMapper();
    const st = makeVehicleState();
    const v = makeControlVector();
    m.update(st, 1 / 60, v);
    expect(v[CTL.IMPACT_COUNT]).toBe(0);
    st.impactCount = 1;
    st.lastImpact.strength = 14;
    st.lastImpact.kind = 'car';
    st.lastImpact.point.set(1.0, 0.5, 0); // car-local +X = left (identity orientation)
    m.update(st, 1 / 60, v);
    m.update(st, 1 / 60, v);
    expect(v[CTL.IMPACT_COUNT]).toBe(1);
    expect(v[CTL.IMPACT_KIND]).toBe(1);
    expect(v[CTL.IMPACT_STRENGTH]).toBe(14);
    expect(v[CTL.IMPACT_PAN]).toBeLessThan(-0.3); // left hit -> pan left (negative)
    st.impactCount = 2;
    st.lastImpact.kind = 'wall';
    st.lastImpact.point.set(-1.0, 0.5, 0);
    m.update(st, 1 / 60, v);
    expect(v[CTL.IMPACT_COUNT]).toBe(2);
    expect(v[CTL.IMPACT_PAN]).toBeGreaterThan(0.3);
  });

  it('localLeft rotates world offsets into the car frame', () => {
    const q = new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0 } as never, Math.PI / 2); // car faces world +X
    // the car's left (local +X) now points along world -Z
    expect(localLeft(q, 0, 0, -1)).toBeCloseTo(1, 5);
    expect(localLeft(q, 0, 0, 1)).toBeCloseTo(-1, 5);
    expect(localLeft(q, 1, 0, 0)).toBeCloseTo(0, 5);
    expect(localLeft(new Quaternion(), 2, 3, 4)).toBeCloseTo(2, 12);
  });

  it('impact strength normalisation is monotonic and bounded', () => {
    let prev = -1;
    for (const s of [0, 1.2, 3, 6, 10, 20, 40, 100]) {
      const n = impactNorm(s);
      expect(n).toBeGreaterThanOrEqual(prev);
      expect(n).toBeLessThanOrEqual(1);
      prev = n;
    }
    expect(impactNorm(0)).toBe(0);
    expect(impactNorm(30)).toBeGreaterThan(0.8);
  });
});

describe('ChassisVoice DSP', () => {
  function run(seconds: number, setup: (v: ChassisVoice, t: number) => void, stereo = true): { l: Float32Array; r: Float32Array } {
    const v = new ChassisVoice(SR, 5);
    const n = Math.floor(seconds * SR);
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let f = 0; f * 800 < n; f++) {
      setup(v, f / 60);
      v.process(l.subarray(f * 800), stereo ? r.subarray(f * 800) : null, Math.min(800, n - f * 800));
    }
    return { l, r };
  }
  const prom = (x: Float32Array, fLo = 650, fHi = 1700): number => strongestPeak(welch(x, 8192, Math.floor(0.7 * SR), x.length), SR, fLo, fHi).prominenceDb;

  it('scrub is noise-like, tone is a narrow-band line, howl is ragged (single wheel, measured)', () => {
    const one = (scrub: number, tone: number, howl: number): Float32Array =>
      run(2, (v) => {
        v.inp.speed = 35;
        v.inp.tire.set([0, 0, 0, 1000, scrub, tone, howl, 1000, 0, 0, 0, 1000, 0, 0, 0, 1000]);
      }).l;
    const scrub = prom(one(1, 0, 0));
    const tone = prom(one(0, 1, 0));
    const howl = prom(one(0, 0, 1));
    expect(tone).toBeGreaterThan(28);
    expect(scrub).toBeLessThan(14);
    expect(howl).toBeLessThan(tone - 8);
  });

  it('road roar grows with speed on every surface; curb rumble follows speed / 0.45 m', () => {
    const level = (surf: number[], speed: number): number => {
      const { l } = run(1.6, (v) => {
        v.inp.speed = speed;
        v.inp.surf.set(surf);
      });
      return 20 * Math.log10(rms(l, Math.floor(0.8 * SR), l.length) + 1e-9);
    };
    const surfaces: number[][] = [
      [1, 0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0, 0],
      [0, 0, 0, 1, 0, 0],
      [0, 0, 0, 0, 1, 0],
      [0, 0, 0, 0, 0, 1],
    ];
    for (const s of surfaces) {
      expect(level(s, 40)).toBeGreaterThan(level(s, 20) + 2);
      expect(level(s, 60)).toBeGreaterThan(level(s, 40) + 1);
    }
    for (const speed of [20, 40]) {
      const { l } = run(3, (v) => {
        v.inp.speed = speed;
        v.inp.surf.set([0, 1, 0, 0, 0, 0]);
        v.inp.curb.set([1, 0, 1, 0]);
      });
      const pk = strongestPeak(welch(l, 32768, Math.floor(0.8 * SR), l.length), SR, (speed / 0.45) * 0.92, (speed / 0.45) * 1.08);
      expect(Math.abs(pk.freq - speed / 0.45) / (speed / 0.45)).toBeLessThan(0.03);
      expect(pk.prominenceDb).toBeGreaterThan(10);
    }
  });

  it('wind grows roughly with speed squared when no wheel touches the ground', () => {
    const at = (speed: number): number => {
      const { l } = run(1.6, (v) => {
        v.inp.speed = speed;
        v.inp.surf.fill(0);
      });
      return 20 * Math.log10(rms(l, Math.floor(0.8 * SR), l.length) + 1e-9);
    };
    const d = at(60) - at(30);
    expect(d).toBeGreaterThan(10);
    expect(d).toBeLessThan(22);
  });

  it('impact crunch scales with strength, is bounded, and glass only on big hits', () => {
    const hit = (kind: number, strength: number): { peak: number; hf: number } => {
      const { l } = run(1.5, (v, t) => {
        if (t === 0) v.inp.impactCount = 0;
        if (t >= 0.1) {
          v.inp.impactCount = 1;
          v.inp.impactKind = kind;
          v.inp.impactStrength = strength;
        }
      });
      const a = Math.floor(0.1 * SR);
      const psd = welch(l, 2048, a + Math.floor(0.2 * SR), a + Math.floor(0.9 * SR));
      let hf = 0;
      let all = 0;
      const df = SR / 2048;
      for (let k = 1; k < psd.length; k++) {
        all += psd[k];
        if (k * df > 3500) hf += psd[k];
      }
      return { peak: 20 * Math.log10(peakAbs(l, a, a + SR) + 1e-9), hf: hf / Math.max(all, 1e-18) };
    };
    const light = hit(0, 3);
    const med = hit(0, 10);
    const heavy = hit(0, 28);
    expect(med.peak).toBeGreaterThan(light.peak + 4);
    expect(heavy.peak).toBeGreaterThan(med.peak + 3);
    expect(heavy.peak).toBeLessThan(0);
    expect(heavy.hf).toBeGreaterThan(light.hf * 3);
    expect(hit(2, 12).hf).toBeLessThan(heavy.hf); // ground slam: no glass
  });

  it('left-side impacts are louder in the left channel', () => {
    const { l, r } = run(1.2, (v, t) => {
      if (t >= 0.1) {
        v.inp.impactCount = 1;
        v.inp.impactKind = 0;
        v.inp.impactStrength = 14;
        v.inp.impactPan = -0.9;
      }
    });
    expect(rms(l, Math.floor(0.1 * SR), l.length)).toBeGreaterThan(rms(r, Math.floor(0.1 * SR), r.length) * 2);
  });

  it('player output is decorrelated stereo; opponent (lite) output is mono and cheaper in state', () => {
    const { l, r } = run(1.2, (v) => {
      v.inp.speed = 50;
      v.inp.surf.set([1, 0, 0, 0, 0, 0]);
    });
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let i = Math.floor(0.4 * SR); i < l.length; i++) {
      sab += l[i] * r[i];
      saa += l[i] * l[i];
      sbb += r[i] * r[i];
    }
    expect(Math.abs(sab / Math.sqrt(saa * sbb))).toBeLessThan(0.7);
    const mono = run(0.6, (v) => {
      v.inp.quality = 1;
      v.inp.speed = 50;
    }, false);
    expect(rms(mono.l, 4000, mono.l.length)).toBeGreaterThan(1e-4);
  });

  it('fuzz: random control vectors never produce NaN or runaway levels', () => {
    const v = new ChassisVoice(SR, 9);
    const out = new Float32Array(128);
    const out2 = new Float32Array(128);
    let s = 12345;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) | 0;
      return (s >>> 0) / 4294967296;
    };
    let worst = 0;
    for (let block = 0; block < 3000; block++) {
      if (block % 6 === 0) {
        v.inp.speed = rnd() * 120;
        v.inp.interior = rnd();
        v.inp.scrape = rnd() > 0.7 ? rnd() : 0;
        for (let i = 0; i < 6; i++) v.inp.surf[i] = rnd() > 0.6 ? rnd() : 0;
        for (let i = 0; i < 4; i++) v.inp.curb[i] = rnd() > 0.8 ? 1 : 0;
        for (let i = 0; i < 16; i++) v.inp.tire[i] = i % 4 === 3 ? 600 + rnd() * 1500 : rnd() * 1.3;
        if (rnd() > 0.9) {
          v.inp.impactCount++;
          v.inp.impactKind = Math.floor(rnd() * 3);
          v.inp.impactStrength = rnd() * 40;
          v.inp.impactPan = rnd() * 2 - 1;
        }
        if (rnd() > 0.9) {
          v.inp.thumpCount++;
          v.inp.thumpStrength = rnd();
        }
        v.inp.quality = rnd() > 0.7 ? 1 : 2;
      }
      v.process(out, out2, 128);
      expect(hasNonFinite(out) || hasNonFinite(out2)).toBe(false);
      worst = Math.max(worst, peakAbs(out), peakAbs(out2));
    }
    expect(worst).toBeLessThan(3);
  });

  it('spectral colour: gravel is brighter than grass', () => {
    const cent = (surf: number[]): number => {
      const { l } = run(1.6, (v) => {
        v.inp.speed = 40;
        v.inp.surf.set(surf);
      });
      return spectralCentroid(welch(l, 8192, Math.floor(0.8 * SR), l.length), SR, 60, 12000);
    };
    expect(cent([0, 0, 0, 1, 0, 0])).toBeGreaterThan(cent([0, 0, 1, 0, 0, 0]) * 2);
  });
});

describe('winter surfaces: the crunch of snow, the studs on ice, the whump of a snowbank', () => {
  const lv = makeSquealLevels();
  const at = (over: Partial<WheelState>, speed = 35): { scrub: number; tone: number; howl: number; pitch: number } => {
    tireSqueal(wheel(over), 0, speed, lv);
    return { ...lv };
  };
  function run(seconds: number, setup: (v: ChassisVoice, t: number) => void): Float32Array {
    const v = new ChassisVoice(SR, 5);
    const n = Math.floor(seconds * SR);
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let f = 0; f * 800 < n; f++) {
      setup(v, f / 60);
      v.process(l.subarray(f * 800), r.subarray(f * 800), Math.min(800, n - f * 800));
    }
    return l;
  }
  const level = (surf: number[], speed: number): number => {
    const l = run(1.6, (v) => {
      v.inp.speed = speed;
      v.inp.surf.fill(0);
      v.inp.surf.set(surf);
    });
    return 20 * Math.log10(rms(l, Math.floor(0.8 * SR), l.length) + 1e-9);
  };
  const SNOW = [0, 0, 0, 0, 0, 0, 1, 0];
  const ICE = [0, 0, 0, 0, 0, 0, 0, 1];
  const GRAVEL = [0, 0, 0, 1, 0, 0, 0, 0];

  it('a tyre on snow hisses and never squeals; on ice the studs add only a thin zip', () => {
    const grip = at({ surface: 'snow' });
    expect(grip.scrub + grip.tone + grip.howl).toBe(0);
    expect(at({ surface: 'snow', slipAngle: 0.11 }).scrub).toBeGreaterThan(0.05); // a whisper before it lets go
    for (const surface of ['snow', 'deepsnow'] as SurfaceType[]) {
      const slide = at({ surface, skid: 1, slipAngle: 0.3 });
      expect(slide.scrub).toBeGreaterThan(0.5);
      expect(slide.tone).toBe(0);
      expect(slide.howl).toBe(0);
    }
    const ice = at({ surface: 'ice', skid: 1, slipAngle: 0.3 });
    expect(ice.scrub).toBeGreaterThan(0.3);
    expect(ice.tone).toBeGreaterThan(0);
    expect(ice.tone).toBeLessThan(0.45);
    expect(ice.howl).toBe(0);
    // and the asphalt is as it was
    expect(at({ surface: 'asphalt', skid: 0.35, slipAngle: 0.14 }).tone).toBeGreaterThan(0.35);
    const air = at({ surface: 'snow', skid: 1, contact: false });
    expect(air.scrub + air.tone + air.howl).toBe(0);
  });

  it('the mapper gives snow and ice their own voices, and a snowbank its own kind of hit', () => {
    const m = new ChassisMapper();
    const st = makeVehicleState();
    const v = makeControlVector();
    st.wheels[0].surface = 'snow';
    st.wheels[1].surface = 'deepsnow';
    st.wheels[2].surface = 'ice';
    st.wheels[3].surface = 'asphalt';
    m.update(st, 1 / 60, v);
    expect(v[CTL.SURF_SNOW]).toBeCloseTo(0.5);
    expect(v[CTL.SURF_ICE]).toBeCloseTo(0.25);
    expect(v[CTL.SURF_HARD]).toBeCloseTo(0.25);
    expect(v[CTL.SURF_DIRT]).toBe(0);
    expect(CTL.SURF_ICE).toBeLessThan(CTL_LEN);
    st.impactCount = 1;
    st.lastImpact.strength = 9;
    st.lastImpact.kind = 'snow';
    m.update(st, 1 / 60, v);
    expect(v[CTL.IMPACT_KIND]).toBe(3);
  });

  it('the crunch grows with the speed and is softer than gravel; the studs are brighter than the snow', () => {
    expect(level(SNOW, 40)).toBeGreaterThan(level(SNOW, 20) + 2);
    expect(level(SNOW, 60)).toBeGreaterThan(level(SNOW, 40) + 1);
    expect(level(ICE, 40)).toBeGreaterThan(level(ICE, 20) + 2);
    expect(level(SNOW, 40)).toBeLessThan(level(GRAVEL, 40));
    expect(level(SNOW, 40)).toBeGreaterThan(-45); // heard
    expect(level(ICE, 40)).toBeGreaterThan(-45);
    const cent = (surf: number[]): number => {
      const l = run(1.6, (v) => {
        v.inp.speed = 40;
        v.inp.surf.fill(0);
        v.inp.surf.set(surf);
      });
      return spectralCentroid(welch(l, 8192, Math.floor(0.8 * SR), l.length), SR, 60, 12000);
    };
    expect(cent(ICE)).toBeGreaterThan(cent(SNOW) * 1.3);
  });

  it('a hit on a snowbank is a low whump: bounded, with none of the high end of metal and glass', () => {
    const hit = (kind: number): { peak: number; hf: number } => {
      const l = run(1.5, (v, t) => {
        if (t >= 0.1) {
          v.inp.impactCount = 1;
          v.inp.impactKind = kind;
          v.inp.impactStrength = 12;
        }
      });
      const a = Math.floor(0.1 * SR);
      const psd = welch(l, 2048, a + Math.floor(0.2 * SR), a + Math.floor(0.9 * SR));
      let hf = 0;
      let all = 0;
      const df = SR / 2048;
      for (let k = 1; k < psd.length; k++) {
        all += psd[k];
        if (k * df > 3500) hf += psd[k];
      }
      return { peak: 20 * Math.log10(peakAbs(l, a, a + SR) + 1e-9), hf: hf / Math.max(all, 1e-18) };
    };
    const bank = hit(3);
    const wall = hit(0);
    expect(bank.peak).toBeGreaterThan(-30); // it is heard
    expect(bank.peak).toBeLessThan(0);
    expect(bank.hf).toBeLessThan(wall.hf * 0.3);
  });

  it('fuzz: the winter voices never produce NaN or runaway levels', () => {
    const v = new ChassisVoice(SR, 11);
    const out = new Float32Array(128);
    const out2 = new Float32Array(128);
    let s = 777;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) | 0;
      return (s >>> 0) / 4294967296;
    };
    let worst = 0;
    for (let block = 0; block < 2000; block++) {
      if (block % 5 === 0) {
        v.inp.speed = rnd() * 100;
        v.inp.surf[6] = rnd();
        v.inp.surf[7] = rnd() > 0.5 ? rnd() : 0;
        if (rnd() > 0.9) {
          v.inp.impactCount++;
          v.inp.impactKind = 3;
          v.inp.impactStrength = rnd() * 30;
        }
      }
      v.process(out, out2, 128);
      expect(hasNonFinite(out) || hasNonFinite(out2)).toBe(false);
      worst = Math.max(worst, peakAbs(out), peakAbs(out2));
    }
    expect(worst).toBeLessThan(3);
  });
});
