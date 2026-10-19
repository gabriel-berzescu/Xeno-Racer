/**
 * Nitro probe: the same AI races with and without nitro, side by side, on every track: shots fired, winner's time, contacts,
 * wall hits, seconds off the track and resets. Nitro must make the pack faster without making it crash more.
 *
 *   NITROPROBE=1 [TRACK=aurelia,kuroyama,brennwald,portovela,isvik] [CAR=mixed] [DIFF=pro] [N=8] [LAPS=2] [SEEDS=0,1] [WET=0..1] [LOG=1]
 *     npx vitest run tests/probes/nitro-probe.test.ts   → .cache/nitro.txt (or OUT=path)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import type { Difficulty } from '../../src/core/contracts';
import { runPack } from './pack-race';

it.skipIf(!process.env.NITROPROBE)('nitro probe (set NITROPROBE=1)', () => {
  const tracks = (process.env.TRACK ?? 'aurelia,kuroyama,brennwald,portovela,isvik').split(',');
  const seeds = (process.env.SEEDS ?? '0,1').split(',').map(Number);
  const car = process.env.CAR ?? 'mixed';
  const diff = (process.env.DIFF as Difficulty) ?? 'pro';
  const n = +(process.env.N ?? 8);
  const laps = +(process.env.LAPS ?? 2);
  const out: string[] = [];
  const f = (x: number) => x.toFixed(1).padStart(6);
  out.push('track       seed  nitro  shots  winner   hits  hard  walls    off  resets  finished');
  for (const t of tracks) {
    for (const seed of seeds) {
      for (const nitro of [false, true]) {
        const r = runPack(t, car, diff, n, laps, !!process.env.LOG, { seed, nitro });
        out.push(`${t.padEnd(11)} ${String(seed).padStart(4)}  ${nitro ? '  yes' : '   no'}  ${String(r.nitroShots ?? 0).padStart(5)}  ${f(r.winnerTime)}  ${String(r.contacts).padStart(5)} ${String(r.hardContacts).padStart(5)} ${String(r.walls).padStart(6)} ${f(r.offTrack)}  ${String(r.resets).padStart(6)}  ${r.finished}/${n}`);
        if (process.env.LOG && nitro) out.push(...r.rows, '');
      }
    }
  }
  mkdirSync('.cache', { recursive: true });
  writeFileSync(process.env.OUT ?? '.cache/nitro.txt', out.join('\n') + '\n');
  console.log(out.join('\n'));
}, 3600000);
