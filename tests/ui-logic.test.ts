import { describe, expect, it } from 'vitest';
import {
  applyTrackDefaults,
  bestKey,
  bestLapFor,
  buildRaceConfig,
  carStatBars,
  defaultSetup,
  gripScore,
  LIVERY_PRESETS,
  liveryFor,
  matchQuality,
  MODE_INFO,
  SETTINGS_TABS,
} from '../src/ui/model';
import {
  formatDelta,
  formatLapTime,
  formatLength,
  formatRaceTime,
  gearLabel,
  ordinal,
  speedUnitLabel,
  speedValue,
} from '../src/ui/format';
import {
  deltaBar,
  deltaClass,
  fitBounds,
  isLimiter,
  lightsView,
  makeLut,
  mapX,
  mapY,
  revScaleMax,
  RingBuf,
  sectorState,
  selectTowerRows,
  shiftLedColor,
  shiftLedCount,
  slipColor,
  tempColor,
  TrailBuf,
  type MapFit,
} from '../src/ui/hudlogic';
import { DamageShow, damageWord } from '../src/ui/hud/damage';
import { FocusList, snap, stepIndex, type FocusRow, type Nav } from '../src/ui/nav';
import { buildChampionshipSetup, CHAMP_DEFAULTS, CHAMP_OPPONENTS_MIN, championshipHint, modeLabel, OPPONENTS_MAX } from '../src/ui/model';
import { formatConditions, formatPointsGap, lapsLabel, leadText, seasonTitle, trackCode } from '../src/ui/format';
import { buildView, championshipDef, createChampionship, recordRound } from '../src/game/championship';
import { autoCase, keyAtColumn } from '../src/ui/osk';
import { CARS } from '../src/cars';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/settings';
import type { HudStanding, Settings, TrackInfo } from '../src/core/contracts';

const TRACKS: TrackInfo[] = [
  { id: 'a', name: 'Alpha', location: 'Here', description: '', difficulty: 2, defaultLaps: 5, defaultTimeOfDay: 'golden', lengthHint: 5000, color: '#fff' },
  { id: 'b', name: 'Beta', location: 'There', description: '', difficulty: 4, defaultLaps: 3, defaultTimeOfDay: 'night', lengthHint: 3000, color: '#f0f' },
];

