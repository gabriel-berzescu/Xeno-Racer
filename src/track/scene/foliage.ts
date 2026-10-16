/**
 * Procedural foliage textures: leaf-cluster / needle-spray cut-outs, bark, and whole-tree billboards.
 *
 * Everything is uploaded as un-premultiplied RGBA DataTextures: the colour of fully transparent texels is the
 * tile's average leaf colour, so mip levels never turn grey or dark at the cut-out edges (canvas textures
 * premultiply, which is what made distant canopies look frosty).
 */
import * as THREE from 'three';
import { mulberry32 } from '../math';

export type FoliageKind = 'broad' | 'pine' | 'poplar' | 'palm' | 'spruce' | 'bare';

export const TILE = 256;
/** Atlas layout: [cluster A | cluster B | bark]. */
export const TILES = 3;

/** u range of tile i inside the atlas, inset so bilinear taps never reach the neighbour. */
export function tileU(i: number, inset = 0.03): [number, number] {
  const w = 1 / TILES;
  return [i * w + w * inset, (i + 1) * w - w * inset];
}

type Pal = { dark: string[]; mid: string[]; light: string[]; hi: string[]; rib: string };

const PAL: Record<FoliageKind, Pal> = {
  broad: {
    dark: ['#10230a', '#142a0c', '#192f0f'],
    mid: ['#1f4313', '#254a14', '#2b5117'],
    light: ['#355a1c', '#3d6320', '#466b23'],
    hi: ['#587a27', '#648329', '#6f8630'],
    rib: 'rgba(190,215,120,0.16)',
  },
  poplar: {
    dark: ['#183410', '#1c3c12', '#224414'],
    mid: ['#2c5419', '#335c1b', '#3a661e'],
    light: ['#46712a', '#507d2c', '#5a8832'],
    hi: ['#6e9433', '#7aa03a', '#86a941'],
    rib: 'rgba(215,235,160,0.18)',
  },
  pine: {
    dark: ['#091c10', '#0b2213', '#0d2916'],
    mid: ['#102f19', '#133620', '#173e23'],
    light: ['#1b4426', '#204c2a', '#265531'],
    hi: ['#33603c', '#3b6a43', '#44744b'],
    rib: 'rgba(0,0,0,0)',
  },
  // winter conifers: a cold blue-green under the snow
  spruce: {
    dark: ['#08181a', '#0a1d1c', '#0c2320'],
    mid: ['#0f2c2a', '#123430', '#16392f'],
    light: ['#1b4339', '#214c3e', '#285544'],
    hi: ['#356055', '#3d6a5d', '#467363'],
    rib: 'rgba(0,0,0,0)',
  },
  // bare birch twigs: grey-brown, a pale lichen on the light side
  bare: {
    dark: ['#3a332f', '#403935', '#463e39'],
    mid: ['#665c55', '#6d635b', '#746961'],
    light: ['#9b9087', '#a2978d', '#a99e94'],
    hi: ['#cfc7bd', '#d6cec4', '#ddd5cb'],
    rib: 'rgba(0,0,0,0)',
  },
  // date palms: yellower, drier greens than the broadleaves
  palm: {
    dark: ['#1a3410', '#203c12', '#264416'],
    mid: ['#3a6a1c', '#41731f', '#497c22'],
    light: ['#62902c', '#6c9a30', '#76a236'],
    hi: ['#9bbd45', '#a5c34c', '#b0c957'],
    rib: 'rgba(214,226,150,0.5)',
  },
};

