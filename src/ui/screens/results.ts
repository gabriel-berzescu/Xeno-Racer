import type { InputFrame, RaceResultEntry, Seat, SplitDuel } from '../../core/contracts';
import type { UiCtx } from '../ctx';
import { clearEl, h } from '../dom';
import { formatDelta, formatLapTime, formatRaceTime, ordinal } from '../format';
import { iconBack, iconPlay, iconRestart, iconReplay, iconTrophy } from '../icons';
import { duelSummary, duelTitle, lapRows, MODE_INFO } from '../model';
import { FocusList } from '../nav';
import { BaseScreen } from './base';

const MAX_LAP_ROWS = 10;
/** Laps listed in each player's column of a split-screen race. */
const MAX_DUEL_LAPS = 8;

interface Btn {
  el: HTMLElement;
  label: HTMLElement;
  run(): void;
}

export class ResultsScreen extends BaseScreen {
  readonly id = 'results' as const;
  private readonly list = new FocusList(true);
  private readonly kicker = h('div', 'kicker');
  private readonly title = h('h1', 'h1');
  /** Split screen: how the two players got on ("Gabriel beat Silviu by 3.241 s"), under the title. */
  private readonly subline = h('div', 'res-sub');
  private readonly yoursHead = h('span', null, 'Your laps');
  /** Split screen: the head-to-head of the two players, in place of the single player's laps. */
  private readonly duel = h('div', 'res-duel');
  private readonly badge = h('div', 'pb-badge');
  private readonly table = h('div', 'res-table');
  private readonly laps = h('div', 'res-laps');
  private readonly pace = h('div', 'pace');
  private readonly lapSummary = h('div', 'res-sum');
  private readonly btnRow = h('div', { cls: 'res-buttons in', style: { '--d': '520', '--ty': '30px', '--tx': '0px' } });
  private readonly btns: { restart: Btn; next: Btn; replay: Btn; menu: Btn };
  /** The buttons on show, in focus order: Restart / Watch replay / Menu, or Continue instead of Restart in a championship. */
  private visible: Btn[] = [];
  private champ: boolean | null = null;

  constructor(ctx: UiCtx) {
    super(ctx, 'results');
    this.btns = {
      restart: this.makeBtn('Restart', iconRestart('ico'), () => ctx.emit({ type: 'restart' })),
      next: this.makeBtn('Continue', iconPlay('ico'), () => this.next()),
      replay: this.makeBtn('Watch replay', iconReplay('ico'), () => ctx.emit({ type: 'watchReplay' })),
      menu: this.makeBtn('Menu', iconBack('ico'), () => ctx.emit({ type: 'quitToMenu' })),
    };
    for (const b of Object.values(this.btns)) this.btnRow.appendChild(b.el);
    this.layoutButtons(false);
    this.el.append(
      h('div', 'scrim scrim-flat'),
      h('div', 'scrim scrim-vignette'),
      h('header', 'topbar', h('div', { cls: 'in', style: { '--d': '60', '--tx': '-60px' } }, this.kicker, this.title, this.subline), this.badge),
      h('div', { cls: 'panel chamfer edge res-panel res-standings in', style: { '--d': '200', '--ty': '40px', '--tx': '0px' } }, h('div', 'res-head', h('span', null, 'Final standings')), this.table),
      h('div', { cls: 'panel chamfer edge res-panel res-yours in', style: { '--d': '300', '--ty': '40px', '--tx': '0px' } }, h('div', 'res-head', this.yoursHead), this.lapSummary, this.laps, this.pace, this.duel),
      this.btnRow,
      this.prompts.el,
    );
    this.prompts.set([
      { action: 'adjust', label: 'Select' },
      { action: 'confirm', label: 'Confirm' },
    ]);
    this.render();
  }

  private makeBtn(label: string, icon: SVGElement, run: () => void): Btn {
    const labelEl = h('span', null, label);
    const el = h('div', 'btn focusable', icon, labelEl);
    const index = (): number => this.visible.findIndex((b) => b.el === el);
    el.addEventListener('pointermove', (e) => {
      if ((e as PointerEvent).movementX !== 0 || (e as PointerEvent).movementY !== 0) {
        if (this.list.focus(index())) this.ctx.sound('move');
      }
    });
    el.addEventListener('click', () => {
      this.list.focus(index());
      this.ctx.sound('select');
      run();
    });
    return { el, label: labelEl, run };
  }

  /** A championship round continues to the standings instead of restarting. */
  private layoutButtons(champ: boolean): void {
    const { restart, next, replay, menu } = this.btns;
    this.visible = champ ? [next, replay, menu] : [restart, replay, menu];
    for (const b of Object.values(this.btns)) b.el.style.display = this.visible.includes(b) ? '' : 'none';
    this.list.setRows(
      this.visible.map((b) => ({ setFocused: (on: boolean) => b.el.classList.toggle('is-focus', on), activate: () => (b.run(), true) })),
      0,
    );
  }

