import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { getCar, CARS } from '../src/cars';
import {
  CarDamage,
  DAMAGE_TUNING,
  DAMAGE_ZONES,
  ImpactObserver,
  MAX_CRACKS,
  MAX_DENTS,
  MAX_MARKS,
  countUpTo,
  crackRadius,
  depthForEnergy,
  hash01,
  hitLook,
  hullCandidates,
  hullOf,
  hullSurfaceDistance,
  radiusForStrength,
  zoneWeights,
  type DamageEvent,
  type DamageGeometry,
  type GlassSpot,
  type HitEvent,
  type Hull,
  type StampedEvent,
  type V3,
} from '../src/core/damage';
import type { VehicleState } from '../src/core/contracts';
import { FULL_CAR, mechanicalEffects, mechanicalProfile } from '../src/core/mechanical';
import { DEFAULT_SETTINGS, loadSettings } from '../src/core/settings';

const hull: Hull = hullOf(getCar('vanta-gt').visual);

/** A flat-sided stand-in body: the surface point is the hull outline at the damage height. */
const geom: DamageGeometry = {
  surfacePoint: (p, n) => {
    const x = Math.max(-hull.hw + 0.1, Math.min(hull.hw - 0.1, p[0]));
    const z = Math.max(hull.rear + 0.1, Math.min(hull.front - 0.1, p[2]));
    // pushed against a side, the point sits on that side; against an end, on that end
    if (Math.abs(n[0]) > Math.abs(n[2])) return [n[0] > 0 ? -hull.hw + 0.05 : hull.hw - 0.05, 0.5, z];
    return [x, 0.5, n[2] < 0 ? hull.front - 0.05 : hull.rear + 0.05];
  },
  lamps: [
    { c: [0.67, 0.65, 2.2], r: 0.18 },
    { c: [-0.67, 0.65, 2.2], r: 0.18 },
    { c: [0.52, 0.84, -2.3], r: 0.16 },
    { c: [-0.52, 0.84, -2.3], r: 0.16 },
  ],
};

const wallHit = (strength: number, p: V3 = [hull.hw, 0.6, hull.front], n: V3 = [-1, 0, 0], slide: V3 = [0, 0, 20]): HitEvent => ({ type: 'hit', kind: 'wall', strength, p, n, slide });
const carHit = (strength: number, p: V3 = [0.9, 0.7, hull.rear], n: V3 = [0, 0, 1], paint?: number): HitEvent => ({ type: 'hit', kind: 'car', strength, p, n, slide: [0.5, 0, 2], paint });

describe('damage calibration', () => {
  it('grows with the hit and saturates below the depth cap', () => {
    let prev = -1;
    for (const s of [2.6, 3, 4, 6, 9, 14, 25, 56, 200]) {
      const d = hitLook(s).depth;
      expect(d).toBeGreaterThan(prev - 1e-12);
      expect(d).toBeLessThanOrEqual(DAMAGE_TUNING.depthMax);
      prev = d;
    }
    expect(depthForEnergy(1e9)).toBeLessThanOrEqual(DAMAGE_TUNING.depthMax);
  });

  it('gives a tap a scuff, a 60 km/h wall hit a crumpled corner and a 200 km/h one the cap', () => {
    // the closing speeds measured with tests/damage-probe.test.ts
    expect(hitLook(2.0)).toMatchObject({ depth: 0, lamp: 'intact' }); // pack-race tap, graze at 100 km/h
    expect(hitLook(3.0).depth).toBeGreaterThan(0.02);
    expect(hitLook(3.0).depth).toBeLessThan(0.05);
    expect(hitLook(5.7).lamp).toBe('cracked'); // 60 km/h at 25 degrees
    const sixty = hitLook(13.8); // 60 km/h head on
    expect(sixty.depth).toBeGreaterThan(0.2);
    expect(sixty.lamp).toBe('broken');
    expect(hitLook(56).depth).toBeGreaterThan(0.31); // 200 km/h head on
    expect(hitLook(56).radius).toBeLessThanOrEqual(DAMAGE_TUNING.radiusMax);
    expect(radiusForStrength(0)).toBeCloseTo(DAMAGE_TUNING.radiusMin, 5);
  });
});

