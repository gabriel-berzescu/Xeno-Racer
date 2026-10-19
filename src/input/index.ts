/**
 * Input system (owner: ui).
 *
 * `createInputSystem(controls)` polls the Gamepad API (Logitech F310 in X mode = `standard` mapping)
 * and the keyboard and turns them into one `InputFrame` per `poll(dt)`.
 *
 *  - The frame object is REUSED between polls (no per-frame allocation). Copy what you need to keep.
 *  - Analog driving values come from the device that was used last; one-shot edges (shift, camera,
 *    pause, ...) and menu navigation edges come from both devices at once.
 *  - No vehicle-aware steering filtering here: `steer` is stick -> radial dead zone -> response curve.
 *  - Directions: steer -1 = left, +1 = right. lookX +1 = stick right. lookY +1 = stick UP (so "look
 *    up" with `invertLookY` off); `invertLookY` flips it.
 *
 * Split screen (two players on one screen). `bindPlayers(a, b)` hands each seat a device, a pad (by `Gamepad.index`: two F310s
 * have the same id) or the keyboard, and from then on `players[seat]` is that seat's own frame, read from its device only (a pad
 * never reads the keyboard, the keyboard seat never reads a pad). `poll()` still returns the one merged frame that the menus and
 * the "somebody pressed pause" check use: its navigation is the union of both seats' devices and the keyboard, filtered by
 * `menuOwner` (a paused race follows the pad that paused it). A seat whose pad goes away keeps its seat and holds still
 * (`missingSeat()`); the pad coming back at the same index is that seat again, and a pad that turns up at another index is adopted
 * by the seat that is missing. The join step uses `beginJoin()` / `takeJoiner()`: the first other device to press A (a pad) or
 * Enter (the keyboard) is the second player. Not bound, everything above is idle and the input behaves as it always did.
 *
 * Bindings: see ./bindings.ts (the table the UI draws).
 */
import type { ControlSettings, InputFrame, Seat } from '../core/contracts';
import type { InputSystem } from '../core/systems';
import { DINPUT, STD } from './bindings';
import { clamp01, decodeHat, hysteresis, pedal, prettyPadName, radialDeadzone, RepeatEdge, responseCurve, stepToward } from './processing';

export { BINDINGS, MENU_KEYS, PAD_LABEL, STD, DINPUT } from './bindings';
export type { Binding, DrivingAction, MenuAction, PadControl } from './bindings';
export * from './processing';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** The part of a browser `Gamepad` this module needs (so tests can fake it). */
export interface PadLike {
  readonly id: string;
  readonly index: number;
  readonly connected: boolean;
  readonly mapping: string;
  readonly axes: ArrayLike<number>;
  readonly buttons: ArrayLike<{ readonly pressed: boolean; readonly value: number }>;
  readonly vibrationActuator?: { playEffect?: (type: string, params: unknown) => unknown } | null;
}

export interface InputEnv {
  getGamepads(): ArrayLike<PadLike | null>;
  /** Receives keydown / keyup / blur / gamepadconnected / gamepaddisconnected. */
  target: EventTarget;
}

/**
 * A device a seat plays on. A pad is identified by its `Gamepad.index` (two controllers of the same model have the same id, so the
 * id says nothing about which is which).
 */
export type PlayerSource = { kind: 'pad'; index: number } | { kind: 'keyboard' };

export interface XenoInputSystem extends InputSystem {
  /** The device that was used last. */
  readonly device: 'gamepad' | 'keyboard';
  /** Friendly name of the active gamepad ("Logitech Gamepad F310"), or null. */
  readonly padName: string | null;
  /** Non-null when the pad is not in `standard` mode (e.g. an F310 switched to D). Show it to the player. */
  readonly warning: string | null;
  readonly controls: ControlSettings;

  // ── split screen ──

  /** True while two seats are bound to two devices (`bindPlayers`). */
  readonly split: boolean;
  /**
   * The two drivers' own frames, filled by every `poll()` while `split` (reused objects, neutral otherwise). Seat s reads ONLY its
   * device: a pad never reads the keyboard, the keyboard seat never reads a pad. Analog driving values, one-shot edges (shiftUp,
   * shiftDown, cameraNext, resetCar, pause, toggleHud, toggleTelemetry, nextTrack, nitro), lookX / lookY / lookBack, `nav` and `anyPressed` of that
   * device; `gamepadId` is the seat's pad id (null for the keyboard seat, or for a pad that is gone), `device` is 'gamepad' or
   * 'keyboard' by the kind of the source.
   */
  readonly players: readonly [InputFrame, InputFrame];
  /** The device of each seat (null, null while not split). */
  readonly sources: readonly [PlayerSource | null, PlayerSource | null];
  /** The device the menus are being driven with: the pad in use (or the first one) if any pad is connected, else the keyboard. It becomes player 1 in a split. */
  primarySource(): PlayerSource;
  /** Seat 0 plays on `p1`, seat 1 on `p2`. Nothing happens if they are the same device. It ends the join step. */
  bindPlayers(p1: PlayerSource, p2: PlayerSource): void;
  /** Back to one player: the pad and the keyboard merge into the one frame again. */
  unbindPlayers(): void;
  /** The seats exchange devices (only while split). */
  swapPlayers(): void;
  /**
   * The join step. While joining, the first device other than `primarySource()` (and than a bound seat's) that asks is recorded: A
   * pressed on another pad (the press that revealed the pad counts: Chrome only shows a pad after a button press), or Enter on the
   * keyboard when the primary device is not the keyboard. Call `beginJoin()` after the frame's `poll()` (a press already polled does not count).
   */
  beginJoin(): void;
  endJoin(): void;
  readonly joining: boolean;
  /** The device that asked to join since the last call, once; then null. */
  takeJoiner(): PlayerSource | null;
  /** The menus follow this seat's device (and the keyboard, always) only; null = every connected device. Only counts while split. The game sets it to the seat whose pad paused a race. */
  menuOwner: Seat | null;
  /** "Logitech Gamepad F310", "Keyboard"; two connected pads with the same name get " (1)" / " (2)" by index so the screens can tell them apart; null for null. */
  deviceName(s: PlayerSource | null): string | null;
  /** Usable gamepads connected as of the last poll (the same filter as the one that picks the pad for the menus). */
  readonly padCount: number;
  /** While split: a seat whose pad has gone away and not come back (lowest seat first), else null. */
  missingSeat(): Seat | null;
  /** `seat` given while split: that seat's pad only (none for the keyboard seat); otherwise the pad the menus use, as ever. */
  rumble(strong: number, weak: number, durationMs: number, seat?: Seat): void;
}

