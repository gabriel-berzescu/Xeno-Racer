/**
 * Race session logic: lap timing from lights-out, finishing order, and the classification of cars
 * still running when the results are shown. Cars are moved along the real track by hand.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { RaceConfig, TrackFrame, VehicleState } from '../src/core/contracts';
import { RaceSession, type Entrant } from '../src/game/session';
import { loadTrackRuntime } from '../src/track';

const track = loadTrackRuntime('aurelia');
const L = track.length;
const frame: TrackFrame = { position: new Vector3(), tangent: new Vector3(), normal: new Vector3(), left: new Vector3(), widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, curvature: 0, bank: 0 };

function fakeState(id: number): VehicleState {
  return { id, position: new Vector3(), velocity: new Vector3() } as unknown as VehicleState;
}

/** Put a car at race distance `dist` (m from the line; negative = on the grid behind it). */
function place(st: VehicleState, dist: number, speed = 50): void {
  const s = ((dist % L) + L) % L;
  track.pointAt(s, 0, st.position);
  track.frameAt(s, frame);
  st.velocity.copy(frame.tangent).multiplyScalar(speed);
}

function setup(n: number, laps: number) {
  const entrants: Entrant[] = [];
  for (let i = 0; i < n; i++) entrants.push({ id: i, name: `car${i}`, color: '#fff', carId: 'vanta-gt', isPlayer: i === 0, state: fakeState(i) });
  entrants.forEach((e, i) => place(e.state, -10 - 8 * i));
  const cfg: RaceConfig = { mode: 'race', trackId: 'aurelia', carId: 'vanta-gt', laps, opponents: n - 1, difficulty: 'pro', environment: { timeOfDay: 'noon', weather: 'clear' }, startPosition: 'pole' };
  const session = new RaceSession(track, cfg, entrants, null, 0);
  return { entrants, session };
}

/** Drive every car at its own constant speed for `seconds`, stepping the session at 60 Hz. */
function drive(session: RaceSession, entrants: Entrant[], dist: number[], speeds: number[], t0: number, seconds: number): number {
  let t = t0;
  for (let k = 0; k < seconds * 60; k++) {
    t += 1 / 60;
    entrants.forEach((e, i) => {
      dist[i] += speeds[i] / 60;
      place(e.state, dist[i], speeds[i]);
    });
    session.update(1 / 60, t);
  }
  return t;
}

describe('race session', () => {
  it('times lap 1 from lights-out and finishes in order', () => {
    const { entrants, session } = setup(2, 2);
    session.startCountdown(0, false);
    expect(session.phase).toBe('racing');
    const dist = [-10, -18];
    // car0 at 60 m/s, car1 at 50 m/s
    drive(session, entrants, dist, [60, 50], 0, (2 * L + 30) / 60);
    const p0 = session.progress[0];
    expect(p0.finished).toBe(true);
    // lap 1 includes the 10 m from the grid slot to the line
    expect(p0.lapTimes[0]).toBeCloseTo((L + 10) / 60, 1);
    expect(p0.lapTimes[1]).toBeCloseTo(L / 60, 1);
    expect(p0.position).toBe(1);
    expect(session.progress[1].finished).toBe(false);
  });

  it('classifies cars still running at the end: projected time on the final lap, laps down otherwise', () => {
    const { entrants, session } = setup(3, 2);
    session.startCountdown(0, false);
    const dist = [-10, -18, -26];
    // car0 fast, car1 slightly slower (on its final lap when car0 finishes), car2 very slow (lapped)
    const t = drive(session, entrants, dist, [60, 52, 25], 0, (2 * L + 30) / 60);
    expect(session.progress[0].finished).toBe(true);
    session.closeRace();
    const res = session.results(false);
    expect(res.entries.map((e) => e.name)).toEqual(['car0', 'car1', 'car2']);
    const [w, second, lapped] = res.entries;
    expect(w.gap).toBe('WINNER');
    // car1: projected to the line at its average pace — a positive time gap, not DNF
    expect(second.totalTime).not.toBeNull();
    expect(second.gap.startsWith('+')).toBe(true);
    expect(second.gap).not.toContain('LAP');
    const elapsed = t - session.startTime;
    const expected = elapsed + (2 * L - dist[1]) / (dist[1] / elapsed);
    expect(second.totalTime!).toBeGreaterThan(w.totalTime!);
    expect(Math.abs(second.totalTime! - expected)).toBeLessThan(3);
    // car2 hasn't started its final lap: classified a lap down
    expect(lapped.gap).toBe('+1 LAP');
    expect(lapped.laps).toBe(1);
  });
});
