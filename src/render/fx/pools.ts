/**
 * Particle pools (owner: render). Structure-of-arrays CPU simulation feeding instanced quads.
 * Nothing allocates after construction: spawning mutates a caller-owned spec object, the ring
 * buffers overwrite their oldest entry when full, and the instance buffers are re-filled in place.
 */
import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  type ShaderMaterial,
} from 'three';

// ───────────────────────────── deterministic RNG ─────────────────────────────

let rngState = 0x2545f491;
export function seedRandom(s: number): void {
  rngState = (s | 0) || 0x2545f491;
}
/** xorshift32, uniform in [0, 1). */
export function rnd(): number {
  let x = rngState;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  rngState = x;
  return (x >>> 0) / 4294967296;
}
export function rr(a: number, b: number): number {
  return a + (b - a) * rnd();
}
/** Roughly gaussian, mean 0, sigma ~0.45. */
export function rg(): number {
  return rnd() + rnd() + rnd() - 1.5;
}

function makeQuadGeometry(max: number, attrs: Record<string, number>): { geom: InstancedBufferGeometry; arrays: Record<string, InstancedBufferAttribute> } {
  const base = new PlaneGeometry(1, 1);
  const geom = new InstancedBufferGeometry();
  geom.index = base.index;
  geom.setAttribute('position', base.getAttribute('position'));
  geom.setAttribute('uv', base.getAttribute('uv'));
  const arrays: Record<string, InstancedBufferAttribute> = {};
  for (const [name, size] of Object.entries(attrs)) {
    const a = new InstancedBufferAttribute(new Float32Array(max * size), size);
    a.setUsage(DynamicDrawUsage);
    geom.setAttribute(name, a);
    arrays[name] = a;
  }
  geom.instanceCount = 0;
  return { geom, arrays };
}

function touch(a: InstancedBufferAttribute, count: number): void {
  a.clearUpdateRanges();
  if (count > 0) a.addUpdateRange(0, count * a.itemSize);
  a.needsUpdate = true;
}

// ───────────────────────────── soft puffs (smoke, dust) ─────────────────────────────

export interface PuffSpec {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  r0: number; r1: number;
  life: number;
  alpha: number;
  cr: number; cg: number; cb: number;
  rotVel: number;
  drag: number;
  buoy: number;
  /** 0..1: how strongly the wind carries it. */
  wind: number;
}

export function makePuffSpec(): PuffSpec {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r0: 0.3, r1: 1.5, life: 2, alpha: 0.4, cr: 0.8, cg: 0.8, cb: 0.8, rotVel: 0.3, drag: 1, buoy: 0.5, wind: 1 };
}

const SORT_BUCKETS = 128;

export class PuffPool {
  readonly mesh: Mesh;
  readonly max: number;
  private readonly geom: InstancedBufferGeometry;
  private readonly aA: InstancedBufferAttribute;
  private readonly aB: InstancedBufferAttribute;
  private readonly aC: InstancedBufferAttribute;
  private readonly alive: Uint8Array;
  private readonly px: Float32Array; private readonly py: Float32Array; private readonly pz: Float32Array;
  private readonly vx: Float32Array; private readonly vy: Float32Array; private readonly vz: Float32Array;
  private readonly age: Float32Array; private readonly life: Float32Array;
  private readonly r0: Float32Array; private readonly r1: Float32Array;
  private readonly rot: Float32Array; private readonly rotVel: Float32Array;
  private readonly alpha0: Float32Array;
  private readonly cr: Float32Array; private readonly cg: Float32Array; private readonly cb: Float32Array;
  private readonly tile: Float32Array; private readonly seed: Float32Array;
  private readonly drag: Float32Array; private readonly buoy: Float32Array; private readonly wind: Float32Array;
  private readonly keys: Float32Array;
  private readonly idx: Uint32Array;
  private readonly sorted: Uint32Array;
  private readonly bucket = new Uint32Array(SORT_BUCKETS + 1);
  private head = 0;
  liveCount = 0;
  private readonly doSort: boolean;

