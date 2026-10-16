/**
 * Isvik Circuit (headless): the layout, the surfaces along the lap, the snowbanks, the frozen lake, a car thrown at a bank, and the words of
 * a winter circuit in the menus, the HUD and the weather notices. The generic track checks (closed loop, continuity, widths, grid, design
 * limits) run for it in tests/track.test.ts like for every circuit; this file is what is particular to it.
 */
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { getCar } from '../src/cars';
import type { GroundSample, TrackPoint } from '../src/core/contracts';
import { trackCondition, WeatherDirector, makePlan } from '../src/game/weather';
import { PhysicsWorld } from '../src/physics';
import { TRACKS, loadTrackRuntime } from '../src/track';
import type { TrackRuntimeImpl } from '../src/track/runtime';
import { forecastLabel, formatConditions, weatherLabel } from '../src/ui/format';
import { runPack } from './probes/pack-race';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import { SteeringFilter } from '../src/physics';
import { makeVehicleState } from '../sandbox/audio/drive-sim';
import type { SurfaceType } from '../src/core/contracts';

const rt = loadTrackRuntime('isvik') as TrackRuntimeImpl;
const info = TRACKS.find((t) => t.info.id === 'isvik')!.info;
const L = rt.length;

const ground = (): GroundSample => ({ height: 0, normal: new Vector3(), surface: 'asphalt' });
const tp = (): TrackPoint => ({ s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 });
const corner = (name: string) => {
  const c = rt.corners.find((k) => k.name === name);
  expect(c, `corner ${name} exists`).toBeDefined();
  return c!;
};
/** The surface at (s, d) and its height. */
function at(s: number, d: number): GroundSample {
  const p = rt.pointAt(rt.wrapS(s), d, new Vector3());
  const g = ground();
  rt.groundAt(p.x, p.z, g);
  return g;
}
/** The widths of the lap at a sample. */
const half = (i: number) => ({ l: rt.widthLeft[i], r: rt.widthRight[i], wl: rt.wallLeft[i], wr: rt.wallRight[i] });

describe('Isvik Circuit layout', () => {
  it('is a closed clockwise loop of 4.2-4.4 km made of its sixteen named corners, in order', () => {
    expect(rt.plan.closureError).toBeLessThan(0.01);
    expect((rt.plan.totalTurn * 180) / Math.PI).toBeCloseTo(-360, 1);
    const order = ['Granen', 'Tallen', 'Furu', 'Bjork', 'Lind', 'Skogen', 'Sjo1', 'Sjo2', 'Vand1a', 'Vand1b', 'Vand2a', 'Vand2b', 'Stranden', 'Kojan', 'Klippan', 'Malet'];
    expect(rt.corners.map((c) => c.name).filter((n) => order.includes(n))).toEqual(order);
    for (let i = 1; i < rt.corners.length; i++) expect(rt.corners[i].sStart).toBeGreaterThan(rt.corners[i - 1].sEnd - 1e-6);
    expect(L).toBeGreaterThan(4200);
    expect(L).toBeLessThan(4400);
    // (the track card and the loading screen print the hint)
    expect(Math.abs(info.lengthHint - L)).toBeLessThan(25);
  });

  it('has the corners of the brief: fast forest sweepers, two hairpins, a long right down to the lake, a village', () => {
    const radius = (n: string) => 1 / Math.max(...Array.from({ length: Math.round((corner(n).sEnd - corner(n).sStart) / rt.spacing) }, (_, k) => Math.abs(rt.curvature[Math.round(corner(n).sStart / rt.spacing) + k])));
    // medium-speed flowing corners
    for (const n of ['Granen', 'Tallen', 'Furu', 'Bjork']) expect(radius(n)).toBeGreaterThan(90);
    // the two hairpin switchbacks of the north shore: radius 25 m, turning through 150 degrees together
    expect(radius('Vand1a')).toBeLessThan(30);
    expect(radius('Vand2a')).toBeLessThan(30);
    // the corners alternate their direction as the layout says (right, left, right, left, ...)
    const sign = (n: string) => Math.sign(rt.curvature[Math.round((corner(n).sStart + corner(n).sEnd) / 2 / rt.spacing)]);
    expect([sign('Granen'), sign('Tallen'), sign('Furu'), sign('Bjork'), sign('Lind'), sign('Skogen')]).toEqual([-1, 1, -1, 1, -1, -1]);
    expect(sign('Vand1a')).toBe(-1);
    expect(sign('Vand2a')).toBe(1);
  });

  it('is a modest climb: 9-16 m of relief with the lake dead flat at the bottom', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < rt.count; i++) {
      lo = Math.min(lo, rt.py[i]);
      hi = Math.max(hi, rt.py[i]);
    }
    expect(hi - lo).toBeGreaterThan(9);
    expect(hi - lo).toBeLessThan(16);
  });
});

