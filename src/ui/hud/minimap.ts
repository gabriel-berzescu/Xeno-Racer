/**
 * HUD minimap: north-up, whole circuit. The road is rendered once into an offscreen canvas when the
 * track changes; every frame only composites it and draws the car markers.
 */
import type { HudState, MinimapTrack, Seat } from '../../core/contracts';
import { h } from '../dom';
import { isOwn, mapX, mapY, minimapOrder, type MapFit } from '../hudlogic';
import { drawCarDot, drawOtherHumanDot, drawTrack, HUD_MAP_STYLE, sizeCanvas } from '../trackmap';

const W = 296;
const MAX_H = 276;
const MIN_H = 176;
const PAD = 26;

export class HudMinimap {
  readonly el: HTMLElement;
  private readonly canvas = h('canvas', 'map-canvas');
  private readonly layer = document.createElement('canvas');
  private g: CanvasRenderingContext2D | null = null;
  private map: MinimapTrack | null = null;
  private readonly fit: MapFit = { scale: 1, ox: 0, oy: 0, minX: 0, minZ: 0 };
  private px = 1;
  private hh = MAX_H;
  private enabled = true;
  private shown = false;
  /** Split screen: whose view this map is in (null: single player), and the draw order of the cars (hudlogic minimapOrder). */
  private seat: Seat | null = null;
  private readonly order = new Int16Array(64);

  constructor(parent: HTMLElement) {
    this.el = h('div', 'hud-map', this.canvas);
    this.el.style.display = 'none';
    parent.appendChild(this.el);
    this.resize(1);
  }

  setMap(m: MinimapTrack | null): void {
    this.map = m;
    if (m) {
      // panel height follows the circuit's aspect ratio (wide tracks need less height)
      const bw = Math.max(1, m.bounds.maxX - m.bounds.minX);
      const bh = Math.max(1, m.bounds.maxZ - m.bounds.minZ);
      this.hh = Math.round(Math.min(MAX_H, Math.max(MIN_H, ((W - 2 * PAD) * bh) / bw + 2 * PAD)));
    } else {
      this.hh = MAX_H;
    }
    this.el.style.height = this.hh + 'px';
    this.g = sizeCanvas(this.canvas, W, this.hh, this.px);
    this.renderLayer();
    this.sync();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.sync();
  }

  /** Whose view the map is in: the viewer's own car is the pulsing arrow in their colour, the other human a ringed arrow in theirs. */
  setSeat(seat: Seat | null): void {
    this.seat = seat;
  }

  private sync(): void {
    const show = this.enabled && this.map !== null;
    if (show !== this.shown) {
      this.shown = show;
      this.el.style.display = show ? '' : 'none';
    }
  }

  resize(px: number): void {
    this.px = px;
    this.g = sizeCanvas(this.canvas, W, this.hh, px);
    this.renderLayer();
  }

  private renderLayer(): void {
    const g = sizeCanvas(this.layer, W, this.hh, this.px);
    g.clearRect(0, 0, W, this.hh);
    if (this.map) drawTrack(g, this.map, W, this.hh, PAD, HUD_MAP_STYLE, this.fit);
  }

  update(s: HudState, now: number): void {
    const g = this.g;
    if (!g || !this.shown || !this.map) return;
    g.clearRect(0, 0, W, this.hh);
    g.drawImage(this.layer, 0, 0, W, this.hh);
    const cars = s.cars;
    const seat = this.seat;
    const n = minimapOrder(cars, seat, this.order);
    for (let k = 0; k < n; k++) {
      const c = cars[this.order[k]];
      const x = mapX(this.fit, c.x);
      const y = mapY(this.fit, c.z);
      if (!c.isPlayer) drawCarDot(g, x, y, c.heading, c.color, false, now);
      else if (isOwn(c, seat)) drawCarDot(g, x, y, c.heading, c.color, true, now, seat ?? 0);
      else drawOtherHumanDot(g, x, y, c.heading, c.seat ?? 1);
    }
  }
}
