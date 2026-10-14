/**
 * Pure input-processing helpers (no DOM, no state beyond what the classes hold). Everything here is
 * allocation-free per call so it can run inside the per-frame poll.
 */

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Radial dead zone with rescale. The stick vector (x, y) is treated as one 2D value: anything inside
 * the dead zone circle is zero, and the remaining range [dz, 1] is stretched back to [0, 1] so there is
 * no "step" when the stick leaves the dead zone. Writes the result into `out[0]`, `out[1]`.
 *
 * The magnitude is NOT clamped to 1 before rescaling: square-gate sticks reach |(1, 1)| = 1.41 in the
 * corners, and clamping would turn a full-lock diagonal into 0.7 steering. The output axes are clamped.
 */
export function radialDeadzone(x: number, y: number, dz: number, out: { [i: number]: number }): void {
  const d = clamp(dz, 0, 0.95);
  const mag = Math.sqrt(x * x + y * y);
  if (mag <= d || mag === 0) {
    out[0] = 0;
    out[1] = 0;
    return;
  }
  const k = (mag - d) / (1 - d) / mag;
  out[0] = clamp(x * k, -1, 1);
  out[1] = clamp(y * k, -1, 1);
}

/** Sign-preserving power curve. `linearity` 1 = linear, > 1 = finer control near the center. */
export function responseCurve(v: number, linearity: number): number {
  const lin = clamp(linearity, 0.25, 4);
  if (lin === 1) return v;
  const a = Math.abs(v);
  const r = Math.pow(a, lin);
  return v < 0 ? -r : r;
}

/** Trigger / pedal dead zone with rescale to 0..1. */
export function pedal(v: number, dz: number): number {
  const d = clamp(dz, 0, 0.9);
  if (v <= d) return 0;
  const r = (v - d) / (1 - d);
  return r > 1 ? 1 : r;
}

/** Move `cur` toward `target` by at most `rate * dt`, never overshooting. */
export function stepToward(cur: number, target: number, rate: number, dt: number): number {
  const d = target - cur;
  const m = rate * dt;
  if (d > m) return cur + m;
  if (d < -m) return cur - m;
  return target;
}

/**
 * Decode a POV hat that a non-standard pad exposes as one axis (Chrome on Windows reports the eight
 * directions as -1, -0.714, ... 1 clockwise from "up", and ~1.286 when centered).
 * Writes booleans into `out`.
 */
export function decodeHat(v: number, out: { up: boolean; down: boolean; left: boolean; right: boolean }): void {
  out.up = out.down = out.left = out.right = false;
  if (!(v >= -1.05 && v <= 1.05)) return; // neutral (or NaN)
  const i = Math.round((v + 1) * 3.5); // 0 up, 1 up-right, 2 right, 3 down-right, 4 down, 5 down-left, 6 left, 7 up-left
  switch (i) {
    case 0: out.up = true; break;
    case 1: out.up = true; out.right = true; break;
    case 2: out.right = true; break;
    case 3: out.down = true; out.right = true; break;
    case 4: out.down = true; break;
    case 5: out.down = true; out.left = true; break;
    case 6: out.left = true; break;
    case 7: out.up = true; out.left = true; break;
  }
}

export const NAV_REPEAT_DELAY = 0.3;
export const NAV_REPEAT_RATE = 0.09;

/**
 * Turns a "held" boolean into menu navigation edges: one edge on press, then — after `delay` seconds —
 * one edge every `rate` seconds while still held. At most one edge per update, so a long frame never
 * produces a burst.
 */
export class RepeatEdge {
  private held = false;
  private time = 0;
  private next = 0;

  constructor(
    private readonly delay = NAV_REPEAT_DELAY,
    private readonly rate = NAV_REPEAT_RATE,
  ) {}

  update(down: boolean, dt: number): boolean {
    if (!down) {
      this.held = false;
      this.time = 0;
      return false;
    }
    if (!this.held) {
      this.held = true;
      this.time = 0;
      this.next = this.delay;
      return true;
    }
    this.time += dt;
    if (this.time >= this.next) {
      this.next += this.rate;
      if (this.time >= this.next) this.next = this.time + this.rate; // long frame: don't queue a backlog
      return true;
    }
    return false;
  }

  reset(): void {
    this.held = false;
    this.time = 0;
    this.next = 0;
  }
}

/**
 * Stick -> direction with hysteresis so a stick resting near the threshold does not chatter.
 * Returns -1, 0 or 1 for one axis, given its previous state.
 */
export function hysteresis(v: number, prev: number, engage = 0.55, release = 0.35): number {
  if (prev === 0) return v > engage ? 1 : v < -engage ? -1 : 0;
  if (prev > 0) return v > release ? 1 : v < -engage ? -1 : 0;
  return v < -release ? -1 : v > engage ? 1 : 0;
}

/** Friendly name from a browser gamepad id ("Logitech Gamepad F310 (STANDARD GAMEPAD Vendor: 046d Product: c21d)"). */
export function prettyPadName(id: string | null | undefined): string | null {
  if (!id) return null;
  let s = id.replace(/\(.*?(vendor|product|standard gamepad).*?\)/gi, '');
  s = s.replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, ''); // Firefox "046d-c21d-Logitech Gamepad F310"
  s = s.replace(/\s+/g, ' ').trim();
  return s || id;
}
