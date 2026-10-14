/**
 * Center-screen messages: start lights (five reds filling, then out = GO), banners (FINAL LAP, FINISH,
 * ...), the WRONG WAY warning and small toasts. All driven by HudState; DOM touched only on change.
 */
import type { HudState } from '../../core/contracts';
import { ClassSlot, h, Txt } from '../dom';
import { lightsView } from '../hudlogic';

export class Center {
  readonly el: HTMLElement;
  private readonly lamps: HTMLElement[] = [];
  private lampOn: boolean[] = [false, false, false, false, false];
  private readonly lightsEl: HTMLElement;
  private readonly lightsCls: ClassSlot;
  private lastGo = false;
  private lastLit = -1;
  private lastVisible = false;

  private readonly bannerEl: HTMLElement;
  private readonly bannerTxt: Txt;
  private readonly bannerCls: ClassSlot;
  private lastBanner: string | null | undefined = undefined;
  private bannerFlip = 0;

  private readonly wrong: HTMLElement;
  private lastWrong = false;

  private readonly toastEl: HTMLElement;
  private readonly toastTxt: Txt;
  private readonly toastCls: ClassSlot;
  private lastToast: string | null | undefined = undefined;
  private toastFlip = 0;

  constructor(parent: HTMLElement) {
    const gantry = h('div', 'gantry');
    for (let i = 0; i < 5; i++) {
      const l = h('i', 'lamp');
      this.lamps.push(l);
      gantry.appendChild(h('div', 'lamp-wrap', l));
    }
    this.lightsEl = h('div', 'hud-lights', gantry, h('div', 'go', 'GO'));
    this.lightsCls = new ClassSlot(this.lightsEl);

    const btxt = h('span', 'btxt');
    this.bannerTxt = new Txt(btxt, '');
    this.bannerEl = h('div', 'hud-banner', h('div', 'band', btxt));
    this.bannerCls = new ClassSlot(this.bannerEl);

    this.wrong = h('div', 'hud-wrong', h('i', 'arr l'), h('span', null, 'WRONG WAY'), h('i', 'arr r'));

    const ttxt = h('span', 'ttxt');
    this.toastTxt = new Txt(ttxt, '');
    this.toastEl = h('div', 'hud-toast', h('i'), ttxt);
    this.toastCls = new ClassSlot(this.toastEl);

    this.el = h('div', 'hud-center', this.lightsEl, this.bannerEl, this.wrong, this.toastEl);
    parent.appendChild(this.el);
  }

  update(s: HudState): void {
    // start lights
    const v = lightsView(s.countdown);
    if (v.visible !== this.lastVisible || v.go !== this.lastGo) {
      this.lastVisible = v.visible;
      this.lastGo = v.go;
      this.lightsCls.set('hud-lights' + (v.visible ? ' show' : '') + (v.go ? ' go' : ''));
    }
    if (v.lit !== this.lastLit) {
      this.lastLit = v.lit;
      for (let i = 0; i < 5; i++) {
        const on = i < v.lit;
        if (on !== this.lampOn[i]) {
          this.lampOn[i] = on;
          this.lamps[i].classList.toggle('on', on);
        }
      }
    }

    // banner
    if (s.banner !== this.lastBanner) {
      this.lastBanner = s.banner;
      if (s.banner) {
        this.bannerTxt.set(s.banner);
        this.bannerFlip ^= 1;
        const b = s.banner.toUpperCase();
        const kind = b.includes('FINISH') ? ' finish' : b.includes('FINAL') ? ' final' : b.includes('WRONG') ? ' bad' : '';
        this.bannerCls.set('hud-banner show f' + this.bannerFlip + kind);
      } else {
        this.bannerCls.set('hud-banner');
      }
    }

    // wrong way
    if (s.wrongWay !== this.lastWrong) {
      this.lastWrong = s.wrongWay;
      this.wrong.classList.toggle('show', s.wrongWay);
    }

    // toast
    if (s.toast !== this.lastToast) {
      this.lastToast = s.toast;
      if (s.toast) {
        this.toastTxt.set(s.toast);
        this.toastFlip ^= 1;
        this.toastCls.set('hud-toast show f' + this.toastFlip);
      } else {
        this.toastCls.set('hud-toast');
      }
    }
  }
}
