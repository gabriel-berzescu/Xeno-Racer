/**
 * Damage indicator (Settings: Damage, Full): a car seen from above, nose up, with its four body zones and its four wheels tinted
 * from amber to red by how hurt they are. It shows itself for a few seconds after a hit that changed something, then fades, and
 * the pause screen shows the same drawing for as long as the car is damaged. The game hands over the numbers (HudState.damage, see
 * src/core/mechanical.ts: a part lights only for what the hit cost that car) and the car's body style; this only draws them, in the
 * outline of that style, and writes to the DOM only when a part's level (or the style) changes.
 */
import '../styles/damage.css';
import type { BodyStyle, HudDamage, HudState } from '../../core/contracts';
import { DAMAGE_SHOWN, reportWorst } from '../../core/mechanical';
import { ClassSlot, h, svg } from '../dom';

/** How long the indicator stays up after the damage last changed (ms), and the steps a level is drawn in. */
const SHOW_MS = 5000;
const STEPS = 24;

/**
 * The car from above, in an 80 x 142 box, nose up: the plan of its body and of its cabin, where its wheels stand (x, y, width and height
 * of FL FR RL RR) and where the four zones divide (the nose ends at y `front`, the tail begins at `rear`, a flank is the strip `side` wide
 * at either edge between them). A grand tourer is a teardrop, the Mammoth a brick with flared arches, a flat nose and a flat tail, the
 * LMP-X a front wing, a nose cone, fat pods over the wheels, a waist, an engine cover and a rear wing: the drawing says whose car it is,
 * and the zones lie where that car's parts are (the wings are in the nose and the tail zones, as the downforce they carry is).
 */
export interface Shape {
  body: string;
  cabin: string;
  wheels: readonly (readonly [number, number, number, number])[];
  front: number;
  rear: number;
  side: number;
}

export const SHAPES = {
  gt: {
    body: 'M40 3 C49 3 58 6 63 14 C67 20 68 27 68 36 L69 56 C69 64 67 70 67 80 L67 104 C67 112 69 120 69 128 C69 134 63 139 55 140 L25 140 C17 139 11 134 11 128 C11 120 13 112 13 104 L13 80 C13 70 11 64 11 56 L12 36 C12 27 13 20 17 14 C22 6 31 3 40 3 Z',
    cabin: 'M27 52 C27 47 31 45 40 45 C49 45 53 47 53 52 L56 92 C56 97 50 100 40 100 C30 100 24 97 24 92 Z',
    wheels: [[1, 22, 10, 24], [69, 22, 10, 24], [1, 98, 10, 26], [69, 98, 10, 26]],
    front: 50,
    rear: 98,
    side: 26,
  },
  suv: {
    body: 'M40 3 L57 3 C61 3 63 4.5 63.5 8 L64.5 12 C68.5 12.5 70 16 70 21 L70 40 C70 43 69 45 69 48 L69 98 C69.5 100 70 102 70 106 L70 122 C70 125 68.5 126.5 67 128 L66 133 C65.5 137 63 139.5 59 139.5 L40 139.5 L21 139.5 C17 139.5 14.5 137 14 133 L13 128 C11.5 126.5 10 125 10 122 L10 106 C10 102 10.5 100 11 98 L11 48 C11 45 10 43 10 40 L10 21 C10 16 11.5 12.5 15.5 12 L16.5 8 C17 4.5 19 3 23 3 L40 3 Z',
    cabin: 'M25 46 L55 46 C57 46 58.5 47 59 49 L61 104 C61 106.5 59.5 108 57 108 L23 108 C20.5 108 19 106.5 19 104 L21 49 C21.5 47 23 46 25 46 Z',
    wheels: [[0, 11, 11, 27], [69, 11, 11, 27], [0, 97, 11, 27], [69, 97, 11, 27]],
    front: 46,
    rear: 100,
    side: 22,
  },
  prototype: {
    body: 'M40 3 L61 3 C63.5 3 65 4.5 65 7 C65 9.5 63 10.5 61 10.5 L51.5 10.5 C51.5 14 51.5 17 52.5 21 C54.5 26 66.5 26.5 68 36 L68 48 C68 56 58.5 58 58.5 68 L58.5 84 C58.5 92 68 94 68 104 L68 120 C68 124 62 126 57 127 L57 131 L67 131 C68 131 68.5 132 68.5 133.5 L68.5 138 C68.5 139.5 67 140 65 140 L40 140 L15 140 C13 140 11.5 139.5 11.5 138 L11.5 133.5 C11.5 132 12 131 13 131 L23 131 L23 127 C18 126 12 124 12 120 L12 104 C12 94 21.5 92 21.5 84 L21.5 68 C21.5 58 12 56 12 48 L12 36 C13.5 26.5 25.5 26 27.5 21 C28.5 17 28.5 14 28.5 10.5 L19 10.5 C17 10.5 15 9.5 15 7 C15 4.5 16.5 3 19 3 L40 3 Z',
    cabin: 'M40 46 C46 46 50 51 50 61 L50 85 C50 92 46 97 40 97 C34 97 30 92 30 85 L30 61 C30 51 34 46 40 46 Z',
    wheels: [[0, 19, 12, 22], [68, 19, 12, 22], [0, 106, 12, 25], [68, 106, 12, 25]],
    front: 50,
    rear: 96,
    side: 31,
  },
} as const satisfies Record<string, Shape>;

