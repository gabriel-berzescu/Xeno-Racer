/**
 * The settlements of an orbital habitat (habitat.ts): a few dozen small white buildings among the trees, laid out the way a
 * sunflower lays out its seeds (each one a golden angle on from the last, a little further out), so that no two stand in a row and
 * none hides its neighbour.
 *
 * Four kinds of house, all of them bodies of revolution: a dome on a ring of glass; a shell (a dome drawn out and cut open, its
 * mouth glazed); a pavilion of two to four terraces, each a ring of glass under a roof of grass; and a rotunda with a garden on its
 * roof. At the centre a great hall (a shell four storeys high) and beside it a spire with a slow white light. After dark the rooms
 * are lit and a lamp burns at every door.
 *
 * A house stands only where the ground is free: off the road and its run-off, out of the water, off anything already built or kept
 * clear (`ctx.reserved`), out of the TV cameras' view of the road, and it keeps the trees off its own plot.
 */
import { mulberry32 } from '../math';
import type { SettlementDef } from '../types';
import type { Ctx } from './ctx';
import { HabBuf, LAMP, PAL, at, crown, frameAt, lathe, moved, type Frame, type HabLights, type LPt, type Surf } from './habitatKit';

export interface Plot {
  x: number;
  z: number;
  r: number;
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** The glazed mouth of a shell cut open between the angles -am and am: a strip from side to side per stretch of the profile. */
function mouth(buf: HabBuf, f: Frame, pts: LPt[], am: number, s: Surf): void {
  const c = Math.cos(am);
  const sn = Math.sin(am);
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    if (q.h - p.h < 1e-3) continue;
    const uv: [number, number][] = [[(-p.r * sn) / 2.6, p.h / 3.3], [(p.r * sn) / 2.6, p.h / 3.3], [(q.r * sn) / 2.6, q.h / 3.3], [(-q.r * sn) / 2.6, q.h / 3.3]];
    buf.quad(at(f, p.r * c, p.h, -p.r * sn), at(f, p.r * c, p.h, p.r * sn), at(f, q.r * c, q.h, q.r * sn), at(f, q.r * c, q.h, -q.r * sn), s, { toward: f.ex, uv });
  }
}

/** A dome's profile: from a foot `sink` m under the floor, up a plinth and over the top; `flat` < 1 lowers it. */
function domePts(r: number, h: number, sink: number, n: number): LPt[] {
  const pts: LPt[] = [{ r: r * 1.02, h: -sink, s: PAL.shell, crease: true }, { r: r * 1.02, h: 0.5, s: PAL.white, crease: true }];
  for (let k = 0; k <= n; k++) {
    const t = (k / n) * (Math.PI / 2);
    pts.push({ r: r * Math.pow(Math.cos(t), 0.85), h: 0.5 + h * Math.sin(t), k: 0.9 + 0.1 * Math.sin(t) });
  }
  return pts;
}

