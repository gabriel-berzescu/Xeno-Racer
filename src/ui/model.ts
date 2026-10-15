/**
 * Pure UI model (no DOM): setup wizard state -> RaceConfig, car stat scoring, livery presets, best-lap
 * lookups and the declarative settings schema the Settings screen is generated from.
 */
import type {
  CameraMode,
  CarDefinition,
  Difficulty,
  GraphicsSettings,
  Livery,
  QualityLevel,
  RaceConfig,
  RaceMode,
  Settings,
  TimeOfDay,
  TrackInfo,
  Weather,
} from '../core/contracts';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../core/settings';
import { CAMERA_LABEL, DIFFICULTY_LABEL, pct, START_LABEL, TIME_OF_DAY_LABEL, WEATHER_LABEL } from './format';
import { clamp, clamp01 } from './hudlogic';

// ─────────────────────────────────────────────────────────────────────────────
// Enumerations
// ─────────────────────────────────────────────────────────────────────────────

export const TIMES: readonly TimeOfDay[] = ['dawn', 'morning', 'noon', 'golden', 'dusk', 'night'];
export const WEATHERS: readonly Weather[] = ['clear', 'cloudy', 'overcast', 'rain', 'storm'];
export const DIFFICULTIES: readonly Difficulty[] = ['rookie', 'amateur', 'pro', 'alien'];
export const STARTS: readonly RaceConfig['startPosition'][] = ['back', 'middle', 'pole'];
export const CAMERA_MODES: readonly CameraMode[] = ['chase', 'chase-far', 'hood', 'bumper', 'cockpit', 'tv', 'orbit'];

export const LAPS_MIN = 1;
export const LAPS_MAX = 50;
export const OPPONENTS_MAX = 11;

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

export interface SetupState {
  mode: RaceMode;
  trackIndex: number;
  carIndex: number;
  liveryIndex: number;
  laps: number;
  opponents: number;
  difficulty: Difficulty;
  timeOfDay: TimeOfDay;
  weather: Weather;
  startPosition: RaceConfig['startPosition'];
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
  freeRoam: { label: 'Free Roam', blurb: 'No laps, no pressure. Learn the circuit and tune your driving.', usesLaps: false, usesOpponents: true, usesDifficulty: true, usesStart: false },
};

export function defaultSetup(mode: RaceMode, tracks: readonly TrackInfo[], cars: readonly CarDefinition[], prev?: Partial<SetupState>): SetupState {
  const trackIndex = clamp(prev?.trackIndex ?? 0, 0, Math.max(0, tracks.length - 1));
  const track = tracks[trackIndex];
  return {
    mode,
    trackIndex,
    carIndex: clamp(prev?.carIndex ?? 0, 0, Math.max(0, cars.length - 1)),
    liveryIndex: prev?.liveryIndex ?? 0,
    laps: prev?.laps ?? track?.defaultLaps ?? 3,
    opponents: mode === 'race' ? clamp(prev?.opponents ?? 7, 0, OPPONENTS_MAX) : 0,
    difficulty: prev?.difficulty ?? 'amateur',
    timeOfDay: prev?.timeOfDay ?? track?.defaultTimeOfDay ?? 'golden',
    weather: prev?.weather ?? 'clear',
    startPosition: mode === 'race' ? prev?.startPosition ?? 'back' : 'pole',
  };
}

/** When the player picks another track, laps and time of day follow that track's defaults. */
export function applyTrackDefaults(s: SetupState, track: TrackInfo): void {
  s.laps = clamp(track.defaultLaps, LAPS_MIN, LAPS_MAX);
  s.timeOfDay = track.defaultTimeOfDay;
}

export function buildRaceConfig(s: SetupState, tracks: readonly TrackInfo[], cars: readonly CarDefinition[], playerName: string): RaceConfig {
  const track = tracks[clamp(s.trackIndex, 0, tracks.length - 1)];
  const car = cars[clamp(s.carIndex, 0, cars.length - 1)];
  const info = MODE_INFO[s.mode];
  const preset = LIVERY_PRESETS[clamp(s.liveryIndex, 0, LIVERY_PRESETS.length - 1)];
  return {
    mode: s.mode,
    trackId: track.id,
    carId: car.id,
    livery: liveryFor(preset, playerName),
    laps: info.usesLaps ? clamp(Math.round(s.laps), LAPS_MIN, LAPS_MAX) : 0,
    opponents: info.usesOpponents ? clamp(Math.round(s.opponents), 0, OPPONENTS_MAX) : 0,
    difficulty: info.usesDifficulty ? s.difficulty : 'amateur',
    environment: { timeOfDay: s.timeOfDay, weather: s.weather },
    startPosition: info.usesStart ? s.startPosition : 'pole',
  };
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

export type SettingsTabId = 'graphics' | 'audio' | 'controls' | 'assists' | 'gameplay';
export interface TabDef {
  id: SettingsTabId;
  label: string;
  /** Show every row's description permanently under its label. */
  showDesc: boolean;
  rows: RowDef[];
  reset(s: Settings): void;
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
        desc: 'How many trees, bushes and grass tufts line the circuit.',
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
    rows: [
      { kind: 'toggle', id: 'abs', label: 'ABS', desc: 'Stops the wheels locking under hard braking so you can still steer.', get: (s) => s.assists.abs, set: (s, v) => { s.assists.abs = v; } },
      {
        kind: 'select', id: 'tcs', label: 'Traction control', desc: 'Cuts power when the driven wheels spin. High keeps the car tidy; Off lets it light the tires.',
        options: opts([['off', 'Off'], ['low', 'Low'], ['high', 'High']]),
        get: (s) => s.assists.tcs, set: (s, v) => { s.assists.tcs = v as Settings['assists']['tcs']; },
      },
      { kind: 'toggle', id: 'esc', label: 'Stability control', desc: 'Brakes individual wheels to stop a spin before it starts.', get: (s) => s.assists.esc, set: (s, v) => { s.assists.esc = v; } },
      { kind: 'toggle', id: 'autoShift', label: 'Automatic gearbox', desc: 'Shifts for you. Turn it off to use RB / LB (or B / X) as paddles.', get: (s) => s.assists.autoShift, set: (s, v) => { s.assists.autoShift = v; } },
      {
        kind: 'slider', id: 'steeringAssist', label: 'Steering assist', min: 0, max: 1, step: 0.05,
        desc: 'Catches slides with automatic counter-steer and limits lock to what the tires can use.',
        get: (s) => s.assists.steeringAssist, set: (s, v) => { s.assists.steeringAssist = v; }, fmt: pct,
      },
      { kind: 'toggle', id: 'autoClutch', label: 'Automatic clutch', desc: 'Handles the clutch for launches and gear changes. Nearly everyone on a gamepad wants this on.', get: (s) => s.assists.autoClutch, set: (s, v) => { s.assists.autoClutch = v; } },
    ],
  },
  {
    id: 'gameplay',
    label: 'Gameplay',
    showDesc: false,
    reset: (s) => {
      s.units = DEFAULT_SETTINGS.units;
      s.hud = structuredClone(DEFAULT_SETTINGS.hud);
      s.camera = structuredClone(DEFAULT_SETTINGS.camera);
      s.playerName = DEFAULT_SETTINGS.playerName;
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
    ],
  },
];

/** Labels used by the setup screen's selectors. */
export const OPTION_LABELS = {
  time: TIME_OF_DAY_LABEL,
  weather: WEATHER_LABEL,
  difficulty: DIFFICULTY_LABEL,
  start: START_LABEL,
};
