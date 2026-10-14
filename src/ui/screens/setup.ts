import type { InputFrame, MinimapTrack, RaceMode } from '../../core/contracts';
import type { ScreenId } from '../../core/systems';
import type { UiCtx } from '../ctx';
import { clearEl, h } from '../dom';
import { formatLapTime, formatLength } from '../format';
import { iconPlay } from '../icons';
import {
  applyTrackDefaults, bestLapFor, buildRaceConfig, carStatBars, defaultSetup, DIFFICULTIES, LAPS_MAX, LAPS_MIN, LIVERY_PRESETS, liveryFor,
  MODE_INFO, OPPONENTS_MAX, OPTION_LABELS, SETUP_STEPS, STARTS, TIMES, WEATHERS, type SetupState, type SetupStep,
} from '../model';
import { FocusList, type FocusRow } from '../nav';
import { drawTrack, MENU_MAP_STYLE, sizeCanvas } from '../trackmap';
import type { MapFit } from '../hudlogic';
import { chevron, pips, selectRow, stepperRow, StatBars, TabBar, type RowHandle } from '../widgets';
import { BaseScreen } from './base';

const STEP_LABEL: Record<SetupStep, string> = { track: 'Track', car: 'Car', race: 'Race' };
const STEP_TITLE: Record<SetupStep, string> = { track: 'Choose your track', car: 'Choose your car', race: 'Race setup' };

const MAP_W = 576;
const MAP_H = 330;

export class SetupScreen extends BaseScreen {
  readonly id = 'setup' as const;

  private state: SetupState;
  private step: SetupStep = 'track';
  private readonly lists: Record<SetupStep, FocusList> = { track: new FocusList(false), car: new FocusList(false), race: new FocusList(false) };
  private readonly views = {} as Record<SetupStep, HTMLElement>;
  private readonly tabs: TabBar;
  private readonly kicker = h('div', 'kicker');
  private readonly title = h('h1', 'h1');
  private flip = 0;

  // track step
  private trackCards: HTMLElement[] = [];
  private readonly mapCanvas = h('canvas', 'map-canvas');
  private mapCache = new Map<string, { canvas: HTMLCanvasElement; fit: MapFit; px: number }>();
  private readonly tName = h('h2', 'sd-name');
  private readonly tPlace = h('div', 'sd-place');
  private readonly tDesc = h('p', 'sd-desc');
  private readonly tLength = h('div', 'v');
  private readonly tDiff = h('div', 'v');
  private readonly tLaps = h('div', 'v');
  private readonly tBest = h('div', 'v');
  private mapUnavailable = h('div', 'map-na', 'Map unavailable');
  private animRaf = 0;

  // car step
  private readonly cMaker = h('div', 'car-maker');
  private readonly cName = h('h2', 'car-name');
  private readonly cChips = h('div', 'car-chips');
  private readonly cDesc = h('p', 'car-desc');
  private readonly cStats = new StatBars();
  private readonly cBest = h('div', 'car-best');
  private readonly cPager = h('div', 'car-pager');
  private carRow!: HTMLElement;
  private swatches: HTMLElement[] = [];
  private readonly liveryName = h('span', 'liv-name');

  // race step
  private raceRows: RowHandle[] = [];
  private raceList: HTMLElement = h('div', 'rows');
  private startBtn: HTMLElement = h('div');
  private readonly sumTrack = h('div', 'v');
  private readonly sumCar = h('div', 'v');
  private readonly sumMode = h('div', 'v');
  private readonly sumBest = h('div', 'v');
  private readonly sumCanvas = h('canvas', 'map-canvas');

  constructor(ctx: UiCtx) {
    super(ctx, 'setup');
    this.state = defaultSetup('race', ctx.deps.tracks, ctx.deps.cars);
    this.tabs = new TabBar(ctx, SETUP_STEPS.map((s, i) => ({ id: s, label: `${i + 1}  ${STEP_LABEL[s]}` })), (i) => this.goStep(SETUP_STEPS[i], false));
    this.views.track = this.buildTrackView();
    this.views.car = this.buildCarView();
    this.views.race = this.buildRaceView();
    this.rebuildRaceRows();
    const body = h('div', 'setup-body', this.views.track, this.views.car, this.views.race);
    this.el.append(
      h('div', 'scrim scrim-top'),
      h('div', 'scrim scrim-left'),
      h('div', 'scrim scrim-bottom'),
      h('header', 'topbar', h('div', { cls: 'in', style: { '--d': '60', '--tx': '-60px' } }, this.kicker, this.title), h('div', { cls: 'in', style: { '--d': '160', '--tx': '0px', '--ty': '-24px' } }, this.tabs.el)),
      body,
      this.prompts.el,
    );
    ctx.onSettings(() => this.refresh());
    ctx.onResize(() => this.drawMaps());
  }

