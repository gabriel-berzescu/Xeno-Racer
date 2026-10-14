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
 * Bindings: see ./bindings.ts (the table the UI draws).
 */
import type { ControlSettings, InputFrame } from '../core/contracts';
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

export interface XenoInputSystem extends InputSystem {
  /** The device that was used last. */
  readonly device: 'gamepad' | 'keyboard';
  /** Friendly name of the active gamepad ("Logitech Gamepad F310"), or null. */
  readonly padName: string | null;
  /** Non-null when the pad is not in `standard` mode (e.g. an F310 switched to D). Show it to the player. */
  readonly warning: string | null;
  readonly controls: ControlSettings;
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
  shiftUp: boolean; shiftDown: boolean; camera: boolean; reset: boolean; pause: boolean; hud: boolean; telemetry: boolean;
  confirm: boolean; back: boolean; tabLeft: boolean; tabRight: boolean;
  /** Arrow-key presses latched until the next poll, so a tap shorter than one frame still navigates. */
  navUp: boolean; navDown: boolean; navLeft: boolean; navRight: boolean;
}

const BUTTONS = 17;

/** Keys the game uses; only these get `preventDefault` (so the browser keeps F5, F11, F12, Tab, ...). */
const HANDLED_KEYS: ReadonlySet<string> = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
  'KeyE', 'KeyQ', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'KeyC', 'KeyR', 'KeyP', 'KeyH', 'KeyT', 'KeyV', 'KeyI', 'KeyJ', 'KeyK', 'KeyL',
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

class InputImpl implements XenoInputSystem {
  controls: ControlSettings;
  private readonly env: InputEnv;

  private dev: 'gamepad' | 'keyboard' = 'keyboard';

  // ── keyboard ──
  private readonly keys = new Set<string>();
  private readonly pend: Pending = { shiftUp: false, shiftDown: false, camera: false, reset: false, pause: false, hud: false, telemetry: false, confirm: false, back: false, tabLeft: false, tabRight: false, navUp: false, navDown: false, navLeft: false, navRight: false };
  private keyActivity = false;
  private kSteer = 0;
  private kThrottle = 0;
  private kBrake = 0;
  private kHand = 0;
  private kLookX = 0;
  private kLookY = 0;

  // ── gamepad ──
  private pad: PadLike | null = null;
  private padIndex = -1;
  private padStd = true;
  private warn: string | null = null;
  private name: string | null = null;
  private readonly cur = new Uint8Array(BUTTONS);
  private readonly prev = new Uint8Array(BUTTONS);
  private lx = 0;
  private ly = 0;
  private rx = 0;
  private ry = 0;
  private lt = 0;
  private rt = 0;
  private readonly tmp: number[] = [0, 0];
  private readonly hat = { up: false, down: false, left: false, right: false };
  private sx = 0;
  private sy = 0;
  private readonly rUp = new RepeatEdge();
  private readonly rDown = new RepeatEdge();
  private readonly rLeft = new RepeatEdge();
  private readonly rRight = new RepeatEdge();

