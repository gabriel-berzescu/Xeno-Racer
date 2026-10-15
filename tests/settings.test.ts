/**
 * Saved settings: whatever is in localStorage, the game must start. Unknown words fall back to the defaults.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings } from '../src/core/settings';

const KEY = 'xeno-racer.settings.v1';
const store: Record<string, string> = {};
const g = globalThis as unknown as { localStorage?: unknown };
const prev = g.localStorage;
g.localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) };
afterEach(() => {
  delete store[KEY];
});
afterAll(() => {
  g.localStorage = prev;
});

describe('saved settings', () => {
  it('replaces words this build does not know with the defaults and keeps the rest', () => {
    store[KEY] = JSON.stringify({
      graphics: { quality: 'ultraviolet', shadows: 'max', antialias: 'taa', renderScale: 9 },
      assists: { tcs: 'race', abs: false },
      units: 'furlongs',
      camera: { defaultMode: 'drone', fov: 70 },
    });
    const s = loadSettings();
    expect(s.graphics.quality).toBe(DEFAULT_SETTINGS.graphics.quality);
    expect(s.graphics.shadows).toBe(DEFAULT_SETTINGS.graphics.shadows);
    expect(s.graphics.antialias).toBe(DEFAULT_SETTINGS.graphics.antialias);
    expect(s.graphics.renderScale).toBe(1.5);
    expect(s.assists.tcs).toBe(DEFAULT_SETTINGS.assists.tcs);
    expect(s.assists.abs).toBe(false);
    expect(s.units).toBe(DEFAULT_SETTINGS.units);
    expect(s.camera.defaultMode).toBe(DEFAULT_SETTINGS.camera.defaultMode);
    expect(s.camera.fov).toBe(70);
  });

  it('keeps every valid choice', () => {
    store[KEY] = JSON.stringify({ graphics: { quality: 'low', shadows: 'off', antialias: 'off' }, assists: { tcs: 'off' }, units: 'mph', camera: { defaultMode: 'cockpit' } });
    const s = loadSettings();
    expect([s.graphics.quality, s.graphics.shadows, s.graphics.antialias, s.assists.tcs, s.units, s.camera.defaultMode]).toEqual(['low', 'off', 'off', 'off', 'mph', 'cockpit']);
  });
});
