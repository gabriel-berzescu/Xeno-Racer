/**
 * The racing slick (TireSpec.slick, the LMP-X's tyres), held to the promises made for it:
 *   - it is a trait of the tyre with a table of surfaces of its own (src/physics/surfaces.ts, SLICK_LOSS): on grass, dirt, gravel, sand and
 *     deep snow it keeps a good deal less grip than a road tyre, far less on wet turf and dirt, and digs into gravel and sand; paved ground,
 *     packed snow and ice are the same for every tyre. It is the other end of the scale from the all-terrain tyre (TireSpec.offroad);
 *   - on asphalt, kerbs and concrete the LMP-X drives exactly as it did: not a bit differs from the same car without the trait;
 *   - on loose ground it is clearly under the three road cars at 60 and at 120 km/h, in lateral g and in the stop, dry and wet, and the
 *     Mammoth's all-terrain tyres are over them: Mammoth > road cars > LMP-X;
 *   - the studded winter tyre replaces it (Isvik is unchanged for every car), the AI reads its table, and it laps the circuits cleanly.
 * Run: npx vitest run tests/slicks.test.ts   (tests/probes/slick-probe.test.ts prints the full table)
 */
import { describe, expect, it } from 'vitest';
import { carLineGrip, computeRacingLine, ProfileJob } from '../src/ai';
import { CARS, getCar } from '../src/cars';
import type { CarDefinition, GroundSample, SurfaceType, TrackRuntime } from '../src/core/contracts';
import { PhysicsWorld, createFlatTrack, fitCar, winterTire } from '../src/physics';
import { SURFACES, carSurfaces, tireSurfaces, treadOf } from '../src/physics/surfaces';
import { loadTrackRuntime, TRACKS } from '../src/track';
import { runPack } from './probes/pack-race';
import { aiLap, brakeRun, dragRun, freeRoll, gripAtSpeed, launch, skidpad } from './probes/car-metrics';

const lmp = getCar('lmp-x');
const mammoth = getCar('mammoth');
const roadCars = ['vanta-gt', 'kestrel-r', 'ronin-86'].map(getCar);
const LOOSE: SurfaceType[] = ['grass', 'dirt', 'gravel', 'sand', 'deepsnow'];
const NOT_LOOSE: SurfaceType[] = ['asphalt', 'curb', 'concrete', 'snow', 'ice'];

/** The LMP-X with the trait taken off: its own `mu` and everything else the same, on the ground rules of a road tyre. */
const withoutSlick: CarDefinition = (() => {
  const d = structuredClone(lmp);
  delete d.physics.tireFront.slick;
  delete d.physics.tireRear.slick;
  return d;
})();

