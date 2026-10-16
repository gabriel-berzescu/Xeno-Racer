/**
 * Bottom-right instrument cluster: segmented rev arc, shift LEDs, speed, gear, throttle / brake bars and
 * ABS / TCS / ESC lights, and the braking assist's cue (the part of the brake bar it adds is blue, and a pill says so). DOM text is written only when it changes; bars use transforms; the arc is a
 * canvas that redraws only when rpm (or the limiter flash) actually changes.
 */
import type { HudState } from '../../core/contracts';
import { Bar, ClassSlot, h, Txt } from '../dom';
import { gearLabel, speedUnitLabel, speedValue } from '../format';
import { clamp01, COLORS, flashPhase, isLimiter, lutAt, makeLut, revRampStops, revScaleMax, shiftLedCount, SHIFT_LEDS } from '../hudlogic';
import { sizeCanvas } from '../trackmap';

const W = 560;
const H = 352;
const CX = 322;
const CY = 206;
const R1 = 172; // outer radius
const R0 = 146; // inner radius
const A0 = (150 * Math.PI) / 180;
const SWEEP = (240 * Math.PI) / 180;
const SEGS = 64;
const GAP = 0.2; // fraction of a segment left empty
const DIM = 'rgba(238,240,243,0.13)';
const DIM_RED = 'rgba(255,46,99,0.26)';
const HOLD_MS = 180; // assist lights stay lit this long after the last active frame

/** Precomputed class names so the per-frame path never concatenates strings. */
const GEAR_CLASS: string[] = [];
for (let i = 0; i < 12; i++) GEAR_CLASS.push('sp-gear' + (i & 3 ? (i & 3) === 1 ? ' rev' : ' neutral' : '') + (i & 4 ? ' lim' : i & 8 ? ' warn' : ''));
const LED_CLASS = ['led', 'led on g', 'led on a', 'led on r', 'led on blue'];

function segPath(i: number): Path2D {
  const step = SWEEP / SEGS;
  const a = A0 + i * step + (step * GAP) / 2;
  const b = A0 + (i + 1) * step - (step * GAP) / 2;
  const p = new Path2D();
  p.moveTo(CX + Math.cos(a) * R1, CY + Math.sin(a) * R1);
  p.arc(CX, CY, R1, a, b);
  p.lineTo(CX + Math.cos(b) * R0, CY + Math.sin(b) * R0);
  p.arc(CX, CY, R0, b, a, true);
  p.closePath();
  return p;
}

export class Speedo {
  readonly el: HTMLElement;
  private readonly canvas = h('canvas', 'rev-canvas');
  private readonly stat = document.createElement('canvas');
  private readonly segs: Path2D[] = [];
  private g: CanvasRenderingContext2D | null = null;
  private px = 0;

  private readonly speed: Txt;
  private readonly unit: Txt;
  private readonly gearTxt: Txt;
  private readonly gearBox = h('div', 'sp-gear');
  private readonly gearCls: ClassSlot;
  private readonly thr: Bar;
  private readonly brk: Bar;
  /** The brake bar's second fill, behind the first: the whole brake, of which the driver's part is drawn over it, so what the assist adds shows in blue. */
  private readonly brkAll: Bar;
  private readonly leds: HTMLElement[] = [];
  private readonly ledState: number[] = [];
  private readonly pills: { el: HTMLElement; until: number; on: boolean }[] = [];

  // change tracking
  private lastRpm = -1;
  private lastFlash = false;
  private lastScale = 0;
  private lastRedline = 0;
  private lastSpeed = -1;
  private lastGear = -99;
  private lastUnits = '';
  private lut: string[] = [];
  private revMax = 9000;
  private redline = 7800;
  private dirty = true;

