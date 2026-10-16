/**
 * The weather of a race that changes, on the HUD: a chip under the timing panel (the sky, and how wet the track is) and, for
 * a few seconds when something is about to happen ("Rain is coming"), a card at the top of the picture. Both stay hidden in a race
 * whose weather is fixed. DOM is touched only when a value changes.
 */
import type { HudState, HudWeather, Weather } from '../../core/contracts';
import { wetnessBars } from '../../core/forecast';
import { ClassSlot, clearEl, h, Txt } from '../dom';
import { WEATHER_LABEL } from '../format';
import { iconCloud, iconRain, iconStorm, iconSun, iconSunCloud } from '../icons';

const ICON: Record<Weather, (cls?: string) => SVGElement> = { clear: iconSun, cloudy: iconSunCloud, overcast: iconCloud, rain: iconRain, storm: iconStorm };
const SEGMENTS = 5;

export class WeatherHud {
  readonly chip: HTMLElement;
  readonly card: HTMLElement;
  private readonly chipCls: ClassSlot;
  private readonly cardCls: ClassSlot;
  private readonly chipIcon = h('span', 'wx-ico');
  private readonly sky: Txt;
  private readonly track: Txt;
  private readonly segs: HTMLElement[] = [];
  private readonly noteIcon = h('div', 'wxn-ico');
  private readonly noteTitle: Txt;
  private readonly noteSub: Txt;
  private lastSky: Weather | null = null;
  private lastLit = -1;
  private lastNotice: HudWeather['notice'] | undefined = undefined;
  private lastShown = false;

  constructor(hud: HTMLElement, center: HTMLElement) {
    const sky = h('span', 'wx-sky');
    const track = h('span', 'wx-track');
    this.sky = new Txt(sky, '');
    this.track = new Txt(track, '');
    const meter = h('span', 'wx-meter');
    for (let i = 0; i < SEGMENTS; i++) {
      const s = h('i');
      this.segs.push(s);
      meter.appendChild(s);
    }
    this.chip = h('div', 'hud-wx', this.chipIcon, sky, h('span', 'wx-sep'), h('div', 'wx-trk', h('span', 'k', 'TRACK'), track), meter);
    this.chip.style.display = 'none';
    this.chipCls = new ClassSlot(this.chip);
    hud.appendChild(this.chip);

    const title = h('span', 'wxn-title');
    const sub = h('span', 'wxn-sub');
    this.noteTitle = new Txt(title, '');
    this.noteSub = new Txt(sub, '');
    this.card = h('div', 'hud-wxnote', this.noteIcon, h('div', 'wxn-txt', title, sub));
    this.cardCls = new ClassSlot(this.card);
    center.appendChild(this.card);
  }

  update(s: HudState): void {
    const w = s.weather ?? null;
    const shown = w !== null;
    if (shown !== this.lastShown) {
      this.lastShown = shown;
      this.chip.style.display = shown ? '' : 'none';
    }
    if (w) {
      if (w.sky !== this.lastSky) {
        this.lastSky = w.sky;
        clearEl(this.chipIcon);
        this.chipIcon.appendChild(ICON[w.sky]());
        this.sky.set(WEATHER_LABEL[w.sky] ?? w.sky);
        this.chipCls.set('hud-wx' + (w.sky === 'rain' || w.sky === 'storm' ? ' wet' : ''));
      }
      this.track.set(w.track);
      // one segment per fifth of the wetness (a track called dry shows none, a soaked one all of them)
      const lit = wetnessBars(w.wetness, SEGMENTS);
      if (lit !== this.lastLit) {
        this.lastLit = lit;
        for (let i = 0; i < SEGMENTS; i++) this.segs[i].classList.toggle('on', i < lit);
      }
    }
    // the card
    const n = w ? w.notice : null;
    if (n !== this.lastNotice) {
      this.lastNotice = n;
      if (n) {
        clearEl(this.noteIcon);
        this.noteIcon.appendChild((n.kind === 'rain' ? iconRain : iconSunCloud)());
        this.noteTitle.set(n.title);
        this.noteSub.set(n.sub);
        this.cardCls.set('hud-wxnote show ' + n.kind);
      } else {
        this.cardCls.set('hud-wxnote');
      }
    }
  }
}
