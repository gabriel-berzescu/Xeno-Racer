/**
 * The pure pieces of the split-screen HUD: which rows each view's tower shows, who is drawn last on the minimap, and where the
 * two panes (and the HUD scale in each) go for a window of any shape.
 */
import { describe, expect, it } from 'vitest';
import type { HudState, HudStanding, Seat, SplitLayout } from '../src/core/contracts';
import { SEAT_COLOR, SPLIT_GAP } from '../src/core/split';
import { dividerBackground, paneLayout } from '../src/ui/hud/panes';
import { isOwn, minimapOrder, pickSplitTowerIndices, pickTowerIndices, ROW_AI, ROW_ME, ROW_OTHER, seatColor, towerRowKind } from '../src/ui/hudlogic';

/** A field of `n` cars; the humans (1-based places) carry their seat. */
function field(n: number, p1: number, p2: number): HudStanding[] {
  const out: HudStanding[] = [];
  for (let p = 1; p <= n; p++) {
    const seat: Seat | undefined = p === p1 ? 0 : p === p2 ? 1 : undefined;
    out.push({ position: p, name: seat === undefined ? 'CAR' + p : seat === 0 ? 'ONE' : 'TWO', gap: p === 1 ? 'LEADER' : '+' + p, isPlayer: seat !== undefined, color: '#fff', ...(seat === undefined ? {} : { seat }) });
  }
  return out;
}

function pick(st: HudStanding[], max: number, seat: Seat | null): { idx: number[]; gap: number[] } {
  const idx = new Int16Array(max);
  const gap = new Uint8Array(max);
  const n = pickSplitTowerIndices(st, max, seat, idx, gap);
  return { idx: Array.from(idx.subarray(0, n)), gap: Array.from(gap.subarray(0, n)) };
}

describe('split tower rows', () => {
  it('shows everybody when they fit, in race order, with no separators', () => {
    const r = pick(field(4, 2, 3), 5, 0);
    expect(r.idx).toEqual([0, 1, 2, 3]);
    expect(r.gap).toEqual([0, 0, 0, 0]);
    expect(pick(field(5, 2, 5), 5, 1).idx).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps the leader, the viewer, the other human and the cars around the viewer, nearest first (the one ahead before the one behind)', () => {
    // twelve cars, the humans in 4th and 7th: player 1's tower
    const a = pick(field(12, 4, 7), 5, 0);
    expect(a.idx).toEqual([0, 2, 3, 4, 6]);
    expect(a.gap).toEqual([0, 1, 0, 0, 1]);
    // and player 2's: the same humans, the neighbours are now around 7th
    const b = pick(field(12, 4, 7), 5, 1);
    expect(b.idx).toEqual([0, 3, 5, 6, 7]);
    expect(b.gap).toEqual([0, 1, 1, 0, 0]);
  });

  it('puts both humans in whatever the order, even far apart or at the ends of the field', () => {
    for (const [p1, p2] of [[1, 12], [12, 1], [1, 2], [11, 12], [6, 7], [2, 12], [12, 5]] as const) {
      for (const seat of [0, 1] as const) {
        const st = field(12, p1, p2);
        const r = pick(st, 5, seat);
        expect(r.idx.length).toBe(5);
        expect(r.idx).toContain(p1 - 1);
        expect(r.idx).toContain(p2 - 1);
        expect(r.idx[0]).toBe(0);
        // ascending, unique, and a separator exactly where cars were skipped
        r.idx.forEach((v, k) => {
          if (k > 0) {
            expect(v).toBeGreaterThan(r.idx[k - 1]);
            expect(r.gap[k]).toBe(v > r.idx[k - 1] + 1 ? 1 : 0);
          }
        });
      }
    }
  });

  it('fills the rest of the rows around the viewer when the viewer leads', () => {
    expect(pick(field(12, 1, 12), 5, 0).idx).toEqual([0, 1, 2, 3, 11]);
    expect(pick(field(12, 12, 1), 5, 0).idx).toEqual([0, 8, 9, 10, 11]);
  });

  it('shrinks to the rows that exist, and honours a smaller maximum', () => {
    expect(pick(field(12, 4, 7), 3, 0).idx).toEqual([0, 3, 6]);
    expect(pick(field(12, 4, 7), 4, 0).idx).toEqual([0, 2, 3, 6]);
    expect(pick([], 5, 0).idx).toEqual([]);
    expect(pick(field(3, 1, 2), 0, 0).idx).toEqual([]);
  });

  it('is pickTowerIndices, unchanged, for a single-player race', () => {
    const lists = [field(12, 4, 99), field(12, 1, 99), field(12, 12, 99), field(5, 3, 99), field(30, 17, 99)].map((st) => st.map((s) => ({ ...s, seat: undefined })));
    for (const st of lists) {
      for (const max of [8, 5, 3]) {
        const ia = new Int16Array(max);
        const ga = new Uint8Array(max);
        const ib = new Int16Array(max);
        const gb = new Uint8Array(max);
        const na = pickSplitTowerIndices(st, max, null, ia, ga);
        const nb = pickTowerIndices(st, max, ib, gb);
        expect(na).toBe(nb);
        expect(Array.from(ia)).toEqual(Array.from(ib));
        expect(Array.from(ga)).toEqual(Array.from(gb));
      }
    }
  });

  it('takes a human without a seat as the viewer\'s own (nothing is lost when a caller leaves the field out)', () => {
    const st = field(12, 4, 99).map((s) => ({ ...s, seat: undefined }));
    expect(pick(st, 5, 1).idx).toEqual([0, 1, 2, 3, 4]);
  });

  it('classifies rows and cars: the opponent, the viewer\'s own and the other human', () => {
    const st = field(5, 2, 4);
    expect(st.map((s) => towerRowKind(s, 0))).toEqual([ROW_AI, ROW_ME, ROW_AI, ROW_OTHER, ROW_AI]);
    expect(st.map((s) => towerRowKind(s, 1))).toEqual([ROW_AI, ROW_OTHER, ROW_AI, ROW_ME, ROW_AI]);
    // one player: the human is "me", whatever seat it carries
    expect(st.map((s) => towerRowKind(s, null))).toEqual([ROW_AI, ROW_ME, ROW_AI, ROW_ME, ROW_AI]);
    expect(isOwn({ isPlayer: true }, 1)).toBe(true);
    expect(isOwn({ isPlayer: true, seat: 0 }, 1)).toBe(false);
    expect(isOwn({ isPlayer: false, seat: 1 }, 1)).toBe(false);
  });
});

