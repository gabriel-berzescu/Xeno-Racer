/**
 * Tire-sound mapping (main-thread, pure): turns WheelState into the four numbers the chassis
 * voice synthesises from. The progression is deliberately informative:
 *
 *   approaching the limit  -> faint broadband SCRUB (rises before any real skid exists)
 *   at the limit           -> rising TONAL squeal (stick-slip), the loudest "pure" sound
 *   sliding / locked       -> ragged HOWL: the tone breaks up, noise and pitch jitter take over
 *
 * Front and rear tires get different base pitches so the driver can hear which axle is going.
 */
import type { SurfaceType, WheelState } from '../core/contracts';
import { clamp, smoothstep } from './dsp/util';

export interface SquealLevels {
  scrub: number;
  tone: number;
  howl: number;
  /** Fundamental of the squeal tone in Hz. */
  pitch: number;
}

export function makeSquealLevels(): SquealLevels {
  return { scrub: 0, tone: 0, howl: 0, pitch: 1000 };
}

/** Base squeal pitch per wheel (FL, FR, RL, RR) in Hz: narrower, higher-loaded fronts sing higher. */
export const TIRE_BASE_HZ = [1090, 1030, 930, 890] as const;

const SLIP_ANGLE_LIMIT = 0.12; // rad, ~7 deg: typical peak slip angle
const SLIP_RATIO_LIMIT = 0.11;

export function squealSurfaceFactor(s: SurfaceType): number {
  switch (s) {
    case 'asphalt':
      return 1;
    case 'concrete':
      return 0.9;
    case 'curb':
      return 0.7;
    default:
      return 0;
  }
}

/** Slip magnitude relative to the tire's limit (1 = at the limit). */
export function slipToLimit(w: WheelState): number {
  const a = w.slipAngle / SLIP_ANGLE_LIMIT;
  const r = w.slipRatio / SLIP_RATIO_LIMIT;
  return Math.sqrt(a * a + r * r);
}

export function tireSqueal(w: WheelState, wheelIndex: number, speed: number, out: SquealLevels): void {
  out.scrub = 0;
  out.tone = 0;
  out.howl = 0;
  out.pitch = TIRE_BASE_HZ[wheelIndex & 3];
  const surf = squealSurfaceFactor(w.surface);
  if (!w.contact || surf === 0) return;
  const u = slipToLimit(w);
  const s = clamp(w.skid, 0, 1);
  const speedGate = smoothstep(1.2, 9, speed);
  if (speedGate <= 0) return;
  const loadF = clamp(Math.sqrt(Math.max(w.load, 0) / 4000), 0.35, 1.35);
  const g = surf * speedGate * loadF;

  // faint scrub as you approach the limit (before skid exists), continuing through the squeal
  const approach = smoothstep(0.55, 1.05, u) * 0.45;
  const scrub = Math.max(approach * (1 - smoothstep(0.2, 0.55, s)), smoothstep(0.03, 0.28, s) * 0.55 * (1 - 0.65 * smoothstep(0.4, 0.75, s)));
  // rising tonal squeal at the limit (physics skid starts at slip/peak ~0.85), breaking into a ragged
  // howl when fully sliding
  const howl = smoothstep(0.6, 0.95, s);
  const tone = smoothstep(0.08, 0.5, s) * (1 - 0.5 * howl);

  out.scrub = clamp(scrub * g, 0, 1.2);
  out.tone = clamp(tone * g, 0, 1.2);
  out.howl = clamp(howl * g, 0, 1.2);
  // pitch: rises with speed, rises a little into the limit, drops into the slide
  const speedPitch = 0.86 + 0.26 * smoothstep(6, 50, speed);
  const slipPitch = 1 + 0.1 * smoothstep(0.1, 0.55, s) - 0.17 * howl;
  const concrete = w.surface === 'concrete' ? 1.1 : 1;
  out.pitch = TIRE_BASE_HZ[wheelIndex & 3] * speedPitch * slipPitch * concrete;
}
