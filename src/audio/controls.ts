/**
 * The control vector: a flat Float32Array that the main thread fills once per frame from a
 * VehicleState and posts to the worklet voice (or that the offline lab feeds straight to the DSP).
 * Keeping the layout in one module guarantees both ends agree.
 */
import type { VehicleState } from '../core/contracts';
import type { EngineInputs } from './dsp/engine-voice';

export const CTL = {
  RPM: 0,
  THROTTLE: 1,
  LOAD: 2,
  BOOST: 3,
  LIMITER: 4,
  SHIFT_COUNT: 5,
  BACKFIRE_COUNT: 6,
  CLUTCH: 7,
  IDLE_RPM: 8,
  LIMITER_RPM: 9,
  REDLINE_RPM: 10,
  INTERIOR: 11,
  TIMESCALE: 12,
  GAIN: 13,
  QUALITY: 14,
  DRIVE_OMEGA: 15,
  SPEED: 16,
  GEAR: 17,
  // chassis
  CH_GAIN: 18,
  SCRAPE: 19,
  AIRBORNE: 20,
  SURF_HARD: 21,
  SURF_CURB: 22,
  SURF_GRASS: 23,
  SURF_GRAVEL: 24,
  SURF_SAND: 25,
  SURF_DIRT: 26,
  CURB_FL: 27, // .. CURB_RR = 30
  TIRE0: 31, // per wheel: scrub, tone, howl, pitch  (4 floats) -> 31..46
  THUMP_COUNT: 47,
  THUMP_STRENGTH: 48,
  THUMP_PAN: 49,
  IMPACT_COUNT: 50,
  IMPACT_STRENGTH: 51,
  IMPACT_KIND: 52,
  IMPACT_PAN: 53,
  CH_INTERIOR: 54,
  CH_QUALITY: 55,
  // weather
  /** Water on the track 0..1 (the same for every car). */
  WET: 56,
  /** Per wheel: wheelspin / lock-up slush level on a wet road (FL, FR, RL, RR) -> 57..60. */
  SLUSH0: 57,
  // winter circuits: the share of the wheels on snow (packed or deep) and on studded ice -> 61, 62
  SURF_SNOW: 61,
  SURF_ICE: 62,
  /** The driver's throttle pedal (the throttle body follows it; -1 = not known). */
  PEDAL: 63,
} as const;

export const CTL_LEN = 64;
export const TIRE_STRIDE = 4;

export function makeControlVector(): Float32Array {
  const v = new Float32Array(CTL_LEN);
  v[CTL.IDLE_RPM] = 900;
  v[CTL.RPM] = 900;
  v[CTL.LIMITER_RPM] = 7000;
  v[CTL.REDLINE_RPM] = 6800;
  v[CTL.TIMESCALE] = 1;
  v[CTL.GAIN] = 1;
  v[CTL.QUALITY] = 2;
  v[CTL.CH_GAIN] = 1;
  v[CTL.CH_QUALITY] = 2;
  v[CTL.GEAR] = 1;
  v[CTL.PEDAL] = -1;
  return v;
}

function fin(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback;
}

/** Engine part of the vector, straight from the physics state. */
export function writeEngineControls(v: Float32Array, st: VehicleState): void {
  v[CTL.RPM] = fin(st.rpm, v[CTL.RPM]);
  v[CTL.THROTTLE] = fin(st.throttle, 0);
  v[CTL.PEDAL] = fin(st.throttlePedal, -1);
  // engineLoad is a fraction of PEAK torque (so WOT near redline reads ~0.6-0.9); blend with the pedal
  // so the sound stays aggressive at full throttle and still follows torque nuances
  v[CTL.LOAD] = Math.min(1, 0.5 * Math.max(0, fin(st.engineLoad, 0)) + 0.5 * Math.min(1, Math.max(0, fin(st.throttle, 0))));
  v[CTL.BOOST] = fin(st.boost, 0);
  v[CTL.LIMITER] = st.revLimiter ? 1 : 0;
  // counters are wrapped so Float32 stays exact for a very long session
  v[CTL.SHIFT_COUNT] = fin(st.shiftCount, 0) % 65536;
  v[CTL.BACKFIRE_COUNT] = fin(st.backfireCount, 0) % 65536;
  v[CTL.CLUTCH] = fin(st.clutch, 0);
  v[CTL.IDLE_RPM] = fin(st.idleRpm, 900);
  v[CTL.LIMITER_RPM] = fin(st.limiterRpm, 7000);
  v[CTL.REDLINE_RPM] = fin(st.redlineRpm, 6800);
  v[CTL.SPEED] = fin(st.speed, 0);
  v[CTL.GEAR] = fin(st.gear, 1);
  const w = st.wheels;
  v[CTL.DRIVE_OMEGA] = (Math.abs(w[0].omega) + Math.abs(w[1].omega) + Math.abs(w[2].omega) + Math.abs(w[3].omega)) * 0.25;
}

/** Vector -> engine inputs (worklet side / lab). Sanitises everything. */
export function readEngineInputs(v: Float32Array, o: EngineInputs): void {
  o.rpm = Math.min(Math.max(fin(v[CTL.RPM], o.rpm), 0), 20000);
  o.throttle = Math.min(Math.max(fin(v[CTL.THROTTLE], 0), 0), 1);
  o.load = Math.min(Math.max(fin(v[CTL.LOAD], 0), 0), 1);
  o.boost = Math.min(Math.max(fin(v[CTL.BOOST], 0), 0), 1.5);
  o.limiter = v[CTL.LIMITER];
  o.shiftCount = v[CTL.SHIFT_COUNT];
  o.backfireCount = v[CTL.BACKFIRE_COUNT];
  o.clutch = Math.min(Math.max(fin(v[CTL.CLUTCH], 0), 0), 1);
  o.idleRpm = fin(v[CTL.IDLE_RPM], 900);
  o.limiterRpm = fin(v[CTL.LIMITER_RPM], 7000);
  o.redlineRpm = fin(v[CTL.REDLINE_RPM], 6800);
  o.interior = Math.min(Math.max(fin(v[CTL.INTERIOR], 0), 0), 1);
  o.timeScale = fin(v[CTL.TIMESCALE], 1);
  o.gain = Math.max(0, fin(v[CTL.GAIN], 1));
  o.quality = fin(v[CTL.QUALITY], 2);
  o.driveOmega = fin(v[CTL.DRIVE_OMEGA], 0);
  o.speed = fin(v[CTL.SPEED], 0);
  o.gear = fin(v[CTL.GEAR], 1);
  const pedal = fin(v[CTL.PEDAL], -1);
  o.pedal = pedal < 0 ? -1 : Math.min(pedal, 1);
}
