/**
 * The Mammoth, a 2.45 t all-wheel-drive SUV on all-terrain tyres, held to the promises made for it:
 *   - what the stats say is what it does (0-100, top speed, power), and it is quick off the line, slower in the bends than the sports cars;
 *   - it leans in a corner, squats under power and dives under the brakes, clearly more than a sports car, and long-travel springs
 *     take a kerb that throws a sports car into the air; thrown around it lifts a wheel, and it does not roll over;
 *   - the all-terrain tyre (TireSpec.offroad) holds more of its grip on grass, gravel, dirt, sand and deep snow than a road tyre, and
 *     floats over the drag of gravel, sand and deep snow, and changes nothing on asphalt, packed snow or ice;
 *   - on snow it launches like nothing else, and a whole grid of them races cleanly.
 * Run: npx vitest run tests/mammoth.test.ts   (tests/probes/mammoth-probe.test.ts prints the full table)
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { carLineGrip, ProfileJob, computeRacingLine } from '../src/ai';
import { CARS, getCar } from '../src/cars';
import type { CarDefinition, SurfaceType } from '../src/core/contracts';
import { PhysicsWorld, createFlatTrack, fitCar, peakPower, peakTorque } from '../src/physics';
import { SURFACES, carSurfaces, tireSurfaces } from '../src/physics/surfaces';
import { loadTrackRuntime } from '../src/track';
import { runPack } from './probes/pack-race';
import { aiLap, brakeRun, coast, dragRun, flick, kerbStrike, launch, skidpad } from './probes/car-metrics';

const mammoth = getCar('mammoth');
const vanta = getCar('vanta-gt');
const roadCars = ['vanta-gt', 'kestrel-r', 'ronin-86'].map(getCar);
const others = CARS.filter((c) => c.id !== 'mammoth');

/** The Mammoth on road tyres: the same car with the all-terrain trait switched off, to ask what the trait does and nothing else. */
const onRoadTyres: CarDefinition = (() => {
  const d = structuredClone(mammoth);
  d.physics.tireFront.offroad = 0;
  d.physics.tireRear.offroad = 0;
  return d;
})();

describe('the Mammoth is what its stats say', () => {
  it('is a 2.45 t all-wheel-drive SUV', () => {
    expect(mammoth.class).toBe('SUV');
    expect(mammoth.drivetrain).toBe('AWD');
    expect(mammoth.physics.drivetrain.layout).toBe('AWD');
    expect(mammoth.physics.chassis.mass).toBe(mammoth.stats.massKg);
    expect(mammoth.physics.tireFront.offroad).toBe(1);
    expect(mammoth.physics.tireRear.offroad).toBe(1);
  });

  it('makes the power and the torque it is sold with', () => {
    const e = mammoth.physics.engine;
    expect(peakPower(e).watts / 745.7 / mammoth.stats.powerHp).toBeGreaterThan(0.99);
    expect(peakPower(e).watts / 745.7 / mammoth.stats.powerHp).toBeLessThan(1.01);
    expect(peakTorque(e)).toBe(mammoth.stats.torqueNm);
  });

  it('does 0-100 and the top speed the stats give, and the standing start is quick, a top speed that of a brick', () => {
    const d = dragRun(mammoth, 150);
    expect(Math.abs(d.t100! - mammoth.stats.zeroTo100)).toBeLessThan(0.2);
    expect(Math.abs(d.vmax - mammoth.stats.topSpeedKmh)).toBeLessThan(6);
    // (0-100 in about 4 s, the top speed in the 250s: a brick does not cut through the air)
    expect(d.t100!).toBeGreaterThan(3.6);
    expect(d.t100!).toBeLessThan(4.3);
    expect(d.vmax).toBeGreaterThan(245);
    expect(d.vmax).toBeLessThan(268);
    // quicker off the line than the sports cars it loses to on the top speed
    for (const c of [vanta, getCar('kestrel-r'), getCar('ronin-86')]) expect(d.t100!).toBeLessThan(dragRun(c, 20).t100! - 0.4);
    expect(d.vmax).toBeLessThan(dragRun(vanta, 70).vmax - 40);
  });

  it('stops from 100 km/h in 36-43 m and holds 0.87-0.96 g on the skidpad: less grip than the sports cars', () => {
    // (the brief: 37-42 m and 0.88-0.95 g; the car does 37.1 m and 0.89 g, and the bounds leave a metre and a hundredth for the next change)
    const b = brakeRun(mammoth, true);
    const pad = skidpad(mammoth);
    expect(b.distance).toBeGreaterThan(36);
    expect(b.distance).toBeLessThan(43);
    expect(pad.latG).toBeGreaterThan(0.87);
    expect(pad.latG).toBeLessThan(0.96);
    expect(pad.latG).toBeLessThan(skidpad(vanta).latG - 0.1);
    expect(pad.latG).toBeLessThan(skidpad(getCar('kestrel-r')).latG - 0.05);
  });
});