  /** On to the standings (or, after the last round, the final table). */
  private next(): void {
    const v = this.ctx.championship;
    if (!v) this.ctx.emit({ type: 'quitToMenu' });
    else this.ctx.go(v.complete ? 'champion' : 'standings');
  }

  refresh(): void {
    this.render();
  }

  enter(): void {
    this.render();
    this.list.focus(0);
  }

  private carName(id: string): string {
    return this.ctx.deps.cars.find((c) => c.id === id)?.name ?? '';
  }

  private render(): void {
    const r = this.ctx.results;
    clearEl(this.table);
    clearEl(this.laps);
    clearEl(this.pace);
    clearEl(this.lapSummary);
    clearEl(this.badge);
    clearEl(this.duel);
    // split screen: the head-to-head takes the place of the single player's laps
    const d = r?.duel;
    this.el.classList.toggle('is-duel', !!d);
    this.subline.textContent = d ? duelSummary(d) : '';
    this.subline.style.display = d ? '' : 'none';
    this.yoursHead.textContent = d ? 'Head to head' : 'Your laps';
    this.lapSummary.style.display = this.laps.style.display = this.pace.style.display = d ? 'none' : '';
    const ch = r?.config.championship;
    this.table.classList.toggle('champ', !!ch);
    if (!!ch !== this.champ) {
      this.champ = !!ch;
      this.layoutButtons(!!ch);
    }
    if (!r) {
      this.title.textContent = 'Results';
      this.kicker.textContent = '';
      return;
    }
    const cfg = r.config;
    const track = this.ctx.deps.tracks.find((t) => t.id === cfg.trackId);
    const info = MODE_INFO[cfg.mode];
    const laps = `${cfg.laps} ${cfg.laps === 1 ? 'lap' : 'laps'}`;
    this.kicker.textContent = ch
      ? `${ch.name}  ·  Round ${ch.round} / ${ch.rounds}  ·  ${track ? track.name + '  ·  ' : ''}${laps}`
      : `${track ? track.name + '  ·  ' : ''}${info.label}${cfg.mode === 'race' ? `  ·  ${laps}` : ''}${d ? '  ·  Split screen' : ''}`;
    const me = r.entries.find((e) => e.isPlayer);
    if (d) this.title.textContent = duelTitle(d);
    else if (cfg.mode !== 'race' || !me) this.title.textContent = 'Session complete';
    else if (me.totalTime === null) this.title.textContent = 'Did not finish';
    else this.title.textContent = me.position === 1 ? 'Victory' : `${ordinal(me.position)} place`;

    if (d) {
      // a new personal best badge for each player who set one, in their colour
      d.personalBest.forEach((pb, i) => {
        if (pb) this.badge.append(h('div', 'badge-in s' + i, iconTrophy('ico'), h('span', null, `${d.names[i]}  ·  personal best`)));
      });
    } else if (r.personalBest) this.badge.append(h('div', 'badge-in', iconTrophy('ico'), h('span', null, 'New personal best')));
    if (ch) this.renderSeason(me?.points ?? 0);

    // the button that carries on in a championship says where to: the next standings or the final table
    this.btns.next.label.textContent = this.ctx.championship?.complete ? 'Final standings' : 'Continue';

    // standings
    const fastest = r.entries.reduce<number>((m, e) => (e.bestLap !== null && e.bestLap < m ? e.bestLap : m), Infinity);
    this.table.appendChild(
      h(
        'div',
        'rt-row rt-head',
        h('span', 'c-pos', 'Pos'),
        h('span', 'c-name', 'Driver'),
        ch ? null : h('span', 'c-laps', 'Laps'),
        h('span', 'c-best', 'Best lap'),
        h('span', 'c-time', 'Time / gap'),
        ch ? h('span', 'c-pts', 'Pts') : null,
      ),
    );
    const entries = [...r.entries].sort((a, b) => a.position - b.position).slice(0, 12);
    entries.forEach((e, i) => this.table.appendChild(this.entryRow(e, fastest, i, !!ch)));
    if (d) this.renderDuel(d);

    // laps
    const times = r.playerLapTimes;
    const best = times.length ? Math.min(...times) : null;
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
    this.lapSummary.append(
      h('div', 'kv', h('span', 'k', 'Best lap'), h('span', 'v t-teal', formatLapTime(best))),
      h('div', 'kv', h('span', 'k', 'Average'), h('span', 'v', formatLapTime(avg))),
      h('div', 'kv', h('span', 'k', 'Laps'), h('span', 'v', String(times.length))),
    );
    if (times.length === 0) this.laps.appendChild(h('div', 'lap-empty', 'No completed laps'));
    const shown = times.length > MAX_LAP_ROWS ? times.slice(times.length - MAX_LAP_ROWS) : times;
    const offset = times.length - shown.length;
    if (offset > 0) this.laps.appendChild(h('div', 'lap-more', `+ ${offset} earlier ${offset === 1 ? 'lap' : 'laps'}`));
    shown.forEach((t, i) => {
      const isBest = best !== null && t === best;
      this.laps.appendChild(
        h(
          'div',
          { cls: 'lap-row' + (isBest ? ' best' : '') },
          h('span', 'l-n', 'LAP ' + (offset + i + 1)),
          h('span', 'l-t t-num', formatLapTime(t)),
          h('span', 'l-d t-num', isBest ? (r.personalBest ? 'PB' : 'BEST') : best !== null ? formatDelta(t - best) : ''),
        ),
      );
    });

    // pace chart: one bar per lap, taller = faster (best lap = full height, slowest = 35%)
    const paceTimes = times.slice(-24);
    if (paceTimes.length >= 2 && best !== null) {
      const worst = Math.max(...paceTimes);
      const fastest = Math.min(...paceTimes);
      const span = Math.max(0.001, worst - fastest);
      const bars = h('div', 'pace-bars');
      const labels = h('div', 'pace-labels');
      const first = times.length - paceTimes.length;
      paceTimes.forEach((t, i) => {
        const b = h('div', t === fastest ? 'pace-bar best' : 'pace-bar');
        b.style.height = (35 + 65 * (1 - (t - fastest) / span)).toFixed(1) + '%';
        bars.appendChild(b);
        labels.appendChild(h('span', null, String(first + i + 1)));
      });
      this.pace.append(h('div', 'pace-k', 'Lap pace'), bars, labels);
    }
  }

