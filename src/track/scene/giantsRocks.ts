/**
 * The rocks in the sea of an island circuit that a height field cannot make (`GiantsDef.arch`, `GiantsDef.boulders`): one natural
 * arch, a fin of layered rock with the sea running through it, and boulders in the shallows under the cliff and round the feet of
 * the stacks. One mesh in the rock of the island's cliffs; it stands too far from the road to cast into the sun's cascades, so the
 * shade under the arch is painted into it.
 */
import * as THREE from 'three';
import { mulberry32, Noise2, smoothstep } from '../math';
import type { TrackRuntimeImpl } from '../runtime';
import type { BoulderFieldDef, GiantsDef, SeaArchDef } from '../types';
import type { Ctx } from './ctx';

/** The rock texture repeats every so many metres (as on the terrain's cliffs). */
const TILE = 6.5;

export class RockBuf {
  /** The first and last vertex of each closed loop: one place, two vertices (the texture has a seam there, the shading must not). */
  seams: number[] = [];
  pos: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  n = 0;
  v(x: number, y: number, z: number, u: number, v: number, r: number, g: number, b: number): number {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    this.col.push(r, g, b);
    return this.n++;
  }
}

/** The colour of the rock at a height over the sea: wet and dark in the wash, a pale band of salt above it, strata further up. */
function rockTone(y: number, k: number, out: [number, number, number]): void {
  const wet = 1 - smoothstep(0.2, 1.6, y);
  const salt = smoothstep(0.8, 2, y) * (1 - smoothstep(2.6, 5, y));
  const strata = 0.93 + 0.09 * Math.sin(y * 0.42 + 1.3) + 0.05 * Math.sin(y * 1.31);
  const v = k * strata * (1 - 0.5 * wet) * (1 + 0.16 * salt);
  out[0] = v * (1 - 0.06 * wet);
  out[1] = v * (1 - 0.01 * wet);
  out[2] = v * (0.96 + 0.05 * salt);
}

/** The skyline of the fin along its length (0..1), as a share of its full height: a cliff at one end, a long neck down into the sea at the other. */
const SKYLINE: [number, number][] = [[0, -0.12], [0.04, 0.46], [0.11, 0.76], [0.26, 0.97], [0.42, 1], [0.56, 0.95], [0.68, 0.79], [0.8, 0.56], [0.9, 0.36], [0.97, 0.14], [1, -0.12]];

function skyline(s: number): number {
  for (let i = 0; i + 1 < SKYLINE.length; i++) {
    const [s0, v0] = SKYLINE[i];
    const [s1, v1] = SKYLINE[i + 1];
    if (s <= s1) {
      const t = Math.min(1, Math.max(0, (s - s0) / (s1 - s0)));
      return v0 + (v1 - v0) * (t * t * (3 - 2 * t));
    }
  }
  return SKYLINE[SKYLINE.length - 1][1];
}

/** The size of the arch a def describes: the height of the rock over the middle of the opening, its length and its thickness at the water. */
export function archSize(a: SeaArchDef): { height: number; length: number; thick: number; from: number; to: number } {
  const length = a.length ?? a.span * 2.6;
  return { height: a.rise + (a.cap ?? 14), length, thick: a.thick ?? a.span * 0.45, from: -0.42 * length, to: 0.58 * length };
}

/**
 * The arch: sections across the fin, one after another along its length, each a closed loop from its foot (the bed of the sea, or
 * the underside of the span where the opening is) to the skyline.
 */
