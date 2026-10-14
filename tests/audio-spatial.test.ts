/** Spatial math, level-of-detail, control mapping, graph curves, WAV + analysis helpers (headless). */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { chirpDeviation, clickScore, fft, harmonicShare, powerSpectrum, strongestPeak, welch, spectralCentroid, rms } from '../src/audio/analysis';
import { CarFrame } from '../src/audio/carsound';
import { CTL, CTL_LEN, TIRE_STRIDE, makeControlVector, readEngineInputs, writeEngineControls } from '../src/audio/controls';
import { defaultEngineInputs } from '../src/audio/dsp/engine-voice';
import { makeChassisInputs, readChassisInputs } from '../src/audio/dsp/chassis-voice';
import { makeLimiterCurve, volumeCurve } from '../src/audio/graph';
import { MUSIC_BASS_ROOTS, MUSIC_CHORD_PITCHES, MUSIC_INFO } from '../src/audio/music';
import {
  LOD_FULL_RADIUS,
  LOD_LITE_RADIUS,
  MAX_FULL_AI,
  SPEED_OF_SOUND,
  assignLod,
  computeSpatial,
  listenerFromMatrix,
  lodFade,
  makeListener,
  makeSpatialOut,
  type Lod,
} from '../src/audio/spatial';
import { decodeWav16, encodeWav16 } from '../src/audio/wav';
import { makeVehicleState } from '../sandbox/audio/drive-sim';

describe('listener from a camera matrix', () => {
  it('matches three.js world direction / up for arbitrary orientations and positions', () => {
    const cam = new PerspectiveCamera();
    const L = makeListener();
    for (const [yaw, pitch, roll] of [
      [0, 0, 0],
      [Math.PI / 2, 0, 0],
      [1.1, -0.4, 0.2],
      [-2.5, 0.3, 0],
    ]) {
      cam.position.set(3, 4, -5);
      cam.rotation.set(pitch, yaw, roll, 'YXZ');
      cam.updateMatrixWorld();
      listenerFromMatrix(cam.matrixWorld.elements, 1, 2, 3, L);
      const fwd = cam.getWorldDirection(new Vector3());
      const up = new Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      expect([L.fx, L.fy, L.fz].map((v) => +v.toFixed(5))).toEqual([fwd.x, fwd.y, fwd.z].map((v) => +v.toFixed(5)));
      expect([L.ux, L.uy, L.uz].map((v) => +v.toFixed(5))).toEqual([up.x, up.y, up.z].map((v) => +v.toFixed(5)));
      expect([L.px, L.py, L.pz]).toEqual([3, 4, -5]);
      expect([L.vx, L.vy, L.vz]).toEqual([1, 2, 3]);
    }
  });

  it('survives a scaled camera and non-finite velocity', () => {
    const cam = new PerspectiveCamera();
    cam.scale.set(2, 2, 2);
    cam.updateMatrixWorld();
    const L = makeListener();
    listenerFromMatrix(cam.matrixWorld.elements, NaN, Infinity, 0, L);
    expect(Math.hypot(L.fx, L.fy, L.fz)).toBeCloseTo(1, 6);
    expect([L.vx, L.vy]).toEqual([NaN, Infinity].map((v) => (Number.isFinite(v) ? v : 0)));
  });
});

