/**
 * Instanced procedural trees.
 *
 *  - Near LOD: lumpy lobes of many small alpha-tested leaf-cluster cards (oak/poplar) or whorls of drooping needle
 *    sprays (pine), with soft spherical normals and baked inner-crown darkening so the crown reads as one lit
 *    volume instead of individual plates.
 *  - Far LOD: three crossed billboards painted from the same silhouettes.
 *  - LODs cross-fade with a screen-door dither (no popping), are distance-culled in the vertex shader, and leaves
 *    glow when the camera looks toward the sun through them (golden-hour translucency).
 *
 * Placement is noise-driven forests that keep clear of the road.
 */
import * as THREE from 'three';
import { Noise2, mulberry32, smoothstep } from '../math';
import type { SpeciesId, VegetationDef } from '../types';
import type { Ctx } from './ctx';
import { yieldFrame } from './ctx';
import { BB_WIDTH, makeBillboardAtlas, makeLeafAtlas, tileU, type FoliageKind } from './foliage';

export interface Inst {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Tree height (m). */
  s: number;
  /** Brightness multiplier. */
  tint: number;
  /** Hue shift -1..1 (yellower / bluer). */
  hue: number;
  /** Width multiplier. */
  w: number;
}

// ── geometry ─────────────────────────────────────────────────────────────────────

class TreeBuf {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  n = 0;
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: number): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(c, c, c);
    return this.n++;
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const CLUSTER_U = [tileU(0), tileU(1)];
const BARK_U0 = tileU(2)[0] + 0.1 / 3;
const BARK_U1 = tileU(2)[1] - 0.02 / 3;

const _up = new THREE.Vector3(0, 1, 0);

