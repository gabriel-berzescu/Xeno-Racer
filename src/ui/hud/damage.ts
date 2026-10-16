/**
 * Damage indicator (Settings: Damage, Full): a car seen from above, nose up, with its four body zones and its four wheels tinted
 * from amber to red by how hurt they are. It shows itself for a few seconds after a hit that changed something, then fades, and
 * the pause screen shows the same drawing for as long as the car is damaged. The game hands over the numbers (HudState.damage, see
 * src/core/mechanical.ts); this only draws them, and writes to the DOM only when a part's level changes.
 */
import '../styles/damage.css';
import type { HudDamage, HudState } from '../../core/contracts';
import { ClassSlot, h, svg } from '../dom';

/** How long the indicator stays up after the damage last changed (ms), and the steps a level is drawn in. */
const SHOW_MS = 5000;
const STEPS = 24;

/** Body outline (a grand tourer from above) in a 80 x 142 box; wheels and zones are drawn against it. */
const BODY =
  'M40 3 C49 3 58 6 63 14 C67 20 68 27 68 36 L69 56 C69 64 67 70 67 80 L67 104 C67 112 69 120 69 128 C69 134 63 139 55 140 L25 140 C17 139 11 134 11 128 C11 120 13 112 13 104 L13 80 C13 70 11 64 11 56 L12 36 C12 27 13 20 17 14 C22 6 31 3 40 3 Z';
const CABIN = 'M27 52 C27 47 31 45 40 45 C49 45 53 47 53 52 L56 92 C56 97 50 100 40 100 C30 100 24 97 24 92 Z';

/** The parts of the drawing, in the order their levels are kept: front, rear, left, right, then the wheels FL FR RL RR. */
const PARTS = ['front', 'rear', 'left', 'right', 'w0', 'w1', 'w2', 'w3'] as const;

let uid = 0;

/** The drawing itself, for the HUD and for the pause screen. */
export class DamageGlyph {
  readonly el: SVGSVGElement;
  private readonly part = new Map<string, SVGElement>();
  private readonly q = new Int8Array(PARTS.length).fill(-1);

  constructor() {
    const id = `dmg-clip-${uid++}`;
    const clip = svg('clipPath', { id }, svg('path', { d: BODY }));
    const zone = (cls: string, d: string, name: string): SVGElement => {
      const p = svg('path', { d, class: 'dz ' + cls });
      this.part.set(name, p);
      return p;
    };
    const wheel = (x: number, y: number, hh: number, name: string): SVGElement => {
      const r = svg('rect', { x, y, width: 10, height: hh, rx: 3, class: 'dw' });
      this.part.set(name, r);
      return r;
    };
    this.el = svg(
      'svg',
      { class: 'dmg-car', viewBox: '0 0 80 142', 'aria-hidden': 'true' },
      svg('defs', null, clip),
      svg('path', { d: BODY, class: 'dmg-body' }),
      svg(
        'g',
        { 'clip-path': `url(#${id})` },
        zone('z-front', 'M0 0 H80 V50 H0 Z', 'front'),
        zone('z-rear', 'M0 98 H80 V142 H0 Z', 'rear'),
        zone('z-left', 'M0 50 H26 V98 H0 Z', 'left'),
        zone('z-right', 'M54 50 H80 V98 H54 Z', 'right'),
      ),
      svg('path', { d: CABIN, class: 'dmg-cabin' }),
      svg('path', { d: BODY, class: 'dmg-edge' }),
      wheel(1, 22, 24, 'w0'),
      wheel(69, 22, 24, 'w1'),
      wheel(1, 98, 26, 'w2'),
      wheel(69, 98, 26, 'w3'),
    );
  }

  /** True when no part is drawn as hurt. */
  get sound(): boolean {
    for (let i = 0; i < PARTS.length; i++) if (this.q[i] > 0) return false;
    return true;
  }

  /** Draw these levels (null: a sound car). True when a part moved to another step. */
  set(d: HudDamage | null): boolean {
    let changed = false;
    for (let i = 0; i < PARTS.length; i++) {
      const v = !d ? 0 : i === 0 ? d.front : i === 1 ? d.rear : i === 2 ? d.left : i === 3 ? d.right : d.wheels[i - 4];
      const q = Math.round(Math.max(0, Math.min(1, v)) * STEPS);
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
  const w = Math.max(d.front, d.rear, d.left, d.right, ...d.wheels);
  return w < 0.2 ? 0 : w < 0.45 ? 1 : w < 0.75 ? 2 : 3;
}

/** The worst part as a word: how a driver would put it. */
export function damageWord(d: HudDamage): string {
  return WORDS[damageLevel(d)];
}

/** A chip for the pause screen: the drawing and a word, in the style of the other chips there. */
export function damageChip(d: HudDamage): HTMLElement {
  const g = new DamageGlyph();
  g.set(d);
  return h('div', 'kv dmg-chip', h('span', 'k', 'Car damage'), h('div', 'v', g.el, h('span', 'dmg-word l' + damageLevel(d), damageWord(d))));
}

/** The panel on the race HUD. */
export class DamageHud {
  readonly el: HTMLElement;
  private readonly glyph = new DamageGlyph();
  private readonly cls: ClassSlot;
  private until = 0;
  private flip = 0;
  private shown = false;

  constructor(hud: HTMLElement) {
    this.el = h('div', 'hud-dmg', h('span', 'dmg-k', 'Damage'), this.glyph.el);
    this.cls = new ClassSlot(this.el);
    hud.appendChild(this.el);
  }

  update(s: HudState, now: number): void {
    const moved = this.glyph.set(s.damage ?? null);
    if (this.glyph.sound) {
      this.show(false, 0);
      return;
    }
    // a hit that changed what is drawn (or the first look at a car that already carries damage): up for a few seconds
    if (moved) this.until = now + SHOW_MS;
    this.show(now < this.until, moved ? (this.flip ^= 1) + 1 : 0);
  }

  private show(on: boolean, hit: number): void {
    if (on !== this.shown || hit) {
      this.shown = on;
      this.cls.set('hud-dmg' + (on ? ' show' : '') + (hit ? ' hit' + (hit - 1) : ''));
    }
  }
}
