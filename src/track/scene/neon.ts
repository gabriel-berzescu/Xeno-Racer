/**
 * The night dressing of a megacity circuit (`SceneryDef.neon`): light strips along the walls, rings of light over the road, hoops in
 * the tunnels, traffic in the sky. Nothing here is physical: the cars drive through all of it.
 */
import type * as THREE from 'three';
import type { Ctx } from './ctx';

export function buildNeon(ctx: Ctx): THREE.Group | null {
  const def = ctx.rt.def.scenery?.neon;
  if (!def) return null;
  return null;
}
