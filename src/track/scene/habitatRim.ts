/**
 * The rim works of an orbital habitat (habitat.ts): what stands at the foot of the wall of glass that holds the air in.
 *
 * The sky draws the glass and its ribs; this is the masonry they stand on. A plinth runs along the crest of the bank: a splayed
 * foot, a battered wall with a fin every twenty metres, a recess with a line of warm light in it, a coping with a lamp on it every
 * twenty metres, an attic of glass (a walk behind windows) and a roof that ends at the glass. Under each rib a pier sweeps up out of
 * the plinth and narrows to the rib's own width at the height where the sky's rib begins, its face in the plane of the glass there, a
 * lift shaft of glass up its middle and a collar of gold at the joint. Half way between, a pilaster on the plinth and a slim
 * mullion above it that dies into the glass. A gallery is a long lens of glass riding on the plinth's roof: the place to stand and
 * look out at the planet.
 *
 * Everything is laid out in the ring's own coordinates: `s` metres along the turn of the ring from its lowest line (north
 * positive), `d` metres in from the plane of the glass, `h` metres above the crest of the bank along the local vertical, which
 * leans back over the circuit as the floor climbs. A rib of the sky stands at s = k * pitch.
 */
import type { OrbitalRing } from '../../core/contracts';
import type { HabitatDef } from '../types';
import type { Ctx } from './ctx';
import { HabBuf, LAMP, PAL, type HabLights, type Surf, type V3 } from './habitatKit';

/** The plinth is a strip of flat pieces this long (m): the ring's curve and the ground's swell are followed at this step. */
const STEP = 10;
/** One mesh per this many metres of the rim. */
const CHUNK = 960;

interface PPt {
  d: number;
  h: number;
  /** The surface from this point to the next, and its panes when it is glazing (floors up). */
  s: Surf;
  floors?: number;
}

/** The plinth's cross-section, walked from the foot up to the glass; `e` (0..1) is how much of a gallery rides on the roof here. */
function section(e: number, seed: number): PPt[] {
  const white = PAL.white;
  const shell = PAL.shell;
  const glass = { ...PAL.glass, seed };
  const pts: PPt[] = [
    // a splayed foot, under the grass wherever the ground is whole (the terrain's last cells fall away toward the rim)
    { d: 27, h: -11, s: shell },
    { d: 9.0, h: -1.5, s: shell },
    // the battered wall
    { d: 6.6, h: 8.6, s: shell },
    // the recess, and the line of light in it
    { d: 5.8, h: 8.75, s: PAL.cove },
    { d: 5.8, h: 9.55, s: white },
    // the coping
    { d: 7.4, h: 9.85, s: white },
    { d: 7.4, h: 11.0, s: white },
    { d: 7.0, h: 11.3, s: shell },
    // the attic: a walk behind glass
    { d: 4.6, h: 11.3, s: glass, floors: 1 },
    { d: 4.6, h: 13.7, s: white },
    { d: 5.2, h: 13.8, s: white },
    { d: 5.2, h: 14.3, s: white },
  ];
  // the gallery: a soffit swept out over the coping, a wall of glass leaning back, a roof
  const gl = { ...PAL.glassLit, seed: seed + 0.37 };
  pts.push(
    { d: 5.2 + 6.0 * e, h: 14.3 + 0.5 * e, s: white },
    { d: 5.2 + 7.6 * e, h: 14.3 + 1.9 * e, s: gl, floors: 1 },
    { d: 5.2 + 7.1 * e, h: 14.3 + 6.3 * e, s: white },
    { d: 5.2 + 7.9 * e, h: 14.3 + 6.45 * e, s: white },
    { d: 5.2 + 7.9 * e, h: 14.3 + 6.9 * e, s: PAL.bone },
    { d: 0, h: 14.6 + 7.8 * e, s: white },
  );
  return pts;
}

/** How many of a section's points are the plinth's own (the rest are the gallery's). */
const BASE = 12;

/** The world's ground must stay clear of the works within this many metres of the plane of the glass. */
const KEEP = 24;

