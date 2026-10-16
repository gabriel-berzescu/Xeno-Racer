/**
 * The aids that live above the physics (src/core/aids.ts, src/ai/guide.ts, src/game/driveraids.ts): the colours of the driving line,
 * the braking assist, the assist presets, and the guide that works the line's speeds out for the player's car and the water on the road.
 */
import { describe, expect, it } from 'vitest';
import { computeRacingLine, computeSpeedProfile, DrivingGuide, ProfileJob } from '../src/ai';
import { CARS, getCar } from '../src/cars';
import {
  applyAssistPreset,
  ASSIST,
  ASSIST_PRESET_IDS,
  ASSIST_PRESETS,
  assistsOfSeat,
  BrakeAssist,
  brakeDemand,
  carAssists,
  lineColor,
  lineFade,
  lineLead,
  lineRange,
  lineShownIn,
  lineShows,
  lineUrgency,
  lineWidth,
  matchAssistPreset,
  neededDecel,
  pedalFor,
  type BrakeCall,
  type SpeedLine,
} from '../src/core/aids';
import type { CameraMode, PlayerAssists } from '../src/core/contracts';
import { neutralEffects } from '../src/core/mechanical';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { loadTrackRuntime } from '../src/track';
import { assistedLaps } from './probes/assist-lap';

const call = (): BrakeCall => ({ demand: 0, over: 0 });

// ─────────────────────────────────────────────────────────────────────────────
// What colour is the line
// ─────────────────────────────────────────────────────────────────────────────

describe('the driving line: how hard it says to brake', () => {
  it('has nothing to say to a car that is no faster than the line', () => {
    expect(neededDecel(30, 40, 100)).toBe(0);
    expect(neededDecel(40, 40, 100)).toBe(0);
    // (the line's own margin: a car a hair over is still on it)
    expect(neededDecel(40.4, 40, 100)).toBe(0);
    expect(lineUrgency(30, 40, 100, 10)).toBe(0);
  });

  it('is the deceleration that brings the car to the line speed by the point, over what the car brakes at', () => {
    // 80 m/s down to 20 m/s in 300 m: (6400 - 400) / 600 = 10 m/s^2 (less the margin the line allows)
    const a = neededDecel(80, 20, 300);
    expect(a).toBeGreaterThan(9.5);
    expect(a).toBeLessThan(10.1);
    expect(lineUrgency(80, 20, 300, 10)).toBeCloseTo(a / 10, 6);
  });

  it('grows as the corner comes nearer and as the car is faster, and falls as the car brakes', () => {
    const far = lineUrgency(60, 20, 400, 12);
    const near = lineUrgency(60, 20, 200, 12);
    const nearer = lineUrgency(60, 20, 100, 12);
    expect(far).toBeLessThan(near);
    expect(near).toBeLessThan(nearer);
    expect(lineUrgency(70, 20, 200, 12)).toBeGreaterThan(near);
    expect(lineUrgency(45, 20, 200, 12)).toBeLessThan(near);
  });

  it('lets a car be a few per cent over its top speed where the line asks for all it has (a slipstream, a descent), and not elsewhere', () => {
    const top = 88;
    // the line asks the top speed; the car is drafting 5 % over it: nothing to brake for
    expect(neededDecel(top * 1.05, top, 200, top)).toBe(0);
    expect(lineUrgency(top * 1.05, top, 200, 10, top)).toBe(0);
    // a long way over is still too much
    expect(neededDecel(top * 1.3, top, 200, top)).toBeGreaterThan(0);
    // and a corner is a corner: the car 5 % over the speed of a corner at 0.8 of the top speed has everything to brake for
    expect(neededDecel(top * 0.84, top * 0.8, 100, top)).toBeGreaterThan(0);
    // without a top speed to go by it is the plain rule
    expect(neededDecel(top * 1.05, top, 200)).toBeGreaterThan(0);
  });

  it('counts a point under the nose as a few metres away, not none', () => {
    const u = lineUrgency(30, 20, 0, 12);
    expect(Number.isFinite(u)).toBe(true);
    expect(u).toBeCloseTo(lineUrgency(30, 20, 8, 12), 9);
    expect(lineUrgency(30, 20, -5, 12)).toBeCloseTo(u, 9);
  });

  it('is 1 for a car on time: braking as the line does along the whole braking zone', () => {
    // a profile that brakes at 10 m/s^2 into a corner at 20 m/s; a car exactly on it asks for what the profile brakes at
    const a = 10;
    for (const x of [60, 150, 300]) {
      const v = Math.sqrt(20 * 20 + 2 * a * x);
      const u = lineUrgency(v, 20, x, a);
      expect(u).toBeGreaterThan(0.9);
      expect(u).toBeLessThan(1.02);
    }
  });
});

