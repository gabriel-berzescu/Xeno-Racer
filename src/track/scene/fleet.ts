/**
 * Who came to watch an island circuit: the boats at anchor and under sail, and the great ship in the sky (`SceneryDef.fleet`).
 */
import type * as THREE from 'three';
import type { Ctx } from './ctx';

export function buildFleet(ctx: Ctx): THREE.Object3D | null {
  if (!ctx.rt.def.scenery?.fleet) return null;
  return null;
}