describe('the racing slick is a trait of the tyre', () => {
  it('is on the LMP-X, front and rear, and on no other car', () => {
    expect(lmp.physics.tireFront.slick).toBe(1);
    expect(lmp.physics.tireRear.slick).toBe(1);
    for (const c of CARS.filter((c) => c.id !== 'lmp-x')) {
      expect(c.physics.tireFront.slick, c.id).toBeUndefined();
      expect(c.physics.tireRear.slick, c.id).toBeUndefined();
    }
    // (and the all-terrain tyre is the Mammoth's alone: the two kinds are two cars)
    expect(CARS.filter((c) => c.physics.tireFront.offroad).map((c) => c.id)).toEqual(['mammoth']);
    // the slick is still the stickiest tyre of the five
    for (const c of CARS.filter((c) => c.id !== 'lmp-x')) expect(lmp.physics.tireFront.mu).toBeGreaterThan(c.physics.tireFront.mu * 1.4);
  });

  it('is a table of surfaces of its own that makes loose ground worse and leaves the rest alone', () => {
    expect(tireSurfaces({ slick: 0 })).toBe(SURFACES);
    expect(tireSurfaces({ slick: undefined })).toBe(SURFACES);
    const slick = tireSurfaces({ slick: 1 });
    expect(slick).not.toBe(SURFACES);
    // shared by every tyre of the same kind (nothing is allocated in the substep)
    expect(tireSurfaces({ slick: 1 })).toBe(slick);
    expect(tireSurfaces(lmp.physics.tireFront)).toBe(slick);
    expect(tireSurfaces(lmp.physics.tireRear)).toBe(slick);
    // ground that is not loose: the same numbers (the same objects)
    for (const s of NOT_LOOSE) expect(slick[s], s).toBe(SURFACES[s]);
    for (const s of LOOSE) {
      // under 0.6 of the grip of a road tyre, but not nothing
      expect(slick[s].grip, s).toBeLessThan(SURFACES[s].grip * 0.6);
      expect(slick[s].grip, s).toBeGreaterThan(SURFACES[s].grip * 0.25);
      // a wide smooth tyre digs in: more rolling and ploughing drag
      expect(slick[s].rolling, s).toBeGreaterThan(SURFACES[s].rolling);
      expect(slick[s].plough, s).toBeGreaterThan(SURFACES[s].plough);
      expect(slick[s].paved, s).toBe(SURFACES[s].paved);
      expect(slick[s].fresh, s).toBe(SURFACES[s].fresh);
    }
    // wet turf and wet dirt are far worse for a smooth tyre; gravel and sand drain, so there the water is the tyre's business
    expect(slick.grass.wet).toBeLessThan(SURFACES.grass.wet * 0.8);
    expect(slick.dirt.wet).toBeLessThan(SURFACES.dirt.wet * 0.8);
    expect(slick.gravel.wet).toBe(SURFACES.gravel.wet);
    expect(slick.sand.wet).toBe(SURFACES.sand.wet);
    // the digging in is for gravel and sand, where the drag is heavy; turf and dirt get a little
    for (const s of ['rolling', 'plough'] as const) {
      expect(slick.gravel[s] / SURFACES.gravel[s], s).toBeGreaterThan(slick.grass[s] / SURFACES.grass[s] + 0.04);
      expect(slick.sand[s] / SURFACES.sand[s], s).toBeGreaterThan(slick.grass[s] / SURFACES.grass[s] + 0.04);
    }
    // half a slick is half-way
    const half = tireSurfaces({ slick: 0.5 });
    for (const s of LOOSE) {
      expect(half[s].grip, s).toBeLessThan(SURFACES[s].grip);
      expect(half[s].grip, s).toBeGreaterThan(slick[s].grip);
      expect(half[s].plough, s).toBeLessThan(slick[s].plough);
    }
    for (const s of NOT_LOOSE) expect(half[s], s).toBe(SURFACES[s]);
  });

  it('is the other end of the scale from the all-terrain tyre: slick < road tyre < all-terrain on every loose surface', () => {
    const slick = tireSurfaces({ slick: 1 });
    const road = SURFACES;
    const terrain = tireSurfaces({ offroad: 1 });
    for (const s of LOOSE) {
      expect(slick[s].grip, s).toBeLessThan(road[s].grip);
      expect(road[s].grip, s).toBeLessThan(terrain[s].grip);
      expect(slick[s].rolling, s).toBeGreaterThan(road[s].rolling);
      expect(road[s].rolling, s).toBeGreaterThan(terrain[s].rolling);
      expect(slick[s].plough, s).toBeGreaterThan(road[s].plough);
      expect(road[s].plough, s).toBeGreaterThan(terrain[s].plough);
    }
    expect(slick.grass.wet).toBeLessThan(road.grass.wet);
    expect(road.grass.wet).toBeLessThan(terrain.grass.wet);
    // one scale: -1 a slick, 0 a road tyre, +1 an all-terrain tyre, and a tyre with both traits is a road tyre again
    expect(treadOf({})).toBe(0);
    expect(treadOf({ slick: 1 })).toBe(-1);
    expect(treadOf({ offroad: 1 })).toBe(1);
    expect(treadOf({ offroad: 0.25 })).toBe(0.25);
    expect(treadOf({ offroad: 1, slick: 1 })).toBe(0);
    expect(tireSurfaces({ offroad: 1, slick: 1 })).toBe(SURFACES);
    expect(tireSurfaces({ offroad: 1, slick: 0 })).toBe(terrain);
    // (a trait out of range counts as the nearest end of it)
    expect(tireSurfaces({ slick: 7 })).toBe(slick);
    expect(tireSurfaces({ slick: -3 })).toBe(SURFACES);
  });

  it('gives a car the table of the worse of its two axles', () => {
    const slick = tireSurfaces({ slick: 1 });
    expect(carSurfaces(lmp.physics)).toBe(slick);
    expect(carSurfaces({ tireFront: { slick: 1 }, tireRear: {} })).toBe(slick);
    expect(carSurfaces({ tireFront: {}, tireRear: { slick: 1 } })).toBe(slick);
    expect(carSurfaces({ tireFront: { slick: 1 }, tireRear: { offroad: 1 } })).toBe(slick);
    expect(carSurfaces({ tireFront: {}, tireRear: {} })).toBe(SURFACES);
    for (const c of roadCars) expect(carSurfaces(c.physics), c.id).toBe(SURFACES);
    // (the Mammoth's table is what it was)
    expect(carSurfaces(mammoth.physics)).toBe(tireSurfaces({ offroad: 1 }));
  });
});

