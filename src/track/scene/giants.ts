/**
 * The old wood of an island circuit and the rocks that stand in its sea (`SceneryDef.giants`).
 */
import type * as THREE from 'three';
import type { Ctx } from './ctx';

export function buildGiants(ctx: Ctx): THREE.Object3D | null {
  if (!ctx.rt.def.scenery?.giants) return null;
  return null;
}