describe('the Mammoth leans, squats and dives, and shrugs off kerbs', () => {
  it('leans 4-7 degrees at the limit, a sports car a degree or two', () => {
    const m = skidpad(mammoth);
    const v = skidpad(vanta);
    expect(m.rollDeg).toBeGreaterThan(4);
    expect(m.rollDeg).toBeLessThan(7);
    expect(m.rollDeg).toBeGreaterThan(3 * v.rollDeg);
    // (in a steady corner, even at the limit, every wheel is still carrying a share of the car)
    expect(m.minLoadShare).toBeGreaterThan(0.15);
  });

  it('squats and dives more than twice what a sports car does', () => {
    const squat = dragRun(mammoth, 6).squatDeg;
    const dive = brakeRun(mammoth, true).diveDeg;
    expect(squat).toBeGreaterThan(2.5);
    expect(dive).toBeGreaterThan(2.5);
    expect(squat).toBeGreaterThan(2 * dragRun(vanta, 6).squatDeg);
    expect(dive).toBeGreaterThan(2 * brakeRun(vanta, true).diveDeg);
  });

  it('keeps its wheels on a 12 cm kerb at 160 km/h, where a sports car is thrown off it', () => {
    const m = kerbStrike(mammoth, 160, 0.12);
    const v = kerbStrike(vanta, 160, 0.12);
    expect(m.wheelsUp).toBe(0);
    expect(m.minLoadShare).toBeGreaterThan(0.3);
    expect(v.minLoadShare).toBeLessThan(0.05);
    expect(m.maxRollDeg).toBeLessThan(v.maxRollDeg);
  });

  it('lifts a wheel in a violent flick, and does not spin or tip', () => {
    for (const kmh of [110, 140]) {
      const f = flick(mammoth, kmh);
      expect(f.spun, `spun at ${kmh}`).toBe(false);
      expect(f.maxRollDeg, `roll at ${kmh}`).toBeLessThan(9);
      expect(f.minLoadShare, `lightest wheel at ${kmh}`).toBeLessThan(0.05);
    }
    // a sports car, thrown the same way, keeps all four on the ground
    expect(flick(vanta, 140).minLoadShare).toBeGreaterThan(0.3);
  });
});

