/**
 * Personal bests and ghost laps, persisted in localStorage (best effort — the game works without).
 */
const BEST_KEY = 'xeno-racer.bestlaps.v1';
const GHOST_KEY = (track: string, car: string) => `xeno-racer.ghost.v1.${track}.${car}`;

export function recordKey(trackId: string, carId: string): string {
  return `${trackId}/${carId}`;
}

export function loadBestLaps(): Record<string, number> {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    if (raw) {
      const o = JSON.parse(raw) as Record<string, number>;
      if (o && typeof o === 'object') return o;
    }
  } catch {
    /* ignore */
  }
  return {};
}

export function saveBestLap(trackId: string, carId: string, time: number): Record<string, number> {
  const all = loadBestLaps();
  const k = recordKey(trackId, carId);
  if (all[k] === undefined || time < all[k]) all[k] = time;
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
  return all;
}

/** A recorded lap: t, px, py, pz, qx, qy, qz, qw per sample. */
export interface GhostLap {
  time: number;
  samples: Float32Array;
}
const STRIDE = 8;

export function saveGhost(trackId: string, carId: string, g: GhostLap): void {
  try {
    const bytes = new Uint8Array(g.samples.buffer, g.samples.byteOffset, g.samples.byteLength);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    localStorage.setItem(GHOST_KEY(trackId, carId), JSON.stringify({ time: g.time, data: btoa(bin) }));
  } catch {
    /* quota — ghosts are a nicety */
  }
}

export function loadGhost(trackId: string, carId: string): GhostLap | null {
  try {
    const raw = localStorage.getItem(GHOST_KEY(trackId, carId));
    if (!raw) return null;
    const o = JSON.parse(raw) as { time: number; data: string };
    const bin = atob(o.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { time: o.time, samples: new Float32Array(bytes.buffer) };
  } catch {
    return null;
  }
}

/** Records the player's pose at ~20 Hz during a lap. */
export class GhostRecorder {
  private buf: number[] = [];
  private last = -1;

  reset(): void {
    this.buf = [];
    this.last = -1;
  }

  sample(t: number, p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }): void {
    if (t - this.last < 0.05) return;
    this.last = t;
    this.buf.push(t, p.x, p.y, p.z, q.x, q.y, q.z, q.w);
  }

  finish(lapTime: number): GhostLap {
    return { time: lapTime, samples: new Float32Array(this.buf) };
  }
}

/** Interpolated pose of a ghost lap at time t (seconds since lap start). */
export function ghostPose(g: GhostLap, t: number, outP: { set(x: number, y: number, z: number): unknown }, outQ: { set(x: number, y: number, z: number, w: number): unknown; slerp?: unknown }): boolean {
  const s = g.samples;
  const n = s.length / STRIDE;
  if (n < 2 || t < 0 || t > s[(n - 1) * STRIDE]) return false;
  // binary search
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid * STRIDE] <= t) lo = mid;
    else hi = mid;
  }
  const a = lo * STRIDE;
  const b = hi * STRIDE;
  const f = Math.min(1, Math.max(0, (t - s[a]) / Math.max(1e-6, s[b] - s[a])));
  outP.set(s[a + 1] + (s[b + 1] - s[a + 1]) * f, s[a + 2] + (s[b + 2] - s[a + 2]) * f, s[a + 3] + (s[b + 3] - s[a + 3]) * f);
  // nlerp is plenty at 20 Hz
  let qx = s[a + 4] + (s[b + 4] - s[a + 4]) * f;
  let qy = s[a + 5] + (s[b + 5] - s[a + 5]) * f;
  let qz = s[a + 6] + (s[b + 6] - s[a + 6]) * f;
  let qw = s[a + 7] + (s[b + 7] - s[a + 7]) * f;
  const dot = s[a + 4] * s[b + 4] + s[a + 5] * s[b + 5] + s[a + 6] * s[b + 6] + s[a + 7] * s[b + 7];
  if (dot < 0) {
    qx = s[a + 4] - (s[b + 4] + s[a + 4]) * f;
    qy = s[a + 5] - (s[b + 5] + s[a + 5]) * f;
    qz = s[a + 6] - (s[b + 6] + s[a + 6]) * f;
    qw = s[a + 7] - (s[b + 7] + s[a + 7]) * f;
  }
  const l = Math.hypot(qx, qy, qz, qw) || 1;
  outQ.set(qx / l, qy / l, qz / l, qw / l);
  return true;
}
