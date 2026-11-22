import { describe, expect, it } from 'vitest';
import { CAR_LINEUP, CARS } from '../src/cars';
import { TRACKS } from '../src/track';
import { buildRaceConfig, defaultSetup } from '../src/ui/model';

/** The order the menus list the cars in, and the order the roster keeps for everything that takes a car from it by position. */
const racing = (c: (typeof CARS)[number]): boolean => c.class === 'Prototype' || c.class === 'Formula';

describe('the cars as the menus list them', () => {
  it('lists every car once: the road cars from the gentlest to the Taccola, then the racing cars from the slowest to the quickest', () => {
    expect(CAR_LINEUP.map((c) => c.id)).toEqual(['ronin-86', 'kestrel-r', 'mammoth', 'vanta-gt', 'taccola', 'lmp-x', 'volta', 'dieci']);
    expect(new Set(CAR_LINEUP)).toEqual(new Set(CARS));
    expect(CAR_LINEUP).toHaveLength(CARS.length);
    // the road cars first, in the order of their power to weight; the Taccola the last of them
    const road = CAR_LINEUP.filter((c) => !racing(c));
    expect(CAR_LINEUP.slice(0, road.length)).toEqual(road);
    const ratio = road.map((c) => c.stats.powerHp / c.stats.massKg);
    for (let i = 1; i < ratio.length; i++) expect(ratio[i], road[i].id).toBeGreaterThan(ratio[i - 1]);
    expect(road[road.length - 1].id).toBe('taccola');
    // then the racing cars, each quicker round a lap than the one before it (tests/volta.test.ts and tests/dieci.test.ts hold those laps)
    expect(CAR_LINEUP.slice(road.length).map((c) => c.id)).toEqual(['lmp-x', 'volta', 'dieci']);
  });

  it('leaves the roster in the order the cars were added, which the tests and the benchmarks take cars from by position', () => {
    expect(CARS.map((c) => c.id)).toEqual(['vanta-gt', 'kestrel-r', 'ronin-86', 'lmp-x', 'mammoth', 'volta', 'dieci', 'taccola']);
  });

  it('opens the car picker on the first of them, with the next for a second player', () => {
    const tracks = TRACKS.map((t) => t.info);
    const s = defaultSetup('race', tracks, CAR_LINEUP);
    expect(CAR_LINEUP[s.carIndex].id).toBe('ronin-86');
    expect(CAR_LINEUP[s.car2Index].id).toBe('kestrel-r');
    expect(buildRaceConfig(s, tracks, CAR_LINEUP, 'You', 1).carId).toBe('ronin-86');
  });
});
