/**
 * Default settings, quality presets and localStorage persistence (owner: game).
 */
import { ASSIST_PRESETS, LINE_MODES } from './aids';
import type { GraphicsSettings, QualityLevel, Settings } from './contracts';

export const QUALITY_PRESETS: Record<QualityLevel, GraphicsSettings> = {
  low: { quality: 'low', renderScale: 0.75, shadows: 'low', ambientOcclusion: false, bloom: false, motionBlur: false, antialias: 'fxaa', vegetation: 0.35, maxFps: 0 },
  medium: { quality: 'medium', renderScale: 0.9, shadows: 'low', ambientOcclusion: false, bloom: true, motionBlur: false, antialias: 'smaa', vegetation: 0.6, maxFps: 0 },
  high: { quality: 'high', renderScale: 1, shadows: 'high', ambientOcclusion: true, bloom: true, motionBlur: true, antialias: 'smaa', vegetation: 0.85, maxFps: 0 },
  ultra: { quality: 'ultra', renderScale: 1.25, shadows: 'high', ambientOcclusion: true, bloom: true, motionBlur: true, antialias: 'smaa', vegetation: 1, maxFps: 0 },
};

export const DEFAULT_SETTINGS: Settings = {
  graphics: { ...QUALITY_PRESETS.high },
  audio: { master: 0.85, engine: 0.9, effects: 0.85, music: 0.5, raceMusic: 0.45, ui: 0.6 },
  controls: { steerDeadzone: 0.08, steerLinearity: 1.6, pedalDeadzone: 0.04, speedSensitivity: 0.6, steerSpeed: 1, vibration: true, invertLookY: false },
  // (the standard aids for each human; the opponents' are fixed, in game.ts)
  assists: { ...ASSIST_PRESETS.standard },
  assists2: { ...ASSIST_PRESETS.standard },
  units: 'kmh',
  hud: { minimap: true, telemetry: false, ghost: true, standings: true, mirror: 'auto', spotter: true },
  camera: { fov: 62, defaultMode: 'chase', shake: 0.6 },
  damage: 'visual',
  nitro: true,
  playerName: 'Gabriel',
  player2Name: 'Player 2',
  split: { layout: 'rows' },
};

const KEY = 'xeno-racer.settings.v1';

function merge<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (!(k in out)) continue;
    const b = out[k];
    out[k] = b !== null && typeof b === 'object' && !Array.isArray(b) ? merge(b, v) : typeof v === typeof b ? v : b;
  }
  return out as T;
}

/** Settings that must be one of a few words. A value this build doesn't know (a hand-edited or newer save) would
 * reach code that indexes tables by it: it falls back to the default. */
const CHOICES: [string, readonly string[]][] = [
  ['graphics.quality', ['low', 'medium', 'high', 'ultra']],
  ['graphics.shadows', ['off', 'low', 'high']],
  ['graphics.antialias', ['off', 'fxaa', 'smaa']],
  ['assists.tcs', ['off', 'low', 'high']],
  ['assists.line', LINE_MODES],
  ['assists2.tcs', ['off', 'low', 'high']],
  ['assists2.line', LINE_MODES],
  ['units', ['kmh', 'mph']],
  ['camera.defaultMode', ['chase', 'chase-far', 'hood', 'bumper', 'cockpit', 'tv', 'orbit']],
  ['split.layout', ['rows', 'columns']],
  // (a save from before Full existed holds 'off' or 'visual': both still mean what they did)
  ['damage', ['off', 'visual', 'full']],
];

function keepKnownChoices(s: Settings): Settings {
  for (const [path, ok] of CHOICES) {
    const keys = path.split('.');
    const last = keys.pop()!;
    let o = s as unknown as Record<string, unknown>;
    let d = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
    for (const k of keys) {
      o = o[k] as Record<string, unknown>;
      d = d[k] as Record<string, unknown>;
    }
    if (!ok.includes(o[last] as string)) o[last] = d[last];
  }
  s.graphics.renderScale = Math.min(1.5, Math.max(0.5, s.graphics.renderScale));
  // (a hand-edited volume past the ends of its slider is held to them; a save from before the race music has the default for it)
  for (const k of Object.keys(s.audio) as (keyof Settings['audio'])[]) s.audio[k] = Math.min(1, Math.max(0, s.audio[k]));
  for (const a of [s.assists, s.assists2]) a.steeringAssist = Math.min(1, Math.max(0, a.steeringAssist));
  return s;
}

const isRecord = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved: unknown = JSON.parse(raw);
      const s = keepKnownChoices(merge(structuredClone(DEFAULT_SETTINGS), saved));
      // a save from before player 2 had aids of their own: both humans drove with the one set, and player 2 goes on with it
      if (isRecord(saved) && isRecord(saved.assists) && !isRecord(saved.assists2)) s.assists2 = { ...s.assists };
      // a mode this build does not know (saved by a newer one) falls back to the default
      if (s.hud.mirror !== 'auto' && s.hud.mirror !== 'off') s.hud.mirror = DEFAULT_SETTINGS.hud.mirror;
      return s;
    }
  } catch {
    /* private mode / corrupted — fall through */
  }
  return structuredClone(DEFAULT_SETTINGS);
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
