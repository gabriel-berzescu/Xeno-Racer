/**
 * Active aero (`AeroSpec.straightMode`, the Volta's 2026 wings): when the flaps of a car that has them open to straight mode and when
 * they close again. The physics moves the flaps by this rule (src/physics/vehicle.ts) and the AI's speed profile and driver expect it
 * (src/ai/racing-line.ts, src/ai/driver.ts), so the three agree on where a car runs with less drag and less downforce.
 *
 * The flaps open, over STRAIGHT_MODE_OPEN_TIME, while all of this holds:
 *   - the driver is flat out: the throttle pedal at STRAIGHT_MODE_THROTTLE or more, and no brake;
 *   - the car goes forwards, in a forward gear, at STRAIGHT_MODE_SPEED or more, with its wheels on the ground;
 *   - it is hardly cornering: the lateral acceleration it has, and the one its steering asks for (speed squared times the road-wheel
 *     angle over the wheelbase), both under STRAIGHT_MODE_LAT.
 * They close, over STRAIGHT_MODE_CLOSE_TIME, as soon as any of it fails: a lift, the brakes, a turn of the wheel, a corner, a jump.
 * Braking and cornering are therefore always done in corner mode, with all of the downforce. (The real rule opens them only inside
 * the activation zones of a circuit, every lap and for every car, and closes them on a lift or the brakes: a circuit here has no zones,
 * so the car's own state decides.)
 */

/** Throttle pedal (0..1) from which the flaps open. */
export const STRAIGHT_MODE_THROTTLE = 0.95;
/** Forward speed (m/s) from which the flaps open: 150 km/h. */
export const STRAIGHT_MODE_SPEED = 150 / 3.6;
/** Lateral acceleration (m/s^2), measured or asked for by the steering, under which the flaps open: 1 g. */
export const STRAIGHT_MODE_LAT = 9.81;
/** Seconds the flaps take to open fully (the rule allows 0.4 s for the change), and to close fully. */
export const STRAIGHT_MODE_OPEN_TIME = 0.4;
export const STRAIGHT_MODE_CLOSE_TIME = 0.2;