describe('on asphalt, kerbs and concrete the LMP-X is what it was', () => {
  it('corners, brakes and holds speed to the bit, dry and wet, as the same car without the trait', () => {
    for (const surface of ['asphalt', 'curb', 'concrete'] as const) {
      for (const wetness of [0, 0.75]) {
        const ground = { surface, wetness };
        expect(skidpad(lmp, 60, ground).latG, `${surface} wet ${wetness} skidpad`).toBe(skidpad(withoutSlick, 60, ground).latG);
        expect(brakeRun(lmp, true, ground, 120).distance, `${surface} wet ${wetness} stop`).toBe(brakeRun(withoutSlick, true, ground, 120).distance);
        expect(gripAtSpeed(lmp, 120, ground).latG, `${surface} wet ${wetness} at 120`).toBe(gripAtSpeed(withoutSlick, 120, ground).latG);
      }
    }
    expect(dragRun(lmp, 20).t100).toBe(dragRun(withoutSlick, 20).t100);
  });

  it('is still the king of the asphalt: far more grip than any other car at 60 and at 120 km/h, dry and wet', () => {
    for (const wetness of [0, 0.75]) {
      for (const kmh of [60, 120]) {
        const mine = gripAtSpeed(lmp, kmh, { wetness }).latG;
        for (const c of CARS.filter((c) => c.id !== 'lmp-x')) expect(mine, `${c.id} at ${kmh} wet ${wetness}`).toBeGreaterThan(gripAtSpeed(c, kmh, { wetness }).latG * 1.35);
      }
    }
  });
});

describe('the studded winter tyre replaces the slick', () => {
  const winter = createFlatTrack({ winter: true });

  it('drops the trait, and the Mammoth keeps its own', () => {
    const fitted = fitCar(lmp, winter);
    expect(fitted).not.toBe(lmp);
    for (const t of [fitted.physics.tireFront, fitted.physics.tireRear]) {
      expect(t.slick).toBeUndefined();
      expect('slick' in t).toBe(false);
      // a tyre like any other car's studded tyre: its table is the plain one
      expect(tireSurfaces(t)).toBe(SURFACES);
    }
    expect(carSurfaces(fitted.physics)).toBe(SURFACES);
    // the very same studded tyre as the same car without the trait is fitted with
    expect(fitted.physics.tireFront).toEqual(fitCar(withoutSlick, winter).physics.tireFront);
    expect(fitted.physics.tireRear).toEqual(fitCar(withoutSlick, winter).physics.tireRear);
    expect(winterTire(lmp.physics.tireFront)).toEqual(winterTire(withoutSlick.physics.tireFront));
    // the original is not touched, and a road circuit gets the car itself
    expect(lmp.physics.tireFront.slick).toBe(1);
    expect(fitCar(lmp, createFlatTrack())).toBe(lmp);
    expect(fitCar(mammoth, winter).physics.tireFront.offroad).toBe(1);
  });

  it('leaves Isvik unchanged for the LMP-X: snow, ice and deep snow to the bit', () => {
    for (const [surface, R] of [['snow', 40], ['ice', 40], ['deepsnow', 40]] as const) {
      expect(skidpad(lmp, R, { surface }).latG, `${surface} skidpad`).toBe(skidpad(withoutSlick, R, { surface }).latG);
      expect(brakeRun(lmp, true, { surface }, 80).distance, `${surface} stop`).toBe(brakeRun(withoutSlick, true, { surface }, 80).distance);
      expect(launch(lmp, { surface }, 50), `${surface} launch`).toBe(launch(withoutSlick, { surface }, 50));
    }
    // (a lap of Isvik: the speed profile, the driver and the car, all on the studded tyre)
    const a = aiLap('isvik', lmp);
    const b = aiLap('isvik', withoutSlick);
    expect(a.lap).toBe(b.lap);
    expect(a.resets).toBe(0);
  }, 300000);
});

