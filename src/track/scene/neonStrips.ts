/**
 * The light strips of a megacity circuit: one thin line of light along the top of the barrier on each side of the whole lap, through
 * every run-off, and the light it throws on the ground at the foot of the wall.
 *
 * The strip sits on the edge of the wall that faces the road (on the shoulder of a tyre wall; at the foot of a tunnel's lining), a
 * front face and a top face, and moves from one mount to the next over a few metres, so the line never breaks. The rows are the wall's
 * own samples, thinned where the wall runs straight.
 */
import { BAR_CODE } from '../types';
import { rowAtD } from './barriers';
import { NEON_CHUNK, type NeonKit, type RGB, nquad, nv, rgb } from './neonKit';

/** Where the strip sits on a barrier: its lower front corner, q metres out from the wall line and y above the ground. */
const MOUNT: Partial<Record<number, { q: number; y: number }>> = {
  [BAR_CODE.concrete]: { q: 0.15, y: 0.985 },
  [BAR_CODE.fence]: { q: 0.15, y: 0.905 },
  [BAR_CODE.tires]: { q: 0.05, y: 1.4 },
  // the lining of a tunnel leans in over the road: the line runs along its foot
  [BAR_CODE.tunnel]: { q: -0.1, y: 0.2 },
};
/** The strip's face toward the road and its top (m). */
const FACE = 0.13;
const TOP = 0.1;
/** The longest step between two rows (samples), and how far a skipped sample may lie from the chord (m). */
const MAX_STEP = 4;
const TOL = 0.005;

/**
 * The light on the ground: distances in from the wall (m) and the share of the light there (a line of light a metre up: half of it a
 * metre out, a fifth at two).
 */
const REACH = [0.04, 0.8, 1.8, 3.6];
const SHARE = [1, 0.6, 0.24, 0];
const TUNNEL_REACH = [0.12, 0.5, 1.2, 2.6];
const LIFT = 0.03;

