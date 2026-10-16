/**
 * The trees of a winter circuit (headless: the canvases the foliage atlases are painted on are stubbed): the conifers and the birches
 * cast their shadows from a hull and a bare trunk of their own, drawn with the instance matrices of the trees, and the needle cards that
 * make the picture cast nothing. A road circuit's trees are as they were.
 */
import { InstancedMesh, MeshBasicMaterial, PerspectiveCamera } from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { instantiateTrees, type Inst } from '../src/track/scene/trees';
import type { SpeciesId } from '../src/track/types';

/** A 2D context that takes any drawing call and does nothing, and a canvas that has one: enough for the atlases to be made. */
function stubDocument(): () => void {
  const g = globalThis as unknown as { document?: unknown };
  const before = g.document;
  const ctx: unknown = new Proxy(
    {},
    {
      get: (_t, key) => (key === 'getImageData' ? (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => ctx),
      set: () => true,
    },
  );
  g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
  return () => {
    g.document = before;
  };
}

const tree = (x: number, z: number): Inst => ({ x, y: 0, z, yaw: 0.3, s: 14, tint: 1, hue: 0, w: 1 });
const empty = (): Record<SpeciesId, Inst[]> => ({ oak: [], poplar: [], pine: [], birch: [], palm: [], spruce: [], snowbirch: [] });

describe('trees of a winter circuit', () => {
  let restore = (): void => {};
  beforeAll(() => {
    restore = stubDocument();
  });
  afterAll(() => restore());

  const winter = (): Record<SpeciesId, Inst[]> => {
    const inst = empty();
    // a stand of trees beside the camera and another a kilometre away
    for (let i = 0; i < 12; i++) {
      inst.spruce.push(tree(10 + i * 3, 4), tree(1000 + i * 3, 4));
      inst.pine.push(tree(12 + i * 3, -6));
      inst.snowbirch.push(tree(14 + i * 3, 8), tree(1014 + i * 3, 8));
    }
    return inst;
  };
  const meshes = (sys: ReturnType<typeof instantiateTrees>, prefix: string): InstancedMesh[] => sys.group.children.filter((c): c is InstancedMesh => c.name.startsWith(prefix));

  it('draw the cards that make the picture without casting, and cast from a hull with the same instances', () => {
    const sys = instantiateTrees(winter(), 2, 1);
    const cards = meshes(sys, 'tree0_');
    const hulls = meshes(sys, 'tree0s_');
    expect(cards.length).toBeGreaterThan(0);
    expect(hulls.length).toBe(cards.length);
    for (const card of cards) {
      expect(card.castShadow).toBe(false);
      expect(card.receiveShadow).toBe(true);
      const hull = hulls.find((h) => h.name === card.name.replace('tree0_', 'tree0s_'))!;
      expect(hull, `a hull for ${card.name}`).toBeDefined();
      // (one buffer of matrices, not a copy)
      expect(hull.instanceMatrix).toBe(card.instanceMatrix);
      expect(hull.count).toBe(card.count);
      expect(hull.castShadow).toBe(true);
      expect(hull.receiveShadow).toBe(false);
      expect(hull.boundingSphere!.radius).toBe(card.boundingSphere!.radius);
    }
    // the cards of the far billboards and of the close hero trees cast nothing either (as before)
    for (const m of meshes(sys, 'treeB_')) expect(m.castShadow).toBe(false);
    for (const m of meshes(sys, 'tree0c_')) expect(m.castShadow).toBe(false);
  });

  it('use a hull of a few dozen triangles, with a noise cut for the gaps of the needles, and a bare trunk for a birch', () => {
    const sys = instantiateTrees(winter(), 2, 1);
    const hull = meshes(sys, 'tree0s_spruce')[0];
    const birch = meshes(sys, 'tree0s_snowbirch')[0];
    expect(hull.geometry.index!.count / 3).toBeLessThan(120);
    expect(hull.geometry.getAttribute('uv')).toBeDefined();
    const m = hull.material as MeshBasicMaterial;
    expect(m.map).toBeTruthy();
    expect(m.alphaTest).toBeGreaterThan(0.2);
    expect(m.alphaTest).toBeLessThan(0.5);
    expect(m.colorWrite).toBe(false);
    expect(m.depthWrite).toBe(false);
    // (the pines are the same hull as the spruces)
    expect(meshes(sys, 'tree0s_pine')[0].geometry).toBe(hull.geometry);
    // a birch: a trunk, a dozen triangles, no holes in it
    expect(birch.geometry.index!.count / 3).toBeLessThan(20);
    expect((birch.material as MeshBasicMaterial).map).toBeNull();
  });

  it('cast only where the cascades of the sun reach: a stand beside the camera does, one a kilometre away does not', () => {
    const sys = instantiateTrees(winter(), 2, 1);
    const cam = new PerspectiveCamera();
    cam.position.set(20, 2, 0);
    cam.updateMatrixWorld();
    sys.update(cam, 0);
    const hulls = meshes(sys, 'tree0s_');
    const near = hulls.filter((h) => h.boundingSphere!.center.x < 500);
    const far = hulls.filter((h) => h.boundingSphere!.center.x > 500);
    expect(near.length).toBeGreaterThan(0);
    expect(far.length).toBeGreaterThan(0);
    for (const h of near) {
      expect(h.visible).toBe(true);
      expect(h.castShadow).toBe(true);
    }
    for (const h of far) {
      expect(h.visible).toBe(false);
      expect(h.castShadow).toBe(false);
    }
    // and the cards do not take the casting back on, whatever the distance
    for (const c of meshes(sys, 'tree0_')) expect(c.castShadow).toBe(false);
    // the camera moves to the far stand: now they are the ones
    cam.position.set(1020, 2, 0);
    cam.updateMatrixWorld();
    sys.update(cam, 1);
    for (const h of near) expect(h.castShadow).toBe(false);
    for (const h of far) expect(h.castShadow).toBe(true);
  });

  it('are as they were on a road circuit: the cards cast, and no hulls are made', () => {
    const inst = empty();
    for (let i = 0; i < 12; i++) {
      inst.oak.push(tree(10 + i * 3, 4));
      inst.pine.push(tree(12 + i * 3, -6));
    }
    const sys = instantiateTrees(inst, 2, 1);
    expect(meshes(sys, 'tree0s_').length).toBe(0);
    const cam = new PerspectiveCamera();
    cam.position.set(20, 2, 0);
    cam.updateMatrixWorld();
    sys.update(cam, 0);
    const cards = meshes(sys, 'tree0_');
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(c.castShadow).toBe(true);
  });
});
