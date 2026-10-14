/**
 * Controls tab side pane: a controller diagram (every binding, from the shared bindings table) that
 * lights up with live input, and the steering response curve with the live stick position on it.
 */
import type { InputFrame } from '../core/contracts';
import type { UiCtx } from './ctx';
import { h, svg } from './dom';
import { sizeCanvas } from './trackmap';
import { responseCurve } from '../input/processing';
import { COLORS } from './hudlogic';

type SvgEl = SVGElement;

interface Lit {
  els: SvgEl[];
  until: number;
  on: boolean;
}

const VB_W = 780;
const VB_H = 430;
const CURVE_W = 780;
const CURVE_H = 168;

/** Leader lines + labels, hand-routed so nothing crosses a control. */
interface Callout {
  id: string;
  text: string;
  sub?: string;
  side: 'l' | 'r' | 't';
  /** label anchor */
  x: number;
  y: number;
  /** polyline from the label edge to the control */
  pts: [number, number][];
  /** controls that light up for this callout */
  lights: string[];
}

const CALLOUTS: Callout[] = [
  { id: 'brake', text: 'BRAKE', side: 'l', x: 150, y: 84, pts: [[158, 84], [214, 84], [240, 106]], lights: ['lt'] },
  { id: 'shiftDown', text: 'SHIFT DOWN', sub: 'LB or X', side: 'l', x: 150, y: 140, pts: [[158, 140], [204, 140], [238, 136]], lights: ['lb', 'x'] },
  { id: 'steer', text: 'STEER', side: 'l', x: 150, y: 196, pts: [[158, 196], [220, 196]], lights: ['ls'] },
  { id: 'hud', text: 'TOGGLE HUD', side: 'l', x: 150, y: 290, pts: [[158, 290], [236, 290], [312, 228]], lights: ['dUp'] },
  { id: 'telemetry', text: 'TELEMETRY', side: 'l', x: 150, y: 338, pts: [[158, 338], [262, 338], [318, 270]], lights: ['dDown'] },
  { id: 'reset', text: 'RESET CAR', side: 't', x: 345, y: 52, pts: [[349, 58], [349, 150], [362, 194]], lights: ['back'] },
  { id: 'pause', text: 'PAUSE', side: 't', x: 435, y: 52, pts: [[431, 58], [431, 150], [418, 194]], lights: ['start'] },
  { id: 'throttle', text: 'THROTTLE', side: 'r', x: 630, y: 84, pts: [[622, 84], [566, 84], [540, 106]], lights: ['rt'] },
  { id: 'shiftUp', text: 'SHIFT UP', sub: 'RB or B', side: 'r', x: 630, y: 140, pts: [[622, 140], [576, 140], [542, 136]], lights: ['rb', 'b'] },
  { id: 'camera', text: 'CAMERA', side: 'r', x: 630, y: 186, pts: [[622, 186], [590, 186], [546, 176]], lights: ['y'] },
  { id: 'handbrake', text: 'HANDBRAKE', side: 'r', x: 630, y: 246, pts: [[622, 246], [584, 246], [542, 228]], lights: ['a'] },
  { id: 'look', text: 'LOOK', side: 'r', x: 630, y: 296, pts: [[622, 296], [520, 296], [478, 262]], lights: ['rs'] },
  { id: 'lookBack', text: 'LOOK BACK', sub: 'press the stick', side: 'r', x: 630, y: 344, pts: [[622, 344], [500, 344], [458, 268]], lights: ['rsClick'] },
];

export class ControlsPane {
  readonly el: HTMLElement;
  private readonly diagram: SVGSVGElement;
  private readonly curve = h('canvas', 'curve-canvas');
  private readonly readout = h('div', 'curve-readout');
  private readonly lit = new Map<string, Lit>();
  private lsCap!: SvgEl;
  private rsCap!: SvgEl;
  private ltFill!: SvgEl;
  private rtFill!: SvgEl;
  private dotValue = -2;
  private lastSig = '';

  constructor(private readonly ctx: UiCtx) {
    this.diagram = this.buildDiagram();
    this.el = h(
      'div',
      'controls-pane',
      h('div', 'cp-title', h('span', null, 'GAMEPAD LAYOUT'), h('span', 'cp-sub', 'Lights up as you press')),
      this.diagram as unknown as HTMLElement,
      h('div', 'cp-title', h('span', null, 'STEERING RESPONSE'), this.readout),
      this.curve,
    );
    ctx.onResize(() => this.drawCurve());
  }

