/**
 * UI sandbox. Mounts the real UI + the real input system over a photo backdrop.
 *
 *   ?screen=title|main|setup|settings|pause|results|loading|credits|hud
 *   &device=pad|kbd        gamepad glyphs + a fake F310 feeding the real InputSystem (kbd = default)
 *   &keys=down,down,confirm  synthetic nav presses after the screen opens (up down left right confirm back tabL tabR pause)
 *   &keygap=180&delay=800    timing of the synthetic presses (ms)
 *   &w=...                   (use scripts/shot.mjs --w/--h for the viewport)
 * HUD:   &telemetry=1 &units=mph &mode=timeTrial|freeRoam &cars=12 &laps=5 &t=20 &freeze=1 &hudvis=0 &car=1
 *        &countdown=3 &banner=FINAL%20LAP &toast=FASTEST%20LAP%201:32.481 &wrongway=1 &limiter=1 &lap=5 &delta=-0.482
 * Results: &pb=1 &pos=3      Loading: &p=0.62     Misc: &guides=1 (3D-area box) &still=1 (no backdrop pan) &warn=1 (F310 D-mode)
 */
import { CARS } from '../../src/cars';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import type { HudState, InputFrame, RaceConfig, SplitLayout, UIIntent } from '../../src/core/contracts';
import { splitGeometry } from '../../src/core/split';
import type { UIDeps } from '../../src/core/systems';
import { createInputSystem, type PadLike } from '../../src/input';
import { createUI, type XenoUI } from '../../src/ui';
import { benchHud, benchSplit } from './bench';
import { MOCK_TRACKS, MockRace, mockMinimap, mockResults, splitState, type MockOptions } from './mock';

declare global {
  interface Window {
    __READY__?: boolean;
    __ui?: XenoUI;
    __intents?: UIIntent[];
    __sounds?: string[];
    __feed?: (tokens: string) => void;
    __hud?: () => HudState | null;
    __bench?: (frames?: number) => unknown;
    __benchSplit?: (frames?: number, flush?: boolean) => unknown;
    __pad?: { axes: number[]; buttons: { pressed: boolean; touched: boolean; value: number }[] };
  }
}

const q = new URLSearchParams(location.search);
const num = (k: string, d: number): number => (q.has(k) ? Number(q.get(k)) : d);
const screen = q.get('screen') ?? 'title';
const usePad = q.get('device') === 'pad';

if (q.get('still')) document.body.classList.add('still');
if (q.get('guides')) document.body.classList.add('guides');
if (q.get('car')) document.body.classList.add('car');

// ── mock deps ────────────────────────────────────────────────────────────────

window.__intents = [];
window.__sounds = [];
const deps: UIDeps = {
  cars: CARS,
  tracks: MOCK_TRACKS,
  settings: structuredClone(DEFAULT_SETTINGS),
  version: '0.1.0',
  bestLaps: { 'azure-coast/vanta-gt': 92.481, 'azure-coast/lmp-x': 88.907, 'ridgeline/kestrel-r': 101.355 },
  minimapFor: (id) => mockMinimap(id),
  onIntent: (i) => {
    window.__intents!.push(i);
    console.log('[intent]', JSON.stringify(i).slice(0, 300));
    if (i.type === 'settingsChanged') deps.settings = structuredClone(i.settings);
  },
  sound: (s) => {
    window.__sounds!.push(s);
  },
};

const container = document.getElementById('ui')!;
const ui = createUI(container, deps);
window.__ui = ui;

// ── input: the real InputSystem (optionally with a fake F310) ───────────────

