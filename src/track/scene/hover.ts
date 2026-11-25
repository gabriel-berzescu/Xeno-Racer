/**
 * The future at the trackside of an orbital circuit (`SceneryDef.hover`): the things near the road that say, at a glance and at
 * speed, that this is another century watching an old kind of race. Nothing here is physical, and all of it is quiet: white
 * composite, pale glass, a gold line, and light that is white with a little of the circuit's own colour in it.
 *
 *   hover.ts          the build
 *   hoverKit.ts       the kit: the materials, a vertex buffer that carries a light per vertex, smooth surfaces
 *   hoverTerrace.ts   the hovering grandstands
 *   hoverDrones.ts    the camera drones and the marshal drones
 *   hoverSky.ts       the traffic in the sky
 *   hoverBanner.ts    the event's name in the air
 *
 * What hovers has a ring of pale light under it (the terraces' hulls, their canopies, the drones): by day it shows in the thing's
 * own shade, after dark it is what one sees first. The quiet lines of light along the walls and the ring over the start line are
 * the neon kit's (`SceneryDef.neon`, see neon.ts), with a white and a level of their own.
 */
import * as THREE from 'three';
import type { Ctx } from './ctx';
import { buildBanner } from './hoverBanner';
import { buildDrones } from './hoverDrones';
import { crowdAtlas, makeHoverMats } from './hoverKit';
import { buildSkyLanes } from './hoverSky';
import { type TvCam, buildTerraces } from './hoverTerrace';
import { makeCrowdTexture } from './propTextures';

/** After the props (it keeps clear of the TV cameras) and before the trees (none grows under a terrace). */
export function buildHover(ctx: Ctx, cams: readonly TvCam[]): THREE.Group | null {
  const def = ctx.rt.def.scenery?.hover;
  if (!def) return null;
  const group = new THREE.Group();
  group.name = 'hover';
  // the stands' crowd (other people than theirs) over a band of white: the spectators are part of the hulls' own meshes
  const crowd = makeCrowdTexture(1);
  const atlas = crowdAtlas(crowd);
  crowd.dispose();
  ctx.disposables.push(atlas);
  const mats = makeHoverMats(ctx, atlas);
  let triangles = 0;
  const terraces = buildTerraces(ctx, def.terraces ?? [], mats, cams);
  group.add(terraces.group);
  triangles += terraces.triangles;
  const drones = buildDrones(ctx, def, mats, cams);
  if (drones) {
    group.add(drones.mesh);
    triangles += drones.triangles;
  }
  const sky = buildSkyLanes(ctx, def);
  if (sky) {
    group.add(sky.mesh);
    triangles += sky.triangles;
  }
  const banner = buildBanner(ctx, def);
  if (banner) {
    group.add(banner.mesh);
    triangles += banner.triangles;
  }
  // (for the probes: what was built, and where the terraces hang)
  group.userData.xrHover = { triangles, drones: drones?.count ?? 0, terraces: terraces.places };
  return group;
}