export function buildStrips(kit: NeonKit): void {
  const strips = kit.def.strips;
  if (!strips) return;
  const rt = kit.rt;
  const N = rt.count;
  const h = rt.spacing;
  for (const sgn of [1, -1] as const) {
    const S = sgn > 0 ? rt.L : rt.R;
    const col: RGB = rgb(strips[sgn > 0 ? 0 : 1]);
    // the mount at every sample, eased from one kind of barrier to the next
    const on = new Uint8Array(N + 1);
    const tun = new Uint8Array(N + 1);
    const q0 = new Float32Array(N);
    const y0 = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const m = MOUNT[S.barrier[i]];
      if (!m) continue;
      on[i] = 1;
      tun[i] = S.barrier[i] === BAR_CODE.tunnel ? 1 : 0;
      q0[i] = m.q;
      y0[i] = m.y;
    }
    on[N] = on[0];
    tun[N] = tun[0];
    const EASE = 4;
    // the strip's lower front corner per sample, and the wall's foot under it
    const P = new Float32Array((N + 1) * 3);
    const O = new Float32Array((N + 1) * 2);
    for (let i = 0; i <= N; i++) {
      const k = i % N;
      if (!on[k]) continue;
      let q = 0;
      let y = 0;
      let n = 0;
      for (let e = -EASE; e <= EASE; e++) {
        const j = (k + e + N) % N;
        if (!on[j]) continue;
        q += q0[j];
        y += y0[j];
        n++;
      }
      const r = rowAtD(rt, sgn, i, S.wall[i]);
      P[i * 3] = r.x + r.ox * (q / n);
      P[i * 3 + 1] = r.y + y / n;
      P[i * 3 + 2] = r.z + r.oz * (q / n);
      O[i * 2] = r.ox;
      O[i * 2 + 1] = r.oz;
    }
    // may the samples between a and b be left out?
    const straight = (a: number, b: number): boolean => {
      if (tun[b] !== tun[a]) return false;
      const ax = P[a * 3];
      const ay = P[a * 3 + 1];
      const az = P[a * 3 + 2];
      const dx = P[b * 3] - ax;
      const dy = P[b * 3 + 1] - ay;
      const dz = P[b * 3 + 2] - az;
      const l2 = dx * dx + dy * dy + dz * dz || 1;
      for (let i = a + 1; i < b; i++) {
        const px = P[i * 3] - ax;
        const py = P[i * 3 + 1] - ay;
        const pz = P[i * 3 + 2] - az;
        const t = (px * dx + py * dy + pz * dz) / l2;
        const ex = px - dx * t;
        const ey = py - dy * t;
        const ez = pz - dz * t;
        if (ex * ex + ey * ey + ez * ez > TOL * TOL) return false;
      }
      return true;
    };
    const sheetRow = (i: number, reach: number[], out: number[], at: number): void => {
      const k = i % N;
      const wall = S.wall[i];
      for (let c = 0; c < reach.length; c++) {
        const d = wall - reach[c];
        out[at + c * 3] = rt.X[i] + sgn * rt.HLX[i] * d;
        out[at + c * 3 + 1] = rt.heightSD(k * h, sgn * d) + LIFT;
        out[at + c * 3 + 2] = rt.Z[i] + sgn * rt.HLZ[i] * d;
      }
    };
    const rowA: number[] = new Array(12).fill(0);
    const rowB: number[] = new Array(12).fill(0);
    const emit = (a: number, b: number): void => {
      const s = a * h;
      const inTunnel = tun[a] === 1;
      const tb = inTunnel ? kit.tunnelTube : kit.tube(s);
      const ox = O[a * 2];
      const oz = O[a * 2 + 1];
      const bx = O[b * 2];
      const bz = O[b * 2 + 1];
      const ax = P[a * 3];
      const ay = P[a * 3 + 1];
      const az = P[a * 3 + 2];
      const cx = P[b * 3];
      const cy = P[b * 3 + 1];
      const cz = P[b * 3 + 2];
      // the face toward the road
      {
        const v0 = nv(tb, ax, ay, az, -ox, 0, -oz, col);
        const v1 = nv(tb, cx, cy, cz, -bx, 0, -bz, col);
        const v2 = nv(tb, cx, cy + FACE, cz, -bx, 0, -bz, col);
        const v3 = nv(tb, ax, ay + FACE, az, -ox, 0, -oz, col);
        nquad(tb, v0, v1, v2, v3, -ox, 0, -oz);
      }
      // the top
      {
        const v0 = nv(tb, ax, ay + FACE, az, 0, 1, 0, col);
        const v1 = nv(tb, cx, cy + FACE, cz, 0, 1, 0, col);
        const v2 = nv(tb, cx + bx * TOP, cy + FACE, cz + bz * TOP, 0, 1, 0, col);
        const v3 = nv(tb, ax + ox * TOP, ay + FACE, az + oz * TOP, 0, 1, 0, col);
        nquad(tb, v0, v1, v2, v3, 0, 1, 0);
      }
      // its light on the ground
      const gb = inTunnel ? kit.tunnelGlow : kit.glow(s);
      const reach = inTunnel ? TUNNEL_REACH : REACH;
      sheetRow(a, reach, rowA, 0);
      sheetRow(b, reach, rowB, 0);
      for (let c = 0; c + 1 < reach.length; c++) {
        const v0 = nv(gb, rowA[c * 3], rowA[c * 3 + 1], rowA[c * 3 + 2], 0, 1, 0, col, SHARE[c]);
        const v1 = nv(gb, rowB[c * 3], rowB[c * 3 + 1], rowB[c * 3 + 2], 0, 1, 0, col, SHARE[c]);
        const v2 = nv(gb, rowB[c * 3 + 3], rowB[c * 3 + 4], rowB[c * 3 + 5], 0, 1, 0, col, SHARE[c + 1]);
        const v3 = nv(gb, rowA[c * 3 + 3], rowA[c * 3 + 4], rowA[c * 3 + 5], 0, 1, 0, col, SHARE[c + 1]);
        nquad(gb, v0, v1, v2, v3, 0, 1, 0);
      }
    };
    for (let c0 = 0; c0 < N; c0 += NEON_CHUNK) {
      const c1 = Math.min(N, c0 + NEON_CHUNK);
      let a = c0;
      while (a < c1) {
        if (!on[a] || !on[a + 1]) {
          a++;
          continue;
        }
        let b = a + 1;
        while (b < c1 && b - a < MAX_STEP && on[b + 1] && straight(a, b + 1)) b++;
        emit(a, b);
        a = b;
      }
    }
  }
}
