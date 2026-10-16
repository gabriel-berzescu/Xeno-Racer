/**
 * Pack-race probe: a full grid of AI cars races from a standing start, the way the game sets it up.
 * Counts car-to-car contacts, wall hits, off-track time, resets and overtakes per car.
 *
 *   PACK=1 [TRACK=kuroyama] [CAR=vanta-gt|mixed] [DIFF=pro] [N=8] [LAPS=2] [WET=0..1] npx vitest run tests/probes/pack.test.ts
 *   → .cache/pack.txt
 *
 * Several seeds and tracks at once (the AI seed of every car shifts with SEED, so each race is a different one):
 *
 *   PACKSEEDS=1 [TRACK=aurelia,kuroyama,brennwald] [WET=0,1] [SEEDS=0..5] [CAR=mixed] [DIFF=pro] [N=12] [LAPS=2] [TAG=x] npx vitest run tests/probes/pack.test.ts
 *   → a table per track and weather (contacts and hard hits per race, wall hits, seconds off the track, resets, overtakes,
 *     and the off-track seconds per car model) in .cache/packseeds-<TAG>.txt
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import type { Difficulty } from '../../src/core/contracts';
import { runPack } from './pack-race';

export { runPack, type PackOptions, type PackResult } from './pack-race';

it.skipIf(!process.env.PACK)('pack race probe (set PACK=1)', () => {
  const tracks = (process.env.TRACK ?? 'aurelia,kuroyama').split(',');
  const out: string[] = [];
  for (const t of tracks) {
    const r = runPack(t, process.env.CAR ?? 'vanta-gt', (process.env.DIFF as Difficulty) ?? 'pro', +(process.env.N ?? 8), +(process.env.LAPS ?? 2), !!process.env.LOG);
    out.push(...r.rows, '');
  }
  mkdirSync('.cache', { recursive: true });
  writeFileSync('.cache/pack.txt', out.join('\n') + '\n');
}, 900000);

/** Benchmark set: same-car fields like the game races, plus one mixed field, on both tracks. */
it.skipIf(!process.env.PACKSET)('pack race benchmark set (set PACKSET=1)', () => {
  const diff = (process.env.DIFF as Difficulty) ?? 'pro';
  const sets: [string, string, number][] = [];
  for (const t of (process.env.TRACK ?? 'aurelia,kuroyama').split(',')) {
    for (const c of ['vanta-gt', 'kestrel-r', 'ronin-86', 'lmp-x', 'mixed']) sets.push([t, c, c === 'mixed' ? 12 : 8]);
  }
  const out: string[] = [];
  const tot = { contacts: 0, hard: 0, walls: 0, resets: 0, off: 0, overtakes: 0 };
  for (const [t, c, n] of sets) {
    const r = runPack(t, c, diff, n, 2);
    tot.contacts += r.contacts;
    tot.hard += r.hardContacts;
    tot.walls += r.walls;
    tot.resets += r.resets;
    tot.off += r.offTrack;
    tot.overtakes += r.overtakes;
    out.push(`${t.padEnd(9)} ${c.padEnd(10)} N=${n}  hits ${String(r.contacts).padStart(3)} hard ${String(r.hardContacts).padStart(2)}  walls ${String(r.walls).padStart(2)}  off ${r.offTrack.toFixed(1).padStart(5)}s  resets ${r.resets}  overtakes ${String(r.overtakes).padStart(3)}  winner ${r.winnerTime.toFixed(1)}s  finished ${r.finished}/${n}`);
  }
  out.push(`TOTAL hits ${tot.contacts} hard ${tot.hard} walls ${tot.walls} off ${tot.off.toFixed(1)}s resets ${tot.resets} overtakes ${tot.overtakes}`);
  mkdirSync('.cache', { recursive: true });
  writeFileSync(`.cache/packset-${process.env.TAG ?? 'run'}.txt`, out.join('\n') + '\n');
}, 1800000);

/** Many seeds on several tracks: the averages that tell a real change in the racing from the noise of one race. */
it.skipIf(!process.env.PACKSEEDS)('pack race seeds (set PACKSEEDS=1)', () => {
  const tracks = (process.env.TRACK ?? 'aurelia,kuroyama,brennwald').split(',');
  const wets = (process.env.WET ?? '0,1').split(',').map(Number);
  const spec = process.env.SEEDS ?? '0..5';
  const seeds = spec.includes('..') ? Array.from({ length: +spec.split('..')[1] - +spec.split('..')[0] + 1 }, (_, i) => +spec.split('..')[0] + i) : spec.split(',').map(Number);
  const diff = (process.env.DIFF as Difficulty) ?? 'pro';
  const car = process.env.CAR ?? 'mixed';
  const n = +(process.env.N ?? 12);
  const laps = +(process.env.LAPS ?? 2);
  const out = [`${car} ${diff} N=${n} laps=${laps} seeds ${spec}`, 'track      wet | contacts/race  hard hits  walls  off s/race  resets | overtakes/race | off s per car model'];
  for (const t of tracks) {
    for (const wet of wets) {
      const sum = { contacts: 0, hard: 0, walls: 0, off: 0, resets: 0, overtakes: 0 };
      const perModel = new Map<string, { off: number; n: number }>();
      for (const seed of seeds) {
        const r = runPack(t, car, diff, n, laps, false, { seed, wetness: wet });
        sum.contacts += r.contacts;
        sum.hard += r.hardContacts;
        sum.walls += r.walls;
        sum.off += r.offTrack;
        sum.resets += r.resets;
        sum.overtakes += r.overtakes;
        for (const c of r.perCar) {
          const m = perModel.get(c.model) ?? { off: 0, n: 0 };
          m.off += c.off;
          m.n++;
          perModel.set(c.model, m);
        }
      }
      const k = seeds.length;
      const models = [...perModel.entries()].map(([id, m]) => `${id} ${(m.off / m.n).toFixed(2)}`).join('  ');
      out.push(`${t.padEnd(10)} ${wet}   | ${(sum.contacts / k).toFixed(1).padStart(8)}  ${String(sum.hard).padStart(10)}  ${String(sum.walls).padStart(5)}  ${(sum.off / k).toFixed(2).padStart(9)}  ${String(sum.resets).padStart(6)} | ${(sum.overtakes / k).toFixed(1).padStart(14)} | ${models}`);
    }
  }
  mkdirSync('.cache', { recursive: true });
  writeFileSync(`.cache/packseeds-${process.env.TAG ?? 'run'}.txt`, out.join('\n') + '\n');
  console.log(out.join('\n'));
}, 3600000);
