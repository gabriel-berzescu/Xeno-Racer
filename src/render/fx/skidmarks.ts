/**
 * Skidmarks (owner: render).
 *
 * One ring-buffer mesh of ribbon quads shared by every wheel of every car: dark rubber on hard
 * surfaces, faint flattened/dug tracks on grass, gravel, sand and dirt. Each trail keeps the last
 * pair of edge vertices so consecutive segments join without gaps; alpha follows skid intensity and
 * ramps in at the start of a trail, so marks fade in and out like real ones. No per-frame
 * allocation, partial GPU uploads, persists for the session (oldest segments are recycled).
 */
import {
  AddEquation,
  BufferAttribute,
  CustomBlending,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  MeshBasicMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  SrcAlphaFactor,
  ZeroFactor,
} from 'three';

export interface SkidTrail {
  active: boolean;
  hasEdges: boolean;
  cx: number; cy: number; cz: number;
  nx: number; ny: number; nz: number;
  lx: number; ly: number; lz: number;
  rx: number; ry: number; rz: number;
  alpha: number;
}

export function makeTrail(): SkidTrail {
  return { active: false, hasEdges: false, cx: 0, cy: 0, cz: 0, nx: 0, ny: 1, nz: 0, lx: 0, ly: 0, lz: 0, rx: 0, ry: 0, rz: 0, alpha: 0 };
}

const MIN_STEP = 0.2;
const MAX_STEP = 4.5;
const LIFT = 0.018;

export class SkidMarks {
  readonly mesh: Mesh;
  readonly max: number;
  private readonly geometry: BufferGeometry;
  private readonly pos: BufferAttribute;
  private readonly col: BufferAttribute;
  private head = 0;
  private count = 0;
  private frameStart = 0;

