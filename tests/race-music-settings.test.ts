/**
 * The Race music setting: a default, old saves without it, bad values, and the row that edits it in Settings > Audio. The words of
 * the "now playing" card.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { NowPlaying, Settings } from '../src/core/contracts';
import { DEFAULT_SETTINGS, loadSettings } from '../src/core/settings';
import { nowPlayingLines } from '../src/ui/format';
import { SETTINGS_TABS } from '../src/ui/model';

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

describe('Race music setting', () => {
  it('defaults to 0.45, apart from the menu music (0.5)', () => {
    expect(DEFAULT_SETTINGS.audio.raceMusic).toBe(0.45);
    expect(DEFAULT_SETTINGS.audio.music).toBe(0.5);
    expect(loadSettings().audio.raceMusic).toBe(0.45);
  });

  it('an old save without it loads, with the default, and keeps its other volumes', () => {
    store[KEY] = JSON.stringify({ audio: { master: 0.4, engine: 0.7, effects: 0.3, music: 0.2, ui: 0.9 }, units: 'mph', playerName: 'Silviu' });
    const s = loadSettings();
    expect(s.audio.raceMusic).toBe(0.45);
    expect(s.audio).toEqual({ master: 0.4, engine: 0.7, effects: 0.3, music: 0.2, raceMusic: 0.45, ui: 0.9 });
    expect(s.units).toBe('mph');
    expect(s.playerName).toBe('Silviu');
  });

  it('a save from before there was any audio object at all loads too', () => {
    store[KEY] = JSON.stringify({ units: 'mph' });
    expect(loadSettings().audio).toEqual(DEFAULT_SETTINGS.audio);
  });

  it('keeps a saved value, 0 (off) included', () => {
    for (const v of [0, 0.05, 0.3, 1]) {
      store[KEY] = JSON.stringify({ audio: { raceMusic: v } });
      expect(loadSettings().audio.raceMusic).toBe(v);
    }
  });

  it('replaces what is not a number with the default, and holds a number to 0..1', () => {
    for (const bad of ['loud', null, true, [0.3], { v: 1 }]) {
      store[KEY] = JSON.stringify({ audio: { raceMusic: bad, music: 0.3 } });
      const s = loadSettings();
      expect(s.audio.raceMusic, JSON.stringify(bad)).toBe(0.45);
      expect(s.audio.music).toBe(0.3);
    }
    store[KEY] = JSON.stringify({ audio: { raceMusic: 7, music: -2 } });
    const s = loadSettings();
    expect(s.audio.raceMusic).toBe(1);
    expect(s.audio.music).toBe(0);
  });

  it('is saved with the rest and read back', () => {
    store[KEY] = JSON.stringify({ ...structuredClone(DEFAULT_SETTINGS), audio: { ...DEFAULT_SETTINGS.audio, raceMusic: 0.8 } });
    expect(loadSettings().audio.raceMusic).toBe(0.8);
  });

  it('the defaults are not shared between loads', () => {
    const a = loadSettings();
    a.audio.raceMusic = 0.1;
    expect(loadSettings().audio.raceMusic).toBe(0.45);
    expect(DEFAULT_SETTINGS.audio.raceMusic).toBe(0.45);
  });
});

describe('Settings > Audio', () => {
  const audio = SETTINGS_TABS.find((t) => t.id === 'audio')!;

  it('has a Race music slider after the menu music, and the old Music slider is the Menu music', () => {
    const ids = audio.rows.map((r) => r.id);
    expect(ids).toEqual(['master', 'engine', 'effects', 'music', 'raceMusic', 'ui']);
    expect(audio.rows.find((r) => r.id === 'music')!.label).toBe('Menu music');
    expect(audio.rows.find((r) => r.id === 'raceMusic')!.label).toBe('Race music');
  });

  it('the Race music row is a 0..1 slider in steps of 5 % that reads and writes audio.raceMusic', () => {
    const row = audio.rows.find((r) => r.id === 'raceMusic')!;
    expect(row.kind).toBe('slider');
    if (row.kind !== 'slider') return;
    expect([row.min, row.max, row.step]).toEqual([0, 1, 0.05]);
    const s: Settings = structuredClone(DEFAULT_SETTINGS);
    expect(row.get(s)).toBe(0.45);
    expect(row.fmt?.(0.45)).toBe('45%');
    row.set(s, 0);
    expect(s.audio.raceMusic).toBe(0);
    expect(row.fmt?.(0)).toBe('0%');
    expect(s.audio.music).toBe(0.5); // (the other slider is not touched)
    expect(row.desc).toMatch(/0 turns it off/);
  });

  it('resetting the tab brings the race music back to its default too', () => {
    const s: Settings = structuredClone(DEFAULT_SETTINGS);
    s.audio.raceMusic = 0.9;
    s.audio.music = 0.1;
    audio.reset(s);
    expect(s.audio).toEqual(DEFAULT_SETTINGS.audio);
  });
});

describe('now playing card words', () => {
  const np: NowPlaying = { id: 'neon-overdrive', title: 'Neon Overdrive', genre: 'Cyberpunk', album: 'Vol. 1' };

  it('are the song, and "Genre · Xeno-Racer Vol. 1" under it', () => {
    expect(nowPlayingLines(np)).toEqual({ note: '♪', title: 'Neon Overdrive', sub: 'Cyberpunk · Xeno-Racer Vol. 1' });
  });

  it('leave out what is missing without a stray separator', () => {
    expect(nowPlayingLines({ ...np, album: '' }).sub).toBe('Cyberpunk · Xeno-Racer');
    expect(nowPlayingLines({ ...np, genre: '' }).sub).toBe('Xeno-Racer Vol. 1');
    expect(nowPlayingLines({ ...np, genre: '', album: ' ' }).sub).toBe('Xeno-Racer');
  });
});
