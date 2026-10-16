import type { ScreenId } from '../../core/systems';
import type { UiCtx } from '../ctx';
import { clearEl, h } from '../dom';
import { formatConditions, formatLength, lapsLabel } from '../format';
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
  'When rain is on the way the track does not wet at once: it takes a lap or two. The first drops are your cue to brake earlier and keep off the kerbs.',
  'Stability control is a safety net, not a crutch. Turn it down as your confidence grows.',
  'Hold RS in (or V) to look behind you before defending a position.',
  'Set a lap in Time Trial first. Your best lap becomes the delta on the HUD in every session.',
  'Downforce makes a car faster the faster it goes. Trust the prototype through the quick corners.',
];

/** Shown first on the loading screen of a championship round (mixed in with the general ones). */
export const CHAMPIONSHIP_TIPS: readonly string[] = [
  'Every point counts. A clean finish in the top ten beats a risky move that ends in the wall.',
  'The quickest lap of a race is worth a bonus point, but only if you finish in the points.',
  'From round 2 the grid is set by the standings: points earned now buy a better start later.',
  'The night and wet rounds are where a season is won. Brake earlier, stay off the kerbs and be smooth.',
  'Quit to the menu and the round does not count, but your season is saved. Pick it up from the Championship entry.',
];

export class LoadingScreen extends BaseScreen {
  readonly id = 'loading' as const;
  private readonly kicker = h('div', 'kicker', 'LOADING');
  private readonly name = h('h1', 'load-name');
  private readonly place = h('div', 'load-place');
  private readonly facts = h('div', 'load-facts');
  /** One pip per round of a championship: done, this one, still to come. */
  private readonly rounds = h('div', 'load-rounds');
  private readonly label = h('div', 'load-label');
  private readonly pctEl = h('div', 'load-pct');
  private readonly fill = h('i');
  private readonly tip = h('div', 'load-tip');
  private readonly tipWrap = h('div', 'load-tipwrap', h('div', 'load-tipk', 'DRIVING TIP'), this.tip);
  private timer = 0;
  private tipIndex = 0;
  private tips: readonly string[] = LOADING_TIPS;
  private fraction = 0;
  private glow = h('div', 'load-glow');

  constructor(ctx: UiCtx) {
    super(ctx, 'loading');
    this.el.append(
      h('div', 'load-bg'),
      this.glow,
      h('div', 'load-stripes'),
      h('div', 'scrim scrim-vignette'),
      h('div', 'load-head', this.kicker, this.name, this.place, this.facts, this.rounds),
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
      this.tip.textContent = this.tips[this.tipIndex % this.tips.length];
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
    const ch = cfg?.championship;
    this.kicker.textContent = ch ? `${ch.name}  ·  Round ${ch.round} / ${ch.rounds}` : 'LOADING';
    this.facts.textContent = track
      ? ch && cfg
        ? `${formatLength(track.lengthHint, this.ctx.settings.units)}  ·  ${lapsLabel(cfg.laps)}  ·  ${formatConditions(cfg.environment)}`
        : `${formatLength(track.lengthHint, this.ctx.settings.units)}  ·  ${cfg?.mode === 'race' ? cfg.laps + (cfg.laps === 1 ? ' lap' : ' laps') : cfg?.mode === 'timeTrial' ? 'Time trial' : 'Free roam'}${cfg?.forecast ? '  ·  ' + formatConditions(cfg.environment, cfg.forecast) : ''}`
      : '';
    clearEl(this.rounds);
    this.rounds.style.display = ch ? '' : 'none';
    if (ch) for (let i = 1; i <= ch.rounds; i++) this.rounds.appendChild(h('i', i < ch.round ? 'done' : i === ch.round ? 'now' : null));
    this.glow.style.setProperty('--accent', track?.color ?? '#16e0bd');
    // a championship round leads with its own advice
    this.tips = ch ? [...CHAMPIONSHIP_TIPS, ...LOADING_TIPS] : LOADING_TIPS;
    this.tipIndex = ch ? Math.floor(Math.random() * CHAMPIONSHIP_TIPS.length) : Math.floor(Math.random() * this.tips.length);
    this.tip.textContent = this.tips[this.tipIndex % this.tips.length];
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