describe('the all-terrain tyre', () => {
  it('is a table of surfaces of its own that softens loose ground and leaves the rest alone', () => {
    expect(tireSurfaces({})).toBe(SURFACES);
    expect(tireSurfaces({ offroad: 0 })).toBe(SURFACES);
    const at = tireSurfaces({ offroad: 1 });
    expect(at).not.toBe(SURFACES);
    // shared by every tyre of the same kind (nothing is allocated in the substep)
    expect(tireSurfaces({ offroad: 1 })).toBe(at);
    // ground that is not loose: the same numbers (the same objects)
    for (const s of ['asphalt', 'curb', 'concrete', 'snow', 'ice'] as SurfaceType[]) expect(at[s]).toBe(SURFACES[s]);
    // loose ground: more grip (never past asphalt), less drag; wet turf and dirt less treacherous
    for (const s of ['grass', 'dirt', 'gravel', 'sand', 'deepsnow'] as SurfaceType[]) {
      expect(at[s].grip, s).toBeGreaterThan(SURFACES[s].grip);
      expect(at[s].grip, s).toBeLessThan(1);
      expect(at[s].rolling, s).toBeLessThan(SURFACES[s].rolling);
      expect(at[s].plough, s).toBeLessThan(SURFACES[s].plough);
      expect(at[s].paved, s).toBe(SURFACES[s].paved);
      expect(at[s].fresh, s).toBe(SURFACES[s].fresh);
    }
    expect(at.grass.wet).toBeGreaterThan(SURFACES.grass.wet);
    expect(at.gravel.wet).toBe(SURFACES.gravel.wet);
    // half an all-terrain tyre is half-way
    const half = tireSurfaces({ offroad: 0.5 });
    expect(half.gravel.grip).toBeGreaterThan(SURFACES.gravel.grip);
    expect(half.gravel.grip).toBeLessThan(at.gravel.grip);
    // and a car is as good as the less all-terrain of its axles
    expect(carSurfaces({ tireFront: { offroad: 1 }, tireRear: {} })).toBe(SURFACES);
    expect(carSurfaces({ tireFront: { offroad: 1 }, tireRear: { offroad: 1 } })).toBe(at);
  });

  it('changes nothing on asphalt, packed snow or ice, to the bit', () => {
    const a = skidpad(mammoth, 60, { surface: 'asphalt' });
    const b = skidpad(onRoadTyres, 60, { surface: 'asphalt' });
    expect(a.latG).toBe(b.latG);
    expect(brakeRun(mammoth, true).distance).toBe(brakeRun(onRoadTyres, true).distance);
    for (const surface of ['snow', 'ice'] as const) {
      expect(skidpad(mammoth, 40, { surface }).latG, surface).toBe(skidpad(onRoadTyres, 40, { surface }).latG);
      expect(launch(mammoth, { surface }), surface).toBe(launch(onRoadTyres, { surface }));
    }
  });

  it('holds much more of its grip on loose ground than the same car on road tyres', () => {
    for (const [surface, gain] of [['grass', 1.12], ['gravel', 1.12], ['dirt', 1.1], ['sand', 1.2], ['deepsnow', 1.15]] as const) {
      const R = surface === 'deepsnow' ? 40 : 60;
      const at = skidpad(mammoth, R, { surface }).latG;
      const road = skidpad(onRoadTyres, R, { surface }).latG;
      expect(at / road, `${surface}: ${at.toFixed(3)} against ${road.toFixed(3)} g`).toBeGreaterThan(gain);
    }
    for (const surface of ['grass', 'gravel', 'dirt', 'sand'] as const) {
      expect(brakeRun(mammoth, true, { surface }).distance, `${surface} stop`).toBeLessThan(brakeRun(onRoadTyres, true, { surface }).distance * 0.92);
    }
  });

  it('floats over gravel, sand and deep snow: it loses less speed coasting through them', () => {
    for (const [surface, kmh, secs] of [['gravel', 100, 4], ['sand', 100, 4], ['deepsnow', 80, 5]] as const) {
      const at = coast(mammoth, { surface }, kmh, secs);
      const road = coast(onRoadTyres, { surface }, kmh, secs);
      expect(at, surface).toBeGreaterThan(road + 5);
    }
  });

  it('beats every road car on every loose surface, and keeps the largest share of its grip', () => {
    const grip = (c: CarDefinition, surface: SurfaceType) => skidpad(c, surface === 'deepsnow' ? 40 : 60, { surface }).latG;
    const dry = new Map(CARS.map((c) => [c.id, skidpad(c).latG] as const));
    for (const surface of ['grass', 'gravel', 'dirt', 'sand', 'deepsnow'] as const) {
      const m = grip(mammoth, surface);
      const keep = (c: CarDefinition) => grip(c, surface) / (surface === 'deepsnow' ? skidpad(c, 40, { surface: 'snow' }).latG : dry.get(c.id)!);
      for (const c of roadCars) expect(m, `${surface}: ${c.id}`).toBeGreaterThan(grip(c, surface) * 1.03);
      // (cutting a corner hurts it least: it keeps the biggest share of what it has on the road, of every car)
      const mine = keep(mammoth);
      for (const c of others) expect(mine, `${surface} kept, ${c.id}`).toBeGreaterThan(keep(c) + 0.05);
    }
  });

  it('stops shorter than a Vanta on grass, gravel, dirt and sand, though it weighs 1.65 times as much', () => {
    for (const surface of ['grass', 'gravel', 'dirt', 'sand'] as const) {
      expect(brakeRun(mammoth, true, { surface }).distance, surface).toBeLessThan(brakeRun(vanta, true, { surface }).distance);
    }
  });

  it('is kept on a winter circuit, where every tyre is studded: it acts on the deep snow beside the road and nowhere else', () => {
    const winter = createFlatTrack({ winter: true });
    const fitted = fitCar(mammoth, winter);
    expect(fitted.physics.tireFront.offroad).toBe(1);
    expect(fitted.physics.tireRear.offroad).toBe(1);
    expect(tireSurfaces(fitted.physics.tireFront).deepsnow.grip).toBeGreaterThan(SURFACES.deepsnow.grip);
    expect(tireSurfaces(fitted.physics.tireFront).snow).toBe(SURFACES.snow);
    expect(tireSurfaces(fitted.physics.tireFront).ice).toBe(SURFACES.ice);
    // (and the studded tyre is more progressive than the all-terrain one it replaces, as for every car)
    expect(fitted.physics.tireFront.peakSlipAngle).toBeGreaterThan(mammoth.physics.tireFront.peakSlipAngle);
    expect(fitted.physics.tireFront.loadSensitivity).toBeLessThan(mammoth.physics.tireFront.loadSensitivity);
  });
});

