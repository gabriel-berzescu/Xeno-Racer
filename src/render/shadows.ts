/**
 * Cascaded sun shadows (owner: render).
 *
 * N nested, focus-centred orthographic shadow maps (see shaderPatches.ts for the receiving side).
 * Each cascade's projection is snapped to its own texel grid in light space so shadows never shimmer
 * while the player drives; far cascades refresh only every few frames and only re-centre after the
 * focus has moved a fraction of their extent, which keeps the cost of 200 m+ of shadow coverage low.
 *
 * Split screen: each view has a set of cascades of its own (two sets of lights, one set in the scene at a time, chosen with
 * select()): the cascades follow the car that view films, and a far cascade that refreshes every few frames keeps its picture
 * between frames, which one set shared by the two views could not.
 */
import { DirectionalLight, Group, Vector3 } from 'three';
import { MAX_CASCADES, xrCsmUniform } from './shaderPatches';

export interface ShadowConfig {
  /** Number of cascades; 0 disables shadows. */
  count: number;
  mapSize: number;
  /** Half extent (m) of each cascade's footprint in light space. */
  radii: number[];
  /** Refresh interval in frames per cascade. */
  every: number[];
  /** PCF taps (1..8). */
  taps: number;
  /** Tallest shadow caster that should still reach the focus area (m). */
  maxCasterHeight: number;
}

export const SHADOW_OFF: ShadowConfig = { count: 0, mapSize: 512, radii: [], every: [], taps: 1, maxCasterHeight: 30 };

/** shadows setting x quality level -> configuration. */
export function shadowConfigFor(shadows: 'off' | 'low' | 'high', quality: 'low' | 'medium' | 'high' | 'ultra'): ShadowConfig {
  if (shadows === 'off') return SHADOW_OFF;
  if (shadows === 'low') {
    if (quality === 'low') return { count: 2, mapSize: 1024, radii: [26, 150], every: [1, 3], taps: 4, maxCasterHeight: 30 };
    return { count: 2, mapSize: 1536, radii: [24, 140], every: [1, 2], taps: 5, maxCasterHeight: 30 };
  }
  if (quality === 'ultra') return { count: 4, mapSize: 2048, radii: [12, 42, 150, 560], every: [1, 1, 2, 5], taps: 8, maxCasterHeight: 40 };
  if (quality === 'high') return { count: 3, mapSize: 2048, radii: [13, 52, 210], every: [1, 1, 3], taps: 7, maxCasterHeight: 35 };
  return { count: 3, mapSize: 1536, radii: [15, 60, 230], every: [1, 2, 4], taps: 5, maxCasterHeight: 30 };
}

const _up = new Vector3(0, 1, 0);
const _upAlt = new Vector3(0, 0, 1);

export class SunShadows {
  readonly group = new Group();
  /** The cascade lights of each view's set: set 0 serves the one view (and the first of two), set 1 the second view of a split screen. */
  readonly sets: DirectionalLight[][] = [[], []];
  private active = 0;
  private cfg: ShadowConfig = SHADOW_OFF;
  private readonly dir = new Vector3(0.3, 0.8, 0.5).normalize();
  private readonly ax = new Vector3(1, 0, 0);
  private readonly ay = new Vector3(0, 0, 1);
  private readonly centerSets: Vector3[][] = [[], []];
  private readonly dirtySets: boolean[][] = [[], []];
  private elevationSin = 0.5;
  private csmAvailable: boolean;
  /** Texel snapping on/off (off only to demonstrate shimmer in the sandbox). */
  snap = true;

  constructor(csmAvailable: boolean) {
    this.csmAvailable = csmAvailable;
    this.group.name = 'xr.sun';
    for (let k = 0; k < 2; k++) {
      for (let i = 0; i < MAX_CASCADES; i++) {
        const l = new DirectionalLight(0xffffff, 1);
        l.name = k === 0 ? `xr.sun.${i}` : `xr.sun2.${i}`;
        l.castShadow = false;
        l.visible = k === 0 && i === 0;
        l.shadow.autoUpdate = false;
        l.shadow.needsUpdate = true;
        l.shadow.radius = 1;
        this.group.add(l);
        this.group.add(l.target);
        this.sets[k].push(l);
        this.centerSets[k].push(new Vector3());
        this.dirtySets[k].push(true);
      }
    }
    this.setDirection(this.dir);
  }

  /** The cascade lights of the set in use (set 0 until select() says otherwise). */
  get lights(): DirectionalLight[] {
    return this.sets[this.active];
  }

  private get centers(): Vector3[] {
    return this.centerSets[this.active];
  }

  private get dirty(): boolean[] {
    return this.dirtySets[this.active];
  }

  /**
   * Put a view's set of cascades in the scene (and the other out of it): the next update() and the next render are that view's.
   * A scene has the sun's cascades of one set only, so the number of lights, and with it every lit shader, is the same for both.
   */
  select(set: 0 | 1): void {
    this.active = set;
    const count = this.cfg.count;
    for (let k = 0; k < 2; k++) for (let i = 0; i < MAX_CASCADES; i++) this.sets[k][i].visible = k === set && (i === 0 || i < count);
  }

  /** The set in use. */
  get selected(): 0 | 1 {
    return this.active === 1 ? 1 : 0;
  }

  /** The screen is whole again: the second set's shadow maps (tens of MB) go, and are made again by the next split screen. */
  releaseSecond(): void {
    for (const l of this.sets[1]) {
      if (l.shadow.map) {
        l.shadow.map.dispose();
        l.shadow.map = null;
      }
    }
    for (let i = 0; i < this.dirtySets[1].length; i++) this.dirtySets[1][i] = true;
  }
  get config(): ShadowConfig {
    return this.cfg;
  }

  get cascadeCount(): number {
    return this.cfg.count;
  }