/** True when two sources are the same device. */
export function sameSource(a: PlayerSource | null, b: PlayerSource | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === 'keyboard' ? b.kind === 'keyboard' : b.kind === 'pad' && a.index === b.index;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tuning
// ─────────────────────────────────────────────────────────────────────────────

/** Keyboard steering: seconds^-1 (full lock in ~0.29 s), and the faster recenter / cross-over rate. */
export const KB_STEER_RAMP = 3.5;
export const KB_STEER_RECENTER = 7;
export const KB_THROTTLE_UP = 6;
export const KB_THROTTLE_DOWN = 9;
export const KB_BRAKE_UP = 8;
export const KB_BRAKE_DOWN = 12;
export const KB_HANDBRAKE_RATE = 20;
export const KB_LOOK_UP = 9;
export const KB_LOOK_DOWN = 14;
export const LOOK_DEADZONE = 0.14;
/** Stick / trigger deflection that counts as "the player is using the pad" (above typical stick drift). */
export const PAD_WAKE_STICK = 0.35;
export const PAD_WAKE_TRIGGER = 0.2;

const WARN_F310 = 'Switch the Logitech F310 to X mode (slide the switch on the back to X, then reconnect it).';
const WARN_GENERIC = 'This controller is not using the standard layout. Some buttons may be mismatched; use an XInput (Xbox layout) controller.';

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

interface Pending {
  shiftUp: boolean; shiftDown: boolean; camera: boolean; reset: boolean; pause: boolean; hud: boolean; telemetry: boolean; nextTrack: boolean; nitro: boolean;
  confirm: boolean; back: boolean; tabLeft: boolean; tabRight: boolean;
  /** Arrow-key presses latched until the next poll, so a tap shorter than one frame still navigates. */
  navUp: boolean; navDown: boolean; navLeft: boolean; navRight: boolean;
}

type Nav = InputFrame['nav'];

const BUTTONS = 17;
/** Gamepad slots tracked (Chrome has four; a pad with a higher index is ignored). */
const MAX_PADS = 16;
const NO_PADS: ArrayLike<PadLike | null> = [];

/** Keys the game uses; only these get `preventDefault` (so the browser keeps F5, F11, F12, Tab, ...). */
const HANDLED_KEYS: ReadonlySet<string> = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
  'KeyE', 'KeyQ', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'KeyC', 'KeyR', 'KeyP', 'KeyH', 'KeyT', 'KeyN', 'KeyV', 'KeyI', 'KeyJ', 'KeyK', 'KeyL',
  'Escape', 'Enter', 'NumpadEnter', 'Backspace', 'PageUp', 'PageDown', 'BracketLeft', 'BracketRight',
]);

function typingTarget(t: EventTarget | null): boolean {
  const el = t as { tagName?: string; isContentEditable?: boolean; type?: string } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const ty = (el.type ?? 'text').toLowerCase();
    return !(ty === 'button' || ty === 'checkbox' || ty === 'radio' || ty === 'range' || ty === 'submit' || ty === 'reset' || ty === 'color' || ty === 'file' || ty === 'image');
  }
  return !!el.isContentEditable;
}

function defaultEnv(): InputEnv {
  return {
    getGamepads: () => {
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
          return navigator.getGamepads() as unknown as ArrayLike<PadLike | null>;
        }
      } catch {
        /* SecurityError (permissions policy / insecure context) */
      }
      return [];
    },
    target: typeof window !== 'undefined' ? window : new EventTarget(),
  };
}

// ── small frame helpers (allocation-free) ──

function makeNav(): Nav {
  return { up: false, down: false, left: false, right: false, confirm: false, back: false, tabLeft: false, tabRight: false };
}

function makeFrame(): InputFrame {
  return {
    device: 'keyboard',
    gamepadId: null,
    steer: 0, throttle: 0, brake: 0, handbrake: 0, clutch: 0,
    lookX: 0, lookY: 0, lookBack: false,
    shiftUp: false, shiftDown: false, cameraNext: false, resetCar: false, pause: false, toggleHud: false, toggleTelemetry: false, nextTrack: false, nitro: false,
    nav: makeNav(),
    anyPressed: false,
  };
}

function copyNav(to: Nav, from: Nav): void {
  to.up = from.up; to.down = from.down; to.left = from.left; to.right = from.right;
  to.confirm = from.confirm; to.back = from.back; to.tabLeft = from.tabLeft; to.tabRight = from.tabRight;
}

function orNav(to: Nav, from: Nav): void {
  to.up = to.up || from.up; to.down = to.down || from.down; to.left = to.left || from.left; to.right = to.right || from.right;
  to.confirm = to.confirm || from.confirm; to.back = to.back || from.back; to.tabLeft = to.tabLeft || from.tabLeft; to.tabRight = to.tabRight || from.tabRight;
}

/** A frame with nothing pressed (a pad that went away, or no split at all). */
function neutralFrame(f: InputFrame, device: 'gamepad' | 'keyboard'): void {
  f.device = device;
  f.gamepadId = null;
  f.steer = f.throttle = f.brake = f.handbrake = f.clutch = 0;
  f.lookX = f.lookY = 0;
  f.lookBack = false;
  f.shiftUp = f.shiftDown = f.cameraNext = f.resetCar = f.pause = f.toggleHud = f.toggleTelemetry = f.nextTrack = f.nitro = false;
  const n = f.nav;
  n.up = n.down = n.left = n.right = n.confirm = n.back = n.tabLeft = n.tabRight = false;
  f.anyPressed = false;
}

