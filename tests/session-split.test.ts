/**
 * The race session with two humans on one screen: two entrants who are players (seats 0 and 1), each with their own lap reference,
 * their own record to beat, and a duel between them in the results. Cars are moved along the real track by hand, as in session.test.ts.
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { RaceConfig, Seat, TrackFrame, VehicleState } from '../src/core/contracts';
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

interface Setup {
  entrants: Entrant[];
  session: RaceSession;
}

/** car 0 = player 1 (seat 0), car 1 = player 2 (seat 1), the rest opponents. */
function setup(n: number, laps: number, stored: number | null | (number | null)[] = null, seats = true): Setup {
  const entrants: Entrant[] = [];
  for (let i = 0; i < n; i++) {
    const human = i < 2;
    entrants.push({
      id: i,
      name: i === 0 ? 'Gabriel' : i === 1 ? 'Silviu' : `car${i}`,
      color: '#fff',
      carId: i === 1 ? 'kestrel-r' : 'vanta-gt',
      isPlayer: human,
      state: fakeState(i),
      ...(human && seats ? { seat: i as Seat } : {}),
    });
  }
  entrants.forEach((e, i) => place(e.state, -10 - 8 * i));
  const cfg: RaceConfig = {
    mode: 'race',
    trackId: 'aurelia',
    carId: 'vanta-gt',
    laps,
    opponents: n - 2,
    difficulty: 'pro',
    environment: { timeOfDay: 'noon', weather: 'clear' },
    startPosition: 'pole',
    player2: { carId: 'kestrel-r' },
  };
  return { entrants, session: new RaceSession(track, cfg, entrants, stored, 0) };
}

