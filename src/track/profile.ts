/**
 * Elevation (PVI + parabolic vertical curves), smooth key interpolation (bank / widths), and the
 * per-side cross-section channels painted from zones (curbs, runoff bands, barriers).
 */
import { boxBlurPeriodic, mod, smootherstep, smoothstep } from './math';
import type { CornerInfo } from './plan';
import { resolveMark } from './plan';
import type { Band, BarrierKind, CurbKind, Key, Mark, PlanEl, Pvi, SideSel, SideStyle, TrackDef, TurnEl, Zone } from './types';
import { BAR_CODE, CURB_AMP, CURB_BASE, CURB_CODE, SURF_CODE } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Elevation
// ─────────────────────────────────────────────────────────────────────────────

interface RPvi {
  s: number;
  y: number;
  vc: number;
}

export function buildElevation(pvis: Pvi[], marks: Map<string, number>, L: number, N: number, spacing: number): Float64Array {
  const sorted = pvis.map((p) => ({ s: resolveMark(marks, L, p.at), p })).sort((a, b) => a.s - b.s);
  const base: RPvi[] = [];
  for (const { s, p } of sorted) {
    let y = p.y;
    if (y === undefined) {
      if (p.grade === undefined || !base.length) throw new Error(`PVI at ${typeof p.at === 'string' ? p.at : p.at[0]} needs y (first) or grade`);
      const prev = base[base.length - 1];
      y = prev.y + p.grade * (s - prev.s);
    }
    base.push({ s, y, vc: p.vc ?? 0 });
  }
  const k = base.length;
  if (k < 2) throw new Error('need at least two PVIs');
  const ext: RPvi[] = [];
  for (const off of [-1, 0, 1]) for (const p of base) ext.push({ s: p.s + off * L, y: p.y, vc: p.vc });
  const m = ext.length;
  // validate that vertical curves do not overlap
  const overlaps: string[] = [];
  for (let j = 0; j < m - 1; j++) {
    const gap = ext[j + 1].s - ext[j].s;
    if (ext[j].vc / 2 + ext[j + 1].vc / 2 > gap + 1e-6) {
      overlaps.push(`s=${mod(ext[j].s, L).toFixed(0)}: gap ${gap.toFixed(1)} < ${((ext[j].vc + ext[j + 1].vc) / 2).toFixed(1)} (vc ${ext[j].vc}+${ext[j + 1].vc})`);
    }
  }
  if (overlaps.length) throw new Error(`vertical curves overlap: ${overlaps.join('; ')}`);
  const grade = (j: number) => (ext[j + 1].y - ext[j].y) / (ext[j + 1].s - ext[j].s);
  const out = new Float64Array(N + 1);
  let j = 0;
  for (let i = 0; i <= N; i++) {
    const s = i * spacing;
    while (j < m - 2 && ext[j + 1].s <= s) j++;
    // segment j: from ext[j] to ext[j+1]
    const a = ext[j];
    const b = ext[j + 1];
    let y: number | null = null;
    // curve at a (PVI j), entering from segment j-1
    if (a.vc > 0 && j > 0 && s < a.s + a.vc / 2) {
      const gIn = grade(j - 1);
      const gOut = grade(j);
      const x = s - (a.s - a.vc / 2);
      const yStart = a.y - (gIn * a.vc) / 2;
      y = yStart + gIn * x + ((gOut - gIn) * x * x) / (2 * a.vc);
    } else if (b.vc > 0 && j + 2 < m && s > b.s - b.vc / 2) {
      const gIn = grade(j);
      const gOut = grade(j + 1);
      const x = s - (b.s - b.vc / 2);
      const yStart = b.y - (gIn * b.vc) / 2;
      y = yStart + gIn * x + ((gOut - gIn) * x * x) / (2 * b.vc);
    }
    if (y === null) y = a.y + grade(j) * (s - a.s);
    out[i] = y;
  }
  // The last sample duplicates the first (closed loop).
  out[N] = out[0];
  // mild smoothing (rounds the curvature steps of the parabolic curves)
  const tmp = new Float64Array(N);
  tmp.set(out.subarray(0, N));
  const r = Math.max(1, Math.round(5 / spacing));
  boxBlurPeriodic(tmp, N, r, 3);
  out.set(tmp);
  out[N] = out[0];
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Keys (smootherstep between keys, periodic)
// ─────────────────────────────────────────────────────────────────────────────

export function interpKeys(keys: Key[], marks: Map<string, number>, L: number, N: number, spacing: number, scale = 1): Float64Array {
  const rk = keys.map((k) => ({ s: resolveMark(marks, L, k.at), v: k.v * scale }));
  rk.sort((a, b) => a.s - b.s);
  const out = new Float64Array(N + 1);
  const n = rk.length;
  if (n === 0) return out;
  if (n === 1) {
    out.fill(rk[0].v);
    return out;
  }
  const ext: { s: number; v: number }[] = [];
  for (const off of [-1, 0, 1]) for (const k of rk) ext.push({ s: k.s + off * L, v: k.v });
  let j = 0;
  for (let i = 0; i <= N; i++) {
    const s = i * spacing;
    while (j < ext.length - 2 && ext[j + 1].s <= s) j++;
    const a = ext[j];
    const b = ext[j + 1];
    const span = b.s - a.s;
    const t = span > 1e-9 ? (s - a.s) / span : 0;
    out[i] = a.v + (b.v - a.v) * smootherstep(0, 1, t);
  }
  out[N] = out[0];
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-section channels
// ─────────────────────────────────────────────────────────────────────────────

export interface SideChannels {
  curbW: Float64Array;
  curbK: Uint8Array;
  /** Curb relief (m): base ramp height and ridge amplitude, tapered with the width and smoothed along s. */
  curbH0: Float64Array;
  curbH1: Float64Array;
  b1W: Float64Array;
  b1S: Uint8Array;
  b2W: Float64Array;
  b2S: Uint8Array;
  /** Smoothed 0..1 gravel fractions of band 1 / band 2 (drives the shallow gravel-bed depression). */
  bowl1: Float64Array;
  bowl2: Float64Array;
  barrier: Uint8Array;
  cross: Float64Array;
}
export interface Channels {
  L: SideChannels;
  R: SideChannels;
  /** Surface code of the road itself per sample (asphalt unless the track is a winter circuit: packed snow, ice on a frozen lake). */
  road: Uint8Array;
}

function newSide(N: number): SideChannels {
  return {
    curbW: new Float64Array(N + 1),
    curbK: new Uint8Array(N + 1),
    curbH0: new Float64Array(N + 1),
    curbH1: new Float64Array(N + 1),
    b1W: new Float64Array(N + 1),
    b1S: new Uint8Array(N + 1),
    b2W: new Float64Array(N + 1),
    b2S: new Uint8Array(N + 1),
    bowl1: new Float64Array(N + 1),
    bowl2: new Float64Array(N + 1),
    barrier: new Uint8Array(N + 1),
    cross: new Float64Array(N + 1),
  };
}

interface Painter {
  N: number;
  spacing: number;
  L: number;
}

function forRange(p: Painter, s0: number, s1: number, fn: (i: number) => void): void {
  const { N, spacing, L } = p;
  s0 = mod(s0, L);
  s1 = mod(s1, L);
  const i0 = Math.ceil(s0 / spacing - 1e-9);
  const i1 = Math.floor(s1 / spacing + 1e-9);
  if (s0 <= s1) {
    for (let i = i0; i <= i1 && i < N; i++) fn(i);
  } else {
    for (let i = i0; i < N; i++) fn(i);
    for (let i = 0; i <= i1 && i < N; i++) fn(i);
  }
}

function paintBands(ch: SideChannels, i: number, bands: Band[]): void {
  const a = bands[0];
  const b = bands[1];
  if (a) {
    ch.b1W[i] = a.w;
    ch.b1S[i] = SURF_CODE[a.surf];
  } else {
    ch.b1W[i] = 0;
  }
  if (b) {
    ch.b2W[i] = b.w;
    ch.b2S[i] = SURF_CODE[b.surf];
  } else {
    ch.b2W[i] = 0;
    ch.b2S[i] = ch.b1S[i];
  }
}

const CURB_W: Record<CurbKind, number> = { none: 0, apex: 1.35, exit: 1.05, chicane: 1.5 };

function sidesFor(sel: SideSel, ch: Channels): SideChannels[] {
  return sel === 'L' ? [ch.L] : sel === 'R' ? [ch.R] : [ch.L, ch.R];
}

export function buildChannels(def: TrackDef, marks: Map<string, number>, corners: CornerInfo[], N: number, spacing: number, L: number): Channels {
  const ch: Channels = { L: newSide(N), R: newSide(N), road: new Uint8Array(N + 1) };
  const painter: Painter = { N, spacing, L };
  ch.road.fill(SURF_CODE[def.winter?.road ?? (def.winter ? 'snow' : 'asphalt')]);
  for (const p of def.winter?.patches ?? []) {
    const code = SURF_CODE[p.surf];
    forRange(painter, resolveMark(marks, L, p.from), resolveMark(marks, L, p.to), (i) => {
      ch.road[i] = code;
    });
  }
  ch.road[N] = ch.road[0];
  const sides: [SideChannels, Band[], BarrierKind][] = [
    [ch.L, def.defaults.bandsL, def.defaults.barrierL],
    [ch.R, def.defaults.bandsR, def.defaults.barrierR],
  ];
  for (const [c, bands, bar] of sides) {
    for (let i = 0; i <= N; i++) {
      paintBands(c, i, bands);
      c.barrier[i] = BAR_CODE[bar];
      c.cross[i] = def.defaults.cross;
    }
  }

  const paintZone = (z: Zone, s0: number, s1: number) => {
    for (const c of sidesFor(z.side, ch)) {
      forRange(painter, s0, s1, (i) => {
        if (z.curb !== undefined) {
          c.curbK[i] = CURB_CODE[z.curb];
          c.curbW[i] = z.curb === 'none' ? 0 : (z.curbW ?? CURB_W[z.curb]);
        }
        if (z.bands) paintBands(c, i, z.bands);
        if (z.barrier !== undefined) c.barrier[i] = BAR_CODE[z.barrier];
        if (z.cross !== undefined) c.cross[i] = z.cross;
      });
    }
  };

  // Auto zones from corners (curbs + optional inside/outside styles)
  for (const c of corners) {
    const el: TurnEl = c.el;
    const inside: SideSel = c.dir > 0 ? 'L' : 'R';
    const outside: SideSel = c.dir > 0 ? 'R' : 'L';
    const before = el.zoneBefore ?? 40;
    const after = el.zoneAfter ?? 30;
    const styleZone = (side: SideSel, st: SideStyle | undefined) => {
      if (!st) return;
      paintZone({ side, from: '', to: '', bands: st.bands, barrier: st.barrier, cross: st.cross }, c.sStart - before, c.sEnd + after);
    };
    styleZone(inside, el.inside);
    styleZone(outside, el.outside);
    const wantCurbs = def.curbs !== false && c.angle > (15 * Math.PI) / 180 && c.radius <= 320;
    const ci: CurbKind = el.curbIn ?? (wantCurbs ? 'apex' : 'none');
    const co: CurbKind = el.curbOut ?? (wantCurbs ? 'exit' : 'none');
    const arcLen = c.sArcB - c.sArcA;
    if (ci !== 'none') {
      paintZone({ side: inside, from: '', to: '', curb: ci }, c.sArcA - 14, c.sArcB + 10);
    }
    if (co !== 'none') {
      paintZone({ side: outside, from: '', to: '', curb: co }, c.sArcA + arcLen * 0.5, c.sEnd + 22);
    }
  }
  // Explicit zones
  for (const z of def.zones) paintZone(z, resolveMark(marks, L, z.from), resolveMark(marks, L, z.to));
  // Tunnels: close concrete walls 2.2 m beyond the asphalt, no curbs
  for (const tn of def.tunnels ?? []) {
    paintZone({ side: 'B', from: tn.from, to: tn.to, curb: 'none', bands: [{ surf: 'concrete', w: 2.2 }], barrier: 'tunnel', cross: -0.02 }, resolveMark(marks, L, tn.from), resolveMark(marks, L, tn.to));
  }

  const minRun = def.minRunoff ?? 3;
  // Smooth the width-like channels, propagate curb kind across the tapered ends.
  const r1 = Math.max(1, Math.round(8 / spacing));
  const r2 = Math.max(1, Math.round(5 / spacing));
  for (const c of [ch.L, ch.R]) {
    // keep a copy of kinds to propagate
    for (const arr of [c.curbW, c.b1W, c.b2W, c.cross]) {
      const tmp = new Float64Array(N);
      tmp.set(arr.subarray(0, N));
      boxBlurPeriodic(tmp, N, arr === c.curbW ? r2 : r1, 2);
      arr.set(tmp);
      arr[N] = arr[0];
    }
    const kinds = new Uint8Array(c.curbK);
    const reach = Math.round(14 / spacing);
    for (let i = 0; i < N; i++) {
      if (c.curbW[i] > 0.02) {
        if (kinds[i] === 0) {
          for (let k = 1; k <= reach; k++) {
            const a = kinds[mod(i - k, N)];
            const b = kinds[mod(i + k, N)];
            if (a || b) {
              c.curbK[i] = a || b;
              break;
            }
          }
        }
      } else {
        c.curbW[i] = 0;
        c.curbK[i] = 0;
      }
    }
    c.curbK[N] = c.curbK[0];
    // Relief heights from the kind, smoothed along s and tapered with the width so a curb never ends in a needle.
    const h0 = new Float64Array(N);
    const h1 = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      h0[i] = CURB_BASE[c.curbK[i]];
      h1[i] = CURB_AMP[c.curbK[i]];
    }
    const rr = Math.max(1, Math.round(3 / spacing));
    boxBlurPeriodic(h0, N, rr, 2);
    boxBlurPeriodic(h1, N, rr, 2);
    for (let i = 0; i < N; i++) {
      const tp = smoothstep(0.1, 0.7, c.curbW[i]);
      c.curbH0[i] = h0[i] * tp;
      c.curbH1[i] = h1[i] * tp;
    }
    c.curbH0[N] = c.curbH0[0];
    c.curbH1[N] = c.curbH1[0];
    // minimum runoff
    for (let i = 0; i <= N; i++) {
      if (c.b1W[i] + c.b2W[i] < minRun) c.b1W[i] = minRun - c.b2W[i];
    }
    // Limit how fast the barrier line may move sideways (runoff tapers open at <= ~11 degrees); widen, never narrow.
    {
      const maxStep = 0.2 * spacing;
      const widen = (i: number, need: number) => {
        const ext = c.curbW[i] + c.b1W[i] + c.b2W[i];
        if (ext < need) {
          if (c.b2W[i] > 0.05) c.b2W[i] += need - ext;
          else c.b1W[i] += need - ext;
        }
      };
      for (let pass = 0; pass < 2; pass++) {
        for (let k = 1; k <= 2 * N; k++) {
          const i = k % N;
          const im = (k - 1) % N;
          widen(i, c.curbW[im] + c.b1W[im] + c.b2W[im] - maxStep);
        }
        for (let k = 2 * N - 1; k >= 0; k--) {
          const i = k % N;
          const ip = (k + 1) % N;
          widen(i, c.curbW[ip] + c.b1W[ip] + c.b2W[ip] - maxStep);
        }
      }
      c.b1W[N] = c.b1W[0];
      c.b2W[N] = c.b2W[0];
    }
    // gravel bed depression fractions, smoothed along s so the depth never steps
    {
      // (a bed of gravel sits 4 cm low; loose snow, a car's wheels sink into, 7 cm)
      const GRAVEL = SURF_CODE.gravel;
      const DEEP = SURF_CODE.deepsnow;
      const bowlOf = (code: number) => (code === GRAVEL ? 1 : code === DEEP ? 1.75 : 0);
      const f1 = new Float64Array(N);
      const f2 = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        f1[i] = bowlOf(c.b1S[i]);
        f2[i] = bowlOf(c.b2S[i]);
      }
      const rb = Math.max(1, Math.round(6 / spacing));
      boxBlurPeriodic(f1, N, rb, 2);
      boxBlurPeriodic(f2, N, rb, 2);
      c.bowl1.set(f1);
      c.bowl2.set(f2);
      c.bowl1[N] = c.bowl1[0];
      c.bowl2[N] = c.bowl2[0];
    }
  }
  return ch;
}

export function resolveZonesMark(marks: Map<string, number>, L: number, m: Mark): number {
  return resolveMark(marks, L, m);
}

export type { PlanEl };