  // ── public ─────────────────────────────────────────────────────────────────

  /** Reset the wizard for a mode (keeps the last track / car / livery). */
  configure(mode: RaceMode): void {
    this.state = defaultSetup(mode, this.ctx.deps.tracks, this.ctx.deps.cars, this.state);
    this.rebuildRaceRows();
    this.step = 'track';
    this.renderAll();
  }

  enter(_from: ScreenId): void {
    this.step = 'track';
    this.renderAll();
    this.showStep('track', false);
    this.startAnim();
    this.ctx.emit({ type: 'previewTrack', trackId: this.track().id });
  }

  leave(): void {
    this.stopAnim();
  }

  dispose(): void {
    this.stopAnim();
  }

  refresh(): void {
    this.renderAll();
  }

  resize(): void {
    this.drawMaps();
  }

  // ── data ───────────────────────────────────────────────────────────────────

  private track() {
    const t = this.ctx.deps.tracks;
    return t[Math.min(this.state.trackIndex, t.length - 1)];
  }
  private car() {
    const c = this.ctx.deps.cars;
    return c[Math.min(this.state.carIndex, c.length - 1)];
  }
  private units() {
    return this.ctx.settings.units;
  }

  // ── step control ───────────────────────────────────────────────────────────

  private goStep(step: SetupStep, tabAlready: boolean): void {
    if (step === this.step) return;
    this.step = step;
    if (!tabAlready) this.tabs.setIndex(SETUP_STEPS.indexOf(step));
    this.showStep(step, true);
    this.ctx.emit({ type: 'menuOpened', screen: 'setup:' + step });
    if (step === 'car') this.previewCar();
    if (step === 'track') this.ctx.emit({ type: 'previewTrack', trackId: this.track().id });
  }

  private showStep(step: SetupStep, animate: boolean): void {
    for (const s of SETUP_STEPS) this.views[s].style.display = s === step ? '' : 'none';
    this.tabs.setIndex(SETUP_STEPS.indexOf(step));
    this.title.textContent = STEP_TITLE[step];
    this.kicker.textContent = `${MODE_INFO[this.state.mode].label}  ·  Setup`;
    if (animate) {
      this.flip ^= 1;
      this.views[step].setAttribute('data-flip', String(this.flip));
    }
    this.updatePrompts();
    this.renderAll();
    if (step === 'track') this.lists.track.focus(this.state.trackIndex);
    this.drawMaps();
  }

  /** Advance one step. `sound` is false when the caller (the nav handler) already plays it. */
  private nextStep(sound = false): void {
    const i = SETUP_STEPS.indexOf(this.step);
    if (i < SETUP_STEPS.length - 1) {
      if (sound) this.ctx.sound('select');
      this.goStep(SETUP_STEPS[i + 1], false);
    }
  }

  private prevStep(): void {
    const i = SETUP_STEPS.indexOf(this.step);
    this.ctx.sound('back');
    if (i > 0) this.goStep(SETUP_STEPS[i - 1], false);
    else this.ctx.go('main');
  }

  private updatePrompts(): void {
    if (this.step === 'track') {
      this.prompts.set([{ action: 'navigate', label: 'Browse' }, { action: 'confirm', label: 'Choose' }, { action: 'tabs', label: 'Step' }, { action: 'back', label: 'Back' }]);
    } else if (this.step === 'car') {
      this.prompts.set([{ action: 'adjust', label: 'Change' }, { action: 'navigate', label: 'Livery' }, { action: 'confirm', label: 'Continue' }, { action: 'tabs', label: 'Step' }, { action: 'back', label: 'Back' }]);
    } else {
      this.prompts.set([{ action: 'navigate', label: 'Select' }, { action: 'adjust', label: 'Change' }, { action: 'confirm', label: 'Confirm' }, { action: 'tabs', label: 'Step' }, { action: 'back', label: 'Back' }]);
    }
  }

  // ── track step ─────────────────────────────────────────────────────────────

