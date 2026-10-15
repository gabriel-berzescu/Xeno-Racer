import type { ChampionshipRoundView, ChampionshipRow, ChampionshipView, InputFrame } from '../../core/contracts';
import type { ScreenId } from '../../core/systems';
import { conditionChips, moveBadge, positionCell, setPosition } from '../champ-widgets';
import type { UiCtx } from '../ctx';
import { clearEl, h } from '../dom';
import { DIFFICULTY_LABEL, formatPointsGap, GRID_LABEL, LENGTH_LABEL, lapsLabel, leadText, trackCode } from '../format';
import { iconBack, iconCheck, iconClose, iconPlay } from '../icons';
import { FocusList, type FocusRow } from '../nav';
import { Dialog } from '../widgets';
import { BaseScreen } from './base';

/** Height of one table row (CSS px on the stage); rows are placed by index so they can slide into their new order. */
const ROW_H = 44;

/** The cells of one table row that change when a round's points are added. */
interface RowRefs {
  r: ChampionshipRow;
  slot: HTMLElement;
  pos: HTMLElement;
  move: HTMLElement;
  /** The cell of the round just raced and its index in the calendar. */
  last: HTMLElement | null;
  lastIdx: number;
  pts: HTMLElement;
  gap: HTMLElement;
}

/**
 * The championship hub: the table after the rounds raced so far, the calendar with each finished round's winner
 * and the next round's track and conditions. Shown after every round and whenever a saved championship is opened
 * from the main menu. All data comes from `ctx.championship`; the game owns the season.
 *
 * Straight after a race the table first shows the standings as they were, then the round's points drop in, the
 * totals count up and the rows slide into their new order.
 */
export class StandingsScreen extends BaseScreen {
  readonly id = 'standings' as const;
  private readonly list = new FocusList(true);
  private readonly kicker = h('div', 'kicker');
  private readonly me = h('div', 'st-me');
  private readonly table = h('div', 'st-table');
  private readonly cal = h('div', 'st-cal');
  private readonly calHead = h('span');
  /** "Fastest lap point": explains the purple numbers; sits in the panel header so a full field still fits. */
  private readonly legend = h('div', 'st-legend', h('i'), 'Fastest lap point');
  private readonly dialog: Dialog;
  /** Opened right after a race (the world is still the race): leaving must go through the game. */
  private fromResults = false;
  private readonly nextLabel = h('span', null, 'Next round');
  /** Bumped whenever the table is rebuilt or the screen is left, so a running reveal stops. */
  private anim = 0;
  private timers: number[] = [];

  constructor(ctx: UiCtx) {
    super(ctx, 'standings');
    this.dialog = new Dialog(ctx);
    const defs: { label: string | HTMLElement; icon: () => SVGElement; run: () => void; danger?: boolean }[] = [
      { label: this.nextLabel, icon: () => iconPlay('ico'), run: () => ctx.nextRound() },
      { label: 'Main menu', icon: () => iconBack('ico'), run: () => this.toMenu() },
      { label: 'Abandon', icon: () => iconClose('ico'), run: () => this.askAbandon(), danger: true },
    ];
    const btnRow = h('div', { cls: 'res-buttons in', style: { '--d': '640', '--ty': '30px', '--tx': '0px' } });
    const rows: FocusRow[] = defs.map((d, i) => {
      const b = h('div', 'btn focusable' + (d.danger ? ' danger' : ''), d.icon(), typeof d.label === 'string' ? h('span', null, d.label) : d.label);
      b.addEventListener('pointermove', (e) => {
        if (this.dialog.open) return;
        if ((e as PointerEvent).movementX !== 0 || (e as PointerEvent).movementY !== 0) {
          if (this.list.focus(i)) ctx.sound('move');
        }
      });
      b.addEventListener('click', () => {
        if (this.dialog.open) return;
        this.list.focus(i);
        ctx.sound('select');
        d.run();
      });
      btnRow.appendChild(b);
      return { setFocused: (on: boolean) => b.classList.toggle('is-focus', on), activate: () => (d.run(), true) };
    });
    this.list.setRows(rows, 0);
    this.el.append(
      h('div', 'scrim scrim-flat'),
      h('div', 'scrim scrim-vignette'),
      h('header', 'topbar', h('div', { cls: 'in', style: { '--d': '60', '--tx': '-60px' } }, this.kicker, h('h1', 'h1', 'Standings')), h('div', { cls: 'in', style: { '--d': '160', '--tx': '0px', '--ty': '-24px' } }, this.me)),
      h('div', { cls: 'panel chamfer edge st-panel st-table-panel in', style: { '--d': '200', '--ty': '40px', '--tx': '0px' } }, h('div', 'res-head st-panel-head', h('span', null, 'Championship'), this.legend), this.table),
      h('div', { cls: 'panel chamfer edge st-panel st-cal-panel in', style: { '--d': '300', '--ty': '40px', '--tx': '0px' } }, h('div', 'res-head', this.calHead), this.cal),
      btnRow,
      this.prompts.el,
      this.dialog.el,
    );
    this.prompts.set([
      { action: 'adjust', label: 'Select' },
      { action: 'confirm', label: 'Confirm' },
      { action: 'back', label: 'Main menu' },
    ]);
    this.render(false);
  }

