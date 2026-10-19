/**
 * Split-screen audio (headless): the pure math that puts two listeners' worlds into the one WebAudio listener, the level of two
 * human voices measured on the real synthesis code, and the audio system itself driven in split mode over a stand-in context.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { CARS } from '../src/cars';
import { CarFrame } from '../src/audio/carsound';
import { CTL, readEngineInputs } from '../src/audio/controls';
import { ChassisVoice, readChassisInputs } from '../src/audio/dsp/chassis-voice';
import { EngineVoice, calibratedExhaustGain } from '../src/audio/dsp/engine-voice';
import { makeLimiterCurve, volumeCurve } from '../src/audio/graph';
import { createAudioSystem, createAudioSystemOn } from '../src/audio';
import {
  LOD_FULL_RADIUS,
  MAX_FULL_AI,
  SPLIT_PLAYER_TRIM,
  SPLIT_SEPARATION_DEG,
  chooseHearer,
  type ListenerState,
  type SplitPlace,
  computeSpatial,
  listenerFromMatrix,
  lodFade,
  makeListener,
  makeSpatialOut,
  makeSplitPlace,
  nearestListener,
  placeSplit,
  separationSwing,
  transplant,
} from '../src/audio/spatial';
import { WCTL } from '../src/audio/weather-model';
import { DriveSim, makeVehicleState } from '../sandbox/audio/drive-sim';

const SR = 48000;
const DEG = Math.PI / 180;
/** The trim as a control vector (a Float32Array) holds it. */
const TRIM32 = Math.fround(SPLIT_PLAYER_TRIM);

/** A listener the way the game makes one: from a camera at `pos` turned `yaw` about Y (0 = looking down -Z), `pitch` up. */
function listenerAt(pos: [number, number, number], yaw: number, pitch = 0, roll = 0, vel: [number, number, number] = [0, 0, 0]): ListenerState {
  const cam = new PerspectiveCamera();
  cam.position.set(...pos);
  cam.rotation.set(pitch, yaw, roll, 'YXZ');
  cam.updateMatrixWorld();
  const L = makeListener();
  listenerFromMatrix(cam.matrixWorld.elements, ...vel, L);
  return L;
}

