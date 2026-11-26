/**
 * Draws an island circuit from above while it is being designed: the land by height, the water by depth, the road on top.
 *   ISLAND=halcyon npx vitest run tests/probes/island-map.test.ts      -> .cache/island-<id>.svg + a few numbers
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { loadTrackRuntime } from '../../src/track';
import type { TrackRuntimeImpl } from '../../src/track/runtime';

const id = process.env.ISLAND ?? '';

describe.runIf(id !== '')('island map', () => {
  it('draws the island', () => {
    const rt = loadTrackRuntime(id) as TrackRuntimeImpl;
    rt.ensureField();
    const level = rt.terrain.lakeLevel ?? 0;
    const pad = +(process.env.PAD ?? 700);
    const b = rt.bounds;
    const cell = +(process.env.CELL ?? 10);
    const nx = Math.ceil((b.maxX - b.minX + 2 * pad) / cell);
    const nz = Math.ceil((b.maxZ - b.minZ + 2 * pad) / cell);
    let rects = '';
    let land = 0;
    let lowest = Infinity;
    let highest = -Infinity;
    // east to the right: screen x = maxX - x; north up: screen y = maxZ - z
    for (let jz = 0; jz < nz; jz++) {
      const z = b.minZ - pad + (jz + 0.5) * cell;
      let run = '';
      let x0 = 0;
      const flush = (jx: number): void => {
        if (run) rects += `<rect x="${nx - jx}" y="${nz - 1 - jz}" width="${jx - x0}" height="1" fill="${run}"/>`;
      };
      for (let jx = 0; jx < nx; jx++) {
        const x = b.minX - pad + (jx + 0.5) * cell;
        const h = rt.fieldHeight(x, z);
        lowest = Math.min(lowest, h);
        highest = Math.max(highest, h);
        let col: string;
        if (h < level) {
          const d = Math.min(1, (level - h) / 12);
          col = `rgb(${Math.round(70 - 60 * d)},${Math.round(200 - 130 * d)},${Math.round(200 - 70 * d)})`;
        } else {
          land++;
          const t = Math.min(1, (h - level) / 30);
          col = h < level + 1.4 ? 'rgb(235,222,170)' : `rgb(${Math.round(90 + 110 * t)},${Math.round(160 - 30 * t)},${Math.round(70 + 40 * t)})`;
        }
        if (col !== run) {
          flush(jx);
          run = col;
          x0 = jx;
        }
      }
      flush(nx);
    }
    let path = '';
    for (let i = 0; i <= rt.count; i += 3) {
      const k = i % rt.count;
      path += `${i ? 'L' : 'M'}${(nx - (rt.X[k] - (b.minX - pad)) / cell).toFixed(1)} ${(nz - (rt.Z[k] - (b.minZ - pad)) / cell).toFixed(1)}`;
    }
    const sc = Math.min(8, 1200 / Math.max(nx, nz));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(nx * sc)}" height="${Math.round(nz * sc)}" viewBox="0 0 ${nx} ${nz}" shape-rendering="crispEdges">${rects}<path d="${path}" fill="none" stroke="#222" stroke-width="${(14 / cell).toFixed(2)}"/><circle cx="${(nx - (rt.X[0] - (b.minX - pad)) / cell).toFixed(1)}" cy="${(nz - (rt.Z[0] - (b.minZ - pad)) / cell).toFixed(1)}" r="${(20 / cell).toFixed(1)}" fill="#e22"/></svg>`;
    mkdirSync('.cache', { recursive: true });
    writeFileSync(`.cache/island-${id}.svg`, svg);
    // the road against the sea: how high it runs, and how near the water comes to its barriers
    let minRoad = Infinity;
    for (let i = 0; i < rt.count; i++) minRoad = Math.min(minRoad, rt.Y[i]);
    writeFileSync(`.cache/island-${id}.txt`, `heights ${lowest.toFixed(1)}..${highest.toFixed(1)} m, land ${((land * cell * cell) / 1e6).toFixed(2)} km2, lowest road ${minRoad.toFixed(1)} m, bounds x ${b.minX.toFixed(0)}..${b.maxX.toFixed(0)} z ${b.minZ.toFixed(0)}..${b.maxZ.toFixed(0)}
`);
    // where things are: the corners' apexes and the middles of the straights between them (world x, z; the road's height)
    const at = (name: string, sm: number): string => {
      const i = Math.min(rt.count - 1, Math.max(0, Math.round(sm / rt.spacing)));
      return `${name.padEnd(11)} s ${sm.toFixed(0).padStart(5)}  x ${rt.X[i].toFixed(0).padStart(5)}  z ${rt.Z[i].toFixed(0).padStart(5)}  y ${rt.Y[i].toFixed(1).padStart(5)}  heading ${((((Math.atan2(-(rt.X[(i + 1) % rt.count] - rt.X[i]), rt.Z[(i + 1) % rt.count] - rt.Z[i]) * 180) / Math.PI) + 360) % 360).toFixed(0)}`;
    };
    const places: string[] = [at('start line', 0)];
    rt.corners.forEach((c, k) => {
      places.push(at(c.name, (c.sArcA + c.sArcB) / 2));
      const next = rt.corners[(k + 1) % rt.corners.length];
      const s1 = next.sStart > c.sEnd ? next.sStart : next.sStart + rt.length;
      if (s1 - c.sEnd > 150) places.push(at(`  straight`, ((c.sEnd + s1) / 2) % rt.length));
    });
    writeFileSync(`.cache/island-${id}-places.txt`, places.join('\n') + '\n');
    console.info(`island ${id}: ${nx}x${nz} cells of ${cell} m, land ${((land * cell * cell) / 1e6).toFixed(2)} km2, heights ${lowest.toFixed(1)}..${highest.toFixed(1)} m, lowest road ${minRoad.toFixed(1)} m, bounds x ${b.minX.toFixed(0)}..${b.maxX.toFixed(0)} z ${b.minZ.toFixed(0)}..${b.maxZ.toFixed(0)}`);
  });
});