  private buildTrackView(): HTMLElement {
    const tracks = this.ctx.deps.tracks;
    const list = h('div', 'track-list');
    const rows: FocusRow[] = tracks.map((t, i) => {
      const card = h(
        'div',
        { cls: 'track-card focusable in', style: { '--d': String(160 + i * 60), '--tx': '-60px', '--accent': t.color } },
        h('i', 'tc-accent'),
        h('span', 'tc-idx', String(i + 1).padStart(2, '0')),
        h('div', 'tc-main', h('div', 'tc-name', t.name), h('div', 'tc-place', t.location)),
        h('div', 'tc-side', pips(t.difficulty, 5, t.difficulty >= 4), h('div', 'tc-len', formatLength(t.lengthHint, this.units()))),
      );
      card.addEventListener('pointermove', (e) => {
        if ((e as PointerEvent).movementX !== 0 || (e as PointerEvent).movementY !== 0) {
          if (this.lists.track.focus(i)) this.ctx.sound('move');
        }
      });
      card.addEventListener('click', () => {
        this.lists.track.focus(i);
        this.nextStep(true);
      });
      list.appendChild(card);
      this.trackCards.push(card);
      return {
        setFocused: (on: boolean) => card.classList.toggle('is-focus', on),
        onFocus: () => this.selectTrack(i),
        activate: () => (this.nextStep(), true),
      };
    });
    this.lists.track.setRows(rows, this.state.trackIndex);

    const detail = h(
      'div',
      { cls: 'panel chamfer edge track-detail in', style: { '--d': '260', '--tx': '70px' } },
      h('div', 'map-wrap', this.mapCanvas, this.mapUnavailable),
      h('div', 'sd-head', this.tName, this.tPlace),
      this.tDesc,
      h(
        'div',
        'sd-grid',
        h('div', 'kv', h('span', 'k', 'Length'), this.tLength),
        h('div', 'kv', h('span', 'k', 'Difficulty'), this.tDiff),
        h('div', 'kv', h('span', 'k', 'Default laps'), this.tLaps),
        h('div', 'kv', h('span', 'k', 'Best lap'), this.tBest),
      ),
    );
    return h('div', 'setup-view view-track', list, detail);
  }

  private selectTrack(i: number): void {
    const changed = i !== this.state.trackIndex;
    this.state.trackIndex = i;
    if (changed) {
      applyTrackDefaults(this.state, this.track());
      this.ctx.emit({ type: 'previewTrack', trackId: this.track().id });
    }
    this.renderTrackDetail();
    this.rebuildRaceRowsValues();
  }

  private renderTrackDetail(): void {
    const t = this.track();
    this.tName.textContent = t.name;
    this.tPlace.textContent = t.location;
    this.tDesc.textContent = t.description;
    this.tLength.textContent = formatLength(t.lengthHint, this.units());
    clearEl(this.tDiff);
    this.tDiff.appendChild(pips(t.difficulty, 5, t.difficulty >= 4));
    this.tLaps.textContent = String(t.defaultLaps);
    const best = bestLapFor(this.ctx.bestLaps, t.id);
    const carName = best ? this.ctx.deps.cars.find((c) => c.id === best.carId)?.name : undefined;
    this.tBest.textContent = best ? formatLapTime(best.time) : 'No lap yet';
    this.tBest.classList.toggle('dim', !best);
    this.tBest.title = carName ?? '';
    this.trackCards.forEach((c, i) => {
      const tt = this.ctx.deps.tracks[i];
      const len = c.querySelector('.tc-len');
      if (len) len.textContent = formatLength(tt.lengthHint, this.units());
    });
    this.drawMaps();
  }

  // ── car step ───────────────────────────────────────────────────────────────

