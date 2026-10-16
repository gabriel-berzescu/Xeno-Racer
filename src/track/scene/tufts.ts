/**
 * Grass tufts: crossed alpha-tested blade clumps scattered on the grass near the camera (high / ultra). They are
 * generated lazily per 48 m cell the first time the camera gets near it (deterministic, so a cell always comes back
 * the same), drawn as one instanced mesh per cell, and faded out with distance in the vertex shader.
 *
 * The tuft takes its colour from the same large-scale grass colour function as the terrain shader, so it blends
 * into the ground instead of looking like a pasted sprite.
 */
import * as THREE from 'three';
import { mulberry32, smoothstep } from '../math';
import type { GroundSample, TrackPoint } from '../../core/contracts';
import type { Ctx } from './ctx';
import { makeTuftTexture } from './foliage';
import { GRASS_MACRO_GLSL, grassTint } from './terrainMat';

const CELL = 48;
const MAX_CELLS = 70;
/** Per-frame time budget (ms) for generating tuft cells. */
const BUDGET_MS = 1.1;

function tuftGeometry(): THREE.BufferGeometry {
  // three vertical quads at 0 / 60 / 120 degrees, 0.62 m wide, 0.46 m tall
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let n = 0;
  for (const a of [0, Math.PI / 3, (2 * Math.PI) / 3]) {
    const dx = Math.cos(a) * 0.31;
    const dz = Math.sin(a) * 0.31;
    pos.push(-dx, 0, -dz, dx, 0, dz, dx, 0.46, dz, -dx, 0.46, -dz);
    for (let i = 0; i < 4; i++) nor.push(0, 1, 0);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
    n += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export function buildTufts(ctx: Ctx): THREE.Group | null {
  if (!ctx.q.tufts) return null;
  const rt = ctx.rt;
  const group = new THREE.Group();
  group.name = 'tufts';
  const range = ctx.q.tier >= 3 ? 58 : 40;
  const tex = makeTuftTexture(Math.min(8, ctx.q.aniso));
  const geo = tuftGeometry();
  const shared = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() } };
  const mat = new THREE.MeshLambertMaterial({ map: tex, vertexColors: false, side: THREE.DoubleSide, alphaTest: 0.5, alphaToCoverage: true, envMapIntensity: 0.9 });
  const tint = grassTint(ctx);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uCam = shared.uCam;
    shader.uniforms.uRange = { value: new THREE.Vector2(range - 12, range) };
    shader.uniforms.uNoise = { value: ctx.tex.noise };
    shader.uniforms.uAvgGrass = { value: ctx.tex.moss.avg.clone() };
    shader.uniforms.uTint = { value: tint };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec3 uCam;\nuniform vec2 uRange;\nvarying vec3 vWorld;\nvarying float vFade;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 iw = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
  float dist = distance(iw, uCam);
  vFade = 1.0 - smoothstep(uRange.x, uRange.y, dist);
  transformed.y *= vFade;
  float sway = smoothstep(0.1, 0.46, position.y) * 0.035;
  transformed.x += sin(uTime * 1.9 + iw.x * 0.9 + iw.z * 0.7) * sway;
  transformed.z += cos(uTime * 1.5 + iw.x * 0.6 + iw.z * 1.1) * sway * 0.8;
  vWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
#else
  vFade = 1.0;
  vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif`,
      )
      .replace('#include <project_vertex>', '#include <project_vertex>\n  if (vFade <= 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''))
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uNoise;
uniform vec3 uAvgGrass;
uniform vec3 uTint;
varying vec3 vWorld;
varying float vFade;
${GRASS_MACRO_GLSL}`,
      )
      .replace(
        '#include <map_fragment>',
        `{
  vec4 tx = texture2D(map, vMapUv);
  diffuseColor.a *= tx.a;
  vec2 wuv = vWorld.xz;
  vec2 ruv = mat2(0.8, -0.6, 0.6, 0.8) * wuv;
  vec4 n0 = texture2D(uNoise, wuv * 0.00093 + 0.13);
  vec4 n1 = texture2D(uNoise, wuv * 0.0037 + 0.31);
  vec4 n2 = texture2D(uNoise, wuv * 0.0173 + 0.62);
  vec4 n3 = texture2D(uNoise, wuv * 0.057 + 0.77);
  vec4 n5 = texture2D(uNoise, ruv * 0.113 + 0.7);
  vec3 ground = uAvgGrass * xrGrassMacro(n0, n1, n2, n3, uTint);
  float shade = 0.34 + tx.r * 0.95;
  diffuseColor.rgb = ground * shade * (0.88 + 0.24 * n5.g) * vec3(1.0, 1.0, 0.92) * diffuse; // diffuse = the (wet-tinted) material colour
}`,
      );
  };
  mat.customProgramCacheKey = () => 'tuft-2';
  ctx.disposables.push(tex, geo, mat);
  // a hidden stand-in set up like the real cells: they are only generated around the camera once frames run, after
  // the loading screen, so without it the renderer's precompile never reaches the tuft program
  const warm = new THREE.InstancedMesh(geo, mat, 1);
  warm.setColorAt(0, new THREE.Color(1, 1, 1));
  warm.castShadow = false;
  warm.receiveShadow = true;
  warm.visible = false;
  warm.name = 'tufts_warmup';
  group.add(warm);

  interface Cell {
    key: number;
    ix: number;
    iz: number;
    mesh: THREE.InstancedMesh | null;
    last: number;
    done: boolean;
    /** Next row to generate, and the candidates found so far (x, y, z, r2, r3 per tuft). */
    row: number;
    items: number[];
    rnd: () => number;
  }
  const cells = new Map<number, Cell>();
  const list: Cell[] = [];
  const g: GroundSample = { height: 0, normal: new THREE.Vector3(), surface: 'grass' };
  const tp = {} as TrackPoint;
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  const mown = rt.def.mowing !== false;
  const lake = rt.terrain.lakeLevel;
  const b = rt.bounds;
  const pad = 130 + rt.maxWall;
  const STEP = 1.25;
  const ROWS = Math.ceil(CELL / STEP);
  let frame = 0;
  let hint = -1;

  /** Generate one row of candidates of a cell (deterministic: the RNG stream is consumed in a fixed order). */
  const genRow = (c: Cell): void => {
    const rnd = c.rnd;
    const z = c.iz * CELL + c.row * STEP;
    for (let x = c.ix * CELL; x < (c.ix + 1) * CELL; x += STEP) {
      const px = x + rnd() * STEP;
      const pz = z + rnd() * STEP;
      const r1 = rnd();
      const r2 = rnd();
      const r3 = rnd();
      rt.project(px, pz, tp, hint);
      hint = tp.segment;
      const wall = tp.d >= 0 ? tp.wallLeft : tp.wallRight;
      const beyond = Math.abs(tp.d) - wall; // metres beyond the barrier line (negative = between road and barrier)
      if (beyond > 62 || Math.abs(beyond) < 0.5) continue;
      // a city: the sidewalks and the built-up ground grow no grass
      if (rt.def.paved && beyond < 12) continue;
      if (ctx.urban && ctx.urban(px, pz) > 0.15) continue;
      // density: managed (mown) ground near the circuit stays short; wild verges grow right up to the barriers
      let k: number;
      if (mown) k = smoothstep(7, 26, beyond);
      else k = beyond < -0.5 ? 0.5 : smoothstep(-0.5, 2.5, beyond);
      if (r1 > k * 0.92) continue;
      let blocked = false;
      for (let i = 0; i < ctx.reserved.length; i++) {
        if (ctx.reserved[i](px, pz, 1.2)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      rt.groundAt(px, pz, g, hint);
      if (g.surface !== 'grass' || g.normal.y < 0.82) continue;
      if (lake !== null && g.height < lake + 0.5) continue;
      c.items.push(px, g.height - 0.015, pz, r2, r3);
    }
    c.row++;
  };

  const finish = (c: Cell): void => {
    c.done = true;
    const items = c.items;
    const n = items.length / 5;
    c.items = [];
    if (!n) return;
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    for (let i = 0; i < n; i++) {
      const j = i * 5;
      q.setFromAxisAngle(up, items[j + 3] * Math.PI * 2);
      const s = 0.6 + items[j + 4] * 0.9;
      sc.set(s * (0.9 + 0.3 * items[j + 3]), s * (0.8 + 0.5 * items[j + 4]), s * (0.9 + 0.3 * items[j + 3]));
      pos.set(items[j], items[j + 1], items[j + 2]);
      m4.compose(pos, q, sc);
      mesh.setMatrixAt(i, m4);
      const v = 0.9 + 0.2 * ((items[j + 3] * 7.31) % 1);
      col.setRGB(v, v, v);
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.boundingSphere!.radius += 1;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.visible = false;
    mesh.name = `tufts_${c.ix}_${c.iz}`;
    c.mesh = mesh;
    group.add(mesh);
  };

  const rShow = range + CELL * 0.71;
  const rPre = rShow + CELL;
  const near = new THREE.Vector3();
  // debugging / test hook: number of cells inside the visible radius that are still being generated
  group.userData.pending = (): number => {
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.done || c.last !== frame) continue;
      const dx = (c.ix + 0.5) * CELL - near.x;
      const dz = (c.iz + 0.5) * CELL - near.z;
      if (dx * dx + dz * dz <= rShow * rShow) n++;
    }
    return n;
  };
  ctx.updaters.push((_dt, camera, time) => {
    shared.uTime.value = time;
    const cp = camera.position;
    shared.uCam.value.copy(cp);
    frame++;
    if (cp.x < b.minX - pad || cp.x > b.maxX + pad || cp.z < b.minZ - pad || cp.z > b.maxZ + pad) {
      for (let i = 0; i < list.length; i++) if (list[i].mesh) list[i].mesh!.visible = false;
      return;
    }
    near.copy(cp);
    const ix0 = Math.floor((cp.x - rPre) / CELL);
    const ix1 = Math.floor((cp.x + rPre) / CELL);
    const iz0 = Math.floor((cp.z - rPre) / CELL);
    const iz1 = Math.floor((cp.z + rPre) / CELL);
    // register the cells around the camera (cheap), then spend the frame budget on the nearest unfinished ones
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = (ix + 0.5) * CELL - cp.x;
        const dz = (iz + 0.5) * CELL - cp.z;
        if (dx * dx + dz * dz > rPre * rPre) continue;
        const key = (ix + 16384) * 32768 + (iz + 16384); // numeric key: no string allocation per frame
        let c = cells.get(key);
        if (!c) {
          c = { key, ix, iz, mesh: null, last: frame, done: false, row: 0, items: [], rnd: mulberry32(((ix * 73856093) ^ (iz * 19349663) ^ rt.def.seed) >>> 0) };
          cells.set(key, c);
          list.push(c);
        }
        c.last = frame;
      }
    }
    let t0 = -1;
    for (;;) {
      let best: Cell | null = null;
      let bd = Infinity;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c.done || c.last !== frame) continue;
        const dx = (c.ix + 0.5) * CELL - cp.x;
        const dz = (c.iz + 0.5) * CELL - cp.z;
        const d = dx * dx + dz * dz;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      if (!best) break; // idle frames never touch the clock
      if (t0 < 0) t0 = performance.now();
      else if (performance.now() - t0 > BUDGET_MS) break;
      genRow(best);
      if (best.row >= ROWS) finish(best);
    }
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.mesh) continue;
      const dx = (c.ix + 0.5) * CELL - cp.x;
      const dz = (c.iz + 0.5) * CELL - cp.z;
      c.mesh.visible = c.last === frame && dx * dx + dz * dz <= rShow * rShow;
    }
    // drop the least recently used cells
    while (list.length > MAX_CELLS) {
      let oi = -1;
      for (let i = 0; i < list.length; i++) if (list[i].last < frame && (oi < 0 || list[i].last < list[oi].last)) oi = i;
      if (oi < 0) break;
      const c = list[oi];
      list.splice(oi, 1);
      cells.delete(c.key);
      if (c.mesh) {
        group.remove(c.mesh);
        c.mesh.dispose();
      }
    }
  });
  return group;
}
