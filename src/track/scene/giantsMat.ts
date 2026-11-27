/**
 * What the old wood is drawn with: the bark (a tile of furrowed, cinnamon-red bark and its relief, made from one height field), the
 * leaf atlas (two pads of foliage, a beard of lichen, a fern), and the three materials.
 *
 * `bark` and `leaf` multiply the sun's light by `aSun`, the share of it each vertex sees past the rest of the wood (giantsShade.ts):
 * the crowns are far above anything the shadow maps hold. `caster` draws nothing: it is the material of the stand-ins that cast the
 * wood's shadows into the cascades (every vertex put outside the view; the shadow pass makes its own depth material from its
 * texture of holes).
 */
import * as THREE from 'three';
import { hash2, mulberry32 } from '../math';
import type { Ctx } from './ctx';
import { coverageMips } from './foliage';
import { HOLES } from './giantsShade';
import { LEAF_TILES } from './giantsTree';
import { sunGlow } from './trees';

// ── the bark ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Value noise that repeats after (px, py) cells: 0..1. */
function pnoise(x: number, y: number, px: number, py: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const h = (a: number, b: number): number => hash2((((a % px) + px) % px) + seed * 131, (((b % py) + py) % py) + seed * 71);
  const a = h(ix, iy);
  const b = h(ix + 1, iy);
  const c = h(ix, iy + 1);
  const d = h(ix + 1, iy + 1);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}

/** The bark as numbers: colour (sRGB bytes) and relief (a tangent-space normal map), both repeating. Headless. */
export function barkPixels(W = 256, H = 512): { color: Uint8Array; normal: Uint8Array; width: number; height: number } {
  const hgt = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const u = i / W;
      const v = j / H;
      // long ridges that wander, part and join, no two as wide as each other: about nine to the tile, and a finer set on their backs
      const warp = (pnoise(u * 3, v * 3, 3, 3, 1) - 0.5) * 0.13 + (pnoise(u * 9, v * 8, 9, 8, 2) - 0.5) * 0.05 + (pnoise(u * 20, v * 24, 20, 24, 8) - 0.5) * 0.016;
      const x = (u + warp) * 9;
      const c = x - Math.floor(x);
      // (a ridge is a wide back between two narrow furrows)
      const ridge = Math.pow(1 - Math.abs(2 * c - 1), 0.42);
      const x2 = (u + warp * 0.5 + (pnoise(u * 6, v * 9, 6, 9, 3) - 0.5) * 0.06) * 23;
      const c2 = x2 - Math.floor(x2);
      const ridge2 = Math.pow(1 - Math.abs(2 * c2 - 1), 0.6);
      // where a ridge has broken across, and the fibres of the bark
      const gap = Math.max(0, pnoise(u * 9 + 0.5, v * 14, 9, 14, 4) - 0.7) * 2.4;
      const f = pnoise(u * 128, v * 16, 128, 16, 5) * 0.2 + pnoise(u * 64, v * 60, 64, 60, 6) * 0.1;
      hgt[j * W + i] = Math.min(1, Math.max(0, 0.56 * ridge + 0.22 * ridge2 - gap + f - 0.08));
    }
  }
  const color = new Uint8Array(W * H * 4);
  const normal = new Uint8Array(W * H * 4);
  const deep = [24, 14, 10];
  const mid = [104, 56, 35];
  const crest = [158, 96, 62];
  const grey = [138, 122, 110];
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const o = j * W + i;
      const h = hgt[o];
      const w = Math.min(1, Math.max(0, (pnoise((i / W) * 4, (j / H) * 5, 4, 5, 7) - 0.4) / 0.35)) * 0.4 * h;
      const sp = 0.9 + 0.2 * hash2(i * 3 + 11, j * 5 + 7);
      // (the furrows are narrow and nearly black, the backs of the ridges take the colour)
      const t = h < 0.34 ? 0 : (h - 0.34) / 0.66;
      for (let k = 0; k < 3; k++) {
        const base = h < 0.34 ? deep[k] + (mid[k] - deep[k]) * Math.pow(h / 0.34, 1.6) : mid[k] + (crest[k] - mid[k]) * t;
        color[o * 4 + k] = Math.min(255, (base + (grey[k] - base) * w) * sp);
      }
      color[o * 4 + 3] = 255;
      const l = hgt[j * W + ((i + W - 1) % W)];
      const r = hgt[j * W + ((i + 1) % W)];
      const d = hgt[((j + H - 1) % H) * W + i];
      const tp = hgt[((j + 1) % H) * W + i];
      const nx = -(r - l) * 4.6;
      const ny = -(tp - d) * 4.6;
      const nl = Math.hypot(nx, ny, 1);
      normal[o * 4] = (nx / nl) * 127.5 + 127.5;
      normal[o * 4 + 1] = (ny / nl) * 127.5 + 127.5;
      normal[o * 4 + 2] = (1 / nl) * 127.5 + 127.5;
      normal[o * 4 + 3] = 255;
    }
  }
  return { color, normal, width: W, height: H };
}