  constructor(maxSegments: number) {
    this.max = maxSegments;
    const g = new BufferGeometry();
    this.pos = new BufferAttribute(new Float32Array(maxSegments * 12), 3);
    this.col = new BufferAttribute(new Float32Array(maxSegments * 16), 4);
    this.pos.setUsage(DynamicDrawUsage);
    this.col.setUsage(DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('color', this.col);
    const idx = new Uint32Array(maxSegments * 6);
    for (let s = 0; s < maxSegments; s++) {
      const v = s * 4, o = s * 6;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
      idx[o + 3] = v + 2; idx[o + 4] = v + 1; idx[o + 5] = v + 3;
    }
    g.setIndex(new BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.geometry = g;
    const mat = new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      // normal alpha blending for the colour; the destination alpha (the wet-road reflection flag) is left alone
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: SrcAlphaFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendSrcAlpha: ZeroFactor,
      blendDstAlpha: OneFactor,
      depthWrite: false,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.mesh = new Mesh(g, mat);
    this.mesh.name = 'xr.fx.skidmarks';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -5;
  }

  beginFrame(): void {
    this.frameStart = this.head;
  }

  /**
   * Extend a trail to a new contact point.
   * (nx,ny,nz) surface normal; width in metres; (r,g,b) mark colour; alpha 0..1.
   */
  addPoint(t: SkidTrail, px: number, py: number, pz: number, nx: number, ny: number, nz: number, width: number, r: number, g: number, b: number, alpha: number): void {
    if (!t.active) {
      t.active = true;
      t.hasEdges = false;
      t.cx = px; t.cy = py; t.cz = pz;
      t.nx = nx; t.ny = ny; t.nz = nz;
      t.alpha = 0;
      return;
    }
    const dx = px - t.cx, dy = py - t.cy, dz = pz - t.cz;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < MIN_STEP) return;
    if (len > MAX_STEP) {
      t.hasEdges = false;
      t.cx = px; t.cy = py; t.cz = pz;
      t.nx = nx; t.ny = ny; t.nz = nz;
      t.alpha = 0;
      return;
    }
    const tx = dx / len, ty = dy / len, tz = dz / len;
    // lateral (left) = n x t
    let lx = ny * tz - nz * ty, ly = nz * tx - nx * tz, lz = nx * ty - ny * tx;
    const ll = Math.sqrt(lx * lx + ly * ly + lz * lz);
    if (ll < 1e-5) return;
    lx /= ll; ly /= ll; lz /= ll;
    const hw = width * 0.5;

    const eLx = px + lx * hw + nx * LIFT, eLy = py + ly * hw + ny * LIFT, eLz = pz + lz * hw + nz * LIFT;
    const eRx = px - lx * hw + nx * LIFT, eRy = py - ly * hw + ny * LIFT, eRz = pz - lz * hw + nz * LIFT;
    let sLx: number, sLy: number, sLz: number, sRx: number, sRy: number, sRz: number;
    if (t.hasEdges) {
      sLx = t.lx; sLy = t.ly; sLz = t.lz; sRx = t.rx; sRy = t.ry; sRz = t.rz;
    } else {
      sLx = t.cx + lx * hw + t.nx * LIFT; sLy = t.cy + ly * hw + t.ny * LIFT; sLz = t.cz + lz * hw + t.nz * LIFT;
      sRx = t.cx - lx * hw + t.nx * LIFT; sRy = t.cy - ly * hw + t.ny * LIFT; sRz = t.cz - lz * hw + t.nz * LIFT;
    }

    const P = this.pos.array as Float32Array;
    const C = this.col.array as Float32Array;
    const seg = this.head;
    const o = seg * 12;
    P[o] = sLx; P[o + 1] = sLy; P[o + 2] = sLz;
    P[o + 3] = sRx; P[o + 4] = sRy; P[o + 5] = sRz;
    P[o + 6] = eLx; P[o + 7] = eLy; P[o + 8] = eLz;
    P[o + 9] = eRx; P[o + 10] = eRy; P[o + 11] = eRz;
    const c = seg * 16;
    const a0 = t.alpha;
    C[c] = r; C[c + 1] = g; C[c + 2] = b; C[c + 3] = a0;
    C[c + 4] = r; C[c + 5] = g; C[c + 6] = b; C[c + 7] = a0;
    C[c + 8] = r; C[c + 9] = g; C[c + 10] = b; C[c + 11] = alpha;
    C[c + 12] = r; C[c + 13] = g; C[c + 14] = b; C[c + 15] = alpha;
    this.head = (seg + 1) % this.max;
    if (this.count < this.max) this.count++;

    t.hasEdges = true;
    t.lx = eLx; t.ly = eLy; t.lz = eLz;
    t.rx = eRx; t.ry = eRy; t.rz = eRz;
    t.cx = px; t.cy = py; t.cz = pz;
    t.nx = nx; t.ny = ny; t.nz = nz;
    t.alpha = alpha;
  }

  endTrail(t: SkidTrail): void {
    t.active = false;
    t.hasEdges = false;
    t.alpha = 0;
  }

  endFrame(): void {
    const written = this.head >= this.frameStart ? this.head - this.frameStart : this.head + this.max - this.frameStart;
    this.pos.clearUpdateRanges();
    this.col.clearUpdateRanges();
    if (written > 0) {
      if (this.head >= this.frameStart) {
        this.pos.addUpdateRange(this.frameStart * 12, written * 12);
        this.col.addUpdateRange(this.frameStart * 16, written * 16);
      } else {
        this.pos.addUpdateRange(this.frameStart * 12, (this.max - this.frameStart) * 12);
        this.col.addUpdateRange(this.frameStart * 16, (this.max - this.frameStart) * 16);
        if (this.head > 0) {
          this.pos.addUpdateRange(0, this.head * 12);
          this.col.addUpdateRange(0, this.head * 16);
        }
      }
      this.pos.needsUpdate = true;
      this.col.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, this.count * 6);
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.frameStart = 0;
    this.geometry.setDrawRange(0, 0);
  }

  get segments(): number {
    return this.count;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
  }
}