describe('zones', () => {
  it('puts a corner hit into two zones and an end or flank hit into one', () => {
    const corner = zoneWeights([hull.hw, 0.6, hull.front], hull);
    expect(corner.front).toBeCloseTo(0.5, 2);
    expect(corner.left).toBeCloseTo(0.5, 2);
    expect(zoneWeights([-hull.hw, 0.6, (hull.front + hull.rear) / 2], hull).right).toBeCloseTo(1, 5);
    expect(zoneWeights([0, 0.6, hull.rear], hull).rear).toBeCloseTo(1, 5);
    for (const p of [[0, 1, 0], [0.3, 1.1, 1], [-0.9, 0.3, -2]] as V3[]) {
      const w = zoneWeights(p, hull);
      expect(w.front + w.rear + w.left + w.right).toBeCloseTo(1, 5);
    }
  });

  it('records hits and severity per zone, harder hits counting for more', () => {
    const d = new CarDamage(hull, geom);
    d.apply(wallHit(8, [hull.hw, 0.6, (hull.front + hull.rear) / 2]));
    expect(d.zones.left.hits).toBe(1);
    expect(d.zones.left.worst).toBe(8);
    expect(d.zones.right.hits).toBe(0);
    const once = d.zones.left.severity;
    expect(once).toBeGreaterThan(0.2);
    d.apply(wallHit(8, [hull.hw, 0.6, (hull.front + hull.rear) / 2]));
    expect(d.zones.left.severity).toBeGreaterThan(once);
    expect(d.zones.left.severity).toBeLessThan(1);
    expect(d.severity).toBeGreaterThan(d.zones.left.severity - 1e-9);
    expect(DAMAGE_ZONES.every((z) => d.zones[z].severity >= 0 && d.zones[z].severity <= 1)).toBe(true);
  });
});

describe('dents', () => {
  it('leaves a light tap as paint marks only', () => {
    const d = new CarDamage(hull, geom);
    d.apply(carHit(2.2, undefined, undefined, 0xff3300));
    expect(d.dents.length).toBe(0);
    expect(d.marks.map((m) => m.kind).sort()).toEqual([0, 2, 3]);
    expect(d.marks.find((m) => m.kind === 3)!.col).toBe(0xff3300);
  });

  it('dents the car where it was hit, pushing the way the obstacle pushed', () => {
    const d = new CarDamage(hull, geom);
    d.apply(wallHit(12, [hull.hw, 0.6, hull.front], [-0.7, 0, -0.7]));
    expect(d.dents.length).toBe(1);
    const dent = d.dents[0];
    expect(dent.depth).toBeGreaterThan(0.15);
    expect(dent.d[0]).toBeLessThan(-0.5);
    expect(dent.d[2]).toBeLessThan(-0.5);
    expect(Math.hypot(...dent.d)).toBeCloseTo(1, 5);
    expect(Math.abs(dent.t[0] * dent.d[0] + dent.t[1] * dent.d[1] + dent.t[2] * dent.d[2])).toBeLessThan(1e-6);
    // a graze is long and shallow compared with a head-on hit of the same speed
    const g = new CarDamage(hull, geom);
    g.apply(wallHit(12, [hull.hw, 0.6, 0], [-1, 0, 0], [0, 0, 50]));
    const h = new CarDamage(hull, geom);
    h.apply(wallHit(12, [hull.hw, 0.6, 0], [-1, 0, 0], [0, 0, 0]));
    expect(g.dents[0].e).toBeGreaterThan(h.dents[0].e + 0.5);
  });

  it('merges nearby hits into one deeper dent and keeps distant ones apart', () => {
    const d = new CarDamage(hull, geom);
    d.apply(carHit(6, [0.8, 0.7, hull.rear]));
    const one = d.dents[0].depth;
    d.apply(carHit(6, [0.7, 0.7, hull.rear]));
    expect(d.dents.length).toBe(1);
    expect(d.dents[0].depth).toBeGreaterThan(one);
    expect(d.dents[0].depth).toBeCloseTo(depthForEnergy(72), 6);
    d.apply(carHit(6, [-0.8, 0.7, hull.rear]));
    expect(d.dents.length).toBe(2);
    // the opposite push direction never merges
    d.apply(carHit(6, [0.8, 0.7, hull.front], [0, 0, -1]));
    expect(d.dents.length).toBe(3);
  });

  it('never exceeds the depth, radius and table caps, however many times it is hit', () => {
    const d = new CarDamage(hull, geom);
    for (let i = 0; i < 200; i++) {
      const sx = hash01(i, 1) * 2 - 1;
      const sz = hash01(i, 2) * 2 - 1;
      const s = 3 + hash01(i, 3) * 50;
      const side = hash01(i, 4) < 0.5;
      d.apply(
        side
          ? wallHit(s, [sx > 0 ? hull.hw : -hull.hw, 0.6, sz * 2], [sx > 0 ? -1 : 1, 0, 0])
          : carHit(s, [sx * hull.hw, 0.7, sz > 0 ? hull.front : hull.rear], [0, 0, sz > 0 ? -1 : 1]),
      );
      expect(d.dents.length).toBeLessThanOrEqual(MAX_DENTS);
      expect(d.marks.length).toBeLessThanOrEqual(MAX_MARKS);
    }
    for (const dent of d.dents) {
      expect(dent.depth).toBeLessThanOrEqual(DAMAGE_TUNING.depthMax);
      expect(dent.r).toBeLessThanOrEqual(DAMAGE_TUNING.radiusMax + 1e-9);
      expect(dent.e).toBeLessThanOrEqual(2.6);
    }
    for (const z of DAMAGE_ZONES) expect(d.zones[z].severity).toBeLessThanOrEqual(1);
    expect(d.marks.every((m) => m.wear <= 1 && m.hl <= 1.9)).toBe(true);
  });

  it('ignores impacts under the physics threshold', () => {
    const d = new CarDamage(hull, geom);
    d.apply(wallHit(0.6));
    expect(d.pristine).toBe(true);
    expect(DAMAGE_ZONES.every((z) => d.zones[z].hits === 0)).toBe(true);
  });
});

