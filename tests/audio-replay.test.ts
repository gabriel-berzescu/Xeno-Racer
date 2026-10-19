/**
 * The sound of a replay (headless): the loud "pac - pac" that came with watching a race again.
 *
 * What it was: an opponent's engine is rendered in full quality only while it is one of the four nearest cars within 80 m of the listener,
 * and in a cheaper "lite" quality (80..150 m, or beyond the four nearest) otherwise. The lite voice does not render the engine block or the
 * valve ticks, but their inputs, fed by every combustion, were never drained: they piled up for as long as the voice stayed lite, and the
 * moment it was promoted to full (a car coming into range, a TV camera cutting onto a pack) all of it was thrown into the resonators in one
 * sample. 24 times the level of the engine after one second in lite, 370 times after twenty: a loud crack from a car that was only just coming
 * into earshot. A replay, with its trackside cameras and cuts, promotes a voice every 1.5 seconds; a race from the car's own camera about
 * every six, and under the player's own engine.
 *
 * Also here: what a voice that has been out of earshot must not play on waking (the shifts, backfires, thumps and hits it missed), and
 * what a replay starting over (its counters go back) must not play.
 */
import { describe, expect, it } from 'vitest';
import { CARS } from '../src/cars';
import { peakAbs, rms } from '../src/audio/analysis';
import { ChassisMapper } from '../src/audio/chassis-controls';
import { CarFrame } from '../src/audio/carsound';
import { CTL, makeControlVector, readEngineInputs } from '../src/audio/controls';
import { ChassisVoice } from '../src/audio/dsp/chassis-voice';
import { EngineVoice, calibratedExhaustGain, createEngineDebug } from '../src/audio/dsp/engine-voice';
import { assignLod, listenerFromMatrix, makeListener, type Lod } from '../src/audio/spatial';
import { ReplayPlayer, ReplayRecorder } from '../src/game/replay';
import { DriveSim, makeVehicleState } from '../sandbox/audio/drive-sim';

const SR = 48000;

function render(v: EngineVoice, seconds: number): Float32Array {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  v.process(out, n);
  return out;
}

/** A voice rendering a steady engine at `quality`: wide open throttle, or the throttle shut at high revs (the overrun that crackles). */
function steadyVoice(car: (typeof CARS)[number], quality: number, mode: 'wot' | 'overrun'): EngineVoice {
  const v = new EngineVoice(SR, car.sound, 5);
  const e = car.physics.engine;
  Object.assign(v.inp, {
    rpm: e.redlineRpm * (mode === 'wot' ? 0.75 : 0.85),
    throttle: mode === 'wot' ? 1 : 0,
    load: mode === 'wot' ? 1 : 0,
    boost: mode === 'wot' ? 0.8 : 0,
    idleRpm: e.idleRpm,
    limiterRpm: e.limiterRpm,
    redlineRpm: e.redlineRpm,
    quality,
    gain: 1,
  });
  return v;
}

