/**
 * A minimal TrackRuntime for the sandbox (owner: render): a circular road (radius 140 m, 18 m wide,
 * counter-clockwise, left = outside) plus a flat asphalt pad in the middle, grass elsewhere.
 * Implements only what the render module queries (groundAt, project, frameAt, pointAt, wrapS) and
 * fills the typed arrays so it satisfies the full interface.
 */
import { Quaternion, Vector3 } from 'three';
import type { GroundSample, SurfaceType, TrackFrame, TrackPoint, TrackRuntime } from '../../src/core/contracts';
import { PAD_SIZE, RING_RADIUS, ROAD_HALF_WIDTH } from './world';

export function makeRingTrack(): TrackRuntime {
  const R = RING_RADIUS;
  const length = 2 * Math.PI * R;
  const spacing = 5;
  const count = Math.round(length / spacing);
  const f = () => new Float32Array(count + 1);
  const px = f(), py = f(), pz = f(), tx = f(), ty = f(), tz = f(), nx = f(), ny = f(), nz = f(), lx = f(), ly = f(), lz = f();
  const wl = f(), wr = f(), wal = f(), war = f(), curv = f(), bank = f();
  for (let i = 0; i <= count; i++) {
    const a = ((i % count) / count) * Math.PI * 2;
    px[i] = Math.cos(a) * R; pz[i] = Math.sin(a) * R;
    tx[i] = -Math.sin(a); tz[i] = Math.cos(a);
    ny[i] = 1;
    lx[i] = Math.cos(a); lz[i] = Math.sin(a);
    wl[i] = wr[i] = ROAD_HALF_WIDTH;
    wal[i] = war[i] = ROAD_HALF_WIDTH + 3;
    curv[i] = -1 / R; // turning toward the centre = right turn
  }
  const grid = Array.from({ length: 12 }, (_, i) => ({
    position: new Vector3(Math.cos(0) * R - (i % 2 ? 3 : -3), 0, -i * 8),
    quaternion: new Quaternion(),
    s: length - i * 8,
    d: i % 2 ? -3 : 3,
  }));

  const rt: TrackRuntime = {
    info: { id: 'sandbox-ring', name: 'Sandbox Ring', location: 'Nowhere', description: '', difficulty: 1, defaultLaps: 3, defaultTimeOfDay: 'golden', lengthHint: length, color: '#16e0bd' },
    length,
    spacing,
    count,
    px, py, pz, tx, ty, tz, nx, ny, nz, lx, ly, lz,
    widthLeft: wl, widthRight: wr, wallLeft: wal, wallRight: war,
    curvature: curv,
    bank,
    sectors: [length / 3, (2 * length) / 3],
    grid,
    bounds: { minX: -R - 20, maxX: R + 20, minZ: -R - 20, maxZ: R + 20, minY: 0, maxY: 0 },

    groundAt(x: number, z: number, out: GroundSample, hint = 0): number {
      out.height = 0;
      out.normal.set(0, 1, 0);
      const r = Math.hypot(x, z);
      let surface: SurfaceType = 'grass';
      if (Math.abs(r - R) < ROAD_HALF_WIDTH) surface = 'asphalt';
      else if (Math.abs(x) < PAD_SIZE / 2 && Math.abs(z) < PAD_SIZE / 2) surface = 'asphalt';
      out.surface = surface;
      return hint;
    },

    project(x: number, z: number, out: TrackPoint, hint = 0): number {
      const a = Math.atan2(z, x);
      const aa = a < 0 ? a + Math.PI * 2 : a;
      const r = Math.hypot(x, z);
      out.s = aa * R;
      out.d = r - R;
      const seg = Math.floor((out.s / length) * count) % count;
      out.segment = seg;
      out.widthLeft = out.widthRight = ROAD_HALF_WIDTH;
      out.wallLeft = out.wallRight = ROAD_HALF_WIDTH + 3;
      out.tx = -Math.sin(aa); out.tz = Math.cos(aa);
      out.lx = out.tz; out.lz = -out.tx;
      out.y = 0;
      void hint;
      return seg;
    },

    pointAt(s: number, d: number, out: Vector3): Vector3 {
      const a = (rt.wrapS(s) / length) * Math.PI * 2;
      const r = R + d;
      return out.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    },

    frameAt(s: number, out: TrackFrame): TrackFrame {
      const a = (rt.wrapS(s) / length) * Math.PI * 2;
      out.position.set(Math.cos(a) * R, 0, Math.sin(a) * R);
      out.tangent.set(-Math.sin(a), 0, Math.cos(a));
      out.normal.set(0, 1, 0);
      out.left.set(Math.cos(a), 0, Math.sin(a));
      out.widthLeft = out.widthRight = ROAD_HALF_WIDTH;
      out.wallLeft = out.wallRight = ROAD_HALF_WIDTH + 3;
      out.curvature = -1 / R;
      out.bank = 0;
      return out;
    },

    wrapS(s: number): number {
      const m = s % length;
      return m < 0 ? m + length : m;
    },
  };
  return rt;
}
