/** Shared vertex-layout helpers (kept apart from build.ts to avoid import cycles). */
import { ZONE_STRIDE } from './blueprint';
import type { PartBuilder } from './parts';

/** floats per vertex: position 3 + normal 3 + zones 16 */
export const VERTEX_STRIDE = 6 + ZONE_STRIDE;

export interface PartData {
  /** interleaved [px py pz nx ny nz z0..z15] */
  vertices: Float32Array;
  index: Uint32Array;
}

export function partToData(pb: PartBuilder): PartData {
  const n = pb.vertexCount;
  const vertices = new Float32Array(n * VERTEX_STRIDE);
  for (let i = 0; i < n; i++) {
    const o = i * VERTEX_STRIDE;
    vertices[o] = pb.pos[i * 3];
    vertices[o + 1] = pb.pos[i * 3 + 1];
    vertices[o + 2] = pb.pos[i * 3 + 2];
    vertices[o + 3] = pb.nor[i * 3];
    vertices[o + 4] = pb.nor[i * 3 + 1];
    vertices[o + 5] = pb.nor[i * 3 + 2];
    for (let k = 0; k < ZONE_STRIDE; k++) vertices[o + 6 + k] = pb.zon[i * ZONE_STRIDE + k];
  }
  return { vertices, index: Uint32Array.from(pb.idx) };
}