describe('paint marks', () => {
  it('lets a long rub grow one streak along the wall instead of piling up marks', () => {
    const d = new CarDamage(hull, geom);
    for (let i = 0; i < 12; i++) {
      d.apply({ type: 'rub', kind: 'wall', p: [hull.hw, 0.6, 1.2 - i * 0.3], n: [-1, 0, 0], amount: 0.6, slide: [0, 0, 45] });
    }
    const streaks = d.marks.filter((m) => m.kind === 1);
    expect(streaks.length).toBeLessThanOrEqual(2);
    expect(Math.max(...streaks.map((m) => m.hl))).toBeGreaterThan(0.8);
    expect(Math.max(...streaks.map((m) => m.wear))).toBeGreaterThan(0.5);
  });

  it('paints the other car\'s colour only in car contacts that know it', () => {
    const d = new CarDamage(hull, geom);
    d.apply(wallHit(5));
    expect(d.marks.some((m) => m.kind === 3)).toBe(false);
    d.apply(carHit(5, undefined, undefined, 0x2255ff));
    expect(d.marks.some((m) => m.kind === 3 && m.col === 0x2255ff)).toBe(true);
    expect(d.marks.some((m) => m.kind === 2)).toBe(true);
  });
});

describe('lamps', () => {
  it('cracks a lamp the hit lands near and breaks it from a harder one, never mending it', () => {
    const d = new CarDamage(hull, geom);
    d.apply(carHit(3.5, [0.67, 0.65, hull.front], [0, 0, -1]));
    expect(d.lamps[0].out).toBe(1);
    d.apply(carHit(7, [0.67, 0.65, hull.front], [0, 0, -1]));
    expect(d.lamps[0].out).toBe(0.5);
    expect(d.lamps[0].crack).toBeGreaterThan(0.25);
    expect(d.lamps[1].out).toBe(1); // the other headlight is untouched
    d.apply(carHit(16, [0.67, 0.65, hull.front], [0, 0, -1]));
    expect(d.lamps[0]).toMatchObject({ out: 0, crack: 1 });
    d.apply(carHit(3, [0.67, 0.65, hull.front], [0, 0, -1]));
    expect(d.lamps[0].out).toBe(0);
  });

  it('breaks the tail lights on a rear hit and not the headlights', () => {
    const d = new CarDamage(hull, geom);
    d.apply(carHit(14, [0.52, 0.8, hull.rear], [0, 0, 1]));
    expect(d.lamps[2].out).toBe(0);
    expect(d.lamps[0].out).toBe(1);
    expect(d.lamps[1].out).toBe(1);
  });
});

