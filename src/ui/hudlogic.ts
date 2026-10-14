/**
 * Pure HUD logic (no DOM, no canvas): everything the 60 fps HUD decides that can be tested headlessly.
 */
import type { HudStanding } from '../core/contracts';

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// ─────────────────────────────────────────────────────────────────────────────
// Palette (matches ARCHITECTURE.md + the CSS tokens)
// ─────────────────────────────────────────────────────────────────────────────

export const COLORS = {
  teal: '#16e0bd',
  pink: '#ff2e63',
  ink: '#0b0c10',
  paper: '#eef0f3',
  good: '#2ee57d',
  warn: '#ffb020',
  bad: '#ff3b57',
  purple: '#b57bff',
  blue: '#4aa8ff',
} as const;

type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Linear blend between color stops given as [position 0..1, hex]. Returns "rgb(r,g,b)". */
export function rampAt(stops: readonly (readonly [number, string])[], t: number): string {
  const x = clamp01(t);
  let i = 0;
  while (i < stops.length - 2 && x > stops[i + 1][0]) i++;
  const [p0, c0] = stops[i];
  const [p1, c1] = stops[i + 1];
  const k = p1 === p0 ? 0 : clamp01((x - p0) / (p1 - p0));
  const a = hexToRgb(c0);
  const b = hexToRgb(c1);
  return `rgb(${Math.round(lerp(a[0], b[0], k))},${Math.round(lerp(a[1], b[1], k))},${Math.round(lerp(a[2], b[2], k))})`;
}

/** Precomputed lookup table so the per-frame path never builds colour strings. */
export function makeLut(stops: readonly (readonly [number, string])[], size = 64): string[] {
  const out: string[] = [];
  for (let i = 0; i < size; i++) out.push(rampAt(stops, i / (size - 1)));
  return out;
}

export function lutAt(lut: readonly string[], t: number): string {
  return lut[Math.round(clamp01(t) * (lut.length - 1))];
}

/** Tire slip: 0 = gripping .. 1 = at / past the limit. */
export const SLIP_LUT = makeLut([[0, COLORS.teal], [0.45, COLORS.good], [0.7, COLORS.warn], [1, COLORS.pink]], 48);

/** Tire tread temperature: cold blue -> optimum green -> hot amber -> overheated red. 20..140 C. */
export const TEMP_LUT = makeLut([[0, COLORS.blue], [0.3, COLORS.teal], [0.5, COLORS.good], [0.72, COLORS.warn], [1, COLORS.bad]], 48);
export const tempColor = (tempC: number): string => lutAt(TEMP_LUT, (tempC - 20) / 120);
export const slipColor = (slip: number): string => lutAt(SLIP_LUT, slip);

// ─────────────────────────────────────────────────────────────────────────────
// Revs and shift lights
// ─────────────────────────────────────────────────────────────────────────────

export const SHIFT_LEDS = 9;

/** Top of the rev scale in rpm: the next 1000 above the limiter. */
export function revScaleMax(limiterRpm: number): number {
  return Math.max(2000, Math.ceil((limiterRpm + 1) / 1000) * 1000);
}

/** The limiter is cutting (or about to). `HudState` has no flag for it, so infer it from rpm. */
export function isLimiter(rpm: number, limiterRpm: number): boolean {
  return limiterRpm > 0 && rpm >= limiterRpm * 0.992;
}

/** How many of the shift LEDs are lit for a 0..1 shift-light progression. */
export function shiftLedCount(shiftLight: number): number {
  const n = Math.ceil(clamp01(shiftLight) * SHIFT_LEDS - 1e-6);
  return n <= 0 ? 0 : Math.min(SHIFT_LEDS, n); // never -0
}

/** LED colour by index: 3 green, 3 amber, 3 red. */
export function shiftLedColor(i: number): string {
  return i < 3 ? COLORS.good : i < 6 ? COLORS.warn : COLORS.bad;
}

/** Rev arc colour ramp along the scale: teal -> green -> amber -> red as rpm approaches the redline. */
export function revRampStops(redlineFrac: number): readonly (readonly [number, string])[] {
  const r = clamp(redlineFrac, 0.2, 1);
  return [
    [0, COLORS.teal],
    [r * 0.58, COLORS.teal],
    [r * 0.74, COLORS.good],
    [r * 0.88, COLORS.warn],
    [r * 0.99, COLORS.bad],
    [Math.min(1, r * 1.0 + 0.001), COLORS.bad],
    [1, COLORS.bad],
  ];
}

