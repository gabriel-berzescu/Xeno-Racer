/**
 * Pure UI model (no DOM): setup wizard state -> RaceConfig, car stat scoring, livery presets, best-lap
 * lookups and the declarative settings schema the Settings screen is generated from.
 */
import type {
  CameraMode,
  CarDefinition,
  ChampionshipDef,
  ChampionshipLength,
  ChampionshipSetup,
  ChampionshipView,
  Difficulty,
  Forecast,
  GraphicsSettings,
  Livery,
  PlayerAssists,
  PlayersInfo,
  QualityLevel,
  RaceConfig,
  RaceMode,
  Seat,
  Settings,
  SplitDuel,
  SplitLayout,
  TimeOfDay,
  TrackInfo,
  Weather,
} from '../core/contracts';
import { applyAssistPreset, ASSIST_PRESETS, assistsOfSeat, matchAssistPreset, type AssistPreset } from '../core/aids';
import { forecastAllowed, sanitizeForecast } from '../core/forecast';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../core/settings';
import { opponentLimit, SEAT_COLOR } from '../core/split';
import { CAMERA_LABEL, DIFFICULTY_LABEL, FORECAST_LABEL, GRID_LABEL, LENGTH_LABEL, ordinal, pct, START_LABEL, TIME_OF_DAY_LABEL, WEATHER_LABEL } from './format';
import { clamp, clamp01 } from './hudlogic';

// ─────────────────────────────────────────────────────────────────────────────
// Enumerations
// ─────────────────────────────────────────────────────────────────────────────

export const TIMES: readonly TimeOfDay[] = ['dawn', 'morning', 'noon', 'golden', 'dusk', 'night'];
export const WEATHERS: readonly Weather[] = ['clear', 'cloudy', 'overcast', 'rain', 'storm'];
export const FORECAST_CHOICES: readonly Forecast[] = ['stable', 'rainLater', 'clearing'];
export const DIFFICULTIES: readonly Difficulty[] = ['rookie', 'amateur', 'pro', 'alien'];
export const STARTS: readonly RaceConfig['startPosition'][] = ['back', 'middle', 'pole'];
export const CAMERA_MODES: readonly CameraMode[] = ['chase', 'chase-far', 'hood', 'bumper', 'cockpit', 'tv', 'orbit'];
export const LENGTHS: readonly ChampionshipLength[] = ['short', 'standard', 'long'];
export const GRID_RULES: readonly ChampionshipSetup['grid'][] = ['standings', 'reverse'];

export const LAPS_MIN = 1;
export const LAPS_MAX = 50;
export const OPPONENTS_MAX = 11;
/** A championship needs someone to race against. */
export const CHAMP_OPPONENTS_MIN = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Car stats
// ─────────────────────────────────────────────────────────────────────────────

export interface StatBar {
  id: 'power' | 'weight' | 'grip' | 'top' | 'accel';
  label: string;
  /** 0..1 bar fill. */
  value: number;
  /** Printed value. */
  text: string;
  /** Weight is informational (a heavier car is not "better"): drawn dim instead of teal. */
  neutral?: boolean;
}

const thousands = (n: number): string => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 0..1 grip score from the tire's friction coefficient and downforce (menu stat only, not physics). */
export function gripScore(car: CarDefinition): number {
  const p = car.physics;
  const downforce = (p.aero.liftAreaFront ?? 0) + (p.aero.liftAreaRear ?? 0);
  const grip = p.tireFront.mu * (1 + 0.12 * downforce);
  return Math.sqrt(clamp01((grip - 0.85) / 1.5));
}