describe('computeSpatial: placement, Doppler, absorption', () => {
  const L = makeListener();
  const sp = makeSpatialOut();

  it('Doppler follows (c + v_listener.u) / (c + v_source.u): approach raises, recede lowers', () => {
    // source 100 m ahead of the listener (listener looks down -Z), driving toward / away at 60 m/s
    computeSpatial(L, 0, 0, -100, 0, 0, 60, false, sp); // moving +Z = toward the listener at the origin
    expect(sp.timeScale).toBeCloseTo(SPEED_OF_SOUND / (SPEED_OF_SOUND - 60), 3);
    computeSpatial(L, 0, 0, -100, 0, 0, -60, false, sp);
    expect(sp.timeScale).toBeCloseTo(SPEED_OF_SOUND / (SPEED_OF_SOUND + 60), 3);
    computeSpatial(L, 0, 0, -100, 0, 0, 0, false, sp);
    expect(sp.timeScale).toBe(1);
    // moving listener toward a standing source also raises the pitch
    const L2 = { ...makeListener(), vz: -30 };
    computeSpatial(L2, 0, 0, -100, 0, 0, 0, false, sp);
    expect(sp.timeScale).toBeCloseTo((SPEED_OF_SOUND + 30) / SPEED_OF_SOUND, 3);
    // sideways motion at closest approach: no shift
    computeSpatial(L, 0, 0, -50, 60, 0, 0, false, sp);
    expect(sp.timeScale).toBeCloseTo(1, 3);
  });

  it('attached cameras (chase / cockpit) get no Doppler even when the car is fast', () => {
    computeSpatial(L, 0, 0, -3, 0, 0, 80, false, sp); // 3 m away and "moving toward" at 80 m/s
    expect(Math.abs(sp.timeScale - 1)).toBeLessThan(0.02);
    computeSpatial(L, 0, 0, -8, 0, 0, 80, false, sp);
    expect(sp.timeScale).toBeGreaterThan(1.05);
    expect(sp.timeScale).toBeLessThanOrEqual(1.4);
  });

  it("the player's own car is pulled to a point 2.2 m ahead of a close camera and released for far ones", () => {
    computeSpatial(L, 0.3, 0, -1.2, 0, 0, 0, true, sp);
    expect([sp.x, sp.y, sp.z].map((v) => +v.toFixed(3))).toEqual([0, 0, -2.2]);
    computeSpatial(L, 4, 0, -20, 0, 0, 0, true, sp);
    expect([sp.x, sp.y, sp.z]).toEqual([4, 0, -20]);
    computeSpatial(L, 0, 0, -5, 0, 0, 0, true, sp); // in between: blended
    expect(sp.z).toBeLessThan(-2.2);
    expect(sp.z).toBeGreaterThan(-5);
    computeSpatial(L, 0, 0, -5, 0, 0, 0, false, sp); // opponents are never pulled
    expect(sp.z).toBe(-5);
  });

  it('air absorption cutoff falls with distance and stays inside sane bounds', () => {
    let prev = Infinity;
    for (const d of [1, 5, 20, 60, 120, 400]) {
      computeSpatial(L, 0, 0, -d, 0, 0, 0, false, sp);
      expect(sp.lpHz).toBeLessThanOrEqual(prev);
      expect(sp.lpHz).toBeGreaterThanOrEqual(2200);
      expect(sp.lpHz).toBeLessThanOrEqual(18000);
      prev = sp.lpHz;
    }
  });
});

describe('level of detail', () => {
  it('nearest four opponents inside 80 m get the full model, the rest the lite one, far ones are off', () => {
    const d = [30, 12, 55, 25, 70, 60, 79, 100, 149, 151, 400];
    const out: Lod[] = [];
    assignLod(d, d.length, out, []);
    const full = out.filter((x) => x === 2).length;
    expect(full).toBe(MAX_FULL_AI);
    // the four nearest are 12, 25, 30, 55
    for (const i of [1, 3, 0, 2]) expect(out[i]).toBe(2);
    for (const i of [4, 5, 6, 7, 8]) expect(out[i]).toBe(1);
    for (const i of [9, 10]) expect(out[i]).toBe(0);
  });

  it('eleven opponents at 30 m: exactly four full and seven lite', () => {
    const d = new Array(11).fill(30);
    const out: Lod[] = [];
    assignLod(d, 11, out, []);
    expect(out.filter((x) => x === 2)).toHaveLength(4);
    expect(out.filter((x) => x === 1)).toHaveLength(7);
  });

  it('radii are consistent and the fade reaches zero at the cull radius without popping', () => {
    expect(LOD_FULL_RADIUS).toBeLessThan(LOD_LITE_RADIUS);
    let prev = 2;
    for (let d = 0; d <= 200; d += 5) {
      const f = lodFade(d);
      expect(f).toBeLessThanOrEqual(prev + 1e-12);
      prev = f;
    }
    expect(lodFade(100)).toBe(1);
    expect(lodFade(LOD_LITE_RADIUS)).toBe(0);
  });
});

