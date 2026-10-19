/**
 * Try variants of the Mammoth's physics without editing src/cars: each variant is a patch merged into the car, and the headline numbers
 * come out in one line each. A patch is JSON (nested objects merge, arrays and numbers replace).
 *
 *   SWEEP='[{"name":"base"},{"name":"stiffer","patch":{"physics":{"suspFront":{"antiRoll":12000}}}}]' npx vitest run tests/probes/mammoth-sweep.test.ts
 *   SWEEP=@variants.json  (read from a file)   METRICS=drag,brake,pad,flick,loose,snow   CAR=mammoth   -> .cache/mammoth-sweep.txt
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { getCar } from '../../src/cars';
import type { CarDefinition } from '../../src/core/contracts';
import { brakeRun, dragRun, flick, launch, skidpad } from './car-metrics';

interface Variant {
  name: string;
  patch?: Record<string, unknown>;
}

function merge<T>(base: T, patch: Record<string, unknown> | undefined): T {
  const out = structuredClone(base) as Record<string, unknown>;
  const walk = (dst: Record<string, unknown>, src: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) walk(dst[k] as Record<string, unknown>, v as Record<string, unknown>);
      else dst[k] = v;
    }
  };
  if (patch) walk(out, patch);
  return out as T;
}

const raw = process.env.SWEEP ?? '';
const variants: Variant[] = raw ? JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw) : [];
const metrics = (process.env.METRICS ?? 'drag,brake,pad,flick').split(',');

describe.skipIf(variants.length === 0)('Mammoth sweep', () => {
  it('measures each variant', () => {
    const base = getCar(process.env.CAR ?? 'mammoth');
    const lines: string[] = [];
    for (const v of variants) {
      const def: CarDefinition = merge(base, v.patch);
      const parts: string[] = [v.name.padEnd(14)];
      if (metrics.includes('drag')) {
        const d = dragRun(def, 45);
        parts.push(`0-100 ${d.t100?.toFixed(2)} 0-200 ${d.t200?.toFixed(1) ?? '-'} vmax ${d.vmax.toFixed(0)} squat ${d.squatDeg.toFixed(1)}`);
      }
      if (metrics.includes('brake')) {
        const b = brakeRun(def, true);
        const w = brakeRun(def, true, { wetness: 0.75 });
        parts.push(`100-0 ${b.distance.toFixed(1)} m dive ${b.diveDeg.toFixed(1)} wet ${w.distance.toFixed(1)}`);
      }
      if (metrics.includes('pad')) {
        const p = skidpad(def);
        const w = skidpad(def, 60, { wetness: 0.75 });
        parts.push(`pad ${p.latG.toFixed(3)} g roll ${p.rollDeg.toFixed(1)} bal ${p.balanceDeg.toFixed(2)} min ${(p.minLoadShare * 100).toFixed(0)}% wet ${(w.latG / p.latG).toFixed(2)}`);
      }
      if (metrics.includes('flick')) {
        const f = flick(def, 110);
        const g = flick(def, 140);
        parts.push(`flick110 roll ${f.maxRollDeg.toFixed(1)} min ${(f.minLoadShare * 100).toFixed(0)}% ${f.spun ? 'SPUN' : ''} | 140 roll ${g.maxRollDeg.toFixed(1)} min ${(g.minLoadShare * 100).toFixed(0)}% up ${g.wheelsUpFrames} ${g.spun ? 'SPUN' : ''}`);
      }
      if (metrics.includes('loose')) {
        const out: string[] = [];
        for (const surface of ['grass', 'gravel', 'dirt', 'sand'] as const) out.push(`${surface} ${skidpad(def, 60, { surface }).latG.toFixed(2)}`);
        out.push(`deepsnow ${skidpad(def, 40, { surface: 'deepsnow' }).latG.toFixed(2)}`);
        parts.push(out.join(' '));
      }
      if (metrics.includes('snow')) {
        parts.push(`snow 0-100 ${launch(def, { surface: 'snow' })?.toFixed(1)} pad ${skidpad(def, 40, { surface: 'snow' }).latG.toFixed(3)} ice 0-100 ${launch(def, { surface: 'ice' })?.toFixed(1)} pad ${skidpad(def, 40, { surface: 'ice' }).latG.toFixed(3)}`);
      }
      lines.push(parts.join(' | '));
      console.log(lines[lines.length - 1]);
    }
    mkdirSync('.cache', { recursive: true });
    writeFileSync('.cache/mammoth-sweep.txt', lines.join('\n') + '\n');
  }, 1800000);
});
