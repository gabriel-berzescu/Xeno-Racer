/**
 * Weather model — the pure, allocation-light logic behind the rain / storm audio. No Web Audio and no
 * DOM, so the main thread, the AudioWorklet DSP, the offline lab and the unit tests all share it.
 *
 *   sanitizeWeather      clamp / NaN-proof the numbers the game hands to setWeather()
 *   WCTL                 the weather node's control-vector layout (rain, interior, speed, gain)
 *   rainProfile          rain intensity -> drop-stream rates and bed levels (monotonic, 0 when dry)
 *   wetRoad              speed / wetness / surface -> the wet-tire hiss, spray and brightness
 *   ThunderScheduler     randomised "every ~20-60 s" thunder, only in storms
 *   planThunder          one thunder event -> a rolling multi-lobe envelope (distance shapes it)
 */
import { Rng, clamp, clamp01, fin, lerp, smoothstep } from './dsp/util';

// ── sanitising ───────────────────────────────────────────────────────────────

/** Finite number clamped to 0..1 (NaN / +-Infinity -> 0). */
export function unit(x: number): number {
  return Number.isFinite(x) ? clamp01(x) : 0;
}

export interface WeatherTarget {
  rain: number;
  wetness: number;
}

export function sanitizeWeather(rain: number, wetness: number): WeatherTarget {
  return { rain: unit(rain), wetness: unit(wetness) };
}

// ── weather node control vector ──────────────────────────────────────────────

export const WCTL = {
  RAIN: 0,
  INTERIOR: 1,
  SPEED: 2,
  GAIN: 3,
  /** 1 = the precipitation is snow (a winter circuit): no drops, only the wind. */
  SNOW: 4,
} as const;
export const WCTL_LEN = 8;

export function makeWeatherControlVector(): Float32Array {
  const v = new Float32Array(WCTL_LEN);
  v[WCTL.GAIN] = 1;
  return v;
}

/** Live inputs of the weather DSP (targets; the voice smooths them itself). */
export interface WeatherInputs {
  /** 0..1 precipitation target. */
  rain: number;
  /** 0 = exterior view .. 1 = interior (cockpit / hood / bumper). */
  interior: number;
  /** The player's speed in m/s (drives the windscreen / roof drumming). */
  speed: number;
  /** Output gain; ~0 puts the voice to sleep (pause, hidden tab). */
  gain: number;
  /** The precipitation is snow: no drops on the ground, the roof or the glass, a wind bed that rises with the snowfall. */
  snow: number;
}

export function makeWeatherInputs(): WeatherInputs {
  return { rain: 0, interior: 0, speed: 0, gain: 1, snow: 0 };
}

export function readWeatherInputs(v: Float32Array, o: WeatherInputs): void {
  o.rain = unit(v[WCTL.RAIN]);
  o.interior = unit(v[WCTL.INTERIOR]);
  o.speed = clamp(fin(v[WCTL.SPEED], 0), 0, 200);
  o.gain = Math.max(0, fin(v[WCTL.GAIN], 1));
  o.snow = v[WCTL.SNOW] > 0.5 ? 1 : 0;
}

// ── rain profile ─────────────────────────────────────────────────────────────

/**
 * Event streams of the rain bed. The first four are heard everywhere outside; the last three are the
 * cabin: drumming on the roof, patter on the panels and ticks on the windscreen.
 */
export const STREAM = { GRAIN: 0, TICK: 1, PLINK: 2, SPLAT: 3, DRUM: 4, PATTER: 5, GLASS: 6 } as const;
export const N_STREAMS = 7;

export interface RainProfile {
  /** Drop events per second per stream (exterior streams already scaled by 1 - interior, cabin by interior). */
  rate: Float64Array;
  /** Smooth bed: bright sizzle (exterior), body (exterior) and the muffled cabin bed, linear levels. */
  bedHi: number;
  bedLo: number;
  bedCabin: number;
  /** Storm wind bed level. */
  wind: number;
  /** How rough the rain intensity is (gusts): 0 steady .. 1 stormy. */
  gustDepth: number;
}

export function makeRainProfile(): RainProfile {
  return { rate: new Float64Array(N_STREAMS), bedHi: 0, bedLo: 0, bedCabin: 0, wind: 0, gustDepth: 0 };
}

