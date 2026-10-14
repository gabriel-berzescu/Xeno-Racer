/**
 * Standings tower: the leader plus the cars around the player, with gaps. Fixed pool of rows; each
 * row's DOM is touched only when one of its fields changes (no per-frame allocation).
 */
import type { HudState } from '../../core/contracts';
import { ClassSlot, h, StyleSlot, Txt } from '../dom';
import { pickTowerIndices } from '../hudlogic';

const ROWS = 8;

interface Row {
  el: HTMLElement;
  cls: ClassSlot;
  pos: Txt;
  name: Txt;
  gap: Txt;
  chip: StyleSlot;
  shown: boolean;
  p: number;
  n: string;
  g: string;
  c: string;
  me: boolean;
  skip: boolean;
}

export class Tower {
  readonly el: HTMLElement;
  private readonly rows: Row[] = [];
  private readonly idx = new Int16Array(ROWS);
  private readonly gap = new Uint8Array(ROWS);
  private visible = true;

  constructor(parent: HTMLElement) {
    this.el = h('div', 'hud-tower');
    for (let i = 0; i < ROWS; i++) {
      const pos = h('span', 'tw-pos');
      const chipEl = h('i', 'tw-chip');
      const name = h('span', 'tw-name');
      const gap = h('span', 'tw-gap');
      const el = h('div', 'tw-row', pos, chipEl, name, gap);
      el.style.display = 'none';
      this.el.appendChild(el);
      this.rows.push({ el, cls: new ClassSlot(el), pos: new Txt(pos), name: new Txt(name), gap: new Txt(gap), chip: new StyleSlot(chipEl, 'background'), shown: false, p: -1, n: '', g: '', c: '', me: false, skip: false });
    }
    parent.appendChild(this.el);
  }

  update(s: HudState): void {
    const count = pickTowerIndices(s.standings, ROWS, this.idx, this.gap);
    const vis = count > 0;
    if (vis !== this.visible) {
      this.visible = vis;
      this.el.style.display = vis ? '' : 'none';
    }
    for (let i = 0; i < ROWS; i++) {
      const r = this.rows[i];
      if (i >= count) {
        if (r.shown) {
          r.shown = false;
          r.el.style.display = 'none';
        }
        continue;
      }
      const st = s.standings[this.idx[i]];
      const skip = this.gap[i] === 1;
      if (!r.shown) {
        r.shown = true;
        r.el.style.display = '';
      }
      if (st.position !== r.p || st.isPlayer !== r.me || skip !== r.skip) {
        r.p = st.position;
        r.me = st.isPlayer;
        r.skip = skip;
        r.cls.set('tw-row' + (st.isPlayer ? ' me' : '') + (st.position === 1 ? ' lead' : '') + (skip ? ' skip' : ''));
        r.pos.set(String(st.position));
      }
      if (st.name !== r.n) {
        r.n = st.name;
        r.name.set(st.name);
      }
      if (st.gap !== r.g) {
        r.g = st.gap;
        r.gap.set(st.gap);
      }
      if (st.color !== r.c) {
        r.c = st.color;
        r.chip.set(st.color);
      }
    }
  }
}
