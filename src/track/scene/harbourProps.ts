/**
 * The harbour's dressing: boats moored along the quays and piers (instanced, bobbing on the swell), harbour cranes and container stacks
 * on the east quay, bollards, a lighthouse on the headland, and palms and lamp masts along the promenade.
 */
import * as THREE from 'three';
import { mulberry32 } from '../math';
import type { Ctx } from './ctx';
import { type QuaySegment, toWorld } from './harbour';

// ── a tiny flat-shaded mesh builder ─────────────────────────────────────────────────────────

class Flat {
  pos: number[] = [];
  col: number[] = [];
  tri(a: number[], b: number[], c: number[], col: [number, number, number]): void {
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.col.push(col[0], col[1], col[2]);
    }
  }
  quad(a: number[], b: number[], c: number[], d: number[], col: [number, number, number]): void {
    this.tri(a, b, c, col);
    this.tri(a, c, d, col);
  }
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, col: [number, number, number], shade = 1): void {
    const P = (sx: number, sy: number, sz: number): number[] => [cx + sx * hx, cy + sy * hy, cz + sz * hz];
    const f = (k: number): [number, number, number] => [col[0] * k * shade, col[1] * k * shade, col[2] * k * shade];
    this.quad(P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1), f(0.85));
    this.quad(P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), P(-1, -1, -1), f(0.85));
    this.quad(P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), f(1));
    this.quad(P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), P(-1, -1, -1), f(0.5));
    this.quad(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), f(0.92));
    this.quad(P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), f(0.78));
  }
  /** A vertical cylinder / cone (r0 at y0, r1 at y1) with `n` sides. */
  cyl(cx: number, y0: number, y1: number, cz: number, r0: number, r1: number, n: number, col: [number, number, number], cap = true): void {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const p = (a: number, r: number, y: number): number[] => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
      const k = 0.7 + 0.3 * Math.cos((a0 + a1) / 2 - 0.8);
      this.quad(p(a0, r0, y0), p(a1, r0, y0), p(a1, r1, y1), p(a0, r1, y1), [col[0] * k, col[1] * k, col[2] * k]);
      if (cap && r1 > 0) this.tri([cx, y1, cz], p(a1, r1, y1), p(a0, r1, y1), [col[0], col[1], col[2]]);
    }
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

const lin = (hex: number): [number, number, number] => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

// ── boats ───────────────────────────────────────────────────────────────────────────────────

interface BoatKind {
  name: string;
  len: number;
  beam: number;
  geo: (hull: number, deck: number, accent: number) => THREE.BufferGeometry;
}

/** A hull along +x (the bow at +x): stations from stern to bow, the waterline at y = 0. */
function hull(f: Flat, L: number, B: number, D: number, colHull: [number, number, number], colDeck: [number, number, number], colBoot: [number, number, number]): number[][][] {
  const widths = [0.8, 0.96, 1.0, 1.0, 0.9, 0.55, 0.05];
  const heights = [0.9, 0.88, 0.86, 0.87, 0.95, 1.1, 1.3];
  const drafts = [0.7, 0.9, 1.0, 1.0, 0.85, 0.5, 0.15];
  const rings: number[][][] = [];
  for (let i = 0; i < 7; i++) {
    const x = -L / 2 + (L * i) / 6;
    const w = (B / 2) * widths[i];
    const h = D * heights[i];
    const d = D * 0.9 * drafts[i];
    // port-side points then starboard: deck edge, waterline, chine, keel
    rings.push([
      [x, h, -w],
      [x, 0, -w * 0.985],
      [x, -d * 0.55, -w * 0.78],
      [x, -d, 0],
      [x, -d * 0.55, w * 0.78],
      [x, 0, w * 0.985],
      [x, h, w],
    ]);
  }
  for (let i = 0; i < 6; i++) {
    const a = rings[i];
    const b = rings[i + 1];
    for (let k = 0; k < 6; k++) {
      // the topsides in the hull colour, below the waterline in the boot colour
      const col = k === 0 || k === 5 ? colHull : colBoot;
      f.quad(a[k], b[k], b[k + 1], a[k + 1], col);
    }
    // deck
    f.quad(a[0], a[6], b[6], b[0], colDeck);
  }
  // transom
  const t = rings[0];
  f.quad(t[0], t[6], t[5], t[1], colHull);
  return rings;
}

