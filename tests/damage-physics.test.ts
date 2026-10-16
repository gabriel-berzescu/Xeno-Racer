/**
 * The damage model fed by the real physics: cars coasting into the barrier and into each other, observed once per
 * rendered frame (60 Hz) and, as the reference, at every physics substep (1000 Hz). Calibrates strength against speed and
 * checks that the late read of a contact still lands on the corner of the collision box that touched.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { getCar } from '../src/cars';
import type { CarDefinition, TrackFrame, TrackPoint } from '../src/core/contracts';
import { CarDamage, DAMAGE_TUNING, ImpactObserver, hitLook, hullCandidates, hullOf, hullSurfaceDistance, type DamageEvent, type HitEvent, type RubEvent } from '../src/core/damage';
import { PhysicsWorld, type Vehicle } from '../src/physics';
import { loadTrackRuntime } from '../src/track';

const frame: TrackFrame = { position: new Vector3(), tangent: new Vector3(), normal: new Vector3(), left: new Vector3(), widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, curvature: 0, bank: 0 };
const m4 = new Matrix4();
const ASSISTS = { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true } as const;

function place(world: PhysicsWorld, v: Vehicle, s: number, d: number, speed: number, yaw = 0): void {
  const tr = world.track;
  tr.frameAt(tr.wrapS(s), frame);
  const q = new Quaternion().setFromRotationMatrix(m4.makeBasis(frame.left, frame.normal, frame.tangent));
  q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw));
  v.placeOnGround(tr.pointAt(tr.wrapS(s), d, new Vector3()), q, speed);
}

/** A car coasting into the left barrier of Aurelia's main straight at `kmh`, `deg` off parallel. Events from an observer stepped at `dt`. */
function intoWall(def: CarDefinition, kmh: number, deg: number, dt: number): { events: DamageEvent[]; impacts: number[]; maxScrape: number } {
  const track = loadTrackRuntime('aurelia');
  const world = new PhysicsWorld(track);
  const v = world.addVehicle(def);
  v.assists = { ...ASSISTS };
  const tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
  const origin = track.pointAt(600, 0, new Vector3());
  track.project(origin.x, origin.z, tp);
  const yaw = (deg * Math.PI) / 180;
  place(world, v, 600, Math.max(-tp.wallRight + 2.5, tp.wallLeft - 2.4 - Math.sin(yaw) * 25), kmh / 3.6, yaw);
  v.setTemperatures(1);
  const obs = new ImpactObserver(hullOf(def.visual));
  const events: DamageEvent[] = [];
  const impacts: number[] = [];
  let seen = v.state.impactCount;
  let maxScrape = 0;
  for (let i = 0; i < 2.5 / dt; i++) {
    world.step(dt);
    if (v.state.impactCount !== seen) {
      seen = v.state.impactCount;
      impacts.push(v.state.lastImpact.strength);
    }
    maxScrape = Math.max(maxScrape, v.state.scrape);
    obs.update(v.state, dt, (e) => events.push(e));
  }
  return { events, impacts, maxScrape };
}

const hits = (es: DamageEvent[]): HitEvent[] => es.filter((e): e is HitEvent => e.type === 'hit');
const rubs = (es: DamageEvent[]): RubEvent[] => es.filter((e): e is RubEvent => e.type === 'rub');

describe('damage from real wall hits', () => {
  const def = getCar('vanta-gt');
  const hull = hullOf(def.visual);
  const cands = hullCandidates(hull);
  const onBox = (p: [number, number, number]): boolean => cands.some((c) => Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]) < 1e-9);

  it('reads strength as the closing speed: v sin(angle), from a graze to a head-on crash', () => {
    const cases: [number, number, number, number][] = [
      // km/h, degrees, expected closing speed range (m/s)
      [100, 10, 3, 6],
      [100, 25, 9, 13],
      [60, 85, 11, 16],
      [150, 50, 26, 34],
    ];
    for (const [kmh, deg, lo, hi] of cases) {
      const r = intoWall(def, kmh, deg, 1 / 60);
      const h = hits(r.events);
      expect(h.length, `${kmh} km/h at ${deg}°`).toBeGreaterThan(0);
      const first = h[0];
      expect(first.kind).toBe('wall');
      expect(first.strength).toBeGreaterThan(lo);
      expect(first.strength).toBeLessThan(hi);
      // the closing speed is what the physics registered, untouched
      expect(r.impacts[0]).toBeCloseTo(first.strength, 6);
    }
  });

  it('puts a late read of the contact back on the corner of the collision box that touched', () => {
    for (const [kmh, deg] of [[100, 25], [150, 10], [200, 25], [60, 50], [100, 85]] as const) {
      const exact = hits(intoWall(def, kmh, deg, 1 / 1000).events)[0];
      const frameRate = hits(intoWall(def, kmh, deg, 1 / 60).events)[0];
      expect(exact, `${kmh}/${deg} exact`).toBeDefined();
      expect(frameRate, `${kmh}/${deg} 60 Hz`).toBeDefined();
      // both are one of the 12 points the physics tests against the wall, and the same one
      expect(onBox(exact.p)).toBe(true);
      expect(onBox(frameRate.p)).toBe(true);
      expect(frameRate.p).toEqual(exact.p);
      // (the two runs step the same physics a different way: the same hit to within a few percent)
      expect(Math.abs(frameRate.strength / exact.strength - 1)).toBeLessThan(0.03);
      // pushed away from a wall on the left (towards the car's right, or straight back on a head-on hit)
      expect(frameRate.n[0]).toBeLessThan(0);
      expect(frameRate.p[0]).toBeGreaterThan(0.9 * hull.hw);
    }
  });

  it('turns a graze into a scrape on the flank: rub events along the barrier and a long streak', () => {
    const r = intoWall(def, 180, 5, 1 / 60);
    expect(r.maxScrape).toBeGreaterThan(0.3);
    const rb = rubs(r.events);
    expect(rb.length).toBeGreaterThan(1);
    for (const e of rb) {
      expect(e.p[0]).toBeGreaterThan(hull.hw - 0.1); // on the left side
      expect(e.amount).toBeGreaterThan(0.05);
      expect(Math.abs(e.slide[2])).toBeGreaterThan(20); // sliding along the car
    }
    // folded into the model: one long streak along the flank and at most a shallow dent where it first touched
    const d = new CarDamage(hull, { surfacePoint: (p) => [p[0], 0.5, p[2]], lamps: [] });
    for (const e of r.events) d.apply(e);
    expect(d.marks.some((m) => m.kind === 1 && m.hl > 0.4)).toBe(true);
    expect(d.dents.length).toBeLessThanOrEqual(1);
    for (const dent of d.dents) expect(dent.depth).toBeLessThan(0.12);
  });

  it('calibrates: strength in, dent out, on the measured scale', () => {
    // (closing speeds measured in tests/damage-probe.test.ts: graze 3, 60 km/h at 25 degrees 6, 100 km/h at 25 degrees 11,
    // head on at 60 km/h 14, at 100 km/h 27, at 200 km/h 56)
    const table = [3, 6, 11, 14, 27, 56].map((s) => ({ s, ...hitLook(s) }));
    expect(table[0].depth).toBeLessThan(0.05);
    expect(table[1].depth).toBeGreaterThan(0.08);
    expect(table[1].depth).toBeLessThan(0.2);
    expect(table[2].depth).toBeGreaterThan(0.2);
    expect(table[3].lamp).toBe('broken');
    expect(table[5].depth).toBeGreaterThan(0.99 * DAMAGE_TUNING.depthMax);
    for (let i = 1; i < table.length; i++) expect(table[i].depth).toBeGreaterThanOrEqual(table[i - 1].depth);
  });
});

