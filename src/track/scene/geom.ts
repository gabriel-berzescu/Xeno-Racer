/**
 * Geometry helpers for the scene builders: a growable vertex buffer and helpers that sample the runtime.
 */
import * as THREE from 'three';
import type { GroundSample } from '../../core/contracts';
import type { TrackRuntimeImpl } from '../runtime';

export class GeoBuf {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  trk: number[] = [];
  lin: number[] = [];
  srf: number[] = [];
  edg: number[] = [];
  idx: number[] = [];
  count = 0;
  useCol = false;
  useTrk = false;
  useSrf = false;
  useEdg = false;

  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    return this.count++;
  }
  color(r: number, g: number, b: number): void {
    this.useCol = true;
    this.col.push(r, g, b);
  }
  track(s: number, d: number, wl: number, wr: number, line: number): void {
    this.useTrk = true;
    this.trk.push(s, d, wl, wr);
    this.lin.push(line);
  }
  surface(k: number): void {
    this.useSrf = true;
    this.srf.push(k);
  }
  edge(u: number): void {
    this.useEdg = true;
    this.edg.push(u);
  }
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }
  get empty(): boolean {
    return this.idx.length === 0;
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.useCol) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.useTrk) {
      g.setAttribute('aTrack', new THREE.Float32BufferAttribute(this.trk, 4));
      g.setAttribute('aLine', new THREE.Float32BufferAttribute(this.lin, 1));
    }
    if (this.useSrf) g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.srf, 1));
    if (this.useEdg) g.setAttribute('aEdge', new THREE.Float32BufferAttribute(this.edg, 1));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const _v = new THREE.Vector3();
const _g: GroundSample = { height: 0, normal: new THREE.Vector3(), surface: 'asphalt' };

export interface SurfacePoint {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

/** Sample the track surface at (s, d): world position plus the analytic normal (same function the physics uses). */
export function samplePoint(rt: TrackRuntimeImpl, s: number, d: number, out: SurfacePoint): SurfacePoint {
  rt.pointAt(s, d, _v);
  const seg = Math.min(rt.count - 1, Math.floor(rt.wrapS(s) / rt.spacing));
  rt.groundAt(_v.x, _v.z, _g, seg);
  out.x = _v.x;
  out.y = _v.y;
  out.z = _v.z;
  out.nx = _g.normal.x;
  out.ny = _g.normal.y;
  out.nz = _g.normal.z;
  return out;
}

/** World XZ (no height) of (s, d). */
export function xzAt(rt: TrackRuntimeImpl, s: number, d: number, out: { x: number; z: number }): void {
  rt.pointAt(s, d, _v);
  out.x = _v.x;
  out.z = _v.z;
}

export function disposeObject(o: THREE.Object3D): void {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
  });
}