  constructor(parent: HTMLElement) {
    for (let i = 0; i < SEGS; i++) this.segs.push(segPath(i));
    const speedEl = h('div', 'sp-speed');
    const unitEl = h('div', 'sp-unit');
    const gearEl = h('span', 'sp-gear-n');
    this.gearBox.appendChild(gearEl);
    this.speed = new Txt(speedEl, '0');
    this.unit = new Txt(unitEl, 'KM/H');
    this.gearTxt = new Txt(gearEl, 'N');
    this.gearCls = new ClassSlot(this.gearBox);

    const ledRow = h('div', 'sp-leds');
    for (let i = 0; i < SHIFT_LEDS; i++) {
      const l = h('i', 'led');
      this.leds.push(l);
      this.ledState.push(-1);
      ledRow.appendChild(l);
    }

    const thrFill = h('i');
    const brkFill = h('i');
    const brkAllFill = h('i', 'assist');
    this.thr = new Bar(thrFill, 'Y', 0.01);
    this.brk = new Bar(brkFill, 'Y', 0.01);
    this.brkAll = new Bar(brkAllFill, 'Y', 0.01);
    const pedals = h('div', 'sp-pedals', h('div', 'ped brk', h('div', 'ped-trk', brkAllFill, brkFill), h('span', null, 'BRK')), h('div', 'ped thr', h('div', 'ped-trk', thrFill), h('span', null, 'THR')));

    const assists = h('div', 'sp-assists');
    for (const name of ['ABS', 'TCS', 'ESC']) {
      const p = h('div', 'pill', name);
      this.pills.push({ el: p, until: 0, on: false });
      assists.appendChild(p);
    }
    // the braking assist's cue (lit while it is on the brakes; pills[3])
    const assistCue = h('div', 'pill ba', 'BRAKE ASSIST');
    this.pills.push({ el: assistCue, until: 0, on: false });

    this.el = h('div', 'hud-speedo', h('div', 'sp-glow'), this.canvas, ledRow, speedEl, unitEl, this.gearBox, pedals, assists, assistCue);
    parent.appendChild(this.el);
    this.resize(1);
    void document.fonts?.load('600 18px Oxanium').then(() => {
      this.dirty = true;
      this.drawStatic();
    });
  }

  resize(px: number): void {
    this.px = px;
    this.g = sizeCanvas(this.canvas, W, H, px);
    sizeCanvas(this.stat, W, H, px);
    this.drawStatic();
    this.dirty = true;
    this.lastRpm = -1;
  }