export function emitArch(b: RockBuf, a: SeaArchDef, seed: number, detail: number): void {
  const size = archSize(a);
  const bearing = ((a.bearing ?? 0) * Math.PI) / 180;
  // the line of sight through the opening (east of north; world x = -east) and the fin's length, square to it
  const bx = -Math.sin(bearing);
  const bz = Math.cos(bearing);
  const ax = Math.cos(bearing);
  const az = Math.sin(bearing);
  const n1 = new Noise2(seed + 3);
  const n2 = new Noise2(seed + 11);
  const half = a.span / 2;
  const BED = -9;
  const M = Math.max(10, Math.round(18 * detail));
  // stations: even along the fin, close together at the two jambs of the opening
  const st: number[] = [];
  const N = Math.max(24, Math.round(54 * detail));
  for (let i = 0; i <= N; i++) st.push(size.from + ((size.to - size.from) * i) / N);
  for (const j of [-1, 1]) st.push(j * half, j * half * 0.992, j * half * 0.95, j * half * 0.86, j * (half + 1.5));
  st.sort((p, q) => p - q);
  const tone: [number, number, number] = [0, 0, 0];
  const lean = (mulberry32(seed)() - 0.5) * 0.08;
  let prev = -1;
  for (let i = 0; i < st.length; i++) {
    const at = st[i];
    if (i > 0 && at - st[i - 1] < 0.05) continue;
    const s = (at - size.from) / (size.to - size.from);
    const inside = Math.abs(at) < half;
    const top = Math.max(BED + 1.5, size.height * skyline(s) + n1.noise(at * 0.05, 3.7) * size.height * 0.07);
    // the underside of the span: a flattened arch, upright at its jambs
    const foot = inside ? a.rise * Math.pow(1 - Math.pow(Math.abs(at) / half, 2.6), 1 / 2.2) : BED;
    const bot = Math.min(foot, top - 1.5);
    const tHalf = (size.thick / 2) * (0.5 + 0.5 * Math.sqrt(Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, s))))));
    const base = b.n;
    let arc = 0;
    let px = 0;
    let py = 0;
    for (let m = 0; m <= M; m++) {
      const ph = (m / M) * Math.PI * 2;
      const cs = Math.cos(ph);
      const sn = Math.sin(ph);
      const yn = Math.sign(sn) * Math.pow(Math.abs(sn), 0.7);
      const bn = Math.sign(cs) * Math.pow(Math.abs(cs), 0.55);
      let y = (top + bot) / 2 + ((top - bot) / 2) * yn;
      // thick at the water, half as thick at the skyline
      const rel = Math.min(1, Math.max(0, y / size.height));
      const tb = tHalf * (0.5 + 0.5 * Math.pow(1 - rel, 1.3));
      let off = tb * bn + lean * y;
      // the weather's work: the two faces each have their own, blended over the top and the foot; ledges where the strata lie
      const w = 0.5 + 0.5 * cs;
      const f1 = n1.fbm(at * 0.045, y * 0.06, 3);
      const f2 = n2.fbm(at * 0.045, y * 0.06, 3);
      const rough = (w * f1 + (1 - w) * f2) * 3.4 + Math.sin(y * 0.5 + (w * f1 + (1 - w) * f2) * 3) * 0.5;
      const d = rough * Math.min(1, tb / 6);
      off += d * cs;
      y += d * sn * 0.6;
      const x = a.x + ax * at + bx * off;
      const z = a.z + az * at + bz * off;
      if (m > 0) arc += Math.hypot(off - px, y - py);
      px = off;
      py = y;
      // under the span, and where a face overhangs, the rock is in its own shade
      const under = inside && sn < -0.2 ? 0.55 + 0.45 * smoothstep(0.75, 1, Math.abs(at) / half) * 0.4 : 1;
      rockTone(y, (0.92 + 0.16 * (w * f1 + (1 - w) * f2)) * under, tone);
      // grass and salt bush on what is level at the top
      const cap = sn > 0.86 && y > 12 ? 0.55 : 0;
      b.v(x, y, z, at / TILE, arc / TILE, tone[0] * (1 - 0.3 * cap), tone[1] * (1 - 0.08 * cap), tone[2] * (1 - 0.45 * cap));
    }
    if (prev >= 0) {
      for (let m = 0; m < M; m++) {
        const p = prev + m;
        const q = base + m;
        b.idx.push(p, q, p + 1, q, q + 1, p + 1);
      }
    }
    prev = base;
    b.seams.push(base, base + M);
  }
}