describe('an opponent promoted from lite to full quality', () => {
  for (const car of CARS) {
    for (const mode of ['wot', 'overrun'] as const) {
      it(`${car.id}, ${mode}: no burst after five seconds in lite (it was 25 to 150 times the engine's own level)`, () => {
        // the engine's own level, in either quality
        const lite = steadyVoice(car, 1, mode);
        render(lite, 1);
        const liteLevel = peakAbs(render(lite, 1));
        const full = steadyVoice(car, 2, mode);
        render(full, 1);
        const fullLevel = peakAbs(render(full, 1));
        // five seconds in lite, then promoted
        const v = steadyVoice(car, 1, mode);
        render(v, 5);
        v.inp.quality = 2;
        const after = render(v, 0.5);
        const level = Math.max(liteLevel, fullLevel);
        expect(peakAbs(after, 0, Math.floor(0.15 * SR))).toBeLessThan(2.5 * level);
        // (and no ringing of the block that lingers either)
        expect(rms(after, Math.floor(0.05 * SR), Math.floor(0.2 * SR))).toBeLessThan(2.5 * Math.max(rms(render(steadyVoice(car, 2, mode), 0.5)), 1e-3));
      });
    }
  }

  it('how long it spent in lite does not matter: the promotion after 0.5 s and after 20 s are the same size', () => {
    const car = CARS[0];
    const burst = (secs: number): number => {
      const v = steadyVoice(car, 1, 'wot');
      render(v, secs);
      v.inp.quality = 2;
      return peakAbs(render(v, 0.3));
    };
    const short = burst(0.5);
    const long = burst(20);
    expect(long).toBeLessThan(short * 2 + 0.2);
  });

  it('demoting to lite and promoting again does not click either', () => {
    const car = CARS[0];
    const v = steadyVoice(car, 2, 'wot');
    render(v, 1);
    const steady = peakAbs(render(v, 0.5));
    let worst = 0;
    for (let k = 0; k < 6; k++) {
      v.inp.quality = 1;
      worst = Math.max(worst, peakAbs(render(v, 0.7)));
      v.inp.quality = 2;
      worst = Math.max(worst, peakAbs(render(v, 0.7)));
    }
    expect(worst).toBeLessThan(2.5 * steady);
  });
});

describe('a car passing a trackside camera, the way a replay hears it', () => {
  it('the engine of an opponent that comes into range, is promoted to full, and leaves again has no burst in it', () => {
    const car = CARS[0];
    const sim = new DriveSim(car, { gear: 4, speed: 60 });
    const frame = new CarFrame(false);
    const eng = new EngineVoice(SR, car.sound, 7, calibratedExhaustGain(car.sound, SR));
    const listener = makeListener();
    // a camera on a mast 20 m beside the road, looking across it
    const cam = { elements: new Float32Array(16) };
    cam.elements[0] = cam.elements[5] = cam.elements[10] = cam.elements[15] = 1;
    cam.elements[12] = 20;
    cam.elements[13] = 4;
    listenerFromMatrix(cam.elements, 0, 0, 0, listener);
    const dist = [0];
    const lodOut: Lod[] = [2];
    const order: number[] = [];
    const vec = frame.vec;
    const out: number[] = [];
    const tiers: number[] = [];
    let z = -330;
    const dt = 1 / 60;
    let level = 0;
    let n = 0;
    for (let f = 0; f < 60 * 11; f++) {
      sim.step(dt, 1);
      sim.st.position.set(0, 0.5, z);
      z += sim.st.speed * dt;
      const st = sim.st;
      frame.compute(st, dt, listener, 0, 2, false, 0);
      dist[0] = frame.sp.distance;
      assignLod(dist, 1, lodOut, order);
      frame.compute(st, dt, listener, 0, lodOut[0], false, 0);
      tiers.push(lodOut[0]);
      readEngineInputs(vec, eng.inp);
      const block = new Float32Array(Math.round(SR * dt));
      eng.process(block, block.length);
      // what the listener hears of it: the distance the panner puts on it (an opponent: refDistance 4, rolloff 1.15)
      const g = 4 / (4 + 1.15 * Math.max(0, frame.sp.distance - 4));
      for (let i = 0; i < block.length; i++) out.push(block[i] * g * vec[CTL.GAIN]);
      if (lodOut[0] === 2) {
        level += rms(block) * g;
        n++;
      }
    }
    // it was in all three tiers
    expect(tiers).toContain(0);
    expect(tiers).toContain(1);
    expect(tiers).toContain(2);
    // nothing in the whole pass stands out of the engine's own level at the listener (the burst was a peak of 25 and more at the source)
    const all = Float32Array.from(out);
    const typical = level / Math.max(1, n);
    expect(peakAbs(all)).toBeLessThan(Math.max(0.25, 12 * typical));
  });
});

