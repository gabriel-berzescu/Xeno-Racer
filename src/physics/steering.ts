/**
 * Turns a raw stick position into a steering command the way a skilled driver's hands would:
 * rate-limited (a thumb is faster than a steering rack) and, at speed, scaled so full stick
 * asks for roughly the front tires' peak slip angle instead of full lock — the same idea as the
 * "normal" steering in console sims. Counter-steer help lives in the vehicle (assists.steeringAssist).
 */
import type { CarDefinition, ControlSettings, VehicleState } from '../core/contracts';

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class SteeringFilter {
  private cur = 0;

  reset(): void {
    this.cur = 0;
  }

  update(raw: number, dt: number, state: VehicleState, def: CarDefinition, controls: ControlSettings): number {
    const ch = def.physics.chassis;
    const tf = def.physics.tireFront;
    const v = Math.abs(state.forwardSpeed);
    // road-wheel angle that saturates the front tires at this speed: kinematic + peak slip
    const gripAngle = (ch.wheelbase * tf.mu * 9.81) / Math.max(v * v, 1) + tf.peakSlipAngle * 1.35;
    const limit = Math.min(1, gripAngle / ch.maxSteer);
    const scale = 1 + (limit - 1) * controls.speedSensitivity;
    const target = Math.max(-1, Math.min(1, raw)) * scale;
    let rate = controls.steerSpeed * (5.0 - 2.6 * smoothstep(0, 45, v));
    if (Math.abs(target) < Math.abs(this.cur) || Math.sign(target) !== Math.sign(this.cur)) rate *= 1.7;
    const step = rate * dt;
    this.cur += Math.max(-step, Math.min(step, target - this.cur));
    return this.cur;
  }
}