  private buildCarView(): HTMLElement {
    const chevL = chevron('l');
    const chevR = chevron('r');
    chevL.addEventListener('click', () => this.setCar(this.state.carIndex - 1));
    chevR.addEventListener('click', () => this.setCar(this.state.carIndex + 1));
    this.carRow = h('div', { cls: 'car-hero focusable in', style: { '--d': '120', '--tx': '-60px' } }, this.cMaker, h('div', 'car-title', chevL, this.cName, chevR), this.cChips, this.cPager);

    const sw = h('div', 'swatches');
    LIVERY_PRESETS.forEach((p, i) => {
      const e = h('div', { cls: 'swatch focusable', title: p.name });
      const fill = h('i');
      e.appendChild(fill);
      e.addEventListener('click', () => this.setLivery(i));
      this.swatches.push(e);
      sw.appendChild(e);
    });
    const livRow = h('div', { cls: 'liv-row focusable in', style: { '--d': '420', '--tx': '-60px' } }, h('div', 'liv-k', h('span', null, 'Livery'), this.liveryName), sw);

    const next = h('div', { cls: 'btn primary focusable in', style: { '--d': '520', '--tx': '-60px' } }, h('span', null, 'Race options'), iconPlay('ico'));
    next.addEventListener('click', () => this.nextStep(true));

    const rows: FocusRow[] = [
      {
        setFocused: (on) => this.carRow.classList.toggle('is-focus', on),
        left: () => this.setCar(this.state.carIndex - 1),
        right: () => this.setCar(this.state.carIndex + 1),
        activate: () => (this.nextStep(), true),
      },
      {
        setFocused: (on) => livRow.classList.toggle('is-focus', on),
        left: () => this.setLivery(this.state.liveryIndex - 1),
        right: () => this.setLivery(this.state.liveryIndex + 1),
        activate: () => (this.nextStep(), true),
      },
      { setFocused: (on) => next.classList.toggle('is-focus', on), activate: () => (this.nextStep(), true) },
    ];
    this.lists.car.setRows(rows, 0);
    for (const [i, el] of [this.carRow, livRow, next].entries()) {
      el.addEventListener('pointermove', (e) => {
        if ((e as PointerEvent).movementX !== 0 || (e as PointerEvent).movementY !== 0) {
          if (this.lists.car.focus(i)) this.ctx.sound('move');
        }
      });
    }

    const info = h('div', { cls: 'car-info in', style: { '--d': '260', '--tx': '-60px' } }, this.cDesc, this.cStats.el, this.cBest);
    return h('div', 'setup-view view-car', h('div', 'car-col', this.carRow, info), h('div', 'car-actions', livRow, next));
  }

  private setCar(i: number): boolean {
    const n = this.ctx.deps.cars.length;
    const j = ((i % n) + n) % n;
    if (j === this.state.carIndex) return false;
    this.state.carIndex = j;
    this.renderCar();
    this.previewCar();
    return true;
  }

  private setLivery(i: number): boolean {
    const n = LIVERY_PRESETS.length;
    const j = ((i % n) + n) % n;
    if (j === this.state.liveryIndex) return false;
    this.state.liveryIndex = j;
    this.renderLivery();
    this.renderSummary();
    this.previewCar();
    return true;
  }

  private previewCar(): void {
    this.ctx.emit({ type: 'previewCar', carId: this.car().id, livery: liveryFor(LIVERY_PRESETS[this.state.liveryIndex], this.ctx.settings.playerName) });
  }

  private renderCar(): void {
    const c = this.car();
    const cars = this.ctx.deps.cars;
    this.cMaker.textContent = c.maker;
    this.cName.textContent = c.name;
    clearEl(this.cChips);
    this.cChips.append(h('span', 'chip teal', c.class), h('span', 'chip', c.drivetrain));
    this.cDesc.textContent = c.description;
    this.cStats.set(carStatBars(c, this.units()));
    const best = bestLapFor(this.ctx.bestLaps, this.track().id, c.id);
    this.cBest.textContent = '';
    this.cBest.append(h('span', 'k', `Best lap at ${this.track().name}`), h('span', 'v t-num', best ? formatLapTime(best.time) : 'No lap yet'));
    clearEl(this.cPager);
    cars.forEach((_, i) => this.cPager.appendChild(h('i', i === this.state.carIndex ? 'on' : null)));
    this.renderLivery();
  }

  private renderLivery(): void {
    const c = this.car();
    this.swatches.forEach((s, i) => {
      const p = LIVERY_PRESETS[i];
      const fill = s.firstElementChild as HTMLElement;
      fill.style.background = p.swatch || c.defaultLivery.primary;
      s.classList.toggle('on', i === this.state.liveryIndex);
      s.classList.toggle('factory', p.id === 'factory');
    });
    this.liveryName.textContent = LIVERY_PRESETS[this.state.liveryIndex].name;
  }

  // ── race step ──────────────────────────────────────────────────────────────

  private buildRaceView(): HTMLElement {
    const summary = h(
      'div',
      { cls: 'panel chamfer edge race-summary in', style: { '--d': '260', '--tx': '70px' } },
      h('div', 'map-wrap small', this.sumCanvas),
      h('div', 'kv', h('span', 'k', 'Track'), this.sumTrack),
      h('div', 'kv', h('span', 'k', 'Car'), this.sumCar),
      h('div', 'kv', h('span', 'k', 'Mode'), this.sumMode),
      h('div', 'kv', h('span', 'k', 'Your best'), this.sumBest),
    );
    return h('div', 'setup-view view-race', h('div', { cls: 'panel chamfer edge race-panel in', style: { '--d': '120', '--tx': '-60px' } }, this.raceList), summary);
  }

