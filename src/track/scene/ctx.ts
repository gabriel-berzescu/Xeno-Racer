/**
 * Shared state for the scene builders.
 */
import * as THREE from 'three';
import type { EnvironmentState, QualityLevel } from '../../core/contracts';
import type { TrackSceneOptions } from '../../core/systems';
import { mulberry32 } from '../math';
import type { TrackRuntimeImpl } from '../runtime';
import type { TrackTextures } from './textures';

export interface QualityParams {
  level: QualityLevel;
  /** 0 low .. 3 ultra */
  tier: number;
  aniso: number;
  /** Tree density multiplier (includes the user's vegetation slider). */
  trees: number;
  /** Crowd detail 0..1 */
  crowd: number;
  /** Grass tufts near the camera */
  tufts: boolean;
  /** Terrain shader: number of splat layers */
  splatLayers: number;
  /** Extra texture detail in shaders (macro variation, cracks, patches). */
  rich: boolean;
  /** Terrain tile resolution multiplier (cells per tile side). */
  terrainRes: number;
  /** Max distance (m) at which full-detail trees/props are drawn. */
  propRange: number;
  shadows: boolean;
}

export function qualityParams(level: QualityLevel, vegetation: number, maxAniso: number): QualityParams {
  const tier = { low: 0, medium: 1, high: 2, ultra: 3 }[level];
  return {
    level,
    tier,
    aniso: Math.min(maxAniso, [2, 4, 8, 16][tier]),
    trees: vegetation * [0.45, 0.75, 1, 1.25][tier],
    crowd: [0.35, 0.6, 1, 1][tier],
    tufts: tier >= 2,
    splatLayers: [2, 3, 4, 4][tier],
    rich: tier >= 1,
    terrainRes: [0.8, 0.95, 1, 1.2][tier],
    propRange: [260, 380, 520, 700][tier],
    shadows: true,
  };
}

export interface Ctx {
  rt: TrackRuntimeImpl;
  opts: TrackSceneOptions;
  q: QualityParams;
  root: THREE.Group;
  tex: TrackTextures;
  rng: () => number;
  env: EnvironmentState;
  /** Called every frame. */
  updaters: Array<(dt: number, camera: THREE.Camera, time: number) => void>;
  disposables: Array<{ dispose(): void }>;
  /** Materials with an emissive that should follow `env.darkness`. */
  nightGlow: Array<{ mat: THREE.MeshStandardMaterial; day: number; night: number }>;
  /** Called when the environment changes. */
  envListeners: Array<(env: EnvironmentState) => void>;
  /** Tiles / cells / etc. that already occupy ground (for scenery placement): returns true if (x,z) is reserved. */
  reserved: Array<(x: number, z: number, margin: number) => boolean>;
  /** Samples where a rock cut face replaces the barrier (per side). */
  rockFlags?: { L: Uint8Array; R: Uint8Array };
  progress: (f: number, label: string) => void;
}

export function newCtx(rt: TrackRuntimeImpl, opts: TrackSceneOptions, tex: TrackTextures, q: QualityParams): Ctx {
  return {
    rt,
    opts,
    q,
    root: new THREE.Group(),
    tex,
    rng: mulberry32(rt.def.seed ^ 0x9e3779b9),
    env: opts.env,
    updaters: [],
    disposables: [],
    nightGlow: [],
    envListeners: [],
    reserved: [],
    progress: (f, label) => opts.onProgress?.(f, label),
  };
}

/** Yield to the browser so the loading screen can repaint between heavy build steps. */
export function yieldFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}
