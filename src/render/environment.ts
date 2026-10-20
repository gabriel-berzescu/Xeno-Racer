/**
 * Environment solver (owner: render). Pure maths, no three.js: turns (TimeOfDay, Weather) into the
 * numbers the sky shader, light rig, fog and tone mapper consume. Cached per (tod, weather).
 */
import { WEATHER_WATER, type EnvironmentSettings } from '../core/contracts';
import { computeSkyModel, FOG_TABLE_SIZE, type RGB, type SkyModel } from './atmosphere';
import { directionFromAngles, TOD, TOD_WINTER, WEATHER, WEATHER_WINTER, type TodPreset, type WeatherPreset } from './presets';

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
  /** The part of `fogTable` that is the sun's own in-scatter (same scaling): the fog keeps it by the sunlit share of the view ray. */
  fogTableSun: Float32Array;
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
  /** How much of the moon shows (0 by day): the full disc in a clear night, a glow behind the deck in the rain. */
  moonVis: number;
  /** Northern lights, 0..1: a winter circuit's clear night (and a hint at the blue hours), none under cloud. */
  aurora: number;
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
  return `${s.winter ? 'winter/' : ''}${s.timeOfDay}/${s.weather}`;
}

export async function solveEnvironment(settings: EnvironmentSettings, yieldFn?: () => Promise<void>): Promise<EnvSolution> {
  const key = envKey(settings);
  const hit = cache.get(key);
  if (hit) return hit;

  const winter = settings.winter === true;
  const tod = (winter ? TOD_WINTER : TOD)[settings.timeOfDay];
  const weather = (winter ? WEATHER_WINTER : WEATHER)[settings.weather];
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

  // Ground fill (below the horizon / environment lower hemisphere): grey-green albedo under sun + sky; snow gives most of its light back
  const albedo: RGB = winter ? [0.74, 0.8, 0.9] : [0.16, 0.17, 0.13];
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
  const fogTableSun = new Float32Array(FOG_TABLE_SIZE * 3);
  for (let k = 0; k < FOG_TABLE_SIZE; k++) {
    const phi = Math.PI * Math.pow(k / (FOG_TABLE_SIZE - 1), 2);
    const toSun = Math.cos(phi / 2) ** 2;
    const keep = deck > 0 ? Math.min(0.5, weather.glow * 0.4 * lowSun * toSun ** 3) : 0;
    const c = desat([model.fogTable[k * 3], model.fogTable[k * 3 + 1], model.fogTable[k * 3 + 2]], od * (1 - keep));
    fogTable[k * 3] = c[0] * skyScale;
    fogTable[k * 3 + 1] = c[1] * skyScale;
    fogTable[k * 3 + 2] = c[2] * skyScale;
    // (the sun's share of it goes through the very same steps, so that fogTable - fogTableSun is the sky's: never below 0)
    const cs = desat([model.fogTableSun[k * 3], model.fogTableSun[k * 3 + 1], model.fogTableSun[k * 3 + 2]], od * (1 - keep));
    fogTableSun[k * 3] = Math.min(fogTable[k * 3], cs[0] * skyScale);
    fogTableSun[k * 3 + 1] = Math.min(fogTable[k * 3 + 1], cs[1] * skyScale);
    fogTableSun[k * 3 + 2] = Math.min(fogTable[k * 3 + 2], cs[2] * skyScale);
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
      for (let c = 0; c < 3; c++) {
        fogTable[k * 3 + c] *= f;
        fogTableSun[k * 3 + c] *= f;
      }
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
    fogTableSun,
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
    moonVis: tod.moon ? (deck > 0 ? 0.6 : 1 - weather.overcast * 0.85) : 0,
    aurora: winter ? (tod.aurora ?? 0) * (1 - Math.min(1, weather.overcast * 1.1)) : 0,
  };
  cache.set(key, sol);
  return sol;
}

