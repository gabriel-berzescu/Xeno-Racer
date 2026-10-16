/**
 * Mechanical damage (Settings: Damage, Full): how a crash is turned into bent suspension, lost downforce and a tired engine
 * (src/core/mechanical.ts), what that does to the physics, and when it comes and goes.
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CARS, getCar } from '../src/cars';
import { CarDamage, hash01, hullOf, type DamageEvent, type DamageGeometry, type HitEvent, type StampedEvent, type V3 } from '../src/core/damage';
import {
  DAMAGE_SHOWN,
  MECH_TUNING,
  MechState,
  axleShare,
  hitEnergy,
  hitWear,
  isNeutral,
  mechanicalEffects,
  mechanicalReport,
  mechanicalWorst,
  neutralEffects,
  wear,
  type MechEffects,
} from '../src/core/mechanical';
import { MechLink } from '../src/game/mechsync';
import { PhysicsWorld, createFlatTrack, type Vehicle } from '../src/physics';

const DEG = Math.PI / 180;
const vanta = getCar('vanta-gt');
const hull = hullOf(vanta.visual);
const geom: DamageGeometry = { surfacePoint: (p) => [p[0], 0.5, p[2]], lamps: [] };
const midZ = (hull.front + hull.rear) / 2;

const wall = (strength: number, p: V3, n: V3 = [-1, 0, 0]): HitEvent => ({ type: 'hit', kind: 'wall', strength, p, n, slide: [0, 0, 20] });
const carHit = (strength: number, p: V3, n: V3 = [0, 0, 1]): HitEvent => ({ type: 'hit', kind: 'car', strength, p, n, slide: [0, 0, 1] });

/** A damage state made directly: the wear (0..1) of the nose, the tail and each wheel. */
function state(parts: { front?: number; rear?: number; wheels?: [number, number, number, number] }): MechState {
  const m = new MechState();
  const e = (w: number): number => -Math.log(1 - Math.min(w, 0.999999));
  m.front = e(parts.front ?? 0);
  m.rear = e(parts.rear ?? 0);
  const w = parts.wheels ?? [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) m.wheel[i] = e(w[i]);
  return m;
}
const fx = (parts: Parameters<typeof state>[0]): MechEffects => mechanicalEffects(state(parts));