describe('damage from real car-to-car contacts', () => {
  const def = getCar('kestrel-r');
  const hull = hullOf(def.visual);

  it('hurts both cars where they touched, with the other car\'s paint, and slides relative to it', () => {
    const track = loadTrackRuntime('aurelia');
    const world = new PhysicsWorld(track);
    const a = world.addVehicle(def);
    const b = world.addVehicle(def);
    for (const v of [a, b]) v.assists = { ...ASSISTS };
    place(world, a, 620, 0, 0);
    place(world, b, 596, 0, 17);
    a.holdOnGrid = true;
    const paints = [0xd4122b, 0x1f4fff];
    const vehicles = [a, b];
    const obs = vehicles.map((v, i) => {
      const o = new ImpactObserver(hull);
      o.otherAt = () => {
        const other = vehicles[1 - i].state;
        return { paint: paints[1 - i], vx: other.velocity.x, vy: other.velocity.y, vz: other.velocity.z };
      };
      return o;
    });
    const events: DamageEvent[][] = [[], []];
    for (let i = 0; i < 2 * 60; i++) {
      world.step(1 / 60);
      vehicles.forEach((v, k) => obs[k].update(v.state, 1 / 60, (e) => events[k].push(e)));
    }
    const ha = hits(events[0]);
    const hb = hits(events[1]);
    expect(ha.length).toBeGreaterThan(0);
    expect(hb.length).toBeGreaterThan(0);
    expect(ha[0].kind).toBe('car');
    expect(hb[0].kind).toBe('car');
    // the same closing speed on both cars; the paint is the other's
    expect(ha[0].strength).toBeCloseTo(hb[0].strength, 3);
    expect(ha[0].paint).toBe(paints[1]);
    expect(hb[0].paint).toBe(paints[0]);
    // A was hit in the back (pushed forward), B in the front (pushed back)
    expect(ha[0].n[2]).toBeGreaterThan(0.9);
    expect(hb[0].n[2]).toBeLessThan(-0.9);
    expect(hullSurfaceDistance(ha[0].p, hull)).toBeLessThan(0.25);
    expect(ha[0].p[2]).toBeLessThan(hull.rear + 0.25);
    expect(hb[0].p[2]).toBeGreaterThan(hull.front - 0.25);
    // a shunt in line: hardly any sliding relative to the car in front
    expect(Math.hypot(...ha[0].slide)).toBeLessThan(4);
    // folded in: rubber and the other car's paint on both, a dent where it was hard enough
    const dmg = [new CarDamage(hull, { surfacePoint: (p) => [p[0], 0.5, p[2]], lamps: [] }), new CarDamage(hull, { surfacePoint: (p) => [p[0], 0.5, p[2]], lamps: [] })];
    events[0].forEach((e) => dmg[0].apply(e));
    events[1].forEach((e) => dmg[1].apply(e));
    for (const d of dmg) {
      expect(d.marks.some((m) => m.kind === 2)).toBe(true);
      expect(d.marks.some((m) => m.kind === 3)).toBe(true);
    }
    expect(dmg[0].marks.find((m) => m.kind === 3)!.col).toBe(paints[1]);
    expect(dmg[1].marks.find((m) => m.kind === 3)!.col).toBe(paints[0]);
    expect(dmg[0].zones.rear.hits).toBeGreaterThan(0);
    expect(dmg[1].zones.front.hits).toBeGreaterThan(0);
  });
});
