/**
 * The race HUD: position / lap + standings tower (top-left), lap timing (top-right), minimap
 * (bottom-left), speed / gear / revs / pedals / assists (bottom-right), start lights, banners and
 * toasts (center), and the telemetry overlay. `update()` runs at the game's frame rate: it only
 * writes to the DOM when a value changes, uses transforms for bars and canvases for graphs.
 *
 * In split screen there is one of these per seat, each in a pane over its view (`setPane`): the same HUD laid out in a box of the
 * pane's size divided by its scale and scaled down (hudScale, about 0.75 in a 538-high view), in the seat's colour, with a five-row
 * tower that shows both humans, no telemetry and no mirror strip. The compact rules are in hud.css under `.xr-hud.split`.
 */
import type { HudState, MinimapTrack, Seat, Settings, SplitLayout } from '../../core/contracts';
import type { UiCtx } from '../ctx';
import { h } from '../dom';
import { Center } from './center';
import { DamageHud } from './damage';
import { HudMinimap } from './minimap';
import { Spotter } from './spotter';
import { Speedo } from './speedo';
import { Telemetry } from './telemetry';
import { PosLap, TimingPanel } from './timing';
import { Tower } from './tower';
import { WeatherHud } from './weather';

/** Split screen: the pane a HUD lives in (see panes.ts). */
export interface HudPane {
  seat: Seat;
  layout: SplitLayout;
  /** The HUD is drawn at this share of its design size, in a box of `w` x `h` design units. */
  scale: number;
  w: number;
  h: number;
}

export interface HudView {
  readonly el: HTMLElement;
  update(s: HudState): void;
  setMinimap(m: MinimapTrack | null): void;
  setSettings(s: Settings): void;
  setVisible(v: boolean): void;
  /** Split screen: this HUD is the view of `pane.seat`, scaled to fit its pane. null: the one HUD of the whole screen. */
  setPane(pane: HudPane | null): void;
  resize(): void;
  dispose(): void;
}

export function createHud(ctx: UiCtx): HudView {
  const el = h('div', 'xr-hud');
  el.style.display = 'none';

  const tl = h('div', 'hud-tl');
  const posLap = new PosLap(tl);
  const tower = new Tower(tl);
  const tr = h('div', 'hud-tr');
  const timing = new TimingPanel(tr);
  el.append(tl, tr);
  const speedo = new Speedo(el);
  const minimap = new HudMinimap(el);
  const tele = new Telemetry(el);
  const spotter = new Spotter(el);
  const damage = new DamageHud(el);
  const center = new Center(el);
  const weather = new WeatherHud(el, center.el);

  let visible = false;
  let teleOn = false;
  let clean = false;
  let standingsOn = true;
  let mirrorShown = false;
  // split screen: a pane's HUD is scaled (canvases are sized for it), has no telemetry and no mirror strip
  let split = false;
  let scale = 1;

  tele.setVisible(false);

  const view: HudView = {
    el,

    update(s: HudState): void {
      if (!visible) return;
      const now = performance.now();
      const isClean = !s.hudVisible;
      if (isClean !== clean) {
        clean = isClean;
        el.classList.toggle('clean', clean);
      }
      const mirror = !split && !clean && s.mirror === true;
      if (mirror !== mirrorShown) {
        mirrorShown = mirror;
        el.classList.toggle('has-mirror', mirror);
      }
      center.update(s);
      weather.update(s);
      if (clean) return; // photo mode: only the center messages stay

      spotter.update(s);
      damage.update(s, now);
      posLap.update(s);
      if (standingsOn) tower.update(s);
      timing.update(s);
      speedo.update(s, now);
      minimap.update(s, now);

      if (!split && s.showTelemetry !== teleOn) {
        teleOn = s.showTelemetry;
        tele.setVisible(teleOn);
      }
      if (teleOn) tele.update(s, now);
    },

    setMinimap(m: MinimapTrack | null): void {
      minimap.setMap(m);
    },

    setSettings(s: Settings): void {
      minimap.setEnabled(s.hud.minimap);
      standingsOn = s.hud.standings;
      tower.el.style.display = standingsOn ? '' : 'none';
      spotter.setEnabled(s.hud.spotter);
    },

    setVisible(v: boolean): void {
      if (v === visible) return;
      visible = v;
      el.style.display = v ? '' : 'none';
      if (v) {
        this.resize();
        // after being hidden, make the telemetry re-sync with the next frame
        teleOn = false;
      }
    },

    setPane(pane: HudPane | null): void {
      const was = split;
      split = pane !== null;
      scale = pane ? pane.scale : 1;
      el.classList.toggle('split', split);
      el.classList.toggle('cols', !!pane && pane.layout === 'columns');
      el.classList.toggle('seat0', !!pane && pane.seat === 0);
      el.classList.toggle('seat1', !!pane && pane.seat === 1);
      if (pane) {
        el.style.width = pane.w + 'px';
        el.style.height = pane.h + 'px';
        el.style.transform = `scale(${pane.scale})`;
      } else {
        el.style.width = '';
        el.style.height = '';
        el.style.transform = '';
      }
      tower.setSeat(pane ? pane.seat : null);
      minimap.setSeat(pane ? pane.seat : null);
      if (split) {
        // no telemetry overlay and no mirror strip in a pane
        tele.setVisible(false);
        teleOn = false;
        mirrorShown = false;
        el.classList.remove('has-mirror');
      } else if (was) {
        // back to the whole screen: the telemetry follows the game's flag again from the next update
        teleOn = false;
      }
      this.resize();
    },

    resize(): void {
      const px = ctx.pxScale * scale;
      speedo.resize(px);
      minimap.resize(px);
      tele.resize(px);
    },

    dispose(): void {
      el.remove();
    },
  };
  return view;
}
