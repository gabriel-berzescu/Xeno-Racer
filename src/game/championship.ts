/**
 * Championship mode logic: the fixed calendar, scoring, standings with tie-breaks, grids, season creation,
 * round recording, the view models the menus render, and localStorage persistence.
 *
 * Everything here is pure and headless (the storage wrappers at the bottom are the only side effects and
 * never throw). game.ts owns the flow: it creates the season, turns a round into a `RaceConfig`, records the
 * finishing order when the results come up and hands `buildView()` to the UI.
 *
 * Scoring: 25-18-15-12-10-8-6-4-2-1 for the top ten, +1 for the fastest lap of the race when its driver
 * finishes in the points. Ties are broken by countback (most wins, then most second places, ...).
 */
import type {
  CarDefinition,
  ChampionshipDef,
  ChampionshipGridSlot,
  ChampionshipLength,
  ChampionshipRoundInfo,
  ChampionshipRoundView,
  ChampionshipRow,
  ChampionshipSetup,
  ChampionshipView,
  Difficulty,
  EnvironmentSettings,
  Forecast,
  Livery,
  RaceConfig,
  TimeOfDay,
  TrackInfo,
  Weather,
} from '../core/contracts';
import { sanitizeForecast } from '../core/forecast';
import { opponentLivery } from './liveries';

// ─────────────────────────────────────────────────────────────────────────────
// Rules and calendar
// ─────────────────────────────────────────────────────────────────────────────

export const CHAMPIONSHIP_NAME = 'Xeno Cup';
export const POINTS: readonly number[] = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
export const FASTEST_LAP_POINT = 1;
export const MAX_OPPONENTS = 11;
export const MIN_OPPONENTS = 1;
export const PLAYER_ID = 'player';
const PLAYER_COLOR = '#16e0bd';
/** Chip colour for an opponent whose saved colour is unusable. */
const FALLBACK_COLOR = '#8a93a3';

/**
 * The calendar is fixed: four circuits, eight very different days. Porto Vela's night round starts dry under cloud and the rain
 * comes during the race (when and how hard is fixed for the season, so a restart repeats it); a thunderstorm to finish.
 */
export const CALENDAR: readonly { trackId: string; environment: EnvironmentSettings; forecast?: Forecast }[] = [
  { trackId: 'aurelia', environment: { timeOfDay: 'golden', weather: 'clear' } },
  { trackId: 'kuroyama', environment: { timeOfDay: 'morning', weather: 'cloudy' } },
  { trackId: 'portovela', environment: { timeOfDay: 'dusk', weather: 'clear' } },
  { trackId: 'brennwald', environment: { timeOfDay: 'morning', weather: 'clear' } },
  { trackId: 'kuroyama', environment: { timeOfDay: 'dusk', weather: 'rain' } },
  { trackId: 'aurelia', environment: { timeOfDay: 'night', weather: 'clear' } },
  { trackId: 'portovela', environment: { timeOfDay: 'night', weather: 'cloudy' }, forecast: 'rainLater' },
  { trackId: 'brennwald', environment: { timeOfDay: 'noon', weather: 'storm' } },
];

/** The weather change a round really runs at this many laps (a one-lap race is over before it would come). */
export const roundForecast = (r: { environment: EnvironmentSettings; forecast?: Forecast }, laps: number): Forecast =>
  sanitizeForecast(r.forecast, r.environment.weather, 'race', laps);

export const LENGTHS: readonly ChampionshipLength[] = ['short', 'standard', 'long'];
const LENGTH_FACTOR: Record<ChampionshipLength, number> = { short: 0.5, standard: 1, long: 2 };
const LAPS_FALLBACK = 3;
const LAPS_MAX = 50;

/** Laps of a round: the track's own default scaled by the chosen race length (never fewer than one). */
export function lapsFor(defaultLaps: number, length: ChampionshipLength): number {
  const base = Number.isFinite(defaultLaps) && defaultLaps > 0 ? defaultLaps : LAPS_FALLBACK;
  return Math.min(LAPS_MAX, Math.max(1, Math.round(base * LENGTH_FACTOR[length])));
}

