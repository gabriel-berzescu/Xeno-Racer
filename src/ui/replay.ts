/**
 * The replay overlay: a REPLAY tag with the driver the camera follows, a timeline, and the button prompts (LB/RB car,
 * Y camera, B exit). The HUD is hidden during a replay, and without this nothing on screen said what was playing or how
 * to leave it.
 */
import type { ReplayInfo } from '../core/systems';
import type { UiCtx } from './ctx';
import { clearEl, h } from './dom';
import { PromptBar } from './widgets';

export class ReplayOverlay {
  readonly el = h('div', 'xr-replay');
  private readonly who = h('div', 'rp-who');
  private readonly bar = h('i');
  private key = '';

  constructor(ctx: UiCtx) {
    const prompts = new PromptBar(ctx, 'prompts');
    prompts.set([
      { action: 'tabs', label: 'Car' },
      { action: 'camera', label: 'Camera' },
      { action: 'back', label: 'Exit' },
    ]);
    this.el.append(h('div', 'rp-tag', h('i', 'rp-dot'), h('span', null, 'Replay')), this.who, h('div', 'rp-time', this.bar), prompts.el);
  }

  set(r: ReplayInfo | null): void {
    this.el.classList.toggle('on', !!r);
    if (!r) {
      this.key = '';
      return;
    }
    const key = `${r.driver}|${r.color}|${r.position}|${r.camera}`;
    if (key !== this.key) {
      this.key = key;
      clearEl(this.who);
      this.who.append(h('i', { cls: 'rp-col', style: { background: r.color } }), h('b', null, r.driver), h('span', null, `P${r.position}  ·  ${r.camera}`));
    }
    this.bar.style.transform = `scaleX(${r.duration > 0 ? Math.min(1, Math.max(0, r.t / r.duration)) : 0})`;
  }
}