function tiling(data: Uint8Array, w: number, h: number, srgb: boolean, aniso: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  return tex;
}

// ── the leaf atlas ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const TILE = 256;
const GREENS = {
  dark: ['#0b2217', '#0e291a', '#11301e'],
  mid: ['#193e27', '#1d472b', '#224f2f'],
  light: ['#2d5f37', '#36693d', '#407344'],
  hi: ['#56864f', '#639255', '#729c5c'],
};

/** A spray of scale leaves: a slender blade with shorter ones swept forward on both sides of it. */
function spray(g: CanvasRenderingContext2D, x: number, y: number, ang: number, len: number, fill: string): void {
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(len * 0.3, -len * 0.15, len * 0.8, -len * 0.09, len, 0);
  g.bezierCurveTo(len * 0.8, len * 0.09, len * 0.3, len * 0.15, 0, 0);
  g.fill();
  for (let k = 1; k <= 3; k++) {
    const bx = (len * k) / 4.6;
    for (const side of [-1, 1]) {
      g.beginPath();
      g.moveTo(bx, 0);
      g.quadraticCurveTo(bx + len * 0.14, side * len * 0.17, bx + len * 0.36, side * len * 0.26 * (1 - k * 0.14));
      g.lineTo(bx + len * 0.14, 0);
      g.closePath();
      g.fill();
    }
  }
  g.restore();
}

/** A pad of foliage seen from above: a lumpy mass of sprays, each lump darker inside and lighter where its sprays reach the open. */
function paintPad(g: CanvasRenderingContext2D, ox: number, rnd: () => number): void {
  g.save();
  g.beginPath();
  g.rect(ox, 0, TILE, TILE);
  g.clip();
  const cx = ox + TILE / 2;
  const cy = TILE / 2;
  const lumps: [number, number, number][] = [];
  const K = 11 + Math.floor(rnd() * 4);
  for (let k = 0; k < K; k++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * 66;
    lumps.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, 18 + rnd() * 18]);
  }
  const pick = (edge: number): [number, number, number] | null => {
    for (let tries = 0; tries < 24; tries++) {
      const l = lumps[Math.floor(rnd() * K)];
      const a = rnd() * Math.PI * 2;
      const r = l[2] * (edge + (1 - edge) * Math.sqrt(rnd()));
      const x = l[0] + Math.cos(a) * r;
      const y = l[1] + Math.sin(a) * r;
      if (x < ox + 14 || x > ox + TILE - 14 || y < 14 || y > TILE - 14) continue;
      return [x, y, a];
    }
    return null;
  };
  const passes: [string[], number, number, number][] = [
    [GREENS.dark, 430, 1.0, 0],
    [GREENS.mid, 260, 0.95, 0.2],
    [GREENS.light, 150, 0.85, 0.45],
    [GREENS.hi, 46, 0.72, 0.7],
  ];
  for (const [cols, count, sz, edge] of passes) {
    for (let i = 0; i < count; i++) {
      const p = pick(edge);
      if (!p) continue;
      spray(g, p[0], p[1], p[2] + (rnd() - 0.5) * 1.5, (15 + rnd() * 12) * sz, cols[Math.floor(rnd() * cols.length)]);
    }
  }
  g.restore();
}