describe('on loose ground the slick keeps much less', () => {
  // [surface, water, speeds]: the speeds a car can hold on the ground (sand and gravel bog a road car down well below 120 km/h)
  const grounds: [SurfaceType, number, number[]][] = [
    ['grass', 0, [60, 120]],
    ['grass', 0.75, [60, 120]],
    ['dirt', 0, [60, 120]],
    ['dirt', 0.75, [60, 120]],
    ['gravel', 0, [60, 120]],
    ['gravel', 0.75, [60, 120]],
    ['sand', 0, [40]],
    ['sand', 0.75, [40]],
  ];

  it('holds clearly less lateral g than the three road cars, and the Mammoth more than any of them', () => {
    for (const [surface, wetness, speeds] of grounds) {
      for (const kmh of speeds) {
        const g = (c: CarDefinition) => gripAtSpeed(c, kmh, { surface, wetness }).latG;
        const road = roadCars.map(g);
        const mine = g(lmp);
        const label = `${surface} wet ${wetness} at ${kmh} km/h: LMP-X ${mine.toFixed(3)}, road cars ${road.map((x) => x.toFixed(3)).join(' ')}`;
        // (it corners on turf, dirt and gravel; in sand it is bogged down, with nothing to corner with: sand is a trap for a road car too)
        if (surface !== 'sand') expect(mine, label).toBeGreaterThan(0.05);
        // (a tenth under the weakest of them at the very least, where its downforce does the most for it)
        expect(mine, label).toBeLessThan(0.9 * Math.min(...road));
        expect(g(mammoth), label).toBeGreaterThan(Math.max(...road));
        // and a long way under what it held without the trait
        expect(mine, label).toBeLessThan(0.7 * g(withoutSlick));
      }
    }
  });

  it('stops clearly later than the three road cars from 60 and from 120 km/h, with the Mammoth stopping sooner than any', () => {
    for (const [surface, wetness] of grounds) {
      for (const kmh of [60, 120]) {
        const d = (c: CarDefinition) => brakeRun(c, true, { surface, wetness }, kmh).distance;
        const road = roadCars.map(d);
        const mine = d(lmp);
        const label = `${surface} wet ${wetness} from ${kmh} km/h: LMP-X ${mine.toFixed(1)} m, road cars ${road.map((x) => x.toFixed(1)).join(' ')}`;
        expect(mine, label).toBeGreaterThan(1.1 * Math.max(...road));
        expect(d(mammoth), label).toBeLessThan(Math.min(...road));
      }
    }
  });

  it('is far worse on wet turf and wet dirt than on dry: it keeps under half of its dry grip there, where a road tyre keeps more than half', () => {
    for (const surface of ['grass', 'dirt'] as const) {
      const mine = gripAtSpeed(lmp, 60, { surface, wetness: 0.75 }).latG / gripAtSpeed(lmp, 60, { surface }).latG;
      const vanta = gripAtSpeed(roadCars[0], 60, { surface, wetness: 0.75 }).latG / gripAtSpeed(roadCars[0], 60, { surface }).latG;
      expect(mine, surface).toBeLessThan(0.55);
      expect(vanta, surface).toBeGreaterThan(0.55);
      expect(mine, surface).toBeLessThan(vanta - 0.1);
    }
  });

  it('digs into gravel and sand: it loses more speed rolling through them than the same car without the trait', () => {
    for (const surface of ['gravel', 'sand'] as const) {
      const a = freeRoll(lmp, { surface });
      const b = freeRoll(withoutSlick, { surface });
      expect(a, `${surface}: ${a.toFixed(1)} km/h against ${b.toFixed(1)}`).toBeLessThan(b - 2.5);
    }
    // (turf and dirt take a little more: it shows, but it is not what the slick is about)
    for (const surface of ['grass', 'dirt'] as const) expect(freeRoll(lmp, { surface })).toBeLessThan(freeRoll(withoutSlick, { surface }) + 0.01);
  });

  it('is beached, not stuck: it still gets itself moving on turf, dirt and gravel, if later than the road cars', () => {
    for (const surface of ['grass', 'dirt', 'gravel'] as const) {
      const mine = launch(lmp, { surface }, 20, 'low', 30);
      expect(mine, `${surface} 0-20`).not.toBeNull();
      expect(mine!, `${surface} 0-20`).toBeLessThan(8);
      for (const c of roadCars) expect(mine!, `${surface} 0-20 against ${c.id}`).toBeGreaterThan(launch(c, { surface }, 20, 'low', 30)!);
    }
  });
});