  /**
   * Every active cascade has its shadow map. A map is made by the first draw of the shadow pass, and until then a program that
   * samples it has nothing valid bound: the draw calls of every shadow-receiving material fail (nothing but sky and terrain on
   * screen). So the pass must run once before anything is drawn, whatever the sun is doing.
   */
  get mapsReady(): boolean {
    for (let i = 0; i < this.cfg.count; i++) if (!this.lights[i].shadow.map) return false;
    return true;
  }

  configure(cfg: ShadowConfig): void {
    const count = this.csmAvailable ? Math.min(cfg.count, MAX_CASCADES) : Math.min(cfg.count, 1);
    this.cfg = { ...cfg, count };
    for (let k = 0; k < 2; k++) {
      for (let i = 0; i < MAX_CASCADES; i++) {
        const l = this.sets[k][i];
        const active = i < count;
        l.castShadow = active;
        l.visible = k === this.active && (i === 0 || active);
        if (active) {
          if (l.shadow.mapSize.x !== cfg.mapSize) {
            l.shadow.mapSize.set(cfg.mapSize, cfg.mapSize);
            if (l.shadow.map) {
              l.shadow.map.dispose();
              l.shadow.map = null;
            }
          }
          l.shadow.bias = -0.0004;
          l.shadow.normalBias = 0.03;
          l.shadow.intensity = 1;
        } else if (l.shadow.map) {
          l.shadow.map.dispose();
          l.shadow.map = null;
        }
        this.dirtySets[k][i] = true;
      }
    }
    xrCsmUniform.value[3] = cfg.taps;
  }

  setLight(color: [number, number, number], intensity: number): void {
    for (const set of this.sets) {
      for (let i = 0; i < MAX_CASCADES; i++) {
        set[i].color.setRGB(color[0], color[1], color[2]);
        set[i].intensity = intensity;
      }
    }
  }

  setShadowIntensity(v: number): void {
    for (const set of this.sets) for (const l of set) l.shadow.intensity = v;
  }

  /** Unit vector pointing toward the sun/moon. */
  setDirection(d: Vector3): void {
    this.dir.copy(d).normalize();
    this.elevationSin = this.dir.y;
    const up = Math.abs(this.dir.y) > 0.985 ? _upAlt : _up;
    this.ax.crossVectors(up, this.dir).normalize();
    this.ay.crossVectors(this.dir, this.ax).normalize();
    this.markDirty();
  }

  markDirty(): void {
    for (const d of this.dirtySets) for (let i = 0; i < d.length; i++) d[i] = true;
  }

  /** The cascades of the set in use only: they were left alone for a while and must be drawn again (see RenderSystem.fitSun). */
  markSelectedDirty(): void {
    const d = this.dirty;
    for (let i = 0; i < d.length; i++) d[i] = true;
  }

  /**
   * Re-fit cascades around `focus`. Returns true when at least one shadow map has to re-render this
   * frame (the caller then sets renderer.shadowMap.needsUpdate).
   */
  update(focus: Vector3, frame: number): boolean {
    const cfg = this.cfg;
    if (cfg.count === 0) return false;
    const sinEl = Math.max(this.elevationSin, Math.sin(0.07));
    let any = false;
    const csm = xrCsmUniform.value;

    for (let i = 0; i < cfg.count; i++) {
      const r = cfg.radii[i];
      const every = cfg.every[i] ?? 1;
      const light = this.lights[i];
      const shadow = light.shadow;

      const zBack = Math.min(950, r + cfg.maxCasterHeight / sinEl);
      const zFront = r + 25;
      const depth = zBack + zFront;
      const size = cfg.mapSize;
      const texel = (2 * r) / size;

      const phase = every > 1 ? i % every : 0;
      const center = this.centers[i];
      const moved = Math.hypot(focus.x - center.x, focus.z - center.z, focus.y - center.y);
      const recenter = this.dirty[i] || every === 1 || moved > r * 0.12;
      // (the second view's set is one frame behind the first's: a far cascade that refreshes every few frames never refreshes for both
      // views in the same frame, which would double that frame's shadow work)
      const due = this.dirty[i] || (frame + this.active) % every === phase;
      if (!due) {
        // keep the map as is
      } else {
        if (recenter) center.copy(focus);
        // snap the centre to the cascade's texel grid in light space
        const cx = center.dot(this.ax);
        const cy = center.dot(this.ay);
        const cz = center.dot(this.dir);
        const sx = this.snap ? Math.round(cx / texel) * texel : cx;
        const sy = this.snap ? Math.round(cy / texel) * texel : cy;
        light.target.position.set(0, 0, 0).addScaledVector(this.ax, sx).addScaledVector(this.ay, sy).addScaledVector(this.dir, cz);
        light.position.copy(light.target.position).addScaledVector(this.dir, zBack);
        const cam = shadow.camera;
        cam.left = -r;
        cam.right = r;
        cam.top = r;
        cam.bottom = -r;
        cam.near = 0.5;
        cam.far = depth;
        cam.up.copy(Math.abs(this.dir.y) > 0.985 ? _upAlt : _up);
        cam.updateProjectionMatrix();
        shadow.normalBias = Math.max(0.02, texel * 1.4);
        shadow.bias = -0.0004;
        shadow.needsUpdate = true;
        any = true;
        this.dirty[i] = false;
      }

      // receiving-side parameters (per cascade)
      csm[i * 4] = 16 * ((2 * r) / depth);
      csm[i * 4 + 1] = (texel * 0.55 + 0.003) / depth;
      csm[i * 4 + 2] = i === 0 ? 1.45 : 1.7;
    }
    return any;
  }

  dispose(): void {
    for (const set of this.sets) for (const l of set) l.shadow.map?.dispose();
  }
}
