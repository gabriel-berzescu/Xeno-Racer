/**
 * The "next track" button of the race music: D-pad right on the pad, N on the keyboard, either player's in a split screen. A one-shot
 * edge like the camera and the HUD toggles; the menus keep the D-pad (nav.right) as ever.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ControlSettings } from '../src/core/contracts';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { BINDINGS, PAD_LABEL, createInputSystem, STD, type InputEnv, type PadLike, type PlayerSource } from '../src/input';

interface FakePad extends Omit<PadLike, 'vibrationActuator' | 'axes' | 'buttons' | 'connected'> {
  axes: number[];
  buttons: { pressed: boolean; touched: boolean; value: number }[];
  connected: boolean;
  vibrationActuator: null;
}

const F310 = 'Logitech Gamepad F310 (STANDARD GAMEPAD Vendor: 046d Product: c21d)';

function fakePad(index = 0, over: Partial<Pick<FakePad, 'mapping' | 'axes' | 'id'>> & { buttons?: number } = {}): FakePad {
  return {
    id: over.id ?? F310,
    index,
    connected: true,
    mapping: over.mapping ?? 'standard',
    axes: over.axes ?? new Array(4).fill(0),
    buttons: Array.from({ length: over.buttons ?? 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    vibrationActuator: null,
  };
}

const press = (p: FakePad, i: number, on: boolean): void => {
  p.buttons[i].pressed = on;
  p.buttons[i].value = on ? 1 : 0;
};

function setup(target: EventTarget = new EventTarget()) {
  const slots: (FakePad | null)[] = [null, null, null, null];
  const env: InputEnv = { getGamepads: () => slots as unknown as ArrayLike<PadLike | null>, target };
  const controls: ControlSettings = { ...DEFAULT_SETTINGS.controls };
  const input = createInputSystem(controls, env);
  return { input, slots, target };
}

function key(target: EventTarget, type: 'keydown' | 'keyup', code: string, extra: Record<string, unknown> = {}): Event {
  const ev = Object.assign(new Event(type, { cancelable: true }), { code, key: '', repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }, extra);
  target.dispatchEvent(ev);
  return ev;
}

const DT = 1 / 60;
const PAD0: PlayerSource = { kind: 'pad', index: 0 };
const PAD1: PlayerSource = { kind: 'pad', index: 1 };
const KEYBOARD: PlayerSource = { kind: 'keyboard' };

describe('next track: one player', () => {
  it('D-pad right is true for exactly one poll, and fires again on a new press', () => {
    const { input, slots } = setup();
    const pad = fakePad();
    slots[0] = pad;
    input.poll(DT);
    press(pad, STD.dRight, true);
    expect(input.poll(DT).nextTrack).toBe(true);
    expect(input.poll(DT).nextTrack).toBe(false); // held: not an edge
    for (let i = 0; i < 60; i++) expect(input.poll(DT).nextTrack).toBe(false); // (the menus auto-repeat nav.right: this does not)
    press(pad, STD.dRight, false);
    expect(input.poll(DT).nextTrack).toBe(false);
    press(pad, STD.dRight, true);
    expect(input.poll(DT).nextTrack).toBe(true);
  });

  it('leaves the D-pad to the menus: nav.right still fires, and no other edge does', () => {
    const { input, slots } = setup();
    const pad = fakePad();
    slots[0] = pad;
    input.poll(DT);
    press(pad, STD.dRight, true);
    const f = input.poll(DT);
    expect(f.nav.right).toBe(true);
    expect(f.nextTrack).toBe(true);
    expect([f.toggleHud, f.toggleTelemetry, f.cameraNext, f.shiftUp, f.shiftDown, f.resetCar, f.pause]).toEqual([false, false, false, false, false, false, false]);
    // and the other D-pad directions do not skip a track
    press(pad, STD.dRight, false);
    input.poll(DT);
    for (const b of [STD.dUp, STD.dDown, STD.dLeft]) {
      press(pad, b, true);
      expect(input.poll(DT).nextTrack).toBe(false);
      press(pad, b, false);
      input.poll(DT);
    }
  });

  it('N is true for one poll, OS key repeat is ignored, a tap shorter than a frame is not lost', () => {
    const { input, target } = setup();
    key(target, 'keydown', 'KeyN');
    expect(input.poll(DT).nextTrack).toBe(true);
    key(target, 'keydown', 'KeyN', { repeat: true });
    key(target, 'keydown', 'KeyN', { repeat: true });
    expect(input.poll(DT).nextTrack).toBe(false);
    key(target, 'keyup', 'KeyN');
    key(target, 'keydown', 'KeyN');
    expect(input.poll(DT).nextTrack).toBe(true);
    key(target, 'keydown', 'KeyN');
    key(target, 'keyup', 'KeyN');
    expect(input.poll(DT).nextTrack).toBe(true);
  });

  it('keeps N from the browser (it is one of the keys the game handles)', () => {
    const { target } = setup();
    const ev = key(target, 'keydown', 'KeyN');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('ignores N typed into a text field (a name being entered)', () => {
    class Field extends EventTarget {
      tagName = 'INPUT';
      type = 'text';
    }
    const { input, target } = setup(new Field());
    key(target, 'keydown', 'KeyN');
    expect(input.poll(DT).nextTrack).toBe(false);
  });

  it('works on an F310 in D (DirectInput) mode: the hat\'s right', () => {
    const pad = fakePad(0, { id: 'Logitech Dual Action (Vendor: 046d Product: c216)', mapping: '', axes: new Array(10).fill(0), buttons: 12 });
    pad.axes[9] = 1.2857143; // hat centred
    const { input, slots } = setup();
    slots[0] = pad;
    input.poll(DT);
    pad.axes[9] = -0.4285714; // right
    const f = input.poll(DT);
    expect(f.nextTrack).toBe(true);
    expect(f.nav.right).toBe(true);
    expect(input.poll(DT).nextTrack).toBe(false);
  });

  it('is not set by anything on the first poll', () => {
    const { input } = setup();
    expect(input.poll(DT).nextTrack).toBe(false);
  });
});

describe('next track: split screen', () => {
  function twoPads() {
    const s = setup();
    const a = fakePad(0);
    const b = fakePad(1);
    s.slots[0] = a;
    s.slots[1] = b;
    s.input.poll(DT);
    s.input.bindPlayers(PAD0, PAD1);
    s.input.poll(DT);
    return { ...s, a, b };
  }

  it('either player\'s D-pad right skips: the merged frame has it, and each seat has its own', () => {
    const { input, a, b } = twoPads();
    press(a, STD.dRight, true);
    let f = input.poll(DT);
    expect(f.nextTrack).toBe(true);
    expect(input.players[0].nextTrack).toBe(true);
    expect(input.players[1].nextTrack).toBe(false);
    expect(input.poll(DT).nextTrack).toBe(false);
    press(a, STD.dRight, false);
    input.poll(DT);
    press(b, STD.dRight, true);
    f = input.poll(DT);
    expect(f.nextTrack).toBe(true);
    expect(input.players[1].nextTrack).toBe(true);
    expect(input.players[0].nextTrack).toBe(false);
  });

  it('two presses in the same poll are one skip', () => {
    const { input, a, b } = twoPads();
    press(a, STD.dRight, true);
    press(b, STD.dRight, true);
    const f = input.poll(DT);
    expect(f.nextTrack).toBe(true);
    expect(input.players[0].nextTrack && input.players[1].nextTrack).toBe(true);
    expect(input.poll(DT).nextTrack).toBe(false);
  });

  it('a pad and the keyboard: the keyboard seat skips with N, the pad seat with its D-pad, neither reads the other', () => {
    const s = setup();
    const a = fakePad(0);
    s.slots[0] = a;
    s.input.poll(DT);
    s.input.bindPlayers(PAD0, KEYBOARD);
    s.input.poll(DT);
    key(s.target, 'keydown', 'KeyN');
    let f = s.input.poll(DT);
    expect(f.nextTrack).toBe(true);
    expect(s.input.players[1].nextTrack).toBe(true);
    expect(s.input.players[0].nextTrack).toBe(false); // (a pad never reads the keyboard)
    key(s.target, 'keyup', 'KeyN');
    s.input.poll(DT);
    press(a, STD.dRight, true);
    f = s.input.poll(DT);
    expect(f.nextTrack).toBe(true);
    expect(s.input.players[0].nextTrack).toBe(true);
    expect(s.input.players[1].nextTrack).toBe(false); // (the keyboard seat never reads a pad)
  });

  it('a seat whose pad has gone holds still: no skip from it', () => {
    const { input, slots, a } = twoPads();
    press(a, STD.dRight, true);
    slots[0] = null; // unplugged while the button is down
    const f = input.poll(DT);
    expect(input.players[0].nextTrack).toBe(false);
    expect(f.nextTrack).toBe(false);
  });

  it('the frames of the two seats are neutral again once the split ends', () => {
    const { input, a } = twoPads();
    press(a, STD.dRight, true);
    input.poll(DT);
    input.unbindPlayers();
    expect(input.players[0].nextTrack).toBe(false);
    expect(input.players[1].nextTrack).toBe(false);
  });
});

describe('next track: the bindings the Controls screen lists', () => {
  it('lists it: D-pad right and N', () => {
    const b = BINDINGS.find((x) => x.id === 'nextTrack');
    expect(b).toBeDefined();
    expect(b!.label).toBe('Next track');
    expect(b!.pad).toEqual(['dRight']);
    expect(b!.keys).toEqual(['N']);
    expect(b!.hint.length).toBeGreaterThan(10);
  });

  it('does not clash with another binding: no control and no key is bound twice', () => {
    const pads = BINDINGS.flatMap((b) => b.pad);
    // (shift up and shift down have two buttons each, none is shared)
    expect(new Set(pads).size).toBe(pads.length);
    const keys = BINDINGS.flatMap((b) => b.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(BINDINGS.map((b) => b.id)).size).toBe(BINDINGS.length);
    for (const c of pads) expect(PAD_LABEL[c]).toBeTruthy();
  });
});

describe('next track in a spy frame', () => {
  it('survives Object.assign into the UI\'s copy of the frame', () => {
    const { input, slots } = setup();
    const pad = fakePad();
    slots[0] = pad;
    input.poll(DT);
    press(pad, STD.dRight, true);
    const copy = { nextTrack: false };
    Object.assign(copy, input.poll(DT));
    expect(copy.nextTrack).toBe(true);
    void vi;
  });
});