/** A boulder: an eight-faced stone, each face split in four, pushed out of round, lying flat rather than standing. */
export function emitBoulder(b: RockBuf, x: number, y: number, z: number, size: number, seed: number): void {
  const rnd = mulberry32(seed);
  const noise = new Noise2(seed);
  const sx = size * (0.8 + 0.6 * rnd());
  const sy = size * (0.45 + 0.4 * rnd());
  const sz = size * (0.8 + 0.6 * rnd());
  const yaw = rnd() * 6.28;
  const cy = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const corners: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const faces = [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [4, 3, 0], [1, 3, 4], [5, 3, 1], [0, 3, 5]];
  const made = new Map<string, number>();
  const tone: [number, number, number] = [0, 0, 0];
  const vert = (p: [number, number, number]): number => {
    const l = Math.hypot(p[0], p[1], p[2]);
    const d: [number, number, number] = [p[0] / l, p[1] / l, p[2] / l];
    const key = d.map((v) => Math.round(v * 1000)).join();
    const got = made.get(key);
    if (got !== undefined) return got;
    const k = 1 + 0.3 * noise.noise(d[0] * 1.7 + d[1] * 1.1, d[2] * 1.7 - d[1] * 0.9);
    const lx = d[0] * sx * k;
    const ly = d[1] * sy * k;
    const lz = d[2] * sz * k;
    const wx = x + lx * cy - lz * sn;
    const wz = z + lx * sn + lz * cy;
    rockTone(y + ly, 0.86 + 0.2 * rnd(), tone);
    const i = b.v(wx, y + ly, wz, (wx + wz * 0.6) / TILE, (y + ly + wz * 0.3) / TILE, tone[0], tone[1], tone[2]);
    made.set(key, i);
    return i;
  };
  const mid = (p: [number, number, number], q: [number, number, number]): [number, number, number] => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
  for (const f of faces) {
    const p = corners[f[0]];
    const q = corners[f[1]];
    const r = corners[f[2]];
    const pq = mid(p, q);
    const qr = mid(q, r);
    const rp = mid(r, p);
    for (const t of [[p, pq, rp], [pq, q, qr], [rp, qr, r], [pq, qr, rp]] as [number, number, number][][]) b.idx.push(vert(t[0]), vert(t[1]), vert(t[2]));
  }
}

/** Where the boulders of a field lie: in the shallows and on the shore (the bed between 5 m under the sea and 3 m over it). */
export function placeBoulders(rt: TrackRuntimeImpl, f: BoulderFieldDef, seed: number): { x: number; y: number; z: number; size: number }[] {
  const rnd = mulberry32(seed);
  const sea = rt.terrain.lakeLevel ?? 0;
  const out: { x: number; y: number; z: number; size: number }[] = [];
  for (let tries = 0; tries < f.n * 30 && out.length < f.n; tries++) {
    const a = rnd() * Math.PI * 2;
    const d = Math.sqrt(rnd()) * f.r;
    const x = f.x + Math.cos(a) * d;
    const z = f.z + Math.sin(a) * d;
    const size = f.size * (0.45 + 1.1 * rnd() * rnd());
    const bed = rt.fieldHeight(x, z);
    if (bed < sea - 5 || bed > sea + 3) continue;
    out.push({ x, y: Math.max(bed, sea - size * 0.5) + size * 0.12, z, size });
  }
  return out;
}

export function buildSeaRocks(ctx: Ctx, def: GiantsDef): { mesh: THREE.Mesh; triangles: number } | null {
  if (!def.arch && !def.boulders?.length) return null;
  const seed = def.seed ?? 1;
  const b = new RockBuf();
  const detail = [0.6, 0.8, 1, 1.2][ctx.q.tier];
  if (def.arch) emitArch(b, def.arch, seed, detail);
  (def.boulders ?? []).forEach((f, i) => {
    placeBoulders(ctx.rt, f, seed + 31 * (i + 1)).forEach((p, j) => emitBoulder(b, p.x, p.y, p.z, p.size, seed + i * 977 + j * 13));
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.pos), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(b.uv), 2));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(b.col), 3));
  geo.setIndex(new THREE.BufferAttribute(b.n > 65535 ? new Uint32Array(b.idx) : new Uint16Array(b.idx), 1));
  geo.computeVertexNormals();
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < b.seams.length; i += 2) {
    const p = b.seams[i];
    const q = b.seams[i + 1];
    const x = nor.getX(p) + nor.getX(q);
    const y = nor.getY(p) + nor.getY(q);
    const z = nor.getZ(p) + nor.getZ(q);
    const l = Math.hypot(x, y, z) || 1;
    nor.setXYZ(p, x / l, y / l, z / l);
    nor.setXYZ(q, x / l, y / l, z / l);
  }
  geo.computeBoundingSphere();
  const r = ctx.tex.rock;
  const rep = (t: THREE.Texture): THREE.Texture => {
    const c = t.clone();
    c.wrapS = c.wrapT = THREE.RepeatWrapping;
    c.needsUpdate = true;
    ctx.disposables.push(c);
    return c;
  };
  const mat = new THREE.MeshStandardMaterial({ map: rep(r.diff), normalMap: rep(r.nor), roughnessMap: rep(r.rough), roughness: 1, vertexColors: true, color: 0xb5ada0, envMapIntensity: 0.5 });
  mat.name = 'giantsRock';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'giants_rocks';
  mesh.matrixAutoUpdate = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  ctx.disposables.push(geo, mat);
  return { mesh, triangles: b.idx.length / 3 };
}
