/**
 * Tiny DOM helpers (no framework). `h('div', 'cls', child, child...)` builds an element tree.
 */

export type Child = Node | string | number | false | null | undefined | readonly Child[];

export interface Spec {
  cls?: string;
  id?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string | number | boolean>;
  style?: Record<string, string>;
  data?: Record<string, string>;
  on?: Record<string, (e: Event & any) => void>;
}

function append(parent: Node, kids: readonly Child[]): void {
  for (const k of kids) {
    if (k === false || k === null || k === undefined) continue;
    if (Array.isArray(k)) append(parent, k as readonly Child[]);
    else if (typeof k === 'string' || typeof k === 'number') parent.appendChild(document.createTextNode(String(k)));
    else parent.appendChild(k as Node);
  }
}

function apply(el: Element, spec: string | Spec | null | undefined): void {
  if (!spec) return;
  if (typeof spec === 'string') {
    el.setAttribute('class', spec);
    return;
  }
  if (spec.cls) el.setAttribute('class', spec.cls);
  if (spec.id) el.id = spec.id;
  if (spec.title) el.setAttribute('title', spec.title);
  if (spec.attrs) for (const [k, v] of Object.entries(spec.attrs)) el.setAttribute(k, String(v));
  if (spec.style) for (const [k, v] of Object.entries(spec.style)) (el as HTMLElement).style.setProperty(k, v);
  if (spec.data) for (const [k, v] of Object.entries(spec.data)) (el as HTMLElement).dataset[k] = v;
  if (spec.on) for (const [k, fn] of Object.entries(spec.on)) el.addEventListener(k, fn);
  if (spec.text !== undefined) el.textContent = spec.text;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, spec?: string | Spec | null, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  apply(el, spec);
  append(el, kids);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Record<string, string | number> | null, ...kids: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  append(el, kids);
  return el;
}

/** Parse an SVG markup string into an element (for static icons). */
export function svgFrom(markup: string): SVGElement {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as SVGElement;
}

export function clearEl(el: Node): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function setClass(el: Element, cls: string, on: boolean): void {
  el.classList.toggle(cls, on);
}

/** A text node that only touches the DOM when the string changes (HUD hot path). */
export class Txt {
  readonly node: Text;
  private v: string;

  constructor(parent?: Node, initial = '') {
    this.node = document.createTextNode(initial);
    this.v = initial;
    parent?.appendChild(this.node);
  }

  set(s: string): void {
    if (s !== this.v) {
      this.v = s;
      this.node.data = s;
    }
  }

  get value(): string {
    return this.v;
  }
}

/** Remembers the last class name set on an element; writes only on change. */
export class ClassSlot {
  private v = '';
  constructor(private readonly el: Element) {}
  set(cls: string): void {
    if (cls !== this.v) {
      this.v = cls;
      this.el.setAttribute('class', cls);
    }
  }
}

/** Remembers the last value of one style property; writes only on change. */
export class StyleSlot {
  private v = '';
  constructor(
    private readonly el: HTMLElement,
    private readonly prop: string,
  ) {}
  set(v: string): void {
    if (v !== this.v) {
      this.v = v;
      this.el.style.setProperty(this.prop, v);
    }
  }
}

/** `transform: scaleX(v)` / `scaleY(v)` on a bar, written only when the quantized value changes. */
export class Bar {
  private v = -1;
  constructor(
    private readonly el: HTMLElement,
    private readonly axis: 'X' | 'Y' = 'X',
    private readonly quant = 0.004,
  ) {}
  set(v: number): void {
    const c = v < 0 ? 0 : v > 1 ? 1 : v;
    if (this.v < 0 || Math.abs(c - this.v) >= this.quant || c === 0 || c === 1) {
      if (c === this.v) return;
      this.v = c;
      this.el.style.transform = this.axis === 'X' ? `scaleX(${c})` : `scaleY(${c})`;
    }
  }
}

/** Debounced "play this at most every N ms". */
export function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let last = 0;
  return (...a: A) => {
    const now = performance.now();
    if (now - last >= ms) {
      last = now;
      fn(...a);
    }
  };
}