/** The same field with one human (no seat): what a single-player race is. */
function single(n: number, laps: number): Setup {
  const entrants: Entrant[] = [];
  for (let i = 0; i < n; i++) entrants.push({ id: i, name: i === 0 ? 'Gabriel' : `car${i}`, color: '#fff', carId: 'vanta-gt', isPlayer: i === 0, state: fakeState(i) });
  entrants.forEach((e, i) => place(e.state, -10 - 8 * i));
  const cfg: RaceConfig = { mode: 'race', trackId: 'aurelia', carId: 'vanta-gt', laps, opponents: n - 1, difficulty: 'pro', environment: { timeOfDay: 'noon', weather: 'clear' }, startPosition: 'pole' };
  return { entrants, session: new RaceSession(track, cfg, entrants, null, 0) };
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

describe('a session with two humans', () => {
  it('knows who is in which seat, and the one player of a single-player session is seat 0', () => {
    const { session } = setup(4, 2);
    expect(session.player?.entrant.name).toBe('Gabriel');
    expect(session.playerAt(0)?.entrant.name).toBe('Gabriel');
    expect(session.playerAt(1)?.entrant.name).toBe('Silviu');
    expect(session.players().map((p) => p.entrant.name)).toEqual(['Gabriel', 'Silviu']);
    // a single-player session: the player has no seat and answers for seat 0; nobody is in seat 1
    const one = single(3, 2).session;
    expect(one.playerAt(0)?.entrant.name).toBe('Gabriel');
    expect(one.playerAt(1)).toBeUndefined();
    expect(one.players().length).toBe(1);
    expect(one.storedBestFor(1)).toBeNull();
  });

  it('times each human\'s laps on their own', () => {
    const { entrants, session } = setup(3, 3);
    session.startCountdown(0, false);
    const dist = [-10, -18, -26];
    // 60 m/s and 50 m/s
    drive(session, entrants, dist, [60, 50, 40], 0, (2 * L + 30) / 50);
    const [a, b] = session.players();
    expect(a.lapTimes.length).toBeGreaterThanOrEqual(2);
    expect(b.lapTimes.length).toBeGreaterThanOrEqual(1);
    expect(a.lapTimes[1]).toBeCloseTo(L / 60, 1);
    expect(b.lapTimes[1]).toBeCloseTo(L / 50, 1);
  });

  it('judges a personal best against each human\'s own record (their car on this track)', () => {
    // player 1 drives a lap in about L/60 s against a record 5 s faster: no personal best; player 2 against a very slow one: one
    const { entrants, session } = setup(2, 3, [L / 60 - 5, 1000]);
    session.startCountdown(0, false);
    expect(session.storedBestFor(0)).toBeCloseTo(L / 60 - 5, 6);
    expect(session.storedBestFor(1)).toBe(1000);
    expect(session.storedBest).toBeCloseTo(L / 60 - 5, 6);
    drive(session, entrants, [-10, -18], [60, 50], 0, (L + 40) / 50);
    const laps = session.drainEvents().flatMap((e) => (e.type === 'lap' ? [e] : []));
    const mine = laps.find((e) => e.entrant.name === 'Gabriel');
    const his = laps.find((e) => e.entrant.name === 'Silviu');
    expect(mine).toBeDefined();
    expect(his).toBeDefined();
    expect(mine!.personalBest).toBe(false);
    expect(his!.personalBest).toBe(true);
  });

  it('keeps a lap reference per human: the live delta and the sector deltas follow their own best lap', () => {
    const { entrants, session } = setup(2, 4);
    session.startCountdown(0, false);
    const dist = [-10, -18];
    // lap 1 (and 2): P1 at 60 m/s, P2 at 40 m/s
    let t = drive(session, entrants, dist, [60, 40], 0, (L + 10) / 40 + (L + 10) / 40 + 5);
    expect(session.players()[0].lapTimes.length).toBeGreaterThanOrEqual(2);
    expect(session.liveDelta(0)).not.toBeNull();
    expect(session.liveDelta(1)).not.toBeNull();
    // P1 now slows down: its delta against its own best lap grows, while P2 (same pace as its own best) stays near zero
    t = drive(session, entrants, dist, [30, 40], t, 6);
    const d0 = session.liveDelta(0)!;
    const d1 = session.liveDelta(1)!;
    expect(d0).toBeGreaterThan(1);
    expect(Math.abs(d1)).toBeLessThan(0.6);
    expect(session.sectorDeltas(0)).toHaveLength(3);
    expect(session.sectorDeltas(1)).toHaveLength(3);
  });
});

describe('the duel in the results', () => {
  /** `seconds`: how long the race runs (default: long enough for both humans to finish). */
  function finish(speeds: number[], laps = 2, seconds = (laps * L + 40) / Math.min(...speeds.slice(0, 2))): { session: RaceSession; entrants: Entrant[]; dist: number[] } {
    const s = setup(3, laps);
    s.session.startCountdown(0, false);
    const dist = [-10, -18, -26];
    drive(s.session, s.entrants, dist, speeds, 0, seconds);
    return { ...s, dist };
  }

  it('says who beat whom and by how much, in times', () => {
    const { session } = finish([60, 55, 30]);
    session.closeRace();
    const res = session.results([false, false]);
    expect(res.duel).toBeDefined();
    const d = res.duel!;
    expect(d.names).toEqual(['Gabriel', 'Silviu']);
    expect(d.winner).toBe(0);
    expect(d.positions[0]).toBeLessThan(d.positions[1]);
    expect(d.gap).toMatch(/^\+\d+\.\d{3}$/);
    expect(parseFloat(d.gap)).toBeGreaterThan(0);
    // 2 laps of the track at 60 and 55 m/s, from 10 and 18 m behind the line
    const expected = (2 * L + 18) / 55 - (2 * L + 10) / 60;
    expect(parseFloat(d.gap)).toBeCloseTo(expected, 0);
    expect(d.carIds).toEqual(['vanta-gt', 'kestrel-r']);
    expect(d.lapTimes[0].length).toBe(2);
    expect(d.bestLap[0]).not.toBeNull();
  });

  it('player 2 can win, and the entries tell which rows are the humans', () => {
    const { session } = finish([50, 60, 30]);
    session.closeRace();
    const res = session.results([true, false]);
    expect(res.duel!.winner).toBe(1);
    expect(res.duel!.personalBest).toEqual([true, false]);
    expect(res.personalBest).toBe(true);
    const seats = res.entries.filter((e) => e.seat !== undefined).map((e) => [e.name, e.seat]);
    expect(seats.sort()).toEqual([['Gabriel', 0], ['Silviu', 1]].sort());
    expect(res.entries.find((e) => e.name === 'car2')!.seat).toBeUndefined();
    expect(res.entries[0].name).toBe('Silviu');
  });

  it('a human a lap behind is "+1 LAP" to the other, not a time', () => {
    // the race is over as player 1 crosses the line (a few seconds on), when player 2 has not yet finished their first lap
    const { session } = finish([60, 25, 20], 2, (2 * L + 60) / 60);
    session.closeRace();
    const d = session.results([false, false]).duel!;
    expect(d.winner).toBe(0);
    expect(d.gap).toBe('+1 LAP');
  });

  it('a race of one has no duel and no seats in its entries', () => {
    const s = single(3, 2);
    const one = s.session;
    one.startCountdown(0, false);
    drive(one, s.entrants, [-10, -18, -26], [60, 50, 40], 0, (2 * L + 40) / 40);
    one.closeRace();
    const res = one.results(false);
    expect(res.duel).toBeUndefined();
    expect(res.entries.every((e) => e.seat === undefined)).toBe(true);
    expect('duel' in res).toBe(false);
  });
});
