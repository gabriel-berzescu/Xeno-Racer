import type { InputFrame } from '../../core/contracts';
import type { ScreenId } from '../../core/systems';
import type { UiCtx } from '../ctx';
import { h, clearEl } from '../dom';
import { formatLapTime, ordinal } from '../format';
import { MODE_INFO } from '../model';
import { FocusList, type FocusRow } from '../nav';
import { Dialog } from '../widgets';
import { BaseScreen } from './base';

interface Item {
  label: string;
  danger?: boolean;
  run(): void;
}

const chip = (k: string, v: string): HTMLElement => h('div', 'kv', h('span', 'k', k), h('span', 'v', v));

export class PauseScreen extends BaseScreen {
  readonly id = 'pause' as const;
  private readonly list = new FocusList(true);
  private readonly dialog: Dialog;
  private readonly kicker = h('div', 'kicker');
  private readonly info = h('div', 'pause-info');
  private readonly items: Item[];
  private readonly restartLabel = h('span', 'lbl', 'Restart');

  constructor(ctx: UiCtx) {
    super(ctx, 'pause');
    this.dialog = new Dialog(ctx);
    this.items = [
      { label: 'Resume', run: () => this.resume() },
      {
        label: 'Restart',
        run: () =>
          this.championship()
            ? this.confirm('Restart the round?', 'You will start again from the grid. Your progress in this round will be lost.', 'Restart', 'Keep racing', () => ctx.emit({ type: 'restart' }))
            : this.mode() === 'race'
              ? this.confirm('Restart the race?', 'You will start again from the grid. Your progress in this race will be lost.', 'Restart', 'Keep racing', () => ctx.emit({ type: 'restart' }))
              : this.confirm('Start over?', 'You will roll out again before the line. The lap you are on will not count.', 'Restart', 'Keep driving', () => ctx.emit({ type: 'restart' })),
      },
      { label: 'Settings', run: () => ctx.go('settings') },
      {
        label: 'Quit to menu',
        danger: true,
        run: () =>
          this.championship()
            ? this.confirm('Quit to the menu?', 'This round will not count. Your championship is saved, and you can pick it up again from the main menu.', 'Quit', 'Cancel', () => ctx.emit({ type: 'quitToMenu' }))
            : this.mode() === 'race'
              ? this.confirm('Quit to the menu?', 'You will leave the race. Your progress in this race will be lost.', 'Quit', 'Cancel', () => ctx.emit({ type: 'quitToMenu' }))
              : this.confirm('Quit to the menu?', 'The lap you are on will not count. Your best laps are already saved.', 'Quit', 'Cancel', () => ctx.emit({ type: 'quitToMenu' })),
      },
    ];
    const menu = h('nav', 'menu');
    const rows: FocusRow[] = this.items.map((it, i) => {
      const el = h('div', { cls: 'menu-item focusable in' + (it.danger ? ' danger' : ''), style: { '--d': String(220 + i * 70), '--tx': '-70px' } }, h('i', 'plate'), h('i', 'plate-edge'), h('span', 'idx', String(i + 1).padStart(2, '0')), i === 1 ? this.restartLabel : h('span', 'lbl', it.label));
      el.addEventListener('pointermove', (e) => {
        if (this.dialog.open) return;
        if ((e as PointerEvent).movementX !== 0 || (e as PointerEvent).movementY !== 0) {
          if (this.list.focus(i)) ctx.sound('move');
        }
      });
      el.addEventListener('click', () => {
        if (this.dialog.open) return;
        this.list.focus(i);
        ctx.sound('select');
        it.run();
      });
      menu.appendChild(el);
      return { setFocused: (on: boolean) => el.classList.toggle('is-focus', on), activate: () => (it.run(), true) };
    });
    this.list.setRows(rows, 0);
    this.el.append(
      h('div', 'scrim scrim-flat'),
      h('div', 'scrim scrim-left'),
      h('div', { cls: 'pause-head in', style: { '--d': '60', '--tx': '-60px' } }, this.kicker, h('h1', 'h1', 'Paused'), this.info),
      h('div', 'pause-menu', menu),
      this.prompts.el,
      this.dialog.el,
    );
    this.prompts.set([
      { action: 'navigate', label: 'Select' },
      { action: 'confirm', label: 'Confirm' },
      { action: 'start', label: 'Resume' },
    ]);
  }

  private resume(): void {
    this.ctx.emit({ type: 'resume' });
    this.ctx.go('none');
  }

  /** Is the race being paused a round of a championship? */
  private championship(): boolean {
    return !!this.ctx.lastConfig?.championship;
  }

  private mode(): 'race' | 'timeTrial' | 'freeRoam' {
    return this.ctx.lastHud?.mode ?? this.ctx.lastConfig?.mode ?? 'race';
  }

  private confirm(title: string, text: string, yes: string, no: string, onYes: () => void): void {
    this.dialog.show({ title, text, yes, no, onYes });
  }

  enter(_from: ScreenId): void {
    this.dialog.hide();
    this.list.focus(0);
    const cfg = this.ctx.lastConfig;
    const hud = this.ctx.lastHud;
    const track = cfg ? this.ctx.deps.tracks.find((t) => t.id === cfg.trackId) : undefined;
    const mode = MODE_INFO[hud?.mode ?? cfg?.mode ?? 'race'].label;
    const ch = cfg?.championship;
    this.kicker.textContent = ch ? `${ch.name}  ·  Round ${ch.round} / ${ch.rounds}${track ? '  ·  ' + track.name : ''}` : `${track ? track.name + '  ·  ' : ''}${mode}`;
    this.restartLabel.textContent = ch ? 'Restart round' : 'Restart';
    clearEl(this.info);
    if (hud) {
      if (hud.mode === 'race') this.info.append(chip('Position', `P${hud.position} / ${hud.totalCars}`));
      this.info.append(chip('Lap', hud.totalLaps > 0 ? `${hud.lap} / ${hud.totalLaps}` : String(hud.lap)), chip('Best lap', formatLapTime(hud.bestLap)), chip('Last lap', formatLapTime(hud.lastLap)));
    }
    // where the season stands going into this round
    const season = ch ? this.ctx.championship : null;
    if (season) this.info.append(chip('Championship', season.done === 0 ? 'Not started' : `${ordinal(season.player.position)}  ·  ${season.player.points} pts`));
  }

  leave(): void {
    this.dialog.hide();
  }

  nav(f: InputFrame): void {
    if (this.dialog.open) {
      this.dialog.handle(f.nav);
      return;
    }
    // Start / Esc / P resume (Start also "confirms" in menus, so check pause first).
    if (f.pause || f.nav.back) {
      if (this.age < 250) return;
      this.ctx.sound('back');
      this.resume();
      return;
    }
    const r = this.list.handle(f.nav);
    if (r === 'moved') this.ctx.sound('move');
    else if (r === 'activated') this.ctx.sound('select');
  }
}