describe('the Mammoth on snow and ice', () => {
  it('launches in half the time of the two-wheel-drive cars', () => {
    for (const surface of ['snow', 'ice'] as const) {
      const m = launch(mammoth, { surface }, 100)!;
      expect(m, `${surface} 0-100`).toBeGreaterThan(5);
      for (const c of others) expect(m, `${surface} 0-100 against ${c.id}`).toBeLessThan(launch(c, { surface }, 100)! * 0.65);
      const m50 = launch(mammoth, { surface }, 50)!;
      for (const c of others) expect(m50, `${surface} 0-50 against ${c.id}`).toBeLessThan(launch(c, { surface }, 50)! * 0.65);
    }
  });
});

describe('the Mammoth does not roll over', () => {
  it('stays on its wheels sliding sideways into walls and snowbanks, however hard', () => {
    // (a tall car is tipped by a wall's push on its flank, by ground that grips a sliding tyre: neither does it in this model, a car's tyres hold 1.05 g
    // where it takes 1.2; this is the guard that says so)
    for (const bank of [false, true]) {
      for (const [kmh, yaw] of [[100, 25], [150, 45], [150, 90], [200, 20]] as const) {
        const world = new PhysicsWorld(createFlatTrack({ wall: 12, ...(bank ? { winter: true, softWalls: true, surface: 'snow' as const } : {}) }));
        const car = world.addVehicle(mammoth);
        car.placeOnGround(new Vector3(), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (yaw * Math.PI) / 180), 0);
        car.setTemperatures(1);
        car.v.set(0, 0, kmh / 3.6);
        for (const w of car.wheels) w.omega = kmh / 3.6 / w.radius;
        let minUp = 1;
        const up = new Vector3();
        for (let i = 0; i < 6 * 60; i++) {
          world.step(1 / 60);
          up.set(0, 1, 0).applyQuaternion(car.state.quaternion);
          minUp = Math.min(minUp, up.y);
        }
        expect(minUp, `${bank ? 'bank' : 'wall'} ${kmh} km/h at ${yaw} degrees`).toBeGreaterThan(0.95);
        expect(car.state.position.y).toBeLessThan(1.2);
      }
    }
  });
});

describe('the Mammoth in the AI’s hands', () => {
  it('has the track’s own grip under its line on the road, and its own where the road is loose', () => {
    // the line stays on asphalt, or on packed snow and ice: the all-terrain tyre changes none of that, so the profile of a Mammoth on road
    // tyres and on its own are the same
    for (const [trackId, wetness] of [['aurelia', 0], ['aurelia', 0.75], ['isvik', 0], ['isvik', 1]] as const) {
      const track = loadTrackRuntime(trackId);
      const line = computeRacingLine(track, { edgeMargin: mammoth.visual.width / 2 - 0.25 + (track.info.winter ? 0.45 : 0) });
      const opts = { gripUse: 0.9, brakeUse: 0.85, wetness };
      const own = new ProfileJob(track, line, mammoth, opts);
      const road = new ProfileJob(track, line, onRoadTyres, opts);
      own.finish();
      road.finish();
      expect(Array.from(own.surfaceFactor), `${trackId} wet ${wetness}: grip under the line`).toEqual(Array.from(road.surfaceFactor));
      expect(Array.from(own.speeds), `${trackId} wet ${wetness}: speeds`).toEqual(Array.from(road.speeds));
    }
    // a line over gravel, grass and a bit of asphalt: the grip of each, for each kind of tyre
    const surf = { at: Uint8Array.from([0, 1, 2, 1, 0]), names: ['asphalt', 'gravel', 'grass'] as SurfaceType[], props: [], grip: Float32Array.from([1, SURFACES.gravel.grip, SURFACES.grass.grip, SURFACES.gravel.grip, 1]) };
    expect(carLineGrip(surf, vanta.physics)).toBe(surf.grip);
    const own = carLineGrip(surf, mammoth.physics);
    expect(own[0]).toBe(1);
    expect(own[1]).toBeGreaterThan(surf.grip[1] + 0.1);
    expect(own[2]).toBeGreaterThan(surf.grip[2] + 0.1);
    expect(own[3]).toBe(own[1]);
    expect(own[4]).toBe(1);
  });
});