  private rebuildRaceRows(): void {
    const ctx = this.ctx;
    const s = this.state;
    const info = MODE_INFO[s.mode];
    clearEl(this.raceList);
    this.raceRows = [];
    const rows: FocusRow[] = [];
    const add = (r: RowHandle): void => {
      const i = this.raceRows.length;
      this.raceRows.push(r);
      r.el.addEventListener('pointermove', (e) => {
        if ((e as PointerEvent).movementX !== 0 || (e as PointerEvent).movementY !== 0) {
          if (this.lists.race.focus(i)) ctx.sound('move');
        }
      });
      this.raceList.appendChild(r.el);
      rows.push(r.row);
    };
    const onChange = (): void => {
      this.renderSummary();
    };
    if (info.usesLaps) {
      add(stepperRow(ctx, { label: 'Laps', min: LAPS_MIN, max: LAPS_MAX, get: () => s.laps, set: (v) => (s.laps = v), fmt: (v) => `${v} ${v === 1 ? 'lap' : 'laps'}` }, { onChange }));
    }
    if (info.usesOpponents) {
      add(stepperRow(ctx, { label: 'Opponents', min: 0, max: OPPONENTS_MAX, get: () => s.opponents, set: (v) => (s.opponents = v), fmt: (v) => (v === 0 ? 'None' : String(v)) }, { onChange }));
    }
    if (info.usesDifficulty) {
      add(selectRow(ctx, { label: 'Difficulty', options: DIFFICULTIES.map((d) => ({ value: d, label: OPTION_LABELS.difficulty[d] })), get: () => s.difficulty, set: (v) => (s.difficulty = v as SetupState['difficulty']) }, { onChange }));
    }
    add(selectRow(ctx, { label: 'Time of day', options: TIMES.map((t) => ({ value: t, label: OPTION_LABELS.time[t] })), get: () => s.timeOfDay, set: (v) => (s.timeOfDay = v as SetupState['timeOfDay']), wrap: true }, { onChange }));
    add(selectRow(ctx, { label: 'Weather', options: WEATHERS.map((w) => ({ value: w, label: OPTION_LABELS.weather[w] })), get: () => s.weather, set: (v) => (s.weather = v as SetupState['weather']) }, { onChange }));
    if (info.usesStart) {
      add(selectRow(ctx, { label: 'Start position', options: STARTS.map((p) => ({ value: p, label: p === 'back' ? 'Back' : p === 'middle' ? 'Middle' : 'Pole' })), get: () => s.startPosition, set: (v) => (s.startPosition = v as SetupState['startPosition']) }, { onChange }));
    }
    const label = s.mode === 'race' ? 'Start race' : s.mode === 'timeTrial' ? 'Start time trial' : 'Start free roam';
    this.startBtn = h('div', 'btn primary start-btn focusable', h('span', null, label), iconPlay('ico'));
    this.startBtn.addEventListener('click', () => this.start(true));
    this.raceList.appendChild(h('div', 'race-start', this.startBtn));
    const sbIndex = rows.length;
    this.startBtn.addEventListener('pointermove', (e) => {
      if ((e as PointerEvent).movementX !== 0 || (e as PointerEvent).movementY !== 0) {
        if (this.lists.race.focus(sbIndex)) ctx.sound('move');
      }
    });
    rows.push({ setFocused: (on) => this.startBtn.classList.toggle('is-focus', on), activate: () => (this.start(), true) });
    this.lists.race.setRows(rows, 0);
  }

  private rebuildRaceRowsValues(): void {
    for (const r of this.raceRows) r.refresh();
  }

  private start(sound = false): void {
    const cfg = buildRaceConfig(this.state, this.ctx.deps.tracks, this.ctx.deps.cars, this.ctx.settings.playerName);
    if (sound) this.ctx.sound('select');
    this.ctx.startRace(cfg);
  }