/** Square-wave phase for flashing things (limiter lights): true during the "on" half. */
export function flashPhase(nowMs: number, hz: number): boolean {
  return Math.floor((nowMs / 1000) * hz * 2) % 2 === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Timing
// ─────────────────────────────────────────────────────────────────────────────

export type DeltaClass = 'none' | 'good' | 'bad' | 'even';

/** Live delta colouring: negative = faster = good (green), positive = slower = bad (red). */
export function deltaClass(delta: number | null): DeltaClass {
  if (delta === null || !Number.isFinite(delta)) return 'none';
  if (delta < -0.0005) return 'good';
  if (delta > 0.0005) return 'bad';
  return 'even';
}

/** Position of the delta bar fill: -1 .. +1 over +-1.0 s full scale (negative fills left = faster). */
export function deltaBar(delta: number | null, fullScale = 1): number {
  if (delta === null || !Number.isFinite(delta)) return 0;
  return clamp(delta / fullScale, -1, 1);
}

export type SectorState = 'pending' | 'active' | 'good' | 'bad' | 'even' | 'set';

/**
 * State of sector cell `i` while the player is in `current` (0..2). Passed sectors are coloured by their
 * delta vs best; the current sector pulses; the rest are blank.
 */
export function sectorState(i: number, current: number, deltas: readonly (number | null)[]): SectorState {
  if (i === current) return 'active';
  if (i > current) return 'pending';
  const d = deltas[i];
  if (d === null || d === undefined || !Number.isFinite(d)) return 'set';
  if (d < -0.0005) return 'good';
  if (d > 0.0005) return 'bad';
  return 'even';
}

// ─────────────────────────────────────────────────────────────────────────────
// Standings tower
// ─────────────────────────────────────────────────────────────────────────────

export interface TowerRow {
  standing: HudStanding;
  /** A row of the list was skipped between this one and the previous (draw a separator). */
  gapBefore: boolean;
}

/**
 * Allocation-free core: leader + the cars around the player, at most `max` rows (`idx.length` >= max).
 * Writes indices into `standings` and "a row was skipped before this one" flags; returns the row count.
 * With few cars everyone is shown.
 */
export function pickTowerIndices(standings: readonly HudStanding[], max: number, idx: Int16Array, gap: Uint8Array): number {
  const n = standings.length;
  if (n === 0 || max <= 0) return 0;
  if (n <= max) {
    for (let i = 0; i < n; i++) {
      idx[i] = i;
      gap[i] = 0;
    }
    return n;
  }
  let me = -1;
  for (let i = 0; i < n; i++) {
    if (standings[i].isPlayer) {
      me = i;
      break;
    }
  }
  if (me < 0) {
    for (let i = 0; i < max; i++) {
      idx[i] = i;
      gap[i] = 0;
    }
    return max;
  }
  idx[0] = 0;
  gap[0] = 0;
  const win = max - 1;
  const before = Math.floor((win - 1) / 2);
  const start = clamp(me - before, 1, n - win);
  for (let k = 0; k < win; k++) {
    idx[k + 1] = start + k;
    gap[k + 1] = k === 0 && start > 1 ? 1 : 0;
  }
  return max;
}

/** Convenience wrapper (allocates; the HUD itself uses `pickTowerIndices`). */
export function selectTowerRows(standings: readonly HudStanding[], max = 8): TowerRow[] {
  const idx = new Int16Array(Math.max(1, max));
  const gap = new Uint8Array(Math.max(1, max));
  const n = pickTowerIndices(standings, max, idx, gap);
  const out: TowerRow[] = [];
  for (let i = 0; i < n; i++) out.push({ standing: standings[idx[i]], gapBefore: gap[i] === 1 });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimap
// ─────────────────────────────────────────────────────────────────────────────

export interface MapFit {
  scale: number;
  ox: number;
  oy: number;
  minX: number;
  minZ: number;
}

/**
 * Uniform fit of world bounds into a w x h box with `pad` pixels around. Top view with +X to the right
 * and +Z down the screen (a correct, un-mirrored view from above for a right-handed +Y-up world).
 */
export function fitBounds(b: { minX: number; maxX: number; minZ: number; maxZ: number }, w: number, h: number, pad: number, out: MapFit): MapFit {
  const bw = Math.max(1e-6, b.maxX - b.minX);
  const bh = Math.max(1e-6, b.maxZ - b.minZ);
  const s = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh);
  out.scale = s;
  out.ox = (w - bw * s) / 2;
  out.oy = (h - bh * s) / 2;
  out.minX = b.minX;
  out.minZ = b.minZ;
  return out;
}
export const mapX = (f: MapFit, x: number): number => f.ox + (x - f.minX) * f.scale;
export const mapY = (f: MapFit, z: number): number => f.oy + (z - f.minZ) * f.scale;

// ─────────────────────────────────────────────────────────────────────────────
// Ring buffers for the telemetry graphs
// ─────────────────────────────────────────────────────────────────────────────

export class RingBuf {
  readonly data: Float32Array;
  private head = 0;
  count = 0;

  constructor(readonly size: number) {
    this.data = new Float32Array(size);
  }

  push(v: number): void {
    this.data[this.head] = v;
    this.head = (this.head + 1) % this.size;
    if (this.count < this.size) this.count++;
  }

  /** i = 0 is the oldest sample, i = count-1 the newest. */
  at(i: number): number {
    const start = (this.head - this.count + this.size) % this.size;
    return this.data[(start + i) % this.size];
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.data.fill(0);
  }
}

/** 2D trail (g-meter): pairs of floats in a ring. */
export class TrailBuf {
  private readonly xs: Float32Array;
  private readonly ys: Float32Array;
  private head = 0;
  count = 0;

  constructor(readonly size: number) {
    this.xs = new Float32Array(size);
    this.ys = new Float32Array(size);
  }

  push(x: number, y: number): void {
    this.xs[this.head] = x;
    this.ys[this.head] = y;
    this.head = (this.head + 1) % this.size;
    if (this.count < this.size) this.count++;
  }

  x(i: number): number {
    return this.xs[(this.head - this.count + i + this.size) % this.size];
  }
  y(i: number): number {
    return this.ys[(this.head - this.count + i + this.size) % this.size];
  }
  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Start lights
// ─────────────────────────────────────────────────────────────────────────────

export interface LightsView {
  visible: boolean;
  /** How many of the five red lights are on. */
  lit: number;
  go: boolean;
}

/** `HudState.countdown`: null hidden, 0..5 lights lit, 6 = all out = GO. */
export function lightsView(countdown: number | null): LightsView {
  if (countdown === null || countdown === undefined) return { visible: false, lit: 0, go: false };
  if (countdown >= 6) return { visible: true, lit: 0, go: true };
  return { visible: true, lit: clamp(Math.floor(countdown), 0, 5), go: false };
}
