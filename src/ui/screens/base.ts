import type { InputFrame } from '../../core/contracts';
import type { ScreenId } from '../../core/systems';
import type { UiCtx } from '../ctx';
import { h } from '../dom';
import { PromptBar } from '../widgets';

export type ActiveScreenId = Exclude<ScreenId, 'none'>;

/** A full-screen menu. The UI core owns activation; screens own their DOM, focus and input. */
export abstract class BaseScreen {
  abstract readonly id: ActiveScreenId;
  readonly el: HTMLElement;
  protected readonly prompts: PromptBar;
  private shownAt = 0;

  constructor(protected readonly ctx: UiCtx, cls: string) {
    this.el = h('section', `screen scr-${cls}`);
    this.prompts = new PromptBar(ctx);
  }

  /** ms since the screen became active. */
  get age(): number {
    return performance.now() - this.shownAt;
  }

  /** Called before the screen becomes visible (reset focus, refresh data). */
  enter(_from: ScreenId): void {}
  /** Called when the screen is hidden. */
  leave(): void {}
  /** Menu navigation edges. */
  nav(_f: InputFrame): void {}
  /** Every frame while active (live input visuals). */
  live(_f: InputFrame): void {}
  /** Stage resized. */
  resize(): void {}
  /** Data (results / best laps / settings) changed while the screen exists. */
  refresh(): void {}
  dispose(): void {}

  activate(): void {
    this.shownAt = performance.now();
    this.el.classList.add('is-active');
  }

  deactivate(): void {
    this.el.classList.remove('is-active');
  }
}
