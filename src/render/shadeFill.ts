/**
 * What the render system does with the sun visibility map besides what the shaders do (owner: render). Pure maths, no three.js.
 *
 * 1. The shade fill. With the sun behind a ridge, the light of a circuit is the sky's alone, and that is dimmer and bluer than the sky and
 *    the sun together that the exposure and the grade of the look were set for. A real eye opens up, and the shade is lit by the glow of the
 *    sky above the ridge and by the sunlit slopes around, in warm colours toward the sun and the sky's blue elsewhere. So a hemisphere light
 *    (diffuse only: no glints) gives back a share of the sun that the terrain takes: its axis points at the sun, a little up; the side that
 *    faces the glow is the colour of the horizon's glow there (a little toward the sun's own), the side that turns from it the same hue,
 *    fainter. `shadeFillLook` makes its colours for a look; the render system scales it by the shade the car is in and by how much the camera
 *    looks toward the sun (`fillViewScale`).
 * 2. The cascades are not drawn while everything they cover is in the terrain's shade (`coveredByShade`).
 */

export type Rgb = readonly [number, number, number];

export interface ShadeFillInput {
  /** The sun's colour (normalised by its brightest channel) and intensity: the light of the look. */
  lightColor: Rgb;
  lightIntensity: number;
  /** The colour of the haze toward the sun at the horizon (the first entry of the fog table): the glow that lights the shade from the side. */
  glow: Rgb;
  /** Unit vector toward the sun. */
  sunDir: Rgb;
  /** The share of the sun a surface loses in the shade that is given back (RenderSystem.fillGain). */
  gain: number;
}

export interface ShadeFillLook {
  /** Irradiance (three's hemisphere light colours) toward the sun and away from it, at full shade. */
  sky: [number, number, number];
  ground: [number, number, number];
  /** The hemisphere's axis: toward the sun, tilted up (not unit: its length is irrelevant). */
  axis: [number, number, number];
}

/**
 * How much of the sun's light the surfaces of a racing picture catch, as a share of the light itself: the ground (the road, the verges, most of
 * what is on screen) catches sin(elevation) of it, and what stands on it (cars, trees, barriers) at every angle about a quarter. A sun a few
 * degrees up has hardly lit the ground even when it shone, so there is hardly anything to give back; a sun at 8 degrees a little.
 */
export function sunSlant(sinElevation: number): number {
  const s = 0.12 + 0.9 * Math.max(0, sinElevation);
  return s > 0.5 ? 0.5 : s;
}
/** How the fill is spread over the hemisphere's two sides: their mean over the sphere is the whole of it. */
export const FILL_SUN_SIDE = 1.6;
export const FILL_AWAY_SIDE = 0.4;

/**
 * The share of the fill that a camera looking away from the sun gets (the whole of it for one looking at the sun).
 *
 * Looking toward the hidden sun a driver sees the glow above the ridge and, against it, everything that turns its back on the sun: the
 * road, the trees, the car, in the sky's light alone, dark and cold beside a sky that blazes (it is what makes the shade "murky"): that
 * is where the picture needs the fill, as a photographer needs one for a backlit subject. Looking the other way, the same surfaces face
 * the glow, the sun side of the fill lights them, and the picture needs a good deal less: with all of the fill there the grass of a
 * shaded straight is brighter than the sun ever made it (a surface cannot be brighter in the shade than in the sun) and the shade
 * stops reading as shade.
 */
export const FILL_AWAY_VIEW = 0.45;

/**
 * How much of the fill the camera needs: 1 looking at the sun, FILL_AWAY_VIEW looking away from it, smooth in between (by the cosine of
 * the angle between the two horizontal directions, from -0.5 to 0.5). A camera pointing straight up or down has no side to look to: the
 * middle.
 */
export function fillViewScale(forwardX: number, forwardZ: number, sunX: number, sunZ: number): number {
  const fl = Math.hypot(forwardX, forwardZ);
  const sl = Math.hypot(sunX, sunZ);
  if (fl < 1e-3 || sl < 1e-3) return (1 + FILL_AWAY_VIEW) / 2;
  const c = (forwardX * sunX + forwardZ * sunZ) / (fl * sl);
  const t = Math.min(1, Math.max(0, c + 0.5));
  return FILL_AWAY_VIEW + (1 - FILL_AWAY_VIEW) * (t * t * (3 - 2 * t));
}
/** How far the glow's colour is taken toward the sun's own, and how far toward grey. */
const SUN_TINT = 0.35;
const GREY_TINT = 0.25;

const lum = (c: Rgb): number => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;

/** The mean outgoing luminance of a white diffuse surface that the fill gives at full shade (what it gives back of the sun's). */
export function shadeFillLook(i: ShadeFillInput): ShadeFillLook {
  const lost = (lum(i.lightColor) * i.lightIntensity * sunSlant(i.sunDir[1])) / Math.PI;
  const lg = Math.max(lum(i.glow), 1e-6);
  const ls = Math.max(lum(i.lightColor), 1e-6);
  const t: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const mixed = (i.glow[c] / lg) * (1 - SUN_TINT) + (i.lightColor[c] / ls) * SUN_TINT;
    // (a quarter of the way to grey: the glow of a dusk is a deep red, and its light on a road is not)
    t[c] = mixed * (1 - GREY_TINT) + GREY_TINT;
  }
  const lt = Math.max(lum(t), 1e-6);
  const e = Math.max(0, i.gain) * lost * Math.PI;
  const hl = Math.hypot(i.sunDir[0], i.sunDir[2]);
  const dx = hl > 1e-5 ? i.sunDir[0] / hl : 1;
  const dz = hl > 1e-5 ? i.sunDir[2] / hl : 0;
  return {
    sky: [(t[0] / lt) * FILL_SUN_SIDE * e, (t[1] / lt) * FILL_SUN_SIDE * e, (t[2] / lt) * FILL_SUN_SIDE * e],
    ground: [(t[0] / lt) * FILL_AWAY_SIDE * e, (t[1] / lt) * FILL_AWAY_SIDE * e, (t[2] / lt) * FILL_AWAY_SIDE * e],
    axis: [dx * 0.98, 0.2, dz * 0.98],
  };
}

/**
 * Is everything the sun's cascades cover out of the sun's reach because the terrain hides it? `vis(x, y, z)` is the share of the sun's disc
 * a point sees (the map's, weather included). Asked at `top` (the height of the tallest caster, with room for the ground to be higher out
 * there) over the focus and on a ring of `reach` around it in 8 directions: nothing above `threshold` anywhere. Then the cascades have
 * nothing to shade and are not drawn (every lit shader scales the sun by the same share and skips the cascade taps where it is nil).
 */
export function coveredByShade(vis: (x: number, y: number, z: number) => number, fx: number, top: number, fz: number, reach: number, threshold = 0.01): boolean {
  if (vis(fx, top, fz) > threshold) return false;
  for (let k = 0; k < 8; k++) {
    const a = k * (Math.PI / 4);
    if (vis(fx + Math.cos(a) * reach, top, fz + Math.sin(a) * reach) > threshold) return false;
  }
  return true;
}
