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

  it('has the split-screen settings: the name of the second driver and how the screen divides', () => {
    expect(DEFAULT_SETTINGS.player2Name).toBe('Player 2');
    expect(DEFAULT_SETTINGS.split.layout).toBe('rows');
    // nothing saved: the defaults, and a save from before split screen existed gets them too
    expect(loadSettings().player2Name).toBe('Player 2');
    store[KEY] = JSON.stringify({ units: 'mph', playerName: 'Gabriel' });
    const old = loadSettings();
    expect(old.player2Name).toBe('Player 2');
    expect(old.split).toEqual({ layout: 'rows' });
  });

  it('has nitro on by default, for a save from before the switch too, and keeps it off once turned off', () => {
    expect(DEFAULT_SETTINGS.nitro).toBe(true);
    store[KEY] = JSON.stringify({ units: 'mph', damage: 'full' });
    expect(loadSettings().nitro).toBe(true);
    store[KEY] = JSON.stringify({ nitro: false });
    expect(loadSettings().nitro).toBe(false);
    // (not a yes or a no: the default)
    store[KEY] = JSON.stringify({ nitro: 'sometimes' });
    expect(loadSettings().nitro).toBe(true);
  });

  it('keeps a saved name for player 2 and the side-by-side layout', () => {
    store[KEY] = JSON.stringify({ player2Name: 'Silviu', split: { layout: 'columns' } });
    const s = loadSettings();
    expect(s.player2Name).toBe('Silviu');
    expect(s.split.layout).toBe('columns');
  });

  it('replaces a layout this build does not know with the default, and ignores a name that is not text', () => {
    store[KEY] = JSON.stringify({ player2Name: 7, split: { layout: 'diagonal' } });
    const s = loadSettings();
    expect(s.split.layout).toBe('rows');
    expect(s.player2Name).toBe('Player 2');
    store[KEY] = JSON.stringify({ split: 'columns' });
    expect(loadSettings().split.layout).toBe('rows');
  });

  it('keeps every valid choice', () => {
    store[KEY] = JSON.stringify({ graphics: { quality: 'low', shadows: 'off', antialias: 'off' }, assists: { tcs: 'off' }, units: 'mph', camera: { defaultMode: 'cockpit' } });
    const s = loadSettings();
    expect([s.graphics.quality, s.graphics.shadows, s.graphics.antialias, s.assists.tcs, s.units, s.camera.defaultMode]).toEqual(['low', 'off', 'off', 'off', 'mph', 'cockpit']);
  });

  it('takes Off, Visual and Full for the damage, and anything else for Visual', () => {
    expect(DEFAULT_SETTINGS.damage).toBe('visual');
    for (const mode of ['off', 'visual', 'full']) {
      store[KEY] = JSON.stringify({ damage: mode });
      expect(loadSettings().damage).toBe(mode);
    }
    // a save from before Full existed, one from a newer build with a mode this one lacks, and hand editing
    for (const bad of ['brutal', 'FULL', '', 3, null, true, ['full'], {}]) {
      store[KEY] = JSON.stringify({ damage: bad, units: 'mph' });
      const s = loadSettings();
      expect(s.damage).toBe('visual');
      expect(s.units).toBe('mph');
    }
    store[KEY] = JSON.stringify({ units: 'mph' });
    expect(loadSettings().damage).toBe('visual');
  });
});