describe('what a hit counts for', () => {
  it('ignores everything up to the dent threshold, and rises smoothly above it', () => {
    expect(MECH_TUNING.onset).toBe(2.6);
    for (const s of [0, 1.0, 1.3, 2, 2.6]) expect(hitEnergy(s)).toBe(0);
    // the bumps of a pack race (1.3 to 3.2 m/s) and a 4 degree graze at 200 km/h (3 m/s)
    for (const s of [1.3, 2, 3, 3.2]) expect(hitWear(s)).toBeLessThan(0.003);
    // a smooth onset: half a metre per second above the threshold is still nothing
    expect(hitWear(MECH_TUNING.onset + 0.5)).toBeLessThan(0.003);
    let prev = 0;
    for (let s = 2.6; s < 80; s += 0.7) {
      const w = hitWear(s);
      expect(w).toBeGreaterThanOrEqual(prev);
      expect(w).toBeLessThanOrEqual(1);
      prev = w;
    }
  });

  it('gives a pack race next to nothing, a 60 km/h tap a little, and a real crash a good deal', () => {
    // (closing speeds measured in tests/damage-probe.test.ts: 25 degrees at 60 km/h 6 m/s, at 100 km/h 11, head on at 60 km/h 14,
    // 25 degrees at 200 km/h 23, head on at 100 km/h 27 and at 200 km/h 56)
    const table = [6, 11, 14, 23, 27, 56].map((s) => hitWear(s));
    expect(table[0]).toBeGreaterThan(0.03);
    expect(table[0]).toBeLessThan(0.12);
    expect(table[1]).toBeGreaterThan(0.25);
    expect(table[1]).toBeLessThan(0.5);
    expect(table[2]).toBeGreaterThan(0.45);
    expect(table[2]).toBeLessThan(0.75);
    expect(table[3]).toBeGreaterThan(0.85);
    expect(table[5]).toBeGreaterThan(0.99);
    // forty pack-race bumps on the same corner still leave the car as it is, to anything a driver could feel
    const m = new MechState();
    for (let i = 0; i < 40; i++) m.add(hitEnergy(3.2), 1, 0, 0, 0, 0.5);
    const e = mechanicalEffects(m);
    expect(e.aeroFront).toBeGreaterThan(0.96);
    expect(e.power).toBe(1);
  });

  it('adds hits up and never past wrecked', () => {
    const one = new MechState();
    one.add(hitEnergy(14), 1, 0, 0, 0, 0.5);
    const two = new MechState();
    two.add(hitEnergy(14), 1, 0, 0, 0, 0.5);
    two.add(hitEnergy(14), 1, 0, 0, 0, 0.5);
    expect(wear(two.front)).toBeGreaterThan(wear(one.front));
    expect(wear(two.front)).toBeCloseTo(1 - Math.exp(-2 * hitEnergy(14)), 12);
    for (let i = 0; i < 500; i++) two.add(hitEnergy(30 + hash01(i) * 40), hash01(i, 1), hash01(i, 2), hash01(i, 3), hash01(i, 4), hash01(i, 5));
    expect(wear(two.front)).toBeLessThanOrEqual(1);
    expect(mechanicalWorst(two)).toBeLessThanOrEqual(1);
  });

  it('is the same fold in any order, and the same twice', () => {
    const hits: [number, number][] = [[14, 0.2], [6, 0.9], [23, 0.5], [3.1, 0.1], [11, 0.7]];
    const run = (order: number[]): string => {
      const m = new MechState();
      for (const k of order) m.add(hitEnergy(hits[k][0]), 0.5, 0.1, 0.3, 0.1, hits[k][1]);
      return JSON.stringify([m.front, m.rear, m.wheel.map((w) => +w.toFixed(12))].flat(2));
    };
    expect(run([0, 1, 2, 3, 4])).toBe(run([4, 2, 0, 3, 1]));
    expect(run([0, 1, 2, 3, 4])).toBe(run([0, 1, 2, 3, 4]));
  });
});

