/**
 * The physics frame (centred on the centre of mass, +z forward) and the body frame (the middle of the wheelbase, on the ground) agree:
 * the wheels the physics drives sit in the arches the body is drawn with, and the collision box is where the body is. (Before 1.0 the body
 * was put on the wrong side of the centre of mass, and every car's wheels stood out of their arches by twice the gap: 63 cm on the Kestrel.)
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CARS } from '../src/cars';
import { bodyCgZ } from '../src/core/contracts';
import { hullOf } from '../src/core/damage';
import { PhysicsWorld, createFlatTrack } from '../src/physics';

describe('the body frame and the physics frame', () => {
  for (const def of CARS) {
    const v = def.visual;
    it(`${def.name}: the wheels are in the arches`, () => {
      expect(v.cgToFrontAxle).toBe(def.physics.chassis.cgToFrontAxle);
      const world = new PhysicsWorld(createFlatTrack());
      const car = world.addVehicle(def);
      car.placeOnGround(new Vector3(), new Quaternion(), 0);
      world.simulate(0.2);
      const st = car.state;
      // the body origin, where the car visual puts it: the centre of mass less (0, cgHeight, bodyCgZ) in the car's frame
      const origin = new Vector3(0, v.cgHeight, bodyCgZ(v)).applyQuaternion(st.quaternion).negate().add(st.position);
      const qi = st.quaternion.clone().invert();
      st.wheels.forEach((w, i) => {
        const b = w.hub.clone().sub(origin).applyQuaternion(qi);
        expect(b.z).toBeCloseTo(i < 2 ? v.wheelbase / 2 : -v.wheelbase / 2, 2);
        expect(Math.abs(b.x)).toBeCloseTo((i < 2 ? v.trackFront : v.trackRear) / 2, 2);
      });
    });

    it(`${def.name}: the collision box is where the body is`, () => {
      const { hullHalf, hullOffset } = def.physics.chassis;
      const front = v.wheelbase / 2 + v.frontOverhang;
      const rear = -(v.length - v.wheelbase / 2 - v.frontOverhang);
      expect(hullOffset.z + bodyCgZ(v) + hullHalf.z).toBeCloseTo(front, 6);
      expect(hullOffset.z + bodyCgZ(v) - hullHalf.z).toBeCloseTo(rear, 6);
      // (and the damage model maps a hit to the same place on the body)
      expect(hullOf(v).cgZ).toBe(bodyCgZ(v));
    });
  }

  it('puts the centre of mass of a car heavier at the front ahead of the middle', () => {
    expect(bodyCgZ({ wheelbase: 2.62, cgToFrontAxle: 0.996 })).toBeCloseTo(0.314, 6);
    expect(bodyCgZ({ wheelbase: 2.7, cgToFrontAxle: 1.35 })).toBe(0);
  });
});
