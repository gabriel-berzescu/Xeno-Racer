/**
 * Xeno-Racer UI (owner: ui): menus + HUD as a DOM/CSS overlay in `#ui`.
 *
 *   const ui = createUI(document.getElementById('ui')!, deps);
 *   ui.show('title');
 *   // per frame:  const f = input.poll(dt);  if (!ui.handleInput(f)) { ...drive... }
 *   //             ui.updateHud(hudState);
 *
 * `handleInput` returns true whenever a menu screen is showing (the game should ignore the frame).
 * Intents the UI raises on its own (see UIIntent): startRace, resume, restart, quitToMenu, watchReplay,
 * settingsChanged (live, on every edit), previewCar / previewTrack (setup screen), menuOpened (only for
 * UI-initiated navigation, e.g. `setup`, `setup:car`; not echoed when the game calls `show()`), and for the
 * championship startChampionship, championshipNext and championshipAbandon. The game keeps the championship
 * and pushes a view model with `setChampionship()`; the standings and champion screens only render it.
 *
 * Split screen: `setSplit('rows' | 'columns')` gives each seat a HUD of its own in a pane over its view (the rectangles are the
 * render system's, src/core/split.ts, divided by the stage scale; src/ui/hud/panes.ts), and the divider line between them;
 * `updateHud(state, seat)` feeds each one (seat 1 only while split); `setSplit(null)` goes back to the one HUD over the whole screen.
 * The game calls setSplit before the first updateHud of a seat 1 and again with null when the race is over (results, replay, menu).
 */
import './styles/base.css';
import './styles/screens.css';
import './styles/hud.css';

import type { ChampionshipSetup, ChampionshipView, HudState, InputFrame, MinimapTrack, NowPlaying, PlayersInfo, RaceConfig, RaceResults, Seat, Settings, SplitLayout, UIIntent, UiSound } from '../core/contracts';
import type { ReplayInfo, ScreenId, UIDeps, UISystem } from '../core/systems';
import { prettyPadName } from '../input/processing';
import type { Device, UiCtx } from './ctx';
import { createHud, type HudView } from './hud';
import { dividerBackground, paneLayout } from './hud/panes';
import type { BaseScreen, ActiveScreenId } from './screens/base';
import { ChampionScreen } from './screens/champion';
import { CreditsScreen } from './screens/credits';
import { LoadingScreen } from './screens/loading';
import { MainScreen } from './screens/main';
import { PauseScreen } from './screens/pause';
import { ResultsScreen } from './screens/results';
import { SettingsScreen } from './screens/settings';
import { SetupScreen } from './screens/setup';
import { StandingsScreen } from './screens/standings';
import { TitleScreen } from './screens/title';
import type { SetupMode, SetupOpts } from './model';
import { h } from './dom';
import { iconSoundOff } from './icons';
import { ReplayOverlay } from './replay';

export type { Settings } from '../core/contracts';

export interface XenoUI extends UISystem {
  /**
   * Device indicator. `name` is the gamepad name (null = keyboard). Pass `input.warning` as the second
   * argument to show the "Switch the F310 to X mode" bar on the title screen. (If never called, the UI
   * infers both from `InputFrame.gamepadId`.)
   */
  setDevice(name: string | null, warning?: string | null): void;
}

const DESIGN_H = 1080;
const MIN_LOGICAL_W = 1500;
/** Below this logical width (about 16:10 and narrower) the dense layouts switch to their compact form. */
const NARROW_W = 1720;
/** The screens that show the sound hint (not the loading screen, not a race). */
const SOUND_HINT_SCREENS: ReadonlySet<ScreenId> = new Set(['title', 'main', 'setup', 'settings', 'pause', 'results', 'credits', 'standings', 'champion']);
/** How long the sound has to stay held back before the hint shows (where the browser lets it start by itself it is running long before). */
const SOUND_HINT_DELAY_MS = 1200;
const WARN_TEXT = 'Switch the Logitech F310 to X mode (slide the switch on the back to X, then reconnect it).';

function inferPadWarning(id: string | null): string | null {
  if (!id) return null;
  if (/standard gamepad/i.test(id)) return null;
  if (/vendor:/i.test(id) && !/xinput|xbox/i.test(id)) return WARN_TEXT; // Chrome marks remapped pads "STANDARD GAMEPAD"
  return null;
}

