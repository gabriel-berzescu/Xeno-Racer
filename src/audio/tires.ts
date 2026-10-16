/**
 * Tire-sound mapping (main-thread, pure): turns WheelState into the four numbers the chassis
 * voice synthesises from. The progression is deliberately informative:
 *
 *   approaching the limit  -> faint broadband SCRUB (rises before any real skid exists)
 *   at the limit           -> rising TONAL squeal (stick-slip), the loudest "pure" sound
 *   sliding / locked       -> ragged HOWL: the tone breaks up, noise and pitch jitter take over
 *
 * Front and rear tires get different base pitches so the driver can hear which axle is going.
 *
 * On a wet road (wet > 0) water lubricates the contact: the tonal squeal shrinks and dulls, the howl softens,
 * the broadband scrub grows (more hiss, less shriek) and sliding, above all wheelspin, turns into slush: a
 * sloshing spray level the chassis voice renders. With wet = 0 every number is exactly what it was.
 */
import type { SurfaceType, WheelState } from '../core/contracts';
import { clamp, smoothstep } from './dsp/util';

export interface SquealLevels {
  scrub: number;
  tone: number;
  howl: number;
  /** Fundamental of the squeal tone in Hz. */
  pitch: number;
  /** Wet-road slush (sloshing spray from a sliding / spinning tire), 0 on a dry road. */
  slush: number;
}

export function makeSquealLevels(): SquealLevels {
  return { scrub: 0, tone: 0, howl: 0, pitch: 1000, slush: 0 };
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

/** How much of its wet film a surface carries for the tire sound (0 = none, 1 = a sheet of water). */
export function wetFilm(s: SurfaceType): number {
  switch (s) {
    case 'asphalt':
      return 1;
    case 'curb':
      return 0.9;
    case 'concrete':
      return 0.85;
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

/** Share of the slip that is longitudinal (wheelspin / lock-up) rather than lateral (cornering): 0..1. */
function longitudinalShare(w: WheelState): number {
  const a = w.slipAngle / SLIP_ANGLE_LIMIT;
  const r = w.slipRatio / SLIP_RATIO_LIMIT;
  return (r * r) / (a * a + r * r + 1e-9);
}

/** The slush formula; `u` = slip relative to the limit, `longShare` as above. */
function slushFrom(w: WheelState, speed: number, wetT: number, u: number, longShare: number): number {
  const wheelSpeed = Math.abs(w.omega) * w.radius;
  const gate = smoothstep(1.5, 10, Math.max(speed, wheelSpeed));
  const loadF = clamp(Math.sqrt(Math.max(w.load, 0) / 4000), 0.35, 1.35);
  return clamp(wetT * gate * smoothstep(0.45, 1.3, u) * (0.4 + 0.6 * longShare) * loadF, 0, 1.2);
}

/**
 * Wheelspin / lock-up slush: 0..1.2, from how hard the tire slides (any slip, mostly longitudinal) and how
 * fast the contact patch moves through the water: the wheel's own surface speed counts, so a standing start
 * with the rear wheels spinning is loud even though the car has hardly moved.
 */
export function slushLevel(w: WheelState, speed: number, wetT: number): number {
  if (wetT <= 0 || !w.contact) return 0;
  return slushFrom(w, speed, wetT, slipToLimit(w), longitudinalShare(w));
}

export function tireSqueal(w: WheelState, wheelIndex: number, speed: number, out: SquealLevels, wet = 0): void {
  out.scrub = 0;
  out.tone = 0;
  out.howl = 0;
  out.slush = 0;
  out.pitch = TIRE_BASE_HZ[wheelIndex & 3];
  const wetT = wet > 0 ? wet * wetFilm(w.surface) : 0;
  const u = slipToLimit(w);
  const longShare = wetT > 0 ? longitudinalShare(w) : 0;
  if (wetT > 0 && w.contact) out.slush = slushFrom(w, speed, wetT, u, longShare);
  const surf = squealSurfaceFactor(w.surface);
  const snowy = w.surface === 'snow' || w.surface === 'deepsnow';
  const icy = w.surface === 'ice';
  if (!w.contact || (surf === 0 && !snowy && !icy)) return;
  const s = clamp(w.skid, 0, 1);
  const speedGate = smoothstep(1.2, 9, speed);
  if (speedGate <= 0) return;
  const loadF = clamp(Math.sqrt(Math.max(w.load, 0) / 4000), 0.35, 1.35);
  if (surf === 0) {
    // Snow and ice: no stick-slip. A tyre at the limit ploughs and hisses (the scrub band, the "shhh" of snow shearing under it),
    // there is no howl; the studs on ice add a thin, high, ragged zip once it slides.
    const approachS = smoothstep(0.5, 1.0, u) * 0.4;
    const slide = smoothstep(0.03, 0.4, s);
    out.scrub = clamp((approachS * (1 - smoothstep(0.2, 0.55, s)) + slide * (snowy ? 0.85 : 0.6)) * speedGate * loadF, 0, 1.2);
    out.tone = icy ? clamp(smoothstep(0.12, 0.6, s) * 0.2 * speedGate * loadF, 0, 0.4) : 0;
    out.pitch = TIRE_BASE_HZ[wheelIndex & 3] * (icy ? 1.7 : 1) * (0.86 + 0.26 * smoothstep(6, 50, speed));
    return;
  }
  const g = surf * speedGate * loadF;

  // faint scrub as you approach the limit (before skid exists), continuing through the squeal
  const approach = smoothstep(0.55, 1.05, u) * 0.45;
  const scrub = Math.max(approach * (1 - smoothstep(0.2, 0.55, s)), smoothstep(0.03, 0.28, s) * 0.55 * (1 - 0.65 * smoothstep(0.4, 0.75, s)));
  // rising tonal squeal at the limit (physics skid starts at slip/peak ~0.85), breaking into a ragged
  // howl when fully sliding
  const howl = smoothstep(0.6, 0.95, s);
  const tone = smoothstep(0.08, 0.5, s) * (1 - 0.5 * howl);

  // water lubricates: less shriek, more hiss; wheelspin and lock-up (longitudinal slip) lose the tone almost
  // completely, a cornering slide keeps a softened one
  let toneCut = 0;
  let howlCut = 0;
  if (wetT > 0) {
    toneCut = (0.72 + 0.23 * longShare) * wetT;
    howlCut = (0.5 + 0.3 * longShare) * wetT;
  }
  out.scrub = clamp(scrub * g * (1 + 0.45 * wetT), 0, 1.2);
  out.tone = clamp(tone * g * (1 - toneCut), 0, 1.2);
  out.howl = clamp(howl * g * (1 - howlCut), 0, 1.2);
  // pitch: rises with speed, rises a little into the limit, drops into the slide
  const speedPitch = 0.86 + 0.26 * smoothstep(6, 50, speed);
  const slipPitch = 1 + 0.1 * smoothstep(0.1, 0.55, s) - 0.17 * howl;
  const concrete = w.surface === 'concrete' ? 1.1 : 1;
  out.pitch = TIRE_BASE_HZ[wheelIndex & 3] * speedPitch * slipPitch * concrete;
}
