/**
 * Builds a TrackRuntimeImpl from a TrackDef: plan -> samples -> elevation / bank / widths / zones.
 */
import { DEG } from './math';
import { PlanSampler, buildPlan, resolveMark } from './plan';
import { buildChannels, buildElevation, interpKeys } from './profile';
import { TrackRuntimeImpl } from './runtime';
import { makeTerrain } from './terrain';
import type { LakeDef, TrackDef } from './types';

export function buildRuntime(def: TrackDef): TrackRuntimeImpl {
  const plan = buildPlan(def.plan, def.dir);
  const L = plan.length;
  const N = Math.ceil(L);
  const spacing = L / N;

  const X = new Float64Array(N + 1);
  const Z = new Float64Array(N + 1);
  const PHI = new Float64Array(N + 1);
  const KAP = new Float64Array(N + 1);
  const sampler = new PlanSampler(plan.prims, L);
  let x = 0;
  let z = 0;
  for (let i = 0; i <= N; i++) {
    const s = i * spacing;
    const a0 = sampler.heading(s);
    PHI[i] = a0;
    KAP[i] = sampler.curvature(s);
    X[i] = x;
    Z[i] = z;
    if (i < N) {
      const am = sampler.heading(s + spacing / 2);
      const a1 = sampler.heading(s + spacing);
      x += (spacing / 6) * (Math.sin(a0) + 4 * Math.sin(am) + Math.sin(a1));
      z += (spacing / 6) * (Math.cos(a0) + 4 * Math.cos(am) + Math.cos(a1));
    }
  }
  // distribute the (tiny) residual closure error linearly (in the local frame)
  const ex = X[N];
  const ez = Z[N];
  for (let i = 0; i <= N; i++) {
    X[i] -= (ex * i) / N;
    Z[i] -= (ez * i) / N;
  }
  PHI[N] = PHI[0] + (def.dir > 0 ? 2 * Math.PI : -2 * Math.PI);
  KAP[N] = KAP[0];
  // place the plan in the world: rotate the local frame by the start heading and move the start line to its position
  if (def.start) {
    const { x: sx, z: sz, phi: sp } = def.start;
    const cs = Math.cos(sp);
    const sn = Math.sin(sp);
    for (let i = 0; i <= N; i++) {
      const xl = X[i];
      const zl = Z[i];
      X[i] = sx + xl * cs + zl * sn;
      Z[i] = sz - xl * sn + zl * cs;
      PHI[i] += sp;
    }
  }

  const Y = buildElevation(def.pvi, plan.marks, L, N, spacing);
  const BANK = interpKeys(def.bank, plan.marks, L, N, spacing, DEG);
  const WL = interpKeys(def.widthL, plan.marks, L, N, spacing);
  const WR = interpKeys(def.widthR, plan.marks, L, N, spacing);
  const ch = buildChannels(def, plan.marks, plan.corners, N, spacing, L);

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < N; i++) {
    if (X[i] < minX) minX = X[i];
    if (X[i] > maxX) maxX = X[i];
    if (Z[i] < minZ) minZ = Z[i];
    if (Z[i] > maxZ) maxZ = Z[i];
  }
  // bumps given by track mark -> world positions
  let terrainParams = def.terrain;
  if (def.terrain.bumpsAt?.length) {
    const extra = def.terrain.bumpsAt.map((b) => {
      const s = resolveMark(plan.marks, L, b.at);
      const i = Math.min(N - 1, Math.round(s / spacing));
      const d = b.d ?? 0;
      return { x: X[i] + Math.cos(PHI[i]) * d, z: Z[i] - Math.sin(PHI[i]) * d, r: b.r, h: b.h };
    });
    terrainParams = { ...def.terrain, bumps: [...(def.terrain.bumps ?? []), ...extra] };
  }
  // a frozen lake placed by mark: its ellipse lies along the road at that mark (the tangent is (sin phi, cos phi))
  let iceLake: LakeDef | null = null;
  const fz = def.terrain.frozen;
  if (fz) {
    const i = Math.min(N - 1, Math.round(resolveMark(plan.marks, L, fz.at) / spacing));
    const d = fz.d ?? 0;
    iceLake = {
      x: X[i] + Math.cos(PHI[i]) * d,
      z: Z[i] - Math.sin(PHI[i]) * d,
      rx: fz.along,
      rz: fz.across,
      rot: Math.atan2(Math.cos(PHI[i]), Math.sin(PHI[i])),
      level: fz.level,
      depth: 0,
      shore: fz.shore,
    };
  }
  const terrain = makeTerrain(
    terrainParams,
    {
      cx: (minX + maxX) / 2,
      cz: (minZ + maxZ) / 2,
      halfW: (maxX - minX) / 2,
      halfH: (maxZ - minZ) / 2,
    },
    iceLake,
  );

  const sectors: [number, number] = [resolveMark(plan.marks, L, def.sectors[0]), resolveMark(plan.marks, L, def.sectors[1])];

  return new TrackRuntimeImpl({
    def,
    plan,
    length: L,
    N,
    spacing,
    X,
    Z,
    PHI,
    KAPPA: KAP,
    Y,
    BANK,
    WL,
    WR,
    ch,
    crown: def.crown ?? (def.winter ? 0 : 0.015),
    terrain,
    iceLake,
    info: def.info,
    sectors,
  });
}
