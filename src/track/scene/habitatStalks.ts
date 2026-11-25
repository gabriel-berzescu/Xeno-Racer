/**
 * The stalks of an orbital habitat (habitat.ts): towers hundreds of metres tall and a few tens thick, each one body of revolution
 * from its foot to the tip of its mast.
 *
 * A foot that flares out of the ground like the bole of a tree; a stem that tapers all the way up, white, with a band of glass
 * every few storeys; and what the stem carries. A `dish` is a garden held up like a cup: an underside swept out from the stem, a
 * line of light under its lip, a rim of glass two storeys high, a walk round the edge and inside it a lawn that rises toward the
 * stem, with trees, a pavilion or two and a few lamps. A `collar` is a bead of rooms round the stem, two bands of glass in it. A
 * `halo` is a ring that stands off the stem on struts like the ribs of an umbrella, glass on its outer face. At the top a lantern, a
 * cap and a mast with a slow white beacon at its tip.
 *
 * A stalk stands square to the floor of the ring, not to the circuit: its axis points at the ring's own axis, so one that stands
 * where the land has begun to climb leans back over the circuit with it.
 */
import type { OrbitalRing } from '../../core/contracts';
import type { StalkDef } from '../types';
import { mulberry32 } from '../math';
import type { TrackRuntimeImpl } from '../runtime';
import { HabBuf, LAMP, PAL, at, crown, frameAt, lathe, moved, ringUp, tube, type Frame, type HabLights, type LPt, type Surf, type V3 } from './habitatKit';

export interface StalkPlace {
  def: StalkDef;
  frame: Frame;
  /** The radius of the ground it holds (m). */
  keep: number;
  top: number;
}

/** The radius of the stem above the flare, and of the foot on the ground. */
function radii(def: StalkDef): { r0: number; rf: number } {
  const r0 = def.stem ?? 6 + def.height * 0.016;
  return { r0, rf: def.foot ?? r0 * 3.3 };
}

export function placeStalk(rt: TrackRuntimeImpl, ring: OrbitalRing, def: StalkDef): StalkPlace {
  const { rf } = radii(def);
  const keep = rf + (def.landmark ? 78 : 10);
  // the lowest ground under the foot carries it
  let y = rt.fieldHeight(def.x, def.z);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    y = Math.min(y, rt.fieldHeight(def.x + Math.cos(a) * keep, def.z + Math.sin(a) * keep));
  }
  return { def, frame: frameAt([def.x, y, def.z], ringUp(ring.radius, ring.z, def.z)), keep, top: def.height * (def.landmark ? 1.2 : 1.13) };
}