describe('the driving line: colours', () => {
  const rgb = (u: number): number[] => {
    const out = [0, 0, 0];
    lineColor(u, out);
    return out;
  };

  it('is green for nothing to do, amber to lift or brake soon, red to brake now', () => {
    const [gr, gg, gb] = rgb(0);
    expect(gg).toBeGreaterThan(gr * 4);
    expect(gg).toBeGreaterThan(gb * 3);
    const [ar, ag, ab] = rgb(0.4);
    expect(ar).toBeGreaterThan(0.8);
    expect(ag).toBeGreaterThan(0.4);
    expect(ab).toBeLessThan(0.1);
    const [rr, rg, rb] = rgb(1);
    expect(rr).toBeGreaterThan(rg * 10);
    expect(rr).toBeGreaterThan(rb * 10);
  });

  it('moves smoothly from green to red as the urgency grows, and is as red as it gets from 1 up', () => {
    let prevG = Infinity;
    for (let u = 0; u <= 1.0001; u += 0.05) {
      const [r, g] = rgb(u);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(prevG + 1e-9);
      prevG = g;
      expect(r).toBeLessThanOrEqual(1.5);
    }
    expect(rgb(3)).toEqual(rgb(1));
    expect(rgb(-1)).toEqual(rgb(0));
  });

  it('writes into the array it is given, at the offset it is given, and leaves the rest alone', () => {
    const out = new Float32Array([9, 9, 9, 9, 9]);
    lineColor(1, out, 1);
    expect(out[0]).toBe(9);
    expect(out[4]).toBe(9);
    expect(out[1]).toBeGreaterThan(0.5);
  });

  it('shows all of the line in Full, only the stretches that ask for a lift or the brake in Braking zones, none when off', () => {
    for (const u of [0, 0.5, 1]) expect(lineShows('full', u)).toBe(1);
    expect(lineShows('braking', 0)).toBe(0);
    expect(lineShows('braking', 0.05)).toBe(0);
    expect(lineShows('braking', 0.5)).toBe(1);
    expect(lineShows('braking', 1)).toBe(1);
    const mid = lineShows('braking', 0.2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    for (const u of [0, 0.5, 1]) expect(lineShows('off', u)).toBe(0);
  });

  it('comes out in front of the car and fades into the distance, and is gone behind the car', () => {
    const range = lineRange(50);
    expect(lineFade(-20, range)).toBe(0);
    expect(lineFade(0, range)).toBe(0);
    expect(lineFade(30, range)).toBe(1);
    expect(lineFade(range * 0.5, range)).toBeCloseTo(1, 6);
    expect(lineFade(range, range)).toBe(0);
    expect(lineFade(range * 2, range)).toBe(0);
    let prev = 1;
    for (let d = range * 0.5; d <= range; d += 5) {
      const f = lineFade(d, range);
      expect(f).toBeLessThanOrEqual(prev + 1e-9);
      prev = f;
    }
    // (it grows from nothing to everything between the nose and a few car lengths ahead)
    expect(lineFade(5, range)).toBeGreaterThan(0);
    expect(lineFade(5, range)).toBeLessThan(1);
  });

  it('starts a little further out and is drawn narrower for the low cameras (bumper, hood), where the nearest metres of a full ribbon would fill the picture', () => {
    const range = lineRange(50);
    expect(lineLead('chase')).toBe(0);
    expect(lineLead('cockpit')).toBe(0);
    expect(lineLead('hood')).toBeGreaterThan(0);
    expect(lineLead('bumper')).toBeGreaterThanOrEqual(lineLead('hood'));
    expect(lineFade(2, range, lineLead('bumper'))).toBe(0);
    expect(lineFade(5, range, lineLead('bumper'))).toBeLessThan(lineFade(5, range, 0));
    // (the same line from there on: it is all there a lead further out)
    expect(lineFade(30, range, lineLead('bumper'))).toBe(1);
    // and drawn narrower from the low lens, whole width everywhere else
    expect(lineWidth('chase')).toBe(1);
    expect(lineWidth('cockpit')).toBe(1);
    expect(lineWidth('bumper')).toBeLessThan(lineWidth('hood'));
    expect(lineWidth('hood')).toBeLessThan(1);
  });

  it('is drawn further ahead the faster the car goes, within limits', () => {
    expect(lineRange(0)).toBe(100);
    expect(lineRange(30)).toBeLessThan(lineRange(60));
    expect(lineRange(100)).toBeLessThanOrEqual(320);
    expect(lineRange(1000)).toBe(320);
  });

  it('shows in the cameras that look along the car\'s road, and in no other', () => {
    const shown: CameraMode[] = ['chase', 'chase-far', 'hood', 'bumper', 'cockpit'];
    const hidden: CameraMode[] = ['tv', 'orbit'];
    for (const m of shown) expect(lineShownIn(m)).toBe(true);
    for (const m of hidden) expect(lineShownIn(m)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The guide: the AI's line and speeds for the player's car and the water on the road
// ─────────────────────────────────────────────────────────────────────────────

describe('the driving guide', () => {
  const aurelia = loadTrackRuntime('aurelia');

  /** The slowest point of the line, and the speed of the line `back` metres before it. */
  function hairpin(g: DrivingGuide): { s: number; v: number } {
    let sMin = 0;
    let vMin = Infinity;
    for (let s = 0; s < aurelia.length; s += 4) {
      const v = g.targetAt(s);
      if (v < vMin) {
        vMin = v;
        sMin = s;
      }
    }
    return { s: sMin, v: vMin };
  }

  it('asks a car for the speeds that car can carry: an LMP-X brakes later and corners faster than a Ronin', () => {
    const lmp = new DrivingGuide(aurelia, getCar('lmp-x'));
    const ronin = new DrivingGuide(aurelia, getCar('ronin-86'));
    let faster = 0;
    let total = 0;
    for (let s = 0; s < aurelia.length; s += 10) {
      total++;
      if (lmp.targetAt(s) >= ronin.targetAt(s)) faster++;
    }
    expect(faster / total).toBeGreaterThan(0.95);
    const a = hairpin(lmp);
    const b = hairpin(ronin);
    expect(a.v).toBeGreaterThan(b.v);
    // it brakes later: 120 m before its hairpin the LMP-X's line still asks for more than the Ronin's does before its own
    expect(lmp.targetAt(a.s - 120)).toBeGreaterThan(ronin.targetAt(b.s - 120));
  });

  it('knows the water on the road: wet, it asks for less speed, and for the braking to start earlier', () => {
    const dry = new DrivingGuide(aurelia, getCar('vanta-gt'));
    const wet = new DrivingGuide(aurelia, getCar('vanta-gt'), { wetness: 0.75 });
    expect(wet.lineBlend).toBe(1);
    expect(dry.lineBlend).toBe(0);
    let slower = 0;
    for (let s = 0; s < aurelia.length; s += 10) {
      if (wet.targetAt(s) <= dry.targetAt(s) + 0.01) slower++;
    }
    expect(slower / Math.floor(aurelia.length / 10)).toBeGreaterThan(0.97);
    // the same car at the same speed and place: the colour of the line is further along the way to red in the wet
    const h = hairpin(dry);
    const speed = 62; // m/s
    for (const back of [200, 260, 330]) {
      const uDry = lineUrgency(speed, dry.targetAt(h.s - 20), back - 20, dry.brakeAt(speed));
      const uWet = lineUrgency(speed, wet.targetAt(h.s - 20), back - 20, wet.brakeAt(speed));
      expect(uWet).toBeGreaterThan(uDry);
    }
    // and it can brake less hard at the profile's pace
    expect(wet.brakeAt(60)).toBeLessThan(dry.brakeAt(60));
  });

  it('works the speeds out again, in slices and with no jump, when the water on the road moves', () => {
    const g = new DrivingGuide(aurelia, getCar('vanta-gt'), { weatherMayChange: true });
    const before = new Float32Array(g.speeds);
    g.setWetness(0.7);
    const wet = new DrivingGuide(aurelia, getCar('vanta-gt'), { wetness: 0.7 }).speeds;
    let worstStep = 0;
    let frames = 0;
    let prev = new Float32Array(g.speeds);
    // (a frame at 60 fps; the work is done in slices over some of them, then the old speeds blend into the new)
    for (; frames < 600; frames++) {
      g.update(1 / 60);
      let step = 0;
      for (let i = 0; i < g.speeds.length; i++) step = Math.max(step, Math.abs(g.speeds[i] - prev[i]));
      worstStep = Math.max(worstStep, step);
      prev = new Float32Array(g.speeds);
      let same = true;
      for (let i = 0; i < g.speeds.length && same; i++) if (Math.abs(g.speeds[i] - wet[i]) > 1e-4) same = false;
      if (same) break;
    }
    expect(frames).toBeLessThan(600);
    // it did not arrive at once (the slices and the blend take a second or two), and no frame moved a speed by more than a little
    expect(frames).toBeGreaterThan(60);
    expect(worstStep).toBeLessThan(0.6);
    // it ended on the profile a guide built wet has
    for (let i = 0; i < wet.length; i++) expect(g.speeds[i]).toBeCloseTo(wet[i], 3);
    expect(before.some((v, i) => Math.abs(v - wet[i]) > 0.5)).toBe(true);
    // and the line itself has moved from the dry racing line to the wet one (a few seconds: it keeps the wheels off the painted kerbs)
    for (let i = 0; i < 240; i++) g.update(1 / 60);
    expect(g.lineBlend).toBe(1);
  });

  it('settles at once when it is asked to (a guide that has been idle while the weather moved)', () => {
    const g = new DrivingGuide(aurelia, getCar('vanta-gt'), { weatherMayChange: true });
    g.setWetness(0.9);
    g.settle();
    const wet = new DrivingGuide(aurelia, getCar('vanta-gt'), { wetness: 0.9 }).speeds;
    for (let i = 0; i < wet.length; i++) expect(g.speeds[i]).toBeCloseTo(wet[i], 3);
  });

  it('does not work the speeds out again for a trace of water, or for a trace of damage', () => {
    const g = new DrivingGuide(aurelia, getCar('vanta-gt'), { weatherMayChange: true });
    const same = new Float32Array(g.speeds);
    g.setWetness(0.01);
    for (let i = 0; i < 200; i++) g.update(1 / 60);
    expect(Array.from(g.speeds)).toEqual(Array.from(same));
  });

  it('asks a damaged car for less (Damage: Full), like the AI that drives it', () => {
    const g = new DrivingGuide(aurelia, getCar('vanta-gt'));
    const before = new Float32Array(g.speeds);
    const hurt = neutralEffects();
    hurt.aeroFront = 0.6;
    hurt.aeroRear = 0.6;
    hurt.camberGrip = [0.85, 0.85, 0.85, 0.85];
    g.setDamage(hurt);
    g.settle();
    let lower = 0;
    for (let i = 0; i < before.length; i++) if (g.speeds[i] < before[i] - 1e-3) lower++;
    expect(lower).toBeGreaterThan(before.length / 20);
    g.setDamage(null);
    g.settle();
    for (let i = 0; i < before.length; i++) expect(g.speeds[i]).toBeCloseTo(before[i], 3);
  });
});

describe('a speed profile worked out in slices', () => {
  it('is bit for bit the profile worked out in one go', () => {
    for (const [trackId, carId, wet] of [['aurelia', 'vanta-gt', 0], ['kuroyama', 'lmp-x', 0.6], ['portovela', 'ronin-86', 1]] as const) {
      const track = loadTrackRuntime(trackId);
      const def = getCar(carId);
      const line = computeRacingLine(track, { edgeMargin: def.visual.width / 2 - 0.25 + (wet > 0 ? 0.45 : 0) });
      const o = { gripUse: 0.9, brakeUse: 0.84, wetness: wet };
      const whole = computeSpeedProfile(track, line, def, o);
      const job = new ProfileJob(track, line, def, o);
      let slices = 0;
      while (!job.advance(777)) slices++;
      expect(slices).toBeGreaterThan(5);
      expect(Array.from(job.speeds)).toEqual(Array.from(whole.v));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The braking assist
// ─────────────────────────────────────────────────────────────────────────────

/** A line that asks 60 m/s up to 400 m, brakes at `a` m/s^2 into a corner at `vc` m/s at `sc` metres, and holds it. */
function cornerLine(sc: number, vc: number, a: number): SpeedLine {
  return {
    targetAt: (s) => {
      if (s >= sc) return vc;
      return Math.min(60, Math.sqrt(vc * vc + 2 * a * (sc - s)));
    },
  };
}

describe('the braking assist: what it asks for', () => {
  const line = cornerLine(600, 20, 8);

  it('asks for nothing of a car drafting past its top speed on a straight', () => {
    const straight: SpeedLine = { targetAt: () => 88, topSpeed: 88 };
    expect(brakeDemand(straight, 100, 88 * 1.06, call()).demand).toBe(0);
    expect(brakeDemand({ targetAt: () => 88 }, 100, 88 * 1.06, call()).demand).toBeGreaterThan(0);
  });

  it('asks for nothing while the car is within the speed of the line', () => {
    expect(brakeDemand(line, 0, 50, call()).demand).toBe(0);
    expect(brakeDemand(line, 100, 55, call()).demand).toBe(0);
    // inside the braking zone, a car that is under the speed the line has a moment ahead (the time the brakes take) is where it should be
    expect(brakeDemand(line, 450, line.targetAt(450 + 50 * ASSIST.lag) - 2, call()).demand).toBe(0);
  });

  it('asks for the line\'s own pace of braking the moment the car is over it, and more the further over it is', () => {
    const s = 450;
    const onLine = line.targetAt(s + 60 * ASSIST.lag);
    const a = brakeDemand(line, s, onLine + 2, call());
    const b = brakeDemand(line, s, onLine + 5, call());
    const c = brakeDemand(line, s, onLine + 9, call());
    expect(a.demand).toBeGreaterThan(5);
    expect(b.demand).toBeGreaterThan(a.demand);
    expect(c.demand).toBeGreaterThan(b.demand);
    expect(a.over).toBeGreaterThan(0);
    expect(c.over).toBeGreaterThan(b.over);
  });

  it('is gentle where the line is steady and the car a little over it (holding a speed through a corner)', () => {
    const d = brakeDemand(line, 650, 21.2, call());
    expect(d.over).toBeGreaterThan(0.5);
    expect(d.over).toBeLessThan(1.5);
    expect(d.demand).toBeLessThan(5);
  });

  it('starts the brakes sooner by the time they take to bite: the speed of the line is read that far ahead', () => {
    // a car at 40 m/s on a line that falls off a cliff at 440 m: at 420 m it is 20 m short of the cliff, 0.5 s
    const cliff: SpeedLine = { targetAt: (s) => (s < 440 ? 60 : 15) };
    expect(brakeDemand(cliff, 400, 40, call()).demand).toBe(0);
    expect(brakeDemand(cliff, 432, 40, call()).demand).toBeGreaterThan(0);
  });

  it('turns a deceleration into a pedal: none for none, the whole pedal at most, the ABS-less pedal short of locking the wheels', () => {
    expect(pedalFor(0, 1, 18, 11, true)).toBe(0);
    expect(pedalFor(1, 2, 18, 11, true)).toBe(0);
    expect(pedalFor(9, 0, 18, 11, true)).toBeCloseTo(0.5, 6);
    expect(pedalFor(100, 0, 18, 11, true)).toBe(1);
    // drag helps: it takes some of the need off the brakes
    expect(pedalFor(9, 2, 18, 11, true)).toBeLessThan(pedalFor(9, 0, 18, 11, true));
    // no ABS: never more than a share of what the tyres can use (11 m/s^2 of 18 per full pedal)
    expect(pedalFor(100, 0, 18, 11, false)).toBeCloseTo((ASSIST.noAbsShare * 11) / 18, 6);
    expect(pedalFor(5, 0, 18, 11, false)).toBeCloseTo(5 / 18, 6);
  });
});

describe('the braking assist: what it does to the pedals', () => {
  const run = (assist: BrakeAssist, frames: number, pedal: number, need: number, over = 1, speed = 40, extra: Partial<Parameters<BrakeAssist['step']>[1]> = {}): number[] => {
    const out: number[] = [];
    for (let i = 0; i < frames; i++) out.push(assist.step(1 / 60, { speed, pedal, handbrake: 0, active: true, need, over, drag: 1, gain: 18, grip: 11, abs: true, ...extra }));
    return out;
  };

  it('adds brake to a driver who is not braking, and never takes any away', () => {
    const a = new BrakeAssist();
    const out = run(a, 60, 0, 9);
    expect(out[out.length - 1]).toBeGreaterThan(0.3);
    expect(a.added).toBeGreaterThan(0.3);
    // the driver brakes harder than the assist wants: the pedal that comes out is the driver's, and the assist adds nothing
    const b = new BrakeAssist();
    const o2 = run(b, 60, 0.9, 9);
    for (const v of o2) expect(v).toBeGreaterThanOrEqual(0.9 - 1e-9);
    expect(o2[o2.length - 1]).toBeCloseTo(0.9, 6);
    expect(b.added).toBe(0);
    // a driver who brakes a little: the assist makes up the difference to what is needed, no more
    const c = new BrakeAssist();
    const o3 = run(c, 90, 0.2, 9);
    expect(o3[o3.length - 1]).toBeCloseTo(Math.max(0.2, (9 - 0.8) / 18), 2);
    expect(c.added).toBeGreaterThan(0.1);
  });

  it('is smooth: it rises quickly and falls slowly, with no overshoot and no chatter', () => {
    const a = new BrakeAssist();
    const up = run(a, 40, 0, 12);
    for (let i = 1; i < up.length; i++) expect(up[i]).toBeGreaterThanOrEqual(up[i - 1] - 1e-12);
    const top = up[up.length - 1];
    expect(Math.max(...up)).toBeLessThanOrEqual(top + 1e-9);
    // (63 % of the way in about its rise time)
    expect(up[Math.round(ASSIST.rise * 60)]).toBeGreaterThan(0.3 * top);
    const down = run(a, 60, 0, 0, 0);
    for (let i = 1; i < down.length; i++) expect(down[i]).toBeLessThanOrEqual(down[i - 1] + 1e-12);
    // it lets go more slowly than it took hold
    const fallFrames = down.findIndex((v) => v < 0.5 * top);
    const riseFrames = up.findIndex((v) => v > 0.5 * top);
    expect(fallFrames).toBeGreaterThan(riseFrames);
    // a need that wobbles around nothing does not make the pedal flutter: below the floor it is no pedal at all
    const b = new BrakeAssist();
    const out = [];
    for (let i = 0; i < 120; i++) out.push(b.step(1 / 60, { speed: 40, pedal: 0, handbrake: 0, active: true, need: i % 2 ? 0.2 : 0, over: 0, drag: 1, gain: 18, grip: 11, abs: true }));
    expect(Math.max(...out)).toBe(0);
  });

  it('leaves the brakes alone when it should: slow, reversing, the handbrake on, or the race not running', () => {
    for (const extra of [{ speed: 3 }, { speed: -2 }, { handbrake: 1 }, { active: false }]) {
      const a = new BrakeAssist();
      const out = run(a, 60, 0, 12, 1, 40, extra);
      expect(Math.max(...out)).toBe(0);
      expect(a.added).toBe(0);
      expect(a.throttle(1)).toBe(1);
    }
  });

  it('lifts the throttle as the car goes over the line, and as the brake it adds grows, and not otherwise', () => {
    const a = new BrakeAssist();
    expect(a.throttle(0.8)).toBe(0.8);
    run(a, 30, 0, 0.5, ASSIST.cutOver * 0.3);
    expect(a.throttle(1)).toBeLessThan(1);
    expect(a.throttle(1)).toBeGreaterThan(0.5);
    run(a, 30, 0, 12, 1.5);
    expect(a.throttle(1)).toBe(0);
    expect(a.throttle(0.4)).toBe(0);
    // over the line no more: the throttle comes back
    const b = new BrakeAssist();
    run(b, 60, 0, 0, 0);
    expect(b.throttle(1)).toBe(1);
  });

  it('brings a car to the corner at the line\'s speed with a driver who never touches the brake, and keeps its hands off a driver who brakes well', () => {
    const line = cornerLine(700, 18, 8);
    const gain = 18;
    // a point mass: 60 m/s down a straight, full throttle (it holds 60 m/s), a brake of `gain` m/s^2 at full pedal, 0.4 m/s^2 of drag
    const drive = (driver: (v: number, s: number) => number): { vAt: number; maxPedal: number; flips: number; added: number } => {
      let s = 0;
      let v = 60;
      const a = new BrakeAssist();
      let maxPedal = 0;
      let flips = 0;
      let prevPedal = 0;
      let prevSign = 0;
      let added = 0;
      let vAt = 0;
      const c = call();
      for (let i = 0; i < 60 * 40 && s < 700; i++) {
        const dt = 1 / 60;
        brakeDemand(line, s, v, c);
        const pedal = a.step(dt, { speed: v, pedal: driver(v, s), handbrake: 0, active: true, need: c.demand, over: c.over, drag: 0.4, gain, grip: 11, abs: true });
        added = Math.max(added, a.added);
        // the tyres give 11 m/s^2 at most (ABS holds them there)
        const decel = Math.min(pedal * gain, 11) + 0.4;
        v = Math.max(0, v - decel * dt);
        s += v * dt;
        const sign = Math.sign(pedal - prevPedal);
        if (sign !== 0 && prevSign !== 0 && sign !== prevSign && Math.abs(pedal - prevPedal) > 1e-3 && s > 300) flips++;
        if (sign !== 0) prevSign = sign;
        prevPedal = pedal;
        maxPedal = Math.max(maxPedal, pedal);
        vAt = v;
      }
      return { vAt, maxPedal, flips, added };
    };
    const lazy = drive(() => 0);
    // (it reaches the corner at about the line's speed: within the line's own margin, and never faster than the corner takes)
    expect(lazy.vAt).toBeLessThan(18 * 1.1 + 0.8);
    expect(lazy.vAt).toBeGreaterThan(12);
    expect(lazy.maxPedal).toBeGreaterThan(0.3);
    expect(lazy.maxPedal).toBeLessThanOrEqual(1);
    // a smooth hand on the brakes: the pedal goes up and comes down, it does not flutter
    expect(lazy.flips).toBeLessThanOrEqual(6);
    // a driver who brakes properly (the line's own pace, a little before it) is not fought
    const good = drive((v, s) => {
      const target = line.targetAt(s + v * 0.5);
      return v > target + 0.5 ? Math.min(1, ((v - target) * 3 + 8) / gain) : 0;
    });
    expect(good.vAt).toBeLessThan(18 * 1.1 + 2.5);
    expect(good.added).toBeLessThan(0.35);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Presets and the aids of each seat
// ─────────────────────────────────────────────────────────────────────────────

describe('assist presets', () => {
  it('are Pro (nothing, a manual gearbox), Standard (the default) and Beginner (everything, the line and the braking assist too)', () => {
    const pro = ASSIST_PRESETS.pro;
    expect(pro.abs || pro.esc || pro.autoShift || pro.brakeAssist).toBe(false);
    expect(pro.tcs).toBe('off');
    expect(pro.steeringAssist).toBe(0);
    expect(pro.line).toBe('off');
    expect(ASSIST_PRESETS.standard).toEqual(DEFAULT_SETTINGS.assists);
    const b = ASSIST_PRESETS.beginner;
    expect(b.abs && b.esc && b.autoShift && b.autoClutch && b.brakeAssist).toBe(true);
    expect(b.tcs).toBe('high');
    expect(b.line).toBe('full');
    expect(b.steeringAssist).toBeGreaterThan(DEFAULT_SETTINGS.assists.steeringAssist);
  });

  it('are recognised, and anything else is custom', () => {
    for (const id of ASSIST_PRESET_IDS) expect(matchAssistPreset({ ...ASSIST_PRESETS[id] })).toBe(id);
    const a: PlayerAssists = { ...ASSIST_PRESETS.standard };
    for (const change of [{ abs: false }, { tcs: 'high' as const }, { esc: false }, { autoShift: false }, { autoClutch: false }, { line: 'braking' as const }, { brakeAssist: true }, { steeringAssist: 0.5 }]) {
      expect(matchAssistPreset({ ...a, ...change })).toBe('custom');
    }
    // (a slider nudged off and back on is still the preset: its steps are twentieths)
    expect(matchAssistPreset({ ...a, steeringAssist: 0.35000000000000003 })).toBe('standard');
  });

  it('are put into a set of aids in place, and do not share their objects', () => {
    const a: PlayerAssists = { ...ASSIST_PRESETS.pro };
    const ref = a;
    applyAssistPreset(a, 'beginner');
    expect(a).toBe(ref);
    expect(matchAssistPreset(a)).toBe('beginner');
    a.abs = false;
    expect(ASSIST_PRESETS.beginner.abs).toBe(true);
    expect(DEFAULT_SETTINGS.assists2).not.toBe(DEFAULT_SETTINGS.assists);
  });

  it('give the car the six aids it has, and keep the line and the braking assist out of its physics', () => {
    const c = carAssists({ ...ASSIST_PRESETS.beginner });
    expect(Object.keys(c).sort()).toEqual(['abs', 'autoClutch', 'autoShift', 'esc', 'steeringAssist', 'tcs']);
    expect(c.tcs).toBe('high');
  });

  it('belong to a seat: player 1\'s are `assists`, player 2\'s are `assists2`', () => {
    const s = { assists: { ...ASSIST_PRESETS.pro }, assists2: { ...ASSIST_PRESETS.beginner } };
    expect(assistsOfSeat(s, 0)).toBe(s.assists);
    expect(assistsOfSeat(s, 1)).toBe(s.assists2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// On the road
// ─────────────────────────────────────────────────────────────────────────────

describe('the braking assist on the road (headless physics, steering only, the throttle flat out)', () => {
  it('laps Aurelia and stays on the asphalt with the assist on, and does not without it', () => {
    const on = assistedLaps('aurelia', 'vanta-gt', { laps: 1, assist: true });
    expect(on.finished).toBe(true);
    expect(on.far).toBe(0);
    expect(on.walls).toBe(0);
    expect(on.resets).toBe(0);
    expect(on.assistShare).toBeGreaterThan(0.05);
    // the control: the same driver with no assist goes into the first hairpin at full speed
    const off = assistedLaps('aurelia', 'vanta-gt', { laps: 1, assist: false });
    expect(off.far + off.walls + off.resets).toBeGreaterThan(5);
  });

  it('laps the tightest circuit (Kuroyama, twelve hairpins) in the wet', () => {
    const r = assistedLaps('kuroyama', 'kestrel-r', { laps: 1, wetness: 0.75 });
    expect(r.finished).toBe(true);
    expect(r.far).toBe(0);
    expect(r.walls).toBe(0);
    expect(r.resets).toBe(0);
  });

  it('brings every car in the game round Portovela, whatever its grip and brakes', () => {
    // (the line's speeds are worked out for each car's own tyres and brakes, so the same driver does the lap in each of them)
    for (const c of CARS) {
      const r = assistedLaps('portovela', c.id, { laps: 1 });
      expect(r.finished).toBe(true);
      expect(r.resets).toBe(0);
    }
  });
});
