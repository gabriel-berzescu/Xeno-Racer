/**
 * Cascaded sun shadows (owner: render).
 *
 * N nested, focus-centred orthographic shadow maps (see shaderPatches.ts for the receiving side).
 * Each cascade's projection is snapped to its own texel grid in light space so shadows never shimmer
 * while the player drives; far cascades refresh only every few frames and only re-centre after the
 * focus has moved a fraction of their extent, which keeps the cost of 200 m+ of shadow coverage low.
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
  readonly lights: DirectionalLight[] = [];
  private cfg: ShadowConfig = SHADOW_OFF;
  private readonly dir = new Vector3(0.3, 0.8, 0.5).normalize();
  private readonly ax = new Vector3(1, 0, 0);
  private readonly ay = new Vector3(0, 0, 1);
  private readonly centers: Vector3[] = [];
  private dirty: boolean[] = [];
  private elevationSin = 0.5;
  private csmAvailable: boolean;
  /** Texel snapping on/off (off only to demonstrate shimmer in the sandbox). */
  snap = true;

  constructor(csmAvailable: boolean) {
    this.csmAvailable = csmAvailable;
    this.group.name = 'xr.sun';
    for (let i = 0; i < MAX_CASCADES; i++) {
      const l = new DirectionalLight(0xffffff, 1);
      l.name = `xr.sun.${i}`;
      l.castShadow = false;
      l.visible = i === 0;
      l.shadow.autoUpdate = false;
      l.shadow.needsUpdate = true;
      l.shadow.radius = 1;
      this.group.add(l);
      this.group.add(l.target);
      this.lights.push(l);
      this.centers.push(new Vector3());
      this.dirty.push(true);
    }
    this.setDirection(this.dir);
  }

  get config(): ShadowConfig {
    return this.cfg;
  }

  get cascadeCount(): number {
    return this.cfg.count;
  }

  configure(cfg: ShadowConfig): void {
    const count = this.csmAvailable ? Math.min(cfg.count, MAX_CASCADES) : Math.min(cfg.count, 1);
    this.cfg = { ...cfg, count };
    for (let i = 0; i < MAX_CASCADES; i++) {
      const l = this.lights[i];
      const active = i < count;
      l.castShadow = active;
      l.visible = i === 0 || active;
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
      this.dirty[i] = true;
    }
    xrCsmUniform.value[3] = cfg.taps;
  }

  setLight(color: [number, number, number], intensity: number): void {
    for (let i = 0; i < MAX_CASCADES; i++) {
      this.lights[i].color.setRGB(color[0], color[1], color[2]);
      this.lights[i].intensity = intensity;
    }
  }

  setShadowIntensity(v: number): void {
    for (const l of this.lights) l.shadow.intensity = v;
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
    for (let i = 0; i < this.dirty.length; i++) this.dirty[i] = true;
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
      const due = this.dirty[i] || frame % every === phase;
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
    for (const l of this.lights) l.shadow.map?.dispose();
  }
}
