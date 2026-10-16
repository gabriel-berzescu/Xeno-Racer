/**
 * Prints the profile of a circuit while it is being designed: where the corners are, the height, the grade, the width, the surface,
 * the lake mask beside the road.
 *   TRACKPROFILE=isvik [STEP=40] npx vitest run tests/probes/track-profile.test.ts   -> .cache/profile-<id>.txt
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { describe, it } from 'vitest';
import type { GroundSample, TrackPoint } from '../../src/core/contracts';
import { loadTrackRuntime } from '../../src/track';
import type { TrackRuntimeImpl } from '../../src/track';

const id = process.env.TRACKPROFILE ?? '';

describe.runIf(id !== '')('track profile', () => {
  it('prints it', () => {
    const rt = loadTrackRuntime(id) as TrackRuntimeImpl;
    const step = +(process.env.STEP ?? 40);
    const lines: string[] = [];
    lines.push(`${rt.info.name}: ${rt.length.toFixed(1)} m, ${rt.count} samples, bounds x ${rt.bounds.minX.toFixed(0)}..${rt.bounds.maxX.toFixed(0)} z ${rt.bounds.minZ.toFixed(0)}..${rt.bounds.maxZ.toFixed(0)} y ${rt.bounds.minY.toFixed(1)}..${rt.bounds.maxY.toFixed(1)}`);
    lines.push('corners: ' + rt.corners.map((c) => `${c.name} ${(c.dir * c.angle * 180 / Math.PI).toFixed(0)}° R${c.radius} @${c.sStart.toFixed(0)}-${c.sEnd.toFixed(0)}`).join(' | '));
    const g: GroundSample = { height: 0, normal: new Vector3(), surface: 'asphalt' };
    const tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
    const p = new Vector3();
    const tn = rt.terrain;
    lines.push('   s      y   grade  curv(1/m)  W    wall   surf@0   iceMask(0/+30L/+30R)  far surf   terrain y at wall+10 (L/R)');
    let prevY = rt.py[0];
    for (let s = 0; s < rt.length; s += step) {
      const i = Math.floor(s / rt.spacing);
      rt.pointAt(s, 0, p);
      rt.groundAt(p.x, p.z, g, i);
      const surf0 = g.surface;
      rt.project(p.x, p.z, tp, i);
      const lm = (d: number) => {
        const q = new Vector3();
        rt.pointAt(s, d, q);
        return tn.iceMask(q.x, q.z);
      };
      rt.pointAt(s, rt.wallLeft[i] + 8, p);
      rt.groundAt(p.x, p.z, g, i);
      const hl = rt.heightFast(p.x, p.z);
      const q2 = new Vector3();
      rt.pointAt(s, -(rt.wallRight[i] + 10), q2);
      const hr = rt.heightFast(q2.x, q2.z);
      const y = rt.py[i];
      const grade = ((rt.py[Math.min(rt.count, i + 20)] - rt.py[i]) / (20 * rt.spacing)) * 100;
      void prevY;
      prevY = y;
      const corner = rt.corners.find((c) => s >= c.sStart && s <= c.sEnd);
      lines.push(
        `${s.toFixed(0).padStart(5)} ${y.toFixed(1).padStart(6)} ${grade.toFixed(1).padStart(5)}% ${rt.curvature[i].toExponential(1).padStart(9)} ${rt.widthLeft[i].toFixed(1).padStart(4)} ${rt.wallLeft[i].toFixed(1).padStart(5)}  ${surf0.padEnd(8)} ${lm(0).toFixed(2)} ${lm(30).toFixed(2)} ${lm(-30).toFixed(2)}  ${g.surface.padEnd(9)} ${hl.toFixed(1).padStart(5)} ${hr.toFixed(1).padStart(5)} ${corner ? corner.name : ''}`,
      );
    }
    mkdirSync('.cache', { recursive: true });
    writeFileSync(`.cache/profile-${id}.txt`, lines.join('\n') + '\n');
  });
});