function isDown(b: PadLike['buttons'], i: number): number {
  const bt = b[i];
  return bt && (bt.pressed || bt.value > 0.5) ? 1 : 0;
}

/** Analog trigger value; digital pads that only set `pressed` count as fully pressed. */
function trig(b: PadLike['buttons'], i: number): number {
  const bt = b[i];
  if (!bt) return 0;
  return bt.value > 0 ? bt.value : bt.pressed ? 1 : 0;
}

// Sources are shared immutable objects (a seat's source is compared and handed out by reference all the time).
const KEYBOARD_SOURCE: PlayerSource = Object.freeze({ kind: 'keyboard' }) as PlayerSource;
const padSources: PlayerSource[] = [];
function padSource(index: number): PlayerSource {
  return (padSources[index] ??= Object.freeze({ kind: 'pad', index }) as PlayerSource);
}
function normSource(s: PlayerSource): PlayerSource {
  return s.kind === 'keyboard' ? KEYBOARD_SOURCE : padSource(s.index);
}

/**
 * One physical gamepad (by `Gamepad.index`), normalised to the standard layout whatever the pad really reports, with the button
 * state of this poll and the last, and the menu navigation state of its own (used while the screen is split: a one-player game
 * merges the pad and the keyboard into one set of repeat edges instead, see InputImpl.rUp).
 */
class PadReader {
  pad: PadLike | null = null;
  id = '';
  name: string | null = null;
  warn: string | null = null;
  std = true;
  /** A different device (or the first) turned up in this slot at this poll: it starts from "nothing pressed". */
  fresh = false;
  /** Scan bookkeeping: listed in this poll, there in the last, and newly there. */
  seen = false;
  wasPresent = false;
  appeared = false;
  readonly cur = new Uint8Array(BUTTONS);
  readonly prev = new Uint8Array(BUTTONS);
  lx = 0;
  ly = 0;
  rx = 0;
  ry = 0;
  lt = 0;
  rt = 0;
  /** Left stick as a direction with hysteresis, one axis at a time. */
  sx = 0;
  sy = 0;
  /** Menu auto-repeat of this pad alone: up, down, left, right. */
  readonly rep: readonly [RepeatEdge, RepeatEdge, RepeatEdge, RepeatEdge] = [new RepeatEdge(), new RepeatEdge(), new RepeatEdge(), new RepeatEdge()];
  private readonly hat = { up: false, down: false, left: false, right: false };

  constructor(readonly index: number) {}

  attach(p: PadLike): void {
    this.seen = true;
    this.fresh = this.pad === null || p.id !== this.id;
    if (this.fresh) {
      // A new pad: start from "nothing pressed" so a press that revealed it still counts as an edge.
      this.prev.fill(0);
      this.std = p.mapping === 'standard';
      this.id = p.id;
      this.name = prettyPadName(p.id);
      this.warn = this.std ? null : /f310|logitech/i.test(p.id) ? WARN_F310 : WARN_GENERIC;
      this.sx = this.sy = 0;
      this.resetRepeats();
    }
    this.pad = p;
  }

  detach(): void {
    this.pad = null;
    this.cur.fill(0);
    this.prev.fill(0);
    this.lx = this.ly = this.rx = this.ry = this.lt = this.rt = 0;
    this.sx = this.sy = 0;
    this.resetRepeats();
  }

  resetRepeats(): void {
    for (let i = 0; i < 4; i++) this.rep[i].reset();
  }

  /** Normalizes the pad into standard-layout button states + axes (so the rest of the code is layout-agnostic). */
  read(): void {
    const p = this.pad!;
    const b = p.buttons;
    const a = p.axes;
    const c = this.cur;
    c.fill(0);
    if (this.std) {
      for (let i = 0; i < BUTTONS && i < b.length; i++) c[i] = isDown(b, i);
      this.lt = trig(b, STD.lt);
      this.rt = trig(b, STD.rt);
      this.lx = a[STD.lx] || 0;
      this.ly = a[STD.ly] || 0;
      this.rx = a[STD.rx] || 0;
      this.ry = a[STD.ry] || 0;
      return;
    }
    // Best effort: F310 in D (DirectInput) mode.
    c[STD.a] = isDown(b, DINPUT.a); c[STD.b] = isDown(b, DINPUT.b); c[STD.x] = isDown(b, DINPUT.x); c[STD.y] = isDown(b, DINPUT.y);
    c[STD.lb] = isDown(b, DINPUT.lb); c[STD.rb] = isDown(b, DINPUT.rb);
    c[STD.lt] = isDown(b, DINPUT.lt); c[STD.rt] = isDown(b, DINPUT.rt);
    c[STD.back] = isDown(b, DINPUT.back); c[STD.start] = isDown(b, DINPUT.start);
    c[STD.lsClick] = isDown(b, DINPUT.lsClick); c[STD.rsClick] = isDown(b, DINPUT.rsClick);
    this.lt = trig(b, DINPUT.lt);
    this.rt = trig(b, DINPUT.rt);
    this.lx = a[DINPUT.lx] || 0;
    this.ly = a[DINPUT.ly] || 0;
    this.rx = a[DINPUT.rx] || 0;
    this.ry = (a.length > DINPUT.ryWide ? a[DINPUT.ryWide] : a[DINPUT.ryNarrow]) || 0;
    if (a.length > DINPUT.hat) {
      decodeHat(a[DINPUT.hat], this.hat);
      c[STD.dUp] = this.hat.up ? 1 : 0; c[STD.dDown] = this.hat.down ? 1 : 0;
      c[STD.dLeft] = this.hat.left ? 1 : 0; c[STD.dRight] = this.hat.right ? 1 : 0;
    } else if (b.length > 15) {
      c[STD.dUp] = isDown(b, 12); c[STD.dDown] = isDown(b, 13); c[STD.dLeft] = isDown(b, 14); c[STD.dRight] = isDown(b, 15);
    }
  }