/**
 * Rain intensity (0..1) -> stream rates and bed levels. Everything is exactly 0 at rain = 0 and rises
 * monotonically with the intensity; light rain is mostly separate drops (patter), heavy rain is a dense
 * roar with the odd big drop standing out.
 *
 * `interior` (0..1) cross-fades the exterior set into the cabin set; `speedN` (0..1, player speed / 70 m/s)
 * feeds the windscreen.
 */
export function rainProfile(rain: number, interior: number, speedN: number, out: RainProfile, snow = false): RainProfile {
  const r = unit(rain);
  const c = unit(interior);
  const e = 1 - c;
  speedN = unit(speedN);
  const rate = out.rate;
  rate[STREAM.GRAIN] = e * 1500 * Math.pow(r, 1.4);
  rate[STREAM.TICK] = e * 260 * Math.pow(r, 1.1);
  rate[STREAM.PLINK] = e * 150 * Math.pow(r, 1.0);
  rate[STREAM.SPLAT] = e * 16 * Math.pow(r, 1.5);
  // a moving car runs into the rain: more drops on the roof and panels the faster it goes (1.0 at ~40 m/s)
  const cabinSpeed = 0.75 + 0.45 * speedN;
  rate[STREAM.DRUM] = c * 150 * Math.pow(r, 1.1) * cabinSpeed;
  rate[STREAM.PATTER] = c * 330 * Math.pow(r, 1.05) * cabinSpeed;
  rate[STREAM.GLASS] = c * (28 + 150 * r) * (0.55 + 0.9 * speedN) * smoothstep(0, 0.12, r);
  out.bedHi = e * Math.pow(r, 1.2);
  out.bedLo = e * Math.pow(r, 1.2);
  out.bedCabin = c * Math.pow(r, 1.2);
  out.wind = smoothstep(0.6, 1, r);
  out.gustDepth = 0.35 + 0.65 * smoothstep(0.4, 1, r);
  if (snow) {
    // snow falls silently: no drops, no roar; what is heard is the wind that carries it, a breath in a light fall, a gale in a blizzard
    rate.fill(0);
    out.bedHi = out.bedLo = out.bedCabin = 0;
    out.wind = r > 0 ? clamp01(0.1 + 0.9 * smoothstep(0.05, 1, r)) : 0;
    out.gustDepth = 0.3 + 0.7 * smoothstep(0.2, 1, r);
  }
  return out;
}

// ── wet road ─────────────────────────────────────────────────────────────────

export interface WetRoadLevels {
  /** Tire hiss level (2-8 kHz water sizzle), 0 on a dry road. */
  hiss: number;
  /** Mid-band spray wash level (200-2000 Hz). */
  spray: number;
  /** Playback step of the noise tables: >1 = brighter, <1 = duller. */
  step: number;
  /** Fraction by which the dry road roar is reduced (water fills the tread texture). */
  roarCut: number;
  /** Rate of puddle splashes per second per car. */
  splashRate: number;
}

export function makeWetRoadLevels(): WetRoadLevels {
  return { hiss: 0, spray: 0, step: 1, roarCut: 0, splashRate: 0 };
}

/**
 * `wet` = track water 0..1, `paved` = share of the car's wheels on a wet-able surface (0..1, already
 * weighted by how much water each surface holds), `speed` in m/s, `interior` 0..1.
 */
export function wetRoad(wet: number, paved: number, speed: number, interior: number, out: WetRoadLevels): WetRoadLevels {
  const w = unit(wet) * unit(paved);
  speed = Number.isFinite(speed) ? Math.max(speed, 0) : 0;
  interior = unit(interior);
  if (w <= 0) {
    out.hiss = out.spray = out.roarCut = out.splashRate = 0;
    out.step = 1;
    return out;
  }
  const sN = clamp(speed / 70, 0, 1.4);
  const wAmt = Math.pow(w, 0.85);
  // water starts to sizzle under a rolling tire above walking pace
  const gate = smoothstep(1.5, 16, speed);
  // hiss ~ v^1.6 (about +9.6 dB per doubling), spray ~ v^2.2 (the wash only really builds at speed)
  out.hiss = wAmt * gate * Math.pow(sN, 1.6) * lerp(1, 0.7, interior);
  out.spray = wAmt * gate * Math.pow(sN, 2.2) * lerp(1, 0.55, interior);
  // brighter with speed (finer droplets), duller in the cabin
  out.step = (0.8 + 0.42 * Math.min(sN, 1.2)) * lerp(1, 0.62, interior);
  out.roarCut = 0.32 * wAmt;
  out.splashRate = 0.9 * smoothstep(0.35, 1, w) * smoothstep(12, 45, speed);
  return out;
}

