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

/**
 * The water surface material: two scrolling normal-mapped wave layers (the second on the clearcoat), environment reflections,
 * rougher and greyer in the rain. `scale1` / `scale2` are the wavelengths (m) of the two layers.
 */
export function makeWaterMaterial(ctx: Ctx, scale1: number, scale2: number): THREE.MeshPhysicalMaterial {
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
    roughness: 0.045,
    metalness: 0,
    ior: 1.33,
    normalMap: n1,
    normalScale: new THREE.Vector2(0.55, 0.55),
    clearcoat: 0.6,
    clearcoatRoughness: 0.03,
    clearcoatNormalMap: n2,
    clearcoatNormalScale: new THREE.Vector2(0.4, 0.4),
    envMapIntensity: 1.25,
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
    mat.envMapIntensity = 1.25 * (1 - 0.8 * env.darkness) + 0.15;
    // rain pocks the surface: more chop, a rougher sheen, a greyer body
    mat.normalScale.set(0.55 + 0.7 * env.rain, 0.55 + 0.7 * env.rain);
    mat.clearcoatNormalScale.set(0.4 + 0.6 * env.rain, 0.4 + 0.6 * env.rain);
    mat.roughness = 0.045 + 0.1 * env.rain;
  });
  return mat;
}
