/**
 * Split screen, the parts that need neither a DOM nor WebGL: where the two views are, the lens of each, how big its HUD is, who
 * starts where, and what the opponents wear (src/core/split.ts, src/game/liveries.ts).
 */
import { describe, expect, it } from 'vitest';
import type { CarDefinition, GraphicsSettings, Livery } from '../src/core/contracts';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { hudBox, hudScale, MAX_OPPONENTS, MAX_SPLIT_OPPONENTS, opponentLimit, playerSlots, SEAT_COLOR, SPLIT_GAP, splitFov, splitGeometry, splitGraphics, viewAspect } from '../src/core/split';
import { opponentLivery } from '../src/game/liveries';
import { CARS } from '../src/cars';

const SIZES: [number, number][] = [[1920, 1080], [1600, 900], [1366, 768], [1024, 768], [2560, 1440], [3440, 1440], [1281, 721], [801, 601]];

describe('splitGeometry', () => {
  it('cuts a canvas into two equal views and a gap, rows (the default): one above the other', () => {
    for (const [w, h] of SIZES) {
      const g = splitGeometry(w, h, 'rows');
      const [a, b] = g.views;
      expect(a.w).toBe(w);
      expect(b.w).toBe(w);
      expect(a.h).toBe(b.h);
      expect(a.x).toBe(0);
      expect(a.y).toBe(0);
      // the second view ends where the canvas does, the divider fills what is left between them
      expect(b.y + b.h).toBe(h);
      expect(g.divider.y).toBe(a.h);
      expect(g.divider.y + g.divider.h).toBe(b.y);
      expect(g.divider.h).toBeGreaterThanOrEqual(SPLIT_GAP);
      expect(g.divider.h).toBeLessThanOrEqual(SPLIT_GAP + 1);
      expect(a.h * 2 + g.divider.h).toBe(h);
    }
  });

  it('1080p: two views of 1920x538 with the 4 px divider between them', () => {
    const g = splitGeometry(1920, 1080, 'rows');
    expect(g.views[0]).toEqual({ x: 0, y: 0, w: 1920, h: 538 });
    expect(g.views[1]).toEqual({ x: 0, y: 542, w: 1920, h: 538 });
    expect(g.divider).toEqual({ x: 0, y: 538, w: 1920, h: 4 });
  });

  it('columns: side by side, the same way round', () => {
    for (const [w, h] of SIZES) {
      const g = splitGeometry(w, h, 'columns');
      const [a, b] = g.views;
      expect(a.h).toBe(h);
      expect(b.h).toBe(h);
      expect(a.w).toBe(b.w);
      expect(b.x + b.w).toBe(w);
      expect(g.divider.x).toBe(a.w);
      expect(g.divider.x + g.divider.w).toBe(b.x);
      expect(a.w * 2 + g.divider.w).toBe(w);
    }
    expect(splitGeometry(1920, 1080, 'columns').views[0]).toEqual({ x: 0, y: 0, w: 958, h: 1080 });
  });

  it('never makes an empty or negative view, even for a tiny window', () => {
    for (const layout of ['rows', 'columns'] as const) {
      const g = splitGeometry(3, 3, layout);
      for (const v of g.views) {
        expect(v.w).toBeGreaterThanOrEqual(1);
        expect(v.h).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('the views never overlap and never leave the canvas', () => {
    for (const [w, h] of SIZES) {
      for (const layout of ['rows', 'columns'] as const) {
        const g = splitGeometry(w, h, layout);
        for (const v of g.views) {
          expect(v.x).toBeGreaterThanOrEqual(0);
          expect(v.y).toBeGreaterThanOrEqual(0);
          expect(v.x + v.w).toBeLessThanOrEqual(w);
          expect(v.y + v.h).toBeLessThanOrEqual(h);
        }
        const [a, b] = g.views;
        const apart = layout === 'rows' ? a.y + a.h <= b.y : a.x + a.w <= b.x;
        expect(apart).toBe(true);
      }
    }
  });
});

describe('splitFov', () => {
  it('leaves the lens alone when the view has the shape of the whole screen', () => {
    expect(splitFov(62, 16 / 9)).toBeCloseTo(62, 6);
    expect(splitFov(75, 16 / 9)).toBeCloseTo(75, 6);
  });

  it('narrows the vertical angle of a wide, short view and widens it for a tall, narrow one', () => {
    const wide = viewAspect(splitGeometry(1920, 1080, 'rows').views[0]);
    const tall = viewAspect(splitGeometry(1920, 1080, 'columns').views[0]);
    expect(wide).toBeGreaterThan(3.4);
    expect(tall).toBeLessThan(0.9);
    expect(splitFov(62, wide)).toBeGreaterThan(36);
    expect(splitFov(62, wide)).toBeLessThan(42);
    expect(splitFov(62, tall)).toBeGreaterThan(75);
    expect(splitFov(62, tall)).toBeLessThan(86);
  });

  it('keeps the horizontal angle of a wide view sensible: wider than the screen has, never a fisheye', () => {
    const hfov = (v: number, a: number): number => (2 * Math.atan(Math.tan((v * Math.PI) / 360) * a) * 180) / Math.PI;
    const a = viewAspect(splitGeometry(1920, 1080, 'rows').views[0]);
    const h = hfov(splitFov(62, a), a);
    expect(h).toBeGreaterThan(hfov(62, 16 / 9) - 2);
    expect(h).toBeLessThan(115);
    // the tall view of the side-by-side layout is narrower, but not a keyhole
    const t = viewAspect(splitGeometry(1920, 1080, 'columns').views[0]);
    expect(hfov(splitFov(62, t), t)).toBeGreaterThan(65);
  });

  it('follows the player\'s setting, monotonically, and stays inside a sane range', () => {
    const a = 3.5;
    let prev = 0;
    for (let f = 45; f <= 100; f += 5) {
      const v = splitFov(f, a);
      expect(v).toBeGreaterThan(prev);
      expect(v).toBeGreaterThanOrEqual(20);
      expect(v).toBeLessThanOrEqual(95);
      prev = v;
    }
  });

  it('survives nonsense', () => {
    expect(splitFov(62, 0)).toBe(62);
    expect(splitFov(62, NaN)).toBe(62);
    expect(splitFov(0, 3)).toBe(0);
  });
});

describe('hudScale and hudBox', () => {
  it('draws the HUD at about three quarters in a view of a 1080p split (and the box it is laid out in follows)', () => {
    const g = splitGeometry(1920, 1080, 'rows');
    const k = hudScale(g.views[0].w, g.views[0].h, 'rows');
    expect(k).toBeGreaterThan(0.7);
    expect(k).toBeLessThan(0.8);
    const box = hudBox(g.views[0].w, g.views[0].h, k);
    expect(box.w * k).toBeCloseTo(g.views[0].w, 6);
    expect(box.h * k).toBeCloseTo(g.views[0].h, 6);
    // the whole-screen HUD is designed for 1080 high: the box is shorter than that, so nothing of it is cut
    expect(box.h).toBeLessThan(760);
  });

  it('is bounded, and the columns follow their width', () => {
    expect(hudScale(100, 100, 'rows')).toBe(0.5);
    expect(hudScale(5000, 5000, 'rows')).toBe(0.9);
    expect(hudScale(958, 1080, 'columns')).toBeCloseTo(958 / 1280, 6);
    expect(hudScale(100, 1080, 'columns')).toBe(0.5);
    expect(hudScale(3000, 1080, 'columns')).toBe(0.9);
  });

  it('a zero scale does not divide by zero', () => {
    expect(hudBox(100, 50, 0)).toEqual({ w: 100, h: 50 });
  });
});

describe('playerSlots', () => {
  it('puts the two humans side by side: the two places of one row of the two-wide grid', () => {
    for (let total = 2; total <= 12; total++) {
      for (const start of ['pole', 'middle', 'back'] as const) {
        const [a, b] = playerSlots(total, start);
        expect(a % 2).toBe(0);
        expect(b).toBe(a + 1);
        expect(b).toBeLessThan(total);
      }
    }
  });

  it('pole is the front row, back the last row that has two places, middle the one between', () => {
    expect(playerSlots(12, 'pole')).toEqual([0, 1]);
    expect(playerSlots(12, 'back')).toEqual([10, 11]);
    expect(playerSlots(12, 'middle')).toEqual([6, 7]);
    // an odd field: one opponent has the last row to himself, behind the two humans
    expect(playerSlots(9, 'back')).toEqual([6, 7]);
    expect(playerSlots(2, 'back')).toEqual([0, 1]);
    expect(playerSlots(2, 'middle')).toEqual([0, 1]);
  });

  it('is ordered: pole before middle before back', () => {
    for (let total = 4; total <= 12; total++) {
      const p = playerSlots(total, 'pole')[0];
      const m = playerSlots(total, 'middle')[0];
      const b = playerSlots(total, 'back')[0];
      expect(p).toBeLessThanOrEqual(m);
      expect(m).toBeLessThanOrEqual(b);
    }
  });
});

describe('opponents and colours', () => {
  it('two humans leave room for ten opponents on the twelve-place grid', () => {
    expect(opponentLimit(1)).toBe(MAX_OPPONENTS);
    expect(opponentLimit(2)).toBe(MAX_SPLIT_OPPONENTS);
    expect(MAX_SPLIT_OPPONENTS + 2).toBe(MAX_OPPONENTS + 1);
  });

  it('player 1 is the game\'s teal and player 2 its hot pink', () => {
    expect(SEAT_COLOR[0]).toBe('#16e0bd');
    expect(SEAT_COLOR[1]).toBe('#ff2e63');
  });
});

describe('splitGraphics', () => {
  it('only ever trims: it never raises a setting the player chose, and leaves what is not graphics alone', () => {
    for (const q of ['low', 'medium', 'high', 'ultra'] as const) {
      const g: GraphicsSettings = { ...DEFAULT_SETTINGS.graphics, quality: q };
      const s = splitGraphics(g);
      expect(s.renderScale).toBeLessThanOrEqual(g.renderScale);
      expect(s.vegetation).toBeLessThanOrEqual(g.vegetation);
      expect(s.maxFps).toBe(g.maxFps);
      expect(s.quality).toBe(g.quality);
      if (!g.ambientOcclusion) expect(s.ambientOcclusion).toBe(false);
      if (!g.bloom) expect(s.bloom).toBe(false);
      if (g.shadows === 'off') expect(s.shadows).toBe('off');
    }
  });

  it('runs the supersampling of Ultra at the screen\'s own resolution, and leaves the other presets as they are', () => {
    const ultra: GraphicsSettings = { ...DEFAULT_SETTINGS.graphics, quality: 'ultra', renderScale: 1.25 };
    expect(splitGraphics(ultra).renderScale).toBe(1);
    expect(splitGraphics(ultra)).toEqual({ ...ultra, renderScale: 1 });
    for (const q of ['low', 'medium', 'high'] as const) {
      const g: GraphicsSettings = { ...DEFAULT_SETTINGS.graphics, quality: q };
      expect(splitGraphics(g)).toEqual(g);
    }
    // a player who set the scale below 1 keeps it
    expect(splitGraphics({ ...DEFAULT_SETTINGS.graphics, renderScale: 0.75 }).renderScale).toBe(0.75);
  });

  it('does not change what it is given', () => {
    const g: GraphicsSettings = { ...DEFAULT_SETTINGS.graphics, renderScale: 1.25 };
    const copy = { ...g };
    splitGraphics(g);
    expect(g).toEqual(copy);
  });
});

describe('opponent liveries in a split screen', () => {
  const def = CARS[0] as CarDefinition;
  const mine = (primary: string): Livery => ({ ...def.defaultLivery, primary });

  it('avoid the colour of each human, not only the first', () => {
    for (let i = 0; i < 14; i++) {
      const a = opponentLivery(i, def, [mine('#c8102e'), mine('#0a3d91')]);
      expect(a.primary.toLowerCase()).not.toBe('#c8102e');
      expect(a.primary.toLowerCase()).not.toBe('#0a3d91');
    }
  });

  it('are what they were for one human: a single livery or none gives the same answer as a list of it', () => {
    for (let i = 0; i < 14; i++) {
      const one = opponentLivery(i, def, mine('#c8102e'));
      const list = opponentLivery(i, def, [mine('#c8102e')]);
      expect(list).toEqual(one);
      expect(one.primary.toLowerCase()).not.toBe('#c8102e');
      expect(opponentLivery(i, def)).toEqual(opponentLivery(i, def, []));
    }
  });
});