describe('a voice that was out of earshot', () => {
  it('an engine does not play the shifts and backfires it missed when it wakes up', () => {
    for (const car of CARS) {
      const v = steadyVoice(car, 2, 'wot');
      v.inp.shiftCount = 7;
      v.inp.backfireCount = 3;
      render(v, 0.8);
      v.inp.quality = 0; // beyond 150 m: asleep
      v.inp.gain = 0;
      render(v, 1);
      v.inp.shiftCount = 9;
      v.inp.backfireCount = 6;
      v.inp.quality = 2; // and back
      v.inp.gain = 1;
      const n = Math.floor(0.3 * SR);
      const dbg = createEngineDebug(n);
      v.debug = dbg;
      render(v, 0.3);
      expect(peakAbs(dbg.events), car.id).toBeLessThan(1e-6);
      // a shift that happens now still clunks
      v.inp.shiftCount = 10;
      const dbg2 = createEngineDebug(n);
      v.debug = dbg2;
      render(v, 0.3);
      expect(peakAbs(dbg2.events), car.id).toBeGreaterThan(0.02);
    }
  });

  it('a chassis voice does not play the hit and the thump it missed, with the strength of the last ones', () => {
    const level = (changed: boolean): number => {
      const v = new ChassisVoice(SR, 9);
      Object.assign(v.inp, { quality: 1, gain: 1, speed: 50, impactCount: 4, impactStrength: 18, impactKind: 0, thumpCount: 10, thumpStrength: 0.8 });
      const run = (secs: number): Float32Array => {
        const out = new Float32Array(Math.floor(secs * SR));
        v.process(out, null, out.length);
        return out;
      };
      run(0.5);
      v.inp.quality = 0;
      v.inp.gain = 0;
      run(1);
      if (changed) {
        v.inp.impactCount = 5;
        v.inp.thumpCount = 11;
      }
      v.inp.quality = 1;
      v.inp.gain = 1;
      return peakAbs(run(0.3));
    };
    expect(level(true)).toBeLessThan(level(false) * 1.5 + 0.01);
  });
});

describe('a replay starting over', () => {
  it('the counters going back are not a shift, a backfire or a hit', () => {
    const car = CARS[1];
    const v = steadyVoice(car, 2, 'wot');
    v.inp.shiftCount = 12;
    v.inp.backfireCount = 5;
    render(v, 0.8);
    // the replay begins again: the recorded counts are those of the first frame
    v.inp.shiftCount = 0;
    v.inp.backfireCount = 0;
    const n = Math.floor(0.3 * SR);
    const dbg = createEngineDebug(n);
    v.debug = dbg;
    render(v, 0.3);
    expect(peakAbs(dbg.events)).toBeLessThan(1e-6);
    // the first shift of the replay is one
    v.inp.shiftCount = 1;
    const dbg2 = createEngineDebug(n);
    v.debug = dbg2;
    render(v, 0.3);
    expect(peakAbs(dbg2.events)).toBeGreaterThan(0.02);

    const m = new ChassisMapper();
    const st = makeVehicleState();
    const vec = makeControlVector();
    st.impactCount = 6;
    m.update(st, 1 / 60, vec);
    st.impactCount = 7;
    st.lastImpact.strength = 12;
    m.update(st, 1 / 60, vec);
    expect(vec[CTL.IMPACT_COUNT]).toBe(1);
    st.impactCount = 0; // started over
    m.update(st, 1 / 60, vec);
    expect(vec[CTL.IMPACT_COUNT]).toBe(1);
    st.impactCount = 1; // and its first hit is a hit
    st.lastImpact.strength = 9;
    m.update(st, 1 / 60, vec);
    expect(vec[CTL.IMPACT_COUNT]).toBe(2);
    expect(vec[CTL.IMPACT_STRENGTH]).toBe(9);
  });
});

