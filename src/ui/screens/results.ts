import type { InputFrame, RaceResultEntry } from '../../core/contracts';
import type { UiCtx } from '../ctx';
import { clearEl, h } from '../dom';
import { formatDelta, formatLapTime, formatRaceTime, ordinal } from '../format';
import { iconBack, iconRestart, iconReplay, iconTrophy } from '../icons';
import { MODE_INFO } from '../model';
import { FocusList, type FocusRow } from '../nav';
import { BaseScreen } from './base';

const MAX_LAP_ROWS = 10;

export class ResultsScreen extends BaseScreen {
  readonly id = 'results' as const;
  private readonly list = new FocusList(true);
  private readonly kicker = h('div', 'kicker');
  private readonly title = h('h1', 'h1');
  private readonly badge = h('div', 'pb-badge');
  private readonly table = h('div', 'res-table');
  private readonly laps = h('div', 'res-laps');
  private readonly pace = h('div', 'pace');
  private readonly lapSummary = h('div', 'res-sum');
  private readonly buttons: HTMLElement[] = [];

  constructor(ctx: UiCtx) {
    super(ctx, 'results');
    const defs: { label: string; icon: () => SVGElement; run: () => void; primary?: boolean }[] = [
      { label: 'Restart', icon: () => iconRestart('ico'), run: () => ctx.emit({ type: 'restart' }), primary: true },
      { label: 'Watch replay', icon: () => iconReplay('ico'), run: () => ctx.emit({ type: 'watchReplay' }) },
      { label: 'Menu', icon: () => iconBack('ico'), run: () => ctx.emit({ type: 'quitToMenu' }) },
    ];
    const btnRow = h('div', { cls: 'res-buttons in', style: { '--d': '520', '--ty': '30px', '--tx': '0px' } });
    const rows: FocusRow[] = defs.map((d, i) => {
      const b = h('div', 'btn focusable', d.icon(), h('span', null, d.label));
      b.addEventListener('pointermove', (e) => {
        if ((e as PointerEvent).movementX !== 0 || (e as PointerEvent).movementY !== 0) {
          if (this.list.focus(i)) ctx.sound('move');
        }
      });
      b.addEventListener('click', () => {
        this.list.focus(i);
        ctx.sound('select');
        d.run();
      });
      btnRow.appendChild(b);
      this.buttons.push(b);
      return { setFocused: (on: boolean) => b.classList.toggle('is-focus', on), activate: () => (d.run(), true) };
    });
    this.list.setRows(rows, 0);
    this.el.append(
      h('div', 'scrim scrim-flat'),
      h('div', 'scrim scrim-vignette'),
      h('header', 'topbar', h('div', { cls: 'in', style: { '--d': '60', '--tx': '-60px' } }, this.kicker, this.title), this.badge),
      h('div', { cls: 'panel chamfer edge res-panel res-standings in', style: { '--d': '200', '--ty': '40px', '--tx': '0px' } }, h('div', 'res-head', h('span', null, 'Final standings')), this.table),
      h('div', { cls: 'panel chamfer edge res-panel res-yours in', style: { '--d': '300', '--ty': '40px', '--tx': '0px' } }, h('div', 'res-head', h('span', null, 'Your laps')), this.lapSummary, this.laps, this.pace),
      btnRow,
      this.prompts.el,
    );
    this.prompts.set([
      { action: 'adjust', label: 'Select' },
      { action: 'confirm', label: 'Confirm' },
    ]);
    this.render();
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
    if (!r) {
      this.title.textContent = 'Results';
      this.kicker.textContent = '';
      return;
    }
    const cfg = r.config;
    const track = this.ctx.deps.tracks.find((t) => t.id === cfg.trackId);
    const info = MODE_INFO[cfg.mode];
    this.kicker.textContent = `${track ? track.name + '  ·  ' : ''}${info.label}${cfg.mode === 'race' ? `  ·  ${cfg.laps} laps` : ''}`;
    const me = r.entries.find((e) => e.isPlayer);
    if (cfg.mode !== 'race' || !me) this.title.textContent = 'Session complete';
    else if (me.totalTime === null) this.title.textContent = 'Did not finish';
    else this.title.textContent = me.position === 1 ? 'Victory' : `${ordinal(me.position)} place`;

    if (r.personalBest) this.badge.append(h('div', 'badge-in', iconTrophy('ico'), h('span', null, 'New personal best')));

    // standings
    const fastest = r.entries.reduce<number>((m, e) => (e.bestLap !== null && e.bestLap < m ? e.bestLap : m), Infinity);
    this.table.appendChild(h('div', 'rt-row rt-head', h('span', 'c-pos', 'Pos'), h('span', 'c-name', 'Driver'), h('span', 'c-laps', 'Laps'), h('span', 'c-best', 'Best lap'), h('span', 'c-time', 'Time / gap')));
    const entries = [...r.entries].sort((a, b) => a.position - b.position).slice(0, 12);
    entries.forEach((e, i) => this.table.appendChild(this.entryRow(e, fastest, i)));

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

  private entryRow(e: RaceResultEntry, fastest: number, i: number): HTMLElement {
    const dnf = e.totalTime === null;
    const row = h(
      'div',
      { cls: 'rt-row' + (e.isPlayer ? ' me' : '') + (e.position === 1 ? ' win' : ''), style: { '--i': String(i) } },
      h('span', 'c-pos', String(e.position)),
      h('span', 'c-name', h('b', null, e.name), h('em', null, this.carName(e.carId))),
      h('span', 'c-laps t-num', String(e.laps)),
      h('span', 'c-best t-num' + (e.bestLap !== null && e.bestLap === fastest ? ' fl' : ''), formatLapTime(e.bestLap)),
      h('span', 'c-time t-num', dnf ? 'DNF' : e.position === 1 ? formatRaceTime(e.totalTime) : e.gap),
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
