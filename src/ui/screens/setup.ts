import { WEATHER_WATER, type ChampionshipRoundDef, type Forecast, type InputFrame, type MinimapTrack, type RaceMode, type Seat, type TrackInfo } from '../../core/contracts';
import { sanitizeForecast } from '../../core/forecast';
import type { ScreenId } from '../../core/systems';
import type { UiCtx } from '../ctx';
import { clearEl, h } from '../dom';
import { forecastLabel, formatConditions, formatLapTime, formatLength, lapsLabel, TIME_OF_DAY_LABEL, weatherLabel } from '../format';
import { iconPlay } from '../icons';
import {
  type JoinView,
  applyTrackDefaults, bestLapFor, buildChampionshipSetup, buildRaceConfig, carStatBars, CHAMP_OPPONENTS_MIN, defaultSetup, DIFFICULTIES, FORECAST_CHOICES, forecastNow, forecastOffered, GRID_RULES,
  joinView, LAPS_MAX, LAPS_MIN, LENGTHS, LIVERY_PRESETS, liveryFor, MODE_INFO, modeLabel, OPPONENTS_MAX, opponentsMax, OPTION_LABELS, playersNow, seatName, SETUP_STEPS, setupStepLabel, setupSteps, splitAllowed, STARTS, stepSeat, TIMES, WEATHERS,
  type SetupMode, type SetupOpts, type SetupState, type SetupStep, type WizardStep,
} from '../model';
import { FocusList, type FocusRow } from '../nav';
import { drawTrack, MENU_MAP_STYLE, sizeCanvas } from '../trackmap';
import type { MapFit } from '../hudlogic';
import { chevron, keyGlyph, padGlyph, pips, selectRow, stepperRow, StatBars, TabBar, type RowHandle } from '../widgets';
import { BaseScreen } from './base';

const STEP_LABEL: Record<SetupStep, string> = { track: 'Track', car: 'Car', race: 'Race' };
const STEP_TITLE: Record<SetupStep, string> = { track: 'Choose your track', car: 'Choose your car', race: 'Race setup' };
/** A championship's first step is its fixed calendar, not a choice of track. */
/** The change of weather a calendar round runs at this many laps (none in a one-lap race). */
const roundChange = (r: ChampionshipRoundDef, laps: number): Forecast => sanitizeForecast(r.forecast, r.environment.weather, 'race', laps);
const CHAMP_STEP_LABEL: Record<SetupStep, string> = { track: 'Calendar', car: 'Car', race: 'Season' };
const CHAMP_STEP_TITLE: Record<SetupStep, string> = { track: 'The calendar', car: 'Choose your car', race: 'Season setup' };

const MAP_W = 576;
const MAP_H = 330;

/** The panes of the wizard: the second player's car step shows the first's car picker, or the join card before the player is in. */
type ViewKey = SetupStep | 'join';
const VIEW_KEYS: readonly ViewKey[] = ['track', 'car', 'race', 'join'];

export class SetupScreen extends BaseScreen {
  readonly id = 'setup' as const;

  private state: SetupState;
  private step: WizardStep = 'track';
  /** The second player's car step is the same picker as the first's (and so is its list of rows). */
  private readonly carList = new FocusList(false);
  private readonly lists: Record<WizardStep, FocusList> = { track: new FocusList(false), car: this.carList, car2: this.carList, race: new FocusList(false) };
  private readonly views = {} as Record<ViewKey, HTMLElement>;
  private readonly tabs: TabBar;
  private readonly kicker = h('div', 'kicker');
  private readonly title = h('h1', 'h1');
  private flip = 0;

  // track step (in a championship: the calendar, one card per round)
  private readonly trackList = h('div', 'track-list');
  private trackCards: HTMLElement[] = [];
  /** Championship: the round whose track is on show. */
  private roundIndex = 0;
  private readonly mapCanvas = h('canvas', 'map-canvas');
  private mapCache = new Map<string, { canvas: HTMLCanvasElement; fit: MapFit; px: number }>();
  private readonly tName = h('h2', 'sd-name');
  private readonly tPlace = h('div', 'sd-place');
  private readonly tDesc = h('p', 'sd-desc');
  private readonly tLength = h('div', 'v');
  private readonly tDiff = h('div', 'v');
  private readonly tLaps = h('div', 'v');
  private readonly tBest = h('div', 'v');
  /** The four labels of the detail grid (a championship round shows different facts). */
  private readonly kLabels: HTMLElement[] = [];
  private readonly sdGrid = h('div', 'sd-grid');
  private mapUnavailable = h('div', 'map-na', 'Map unavailable');
  /** "Round 2 / 4" beside the name of a calendar round. */
  private readonly mapTag = h('span', 'sd-tag');
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
  private readonly nextLabel = h('span', null, 'Race options');
  /** Split screen: whose car this is ("Player 2 · Silviu · Logitech Gamepad F310"), above the car. */
  private readonly seatTag = h('div', 'seat-tag');

  // the join card: the second player's car step, until they are in
  private readonly joinCard = h('div', { cls: 'panel chamfer edge join-card in', style: { '--d': '120', '--tx': '-60px' } });
  /** The game was told to listen for a second player (and has not been told to stop). */
  private joining = false;
  /** The screen is on show (the game's answers about the devices only matter then). */
  private open = false;

