/**
 * Track module public API (see src/core/systems.ts).
 *   TRACKS, loadTrackRuntime(), buildTrackScene()
 */
import type { TrackRuntime } from '../core/contracts';
import type { TrackEntry, TrackScene, TrackSceneOptions } from '../core/systems';
import { buildRuntime } from './build';
import { aurelia } from './defs/aurelia';
import { brennwald } from './defs/brennwald';
import { kuroyama } from './defs/kuroyama';
import { isvik } from './defs/isvik';
import { portovela } from './defs/portovela';
import type { TrackRuntimeImpl } from './runtime';
import type { TrackDef } from './types';

const DEFS: Record<string, TrackDef> = { aurelia, kuroyama, brennwald, portovela, isvik };

export const TRACKS: TrackEntry[] = Object.values(DEFS).map((d) => ({ info: d.info }));

const cache = new Map<string, TrackRuntimeImpl>();

/** Headless, synchronous. Runtimes are immutable, so they are cached per id. */
export function loadTrackRuntime(id: string): TrackRuntime {
  let rt = cache.get(id);
  if (!rt) {
    const def = DEFS[id];
    if (!def) throw new Error(`Unknown track '${id}'`);
    rt = buildRuntime(def);
    cache.set(id, rt);
  }
  return rt;
}

export async function buildTrackScene(rt: TrackRuntime, opts: TrackSceneOptions): Promise<TrackScene> {
  const mod = await import('./scene/buildScene');
  return mod.buildTrackScene(rt as TrackRuntimeImpl, opts);
}

export type { TrackRuntimeImpl };
