import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { computeRacingLine } from '../../src/ai';
import { loadTrackRuntime } from '../../src/track';
it.skipIf(!process.env.GEO)('geo probe', () => {
  const t = loadTrackRuntime('aurelia');
  const line = computeRacingLine(t, { edgeMargin: 0.75 });
  const rows: string[] = [];
  for (let s = 400; s < 900; s += 25) {
    const j = Math.round(s / t.spacing);
    const i = Math.round(s / line.step);
    // heading change over next 20 m from tangents
    const j2 = Math.round((s + 20) / t.spacing);
    const h1 = Math.atan2(t.tx[j], t.tz[j]);
    const h2 = Math.atan2(t.tx[j2], t.tz[j2]);
    let dh = h2 - h1; if (dh > Math.PI) dh -= 2 * Math.PI; if (dh < -Math.PI) dh += 2 * Math.PI;
    rows.push(`s=${s} trackCurv=${(t.curvature[j] * 1000).toFixed(2)} lineK=${(line.k[i] * 1000).toFixed(2)} dHeading20m=${(dh * 57.3).toFixed(1)}deg t=(${t.tx[j].toFixed(2)},${t.tz[j].toFixed(2)}) l=(${t.lx[j].toFixed(2)},${t.lz[j].toFixed(2)}) cross(t,l).y=${(t.tz[j] * t.lx[j] - t.tx[j] * t.lz[j]).toFixed(2)} lineD=${line.d[i].toFixed(1)} wL=${t.widthLeft[j].toFixed(1)}`);
  }
  writeFileSync('.cache/geo.txt', rows.join('\n'));
});
