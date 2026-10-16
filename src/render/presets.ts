/**
 * Time-of-day and weather presets (owner: render).
 *
 * Everything the sky, light rig, fog and tone mapper need for one (TimeOfDay, Weather) pair.
 * Numbers are artistic: radiance is "relative to solar irradiance E" (see atmosphere.ts), the light
 * intensities are in three.js units, exposure scales the final tone mapper.
 */
import type { TimeOfDay, Weather } from '../core/contracts';

export interface TodPreset {
  /** Elevation of the light-casting body (sun; at night the moon), degrees. */
  elDeg: number;
  /** Azimuth in the XZ plane, degrees, measured from +Z toward +X. */
  azDeg: number;
  /** Scene "solar irradiance": directional light intensity before atmospheric transmittance. */
  sunE: number;
  /** Artistic gain on sky radiance (sky ambient and sky colour scale with it). */
  skyGain: number;
  /** Final tone-mapper exposure. */
  exposure: number;
  /** 0 = full day .. 1 = full night (EnvironmentState.darkness). */
  darkness: number;
  /** Night sky visibility: stars and moon (0..1). */
  stars: number;
  moon: boolean;
  /** Fog density multiplier (morning mist, dusk haze). */
  haze: number;
  /** Hemisphere fill relative to the sky mean irradiance. */
  hemi: number;
  /** Image-based light multiplier (night boosts ambient without brightening the sky). */
  env: number;
  /** Cloud light scale (sun light that reaches the visible cloud faces). */
  cloud: number;
  /** Warm / cool grade shift: +1 warm. */
  warmth: number;
  /** Direction of the true sun when the light-casting body is the moon (degrees). */
  trueSunElDeg?: number;
  trueSunAzDeg?: number;
  /** Northern lights in a clear sky (0..1): winter circuits only. */
  aurora?: number;
}

export const TOD: Record<TimeOfDay, TodPreset> = {
  dawn: { elDeg: 3.5, azDeg: 80, sunE: 3.2, skyGain: 3.0, exposure: 3.4, darkness: 0.22, stars: 0.0, moon: false, haze: 1.6, hemi: 0.5, env: 1.35, cloud: 0.36, warmth: 0.5 },
  morning: { elDeg: 24, azDeg: 115, sunE: 3.5, skyGain: 2.7, exposure: 1.65, darkness: 0.0, stars: 0.0, moon: false, haze: 1.2, hemi: 0.4, env: 1.0, cloud: 0.36, warmth: 0.25 },
  noon: { elDeg: 63, azDeg: 200, sunE: 3.7, skyGain: 2.6, exposure: 1.2, darkness: 0.0, stars: 0.0, moon: false, haze: 0.8, hemi: 0.35, env: 1.0, cloud: 0.36, warmth: 0.0 },
  golden: { elDeg: 8.5, azDeg: 262, sunE: 3.4, skyGain: 2.8, exposure: 2.6, darkness: 0.05, stars: 0.0, moon: false, haze: 1.0, hemi: 0.45, env: 1.4, cloud: 0.36, warmth: 0.45 },
  dusk: { elDeg: 0.9, azDeg: 285, sunE: 3.0, skyGain: 3.2, exposure: 5.5, darkness: 0.55, stars: 0.25, moon: false, haze: 1.3, hemi: 0.6, env: 1.3, cloud: 0.36, warmth: 0.3 },
  night: { elDeg: 42, azDeg: 150, sunE: 0.62, skyGain: 0.7, exposure: 4.6, darkness: 1.0, stars: 1.0, moon: true, haze: 0.9, hemi: 0.6, env: 2.1, cloud: 0.16, warmth: -0.5, trueSunElDeg: -28, trueSunAzDeg: 330 },
};

/**
 * The same six times of day on a winter circuit (far north in late winter): the sun never gets high, even at noon, and it hangs in the
 * south-east, south, south-west; dusk is the blue hour, the sky pink and blue over a snow that gives its light back. Snow is five times
 * as bright as grass, so the exposures are a good deal lower.
 */
export const TOD_WINTER: Record<TimeOfDay, TodPreset> = {
  dawn: { elDeg: 0.8, azDeg: 120, sunE: 3.2, skyGain: 3.0, exposure: 2.3, darkness: 0.2, stars: 0.0, moon: false, haze: 1.5, hemi: 0.55, env: 1.35, cloud: 0.36, warmth: 0.5, aurora: 0.1 },
  morning: { elDeg: 7, azDeg: 132, sunE: 3.5, skyGain: 2.7, exposure: 1.0, darkness: 0.0, stars: 0.0, moon: false, haze: 1.15, hemi: 0.4, env: 1.0, cloud: 0.36, warmth: 0.3 },
  noon: { elDeg: 14, azDeg: 190, sunE: 3.7, skyGain: 2.6, exposure: 0.78, darkness: 0.0, stars: 0.0, moon: false, haze: 0.9, hemi: 0.38, env: 1.0, cloud: 0.36, warmth: 0.0 },
  golden: { elDeg: 3.8, azDeg: 238, sunE: 3.4, skyGain: 2.8, exposure: 1.6, darkness: 0.05, stars: 0.0, moon: false, haze: 1.0, hemi: 0.45, env: 1.4, cloud: 0.36, warmth: 0.45 },
  dusk: { elDeg: -1.6, azDeg: 252, sunE: 3.0, skyGain: 3.2, exposure: 3.4, darkness: 0.5, stars: 0.25, moon: false, haze: 1.2, hemi: 0.62, env: 1.3, cloud: 0.36, warmth: 0.1, aurora: 0.2 },
  night: { elDeg: 38, azDeg: 150, sunE: 0.62, skyGain: 0.7, exposure: 3.5, darkness: 1.0, stars: 1.0, moon: true, haze: 0.9, hemi: 0.6, env: 2.1, cloud: 0.16, warmth: -0.5, trueSunElDeg: -28, trueSunAzDeg: 330, aurora: 1.0 },
};