const near = (a: number[], b: number[], digits = 6): void => {
  expect(a).toHaveLength(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
};

// ── the pure math ────────────────────────────────────────────────────────────

describe('which listener hears a sound', () => {
  const a = listenerAt([0, 0, 0], 0);
  const b = listenerAt([100, 0, 0], 0);

  it('the nearer one; seat 0 at an exact tie', () => {
    expect(nearestListener(a, b, 10, 0, 0)).toBe(0);
    expect(nearestListener(a, b, 90, 0, 0)).toBe(1);
    expect(nearestListener(a, b, 50, 0, 0)).toBe(0);
    expect(nearestListener(a, b, 50, 30, -20)).toBe(0); // equidistant in 3D (and off the line between them)
    expect(nearestListener(a, b, 50.001, 0, 0)).toBe(1);
    // height counts
    const c = listenerAt([0, 40, 0], 0);
    expect(nearestListener(a, c, 0, 21, 0)).toBe(1);
    expect(nearestListener(a, c, 0, 19, 0)).toBe(0);
  });
});

describe('who hears an opponent, without flip-flopping', () => {
  const a = listenerAt([0, 0, 0], 0);
  const b = listenerAt([100, 0, 0], 0);

  it('keeps the listener it has until the other is clearly nearer (about 10 % of the distance)', () => {
    // on the half way line it stays with whoever it has
    expect(chooseHearer(a, b, 50, 0, 0, 0)).toBe(0);
    expect(chooseHearer(a, b, 50, 0, 0, 1)).toBe(1);
    // 52 m from a and 48 m from b is not nearer enough; 53 and 47 is
    expect(chooseHearer(a, b, 52, 0, 0, 0)).toBe(0);
    expect(chooseHearer(a, b, 53, 0, 0, 0)).toBe(1);
    // and back
    expect(chooseHearer(a, b, 48, 0, 0, 1)).toBe(1);
    expect(chooseHearer(a, b, 47, 0, 0, 1)).toBe(0);
    // far from the middle it is just the nearer one, whoever had it
    for (const cur of [0, 1] as const) {
      expect(chooseHearer(a, b, 10, 3, 4, cur)).toBe(0);
      expect(chooseHearer(a, b, 95, -2, 1, cur)).toBe(1);
    }
  });

  it('an opponent driving from one human to the other changes ears once, not back and forth on the half way line', () => {
    let cur: 0 | 1 = 0;
    let changes = 0;
    for (let x = -20; x <= 120; x += 0.25) {
      const next = chooseHearer(a, b, x, 0, 0, cur);
      if (next !== cur) changes++;
      cur = next;
    }
    expect(changes).toBe(1);
    expect(cur).toBe(1);
  });
});

describe('transplant: the same place seen from another head', () => {
  const out = { x: 0, y: 0, z: 0 };

  it('is the identity for the same listener, and for another with the same pose', () => {
    for (const [yaw, pitch, roll] of [
      [0, 0, 0],
      [1.1, -0.4, 0.2],
      [-2.5, 0.3, 0],
      [Math.PI, 0.7, -0.3],
    ]) {
      const l = listenerAt([3, 4, -5], yaw, pitch, roll);
      const twin = listenerAt([3, 4, -5], yaw, pitch, roll);
      for (const p of [[0, 0, 0], [10, -3, 25], [-40, 12, 7]]) {
        transplant(l, l, p[0], p[1], p[2], 0, out);
        expect([out.x, out.y, out.z]).toEqual(p);
        transplant(l, twin, p[0], p[1], p[2], 0, out);
        near([out.x, out.y, out.z], p, 9);
      }
    }
  });

  it('keeps the ahead / right / above of the point: 5 ahead, 2 right, 1 above of a head facing +X is the same of one facing -Z', () => {
    const from = listenerAt([10, 2, 0], -Math.PI / 2); // looking down +X; its right is +Z
    near([from.fx, from.fy, from.fz], [1, 0, 0], 9);
    const to = listenerAt([0, 0, 0], 0); // looking down -Z; its right is +X
    // from's point: 5 along +X, 2 along +Z, 1 up
    transplant(from, to, 15, 3, 2, 0, out);
    near([out.x, out.y, out.z], [2, 1, -5], 9);
  });

  it('round trips, and never changes a distance from the head', () => {
    const a = listenerAt([-30, 5, 70], 2.2, -0.2, 0.1);
    const b = listenerAt([400, 1.5, -90], -0.8, 0.35, -0.05);
    const p = [12, -2, 9];
    transplant(a, b, p[0], p[1], p[2], 0, out);
    const q = { ...out };
    expect(Math.hypot(q.x - b.px, q.y - b.py, q.z - b.pz)).toBeCloseTo(Math.hypot(p[0] - a.px, p[1] - a.py, p[2] - a.pz), 9);
    transplant(b, a, q.x, q.y, q.z, 0, out);
    near([out.x, out.y, out.z], p, 9);
  });

  it('a swing turns a point ahead to the right (positive) or left (negative) of the listener, about its up axis, without changing the distance', () => {
    const l = listenerAt([0, 2, 0], 0);
    transplant(l, l, 0, 2, -10, 15 * DEG, out);
    near([out.x, out.y, out.z], [10 * Math.sin(15 * DEG), 2, -10 * Math.cos(15 * DEG)], 9);
    transplant(l, l, 0, 2, -10, -15 * DEG, out);
    near([out.x, out.y, out.z], [-10 * Math.sin(15 * DEG), 2, -10 * Math.cos(15 * DEG)], 9);
    // a listener that turned: the swing turns with it (this one looks down +X, so "right" is +Z)
    const m = listenerAt([5, 0, 5], -Math.PI / 2);
    transplant(m, m, 15, 0, 5, 20 * DEG, out);
    near([out.x, out.y, out.z], [5 + 10 * Math.cos(20 * DEG), 0, 5 + 10 * Math.sin(20 * DEG)], 9);
    // above or below does not move
    transplant(l, l, 3, 9, -4, 15 * DEG, out);
    expect(out.y).toBeCloseTo(9, 9);
  });

  it('survives a listener looking straight up or down, and a zero direction', () => {
    const up = listenerAt([0, 0, 0], 0, Math.PI / 2);
    const down = listenerAt([50, 0, 0], 0, -Math.PI / 2);
    const broken: ListenerState = { ...makeListener(), fx: 0, fy: 0, fz: 0, ux: 0, uy: 0, uz: 0 };
    for (const [from, to] of [[up, down], [down, up], [broken, up], [up, broken], [broken, broken]]) {
      transplant(from, to, 3, 4, 5, 0.2, out);
      expect(Number.isFinite(out.x + out.y + out.z)).toBe(true);
    }
    // looking straight up, the frame still carries a point's distance over
    transplant(up, listenerAt([0, 0, 0], 0), 0, 7, 0, 0, out);
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(7, 9);
  });
});

describe('the left / right swing of the two human voices', () => {
  it('seat 0 turns left, seat 1 right, by SPLIT_SEPARATION_DEG, mirror images of each other', () => {
    expect(SPLIT_SEPARATION_DEG).toBe(15);
    expect(separationSwing(0, 2)).toBeCloseTo(-15 * DEG, 12);
    expect(separationSwing(1, 2)).toBeCloseTo(15 * DEG, 12);
    for (const d of [0, 1, 6, 12, 20, 29, 50]) expect(separationSwing(0, d)).toBeCloseTo(-separationSwing(1, d), 12);
  });

  it('holds for the cameras that ride with the car and fades out between 10 and 30 m', () => {
    expect(separationSwing(1, 9.99)).toBeCloseTo(15 * DEG, 12);
    expect(separationSwing(1, 30)).toBe(0);
    expect(separationSwing(1, 400)).toBe(0);
    let prev = Infinity;
    for (let d = 10; d <= 30; d += 1) {
      const s = separationSwing(1, d);
      expect(s).toBeLessThanOrEqual(prev + 1e-12);
      prev = s;
    }
    expect(separationSwing(1, 20)).toBeGreaterThan(0);
    expect(separationSwing(1, 20)).toBeLessThan(15 * DEG);
  });
});

describe('placeSplit: where each car goes in seat 0\'s frame', () => {
  const camA = listenerAt([0, 2, 0], 0); // looking down -Z
  const camB = listenerAt([1000, 2, 0], -Math.PI / 2); // looking down +X; its right is +Z
  const sp = makeSpatialOut();
  const put: SplitPlace = makeSplitPlace();
  const sin = Math.sin(15 * DEG);
  const cos = Math.cos(15 * DEG);

  it("seat 0's own car sits 2.2 m ahead of its camera, a swing to the left", () => {
    computeSpatial(camA, 0, 2, -1.5, 0, 0, 0, true, sp);
    placeSplit(camA, camA, 0, true, sp, 0, 2, -1.5, put);
    near([put.x, put.y, put.z], [-2.2 * sin, 2, -2.2 * cos], 9);
  });

  it("seat 1's own car sits 2.2 m ahead of ITS camera, a swing to the right, and that is 2.2 m ahead of seat 0's head", () => {
    computeSpatial(camB, 1001.5, 2, 0, 0, 0, 0, true, sp);
    expect(sp.x).toBeCloseTo(1002.2, 9); // worked out against its own camera
    placeSplit(camA, camB, 1, true, sp, 1001.5, 2, 0, put);
    near([put.x, put.y, put.z], [2.2 * sin, 2, -2.2 * cos], 9);
    expect(Math.hypot(put.x - camA.px, put.y - camA.py, put.z - camA.pz)).toBeCloseTo(2.2, 9);
  });

  it('an opponent keeps its place relative to the listener that hears it, whichever that is', () => {
    // near seat 0: nothing moves
    computeSpatial(camA, 3, 2, -20, 0, 0, 0, false, sp);
    placeSplit(camA, camA, 0, false, sp, 3, 2, -20, put);
    near([put.x, put.y, put.z, put.cx, put.cy, put.cz], [3, 2, -20, 3, 2, -20], 12);
    // near seat 1: 12 m ahead of it and 2 m to its right -> 12 ahead, 2 right of seat 0
    computeSpatial(camB, 1012, 2, 2, 0, 0, 0, false, sp);
    placeSplit(camA, camB, 1, false, sp, 1012, 2, 2, put);
    near([put.x, put.y, put.z], [2, 2, -12], 9);
    near([put.cx, put.cy, put.cz], [2, 2, -12], 9); // the chassis voice follows
    // and it is never swung
    expect(Math.hypot(put.x - camA.px, put.z - camA.pz)).toBeCloseTo(Math.hypot(12, 2), 9);
  });

  it('a trackside camera hears the human car where it is (no swing far away)', () => {
    const tv = listenerAt([0, 6, 0], 0);
    computeSpatial(tv, 1, 1, -60, 0, 0, 0, true, sp);
    placeSplit(tv, tv, 1, true, sp, 1, 1, -60, put);
    near([put.x, put.y, put.z], [1, 1, -60], 9);
  });
});

describe('the distance an opponent is heard from', () => {
  it('the tiers follow the nearer human: an opponent 30 m from seat 1 and 1000 m from seat 0 is not cut off', () => {
    const camA = listenerAt([0, 2, 0], 0);
    const camB = listenerAt([1000, 2, 0], -Math.PI / 2);
    const st = makeVehicleState();
    st.position.set(1030, 2, 0);
    const alone = new CarFrame(false);
    alone.compute(st, 1 / 60, camA, 0, 2, false);
    expect(alone.vec[CTL.GAIN]).toBe(0); // out of range of the only listener
    const heard = nearestListener(camA, camB, 1030, 2, 0) === 1 ? camB : camA;
    const split = new CarFrame(false);
    split.compute(st, 1 / 60, heard, 0, 2, false);
    expect(split.sp.distance).toBeCloseTo(30, 9);
    expect(split.vec[CTL.GAIN]).toBe(lodFade(30));
    expect(split.vec[CTL.GAIN]).toBe(1);
    expect(LOD_FULL_RADIUS).toBeGreaterThan(30);
  });
});

describe('CarFrame trim', () => {
  const L = makeListener();
  const st = makeVehicleState();

  it('is 1 by default, and turns a player down to SPLIT_PLAYER_TRIM in engine and chassis alike', () => {
    const f = new CarFrame(true);
    f.compute(st, 1 / 60, L, 0, 2, false);
    expect([f.vec[CTL.GAIN], f.vec[CTL.CH_GAIN]]).toEqual([1, 1]);
    f.trim = SPLIT_PLAYER_TRIM;
    f.compute(st, 1 / 60, L, 0, 2, false);
    expect([f.vec[CTL.GAIN], f.vec[CTL.CH_GAIN]]).toEqual([TRIM32, TRIM32]);
    expect([f.vec[CTL.QUALITY], f.vec[CTL.CH_QUALITY]]).toEqual([2, 2]); // still the full voice
    f.compute(st, 1 / 60, L, 0, 2, true);
    expect([f.vec[CTL.GAIN], f.vec[CTL.CH_GAIN]]).toEqual([0, 0]); // paused is paused
  });

  it("leaves an opponent's level to its distance", () => {
    const f = new CarFrame(false);
    f.trim = SPLIT_PLAYER_TRIM;
    const s2 = makeVehicleState();
    s2.position.set(0, 0, -20);
    f.compute(s2, 1 / 60, L, 0, 2, false);
    expect(f.vec[CTL.GAIN]).toBe(1);
    s2.position.set(0, 0, -135);
    f.compute(s2, 1 / 60, L, 0, 2, false);
    expect(f.vec[CTL.GAIN]).toBe(lodFade(135));
  });
});

// ── the level of two human voices ────────────────────────────────────────────

/** A player's voice as the worklet renders it: the engine (mono) and the chassis (stereo), driven by a recorded standing start. */
function renderPlayer(carId: string, seed: number, seconds: number): Voice {
  const car = CARS.find((c) => c.id === carId)!;
  const sim = new DriveSim(car, { gear: 1, speed: 0 });
  const frame = new CarFrame(true);
  const listener = makeListener();
  const eng = new EngineVoice(SR, car.sound, seed, calibratedExhaustGain(car.sound, SR));
  const ch = new ChassisVoice(SR, seed + 7);
  const n = Math.floor(seconds * SR);
  const e = new Float32Array(n);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const step = Math.round(SR / 60);
  for (let k = 0; k * step < n; k++) {
    sim.step(1 / 60, 1);
    listener.pz = sim.st.position.z + 2.2;
    frame.compute(sim.st, 1 / 60, listener, 0, 2, false);
    readEngineInputs(frame.vec, eng.inp);
    readChassisInputs(frame.vec, ch.inp);
    const a = k * step;
    const len = Math.min(step, n - a);
    eng.process(e.subarray(a, a + len), len);
    ch.process(l.subarray(a, a + len), r.subarray(a, a + len), len);
  }
  return { eng: e, cl: l, cr: r };
}

interface Voice {
  eng: Float32Array;
  cl: Float32Array;
  cr: Float32Array;
}

/**
 * The master input as the graph makes it (graph.ts, default volumes): the engine through its equal-power panner and the engine bus,
 * the chassis' own stereo through the effects bus, both through the master gain. `pan` is -1 (left) .. 1 (right).
 */
function mix(voices: { v: Voice; pan: number; trim: number }[]): { l: Float32Array; r: Float32Array } {
  const eBus = volumeCurve(0.9);
  const fBus = volumeCurve(0.85);
  const master = volumeCurve(0.85);
  const n = voices[0].v.eng.length;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (const { v, pan, trim } of voices) {
    const x = (pan + 1) / 2;
    const gl = Math.cos((x * Math.PI) / 2) * eBus * trim * master;
    const gr = Math.sin((x * Math.PI) / 2) * eBus * trim * master;
    const f = fBus * trim * master;
    for (let i = 0; i < n; i++) {
      l[i] += v.eng[i] * gl + v.cl[i] * f;
      r[i] += v.eng[i] * gr + v.cr[i] * f;
    }
  }
  return { l, r };
}

const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-9));