function sailboat(hullHex: number, deckHex: number, accentHex: number): THREE.BufferGeometry {
  const f = new Flat();
  const L = 11;
  const B = 3.5;
  const D = 0.75;
  hull(f, L, B, D, lin(hullHex), lin(deckHex), lin(0x1b1d22));
  // cabin, mast, boom, a furled sail
  f.box(-0.4, D + 0.3, 0, 2.0, 0.3, 1.0, lin(deckHex), 1.05);
  f.box(2.4, D + 0.12, 0, 0.25, 0.1, 0.5, lin(deckHex));
  f.cyl(0.9, D, D + 15, 0, 0.07, 0.035, 6, lin(0xb9bcc0), false);
  f.box(-1.8, D + 0.85, 0, 2.6, 0.06, 0.06, lin(0xb9bcc0));
  f.box(-1.8, D + 0.98, 0, 2.55, 0.14, 0.14, lin(accentHex));
  f.cyl(-6.5, D, D + 3.2, 0, 0.03, 0.03, 4, lin(0xb9bcc0), false);
  return f.build();
}

function yacht(hullHex: number, deckHex: number, accentHex: number): THREE.BufferGeometry {
  const f = new Flat();
  const L = 19;
  const B = 5.2;
  const D = 1.3;
  hull(f, L, B, D, lin(hullHex), lin(deckHex), lin(0x2a2c30));
  const white = lin(0xeceeef);
  // lower saloon with a dark window band, the flybridge, the radar mast
  f.box(-1.2, D + 0.85, 0, 5.2, 0.85, 1.95, white);
  f.box(-1.2, D + 0.95, 0, 5.22, 0.28, 1.97, lin(0x0e141c));
  f.box(-2.4, D + 2.25, 0, 3.0, 0.5, 1.7, white);
  f.box(-2.4, D + 2.32, 0, 3.02, 0.2, 1.72, lin(0x0e141c));
  f.box(-2.6, D + 3.0, 0, 3.2, 0.1, 1.9, lin(accentHex));
  f.cyl(-1.6, D + 3.1, D + 5.2, 0, 0.06, 0.03, 6, lin(0xb9bcc0), false);
  f.box(-1.6, D + 4.6, 0, 0.12, 0.05, 0.5, lin(0x2d333b));
  return f.build();
}

function trawler(hullHex: number, deckHex: number, accentHex: number): THREE.BufferGeometry {
  const f = new Flat();
  const L = 13;
  const B = 4.2;
  const D = 1.15;
  hull(f, L, B, D, lin(hullHex), lin(deckHex), lin(0x201d1b));
  // wheelhouse forward, a mast with a boom, a net pile aft
  f.box(2.2, D + 1.0, 0, 1.3, 1.0, 1.35, lin(0xe9e6dc));
  f.box(2.2, D + 1.15, 0, 1.32, 0.34, 1.37, lin(0x10161d));
  f.box(2.2, D + 2.1, 0, 1.45, 0.08, 1.5, lin(accentHex));
  f.cyl(0.3, D, D + 7.4, 0, 0.08, 0.04, 6, lin(0x42464c), false);
  f.box(-1.4, D + 5.6, 0, 2.4, 0.05, 0.05, lin(0x42464c));
  f.box(-3.6, D + 0.4, 0, 1.4, 0.4, 1.2, lin(0x6b6a45));
  return f.build();
}

function dinghy(hullHex: number, deckHex: number, accentHex: number): THREE.BufferGeometry {
  const f = new Flat();
  const L = 5;
  const B = 2;
  const D = 0.55;
  hull(f, L, B, D, lin(hullHex), lin(deckHex), lin(0x222428));
  f.box(0, D + 0.12, 0, 1.6, 0.12, 0.8, lin(accentHex));
  f.box(-2.2, D + 0.45, 0, 0.3, 0.3, 0.2, lin(0x2d333b));
  return f.build();
}

