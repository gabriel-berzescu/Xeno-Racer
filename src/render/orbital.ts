/**
 * The sky of a circuit inside an orbital ring (owner: render): where the sun and the planet are, the look of every hour of the
 * ring's day, and what the solver hands the sky shader (skyShader.ts, XR_ORBITAL) to draw the rest of the ring with.
 *
 * The ring is a band of land on the inside of a cylinder (`OrbitalRing`): its axis lies along world x, east to west, high overhead.
 * It turns about that axis once in five minutes, which is what makes its floor weigh 1 g, and the whole sky turns with it the other
 * way: the sun, the planet and the stars circle the two ends of the axis, which stay where they are, on the horizon due east and due
 * west. One number says where everything is: the phase of the ring's day, in degrees (0 = sunrise, 90 = noon, 180 = sunset, 270 =
 * midnight), and it goes round once in `ORBITAL.daySeconds`.
 *
 *   the sun     35 degrees from the east end of the axis: it rises in the north-east, stands due east at noon, 35 degrees up and no
 *               higher, and sets in the south-east. Half the ring is in its day and half in its night, always: the land that
 *               climbs to the north is some hours ahead or behind, and at midnight the land overhead is at its noon.
 *   Saturn      16 degrees from the west end, nearly opposite the sun (so nearly full): it comes up over the western rim late in
 *               the ring's afternoon, is highest in the small hours and gone by dawn, and it turns about itself as it goes.
 *
 * Out here the sun is a hundredth of the Earth's; the ring's daylight is gathered by a formation of mirrors that flies with it and
 * stands where the sun stands. (That is the story; the light is the game's ordinary sun.)
 *
 * The light on the circuit is the sun's while the circuit sees it. Near the ends of the day the ring's own land stands in front of
 * the sun (it comes in over the far rim), and while the sun is down the light is the ring's: the half of it that is in its day, to
 * the north in the evening, overhead at midnight, to the south before dawn. One directional light does both: it dims to nothing as
 * the sun goes behind the land and comes up again from the other side.
 */
import type { OrbitalRing, TimeOfDay } from '../core/contracts';
import type { RGB } from './atmosphere';
import type { TodPreset } from './presets';

const DEG = Math.PI / 180;

export const ORBITAL = {
  /** Seconds the ring takes to turn once: a day and a night (2 pi sqrt(r / g) for a floor 22.4 km from the axis). */
  daySeconds: 300,
  /** Degrees between the sun and the east end of the axis: the sun's height at noon. */
  sunAxis: 35,
  /** Degrees between the planet and the west end of the axis, and how far its turn is ahead of the sun's. */
  planetAxis: 16,
  planetLead: 210,
  /** The planet's rings are seen from this many degrees above their plane. */
  ringOpening: 20,
  /** The pole is turned this far about the line of sight from where the sunlight would put it (degrees): the rings lie nearly level at midnight. */
  poleTurn: 50,
  /** The air of the ring is clean: the visibility is this many times an ordinary day's. */
  clarity: 3.2,
  /** The sky's light on the ground, against an ordinary sky's: the air is a few kilometres deep, not a whole atmosphere. */
  ambient: 0.8,
  /** The light of the lit side of the ring on the circuit, when the sun is down (the directional light's strength). */
  ringLight: 0.64,
  /** Sunlight on the ring's land, radiance per unit albedo at normal incidence (the day side of the ring, at any hour here). */
  landSun: [1.06, 1.02, 0.95] as RGB,
  /** The light of the sky on the ring's land (day side; a fifth of it on the night side). */
  landAmb: [0.07, 0.085, 0.11] as RGB,
  /** The lights of the towns on the night side (radiance of a bright one). */
  lights: 0.5,
};

/** The phase of the ring's day at each of the game's times of day (degrees): where a race that starts at that hour starts. */
export const ORBITAL_PHASE: Record<TimeOfDay, number> = { dawn: 6.2, morning: 32, noon: 90, golden: 164, dusk: 176.6, night: 270 };

const wrap360 = (p: number): number => ((p % 360) + 360) % 360;

/** Unit direction toward the sun at a phase of the day (world axes: east = -x, up = +y, north = +z). */
export function orbitalSun(phaseDeg: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const a = ORBITAL.sunAxis * DEG;
  const p = phaseDeg * DEG;
  out[0] = -Math.cos(a);
  out[1] = Math.sin(a) * Math.sin(p);
  out[2] = Math.sin(a) * Math.cos(p);
  return out;
}

