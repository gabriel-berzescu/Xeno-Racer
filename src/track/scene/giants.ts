/**
 * The old wood of an island circuit and the rocks that stand in its sea (`SceneryDef.giants`).
 *
 * The wood: a few hundred trees a hundred metres tall (giantsPlace.ts says where, giantsTree.ts what one is), merged into two
 * meshes, bark and leaf; the nearer the road a giant stands, the more of it is built. Its shade is in giantsShade.ts: stand-in
 * casters for the cascades, and a share of the sun for every vertex above them, both worked out again when the light moves. Under
 * the giants, ferns (cards in the leaf mesh) and young trees of the game's own kind (handed to the tree system, which builds after
 * this); the ground of the wood is kept clear of the island's palms.
 *
 * The rocks: giantsRocks.ts.
 *
 * A circuit without the block gets nothing of this: no object, no material, no program.
 */
import * as THREE from 'three';
import type { Ctx } from './ctx';
import { makeGiantMaterials } from './giantsMat';
import { placeGiants, placeLogs, placeUnder, woodDensity, type Blocked, type Giant } from './giantsPlace';
import { buildSeaRocks } from './giantsRocks';
import { mulberry32 } from '../math';
import { ShadeModel, slideToSun } from './giantsShade';
import { emitFern, emitGiant, emitLog, GBuf } from './giantsTree';
import type { Inst } from './trees';

/** How near the road a giant is built in full, and how near in part (m from the centre line), by quality tier. */
const FULL = [0, 34, 48, 62];
const PART = [60, 90, 112, 150];
/** The share of the wood away from the road that stands at all, and of what grows under it, by quality tier. */
const SHARE = [0.5, 0.75, 1, 1];
const UNDER = [0.35, 0.7, 1, 1.25];

interface Part {
  bark: THREE.Mesh;
  leaf: THREE.Mesh;
  barkProbe: Int32Array;
  leafProbe: Int32Array;
  shade: ShadeModel;
  seen: Float32Array | null;
  caster: THREE.Mesh | null;
  casterBase: Float32Array | null;
}

function meshOf(b: GBuf, mat: THREE.Material, name: string, wind: boolean): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.pos), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(b.nor), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(b.uv), 2));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(b.col), 3));
  geo.setAttribute('aSun', new THREE.BufferAttribute(new Float32Array(b.n).fill(1), 1));
  if (wind) geo.setAttribute('aWind', new THREE.BufferAttribute(new Float32Array(b.wind), 1));
  geo.setIndex(new THREE.BufferAttribute(b.n > 65535 ? new Uint32Array(b.idx) : new Uint16Array(b.idx), 1));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.matrixAutoUpdate = false;
  // (the stand-ins cast for it; what is near the ground takes the cascades' shadows, the rest has its own sunlight)
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