describe('Isvik Circuit surfaces', () => {
  // the stretch of ice: from 70 m after Skogen to 40 m after Sjo2 (the lake)
  const iceFrom = corner('Skogen').sEnd + 70;
  const iceTo = corner('Sjo2').sEnd + 40;

  it('is packed snow all the way round, and ice only across the lake', () => {
    let iceM = 0;
    for (let s = 0; s < L; s += 5) {
      const g = at(s, 0);
      if (s > iceFrom + 8 && s < iceTo - 8) {
        expect(g.surface, `ice at s=${s}`).toBe('ice');
        iceM += 5;
      } else if (s < iceFrom - 8 || s > iceTo + 8) expect(g.surface, `snow at s=${s}`).toBe('snow');
    }
    // three quarters of a kilometre of ice
    expect(iceM + 16).toBeGreaterThan(750);
    expect(iceM + 16).toBeLessThan(820);
  });

  it('has a metre of packed snow beside the road, then deep snow to the bank and beyond it', () => {
    // (0.8 m of packed shoulder; then 2.2 m of deep snow at the foot of the bank; the paddock side of the start straight has its own wide shoulder)
    const paddock = (s: number) => s < 340 || s > corner('Malet').sEnd - 10;
    for (let s = 20; s < L; s += 37) {
      const i = Math.round(s / rt.spacing) % rt.count;
      const w = half(i);
      for (const side of [1, -1]) {
        const edge = side > 0 ? w.l : w.r;
        const wall = side > 0 ? w.wl : w.wr;
        if (!(side > 0 && paddock(s))) {
          expect(at(s, side * (edge + 0.4)).surface, `shoulder s=${s}`).toBe('snow');
          expect(at(s, side * (edge + 1.6)).surface, `deep snow s=${s}`).toBe('deepsnow');
        }
        expect(at(s, side * (wall + 4)).surface, `beyond the bank s=${s}`).toBe('deepsnow');
      }
    }
  });

  it('has a wide shoulder of packed snow on the paddock side of the start straight (the pit lane), deep snow behind it', () => {
    const i = Math.round(150 / rt.spacing);
    const w = half(i);
    expect(at(150, w.l + 3).surface).toBe('snow');
    expect(at(150, w.l + 5.4).surface).toBe('deepsnow');
    expect(at(150, -(w.r + 1.6)).surface).toBe('deepsnow');
  });

  it('keeps the road 11.5-15.5 m wide and the snowbank 2.5-4 m beyond its edge', () => {
    let narrow = Infinity;
    let wide = 0;
    for (let i = 0; i < rt.count; i++) {
      const w = half(i);
      narrow = Math.min(narrow, w.l + w.r);
      wide = Math.max(wide, w.l + w.r);
      // (the paddock side of the start straight has a wider shoulder, so a larger gap)
      expect(w.wl - w.l).toBeGreaterThan(2.4);
      expect(w.wl - w.l).toBeLessThan(6.6);
      expect(w.wr - w.r).toBeGreaterThan(2.4);
      expect(w.wr - w.r).toBeLessThan(4);
    }
    expect(narrow).toBeGreaterThan(11.4);
    expect(wide).toBeLessThan(15.6);
  });

  it('has a snowbank on both sides all the way round: a soft barrier, never a wall', () => {
    const p = tp();
    let hint = -1;
    for (let s = 3; s < L; s += 11) {
      const i = Math.round(s / rt.spacing) % rt.count;
      const w = half(i);
      for (const side of [1, -1]) {
        const d = side * ((side > 0 ? w.wl : w.wr) - 0.05);
        const q = rt.pointAt(rt.wrapS(s), d, new Vector3());
        hint = rt.project(q.x, q.z, p, hint);
        expect(side > 0 ? p.softLeft : p.softRight, `soft side ${side} s=${s}`).toBeGreaterThan(0.99);
      }
    }
  });

  it('lays the lake dead flat and level, a shore of 45 m, and nothing but the lake on it', () => {
    // the road across the ice is at the level of the lake
    for (let s = iceFrom + 20; s < iceTo - 20; s += 20) {
      expect(at(s, 0).height, `road s=${s}`).toBeCloseTo(3.5, 1);
      // and so is the lake on either side, as far out as the bank and the foot of it
      expect(at(s, 11).height, `lake left s=${s}`).toBeGreaterThan(3.3);
      expect(at(s, 11).height, `lake left s=${s}`).toBeLessThan(3.8);
      expect(at(s, -11).height, `lake right s=${s}`).toBeGreaterThan(3.3);
      expect(at(s, -11).height, `lake right s=${s}`).toBeLessThan(3.8);
    }
    expect(rt.iceLake).not.toBeNull();
  });
});