  private readonly frame: InputFrame = {
    device: 'keyboard',
    gamepadId: null,
    steer: 0, throttle: 0, brake: 0, handbrake: 0, clutch: 0,
    lookX: 0, lookY: 0, lookBack: false,
    shiftUp: false, shiftDown: false, cameraNext: false, resetCar: false, pause: false, toggleHud: false, toggleTelemetry: false,
    nav: { up: false, down: false, left: false, right: false, confirm: false, back: false, tabLeft: false, tabRight: false },
    anyPressed: false,
  };

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
    return this.pad !== null;
  }
  get device(): 'gamepad' | 'keyboard' {
    return this.dev;
  }
  get padName(): string | null {
    return this.name;
  }
  get warning(): string | null {
    return this.warn;
  }

  setControls(c: ControlSettings): void {
    this.controls = c;
  }

  rumble(strong: number, weak: number, durationMs: number): void {
    if (!this.controls.vibration) return;
    const act = this.pad?.vibrationActuator;
    if (!act || typeof act.playEffect !== 'function') return; // the F310 has no motors: silent no-op
    try {
      const r = act.playEffect('dual-rumble', {
        startDelay: 0,
        duration: Math.max(0, durationMs),
        strongMagnitude: clamp01(strong),
        weakMagnitude: clamp01(weak),
      }) as Promise<unknown> | undefined;
      if (r && typeof r.catch === 'function') r.catch(() => undefined);
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
      case 'KeyE': p.shiftUp = true; p.tabRight = true; break;
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
    p.shiftUp = p.shiftDown = p.camera = p.reset = p.pause = p.hud = p.telemetry = p.confirm = p.back = p.tabLeft = p.tabRight = false;
    p.navUp = p.navDown = p.navLeft = p.navRight = false;
    this.keyActivity = false;
  }

  private down(code: string, alt?: string): boolean {
    return this.keys.has(code) || (alt !== undefined && this.keys.has(alt));
  }

  // ── gamepad ────────────────────────────────────────────────────────────────

  private pickPad(): PadLike | null {
    let list: ArrayLike<PadLike | null>;
    try {
      list = this.env.getGamepads();
    } catch {
      list = [];
    }
    let firstStd: PadLike | null = null;
    let firstOther: PadLike | null = null;
    let sticky: PadLike | null = null;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || !p.connected) continue;
      if (p.mapping === 'standard') {
        if (!firstStd) firstStd = p;
        if (p.index === this.padIndex) sticky = p;
      } else if (!firstOther && p.axes.length >= 4 && p.buttons.length >= 8) {
        // Some mice / keyboards / receivers show up as "gamepads": only accept something shaped like a pad.
        firstOther = p;
      }
    }
    return sticky ?? firstStd ?? firstOther;
  }

  private selectPad(p: PadLike | null): void {
    if (p === null) {
      if (this.pad !== null) this.prev.fill(0);
      this.pad = null;
      this.padIndex = -1;
      this.warn = null;
      this.name = null;
      return;
    }
    if (this.pad === null || p.index !== this.padIndex || p.id !== this.pad.id) {
      // A new pad: start from "nothing pressed" so a press that revealed it still counts as an edge.
      this.prev.fill(0);
      this.padIndex = p.index;
      this.padStd = p.mapping === 'standard';
      this.name = prettyPadName(p.id);
      this.warn = this.padStd ? null : /f310|logitech/i.test(p.id) ? WARN_F310 : WARN_GENERIC;
      this.rUp.reset(); this.rDown.reset(); this.rLeft.reset(); this.rRight.reset();
    }
    this.pad = p;
  }

  private static isDown(b: PadLike['buttons'], i: number): number {
    const bt = b[i];
    return bt && (bt.pressed || bt.value > 0.5) ? 1 : 0;
  }

  /** Analog trigger value; digital pads that only set `pressed` count as fully pressed. */
  private static trig(b: PadLike['buttons'], i: number): number {
    const bt = b[i];
    if (!bt) return 0;
    return bt.value > 0 ? bt.value : bt.pressed ? 1 : 0;
  }

  /** Normalizes the pad into standard-layout button states + axes (so the rest of the code is layout-agnostic). */
  private readPad(p: PadLike): void {
    const b = p.buttons;
    const a = p.axes;
    const c = this.cur;
    const isDown = InputImpl.isDown;
    const trig = InputImpl.trig;
    c.fill(0);
    if (this.padStd) {
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

  private edge(i: number): boolean {
    return this.cur[i] === 1 && this.prev[i] === 0;
  }

  // ── poll ───────────────────────────────────────────────────────────────────

  poll(dtIn: number): InputFrame {
    const dt = dtIn > 0 ? (dtIn > 0.1 ? 0.1 : dtIn) : 0;
    const c = this.controls;
    const f = this.frame;
    const nav = f.nav;
    const p = this.pend;

    // 1. pad state
    this.selectPad(this.pickPad());
    let padActive = false;
    let padPressed = false;
    if (this.pad) {
      this.readPad(this.pad);
      for (let i = 0; i < BUTTONS; i++) {
        if (this.cur[i] === 1 && this.prev[i] === 0) {
          padPressed = true;
          padActive = true;
        }
      }
      const mag = Math.sqrt(this.lx * this.lx + this.ly * this.ly);
      if (mag > PAD_WAKE_STICK || this.lt > PAD_WAKE_TRIGGER || this.rt > PAD_WAKE_TRIGGER) padActive = true;
    } else {
      this.cur.fill(0);
      this.lx = this.ly = this.rx = this.ry = this.lt = this.rt = 0;
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

    // 4. analog values from the active device
    f.device = this.dev;
    f.gamepadId = this.pad ? this.pad.id : null;
    f.clutch = 0;
    if (this.dev === 'gamepad' && this.pad) {
      radialDeadzone(this.lx, this.ly, c.steerDeadzone, this.tmp);
      f.steer = responseCurve(this.tmp[0], c.steerLinearity);
      f.throttle = pedal(this.rt, c.pedalDeadzone);
      f.brake = pedal(this.lt, c.pedalDeadzone);
      f.handbrake = this.cur[STD.a];
      radialDeadzone(this.rx, this.ry, LOOK_DEADZONE, this.tmp);
      f.lookX = this.tmp[0];
      f.lookY = c.invertLookY ? this.tmp[1] : -this.tmp[1];
      f.lookBack = this.cur[STD.rsClick] === 1;
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
    f.shiftUp = this.edge(STD.rb) || this.edge(STD.b) || p.shiftUp;
    f.shiftDown = this.edge(STD.lb) || this.edge(STD.x) || p.shiftDown;
    f.cameraNext = this.edge(STD.y) || p.camera;
    f.resetCar = this.edge(STD.back) || p.reset;
    f.pause = this.edge(STD.start) || p.pause;
    f.toggleHud = this.edge(STD.dUp) || p.hud;
    f.toggleTelemetry = this.edge(STD.dDown) || p.telemetry;

    // 6. menu navigation: D-pad / left stick / arrow keys with auto-repeat
    const ax = Math.abs(this.lx);
    const ay = Math.abs(this.ly);
    if (ax >= ay) {
      this.sx = hysteresis(this.lx, this.sx);
      this.sy = 0;
    } else {
      this.sy = hysteresis(this.ly, this.sy);
      this.sx = 0;
    }
    const cu = this.cur;
    nav.up = this.rUp.update(cu[STD.dUp] === 1 || this.sy < 0 || this.keys.has('ArrowUp') || p.navUp, dt);
    nav.down = this.rDown.update(cu[STD.dDown] === 1 || this.sy > 0 || this.keys.has('ArrowDown') || p.navDown, dt);
    nav.left = this.rLeft.update(cu[STD.dLeft] === 1 || this.sx < 0 || this.keys.has('ArrowLeft') || p.navLeft, dt);
    nav.right = this.rRight.update(cu[STD.dRight] === 1 || this.sx > 0 || this.keys.has('ArrowRight') || p.navRight, dt);
    nav.confirm = this.edge(STD.a) || this.edge(STD.start) || p.confirm;
    nav.back = this.edge(STD.b) || p.back;
    nav.tabLeft = this.edge(STD.lb) || p.tabLeft;
    nav.tabRight = this.edge(STD.rb) || p.tabRight;

    f.anyPressed = padPressed || keyActive;

    // 7. consume
    p.shiftUp = p.shiftDown = p.camera = p.reset = p.pause = p.hud = p.telemetry = p.confirm = p.back = p.tabLeft = p.tabRight = false;
    p.navUp = p.navDown = p.navLeft = p.navRight = false;
    this.keyActivity = false;
    this.prev.set(this.cur);
    return f;
  }
}

/**
 * @param controls live control settings (the object is read every poll, so mutating it in place also works)
 * @param env      injectable gamepad source + event target, for tests. Defaults to `navigator` / `window`.
 */
export function createInputSystem(controls: ControlSettings, env: Partial<InputEnv> = {}): XenoInputSystem {
  return new InputImpl(controls, env);
}