describe('where it lands', () => {
  it('shares a flank hit between the wheels by the axle it landed nearer to', () => {
    expect(axleShare(hull.wb / 2, hull.wb)).toBe(1);
    expect(axleShare(-hull.wb / 2, hull.wb)).toBe(0);
    expect(axleShare(hull.front, hull.wb)).toBe(1); // ahead of the front axle
    expect(axleShare(hull.rear, hull.wb)).toBe(0);
    // the middle of the flank: both wheels of that side, about the same
    const mid = new CarDamage(hull, geom);
    mid.apply(wall(14, [hull.hw, 0.6, midZ]));
    expect(mid.mech.wheel[1] + mid.mech.wheel[3]).toBe(0);
    expect(mid.mech.front + mid.mech.rear).toBe(0);
    expect(mid.mech.wheel[0]).toBeGreaterThan(0.3);
    expect(Math.abs(mid.mech.wheel[0] / mid.mech.wheel[2] - 1)).toBeLessThan(0.1);
    // the front left corner: the front left wheel and the nose, and next to nothing on the rear wheel
    const corner = new CarDamage(hull, geom);
    corner.apply(wall(14, [hull.hw, 0.6, hull.front]));
    expect(corner.mech.wheel[0]).toBeGreaterThan(0.2);
    expect(corner.mech.wheel[2]).toBeLessThan(0.01 * corner.mech.wheel[0]);
    expect(corner.mech.front).toBeCloseTo(corner.mech.wheel[0], 6);
    expect(corner.mech.rear).toBe(0);
    // the rear right corner: the other wheel, the other end
    const back = new CarDamage(hull, geom);
    back.apply(carHit(14, [-hull.hw, 0.6, hull.rear], [0, 0, 1]));
    expect(back.mech.wheel[3]).toBeGreaterThan(0.2);
    expect(back.mech.wheel[1]).toBeLessThan(0.01 * back.mech.wheel[3]);
    expect(back.mech.rear).toBeCloseTo(back.mech.wheel[3], 6);
    // a hit on the nose bends the nose and nothing else
    const nose = new CarDamage(hull, geom);
    nose.apply(wall(14, [0, 0.6, hull.front], [0, 0, -1]));
    expect(nose.mech.front).toBeGreaterThan(0.5);
    expect(nose.mech.wheel.every((w) => w === 0)).toBe(true);
  });

  it('does not count taps, scrapes and rubs, and says so by not changing its version', () => {
    const d = new CarDamage(hull, geom);
    d.apply(carHit(2.5, [hull.hw, 0.6, midZ], [-1, 0, 0]));
    d.apply(wall(1.9, [hull.hw, 0.6, hull.front]));
    d.apply({ type: 'rub', kind: 'wall', p: [hull.hw, 0.6, 0], n: [-1, 0, 0], amount: 5, slide: [0, 0, 50] });
    expect(d.mech.pristine).toBe(true);
    expect(d.mech.version).toBe(0);
    expect(d.applied).toBe(3);
    // a bump at the top of a pack race's range, and a 4 degree graze at 200 km/h, leave a trace nobody could see or feel
    for (let i = 0; i < 12; i++) d.apply(carHit(3.2, [hull.hw, 0.6, hull.front], [-1, 0, 0]));
    d.apply(wall(3.0, [hull.hw, 0.6, midZ]));
    expect(mechanicalWorst(d.mech)).toBeLessThan(DAMAGE_SHOWN);
    expect(Math.max(...mechanicalEffects(d.mech).toe.map(Math.abs))).toBeLessThan(0.05 * DEG);
    const v = d.mech.version;
    d.reset();
    expect(d.mech.pristine).toBe(true);
    expect(d.mech.version).toBe(v + 1);
    d.apply(wall(9, [hull.hw, 0.6, midZ]));
    expect(d.mech.pristine).toBe(false);
    expect(d.mech.version).toBe(v + 2);
  });

  it('rebuilds the same mechanics from a replay timeline, at any moment', () => {
    const events: DamageEvent[] = [
      wall(14, [hull.hw, 0.6, hull.front]),
      carHit(6, [-hull.hw, 0.6, midZ], [1, 0, 0]),
      wall(20, [0, 0.6, hull.rear], [0, 0, 1]),
    ];
    const list: StampedEvent[] = events.map((e, i) => ({ f: 10 + i * 15 - 0.5, e }));
    const live = new CarDamage(hull, geom);
    const shown = new CarDamage(hull, geom);
    const after: string[] = [JSON.stringify(live.mech)];
    for (const e of events) {
      live.apply(e);
      after.push(JSON.stringify({ ...live.mech, version: 0 }));
    }
    const at = (f: number): string => {
      shown.syncTo(list, f);
      return JSON.stringify({ ...shown.mech, version: 0 });
    };
    expect(shown.mech.pristine).toBe(true);
    expect(at(9)).toBe(JSON.stringify({ ...new MechState(), version: 0 }));
    expect(at(11)).toBe(after[1]);
    expect(at(27)).toBe(after[2]);
    expect(at(60)).toBe(after[3]);
    expect(at(12)).toBe(after[1]); // back in time
    expect(at(0)).toBe(after[0].replace(/"version":\d+/, '"version":0'));
  });
});