  /** The left stick as a menu direction: the dominant axis only, with hysteresis. */
  updateStick(): void {
    const ax = Math.abs(this.lx);
    const ay = Math.abs(this.ly);
    if (ax >= ay) {
      this.sx = hysteresis(this.lx, this.sx);
      this.sy = 0;
    } else {
      this.sy = hysteresis(this.ly, this.sy);
      this.sx = 0;
    }
  }

  edge(i: number): boolean {
    return this.cur[i] === 1 && this.prev[i] === 0;
  }

  /** A button went down at this poll. */
  anyEdge(): boolean {
    for (let i = 0; i < BUTTONS; i++) if (this.cur[i] === 1 && this.prev[i] === 0) return true;
    return false;
  }

  /** The stick or a trigger is pushed past what drift could be: "the player is using this pad". */
  awake(): boolean {
    const mag = Math.sqrt(this.lx * this.lx + this.ly * this.ly);
    return mag > PAD_WAKE_STICK || this.lt > PAD_WAKE_TRIGGER || this.rt > PAD_WAKE_TRIGGER;
  }
}

class InputImpl implements XenoInputSystem {
  controls: ControlSettings;
  private readonly env: InputEnv;

  private dev: 'gamepad' | 'keyboard' = 'keyboard';

  // ── keyboard ──
  private readonly keys = new Set<string>();
  private readonly pend: Pending = { shiftUp: false, shiftDown: false, camera: false, reset: false, pause: false, hud: false, telemetry: false, nextTrack: false, nitro: false, confirm: false, back: false, tabLeft: false, tabRight: false, navUp: false, navDown: false, navLeft: false, navRight: false };
  private keyActivity = false;
  private kSteer = 0;
  private kThrottle = 0;
  private kBrake = 0;
  private kHand = 0;
  private kLookX = 0;
  private kLookY = 0;

  // ── gamepads ──
  /** Every pad seen so far, by Gamepad.index (kept when it goes away: its name and its place in a seat are remembered). */
  private readonly readers: (PadReader | undefined)[] = [];
  private readonly readerList: PadReader[] = [];
  /** The pad the menus and a one-player race use. It is sticky: it stays until it goes away. */
  private main: PadReader | null = null;
  private stickyIndex = -1;
  /** Stands in for the main pad while there is none: never pressed, never moved. */
  private readonly noPad = new PadReader(-1);
  private pads = 0;
  private readonly tmp: number[] = [0, 0];
  /** One player: the menu repeat of the main pad and the arrow keys together. */
  private readonly rUp = new RepeatEdge();
  private readonly rDown = new RepeatEdge();
  private readonly rLeft = new RepeatEdge();
  private readonly rRight = new RepeatEdge();

  // ── split screen ──
  private splitOn = false;
  private readonly seatSrc: [PlayerSource | null, PlayerSource | null] = [null, null];
  readonly players: readonly [InputFrame, InputFrame] = [makeFrame(), makeFrame()];
  menuOwner: Seat | null = null;
  private joinOn = false;
  private joiner: PlayerSource | null = null;
  /** The keyboard's own menu edges while split (it navigates whoever's menu it is). */
  private readonly kbNav = makeNav();
  private readonly kUp = new RepeatEdge();
  private readonly kDown = new RepeatEdge();
  private readonly kLeft = new RepeatEdge();
  private readonly kRight = new RepeatEdge();

  private readonly frame: InputFrame = makeFrame();

  private readonly onKeyDown = (e: Event): void => this.keyDown(e as KeyboardEvent);
  private readonly onKeyUp = (e: Event): void => this.keyUp(e as KeyboardEvent);
  private readonly onBlur = (): void => this.releaseAll();
  private readonly onPadConnect = (): void => {
    /* the next poll sees it; kept so a connect event wakes things up in browsers that need it */
  };

  constructor(controls: ControlSettings, env: Partial<InputEnv>) {
    this.controls = controls;
    const d = defaultEnv();
    this.env = { getGamepads: env.getGamepads ?? d.getGamepads, target: env.target ?? d.target };
    const t = this.env.target;
    t.addEventListener('keydown', this.onKeyDown);
    t.addEventListener('keyup', this.onKeyUp);
    t.addEventListener('blur', this.onBlur);
    t.addEventListener('gamepadconnected', this.onPadConnect);
    t.addEventListener('gamepaddisconnected', this.onPadConnect);
  }

  get connected(): boolean {
    return this.main !== null;
  }
  get device(): 'gamepad' | 'keyboard' {
    return this.dev;
  }
  get padName(): string | null {
    return this.main ? this.main.name : null;
  }
  get warning(): string | null {
    return this.main ? this.main.warn : null;
  }
  get split(): boolean {
    return this.splitOn;
  }
  get sources(): readonly [PlayerSource | null, PlayerSource | null] {
    return this.seatSrc;
  }
  get joining(): boolean {
    return this.joinOn;
  }
  get padCount(): number {
    return this.pads;
  }

  setControls(c: ControlSettings): void {
    this.controls = c;
  }

  rumble(strong: number, weak: number, durationMs: number, seat?: Seat): void {
    if (!this.controls.vibration) return;
    let r: PadReader | null = this.main;
    if (seat !== undefined && this.splitOn) {
      const src = this.seatSrc[seat];
      r = src !== null && src.kind === 'pad' ? this.readers[src.index] ?? null : null;
    }
    const act = r?.pad?.vibrationActuator;
    if (!act || typeof act.playEffect !== 'function') return; // the F310 has no motors: silent no-op
    try {
      const res = act.playEffect('dual-rumble', {
        startDelay: 0,
        duration: Math.max(0, durationMs),
        strongMagnitude: clamp01(strong),
        weakMagnitude: clamp01(weak),
      }) as Promise<unknown> | undefined;
      if (res && typeof res.catch === 'function') res.catch(() => undefined);
    } catch {
      /* unsupported effect type */
    }
  }

  dispose(): void {
    const t = this.env.target;
    t.removeEventListener('keydown', this.onKeyDown);
    t.removeEventListener('keyup', this.onKeyUp);
    t.removeEventListener('blur', this.onBlur);
    t.removeEventListener('gamepadconnected', this.onPadConnect);
    t.removeEventListener('gamepaddisconnected', this.onPadConnect);
    this.releaseAll();
  }