function mk(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

/** Canvas (tiles side by side) -> un-premultiplied RGBA DataTexture with dilated colours and a mip chain. */
function toDataTexture(c: HTMLCanvasElement, tiles: number, aniso: number): THREE.DataTexture {
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
    const mr = n ? sr / n : 60;
    const mg = n ? sg / n : 90;
    const mb = n ? sb / n : 40;
    for (let y = 0; y < h; y++) {
      for (let x = t * tw; x < (t + 1) * tw; x++) {
        const i = (y * w + x) * 4;
        const j = ((h - 1 - y) * w + x) * 4; // flip rows: v = 0 is the bottom, like canvas textures
        const a = src[i + 3];
        const k = Math.min(1, a / 72); // rim pixels: un-premultiplied colours are noisy, ease toward the mean
        out[j] = mr + (src[i] - mr) * k;
        out[j + 1] = mg + (src[i + 1] - mg) * k;
        out[j + 2] = mb + (src[i + 2] - mb) * k;
        out[j + 3] = a;
      }
    }
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  return tex;
}

// ── leaves & needles ─────────────────────────────────────────────────────────────

function leaf(g: CanvasRenderingContext2D, x: number, y: number, ang: number, len: number, wid: number, fill: string, rib: string): void {
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(len * 0.2, -wid, len * 0.7, -wid * 0.8, len, 0);
  g.bezierCurveTo(len * 0.7, wid * 0.8, len * 0.2, wid, 0, 0);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  g.strokeStyle = rib;
  g.lineWidth = Math.max(0.7, wid * 0.09);
  g.beginPath();
  g.moveTo(len * 0.06, 0);
  g.lineTo(len * 0.86, 0);
  g.stroke();
  g.restore();
}

/** A branchlet of leaves: irregular lumpy silhouette, dense dark interior, lighter leaf tops. */
function broadCluster(g: CanvasRenderingContext2D, ox: number, rnd: () => number, pal: Pal, scale: number): void {
  g.save();
  g.beginPath();
  g.rect(ox, 0, TILE, TILE);
  g.clip();
  const cx = ox + TILE / 2;
  const cy = TILE / 2;
  const circles: [number, number, number][] = [];
  const K = 9 + ((rnd() * 4) | 0);
  for (let k = 0; k < K; k++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * 58;
    circles.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.9, 20 + rnd() * 18]);
  }
  const pick = (): [number, number, number] | null => {
    for (let tries = 0; tries < 24; tries++) {
      const x = cx + (rnd() * 2 - 1) * 108;
      const y = cy + (rnd() * 2 - 1) * 108;
      for (const c of circles) {
        const dx = x - c[0];
        const dy = y - c[1];
        if (dx * dx + dy * dy < c[2] * c[2]) return [x, y, Math.atan2(dy, dx)];
      }
    }
    return null;
  };
  const passes: [string[], number, number][] = [
    [pal.dark, 300, 1.0],
    [pal.mid, 150, 0.95],
    [pal.light, 95, 0.9],
    [pal.hi, 30, 0.8],
  ];
  for (const [cols, count, sz] of passes) {
    for (let i = 0; i < count; i++) {
      const p = pick();
      if (!p) continue;
      const len = (19 + rnd() * 13) * sz * scale;
      const wid = len * (0.4 + rnd() * 0.14);
      leaf(g, p[0], p[1], p[2] + (rnd() - 0.5) * 1.7, len, wid, cols[(rnd() * cols.length) | 0], pal.rib);
    }
  }
  g.restore();
}

/** A fir branchlet: central twig along +x with drooping herringbone needles (tip at the right). */
function pineFrond(g: CanvasRenderingContext2D, ox: number, rnd: () => number, pal: Pal, tilt: number): void {
  g.save();
  g.beginPath();
  g.rect(ox, 0, TILE, TILE);
  g.clip();
  const x0 = ox + 8;
  const x1 = ox + TILE - 10;
  const cy = TILE / 2;
  const twigY = (t: number) => cy + Math.sin(t * Math.PI) * tilt * -10 + t * tilt * 6;
  g.lineCap = 'round';
  // twig
  g.strokeStyle = '#2b1f16';
  g.lineWidth = 3.2;
  g.beginPath();
  g.moveTo(x0, twigY(0));
  for (let k = 1; k <= 12; k++) g.lineTo(x0 + ((x1 - x0) * k) / 12, twigY(k / 12));
  g.stroke();
  const passes: [string[], number, number][] = [
    [pal.dark, 3.6, 1.0],
    [pal.mid, 2.6, 0.92],
    [pal.light, 1.9, 0.8],
    [pal.hi, 1.5, 0.52],
  ];
  const N = 78;
  for (const [cols, width, lenMul] of passes) {
    g.lineWidth = width;
    for (let i = 0; i < N; i++) {
      const t = (i + rnd()) / N;
      const bx = x0 + (x1 - x0) * t;
      const by = twigY(t);
      const taper = 1 - Math.pow(t, 1.25) * 0.82;
      for (const side of [-1, 1]) {
        if (lenMul < 0.7 && rnd() < 0.55) continue;
        const L = (86 * taper + 8) * lenMul * (0.78 + rnd() * 0.42);
        const ang = side * (1.12 - 0.5 * t) + (rnd() - 0.5) * 0.34 + (tilt * 0.12);
        // needles sweep forward (toward the tip): direction = (cos a, sin a) with a measured from +x
        const ex = bx + Math.cos(ang) * L;
        const ey = by + Math.sin(ang) * L;
        g.strokeStyle = cols[(rnd() * cols.length) | 0];
        g.beginPath();
        g.moveTo(bx, by);
        g.quadraticCurveTo(bx + Math.cos(ang * 0.7) * L * 0.55, by + Math.sin(ang * 0.7) * L * 0.55 + side * 3, ex, ey + 6 * Math.abs(side));
        g.stroke();
      }
    }
  }
  g.restore();
}

