/**
 * Canvas drawing for track maps (track-select preview and the HUD minimap).
 * World XZ -> canvas: +X to the right, +Z down the screen (an un-mirrored top view).
 */
import type { MinimapTrack } from '../core/contracts';
import { COLORS, fitBounds, mapX, mapY, type MapFit } from './hudlogic';

export interface MapStyle {
  /** Dark edge drawn under the road. */
  outline: string;
  body: string;
  /** Minimum / maximum road stroke in CSS px. */
  minWidth: number;
  maxWidth: number;
  /** Extra stroke added for the outline on each side. */
  edge: number;
}

export const HUD_MAP_STYLE: MapStyle = { outline: 'rgba(3,4,7,0.88)', body: 'rgba(238,240,243,0.82)', minWidth: 4, maxWidth: 7, edge: 2.5 };
export const MENU_MAP_STYLE: MapStyle = { outline: 'rgba(3,4,7,0.9)', body: 'rgba(238,240,243,0.92)', minWidth: 5, maxWidth: 10, edge: 3 };

/** Size a canvas for crisp output: backing store = css size x pxScale. Returns its 2D context. */
export function sizeCanvas(c: HTMLCanvasElement, cssW: number, cssH: number, pxScale: number): CanvasRenderingContext2D {
  const w = Math.max(1, Math.round(cssW * pxScale));
  const h = Math.max(1, Math.round(cssH * pxScale));
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  c.style.width = cssW + 'px';
  c.style.height = cssH + 'px';
  const g = c.getContext('2d')!;
  g.setTransform(pxScale, 0, 0, pxScale, 0, 0);
  return g;
}

export function trackPath(g: CanvasRenderingContext2D, map: MinimapTrack, fit: MapFit): void {
  const p = map.points;
  g.beginPath();
  for (let i = 0; i < p.length; i++) {
    const x = mapX(fit, p[i].x);
    const y = mapY(fit, p[i].z);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
}

/** Perpendicular tick at point index `i` (start line / sector markers). */
function tick(g: CanvasRenderingContext2D, map: MinimapTrack, fit: MapFit, i: number, half: number, color: string, width: number): void {
  const n = map.points.length;
  if (n < 3) return;
  const a = map.points[(i - 1 + n) % n];
  const b = map.points[(i + 1) % n];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len;
  const nz = dx / len;
  const c = map.points[((i % n) + n) % n];
  const cx = mapX(fit, c.x);
  const cy = mapY(fit, c.z);
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineCap = 'butt';
  g.beginPath();
  g.moveTo(cx - nx * half, cy - nz * half);
  g.lineTo(cx + nx * half, cy + nz * half);
  g.stroke();
}

/** Draws the static track (road + start line + sector ticks) into a w x h CSS-px box. */
export function drawTrack(g: CanvasRenderingContext2D, map: MinimapTrack, w: number, h: number, pad: number, style: MapStyle, fit: MapFit): void {
  fitBounds(map.bounds, w, h, pad, fit);
  const roadW = Math.min(style.maxWidth, Math.max(style.minWidth, map.width * fit.scale));
  g.lineJoin = 'round';
  g.lineCap = 'round';
  trackPath(g, map, fit);
  g.strokeStyle = style.outline;
  g.lineWidth = roadW + style.edge * 2;
  g.stroke();
  trackPath(g, map, fit);
  g.strokeStyle = style.body;
  g.lineWidth = roadW;
  g.stroke();
  // sector ticks
  const half = roadW / 2 + 5;
  tick(g, map, fit, map.sectorIndices[0], half, COLORS.teal, 2.5);
  tick(g, map, fit, map.sectorIndices[1], half, COLORS.teal, 2.5);
  // start / finish: a white bar with a pink cap
  tick(g, map, fit, map.startIndex, half + 2, '#ffffff', 4);
  tick(g, map, fit, map.startIndex, half + 2, COLORS.pink, 1.5);
}

const PULSE_COLORS: string[] = [];
for (let i = 0; i < 24; i++) PULSE_COLORS.push(`rgba(22,224,189,${(0.55 * (1 - i / 24)).toFixed(3)})`);

/** A car marker. heading = atan2(forward.x, forward.z) in world XZ. */
export function drawCarDot(g: CanvasRenderingContext2D, x: number, y: number, heading: number, color: string, player: boolean, nowMs: number): void {
  const fx = Math.sin(heading);
  const fy = Math.cos(heading);
  if (player) {
    const pulse = (nowMs % 1400) / 1400;
    g.beginPath();
    g.arc(x, y, 8 + pulse * 11, 0, Math.PI * 2);
    g.strokeStyle = PULSE_COLORS[Math.min(23, Math.floor(pulse * 24))];
    g.lineWidth = 2;
    g.stroke();
    g.save();
    g.translate(x, y);
    g.rotate(Math.atan2(fx, -fy));
    g.beginPath();
    g.moveTo(0, -11);
    g.lineTo(7.5, 8);
    g.lineTo(0, 4);
    g.lineTo(-7.5, 8);
    g.closePath();
    g.fillStyle = COLORS.teal;
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = '#03211b';
    g.stroke();
    g.restore();
    return;
  }
  g.beginPath();
  g.arc(x, y, 5.2, 0, Math.PI * 2);
  g.fillStyle = color;
  g.fill();
  g.lineWidth = 1.6;
  g.strokeStyle = 'rgba(3,4,7,0.92)';
  g.stroke();
}
