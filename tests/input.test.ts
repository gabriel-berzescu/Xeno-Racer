import { describe, expect, it, vi } from 'vitest';
import {
  createInputSystem,
  decodeHat,
  hysteresis,
  KB_STEER_RAMP,
  pedal,
  prettyPadName,
  radialDeadzone,
  RepeatEdge,
  responseCurve,
  stepToward,
  STD,
  type InputEnv,
  type PadLike,
} from '../src/input';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import type { ControlSettings } from '../src/core/contracts';

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

interface FakePad extends Omit<PadLike, 'vibrationActuator' | 'axes' | 'buttons' | 'connected'> {
  axes: number[];
  buttons: { pressed: boolean; touched: boolean; value: number }[];
  connected: boolean;
  vibrationActuator: { playEffect: ReturnType<typeof vi.fn> } | null;
}

const F310_X_ID = 'Logitech Gamepad F310 (STANDARD GAMEPAD Vendor: 046d Product: c21d)';
const F310_D_ID = 'Logitech Dual Action (Vendor: 046d Product: c216)';

function fakePad(opts: { id?: string; mapping?: string; index?: number; axes?: number; buttons?: number; rumble?: boolean } = {}): FakePad {
  return {
    id: opts.id ?? F310_X_ID,
    index: opts.index ?? 0,
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

function controls(over: Partial<ControlSettings> = {}): ControlSettings {
  return { ...DEFAULT_SETTINGS.controls, ...over };
}

function setup(pads: (FakePad | null)[] = [], over: Partial<ControlSettings> = {}) {
  const target = new EventTarget();
  const list = pads;
  const env: InputEnv = { getGamepads: () => list as unknown as ArrayLike<PadLike | null>, target };
  const c = controls(over);
  const input = createInputSystem(c, env);
  return { input, target, pads: list, controls: c };
}

function key(target: EventTarget, type: 'keydown' | 'keyup', code: string, extra: Record<string, unknown> = {}): Event {
  const ev = Object.assign(new Event(type, { cancelable: true }), { code, key: '', repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }, extra);
  target.dispatchEvent(ev);
  return ev;
}

/** Press and release A so the pad becomes the active device. */
function wake(input: ReturnType<typeof createInputSystem>, pad: FakePad): void {
  setBtn(pad, STD.a, true);
  input.poll(1 / 60);
  setBtn(pad, STD.a, false);
  input.poll(1 / 60);
}

/** Poll `seconds` of time at 60 Hz, return the last frame. */
function run(input: ReturnType<typeof createInputSystem>, seconds: number, hz = 60) {
  const dt = 1 / hz;
  let f = input.poll(0);
  const n = Math.round(seconds * hz);
  for (let i = 0; i < n; i++) f = input.poll(dt);
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────
// pure processing
// ─────────────────────────────────────────────────────────────────────────────

describe('radialDeadzone', () => {
  const out = [0, 0];
  it('zeroes everything inside the dead zone', () => {
    radialDeadzone(0.05, 0.05, 0.08, out);
    expect(out).toEqual([0, 0]);
    radialDeadzone(0, 0, 0.08, out);
    expect(out).toEqual([0, 0]);
  });
  it('rescales so there is no step at the edge and full deflection stays 1', () => {
    radialDeadzone(0.08001, 0, 0.08, out);
    expect(out[0]).toBeLessThan(0.001);
    radialDeadzone(1, 0, 0.08, out);
    expect(out[0]).toBeCloseTo(1, 10);
    radialDeadzone(0.5, 0, 0.08, out);
    expect(out[0]).toBeCloseTo((0.5 - 0.08) / 0.92, 10);
  });
  it('keeps the sign and treats the stick as one 2D vector', () => {
    radialDeadzone(-0.5, 0, 0.08, out);
    expect(out[0]).toBeCloseTo(-(0.5 - 0.08) / 0.92, 10);
    // 0.06 on X alone is inside the dead zone; with Y pushed hard the vector is outside it.
    radialDeadzone(0.06, 0, 0.08, out);
    expect(out[0]).toBe(0);
    radialDeadzone(0.06, 0.9, 0.08, out);
    expect(out[0]).toBeGreaterThan(0);
  });
  it('does not shrink a square-gate corner (1,1) to 0.7', () => {
    radialDeadzone(1, 1, 0.08, out);
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(1);
  });
});

describe('responseCurve', () => {
  it('is the identity at linearity 1', () => {
    expect(responseCurve(0.37, 1)).toBe(0.37);
    expect(responseCurve(-0.9, 1)).toBe(-0.9);
  });
  it('gives finer control near center at linearity > 1 and keeps +-1', () => {
    expect(responseCurve(0.5, 2)).toBeCloseTo(0.25, 10);
    expect(responseCurve(-0.5, 2)).toBeCloseTo(-0.25, 10);
    expect(responseCurve(1, 2.5)).toBe(1);
    expect(responseCurve(-1, 2.5)).toBe(-1);
    expect(responseCurve(0, 1.6)).toBe(0);
  });
});

describe('pedal', () => {
  it('applies the dead zone and rescales', () => {
    expect(pedal(0.03, 0.04)).toBe(0);
    expect(pedal(0.04, 0.04)).toBe(0);
    expect(pedal(0.5, 0.04)).toBeCloseTo(0.46 / 0.96, 10);
    expect(pedal(1, 0.04)).toBe(1);
    expect(pedal(1.2, 0.04)).toBe(1);
  });
});

describe('stepToward', () => {
  it('never overshoots', () => {
    expect(stepToward(0, 1, 3.5, 0.1)).toBeCloseTo(0.35, 10);
    expect(stepToward(0.9, 1, 3.5, 0.1)).toBe(1);
    expect(stepToward(0.1, -1, 10, 1)).toBe(-1);
    expect(stepToward(0.5, 0.5, 5, 0.1)).toBe(0.5);
  });
});

describe('decodeHat (POV hat reported as one axis)', () => {
  const h = { up: false, down: false, left: false, right: false };
  const dirs = (v: number): string => {
    decodeHat(v, h);
    return [h.up && 'U', h.down && 'D', h.left && 'L', h.right && 'R'].filter(Boolean).join('');
  };
  it('decodes the eight directions clockwise from up', () => {
    expect(dirs(-1)).toBe('U');
    expect(dirs(-0.7142857)).toBe('UR');
    expect(dirs(-0.4285714)).toBe('R');
    expect(dirs(-0.1428571)).toBe('DR');
    expect(dirs(0.1428571)).toBe('D');
    expect(dirs(0.4285714)).toBe('DL');
    expect(dirs(0.7142857)).toBe('L');
    expect(dirs(1)).toBe('UL');
  });
  it('treats the centered value (~1.286) and NaN as neutral', () => {
    expect(dirs(1.2857143)).toBe('');
    expect(dirs(NaN)).toBe('');
  });
});

describe('RepeatEdge (menu auto-repeat)', () => {
  it('fires on press, again after ~300 ms, then every ~90 ms, and stops on release', () => {
    const r = new RepeatEdge();
    const dt = 1 / 120;
    const hits: number[] = [];
    let t = 0;
    for (let i = 0; i < 240; i++) {
      if (r.update(true, dt)) hits.push(t);
      t += dt;
    }
    expect(hits[0]).toBe(0);
    expect(hits[1]).toBeGreaterThanOrEqual(0.3 - 1e-9);
    expect(hits[1]).toBeLessThan(0.3 + dt + 1e-9);
    for (let i = 2; i < hits.length; i++) {
      const gap = hits[i] - hits[i - 1];
      expect(gap).toBeGreaterThan(0.08);
      expect(gap).toBeLessThan(0.1);
    }
    expect(hits.length).toBeGreaterThan(18); // ~ (2 - 0.3) / 0.09 + 2
    expect(r.update(false, dt)).toBe(false);
    expect(r.update(true, dt)).toBe(true); // a new press starts over
  });
  it('never bursts after a long frame', () => {
    const r = new RepeatEdge();
    r.update(true, 0.016);
    let count = 0;
    for (let i = 0; i < 3; i++) if (r.update(true, 0.5)) count++;
    expect(count).toBe(3); // at most one per update
    // after the hitch, the next repeat is a full rate away, not an immediate backlog
    expect(r.update(true, 0.01)).toBe(false);
  });
});

describe('hysteresis', () => {
  it('engages at 0.55 and releases at 0.35', () => {
    expect(hysteresis(0.5, 0)).toBe(0);
    expect(hysteresis(0.6, 0)).toBe(1);
    expect(hysteresis(0.4, 1)).toBe(1); // still held between the thresholds
    expect(hysteresis(0.3, 1)).toBe(0);
    expect(hysteresis(-0.6, 0)).toBe(-1);
    expect(hysteresis(-0.4, -1)).toBe(-1);
    expect(hysteresis(0.9, -1)).toBe(1); // flicked straight across
  });
});

describe('prettyPadName', () => {
  it('strips the browser suffixes', () => {
    expect(prettyPadName(F310_X_ID)).toBe('Logitech Gamepad F310');
    expect(prettyPadName('046d-c21d-Logitech Gamepad F310')).toBe('Logitech Gamepad F310');
    expect(prettyPadName('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe('Xbox 360 Controller');
    expect(prettyPadName(null)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gamepad
// ─────────────────────────────────────────────────────────────────────────────

describe('gamepad driving axes', () => {
  it('maps the left stick to steer through the dead zone and the response curve', () => {
    const pad = fakePad();
    const { input } = setup([pad]);
    pad.axes[0] = 1;
    expect(input.poll(1 / 60).steer).toBeCloseTo(1, 10);
    pad.axes[0] = -1;
    expect(input.poll(1 / 60).steer).toBeCloseTo(-1, 10);
    pad.axes[0] = 0.5;
    const expected = Math.pow((0.5 - 0.08) / 0.92, 1.6);
    expect(input.poll(1 / 60).steer).toBeCloseTo(expected, 10);
    pad.axes[0] = 0.05; // inside the dead zone
    expect(input.poll(1 / 60).steer).toBe(0);
  });

  it('honours live changes to the control settings (steerDeadzone / steerLinearity)', () => {
    const pad = fakePad();
    const { input, controls: c } = setup([pad]);
    wake(input, pad);
    pad.axes[0] = 0.5;
    c.steerLinearity = 1;
    c.steerDeadzone = 0;
    expect(input.poll(1 / 60).steer).toBeCloseTo(0.5, 10);
    input.setControls({ ...c, steerLinearity: 2, steerDeadzone: 0 });
    expect(input.poll(1 / 60).steer).toBeCloseTo(0.25, 10);
  });

  it('maps RT to throttle and LT to brake with the pedal dead zone', () => {
    const pad = fakePad();
    const { input } = setup([pad]);
    setBtn(pad, STD.rt, 0.5);
    let f = input.poll(1 / 60);
    expect(f.throttle).toBeCloseTo((0.5 - 0.04) / 0.96, 10);
    expect(f.brake).toBe(0);
    setBtn(pad, STD.rt, 0.03);
    expect(input.poll(1 / 60).throttle).toBe(0);
    setBtn(pad, STD.rt, 0);
    setBtn(pad, STD.lt, 1);
    f = input.poll(1 / 60);
    expect(f.brake).toBe(1);
    expect(f.throttle).toBe(0);
  });

  it('A is the handbrake, RS click is look-back (held), right stick is look', () => {
    const pad = fakePad();
    const { input } = setup([pad]);
    setBtn(pad, STD.a, true);
    expect(input.poll(1 / 60).handbrake).toBe(1);
    expect(input.poll(1 / 60).handbrake).toBe(1); // held, not an edge
    setBtn(pad, STD.a, false);
    expect(input.poll(1 / 60).handbrake).toBe(0);
    setBtn(pad, STD.rsClick, true);
    expect(input.poll(1 / 60).lookBack).toBe(true);
    expect(input.poll(1 / 60).lookBack).toBe(true);
    setBtn(pad, STD.rsClick, false);
    expect(input.poll(1 / 60).lookBack).toBe(false);
    pad.axes[2] = 1;
    pad.axes[3] = -1; // stick pushed up
    let f = input.poll(1 / 60);
    expect(f.lookX).toBe(1);
    expect(f.lookY).toBe(1); // +1 = up
    pad.axes[3] = 1;
    expect(input.poll(1 / 60).lookY).toBe(-1);
  });

  it('invertLookY flips lookY', () => {
    const pad = fakePad();
    const { input } = setup([pad], { invertLookY: true });
    wake(input, pad);
    pad.axes[3] = -1;
    expect(input.poll(1 / 60).lookY).toBe(-1);
  });

  it('never reports a clutch value', () => {
    const { input } = setup([fakePad()]);
    expect(input.poll(1 / 60).clutch).toBe(0);
  });
});

describe('gamepad one-shot edges', () => {
  const cases: [string, number, keyof ReturnType<ReturnType<typeof createInputSystem>['poll']>][] = [
    ['RB -> shiftUp', STD.rb, 'shiftUp'],
    ['B -> shiftUp', STD.b, 'shiftUp'],
    ['LB -> shiftDown', STD.lb, 'shiftDown'],
    ['X -> shiftDown', STD.x, 'shiftDown'],
    ['Y -> cameraNext', STD.y, 'cameraNext'],
    ['Back -> resetCar', STD.back, 'resetCar'],
    ['Start -> pause', STD.start, 'pause'],
    ['D-pad up -> toggleHud', STD.dUp, 'toggleHud'],
    ['D-pad down -> toggleTelemetry', STD.dDown, 'toggleTelemetry'],
  ];
  for (const [name, btn, field] of cases) {
    it(`${name}: true for exactly one poll`, () => {
      const pad = fakePad();
      const { input } = setup([pad]);
      input.poll(1 / 60);
      setBtn(pad, btn, true);
      expect(input.poll(1 / 60)[field]).toBe(true);
      expect(input.poll(1 / 60)[field]).toBe(false);
      expect(input.poll(1 / 60)[field]).toBe(false);
      setBtn(pad, btn, false);
      expect(input.poll(1 / 60)[field]).toBe(false);
      setBtn(pad, btn, true);
      expect(input.poll(1 / 60)[field]).toBe(true); // a new press fires again
    });
  }

  it('counts the press that revealed the pad as an edge (Chrome only exposes pads after a press)', () => {
    const pad = fakePad();
    const pads: (FakePad | null)[] = [null];
    const { input } = setup(pads);
    expect(input.poll(1 / 60).anyPressed).toBe(false);
    setBtn(pad, STD.a, true);
    pads[0] = pad;
    const f = input.poll(1 / 60);
    expect(f.anyPressed).toBe(true);
    expect(f.nav.confirm).toBe(true);
    expect(f.device).toBe('gamepad');
  });
});

describe('gamepad menu navigation', () => {
  it('D-pad produces an edge, then auto-repeats after ~300 ms at ~90 ms', () => {
    const pad = fakePad();
    const { input } = setup([pad]);
    input.poll(1 / 60);
    setBtn(pad, STD.dDown, true);
    const hits: number[] = [];
    let t = 0;
    for (let i = 0; i < 120; i++) {
      const f = input.poll(1 / 60);
      if (f.nav.down) hits.push(t);
      t += 1 / 60;
    }
    expect(hits[0]).toBe(0);
    expect(hits[1]).toBeGreaterThanOrEqual(0.29);
    expect(hits[1]).toBeLessThanOrEqual(0.33);
    expect(hits[2] - hits[1]).toBeGreaterThanOrEqual(0.08);
    expect(hits[2] - hits[1]).toBeLessThanOrEqual(0.11);
    expect(hits.length).toBeGreaterThanOrEqual(15);
  });

  it('left stick navigates with hysteresis and only the dominant axis', () => {
    const pad = fakePad();
    const { input } = setup([pad]);
    input.poll(1 / 60);
    pad.axes[0] = 0.4; // below the engage threshold
    expect(input.poll(1 / 60).nav.right).toBe(false);
    pad.axes[0] = 0.7;
    let f = input.poll(1 / 60);
    expect(f.nav.right).toBe(true);
    expect(f.nav.up).toBe(false);
    pad.axes[0] = 0.45; // between the thresholds: still held, no new edge
    expect(input.poll(1 / 60).nav.right).toBe(false);
    pad.axes[0] = 0.2; // released
    input.poll(1 / 60);
    pad.axes[0] = 0;
    pad.axes[1] = -0.9;
    f = input.poll(1 / 60);
    expect(f.nav.up).toBe(true);
    pad.axes[0] = 0.6;
    pad.axes[1] = -0.7; // diagonal: vertical dominates
    f = input.poll(1 / 60);
    expect(f.nav.right).toBe(false);
  });

  it('A and Start confirm, B goes back, LB/RB are the tabs (edges, no repeat)', () => {
    const pad = fakePad();
    const { input } = setup([pad]);
    input.poll(1 / 60);
    setBtn(pad, STD.a, true);
    expect(input.poll(1 / 60).nav.confirm).toBe(true);
    expect(input.poll(1 / 60).nav.confirm).toBe(false);
    setBtn(pad, STD.a, false);
    setBtn(pad, STD.start, true);
    expect(input.poll(1 / 60).nav.confirm).toBe(true);
    setBtn(pad, STD.start, false);
    setBtn(pad, STD.b, true);
    expect(input.poll(1 / 60).nav.back).toBe(true);
    setBtn(pad, STD.b, false);
    setBtn(pad, STD.lb, true);
    expect(input.poll(1 / 60).nav.tabLeft).toBe(true);
    setBtn(pad, STD.lb, false);
    setBtn(pad, STD.rb, true);
    expect(input.poll(1 / 60).nav.tabRight).toBe(true);
  });

  it('anyPressed is true only on the poll where a button went down (not for stick movement)', () => {
    const pad = fakePad();
    const { input } = setup([pad]);
    input.poll(1 / 60);
    pad.axes[0] = 1;
    expect(input.poll(1 / 60).anyPressed).toBe(false);
    setBtn(pad, STD.x, true);
    expect(input.poll(1 / 60).anyPressed).toBe(true);
    expect(input.poll(1 / 60).anyPressed).toBe(false);
  });
});

describe('device selection', () => {
  it('starts on the keyboard, goes to the gamepad on pad activity and back on a key', () => {
    const pad = fakePad();
    const { input, target } = setup([pad]);
    expect(input.poll(1 / 60).device).toBe('keyboard');
    pad.axes[0] = 1; // big stick move
    expect(input.poll(1 / 60).device).toBe('gamepad');
    pad.axes[0] = 0;
    expect(input.poll(1 / 60).device).toBe('gamepad');
    key(target, 'keydown', 'KeyW');
    let f = input.poll(1 / 60);
    expect(f.device).toBe('keyboard');
    key(target, 'keyup', 'KeyW');
    setBtn(pad, STD.rt, 1);
    f = input.poll(1 / 60);
    expect(f.device).toBe('gamepad');
    expect(f.throttle).toBe(1);
  });

  it('ignores stick drift for device switching', () => {
    const pad = fakePad();
    const { input, target } = setup([pad]);
    key(target, 'keydown', 'KeyA');
    expect(input.poll(1 / 60).device).toBe('keyboard');
    pad.axes[0] = 0.2; // drift
    pad.axes[1] = -0.15;
    expect(input.poll(1 / 60).device).toBe('keyboard');
  });

  it('keyboard device ignores the pad axes (keyboard wins until the pad is used again)', () => {
    const pad = fakePad();
    const { input, target } = setup([pad]);
    key(target, 'keydown', 'KeyD');
    pad.axes[0] = 0.2; // drift only
    const f = run(input, 0.05);
    expect(f.device).toBe('keyboard');
    expect(f.steer).toBeGreaterThan(0.1); // ramping from the key, not the stick
  });

  it('reports the pad id on every frame, even while on the keyboard', () => {
    const pad = fakePad();
    const { input, target } = setup([pad]);
    key(target, 'keydown', 'KeyW');
    const f = input.poll(1 / 60);
    expect(f.device).toBe('keyboard');
    expect(f.gamepadId).toBe(F310_X_ID);
  });
});

describe('pad selection and connection', () => {
  it('reports connected / padName and handles disconnects', () => {
    const pad = fakePad();
    const pads: (FakePad | null)[] = [pad];
    const { input } = setup(pads);
    input.poll(1 / 60);
    expect(input.connected).toBe(true);
    expect(input.padName).toBe('Logitech Gamepad F310');
    expect(input.warning).toBeNull();
    pad.connected = false;
    const f = input.poll(1 / 60);
    expect(input.connected).toBe(false);
    expect(input.padName).toBeNull();
    expect(f.gamepadId).toBeNull();
  });

  it('is not connected when there are no pads or the API throws', () => {
    const { input } = setup([null, null]);
    expect(input.poll(1 / 60).gamepadId).toBeNull();
    expect(input.connected).toBe(false);
    const throwing = createInputSystem(controls(), {
      target: new EventTarget(),
      getGamepads: () => {
        throw new Error('SecurityError');
      },
    });
    expect(() => throwing.poll(1 / 60)).not.toThrow();
    expect(throwing.connected).toBe(false);
  });

  it('prefers a standard pad over a non-standard one, ignores things that are not shaped like a pad', () => {
    const weird = fakePad({ id: 'Wireless Receiver', mapping: '', axes: 2, buttons: 3, index: 0 });
    const dinput = fakePad({ id: F310_D_ID, mapping: '', axes: 10, buttons: 12, index: 1 });
    const std = fakePad({ index: 2 });
    const { input } = setup([weird, dinput, std]);
    input.poll(1 / 60);
    expect(input.padName).toBe('Logitech Gamepad F310');
    expect(input.warning).toBeNull();
    const { input: i2 } = setup([weird]);
    i2.poll(1 / 60);
    expect(i2.connected).toBe(false);
  });
});

describe('non-standard pad (F310 switched to D)', () => {
  it('exposes the "switch to X mode" warning', () => {
    const pad = fakePad({ id: F310_D_ID, mapping: '', axes: 10, buttons: 12 });
    const { input } = setup([pad]);
    input.poll(1 / 60);
    expect(input.connected).toBe(true);
    expect(input.warning).toMatch(/X mode/);
    expect(input.warning).toMatch(/F310/);
  });

  it('gives a generic warning for other non-standard pads', () => {
    const pad = fakePad({ id: 'Generic USB Joystick', mapping: '', axes: 6, buttons: 12 });
    const { input } = setup([pad]);
    input.poll(1 / 60);
    expect(input.warning).toMatch(/standard layout/);
  });

  it('maps best-effort: rotated face buttons, digital triggers, right stick on axis 5, hat D-pad', () => {
    const pad = fakePad({ id: F310_D_ID, mapping: '', axes: 10, buttons: 12 });
    pad.axes[9] = 1.2857143; // hat centered
    const { input } = setup([pad]);
    input.poll(1 / 60);
    setBtn(pad, 1, true); // A is button 1 in D mode
    let f = input.poll(1 / 60);
    expect(f.handbrake).toBe(1);
    expect(f.nav.confirm).toBe(true);
    setBtn(pad, 1, false);
    setBtn(pad, 7, true); // RT (digital)
    f = input.poll(1 / 60);
    expect(f.throttle).toBe(1);
    setBtn(pad, 7, false);
    pad.axes[5] = -1; // right stick up
    f = input.poll(1 / 60);
    expect(f.lookY).toBe(1);
    pad.axes[5] = 0;
    pad.axes[9] = 0.1428571; // hat: down
    f = input.poll(1 / 60);
    expect(f.toggleTelemetry).toBe(true);
    expect(f.nav.down).toBe(true);
  });
});

describe('rumble', () => {
  it('calls the dual-rumble effect with clamped magnitudes', () => {
    const pad = fakePad({ rumble: true });
    const { input } = setup([pad]);
    input.poll(1 / 60);
    input.rumble(2, -1, 120);
    expect(pad.vibrationActuator!.playEffect).toHaveBeenCalledTimes(1);
    expect(pad.vibrationActuator!.playEffect).toHaveBeenCalledWith('dual-rumble', { startDelay: 0, duration: 120, strongMagnitude: 1, weakMagnitude: 0 });
  });

  it('is a silent no-op without an actuator (the F310) or with vibration off', () => {
    const f310 = fakePad({ rumble: false });
    const { input } = setup([f310]);
    input.poll(1 / 60);
    expect(() => input.rumble(1, 1, 100)).not.toThrow();
    const motors = fakePad({ rumble: true });
    const { input: off } = setup([motors], { vibration: false });
    off.poll(1 / 60);
    off.rumble(1, 1, 100);
    expect(motors.vibrationActuator!.playEffect).not.toHaveBeenCalled();
    const { input: none } = setup([]);
    expect(() => none.rumble(1, 1, 100)).not.toThrow();
  });

  it('swallows a rejected promise and a throwing actuator', () => {
    const pad = fakePad({ rumble: true });
    pad.vibrationActuator!.playEffect.mockImplementation(() => Promise.reject(new Error('nope')));
    const { input } = setup([pad]);
    input.poll(1 / 60);
    expect(() => input.rumble(1, 1, 50)).not.toThrow();
    pad.vibrationActuator!.playEffect.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => input.rumble(1, 1, 50)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// keyboard
// ─────────────────────────────────────────────────────────────────────────────

describe('keyboard driving', () => {
  it('steering ramps to +-1 at ~3.5 per second and recenters faster', () => {
    const { input, target } = setup();
    key(target, 'keydown', 'KeyD');
    let f = run(input, 0.1);
    expect(f.steer).toBeGreaterThan(KB_STEER_RAMP * 0.1 - 0.05);
    expect(f.steer).toBeLessThan(KB_STEER_RAMP * 0.1 + 0.05);
    f = run(input, 0.5);
    expect(f.steer).toBe(1);
    key(target, 'keyup', 'KeyD');
    f = run(input, 0.1);
    expect(f.steer).toBeGreaterThan(0); // not instant
    expect(f.steer).toBeLessThan(0.5);
    f = run(input, 0.1);
    expect(f.steer).toBe(0); // recentered in ~0.15 s, faster than the ramp-in
  });

  it('crossing from right to left goes through center quickly', () => {
    const { input, target } = setup();
    key(target, 'keydown', 'ArrowRight');
    run(input, 0.5);
    key(target, 'keyup', 'ArrowRight');
    key(target, 'keydown', 'ArrowLeft');
    let f = run(input, 0.14);
    expect(Math.abs(f.steer)).toBeLessThan(0.12); // crossed zero at the fast rate
    f = run(input, 0.4);
    expect(f.steer).toBe(-1);
  });

  it('left and right together cancel out', () => {
    const { input, target } = setup();
    key(target, 'keydown', 'KeyA');
    key(target, 'keydown', 'KeyD');
    expect(run(input, 0.3).steer).toBe(0);
  });

  it('throttle and brake ramp quickly (not instantly) and release faster', () => {
    const { input, target } = setup();
    key(target, 'keydown', 'KeyW');
    let f = input.poll(1 / 60);
    expect(f.throttle).toBeGreaterThan(0);
    expect(f.throttle).toBeLessThan(0.5);
    f = run(input, 0.25);
    expect(f.throttle).toBe(1);
    key(target, 'keyup', 'KeyW');
    key(target, 'keydown', 'KeyS');
    f = run(input, 0.3);
    expect(f.throttle).toBe(0);
    expect(f.brake).toBe(1);
  });

  it('Space is the handbrake, V looks back, IJKL look around', () => {
    const { input, target } = setup();
    key(target, 'keydown', 'Space');
    expect(run(input, 0.1).handbrake).toBe(1);
    key(target, 'keyup', 'Space');
    expect(run(input, 0.1).handbrake).toBe(0);
    key(target, 'keydown', 'KeyV');
    expect(input.poll(1 / 60).lookBack).toBe(true);
    key(target, 'keyup', 'KeyV');
    expect(input.poll(1 / 60).lookBack).toBe(false);
    key(target, 'keydown', 'KeyL');
    key(target, 'keydown', 'KeyI');
    const f = run(input, 0.3);
    expect(f.lookX).toBe(1);
    expect(f.lookY).toBe(1);
  });

  it('arrow keys and WASD are interchangeable for driving', () => {
    const { input, target } = setup();
    key(target, 'keydown', 'ArrowUp');
    key(target, 'keydown', 'ArrowRight');
    const f = run(input, 0.5);
    expect(f.throttle).toBe(1);
    expect(f.steer).toBe(1);
  });
});

describe('keyboard one-shot edges', () => {
  const cases: [string, string, string][] = [
    ['E', 'KeyE', 'shiftUp'],
    ['Shift', 'ShiftLeft', 'shiftUp'],
    ['Q', 'KeyQ', 'shiftDown'],
    ['Ctrl', 'ControlLeft', 'shiftDown'],
    ['C', 'KeyC', 'cameraNext'],
    ['R', 'KeyR', 'resetCar'],
    ['Esc', 'Escape', 'pause'],
    ['P', 'KeyP', 'pause'],
    ['H', 'KeyH', 'toggleHud'],
    ['T', 'KeyT', 'toggleTelemetry'],
  ];
  for (const [name, code, field] of cases) {
    it(`${name} -> ${field}: one poll only, OS key-repeat ignored`, () => {
      const { input, target } = setup();
      key(target, 'keydown', code);
      const f = input.poll(1 / 60) as unknown as Record<string, unknown>;
      expect(f[field]).toBe(true);
      key(target, 'keydown', code, { repeat: true });
      key(target, 'keydown', code, { repeat: true });
      expect((input.poll(1 / 60) as unknown as Record<string, unknown>)[field]).toBe(false);
      key(target, 'keyup', code);
      key(target, 'keydown', code);
      expect((input.poll(1 / 60) as unknown as Record<string, unknown>)[field]).toBe(true);
    });
  }

  it('a tap shorter than one frame is not lost', () => {
    const { input, target } = setup();
    key(target, 'keydown', 'KeyC');
    key(target, 'keyup', 'KeyC');
    expect(input.poll(1 / 60).cameraNext).toBe(true);
  });
});

describe('keyboard menu navigation', () => {
  it('arrows navigate with the same auto-repeat; Enter confirms; Esc and Backspace go back; Q/E and PgUp/PgDn are tabs', () => {
    const { input, target } = setup();
    input.poll(1 / 60);
    key(target, 'keydown', 'ArrowDown');
    const hits: number[] = [];
    let t = 0;
    for (let i = 0; i < 60; i++) {
      if (input.poll(1 / 60).nav.down) hits.push(t);
      t += 1 / 60;
    }
    expect(hits[0]).toBe(0);
    expect(hits[1]).toBeGreaterThanOrEqual(0.29);
    expect(hits[1]).toBeLessThanOrEqual(0.33);
    key(target, 'keyup', 'ArrowDown');
    expect(input.poll(1 / 60).nav.down).toBe(false);

    key(target, 'keydown', 'Enter');
    expect(input.poll(1 / 60).nav.confirm).toBe(true);
    key(target, 'keydown', 'Escape');
    let f = input.poll(1 / 60);
    expect(f.nav.back).toBe(true);
    expect(f.pause).toBe(true);
    key(target, 'keydown', 'Backspace');
    expect(input.poll(1 / 60).nav.back).toBe(true);
    key(target, 'keydown', 'KeyQ');
    f = input.poll(1 / 60);
    expect(f.nav.tabLeft).toBe(true);
    key(target, 'keydown', 'PageDown');
    expect(input.poll(1 / 60).nav.tabRight).toBe(true);
  });

  it('a tap on an arrow key shorter than one frame still produces one menu edge', () => {
    const { input, target } = setup();
    input.poll(1 / 60);
    key(target, 'keydown', 'ArrowDown');
    key(target, 'keyup', 'ArrowDown');
    expect(input.poll(1 / 60).nav.down).toBe(true);
    expect(input.poll(1 / 60).nav.down).toBe(false);
    expect(input.poll(1 / 60).nav.down).toBe(false);
    // ...and a tap does not start an auto-repeat
    let extra = 0;
    for (let i = 0; i < 60; i++) if (input.poll(1 / 60).nav.down) extra++;
    expect(extra).toBe(0);
    // all four directions
    for (const [code, field] of [['ArrowUp', 'up'], ['ArrowLeft', 'left'], ['ArrowRight', 'right']] as const) {
      key(target, 'keydown', code);
      key(target, 'keyup', code);
      expect(input.poll(1 / 60).nav[field]).toBe(true);
    }
  });

  it('anyPressed fires on a key press (to unlock audio / dismiss the title)', () => {
    const { input, target } = setup();
    expect(input.poll(1 / 60).anyPressed).toBe(false);
    key(target, 'keydown', 'KeyG');
    expect(input.poll(1 / 60).anyPressed).toBe(true);
    expect(input.poll(1 / 60).anyPressed).toBe(false);
  });
});

describe('keyboard event hygiene', () => {
  it('prevents default only for game keys (F5, F12 and Tab keep working)', () => {
    const { target } = setup();
    expect(key(target, 'keydown', 'Space').defaultPrevented).toBe(true);
    expect(key(target, 'keydown', 'ArrowUp').defaultPrevented).toBe(true);
    expect(key(target, 'keydown', 'F5').defaultPrevented).toBe(false);
    expect(key(target, 'keydown', 'F12').defaultPrevented).toBe(false);
    expect(key(target, 'keydown', 'Tab').defaultPrevented).toBe(false);
    expect(key(target, 'keydown', 'KeyR', { ctrlKey: true }).defaultPrevented).toBe(false); // Ctrl+R reloads
    expect(key(target, 'keydown', 'ArrowLeft', { altKey: true }).defaultPrevented).toBe(false); // Alt+Left = browser back
  });

  it('ignores keys typed into a text field (player name) entirely', () => {
    const { input, target } = setup();
    const ev = Object.assign(new Event('keydown', { cancelable: true }), { code: 'KeyW', repeat: false, ctrlKey: false, altKey: false, metaKey: false });
    Object.defineProperty(ev, 'target', { value: { tagName: 'INPUT', type: 'text' } });
    target.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    const f = run(input, 0.2);
    expect(f.throttle).toBe(0);
    expect(f.anyPressed).toBe(false);
    // ...but a range/checkbox input is not a typing target
    const ev2 = Object.assign(new Event('keydown', { cancelable: true }), { code: 'KeyW', repeat: false, ctrlKey: false, altKey: false, metaKey: false });
    Object.defineProperty(ev2, 'target', { value: { tagName: 'INPUT', type: 'checkbox' } });
    target.dispatchEvent(ev2);
    expect(run(input, 0.3).throttle).toBe(1);
  });

  it('releases every key when the window loses focus', () => {
    const { input, target } = setup();
    key(target, 'keydown', 'KeyW');
    key(target, 'keydown', 'KeyD');
    expect(run(input, 0.3).throttle).toBe(1);
    target.dispatchEvent(new Event('blur'));
    const f = run(input, 0.4);
    expect(f.throttle).toBe(0);
    expect(f.steer).toBe(0);
  });

  it('dispose removes the listeners', () => {
    const { input, target } = setup();
    input.dispose();
    key(target, 'keydown', 'KeyW');
    expect(run(input, 0.3).throttle).toBe(0);
  });
});

describe('frame object', () => {
  it('is reused between polls (no per-frame allocation)', () => {
    const { input } = setup();
    const a = input.poll(1 / 60);
    const b = input.poll(1 / 60);
    expect(a).toBe(b);
    expect(a.nav).toBe(b.nav);
  });

  it('tolerates dt = 0, negative dt and huge dt', () => {
    const { input, target } = setup();
    key(target, 'keydown', 'KeyD');
    expect(() => {
      input.poll(0);
      input.poll(-1);
      input.poll(10);
    }).not.toThrow();
    expect(input.poll(10).steer).toBeLessThanOrEqual(1);
  });
});
