/**
 * The Mammoth against the other cars, in numbers: the standing start, the stop, the skidpad with the lean of the body, the squat and
 * the dive, loose ground, a launch on snow and a flick. Prints a table per section and writes .cache/mammoth-probe.txt.
 *
 *   MAMMOTH=drag,brake,pad,loose,snow,flick  npx vitest run tests/probes/mammoth-probe.test.ts
 *   MAMMOTH=all CAR=mammoth,vanta-gt          (the sections, the cars: default all the cars)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { CARS, getCar } from '../../src/cars';
import { brakeRun, coast, dragRun, flick, launch, skidpad } from './car-metrics';

const SECTIONS = (process.env.MAMMOTH ?? '').split(',').filter(Boolean);
const on = (s: string) => SECTIONS.includes('all') || SECTIONS.includes(s);
const cars = (process.env.CAR ? process.env.CAR.split(',').map(getCar) : CARS).filter(Boolean);
const f = (x: number | null, d = 2) => (x === null ? '  -  ' : x.toFixed(d));

describe.skipIf(SECTIONS.length === 0)('Mammoth probe', () => {
  it('measures', () => {
    const out: string[] = [];
    const say = (s: string) => {
      out.push(s);
      console.log(s);
    };
    if (on('drag')) {
      say('── standing start on dry asphalt (TCS low), 0-200 and top speed ──');
      for (const c of cars) {
        const d = dragRun(c);
        const off = dragRun(c, 12, {}, 'off');
        say(`${c.id.padEnd(10)} 0-60mph ${f(d.t60)} 0-100 ${f(d.t100)} (TCS off ${f(off.t100)}) 0-200 ${f(d.t200)} 1/4mi ${f(d.quarter)} vmax ${d.vmax.toFixed(0)} km/h  squat ${d.squatDeg.toFixed(2)} deg  maxslip ${d.maxSlip.toFixed(2)}  (stats ${c.stats.zeroTo100}s ${c.stats.topSpeedKmh} km/h)`);
      }
    }
    if (on('brake')) {
      say('── 100-0 km/h ──');
      for (const c of cars) {
        const a = brakeRun(c, true);
        const l = brakeRun(c, false);
        const w = brakeRun(c, true, { wetness: 0.75 });
        say(`${c.id.padEnd(10)} ABS ${a.distance.toFixed(1)} m (${((100 / 3.6) ** 2 / (2 * a.distance) / 9.81).toFixed(2)} g)  dive ${a.diveDeg.toFixed(2)} deg | locked ${l.distance.toFixed(1)} m | wet ${w.distance.toFixed(1)} m`);
      }
    }
    if (on('pad')) {
      say('── skidpad R60 ──');
      for (const c of cars) {
        const p = skidpad(c);
        const w = skidpad(c, 60, { wetness: 0.75 });
        say(`${c.id.padEnd(10)} ${p.latG.toFixed(3)} g @ ${p.speedKmh.toFixed(0)} km/h  roll ${p.rollDeg.toFixed(1)} deg (max ${p.maxRollDeg.toFixed(1)})  balance F-R ${p.balanceDeg.toFixed(2)} deg  min load ${(p.minLoadShare * 100).toFixed(0)} % | wet ${w.latG.toFixed(3)} g (${((w.latG / p.latG) * 100).toFixed(0)} %)`);
      }
    }
    if (on('loose')) {
      say('── loose ground: skidpad R60, stop from 100, coasting 4 s from 100 ──');
      for (const surface of ['grass', 'gravel', 'dirt', 'sand'] as const) {
        for (const c of cars) {
          const p = skidpad(c, 60, { surface });
          const b = brakeRun(c, true, { surface });
          const k = coast(c, { surface });
          say(`${surface.padEnd(7)} ${c.id.padEnd(10)} lat ${p.latG.toFixed(3)} g @ ${p.speedKmh.toFixed(0)} | 100-0 ${b.distance.toFixed(1)} m | coast 100 -> ${k.toFixed(0)} km/h`);
        }
      }
      for (const c of cars) {
        const p = skidpad(c, 40, { surface: 'deepsnow' });
        const k = coast(c, { surface: 'deepsnow' }, 80, 5);
        say(`deepsnow ${c.id.padEnd(10)} lat ${p.latG.toFixed(3)} g @ ${p.speedKmh.toFixed(0)} | coast 80 -> ${k.toFixed(0)} km/h in 5 s`);
      }
    }
    if (on('snow')) {
      say('── snow and ice (studded tyres): 0-100 with TCS low / off, skidpad R40, 100-0 ──');
      for (const surface of ['snow', 'ice'] as const) {
        for (const c of cars) {
          const a = launch(c, { surface }, 100, 'low');
          const b = launch(c, { surface }, 100, 'off');
          const p = skidpad(c, 40, { surface });
          const s = brakeRun(c, true, { surface });
          say(`${surface.padEnd(5)} ${c.id.padEnd(10)} 0-100 TCS low ${f(a, 1)} off ${f(b, 1)} | lat ${p.latG.toFixed(3)} g @ ${p.speedKmh.toFixed(0)} | 100-0 ${s.distance.toFixed(1)} m | 0-50 ${f(launch(c, { surface }, 50, 'low'), 1)}`);
        }
      }
    }
    if (on('flick')) {
      say('── flick at 110 km/h with the default aids (roll, lowest wheel load, wheels off the ground) ──');
      for (const c of cars) {
        const r = flick(c);
        const n = flick(c, 140);
        say(`${c.id.padEnd(10)} 110: roll ${r.maxRollDeg.toFixed(1)} deg  min load ${(r.minLoadShare * 100).toFixed(0)} %  ${r.spun ? 'SPUN' : 'ok'} | 140: roll ${n.maxRollDeg.toFixed(1)} deg  min load ${(n.minLoadShare * 100).toFixed(0)} %  ${n.spun ? 'SPUN' : 'ok'} lifted ${n.wheelsUpFrames}`);
      }
    }
    mkdirSync('.cache', { recursive: true });
    writeFileSync('.cache/mammoth-probe.txt', out.join('\n') + '\n');
  }, 1800000);
});
