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
}

export const SURFACES: Record<SurfaceType, SurfaceProps> = {
  asphalt: { grip: 1.0, rolling: 0, plough: 0, paved: true },
  curb: { grip: 0.93, rolling: 0.002, plough: 0, paved: true },
  concrete: { grip: 0.9, rolling: 0, plough: 0, paved: true },
  grass: { grip: 0.58, rolling: 0.035, plough: 0.0006, paved: false },
  dirt: { grip: 0.7, rolling: 0.03, plough: 0.0004, paved: false },
  gravel: { grip: 0.62, rolling: 0.16, plough: 0.004, paved: false },
  sand: { grip: 0.5, rolling: 0.25, plough: 0.006, paved: false },
};