describe('minimap order', () => {
  const cars = (spec: { isPlayer: boolean; seat?: Seat }[]): HudState['cars'] => spec.map((c, i) => ({ x: i, z: 0, heading: 0, color: '#fff', ...c }));

  it('draws the opponents first, then the other human, and the viewer\'s own car last, on top', () => {
    const c = cars([{ isPlayer: true, seat: 0 }, { isPlayer: false }, { isPlayer: true, seat: 1 }, { isPlayer: false }]);
    const out = new Int16Array(8);
    expect(minimapOrder(c, 0, out)).toBe(4);
    expect(Array.from(out.subarray(0, 4))).toEqual([1, 3, 2, 0]);
    expect(minimapOrder(c, 1, out)).toBe(4);
    expect(Array.from(out.subarray(0, 4))).toEqual([1, 3, 0, 2]);
  });

  it('is the old order for one player: opponents, then the player on top', () => {
    const c = cars([{ isPlayer: false }, { isPlayer: true }, { isPlayer: false }]);
    const out = new Int16Array(8);
    expect(minimapOrder(c, null, out)).toBe(3);
    expect(Array.from(out.subarray(0, 3))).toEqual([0, 2, 1]);
  });

  it('never writes past its buffer', () => {
    const c = cars(Array.from({ length: 10 }, (_, i) => ({ isPlayer: i === 9, seat: 0 as Seat })));
    const out = new Int16Array(4);
    expect(minimapOrder(c, 0, out)).toBeLessThanOrEqual(4);
  });
});

describe('seat colours', () => {
  it('player 1 is the game teal, player 2 hot pink', () => {
    expect(seatColor(0)).toBe('#16e0bd');
    expect(seatColor(1)).toBe('#ff2e63');
    expect(SEAT_COLOR).toEqual([seatColor(0), seatColor(1)]);
  });
});

/** The stage scale the UI uses for a window (src/ui/index.ts layout()). */
const stageScale = (w: number, h: number): number => Math.min(h / 1080, w / 1500);

