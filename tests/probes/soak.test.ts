/**
 * Soak probe: a long race with a full mixed grid, to catch slow drift (lap times creeping, temperatures running
 * away, numerical blow-ups, resets that only show up after many laps).
 *
 *   SOAK=1 [TRACK=aurelia,kuroyama] [LAPS=15] [N=12] [DIFF=pro] [WET=0..1] npx vitest run tests/probes/soak.test.ts
 *   → .cache/soak.txt
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import type { Difficulty } from '../../src/core/contracts';
import { runPack } from './pack.test';

it.skipIf(!process.env.SOAK)('long-race soak (set SOAK=1)', () => {
  const tracks = (process.env.TRACK ?? 'aurelia,kuroyama').split(',');
  const laps = +(process.env.LAPS ?? 15);
  const out: string[] = [];
  for (const t of tracks) {
    const t0 = performance.now();
    const r = runPack(t, 'mixed', (process.env.DIFF as Difficulty) ?? 'pro', +(process.env.N ?? 12), laps);
    const wall = (performance.now() - t0) / 1000;
    out.push(`${t}  ${laps} laps  finished ${r.finished}  winner ${r.winnerTime.toFixed(1)}s  overtakes ${r.overtakes}  (wall clock ${wall.toFixed(0)} s)`, ...r.rows, '');
  }
  mkdirSync('.cache', { recursive: true });
  writeFileSync('.cache/soak.txt', out.join('\n') + '\n');
}, 3600000);
