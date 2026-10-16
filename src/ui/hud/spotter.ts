/**
 * Proximity spotter: a light on the left or right edge of the screen while a car is alongside or closing within a car
 * length. The game hands over smoothed per-side levels (src/game/spotter.ts); this only draws them. Each side writes
 * two CSS variables, and only when the quantized value changes, so a quiet road costs nothing.
 */
import type { HudState } from '../../core/contracts';
import { h } from '../dom';

/** Steps per unit for the level and the position: coarse enough to skip most frames, fine enough to look continuous. */
const STEPS = 48;

class Side {
  readonly el: HTMLElement;
  private level = -1;
  private at = 99;
  private on = false;

  constructor(parent: HTMLElement, side: 'l' | 'r') {
    this.el = h('div', 'hud-spot ' + side, h('i', 'spot-trk'), h('i', 'spot-lit'));
    parent.appendChild(this.el);
  }

  set(level: number, at: number): void {
    const on = level > 0.012;
    if (on !== this.on) {
      this.on = on;
      this.el.classList.toggle('on', on);
    }
    if (!on) return;
    const l = Math.round(Math.min(1, level) * STEPS) / STEPS;
    const a = Math.round(Math.max(-1, Math.min(1, at)) * STEPS) / STEPS;
    if (l !== this.level) {
      this.level = l;
      this.el.style.setProperty('--lv', String(l));
    }
    if (a !== this.at) {
      this.at = a;
      this.el.style.setProperty('--at', String(a));
    }
  }
}

export class Spotter {
  private readonly left: Side;
  private readonly right: Side;
  private enabled = true;

  constructor(parent: HTMLElement) {
    this.left = new Side(parent, 'l');
    this.right = new Side(parent, 'r');
  }

  /** The Settings switch (the game also sends no data while it is off; this makes the HUD safe on its own). */
  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  update(s: HudState): void {
    const p = this.enabled ? s.spotter : null;
    if (!p) {
      this.left.set(0, 0);
      this.right.set(0, 0);
      return;
    }
    this.left.set(p.left, p.leftAt);
    this.right.set(p.right, p.rightAt);
  }
}