/** Snow lying on a twig: a white lumpy ridge on the upper side, a blue-grey shade under it, a few crystals of light on top. */
function snowOnTwig(g: CanvasRenderingContext2D, rnd: () => number, x0: number, x1: number, twigY: (t: number) => number, lumps: number, thick: number): void {
  for (let k = 0; k < lumps; k++) {
    const t = (k + rnd() * 0.8) / lumps;
    const x = x0 + (x1 - x0) * t;
    const y = twigY(t) - 3 - rnd() * 4;
    const w = (14 + 30 * (1 - t * 0.7)) * (0.7 + 0.6 * rnd()) * thick;
    const h = (6 + 11 * (1 - t * 0.6)) * (0.7 + 0.6 * rnd()) * thick;
    g.fillStyle = '#9fb0cc';
    g.beginPath();
    g.ellipse(x + 2, y + h * 0.35, w * 0.5, h * 0.8, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#eef3fb';
    g.beginPath();
    g.ellipse(x, y, w * 0.5, h * 0.8, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.ellipse(x - w * 0.06, y - h * 0.22, w * 0.32, h * 0.42, 0, 0, Math.PI * 2);
    g.fill();
  }
}

/** A snow-laden fir branchlet: the needle spray of a pine frond, dark and blue-green, with snow lying along its twig and on the needles above it. */
function spruceFrond(g: CanvasRenderingContext2D, ox: number, rnd: () => number, pal: Pal, tilt: number): void {
  pineFrond(g, ox, rnd, pal, tilt);
  g.save();
  g.beginPath();
  g.rect(ox, 0, TILE, TILE);
  g.clip();
  const x0 = ox + 8;
  const x1 = ox + TILE - 10;
  const cy = TILE / 2;
  const twigY = (t: number) => cy + Math.sin(t * Math.PI) * tilt * -10 + t * tilt * 6;
  snowOnTwig(g, rnd, x0, x1, twigY, 13, 1);
  // a second, thinner layer of snow on the needles either side of the twig
  for (const side of [-1, 1]) {
    for (let k = 0; k < 9; k++) {
      const t = (k + rnd()) / 9;
      const x = x0 + (x1 - x0) * t;
      const y = twigY(t) + side * (12 + rnd() * 30 * (1 - t));
      g.fillStyle = 'rgba(232,240,252,0.8)';
      g.beginPath();
      g.ellipse(x, y, 5 + rnd() * 9 * (1 - t * 0.6), 2.5 + rnd() * 3, side * 0.3, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.restore();
}

/** A bare birch twig spray: a lacework of thin dark twigs from a central branch, with a little snow on them. */
function bareSpray(g: CanvasRenderingContext2D, ox: number, rnd: () => number, pal: Pal, tilt: number): void {
  g.save();
  g.beginPath();
  g.rect(ox, 0, TILE, TILE);
  g.clip();
  const x0 = ox + 8;
  const x1 = ox + TILE - 10;
  const cy = TILE / 2;
  const twigY = (t: number) => cy + Math.sin(t * Math.PI) * tilt * -14 + t * tilt * 8;
  g.lineCap = 'round';
  // the branch
  g.strokeStyle = pal.dark[1];
  g.lineWidth = 4.2;
  g.beginPath();
  g.moveTo(x0, twigY(0));
  for (let k = 1; k <= 12; k++) g.lineTo(x0 + ((x1 - x0) * k) / 12, twigY(k / 12));
  g.stroke();
  // twigs: forking, drooping a little, thinner towards the tips
  const fork = (x: number, y: number, ang: number, len: number, w: number, depth: number) => {
    const ex = x + Math.cos(ang) * len;
    const ey = y + Math.sin(ang) * len + len * 0.12;
    g.strokeStyle = depth === 0 ? pal.mid[(rnd() * 3) | 0] : depth === 1 ? pal.light[(rnd() * 3) | 0] : pal.hi[(rnd() * 3) | 0];
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(ang + 0.2) * len * 0.55, y + Math.sin(ang + 0.2) * len * 0.55, ex, ey);
    g.stroke();
    if (depth < 2) {
      const n = depth === 0 ? 3 : 2;
      for (let k = 0; k < n; k++) fork(x + (ex - x) * (0.45 + 0.5 * rnd()), y + (ey - y) * (0.45 + 0.5 * rnd()), ang + (rnd() - 0.5) * 1.5, len * (0.5 + 0.25 * rnd()), Math.max(1.5, w * 0.7), depth + 1);
    }
  };
  for (let i = 0; i < 10; i++) {
    const t = (i + rnd()) / 10;
    for (const side of [-1, 1]) fork(x0 + (x1 - x0) * t, twigY(t), side * (0.9 + rnd() * 0.5) - 0.2, 40 + 34 * (1 - Math.abs(t - 0.45)) * (0.7 + 0.6 * rnd()), 2.6, 0);
  }
  // snow along the upper side of the branch, and on a few twigs
  snowOnTwig(g, rnd, x0, x1, twigY, 6, 0.5);
  for (let k = 0; k < 18; k++) {
    g.fillStyle = 'rgba(240,245,252,0.85)';
    g.beginPath();
    g.ellipse(x0 + rnd() * (x1 - x0), cy + (rnd() - 0.5) * 120, 2.4 + rnd() * 3, 1.6 + rnd() * 1.6, rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

/** A date-palm frond: a rib along +x (the base at the left) with feathery leaflets swept toward the tip, hanging down on both sides. */
function palmFrond(g: CanvasRenderingContext2D, ox: number, rnd: () => number, pal: Pal, curl: number): void {
  g.save();
  g.beginPath();
  g.rect(ox, 0, TILE, TILE);
  g.clip();
  const x0 = ox + 6;
  const x1 = ox + TILE - 8;
  const cy = TILE / 2;
  const ribY = (t: number) => cy + curl * 9 * Math.sin(t * Math.PI);
  g.lineCap = 'round';
  g.strokeStyle = '#5b6a2a';
  g.lineWidth = 3.2;
  g.beginPath();
  g.moveTo(x0, ribY(0));
  for (let k = 1; k <= 16; k++) g.lineTo(x0 + ((x1 - x0) * k) / 16, ribY(k / 16));
  g.stroke();
  const N = 46;
  const passes: [string[], number, number][] = [
    [pal.dark, 3.4, 1.0],
    [pal.mid, 2.7, 0.94],
    [pal.light, 1.9, 0.8],
    [pal.hi, 1.2, 0.58],
  ];
  for (const [cols, width, lenMul] of passes) {
    g.lineWidth = width;
    for (let i = 0; i < N; i++) {
      const t = (i + rnd()) / N;
      if (t < 0.04) continue;
      const bx = x0 + (x1 - x0) * t;
      const by = ribY(t);
      // long in the middle, short at the base and tip
      const env = Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.06)), 0.7);
      for (const side of [-1, 1]) {
        if (lenMul < 0.7 && rnd() < 0.5) continue;
        const L = (14 + 100 * env) * lenMul * (0.8 + rnd() * 0.36);
        // swept toward the tip, and spreading sideways
        const ang = 0.95 - 0.5 * t + (rnd() - 0.5) * 0.18;
        const ex = bx + Math.sin(ang) * L * 0.55 + 4;
        const ey = by + side * Math.cos(ang * 0.7) * L * 0.82;
        g.strokeStyle = cols[(rnd() * cols.length) | 0];
        g.beginPath();
        g.moveTo(bx, by);
        g.quadraticCurveTo(bx + (ex - bx) * 0.4, by + (ey - by) * 0.8, ex, ey + side * 6 * env);
        g.stroke();
      }
    }
  }
  // the tip: a few short leaflets closing the end
  g.strokeStyle = pal.mid[1];
  g.lineWidth = 2.2;
  for (let k = 0; k < 7; k++) {
    g.beginPath();
    g.moveTo(x1 - 24, ribY(0.96));
    g.lineTo(x1 + (rnd() - 0.2) * 4, ribY(1) + (k - 3) * 3.4);
    g.stroke();
  }
  g.restore();
}

function barkTile(g: CanvasRenderingContext2D, ox: number, rnd: () => number, kind: FoliageKind): void {
  if (kind === 'bare') {
    // birch: white, with the black horizontal lenticels and a grey, rough base
    g.fillStyle = '#e4e2dc';
    g.fillRect(ox, 0, TILE, TILE);
    for (let i = 0; i < 160; i++) {
      const v = Math.floor(190 + rnd() * 50);
      g.fillStyle = `rgba(${v},${v},${Math.floor(v * 0.97)},0.5)`;
      g.fillRect(ox + rnd() * TILE, rnd() * TILE, 6 + rnd() * 30, 1 + rnd() * 3);
    }
    for (let i = 0; i < 90; i++) {
      g.fillStyle = `rgba(24,20,18,${0.55 + rnd() * 0.4})`;
      g.fillRect(ox + rnd() * TILE, rnd() * TILE, 5 + rnd() * 26, 1.4 + rnd() * 2.6);
    }
    return;
  }
  if (kind === 'palm') {
    // palm trunk: pale grey-brown with scar rings every 7 px and fibrous streaks
    g.fillStyle = '#6f6352';
    g.fillRect(ox, 0, TILE, TILE);
    for (let i = 0; i < 700; i++) {
      const x = ox + rnd() * TILE;
      const y = rnd() * TILE;
      const v = Math.floor(70 + rnd() * 50);
      g.fillStyle = `rgba(${v},${Math.floor(v * 0.88)},${Math.floor(v * 0.7)},0.4)`;
      g.fillRect(x, y, 1 + rnd() * 1.6, 6 + rnd() * 22);
    }
    for (let y = 3; y < TILE; y += 7) {
      g.fillStyle = 'rgba(38,30,22,0.55)';
      g.fillRect(ox, y, TILE, 1.6 + rnd() * 1.4);
      g.fillStyle = 'rgba(150,138,118,0.28)';
      g.fillRect(ox, y + 2.6, TILE, 1.0);
    }
    return;
  }
  g.fillStyle = kind === 'pine' || kind === 'spruce' ? '#3f2d22' : kind === 'poplar' ? '#4f4a3f' : '#35291e';
  g.fillRect(ox, 0, TILE, TILE);
  for (let i = 0; i < 520; i++) {
    const x = ox + 2 + rnd() * (TILE - 4);
    const y = rnd() * TILE;
    const l = 14 + rnd() * 60;
    const v = Math.floor(18 + rnd() * 52);
    g.fillStyle = kind === 'poplar' && rnd() < 0.12 ? '#1d1b18' : `rgba(${v},${Math.floor(v * 0.78)},${Math.floor(v * 0.55)},0.55)`;
    g.fillRect(x, y, 1 + rnd() * 3, l);
  }
}

/** Leaf-cluster / needle-spray atlas: [cluster A | cluster B | bark]. */
export function makeLeafAtlas(kind: FoliageKind, aniso = 8): THREE.DataTexture {
  const [c, g] = mk(TILE * TILES, TILE);
  g.clearRect(0, 0, c.width, c.height);
  const seed = kind === 'broad' ? 11 : kind === 'pine' ? 23 : kind === 'palm' ? 53 : kind === 'spruce' ? 61 : kind === 'bare' ? 67 : 37;
  const rnd = mulberry32(seed);
  const pal = PAL[kind];
  if (kind === 'pine') {
    pineFrond(g, 0, rnd, pal, 0.6);
    pineFrond(g, TILE, rnd, pal, -0.5);
  } else if (kind === 'spruce') {
    spruceFrond(g, 0, rnd, pal, 0.6);
    spruceFrond(g, TILE, rnd, pal, -0.5);
  } else if (kind === 'bare') {
    bareSpray(g, 0, rnd, pal, 0.7);
    bareSpray(g, TILE, rnd, pal, -0.6);
  } else if (kind === 'palm') {
    palmFrond(g, 0, rnd, pal, 0.8);
    palmFrond(g, TILE, rnd, pal, -0.6);
  } else {
    broadCluster(g, 0, rnd, pal, kind === 'poplar' ? 0.8 : 1);
    broadCluster(g, TILE, rnd, pal, kind === 'poplar' ? 0.8 : 1);
  }
  barkTile(g, TILE * 2, rnd, kind);
  return toDataTexture(c, TILES, aniso);
}

// ── billboards ───────────────────────────────────────────────────────────────────

/** Billboard tiles are square (256 px = one tree height); the quad width per species is BB_WIDTH (in tree heights). */
export const BB_T = 256;
export const BB_WIDTH = { broad: 1.0, poplar: 0.62, pine: 0.7, palm: 0.86, spruce: 0.62, bare: 0.5 } as const;
/** Tiles in the billboard atlas: [broad | poplar | pine | palm], and on a winter circuit [.. | spruce | bare birch] after them. */
export const BB_TILES = 4;
export const BB_TILES_WINTER = 6;

function dab(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, rnd: () => number): void {
  g.fillStyle = fill;
  g.beginPath();
  g.ellipse(x, y, r * (1 + rnd() * 0.5), r * (0.6 + rnd() * 0.4), rnd() * Math.PI, 0, Math.PI * 2);
  g.fill();
}

/** Run `draw` in design space: x in [0, 256 * width], y in [0, 256] (y down), mapped onto one square atlas tile. */
function inTile(g: CanvasRenderingContext2D, tile: number, width: number, draw: (dw: number) => void): void {
  g.save();
  g.beginPath();
  g.rect(tile * BB_T, 0, BB_T, BB_T);
  g.clip();
  g.translate(tile * BB_T, 0);
  g.scale(1 / width, 1);
  draw(BB_T * width);
  g.restore();
}

function broadBillboard(g: CanvasRenderingContext2D, dw: number, rnd: () => number, pal: Pal, lobes: [number, number, number][], trunkTop: number): void {
  g.fillStyle = '#3a2b1e';
  g.fillRect(dw / 2 - 5, trunkTop, 10, BB_T - trunkTop);
  g.fillStyle = '#291e15';
  g.fillRect(dw / 2 + 1, trunkTop, 4, BB_T - trunkTop);
  // lobes back to front (lower ones first so upper lobes overlap them)
  const sorted = [...lobes].sort((a, b) => b[1] - a[1]);
  for (const [lx, ly, lr] of sorted) {
    const gr = g.createRadialGradient(lx - lr * 0.3, ly - lr * 0.38, lr * 0.1, lx, ly, lr * 1.05);
    gr.addColorStop(0, pal.light[1]);
    gr.addColorStop(0.55, pal.mid[1]);
    gr.addColorStop(1, pal.dark[0]);
    g.fillStyle = gr;
    g.beginPath();
    g.arc(lx, ly, lr, 0, Math.PI * 2);
    g.fill();
    // leaf speckle: light on the upper-left, dark on the lower-right, plus a ragged rim of leaves
    const n = Math.floor(lr * 3.2);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * lr * 1.04;
      const px = lx + Math.cos(a) * r;
      const py = ly + Math.sin(a) * r;
      const lit = (-Math.cos(a) * 0.6 - Math.sin(a) * 0.8) * (0.4 + 0.6 * (r / lr)) + (rnd() - 0.5) * 0.5;
      const pool = lit > 0.3 ? pal.hi : lit > -0.05 ? pal.light : lit > -0.4 ? pal.mid : pal.dark;
      dab(g, px, py, 2.6 + rnd() * 3.4, pool[(rnd() * pool.length) | 0], rnd);
    }
  }
}

function pineBillboard(g: CanvasRenderingContext2D, dw: number, rnd: () => number, pal: Pal): void {
  const cx = dw / 2;
  g.fillStyle = '#33261b';
  g.fillRect(cx - 4, 200, 8, 56);
  const tiers = 11;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const yTop = 12 + t * 168;
    const w = 9 + (1 - Math.pow(1 - t, 0.9)) * 60;
    const h = 30 + t * 22;
    const gr = g.createLinearGradient(cx - w, 0, cx + w, 0);
    gr.addColorStop(0, pal.mid[1]);
    gr.addColorStop(0.5, pal.dark[1]);
    gr.addColorStop(1, pal.dark[0]);
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(cx, yTop - 8);
    const steps = 10;
    g.lineTo(cx + w, yTop + h * 0.85);
    for (let k = steps; k >= 0; k--) {
      const u = k / steps;
      g.lineTo(cx - w + 2 * w * u, yTop + h * 0.92 - rnd() * 9 + (k % 2) * 8);
    }
    g.lineTo(cx - w, yTop + h * 0.85);
    g.closePath();
    g.fill();
    const n = Math.floor(18 + w * 0.7);
    for (let k = 0; k < n; k++) {
      const px = cx + (rnd() * 2 - 1) * w * 0.96;
      const py = yTop + 4 + rnd() * h * 0.9;
      const lit = (-(px - cx) / w) * 0.7 + (1 - (py - yTop) / h) * 0.35 + (rnd() - 0.5) * 0.4;
      const pool = lit > 0.45 ? pal.hi : lit > 0.0 ? pal.light : pal.mid;
      dab(g, px, py, 2 + rnd() * 2.6, pool[(rnd() * pool.length) | 0], rnd);
    }
  }
}

/** A palm seen from the side: a gently curved trunk and a starburst of drooping fronds. */
function palmBillboard(g: CanvasRenderingContext2D, dw: number, rnd: () => number, pal: Pal): void {
  const cx = dw / 2;
  const topY = 50;
  const lean = 12;
  // trunk: curved, tapering, with a few ring marks
  g.fillStyle = '#6a5f4e';
  g.beginPath();
  g.moveTo(cx - 4.6, BB_T);
  g.quadraticCurveTo(cx - 5 + lean * 0.2, BB_T * 0.6, cx + lean - 2.6, topY + 4);
  g.lineTo(cx + lean + 2.6, topY + 4);
  g.quadraticCurveTo(cx + 5 + lean * 0.2, BB_T * 0.6, cx + 4.6, BB_T);
  g.closePath();
  g.fill();
  g.strokeStyle = 'rgba(40,32,24,0.5)';
  g.lineWidth = 1.2;
  for (let y = topY + 12; y < BB_T - 6; y += 9) {
    const t = (y - topY) / (BB_T - topY);
    const x = cx + lean * (1 - t) * 0.9;
    g.beginPath();
    g.moveTo(x - 4 - t * 1.6, y);
    g.lineTo(x + 4 + t * 1.6, y);
    g.stroke();
  }
  const hx = cx + lean;
  // fronds: arching out and drooping
  const fronds = 15;
  for (let k = 0; k < fronds; k++) {
    const a = (k / (fronds - 1)) * Math.PI;
    const dir = Math.cos(a);
    const rise = Math.sin(a);
    const R = (74 + rnd() * 22) * (0.8 + 0.2 * Math.abs(dir) + 0.2 * rise);
    const tipX = hx + dir * R;
    const tipY = topY - rise * R * 0.4 + (1 - rise) * R * 0.62 + 8;
    const cpX = hx + dir * R * 0.55;
    const cpY = topY - rise * R * 0.78 - 8;
    for (const [w, col] of [[7.5, pal.dark[0]], [5.2, pal.mid[1]], [2.4, pal.light[1]]] as const) {
      g.strokeStyle = col;
      g.lineWidth = w;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(hx, topY);
      g.quadraticCurveTo(cpX, cpY, tipX, tipY);
      g.stroke();
    }
    // leaflet fringe along the frond
    for (let i = 1; i < 9; i++) {
      const t = i / 9;
      const px = (1 - t) * (1 - t) * hx + 2 * t * (1 - t) * cpX + t * t * tipX;
      const py = (1 - t) * (1 - t) * topY + 2 * t * (1 - t) * cpY + t * t * tipY;
      const pool = rnd() < 0.5 ? pal.light : pal.mid;
      dab(g, px, py + 3, 3.4 + rnd() * 2.8, pool[(rnd() * pool.length) | 0], rnd);
    }
  }
  // the crown boss
  g.fillStyle = '#4d3b1c';
  g.beginPath();
  g.arc(hx, topY + 3, 6, 0, Math.PI * 2);
  g.fill();
}

/** A snow-laden spruce seen from the side: dark tiers with a white cap of snow on each, getting wider towards the ground. */
function spruceBillboard(g: CanvasRenderingContext2D, dw: number, rnd: () => number, pal: Pal): void {
  const cx = dw / 2;
  g.fillStyle = '#2a2018';
  g.fillRect(cx - 3.5, 214, 7, 42);
  const tiers = 13;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const yTop = 8 + t * 176;
    const w = 7 + (1 - Math.pow(1 - t, 0.85)) * 62;
    const h = 28 + t * 24;
    // the dark needles, a little lighter on the sun side
    const gr = g.createLinearGradient(cx - w, 0, cx + w, 0);
    gr.addColorStop(0, pal.light[1]);
    gr.addColorStop(0.5, pal.mid[1]);
    gr.addColorStop(1, pal.dark[0]);
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(cx, yTop - 7);
    g.lineTo(cx + w, yTop + h * 0.86);
    const steps = 11;
    for (let k = steps; k >= 0; k--) {
      const u = k / steps;
      g.lineTo(cx - w + 2 * w * u, yTop + h * 0.92 - rnd() * 10 + (k % 2) * 9);
    }
    g.lineTo(cx - w, yTop + h * 0.86);
    g.closePath();
    g.fill();
    // the snow on top of the tier: a white cap following its upper edge, blue underneath
    g.fillStyle = '#c4d0e6';
    g.beginPath();
    g.moveTo(cx, yTop - 7);
    g.lineTo(cx + w * 0.97, yTop + h * 0.78);
    g.quadraticCurveTo(cx + w * 0.4, yTop + h * 0.46, cx, yTop + h * 0.34);
    g.quadraticCurveTo(cx - w * 0.4, yTop + h * 0.46, cx - w * 0.97, yTop + h * 0.78);
    g.closePath();
    g.fill();
    g.fillStyle = '#f2f6fd';
    g.beginPath();
    g.moveTo(cx, yTop - 7);
    g.lineTo(cx + w * 0.8, yTop + h * 0.64);
    g.quadraticCurveTo(cx + w * 0.3, yTop + h * 0.34, cx, yTop + h * 0.24);
    g.quadraticCurveTo(cx - w * 0.3, yTop + h * 0.34, cx - w * 0.8, yTop + h * 0.64);
    g.closePath();
    g.fill();
    const n = Math.floor(10 + w * 0.5);
    for (let k = 0; k < n; k++) {
      const px = cx + (rnd() * 2 - 1) * w * 0.94;
      const py = yTop + h * (0.4 + rnd() * 0.5);
      dab(g, px, py, 1.8 + rnd() * 2.4, rnd() < 0.5 ? pal.light[2] : pal.mid[0], rnd);
    }
  }
}

/** A bare birch seen from the side: a slim white trunk, a lacework crown of dark twigs with snow on them. */
function bareBillboard(g: CanvasRenderingContext2D, dw: number, rnd: () => number, pal: Pal): void {
  const cx = dw / 2;
  g.fillStyle = '#e3e1db';
  g.beginPath();
  g.moveTo(cx - 4.5, BB_T);
  g.lineTo(cx - 2.6, 90);
  g.lineTo(cx + 2.6, 90);
  g.lineTo(cx + 4.5, BB_T);
  g.closePath();
  g.fill();
  g.fillStyle = '#26211e';
  for (let y = 100; y < BB_T - 6; y += 11) g.fillRect(cx - 3 + rnd() * 2, y, 2 + rnd() * 3, 1.6);
  g.lineCap = 'round';
  for (let i = 0; i < 120; i++) {
    const y0 = 56 + rnd() * 120;
    const spread = 6 + ((y0 - 40) / 140) * 34;
    const dx = (rnd() * 2 - 1) * spread;
    g.strokeStyle = (rnd() < 0.5 ? pal.mid : pal.light)[(rnd() * 3) | 0];
    g.lineWidth = 1.2 + rnd() * 1.5;
    g.beginPath();
    g.moveTo(cx + dx * 0.15, y0 + 18 + rnd() * 20);
    g.quadraticCurveTo(cx + dx * 0.6, y0 - 4, cx + dx, y0 - 14 - rnd() * 22);
    g.stroke();
    if (rnd() < 0.35) {
      g.fillStyle = 'rgba(240,245,252,0.85)';
      g.beginPath();
      g.ellipse(cx + dx * 0.8, y0 - 12, 2 + rnd() * 2, 1.4, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
}

/** Atlas of whole-tree silhouettes: [broad | poplar | pine | palm], square tiles, unit tree height = 256 px. */
export function makeBillboardAtlas(aniso = 4, winter = false): THREE.DataTexture {
  const tiles = winter ? BB_TILES_WINTER : BB_TILES;
  const [c, g] = mk(BB_T * tiles, BB_T);
  g.clearRect(0, 0, c.width, c.height);
  const rnd = mulberry32(777);
  inTile(g, 0, BB_WIDTH.broad, (dw) =>
    broadBillboard(
      g,
      dw,
      rnd,
      PAL.broad,
      [
        [128, 94, 46],
        [80, 108, 40],
        [176, 108, 40],
        [100, 62, 38],
        [156, 62, 38],
        [128, 40, 30],
        [60, 132, 28],
        [196, 132, 28],
        [128, 128, 36],
      ],
      150,
    ),
  );
  inTile(g, 1, BB_WIDTH.poplar, (dw) => {
    const c0 = dw / 2;
    broadBillboard(
      g,
      dw,
      rnd,
      PAL.poplar,
      [
        [c0, 160, 27],
        [c0 - 1, 126, 31],
        [c0 + 2, 92, 31],
        [c0, 58, 27],
        [c0, 28, 19],
        [c0 - 20, 140, 20],
        [c0 + 21, 108, 20],
        [c0 - 20, 76, 19],
        [c0 + 19, 46, 17],
      ],
      190,
    );
  });
  inTile(g, 2, BB_WIDTH.pine, (dw) => pineBillboard(g, dw, rnd, PAL.pine));
  inTile(g, 3, BB_WIDTH.palm, (dw) => palmBillboard(g, dw, rnd, PAL.palm));
  return toDataTexture(c, BB_TILES, aniso);
}

// ── grass tufts ──────────────────────────────────────────────────────────────────

/**
 * A clump of grass blades on a transparent background. The texture is a grey-scale shade map (dark at the base,
 * bright at the tips): the tuft material takes its colour from the ground shader so tufts blend into the terrain.
 */
export function makeTuftTexture(aniso = 8): THREE.DataTexture {
  const S = 128;
  const [c, g] = mk(S, S);
  g.clearRect(0, 0, S, S);
  const rnd = mulberry32(4242);
  const blades = 26;
  for (let i = 0; i < blades; i++) {
    const t = (i + rnd()) / blades;
    const bx = S * (0.5 + (t - 0.5) * 0.62) + (rnd() - 0.5) * 6;
    const h = S * (0.5 + 0.46 * (1 - Math.abs(t - 0.5) * 1.4) * (0.7 + 0.3 * rnd()));
    const lean = (t - 0.5) * 34 + (rnd() - 0.5) * 20;
    const w = 3.6 + rnd() * 2.6;
    const tipX = bx + lean * 1.2;
    const tipY = S - h;
    const gr = g.createLinearGradient(0, S, 0, tipY);
    const lo = 70 + ((rnd() * 40) | 0);
    const hi = 205 + ((rnd() * 50) | 0);
    gr.addColorStop(0, `rgb(${lo},${lo},${lo})`);
    gr.addColorStop(1, `rgb(${hi},${hi},${hi})`);
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(bx - w, S);
    g.quadraticCurveTo(bx - w * 0.5 + lean * 0.3, S - h * 0.55, tipX, tipY);
    g.quadraticCurveTo(bx + w * 0.5 + lean * 0.5, S - h * 0.5, bx + w, S);
    g.closePath();
    g.fill();
  }
  return toDataTexture(c, 1, aniso);
}
