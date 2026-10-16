/**
 * Replays of long races: the buffer holds ten minutes at 30 Hz, and a longer race halves the rate instead of losing its
 * end, so the replay always runs from the lights to the flag.
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

  it('records a short race at the full rate', () => {
    const states = [makeVehicleState(0)];
    const rec = new ReplayRecorder(1, 0);
    for (let k = 0; k <= 120 * 60; k++) rec.capture(k / 60, states);
    expect(rec.rate).toBe(30);
    expect(rec.frames).toBe(120 * 30 + 1);
  });
});
