/**
 * The menus of split screen (src/ui/model.ts): what the setup wizard turns into with two players, the join card's words, the
 * head-to-head of the results and the lines of the pause menu. Pure logic: the DOM screens that draw it are checked by eye.
 */
import { describe, expect, it } from 'vitest';
import type { PlayersInfo, SplitDuel, TrackInfo } from '../src/core/contracts';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { MAX_SPLIT_OPPONENTS } from '../src/core/split';
import { CARS } from '../src/cars';
import {
  buildRaceConfig,
  contrastLivery,
  defaultSetup,
  duelMargin,
  duelSummary,
  duelTitle,
  joinView,
  lapRows,
  LIVERY_PRESETS,
  missingPadLine,
  opponentsMax,
  parseDuelGap,
  pauseOwnerLine,
  playersNow,
  possessive,
  seatName,
  SETTINGS_TABS,
  SETUP_STEPS,
  setupStepLabel,
  setupSteps,
  SPLIT_BLURB,
  SPLIT_SETUP_STEPS,
  splitAllowed,
  stepSeat,
} from '../src/ui/model';

const TRACKS: TrackInfo[] = [
  { id: 'a', name: 'Alpha', location: 'Here', description: '', difficulty: 2, defaultLaps: 5, defaultTimeOfDay: 'golden', lengthHint: 5000, color: '#fff' },
  { id: 'b', name: 'Beta', location: 'There', description: '', difficulty: 4, defaultLaps: 3, defaultTimeOfDay: 'night', lengthHint: 3000, color: '#f0f' },
];

const info = (over: Partial<PlayersInfo> = {}): PlayersInfo => ({ devices: ['Logitech Gamepad F310', null], pads: 1, joined: false, owner: null, missing: null, ...over });

describe('two players in the setup', () => {
  it('only a race and free roam can have a second player', () => {
    expect(splitAllowed('race')).toBe(true);
    expect(splitAllowed('freeRoam')).toBe(true);
    expect(splitAllowed('timeTrial')).toBe(false);
    expect(splitAllowed('championship')).toBe(false);
  });

  it('opens with one player unless asked for two, and a time trial or a championship stays at one', () => {
    expect(defaultSetup('race', TRACKS, CARS).players).toBe(1);
    expect(defaultSetup('race', TRACKS, CARS, { players: 2 }).players).toBe(2);
    expect(defaultSetup('freeRoam', TRACKS, CARS, { players: 2 }).players).toBe(2);
    expect(defaultSetup('timeTrial', TRACKS, CARS, { players: 2 }).players).toBe(1);
    expect(defaultSetup('championship', TRACKS, CARS, { players: 2 }).players).toBe(1);
    // the count asked for sticks to the state it came from, but a mode that cannot have two forces one
    const split = defaultSetup('race', TRACKS, CARS, { players: 2 });
    expect(playersNow(split)).toBe(2);
    expect(playersNow({ ...split, mode: 'timeTrial' })).toBe(1);
  });

  it('carries a one-player setup\'s opponents over to two players no higher than a grid of two humans has room for', () => {
    // a one-player race with the full eleven opponents, then the Split screen entry of the main menu
    expect(defaultSetup('race', TRACKS, CARS, { opponents: 11 }).opponents).toBe(11);
    const two = defaultSetup('race', TRACKS, CARS, { opponents: 11, players: 2 });
    expect(two.opponents).toBe(MAX_SPLIT_OPPONENTS);
    expect(two.opponents).toBe(opponentsMax(two));
    expect(defaultSetup('freeRoam', TRACKS, CARS, { opponents: 11, players: 2 }).opponents).toBe(0);
    // fewer than the limit stay as they were
    expect(defaultSetup('race', TRACKS, CARS, { opponents: 4, players: 2 }).opponents).toBe(4);
  });

  it('the second player drives the next car along, in a livery that contrasts with the first', () => {
    const s = defaultSetup('race', TRACKS, CARS);
    expect(s.car2Index).toBe(1 % CARS.length);
    const last = defaultSetup('race', TRACKS, CARS, { carIndex: CARS.length - 1 });
    expect(last.car2Index).toBe(0); // wraps
    const factory = LIVERY_PRESETS.findIndex((p) => p.id === 'factory');
    const pink = LIVERY_PRESETS.findIndex((p) => p.id === 'pink');
    const teal = LIVERY_PRESETS.findIndex((p) => p.id === 'teal');
    expect(contrastLivery(factory)).toBe(pink);
    expect(contrastLivery(pink)).toBe(teal);
    expect(contrastLivery(teal)).toBe(pink);
    expect(s.liveryIndex2).toBe(pink);
    // what they picked is kept when the setup is opened again
    const again = defaultSetup('race', TRACKS, CARS, { ...s, car2Index: 3, liveryIndex2: 7 });
    expect(again.car2Index).toBe(3);
    expect(again.liveryIndex2).toBe(7);
    // and never points off the end of the roster
    expect(defaultSetup('race', TRACKS, CARS, { car2Index: 99 }).car2Index).toBe(CARS.length - 1);
  });

  it('two players add the second player\'s car as a fourth step; one player and a championship keep three', () => {
    expect(setupSteps(defaultSetup('race', TRACKS, CARS))).toEqual(SETUP_STEPS);
    expect(setupSteps(defaultSetup('race', TRACKS, CARS, { players: 2 }))).toEqual(['track', 'car', 'car2', 'race']);
    expect(SPLIT_SETUP_STEPS).toEqual(['track', 'car', 'car2', 'race']);
    expect(setupSteps({ mode: 'championship', players: 2 })).toEqual(SETUP_STEPS);
    expect(setupSteps({ mode: 'timeTrial', players: 2 })).toEqual(SETUP_STEPS);
  });

  it('labels the steps for one player and for two, and knows whose car a step picks', () => {
    expect(['track', 'car', 'race'].map((s) => setupStepLabel(s as 'track', 1))).toEqual(['Track', 'Car', 'Race']);
    expect(SPLIT_SETUP_STEPS.map((s) => setupStepLabel(s, 2))).toEqual(['Track', 'P1 car', 'P2 car', 'Race']);
    expect(SPLIT_SETUP_STEPS.map(stepSeat)).toEqual([0, 0, 1, 0]);
  });

  it('names the drivers: the settings\' own, never empty', () => {
    expect(seatName(DEFAULT_SETTINGS, 0)).toBe('Gabriel');
    expect(seatName(DEFAULT_SETTINGS, 1)).toBe('Player 2');
    expect(seatName({ playerName: '  ', player2Name: '' }, 0)).toBe('You');
    expect(seatName({ playerName: 'A', player2Name: '  Silviu ' }, 1)).toBe('Silviu');
  });
});

