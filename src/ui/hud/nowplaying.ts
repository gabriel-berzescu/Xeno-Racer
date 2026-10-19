/**
 * The "now playing" card: when a song of the race music starts, a small card says what it is for a few seconds, and goes.
 *
 *   ♪ NEON OVERDRIVE
 *   Cyberpunk · Xeno-Racer Vol. 1
 *
 * It sits in the HUD of the first seat only (a split screen shows it once, in player 1's view, scaled with that view), apart from
 * everything else the HUD puts on screen, and leaves with the HUD (the H key, the pause menu, the results). Written to the DOM only
 * when a song changes; no timer runs while it is hidden.
 */
import type { NowPlaying } from '../../core/contracts';
import { h } from '../dom';
import { nowPlayingLines } from '../format';

/** How long the card stays up (ms). */
export const NOW_PLAYING_MS = 5000;

export class NowPlayingCard {
  readonly el: HTMLElement;
  private readonly title = h('span', 'np-name');
  private readonly sub = h('div', 'np-sub');
  private timer = 0;

  constructor(parent: HTMLElement) {
    this.el = h('div', 'hud-np', h('i', 'np-bar'), h('div', 'np-txt', h('div', 'np-title', h('span', 'np-note', '♪'), this.title), this.sub));
    parent.appendChild(this.el);
  }

  /** A song has started: show it (again, if the card was up for the one before). */
  show(np: NowPlaying, ms = NOW_PLAYING_MS): void {
    const t = nowPlayingLines(np);
    this.title.textContent = t.title;
    this.sub.textContent = t.sub;
    this.el.classList.add('show');
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.hide(), ms);
  }

  hide(): void {
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.el.classList.remove('show');
  }

  get shown(): boolean {
    return this.el.classList.contains('show');
  }
}