describe('glass', () => {
  // windows at fixed places: the windscreen low in front of the driver, the rear glass, the two side windows
  const glassGeom: DamageGeometry = {
    ...geom,
    glassPoints: (p, d) => {
      const out: GlassSpot[] = [];
      if (d[2] < -0.5) out.push({ id: 0, c: [Math.max(-0.4, Math.min(0.4, p[0] * 0.6)), 1.0, 0.1], n: [0, 0.5, 0.86] });
      if (d[2] > 0.5) out.push({ id: 1, c: [Math.max(-0.4, Math.min(0.4, p[0] * 0.6)), 1.05, -1.5], n: [0, 0.8, -0.6] });
      if (Math.abs(d[0]) > 0.6) out.push({ id: d[0] < 0 ? 2 : 3, c: [d[0] < 0 ? 0.8 : -0.8, 1.05, Math.max(-1, Math.min(0, p[2]))], n: [d[0] < 0 ? 1 : -1, 0, 0] });
      return out;
    },
  };
  const headOn = (s: number, x = 0): HitEvent => wallHit(s, [x, 0.6, hull.front], [0, 0, -1], [0, 0, 5]);

  it('cracks the windscreen from a hard head-on hit and leaves a tap and a graze alone', () => {
    const d = new CarDamage(hull, glassGeom);
    d.apply(headOn(DAMAGE_TUNING.glassCrack - 0.5));
    expect(d.cracks.length).toBe(0);
    expect(d.lastHit?.glass).toBeNull();
    d.apply(headOn(12));
    expect(d.cracks.length).toBe(1);
    expect(d.cracks[0].id).toBe(0);
    expect(d.cracks[0].r).toBeCloseTo(crackRadius(12), 6);
    expect(d.lastHit?.glass).toEqual(d.cracks[0].c);
    // a hard scrape along the flank of a car with no window beside the hit does not touch the glass
    const e = new CarDamage(hull, glassGeom);
    e.apply(wallHit(14, [hull.hw, 0.6, hull.front], [-0.4, 0, -0.9]));
    expect(e.cracks.filter((c) => c.id >= 2).length).toBe(0);
  });

  it('cracks the glass on the side that was hit, and the rear glass from behind', () => {
    const left = new CarDamage(hull, glassGeom);
    left.apply(wallHit(12, [hull.hw, 0.6, -0.5], [-1, 0, 0]));
    expect(left.cracks.map((c) => c.id)).toEqual([2]);
    const right = new CarDamage(hull, glassGeom);
    right.apply(wallHit(12, [-hull.hw, 0.6, -0.5], [1, 0, 0]));
    expect(right.cracks.map((c) => c.id)).toEqual([3]);
    const rear = new CarDamage(hull, glassGeom);
    rear.apply(carHit(12));
    expect(rear.cracks.map((c) => c.id)).toEqual([1]);
  });

  it('widens the star with the hit, and never beyond the cap', () => {
    let prev = 0;
    for (const s of [8, 10, 14, 20, 30, 56, 300]) {
      const r = crackRadius(s);
      expect(r).toBeGreaterThanOrEqual(prev);
      expect(r).toBeLessThanOrEqual(DAMAGE_TUNING.glassRadiusMax);
      prev = r;
    }
    expect(crackRadius(8)).toBeGreaterThan(0.1);
    expect(crackRadius(8)).toBeLessThan(0.2);
    expect(crackRadius(56)).toBeGreaterThan(0.38);
  });

  it('grows the star a second hit lands in instead of adding another, and keeps at most MAX_CRACKS', () => {
    const d = new CarDamage(hull, glassGeom);
    d.apply(headOn(10));
    const r0 = d.cracks[0].r;
    d.apply(headOn(10));
    expect(d.cracks.length).toBe(1);
    expect(d.cracks[0].r).toBeGreaterThan(r0);
    expect(d.cracks[0].r).toBeLessThanOrEqual(DAMAGE_TUNING.glassRadiusMax);
    // far apart on the same window, and on the other windows: separate stars, up to the table
    d.apply(headOn(10, 2));
    expect(d.cracks.length).toBe(2);
    d.apply(carHit(11));
    d.apply(wallHit(11, [hull.hw, 0.6, -0.5], [-1, 0, 0]));
    expect(d.cracks.length).toBe(MAX_CRACKS);
    // the table is full: a harder hit on another window pushes out the smallest star, a lighter one does not get in
    const smallest = Math.min(...d.cracks.map((c) => c.r));
    d.apply(wallHit(9, [-hull.hw, 0.6, -0.5], [1, 0, 0]));
    expect(d.cracks.length).toBe(MAX_CRACKS);
    expect(d.cracks.some((c) => c.id === 3)).toBe(false);
    d.apply(wallHit(30, [-hull.hw, 0.6, -0.5], [1, 0, 0]));
    expect(d.cracks.length).toBe(MAX_CRACKS);
    expect(d.cracks.some((c) => c.id === 3)).toBe(true);
    expect(Math.min(...d.cracks.map((c) => c.r))).toBeGreaterThanOrEqual(smallest);
    for (const c of d.cracks) expect(c.r).toBeLessThanOrEqual(DAMAGE_TUNING.glassRadiusMax);
  });

  it('is part of pristine, goes with reset, and rebuilds the same on a replay', () => {
    const list: StampedEvent[] = [headOn(12), wallHit(11, [hull.hw, 0.6, -0.5], [-1, 0, 0]), carHit(14)].map((e, i) => ({ f: i * 10 + 2.5, e }));
    const live = new CarDamage(hull, glassGeom);
    for (const x of list) live.apply(x.e);
    expect(live.pristine).toBe(false);
    const re = new CarDamage(hull, glassGeom);
    re.syncTo(list, 1000);
    expect(JSON.stringify(re.cracks)).toBe(JSON.stringify(live.cracks));
    re.syncTo(list, 13);
    expect(re.cracks.length).toBe(2);
    re.syncTo(list, 1);
    expect(re.cracks.length).toBe(0);
    live.reset();
    expect(live.cracks.length).toBe(0);
    expect(live.pristine).toBe(true);
    // a body without windows never cracks
    const bare = new CarDamage(hull, geom);
    bare.apply(headOn(30));
    expect(bare.cracks.length).toBe(0);
  });
});