  constructor(max: number, material: ShaderMaterial, sort: boolean) {
    this.max = max;
    this.doSort = sort;
    const { geom, arrays } = makeQuadGeometry(max, { aA: 4, aB: 4, aC: 4 });
    this.geom = geom;
    this.aA = arrays.aA;
    this.aB = arrays.aB;
    this.aC = arrays.aC;
    this.mesh = new Mesh(geom, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'xr.fx.puffs';
    const f = () => new Float32Array(max);
    this.alive = new Uint8Array(max);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.age = f(); this.life = f();
    this.r0 = f(); this.r1 = f();
    this.rot = f(); this.rotVel = f();
    this.alpha0 = f();
    this.cr = f(); this.cg = f(); this.cb = f();
    this.tile = f(); this.seed = f();
    this.drag = f(); this.buoy = f(); this.wind = f();
    this.keys = f();
    this.idx = new Uint32Array(max);
    this.sorted = new Uint32Array(max);
  }

  spawn(s: PuffSpec): void {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    if (!this.alive[i]) this.liveCount++;
    this.alive[i] = 1;
    this.px[i] = s.x; this.py[i] = s.y; this.pz[i] = s.z;
    this.vx[i] = s.vx; this.vy[i] = s.vy; this.vz[i] = s.vz;
    this.age[i] = 0;
    this.life[i] = s.life;
    this.r0[i] = s.r0; this.r1[i] = s.r1;
    this.rot[i] = rnd() * 6.2831853;
    this.rotVel[i] = s.rotVel * (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd());
    this.alpha0[i] = s.alpha;
    this.cr[i] = s.cr; this.cg[i] = s.cg; this.cb[i] = s.cb;
    this.tile[i] = Math.floor(rnd() * 4);
    this.seed[i] = rnd();
    this.drag[i] = s.drag; this.buoy[i] = s.buoy; this.wind[i] = s.wind;
  }

  update(dt: number, windX: number, windZ: number): void {
    const max = this.max;
    for (let i = 0; i < max; i++) {
      if (!this.alive[i]) continue;
      const a = (this.age[i] += dt);
      const t = a / this.life[i];
      if (t >= 1) {
        this.alive[i] = 0;
        this.liveCount--;
        continue;
      }
      const dk = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= dk;
      this.vy[i] *= dk;
      this.vz[i] *= dk;
      this.vy[i] += this.buoy[i] * (1 - t) * dt;
      const wk = 1 - Math.exp(-0.55 * this.wind[i] * dt);
      this.vx[i] += (windX * this.wind[i] - this.vx[i]) * wk;
      this.vz[i] += (windZ * this.wind[i] - this.vz[i]) * wk;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.rot[i] += this.rotVel[i] * dt;
    }
  }

  /** Write the live particles into the instance buffers (far to near) and set the instance count. */
  fill(cx: number, cy: number, cz: number, fx: number, fy: number, fz: number): number {
    const max = this.max;
    let n = 0;
    let dmin = 1e30, dmax = -1e30;
    for (let i = 0; i < max; i++) {
      if (!this.alive[i]) continue;
      const d = (this.px[i] - cx) * fx + (this.py[i] - cy) * fy + (this.pz[i] - cz) * fz;
      this.keys[i] = d;
      this.idx[n++] = i;
      if (d < dmin) dmin = d;
      if (d > dmax) dmax = d;
    }
    let order = this.idx;
    if (this.doSort && n > 1 && dmax > dmin) {
      const b = this.bucket;
      b.fill(0);
      const k = (SORT_BUCKETS - 1) / (dmax - dmin);
      // far first: bucket index = (dmax - d)
      for (let j = 0; j < n; j++) b[1 + Math.floor((dmax - this.keys[this.idx[j]]) * k)]++;
      for (let j = 1; j <= SORT_BUCKETS; j++) b[j] += b[j - 1];
      for (let j = 0; j < n; j++) {
        const i = this.idx[j];
        const bi = Math.floor((dmax - this.keys[i]) * k);
        this.sorted[b[bi]++] = i;
      }
      order = this.sorted;
    }
    const A = this.aA.array as Float32Array;
    const B = this.aB.array as Float32Array;
    const C = this.aC.array as Float32Array;
    for (let j = 0; j < n; j++) {
      const i = order[j];
      const t = this.age[i] / this.life[i];
      const grow = 1 - Math.pow(1 - t, 2.2);
      const o = j * 4;
      A[o] = this.px[i]; A[o + 1] = this.py[i]; A[o + 2] = this.pz[i];
      A[o + 3] = this.r0[i] + (this.r1[i] - this.r0[i]) * grow;
      const fi = Math.min(1, t / 0.2);
      const fadeIn = fi * fi * (3 - 2 * fi);
      const u = Math.min(1, Math.max(0, (t - 0.5) / 0.5));
      const fadeOut = 1 - u * u * (3 - 2 * u);
      B[o] = this.rot[i];
      B[o + 1] = this.alpha0[i] * fadeIn * fadeOut;
      B[o + 2] = t;
      B[o + 3] = this.tile[i];
      C[o] = this.cr[i]; C[o + 1] = this.cg[i]; C[o + 2] = this.cb[i]; C[o + 3] = this.seed[i];
    }
    touch(this.aA, n);
    touch(this.aB, n);
    touch(this.aC, n);
    this.geom.instanceCount = n;
    return n;
  }

  clear(): void {
    this.alive.fill(0);
    this.liveCount = 0;
    this.geom.instanceCount = 0;
  }

  dispose(): void {
    this.geom.dispose();
  }
}

// ───────────────────────────── sparks ─────────────────────────────

export class SparkPool {
  readonly mesh: Mesh;
  readonly max: number;
  private readonly geom: InstancedBufferGeometry;
  private readonly aP: InstancedBufferAttribute;
  private readonly aV: InstancedBufferAttribute;
  private readonly aD: InstancedBufferAttribute;
  private readonly alive: Uint8Array;
  private readonly px: Float32Array; private readonly py: Float32Array; private readonly pz: Float32Array;
  private readonly vx: Float32Array; private readonly vy: Float32Array; private readonly vz: Float32Array;
  private readonly age: Float32Array; private readonly life: Float32Array;
  private readonly width: Float32Array; private readonly len: Float32Array;
  private readonly bright: Float32Array; private readonly gy: Float32Array; private readonly seed: Float32Array;
  private head = 0;
  liveCount = 0;

