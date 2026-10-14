/**
 * Procedural tileable noise (owner: render). Used by the sky (clouds, moon surface, galaxy band) and
 * the effects (smoke puffs). No assets: generated once at start-up, deterministic.
 */

function hash(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Smooth value noise on a periodic lattice. x, y in lattice units. Returns 0..1. */
export function valueNoiseTile(x: number, y: number, period: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = fade(x - x0), fy = fade(y - y0);
  const xa = ((x0 % period) + period) % period, ya = ((y0 % period) + period) % period;
  const xb = (xa + 1) % period, yb = (ya + 1) % period;
  const a = hash(xa, ya, seed), b = hash(xb, ya, seed), c = hash(xa, yb, seed), d = hash(xb, yb, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

export function fbmTile(x: number, y: number, period: number, octaves: number, seed: number, gain = 0.5): number {
  let sum = 0, amp = 0.5, norm = 0, p = period, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoiseTile(x * f, y * f, p, seed + o * 17);
    norm += amp;
    amp *= gain;
    p *= 2;
    f *= 2;
  }
  return sum / norm;
}

/** Inverted cellular noise (1 at cell centres) on a periodic lattice. */
export function worleyTile(x: number, y: number, period: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  let best = 8;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = x0 + i, cy = y0 + j;
      const wx = ((cx % period) + period) % period, wy = ((cy % period) + period) % period;
      const px = cx + hash(wx, wy, seed), py = cy + hash(wx, wy, seed + 101);
      const dx = x - px, dy = y - py;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return 1 - Math.min(1, Math.sqrt(best));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * RGBA8 tileable noise for clouds:
 *  R = low-frequency fbm (cloud masses)       G = worley billows
 *  B = Perlin-Worley mix (puffy cumulus)       A = independent fbm (detail / wisps)
 */
export function makeCloudNoise(size = 256, seed = 1337): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = i / size, v = j / size;
      const r = fbmTile(u * 4, v * 4, 4, 5, seed);
      const w1 = worleyTile(u * 6, v * 6, 6, seed + 3);
      const w2 = worleyTile(u * 12, v * 12, 12, seed + 5);
      const w3 = worleyTile(u * 24, v * 24, 24, seed + 7);
      const g = w1 * 0.55 + w2 * 0.3 + w3 * 0.15;
      const b = clamp01((r - (1 - g) * 0.45) / (1 - (1 - g) * 0.45));
      const a = fbmTile(u * 8, v * 8, 8, 4, seed + 99);
      const o = (j * size + i) * 4;
      // spread the histogram (fbm clusters around 0.5)
      data[o] = Math.round(clamp01((r - 0.5) * 1.9 + 0.5) * 255);
      data[o + 1] = Math.round(clamp01((g - 0.35) * 1.7) * 255);
      data[o + 2] = Math.round(clamp01((b - 0.3) * 1.5) * 255);
      data[o + 3] = Math.round(clamp01((a - 0.5) * 1.9 + 0.5) * 255);
    }
  }
  return data;
}

/**
 * Smoke puff atlas: 2x2 tiles of soft, turbulent, round puffs. RGBA8: R = density, G = a second
 * noise octave used to roughen the shading normal, B = unused, A = density. size = full atlas edge.
 */
export function makeSmokeAtlas(size = 256, seed = 4242): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const tile = size / 2;
  for (let ty = 0; ty < 2; ty++) {
    for (let tx = 0; tx < 2; tx++) {
      const s = seed + (ty * 2 + tx) * 31;
      for (let j = 0; j < tile; j++) {
        for (let i = 0; i < tile; i++) {
          const u = (i + 0.5) / tile, v = (j + 0.5) / tile;
          const dx = u * 2 - 1, dy = v * 2 - 1;
          const r = Math.sqrt(dx * dx + dy * dy);
          // billowy domain warp
          const wx = fbmTile(u * 3 + 0.3, v * 3 + 0.7, 3, 3, s) - 0.5;
          const wy = fbmTile(u * 3 + 5.1, v * 3 + 2.9, 3, 3, s + 9) - 0.5;
          const n = fbmTile(u * 4 + wx * 1.3, v * 4 + wy * 1.3, 4, 5, s + 21);
          const n2 = fbmTile(u * 9 + wx * 2, v * 9 + wy * 2, 9, 3, s + 40);
          // radial envelope with noisy edge
          const edge = 1 - r * (0.84 + (n - 0.5) * 1.45);
          let d = clamp01(edge * 1.3);
          d = d * d * (3 - 2 * d);
          // mottled interior: smoke is patchy, not a glowing ball
          d *= 0.28 + n * 0.95 + (n2 - 0.5) * 0.4;
          const o = ((ty * tile + j) * size + tx * tile + i) * 4;
          const dv = Math.round(clamp01(d) * 255);
          data[o] = dv;
          data[o + 1] = Math.round(clamp01(n2) * 255);
          data[o + 2] = Math.round(clamp01(n) * 255);
          data[o + 3] = dv;
        }
      }
    }
  }
  return data;
}