/** RMS of both channels (dB), the loudest second (dB), the peak (dB) and the share of samples past the limiter's knee (0.8). */
function level(m: { l: Float32Array; r: Float32Array }, from: number): { rmsDb: number; loudestDb: number; peakDb: number; kneeShare: number; limited: number } {
  const n = m.l.length;
  const curve = makeLimiterCurve(4097);
  let s = 0;
  let k = 0;
  let pk = 0;
  let lim = 0;
  for (let i = from; i < n; i++) {
    s += m.l[i] * m.l[i] + m.r[i] * m.r[i];
    const a = Math.max(Math.abs(m.l[i]), Math.abs(m.r[i]));
    if (a > pk) pk = a;
    if (a > 0.8) k++;
    // through the soft limiter at the end of the master chain (a static curve; the compressor before it only lowers a loud mix)
    for (const x of [m.l[i], m.r[i]]) lim = Math.max(lim, Math.abs(curve[Math.round(((Math.max(-1, Math.min(1, x)) + 1) / 2) * (curve.length - 1))]));
  }
  let loud = 0;
  for (let a = from; a + SR <= n; a += SR / 4) {
    let w = 0;
    for (let i = a; i < a + SR; i++) w += m.l[i] * m.l[i] + m.r[i] * m.r[i];
    loud = Math.max(loud, w / (2 * SR));
  }
  return { rmsDb: db(Math.sqrt(s / (2 * (n - from)))), loudestDb: db(Math.sqrt(loud)), peakDb: db(pk), kneeShare: k / (n - from), limited: lim };
}

