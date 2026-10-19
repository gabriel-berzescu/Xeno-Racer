/**
 * Turns a raw stick position into a steering command the way a skilled driver's hands would:
 * rate-limited (a thumb is faster than a steering rack) and, at speed, scaled so full stick
 * asks for roughly the front tires' peak slip angle instead of full lock — the same idea as the
 * "normal" steering in console sims. Counter-steer help lives in the vehicle (assists.steeringAssist).
 */
import { Vector3 } from 'three';
import type { CarDefinition, ControlSettings, SurfaceType, VehicleState } from '../core/contracts';
import { tireSurfaces } from './surfaces';

const winterSurface = (s: SurfaceType): boolean => s === 'snow' || s === 'ice' || s === 'deepsnow';

const _left = new Vector3();

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
    // the grip of the snow or the ice under the front wheels (half that of asphalt on packed snow, and the angle the tyres can use falls with it)
    const wf = state.wheels[0];
    const wg = state.wheels[1];
    const surfaces = tireSurfaces(tf);
    const ground = wf.contact && wg.contact && winterSurface(wf.surface) && winterSurface(wg.surface) ? 0.5 * (surfaces[wf.surface].grip + surfaces[wg.surface].grip) : 1;
    // road-wheel angle that saturates the front tires at this speed: kinematic + peak slip
    const gripAngle = (ch.wheelbase * tf.mu * ground * 9.81) / Math.max(v * v, 1) + tf.peakSlipAngle * 1.35;
    const limit = Math.min(1, gripAngle / ch.maxSteer);
    let scale = 1 + (limit - 1) * controls.speedSensitivity;
    // never limit counter-steer: when the car slides, the stick may ask for as much angle as the
    // slide needs (body slip + a margin) in the direction that catches it
    const fwd = state.forwardSpeed;
    if (fwd > 3) {
      _left.set(1, 0, 0).applyQuaternion(state.quaternion);
      const beta = Math.atan2(state.velocity.dot(_left), fwd); // + = travelling left of the nose
      const counter = (raw < 0 && beta > 0) || (raw > 0 && beta < 0);
      if (counter) scale = Math.min(1, scale + (Math.abs(beta) * 1.4) / ch.maxSteer);
    }
    const target = Math.max(-1, Math.min(1, raw)) * scale;
    let rate = controls.steerSpeed * (5.0 - 2.6 * smoothstep(0, 45, v));
    if (Math.abs(target) < Math.abs(this.cur) || Math.sign(target) !== Math.sign(this.cur)) rate *= 1.7;
    const step = rate * dt;
    this.cur += Math.max(-step, Math.min(step, target - this.cur));
    return this.cur;
  }
}
