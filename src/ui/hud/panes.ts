/**
 * Split screen: where the two panes of the HUD go (pure, no DOM). The render system cuts the canvas into two views in CSS pixels
 * (core/split.ts splitGeometry); the UI works in stage units (the 1080-high stage is scaled by `s` onto the window), so each
 * view is divided by `s` to get the pane over it, and the HUD of the pane is drawn at `hudScale` of its design size in a box
 * of the pane's size divided by that scale.
 */
import type { SplitLayout } from '../../core/contracts';
import { hudBox, hudScale, SEAT_COLOR, splitGeometry, type Rect } from '../../core/split';

export interface Pane {
  /** The pane over a view, in stage units. */
  rect: Rect;
  /** The HUD's scale in it (1 = the full-screen HUD). */
  scale: number;
  /** The size of the box the HUD is laid out in before it is scaled: the pane divided by the scale. */
  box: { w: number; h: number };
}

export interface PaneLayout {
  layout: SplitLayout;
  /** Seat 0 first (top, or left). */
  panes: readonly [Pane, Pane];
  /** The strip between the views (the divider line is drawn in it), in stage units. */
  divider: Rect;
}

const toStage = (r: Rect, s: number): Rect => ({ x: r.x / s, y: r.y / s, w: r.w / s, h: r.h / s });

/**
 * The panes for a window of `cssW` x `cssH` CSS pixels whose stage is scaled by `s` (stage unit -> CSS pixel).
 */
export function paneLayout(cssW: number, cssH: number, s: number, layout: SplitLayout): PaneLayout {
  const k = s > 0 ? s : 1;
  const g = splitGeometry(cssW, cssH, layout);
  const make = (v: Rect): Pane => {
    const rect = toStage(v, k);
    const scale = hudScale(rect.w, rect.h, layout);
    return { rect, scale, box: hudBox(rect.w, rect.h, scale) };
  };
  return { layout, panes: [make(g.views[0]), make(g.views[1])], divider: toStage(g.divider, k) };
}

/**
 * The divider's background: a dark strip with a hairline of each seat's colour along the edge of its own view (seat 0's colour on the
 * top or left edge, seat 1's on the bottom or right). `gap` is the strip's thickness and `line` the hairline's, both in the units of
 * the element that carries the background (stage units).
 */
export function dividerBackground(layout: SplitLayout, gap: number, line = 1.5): string {
  const t = Math.min(line, Math.max(0, gap / 2 - 0.25));
  const dir = layout === 'columns' ? '90deg' : '180deg';
  const a = SEAT_COLOR[0];
  const b = SEAT_COLOR[1];
  const ink = '#05060a';
  return `linear-gradient(${dir}, ${a} 0, ${a} ${t}px, ${ink} ${t}px, ${ink} ${gap - t}px, ${b} ${gap - t}px, ${b} ${gap}px)`;
}
