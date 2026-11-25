/**
 * The sky of a circuit inside an orbital ring (owner: render): where the sun and the planet are, the six times of day, and what the
 * solver hands the sky shader (skyShader.ts, XR_ORBITAL) to draw the rest of the ring with.
 *
 * The ring is a band of land on the inside of a cylinder (`OrbitalRing`): its axis lies along world x, east to west, high overhead.
 * It turns about that axis once in five minutes, and the whole sky turns with it the other way: the sun, the planet and the stars
 * circle the two ends of the axis, which stay where they are, on the horizon due east and due west. One number says where
 * everything is: the phase of the ring's day, in degrees (0 = sunrise, 90 = noon, 180 = sunset, 270 = midnight).
 *
 *   the sun     35 degrees from the east end of the axis: it rises in the north-east, stands due east at noon, 35 degrees up and no
 *               higher, and sets in the south-east. Half the ring is in its day and half in its night, always: the land that
 *               climbs to the north is some hours ahead or behind, and at midnight the land overhead is at its noon.
 *   Saturn      16 degrees from the west end, nearly opposite the sun (so nearly full): it comes up over the western rim late in
 *               the ring's afternoon, is highest in the small hours and gone by dawn.
 *
 * Out here the sun is a hundredth of the Earth's; the ring's daylight is gathered by a formation of mirrors that flies with it and
 * stands where the sun stands. (That is the story; the light is the game's ordinary sun.)
 */
import type { OrbitalRing, TimeOfDay } from '../core/contracts';
import type { RGB } from './atmosphere';
import type { TodPreset } from './presets';

const DEG = Math.PI / 180;

export const ORBITAL = {
  /** Degrees between the sun and the east end of the axis: the sun's height at noon. */
  sunAxis: 35,
  /** Degrees between the planet and the west end of the axis, and how far its turn is ahead of the sun's. */
  planetAxis: 16,
  planetLead: 210,
  /** The planet's rings are seen from this many degrees above their plane. */
  ringOpening: 20,
  /** The pole is turned this far about the line of sight from where the sunlight would put it (degrees). */
  poleTurn: 50,
  /** The air of the ring is clean: the visibility is this many times an ordinary day's. */
  clarity: 3.2,
  /** The sky's light on the ground, against an ordinary sky's: the air is a few kilometres deep, not a whole atmosphere. */
  ambient: 0.8,
  /** Sunlight on the ring's land, radiance per unit albedo at normal incidence (the day side of the ring, at any hour here). */
  landSun: [1.06, 1.02, 0.95] as RGB,
  /** The light of the sky on the ring's land (day side; a fifth of it on the night side). */
  landAmb: [0.07, 0.085, 0.11] as RGB,
  /** The lights of the towns on the night side (radiance of a bright one). */
  lights: 0.5,
};

/** The phase of the ring's day at each of the game's times of day (degrees). */
export const ORBITAL_PHASE: Record<TimeOfDay, number> = { dawn: 6.2, morning: 32, noon: 90, golden: 164, dusk: 176.6, night: 270 };

/** Unit direction toward the sun at a phase of the day (world axes: east = -x, up = +y, north = +z). */
export function orbitalSun(phaseDeg: number): [number, number, number] {
  const a = ORBITAL.sunAxis * DEG;
  const p = phaseDeg * DEG;
  return [-Math.cos(a), Math.sin(a) * Math.sin(p), Math.sin(a) * Math.cos(p)];
}

/** Unit direction toward the planet at a phase of the day. */
export function orbitalPlanet(phaseDeg: number): [number, number, number] {
  const a = ORBITAL.planetAxis * DEG;
  const p = (phaseDeg + ORBITAL.planetLead) * DEG;
  return [Math.cos(a), Math.sin(a) * Math.sin(p), Math.sin(a) * Math.cos(p)];
}

/**
 * The planet's north pole, as seen from here: across the line of sight and across the sunlight, tipped toward us by the rings'
 * opening (we look at their sunlit face from a little above their plane). It is made from the two directions, so it turns with the sky.
 */
export function orbitalPole(planet: readonly number[], sun: readonly number[]): [number, number, number] {
  let ux = planet[1] * sun[2] - planet[2] * sun[1];
  let uy = planet[2] * sun[0] - planet[0] * sun[2];
  let uz = planet[0] * sun[1] - planet[1] * sun[0];
  const l = Math.hypot(ux, uy, uz) || 1;
  ux /= l;
  uy /= l;
  uz /= l;
  // (turned about the line of sight: the pole stands some way off the upright at midnight, when the planet is highest)
  const t = ORBITAL.poleTurn * DEG;
  const vx = planet[1] * uz - planet[2] * uy;
  const vy = planet[2] * ux - planet[0] * uz;
  const vz = planet[0] * uy - planet[1] * ux;
  ux = ux * Math.cos(t) + vx * Math.sin(t);
  uy = uy * Math.cos(t) + vy * Math.sin(t);
  uz = uz * Math.cos(t) + vz * Math.sin(t);
  const c = Math.cos(ORBITAL.ringOpening * DEG);
  const s = Math.sin(ORBITAL.ringOpening * DEG);
  return [c * ux - s * planet[0], c * uy - s * planet[1], c * uz - s * planet[2]];
}