export function buildGiants(ctx: Ctx): THREE.Object3D | null {
  const rt = ctx.rt;
  const def = rt.def.scenery?.giants;
  if (!def) return null;
  const group = new THREE.Group();
  group.name = 'giants';
  const tier = ctx.q.tier;
  const sea = rt.terrain.lakeLevel ?? -1e9;
  const blocked: Blocked = {
    ground: (x, z, m) => ctx.reserved.some((r) => r(x, z, m)),
    view: (x, z, m) => ctx.viewReserved.some((r) => r(x, z, m)),
  };
  const giants = placeGiants(rt, def, blocked, SHARE[tier]);
  const logs = placeLogs(rt, def, giants, blocked);
  const under = placeUnder(rt, def, giants, blocked, UNDER[tier], logs);
  // (its own dice: the scene's are left as they were for whoever builds after)
  const rnd = mulberry32((def.seed ?? 1) ^ 0x1b873593);
  const stats = { giants: giants.length, full: 0, part: 0, logs: logs.length, young: under.young.length, ferns: under.ferns.length, triangles: 0, casterTriangles: 0, probes: 0, parts: {} as Record<string, number> };

  if (giants.length) {
    const mats = makeGiantMaterials(ctx);
    // two parts: the wood, and the giants that stand alone far from it (each is drawn only when it is in sight)
    const parts: Part[] = [];
    for (const lone of [false, true]) {
      const list = giants.filter((g) => (g.kind === 'lone') === lone);
      if (!list.length) continue;
      const bark = new GBuf();
      const leaf = new GBuf();
      const shade = new ShadeModel();
      list.forEach((g: Giant, i) => {
        // (a lone giant is a landmark: seen from far, but whole)
        const li = lone ? Math.min(1, tier < 2 ? 1 : 0) : g.road < FULL[tier] ? 0 : g.road < PART[tier] ? 1 : 2;
        if (li === 0) stats.full++;
        else if (li === 1) stats.part++;
        emitGiant(g, li, bark, leaf, shade, i);
      });
      if (!lone) {
        for (const l of logs) emitLog(bark, l, tier >= 2 ? 12 : 8);
        for (const f of under.ferns) emitFern(leaf, f.x, f.y, f.z, f.s, rnd() * 6.28, 0.5 + 0.3 * rnd());
      }
      const name = lone ? 'giants_lone' : 'giants_wood';
      const bm = meshOf(bark, mats.bark, `${name}_bark`, false);
      const lm = meshOf(leaf, mats.leaf, `${name}_leaf`, true);
      group.add(bm, lm);
      ctx.disposables.push(bm.geometry, lm.geometry);
      stats.triangles += bark.tris + leaf.tris;
      stats.parts[`${name}_bark`] = bark.tris;
      stats.parts[`${name}_leaf`] = leaf.tris;
      stats.probes += shade.probeCount;
      // the stand-ins that cast its shadows
      const c = shade.casters();
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(c.pos), 3));
      cg.setAttribute('uv', new THREE.BufferAttribute(c.uv, 2));
      cg.setIndex(new THREE.BufferAttribute(c.idx, 1));
      const cm = new THREE.Mesh(cg, mats.caster);
      cm.name = `${name}_caster`;
      cm.matrixAutoUpdate = false;
      cm.castShadow = true;
      cm.receiveShadow = false;
      group.add(cm);
      ctx.disposables.push(cg);
      stats.casterTriangles += c.idx.length / 3;
      parts.push({ bark: bm, leaf: lm, barkProbe: Int32Array.from(bark.probe), leafProbe: Int32Array.from(leaf.probe), shade, seen: null, caster: cm, casterBase: c.pos });
    }

    // the shade follows the light: worked out when the scene is built and again whenever the light has moved by a fifth of a degree
    const last = new THREE.Vector3();
    const ground = (x: number, z: number): number => Math.max(sea, rt.drawnHeight(x, z));
    ctx.envListeners.push((env) => {
      const s = env.sunDirection;
      if (last.lengthSq() > 0 && last.dot(s) > 0.999994) return;
      last.copy(s);
      for (const p of parts) {
        p.seen = p.shade.solve(s.x, s.y, s.z, p.seen ?? undefined);
        for (const [mesh, probe] of [[p.bark, p.barkProbe], [p.leaf, p.leafProbe]] as const) {
          const a = mesh.geometry.getAttribute('aSun') as THREE.BufferAttribute;
          p.shade.paint(mesh.geometry.getAttribute('position').array, probe, p.seen, s.x, s.z, a.array as Float32Array);
          a.needsUpdate = true;
        }
        if (p.caster && p.casterBase) {
          const a = p.caster.geometry.getAttribute('position') as THREE.BufferAttribute;
          slideToSun(p.casterBase, a.array as Float32Array, s.x, s.y, s.z, ground);
          a.needsUpdate = true;
          p.caster.geometry.computeBoundingSphere();
        }
      }
    });

    // young trees of the giants' own kind: the game's conifers, a little bluer and darker than its pines
    if (under.young.length) {
      ctx.extraTrees ??= {};
      const list: Inst[] = (ctx.extraTrees.pine ??= []);
      for (const y of under.young) list.push({ x: y.x, y: y.y, z: y.z, yaw: rnd() * Math.PI * 2, s: y.s, tint: 0.8 + 0.2 * rnd(), hue: -0.12 + 0.1 * rnd(), w: 0.8 + 0.3 * rnd() });
    }

    // The ground of the wood is the giants': the island's palms and oaks keep off it (they ask with a margin of several metres),
    // the grass does not (it asks with one of a metre or so, and is refused only where a trunk and its roots stand).
    const wood = def.wood;
    ctx.reserved.push((x, z, m) => {
      if (wood && m >= 3) {
        if (woodDensity(wood, x, z) > 0.1) return true;
        // (a glade is open ground, a view is kept through it; the sea in front of it is whoever sails there's)
        for (const g of wood.glades ?? []) if ((x - g.x) * (x - g.x) + (z - g.z) * (z - g.z) < g.r * g.r && rt.fieldHeight(x, z) > sea) return true;
      }
      for (let i = 0; i < giants.length; i++) {
        const g = giants[i];
        const r = g.root * 0.8 + m;
        if ((x - g.x) * (x - g.x) + (z - g.z) * (z - g.z) < r * r) return true;
      }
      for (let i = 0; i < logs.length; i++) {
        const l = logs[i];
        // (the nearest point of the fallen trunk's axis)
        const t = Math.min(1, Math.max(0, ((x - l.x) * Math.cos(l.yaw) + (z - l.z) * Math.sin(l.yaw)) / l.len));
        const r = l.r + m;
        if ((x - l.x - Math.cos(l.yaw) * l.len * t) ** 2 + (z - l.z - Math.sin(l.yaw) * l.len * t) ** 2 < r * r) return true;
      }
      return false;
    });
  }

  const rocks = buildSeaRocks(ctx, def);
  if (rocks) {
    // (the water the arch stands in is taken: nothing anchors inside the rock)
    ctx.reserved.push(rocks.reserve);
    group.add(rocks.mesh);
    stats.triangles += rocks.triangles;
    stats.parts.rocks = rocks.triangles;
  }
  group.userData.xrGiants = stats;
  return group;
}