/** A beard of lichen: pale strands hanging from the top edge, long in the middle, thinning downward. */
function paintBeard(g: CanvasRenderingContext2D, ox: number, rnd: () => number): void {
  g.save();
  g.beginPath();
  g.rect(ox, 0, TILE, TILE);
  g.clip();
  g.lineCap = 'round';
  const cols = ['#5d7559', '#6d8565', '#4e684f', '#80926f', '#657d5e'];
  for (let i = 0; i < 64; i++) {
    const t = rnd();
    const x0 = ox + 12 + (TILE - 24) * t;
    const mid = 1 - Math.abs(t - 0.5) * 1.5;
    const len = (60 + 180 * rnd() * rnd()) * (0.45 + 0.55 * mid);
    let x = x0;
    let y = -2;
    const sway = (rnd() - 0.5) * 16;
    g.strokeStyle = cols[Math.floor(rnd() * cols.length)];
    const w0 = 2.0 + rnd() * 2.2;
    const N = 5;
    for (let k = 0; k < N; k++) {
      const nx = x0 + sway * ((k + 1) / N) + (rnd() - 0.5) * 7;
      const ny = (len * (k + 1)) / N;
      g.lineWidth = w0 * (1 - (0.7 * k) / N);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(nx, ny);
      g.stroke();
      x = nx;
      y = ny;
    }
  }
  g.restore();
}

/** A fern: fronds arching out of one foot at the bottom of the tile, each with its blades on both sides. */
function paintFern(g: CanvasRenderingContext2D, ox: number, rnd: () => number): void {
  g.save();
  g.beginPath();
  g.rect(ox, 0, TILE, TILE);
  g.clip();
  g.lineCap = 'round';
  const cols = ['#18381a', '#234c20', '#2f6127', '#43772f', '#5e8f3c'];
  const fx = ox + TILE / 2;
  const fy = TILE - 4;
  const n = 13;
  // (the fronds at the back first, the upright ones last)
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 1 : -1;
    const lean = side * (1.25 - (1.15 * Math.floor(i / 2)) / (n / 2)) + (rnd() - 0.5) * 0.2;
    const L = 150 + 80 * rnd();
    const tone = Math.min(4, Math.floor((i / n) * 3 + rnd() * 2));
    // the rib: up and out, drooping at the tip
    const ex = fx + Math.sin(lean) * L * 0.52;
    const ey = fy - Math.cos(lean) * L * 0.86;
    const mx = fx + Math.sin(lean) * L * 0.16;
    const my = fy - L * 0.72;
    const at = (t: number): [number, number] => [(1 - t) * (1 - t) * fx + 2 * t * (1 - t) * mx + t * t * ex, (1 - t) * (1 - t) * fy + 2 * t * (1 - t) * my + t * t * ey];
    g.strokeStyle = cols[Math.max(0, tone - 1)];
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(fx, fy);
    g.quadraticCurveTo(mx, my, ex, ey);
    g.stroke();
    g.fillStyle = cols[tone];
    for (let k = 3; k < 30; k++) {
      const t = k / 30;
      const [x, y] = at(t);
      const [x2, y2] = at(t + 0.02);
      const dir = Math.atan2(y2 - y, x2 - x);
      const bl = 30 * Math.sin(Math.PI * Math.min(1, t * 1.08)) ** 0.7 + 4;
      for (const s of [-1, 1]) {
        const a = dir + s * 1.15;
        g.beginPath();
        g.moveTo(x, y);
        g.quadraticCurveTo(x + Math.cos(a - s * 0.3) * bl * 0.6, y + Math.sin(a - s * 0.3) * bl * 0.6 - 1.5, x + Math.cos(a) * bl, y + Math.sin(a) * bl);
        g.quadraticCurveTo(x + Math.cos(a + s * 0.35) * bl * 0.5, y + Math.sin(a + s * 0.35) * bl * 0.5, x + Math.cos(dir) * 5, y + Math.sin(dir) * 5);
        g.closePath();
        g.fill();
      }
    }
  }
  g.restore();
}