/** The calendar and rules as the setup screen previews them. */
export function championshipDef(tracks: readonly TrackInfo[]): ChampionshipDef {
  return {
    name: CHAMPIONSHIP_NAME,
    rounds: CALENDAR.map((c) => {
      const base = tracks.find((t) => t.id === c.trackId)?.defaultLaps ?? LAPS_FALLBACK;
      return {
        trackId: c.trackId,
        environment: { ...c.environment },
        ...(c.forecast ? { forecast: c.forecast } : {}),
        laps: { short: lapsFor(base, 'short'), standard: lapsFor(base, 'standard'), long: lapsFor(base, 'long') },
      };
    }),
    points: [...POINTS],
    fastestLapPoint: FASTEST_LAP_POINT,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

export const CHAMPIONSHIP_VERSION = 1;

export interface ChampionshipDriver {
  /** Stable for the whole season. */
  id: string;
  name: string;
  isPlayer: boolean;
  /** Chip colour in the tables. */
  color: string;
  /** Opponents: livery and AI variation seed, fixed for the season (a driver's identity and pace). */
  livery?: Livery;
  seed?: number;
}

export interface ChampionshipRound {
  trackId: string;
  environment: EnvironmentSettings;
  laps: number;
  /** A change of weather during the round, and the seed that fixes when and how hard (the same all season). */
  forecast?: Forecast;
  forecastSeed?: number;
}

export interface RoundEntry {
  id: string;
  /** Finishing position, 1-based. */
  position: number;
  /** Points scored, fastest-lap bonus included. */
  points: number;
  /** This driver took the fastest-lap point. */
  fastestLap: boolean;
  bestLap: number | null;
  totalTime: number | null;
  laps: number;
}

export interface RoundResult {
  /** 0-based calendar index. */
  round: number;
  /** Sorted by position. */
  entries: RoundEntry[];
  /** Who set the fastest lap of the race (whether or not it earned the bonus). */
  fastestLapId: string | null;
  fastestLapTime: number | null;
}

export interface ChampionshipState {
  version: typeof CHAMPIONSHIP_VERSION;
  name: string;
  seed: number;
  createdAt: number;
  setup: ChampionshipSetup;
  calendar: ChampionshipRound[];
  /** The player first, then the opponents in roster order. */
  drivers: ChampionshipDriver[];
  /** Completed rounds, in calendar order. */
  results: RoundResult[];
}

const TIME_OF_DAY: Record<TimeOfDay, true> = { dawn: true, morning: true, noon: true, golden: true, dusk: true, night: true };
const WEATHER: Record<Weather, true> = { clear: true, cloudy: true, overcast: true, rain: true, storm: true };
const DIFFICULTY: Record<Difficulty, true> = { rookie: true, amateur: true, pro: true, alien: true };
const START: Record<ChampionshipSetup['startPosition'], true> = { back: true, middle: true, pole: true };
const GRID: Record<ChampionshipSetup['grid'], true> = { standings: true, reverse: true };
const LENGTH: Record<ChampionshipLength, true> = { short: true, standard: true, long: true };
const PATTERN: Record<Livery['pattern'], true> = { solid: true, stripes: true, split: true, arrow: true, hoops: true, shards: true };

const isKey = <T extends string>(table: Record<T, true>, v: unknown): v is T => typeof v === 'string' && Object.prototype.hasOwnProperty.call(table, v);
const clampInt = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(v)));

