/**
 * Shared widgets: button glyphs, prompt bar, setting rows (slider / toggle / select / stepper / text),
 * tabs, stat bars, pips and a confirm dialog. DOM only; the logic they drive lives in model.ts / nav.ts.
 */
import { h, svg, clearEl, throttle, type Child } from './dom';
import { MENU_KEYS, type MenuAction, type PadControl } from '../input/bindings';
import type { Device, UiCtx } from './ctx';
import { snap, type FocusRow, type Nav } from './nav';
import type { StatBar } from './model';

// ─────────────────────────────────────────────────────────────────────────────
// Glyphs
// ─────────────────────────────────────────────────────────────────────────────

export function chevron(dir: 'l' | 'r'): SVGElement {
  return svg(
    'svg',
    { class: `chev ${dir}`, viewBox: '0 0 22 30' },
    svg('path', { d: dir === 'l' ? 'M17 3 L5 15 L17 27' : 'M5 3 L17 15 L5 27', fill: 'none', stroke: 'currentColor', 'stroke-width': 4.5, 'stroke-linecap': 'square' }),
  );
}

type Dir = 'up' | 'down' | 'left' | 'right';

export function dpadGlyph(active: Dir[]): HTMLElement {
  const c = (d: Dir): string => (active.includes(d) ? '#16e0bd' : '#4b5266');
  return h(
    'span',
    'gl gl-dpad',
    svg(
      'svg',
      { viewBox: '0 0 38 38' },
      svg('rect', { x: 13, y: 13, width: 12, height: 12, fill: '#4b5266' }),
      svg('path', { d: 'M13 2h12v11H13z', fill: c('up') }),
      svg('path', { d: 'M13 25h12v11H13z', fill: c('down') }),
      svg('path', { d: 'M2 13h11v12H2z', fill: c('left') }),
      svg('path', { d: 'M25 13h11v12H25z', fill: c('right') }),
    ),
  );
}

export function keyArrow(dir: Dir): HTMLElement {
  const rot = dir === 'up' ? 0 : dir === 'right' ? 90 : dir === 'down' ? 180 : 270;
  return h('span', 'key', svg('svg', { viewBox: '0 0 18 18' }, svg('path', { d: 'M9 4 L15.5 13.5 H2.5 Z', fill: 'currentColor', transform: `rotate(${rot} 9 9)` })));
}

export function padGlyph(c: PadControl): HTMLElement {
  switch (c) {
    case 'a': case 'b': case 'x': case 'y': return h('span', `gl gl-${c}`, c.toUpperCase());
    case 'lb': case 'rb': case 'lt': case 'rt': return h('span', 'gl gl-bumper', c.toUpperCase());
    case 'start': return h('span', 'gl gl-pill', 'START');
    case 'back': return h('span', 'gl gl-pill', 'BACK');
    case 'dUp': return dpadGlyph(['up']);
    case 'dDown': return dpadGlyph(['down']);
    case 'dLeft': return dpadGlyph(['left']);
    case 'dRight': return dpadGlyph(['right']);
    case 'ls': return h('span', 'gl', 'LS');
    case 'rs': return h('span', 'gl', 'RS');
    case 'lsClick': return h('span', 'gl', 'L3');
    case 'rsClick': return h('span', 'gl', 'R3');
  }
}

export function keyGlyph(k: string): HTMLElement {
  if (k === 'Up' || k === 'Down' || k === 'Left' || k === 'Right') return keyArrow(k.toLowerCase() as Dir);
  return h('span', 'key', k);
}

