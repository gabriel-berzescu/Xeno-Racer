/**
 * Split-screen input: two seats bound to two devices (two pads, or a pad and the keyboard), the join step, the menus that follow
 * whoever may navigate them, and a controller that is unplugged and plugged in again. The one-player behaviour is in input.test.ts;
 * here it only has to stay what it was while all of this exists.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ControlSettings } from '../src/core/contracts';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { createInputSystem, sameSource, STD, type InputEnv, type PadLike, type PlayerSource, type XenoInputSystem } from '../src/input';

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

interface FakePad extends Omit<PadLike, 'vibrationActuator' | 'axes' | 'buttons' | 'connected'> {
  axes: number[];
  buttons: { pressed: boolean; touched: boolean; value: number }[];
  connected: boolean;
  vibrationActuator: { playEffect: ReturnType<typeof vi.fn> } | null;
}

/** Two real F310s report the very same id; only the index tells them apart. */
const F310 = 'Logitech Gamepad F310 (STANDARD GAMEPAD Vendor: 046d Product: c21d)';

function fakePad(index: number, opts: { id?: string; mapping?: string; axes?: number; buttons?: number; rumble?: boolean } = {}): FakePad {
  return {
    id: opts.id ?? F310,
    index,
    connected: true,
    mapping: opts.mapping ?? 'standard',
    axes: new Array(opts.axes ?? 4).fill(0),
    buttons: Array.from({ length: opts.buttons ?? 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    vibrationActuator: opts.rumble ? { playEffect: vi.fn(async () => 'complete') } : null,
  };
}

function setBtn(p: FakePad, i: number, v: number | boolean): void {
  const n = typeof v === 'boolean' ? (v ? 1 : 0) : v;
  p.buttons[i].pressed = n > 0.5;
  p.buttons[i].value = n;
}

function setup(over: Partial<ControlSettings> = {}) {
  const slots: (FakePad | null)[] = [null, null, null, null];
  const target = new EventTarget();
  const env: InputEnv = { getGamepads: () => slots as unknown as ArrayLike<PadLike | null>, target };
  const controls: ControlSettings = { ...DEFAULT_SETTINGS.controls, ...over };
  const input = createInputSystem(controls, env);
  return { input, slots, target, controls };
}

function key(target: EventTarget, type: 'keydown' | 'keyup', code: string, extra: Record<string, unknown> = {}): Event {
  const ev = Object.assign(new Event(type, { cancelable: true }), { code, key: '', repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }, extra);
  target.dispatchEvent(ev);
  return ev;
}

/** Poll `seconds` of time at 60 Hz, return the last frame. */
function run(input: XenoInputSystem, seconds: number) {
  let f = input.poll(0);
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) f = input.poll(1 / 60);
  return f;
}

const PAD0: PlayerSource = { kind: 'pad', index: 0 };
const PAD1: PlayerSource = { kind: 'pad', index: 1 };
const KEYBOARD: PlayerSource = { kind: 'keyboard' };

/** Two connected pads, seen by one poll, and bound: pad 0 is player 1, pad 1 is player 2. */
function twoPads(opts: { rumble?: boolean } = {}) {
  const s = setup();
  const a = fakePad(0, opts);
  const b = fakePad(1, opts);
  s.slots[0] = a;
  s.slots[1] = b;
  s.input.poll(1 / 60);
  s.input.bindPlayers(PAD0, PAD1);
  s.input.poll(1 / 60);
  return { ...s, a, b };
}

/** A pad for player 1 and the keyboard for player 2. */
function padAndKeyboard() {
  const s = setup();
  const a = fakePad(0);
  s.slots[0] = a;
  s.input.poll(1 / 60);
  s.input.bindPlayers(PAD0, KEYBOARD);
  s.input.poll(1 / 60);
  return { ...s, a };
}

// ─────────────────────────────────────────────────────────────────────────────
// two pads
// ─────────────────────────────────────────────────────────────────────────────

describe('two pads, two seats', () => {
  it('starts with nobody in a seat, no owner and no join step', () => {
    const { input } = setup();
    expect(input.split).toBe(false);
    expect(input.joining).toBe(false);
    expect(input.menuOwner).toBeNull();
    expect(input.padCount).toBe(0);
    expect(input.sources).toEqual([null, null]);
  });

  it('binds both seats and reports them', () => {
    const { input } = twoPads();
    expect(input.split).toBe(true);
    expect(input.sources).toEqual([PAD0, PAD1]);
    expect(input.players[0].device).toBe('gamepad');
    expect(input.players[1].gamepadId).toBe(F310);
  });

  it('gives each seat only the axes of its own pad', () => {
    const { input, a, b } = twoPads();
    a.axes[0] = 1;
    setBtn(a, STD.lt, 1);
    b.axes[0] = -0.5;
    setBtn(b, STD.rt, 0.5);
    input.poll(1 / 60);
    const [p1, p2] = input.players;
    expect(p1.steer).toBeCloseTo(1, 10);
    expect(p1.brake).toBe(1);
    expect(p1.throttle).toBe(0);
    expect(p2.steer).toBeCloseTo(-Math.pow((0.5 - 0.08) / 0.92, 1.6), 10);
    expect(p2.throttle).toBeCloseTo((0.5 - 0.04) / 0.96, 10);
    expect(p2.brake).toBe(0);
  });

  it('handbrake, look stick and look-back are per pad', () => {
    const { input, a, b } = twoPads();
    setBtn(a, STD.a, true);
    b.axes[2] = 1;
    b.axes[3] = -1; // stick pushed up
    setBtn(b, STD.rsClick, true);
    input.poll(1 / 60);
    const [p1, p2] = input.players;
    expect(p1.handbrake).toBe(1);
    expect(p2.handbrake).toBe(0);
    expect(p1.lookBack).toBe(false);
    expect(p2.lookBack).toBe(true);
    expect(p2.lookX).toBe(1);
    expect(p2.lookY).toBe(1); // +1 = up
    expect(p1.lookX).toBe(0);
    expect(Math.abs(p1.lookY)).toBe(0); // (a still stick is -0 after the sign flip)
  });

  it('honours invertLookY and the steering settings for both seats', () => {
    const { input, a, b, controls } = twoPads();
    controls.steerLinearity = 1;
    controls.steerDeadzone = 0;
    controls.invertLookY = true;
    a.axes[0] = 0.5;
    b.axes[0] = 0.5;
    b.axes[3] = -1;
    input.poll(1 / 60);
    expect(input.players[0].steer).toBeCloseTo(0.5, 10);
    expect(input.players[1].steer).toBeCloseTo(0.5, 10);
    expect(input.players[1].lookY).toBe(-1);
  });

  const edges: [string, number, 'shiftUp' | 'shiftDown' | 'cameraNext' | 'resetCar' | 'pause' | 'toggleHud' | 'toggleTelemetry'][] = [
    ['RB', STD.rb, 'shiftUp'],
    ['B', STD.b, 'shiftUp'],
    ['LB', STD.lb, 'shiftDown'],
    ['X', STD.x, 'shiftDown'],
    ['Y', STD.y, 'cameraNext'],
    ['Back', STD.back, 'resetCar'],
    ['Start', STD.start, 'pause'],
    ['D-pad up', STD.dUp, 'toggleHud'],
    ['D-pad down', STD.dDown, 'toggleTelemetry'],
  ];
  for (const [name, btn, field] of edges) {
    it(`${name} on player 2's pad is player 2's ${field} for exactly one poll, and not player 1's`, () => {
      const { input, b } = twoPads();
      setBtn(b, btn, true);
      input.poll(1 / 60);
      expect(input.players[1][field]).toBe(true);
      expect(input.players[0][field]).toBe(false);
      input.poll(1 / 60);
      expect(input.players[1][field]).toBe(false);
      setBtn(b, btn, false);
      input.poll(1 / 60);
      setBtn(b, btn, true);
      input.poll(1 / 60);
      expect(input.players[1][field]).toBe(true); // a new press fires again
    });
  }

  it('the merged frame takes player 1\'s driving values and either seat\'s one-shot edges', () => {
    const { input, a, b } = twoPads();
    a.axes[0] = 1;
    setBtn(a, STD.rt, 1);
    setBtn(b, STD.y, true);
    const f = input.poll(1 / 60);
    expect(f.steer).toBeCloseTo(1, 10);
    expect(f.throttle).toBe(1);
    expect(f.cameraNext).toBe(true);
    expect(f.gamepadId).toBe(F310);
    expect(f.device).toBe('gamepad');
  });

  it('reuses its frame objects (no allocation per poll)', () => {
    const { input } = twoPads();
    const p1 = input.players[0];
    const p2 = input.players[1];
    const nav1 = p1.nav;
    const merged = input.poll(1 / 60);
    input.poll(1 / 60);
    expect(input.players[0]).toBe(p1);
    expect(input.players[1]).toBe(p2);
    expect(p1.nav).toBe(nav1);
    expect(input.poll(1 / 60)).toBe(merged);
  });

  it('anyPressed is per seat, and the merged one is the union', () => {
    const { input, a, b } = twoPads();
    input.poll(1 / 60);
    setBtn(b, STD.x, true);
    const f = input.poll(1 / 60);
    expect(input.players[1].anyPressed).toBe(true);
    expect(input.players[0].anyPressed).toBe(false);
    expect(f.anyPressed).toBe(true);
    a.axes[0] = 1; // a stick is not a press
    expect(input.poll(1 / 60).anyPressed).toBe(false);
  });

  it('a pad in D mode still works as a seat (best-effort layout)', () => {
    const { input, slots } = setup();
    const a = fakePad(0);
    const d = fakePad(1, { id: 'Logitech Dual Action (Vendor: 046d Product: c216)', mapping: '', axes: 10, buttons: 12 });
    d.axes[9] = 1.2857143; // hat centered
    slots[0] = a;
    slots[1] = d;
    input.poll(1 / 60);
    input.bindPlayers(PAD0, PAD1);
    setBtn(d, 7, true); // RT (digital)
    setBtn(d, 1, true); // A is button 1 in D mode
    input.poll(1 / 60);
    expect(input.players[1].throttle).toBe(1);
    expect(input.players[1].handbrake).toBe(1);
    expect(input.players[0].throttle).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pad + keyboard
// ─────────────────────────────────────────────────────────────────────────────

describe('a pad and the keyboard', () => {
  it('the keyboard seat drives with the keys and never reads the pad; the pad seat never reads the keys', () => {
    const { input, a, target } = padAndKeyboard();
    expect(input.sources).toEqual([PAD0, KEYBOARD]);
    key(target, 'keydown', 'KeyW');
    key(target, 'keydown', 'KeyD');
    a.axes[0] = -1;
    setBtn(a, STD.lt, 1);
    run(input, 0.5);
    const [p1, p2] = input.players;
    expect(p2.throttle).toBe(1);
    expect(p2.steer).toBe(1);
    expect(p2.brake).toBe(0);
    expect(p1.throttle).toBe(0);
    expect(p1.steer).toBeCloseTo(-1, 10);
    expect(p1.brake).toBe(1);
  });

  it('knows which seat is which device', () => {
    const { input } = padAndKeyboard();
    expect(input.players[0].device).toBe('gamepad');
    expect(input.players[0].gamepadId).toBe(F310);
    expect(input.players[1].device).toBe('keyboard');
    expect(input.players[1].gamepadId).toBeNull();
  });

  it('keyboard edges reach the keyboard seat once, pad edges the pad seat', () => {
    const { input, a, target } = padAndKeyboard();
    key(target, 'keydown', 'KeyC');
    key(target, 'keydown', 'KeyE');
    key(target, 'keydown', 'KeyR');
    input.poll(1 / 60);
    expect(input.players[1].cameraNext).toBe(true);
    expect(input.players[1].shiftUp).toBe(true);
    expect(input.players[1].resetCar).toBe(true);
    expect(input.players[0].cameraNext).toBe(false);
    input.poll(1 / 60);
    expect(input.players[1].cameraNext).toBe(false);
    setBtn(a, STD.y, true);
    input.poll(1 / 60);
    expect(input.players[0].cameraNext).toBe(true);
    expect(input.players[1].cameraNext).toBe(false);
  });

  it('Space is the keyboard seat\'s handbrake, V looks back, IJKL look around', () => {
    const { input, target } = padAndKeyboard();
    key(target, 'keydown', 'Space');
    key(target, 'keydown', 'KeyV');
    key(target, 'keydown', 'KeyL');
    key(target, 'keydown', 'KeyI');
    const f = run(input, 0.3);
    void f;
    const p2 = input.players[1];
    expect(p2.handbrake).toBe(1);
    expect(p2.lookBack).toBe(true);
    expect(p2.lookX).toBe(1);
    expect(p2.lookY).toBe(1);
    expect(input.players[0].handbrake).toBe(0);
    expect(input.players[0].lookBack).toBe(false);
  });

  it('Esc pauses from the keyboard seat and is in the merged frame', () => {
    const { input, target } = padAndKeyboard();
    key(target, 'keydown', 'Escape');
    const f = input.poll(1 / 60);
    expect(input.players[1].pause).toBe(true);
    expect(input.players[0].pause).toBe(false);
    expect(f.pause).toBe(true);
  });

  it('works the other way round: the keyboard is player 1, the pad is player 2', () => {
    const { input, slots, target } = setup();
    const a = fakePad(0);
    slots[0] = a;
    input.poll(1 / 60);
    input.bindPlayers(KEYBOARD, PAD0);
    key(target, 'keydown', 'KeyW');
    setBtn(a, STD.rt, 1);
    run(input, 0.5);
    expect(input.players[0].throttle).toBe(1);
    expect(input.players[0].device).toBe('keyboard');
    expect(input.players[1].throttle).toBe(1);
    expect(input.players[1].device).toBe('gamepad');
    // the merged frame follows player 1 (the keyboard); the controller that is there is the other player's
    const f = input.poll(1 / 60);
    expect(f.gamepadId).toBe(F310);
  });

  it('a pad and a keyboard seat: the pad seat does not hear the keyboard even when the pad lies idle', () => {
    const { input, target } = padAndKeyboard();
    key(target, 'keydown', 'KeyA');
    run(input, 0.4);
    expect(input.players[0].steer).toBe(0);
    expect(input.players[1].steer).toBe(-1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bind, swap, unbind
// ─────────────────────────────────────────────────────────────────────────────

describe('binding, swapping and unbinding', () => {
  it('swapPlayers exchanges the devices: the frames follow', () => {
    const { input, a, b } = twoPads();
    a.axes[0] = 1;
    input.poll(1 / 60);
    expect(input.players[0].steer).toBeCloseTo(1, 10);
    input.swapPlayers();
    expect(input.sources).toEqual([PAD1, PAD0]);
    input.poll(1 / 60);
    expect(input.players[0].steer).toBe(0);
    expect(input.players[1].steer).toBeCloseTo(1, 10);
    b.axes[0] = -1;
    input.poll(1 / 60);
    expect(input.players[0].steer).toBeCloseTo(-1, 10);
  });

  it('swapPlayers does nothing while not split', () => {
    const { input, slots } = setup();
    slots[0] = fakePad(0);
    input.poll(1 / 60);
    input.swapPlayers();
    expect(input.sources).toEqual([null, null]);
    expect(input.split).toBe(false);
  });

  it('refuses to put both seats on the same device', () => {
    const { input, slots } = setup();
    slots[0] = fakePad(0);
    input.poll(1 / 60);
    input.bindPlayers(PAD0, PAD0);
    expect(input.split).toBe(false);
    input.bindPlayers(KEYBOARD, KEYBOARD);
    expect(input.split).toBe(false);
    expect(input.sources).toEqual([null, null]);
  });

  it('unbindPlayers goes back to one player: the frames go neutral and the merged frame is the old one', () => {
    const { input, a, b, target } = twoPads();
    a.axes[0] = 1;
    setBtn(b, STD.rt, 1);
    input.poll(1 / 60);
    input.unbindPlayers();
    expect(input.split).toBe(false);
    expect(input.sources).toEqual([null, null]);
    expect(input.missingSeat()).toBeNull();
    const f = input.poll(1 / 60);
    expect(input.players[0].steer).toBe(0);
    expect(input.players[1].throttle).toBe(0);
    // one player again: the first pad and the keyboard in one frame; the second pad is ignored
    expect(f.steer).toBeCloseTo(1, 10);
    expect(f.throttle).toBe(0);
    // (the pad is in use while its stick is pushed: let go of it, then the keys are the device in use)
    a.axes[0] = 0;
    setBtn(b, STD.rt, 0);
    input.poll(1 / 60);
    key(target, 'keydown', 'KeyW');
    expect(run(input, 0.3).throttle).toBe(1);
  });

  it('can be bound again after an unbind, with other devices', () => {
    const { input, slots, target } = setup();
    slots[0] = fakePad(0);
    slots[1] = fakePad(1);
    input.poll(1 / 60);
    input.bindPlayers(PAD0, PAD1);
    input.unbindPlayers();
    input.bindPlayers(PAD1, KEYBOARD);
    expect(input.sources).toEqual([PAD1, KEYBOARD]);
    key(target, 'keydown', 'KeyW');
    run(input, 0.4);
    expect(input.players[1].throttle).toBe(1);
  });

  it('sameSource compares devices, not objects', () => {
    expect(sameSource({ kind: 'pad', index: 1 }, PAD1)).toBe(true);
    expect(sameSource(PAD0, PAD1)).toBe(false);
    expect(sameSource({ kind: 'keyboard' }, KEYBOARD)).toBe(true);
    expect(sameSource(KEYBOARD, PAD0)).toBe(false);
    expect(sameSource(null, null)).toBe(true);
    expect(sameSource(null, PAD0)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// the join step
// ─────────────────────────────────────────────────────────────────────────────

describe('primarySource', () => {
  it('is the keyboard with no pad, the pad in use otherwise, and player 1\'s device once split', () => {
    const { input, slots } = setup();
    input.poll(1 / 60);
    expect(input.primarySource()).toEqual(KEYBOARD);
    slots[1] = fakePad(1);
    input.poll(1 / 60);
    expect(input.primarySource()).toEqual(PAD1);
    slots[0] = fakePad(0);
    input.poll(1 / 60);
    expect(input.primarySource()).toEqual(PAD1); // the pad in use stays the pad in use
    input.bindPlayers(PAD0, KEYBOARD);
    expect(input.primarySource()).toEqual(PAD0);
  });
});

describe('joining', () => {
  it('the first other pad to press A is the joiner, once', () => {
    const { input, slots } = setup();
    slots[0] = fakePad(0);
    input.poll(1 / 60);
    input.beginJoin();
    expect(input.joining).toBe(true);
    expect(input.takeJoiner()).toBeNull();
    // the second pad shows up with A already down: Chrome only reveals a pad after a press, and that press counts
    const b = fakePad(1);
    setBtn(b, STD.a, true);
    slots[1] = b;
    input.poll(1 / 60);
    expect(input.takeJoiner()).toEqual(PAD1);
    expect(input.takeJoiner()).toBeNull();
    // and it binds like any other
    input.bindPlayers(input.primarySource(), PAD1);
    expect(input.joining).toBe(false);
    expect(input.sources).toEqual([PAD0, PAD1]);
  });

  it('the primary pad pressing A is just player 1 navigating', () => {
    const { input, slots } = setup();
    const a = fakePad(0);
    slots[0] = a;
    input.poll(1 / 60);
    input.beginJoin();
    setBtn(a, STD.a, true);
    input.poll(1 / 60);
    expect(input.takeJoiner()).toBeNull();
  });

  it('only A joins: another button on the revealed pad is nothing, the A that follows is a join', () => {
    const { input, slots } = setup();
    slots[0] = fakePad(0);
    input.poll(1 / 60);
    input.beginJoin();
    const b = fakePad(1);
    setBtn(b, STD.b, true);
    slots[1] = b;
    input.poll(1 / 60);
    expect(input.takeJoiner()).toBeNull();
    setBtn(b, STD.b, false);
    input.poll(1 / 60);
    setBtn(b, STD.a, true);
    input.poll(1 / 60);
    expect(input.takeJoiner()).toEqual(PAD1);
  });

  it('a pad that was there all along joins on a new press of A, not on one that was already held', () => {
    const { input, slots } = setup();
    slots[0] = fakePad(0);
    const b = fakePad(1);
    slots[1] = b;
    setBtn(b, STD.a, true);
    input.poll(1 / 60);
    input.poll(1 / 60);
    input.beginJoin();
    input.poll(1 / 60);
    expect(input.takeJoiner()).toBeNull(); // still holding the A from before
    setBtn(b, STD.a, false);
    input.poll(1 / 60);
    expect(input.takeJoiner()).toBeNull();
    setBtn(b, STD.a, true);
    input.poll(1 / 60);
    expect(input.takeJoiner()).toEqual(PAD1);
  });

  it('nothing happens unless the join step is open', () => {
    const { input, slots } = setup();
    slots[0] = fakePad(0);
    input.poll(1 / 60);
    const b = fakePad(1);
    setBtn(b, STD.a, true);
    slots[1] = b;
    input.poll(1 / 60);
    expect(input.joining).toBe(false);
    expect(input.takeJoiner()).toBeNull();
    input.beginJoin();
    input.endJoin();
    expect(input.joining).toBe(false);
    setBtn(b, STD.a, false);
    input.poll(1 / 60);
    setBtn(b, STD.a, true);
    input.poll(1 / 60);
    expect(input.takeJoiner()).toBeNull();
  });

  it('Enter on the keyboard joins when the primary device is a pad', () => {
    const { input, slots, target } = setup();
    slots[0] = fakePad(0);
    input.poll(1 / 60);
    input.beginJoin();
    key(target, 'keydown', 'Enter');
    input.poll(1 / 60);
    expect(input.takeJoiner()).toEqual(KEYBOARD);
  });

  it('other keys do not join', () => {
    const { input, slots, target } = setup();
    slots[0] = fakePad(0);
    input.poll(1 / 60);
    input.beginJoin();
    key(target, 'keydown', 'Space');
    key(target, 'keydown', 'KeyW');
    input.poll(1 / 60);
    expect(input.takeJoiner()).toBeNull();
  });

  it('the keyboard cannot join when it is the primary device; a pad can, even though it takes the menus over', () => {
    const { input, slots, target } = setup();
    input.poll(1 / 60);
    input.beginJoin();
    key(target, 'keydown', 'Enter');
    input.poll(1 / 60);
    expect(input.takeJoiner()).toBeNull();
    const a = fakePad(0);
    setBtn(a, STD.a, true);
    slots[0] = a;
    input.poll(1 / 60);
    expect(input.takeJoiner()).toEqual(PAD0);
    input.bindPlayers(KEYBOARD, PAD0);
    expect(input.sources).toEqual([KEYBOARD, PAD0]);
  });

  it('a device that is already in a seat cannot join again', () => {
    const { input, b, target } = twoPads();
    input.beginJoin();
    setBtn(b, STD.a, true);
    input.poll(1 / 60);
    expect(input.takeJoiner()).toBeNull();
    // a third device can
    const { input: input2, slots, target: target2 } = setup();
    slots[0] = fakePad(0);
    input2.poll(1 / 60);
    input2.bindPlayers(PAD0, KEYBOARD);
    input2.beginJoin();
    key(target2, 'keydown', 'Enter');
    input2.poll(1 / 60);
    expect(input2.takeJoiner()).toBeNull(); // the keyboard is player 2
    key(target, 'keydown', 'Enter');
    input.poll(1 / 60);
    expect(input.takeJoiner()).toEqual(KEYBOARD); // two pads, so the keyboard is free
  });

  it('the join press does not leak into the menus as a confirm', () => {
    const { input, slots } = setup();
    slots[0] = fakePad(0);
    input.poll(1 / 60);
    input.beginJoin();
    const b = fakePad(1);
    setBtn(b, STD.a, true);
    slots[1] = b;
    const f = input.poll(1 / 60);
    expect(f.nav.confirm).toBe(false);
    expect(input.takeJoiner()).toEqual(PAD1);
  });

  it('endJoin forgets a joiner that has not been taken', () => {
    const { input, slots } = setup();
    slots[0] = fakePad(0);
    input.poll(1 / 60);
    input.beginJoin();
    const b = fakePad(1);
    setBtn(b, STD.a, true);
    slots[1] = b;
    input.poll(1 / 60);
    input.endJoin();
    expect(input.takeJoiner()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// the menus
// ─────────────────────────────────────────────────────────────────────────────

describe('menus while split', () => {
  it('navigate with either pad and the keyboard', () => {
    const { input, a, b, target } = twoPads();
    setBtn(a, STD.dDown, true);
    expect(input.poll(1 / 60).nav.down).toBe(true);
    setBtn(a, STD.dDown, false);
    input.poll(1 / 60);
    setBtn(b, STD.a, true);
    expect(input.poll(1 / 60).nav.confirm).toBe(true);
    setBtn(b, STD.a, false);
    input.poll(1 / 60);
    key(target, 'keydown', 'Enter');
    expect(input.poll(1 / 60).nav.confirm).toBe(true);
    key(target, 'keydown', 'ArrowUp');
    key(target, 'keyup', 'ArrowUp');
    expect(input.poll(1 / 60).nav.up).toBe(true);
    // every kind of edge, from the second pad
    setBtn(b, STD.b, true);
    setBtn(b, STD.lb, true);
    setBtn(b, STD.rb, true);
    const f = input.poll(1 / 60);
    expect([f.nav.back, f.nav.tabLeft, f.nav.tabRight]).toEqual([true, true, true]);
  });

  it('the left stick navigates with hysteresis, per pad', () => {
    const { input, b } = twoPads();
    b.axes[0] = 0.7;
    expect(input.poll(1 / 60).nav.right).toBe(true);
    b.axes[0] = 0.45; // between the thresholds: held, no new edge
    expect(input.poll(1 / 60).nav.right).toBe(false);
    b.axes[0] = 0.1;
    input.poll(1 / 60);
    b.axes[1] = -0.9;
    expect(input.poll(1 / 60).nav.up).toBe(true);
  });

  it('Start is a confirm in the menus, of whichever pad pressed it', () => {
    const { input, b } = twoPads();
    setBtn(b, STD.start, true);
    const f = input.poll(1 / 60);
    expect(f.nav.confirm).toBe(true);
    expect(f.pause).toBe(true);
  });

  it('a menu owner shuts the other pad out but never the keyboard', () => {
    const { input, a, b, target } = twoPads();
    input.menuOwner = 1;
    setBtn(a, STD.dDown, true);
    setBtn(a, STD.a, true);
    let f = input.poll(1 / 60);
    expect(f.nav.down).toBe(false);
    expect(f.nav.confirm).toBe(false);
    setBtn(b, STD.dDown, true);
    setBtn(b, STD.a, true);
    f = input.poll(1 / 60);
    expect(f.nav.down).toBe(true);
    expect(f.nav.confirm).toBe(true);
    key(target, 'keydown', 'Backspace');
    expect(input.poll(1 / 60).nav.back).toBe(true);
    // the seats' own frames are not filtered: the owner is only about the menus
    expect(input.players[0].nav.down).toBe(false); // (held, not an edge, any more)
    setBtn(a, STD.a, false);
    input.poll(1 / 60);
    setBtn(a, STD.a, true);
    const merged = input.poll(1 / 60);
    expect(input.players[0].nav.confirm).toBe(true);
    expect(merged.nav.confirm).toBe(false);
  });

  it('owner 0 mirrors owner 1, null lets everyone in', () => {
    const { input, a, b } = twoPads();
    input.menuOwner = 0;
    setBtn(b, STD.a, true);
    expect(input.poll(1 / 60).nav.confirm).toBe(false);
    setBtn(b, STD.a, false);
    setBtn(a, STD.a, true);
    expect(input.poll(1 / 60).nav.confirm).toBe(true);
    setBtn(a, STD.a, false);
    input.poll(1 / 60);
    input.menuOwner = null;
    setBtn(b, STD.a, true);
    expect(input.poll(1 / 60).nav.confirm).toBe(true);
  });

  it('the owner follows the seat, so a swap hands the menus to the other device', () => {
    const { input, a, b } = twoPads();
    input.menuOwner = 0;
    input.swapPlayers(); // seat 0 is now pad 1
    setBtn(a, STD.a, true);
    expect(input.poll(1 / 60).nav.confirm).toBe(false);
    setBtn(a, STD.a, false);
    input.poll(1 / 60);
    setBtn(b, STD.a, true);
    expect(input.poll(1 / 60).nav.confirm).toBe(true);
  });

  it('a pad in the keyboard\'s company: the owner can be the pad and the keyboard still navigates', () => {
    const { input, a, target } = padAndKeyboard();
    input.menuOwner = 0;
    key(target, 'keydown', 'Enter');
    expect(input.poll(1 / 60).nav.confirm).toBe(true);
    setBtn(a, STD.dRight, true);
    expect(input.poll(1 / 60).nav.right).toBe(true);
    input.menuOwner = 1; // the keyboard seat owns the menus: the pad is shut out
    setBtn(a, STD.dRight, false);
    input.poll(1 / 60);
    setBtn(a, STD.a, true);
    expect(input.poll(1 / 60).nav.confirm).toBe(false);
    key(target, 'keydown', 'Enter');
    expect(input.poll(1 / 60).nav.confirm).toBe(true);
  });

  it('an owner whose pad is unplugged does not lock the menus: anyone may navigate until it is back', () => {
    const { input, slots, a, b } = twoPads();
    input.menuOwner = 1;
    setBtn(a, STD.a, true);
    expect(input.poll(1 / 60).nav.confirm).toBe(false);
    setBtn(a, STD.a, false);
    input.poll(1 / 60);
    slots[1] = null; // the owner's pad goes
    setBtn(a, STD.a, true);
    expect(input.poll(1 / 60).nav.confirm).toBe(true);
    setBtn(a, STD.a, false);
    input.poll(1 / 60);
    slots[1] = b; // and comes back: the owner again
    setBtn(a, STD.a, true);
    expect(input.poll(1 / 60).nav.confirm).toBe(false);
    expect(input.menuOwner).toBe(1);
  });

  it("the keyboard seat's own frame carries the keyboard's menu edges", () => {
    const { input, target } = padAndKeyboard();
    key(target, 'keydown', 'Enter');
    input.poll(1 / 60);
    expect(input.players[1].nav.confirm).toBe(true);
    expect(input.players[0].nav.confirm).toBe(false);
    key(target, 'keydown', 'ArrowDown');
    expect(input.poll(1 / 60).nav.down).toBe(true);
    expect(input.players[1].nav.down).toBe(true);
  });

  it('is ignored while the screen is not split (one player: the pad in use and the keyboard)', () => {
    const { input, slots } = setup();
    const a = fakePad(0);
    slots[0] = a;
    input.menuOwner = 1;
    input.poll(1 / 60);
    setBtn(a, STD.a, true);
    expect(input.poll(1 / 60).nav.confirm).toBe(true);
  });

  it('keeps the auto-repeat rhythm of a held direction when the owner changes', () => {
    const { input, a } = twoPads();
    setBtn(a, STD.dDown, true);
    expect(input.poll(1 / 60).nav.down).toBe(true); // the press (poll 0)
    for (let i = 0; i < 6; i++) expect(input.poll(1 / 60).nav.down).toBe(false);
    input.menuOwner = 1;
    for (let i = 0; i < 6; i++) expect(input.poll(1 / 60).nav.down).toBe(false);
    input.menuOwner = 0;
    // still held: no new press just because the pad may navigate again
    expect(input.poll(1 / 60).nav.down).toBe(false);
    // the repeat comes ~0.3 s after the press, 18 polls in, not 0.3 s after the owner changed
    let at = -1;
    for (let i = 14; i < 60; i++) {
      if (input.poll(1 / 60).nav.down) {
        at = i;
        break;
      }
    }
    expect(at).toBeGreaterThanOrEqual(17);
    expect(at).toBeLessThanOrEqual(20);
  });

  it('a held direction repeats for the owner (and only the owner)', () => {
    const { input, a } = twoPads();
    input.menuOwner = 0;
    setBtn(a, STD.dDown, true);
    let hits = 0;
    for (let i = 0; i < 120; i++) if (input.poll(1 / 60).nav.down) hits++;
    expect(hits).toBeGreaterThanOrEqual(15);
    input.menuOwner = 1;
    hits = 0;
    for (let i = 0; i < 120; i++) if (input.poll(1 / 60).nav.down) hits++;
    expect(hits).toBe(0);
  });

  it('a pad that is unplugged while it holds a direction leaves no edge behind', () => {
    const { input, slots, a } = twoPads();
    setBtn(a, STD.dDown, true);
    input.poll(1 / 60);
    slots[0] = null;
    let any = false;
    for (let i = 0; i < 30; i++) if (input.poll(1 / 60).nav.down) any = true;
    expect(any).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pausing
// ─────────────────────────────────────────────────────────────────────────────

describe('pausing', () => {
  it('Start on a pad is that seat\'s pause and the merged one', () => {
    const { input, b } = twoPads();
    setBtn(b, STD.start, true);
    const f = input.poll(1 / 60);
    expect(f.pause).toBe(true);
    expect(input.players[1].pause).toBe(true);
    expect(input.players[0].pause).toBe(false);
    expect(input.poll(1 / 60).pause).toBe(false);
  });

  it('either pad can pause, and both at once are both seats\' pause', () => {
    const { input, a, b } = twoPads();
    setBtn(a, STD.start, true);
    let f = input.poll(1 / 60);
    expect([f.pause, input.players[0].pause, input.players[1].pause]).toEqual([true, true, false]);
    setBtn(a, STD.start, false);
    input.poll(1 / 60);
    setBtn(a, STD.start, true);
    setBtn(b, STD.start, true);
    f = input.poll(1 / 60);
    expect([f.pause, input.players[0].pause, input.players[1].pause]).toEqual([true, true, true]);
  });

  it('the keyboard pauses two pads\' race too, and belongs to neither seat', () => {
    const { input, target } = twoPads();
    key(target, 'keydown', 'Escape');
    const f = input.poll(1 / 60);
    expect(f.pause).toBe(true);
    expect(input.players[0].pause).toBe(false);
    expect(input.players[1].pause).toBe(false);
    key(target, 'keyup', 'Escape');
    key(target, 'keydown', 'KeyP');
    expect(input.poll(1 / 60).pause).toBe(true);
  });

  it('the pause menu can follow the pad that paused', () => {
    const { input, a, b } = twoPads();
    setBtn(b, STD.start, true);
    input.poll(1 / 60);
    expect(input.players[1].pause).toBe(true);
    input.menuOwner = 1; // what the game does
    setBtn(b, STD.start, false);
    input.poll(1 / 60);
    setBtn(a, STD.dDown, true);
    expect(input.poll(1 / 60).nav.down).toBe(false);
    setBtn(b, STD.dDown, true);
    expect(input.poll(1 / 60).nav.down).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// unplug and replug
// ─────────────────────────────────────────────────────────────────────────────

describe('a controller is unplugged and plugged in again', () => {
  it('the seat keeps its place, holds still, and is reported missing', () => {
    const { input, slots, b } = twoPads();
    b.axes[0] = 1;
    setBtn(b, STD.rt, 1);
    input.poll(1 / 60);
    expect(input.players[1].throttle).toBe(1);
    expect(input.missingSeat()).toBeNull();
    slots[1] = null;
    input.poll(1 / 60);
    expect(input.missingSeat()).toBe(1);
    expect(input.sources).toEqual([PAD0, PAD1]);
    const p2 = input.players[1];
    expect([p2.steer, p2.throttle, p2.brake, p2.handbrake]).toEqual([0, 0, 0, 0]);
    expect(p2.gamepadId).toBeNull();
    expect(p2.anyPressed).toBe(false);
    expect(p2.cameraNext || p2.pause || p2.shiftUp || p2.nav.confirm).toBe(false);
  });

  it('a pad object that stays in its slot but says it is not connected is just as gone', () => {
    const { input, b } = twoPads();
    b.connected = false;
    input.poll(1 / 60);
    expect(input.missingSeat()).toBe(1);
    expect(input.padCount).toBe(1);
  });

  it('the other seat carries on while one is missing', () => {
    const { input, slots, a } = twoPads();
    slots[1] = null;
    a.axes[0] = 1;
    input.poll(1 / 60);
    expect(input.players[0].steer).toBeCloseTo(1, 10);
    expect(input.missingSeat()).toBe(1);
  });

  it('a pad that comes back at the same index is that seat again, and its first press counts', () => {
    const { input, slots, b } = twoPads();
    slots[1] = null;
    input.poll(1 / 60);
    input.poll(1 / 60);
    expect(input.missingSeat()).toBe(1);
    const again = fakePad(1);
    setBtn(again, STD.a, true); // the press that made Chrome show it again
    again.axes[0] = -1;
    slots[1] = again;
    input.poll(1 / 60);
    expect(input.missingSeat()).toBeNull();
    expect(input.sources).toEqual([PAD0, PAD1]);
    expect(input.players[1].gamepadId).toBe(F310);
    expect(input.players[1].steer).toBeCloseTo(-1, 10);
    expect(input.players[1].anyPressed).toBe(true);
    expect(input.players[1].nav.confirm).toBe(true);
    void b;
  });

  it('a pad that turns up at another index is adopted by the seat that is missing', () => {
    const { input, slots } = twoPads();
    slots[1] = null;
    input.poll(1 / 60);
    expect(input.missingSeat()).toBe(1);
    const c = fakePad(2);
    c.axes[0] = 1;
    slots[2] = c;
    input.poll(1 / 60);
    expect(input.sources).toEqual([PAD0, { kind: 'pad', index: 2 }]);
    expect(input.missingSeat()).toBeNull();
    expect(input.players[1].steer).toBeCloseTo(1, 10);
    expect(input.players[0].steer).toBe(0);
  });

  it('seat 0 is adopted into when seat 0 is the one that is missing', () => {
    const { input, slots } = twoPads();
    slots[0] = null;
    input.poll(1 / 60);
    expect(input.missingSeat()).toBe(0);
    slots[3] = fakePad(3);
    input.poll(1 / 60);
    expect(input.sources).toEqual([{ kind: 'pad', index: 3 }, PAD1]);
  });

  it('a third pad is nobody\'s while both seats have theirs', () => {
    const { input, slots } = twoPads();
    slots[2] = fakePad(2);
    input.poll(1 / 60);
    input.poll(1 / 60);
    expect(input.sources).toEqual([PAD0, PAD1]);
    expect(input.padCount).toBe(3);
    // and it is not taken over when a seat's pad goes later: only a pad that turns up is adopted
    slots[1] = null;
    input.poll(1 / 60);
    expect(input.missingSeat()).toBe(1);
    expect(input.sources).toEqual([PAD0, PAD1]);
  });

  it('with both missing, pads are adopted in the order they turn up, the lowest seat first', () => {
    const { input, slots } = twoPads();
    slots[0] = null;
    slots[1] = null;
    input.poll(1 / 60);
    expect(input.missingSeat()).toBe(0);
    slots[3] = fakePad(3);
    input.poll(1 / 60);
    expect(input.sources).toEqual([{ kind: 'pad', index: 3 }, PAD1]);
    expect(input.missingSeat()).toBe(1);
    slots[2] = fakePad(2);
    input.poll(1 / 60);
    expect(input.sources).toEqual([{ kind: 'pad', index: 3 }, { kind: 'pad', index: 2 }]);
    expect(input.missingSeat()).toBeNull();
  });

  it('two pads that turn up in the same poll are taken in index order', () => {
    const { input, slots } = twoPads();
    slots[0] = null;
    slots[1] = null;
    input.poll(1 / 60);
    slots[3] = fakePad(3);
    slots[2] = fakePad(2);
    input.poll(1 / 60);
    expect(input.sources).toEqual([{ kind: 'pad', index: 2 }, { kind: 'pad', index: 3 }]);
  });

  it('a pad that is not shaped like a pad is not adopted', () => {
    const { input, slots } = twoPads();
    slots[1] = null;
    input.poll(1 / 60);
    slots[2] = fakePad(2, { id: 'Wireless Receiver', mapping: '', axes: 2, buttons: 3 });
    input.poll(1 / 60);
    expect(input.missingSeat()).toBe(1);
  });

  it('the keyboard seat is never missing, and does not care what the pad does', () => {
    const { input, slots, target } = padAndKeyboard();
    expect(input.missingSeat()).toBeNull();
    key(target, 'keydown', 'KeyW');
    slots[0] = null;
    run(input, 0.4);
    expect(input.missingSeat()).toBe(0);
    expect(input.players[1].throttle).toBe(1);
    expect(input.players[0].throttle).toBe(0);
  });

  it('no seat is missing when the screen is not split', () => {
    const { input, slots } = setup();
    slots[0] = fakePad(0);
    input.poll(1 / 60);
    slots[0] = null;
    input.poll(1 / 60);
    expect(input.missingSeat()).toBeNull();
  });

  it('the merged frame loses the pad id when player 1\'s pad goes', () => {
    const { input, slots } = twoPads();
    expect(input.poll(1 / 60).gamepadId).toBe(F310);
    slots[0] = null;
    expect(input.poll(1 / 60).gamepadId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rumble
// ─────────────────────────────────────────────────────────────────────────────

describe('rumble', () => {
  it('goes to the pad of the seat it names', () => {
    const { input, a, b } = twoPads({ rumble: true });
    input.rumble(1, 0.5, 120, 1);
    expect(a.vibrationActuator!.playEffect).not.toHaveBeenCalled();
    expect(b.vibrationActuator!.playEffect).toHaveBeenCalledTimes(1);
    expect(b.vibrationActuator!.playEffect).toHaveBeenCalledWith('dual-rumble', { startDelay: 0, duration: 120, strongMagnitude: 1, weakMagnitude: 0.5 });
    input.rumble(2, -1, 80, 0);
    expect(a.vibrationActuator!.playEffect).toHaveBeenCalledWith('dual-rumble', { startDelay: 0, duration: 80, strongMagnitude: 1, weakMagnitude: 0 });
    expect(b.vibrationActuator!.playEffect).toHaveBeenCalledTimes(1);
  });

  it('without a seat it is the pad the menus use, as ever', () => {
    const { input, a, b } = twoPads({ rumble: true });
    input.rumble(0.5, 0.5, 50);
    expect(a.vibrationActuator!.playEffect).toHaveBeenCalledTimes(1);
    expect(b.vibrationActuator!.playEffect).not.toHaveBeenCalled();
  });

  it('a seat on the keyboard has nothing to shake', () => {
    const { input, a } = padAndKeyboard();
    a.vibrationActuator = { playEffect: vi.fn(async () => 'complete') };
    input.rumble(1, 1, 100, 1);
    expect(a.vibrationActuator.playEffect).not.toHaveBeenCalled();
    input.rumble(1, 1, 100, 0);
    expect(a.vibrationActuator.playEffect).toHaveBeenCalledTimes(1);
  });

  it('a seat number means nothing while the screen is whole', () => {
    const { input, slots } = setup();
    const a = fakePad(0, { rumble: true });
    slots[0] = a;
    input.poll(1 / 60);
    input.rumble(1, 1, 100, 1);
    expect(a.vibrationActuator!.playEffect).toHaveBeenCalledTimes(1);
  });

  it('is a silent no-op for a missing pad, a pad without motors and with vibration off', () => {
    const { input, slots, b } = twoPads({ rumble: true });
    slots[1] = null;
    input.poll(1 / 60);
    expect(() => input.rumble(1, 1, 100, 1)).not.toThrow();
    expect(b.vibrationActuator!.playEffect).not.toHaveBeenCalled();
    const f310 = twoPads();
    expect(() => f310.input.rumble(1, 1, 100, 0)).not.toThrow();
    const quiet = setup({ vibration: false });
    const q = fakePad(0, { rumble: true });
    const q2 = fakePad(1, { rumble: true });
    quiet.slots[0] = q;
    quiet.slots[1] = q2;
    quiet.input.poll(1 / 60);
    quiet.input.bindPlayers(PAD0, PAD1);
    quiet.input.rumble(1, 1, 100, 1);
    expect(q2.vibrationActuator!.playEffect).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// names and counts
// ─────────────────────────────────────────────────────────────────────────────

describe('device names and pad count', () => {
  it('names the keyboard and a single pad plainly', () => {
    const { input, slots } = setup();
    slots[0] = fakePad(0);
    input.poll(1 / 60);
    expect(input.deviceName(KEYBOARD)).toBe('Keyboard');
    expect(input.deviceName(PAD0)).toBe('Logitech Gamepad F310');
    expect(input.deviceName(null)).toBeNull();
    expect(input.deviceName({ kind: 'pad', index: 3 })).toBeNull(); // never seen
  });

  it('numbers two controllers of one model by slot', () => {
    const { input } = twoPads();
    expect(input.deviceName(PAD0)).toBe('Logitech Gamepad F310 (1)');
    expect(input.deviceName(PAD1)).toBe('Logitech Gamepad F310 (2)');
  });

  it('does not number controllers of different models', () => {
    const { input, slots } = setup();
    slots[0] = fakePad(0);
    slots[1] = fakePad(1, { id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)' });
    input.poll(1 / 60);
    expect(input.deviceName(PAD0)).toBe('Logitech Gamepad F310');
    expect(input.deviceName(PAD1)).toBe('Xbox 360 Controller');
  });

  it('a controller that went away keeps its plain name, and the one left loses its number', () => {
    const { input, slots } = twoPads();
    slots[1] = null;
    input.poll(1 / 60);
    expect(input.deviceName(PAD1)).toBe('Logitech Gamepad F310');
    expect(input.deviceName(PAD0)).toBe('Logitech Gamepad F310');
  });

  it('counts the usable pads', () => {
    const { input, slots } = setup();
    input.poll(1 / 60);
    expect(input.padCount).toBe(0);
    slots[0] = fakePad(0);
    input.poll(1 / 60);
    expect(input.padCount).toBe(1);
    slots[1] = fakePad(1);
    input.poll(1 / 60);
    expect(input.padCount).toBe(2);
    // things that are not shaped like a pad do not count, a pad in D mode does
    slots[2] = fakePad(2, { id: 'Wireless Receiver', mapping: '', axes: 2, buttons: 3 });
    slots[3] = fakePad(3, { id: 'Logitech Dual Action (Vendor: 046d Product: c216)', mapping: '', axes: 10, buttons: 12 });
    input.poll(1 / 60);
    expect(input.padCount).toBe(3);
    slots[0] = null;
    input.poll(1 / 60);
    expect(input.padCount).toBe(2);
    (slots[1] as FakePad).connected = false;
    input.poll(1 / 60);
    expect(input.padCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// the one-player game must not notice any of this
// ─────────────────────────────────────────────────────────────────────────────

describe('one player is unchanged', () => {
  it('not split: a second pad is ignored, the players are neutral, nothing is missing', () => {
    const { input, slots } = setup();
    const a = fakePad(0);
    const b = fakePad(1);
    slots[0] = a;
    slots[1] = b;
    input.poll(1 / 60);
    expect(input.split).toBe(false);
    expect(input.sources).toEqual([null, null]);
    expect(input.missingSeat()).toBeNull();
    b.axes[0] = 1;
    setBtn(b, STD.rt, 1);
    setBtn(b, STD.y, true);
    let f = input.poll(1 / 60);
    expect(f.steer).toBe(0);
    expect(f.throttle).toBe(0);
    expect(f.cameraNext).toBe(false);
    expect(f.device).toBe('keyboard'); // the second pad did not even wake the input
    a.axes[0] = -1;
    f = input.poll(1 / 60);
    expect(f.steer).toBeCloseTo(-1, 10);
    expect(f.device).toBe('gamepad');
    expect(input.players[0].steer).toBe(0);
    expect(input.players[1].throttle).toBe(0);
    expect(input.padName).toBe('Logitech Gamepad F310');
  });

  it('not split: the pad in use stays the one in use when another one turns up', () => {
    const { input, slots } = setup();
    slots[1] = fakePad(1);
    input.poll(1 / 60);
    expect(input.primarySource()).toEqual(PAD1);
    slots[0] = fakePad(0);
    input.poll(1 / 60);
    expect(input.primarySource()).toEqual(PAD1);
    slots[1] = null; // the one in use goes: the other takes over
    input.poll(1 / 60);
    expect(input.primarySource()).toEqual(PAD0);
  });

  it('keyboard and pad still merge into one frame, whichever was used last', () => {
    const { input, slots, target } = setup();
    const a = fakePad(0);
    slots[0] = a;
    key(target, 'keydown', 'KeyD');
    const f = run(input, 0.5);
    expect(f.device).toBe('keyboard');
    expect(f.steer).toBe(1);
    key(target, 'keyup', 'KeyD');
    a.axes[0] = -1;
    expect(input.poll(1 / 60).device).toBe('gamepad');
    expect(input.poll(1 / 60).steer).toBeCloseTo(-1, 10);
  });

  it('joining does not change the frame', () => {
    const { input, slots } = setup();
    const a = fakePad(0);
    slots[0] = a;
    input.poll(1 / 60);
    input.beginJoin();
    setBtn(a, STD.dDown, true);
    setBtn(a, STD.a, true);
    const f = input.poll(1 / 60);
    expect(f.nav.down).toBe(true);
    expect(f.nav.confirm).toBe(true);
    expect(f.handbrake).toBe(1);
  });

  it('the split frames stay neutral until there is a split', () => {
    const { input, slots } = setup();
    const a = fakePad(0);
    slots[0] = a;
    setBtn(a, STD.rt, 1);
    a.axes[0] = 1;
    input.poll(1 / 60);
    for (const p of input.players) {
      expect([p.steer, p.throttle, p.brake, p.handbrake, p.pause, p.cameraNext, p.anyPressed, p.nav.confirm]).toEqual([0, 0, 0, 0, false, false, false, false]);
      expect(p.gamepadId).toBeNull();
    }
  });

  it('the device switch works in a split too', () => {
    const { input, a, target } = twoPads();
    a.axes[0] = 1;
    expect(input.poll(1 / 60).device).toBe('gamepad');
    a.axes[0] = 0;
    key(target, 'keydown', 'KeyH');
    expect(input.poll(1 / 60).device).toBe('keyboard');
    setBtn(a, STD.x, true);
    expect(input.poll(1 / 60).device).toBe('gamepad');
  });

  it('reads the pad list once per poll, split or not, joining or not', () => {
    const slots: (FakePad | null)[] = [fakePad(0), fakePad(1), null, null];
    let calls = 0;
    const input = createInputSystem({ ...DEFAULT_SETTINGS.controls }, {
      getGamepads: () => {
        calls++;
        return slots as unknown as ArrayLike<PadLike | null>;
      },
      target: new EventTarget(),
    });
    input.poll(1 / 60);
    expect(calls).toBe(1);
    input.beginJoin();
    input.poll(1 / 60);
    expect(calls).toBe(2);
    input.bindPlayers(PAD0, PAD1);
    input.poll(1 / 60);
    input.poll(1 / 60);
    expect(calls).toBe(4);
    expect(input.primarySource()).toEqual(PAD0);
    expect(input.deviceName(PAD1)).toBe('Logitech Gamepad F310 (2)');
    expect(input.missingSeat()).toBeNull();
    expect(calls).toBe(4); // asking who plays on what does not look at the pads again
  });

  it('a seat bound to a pad that has not shown up yet is missing until it does', () => {
    const { input, slots } = setup();
    slots[0] = fakePad(0);
    input.poll(1 / 60);
    input.bindPlayers(PAD0, PAD1);
    input.poll(1 / 60);
    expect(input.missingSeat()).toBe(1);
    expect(input.players[1].gamepadId).toBeNull();
    const b = fakePad(1);
    b.axes[0] = 1;
    slots[1] = b;
    input.poll(1 / 60);
    expect(input.missingSeat()).toBeNull();
    expect(input.players[1].steer).toBeCloseTo(1, 10);
  });

  it('a split frame never allocates: the nav objects keep their identity when a seat is rebound', () => {
    const { input } = twoPads();
    const nav0 = input.players[0].nav;
    const merged = input.poll(1 / 60);
    const mergedNav = merged.nav;
    input.unbindPlayers();
    input.bindPlayers(PAD1, PAD0);
    input.poll(1 / 60);
    expect(input.players[0].nav).toBe(nav0);
    expect(input.poll(1 / 60).nav).toBe(mergedNav);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// the fake pads the QA scripts drive
// ─────────────────────────────────────────────────────────────────────────────

interface FakeControl {
  raw: FakePad;
  btn(i: number, v?: number): number;
  axis(i: number, v: number): number;
  connect(): void;
  disconnect(): void;
}

function loadFixture(search = '') {
  const src = readFileSync(new URL('../scripts/fixtures/fake-pad.js', import.meta.url), 'utf8');
  const win = new EventTarget() as EventTarget & { __pad: FakeControl; __pad2: FakeControl; __pads: FakeControl[] };
  const nav = {} as { getGamepads: () => (FakePad | null)[] };
  new Function('window', 'navigator', 'location', 'URLSearchParams', 'Event', src)(win, nav, { search }, URLSearchParams, Event);
  const events: { type: string; index: number }[] = [];
  for (const type of ['gamepadconnected', 'gamepaddisconnected']) {
    win.addEventListener(type, (e) => events.push({ type, index: (e as Event & { gamepad: FakePad }).gamepad.index }));
  }
  return { win, nav, events };
}

describe('scripts/fixtures/fake-pad.js', () => {
  it('keeps the one pad the QA scripts know: window.__pad, index 0, connected, the F310 id', () => {
    const { win, nav, events } = loadFixture();
    win.dispatchEvent(new Event('load'));
    expect(nav.getGamepads()).toEqual([win.__pad.raw, null, null, null]);
    const raw = win.__pad.raw;
    expect([raw.id, raw.index, raw.connected, raw.mapping, raw.buttons.length, raw.axes.length]).toEqual([F310, 0, true, 'standard', 17, 4]);
    expect(events).toEqual([{ type: 'gamepadconnected', index: 0 }]);
    expect(win.__pad.btn(0, 1)).toBe(1);
    expect(raw.buttons[0]).toMatchObject({ pressed: true, value: 1 });
    win.__pad.btn(0, 0);
    expect(raw.buttons[0]).toMatchObject({ pressed: false, value: 0 });
    expect(win.__pad.axis(0, -0.6)).toBe(-0.6);
    expect(raw.axes[0]).toBe(-0.6);
    expect(raw.vibrationActuator).toBeTruthy();
  });

  it('adds a second pad, unplugged, with the same id at index 1', () => {
    const { win, nav } = loadFixture();
    win.dispatchEvent(new Event('load'));
    expect(win.__pads).toEqual([win.__pad, win.__pad2]);
    expect(win.__pad2.raw.index).toBe(1);
    expect(win.__pad2.raw.id).toBe(win.__pad.raw.id);
    expect(win.__pad2.raw.connected).toBe(false);
    expect(nav.getGamepads()[1]).toBeNull();
  });

  it('plugs the second pad in at load with pad2=1 in the address', () => {
    const { win, nav, events } = loadFixture('?quick=race&pad2=1');
    win.dispatchEvent(new Event('load'));
    expect(nav.getGamepads()).toEqual([win.__pad.raw, win.__pad2.raw, null, null]);
    expect(events).toEqual([{ type: 'gamepadconnected', index: 0 }, { type: 'gamepadconnected', index: 1 }]);
    expect(loadFixture('?pad2=0').nav.getGamepads()[1]).toBeNull();
  });

  it('connect() and disconnect() fill and empty the slot and fire the events', () => {
    const { win, nav, events } = loadFixture();
    win.__pad2.btn(0, 1); // pressed before it is revealed, like a real pad
    win.__pad2.connect();
    expect(nav.getGamepads()[1]).toBe(win.__pad2.raw);
    expect(win.__pad2.raw.connected).toBe(true);
    expect(win.__pad2.raw.buttons[0].pressed).toBe(true);
    win.__pad2.connect(); // already there: nothing more
    win.__pad2.disconnect();
    expect(nav.getGamepads()[1]).toBeNull();
    expect(win.__pad2.raw.connected).toBe(false);
    expect(win.__pad2.raw.buttons[0].pressed).toBe(false);
    win.__pad2.disconnect();
    expect(events).toEqual([{ type: 'gamepadconnected', index: 1 }, { type: 'gamepaddisconnected', index: 1 }]);
    win.__pad.disconnect();
    expect(nav.getGamepads()[0]).toBeNull();
    win.__pad.connect();
    expect(nav.getGamepads()[0]).toBe(win.__pad.raw);
  });

  it('drives the input system end to end: the join step finds the second pad, and the seats follow their pads', () => {
    const { win, nav } = loadFixture();
    win.dispatchEvent(new Event('load'));
    const target = new EventTarget();
    const input = createInputSystem({ ...DEFAULT_SETTINGS.controls }, { getGamepads: nav.getGamepads as unknown as InputEnv['getGamepads'], target });
    input.poll(1 / 60);
    input.beginJoin();
    win.__pad2.btn(0, 1);
    win.__pad2.connect();
    input.poll(1 / 60);
    expect(input.takeJoiner()).toEqual(PAD1);
    input.bindPlayers(input.primarySource(), PAD1);
    win.__pad.axis(0, 1);
    win.__pad2.axis(0, -1);
    input.poll(1 / 60);
    expect(input.players[0].steer).toBeCloseTo(1, 10);
    expect(input.players[1].steer).toBeCloseTo(-1, 10);
    win.__pad2.disconnect();
    input.poll(1 / 60);
    expect(input.missingSeat()).toBe(1);
    win.__pad2.connect();
    input.poll(1 / 60);
    expect(input.missingSeat()).toBeNull();
  });
});
