/**
 * The built world of an orbital habitat (`SceneryDef.habitat`, on a circuit with `TrackInfo.orbital`): the works at the foot of the
 * rim's wall of glass (habitatRim.ts), the stalks that stand on the floor of the ring (habitatStalks.ts), the settlements in the park
 * (habitatTown.ts) and the viaducts far out on the land (habitatSpan.ts).
 *
 * The opposite of the megacity: white shapes in sunlight, glass, gardens, a little gold. Everything is merged geometry in one lit
 * material (habitatKit.ts) and one draw call of small lights; nothing casts into the sun's cascades (the nearest of it stands a
 * quarter of a kilometre from the road) and nothing is made after the scene is built. A circuit without the block gets nothing of
 * this: no object, no material, no program.
 */
import * as THREE from 'three';
import type { Ctx } from './ctx';
import { HabBuf, HabLights, makeHabMaterials } from './habitatKit';
import { emitRim } from './habitatRim';
import { emitViaduct, viaductFeet } from './habitatSpan';
import { emitStalk, placeStalk } from './habitatStalks';
import { emitTown, type Plot } from './habitatTown';

/** How far away a settlement is still drawn (m), by quality tier: beyond it a house is less than a pixel or two high. */
const TOWN_RANGE = [1400, 2000, 2600, 3200];

export function buildHabitat(ctx: Ctx): THREE.Group | null {
  const rt = ctx.rt;
  const def = rt.def.scenery?.habitat;
  const ring = rt.info.orbital;
  if (!def || !ring) return null;
  const group = new THREE.Group();
  group.name = 'habitat';
  const mats = makeHabMaterials(ctx);
  const lights = new HabLights();
  let tris = 0;
  const parts: Record<string, number> = {};

  const add = (buf: HabBuf, name: string): THREE.Mesh | null => {
    if (buf.empty) return null;
    const geo = buf.build();
    tris += buf.tris;
    parts[name] = buf.tris;
    const mesh = new THREE.Mesh(geo, mats.structure);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    ctx.disposables.push(geo);
    return mesh;
  };

  // ── the rim works ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  if (def.rim) {
    const rim = emitRim(ctx, def.rim, ring, lights);
    rim.bufs.forEach((b, i) => add(b, `habitat_rim_${i}`));
    ctx.reserved.push(rim.reserve);
  }

  // ── the stalks ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const stalks = (def.stalks ?? []).map((s) => placeStalk(rt, ring, s));
  stalks.forEach((p, i) => {
    const buf = new HabBuf();
    emitStalk(buf, lights, p, i);
    add(buf, `habitat_stalk_${i}`);
  });
  if (stalks.length) {
    ctx.reserved.push((x, z, m) => {
      for (let i = 0; i < stalks.length; i++) {
        const p = stalks[i];
        const dx = x - p.def.x;
        const dz = z - p.def.z;
        const r = p.keep + m;
        if (dx * dx + dz * dz < r * r) return true;
      }
      return false;
    });
  }

  // ── the viaducts ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const feet: [number, number, number][] = [];
  (def.viaducts ?? []).forEach((v, i) => {
    const buf = new HabBuf();
    emitViaduct(buf, lights, rt, ring, v);
    add(buf, `habitat_viaduct_${i}`);
    feet.push(...viaductFeet(v));
  });
  if (feet.length) {
    ctx.reserved.push((x, z, m) => {
      for (let i = 0; i < feet.length; i++) {
        const f = feet[i];
        const r = f[2] + m;
        if ((x - f[0]) * (x - f[0]) + (z - f[1]) * (z - f[1]) < r * r) return true;
      }
      return false;
    });
  }

  // ── the settlements: a mesh each, drawn within sight ──────────────────────────────────────────────────────────────────────────
  const towns: { mesh: THREE.Mesh; x: number; z: number; r: number }[] = [];
  const plots: Plot[] = [];
  (def.settlements ?? []).forEach((s, i) => {
    const buf = new HabBuf();
    plots.push(...emitTown(ctx, buf, lights, s, i));
    const mesh = add(buf, `habitat_town_${i}`);
    if (mesh) towns.push({ mesh, x: s.x, z: s.z, r: s.r });
  });
  if (plots.length) {
    // (a coarse grid over the plots: the trees ask about every place they might stand)
    const CELL = 48;
    const grid = new Map<number, Plot[]>();
    const key = (ix: number, iz: number): number => ix * 73856093 + iz * 19349663;
    for (const p of plots) {
      const r = p.r + 12;
      for (let ix = Math.floor((p.x - r) / CELL); ix <= Math.floor((p.x + r) / CELL); ix++) {
        for (let iz = Math.floor((p.z - r) / CELL); iz <= Math.floor((p.z + r) / CELL); iz++) {
          const k = key(ix, iz);
          const l = grid.get(k);
          if (l) l.push(p);
          else grid.set(k, [p]);
        }
      }
    }
    ctx.reserved.push((x, z, m) => {
      const l = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
      if (!l) return false;
      for (let i = 0; i < l.length; i++) {
        const p = l[i];
        const r = p.r + Math.min(m, 12) - 1.5;
        if ((x - p.x) * (x - p.x) + (z - p.z) * (z - p.z) < r * r) return true;
      }
      return false;
    });
  }
  if (towns.length) {
    const cam = new THREE.Vector3();
    const range = TOWN_RANGE[ctx.q.tier];
    ctx.updaters.push((_dt, camera) => {
      camera.getWorldPosition(cam);
      for (let i = 0; i < towns.length; i++) {
        const t = towns[i];
        const d = Math.hypot(t.x - cam.x, t.z - cam.z) - t.r;
        t.mesh.visible = d < range;
        // (the sun's cascades reach a few hundred metres: a settlement nearer than that stands in its own shadow on the grass)
        t.mesh.castShadow = d < 280;
      }
    });
  }

  // ── the small lights: one object, always drawn (at zero by day: its program exists whatever the hour) ───────────────────────────
  const pts = lights.build(mats.lights);
  if (pts) {
    pts.frustumCulled = false;
    pts.matrixAutoUpdate = false;
    group.add(pts);
    ctx.disposables.push(pts.geometry);
  }
  group.userData.xrHabitat = { triangles: tris, lights: lights.count, meshes: group.children.length, parts };
  return group;
}
