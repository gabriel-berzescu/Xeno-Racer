/**
 * Texture loading (Poly Haven CC0 PBR sets, with flat fallbacks) and small procedural textures.
 */
import * as THREE from 'three';
import { mulberry32 } from '../math';

export interface PbrSet {
  diff: THREE.Texture;
  nor: THREE.Texture;
  rough: THREE.Texture;
  /** Average albedo (linear), used to high-pass the texture so tiling is hidden. */
  avg: THREE.Color;
}

export interface TrackTextures {
  asphalt: PbrSet;
  grass: PbrSet;
  moss: PbrSet;
  dirt: PbrSet;
  gravel: PbrSet;
  rock: PbrSet;
  concreteWall: PbrSet;
  concreteFloor: PbrSet;
  bark: PbrSet;
  /** Tileable value noise (RGBA = 4 octave bands). */
  noise: THREE.DataTexture;
  /** Multiplicative crack mask (1 = clean). */
  cracks: THREE.Texture;
  all: THREE.Texture[];
}

const SETS: Record<string, { id: string; fallback: number }> = {
  asphalt: { id: 'asphalt_track', fallback: 0x2e3033 },
  grass: { id: 'leafy_grass', fallback: 0x4f6b2e },
  moss: { id: 'rocky_terrain_02', fallback: 0x4a5e28 },
  dirt: { id: 'forrest_ground_03', fallback: 0x6d5a42 },
  gravel: { id: 'gravel_floor', fallback: 0x9a8d78 },
  rock: { id: 'rock_face_03', fallback: 0x6e665c },
  concreteWall: { id: 'concrete_wall_007', fallback: 0xa7a8a4 },
  concreteFloor: { id: 'concrete_floor_worn_001', fallback: 0x8f908c },
  bark: { id: 'pine_bark', fallback: 0x4a3a2c },
};

function flat(r: number, g: number, b: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255, r, g, b, 255, r, g, b, 255, r, g, b, 255]), 2, 2, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

function assetUrl(rel: string): string {
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return `${base}assets/track/${rel}`;
}

async function loadTex(loader: THREE.TextureLoader, url: string, srgb: boolean, aniso: number, fallback: THREE.Texture): Promise<THREE.Texture> {
  try {
    const t = await loader.loadAsync(url);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = aniso;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  } catch (e) {
    console.warn(`[track] texture ${url} failed, using fallback`, e);
    return fallback;
  }
}

export async function loadTextures(aniso: number, onProgress?: (f: number) => void): Promise<TrackTextures> {
  const loader = new THREE.TextureLoader();
  const names = Object.keys(SETS);
  let done = 0;
  const out: Record<string, PbrSet> = {};
  await Promise.all(
    names.map(async (name) => {
      const { id, fallback } = SETS[name];
      const c = new THREE.Color(fallback);
      const [diff, nor, rough] = await Promise.all([
        loadTex(loader, assetUrl(`tex/${id}/diff.webp`), true, aniso, flat(Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255), false)),
        loadTex(loader, assetUrl(`tex/${id}/nor.webp`), false, aniso, flat(128, 128, 255, false)),
        loadTex(loader, assetUrl(`tex/${id}/rough.webp`), false, aniso, flat(200, 200, 200, false)),
      ]);
      out[name] = { diff, nor, rough, avg: averageColor(diff, c) };
      onProgress?.(++done / names.length);
    }),
  );
  const noise = makeNoiseTexture(256);
  const cracks = makeCrackTexture(1024);
  const all: THREE.Texture[] = [noise, cracks];
  for (const k of names) all.push(out[k].diff, out[k].nor, out[k].rough);
  return { ...(out as unknown as Omit<TrackTextures, 'noise' | 'cracks' | 'all'>), noise, cracks, all };
}

/** Average linear colour of a loaded albedo texture (falls back to `fallback`). */
export function averageColor(tex: THREE.Texture, fallback: THREE.Color): THREE.Color {
  try {
    const img = tex.image as CanvasImageSource | undefined;
    if (!img || tex instanceof THREE.DataTexture) return fallback.clone();
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data;
    let r = 0;
    let gg = 0;
    let b = 0;
    const lin = (v: number) => Math.pow(v / 255, 2.2);
    for (let i = 0; i < d.length; i += 4) {
      r += lin(d[i]);
      gg += lin(d[i + 1]);
      b += lin(d[i + 2]);
    }
    const n = d.length / 4;
    return new THREE.Color(r / n, gg / n, b / n);
  } catch {
    return fallback.clone();
  }
}

/** Periodic 2D value noise bands packed in RGBA (R: coarse .. A: fine). */
export function makeNoiseTexture(size: number): THREE.DataTexture {
  const rnd = mulberry32(777);
  const bands = [4, 8, 16, 32];
  const lattices = bands.map((n) => {
    const a = new Float32Array(n * n);
    for (let i = 0; i < a.length; i++) a[i] = rnd();
    return a;
  });
  const data = new Uint8Array(size * size * 4);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let b = 0; b < 4; b++) {
        const n = bands[b];
        const fx = (x / size) * n;
        const fy = (y / size) * n;
        const x0 = Math.floor(fx) % n;
        const y0 = Math.floor(fy) % n;
        const x1 = (x0 + 1) % n;
        const y1 = (y0 + 1) % n;
        const tx = smooth(fx - Math.floor(fx));
        const ty = smooth(fy - Math.floor(fy));
        const L = lattices[b];
        const v = (L[y0 * n + x0] * (1 - tx) + L[y0 * n + x1] * tx) * (1 - ty) + (L[y1 * n + x0] * (1 - tx) + L[y1 * n + x1] * tx) * ty;
        data[(y * size + x) * 4 + b] = Math.round(v * 255);
      }
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** Cracks / tar seams: dark thin jagged lines on white. */
export function makeCrackTexture(size: number): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, size, size);
  const rnd = mulberry32(4242);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const crack = (x: number, y: number, ang: number, len: number, w: number, depth: number) => {
    g.lineWidth = w;
    g.strokeStyle = `rgba(20,20,20,${0.55 + rnd() * 0.35})`;
    g.beginPath();
    g.moveTo(x, y);
    let cx = x;
    let cy = y;
    let a = ang;
    const seg = 5 + rnd() * 9;
    for (let d = 0; d < len; d += seg) {
      a += (rnd() - 0.5) * 0.7;
      cx += Math.cos(a) * seg;
      cy += Math.sin(a) * seg;
      g.lineTo(cx, cy);
      if (depth < 2 && rnd() < 0.09) crack(cx, cy, a + (rnd() < 0.5 ? 1 : -1) * (0.6 + rnd() * 0.6), len * 0.45, w * 0.65, depth + 1);
    }
    g.stroke();
  };
  for (let i = 0; i < 26; i++) crack(rnd() * size, rnd() * size, rnd() * Math.PI * 2, 90 + rnd() * 320, 1.1 + rnd() * 1.3, 0);
  // wrap-around copies for tiling: redraw edge strips by drawing the canvas onto itself offset
  const copy = document.createElement('canvas');
  copy.width = copy.height = size;
  copy.getContext('2d')!.drawImage(c, 0, 0);
  g.globalCompositeOperation = 'multiply';
  for (const [dx, dy] of [[size, 0], [-size, 0], [0, size], [0, -size]]) g.drawImage(copy, dx, dy);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}