// ── thunder ──────────────────────────────────────────────────────────────────

/** Speed of sound used for the flash-to-bang delay (m/s). */
export const THUNDER_SOUND_SPEED = 343;
/** Rain intensity below which a storm never thunders (the "rain" preset stays quiet). */
export const THUNDER_MIN_RAIN = 0.75;
/** Seconds between thunder claps at full storm intensity: uniform in [MIN, MAX]. */
export const THUNDER_INTERVAL_MIN = 20;
export const THUNDER_INTERVAL_MAX = 60;

export interface ThunderEvent {
  /** Distance of the strike in km (shapes the onset, the length and the darkness). */
  distanceKm: number;
  /** 0..1 loudness. */
  level: number;
  /** -1..1 stereo position of the rumble. */
  pan: number;
  /** Seeds the random shape of the lobes and the noise. */
  seed: number;
}

/**
 * Seconds until the next thunder clap. `u` is a uniform random number in [0, 1). Infinity when it is
 * not stormy enough; a lighter storm thunders less often (up to 3x the full-storm interval).
 */
export function thunderInterval(rain: number, u: number): number {
  if (!(rain >= THUNDER_MIN_RAIN)) return Infinity;
  const k = smoothstep(THUNDER_MIN_RAIN, 0.95, rain);
  const base = THUNDER_INTERVAL_MIN + (THUNDER_INTERVAL_MAX - THUNDER_INTERVAL_MIN) * clamp01(u);
  return base * lerp(3, 1, k);
}

/** Flash-to-bang delay in seconds. */
export function thunderDelay(distanceKm: number): number {
  return (distanceKm * 1000) / THUNDER_SOUND_SPEED;
}

/**
 * Randomised thunder clock. `tick(dt, rain)` is called every frame while the game is running (a paused
 * game simply does not tick it); it returns a strike when one is due. A dry spell (rain below the storm
 * threshold) re-arms the clock, the first clap of a storm comes after 35-75 % of a normal interval, and two
 * claps are never closer than THUNDER_INTERVAL_MIN seconds.
 */
export class ThunderScheduler {
  private rng: Rng;
  /** Seconds until the next strike; NaN = not armed. */
  timer = Number.NaN;
  count = 0;

  constructor(seed = 1) {
    this.rng = new Rng(seed * 7919 + 13);
  }

  reset(): void {
    this.timer = Number.NaN;
  }

  tick(dt: number, rain: number): ThunderEvent | null {
    if (!(rain >= THUNDER_MIN_RAIN) || !(dt > 0)) {
      if (!(rain >= THUNDER_MIN_RAIN)) this.timer = Number.NaN;
      return null;
    }
    if (Number.isNaN(this.timer)) {
      this.timer = thunderInterval(rain, this.rng.u()) * (0.35 + 0.4 * this.rng.u());
      return null;
    }
    this.timer -= dt;
    if (this.timer > 0) return null;
    const ev = this.makeEvent();
    this.timer = thunderInterval(rain, this.rng.u()); // always >= THUNDER_INTERVAL_MIN while it is stormy
    this.count++;
    return ev;
  }

  private makeEvent(): ThunderEvent {
    const r = this.rng;
    // mostly far away; the odd closer one is still a soft, low rumble (never a sharp crack)
    const far = Math.pow(r.u(), 0.8);
    return {
      distanceKm: 2.5 + 7.5 * far,
      level: 0.55 + 0.45 * (1 - far) * (0.6 + 0.4 * r.u()),
      pan: (r.u() + r.u() - 1) * 0.8,
      seed: 1 + Math.floor(r.u() * 1e9),
    };
  }
}

export const THUNDER_MAX_LOBES = 10;