describe('reset and replay', () => {
  const events = (n: number): DamageEvent[] => {
    const out: DamageEvent[] = [];
    for (let i = 0; i < n; i++) {
      const r = hash01(i, 7);
      if (r < 0.25) out.push({ type: 'rub', kind: 'wall', p: [hull.hw, 0.6, 1 - hash01(i, 8) * 2], n: [-1, 0, 0], amount: 0.5 + hash01(i, 9), slide: [0, 0, 30] });
      else if (r < 0.6) out.push(carHit(2 + hash01(i, 10) * 12, [(hash01(i, 11) * 2 - 1) * hull.hw, 0.7, hull.rear], [0, 0, 1], hash01(i, 12) < 0.5 ? 0xcc2222 : undefined));
      else out.push(wallHit(2 + hash01(i, 13) * 30, [hull.hw * (hash01(i, 14) < 0.5 ? 1 : -1), 0.6, hash01(i, 15) * 4 - 2], [hash01(i, 14) < 0.5 ? -1 : 1, 0, 0]));
    }
    return out;
  };
  const stamp = (es: DamageEvent[]): StampedEvent[] => es.map((e, i) => ({ f: i * 12 + 3.5, e }));
  const snap = (d: CarDamage): string => JSON.stringify({ dents: d.dents, marks: d.marks, lamps: d.lamps, zones: d.zones });

  it('reset makes the car pristine again, whatever happened to it', () => {
    const d = new CarDamage(hull, geom);
    for (const e of events(30)) d.apply(e);
    expect(d.pristine).toBe(false);
    const v = d.version;
    d.reset();
    expect(d.pristine).toBe(true);
    expect(d.dents.length + d.marks.length).toBe(0);
    expect(d.severity).toBe(0);
    expect(d.version).toBeGreaterThan(v);
    expect(snap(d)).toBe(snap(new CarDamage(hull, geom)));
  });

  it('is a deterministic fold: the same events always make the same damage', () => {
    const a = new CarDamage(hull, geom);
    const b = new CarDamage(hull, geom);
    for (const e of events(40)) {
      a.apply(e);
      b.apply(e);
    }
    expect(snap(a)).toBe(snap(b));
  });

  it('shows the damage of the moment on a replay: forward, back, seeking and looping', () => {
    const list = stamp(events(40));
    const replay = new CarDamage(hull, geom);
    const at = (f: number): string => {
      const fresh = new CarDamage(hull, geom);
      for (const s of list) if (s.f <= f) fresh.apply(s.e);
      return snap(fresh);
    };
    // play forward frame by frame
    for (let f = 0; f <= 500; f += 7) {
      replay.syncTo(list, f);
      expect(snap(replay)).toBe(at(f));
    }
    // seek back and forward
    for (const f of [120, 30, 480, 0, 250, 251, 249, 500, 3]) {
      replay.syncTo(list, f);
      expect(snap(replay)).toBe(at(f));
    }
    // the loop at the end of a replay starts from a pristine car
    replay.syncTo(list, 0);
    expect(replay.pristine).toBe(true);
    expect(countUpTo(list, 3.4)).toBe(0);
    expect(countUpTo(list, 3.5)).toBe(1);
    expect(countUpTo(list, 1e9)).toBe(list.length);
  });

  it('switches cleanly to another timeline', () => {
    const a = stamp(events(10));
    const b = stamp(events(25));
    const d = new CarDamage(hull, geom);
    d.syncTo(a, 1000);
    d.syncTo(b, 60);
    const fresh = new CarDamage(hull, geom);
    for (const s of b) if (s.f <= 60) fresh.apply(s.e);
    expect(snap(d)).toBe(snap(fresh));
  });

  it('looks the same on every car, and only what the hits cost it differs: the fold is the car-less one, the profile says what it means', () => {
    const list = stamp(events(40));
    const everything = new CarDamage(hull, geom);
    const cars = CARS.map((def) => ({ def, d: new CarDamage(hull, geom, mechanicalProfile(def)) }));
    for (const s of list) {
      everything.apply(s.e);
      for (const c of cars) c.d.apply(s.e);
    }
    const energies = (d: CarDamage): number[] => [d.mech.front, d.mech.rear, ...d.mech.wheel];
    for (const { def, d } of cars) {
      // dents, marks, lamps, glass and the severity of the zones are the same for every car; so is the energy each part took
      expect(snap(d), def.id).toBe(snap(everything));
      expect(energies(d), def.id).toEqual(energies(everything));
      // what it comes to is not: the aero of a car that has none stays a one, however much the nose and the tail took
      const e = mechanicalEffects(d.mech);
      const P = mechanicalProfile(def);
      expect(e.aeroFront === 1, def.id).toBe(!P.frontAero);
      expect(e.aeroRear === 1, def.id).toBe(!P.rearAero);
      expect(e.toe, def.id).toEqual(mechanicalEffects(everything.mech).toe);
    }
    expect(mechanicalEffects(everything.mech).aeroFront).toBeLessThan(0.7);
  });

  it('keeps what the car can lose through a reset, a replay and the next crash', () => {
    const profile = mechanicalProfile(getCar('mammoth'));
    const d = new CarDamage(hull, geom, profile);
    expect(d.mech.profile).toBe(profile);
    for (const e of events(20)) d.apply(e);
    d.reset();
    expect(d.mech.profile).toBe(profile);
    d.syncTo(stamp(events(20)), 100);
    expect(d.mech.profile).toBe(profile);
    d.syncTo(stamp(events(5)), 0);
    expect(d.mech.profile).toBe(profile);
    expect(mechanicalEffects(d.mech).aeroFront).toBe(1);
    // and a car given none is a car that has everything
    expect(new CarDamage(hull, geom).mech.profile).toBe(FULL_CAR);
  });
});

