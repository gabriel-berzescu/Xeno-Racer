import { describe, expect, it } from 'vitest';
import { polygonize, type MeshOut } from '../src/carvis/polygonize';
import { Curve } from '../src/carvis/curve';
import { sdEllipsoid, sdRoundBox, smin, sdSphere, sdPolygon2 } from '../src/carvis/sdf';

function edgeStats(m: MeshOut): { open: number; nonManifold: number } {
  const map = new Map<number, number>();
  const n = m.positions.length / 3;
  for (let t = 0; t < m.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = m.indices[t + e], b = m.indices[t + ((e + 1) % 3)];
      // directed edge key; a closed oriented manifold has each directed edge once and its reverse once
      const key = a * n + b;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
  }
  let open = 0, nonManifold = 0;
  for (const [key, c] of map) {
    const a = Math.floor(key / n), b = key % n;
    const rev = map.get(b * n + a) ?? 0;
    if (c !== 1) nonManifold++;
    if (rev !== 1) open++;
  }
  return { open, nonManifold };
}

function volumeArea(m: MeshOut): { volume: number; area: number } {
  let vol = 0, area = 0;
  const p = m.positions;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t] * 3, b = m.indices[t + 1] * 3, c = m.indices[t + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    area += 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
  }
  return { volume: vol, area };
}

describe('polygonize', () => {
  it('meshes a sphere: watertight, on-surface, outward, accurate', () => {
    const r = 0.5;
    const m = polygonize({ min: [-0.7, -0.7, -0.7], max: [0.7, 0.7, 0.7], cell: 0.04, field: (x, y, z) => sdSphere(x, y, z, r) });
    expect(m.stats.triangles).toBeGreaterThan(1000);
    const { open, nonManifold } = edgeStats(m);
    expect(open).toBe(0);
    expect(nonManifold).toBe(0);
    let maxErr = 0, maxNormalErr = 0;
    for (let i = 0; i < m.positions.length; i += 3) {
      const x = m.positions[i], y = m.positions[i + 1], z = m.positions[i + 2];
      const len = Math.sqrt(x * x + y * y + z * z);
      maxErr = Math.max(maxErr, Math.abs(len - r));
      const dot = (x * m.normals[i] + y * m.normals[i + 1] + z * m.normals[i + 2]) / len;
      maxNormalErr = Math.max(maxNormalErr, 1 - dot);
    }
    expect(maxErr).toBeLessThan(0.001);
    expect(maxNormalErr).toBeLessThan(0.001);
    const { volume, area } = volumeArea(m);
    expect(volume).toBeGreaterThan(0); // outward winding
    expect(Math.abs(volume / ((4 / 3) * Math.PI * r ** 3) - 1)).toBeLessThan(0.02);
    expect(Math.abs(area / (4 * Math.PI * r * r) - 1)).toBeLessThan(0.02);
  });

  it('culling gives the same mesh as brute force, with far fewer evaluations', () => {
    const f = (x: number, y: number, z: number): number => {
      const a = sdRoundBox(x, y, z, 0.6, 0.18, 0.35, 0.1);
      const b = sdEllipsoid(x - 0.1, y - 0.15, z, 0.3, 0.2, 0.25);
      return smin(a, b, 0.08);
    };
    const opts = { min: [-0.8, -0.4, -0.6] as const, max: [0.8, 0.5, 0.6] as const, cell: 0.03, field: f };
    const a = polygonize({ ...opts, cull: true, lipschitz: 1.3 });
    const b = polygonize({ ...opts, cull: false });
    expect(a.stats.vertices).toBe(b.stats.vertices);
    expect(a.stats.triangles).toBe(b.stats.triangles);
    expect(a.stats.evals).toBeLessThan(b.stats.evals * 0.6);
    const { open } = edgeStats(a);
    expect(open).toBe(0);
  });
});

describe('Curve', () => {
  it('interpolates control points and is monotone between monotone points', () => {
    const c = new Curve([[0, 0], [1, 1], [2, 4], [3, 4.2]], 0);
    expect(c.at(0)).toBeCloseTo(0, 3);
    expect(c.at(1)).toBeCloseTo(1, 3);
    expect(c.at(2)).toBeCloseTo(4, 3);
    expect(c.at(-5)).toBeCloseTo(0, 3);
    expect(c.at(9)).toBeCloseTo(4.2, 3);
    let prev = -1;
    for (let z = 0; z <= 3; z += 0.01) {
      const v = c.at(z);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-6);
      expect(v).toBeLessThanOrEqual(4.2 + 1e-6);
      prev = v;
    }
  });
  it('slope of a linear curve is its gradient', () => {
    const c = new Curve([[0, 0], [2, 1]], 0);
    expect(c.slope(1)).toBeCloseTo(0.5, 3);
  });
});

describe('sdPolygon2', () => {
  it('is negative inside and positive outside a square', () => {
    const sq = [0, 0, 1, 0, 1, 1, 0, 1];
    expect(sdPolygon2(sq, 0.5, 0.5)).toBeCloseTo(-0.5, 5);
    expect(sdPolygon2(sq, 2, 0.5)).toBeCloseTo(1, 5);
    expect(sdPolygon2(sq, -1, -1)).toBeCloseTo(Math.SQRT2, 5);
  });
});