export interface WeatherPreset {
  /** 2D cloud coverage (0 clear .. 1 overcast). */
  coverage: number;
  /** Cloud edge softness. */
  soft: number;
  /** Cirrus (high wispy layer) amount. */
  cirrus: number;
  /** Direct sun multiplier. */
  sun: number;
  /** Sky radiance multiplier (overcast skies are dimmer overall). */
  sky: number;
  /** Aerosol multiplier for the atmosphere model. */
  mie: number;
  /** Mix toward a grey overcast sky (0..1). */
  overcast: number;
  /** Fog density multiplier. */
  fog: number;
  /** Sun shadow strength (0..1). */
  shadow: number;
  /** Exposure compensation. */
  exposure: number;
  /** Cloud darkness (thick bases). */
  dark: number;
  /**
   * Rain-bearing cloud deck (0 = the ordinary cumulus layer, 1 = a solid, low, heavy deck that replaces it).
   * Everything below only matters when this is > 0, so the dry presets render exactly as before.
   */
  deck: number;
  /** How dark the thick parts of the deck are against the pale horizon haze (0..1). */
  deckDark: number;
  /** Ragged low scud under the deck (0..1). */
  scud: number;
  /** Rain-haze extinction (1/m, Beer-Lambert): far scenery dissolves into the mist as exp(-k d). */
  rainFog: number;
  /** Added to the time-of-day darkness: lamps and headlights come on under a black storm sky. */
  darken: number;
  /** Share of the low sun's warm horizon colour that survives under the deck (dawn / dusk glow). */
  glow: number;
}

export const WEATHER: Record<Weather, WeatherPreset> = {
  clear: { coverage: 0.3, soft: 0.1, cirrus: 0.24, sun: 1.0, sky: 1.0, mie: 1.0, overcast: 0.0, fog: 1.0, shadow: 1.0, exposure: 1.0, dark: 0.35, deck: 0, deckDark: 0, scud: 0, rainFog: 0, darken: 0, glow: 0 },
  cloudy: { coverage: 0.62, soft: 0.16, cirrus: 0.25, sun: 0.7, sky: 0.95, mie: 1.8, overcast: 0.3, fog: 1.35, shadow: 0.82, exposure: 1.05, dark: 0.55, deck: 0, deckDark: 0, scud: 0, rainFog: 0, darken: 0, glow: 0 },
  overcast: { coverage: 1.0, soft: 0.4, cirrus: 0.0, sun: 0.1, sky: 0.9, mie: 3.0, overcast: 0.92, fog: 2.0, shadow: 0.22, exposure: 1.4, dark: 0.8, deck: 0, deckDark: 0, scud: 0, rainFog: 0, darken: 0, glow: 0 },
  // Rain: a low grey ceiling, soft shadowless light, milky haze that thickens with distance.
  rain: { coverage: 1.0, soft: 0.5, cirrus: 0.0, sun: 0.04, sky: 0.52, mie: 3.6, overcast: 0.97, fog: 1.5, shadow: 0.0, exposure: 1.45, dark: 0.9, deck: 1, deckDark: 0.6, scud: 0.4, rainFog: 0.0007, darken: 0.14, glow: 0.13 },
  // Storm: the same ceiling, much darker and lower, hard rain, a few hundred metres of visibility.
  storm: { coverage: 1.0, soft: 0.6, cirrus: 0.0, sun: 0.02, sky: 0.36, mie: 4.2, overcast: 1.0, fog: 2.0, shadow: 0.0, exposure: 1.4, dark: 1.0, deck: 1, deckDark: 0.9, scud: 0.8, rainFog: 0.0016, darken: 0.4, glow: 0.08 },
};

/**
 * The weathers of a winter circuit: the clear, cloudy and overcast skies are the ordinary ones; 'rain' is a snowfall (a low, soft white
 * ceiling, a milky light from every side, the flakes thinning the view) and 'storm' a blizzard (the same, thicker, darker, a few hundred
 * metres of sight).
 */
export const WEATHER_WINTER: Record<Weather, WeatherPreset> = {
  ...WEATHER,
  rain: { coverage: 1.0, soft: 0.5, cirrus: 0.0, sun: 0.06, sky: 0.66, mie: 3.0, overcast: 0.96, fog: 1.3, shadow: 0.0, exposure: 1.3, dark: 0.5, deck: 1, deckDark: 0.26, scud: 0.2, rainFog: 0.0011, darken: 0.03, glow: 0.14 },
  storm: { coverage: 1.0, soft: 0.6, cirrus: 0.0, sun: 0.03, sky: 0.5, mie: 3.6, overcast: 1.0, fog: 2.2, shadow: 0.0, exposure: 1.4, dark: 0.75, deck: 1, deckDark: 0.5, scud: 0.55, rainFog: 0.0034, darken: 0.14, glow: 0.1 },
};

const DEG = Math.PI / 180;

/** Unit vector toward a body at (elevation, azimuth) in degrees. */
export function directionFromAngles(elDeg: number, azDeg: number, out: { x: number; y: number; z: number }): void {
  const el = elDeg * DEG;
  const az = azDeg * DEG;
  out.x = Math.cos(el) * Math.sin(az);
  out.y = Math.sin(el);
  out.z = Math.cos(el) * Math.cos(az);
}
