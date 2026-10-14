/**
 * Telemetry overlay (shown when `HudState.showTelemetry`): four tire widgets (slip as colour, tread
 * temperature, load), a g-meter with a fading trail, and scrolling throttle / brake / steering traces.
 *
 * Conventions assumed from HudState: tires[i].slip is 0 (gripping) .. 1 (at the limit) and can exceed 1;
 * load is a fraction of static load (1 = static); gLat > 0 = left, gLong > 0 = accelerating. The g-meter
 * plots the acceleration vector (dot moves toward the direction the car is being pushed by its tires:
 * left in a left turn, up when accelerating).
 */
import type { HudState } from '../../core/contracts';
import { Bar, h, StyleSlot, Txt } from '../dom';
import { COLORS, RingBuf, slipColor, tempColor, TrailBuf, clamp, clamp01 } from '../hudlogic';
import { sizeCanvas } from '../trackmap';

const G_SIZE = 268;
const G_MAX = 2; // g at the outer ring
const G_R = 118;
const TR_W = 480;
const TR_H = 132;
const TR_N = 480; // samples (8 s at 60 Hz)
const TRAIL_N = 80;
const SAMPLE_MS = 16;
const TIRE_NAMES = ['FL', 'FR', 'RL', 'RR'];
/** Trail stroke colours by age (index = sample position / TRAIL_N), built once. */
const TRAIL_COLORS: string[] = [];
for (let i = 0; i <= TRAIL_N; i++) {
  const a = i / TRAIL_N;
  TRAIL_COLORS.push(`rgba(22,224,189,${(a * a * 0.85).toFixed(3)})`);
}

interface TireCard {
  el: HTMLElement;
  temp: Txt;
  tempEl: HTMLElement;
  slip: Bar;
  slipFill: HTMLElement;
  load: Bar;
  tempQ: number;
  slipQ: number;
  tempC: string;
  slipC: string;
  tempCol: StyleSlot;
  slipCol: StyleSlot;
}

export class Telemetry {
  readonly tires: HTMLElement;
  readonly gmeter: HTMLElement;
  readonly traces: HTMLElement;
  private readonly cards: TireCard[] = [];

  private readonly gCanvas = h('canvas', 'g-canvas');
  private readonly latTxt: Txt;
  private readonly lonTxt: Txt;
  private lastLat = -99;
  private lastLon = -99;
  private readonly trail = new TrailBuf(TRAIL_N);
  private gG: CanvasRenderingContext2D | null = null;

  private readonly trCanvas = h('canvas', 'tr-canvas');
  private trG: CanvasRenderingContext2D | null = null;
  private readonly thr = new RingBuf(TR_N);
  private readonly brk = new RingBuf(TR_N);
  private readonly str = new RingBuf(TR_N);
  private readonly abs = new RingBuf(TR_N);
  private lastSample = 0;
  private peakL = 0;
  private peakR = 0;

  constructor(parent: HTMLElement) {
    // tires: 2x2 cards around a car outline
    const grid = h('div', 'tire-grid');
    for (let i = 0; i < 4; i++) {
      const tempEl = h('span', 'tc-temp');
      const unit = h('span', 'tc-unit', '°');
      const slipFill = h('i');
      const loadFill = h('i');
      const card = h(
        'div',
        `tire-card t${i}`,
        h('div', 'tc-head', h('span', 'tc-name', TIRE_NAMES[i])),
        h('div', 'tc-t', tempEl, unit),
        h('div', 'tc-slip', slipFill),
        h('div', 'tc-load', h('div', 'tc-load-trk', loadFill, h('b'))),
      );
      grid.appendChild(card);
      this.cards.push({
        el: card, temp: new Txt(tempEl, '--'), tempEl, slip: new Bar(slipFill, 'X', 0.02), slipFill, load: new Bar(loadFill, 'Y', 0.02),
        tempQ: -1, slipQ: -1, tempC: '', slipC: '', tempCol: new StyleSlot(tempEl, 'color'), slipCol: new StyleSlot(slipFill, 'background'),
      });
    }
    const car = h('div', 'tire-car', h('i', 'tc-body'), h('i', 'tc-cabin'));
    this.tires = h('div', 'hud-tires', h('div', 'tele-k', 'TIRES'), h('div', 'tire-wrap', car, grid), h('div', 'tire-legend', h('span', null, 'TEMP \u00b0C'), h('i'), h('span', null, 'SLIP'), h('i'), h('span', null, 'LOAD')));

    // g-meter
    const lat = h('span', 'g-v');
    const lon = h('span', 'g-v');
    this.latTxt = new Txt(lat, '0.00');
    this.lonTxt = new Txt(lon, '0.00');
    this.gmeter = h('div', 'hud-gmeter', h('div', 'tele-k', 'G-FORCE'), this.gCanvas, h('div', 'g-read', h('div', 'g-cell', h('span', 'g-k', 'LAT'), lat), h('i', 'g-div'), h('div', 'g-cell', h('span', 'g-k', 'LONG'), lon), h('span', 'g-u', 'g')));

    // traces
    this.traces = h('div', 'hud-traces', h('div', 'tr-legend', h('span', 'thr', 'THROTTLE'), h('span', 'brk', 'BRAKE'), h('span', 'str', 'STEERING'), h('span', 'abs', 'ABS')), this.trCanvas);

    parent.append(this.tires, this.gmeter, this.traces);
    this.resize(1);
  }

