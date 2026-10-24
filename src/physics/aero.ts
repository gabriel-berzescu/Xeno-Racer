/**
 * Active aero (`AeroSpec.straightMode`, the Volta's 2026 wings): when the flaps of a car that has them open to straight mode and when
 * they close again. The physics moves the flaps by this rule (src/physics/vehicle.ts) and the AI's speed profile and driver expect it
 * (src/ai/racing-line.ts, src/ai/driver.ts), so the three agree on where a car runs with less drag and less downforce.
 *
 * The flaps open, over STRAIGHT_MODE_OPEN_TIME, while all of this holds:
 *   - the driver is flat out: the throttle pedal at STRAIGHT_MODE_THROTTLE or more, and no brake;
 *   - the car goes forwards, in a forward gear, at STRAIGHT_MODE_SPEED or more, with its wheels on the ground;
 *   - it is hardly cornering: the lateral acceleration it has, and the one its steering asks for, both under STRAIGHT_MODE_LAT. (What the
 *     steering asks for is the road-wheel angle's turn with a road car's understeer, times the speed: v^2 δ / (L + 0.0022 v^2). The bare
 *     v^2 δ / L would count the slip angle the front tyres run at as a turn, and that alone is 1 g at 290 km/h in a bend of 0.3 g. The
 *     stability control's reference takes less of that understeer for a car the downforce presses down; the flaps keep the road car's, and
 *     the lateral acceleration the car has shuts them in a corner either way.)
 * They begin to open once all of it has held for STRAIGHT_MODE_DWELL without a break: a governor pumping the throttle on a wet road (the
 * AI's, every 2-6 frames while the rear tyres spin) or a twitch of the wheel on a straight otherwise has them shutting and opening 10-20
 * times a second.
 * Once open they stay so through a part-lift to STRAIGHT_MODE_LIFT and a bend up to STRAIGHT_MODE_LAT_HOLD, and close, over
 * STRAIGHT_MODE_CLOSE_TIME, as soon as that fails: a lift, the brakes, a turn of the wheel, a corner, a jump. (Without that margin a
 * driver holding a speed at 0.95 of the throttle, or running a bend at 1 g, has them opening and closing many times a second.)
 * Braking and cornering are therefore always done in corner mode, with all of the downforce. (The real rule opens them only inside
 * the activation zones of a circuit, every lap and for every car, and closes them on a lift or the brakes: a circuit here has no zones,
 * so the car's own state decides.)
 */

/** Throttle pedal (0..1) from which the flaps open, and under which open flaps close (a lift). */
export const STRAIGHT_MODE_THROTTLE = 0.95;
export const STRAIGHT_MODE_LIFT = 0.8;
/** Forward speed (m/s) from which the flaps open: 150 km/h. */
export const STRAIGHT_MODE_SPEED = 150 / 3.6;
/**
 * Lateral acceleration (m/s^2), measured or asked for by the steering, under which the flaps open (1 g; the AI's speed profile takes the
 * line's own, v^2 times its curvature), and from which open flaps close (1.25 g).
 */
export const STRAIGHT_MODE_LAT = 9.81;
export const STRAIGHT_MODE_LAT_HOLD = 1.25 * 9.81;
/** Seconds the way to open the flaps must hold, without a break, before they begin to open. */
export const STRAIGHT_MODE_DWELL = 0.25;
/** Seconds the flaps take to open fully (the rule allows 0.4 s for the change), and to close fully. */
export const STRAIGHT_MODE_OPEN_TIME = 0.4;
export const STRAIGHT_MODE_CLOSE_TIME = 0.2;
