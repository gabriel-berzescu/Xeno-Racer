/**
 * Small DOM pieces shared by the championship screens (setup, standings, champion): condition chips,
 * movement arrows, position numerals.
 */
import type { EnvironmentSettings, Forecast } from '../core/contracts';
import { h } from './dom';
import { FORECAST_LABEL, TIME_OF_DAY_LABEL, WEATHER_LABEL } from './format';

const DARK = new Set(['dusk', 'night']);
const WET = new Set(['rain', 'storm']);

/**
 * Time of day and weather as two chips, and a third when the weather changes during the race; rain and low light get their own
 * tint so a calendar reads at a glance.
 */
export function conditionChips(env: EnvironmentSettings, small = false, forecast?: Forecast): HTMLElement {
  const sz = small ? ' sm' : '';
  return h(
    'span',
    'conds',
    h('span', 'chip' + sz + (DARK.has(env.timeOfDay) ? ' dusk' : ''), TIME_OF_DAY_LABEL[env.timeOfDay] ?? env.timeOfDay),
    h('span', 'chip' + sz + (WET.has(env.weather) ? ' rain' : ''), WEATHER_LABEL[env.weather] ?? env.weather),
    forecast && forecast !== 'stable' ? h('span', 'chip' + sz + ' rain', FORECAST_LABEL[forecast] ?? forecast) : null,
  );
}

/** Places gained (green arrow up), lost (red arrow down) or held (dash) since the previous round; blank when unknown. */
export function moveBadge(move: number | null): HTMLElement {
  if (move === null) return h('span', 'mv none');
  if (move === 0) return h('span', 'mv even', h('i'));
  return h('span', 'mv ' + (move > 0 ? 'up' : 'down'), h('i'), String(Math.abs(move)));
}

/** "1".."n" with a medal tint for the podium. */
export function positionCell(position: number, cls = 'c-pos'): HTMLElement {
  const el = h('span', cls);
  setPosition(el, position, cls);
  return el;
}

/** Re-labels a position cell in place (the standings re-sort while on screen). */
export function setPosition(el: HTMLElement, position: number, cls = 'c-pos'): void {
  el.className = cls + (position <= 3 ? ` p${position}` : '');
  el.textContent = String(position);
}