describe('the AI reads the slick’s table', () => {
  it('gives the track’s own grip under the line on the circuits, and its own where the ground under the line is loose', () => {
    // the racing line of every circuit stays on the road: asphalt, or packed snow and ice. The slick changes none of that, so the profile of an
    // LMP-X with slicks and without are the same, bit for bit, dry and wet
    for (const trackId of TRACKS.map((t) => t.info.id)) {
      const track = loadTrackRuntime(trackId);
      const line = computeRacingLine(track, { edgeMargin: lmp.visual.width / 2 - 0.25 + (track.info.winter ? 0.45 : 0) });
      for (const wetness of [0, 0.75]) {
        const opts = { gripUse: 0.9, brakeUse: 0.85, wetness };
        const own = new ProfileJob(track, line, lmp, opts);
        const plain = new ProfileJob(track, line, withoutSlick, opts);
        own.finish();
        plain.finish();
        expect(Array.from(own.surfaceFactor), `${trackId} wet ${wetness}: grip under the line`).toEqual(Array.from(plain.surfaceFactor));
        expect(Array.from(own.speeds), `${trackId} wet ${wetness}: speeds`).toEqual(Array.from(plain.speeds));
      }
    }
    // a line over gravel, grass and a bit of asphalt: the grip of each, for each kind of tyre
    const surf = { at: Uint8Array.from([0, 1, 2, 1, 0]), names: ['asphalt', 'gravel', 'grass'] as SurfaceType[], props: [], grip: Float32Array.from([1, SURFACES.gravel.grip, SURFACES.grass.grip, SURFACES.gravel.grip, 1]) };
    expect(carLineGrip(surf, getCar('vanta-gt').physics)).toBe(surf.grip);
    const own = carLineGrip(surf, lmp.physics);
    expect(own[0]).toBe(1);
    expect(own[1]).toBeCloseTo(tireSurfaces({ slick: 1 }).gravel.grip, 6);
    expect(own[2]).toBeCloseTo(tireSurfaces({ slick: 1 }).grass.grip, 6);
    expect(own[1]).toBeLessThan(surf.grip[1] * 0.6);
    expect(own[2]).toBeLessThan(surf.grip[2] * 0.6);
    expect(own[3]).toBe(own[1]);
    expect(own[4]).toBe(1);
    // (the Mammoth and the slick are on opposite sides of the road tyre)
    expect(carLineGrip(surf, mammoth.physics)[1]).toBeGreaterThan(surf.grip[1]);
  });

  it('slows the speed profile where the line crosses gravel, and only there', () => {
    const base = loadTrackRuntime('aurelia');
    const line = computeRacingLine(base, { edgeMargin: lmp.visual.width / 2 - 0.25 });
    // a stretch of the line, 120 m of it, laid with gravel (a distinct id keeps the track's caches apart)
    const mid = Math.floor(line.n / 3);
    const cx = line.x[mid];
    const cz = line.z[mid];
    const gravelled: TrackRuntime = Object.create(base, {
      info: { value: { ...base.info, id: 'aurelia-gravel-line' } },
      groundAt: {
        value: (x: number, z: number, out: GroundSample, hint?: number) => {
          const i = base.groundAt(x, z, out, hint);
          if (Math.hypot(x - cx, z - cz) < 60) out.surface = 'gravel';
          return i;
        },
      },
    });
    const opts = { gripUse: 0.9, brakeUse: 0.85 };
    const slick = new ProfileJob(gravelled, line, lmp, opts);
    const plain = new ProfileJob(gravelled, line, withoutSlick, opts);
    const road = new ProfileJob(base, line, lmp, opts);
    slick.finish();
    plain.finish();
    road.finish();
    // under the gravel, the slick's grip under the line is the slick's, against the road tyre's
    expect(slick.surfaceFactor[mid]).toBeCloseTo(tireSurfaces({ slick: 1 }).gravel.grip, 5);
    expect(plain.surfaceFactor[mid]).toBeCloseTo(SURFACES.gravel.grip, 5);
    expect(slick.surfaceFactor[0]).toBe(1);
    // the corner speed on the gravel is a good deal lower for the slick than for the same car without the trait, and than on the road
    expect(slick.speeds[mid]).toBeLessThan(0.85 * plain.speeds[mid]);
    expect(slick.speeds[mid]).toBeLessThan(road.speeds[mid]);
    // far from the gravel, the two profiles are the road's own
    const far = (mid + Math.floor(line.n / 2)) % line.n;
    expect(slick.speeds[far]).toBe(road.speeds[far]);
  });
});