export type ShapeId = keyof typeof SHAPES;

/** The shape each body style is drawn in: the three road cars share the grand tourer's. */
export const SHAPE_OF: Record<BodyStyle, ShapeId> = { gt: 'gt', coupe: 'gt', hatch: 'gt', suv: 'suv', prototype: 'prototype' };

/** The four zones of a shape, as the rectangles that are cut to its body. */
const zonePaths = (s: Shape): Record<'front' | 'rear' | 'left' | 'right', string> => ({
  front: `M0 0 H80 V${s.front} H0 Z`,
  rear: `M0 ${s.rear} H80 V142 H0 Z`,
  left: `M0 ${s.front} H${s.side} V${s.rear} H0 Z`,
  right: `M${80 - s.side} ${s.front} H80 V${s.rear} H${80 - s.side} Z`,
});

/** The parts of the drawing, in the order their levels are kept: front, rear, left, right, then the wheels FL FR RL RR. */
const PARTS = ['front', 'rear', 'left', 'right', 'w0', 'w1', 'w2', 'w3'] as const;

let uid = 0;

/** The drawing itself, for the HUD and for the pause screen. */
export class DamageGlyph {
  readonly el: SVGSVGElement;
  private readonly part = new Map<string, SVGElement>();
  private readonly q = new Int8Array(PARTS.length).fill(-1);
  /** what takes the outline of a shape: the body's three layers (the clip of the zones, the fill, the edge) and the cabin, and the shape held now */
  private readonly body: SVGElement[] = [];
  private readonly cabin: SVGElement;
  private shape: ShapeId = 'gt';

  constructor() {
    const id = `dmg-clip-${uid++}`;
    const G: Shape = SHAPES.gt;
    const outline = (cls?: string): SVGElement => {
      const p = svg('path', cls ? { d: G.body, class: cls } : { d: G.body });
      this.body.push(p);
      return p;
    };
    const clip = svg('clipPath', { id }, outline());
    const zone = (cls: string, d: string, name: string): SVGElement => {
      const p = svg('path', { d, class: 'dz ' + cls });
      this.part.set(name, p);
      return p;
    };
    const wheel = (r: readonly [number, number, number, number], name: string): SVGElement => {
      const el = svg('rect', { x: r[0], y: r[1], width: r[2], height: r[3], rx: 3, class: 'dw' });
      this.part.set(name, el);
      return el;
    };
    const zones = zonePaths(G);
    this.cabin = svg('path', { d: G.cabin, class: 'dmg-cabin' });
    this.el = svg(
      'svg',
      { class: 'dmg-car', viewBox: '0 0 80 142', 'aria-hidden': 'true' },
      svg('defs', null, clip),
      outline('dmg-body'),
      svg(
        'g',
        { 'clip-path': `url(#${id})` },
        zone('z-front', zones.front, 'front'),
        zone('z-rear', zones.rear, 'rear'),
        zone('z-left', zones.left, 'left'),
        zone('z-right', zones.right, 'right'),
      ),
      this.cabin,
      outline('dmg-edge'),
      wheel(G.wheels[0], 'w0'),
      wheel(G.wheels[1], 'w1'),
      wheel(G.wheels[2], 'w2'),
      wheel(G.wheels[3], 'w3'),
    );
  }

  /** Draw the outline of another body style (another car: the next race, the other seat); a shape already drawn costs nothing. */
  private useShape(id: ShapeId): void {
    if (id === this.shape) return;
    this.shape = id;
    const s: Shape = SHAPES[id];
    for (const el of this.body) el.setAttribute('d', s.body);
    this.cabin.setAttribute('d', s.cabin);
    const zones = zonePaths(s);
    for (const k of ['front', 'rear', 'left', 'right'] as const) this.part.get(k)!.setAttribute('d', zones[k]);
    for (let i = 0; i < 4; i++) {
      const el = this.part.get('w' + i)!;
      const [x, y, width, height] = s.wheels[i];
      el.setAttribute('x', String(x));
      el.setAttribute('y', String(y));
      el.setAttribute('width', String(width));
      el.setAttribute('height', String(height));
    }
  }