/**
 * The canvas as an un-premultiplied RGBA texture whose clear texels carry their tile's mean colour (so that no level of the mip
 * chain turns grey at the cut-out edges) and whose levels keep the coverage of the alpha test (foliage.ts does the same for the
 * game's trees).
 */
function atlasTexture(c: HTMLCanvasElement, tiles: number, aniso: number, cutoff: number): THREE.DataTexture {
  const w = c.width;
  const h = c.height;
  const src = c.getContext('2d')!.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 4);
  const tw = w / tiles;
  for (let t = 0; t < tiles; t++) {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = t * tw; x < (t + 1) * tw; x++) {
        const i = (y * w + x) * 4;
        if (src[i + 3] > 200) {
          sr += src[i];
          sg += src[i + 1];
          sb += src[i + 2];
          n++;
        }
      }
    }
    const mr = n ? sr / n : 40;
    const mg = n ? sg / n : 80;
    const mb = n ? sb / n : 50;
    for (let y = 0; y < h; y++) {
      for (let x = t * tw; x < (t + 1) * tw; x++) {
        const i = (y * w + x) * 4;
        const j = ((h - 1 - y) * w + x) * 4; // (rows flipped: v = 0 is the bottom)
        const a = src[i + 3];
        const k = Math.min(1, a / 72);
        out[j] = mr + (src[i] - mr) * k;
        out[j + 1] = mg + (src[i + 1] - mg) * k;
        out[j + 2] = mb + (src[i + 2] - mb) * k;
        out[j + 3] = a;
      }
    }
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mipmaps = coverageMips(out, w, h, tiles, cutoff);
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  return tex;
}

const ALPHA_TEST = 0.42;

function leafAtlas(aniso: number): THREE.DataTexture {
  const c = document.createElement('canvas');
  c.width = TILE * LEAF_TILES;
  c.height = TILE;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  const rnd = mulberry32(6026);
  paintPad(g, 0, rnd);
  paintPad(g, TILE, rnd);
  paintBeard(g, TILE * 2, rnd);
  paintFern(g, TILE * 3, rnd);
  return atlasTexture(c, LEAF_TILES, aniso, ALPHA_TEST);
}

