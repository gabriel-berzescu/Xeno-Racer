import type { SurfaceType } from '../core/contracts';

export interface SurfaceProps {
  /** Multiplier on tire friction. */
  grip: number;
  /** Extra rolling-resistance coefficient (gravel and sand bog the car down). */
  rolling: number;
  /** Extra speed-proportional drag coefficient (N per (m/s) per N of load) — ploughing. */
  plough: number;
  /** True for surfaces that leave rubber skidmarks / squeal. */
  paved: boolean;
  /**
   * When fully wet, this surface keeps `wet` × the tire's own wet grip (1 = like wet asphalt).
   * Painted kerbs and grass turn treacherous; gravel and sand barely change.
   */
  wet: number;
  /**
   * Winter surfaces only: the grip kept when a heavy fall of fresh snow lies on it. On a winter track the "water" on the road
   * (`wetness`) is that snow: it adds no film and no aquaplaning, it is loose powder on top of the packed surface, so the tire's
   * wet-weather grip does not enter. Absent: the surface takes water.
   */
  fresh?: number;
}

/**
 * Grip is relative to dry asphalt on the same tyre. The winter surfaces are for studded winter tyres (src/physics/compound.ts):
 *   - packed snow, 0.50: a studded winter tyre holds 0.3-0.5 μ on a packed snow road against 0.8-1.1 on dry asphalt;
 *   - studded ice, 0.40: the studs bite where rubber alone would hold 0.1; racing studs on a prepared ice track reach 0.4-0.5
 *     of asphalt;
 *   - deep snow, 0.32: loose snow off the road shears under the wheel; it holds a car back more than it holds it up.
 */
export const SURFACES: Record<SurfaceType, SurfaceProps> = {
  asphalt: { grip: 1.0, rolling: 0, plough: 0, paved: true, wet: 1 },
  curb: { grip: 0.93, rolling: 0.002, plough: 0, paved: true, wet: 0.72 },
  concrete: { grip: 0.9, rolling: 0, plough: 0, paved: true, wet: 0.92 },
  grass: { grip: 0.58, rolling: 0.035, plough: 0.0006, paved: false, wet: 0.7 },
  dirt: { grip: 0.7, rolling: 0.03, plough: 0.0004, paved: false, wet: 0.82 },
  gravel: { grip: 0.62, rolling: 0.16, plough: 0.004, paved: false, wet: 1.25 },
  sand: { grip: 0.5, rolling: 0.25, plough: 0.006, paved: false, wet: 1.35 },
  snow: { grip: 0.5, rolling: 0.006, plough: 0, paved: false, wet: 1, fresh: 0.86 },
  ice: { grip: 0.4, rolling: 0.002, plough: 0, paved: false, wet: 1, fresh: 0.93 },
  deepsnow: { grip: 0.32, rolling: 0.12, plough: 0.0055, paved: false, wet: 1, fresh: 0.9 },
};

/**
 * What an all-terrain tyre (`TireSpec.offroad`, 1 = a full one) gets back from loose ground, per surface. It is a share of what a road
 * tyre loses there, so it can never take a surface past asphalt (a share of the way back from the road tyre's grip to 1), and it only
 * acts where the ground is loose enough for a tread to bite into: paved ground (asphalt, kerb, concrete), packed snow and ice are the
 * same for every tyre (the all-terrain tyre pays for its blocks there, in its lower `mu`).
 *   - `grip`: the share of the missing grip won back. Open blocks and deep voids key into turf and grit where a road tyre's closed
 *     tread skates on top: a good all-terrain tyre holds 20-30 % more than a summer tyre on gravel and dirt, and takes much more of
 *     the mud off wet grass; a loose pile (sand, deep snow) it can only claw at, so a smaller share.
 *   - `wet`: the same for the surface's wet factor (`SurfaceProps.wet`): the voids clear the mud that makes wet turf and dirt a skating rink.
 *   - `rolling`, `plough`: the share of the drag a big, soft, tall tyre does not feel. It floats: a larger patch sinks less, so it
 *     piles up less ground in front of it and flexes less of it. Gravel, sand and deep snow, where the drag is heavy, are where it shows.
 */
interface OffroadGain {
  grip: number;
  wet?: number;
  rolling: number;
  plough: number;
}