export function emitTown(ctx: Ctx, buf: HabBuf, lights: HabLights, def: SettlementDef, index: number): Plot[] {
  const rt = ctx.rt;
  const rnd = mulberry32(((def.seed ?? 11 + index * 53) * 2246822519) >>> 0);
  const plots: Plot[] = [];
  const lake = rt.terrain.lakeLevel;
  const turn = rnd() * 6.28;
  // the seeds of the sunflower: spaced so that `count` houses fill the settlement's radius with room to spare for what is refused
  const c = def.r / Math.sqrt(def.count * 1.25 + 2);
  const free = (x: number, z: number, r: number): boolean => {
    if (rt.stripMargin(x, z) < 26 + r) return false;
    for (const k of ctx.reserved) if (k(x, z, r + 3)) return false;
    for (const k of ctx.viewReserved) if (k(x, z, r + 2)) return false;
    if (ctx.camSpots?.some(([cx, cz]) => (cx - x) * (cx - x) + (cz - z) * (cz - z) < (r + 25) * (r + 25))) return false;
    return true;
  };
  /** The floor of a house on a round plot: the highest ground under it (and how far down its foot must reach), or null on water or a bank. */
  const floor = (x: number, z: number, r: number): [number, number] | null => {
    let lo = rt.fieldHeight(x, z);
    let hi = lo;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const y = rt.fieldHeight(x + Math.cos(a) * r, z + Math.sin(a) * r);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    if (lake !== null && lo < lake + 0.8) return null;
    if (hi - lo > 0.5 + r * 0.42) return null;
    return [hi + 0.15, hi - lo + 1.6];
  };

  let made = 0;
  const wantHall = def.hall !== false;
  const spire = def.spire ?? 38;
  let hallAt = null as Plot | null;
  for (let i = 0; made < def.count && i < def.count * 4 + 8; i++) {
    const rad = c * Math.sqrt(i + 0.35);
    if (rad > def.r * 1.25) break;
    const ang = turn + i * GOLDEN;
    const isHall: boolean = wantHall && !hallAt;
    const kind = isHall ? 4 : Math.floor(rnd() * 4);
    const size = isHall ? 15 + rnd() * 5 : kind === 1 ? 5.5 + rnd() * 3.5 : kind === 2 ? 6.5 + rnd() * 4.5 : 4.2 + rnd() * 3.6;
    // (a shell is drawn out along its axis: its plot is as long as that)
    const plotR = size * (kind === 1 || kind === 4 ? 1.45 : 1.08);
    const x = def.x + Math.cos(ang) * rad * (isHall ? 0.3 : 1);
    const z = def.z + Math.sin(ang) * rad * (isHall ? 0.3 : 1);
    if (plots.some((p) => (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < (p.r + plotR + 2.5) * (p.r + plotR + 2.5))) continue;
    if (!free(x, z, plotR)) continue;
    const fl = floor(x, z, plotR);
    if (!fl) continue;
    const [y, sink] = fl;
    // a house looks out of the settlement, and a little to one side
    const yaw = Math.atan2(z - def.z, x - def.x) + (rnd() - 0.5) * 1.1;
    const f0 = frameAt([x, y, z]);
    const seed = rnd();
    plots.push({ x, z, r: plotR });
    made++;
    if (kind === 0) {
      // a dome on a ring of glass
      const r = size;
      const gh = 3.1;
      const pts: LPt[] = [
        { r: r, h: -sink, s: PAL.shell, crease: true },
        { r: r, h: 0.4, s: { ...PAL.glass, win: 0.45, seed }, win: [Math.max(6, Math.round((2 * Math.PI * r) / 2.4)), 1], crease: true },
        { r: r, h: 0.4 + gh, s: PAL.white, crease: true },
        { r: r + 0.7, h: 0.55 + gh, crease: true },
        { r: r + 0.7, h: 0.9 + gh, crease: true },
      ];
      const dh = r * (0.5 + rnd() * 0.25);
      for (let k = 1; k <= 4; k++) {
        const t = (k / 4) * (Math.PI / 2);
        pts.push({ r: (r + 0.3) * Math.pow(Math.cos(t), 0.85), h: 0.9 + gh + dh * Math.sin(t) });
      }
      lathe(buf, f0, pts, 10, PAL.white);
    } else if (kind === 1 || kind === 4) {
      // a shell: a dome drawn out and cut open toward where it looks, its mouth glazed
      const r = size;
      const h = isHall ? r * 0.82 : r * (0.62 + rnd() * 0.2);
      const fr = moved(f0, 0, 0, 0, yaw, isHall ? 1.35 : 1.3);
      const am = isHall ? 0.95 : 0.8 + rnd() * 0.25;
      const pts = domePts(r, h, sink, isHall ? 7 : 5);
      const a0 = am / (Math.PI * 2);
      lathe(buf, fr, pts, isHall ? 18 : 10, PAL.white, [a0, 1 - a0]);
      mouth(buf, fr, pts, am, { ...PAL.glassLit, win: isHall ? 0.85 : 0.6, seed });
      if (isHall) {
        hallAt = { x, z, r: plotR };
        // a gilded ring where the mouth's arch meets the shell's crown
        lathe(buf, moved(f0, 0, 0.5 + h, 0), [{ r: 1.6, h: -0.3, s: PAL.gold, crease: true }, { r: 2.2, h: 0.5 }, { r: 0.9, h: 1.4 }, { r: 0, h: 1.6 }], 8, PAL.gold);
      }
      lights.add(at(fr, r * 0.75, 2.6, 0), LAMP.pale, isHall ? 1.6 : 1.1, isHall ? 7 : 3.4);
    } else if (kind === 2) {
      // a pavilion of terraces: rings of glass, each under a roof of grass, each set back from the one below
      const tiers = 2 + Math.floor(rnd() * 2.4);
      const pts: LPt[] = [{ r: size, h: -sink, s: PAL.shell, crease: true }];
      let r = size;
      let h = 0.3;
      for (let t = 0; t < tiers; t++) {
        pts.push(
          { r, h, s: { ...PAL.glass, win: 0.5, seed: seed + t * 0.21 }, win: [Math.max(6, Math.round((2 * Math.PI * r) / 2.4)), 1], crease: true },
          { r, h: h + 3.0, s: PAL.white, crease: true },
          { r: r + 1.1, h: h + 3.1, crease: true },
          { r: r + 1.1, h: h + 3.55, s: PAL.lawn, crease: true },
        );
        h += 3.55;
        const rn = t === tiers - 1 ? 0 : r * (0.62 + rnd() * 0.1);
        if (rn > 0) pts.push({ r: rn, h: h + 0.1, crease: true });
        else pts.push({ r: r * 0.5, h: h + 0.5 }, { r: 0, h: h + 0.7 });
        r = rn;
        h += 0.1;
      }
      lathe(buf, f0, pts, 12, PAL.white);
    } else {
      // a rotunda: a low drum, its wall leaning out to an eave, a tree or two on its roof
      const r = size;
      const eh = 3.6 + rnd() * 1.5;
      lathe(
        buf,
        f0,
        [
          { r: r * 0.92, h: -sink, s: PAL.shell, crease: true },
          { r: r * 0.92, h: 0.3, s: { ...PAL.glass, win: 0.4, seed }, win: [Math.max(6, Math.round((2 * Math.PI * r) / 2.6)), 1], crease: true },
          { r: r, h: 0.3 + eh * 0.8, s: PAL.white, crease: true },
          { r: r + 0.9, h: 0.3 + eh, crease: true },
          { r: r + 0.9, h: 0.75 + eh, s: PAL.lawn, crease: true },
          { r: r * 0.3, h: 1.1 + eh },
          { r: 0, h: 1.15 + eh },
        ],
        10,
        PAL.white,
      );
      const nt = 1 + Math.floor(rnd() * 2.5);
      for (let k = 0; k < nt; k++) {
        const a = rnd() * 6.28;
        const cr = 1.8 + rnd() * 1.6;
        crown(buf, f0, Math.cos(a) * r * 0.5, 1 + eh, Math.sin(a) * r * 0.5, cr, cr * 1.5, rnd);
      }
    }
    // the lamp at its door
    if (kind !== 1 && kind !== 4) lights.add([x + Math.cos(yaw) * (size + 1.2), y + 2.7, z + Math.sin(yaw) * (size + 1.2)], LAMP.warm, 1.2, 3.2);
  }

  // the spire: a needle beside the hall (or at the centre), a bead of gold two thirds of the way up, a slow white light on top
  if (spire > 0 && plots.length) {
    const base = hallAt ?? plots[0];
    for (let k = 0; k < 10; k++) {
      const a = turn + 2.2 + k * 0.63;
      const x = base.x + Math.cos(a) * (base.r + 7);
      const z = base.z + Math.sin(a) * (base.r + 7);
      if (plots.some((p) => p !== base && (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < (p.r + 4) * (p.r + 4))) continue;
      if (!free(x, z, 3)) continue;
      const fl = floor(x, z, 3);
      if (!fl) continue;
      const f0 = frameAt([x, fl[0], z]);
      const H = spire;
      lathe(
        buf,
        f0,
        [
          { r: 2.6, h: -fl[1], s: PAL.bone, crease: true },
          { r: 2.3, h: 0 },
          { r: 1.25, h: H * 0.12 },
          { r: 0.85, h: H * 0.4 },
          { r: 0.6, h: H * 0.66, s: PAL.gold, crease: true },
          { r: 1.5, h: H * 0.69 },
          { r: 0.55, h: H * 0.73, s: PAL.bone, crease: true },
          { r: 0.16, h: H },
        ],
        7,
        PAL.bone,
      );
      lights.add([x, fl[0] + H + 0.6, z], LAMP.white, 2.4, 6, rnd());
      plots.push({ x, z, r: 3 });
      break;
    }
  }
  return plots;
}
