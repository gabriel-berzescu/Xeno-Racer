/**
 * Standings tower: the leader plus the cars around the player, with gaps. Fixed pool of rows; each
 * row's DOM is touched only when one of its fields changes (no per-frame allocation).
 *
 * Split screen: each view has its own tower (setSeat), five rows tall, with both humans always in it (hudlogic
 * pickSplitTowerIndices): the viewer's own row is the full row in the viewer's colour, the other human's row is lit in theirs
 * with a "P1" / "P2" tag, so neither can be mistaken for an opponent.
 */
import type { HudState, Seat } from '../../core/contracts';
import { ClassSlot, h, StyleSlot, Txt } from '../dom';
import { pickSplitTowerIndices, ROW_ME, ROW_OTHER, towerRowKind, type RowKind } from '../hudlogic';

const ROWS = 8;
/** Rows a short split-screen pane has room for. */
export const SPLIT_ROWS = 5;

interface Row {
  el: HTMLElement;
  cls: ClassSlot;
  pos: Txt;
  name: Txt;
  gap: Txt;
  tag: Txt;
  chip: StyleSlot;
  shown: boolean;
  p: number;
  n: string;
  g: string;
  c: string;
  kind: RowKind;
  /** The other human's seat (for the colour of their row), -1 for any other row. */
  os: number;
  skip: boolean;
}

export class Tower {
  readonly el: HTMLElement;
  private readonly rows: Row[] = [];
  private readonly idx = new Int16Array(ROWS);
  private readonly gap = new Uint8Array(ROWS);
  private visible = true;
  /** Split screen: whose view this tower is in (null: the one tower of a single-player race), and how many rows it shows. */
  private seat: Seat | null = null;
  private max = ROWS;

  constructor(parent: HTMLElement) {
    this.el = h('div', 'hud-tower');
    for (let i = 0; i < ROWS; i++) {
      const pos = h('span', 'tw-pos');
      const chipEl = h('i', 'tw-chip');
      const tag = h('span', 'tw-tag');
      const name = h('span', 'tw-name');
      const gap = h('span', 'tw-gap');
      const el = h('div', 'tw-row', pos, chipEl, tag, name, gap);
      el.style.display = 'none';
      this.el.appendChild(el);
      this.rows.push({
        el, cls: new ClassSlot(el), pos: new Txt(pos), name: new Txt(name), gap: new Txt(gap), tag: new Txt(tag), chip: new StyleSlot(chipEl, 'background'),
        shown: false, p: -1, n: '', g: '', c: '', kind: 0, os: -1, skip: false,
      });
    }
    parent.appendChild(this.el);
  }

  /** The tower of seat `seat`'s view (null: back to the single-player tower). Every row is drawn afresh on the next update. */
  setSeat(seat: Seat | null): void {
    this.seat = seat;
    this.max = seat === null ? ROWS : SPLIT_ROWS;
    for (const r of this.rows) {
      r.p = -1;
      r.kind = 0;
      r.os = -1;
    }
  }

  update(s: HudState): void {
    const count = pickSplitTowerIndices(s.standings, this.max, this.seat, this.idx, this.gap);
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
      const kind = towerRowKind(st, this.seat);
      const os = kind === ROW_OTHER ? st.seat ?? 0 : -1;
      if (!r.shown) {
        r.shown = true;
        r.el.style.display = '';
      }
      if (st.position !== r.p || kind !== r.kind || os !== r.os || skip !== r.skip) {
        r.p = st.position;
        r.kind = kind;
        r.os = os;
        r.skip = skip;
        r.cls.set('tw-row' + (kind === ROW_ME ? ' me' : kind === ROW_OTHER ? ' other s' + os : '') + (st.position === 1 ? ' lead' : '') + (skip ? ' skip' : ''));
        r.pos.set(String(st.position));
        r.tag.set(kind === ROW_OTHER ? 'P' + (os + 1) : '');
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
