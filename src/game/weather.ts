/**
 * The weather of a race that changes (owner: game). Pure maths and one small state machine, no three.js, no DOM: the plan of a
 * race (what comes, when, how hard) is a function of its seed, so a restart repeats it, and the director turns the leader's
 * progress into the three numbers every other system reads (`WeatherState`: the sky, the rain, the water on the track).
 *
 *   rain later   a dry start; at 30-65 % of the race distance the leader brings the call ("Rain is coming"), the sky darkens
 *                over a minute, the first drops fall some 35 s after the call, the rain builds for 1-2 minutes to a shower or a
 *                storm, and the track wets with a lag of about a lap
 *   clearing     a wet start; the call, then the rain eases away over 1-2 minutes, the cloud deck lifts after it, and the
 *                track dries a good deal more slowly than it wet (the water has to drain and evaporate)
 *
 * The sky, rain and wetness are separate because they move at different speeds: the clouds lead the rain, the water on the road
 * trails it. Races start the change from the leader's race progress; free roam, which has no race distance, from the clock.
 */
import { WEATHER_WATER, type Forecast, type RaceMode, type Weather, type WeatherState } from '../core/contracts';
import { DRY_BELOW, isWetWeather, sanitizeForecast } from '../core/forecast';

// (what makes a legal forecast, shared with the setup screen, is in src/core/forecast.ts)
export { FORECAST_MIN_LAPS, forecastAllowed, isWetWeather, sanitizeForecast } from '../core/forecast';

// ─────────────────────────────────────────────────────────────────────────────
// The plan
// ─────────────────────────────────────────────────────────────────────────────

/** The leader's race progress (0..1) the call comes between: the first drops fall a little later, 30-65 % of the way round. */
export const CALL_PROGRESS: readonly [number, number] = [0.28, 0.62];
/** Where the call comes in free roam, seconds after the start. */
export const CALL_SECONDS: readonly [number, number] = [60, 150];

export interface WeatherPlan {
  forecast: Exclude<Forecast, 'stable'>;
  /** The weather at the start, and the weather the change ends in. */
  from: Weather;
  to: Weather;
  /** The two skies the renderer blends between (`WeatherState.sky` 0 = dry, 1 = wet). */
  dry: Weather;
  wet: Weather;
  /** What starts the change: the leader reaching this share of the race distance, or this many seconds on the clock. */
  at: { progress: number } | { seconds: number };
  /** Seconds from the call to the first drops (rain later) or to the rain starting to ease (clearing). */
  lead: number;
  /** Seconds the rain takes to build to its peak, or to die away. */
  span: number;
  /** The heaviest the rain gets (the wet weather's own: 0.55 for rain, 1 for a storm). */
  peak: number;
}