/** The glyph(s) for a menu action on the given device. */
export function glyphsFor(action: MenuAction, device: Device): HTMLElement {
  const wrap = h('span', 'gls');
  if (device === 'gamepad') {
    if (action === 'navigate') wrap.appendChild(dpadGlyph(['up', 'down']));
    else if (action === 'adjust') wrap.appendChild(dpadGlyph(['left', 'right']));
    else for (const c of MENU_KEYS[action].pad) wrap.appendChild(padGlyph(c));
  } else {
    for (const k of MENU_KEYS[action].keys) wrap.appendChild(keyGlyph(k));
  }
  return wrap;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt bar
// ─────────────────────────────────────────────────────────────────────────────

export interface Prompt {
  action: MenuAction;
  label: string;
}

export class PromptBar {
  readonly el: HTMLElement;
  private items: Prompt[] = [];

  constructor(private readonly ctx: UiCtx, cls = 'prompts in') {
    this.el = h('div', { cls, style: { '--d': '500', '--tx': '0px', '--ty': '18px' } });
    ctx.onDevice(() => this.render());
  }

  set(items: Prompt[]): void {
    this.items = items;
    this.render();
  }

  render(): void {
    clearEl(this.el);
    for (const p of this.items) this.el.appendChild(h('div', 'prompt', glyphsFor(p.action, this.ctx.device), h('span', null, p.label)));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────

export interface RowHandle {
  el: HTMLElement;
  row: FocusRow;
  /** Re-read the value from its binding. */
  refresh(): void;
}

export interface RowOpts {
  /** Show the description permanently under the label. */
  showDesc?: boolean;
  /** Called after the value changed (by input or pointer). */
  onChange?: () => void;
  /** Pointer moved over the row: let the list focus it. */
  onHover?: () => void;
}

function shell(kind: string, label: string, desc: string | undefined, opts: RowOpts): { el: HTMLElement; ctl: HTMLElement; lab: HTMLElement } {
  const el = h('div', `row focusable kind-${kind}`);
  const lab = h('div', 'r-label', label);
  const ctl = h('div', 'r-ctl');
  el.append(lab, ctl);
  if (opts.showDesc && desc) el.appendChild(h('div', 'r-desc', desc));
  el.addEventListener('pointermove', (e) => {
    if ((e as PointerEvent).movementX !== 0 || (e as PointerEvent).movementY !== 0) opts.onHover?.();
  });
  return { el, ctl, lab };
}

function focusRow(el: HTMLElement, h: Partial<FocusRow>): FocusRow {
  return {
    setFocused: (on) => el.classList.toggle('is-focus', on),
    ...h,
  };
}

export interface SliderBinding {
  label: string;
  desc?: string;
  min: number;
  max: number;
  step: number;
  get(): number;
  set(v: number): void;
  fmt(v: number): string;
}

export function sliderRow(ctx: UiCtx, b: SliderBinding, opts: RowOpts = {}): RowHandle {
  const { el, ctl } = shell('slider', b.label, b.desc, opts);
  const fill = h('i', 'fill');
  const knob = h('i', 'knob');
  const slider = h('div', 'slider', h('div', 'trk', fill), knob);
  const val = h('span', 'r-val');
  ctl.append(chevron('l'), slider, val, chevron('r'));
  const tick = throttle(() => ctx.sound('move'), 70);

  const refresh = (): void => {
    const v = b.get();
    const p = (v - b.min) / (b.max - b.min);
    fill.style.transform = `scaleX(${p})`;
    knob.style.left = p * 100 + '%';
    val.textContent = b.fmt(v);
  };
  const apply = (raw: number): boolean => {
    const v = snap(raw, b.min, b.max, b.step);
    if (v === b.get()) return false;
    b.set(v);
    refresh();
    opts.onChange?.();
    return true;
  };
  const fromPointer = (e: PointerEvent): void => {
    const r = slider.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (apply(b.min + t * (b.max - b.min))) tick();
  };
  slider.addEventListener('pointerdown', (e) => {
    slider.setPointerCapture(e.pointerId);
    fromPointer(e);
  });
  slider.addEventListener('pointermove', (e) => {
    if (slider.hasPointerCapture(e.pointerId)) fromPointer(e);
  });
  ctl.querySelector('.chev.l')?.addEventListener('click', () => apply(b.get() - b.step) && ctx.sound('move'));
  ctl.querySelector('.chev.r')?.addEventListener('click', () => apply(b.get() + b.step) && ctx.sound('move'));
  refresh();
  return {
    el,
    refresh,
    row: focusRow(el, {
      left: () => apply(b.get() - b.step),
      right: () => apply(b.get() + b.step),
    }),
  };
}

export interface ToggleBinding {
  label: string;
  desc?: string;
  get(): boolean;
  set(v: boolean): void;
}

export function toggleRow(ctx: UiCtx, b: ToggleBinding, opts: RowOpts = {}): RowHandle {
  const { el, ctl } = shell('toggle', b.label, b.desc, opts);
  const tk = h('div', 'tk');
  const tg = h('div', 'toggle', tk);
  ctl.appendChild(tg);
  const refresh = (): void => {
    const on = b.get();
    tg.classList.toggle('on', on);
    tk.textContent = on ? 'ON' : 'OFF';
  };
  const apply = (v: boolean): boolean => {
    if (v === b.get()) return false;
    b.set(v);
    refresh();
    opts.onChange?.();
    return true;
  };
  tg.addEventListener('click', () => {
    apply(!b.get());
    ctx.sound('select');
  });
  refresh();
  return { el, refresh, row: focusRow(el, { left: () => apply(false), right: () => apply(true), activate: () => (apply(!b.get()), true) }) };
}

export interface SelectBinding {
  label: string;
  desc?: string;
  options: { value: string; label: string }[];
  get(): string;
  set(v: string): void;
  /** Label override, e.g. "Custom". */
  display?(): string;
  wrap?: boolean;
  /** Render as a segmented control when there are at most this many options (default 4). */
  segmentedMax?: number;
  /** An option that cannot be picked right now (the answer can change: refresh() asks again) is left out of the row and skipped. */
  enabled?(value: string): boolean;
}

export function selectRow(ctx: UiCtx, b: SelectBinding, opts: RowOpts = {}): RowHandle {
  const { el, ctl } = shell('select', b.label, b.desc, opts);
  const segmented = b.options.length <= (b.segmentedMax ?? 4);
  const idx = (): number => Math.max(0, b.options.findIndex((o) => o.value === b.get()));
  const on = (i: number): boolean => !b.enabled || b.enabled(b.options[i].value);
  /** The index of the next option that can be picked from the current one in `dir` (the current one when there is none). */
  const nextOn = (dir: 1 | -1): number => {
    const n = b.options.length;
    const cur = idx();
    for (let k = 1; k < n; k++) {
      const j = b.wrap ? (((cur + dir * k) % n) + n) % n : cur + dir * k;
      if (j < 0 || j >= n) break;
      if (on(j)) return j;
    }
    return cur;
  };
  const apply = (i: number): boolean => {
    const n = b.options.length;
    const j = Math.min(n - 1, Math.max(0, i));
    const next = b.wrap ? ((i % n) + n) % n : j;
    if (b.options[next].value === b.get()) return false;
    b.set(b.options[next].value);
    refresh();
    opts.onChange?.();
    return true;
  };
  let refresh: () => void;
  if (segmented) {
    const note = h('span', 'chip pink');
    const seg = h('div', 'seg');
    const optEls = b.options.map((o, i) => {
      const e = h('div', 'opt', o.label);
      e.addEventListener('click', () => {
        if (apply(i)) ctx.sound('select');
      });
      seg.appendChild(e);
      return e;
    });
    ctl.append(note, seg);
    refresh = (): void => {
      const cur = idx();
      const shown = b.display?.();
      const custom = shown !== undefined && shown.toLowerCase() !== b.options[cur].label.toLowerCase();
      optEls.forEach((e, i) => {
        e.classList.toggle('on', !custom && i === cur);
        e.style.display = on(i) ? '' : 'none';
      });
      note.textContent = custom ? shown : '';
      note.style.display = custom ? '' : 'none';
    };
  } else {
    const val = h('span', 'sel-val');
    const l = chevron('l');
    const r = chevron('r');
    l.addEventListener('click', () => apply(b.enabled ? nextOn(-1) : idx() - 1) && ctx.sound('move'));
    r.addEventListener('click', () => apply(b.enabled ? nextOn(1) : idx() + 1) && ctx.sound('move'));
    ctl.append(l, val, r);
    refresh = (): void => {
      val.textContent = b.display?.() ?? b.options[idx()].label;
    };
  }
  refresh();
  return {
    el,
    refresh,
    row: focusRow(el, {
      left: () => apply(b.enabled ? nextOn(-1) : idx() - 1),
      right: () => apply(b.enabled ? nextOn(1) : idx() + 1),
      activate: () => (apply(b.enabled ? nextOn(1) : b.wrap || !segmented ? idx() + 1 : (idx() + 1) % b.options.length), true),
    }),
  };
}

export interface StepperBinding {
  label: string;
  desc?: string;
  min: number;
  max: number;
  step?: number;
  get(): number;
  set(v: number): void;
  fmt?(v: number): string;
}

export function stepperRow(ctx: UiCtx, b: StepperBinding, opts: RowOpts = {}): RowHandle {
  const { el, ctl } = shell('stepper', b.label, b.desc, opts);
  const step = b.step ?? 1;
  const val = h('span', 'r-val');
  const l = chevron('l');
  const r = chevron('r');
  ctl.append(l, val, r);
  const refresh = (): void => {
    val.textContent = b.fmt ? b.fmt(b.get()) : '' + b.get();
  };
  const apply = (raw: number): boolean => {
    const v = snap(raw, b.min, b.max, step);
    if (v === b.get()) return false;
    b.set(v);
    refresh();
    opts.onChange?.();
    return true;
  };
  l.addEventListener('click', () => apply(b.get() - step) && ctx.sound('move'));
  r.addEventListener('click', () => apply(b.get() + step) && ctx.sound('move'));
  refresh();
  return { el, refresh, row: focusRow(el, { left: () => apply(b.get() - step), right: () => apply(b.get() + step) }) };
}

export interface TextBinding {
  label: string;
  desc?: string;
  maxLength: number;
  get(): string;
  set(v: string): void;
}

/** A text row. Keyboard: edits inline. Gamepad: calls `osk` (the on-screen keyboard) if provided. */
export function textRow(ctx: UiCtx, b: TextBinding, opts: RowOpts & { osk?: (initial: string, max: number, done: (v: string | null) => void) => void } = {}): RowHandle {
  const { el, ctl } = shell('text', b.label, b.desc, opts);
  const val = h('span', 'txt-val');
  ctl.appendChild(val);
  const refresh = (): void => {
    val.textContent = b.get() || '—';
  };
  const commit = (v: string): void => {
    const t = v.trim().slice(0, b.maxLength);
    if (t && t !== b.get()) {
      b.set(t);
      opts.onChange?.();
    }
    refresh();
  };
  const edit = (): boolean => {
    if (ctx.device === 'gamepad' && opts.osk) {
      opts.osk(b.get(), b.maxLength, (v) => {
        if (v !== null) commit(v);
      });
      return true;
    }
    const input = h('input', { attrs: { type: 'text', maxlength: b.maxLength, spellcheck: 'false', autocomplete: 'off' } });
    input.value = b.get();
    clearEl(val);
    val.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      if (save) commit(input.value);
      else refresh();
      if (input.parentNode) clearEl(val);
      refresh();
      input.blur();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
        ctx.sound('select');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
        ctx.sound('back');
      }
    });
    input.addEventListener('blur', () => finish(true));
    return true;
  };
  el.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).tagName !== 'INPUT') edit();
  });
  refresh();
  return { el, refresh, row: focusRow(el, { activate: edit }) };
}