describe('the LMP-X on a lap', () => {
  // The AI drivers' laps (alien, standing start): the table of the slick acts only where a wheel is off the paved ground, and the AI keeps to
  // the road. tests/ai.test.ts has every car on every circuit, dry and in a storm, held to two clean laps; here the slick against itself.
  it('laps Aurelia and Kuroyama (the one with a dirt and grass shoulder close to the road) cleanly, within a percent of the same car without the trait', () => {
    for (const trackId of ['aurelia', 'kuroyama']) {
      const a = aiLap(trackId, lmp);
      const b = aiLap(trackId, withoutSlick);
      expect(a.resets, `${trackId} resets`).toBe(0);
      expect(a.impacts, `${trackId} hits`).toBe(0);
      expect(Math.abs(a.lap / b.lap - 1), `${trackId}: ${a.lap.toFixed(2)} s against ${b.lap.toFixed(2)} s`).toBeLessThan(0.01);
    }
  }, 300000);

  it('races a mixed grid on Kuroyama and on Brennwald, dry, without a wall hit or a reset', () => {
    // (the two circuits where the AI's racing line has the LMP-X's wheels on loose ground the most: Kuroyama has a dirt and grass shoulder close to
    // the guardrail, and at Brennwald the LMP-X of a pack spends a fifth of a lap with a wheel on the grass or the gravel; in 48 races of twelve
    // on Aurelia, Kuroyama and Brennwald, dry and wet, no car hit a wall or needed a reset, with the slicks as without them)
    for (const trackId of ['kuroyama', 'brennwald']) {
      const r = runPack(trackId, 'mixed', 'pro', 12, 1, false, { seed: 0 });
      expect(r.finished, `${trackId} finished`).toBe(12);
      expect(r.walls, `${trackId} wall hits`).toBe(0);
      expect(r.resets, `${trackId} resets`).toBe(0);
      expect(r.offTrack / 12, `${trackId} seconds off the road per car`).toBeLessThan(1);
    }
  }, 900000);
});