const OFFROAD_GAIN: Partial<Record<SurfaceType, OffroadGain>> = {
  grass: { grip: 0.55, wet: 0.5, rolling: 0.1, plough: 0.1 },
  dirt: { grip: 0.7, wet: 0.5, rolling: 0.1, plough: 0.1 },
  gravel: { grip: 0.65, rolling: 0.35, plough: 0.35 },
  sand: { grip: 0.5, rolling: 0.4, plough: 0.4 },
  deepsnow: { grip: 0.2, rolling: 0.35, plough: 0.35 },
};

/**
 * What a racing slick (`TireSpec.slick`, 1 = a full one) keeps of loose ground, per surface: the other end of the scale from the
 * all-terrain tyre above, and a table of the same kind. A slick is a smooth face of soft rubber that grips by adhesion and by hysteresis
 * on the micro-texture of a clean, hard road, and that is its whole advantage (a peak μ of 1.6-1.9 on dry asphalt against a road tyre's
 * 1.0-1.1). Loose ground gives that nothing to work on, and the slick has no tread to work with: a road tyre's grooves and sipes take in
 * blades of grass, grit and clods and key into them, where a slick sits on the blades, on the film of moisture over them, and rolls the
 * stones out from under its face. What real tyres do (a peak μ, a road tyre against a slick):
 *
 *                   road   slick
 *     dry grass     0.45   0.30
 *     wet grass     0.25   0.10   (rain, dew, the juice of the crushed blades: a smooth face aquaplanes on turf)
 *     dry dirt      0.60   0.40   (a packed dirt road; the dust lying on it is a layer of ball bearings)
 *     wet dirt      0.35   0.12   (mud)
 *     gravel        0.50   0.30   (wet gravel drains: the same)
 *     dry sand      0.40   0.30
 *
 * so on loose ground a slick holds 0.6-0.75 of what a road tyre does, where on asphalt it holds 1.5 times as much. The model works in
 * shares of the tyre's own asphalt grip, and a slick's `mu` is 1.4-1.6 times a road tyre's, so the same absolute figures are a smaller
 * share of it: 0.67 (the slick against the road tyre) x 0.68 (a road tyre's `mu` of 1.1 over the LMP-X's 1.62) is 0.45 of the table's grip on
 * grass, and the downforce of a prototype, which presses a slick into soft ground and gets less back for the load than a road tyre does
 * on asphalt (the strength of a soil is not proportional to the weight on it), takes it a little further: that is `grip` below, 0.4. It makes
 * the LMP-X clearly worse than the weakest road car on every loose surface at 60 and at 120 km/h, where its downforce is worth a quarter
 * of its weight (tests/slicks.test.ts, tests/probes/slick-probe.test.ts). Only loose ground: paved ground (asphalt, kerb, concrete), packed
 * snow and ice are the same for every tyre.
 *   - `grip`: the share of the table's grip for the surface that a slick keeps.
 *   - `wet`: the share it keeps of the surface's wet factor (`SurfaceProps.wet`): wet turf and wet dirt are the worst ground there is for a
 *     smooth tyre. Gravel and sand drain, so nothing changes there (the tyre's own wet grip still applies).
 *   - `rolling`, `plough`: the drag of a wide smooth tyre, with a floor six centimetres off the ground behind it, digging in, as a multiple
 *     of the surface's: it has nothing to shed what it picks up, and gravel and sand pile up in front of it. It is gravel and sand, where the
 *     drag is heavy, that it shows in; turf and dirt just a little. (A prototype in a gravel trap is beached: it stops short, and has no
 *     grip to leave with.)
 */
interface SlickLoss {
  grip: number;
  wet?: number;
  rolling: number;
  plough: number;
}

const SLICK_LOSS: Partial<Record<SurfaceType, SlickLoss>> = {
  grass: { grip: 0.4, wet: 0.7, rolling: 1.1, plough: 1.1 },
  dirt: { grip: 0.4, wet: 0.7, rolling: 1.1, plough: 1.15 },
  gravel: { grip: 0.4, rolling: 1.2, plough: 1.3 },
  sand: { grip: 0.42, rolling: 1.15, plough: 1.25 },
  deepsnow: { grip: 0.45, rolling: 1.15, plough: 1.25 },
};

/** The trait of a tyre that decides its table of surfaces: `offroad` and `slick`, each 0..1 or absent. */
interface Tread {
  readonly offroad?: number;
  readonly slick?: number;
}