describe('what the damage does, as numbers', () => {
  it('is nothing on a sound car, and a no-op to ask for it', () => {
    const e = mechanicalEffects(new MechState());
    expect(isNeutral(e)).toBe(true);
    expect(isNeutral(neutralEffects())).toBe(true);
    expect(isNeutral(null)).toBe(true);
    expect(isNeutral(fx({ front: 0.2 }))).toBe(false);
  });

  it('follows the brief at the limits: downforce, power, toe and camber', () => {
    const T = MECH_TUNING;
    const all = fx({ front: 1, rear: 1, wheels: [1, 1, 1, 1] });
    expect(all.aeroFront).toBeCloseTo(1 - T.aeroFront, 4);
    expect(all.aeroFront).toBeGreaterThanOrEqual(0.6);
    expect(all.aeroFront).toBeLessThanOrEqual(0.7);
    expect(all.aeroRear).toBeGreaterThanOrEqual(0.58);
    expect(all.aeroRear).toBeLessThanOrEqual(0.7);
    expect(all.power).toBeGreaterThanOrEqual(0.9);
    expect(all.power).toBeLessThanOrEqual(0.92);
    expect(Math.abs(all.toe[0]) / DEG).toBeGreaterThan(1);
    expect(Math.abs(all.toe[0]) / DEG).toBeLessThanOrEqual(1.5 + 1e-9);
    expect(Math.abs(all.toe[2]) / DEG).toBeGreaterThan(0.4);
    expect(Math.abs(all.toe[2]) / DEG).toBeLessThanOrEqual(0.7 + 1e-9); // 0.5 degrees, and a little from a battered tail
    expect(all.camber[0] / DEG).toBeGreaterThan(1);
    expect(all.camber[0] / DEG).toBeLessThanOrEqual(1.5 + 1e-9);
    // the sign convention: a toed-out left wheel points left (+), a toed-out right wheel points right (-); both lean outwards
    expect(all.toe[0]).toBeGreaterThan(0);
    expect(all.toe[1]).toBeLessThan(0);
    expect(all.toe[2]).toBeGreaterThan(0);
    expect(all.toe[3]).toBeLessThan(0);
    expect(all.toe[0]).toBeCloseTo(-all.toe[1], 12);
    expect(all.camber.every((c) => c > 0)).toBe(true);
    expect(all.camberThrust[0]).toBeGreaterThan(0);
    expect(all.camberThrust[1]).toBeLessThan(0);
    expect(Math.min(...all.camberGrip)).toBeGreaterThan(0.9);
  });

  it('costs power only from a heavy nose hit, and the other ends cost none', () => {
    expect(fx({ front: 0.25 }).power).toBe(1);
    expect(fx({ front: 0.5 }).power).toBeLessThan(1);
    expect(fx({ front: 0.5 }).power).toBeGreaterThan(0.97);
    expect(fx({ rear: 1, wheels: [1, 1, 1, 1] }).power).toBe(1);
    expect(fx({ front: 1 }).aeroRear).toBe(1);
    expect(fx({ rear: 1 }).aeroFront).toBe(1);
  });

  it('puts a side only on that side', () => {
    const left = fx({ wheels: [0.8, 0, 0.8, 0] });
    expect(left.toe[1]).toBe(0);
    expect(left.toe[3]).toBe(0);
    expect(left.camber[1]).toBe(0);
    expect(left.toe[0]).toBeGreaterThan(0);
    expect(left.toe[2]).toBeGreaterThan(0);
    const right = fx({ wheels: [0, 0.8, 0, 0.8] });
    expect(right.toe[0]).toBe(0);
    expect(right.toe[1]).toBeCloseTo(-left.toe[0], 12);
  });

  it('grows with the damage without a step, and stays inside its limits', () => {
    const parts: (keyof ReturnType<typeof read>)[] = ['aeroFront', 'aeroRear', 'power', 'toeFL', 'toeRL', 'camber', 'grip'];
    const read = (e: MechEffects) => ({ aeroFront: e.aeroFront, aeroRear: e.aeroRear, power: e.power, toeFL: e.toe[0], toeRL: e.toe[2], camber: e.camber[0], grip: e.camberGrip[0] });
    let prev: ReturnType<typeof read> | null = null;
    for (let i = 0; i <= 200; i++) {
      const w = i / 200;
      const now = read(fx({ front: w, rear: w, wheels: [w, w, w, w] }));
      if (prev)
        for (const k of parts) {
          const step = Math.abs(now[k] - prev[k]);
          // monotone (power, aero and grip fall; toe and camber rise) and without a jump
          if (k === 'aeroFront' || k === 'aeroRear' || k === 'power' || k === 'grip') expect(now[k]).toBeLessThanOrEqual(prev[k] + 1e-12);
          else expect(now[k]).toBeGreaterThanOrEqual(prev[k] - 1e-12);
          expect(step).toBeLessThan(0.02);
        }
      prev = now;
    }
    // the worst a car can be
    const worst = fx({ front: 1, rear: 1, wheels: [1, 1, 1, 1] });
    expect(worst.power).toBeGreaterThan(0.89);
    expect(worst.aeroFront).toBeGreaterThan(0.59);
    expect(worst.aeroRear).toBeGreaterThan(0.59);
  });

  it('reports the damage to the HUD part by part', () => {
    const out = { front: 0, rear: 0, left: 0, right: 0, wheels: [0, 0, 0, 0] as [number, number, number, number] };
    const d = new CarDamage(hull, geom);
    mechanicalReport(d.mech, out);
    expect([out.front, out.rear, out.left, out.right, ...out.wheels]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    d.apply(wall(16, [hull.hw, 0.6, hull.front]));
    mechanicalReport(d.mech, out);
    expect(mechanicalWorst(d.mech)).toBeGreaterThan(DAMAGE_SHOWN);
    expect(out.front).toBeGreaterThan(0.2);
    expect(out.left).toBeGreaterThan(0.2);
    expect(out.right).toBe(0);
    expect(out.wheels[0]).toBeGreaterThan(0.2);
    expect(out.wheels[1]).toBe(0);
    expect(out.rear).toBe(0);
  });
});

// ── the physics ───────────────────────────────────────────────────────────────

const ASSISTS = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true } as const;