  constructor(max: number, material: ShaderMaterial) {
    this.max = max;
    const { geom, arrays } = makeQuadGeometry(max, { aP: 4, aV: 4, aD: 4 });
    this.geom = geom;
    this.aP = arrays.aP;
    this.aV = arrays.aV;
    this.aD = arrays.aD;
    this.mesh = new Mesh(geom, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.name = 'xr.fx.sparks';
    const f = () => new Float32Array(max);
    this.alive = new Uint8Array(max);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.age = f(); this.life = f();
    this.width = f(); this.len = f();
    this.bright = f(); this.gy = f(); this.seed = f();
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, width: number, bright: number, groundY: number): void {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    if (!this.alive[i]) this.liveCount++;
    this.alive[i] = 1;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.width[i] = width;
    const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
    this.len[i] = Math.min(0.55, Math.max(0.05, sp * 0.03));
    this.bright[i] = bright;
    this.gy[i] = groundY;
    this.seed[i] = rnd();
  }

  update(dt: number): void {
    const dk = Math.exp(-0.35 * dt);
    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i]) continue;
      const a = (this.age[i] += dt);
      if (a >= this.life[i]) {
        this.alive[i] = 0;
        this.liveCount--;
        continue;
      }
      this.vy[i] -= 9.81 * dt;
      this.vx[i] *= dk; this.vy[i] *= dk; this.vz[i] *= dk;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      const gy = this.gy[i] + 0.012;
      if (this.py[i] < gy && this.vy[i] < 0) {
        this.py[i] = gy;
        this.vy[i] = -this.vy[i] * 0.34;
        this.vx[i] *= 0.72;
        this.vz[i] *= 0.72;
        if (Math.abs(this.vy[i]) < 0.9) this.vy[i] = 0;
      }
    }
  }

  fill(): number {
    const P = this.aP.array as Float32Array;
    const V = this.aV.array as Float32Array;
    const D = this.aD.array as Float32Array;
    let n = 0;
    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i]) continue;
      const o = n * 4;
      const t = this.age[i] / this.life[i];
      P[o] = this.px[i]; P[o + 1] = this.py[i]; P[o + 2] = this.pz[i]; P[o + 3] = this.width[i];
      V[o] = this.vx[i]; V[o + 1] = this.vy[i]; V[o + 2] = this.vz[i]; V[o + 3] = this.len[i] * (1 - t * 0.5);
      D[o] = t; D[o + 1] = this.bright[i]; D[o + 2] = this.seed[i]; D[o + 3] = 0;
      n++;
    }
    touch(this.aP, n);
    touch(this.aV, n);
    touch(this.aD, n);
    this.geom.instanceCount = n;
    return n;
  }

  clear(): void {
    this.alive.fill(0);
    this.liveCount = 0;
    this.geom.instanceCount = 0;
  }

  dispose(): void {
    this.geom.dispose();
  }
}

