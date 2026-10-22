/**
 * Mock data for the UI sandbox: fictional tracks, a procedural circuit for the minimap, and an animated
 * HudState driven by a curvature-based speed profile (so speed, gears, g-forces and tire load look right).
 */
import type { HudState, HudStanding, MinimapTrack, RaceResultEntry, RaceResults, Seat, TrackInfo } from '../../src/core/contracts';
import { SEAT_COLOR } from '../../src/core/split';

export const MOCK_TRACKS: TrackInfo[] = [
  {
    id: 'azure-coast', name: 'Azure Coast GP', location: 'Costa Azura', difficulty: 3, defaultLaps: 5, defaultTimeOfDay: 'golden', lengthHint: 5210, color: '#2bb3ff',
    description: 'A flowing seaside circuit: a long flat-out main straight, a sweeping esses section through the dunes, and a tight hairpin that rewards late braking.',
  },
  {
    id: 'ridgeline', name: 'Ridgeline Circuit', location: 'Ridgeline Pass', difficulty: 4, defaultLaps: 4, defaultTimeOfDay: 'morning', lengthHint: 3920, color: '#ffb020',
    description: 'A technical mountain circuit with blind crests, elevation changes and very little room for error. Smooth inputs only.',
  },
  {
    id: 'meridian', name: 'Meridian Speedway', location: 'Meridian Flats', difficulty: 2, defaultLaps: 8, defaultTimeOfDay: 'noon', lengthHint: 4400, color: '#ff6a3d',
    description: 'A fast, wide, high-speed oval-style loop with a banked final turn. Slipstreams and bravery decide it.',
  },
  {
    id: 'nordhavn', name: 'Nordhavn Street Circuit', location: 'Nordhavn Harbour', difficulty: 5, defaultLaps: 3, defaultTimeOfDay: 'night', lengthHint: 3380, color: '#b57bff',
    description: 'Walls on both sides, harbour lights and a lap you drive with your heart in your mouth. Night racing at its most unforgiving.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Procedural circuit
// ─────────────────────────────────────────────────────────────────────────────

interface Seed { a: number[]; p: number[]; sx: number; sz: number; scale: number }
const SEEDS: Record<string, Seed> = {
  'azure-coast': { a: [0.34, 0.22, 0.12, 0.07], p: [0.4, 1.9, 3.1, 0.5], sx: 1.45, sz: 0.85, scale: 520 },
  ridgeline: { a: [0.18, 0.3, 0.2, 0.12], p: [2.2, 0.3, 1.1, 2.6], sx: 1.1, sz: 1.0, scale: 400 },
  meridian: { a: [0.42, 0.1, 0.06, 0.03], p: [0.1, 0.8, 1.6, 2.4], sx: 1.6, sz: 0.8, scale: 560 },
  nordhavn: { a: [0.2, 0.26, 0.24, 0.16], p: [1.3, 2.9, 0.2, 1.7], sx: 1.0, sz: 1.2, scale: 360 },
};

export function mockMinimap(id: string): MinimapTrack | null {
  const seed = SEEDS[id];
  if (!seed) return null;
  // dense polar curve first, then resample at ~5 m
  const N = 4000;
  const dense: { x: number; z: number }[] = [];
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    let r = 1;
    seed.a.forEach((a, k) => (r += a * Math.cos((k + 2) * th + seed.p[k])));
    dense.push({ x: Math.cos(th) * r * seed.scale * seed.sx, z: Math.sin(th) * r * seed.scale * seed.sz });
  }
  const pts: { x: number; z: number }[] = [dense[0]];
  let acc = 0;
  for (let i = 1; i <= N; i++) {
    const a = dense[i - 1];
    const b = dense[i % N];
    acc += Math.hypot(b.x - a.x, b.z - a.z);
    if (acc >= 5) {
      pts.push(b);
      acc = 0;
    }
  }
  if (Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].z - pts[0].z) < 2.5) pts.pop();
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const n = pts.length;
  return { points: pts, width: 13, startIndex: 0, sectorIndices: [Math.floor(n / 3), Math.floor((2 * n) / 3)], bounds: { minX, maxX, minZ, maxZ } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Animated HudState
// ─────────────────────────────────────────────────────────────────────────────

const NAMES = ['AYALA', 'BRANDT', 'CHEN', 'DUFOUR', 'EZE', 'FONTAINE', 'GABRIEL', 'HART', 'IVANOV', 'JANSEN', 'KOVACS', 'LINDQVIST'];
const COLORS = ['#ff6a1a', '#2bb3ff', '#ffd12b', '#c34bff', '#ff2e63', '#16e0bd', '#16e0bd', '#e8e8ee', '#7cff4b', '#ff8fb3', '#4b6bff', '#b0b6c4'];
/** The humans' cars' paint (two cars' default liveries): their minimap markers, while their tower chips are the seats' colours. */
const PLAYER_PAINT: readonly [string, string] = ['#1c2c5a', '#f2c200'];
const GEARS = [3.13, 2.12, 1.63, 1.3, 1.07, 0.88, 0.71];
const FINAL = 3.7;
const WHEEL_R = 0.34;

export interface MockOptions {
  units: 'kmh' | 'mph';
  telemetry: boolean;
  /** Seconds of the start sequence before the car moves. */
  startDelay: number;
  totalLaps: number;
  carCount: number;
  mode: 'race' | 'timeTrial' | 'freeRoam';
  hudVisible: boolean;
  /** Overrides for screenshots. */
  override: Partial<HudState>;
  limiter: boolean;
}

export class MockRace {
  private readonly n: number;
  private readonly v: Float32Array; // m/s at each sample
  private readonly kappa: Float32Array; // dh/ds, + = left
  private readonly T: Float32Array; // cumulative time
  private readonly heading: Float32Array;
  readonly lapTime: number;

  constructor(private readonly map: MinimapTrack, readonly o: MockOptions) {
    const p = map.points;
    const n = (this.n = p.length);
    const ds = 5;
    const heading = (this.heading = new Float32Array(n));
    for (let i = 0; i < n; i++) {
      const a = p[i];
      const b = p[(i + 1) % n];
      heading[i] = Math.atan2(b.x - a.x, b.z - a.z);
    }
    // curvature, lightly smoothed
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let d = heading[(i + 1) % n] - heading[i];
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      raw[i] = d / ds;
    }
    const kappa = (this.kappa = new Float32Array(n));
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -6; k <= 6; k++) s += raw[(i + k + n) % n];
      kappa[i] = s / 13;
    }
    // speed profile: corner limit, then forward (accel) and backward (brake) passes, twice around the loop
    const vmax = 95; // m/s ~ 340 km/h
    const v = (this.v = new Float32Array(n));
    for (let i = 0; i < n; i++) v[i] = Math.min(vmax, Math.sqrt(26 / Math.max(1e-4, Math.abs(kappa[i]))));
    const accel = 7.5;
    const brake = 13;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        v[j] = Math.min(v[j], Math.sqrt(v[i] * v[i] + 2 * accel * ds));
      }
      for (let i = n - 1; i >= 0; i--) {
        const j = (i + 1) % n;
        v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * brake * ds));
      }
    }
    for (let i = 0; i < n; i++) v[i] = Math.max(22, v[i]);
    const T = (this.T = new Float32Array(n + 1));
    for (let i = 0; i < n; i++) T[i + 1] = T[i] + ds / (0.5 * (v[i] + v[(i + 1) % n]));
    this.lapTime = T[n];
  }

  /** Index (fractional) along the lap for a time into the lap. */
  private at(tLap: number): { i: number; f: number } {
    const t = ((tLap % this.lapTime) + this.lapTime) % this.lapTime;
    let lo = 0;
    let hi = this.n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.T[mid] <= t) lo = mid;
      else hi = mid;
    }
    const f = (t - this.T[lo]) / Math.max(1e-6, this.T[lo + 1] - this.T[lo]);
    return { i: lo, f };
  }

  private speedAt(tLap: number): number {
    const { i, f } = this.at(tLap);
    const v = this.v[i] + (this.v[(i + 1) % this.n] - this.v[i]) * f;
    // standing start on the first lap: a plausible launch instead of a flying start
    return tLap >= 0 && tLap < this.lapTime ? Math.min(v, 9.5 * tLap + 0.5) : v;
  }

  state(t: number): HudState {
    const o = this.o;
    const raceT = Math.max(0, t - o.startDelay);
    const moving = t >= o.startDelay;
    const { i, f } = this.at(raceT + 0.0);
    const speed = moving ? this.speedAt(raceT) : 0;
    const a = moving ? (this.speedAt(raceT + 0.06) - this.speedAt(raceT - 0.06)) / 0.12 : 0;
    const k = this.kappa[i];
    const gLat = (speed * speed * k) / 9.81;
    const gLong = a / 9.81;

    // drivetrain
    const idle = 900;
    const redline = 7800;
    const limiter = 8000;
    let gear = 1;
    let rpm = idle;
    if (moving) {
      for (let g = GEARS.length; g >= 1; g--) {
        const r = ((speed / (2 * Math.PI * WHEEL_R)) * 60 * GEARS[g - 1] * FINAL);
        if (r >= 3900) {
          gear = g;
          break;
        }
      }
      rpm = Math.min(limiter, Math.max(idle + 300, (speed / (2 * Math.PI * WHEEL_R)) * 60 * GEARS[gear - 1] * FINAL));
    } else {
      rpm = t > o.startDelay - 1.2 ? 3200 + Math.sin(t * 40) * 120 : idle + Math.sin(t * 6) * 30;
    }
    if (o.limiter) rpm = limiter - 5;
    const throttle = moving ? Math.max(0, Math.min(1, a > 0.3 ? 0.55 + a / 9 : a > -2 ? 0.28 : 0)) : t > o.startDelay - 1.2 ? 1 : 0;
    const brake = moving ? Math.max(0, Math.min(1, -a / 11)) : 0;
    const shiftLight = Math.max(0, Math.min(1, (rpm - 0.86 * redline) / (limiter - 0.86 * redline)));

    // lap timing
    const lap = Math.floor(raceT / this.lapTime) + 1;
    const lapTime = raceT % this.lapTime;
    const sector = i < this.map.sectorIndices[0] ? 0 : i < this.map.sectorIndices[1] ? 1 : 2;
    const delta = moving ? Math.sin(raceT * 0.31) * 0.9 + Math.sin(raceT * 0.07) * 0.5 : null;
    const sectorDeltas: (number | null)[] = [sector > 0 ? -0.118 : null, sector > 1 ? 0.307 : null, null];

    // field
    const total = o.carCount;
    const myPos = o.mode === 'race' ? 3 + Math.round(Math.sin(raceT * 0.05) * 0.6 + 0.6) : 1;
    const order = NAMES.slice(0, total).filter((n) => n !== 'GABRIEL');
    const standings: HudStanding[] = [];
    let oi = 0;
    for (let p = 1; p <= total; p++) {
      const me = p === myPos;
      const name = me ? 'GABRIEL' : order[oi++];
      const idx = NAMES.indexOf(name);
      standings.push({ position: p, name, gap: p === 1 ? 'LEADER' : '+' + (p * 0.74 + (p % 3) * 0.21).toFixed(3), isPlayer: me, color: COLORS[idx] });
    }
    // cars on the minimap
    const p = this.map.points;
    const cars: HudState['cars'] = [];
    for (let c = 0; c < total; c++) {
      const std = standings[c];
      const offset = (myPos - std.position) * 11; // samples ahead (+) of the player
      const j = (((Math.floor(i + offset)) % this.n) + this.n) % this.n;
      cars.push({ x: p[j].x, z: p[j].z, heading: this.heading[j], color: std.isPlayer ? PLAYER_PAINT[0] : std.color, isPlayer: std.isPlayer });
    }
    void f;

    // tires: FL FR RL RR. Left turn (gLat > 0) loads the right-hand tires; braking loads the front.
    const lat = Math.max(-1.6, Math.min(1.6, gLat));
    const lon = Math.max(-1.6, Math.min(1.6, gLong));
    const front = 1 - lon * 0.22;
    const rear = 1 + lon * 0.22;
    const left = 1 - lat * 0.26;
    const right = 1 + lat * 0.26;
    const slipBase = Math.min(1.1, Math.abs(lat) / 1.5 + brake * 0.35 + (throttle > 0.9 && speed < 25 ? 0.4 : 0));
    const mk = (load: number, slipK: number, ti: number): { slip: number; tempC: number; load: number } => ({
      slip: Math.max(0, Math.min(1.2, slipBase * slipK + (load > 1.15 ? 0.12 : 0))),
      tempC: 72 + ti * 6 + Math.sin(t * 0.09 + ti) * 6 + slipBase * 26 + (load - 1) * 12,
      load,
    });
    const tires = [mk(front * left, 1.0, 0), mk(front * right, 1.0, 1), mk(rear * left, 0.9, 2), mk(rear * right, 0.9, 3)];

    // start sequence
    let countdown: number | null = null;
    if (t < o.startDelay - 1.0) countdown = Math.min(5, Math.max(0, Math.floor(t)));
    else if (t < o.startDelay + 0.9) countdown = t < o.startDelay ? 5 : 6;

    const base: HudState = {
      mode: o.mode,
      units: o.units,
      speed,
      rpm,
      idleRpm: idle,
      redlineRpm: redline,
      limiterRpm: limiter,
      gear: moving ? gear : 1,
      throttle,
      brake,
      steer: Math.max(-1, Math.min(1, -k * 55)),
      shiftLight,
      absActive: brake > 0.85 && Math.sin(t * 45) > 0,
      tcsActive: throttle > 0.9 && speed < 28,
      escActive: Math.abs(lat) > 1.25 && Math.sin(t * 18) > 0,
      lap: Math.min(lap, o.totalLaps || 99),
      totalLaps: o.mode === 'race' ? o.totalLaps : 0,
      position: myPos,
      totalCars: total,
      raceTime: raceT,
      lapTime,
      lastLap: lap > 1 ? 93.012 : null,
      bestLap: 91.874,
      delta,
      sector,
      sectorDeltas,
      standings: o.mode === 'race' ? standings : [],
      cars,
      gLat: lat,
      gLong: lon,
      tires,
      countdown,
      wrongWay: false,
      banner: null,
      toast: null,
      showTelemetry: o.telemetry,
      hudVisible: o.hudVisible,
    };
    return { ...base, ...o.override };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Results
// ─────────────────────────────────────────────────────────────────────────────

export function mockResults(carIds: string[], personalBest: boolean, position = 3): RaceResults {
  const names = NAMES.slice(0, 12);
  const order = names.filter((n) => n !== 'GABRIEL');
  order.splice(position - 1, 0, 'GABRIEL');
  const entries: RaceResultEntry[] = order.map((name, i) => ({
    position: i + 1,
    name,
    carId: carIds[i % carIds.length],
    isPlayer: name === 'GABRIEL',
    totalTime: i === 11 ? null : 480.5 + i * 1.7 + (i % 3) * 0.4,
    bestLap: i === 11 ? null : 91.9 + i * 0.21 + (i === 4 ? -0.4 : 0),
    gap: i === 0 ? 'WINNER' : i === 11 ? 'DNF' : i < 8 ? '+' + (i * 1.7 + (i % 3) * 0.4).toFixed(3) : '+1 LAP',
    laps: i === 11 ? 3 : 5,
  }));
  return {
    config: { mode: 'race', trackId: 'azure-coast', carId: carIds[0], laps: 5, opponents: 11, difficulty: 'amateur', environment: { timeOfDay: 'golden', weather: 'clear' }, startPosition: 'back' },
    entries,
    playerLapTimes: [95.4, 93.012, 92.481, 92.9, 93.77],
    personalBest,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Split screen
// ─────────────────────────────────────────────────────────────────────────────

export const SPLIT_NAMES: readonly [string, string] = ['GABRIEL', 'SILVIU'];

/**
 * The view of one seat in a split race: `base` (a MockRace state) with the two humans in the standings at places `pos` (both rows
 * are `isPlayer`, with their seat), on the map, and the viewer's own place/lap numbers. `keep` limits the standings the way the game
 * does (leader, the cars around the viewer and both humans: 6 rows at most); 0 keeps all of them.
 */
export function splitState(base: HudState, seat: Seat, pos: readonly [number, number], keep = 6): HudState {
  const total = base.totalCars;
  const humans = [clampPos(pos[0], total), clampPos(pos[1], total)];
  if (humans[0] === humans[1]) humans[1] = humans[1] === total ? total - 1 : humans[1] + 1;
  const names = NAMES.filter((n) => n !== 'GABRIEL' && n !== 'SILVIU');
  let ai = 0;
  const standings: HudStanding[] = [];
  const cars: HudState['cars'] = [];
  for (let p = 1; p <= total; p++) {
    const hs = humans.indexOf(p);
    const std = base.standings[p - 1] ?? base.standings[base.standings.length - 1];
    const name = hs >= 0 ? SPLIT_NAMES[hs] : names[ai++ % names.length];
    const color = hs >= 0 ? SEAT_COLOR[hs] : COLORS[NAMES.indexOf(name) % COLORS.length];
    const gap = p === 1 ? 'LEADER' : '+' + (p * 0.74 + (p % 3) * 0.21).toFixed(3);
    standings.push({ position: p, name, gap, isPlayer: hs >= 0, color, ...(hs >= 0 ? { seat: hs as Seat } : {}) });
    const c = base.cars[Math.min(base.cars.length - 1, p - 1)];
    cars.push({ x: c.x, z: c.z, heading: c.heading, color: hs >= 0 ? PLAYER_PAINT[hs] : color, isPlayer: hs >= 0, ...(hs >= 0 ? { seat: hs as Seat } : {}) });
    void std;
  }
  let shown = standings;
  if (keep > 0 && total > keep) {
    // what the game sends: the leader and both humans first, then the cars around the viewer until `keep` rows are chosen
    const me = humans[seat] - 1;
    const want: number[] = [0, me, humans[1 - seat] - 1];
    for (let d = 1; want.length < keep && d < total; d++) for (const i of [me - d, me + d]) if (i >= 0 && i < total && !want.includes(i) && want.length < keep) want.push(i);
    shown = standings.filter((_, i) => want.includes(i));
  }
  return { ...base, position: humans[seat], standings: shown, cars };
}

function clampPos(p: number, total: number): number {
  return Math.max(1, Math.min(total, Math.round(p)));
}
