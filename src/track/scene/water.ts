/**
 * Lake water: a grid over the lake bounds at the lake level, vertex-coloured by depth (shallow = clear + lighter,
 * deep = dark), two scrolling normal-mapped wave layers (normalMap + clearcoat normalMap) and environment reflections.
 */
import * as THREE from 'three';
import type { Ctx } from './ctx';
import { makeWaterNormal } from './propTextures';

export function buildWater(ctx: Ctx): THREE.Object3D | null {
  const rt = ctx.rt;
  const lake = rt.def.terrain.lake;
  if (!lake) return null;
  const level = lake.level;
  // bounds: sample the field to find the water extent
  const R = Math.max(lake.rx, lake.rz) * 1.5 + 140;
  const step = 7;
  const nx = Math.ceil((2 * R) / step) + 1;
  const x0 = lake.x - R;
  const z0 = lake.z - R;
  const H = new Float32Array(nx * nx);
  let minI = nx;
  let maxI = -1;
  let minJ = nx;
  let maxJ = -1;
  for (let j = 0; j < nx; j++) {
    for (let i = 0; i < nx; i++) {
      const h = rt.heightFast(x0 + i * step, z0 + j * step);
      H[j * nx + i] = h;
      if (h < level + 0.4) {
        minI = Math.min(minI, i);
        maxI = Math.max(maxI, i);
        minJ = Math.min(minJ, j);
        maxJ = Math.max(maxJ, j);
      }
    }
  }
  if (maxI < 0) return null;
  minI = Math.max(0, minI - 2);
  minJ = Math.max(0, minJ - 2);
  maxI = Math.min(nx - 1, maxI + 2);
  maxJ = Math.min(nx - 1, maxJ + 2);
  const w = maxI - minI + 1;
  const h = maxJ - minJ + 1;
  const pos = new Float32Array(w * h * 3);
  const nor = new Float32Array(w * h * 3);
  const uv = new Float32Array(w * h * 2);
  const col = new Float32Array(w * h * 4);
  const shallow = new THREE.Color(0.16, 0.36, 0.33);
  const deep = new THREE.Color(0.012, 0.075, 0.095);
  const c = new THREE.Color();
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const gx = x0 + (minI + i) * step;
      const gz = z0 + (minJ + j) * step;
      pos[k * 3] = gx;
      pos[k * 3 + 1] = level;
      pos[k * 3 + 2] = gz;
      nor[k * 3 + 1] = 1;
      uv[k * 2] = gx;
      uv[k * 2 + 1] = gz;
      const depth = level - H[(minJ + j) * nx + (minI + i)];
      const t = Math.min(1, Math.max(0, depth / 5));
      c.copy(shallow).lerp(deep, Math.sqrt(t));
      col[k * 4] = c.r;
      col[k * 4 + 1] = c.g;
      col[k * 4 + 2] = c.b;
      // clear at the shore, opaque once there is some depth
      const a = Math.min(1, Math.max(0, (depth + 0.05) / 0.9));
      col[k * 4 + 3] = a * a * (3 - 2 * a);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j + 1 < h; j++) {
    for (let i = 0; i + 1 < w; i++) {
      const a = j * w + i;
      const b = a + 1;
      const cc = a + w + 1;
      const d = a + w;
      // up-facing: (a, d, c) (b)
      idx.push(a, d, cc, a, cc, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
  geo.setIndex(idx);
  geo.computeBoundingSphere();

  const mat = makeWaterMaterial(ctx, 23, 7.3);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 5;
  mesh.name = 'lake';
  mesh.receiveShadow = false;
  ctx.disposables.push(geo);
  return mesh;
}

/** The colour of the sea over `depth` metres of water (linear): turquoise over the sand of the shallows, blue-black off the shelf. */
function seaColour(depth: number, out: THREE.Color): THREE.Color {
  const d = Math.max(0, depth);
  // (three stops: the wash, a lagoon's depth, the open sea)
  const a = Math.min(1, d / 2.2);
  const b = Math.min(1, Math.max(0, (d - 2.2) / 6.5));
  const c = Math.min(1, Math.max(0, (d - 8.7) / 9));
  out.setRGB(0.075 + (0.028 - 0.075) * a, 0.42 + (0.31 - 0.42) * a, 0.36 + (0.33 - 0.36) * a);
  out.setRGB(out.r + (0.008 - out.r) * b, out.g + (0.115 - out.g) * b, out.b + (0.2 - out.b) * b);
  out.setRGB(out.r + (0.004 - out.r) * c, out.g + (0.036 - out.g) * c, out.b + (0.085 - out.b) * c);
  return out;
}

/**
 * The sea of an island circuit (`TerrainParams.ocean`): one sheet of water at the sea's level, vertex-coloured by the depth of the
 * bed under it, as far as the terrain reaches and a good way beyond. It is cut fine where the colour changes (the shallows: 8 m
 * cells near the circuit, 16 m further off) and coarse where it does not (one quad to a 64 m block of deep water, a few very large
 * ones out to the horizon); a block that is all land has no water at all.
 */
export function buildOcean(ctx: Ctx, reach: number): THREE.Object3D | null {
  const rt = ctx.rt;
  const ocean = rt.def.terrain.ocean;
  if (!ocean) return null;
  const level = ocean.level;
  const b = rt.bounds;
  const B = 64;
  // the part that is looked at closely: the atoll and every islet, with room round them for the shelf
  let nx0 = b.minX - 420;
  let nx1 = b.maxX + 420;
  let nz0 = b.minZ - 420;
  let nz1 = b.maxZ + 420;
  for (const it of ocean.islets ?? []) {
    nx0 = Math.min(nx0, it.x - it.r - 300);
    nx1 = Math.max(nx1, it.x + it.r + 300);
    nz0 = Math.min(nz0, it.z - it.r - 300);
    nz1 = Math.max(nz1, it.z + it.r + 300);
  }
  nx0 = Math.floor(nx0 / B) * B;
  nz0 = Math.floor(nz0 / B) * B;
  const bx = Math.ceil((nx1 - nx0) / B);
  const bz = Math.ceil((nz1 - nz0) / B);
  nx1 = nx0 + bx * B;
  nz1 = nz0 + bz * B;

  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new THREE.Color();
  let n = 0;
  const vert = (x: number, z: number, depth: number): number => {
    pos.push(x, level, z);
    seaColour(depth, c);
    // clear at the wash, opaque once there is some depth
    const a = Math.min(1, Math.max(0, (depth + 0.05) / 0.9));
    col.push(c.r, c.g, c.b, a * a * (3 - 2 * a));
    return n++;
  };
  /** A grid of k x k cells over a square of water, from the depths at its (k + 1)^2 corners. */
  const sheet = (x0: number, z0: number, size: number, k: number, depth: (i: number, j: number) => number): void => {
    const base = n;
    const cs = size / k;
    for (let j = 0; j <= k; j++) for (let i = 0; i <= k; i++) vert(x0 + i * cs, z0 + j * cs, depth(i, j));
    for (let j = 0; j < k; j++) {
      for (let i = 0; i < k; i++) {
        // (a cell with dry land at all four corners has no water)
        if (depth(i, j) < -0.3 && depth(i + 1, j) < -0.3 && depth(i, j + 1) < -0.3 && depth(i + 1, j + 1) < -0.3) continue;
        const a = base + j * (k + 1) + i;
        const d = a + k + 1;
        idx.push(a, d, d + 1, a, d + 1, a + 1);
      }
    }
  };

  // the depths at the corners and the centres of the blocks
  const D = new Float32Array((bx + 1) * (bz + 1));
  for (let j = 0; j <= bz; j++) for (let i = 0; i <= bx; i++) D[j * (bx + 1) + i] = level - rt.heightFast(nx0 + i * B, nz0 + j * B);
  const fine = new Float32Array(9 * 9);
  for (let j = 0; j < bz; j++) {
    for (let i = 0; i < bx; i++) {
      const x0 = nx0 + i * B;
      const z0 = nz0 + j * B;
      const k00 = j * (bx + 1) + i;
      const d00 = D[k00];
      const d10 = D[k00 + 1];
      const d01 = D[k00 + bx + 1];
      const d11 = D[k00 + bx + 2];
      const dc = level - rt.heightFast(x0 + B / 2, z0 + B / 2);
      const lo = Math.min(d00, d10, d01, d11, dc);
      const hi = Math.max(d00, d10, d01, d11, dc);
      // (well above the sea at five points: land)
      if (hi < -1.2) continue;
      if (lo > 3 && hi - lo < 0.9) {
        // deep, level water: one quad
        const base = n;
        vert(x0, z0, d00);
        vert(x0 + B, z0, d10);
        vert(x0, z0 + B, d01);
        vert(x0 + B, z0 + B, d11);
        idx.push(base, base + 2, base + 3, base, base + 3, base + 1);
        continue;
      }
      const near = x0 + B > b.minX - 500 && x0 < b.maxX + 500 && z0 + B > b.minZ - 500 && z0 < b.maxZ + 500;
      const k = near ? 8 : 4;
      const cs = B / k;
      for (let v = 0; v <= k; v++) for (let u = 0; u <= k; u++) fine[v * 9 + u] = level - rt.heightFast(x0 + u * cs, z0 + v * cs);
      sheet(x0, z0, B, k, (u, v) => fine[v * 9 + u]);
    }
  }
  // the open sea round it, out past where the ground ends: the horizon of a sea is a long way off
  const far = reach + 9000;
  const deep = 40;
  const ring: [number, number, number, number][] = [
    [b.minX - far, b.minZ - far, b.maxX + far, nz0],
    [b.minX - far, nz1, b.maxX + far, b.maxZ + far],
    [b.minX - far, nz0, nx0, nz1],
    [nx1, nz0, b.maxX + far, nz1],
  ];
  for (const [x0, z0, x1, z1] of ring) {
    // (cut into pieces a few kilometres long: the fog is worked out per vertex of a transparent sheet nowhere, but the sort is by mesh)
    const sx = Math.max(1, Math.ceil((x1 - x0) / 3000));
    const sz = Math.max(1, Math.ceil((z1 - z0) / 3000));
    for (let j = 0; j < sz; j++) {
      for (let i = 0; i < sx; i++) {
        const base = n;
        const ax = x0 + ((x1 - x0) * i) / sx;
        const bx1 = x0 + ((x1 - x0) * (i + 1)) / sx;
        const az = z0 + ((z1 - z0) * j) / sz;
        const bz1 = z0 + ((z1 - z0) * (j + 1)) / sz;
        vert(ax, az, deep);
        vert(bx1, az, deep);
        vert(ax, bz1, deep);
        vert(bx1, bz1, deep);
        idx.push(base, base + 2, base + 3, base, base + 3, base + 1);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  const p = new Float32Array(pos);
  const nor = new Float32Array(p.length);
  const uv = new Float32Array((p.length / 3) * 2);
  for (let k = 0; k < p.length / 3; k++) {
    nor[k * 3 + 1] = 1;
    uv[k * 2] = p[k * 3];
    uv[k * 2 + 1] = p[k * 3 + 2];
  }
  geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 4));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  // (longer swells than a lake's; and less of a mirror: seen from a car the sea is all at a grazing angle, and a mirror there is the
  // colour of the horizon from shore to shore. The colour of the water is what an island is looked at for.)
  const mesh = new THREE.Mesh(geo, makeWaterMaterial(ctx, 31, 8.7, { env: 0.5, clearcoat: 0.22, roughness: 0.11 }));
  mesh.renderOrder = 5;
  mesh.name = 'sea';
  mesh.receiveShadow = false;
  ctx.disposables.push(geo);
  return mesh;
}

/**
 * The water surface material: two scrolling normal-mapped wave layers (the second on the clearcoat), environment reflections,
 * rougher and greyer in the rain. `scale1` / `scale2` are the wavelengths (m) of the two layers.
 */
export function makeWaterMaterial(ctx: Ctx, scale1: number, scale2: number, look: { env?: number; clearcoat?: number; roughness?: number } = {}): THREE.MeshPhysicalMaterial {
  const envK = look.env ?? 1.25;
  const rough = look.roughness ?? 0.045;
  const n1 = makeWaterNormal(512);
  const n2 = makeWaterNormal(256);
  n1.repeat.set(1 / scale1, 1 / scale1);
  n2.repeat.set(1 / scale2, 1 / scale2);
  ctx.disposables.push(n1, n2);
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    roughness: rough,
    metalness: 0,
    ior: 1.33,
    normalMap: n1,
    normalScale: new THREE.Vector2(0.55, 0.55),
    clearcoat: look.clearcoat ?? 0.6,
    clearcoatRoughness: 0.03,
    clearcoatNormalMap: n2,
    clearcoatNormalScale: new THREE.Vector2(0.4, 0.4),
    envMapIntensity: envK,
  });
  mat.name = 'water';
  mat.userData.wetShader = true; // the listener below handles the rain itself
  let tt = 0;
  ctx.updaters.push((dt) => {
    tt += dt;
    n1.offset.set(tt * 0.011, tt * 0.006);
    n2.offset.set(-tt * 0.017, tt * 0.013);
  });
  ctx.disposables.push(mat);
  ctx.envListeners.push((env) => {
    mat.opacity = 1;
    mat.envMapIntensity = envK * (1 - 0.8 * env.darkness) + 0.15;
    // rain pocks the surface: more chop, a rougher sheen, a greyer body
    mat.normalScale.set(0.55 + 0.7 * env.rain, 0.55 + 0.7 * env.rain);
    mat.clearcoatNormalScale.set(0.4 + 0.6 * env.rain, 0.4 + 0.6 * env.rain);
    mat.roughness = rough + 0.1 * env.rain;
  });
  return mat;
}
