/**
 * Smaller things of a winter circuit: the marker poles along the snowbanks across the ice, the reeds of the shore, and the spectators
 * in their parkas. Instanced, cheap, alpha-cut.
 */
import * as THREE from 'three';
import { mulberry32 } from '../math';
import { resolveMark } from '../plan';
import type { WinterSceneryDef } from '../types';
import { SURF_CODE } from '../types';
import type { Ctx } from './ctx';

// ─────────────────────────────────────────────────────────────────────────────
// Marker poles on the ice
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the lane is across the frozen lake there is no road to see, only the snowbanks that mark it: ice racing puts a pole in the crest of
 * each, every 20 m or so, with an orange band that the lamps and headlights catch. They stand on the crest (a metre above the ground).
 */
export function buildPoles(ctx: Ctx, every: number): THREE.Object3D | null {
  const rt = ctx.rt;
  const ice = SURF_CODE.ice;
  const list: { x: number; y: number; z: number }[] = [];
  const step = Math.max(1, Math.round(every / rt.spacing));
  for (let i = 0; i < rt.count; i += step) {
    if (rt.roadSurf[i] !== ice) continue;
    for (const sgn of [1, -1] as const) {
      const S = sgn > 0 ? rt.L : rt.R;
      const d = sgn * (S.wall[i] + 1.1);
      const p = new THREE.Vector3();
      rt.pointAt(i * rt.spacing, d, p);
      list.push({ x: p.x, y: rt.heightSD(i * rt.spacing, d) + 1.2, z: p.z });
    }
  }
  if (!list.length) return null;
  // a slim pole, an orange sleeve at the top, a black band under it
  const geo = new THREE.CylinderGeometry(0.035, 0.035, 2.1, 6);
  geo.translate(0, 1.05, 0);
  const sleeve = new THREE.CylinderGeometry(0.06, 0.06, 0.45, 8);
  sleeve.translate(0, 1.82, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.6 });
  const matO = new THREE.MeshStandardMaterial({ color: 0xff6a10, roughness: 0.5, emissive: 0xff5a00, emissiveIntensity: 0.12 });
  const poles = new THREE.InstancedMesh(geo, mat, list.length);
  const sleeves = new THREE.InstancedMesh(sleeve, matO, list.length);
  const m4 = new THREE.Matrix4();
  list.forEach((l, i) => {
    m4.makeTranslation(l.x, l.y, l.z);
    poles.setMatrixAt(i, m4);
    sleeves.setMatrixAt(i, m4);
  });
  poles.castShadow = sleeves.castShadow = true;
  poles.frustumCulled = sleeves.frustumCulled = false;
  const g = new THREE.Group();
  g.name = 'icePoles';
  g.add(poles, sleeves);
  ctx.disposables.push(geo, sleeve, mat, matO);
  ctx.nightGlow.push({ mat: matO, day: 0.12, night: 1.1 });
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reeds
// ─────────────────────────────────────────────────────────────────────────────