export function clearEnvironmentCache(): void {
  cache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Weather that changes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rain haze for a rain intensity: the presets' own pairs (rain 0.55 -> 0.0007 1/m, storm 1 -> 0.0016), straight lines between.
 * The haze is made by the rain falling, not by the clouds, so in a changing race it follows the rain and not the sky.
 */
export function rainFogFor(rain: number, winter = false): number {
  const r = Math.min(1, Math.max(0, rain));
  const ra = WEATHER_WATER.rain.rain;
  const rb = WEATHER_WATER.storm.rain;
  const table = winter ? WEATHER_WINTER : WEATHER;
  const fa = table.rain.rainFog;
  const fb = table.storm.rainFog;
  return r <= ra ? (fa * r) / ra : fa + ((fb - fa) * (r - ra)) / (rb - ra);
}

/** How far each family of the look has got when the sky is `s` of the way from its dry weather to its wet one. */
export interface SkyCurves {
  /** Direct sun: its light, the disc, the shadows. The clouds shut it out early. */
  sun: number;
  /** Ambient light, haze, fog and exposure: they follow the sky as a whole. */
  amb: number;
  /** The cumulus layer: more of the sky under cloud, thicker, darker, greyer. */
  cloud: number;
  /** How much of the sky the rain deck has closed over (it replaces the cumulus, in patches, and comes last). Its colours follow `amb`. */
  deck: number;
}

const smooth01 = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function skyCurves(s: number, out: SkyCurves = { sun: 0, amb: 0, cloud: 0, deck: 0 }): SkyCurves {
  const x = Math.min(1, Math.max(0, s));
  out.sun = smooth01(0.05, 0.6, x);
  out.amb = x;
  out.cloud = smooth01(0, 0.7, x);
  out.deck = smooth01(0.3, 0.92, x);
  return out;
}

/** A copy of a solution that owns all of its arrays, to be rewritten by `blendInto`. */
export function cloneSolution(a: EnvSolution): EnvSolution {
  const rgb = (c: RGB): RGB => [c[0], c[1], c[2]];
  return {
    ...a,
    settings: { ...a.settings },
    weather: { ...a.weather },
    sunDir: [a.sunDir[0], a.sunDir[1], a.sunDir[2]],
    trueSunDir: [a.trueSunDir[0], a.trueSunDir[1], a.trueSunDir[2]],
    lightColor: rgb(a.lightColor),
    sunRadiance: rgb(a.sunRadiance),
    ground: rgb(a.ground),
    skyAmbient: rgb(a.skyAmbient),
    cloudLight: rgb(a.cloudLight),
    cloudAmbient: rgb(a.cloudAmbient),
    haze: rgb(a.haze),
    hemiSky: rgb(a.hemiSky),
    hemiGround: rgb(a.hemiGround),
    fogTable: new Float32Array(a.fogTable),
    fogTableSun: new Float32Array(a.fogTableSun),
    fogColor: rgb(a.fogColor),
    moonLight: rgb(a.moonLight),
    deckLo: rgb(a.deckLo),
    deckHi: rgb(a.deckHi),
    glow: rgb(a.glow),
  };
}

const _curves: SkyCurves = { sun: 0, amb: 0, cloud: 0, deck: 0 };

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolate in the log domain (a ratio, like an exposure or a visibility, changes by the same factor per step). */
function mixLog(a: number, b: number, t: number): number {
  return a > 0 && b > 0 ? a * Math.pow(b / a, t) : mix(a, b, t);
}

function mixRgb(a: RGB, b: RGB, t: number, out: RGB): void {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

/**
 * The look of a sky `s` of the way from `dry` to `wet` (the same time of day) with `rain` falling, written into `out` (a
 * `cloneSolution`). Everything that is a number or a colour is blended, nothing is solved again: this runs every frame of a
 * race whose weather changes. The families of the look move at their own pace (`skyCurves`): the sun is shut out early, the
 * cumulus thickens, the rain deck comes last. The sky LUT is the dry weather's (the deck takes the sky over from it in the
 * shader); the haze of the rain follows the rain itself.
 */
export function blendInto(out: EnvSolution, dry: EnvSolution, wet: EnvSolution, s: number, rain: number): EnvSolution {
  const c = skyCurves(s, _curves);
  const o = out;
  o.settings.timeOfDay = dry.settings.timeOfDay;
  o.settings.weather = s < 0.5 ? dry.settings.weather : wet.settings.weather;
  o.tod = dry.tod;
  o.model = dry.model;
  const w = o.weather;
  const dw = dry.weather;
  const ww = wet.weather;
  w.coverage = mix(dw.coverage, ww.coverage, c.cloud);
  w.soft = mix(dw.soft, ww.soft, c.cloud);
  w.cirrus = mix(dw.cirrus, ww.cirrus, c.cloud);
  w.sun = mix(dw.sun, ww.sun, c.sun);
  w.sky = mix(dw.sky, ww.sky, c.amb);
  w.mie = mix(dw.mie, ww.mie, c.amb);
  w.overcast = mix(dw.overcast, ww.overcast, c.cloud);
  w.fog = mixLog(dw.fog, ww.fog, c.amb);
  w.shadow = mix(dw.shadow, ww.shadow, c.sun);
  w.exposure = mixLog(dw.exposure, ww.exposure, c.amb);
  w.dark = mix(dw.dark, ww.dark, c.cloud);
  w.deck = c.deck;
  w.deckDark = mix(dw.deckDark, ww.deckDark, c.amb);
  w.scud = mix(dw.scud, ww.scud, c.amb);
  w.rainFog = rainFogFor(rain, dry.settings.winter === true);
  w.darken = mix(dw.darken, ww.darken, c.amb);
  w.glow = mix(dw.glow, ww.glow, c.amb);

  for (let i = 0; i < 3; i++) o.sunDir[i] = dry.sunDir[i];
  for (let i = 0; i < 3; i++) o.trueSunDir[i] = dry.trueSunDir[i];
  o.sunElevation = dry.sunElevation;
  mixRgb(dry.lightColor, wet.lightColor, c.sun, o.lightColor);
  o.lightIntensity = mix(dry.lightIntensity, wet.lightIntensity, c.sun);
  o.skyScale = mix(dry.skyScale, wet.skyScale, c.amb);
  mixRgb(dry.sunRadiance, wet.sunRadiance, c.sun, o.sunRadiance);
  mixRgb(dry.ground, wet.ground, c.amb, o.ground);
  mixRgb(dry.skyAmbient, wet.skyAmbient, c.amb, o.skyAmbient);
  mixRgb(dry.cloudLight, wet.cloudLight, c.sun, o.cloudLight);
  mixRgb(dry.cloudAmbient, wet.cloudAmbient, c.amb, o.cloudAmbient);
  mixRgb(dry.haze, wet.haze, c.amb, o.haze);
  mixRgb(dry.hemiSky, wet.hemiSky, c.amb, o.hemiSky);
  mixRgb(dry.hemiGround, wet.hemiGround, c.amb, o.hemiGround);
  o.fogDensity = mixLog(dry.fogDensity, wet.fogDensity, c.amb);
  const ft = o.fogTable;
  for (let i = 0; i < ft.length; i++) ft[i] = dry.fogTable[i] + (wet.fogTable[i] - dry.fogTable[i]) * c.amb;
  const fs = o.fogTableSun;
  for (let i = 0; i < fs.length; i++) fs[i] = dry.fogTableSun[i] + (wet.fogTableSun[i] - dry.fogTableSun[i]) * c.amb;
  const last = ft.length - 3;
  o.fogColor[0] = ft[last];
  o.fogColor[1] = ft[last + 1];
  o.fogColor[2] = ft[last + 2];
  o.exposure = mixLog(dry.exposure, wet.exposure, c.amb);
  o.darkness = mix(dry.darkness, wet.darkness, c.amb);
  o.envIntensity = dry.envIntensity;
  o.shadowIntensity = mix(dry.shadowIntensity, wet.shadowIntensity, c.sun);
  o.warmth = dry.warmth;
  o.stars = mix(dry.stars, wet.stars, c.cloud);
  mixRgb(dry.moonLight, wet.moonLight, c.amb, o.moonLight);
  o.deck = c.deck;
  o.deckDark = w.deckDark;
  o.scud = w.scud;
  mixRgb(dry.deckLo, wet.deckLo, c.amb, o.deckLo);
  mixRgb(dry.deckHi, wet.deckHi, c.amb, o.deckHi);
  mixRgb(dry.glow, wet.glow, c.amb, o.glow);
  o.rainFog = rainFogFor(rain, dry.settings.winter === true) * (0.8 + 0.2 * dry.tod.haze);
  o.aurora = mix(dry.aurora, wet.aurora, c.cloud);
  o.moonVis = mix(dry.moonVis, wet.moonVis, c.cloud);
  return o;
}
