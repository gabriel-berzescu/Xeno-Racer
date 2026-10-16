/**
 * Draws the centerline of a plan as an SVG (corner labels, free straights, a self-intersection check) while a circuit is being designed.
 *   LAYOUT=isvik npx vitest run tests/probes/layout-map.test.ts      -> .cache/layout-<id>.svg + a text report
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { polyLayout, type Vtx } from '../../src/track/layout';
import { DEG } from '../../src/track/math';
import { buildPlan } from '../../src/track/plan';
import type { PlanEl } from '../../src/track/types';

const id = process.env.LAYOUT ?? '';
const notes: string[] = [];

async function planOf(name: string): Promise<{ plan: PlanEl[]; dir: 1 | -1 }> {
  // (a scratch design under .cache/design/<name>.ts exporting { plan, dir } or { verts, sf } (a polygon layout), or a track def under src/track/defs/)
  const mod = (await import(/* @vite-ignore */ name.includes('/') ? `../../${name}.ts` : `../../.cache/design/${name}.ts`)) as { default?: unknown; [k: string]: unknown };
  if (mod.verts) {
    const lay = polyLayout(mod.verts as Vtx[], { sfAfterLastCorner: (mod.sf as number) ?? 120, strict: false });
    const neg = lay.straights.filter((s) => s.len < 0.5).map((s) => `${s.name}=${s.len.toFixed(0)}`);
    if (neg.length) notes.push(`OVERLAPPING corners (straight lengths): ${neg.join(', ')}`);
    notes.push('edges: ' + lay.straights.map((s) => `${s.name} ${s.len.toFixed(0)}`).join(', '));
    return { plan: lay.plan, dir: (mod.dir as 1 | -1) ?? -1 };
  }
  const def = (mod.plan ? mod : (mod[name.split('/').pop()!] ?? mod.default)) as { plan: PlanEl[]; dir: 1 | -1 };
  return { plan: def.plan, dir: def.dir };
}

describe.runIf(id !== '')('layout map', () => {
  it('draws the plan', async () => {
    const { plan, dir } = await planOf(id);
    let res;
    try {
      res = buildPlan(plan, dir);
    } catch (e) {
      // not closable: draw it open, with the free straights as given, to see why
      notes.push(`NOT CLOSABLE: ${(e as Error).message}`);
      res = buildPlan(plan.map((el) => (el.k === 'S' ? { ...el, free: false } : el)), dir);
    }
    const L = res.length;
    const N = Math.ceil(L);
    const pts: { x: number; z: number; s: number }[] = [];
    // integrate heading/curvature primitives
    let x = 0;
    let z = 0;
    let phi = 0;
    const prims = res.prims;
    let pi = 0;
    for (let i = 0; i <= N; i++) {
      const s = (i * L) / N;
      while (pi < prims.length - 1 && s >= prims[pi].s0 + prims[pi].len) pi++;
      pts.push({ x, z, s });
      const p = prims[pi];
      const u = Math.min(Math.max(s - p.s0, 0), p.len);
      const h = p.phi0 + p.k0 * u + ((p.k1 - p.k0) * u * u) / (2 * p.len || 1);
      phi = h;
      x += Math.sin(phi) * (L / N);
      z += Math.cos(phi) * (L / N);
    }
    // closure residual distributed
    const ex = pts[N].x;
    const ez = pts[N].z;
    for (let i = 0; i <= N; i++) {
      pts[i].x -= (ex * i) / N;
      pts[i].z -= (ez * i) / N;
    }
    // self-intersection: segments sampled every 4 m, non-adjacent closer than 9 m
    let near = 0;
    let nearest = 1e9;
    let nearAt = '';
    for (let i = 0; i < N; i += 2) {
      for (let j = i + 40; j < N; j += 2) {
        if (j > N - 40 && i < 40) continue;
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z);
        if (d < nearest) {
          nearest = d;
          nearAt = `s=${pts[i].s.toFixed(0)} and s=${pts[j].s.toFixed(0)}`;
        }
        if (d < 30) near++;
      }
    }
    const xs = pts.map((p) => p.x);
    const zs = pts.map((p) => p.z);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const pad = 80;
    const W = maxX - minX + 2 * pad;
    const H = maxZ - minZ + 2 * pad;
    const sc = 1100 / Math.max(W, H);
    // world +x is the car's LEFT when heading +z; draw east right: screen x = -world x, screen y = -z
    const sx = (px: number) => (-(px) - -maxX + pad) * sc;
    const sy = (pz: number) => (maxZ - pz + pad) * sc;
    let path = '';
    pts.forEach((p, i) => (path += (i ? 'L' : 'M') + sx(p.x).toFixed(1) + ' ' + sy(p.z).toFixed(1)));
    let labels = '';
    for (const c of res.corners) {
      const sm = (c.sArcA + c.sArcB) / 2;
      const k = Math.min(N, Math.round((sm / L) * N));
      labels += `<circle cx="${sx(pts[k].x).toFixed(1)}" cy="${sy(pts[k].z).toFixed(1)}" r="4" fill="${c.dir > 0 ? '#d33' : '#36c'}"/><text x="${(sx(pts[k].x) + 7).toFixed(1)}" y="${(sy(pts[k].z) - 6).toFixed(1)}" font-size="13" font-family="sans-serif">${c.name} ${(c.angle / DEG).toFixed(0)}° R${c.radius}</text>`;
    }
    // km ticks
    for (let km = 0; km * 1000 < L; km++) {
      const k = Math.round((km * 1000 * N) / L);
      labels += `<text x="${(sx(pts[k].x) - 4).toFixed(1)}" y="${(sy(pts[k].z) + 4).toFixed(1)}" font-size="11" fill="#080" font-family="sans-serif">${km}km</text>`;
    }
    const w = Math.round(W * sc);
    const h = Math.round(H * sc);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="none" stroke="#223" stroke-width="3"/>${labels}<circle cx="${sx(pts[0].x).toFixed(1)}" cy="${sy(pts[0].z).toFixed(1)}" r="6" fill="#0a0"/></svg>`;
    mkdirSync('.cache', { recursive: true });
    writeFileSync(`.cache/layout-${id}.svg`, svg);
    const lines = [...notes, `length ${L.toFixed(1)} m, closure error ${res.closureError.toExponential(2)}, total turn ${(res.totalTurn / DEG).toFixed(1)} deg`, `bounds ${(maxX - minX).toFixed(0)} x ${(maxZ - minZ).toFixed(0)} m, min approach of distant parts ${nearest.toFixed(1)} m (${nearAt}), ${near} close pairs`];
    for (const p of prims.filter((q) => q.kind === 'S')) lines.push(`  S ${p.n.padEnd(8)} ${p.len.toFixed(1)}${p.free ? ' (free)' : ''}`);
    for (const c of res.corners) lines.push(`  T ${c.name.padEnd(8)} ${(c.dir * c.angle / DEG).toFixed(0).padStart(5)}° R${c.radius}  s ${c.sStart.toFixed(0)}..${c.sEnd.toFixed(0)}`);
    writeFileSync(`.cache/layout-${id}.txt`, lines.join('\n') + '\n');
    console.info(lines.join('\n'));
  });
});