  // race step
  private raceRows: RowHandle[] = [];
  /** The Weather row's options and the Forecast row (see relabelWeather). */
  private weatherOptions: { value: string; label: string }[] = [];
  private weatherRow: RowHandle | null = null;
  private forecastRow: RowHandle | null = null;
  private raceList: HTMLElement = h('div', 'rows');
  private startBtn: HTMLElement = h('div');
  private readonly sumTrack = h('div', 'v');
  private readonly sumCar = h('div', 'v');
  private readonly sumMode = h('div', 'v');
  private readonly sumConditions = h('div', 'v');
  private readonly sumBest = h('div', 'v');
  // (split screen: the summary names both cars, and the best lap, which is the first car's, goes)
  private readonly sumCarK = h('span', 'k', 'Car');
  private readonly sumCarRow = h('div', 'kv');
  private readonly sumCar2K = h('span', 'k', 'Player 2');
  private readonly sumCar2 = h('div', 'v');
  private readonly sumCar2Row = h('div', 'kv s1');
  private readonly sumBestRow = h('div', 'kv');
  private readonly sumCanvas = h('canvas', 'map-canvas');
  private raceSummary: HTMLElement = h('div');
  // race step, championship: the season at a glance
  private champSummary: HTMLElement = h('div');
  private readonly csRounds = h('div', 'cs-rounds');
  private readonly csCar = h('div', 'v');
  private readonly csField = h('div', 'v');
  private readonly csPoints = h('div', 'cs-points t-num');
  /** What the focused season option does. */
  private readonly csHelp = h('p', 'cs-help');

