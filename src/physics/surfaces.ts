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
  dirt: { grip: 0.6, wet: 0.5, rolling: 0.1, plough: 0.1 },
  gravel: { grip: 0.55, rolling: 0.35, plough: 0.35 },
  sand: { grip: 0.45, rolling: 0.4, plough: 0.4 },
  deepsnow: { grip: 0.2, rolling: 0.35, plough: 0.35 },
};

const tireTables = new Map<number, Record<SurfaceType, SurfaceProps>>();

/**
 * The table of surfaces as a tyre meets them: `SURFACES` itself (the very same object, so nothing about a road or race tyre changes by
 * a bit) unless the tyre is an all-terrain one (`TireSpec.offroad` above 0), which gets a table of its own with loose ground softened as
 * `OFFROAD_GAIN` says, scaled by how much of an all-terrain tyre it is. Worked out once per value and shared: the physics keeps one per
 * wheel and the AI one per car, so nothing is allocated in the substep or the frame.
 */
export function tireSurfaces(tire: { readonly offroad?: number }): Record<SurfaceType, SurfaceProps> {
  const k = tire.offroad === undefined ? 0 : Math.min(1, Math.max(0, tire.offroad));
  if (!(k > 0)) return SURFACES;
  let t = tireTables.get(k);
  if (t) return t;
  t = {} as Record<SurfaceType, SurfaceProps>;
  for (const name of Object.keys(SURFACES) as SurfaceType[]) {
    const s = SURFACES[name];
    const g = OFFROAD_GAIN[name];
    t[name] = g
      ? { ...s, grip: s.grip + (1 - s.grip) * g.grip * k, wet: s.wet + (g.wet !== undefined ? (1 - s.wet) * g.wet * k : 0), rolling: s.rolling * (1 - g.rolling * k), plough: s.plough * (1 - g.plough * k) }
      : s;
  }
  tireTables.set(k, t);
  return t;
}

/** The table of a car on its two axles: the one of the less all-terrain tyre (the axle that has less of it limits what the AI may ask of the ground). */
export function carSurfaces(ph: { readonly tireFront: { readonly offroad?: number }; readonly tireRear: { readonly offroad?: number } }): Record<SurfaceType, SurfaceProps> {
  return tireSurfaces({ offroad: Math.min(ph.tireFront.offroad ?? 0, ph.tireRear.offroad ?? 0) });
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
