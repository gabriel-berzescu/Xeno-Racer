/**
 * Split screen, the parts that need no DOM and no WebGL (owner: game). The render system (the two viewports and the lens of each
 * view), the UI (the HUD of each pane, the divider) and the game (who starts where) all work from the same numbers, so they are
 * here, and tests/split.test.ts holds them to what they promise.
 *
 * Two players, one canvas: the screen is cut into two views of the same size with a thin gap between them (the divider is drawn in
 * the gap). 'rows' is the default: two wide views, one above the other (each 1920x538 at 1080p); 'columns' puts them side by side.
 * All rectangles are in CSS pixels with the origin at the top left, the way the DOM has them.
 */
import type { GraphicsSettings, SplitLayout } from './contracts';

/** CSS pixels between the two views (the divider line lives in it). */
export const SPLIT_GAP = 4;

/** The colour of each seat: the tower row, the minimap marker, the name on the results. Player 1 is the game's teal. */
export const SEAT_COLOR: readonly [string, string] = ['#16e0bd', '#ff2e63'];

/** Opponents a race can have beside the one human, and beside two (the grid has twelve places). */
export const MAX_OPPONENTS = 11;
export const MAX_SPLIT_OPPONENTS = 10;
export const opponentLimit = (players: 1 | 2): number => (players === 2 ? MAX_SPLIT_OPPONENTS : MAX_OPPONENTS);

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SplitGeometry {
  layout: SplitLayout;
  /** The two views: seat 0 first (top, or left). Equal sizes. */
  views: readonly [Rect, Rect];
  /** The strip between them. */
  divider: Rect;
}

/** The two views of a canvas of this size (CSS px). */
export function splitGeometry(width: number, height: number, layout: SplitLayout): SplitGeometry {
  const w = Math.max(2, Math.floor(width));
  const h = Math.max(2, Math.floor(height));
  if (layout === 'columns') {
    const vw = Math.max(1, Math.floor((w - SPLIT_GAP) / 2));
    return {
      layout,
      views: [
        { x: 0, y: 0, w: vw, h },
        { x: w - vw, y: 0, w: vw, h },
      ],
      divider: { x: vw, y: 0, w: w - 2 * vw, h },
    };
  }
  const vh = Math.max(1, Math.floor((h - SPLIT_GAP) / 2));
  return {
    layout,
    views: [
      { x: 0, y: 0, w, h: vh },
      { x: 0, y: h - vh, w, h: vh },
    ],
    divider: { x: 0, y: vh, w, h: h - 2 * vh },
  };
}

/** The aspect ratio of one view. */
export const viewAspect = (r: Rect): number => r.w / Math.max(1, r.h);

const DEG = Math.PI / 180;
const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));

/**
 * The vertical field of view (deg) for a view of this aspect ratio, given the player's setting for a full screen (`fullAspect`, the
 * 16:9 the lens is tuned for). A wide, short view keeps its vertical angle only if the picture is stretched far too wide, and a
 * tall narrow one only if it is a keyhole, so the angle follows the shape in between: in the tangent of the half angle, to the
 * power 0.75 of the ratio of the aspects for a view wider than the screen (a 1920x538 view at 62 degrees: 39 vertical, 104
 * horizontal) and 0.5 for a narrower one (a 958x1080 view: 80 vertical, 75 horizontal). Used for the base of the lens only: the
 * camera rig still adds its own degrees on top for the interior view and for speed.
 */
export function splitFov(baseDeg: number, aspect: number, fullAspect = 16 / 9): number {
  if (!(aspect > 0) || !(baseDeg > 0)) return baseDeg;
  const k = aspect >= fullAspect ? 0.75 : 0.5;
  const t = Math.tan((baseDeg * DEG) / 2) * Math.pow(fullAspect / aspect, k);
  return clamp((2 * Math.atan(t)) / DEG, 20, 95);
}

/**
 * How big the HUD of one pane is drawn, as a share of the HUD at full screen. `paneW` and `paneH` are the pane in the units of the
 * UI stage (a 1080-high stage: CSS pixels divided by the stage scale). The full-screen HUD is designed for 1080 high, so a
 * 538-high pane gets about 0.75: legible on a television, and it leaves the middle of the view free. Wide short panes are limited by
 * their height, tall narrow ones by their width.
 */
export function hudScale(paneW: number, paneH: number, layout: SplitLayout): number {
  return layout === 'columns' ? clamp(paneW / 1280, 0.5, 0.9) : clamp(paneH / 720, 0.5, 0.9);
}

/** The size, in HUD units, of the box the HUD of a pane is laid out in before it is scaled by `hudScale` (the pane divided by the scale). */
export function hudBox(paneW: number, paneH: number, scale: number): { w: number; h: number } {
  const s = scale > 0 ? scale : 1;
  return { w: paneW / s, h: paneH / s };
}

/**
 * Where the two humans start. The grid is two cars wide, so they take the two places of one row, side by side: slot indexes of the
 * grid, pole first, `total` cars in the race (the two humans included). `back` is the last row that has two places, `pole` the front
 * row, `middle` the row in between. The first slot is the left car of the row.
 */
export function playerSlots(total: number, start: 'back' | 'middle' | 'pole'): [number, number] {
  const n = Math.max(2, Math.floor(total));
  const rows = Math.floor(n / 2); // rows that have two places
  const row = start === 'pole' ? 0 : start === 'back' ? rows - 1 : Math.floor(rows / 2);
  return [row * 2, row * 2 + 1];
}

/**
 * Settings the graphics are run with while the screen is split: each half costs about what the whole screen did (the scene, the
 * sun's shadows and the post chain are drawn once per view), so what goes past the screen's own pixels is not paid twice: the
 * Ultra preset's 1.25 supersampling is run at 1.0 (RTX 3050 laptop, 1080p, two views: Ultra at 1.25 takes longer than a 60 Hz frame,
 * 16.7 ms, on the GPU in 1.5 % of frames; at 1.0 in 0.35 %; High in 0.04 %). The saved settings are not touched (the menus show the
 * player's own choice); the render system applies this on top while two views are up.
 */
export function splitGraphics(g: GraphicsSettings): GraphicsSettings {
  return g.renderScale > 1 ? { ...g, renderScale: 1 } : g;
}
