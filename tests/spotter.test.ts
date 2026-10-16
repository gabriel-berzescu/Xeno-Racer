import { describe, expect, it } from 'vitest';
import { makeSpotter, resetSpotter, SPOTTER, threat, updateSpotter, type SpotterBody, type SpotterHit } from '../src/game/spotter';

const HL = 2.3;
const HW = 0.95;

/** A body at (x, z) heading `yaw` rad about +Y (0 = +Z, positive turns toward +X), moving `speed` m/s along its heading. */
function body(x: number, z: number, yaw = 0, speed = 40, hl = HL, hw = HW): SpotterBody {
  return {
    position: { x, y: 0, z },
    quaternion: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
    velocity: { x: Math.sin(yaw) * speed, y: 0, z: Math.cos(yaw) * speed },
    halfLength: hl,
    halfWidth: hw,
  };
}

/** Left of a car heading +Z is +X. Run the smoothing to its end state. */
function settle(me: SpotterBody, others: SpotterBody[], frames = 120) {
  const s = makeSpotter();
  for (let i = 0; i < frames; i++) updateSpotter(s, me, others, 1 / 60);
  return s;
}

const hit = (me: SpotterBody, o: SpotterBody): SpotterHit => threat(me, o, { level: 0, side: 0, dz: 0 });

describe('spotter threat', () => {
  const me = body(0, 0);

  it('lights the side a car is alongside on, at full strength when wheel to wheel', () => {
    const left = hit(me, body(2.6, 0)); // 0.7 m between the bodies
    expect(left.side).toBe(1);
    expect(left.level).toBeGreaterThan(0.9);
    const right = hit(me, body(-2.6, 0.5));
    expect(right.side).toBe(-1);
    expect(right.level).toBeGreaterThan(0.9);
  });

  it('is blind to far cars, cars a lane away and cars far ahead or behind', () => {
    expect(hit(me, body(2.6, 40)).level).toBe(0);
    expect(hit(me, body(2.6, -40)).level).toBe(0);
    expect(hit(me, body(2.6, 15)).level).toBe(0); // ahead, past the window
    expect(hit(me, body(7, 0)).level).toBe(0); // 5 m gap
    expect(hit(me, body(2.6, -12)).level).toBe(0);
  });

  it('falls off smoothly with the lateral gap', () => {
    let prev = 2;
    for (let x = 2; x <= 7; x += 0.25) {
      const l = hit(me, body(x, 0)).level;
      expect(l).toBeLessThanOrEqual(prev + 1e-12);
      prev = l;
    }
    expect(hit(me, body(2.4, 0)).level).toBeGreaterThan(hit(me, body(4.2, 0)).level);
    expect(hit(me, body(6.4, 0)).level).toBeLessThan(0.03);
  });

  it('falls off smoothly as the car drops behind, and sooner ahead', () => {
    let prev = 2;
    for (let z = -3; z >= -14; z -= 0.5) {
      const l = hit(me, body(2.6, z)).level;
      expect(l).toBeLessThanOrEqual(prev + 1e-12);
      prev = l;
    }
    // a car whose nose is level with your tail is still beside you; half a car length further back it has faded to
    // about half, and a whole car length back it is gone
    expect(hit(me, body(2.6, -4.5)).level).toBeGreaterThan(0.9);
    const half = hit(me, body(2.6, -6.9)).level;
    expect(half).toBeGreaterThan(0.35);
    expect(half).toBeLessThan(0.65);
    expect(hit(me, body(2.6, -9.5)).level).toBe(0);
    // ahead the window is much shorter than behind
    expect(hit(me, body(2.6, 7)).level).toBeLessThan(hit(me, body(2.6, -7)).level);
  });

  it('sees a closing car earlier than one that keeps pace', () => {
    const closing = body(2.6, -11, 0, 60);
    const pacing = body(2.6, -11, 0, 40);
    expect(hit(me, closing).level).toBeGreaterThan(hit(me, pacing).level);
    expect(hit(me, closing).level).toBeGreaterThan(0.05);
  });

  it('ignores a car right behind or ahead in the same lane', () => {
    expect(hit(me, body(0, -7)).level).toBe(0);
    expect(hit(me, body(0.3, -6)).level).toBe(0);
    expect(hit(me, body(0, 7)).level).toBe(0);
    // but one that has pulled out to pass counts, on the side it pulled out to
    const pulling = hit(me, body(1.9, -6));
    expect(pulling.level).toBeGreaterThan(0.1);
    expect(pulling.side).toBe(1);
  });

  it('counts overlapping bodies as touching, on the side the centre is', () => {
    const t = hit(me, body(-1.2, 1));
    expect(t.level).toBe(1);
    expect(t.side).toBe(-1);
  });

  it('measures a car turned broadside by its length, not its width', () => {
    // the same centre, 5.2 m to the left: 3.3 m clear of a normal car's side, only 1.95 m clear of one lying across the road
    const upright = hit(me, body(5.2, 0));
    const spun = hit(me, body(5.2, 0, Math.PI / 2));
    expect(spun.side).toBe(1);
    expect(upright.level).toBeLessThan(0.25);
    expect(spun.level).toBeGreaterThan(upright.level + 0.3);
  });

  it('does not depend on which way the player faces', () => {
    for (const yaw of [0.4, 1.9, -2.5, Math.PI]) {
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      const m = body(10, -20, yaw);
      // the offset (2.6 left, 1.5 behind) in the player's frame, rotated into the world: left = (cos, -sin), forward = (sin, cos)
      const o = body(10 + 2.6 * c - 1.5 * s, -20 - 2.6 * s - 1.5 * c, yaw);
      const t = hit(m, o);
      expect(t.side).toBe(1);
      expect(t.level).toBeGreaterThan(0.9);
      const o2 = body(10 - 2.6 * c - 1.5 * s, -20 + 2.6 * s - 1.5 * c, yaw);
      expect(hit(m, o2).side).toBe(-1);
    }
  });
});

