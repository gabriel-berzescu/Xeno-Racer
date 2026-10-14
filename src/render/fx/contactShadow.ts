/**
 * Contact shadows (owner: render): a soft dark blob under each car plus a tight one at every tyre
 * contact patch. Real cascaded shadows are crisp but cannot ground a car on their own (and are off
 * at the lowest settings); this fake ambient occlusion is what makes the tyres "sit" on the asphalt.
 * One instanced draw for all cars.
 */
import {
  DataTexture,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  PlaneGeometry,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
} from 'three';

const BLOBS_PER_CAR = 5; // body + 4 tyres

function makeBlobTexture(size = 128): DataTexture {
  const d = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) / size * 2 - 1;
      const y = (j + 0.5) / size * 2 - 1;
      // rounded box distance
      const bx = Math.abs(x) - 0.55, by = Math.abs(y) - 0.55;
      const out = Math.hypot(Math.max(bx, 0), Math.max(by, 0)) + Math.min(Math.max(bx, by), 0) - 0.18;
      let a = 1 - Math.min(1, Math.max(0, (out + 0.1) / 0.55));
      a = a * a * (3 - 2 * a);
      const o = (j * size + i) * 4;
      d[o] = d[o + 1] = d[o + 2] = 0;
      d[o + 3] = Math.round(a * 255);
    }
  }
  const t = new DataTexture(d, size, size, RGBAFormat, UnsignedByteType);
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

export class ContactShadows {
  readonly mesh: InstancedMesh;
  private readonly capacity: number;
  private readonly opacity: InstancedBufferAttribute;
  private readonly tex: DataTexture;
  private readonly m = new Matrix4();
  private nextSlot = 0;
  private readonly slots = new Map<number, number>();

  constructor(maxCars: number) {
    this.capacity = maxCars;
    this.tex = makeBlobTexture();
    const geo = new PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.opacity = new InstancedBufferAttribute(new Float32Array(maxCars * BLOBS_PER_CAR), 1);
    geo.setAttribute('aOpacity', this.opacity);
    const mat = new ShaderMaterial({
      uniforms: { uMap: { value: this.tex } },
      vertexShader: /* glsl */ `
        attribute float aOpacity;
        varying vec2 vUv;
        varying float vOp;
        void main() {
          vUv = uv;
          vOp = aOpacity;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        varying vec2 vUv;
        varying float vOp;
        void main() {
          float a = texture2D(uMap, vUv).a * vOp;
          if (a < 0.004) discard;
          gl_FragColor = vec4(0.0, 0.0, 0.0, a);
        }`,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      toneMapped: false,
      fog: false,
    });
    this.mesh = new InstancedMesh(geo, mat, maxCars * BLOBS_PER_CAR);
    this.mesh.name = 'xr.fx.contactShadows';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -6;
    this.mesh.count = 0;
    // park everything off-screen
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < maxCars * BLOBS_PER_CAR; i++) this.mesh.setMatrixAt(i, this.m);
  }

  slotFor(id: number): number {
    let s = this.slots.get(id);
    if (s === undefined) {
      s = this.nextSlot++ % this.capacity;
      this.slots.set(id, s);
      this.mesh.count = Math.max(this.mesh.count, (s + 1) * BLOBS_PER_CAR);
    }
    return s;
  }

  release(id: number): void {
    const s = this.slots.get(id);
    if (s === undefined) return;
    this.hide(s);
    this.slots.delete(id);
  }

  private hide(slot: number): void {
    const o = this.opacity.array as Float32Array;
    this.m.makeScale(0, 0, 0);
    for (let k = 0; k < BLOBS_PER_CAR; k++) {
      o[slot * BLOBS_PER_CAR + k] = 0;
      this.mesh.setMatrixAt(slot * BLOBS_PER_CAR + k, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.opacity.needsUpdate = true;
  }

  /**
   * Write the blobs of one car. Basis: left (lx..), up (ux..), forward (fx..) of the ground plane.
   * `cx,cy,cz` is the body centre on the plane.
   */
  set(
    slot: number,
    cx: number, cy: number, cz: number,
    lx: number, ly: number, lz: number,
    ux: number, uy: number, uz: number,
    fx: number, fy: number, fz: number,
    bodyWidth: number, bodyLength: number, bodyOpacity: number,
    wheelX: Float32Array, wheelY: Float32Array, wheelZ: Float32Array,
    wheelW: Float32Array, wheelD: Float32Array, wheelOpacity: Float32Array,
  ): void {
    const op = this.opacity.array as Float32Array;
    const base = slot * BLOBS_PER_CAR;
    const e = this.m.elements;
    // body blob
    this.setBlob(base, cx, cy, cz, lx, ly, lz, ux, uy, uz, fx, fy, fz, bodyWidth, bodyLength);
    op[base] = bodyOpacity;
    for (let w = 0; w < 4; w++) {
      this.setBlob(base + 1 + w, wheelX[w], wheelY[w], wheelZ[w], lx, ly, lz, ux, uy, uz, fx, fy, fz, wheelW[w], wheelD[w]);
      op[base + 1 + w] = wheelOpacity[w];
    }
    void e;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.opacity.needsUpdate = true;
  }

  private setBlob(i: number, x: number, y: number, z: number, lx: number, ly: number, lz: number, ux: number, uy: number, uz: number, fx: number, fy: number, fz: number, w: number, l: number): void {
    const e = this.m.elements;
    // columns: left * w, up, forward * l, translation
    e[0] = lx * w; e[1] = ly * w; e[2] = lz * w; e[3] = 0;
    e[4] = ux; e[5] = uy; e[6] = uz; e[7] = 0;
    e[8] = fx * l; e[9] = fy * l; e[10] = fz * l; e[11] = 0;
    e[12] = x; e[13] = y; e[14] = z; e[15] = 1;
    this.mesh.setMatrixAt(i, this.m);
  }

  clear(): void {
    for (const s of this.slots.values()) this.hide(s);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as ShaderMaterial).dispose();
    this.tex.dispose();
  }
}