  resize(px: number): void {
    this.gG = sizeCanvas(this.gCanvas, G_SIZE, G_SIZE, px);
    this.trG = sizeCanvas(this.trCanvas, TR_W, TR_H, px);
  }

  setVisible(v: boolean): void {
    const d = v ? '' : 'none';
    this.tires.style.display = d;
    this.gmeter.style.display = d;
    this.traces.style.display = d;
    if (v) this.clear();
  }

  clear(): void {
    this.thr.clear();
    this.brk.clear();
    this.str.clear();
    this.abs.clear();
    this.trail.clear();
    this.peakL = this.peakR = 0;
    this.lastSample = 0;
  }

  update(s: HudState, now: number): void {
    // ── tires ──
    for (let i = 0; i < 4; i++) {
      const t = s.tires[i];
      if (!t) continue;
      const c = this.cards[i];
      const tq = Math.round(t.tempC);
      if (tq !== c.tempQ) {
        c.tempQ = tq;
        c.temp.set(String(tq));
        c.tempCol.set(tempColor(t.tempC));
      }
      const slip = clamp(t.slip, 0, 1.2);
      c.slip.set(Math.min(1, slip));
      const sq = Math.round(slip * 24);
      if (sq !== c.slipQ) {
        c.slipQ = sq;
        c.slipCol.set(slipColor(slip));
      }
      c.load.set(clamp01(t.load / 2));
    }

    // ── sampling for the graphs (time-based so the window length is frame-rate independent) ──
    if (now - this.lastSample >= SAMPLE_MS) {
      this.lastSample = now;
      this.thr.push(s.throttle);
      this.brk.push(s.brake);
      this.str.push(s.steer);
      this.abs.push(s.absActive ? 1 : 0);
      this.trail.push(-s.gLat, -s.gLong); // screen space: +x right, +y down
    }
    this.peakL = Math.max(this.peakL * 0.9985, Math.max(0, s.gLat));
    this.peakR = Math.max(this.peakR * 0.9985, Math.max(0, -s.gLat));

    this.drawG(s);
    this.drawTraces(s);

    const lq = Math.round(s.gLat * 100);
    if (lq !== this.lastLat) {
      this.lastLat = lq;
      this.latTxt.set((s.gLat >= 0 ? '+' : '') + (lq / 100).toFixed(2));
    }
    const oq = Math.round(s.gLong * 100);
    if (oq !== this.lastLon) {
      this.lastLon = oq;
      this.lonTxt.set((s.gLong >= 0 ? '+' : '') + (oq / 100).toFixed(2));
    }
  }

  // ── g-meter ────────────────────────────────────────────────────────────────

