/**
 * Replays of long races: the buffer holds ten minutes at 30 Hz, and a longer race halves the rate instead of losing its
 * end, so the replay always runs from the lights to the flag. And the clock of a replay: it is the race's own, however often
 * the pictures the frames were taken from were drawn, and it stops when the recording is closed (the results are up).
 */
import { describe, expect, it } from 'vitest';
import { makeVehicleState } from '../sandbox/audio/drive-sim';
import type { DamageEvent } from '../src/core/damage';
import { ReplayPlayer, ReplayRecorder } from '../src/game/replay';

const hit: DamageEvent = { type: 'hit', kind: 'wall', strength: 9, p: [0, 0.5, 2], n: [0, 0, -1], slide: [0, 0, 0] };

describe('long replays', () => {
  it('keeps the whole race past ten minutes at a lower rate, with the damage timeline in step', () => {
    const states = [makeVehicleState(0)];
    const rec = new ReplayRecorder(1, 0);
    const seconds = 1500;
    let hitAt = -1;
    for (let k = 0; k <= seconds * 60; k++) {
      const t = k / 60;
      // the car's x is the race time, so a frame's position says when it was recorded
      states[0].position.set(t, 0, 0);
      if (k === 1200 * 60) {
        rec.addDamage(0, hit);
        hitAt = t;
      }
      rec.capture(t, states);
    }
    expect(rec.rate).toBe(7.5);
    expect(rec.duration).toBeGreaterThan(seconds - 1);
    const player = new ReplayPlayer(rec, states);
    for (const t of [0, 100, 599, 601, 1000, 1499]) {
      player.apply(t);
      expect(player.states[0].position.x).toBeCloseTo(t, 0);
    }
    // the hit is still stamped where it happened: between the frames either side of 1200 s
    const f = rec.damage[0][0].f;
    expect(f / rec.rate).toBeGreaterThan(hitAt - 2 / rec.rate);
    expect(f / rec.rate).toBeLessThan(hitAt + 1 / rec.rate);
  });

  it('replays every surface under the wheels, the winter ones too', () => {
    const states = [makeVehicleState(0)];
    const rec = new ReplayRecorder(1, 0);
    const kinds = ['asphalt', 'curb', 'concrete', 'grass', 'gravel', 'sand', 'dirt', 'snow', 'ice', 'deepsnow'] as const;
    kinds.forEach((s, k) => {
      for (const w of states[0].wheels) w.surface = s;
      rec.capture(k / 30, states); // (one frame each: the recorder keeps 30 a second)
    });
    rec.capture(kinds.length / 30, states); // (and one past the last, which is a frame's end)
    const player = new ReplayPlayer(rec, [makeVehicleState(0)]);
    kinds.forEach((s, k) => {
      player.apply((k + 0.25) / 30);
      expect(player.states[0].wheels.map((w) => w.surface)).toEqual([s, s, s, s]);
    });
  });

  it('records a short race at the full rate', () => {
    const states = [makeVehicleState(0)];
    const rec = new ReplayRecorder(1, 0);
    for (let k = 0; k <= 120 * 60; k++) rec.capture(k / 60, states);
    expect(rec.rate).toBe(30);
    expect(rec.frames).toBe(120 * 30 + 1);
  });
});

/**
 * The race's clock as the game hands it to the recorder: the physics world's, which moves in steps of 1 ms, read once for every
 * picture drawn. `each` is called with it after every picture; the clock at the end is returned.
 */
function raceClock(fps: number, seconds: number, each: (t: number) => void): number {
  let time = 0;
  let acc = 0;
  const pictures = Math.round(seconds * fps);
  for (let k = 0; k < pictures; k++) {
    acc += 1 / fps;
    while (acc >= 0.001) {
      acc -= 0.001;
      time += 0.001;
    }
    each(time);
  }
  return time;
}

/**
 * A replay runs on the race's own clock. The recorder used to count on a frame every 1/30 s and took one from the first picture
 * that came at least that long after the last: at 60 pictures a second, on a clock that moves in whole milliseconds, that was every
 * third picture (33 ms is not yet 33.3), 20 frames a second played back as 30. A five-minute race was a replay of 3 min 20 s.
 */