describe('CarFrame: state -> control vector', () => {
  const L = makeListener();
  it('opponents beyond the cull radius are off and silent; near ones follow the assigned tier', () => {
    const st = makeVehicleState();
    st.position.set(0, 0, -200);
    const f = new CarFrame(false);
    f.compute(st, 1 / 60, L, 0, 2, false);
    expect(f.vec[CTL.GAIN]).toBe(0);
    st.position.set(0, 0, -20);
    f.compute(st, 1 / 60, L, 0, 1, false);
    expect(f.vec[CTL.QUALITY]).toBe(1);
    expect(f.vec[CTL.CH_QUALITY]).toBe(1);
    expect(f.vec[CTL.GAIN]).toBe(1);
    f.compute(st, 1 / 60, L, 0, 0, false);
    expect(f.vec[CTL.QUALITY]).toBe(0);
    expect(f.vec[CTL.CH_QUALITY]).toBe(0);
  });

  it('the player is always full quality; pause silences everyone; interior is passed through', () => {
    const st = makeVehicleState();
    const f = new CarFrame(true);
    f.compute(st, 1 / 60, L, 1, 0, false);
    expect([f.vec[CTL.QUALITY], f.vec[CTL.CH_QUALITY], f.vec[CTL.GAIN], f.vec[CTL.INTERIOR], f.vec[CTL.CH_INTERIOR]]).toEqual([2, 2, 1, 1, 1]);
    f.compute(st, 1 / 60, L, 0, 2, true);
    expect(f.vec[CTL.GAIN]).toBe(0);
    expect(f.vec[CTL.CH_GAIN]).toBe(0);
  });

  it('the Doppler time-scale lands in the vector', () => {
    const st = makeVehicleState();
    st.position.set(0, 0, -100);
    st.velocity.set(0, 0, 60);
    const f = new CarFrame(false);
    f.compute(st, 1 / 60, L, 0, 2, false);
    expect(f.vec[CTL.TIMESCALE]).toBeGreaterThan(1.15);
  });
});