  // ── split screen: who plays on what ────────────────────────────────────────

  primarySource(): PlayerSource {
    if (this.splitOn && this.seatSrc[0] !== null) return this.seatSrc[0];
    return this.main ? padSource(this.main.index) : KEYBOARD_SOURCE;
  }

  bindPlayers(p1: PlayerSource, p2: PlayerSource): void {
    if (sameSource(p1, p2)) return;
    this.seatSrc[0] = normSource(p1);
    this.seatSrc[1] = normSource(p2);
    this.splitOn = true;
    this.joinOn = false;
    this.joiner = null;
    this.menuOwner = null;
    this.freshMenuState();
  }

  unbindPlayers(): void {
    this.seatSrc[0] = this.seatSrc[1] = null;
    this.splitOn = false;
    this.menuOwner = null;
    neutralFrame(this.players[0], 'keyboard');
    neutralFrame(this.players[1], 'keyboard');
    this.freshMenuState();
  }

  swapPlayers(): void {
    if (!this.splitOn) return;
    const t = this.seatSrc[0];
    this.seatSrc[0] = this.seatSrc[1];
    this.seatSrc[1] = t;
  }

  beginJoin(): void {
    this.joinOn = true;
    this.joiner = null;
  }

  endJoin(): void {
    this.joinOn = false;
    this.joiner = null;
  }

  takeJoiner(): PlayerSource | null {
    const j = this.joiner;
    this.joiner = null;
    return j;
  }

  deviceName(s: PlayerSource | null): string | null {
    if (s === null) return null;
    if (s.kind === 'keyboard') return 'Keyboard';
    const r = this.readers[s.index];
    if (!r || r.name === null) return null;
    if (r.pad === null) return r.name;
    // two controllers of one model: number them by slot
    let same = 0;
    let rank = 0;
    for (const q of this.readerList) {
      if (q.pad === null || q.name !== r.name) continue;
      same++;
      if (q.index < r.index) rank++;
    }
    return same > 1 ? `${r.name} (${rank + 1})` : r.name;
  }

  missingSeat(): Seat | null {
    if (!this.splitOn) return null;
    return this.firstMissingSeat();
  }

  /** The lowest seat whose pad is not there (-1 elsewhere is null). */
  private firstMissingSeat(): 0 | 1 | null {
    for (let s = 0; s < 2; s++) {
      const src = this.seatSrc[s];
      if (src !== null && src.kind === 'pad') {
        const r = this.readers[src.index];
        if (!r || r.pad === null) return s as 0 | 1;
      }
    }
    return null;
  }

  /** The pad of seat `s`, if it is a pad and it is there. */
  private seatPad(s: number): PadReader | null {
    const src = this.seatSrc[s];
    if (src === null || src.kind !== 'pad') return null;
    const r = this.readers[src.index];
    return r && r.pad !== null ? r : null;
  }

  private boundTo(index: number): boolean {
    for (let s = 0; s < 2; s++) {
      const src = this.seatSrc[s];
      if (this.splitOn && src !== null && src.kind === 'pad' && src.index === index) return true;
    }
    return false;
  }

  private keyboardBound(): boolean {
    return this.splitOn && (this.seatSrc[0]?.kind === 'keyboard' || this.seatSrc[1]?.kind === 'keyboard');
  }

  /** Binding or unbinding changes who navigates what: nothing held at that moment may fire as a new press. */
  private freshMenuState(): void {
    this.rUp.reset(); this.rDown.reset(); this.rLeft.reset(); this.rRight.reset();
    this.kUp.reset(); this.kDown.reset(); this.kLeft.reset(); this.kRight.reset();
    for (const r of this.readerList) r.resetRepeats();
  }

  // ── keyboard events ────────────────────────────────────────────────────────

  private keyDown(e: KeyboardEvent): void {
    if (typingTarget(e.target)) return;
    const code = e.code;
    if (!code) return;
    // Let the browser keep its own shortcuts: Alt+anything and Ctrl/Cmd+R (reload).
    const browserCombo = e.altKey || ((e.ctrlKey || e.metaKey) && code === 'KeyR');
    if (!browserCombo && HANDLED_KEYS.has(code)) e.preventDefault(); // never swallow F5 / F12 / Tab / ...
    this.keys.add(code);
    if (e.repeat) return; // OS auto-repeat: we generate our own repeats for menus
    this.keyActivity = true;
    const p = this.pend;
    switch (code) {
      case 'KeyE': p.nitro = true; p.tabRight = true; break;
      case 'ShiftLeft':
      case 'ShiftRight': p.shiftUp = true; break;
      case 'KeyQ': p.shiftDown = true; p.tabLeft = true; break;
      case 'ControlLeft':
      case 'ControlRight': p.shiftDown = true; break;
      case 'KeyC': p.camera = true; break;
      case 'KeyR': p.reset = true; break;
      case 'Escape': p.pause = true; p.back = true; break;
      case 'KeyP': p.pause = true; break;
      case 'KeyH': p.hud = true; break;
      case 'KeyT': p.telemetry = true; break;
      case 'KeyN': p.nextTrack = true; break;
      case 'Enter':
      case 'NumpadEnter': p.confirm = true; break;
      case 'Backspace': p.back = true; break;
      case 'PageUp':
      case 'BracketLeft': p.tabLeft = true; break;
      case 'PageDown':
      case 'BracketRight': p.tabRight = true; break;
      case 'ArrowUp': p.navUp = true; break;
      case 'ArrowDown': p.navDown = true; break;
      case 'ArrowLeft': p.navLeft = true; break;
      case 'ArrowRight': p.navRight = true; break;
    }
  }

  private keyUp(e: KeyboardEvent): void {
    if (e.code) this.keys.delete(e.code);
  }

