/**
 * Championship logic: scoring, fastest-lap rule, standings and tie-breaks, grids, round configs, season
 * creation, round recording, view models and persistence (including corrupt data).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CARS } from '../src/cars';
import type { ChampionshipSetup, Livery, TrackInfo } from '../src/core/contracts';
import {
  buildOpponents,
  buildView,
  CALENDAR,
  CHAMPIONSHIP_KEY,
  championshipDef,
  computeStandings,
  createChampionship,
  FASTEST_LAP_POINT,
  gridOrder,
  isComplete,
  isPlayable,
  lapsFor,
  loadChampionship,
  nextRound,
  parseChampionship,
  PLAYER_ID,
  pointsFor,
  POINTS,
  recordRound,
  roundConfig,
  roundForecast,
  sanitizeState,
  saveChampionship,
  scoreRound,
  seededRandom,
  serializeChampionship,
  standingsOrder,
  type ChampionshipState,
  type Finisher,
} from '../src/game/championship';
import { TRACKS } from '../src/track';

const TRACK_INFO: TrackInfo[] = [
  { id: 'aurelia', name: 'Aurelia Ring', location: 'X', description: '', difficulty: 3, defaultLaps: 3, defaultTimeOfDay: 'golden', lengthHint: 4795, color: '#16e0bd' },
  { id: 'kuroyama', name: 'Kuroyama Pass', location: 'Y', description: '', difficulty: 4, defaultLaps: 2, defaultTimeOfDay: 'morning', lengthHint: 5250, color: '#ff2e63' },
  { id: 'brennwald', name: 'Brennwald Ring', location: 'Z', description: '', difficulty: 4, defaultLaps: 3, defaultTimeOfDay: 'golden', lengthHint: 6843, color: '#ffb02e' },
  { id: 'portovela', name: 'Porto Vela', location: 'W', description: '', difficulty: 4, defaultLaps: 3, defaultTimeOfDay: 'dusk', lengthHint: 3960, color: '#3fa9ff' },
];
const CAR = CARS[0];
const PLAYER_LIVERY: Livery = { ...CAR.defaultLivery, driver: 'Gabriel' };

const SETUP: ChampionshipSetup = { carId: CAR.id, livery: { primary: '#16e0bd', driver: 'Gabriel' }, difficulty: 'pro', opponents: 7, length: 'standard', startPosition: 'back', grid: 'standings' };

function make(over: Partial<ChampionshipSetup> = {}, seed = 12345): ChampionshipState {
  return createChampionship({ setup: { ...SETUP, ...over }, tracks: TRACK_INFO, playerName: 'Gabriel', playerLivery: PLAYER_LIVERY, car: CAR, seed, now: 1700000000000 });
}

/** A finishing order (driver ids, winner first) as race finishers: every car classified, the winner also the fastest. */
function finishers(order: readonly string[], over: Record<string, Partial<Finisher>> = {}): Finisher[] {
  return order.map((id, i) => ({ id, position: i + 1, totalTime: 300 + i * 2, bestLap: 90 + i * 0.1, laps: 3, ...over[id] }));
}

/** Rotate the roster so that `first` wins; everyone else keeps their relative order. */
const winnerFirst = (s: ChampionshipState, first: string): string[] => [first, ...s.drivers.map((d) => d.id).filter((id) => id !== first)];

