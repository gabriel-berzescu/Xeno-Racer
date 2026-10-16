/**
 * A minimal TrackRuntime: an endless flat asphalt plane along +Z with distant walls. Used by the
 * physics tests and as a fallback proving ground. Optionally a ring of surface patches.
 */
import { Quaternion, Vector3 } from 'three';
import type { GridSlot, GroundSample, SurfaceType, TrackFrame, TrackPoint, TrackRuntime } from '../core/contracts';

export interface FlatTrackOptions {
  halfWidth?: number;
  wall?: number;
  length?: number;
  /** Surface of the whole plane (default asphalt). */
  surface?: SurfaceType;
  /** A winter circuit: studded winter tyres, cold air (TrackInfo.winter). */
  winter?: boolean;
  /** The walls are snowbanks (soft barriers). */
  softWalls?: boolean;
  /** Surface for x > 0 half-plane (default asphalt everywhere). */
  leftSurface?: SurfaceType;
  /** Slope along +Z (rise/run). */
  slope?: number;
  /** Lateral slope (rise per meter toward +X). */
  sideSlope?: number;
}

export function createFlatTrack(opts: FlatTrackOptions = {}): TrackRuntime {
  const halfWidth = opts.halfWidth ?? 200;
  const wall = opts.wall ?? 400;
  const length = opts.length ?? 100000;
  const slope = opts.slope ?? 0;
  const side = opts.sideSlope ?? 0;
  const normal = new Vector3(-side, 1, -slope).normalize();
  const spacing = 10;
  const count = 8;
  const arr = () => new Float32Array(count);
  const grid: GridSlot[] = [];
  for (let i = 0; i < 12; i++) {
    const s = -10 - Math.floor(i / 2) * 8;
    const d = i % 2 === 0 ? 3 : -3;
    grid.push({ position: new Vector3(d, d * side + s * slope, s), quaternion: new Quaternion(), s, d });
  }
  const height = (x: number, z: number) => z * slope + x * side;
  const rt: TrackRuntime = {
    info: { id: 'flat', name: 'Proving Ground', location: 'Test', description: 'Flat pad', difficulty: 1, defaultLaps: 1, defaultTimeOfDay: 'noon', lengthHint: length, color: '#888', ...(opts.winter ? { winter: true } : {}) },
    length,
    spacing,
    count,
    px: arr(), py: arr(), pz: arr(),
    tx: arr(), ty: arr(), tz: arr(),
    nx: arr(), ny: arr(), nz: arr(),
    lx: arr(), ly: arr(), lz: arr(),
    widthLeft: arr().fill(halfWidth), widthRight: arr().fill(halfWidth),
    wallLeft: arr().fill(wall), wallRight: arr().fill(wall),
    curvature: arr(), bank: arr(),
    sectors: [length / 3, (2 * length) / 3],
    grid,
    bounds: { minX: -wall, maxX: wall, minZ: -1000, maxZ: length, minY: -100, maxY: 100 },
    groundAt(x: number, z: number, out: GroundSample): number {
      out.height = height(x, z);
      out.normal.copy(normal);
      out.surface = opts.leftSurface && x > 0 ? opts.leftSurface : (opts.surface ?? 'asphalt');
      return 0;
    },
    project(x: number, z: number, out: TrackPoint): number {
      out.s = z;
      out.d = x;
      out.segment = 0;
      out.widthLeft = halfWidth;
      out.widthRight = halfWidth;
      out.wallLeft = wall;
      out.wallRight = wall;
      out.softLeft = opts.softWalls ? 1 : 0;
      out.softRight = opts.softWalls ? 1 : 0;
      out.tx = 0;
      out.tz = 1;
      out.lx = 1;
      out.lz = 0;
      out.y = height(0, z);
      return 0;
    },
    pointAt(s: number, d: number, out: Vector3): Vector3 {
      return out.set(d, height(d, s), s);
    },
    frameAt(s: number, out: TrackFrame): TrackFrame {
      out.position.set(0, height(0, s), s);
      out.tangent.set(0, slope, 1).normalize();
      out.normal.copy(normal);
      out.left.crossVectors(out.normal, out.tangent).normalize();
      out.widthLeft = out.widthRight = halfWidth;
      out.wallLeft = out.wallRight = wall;
      out.curvature = 0;
      out.bank = 0;
      return out;
    },
    wrapS(s: number): number {
      return s;
    },
  };
  return rt;
}
