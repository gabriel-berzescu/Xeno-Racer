/**
 * Who came to watch an island circuit: the boats at anchor and under sail, and the great ship in the sky (`SceneryDef.fleet`).
 *
 * The people of the place came by sea, and they sail because they like to. The boats (fleetBoats.ts) are five kinds, one instanced
 * draw call each; where they lie and where they sail is worked out from the def and the depth of the water (fleetPlan.ts). The great
 * ship (fleetShip.ts) is one mesh. All of it is one lit material in two programs (fleetKit.ts): the sun, the sky and the haze of
 * the scene are on it at every hour, its lamps and its lines of light come up with the dark, and nothing is made after the scene
 * is built. Nothing casts into the sun's cascades: the nearest boat is forty metres from the road, on water, which shows no shadow.
 *
 * A circuit without the block gets nothing of this: no object, no material, no program.
 */
import * as THREE from 'three';
import type { BoatKind } from '../types';
import type { Ctx } from './ctx';
import { BOATS, BOAT_KINDS, boatBuffer } from './fleetBoats';
import { makeFleetMats } from './fleetKit';
import { type Berth, type PointOfSail, type Sailor, planFleet, pointOfSail, yawOf } from './fleetPlan';
import { greatShipBuffer } from './fleetShip';

export function buildFleet(ctx: Ctx): THREE.Object3D | null {
  const rt = ctx.rt;
  const def = rt.def.scenery?.fleet;
  if (!def) return null;
  const group = new THREE.Group();
  group.name = 'fleet';
  const mats = makeFleetMats(ctx);
  const level = rt.def.terrain.ocean?.level ?? rt.terrain.lakeLevel ?? 0;
  const plan = planFleet(rt, def, ctx.q.tier);
  let triangles = 0;
  const counts: Partial<Record<BoatKind, number>> = {};
  const parts: Record<string, number> = {};

  // ── the boats: one draw call a kind ───────────────────────────────────────────────────────────────────────────────────────────
  interface Under {
    sailor: Sailor;
    mesh: THREE.InstancedMesh;
    boat: THREE.InstancedBufferAttribute;
    index: number;
    s: number;
    trim: number;
    heel: number;
  }
  const under: Under[] = [];
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const qh = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const sv = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const AHEAD = new THREE.Vector3(1, 0, 0);
  for (const kind of BOAT_KINDS) {
    const moored: Berth[] = plan.berths.filter((b) => b.kind === kind);
    const sailing = plan.sailors.filter((b) => b.kind === kind);
    const list: Berth[] = [...moored, ...sailing];
    if (!list.length) continue;
    const buf = boatBuffer(kind);
    const geo = buf.build();
    const n = list.length;
    const boat = new Float32Array(n * 4);
    const tintA = new Float32Array(n * 3);
    const tintB = new Float32Array(n * 3);
    const mesh = new THREE.InstancedMesh(geo, mats.boats, n);
    mesh.name = `fleet_${kind}`;
    list.forEach((b, i) => {
      const sails = i >= moored.length;
      q.setFromAxisAngle(UP, b.yaw);
      m4.compose(p.set(b.x, level, b.z), q, sv.setScalar(b.scale));
      mesh.setMatrixAt(i, m4);
      // phase, roll (below 0 under way: a boat under sail does not swing at anchor, and the wind steadies it), trim, furl
      boat[i * 4] = b.phase;
      boat[i * 4 + 1] = sails ? -0.6 * BOATS[kind].roll : BOATS[kind].roll;
      boat[i * 4 + 2] = b.trim;
      boat[i * 4 + 3] = b.furl;
      tintA.set(b.sail, i * 3);
      tintB.set(b.hull, i * 3);
    });
    const boatAttr = new THREE.InstancedBufferAttribute(boat, 4);
    geo.setAttribute('aBoat', boatAttr);
    geo.setAttribute('aTintA', new THREE.InstancedBufferAttribute(tintA, 3));
    geo.setAttribute('aTintB', new THREE.InstancedBufferAttribute(tintB, 3));
    if (sailing.length) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      boatAttr.setUsage(THREE.DynamicDrawUsage);
      sailing.forEach((sailor, j) => under.push({ sailor, mesh, boat: boatAttr, index: moored.length + j, s: sailor.s, trim: 0, heel: 0 }));
    }
    mesh.instanceMatrix.needsUpdate = true;
    // (they lie all round the island: one draw call whatever the view)
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    ctx.disposables.push(geo);
    triangles += buf.triangles * n;
    counts[kind] = n;
    parts[kind] = buf.triangles;
  }

  // ── the boats under sail: along their courses, trimmed to the wind ────────────────────────────────────────────────────────────
  if (under.length) {
    const at = { x: 0, z: 0, tx: 0, tz: 0 };
    const pos: PointOfSail = { trim: 0, heel: 0, drive: 1 };
    const meshes = [...new Set(under.map((u) => u.mesh))];
    let first = true;
    ctx.updaters.push((dt) => {
      // (the sheets are let out and hauled in over a second or two: a gybe is not a snap)
      const ease = first ? 1 : Math.min(1, dt / 1.4);
      first = false;
      for (let i = 0; i < under.length; i++) {
        const u = under[i];
        const c = u.sailor.course;
        c.at(u.s, at);
        pointOfSail(u.sailor.kind, at.tx, at.tz, plan.wind, pos);
        u.s = (u.s + c.speed * pos.drive * dt) % c.length;
        u.trim += (pos.trim - u.trim) * ease;
        u.heel += (pos.heel - u.heel) * ease;
        q.setFromAxisAngle(UP, yawOf(at.tx, at.tz)).multiply(qh.setFromAxisAngle(AHEAD, u.heel));
        m4.compose(p.set(at.x, level, at.z), q, sv.setScalar(u.sailor.scale));
        u.mesh.setMatrixAt(u.index, m4);
        u.boat.setZ(u.index, u.trim);
      }
      for (const m of meshes) m.instanceMatrix.needsUpdate = true;
      for (const u of under) u.boat.needsUpdate = true;
    });
  }

  // ── the great ship ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  if (def.ship) {
    const buf = greatShipBuffer(def.ship);
    const geo = buf.build();
    const mesh = new THREE.Mesh(geo, mats.ship);
    mesh.name = 'fleet_ship';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    ctx.disposables.push(geo);
    triangles += buf.triangles;
    parts.ship = buf.triangles;
  }

  group.userData.xrFleet = { triangles, boats: counts, parts, sailing: under.length, meshes: group.children.length };
  return group;
}
