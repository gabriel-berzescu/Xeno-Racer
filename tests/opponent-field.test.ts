/**
 * Who the opponents of a race are: a race set up from the menus draws its field (its seed rides in the config, so a restart races the
 * same one), and whichever driver it begins with, the field has different names and colours.
 */
import { describe, expect, it } from 'vitest';
import type { TrackInfo } from '../src/core/contracts';
import { MAX_OPPONENTS } from '../src/core/split';
import { CARS } from '../src/cars';
import { DRIVER_NAMES, fieldStart, opponentLivery } from '../src/game/liveries';
import { buildRaceConfig, defaultSetup } from '../src/ui/model';

const TRACKS: TrackInfo[] = [
  { id: 'a', name: 'Alpha', location: 'Here', description: '', difficulty: 2, defaultLaps: 5, defaultTimeOfDay: 'golden', lengthHint: 5000, color: '#fff' },
  { id: 'b', name: 'Beta', location: 'There', description: '', difficulty: 4, defaultLaps: 3, defaultTimeOfDay: 'night', lengthHint: 3000, color: '#f0f' },
];

describe('the field of a race', () => {
  it('a race set up from the menus carries a seed for its field; a time trial and free roam, alone on track, do not', () => {
    const c = buildRaceConfig(defaultSetup('race', TRACKS, CARS), TRACKS, CARS, 'X');
    expect(Number.isInteger(c.opponentSeed)).toBe(true);
    expect(c.opponentSeed).toBeGreaterThan(0);
    expect(buildRaceConfig(defaultSetup('timeTrial', TRACKS, CARS), TRACKS, CARS, 'X').opponentSeed).toBeUndefined();
    expect(buildRaceConfig(defaultSetup('freeRoam', TRACKS, CARS), TRACKS, CARS, 'X').opponentSeed).toBeUndefined();
  });

  it('the seed picks the first opponent: any driver of the list, the same one for the same seed, the first without a seed', () => {
    expect(fieldStart(undefined)).toBe(0);
    expect(fieldStart(12345)).toBe(fieldStart(12345));
    const firsts = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) firsts.add(opponentLivery(fieldStart(seed), CARS[0]).driver);
    expect(firsts.size).toBe(DRIVER_NAMES.length);
  });

  it('whichever driver it begins with, a full field has different names and colours', () => {
    for (let first = 0; first < DRIVER_NAMES.length; first++) {
      const field = Array.from({ length: MAX_OPPONENTS }, (_, i) => opponentLivery(first + i, CARS[0]));
      expect(new Set(field.map((l) => l.driver)).size).toBe(MAX_OPPONENTS);
      expect(new Set(field.map((l) => l.primary)).size).toBe(MAX_OPPONENTS);
    }
  });
});