function car(def = vanta, kmh = 150, damage: MechEffects | null = null) {
  const world = new PhysicsWorld(createFlatTrack());
  const v = world.addVehicle(def);
  v.assists = { ...ASSISTS };
  v.placeOnGround(new Vector3(), new Quaternion(), kmh / 3.6);
  v.setTemperatures(1);
  if (damage) v.setDamage(damage);
  world.simulate(0.4);
  return { world, v };
}

/** Coasts straight with the wheel held at `steer` and the speed kept; where the car ends up. */
function wander(def: typeof vanta, damage: MechEffects | null, kmh: number, steer: number, secs = 3): { headingDeg: number; drift: number } {
  const { world, v } = car(def, kmh, damage);
  const x0 = v.p.x;
  for (let i = 0; i < secs * 60; i++) {
    v.controls.steer = steer;
    v.controls.throttle = Math.min(1, Math.max(0, 0.25 + (kmh / 3.6 - v.state.forwardSpeed) * 0.3));
    world.step(1 / 60);
  }
  const f = new Vector3(0, 0, 1).applyQuaternion(v.state.quaternion);
  return { headingDeg: Math.atan2(f.x, f.z) / DEG, drift: v.p.x - x0 };
}

/** Keeps the car on the line x = 0 heading +Z like a driver (a pull is corrected, not ignored). */
function holdLine(v: Vehicle): number {
  const f = new Vector3(0, 0, 1).applyQuaternion(v.state.quaternion);
  return Math.max(-0.5, Math.min(0.5, 0.012 * v.state.position.x + 1.2 * Math.atan2(f.x, f.z) + 0.25 * v.state.angularVelocity.y));
}