export function carStatBars(car: CarDefinition, units: 'kmh' | 'mph'): StatBar[] {
  const s = car.stats;
  const top = units === 'mph' ? Math.round(s.topSpeedKmh * 0.621371) + ' mph' : Math.round(s.topSpeedKmh) + ' km/h';
  return [
    { id: 'power', label: 'Power', value: clamp01(s.powerHp / 750), text: Math.round(s.powerHp) + ' hp' },
    { id: 'weight', label: 'Weight', value: clamp01(s.massKg / 1800), text: thousands(s.massKg) + ' kg', neutral: true },
    { id: 'grip', label: 'Grip', value: gripScore(car), text: '' + Math.round(gripScore(car) * 100) },
    { id: 'top', label: 'Top speed', value: clamp01((s.topSpeedKmh - 150) / 200), text: top },
    { id: 'accel', label: 'Acceleration', value: clamp01(1 - (s.zeroTo100 - 2.4) / 5.2), text: s.zeroTo100.toFixed(1) + ' s' },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Livery presets
// ─────────────────────────────────────────────────────────────────────────────

export interface LiveryPreset {
  id: string;
  name: string;
  /** Swatch colour; '' = use the car's own default primary. */
  swatch: string;
  /** Overrides; null = the car's factory livery. */
  livery: Partial<Livery> | null;
}

export const LIVERY_PRESETS: readonly LiveryPreset[] = [
  { id: 'factory', name: 'Factory', swatch: '', livery: null },
  { id: 'teal', name: 'Xeno Teal', swatch: '#16e0bd', livery: { primary: '#16e0bd', secondary: '#0b0c10', accent: '#ff2e63', pattern: 'stripes', metallic: true, finish: 0 } },
  { id: 'pink', name: 'Hot Pink', swatch: '#ff2e63', livery: { primary: '#ff2e63', secondary: '#0b0c10', accent: '#eef0f3', pattern: 'split', metallic: false, finish: 0 } },
  { id: 'pearl', name: 'Pearl White', swatch: '#eef0f3', livery: { primary: '#eef0f3', secondary: '#16e0bd', accent: '#0b0c10', pattern: 'arrow', metallic: true, finish: 0 } },
  { id: 'midnight', name: 'Midnight', swatch: '#14161d', livery: { primary: '#14161d', secondary: '#2a2f3a', accent: '#16e0bd', pattern: 'shards', metallic: true, finish: 0.5 } },
  { id: 'yellow', name: 'Signal Yellow', swatch: '#ffcc00', livery: { primary: '#ffcc00', secondary: '#101216', accent: '#ffffff', pattern: 'hoops', metallic: false, finish: 0 } },
  { id: 'papaya', name: 'Papaya', swatch: '#ff7a1a', livery: { primary: '#ff7a1a', secondary: '#101216', accent: '#eef0f3', pattern: 'stripes', metallic: false, finish: 0 } },
  { id: 'blue', name: 'Racing Blue', swatch: '#1f4fff', livery: { primary: '#1f4fff', secondary: '#eef0f3', accent: '#ff2e63', pattern: 'stripes', metallic: true, finish: 0 } },
  { id: 'green', name: 'Heritage Green', swatch: '#0f6b3e', livery: { primary: '#0f6b3e', secondary: '#d8c27a', accent: '#eef0f3', pattern: 'solid', metallic: true, finish: 0 } },
  { id: 'red', name: 'Rosso', swatch: '#d4122b', livery: { primary: '#d4122b', secondary: '#eef0f3', accent: '#101216', pattern: 'split', metallic: false, finish: 0 } },
  { id: 'silver', name: 'Silver', swatch: '#b9c0cc', livery: { primary: '#b9c0cc', secondary: '#2a2f3a', accent: '#ff2e63', pattern: 'solid', metallic: true, finish: 0 } },
  { id: 'matte', name: 'Matte Grey', swatch: '#6b7280', livery: { primary: '#6b7280', secondary: '#16e0bd', accent: '#eef0f3', pattern: 'shards', metallic: false, finish: 1 } },
];

/** The partial livery to send for a preset (always carries the driver name for the standings). */
export function liveryFor(preset: LiveryPreset, playerName: string): Partial<Livery> {
  return { ...(preset.livery ?? {}), driver: playerName || 'You' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Best laps
// ─────────────────────────────────────────────────────────────────────────────

export const bestKey = (trackId: string, carId: string): string => `${trackId}/${carId}`;

/** Best lap on a track: for one car, or (carId omitted) the best across every car. */
export function bestLapFor(best: Record<string, number>, trackId: string, carId?: string): { time: number; carId: string } | null {
  if (carId !== undefined) {
    const t = best[bestKey(trackId, carId)];
    return t !== undefined && Number.isFinite(t) ? { time: t, carId } : null;
  }
  let out: { time: number; carId: string } | null = null;
  const prefix = trackId + '/';
  for (const k of Object.keys(best)) {
    if (!k.startsWith(prefix)) continue;
    const t = best[k];
    if (Number.isFinite(t) && (out === null || t < out.time)) out = { time: t, carId: k.slice(prefix.length) };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup wizard
// ─────────────────────────────────────────────────────────────────────────────

export type SetupStep = 'track' | 'car' | 'race';
export const SETUP_STEPS: readonly SetupStep[] = ['track', 'car', 'race'];
/** A split-screen setup has a fourth step, the second player's car (behind the join): the wizard's steps are these. */
export type WizardStep = SetupStep | 'car2';
export const SPLIT_SETUP_STEPS: readonly WizardStep[] = ['track', 'car', 'car2', 'race'];

/** The setup wizard serves the three race modes and the championship. */
export type SetupMode = RaceMode | 'championship';

/** How a screen opens the setup: with how many humans (the Split screen entry of the main menu opens it with two). */
export interface SetupOpts {
  players?: 1 | 2;
}

/** The championship's own options (kept apart from the Race ones so each remembers its last choice). */
export interface ChampSetupState {
  opponents: number;
  difficulty: Difficulty;
  length: ChampionshipLength;
  startPosition: RaceConfig['startPosition'];
  grid: ChampionshipSetup['grid'];
}

export const CHAMP_DEFAULTS: ChampSetupState = { opponents: 7, difficulty: 'amateur', length: 'standard', startPosition: 'back', grid: 'standings' };

export interface SetupState {
  mode: SetupMode;
  trackIndex: number;
  carIndex: number;
  liveryIndex: number;
  laps: number;
  opponents: number;
  difficulty: Difficulty;
  timeOfDay: TimeOfDay;
  weather: Weather;
  /** How the weather moves during the race. It only counts where it makes sense (see forecastNow). */
  forecast: Forecast;
  startPosition: RaceConfig['startPosition'];
  champ: ChampSetupState;
  /** Split screen: one human or two (only a race and free roam can have two: see `splitAllowed`). */
  players: 1 | 2;
  /** The second player's car and livery (they only count with two players). */
  car2Index: number;
  liveryIndex2: number;
}

export interface ModeInfo {
  label: string;
  blurb: string;
  usesLaps: boolean;
  usesOpponents: boolean;
  usesDifficulty: boolean;
  usesStart: boolean;
}

export const MODE_INFO: Record<RaceMode, ModeInfo> = {
  race: { label: 'Race', blurb: 'A full grid, a set number of laps, and a podium to fight for.', usesLaps: true, usesOpponents: true, usesDifficulty: true, usesStart: true },
  timeTrial: { label: 'Time Trial', blurb: 'You against the clock. Chase your own best lap and race your ghost.', usesLaps: false, usesOpponents: false, usesDifficulty: false, usesStart: false },
  freeRoam: { label: 'Free Roam', blurb: 'No laps, no pressure: the circuit to yourself. Learn it and tune your driving.', usesLaps: false, usesOpponents: false, usesDifficulty: false, usesStart: false },
};

export const CHAMPIONSHIP_INFO = {
  label: 'Championship',
  blurb: 'A season of races across the circuits, in changing light and weather. Score points in every round and take the cup.',
};

/** "Race", "Time Trial", "Free Roam", "Championship". */
export const modeLabel = (mode: SetupMode): string => (mode === 'championship' ? CHAMPIONSHIP_INFO.label : MODE_INFO[mode].label);

// ─────────────────────────────────────────────────────────────────────────────
// Split screen
// ─────────────────────────────────────────────────────────────────────────────

/** The line under the Split screen entry of the main menu. */
export const SPLIT_BLURB = 'Two players, one screen: race a friend on two controllers.';

/** A second human can drive in a race and in free roam; a time trial and a championship are for one. */
export const splitAllowed = (mode: SetupMode): boolean => mode === 'race' || mode === 'freeRoam';

/** The humans this setup will really run with: two only where it is allowed. */
export const playersNow = (s: Pick<SetupState, 'mode' | 'players'>): 1 | 2 => (splitAllowed(s.mode) && s.players === 2 ? 2 : 1);

/** The steps of the wizard for this setup: two players add the second player's car after the first's. */
export const setupSteps = (s: Pick<SetupState, 'mode' | 'players'>): readonly WizardStep[] => (playersNow(s) === 2 ? SPLIT_SETUP_STEPS : SETUP_STEPS);

/** The most opponents the setup can have beside its humans (11 beside one, 10 beside two). */
export const opponentsMax = (s: Pick<SetupState, 'mode' | 'players'>): number => opponentLimit(playersNow(s));

/** The name of a seat's driver: the settings' own, never empty. */
export const seatName = (settings: Pick<Settings, 'playerName' | 'player2Name'>, seat: Seat): string =>
  (seat === 0 ? settings.playerName.trim() || 'You' : settings.player2Name.trim() || 'Player 2');

/** The tab text of a step of a race or free roam: "Car" for one player, "P1 car" and "P2 car" for two. */
export function setupStepLabel(step: WizardStep, players: 1 | 2): string {
  switch (step) {
    case 'track': return 'Track';
    case 'car': return players === 2 ? 'P1 car' : 'Car';
    case 'car2': return 'P2 car';
    default: return 'Race';
  }
}

/** Which seat's car a step picks: the second player's on the 'car2' step, the first's on any other. */
export const stepSeat = (step: WizardStep): Seat => (step === 'car2' ? 1 : 0);

/**
 * A livery that stands apart from the first player's, for the second player's default: the grid looks better with two different
 * cars, and a pink one beside a factory-painted one is easy to tell from the tower and the minimap.
 */
export function contrastLivery(first: number): number {
  const pink = LIVERY_PRESETS.findIndex((p) => p.id === 'pink');
  const teal = LIVERY_PRESETS.findIndex((p) => p.id === 'teal');
  return first === pink ? teal : pink;
}

// ── the join step ──

export interface JoinSlot {
  seat: Seat;
  /** "Player 1" / "Player 2". */
  title: string;
  /** The driver's name. */
  name: string;
  /** What they play on ("Logitech Gamepad F310", "Keyboard"); null while nobody is there. */
  device: string | null;
  color: string;
}

/** What the join card of the setup says, from what the game knows about the devices (`PlayersInfo`). */
export interface JoinView {
  slots: readonly [JoinSlot, JoinSlot];
  /** The second player is in (their device is bound). */
  joined: boolean;
  /** The big line: "Player 2, press A to join" while waiting, "Silviu is in" after. */
  heading: string;
  /** Under it: where to press ("on a second controller"), or what they play on once in. */
  sub: string;
  /** The way in that needs no second controller ("Or press Enter to play on the keyboard"), while it is one; else null. */
  keyboard: string | null;
  /** "1 controller connected". */
  pads: string;
  /** Both players are known, so the swap button has something to swap. */
  canSwap: boolean;
}

const isKeyboard = (device: string | null): boolean => device !== null && device.toLowerCase().includes('keyboard');

export function joinView(info: PlayersInfo, names: readonly [string, string]): JoinView {
  const [d1, d2] = info.devices;
  const joined = info.joined && d2 !== null;
  const slot = (seat: Seat, device: string | null): JoinSlot => ({ seat, title: 'Player ' + (seat + 1), name: names[seat], device, color: SEAT_COLOR[seat] });
  const firstOnKeyboard = isKeyboard(d1);
  let sub: string;
  if (joined) sub = 'on ' + d2;
  else if (firstOnKeyboard) sub = info.pads > 0 ? 'on a controller' : 'on a controller, once it is plugged in';
  else sub = info.pads > 1 ? 'on the controller for player 2' : 'on a second controller';
  const n = info.pads;
  return {
    slots: [slot(0, d1), slot(1, joined ? d2 : null)],
    joined,
    heading: joined ? names[1] + ' is in' : 'Player 2, press A to join',
    sub,
    keyboard: !joined && !firstOnKeyboard ? 'Or press Enter to play on the keyboard' : null,
    pads: n === 0 ? 'No controller connected' : n + (n === 1 ? ' controller' : ' controllers') + ' connected',
    canSwap: joined && d1 !== null,
  };
}

// ── the head-to-head of a split-screen race ──

export type DuelMargin = { kind: 'time'; seconds: number } | { kind: 'laps'; laps: number } | { kind: 'none' };

/** The gap a duel carries ("+3.241", "+1 LAP", "+2 LAPS", "+1L", or "" for no time) as a number of seconds or laps. */
export function parseDuelGap(gap: string): DuelMargin {
  const t = gap.trim();
  const laps = /^\+?(\d+)\s*L(AP)?S?$/i.exec(t);
  if (laps) return { kind: 'laps', laps: +laps[1] };
  const sec = /^\+?(\d+(?:\.\d+)?)$/.exec(t);
  return sec ? { kind: 'time', seconds: +sec[1] } : { kind: 'none' };
}

/** "by 3.241 s", "by 1 lap", or "" when the other player has no time to be behind by. */
export function duelMargin(d: SplitDuel): string {
  const m = parseDuelGap(d.gap);
  if (m.kind === 'time') return 'by ' + m.seconds.toFixed(3) + ' s';
  if (m.kind === 'laps') return 'by ' + m.laps + (m.laps === 1 ? ' lap' : ' laps');
  return '';
}

/** The headline of the results of a split-screen race. */
export function duelTitle(d: SplitDuel): string {
  if (d.winner !== null) return d.names[d.winner] + ' wins';
  return d.gap.trim() === '' ? 'No winner' : 'Dead heat';
}

/** One line on how it went: "Gabriel beat Silviu by 3.241 s", "Silviu did not finish", "Dead heat". */
export function duelSummary(d: SplitDuel): string {
  if (d.winner === null) return d.gap.trim() === '' ? 'Neither player finished' : 'Dead heat';
  const win = d.names[d.winner];
  const lose = d.names[d.winner === 0 ? 1 : 0];
  const margin = duelMargin(d);
  return margin ? win + ' beat ' + lose + ' ' + margin : lose + ' did not finish';
}

export interface LapRow {
  /** 1-based lap number. */
  lap: number;
  time: number;
  best: boolean;
  /** "PB" or "BEST" on the best lap, else the gap to it ("+0.482"). */
  tag: string;
}

/** The last `max` laps of a list, for a column of the results: the best one tagged, the rest as a gap to it. `hidden` counts the earlier laps left out. */
export function lapRows(times: readonly number[], personalBest: boolean, max: number): { rows: LapRow[]; hidden: number } {
  if (times.length === 0) return { rows: [], hidden: 0 };
  let best = Infinity;
  for (const t of times) if (t < best) best = t;
  const hidden = Math.max(0, times.length - max);
  const rows: LapRow[] = [];
  for (let i = hidden; i < times.length; i++) {
    const t = times[i];
    const isBest = t === best;
    rows.push({ lap: i + 1, time: t, best: isBest, tag: isBest ? (personalBest ? 'PB' : 'BEST') : '+' + (t - best).toFixed(3) });
  }
  return { rows, hidden };
}

// ── the pause menu of a split-screen race ──

/** The apostrophe form of a name: "Silviu's", "James'". */
export const possessive = (name: string): string => (/s$/i.test(name) ? name + "'" : name + "'s");

/** "Paused by Silviu" while the pause menu follows one player's pad; null while it is anyone's. */
export function pauseOwnerLine(info: PlayersInfo, names: readonly [string, string]): string | null {
  return info.owner === null ? null : 'Paused by ' + names[info.owner];
}

/** Whose controller came out, and what to do about it; null while both are in. */
export function missingPadLine(info: PlayersInfo, names: readonly [string, string]): string | null {
  return info.missing === null ? null : possessive(names[info.missing]) + ' controller was disconnected. Plug it in and press A.';
}

export function defaultSetup(mode: SetupMode, tracks: readonly TrackInfo[], cars: readonly CarDefinition[], prev?: Partial<SetupState>): SetupState {
  const trackIndex = clamp(prev?.trackIndex ?? 0, 0, Math.max(0, tracks.length - 1));
  const track = tracks[trackIndex];
  // visiting the championship setup must not wipe what the Race setup remembers
  const racing = mode === 'race' || mode === 'championship';
  const carIndex = clamp(prev?.carIndex ?? 0, 0, Math.max(0, cars.length - 1));
  const liveryIndex = prev?.liveryIndex ?? 0;
  const players: 1 | 2 = splitAllowed(mode) && prev?.players === 2 ? 2 : 1;
  return {
    mode,
    trackIndex,
    carIndex,
    liveryIndex,
    laps: prev?.laps ?? track?.defaultLaps ?? 3,
    // (what a one-player setup left behind may be more than a grid of two humans has room for)
    opponents: racing ? clamp(prev?.opponents ?? 7, 0, opponentLimit(players)) : 0,
    difficulty: prev?.difficulty ?? 'amateur',
    timeOfDay: prev?.timeOfDay ?? track?.defaultTimeOfDay ?? 'golden',
    weather: prev?.weather ?? 'clear',
    forecast: prev?.forecast ?? 'stable',
    startPosition: racing ? prev?.startPosition ?? 'back' : 'pole',
    champ: { ...CHAMP_DEFAULTS, ...prev?.champ },
    players,
    // (the second player drives the next car along, in a livery that contrasts with the first player's, until they pick their own)
    car2Index: prev?.car2Index !== undefined ? clamp(prev.car2Index, 0, Math.max(0, cars.length - 1)) : (carIndex + 1) % Math.max(1, cars.length),
    liveryIndex2: prev?.liveryIndex2 ?? contrastLivery(liveryIndex),
  };
}

/** When the player picks another track, laps and time of day follow that track's defaults. */
export function applyTrackDefaults(s: SetupState, track: TrackInfo): void {
  s.laps = clamp(track.defaultLaps, LAPS_MIN, LAPS_MAX);
  s.timeOfDay = track.defaultTimeOfDay;
}

/**
 * The forecast the setup will really run: what is chosen when it makes sense for the weather, mode and laps (rain later from a dry
 * weather, clearing from a wet one, not in a time trial, not in a race of one lap), else stable.
 */
export function forecastNow(s: SetupState): Forecast {
  const mode: RaceMode = s.mode === 'championship' ? 'race' : s.mode;
  const laps = MODE_INFO[mode].usesLaps ? clamp(Math.round(s.laps), LAPS_MIN, LAPS_MAX) : 0;
  return s.mode === 'championship' ? 'stable' : sanitizeForecast(s.forecast, s.weather, mode, laps);
}

/** Is `forecast` one the Forecast row can offer for this setup? */
export function forecastOffered(s: SetupState, forecast: Forecast): boolean {
  const mode: RaceMode = s.mode === 'championship' ? 'race' : s.mode;
  const laps = MODE_INFO[mode].usesLaps ? clamp(Math.round(s.laps), LAPS_MIN, LAPS_MAX) : 0;
  return s.mode !== 'championship' && forecastAllowed(forecast, s.weather, mode, laps);
}

/** A seed for a race's forecast (it fixes when the weather changes and how hard, so a restart repeats it). */
export const newForecastSeed = (): number => Math.floor(Math.random() * 2147483646) + 1;

/**
 * The race the setup describes. With two players (a race or free roam, `players` 2) the config carries the second player's car and
 * name (`player2Name`, "Player 2" when blank) and the opponents are limited to what the grid has room for beside both (10).
 */
export function buildRaceConfig(s: SetupState, tracks: readonly TrackInfo[], cars: readonly CarDefinition[], playerName: string, forecastSeed: number = newForecastSeed(), player2Name = ''): RaceConfig {
  const track = tracks[clamp(s.trackIndex, 0, tracks.length - 1)];
  const car = cars[clamp(s.carIndex, 0, cars.length - 1)];
  const mode: RaceMode = s.mode === 'championship' ? 'race' : s.mode;
  const info = MODE_INFO[mode];
  const preset = LIVERY_PRESETS[clamp(s.liveryIndex, 0, LIVERY_PRESETS.length - 1)];
  const forecast = forecastNow(s);
  const two = playersNow(s) === 2;
  const car2 = cars[clamp(s.car2Index, 0, cars.length - 1)];
  const preset2 = LIVERY_PRESETS[clamp(s.liveryIndex2, 0, LIVERY_PRESETS.length - 1)];
  return {
    mode,
    trackId: track.id,
    carId: car.id,
    livery: liveryFor(preset, playerName),
    laps: info.usesLaps ? clamp(Math.round(s.laps), LAPS_MIN, LAPS_MAX) : 0,
    opponents: info.usesOpponents ? clamp(Math.round(s.opponents), 0, opponentsMax(s)) : 0,
    difficulty: info.usesDifficulty ? s.difficulty : 'amateur',
    environment: { timeOfDay: s.timeOfDay, weather: s.weather },
    startPosition: info.usesStart ? s.startPosition : 'pole',
    ...(two ? { player2: { carId: car2.id, livery: liveryFor(preset2, player2Name.trim() || 'Player 2') } } : {}),
    ...(forecast !== 'stable' ? { forecast, forecastSeed } : {}),
  };
}

/** What the setup wizard sends to start a championship. */
export function buildChampionshipSetup(s: SetupState, cars: readonly CarDefinition[], playerName: string): ChampionshipSetup {
  const car = cars[clamp(s.carIndex, 0, cars.length - 1)];
  const preset = LIVERY_PRESETS[clamp(s.liveryIndex, 0, LIVERY_PRESETS.length - 1)];
  const c = s.champ;
  return {
    carId: car.id,
    livery: liveryFor(preset, playerName),
    difficulty: c.difficulty,
    opponents: clamp(Math.round(c.opponents), CHAMP_OPPONENTS_MIN, OPPONENTS_MAX),
    length: c.length,
    startPosition: c.startPosition,
    grid: c.grid,
  };
}

/** The line under the Championship entry of the main menu. */
export function championshipHint(def: ChampionshipDef | null | undefined, view: ChampionshipView | null | undefined): string {
  if (!view) {
    const n = def?.rounds.length ?? 0;
    const circuits = new Set(def?.rounds.map((r) => r.trackId)).size;
    const name = def?.name ?? 'cup';
    return n > 0
      ? `${n} rounds across ${circuits} ${circuits === 1 ? 'circuit' : 'circuits'}, in changing light and weather. Score points in every race and take the ${name}.`
      : CHAMPIONSHIP_INFO.blurb;
  }
  const me = view.player;
  const pts = `${me.points} ${me.points === 1 ? 'point' : 'points'}`;
  if (view.complete) return me.position === 1 ? `${view.name} won with ${pts}. See the final standings.` : `${view.name} finished: ${ordinal(me.position)} with ${pts}. See the final standings.`;
  if (view.done === 0) return `${view.name}: round 1 of ${view.rounds.length} is next. Nobody has scored yet.`;
  return `${view.name}, round ${view.done + 1} of ${view.rounds.length}. ${ordinal(me.position)} with ${pts}. Pick up where you left off.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings schema
// ─────────────────────────────────────────────────────────────────────────────

interface RowBase {
  id: string;
  label: string;
  /** One line, shown under the row (Assists) or in the help pane. */
  desc: string;
}
export interface SliderDef extends RowBase {
  kind: 'slider';
  min: number;
  max: number;
  step: number;
  get(s: Settings): number;
  set(s: Settings, v: number): void;
  fmt(v: number): string;
}
export interface ToggleDef extends RowBase {
  kind: 'toggle';
  get(s: Settings): boolean;
  set(s: Settings, v: boolean): void;
}
export interface SelectDef extends RowBase {
  kind: 'select';
  options: { value: string; label: string }[];
  get(s: Settings): string;
  set(s: Settings, v: string): void;
  /** Label override (e.g. "Custom" when the graphics no longer match a preset). */
  display?(s: Settings): string;
  wrap?: boolean;
}
export interface TextDef extends RowBase {
  kind: 'text';
  maxLength: number;
  get(s: Settings): string;
  set(s: Settings, v: string): void;
}
export type RowDef = SliderDef | ToggleDef | SelectDef | TextDef;

export type SettingsTabId = 'graphics' | 'audio' | 'controls' | 'assists' | 'assists2' | 'gameplay';
export interface TabDef {
  id: SettingsTabId;
  label: string;
  /** Show every row's description permanently under its label. */
  showDesc: boolean;
  rows: RowDef[];
  reset(s: Settings): void;
  /** The tab is there only while a second player matters (see secondPlayerMatters). */
  split?: boolean;
}

/**
 * Does a second human matter to the settings right now? They do while a split-screen race is on or a second player has joined, and
 * while two controllers are plugged in (somebody is waiting for a turn): then the Assists have a tab for player 2, who may drive
 * with other aids than player 1 (a manual gearbox and no help for one, everything on for a child).
 */
export function secondPlayerMatters(players: PlayersInfo, split: SplitLayout | null): boolean {
  return players.joined || players.pads >= 2 || split !== null;
}

const opts = (pairs: [string, string][]): { value: string; label: string }[] => pairs.map(([value, label]) => ({ value, label }));

/** Which quality level the graphics settings currently match, or 'custom'. maxFps is a separate preference. */
export function matchQuality(g: GraphicsSettings): QualityLevel | 'custom' {
  const eq = (p: GraphicsSettings): boolean =>
    p.renderScale === g.renderScale && p.shadows === g.shadows && p.ambientOcclusion === g.ambientOcclusion &&
    p.bloom === g.bloom && p.motionBlur === g.motionBlur && p.antialias === g.antialias && p.vegetation === g.vegetation;
  if (QUALITY_PRESETS[g.quality] && eq(QUALITY_PRESETS[g.quality])) return g.quality;
  for (const q of ['low', 'medium', 'high', 'ultra'] as QualityLevel[]) if (eq(QUALITY_PRESETS[q])) return q;
  return 'custom';
}

const FPS_OPTIONS = [0, 30, 60, 75, 90, 120, 144, 165, 240];

/** The preset words of the Assists tabs. */
const PRESET_LABEL: Record<AssistPreset | 'custom', string> = { pro: 'Pro', standard: 'Standard', beginner: 'Beginner', custom: 'Custom' };

/** The rows of the Assists tab of one human: player 1's `assists` or player 2's `assists2`. */
function assistRows(seat: Seat): RowDef[] {
  const A = (s: Settings): PlayerAssists => assistsOfSeat(s, seat);
  return [
    {
      kind: 'select', id: 'preset', label: 'Preset',
      desc: 'All the aids at once: Pro has none and a manual gearbox, Standard is the default, Beginner has everything on.',
      options: (Object.keys(ASSIST_PRESETS) as AssistPreset[]).map((p) => ({ value: p, label: PRESET_LABEL[p] })),
      get: (s) => matchAssistPreset(A(s)),
      display: (s) => PRESET_LABEL[matchAssistPreset(A(s))],
      set: (s, v) => { applyAssistPreset(A(s), v as AssistPreset); },
    },
    { kind: 'toggle', id: 'abs', label: 'ABS', desc: 'Stops the wheels locking under hard braking so you can still steer.', get: (s) => A(s).abs, set: (s, v) => { A(s).abs = v; } },
    {
      kind: 'select', id: 'tcs', label: 'Traction control', desc: 'Cuts power when the driven wheels spin. High keeps the car tidy; Off lets it light the tires.',
      options: opts([['off', 'Off'], ['low', 'Low'], ['high', 'High']]),
      get: (s) => A(s).tcs, set: (s, v) => { A(s).tcs = v as PlayerAssists['tcs']; },
    },
    { kind: 'toggle', id: 'esc', label: 'Stability control', desc: 'Brakes individual wheels to stop a spin before it starts.', get: (s) => A(s).esc, set: (s, v) => { A(s).esc = v; } },
    { kind: 'toggle', id: 'autoShift', label: 'Automatic gearbox', desc: 'Shifts for you. Turn it off to use RB / LB (or B / X) as paddles.', get: (s) => A(s).autoShift, set: (s, v) => { A(s).autoShift = v; } },
    {
      kind: 'slider', id: 'steeringAssist', label: 'Steering assist', min: 0, max: 1, step: 0.05,
      desc: 'Catches slides with automatic counter-steer and limits lock to what the tires can use.',
      get: (s) => A(s).steeringAssist, set: (s, v) => { A(s).steeringAssist = v; }, fmt: pct,
    },
    { kind: 'toggle', id: 'autoClutch', label: 'Automatic clutch', desc: 'Handles the clutch for launches and gear changes. Nearly everyone on a gamepad wants this on.', get: (s) => A(s).autoClutch, set: (s, v) => { A(s).autoClutch = v; } },
    {
      kind: 'select', id: 'line', label: 'Driving line',
      desc: 'Green to keep going, amber to lift or brake soon, red to brake now. Braking zones shows it only where you slow down.',
      options: opts([['off', 'Off'], ['braking', 'Braking zones'], ['full', 'Full']]),
      get: (s) => A(s).line, set: (s, v) => { A(s).line = v as PlayerAssists['line']; },
    },
    {
      kind: 'toggle', id: 'brakeAssist', label: 'Braking assist',
      desc: 'Brakes for you when you come into a corner too fast, and lifts the throttle. You still steer, and can always brake harder.',
      get: (s) => A(s).brakeAssist, set: (s, v) => { A(s).brakeAssist = v; },
    },
  ];
}

export const SETTINGS_TABS: TabDef[] = [
  {
    id: 'graphics',
    label: 'Graphics',
    showDesc: false,
    reset: (s) => { s.graphics = structuredClone(DEFAULT_SETTINGS.graphics); },
    rows: [
      {
        kind: 'select', id: 'quality', label: 'Quality preset',
        desc: 'Sets everything below in one go. Choose Low on integrated graphics; Custom appears when you change an option yourself.',
        options: opts([['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']]),
        get: (s) => s.graphics.quality,
        display: (s) => { const m = matchQuality(s.graphics); return m === 'custom' ? 'Custom' : m[0].toUpperCase() + m.slice(1); },
        set: (s, v) => { const q = v as QualityLevel; s.graphics = { ...QUALITY_PRESETS[q], maxFps: s.graphics.maxFps }; },
      },
      {
        kind: 'slider', id: 'renderScale', label: 'Render scale', min: 0.5, max: 1.5, step: 0.05,
        desc: 'Internal resolution as a share of your screen. Lower it for speed, raise it for a sharper picture.',
        get: (s) => s.graphics.renderScale, set: (s, v) => { s.graphics.renderScale = v; }, fmt: pct,
      },
      {
        kind: 'select', id: 'shadows', label: 'Shadows', desc: 'Sun shadow quality. High adds soft, long golden-hour shadows.',
        options: opts([['off', 'Off'], ['low', 'Low'], ['high', 'High']]),
        get: (s) => s.graphics.shadows, set: (s, v) => { s.graphics.shadows = v as GraphicsSettings['shadows']; },
      },
      {
        kind: 'toggle', id: 'ambientOcclusion', label: 'Ambient occlusion', desc: 'Darkens creases and contact points for depth. Costs GPU time.',
        get: (s) => s.graphics.ambientOcclusion, set: (s, v) => { s.graphics.ambientOcclusion = v; },
      },
      {
        kind: 'toggle', id: 'bloom', label: 'Bloom', desc: 'The soft glow around the sun, brake discs and lights.',
        get: (s) => s.graphics.bloom, set: (s, v) => { s.graphics.bloom = v; },
      },
      {
        kind: 'toggle', id: 'motionBlur', label: 'Motion blur', desc: 'Streaks the scene at speed for a sense of velocity.',
        get: (s) => s.graphics.motionBlur, set: (s, v) => { s.graphics.motionBlur = v; },
      },
      {
        kind: 'select', id: 'antialias', label: 'Anti-aliasing', desc: 'Smooths jagged edges. SMAA is sharper than FXAA and a little heavier.',
        options: opts([['off', 'Off'], ['fxaa', 'FXAA'], ['smaa', 'SMAA']]),
        get: (s) => s.graphics.antialias, set: (s, v) => { s.graphics.antialias = v as GraphicsSettings['antialias']; },
      },
      {
        kind: 'slider', id: 'vegetation', label: 'Vegetation density', min: 0, max: 1, step: 0.05,
        desc: 'How many trees, bushes and grass tufts line the circuit. Takes effect when the next race starts or restarts.',
        get: (s) => s.graphics.vegetation, set: (s, v) => { s.graphics.vegetation = v; }, fmt: pct,
      },
      {
        kind: 'select', id: 'maxFps', label: 'Frame rate cap', desc: 'Caps the frame rate. Uncapped follows your display (V-sync).',
        options: FPS_OPTIONS.map((f) => ({ value: '' + f, label: f === 0 ? 'Uncapped' : f + ' fps' })),
        get: (s) => '' + s.graphics.maxFps, set: (s, v) => { s.graphics.maxFps = Number(v); },
      },
    ],
  },
  {
    id: 'audio',
    label: 'Audio',
    showDesc: false,
    reset: (s) => { s.audio = structuredClone(DEFAULT_SETTINGS.audio); },
    rows: [
      { kind: 'slider', id: 'master', label: 'Master volume', min: 0, max: 1, step: 0.05, desc: 'Everything at once.', get: (s) => s.audio.master, set: (s, v) => { s.audio.master = v; }, fmt: pct },
      { kind: 'slider', id: 'engine', label: 'Engine', min: 0, max: 1, step: 0.05, desc: 'Your engine and the cars around you.', get: (s) => s.audio.engine, set: (s, v) => { s.audio.engine = v; }, fmt: pct },
      { kind: 'slider', id: 'effects', label: 'Effects', min: 0, max: 1, step: 0.05, desc: 'Tires, wind, impacts and the crowd.', get: (s) => s.audio.effects, set: (s, v) => { s.audio.effects = v; }, fmt: pct },
      { kind: 'slider', id: 'music', label: 'Music', min: 0, max: 1, step: 0.05, desc: 'Menu and results music.', get: (s) => s.audio.music, set: (s, v) => { s.audio.music = v; }, fmt: pct },
      { kind: 'slider', id: 'ui', label: 'Interface', min: 0, max: 1, step: 0.05, desc: 'Menu clicks and race beeps.', get: (s) => s.audio.ui, set: (s, v) => { s.audio.ui = v; }, fmt: pct },
    ],
  },
  {
    id: 'controls',
    label: 'Controls',
    showDesc: false,
    reset: (s) => { s.controls = structuredClone(DEFAULT_SETTINGS.controls); },
    rows: [
      {
        kind: 'slider', id: 'steerDeadzone', label: 'Steering dead zone', min: 0, max: 0.3, step: 0.01,
        desc: 'Ignores tiny stick movements around the center. Raise it if the car drifts on its own.',
        get: (s) => s.controls.steerDeadzone, set: (s, v) => { s.controls.steerDeadzone = v; }, fmt: pct,
      },
      {
        kind: 'slider', id: 'steerLinearity', label: 'Steering linearity', min: 1, max: 3, step: 0.1,
        desc: '1.0 is a straight response. Higher values give finer control near the center and full lock at the edge.',
        get: (s) => s.controls.steerLinearity, set: (s, v) => { s.controls.steerLinearity = v; }, fmt: (v) => v.toFixed(1),
      },
      {
        kind: 'slider', id: 'pedalDeadzone', label: 'Trigger dead zone', min: 0, max: 0.2, step: 0.01,
        desc: 'How far the triggers travel before throttle or brake begins.',
        get: (s) => s.controls.pedalDeadzone, set: (s, v) => { s.controls.pedalDeadzone = v; }, fmt: pct,
      },
      {
        kind: 'slider', id: 'speedSensitivity', label: 'Speed sensitivity', min: 0, max: 1, step: 0.05,
        desc: 'Reduces steering lock as speed rises, so the car stays calm on the straights.',
        get: (s) => s.controls.speedSensitivity, set: (s, v) => { s.controls.speedSensitivity = v; }, fmt: pct,
      },
      {
        kind: 'slider', id: 'steerSpeed', label: 'Steering speed', min: 0.5, max: 2, step: 0.1,
        desc: 'How quickly the virtual steering wheel follows the stick.',
        get: (s) => s.controls.steerSpeed, set: (s, v) => { s.controls.steerSpeed = v; }, fmt: (v) => v.toFixed(1) + 'x',
      },
      {
        kind: 'toggle', id: 'vibration', label: 'Vibration', desc: 'Controller rumble on impacts and curbs. (The Logitech F310 has no motors.)',
        get: (s) => s.controls.vibration, set: (s, v) => { s.controls.vibration = v; },
      },
      {
        kind: 'toggle', id: 'invertLookY', label: 'Invert look Y', desc: 'Right stick up looks down.',
        get: (s) => s.controls.invertLookY, set: (s, v) => { s.controls.invertLookY = v; },
      },
    ],
  },
  {
    id: 'assists',
    label: 'Assists',
    showDesc: true,
    reset: (s) => { s.assists = structuredClone(DEFAULT_SETTINGS.assists); },
    rows: assistRows(0),
  },
  {
    id: 'assists2',
    label: 'Assists P2',
    showDesc: true,
    split: true,
    reset: (s) => { s.assists2 = structuredClone(DEFAULT_SETTINGS.assists2); },
    rows: assistRows(1),
  },
  {
    id: 'gameplay',
    label: 'Gameplay',
    showDesc: false,
    reset: (s) => {
      s.units = DEFAULT_SETTINGS.units;
      s.hud = structuredClone(DEFAULT_SETTINGS.hud);
      s.camera = structuredClone(DEFAULT_SETTINGS.camera);
      s.damage = DEFAULT_SETTINGS.damage;
      s.playerName = DEFAULT_SETTINGS.playerName;
      s.player2Name = DEFAULT_SETTINGS.player2Name;
      s.split = structuredClone(DEFAULT_SETTINGS.split);
    },
    rows: [
      {
        kind: 'select', id: 'units', label: 'Units', desc: 'Speed and distance in kilometers or miles.',
        options: opts([['kmh', 'km/h'], ['mph', 'mph']]),
        get: (s) => s.units, set: (s, v) => { s.units = v as Settings['units']; },
      },
      { kind: 'toggle', id: 'minimap', label: 'Minimap', desc: 'The track map with every car on it.', get: (s) => s.hud.minimap, set: (s, v) => { s.hud.minimap = v; } },
      { kind: 'toggle', id: 'standings', label: 'Standings tower', desc: 'The live order and gaps in the top-left corner.', get: (s) => s.hud.standings, set: (s, v) => { s.hud.standings = v; } },
      { kind: 'toggle', id: 'telemetry', label: 'Telemetry overlay', desc: 'Tire temperatures, load, g-meter and live pedal traces. Toggle in-race with D-pad down or T.', get: (s) => s.hud.telemetry, set: (s, v) => { s.hud.telemetry = v; } },
      { kind: 'toggle', id: 'ghost', label: 'Ghost car', desc: 'Shows your best lap as a see-through car to race against.', get: (s) => s.hud.ghost, set: (s, v) => { s.hud.ghost = v; } },
      {
        kind: 'select', id: 'mirror', label: 'Rear-view mirrors',
        desc: 'Auto: the real mirrors in the cockpit view, a mirror strip at the top of the screen in the hood and bumper views. Off draws no mirror view at all, which saves a little GPU and CPU time.',
        options: opts([['auto', 'Auto'], ['off', 'Off']]),
        get: (s) => s.hud.mirror, set: (s, v) => { s.hud.mirror = v as Settings['hud']['mirror']; },
      },
      { kind: 'toggle', id: 'spotter', label: 'Car alongside indicator', desc: 'Lights the left or right edge of the screen when a car is alongside you or closing within a car length, brighter the closer it is.', get: (s) => s.hud.spotter, set: (s, v) => { s.hud.spotter = v; } },
      {
        kind: 'select', id: 'damage', label: 'Damage', desc: 'What crashes do to the cars. Off keeps every car pristine. Visual crumples panels, scrapes paint and breaks lamps on every car on track, and does not change how a car drives. Full: hard hits also hurt how the car drives: bent suspension, lost downforce, a tired engine. Taps and light scrapes never do.',
        options: opts([['off', 'Off'], ['visual', 'Visual'], ['full', 'Full']]),
        get: (s) => s.damage, set: (s, v) => { s.damage = v as Settings['damage']; },
      },
      {
        kind: 'slider', id: 'fov', label: 'Field of view', min: 45, max: 100, step: 1,
        desc: 'The camera lens. Wider shows more of the road and feels faster.',
        get: (s) => s.camera.fov, set: (s, v) => { s.camera.fov = v; }, fmt: (v) => Math.round(v) + '°',
      },
      {
        kind: 'slider', id: 'shake', label: 'Camera shake', min: 0, max: 1, step: 0.05,
        desc: 'Bumps, curbs and impacts shaking the view.',
        get: (s) => s.camera.shake, set: (s, v) => { s.camera.shake = v; }, fmt: pct,
      },
      {
        kind: 'select', id: 'defaultMode', label: 'Default camera', desc: 'The view you start every race in. Press Y or C to cycle in the race.',
        options: CAMERA_MODES.map((m) => ({ value: m, label: CAMERA_LABEL[m] })),
        get: (s) => s.camera.defaultMode, set: (s, v) => { s.camera.defaultMode = v as CameraMode; }, wrap: true,
      },
      { kind: 'text', id: 'playerName', label: 'Driver name', maxLength: 16, desc: 'Shown in the standings and on your car.', get: (s) => s.playerName, set: (s, v) => { s.playerName = v; } },
      { kind: 'text', id: 'player2Name', label: 'Player 2 name', maxLength: 16, desc: 'Shown on the tower, the HUD and the results in split screen.', get: (s) => s.player2Name, set: (s, v) => { s.player2Name = v; } },
      {
        kind: 'select', id: 'splitLayout', label: 'Split screen layout',
        desc: 'How two players share the screen. Top and bottom gives each a wide view and suits a 16:9 screen; side by side suits an ultrawide one.',
        options: opts([['rows', 'Top and bottom'], ['columns', 'Side by side']]),
        get: (s) => s.split.layout, set: (s, v) => { s.split.layout = v as SplitLayout; },
      },
    ],
  },
];

/** Labels used by the setup screen's selectors. */
export const OPTION_LABELS = {
  time: TIME_OF_DAY_LABEL,
  weather: WEATHER_LABEL,
  forecast: FORECAST_LABEL,
  difficulty: DIFFICULTY_LABEL,
  start: START_LABEL,
  length: LENGTH_LABEL,
  grid: GRID_LABEL,
};