/** What the stand-in casters are cut with: blotches that let a third of the light through, and one solid texel (the trunks'). */
function holesTexture(): THREE.DataTexture {
  const data = new Uint8Array(HOLES * HOLES * 4).fill(255);
  for (let j = 0; j < HOLES; j++) {
    for (let i = 0; i < HOLES; i++) {
      const n = pnoise(i / 4, j / 4, HOLES / 4, HOLES / 4, 9) * 0.7 + pnoise(i / 2, j / 2, HOLES / 2, HOLES / 2, 10) * 0.3;
      data[(j * HOLES + i) * 4 + 3] = Math.min(255, Math.max(0, (n + 0.1) * 255));
    }
  }
  data[3] = 255;
  const tex = new THREE.DataTexture(data, HOLES, HOLES, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ── the materials ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface GiantMaterials {
  bark: THREE.MeshStandardMaterial;
  leaf: THREE.MeshLambertMaterial;
  caster: THREE.MeshBasicMaterial;
}

const SUN_VERT = '#include <common>\nattribute float aSun;\nvarying float vGiantSun;';
const SUN_FRAG = '#include <common>\nvarying float vGiantSun;';
/** The direct light, times the share of the sun the vertex sees. */
const SUN_APPLY = '#include <lights_fragment_begin>\n  reflectedLight.directDiffuse *= vGiantSun;\n  reflectedLight.directSpecular *= vGiantSun;';

export function makeGiantMaterials(ctx: Ctx): GiantMaterials {
  const aniso = ctx.q.aniso;
  const px = barkPixels();
  const barkMap = tiling(px.color, px.width, px.height, true, aniso);
  const barkNor = tiling(px.normal, px.width, px.height, false, aniso);
  const atlas = leafAtlas(aniso);
  const holes = holesTexture();

  const bark = new THREE.MeshStandardMaterial({ map: barkMap, normalMap: barkNor, normalScale: new THREE.Vector2(1.1, 1.1), vertexColors: true, roughness: 0.93, metalness: 0, envMapIntensity: 0.6 });
  bark.name = 'giantsBark';
  bark.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', SUN_VERT).replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGiantSun = aSun;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', SUN_FRAG).replace('#include <lights_fragment_begin>', SUN_APPLY);
  };
  bark.customProgramCacheKey = () => 'giants-bark-1';

  const uTime = { value: 0 };
  const uSunDir = { value: new THREE.Vector3(0, 1, 0) };
  const uSunCol = { value: new THREE.Vector3(0.3, 0.25, 0.18) };
  // (Lambert, as the game's trees are: no sheen of the sky on cards seen edge on)
  const leaf = new THREE.MeshLambertMaterial({ map: atlas, vertexColors: true, side: THREE.DoubleSide, alphaTest: ALPHA_TEST, alphaToCoverage: true });
  leaf.name = 'giantsLeaf';
  leaf.onBeforeCompile = (shader) => {
    shader.uniforms.uGiantTime = uTime;
    shader.uniforms.uGiantSunDir = uSunDir;
    shader.uniforms.uGiantSunCol = uSunCol;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `${SUN_VERT}\nattribute float aWind;\nuniform float uGiantTime;`)
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
  vGiantSun = aSun;
  {
    // the wind: a slow swing of each pad and beard, by where it hangs
    float ph = position.x * 0.13 + position.z * 0.11;
    transformed.x += sin(uGiantTime * 0.9 + ph) * aWind * 0.5;
    transformed.z += cos(uGiantTime * 0.7 + ph * 1.3) * aWind * 0.4;
  }`,
      );
    shader.fragmentShader = shader.fragmentShader
      // the soft normals of a pad do not depend on which side of a card is seen
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''))
      .replace('#include <common>', `${SUN_FRAG}\nuniform vec3 uGiantSunDir;\nuniform vec3 uGiantSunCol;`)
      .replace('#include <lights_fragment_begin>', SUN_APPLY)
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
{
  // foliage between the eye and the sun glows with the light that comes through it
  vec3 Lv = normalize((viewMatrix * vec4(uGiantSunDir, 0.0)).xyz);
  float back = clamp(-dot(normalize(vViewPosition), Lv), 0.0, 1.0);
  float sunSeen = xrSunVisAt(cameraPosition + (vec4(-vViewPosition, 0.0) * viewMatrix).xyz);
  totalEmissiveRadiance += diffuseColor.rgb * uGiantSunCol * (pow(back, 3.0) * smoothstep(0.02, 0.16, uGiantSunDir.y) * sunSeen * vGiantSun);
}`,
      );
  };
  leaf.customProgramCacheKey = () => 'giants-leaf-1';

  const caster = new THREE.MeshBasicMaterial({ map: holes, alphaTest: 0.5, side: THREE.DoubleSide, colorWrite: false, depthWrite: false });
  caster.name = 'giantsCaster';
  caster.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);');
  };
  caster.customProgramCacheKey = () => 'giants-caster-1';

  ctx.updaters.push((_dt, _camera, time) => {
    uTime.value = time % 3600;
  });
  ctx.envListeners.push((env) => {
    uSunDir.value.copy(env.sunDirection).normalize();
    sunGlow(env.sunIntensity, uSunCol.value);
  });
  ctx.disposables.push(barkMap, barkNor, atlas, holes, bark, leaf, caster);
  return { bark, leaf, caster };
}
