import type { InputFrame, RaceMode } from '../../core/contracts';
import type { UiCtx } from '../ctx';
import { clearEl, h } from '../dom';
import { formatLapTime } from '../format';
import { championshipHint, MODE_INFO } from '../model';
import { FocusList, type FocusRow } from '../nav';
import { wordmark } from '../wordmark';
import { BaseScreen } from './base';

interface Item {
  label: string;
  hint(): string;
  danger?: boolean;
  /** A small chip beside the label (e.g. the round a saved championship is at). */
  badge?(): { text: string; tone?: 'gold' } | null;
  run(): void;
}

export class MainScreen extends BaseScreen {
  readonly id = 'main' as const;
  private readonly list = new FocusList(true);
  private readonly hint = h('div', 'main-hint');
  private readonly items: Item[];
  private readonly badges: (HTMLElement | null)[] = [];
  private readonly driver = h('b');
  private readonly pb = h('div', { cls: 'panel chamfer edge main-pb in', style: { '--d': '700', '--tx': '60px' } });

  constructor(ctx: UiCtx) {
    super(ctx, 'main');
    const mode = (m: RaceMode) => () => ctx.openSetup(m);
    const modeItem = (label: string, m: RaceMode): Item => ({ label, hint: () => MODE_INFO[m].blurb, run: mode(m) });
    this.items = [modeItem('Race', 'race')];
    if (ctx.championshipDef) {
      this.items.push({
        label: 'Championship',
        hint: () => championshipHint(ctx.championshipDef, ctx.championship),
        badge: () => {
          const v = ctx.championship;
          if (!v) return null;
          return v.complete ? { text: 'Finished', tone: 'gold' } : { text: `Round ${v.done + 1}/${v.rounds.length}` };
        },
        // a saved season resumes at its standings (or its final table); a new one starts at the setup
        run: () => {
          const v = ctx.championship;
          if (!v) ctx.openSetup('championship');
          else ctx.go(v.complete ? 'champion' : 'standings');
        },
      });
    }
    this.items.push(
      modeItem('Time Trial', 'timeTrial'),
      modeItem('Free Roam', 'freeRoam'),
      { label: 'Settings', hint: () => 'Graphics, audio, controls, driving assists and gameplay.', run: () => ctx.go('settings') },
      { label: 'Credits', hint: () => 'The people and projects behind Xeno-Racer.', run: () => ctx.go('credits') },
    );
    const menu = h('nav', 'menu');
    const rows: FocusRow[] = this.items.map((it, i) => {
      const badge = it.badge ? h('span', 'mi-badge') : null;
      this.badges.push(badge);
      const el = h('div', { cls: 'menu-item focusable in', style: { '--d': String(200 + i * 70), '--tx': '-70px' } }, h('i', 'plate'), h('i', 'plate-edge'), h('span', 'idx', String(i + 1).padStart(2, '0')), h('span', 'lbl', it.label), badge);
      el.addEventListener('pointermove', (e) => {
        if ((e as PointerEvent).movementX !== 0 || (e as PointerEvent).movementY !== 0) this.focusTo(i);
      });
      el.addEventListener('click', () => {
        this.focusTo(i);
        this.ctx.sound('select');
        this.items[i].run();
      });
      menu.appendChild(el);
      return {
        setFocused: (on: boolean) => el.classList.toggle('is-focus', on),
        activate: () => (it.run(), true),
        onFocus: () => {
          this.hint.textContent = it.hint();
        },
      };
    });
    this.list.setRows(rows, 0);
    this.el.append(
      h('div', 'scrim scrim-top'),
      h('div', 'scrim scrim-left'),
      h('div', 'scrim scrim-bottom'),
      h('div', { cls: 'main-brand in', style: { '--d': '60', '--ty': '-24px', '--tx': '0px' } }, wordmark()),
      h('div', { cls: 'main-driver in', style: { '--d': '260', '--ty': '-24px', '--tx': '0px' } }, h('div', 'tag', 'DRIVER ', this.driver)),
      h('div', 'main-menu', menu),
      this.pb,
      h('div', { cls: 'main-hintwrap in', style: { '--d': '640', '--ty': '20px', '--tx': '0px' } }, this.hint),
      this.prompts.el,
    );
    this.prompts.set([
      { action: 'navigate', label: 'Select' },
      { action: 'confirm', label: 'Open' },
      { action: 'back', label: 'Title' },
    ]);
    this.hint.textContent = this.items[0].hint();
    ctx.onSettings(() => this.refresh());
    this.refresh();
  }

  private focusTo(i: number): void {
    if (this.list.focus(i)) this.ctx.sound('move');
  }

  refresh(): void {
    this.driver.textContent = this.ctx.settings.playerName;
    this.renderBests();
    this.items.forEach((it, i) => {
      const el = this.badges[i];
      if (!el || !it.badge) return;
      const b = it.badge();
      el.textContent = b?.text ?? '';
      el.style.display = b ? '' : 'none';
      el.classList.toggle('gold', b?.tone === 'gold');
    });
    const cur = this.list.index >= 0 ? this.items[this.list.index] : null;
    if (cur) this.hint.textContent = cur.hint(); // a saved championship changes its own line
  }

  /** Up to three personal bests (track order), or nothing at all before the first lap. */
  private renderBests(): void {
    const { tracks, cars } = this.ctx.deps;
    clearEl(this.pb);
    const rows: { track: string; car: string; time: number }[] = [];
    for (const t of tracks) {
      for (const c of cars) {
        const time = this.ctx.bestLaps[`${t.id}/${c.id}`];
        if (time !== undefined && Number.isFinite(time)) rows.push({ track: t.name, car: c.name, time });
      }
    }
    this.pb.style.display = rows.length ? '' : 'none';
    if (!rows.length) return;
    this.pb.appendChild(h('div', 'pb-head', 'Personal bests'));
    for (const r of rows.slice(0, 3)) this.pb.appendChild(h('div', 'pb-row', h('div', 'pb-what', h('b', null, r.track), h('em', null, r.car)), h('span', 't-num', formatLapTime(r.time))));
  }

  enter(): void {
    this.refresh();
    this.list.focus(this.list.index < 0 ? 0 : this.list.index);
  }

  nav(f: InputFrame): void {
    const n = f.nav;
    if (n.back) {
      this.ctx.sound('back');
      this.ctx.go('title');
      return;
    }
    const r = this.list.handle(n);
    if (r === 'moved') this.ctx.sound('move');
    else if (r === 'activated') this.ctx.sound('select');
  }
}
