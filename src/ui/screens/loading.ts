import type { ScreenId } from '../../core/systems';
import type { UiCtx } from '../ctx';
import { h } from '../dom';
import { formatLength } from '../format';
import { BaseScreen } from './base';

export const LOADING_TIPS: readonly string[] = [
  'Brake in a straight line, then ease off the brakes as you turn in. The front tires can only do one job at a time.',
  'The right trigger is analog. Squeeze the throttle out of slow corners instead of stamping on it.',
  'Cold tires grip far less. Weave gently on the formation lap to build some heat.',
  'Press D-pad down (or T) for live telemetry: tire temperatures, load, and the g-circle.',
  'In a rear-drive car, lifting off mid-corner shifts weight forward and can make the rear step out. Be smooth.',
  'Look through the corner, not at the wall. The car follows your eyes.',
  'Curbs are fast but they unsettle the car. Use the flat ones, avoid the tall ones.',
  'Rain, dusk and night change grip and visibility. Try the same track at a different time of day.',
  'Stability control is a safety net, not a crutch. Turn it down as your confidence grows.',
  'Hold RS in (or V) to look behind you before defending a position.',
  'Set a lap in Time Trial first. Your best lap becomes the delta on the HUD in every session.',
  'Downforce makes a car faster the faster it goes. Trust the prototype through the quick corners.',
];

export class LoadingScreen extends BaseScreen {
  readonly id = 'loading' as const;
  private readonly name = h('h1', 'load-name');
  private readonly place = h('div', 'load-place');
  private readonly facts = h('div', 'load-facts');
  private readonly label = h('div', 'load-label');
  private readonly pctEl = h('div', 'load-pct');
  private readonly fill = h('i');
  private readonly tip = h('div', 'load-tip');
  private readonly tipWrap = h('div', 'load-tipwrap', h('div', 'load-tipk', 'DRIVING TIP'), this.tip);
  private timer = 0;
  private tipIndex = 0;
  private fraction = 0;
  private glow = h('div', 'load-glow');

  constructor(ctx: UiCtx) {
    super(ctx, 'loading');
    this.el.append(
      h('div', 'load-bg'),
      this.glow,
      h('div', 'load-stripes'),
      h('div', 'scrim scrim-vignette'),
      h('div', 'load-head', h('div', 'kicker', 'LOADING'), this.name, this.place, this.facts),
      this.tipWrap,
      h('div', 'load-bar', h('div', 'load-meta', this.label, this.pctEl), h('div', 'load-track', this.fill)),
    );
    this.set(0, 'Preparing');
  }

  set(fraction: number, label: string): void {
    this.fraction = Math.min(1, Math.max(0, fraction));
    this.fill.style.transform = `scaleX(${this.fraction})`;
    this.pctEl.textContent = Math.round(this.fraction * 100) + '%';
    this.label.textContent = label;
  }

  private showTip(): void {
    this.tipWrap.classList.remove('show');
    window.setTimeout(() => {
      this.tip.textContent = LOADING_TIPS[this.tipIndex % LOADING_TIPS.length];
      this.tipIndex++;
      this.tipWrap.classList.add('show');
    }, 280);
  }

  enter(_from: ScreenId): void {
    const cfg = this.ctx.lastConfig;
    const track = cfg ? this.ctx.deps.tracks.find((t) => t.id === cfg.trackId) : undefined;
    const nm = track?.name ?? 'Xeno-Racer';
    this.name.textContent = nm;
    this.name.classList.toggle('long', nm.length > 14 && nm.length <= 22);
    this.name.classList.toggle('xlong', nm.length > 22);
    this.place.textContent = track?.location ?? '';
    this.facts.textContent = track ? `${formatLength(track.lengthHint, this.ctx.settings.units)}  ·  ${cfg?.mode === 'race' ? cfg.laps + (cfg.laps === 1 ? ' lap' : ' laps') : cfg?.mode === 'timeTrial' ? 'Time trial' : 'Free roam'}` : '';
    this.glow.style.setProperty('--accent', track?.color ?? '#16e0bd');
    this.tipIndex = Math.floor(Math.random() * LOADING_TIPS.length);
    this.tip.textContent = LOADING_TIPS[this.tipIndex % LOADING_TIPS.length];
    this.tipIndex++;
    this.tipWrap.classList.add('show');
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.showTip(), 5200);
  }

  leave(): void {
    window.clearInterval(this.timer);
  }

  dispose(): void {
    window.clearInterval(this.timer);
  }
}