  /** Dim segments, scale numbers and the redline marker. Redrawn when the scale or size changes. */
  private drawStatic(): void {
    const g = this.stat.getContext('2d');
    if (!g) return;
    g.setTransform(this.px, 0, 0, this.px, 0, 0);
    g.clearRect(0, 0, W, H);
    const redFrac = this.redline / this.revMax;
    for (let i = 0; i < SEGS; i++) {
      const f = (i + 0.5) / SEGS;
      g.fillStyle = f >= redFrac ? DIM_RED : DIM;
      g.fill(this.segs[i]);
    }
    // 1000-rpm ticks + labels
    const thousands = Math.floor(this.revMax / 1000);
    g.font = '600 19px Oxanium, "Barlow Condensed", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let k = 0; k <= thousands; k++) {
      const f = (k * 1000) / this.revMax;
      const a = A0 + f * SWEEP;
      const red = k * 1000 >= this.redline;
      g.strokeStyle = red ? 'rgba(255,90,120,0.95)' : 'rgba(238,240,243,0.55)';
      g.lineWidth = 2.2;
      g.beginPath();
      g.moveTo(CX + Math.cos(a) * (R1 + 3), CY + Math.sin(a) * (R1 + 3));
      g.lineTo(CX + Math.cos(a) * (R1 + 11), CY + Math.sin(a) * (R1 + 11));
      g.stroke();
      g.fillStyle = red ? 'rgba(255,120,145,0.95)' : 'rgba(238,240,243,0.78)';
      g.fillText(String(k), CX + Math.cos(a) * (R0 - 20), CY + Math.sin(a) * (R0 - 20));
    }
    // redline marker
    const ar = A0 + redFrac * SWEEP;
    g.strokeStyle = COLORS.pink;
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(CX + Math.cos(ar) * (R0 - 4), CY + Math.sin(ar) * (R0 - 4));
    g.lineTo(CX + Math.cos(ar) * (R1 + 14), CY + Math.sin(ar) * (R1 + 14));
    g.stroke();
  }

  private pill(i: number, active: boolean, now: number): void {
    const p = this.pills[i];
    if (active) p.until = now + HOLD_MS;
    const on = active || now < p.until;
    if (on !== p.on) {
      p.on = on;
      p.el.classList.toggle('on', on);
    }
  }

  update(s: HudState, now: number): void {
    // speed + units
    const sp = speedValue(s.speed, s.units);
    if (sp !== this.lastSpeed) {
      this.lastSpeed = sp;
      this.speed.set(String(sp));
    }
    if (s.units !== this.lastUnits) {
      this.lastUnits = s.units;
      this.unit.set(speedUnitLabel(s.units));
    }

    // gear
    if (s.gear !== this.lastGear) {
      this.lastGear = s.gear;
      this.gearTxt.set(gearLabel(s.gear));
    }
    const limiter = isLimiter(s.rpm, s.limiterRpm);
    const warn = s.shiftLight >= 0.8;
    this.gearCls.set(GEAR_CLASS[(s.gear < 0 ? 1 : s.gear === 0 ? 2 : 0) | (limiter ? 4 : warn ? 8 : 0)]);

    // pedals + assists (the brake bar shows the whole brake, and what the braking assist adds to the driver's pedal in its own colour)
    const added = s.brakeAssist ?? 0;
    this.thr.set(s.throttle);
    this.brk.set(s.brake - added);
    this.brkAll.set(added > 0.01 ? s.brake : 0);
    this.pill(0, s.absActive, now);
    this.pill(1, s.tcsActive, now);
    this.pill(2, s.escActive, now);
    this.pill(3, added > 0.03, now);

    // shift LEDs
    const flash = limiter && flashPhase(now, 6);
    const n = shiftLedCount(s.shiftLight);
    for (let i = 0; i < SHIFT_LEDS; i++) {
      const st = limiter ? (flash ? 4 : 0) : i < n ? (i < 3 ? 1 : i < 6 ? 2 : 3) : 0;
      if (st !== this.ledState[i]) {
        this.ledState[i] = st;
        this.leds[i].className = LED_CLASS[st];
      }
    }

    // arc
    const scale = revScaleMax(s.limiterRpm);
    if (scale !== this.lastScale || s.redlineRpm !== this.lastRedline) {
      this.lastScale = scale;
      this.lastRedline = s.redlineRpm;
      this.revMax = scale;
      this.redline = s.redlineRpm;
      this.lut = makeLut(revRampStops(this.redline / this.revMax), SEGS);
      this.drawStatic();
      this.dirty = true;
    }
    if (!this.dirty && Math.abs(s.rpm - this.lastRpm) < 14 && flash === this.lastFlash) return;
    this.dirty = false;
    this.lastRpm = s.rpm;
    this.lastFlash = flash;
    this.drawArc(s.rpm, limiter, flash);
  }

  private drawArc(rpm: number, limiter: boolean, flash: boolean): void {
    const g = this.g;
    if (!g) return;
    g.clearRect(0, 0, W, H);
    g.drawImage(this.stat, 0, 0, W, H);
    const frac = clamp01(rpm / this.revMax);
    const lit = Math.floor(frac * SEGS + 0.5);
    if (limiter) {
      if (!flash) return;
      g.fillStyle = COLORS.blue;
      for (let i = 0; i < SEGS; i++) g.fill(this.segs[i]);
      return;
    }
    for (let i = 0; i < lit; i++) {
      g.fillStyle = lutAt(this.lut, i / (SEGS - 1));
      g.fill(this.segs[i]);
    }
    // soft head highlight on the leading segment
    if (lit > 0 && lit < SEGS) {
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fill(this.segs[lit - 1]);
    }
  }

  dispose(): void {
    this.el.remove();
  }
}