  private releaseAll(): void {
    this.keys.clear();
    const p = this.pend;
    p.shiftUp = p.shiftDown = p.camera = p.reset = p.pause = p.hud = p.telemetry = p.nextTrack = p.nitro = p.confirm = p.back = p.tabLeft = p.tabRight = false;
    p.navUp = p.navDown = p.navLeft = p.navRight = false;
    this.keyActivity = false;
  }

  private down(code: string, alt?: string): boolean {
    return this.keys.has(code) || (alt !== undefined && this.keys.has(alt));
  }

  // ── gamepads ───────────────────────────────────────────────────────────────

  private reader(index: number): PadReader {
    let r = this.readers[index];
    if (!r) {
      r = new PadReader(index);
      this.readers[index] = r;
      this.readerList.push(r);
      this.readerList.sort((a, b) => a.index - b.index);
    }
    return r;
  }

  /**
   * Reads the pad list once: every usable pad gets its reader brought up to date, the pad for the menus is chosen (a standard-mapping
   * pad is preferred to anything else, and the one in use stays the one in use), and pads that went away are let go.
   */
  private scan(): void {
    let list: ArrayLike<PadLike | null>;
    try {
      list = this.env.getGamepads();
    } catch {
      list = NO_PADS;
    }
    const rl = this.readerList;
    for (let i = 0; i < rl.length; i++) {
      const r = rl[i];
      r.wasPresent = r.pad !== null;
      r.seen = false;
      r.appeared = false;
    }
    let firstStd: PadLike | null = null;
    let firstOther: PadLike | null = null;
    let sticky: PadLike | null = null;
    let usable = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || !p.connected || !(p.index >= 0 && p.index < MAX_PADS)) continue;
      if (p.mapping === 'standard') {
        if (!firstStd) firstStd = p;
        if (p.index === this.stickyIndex) sticky = p;
      } else if (p.axes.length >= 4 && p.buttons.length >= 8) {
        // Some mice / keyboards / receivers show up as "gamepads": only accept something shaped like a pad.
        if (!firstOther) firstOther = p;
      } else continue;
      usable++;
      const r = this.reader(p.index);
      r.attach(p);
      r.appeared = !r.wasPresent;
    }
    this.selectMain(sticky ?? firstStd ?? firstOther);
    for (let i = 0; i < rl.length; i++) {
      const r = rl[i];
      if (r.seen) {
        r.read();
        r.updateStick();
      } else if (r.pad !== null) r.detach();
    }
    this.pads = usable;
  }

  private selectMain(p: PadLike | null): void {
    if (p === null) {
      this.main = null;
      this.stickyIndex = -1;
      return;
    }
    const r = this.readers[p.index]!;
    if (this.main !== r || r.fresh) {
      // A new pad: start from "nothing pressed" so a press that revealed it still counts as an edge.
      r.prev.fill(0);
      this.rUp.reset(); this.rDown.reset(); this.rLeft.reset(); this.rRight.reset();
    }
    this.main = r;
    this.stickyIndex = r.index;
  }

  // ── poll ───────────────────────────────────────────────────────────────────

  poll(dtIn: number): InputFrame {
    const dt = dtIn > 0 ? (dtIn > 0.1 ? 0.1 : dtIn) : 0;
    const c = this.controls;
    const f = this.frame;
    const p = this.pend;
    // who the menus were driven with before this poll: a pad revealed now must not count as the device it takes the menus over from
    const primaryBefore = this.joinOn ? this.primarySource() : null;

    // 1. pad state
    this.scan();
    const split = this.splitOn;
    if (split) this.adoptReturningPads();
    const m = this.main ?? this.noPad;
    let padActive = false;
    let padPressed = false;
    if (split) {
      for (let s = 0; s < 2; s++) {
        const r = this.seatPad(s);
        if (r === null) continue;
        if (r.anyEdge()) {
          padPressed = true;
          padActive = true;
        }
        if (r.awake()) padActive = true;
      }
    } else if (this.main) {
      if (m.anyEdge()) {
        padPressed = true;
        padActive = true;
      }
      if (m.awake()) padActive = true;
    }

    // 2. device switch: whichever was used last
    const keyActive = this.keyActivity;
    if (padActive && !keyActive) this.dev = 'gamepad';
    else if (keyActive && !padActive) this.dev = 'keyboard';

    // 3. keyboard ramps (always integrated so a device switch never starts from a stale value)
    const kl = this.down('KeyA', 'ArrowLeft');
    const kr = this.down('KeyD', 'ArrowRight');
    const steerTarget = (kr ? 1 : 0) - (kl ? 1 : 0);
    const crossing = this.kSteer * steerTarget < 0;
    this.kSteer = stepToward(this.kSteer, steerTarget, steerTarget === 0 || crossing ? KB_STEER_RECENTER : KB_STEER_RAMP, dt);
    const thrT = this.down('KeyW', 'ArrowUp') ? 1 : 0;
    const brkT = this.down('KeyS', 'ArrowDown') ? 1 : 0;
    this.kThrottle = stepToward(this.kThrottle, thrT, thrT > this.kThrottle ? KB_THROTTLE_UP : KB_THROTTLE_DOWN, dt);
    this.kBrake = stepToward(this.kBrake, brkT, brkT > this.kBrake ? KB_BRAKE_UP : KB_BRAKE_DOWN, dt);
    this.kHand = stepToward(this.kHand, this.down('Space') ? 1 : 0, KB_HANDBRAKE_RATE, dt);
    const lxT = (this.down('KeyL') ? 1 : 0) - (this.down('KeyJ') ? 1 : 0);
    const lyT = (this.down('KeyI') ? 1 : 0) - (this.down('KeyK') ? 1 : 0);
    this.kLookX = stepToward(this.kLookX, lxT, lxT === 0 ? KB_LOOK_DOWN : KB_LOOK_UP, dt);
    this.kLookY = stepToward(this.kLookY, lyT, lyT === 0 ? KB_LOOK_DOWN : KB_LOOK_UP, dt);

    if (split) this.pollSplit(f, dt);
    else this.pollSingle(f, m, c, dt);

    f.anyPressed = padPressed || keyActive;

    if (this.joinOn) this.detectJoiner(primaryBefore);

    // 7. consume
    p.shiftUp = p.shiftDown = p.camera = p.reset = p.pause = p.hud = p.telemetry = p.nextTrack = p.nitro = p.confirm = p.back = p.tabLeft = p.tabRight = false;
    p.navUp = p.navDown = p.navLeft = p.navRight = false;
    this.keyActivity = false;
    const rl = this.readerList;
    for (let i = 0; i < rl.length; i++) rl[i].prev.set(rl[i].cur);
    return f;
  }

  /** One player: the pad that is in use and the keyboard, merged into the one frame (what the input has always done). */
  private pollSingle(f: InputFrame, m: PadReader, c: ControlSettings, dt: number): void {
    const nav = f.nav;
    const p = this.pend;

    // 4. analog values from the active device
    f.device = this.dev;
    f.gamepadId = m.pad ? m.pad.id : null;
    f.clutch = 0;
    if (this.dev === 'gamepad' && this.main) {
      radialDeadzone(m.lx, m.ly, c.steerDeadzone, this.tmp);
      f.steer = responseCurve(this.tmp[0], c.steerLinearity);
      f.throttle = pedal(m.rt, c.pedalDeadzone);
      f.brake = pedal(m.lt, c.pedalDeadzone);
      f.handbrake = m.cur[STD.a];
      radialDeadzone(m.rx, m.ry, LOOK_DEADZONE, this.tmp);
      f.lookX = this.tmp[0];
      f.lookY = c.invertLookY ? this.tmp[1] : -this.tmp[1];
      f.lookBack = m.cur[STD.rsClick] === 1;
    } else {
      f.steer = this.kSteer;
      f.throttle = this.kThrottle;
      f.brake = this.kBrake;
      f.handbrake = this.kHand;
      f.lookX = this.kLookX;
      f.lookY = c.invertLookY ? -this.kLookY : this.kLookY;
      f.lookBack = this.down('KeyV');
    }

    // 5. one-shot edges: union of both devices
    f.shiftUp = m.edge(STD.rb) || p.shiftUp;
    f.nitro = m.edge(STD.b) || p.nitro;
    f.shiftDown = m.edge(STD.lb) || m.edge(STD.x) || p.shiftDown;
    f.cameraNext = m.edge(STD.y) || p.camera;
    f.resetCar = m.edge(STD.back) || p.reset;
    f.pause = m.edge(STD.start) || p.pause;
    f.toggleHud = m.edge(STD.dUp) || p.hud;
    f.toggleTelemetry = m.edge(STD.dDown) || p.telemetry;
    f.nextTrack = m.edge(STD.dRight) || p.nextTrack;

    // 6. menu navigation: D-pad / left stick / arrow keys with auto-repeat
    const cu = m.cur;
    nav.up = this.rUp.update(cu[STD.dUp] === 1 || m.sy < 0 || this.keys.has('ArrowUp') || p.navUp, dt);
    nav.down = this.rDown.update(cu[STD.dDown] === 1 || m.sy > 0 || this.keys.has('ArrowDown') || p.navDown, dt);
    nav.left = this.rLeft.update(cu[STD.dLeft] === 1 || m.sx < 0 || this.keys.has('ArrowLeft') || p.navLeft, dt);
    nav.right = this.rRight.update(cu[STD.dRight] === 1 || m.sx > 0 || this.keys.has('ArrowRight') || p.navRight, dt);
    nav.confirm = m.edge(STD.a) || m.edge(STD.start) || p.confirm;
    nav.back = m.edge(STD.b) || p.back;
    nav.tabLeft = m.edge(STD.lb) || p.tabLeft;
    nav.tabRight = m.edge(STD.rb) || p.tabRight;
  }

  /**
   * Two seats: each frame comes from its own device, and the merged frame is made from them. Every device's menu edges are
   * advanced on every poll whoever is allowed to use them, so a held direction keeps its auto-repeat rhythm when the owner of the
   * menus changes or a device goes away, and nothing fires as a new press because of that.
   */
  private pollSplit(f: InputFrame, dt: number): void {
    const p = this.pend;
    const kb = this.kbNav;
    kb.up = this.kUp.update(this.keys.has('ArrowUp') || p.navUp, dt);
    kb.down = this.kDown.update(this.keys.has('ArrowDown') || p.navDown, dt);
    kb.left = this.kLeft.update(this.keys.has('ArrowLeft') || p.navLeft, dt);
    kb.right = this.kRight.update(this.keys.has('ArrowRight') || p.navRight, dt);
    kb.confirm = p.confirm;
    kb.back = p.back;
    kb.tabLeft = p.tabLeft;
    kb.tabRight = p.tabRight;

    this.fillSeat(0, dt);
    this.fillSeat(1, dt);
    const s0 = this.players[0];
    const s1 = this.players[1];

    // The merged frame. Driving values are player 1's, a one-shot edge is either player's, pause is anybody's (the keyboard's too).
    f.device = this.dev;
    f.gamepadId = this.mergedPadId();
    f.clutch = 0;
    f.steer = s0.steer;
    f.throttle = s0.throttle;
    f.brake = s0.brake;
    f.handbrake = s0.handbrake;
    f.lookX = s0.lookX;
    f.lookY = s0.lookY;
    f.lookBack = s0.lookBack;
    f.shiftUp = s0.shiftUp || s1.shiftUp;
    f.shiftDown = s0.shiftDown || s1.shiftDown;
    f.cameraNext = s0.cameraNext || s1.cameraNext;
    f.resetCar = s0.resetCar || s1.resetCar;
    f.toggleHud = s0.toggleHud || s1.toggleHud;
    f.toggleTelemetry = s0.toggleTelemetry || s1.toggleTelemetry;
    f.nextTrack = s0.nextTrack || s1.nextTrack;
    f.nitro = s0.nitro || s1.nitro;
    f.pause = s0.pause || s1.pause || p.pause;

    // The menus: the keyboard always, and the devices the owner of the menus allows. An owner whose pad has gone cannot navigate
    // anything, so until it is back any device may (the pause menu that follows the pad which paused must not be stuck on a dead pad).
    let owner = this.menuOwner;
    if (owner !== null && this.seatSrc[owner]?.kind === 'pad' && this.seatPad(owner) === null) owner = null;
    copyNav(f.nav, kb);
    if (owner === null || owner === 0) orNav(f.nav, s0.nav);
    if (owner === null || owner === 1) orNav(f.nav, s1.nav);
  }

  private mergedPadId(): string | null {
    const r0 = this.seatPad(0);
    if (r0 !== null) return r0.pad!.id;
    // player 1 plays on the keyboard: the controller that is there is the other player's
    if (this.seatSrc[0]?.kind === 'keyboard') {
      const r1 = this.seatPad(1);
      if (r1 !== null) return r1.pad!.id;
    }
    return null;
  }

  private fillSeat(s: 0 | 1, dt: number): void {
    const src = this.seatSrc[s];
    const fr = this.players[s];
    if (src === null) {
      neutralFrame(fr, 'keyboard');
      return;
    }
    if (src.kind === 'keyboard') {
      this.fillKeyboard(fr);
      return;
    }
    const r = this.readers[src.index];
    if (r && r.pad !== null) this.fillPad(fr, r, dt);
    else neutralFrame(fr, 'gamepad'); // the pad is gone: the seat holds still
  }

  private fillPad(f: InputFrame, r: PadReader, dt: number): void {
    const c = this.controls;
    const tmp = this.tmp;
    f.device = 'gamepad';
    f.gamepadId = r.pad!.id;
    radialDeadzone(r.lx, r.ly, c.steerDeadzone, tmp);
    f.steer = responseCurve(tmp[0], c.steerLinearity);
    f.throttle = pedal(r.rt, c.pedalDeadzone);
    f.brake = pedal(r.lt, c.pedalDeadzone);
    f.handbrake = r.cur[STD.a];
    f.clutch = 0;
    radialDeadzone(r.rx, r.ry, LOOK_DEADZONE, tmp);
    f.lookX = tmp[0];
    f.lookY = c.invertLookY ? tmp[1] : -tmp[1];
    f.lookBack = r.cur[STD.rsClick] === 1;
    f.shiftUp = r.edge(STD.rb);
    f.nitro = r.edge(STD.b);
    f.shiftDown = r.edge(STD.lb) || r.edge(STD.x);
    f.cameraNext = r.edge(STD.y);
    f.resetCar = r.edge(STD.back);
    f.pause = r.edge(STD.start);
    f.toggleHud = r.edge(STD.dUp);
    f.toggleTelemetry = r.edge(STD.dDown);
    f.nextTrack = r.edge(STD.dRight);
    const n = f.nav;
    const cu = r.cur;
    n.up = r.rep[0].update(cu[STD.dUp] === 1 || r.sy < 0, dt);
    n.down = r.rep[1].update(cu[STD.dDown] === 1 || r.sy > 0, dt);
    n.left = r.rep[2].update(cu[STD.dLeft] === 1 || r.sx < 0, dt);
    n.right = r.rep[3].update(cu[STD.dRight] === 1 || r.sx > 0, dt);
    n.confirm = r.edge(STD.a) || r.edge(STD.start);
    n.back = r.edge(STD.b);
    n.tabLeft = r.edge(STD.lb);
    n.tabRight = r.edge(STD.rb);
    f.anyPressed = r.anyEdge();
  }

  private fillKeyboard(f: InputFrame): void {
    const c = this.controls;
    const p = this.pend;
    f.device = 'keyboard';
    f.gamepadId = null;
    f.steer = this.kSteer;
    f.throttle = this.kThrottle;
    f.brake = this.kBrake;
    f.handbrake = this.kHand;
    f.clutch = 0;
    f.lookX = this.kLookX;
    f.lookY = c.invertLookY ? -this.kLookY : this.kLookY;
    f.lookBack = this.down('KeyV');
    f.shiftUp = p.shiftUp;
    f.nitro = p.nitro;
    f.shiftDown = p.shiftDown;
    f.cameraNext = p.camera;
    f.resetCar = p.reset;
    f.pause = p.pause;
    f.toggleHud = p.hud;
    f.toggleTelemetry = p.telemetry;
    f.nextTrack = p.nextTrack;
    copyNav(f.nav, this.kbNav);
    f.anyPressed = this.keyActivity;
  }

  /**
   * A seat's pad that went away and a pad that turns up at another index: it takes the place of the seat that is missing (the lowest
   * one when both are). A pad that comes back at its own index is that seat again without any of this, and a pad that is bound to a
   * seat is never given to the other.
   */
  private adoptReturningPads(): void {
    const rl = this.readerList;
    for (let i = 0; i < rl.length; i++) {
      const r = rl[i];
      if (!r.appeared || r.pad === null || this.boundTo(r.index)) continue;
      const s = this.firstMissingSeat();
      if (s === null) continue;
      this.seatSrc[s] = padSource(r.index);
      r.resetRepeats();
    }
  }

  /** While joining: the first device other than the primary one (and than a seat's) to press A (a pad) or Enter (the keyboard). */
  private detectJoiner(primary: PlayerSource | null): void {
    if (this.joiner !== null) return;
    const rl = this.readerList;
    for (let i = 0; i < rl.length; i++) {
      const r = rl[i];
      if (r.pad === null || this.boundTo(r.index)) continue;
      if (primary !== null && primary.kind === 'pad' && primary.index === r.index) continue;
      if (r.edge(STD.a)) {
        this.joiner = padSource(r.index);
        return;
      }
    }
    if (this.pend.confirm && primary !== null && primary.kind !== 'keyboard' && !this.keyboardBound()) this.joiner = KEYBOARD_SOURCE;
  }
}

/**
 * @param controls live control settings (the object is read every poll, so mutating it in place also works)
 * @param env      injectable gamepad source + event target, for tests. Defaults to `navigator` / `window`.
 */
export function createInputSystem(controls: ControlSettings, env: Partial<InputEnv> = {}): XenoInputSystem {
  return new InputImpl(controls, env);
}
