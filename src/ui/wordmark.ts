/**
 * The XENO-RACER wordmark, built from CSS + one inline SVG slash. Sized by `--fs` on `.wm`.
 *
 * Heavy italic caps; XENO in cool white, RACER in brand teal, a hot-pink slash between them, a
 * thin stencil cut through the letters and a teal / pink speed rule underneath.
 */
import { h, svgFrom } from './dom';

export function wordmark(): HTMLElement {
  const xeno = h('span', 'wm-xeno', 'XENO');
  const racer = h('span', 'wm-racer', 'RACER');
  const slash = svgFrom('<svg class="wm-slash" viewBox="0 0 60 120" aria-hidden="true"><path d="M36 0h24L24 120H0z" fill="#ff2e63"/></svg>');
  const el = h('div', 'wm', h('div', 'wm-row', xeno, slash, racer), h('div', 'wm-rule'));
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'Xeno-Racer');
  return el;
}