// ─────────────────────────────────────────────────────────────────────────────
describe('championship scoring', () => {
  it('awards 25-18-15-12-10-8-6-4-2-1 and nothing below tenth', () => {
    expect(POINTS).toEqual([25, 18, 15, 12, 10, 8, 6, 4, 2, 1]);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(pointsFor)).toEqual([25, 18, 15, 12, 10, 8, 6, 4, 2, 1]);
    expect([0, -1, 11, 12, 99].map(pointsFor)).toEqual([0, 0, 0, 0, 0]);
  });

  it('scores a full field and sorts the result by position', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `d${i}`);
    const shuffled = [...finishers(ids)].reverse();
    const r = scoreRound(0, shuffled);
    expect(r.entries.map((e) => e.id)).toEqual(ids);
    // the winner also set the fastest lap: 25 + 1
    expect(r.entries.map((e) => e.points)).toEqual([26, 18, 15, 12, 10, 8, 6, 4, 2, 1, 0, 0]);
    expect(r.entries[0].fastestLap).toBe(true);
    expect(r.entries.filter((e) => e.fastestLap)).toHaveLength(1);
  });

  it('gives the fastest-lap point to a driver in the points, whatever his finishing position', () => {
    const r = scoreRound(0, finishers(['a', 'b', 'c', 'd'], { d: { bestLap: 80 } }));
    expect(r.fastestLapId).toBe('d');
    expect(r.entries.find((e) => e.id === 'd')).toMatchObject({ position: 4, points: 12 + FASTEST_LAP_POINT, fastestLap: true });
    expect(r.entries.find((e) => e.id === 'a')!.points).toBe(25);
  });

  it('gives nobody the fastest-lap point when its driver finishes outside the top ten', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `d${i}`);
    const r = scoreRound(0, finishers(ids, { d10: { bestLap: 70 } }));
    expect(r.fastestLapId).toBe('d10');
    expect(r.fastestLapTime).toBe(70);
    expect(r.entries.some((e) => e.fastestLap)).toBe(false);
    expect(r.entries.reduce((s, e) => s + e.points, 0)).toBe(POINTS.reduce((s, p) => s + p, 0));
  });

  it('gives nothing to unclassified drivers (no finish time), not even the fastest lap', () => {
    const r = scoreRound(0, finishers(['a', 'b', 'c'], { b: { totalTime: null, bestLap: 60 }, c: { totalTime: null } }));
    expect(r.entries.map((e) => e.points)).toEqual([25, 0, 0]);
    expect(r.fastestLapId).toBe('b');
    expect(r.entries.some((e) => e.fastestLap)).toBe(false);
    expect(r.entries[1].totalTime).toBeNull();
  });

  it('breaks a tie for the fastest lap in favour of the better finisher', () => {
    const r = scoreRound(0, finishers(['a', 'b', 'c'], { a: { bestLap: 91 }, b: { bestLap: 90 }, c: { bestLap: 90 } }));
    expect(r.fastestLapId).toBe('b');
  });

  it('copes with drivers who never set a lap', () => {
    const r = scoreRound(0, finishers(['a', 'b'], { a: { bestLap: null }, b: { bestLap: null } }));
    expect(r.fastestLapId).toBeNull();
    expect(r.entries.map((e) => e.points)).toEqual([25, 18]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('calendar and race length', () => {
  it('scales each track default by the race length, never below one lap', () => {
    expect([3, 2].map((d) => lapsFor(d, 'short'))).toEqual([2, 1]);
    expect([3, 2].map((d) => lapsFor(d, 'standard'))).toEqual([3, 2]);
    expect([3, 2].map((d) => lapsFor(d, 'long'))).toEqual([6, 4]);
    expect(lapsFor(1, 'short')).toBe(1);
    expect(lapsFor(0, 'standard')).toBeGreaterThanOrEqual(1);
    expect(lapsFor(NaN, 'long')).toBeGreaterThanOrEqual(1);
    expect(lapsFor(40, 'long')).toBeLessThanOrEqual(50);
  });

  it('is the Xeno Cup: eight rounds over the four circuits, each in different conditions', () => {
    expect(CALENDAR.map((c) => [c.trackId, c.environment.timeOfDay, c.environment.weather, c.forecast ?? 'stable'])).toEqual([
      ['aurelia', 'golden', 'clear', 'stable'],
      ['kuroyama', 'morning', 'cloudy', 'stable'],
      ['portovela', 'dusk', 'clear', 'stable'],
      ['brennwald', 'morning', 'clear', 'stable'],
      ['kuroyama', 'dusk', 'rain', 'stable'],
      ['aurelia', 'night', 'clear', 'stable'],
      ['portovela', 'night', 'cloudy', 'rainLater'],
      ['brennwald', 'noon', 'storm', 'stable'],
    ]);
    // every circuit twice, never twice in a row, never the same conditions twice
    for (const id of ['aurelia', 'kuroyama', 'brennwald', 'portovela']) expect(CALENDAR.filter((c) => c.trackId === id)).toHaveLength(2);
    for (let i = 1; i < CALENDAR.length; i++) expect(CALENDAR[i].trackId).not.toBe(CALENDAR[i - 1].trackId);
    expect(new Set(CALENDAR.map((c) => `${c.environment.timeOfDay}/${c.environment.weather}`)).size).toBe(CALENDAR.length);
  });

  it('only races at night where the track is floodlit', () => {
    for (const c of CALENDAR) {
      if (c.environment.timeOfDay === 'night') expect(TRACKS.find((t) => t.info.id === c.trackId)?.info.floodlit).toBe(true);
    }
  });

  it('only changes the weather where the round can run it at every race length', () => {
    const def = championshipDef(TRACK_INFO);
    for (const [i, c] of CALENDAR.entries()) {
      if (!c.forecast) continue;
      for (const laps of Object.values(def.rounds[i].laps)) expect(roundForecast(c, laps)).toBe(c.forecast);
    }
    // a one-lap race is over before the weather would change
    expect(roundForecast({ environment: { timeOfDay: 'night', weather: 'cloudy' }, forecast: 'rainLater' }, 1)).toBe('stable');
  });

  it('only schedules tracks that exist', () => {
    const ids = TRACKS.map((t) => t.info.id);
    for (const c of CALENDAR) expect(ids).toContain(c.trackId);
  });

  it('describes the calendar for the setup screen, laps per race length included', () => {
    const def = championshipDef(TRACK_INFO);
    expect(def.name).toBe('Xeno Cup');
    expect(def.rounds).toHaveLength(8);
    expect(def.rounds[0]).toMatchObject({ trackId: 'aurelia', laps: { short: 2, standard: 3, long: 6 } });
    expect(def.rounds[1]).toMatchObject({ trackId: 'kuroyama', laps: { short: 1, standard: 2, long: 4 } });
    expect(def.rounds[2]).toMatchObject({ trackId: 'portovela', laps: { short: 2, standard: 3, long: 6 } });
    expect(def.rounds[3]).toMatchObject({ trackId: 'brennwald', laps: { short: 2, standard: 3, long: 6 } });
    expect(def.rounds[6].forecast).toBe('rainLater');
    expect(def.rounds.filter((r) => r.forecast)).toHaveLength(1);
    expect(def.points).toEqual([...POINTS]);
    expect(def.fastestLapPoint).toBe(1);
    // the def is a copy: editing it must not touch the rules
    def.points[0] = 0;
    expect(POINTS[0]).toBe(25);
  });

  it('falls back to a default lap count for a track it does not know', () => {
    const def = championshipDef([]);
    expect(def.rounds.every((r) => r.laps.standard >= 1)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('creating a championship', () => {
  it('builds the fixed calendar with laps from the track defaults and the chosen length', () => {
    const s = make();
    expect(s.name).toBe('Xeno Cup');
    expect(s.calendar.map((c) => [c.trackId, c.laps])).toEqual([
      ['aurelia', 3], ['kuroyama', 2], ['portovela', 3], ['brennwald', 3], ['kuroyama', 2], ['aurelia', 3], ['portovela', 3], ['brennwald', 3],
    ]);
    expect(s.calendar[4].environment).toEqual({ timeOfDay: 'dusk', weather: 'rain' });
    expect(s.calendar[7].environment).toEqual({ timeOfDay: 'noon', weather: 'storm' });
    expect(make({ length: 'long' }).calendar.map((c) => c.laps)).toEqual([6, 4, 6, 6, 4, 6, 6, 6]);
    expect(make({ length: 'short' }).calendar.map((c) => c.laps)).toEqual([2, 1, 2, 2, 1, 2, 2, 2]);
    expect(s.results).toEqual([]);
    expect(nextRound(s)).toBe(0);
    expect(isComplete(s)).toBe(false);
  });

  it('puts the player first and gives opponents a lasting identity: name, livery, colour and AI seed', () => {
    const s = make();
    expect(s.drivers).toHaveLength(8);
    expect(s.drivers[0]).toMatchObject({ id: PLAYER_ID, name: 'Gabriel', isPlayer: true });
    for (const d of s.drivers.slice(1)) {
      expect(d.isPlayer).toBe(false);
      expect(d.livery).toBeDefined();
      expect(d.livery!.driver).toBe(d.name);
      expect(d.color).toBe(d.livery!.primary);
      expect(d.seed).toBeGreaterThan(0);
    }
  });

  it('gives every opponent a distinct name and colour, none shared with the player', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const s = make({ opponents: 11 }, seed * 7919);
      const names = s.drivers.map((d) => d.name.toLowerCase());
      const colours = s.drivers.filter((d) => !d.isPlayer).map((d) => d.color.toLowerCase());
      expect(new Set(names).size).toBe(names.length);
      expect(new Set(colours).size).toBe(colours.length);
      expect(colours).not.toContain(PLAYER_LIVERY.primary.toLowerCase());
    }
  });

  it('avoids a player who is called like an opponent and who paints his car like one', () => {
    const drivers = buildOpponents(11, CAR, { name: 'K. Tanaka', livery: { ...PLAYER_LIVERY, primary: '#c8102e' } }, 3);
    expect(drivers.map((d) => d.name)).not.toContain('K. Tanaka');
    expect(drivers.map((d) => d.color.toLowerCase())).not.toContain('#c8102e');
  });

  it('is reproducible from its seed and varies with it', () => {
    const a = make({}, 42);
    const b = make({}, 42);
    expect(a.drivers).toEqual(b.drivers);
    const lineups = new Set(Array.from({ length: 20 }, (_, i) => make({}, i * 101 + 5).drivers.map((d) => d.name).join('|')));
    expect(lineups.size).toBeGreaterThan(3);
  });

  it('clamps the field to 1..11 opponents and repairs bad setup values', () => {
    expect(make({ opponents: 99 }).drivers).toHaveLength(12);
    expect(make({ opponents: 0 }).drivers).toHaveLength(2);
    expect(make({ opponents: -4 }).drivers).toHaveLength(2);
    expect(make({ opponents: 3.6 }).drivers).toHaveLength(5);
    const bad = make({ difficulty: 'godlike' as never, length: 'epic' as never, startPosition: 'nowhere' as never, grid: 'random' as never });
    expect(bad.setup).toMatchObject({ difficulty: 'amateur', length: 'standard', startPosition: 'back', grid: 'standings' });
  });

  it('seeded random numbers are deterministic and in [0, 1)', () => {
    const r1 = seededRandom(9);
    const r2 = seededRandom(9);
    for (let i = 0; i < 50; i++) {
      const v = r1();
      expect(v).toBe(r2());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('recording rounds', () => {
  it('appends a scored round and leaves the original state untouched', () => {
    const s = make();
    const ids = s.drivers.map((d) => d.id);
    const s2 = recordRound(s, finishers(ids));
    expect(s.results).toHaveLength(0);
    expect(s2.results).toHaveLength(1);
    expect(s2.results[0].round).toBe(0);
    expect(nextRound(s2)).toBe(1);
  });

  it('ignores unknown and repeated drivers and classifies drivers the race forgot last, without points', () => {
    const s = make({ opponents: 3 });
    const [p, a1, a2, a3] = s.drivers.map((d) => d.id);
    const report: Finisher[] = [
      { id: a2, position: 1, totalTime: 100, bestLap: 90, laps: 3 },
      { id: 'ghost', position: 2, totalTime: 101, bestLap: 89, laps: 3 },
      { id: a2, position: 3, totalTime: 102, bestLap: 88, laps: 3 },
      { id: p, position: 4, totalTime: 103, bestLap: 91, laps: 3 },
    ];
    const r = recordRound(s, report).results[0];
    expect(r.entries.map((e) => e.id)).toEqual([a2, p, a1, a3]);
    expect(r.entries.map((e) => e.points)).toEqual([25 + 1, 18, 0, 0]);
    expect(r.entries[2].totalTime).toBeNull();
    expect(r.entries.some((e) => e.id === 'ghost')).toBe(false);
  });

  it('stops once the season is over', () => {
    let s = make({ opponents: 2 });
    const ids = s.drivers.map((d) => d.id);
    for (let i = 0; i < CALENDAR.length; i++) s = recordRound(s, finishers(ids));
    expect(isComplete(s)).toBe(true);
    expect(nextRound(s)).toBe(-1);
    expect(recordRound(s, finishers(ids))).toBe(s);
    expect(s.results).toHaveLength(CALENDAR.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('standings', () => {
  /** A race with no fastest-lap bonus (nobody sets a lap), so the points are exactly the position points. */
  const plain = (order: readonly string[]): Finisher[] => finishers(order).map((f) => ({ ...f, bestLap: null }));

  it('adds up the rounds, orders by points and reports the gap to the leader', () => {
    let s = make({ opponents: 3 });
    const [p, a1, a2, a3] = s.drivers.map((d) => d.id);
    s = recordRound(s, finishers([a1, p, a2, a3])); // a1 26 (fastest lap), p 18, a2 15, a3 12
    s = recordRound(s, finishers([p, a1, a3, a2])); // p 26 (fastest lap), a1 18, a3 15, a2 12
    const t = computeStandings(s);
    // p and a1 are level on 44 with a win and a second each: the latest round decides, and p won it
    expect(t.map((r) => [r.id, r.points])).toEqual([[p, 44], [a1, 44], [a3, 27], [a2, 27]]);
    expect(t.map((r) => r.position)).toEqual([1, 2, 3, 4]);
    expect(t.map((r) => r.gap)).toEqual([0, 0, 17, 17]);
    const rival = t.find((r) => r.id === a1)!;
    expect(rival.roundPoints).toEqual([26, 18, null, null, null, null, null, null]);
    expect(rival.roundPositions).toEqual([1, 2, null, null, null, null, null, null]);
    expect(rival.roundFastest).toEqual([true, false, false, false, false, false, false, false]);
  });

  it('breaks a tie on points by countback: the driver with more wins is ahead', () => {
    let s = make({ opponents: 3 });
    const [p, a1, a2, a3] = s.drivers.map((d) => d.id);
    // a1: 25 + 12 = 37 with a win. a2: 18 + 18 + the fastest-lap point = 37 without one.
    s = recordRound(s, plain([a1, a2, p, a3]));
    s = recordRound(s, finishers([p, a2, a3, a1], { [p]: { bestLap: null }, [a3]: { bestLap: null }, [a1]: { bestLap: null }, [a2]: { bestLap: 80 } }));
    const t = computeStandings(s);
    expect(t.map((r) => [r.id, r.points])).toEqual([[p, 40], [a1, 37], [a2, 37], [a3, 27]]);
  });

  it('goes on down the countback: with the wins level, more second places win', () => {
    let s = make({ opponents: 6 });
    const [x, o1, o2, o3, o4, o5, y] = s.drivers.map((d) => d.id);
    // x: 2nd + 7th = 18 + 6 = 24, y: 4th + 4th = 12 + 12 = 24; nobody has a win between them
    s = recordRound(s, plain([o1, x, o2, y, o3, o4, o5]));
    s = recordRound(s, plain([o1, o2, o3, y, o4, o5, x]));
    const t = computeStandings(s);
    const rx = t.find((r) => r.id === x)!;
    const ry = t.find((r) => r.id === y)!;
    expect(rx.points).toBe(24);
    expect(ry.points).toBe(24);
    expect(rx.wins + ry.wins).toBe(0);
    expect(rx.position).toBeLessThan(ry.position);
    expect(rx.position + 1).toBe(ry.position); // adjacent in the table
  });

  it('when even the finishes are level, the better result in the latest round is ahead', () => {
    let s = make({ opponents: 3 });
    const [p, a1, a2, a3] = s.drivers.map((d) => d.id);
    // p: 3rd then 4th, a1: 4th then 3rd: 27 points each, the same set of finishes; a1 was ahead last time
    s = recordRound(s, plain([a2, a3, p, a1]));
    s = recordRound(s, plain([a2, a3, a1, p]));
    const t = computeStandings(s);
    const rp = t.find((r) => r.id === p)!;
    const r1 = t.find((r) => r.id === a1)!;
    expect(rp.points).toBe(r1.points);
    expect(r1.position).toBeLessThan(rp.position);
  });

  it('reports places gained and lost in the last round, and nothing to compare after the first', () => {
    let s = make({ opponents: 3 });
    const [p, a1, a2, a3] = s.drivers.map((d) => d.id);
    expect(computeStandings(s).map((r) => r.prevPosition)).toEqual([1, 2, 3, 4]); // nothing raced: the roster order
    s = recordRound(s, finishers([a1, a2, a3, p])); // a1 26, a2 18, a3 15, p 12
    const first = computeStandings(s);
    expect(first.every((r) => r.move === null)).toBe(true);
    // before the first round the table was in roster order: p, a1, a2, a3
    expect(first.map((r) => [r.id, r.prevPosition])).toEqual([[a1, 2], [a2, 3], [a3, 4], [p, 1]]);
    s = recordRound(s, finishers([p, a3, a1, a2])); // p 38, a1 41, a3 33, a2 30
    const t = computeStandings(s);
    expect(t.map((r) => [r.id, r.move])).toEqual([[a1, 0], [p, 2], [a3, 0], [a2, -2]]);
    expect(t.map((r) => [r.id, r.prevPosition])).toEqual([[a1, 1], [p, 4], [a3, 3], [a2, 2]]);
    expect(t.map((r) => r.lastGain)).toEqual([15, 26, 18, 12]);
  });

  it('shows the table as it stood after any number of rounds', () => {
    let s = make({ opponents: 3 });
    const [p, a1, a2, a3] = s.drivers.map((d) => d.id);
    s = recordRound(s, finishers([a1, a2, a3, p]));
    s = recordRound(s, finishers([p, a3, a2, a1]));
    expect(computeStandings(s, 0).every((r) => r.points === 0)).toBe(true);
    expect(computeStandings(s, 1)[0].id).toBe(a1);
    expect(computeStandings(s, 1)[0].roundPoints).toEqual([26, null, null, null, null, null, null, null]);
    expect(computeStandings(s, 1)[0].move).toBeNull();
    expect(computeStandings(s, 99)).toEqual(computeStandings(s));
    expect(computeStandings(s, -3)).toEqual(computeStandings(s, 0));
  });

  it('with no rounds raced everyone is level and keeps roster order', () => {
    const s = make({ opponents: 4 });
    const t = computeStandings(s);
    expect(t.map((r) => r.id)).toEqual(s.drivers.map((d) => d.id));
    expect(t.every((r) => r.points === 0 && r.gap === 0 && r.move === null && r.lastGain === 0)).toBe(true);
  });

  it('counts wins and podiums for classified finishes, and fastest laps by the bonus', () => {
    let s = make({ opponents: 3 });
    const [p, a1, a2, a3] = s.drivers.map((d) => d.id);
    s = recordRound(s, finishers([p, a1, a2, a3], { [a1]: { bestLap: 80 } }));
    const t = computeStandings(s);
    const me = t.find((r) => r.id === p)!;
    const rival = t.find((r) => r.id === a1)!;
    expect(me).toMatchObject({ wins: 1, podiums: 1, fastestLaps: 0, points: 25 });
    expect(rival).toMatchObject({ wins: 0, podiums: 1, fastestLaps: 1, points: 19 });
    // an unclassified winner is no winner
    const dnf = recordRound(make({ opponents: 3 }), finishers([p, a1, a2, a3], { [p]: { totalTime: null } }));
    expect(computeStandings(dnf).find((r) => r.id === p)).toMatchObject({ wins: 0, podiums: 0, points: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('grids and round configs', () => {
  it('round 1 puts the player where the setup says and the opponents in roster order around him', () => {
    for (const [start, slot] of [['pole', 0], ['middle', 4], ['back', 7]] as const) {
      const s = make({ startPosition: start });
      const grid = gridOrder(s, 0);
      expect(grid).toHaveLength(8);
      expect(grid.indexOf(PLAYER_ID)).toBe(slot);
      expect(grid.filter((id) => id !== PLAYER_ID)).toEqual(s.drivers.filter((d) => !d.isPlayer).map((d) => d.id));
    }
  });

  it('later rounds follow the championship order with the leader on pole', () => {
    let s = make({ opponents: 3 });
    const [p, a1, a2, a3] = s.drivers.map((d) => d.id);
    s = recordRound(s, finishers([a2, p, a3, a1]));
    expect(gridOrder(s, 1)).toEqual([a2, p, a3, a1]);
    s = recordRound(s, finishers([p, a1, a2, a3]));
    expect(gridOrder(s, 2)).toEqual(standingsOrder(s));
  });

  it('can grid later rounds in reverse championship order', () => {
    let s = make({ opponents: 3, grid: 'reverse' });
    const [p, a1, a2, a3] = s.drivers.map((d) => d.id);
    s = recordRound(s, finishers([a2, p, a3, a1]));
    expect(gridOrder(s, 1)).toEqual([a1, a3, p, a2]);
    // round 1 is not affected by the rule
    expect(gridOrder(make({ opponents: 3, grid: 'reverse', startPosition: 'pole' }), 0)[0]).toBe(PLAYER_ID);
  });

  it('every grid holds every driver exactly once', () => {
    let s = make({ opponents: 11 });
    const ids = s.drivers.map((d) => d.id);
    for (let r = 0; r < 4; r++) {
      const g = gridOrder(s, r);
      expect([...g].sort()).toEqual([...ids].sort());
      s = recordRound(s, finishers([...ids].reverse()));
    }
  });

  it('turns a round into a race config that carries the grid and the season identity', () => {
    const s = make({ opponents: 3, startPosition: 'middle', difficulty: 'alien' });
    const c = roundConfig(s, 1);
    expect(c).toMatchObject({ mode: 'race', trackId: 'kuroyama', carId: CAR.id, laps: 2, opponents: 3, difficulty: 'alien' });
    expect(c.environment).toEqual({ timeOfDay: 'morning', weather: 'cloudy' });
    expect(c.championship).toMatchObject({ name: 'Xeno Cup', round: 2, rounds: 8 });
    expect(c.forecast).toBeUndefined();
    expect(c.championship!.grid.map((g) => g.id)).toEqual(gridOrder(s, 1));
    const opp = c.championship!.grid.find((g) => !g.isPlayer)!;
    const d = s.drivers.find((x) => x.id === opp.id)!;
    expect(opp).toMatchObject({ name: d.name, livery: d.livery, seed: d.seed });
    expect(c.championship!.grid.find((g) => g.isPlayer)).toMatchObject({ id: PLAYER_ID, name: 'Gabriel' });
    expect(c.livery).toEqual(SETUP.livery);
  });

  it('brings the rain to the Porto Vela night round at a moment fixed for the season', () => {
    const s = make();
    const r = s.calendar[6];
    expect(r).toMatchObject({ trackId: 'portovela', forecast: 'rainLater' });
    expect(s.calendar.filter((x) => x.forecast)).toHaveLength(1);
    const c = roundConfig(s, 6);
    expect(c).toMatchObject({ trackId: 'portovela', forecast: 'rainLater', environment: { timeOfDay: 'night', weather: 'cloudy' } });
    // a restart repeats it; another season has its own
    expect(roundConfig(s, 6).forecastSeed).toBe(c.forecastSeed);
    expect(Number.isInteger(c.forecastSeed) && (c.forecastSeed ?? 0) >= 1).toBe(true);
    const seeds = new Set([1, 2, 3, 4, 5].map((seed) => roundConfig(make({}, seed), 6).forecastSeed));
    expect(seeds.size).toBe(5);
    // it survives a save
    expect(sanitizeState(JSON.parse(JSON.stringify(s)))?.calendar[6]).toEqual(r);
    // a one-lap round cannot run it
    const one = { ...s, calendar: s.calendar.map((x) => ({ ...x, laps: 1 })) };
    expect(roundConfig(one, 6).forecast).toBeUndefined();
    expect(buildView(one).rounds[6].forecast).toBeUndefined();
    expect(buildView(s).rounds[6].forecast).toBe('rainLater');
  });

  it('keeps the calendar of a season saved before Porto Vela', () => {
    const s = make();
    const calendar = s.calendar.filter((c) => c.trackId !== 'portovela').map((c) => ({ trackId: c.trackId, environment: c.environment, laps: c.laps }));
    const back = sanitizeState(JSON.parse(JSON.stringify({ ...s, calendar })));
    expect(back?.calendar.map((c) => c.trackId)).toEqual(['aurelia', 'kuroyama', 'brennwald', 'kuroyama', 'aurelia', 'brennwald']);
    expect(back?.calendar.every((c) => c.forecast === undefined)).toBe(true);
    expect(roundConfig(back!, 5).championship).toMatchObject({ rounds: 6 });
  });

  it('derives the config start position from the player slot', () => {
    expect(roundConfig(make({ startPosition: 'pole' }), 0).startPosition).toBe('pole');
    expect(roundConfig(make({ startPosition: 'middle' }), 0).startPosition).toBe('middle');
    expect(roundConfig(make({ startPosition: 'back' }), 0).startPosition).toBe('back');
  });

  it('the config of a round is independent of the state (no shared mutable data)', () => {
    const s = make();
    const c = roundConfig(s, 0);
    c.environment.weather = 'storm';
    c.livery!.primary = '#000000';
    expect(s.calendar[0].environment.weather).toBe('clear');
    expect(s.setup.livery!.primary).toBe('#16e0bd');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a whole season', () => {
  /** Plays a whole season with a pseudo-random order (the player keeps finishing near the front). */
  function play(seed: number, opponents = 7): ChampionshipState {
    const rand = seededRandom(seed);
    let s = make({ opponents }, seed);
    const ids = s.drivers.map((d) => d.id);
    while (!isComplete(s)) {
      const order = [...ids].sort(() => rand() - 0.5);
      s = recordRound(s, finishers(order, { [order[Math.floor(rand() * order.length)]]: { bestLap: 70 } }));
    }
    return s;
  }

  it('hands out the same points in every race and keeps totals consistent with the rounds', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const s = play(seed);
      const perRound = s.results.map((r) => r.entries.reduce((sum, e) => sum + e.points, 0));
      // every round hands out the points of the field (eight cars here), plus the fastest-lap point when it was earned
      const table = POINTS.slice(0, s.drivers.length).reduce((x, y) => x + y, 0);
      for (const p of perRound) expect([table, table + 1]).toContain(p);
      const t = computeStandings(s);
      expect(t.reduce((sum, r) => sum + r.points, 0)).toBe(perRound.reduce((a, b) => a + b, 0));
      expect([...t.map((r) => r.points)].sort((a, b) => b - a)).toEqual(t.map((r) => r.points));
      expect(t.map((r) => r.position)).toEqual(t.map((_, i) => i + 1));
    }
  });

  it('summarises the player\'s season', () => {
    const s = play(7);
    const v = buildView(s);
    expect(v.complete).toBe(true);
    expect(v.done).toBe(8);
    const mine = s.results.map((r) => r.entries.find((e) => e.id === PLAYER_ID)!);
    expect(v.season.points).toBe(mine.reduce((sum, e) => sum + e.points, 0));
    expect(v.season.wins).toBe(mine.filter((e) => e.position === 1).length);
    expect(v.season.podiums).toBe(mine.filter((e) => e.position <= 3).length);
    expect(v.season.bestFinish).toBe(Math.min(...mine.map((e) => e.position)));
    expect(v.season.fastestLaps).toBe(mine.filter((e) => e.fastestLap).length);
    expect(v.player.id).toBe(PLAYER_ID);
    expect(v.table.find((r) => r.isPlayer)).toBe(v.player);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('view model', () => {
  it('lists the calendar with winners, the player\'s result and the fastest lap of finished rounds', () => {
    let s = make({ opponents: 3 });
    const [p, a1, a2, a3] = s.drivers.map((d) => d.id);
    s = recordRound(s, finishers([a1, p, a2, a3], { [a3]: { bestLap: 81.5 } }));
    const v = buildView(s);
    expect(v.name).toBe('Xeno Cup');
    expect(v.done).toBe(1);
    expect(v.complete).toBe(false);
    expect(v.opponents).toBe(3);
    expect(v.rounds).toHaveLength(8);
    expect(v.rounds[0]).toMatchObject({ round: 0, trackId: 'aurelia', laps: 3, done: true, playerPosition: 2, playerPoints: 18 });
    expect(v.rounds[0].winner).toEqual({ name: s.drivers[1].name, isPlayer: false });
    expect(v.rounds[0].fastestLap).toEqual({ name: s.drivers[3].name, time: 81.5, isPlayer: false });
    expect(v.rounds[1]).toMatchObject({ done: false, winner: null, playerPosition: null, playerPoints: null, fastestLap: null });
    expect(v.table[0].id).toBe(a1);
  });

  it('shows the player under their current name', () => {
    const s = make({ opponents: 2 });
    const v = buildView(s, '  Ana ');
    expect(v.player.name).toBe('Ana');
    expect(v.table.find((r) => r.isPlayer)!.name).toBe('Ana');
    expect(buildView(s).player.name).toBe('Gabriel');
    expect(buildView(s, '   ').player.name).toBe('Gabriel');
    const done = recordRound(s, finishers([PLAYER_ID, ...s.drivers.slice(1).map((d) => d.id)]));
    expect(buildView(done, 'Ana').rounds[0].winner).toEqual({ name: 'Ana', isPlayer: true });
  });

  it('is plain JSON data', () => {
    const v = buildView(recordRound(make(), finishers(make().drivers.map((d) => d.id))));
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('persistence', () => {
  const played = (): ChampionshipState => {
    let s = make({ opponents: 5 }, 99);
    const ids = s.drivers.map((d) => d.id);
    s = recordRound(s, finishers(ids, { [ids[3]]: { bestLap: 75 } }));
    return recordRound(s, finishers([...ids].reverse()));
  };

  it('round-trips a season exactly', () => {
    const s = played();
    expect(parseChampionship(serializeChampionship(s))).toEqual(s);
  });

  it('resumes with standings, opponents, settings and next round intact', () => {
    const s = played();
    const r = parseChampionship(serializeChampionship(s))!;
    expect(nextRound(r)).toBe(2);
    expect(r.drivers).toEqual(s.drivers);
    expect(r.setup).toEqual(s.setup);
    expect(computeStandings(r)).toEqual(computeStandings(s));
    expect(gridOrder(r, 2)).toEqual(gridOrder(s, 2));
    expect(roundConfig(r, 2)).toEqual(roundConfig(s, 2));
  });

  it('ignores anything that is not a championship', () => {
    for (const bad of [null, undefined, '', 'not json', '{', '[]', '42', 'null', '{"version":1}', '{"version":2}', JSON.stringify({ ...played(), version: 2 })]) {
      expect(parseChampionship(bad as string)).toBeNull();
    }
    expect(sanitizeState('hello')).toBeNull();
    expect(sanitizeState([])).toBeNull();
  });

  it('rejects broken structure it cannot repair', () => {
    const base = JSON.parse(serializeChampionship(played()));
    const cases: Record<string, (o: Record<string, any>) => void> = {
      'no calendar': (o) => delete o.calendar,
      'empty calendar': (o) => (o.calendar = []),
      'unknown weather': (o) => (o.calendar[0].environment.weather = 'hail'),
      'no drivers': (o) => (o.drivers = []),
      'player not first': (o) => o.drivers.reverse(),
      'two players': (o) => (o.drivers[1].isPlayer = true),
      'duplicate ids': (o) => (o.drivers[1].id = o.drivers[0].id),
      'player under another id': (o) => (o.drivers[0].id = 'me'),
      'an opponent claiming the player id': (o) => (o.drivers[1].id = 'player'),
      'no setup': (o) => delete o.setup,
      'setup without car': (o) => (o.setup.carId = ''),
    };
    for (const [name, mutate] of Object.entries(cases)) {
      const o = structuredClone(base);
      mutate(o);
      expect(sanitizeState(o), name).toBeNull();
    }
  });

  it('repairs what it can: bad setup values, bad colours, and cuts out a broken round with everything after it', () => {
    const base = JSON.parse(serializeChampionship(played()));
    const o = structuredClone(base);
    o.setup.difficulty = 'impossible';
    o.setup.opponents = 500;
    o.drivers[2].color = 'red';
    o.drivers[2].livery.primary = 'nope';
    o.drivers[3].seed = 'x';
    o.results[1].entries = 'broken';
    const r = sanitizeState(o)!;
    expect(r).not.toBeNull();
    expect(r.setup.difficulty).toBe('amateur');
    expect(r.setup.opponents).toBe(11);
    expect(r.drivers[2].color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(r.drivers[2].color).not.toBe('#16e0bd'); // an opponent never borrows the player's teal
    expect(r.drivers[2].livery!.primary).toBe(r.drivers[2].color);
    expect(r.drivers[3].seed).toBeGreaterThan(0);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toEqual(base.results[0]);
  });

  it('drops result entries for drivers who are not in the season and rounds out of order', () => {
    const base = JSON.parse(serializeChampionship(played()));
    const o = structuredClone(base);
    o.results[0].entries.push({ id: 'ghost', position: 99, points: 25, fastestLap: false, bestLap: 1, totalTime: 1, laps: 3 });
    o.results[0].entries.push({ ...o.results[0].entries[0] }); // duplicate
    const r = sanitizeState(o)!;
    expect(r.results[0].entries).toHaveLength(base.results[0].entries.length);
    const skipped = structuredClone(base);
    skipped.results[0].round = 5;
    expect(sanitizeState(skipped)!.results).toHaveLength(0);
    const extra = structuredClone(base);
    for (let i = 0; i < 8; i++) extra.results.push({ ...structuredClone(base.results[0]), round: extra.results.length });
    expect(sanitizeState(extra)!.results.length).toBeLessThanOrEqual(CALENDAR.length);
  });

  it('knows whether this build can race a saved season', () => {
    const s = make();
    const all = ['aurelia', 'kuroyama', 'brennwald', 'portovela'];
    expect(isPlayable(s, all, [CAR.id])).toBe(true);
    expect(isPlayable(s, ['aurelia', 'kuroyama', 'brennwald'], [CAR.id])).toBe(false); // a track has gone
    expect(isPlayable(s, all, ['other-car'])).toBe(false); // so has the car
  });

  it('never lets negative or non-numeric points into the table', () => {
    const o = JSON.parse(serializeChampionship(played()));
    o.results[0].entries[0].points = -50;
    o.results[0].entries[1].points = 'lots';
    o.results[0].entries[2].bestLap = 'fast';
    const r = sanitizeState(o)!;
    expect(r.results[0].entries[0].points).toBe(0);
    expect(r.results[0].entries[1].points).toBe(0);
    expect(r.results[0].entries[2].bestLap).toBeNull();
    expect(computeStandings(r).every((row) => row.points >= 0)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('localStorage wrappers', () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeStorage(): Storage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      get length() {
        return data.size;
      },
      clear: () => data.clear(),
      getItem: (k: string) => data.get(k) ?? null,
      key: (i: number) => [...data.keys()][i] ?? null,
      removeItem: (k: string) => void data.delete(k),
      setItem: (k: string, v: string) => void data.set(k, String(v)),
    };
  }

  it('saves under a versioned key, loads it back, and forgets on null', () => {
    const ls = fakeStorage();
    vi.stubGlobal('localStorage', ls);
    expect(CHAMPIONSHIP_KEY).toMatch(/\.v1$/);
    expect(loadChampionship()).toBeNull();
    const s = make();
    saveChampionship(s);
    expect(ls.data.has(CHAMPIONSHIP_KEY)).toBe(true);
    expect(loadChampionship()).toEqual(s);
    saveChampionship(null);
    expect(ls.data.has(CHAMPIONSHIP_KEY)).toBe(false);
    expect(loadChampionship()).toBeNull();
  });

  it('survives corrupt stored data', () => {
    const ls = fakeStorage();
    vi.stubGlobal('localStorage', ls);
    ls.setItem(CHAMPIONSHIP_KEY, '{"version":1,"calendar":"oops"');
    expect(loadChampionship()).toBeNull();
    ls.setItem(CHAMPIONSHIP_KEY, '{"version":1,"calendar":"oops"}');
    expect(loadChampionship()).toBeNull();
  });

  it('never throws when storage is missing, full or blocked', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => saveChampionship(make())).not.toThrow();
    expect(loadChampionship()).toBeNull();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => saveChampionship(make())).not.toThrow();
    expect(() => saveChampionship(null)).not.toThrow();
    expect(loadChampionship()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a round the player wins', () => {
  it('the player can win a round and lead the table', () => {
    let s = make({ opponents: 3 });
    s = recordRound(s, finishers(winnerFirst(s, PLAYER_ID)));
    const v = buildView(s);
    expect(v.table[0].isPlayer).toBe(true);
    expect(v.table[0].points).toBe(26);
    expect(v.season).toMatchObject({ wins: 1, podiums: 1, bestFinish: 1, fastestLaps: 1, points: 26 });
  });
});