describe('the level of two human voices (real synthesis, full throttle from a standing start)', () => {
  // 14 s of acceleration through the gears; the first 4 s (first gear, building up) are left out of the measurement
  const seconds = 14;
  const from = 4 * SR;
  // the engine panner's pan for a swing of 15 degrees (the equal-power panner maps the azimuth linearly: azimuth / 90 degrees)
  const pan = SPLIT_SEPARATION_DEG / 90;
  let vanta1: Voice;
  let vanta2: Voice;
  let kestrel: Voice;
  let lmp: Voice;
  let one: ReturnType<typeof level>;
  const two = (other: Voice, trim: number) => level(mix([{ v: vanta1, pan: -pan, trim }, { v: other, pan, trim }]), from);
  beforeAll(() => {
    vanta1 = renderPlayer('vanta-gt', 11, seconds);
    vanta2 = renderPlayer('vanta-gt', 29, seconds);
    kestrel = renderPlayer('kestrel-r', 31, seconds);
    lmp = renderPlayer('lmp-x', 37, seconds);
    one = level(mix([{ v: vanta1, pan: 0, trim: 1 }]), from);
    // four players' worth of real synthesis: a few seconds alone, far more while the machine is busy with something else
  }, 60_000);

  it('untrimmed, a second voice adds about 2 to 4 dB: the doubling the trim is there to take away', () => {
    expect(two(vanta2, 1).rmsDb - one.rmsDb).toBeGreaterThan(1.5);
    expect(two(lmp, 1).rmsDb - one.rmsDb).toBeGreaterThan(2.5);
    expect(two(lmp, 1).peakDb - one.peakDb).toBeGreaterThan(3.5);
  });

  it('with SPLIT_PLAYER_TRIM two voices stay within 1.5 dB of one untrimmed voice, for equal and for unequal pairs', () => {
    const rows: string[] = [];
    for (const [name, other] of [['vanta+vanta', vanta2], ['vanta+kestrel', kestrel], ['vanta+lmp-x', lmp]] as const) {
      const t = two(other, SPLIT_PLAYER_TRIM);
      rows.push(`${name}: rms ${(t.rmsDb - one.rmsDb).toFixed(2)} dB, loudest second ${(t.loudestDb - one.loudestDb).toFixed(2)} dB, peak ${(t.peakDb - one.peakDb).toFixed(2)} dB`);
      expect(Math.abs(t.rmsDb - one.rmsDb)).toBeLessThan(1.5);
      expect(Math.abs(t.loudestDb - one.loudestDb)).toBeLessThan(1.5);
      expect(t.peakDb - one.peakDb).toBeLessThan(3); // the prototype's peaks are what reach above one voice's
      expect(t.kneeShare).toBe(0); // never into the limiter's knee
      expect(t.limited).toBeLessThan(1);
    }
    // (the numbers behind SPLIT_PLAYER_TRIM: SPLIT_AUDIO_LOG=1 npx vitest run tests/audio-split.test.ts --reporter=verbose)
    if (process.env.SPLIT_AUDIO_LOG) console.log(`split trim ${SPLIT_PLAYER_TRIM} against one untrimmed voice (${one.rmsDb.toFixed(1)} dB rms, ${one.peakDb.toFixed(1)} dB peak):\n  ${rows.join('\n  ')}`);
  });

  it('is close to the equal-power value 1/sqrt(2), a little above it, and below 1', () => {
    expect(SPLIT_PLAYER_TRIM).toBeGreaterThan(Math.SQRT1_2);
    expect(SPLIT_PLAYER_TRIM).toBeLessThan(0.8);
  });
});