const BOATS: BoatKind[] = [
  { name: 'sail', len: 11, beam: 3.5, geo: sailboat },
  { name: 'yacht', len: 19, beam: 5.2, geo: yacht },
  { name: 'trawler', len: 13, beam: 4.2, geo: trawler },
  { name: 'dinghy', len: 5, beam: 2, geo: dinghy },
];
const HULLS = [0xf1f2f2, 0xeceae2, 0x1e3a5f, 0xf4f4f0, 0xb7352a, 0x2c4a3a, 0xdedbd0, 0x16171a];
const DECKS = [0xcfc7b5, 0xd9d6cc, 0x9c9a92];
const ACCENTS = [0xd0102b, 0x1c4f9c, 0xe8e6dc, 0xf2c200, 0x2a8f6a, 0x10131a];

export interface HarbourProps {
  group: THREE.Group;
}

export function buildHarbourProps(ctx: Ctx, quays: QuaySegment[]): HarbourProps | null {
  const rt = ctx.rt;
  const sea = rt.def.terrain.sea;
  if (!sea) return null;
  const hd = rt.def.scenery?.harbour;
  const rnd = mulberry32(rt.def.seed ^ 0x2545f491);
  const group = new THREE.Group();
  group.name = 'harbour_props';
  const level = sea.level;
  const quayY = sea.quay;
  const sd = rt.terrain.seaDistance;

  // ── boats ──────────────────────────────────────────────────────────────────────────────────────
  interface Berth {
    x: number;
    z: number;
    yaw: number;
    kind: number;
  }
  const berths: Berth[] = [];
  const nearCircuit = (x: number, z: number): boolean => {
    const b = rt.bounds;
    return x > b.minX - 500 && x < b.maxX + 700 && z > b.minZ - 1400 && z < b.maxZ + 100;
  };
  for (const q of quays) {
    if (q.len < 30) continue;
    const dx = (q.x1 - q.x0) / q.len;
    const dz = (q.z1 - q.z0) / q.len;
    // a pier's long sides: boats alongside; the main quay (and short ends): boats stern-to, bow out
    const alongside = q.len < 150;
    let t = 6 + rnd() * 4;
    while (t < q.len - 6) {
      // kinds: mostly sail and motor, some trawlers and tenders
      const r = rnd();
      const kind = r < 0.5 ? 0 : r < 0.72 ? 1 : r < 0.84 ? 2 : 3;
      const bk = BOATS[kind];
      const x = q.x0 + dx * t;
      const z = q.z0 + dz * t;
      if (rnd() < (alongside ? 0.55 : 0.62) && nearCircuit(x, z)) {
        if (alongside) {
          // along the wall: yaw along the quay, the beam against it
          const yaw = Math.atan2(-dz, dx) + (rnd() < 0.5 ? 0 : Math.PI);
          berths.push({ x: x + q.nx * (bk.beam / 2 + 0.9), z: z + q.nz * (bk.beam / 2 + 0.9), yaw, kind });
          t += bk.len + 1.4;
        } else {
          // stern-to: the boat's axis along the normal, the stern a metre off the wall
          const yaw = Math.atan2(-q.nz, q.nx);
          berths.push({ x: x + q.nx * (bk.len / 2 + 1.1), z: z + q.nz * (bk.len / 2 + 1.1), yaw, kind });
          t += bk.beam + 1.3;
        }
      } else t += 4 + rnd() * 6;
    }
  }
  // a few at anchor out in the bay
  {
    const b = rt.bounds;
    for (let i = 0; i < (hd?.boats ?? 14); i++) {
      const e = (-(b.minX + b.maxX) / 2) + (rnd() - 0.5) * 900;
      const n = -140 - rnd() * 700;
      const [x, z] = toWorld(e, n);
      if (sd(x, z) > -40) continue;
      berths.push({ x, z, yaw: 1.2 + (rnd() - 0.5) * 0.4, kind: rnd() < 0.6 ? 0 : 1 });
    }
  }
  const variants = 3;
  const lists: Berth[][] = BOATS.flatMap(() => Array.from({ length: variants }, () => [] as Berth[]));
  for (const bth of berths) lists[bth.kind * variants + Math.floor(rnd() * variants)].push(bth);
  const uTime = { value: 0 };
  const boatMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05, envMapIntensity: 0.9 });
  boatMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  float bph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
  float roll = sin(uTime * 0.9 + bph) * 0.02;
  float pitch = sin(uTime * 0.7 + bph * 1.7) * 0.012;
  transformed.y += sin(uTime * 1.25 + bph) * 0.05 + transformed.z * roll + transformed.x * pitch;
