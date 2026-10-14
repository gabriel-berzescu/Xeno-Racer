/**
 * Default settings, quality presets and localStorage persistence (owner: game).
 */
import type { GraphicsSettings, QualityLevel, Settings } from './contracts';

export const QUALITY_PRESETS: Record<QualityLevel, GraphicsSettings> = {
  low: { quality: 'low', renderScale: 0.75, shadows: 'low', ambientOcclusion: false, bloom: false, motionBlur: false, antialias: 'fxaa', vegetation: 0.35, maxFps: 0 },
  medium: { quality: 'medium', renderScale: 0.9, shadows: 'low', ambientOcclusion: false, bloom: true, motionBlur: false, antialias: 'smaa', vegetation: 0.6, maxFps: 0 },
  high: { quality: 'high', renderScale: 1, shadows: 'high', ambientOcclusion: true, bloom: true, motionBlur: true, antialias: 'smaa', vegetation: 0.85, maxFps: 0 },
  ultra: { quality: 'ultra', renderScale: 1.25, shadows: 'high', ambientOcclusion: true, bloom: true, motionBlur: true, antialias: 'smaa', vegetation: 1, maxFps: 0 },
};

export const DEFAULT_SETTINGS: Settings = {
  graphics: { ...QUALITY_PRESETS.high },
  audio: { master: 0.85, engine: 0.9, effects: 0.85, music: 0.5, ui: 0.6 },
  controls: { steerDeadzone: 0.08, steerLinearity: 1.6, pedalDeadzone: 0.04, speedSensitivity: 0.6, steerSpeed: 1, vibration: true, invertLookY: false },
  assists: { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0.35, autoClutch: true },
  units: 'kmh',
  hud: { minimap: true, telemetry: false, ghost: true, standings: true },
  camera: { fov: 62, defaultMode: 'chase', shake: 0.6 },
  playerName: 'Gabriel',
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

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return merge(structuredClone(DEFAULT_SETTINGS), JSON.parse(raw));
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