/**
 * How much of the sun's disc a place on the floor sees (0..1): the sun comes in over the rim on its side of the ring, and near the
 * ends of the day the land that climbs toward it is in the way. `x` is the place's world x, `sinEl` the sine of the sun's elevation there.
 */
export function orbitalSunSeen(ring: OrbitalRing, sun: readonly number[], x: number, sinEl: number): number {
  const toRim = sun[0] < 0 ? x - ring.rims[0] : ring.rims[1] - x;
  const thr = (toRim * (1 - sun[0] * sun[0])) / (Math.max(Math.abs(sun[0]), 0.05) * 2 * ring.radius);
  const t = Math.min(1, Math.max(0, (sinEl - thr) / 0.02));
  return t * t * (3 - 2 * t);
}

function angles(d: readonly number[]): { el: number; az: number } {
  return { el: Math.asin(Math.max(-1, Math.min(1, d[1]))) / DEG, az: Math.atan2(d[0], d[2]) / DEG };
}

function preset(tod: TimeOfDay, o: Omit<TodPreset, 'elDeg' | 'azDeg' | 'moon'> & { body?: { elDeg: number; azDeg: number } }): TodPreset {
  const sun = angles(orbitalSun(ORBITAL_PHASE[tod]));
  const { body, ...rest } = o;
  return body
    ? { ...rest, elDeg: body.elDeg, azDeg: body.azDeg, moon: true, trueSunElDeg: sun.el, trueSunAzDeg: sun.az }
    : { ...rest, elDeg: sun.el, azDeg: sun.az, moon: false };
}

/**
 * The six times of day inside the ring. By day the light is the sun's, low in the east. At dusk the sun has just gone behind the land
 * that climbs to the south, and at night it is under the floor: the light then comes from the ring itself, the half of it that is in
 * its day (to the north at dusk, overhead at night), and the sky is as dark as space is.
 */
export const TOD_ORBITAL: Record<TimeOfDay, TodPreset> = {
  dawn: preset('dawn', { sunE: 3.2, skyGain: 3.0, exposure: 4.2, darkness: 0.22, stars: 0.12, haze: 1.3, hemi: 0.5, env: 1.35, cloud: 0.36, warmth: 0.5, planetLum: 0.2 }),
  morning: preset('morning', { sunE: 3.5, skyGain: 2.7, exposure: 1.75, darkness: 0.0, stars: 0.0, haze: 1.1, hemi: 0.4, env: 1.0, cloud: 0.36, warmth: 0.25, planetLum: 0.2 }),
  noon: preset('noon', { sunE: 3.7, skyGain: 2.6, exposure: 1.4, darkness: 0.0, stars: 0.0, haze: 0.9, hemi: 0.36, env: 1.0, cloud: 0.36, warmth: 0.05, planetLum: 0.25 }),
  golden: preset('golden', { sunE: 3.4, skyGain: 2.8, exposure: 2.5, darkness: 0.05, stars: 0.06, haze: 1.0, hemi: 0.45, env: 1.4, cloud: 0.36, warmth: 0.45, planetLum: 0.3 }),
  dusk: preset('dusk', {
    sunE: 0.62, skyGain: 14, exposure: 5.0, darkness: 0.55, stars: 0.5, haze: 1.1, hemi: 0.6, env: 1.3, cloud: 0.3, warmth: 0.25, planetLum: 0.12,
    body: { elDeg: 36, azDeg: 8 }, skyElDeg: 2.0, lightRGB: [1.0, 0.9, 0.76],
  }),
  night: preset('night', {
    sunE: 0.66, skyGain: 0.22, exposure: 4.4, darkness: 1.0, stars: 1.0, haze: 0.9, hemi: 0.6, env: 2.1, cloud: 0.16, warmth: -0.35, planetLum: 0.1,
    body: { elDeg: 78, azDeg: 0 }, skyElDeg: 30, lightRGB: [0.8, 0.88, 1.0],
  }),
};

/** What the sky shader draws the ring with (EnvSolution.orbital). */
export interface OrbitalLook {
  ring: OrbitalRing;
  /** cos and sin of the phase of the day: the stars turn by it. */
  rot: [number, number];
  planet: [number, number, number];
  pole: [number, number, number];
  /** Radiance of the planet's sunlit cloud tops (an artistic level per time of day: the eye's, not the light meter's). */
  planetLum: number;
  landSun: RGB;
  landAmb: RGB;
  lights: number;
  /** The light on the white structure of the glass (ambient radiance per unit albedo). */
  structure: RGB;
}

export function orbitalLook(ring: OrbitalRing, tod: TimeOfDay, preset: TodPreset, skyAmbient: RGB, light: RGB): OrbitalLook {
  const phase = ORBITAL_PHASE[tod];
  const sun = orbitalSun(phase);
  const planet = orbitalPlanet(phase);
  return {
    ring,
    rot: [Math.cos(phase * DEG), Math.sin(phase * DEG)],
    planet,
    pole: orbitalPole(planet, sun),
    planetLum: preset.planetLum ?? 0.1,
    landSun: ORBITAL.landSun,
    landAmb: ORBITAL.landAmb,
    lights: ORBITAL.lights,
    structure: [skyAmbient[0] * 0.5 + light[0] * 0.05, skyAmbient[1] * 0.5 + light[1] * 0.05, skyAmbient[2] * 0.5 + light[2] * 0.05],
  };
}