// ── the audio system, in split mode, over a stand-in context ─────────────────

class FParam {
  value = 0;
  setValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number): this {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
}

class FNode {
  out: FNode[] = [];
  connect(dest?: FNode): FNode {
    if (dest) this.out.push(dest);
    return dest ?? this;
  }
  disconnect(): void {}
}
class FGain extends FNode {
  gain = new FParam();
}
class FFilter extends FNode {
  type = '';
  Q = new FParam();
  frequency = new FParam();
}
class FPanner extends FNode {
  positionX = new FParam();
  positionY = new FParam();
  positionZ = new FParam();
  panningModel = '';
  distanceModel = '';
  refDistance = 1;
  maxDistance = 1;
  rolloffFactor = 1;
  coneInnerAngle = 0;
  coneOuterAngle = 0;
  coneOuterGain = 0;
  at(): [number, number, number] {
    return [this.positionX.value, this.positionY.value, this.positionZ.value];
  }
}
class FCompressor extends FNode {
  threshold = new FParam();
  knee = new FParam();
  ratio = new FParam();
  attack = new FParam();
  release = new FParam();
}
class FShaper extends FNode {
  curve: Float32Array | null = null;
  oversample = 'none';
}
class FConvolver extends FNode {
  buffer: unknown = null;
}

/** An AudioWorkletNode that only remembers what it was told. */
class FWorklet extends FNode {
  static made: FWorklet[] = [];
  readonly posts: Float32Array[] = [];
  readonly port = {
    postMessage: (m: unknown): void => {
      if (m instanceof Float32Array) this.posts.push(Float32Array.from(m));
    },
    close: (): void => {},
  };
  constructor(
    readonly ctx: unknown,
    readonly name: string,
    readonly options: unknown,
  ) {
    super();
    FWorklet.made.push(this);
  }
  last(): Float32Array {
    return this.posts[this.posts.length - 1];
  }
  /** Engine panner and chassis end of a car's graph (createCarNodes connects output 0 to the engine filter, output 1 to the chassis'). */
  get enginePanner(): FPanner {
    return this.out[0].out[0] as FPanner;
  }
  get chassisEnd(): FNode {
    return this.out[1].out[0];
  }
}