// ───────────────────────────── flames ─────────────────────────────

export class FlamePool {
  readonly mesh: Mesh;
  readonly max: number;
  private readonly geom: InstancedBufferGeometry;
  private readonly aP: InstancedBufferAttribute;
  private readonly aV: InstancedBufferAttribute;
  private readonly aD: InstancedBufferAttribute;
  private readonly alive: Uint8Array;
  private readonly px: Float32Array; private readonly py: Float32Array; private readonly pz: Float32Array;
  private readonly cvx: Float32Array; private readonly cvy: Float32Array; private readonly cvz: Float32Array;
  private readonly dx: Float32Array; private readonly dy: Float32Array; private readonly dz: Float32Array;
  private readonly len: Float32Array; private readonly width: Float32Array;
  private readonly age: Float32Array; private readonly life: Float32Array;
  private readonly bright: Float32Array; private readonly seed: Float32Array; private readonly flash: Float32Array;
  private head = 0;
  liveCount = 0;

  constructor(max: number, material: ShaderMaterial) {
    this.max = max;
    const { geom, arrays } = makeQuadGeometry(max, { aP: 4, aV: 4, aD: 4 });
    this.geom = geom;
    this.aP = arrays.aP;
    this.aV = arrays.aV;
    this.aD = arrays.aD;
    this.mesh = new Mesh(geom, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.name = 'xr.fx.flames';
    const f = () => new Float32Array(max);
    this.alive = new Uint8Array(max);
    this.px = f(); this.py = f(); this.pz = f();
    this.cvx = f(); this.cvy = f(); this.cvz = f();
    this.dx = f(); this.dy = f(); this.dz = f();
    this.len = f(); this.width = f();
    this.age = f(); this.life = f();
    this.bright = f(); this.seed = f(); this.flash = f();
  }

  spawn(x: number, y: number, z: number, dx: number, dy: number, dz: number, len: number, width: number, life: number, bright: number, flash: number, cvx: number, cvy: number, cvz: number): void {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    if (!this.alive[i]) this.liveCount++;
    this.alive[i] = 1;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.dx[i] = dx; this.dy[i] = dy; this.dz[i] = dz;
    this.len[i] = len; this.width[i] = width;
    this.age[i] = 0; this.life[i] = life;
    this.bright[i] = bright; this.flash[i] = flash;
    this.seed[i] = rnd();
    this.cvx[i] = cvx; this.cvy[i] = cvy; this.cvz[i] = cvz;
  }

  update(dt: number): void {
    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i]) continue;
      const a = (this.age[i] += dt);
      if (a >= this.life[i]) {
        this.alive[i] = 0;
        this.liveCount--;
        continue;
      }
      this.px[i] += this.cvx[i] * dt;
      this.py[i] += this.cvy[i] * dt;
      this.pz[i] += this.cvz[i] * dt;
    }
  }

  fill(): number {
    const P = this.aP.array as Float32Array;
    const V = this.aV.array as Float32Array;
    const D = this.aD.array as Float32Array;
    let n = 0;
    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i]) continue;
      const o = n * 4;
      const t = this.age[i] / this.life[i];
      P[o] = this.px[i]; P[o + 1] = this.py[i]; P[o + 2] = this.pz[i]; P[o + 3] = this.width[i] * (0.8 + 0.5 * t);
      V[o] = this.dx[i]; V[o + 1] = this.dy[i]; V[o + 2] = this.dz[i]; V[o + 3] = this.len[i] * (0.35 + 0.65 * Math.min(1, t * 5));
      D[o] = t; D[o + 1] = this.bright[i]; D[o + 2] = this.seed[i]; D[o + 3] = this.flash[i];
      n++;
    }
    touch(this.aP, n);
    touch(this.aV, n);
    touch(this.aD, n);
    this.geom.instanceCount = n;
    return n;
  }

  clear(): void {
    this.alive.fill(0);
    this.liveCount = 0;
    this.geom.instanceCount = 0;
  }

  dispose(): void {
    this.geom.dispose();
  }
}