/** Unit direction toward the planet at a phase of the day. */
export function orbitalPlanet(phaseDeg: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const a = ORBITAL.planetAxis * DEG;
  const p = (phaseDeg + ORBITAL.planetLead) * DEG;
  out[0] = Math.cos(a);
  out[1] = Math.sin(a) * Math.sin(p);
  out[2] = Math.sin(a) * Math.cos(p);
  return out;
}

/**
 * The planet's north pole, as seen from here: across the line of sight and across the sunlight, turned a little about the line of
 * sight, and tipped toward us by the rings' opening (we look at their sunlit face from a little above their plane). It is made from
 * the two directions, so it turns with the sky. Written into `out`.
 */
export function orbitalPole(planet: readonly number[], sun: readonly number[], out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  let ux = planet[1] * sun[2] - planet[2] * sun[1];
  let uy = planet[2] * sun[0] - planet[0] * sun[2];
  let uz = planet[0] * sun[1] - planet[1] * sun[0];
  const l = Math.hypot(ux, uy, uz) || 1;
  ux /= l;
  uy /= l;
  uz /= l;
  const t = ORBITAL.poleTurn * DEG;
  const vx = planet[1] * uz - planet[2] * uy;
  const vy = planet[2] * ux - planet[0] * uz;
  const vz = planet[0] * uy - planet[1] * ux;
  const ct = Math.cos(t);
  const st = Math.sin(t);
  const wx = ux * ct + vx * st;
  const wy = uy * ct + vy * st;
  const wz = uz * ct + vz * st;
  const c = Math.cos(ORBITAL.ringOpening * DEG);
  const s = Math.sin(ORBITAL.ringOpening * DEG);
  out[0] = c * wx - s * planet[0];
  out[1] = c * wy - s * planet[1];
  out[2] = c * wz - s * planet[2];
  return out;
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

/** The world x the circuit's light is worked out for: it lies some 700 m inside the higher rim. */
const circuitX = (ring: OrbitalRing): number => ring.rims[1] - 700;

const _sun: [number, number, number] = [0, 0, 0];

/**
 * Whose light the circuit is in at a phase of the day: +1 the sun's in full, -1 the lit side of the ring's in full, and through 0
 * as the sun goes behind the land or comes out from behind it (the light is at its faintest then, and changes hands).
 */
export function orbitalLight(ring: OrbitalRing, phaseDeg: number): number {
  const sun = orbitalSun(phaseDeg, _sun);
  return 2 * orbitalSunSeen(ring, sun, circuitX(ring), sun[1]) - 1;
}

/** The two phases of the day at which the light changes hands (`orbitalLight` is 0): just after sunrise, just before sunset. */
export function orbitalHandovers(ring: OrbitalRing): [number, number] {
  // (the light is the ring's at a and the sun's at b)
  let a = -20;
  let b = 60;
  for (let i = 0; i < 40; i++) {
    const m = (a + b) / 2;
    if (orbitalLight(ring, m) > 0) b = m;
    else a = m;
  }
  const up = (a + b) / 2;
  return [up, 180 - up];
}

/**
 * Unit direction toward the middle of the lit side of the ring while the sun is down: 54 degrees to the north of the zenith at
 * sunset, overhead at midnight, 54 degrees to the south at sunrise. Written into `out`.
 */
export function orbitalRingLight(phaseDeg: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const psi = wrap360(phaseDeg - 90) - 180; // -90 at sunset, 0 at midnight, +90 at sunrise
  const tilt = Math.max(-58, Math.min(58, -psi * 0.6)) * DEG;
  out[0] = 0;
  out[1] = Math.cos(tilt);
  out[2] = Math.sin(tilt);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The look of an hour
// ─────────────────────────────────────────────────────────────────────────────

/** The numbers of the look that are not geometry: dials, like the presets of the other circuits. `sky` is the sky's radiance scale. */
interface HourLook {
  phase: number;
  sunE: number;
  sky: number;
  exposure: number;
  darkness: number;
  stars: number;
  haze: number;
  hemi: number;
  env: number;
  cloud: number;
  warmth: number;
  planetLum: number;
}

/**
 * The hours the look is set at, round the clock: the game's six times of day, and the two ends of the night between them (the sky
 * is dark a quarter of a minute after sunset and until as long before sunrise: the twilight of a ring is short). Between two of them
 * every number is on the straight line (brightnesses in the log domain).
 */
const HOURS: HourLook[] = [
  { phase: 6.2, sunE: 3.2, sky: 9.6, exposure: 4.2, darkness: 0.22, stars: 0.12, haze: 1.3, hemi: 0.5, env: 1.35, cloud: 0.36, warmth: 0.5, planetLum: 0.2 }, // dawn
  { phase: 32, sunE: 3.5, sky: 9.45, exposure: 1.75, darkness: 0.0, stars: 0.0, haze: 1.1, hemi: 0.4, env: 1.0, cloud: 0.36, warmth: 0.25, planetLum: 0.2 }, // morning
  { phase: 90, sunE: 3.7, sky: 9.62, exposure: 1.4, darkness: 0.0, stars: 0.0, haze: 0.9, hemi: 0.36, env: 1.0, cloud: 0.36, warmth: 0.05, planetLum: 0.25 }, // noon
  { phase: 164, sunE: 3.4, sky: 9.52, exposure: 2.5, darkness: 0.05, stars: 0.06, haze: 1.0, hemi: 0.45, env: 1.4, cloud: 0.36, warmth: 0.45, planetLum: 0.3 }, // golden
  { phase: 176.6, sunE: 3.0, sky: 8.7, exposure: 5.0, darkness: 0.55, stars: 0.5, haze: 1.1, hemi: 0.6, env: 1.3, cloud: 0.3, warmth: 0.25, planetLum: 0.12 }, // dusk
  { phase: 194, sunE: 3.0, sky: 0.5, exposure: 4.6, darkness: 0.92, stars: 0.9, haze: 1.0, hemi: 0.6, env: 1.9, cloud: 0.2, warmth: -0.15, planetLum: 0.1 }, // nightfall
  { phase: 270, sunE: 3.0, sky: 0.145, exposure: 4.4, darkness: 1.0, stars: 1.0, haze: 0.9, hemi: 0.6, env: 2.1, cloud: 0.16, warmth: -0.35, planetLum: 0.1 }, // night
  { phase: 348, sunE: 3.0, sky: 0.5, exposure: 4.6, darkness: 0.9, stars: 0.9, haze: 1.1, hemi: 0.6, env: 1.9, cloud: 0.2, warmth: -0.1, planetLum: 0.1 }, // daybreak
];

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpLog = (a: number, b: number, t: number): number => (a > 0 && b > 0 ? a * Math.pow(b / a, t) : lerp(a, b, t));

function hourLook(phaseDeg: number): HourLook {
  const p = wrap360(phaseDeg);
  const n = HOURS.length;
  let i = n - 1;
  for (let k = 0; k < n; k++) if (HOURS[k].phase <= p) i = k;
  const a = HOURS[i];
  const b = HOURS[(i + 1) % n];
  const span = wrap360(b.phase - a.phase) || 360;
  const t = wrap360(p - a.phase) / span;
  return {
    phase: p,
    sunE: lerp(a.sunE, b.sunE, t),
    sky: lerpLog(a.sky, b.sky, t),
    exposure: lerpLog(a.exposure, b.exposure, t),
    darkness: lerp(a.darkness, b.darkness, t),
    stars: lerp(a.stars, b.stars, t),
    haze: lerp(a.haze, b.haze, t),
    hemi: lerp(a.hemi, b.hemi, t),
    env: lerp(a.env, b.env, t),
    cloud: lerp(a.cloud, b.cloud, t),
    warmth: lerp(a.warmth, b.warmth, t),
    planetLum: lerp(a.planetLum, b.planetLum, t),
  };
}

function angles(d: readonly number[]): { el: number; az: number } {
  return { el: Math.asin(Math.max(-1, Math.min(1, d[1]))) / DEG, az: Math.atan2(d[0], d[2]) / DEG };
}

/**
 * The look of the circuit at a phase of the ring's day, as a preset the solver understands: the light-casting body (the sun, or the
 * lit side of the ring), how strong its light is, and the dials of that hour.
 */
export function orbitalHour(ring: OrbitalRing, phaseDeg: number): TodPreset {
  const h = hourLook(phaseDeg);
  const sun = angles(orbitalSun(h.phase));
  const k = orbitalLight(ring, h.phase);
  const common = {
    skyGain: 1,
    skyScale: h.sky,
    exposure: h.exposure,
    darkness: h.darkness,
    stars: h.stars,
    haze: h.haze,
    hemi: h.hemi,
    env: h.env,
    cloud: h.cloud,
    warmth: h.warmth,
    planetLum: h.planetLum,
    // the sky keeps the colours of the true sun's hour (a few degrees under the horizon and it has none left to give)
    skyElDeg: Math.max(sun.el, -3),
    phaseDeg: h.phase,
  };
  if (k > 0) return { ...common, elDeg: sun.el, azDeg: sun.az, sunE: h.sunE * k, moon: false };
  const body = angles(orbitalRingLight(h.phase));
  // warm from the low sun on the land at the ends of the night, the cool white of a noon far overhead in the middle of it
  const deep = Math.min(1, Math.abs(wrap360(h.phase - 90) - 180) / 90);
  const lightRGB: [number, number, number] = [lerp(0.8, 1.0, deep), lerp(0.88, 0.9, deep), lerp(1.0, 0.76, deep)];
  return { ...common, elDeg: body.el, azDeg: body.az, sunE: ORBITAL.ringLight * -k, moon: true, trueSunElDeg: sun.el, trueSunAzDeg: sun.az, lightRGB };
}

/**
 * The phases a turning day is solved at (degrees, ascending): close together where the look changes fast (the ends of the day),
 * far apart at noon and in the night, with the game's six hours and the two hand-overs of the light among them, so that the day
 * passes through exactly the looks a still hour has.
 */
export function orbitalKeyPhases(ring: OrbitalRing): number[] {
  const [up, down] = orbitalHandovers(ring);
  const list = [0, 2.5, up, 6.2, 8, 11, 16, 23, 32, 48, 68, 90, 112, 132, 150, 158, 164, 168, 171, down, 176.6, 179, 182, 186, 194, 212, 240, 270, 300, 328, 348, 354, 357.5];
  return [...new Set(list.map((p) => Math.round(wrap360(p) * 1000) / 1000))].sort((a, b) => a - b);
}

// ─────────────────────────────────────────────────────────────────────────────
// What the sky shader draws the ring with
// ─────────────────────────────────────────────────────────────────────────────

/** What the sky shader draws the ring with (EnvSolution.orbital). */
export interface OrbitalLook {
  ring: OrbitalRing;
  /** The phase of the ring's day (degrees). */
  phase: number;
  /** cos and sin of it: the stars turn by it. */
  rot: [number, number];
  planet: [number, number, number];
  pole: [number, number, number];
  /** Radiance of the planet's sunlit cloud tops (an artistic level per hour: the eye's, not the light meter's). */
  planetLum: number;
  landSun: RGB;
  landAmb: RGB;
  lights: number;
  /** The light on the white structure of the glass (ambient radiance per unit albedo). */
  structure: RGB;
}

const _planet: [number, number, number] = [0, 0, 0];

/** Put the sky's bodies where they are at a phase of the day (the geometry of the look; the levels are left alone). */
export function orbitalTurn(look: OrbitalLook, phaseDeg: number): OrbitalLook {
  const sun = orbitalSun(phaseDeg, _sun);
  const planet = orbitalPlanet(phaseDeg, _planet);
  look.phase = wrap360(phaseDeg);
  look.rot[0] = Math.cos(phaseDeg * DEG);
  look.rot[1] = Math.sin(phaseDeg * DEG);
  look.planet[0] = planet[0];
  look.planet[1] = planet[1];
  look.planet[2] = planet[2];
  orbitalPole(planet, sun, look.pole);
  return look;
}

export function orbitalLook(ring: OrbitalRing, phaseDeg: number, planetLum: number, skyAmbient: RGB, light: RGB): OrbitalLook {
  return orbitalTurn(
    {
      ring,
      phase: 0,
      rot: [1, 0],
      planet: [1, 0, 0],
      pole: [0, 1, 0],
      planetLum,
      landSun: ORBITAL.landSun,
      landAmb: ORBITAL.landAmb,
      lights: ORBITAL.lights,
      structure: [skyAmbient[0] * 0.5 + light[0] * 0.05, skyAmbient[1] * 0.5 + light[1] * 0.05, skyAmbient[2] * 0.5 + light[2] * 0.05],
    },
    phaseDeg,
  );
}