interface FakeButton { pressed: boolean; touched: boolean; value: number }
const fakePad = {
  id: q.get('warn') ? 'Logitech Dual Action (Vendor: 046d Product: c216)' : 'Logitech Gamepad F310 (STANDARD GAMEPAD Vendor: 046d Product: c21d)',
  index: 0,
  connected: true,
  mapping: q.get('warn') ? '' : 'standard',
  axes: new Array<number>(q.get('warn') ? 10 : 4).fill(0),
  buttons: Array.from({ length: q.get('warn') ? 12 : 17 }, (): FakeButton => ({ pressed: false, touched: false, value: 0 })),
};
window.__pad = fakePad;
const input = createInputSystem(deps.settings.controls, usePad ? { getGamepads: () => [fakePad as unknown as PadLike] } : {});
if (usePad) {
  // wake the pad (Chrome only exposes a pad after a press) without feeding that frame to the UI
  fakePad.buttons[0] = { pressed: true, touched: true, value: 1 };
  input.poll(1 / 60);
  fakePad.buttons[0] = { pressed: false, touched: false, value: 0 };
  input.poll(1 / 60);
  ui.setDevice(input.padName, input.warning);
}

// ── synthetic frames (deterministic screenshots) ────────────────────────────

function blank(device: 'gamepad' | 'keyboard'): InputFrame {
  return {
    device, gamepadId: device === 'gamepad' ? fakePad.id : null,
    steer: 0, throttle: 0, brake: 0, handbrake: 0, clutch: 0, lookX: 0, lookY: 0, lookBack: false,
    shiftUp: false, shiftDown: false, cameraNext: false, resetCar: false, pause: false, toggleHud: false, toggleTelemetry: false, nitro: false,
    nav: { up: false, down: false, left: false, right: false, confirm: false, back: false, tabLeft: false, tabRight: false },
    anyPressed: false,
  };
}
function feedToken(tok: string): void {
  const f = blank(usePad ? 'gamepad' : 'keyboard');
  const n = f.nav;
  switch (tok.trim()) {
    case 'up': n.up = true; break;
    case 'down': n.down = true; break;
    case 'left': n.left = true; break;
    case 'right': n.right = true; break;
    case 'confirm': n.confirm = true; f.anyPressed = true; break;
    case 'back': n.back = true; f.anyPressed = true; break;
    case 'tabL': n.tabLeft = true; break;
    case 'tabR': n.tabRight = true; break;
    case 'pause': f.pause = true; n.confirm = true; f.anyPressed = true; break;
    case 'any': f.anyPressed = true; break;
    default: return;
  }
  ui.handleInput(f);
}
window.__feed = (tokens: string) => tokens.split(',').forEach(feedToken);

// ── HUD mock ────────────────────────────────────────────────────────────────

const mode = (q.get('mode') as MockOptions['mode']) ?? 'race';
const opts: MockOptions = {
  units: q.get('units') === 'mph' ? 'mph' : 'kmh',
  telemetry: q.get('telemetry') === '1',
  startDelay: num('delay0', 6),
  totalLaps: num('laps', 5),
  carCount: num('cars', 12),
  mode,
  hudVisible: q.get('hudvis') !== '0',
  limiter: q.get('limiter') === '1',
  override: {},
};
if (q.has('countdown')) opts.override.countdown = q.get('countdown') === 'null' ? null : num('countdown', 3);
if (q.has('banner')) opts.override.banner = q.get('banner');
if (q.has('toast')) opts.override.toast = q.get('toast');
if (q.get('wrongway')) opts.override.wrongWay = true;
if (q.get('spot')) opts.override.spotter = { left: 0.85, right: 0.45, leftAt: 0.3, rightAt: -0.4 };
// &wx=chip|note: the changing-weather chip (and the "Rain is coming" card)
if (q.get('wx')) {
  opts.override.weather = {
    sky: 'rain', rain: 0.55, wetness: 0.6, track: 'Damp', forecast: 'rainLater', called: true,
    notice: q.get('wx') === 'note' ? { kind: 'rain', title: 'Rain is coming', sub: 'Showers over the circuit in a minute or two' } : null,
  };
}
if (q.has('lap')) opts.override.lap = num('lap', 1);
if (q.has('delta')) opts.override.delta = num('delta', 0);
const trackId = q.get('track') ?? 'azure-coast';
const map = mockMinimap(trackId)!;
const race = new MockRace(map, opts);
// &split=rows|columns: two HUDs, one per view (the places are &p1= and &p2=; &keep=0 sends the whole standings)
const splitLayout: SplitLayout | null = q.get('split') === 'columns' ? 'columns' : q.get('split') ? 'rows' : null;
const places: [number, number] = [num('p1', 4), num('p2', 7)];
const keep = num('keep', 6);
if (splitLayout) {
  // stand-in for the game's two views: the backdrop with the gap between them cut out in black
  const gap = document.createElement('div');
  gap.style.cssText = 'position:fixed;background:#000;pointer-events:none';
  document.getElementById('bg')!.after(gap);
  const place = (): void => {
    const d = splitGeometry(window.innerWidth, window.innerHeight, splitLayout).divider;
    gap.style.cssText = `position:fixed;background:#000;pointer-events:none;left:${d.x}px;top:${d.y}px;width:${d.w}px;height:${d.h}px`;
  };
  place();
  window.addEventListener('resize', place);
}
const t0 = num('t', screen === 'hud' || screen === 'pause' ? 38 : 0);
const freeze = q.get('freeze') === '1';
let hudTime = t0;
let lastHud: HudState | null = null;
window.__hud = () => lastHud;
window.__bench = (frames = 600) => benchHud(ui, race, frames);
window.__benchSplit = (frames = 600, flush = true) => benchSplit(ui, race, (s, seat) => splitState(s, seat, places, keep), frames, flush);

