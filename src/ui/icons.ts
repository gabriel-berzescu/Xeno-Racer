/**
 * Inline SVG icons (single colour via currentColor).
 */
import { svgFrom } from './dom';

const wrap = (vb: string, body: string, cls = ''): SVGElement => svgFrom(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" class="${cls}" fill="currentColor" aria-hidden="true">${body}</svg>`);

export const iconGamepad = (cls = ''): SVGElement =>
  wrap(
    '0 0 48 32',
    '<path d="M13 2h22c6 0 9 4 11 12l2 11c1 4-1 7-4 7-2 0-4-1-5-3l-3-5H13l-3 5c-1 2-3 3-5 3-3 0-5-3-4-7l2-11C4 6 7 2 13 2z"/>' +
      '<path fill="#0b0c10" fill-opacity=".55" d="M12 9h4v3h3v4h-3v3h-4v-3H9v-4h3z"/>' +
      '<circle fill="#0b0c10" fill-opacity=".55" cx="35" cy="10" r="2.6"/><circle fill="#0b0c10" fill-opacity=".55" cx="40" cy="15" r="2.6"/>' +
      '<circle fill="#0b0c10" fill-opacity=".55" cx="30" cy="15" r="2.6"/><circle fill="#0b0c10" fill-opacity=".55" cx="35" cy="20" r="2.6"/>',
    cls,
  );

export const iconKeyboard = (cls = ''): SVGElement =>
  wrap(
    '0 0 48 32',
    '<rect x="2" y="5" width="44" height="22" rx="4"/>' +
      '<g fill="#0b0c10" fill-opacity=".55"><rect x="6" y="9" width="5" height="4" rx="1"/><rect x="13" y="9" width="5" height="4" rx="1"/><rect x="20" y="9" width="5" height="4" rx="1"/><rect x="27" y="9" width="5" height="4" rx="1"/><rect x="34" y="9" width="8" height="4" rx="1"/>' +
      '<rect x="6" y="15" width="8" height="4" rx="1"/><rect x="16" y="15" width="5" height="4" rx="1"/><rect x="23" y="15" width="5" height="4" rx="1"/><rect x="30" y="15" width="12" height="4" rx="1"/><rect x="12" y="21" width="24" height="3" rx="1"/></g>',
    cls,
  );

export const iconTrophy = (cls = ''): SVGElement =>
  wrap('0 0 32 32', '<path d="M9 3h14v3h5v4c0 4-3 7-7 7.5-.8 2-2.2 3.4-4 4V25h5v4H10v-4h5v-3.5c-1.8-.6-3.2-2-4-4C7 17 4 14 4 10V6h5V3zm-2 6v1c0 2 1 3.6 3 4.4V9H7zm18 0h-3v5.4c2-.8 3-2.4 3-4.4V9z"/>', cls);

export const iconFlag = (cls = ''): SVGElement =>
  wrap('0 0 32 32', '<path d="M6 3h2v26H6zM10 4h16l-3 6 3 6H10z"/>', cls);

export const iconPlay = (cls = ''): SVGElement => wrap('0 0 32 32', '<path d="M9 5l18 11L9 27z"/>', cls);

export const iconRestart = (cls = ''): SVGElement =>
  wrap('0 0 32 32', '<path d="M16 5a11 11 0 1 0 11 11h-4a7 7 0 1 1-7-7v5l8-7-8-7z"/>', cls);

export const iconReplay = (cls = ''): SVGElement =>
  wrap('0 0 32 32', '<path d="M4 8h16a8 8 0 0 1 0 16H8v-4h12a4 4 0 0 0 0-8H4l5 5-3 3-9-9 9-9 3 3z" transform="translate(3 -1)"/>', cls);

export const iconBack = (cls = ''): SVGElement => wrap('0 0 32 32', '<path d="M20 4l-12 12 12 12 3-3-9-9 9-9z"/>', cls);

export const iconCheck = (cls = ''): SVGElement => wrap('0 0 32 32', '<path d="M12 22.5L5.5 16l-3 3L12 28.5 29.5 11l-3-3z"/>', cls);

export const iconClose = (cls = ''): SVGElement => wrap('0 0 32 32', '<path d="M7 4l9 9 9-9 3 3-9 9 9 9-3 3-9-9-9 9-3-3 9-9-9-9z"/>', cls);

export const iconWarn = (cls = ''): SVGElement => wrap('0 0 32 32', '<path d="M16 3l14 25H2zm-2 9v8h4v-8zm0 10v4h4v-4z"/>', cls);

export const iconClock = (cls = ''): SVGElement =>
  wrap('0 0 32 32', '<path d="M16 3a13 13 0 1 0 0 26 13 13 0 0 0 0-26zm-1.5 5h3v8.2l5 3-1.5 2.6-6.5-3.9z"/>', cls);

// ── weather (the HUD's conditions chip and its notices) ──────────────────────────────────────────────────────────────

/** A cloud, low in the box so that rain or a bolt can hang under it. */
const CLOUD = '<path d="M9 20.5a5.5 5.5 0 0 1-.9-10.9 7.5 7.5 0 0 1 14.3-1.7A6.3 6.3 0 0 1 23 20.5z"/>';
const LINES = (d: string): string => `<path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="${d}"/>`;

export const iconCloud = (cls = ''): SVGElement => wrap('0 0 32 32', '<g transform="translate(0 4)">' + CLOUD + '</g>', cls);

export const iconRain = (cls = ''): SVGElement => wrap('0 0 32 32', CLOUD + LINES('M10 24.5l-1.6 4M16 24.5l-1.6 4M22 24.5l-1.6 4'), cls);

export const iconStorm = (cls = ''): SVGElement => wrap('0 0 32 32', CLOUD + '<path d="M17.4 21.5l-5 6.6h3.3l-1.4 4.4 6.2-7.6h-3.6l2.1-3.4z"/>', cls);

export const iconSun = (cls = ''): SVGElement =>
  wrap('0 0 32 32', '<circle cx="16" cy="16" r="5.8"/>' + LINES('M16 3.5v3M16 25.5v3M3.5 16h3M25.5 16h3M7.2 7.2l2.1 2.1M22.7 22.7l2.1 2.1M7.2 24.8l2.1-2.1M22.7 9.3l2.1-2.1'), cls);

/** The sun coming out from behind a cloud: the rain easing, the sky lifting. */
export const iconSunCloud = (cls = ''): SVGElement =>
  wrap('0 0 32 32', '<circle cx="21" cy="11" r="4.6"/>' + LINES('M21 2.4v2M28.6 11h2M21 19.6v2M13.4 11h-2M26.2 5.8l1.4-1.4M15.8 5.8l-1.4-1.4M26.2 16.2l1.4 1.4') + '<g transform="translate(-1.5 7) scale(0.92)">' + CLOUD + '</g>', cls);
