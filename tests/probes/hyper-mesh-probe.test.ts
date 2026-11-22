/**
 * Probe: how well the Taccola's mesh lies on its field (HYPERMESH=1 npx vitest run tests/probes/hyper-mesh-probe.test.ts). For every
 * triangle of the body, the field at its centroid and at its edges' middles is how far that triangle strays from the surface: a tooth
 * across a crease shows as millimetres. Prints the worst, where they are, and a histogram.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { getCar } from '../../src/cars';
import { BLUEPRINTS } from '../../src/carvis/bodies';
import { polygonize } from '../../src/carvis/polygonize';

const on = !!process.env.HYPERMESH;

describe.skipIf(!on)('hyper mesh probe', () => {
  it('measures the triangles against the field', () => {
    const spec = getCar('taccola').visual;
    const bp = BLUEPRINTS[spec.style](spec);
    const out: string[] = [];
    const console = { log: (s: string): void => void out.push(s) };
    for (const sharp of [false, true]) {
      const t0 = performance.now();
      const m = polygonize({ min: bp.bounds.min, max: bp.bounds.max, cell: 0.027, field: bp.body, lipschitz: 1.35, sharp });
      const ms = performance.now() - t0;
      const p = m.positions;
      const worst: Array<{ d: number; x: number; y: number; z: number }> = [];
      const hist = [0, 0, 0, 0, 0, 0];
      let vmax = 0;
      for (let v = 0; v < p.length; v += 3) vmax = Math.max(vmax, Math.abs(bp.body(p[v], p[v + 1], p[v + 2])));
      for (let t = 0; t < m.indices.length; t += 3) {
        const a = m.indices[t] * 3, b = m.indices[t + 1] * 3, c = m.indices[t + 2] * 3;
        const pts = [
          [(p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3],
          [(p[a] + p[b]) / 2, (p[a + 1] + p[b + 1]) / 2, (p[a + 2] + p[b + 2]) / 2],
          [(p[b] + p[c]) / 2, (p[b + 1] + p[c + 1]) / 2, (p[b + 2] + p[c + 2]) / 2],
          [(p[a] + p[c]) / 2, (p[a + 1] + p[c + 1]) / 2, (p[a + 2] + p[c + 2]) / 2],
        ];
        let d = 0;
        let at = pts[0];
        for (const q of pts) {
          const f = Math.abs(bp.body(q[0], q[1], q[2]));
          if (f > d) {
            d = f;
            at = q;
          }
        }
        hist[d < 0.001 ? 0 : d < 0.002 ? 1 : d < 0.004 ? 2 : d < 0.008 ? 3 : d < 0.016 ? 4 : 5]++;
        if (at[0] > 0 && d > 0.004) worst.push({ d, x: at[0], y: at[1], z: at[2] });
      }
      worst.sort((u, w) => w.d - u.d);
      console.log(`sharp=${sharp}: ${m.stats.vertices} vertices, ${m.stats.triangles} triangles, ${m.stats.evals} evals, ${ms.toFixed(0)} ms; worst vertex off the surface ${(vmax * 1000).toFixed(2)} mm`);
      console.log(`  triangles by how far they stray (<1, <2, <4, <8, <16, more mm): ${hist.join(' ')}`);
      // where the strays over 4 mm are, on the left half: counted in boxes of 20 cm along the car
      const boxes = new Map<string, number>();
      for (const w of worst) {
        const key = `z ${(Math.floor(w.z / 0.2) * 0.2).toFixed(1)} y ${(Math.floor(w.y / 0.2) * 0.2).toFixed(1)}`;
        boxes.set(key, (boxes.get(key) ?? 0) + 1);
      }
      console.log('  ' + [...boxes].sort((u, w) => w[1] - u[1]).slice(0, 14).map(([k, n]) => `${k}: ${n}`).join(' | '));
      console.log('  worst: ' + worst.slice(0, 8).map((w) => `${(w.d * 1000).toFixed(1)} mm at (${w.x.toFixed(2)}, ${w.y.toFixed(2)}, ${w.z.toFixed(2)})`).join('; '));
      mkdirSync('.cache', { recursive: true });
      writeFileSync('.cache/hyper-mesh.txt', out.join('\n') + '\n');
    }
  });
});