function startHud(): void {
  ui.setHudVisible(true);
  ui.setMinimap(map);
  if (splitLayout) ui.setSplit(splitLayout);
}

// ── screen setup ────────────────────────────────────────────────────────────

const cfg: RaceConfig = { mode: 'race', trackId, carId: CARS[0].id, laps: opts.totalLaps, opponents: 11, difficulty: 'amateur', environment: { timeOfDay: 'golden', weather: 'clear' }, startPosition: 'back' };

function openScreen(): void {
  switch (screen) {
    case 'hud':
      startHud();
      ui.show('none');
      break;
    case 'pause':
      startHud();
      ui.updateHud(splitLayout ? splitState(race.state(t0), 0, places, keep) : race.state(t0));
      if (splitLayout) ui.updateHud(splitState(race.state(t0 + 4), 1, places, keep), 1);
      (ui as unknown as { ctx: { lastConfig: RaceConfig | null } }).ctx.lastConfig = cfg;
      ui.show('pause');
      break;
    case 'results':
      ui.setResults(mockResults(CARS.map((c) => c.id), q.get('pb') === '1', num('pos', 3)));
      ui.show('results');
      break;
    case 'loading':
      (ui as unknown as { ctx: { startRace(c: RaceConfig): void } }).ctx.startRace(cfg);
      ui.setLoading(num('p', 0.62), q.get('label') ?? 'Building scenery');
      break;
    default:
      ui.show(screen as never);
  }
}

openScreen();

// ── frame loop ──────────────────────────────────────────────────────────────

let last = performance.now();
function tick(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const f = input.poll(dt);
  ui.handleInput(f);
  if (!freeze) hudTime += dt;
  if (ui.screen === 'none' || ui.screen === 'pause') {
    lastHud = race.state(hudTime);
    if (splitLayout) {
      ui.updateHud(splitState(lastHud, 0, places, keep), 0);
      ui.updateHud(splitState(race.state(hudTime + 4), 1, places, keep), 1);
    } else ui.updateHud(lastHud);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ── keys + ready ────────────────────────────────────────────────────────────

const keys = (q.get('keys') ?? '').split(',').filter(Boolean);
const delay = num('delay', 800);
const gap = num('keygap', 180);
let ki = 0;
function nextKey(): void {
  if (ki >= keys.length) return;
  feedToken(keys[ki++]);
  setTimeout(nextKey, gap);
}
if (keys.length) setTimeout(nextKey, delay);

void (document.fonts?.ready ?? Promise.resolve()).then(() => {
  const total = (keys.length ? delay + keys.length * gap : 0) + 900;
  setTimeout(() => {
    window.__READY__ = true;
  }, total);
});