export function emitRim(ctx: Ctx, def: NonNullable<HabitatDef['rim']>, ring: OrbitalRing, lights: HabLights): { bufs: HabBuf[]; reserve: (x: number, z: number, m: number) => boolean } {
  const rt = ctx.rt;
  const R = ring.radius;
  const X = ring.rims[def.side];
  // (which way is in: toward lower x from the rim at the higher x)
  const sg = def.side === 1 ? 1 : -1;
  const pitch = def.pitch ?? 240;
  const pierTop = def.pier ?? 45;
  const n = Math.round(def.reach / STEP);

  // the crest of the bank at every station, as a height above the ring's true floor, smoothed so that the coping runs clean
  const raw = new Float32Array(2 * n + 1);
  for (let i = -n; i <= n; i++) {
    const th = (i * STEP) / R;
    let h = 0;
    for (let it = 0; it < 3; it++) {
      const z = ring.z + (R - h) * Math.sin(th);
      const g = rt.fieldHeight(X - sg * 9, z);
      h = R - (ring.y + R - g) / Math.cos(th);
    }
    raw[i + n] = h;
  }
  const hg = new Float32Array(2 * n + 1);
  for (let i = 0; i <= 2 * n; i++) {
    let sum = 0;
    let w = 0;
    for (let k = -4; k <= 4; k++) {
      const j = Math.min(2 * n, Math.max(0, i + k));
      const wk = 5 - Math.abs(k);
      sum += raw[j] * wk;
      w += wk;
    }
    hg[i] = sum / w;
  }
  const crest = (s: number): number => {
    const f = Math.min(2 * n - 1e-6, Math.max(0, s / STEP + n));
    const i = Math.floor(f);
    return hg[i] + (hg[i + 1] - hg[i]) * (f - i);
  };
  /** The world point at s along the turn, d in from the glass, h above the crest. */
  const W = (s: number, d: number, h: number): V3 => {
    const th = s / R;
    const r = R - crest(s) - h;
    return [X - sg * d, ring.y + R - r * Math.cos(th), ring.z + r * Math.sin(th)];
  };
  /** A direction in the section's plane at s: `nd` inward, `nh` up. */
  const N = (s: number, nd: number, nh: number): V3 => {
    const th = s / R;
    return [-sg * nd, nh * Math.cos(th), -nh * Math.sin(th)];
  };

  // how much of a gallery rides on the roof at s: a lens, full in the middle and nothing at its ends
  const galleries = def.galleries ?? [];
  const gal = (s: number): number => {
    let e = 0;
    for (const g of galleries) {
      const t = (s - g.at) / (g.length / 2);
      if (Math.abs(t) < 1) e = Math.max(e, Math.pow(1 - t * t, 0.62));
    }
    return e;
  };

  const chunks = new Map<number, HabBuf>();
  const bufAt = (s: number): HabBuf => {
    const k = Math.floor((s + def.reach) / CHUNK);
    let b = chunks.get(k);
    if (!b) chunks.set(k, (b = new HabBuf()));
    return b;
  };

  // ── the plinth ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  for (let i = -n; i < n; i++) {
    const s0 = i * STEP;
    const s1 = s0 + STEP;
    const buf = bufAt(s0 + STEP / 2);
    const e0 = gal(s0);
    const e1 = gal(s1);
    const seed = 0.11 + (((i % 97) + 97) % 97) * 0.013;
    const p0 = section(e0, seed);
    const p1 = section(e1, seed);
    const full = e0 > 0 || e1 > 0;
    const last = full ? p0.length - 1 : BASE;
    for (let k = 0; k < last; k++) {
      const a = p0[k];
      const d = p1[k];
      // without a gallery the roof runs from the attic's edge straight to the glass
      const roof = !full && k === BASE - 1;
      const b = roof ? p0[p0.length - 1] : p0[k + 1];
      const c = roof ? p1[p1.length - 1] : p1[k + 1];
      const dd = (b.d - a.d + c.d - d.d) / 2;
      const dh = (b.h - a.h + c.h - d.h) / 2;
      if (Math.abs(dd) + Math.abs(dh) < 1e-4) continue;
      const uv: [number, number][] | undefined = a.floors ? [[s0 / 2.5, 0], [s0 / 2.5, a.floors], [s1 / 2.5, a.floors], [s1 / 2.5, 0]] : undefined;
      buf.quad(W(s0, a.d, a.h), W(s0, b.d, b.h), W(s1, c.d, c.h), W(s1, d.d, d.h), a.s, { toward: N(s0, dh, -dd), uv });
    }
  }

  // ── fins, lamps, pilasters, mullions and piers ────────────────────────────────────────────────────────────────────────────────
  const fin = (buf: HabBuf, s: number, hw: number, proud: number, top: number, surfc: Surf): void => {
    // a rib standing on the batter: its front edge `proud` m out at the foot, flush under the recess
    const batter = (h: number): number => 9.0 + ((6.6 - 9.0) * (h + 1.5)) / 10.1;
    const hs = [-1.5, top];
    const f = (h: number): number => batter(h) + proud * (1 - (h + 1.5) / (top + 1.5)) + 0.25;
    for (let k = 0; k + 1 < hs.length; k++) {
      const h0 = hs[k];
      const h1 = hs[k + 1];
      buf.quad(W(s - hw, f(h0), h0), W(s + hw, f(h0), h0), W(s + hw, f(h1), h1), W(s - hw, f(h1), h1), surfc, { toward: N(s, 1, 0.2) });
      for (const sd of [-1, 1]) {
        const ss = s + sd * hw;
        buf.quad(W(ss, f(h0), h0), W(ss, batter(h0) - 0.3, h0), W(ss, batter(h1) - 0.3, h1), W(ss, f(h1), h1), surfc, { toward: [0, 0, sd] });
      }
    }
  };

  const pier = (buf: HabBuf, s: number): void => {
    const top = pierTop;
    const dOf = (h: number): number => (h <= 0 ? 13 - h * 0.8 : 13 * Math.pow(Math.max(0, 1 - h / top), 1.6));
    const wOf = (h: number): number => 9 - 3 * Math.min(1, Math.max(0, h / top));
    const hs = [-4, 0, 3, 6.5, 10.5, 14.6, 16, 20, 24.5, 29.5, 35, 41, top - 2.4, top];
    for (let k = 0; k + 1 < hs.length; k++) {
      const h0 = hs[k];
      const h1 = hs[k + 1];
      const d0 = dOf(h0);
      const d1 = dOf(h1);
      const w0 = wOf(h0) / 2;
      const w1 = wOf(h1) / 2;
      const gold = h0 >= top - 2.5;
      const shaft = h0 >= 16 && h1 <= 41;
      const body = gold ? PAL.gold : PAL.white;
      const toward = N(s, h1 - h0, d0 - d1);
      // the face in three strips: white, the lift shaft's glass, white
      const cuts = [-1, -0.75 / w0, 0.75 / w0, 1];
      const cuts1 = [-1, -0.75 / w1, 0.75 / w1, 1];
      for (let c = 0; c < 3; c++) {
        const mid = c === 1;
        const sf: Surf = mid && shaft ? { ...PAL.glassLit, win: 0.55, seed: 0.3 + s * 0.001 } : mid && !gold ? PAL.shell : body;
        const uv: [number, number][] | undefined = mid && shaft ? [[0, h0 / 3], [1, h0 / 3], [1, h1 / 3], [0, h1 / 3]] : undefined;
        buf.quad(W(s + cuts[c] * w0, d0, h0), W(s + cuts[c + 1] * w0, d0, h0), W(s + cuts1[c + 1] * w1, d1, h1), W(s + cuts1[c] * w1, d1, h1), sf, { toward, uv });
      }
      // the flanks, back to the plane of the glass
      for (const sd of [-1, 1]) {
        buf.quad(W(s + sd * w0, d0, h0), W(s + sd * w0, -0.6, h0), W(s + sd * w1, -0.6, h1), W(s + sd * w1, d1, h1), gold ? PAL.gold : PAL.shell, { toward: [0, 0, sd], k: [0.94, 0.8, 0.8, 0.94] });
      }
    }
  };

  const mullion = (buf: HabBuf, s: number): void => {
    // a slim secondary rib from the roof of the plinth, narrowing into the glass
    const hs = [14.4, 20, 27, 34, 40];
    const top = 40;
    for (let k = 0; k + 1 < hs.length; k++) {
      const h0 = hs[k];
      const h1 = hs[k + 1];
      const t0 = (h0 - 14.4) / (top - 14.4);
      const t1 = (h1 - 14.4) / (top - 14.4);
      const d0 = 3.4 * Math.pow(1 - t0, 1.5);
      const d1 = 3.4 * Math.pow(1 - t1, 1.5);
      const w0 = 1.3 - 0.9 * t0;
      const w1 = 1.3 - 0.9 * t1;
      buf.quad(W(s - w0, d0, h0), W(s + w0, d0, h0), W(s + w1, d1, h1), W(s - w1, d1, h1), PAL.white, { toward: N(s, h1 - h0, d0 - d1) });
      for (const sd of [-1, 1]) buf.quad(W(s + sd * w0, d0, h0), W(s + sd * w0, -0.4, h0), W(s + sd * w1, -0.4, h1), W(s + sd * w1, d1, h1), PAL.shell, { toward: [0, 0, sd], k: [0.94, 0.8, 0.8, 0.94] });
    }
  };

  const half = pitch / 2;
  for (let i = -n; i <= n; i++) {
    const s = i * STEP;
    const buf = bufAt(Math.min(def.reach - 1, Math.max(-def.reach + 1, s)));
    const onRib = Math.abs(s / pitch - Math.round(s / pitch)) < 1e-6;
    const onHalf = !onRib && Math.abs(s / half - Math.round(s / half)) < 1e-6;
    if (onRib) {
      pier(buf, s);
      // a slow white beacon where every other pier meets its rib
      if (Math.round(s / pitch) % 2 === 0) lights.add(W(s, 1.2, pierTop + 1.5), LAMP.white, 2.6, 7, (((Math.round(s / pitch) * 0.137) % 1) + 1) % 1);
    } else if (onHalf) {
      // a pilaster on the plinth, and the mullion above it unless a gallery rides there
      fin(buf, s, 1.9, 2.4, 9.85, PAL.white);
      if (gal(s) <= 0) mullion(buf, s);
    } else if (i % 2 === 0) {
      fin(buf, s, 0.55, 1.5, 8.6, PAL.white);
    } else {
      // a lamp on the coping, between two fins
      lights.add(W(s, 7.1, 11.75), LAMP.warm, 1.5, 2.6);
    }
  }
  // lamps under the lip of each gallery's roof
  for (const g of galleries) {
    for (let s = g.at - g.length / 2 + 15; s < g.at + g.length / 2 - 14; s += 10) {
      const e = gal(s);
      lights.add(W(s, 5.2 + 7.6 * e, 14.3 + 6.2 * e), LAMP.pale, 1.1, 2.2);
    }
  }

  const inner = X - sg * KEEP;
  return {
    bufs: [...chunks.keys()].sort((a, b) => a - b).map((k) => chunks.get(k)!),
    reserve: (x, _z, m) => (x - inner) * sg > -m,
  };
}