#endif`,
      );
  };
  boatMat.customProgramCacheKey = () => 'harbour-boat-v1';
  ctx.disposables.push(boatMat);
  const m4 = new THREE.Matrix4();
  const qn = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  BOATS.forEach((bk, ki) => {
    for (let v = 0; v < variants; v++) {
      const list = lists[ki * variants + v];
      if (!list.length) continue;
      const geo = bk.geo(HULLS[(ki * 3 + v * 2 + (v === 2 ? 1 : 0)) % HULLS.length], DECKS[v % DECKS.length], ACCENTS[(ki + v * 2) % ACCENTS.length]);
      ctx.disposables.push(geo);
      const mesh = new THREE.InstancedMesh(geo, boatMat, list.length);
      list.forEach((bth, i) => {
        qn.setFromAxisAngle(up, bth.yaw);
        m4.compose(new THREE.Vector3(bth.x, level + 0.05, bth.z), qn, new THREE.Vector3(1, 1, 1));
        mesh.setMatrixAt(i, m4);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `boats_${bk.name}_${v}`;
      group.add(mesh);
    }
  });
  ctx.updaters.push((_dt, _cam, time) => {
    uTime.value = time;
  });

  // ── mooring bollards along the quays ──────────────────────────────────────────────────────────────
  {
    const spots: [number, number][] = [];
    for (const q of quays) {
      if (!nearCircuit(q.x0, q.z0)) continue;
      const dx = (q.x1 - q.x0) / q.len;
      const dz = (q.z1 - q.z0) / q.len;
      for (let t = 5; t < q.len - 3; t += 14) spots.push([q.x0 + dx * t - q.nx * 0.55, q.z0 + dz * t - q.nz * 0.55]);
    }
    if (spots.length) {
      const g = new THREE.CylinderGeometry(0.2, 0.26, 0.55, 8);
      g.translate(0, 0.28, 0);
      const mat = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.6, metalness: 0.4 });
      const mesh = new THREE.InstancedMesh(g, mat, spots.length);
      spots.forEach(([x, z], i) => {
        m4.compose(new THREE.Vector3(x, quayY + 0.05, z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
        mesh.setMatrixAt(i, m4);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      group.add(mesh);
      ctx.disposables.push(g, mat);
    }
  }

  // ── the promenade: palms along the long quays, floodlight masts reaching over the apron ──────────────────
  {
    const palms: import('./trees').Inst[] = [];
    const lamps: { x: number; y: number; z: number; ox: number; oz: number }[] = [];
    for (const q of quays) {
      if (!nearCircuit(q.x0, q.z0) || q.len < 200) continue;
      const dx = (q.x1 - q.x0) / q.len;
      const dz = (q.z1 - q.z0) / q.len;
      for (let t = 8; t < q.len - 6; t += 15 + rnd() * 3) {
        const x = q.x0 + dx * t - q.nx * 5.5;
        const z = q.z0 + dz * t - q.nz * 5.5;
        if (ctx.reserved.some((r) => r(x, z, 2))) continue;
        palms.push({ x, y: quayY - 0.05, z, yaw: rnd() * Math.PI * 2, s: 9.5 + rnd() * 4.5, tint: 0.92 + rnd() * 0.16, hue: (rnd() - 0.5) * 0.2, w: 0.9 + rnd() * 0.25 });
      }
      for (let t = 20; t < q.len - 10; t += 62) {
        lamps.push({ x: q.x0 + dx * t - q.nx * 2.2, y: quayY, z: q.z0 + dz * t - q.nz * 2.2, ox: q.nx, oz: q.nz });
      }
    }
    ctx.extraTrees = { ...(ctx.extraTrees ?? {}), palm: [...(ctx.extraTrees?.palm ?? []), ...palms] };
    ctx.extraLamps = [...(ctx.extraLamps ?? []), ...lamps];
  }

  // ── cranes and containers on the east quay ─────────────────────────────────────────────────────────
  for (const c of hd?.cranes ?? []) {
    const f = new Flat();
    const red = lin(0xc2321f);
    const grey = lin(0xb8bcc0);
    const dark = lin(0x30343a);
    // a portal on four legs over the quay, a cab, a boom reaching over the water (+x = toward the water) and a counterweight
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) f.box(sx * 4.2, 8, sz * 6.5, 0.45, 8, 0.45, red);
    }
    f.box(0, 16.4, 0, 5, 0.6, 7.4, red);
    f.box(0, 18.2, 0, 3.2, 1.8, 3.2, grey);
    f.box(-0.5, 21.6, 0, 1.6, 1.2, 1.8, lin(0xe8e2d0));
    f.box(-0.4, 21.7, 0, 1.62, 0.5, 1.82, lin(0x10161d));
    // boom: an inclined box from the cab out over the water
    const boom: number[][] = [[0, 19.5, 0], [26, 23, 0], [26, 24.2, 0], [0, 20.8, 0]];
    f.quad([boom[0][0], boom[0][1], -1], [boom[1][0], boom[1][1], -1], [boom[2][0], boom[2][1], -1], [boom[3][0], boom[3][1], -1], grey);
    f.quad([boom[0][0], boom[0][1], 1], [boom[3][0], boom[3][1], 1], [boom[2][0], boom[2][1], 1], [boom[1][0], boom[1][1], 1], grey);
    f.quad([boom[3][0], boom[3][1], -1], [boom[2][0], boom[2][1], -1], [boom[2][0], boom[2][1], 1], [boom[3][0], boom[3][1], 1], lin(0xd7d9da));
    f.box(-7, 20.2, 0, 3.5, 1.2, 1.6, dark);
    f.cyl(27, 17, 23.6, 0, 0.09, 0.09, 5, lin(0x24272c), false);
    f.box(27, 15.5, 0, 0.8, 1.5, 0.6, lin(0xf2c200));
    const geo = f.build();
    ctx.disposables.push(geo);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.35, envMapIntensity: 0.8 });
    ctx.disposables.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    const [x, z] = toWorld(c.e, c.n);
    mesh.position.set(x, quayY, z);
    // the boom points at the water (west of the east quay: toward -e... in world +x): rotate the model's +x to the yaw
    mesh.rotation.y = ((c.yaw ?? 0) * Math.PI) / 180;
    mesh.scale.setScalar(c.scale ?? 1);
    mesh.castShadow = true;
    group.add(mesh);
  }
  // container stacks behind the cranes (instanced boxes in a few colours)
  {
    const yard = hd?.cranes?.length ? hd.cranes : [];
    if (yard.length) {
      const boxes: { x: number; y: number; z: number; yaw: number; c: number }[] = [];
      const e0 = Math.min(...yard.map((c) => c.e));
      const n0 = Math.min(...yard.map((c) => c.n)) - 60;
      const n1 = Math.max(...yard.map((c) => c.n)) + 40;
      for (let n = n0; n < n1; n += 16) {
        for (let k = 0; k < 6; k++) {
          const e = e0 + 28 + k * 15;
          if (rnd() < 0.18) continue;
          const stack = 1 + Math.floor(rnd() * 4);
          const [x, z] = toWorld(e, n);
          for (let h = 0; h < stack; h++) boxes.push({ x, y: quayY + 1.3 + h * 2.62, z, yaw: Math.PI / 2, c: Math.floor(rnd() * 6) });
        }
      }
      const colors = [0xb23a2c, 0x2b5d8f, 0xd9a21b, 0x3d7a4a, 0xcfcfc8, 0x6d4a7a];
      const g = new THREE.BoxGeometry(2.45, 2.6, 12.2);
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.65, metalness: 0.25 });
      const mesh = new THREE.InstancedMesh(g, mat, boxes.length);
      const col = new THREE.Color();
      boxes.forEach((b, i) => {
        qn.setFromAxisAngle(up, b.yaw);
        m4.compose(new THREE.Vector3(b.x, b.y, b.z), qn, new THREE.Vector3(1, 1, 1));
        mesh.setMatrixAt(i, m4);
        mesh.setColorAt(i, col.set(colors[b.c]));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      ctx.disposables.push(g, mat);
    }
  }

  // ── the lighthouse on the headland ──────────────────────────────────────────────────────────────────
  for (const lm of rt.def.scenery?.city?.landmarks ?? []) {
    if (lm.kind !== 'lighthouse') continue;
    const f = new Flat();
    const [x, z] = toWorld(lm.e ?? 0, lm.n ?? 0);
    const base = quayY;
    const white = lin(0xeeeae0);
    const red = lin(0xb42a22);
    // a stepped, banded tower
    let y = base;
    for (let i = 0; i < 6; i++) {
      const r0 = 3.6 - i * 0.28;
      const r1 = 3.6 - (i + 1) * 0.28;
      f.cyl(0, y, y + 4.2, 0, r0, r1, 12, i % 2 === 0 ? white : red, false);
      y += 4.2;
    }
    f.cyl(0, y, y + 0.3, 0, 3.4, 3.4, 12, lin(0x2a2d31), false);
    f.cyl(0, y + 0.3, y + 1.2, 0, 3.4, 3.4, 12, lin(0x2a2d31), true);
    const geo = f.build();
    ctx.disposables.push(geo);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
    ctx.disposables.push(mat);
    const tower = new THREE.Mesh(geo, mat);
    tower.position.set(x, 0, z);
    tower.scale.setScalar(lm.scale ?? 1);
    tower.castShadow = true;
    group.add(tower);
    // the lantern: a glass cylinder that glows at night, a dome above it, and a beacon that flashes
    const lanternY = (y + 1.2 - base) * (lm.scale ?? 1) + base;
    const lg = new THREE.CylinderGeometry(1.5, 1.5, 2.6, 10);
    const lanternMat = new THREE.MeshStandardMaterial({ color: 0xfff2c0, roughness: 0.3, emissive: 0xffe9a8, emissiveIntensity: 0 });
    const lantern = new THREE.Mesh(lg, lanternMat);
    lantern.position.set(x, lanternY + 1.3 * (lm.scale ?? 1), z);
    lantern.scale.setScalar(lm.scale ?? 1);
    group.add(lantern);
    const dome = new THREE.Mesh(new THREE.ConeGeometry(1.9, 1.6, 10), new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.5, metalness: 0.4 }));
    dome.position.set(x, lanternY + 3.4 * (lm.scale ?? 1), z);
    dome.scale.setScalar(lm.scale ?? 1);
    group.add(dome);
    ctx.disposables.push(lg, lanternMat, dome.geometry, dome.material as THREE.Material);
    ctx.nightGlow.push({ mat: lanternMat, day: 0, night: 5 });
    // beacon flash: a soft additive sprite, on for a moment every few seconds, only after dark
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const g2 = cv.getContext('2d')!;
    const gr = g2.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,246,214,1)');
    gr.addColorStop(0.15, 'rgba(255,236,170,0.7)');
    gr.addColorStop(0.5, 'rgba(255,220,140,0.16)');
    gr.addColorStop(1, 'rgba(255,210,120,0)');
    g2.fillStyle = gr;
    g2.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sm = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, fog: false });
    const spr = new THREE.Sprite(sm);
    spr.position.copy(lantern.position);
    spr.scale.setScalar(90);
    spr.renderOrder = 8;
    group.add(spr);
    ctx.disposables.push(tex, sm);
    let dark = 0;
    ctx.envListeners.push((env) => {
      dark = env.darkness;
    });
    ctx.updaters.push((_dt, _cam, time) => {
      // one flash every 5 s: a quick rise and a slow fade
      const ph = (time % 5) / 5;
      const flash = ph < 0.05 ? ph / 0.05 : Math.exp(-(ph - 0.05) * 7);
      sm.opacity = Math.min(1, Math.max(0, (dark - 0.25) / 0.5)) * (0.15 + 0.85 * flash);
    });
  }

  return { group };
}
