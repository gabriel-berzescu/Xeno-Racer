import type { InputFrame } from '../../core/contracts';
import type { UiCtx } from '../ctx';
import { h } from '../dom';
import { wordmark } from '../wordmark';
import { BaseScreen } from './base';

interface Block {
  head: string;
  lines: string[];
}

export class CreditsScreen extends BaseScreen {
  readonly id = 'credits' as const;
  private readonly roll = h('div', 'credits-roll');

  constructor(ctx: UiCtx) {
    super(ctx, 'credits');
    const blocks: Block[] = [
      { head: 'The game', lines: ['Xeno-Racer ' + ctx.deps.version, 'A realistic racing game for the browser, made to be played with a gamepad.', 'Built with Claude, for Gabriel.'] },
      {
        head: 'Disciplines',
        lines: ['Vehicle dynamics and race logic', 'Tracks and scenery', 'Rendering and atmosphere', 'Car models and liveries', 'Engine and tire audio', 'Controls, menus and HUD', 'Racing line and AI drivers'],
      },
      { head: 'Built on', lines: ['three.js', 'postprocessing', 'n8ao ambient occlusion', 'Vite and TypeScript'] },
      { head: 'Typefaces', lines: ['Barlow and Barlow Condensed (The Barlow Project Authors)', 'Oxanium (The Oxanium Project Authors)', 'SIL Open Font License 1.1'] },
      { head: 'Imagery', lines: ['Environment maps and textures from Poly Haven and ambientCG', 'Released under CC0'] },
      { head: 'Thank you for driving', lines: ['See you on the grid.'] },
    ];
    for (const b of blocks) {
      this.roll.appendChild(h('section', 'credits-block', h('h2', null, b.head), ...b.lines.map((l) => h('p', null, l))));
    }
    this.el.append(
      h('div', 'scrim scrim-flat'),
      h('div', 'scrim scrim-vignette'),
      h('div', { cls: 'credits-brand in', style: { '--d': '60', '--tx': '-60px' } }, wordmark()),
      h('div', 'credits-window', this.roll),
      this.prompts.el,
    );
    this.prompts.set([{ action: 'back', label: 'Back' }]);
    this.el.addEventListener('click', () => this.close());
  }

  private close(): void {
    this.ctx.sound('back');
    this.ctx.go('main');
  }

  enter(): void {
    // restart the roll animation
    this.roll.style.animation = 'none';
    void this.roll.offsetWidth;
    this.roll.style.animation = '';
  }

  nav(f: InputFrame): void {
    if (f.nav.back || f.nav.confirm) this.close();
  }
}
