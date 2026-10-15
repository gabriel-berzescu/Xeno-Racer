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
  /** 1 under a rain-bearing deck (see WeatherPreset.deck), 0 for the dry skies. */
  deck: number;
  deckDark: number;
  scud: number;
  /** Colours of the deck: pale haze toward the horizon and the thick, darker underside overhead. */
  deckLo: RGB;
  deckHi: RGB;
  /** Warm chroma of a low sun / the moon, added under the deck near the horizon. */
  glow: RGB;
  /** Beer-Lambert rain-haze extinction, 1/m (0 when dry). */
  rainFog: number;
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

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Flash strength (0..1) for `render.lightning()` from the distance of a strike: a strike 2-3 km away is a hard flash,
 * one 10 km away only a faint flicker on the clouds. (The audio's thunder events lie between 2.5 and 10 km.)
 */
export function lightningStrength(distanceKm: number): number {
  const k = 1 - Math.min(1, Math.max(0, ((Number.isFinite(distanceKm) ? distanceKm : 6) - 2) / 9));
  return 0.18 + 0.82 * k * k;
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

  // under a night rain deck there is no moon and no sky glow: far darker than the dry night
  const nightDim = weather.deck > 0 ? 1 - 0.5 * tod.darkness : 1;
  const skyScale = tod.sunE * tod.skyGain * weather.sky * nightDim;
  const od = weather.overcast;

  const sunRadiance: RGB = tod.moon ? [0, 0, 0] : scale(T, 110 * (1 - od));
  const sinEl = Math.max(0, sd.y);
  // A floodlit circuit under a night rain deck is not pitch black: the lamps and the glow of the track fill the
  // ambient (so cars and trackside things keep their shape). The sky itself stays black above.
  const fill = weather.deck > 0 ? 0.0034 * tod.darkness * tod.darkness : 0;
  const skyBase = desat(scale(model.skyMeanCos, skyScale), od);
  const skyCos: RGB = [skyBase[0] + fill, skyBase[1] + fill * 0.86, skyBase[2] + fill * 0.7];
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

  // A low sun still warms the horizon under a rain deck: the fog toward the sun keeps part of its colour.
  const deck = weather.deck;
  const lowSun = tod.moon ? 0 : 1 - smoothstep(0.02, 0.22, el);
  const fogTable = new Float32Array(FOG_TABLE_SIZE * 3);
  for (let k = 0; k < FOG_TABLE_SIZE; k++) {
    const phi = Math.PI * Math.pow(k / (FOG_TABLE_SIZE - 1), 2);
    const toSun = Math.cos(phi / 2) ** 2;
    const keep = deck > 0 ? Math.min(0.5, weather.glow * 0.4 * lowSun * toSun ** 3) : 0;
    const c = desat([model.fogTable[k * 3], model.fogTable[k * 3 + 1], model.fogTable[k * 3 + 2]], od * (1 - keep));
    fogTable[k * 3] = c[0] * skyScale;
    fogTable[k * 3 + 1] = c[1] * skyScale;
    fogTable[k * 3 + 2] = c[2] * skyScale;
  }
  // Under a deck the haze has no sun-side glare: flatten the luminance of the horizon table (the colour toward a
  // low sun survives, its blinding brightness does not).
  let deckLo: RGB = haze;
  if (deck > 0) {
    let mean = 0;
    let n = 0;
    for (let k = 2; k < FOG_TABLE_SIZE; k++) {
      mean += lum([fogTable[k * 3], fogTable[k * 3 + 1], fogTable[k * 3 + 2]]);
      n++;
    }
    mean /= n;
    const flat = 0.9;
    const avg: RGB = [0, 0, 0];
    for (let k = 0; k < FOG_TABLE_SIZE; k++) {
      const l = lum([fogTable[k * 3], fogTable[k * 3 + 1], fogTable[k * 3 + 2]]);
      const f = l > 1e-7 ? 1 + (mean / l - 1) * flat : 1;
      for (let c = 0; c < 3; c++) fogTable[k * 3 + c] *= f;
    }
    for (let k = 2; k < FOG_TABLE_SIZE; k++) for (let c = 0; c < 3; c++) avg[c] += fogTable[k * 3 + c] / (FOG_TABLE_SIZE - 2);
    deckLo = avg;
  }
  const fogColor: RGB = [fogTable[(FOG_TABLE_SIZE - 1) * 3], fogTable[(FOG_TABLE_SIZE - 1) * 3 + 1], fogTable[(FOG_TABLE_SIZE - 1) * 3 + 2]];

  // The thick underside overhead is darker than the horizon haze (much darker in a storm).
  // A night deck is faintly lit from below by the floodlights and the glow of the track.
  if (deck > 0) {
    const pol = 0.0042 * tod.darkness * (1 - 0.35 * weather.deckDark);
    deckLo = [deckLo[0] + pol * 1.0, deckLo[1] + pol * 0.78, deckLo[2] + pol * 0.55];
  }
  // the thick underside is a cool, desaturated grey-blue
  const deckHi = mul(scale(deckLo, 0.58 - 0.36 * weather.deckDark), [0.96, 0.995, 1.05]);
  // chroma of the clear-sky horizon beside the sun, per unit luminance: a faint warm band above the horizon
  const hs = model.horizonSun;
  const hsl = Math.max(lum(hs), 1e-6);
  const glowK = deck > 0 ? weather.glow * 0.5 * lowSun * lum(deckLo) : 0;
  const glow: RGB = [((hs[0] - hsl) / hsl) * glowK, ((hs[1] - hsl) / hsl) * glowK, ((hs[2] - hsl) / hsl) * glowK];

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
    // the exposure compensation of a dim rainy day does not apply once the lights are on
    exposure: tod.exposure * (weather.deck > 0 ? (1 + (weather.exposure - 1) * (1 - tod.darkness)) * (1 - 0.22 * lowSun * (1 - tod.darkness)) : weather.exposure),
    // a storm brings the lamps and headlights on even at noon
    darkness: Math.min(1, tod.darkness + weather.darken * (1 - tod.darkness)),
    envIntensity: tod.env,
    shadowIntensity: weather.shadow,
    warmth: tod.warmth,
    stars: deck > 0 ? 0 : tod.stars * (1 - od),
    moonLight,
    deck,
    deckDark: weather.deckDark,
    scud: weather.scud,
    deckLo,
    deckHi,
    glow,
    rainFog: weather.rainFog * (0.8 + 0.2 * tod.haze),
  };
  cache.set(key, sol);
  return sol;
}

export function clearEnvironmentCache(): void {
  cache.clear();
}