describe('control vector', () => {
  it('layout: every index is unique and inside the vector; tire block has room for four wheels', () => {
    const idx = Object.values(CTL);
    expect(new Set(idx).size).toBe(idx.length);
    for (const i of idx) expect(i).toBeLessThan(CTL_LEN);
    expect(CTL.TIRE0 + 4 * TIRE_STRIDE).toBeLessThanOrEqual(CTL.THUMP_COUNT);
    expect(CTL.CURB_FL + 3).toBeLessThan(CTL.TIRE0);
  });

  it('engine part is written from VehicleState; load blends engineLoad with the pedal', () => {
    const st = makeVehicleState();
    Object.assign(st, { rpm: 6000, throttle: 1, engineLoad: 0.6, boost: 0.8, shiftCount: 70000, backfireCount: 3, revLimiter: true, idleRpm: 800, limiterRpm: 8000, redlineRpm: 7800, gear: 4, clutch: 0.2 });
    st.wheels[0].omega = st.wheels[1].omega = 100;
    st.wheels[2].omega = st.wheels[3].omega = -100;
    const v = makeControlVector();
    writeEngineControls(v, st);
    expect(v[CTL.RPM]).toBe(6000);
    expect(v[CTL.LOAD]).toBeCloseTo(0.5 * 0.6 + 0.5 * 1, 6);
    expect(v[CTL.BOOST]).toBeCloseTo(0.8, 6);
    expect(v[CTL.LIMITER]).toBe(1);
    expect(v[CTL.SHIFT_COUNT]).toBe(70000 % 65536); // counters are wrapped so Float32 stays exact
    expect(v[CTL.DRIVE_OMEGA]).toBeCloseTo(100, 4);
    st.throttle = 0;
    st.engineLoad = 0;
    writeEngineControls(v, st);
    expect(v[CTL.LOAD]).toBe(0);
  });

  it('non-finite physics values never reach the DSP', () => {
    const st = makeVehicleState();
    st.rpm = NaN;
    st.throttle = Infinity;
    st.engineLoad = NaN;
    st.boost = -Infinity;
    const v = makeControlVector();
    v[CTL.RPM] = 4321;
    writeEngineControls(v, st);
    const inp = defaultEngineInputs();
    readEngineInputs(v, inp);
    for (const val of Object.values(inp)) expect(Number.isFinite(val)).toBe(true);
    expect(inp.rpm).toBe(4321); // keeps the last good value
    expect(inp.throttle).toBeLessThanOrEqual(1);
    // wild vectors are clamped on the way in
    v[CTL.RPM] = 1e9;
    v[CTL.THROTTLE] = 9;
    v[CTL.LOAD] = -3;
    v[CTL.BOOST] = 10;
    v[CTL.INTERIOR] = 4;
    readEngineInputs(v, inp);
    expect([inp.rpm, inp.throttle, inp.load, inp.boost, inp.interior]).toEqual([20000, 1, 0, 1.5, 1]);
    const ch = makeChassisInputs();
    v.fill(NaN);
    readChassisInputs(v, ch);
    for (const val of [ch.speed, ch.gain, ch.interior, ch.airborne, ch.scrape, ...ch.surf, ...ch.curb, ...ch.tire]) expect(Number.isFinite(val)).toBe(true);
  });
});

describe('master graph curves', () => {
  it('slider curve is monotonic from 0 to 1 and clamps garbage', () => {
    let prev = -1;
    for (let x = 0; x <= 1.0001; x += 0.05) {
      const g = volumeCurve(x);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
    expect(volumeCurve(0)).toBe(0);
    expect(volumeCurve(1)).toBe(1);
    expect(volumeCurve(5)).toBe(1);
    expect(volumeCurve(-2)).toBe(0);
    expect(volumeCurve(NaN)).toBe(0);
  });

  it('soft limiter is transparent below the knee, odd-symmetric, monotonic and never exceeds full scale', () => {
    const c = makeLimiterCurve(4097);
    const n = c.length;
    let prev = -2;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      expect(c[i]).toBeGreaterThanOrEqual(prev);
      expect(Math.abs(c[i])).toBeLessThanOrEqual(1);
      expect(c[i]).toBeCloseTo(-c[n - 1 - i], 6);
      if (Math.abs(x) <= 0.79) expect(c[i]).toBeCloseTo(x, 4);
      prev = c[i];
    }
    expect(c[n - 1]).toBeLessThanOrEqual(1);
    expect(c[n - 1]).toBeGreaterThan(0.94); // a full-scale input lands at ~0.952 (-0.4 dBFS)
  });
});

