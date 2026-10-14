import type { InputFrame } from '../../core/contracts';
import { h, clearEl } from '../dom';
import { iconGamepad, iconKeyboard, iconWarn } from '../icons';
import { padGlyph } from '../widgets';
import { wordmark } from '../wordmark';
import { prettyPadName } from '../../input/processing';
import type { UiCtx } from '../ctx';
import { BaseScreen } from './base';

export class TitleScreen extends BaseScreen {
  readonly id = 'title' as const;
  private readonly deviceEl = h('div', 'device');
  private readonly warnEl = h('div', 'warnbar');

  constructor(ctx: UiCtx) {
    super(ctx, 'title');
    const press = h(
      'div',
      { cls: 'title-press in', style: { '--d': '650', '--tx': '0px', '--ty': '30px' } },
      h('span', 'pulse', h('span', 'press-txt', 'PRESS'), padGlyph('a'), h('span', 'press-or', '/'), h('span', 'key key-big', 'ENTER'), h('span', 'press-txt', 'TO START')),
    );
    this.el.append(
      h('div', 'scrim scrim-vignette'),
      h('div', 'scrim scrim-top'),
      h('div', 'scrim scrim-bottom'),
      h('div', { cls: 'title-logo in', style: { '--d': '120', '--tx': '-90px' } }, wordmark(), h('div', 'title-tag', h('span', null, 'PHOTOREAL MOTORSPORT'), h('i'), h('span', null, 'BUILT FOR THE GAMEPAD'))),
      h('div', { cls: 'title-meta in', style: { '--d': '500', '--ty': '-20px', '--tx': '0px' } }, h('div', 'tag', 'VERSION ', h('b', null, ctx.deps.version))),
      h('div', { cls: 'title-device in', style: { '--d': '560', '--ty': '-20px', '--tx': '0px' } }, this.deviceEl, this.warnEl),
      press,
    );
    this.el.addEventListener('click', () => this.proceed());
    ctx.onDevice(() => this.renderDevice());
    this.renderDevice();
  }

  private renderDevice(): void {
    const c = this.ctx;
    clearEl(this.deviceEl);
    const pad = c.device === 'gamepad';
    const name = pad ? prettyPadName(c.deviceName) ?? c.deviceName ?? 'Gamepad' : 'Keyboard';
    this.deviceEl.append(c.padWarning && pad ? iconWarn() : pad ? iconGamepad() : iconKeyboard(), h('span', null, name));
    this.deviceEl.classList.toggle('warn', !!c.padWarning && pad);
    this.warnEl.textContent = c.padWarning ?? '';
    this.warnEl.style.display = c.padWarning ? '' : 'none';
  }

  enter(): void {
    this.renderDevice();
  }

  private proceed(): void {
    if (this.age < 350) return;
    this.ctx.sound('select');
    this.ctx.go('main');
  }

  nav(f: InputFrame): void {
    if (f.anyPressed || f.nav.confirm) this.proceed();
  }
}