// ── from VehicleState ───────────────────────────────────────────────────────

function fakeState(def = getCar('vanta-gt')): VehicleState {
  const v = def.visual;
  const w = () => ({
    hub: new Vector3(), contactPoint: new Vector3(), contactNormal: new Vector3(0, 1, 0), steerAngle: 0, spin: 0, omega: 0, radius: 0.34, width: 0.25, compression: 0.3,
    suspensionVelocity: 0, contact: true, surface: 'asphalt', load: 3000, slipRatio: 0, slipAngle: 0, forceLong: 0, forceLat: 0, skid: 0, tempC: 80, brakeTempC: 100,
  });
  return {
    id: 0,
    position: new Vector3(0, v.cgHeight, v.cgToFrontAxle - v.wheelbase / 2),
    quaternion: new Quaternion(),
    velocity: new Vector3(0, 0, 30),
    angularVelocity: new Vector3(),
    speed: 30,
    forwardSpeed: 30,
    localAccel: new Vector3(),
    steer: 0, throttle: 0, brake: 0, handbrake: 0, clutch: 0, rpm: 3000, idleRpm: 900, redlineRpm: 7800, limiterRpm: 8000, gear: 3, gearCount: 6,
    engineLoad: 0, boost: 0, revLimiter: false, absActive: false, tcsActive: false, escActive: false, shiftCount: 0, backfireCount: 0,
    impactCount: 0,
    lastImpact: { strength: 0, point: new Vector3(), normal: new Vector3(0, 1, 0), kind: 'wall' },
    scrape: 0,
    scrapePoint: new Vector3(),
    wheels: [w(), w(), w(), w()],
    airborne: false,
  } as unknown as VehicleState;
}

