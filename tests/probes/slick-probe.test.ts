/**
 * The racing slick against the road tyres and the all-terrain tyre on loose ground, in numbers, on a flat plane of grass, dirt, gravel and
 * sand, dry and wet, with asphalt for the reference: the lateral g each car holds at a steady 60 and 120 km/h (the pedals hold the speed
 * while the steering is wound on), the stop from that speed with ABS, what the ground takes from a rolling car (with the engine out of
 * it, `roll`, and with the engine braking, `coast`), how a car gets going (`launch`), the skidpad, and the AI's laps (`lap`).
 * Prints a table per section and writes .cache/slick-probe.txt (SLICK_OUT overrides).
 *
 *   SLICK=grip,brake,coast,roll,launch,pad,lap  npx vitest run tests/probes/slick-probe.test.ts
 *   SLICK=all CAR=lmp-x,lmp-x:plain,ronin-86 SURFACE=grass,gravel WET=0,0.75 KMH=60,120 TRACKS=aurelia
 *     (the sections; the cars, `lmp-x:plain` being the LMP-X as it was, without the trait; the grounds, the water and the speeds; the circuits)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { CARS, getCar } from '../../src/cars';
import type { CarDefinition, SurfaceType } from '../../src/core/contracts';
import { TRACKS } from '../../src/track';
import { aiLap, brakeRun, coast, freeRoll, gripAtSpeed, launch, skidpad } from './car-metrics';

const SECTIONS = (process.env.SLICK ?? '').split(',').filter(Boolean);
const on = (s: string) => SECTIONS.includes('all') || SECTIONS.includes(s);
/** A car by id; `lmp-x:plain` is the LMP-X without the slick trait (on the ground rules of a road tyre, with its own `mu`): the car as it was. */
const carByName = (name: string): CarDefinition => {
  const [id, variant] = name.split(':');
  const def = getCar(id);
  if (variant !== 'plain') return def;
  const d = structuredClone(def);
  delete d.physics.tireFront.slick;
  delete d.physics.tireRear.slick;
  return d;
};
const names = process.env.CAR ? process.env.CAR.split(',') : CARS.map((c) => c.id);
const cars = names.map(carByName);
const surfaces = (process.env.SURFACE ?? 'asphalt,grass,dirt,gravel,sand').split(',') as SurfaceType[];
const wets = (process.env.WET ?? '0,0.75').split(',').map(Number);
const speeds = (process.env.KMH ?? '60,120').split(',').map(Number);
const short = (name: string) => (name === 'lmp-x:plain' ? 'lmpPlain' : name.split('-')[0]).padEnd(8);

describe.skipIf(SECTIONS.length === 0)('Slick probe', () => {
  it('measures', () => {
    const out: string[] = [];
    const say = (s: string) => {
      out.push(s);
      console.log(s);
    };
    if (on('grip')) {
      say('── lateral g held at a steady speed (the speed it really held at the best, km/h, in brackets) ──');
      for (const surface of surfaces)
        for (const wetness of wets)
          for (const kmh of speeds) {
            const cells = cars.map((c, i) => {
              const g = gripAtSpeed(c, kmh, { surface, wetness });
              // (a car that cannot hold the speed on that ground, under a tenth short of it, has no figure)
              return g.latG > 0 ? `${short(names[i])} ${g.latG.toFixed(3)} (${g.speedKmh.toFixed(0).padStart(3)})` : `${short(names[i])}   -   (    )`;
            });
            say(`${surface.padEnd(7)} wet ${wetness.toFixed(2)} ${String(kmh).padStart(3)} km/h | ${cells.join(' | ')}`);
          }
    }
    if (on('brake')) {
      say('── stop from a speed with ABS (m, and the mean deceleration in g) ──');
      for (const surface of surfaces)
        for (const wetness of wets)
          for (const kmh of speeds) {
            const cells = cars.map((c, i) => {
              const b = brakeRun(c, true, { surface, wetness }, kmh);
              const g = (kmh / 3.6) ** 2 / (2 * b.distance) / 9.81;
              return `${short(names[i])} ${b.distance.toFixed(1).padStart(6)} (${g.toFixed(2)})`;
            });
            say(`${surface.padEnd(7)} wet ${wetness.toFixed(2)} ${String(kmh).padStart(3)} km/h | ${cells.join(' | ')}`);
          }
    }
    if (on('coast')) {
      say('── coasting 4 s from 100 km/h (km/h left): what drag, rolling and ploughing take ──');
      for (const surface of surfaces)
        say(`${surface.padEnd(7)} | ${cars.map((c, i) => `${short(names[i])} ${coast(c, { surface }, 100, 4).toFixed(0).padStart(3)}`).join(' | ')}`);
    }
    if (on('roll')) {
      say('── rolling 3 s from 100 km/h with the clutch in and no pedal (km/h left): what the ground and the air take, the engine out of it ──');
      for (const surface of surfaces)
        say(`${surface.padEnd(7)} | ${cars.map((c, i) => `${short(names[i])} ${freeRoll(c, { surface }).toFixed(1).padStart(5)}`).join(' | ')}`);
    }
    if (on('launch')) {
      say('── standing start with the default traction control: seconds to 20 and to 50 km/h (- = not in 30 s: beached) ──');
      for (const surface of surfaces)
        for (const wetness of wets) {
          const f = (t: number | null) => (t === null ? '  - ' : t.toFixed(1).padStart(4));
          const cells = cars.map((c, i) => `${short(names[i])} ${f(launch(c, { surface, wetness }, 20, 'low', 30))} ${f(launch(c, { surface, wetness }, 50, 'low', 30))}`);
          say(`${surface.padEnd(7)} wet ${wetness.toFixed(2)} | ${cells.join(' | ')}`);
        }
    }
    if (on('lap')) {
      say('── the AI (alien) second lap, dry and in a storm: time, resets, hits (a lap that stays on the asphalt is the same lap to the bit) ──');
      const tracks = (process.env.TRACKS ?? TRACKS.map((t) => t.info.id).join(',')).split(',');
      for (const trackId of tracks)
        for (const wetness of [0, 1]) {
          const cells = cars.map((c, i) => {
            const r = aiLap(trackId, c, wetness);
            return `${short(names[i])} ${r.lap.toFixed(3)} s r${r.resets} h${r.impacts}`;
          });
          say(`${trackId.padEnd(9)} wet ${wetness} | ${cells.join(' | ')}`);
        }
    }
    if (on('pad')) {
      say('── skidpad R60 (best lateral g, and the speed it was found at) ──');
      for (const surface of surfaces)
        for (const wetness of wets) {
          const cells = cars.map((c, i) => {
            const p = skidpad(c, 60, { surface, wetness });
            return `${short(names[i])} ${p.latG.toFixed(3)} (${p.speedKmh.toFixed(0).padStart(3)})`;
          });
          say(`${surface.padEnd(7)} wet ${wetness.toFixed(2)} | ${cells.join(' | ')}`);
        }
    }
    mkdirSync('.cache', { recursive: true });
    writeFileSync(process.env.SLICK_OUT ?? '.cache/slick-probe.txt', out.join('\n') + '\n');
  }, 1800000);
});
