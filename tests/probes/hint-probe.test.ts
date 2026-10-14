import { writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { it } from 'vitest';
import type { GroundSample } from '../../src/core/contracts';
import { loadTrackRuntime } from '../../src/track';
it.skipIf(!process.env.HINT)('hint probe', () => {
  const t = loadTrackRuntime(process.env.TRACK ?? 'aurelia');
  const [a, b, dd] = process.env.HINT!.split(',').map(Number);
  const rows: string[] = [];
  const g1: GroundSample = { height: 0, normal: new Vector3(), surface: 'asphalt' };
  const g2: GroundSample = { height: 0, normal: new Vector3(), surface: 'asphalt' };
  const p = new Vector3();
  let hint = -1;
  for (let s = a; s <= b; s += 0.1) {
    t.pointAt(s, dd, p);
    hint = t.groundAt(p.x, p.z, g1, hint);
    t.groundAt(p.x, p.z, g2);
    const flag = Math.abs(g1.height - p.y) > 0.03 || Math.abs(g1.height - g2.height) > 0.01 ? ' <<<' : '';
    rows.push(`s=${s.toFixed(1)} road=${p.y.toFixed(3)} hinted=${g1.height.toFixed(3)} ${g1.surface} fresh=${g2.height.toFixed(3)} ${g2.surface} hint=${hint}${flag}`);
  }
  writeFileSync('.cache/hint.txt', rows.join('\n'));
});