function reedTexture(): THREE.CanvasTexture {
  const w = 128;
  const h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(31);
  g.clearRect(0, 0, w, h);
  g.lineCap = 'round';
  for (let i = 0; i < 26; i++) {
    const x0 = w * (0.14 + 0.72 * rnd());
    const lean = (rnd() - 0.5) * 40;
    const top = 14 + rnd() * 70;
    const col = ['#b3a066', '#c4b176', '#d0be84', '#a69358'][(rnd() * 4) | 0];
    g.strokeStyle = col;
    g.lineWidth = 2.6 + rnd() * 2;
    g.beginPath();
    g.moveTo(x0, h);
    g.quadraticCurveTo(x0 + lean * 0.3, h * 0.55, x0 + lean, top);
    g.stroke();
    // the seed head, and snow on the bent top
    if (rnd() < 0.55) {
      g.fillStyle = '#7a6740';
      g.beginPath();
      g.ellipse(x0 + lean, top + 5, 3.2, 10, lean * 0.01, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = 'rgba(245,248,255,0.95)';
    g.beginPath();
    g.ellipse(x0 + lean, top - 1, 4.6 + rnd() * 3, 3 + rnd() * 2, 0, 0, Math.PI * 2);
    g.fill();
  }
  // snow around the stalks' feet
  g.fillStyle = 'rgba(240,244,252,0.95)';
  g.beginPath();
  g.ellipse(w / 2, h - 3, w * 0.46, 11, 0, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Clumps of reeds standing through the snow along the shore of the lake, where the ice mask crosses its edge. */
export function buildReeds(ctx: Ctx, count: number): THREE.Object3D | null {
  const rt = ctx.rt;
  const lake = rt.iceLake;
  if (!lake || count <= 0) return null;
  const rnd = mulberry32(rt.def.seed ^ 0x2eed);
  const R = Math.max(lake.rx, lake.rz) * 1.2 + lake.shore * 2 + 40;
  const spots: { x: number; y: number; z: number; yaw: number; s: number }[] = [];
  for (let tries = 0; tries < count * 40 && spots.length < count; tries++) {
    const x = lake.x + (rnd() * 2 - 1) * R;
    const z = lake.z + (rnd() * 2 - 1) * R;
    const m = rt.terrain.iceMask(x, z);
    // the shore: where the mask is falling away, and a bit out in the ice
    if (m < 0.28 || m > 0.62) continue;
    if (rt.stripMargin(x, z) < 6) continue;
    let blocked = false;
    for (const r of ctx.reserved) {
      if (r(x, z, 2)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    spots.push({ x, y: rt.fieldHeight(x, z) - 0.05, z, yaw: rnd() * Math.PI, s: 0.8 + rnd() * 0.9 });
  }
  if (!spots.length) return null;
  // three crossed quads per clump
  const pos: number[] = [];
  const uv: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  let n = 0;
  for (const a of [0, Math.PI / 3, (2 * Math.PI) / 3]) {
    const dx = Math.cos(a) * 0.4;
    const dz = Math.sin(a) * 0.4;
    pos.push(-dx, 0, -dz, dx, 0, dz, dx, 1.9, dz, -dx, 1.9, -dz);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let i = 0; i < 4; i++) nor.push(0, 1, 0);
    idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
    n += 4;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const tex = reedTexture();
  const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, alphaToCoverage: true });
  const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const sc = new THREE.Vector3();
  const p = new THREE.Vector3();
  spots.forEach((s, i) => {
    q.setFromAxisAngle(up, s.yaw);
    sc.set(s.s, s.s, s.s);
    p.set(s.x, s.y, s.z);
    m4.compose(p, q, sc);
    mesh.setMatrixAt(i, m4);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.receiveShadow = true;
  mesh.name = 'reeds';
  ctx.disposables.push(geo, tex, mat);
  return mesh;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spectators
// ─────────────────────────────────────────────────────────────────────────────

const PARKAS = ['#c8321e', '#1f5fa8', '#e0a020', '#2a8a52', '#d8d8dc', '#7a2a8a', '#14181e', '#e8601c'];
const HATS = ['#e8e8ee', '#14181e', '#c8321e', '#1f5fa8', '#e0a020', '#3a3a44'];

/** An atlas of eight people bundled up for the cold (64 x 128 each): a bobble hat or a fur one, a scarf, a puffed parka, dark trousers and boots. */
function crowdAtlas(): THREE.CanvasTexture {
  const n = 8;
  const c = document.createElement('canvas');
  c.width = 64 * n;
  c.height = 128;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(555);
  g.clearRect(0, 0, c.width, c.height);
  for (let k = 0; k < n; k++) {
    const x0 = k * 64;
    const cx = x0 + 32;
    const parka = PARKAS[(k + 3 * ((rnd() * 3) | 0)) % PARKAS.length];
    const hat = HATS[(rnd() * HATS.length) | 0];
    const fat = 15 + rnd() * 5;
    // legs and boots
    g.fillStyle = '#20232a';
    g.fillRect(cx - 9, 84, 7, 36);
    g.fillRect(cx + 2, 84, 7, 36);
    g.fillStyle = '#101216';
    g.fillRect(cx - 10, 116, 9, 8);
    g.fillRect(cx + 1, 116, 9, 8);
    // the parka: a rounded body, arms, a hem
    g.fillStyle = parka;
    g.beginPath();
    g.ellipse(cx, 66, fat, 26, 0, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.ellipse(cx - fat - 1, 62, 5, 18, 0.15, 0, Math.PI * 2);
    g.ellipse(cx + fat + 1, 62, 5, 18, -0.15, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(cx - fat + 2, 56, fat * 2 - 4, 2.5);
    g.fillRect(cx - fat + 2, 70, fat * 2 - 4, 2.5);
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(cx - 1, 46, 2, 44);
    // the scarf, the head, the hat with a bobble
    g.fillStyle = HATS[(k + 2) % HATS.length];
    g.beginPath();
    g.ellipse(cx, 41, 11, 5, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#d9a98a';
    g.beginPath();
    g.ellipse(cx, 30, 8.5, 10, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = hat;
    g.beginPath();
    g.ellipse(cx, 24, 10.5, 9, 0, Math.PI, Math.PI * 2);
    g.fill();
    g.fillRect(cx - 10.5, 22, 21, 5);
    g.beginPath();
    g.arc(cx, 14, 4, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Spectators standing in groups behind the snowbank, facing the road: upright cut-outs, one instanced mesh, 8 people in the atlas. */
export function buildCrowds(ctx: Ctx, def: NonNullable<WinterSceneryDef['crowds']>): THREE.Object3D | null {
  const rt = ctx.rt;
  const rnd = mulberry32(rt.def.seed ^ 0xc20d);
  const people: { x: number; y: number; z: number; yaw: number; tile: number; s: number }[] = [];
  for (const cd of def) {
    const sgn: 1 | -1 = cd.side === 'L' ? 1 : -1;
    const S = sgn > 0 ? rt.L : rt.R;
    const i0 = Math.round(resolveMark(rt.plan.marks, rt.length, cd.at) / rt.spacing);
    for (let k = 0; k < cd.count; k++) {
      const i = (((i0 + Math.round((rnd() * 2 - 1) * cd.along)) % rt.count) + rt.count) % rt.count;
      const back = 5.6 + (cd.gap ?? 0.8) + rnd() * 5;
      const d = sgn * (S.wall[i] + back);
      const p = new THREE.Vector3();
      rt.pointAt(i * rt.spacing, d, p);
      let blocked = false;
      for (const r of ctx.reserved) {
        if (r(p.x, p.z, 0.5)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      const yaw = Math.atan2(-sgn * rt.HLX[i], -sgn * rt.HLZ[i]);
      people.push({ x: p.x, y: Math.max(rt.heightSD(i * rt.spacing, d), rt.fieldHeight(p.x, p.z)), z: p.z, yaw: yaw + (rnd() - 0.5) * 0.5, tile: (rnd() * 8) | 0, s: 0.92 + rnd() * 0.18 });
    }
  }
  if (!people.length) return null;
  const geo = new THREE.PlaneGeometry(0.62, 1.78);
  geo.translate(0, 0.89, 0);
  const tile = new Float32Array(people.length);
  people.forEach((p, i) => (tile[i] = p.tile));
  geo.setAttribute('aTile', new THREE.InstancedBufferAttribute(tile, 1));
  const tex = crowdAtlas();
  const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, alphaToCoverage: true });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aTile;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv = vec2((vMapUv.x + aTile) / 8.0, vMapUv.y);\n#endif');
  };
  mat.customProgramCacheKey = () => 'winter-crowd-v1';
  const mesh = new THREE.InstancedMesh(geo, mat, people.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const sc = new THREE.Vector3();
  const pp = new THREE.Vector3();
  people.forEach((p, i) => {
    q.setFromAxisAngle(up, p.yaw);
    sc.set(p.s, p.s, p.s);
    pp.set(p.x, p.y - 0.1, p.z);
    m4.compose(pp, q, sc);
    mesh.setMatrixAt(i, m4);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.name = 'crowds';
  mesh.receiveShadow = false;
  ctx.disposables.push(geo, tex, mat);
  return mesh;
}
