import type { InputFrame } from '../../core/contracts';
import type { ScreenId } from '../../core/systems';
import type { UiCtx } from '../ctx';
import { h, clearEl } from '../dom';
import { formatLapTime } from '../format';
import { MODE_INFO } from '../model';
import { FocusList, type FocusRow } from '../nav';
import { Dialog } from '../widgets';
import { BaseScreen } from './base';

interface Item {
  label: string;
  danger?: boolean;
  run(): void;
}

export class PauseScreen extends BaseScreen {
  readonly id = 'pause' as const;
  private readonly list = new FocusList(true);
  private readonly dialog: Dialog;
  private readonly kicker = h('div', 'kicker');
  private readonly info = h('div', 'pause-info');
  private readonly items: Item[];

  constructor(ctx: UiCtx) {
    super(ctx, 'pause');
    this.dialog = new Dialog(ctx);
    this.items = [
      { label: 'Resume', run: () => this.resume() },
      { label: 'Restart', run: () => this.confirm('Restart the race?', 'You will start again from the grid. Your progress in this race will be lost.', 'Restart', 'Keep racing', () => ctx.emit({ type: 'restart' })) },
      { label: 'Settings', run: () => ctx.go('settings') },
      { label: 'Quit to menu', danger: true, run: () => this.confirm('Quit to the menu?', 'You will leave the race. Your progress in this race will be lost.', 'Quit', 'Cancel', () => ctx.emit({ type: 'quitToMenu' })) },
    ];
    const menu = h('nav', 'menu');
    const rows: FocusRow[] = this.items.map((it, i) => {
      const el = h('div', { cls: 'menu-item focusable in' + (it.danger ? ' danger' : ''), style: { '--d': String(220 + i * 70), '--tx': '-70px' } }, h('i', 'plate'), h('i', 'plate-edge'), h('span', 'idx', String(i + 1).padStart(2, '0')), h('span', 'lbl', it.label));
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

  private confirm(title: string, text: string, yes: string, no: string, onYes: () => void): void {
    const mode = this.ctx.lastHud?.mode ?? this.ctx.lastConfig?.mode ?? 'race';
    if (mode !== 'race') {
      onYes();
      return;
    }
    this.dialog.show({ title, text, yes, no, onYes });
  }

  enter(_from: ScreenId): void {
    this.dialog.hide();
    this.list.focus(0);
    const cfg = this.ctx.lastConfig;
    const hud = this.ctx.lastHud;
    const track = cfg ? this.ctx.deps.tracks.find((t) => t.id === cfg.trackId) : undefined;
    const mode = MODE_INFO[hud?.mode ?? cfg?.mode ?? 'race'].label;
    this.kicker.textContent = `${track ? track.name + '  ·  ' : ''}${mode}`;
    clearEl(this.info);
    if (hud) {
      const chip = (k: string, v: string): HTMLElement => h('div', 'kv', h('span', 'k', k), h('span', 'v', v));
      if (hud.mode === 'race') this.info.append(chip('Position', `P${hud.position} / ${hud.totalCars}`));
      this.info.append(chip('Lap', hud.totalLaps > 0 ? `${hud.lap} / ${hud.totalLaps}` : String(hud.lap)), chip('Best lap', formatLapTime(hud.bestLap)), chip('Last lap', formatLapTime(hud.lastLap)));
    }
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
