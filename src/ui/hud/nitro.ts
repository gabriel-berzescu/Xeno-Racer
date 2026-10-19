/**
 * Nitro gauge (above the instrument cluster): a cell per shot of the lap, full while the shot is there, draining while it burns and
 * dark once spent. The whole gauge glows blue while a shot burns and flashes when a new lap fills it again. DOM writes only on change.
 */
import '../styles/nitro.css';
import type { HudState } from '../../core/contracts';
import { h } from '../dom';

/** Steps the draining cell is drawn in. */
const STEPS = 100;

export class NitroHud {
  readonly el: HTMLElement;
  private readonly row = h('div', 'nt-cells');
  private cells: { el: HTMLElement; fill: HTMLElement; state: number; q: number }[] = [];
  private max = -1;
  private charges = -1;
  private burning = false;
  private shown = false;

  constructor(parent: HTMLElement) {
    this.el = h('div', 'hud-nitro', h('span', 'nt-k', 'NITRO'), this.row);
    this.el.style.display = 'none';
    parent.appendChild(this.el);
  }

  update(s: HudState): void {
    const n = s.nitro;
    const show = !!n && n.max > 0;
    if (show !== this.shown) {
      this.shown = show;
      this.el.style.display = show ? '' : 'none';
    }
    if (!n || !show) return;
    if (n.max !== this.max) this.build(n.max);
    const burning = n.burn > 0;
    if (burning !== this.burning) {
      this.burning = burning;
      this.el.classList.toggle('on', burning);
    }
    // a new lap: the tank is full again
    if (this.charges >= 0 && n.charges > this.charges) {
      this.el.classList.remove('refill');
      void this.el.offsetWidth; // restart the animation
      this.el.classList.add('refill');
    }
    this.charges = n.charges;
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i];
      // 2 = full, 1 = burning, 0 = spent
      const state = i < n.charges ? 2 : i === n.charges && burning ? 1 : 0;
      const q = state === 2 ? STEPS : state === 1 ? Math.round(n.burn * STEPS) : 0;
      if (state !== c.state) {
        c.state = state;
        c.el.className = state === 2 ? 'nt-cell full' : state === 1 ? 'nt-cell burn' : 'nt-cell';
      }
      if (q !== c.q) {
        c.q = q;
        c.fill.style.transform = `scaleX(${(q / STEPS).toFixed(2)})`;
      }
    }
  }

  private build(max: number): void {
    this.max = max;
    this.row.textContent = '';
    this.cells = [];
    for (let i = 0; i < max; i++) {
      const fill = h('b');
      const el = h('i', 'nt-cell', fill);
      this.row.appendChild(el);
      this.cells.push({ el, fill, state: -1, q: -1 });
    }
  }
}
