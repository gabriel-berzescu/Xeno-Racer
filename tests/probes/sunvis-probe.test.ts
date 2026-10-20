/**
 * Probe (SUNVIS_PROBE=1): the sun visibility map on the real circuits. For every circuit and time of day: how long the map takes
 * to make, how much of the centreline it says is out of the sun, and the same share by marching the height field the way the QA
 * script (.cache/qa/s88-sunblock.mjs) does, as an independent check. Writes .cache/sunvis-probe.txt.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import type { TimeOfDay } from '../../src/core/contracts';
import { directionFromAngles, TOD, TOD_WINTER } from '../../src/render/presets';
import { computeSunVisibility, sampleSunVisibility, type SunTerrain } from '../../src/render/sunVisibility';
import { TRACKS, loadTrackRuntime } from '../../src/track';
import type { TrackRuntimeImpl } from '../../src/track';

const R = 0.0135;
const TODS: TimeOfDay[] = ['dawn', 'morning', 'noon', 'golden', 'dusk', 'night'];

it.skipIf(!process.env.SUNVIS_PROBE)('map vs marching on the circuits', async () => {
  mkdirSync('.cache', { recursive: true });
  if (!process.env.APPEND) writeFileSync('.cache/sunvis-probe.txt', '');
  const out = (s: string): void => appendFileSync('.cache/sunvis-probe.txt', s + '\n');
  const only = process.env.TRACK;
  for (const t of TRACKS) {
    if (only && t.info.id !== only) continue;
    const rt = loadTrackRuntime(t.info.id) as TrackRuntimeImpl;
    rt.ensureField();
    const b = rt.bounds;
    const terrain: SunTerrain = {
      height: (x, z) => rt.drawnHeight(x, z),
      extent: { minX: b.minX - 5000, maxX: b.maxX + 5000, minZ: b.minZ - 5000, maxZ: b.maxZ + 5000 },
      focus: { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ },
    };
    for (const tod of TODS) {
      const p = (t.info.winter ? TOD_WINTER : TOD)[tod];
      const d = { x: 0, y: 0, z: 0 };
      directionFromAngles(p.elDeg, p.azDeg, d);
      const t0 = performance.now();
      const f = await computeSunVisibility(terrain, [d.x, d.y, d.z], R);
      const ms = performance.now() - t0;
      // the centreline: the map's own verdict vs a march
      const hl = Math.hypot(d.x, d.z);
      const dx = d.x / hl;
      const dz = d.z / hl;
      const elev = Math.asin(d.y);
      let n = 0;
      let dark = 0;
      let mostly = 0;
      let part = 0;
      let marched = 0;
      for (let i = 0; i < rt.count; i += 8) {
        n++;
        const x = rt.X[i];
        const z = rt.Z[i];
        const road = rt.Y[i] + 0.6;
        const v = sampleSunVisibility(f, x, road, z);
        if (v < 0.02) dark++;
        if (v < 0.15) mostly++;
        if (v >= 0.15 && v < 0.98) part++;
        const eye = rt.fieldHeight(x, z) + 1.6;
        let best = -1;
        for (let s = 30; s <= 5000; s += 15) {
          const h = rt.fieldHeight(x + dx * s, z + dz * s);
          best = Math.max(best, Math.atan2(h - eye, s));
        }
        if ((best - elev) * 57.3 > 0.5) marched++;
      }
      out(
        `${t.info.id.padEnd(10)} ${tod.padEnd(8)} el ${p.elDeg.toFixed(1).padStart(5)} map ${ms.toFixed(0).padStart(4)} ms  coarse ${f.coarse ? `${f.coarse.w}x${f.coarse.h}@${f.coarse.cell.toFixed(0)}m` : '-'} fine ${f.fine ? `${f.fine.w}x${f.fine.h}@${f.fine.cell.toFixed(1)}m` : '-'} | centreline dark ${((100 * dark) / n).toFixed(0).padStart(3)} % <0.15 ${((100 * mostly) / n).toFixed(0).padStart(3)} % partial ${((100 * part) / n).toFixed(0).padStart(3)} % | marched (to 5 km, >0.5 deg) ${((100 * marched) / n).toFixed(0).padStart(3)} % | fineShade ${(100 * f.shadedFine).toFixed(0)} % active ${f.active}`,
      );
    }
  }
}, 600000);