describe('ImpactObserver', () => {
  const def = getCar('vanta-gt');
  const h = hullOf(def.visual);
  /** world point of a body-frame point for a car at rest at the origin (the state's position is the centre of mass) */
  const world = (b: V3): Vector3 => new Vector3(b[0], b[1] - h.cgH, b[2] - h.cgZ).add(new Vector3(0, h.cgH, h.cgZ));

  it('says nothing about impacts that happened before it started watching', () => {
    const st = fakeState();
    st.impactCount = 5;
    const out: DamageEvent[] = [];
    const o = new ImpactObserver(h);
    o.update(st, 1 / 60, (e) => out.push(e));
    o.update(st, 1 / 60, (e) => out.push(e));
    expect(out.length).toBe(0);
  });

  it('turns a new impactCount into a hit on the corner of the hull the barrier touched', () => {
    const st = fakeState();
    const o = new ImpactObserver(h);
    const out: DamageEvent[] = [];
    o.update(st, 1 / 60, (e) => out.push(e));
    // the physics says: front-left top corner, barrier on the left, nose angled into it
    st.impactCount = 1;
    st.lastImpact.kind = 'wall';
    st.lastImpact.strength = 14;
    st.lastImpact.point.copy(world([h.hw, h.top, h.front]));
    st.lastImpact.normal.set(-0.9, 0, -0.43);
    o.update(st, 1 / 60, (e) => out.push(e));
    expect(out.length).toBe(1);
    const e = out[0] as HitEvent;
    expect(e.type).toBe('hit');
    expect(e.kind).toBe('wall');
    expect(e.strength).toBe(14);
    expect(e.p[0]).toBeCloseTo(h.hw, 5);
    expect(e.p[2]).toBeCloseTo(h.front, 5);
    expect(e.n[0]).toBeLessThan(-0.8);
    // the car was moving forward along the barrier: the slide is mostly along z
    expect(Math.abs(e.slide[2])).toBeGreaterThan(20);
  });

  it('puts a contact read a frame late back on the corner the car was touching', () => {
    const st = fakeState();
    const o = new ImpactObserver(h);
    const out: DamageEvent[] = [];
    o.update(st, 1 / 60, () => undefined);
    // the car was at z = 0 last frame, touched the wall with its nose, and has slid 0.9 m along since
    const hitWorld = world([h.hw, h.top, h.front]);
    st.position.z += 0.9;
    st.impactCount = 1;
    st.lastImpact.kind = 'wall';
    st.lastImpact.strength = 3;
    st.lastImpact.point.copy(hitWorld);
    st.lastImpact.normal.set(-1, 0, -0.05);
    o.update(st, 1 / 60, (e) => out.push(e));
    const e = out[0] as HitEvent;
    expect(e.p[2]).toBeCloseTo(h.front, 5);
  });

  it('reads the other car\'s paint at a car-to-car contact and ignores the ground', () => {
    const st = fakeState();
    const o = new ImpactObserver(h);
    const out: DamageEvent[] = [];
    o.otherAt = () => ({ paint: 0x118833, vx: 0, vy: 0, vz: 0 });
    o.update(st, 1 / 60, () => undefined);
    st.impactCount = 1;
    st.lastImpact.kind = 'car';
    st.lastImpact.strength = 4;
    st.lastImpact.point.copy(world([0.9, 0.7, h.rear]));
    st.lastImpact.normal.set(0, 0, 1);
    o.update(st, 1 / 60, (e) => out.push(e));
    expect((out[0] as HitEvent).paint).toBe(0x118833);
    expect((out[0] as HitEvent).kind).toBe('car');
    st.impactCount = 2;
    st.lastImpact.kind = 'ground';
    st.lastImpact.strength = 9;
    o.update(st, 1 / 60, (e) => out.push(e));
    expect(out.length).toBe(1);
  });

  it('turns a long scrape along a barrier into rub events and nothing for the underbody', () => {
    const st = fakeState();
    const o = new ImpactObserver(h);
    const out: DamageEvent[] = [];
    o.update(st, 1 / 60, () => undefined);
    st.velocity.set(0, 0, 40);
    st.speed = 40;
    st.scrape = 0.8;
    for (let i = 0; i < 90; i++) {
      st.position.z += 40 / 60;
      st.scrapePoint.copy(world([h.hw, h.top, h.front])).add(new Vector3(0, 0, 40 / 60 * (i + 1)));
      o.update(st, 1 / 60, (e) => out.push(e));
    }
    st.scrape = 0;
    o.update(st, 1 / 60, (e) => out.push(e));
    expect(out.length).toBeGreaterThan(2);
    for (const e of out) {
      expect(e.type).toBe('rub');
      expect(e.p[0]).toBeGreaterThan(h.hw - 0.1);
    }
    // an underbody scrape (skid plank) is not on a side of the box
    const o2 = new ImpactObserver(h);
    const out2: DamageEvent[] = [];
    const st2 = fakeState();
    o2.update(st2, 1 / 60, () => undefined);
    st2.scrape = 1;
    st2.scrapePoint.copy(world([0.2, h.bottom, 0]));
    for (let i = 0; i < 40; i++) o2.update(st2, 1 / 60, (e) => out2.push(e));
    expect(out2.length).toBe(0);
  });
});