class UiImpl implements XenoUI {
  readonly root: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly screensEl: HTMLElement;
  /** The HUD of each seat: [0] is the one HUD of a single-player race, [1] is made the first time the screen is split. */
  private readonly huds: HudView[] = [];
  /** The box each HUD sits in (the whole stage, or the pane over one view of a split) and the line between the views. */
  private readonly panes: HTMLElement[] = [];
  private readonly divider = h('div', 'xr-split-divider');
  private minimap: MinimapTrack | null = null;
  /** Stage units -> CSS pixels of the last layout(). */
  private stageScale = 1;
  readonly ctx: UiCtx;
  private readonly screens = new Map<ActiveScreenId, BaseScreen>();
  private cur: ScreenId = 'none';
  private hudWanted = false;
  private readonly deviceCbs: (() => void)[] = [];
  private readonly settingsCbs: (() => void)[] = [];
  private readonly resizeCbs: (() => void)[] = [];
  private ro: ResizeObserver | null = null;
  private haveFrames = false;
  private explicitDevice = false;
  private explicitWarning = false;
  private frame: InputFrame | null = null;
  /** undefined until the first frame, so a pad that is already there at start does not announce itself. */
  private lastPadId: string | null | undefined = undefined;
  private shownAt = 0;
  private readonly fcopy: InputFrame;
  private prewarmTimer = 0;
  private disposed = false;
  private lastErrorAt = 0;
  private readonly notice = h('div', 'xr-notice');
  private readonly soundHint = h('div', 'xr-soundhint', iconSoundOff(), h('span', null, 'Click or press any key for sound'));
  private soundLockedAt = 0;
  private soundHintShown = false;
  private readonly replay: ReplayOverlay;
  private noticeTimer = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly deps: UIDeps,
  ) {
    const self = this;
    this.ctx = {
      deps,
      settings: structuredClone(deps.settings),
      bestLaps: { ...deps.bestLaps },
      device: 'keyboard',
      deviceName: null,
      padWarning: null,
      lastConfig: null,
      lastHud: null,
      lastHud2: null,
      results: null,
      championship: deps.championship ?? null,
      championshipDef: deps.championshipDef ?? null,
      players: { devices: [null, null], pads: 0, joined: false, owner: null, missing: null },
      nowPlaying: null,
      split: null,
      pxScale: 1,
      sound: (s: UiSound) => this.playSound(s),
      emit: (i: UIIntent) => deps.onIntent(i),
      go: (s: ScreenId) => this.switchTo(s, true),
      openSetup: (m: SetupMode, o?: SetupOpts) => this.openSetup(m, o),
      startRace: (c: RaceConfig) => this.startRace(c),
      startChampionship: (s: ChampionshipSetup) => this.startChampionship(s),
      nextRound: () => this.nextRound(),
      changed: () => this.settingsChanged(),
      onDevice: (cb) => void this.deviceCbs.push(cb),
      onSettings: (cb) => void this.settingsCbs.push(cb),
      onResize: (cb) => void this.resizeCbs.push(cb),
      get frame() {
        return self.frame;
      },
    };

    this.root = h('div', { cls: 'xr-ui', data: { input: 'kbd', fx: 'on' } });
    this.stage = h('div', 'xr-stage');
    this.screensEl = h('div', 'xr-screens');
    this.huds[0] = createHud(this.ctx);
    this.panes[0] = h('div', 'xr-pane', this.huds[0].el);
    this.replay = new ReplayOverlay(this.ctx);
    this.stage.append(this.panes[0], this.divider, this.replay.el, this.screensEl, this.notice, this.soundHint);
    this.root.appendChild(this.stage);
    container.appendChild(this.root);

    this.fcopy = {
      device: 'keyboard', gamepadId: null, steer: 0, throttle: 0, brake: 0, handbrake: 0, clutch: 0, lookX: 0, lookY: 0, lookBack: false,
      shiftUp: false, shiftDown: false, cameraNext: false, resetCar: false, pause: false, toggleHud: false, toggleTelemetry: false, nextTrack: false, nitro: false,
      nav: { up: false, down: false, left: false, right: false, confirm: false, back: false, tabLeft: false, tabRight: false },
      anyPressed: false,
    };

    this.root.addEventListener('pointermove', (e) => {
      if (e.movementX !== 0 || e.movementY !== 0) this.root.dataset.input = 'mouse';
    });
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.layout());
      this.ro.observe(container);
    }
    window.addEventListener('resize', this.layout);
    this.layout();
    this.applySettings();
    // warm the faces the first screen needs so text never flashes in a fallback font
    try {
      void document.fonts?.load('800 italic 40px "Barlow Condensed"');
      void document.fonts?.load('600 28px "Barlow Condensed"');
      void document.fonts?.load('500 24px "Barlow"');
      void document.fonts?.load('600 28px "Oxanium"');
    } catch {
      /* fonts API unavailable */
    }
    this.prewarmTimer = window.setTimeout(() => this.prewarm(), 600);
  }

  // ── layout ─────────────────────────────────────────────────────────────────

  private readonly layout = (): void => {
    const w = this.container.clientWidth || window.innerWidth;
    const hh = this.container.clientHeight || window.innerHeight;
    if (w <= 0 || hh <= 0) return;
    const s = Math.min(hh / DESIGN_H, w / MIN_LOGICAL_W);
    this.stage.style.width = w / s + 'px';
    this.stage.style.height = hh / s + 'px';
    this.stage.style.transform = `scale(${s})`;
    this.stage.toggleAttribute('data-narrow', w / s < NARROW_W);
    this.stageScale = s;
    this.ctx.pxScale = s * (window.devicePixelRatio || 1);
    for (const cb of this.resizeCbs) cb();
    for (const sc of this.screens.values()) sc.resize();
    this.layoutHuds();
  };

  /**
   * Place the HUDs: one over the whole stage, or in a split one in a pane over each view (the same rectangles the render system
   * draws the views in: core/split.ts, in CSS pixels, divided by the stage scale) with the divider in the gap between them. Runs on
   * every resize and whenever the split changes.
   */
  private layoutHuds(): void {
    const layout = this.ctx.split;
    const huds = this.huds;
    if (!layout || !huds[1]) {
      const p = this.panes[0];
      p.className = 'xr-pane';
      p.style.cssText = '';
      this.divider.className = 'xr-split-divider';
      if (this.panes[1]) this.panes[1].style.cssText = 'display:none';
      huds[0].setPane(null);
      huds[1]?.setPane(null);
      return;
    }
    const w = this.container.clientWidth || window.innerWidth;
    const hh = this.container.clientHeight || window.innerHeight;
    const s = this.stageScale;
    const pl = paneLayout(w, hh, s, layout);
    for (let seat = 0; seat < 2; seat++) {
      const pane = pl.panes[seat];
      const el = this.panes[seat];
      const r = pane.rect;
      el.className = 'xr-pane split';
      el.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
      huds[seat].setPane({ seat: seat as Seat, layout, scale: pane.scale, w: pane.box.w, h: pane.box.h });
    }
    const d = pl.divider;
    this.divider.style.cssText = `left:${d.x}px;top:${d.y}px;width:${d.w}px;height:${d.h}px;background:${dividerBackground(layout, layout === 'columns' ? d.w : d.h, 1.5 / s)}`;
    this.divider.className = 'xr-split-divider' + (this.splitShown() ? ' on' : '');
  }

  /** Is the split on screen (a race or its pause menu, not a menu screen over it)? */
  private splitShown(): boolean {
    return this.ctx.split !== null && (this.cur === 'none' || this.cur === 'pause');
  }

  // ── screens ────────────────────────────────────────────────────────────────

  private screenFor(id: ActiveScreenId): BaseScreen {
    let s = this.screens.get(id);
    if (!s) {
      switch (id) {
        case 'title': s = new TitleScreen(this.ctx); break;
        case 'main': s = new MainScreen(this.ctx); break;
        case 'setup': s = new SetupScreen(this.ctx); break;
        case 'settings': s = new SettingsScreen(this.ctx); break;
        case 'pause': s = new PauseScreen(this.ctx); break;
        case 'results': s = new ResultsScreen(this.ctx); break;
        case 'loading': s = new LoadingScreen(this.ctx); break;
        case 'credits': s = new CreditsScreen(this.ctx); break;
        case 'standings': s = new StandingsScreen(this.ctx); break;
        case 'champion': s = new ChampionScreen(this.ctx); break;
      }
      this.screensEl.appendChild(s.el);
      this.screens.set(id, s);
      s.resize();
    }
    return s;
  }

  private prewarm(): void {
    if (this.disposed) return;
    for (const id of ['title', 'main', 'setup', 'settings', 'pause', 'results', 'loading', 'credits', 'standings', 'champion'] as ActiveScreenId[]) this.screenFor(id);
  }

  private switchTo(next: ScreenId, fromUi: boolean): void {
    const prev = this.cur;
    if (next === prev) {
      if (next !== 'none') this.screens.get(next)?.refresh();
      return;
    }
    if (prev !== 'none') {
      const s = this.screens.get(prev);
      if (s) {
        s.leave();
        s.deactivate();
      }
    }
    this.cur = next;
    this.shownAt = performance.now();
    if (next !== 'none') {
      const s = this.screenFor(next);
      s.enter(prev);
      s.activate();
    }
    this.root.classList.toggle('has-screen', next !== 'none');
    this.syncHud();
    if (fromUi && next !== 'none') this.deps.onIntent({ type: 'menuOpened', screen: next });
  }

  private openSetup(mode: SetupMode, opts?: SetupOpts): void {
    (this.screenFor('setup') as SetupScreen).configure(mode, opts);
    this.switchTo('setup', true);
  }

  private startRace(config: RaceConfig): void {
    this.ctx.lastConfig = config;
    this.deps.onIntent({ type: 'startRace', config });
    this.switchTo('loading', false); // the game will call show('loading') too: idempotent
  }

  /**
   * The championship intents do not switch to the loading screen themselves: the game does, in the same call, once it
   * has described the round with `setRaceConfig()` and really starts the race. If it ignores the intent the player
   * stays where they are instead of waiting on a loading screen that never ends.
   */
  private startChampionship(setup: ChampionshipSetup): void {
    this.deps.onIntent({ type: 'startChampionship', setup });
  }

  private nextRound(): void {
    const v = this.ctx.championship;
    if (!v || v.complete) return; // nothing left to race
    this.deps.onIntent({ type: 'championshipNext' });
  }

  // ── settings ───────────────────────────────────────────────────────────────

  private applySettings(): void {
    this.root.dataset.fx = this.ctx.settings.graphics.quality === 'low' ? 'off' : 'on';
    for (const hud of this.huds) hud.setSettings(this.ctx.settings);
  }

  private settingsChanged(): void {
    this.applySettings();
    this.deps.onIntent({ type: 'settingsChanged', settings: structuredClone(this.ctx.settings) });
  }

  // ── HUD visibility ─────────────────────────────────────────────────────────

  private syncHud(): void {
    const on = this.hudWanted && (this.cur === 'none' || this.cur === 'pause');
    this.huds[0].setVisible(on);
    this.huds[1]?.setVisible(on && this.ctx.split !== null);
    this.divider.classList.toggle('on', this.splitShown());
  }

  // ── sounds + notices ───────────────────────────────────────────────────────

  /** `error` is rate-limited so holding a direction against a slider limit does not machine-gun it. */
  private playSound(s: UiSound): void {
    if (s === 'error') {
      const now = performance.now();
      if (now - this.lastErrorAt < 280) return;
      this.lastErrorAt = now;
    }
    this.deps.sound(s);
  }

  private showNotice(text: string, kind: 'info' | 'warn'): void {
    this.notice.textContent = text;
    this.notice.className = 'xr-notice show ' + kind;
    window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => this.notice.classList.remove('show'), 3600);
  }

  // ── device ─────────────────────────────────────────────────────────────────

  private setActiveDevice(d: Device): void {
    if (d === this.ctx.device) return;
    this.ctx.device = d;
    for (const cb of this.deviceCbs) cb();
  }

  // ── UISystem ───────────────────────────────────────────────────────────────

  get screen(): ScreenId {
    return this.cur;
  }

  show(screen: ScreenId): void {
    this.switchTo(screen, false);
  }

  setReplay(r: ReplayInfo | null): void {
    this.replay.set(r);
  }

  /** The card is in the first seat's HUD only (a split screen shows it once, in player 1's view); the pause menu says what plays. */
  setNowPlaying(np: NowPlaying | null): void {
    this.ctx.nowPlaying = np;
    this.huds[0].nowPlaying(np);
    this.screens.get('pause')?.refresh();
  }

  setSoundLocked(locked: boolean): void {
    const now = performance.now();
    if (!locked) this.soundLockedAt = 0;
    else if (!this.soundLockedAt) this.soundLockedAt = now;
    const show = locked && now - this.soundLockedAt >= SOUND_HINT_DELAY_MS && SOUND_HINT_SCREENS.has(this.cur);
    if (show === this.soundHintShown) return;
    this.soundHintShown = show;
    this.soundHint.classList.toggle('show', show);
  }

  handleInput(f: InputFrame): boolean {
    this.frame = f;
    if (!this.haveFrames) this.haveFrames = true;
    this.setActiveDevice(f.device);
    if (f.gamepadId !== this.lastPadId) {
      const was = this.lastPadId;
      this.lastPadId = f.gamepadId;
      if (was === undefined) {
        /* first frame: just record it */
      } else if (was && !f.gamepadId) this.showNotice('Controller disconnected', 'warn');
      else if (!was && f.gamepadId) this.showNotice('Controller connected  \u00b7  ' + (prettyPadName(f.gamepadId) ?? 'Gamepad'), 'info');
      if (!this.explicitDevice) {
        this.ctx.deviceName = prettyPadName(f.gamepadId);
        if (!this.explicitWarning) this.ctx.padWarning = inferPadWarning(f.gamepadId);
        for (const cb of this.deviceCbs) cb();
      }
    }
    if (this.cur === 'none') return false;
    const s = this.screens.get(this.cur);
    if (!s) return true;
    const n = f.nav;
    if (n.up || n.down || n.left || n.right || n.confirm || n.back || f.anyPressed) this.root.dataset.input = f.device === 'gamepad' ? 'pad' : 'kbd';

    // Keys that were still held when this screen opened (e.g. throttle) must not scroll the new menu.
    const settling = performance.now() - this.shownAt < 280;
    const c = this.fcopy;
    Object.assign(c, f);
    c.nav = this.fcopy.nav;
    Object.assign(c.nav, n);
    if (settling) c.nav.up = c.nav.down = c.nav.left = c.nav.right = false;
    s.live(c);
    s.nav(c);
    return true;
  }

  setLoading(fraction: number, label: string): void {
    (this.screenFor('loading') as LoadingScreen).set(fraction, label);
  }

  setResults(r: RaceResults): void {
    this.ctx.results = r;
    this.ctx.lastConfig = r.config;
    this.screens.get('results')?.refresh();
  }

  setRaceConfig(c: RaceConfig | null): void {
    this.ctx.lastConfig = c;
  }

  setChampionship(v: ChampionshipView | null): void {
    this.ctx.championship = v;
    for (const s of this.screens.values()) s.refresh();
  }

  setSettings(s: Settings): void {
    this.ctx.settings = structuredClone(s);
    this.applySettings();
    for (const cb of this.settingsCbs) cb();
  }

  setBestLaps(b: Record<string, number>): void {
    this.ctx.bestLaps = { ...b };
    for (const s of this.screens.values()) s.refresh();
  }

  setHudVisible(v: boolean): void {
    this.hudWanted = v;
    this.syncHud();
  }

  setMinimap(m: MinimapTrack | null): void {
    this.minimap = m;
    for (const hud of this.huds) hud.setMinimap(m);
  }

  /** Seat 1's HUD only exists (and only takes states) while the screen is split. */
  updateHud(s: HudState, seat: Seat = 0): void {
    if (seat === 1) {
      const hud = this.huds[1];
      if (!hud || this.ctx.split === null) return;
      this.ctx.lastHud2 = s;
      hud.update(s);
      return;
    }
    this.ctx.lastHud = s;
    this.huds[0].update(s);
  }

  setSplit(layout: SplitLayout | null): void {
    if (layout !== null) this.ensureSecondHud();
    const changed = layout !== this.ctx.split;
    this.ctx.split = layout;
    if (layout === null) this.ctx.lastHud2 = null;
    if (changed) {
      this.syncHud();
      this.layoutHuds();
    }
  }

  /** The second seat's HUD is built the first time a race is split, and kept. */
  private ensureSecondHud(): void {
    if (this.huds[1]) return;
    const hud = createHud(this.ctx);
    hud.setSettings(this.ctx.settings);
    hud.setMinimap(this.minimap);
    this.huds[1] = hud;
    const pane = h('div', 'xr-pane', hud.el);
    this.panes[1] = pane;
    this.stage.insertBefore(pane, this.divider);
  }

  setPlayers(info: PlayersInfo): void {
    this.ctx.players = info;
    for (const s of this.screens.values()) s.refresh();
  }

  setDevice(name: string | null, warning?: string | null): void {
    // (the game says it every frame: only a change reaches the screens)
    const warnChanged = warning !== undefined && (!this.explicitWarning || warning !== this.ctx.padWarning);
    if (this.explicitDevice && name === this.ctx.deviceName && !warnChanged) return;
    this.explicitDevice = true;
    this.ctx.deviceName = name;
    if (warning !== undefined) {
      this.explicitWarning = true;
      this.ctx.padWarning = warning;
    }
    if (!this.haveFrames) this.ctx.device = name ? 'gamepad' : 'keyboard';
    for (const cb of this.deviceCbs) cb();
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.prewarmTimer);
    window.clearTimeout(this.noticeTimer);
    window.removeEventListener('resize', this.layout);
    this.ro?.disconnect();
    for (const s of this.screens.values()) s.dispose();
    for (const hud of this.huds) hud.dispose();
    this.root.remove();
  }
}

export function createUI(container: HTMLElement, deps: UIDeps): XenoUI {
  return new UiImpl(container, deps);
}