describe('the race config of two players', () => {
  const two = (over = {}) => ({ ...defaultSetup('race', TRACKS, CARS, { players: 2 }), ...over });

  it('one player: no second player in the config, as ever', () => {
    const c = buildRaceConfig(defaultSetup('race', TRACKS, CARS), TRACKS, CARS, 'Gabriel');
    expect('player2' in c).toBe(false);
    expect(c.livery).toMatchObject({ driver: 'Gabriel' });
  });

  it('two players: the second one\'s car and name ride along', () => {
    const s = two({ carIndex: 0, car2Index: 2, liveryIndex2: LIVERY_PRESETS.findIndex((p) => p.id === 'pink') });
    const c = buildRaceConfig(s, TRACKS, CARS, 'Gabriel', 7, 'Silviu');
    expect(c.mode).toBe('race');
    expect(c.carId).toBe(CARS[0].id);
    expect(c.player2?.carId).toBe(CARS[2].id);
    expect(c.player2?.livery).toMatchObject({ primary: LIVERY_PRESETS.find((p) => p.id === 'pink')!.livery!.primary, driver: 'Silviu' });
    expect(c.livery).toMatchObject({ driver: 'Gabriel' });
  });

  it('a blank second name is "Player 2"', () => {
    expect(buildRaceConfig(two(), TRACKS, CARS, 'Gabriel', 7).player2?.livery?.driver).toBe('Player 2');
    expect(buildRaceConfig(two(), TRACKS, CARS, 'Gabriel', 7, '   ').player2?.livery?.driver).toBe('Player 2');
  });

  it('the grid has room for ten opponents beside two players, eleven beside one', () => {
    expect(opponentsMax(two())).toBe(MAX_SPLIT_OPPONENTS);
    expect(opponentsMax(defaultSetup('race', TRACKS, CARS))).toBe(11);
    expect(buildRaceConfig(two({ opponents: 11 }), TRACKS, CARS, 'X').opponents).toBe(10);
    expect(buildRaceConfig(two({ opponents: 99 }), TRACKS, CARS, 'X').opponents).toBe(10);
    expect(buildRaceConfig(two({ opponents: 4 }), TRACKS, CARS, 'X').opponents).toBe(4);
    expect(buildRaceConfig({ ...defaultSetup('race', TRACKS, CARS), opponents: 11 }, TRACKS, CARS, 'X').opponents).toBe(11);
  });

  it('free roam can have two players (and no opponents); a time trial and a championship cannot', () => {
    const fr = buildRaceConfig({ ...defaultSetup('freeRoam', TRACKS, CARS, { players: 2 }), opponents: 5 }, TRACKS, CARS, 'X', 7, 'Y');
    expect(fr).toMatchObject({ mode: 'freeRoam', opponents: 0, startPosition: 'pole' });
    expect(fr.player2?.livery?.driver).toBe('Y');
    const tt = buildRaceConfig({ ...defaultSetup('timeTrial', TRACKS, CARS), players: 2 }, TRACKS, CARS, 'X', 7, 'Y');
    expect('player2' in tt).toBe(false);
    const ch = buildRaceConfig({ ...defaultSetup('championship', TRACKS, CARS), players: 2 }, TRACKS, CARS, 'X', 7, 'Y');
    expect('player2' in ch).toBe(false);
  });

  it('has a line for the main menu', () => {
    expect(SPLIT_BLURB.length).toBeGreaterThan(20);
  });
});

