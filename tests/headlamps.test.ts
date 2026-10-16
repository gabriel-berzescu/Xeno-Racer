import { describe, expect, it } from 'vitest';
import { collectHeadlamps, HEADLAMPS, makeMirrorLamps } from '../src/game/headlamps';
import type { SpotterBody } from '../src/game/spotter';

/** A car on the ground at (x, z) heading `yaw` radians from +Z toward +X (a rotation about +Y). */
function car(x: number, z: number, yaw = 0, halfLength = 2.3, halfWidth = 0.95): SpotterBody {
  return {
    position: { x, y: 0.5, z },
    quaternion: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
    velocity: { x: 0, y: 0, z: 0 },
    halfLength,
    halfWidth,
  };
}

const eye = { x: 0, z: 0 };

describe('headlamps for the mirrors', () => {
  it('lights both lamps of a car right behind the viewer, at its nose, a track apart', () => {
    const out = makeMirrorLamps();
    const n = collectHeadlamps(out, [car(0, 0), car(0, -20)], 0, eye, 1);
    expect(n).toBe(2);
    expect(out.n).toBe(2);
    const d = out.data;
    // the car is 20 m behind, heading +Z (toward the viewer): its nose is at z = -20 + 2.3 - inset
    const noseZ = -20 + 2.3 - HEADLAMPS.inset;
    expect(d[2]).toBeCloseTo(noseZ, 5);
    expect(d[6]).toBeCloseTo(noseZ, 5);
    // one lamp each side, +X is the car's left
    const half = 0.95 - HEADLAMPS.sideInset;
    expect(d[0]).toBeCloseTo(half, 5);
    expect(d[4]).toBeCloseTo(-half, 5);
    // at lamp height, full strength
    expect(d[1]).toBeCloseTo(0.5 + HEADLAMPS.up, 5);
    expect(d[3]).toBeCloseTo(1, 5);
    expect(d[7]).toBeCloseTo(1, 5);
  });

  it('puts a turned car\'s lamps at its own nose and flanks, not on the world axes', () => {
    const out = makeMirrorLamps();
    // 20 m away to the right and slightly behind, heading toward the viewer: yaw so that its heading points at (0, 0)
    const cx = 5;
    const cz = -19;
    const yaw = Math.atan2(-cx, -cz); // heading (sin yaw, cos yaw) = direction to the viewer
    collectHeadlamps(out, [car(0, 0), car(cx, cz, yaw)], 0, eye, 1);
    expect(out.n).toBe(2);
    const d = out.data;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const nose = 2.3 - HEADLAMPS.inset;
    const mx = (d[0] + d[4]) / 2;
    const mz = (d[2] + d[6]) / 2;
    expect(mx).toBeCloseTo(cx + fx * nose, 4);
    expect(mz).toBeCloseTo(cz + fz * nose, 4);
    // the two lamps are a track apart and across the heading
    const sx = d[0] - d[4];
    const sz = d[2] - d[6];
    expect(Math.hypot(sx, sz)).toBeCloseTo(2 * (0.95 - HEADLAMPS.sideInset), 4);
    expect(sx * fx + sz * fz).toBeCloseTo(0, 4);
  });

  it('gives no glare to a car that faces away or sits beside the viewer', () => {
    const out = makeMirrorLamps();
    // ahead and heading away
    expect(collectHeadlamps(out, [car(0, 0), car(0, 30)], 0, eye, 1)).toBe(0);
    // alongside, heading the same way: its lamps point down the road, not at the viewer
    expect(collectHeadlamps(out, [car(0, 0), car(3.5, 0)], 0, eye, 1)).toBe(0);
  });

  it('ramps up smoothly as a car comes round behind, with no step', () => {
    const out = makeMirrorLamps();
    let last = -1;
    for (let back = 0; back <= 12; back += 0.1) {
      // a car 3.5 m to the side that drops back from alongside, a hand's breadth at a time
      collectHeadlamps(out, [car(0, 0), car(3.5, -back)], 0, eye, 1);
      const k = out.n > 0 ? out.data[3] : 0;
      expect(k).toBeGreaterThanOrEqual(last - 1e-6);
      expect(k - Math.max(last, 0)).toBeLessThan(0.1);
      last = k;
    }
    expect(last).toBeGreaterThan(0.5);
  });

  it('leaves out a lamp that is broken and dims one that flickers', () => {
    const out = makeMirrorLamps();
    const field = [car(0, 0), car(0, -20)];
    // [head left, head right, tail left, tail right]
    const n = collectHeadlamps(out, field, 0, eye, 1, [undefined, new Float32Array([0, 1, 1, 1])]);
    expect(n).toBe(1);
    // the one that is left is the right-hand lamp (-X): the car's left lamp is out
    expect(out.data[0]).toBeLessThan(0);
    expect(out.data[3]).toBeCloseTo(1, 5);
    collectHeadlamps(out, field, 0, eye, 1, [undefined, new Float32Array([0.5, 0.25, 1, 1])]);
    expect(out.n).toBe(2);
    expect(out.data[3]).toBeCloseTo(0.5, 5);
    expect(out.data[7]).toBeCloseTo(0.25, 5);
  });

  it('is dark by day and follows how far the lamps are lit', () => {
    const out = makeMirrorLamps();
    expect(collectHeadlamps(out, [car(0, 0), car(0, -20)], 0, eye, 0)).toBe(0);
    collectHeadlamps(out, [car(0, 0), car(0, -20)], 0, eye, 0.5);
    expect(out.data[3]).toBeCloseTo(0.5, 5);
  });

  it('fades out with distance', () => {
    const out = makeMirrorLamps();
    collectHeadlamps(out, [car(0, 0), car(0, -HEADLAMPS.fadeFrom + 10)], 0, eye, 1);
    expect(out.data[3]).toBeCloseTo(1, 5);
    collectHeadlamps(out, [car(0, 0), car(0, -(HEADLAMPS.fadeFrom + HEADLAMPS.fadeTo) / 2)], 0, eye, 1);
    expect(out.data[3]).toBeGreaterThan(0.2);
    expect(out.data[3]).toBeLessThan(0.8);
    expect(collectHeadlamps(out, [car(0, 0), car(0, -HEADLAMPS.fadeTo - 5)], 0, eye, 1)).toBe(0);
  });

  it('skips the player and never writes past the list', () => {
    const out = makeMirrorLamps();
    const field = [car(0, 0)];
    for (let i = 0; i < 30; i++) field.push(car((i % 3) - 1, -10 - i));
    const n = collectHeadlamps(out, field, 0, eye, 1);
    expect(n).toBe(HEADLAMPS.max);
    expect(out.data.length).toBe(HEADLAMPS.max * 4);
    // the skipped car (index 0, the viewer's own) is not among the lamps: all are behind it
    for (let i = 0; i < n; i++) expect(out.data[i * 4 + 2]).toBeLessThan(0);
  });
});
