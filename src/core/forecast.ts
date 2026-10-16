/**
 * The rules of a race's forecast, shared by the setup screen (which offers what makes sense), the game (which runs it) and the
 * HUD (the words and the meter for how wet the track is). Pure. The timeline itself is src/game/weather.ts.
 */
import type { Forecast, RaceMode, Weather } from './contracts';

export const FORECASTS: readonly Forecast[] = ['stable', 'rainLater', 'clearing'];

export const isWetWeather = (w: Weather): boolean => w === 'rain' || w === 'storm';

/** The water on the track (0..1) below which it is called dry: the HUD's word for it, and where the first bar of its meter lights. */
export const DRY_BELOW = 0.04;

/** How many segments of the HUD's wetness meter are lit: none while the track is called dry, then one per fifth of the water, all at soaked. */
export function wetnessBars(wetness: number, segments = 5): number {
  return wetness < DRY_BELOW ? 0 : Math.min(segments, Math.ceil(Math.min(1, wetness) * segments - 1e-6));
}

/** A race of fewer laps is over before the weather has done anything worth the name. */
export const FORECAST_MIN_LAPS = 2;

/** Can `forecast` be run for this weather and mode? Rain later wants a dry start, clearing a wet one; a time trial stays as set. */
export function forecastAllowed(forecast: Forecast, weather: Weather, mode: RaceMode, laps: number): boolean {
  if (forecast === 'stable') return true;
  if (mode === 'timeTrial') return false;
  if (mode === 'race' && !(laps >= FORECAST_MIN_LAPS)) return false;
  return forecast === 'rainLater' ? !isWetWeather(weather) : isWetWeather(weather);
}

/** The forecast a config may really run: what was asked for when it is allowed, else stable. */
export function sanitizeForecast(forecast: Forecast | undefined, weather: Weather, mode: RaceMode, laps: number): Forecast {
  return forecast && forecastAllowed(forecast, weather, mode, laps) ? forecast : 'stable';
}

/** The forecasts the setup screen offers for this weather and mode, stable first. */
export function forecastOptions(weather: Weather, mode: RaceMode, laps: number): Forecast[] {
  return FORECASTS.filter((f) => forecastAllowed(f, weather, mode, laps));
}