function fakeContext(): BaseAudioContext {
  const listener = {
    positionX: new FParam(),
    positionY: new FParam(),
    positionZ: new FParam(),
    forwardX: new FParam(),
    forwardY: new FParam(),
    forwardZ: new FParam(),
    upX: new FParam(),
    upY: new FParam(),
    upZ: new FParam(),
  };
  const buffer = (ch: number, len: number, sr: number) => ({ length: len, sampleRate: sr, numberOfChannels: ch, getChannelData: () => new Float32Array(len) });
  const ctx = {
    state: 'running',
    currentTime: 0,
    sampleRate: SR,
    destination: new FNode(),
    listener,
    audioWorklet: { addModule: () => Promise.resolve() },
    createGain: () => new FGain(),
    createBiquadFilter: () => new FFilter(),
    createPanner: () => new FPanner(),
    createDynamicsCompressor: () => new FCompressor(),
    createWaveShaper: () => new FShaper(),
    createConvolver: () => new FConvolver(),
    createBuffer: buffer,
    addEventListener: () => undefined,
  };
  return ctx as unknown as BaseAudioContext;
}

const VOLUMES = { master: 0.85, engine: 0.9, effects: 0.85, music: 0.5, raceMusic: 0.45, ui: 0.6 };
const profile = CARS[0].sound;

