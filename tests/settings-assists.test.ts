/**
 * The aids of each human in the saved settings: player 2 has a set of their own (`assists2`, added the way `player2Name` was), a save
 * from before it existed still loads, and the aids of a seat reach the car of that seat.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { getCar } from '../src/cars';
import { applyAssistPreset, ASSIST_PRESETS, assistsOfSeat, carAssists, matchAssistPreset } from '../src/core/aids';
import type { PlayerAssists } from '../src/core/contracts';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../src/core/settings';
import { PhysicsWorld, createFlatTrack } from '../src/physics';
import { secondPlayerMatters, SETTINGS_TABS } from '../src/ui/model';
import { Quaternion, Vector3 } from 'three';

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

describe('the aids in the saved settings', () => {
  it('start as the standard aids for both players, with the driving line and the braking assist off', () => {
    for (const a of [DEFAULT_SETTINGS.assists, DEFAULT_SETTINGS.assists2]) {
      expect(matchAssistPreset(a)).toBe('standard');
      expect(a.line).toBe('off');
      expect(a.brakeAssist).toBe(false);
    }
    expect(loadSettings().assists2).toEqual(DEFAULT_SETTINGS.assists);
  });

  it('load from a save that has neither: the aids it had, the new ones off, and player 2 driving with what player 1 had', () => {
    // (a save from before the line, the braking assist and player 2's own aids: one set, which both humans drove with)
    store[KEY] = JSON.stringify({ assists: { abs: false, tcs: 'high', esc: false, autoShift: false, steeringAssist: 0.8, autoClutch: true }, units: 'mph' });
    const s = loadSettings();
    expect(s.units).toBe('mph');
    expect(s.assists).toEqual({ abs: false, tcs: 'high', esc: false, autoShift: false, steeringAssist: 0.8, autoClutch: true, line: 'off', brakeAssist: false });
    expect(s.assists2).toEqual(s.assists);
    expect(s.assists2).not.toBe(s.assists);
    // nothing saved of the aids at all: both are the defaults
    store[KEY] = JSON.stringify({ units: 'mph' });
    const d = loadSettings();
    expect(d.assists).toEqual(DEFAULT_SETTINGS.assists);
    expect(d.assists2).toEqual(DEFAULT_SETTINGS.assists2);
  });

  it('keep two sets apart once they are saved', () => {
    const s = loadSettings();
    applyAssistPreset(s.assists, 'pro');
    applyAssistPreset(s.assists2, 'beginner');
    saveSettings(s);
    const back = loadSettings();
    expect(matchAssistPreset(back.assists)).toBe('pro');
    expect(matchAssistPreset(back.assists2)).toBe('beginner');
    expect(back.assists2.line).toBe('full');
    expect(back.assists2.brakeAssist).toBe(true);
    expect(back.assists.line).toBe('off');
  });

  it('fall back to the default for a driving line this build does not know, in either set, and keep the rest', () => {
    store[KEY] = JSON.stringify({ assists: { line: 'laser', abs: false }, assists2: { line: 7, tcs: 'race', brakeAssist: true } });
    const s = loadSettings();
    expect(s.assists.line).toBe('off');
    expect(s.assists.abs).toBe(false);
    expect(s.assists2.line).toBe('off');
    expect(s.assists2.tcs).toBe(DEFAULT_SETTINGS.assists2.tcs);
    expect(s.assists2.brakeAssist).toBe(true);
    for (const word of ['off', 'braking', 'full'] as const) {
      store[KEY] = JSON.stringify({ assists: { line: word }, assists2: { line: word } });
      expect(loadSettings().assists.line).toBe(word);
      expect(loadSettings().assists2.line).toBe(word);
    }
  });

  it('keep the steering assist inside 0..1, and ignore flags that are not flags', () => {
    store[KEY] = JSON.stringify({ assists: { steeringAssist: 7, brakeAssist: 'yes' }, assists2: { steeringAssist: -3 } });
    const s = loadSettings();
    expect(s.assists.steeringAssist).toBe(1);
    expect(s.assists.brakeAssist).toBe(false);
    expect(s.assists2.steeringAssist).toBe(0);
  });
});

describe('the aids of each seat reach the car of that seat', () => {
  const pro: PlayerAssists = { ...ASSIST_PRESETS.pro, autoClutch: true };
  const beginner: PlayerAssists = { ...ASSIST_PRESETS.beginner };

  /** Two cars on a flat road side by side, each with the aids of its seat, as the game gives them (src/game/game.ts spawnCar and applySettings). */
  function twoCars(settings: { assists: PlayerAssists; assists2: PlayerAssists }) {
    const world = new PhysicsWorld(createFlatTrack());
    const def = getCar('vanta-gt');
    const cars = [world.addVehicle(def), world.addVehicle(def)];
    cars.forEach((c, seat) => {
      c.assists = carAssists(assistsOfSeat(settings, seat as 0 | 1));
      c.placeOnGround(new Vector3(seat === 0 ? -6 : 6, 0, 0), new Quaternion(), 0);
      c.setTemperatures(1);
    });
    return { world, cars };
  }

  it('give player 1 a manual gearbox and player 2 an automatic one', () => {
    const { world, cars } = twoCars({ assists: pro, assists2: beginner });
    expect(cars[0].assists.autoShift).toBe(false);
    expect(cars[1].assists.autoShift).toBe(true);
    for (let i = 0; i < 60 * 6; i++) {
      for (const c of cars) {
        c.controls.throttle = 1;
        c.controls.brake = 0;
      }
      world.step(1 / 60);
    }
    // the manual car stays in the gear it was in (nobody shifted it), the automatic one has gone up through the box
    expect(cars[0].state.gear).toBeLessThanOrEqual(1);
    expect(cars[1].state.gear).toBeGreaterThanOrEqual(3);
    expect(cars[1].state.speed).toBeGreaterThan(cars[0].state.speed);
  });

  it('give the aids the other way round when the settings are the other way round', () => {
    const { cars } = twoCars({ assists: beginner, assists2: pro });
    expect(cars[0].assists.autoShift).toBe(true);
    expect(cars[0].assists.tcs).toBe('high');
    expect(cars[1].assists.autoShift).toBe(false);
    expect(cars[1].assists.tcs).toBe('off');
    expect(cars[1].assists.abs).toBe(false);
  });

  it('give ABS to the seat that has it: its wheels do not lock under full brakes at speed, the other seat\'s do', () => {
    const { world, cars } = twoCars({ assists: pro, assists2: beginner });
    for (const c of cars) c.placeOnGround(c.p.clone(), new Quaternion(), 45);
    let abs0 = false;
    let abs1 = false;
    // (the share of the stop a wheel spent locked: turning at less than 15 % of the road speed)
    let frames = 0;
    let locked0 = 0;
    let locked1 = 0;
    const lockedNow = (c: (typeof cars)[number]): boolean => Math.min(...c.state.wheels.map((w) => w.omega * w.radius)) < 0.15 * c.state.speed;
    for (let i = 0; i < 60 * 2; i++) {
      for (const c of cars) {
        c.controls.throttle = 0;
        c.controls.brake = 1;
      }
      world.step(1 / 60);
      abs0 ||= cars[0].state.absActive;
      abs1 ||= cars[1].state.absActive;
      if (cars[0].state.speed > 12 && cars[1].state.speed > 12) {
        frames++;
        if (lockedNow(cars[0])) locked0++;
        if (lockedNow(cars[1])) locked1++;
      }
    }
    expect(abs0).toBe(false);
    expect(abs1).toBe(true);
    // (without ABS a wheel stops turning while the car still rolls: it is locked for most of the stop; with it, the wheels dip now and then as ABS pulses)
    expect(frames).toBeGreaterThan(30);
    expect(locked0 / frames).toBeGreaterThan(0.7);
    expect(locked1 / frames).toBeLessThan(0.35);
  });

  it('are what the Assists tab of each seat reads and writes', () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    const tab1 = SETTINGS_TABS.find((t) => t.id === 'assists')!;
    const tab2 = SETTINGS_TABS.find((t) => t.id === 'assists2')!;
    const row = (tab: typeof tab1, id: string) => tab.rows.find((r) => r.id === id)!;
    const line = row(tab2, 'line');
    if (line.kind !== 'select') throw new Error('the driving line is a select');
    line.set(s, 'full');
    expect(s.assists2.line).toBe('full');
    expect(s.assists.line).toBe('off');
    const ba = row(tab1, 'brakeAssist');
    if (ba.kind !== 'toggle') throw new Error('the braking assist is a toggle');
    ba.set(s, true);
    expect(s.assists.brakeAssist).toBe(true);
    expect(s.assists2.brakeAssist).toBe(false);
    const gear = row(tab2, 'autoShift');
    if (gear.kind !== 'toggle') throw new Error('the gearbox is a toggle');
    gear.set(s, false);
    expect(s.assists2.autoShift).toBe(false);
    expect(s.assists.autoShift).toBe(true);
    // the preset row of a seat puts the preset on that seat only, and says Custom after a change by hand
    const preset = row(tab1, 'preset');
    if (preset.kind !== 'select') throw new Error('the preset is a select');
    preset.set(s, 'beginner');
    expect(matchAssistPreset(s.assists)).toBe('beginner');
    expect(s.assists2.autoShift).toBe(false);
    expect(preset.get(s)).toBe('beginner');
    s.assists.abs = false;
    expect(preset.display?.(s)).toBe('Custom');
    // each tab resets its own seat
    tab2.reset(s);
    expect(s.assists2).toEqual(DEFAULT_SETTINGS.assists2);
    expect(s.assists.abs).toBe(false);
  });
});