function trunk(b: TreeBuf, height: number, r0: number, r1: number, sides: number, segs: number, lean: [number, number] = [0, 0]): void {
  const base = b.n;
  for (let k = 0; k <= segs; k++) {
    const t = k / segs;
    const y = height * t;
    const r = r0 + (r1 - r0) * t;
    const cx = lean[0] * t * t;
    const cz = lean[1] * t * t;
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      b.v(cx + nx * r, y, cz + nz * r, nx, 0.15, nz, BARK_U0 + (BARK_U1 - BARK_U0) * (i / sides), t * 0.8 + 0.1, 0.9);
    }
  }
  const row = sides + 1;
  for (let k = 0; k < segs; k++) {
    for (let i = 0; i < sides; i++) {
      const a = base + k * row + i;
      b.idx.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
}

function branch(b: TreeBuf, from: [number, number, number], to: [number, number, number], r: number): void {
  // thin 4-sided tapered tube
  const dir = new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const len = dir.length();
  dir.normalize();
  const up = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(dir, up).normalize();
  const w = new THREE.Vector3().crossVectors(dir, u).normalize();
  const base = b.n;
  for (let k = 0; k < 2; k++) {
    const p = k === 0 ? from : to;
    const rr = k === 0 ? r : r * 0.35;
    for (let i = 0; i <= 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const nx = Math.cos(a) * u.x + Math.sin(a) * w.x;
      const ny = Math.cos(a) * u.y + Math.sin(a) * w.y;
      const nz = Math.cos(a) * u.z + Math.sin(a) * w.z;
      b.v(p[0] + nx * rr, p[1] + ny * rr, p[2] + nz * rr, nx, ny, nz, BARK_U0 + (BARK_U1 - BARK_U0) * (i / 4), k * Math.min(1, len * 2), 0.85);
    }
  }
  for (let i = 0; i < 4; i++) b.idx.push(base + i, base + i + 1, base + 6 + i, base + i + 1, base + 7 + i, base + 6 + i);
}

/**
 * One leaf card: centre, two in-plane axes (half extents baked in). Lighting normals are soft (pointing away from
 * `ref`, blended toward up) and the vertex colour is `light(p)`.
 */
function card(
  b: TreeBuf,
  c: THREE.Vector3,
  ax: THREE.Vector3,
  ay: THREE.Vector3,
  ref: THREE.Vector3,
  light: (p: THREE.Vector3) => number,
  tile: number,
  flipU: boolean,
  flipV: boolean,
  normalMix: number,
): void {
  const base = b.n;
  const corners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const n = new THREE.Vector3();
  const p = new THREE.Vector3();
  const [u0, u1] = CLUSTER_U[tile];
  for (const [sx, sy] of corners) {
    p.copy(c).addScaledVector(ax, sx).addScaledVector(ay, sy);
    n.copy(p).sub(ref).normalize().multiplyScalar(normalMix);
    n.y += 1 - normalMix; // blend toward up for a soft top-lit canopy
    n.normalize();
    const u = (sx * (flipU ? -1 : 1) + 1) / 2;
    const v = (sy * (flipV ? -1 : 1) + 1) / 2;
    b.v(p.x, p.y, p.z, n.x, n.y, n.z, u0 + (u1 - u0) * u, 0.02 + 0.96 * v, light(p));
  }
  b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function randUnit(rnd: () => number, out: THREE.Vector3): THREE.Vector3 {
  const z = rnd() * 2 - 1;
  const a = rnd() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(a), z, r * Math.sin(a));
}

function cardBasis(normal: THREE.Vector3, half: number, aspect: number, roll: number, ax: THREE.Vector3, ay: THREE.Vector3): void {
  const ref = Math.abs(normal.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  ax.crossVectors(normal, ref).normalize();
  ay.crossVectors(normal, ax).normalize();
  const c = Math.cos(roll);
  const s = Math.sin(roll);
  const rx = ax.clone().multiplyScalar(c).addScaledVector(ay, s);
  const ry = ay.clone().multiplyScalar(c).addScaledVector(ax, -s);
  ax.copy(rx).multiplyScalar(half);
  ay.copy(ry).multiplyScalar(half * aspect);
}

/** Dark low-poly ellipsoid inside a crown: what you see through the gaps between cards (depth instead of sky). */
function core(b: TreeBuf, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, rings: number, segs: number, shade: number): void {
  const [u0, u1] = CLUSTER_U[0];
  // a dense patch of the cluster tile (leaf-filled), sampled as a constant: UV just off the centre
  const u = u0 + (u1 - u0) * 0.43;
  const base = b.n;
  for (let r = 0; r <= rings; r++) {
    const th = (r / rings) * Math.PI;
    const y = Math.cos(th);
    const rr = Math.sin(th);
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const nx = Math.cos(a) * rr;
      const nz = Math.sin(a) * rr;
      const n = new THREE.Vector3(nx / rx, y / ry, nz / rz).normalize();
      b.v(cx + nx * rx, cy + y * ry, cz + nz * rz, n.x, n.y, n.z, u, 0.46, shade * (0.7 + 0.3 * (y * 0.5 + 0.5)));
    }
  }
  const row = segs + 1;
  for (let r = 0; r < rings; r++) {
    for (let i = 0; i < segs; i++) {
      const a = base + r * row + i;
      b.idx.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Geometry for a unit-height tree. `detail` scales the card counts (low tiers use fewer); `close` builds the hero
 * version used within a few tens of metres of the camera: ~2.3x the cards at ~0.72x the size, a thicker leaf shell.
 */
export function treeGeometry(species: SpeciesId, seed: number, detail = 1, close = false): THREE.BufferGeometry {
  const rnd = mulberry32(seed);
  const b = new TreeBuf();
  const ax = new THREE.Vector3();
  const ay = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const ctr = new THREE.Vector3();
  const ref = new THREE.Vector3();
  const crown = new THREE.Vector3();
  const dens = close ? 2.3 : 1;
  const sz = close ? 0.72 : 1;
  const cnt = (n: number) => Math.max(3, Math.round(n * detail * dens));

  if (species === 'oak' || species === 'birch') {
    const birch = species === 'birch';
    const th = birch ? 0.52 : 0.4;
    trunk(b, th * 1.05, birch ? 0.016 : 0.024, birch ? 0.009 : 0.012, close ? 9 : 7, 3, [0.02 * (rnd() - 0.5), 0.02 * (rnd() - 0.5)]);
    const cy = birch ? 0.66 : 0.62;
    const rx = birch ? 0.26 : 0.36;
    const ry = birch ? 0.34 : 0.3;
    crown.set(0, cy, 0);
    // a small dark core: what shows through the gaps between the outer cards is shade, not sky
    core(b, 0, cy + ry * 0.05, 0, rx * 0.3, ry * 0.28, rx * 0.3, 3, 7, 0.1);
    // limbs from the trunk into the crown (seen from below / between the leaves)
    for (let i = 0; i < (close ? 5 : 3); i++) {
      const a = rnd() * Math.PI * 2;
      branch(b, [0, th * 0.85, 0], [Math.cos(a) * rx * 0.6, cy - 0.04 + rnd() * 0.08, Math.sin(a) * rx * 0.6], 0.008);
    }
    // lumpy crown surface: pseudo-noise radius from a few random plane waves
    const waves: [number, number, number, number, number][] = [];
    for (let k = 0; k < 4; k++) {
      const d = randUnit(rnd, new THREE.Vector3()).multiplyScalar(2.4 + 2.2 * rnd());
      waves.push([d.x, d.y, d.z, rnd() * 6.28, 0.14 / (1 + k * 0.55)]);
    }
    const lump = (x: number, y: number, z: number) => {
      let v = 0;
      for (const w of waves) v += w[4] * Math.sin(w[0] * x + w[1] * y + w[2] * z + w[3]);
      return 1 + v;
    };
    const GOLD = 2.399963;
    const nOuter = cnt(175);
    const nInner = cnt(70);
    const phase = rnd() * 6.28;
    for (let i = 0; i < nOuter + nInner; i++) {
      const inner = i >= nOuter;
      const m = inner ? i - nOuter : i;
      const nn0 = inner ? nInner : nOuter;
      // stratified directions with jitter (an exact golden-angle spiral shows up as ribbons at close range)
      const t = (m + 0.15 + 0.7 * rnd()) / nn0;
      const yy = (1 - 2 * t) * 0.97;
      const rr0 = Math.sqrt(1 - yy * yy);
      const az = m * GOLD + phase + (rnd() - 0.5) * (6.28 / Math.sqrt(nn0)) * 1.1;
      nrm.set(Math.cos(az) * rr0, yy, Math.sin(az) * rr0);
      // a thick shell: cards sit anywhere in the outer quarter of the crown so leaves interpenetrate
      const L = lump(nrm.x, nrm.y, nrm.z) * (inner ? 0.42 + 0.3 * rnd() : 0.8 + 0.22 * rnd());
      ctr.set(nrm.x * rx * L, cy + nrm.y * ry * L, nrm.z * rx * L);
      const nn = randUnit(rnd, new THREE.Vector3()).multiplyScalar(0.62).add(nrm).normalize();
      const size = (0.05 + rnd() * 0.04) * sz;
      cardBasis(nn, size, 1, rnd() * Math.PI * 2, ax, ay);
      const valley = clamp01((L - 0.8) / 0.36);
      const depth = inner ? 0.3 + 0.2 * rnd() : 0.55 + 0.45 * clamp01((L - 0.78) / 0.24);
      const ao = depth * (0.62 + 0.38 * valley) * (0.92 + rnd() * 0.16);
      const cyy = cy;
      ref.copy(crown);
      card(b, ctr, ax, ay, ref, (p) => ao * (0.8 + 0.2 * clamp01((p.y - cyy) * 1.5 + 0.5)), rnd() < 0.5 ? 0 : 1, rnd() < 0.5, rnd() < 0.5, 0.85);
    }
  } else if (species === 'poplar') {
    trunk(b, 0.26, 0.016, 0.01, close ? 8 : 6, 2);
    crown.set(0, 0.58, 0);
    core(b, 0, 0.58, 0, 0.04, 0.28, 0.04, 3, 6, 0.25);
    const nOuter = cnt(76);
    const nInner = cnt(18);
    const GOLD = 2.399963;
    for (let i = 0; i < nOuter + nInner; i++) {
      const inner = i >= nOuter;
      const m = inner ? i - nOuter : i;
      const t = (m + 0.15 + 0.7 * rnd()) / (inner ? nInner : nOuter);
      const a = m * GOLD + rnd() * 0.5;
      const hy = 0.17 + 0.8 * t;
      const prof = Math.sin(Math.PI * Math.min(1, Math.max(0, (hy - 0.14) / 0.86)) ** 0.85);
      const rad = (0.03 + 0.12 * prof) * (inner ? 0.5 : 0.8 + 0.24 * rnd());
      ctr.set(Math.cos(a) * rad, hy, Math.sin(a) * rad);
      nrm.set(Math.cos(a), 0.25, Math.sin(a)).normalize();
      nrm.add(randUnit(rnd, new THREE.Vector3()).multiplyScalar(0.55)).normalize();
      cardBasis(nrm, (0.06 + rnd() * 0.03) * sz, 1.3, rnd() * Math.PI * 2, ax, ay);
      ref.set(0, hy - 0.02, 0);
      const shade = (inner ? 0.42 : 0.72 + 0.28 * (rad / 0.15)) * (0.92 + rnd() * 0.16);
      card(b, ctr, ax, ay, ref, (p) => shade * (0.82 + 0.18 * clamp01((p.y - 0.2) * 1.3)), rnd() < 0.5 ? 0 : 1, rnd() < 0.5, rnd() < 0.5, 0.7);
    }
  } else {
    // pine / fir: whorls of drooping needle sprays hinged on the trunk
    trunk(b, 0.96, 0.02, 0.004, close ? 8 : 6, 3);
    const layers = Math.max(6, Math.round(11 * Math.min(1, detail + 0.15) * (close ? 1.5 : 1)));
    const tmpT = new THREE.Vector3();
    for (let l = 0; l < layers; l++) {
      const t = l / (layers - 1);
      const y = 0.12 + 0.85 * t;
      const R = 0.3 * Math.pow(1 - t, 0.95) + 0.03;
      const per = Math.max(4, Math.round((4.4 + 5.6 * (1 - t)) * Math.min(1.15, 0.55 + detail * 0.5) * (close ? 1.55 : 1)));
      for (let k = 0; k < per; k++) {
        const a = ((k + rnd() * 0.6) / per) * Math.PI * 2 + l * 0.9;
        const dx = Math.cos(a);
        const dz = Math.sin(a);
        const len = R * (1.25 + rnd() * 0.2);
        const droop = len * (0.26 + 0.14 * (1 - t) + rnd() * 0.08);
        const half = len * (0.46 + rnd() * 0.12) * (close ? 0.8 : 1);
        const root = ctr.set(0, y + (close ? (rnd() - 0.5) * 0.02 : 0), 0);
        ax.set(dx * len * 0.5, -droop * 0.5, dz * len * 0.5);
        tmpT.set(-dz, 0, dx).multiplyScalar(half).addScaledVector(_up, (rnd() - 0.5) * half * 0.5);
        const c = new THREE.Vector3().copy(root).add(ax);
        ref.set(0, y - 0.1, 0);
        const ao0 = 0.72 + 0.28 * t;
        const shade = ao0 * (0.9 + rnd() * 0.2);
        const Rr = Math.max(0.05, len);
        card(
          b,
          c,
          ax.clone(),
          tmpT.clone(),
          ref,
          (p) => shade * (0.5 + 0.5 * clamp01(Math.hypot(p.x, p.z) / Rr)),
          rnd() < 0.5 ? 0 : 1,
          false,
          rnd() < 0.5,
          0.78,
        );
      }
    }
  }
  return b.build();
}

/** Three crossed unit quads (half width 0.5, base at y = 0) for the far LOD, with rounded soft normals and a baked
 * darker base (the vertical gradient stands in for crown self-shadowing). */
function billboardGeometry(): THREE.BufferGeometry {
  const b = new TreeBuf();
  for (const a of [0, Math.PI / 3, (2 * Math.PI) / 3]) {
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    const base = b.n;
    const corner = (side: number, y: number) => {
      const ny = 0.2 + 0.65 * y;
      const h = 0.7 * side;
      const l = Math.hypot(h, ny);
      b.v(cx * 0.5 * side, y, cz * 0.5 * side, (cx * h) / l, ny / l, (cz * h) / l, side < 0 ? 0 : 1, y, 0.7 + 0.3 * y);
    };
    corner(-1, 0);
    corner(1, 0);
    corner(1, 1);
    corner(-1, 1);
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return b.build();
}

// ── materials ────────────────────────────────────────────────────────────────────

export interface TreeShared {
  uTime: { value: number };
  uCam: { value: THREE.Vector3 };
  /** World-space unit vector toward the sun. */
  uSunDir: { value: THREE.Vector3 };
  /** Linear sun radiance used for the leaf translucency glow. */
  uSunCol: { value: THREE.Vector3 };
}

export function makeShared(): TreeShared {
  return {
    uTime: { value: 0 },
    uCam: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Vector3(0.3, 0.25, 0.18) },
  };
}

/** Sun radiance (for translucency) from the environment: warm white scaled by its intensity. */
export function sunGlow(intensity: number, out: THREE.Vector3): THREE.Vector3 {
  const k = 0.16 * Math.min(6, Math.max(0, intensity));
  return out.set(k, k * 0.82, k * 0.6);
}

/**
 * `fade` = [fadeInStart, fadeInEnd, fadeOutStart, fadeOutEnd] distances (m) from the camera. A LOD is invisible
 * outside [fadeInStart, fadeOutEnd] (collapsed in the vertex shader) and dithers in/out across the two bands.
 */
function foliageMaterial(tex: THREE.Texture, fade: [number, number, number, number], shared: TreeShared, billboard: boolean): THREE.MeshLambertMaterial {
  // Lambert: leaves get no specular term (the Fresnel sheen of a rough standard material reflected the bright sky off
  // grazing cards and made canopies look frosty), and the shader is cheaper for the low tier.
  const mat = new THREE.MeshLambertMaterial({
    map: tex,
    vertexColors: true,
    side: THREE.DoubleSide,
    alphaTest: 0.42,
    alphaToCoverage: true,
    envMapIntensity: 0.9,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uCam = shared.uCam;
    shader.uniforms.uSunDir = shared.uSunDir;
    shader.uniforms.uSunCol = shared.uSunCol;
    shader.uniforms.uFade = { value: new THREE.Vector4(fade[0], fade[1], fade[2], fade[3]) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec3 uCam;\nuniform vec4 uFade;\nvarying float vTreeDist;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec3 iw = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
  float swayPh = iw.x * 0.31 + iw.z * 0.23;
  float swayAmp = smoothstep(0.3, 1.0, position.y) * ${billboard ? '0.0' : '0.02'};
  transformed.x += sin(uTime * 1.6 + swayPh) * swayAmp;
  transformed.z += cos(uTime * 1.2 + swayPh * 1.4) * swayAmp * 0.8;
  vTreeDist = distance(iw, uCam);
#else
  vTreeDist = 0.0;
#endif`,
      )
      .replace('#include <project_vertex>', '#include <project_vertex>\n  if (vTreeDist < uFade.x || vTreeDist >= uFade.w) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);');
    shader.fragmentShader = shader.fragmentShader
      // the soft canopy normals are view-independent: never flip them on back faces (that made neighbouring cards
      // light up or go dark at random, the "crumpled paper" look)
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''))
      .replace('#include <common>', '#include <common>\nuniform vec4 uFade;\nuniform vec3 uSunDir;\nuniform vec3 uSunCol;\nvarying float vTreeDist;')
      .replace(
        '#include <alphatest_fragment>',
        `{
  // screen-door cross-fade between LODs (complementary patterns, so there is never a hole or a double)
  float tn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float fin = smoothstep(uFade.x, uFade.y, vTreeDist);
  float fout = 1.0 - smoothstep(uFade.z, uFade.w, vTreeDist);
  if (tn > fout || (1.0 - tn) > fin) discard;
}
#include <alphatest_fragment>`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  // leaves lit from behind (camera looking toward the sun) glow with transmitted light
  vec3 Lv = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  float back = clamp(-dot(normalize(vViewPosition), Lv), 0.0, 1.0);
  totalEmissiveRadiance += diffuseColor.rgb * uSunCol * (pow(back, 3.0) * smoothstep(0.02, 0.16, uSunDir.y));
}`,
      );
  };
  mat.customProgramCacheKey = () => `tree-${billboard ? 'bb' : 'card'}-5`;
  return mat;
}

// ── scatter ──────────────────────────────────────────────────────────────────────

function scatter(ctx: Ctx, veg: VegetationDef): Record<SpeciesId, Inst[]> {
  const rt = ctx.rt;
  const out: Record<SpeciesId, Inst[]> = { oak: [], poplar: [], pine: [], birch: [] };
  const rnd = mulberry32(rt.def.seed ^ 0x7f4a7c15);
  const noise = new Noise2(rt.def.seed + 5);
  const noise2 = new Noise2(rt.def.seed + 17);
  const b = rt.bounds;
  const margin = veg.reach + rt.maxWall + 20;
  const g = 6.5;
  const lakeLevel = rt.terrain.lakeLevel;
  const scale = ctx.q.trees;
  const totalW = veg.species.reduce((a, s) => a + s[1], 0);
  const pick = (): SpeciesId => {
    let r = rnd() * totalW;
    for (const [id, w] of veg.species) {
      r -= w;
      if (r <= 0) return id;
    }
    return veg.species[0][0];
  };
  const accept0 = (veg.density / 100) * g * g * scale; // probability scale at full forest
  const e = 2.2;
  for (let z = b.minZ - margin; z <= b.maxZ + margin; z += g) {
    for (let x = b.minX - margin; x <= b.maxX + margin; x += g) {
      const px = x + (rnd() - 0.5) * g;
      const pz = z + (rnd() - 0.5) * g;
      const m = rt.stripMargin(px, pz);
      if (m < veg.clearance || m > veg.reach) continue;
      const f = noise.fbm(px / veg.forestScale, pz / veg.forestScale, 3) * 0.7 + noise2.noise(px / (veg.forestScale * 0.31), pz / (veg.forestScale * 0.31)) * 0.3;
      const forest = smoothstep(veg.forestThreshold, veg.forestThreshold + 0.28, f);
      const ramp = smoothstep(veg.clearance, veg.clearance + veg.ramp, m);
      const p = accept0 * (0.04 + 0.96 * forest) * (0.15 + 0.85 * ramp);
      if (rnd() > p) continue;
      const y = rt.fieldHeight(px, pz);
      if (lakeLevel !== null && y < lakeLevel + 0.9) continue;
      const hx = (rt.fieldHeight(px + e, pz) - rt.fieldHeight(px - e, pz)) / (2 * e);
      const hz = (rt.fieldHeight(px, pz + e) - rt.fieldHeight(px, pz - e)) / (2 * e);
      if (Math.hypot(hx, hz) > veg.slopeMax) continue;
      let blocked = false;
      for (const r of ctx.reserved) {
        if (r(px, pz, 5)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        for (const r of ctx.viewReserved) {
          if (r(px, pz, 4.5)) {
            blocked = true;
            break;
          }
        }
      }
      if (blocked) continue;
      let sp = pick();
      // poplars like the water
      if (lakeLevel !== null && y < lakeLevel + 6 && rnd() < 0.5) sp = 'poplar';
      let tint = 0.88 + rnd() * 0.24;
      let hue = (rnd() - 0.5) * 0.2;
      let hmul = sp === 'poplar' ? 1.5 : sp === 'pine' ? 1.15 : 1;
      if (sp === 'birch') {
        // birches share the oak geometry: lighter, yellower and smaller
        sp = 'oak';
        tint = 1.1 + rnd() * 0.2;
        hue = 0.15 + rnd() * 0.15;
        hmul = 0.85;
      }
      const h = veg.scale * (0.72 + rnd() * 0.5) * hmul;
      out[sp].push({ x: px, y: y - 0.12, z: pz, yaw: rnd() * Math.PI * 2, s: h, tint, hue, w: 0.85 + rnd() * 0.35 });
    }
  }
  return out;
}

// ── instancing ───────────────────────────────────────────────────────────────────

export interface TreeSystem {
  group: THREE.Group;
  /** Call every frame with the camera and a time in seconds. */
  update(camera: THREE.Camera, time: number): void;
  setSun(dir: THREE.Vector3, intensity: number, glow?: number): void;
  disposables: Array<{ dispose(): void }>;
}

/** Near-LOD range (m) and card-count factor per quality tier (0 low .. 3 ultra). */
export function treeRanges(tier: number): { r0: number; detail: number } {
  return { r0: [60, 90, 125, 170][tier], detail: [0.5, 0.7, 0.9, 1.1][tier] };
}

const FADE_BAND = 10;
const CLOSE_BAND = 8;

/** Build instanced meshes for hand- or noise-placed trees. */
export function instantiateTrees(inst: Record<SpeciesId, Inst[]>, tier: number, aniso: number, seed = 100): TreeSystem {
  const group = new THREE.Group();
  group.name = 'trees';
  const disposables: Array<{ dispose(): void }> = [];
  const shared = makeShared();
  const { r0, detail } = treeRanges(tier);
  const rC = [0, 0, 36, 48][tier]; // hero ("close") LOD range; none on low / medium
  const cell0 = 96;
  const cellC = 64;
  const cellB = 512;
  const kinds: SpeciesId[] = ['oak', 'poplar', 'pine'];
  const atlasKind: Record<string, FoliageKind> = { oak: 'broad', poplar: 'poplar', pine: 'pine' };
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  interface LodMesh {
    mesh: THREE.InstancedMesh;
    center: THREE.Vector3;
    r: number;
    far: boolean;
    close?: boolean;
  }
  const lodMeshes: LodMesh[] = [];
  let seedBase = seed;

  // far LOD: one atlas for the three silhouettes, three crossed quads per tree
  const bbAtlas = makeBillboardAtlas(Math.min(aniso, 4));
  const bbMat = foliageMaterial(bbAtlas, [r0 - FADE_BAND, r0, 1e8, 1e9], shared, true);
  const bbPrev = bbMat.onBeforeCompile;
  bbMat.onBeforeCompile = (shader, renderer) => {
    bbPrev(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aBB;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv = vMapUv * aBB.zw + aBB.xy;\n#endif');
  };
  bbMat.customProgramCacheKey = () => 'tree-bb-atlas-5';
  const geoB = billboardGeometry();
  disposables.push(bbAtlas, bbMat, geoB);

  const place = (mesh: THREE.InstancedMesh, list: Inst[], wMul = 1) => {
    list.forEach((t, i) => {
      q.setFromAxisAngle(up, t.yaw);
      sc.set(t.s * t.w * wMul, t.s, t.s * t.w * wMul);
      pos.set(t.x, t.y, t.z);
      m4.compose(pos, q, sc);
      mesh.setMatrixAt(i, m4);
      col.setRGB(t.tint * (1 + t.hue * 0.55), t.tint, t.tint * (1 - t.hue * 0.7));
      mesh.setColorAt(i, col);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  };
  const cellsOf = <T extends { x: number; z: number }>(list: T[], cell: number) => {
    const cells = new Map<string, T[]>();
    for (const t of list) {
      const key = `${Math.floor(t.x / cell)}_${Math.floor(t.z / cell)}`;
      let a = cells.get(key);
      if (!a) cells.set(key, (a = []));
      a.push(t);
    }
    return cells;
  };

  // near LOD per species
  for (const sp of kinds) {
    const list = inst[sp];
    if (!list.length) continue;
    const atlas = makeLeafAtlas(atlasKind[sp], aniso);
    const geos = sp === 'poplar' ? [treeGeometry(sp, seedBase++, detail)] : [treeGeometry(sp, seedBase++, detail), treeGeometry(sp, seedBase++, detail)];
    const mat = foliageMaterial(atlas, rC ? [rC - CLOSE_BAND, rC, r0 - FADE_BAND, r0] : [-30, -10, r0 - FADE_BAND, r0], shared, false);
    disposables.push(atlas, mat, ...geos);
    if (rC) {
      const geoC = treeGeometry(sp, seedBase++, detail, true);
      const matC = foliageMaterial(atlas, [-30, -10, rC - CLOSE_BAND, rC], shared, false);
      disposables.push(geoC, matC);
      for (const [key, arr] of cellsOf(list, cellC)) {
        const mesh = new THREE.InstancedMesh(geoC, matC, arr.length);
        place(mesh, arr);
        mesh.boundingSphere!.radius += 20;
        mesh.castShadow = false; // the regular near LOD casts for it
        mesh.receiveShadow = true;
        mesh.name = `tree0c_${sp}_${key}`;
        group.add(mesh);
        lodMeshes.push({ mesh, center: mesh.boundingSphere!.center.clone(), r: mesh.boundingSphere!.radius, far: false, close: true });
      }
    }
    for (const [key, arr] of cellsOf(list, cell0)) {
      const variants: Inst[][] = geos.map(() => []);
      arr.forEach((t, i) => variants[i % geos.length].push(t));
      variants.forEach((vs, vi) => {
        if (!vs.length) return;
        const mesh = new THREE.InstancedMesh(geos[vi], mat, vs.length);
        place(mesh, vs);
        mesh.boundingSphere!.radius += 28;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = `tree0_${sp}_${key}_${vi}`;
        group.add(mesh);
        lodMeshes.push({ mesh, center: mesh.boundingSphere!.center.clone(), r: mesh.boundingSphere!.radius, far: false });
      });
    }
  }

  // far LOD: one instanced mesh per cell for all species
  const allTrees: { x: number; z: number; t: Inst; sp: number }[] = [];
  kinds.forEach((k, ki) => inst[k].forEach((t) => allTrees.push({ x: t.x, z: t.z, t, sp: ki })));
  for (const [key, arr] of cellsOf(allTrees, cellB)) {
    const g = geoB.clone();
    const rect = new Float32Array(arr.length * 4);
    const mesh = new THREE.InstancedMesh(g, bbMat, arr.length);
    const widthOf = [BB_WIDTH.broad, BB_WIDTH.poplar, BB_WIDTH.pine];
    arr.forEach((e, i) => {
      q.setFromAxisAngle(up, e.t.yaw);
      const wm = widthOf[e.sp] * e.t.w;
      sc.set(e.t.s * wm, e.t.s, e.t.s * wm);
      pos.set(e.t.x, e.t.y, e.t.z);
      m4.compose(pos, q, sc);
      mesh.setMatrixAt(i, m4);
      col.setRGB(e.t.tint * (1 + e.t.hue * 0.55), e.t.tint, e.t.tint * (1 - e.t.hue * 0.7));
      mesh.setColorAt(i, col);
      const inset = 0.02 / 3;
      rect[i * 4] = e.sp / 3 + inset;
      rect[i * 4 + 1] = 0;
      rect[i * 4 + 2] = 1 / 3 - inset * 2;
      rect[i * 4 + 3] = 1;
    });
    g.setAttribute('aBB', new THREE.InstancedBufferAttribute(rect, 4));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.boundingSphere!.radius += 40;
    mesh.receiveShadow = false;
    mesh.name = `treeB_${key}`;
    group.add(mesh);
    disposables.push(g);
    lodMeshes.push({ mesh, center: mesh.boundingSphere!.center.clone(), r: mesh.boundingSphere!.radius, far: true });
  }

  const camPos = new THREE.Vector3();
  return {
    group,
    disposables,
    update(camera, time) {
      shared.uTime.value = time;
      camPos.copy(camera.position);
      shared.uCam.value.copy(camPos);
      for (const m of lodMeshes) {
        const d = camPos.distanceTo(m.center);
        if (m.close) {
          m.mesh.visible = d - m.r < rC + 4;
          continue;
        }
        m.mesh.visible = m.far ? d + m.r > r0 - FADE_BAND : d - m.r < r0 + 4;
        // only trees whose (long, low-sun) shadows can reach the track area cast into the shadow cascades
        if (!m.far) m.mesh.castShadow = d - m.r < 100;
      }
    },
    setSun(dir, intensity, glow = 1) {
      shared.uSunDir.value.copy(dir).normalize();
      sunGlow(intensity * glow, shared.uSunCol.value);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export async function buildTrees(ctx: Ctx): Promise<THREE.Group | null> {
  const veg = ctx.rt.def.scenery?.vegetation;
  if (!veg || ctx.q.trees < 0.05) return null;
  const inst = scatter(ctx, veg);
  ctx.progress(0.7, 'trees');
  await yieldFrame();
  const sys = instantiateTrees(inst, ctx.q.tier, ctx.q.aniso, 100);
  ctx.disposables.push(...sys.disposables);
  ctx.updaters.push((_dt, camera, time) => sys.update(camera, time));
  ctx.envListeners.push((env) => sys.setSun(env.sunDirection, env.sunIntensity));
  return sys.group;
}