  /** True when no part is drawn as hurt. */
  get sound(): boolean {
    for (let i = 0; i < PARTS.length; i++) if (this.q[i] > 0) return false;
    return true;
  }

  /** Draw these levels (null: a sound car), in the outline of the car they are of. True when a part moved to another step. */
  set(d: HudDamage | null): boolean {
    if (d?.style) this.useShape(SHAPE_OF[d.style]);
    let changed = false;
    for (let i = 0; i < PARTS.length; i++) {
      const v = !d ? 0 : i === 0 ? d.front : i === 1 ? d.rear : i === 2 ? d.left : i === 3 ? d.right : d.wheels[i - 4];
      // (a part under DAMAGE_SHOWN is not drawn as hurt, the first step from there up is amber)
      const q = v < DAMAGE_SHOWN ? 0 : Math.max(1, Math.round(Math.min(1, v) * STEPS));
      if (q === this.q[i]) continue;
      this.q[i] = q;
      changed = true;
      const el = this.part.get(PARTS[i])!;
      el.style.setProperty('--on', q > 0 ? '1' : '0');
      // (red well before the part is wrecked: a bent wheel at two thirds reads as broken)
      el.style.setProperty('--hot', String(Math.min(1, (q / STEPS) * 1.5)));
    }
    return changed;
  }
}

const WORDS = ['Light', 'Moderate', 'Heavy', 'Severe'] as const;

/** How bad the worst part is, 0 (light) .. 3 (severe). */
function damageLevel(d: HudDamage): number {
  const w = reportWorst(d);
  return w < 0.2 ? 0 : w < 0.45 ? 1 : w < 0.75 ? 2 : 3;
}

/** The worst part as a word: how a driver would put it. */
export function damageWord(d: HudDamage): string {
  return WORDS[damageLevel(d)];
}

/** A chip for the pause screen: the drawing and a word, in the style of the other chips there. */
export function damageChip(d: HudDamage, label = 'Car damage'): HTMLElement {
  const g = new DamageGlyph();
  g.set(d);
  return h('div', 'kv dmg-chip', h('span', 'k', label), h('div', 'v', g.el, h('span', 'dmg-word l' + damageLevel(d), damageWord(d))));
}

/**
 * When the indicator is up: for a few seconds after what is drawn last changed (a hit that bent something, or the first look at a car
 * that already carries damage), and never while the car is sound. Each change is a new pulse, alternately 1 and 2 so that an animation
 * on the class restarts. No DOM, so it is tested on its own.
 */
export class DamageShow {
  private until = 0;
  private flip = 0;
  /** Up now? */
  on = false;
  /** 0, or 1 / 2 on the step that began a pulse. */
  pulse = 0;

  step(moved: boolean, sound: boolean, now: number): void {
    this.pulse = 0;
    if (sound) {
      this.on = false;
      this.until = 0;
      return;
    }
    if (moved) {
      this.until = now + SHOW_MS;
      this.pulse = (this.flip ^= 1) + 1;
    }
    this.on = now < this.until;
  }
}

/** The panel on the race HUD. */
export class DamageHud {
  readonly el: HTMLElement;
  private readonly glyph = new DamageGlyph();
  private readonly cls: ClassSlot;
  private readonly when = new DamageShow();
  private shown = false;
  private tele = false;

  constructor(hud: HTMLElement) {
    this.el = h('div', 'hud-dmg', h('span', 'dmg-k', 'Damage'), this.glyph.el);
    this.cls = new ClassSlot(this.el);
    hud.appendChild(this.el);
  }

  update(s: HudState, now: number): void {
    const moved = this.glyph.set(s.damage ?? null);
    this.when.step(moved, this.glyph.sound, now);
    const { on, pulse } = this.when;
    // (the telemetry overlay puts its traces where the panel would be on a narrow stage: the panel steps up out of the way)
    const tele = s.showTelemetry;
    if (on !== this.shown || pulse || tele !== this.tele) {
      this.shown = on;
      this.tele = tele;
      this.cls.set('hud-dmg' + (on ? ' show' : '') + (tele ? ' tele' : '') + (pulse ? ' hit' + (pulse - 1) : ''));
    }
  }
}
