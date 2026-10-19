/**
 * Trees at a distance (headless: the canvases the atlases are painted on are stubbed). A winter circuit's billboard atlas has its
 * spruce and bare-birch tiles painted (they were left blank, and every tree of Isvik past the near trees' range was invisible); the mip
 * chain of an alpha-tested atlas keeps the coverage of its alpha test, level after level, where a plain box filter lets the silhouettes
 * melt away; and the far forest is drawn by the billboards alone.
 */
import { InstancedMesh } from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BB_T, coverageMips, makeBillboardAtlas } from '../src/track/scene/foliage';
import { instantiateTrees, treeRanges, type Inst } from '../src/track/scene/trees';
import type { SpeciesId } from '../src/track/types';

/** A canvas whose 2D context takes any drawing call and remembers the clip rectangles (one per atlas tile painted). */
function stubDocument(rects: number[]): () => void {
  const g = globalThis as unknown as { document?: unknown };
  const before = g.document;
  const ctx: unknown = new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) });
        if (key === 'rect') return (x: number) => void rects.push(x);
        return () => ctx;
      },
      set: () => true,
    },
  );
  g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
  return () => {
    g.document = before;
  };
}

const empty = (): Record<SpeciesId, Inst[]> => ({ oak: [], poplar: [], pine: [], birch: [], palm: [], spruce: [], snowbirch: [] });
const tree = (x: number, z: number): Inst => ({ x, y: 0, z, yaw: 0.3, s: 14, tint: 1, hue: 0, w: 1 });

describe('trees at a distance', () => {
  const rects: number[] = [];
  let restore = (): void => {};
  beforeAll(() => {
    restore = stubDocument(rects);
  });
  afterAll(() => restore());

  it("paints every tile of a winter circuit's billboard atlas (the spruce and the bare birch too)", () => {
    rects.length = 0;
    const road = makeBillboardAtlas(1, false);
    expect(road.image.width).toBe(BB_T * 4);
    expect([...new Set(rects)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3].map((t) => t * BB_T));
    rects.length = 0;
    const winter = makeBillboardAtlas(1, true);
    expect(winter.image.width).toBe(BB_T * 6);
    expect([...new Set(rects)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5].map((t) => t * BB_T));
    // and it carries its own mip chain, down to one texel
    expect(winter.generateMipmaps).toBe(false);
    const last = winter.mipmaps[winter.mipmaps.length - 1] as { width: number; height: number };
    expect([last.width, last.height]).toEqual([1, 1]);
  });

  it('keeps the coverage of the alpha test through the mip levels, where a box filter loses it', () => {
    // two tiles of 64 x 64: a spiky "tree" of thin vertical strokes (the worst case: a box filter halves it at every level) and a disc
    const W = 128;
    const H = 64;
    const base = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        base[i] = 30;
        base[i + 1] = 60;
        base[i + 2] = 40;
        const stroke = x < 64 && x % 4 === 0 && y > 8;
        const disc = x >= 64 && Math.hypot(x - 96, y - 32) < 20;
        base[i + 3] = stroke || disc ? 255 : 0;
      }
    }
    const cut = 0.42 * 255;
    const cover = (d: Uint8Array, w: number, h: number, x0: number, x1: number): number => {
      let n = 0;
      for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) if (d[(y * w + x) * 4 + 3] >= cut) n++;
      return n / ((x1 - x0) * h);
    };
    const levels = coverageMips(base, W, H, 2, 0.42);
    expect(levels.length).toBe(8); // 128 x 64 down to 1 x 1
    // never thinner than the full-size tile (hairline strokes may come out fuller: their alpha is only ever scaled up), and a disc,
    // which a box filter already keeps, stays as it was
    const strokes0 = cover(base, W, H, 0, 64);
    const disc0 = cover(base, W, H, 64, 128);
    for (const m of levels.slice(1, 5)) {
      const half = m.width / 2;
      expect(cover(m.data, m.width, m.height, 0, half)).toBeGreaterThanOrEqual(strokes0 - 0.02);
      // (down to 8 x 8 texels a tile: below that a texel is a sixteenth of it, and the coverage moves in steps that size)
      if (half >= 8) expect(cover(m.data, m.width, m.height, half, m.width)).toBeCloseTo(disc0, 1);
    }
    // what a plain box filter makes of the strokes two levels down (4 x 4 texels in one): a quarter of the alpha everywhere, under the
    // test: nothing would be drawn
    let boxPass = 0;
    for (let y = 2; y < H / 4; y++) {
      for (let x = 0; x < 16; x++) {
        let a = 0;
        for (let k = 0; k < 16; k++) a += base[((y * 4 + (k >> 2)) * W + x * 4 + (k & 3)) * 4 + 3];
        if (a / 16 >= cut) boxPass++;
      }
    }
    expect(boxPass).toBe(0);
    expect(cover(levels[2].data, levels[2].width, levels[2].height, 0, levels[2].width / 2)).toBeGreaterThan(0.2);
    // and a colour is never darkened by the clear texels around it (they have no weight in the average)
    const m1 = levels[1];
    const edge = (8 * m1.width + 0) * 4; // a texel that averages a stroke with the clear beside it
    expect(m1.data[edge + 1]).toBe(60);
  });

  it('draws the far forest with the billboards only, from every tier but the lowest', () => {
    const near = empty();
    const far = empty();
    for (let i = 0; i < 10; i++) {
      near.spruce.push(tree(10 + i * 3, 4));
      far.spruce.push(tree(600 + i * 7, 300));
      far.snowbirch.push(tree(640 + i * 7, 320));
    }
    const sys = instantiateTrees(near, 2, 1, 100, far);
    const count = (prefix: string): number =>
      sys.group.children.filter((c): c is InstancedMesh => c.name.startsWith(prefix)).reduce((n, m) => n + m.count, 0);
    expect(count('treeB_')).toBe(30); // the ten near trees and the twenty far ones
    expect(count('tree0_')).toBe(10); // the near LOD: the near trees only
    expect(treeRanges(0).far).toBe(0);
    for (const t of [1, 2, 3]) expect(treeRanges(t).far).toBeGreaterThan(treeRanges(t).r0 + 400);
  });
});
