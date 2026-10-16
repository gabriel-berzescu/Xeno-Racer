import type { HudState, InputFrame, Seat } from '../../core/contracts';
import type { ScreenId } from '../../core/systems';
import type { UiCtx } from '../ctx';
import { h, clearEl } from '../dom';
import { damageChip } from '../hud/damage';
import { FORECAST_LABEL, formatLapTime, ordinal, WEATHER_LABEL } from '../format';
import { MODE_INFO, missingPadLine, pauseOwnerLine, seatName } from '../model';
import { FocusList, type FocusRow } from '../nav';
import { Dialog } from '../widgets';
import { BaseScreen } from './base';

interface Item {
  label: string;
  danger?: boolean;
  run(): void;
}

const chip = (k: string, v: string): HTMLElement => h('div', 'kv', h('span', 'k', k), h('span', 'v', v));

/** One player's line of a split-screen pause: their name in their colour, then the numbers the single-player pause shows. */
function playerLine(seat: Seat, name: string, hud: HudState | null): HTMLElement {
  const chips: HTMLElement[] = [];
  if (hud) {
    if (hud.mode === 'race') chips.push(chip('Position', `P${hud.position} / ${hud.totalCars}`));
    chips.push(chip('Lap', hud.totalLaps > 0 ? `${hud.lap} / ${hud.totalLaps}` : String(hud.lap)), chip('Best lap', formatLapTime(hud.bestLap)), chip('Last lap', formatLapTime(hud.lastLap)));
    // Damage: Full, and this player's car is bent
    if (hud.damage) chips.push(damageChip(hud.damage, 'Damage'));
  }
  return h('div', 'pause-line s' + seat, h('b', 'who', name), ...chips);
}

export class PauseScreen extends BaseScreen {
  readonly id = 'pause' as const;
  private readonly list = new FocusList(true);
  private readonly dialog: Dialog;
  private readonly kicker = h('div', 'kicker');
  private readonly info = h('div', 'pause-info');
  /** Split screen: whose pad the menu follows ("Paused by Silviu"), and a warning when a controller has come out. */
  private readonly owner = h('div', 'pause-owner');
  private readonly warn = h('div', 'pause-warn');
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
      h('div', { cls: 'pause-head in', style: { '--d': '60', '--tx': '-60px' } }, this.kicker, h('h1', 'h1', 'Paused'), this.owner, this.info, this.warn),
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
    // split screen: a line for each player (player 2's numbers come with the HUD of their view)
    this.info.classList.toggle('duo', !!cfg?.player2);
    this.el.classList.toggle('is-duo', !!cfg?.player2);
    if (cfg?.player2) {
      const names = this.names();
      this.info.append(playerLine(0, names[0], hud), playerLine(1, names[1], this.ctx.lastHud2));
    } else if (hud) {
      if (hud.mode === 'race') this.info.append(chip('Position', `P${hud.position} / ${hud.totalCars}`));
      this.info.append(chip('Lap', hud.totalLaps > 0 ? `${hud.lap} / ${hud.totalLaps}` : String(hud.lap)), chip('Best lap', formatLapTime(hud.bestLap)), chip('Last lap', formatLapTime(hud.lastLap)));
    }
    // weather that changes: what it is now, or what is coming
    const wx = hud?.weather;
    if (wx) this.info.append(chip('Weather', wx.called ? `${WEATHER_LABEL[wx.sky]}  ·  track ${wx.track.toLowerCase()}` : `${WEATHER_LABEL[wx.sky]}, ${FORECAST_LABEL[wx.forecast].toLowerCase()}`));
    // Damage: Full, and the car is bent (split screen: on each player's line)
    if (!cfg?.player2 && hud?.damage) this.info.append(damageChip(hud.damage));
    // where the season stands going into this round
    const season = ch ? this.ctx.championship : null;
    if (season) this.info.append(chip('Championship', season.done === 0 ? 'Not started' : `${ordinal(season.player.position)}  ·  ${season.player.points} pts`));
    this.renderPlayers();
  }

  /** The two players' names, as the race has them (the config's liveries carry the names it started with). */
  private names(): [string, string] {
    const cfg = this.ctx.lastConfig;
    return [cfg?.livery?.driver || seatName(this.ctx.settings, 0), cfg?.player2?.livery?.driver || seatName(this.ctx.settings, 1)];
  }

  /** Split screen: whose pad the menu follows, and which controller has come out (the game keeps both up to date through setPlayers). */
  private renderPlayers(): void {
    const split = !!this.ctx.lastConfig?.player2;
    const names = this.names();
    const owner = split ? pauseOwnerLine(this.ctx.players, names) : null;
    this.owner.textContent = owner ?? '';
    this.owner.className = 'pause-owner' + (this.ctx.players.owner !== null ? ' s' + this.ctx.players.owner : '');
    this.owner.style.display = owner ? '' : 'none';
    const missing = split ? missingPadLine(this.ctx.players, names) : null;
    this.warn.textContent = missing ?? '';
    this.warn.style.display = missing ? '' : 'none';
  }

  refresh(): void {
    this.renderPlayers();
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
