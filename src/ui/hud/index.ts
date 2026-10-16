/**
 * The race HUD: position / lap + standings tower (top-left), lap timing (top-right), minimap
 * (bottom-left), speed / gear / revs / pedals / assists (bottom-right), start lights, banners and
 * toasts (center), and the telemetry overlay. `update()` runs at the game's frame rate: it only
 * writes to the DOM when a value changes, uses transforms for bars and canvases for graphs.
 */
import type { HudState, MinimapTrack, Settings } from '../../core/contracts';
import type { UiCtx } from '../ctx';
import { h } from '../dom';
import { Center } from './center';
import { HudMinimap } from './minimap';
import { Spotter } from './spotter';
import { Speedo } from './speedo';
import { Telemetry } from './telemetry';
import { PosLap, TimingPanel } from './timing';
import { Tower } from './tower';

export interface HudView {
  readonly el: HTMLElement;
  update(s: HudState): void;
  setMinimap(m: MinimapTrack | null): void;
  setSettings(s: Settings): void;
  setVisible(v: boolean): void;
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
  const center = new Center(el);

  let visible = false;
  let teleOn = false;
  let clean = false;
  let standingsOn = true;
  let mirrorShown = false;

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
      const mirror = !clean && s.mirror === true;
      if (mirror !== mirrorShown) {
        mirrorShown = mirror;
        el.classList.toggle('has-mirror', mirror);
      }
      center.update(s);
      if (clean) return; // photo mode: only the center messages stay

      spotter.update(s);
      posLap.update(s);
      if (standingsOn) tower.update(s);
      timing.update(s);
      speedo.update(s, now);
      minimap.update(s, now);

      if (s.showTelemetry !== teleOn) {
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

    resize(): void {
      const px = ctx.pxScale;
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
