import { describe, expect, it } from 'vitest';
import { CARS } from '../src/cars';
import { BLUEPRINTS } from '../src/carvis/bodies';
import { polygonize } from '../src/carvis/polygonize';

/**
 * The sculpted fields must be continuous and roughly distance-like near the surface: a jump or a
 * very steep gradient shows up as creases / saw-tooth edges in clearcoat reflections.
 */
describe('sculpted body fields', () => {
  for (const def of CARS) {
    it(`${def.id}: Lipschitz-continuous near the surface`, () => {
      const bp = BLUEPRINTS[def.visual.style](def.visual);
      const m = polygonize({ min: bp.bounds.min, max: bp.bounds.max, cell: 0.05, field: bp.body, lipschitz: 1.35 });
      const n = m.stats.vertices;
      const d = 0.003;
      let worst = 0, over = 0, tested = 0;
      let seed = 12345;
      const rnd = (): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        return ((seed >>> 0) / 4294967296) * 2 - 1;
      };
      for (let i = 0; i < n; i += 2) {
        const x = m.positions[i * 3], y = m.positions[i * 3 + 1], z = m.positions[i * 3 + 2];
        // a small ball of random directions around the surface vertex
        for (let k = 0; k < 3; k++) {
          let dx = rnd(), dy = rnd(), dz = rnd();
          const l = Math.hypot(dx, dy, dz) || 1;
          dx = (dx / l) * d; dy = (dy / l) * d; dz = (dz / l) * d;
          const r = Math.abs(bp.body(x + dx, y + dy, z + dz) - bp.body(x, y, z)) / d;
          worst = Math.max(worst, r);
          tested++;
          if (r > 1.45) over++;
        }
      }
      // essentially no sample may be steeper than 1.45, and nothing may exceed 2.2 (a true discontinuity)
      expect(over / tested).toBeLessThan(0.002);
      expect(worst).toBeLessThan(2.2);
    });
  }
});