/** One thunder clap as a sum of overlapping fast-rise / slow-fall lobes, plus the filter sweep. */
export interface ThunderPlan {
  n: number;
  /** Lobe start (s), amplitude, attack and decay time constants (s). */
  t: Float64Array;
  amp: Float64Array;
  att: Float64Array;
  dec: Float64Array;
  /** Per-lobe peak of the unit lobe (normalisation). */
  lobePeak: Float64Array;
  /** Seconds until the whole clap has decayed by 50 dB. */
  dur: number;
  /** Peak of the summed raw envelope (so that thunderEnvelope() peaks at 1). */
  peak: number;
  /** Rumble low-pass cutoff at the start / end of the clap (Hz) and the sweep time constant. */
  fc0: number;
  fc1: number;
  tauFc: number;
  level: number;
  pan: number;
  rng: Rng;
}

export function makeThunderPlan(): ThunderPlan {
  const z = (): Float64Array => new Float64Array(THUNDER_MAX_LOBES);
  return { n: 0, t: z(), amp: z(), att: z(), dec: z(), lobePeak: z(), dur: 0, peak: 1, fc0: 200, fc1: 90, tauFc: 3, level: 0, pan: 0, rng: new Rng(1) };
}

/** Peak value of exp(-t/D) - exp(-t/A) for D > A. */
function lobePeakValue(A: number, D: number): number {
  const ts = ((A * D) / (D - A)) * Math.log(D / A);
  return Math.exp(-ts / D) - Math.exp(-ts / A);
}

/** Fill `p` for one strike. Allocation-free (the plan owns its RNG). */
export function planThunder(p: ThunderPlan, ev: ThunderEvent): ThunderPlan {
  const rng = p.rng;
  rng.s = (Math.floor(ev.seed) | 0) || 0x2545f491;
  for (let i = 0; i < 4; i++) rng.u();
  const d = clamp(Number.isFinite(ev.distanceKm) ? ev.distanceKm : 5, 1, 14);
  const s = clamp((d - 1.5) / 9, 0, 1); // 0 near .. 1 far
  const n = clamp(4 + Math.floor(rng.u() * 3) + (s > 0.5 ? 1 : 0), 4, THUNDER_MAX_LOBES);
  p.n = n;
  const att0 = lerp(0.24, 0.7, s) * (0.8 + 0.4 * rng.u());
  const dec0 = lerp(0.62, 1.15, s) * (0.8 + 0.4 * rng.u());
  const span = lerp(2.6, 5.4, s) * (0.85 + 0.3 * rng.u());
  let dur = 0;
  for (let k = 0; k < n; k++) {
    const f = k / n;
    p.t[k] = k === 0 ? 0 : span * Math.pow((k + 0.75 * rng.u()) / n, 1.15);
    p.amp[k] = k === 0 ? 1 : lerp(0.85, 0.3, f) * (0.55 + 0.45 * rng.u());
    p.att[k] = k === 0 ? att0 : att0 * (1 + 1.4 * rng.u());
    p.dec[k] = k === n - 1 ? dec0 * 1.5 : dec0 * (0.65 + 0.7 * rng.u());
    if (p.dec[k] < p.att[k] * 1.5) p.dec[k] = p.att[k] * 1.5;
    p.lobePeak[k] = lobePeakValue(p.att[k], p.dec[k]);
    dur = Math.max(dur, p.t[k] + 5.76 * p.dec[k]);
  }
  p.dur = Math.min(dur, 12.5);
  // normalise: sample the envelope every 20 ms
  let pk = 1e-9;
  p.peak = 1;
  for (let t = 0; t < p.dur; t += 0.02) pk = Math.max(pk, thunderEnvelope(p, t));
  p.peak = pk;
  p.fc0 = lerp(420, 220, s) * (0.9 + 0.2 * rng.u());
  p.fc1 = p.fc0 * 0.38;
  p.tauFc = p.dur / 2.2;
  p.level = unit(ev.level);
  p.pan = Number.isFinite(ev.pan) ? clamp(ev.pan, -1, 1) : 0;
  return p;
}

/** Envelope of a planned clap at time t (s), normalised so that its maximum is 1. It is faded out over the last second. */
export function thunderEnvelope(p: ThunderPlan, t: number): number {
  let e = 0;
  for (let k = 0; k < p.n; k++) {
    const x = t - p.t[k];
    if (x <= 0) continue;
    e += (p.amp[k] * (Math.exp(-x / p.dec[k]) - Math.exp(-x / p.att[k]))) / p.lobePeak[k] / p.peak;
  }
  const tail = p.dur - t;
  if (tail < 1) e *= tail <= 0 ? 0 : tail * tail * (3 - 2 * tail);
  return e > 0 ? e : 0;
}