/** Clamps a setup to legal values (the UI already does; saved data and URL flags may not). */
export function sanitizeSetup(s: Partial<ChampionshipSetup> & { carId: string }): ChampionshipSetup {
  return {
    carId: s.carId,
    livery: s.livery ? { ...s.livery } : undefined,
    difficulty: isKey(DIFFICULTY, s.difficulty) ? s.difficulty : 'amateur',
    opponents: typeof s.opponents === 'number' && Number.isFinite(s.opponents) ? clampInt(s.opponents, MIN_OPPONENTS, MAX_OPPONENTS) : 7,
    length: isKey(LENGTH, s.length) ? s.length : 'standard',
    startPosition: isKey(START, s.startPosition) ? s.startPosition : 'back',
    grid: isKey(GRID, s.grid) ? s.grid : 'standings',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Creating a season
// ─────────────────────────────────────────────────────────────────────────────

/** Small deterministic PRNG (mulberry32) so a season's roster follows from its seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CreateOptions {
  setup: ChampionshipSetup;
  tracks: readonly TrackInfo[];
  playerName: string;
  /** The player's resolved livery (opponents avoid its colour). */
  playerLivery: Livery;
  /** The car everyone drives (liveries depend on it only through the number offset). */
  car: CarDefinition;
  seed: number;
  now?: number;
}

/**
 * The opponents of a season: `n` distinct drivers with distinct primary colours, none sharing the player's
 * colour or name. Which names and colours come up depends on the seed.
 */
export function buildOpponents(n: number, car: CarDefinition, player: { name: string; livery: Livery }, seed: number): ChampionshipDriver[] {
  const rand = seededRandom(seed);
  const names = new Set<string>([player.name.trim().toLowerCase()]);
  const colours = new Set<string>([player.livery.primary.toLowerCase()]);
  let idx = Math.floor(rand() * 14);
  const out: ChampionshipDriver[] = [];
  for (let i = 0; i < n; i++) {
    let livery = opponentLivery(idx, car, player.livery);
    for (let tries = 0; tries < 14 && (colours.has(livery.primary.toLowerCase()) || names.has(livery.driver.toLowerCase())); tries++) {
      idx++;
      livery = opponentLivery(idx, car, player.livery);
    }
    idx++;
    colours.add(livery.primary.toLowerCase());
    names.add(livery.driver.toLowerCase());
    out.push({ id: `ai${i + 1}`, name: livery.driver, isPlayer: false, color: livery.primary, livery, seed: 1 + Math.floor(rand() * 8999) });
  }
  return out;
}

/** A round's weather seed, from the season's: every season brings its rain at its own moment. */
const forecastSeedFor = (seed: number, round: number): number => 1 + (Math.abs(Math.floor(seed * 7919 + (round + 1) * 104729)) % 2147483646);

export function createChampionship(o: CreateOptions): ChampionshipState {
  const setup = sanitizeSetup(o.setup);
  const calendar: ChampionshipRound[] = CALENDAR.map((c, i) => ({
    trackId: c.trackId,
    environment: { ...c.environment },
    laps: lapsFor(o.tracks.find((t) => t.id === c.trackId)?.defaultLaps ?? LAPS_FALLBACK, setup.length),
    ...(c.forecast && c.forecast !== 'stable' ? { forecast: c.forecast, forecastSeed: forecastSeedFor(o.seed, i) } : {}),
  }));
  const name = o.playerName.trim() || 'You';
  const drivers: ChampionshipDriver[] = [
    { id: PLAYER_ID, name, isPlayer: true, color: PLAYER_COLOR },
    ...buildOpponents(setup.opponents, o.car, { name, livery: o.playerLivery }, o.seed),
  ];
  return { version: CHAMPIONSHIP_VERSION, name: CHAMPIONSHIP_NAME, seed: o.seed, createdAt: o.now ?? Date.now(), setup, calendar, drivers, results: [] };
}

/** Can this build race the season? (A save may name a track or a car that no longer exists.) */
export function isPlayable(s: ChampionshipState, trackIds: readonly string[], carIds: readonly string[]): boolean {
  return carIds.includes(s.setup.carId) && s.calendar.every((r) => trackIds.includes(r.trackId));
}

export const isComplete = (s: ChampionshipState): boolean => s.results.length >= s.calendar.length;
/** Index of the next round to race, or -1 when the season is over. */
export const nextRound = (s: ChampionshipState): number => (isComplete(s) ? -1 : s.results.length);

// ─────────────────────────────────────────────────────────────────────────────
// Scoring a round
// ─────────────────────────────────────────────────────────────────────────────

/** What the race reports about one driver. */
export interface Finisher {
  id: string;
  /** Finishing position, 1-based (as classified by the race). */
  position: number;
  /** null = not classified (scores nothing). */
  totalTime: number | null;
  bestLap: number | null;
  laps: number;
}

/** Points for a finishing position (0 outside the points). */
export function pointsFor(position: number): number {
  return position >= 1 && position <= POINTS.length ? POINTS[position - 1] : 0;
}

const finite = (v: number | null): v is number => v !== null && Number.isFinite(v);

/**
 * Scores one race. The fastest lap of the race earns a point when its driver is classified in the points
 * (otherwise nobody gets it); equal laps go to the better finisher.
 */
export function scoreRound(round: number, finishers: readonly Finisher[]): RoundResult {
  const sorted = finishers.map((f, i) => ({ f, i })).sort((a, b) => a.f.position - b.f.position || a.i - b.i).map((x) => x.f);
  let fastest: Finisher | null = null;
  for (const f of sorted) if (finite(f.bestLap) && (fastest === null || f.bestLap < (fastest.bestLap as number))) fastest = f;
  const bonus = fastest !== null && finite(fastest.totalTime) && fastest.position <= POINTS.length ? fastest.id : null;
  const entries: RoundEntry[] = sorted.map((f) => {
    const classified = finite(f.totalTime);
    const fl = bonus === f.id;
    return {
      id: f.id,
      position: f.position,
      points: (classified ? pointsFor(f.position) : 0) + (fl ? FASTEST_LAP_POINT : 0),
      fastestLap: fl,
      bestLap: finite(f.bestLap) ? f.bestLap : null,
      totalTime: classified ? f.totalTime : null,
      laps: f.laps,
    };
  });
  return { round, entries, fastestLapId: fastest ? fastest.id : null, fastestLapTime: fastest ? (fastest.bestLap as number) : null };
}

/**
 * The state after the next round has been raced. Unknown drivers and duplicates are ignored and any driver the
 * race did not report is classified last without points, so a malformed report can never corrupt the season.
 * Returns the same state once the season is over.
 */
export function recordRound(state: ChampionshipState, finishers: readonly Finisher[]): ChampionshipState {
  if (isComplete(state)) return state;
  const known = new Set(state.drivers.map((d) => d.id));
  const seen = new Set<string>();
  const clean: Finisher[] = [];
  for (const f of finishers) {
    if (!known.has(f.id) || seen.has(f.id)) continue;
    seen.add(f.id);
    clean.push(f);
  }
  // close ranks (positions are 1..n again, whatever was dropped), then classify the forgotten drivers last
  const ranked = clean.map((f, i) => ({ f, i })).sort((x, y) => x.f.position - y.f.position || x.i - y.i).map(({ f }, i) => ({ ...f, position: i + 1 }));
  for (const d of state.drivers) if (!seen.has(d.id)) ranked.push({ id: d.id, position: ranked.length + 1, totalTime: null, bestLap: null, laps: 0 });
  return { ...state, results: [...state.results, scoreRound(state.results.length, ranked)] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Standings
// ─────────────────────────────────────────────────────────────────────────────

interface Tally {
  id: string;
  order: number;
  points: number;
  /** How often the driver finished in each position (index 0 = wins). */
  finishes: number[];
  /** Position in the most recent round raced. */
  last: number;
}

function tally(state: ChampionshipState, upTo: number): Tally[] {
  const n = state.drivers.length;
  const byId = new Map<string, Tally>();
  state.drivers.forEach((d, order) => byId.set(d.id, { id: d.id, order, points: 0, finishes: new Array<number>(n).fill(0), last: n + 1 }));
  for (const r of state.results.slice(0, upTo)) {
    for (const e of r.entries) {
      const t = byId.get(e.id);
      if (!t) continue;
      t.points += e.points;
      if (e.position >= 1 && e.position <= n) t.finishes[e.position - 1]++;
      t.last = e.position;
    }
  }
  return [...byId.values()];
}

/** Points, then countback on finishing positions (most wins, then most seconds, ...), then the latest result. */
function compareTallies(a: Tally, b: Tally): number {
  if (a.points !== b.points) return b.points - a.points;
  for (let i = 0; i < a.finishes.length; i++) if (a.finishes[i] !== b.finishes[i]) return b.finishes[i] - a.finishes[i];
  if (a.last !== b.last) return a.last - b.last;
  return a.order - b.order;
}

/** Driver ids in championship order after the first `upTo` rounds. */
export function standingsOrder(state: ChampionshipState, upTo: number = state.results.length): string[] {
  return tally(state, upTo).sort(compareTallies).map((t) => t.id);
}

/** The championship table after the first `upTo` rounds (default: every completed round). */
export function computeStandings(state: ChampionshipState, upTo: number = state.results.length): ChampionshipRow[] {
  const k = Math.min(Math.max(0, upTo), state.results.length);
  const order = standingsOrder(state, k);
  // the order before the last round: the roster order if it was the first
  const before = k >= 1 ? standingsOrder(state, k - 1) : order;
  const rounds = state.calendar.length;
  const driver = new Map(state.drivers.map((d) => [d.id, d]));
  const leaderPoints = tally(state, k).reduce((m, t) => Math.max(m, t.points), 0);
  return order.map((id, i) => {
    const d = driver.get(id) as ChampionshipDriver;
    const roundPoints: (number | null)[] = new Array<number | null>(rounds).fill(null);
    const roundPositions: (number | null)[] = new Array<number | null>(rounds).fill(null);
    const roundFastest: boolean[] = new Array<boolean>(rounds).fill(false);
    let points = 0;
    let wins = 0;
    let podiums = 0;
    let fastestLaps = 0;
    for (let r = 0; r < k; r++) {
      const e = state.results[r].entries.find((x) => x.id === id);
      if (!e) continue;
      roundPoints[r] = e.points;
      roundPositions[r] = e.position;
      roundFastest[r] = e.fastestLap;
      points += e.points;
      if (e.totalTime !== null && e.position === 1) wins++;
      if (e.totalTime !== null && e.position <= 3) podiums++;
      if (e.fastestLap) fastestLaps++;
    }
    return {
      position: i + 1,
      id,
      name: d.name,
      isPlayer: d.isPlayer,
      color: d.color,
      points,
      gap: leaderPoints - points,
      roundPoints,
      roundPositions,
      roundFastest,
      wins,
      podiums,
      fastestLaps,
      move: k >= 2 ? before.indexOf(id) - i : null,
      prevPosition: before.indexOf(id) + 1,
      lastGain: k > 0 ? roundPoints[k - 1] ?? 0 : 0,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Grids and round configs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Driver ids on the grid for a round, pole first. Round 1: the opponents in roster order with the player
 * where the setup says. Later rounds: championship order after the rounds before it, leader on pole
 * (or the reverse of that order, if the season is set up that way).
 */
export function gridOrder(state: ChampionshipState, round: number): string[] {
  if (round <= 0) {
    const ids = state.drivers.filter((d) => !d.isPlayer).map((d) => d.id);
    const total = ids.length + 1;
    const start = state.setup.startPosition;
    ids.splice(start === 'pole' ? 0 : start === 'back' ? total - 1 : Math.floor(total / 2), 0, PLAYER_ID);
    return ids;
  }
  const order = standingsOrder(state, Math.min(round, state.results.length));
  return state.setup.grid === 'reverse' ? order.reverse() : order;
}

export function roundInfo(state: ChampionshipState, round: number): ChampionshipRoundInfo {
  const byId = new Map(state.drivers.map((d) => [d.id, d]));
  const grid: ChampionshipGridSlot[] = gridOrder(state, round).map((id) => {
    const d = byId.get(id) as ChampionshipDriver;
    return d.isPlayer ? { id, name: d.name, isPlayer: true } : { id, name: d.name, isPlayer: false, livery: d.livery, seed: d.seed };
  });
  return { name: state.name, round: round + 1, rounds: state.calendar.length, grid };
}

/** The race config of a round of the season (always a normal race; `championship` carries the grid). */
export function roundConfig(state: ChampionshipState, round: number): RaceConfig {
  const r = state.calendar[round];
  const info = roundInfo(state, round);
  const slot = info.grid.findIndex((g) => g.isPlayer);
  return {
    mode: 'race',
    trackId: r.trackId,
    carId: state.setup.carId,
    livery: state.setup.livery ? { ...state.setup.livery } : undefined,
    laps: r.laps,
    opponents: state.drivers.length - 1,
    difficulty: state.setup.difficulty,
    environment: { ...r.environment },
    ...(roundForecast(r, r.laps) !== 'stable' ? { forecast: r.forecast, forecastSeed: r.forecastSeed ?? forecastSeedFor(state.seed, round) } : {}),
    startPosition: slot <= 0 ? 'pole' : slot >= info.grid.length - 1 ? 'back' : 'middle',
    championship: info,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// View model for the menus
// ─────────────────────────────────────────────────────────────────────────────

export function buildView(state: ChampionshipState, playerName?: string): ChampionshipView {
  const table = computeStandings(state);
  const shown = (d: { name: string; isPlayer: boolean }): string => (d.isPlayer && playerName && playerName.trim() ? playerName.trim() : d.name);
  for (const row of table) row.name = shown(row);
  const names = new Map(state.drivers.map((d) => [d.id, { name: shown(d), isPlayer: d.isPlayer }]));
  const rounds: ChampionshipRoundView[] = state.calendar.map((c, r) => {
    const res = state.results[r];
    const win = res?.entries.find((e) => e.position === 1 && e.totalTime !== null);
    const me = res?.entries.find((e) => e.id === PLAYER_ID);
    const fl = res && res.fastestLapId !== null && res.fastestLapTime !== null ? names.get(res.fastestLapId) : undefined;
    return {
      round: r,
      trackId: c.trackId,
      environment: { ...c.environment },
      ...(roundForecast(c, c.laps) !== 'stable' ? { forecast: c.forecast } : {}),
      laps: c.laps,
      done: !!res,
      winner: win ? { ...(names.get(win.id) as { name: string; isPlayer: boolean }) } : null,
      playerPosition: me ? me.position : null,
      playerPoints: me ? me.points : null,
      fastestLap: fl && res.fastestLapTime !== null ? { name: fl.name, time: res.fastestLapTime, isPlayer: fl.isPlayer } : null,
    };
  });
  const player = table.find((r) => r.isPlayer) as ChampionshipRow;
  const finishes = player.roundPositions.filter((p): p is number => p !== null);
  return {
    name: state.name,
    carId: state.setup.carId,
    difficulty: state.setup.difficulty,
    length: state.setup.length,
    opponents: state.drivers.length - 1,
    grid: state.setup.grid,
    rounds,
    done: state.results.length,
    complete: isComplete(state),
    table,
    player,
    season: {
      rounds: state.results.length,
      wins: player.wins,
      podiums: player.podiums,
      fastestLaps: player.fastestLaps,
      points: player.points,
      bestFinish: finishes.length ? Math.min(...finishes) : null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence (versioned, tolerant of corrupt data)
// ─────────────────────────────────────────────────────────────────────────────

export const CHAMPIONSHIP_KEY = 'xeno-racer.championship.v1';

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.length > 0 ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const HEX = /^#[0-9a-f]{6}$/i;

function sanitizeLivery(v: unknown, fallbackName: string, fallbackColor: string): Livery {
  const o = isObj(v) ? v : {};
  return {
    primary: typeof o.primary === 'string' && HEX.test(o.primary) ? o.primary : fallbackColor,
    secondary: typeof o.secondary === 'string' && HEX.test(o.secondary) ? o.secondary : '#eef0f3',
    accent: typeof o.accent === 'string' && HEX.test(o.accent) ? o.accent : '#111111',
    pattern: isKey(PATTERN, o.pattern) ? o.pattern : 'solid',
    number: clampInt(num(o.number, 0), 0, 99),
    driver: str(o.driver, fallbackName),
    finish: Math.min(1, Math.max(0, num(o.finish, 0))),
    metallic: o.metallic === true,
  };
}

function sanitizePartialLivery(v: unknown): Partial<Livery> | undefined {
  if (!isObj(v)) return undefined;
  const out: Partial<Livery> = {};
  for (const k of ['primary', 'secondary', 'accent'] as const) if (typeof v[k] === 'string' && HEX.test(v[k] as string)) out[k] = v[k] as string;
  if (isKey(PATTERN, v.pattern)) out.pattern = v.pattern;
  if (typeof v.driver === 'string') out.driver = v.driver;
  if (typeof v.number === 'number' && Number.isFinite(v.number)) out.number = clampInt(v.number, 0, 99);
  if (typeof v.finish === 'number' && Number.isFinite(v.finish)) out.finish = Math.min(1, Math.max(0, v.finish));
  if (typeof v.metallic === 'boolean') out.metallic = v.metallic;
  return out;
}

function sanitizeEnvironment(v: unknown): EnvironmentSettings | null {
  if (!isObj(v) || !isKey(TIME_OF_DAY, v.timeOfDay) || !isKey(WEATHER, v.weather)) return null;
  return { timeOfDay: v.timeOfDay, weather: v.weather };
}

/**
 * Validates and repairs parsed JSON. Returns null when it cannot be a championship; damage that can be cut out
 * (a broken round and everything after it, an entry for a driver who is not in the season) is cut out.
 */
export function sanitizeState(raw: unknown): ChampionshipState | null {
  if (!isObj(raw) || raw.version !== CHAMPIONSHIP_VERSION) return null;
  const setupRaw = raw.setup;
  if (!isObj(setupRaw) || typeof setupRaw.carId !== 'string' || setupRaw.carId.length === 0) return null;
  const setup = sanitizeSetup({ ...(setupRaw as Partial<ChampionshipSetup>), carId: setupRaw.carId, livery: sanitizePartialLivery(setupRaw.livery) });

  if (!Array.isArray(raw.calendar) || raw.calendar.length < 1 || raw.calendar.length > 12) return null;
  const calendar: ChampionshipRound[] = [];
  for (const c of raw.calendar) {
    const env = isObj(c) ? sanitizeEnvironment(c.environment) : null;
    if (!isObj(c) || typeof c.trackId !== 'string' || c.trackId.length === 0 || !env) return null;
    const round: ChampionshipRound = { trackId: c.trackId, environment: env, laps: clampInt(num(c.laps, LAPS_FALLBACK), 1, LAPS_MAX) };
    // (a season saved before the weather could change has no forecasts and keeps its own calendar)
    if (c.forecast === 'rainLater' || c.forecast === 'clearing') {
      round.forecast = c.forecast;
      round.forecastSeed = clampInt(num(c.forecastSeed, calendar.length + 1), 1, 2147483646);
    }
    calendar.push(round);
  }

  if (!Array.isArray(raw.drivers) || raw.drivers.length < 2 || raw.drivers.length > MAX_OPPONENTS + 1) return null;
  const drivers: ChampionshipDriver[] = [];
  const ids = new Set<string>();
  for (const [i, d] of raw.drivers.entries()) {
    if (!isObj(d) || typeof d.id !== 'string' || d.id.length === 0 || ids.has(d.id)) return null;
    if ((i === 0) !== (d.isPlayer === true)) return null; // exactly one player, listed first
    if (i === 0 ? d.id !== PLAYER_ID : d.id === PLAYER_ID) return null; // the grid and the tables look the player up by this id
    ids.add(d.id);
    const name = str(d.name, i === 0 ? 'You' : `Driver ${i}`);
    const color = typeof d.color === 'string' && HEX.test(d.color) ? d.color : i === 0 ? PLAYER_COLOR : FALLBACK_COLOR;
    drivers.push(
      i === 0
        ? { id: d.id, name, isPlayer: true, color }
        : { id: d.id, name, isPlayer: false, color, livery: sanitizeLivery(d.livery, name, color), seed: clampInt(num(d.seed, i), 1, 1e6) },
    );
  }

  const results: RoundResult[] = [];
  if (Array.isArray(raw.results)) {
    for (const r of raw.results) {
      if (results.length >= calendar.length || !isObj(r) || r.round !== results.length || !Array.isArray(r.entries)) break;
      const entries: RoundEntry[] = [];
      const seen = new Set<string>();
      for (const e of r.entries) {
        if (!isObj(e) || typeof e.id !== 'string' || !ids.has(e.id) || seen.has(e.id)) continue;
        if (typeof e.position !== 'number' || !Number.isFinite(e.position) || e.position < 1) continue;
        seen.add(e.id);
        entries.push({
          id: e.id,
          position: Math.round(e.position),
          points: Math.max(0, num(e.points, 0)),
          fastestLap: e.fastestLap === true,
          bestLap: numOrNull(e.bestLap),
          totalTime: numOrNull(e.totalTime),
          laps: Math.max(0, Math.round(num(e.laps, 0))),
        });
      }
      if (entries.length === 0) break;
      entries.sort((a, b) => a.position - b.position);
      const flId = typeof r.fastestLapId === 'string' && ids.has(r.fastestLapId) ? r.fastestLapId : null;
      const flTime = numOrNull(r.fastestLapTime);
      results.push({ round: results.length, entries, fastestLapId: flId !== null && flTime !== null ? flId : null, fastestLapTime: flId !== null ? flTime : null });
    }
  }

  return {
    version: CHAMPIONSHIP_VERSION,
    name: str(raw.name, CHAMPIONSHIP_NAME),
    seed: num(raw.seed, 1),
    createdAt: num(raw.createdAt, 0),
    setup,
    calendar,
    drivers,
    results,
  };
}

export const serializeChampionship = (s: ChampionshipState): string => JSON.stringify(s);

export function parseChampionship(text: string | null | undefined): ChampionshipState | null {
  if (!text) return null;
  try {
    return sanitizeState(JSON.parse(text));
  } catch {
    return null;
  }
}

export function loadChampionship(): ChampionshipState | null {
  try {
    return parseChampionship(localStorage.getItem(CHAMPIONSHIP_KEY));
  } catch {
    return null;
  }
}

/** Saves the season (best effort; the game works without storage). `null` forgets it. */
export function saveChampionship(s: ChampionshipState | null): void {
  try {
    if (s) localStorage.setItem(CHAMPIONSHIP_KEY, serializeChampionship(s));
    else localStorage.removeItem(CHAMPIONSHIP_KEY);
  } catch {
    /* quota / private mode: the season just will not survive a reload */
  }
}