describe('the join card', () => {
  const names: [string, string] = ['Gabriel', 'Silviu'];

  it('waits for a button on a second controller, and offers the keyboard', () => {
    const v = joinView(info(), names);
    expect(v.joined).toBe(false);
    expect(v.heading).toBe('Player 2, press A to join');
    expect(v.sub).toBe('on a second controller');
    expect(v.keyboard).toMatch(/Enter/);
    expect(v.pads).toBe('1 controller connected');
    expect(v.canSwap).toBe(false);
    expect(v.slots.map((s) => s.device)).toEqual(['Logitech Gamepad F310', null]);
    expect(v.slots.map((s) => s.name)).toEqual(['Gabriel', 'Silviu']);
    expect(v.slots.map((s) => s.title)).toEqual(['Player 1', 'Player 2']);
    expect(v.slots[0].color).not.toBe(v.slots[1].color);
  });

  it('with the keyboard as player 1, the way in is a controller; there is no keyboard hint', () => {
    const none = joinView(info({ devices: ['Keyboard', null], pads: 0 }), names);
    expect(none.keyboard).toBeNull();
    expect(none.sub).toMatch(/controller/);
    expect(none.pads).toBe('No controller connected');
    expect(joinView(info({ devices: ['Keyboard', null], pads: 1 }), names).sub).toBe('on a controller');
  });

  it('knows when a second controller is already there', () => {
    expect(joinView(info({ pads: 2 }), names).sub).toBe('on the controller for player 2');
    expect(joinView(info({ pads: 2 }), names).pads).toBe('2 controllers connected');
  });

  it('once the second player is in: who is on what, and the swap is possible', () => {
    const v = joinView(info({ devices: ['Logitech Gamepad F310', 'Keyboard'], joined: true }), names);
    expect(v.joined).toBe(true);
    expect(v.heading).toBe('Silviu is in');
    expect(v.sub).toBe('on Keyboard');
    expect(v.keyboard).toBeNull();
    expect(v.canSwap).toBe(true);
    expect(v.slots.map((s) => s.device)).toEqual(['Logitech Gamepad F310', 'Keyboard']);
    // "joined" without a device is not joined
    expect(joinView(info({ joined: true }), names).joined).toBe(false);
  });
});

describe('the head to head', () => {
  const duel = (over: Partial<SplitDuel> = {}): SplitDuel => ({
    names: ['Gabriel', 'Silviu'],
    winner: 0,
    gap: '+3.241',
    positions: [3, 5],
    lapTimes: [[93.1, 92.4, 92.9], [94.2, 93.8, 93.5]],
    bestLap: [92.4, 93.5],
    personalBest: [true, false],
    carIds: ['vanta-gt', 'kestrel-r'],
    ...over,
  });

  it('reads the gap as seconds or laps', () => {
    expect(parseDuelGap('+3.241')).toEqual({ kind: 'time', seconds: 3.241 });
    expect(parseDuelGap('3.241')).toEqual({ kind: 'time', seconds: 3.241 });
    expect(parseDuelGap('+1 LAP')).toEqual({ kind: 'laps', laps: 1 });
    expect(parseDuelGap('+2 LAPS')).toEqual({ kind: 'laps', laps: 2 });
    expect(parseDuelGap('+1L')).toEqual({ kind: 'laps', laps: 1 });
    expect(parseDuelGap('')).toEqual({ kind: 'none' });
    expect(parseDuelGap('DNF')).toEqual({ kind: 'none' });
  });

  it('says who won and by how much', () => {
    expect(duelTitle(duel())).toBe('Gabriel wins');
    expect(duelTitle(duel({ winner: 1 }))).toBe('Silviu wins');
    expect(duelMargin(duel())).toBe('by 3.241 s');
    expect(duelMargin(duel({ gap: '+1 LAP' }))).toBe('by 1 lap');
    expect(duelMargin(duel({ gap: '+3 LAPS' }))).toBe('by 3 laps');
    expect(duelMargin(duel({ gap: '' }))).toBe('');
    expect(duelSummary(duel())).toBe('Gabriel beat Silviu by 3.241 s');
    expect(duelSummary(duel({ winner: 1, gap: '+0.050' }))).toBe('Silviu beat Gabriel by 0.050 s');
    expect(duelSummary(duel({ gap: '+1 LAP' }))).toBe('Gabriel beat Silviu by 1 lap');
  });

  it('a player who did not finish is said so, and a tie or no finisher has no winner', () => {
    expect(duelSummary(duel({ gap: '' }))).toBe('Silviu did not finish');
    expect(duelSummary(duel({ winner: 1, gap: '' }))).toBe('Gabriel did not finish');
    expect(duelTitle(duel({ winner: null, gap: '+0.000' }))).toBe('Dead heat');
    expect(duelSummary(duel({ winner: null, gap: '+0.000' }))).toBe('Dead heat');
    expect(duelTitle(duel({ winner: null, gap: '' }))).toBe('No winner');
    expect(duelSummary(duel({ winner: null, gap: '' }))).toBe('Neither player finished');
  });

  it('lists the laps of a player, the best one tagged and the rest as the gap to it', () => {
    const { rows, hidden } = lapRows([93.1, 92.4, 92.9], false, 8);
    expect(hidden).toBe(0);
    expect(rows.map((r) => r.lap)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.best)).toEqual([false, true, false]);
    expect(rows.map((r) => r.tag)).toEqual(['+0.700', 'BEST', '+0.500']);
    expect(lapRows([93.1, 92.4], true, 8).rows[1].tag).toBe('PB');
    expect(lapRows([], true, 8)).toEqual({ rows: [], hidden: 0 });
  });

  it('shows the last laps when there are too many, and counts the ones it left out', () => {
    const times = Array.from({ length: 12 }, (_, i) => 100 - i * 0.1);
    const { rows, hidden } = lapRows(times, false, 8);
    expect(hidden).toBe(4);
    expect(rows.length).toBe(8);
    expect(rows[0].lap).toBe(5);
    expect(rows[rows.length - 1].lap).toBe(12);
    expect(rows[rows.length - 1].best).toBe(true);
  });
});