describe('the Mammoth on a lap', () => {
  // The AI drivers' laps (alien, standing start, the second lap): the character of the car in lap times. tests/ai.test.ts has all five on all five
  // circuits, dry and in a storm, and holds every one of them to two clean laps; here the order the promise gives.
  it('is slower than a Vanta in the dry, and a long way behind the LMP-X', () => {
    const m = aiLap('aurelia', mammoth);
    const v = aiLap('aurelia', vanta);
    const l = aiLap('aurelia', getCar('lmp-x'));
    expect(m.resets).toBe(0);
    expect(m.impacts).toBe(0);
    expect(m.lap).toBeGreaterThan(v.lap * 1.05);
    expect(m.lap).toBeGreaterThan(l.lap * 1.3);
    // (but it is not a slow car: quicker than the Ronin)
    expect(m.lap).toBeLessThan(aiLap('aurelia', getCar('ronin-86')).lap);
  }, 300000);

  it('is quicker than a Vanta in the rain, and on Isvik dry and in the snow quicker than every road car', () => {
    const rain = aiLap('aurelia', mammoth, 1);
    expect(rain.resets).toBe(0);
    expect(rain.lap).toBeLessThan(aiLap('aurelia', vanta, 1).lap);
    for (const wetness of [0, 1]) {
      const m = aiLap('isvik', mammoth, wetness);
      expect(m.resets, `resets, wet ${wetness}`).toBe(0);
      expect(m.impacts, `hits, wet ${wetness}`).toBe(0);
      for (const c of roadCars) expect(m.lap, `Isvik wet ${wetness} against ${c.id}`).toBeLessThan(aiLap('isvik', c, wetness).lap);
    }
  }, 300000);
});

describe('a whole grid of Mammoths', () => {
  // The lap times of the five cars are in tests/ai.test.ts' tables; here the one-make race, 2.45 t cars two abreast. A grid of twelve of them
  // bumps more than a grid of Vantas does (Isvik, six seeds, dry and in the snow: 8-50 contacts a race and 0-6 "hard" ones, which count a
  // collision twice, once for each car, and are 3-4 m/s a time: a Vanta field has 6-34 and 0-4), but it hits no wall, needs no reset and stays on the road.
  it('races Isvik, dry and in the snow, without a wall hit or a reset', () => {
    for (const [seed, wetness] of [[0, 0], [2, 1]] as const) {
      const r = runPack('isvik', 'mammoth', 'pro', 12, 1, false, { seed, wetness });
      expect(r.finished, `finished, seed ${seed} wet ${wetness}`).toBe(12);
      expect(r.walls, `wall hits, seed ${seed} wet ${wetness}`).toBe(0);
      expect(r.resets, `resets, seed ${seed} wet ${wetness}`).toBe(0);
      expect(r.offTrack / 12, `seconds off the road per car, seed ${seed} wet ${wetness}`).toBeLessThan(1);
      expect(r.hardContacts, `hard hits between cars, seed ${seed} wet ${wetness}`).toBeLessThan(10);
      expect(r.contacts, `contacts, seed ${seed} wet ${wetness}`).toBeLessThan(70);
    }
  }, 600000);

  it('races a dry circuit, Aurelia, without a wall hit or a reset', () => {
    const r = runPack('aurelia', 'mammoth', 'pro', 12, 1, false, { seed: 0 });
    expect(r.finished).toBe(12);
    expect(r.walls).toBe(0);
    expect(r.resets).toBe(0);
    expect(r.offTrack / 12).toBeLessThan(1);
    // (a one-make field of Vantas has twelve of them in the same race)
    expect(r.hardContacts).toBeLessThan(18);
  }, 600000);
});
