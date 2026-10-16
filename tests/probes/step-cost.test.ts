/**
 * What the mechanical damage costs the physics step. On demand only:
 *
 *   STEPCOST=1 [ROUNDS=7] npx vitest run tests/probes/step-cost.test.ts      → .cache/step-cost.txt
 *
 * The same 12-car field is stepped by this tree's physics on sound cars and on cars that all carry heavy damage, and, when
 * there is an export of the physics as it was before the mechanical damage in .cache/orig/src (`git archive <commit before> src`
 * extracted into .cache/orig), by that too. The rounds are interleaved, the order rotating, so that whatever the machine is doing
 * hits all alike. Only world.step() is timed (the drivers run outside the clock). Reported in ms per 60 Hz frame for 12 cars at 1000 Hz.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Quaternion, Vector3 } from 'three';
import { describe, it } from 'vitest';
import { AIDriver } from '../../src/ai';
import { CARS } from '../../src/cars';
import { MechState, mechanicalEffects } from '../../src/core/mechanical';
import { PhysicsWorld, createFlatTrack } from '../../src/physics';
import { loadTrackRuntime } from '../../src/track';

const DT = 1 / 60;
const SECONDS = 8;
const ORIG = resolve('.cache/orig/src').replace(/\\/g, '/');

interface Tree {
  World: new (track: never) => PhysicsWorld;
  AI: new (track: never, def: never, o: never) => AIDriver;
  cars: typeof CARS;
  flat(): never;
  track(id: string): never;
}

const here: Tree = { World: PhysicsWorld as never, AI: AIDriver as never, cars: CARS, flat: () => createFlatTrack() as never, track: (id) => loadTrackRuntime(id) as never };

/** The physics as it was before the mechanical damage, if an export of it is lying around. */
async function loadOrig(): Promise<Tree | null> {
  if (!existsSync(ORIG)) return null;
  const load = (m: string): Promise<Record<string, never>> => import(/* @vite-ignore */ `${ORIG}/${m}/index.ts`);
  const [ai, cars, physics, track] = await Promise.all([load('ai'), load('cars'), load('physics'), load('track')]);
  return {
    World: physics.PhysicsWorld,
    AI: ai.AIDriver,
    cars: cars.CARS,
    flat: () => (physics.createFlatTrack as () => never)(),
    track: (id) => (track.loadTrackRuntime as (id: string) => never)(id),
  };
}

const heavy = (() => {
  const m = new MechState();
  m.front = 1.2;
  m.rear = 1.2;
  for (let i = 0; i < 4; i++) m.wheel[i] = 1.2;
  return mechanicalEffects(m);
})();

/** One round: a 12-car field stepped for SECONDS of simulated time; the milliseconds spent in step() per 60 Hz frame. */
function round(tree: Tree, where: 'flat' | 'aurelia', damaged: boolean): number {
  const track = where === 'flat' ? tree.flat() : tree.track('aurelia');
  const world = new tree.World(track);
  const drivers: { ai: AIDriver; v: ReturnType<PhysicsWorld['addVehicle']> }[] = [];
  for (let i = 0; i < 12; i++) {
    const def = tree.cars[i % tree.cars.length];
    const v = world.addVehicle(def);
    v.assists = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true };
    if (where === 'flat') {
      v.placeOnGround(new Vector3((i % 4) * 8 - 12, 0, Math.floor(i / 4) * 12), new Quaternion(), 30);
      v.controls.throttle = 0.7;
      v.controls.steer = 0.1;
    } else {
      const g = (track as { grid: { position: Vector3; quaternion: Quaternion }[] }).grid[Math.min(i, 11)];
      v.placeOnGround(g.position, g.quaternion, 25);
      v.setTemperatures(0.8);
      drivers.push({ ai: new tree.AI(track, def as never, { difficulty: 'pro', seed: v.id * 17 + i, wetness: 0 } as never), v });
    }
    if (damaged) v.setDamage(heavy);
  }
  const states = world.states;
  let spent = 0;
  const frames = Math.round(SECONDS / DT);
  for (let f = 0; f < frames; f++) {
    for (const d of drivers) {
      d.ai.update(DT, d.v.state, states, d.v.controls, true);
      if (d.ai.needsReset) d.ai.onReset();
    }
    const t0 = performance.now();
    world.step(DT);
    spent += performance.now() - t0;
  }
  return spent / frames;
}

describe('physics step cost', () => {
  it.skipIf(!process.env.STEPCOST)('12 cars, sound and damaged, against the physics before the mechanical damage (set STEPCOST=1)', async () => {
    const rounds = +(process.env.ROUNDS ?? 7);
    const orig = await loadOrig();
    const variants: [string, Tree, boolean][] = [...(orig ? ([['before', orig, false]] as [string, Tree, boolean][]) : []), ['now, sound', here, false], ['now, all damaged', here, true]];
    const out: string[] = [`12 cars, 1000 Hz, ${SECONDS} s of simulated time per round, ${rounds} rounds, interleaved; ms of physics per 60 Hz frame${orig ? '' : ' (no .cache/orig/src: no "before")'}`];
    for (const where of ['flat', 'aurelia'] as const) {
      const times = variants.map(() => [] as number[]);
      variants.forEach(([, t, d]) => round(t, where, d)); // warm-up
      for (let r = 0; r < rounds; r++) {
        for (let j = 0; j < variants.length; j++) {
          const k = (r + j) % variants.length;
          times[k].push(round(variants[k][1], where, variants[k][2]));
        }
      }
      const med = (a: number[]): number => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
      out.push(`${where}:`);
      variants.forEach(([name], k) => {
        const a = times[k];
        out.push(`  ${name.padEnd(18)} min ${Math.min(...a).toFixed(3)}  median ${med(a).toFixed(3)}  mean ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3)}  max ${Math.max(...a).toFixed(3)}   [${a.map((x) => x.toFixed(2)).join(' ')}]`);
      });
      const base = med(times[0]);
      variants.slice(1).forEach(([name], k) => out.push(`  ${name} / ${variants[0][0]} (median) ${(med(times[k + 1]) / base).toFixed(3)}, (min) ${(Math.min(...times[k + 1]) / Math.min(...times[0])).toFixed(3)}`));
    }
    mkdirSync('.cache', { recursive: true });
    writeFileSync('.cache/step-cost.txt', out.join('\n') + '\n');
    console.log(out.join('\n'));
  }, 3600000);
});