describe('player 2\'s Assists tab', () => {
  const none = { devices: [null, null] as [string | null, string | null], pads: 0, joined: false, owner: null, missing: null };

  it('is there only while a second player matters: joined, two controllers plugged in, or a split screen on', () => {
    expect(secondPlayerMatters({ ...none, pads: 1 }, null)).toBe(false);
    expect(secondPlayerMatters(none, null)).toBe(false);
    expect(secondPlayerMatters({ ...none, joined: true }, null)).toBe(true);
    expect(secondPlayerMatters({ ...none, pads: 2 }, null)).toBe(true);
    expect(secondPlayerMatters({ ...none, pads: 1 }, 'rows')).toBe(true);
  });

  it('has the same rows as player 1\'s, and a name that says whose it is', () => {
    const t1 = SETTINGS_TABS.find((t) => t.id === 'assists')!;
    const t2 = SETTINGS_TABS.find((t) => t.id === 'assists2')!;
    expect(t2.split).toBe(true);
    expect(t1.split).toBeUndefined();
    expect(t2.rows.map((r) => r.id)).toEqual(t1.rows.map((r) => r.id));
    expect(t2.rows.map((r) => r.id)).toEqual(['preset', 'abs', 'tcs', 'esc', 'autoShift', 'steeringAssist', 'autoClutch', 'line', 'brakeAssist']);
    expect(t2.label).toContain('P2');
    // every row says what it does, in a sentence or two
    for (const r of t2.rows) {
      expect(r.desc.length).toBeGreaterThan(20);
      expect(r.desc.endsWith('.')).toBe(true);
    }
  });
});
