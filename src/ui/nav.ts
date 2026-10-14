/**
 * Menu focus model (pure logic, no DOM): a vertical list of focusable rows driven by `InputFrame.nav`.
 * Screens give it rows that know how to draw their own focus state.
 */
import type { InputFrame } from '../core/contracts';

export type Nav = InputFrame['nav'];

export interface FocusRow {
  /** Draw / clear the focus visuals. */
  setFocused(on: boolean): void;
  isDisabled?(): boolean;
  /** Left / right: return true if the row changed something (so a tick sound plays). */
  left?(): boolean;
  right?(): boolean;
  /** Confirm. Return true if handled. */
  activate?(): boolean;
  /** Called when this row receives focus by navigation or pointer. */
  onFocus?(): void;
}

/** `blocked`: left/right on an adjustable row that is already at its limit. */
export type NavResult = 'none' | 'moved' | 'changed' | 'activated' | 'blocked';

export class FocusList {
  rows: FocusRow[] = [];
  index = -1;
  /** Wrap around at the ends (short menus). */
  wrap = false;

  constructor(wrap = false) {
    this.wrap = wrap;
  }

  setRows(rows: FocusRow[], start = 0): void {
    if (this.index >= 0 && this.rows[this.index]) this.rows[this.index].setFocused(false);
    this.rows = rows;
    this.index = -1;
    if (rows.length) {
      let i = Math.min(Math.max(start, 0), rows.length - 1);
      if (rows[i].isDisabled?.()) i = this.nextEnabled(i, 1) ?? this.nextEnabled(i, -1) ?? i;
      this.focus(i);
    }
  }

  current(): FocusRow | null {
    return this.index >= 0 ? this.rows[this.index] ?? null : null;
  }

  /** Focus row `i`. Returns true if the focus changed. */
  focus(i: number): boolean {
    if (i < 0 || i >= this.rows.length || i === this.index) return false;
    if (this.index >= 0 && this.rows[this.index]) this.rows[this.index].setFocused(false);
    this.index = i;
    const r = this.rows[i];
    r.setFocused(true);
    r.onFocus?.();
    return true;
  }

  private nextEnabled(from: number, dir: 1 | -1): number | null {
    const n = this.rows.length;
    if (n === 0) return null;
    let i = from;
    for (let step = 0; step < n; step++) {
      i += dir;
      if (i < 0 || i >= n) {
        if (!this.wrap) return null;
        i = (i + n) % n;
      }
      if (!this.rows[i].isDisabled?.()) return i;
    }
    return null;
  }

  move(dir: 1 | -1): boolean {
    if (this.index < 0) return this.rows.length ? this.focus(0) : false;
    const next = this.nextEnabled(this.index, dir);
    return next === null ? false : this.focus(next);
  }

  /** Feed one frame's nav edges. Up/down move; left/right adjust the row; confirm activates it. */
  handle(n: Nav): NavResult {
    if (this.rows.length === 0) return 'none';
    if (n.up && !n.down) return this.move(-1) ? 'moved' : 'none';
    if (n.down && !n.up) return this.move(1) ? 'moved' : 'none';
    const row = this.current();
    if (!row) return 'none';
    if (n.left && !n.right) return !row.left ? 'none' : row.left() ? 'changed' : 'blocked';
    if (n.right && !n.left) return !row.right ? 'none' : row.right() ? 'changed' : 'blocked';
    if (n.confirm) return row.activate?.() ? 'activated' : 'none';
    return 'none';
  }
}

/** Cycle through `count` options with left/right; returns the new index (clamped, or wrapped). */
export function stepIndex(i: number, dir: 1 | -1, count: number, wrap: boolean): number {
  if (count <= 0) return 0;
  const n = i + dir;
  if (wrap) return (n + count) % count;
  return Math.min(count - 1, Math.max(0, n));
}

/** Snap a value to a step grid inside [min, max] (avoids 0.30000000000000004 drift on sliders). */
export function snap(v: number, min: number, max: number, step: number): number {
  const c = Math.min(max, Math.max(min, v));
  const n = Math.round((c - min) / step);
  const r = min + n * step;
  const digits = Math.max(0, Math.ceil(-Math.log10(step)) + 1);
  return Math.min(max, Math.max(min, Number(r.toFixed(digits))));
}