/** A share of a trait: 0 when it is absent (or not a number), at most 1. */
const share = (x: number | undefined): number => (x !== undefined && x > 0 ? (x > 1 ? 1 : x) : 0);

/**
 * Where a tyre stands between the racing slick (-1) and the all-terrain tyre (+1) on the one scale its tread is on: 0 for a road tyre (and
 * for the two traits on one tyre, which cancel). It decides the table of surfaces the tyre meets, `tireSurfaces`.
 */
export function treadOf(tire: Tread): number {
  return share(tire.offroad) - share(tire.slick);
}

const tireTables = new Map<number, Record<SurfaceType, SurfaceProps>>();

/** The table for a place `k` on the scale of `treadOf`: the road tyre's at 0, an all-terrain tyre's above it, a slick's below. Worked out once per value. */
function treadSurfaces(k: number): Record<SurfaceType, SurfaceProps> {
  if (k === 0) return SURFACES;
  let t = tireTables.get(k);
  if (t) return t;
  t = {} as Record<SurfaceType, SurfaceProps>;
  for (const name of Object.keys(SURFACES) as SurfaceType[]) {
    const s = SURFACES[name];
    if (k > 0) {
      const g = OFFROAD_GAIN[name];
      t[name] = g
        ? { ...s, grip: s.grip + (1 - s.grip) * g.grip * k, wet: s.wet + (g.wet !== undefined ? (1 - s.wet) * g.wet * k : 0), rolling: s.rolling * (1 - g.rolling * k), plough: s.plough * (1 - g.plough * k) }
        : s;
    } else {
      const l = SLICK_LOSS[name];
      const m = -k;
      t[name] = l
        ? { ...s, grip: s.grip * (1 - (1 - l.grip) * m), wet: s.wet * (1 - (1 - (l.wet ?? 1)) * m), rolling: s.rolling * (1 + (l.rolling - 1) * m), plough: s.plough * (1 + (l.plough - 1) * m) }
        : s;
    }
  }
  tireTables.set(k, t);
  return t;
}

/**
 * The table of surfaces as a tyre meets it: `SURFACES` itself (the very same object, so nothing about a road tyre changes by a bit)
 * unless the tyre is an all-terrain one (`TireSpec.offroad` above 0), which gets a table of its own with loose ground softened as
 * `OFFROAD_GAIN` says, or a racing slick (`TireSpec.slick`), which gets one with loose ground made worse as `SLICK_LOSS` says, each
 * scaled by how much of that kind of tyre it is. The ground that is not loose is the very same object in every table. Worked out once
 * per value and shared: the physics keeps one per wheel and the AI one per car, so nothing is allocated in the substep or the frame.
 */
export function tireSurfaces(tire: Tread): Record<SurfaceType, SurfaceProps> {
  return treadSurfaces(treadOf(tire));
}

/**
 * The table of a car on its two axles: the one of the axle that has less of a tread for loose ground, the less all-terrain or the more
 * slick of the two (the axle that gives less grip limits what the AI may ask of the ground).
 */
export function carSurfaces(ph: { readonly tireFront: Tread; readonly tireRear: Tread }): Record<SurfaceType, SurfaceProps> {
  return treadSurfaces(Math.min(treadOf(ph.tireFront), treadOf(ph.tireRear)));
}

/**
 * Grip multiplier for a tire on a surface with `wetness` (0..1) water at contact speed `v` (m/s):
 * the tire's wet grip times the surface's wet factor, plus aquaplaning in standing water at speed. On a winter surface the
 * "water" is fresh snow (see `SurfaceProps.fresh`).
 */
export function wetGripFactor(wetness: number, tireWet: number, surf: SurfaceProps, v: number): number {
  if (wetness <= 0) return 1;
  if (surf.fresh !== undefined) return 1 + (surf.fresh - 1) * wetness;
  const full = Math.min(1.15, tireWet * surf.wet);
  let f = 1 + (full - 1) * wetness;
  if (surf.paved) {
    // standing water: the tread can't clear it at speed (only in heavy rain)
    const deep = Math.min(1, Math.max(0, (wetness - 0.7) / 0.3));
    const fast = Math.min(1, Math.max(0, (v - 50) / 35));
    f *= 1 - 0.16 * deep * fast * fast * (3 - 2 * fast);
  }
  return f;
}
