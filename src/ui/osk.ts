/**
 * On-screen keyboard for text entry with a gamepad (the driver name). D-pad / stick moves, A types,
 * LB deletes, RB inserts a space, Start accepts, B cancels.
 */
import type { InputFrame } from '../core/contracts';
import type { UiCtx } from './ctx';
import { clearEl, h } from './dom';

type KeyKind = 'char' | 'caps' | 'del' | 'space' | 'cancel' | 'ok';
interface Key {
  kind: KeyKind;
  ch?: string;
  col: number;
  span: number;
  el?: HTMLElement;
}

const ROWS: string[] = ['ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZ-_.\'', '0123456789'];

/** Index of the key in `row` covering column `col` (keys are sorted by col). */
export function keyAtColumn(row: readonly { col: number; span: number }[], col: number): number {
  for (let i = 0; i < row.length; i++) if (col >= row[i].col && col < row[i].col + row[i].span) return i;
  return row.length - 1;
}

/** Applies auto-capitalisation: the first letter of the text and of each word is upper case. */
export function autoCase(prev: string, ch: string, caps: boolean): string {
  if (!/[a-z]/i.test(ch)) return ch;
  const atWordStart = prev.length === 0 || /[\s\-_.]$/.test(prev);
  return caps || atWordStart ? ch.toUpperCase() : ch.toLowerCase();
}

export class Osk {
  readonly el: HTMLElement;
  open = false;
  private readonly keys: Key[][] = [];
  private readonly display = h('div', 'osk-value');
  private readonly title = h('h3');
  private r = 0;
  private c = 0;
  private value = '';
  private max = 16;
  private caps = false;
  private done: ((v: string | null) => void) | null = null;

  constructor(private readonly ctx: UiCtx) {
    const grid = h('div', 'osk-grid');
    ROWS.forEach((chars, ri) => {
      const row: Key[] = [];
      [...chars].forEach((ch, ci) => {
        const k: Key = { kind: 'char', ch, col: ci, span: 1 };
        k.el = h('div', 'osk-key', ch);
        k.el.style.gridColumn = `${ci + 1} / span 1`;
        k.el.style.gridRow = String(ri + 1);
        k.el.addEventListener('click', () => this.press(ri, ci));
        grid.appendChild(k.el);
        row.push(k);
      });
      this.keys.push(row);
    });
    const actions: [KeyKind, string, number][] = [['caps', 'Caps', 2], ['del', 'Delete', 2], ['space', 'Space', 2], ['cancel', 'Cancel', 2], ['ok', 'OK', 2]];
    const arow: Key[] = [];
    let col = 0;
    for (const [kind, label, span] of actions) {
      const k: Key = { kind, col, span };
      k.el = h('div', `osk-key act ${kind}`, label);
      k.el.style.gridColumn = `${col + 1} / span ${span}`;
      k.el.style.gridRow = String(ROWS.length + 1);
      const ri = ROWS.length;
      const idx = arow.length;
      k.el.addEventListener('click', () => this.press(ri, idx));
      grid.appendChild(k.el);
      arow.push(k);
      col += span;
    }
    this.keys.push(arow);
    this.el = h('div', 'modal osk', h('div', 'box panel chamfer edge', this.title, this.display, grid, h('div', 'osk-hint', 'Move with the D-pad. A types, LB deletes, RB adds a space, Start accepts, B cancels.')));
  }

  show(title: string, initial: string, max: number, done: (v: string | null) => void): void {
    this.title.textContent = title;
    this.value = initial;
    this.max = max;
    this.caps = false;
    this.done = done;
    this.r = 0;
    this.c = 0;
    this.open = true;
    this.el.classList.add('on');
    this.render();
    this.ctx.sound('select');
  }

  /** Closes it without an answer (the screen it is on is going). */
  hide(): void {
    this.open = false;
    this.done = null;
    this.el.classList.remove('on');
  }

  private close(result: string | null): void {
    const cb = this.done;
    this.open = false;
    this.done = null;
    this.el.classList.remove('on');
    cb?.(result);
  }

  private render(): void {
    clearEl(this.display);
    this.display.append(h('span', null, this.value || ''), h('span', 'caret'));
    this.keys.forEach((row, ri) =>
      row.forEach((k, ci) => {
        k.el!.classList.toggle('is-focus', ri === this.r && ci === this.focusIndex());
        if (k.kind === 'caps') k.el!.classList.toggle('on', this.caps);
      }),
    );
  }

  /** The focused key index inside the focused row, derived from the remembered column. */
  private focusIndex(): number {
    return keyAtColumn(this.keys[this.r], this.c);
  }

  private move(dr: number, dc: number): void {
    if (dr !== 0) this.r = (this.r + dr + this.keys.length) % this.keys.length;
    if (dc !== 0) {
      const row = this.keys[this.r];
      const i = this.focusIndex();
      const j = (i + dc + row.length) % row.length;
      this.c = row[j].col;
    }
    this.ctx.sound('move');
    this.render();
  }

  private press(ri: number, ci: number): void {
    const k = this.keys[ri][ci];
    this.r = ri;
    this.c = k.col;
    switch (k.kind) {
      case 'char':
        if (this.value.length < this.max) {
          this.value += autoCase(this.value, k.ch!, this.caps);
          this.ctx.sound('select');
        } else this.ctx.sound('error');
        break;
      case 'caps':
        this.caps = !this.caps;
        this.ctx.sound('select');
        break;
      case 'del':
        this.value = this.value.slice(0, -1);
        this.ctx.sound('back');
        break;
      case 'space':
        if (this.value.length < this.max && this.value.length > 0 && !this.value.endsWith(' ')) this.value += ' ';
        this.ctx.sound('select');
        break;
      case 'cancel':
        this.ctx.sound('back');
        this.close(null);
        return;
      case 'ok':
        this.ctx.sound('select');
        this.close(this.value.trim());
        return;
    }
    this.render();
  }

  /** Consumes every frame while open. */
  handle(f: InputFrame): boolean {
    if (!this.open) return false;
    const n = f.nav;
    if (f.pause) {
      this.ctx.sound('select');
      this.close(this.value.trim());
      return true;
    }
    if (n.back) {
      this.ctx.sound('back');
      this.close(null);
      return true;
    }
    if (n.tabLeft) {
      this.value = this.value.slice(0, -1);
      this.ctx.sound('back');
      this.render();
      return true;
    }
    if (n.tabRight) {
      if (this.value.length < this.max && this.value.length > 0 && !this.value.endsWith(' ')) this.value += ' ';
      this.ctx.sound('select');
      this.render();
      return true;
    }
    if (n.up && !n.down) this.move(-1, 0);
    else if (n.down && !n.up) this.move(1, 0);
    else if (n.left && !n.right) this.move(0, -1);
    else if (n.right && !n.left) this.move(0, 1);
    else if (n.confirm) this.press(this.r, this.focusIndex());
    return true;
  }
}
