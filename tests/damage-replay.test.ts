import { describe, expect, it } from 'vitest';
import { makeVehicleState } from '../sandbox/audio/drive-sim';
import { getCar } from '../src/cars';
import { CarDamage, hullOf, type DamageEvent, type DamageGeometry, type V3 } from '../src/core/damage';
import { REPLAY_STRIDE, ReplayPlayer, ReplayRecorder } from '../src/game/replay';

const hull = hullOf(getCar('kestrel-r').visual);
const geom: DamageGeometry = {
  surfacePoint: (p, n) => [Math.abs(n[0]) > Math.abs(n[2]) ? (n[0] < 0 ? hull.hw - 0.05 : -hull.hw + 0.05) : p[0], 0.5, Math.abs(n[0]) > Math.abs(n[2]) ? p[2] : n[2] < 0 ? hull.front - 0.05 : hull.rear + 0.05],
  lamps: [
    { c: [0.6, 0.65, 2], r: 0.18 },
    { c: [-0.6, 0.65, 2], r: 0.18 },
    { c: [0.5, 0.8, -2], r: 0.16 },
    { c: [-0.5, 0.8, -2], r: 0.16 },
  ],
};
const hit = (strength: number, p: V3, n: V3): DamageEvent => ({ type: 'hit', kind: 'wall', strength, p, n, slide: [0, 0, 20] });
const snap = (d: CarDamage): string => JSON.stringify({ dents: d.dents, marks: d.marks, lamps: d.lamps, zones: d.zones });

/** Record `frames` frames at 30 Hz; `at(frame)` runs just before that frame is captured (the place to hit things). */
function record(cars: number, frames: number, at: (frame: number, rec: ReplayRecorder, states: ReturnType<typeof makeVehicleState>[]) => void) {
  const states = Array.from({ length: cars }, (_, i) => makeVehicleState(i));
  const rec = new ReplayRecorder(cars, 0);
  for (let f = 0; f < frames; f++) {
    states.forEach((s) => s.position.set(f * 0.5, 0, s.id * 5));
    at(f, rec, states);
    rec.capture(f / 30, states);
  }
  return { states, rec };
}

describe('replay frames', () => {
  it('records the last impact and the scrape point and plays them back where the car touched', () => {
    const { states, rec } = record(2, 12, (f, _r, s) => {
      if (f === 5) {
        s[0].impactCount = 1;
        s[0].lastImpact.strength = 7;
        s[0].lastImpact.kind = 'car';
        s[0].lastImpact.point.set(10, 1, 20);
        s[0].lastImpact.normal.set(0, 0, -1);
      }
      if (f >= 6) s[0].scrapePoint.set(11, 2, 21);
    });
    expect(rec.data.length).toBeGreaterThan(REPLAY_STRIDE * 2 * 12);
    const player = new ReplayPlayer(rec, states);
    player.apply(2 / 30);
    expect(player.states[0].impactCount).toBe(0);
    player.apply(8 / 30);
    const s = player.states[0];
    expect(s.impactCount).toBe(1);
    expect(s.lastImpact.strength).toBeCloseTo(7, 5);
    expect(s.lastImpact.kind).toBe('car');
    expect(s.lastImpact.point.toArray()).toEqual([10, 1, 20]);
    expect(s.lastImpact.normal.toArray()).toEqual([0, 0, -1]);
    expect(s.scrapePoint.toArray()).toEqual([11, 2, 21]);
    // the other car had no impact
    expect(player.states[1].impactCount).toBe(0);
  });

  it('stamps each damage event between the frames it fell between and plays the frame it shows', () => {
    const e = hit(9, [hull.hw, 0.6, hull.front], [-1, 0, 0]);
    const { states, rec } = record(2, 20, (f, r) => {
      if (f === 0) r.addDamage(1, e); // before the first frame was captured
      if (f === 10) r.addDamage(0, e);
    });
    expect(rec.damage[0].map((s) => s.f)).toEqual([9.5]);
    expect(rec.damage[1].map((s) => s.f)).toEqual([-0.5]);
    expect(rec.damage[0][0].e).toBe(e);
    const player = new ReplayPlayer(rec, states);
    player.apply(0);
    expect(player.frame).toBe(0);
    player.apply(0.2);
    expect(player.frame).toBeCloseTo(6, 6);
    // past the end it stops on the last frame
    player.apply(10);
    expect(player.frame).toBeCloseTo(rec.frames - 1.001, 6);
  });

  it('shows the damage of a replay moment, building up as it plays and after any seek', () => {
    const events: DamageEvent[] = [
      hit(14, [hull.hw, 0.6, hull.front], [-1, 0, 0]),
      hit(6, [-hull.hw, 0.6, 0], [1, 0, 0]),
      hit(20, [0, 0.6, hull.rear], [0, 0, 1]),
    ];
    const live = new CarDamage(hull, geom);
    const liveAt: string[] = []; // the live car's damage after each frame
    const { states, rec } = record(1, 60, (f, r) => {
      const idx = [10, 25, 40].indexOf(f);
      if (idx >= 0) {
        live.apply(events[idx]);
        r.addDamage(0, events[idx]);
      }
      liveAt.push(snap(live));
    });
    const player = new ReplayPlayer(rec, states);
    const shown = new CarDamage(hull, geom);
    const at = (t: number): string => {
      player.apply(t);
      shown.syncTo(rec.damage[0], player.frame);
      return snap(shown);
    };
    // playing forward: nothing, then the first hit, then the second, then the third
    expect(at(0)).toBe(snap(new CarDamage(hull, geom)));
    expect(at(9 / 30)).toBe(liveAt[9]);
    expect(at(11 / 30)).toBe(liveAt[11]);
    expect(at(26 / 30)).toBe(liveAt[26]);
    expect(at(58 / 30)).toBe(liveAt[58]);
    // seeking backwards and forwards gives the damage of the moment either way
    for (const f of [30, 5, 41, 12, 0, 59, 24, 25, 26]) expect(at(f / 30), `frame ${f}`).toBe(liveAt[f]);
    // the loop at the end starts from a pristine car
    at(0);
    expect(shown.pristine).toBe(true);
  });
});
