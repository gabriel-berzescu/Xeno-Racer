/**
 * Tire force model.
 *
 * Combined slip uses the "similarity" approach: longitudinal slip ratio and lateral slip (tan α)
 * are each normalized by the slip at which their force peaks, giving a slip vector whose length
 * ρ = 1 at the friction peak in any direction. The total force follows a Pacejka magic-formula
 * shape in ρ and is split along the slip direction, so braking or wheelspin while cornering eats
 * into lateral grip exactly like a real tire (friction circle with a post-peak drop-off).
 */
import type { TireSpec } from './spec';

export interface TireShape {
  B: number;
  C: number;
  /** Small-slip slope g(ρ)/ρ as ρ → 0, i.e. B·C. */
  slope: number;
}

/** Magic-formula coefficients with the peak at ρ = 1 and g(∞) = slideRatio. */
export function makeShape(slideRatio: number): TireShape {
  const s = Math.min(0.97, Math.max(0.3, slideRatio));
  const C = (2 / Math.PI) * (Math.PI - Math.asin(s));
  const B = Math.tan(Math.PI / (2 * C));
  return { B, C, slope: B * C };
}

/** Normalized force 0..1 for normalized slip magnitude ρ ≥ 0. */
export function shapeForce(rho: number, sh: TireShape): number {
  return Math.sin(sh.C * Math.atan(sh.B * rho));
}

/** g(ρ)/ρ, well-defined at ρ = 0. */
export function shapeRatio(rho: number, sh: TireShape): number {
  if (rho < 1e-4) return sh.slope;
  return Math.sin(sh.C * Math.atan(sh.B * rho)) / rho;
}

/** Friction coefficient falls with load (bigger contact patch, less grip per newton). */
export function loadFactor(load: number, tire: TireSpec): number {
  const f = 1 - tire.loadSensitivity * (load / tire.nominalLoad - 1);
  return f < 0.6 ? 0.6 : f > 1.25 ? 1.25 : f;
}

/** Grip vs tread temperature: 1 at optimal, coldGrip at ±tempWindow and beyond. */
export function tempFactor(tempC: number, tire: TireSpec): number {
  const x = (tempC - tire.optimalTemp) / tire.tempWindow;
  const q = x * x;
  return 1 - (1 - tire.coldGrip) * (q > 1 ? 1 : q);
}