// ───────────────────────────── round glows ─────────────────────────────

export class GlowPool {
  readonly mesh: Mesh;
  readonly max: number;
  private readonly geom: InstancedBufferGeometry;
  private readonly aA: InstancedBufferAttribute;
  private readonly aB: InstancedBufferAttribute;
  private readonly aC: InstancedBufferAttribute;
  private readonly alive: Uint8Array;
  private readonly px: Float32Array; private readonly py: Float32Array; private readonly pz: Float32Array;
  private readonly vx: Float32Array; private readonly vy: Float32Array; private readonly vz: Float32Array;
  private readonly age: Float32Array; private readonly life: Float32Array;
  private readonly size: Float32Array; private readonly bright: Float32Array;
  private readonly cr: Float32Array; private readonly cg: Float32Array; private readonly cb: Float32Array;
  private head = 0;
  liveCount = 0;

  constructor(max: number, material: ShaderMaterial) {
    this.max = max;
    const { geom, arrays } = makeQuadGeometry(max, { aA: 4, aB: 4, aC: 4 });
    this.geom = geom;
    this.aA = arrays.aA;
    this.aB = arrays.aB;
    this.aC = arrays.aC;
    this.mesh = new Mesh(geom, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.name = 'xr.fx.glows';
    const f = () => new Float32Array(max);
    this.alive = new Uint8Array(max);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.age = f(); this.life = f();
    this.size = f(); this.bright = f();
    this.cr = f(); this.cg = f(); this.cb = f();
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, r: number, g: number, b: number, bright: number): void {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    if (!this.alive[i]) this.liveCount++;
    this.alive[i] = 1;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0; this.life[i] = life;
    this.size[i] = size; this.bright[i] = bright;
    this.cr[i] = r; this.cg[i] = g; this.cb[i] = b;
  }

  update(dt: number): void {
    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i]) continue;
      const a = (this.age[i] += dt);
      if (a >= this.life[i]) {
        this.alive[i] = 0;
        this.liveCount--;
        continue;
      }
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
    }
  }

  fill(): number {
    const A = this.aA.array as Float32Array;
    const B = this.aB.array as Float32Array;
    const C = this.aC.array as Float32Array;
    let n = 0;
    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i]) continue;
      const o = n * 4;
      A[o] = this.px[i]; A[o + 1] = this.py[i]; A[o + 2] = this.pz[i]; A[o + 3] = this.size[i];
      B[o] = this.age[i] / this.life[i]; B[o + 1] = this.bright[i]; B[o + 2] = 0; B[o + 3] = 0;
      C[o] = this.cr[i]; C[o + 1] = this.cg[i]; C[o + 2] = this.cb[i]; C[o + 3] = 0;
      n++;
    }
    touch(this.aA, n);
    touch(this.aB, n);
    touch(this.aC, n);
    this.geom.instanceCount = n;
    return n;
  }

  clear(): void {
    this.alive.fill(0);
    this.liveCount = 0;
    this.geom.instanceCount = 0;
  }

  dispose(): void {
    this.geom.dispose();
  }
}