// ─────────────────────────────────────────────────────────────────────────────
describe('format', () => {
  it('formatLapTime is fixed width m:ss.mmm and handles missing values', () => {
    expect(formatLapTime(92.481)).toBe('1:32.481');
    expect(formatLapTime(0)).toBe('0:00.000');
    expect(formatLapTime(59.9996)).toBe('1:00.000'); // rounds up across the minute
    expect(formatLapTime(600.5)).toBe('10:00.500');
    expect(formatLapTime(null)).toBe('-:--.---');
    expect(formatLapTime(undefined)).toBe('-:--.---');
    expect(formatLapTime(NaN)).toBe('-:--.---');
    expect(formatLapTime(-3)).toBe('-:--.---');
  });
  it('formatRaceTime switches to h:mm:ss past an hour', () => {
    expect(formatRaceTime(723.456)).toBe('12:03.456');
    expect(formatRaceTime(124.144)).toBe('2:04.144');
    expect(formatRaceTime(3723.456)).toBe('1:02:03.456');
    expect(formatRaceTime(null)).toBe('--:--.---');
  });
  it('formatDelta carries the sign, never "-0.000", and clamps', () => {
    expect(formatDelta(0.482)).toBe('+0.482');
    expect(formatDelta(-1.117)).toBe('-1.117');
    expect(formatDelta(-0.0001)).toBe('+0.000');
    expect(formatDelta(0)).toBe('+0.000');
    expect(formatDelta(123.4)).toBe('+99.999');
    expect(formatDelta(null)).toBe('-.---');
  });
  it('converts speed and length', () => {
    expect(speedValue(100, 'kmh')).toBe(360);
    expect(speedValue(100, 'mph')).toBe(224);
    expect(speedValue(-5, 'kmh')).toBe(0);
    expect(speedUnitLabel('kmh')).toBe('KM/H');
    expect(speedUnitLabel('mph')).toBe('MPH');
    expect(formatLength(5210, 'kmh')).toBe('5.21 km');
    expect(formatLength(5210, 'mph')).toBe('3.24 mi');
  });
  it('ordinals and gear labels', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
    expect([-1, 0, 1, 7].map(gearLabel)).toEqual(['R', 'N', '1', '7']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('hud logic', () => {
  it('revScaleMax puts the limiter inside the scale', () => {
    expect(revScaleMax(8000)).toBe(9000);
    expect(revScaleMax(9500)).toBe(10000);
    expect(revScaleMax(7000)).toBe(8000);
    expect(revScaleMax(0)).toBe(2000);
  });
  it('isLimiter triggers just below the limiter rpm', () => {
    expect(isLimiter(8000, 8000)).toBe(true);
    expect(isLimiter(7950, 8000)).toBe(true);
    expect(isLimiter(7800, 8000)).toBe(false);
    expect(isLimiter(5000, 0)).toBe(false);
  });
  it('shift LEDs light progressively and colour green, amber, red', () => {
    expect(shiftLedCount(0)).toBe(0);
    expect(shiftLedCount(0.01)).toBe(1);
    expect(shiftLedCount(0.5)).toBe(5);
    expect(shiftLedCount(1)).toBe(9);
    expect(shiftLedCount(2)).toBe(9);
    expect(shiftLedCount(-1)).toBe(0);
    expect([0, 2, 3, 5, 6, 8].map(shiftLedColor)).toEqual(['#2ee57d', '#2ee57d', '#ffb020', '#ffb020', '#ff3b57', '#ff3b57']);
  });
  it('delta colouring: negative is good, positive is bad, null is none', () => {
    expect(deltaClass(-0.3)).toBe('good');
    expect(deltaClass(0.3)).toBe('bad');
    expect(deltaClass(0)).toBe('even');
    expect(deltaClass(null)).toBe('none');
    expect(deltaBar(-0.5)).toBe(-0.5);
    expect(deltaBar(3)).toBe(1);
    expect(deltaBar(null)).toBe(0);
  });
  it('sector cells: current pulses, passed ones are coloured vs best, future are pending', () => {
    const d = [-0.12, null, null];
    expect(sectorState(0, 1, d)).toBe('good');
    expect(sectorState(1, 1, d)).toBe('active');
    expect(sectorState(2, 1, d)).toBe('pending');
    expect(sectorState(0, 2, [0.4, -0.1, null])).toBe('bad');
    expect(sectorState(1, 2, [0.4, -0.1, null])).toBe('good');
    expect(sectorState(0, 1, [null, null, null])).toBe('set');
    expect(sectorState(0, 1, [0, null, null])).toBe('even');
  });
  it('start lights follow the countdown contract', () => {
    expect(lightsView(null)).toEqual({ visible: false, lit: 0, go: false });
    expect(lightsView(0)).toEqual({ visible: true, lit: 0, go: false });
    expect(lightsView(3)).toEqual({ visible: true, lit: 3, go: false });
    expect(lightsView(5)).toEqual({ visible: true, lit: 5, go: false });
    expect(lightsView(6)).toEqual({ visible: true, lit: 0, go: true });
  });
  it('colour LUTs return a colour at both ends and clamp', () => {
    const lut = makeLut([[0, '#000000'], [1, '#ffffff']], 8);
    expect(lut).toHaveLength(8);
    expect(lut[0]).toBe('rgb(0,0,0)');
    expect(lut[7]).toBe('rgb(255,255,255)');
    expect(slipColor(-5)).toBe(slipColor(0));
    expect(slipColor(9)).toBe(slipColor(1));
    expect(tempColor(20)).not.toBe(tempColor(140));
    expect(tempColor(-50)).toBe(tempColor(20));
  });
});

describe('standings tower', () => {
  const mk = (n: number, player: number): HudStanding[] =>
    Array.from({ length: n }, (_, i) => ({ position: i + 1, name: 'D' + (i + 1), gap: i === 0 ? 'LEADER' : '+' + i, isPlayer: i === player, color: '#fff' }));

  it('shows everyone when the field is small', () => {
    const rows = selectTowerRows(mk(6, 3), 8);
    expect(rows.map((r) => r.standing.position)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.every((r) => !r.gapBefore)).toBe(true);
  });
  it('shows leader + a window around the player, with a separator when rows are skipped', () => {
    const rows = selectTowerRows(mk(12, 8), 8);
    expect(rows).toHaveLength(8);
    expect(rows[0].standing.position).toBe(1);
    expect(rows.some((r) => r.standing.isPlayer)).toBe(true);
    expect(rows[1].gapBefore).toBe(true);
    const pos = rows.map((r) => r.standing.position);
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
    expect(new Set(pos).size).toBe(pos.length);
  });
  it('has no separator when the window touches the leader', () => {
    const rows = selectTowerRows(mk(12, 2), 8);
    expect(rows.map((r) => r.standing.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rows.every((r) => !r.gapBefore)).toBe(true);
  });
  it('keeps the last place visible and never over-runs the end', () => {
    const rows = selectTowerRows(mk(12, 11), 8);
    expect(rows.map((r) => r.standing.position)).toEqual([1, 6, 7, 8, 9, 10, 11, 12]);
    expect(rows[1].gapBefore).toBe(true);
  });
  it('falls back to the top of the order when the player is not listed', () => {
    const rows = selectTowerRows(mk(12, -1), 8);
    expect(rows.map((r) => r.standing.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(selectTowerRows([], 8)).toEqual([]);
  });
});

describe('minimap fit', () => {
  it('fits uniformly, centers, and keeps +X right / +Z down', () => {
    const f: MapFit = { scale: 0, ox: 0, oy: 0, minX: 0, minZ: 0 };
    fitBounds({ minX: -100, maxX: 100, minZ: 0, maxZ: 50 }, 300, 200, 10, f);
    expect(f.scale).toBeCloseTo(1.4, 10); // limited by width: (300-20)/200
    expect(mapX(f, -100)).toBeCloseTo(10, 10);
    expect(mapX(f, 100)).toBeCloseTo(290, 10);
    expect(mapY(f, 0)).toBeCloseTo((200 - 50 * 1.4) / 2, 10);
    expect(mapY(f, 50)).toBeGreaterThan(mapY(f, 0));
  });
  it('survives a degenerate box', () => {
    const f: MapFit = { scale: 0, ox: 0, oy: 0, minX: 0, minZ: 0 };
    fitBounds({ minX: 5, maxX: 5, minZ: 5, maxZ: 5 }, 100, 100, 10, f);
    expect(Number.isFinite(f.scale)).toBe(true);
  });
});

describe('ring buffers', () => {
  it('RingBuf keeps the newest samples in order', () => {
    const r = new RingBuf(4);
    for (let i = 1; i <= 6; i++) r.push(i);
    expect(r.count).toBe(4);
    expect([0, 1, 2, 3].map((i) => r.at(i))).toEqual([3, 4, 5, 6]);
    r.clear();
    expect(r.count).toBe(0);
  });
  it('TrailBuf keeps the newest points in order', () => {
    const t = new TrailBuf(3);
    for (let i = 1; i <= 5; i++) t.push(i, -i);
    expect(t.count).toBe(3);
    expect([0, 1, 2].map((i) => t.x(i))).toEqual([3, 4, 5]);
    expect([0, 1, 2].map((i) => t.y(i))).toEqual([-3, -4, -5]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('car stats', () => {
  it('has a bar for every stat, all within 0..1', () => {
    for (const car of CARS) {
      const bars = carStatBars(car, 'kmh');
      expect(bars.map((b) => b.id)).toEqual(['power', 'weight', 'grip', 'top', 'accel']);
      for (const b of bars) {
        expect(b.value).toBeGreaterThanOrEqual(0);
        expect(b.value).toBeLessThanOrEqual(1);
        expect(b.text.length).toBeGreaterThan(0);
      }
    }
  });
  it('bars are monotonic in the underlying spec (so a better car never gets a shorter bar)', () => {
    const rows = CARS.map((c) => ({ c, bars: carStatBars(c, 'kmh') }));
    const bar = (r: (typeof rows)[number], id: string): number => r.bars.find((b) => b.id === id)!.value;
    for (const a of rows) {
      for (const b of rows) {
        if (a.c.stats.powerHp > b.c.stats.powerHp) expect(bar(a, 'power')).toBeGreaterThanOrEqual(bar(b, 'power'));
        if (a.c.stats.massKg > b.c.stats.massKg) expect(bar(a, 'weight')).toBeGreaterThanOrEqual(bar(b, 'weight'));
        if (a.c.stats.topSpeedKmh > b.c.stats.topSpeedKmh) expect(bar(a, 'top')).toBeGreaterThanOrEqual(bar(b, 'top'));
        if (a.c.stats.zeroTo100 < b.c.stats.zeroTo100) expect(bar(a, 'accel')).toBeGreaterThanOrEqual(bar(b, 'accel'));
      }
    }
  });
  it('grip rises with tire friction and with downforce', () => {
    const base = structuredClone(CARS[0]);
    const grippier = structuredClone(CARS[0]);
    grippier.physics.tireFront.mu = base.physics.tireFront.mu + 0.3;
    expect(gripScore(grippier)).toBeGreaterThan(gripScore(base));
    const winged = structuredClone(CARS[0]);
    winged.physics.aero.liftAreaRear = base.physics.aero.liftAreaRear + 2;
    expect(gripScore(winged)).toBeGreaterThan(gripScore(base));
    expect(gripScore(base)).toBeGreaterThan(0);
    expect(gripScore(base)).toBeLessThanOrEqual(1);
  });
  it('prints units', () => {
    const car = CARS[0];
    expect(carStatBars(car, 'kmh').find((b) => b.id === 'top')!.text).toBe(Math.round(car.stats.topSpeedKmh) + ' km/h');
    expect(carStatBars(car, 'mph').find((b) => b.id === 'top')!.text).toBe(Math.round(car.stats.topSpeedKmh * 0.621371) + ' mph');
    expect(carStatBars(car, 'kmh').find((b) => b.id === 'power')!.text).toBe(Math.round(car.stats.powerHp) + ' hp');
    const heavy = structuredClone(car);
    heavy.stats.massKg = 1480;
    expect(carStatBars(heavy, 'kmh').find((b) => b.id === 'weight')!.text).toBe('1,480 kg');
  });
});

describe('best laps', () => {
  const best = { 'a/vanta-gt': 92.5, 'a/lmp-x': 88.1, 'b/lmp-x': 70, 'ab/x': 1 };
  it('looks up an exact track + car', () => {
    expect(bestLapFor(best, 'a', 'vanta-gt')).toEqual({ time: 92.5, carId: 'vanta-gt' });
    expect(bestLapFor(best, 'a', 'ronin-86')).toBeNull();
  });
  it('finds the best across cars without matching track-id prefixes', () => {
    expect(bestLapFor(best, 'a')).toEqual({ time: 88.1, carId: 'lmp-x' });
    expect(bestLapFor(best, 'b')).toEqual({ time: 70, carId: 'lmp-x' });
    expect(bestLapFor(best, 'zz')).toBeNull();
    expect(bestKey('a', 'x')).toBe('a/x');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('setup -> RaceConfig', () => {
  it('builds a complete config for a race', () => {
    const s = defaultSetup('race', TRACKS, CARS);
    expect(s.laps).toBe(5);
    expect(s.timeOfDay).toBe('golden');
    s.trackIndex = 1;
    s.carIndex = CARS.length - 1;
    s.liveryIndex = 1;
    s.opponents = 11;
    s.difficulty = 'alien';
    s.weather = 'overcast';
    s.startPosition = 'pole';
    const c = buildRaceConfig(s, TRACKS, CARS, 'Gabriel');
    expect(c.mode).toBe('race');
    expect(c.trackId).toBe('b');
    expect(c.carId).toBe(CARS[CARS.length - 1].id);
    expect(c.laps).toBe(5);
    expect(c.opponents).toBe(11);
    expect(c.difficulty).toBe('alien');
    expect(c.environment).toEqual({ timeOfDay: 'golden', weather: 'overcast' });
    expect(c.startPosition).toBe('pole');
    expect(c.livery).toMatchObject({ primary: LIVERY_PRESETS[1].livery!.primary, driver: 'Gabriel' });
  });
  it('clamps laps and opponents to the legal range', () => {
    const s = defaultSetup('race', TRACKS, CARS);
    s.laps = 999;
    s.opponents = 99;
    let c = buildRaceConfig(s, TRACKS, CARS, 'X');
    expect(c.laps).toBe(50);
    expect(c.opponents).toBe(11);
    s.laps = -4;
    s.opponents = -2;
    c = buildRaceConfig(s, TRACKS, CARS, 'X');
    expect(c.laps).toBe(1);
    expect(c.opponents).toBe(0);
  });
  it('time trial and free roam are alone on track with unlimited laps', () => {
    const tt = buildRaceConfig({ ...defaultSetup('timeTrial', TRACKS, CARS), opponents: 9, laps: 4 }, TRACKS, CARS, 'X');
    expect(tt).toMatchObject({ mode: 'timeTrial', laps: 0, opponents: 0, startPosition: 'pole' });
    const fr = buildRaceConfig({ ...defaultSetup('freeRoam', TRACKS, CARS), opponents: 3 }, TRACKS, CARS, 'X');
    expect(fr).toMatchObject({ mode: 'freeRoam', laps: 0, opponents: 0, startPosition: 'pole' });
    expect(MODE_INFO.timeTrial.usesOpponents).toBe(false);
    expect(MODE_INFO.freeRoam.usesOpponents || MODE_INFO.freeRoam.usesDifficulty).toBe(false);
  });
  it('the factory livery only carries the driver name', () => {
    expect(liveryFor(LIVERY_PRESETS[0], 'Ana')).toEqual({ driver: 'Ana' });
    expect(liveryFor(LIVERY_PRESETS[0], '')).toEqual({ driver: 'You' });
    for (const p of LIVERY_PRESETS.slice(1)) {
      expect(p.livery!.primary).toMatch(/^#[0-9a-f]{6}$/i);
      expect(p.swatch).toBe(p.livery!.primary);
    }
  });
  it('following a different track updates laps and time of day', () => {
    const s = defaultSetup('race', TRACKS, CARS);
    applyTrackDefaults(s, TRACKS[1]);
    expect(s.laps).toBe(3);
    expect(s.timeOfDay).toBe('night');
  });
  it('defaultSetup tolerates empty or out-of-range previous state', () => {
    const s = defaultSetup('race', TRACKS, CARS, { trackIndex: 99, carIndex: -3 });
    expect(s.trackIndex).toBe(1);
    expect(s.carIndex).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('settings schema', () => {
  const rowIds = (tab: string): string[] => SETTINGS_TABS.find((t) => t.id === tab)!.rows.map((r) => r.id);

  it('has the tabs in order (the Assists tab of player 2 is shown only while a second player matters)', () => {
    expect(SETTINGS_TABS.map((t) => t.id)).toEqual(['graphics', 'audio', 'controls', 'assists', 'assists2', 'gameplay']);
    expect(SETTINGS_TABS.filter((t) => t.split).map((t) => t.id)).toEqual(['assists2']);
  });

  it('covers EVERY field of GraphicsSettings, AudioSettings, ControlSettings, Assists, hud, camera, units, playerName', () => {
    const s = DEFAULT_SETTINGS;
    expect(rowIds('graphics').sort()).toEqual(['quality', ...Object.keys(s.graphics).filter((k) => k !== 'quality')].sort());
    expect(rowIds('audio').sort()).toEqual(Object.keys(s.audio).sort());
    expect(rowIds('controls').sort()).toEqual(Object.keys(s.controls).sort());
    // (each human's aids: every field of them, and the preset row that sets them all at once)
    expect(rowIds('assists').sort()).toEqual(['preset', ...Object.keys(s.assists)].sort());
    expect(rowIds('assists2').sort()).toEqual(['preset', ...Object.keys(s.assists2)].sort());
    // (the split-screen settings: the second driver's name and how the screen divides)
    expect(rowIds('gameplay').sort()).toEqual(['units', ...Object.keys(s.hud), 'fov', 'shake', 'defaultMode', 'damage', 'nitro', 'playerName', 'player2Name', 'splitLayout'].sort());
  });

  it('shows the damage indicator for five seconds after what is drawn changes, and never on a sound car', () => {
    const s = new DamageShow();
    s.step(true, true, 0); // the first look at a sound car (everything moves from "unknown" to zero): nothing to show
    expect([s.on, s.pulse]).toEqual([false, 0]);
    s.step(true, false, 1000); // a hit
    const first = s.pulse;
    expect([s.on, first > 0]).toEqual([true, true]);
    s.step(false, false, 1016);
    expect([s.on, s.pulse]).toEqual([true, 0]);
    s.step(false, false, 5900);
    expect(s.on).toBe(true);
    s.step(true, false, 5016); // a second hit on the way: a new pulse (the other one, so that the animation restarts), and five seconds more
    expect(s.on).toBe(true);
    expect(s.pulse).toBeGreaterThan(0);
    expect(s.pulse).not.toBe(first);
    s.step(false, false, 9900);
    expect(s.on).toBe(true);
    s.step(false, false, 10100);
    expect(s.on).toBe(false);
    s.step(true, false, 20000); // the HUD comes back (or the setting) and the car is bent already: it shows
    expect([s.on, s.pulse > 0]).toEqual([true, true]);
    s.step(false, true, 20100); // repaired
    expect([s.on, s.pulse]).toEqual([false, 0]);
    s.step(false, false, 20200); // (nothing moved and the car is not sound: still down, the window is over)
    expect(s.on).toBe(false);
  });

  it('puts a word to the worst part of a damaged car for the pause screen', () => {
    const d = (worst: number) => ({ front: worst, rear: 0, left: 0, right: 0, wheels: [0, 0, 0, 0] as [number, number, number, number] });
    expect([0.05, 0.3, 0.6, 0.95].map((w) => damageWord(d(w)))).toEqual(['Light', 'Moderate', 'Heavy', 'Severe']);
    expect(damageWord({ ...d(0.1), wheels: [0, 0, 0.8, 0] })).toBe('Severe');
  });

  it('offers the damage as Off, Visual and Full, and says what Full does', () => {
    const row = SETTINGS_TABS.find((t) => t.id === 'gameplay')!.rows.find((r) => r.id === 'damage')!;
    expect(row.kind).toBe('select');
    if (row.kind !== 'select') return;
    expect(row.options.map((o) => [o.value, o.label])).toEqual([['off', 'Off'], ['visual', 'Visual'], ['full', 'Full']]);
    expect(row.desc).toMatch(/bent suspension/);
    expect(row.desc).toMatch(/downforce/);
    expect(row.desc).toMatch(/engine/);
    const s: Settings = structuredClone(DEFAULT_SETTINGS);
    row.set(s, 'full');
    expect(s.damage).toBe('full');
    expect(row.get(s)).toBe('full');
  });

  it('every row reads and writes through to the right field and round-trips', () => {
    for (const tab of SETTINGS_TABS) {
      for (const row of tab.rows) {
        const s: Settings = structuredClone(DEFAULT_SETTINGS);
        expect(row.label.length).toBeGreaterThan(0);
        expect(row.desc.length).toBeGreaterThan(10);
        if (row.kind === 'slider') {
          expect(row.min).toBeLessThan(row.max);
          row.set(s, row.max);
          expect(row.get(s)).toBe(row.max);
          row.set(s, row.min);
          expect(row.get(s)).toBe(row.min);
          expect(row.fmt(row.get(s)).length).toBeGreaterThan(0);
          // the default sits inside the slider's range
          const d = row.get(structuredClone(DEFAULT_SETTINGS));
          expect(d).toBeGreaterThanOrEqual(row.min);
          expect(d).toBeLessThanOrEqual(row.max);
        } else if (row.kind === 'toggle') {
          const before = row.get(s);
          row.set(s, !before);
          expect(row.get(s)).toBe(!before);
        } else if (row.kind === 'select') {
          expect(row.options.length).toBeGreaterThan(1);
          for (const o of row.options) {
            const t: Settings = structuredClone(DEFAULT_SETTINGS);
            row.set(t, o.value);
            expect(row.get(t)).toBe(o.value);
          }
          // the default value is one of the options
          expect(row.options.map((o) => o.value)).toContain(row.get(structuredClone(DEFAULT_SETTINGS)));
        } else {
          row.set(s, 'Test');
          expect(row.get(s)).toBe('Test');
          expect(row.maxLength).toBeGreaterThan(0);
        }
      }
    }
  });

  it('each tab can reset itself to the defaults', () => {
    for (const tab of SETTINGS_TABS) {
      const s: Settings = structuredClone(DEFAULT_SETTINGS);
      for (const row of tab.rows) {
        if (row.kind === 'slider') row.set(s, row.max);
        else if (row.kind === 'toggle') row.set(s, !row.get(s));
        else if (row.kind === 'select') row.set(s, row.options[row.options.length - 1].value);
        else row.set(s, 'zzz');
      }
      tab.reset(s);
      expect(s).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('the quality preset applies every field but keeps the frame-rate cap, and reports Custom when edited', () => {
    const q = SETTINGS_TABS[0].rows[0];
    if (q.kind !== 'select') throw new Error('quality must be a select');
    const s: Settings = structuredClone(DEFAULT_SETTINGS);
    s.graphics.maxFps = 60;
    q.set(s, 'low');
    expect(s.graphics).toEqual({ ...QUALITY_PRESETS.low, maxFps: 60 });
    expect(matchQuality(s.graphics)).toBe('low');
    expect(q.display!(s)).toBe('Low');
    s.graphics.bloom = !s.graphics.bloom;
    expect(matchQuality(s.graphics)).toBe('custom');
    expect(q.display!(s)).toBe('Custom');
    expect(q.get(s)).toBe('low'); // the underlying level is kept so left/right still step from it
    // a hand-built match of another preset is recognised
    const t: Settings = structuredClone(DEFAULT_SETTINGS);
    t.graphics = { ...QUALITY_PRESETS.ultra, quality: 'high' };
    expect(matchQuality(t.graphics)).toBe('ultra');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('focus list', () => {
  const nav = (o: Partial<Nav>): Nav => ({ up: false, down: false, left: false, right: false, confirm: false, back: false, tabLeft: false, tabRight: false, ...o });
  const row = (name: string, log: string[], over: Partial<FocusRow> = {}): FocusRow => ({
    setFocused: (on) => log.push(`${name}:${on ? 'on' : 'off'}`),
    left: () => (log.push(`${name}:left`), true),
    right: () => (log.push(`${name}:right`), true),
    activate: () => (log.push(`${name}:go`), true),
    ...over,
  });

  it('focuses the first row, moves up/down and routes left/right/confirm to the current row', () => {
    const log: string[] = [];
    const l = new FocusList();
    l.setRows([row('a', log), row('b', log), row('c', log)]);
    expect(l.index).toBe(0);
    expect(l.handle(nav({ down: true }))).toBe('moved');
    expect(l.index).toBe(1);
    expect(l.handle(nav({ right: true }))).toBe('changed');
    expect(l.handle(nav({ left: true }))).toBe('changed');
    expect(l.handle(nav({ confirm: true }))).toBe('activated');
    expect(log).toEqual(['a:on', 'a:off', 'b:on', 'b:right', 'b:left', 'b:go']);
  });

  it('stops at the ends, or wraps when asked', () => {
    const log: string[] = [];
    const l = new FocusList(false);
    l.setRows([row('a', log), row('b', log)]);
    expect(l.handle(nav({ up: true }))).toBe('none');
    expect(l.index).toBe(0);
    l.handle(nav({ down: true }));
    expect(l.handle(nav({ down: true }))).toBe('none');
    const w = new FocusList(true);
    w.setRows([row('a', log), row('b', log)]);
    expect(w.handle(nav({ up: true }))).toBe('moved');
    expect(w.index).toBe(1);
    expect(w.handle(nav({ down: true }))).toBe('moved');
    expect(w.index).toBe(0);
  });

  it('skips disabled rows in both directions and on the initial focus', () => {
    const log: string[] = [];
    const off = { isDisabled: () => true };
    const l = new FocusList();
    l.setRows([row('a', log, off), row('b', log), row('c', log, off), row('d', log)]);
    expect(l.index).toBe(1);
    l.handle(nav({ down: true }));
    expect(l.index).toBe(3);
    l.handle(nav({ up: true }));
    expect(l.index).toBe(1);
  });

  it('opposite directions together do nothing; empty list is harmless', () => {
    const log: string[] = [];
    const l = new FocusList();
    l.setRows([row('a', log), row('b', log)]);
    l.handle(nav({ up: true, down: true }));
    expect(l.index).toBe(0);
    expect(new FocusList().handle(nav({ down: true }))).toBe('none');
  });

  it('calls onFocus when focus lands on a row', () => {
    const log: string[] = [];
    const l = new FocusList();
    l.setRows([row('a', log), row('b', log, { onFocus: () => log.push('b:focus') })]);
    l.handle(nav({ down: true }));
    expect(log).toContain('b:focus');
  });
});

describe('focus list: blocked adjustments', () => {
  const nav = (o: Partial<Nav>): Nav => ({ up: false, down: false, left: false, right: false, confirm: false, back: false, tabLeft: false, tabRight: false, ...o });
  it('reports "blocked" when an adjustable row is at its limit, "none" when the row is not adjustable', () => {
    const noop = (): void => undefined;
    const slider: FocusRow = { setFocused: noop, left: () => false, right: () => true };
    const button: FocusRow = { setFocused: noop, activate: () => true };
    const l = new FocusList();
    l.setRows([slider, button]);
    expect(l.handle(nav({ left: true }))).toBe('blocked');
    expect(l.handle(nav({ right: true }))).toBe('changed');
    l.handle(nav({ down: true }));
    expect(l.handle(nav({ left: true }))).toBe('none');
    expect(l.handle(nav({ right: true }))).toBe('none');
  });
});

describe('on-screen keyboard helpers', () => {
  const row = [{ col: 0, span: 2 }, { col: 2, span: 2 }, { col: 4, span: 3 }, { col: 7, span: 3 }];
  it('keyAtColumn finds the key covering a column', () => {
    expect([0, 1, 2, 3, 4, 6, 7, 9].map((c) => keyAtColumn(row, c))).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(keyAtColumn(row, 99)).toBe(3); // past the end -> last key
  });
  it('autoCase capitalises the first letter of the name and of each word', () => {
    expect(autoCase('', 'g', false)).toBe('G');
    expect(autoCase('G', 'A', false)).toBe('a');
    expect(autoCase('Ga ', 'b', false)).toBe('B');
    expect(autoCase('Ana-', 'm', false)).toBe('M');
    expect(autoCase('Ga', 'b', true)).toBe('B'); // caps lock
    expect(autoCase('Ga', '7', false)).toBe('7'); // non-letters untouched
  });
});

describe('stepIndex / snap', () => {
  it('stepIndex clamps or wraps', () => {
    expect(stepIndex(0, -1, 4, false)).toBe(0);
    expect(stepIndex(3, 1, 4, false)).toBe(3);
    expect(stepIndex(0, -1, 4, true)).toBe(3);
    expect(stepIndex(3, 1, 4, true)).toBe(0);
    expect(stepIndex(0, 1, 0, true)).toBe(0);
  });
  it('snap avoids floating-point drift', () => {
    expect(snap(0.1 + 0.2, 0, 1, 0.05)).toBe(0.3);
    expect(snap(0.96, 0, 1, 0.05)).toBe(0.95);
    expect(snap(-5, 0, 1, 0.05)).toBe(0);
    expect(snap(7, 0, 1, 0.05)).toBe(1);
    expect(snap(1.43, 1, 3, 0.1)).toBe(1.4);
    expect(snap(62.4, 45, 100, 1)).toBe(62);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('championship setup', () => {
  it('starts from sensible defaults: 7 opponents, amateur, standard length, back of the grid, standings order', () => {
    const s = defaultSetup('championship', TRACKS, CARS);
    expect(s.mode).toBe('championship');
    expect(s.champ).toEqual({ opponents: 7, difficulty: 'amateur', length: 'standard', startPosition: 'back', grid: 'standings' });
    expect(s.champ).toEqual(CHAMP_DEFAULTS);
    expect(modeLabel('championship')).toBe('Championship');
    expect(modeLabel('timeTrial')).toBe('Time Trial');
  });

  it('keeps its own options apart from the Race setup, and the car choice in common', () => {
    const race = { ...defaultSetup('race', TRACKS, CARS), opponents: 3, difficulty: 'alien' as const, carIndex: 2, liveryIndex: 4 };
    const s = defaultSetup('championship', TRACKS, CARS, race);
    expect(s.carIndex).toBe(2);
    expect(s.liveryIndex).toBe(4);
    expect(s.champ.opponents).toBe(7); // not the 3 of the race
    s.champ.opponents = 10;
    s.champ.length = 'long';
    // visiting the championship must not wipe what the race remembers...
    const back = defaultSetup('race', TRACKS, CARS, s);
    expect(back.opponents).toBe(3);
    expect(back.difficulty).toBe('alien');
    // ...and the championship remembers its last choices
    expect(defaultSetup('championship', TRACKS, CARS, s).champ).toMatchObject({ opponents: 10, length: 'long' });
    // a time trial in between does not reset the championship's field either
    expect(defaultSetup('championship', TRACKS, CARS, defaultSetup('timeTrial', TRACKS, CARS, s)).champ.opponents).toBe(10);
  });

  it('builds the setup the game starts a championship from', () => {
    const s = defaultSetup('championship', TRACKS, CARS);
    s.carIndex = 1;
    s.liveryIndex = 3;
    s.champ = { opponents: 11, difficulty: 'pro', length: 'short', startPosition: 'pole', grid: 'reverse' };
    const c = buildChampionshipSetup(s, CARS, 'Ana');
    expect(c).toEqual({
      carId: CARS[1].id,
      livery: liveryFor(LIVERY_PRESETS[3], 'Ana'),
      difficulty: 'pro',
      opponents: 11,
      length: 'short',
      startPosition: 'pole',
      grid: 'reverse',
    });
    expect(c.livery).toMatchObject({ driver: 'Ana', primary: LIVERY_PRESETS[3].livery!.primary });
  });

  it('keeps the field between 1 and 11 opponents', () => {
    const s = defaultSetup('championship', TRACKS, CARS);
    s.champ.opponents = 40;
    expect(buildChampionshipSetup(s, CARS, 'X').opponents).toBe(OPPONENTS_MAX);
    s.champ.opponents = 0;
    expect(buildChampionshipSetup(s, CARS, 'X').opponents).toBe(CHAMP_OPPONENTS_MIN);
    s.champ.opponents = 4.4;
    expect(buildChampionshipSetup(s, CARS, 'X').opponents).toBe(4);
  });

  it('a championship wizard still builds a legal race config if asked (the mode maps to race)', () => {
    const c = buildRaceConfig(defaultSetup('championship', TRACKS, CARS), TRACKS, CARS, 'X');
    expect(c.mode).toBe('race');
    expect(c.championship).toBeUndefined();
  });
});

describe('championship menu text', () => {
  const tracks: TrackInfo[] = [
    { ...TRACKS[0], id: 'aurelia', name: 'Aurelia Ring', defaultLaps: 3 },
    { ...TRACKS[1], id: 'kuroyama', name: 'Kuroyama Pass', defaultLaps: 2 },
    { ...TRACKS[1], id: 'brennwald', name: 'Brennwald Ring', defaultLaps: 3 },
  ];
  const def = championshipDef(tracks);
  const start = (): ReturnType<typeof createChampionship> =>
    createChampionship({
      setup: { carId: CARS[0].id, difficulty: 'pro', opponents: 3, length: 'standard', startPosition: 'back', grid: 'standings' },
      tracks,
      playerName: 'Gabriel',
      playerLivery: { ...CARS[0].defaultLivery, driver: 'Gabriel' },
      car: CARS[0],
      seed: 5,
    });
  const ids = (s: ReturnType<typeof start>): string[] => s.drivers.map((d) => d.id);
  const finish = (order: string[]) => order.map((id, i) => ({ id, position: i + 1, totalTime: 100 + i, bestLap: null, laps: 3 }));

  it('describes the championship before there is one', () => {
    const t = championshipHint(def, null);
    expect(t).toContain('10 rounds across 5 circuits');
    expect(t).toContain('Xeno Cup');
    expect(championshipHint(undefined, null).length).toBeGreaterThan(20);
  });

  it('says where a saved season stands', () => {
    let s = start();
    expect(championshipHint(def, buildView(s))).toBe('Xeno Cup: round 1 of 10 is next. Nobody has scored yet.');
    s = recordRound(s, finish([...ids(s)].reverse())); // the player (listed first) finishes last: 12 points... on 4 cars: P4 = 12
    const v = buildView(s);
    expect(championshipHint(def, v)).toBe(`Xeno Cup, round 2 of 10. 4th with 12 points. Pick up where you left off.`);
    s = recordRound(s, finish([ids(s)[0], ...ids(s).slice(1)]));
    expect(championshipHint(def, buildView(s))).toContain('round 3 of 10');
  });

  it('congratulates a champion and shows a runner-up their place once the season is over', () => {
    let win = start();
    for (let i = 0; i < def.rounds.length; i++) win = recordRound(win, finish(ids(win)));
    expect(championshipHint(def, buildView(win))).toBe('Xeno Cup won with 250 points. See the final standings.');
    let lose = start();
    for (let i = 0; i < def.rounds.length; i++) lose = recordRound(lose, finish([ids(lose)[1], ids(lose)[0], ...ids(lose).slice(2)]));
    expect(championshipHint(def, buildView(lose))).toBe('Xeno Cup finished: 2nd with 180 points. See the final standings.');
  });

  it('formats conditions, laps, gaps, track codes and season titles', () => {
    expect(formatConditions({ timeOfDay: 'golden', weather: 'clear' })).toBe('Golden hour  ·  Clear');
    expect(formatConditions({ timeOfDay: 'dusk', weather: 'rain' })).toBe('Dusk  ·  Rain');
    expect([1, 2, 6].map(lapsLabel)).toEqual(['1 lap', '2 laps', '6 laps']);
    expect([0, 7, 25].map(formatPointsGap)).toEqual(['', '-7', '-25']);
    expect(trackCode('Aurelia Ring')).toBe('AUR');
    expect(trackCode('Kuroyama Pass')).toBe('KUR');
    expect(trackCode('X')).toBe('X');
    expect([1, 2, 3, 4, 11].map(seasonTitle)).toEqual(['Champion', 'Runner-up', 'Third place', '4th place', '11th place']);
    expect(leadText(1, 0, 7)).toBe('7 ahead');
    expect(leadText(1, 0, 0)).toBe('level on points');
    expect(leadText(2, 0, 0)).toBe('level on points'); // level on points but behind on countback
    expect(leadText(5, 12, 0)).toBe('12 behind the lead');
  });
});
