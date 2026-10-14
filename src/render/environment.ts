/**
 * Environment solver (owner: render). Pure maths, no three.js: turns (TimeOfDay, Weather) into the
 * numbers the sky shader, light rig, fog and tone mapper consume. Cached per (tod, weather).
 */
import type { EnvironmentSettings } from '../core/contracts';
import { computeSkyModel, FOG_TABLE_SIZE, type RGB, type SkyModel } from './atmosphere';
import { directionFromAngles, TOD, WEATHER, type TodPreset, type WeatherPreset } from './presets';

const DEG = Math.PI / 180;

export interface EnvSolution {
  settings: EnvironmentSettings;
  tod: TodPreset;
  weather: WeatherPreset;
  model: SkyModel;
  /** Unit direction toward the light-casting body (sun, or moon at night). */
  sunDir: [number, number, number];
  /** Unit direction toward the true sun (differs from sunDir only at night). */
  trueSunDir: [number, number, number];
  sunElevation: number;
  /** Directional light. */
  lightColor: RGB;
  lightIntensity: number;
  /** Multiplier of LUT radiance -> scene radiance. */
  skyScale: number;
  /** Sun disc HDR radiance (colour included). */
  sunRadiance: RGB;
  ground: RGB;
  /** Radiance an up-facing white surface sees from the sky (scene units). */
  skyAmbient: RGB;
  cloudLight: RGB;
  cloudAmbient: RGB;
  haze: RGB;
  hemiSky: RGB;
  hemiGround: RGB;
  fogDensity: number;
  /** Horizon table scaled to scene radiance, already overcast-desaturated. */
  fogTable: Float32Array;
  fogColor: RGB;
  exposure: number;
  darkness: number;
  /** Image-based light multiplier. */
  envIntensity: number;
  shadowIntensity: number;
  warmth: number;
  stars: number;
  moonLight: RGB;
}

const cache = new Map<string, EnvSolution>();

function lum(c: RGB): number {
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}

function desat(c: RGB, amount: number): RGB {
  const l = lum(c);
  return [c[0] + (l - c[0]) * amount, c[1] + (l - c[1]) * amount, c[2] + (l - c[2]) * amount];
}

function scale(c: RGB, s: number): RGB {
  return [c[0] * s, c[1] * s, c[2] * s];
}

function mul(a: RGB, b: RGB): RGB {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}

export function envKey(s: EnvironmentSettings): string {
  return `${s.timeOfDay}/${s.weather}`;
}

export async function solveEnvironment(settings: EnvironmentSettings, yieldFn?: () => Promise<void>): Promise<EnvSolution> {
  const key = envKey(settings);
  const hit = cache.get(key);
  if (hit) return hit;

  const tod = TOD[settings.timeOfDay];
  const weather = WEATHER[settings.weather];
  const el = tod.elDeg * DEG;

  const model = await computeSkyModel({ sunElevation: el, mieScale: weather.mie * (tod.haze > 1.2 ? 1.25 : 1) }, yieldFn);

  const sd = { x: 0, y: 0, z: 0 };
  directionFromAngles(tod.elDeg, tod.azDeg, sd);
  const ts = { x: 0, y: 0, z: 0 };
  if (tod.moon) directionFromAngles(tod.trueSunElDeg ?? -25, tod.trueSunAzDeg ?? 0, ts);
  else ts.x = sd.x, ts.y = sd.y, ts.z = sd.z;

  // Directional light: sunlight attenuated by the atmosphere; at night a cool moonlight.
  let T = model.sunTransmittance;
  const tMax = Math.max(T[0], T[1], T[2]);
  let lightColor: RGB;
  let lightIntensity: number;
  let moonLight: RGB = [0, 0, 0];
  if (tod.moon) {
    lightColor = [0.58, 0.7, 1.0];
    lightIntensity = tod.sunE * weather.sun;
    moonLight = [0.85, 0.9, 1.0];
    T = [1, 1, 1];
  } else if (tMax > 1e-4) {
    lightColor = [T[0] / tMax, T[1] / tMax, T[2] / tMax];
    lightIntensity = tod.sunE * tMax * weather.sun;
  } else {
    lightColor = [1, 0.25, 0.08];
    lightIntensity = 0;
  }

  const skyScale = tod.sunE * tod.skyGain * weather.sky;
  const od = weather.overcast;

  const sunRadiance: RGB = tod.moon ? [0, 0, 0] : scale(T, 110 * (1 - od));
  const sinEl = Math.max(0, sd.y);
  const skyCos = desat(scale(model.skyMeanCos, skyScale), od);
  const lightVec = scale(mul(lightColor, [1, 1, 1]), lightIntensity);

  // Ground fill (below the horizon / environment lower hemisphere): grey-green albedo under sun + sky.
  const albedo: RGB = [0.16, 0.17, 0.13];
  const ground: RGB = [
    albedo[0] * (skyCos[0] + (lightVec[0] * sinEl) / Math.PI),
    albedo[1] * (skyCos[1] + (lightVec[1] * sinEl) / Math.PI),
    albedo[2] * (skyCos[2] + (lightVec[2] * sinEl) / Math.PI),
  ];

  const cloudLight = scale(lightVec, tod.cloud);
  const cloudAmbient = desat(scale(model.skyMeanCos, skyScale * 1.5), od * 0.5);
  const haze = desat(scale(model.horizonSide, skyScale), od);

  const hemiSky = scale(skyCos, Math.PI * tod.hemi * 0.45);
  const hemiGround = scale(ground, Math.PI * tod.hemi * 0.45);

  // Visibility -> exp2 fog density.
  const visibility = 9000 / (tod.haze * weather.fog);
  const fogDensity = 2 / visibility;

  const fogTable = new Float32Array(FOG_TABLE_SIZE * 3);
  for (let k = 0; k < FOG_TABLE_SIZE; k++) {
    const c = desat([model.fogTable[k * 3], model.fogTable[k * 3 + 1], model.fogTable[k * 3 + 2]], od);
    fogTable[k * 3] = c[0] * skyScale;
    fogTable[k * 3 + 1] = c[1] * skyScale;
    fogTable[k * 3 + 2] = c[2] * skyScale;
  }
  const fogColor: RGB = [fogTable[(FOG_TABLE_SIZE - 1) * 3], fogTable[(FOG_TABLE_SIZE - 1) * 3 + 1], fogTable[(FOG_TABLE_SIZE - 1) * 3 + 2]];

  const sol: EnvSolution = {
    settings: { ...settings },
    tod,
    weather,
    model,
    sunDir: [sd.x, sd.y, sd.z],
    trueSunDir: [ts.x, ts.y, ts.z],
    sunElevation: el,
    lightColor,
    lightIntensity,
    skyScale,
    sunRadiance,
    ground,
    skyAmbient: skyCos,
    cloudLight,
    cloudAmbient,
    haze,
    hemiSky,
    hemiGround,
    fogDensity,
    fogTable,
    fogColor,
    exposure: tod.exposure * weather.exposure,
    darkness: tod.darkness,
    envIntensity: tod.env,
    shadowIntensity: weather.shadow,
    warmth: tod.warmth,
    stars: tod.stars * (1 - od),
    moonLight,
  };
  cache.set(key, sol);
  return sol;
}

export function clearEnvironmentCache(): void {
  cache.clear();
}
