/**
 * TrackRuntimeImpl.drawnHeight: the ground as it is drawn, cheaply, over a whole region (the sun visibility map asks for hundreds of
 * thousands of heights). It must be the road's own surface wherever the baked terrain field is not what is drawn, and the field elsewhere.
 */
import { describe, expect, it } from 'vitest';
import { TRACKS, loadTrackRuntime } from '../src/track';
import type { TrackRuntimeImpl } from '../src/track';
import { mulberry32 } from '../src/track/math';

describe('the ground as drawn', () => {
  for (const t of TRACKS) {
    it(`${t.info.id}: is heightFast wherever it differs from the baked field, and the field everywhere else`, () => {
      const rt = loadTrackRuntime(t.info.id) as TrackRuntimeImpl;
      rt.ensureField();
      const b = rt.bounds;
      const rnd = mulberry32(12345);
      let near = 0;
      let far = 0;
      for (let k = 0; k < 6000; k++) {
        // half of the points around the road, half over the whole drawn terrain
        const x = k % 2 ? b.minX - 150 + rnd() * (b.maxX - b.minX + 300) : b.minX - 5000 + rnd() * (b.maxX - b.minX + 10000);
        const z = k % 2 ? b.minZ - 150 + rnd() * (b.maxZ - b.minZ + 300) : b.minZ - 5000 + rnd() * (b.maxZ - b.minZ + 10000);
        const fast = rt.heightFast(x, z);
        const field = rt.fieldHeight(x, z);
        const drawn = rt.drawnHeight(x, z);
        if (fast !== field) {
          // inside the road's corridor, where the surface is the road's: the exact one
          expect(drawn, `${x.toFixed(1)} ${z.toFixed(1)}`).toBe(fast);
          near++;
        } else {
          expect(drawn, `${x.toFixed(1)} ${z.toFixed(1)}`).toBe(field);
          far++;
        }
      }
      expect(near).toBeGreaterThan(20);
      expect(far).toBeGreaterThan(2000);
    });
  }

  it('is as cheap as the baked field far from the road (a ring search for the nearest road sample is what it saves)', () => {
    const rt = loadTrackRuntime('aurelia') as TrackRuntimeImpl;
    rt.ensureField();
    const b = rt.bounds;
    const time = (f: (x: number, z: number) => number): number => {
      let acc = 0;
      const t0 = performance.now();
      for (let i = 0; i < 60000; i++) acc += f(b.minX - 3000 + (i % 250) * 20, b.maxZ + 400 + Math.floor(i / 250) * 9);
      void acc;
      return performance.now() - t0;
    };
    time((x, z) => rt.drawnHeight(x, z));
    const drawn = Math.min(time((x, z) => rt.drawnHeight(x, z)), time((x, z) => rt.drawnHeight(x, z)));
    const fast = Math.min(time((x, z) => rt.heightFast(x, z)), time((x, z) => rt.heightFast(x, z)));
    // (a ring search that grows with the distance to the road: several times what a few cell lookups cost)
    expect(drawn).toBeLessThan(fast * 0.7);
  });
});