  /**
   * The championship changed under the screen: show it as it is, without the reveal. When it has just been abandoned
   * the screen is on its way out, so the old table stays rather than being rebuilt empty.
   */
  refresh(): void {
    if (this.ctx.championship) this.render(false);
  }

  enter(from: ScreenId): void {
    this.fromResults = from === 'results';
    this.dialog.hide();
    this.render(this.fromResults);
    this.list.focus(0);
  }

  leave(): void {
    this.stopReveal();
    this.dialog.hide();
  }

  dispose(): void {
    this.stopReveal();
  }

  // ── actions ────────────────────────────────────────────────────────────────

  private toMenu(): void {
    if (this.fromResults) this.ctx.emit({ type: 'quitToMenu' });
    else this.ctx.go('main');
  }

  private askAbandon(): void {
    const v = this.ctx.championship;
    this.dialog.show({
      title: 'Abandon the championship?',
      text: `Your ${v?.name ?? 'championship'} points and standings are lost for good. You can always start a new one from the main menu.`,
      yes: 'Abandon',
      no: 'Keep racing',
      onYes: () => {
        this.ctx.emit({ type: 'championshipAbandon' });
        this.toMenu();
      },
    });
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  private trackName(id: string): string {
    return this.ctx.deps.tracks.find((t) => t.id === id)?.name ?? id;
  }

  /** Motion is skipped for people who ask for none, and on the low quality preset (which turns the effects off). */
  private motionOk(): boolean {
    try {
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
    } catch {
      /* no matchMedia */
    }
    return this.el.closest('.xr-ui')?.getAttribute('data-fx') !== 'off';
  }

  private render(reveal: boolean): void {
    this.stopReveal();
    clearEl(this.table);
    clearEl(this.cal);
    clearEl(this.me);
    const v = this.ctx.championship;
    if (!v) {
      this.kicker.textContent = '';
      return;
    }
    const n = v.rounds.length;
    this.kicker.textContent = v.done === 0 ? `${v.name}  ·  Season start` : `${v.name}  ·  After round ${v.done} of ${n}`;
    this.nextLabel.textContent = v.done === 0 ? 'Start round 1' : 'Next round';
    const animate = reveal && v.done > 0 && this.motionOk();
    this.renderMe(v, animate);
    this.renderTable(v, animate);
    this.renderCalendar(v);
  }

  /** The "your position" tile. `before` shows it as it stood ahead of the round just raced (the table's reveal catches up). */
  private renderMe(v: ChampionshipView, before = false): void {
    clearEl(this.me);
    const me = v.player;
    const pts = (r: ChampionshipRow): number => (before ? r.points - r.lastGain : r.points);
    const others = v.table.filter((r) => r !== me).reduce((m, r) => Math.max(m, pts(r)), 0);
    const leader = Math.max(others, pts(me));
    const position = before ? me.prevPosition : me.position;
    this.me.append(
      h('span', 'k', 'Your position'),
      h('div', 'st-me-val', h('b', 'pn', 'P' + position), h('span', 'of', '/' + v.table.length)),
      h('div', 'st-me-sub', `${pts(me)} ${pts(me) === 1 ? 'point' : 'points'}`, v.done > 0 ? h('em', null, leadText(position, leader - pts(me), pts(me) - others)) : null),
    );
  }

  private renderTable(v: ChampionshipView, reveal: boolean): void {
    const n = v.rounds.length;
    const last = v.done - 1;
    this.table.style.setProperty('--rounds', String(n));
    this.table.appendChild(
      h(
        'div',
        'st-row st-head',
        h('span', 'c-pos', 'Pos'),
        h('span', 'c-mv'),
        h('span', 'c-name', 'Driver'),
        ...v.rounds.map((r, k) => h('span', 'c-rd' + (k === last ? ' last' : ''), h('b', null, 'R' + (k + 1)), h('em', null, trackCode(this.trackName(r.trackId))))),
        h('span', 'c-pts', 'Pts'),
        h('span', 'c-gap', 'Gap'),
      ),
    );
    const body = h('div', 'st-body');
    body.style.height = v.table.length * ROW_H + 'px';
    this.table.appendChild(body);
    const refs = v.table.map((r, i) => {
      const x = this.row(r, i, last, reveal);
      body.appendChild(x.slot);
      return x;
    });
    this.legend.style.display = v.table.some((r) => r.fastestLaps > 0) ? '' : 'none';
    if (reveal) this.startReveal(refs, () => this.renderMe(v));
  }

  /** One row. With `reveal` it starts as it was before the round (order, totals, no points yet): `startReveal` brings it up to date. */
  private row(r: ChampionshipRow, i: number, last: number, reveal: boolean): RowRefs {
    const pos = positionCell(reveal ? r.prevPosition : r.position);
    const move = h('span', 'c-mv', moveBadge(reveal ? null : r.move));
    const cells = r.roundPoints.map((p, k) => {
      const hidden = reveal && k === last; // the round just raced is empty until its points drop in
      return h('span', 'c-rd t-num' + (k === last ? ' last' : '') + (r.roundFastest[k] && !hidden ? ' fl' : '') + (hidden || p === null ? ' none' : ''), hidden || p === null ? '–' : String(p));
    });
    const pts = h('span', 'c-pts t-num', String(reveal ? r.points - r.lastGain : r.points));
    const gap = h('span', 'c-gap t-num', reveal ? '' : formatPointsGap(r.gap));
    const row = h(
      'div',
      { cls: 'st-row in' + (r.isPlayer ? ' me' : '') + (r.position === 1 ? ' lead' : ''), style: { '--d': String(320 + i * 42), '--tx': '-40px' } },
      pos,
      move,
      h('span', 'c-name', h('i', { cls: 'chip-dot', style: { background: r.color } }), h('b', null, r.name)),
      ...cells,
      pts,
      gap,
    );
    const slot = h('div', 'st-slot', row);
    slot.style.setProperty('--y', ((reveal ? r.prevPosition : r.position) - 1) * ROW_H + 'px');
    return { r, slot, pos, move, last: last >= 0 ? cells[last] : null, lastIdx: last, pts, gap };
  }

  // ── the reveal ─────────────────────────────────────────────────────────────

  private stopReveal(): void {
    this.anim++;
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
  }

  private later(ms: number, fn: () => void): void {
    const token = this.anim;
    this.timers.push(
      window.setTimeout(() => {
        if (token === this.anim) fn();
      }, ms),
    );
  }

  private countUp(el: HTMLElement, from: number, to: number, ms: number): void {
    if (from === to) return;
    const token = this.anim;
    const t0 = performance.now();
    const step = (now: number): void => {
      if (token !== this.anim) return;
      const k = Math.min(1, (now - t0) / ms);
      el.textContent = String(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** The round's points land row by row, the totals count up, then the table re-sorts itself. */
  private startReveal(refs: RowRefs[], settled: () => void): void {
    const settle = 320 + refs.length * 42 + 420; // the rows have come in
    const pop = 55;
    refs.forEach((x, i) => {
      this.later(settle + i * pop, () => {
        const cell = x.last;
        if (cell) {
          cell.textContent = String(x.r.lastGain);
          cell.classList.remove('none');
          cell.classList.toggle('fl', x.r.roundFastest[x.lastIdx]);
          cell.classList.add('pop');
        }
        this.countUp(x.pts, x.r.points - x.r.lastGain, x.r.points, 700);
      });
    });
    this.later(settle + refs.length * pop + 800, () => {
      this.ctx.sound('move');
      for (const x of refs) {
        x.slot.style.setProperty('--y', (x.r.position - 1) * ROW_H + 'px');
        setPosition(x.pos, x.r.position);
        x.gap.textContent = formatPointsGap(x.r.gap);
        x.move.replaceChildren(moveBadge(x.r.move));
      }
      settled();
    });
  }

  private renderCalendar(v: ChampionshipView): void {
    this.calHead.textContent = v.complete ? 'Calendar' : `Calendar  ·  Next: round ${v.done + 1}`;
    // more than four rounds only fit the panel as slimmer cards
    this.cal.classList.toggle('compact', v.rounds.length > 4);
    v.rounds.forEach((r, i) => this.cal.appendChild(this.card(r, i, v)));
    // the season's rules, as a reminder
    const car = this.ctx.deps.cars.find((c) => c.id === v.carId);
    const chip = (t: string): HTMLElement => h('span', 'chip sm', t);
    this.cal.appendChild(
      h(
        'div',
        { cls: 'st-rules in', style: { '--d': '700', '--ty': '14px', '--tx': '0px' } },
        chip(car?.name ?? v.carId),
        chip(DIFFICULTY_LABEL[v.difficulty] ?? v.difficulty),
        chip(`${v.opponents + 1} drivers`),
        chip(`${LENGTH_LABEL[v.length] ?? v.length} races`),
        chip(`${GRID_LABEL[v.grid] ?? v.grid} grid`),
      ),
    );
  }

  private card(r: ChampionshipRoundView, i: number, v: ChampionshipView): HTMLElement {
    const next = !r.done && i === v.done;
    const state = r.done ? 'done' : next ? 'next' : 'later';
    const track = this.ctx.deps.tracks.find((t) => t.id === r.trackId);
    const badge = h('span', 'cc-n', r.done ? iconCheck('ico') : String(i + 1));
    let right: HTMLElement | null = null;
    if (r.done) {
      right = h(
        'div',
        'cc-res',
        h('span', 'cc-pos' + (r.playerPosition !== null && r.playerPosition <= 3 ? ` p${r.playerPosition}` : ''), r.playerPosition !== null ? 'P' + r.playerPosition : '-'),
        h('span', 'cc-pts t-num', r.playerPoints !== null ? `+${r.playerPoints}` : ''),
      );
    } else if (next) right = h('span', 'cc-next', 'Next');
    const won = r.winner ? (r.winner.isPlayer ? 'You won' : `Won by ${r.winner.name}`) : '';
    return h(
      'div',
      { cls: `cc ${state}` + (r.winner?.isPlayer ? ' won' : ''), style: { '--d': String(380 + i * 70), '--tx': '50px', '--accent': track?.color ?? '#16e0bd' } },
      h('i', 'cc-accent'),
      badge,
      h('div', 'cc-main', h('div', 'cc-name', track?.name ?? r.trackId), h('div', 'cc-sub', conditionChips(r.environment, true), h('span', 'cc-laps', lapsLabel(r.laps))), r.done ? h('div', 'cc-won', won) : null),
      right,
    );
  }

  // ── input ──────────────────────────────────────────────────────────────────

  nav(f: InputFrame): void {
    const n = f.nav;
    if (this.dialog.open) {
      this.dialog.handle(n);
      return;
    }
    if (n.back) {
      this.ctx.sound('back');
      this.toMenu();
      return;
    }
    if (n.left && !n.right) {
      if (this.list.move(-1)) this.ctx.sound('move');
    } else if (n.right && !n.left) {
      if (this.list.move(1)) this.ctx.sound('move');
    } else if (n.up || n.down) {
      /* the table is read-only */
    } else if (n.confirm) {
      if (this.age < 400) return; // the finishing "A" press of the results screen must not fall through
      this.ctx.sound('select');
      this.list.current()?.activate?.();
    }
  }
}