/** mulberry32: a small seeded generator, the same numbers on every machine. */
function rng(seed: number): () => number {
  let a = (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PlanRequest {
  forecast: Forecast | undefined;
  weather: Weather;
  mode: RaceMode;
  laps: number;
  seed?: number;
}

/** The plan for a race, or null for a stable one (or one the forecast does not fit). Deterministic in the seed. */
export function makePlan(r: PlanRequest): WeatherPlan | null {
  const forecast = sanitizeForecast(r.forecast, r.weather, r.mode, r.laps);
  if (forecast === 'stable') return null;
  const u = rng(r.seed ?? 1);
  const at = r.mode === 'race' ? { progress: CALL_PROGRESS[0] + (CALL_PROGRESS[1] - CALL_PROGRESS[0]) * u() } : { seconds: CALL_SECONDS[0] + (CALL_SECONDS[1] - CALL_SECONDS[0]) * u() };
  const span = 60 + 60 * u();
  if (forecast === 'rainLater') {
    // two in three bring a shower, one a storm
    const to: Weather = u() < 0.34 ? 'storm' : 'rain';
    return { forecast, from: r.weather, to, dry: r.weather, wet: to, at, lead: 30 + 12 * u(), span, peak: WEATHER_WATER[to].rain };
  }
  // the clouds that stay behind: mostly broken cloud, now and then a clear sky or a grey lid
  const v = u();
  const to: Weather = v < 0.55 ? 'cloudy' : v < 0.85 ? 'clear' : 'overcast';
  return { forecast, from: r.weather, to, dry: to, wet: r.weather, at, lead: 18 + 10 * u(), span, peak: WEATHER_WATER[r.weather].rain };
}

// ─────────────────────────────────────────────────────────────────────────────
// The curves
// ─────────────────────────────────────────────────────────────────────────────

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/** The sky and the rain `u` seconds after the call (the water on the track is not a function of time alone, see `stepWetness`). */
export function evaluate(plan: WeatherPlan, u: number, out: { sky: number; rain: number }): { sky: number; rain: number } {
  if (plan.forecast === 'rainLater') {
    // the cloud closes in over a minute or so, and the first drops fall into it
    out.sky = smooth(u / (plan.lead * 1.7));
    out.rain = plan.peak * smooth((u - plan.lead) / plan.span);
  } else {
    out.rain = plan.peak * (1 - smooth((u - plan.lead) / plan.span));
    // the deck lifts after the rain has begun to ease, and lets go of the sky last
    out.sky = 1 - smooth((u - plan.lead - plan.span * 0.25) / (plan.span * 0.9 + 40));
  }
  return out;
}

/** Seconds from the call until nothing changes any more in the sky and the rain. */
export function planDuration(plan: WeatherPlan): number {
  return plan.forecast === 'rainLater' ? plan.lead + plan.span : plan.lead + plan.span * 1.15 + 40;
}

/** The water a road settles to under this rain: the weather presets' own pairs (0.55 -> 0.75, 1 -> 1), straight lines between. */
export function wetnessTarget(rain: number): number {
  const r = clamp01(rain);
  const a = WEATHER_WATER.rain;
  const b = WEATHER_WATER.storm;
  return r <= a.rain ? (r * a.wetness) / a.rain : a.wetness + ((r - a.rain) / (b.rain - a.rain)) * (b.wetness - a.wetness);
}

/** Time constant (s) of the road taking water: a lap and a bit from dry to soaked under steady rain. */
export const WET_RISE_TAU = 30;
/** Drying: an exponential tail (time constant, s) and a constant part so that the road is really dry in the end. */
export const DRY_TAU = 240;
export const DRY_RATE = 1 / 1500;

/**
 * The water on the road after `dt` seconds under rain that would leave it at `target`. It rises toward the target as a first-order
 * lag (stable for any step) and falls away more slowly than that, down to the target and no further.
 */
export function stepWetness(w: number, target: number, dt: number): number {
  if (!(dt > 0)) return w;
  if (target > w) return w + (target - w) * (1 - Math.exp(-dt / WET_RISE_TAU));
  const c = DRY_RATE * DRY_TAU;
  const next = (w + c) * Math.exp(-dt / DRY_TAU) - c;
  return Math.max(target, Math.min(w, next));
}

/** What the road is like under the tyres, for the HUD (on a winter circuit the wetness is the fresh snow lying on the packed road). */
export function trackCondition(wetness: number, winter = false): string {
  if (winter) return wetness < DRY_BELOW ? 'Packed' : wetness < 0.25 ? 'Dusted' : wetness < 0.6 ? 'Fresh snow' : wetness < 0.9 ? 'Deep snow' : 'Drifting';
  return wetness < DRY_BELOW ? 'Dry' : wetness < 0.25 ? 'Damp' : wetness < 0.6 ? 'Wet' : wetness < 0.9 ? 'Very wet' : 'Soaked';
}

/** A lap (or any stretch) driven on a road wetter than this is a wet one: its time goes in the wet records. */
export const WET_RECORD = 0.08;

// ─────────────────────────────────────────────────────────────────────────────
// The director
// ─────────────────────────────────────────────────────────────────────────────

export type WeatherEventKind = 'call' | 'stopped';

export interface WeatherEvent {
  kind: WeatherEventKind;
  /** The notice that goes with it. */
  notice: { kind: 'rain' | 'clearing'; title: string; sub: string };
}

const NOTICES = {
  rainLater: { kind: 'rain', title: 'Rain is coming', sub: 'The track will get wet within a lap or two' },
  clearing: { kind: 'clearing', title: 'Skies are clearing', sub: 'The rain is easing. The track will dry slowly' },
  stopped: { kind: 'clearing', title: 'The rain has stopped', sub: 'The track is drying: grip comes back slowly' },
} as const;

/** The same notices at a winter circuit: the snow is coming, and the fresh snow packs down under the cars. */
const NOTICES_WINTER = {
  rainLater: { kind: 'rain', title: 'Snow is coming', sub: 'Fresh snow will cover the track within a lap or two' },
  clearing: { kind: 'clearing', title: 'Skies are clearing', sub: 'The snow is easing. The track will pack down slowly' },
  stopped: { kind: 'clearing', title: 'The snow has stopped', sub: 'The fresh snow is packing down: grip comes back slowly' },
} as const;

/** Where a race's weather is: waits for the call, runs the change, then keeps drying (or wetting) until the road has caught up. */
export class WeatherDirector {
  /** The state everyone reads; one object, rewritten in place. */
  readonly state: WeatherState;
  /** Seconds since the call (scaled by `speed`), 0 before it. */
  elapsed = 0;
  called = false;
  private readonly events: WeatherEvent[] = [];
  private stoppedSent = false;
  private readonly tmp = { sky: 0, rain: 0 };
  private manual = false;

  /** `speed` runs the weather faster than the clock (a development flag for looking at it: ?wxspeed=10). */
  constructor(
    readonly plan: WeatherPlan | null,
    readonly speed = 1,
    /** A winter circuit: the notices talk about snow. */
    readonly winter = false,
  ) {
    this.state = plan ? startState(plan) : { sky: 0, rain: 0, wetness: 0 };
  }

  /**
   * Advance `dt` seconds. `progress` is the leader's share of the race distance (0..1; it can start below 0 on the grid) and
   * `seconds` the time since the start, whichever the plan's call waits for.
   */
  update(dt: number, progress: number, seconds: number): void {
    const plan = this.plan;
    if (!plan || this.manual) return;
    if (!this.called) {
      const hit = 'progress' in plan.at ? progress >= plan.at.progress : seconds >= plan.at.seconds;
      if (!hit) return;
      this.called = true;
      this.events.push({ kind: 'call', notice: (this.winter ? NOTICES_WINTER : NOTICES)[plan.forecast] });
    }
    this.advance(dt * this.speed);
  }

  private advance(dt: number): void {
    const plan = this.plan!;
    const s = this.state;
    this.elapsed += dt;
    evaluate(plan, this.elapsed, this.tmp);
    s.sky = this.tmp.sky;
    s.rain = this.tmp.rain;
    s.wetness = stepWetness(s.wetness, wetnessTarget(s.rain), dt);
    if (plan.forecast === 'clearing' && !this.stoppedSent && this.elapsed >= plan.lead + plan.span) {
      this.stoppedSent = true;
      this.events.push({ kind: 'stopped', notice: (this.winter ? NOTICES_WINTER : NOTICES).stopped });
    }
  }

  /** Hand out the events since the last call (an empty array, always the same one, when there are none). */
  drain(): readonly WeatherEvent[] {
    return this.events.length ? this.events.splice(0, this.events.length) : NONE;
  }

  /** Development: hold the weather at exactly this state (the plan is ignored from now on). */
  hold(s: Partial<WeatherState>): void {
    this.manual = true;
    Object.assign(this.state, s);
  }
}

const NONE: readonly WeatherEvent[] = [];

/** The state of a plan before the call: the start weather's own. */
export function startState(plan: WeatherPlan): WeatherState {
  const w = WEATHER_WATER[plan.from];
  return { sky: plan.forecast === 'rainLater' ? 0 : 1, rain: w.rain, wetness: w.wetness };
}

/** The state of fixed weather (the presets' own numbers). */
export function fixedState(weather: Weather): WeatherState {
  const w = WEATHER_WATER[weather];
  return { sky: isWetWeather(weather) ? 1 : 0, rain: w.rain, wetness: w.wetness };
}

/** The weather preset nearest to a state, for the HUD's icon: rain where it rains, else the dry sky or the grey lid left over it. */
export function nearestWeather(plan: WeatherPlan, s: WeatherState): Weather {
  if (s.rain > 0.8) return 'storm';
  if (s.rain > 0.04) return 'rain';
  return s.sky < 0.5 ? plan.dry : 'overcast';
}

// ─────────────────────────────────────────────────────────────────────────────
// The log
// ─────────────────────────────────────────────────────────────────────────────

/** The weather of a race as it went, a sample every half second, for a replay to play back (it runs on the replay's own clock). */
export class WeatherLog {
  private readonly t: number[] = [];
  private readonly v: number[] = [];
  private last = -Infinity;

  reset(): void {
    this.t.length = 0;
    this.v.length = 0;
    this.last = -Infinity;
  }

  get samples(): number {
    return this.t.length;
  }

  /** Note the state at time `t` (seconds since the race's replay began); a state closer than half a second to the last is skipped. */
  sample(t: number, s: WeatherState): void {
    if (t - this.last < 0.5) return;
    this.last = t;
    this.t.push(t);
    this.v.push(s.sky, s.rain, s.wetness);
  }

  /** The state at time `t`, interpolated (before the first sample and after the last: those). False when nothing was logged. */
  at(t: number, out: WeatherState): boolean {
    const n = this.t.length;
    if (n === 0) return false;
    let lo = 0;
    let hi = n - 1;
    if (t <= this.t[0]) hi = 0;
    else if (t >= this.t[hi]) lo = hi;
    else {
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (this.t[mid] <= t) lo = mid;
        else hi = mid;
      }
    }
    const f = hi === lo ? 0 : (t - this.t[lo]) / (this.t[hi] - this.t[lo]);
    const a = lo * 3;
    const b = hi * 3;
    out.sky = this.v[a] + (this.v[b] - this.v[a]) * f;
    out.rain = this.v[a + 1] + (this.v[b + 1] - this.v[a + 1]) * f;
    out.wetness = this.v[a + 2] + (this.v[b + 2] - this.v[a + 2]) * f;
    return true;
  }
}