describe('what a replay hands the sound', () => {
  /** Drive a car for `seconds` with lifts and shifts, record it as the game does, and play it back. */
  function recordRun(seconds: number): { live: ReturnType<typeof counts>; rec: ReplayRecorder; template: ReturnType<typeof makeVehicleState> } {
    const car = CARS[0];
    const sim = new DriveSim(car, { gear: 1, speed: 5, seed: 77 });
    const rec = new ReplayRecorder(1, 0);
    const frame = new CarFrame(false);
    const listener = makeListener();
    const live = counts();
    let prev = counters(frame.vec);
    for (let f = 0; f < 60 * seconds; f++) {
      const t = f / 60;
      // full throttle, with a lift every few seconds
      const thr = Math.floor(t / 4) % 2 === 1 ? 0 : 1;
      sim.step(1 / 60, thr, thr === 0 ? 0.4 : 0);
      rec.capture(t, [sim.st]);
      frame.compute(sim.st, 1 / 60, listener, 0, 2, false, 0);
      if (f > 0) tally(live, prev, frame.vec);
      prev = counters(frame.vec);
    }
    return { live, rec, template: sim.st };
  }
  const counts = (): { shift: number; backfire: number; limiter: number } => ({ shift: 0, backfire: 0, limiter: 0 });
  const counters = (v: Float32Array): number[] => [v[CTL.SHIFT_COUNT], v[CTL.BACKFIRE_COUNT], v[CTL.LIMITER]];
  const tally = (c: ReturnType<typeof counts>, p: number[], v: Float32Array): void => {
    if (v[CTL.SHIFT_COUNT] !== p[0]) c.shift++;
    if (v[CTL.BACKFIRE_COUNT] !== p[1]) c.backfire++;
    if (v[CTL.LIMITER] > 0.5 && p[2] <= 0.5) c.limiter++;
  };

  it('the stand-ins of a replay carry no stale suspension velocity (the recording has none): a frozen one made a thump every 0.11 s', () => {
    const template = makeVehicleState();
    for (const w of template.wheels) w.suspensionVelocity = 1.4; // a wheel hitting a kerb at the moment "Watch replay" was pressed
    const rec = new ReplayRecorder(1, 0);
    for (let k = 0; k < 90; k++) rec.capture(k / 30, [template]);
    const player = new ReplayPlayer(rec, [template]);
    const m = new ChassisMapper();
    const vec = makeControlVector();
    for (let f = 0; f < 60 * 2; f++) {
      player.apply(f / 60);
      m.update(player.states[0], 1 / 60, vec);
    }
    for (const w of player.states[0].wheels) expect(w.suspensionVelocity).toBe(0);
    expect(vec[CTL.THUMP_COUNT]).toBe(0);
    // (the same stand-in states with the stale value left in make the thumps)
    const stale = new ReplayPlayer(rec, [template]);
    for (const w of stale.states[0].wheels) w.suspensionVelocity = 1.4;
    const m2 = new ChassisMapper();
    const vec2 = makeControlVector();
    for (let f = 0; f < 60 * 2; f++) {
      stale.apply(f / 60);
      for (const w of stale.states[0].wheels) w.suspensionVelocity = 1.4;
      m2.update(stale.states[0], 1 / 60, vec2);
    }
    expect(vec2[CTL.THUMP_COUNT]).toBeGreaterThan(10);
  });

  it('a recorded run triggers as many shifts and backfires when played back as when it was driven', () => {
    const { live, rec, template } = recordRun(30);
    expect(live.shift).toBeGreaterThan(4);
    const player = new ReplayPlayer(rec, [template]);
    const frame = new CarFrame(false);
    const listener = makeListener();
    const rep = counts();
    player.apply(0);
    frame.compute(player.states[0], 1 / 60, listener, 0, 2, false, 0);
    let prev = counters(frame.vec);
    for (let t = 1 / 60; t <= rec.duration; t += 1 / 60) {
      player.apply(t);
      frame.compute(player.states[0], 1 / 60, listener, 0, 2, false, 0);
      tally(rep, prev, frame.vec);
      prev = counters(frame.vec);
    }
    expect(rep.shift).toBe(live.shift);
    // (two backfires within one recorded 1/30 s are one in the replay)
    expect(rep.backfire).toBeLessThanOrEqual(live.backfire);
    expect(rep.backfire).toBeGreaterThanOrEqual(Math.floor(live.backfire * 0.8));
  });
});