describe('WAV and analysis helpers', () => {
  it('WAV round trip stays within 16-bit quantisation and keeps rate / channels', () => {
    const n = 5000;
    const a = new Float32Array(n);
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      a[i] = Math.sin(i * 0.05) * 0.9;
      b[i] = Math.cos(i * 0.031) * 0.5;
    }
    const wav = decodeWav16(encodeWav16([a, b], 44100));
    expect(wav.sampleRate).toBe(44100);
    expect(wav.channels).toHaveLength(2);
    for (let i = 0; i < n; i += 97) {
      expect(Math.abs(wav.channels[0][i] - a[i])).toBeLessThan(1 / 30000);
      expect(Math.abs(wav.channels[1][i] - b[i])).toBeLessThan(1 / 30000);
    }
    // out-of-range and NaN samples are clamped / zeroed, not wrapped
    const hostile = decodeWav16(encodeWav16([Float32Array.from([2, -3, NaN, 0.5])], 8000));
    expect(Array.from(hostile.channels[0]).map((v) => +v.toFixed(3))).toEqual([1, -1, 0, 0.5]);
  });

  it('FFT finds a pure tone in the right bin; PSD peak interpolation is sub-bin accurate', () => {
    const sr = 48000;
    const f = 1234.5;
    const x = new Float32Array(sr);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * f * i) / sr);
    const psd = welch(x, 16384);
    const pk = strongestPeak(psd, sr, 1000, 1500);
    expect(Math.abs(pk.freq - f)).toBeLessThan(0.3);
    expect(pk.prominenceDb).toBeGreaterThan(60);
    const re = new Float64Array(8);
    const im = new Float64Array(8);
    re[1] = 1;
    fft(re, im);
    expect(re[0]).toBeCloseTo(1, 12); // impulse at 1 -> flat magnitude
    expect(Math.hypot(re[3], im[3])).toBeCloseTo(1, 12);
    expect(powerSpectrum(x, 0, 1024).length).toBe(513);
  });

  it('chirpDeviation measures a known pitch error precisely; clickScore flags a click but not smooth audio', () => {
    const sr = 48000;
    const secs = 3;
    const x = new Float32Array(secs * sr);
    let ph = 0;
    for (let i = 0; i < x.length; i++) {
      const t = i / sr;
      ph += (2 * Math.PI * (300 + 100 * t) * 1.02) / sr; // actual pitch is 2 % above the expected one
      x[i] = Math.sin(ph);
    }
    const d = chirpDeviation(x, sr, (t) => 300 + 100 * t, 0.3, 2.7, { boxMs: 40, fitMs: 150, stepMs: 100 });
    for (const r of d.relDev) expect(Math.abs(r - 0.02)).toBeLessThan(0.004);
    const smooth = new Float32Array(sr);
    for (let i = 0; i < smooth.length; i++) smooth[i] = 0.3 * Math.sin(i * 0.05) + 0.2 * Math.sin(i * 0.013);
    const clicked = smooth.slice();
    clicked[20000] += 0.9;
    expect(clickScore(clicked, 96).score).toBeGreaterThan(clickScore(smooth, 96).score * 5);
    expect(harmonicShare(welch(x.subarray(sr), 16384), sr, 5000, 5, 60, 6000)).toBeLessThan(0.2); // a chirp is not a harmonic series
    expect(spectralCentroid(welch(x.subarray(sr), 16384), sr, 100, 4000)).toBeGreaterThan(300);
    expect(rms(smooth)).toBeGreaterThan(0.1);
  });
});

describe('music data', () => {
  it('harmony: every bar uses only the notes of A minor plus the G# leading tone', () => {
    const allowed = new Set([0, 2, 4, 5, 7, 8, 9, 11]);
    for (const bar of MUSIC_CHORD_PITCHES) for (const seg of bar) for (const pc of seg) expect(allowed.has(pc)).toBe(true);
    expect(MUSIC_CHORD_PITCHES).toHaveLength(8);
    expect(MUSIC_CHORD_PITCHES[7]).toHaveLength(2); // Esus4 -> E7 inside the last bar
  });

  it('progression Am - F - C - G - Am - F - Dm - E, tempo 96 BPM', () => {
    expect(MUSIC_BASS_ROOTS.map((b) => b[0])).toEqual([9, 5, 0, 7, 9, 5, 2, 4]);
    expect(MUSIC_INFO.bpm).toBe(96);
    expect(MUSIC_INFO.barSeconds).toBeCloseTo(2.5, 6);
    expect(MUSIC_INFO.bars).toBe(32);
  });
});
