/**
 * AI pack races with the mechanical damage on (Damage: Full), against the same races without it (Visual). On demand only:
 *
 *   DMGRACE=1 [TRACK=aurelia,kuroyama,brennwald,portovela] [SEEDS=0..3] [N=12] [LAPS=2] [DIFF=pro] [CAR=mixed] \
 *     npx vitest run tests/probes/damage-race.test.ts
 *
 * Three races per track and seed: Visual (the cars take damage that changes nothing), Full as the game runs it (impacts folded
 * into each car's record, and what that does to the mechanics put on its physics and its driver), and a stress race in which half
 * the field starts the race badly damaged (a driver that knows about it, and one that does not). Prints how clean each stays:
 * contacts, hard hits, wall hits, seconds off the road, resets, overtakes, the winner's time, and in Full the hits that bent
 * something and the worst part at the end. Written to .cache/damage-race-<TAG>.txt.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import type { Difficulty } from '../../src/core/contracts';
import { MechState } from '../../src/core/mechanical';
import { runPack, type PackResult } from './pack-race';

/** Half the field gets a heavy, different state of damage; the rest are sound. Deterministic in the slot and the seed. */
export function stressDamage(i: number, seed: number): MechState | null {
  const h = (k: number): number => {
    const x = Math.sin((i + 1) * 12.9898 + k * 78.233 + seed * 37.719) * 43758.5453;
    return x - Math.floor(x);
  };
  if (h(0) < 0.5) return null;
  const m = new MechState();
  const e = (w: number): number => -Math.log(1 - Math.min(w, 0.999));
  m.front = h(1) < 0.5 ? e(0.4 + 0.6 * h(2)) : 0;
  m.rear = h(3) < 0.4 ? e(0.4 + 0.6 * h(4)) : 0;
  for (let w = 0; w < 4; w++) m.wheel[w] = h(5 + w) < 0.35 ? e(0.4 + 0.6 * h(9 + w)) : 0;
  return m;
}

const fmt = (r: PackResult): string =>
  `hits ${String(r.contacts).padStart(3)} hard ${String(r.hardContacts).padStart(2)}  walls ${String(r.walls).padStart(2)}  off ${r.offTrack.toFixed(1).padStart(5)}s  resets ${r.resets}  overtakes ${String(r.overtakes).padStart(3)}  winner ${r.winnerTime.toFixed(1)}s  finished ${r.finished}`;

describe('pack races with the mechanical damage', () => {
  it.skipIf(!process.env.DMGRACE)('Visual against Full, and a damaged field (set DMGRACE=1)', () => {
    const tracks = (process.env.TRACK ?? 'aurelia,kuroyama,brennwald,portovela').split(',');
    const spec = process.env.SEEDS ?? '0..3';
    const seeds = spec.includes('..') ? Array.from({ length: +spec.split('..')[1] - +spec.split('..')[0] + 1 }, (_, i) => +spec.split('..')[0] + i) : spec.split(',').map(Number);
    const n = +(process.env.N ?? 12);
    const laps = +(process.env.LAPS ?? 2);
    const diff = (process.env.DIFF as Difficulty) ?? 'pro';
    const car = process.env.CAR ?? 'mixed';
    const out: string[] = [`${car} ${diff} N=${n} laps=${laps} seeds ${spec}`];
    const tot: Record<string, { contacts: number; hard: number; walls: number; off: number; resets: number; overtakes: number; races: number }> = {};
    const add = (k: string, r: PackResult): void => {
      const t = (tot[k] ??= { contacts: 0, hard: 0, walls: 0, off: 0, resets: 0, overtakes: 0, races: 0 });
      t.contacts += r.contacts;
      t.hard += r.hardContacts;
      t.walls += r.walls;
      t.off += r.offTrack;
      t.resets += r.resets;
      t.overtakes += r.overtakes;
      t.races++;
    };
    for (const trackId of tracks) {
      for (const seed of seeds) {
        const visual = runPack(trackId, car, diff, n, laps, false, { seed });
        const full = runPack(trackId, car, diff, n, laps, false, { seed, full: true });
        const start = (i: number): MechState | null => stressDamage(i, seed);
        const knows = runPack(trackId, car, diff, n, laps, false, { seed, initial: start });
        const blind = runPack(trackId, car, diff, n, laps, false, { seed, initial: start, blind: true });
        add('visual', visual);
        add('full', full);
        add('damaged field, drivers know', knows);
        add('damaged field, drivers blind', blind);
        out.push(
          `${trackId.padEnd(9)} seed ${seed}`,
          `   Visual                         ${fmt(visual)}`,
          `   Full                           ${fmt(full)}  | bent: ${full.mechHits} hits, worst part ${full.worstWear!.toFixed(2)}`,
          `   Full, half the field damaged   ${fmt(knows)}  | drivers know`,
          `   Full, half the field damaged   ${fmt(blind)}  | drivers blind`,
        );
      }
    }
    out.push('', 'totals over all races:');
    for (const [k, t] of Object.entries(tot)) {
      out.push(`  ${k.padEnd(30)} ${t.races} races: contacts ${(t.contacts / t.races).toFixed(1)}  hard ${t.hard}  walls ${t.walls}  off ${(t.off / t.races).toFixed(2)} s/race  resets ${t.resets}  overtakes ${(t.overtakes / t.races).toFixed(1)}`);
    }
    mkdirSync('.cache', { recursive: true });
    writeFileSync(`.cache/damage-race-${process.env.TAG ?? 'run'}.txt`, out.join('\n') + '\n');
    console.log(out.join('\n'));
  }, 7200000);
});
