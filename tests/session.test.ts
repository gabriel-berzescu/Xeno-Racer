/**
 * Race session logic: lap timing from lights-out, finishing order, and the classification of cars
 * still running when the results are shown. Cars are moved along the real track by hand.
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { RaceConfig, TrackFrame, VehicleState } from '../src/core/contracts';
import { RaceSession, type Entrant } from '../src/game/session';
import { loadTrackRuntime } from '../src/track';

const track = loadTrackRuntime('aurelia');
const L = track.length;
const frame: TrackFrame = { position: new Vector3(), tangent: new Vector3(), normal: new Vector3(), left: new Vector3(), widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, curvature: 0, bank: 0 };

function fakeState(id: number): VehicleState {
  return { id, position: new Vector3(), velocity: new Vector3(), quaternion: new Quaternion() } as unknown as VehicleState;
}

/** Put a car at race distance `dist` (m from the line; negative = on the grid behind it), facing along the track. */
function place(st: VehicleState, dist: number, speed = 50): void {
  const s = ((dist % L) + L) % L;
  track.pointAt(s, 0, st.position);
  track.frameAt(s, frame);
  st.velocity.copy(frame.tangent).multiplyScalar(speed);
  st.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), frame.tangent);
}

/** `stored`: the player's record for the track and car when the race begins. */
function setup(n: number, laps: number, stored: number | null = null) {
  const entrants: Entrant[] = [];
  for (let i = 0; i < n; i++) entrants.push({ id: i, name: `car${i}`, color: '#fff', carId: 'vanta-gt', isPlayer: i === 0, state: fakeState(i) });
  entrants.forEach((e, i) => place(e.state, -10 - 8 * i));
  const cfg: RaceConfig = { mode: 'race', trackId: 'aurelia', carId: 'vanta-gt', laps, opponents: n - 1, difficulty: 'pro', environment: { timeOfDay: 'noon', weather: 'clear' }, startPosition: 'pole' };
  const session = new RaceSession(track, cfg, entrants, stored, 0);
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

  it('does not complete a lap when a car reverses (or is reset) back over the line and drives on', () => {
    const { entrants, session } = setup(1, 0);
    (session as unknown as { config: RaceConfig }).config.mode = 'timeTrial';
    (session as unknown as { unlimited: boolean }).unlimited = true;
    session.startCountdown(0, false);
    const dist = [-10];
    // a real lap, then park just past the line
    let t = drive(session, entrants, dist, [60], 0, (L + 12) / 60);
    const p = session.progress[0];
    expect(p.lapTimes.length).toBe(1);
    t = drive(session, entrants, dist, [0], t, 17);
    // the reset puts the car 4 m behind the line, then it drives over it again and on for half a lap
    dist[0] -= 6;
    place(entrants[0].state, dist[0], 0);
    session.update(1 / 60, (t += 1 / 60));
    t = drive(session, entrants, dist, [60], t, L / 2 / 60);
    expect(p.lapTimes.length).toBe(1);
    // the lap that was under way still ends on the next real crossing, timed from its true start
    const lapBegan = 10 / 60 + L / 60;
    t = drive(session, entrants, dist, [60], t, (L / 2 + 10) / 60);
    expect(p.lapTimes.length).toBe(2);
    expect(p.lapTimes[1]).toBeGreaterThan(17 + L / 60 - 1);
    // (it ends 6 m past the line)
    expect(p.lapTimes[1]).toBeCloseTo(t - 6 / 60 - lapBegan, 1);
  });

  it('calls a lap a personal best only when it beats the record and every earlier lap of the race', () => {
    // lap 1 at 60 m/s (from the grid, 10 m behind the line), lap 2 slower at 40 m/s, lap 3 faster than both at 80 m/s
    const lap1 = (L + 10) / 60;
    const lap2 = 30 / 60 + (L - 30) / 40;
    const pbs = (stored: number | null): boolean[] => {
      const { entrants, session } = setup(1, 5, stored);
      session.startCountdown(0, false);
      const dist = [-10];
      let t = drive(session, entrants, dist, [60], 0, (L + 40) / 60);
      t = drive(session, entrants, dist, [40], t, L / 40);
      drive(session, entrants, dist, [80], t, L / 80);
      const laps = session.drainEvents().flatMap((e) => (e.type === 'lap' ? [e] : []));
      expect(laps).toHaveLength(3);
      expect(laps[1].time).toBeCloseTo(lap2, 1);
      return laps.map((e) => e.personalBest);
    };
    // the first race of the car on the track: no record stored, yet lap 2 is slower than lap 1
    expect(pbs(null)).toEqual([true, false, true]);
    // a record between laps 1 and 2: lap 2 beats it, but lap 1 already lowered it
    expect(pbs((lap1 + lap2) / 2)).toEqual([true, false, true]);
    // a record faster than laps 1 and 2: only lap 3 beats it
    expect(pbs(lap1 - 1)).toEqual([false, false, true]);
  });

  it('warns of the wrong way when a car drives against the track, not when it reverses', () => {
    const { entrants, session } = setup(1, 3);
    session.startCountdown(0, false);
    const st = entrants[0].state;
    const p = session.progress[0];
    let t = 0;
    // reversing: facing along the track, moving backwards
    for (let k = 0; k < 120; k++) {
      place(st, 300 - k * 0.1, -6);
      session.update(1 / 60, (t += 1 / 60));
    }
    expect(p.wrongWayTime).toBe(0);
    // turned round and driving the wrong way
    for (let k = 0; k < 120; k++) {
      place(st, 290 - k * 0.1, -6);
      st.quaternion.premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI));
      session.update(1 / 60, (t += 1 / 60));
    }
    expect(p.wrongWayTime).toBeGreaterThan(1.5);
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