describe('the clock of a replay', () => {
  const RATES = [20, 25, 30, 40, 45, 50, 60, 75, 90, 120, 144, 165, 240];

  it.each(RATES)('plays a second of the race in a second of replay, recorded at %i pictures a second', (fps) => {
    const states = [makeVehicleState(0), makeVehicleState(1)];
    const rec = new ReplayRecorder(2, 0);
    const lights = 6.4; // (the countdown is not recorded: the first frame is not at 0 on the race's clock)
    const end = raceClock(fps, 120, (t) => {
      // each car's x is the race's clock (the second car's, three times it), so a frame's position says when it was recorded
      states[0].position.set(t, 0, 0);
      states[1].position.set(3 * t, 0, 0);
      if (t >= lights) rec.capture(t, states);
    });
    const first = rec.time[0];
    expect(first).toBeGreaterThanOrEqual(lights);
    expect(first).toBeLessThan(lights + 0.06);
    // as long as the race was, to within a frame
    expect(rec.duration).toBeGreaterThan(end - first - 1.5 / Math.min(fps, 30));
    expect(rec.duration).toBeLessThanOrEqual(end - first);
    // 30 frames a second when the pictures come at least that often (the buffer holds ten minutes of them), else every picture
    expect(rec.frames).toBeGreaterThan(rec.duration * Math.min(fps, 30) * 0.98);
    expect(rec.frames).toBeLessThanOrEqual(rec.duration * 30 + 2);
    const player = new ReplayPlayer(rec, states);
    for (const t of [0, 0.31, 1, 17.77, 60, 100, rec.duration - 0.2]) {
      player.apply(t);
      expect(player.clock).toBeCloseTo(first + t, 9);
      expect(player.states[0].position.x).toBeCloseTo(first + t, 2);
      expect(player.states[1].position.x).toBeCloseTo(3 * (first + t), 2);
    }
    // past the end: the last frame
    player.apply(rec.duration + 30);
    expect(player.clock).toBeCloseTo(first + rec.duration, 9);
    expect(player.states[0].position.x).toBeCloseTo(first + rec.duration, 1);
  });

  it.each([40, 60, 144])('keeps to the clock past ten minutes too, where the rate is halved (%i pictures a second)', (fps) => {
    const states = [makeVehicleState(0), makeVehicleState(1), makeVehicleState(2)];
    const rec = new ReplayRecorder(3, 0);
    const end = raceClock(fps, 1300, (t) => {
      states.forEach((s, c) => s.position.set((c + 1) * t, 0, 0));
      rec.capture(t, states);
    });
    expect(rec.rate).toBe(7.5);
    expect(rec.duration).toBeGreaterThan(end - rec.time[0] - 0.3);
    const player = new ReplayPlayer(rec, states);
    for (const t of [0, 3.3, 299, 599.9, 600.1, 900, 1201, 1299]) {
      player.apply(t);
      // (the positions are 32-bit floats: a millimetre at 4 km)
      player.states.forEach((s, c) => expect(s.position.x).toBeCloseTo((c + 1) * (rec.time[0] + t), 1));
    }
  });

  it('records nothing once it is closed: what the cars do behind the results is not the race', () => {
    const states = [makeVehicleState(0)];
    const rec = new ReplayRecorder(1, 0);
    const flag = raceClock(60, 20, (t) => {
      states[0].position.set(t, 0, 0);
      rec.capture(t, states);
    });
    rec.addDamage(0, hit);
    rec.close();
    const frames = rec.frames;
    const duration = rec.duration;
    // behind the results: the car is braked to a stop, for as long as they are read, and hits something on the way
    for (let k = 1; k <= 60 * 60; k++) {
      states[0].position.set(flag + 3, 0, 0);
      rec.capture(flag + k / 60, states);
    }
    rec.addDamage(0, hit);
    expect(rec.frames).toBe(frames);
    expect(rec.duration).toBe(duration);
    expect(rec.damage[0].length).toBe(1);
    const player = new ReplayPlayer(rec, states);
    player.apply(duration + 30);
    expect(player.states[0].position.x).toBeCloseTo(flag, 1);
  });
});
