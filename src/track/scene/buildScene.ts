/**
 * buildTrackScene: orchestrates the visible world for a track.
 */
import * as THREE from 'three';
import type { EnvironmentState } from '../../core/contracts';
import type { TrackScene, TrackSceneOptions } from '../../core/systems';
import type { TrackRuntimeImpl } from '../runtime';
import { newCtx, qualityParams, yieldFrame } from './ctx';
import { buildBarriers, makeBarrierMaterials } from './barriers';
import { buildCity } from './city';
import { buildHarbour } from './harbour';
import { buildHarbourProps } from './harbourProps';
import { buildStreet } from './street';
import { makeMaterials } from './materials';
import { buildProps } from './props';
import { buildRockCuts, buildTunnels } from './rocks';
import { buildRoad } from './road';
import { buildTerrainTiles } from './terrainTiles';
import { buildTrees } from './trees';
import { buildTufts } from './tufts';
import { buildWater } from './water';
import { loadTextures } from './textures';
import { setupWet, tintScene } from './wet';

export async function buildTrackScene(rt: TrackRuntimeImpl, opts: TrackSceneOptions): Promise<TrackScene> {
  const maxAniso = opts.renderer.capabilities.getMaxAnisotropy();
  const q = qualityParams(opts.quality, opts.vegetation, maxAniso);
  opts.onProgress?.(0.01, 'textures');
  const tex = await loadTextures(q.aniso, (f) => opts.onProgress?.(0.01 + 0.09 * f, 'textures'));
  const ctx = newCtx(rt, opts, tex, q);
  setupWet(ctx);
  const mats = makeMaterials(ctx);
  const root = ctx.root;
  root.name = `track:${rt.info.id}`;

  ctx.progress(0.12, 'terrain field');
  await yieldFrame();
  rt.ensureField();

  ctx.progress(0.2, 'road');
  root.add(buildRoad(ctx, mats));
  await yieldFrame();

  if (rt.def.scenery?.rockCuts) {
    const rc = buildRockCuts(ctx);
    ctx.rockFlags = rc.flags;
    root.add(rc.group);
  }
  ctx.progress(0.25, 'barriers');
  const barrierMats = makeBarrierMaterials(ctx);
  const tunnels = buildTunnels(ctx, barrierMats.concrete, mats.terrain);
  if (tunnels) root.add(tunnels);
  root.add(buildBarriers(ctx, barrierMats));
  await yieldFrame();

  // the harbour first: its dressing registers the quay lamps that the props build with the street lamps
  const harbour = buildHarbour(ctx);
  if (harbour) {
    root.add(harbour.group);
    const hp = buildHarbourProps(ctx, harbour.quays);
    if (hp) root.add(hp.group);
  }

  ctx.progress(0.27, 'buildings');
  const props = buildProps(ctx, barrierMats, mats);
  root.add(props.group);
  await yieldFrame();

  ctx.progress(0.29, 'city');
  const city = buildCity(ctx);
  if (city) root.add(city.group);
  const street = buildStreet(ctx);
  if (street) root.add(street);
  await yieldFrame();

  ctx.progress(0.3, 'terrain');
  root.add(await buildTerrainTiles(ctx, mats));

  ctx.progress(0.6, 'water');
  const water = buildWater(ctx);
  if (water) root.add(water);
  await yieldFrame();

  ctx.progress(0.65, 'trees');
  const trees = await buildTrees(ctx);
  if (trees) root.add(trees);
  const tufts = buildTufts(ctx);
  if (tufts) root.add(tufts);

  // every plain material below the root gets a wetness-aware tint (the road and terrain shaders do their own)
  tintScene(ctx, root);
  ctx.progress(1, 'done');

  const scene: TrackScene = {
    root,
    update(dt, camera) {
      const time = performance.now() / 1000;
      for (const u of ctx.updaters) u(dt, camera, time);
    },
    setStartLights(state: number | null) {
      props.setStartLights(state);
    },
    setEnvironment(env: EnvironmentState) {
      ctx.env = env;
      const k = Math.min(1, Math.max(0, (env.darkness - 0.15) / 0.7));
      for (const g of ctx.nightGlow) g.mat.emissiveIntensity = g.day + (g.night - g.day) * k;
      for (const l of ctx.envListeners) l(env);
    },
    tvCameras: props.tvCameras,
    dispose() {
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
      for (const m of mats.all) m.dispose();
      for (const d of ctx.disposables) d.dispose();
      for (const t of tex.all) t.dispose();
    },
  };
  scene.setEnvironment(opts.env);
  return scene;
}
