/**
 * The sun visibility map on the GPU (owner: render).
 *
 * Makes the map (sunVisibility.ts) for the terrain a circuit stands on and the sun of the race, lays its two grids out in one atlas
 * texture that every material shares (sharedTexture.ts, installed by shaderPatches.ts), and keeps the uniforms the shaders read
 * current: the atlas layout and the sun's frame (`xrSunVis`), how much of the map's verdict the weather lets through (a sun behind
 * a rain deck casts no shade for the hills to take away), and the sun's part of the haze (`xrFogSun`).
 *
 * The sun does not move during a race, so the map is made once per (circuit, sun): when the track is loaded and when the time of
 * day changes under a scene that is kept (a race on the same circuit at another hour). It is made in slices between the frames of
 * the loading screen, never in a race.
 */
import { DataUtils, FloatType, HalfFloatType, LinearFilter, type WebGLRenderer } from 'three';
import type { TerrainSource } from '../core/systems';
import { FOG_TABLE_SIZE } from './atmosphere';
import { sunVisTexture, xrFogSunUniform, xrSunVisUniform } from './shaderPatches';
import { computeSunVisibility, FINE_BLEND_NODES, HEIGHT_BIAS, NO_GROUND, sampleSunVisibility, SHADE_HAZE_GLOW, SUNVIS_STRIDE, type SunVisField, type SunVisGrid } from './sunVisibility';

export class SunVisMap {
  /** The map in use; null until one is made and while there is no terrain. */
  field: SunVisField | null = null;
  /** What it was made for: terrain id, sun direction, radius. */
  private key = '';
  private pendingKey = '';
  private pending: Promise<void> | null = null;
  private token = 0;
  /** How much of the shade the weather lets through (the cascades' own strength: 0 under a rain deck, 1 in a clear sky). */
  private weather = 1;
  /** 32-bit floats filter on this GPU; if not the atlas is made of half floats. */
  private readonly floatLinear: boolean;
  /** Size and type of the atlas on the GPU (a change of either makes a new GPU texture). */
  private w = 1;
  private h = 1;
  private half = false;
  /** Atlas data that is on the GPU now (kept: the texture does not copy it). */
  private data: Float32Array | Uint16Array | null = null;
  /** Milliseconds the last map took to make and hand to the GPU (slices and the frames between them included). */
  lastMs = 0;
  /** The share of the sun's in-scatter that the air in a hill's shade keeps (SHADE_HAZE_GLOW). */
  private glow = SHADE_HAZE_GLOW;

  constructor(renderer: WebGLRenderer) {
    this.floatLinear = renderer.extensions.has('OES_texture_float_linear');
  }

  /**
   * Make the map for `terrain` and the sun at `dir` (a unit vector, radius in rad), unless it is the one in use already. `terrain` null:
   * no map (a circuit is being unloaded). Resolves when the map is on the GPU; a newer call overtakes an older one in progress.
   */
  async update(terrain: TerrainSource | null, dir: readonly [number, number, number], radius: number, yieldFn?: () => Promise<void>): Promise<void> {
    if (!terrain) {
      this.token++;
      this.field = null;
      this.key = '';
      this.pendingKey = '';
      this.pending = null;
      this.writeParams();
      return;
    }
    const key = `${terrain.id}|${dir[0].toFixed(5)},${dir[1].toFixed(5)},${dir[2].toFixed(5)}|${radius}`;
    if (key === this.key && this.field) return;
    if (key === this.pendingKey && this.pending) return this.pending;
    const token = ++this.token;
    this.pendingKey = key;
    // (the map in use was made for another sun or circuit: it says nothing about this one while the new one is being made)
    if (this.field) {
      this.field = null;
      this.key = '';
      this.writeParams();
    }
    const run = this.make(terrain, dir, radius, yieldFn, key, token);
    this.pending = run;
    return run;
  }

  private async make(terrain: TerrainSource, dir: readonly [number, number, number], radius: number, yieldFn: (() => Promise<void>) | undefined, key: string, token: number): Promise<void> {
    const t0 = performance.now();
    try {
      const field = await computeSunVisibility(terrain, dir, radius, {}, yieldFn);
      // (a newer call took over while this one was being made: its map is the one that counts)
      if (token !== this.token) return;
      this.field = field;
      this.key = key;
      this.upload(field);
      this.lastMs = performance.now() - t0;
    } finally {
      if (token === this.token) {
        this.pendingKey = '';
        this.pending = null;
      }
    }
  }

  /** The share of the sun's in-scatter that the air in the shade of a hill keeps (the glow of the sky above the ridge lights it): a dial for the look. */
  get hazeGlow(): number {
    return this.glow;
  }

  set hazeGlow(v: number) {
    this.glow = Math.min(1, Math.max(0, v));
    this.writeParams();
  }

  /** How much of the terrain's shade the weather lets through, 0..1 (the sun shadow strength of the weather preset). */
  setWeather(s: number): void {
    this.weather = Math.min(1, Math.max(0, s));
    this.writeParams();
  }

  /** The sun's part of the horizon table (EnvSolution.fogTableSun, scaled for a flash of lightning by the caller), for the haze. */
  setFogSun(table: Float32Array, gain = 1): void {
    const u = xrFogSunUniform.value;
    for (let k = 0; k < FOG_TABLE_SIZE; k++) {
      u[k * 4] = table[k * 3] * gain;
      u[k * 4 + 1] = table[k * 3 + 1] * gain;
      u[k * 4 + 2] = table[k * 3 + 2] * gain;
      u[k * 4 + 3] = 0;
    }
  }

