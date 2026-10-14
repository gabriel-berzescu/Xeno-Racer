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

/** Peak power (W) and the rpm it occurs at. */
export function peakPower(spec: EngineSpec): { watts: number; rpm: number } {
  let best = { watts: 0, rpm: 0 };
  for (let rpm = spec.idleRpm; rpm <= spec.limiterRpm; rpm += 50) {
    const w = torqueAt(spec, rpm) * rpm * RPM_TO_RADS;
    if (w > best.watts) best = { watts: w, rpm };
  }
  return best;
}