describe('Isvik Circuit snowbank, driven into', () => {
  /** A car at `kmh`, `deg` degrees off the road's direction towards the left bank, left to itself for `secs`. */
  function hit(carId: string, kmh: number, deg: number, secs = 3) {
    const world = new PhysicsWorld(rt);
    const car = world.addVehicle(getCar(carId));
    const s0 = 200;
    const f = rt.frameAt(s0, { position: new Vector3(), tangent: new Vector3(), normal: new Vector3(), left: new Vector3(), widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, curvature: 0, bank: 0 });
    const aim = new Vector3().copy(f.tangent).multiplyScalar(Math.cos((deg * Math.PI) / 180)).addScaledVector(f.left, Math.sin((deg * Math.PI) / 180));
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), aim.normalize());
    car.placeOnGround(rt.pointAt(s0, f.widthLeft - 1.5, new Vector3()), q, kmh / 3.6);
    car.setTemperatures(1);
    let peakG = 0;
    let impact = '';
    let seen = 0;
    let maxD = 0;
    const p = tp();
    let hint = -1;
    let prev = car.state.velocity.clone();
    const dt = 1 / 60;
    for (let i = 0; i < secs * 60; i++) {
      world.step(dt);
      const v = car.state.velocity;
      peakG = Math.max(peakG, v.distanceTo(prev) / dt / 9.81);
      prev = v.clone();
      if (car.state.impactCount !== seen) {
        seen = car.state.impactCount;
        impact = car.state.lastImpact.kind;
      }
      hint = rt.project(car.p.x, car.p.z, p, hint);
      maxD = Math.max(maxD, p.d);
    }
    return { kmh: car.state.speed * 3.6, peakG, impact, maxD, wall: p.wallLeft, d: p.d, width: p.widthLeft };
  }

  it('slows the car in a metre or two and does not throw it back: 100 km/h at 20 degrees', () => {
    for (const id of ['vanta-gt', 'lmp-x']) {
      const r = hit(id, 100, 20, 3);
      expect(r.impact).toBe('snow');
      // it has lost half its speed in a glancing blow (a wall takes much more and gives some back), at a few g and not a dozen
      expect(r.kmh).toBeLessThan(65);
      expect(r.kmh).toBeGreaterThan(20);
      expect(r.peakG).toBeLessThan(9);
      expect(r.peakG).toBeGreaterThan(1);
      // it went into the bank, and has not come back across the road
      expect(r.maxD).toBeGreaterThan(r.wall - 0.6);
      expect(r.d).toBeGreaterThan(r.width - 0.5);
    }
  });

  it('a graze at 60 km/h and 10 degrees costs a few km/h and no impact worth a name', () => {
    const r = hit('kestrel-r', 60, 10, 1.5);
    expect(r.kmh).toBeGreaterThan(30);
    expect(r.peakG).toBeLessThan(3);
  });
});