describe('the pause menu of two players', () => {
  const names: [string, string] = ['Gabriel', 'Silviu'];

  it('says whose pad the menu follows', () => {
    expect(pauseOwnerLine(info(), names)).toBeNull();
    expect(pauseOwnerLine(info({ owner: 0 }), names)).toBe('Paused by Gabriel');
    expect(pauseOwnerLine(info({ owner: 1 }), names)).toBe('Paused by Silviu');
  });

  it('says whose controller came out', () => {
    expect(missingPadLine(info(), names)).toBeNull();
    expect(missingPadLine(info({ missing: 1 }), names)).toBe("Silviu's controller was disconnected. Plug it in and press A.");
    expect(missingPadLine(info({ missing: 0 }), ['James', 'Ana'])).toBe("James' controller was disconnected. Plug it in and press A.");
  });

  it('writes a name as a possessive', () => {
    expect(possessive('Silviu')).toBe("Silviu's");
    expect(possessive('Chris')).toBe("Chris'");
  });
});

describe('the split-screen settings', () => {
  const gameplay = SETTINGS_TABS.find((t) => t.id === 'gameplay')!;
  const row = (id: string) => gameplay.rows.find((r) => r.id === id)!;

  it('has a row for the second driver\'s name, right after the first\'s, and for the layout', () => {
    const ids = gameplay.rows.map((r) => r.id);
    expect(ids.indexOf('player2Name')).toBe(ids.indexOf('playerName') + 1);
    expect(ids).toContain('splitLayout');
    const name = row('player2Name');
    expect(name.kind).toBe('text');
    if (name.kind === 'text') {
      expect(name.maxLength).toBe(16);
      const s = structuredClone(DEFAULT_SETTINGS);
      expect(name.get(s)).toBe('Player 2');
      name.set(s, 'Silviu');
      expect(s.player2Name).toBe('Silviu');
    }
  });

  it('offers the two layouts, top and bottom first, and writes the choice', () => {
    const layout = row('splitLayout');
    expect(layout.kind).toBe('select');
    if (layout.kind !== 'select') return;
    expect(layout.options.map((o) => o.value)).toEqual(['rows', 'columns']);
    expect(layout.options.map((o) => o.label)).toEqual(['Top and bottom', 'Side by side']);
    const s = structuredClone(DEFAULT_SETTINGS);
    expect(layout.get(s)).toBe('rows');
    layout.set(s, 'columns');
    expect(s.split.layout).toBe('columns');
  });

  it('the gameplay tab resets both', () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.player2Name = 'Silviu';
    s.split.layout = 'columns';
    gameplay.reset(s);
    expect(s.player2Name).toBe(DEFAULT_SETTINGS.player2Name);
    expect(s.split).toEqual(DEFAULT_SETTINGS.split);
    expect(s).toEqual(DEFAULT_SETTINGS);
  });
});