// ───────────────────────────── debris chips ─────────────────────────────

export class ChipPool {
  readonly mesh: Mesh;
  readonly max: number;
  private readonly geom: InstancedBufferGeometry;
  private readonly aA: InstancedBufferAttribute;
  private readonly aB: InstancedBufferAttribute;
  private readonly aC: InstancedBufferAttribute;
  private readonly alive: Uint8Array;
  private readonly px: Float32Array; private readonly py: Float32Array; private readonly pz: Float32Array;
  private readonly vx: Float32Array; private readonly vy: Float32Array; private readonly vz: Float32Array;
  private readonly age: Float32Array; private readonly life: Float32Array;
  private readonly size: Float32Array; private readonly rot: Float32Array; private readonly rotVel: Float32Array;
  private readonly cr: Float32Array; private readonly cg: Float32Array; private readonly cb: Float32Array;
  private readonly gy: Float32Array;
  private head = 0;
  liveCount = 0;

  constructor(max: number, material: ShaderMaterial) {
    this.max = max;
    const { geom, arrays } = makeQuadGeometry(max, { aA: 4, aB: 4, aC: 4 });
    this.geom = geom;
    this.aA = arrays.aA;
    this.aB = arrays.aB;
    this.aC = arrays.aC;
    this.mesh = new Mesh(geom, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'xr.fx.chips';
    const f = () => new Float32Array(max);
    this.alive = new Uint8Array(max);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.age = f(); this.life = f();
    this.size = f(); this.rot = f(); this.rotVel = f();
    this.cr = f(); this.cg = f(); this.cb = f();
    this.gy = f();
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, r: number, g: number, b: number, groundY: number): void {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    if (!this.alive[i]) this.liveCount++;
    this.alive[i] = 1;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0; this.life[i] = life;
    this.size[i] = size;
    this.rot[i] = rnd() * 6.28;
    this.rotVel[i] = rr(-14, 14);
    this.cr[i] = r; this.cg[i] = g; this.cb[i] = b;
    this.gy[i] = groundY;
  }

  update(dt: number): void {
    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i]) continue;
      const a = (this.age[i] += dt);
      if (a >= this.life[i]) {
        this.alive[i] = 0;
        this.liveCount--;
        continue;
      }
      this.vy[i] -= 9.81 * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.rot[i] += this.rotVel[i] * dt;
      const gy = this.gy[i] + this.size[i] * 0.6;
      if (this.py[i] < gy) {
        this.py[i] = gy;
        if (this.vy[i] < 0) this.vy[i] = -this.vy[i] * 0.3;
        this.vx[i] *= 0.6;
        this.vz[i] *= 0.6;
        this.rotVel[i] *= 0.5;
        if (this.vy[i] < 0.6) this.vy[i] = 0;
      }
    }
  }

  fill(): number {
    const A = this.aA.array as Float32Array;
    const B = this.aB.array as Float32Array;
    const C = this.aC.array as Float32Array;
    let n = 0;
    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i]) continue;
      const o = n * 4;
      const t = this.age[i] / this.life[i];
      A[o] = this.px[i]; A[o + 1] = this.py[i]; A[o + 2] = this.pz[i]; A[o + 3] = this.size[i];
      B[o] = this.rot[i]; B[o + 1] = 0; B[o + 2] = 0; B[o + 3] = 0;
      C[o] = this.cr[i]; C[o + 1] = this.cg[i]; C[o + 2] = this.cb[i]; C[o + 3] = 1 - Math.max(0, (t - 0.7) / 0.3);
      n++;
    }
    touch(this.aA, n);
    touch(this.aB, n);
    touch(this.aC, n);
    this.geom.instanceCount = n;
    return n;
  }

  clear(): void {
    this.alive.fill(0);
    this.liveCount = 0;
    this.geom.instanceCount = 0;
  }

  dispose(): void {
    this.geom.dispose();
  }
}