describe('panes', () => {
  const sizes: [number, number][] = [[1920, 1080], [1600, 900], [1366, 768], [1280, 720], [1024, 768], [2560, 1440], [3440, 1440], [3840, 2160]];
  for (const layout of ['rows', 'columns'] as SplitLayout[]) {
    it(`${layout}: two equal panes inside the stage, the divider between them, nothing overlapping, at any window size`, () => {
      for (const [w, h] of sizes) {
        const s = stageScale(w, h);
        const sw = w / s;
        const sh = h / s;
        const pl = paneLayout(w, h, s, layout);
        const [a, b] = pl.panes.map((p) => p.rect);
        expect(pl.panes[0].rect.w).toBeCloseTo(pl.panes[1].rect.w, 6);
        expect(pl.panes[0].rect.h).toBeCloseTo(pl.panes[1].rect.h, 6);
        for (const r of [a, b, pl.divider]) {
          expect(r.x).toBeGreaterThanOrEqual(-1e-9);
          expect(r.y).toBeGreaterThanOrEqual(-1e-9);
          expect(r.x + r.w).toBeLessThanOrEqual(sw + 1e-6);
          expect(r.y + r.h).toBeLessThanOrEqual(sh + 1e-6);
        }
        if (layout === 'rows') {
          expect(a.y + a.h).toBeLessThanOrEqual(pl.divider.y + 1e-9);
          expect(pl.divider.y + pl.divider.h).toBeLessThanOrEqual(b.y + 1e-9);
          expect(a.w).toBeCloseTo(sw, 6);
          // the strip is the CSS-pixel gap (a pixel more when the height is odd), in stage units
          expect(pl.divider.h * s).toBeGreaterThanOrEqual(SPLIT_GAP - 1e-6);
          expect(pl.divider.h * s).toBeLessThan(SPLIT_GAP + 1.5);
        } else {
          expect(a.x + a.w).toBeLessThanOrEqual(pl.divider.x + 1e-9);
          expect(pl.divider.x + pl.divider.w).toBeLessThanOrEqual(b.x + 1e-9);
          expect(a.h).toBeCloseTo(sh, 6);
          expect(pl.divider.w * s).toBeGreaterThanOrEqual(SPLIT_GAP - 1e-6);
        }
        for (const p of pl.panes) {
          expect(p.scale).toBeGreaterThanOrEqual(0.5);
          expect(p.scale).toBeLessThanOrEqual(0.9);
          // the HUD box is the pane before the scale
          expect(p.box.w * p.scale).toBeCloseTo(p.rect.w, 6);
          expect(p.box.h * p.scale).toBeCloseTo(p.rect.h, 6);
        }
      }
    });
  }

  it('a 1080p screen: two 1920x538 views, the HUD at three quarters in a 2570x720 box', () => {
    const pl = paneLayout(1920, 1080, 1, 'rows');
    expect(pl.panes[0].rect).toEqual({ x: 0, y: 0, w: 1920, h: 538 });
    expect(pl.panes[1].rect).toEqual({ x: 0, y: 542, w: 1920, h: 538 });
    expect(pl.divider).toEqual({ x: 0, y: 538, w: 1920, h: 4 });
    expect(pl.panes[0].scale).toBeCloseTo(0.747, 3);
    expect(pl.panes[0].box.w).toBeCloseTo(2570, 0);
    expect(pl.panes[0].box.h).toBeCloseTo(720, 0);
  });

  it('a 900p window has the same panes in stage units (the stage is scaled to the window)', () => {
    const a = paneLayout(1920, 1080, 1, 'rows');
    const b = paneLayout(1600, 900, stageScale(1600, 900), 'rows');
    expect(b.panes[0].rect.w).toBeCloseTo(a.panes[0].rect.w, 6);
    expect(b.panes[0].rect.h).toBeCloseTo(a.panes[0].rect.h, 0);
    expect(b.panes[0].scale).toBeCloseTo(a.panes[0].scale, 2);
  });

  it('a 4:3 window: wide short panes, the HUD a little bigger than at 16:9', () => {
    const w = 1024;
    const h = 768;
    const s = stageScale(w, h);
    const pl = paneLayout(w, h, s, 'rows');
    expect(pl.panes[0].rect.w).toBeCloseTo(1500, 3);
    expect(pl.panes[0].rect.h).toBeCloseTo(559.5, 0);
    expect(pl.panes[0].scale).toBeGreaterThan(0.747);
    expect(pl.panes[0].box.h).toBeCloseTo(720, 0);
  });

  it('side by side: two tall panes, the scale set by their width', () => {
    const pl = paneLayout(1920, 1080, 1, 'columns');
    expect(pl.panes[0].rect).toEqual({ x: 0, y: 0, w: 958, h: 1080 });
    expect(pl.panes[1].rect).toEqual({ x: 962, y: 0, w: 958, h: 1080 });
    expect(pl.divider).toEqual({ x: 958, y: 0, w: 4, h: 1080 });
    expect(pl.panes[0].scale).toBeCloseTo(0.748, 3);
    expect(pl.panes[0].box.w).toBeCloseTo(1280, 0);
  });

  it('a bad stage scale falls back to 1 instead of dividing by zero', () => {
    const pl = paneLayout(1920, 1080, 0, 'rows');
    expect(Number.isFinite(pl.panes[0].rect.w)).toBe(true);
    expect(pl.panes[0].rect.w).toBe(1920);
  });
});

describe('divider', () => {
  it('lines each view\'s edge with its own seat colour, in the direction the views are stacked', () => {
    const rows = dividerBackground('rows', 4, 1.5);
    expect(rows).toContain('180deg');
    expect(rows.indexOf(SEAT_COLOR[0])).toBeLessThan(rows.indexOf(SEAT_COLOR[1]));
    const cols = dividerBackground('columns', 4, 1.5);
    expect(cols).toContain('90deg');
    expect(cols).toContain(SEAT_COLOR[0]);
    expect(cols).toContain(SEAT_COLOR[1]);
  });

  it('never makes a hairline thicker than half the strip', () => {
    const bg = dividerBackground('rows', 2, 5);
    // 2 px strip: each line at most 0.75 px (half minus a quarter), never the 5 px asked for
    expect(bg).not.toMatch(/\s5px/);
    expect(bg).toContain('0.75px');
  });
});