  constructor(ctx: UiCtx) {
    super(ctx, 'setup');
    this.state = defaultSetup('race', ctx.deps.tracks, ctx.deps.cars);
    this.tabs = new TabBar(ctx, this.steps().map((s, i) => ({ id: s, label: this.tabLabel(s, i) })), (i) => this.goStep(this.steps()[i], false));
    this.views.track = this.buildTrackView();
    this.views.car = this.buildCarView();
    this.views.race = this.buildRaceView();
    this.views.join = h('div', 'setup-view view-join', this.joinCard);
    this.rebuildTrackCards();
    this.rebuildRaceRows();
    const body = h('div', 'setup-body', this.views.track, this.views.car, this.views.race, this.views.join);
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

  /**
   * Reset the wizard for a mode (keeps the last track / car / livery). `opts.players` is how many humans it is for (one when absent): a
   * second player left over from an earlier split-screen setup goes home when this one is for one.
   */
  configure(mode: SetupMode, opts: SetupOpts = {}): void {
    this.state = defaultSetup(mode, this.ctx.deps.tracks, this.ctx.deps.cars, { ...this.state, players: opts.players ?? 1 });
    this.roundIndex = 0;
    this.step = 'track';
    this.syncTabs();
    this.rebuildTrackCards();
    this.rebuildRaceRows();
    this.renderAll();
    if (playersNow(this.state) === 1 && this.ctx.players.joined) this.ctx.emit({ type: 'split', action: 'unbind' });
  }

  enter(_from: ScreenId): void {
    this.open = true;
    this.step = 'track';
    this.renderAll();
    this.showStep('track', false);
    this.startAnim();
    this.ctx.emit({ type: 'previewTrack', trackId: this.track().id });
  }

  leave(): void {
    this.open = false;
    this.stopAnim();
    this.endJoin();
  }

  dispose(): void {
    this.stopAnim();
  }

  refresh(): void {
    this.renderAll();
    this.syncJoin();
  }

  resize(): void {
    this.drawMaps();
  }

  // ── data ───────────────────────────────────────────────────────────────────

  private champMode(): boolean {
    return this.state.mode === 'championship';
  }

  /** The calendar entry on show (championship mode), else null. */
  private round(): ChampionshipRoundDef | null {
    return this.champMode() ? this.ctx.championshipDef?.rounds[this.roundIndex] ?? null : null;
  }

  private track(): TrackInfo {
    const t = this.ctx.deps.tracks;
    const r = this.round();
    return (r && t.find((x) => x.id === r.trackId)) || t[Math.min(this.state.trackIndex, t.length - 1)];
  }
  private car() {
    const c = this.ctx.deps.cars;
    return c[Math.min(this.state.carIndex, c.length - 1)];
  }
  private units() {
    return this.ctx.settings.units;
  }

  // ── split screen: two players, two cars ──

  /** The seat whose car the car step is picking (the second player's on the 'car2' step). */
  private seat(): Seat {
    return stepSeat(this.step);
  }
  private splitOn(): boolean {
    return playersNow(this.state) === 2;
  }
  private names(): [string, string] {
    return [seatName(this.ctx.settings, 0), seatName(this.ctx.settings, 1)];
  }
  private carIndexOf(seat: Seat): number {
    return seat === 1 ? this.state.car2Index : this.state.carIndex;
  }
  private liveryIndexOf(seat: Seat): number {
    return seat === 1 ? this.state.liveryIndex2 : this.state.liveryIndex;
  }
  private carOf(seat: Seat) {
    const c = this.ctx.deps.cars;
    return c[Math.min(this.carIndexOf(seat), c.length - 1)];
  }
  /** The car on show in the car picker. */
  private pickedCar() {
    return this.carOf(this.seat());
  }
  /** The second player is not in yet: their car step is the join card. */
  private joinShown(): boolean {
    return this.step === 'car2' && !this.ctx.players.joined;
  }
  /** Which pane a step shows. */
  private viewFor(step: WizardStep): ViewKey {
    return step === 'car2' ? (this.ctx.players.joined ? 'car' : 'join') : step;
  }

  private steps(): readonly WizardStep[] {
    return setupSteps(this.state);
  }

  private tabLabel(step: WizardStep, i: number): string {
    // (a championship has one player: its steps are always the three of SETUP_STEPS)
    const label = this.champMode() ? CHAMP_STEP_LABEL[step as SetupStep] : setupStepLabel(step, playersNow(this.state));
    return `${i + 1}  ${label}`;
  }

  /** The line above the title: the mode and "Setup", or for a split-screen setup the mode, "Split screen" and (on the car steps) what is being asked. */
  private kickerText(): string {
    const mode = modeLabel(this.state.mode);
    if (!this.splitOn()) return `${mode}  ·  Setup`;
    if (this.step === 'car2' && !this.ctx.players.joined) return `${mode}  ·  Split screen  ·  Join`;
    return this.step === 'car' || this.step === 'car2' ? `${mode}  ·  Split screen  ·  Choose your car` : `${mode}  ·  Split screen`;
  }

  /** The title of a step; the two car steps of a split-screen setup are just the player they are for, big and in that player's colour. */
  private renderTitle(step: WizardStep): void {
    if (this.splitOn() && (step === 'car' || step === 'car2')) {
      const seat = stepSeat(step);
      this.title.replaceChildren(h('span', 'seat s' + seat, `Player ${seat + 1}`));
    } else {
      this.title.textContent = (this.champMode() ? CHAMP_STEP_TITLE : STEP_TITLE)[step as SetupStep];
    }
  }

  /** The tabs of the steps this setup has (a fourth for the second player's car), the current one marked. */
  private syncTabs(): void {
    const steps = this.steps();
    this.tabs.setTabs(steps.map((s, i) => this.tabLabel(s, i)));
    this.tabs.setIndex(steps.indexOf(this.step));
    this.tabs.el.classList.toggle('four', steps.length > 3);
  }

  // ── step control ───────────────────────────────────────────────────────────

  private goStep(step: WizardStep, tabAlready: boolean): void {
    if (step === this.step) return;
    if (this.step === 'car2') this.endJoin();
    this.step = step;
    if (!tabAlready) this.tabs.setIndex(this.steps().indexOf(step));
    this.showStep(step, true);
    // (the second player's car is shown in the showroom like the first's, which the game keeps for 'setup:car')
    this.ctx.emit({ type: 'menuOpened', screen: 'setup:' + (step === 'car2' ? 'car' : step) });
    if (step === 'car' || step === 'car2') this.previewCar();
    if (step === 'track') this.ctx.emit({ type: 'previewTrack', trackId: this.track().id });
  }

  private showStep(step: WizardStep, animate: boolean): void {
    const key = this.viewFor(step);
    for (const k of VIEW_KEYS) this.views[k].style.display = k === key ? '' : 'none';
    this.tabs.setIndex(this.steps().indexOf(step));
    this.renderTitle(step);
    this.kicker.textContent = this.kickerText();
    if (animate) {
      this.flip ^= 1;
      this.views[key].setAttribute('data-flip', String(this.flip));
    }
    this.syncJoin();
    this.updatePrompts();
    this.renderAll();
    if (step === 'track') this.lists.track.focus(this.champMode() ? this.roundIndex : this.state.trackIndex);
    this.drawMaps();
  }

  /** Advance one step. `sound` is false when the caller (the nav handler) already plays it. */
  private nextStep(sound = false): void {
    const steps = this.steps();
    const i = steps.indexOf(this.step);
    if (i < steps.length - 1) {
      if (sound) this.ctx.sound('select');
      this.goStep(steps[i + 1], false);
    }
  }

  private prevStep(): void {
    const steps = this.steps();
    const i = steps.indexOf(this.step);
    this.ctx.sound('back');
    if (i > 0) this.goStep(steps[i - 1], false);
    else {
      // backing out of the setup: the second player (in or waiting) goes home
      if (this.splitOn() || this.ctx.players.joined) this.ctx.emit({ type: 'split', action: 'unbind' });
      this.ctx.go('main');
    }
  }

  private updatePrompts(): void {
    if (this.step === 'track') {
      this.prompts.set([{ action: 'navigate', label: 'Browse' }, { action: 'confirm', label: this.champMode() ? 'Continue' : 'Choose' }, { action: 'tabs', label: 'Step' }, { action: 'back', label: 'Back' }]);
    } else if (this.joinShown()) {
      this.prompts.set([{ action: 'tabs', label: 'Step' }, { action: 'back', label: 'Back' }]);
    } else if (this.step === 'car' || this.step === 'car2') {
      const swap = this.splitOn() && this.ctx.players.joined ? [{ action: 'camera' as const, label: 'Swap players' }] : [];
      this.prompts.set([{ action: 'adjust', label: 'Change' }, { action: 'navigate', label: 'Livery' }, { action: 'confirm', label: 'Continue' }, ...swap, { action: 'tabs', label: 'Step' }, { action: 'back', label: 'Back' }]);
    } else {
      this.prompts.set([{ action: 'navigate', label: 'Select' }, { action: 'adjust', label: 'Change' }, { action: 'confirm', label: 'Confirm' }, { action: 'tabs', label: 'Step' }, { action: 'back', label: 'Back' }]);
    }
  }

  // ── track step ─────────────────────────────────────────────────────────────

  private buildTrackView(): HTMLElement {
    const kv = (label: string, v: HTMLElement): HTMLElement => {
      const k = h('span', 'k', label);
      this.kLabels.push(k);
      return h('div', 'kv', k, v);
    };
    this.sdGrid.append(kv('Length', this.tLength), kv('Difficulty', this.tDiff), kv('Default laps', this.tLaps), kv('Best lap', this.tBest));
    const detail = h(
      'div',
      { cls: 'panel chamfer edge track-detail in', style: { '--d': '260', '--tx': '70px' } },
      h('div', 'map-wrap', this.mapCanvas, this.mapUnavailable),
      h('div', 'sd-head', h('div', 'sd-titles', this.tName, this.tPlace), this.mapTag),
      this.tDesc,
      this.sdGrid,
    );
    return h('div', 'setup-view view-track', this.trackList, detail);
  }

  /** The cards of the track step: every track, or in a championship the rounds of the calendar. */
  private rebuildTrackCards(): void {
    const tracks = this.ctx.deps.tracks;
    const def = this.champMode() ? this.ctx.championshipDef : null;
    clearEl(this.trackList);
    this.trackCards = [];
    const entries: { t: TrackInfo; round: ChampionshipRoundDef | null }[] = def
      ? def.rounds.map((round) => ({ t: tracks.find((x) => x.id === round.trackId) ?? tracks[0], round }))
      : tracks.map((t) => ({ t, round: null }));
    this.trackList.classList.toggle('compact', entries.length > 6);
    this.trackList.classList.toggle('dense', entries.length > 8);
    const rows: FocusRow[] = entries.map(({ t, round }, i) => {
      const card = h(
        'div',
        { cls: 'track-card focusable in', style: { '--d': String(160 + i * 60), '--tx': '-60px', '--accent': t.color } },
        h('i', 'tc-accent'),
        h('span', 'tc-idx', round ? 'R' + (i + 1) : String(i + 1).padStart(2, '0')),
        h('div', 'tc-main', h('div', 'tc-name', t.name), h('div', 'tc-place', round ? formatConditions(round.environment, roundChange(round, round.laps[this.state.champ.length]), t.winter) : t.location)),
        h('div', 'tc-side', pips(t.difficulty, 5, t.difficulty >= 4), h('div', 'tc-len', round ? lapsLabel(round.laps[this.state.champ.length]) : formatLength(t.lengthHint, this.units()))),
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
      this.trackList.appendChild(card);
      this.trackCards.push(card);
      return {
        setFocused: (on: boolean) => card.classList.toggle('is-focus', on),
        onFocus: () => (round ? this.selectRound(i) : this.selectTrack(i)),
        activate: () => (this.nextStep(), true),
      };
    });
    this.lists.track.setRows(rows, def ? this.roundIndex : this.state.trackIndex);
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

  private selectRound(i: number): void {
    const before = this.track().id;
    this.roundIndex = i;
    if (this.track().id !== before) this.ctx.emit({ type: 'previewTrack', trackId: this.track().id });
    this.renderTrackDetail();
  }

  private renderTrackDetail(): void {
    const t = this.track();
    const round = this.round();
    const def = this.ctx.championshipDef;
    this.tName.textContent = t.name;
    this.tPlace.textContent = t.location;
    this.mapTag.style.display = round && def ? '' : 'none';
    if (round && def) this.mapTag.textContent = `Round ${this.roundIndex + 1} / ${def.rounds.length}`;
    this.tDesc.textContent = t.description;
    this.sdGrid.classList.toggle('champ', !!round);
    this.tLength.textContent = formatLength(t.lengthHint, this.units());
    clearEl(this.tDiff);
    // a calendar round shows its own facts in the same four cells: length, laps, time of day, weather
    this.kLabels.forEach((k, i) => (k.textContent = (round ? ['Length', 'Laps', 'Time', 'Weather'] : ['Length', 'Difficulty', 'Default laps', this.wet() ? (t.winter ? 'Snow best lap' : 'Wet best lap') : 'Best lap'])[i]));
    if (round) {
      this.tDiff.textContent = String(round.laps[this.state.champ.length]);
      this.tLaps.textContent = TIME_OF_DAY_LABEL[round.environment.timeOfDay] ?? round.environment.timeOfDay;
      this.tBest.textContent = weatherLabel(round.environment.weather, t.winter);
      this.tBest.classList.remove('dim');
      this.tBest.title = '';
    } else {
      this.tDiff.appendChild(pips(t.difficulty, 5, t.difficulty >= 4));
      this.tLaps.textContent = String(t.defaultLaps);
      const best = bestLapFor(this.ctx.bestLaps, this.recordTrack(t.id));
      const carName = best ? this.ctx.deps.cars.find((c) => c.id === best.carId)?.name : undefined;
      this.tBest.textContent = best ? formatLapTime(best.time) : 'No lap yet';
      this.tBest.classList.toggle('dim', !best);
      this.tBest.title = carName ?? '';
    }
    this.trackCards.forEach((c, i) => {
      const len = c.querySelector('.tc-len');
      if (!len) return;
      const r = this.champMode() ? def?.rounds[i] : undefined;
      len.textContent = r ? lapsLabel(r.laps[this.state.champ.length]) : formatLength(this.ctx.deps.tracks[i]?.lengthHint ?? 0, this.units());
    });
    this.drawMaps();
  }

  // ── car step ───────────────────────────────────────────────────────────────

  private buildCarView(): HTMLElement {
    const chevL = chevron('l');
    const chevR = chevron('r');
    chevL.addEventListener('click', () => this.setCar(this.carIndexOf(this.seat()) - 1));
    chevR.addEventListener('click', () => this.setCar(this.carIndexOf(this.seat()) + 1));
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

    const next = h('div', { cls: 'btn primary focusable in', style: { '--d': '520', '--tx': '-60px' } }, this.nextLabel, iconPlay('ico'));
    next.addEventListener('click', () => this.nextStep(true));

    const rows: FocusRow[] = [
      {
        setFocused: (on) => this.carRow.classList.toggle('is-focus', on),
        left: () => this.setCar(this.carIndexOf(this.seat()) - 1),
        right: () => this.setCar(this.carIndexOf(this.seat()) + 1),
        activate: () => (this.nextStep(), true),
      },
      {
        setFocused: (on) => livRow.classList.toggle('is-focus', on),
        left: () => this.setLivery(this.liveryIndexOf(this.seat()) - 1),
        right: () => this.setLivery(this.liveryIndexOf(this.seat()) + 1),
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
    return h('div', 'setup-view view-car', this.seatTag, h('div', 'car-col', this.carRow, info), h('div', 'car-actions', livRow, next));
  }

  /** The picker works on the seat the step belongs to: the first player's car and livery, or the second player's. */
  private setCar(i: number): boolean {
    const n = this.ctx.deps.cars.length;
    const j = ((i % n) + n) % n;
    if (j === this.carIndexOf(this.seat())) return false;
    if (this.seat() === 1) this.state.car2Index = j;
    else this.state.carIndex = j;
    this.renderCar();
    this.previewCar();
    return true;
  }

  private setLivery(i: number): boolean {
    const n = LIVERY_PRESETS.length;
    const j = ((i % n) + n) % n;
    if (j === this.liveryIndexOf(this.seat())) return false;
    if (this.seat() === 1) this.state.liveryIndex2 = j;
    else this.state.liveryIndex = j;
    this.renderLivery();
    this.renderSummary();
    this.previewCar();
    return true;
  }

  private previewCar(): void {
    const seat = this.seat();
    this.ctx.emit({ type: 'previewCar', carId: this.pickedCar().id, livery: liveryFor(LIVERY_PRESETS[this.liveryIndexOf(seat)], this.names()[seat]) });
  }

  /** Whose car the picker shows: the seat tag above it, and the second player's step in their colour. */
  private renderSeat(): void {
    const split = this.splitOn();
    const seat = this.seat();
    this.views.car.classList.toggle('seat1', split && seat === 1);
    this.seatTag.style.display = split ? '' : 'none';
    if (!split) return;
    const device = this.ctx.players.devices[seat];
    this.seatTag.className = 'seat-tag s' + seat;
    this.seatTag.replaceChildren(h('b', null, this.names()[seat]));
    if (device) this.seatTag.append(h('em', null, device));
  }

  private renderCar(): void {
    const c = this.pickedCar();
    const cars = this.ctx.deps.cars;
    this.renderSeat();
    this.cMaker.textContent = c.maker;
    this.cName.textContent = c.name;
    clearEl(this.cChips);
    this.cChips.append(h('span', 'chip teal', c.class), h('span', 'chip', c.drivetrain));
    this.cDesc.textContent = c.description;
    this.cStats.set(carStatBars(c, this.units()));
    // a championship runs on several tracks: no single best lap to show
    this.cBest.style.display = this.champMode() ? 'none' : '';
    this.nextLabel.textContent = this.champMode() ? 'Season options' : 'Race options';
    const best = bestLapFor(this.ctx.bestLaps, this.recordTrack(this.track().id), c.id);
    this.cBest.textContent = '';
    this.cBest.append(h('span', 'k', `${this.wet() ? 'Wet best lap' : 'Best lap'} at ${this.track().name}`), h('span', 'v t-num', best ? formatLapTime(best.time) : 'No lap yet'));
    clearEl(this.cPager);
    cars.forEach((_, i) => this.cPager.appendChild(h('i', i === this.carIndexOf(this.seat()) ? 'on' : null)));
    this.renderLivery();
  }

  private renderLivery(): void {
    const c = this.pickedCar();
    const picked = this.liveryIndexOf(this.seat());
    this.swatches.forEach((s, i) => {
      const p = LIVERY_PRESETS[i];
      const fill = s.firstElementChild as HTMLElement;
      fill.style.background = p.swatch || c.defaultLivery.primary;
      s.classList.toggle('on', i === picked);
      s.classList.toggle('factory', p.id === 'factory');
    });
    this.liveryName.textContent = LIVERY_PRESETS[picked].name;
  }

  // ── race step ──────────────────────────────────────────────────────────────

  private buildRaceView(): HTMLElement {
    this.sumCarRow.append(this.sumCarK, this.sumCar);
    this.sumCar2Row.append(this.sumCar2K, this.sumCar2);
    this.sumBestRow.append(h('span', 'k', 'Your best'), this.sumBest);
    this.raceSummary = h(
      'div',
      { cls: 'panel chamfer edge race-summary in', style: { '--d': '260', '--tx': '70px' } },
      h('div', 'map-wrap small', this.sumCanvas),
      h('div', 'kv', h('span', 'k', 'Track'), this.sumTrack),
      this.sumCarRow,
      this.sumCar2Row,
      h('div', 'kv', h('span', 'k', 'Mode'), this.sumMode),
      h('div', 'kv', h('span', 'k', 'Conditions'), this.sumConditions),
      this.sumBestRow,
    );
    this.champSummary = h(
      'div',
      { cls: 'panel chamfer edge race-summary champ-summary in', style: { '--d': '260', '--tx': '70px' } },
      h('div', 'cs-k', 'The season'),
      this.csRounds,
      h('div', 'kv', h('span', 'k', 'Car'), this.csCar),
      h('div', 'kv', h('span', 'k', 'Field'), this.csField),
      h('div', 'kv', h('span', 'k', 'Points for 1st to 10th'), this.csPoints),
    );
    // the help for the focused season option sits under the options themselves (a six-round calendar fills the summary)
    return h('div', 'setup-view view-race', h('div', { cls: 'panel chamfer edge race-panel in', style: { '--d': '120', '--tx': '-60px' } }, this.raceList, this.csHelp), this.raceSummary, this.champSummary);
  }

  private rebuildRaceRows(): void {
    const ctx = this.ctx;
    const s = this.state;
    const champ = this.champMode();
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
    if (champ) {
      const c = s.champ;
      // each season option explains itself in the summary while it has the focus
      const help = (text: string) => (r: RowHandle): RowHandle => {
        r.row.onFocus = () => {
          this.csHelp.textContent = text;
        };
        return r;
      };
      add(help('How many rivals you race all season. They keep their names, colours and pace from round to round.')(stepperRow(ctx, { label: 'Opponents', min: CHAMP_OPPONENTS_MIN, max: OPPONENTS_MAX, get: () => c.opponents, set: (v) => (c.opponents = v) }, { onChange })));
      add(help('How hard the rivals drive. Everyone races your car, so it comes down to driving.')(selectRow(ctx, { label: 'Difficulty', options: DIFFICULTIES.map((d) => ({ value: d, label: OPTION_LABELS.difficulty[d] })), get: () => c.difficulty, set: (v) => (c.difficulty = v as typeof c.difficulty) }, { onChange })));
      add(help('Short is half the usual race at each circuit, Long is double. The laps for every round are listed above.')(selectRow(ctx, { label: 'Race length', options: LENGTHS.map((l) => ({ value: l, label: OPTION_LABELS.length[l] })), get: () => c.length, set: (v) => (c.length = v as typeof c.length) }, { onChange: () => (onChange(), this.renderTrackDetail()) })));
      add(help('Where you start the first race. From round 2 the grid follows the championship.')(selectRow(ctx, { label: 'Round 1 start', options: STARTS.map((p) => ({ value: p, label: p === 'back' ? 'Back' : p === 'middle' ? 'Middle' : 'Pole' })), get: () => c.startPosition, set: (v) => (c.startPosition = v as typeof c.startPosition) }, { onChange })));
      add(help('Standings: the championship leader starts on pole. Reverse: the leader starts last, and the back of the order starts up front.')(selectRow(ctx, { label: 'Later grids', options: GRID_RULES.map((g) => ({ value: g, label: OPTION_LABELS.grid[g] })), get: () => c.grid, set: (v) => (c.grid = v as typeof c.grid) }, { onChange })));
    } else {
      const info = MODE_INFO[s.mode as RaceMode];
      // split screen: a second human, in a race or in free roam (the opponents stepper below follows the choice)
      if (splitAllowed(s.mode)) {
        add(selectRow(ctx, { label: 'Players', options: [{ value: '1', label: '1 player' }, { value: '2', label: '2 players' }], get: () => String(s.players), set: (v) => this.setPlayerCount(v === '2' ? 2 : 1) }, { onChange }));
      }
      if (info.usesLaps) {
        // (a race of one lap cannot run a forecast: the Forecast row follows the laps)
        add(stepperRow(ctx, { label: 'Laps', min: LAPS_MIN, max: LAPS_MAX, get: () => s.laps, set: (v) => (s.laps = v), fmt: (v) => `${v} ${v === 1 ? 'lap' : 'laps'}` }, { onChange: () => (onChange(), this.rebuildRaceRowsValues()) }));
      }
      if (info.usesOpponents) {
        add(stepperRow(ctx, { label: 'Opponents', min: 0, max: OPPONENTS_MAX, limit: () => opponentsMax(s), get: () => s.opponents, set: (v) => (s.opponents = v), fmt: (v) => (v === 0 ? 'None' : String(v)) }, { onChange }));
      }
      if (info.usesDifficulty) {
        add(selectRow(ctx, { label: 'Difficulty', options: DIFFICULTIES.map((d) => ({ value: d, label: OPTION_LABELS.difficulty[d] })), get: () => s.difficulty, set: (v) => (s.difficulty = v as SetupState['difficulty']) }, { onChange }));
      }
      add(selectRow(ctx, { label: 'Time of day', options: TIMES.map((t) => ({ value: t, label: OPTION_LABELS.time[t] })), get: () => s.timeOfDay, set: (v) => (s.timeOfDay = v as SetupState['timeOfDay']), wrap: true }, { onChange }));
      // a change of weather changes what the forecast can be (rain later from a dry start, clearing from a wet one)
      this.weatherOptions = WEATHERS.map((w) => ({ value: w, label: OPTION_LABELS.weather[w] }));
      this.weatherRow = selectRow(ctx, { label: 'Weather', options: this.weatherOptions, get: () => s.weather, set: (v) => (s.weather = v as SetupState['weather']) }, { onChange: () => (onChange(), this.rebuildRaceRowsValues()) });
      add(this.weatherRow);
      this.forecastRow = null;
      if (s.mode !== 'timeTrial') {
        this.forecastRow = selectRow(
          ctx,
          {
            label: 'Forecast',
            options: FORECAST_CHOICES.map((f) => ({ value: f, label: OPTION_LABELS.forecast[f] })),
            get: () => forecastNow(s),
            set: (v) => (s.forecast = v as Forecast),
            wrap: true,
            enabled: (v) => forecastOffered(s, v as Forecast),
          },
          { onChange },
        );
        add(this.forecastRow);
      }
      this.relabelWeather();
      if (info.usesStart) {
        add(selectRow(ctx, { label: 'Start position', options: STARTS.map((p) => ({ value: p, label: p === 'back' ? 'Back' : p === 'middle' ? 'Middle' : 'Pole' })), get: () => s.startPosition, set: (v) => (s.startPosition = v as SetupState['startPosition']) }, { onChange }));
      }
    }
    const label = champ ? 'Start championship' : s.mode === 'race' ? 'Start race' : s.mode === 'timeTrial' ? 'Start time trial' : 'Start free roam';
    this.startBtn = h('div', 'btn primary start-btn focusable', h('span', null, label), iconPlay('ico'));
    this.startBtn.addEventListener('click', () => this.start(true));
    this.raceList.appendChild(h('div', 'race-start', this.startBtn));
    const sbIndex = rows.length;
    this.startBtn.addEventListener('pointermove', (e) => {
      if ((e as PointerEvent).movementX !== 0 || (e as PointerEvent).movementY !== 0) {
        if (this.lists.race.focus(sbIndex)) ctx.sound('move');
      }
    });
    rows.push({
      setFocused: (on) => this.startBtn.classList.toggle('is-focus', on),
      onFocus: champ
        ? () => {
            this.csHelp.textContent = 'Race round 1 of the season. Your progress is saved after every round, so you can stop whenever you like.';
          }
        : undefined,
      activate: () => (this.start(), true),
    });
    // (a race with the Players row has eight rows: they are set a little tighter so the Start button stays above the prompts)
    this.raceList.classList.toggle('dense', this.raceRows.length >= 8);
    this.lists.race.setRows(rows, 0);
  }

  private rebuildRaceRowsValues(): void {
    this.relabelWeather();
    for (const r of this.raceRows) r.refresh();
  }

  /** The Weather and Forecast rows name the weathers of the chosen circuit: snow and a blizzard where the others have rain and a storm. */
  private relabelWeather(): void {
    const winter = this.track()?.winter === true;
    for (const o of this.weatherOptions) o.label = weatherLabel(o.value, winter);
    const f = this.forecastRow;
    if (f) {
      const els = f.el.querySelectorAll('.opt');
      FORECAST_CHOICES.forEach((c, i) => {
        if (els[i]) els[i].textContent = forecastLabel(c, winter);
      });
    }
  }

  /** The Players row: a second step appears for the second player's car, and the field shrinks to what the grid has room for. */
  private setPlayerCount(n: 1 | 2): void {
    const s = this.state;
    if (s.players === n) return;
    s.players = n;
    s.opponents = Math.min(s.opponents, opponentsMax(s));
    this.syncTabs();
    this.kicker.textContent = this.kickerText();
    // one player again: the second one (in, or waited for) goes home
    if (n === 1 && this.ctx.players.joined) this.ctx.emit({ type: 'split', action: 'unbind' });
    this.rebuildRaceRowsValues();
  }

  private start(sound = false): void {
    if (sound) this.ctx.sound('select');
    if (this.champMode()) {
      this.ctx.startChampionship(buildChampionshipSetup(this.state, this.ctx.deps.cars, this.ctx.settings.playerName));
      return;
    }
    // two players: the second one has to be in before the lights go on, so the setup goes to the join step first
    if (this.splitOn() && !this.ctx.players.joined) {
      this.goStep('car2', false);
      return;
    }
    this.ctx.startRace(buildRaceConfig(this.state, this.ctx.deps.tracks, this.ctx.deps.cars, this.ctx.settings.playerName, undefined, this.ctx.settings.player2Name));
  }

  /** Rain or storm chosen: laps are kept apart from the dry ones (game.ts recordTrack), and so are the bests shown. */
  private wet(): boolean {
    return WEATHER_WATER[this.state.weather].wetness > 0;
  }

  private recordTrack(trackId: string): string {
    return this.wet() ? `${trackId}~wet` : trackId;
  }

  private renderSummary(): void {
    const champ = this.champMode();
    this.raceSummary.style.display = champ ? 'none' : '';
    this.champSummary.style.display = champ ? '' : 'none';
    this.csHelp.style.display = champ ? '' : 'none';
    if (champ) {
      this.renderChampSummary();
      return;
    }
    const t = this.track();
    const c = this.car();
    this.sumTrack.textContent = t.name;
    this.sumCar.textContent = `${c.name}  ·  ${LIVERY_PRESETS[this.state.liveryIndex].name}`;
    const two = this.splitOn();
    const [name1, name2] = this.names();
    this.sumCarK.textContent = two ? name1 : 'Car';
    this.sumCarRow.classList.toggle('s0', two);
    this.sumCar2Row.style.display = two ? '' : 'none';
    this.sumBestRow.style.display = two ? 'none' : '';
    if (two) {
      this.sumCar2K.textContent = name2;
      this.sumCar2.textContent = `${this.carOf(1).name}  ·  ${LIVERY_PRESETS[this.state.liveryIndex2].name}`;
    }
    this.sumMode.textContent = MODE_INFO[this.state.mode as RaceMode].label;
    this.sumConditions.textContent = formatConditions({ timeOfDay: this.state.timeOfDay, weather: this.state.weather }, forecastNow(this.state), t.winter);
    const best = bestLapFor(this.ctx.bestLaps, this.recordTrack(t.id), c.id);
    this.sumBest.textContent = best ? formatLapTime(best.time) + (this.wet() ? (t.winter ? '  (snow)' : '  (wet)') : '') : 'No lap yet';
    this.drawMaps();
  }

  /** The calendar with this season's lap counts, the car, the field and the points table. */
  private renderChampSummary(): void {
    const def = this.ctx.championshipDef;
    if (!def) return;
    const c = this.state.champ;
    clearEl(this.csRounds);
    this.csRounds.classList.toggle('compact', def.rounds.length > 4);
    def.rounds.forEach((r, i) => {
      const t = this.ctx.deps.tracks.find((x) => x.id === r.trackId);
      this.csRounds.appendChild(
        h('div', 'cs-round', h('span', 'n', 'R' + (i + 1)), h('div', 'cs-main', h('b', null, t?.name ?? r.trackId), h('em', null, formatConditions(r.environment, roundChange(r, r.laps[c.length]), t?.winter))), h('span', 'cs-laps t-num', lapsLabel(r.laps[c.length]))),
      );
    });
    this.csCar.textContent = `${this.car().name}  ·  ${LIVERY_PRESETS[this.state.liveryIndex].name}`;
    this.csField.textContent = `${c.opponents + 1} drivers  ·  ${OPTION_LABELS.difficulty[c.difficulty]}`;
    this.csPoints.textContent = `${def.points.join('  ')}   +${def.fastestLapPoint} fastest lap`;
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  private renderAll(): void {
    this.renderTrackDetail();
    this.renderCar();
    this.renderSummary();
    this.rebuildRaceRowsValues();
    this.kicker.textContent = this.kickerText();
    this.renderJoin();
  }

  // ── split screen: the second player joins ──────────────────────────────────

  private canSwap(): boolean {
    return this.splitOn() && this.ctx.players.joined && (this.step === 'car' || this.step === 'car2');
  }

  /**
   * The second player's car step follows what the game knows about the devices: the join card (and the game listening for a button
   * on another controller) until they are in, the car picker once they are, the card again if their device goes away.
   */
  private syncJoin(): void {
    if (!this.open) return;
    if (this.step === 'car2') {
      const key = this.viewFor('car2');
      for (const k of VIEW_KEYS) this.views[k].style.display = k === key ? '' : 'none';
      this.renderTitle('car2');
      this.kicker.textContent = this.kickerText();
      this.updatePrompts();
    }
    const wait = this.joinShown();
    if (wait && !this.joining) {
      this.joining = true;
      this.ctx.emit({ type: 'split', action: 'join' });
    } else if (!wait && this.joining) {
      this.joining = false;
      this.ctx.sound('select');
    }
  }

  /** Stop the game listening for a second player (the join card is gone without them). */
  private endJoin(): void {
    if (!this.joining) return;
    this.joining = false;
    this.ctx.emit({ type: 'split', action: 'cancel' });
  }

  /** The join card: what to press, who is on what, and how to play without a second controller. */
  private renderJoin(): void {
    const v = joinView(this.ctx.players, this.names());
    const slot = (sl: JoinView['slots'][number]): HTMLElement =>
      h('div', 'join-slot s' + sl.seat + (sl.device || sl.seat === 0 ? ' on' : ' wait'), h('span', 'js-k', sl.title), h('b', 'js-name', sl.name), h('span', 'js-dev', sl.device ?? (sl.seat === 0 ? 'Ready' : 'Waiting for a controller')));
    this.joinCard.replaceChildren(
      v.joined ? h('div', 'join-head', v.heading) : h('div', 'join-head', 'Player 2, press ', padGlyph('a'), ' to join'),
      h('div', 'join-sub', v.sub),
      h('div', 'join-slots', slot(v.slots[0]), slot(v.slots[1])),
      h('div', 'join-foot', h('span', 'join-pads', v.pads), v.keyboard ? h('span', 'join-kb', 'Or press ', keyGlyph('Enter'), ' to play on the keyboard') : null),
    );
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
    if (!this.champMode()) this.drawOne(this.sumCanvas, this.track().id, 440, 250);
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
      else if (this.step === 'race' && !this.champMode()) this.drawOne(this.sumCanvas, this.track().id, 440, 250);
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
    // Y (C on the keyboard): the two players change devices (the pad for the keyboard, or the other way round)
    if (f.cameraNext && this.canSwap()) {
      this.ctx.sound('select');
      this.ctx.emit({ type: 'split', action: 'swap' });
      return;
    }
    if (this.joinShown()) return; // the join card has nothing to move
    const list = this.lists[this.step];
    const r = list.handle(n);
    if (r === 'moved' || r === 'changed') this.ctx.sound('move');
    else if (r === 'activated') this.ctx.sound('select');
    else if (r === 'blocked') this.ctx.sound('error');
  }
}
