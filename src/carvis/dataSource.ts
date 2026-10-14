/**
 * Geometry data provider: builds car geometry in a module Worker when available (falls back to the
 * main thread, e.g. in tests), and caches per car id + quality so any number of identical cars share it.
 */
import type { CarVisualSpec, QualityLevel } from '../core/contracts';
import { buildCarData, type CarData } from './build';

const cache = new Map<string, Promise<CarData>>();
/** A tiny pool: distinct car models build in parallel, requests go to the least-busy worker. */
interface Slot {
  worker: Worker;
  busy: number;
}
const slots: Slot[] = [];
let poolFailed = false;
let nextId = 1;
const pending = new Map<number, { resolve: (d: CarData) => void; reject: (e: Error) => void; slot: Slot }>();

function poolSize(): number {
  const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
  return Math.max(1, Math.min(3, Math.floor(hc / 4)));
}

function pickSlot(): Slot | null {
  if (typeof Worker === 'undefined' || poolFailed) return null;
  if (slots.length < poolSize()) {
    try {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      const slot: Slot = { worker, busy: 0 };
      worker.onmessage = (e: MessageEvent<{ id: number; data?: CarData; error?: string }>) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        p.slot.busy--;
        if (e.data.data) p.resolve(e.data.data);
        else p.reject(new Error(e.data.error ?? 'car worker failed'));
      };
      worker.onerror = () => {
        // the worker could not start: fall back to inline builds for everything pending / future
        poolFailed = true;
        for (const [id, p] of pending) {
          pending.delete(id);
          p.reject(new Error('car worker failed'));
        }
      };
      slots.push(slot);
      return slot;
    } catch {
      poolFailed = true;
      return null;
    }
  }
  let best = slots[0];
  for (const sl of slots) if (sl.busy < best.busy) best = sl;
  return best ?? null;
}

export function loadCarData(id: string, spec: CarVisualSpec, quality: QualityLevel, forceInline = false, cell?: number): Promise<CarData> {
  const key = `${id}|${quality}|${cell ?? ''}|${JSON.stringify(spec)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const slot = forceInline ? null : pickSlot();
  const p = slot
    ? new Promise<CarData>((resolve, reject) => {
        const rid = nextId++;
        slot.busy++;
        pending.set(rid, { resolve, reject, slot });
        slot.worker.postMessage({ id: rid, spec, quality, cell });
      }).catch(() => buildCarData(spec, quality, cell))
    : buildCarData(spec, quality, cell);
  cache.set(key, p);
  return p;
}