describe('what the damage does to the car', () => {
  it('leaves a sound car, and one told it is sound, exactly as it was', () => {
    const run = (setIt: boolean): number[] => {
      const { world, v } = car(vanta, 150);
      if (setIt) v.setDamage(neutralEffects());
      for (let i = 0; i < 240; i++) {
        v.controls.steer = 0.04 * Math.sin(i / 20);
        v.controls.throttle = 0.6;
        world.step(1 / 60);
      }
      return [v.p.x, v.p.y, v.p.z, v.v.x, v.v.z, v.state.rpm];
    };
    expect(run(true)).toEqual(run(false));
    expect(Math.abs(wander(vanta, null, 150, 0).drift)).toBeLessThan(0.02);
  });

  it('pulls a car with a bent front wheel towards that side with the wheel centred, and takes steering to hold it straight', () => {
    const hurt = fx({ wheels: [0.6, 0, 0, 0] });
    const left = wander(vanta, hurt, 150, 0);
    expect(left.headingDeg).toBeGreaterThan(4);
    expect(left.drift).toBeGreaterThan(4);
    // the mirror image pulls the other way, as much
    const right = wander(vanta, fx({ wheels: [0, 0.6, 0, 0] }), 150, 0);
    expect(right.headingDeg).toBeLessThan(-4);
    expect(right.headingDeg).toBeCloseTo(-left.headingDeg, 0);
    // steering the other way by about half a degree of road wheel (a tenth of the stick) puts it straight again
    const trim = 0.5 * DEG / vanta.physics.chassis.maxSteer;
    const held = wander(vanta, hurt, 150, trim);
    expect(Math.abs(held.headingDeg)).toBeLessThan(0.5 * Math.abs(left.headingDeg));
    expect(wander(vanta, hurt, 150, 2 * trim).headingDeg).toBeLessThan(-1);
    // a bent rear wheel steps the tail out the other way: a nervous car
    const rear = wander(vanta, fx({ wheels: [0, 0, 1, 0] }), 150, 0);
    expect(rear.headingDeg).toBeLessThan(-2);
    // nose and tail pull nowhere
    for (const w of [{ front: 1 }, { rear: 1 }, { front: 1, rear: 1, wheels: [1, 1, 1, 1] as [number, number, number, number] }]) expect(Math.abs(wander(vanta, fx(w), 150, 0).headingDeg)).toBeLessThan(0.1);
  });

  it('pulls harder the more it is bent, and is the same every time', () => {
    const pulls = [0.2, 0.5, 0.8, 1].map((w) => wander(vanta, fx({ wheels: [w, 0, 0, 0] }), 120, 0).headingDeg);
    for (let i = 1; i < pulls.length; i++) expect(pulls[i]).toBeGreaterThan(pulls[i - 1]);
    expect(wander(vanta, fx({ wheels: [0.5, 0, 0, 0] }), 120, 0)).toEqual(wander(vanta, fx({ wheels: [0.5, 0, 0, 0] }), 120, 0));
  });

  it('shows the toe in the angle of the wheel, which is what the car visual and the replay draw', () => {
    const { world, v } = car(vanta, 100, fx({ wheels: [1, 0, 0, 1] }));
    world.simulate(0.2);
    const t = v.state.wheels.map((w) => w.steerAngle / DEG);
    expect(t[0]).toBeGreaterThan(1.2);
    expect(t[1]).toBe(0);
    expect(t[2]).toBe(0);
    expect(t[3]).toBeLessThan(-0.3);
  });

  it('pushes the tyres of a bent wheel sideways, towards the lean, and repairs when told to', () => {
    // (a push on all four tyres in proportion to their load goes through the middle of the car: it is held by a small slip angle,
    // so the car points a little the other way instead of drifting. The sign is what shows)
    const thrust = neutralEffects();
    thrust.camber = [0.02, 0.02, 0.02, 0.02];
    thrust.camberThrust = [0.1, 0.1, 0.1, 0.1];
    expect(wander(vanta, thrust, 150, 0).headingDeg).toBeLessThan(-0.15);
    thrust.camberThrust = [-0.1, -0.1, -0.1, -0.1];
    expect(wander(vanta, thrust, 150, 0).headingDeg).toBeGreaterThan(0.15);
    const { world, v } = car(vanta, 150, fx({ wheels: [1, 0, 0, 0] }));
    expect(v.mechanical).not.toBeNull();
    v.setDamage(null);
    expect(v.mechanical).toBeNull();
    const x0 = v.p.x;
    for (let i = 0; i < 180; i++) {
      v.controls.steer = holdLine(v);
      v.controls.throttle = 0.5;
      world.step(1 / 60);
    }
    expect(Math.abs(v.p.x - x0)).toBeLessThan(1);
  });

  it('keeps the grip of the tyre down on a bent wheel', () => {
    const base = car(vanta, 120);
    const bent = car(vanta, 120, { ...neutralEffects(), camber: [0.02, 0.02, 0.02, 0.02], camberGrip: [0.8, 0.8, 0.8, 0.8] });
    for (const c of [base, bent]) {
      for (let i = 0; i < 90; i++) {
        c.v.controls.steer = 0.03;
        c.v.controls.throttle = 0.4;
        c.world.step(1 / 60);
      }
    }
    // the same slip and about the same load: the peak friction the tyres could give is 20 % lower
    const peak = (c: typeof base): number => c.v.wheels.reduce((a, w) => a + w.peakF, 0);
    expect(peak(bent) / peak(base)).toBeGreaterThan(0.77);
    expect(peak(bent) / peak(base)).toBeLessThan(0.83);
  });

  it('loses the grip that the downforce gave the rear axle at speed (a prototype feels it, a road car hardly)', () => {
    const rearGrip = (id: string, e: MechEffects | null): number => {
      const { world, v } = car(getCar(id), 250, e);
      for (let i = 0; i < 90; i++) {
        v.controls.throttle = Math.min(1, Math.max(0, 0.3 + (250 / 3.6 - v.state.forwardSpeed) * 0.3));
        world.step(1 / 60);
      }
      return v.wheels[2].peakF + v.wheels[3].peakF;
    };
    const lmp = rearGrip('lmp-x', null);
    const lmpHurt = rearGrip('lmp-x', fx({ rear: 1 }));
    expect(lmpHurt / lmp).toBeLessThan(0.93);
    expect(lmpHurt / lmp).toBeGreaterThan(0.75);
    const gt = rearGrip('vanta-gt', null);
    expect(rearGrip('vanta-gt', fx({ rear: 1 })) / gt).toBeGreaterThan(0.95);
    // and the front end, which it should leave be
    const frontGrip = (e: MechEffects | null): number => {
      const { world, v } = car(getCar('lmp-x'), 250, e);
      for (let i = 0; i < 90; i++) {
        v.controls.throttle = Math.min(1, Math.max(0, 0.3 + (250 / 3.6 - v.state.forwardSpeed) * 0.3));
        world.step(1 / 60);
      }
      return v.wheels[0].peakF + v.wheels[1].peakF;
    };
    expect(frontGrip(fx({ rear: 1 })) / frontGrip(null)).toBeGreaterThan(0.99);
    expect(frontGrip(fx({ front: 1 })) / frontGrip(null)).toBeLessThan(0.93);
  });

  it('lowers the top speed and slows the acceleration with the tired engine', () => {
    const top = (e: MechEffects | null): { vmax: number; t100: number } => {
      const { world, v } = car(vanta, 0, e);
      v.placeOnGround(new Vector3(), new Quaternion(), 0);
      v.controls.throttle = 1;
      let vmax = 0;
      let t100 = NaN;
      const t0 = world.time;
      for (let i = 0; i < 60 * 60; i++) {
        v.controls.steer = holdLine(v);
        world.step(1 / 60);
        vmax = Math.max(vmax, v.state.forwardSpeed * 3.6);
        if (Number.isNaN(t100) && v.state.forwardSpeed * 3.6 >= 100) t100 = world.time - t0;
      }
      return { vmax, t100 };
    };
    const sound = top(null);
    const tired = top(fx({ front: 1 }));
    expect(tired.vmax).toBeLessThan(sound.vmax * 0.985);
    expect(tired.vmax).toBeGreaterThan(sound.vmax * 0.93);
    // (off the line the car is limited by grip, not by power: the standing start hardly changes)
    expect(tired.t100).toBeGreaterThan(sound.t100 * 1.005);
    // a car with a tail in pieces is just as quick in a straight line
    expect(top(fx({ rear: 1 })).vmax).toBeGreaterThan(sound.vmax * 0.995);
  });

  it('never makes a car undrivable: every car, wrecked everywhere, holds a line at speed and still gets going', () => {
    for (const def of CARS) {
      const wreck = fx({ front: 1, rear: 1, wheels: [1, 1, 1, 1] });
      const { world, v } = car(def, 0, wreck);
      v.controls.throttle = 1;
      let worstOff = 0;
      let vmax = 0;
      for (let i = 0; i < 60 * 40; i++) {
        v.controls.steer = holdLine(v);
        v.controls.throttle = v.state.forwardSpeed > 55 ? 0.6 : 1;
        world.step(1 / 60);
        worstOff = Math.max(worstOff, Math.abs(v.state.position.x));
        vmax = Math.max(vmax, v.state.forwardSpeed);
        expect(Number.isFinite(v.state.position.x + v.state.position.y + v.state.position.z)).toBe(true);
      }
      expect(worstOff, def.id).toBeLessThan(2);
      expect(vmax * 3.6, def.id).toBeGreaterThan(0.6 * def.stats.topSpeedKmh * 0.85);
      // lopsided, too: the worst corner on its own
      const lop = car(def, 130, fx({ front: 1, wheels: [1, 0, 1, 0] }));
      for (let i = 0; i < 60 * 15; i++) {
        lop.v.controls.steer = holdLine(lop.v);
        lop.v.controls.throttle = lop.v.state.forwardSpeed > 36 ? 0.4 : 0.8;
        lop.world.step(1 / 60);
      }
      // (a driver that has nothing to hold the wheel against a steady pull but a push proportional to the error settles off the line)
      expect(Math.abs(lop.v.state.position.x), def.id).toBeLessThan(4);
    }
  });
});