  // ── diagram ────────────────────────────────────────────────────────────────

  private mark(id: string, ...els: SvgEl[]): void {
    for (const e of els) e.classList.add('ctl');
    const cur = this.lit.get(id);
    if (cur) cur.els.push(...els);
    else this.lit.set(id, { els: [...els], until: 0, on: false });
  }

  private buildDiagram(): SVGSVGElement {
    const s = svg('svg', { class: 'pad-svg', viewBox: `0 0 ${VB_W} ${VB_H}` });

    // body (left half mirrored around x = 390)
    const cx = 390;
    const left: [string, number[]][] = [
      ['M', [cx, 148]],
      ['L', [300, 148]],
      ['C', [262, 148, 232, 152, 214, 178]],
      ['C', [196, 205, 186, 262, 176, 300]],
      ['C', [170, 325, 186, 346, 208, 340]],
      ['C', [232, 334, 246, 300, 262, 282]],
      ['C', [272, 271, 290, 268, 310, 268]],
      ['L', [cx, 268]],
    ];
    let d = '';
    for (const [c, p] of left) d += c + p.join(' ') + ' ';
    // mirrored right half, walking back up
    const mir = (x: number): number => 2 * cx - x;
    d += 'L' + mir(310) + ' 268 ';
    d += 'C' + [mir(290), 268, mir(272), 271, mir(262), 282].join(' ') + ' ';
    d += 'C' + [mir(246), 300, mir(232), 334, mir(208), 340].join(' ') + ' ';
    d += 'C' + [mir(186), 346, mir(170), 325, mir(176), 300].join(' ') + ' ';
    d += 'C' + [mir(186), 262, mir(196), 205, mir(214), 178].join(' ') + ' ';
    d += 'C' + [mir(232), 152, mir(262), 148, mir(300), 148].join(' ') + ' Z';
    s.appendChild(svg('path', { d, class: 'pad-body' }));
    s.appendChild(svg('path', { d, class: 'pad-body-edge' }));

    // triggers + bumpers
    const trig = (x0: number, x1: number, id: string, fillOut: (e: SvgEl) => void): void => {
      const path = `M${x0} 122 L${x0 + 6} 98 Q${(x0 + x1) / 2} 90 ${x1 - 6} 98 L${x1} 122 Z`;
      const base = svg('path', { d: path, class: 'pad-part' });
      const fill = svg('path', { d: path, class: 'pad-fill', style: 'transform-box:fill-box;transform-origin:50% 100%;transform:scaleY(0)' });
      s.append(base, fill);
      this.mark(id, base);
      fillOut(fill);
    };
    trig(238, 312, 'lt', (e) => (this.ltFill = e));
    trig(468, 542, 'rt', (e) => (this.rtFill = e));
    const bump = (x: number, id: string): void => {
      const r = svg('rect', { x, y: 126, width: 90, height: 17, rx: 7, class: 'pad-part' });
      s.appendChild(r);
      this.mark(id, r);
    };
    bump(232, 'lb');
    bump(458, 'rb');

    // sticks
    const stick = (x: number, y: number, id: string, capOut: (e: SvgEl) => void): void => {
      const ring = svg('circle', { cx: x, cy: y, r: 31, class: 'pad-ring' });
      const cap = svg('circle', { cx: x, cy: y, r: 21, class: 'pad-part stick' });
      s.append(ring, cap);
      this.mark(id, cap);
      capOut(cap);
    };
    stick(254, 196, 'ls', (e) => (this.lsCap = e));
    stick(454, 240, 'rs', (e) => (this.rsCap = e));
    const rsClick = svg('circle', { cx: 454, cy: 240, r: 8, class: 'pad-click' });
    s.appendChild(rsClick);
    this.mark('rsClick', rsClick);

    // d-pad
    const dp = (x: number, y: number, w: number, hh: number, id: string): void => {
      const r = svg('rect', { x, y, width: w, height: hh, rx: 3, class: 'pad-part' });
      s.appendChild(r);
      this.mark(id, r);
    };
    dp(316, 212, 20, 26, 'dUp');
    dp(316, 242, 20, 26, 'dDown');
    dp(290, 238, 26, 20, 'dLeft');
    dp(336, 238, 26, 20, 'dRight');
    s.appendChild(svg('rect', { x: 316, y: 238, width: 20, height: 20, class: 'pad-hub' }));

    // face buttons
    const face = (x: number, y: number, id: string, label: string): void => {
      const c = svg('circle', { cx: x, cy: y, r: 14, class: `pad-btn pad-btn-${id}` });
      const t = svg('text', { x, y: y + 6.5, class: 'pad-btn-text', 'text-anchor': 'middle' }, label);
      s.append(c, t);
      this.mark(id, c);
    };
    face(526, 168, 'y', 'Y');
    face(552, 196, 'b', 'B');
    face(526, 224, 'a', 'A');
    face(500, 196, 'x', 'X');

    // back / start / guide
    const pill = (x: number, id: string): void => {
      const r = svg('rect', { x: x - 15, y: 195, width: 30, height: 11, rx: 5.5, class: 'pad-part' });
      s.appendChild(r);
      this.mark(id, r);
    };
    pill(362, 'back');
    pill(418, 'start');
    s.appendChild(svg('circle', { cx: 390, cy: 174, r: 13, class: 'pad-guide' }));

    // callouts
    for (const c of CALLOUTS) {
      const g = svg('g', { class: `callout callout-${c.side}` });
      const line = svg('polyline', { points: c.pts.map((p) => p.join(',')).join(' '), class: 'lead' });
      const dot = svg('circle', { cx: c.pts[c.pts.length - 1][0], cy: c.pts[c.pts.length - 1][1], r: 3.2, class: 'lead-dot' });
      const anchor = c.side === 'l' ? 'end' : c.side === 'r' ? 'start' : c.id === 'reset' ? 'end' : 'start';
      const text = svg('text', { x: c.x, y: c.y + 7, class: 'lead-text', 'text-anchor': anchor }, c.text);
      g.append(line, dot, text);
      if (c.sub) g.appendChild(svg('text', { x: c.x, y: c.y + 26, class: 'lead-sub', 'text-anchor': anchor }, c.sub));
      s.appendChild(g);
      // the callout lights with its controls
      const entry = this.lit.get(c.lights[0]);
      if (entry) entry.els.push(line, text);
      for (const extra of c.lights.slice(1)) {
        const e = this.lit.get(extra);
        if (e) e.els.push(line);
      }
    }
    return s;
  }