  private drawG(s: HudState): void {
    const g = this.gG;
    if (!g) return;
    const cx = G_SIZE / 2;
    const cy = G_SIZE / 2;
    const k = G_R / G_MAX;
    g.clearRect(0, 0, G_SIZE, G_SIZE);
    // disc
    g.beginPath();
    g.arc(cx, cy, G_R + 8, 0, Math.PI * 2);
    g.fillStyle = 'rgba(4,5,8,0.5)';
    g.fill();
    // rings
    for (let i = 1; i <= 4; i++) {
      g.beginPath();
      g.arc(cx, cy, k * i * 0.5, 0, Math.PI * 2);
      g.strokeStyle = i === 2 ? 'rgba(238,240,243,0.38)' : 'rgba(238,240,243,0.16)';
      g.lineWidth = i === 2 ? 1.8 : 1.2;
      g.stroke();
    }
    g.strokeStyle = 'rgba(238,240,243,0.18)';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(cx - G_R - 4, cy);
    g.lineTo(cx + G_R + 4, cy);
    g.moveTo(cx, cy - G_R - 4);
    g.lineTo(cx, cy + G_R + 4);
    g.stroke();
    // ring labels
    g.font = '600 14px Oxanium, sans-serif';
    g.fillStyle = 'rgba(238,240,243,0.5)';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText('1g', cx + k + 4, cy - 9);
    g.fillText('2g', cx + k * 2 - 22, cy - 9);
    // peak ticks (left / right)
    const pl = Math.min(G_MAX, this.peakL) * k;
    const pr = Math.min(G_MAX, this.peakR) * k;
    g.strokeStyle = 'rgba(255,176,32,0.85)';
    g.lineWidth = 3;
    g.beginPath();
    if (pl > 4) {
      g.moveTo(cx - pl, cy - 9);
      g.lineTo(cx - pl, cy + 9);
    }
    if (pr > 4) {
      g.moveTo(cx + pr, cy - 9);
      g.lineTo(cx + pr, cy + 9);
    }
    g.stroke();
    // trail
    const n = this.trail.count;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (let i = 1; i < n; i++) {
      const a = i / n;
      g.strokeStyle = TRAIL_COLORS[Math.round(a * TRAIL_N)];
      g.lineWidth = 1.5 + a * 4.5;
      g.beginPath();
      g.moveTo(cx + this.trail.x(i - 1) * k, cy + this.trail.y(i - 1) * k);
      g.lineTo(cx + this.trail.x(i) * k, cy + this.trail.y(i) * k);
      g.stroke();
    }
    // dot
    const mag = Math.hypot(s.gLat, s.gLong);
    const px = cx + clamp(-s.gLat, -G_MAX, G_MAX) * k;
    const py = cy + clamp(-s.gLong, -G_MAX, G_MAX) * k;
    g.beginPath();
    g.arc(px, py, 9.5, 0, Math.PI * 2);
    g.fillStyle = '#fff';
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = mag > 1.5 ? COLORS.pink : mag > 1.1 ? COLORS.warn : COLORS.teal;
    g.stroke();
  }

  // ── traces ─────────────────────────────────────────────────────────────────

  private drawTraces(s: HudState): void {
    const g = this.trG;
    if (!g) return;
    const padL = 6;
    const padR = 8;
    const w = TR_W - padL - padR;
    const pedTop = 6;
    const pedH = 66;
    const strTop = 82;
    const strH = 40;
    g.clearRect(0, 0, TR_W, TR_H);
    // lanes
    g.fillStyle = 'rgba(255,255,255,0.045)';
    g.fillRect(padL, pedTop, w, pedH);
    g.fillRect(padL, strTop, w, strH);
    g.strokeStyle = 'rgba(238,240,243,0.14)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(padL, pedTop + pedH / 2);
    g.lineTo(padL + w, pedTop + pedH / 2);
    g.moveTo(padL, strTop + strH / 2);
    g.lineTo(padL + w, strTop + strH / 2);
    g.stroke();

    const n = this.thr.count;
    if (n < 2) return;
    const dx = w / (TR_N - 1);
    const x0 = padL + w - (n - 1) * dx;
    // throttle area
    this.area(g, this.thr, n, x0, dx, pedTop + pedH, pedH, 'rgba(22,224,189,0.55)', COLORS.teal);
    // brake area (over it)
    this.area(g, this.brk, n, x0, dx, pedTop + pedH, pedH, 'rgba(255,46,99,0.55)', COLORS.pink);
    // ABS ticks along the top of the pedal lane
    g.fillStyle = COLORS.warn;
    for (let i = 0; i < n; i++) if (this.abs.at(i) > 0) g.fillRect(x0 + i * dx - 0.5, pedTop, Math.max(1.5, dx + 0.5), 4);
    // steering line
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = x0 + i * dx;
      const y = strTop + strH / 2 - this.str.at(i) * (strH / 2 - 3);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.lineWidth = 2.4;
    g.strokeStyle = 'rgba(238,240,243,0.95)';
    g.lineJoin = 'round';
    g.stroke();
    // "now" cursor + heads
    const nx = padL + w;
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(nx, pedTop);
    g.lineTo(nx, strTop + strH);
    g.stroke();
    this.head(g, nx, pedTop + pedH - s.throttle * (pedH - 2), COLORS.teal);
    this.head(g, nx, pedTop + pedH - s.brake * (pedH - 2), COLORS.pink);
    this.head(g, nx, strTop + strH / 2 - s.steer * (strH / 2 - 3), '#ffffff');
  }

  private area(g: CanvasRenderingContext2D, buf: RingBuf, n: number, x0: number, dx: number, base: number, hgt: number, fill: string, line: string): void {
    g.beginPath();
    g.moveTo(x0, base);
    for (let i = 0; i < n; i++) g.lineTo(x0 + i * dx, base - buf.at(i) * (hgt - 2));
    g.lineTo(x0 + (n - 1) * dx, base);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = x0 + i * dx;
      const y = base - buf.at(i) * (hgt - 2);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokeStyle = line;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.stroke();
  }

  private head(g: CanvasRenderingContext2D, x: number, y: number, color: string): void {
    g.beginPath();
    g.arc(x, y, 4.2, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
  }
}