describe('spotter smoothing', () => {
  const me = body(0, 0);

  it('settles to the strongest car on each side and to nothing when the road is clear', () => {
    const s = settle(me, [body(2.6, 0), body(-3.4, -3), body(-6, 0)]);
    expect(s.left.level).toBeGreaterThan(0.9);
    expect(s.right.level).toBeGreaterThan(0.5);
    expect(s.right.level).toBeLessThan(s.left.level);
    const none = settle(me, [body(2.6, 30), body(-9, 0)]);
    expect(none.left.level).toBe(0);
    expect(none.right.level).toBe(0);
  });

  it('lights up fast and fades slowly', () => {
    const s = makeSpotter();
    const o = body(2.6, 0);
    updateSpotter(s, me, [o], 1 / 60);
    updateSpotter(s, me, [o], 1 / 60);
    updateSpotter(s, me, [o], 1 / 60);
    expect(s.left.level).toBeGreaterThan(0.5); // 50 ms after it appeared
    for (let i = 0; i < 120; i++) updateSpotter(s, me, [o], 1 / 60);
    const lit = s.left.level;
    for (let i = 0; i < 12; i++) updateSpotter(s, me, [], 1 / 60); // 0.2 s later
    expect(s.left.level).toBeGreaterThan(lit * 0.4);
    for (let i = 0; i < 180; i++) updateSpotter(s, me, [], 1 / 60);
    expect(s.left.level).toBe(0);
  });

  it('does not flicker when a car hovers around the edge of the window', () => {
    const s = makeSpotter();
    // gap between the bodies wobbles across the lateral cut-off, frame by frame
    const trace: number[] = [];
    for (let i = 0; i < 240; i++) {
      const x = 2.9 + (i % 2 === 0 ? 3.0 : 3.4);
      updateSpotter(s, me, [body(x, 0)], 1 / 60);
      if (i > 60) trace.push(s.left.level);
    }
    const lo = Math.min(...trace);
    const hi = Math.max(...trace);
    expect(hi - lo).toBeLessThan(0.02);
    // and across the longitudinal window
    const s2 = makeSpotter();
    const t2: number[] = [];
    for (let i = 0; i < 240; i++) {
      updateSpotter(s2, me, [body(2.6, i % 2 === 0 ? -9.4 : -10.2)], 1 / 60);
      if (i > 60) t2.push(s2.left.level);
    }
    expect(Math.max(...t2) - Math.min(...t2)).toBeLessThan(0.03);
  });

  it('never steps from one frame to the next as a car sweeps past', () => {
    const s = makeSpotter();
    let prev = 0;
    let worst = 0;
    // a car overtaking at 5 m/s relative speed, 60 fps
    for (let i = 0; i < 600; i++) {
      const z = -25 + (i / 60) * 5;
      updateSpotter(s, me, [body(2.7, z, 0, 45)], 1 / 60);
      worst = Math.max(worst, Math.abs(s.left.level - prev));
      prev = s.left.level;
    }
    expect(worst).toBeLessThan(0.08);
  });

  it('puts the glow where the car is along the player, front for a car ahead and back for one behind', () => {
    const behind = settle(me, [body(2.6, -5)]);
    const ahead = settle(me, [body(2.6, 3)]);
    const beside = settle(me, [body(2.6, 0)]);
    expect(behind.left.at).toBeLessThan(-0.5);
    expect(ahead.left.at).toBeGreaterThan(0.3);
    expect(Math.abs(beside.left.at)).toBeLessThan(0.05);
  });

  it('lights up where the car is, without sliding in from the old spot', () => {
    const s = settle(me, [body(2.6, -5)]);
    for (let i = 0; i < 200; i++) updateSpotter(s, me, [], 1 / 60);
    expect(s.left.level).toBe(0);
    updateSpotter(s, me, [body(2.6, 3)], 1 / 60);
    expect(s.left.at).toBeGreaterThan(0.3);
  });

  it('is silent at a standstill, off when disabled, and reset clears it', () => {
    const slow = body(0, 0, 0, 0);
    const s = settle(slow, [body(2.6, 0, 0, 0)]);
    expect(s.left.level).toBe(0);
    const on = settle(me, [body(2.6, 0)]);
    expect(on.left.level).toBeGreaterThan(0.9);
    for (let i = 0; i < 240; i++) updateSpotter(on, me, [body(2.6, 0)], 1 / 60, false);
    expect(on.left.level).toBe(0);
    const again = settle(me, [body(2.6, 0)]);
    resetSpotter(again);
    expect(again.left.level).toBe(0);
    expect(again.right.at).toBe(0);
  });

  it('skips the player itself when it is in the list', () => {
    const s = settle(me, [me, body(2.6, 0)]);
    expect(s.left.level).toBeGreaterThan(0.9);
    expect(s.right.level).toBe(0);
  });

  it('keeps the constants sane', () => {
    expect(SPOTTER.latFull).toBeLessThan(SPOTTER.latNone);
    expect(SPOTTER.speedMin).toBeLessThan(SPOTTER.speedFull);
    expect(SPOTTER.attack).toBeLessThan(SPOTTER.release);
  });
});