  private flash(id: string, now: number, on: boolean, hold = 0): void {
    const l = this.lit.get(id);
    if (!l) return;
    if (on) l.until = now + hold;
    const state = on || now < l.until;
    if (state !== l.on) {
      l.on = state;
      for (const e of l.els) e.classList.toggle('lit', state);
    }
  }

  // ── live ───────────────────────────────────────────────────────────────────

  update(f: InputFrame): void {
    const now = performance.now();
    const pad = f.device === 'gamepad';
    this.flash('lt', now, pad && f.brake > 0.02);
    this.flash('rt', now, pad && f.throttle > 0.02);
    this.flash('ls', now, pad && Math.abs(f.steer) > 0.02);
    this.flash('rs', now, pad && (Math.abs(f.lookX) > 0.05 || Math.abs(f.lookY) > 0.05));
    this.flash('rsClick', now, pad && f.lookBack);
    this.flash('a', now, pad && f.handbrake > 0.5);
    this.flash('rb', now, f.shiftUp, 240);
    this.flash('b', now, f.shiftUp, 240);
    this.flash('lb', now, f.shiftDown, 240);
    this.flash('x', now, f.shiftDown, 240);
    this.flash('y', now, f.cameraNext, 240);
    this.flash('back', now, f.resetCar, 240);
    this.flash('start', now, f.pause, 240);
    this.flash('dUp', now, f.toggleHud, 240);
    this.flash('dDown', now, f.toggleTelemetry, 240);

    const m = 11;
    const sx = pad ? f.steer * m : 0;
    this.lsCap.setAttribute('transform', `translate(${sx.toFixed(1)} 0)`);
    this.rsCap.setAttribute('transform', pad ? `translate(${(f.lookX * m).toFixed(1)} ${(-f.lookY * m).toFixed(1)})` : '');
    (this.ltFill as unknown as HTMLElement).style.transform = `scaleY(${pad ? f.brake.toFixed(3) : 0})`;
    (this.rtFill as unknown as HTMLElement).style.transform = `scaleY(${pad ? f.throttle.toFixed(3) : 0})`;

    const v = pad ? f.steer : 0;
    const sig = v.toFixed(3) + (pad ? 'p' : 'k');
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.dotValue = v;
      this.drawCurve();
    }
  }

  refresh(): void {
    this.drawCurve();
  }

  // ── response curve ─────────────────────────────────────────────────────────

  private drawCurve(): void {
    const c = this.ctx.settings.controls;
    const g = sizeCanvas(this.curve, CURVE_W, CURVE_H, this.ctx.pxScale);
    const padL = 54;
    const padR = 18;
    const padT = 14;
    const padB = 30;
    const w = CURVE_W - padL - padR;
    const hh = CURVE_H - padT - padB;
    const X = (v: number): number => padL + v * w;
    const Y = (v: number): number => padT + (1 - v) * hh;
    g.clearRect(0, 0, CURVE_W, CURVE_H);
    // dead-zone band
    g.fillStyle = 'rgba(255,46,99,0.16)';
    g.fillRect(X(0), padT, c.steerDeadzone * w, hh);
    // grid
    g.strokeStyle = 'rgba(238,240,243,0.10)';
    g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      g.beginPath();
      g.moveTo(X(i / 4), padT);
      g.lineTo(X(i / 4), padT + hh);
      g.moveTo(padL, Y(i / 4));
      g.lineTo(padL + w, Y(i / 4));
      g.stroke();
    }
    // linear reference
    g.setLineDash([6, 6]);
    g.strokeStyle = 'rgba(238,240,243,0.32)';
    g.beginPath();
    g.moveTo(X(0), Y(0));
    g.lineTo(X(1), Y(1));
    g.stroke();
    g.setLineDash([]);
    // curve: stick deflection -> steering
    const dz = c.steerDeadzone;
    const curveAt = (x: number): number => (x <= dz ? 0 : responseCurve((x - dz) / (1 - dz), c.steerLinearity));
    g.beginPath();
    for (let i = 0; i <= 80; i++) {
      const x = i / 80;
      const px = X(x);
      const py = Y(curveAt(x));
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.lineWidth = 3.5;
    g.strokeStyle = COLORS.teal;
    g.lineJoin = 'round';
    g.stroke();
    // axis labels
    g.fillStyle = 'rgba(238,240,243,0.55)';
    g.font = '600 15px "Barlow Condensed", sans-serif';
    g.textBaseline = 'alphabetic';
    g.textAlign = 'center';
    g.fillText('STICK DEFLECTION', padL + w / 2, CURVE_H - 6);
    g.textAlign = 'right';
    g.fillText('100%', padL - 8, padT + 10);
    g.fillText('0', padL - 8, padT + hh);
    g.save();
    g.translate(14, padT + hh / 2);
    g.rotate(-Math.PI / 2);
    g.textAlign = 'center';
    g.fillText('STEERING', 0, 0);
    g.restore();

    // live position
    const steer = Math.abs(this.dotValue);
    const showDot = this.dotValue > -1.5 && this.ctx.device === 'gamepad';
    if (showDot) {
      const lin = Math.max(0.25, Math.min(4, c.steerLinearity));
      const norm = steer <= 0 ? 0 : Math.pow(steer, 1 / lin);
      const raw = steer <= 0 ? 0 : dz + norm * (1 - dz);
      const px = X(Math.min(1, raw));
      const py = Y(steer);
      g.setLineDash([3, 4]);
      g.strokeStyle = 'rgba(238,240,243,0.4)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px, padT + hh);
      g.moveTo(px, py);
      g.lineTo(padL, py);
      g.stroke();
      g.setLineDash([]);
      g.beginPath();
      g.arc(px, py, 7, 0, Math.PI * 2);
      g.fillStyle = '#fff';
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = COLORS.teal;
      g.stroke();
      this.readout.textContent = `STICK ${Math.round(Math.min(1, raw) * 100)}%  →  STEER ${Math.round(steer * 100)}%`;
    } else {
      this.readout.textContent = `DEAD ZONE ${Math.round(dz * 100)}%  ·  LINEARITY ${c.steerLinearity.toFixed(1)}`;
    }
  }

  resize(): void {
    this.drawCurve();
  }
}
