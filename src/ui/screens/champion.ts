import type { ChampionshipRow, ChampionshipView, InputFrame } from '../../core/contracts';
import { positionCell } from '../champ-widgets';
import type { UiCtx } from '../ctx';
import { clearEl, h } from '../dom';
import { ordinal, seasonTitle } from '../format';
import { iconBack, iconTrophy } from '../icons';
import { BaseScreen } from './base';

const CONFETTI = 46;
const CONFETTI_COLORS = ['#16e0bd', '#ff2e63', '#ffd24a', '#eef0f3', '#16e0bd', '#ff2e63'];

/**
 * The end of a championship: the podium, a celebration when the player won, the season summary and the full
 * final table. Leaving it forgets the finished season.
 */
export class ChampionScreen extends BaseScreen {
  readonly id = 'champion' as const;
  private readonly kicker = h('div', 'kicker');
  private readonly title = h('h1', 'h1');
  private readonly badge = h('div', 'pb-badge');
  private readonly podium = h('div', 'podium');
  private readonly stats = h('div', 'ch-stats');
  private readonly table = h('div', 'ch-table');
  private readonly confetti = h('div', 'confetti');
  private readonly button: HTMLElement;
  private fromResults = false;

  constructor(ctx: UiCtx) {
    super(ctx, 'champion');
    this.button = h('div', 'btn primary is-focus focusable', iconBack('ico'), h('span', null, 'Main menu'));
    this.button.addEventListener('click', () => {
      ctx.sound('select');
      this.finish();
    });
    this.el.append(
      h('div', 'scrim scrim-flat'),
      h('div', 'scrim scrim-vignette'),
      this.confetti,
      h('header', 'topbar', h('div', { cls: 'in', style: { '--d': '60', '--tx': '-60px' } }, this.kicker, this.title), this.badge),
      this.podium,
      this.stats,
      h('div', { cls: 'panel chamfer edge ch-panel in', style: { '--d': '260', '--ty': '40px', '--tx': '0px' } }, h('div', 'res-head', h('span', null, 'Final standings')), this.table),
      h('div', { cls: 'res-buttons in', style: { '--d': '700', '--ty': '30px', '--tx': '0px' } }, this.button),
      this.prompts.el,
    );
    this.prompts.set([{ action: 'confirm', label: 'Main menu' }]);
    this.render();
  }

  /** The finished season is forgotten as the screen is left: keep the table up rather than rebuilding it empty. */
  refresh(): void {
    if (this.ctx.championship) this.render();
  }

  enter(from: string): void {
    this.fromResults = from === 'results';
    this.render();
    const v = this.ctx.championship;
    // a fanfare for the podium; the player's own win gets the bigger one
    if (v) this.ctx.sound(v.player.position === 1 ? 'bestLap' : 'finish');
  }