export interface ButtonBinding {
  label: string;
  desc?: string;
  danger?: boolean;
  /** Right-aligned hint text. */
  value?: () => string;
  run(): void;
}

/** A plain action row (e.g. "Reset this tab to defaults"). */
export function actionRow(ctx: UiCtx, b: ButtonBinding, opts: RowOpts = {}): RowHandle {
  const { el, ctl } = shell('action', b.label, b.desc, opts);
  if (b.danger) el.classList.add('danger');
  const val = h('span', 'r-val');
  ctl.appendChild(val);
  const refresh = (): void => {
    val.textContent = b.value ? b.value() : '';
  };
  el.addEventListener('click', () => {
    ctx.sound('select');
    b.run();
  });
  refresh();
  return { el, refresh, row: focusRow(el, { activate: () => (b.run(), true) }) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tabs
// ─────────────────────────────────────────────────────────────────────────────

export class TabBar {
  readonly el: HTMLElement;
  private readonly tabEls: HTMLElement[] = [];
  private readonly left: HTMLElement;
  private readonly right: HTMLElement;
  index = 0;

  constructor(
    private readonly ctx: UiCtx,
    tabs: { id: string; label: string }[],
    private readonly onSelect: (i: number) => void,
    opts: { glyphs?: boolean } = {},
  ) {
    this.el = h('div', 'tabs');
    this.left = h('span');
    this.right = h('span');
    if (opts.glyphs !== false) this.el.appendChild(this.left);
    tabs.forEach((t, i) => {
      const e = h('div', 'tab focusable', t.label);
      e.addEventListener('click', () => this.select(i));
      this.tabEls.push(e);
      this.el.appendChild(e);
    });
    if (opts.glyphs !== false) this.el.appendChild(this.right);
    this.renderGlyphs();
    ctx.onDevice(() => this.renderGlyphs());
    this.mark();
  }

  private renderGlyphs(): void {
    const dev = this.ctx.device;
    clearEl(this.left);
    clearEl(this.right);
    if (dev === 'gamepad') {
      this.left.appendChild(padGlyph('lb'));
      this.right.appendChild(padGlyph('rb'));
    } else {
      this.left.appendChild(keyGlyph('Q'));
      this.right.appendChild(keyGlyph('E'));
    }
    this.left.style.marginRight = '14px';
    this.right.style.marginLeft = '14px';
  }

  private mark(): void {
    this.tabEls.forEach((e, i) => e.classList.toggle('on', i === this.index));
  }

  select(i: number, silent = false): void {
    const n = this.tabEls.length;
    const j = Math.min(n - 1, Math.max(0, i));
    if (j === this.index) return;
    this.index = j;
    this.mark();
    if (!silent) this.ctx.sound('move');
    this.onSelect(j);
  }

  /** Apply tabLeft / tabRight edges. */
  handle(n: Nav): boolean {
    if (n.tabLeft && !n.tabRight) {
      const before = this.index;
      this.select(this.index - 1);
      return this.index !== before;
    }
    if (n.tabRight && !n.tabLeft) {
      const before = this.index;
      this.select(this.index + 1);
      return this.index !== before;
    }
    return false;
  }

  setIndex(i: number): void {
    this.index = Math.min(this.tabEls.length - 1, Math.max(0, i));
    this.mark();
  }

  /** Rename the tabs in place (the setup wizard calls its steps differently for a championship). */
  setLabels(labels: readonly string[]): void {
    labels.forEach((l, i) => {
      if (this.tabEls[i]) this.tabEls[i].textContent = l;
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stat bars, pips
// ─────────────────────────────────────────────────────────────────────────────

export class StatBars {
  readonly el: HTMLElement;
  private rows: { fill: HTMLElement; val: HTMLElement; wrap: HTMLElement; label: HTMLElement }[] = [];

  constructor() {
    this.el = h('div', 'stats');
  }

  set(bars: StatBar[]): void {
    if (this.rows.length !== bars.length) {
      clearEl(this.el);
      this.rows = bars.map(() => {
        const label = h('span', 's-l');
        const fill = h('i');
        const val = h('span', 's-v');
        const wrap = h('div', 'stat', label, h('div', 's-b', fill), val);
        this.el.appendChild(wrap);
        return { fill, val, wrap, label };
      });
    }
    bars.forEach((b, i) => {
      const r = this.rows[i];
      r.label.textContent = b.label;
      r.fill.style.transform = `scaleX(${b.value})`;
      r.val.textContent = b.text;
      r.wrap.classList.toggle('neutral', !!b.neutral);
    });
  }
}

export function pips(n: number, max = 5, hard = false): HTMLElement {
  const el = h('span', hard ? 'pips hard' : 'pips');
  for (let i = 0; i < max; i++) el.appendChild(h('i', i < n ? 'on' : null));
  return el;
}

// ─────────────────────────────────────────────────────────────────────────────
// Confirm dialog (two buttons, left/right + confirm/back)
// ─────────────────────────────────────────────────────────────────────────────

export class Dialog {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly text: HTMLElement;
  private readonly yes: HTMLElement;
  private readonly no: HTMLElement;
  private focus: 0 | 1 = 1;
  private onYes: (() => void) | null = null;
  private onNo: (() => void) | null = null;
  open = false;

  constructor(private readonly ctx: UiCtx) {
    this.title = h('h3');
    this.text = h('p');
    this.yes = h('div', 'btn danger focusable');
    this.no = h('div', 'btn focusable');
    this.el = h('div', 'modal', h('div', 'box panel chamfer edge', this.title, this.text, h('div', 'btns', this.no, this.yes)));
    this.yes.addEventListener('click', () => this.choose(0));
    this.no.addEventListener('click', () => this.choose(1));
    this.yes.addEventListener('pointermove', () => this.setFocus(0));
    this.no.addEventListener('pointermove', () => this.setFocus(1));
  }

  private setFocus(f: 0 | 1): void {
    if (f !== this.focus) {
      this.focus = f;
      this.ctx.sound('move');
    }
    this.yes.classList.toggle('is-focus', this.focus === 0);
    this.no.classList.toggle('is-focus', this.focus === 1);
  }

  show(o: { title: string; text: string; yes: string; no: string; onYes: () => void; onNo?: () => void }): void {
    this.title.textContent = o.title;
    this.text.textContent = o.text;
    this.yes.textContent = o.yes;
    this.no.textContent = o.no;
    this.onYes = o.onYes;
    this.onNo = o.onNo ?? null;
    this.focus = 1;
    this.yes.classList.remove('is-focus');
    this.no.classList.add('is-focus');
    this.open = true;
    this.el.classList.add('on');
    this.ctx.sound('select');
  }

  hide(): void {
    this.open = false;
    this.el.classList.remove('on');
  }

  private choose(which: 0 | 1): void {
    const fn = which === 0 ? this.onYes : this.onNo;
    this.hide();
    this.ctx.sound(which === 0 ? 'select' : 'back');
    fn?.();
  }

  /** Returns true (always consumes input while open). */
  handle(n: Nav): boolean {
    if (!this.open) return false;
    if (n.left || n.right) this.setFocus(this.focus === 0 ? 1 : 0);
    else if (n.confirm) this.choose(this.focus);
    else if (n.back) this.choose(1);
    return true;
  }
}

export type { Child };