  private renderSummary(): void {
    const t = this.track();
    const c = this.car();
    this.sumTrack.textContent = t.name;
    this.sumCar.textContent = `${c.name}  ·  ${LIVERY_PRESETS[this.state.liveryIndex].name}`;
    this.sumMode.textContent = MODE_INFO[this.state.mode].label;
    const best = bestLapFor(this.ctx.bestLaps, t.id, c.id);
    this.sumBest.textContent = best ? formatLapTime(best.time) : 'No lap yet';
    this.drawMaps();
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  private renderAll(): void {
    this.renderTrackDetail();
    this.renderCar();
    this.renderSummary();
    this.rebuildRaceRowsValues();
    this.kicker.textContent = `${MODE_INFO[this.state.mode].label}  ·  Setup`;
  }

  /** Static track image per (track, canvas size), cached; the moving dot is drawn on top every frame. */
  private staticMap(id: string, w: number, h_: number): { canvas: HTMLCanvasElement; map: MinimapTrack | null; fit: MapFit } | null {
    const map = this.ctx.deps.minimapFor(id);
    if (!map) return null;
    const px = this.ctx.pxScale;
    const key = `${id}:${w}x${h_}:${px.toFixed(2)}`;
    let e = this.mapCache.get(key);
    if (!e) {
      const canvas = document.createElement('canvas');
      const g = sizeCanvas(canvas, w, h_, px);
      const fit: MapFit = { scale: 1, ox: 0, oy: 0, minX: 0, minZ: 0 };
      drawTrack(g, map, w, h_, 26, MENU_MAP_STYLE, fit);
      e = { canvas, fit, px };
      this.mapCache.set(key, e);
      if (this.mapCache.size > 24) this.mapCache.delete(this.mapCache.keys().next().value as string);
    }
    return { canvas: e.canvas, map, fit: e.fit };
  }

  private drawMaps(): void {
    this.drawOne(this.mapCanvas, this.track().id, MAP_W, MAP_H, this.mapUnavailable);
    this.drawOne(this.sumCanvas, this.track().id, 440, 250);
  }

  private drawOne(canvas: HTMLCanvasElement, id: string, w: number, hh: number, na?: HTMLElement): void {
    const g = sizeCanvas(canvas, w, hh, this.ctx.pxScale);
    g.clearRect(0, 0, w, hh);
    const m = this.staticMap(id, w, hh);
    if (na) na.style.display = m ? 'none' : '';
    if (!m) return;
    g.drawImage(m.canvas, 0, 0, w, hh);
    this.drawDot(g, m.map!, m.fit, performance.now());
  }

  private drawDot(g: CanvasRenderingContext2D, map: MinimapTrack, fit: MapFit, now: number): void {
    const n = map.points.length;
    if (n < 4) return;
    const t = (now / 1000) * 0.11;
    const f = (t % 1) * n;
    const trail = Math.min(26, Math.floor(n / 6));
    for (let k = trail; k >= 0; k--) {
      const idx = (((Math.floor(f) - k) % n) + n) % n;
      const p = map.points[idx];
      const x = fit.ox + (p.x - fit.minX) * fit.scale;
      const y = fit.oy + (p.z - fit.minZ) * fit.scale;
      g.beginPath();
      g.arc(x, y, k === 0 ? 7 : 4.2 * (1 - k / (trail + 2)), 0, Math.PI * 2);
      g.fillStyle = k === 0 ? '#16e0bd' : `rgba(22,224,189,${0.5 * (1 - k / (trail + 1))})`;
      g.fill();
      if (k === 0) {
        g.strokeStyle = '#03211b';
        g.lineWidth = 2;
        g.stroke();
      }
    }
  }

  private startAnim(): void {
    this.stopAnim();
    const loop = (): void => {
      this.animRaf = requestAnimationFrame(loop);
      if (this.step === 'track') this.drawOne(this.mapCanvas, this.track().id, MAP_W, MAP_H, this.mapUnavailable);
      else if (this.step === 'race') this.drawOne(this.sumCanvas, this.track().id, 440, 250);
    };
    this.animRaf = requestAnimationFrame(loop);
  }

  private stopAnim(): void {
    if (this.animRaf) cancelAnimationFrame(this.animRaf);
    this.animRaf = 0;
  }

  // ── input ──────────────────────────────────────────────────────────────────

  nav(f: InputFrame): void {
    const n = f.nav;
    if (this.tabs.handle(n)) return; // TabBar -> goStep

    if (n.back) {
      this.prevStep();
      return;
    }
    const list = this.lists[this.step];
    const r = list.handle(n);
    if (r === 'moved' || r === 'changed') this.ctx.sound('move');
    else if (r === 'activated') this.ctx.sound('select');
    else if (r === 'blocked') this.ctx.sound('error');
  }
}
