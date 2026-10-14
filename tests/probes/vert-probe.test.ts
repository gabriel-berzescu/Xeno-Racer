import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { loadTrackRuntime } from '../../src/track';
it.skipIf(!process.env.VERT)('vertical profile', () => {
  const t = loadTrackRuntime(process.env.TRACK ?? 'aurelia');
  const rows: string[] = [];
  const [a, b, step] = process.env.VERT!.split(',').map(Number);
  let worst = { s: 0, k: 0 };
  for (let i = 2; i < t.count - 2; i++) {
    // vertical curvature from centerline heights over ±5 m
    const h = 5 / t.spacing;
    const i0 = Math.max(0, i - h), i2 = Math.min(t.count - 1, i + h);
    const kv = (t.py[i2] - 2 * t.py[i] + t.py[i0]) / (5 * 5);
    if (-kv > worst.k) worst = { s: i * t.spacing, k: -kv };
    const s = i * t.spacing;
    if (s >= a && s <= b && Math.round(s) % step === 0) rows.push(`s=${s.toFixed(0)} y=${t.py[i].toFixed(2)} kv=${(kv * 1000).toFixed(2)} (crest R=${kv < 0 ? (-1 / kv).toFixed(0) : '-'} m, airborne above ${kv < 0 ? (Math.sqrt(9.81 / -kv) * 3.6).toFixed(0) : '-'} km/h) bank=${(t.bank[i] * 57.3).toFixed(1)}`);
  }
  rows.push(`worst crest: s=${worst.s} R=${(1 / worst.k).toFixed(0)} m → airborne above ${(Math.sqrt(9.81 / worst.k) * 3.6).toFixed(0)} km/h`);
  writeFileSync('.cache/vert.txt', rows.join('\n'));
});