  /** Split screen: the two players side by side, each with their place, car, best lap and laps, the winner marked. */
  private renderDuel(d: SplitDuel): void {
    const col = (seat: Seat): HTMLElement => {
      const { rows, hidden } = lapRows(d.lapTimes[seat], d.personalBest[seat], MAX_DUEL_LAPS);
      const laps = h('div', 'duel-laps');
      if (rows.length === 0) laps.appendChild(h('div', 'lap-empty', 'No completed laps'));
      if (hidden > 0) laps.appendChild(h('div', 'lap-more', `+ ${hidden} earlier ${hidden === 1 ? 'lap' : 'laps'}`));
      for (const row of rows) {
        laps.appendChild(h('div', { cls: 'lap-row' + (row.best ? ' best' : '') }, h('span', 'l-n', 'LAP ' + row.lap), h('span', 'l-t t-num', formatLapTime(row.time)), h('span', 'l-d t-num', row.tag)));
      }
      return h(
        'div',
        'duel-col s' + seat + (d.winner === seat ? ' win' : ''),
        h('div', 'duel-who', h('b', null, d.names[seat]), d.winner === seat ? iconTrophy('ico') : null, h('span', 'duel-pos', 'P' + d.positions[seat])),
        h('div', 'duel-car', this.carName(d.carIds[seat])),
        h('div', 'kv duel-best', h('span', 'k', 'Best lap'), h('span', 'v t-num', formatLapTime(d.bestLap[seat]))),
        laps,
      );
    };
    this.duel.append(col(0), col(1));
  }

  /** Where this round leaves the player in the championship (the game records the round before showing results). */
  private renderSeason(gained: number): void {
    const v = this.ctx.championship;
    if (!v) return;
    const me = v.player;
    this.badge.append(
      h(
        'div',
        'st-me res-season',
        h('span', 'k', v.name),
        h('div', 'st-me-val', h('b', 'pn', 'P' + me.position), h('span', 'of', '/' + v.table.length)),
        h('div', 'st-me-sub', `+${gained} ${gained === 1 ? 'pt' : 'pts'}`, h('em', null, `${me.points} total`)),
      ),
    );
  }

  private entryRow(e: RaceResultEntry, fastest: number, i: number, champ: boolean): HTMLElement {
    const dnf = e.totalTime === null;
    const row = h(
      'div',
      { cls: 'rt-row' + (e.isPlayer ? ' me' : '') + (e.isPlayer && e.seat === 1 ? ' s1' : '') + (e.position === 1 ? ' win' : ''), style: { '--i': String(i) } },
      h('span', 'c-pos', String(e.position)),
      h('span', 'c-name', h('b', null, e.name), h('em', null, this.carName(e.carId))),
      champ ? null : h('span', 'c-laps t-num', String(e.laps)),
      h('span', 'c-best t-num' + (e.bestLap !== null && e.bestLap === fastest ? ' fl' : ''), formatLapTime(e.bestLap)),
      h('span', 'c-time t-num', dnf ? 'DNF' : e.position === 1 ? formatRaceTime(e.totalTime) : e.gap),
      champ ? h('span', 'c-pts t-num' + ((e.points ?? 0) > 0 ? ' scored' : ''), e.fastestLap ? h('i', 'fl-tag', 'FL') : null, String(e.points ?? 0)) : null,
    );
    return row;
  }

  nav(f: InputFrame): void {
    const n = f.nav;
    // horizontal button row
    if (n.left && !n.right) {
      if (this.list.move(-1)) this.ctx.sound('move');
    } else if (n.right && !n.left) {
      if (this.list.move(1)) this.ctx.sound('move');
    } else if (n.up || n.down) {
      /* the table is read-only */
    } else if (n.confirm) {
      if (this.age < 400) return; // don't let the finishing "A" press fall straight through
      this.ctx.sound('select');
      this.list.current()?.activate?.();
    }
  }
}
