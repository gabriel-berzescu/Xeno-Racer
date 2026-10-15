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
}

export const SURFACES: Record<SurfaceType, SurfaceProps> = {
  asphalt: { grip: 1.0, rolling: 0, plough: 0, paved: true, wet: 1 },
  curb: { grip: 0.93, rolling: 0.002, plough: 0, paved: true, wet: 0.72 },
  concrete: { grip: 0.9, rolling: 0, plough: 0, paved: true, wet: 0.92 },
  grass: { grip: 0.58, rolling: 0.035, plough: 0.0006, paved: false, wet: 0.7 },
  dirt: { grip: 0.7, rolling: 0.03, plough: 0.0004, paved: false, wet: 0.82 },
  gravel: { grip: 0.62, rolling: 0.16, plough: 0.004, paved: false, wet: 1.25 },
  sand: { grip: 0.5, rolling: 0.25, plough: 0.006, paved: false, wet: 1.35 },
};

/**
 * Grip multiplier for a tire on a surface with `wetness` (0..1) water at contact speed `v` (m/s):
 * the tire's wet grip times the surface's wet factor, plus aquaplaning in standing water at speed.
 */
export function wetGripFactor(wetness: number, tireWet: number, surf: SurfaceProps, v: number): number {
  if (wetness <= 0) return 1;
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
