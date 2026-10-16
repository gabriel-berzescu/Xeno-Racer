import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings } from '../src/core/settings';
import { SETTINGS_TABS } from '../src/ui/model';

const KEY = 'xeno-racer.settings.v1';

function withStorage(raw: string | null, run: () => void): void {
  const store = new Map<string, string>();
  if (raw !== null) store.set(KEY, raw);
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  run();
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('mirror and spotter settings', () => {
  it('both default on', () => {
    expect(DEFAULT_SETTINGS.hud.mirror).toBe('auto');
    expect(DEFAULT_SETTINGS.hud.spotter).toBe(true);
  });

  it('an old save without them gets the defaults and keeps what it had', () => {
    const old = { hud: { minimap: false, telemetry: true, ghost: false, standings: false }, camera: { fov: 80, defaultMode: 'cockpit', shake: 0.2 }, units: 'mph' };
    withStorage(JSON.stringify(old), () => {
      const s = loadSettings();
      expect(s.hud).toEqual({ minimap: false, telemetry: true, ghost: false, standings: false, mirror: 'auto', spotter: true });
      expect(s.camera.fov).toBe(80);
      expect(s.units).toBe('mph');
      expect(s.graphics).toEqual(DEFAULT_SETTINGS.graphics);
    });
  });

  it('saved values are kept', () => {
    withStorage(JSON.stringify({ hud: { mirror: 'off', spotter: false } }), () => {
      const s = loadSettings();
      expect(s.hud.mirror).toBe('off');
      expect(s.hud.spotter).toBe(false);
      expect(s.hud.minimap).toBe(true);
    });
  });

  it('a mirror mode this build does not know (a newer save, hand editing) falls back to the default', () => {
    for (const bad of ['virtual', 'ON', '', 3, null, true]) {
      withStorage(JSON.stringify({ hud: { mirror: bad, spotter: false } }), () => {
        const s = loadSettings();
        expect(s.hud.mirror).toBe('auto');
        expect(s.hud.spotter).toBe(false);
      });
    }
  });

  it('a spotter that is not a boolean is ignored', () => {
    withStorage(JSON.stringify({ hud: { spotter: 'yes' } }), () => {
      expect(loadSettings().hud.spotter).toBe(true);
    });
  });

  it('has a row for each in the gameplay tab, next to the other HUD options', () => {
    const rows = SETTINGS_TABS.find((t) => t.id === 'gameplay')!.rows;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('mirror');
    expect(ids).toContain('spotter');
    const mirror = rows.find((r) => r.id === 'mirror')!;
    expect(mirror.kind).toBe('select');
    if (mirror.kind === 'select') expect(mirror.options.map((o) => o.value)).toEqual(['auto', 'off']);
    // the HUD toggles stay together
    expect(Math.abs(ids.indexOf('mirror') - ids.indexOf('ghost'))).toBeLessThanOrEqual(2);
  });
});