  /** The map says the terrain hides the sun from somewhere (or the sun is down altogether), and the weather has a sun to hide. */
  get on(): boolean {
    return this.field !== null && this.field.active && this.weather > 0;
  }

  /**
   * The share of the sun's disc (0..1) that a point sees past the terrain, weather included: the CPU twin of xrSunVisAt. 1 where there is
   * no map. (The cascades are not drawn while the car stands where this is 0.)
   */
  visibilityAt(x: number, y: number, z: number): number {
    const f = this.field;
    if (!f || !f.active || this.weather <= 0) return 1;
    return 1 - this.weather * (1 - sampleSunVisibility(f, x, y, z));
  }

  /** Lay the grids out in the atlas and hand it to the GPU. */
  private upload(f: SunVisField): void {
    const fg = f.fine;
    const cg = f.coarse;
    if (!cg) {
      // the whole disc is below the horizon: the shader answers "dark" without a lookup (xrSunVis[5].w)
      this.writeParams();
      return;
    }
    const hf = fg ? fg.h : 0;
    const w = Math.max(fg ? fg.w : 1, cg.w);
    const h = hf + cg.h;
    const n = w * h;
    const data = new Float32Array(n * SUNVIS_STRIDE);
    // the pad around the blocks is never read (the shader keeps a block's lookups inside it), but it says "no terrain" all the same
    for (let k = 0; k < n; k++) {
      data[k * 4] = NO_GROUND;
      data[k * 4 + 1] = NO_GROUND;
      data[k * 4 + 2] = 1;
      data[k * 4 + 3] = 1;
    }
    const put = (g: SunVisGrid, y0: number): void => {
      for (let j = 0; j < g.h; j++) data.set(g.data.subarray(j * g.w * SUNVIS_STRIDE, (j + 1) * g.w * SUNVIS_STRIDE), ((y0 + j) * w) * SUNVIS_STRIDE);
    };
    if (fg) put(fg, 0);
    put(cg, hf);
    // from now on the CPU's grids read their numbers from the atlas too (one copy of them, not two)
    const stride = w * SUNVIS_STRIDE;
    if (fg) {
      fg.data = data;
      fg.base = 0;
      fg.rowStride = stride;
    }
    cg.data = data;
    cg.base = hf * stride;
    cg.rowStride = stride;

    const tex = sunVisTexture;
    const half = !this.floatLinear;
    let out: Float32Array | Uint16Array = data;
    if (half) {
      const u = new Uint16Array(data.length);
      for (let k = 0; k < data.length; k++) u[k] = DataUtils.toHalfFloat(Math.max(-65000, Math.min(65000, data[k])));
      out = u;
    }
    // a different size or type is a different GPU texture (three keeps its storage immutable): let go of the old one, the next draw makes the new
    if (w !== this.w || h !== this.h || half !== this.half) tex.dispose();
    this.w = w;
    this.h = h;
    this.half = half;
    this.data = out;
    tex.image = { data: out, width: w, height: h };
    tex.type = half ? HalfFloatType : FloatType;
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearFilter;
    tex.needsUpdate = true;
    this.writeParams();
  }

  /** The uniform block: the sun's frame, where the grids are in the atlas, and whether the map is on. */
  private writeParams(): void {
    const p = xrSunVisUniform.value;
    const f = this.field;
    p[24] = this.glow;
    if (!f || !f.active || this.weather <= 0) {
      p[3] = 0;
      return;
    }
    p[0] = f.ax;
    p[1] = f.az;
    p[2] = f.yRef;
    p[3] = this.weather;
    const cg = f.coarse;
    const fg = f.fine;
    // the dark sun: no lookup, everything in the shade
    p[20 + 3] = !cg ? 1 : 0;
    if (!cg) return;
    const iw = 1 / this.w;
    const ih = 1 / this.h;
    if (fg) {
      const inv = 1 / fg.cell;
      p[4] = inv;
      p[5] = -fg.u0 * inv;
      p[6] = -fg.v0 * inv;
      p[7] = 1 / FINE_BLEND_NODES;
      p[8] = fg.w - 1;
      p[9] = fg.h - 1;
      p[10] = 0.5;
      p[11] = 0.5;
    } else {
      p[4] = 0;
      p[5] = 0;
      p[6] = 0;
      p[7] = 0;
      p[8] = 0;
      p[9] = 0;
      p[10] = 0;
      p[11] = 0;
    }
    const invC = 1 / cg.cell;
    p[12] = invC;
    p[13] = -cg.u0 * invC;
    p[14] = -cg.v0 * invC;
    p[15] = 0;
    p[16] = cg.w - 1;
    p[17] = cg.h - 1;
    p[18] = 0.5;
    p[19] = (fg ? fg.h : 0) + 0.5;
    p[20] = iw;
    p[21] = ih;
    p[22] = HEIGHT_BIAS;
  }

  /** Size and type of the atlas on the GPU: for the logs and the memory estimate. */
  get atlas(): { width: number; height: number; bytes: number } {
    return { width: this.w, height: this.h, bytes: this.data ? this.data.byteLength : 0 };
  }
}