// ── when it comes and goes ───────────────────────────────────────────────────────

describe('the life of the damage', () => {
  /** A car with a record, a physics and a driver stand-in, as the game sets one up. */
  function setup() {
    const record = new CarDamage(hull, geom);
    const { world, v } = car(vanta, 100);
    const told: (MechEffects | null)[] = [];
    const link = new MechLink([v, { setDamage: (e) => void told.push(e && { ...e }) }]);
    return { record, world, v, link, told };
  }

  it('does nothing in Visual or Off, however hard the hit, and everything in Full', () => {
    const { record, v, link, told } = setup();
    record.apply(wall(20, [hull.hw, 0.6, hull.front]));
    expect(record.mech.pristine).toBe(false); // the record is kept in every mode that keeps damage
    expect(link.update(record.mech, false)).toBe(false);
    expect(v.mechanical).toBeNull();
    expect(told.length).toBe(0);
    expect(link.update(record.mech, true)).toBe(true);
    expect(v.mechanical).not.toBeNull();
    expect(v.mechanical!.toe[0]).toBeGreaterThan(0.2 * DEG);
    expect(told.length).toBe(1);
    expect(told[0]!.aeroFront).toBeLessThan(1);
    // asking again with nothing new changes nothing
    expect(link.update(record.mech, true)).toBe(false);
    expect(told.length).toBe(1);
    // a later hit goes on top of it
    const before = v.mechanical!.toe[0];
    record.apply(wall(20, [hull.hw, 0.6, midZ]));
    expect(link.update(record.mech, true)).toBe(true);
    expect(v.mechanical!.toe[0]).toBeGreaterThan(before);
    expect(told.length).toBe(2);
  });

  it('is taken off again when the mode goes back to Visual or Off, and comes back with Full', () => {
    const { record, v, link, told } = setup();
    record.apply(wall(20, [hull.hw, 0.6, hull.front]));
    link.update(record.mech, true);
    expect(v.mechanical).not.toBeNull();
    link.update(record.mech, false);
    expect(v.mechanical).toBeNull();
    expect(told[told.length - 1]).toBeNull();
    link.update(record.mech, true);
    expect(v.mechanical).not.toBeNull();
    expect(link.version).toBe(record.mech.version);
  });

  it('starts every new car sound: a restart or the next round builds new ones', () => {
    const first = setup();
    first.record.apply(wall(25, [hull.hw, 0.6, hull.front]));
    first.link.update(first.record.mech, true);
    expect(first.v.mechanical).not.toBeNull();
    const second = setup();
    second.link.update(second.record.mech, true);
    expect(second.v.mechanical).toBeNull();
    expect(second.record.mech.pristine).toBe(true);
    expect(second.told.every((e) => e === null)).toBe(true);
  });

  it('leaves the damage where it is when the car is put back on the track', () => {
    const { record, world, v, link } = setup();
    record.apply(wall(25, [hull.hw, 0.6, hull.front]));
    link.update(record.mech, true);
    const toe = v.mechanical!.toe[0];
    // the game resets a car with placeOnGround and stop(), and neither touches the damage
    v.stop();
    v.placeOnGround(new Vector3(5, 0, 50), new Quaternion(), 0);
    world.simulate(0.5);
    expect(v.mechanical!.toe[0]).toBe(toe);
    expect(link.update(record.mech, true)).toBe(false);
    expect(v.mechanical!.toe[0]).toBe(toe);
  });

  it('hands a driver that joins later what the others already know', () => {
    const record = new CarDamage(hull, geom);
    const { v } = car(vanta, 100);
    const link = new MechLink([v]);
    record.apply(wall(25, [hull.hw, 0.6, hull.front]));
    link.update(record.mech, true);
    const late: (MechEffects | null)[] = [];
    link.add({ setDamage: (e) => void late.push(e) }, record.mech);
    expect(late.length).toBe(1);
    expect(late[0]!.aeroFront).toBeLessThan(1);
  });
});
