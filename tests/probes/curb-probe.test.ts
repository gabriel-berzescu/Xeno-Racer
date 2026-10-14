import { writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { it } from 'vitest';
import type { GroundSample } from '../../src/core/contracts';
import { loadTrackRuntime } from '../../src/track';
const c0 = (t: any, s: number) => t.pointAt(s, 0, new Vector3());
it.skipIf(!process.env.CURB)('curb probe', () => {
  const t = loadTrackRuntime(process.env.TRACK ?? 'aurelia');
  const rows: string[] = [];
  const g: GroundSample = { height: 0, normal: new Vector3(), surface: 'asphalt' };
  const p = new Vector3();
  for (const s of (process.env.CURB!).split(',').map(Number)) {
    const tp: any = {}; t.project(c0(t, s).x, c0(t, s).z, tp);
    rows.push(`--- s=${s} wallL=${tp.wallLeft} wallR=${tp.wallRight} wL=${tp.widthLeft} wR=${tp.widthRight}`);
    const c = t.pointAt(s, 0, new Vector3());
    for (let d = -12; d <= 12; d += 0.25) {
      t.pointAt(s, d, p);
      t.groundAt(p.x, p.z, g);
      rows.push(`d=${d.toFixed(2)} h=${(g.height - c.y).toFixed(3)} n=(${g.normal.x.toFixed(2)},${g.normal.y.toFixed(3)},${g.normal.z.toFixed(2)}) ${g.surface}`);
    }
  }
  writeFileSync('.cache/curb.txt', rows.join('\n'));
});
