import { describe, expect, it } from 'vitest';
import { CARS } from '../src/cars';
import { BLUEPRINTS } from '../src/carvis/bodies';
import { buildBody, buildCarData, CELL_SIZE, VERTEX_STRIDE } from '../src/carvis/build';
import { buildCaliper, buildWheel, styleForBody } from '../src/carvis/wheels';

describe('carvis geometry build (headless)', () => {
  for (const def of CARS) {
    const spec = def.visual;
    describe(def.id, () => {
      // build once per car at the default quality used by the game
      const dataP = buildCarData(spec, 'high');

      it('matches the CarVisualSpec dimensions (length / width / height within tolerance)', async () => {
        const d = (await dataP).lod0;
        const nb = d.stats.bodyVertices;
        let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, minZ = 1e9, maxZ = -1e9;
        for (let i = 0; i < nb; i++) {
          const o = i * VERTEX_STRIDE;
          const x = d.vertices[o], y = d.vertices[o + 1], z = d.vertices[o + 2];
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        }
        const rear = spec.length - spec.wheelbase - spec.frontOverhang;
        expect(maxZ).toBeGreaterThan(spec.wheelbase / 2 + spec.frontOverhang - 0.06);
        expect(maxZ).toBeLessThan(spec.wheelbase / 2 + spec.frontOverhang + 0.04);
        expect(minZ).toBeLessThan(-(spec.wheelbase / 2 + rear) + 0.06);
        expect(minZ).toBeGreaterThan(-(spec.wheelbase / 2 + rear) - 0.05);
        expect(maxX - minX).toBeGreaterThan(spec.width - 0.1);
        expect(maxX - minX).toBeLessThan(spec.width + 0.08); // the prototype's fenders must cover tyres wider than the nominal body width
        expect(maxY).toBeGreaterThan(spec.height - 0.05);
        expect(maxY).toBeLessThan(spec.height + 0.03);
        expect(minY).toBeGreaterThan(spec.rideHeight - 0.1);
      });

      it('keeps the tyres clear of the sculpted body at rest', () => {
        const bp = BLUEPRINTS[spec.style](spec);
        const wheels: Array<[number, number, number, number, number]> = [
          [spec.trackFront / 2, spec.wheelRadiusFront, spec.wheelbase / 2, spec.wheelRadiusFront, spec.tireWidthFront],
          [spec.trackRear / 2, spec.wheelRadiusRear, -spec.wheelbase / 2, spec.wheelRadiusRear, spec.tireWidthRear],
        ];
        let worst = 1e9;
        for (const [x, y, z, R, W] of wheels) {
          for (let a = 0; a < 48; a++) {
            const t = (a / 48) * Math.PI * 2;
            for (const dx of [-W / 2, 0, W / 2]) {
              const f = bp.body(x + dx, y + Math.sin(t) * R, z + Math.cos(t) * R);
              worst = Math.min(worst, f);
            }
          }
        }
        // the tread surface must not poke into the body by more than 1.5 cm anywhere
        expect(worst).toBeGreaterThan(-0.015);
      });

      it('stays inside the triangle budgets and has valid numbers', async () => {
        const data = await dataP;
        const tri = (n: number): number => n / 3;
        const body0 = tri(data.lod0.paintIndex.length) + tri(data.lod0.glassIndex.length);
        expect(body0).toBeLessThan(110000);
        expect(tri(data.lod2.index.length)).toBeLessThan(10000);
        for (const arr of [data.lod0.vertices, data.lod1.vertices, data.lod2.vertices, data.wheels0.front.vertices, data.interior.cabin.vertices]) {
          let bad = 0;
          for (let i = 0; i < arr.length; i += 7) if (!Number.isFinite(arr[i])) bad++;
          expect(bad).toBe(0);
        }
        expect(data.lod0.glassIndex.length).toBeGreaterThan(300);
        expect(data.lod2.colors?.length).toBe((data.lod2.vertices.length / VERTEX_STRIDE) * 3);
      });
    });
  }

  it('wheel builder: balanced triangle budget per wheel (high quality)', () => {
    for (const def of CARS) {
      const s = def.visual;
      const w = buildWheel({ R: s.wheelRadiusFront, W: s.tireWidthFront, rimR: s.rimRadiusFront, style: styleForBody(s.style), quality: 'high' });
      expect(w.triangleCount).toBeLessThan(11000);
      const c = buildCaliper({ R: s.wheelRadiusFront, W: s.tireWidthFront, rimR: s.rimRadiusFront, style: styleForBody(s.style), quality: 'high' }, true);
      expect(c.triangleCount).toBeLessThan(1500);
    }
  });

  it('cell size never gets coarser with higher quality (ultra shares the body resolution of high: 150k budget)', () => {
    expect(CELL_SIZE.low).toBeGreaterThan(CELL_SIZE.medium);
    expect(CELL_SIZE.medium).toBeGreaterThan(CELL_SIZE.high);
    expect(CELL_SIZE.high).toBeGreaterThanOrEqual(CELL_SIZE.ultra);
    void buildBody;
  });
});
