/// <reference lib="webworker" />
import type { CarVisualSpec, QualityLevel } from '../core/contracts';
import { buildCarData } from './build';

interface Req {
  id: number;
  spec: CarVisualSpec;
  quality: QualityLevel;
  cell?: number;
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, spec, quality, cell } = e.data;
  try {
    const data = await buildCarData(spec, quality, cell);
    const set = new Set<ArrayBufferLike>();
    for (const b of [data.lod0, data.lod1, data.lod2]) {
      set.add(b.vertices.buffer);
      set.add(b.index.buffer);
      set.add(b.glassIndex.buffer);
      set.add(b.paintIndex.buffer);
      if (b.colors) set.add(b.colors.buffer);
    }
    for (const ws of [data.wheels0, data.wheels1]) {
      for (const w of [ws.front, ws.rear, ws.caliperFront, ws.caliperRear]) {
        set.add(w.vertices.buffer);
        set.add(w.index.buffer);
      }
    }
    for (const w of [data.interior.cabin, data.interior.driver, data.interior.driverLite, data.interior.wheel]) {
      set.add(w.vertices.buffer);
      set.add(w.index.buffer);
    }
    const transfer = [...set] as Transferable[];
    (self as unknown as Worker).postMessage({ id, data }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
