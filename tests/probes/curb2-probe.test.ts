import { writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { it } from 'vitest';
import type { GroundSample } from '../../src/core/contracts';
import { loadTrackRuntime } from '../../src/track';
it.skipIf(!process.env.CURB2)('curb fine probe', () => {
  const t = loadTrackRuntime('aurelia');
  const g: GroundSample = { height: 0, normal: new Vector3(), surface: 'asphalt' };
  const p = new Vector3();
  const rows: string[] = [];
  let minNy = 1, maxStep = 0, worst = '';
  for (let s = 0; s < t.length; s += 0.05) {
    for (let d = -12; d <= 12; d += 0.05) {
      t.pointAt(s, d, p);
      t.groundAt(p.x, p.z, g);
      if (g.normal.y < minNy) { minNy = g.normal.y; worst = `s=${s.toFixed(2)} d=${d.toFixed(2)} ny=${g.normal.y.toFixed(3)} h=${g.height.toFixed(3)} ${g.surface}`; }
    }
    if (Math.round(s * 20) % 2000 === 0) rows.push(`progress s=${s.toFixed(0)} minNy=${minNy.toFixed(3)} worst ${worst}`);
  }
  rows.push(`FINAL minNy=${minNy.toFixed(3)} at ${worst}`);
  // detailed slice at the incident
  for (let s = 1676; s <= 1684; s += 0.1) {
    const line: string[] = [];
    for (let d = 6.6; d <= 7.6; d += 0.1) { t.pointAt(s, d, p); t.groundAt(p.x, p.z, g); line.push(`${(g.height - p.y).toFixed(3)}/${g.normal.y.toFixed(2)}${g.surface[0]}`); }
    rows.push(`s=${s.toFixed(1)} ${line.join(' ')}`);
  }
  writeFileSync('.cache/curb2.txt', rows.join('\n'));
});