describe('Isvik Circuit in the menus, the HUD and the weather', () => {
  it('is on the track list with its own name, place and colour, and it is the winter circuit', () => {
    expect(info.name).toBe('Isvik Circuit');
    expect(info.location).toMatch(/Isvik/);
    expect(info.winter).toBe(true);
    expect(info.floodlit).toBe(true);
    expect(TRACKS.filter((t) => t.info.winter).map((t) => t.info.id)).toEqual(['isvik']);
    expect(new Set(TRACKS.map((t) => t.info.color.toLowerCase())).size).toBe(TRACKS.length);
  });

  it('calls the rain snow and the storm a blizzard, here and only here', () => {
    expect(weatherLabel('rain', true)).toBe('Snow');
    expect(weatherLabel('storm', true)).toBe('Blizzard');
    expect(weatherLabel('clear', true)).toBe('Clear');
    expect(weatherLabel('rain')).toBe('Rain');
    expect(weatherLabel('storm', false)).toBe('Storm');
    expect(forecastLabel('rainLater', true)).toBe('Snow later');
    expect(forecastLabel('rainLater')).toBe('Rain later');
    expect(forecastLabel('clearing', true)).toBe('Clearing');
    expect(formatConditions({ timeOfDay: 'dusk', weather: 'rain' }, 'clearing', true)).toBe('Dusk  ·  Snow, clearing');
    expect(formatConditions({ timeOfDay: 'noon', weather: 'cloudy' }, 'rainLater', true)).toBe('Noon  ·  Cloudy, snow later');
    expect(formatConditions({ timeOfDay: 'noon', weather: 'cloudy' }, 'rainLater')).toBe('Noon  ·  Cloudy, rain later');
  });

  it('describes the road as packed, dusted, fresh snow, deep snow and drifts, and the notices talk about snow', () => {
    expect([0, 0.1, 0.4, 0.75, 1].map((w) => trackCondition(w, true))).toEqual(['Packed', 'Dusted', 'Fresh snow', 'Deep snow', 'Drifting']);
    expect([0, 0.1, 0.4, 0.75, 1].map((w) => trackCondition(w))).toEqual(['Dry', 'Damp', 'Wet', 'Very wet', 'Soaked']);
    const plan = makePlan({ forecast: 'rainLater', weather: 'clear', mode: 'race', laps: 3, seed: 1 })!;
    const snow = new WeatherDirector(plan, 1, true);
    snow.update(1, 1, 1000);
    expect(snow.drain()[0].notice.title).toBe('Snow is coming');
    const rain = new WeatherDirector(plan, 1);
    rain.update(1, 1, 1000);
    expect(rain.drain()[0].notice.title).toBe('Rain is coming');
    const clearing = makePlan({ forecast: 'clearing', weather: 'rain', mode: 'race', laps: 3, seed: 1 })!;
    const done = new WeatherDirector(clearing, 1, true);
    done.update(1, 1, 1000);
    const events = [...done.drain()];
    for (let i = 0; i < 400; i++) {
      done.update(1, 1, 1000);
      events.push(...done.drain());
    }
    expect(events.map((e) => e.notice.title)).toEqual(['Skies are clearing', 'The snow has stopped']);
  });
});

describe('Isvik Circuit pack racing', () => {
  // A mixed 12-car grid of pros from a standing start, on dry packed snow and in a snowfall. With the first drivers it went wrong
  // on the outside of the long right-hand sweepers: a car that had run out to the edge to pass slid on into the deep snow and the
  // bank (a wall hit in one race of five, and a reset, dry; in the snow two of five).
  it('keeps to the road: no wall hits and no resets, dry and in the snow', () => {
    for (const wetness of [0, 1]) {
      for (const seed of [0, 3]) {
        const r = runPack('isvik', 'mixed', 'pro', 12, 1, false, { seed, wetness });
        expect(r.finished, `finished, seed ${seed} wet ${wetness}`).toBe(12);
        expect(r.walls, `wall hits, seed ${seed} wet ${wetness}`).toBe(0);
        expect(r.resets, `resets, seed ${seed} wet ${wetness}`).toBe(0);
        expect(r.offTrack / 12, `seconds off the road per car, seed ${seed} wet ${wetness}`).toBeLessThan(1);
        expect(r.hardContacts, `hard hits between cars, seed ${seed} wet ${wetness}`).toBeLessThan(6);
      }
    }
  }, 600000);
});

describe('The stick on snow', () => {
  it('asks for less steering angle on snow and ice than on asphalt at the same speed, and the same on every other surface as before', () => {
    const def = getCar('vanta-gt');
    const controls = DEFAULT_SETTINGS.controls;
    const full = (surface: SurfaceType, kmh: number): number => {
      const st = makeVehicleState();
      st.forwardSpeed = kmh / 3.6;
      st.speed = kmh / 3.6;
      for (const w of st.wheels) {
        w.contact = true;
        w.surface = surface;
      }
      const f = new SteeringFilter();
      let out = 0;
      for (let i = 0; i < 120; i++) out = f.update(1, 1 / 60, st, def, controls);
      return out;
    };
    for (const kmh of [60, 90, 120]) {
      const asphalt = full('asphalt', kmh);
      expect(full('snow', kmh)).toBeLessThan(asphalt);
      expect(full('ice', kmh)).toBeLessThan(full('snow', kmh) + 1e-9);
      expect(full('grass', kmh)).toBeCloseTo(asphalt, 9);
      expect(full('gravel', kmh)).toBeCloseTo(asphalt, 9);
    }
    // at a walking pace nothing limits the stick
    expect(full('snow', 20)).toBeCloseTo(full('asphalt', 20), 6);
  });
});