describe('hull helpers', () => {
  it('matches the collision box in src/cars: 8 corners, 4 midpoints, and the box surface is distance 0', () => {
    for (const def of CARS) {
      const h2 = hullOf(def.visual);
      const cands = hullCandidates(h2);
      expect(cands.length).toBe(12);
      for (const c of cands) expect(hullSurfaceDistance(c, h2)).toBeLessThan(1e-9);
      expect(hullSurfaceDistance([0, (h2.top + h2.bottom) / 2, 0], h2)).toBeGreaterThan(0.3);
      expect(hullSurfaceDistance([h2.hw + 0.3, (h2.top + h2.bottom) / 2, 0], h2)).toBeCloseTo(0.3, 6);
      // the physics' own numbers
      const half = def.physics.chassis.hullHalf;
      expect(h2.hw).toBeCloseTo(half.x, 9);
      expect((h2.front - h2.rear) / 2).toBeCloseTo(half.z, 9);
      expect((h2.top - h2.bottom) / 2).toBeCloseTo(half.y, 9);
    }
  });
});

describe('settings', () => {
  it('defaults to visual damage and merges that default into an old save', () => {
    expect(DEFAULT_SETTINGS.damage).toBe('visual');
    const store: Record<string, string> = { 'xeno-racer.settings.v1': JSON.stringify({ units: 'mph', audio: { master: 0.3 } }) };
    const g = globalThis as { localStorage?: unknown };
    const prev = g.localStorage;
    g.localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
    try {
      const s = loadSettings();
      expect(s.units).toBe('mph');
      expect(s.damage).toBe('visual');
      store['xeno-racer.settings.v1'] = JSON.stringify({ damage: 'off' });
      expect(loadSettings().damage).toBe('off');
      // (Full has been a mode since the mechanical damage came: a word nobody knows still falls back)
      store['xeno-racer.settings.v1'] = JSON.stringify({ damage: 'full' });
      expect(loadSettings().damage).toBe('full');
      store['xeno-racer.settings.v1'] = JSON.stringify({ damage: 'brutal' });
      expect(loadSettings().damage).toBe('visual');
      store['xeno-racer.settings.v1'] = JSON.stringify({ damage: 3 });
      expect(loadSettings().damage).toBe('visual');
    } finally {
      g.localStorage = prev;
    }
  });
});