export function emitStalk(buf: HabBuf, lights: HabLights, place: StalkPlace, index: number): void {
  const def = place.def;
  const f = place.frame;
  const H = def.height;
  const rnd = mulberry32((def.seed ?? 7 + index * 131) * 2654435761);
  const { r0, rf } = radii(def);
  const r1 = r0 * 0.3;
  const hf = H * 0.17;
  const segs = def.landmark ? 48 : 32;
  /** The stem's radius at a height: a steady taper, and the flare of the foot under it. */
  const rs = (h: number): number => {
    const t = Math.min(1, Math.max(0, h / H));
    const taper = r0 + (r1 - r0) * Math.pow(t, 0.9);
    const fl = h < hf ? (rf - r0) * Math.pow(1 - Math.max(0, h) / hf, 2.7) : 0;
    return taper + fl;
  };
  const seed0 = rnd();
  const white = PAL.white;
  const pts: LPt[] = [];
  const period = 26 + rnd() * 12;
  const band = 6.4 + Math.floor(rnd() * 2) * 3.2;
  let nb = 0;

  /** The stem from hA to hB: white, with a band of glass every `period` metres. */
  const stem = (hA: number, hB: number): void => {
    let h = hA;
    pts.push({ r: rs(h), h, s: white, crease: true });
    while (h < hB - 0.5) {
      const room = hB - h;
      const w = Math.min(period - band, room);
      // (the flare is a curve: short pieces there)
      const pieces = h < hf ? Math.max(1, Math.ceil(w / 9)) : 1;
      for (let k = 1; k <= pieces; k++) pts.push({ r: rs(h + (w * k) / pieces), h: h + (w * k) / pieces });
      h += w;
      if (hB - h > band + 8) {
        const r = rs(h + band / 2);
        const floors = Math.round(band / 3.2);
        pts[pts.length - 1] = { r: rs(h), h, s: { ...PAL.glassDim, seed: seed0 + nb * 0.173 }, win: [Math.max(8, Math.round((2 * Math.PI * r) / 3.4)), floors], crease: true };
        nb++;
        h += band;
        pts.push({ r: rs(h), h, s: white, crease: true });
      } else if (room > w) {
        h = hB;
        pts.push({ r: rs(h), h });
      }
    }
  };

  const tiers = [...def.tiers].sort((a, b) => a.at - b.at);
  const gardens: { hd: number; R: number; rIn: number; yIn: number }[] = [];
  let cur = -16;

  // the landmark stands on two terraces of garden
  if (def.landmark) {
    const R2 = rf + 70;
    const R1 = rf + 34;
    pts.push(
      { r: R2, h: -16, s: PAL.shell, crease: true },
      { r: R2, h: 1.5, s: { ...PAL.glass, seed: seed0 + 0.61 }, win: [Math.round((2 * Math.PI * R2) / 3.6), 1], crease: true },
      { r: R2, h: 5.5, s: white, crease: true },
      { r: R2 + 0.9, h: 5.7, crease: true },
      { r: R2 + 0.9, h: 6.5, crease: true },
      { r: R2 - 5, h: 6.5, s: PAL.lawn, crease: true },
      { r: R1 + 1, h: 7.4, s: PAL.shell, crease: true },
      { r: R1, h: 7.4, s: { ...PAL.glassLit, seed: seed0 + 0.83 }, win: [Math.round((2 * Math.PI * R1) / 3.6), 2], crease: true },
      { r: R1, h: 14.5, s: white, crease: true },
      { r: R1 + 0.9, h: 14.7, crease: true },
      { r: R1 + 0.9, h: 15.5, crease: true },
      { r: R1 - 5, h: 15.5, s: PAL.lawn, crease: true },
      { r: rs(17) + 2, h: 17 },
    );
    gardens.push({ hd: 6.5, R: R2 - 5, rIn: R1 + 7, yIn: 7.3 }, { hd: 15.5, R: R1 - 5, rIn: rs(17) + 7, yIn: 16.9 });
    cur = 17;
  }

  for (const t of tiers) {
    const hd = t.at * H;
    if (t.kind === 'dish') {
      const R = t.r;
      const dd = Math.min(0.44 * R, hd - cur - 12);
      stem(cur, hd - dd);
      const ra = rs(hd - dd);
      // the cup: steep where it leaves the stem, level at the lip (shaded darker toward the stem)
      const NS = 9;
      for (let k = 0; k <= NS; k++) {
        const u = k / NS;
        const p: LPt = { r: ra + (R - ra) * u, h: hd - 3 - (dd - 3) * Math.pow(1 - u, 2.3), k: 0.66 + 0.3 * u };
        if (k === 0) {
          p.s = PAL.shell;
          p.crease = true;
        }
        // a line of warm light under the lip
        if (k === NS - 1) p.s = { ...PAL.cove, win: 2.3 };
        pts.push(p);
      }
      const yTop = hd + 3.7;
      const rIn = rs(yTop + 0.05 * R) + 7;
      const yIn = yTop + 0.3 + 0.05 * R;
      pts.push(
        { r: R, h: hd - 3, s: white, crease: true },
        { r: R + 0.9, h: hd - 2.7, s: { ...PAL.glassLit, win: 0.62, seed: seed0 + hd * 0.01 }, win: [Math.round((2 * Math.PI * R) / 3.6), 2], crease: true },
        { r: R + 0.5, h: hd + 2.7, s: white, crease: true },
        { r: R + 1.2, h: hd + 2.9, crease: true },
        { r: R + 1.2, h: yTop, s: PAL.bone, crease: true },
        { r: R - 6, h: yTop, s: PAL.lawn, crease: true },
        { r: rIn, h: yIn, k: 0.9 },
        { r: rs(yIn + 2) + 0.01, h: yIn + 2, k: 0.8 },
      );
      gardens.push({ hd: yTop, R: R - 7, rIn: rIn + 2, yIn });
      cur = yIn + 2;
    } else if (t.kind === 'collar') {
      const R = t.r;
      const a = Math.min(R * 0.62, (hd - cur) * 0.8);
      stem(cur, hd - a);
      const bulge = (u: number): number => Math.pow(Math.sin(Math.PI * u), 0.72);
      const us = [0, 0.1, 0.22, 0.34, 0.47, 0.53, 0.66, 0.78, 0.9, 1];
      for (let k = 0; k < us.length; k++) {
        const u = us[k];
        const h = hd - a + 2 * a * u;
        const p: LPt = { r: rs(h) + (R - rs(h)) * bulge(u), h };
        if (k === 0) {
          p.s = white;
          p.crease = true;
        }
        if (k === 3 || k === 5) {
          const floors = Math.max(1, Math.round((2 * a * (us[k + 1] - u)) / 3.4));
          p.s = { ...PAL.glass, win: 0.5, seed: seed0 + hd * 0.013 + k };
          p.win = [Math.round((2 * Math.PI * R) / 3.4), floors];
          p.crease = true;
        }
        if (k === 4 || k === 6) {
          p.s = k === 4 ? PAL.gold : white;
          p.crease = true;
        }
        pts.push(p);
      }
      cur = hd + a;
    }
  }

  // the lantern, the cap and the mast
  const lan = Math.min(18, H * 0.03);
  stem(cur, H - lan);
  const rl = rs(H) + 1.2;
  const mast = H * (def.landmark ? 0.2 : 0.13);
  pts.push(
    { r: rs(H - lan), h: H - lan, s: PAL.gold, crease: true },
    { r: rl, h: H - lan + 1.2, s: { ...PAL.glassLit, win: 0.9, seed: seed0 + 0.5 }, win: [Math.round((2 * Math.PI * rl) / 3), Math.max(2, Math.round(lan / 3.4))], crease: true },
    { r: rl, h: H - 1.2, s: white, crease: true },
    { r: rl + 0.6, h: H - 1, crease: true },
    { r: rl + 0.6, h: H, crease: true },
    { r: rl * 0.55, h: H + rl * 0.7 },
    { r: 1.5, h: H + rl * 1.5, s: PAL.bone, crease: true },
    { r: 1.1, h: H + mast * 0.55 },
    { r: 2.6, h: H + mast * 0.58, s: PAL.gold, crease: true },
    { r: 2.6, h: H + mast * 0.6, s: PAL.bone, crease: true },
    { r: 0.8, h: H + mast * 0.63 },
    { r: 0.35, h: H + mast },
  );
  lathe(buf, f, pts, segs, white);
  lights.add(at(f, 0, H + mast + 1, 0), LAMP.white, 3.2, 16, rnd());
  lights.add(at(f, 0, H + mast * 0.6, 0), LAMP.warm, 1.6, 9);

  // ── the halos ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  for (const t of tiers) {
    if (t.kind !== 'halo') continue;
    const hh = t.at * H;
    const R = t.r;
    const w = Math.max(4, R * 0.05);
    const gl: Surf = { ...PAL.glassLit, win: 0.6, seed: seed0 + hh * 0.007 };
    const panes = Math.round((2 * Math.PI * R) / 3.6);
    lathe(
      buf,
      f,
      [
        { r: R - w, h: hh - w * 0.6, s: PAL.shell, crease: true, k: 0.72 },
        { r: R + w * 0.7, h: hh - w * 0.75, k: 0.85 },
        { r: R + w, h: hh - w * 0.45, s: gl, win: [panes, 2], crease: true },
        { r: R + w, h: hh + w * 0.45, s: PAL.white, crease: true },
        { r: R + w * 0.7, h: hh + w * 0.75, s: PAL.lawn, crease: true },
        { r: R - w * 0.7, h: hh + w * 0.75, s: PAL.white, crease: true },
        { r: R - w, h: hh + w * 0.45, s: { ...gl, win: 0.35, seed: gl.seed! + 0.4 }, win: [panes, 2], crease: true },
        { r: R - w, h: hh - w * 0.6 },
      ],
      segs,
      PAL.white,
    );
    // the struts: from low on the stem out and up to the ring's inner edge
    const ns = def.landmark ? 6 : 5;
    const hA = hh - R * 0.5;
    const turn = rnd() * 6.28;
    for (let k = 0; k < ns; k++) {
      const fr = moved(f, 0, 0, 0, turn + (k / ns) * Math.PI * 2);
      const path: V3[] = [];
      const rad: number[] = [];
      const ra = rs(hA) * 0.7;
      for (let j = 0; j <= 9; j++) {
        const u = j / 9;
        // a quadratic curve: out along the stem's flank first, then up into the ring
        const cr = R * 0.62;
        const ch = hA + R * 0.06;
        const pr = (1 - u) * (1 - u) * ra + 2 * u * (1 - u) * cr + u * u * (R - w * 0.8);
        const ph = (1 - u) * (1 - u) * hA + 2 * u * (1 - u) * ch + u * u * (hh - w * 0.55);
        path.push(at(fr, pr, ph, 0));
        rad.push(Math.max(1.1, R * 0.016) * (1.25 - 0.55 * u));
      }
      tube(buf, path, rad, 6, PAL.bone);
    }
    for (let k = 0; k < 4; k++) lights.add(at(moved(f, 0, 0, 0, turn + (k / 4) * Math.PI * 2 + 0.6), R + w + 0.5, hh, 0), LAMP.white, 2.2, 8, (k * 0.25 + rnd() * 0.05) % 1);
  }

  // ── the gardens ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  for (const g of gardens) {
    const span = g.R - g.rIn;
    if (span < 8) continue;
    const yAt = (r: number): number => g.hd + ((g.yIn - g.hd) * (g.R - r)) / span;
    const area = Math.PI * (g.R * g.R - g.rIn * g.rIn);
    const n = Math.min(110, Math.max(8, Math.round(area / 240)));
    for (let k = 0; k < n; k++) {
      const r = Math.sqrt(g.rIn * g.rIn + rnd() * ((g.R - 5) * (g.R - 5) - g.rIn * g.rIn));
      const a = rnd() * Math.PI * 2;
      const cr = 5.5 + rnd() * 6;
      crown(buf, f, Math.cos(a) * r, yAt(r) + 1.5 + rnd() * 3, Math.sin(a) * r, cr, cr * (1.1 + rnd() * 0.7), rnd);
    }
    // a pavilion or two: a small white dome on a ring of glass, and a few lamps along the walk
    const np = span > 30 ? 2 + Math.floor(rnd() * 2) : 1;
    for (let k = 0; k < np; k++) {
      const r = g.R - 9 - rnd() * Math.min(18, span * 0.3);
      const a = rnd() * Math.PI * 2;
      const pr = 5 + rnd() * 4;
      const fr = moved(f, Math.cos(a) * r, yAt(r) - 0.5, Math.sin(a) * r);
      lathe(
        buf,
        fr,
        [
          { r: pr, h: 0, s: { ...PAL.glassLit, seed: rnd() }, win: [Math.round((2 * Math.PI * pr) / 2.6), 1], crease: true },
          { r: pr, h: 3.4, s: PAL.white, crease: true },
          { r: pr + 0.7, h: 3.6, crease: true },
          { r: pr * 0.86, h: 3.6 + pr * 0.42 },
          { r: pr * 0.5, h: 3.6 + pr * 0.74 },
          { r: 0, h: 3.6 + pr * 0.86 },
        ],
        10,
        PAL.white,
      );
    }
    const nl = Math.min(14, Math.max(5, Math.round(g.R / 9)));
    const a0 = rnd() * 6.28;
    for (let k = 0; k < nl; k++) {
      const a = a0 + (k / nl) * Math.PI * 2;
      lights.add(at(f, Math.cos(a) * (g.R - 1.5), yAt(g.R) + 4.5, Math.sin(a) * (g.R - 1.5)), LAMP.warm, 1.5, 4.5);
    }
  }
}
