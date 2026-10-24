/**
 * Tyre compounds per track. Every car races on its own road or slick tyres everywhere but on a winter circuit
 * (`TrackInfo.winter`), where all of them run studded winter tyres. The car is fitted once, before it is built:
 * `fitCar(def, track)` gives back the same car with the tyres of the track (the very same object on a road circuit), and everything
 * downstream (the vehicle, the AI driver's speed profile, the steering filter) reads the tyres from the fitted car.
 *
 * Why a tyre and not only a lower surface grip: a studded tyre does not behave like a summer tyre that is merely slippery.
 *   - The friction does not come from rubber keyed into the road but from the studs digging into the snow and the ice, and from
 *     the shear of the snow itself. Both give way gradually, so the force peaks at a larger slip (10 degrees of slip angle against
 *     6-8, a slip ratio of 0.16 against 0.11) and falls off gently afterwards: the car slides without letting go. That is what makes
 *     sideways driving on ice controllable.
 *   - Friction hardly falls with load (the studs bite as hard on a lightly loaded wheel), so weight transfer matters less.
 *   - A softer, taller carcass answers more lazily (a longer relaxation length).
 *   - The compound works across a very wide range of temperatures, and the tread never gets near a summer tyre's window in air
 *     below freezing.
 * The peak friction itself is the tyre's, the same for every car (about 1.1 on dry asphalt, a winter tyre is no sticky summer tyre),
 * a few per cent better for a narrow tyre than for a wide one (more pressure per area, a deeper bite). The surface then takes it
 * to 0.5 on packed snow and 0.4 on ice (src/physics/surfaces.ts).
 * What the studded tyre keeps of the tyre it replaces, because it is the same size of tyre: the radius, the width and the rolling mass, the
 * thermal size (`heatScale`) and the all-terrain trait (`offroad`). The last one is deliberate: a big block tyre with studs still floats on
 * deep snow, so the Mammoth keeps its edge on the powder beside the road; on packed snow and ice (the road, the lake) the trait does nothing
 * and every car is on the same footing.
 * What it does not keep is the slick trait (`slick`): a racing slick has no tread, and the studded tyre that takes its place has a tread
 * and studs. The slick's rule for loose ground (src/physics/surfaces.ts) is for the dry circuits, so the LMP-X, the Volta and the Dieci (whose
 * grooved tyres carry the trait) at Isvik meet the deep snow beside the road as any road car on studs does.
 */
import type { CarDefinition, TrackRuntime } from '../core/contracts';
import type { TireSpec } from './spec';

const DEG = Math.PI / 180;

/** Peak friction of a studded winter tyre on dry asphalt, before the width correction. */
const WINTER_MU = 1.1;

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/** A studded winter tyre of the size, wheel and rolling mass of `t`. */
export function winterTire(t: TireSpec): TireSpec {
  // (a narrower tyre bites deeper in snow: ±7 % around a 235 mm tyre)
  const narrow = clamp(Math.pow(0.235 / t.width, 0.25), 0.93, 1.07);
  // (a slick's smooth face is not kept: the studded tyre is a tyre with a tread of its own, and the ground beside the road is deep snow)
  const { slick: _slick, ...kept } = t;
  return {
    ...kept,
    mu: WINTER_MU * narrow,
    loadSensitivity: 0.06,
    peakSlipAngle: 10 * DEG,
    peakSlipRatio: 0.16,
    slideRatio: 0.9,
    relaxationLength: t.relaxationLength * 1.2 + 0.05,
    rollingResistance: t.rollingResistance * 1.15,
    optimalTemp: 40,
    tempWindow: 60,
    coldGrip: 0.92,
    // (no water film on a winter circuit: the "wet" grip is the snow's, see SurfaceProps.fresh)
    wetGrip: 1,
  };
}

const fitted = new WeakSet<CarDefinition>();
const cache = new WeakMap<CarDefinition, CarDefinition>();

/** The car with the tyres its track asks for: the car itself on a road circuit, a copy on winter tyres on a winter one. */
export function fitCar(def: CarDefinition, track: { readonly info: { readonly winter?: boolean } }): CarDefinition {
  if (!track.info.winter || fitted.has(def)) return def;
  let car = cache.get(def);
  if (!car) {
    const ph = def.physics;
    car = { ...def, physics: { ...ph, tireFront: winterTire(ph.tireFront), tireRear: winterTire(ph.tireRear) } };
    fitted.add(car);
    cache.set(def, car);
  }
  return car;
}

/** True when the track is a winter circuit (studded tyres, snow for rain, cold air). */
export function isWinter(track: Pick<TrackRuntime, 'info'>): boolean {
  return track.info.winter === true;
}