  /**
   * Done with the season: it has been seen, so forget it and go to the main menu (a finished season can be reopened
   * from the menu until then, e.g. after leaving the results with "Menu" or closing the game on this screen).
   */
  private finish(): void {
    this.ctx.emit({ type: 'championshipAbandon' });
    if (this.fromResults) this.ctx.emit({ type: 'quitToMenu' });
    else this.ctx.go('main');
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  private render(): void {
    for (const el of [this.badge, this.podium, this.stats, this.table, this.confetti]) clearEl(el);
    const v = this.ctx.championship;
    if (!v) {
      this.title.textContent = 'Championship';
      this.kicker.textContent = '';
      return;
    }
    const me = v.player;
    const champion = me.position === 1;
    this.kicker.textContent = `${v.name}  ·  Final standings`;
    this.title.textContent = seasonTitle(me.position);
    this.title.classList.toggle('gold', champion);
    this.el.classList.toggle('is-champion', champion);
    if (champion) {
      this.badge.append(h('div', 'badge-in gold', iconTrophy('ico'), h('span', null, `${v.name} champion`)));
      for (let i = 0; i < CONFETTI; i++) this.confetti.appendChild(this.piece(i));
    } else {
      this.badge.append(h('div', 'badge-in muted', h('span', null, 'Season complete')));
    }
    this.renderPodium(v);
    this.renderStats(v);
    this.renderTable(v);
  }

  /** One streamer of the celebration; spread deterministically so every run looks the same. */
  private piece(i: number): HTMLElement {
    const u = (k: number): number => {
      const x = Math.sin((i + 1) * 12.9898 + k * 78.233) * 43758.5453;
      return x - Math.floor(x);
    };
    return h('i', {
      style: {
        left: (u(1) * 100).toFixed(1) + '%',
        '--c': CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        '--dl': (u(2) * 3.2).toFixed(2) + 's',
        '--t': (4.2 + u(3) * 3.4).toFixed(2) + 's',
        '--dx': ((u(4) - 0.5) * 220).toFixed(0) + 'px',
        '--rot': (360 + u(5) * 540).toFixed(0) + 'deg',
        '--w': (7 + u(6) * 8).toFixed(0) + 'px',
      },
    });
  }

  private renderPodium(v: ChampionshipView): void {
    const [p1, p2, p3] = v.table;
    const order = [p2, p1, p3].filter((r): r is ChampionshipRow => !!r);
    order.forEach((r) => this.podium.appendChild(this.block(r)));
  }

  private block(r: ChampionshipRow): HTMLElement {
    const delay = r.position === 1 ? 760 : r.position === 2 ? 520 : 340;
    return h(
      'div',
      { cls: `pod pod-${r.position}` + (r.isPlayer ? ' me' : ''), style: { '--d': String(delay), '--ty': '60px', '--tx': '0px', '--col': r.color } },
      r.position === 1 ? h('div', 'pod-trophy', iconTrophy('ico')) : null,
      h(
        'div',
        { cls: 'pod-body' },
        h('i', 'pod-chip'),
        h('div', 'pod-n', String(r.position)),
        h('div', 'pod-name', r.name),
        r.isPlayer ? h('div', 'pod-you', 'You') : null,
        h('div', 'pod-pts t-num', h('b', null, String(r.points)), h('span', null, r.points === 1 ? 'pt' : 'pts')),
        h('div', 'pod-sub', r.wins === 1 ? '1 win' : `${r.wins} wins`, h('span', null, '·'), r.podiums === 1 ? '1 podium' : `${r.podiums} podiums`),
      ),
    );
  }

  private renderStats(v: ChampionshipView): void {
    const s = v.season;
    const tile = (k: string, val: string, cls = ''): HTMLElement => h('div', 'ch-tile' + cls, h('span', 'k', k), h('span', 'v t-num', val));
    this.stats.append(
      h('div', 'ch-stats-k', 'Your season'),
      h('div', { cls: 'ch-tiles in', style: { '--d': '560', '--ty': '30px', '--tx': '0px' } }, tile('Points', String(s.points), ' hot'), tile('Wins', String(s.wins)), tile('Podiums', String(s.podiums)), tile('Fastest laps', String(s.fastestLaps)), tile('Best finish', s.bestFinish !== null ? ordinal(s.bestFinish) : '-')),
    );
  }

  private renderTable(v: ChampionshipView): void {
    this.table.append(h('div', 'ch-row ch-head', h('span', 'c-pos', 'Pos'), h('span', 'c-name', 'Driver'), h('span', 'c-s', 'Wins'), h('span', 'c-s', 'Pod'), h('span', 'c-s', 'FL'), h('span', 'c-pts', 'Pts')));
    v.table.forEach((r, i) =>
      this.table.appendChild(
        h(
          'div',
          { cls: 'ch-row in' + (r.isPlayer ? ' me' : ''), style: { '--d': String(420 + i * 40), '--tx': '-30px' } },
          positionCell(r.position),
          h('span', 'c-name', h('i', { cls: 'chip-dot', style: { background: r.color } }), h('b', null, r.name)),
          h('span', 'c-s t-num', String(r.wins)),
          h('span', 'c-s t-num', String(r.podiums)),
          h('span', 'c-s t-num', String(r.fastestLaps)),
          h('span', 'c-pts t-num', String(r.points)),
        ),
      ),
    );
  }

  // ── input ──────────────────────────────────────────────────────────────────

  nav(f: InputFrame): void {
    const n = f.nav;
    // the podium takes a moment to come in: an early press (a double tap on "Final standings") must not skip it
    if (this.age < 1400) return;
    if (n.back) {
      this.ctx.sound('back');
      this.finish();
      return;
    }
    if (n.confirm) {
      this.ctx.sound('select');
      this.finish();
    }
  }
}