beforeAll(() => {
  vi.stubGlobal('AudioWorkletNode', FWorklet);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

/** The world of a scene: two cameras a kilometre apart, each with a human 1.5 m ahead of it, and opponents about. */
interface Scene {
  sys: ReturnType<typeof createAudioSystemOn>;
  ctx: BaseAudioContext;
  camA: PerspectiveCamera;
  camB: PerspectiveCamera;
  humans: ReturnType<typeof makeVehicleState>[];
  ais: ReturnType<typeof makeVehicleState>[];
  voices: { h0: FWorklet; h1: FWorklet; ai: FWorklet[] };
  cars: { update(st: ReturnType<typeof makeVehicleState>, dt: number): void; setInterior(on: boolean): void; dispose(): void }[];
  frame(split: boolean, dt?: number): void;
}

const camAt = (x: number, y: number, z: number, yaw: number): PerspectiveCamera => {
  const c = new PerspectiveCamera();
  c.position.set(x, y, z);
  c.rotation.set(0, yaw, 0, 'YXZ');
  c.updateMatrixWorld();
  return c;
};

async function makeScene(aiAt: [number, number, number][]): Promise<Scene> {
  FWorklet.made.length = 0;
  const ctx = fakeContext();
  const sys = createAudioSystemOn(ctx, VOLUMES);
  await sys.ready;
  const camA = camAt(0, 2, 0, 0); // looking down -Z
  const camB = camAt(1000, 2, 0, -Math.PI / 2); // looking down +X
  const humans = [makeVehicleState(0), makeVehicleState(1)];
  humans[0].position.set(0, 2, -1.5);
  humans[1].position.set(1001.5, 2, 0);
  const ais = aiAt.map((p, i) => {
    const s = makeVehicleState(10 + i);
    s.position.set(...p);
    return s;
  });
  const cars = [sys.createCarSound(profile, true, 0), sys.createCarSound(profile, true, 1), ...ais.map(() => sys.createCarSound(profile, false))] as Scene['cars'];
  const scene: Scene = {
    sys,
    ctx,
    camA,
    camB,
    humans,
    ais,
    voices: { h0: null as unknown as FWorklet, h1: null as unknown as FWorklet, ai: [] },
    cars,
    frame(split: boolean, dt = 1 / 60) {
      if (split) {
        sys.setListener(camA, new Vector3(), 0);
        sys.setListener(camB, new Vector3(), 1);
      } else sys.setListener(camA, new Vector3(), 0);
      cars[0].update(humans[0], dt);
      cars[1].update(humans[1], dt);
      ais.forEach((s, i) => cars[2 + i].update(s, dt));
      sys.update(dt);
    },
  };
  scene.frame(false); // the voices are built by the first update
  const made = FWorklet.made.filter((w) => w.name === 'xr-car');
  scene.voices = { h0: made[0], h1: made[1], ai: made.slice(2) };
  return scene;
}

describe('AudioSystem alone (no split): the single-player sound, untouched', () => {
  it('a human sits where computeSpatial puts it for the one listener, at full level; opponents where they are; no trim anywhere', async () => {
    const s = await makeScene([[3, 2, -20]]);
    for (let i = 0; i < 4; i++) s.frame(false);
    const L = listenerAt([0, 2, 0], 0);
    const sp = makeSpatialOut();
    computeSpatial(L, 0, 2, -1.5, 0, 0, 0, true, sp);
    expect(s.voices.h0.enginePanner.at()).toEqual([sp.x, sp.y, sp.z]);
    expect([sp.x, sp.y, sp.z]).toEqual([0, 2, -2.2].map((v) => expect.closeTo(v, 9)));
    // the second human, with nobody to split the screen with, is any other player car: 1 km from the listener, where it is
    computeSpatial(L, 1001.5, 2, 0, 0, 0, 0, true, sp);
    expect(s.voices.h1.enginePanner.at()).toEqual([sp.x, sp.y, sp.z]);
    computeSpatial(L, 3, 2, -20, 0, 0, 0, false, sp);
    expect(s.voices.ai[0].enginePanner.at()).toEqual([3, 2, -20]);
    expect((s.voices.ai[0].chassisEnd as FPanner).at()).toEqual([3, 2, -20]);
    expect((s.voices.ai[0].out[0] as FFilter).frequency.value).toBe(sp.lpHz);
    for (const w of [s.voices.h0, s.voices.h1, s.voices.ai[0]]) expect([w.last()[CTL.GAIN], w.last()[CTL.CH_GAIN]]).toEqual([1, 1]);
  });

  it('seat 1 of setListener is only stored: it changes nothing until split is on', async () => {
    const s = await makeScene([[3, 2, -20]]);
    s.sys.setListener(s.camB, new Vector3(), 1);
    for (let i = 0; i < 3; i++) {
      s.cars[0].update(s.humans[0], 1 / 60);
      s.cars[1].update(s.humans[1], 1 / 60);
      s.cars[2].update(s.ais[0], 1 / 60);
      s.sys.update(1 / 60);
    }
    near(s.voices.h0.enginePanner.at(), [0, 2, -2.2], 9);
    expect(s.voices.h0.last()[CTL.GAIN]).toBe(1);
    near(s.voices.ai[0].enginePanner.at(), [3, 2, -20], 9);
  });
});

describe('AudioSystem in split mode', () => {
  it('seat 1 needs its camera: until it has given one, nothing changes', async () => {
    const s = await makeScene([[3, 2, -20]]);
    s.sys.setSplit(true);
    s.sys.setListener(s.camA, new Vector3(), 0);
    for (let i = 0; i < 3; i++) {
      s.cars[0].update(s.humans[0], 1 / 60);
      s.cars[1].update(s.humans[1], 1 / 60);
      s.sys.update(1 / 60);
    }
    expect(s.voices.h0.last()[CTL.GAIN]).toBe(1);
    expect(s.voices.h1.last()[CTL.GAIN]).toBe(1);
    s.frame(true);
    expect(s.voices.h0.last()[CTL.GAIN]).toBe(TRIM32);
    expect(s.voices.h1.last()[CTL.GAIN]).toBe(TRIM32);
  });

  it('puts both human cars in front of the real listener, seat 0 left of seat 1, at the trimmed level; opponents at theirs', async () => {
    const s = await makeScene([[3, 2, -20], [1012, 2, 2], [500, 2, 0]]);
    s.sys.setSplit(true);
    s.frame(true);
    s.frame(true);
    const sin = Math.sin(15 * DEG);
    const cos = Math.cos(15 * DEG);
    // the humans: 2.2 m ahead of THEIR camera, turned 15 degrees apart, and so 2.2 m ahead of the real listener (seat 0's camera)
    near(s.voices.h0.enginePanner.at(), [-2.2 * sin, 2, -2.2 * cos], 5);
    near(s.voices.h1.enginePanner.at(), [2.2 * sin, 2, -2.2 * cos], 5);
    for (const h of [s.voices.h0, s.voices.h1]) {
      expect(h.last()[CTL.GAIN]).toBe(TRIM32);
      expect(h.last()[CTL.CH_GAIN]).toBe(TRIM32);
      expect(h.last()[CTL.QUALITY]).toBe(2);
    }
    // opponents: one near seat 0 (untouched), one near seat 1 (12 ahead, 2 right of it -> 12 ahead, 2 right of seat 0)
    near(s.voices.ai[0].enginePanner.at(), [3, 2, -20], 5);
    near(s.voices.ai[1].enginePanner.at(), [2, 2, -12], 4);
    near((s.voices.ai[1].chassisEnd as FPanner).at(), [2, 2, -12], 4);
    expect(s.voices.ai[0].last()[CTL.GAIN]).toBe(1);
    expect(s.voices.ai[1].last()[CTL.GAIN]).toBe(1);
    // one 500 m from both is out of everyone's range
    expect(s.voices.ai[2].last()[CTL.GAIN]).toBe(0);
    // the real listener is seat 0's camera
    expect((s.ctx.listener as unknown as { positionY: FParam }).positionY.value).toBe(2);
    expect((s.ctx.listener as unknown as { positionX: FParam }).positionX.value).toBe(0);
  });

  it("opponents near either human are all heard: the tiers are filled from both neighbourhoods", async () => {
    const around: [number, number, number][] = [];
    for (let i = 0; i < 3; i++) around.push([4 + i * 3, 2, -30 - i * 6]); // near seat 0
    for (let i = 0; i < 5; i++) around.push([1030 + i * 4, 2, 3 - i]); // near seat 1, 1 km away from seat 0
    const s = await makeScene(around);
    s.sys.setSplit(true);
    for (let i = 0; i < 4; i++) s.frame(true); // (the tier is handed out after a frame and used by the next)
    const q = s.voices.ai.map((w) => w.last()[CTL.QUALITY]);
    expect(q.filter((x) => x === 2)).toHaveLength(MAX_FULL_AI);
    expect(q.filter((x) => x === 0)).toHaveLength(0); // with one listener the five near seat 1 would all be cut
    expect(q.filter((x) => x === 1)).toHaveLength(around.length - MAX_FULL_AI);
  });

  it('the rain ambience follows both humans: half a cabin when one is inside, the faster car\'s wind', async () => {
    const s = await makeScene([]);
    s.sys.setSplit(true);
    s.sys.setWeather(0.6, 0.6);
    s.humans[0].speed = 20;
    s.humans[1].speed = 55;
    s.cars[0].setInterior(true);
    s.cars[1].setInterior(false);
    s.frame(true);
    s.frame(true);
    const rain = FWorklet.made.find((w) => w.name === 'xr-weather')!;
    expect(rain).toBeDefined();
    expect(rain.last()[WCTL.INTERIOR]).toBeCloseTo(0.5, 6);
    expect(rain.last()[WCTL.SPEED]).toBeCloseTo(55, 4);
    s.cars[1].setInterior(true);
    s.frame(true);
    expect(rain.last()[WCTL.INTERIOR]).toBeCloseTo(1, 6);
    // one human gone: the other one's
    s.cars[1].dispose();
    s.cars[0].setInterior(false);
    s.frame(true);
    expect(rain.last()[WCTL.INTERIOR]).toBe(0);
    expect(rain.last()[WCTL.SPEED]).toBeCloseTo(20, 4);
  });

  it('setSplit(false) is the single listener again, exactly as a system that never split', async () => {
    // (opponents that stay inside seat 0's hearing: a voice that is cut off only refreshes now and then, and when is its own business)
    const places: [number, number, number][] = [[3, 2, -20], [60, 1, -10], [-40, 2, 30]];
    const never = await makeScene(places);
    const was = await makeScene(places);
    was.sys.setSplit(true);
    for (let i = 0; i < 10; i++) was.frame(true);
    for (let i = 0; i < 10; i++) never.frame(false);
    was.sys.setSplit(false);
    // what each voice is told, and where each panner sits, from the second frame after the switch on
    const record = (s: Scene): { vec: number[][]; pos: number[][]; lp: number[]; chg: number[] } => {
      const vec: number[][] = [];
      const pos: number[][] = [];
      const lp: number[] = [];
      const chg: number[] = [];
      for (let f = 0; f < 6; f++) {
        // identical movement in both
        s.humans.forEach((h, i) => h.position.z += 0.2 * (i + 1));
        s.ais.forEach((a, i) => a.position.x += 0.1 * (i + 1));
        s.frame(false);
        if (f < 2) continue;
        for (const w of [s.voices.h0, s.voices.h1, ...s.voices.ai]) {
          vec.push(Array.from(w.last()));
          pos.push(w.enginePanner.at());
          lp.push((w.out[0] as unknown as FFilter).frequency.value);
          const end = w.chassisEnd;
          if (end instanceof FPanner) pos.push(end.at());
          else chg.push((end as FGain).gain.value);
        }
      }
      return { vec, pos, lp, chg };
    };
    const a = record(was);
    const b = record(never);
    expect(a.vec).toEqual(b.vec);
    expect(a.pos).toEqual(b.pos);
    expect(a.lp).toEqual(b.lp);
    expect(a.chg).toEqual(b.chg);
    // and the human cars are at full level, as in the single-player game
    expect(was.voices.h0.last()[CTL.GAIN]).toBe(1);
    expect(was.voices.h1.last()[CTL.GAIN]).toBe(1);
  });

  it('a car sound built before the split, or after it, takes part; disposing one leaves the other', async () => {
    const s = await makeScene([[3, 2, -20]]);
    s.sys.setSplit(true);
    s.frame(true);
    const late = s.sys.createCarSound(profile, false);
    const st = makeVehicleState(77);
    st.position.set(1005, 2, 0);
    s.sys.setListener(s.camA, new Vector3(), 0);
    s.sys.setListener(s.camB, new Vector3(), 1);
    late.update(st, 1 / 60);
    late.update(st, 1 / 60);
    const w = FWorklet.made.filter((x) => x.name === 'xr-car').pop()!;
    near(w.enginePanner.at(), [0, 2, -5], 4); // 5 m ahead of seat 1's camera -> 5 m ahead of seat 0's
    s.cars[1].dispose();
    expect(() => s.frame(true)).not.toThrow();
    expect(s.voices.h0.last()[CTL.GAIN]).toBe(TRIM32);
  });

  it('the silent stand-in (no Web Audio) takes setSplit and a seat too', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const silent = createAudioSystem(VOLUMES);
    warn.mockRestore();
    expect(() => {
      silent.setSplit(true);
      silent.setListener(camAt(0, 0, 0, 0), new Vector3(), 1);
      silent.createCarSound(profile, true, 1).update(makeVehicleState(), 1 / 60);
      silent.setSplit(false);
    }).not.toThrow();
  });
});
