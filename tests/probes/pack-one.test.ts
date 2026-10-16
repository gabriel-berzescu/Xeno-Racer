/**
 * One pack race with the event log (impacts, resets, off-track moments), for a given seed.
 *   PACKONE=1 [SEED=3] [WET=1] [TRACK=isvik] [CAR=mixed] [DIFF=pro] [N=12] [LAPS=2] npx vitest run tests/probes/pack-one.test.ts   -> .cache/pack-one.txt
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import type { Difficulty } from '../../src/core/contracts';
import { runPack } from './pack-race';

it.skipIf(!process.env.PACKONE)('one pack race (set PACKONE=1)', () => {
  const r = runPack(process.env.TRACK ?? 'isvik', process.env.CAR ?? 'mixed', (process.env.DIFF as Difficulty) ?? 'pro', +(process.env.N ?? 12), +(process.env.LAPS ?? 2), true, {
    seed: +(process.env.SEED ?? 0),
    wetness: +(process.env.WET ?? 0),
  });
  mkdirSync('.cache', { recursive: true });
  writeFileSync('.cache/pack-one.txt', r.rows.join('\n') + '\n');
}, 900000);
