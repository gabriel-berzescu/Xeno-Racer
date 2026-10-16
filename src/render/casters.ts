/**
 * Shadow casters by the kind of depth program they need (owner: render).
 *
 * The cascades build the depth program of a kind of caster the first time they draw one of that kind, and they only reach a couple
 * of hundred metres around the car. A kind that stands further away from the grid than that (the alpha-tested fences of Brennwald,
 * the palms of Porto Vela) would be built in the middle of the race, in a frame of its own: and in a race whose sky is dark at the
 * start, when the sun first comes out. So the hidden warm-up frame draws one caster of every kind, wherever it stands (see
 * RenderSystemImpl.renderNow; a mesh with several materials is taken once for each kind it brings, but is drawn once).
 */
import type { BufferGeometry, Material, Object3D } from 'three';

type Caster = Object3D & {
  isMesh?: boolean;
  material?: Material | Material[];
  geometry?: BufferGeometry;
  isInstancedMesh?: boolean;
  instanceColor?: unknown;
  isSkinnedMesh?: boolean;
  isBatchedMesh?: boolean;
};
type Texturing = Material & { map?: unknown; alphaMap?: unknown; displacementMap?: unknown };

/**
 * One visible shadow caster of every kind of depth program in `root`: what makes two casters differ here is what makes three.js
 * build them a different program (instanced, with a colour per instance, skinned, batched or morphed, one- or two-sided,
 * alpha-tested through a map or an alpha map, displaced). The first of each kind in the order of the scene.
 */
export function casterKinds(root: Object3D): Object3D[] {
  const seen = new Set<string>();
  const out = new Set<Object3D>();
  root.traverseVisible((o) => {
    if (!o.castShadow || !(o as Caster).isMesh) return;
    const c = o as Caster;
    if (!c.material) return;
    for (const m of Array.isArray(c.material) ? c.material : [c.material]) {
      if (!m.visible) continue;
      const t = m as Texturing;
      const key = [
        o.type,
        c.isInstancedMesh ? 1 : 0,
        c.instanceColor ? 1 : 0,
        c.isSkinnedMesh ? 1 : 0,
        c.isBatchedMesh ? 1 : 0,
        c.geometry?.morphAttributes?.position ? 1 : 0,
        m.side,
        m.shadowSide ?? '',
        m.alphaTest > 0 ? 1 : 0,
        t.map ? 1 : 0,
        t.alphaMap ? 1 : 0,
        t.displacementMap ? 1 : 0,
        m.alphaToCoverage ? 1 : 0,
      ].join();
      if (seen.has(key)) continue;
      seen.add(key);
      out.add(o);
    }
  });
  return [...out];
}
