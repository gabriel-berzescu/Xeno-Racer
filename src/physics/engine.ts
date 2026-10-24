import type { EngineSpec } from './spec';

export const RPM_TO_RADS = (2 * Math.PI) / 60;
export const RADS_TO_RPM = 60 / (2 * Math.PI);

/** Linear interpolation in a [rpm, Nm][] table (clamped at the ends). */
export function torqueAt(spec: EngineSpec, rpm: number): number {
  const t = spec.torqueCurve;
  if (rpm <= t[0][0]) return t[0][1];
  const last = t[t.length - 1];
  if (rpm >= last[0]) return last[1];
  // tables are short (≤ 16 points) — linear scan is fastest
  for (let i = 1; i < t.length; i++) {
    if (rpm <= t[i][0]) {
      const [r0, q0] = t[i - 1];
      const [r1, q1] = t[i];
      return q0 + ((q1 - q0) * (rpm - r0)) / (r1 - r0);
    }
  }
  return last[1];
}

/** Peak torque of the full-boost curve. */
export function peakTorque(spec: EngineSpec): number {
  let m = 0;
  for (const [, q] of spec.torqueCurve) m = Math.max(m, q);
  return m;
}

/** How fast the power of an electric motor (EngineSpec.electric) tapers above its `fullToKmh` (kW per km/h): the 2026 rule's rate. */
const ELECTRIC_TAPER_KW_PER_KMH = 5;

/**
 * Power (W) an electric motor geared to the crankshaft (EngineSpec.electric, a 2026 MGU-K) may deploy at a road speed of `kmh`: all of
 * its `powerKw` up to `fullToKmh`, 5 kW less for every km/h above it, and nothing from `zeroAtKmh`. For 350 kW to 290 km/h that is
 * 1800 - 5 v kW, cut at 345 km/h: the 2026 rule (C5.2.8) made simpler, as the Volta's brief has it. The rule itself tapers steeply over
 * its last 5 km/h, 6900 - 20 v kW from 340 km/h, so where it allows 20 kW at 344 km/h this allows 80.
 */
export function electricPower(m: NonNullable<EngineSpec['electric']>, kmh: number): number {
  if (kmh >= m.zeroAtKmh) return 0;
  const kw = Math.min(m.powerKw, m.powerKw - ELECTRIC_TAPER_KW_PER_KMH * (kmh - m.fullToKmh));
  return kw > 0 ? kw * 1000 : 0;
}

/** Peak power (W) and the rpm it occurs at. */
export function peakPower(spec: EngineSpec): { watts: number; rpm: number } {
  let best = { watts: 0, rpm: 0 };
  for (let rpm = spec.idleRpm; rpm <= spec.limiterRpm; rpm += 50) {
    const w = torqueAt(spec, rpm) * rpm * RPM_TO_RADS;
    if (w > best.watts) best = { watts: w, rpm };
  }
  return best;
}
