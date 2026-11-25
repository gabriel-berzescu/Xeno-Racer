/**
 * Hyperion Ring (headless): the layout brief as numbers, the floor of the ring it lies on, the sky of the ring (where the sun and
 * the planet are, whose light the circuit is in, the six hours and the day that turns through them), the circuit in the menus, and a
 * pack of twelve racing on it. The generic track checks (closed loop, continuity, widths, grid, design limits) run for it in
 * tests/track.test.ts like for every circuit; this file is what is particular to it.
 */
import { describe, expect, it } from 'vitest';
import type { TimeOfDay } from '../src/core/contracts';
import { CARS } from '../src/cars';
import { CALENDAR, championshipDef, createChampionship, isPlayable, lapsFor, roundConfig } from '../src/game/championship';
import { cloneSolution, envKey, mixHours, solveEnvironment, solveOrbitalHour, type EnvSolution } from '../src/render/environment';
import {
  ORBITAL,
  ORBITAL_PHASE,
  orbitalHandovers,
  orbitalHour,
  orbitalKeyPhases,
  orbitalLight,
  orbitalPlanet,
  orbitalPole,
  orbitalRingLight,
  orbitalSun,
} from '../src/render/orbital';
import { TRACKS, loadTrackRuntime } from '../src/track';
import type { TrackRuntimeImpl } from '../src/track/runtime';
import { ringRise } from '../src/track/terrain';
import { trackCode } from '../src/ui/format';
import { runPack } from './probes/pack-race';

const rt = loadTrackRuntime('hyperion') as TrackRuntimeImpl;
const info = TRACKS.find((t) => t.info.id === 'hyperion')!.info;
const ring = info.orbital!;
const floor = rt.def.terrain.ring!;
const L = rt.length;
const N = rt.count;
const h = rt.spacing;
const DEG = Math.PI / 180;
const HOURS: TimeOfDay[] = ['dawn', 'morning', 'noon', 'golden', 'dusk', 'night'];
const at = (s: number): number => Math.round((((s % L) + L) % L) / h) % N;
const yAt = (s: number): number => rt.py[at(s)];
const corner = (name: string) => {
  const c = rt.corners.find((k) => k.name === name);
  expect(c, `corner ${name} exists`).toBeDefined();
  return c!;
};
const lum = (c: ArrayLike<number>, o = 0): number => 0.2126 * c[o] + 0.7152 * c[o + 1] + 0.0722 * c[o + 2];
const len3 = (v: readonly number[]): number => Math.hypot(v[0], v[1], v[2]);
const dot3 = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const elevation = (v: readonly number[]): number => Math.asin(v[1]) / DEG;

describe('Hyperion Ring layout', () => {
  it('is a closed counter-clockwise loop of 5.1-5.45 km made of the named corners, in order', () => {
    expect(rt.plan.closureError).toBeLessThan(0.01);
    expect(rt.plan.totalTurn / DEG).toBeCloseTo(360, 1);
    expect(L).toBeGreaterThan(5100);
    expect(L).toBeLessThan(5450);
    expect(rt.corners.map((c) => c.name)).toEqual(['Janus', 'Epimetheus', 'Pandora', 'Atlas', 'Titan', 'Rhea', 'Dione', 'Dione2', 'Tethys', 'Enceladus1', 'Enceladus2', 'Phoebe']);
    for (let i = 1; i < rt.corners.length; i++) expect(rt.corners[i].sStart).toBeGreaterThan(rt.corners[i - 1].sEnd - 1e-6);
    expect(Math.abs(info.lengthHint - L)).toBeLessThan(6);
  });

  it('has Skyward, the longest straight, across the line and due north, and the heaviest braking of the lap at its end', () => {
    const janus = corner('Janus');
    const phoebe = corner('Phoebe');
    const skyward = janus.sStart + (L - phoebe.sEnd);
    expect(skyward).toBeGreaterThan(1100);
    for (let i = 1; i < rt.corners.length; i++) expect(rt.corners[i].sStart - rt.corners[i - 1].sEnd).toBeLessThan(skyward - 300);
    // due north (+z), along the ring: the land the driver looks at is the land that climbs
    for (let s = 0; s < janus.sStart - 10; s += 50) {
      expect(rt.Z[at(s + 20)] - rt.Z[at(s)]).toBeCloseTo(20, 1);
      expect(Math.abs(rt.X[at(s + 20)] - rt.X[at(s)])).toBeLessThan(0.05);
    }
    expect(janus.dir).toBe(1);
    expect(janus.angle / DEG).toBeCloseTo(80, 0);
    expect(janus.radius).toBeLessThanOrEqual(60);
    // and the last corner gives onto it: a left of 135 degrees, 300 m before the line
    expect(phoebe.dir).toBe(1);
    expect(phoebe.angle / DEG).toBeCloseTo(135, 0);
    expect(L - phoebe.sEnd).toBeCloseTo(300, 0);
  });

  it('climbs to the Edge: 650 m and more flat out on a terrace beside the western rim, due south, the glass 240 m to the right', () => {
    const atlas = corner('Atlas');
    const titan = corner('Titan');
    expect(atlas.dir).toBe(1);
    expect(atlas.radius).toBeGreaterThanOrEqual(200);
    const a = atlas.sEnd;
    const b = titan.sStart;
    expect(b - a).toBeGreaterThan(650);
    for (let s = a + 10; s < b - 10; s += 25) {
      const i = at(s);
      expect(Math.abs(rt.curvature[i])).toBeLessThan(1e-9);
      // 14 m and more over the park
      expect(rt.py[i] - ring.y, `s=${s.toFixed(0)}`).toBeGreaterThan(14);
      // due south, between 200 and 280 m inside the rim (west is +x, on the driver's right)
      expect(rt.Z[at(s + 10)]).toBeLessThan(rt.Z[i] - 9.9);
      expect(ring.rims[1] - rt.X[i]).toBeGreaterThan(200);
      expect(ring.rims[1] - rt.X[i]).toBeLessThan(280);
    }
    // the terrace is the top of the lap, and the road comes down off it through Titan and Rhea
    let iMax = 0;
    for (let i = 0; i < N; i++) if (rt.py[i] > rt.py[iMax]) iMax = i;
    expect(iMax * h).toBeGreaterThan(a);
    expect(iMax * h).toBeLessThan(b);
    expect(yAt(corner('Rhea').sEnd)).toBeLessThan(yAt(b) - 10);
    expect(titan.dir).toBe(1);
  });

  it('has a hairpin to pass at on the shore of the lake (Dione), and a right-left taken in one breath before the last corner (Enceladus)', () => {
    const a = corner('Dione');
    const b = corner('Dione2');
    expect([a.dir, b.dir]).toEqual([-1, -1]);
    expect((a.angle + b.angle) / DEG).toBeCloseTo(180, 0);
    expect(a.radius).toBeLessThan(40);
    expect(b.sStart - a.sEnd).toBeLessThan(0.5);
    expect(a.sStart - corner('Rhea').sEnd).toBeGreaterThan(280);
    // the lake lies inside the circuit, between the hairpin and the start straight: the road passes it at 60 m and more
    const lake = rt.def.terrain.lake!;
    expect(lake).toBeDefined();
    let nearest = Infinity;
    for (let i = 0; i < N; i += 2) {
      const dx = (rt.X[i] - lake.x) / lake.rx;
      const dz = (rt.Z[i] - lake.z) / lake.rz;
      nearest = Math.min(nearest, (Math.hypot(dx, dz) - 1) * Math.min(lake.rx, lake.rz));
    }
    expect(nearest).toBeGreaterThan(55);
    const e1 = corner('Enceladus1');
    const e2 = corner('Enceladus2');
    expect([e1.dir, e2.dir]).toEqual([-1, 1]);
    expect(e2.sStart - e1.sEnd).toBeLessThan(90);
    expect(Math.min(e1.radius, e2.radius)).toBeGreaterThanOrEqual(130);
  });

  it('is a circuit of the old kind: grass and gravel beyond the kerbs, armco and tyres, 13 to 15 m of road, three sectors', () => {
    expect(rt.def.paved).toBeFalsy();
    expect(rt.def.scenery?.city).toBeUndefined();
    expect(rt.def.scenery?.vegetation?.species[0][0]).toBe('oak');
    for (let i = 0; i < N; i += 10) {
      expect(rt.widthLeft[i] + rt.widthRight[i]).toBeGreaterThanOrEqual(13 - 1e-6);
      expect(rt.widthLeft[i] + rt.widthRight[i]).toBeLessThanOrEqual(15 + 1e-6);
    }
    const [s1, s2] = rt.sectors;
    expect(s1).toBeCloseTo(corner('Atlas').sEnd, 3);
    expect(s2).toBeCloseTo(corner('Dione2').sEnd, 3);
    for (const len of [s1, s2 - s1, L - s2]) expect(len).toBeGreaterThan(1300);
  });
});

describe('The floor of the ring', () => {
  it('turns once in five minutes for 1 g, and the contract and the terrain agree about it', () => {
    // g = w^2 r: a floor 22.4 km from the axis weighs 1 g when the ring turns in 2 pi sqrt(r / g) seconds
    expect(2 * Math.PI * Math.sqrt(ring.radius / 9.81)).toBeCloseTo(ORBITAL.daySeconds, 0);
    expect(floor.radius).toBe(ring.radius);
    expect(floor.z).toBe(ring.z);
    expect(floor.rims).toEqual(ring.rims);
    expect(ring.rims[1] - ring.rims[0]).toBeGreaterThan(5000);
    expect(ring.canopy).toBeGreaterThan(2000);
  });

  it('is flat under the circuit, the true circle beyond it, and ends at the rims', () => {
    const x = 400;
    // the circuit lies wholly on the flat part, between the rims
    for (let i = 0; i < N; i += 5) {
      expect(Math.abs(rt.Z[i] - floor.z)).toBeLessThan(floor.flat);
      expect(rt.X[i]).toBeGreaterThan(ring.rims[0] + 1000);
      expect(rt.X[i]).toBeLessThan(ring.rims[1] - 150);
      // (no curl under it; the bank of the rim only just reaches the Edge)
      expect(ringRise(floor, x, rt.Z[i])).toBe(0);
      expect(ringRise(floor, rt.X[i], rt.Z[i])).toBeLessThan(6);
    }
    // north and south alike the ground curls up, never down, and from `full` on it is the cylinder itself
    let prev = 0;
    for (let c = 0; c <= 5500; c += 100) {
      const up = ringRise(floor, x, floor.z + c);
      expect(up).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(ringRise(floor, x, floor.z - c)).toBeCloseTo(up, 9);
      if (c >= floor.full) expect(up).toBeCloseTo(ring.radius - Math.sqrt(ring.radius * ring.radius - c * c), 6);
      prev = up;
    }
    expect(ringRise(floor, x, floor.z + 5000)).toBeGreaterThan(500);
    // the terrain the scene is built from has it (5 km north of the circuit the ground is half a kilometre up)
    expect(rt.fieldHeight(x, floor.z + 5000)).toBeGreaterThan(ring.y + 450);
    // a bank at each rim, and no ground beyond it
    expect(ringRise(floor, ring.rims[1], floor.z)).toBeCloseTo(floor.berm, 6);
    expect(ringRise(floor, ring.rims[0], floor.z)).toBeCloseTo(floor.berm, 6);
    expect(ringRise(floor, ring.rims[1] - floor.bermW - 1, floor.z)).toBe(0);
    expect(ringRise(floor, ring.rims[1] + 120, floor.z)).toBeLessThan(-300);
  });
});

describe('The sky of the ring: where things are', () => {
  it('has the sun roll round the east: up in the north-east, due east and 35 degrees high at noon, down in the south-east', () => {
    for (let p = 0; p < 360; p += 7.5) {
      const s = orbitalSun(p);
      expect(len3(s)).toBeCloseTo(1, 9);
      expect(elevation(s)).toBeLessThanOrEqual(ORBITAL.sunAxis + 1e-9);
      // always on the east side (east = -x), at the same angle from the axis
      expect(s[0]).toBeCloseTo(-Math.cos(ORBITAL.sunAxis * DEG), 9);
    }
    expect(elevation(orbitalSun(90))).toBeCloseTo(ORBITAL.sunAxis, 9);
    expect(orbitalSun(90)[2]).toBeCloseTo(0, 9);
    expect(orbitalSun(0)[1]).toBeCloseTo(0, 9);
    expect(orbitalSun(0)[2]).toBeGreaterThan(0.5); // north
    expect(orbitalSun(180)[2]).toBeLessThan(-0.5); // south
    expect(elevation(orbitalSun(270))).toBeCloseTo(-ORBITAL.sunAxis, 9);
  });

  it('has Saturn over the western rim in the night and under it by day, nearly full, its pole across the line of sight', () => {
    for (let p = 0; p < 360; p += 7.5) {
      const pl = orbitalPlanet(p);
      const s = orbitalSun(p);
      expect(len3(pl)).toBeCloseTo(1, 9);
      expect(pl[0]).toBeCloseTo(Math.cos(ORBITAL.planetAxis * DEG), 9); // west = +x
      // the sun stands behind the watcher's shoulder: the planet is lit nearly face on, at every hour alike
      expect(dot3(pl, s)).toBeLessThan(-0.85);
      const k = orbitalPole(pl, s);
      expect(len3(k)).toBeCloseTo(1, 9);
      // tipped toward us by the rings' opening, and the sun on the same side of the rings as we are
      expect(-dot3(pl, k)).toBeCloseTo(Math.sin(ORBITAL.ringOpening * DEG), 9);
      // (only just: the sunlight skims the rings, as it does near the planet's equinox)
      expect(dot3(s, k)).toBeGreaterThan(0.02);
    }
    expect(elevation(orbitalPlanet(ORBITAL_PHASE.night))).toBeGreaterThan(10);
    expect(elevation(orbitalPlanet(ORBITAL_PHASE.golden))).toBeGreaterThan(0);
    expect(elevation(orbitalPlanet(ORBITAL_PHASE.noon))).toBeLessThan(-8);
    expect(elevation(orbitalPlanet(ORBITAL_PHASE.morning))).toBeLessThan(-8);
  });

  it('hands the light from the sun to the lit side of the ring and back, through nothing', () => {
    expect(orbitalLight(ring, 90)).toBe(1);
    expect(orbitalLight(ring, 30)).toBe(1);
    expect(orbitalLight(ring, 270)).toBe(-1);
    expect(orbitalLight(ring, 181)).toBe(-1);
    const [up, down] = orbitalHandovers(ring);
    // the ring's own land hides the sun for the first and the last degrees of the day
    expect(up).toBeGreaterThan(2);
    expect(up).toBeLessThan(ORBITAL_PHASE.dawn);
    expect(down).toBeCloseTo(180 - up, 6);
    expect(down).toBeGreaterThan(ORBITAL_PHASE.golden);
    expect(down).toBeLessThan(ORBITAL_PHASE.dusk);
    expect(Math.abs(orbitalLight(ring, up))).toBeLessThan(1e-6);
    // and it never jumps
    for (let p = 0; p < 360; p += 0.05) expect(Math.abs(orbitalLight(ring, p + 0.05) - orbitalLight(ring, p))).toBeLessThan(0.2);
    // the lit side of the ring: to the north after sunset, overhead at midnight, to the south before sunrise, in one sweep
    expect(orbitalRingLight(182)[2]).toBeGreaterThan(0.7);
    expect(orbitalRingLight(270)[1]).toBeCloseTo(1, 9);
    expect(orbitalRingLight(358)[2]).toBeLessThan(-0.7);
    for (let p = 176; p < 364; p += 1) {
      const a = orbitalRingLight(p);
      const b = orbitalRingLight(p + 1);
      expect(len3(a)).toBeCloseTo(1, 9);
      expect(a[1]).toBeGreaterThan(0.5);
      expect(dot3(a, b)).toBeGreaterThan(Math.cos(0.7 * DEG));
    }
  });
});

describe('The sky of the ring: the six hours', () => {
  it('is its own environment at every hour: clear thin air, the ring to draw, and the ordinary skies untouched', async () => {
    for (const timeOfDay of HOURS) {
      const plain = await solveEnvironment({ timeOfDay, weather: 'clear' });
      const sol = await solveEnvironment({ timeOfDay, weather: 'clear', orbital: ring });
      expect(envKey(sol.settings)).not.toBe(envKey(plain.settings));
      expect(plain.orbital).toBeNull();
      expect(plain.lutB).toBeNull();
      const look = sol.orbital!;
      expect(look.ring).toEqual(ring);
      expect(look.phase).toBeCloseTo(ORBITAL_PHASE[timeOfDay], 9);
      expect(look.rot[0]).toBeCloseTo(Math.cos(look.phase * DEG), 9);
      expect(look.planet).toEqual(orbitalPlanet(look.phase));
      expect(len3(look.pole)).toBeCloseTo(1, 9);
      // the sky's bright side is the true sun's, whoever lights the ground
      const sun = orbitalSun(look.phase);
      for (let c = 0; c < 3; c++) expect(sol.trueSunDir[c]).toBeCloseTo(sun[c], 6);
      expect(sol.skyAz[0] * sun[2] - sol.skyAz[1] * sun[0]).toBeCloseTo(0, 6);
      expect(sol.skyAz[0] * sun[0] + sol.skyAz[1] * sun[2]).toBeGreaterThan(0);
      // (an ordinary sky's bright side is its light's)
      expect(plain.skyAz[0] * plain.sunDir[2] - plain.skyAz[1] * plain.sunDir[0]).toBeCloseTo(0, 6);
      // no moon, no aurora, no city
      expect(sol.moonVis).toBe(0);
      expect(sol.aurora).toBe(0);
      expect(sol.city).toEqual([0, 0, 0]);
    }
    // the land is seen for tens of kilometres: the air is a third as hazy as an ordinary noon's
    const noon = await solveEnvironment({ timeOfDay: 'noon', weather: 'clear', orbital: ring });
    expect(2 / noon.fogDensity).toBeGreaterThan(25000);
  }, 60000);

  it('is in the sun by day and in the light of the ring after it: north at dusk, overhead at night', async () => {
    for (const timeOfDay of ['dawn', 'morning', 'noon', 'golden'] as const) {
      const sol = await solveEnvironment({ timeOfDay, weather: 'clear', orbital: ring });
      expect(sol.tod.moon, timeOfDay).toBe(false);
      for (let c = 0; c < 3; c++) expect(sol.sunDir[c]).toBeCloseTo(sol.trueSunDir[c], 6);
      expect(sol.lightIntensity).toBeGreaterThan(0.25);
      expect(lum(sol.sunRadiance)).toBeGreaterThan(0);
    }
    const noon = await solveEnvironment({ timeOfDay: 'noon', weather: 'clear', orbital: ring });
    expect(noon.sunElevation / DEG).toBeCloseTo(ORBITAL.sunAxis, 6);
    expect(noon.darkness).toBe(0);
    expect(noon.stars).toBe(0);
    const dawn = await solveEnvironment({ timeOfDay: 'dawn', weather: 'clear', orbital: ring });
    expect(dawn.lightIntensity).toBeLessThan(noon.lightIntensity * 0.5);

    const dusk = await solveEnvironment({ timeOfDay: 'dusk', weather: 'clear', orbital: ring });
    expect(dusk.tod.moon).toBe(true);
    expect(dusk.sunDir[2]).toBeGreaterThan(0.6);
    expect(dusk.trueSunDir[2]).toBeLessThan(-0.5);
    expect(dusk.lightIntensity).toBeCloseTo(ORBITAL.ringLight, 6);
    // the sky is still a dusk's: far brighter than the night's
    const night = await solveEnvironment({ timeOfDay: 'night', weather: 'clear', orbital: ring });
    expect(night.tod.moon).toBe(true);
    expect(night.sunDir[1]).toBeGreaterThan(0.99);
    expect(night.trueSunDir[1]).toBeLessThan(-0.5);
    expect(night.darkness).toBe(1);
    expect(night.stars).toBe(1);
    expect(night.skyScale).toBeLessThan(dusk.skyScale * 0.05);
    // the true sun's disc is still the sky's at dusk (the land hides it); by night the air has none of its light left
    expect(lum(dusk.sunRadiance)).toBeGreaterThan(0);
    expect(lum(night.sunRadiance)).toBe(0);
  }, 60000);
});

describe('A day that turns', () => {
  it('is solved at hours round the clock that hold the six of the game and the two hand-overs', () => {
    const ph = orbitalKeyPhases(ring);
    for (let i = 1; i < ph.length; i++) expect(ph[i]).toBeGreaterThan(ph[i - 1]);
    expect(ph[0]).toBeGreaterThanOrEqual(0);
    expect(ph[ph.length - 1]).toBeLessThan(360);
    for (const t of HOURS) expect(ph.some((p) => Math.abs(p - ORBITAL_PHASE[t]) < 1e-3), t).toBe(true);
    for (const p of orbitalHandovers(ring)) expect(ph.some((q) => Math.abs(q - p) < 1e-3)).toBe(true);
    // no gap of more than a quarter of a minute at noon or in the night, and none of more than three seconds at the ends of the day
    for (let i = 0; i < ph.length; i++) {
      const gap = (ph[(i + 1) % ph.length] - ph[i] + 360) % 360;
      expect(gap * (ORBITAL.daySeconds / 360)).toBeLessThanOrEqual(36);
      if (ph[i] >= 164 && ph[i] < 186) expect(gap).toBeLessThanOrEqual(8);
    }
  });

  it('passes through exactly the looks the still hours have', async () => {
    for (const timeOfDay of HOURS) {
      const still = await solveEnvironment({ timeOfDay, weather: 'clear', orbital: ring });
      const hour = await solveOrbitalHour({ timeOfDay: 'noon', weather: 'clear', orbital: ring }, ORBITAL_PHASE[timeOfDay]);
      expect(hour.lightIntensity, timeOfDay).toBeCloseTo(still.lightIntensity, 9);
      expect(hour.skyScale, timeOfDay).toBeCloseTo(still.skyScale, 9);
      expect(hour.exposure, timeOfDay).toBeCloseTo(still.exposure, 9);
      expect(hour.darkness, timeOfDay).toBeCloseTo(still.darkness, 9);
      for (let c = 0; c < 3; c++) expect(hour.sunDir[c], timeOfDay).toBeCloseTo(still.sunDir[c], 9);
      expect(Array.from(hour.fogTable), timeOfDay).toEqual(Array.from(still.fogTable));
    }
    // the preset of an hour is the same thing asked by phase
    expect(orbitalHour(ring, ORBITAL_PHASE.golden).elDeg).toBeCloseTo(Math.asin(orbitalSun(ORBITAL_PHASE.golden)[1]) / DEG, 9);
  }, 60000);

  it('goes round without a jump: the light dims to nothing where it changes hands, the dark comes and goes, the bodies keep to their paths', async () => {
    const settings = { timeOfDay: 'noon', weather: 'clear', orbital: ring } as const;
    const ph = orbitalKeyPhases(ring);
    const hours: EnvSolution[] = [];
    for (const p of ph) hours.push(await solveOrbitalHour(settings, p));
    const out = cloneSolution(hours[0]);
    const lookAt = (phase: number) => {
      const p = ((phase % 360) + 360) % 360;
      let i = ph.length - 1;
      for (let k = 0; k < ph.length; k++) if (ph[k] <= p) i = k;
      const j = (i + 1) % ph.length;
      const span = (ph[j] - ph[i] + 360) % 360 || 360;
      return mixHours(out, hours[i], hours[j], ((p - ph[i] + 360) % 360) / span, p);
    };
    // at a solved hour the mix is that hour
    for (const k of [0, 5, 11, 20, 27]) {
      const m = lookAt(ph[k]);
      expect(m.lightIntensity).toBeCloseTo(hours[k].lightIntensity, 9);
      expect(m.exposure).toBeCloseTo(hours[k].exposure, 9);
      expect(m.lutB!.mix).toBeCloseTo(0, 9);
      for (let c = 0; c < 3; c++) expect(m.sunDir[c]).toBeCloseTo(hours[k].sunDir[c], 6);
    }
    const [up, down] = orbitalHandovers(ring);
    let prev: { light: number[]; dir: number[]; dark: number; exposure: number; sky: number } | null = null;
    let darkest = 0;
    let brightest = 0;
    const step = 0.25;
    for (let p = 0; p <= 360; p += step) {
      const m = lookAt(p);
      const light = [m.lightColor[0] * m.lightIntensity, m.lightColor[1] * m.lightIntensity, m.lightColor[2] * m.lightIntensity];
      expect(len3(m.sunDir)).toBeCloseTo(1, 9);
      expect(m.sunDir[1]).toBeGreaterThan(0);
      expect(len3(m.trueSunDir)).toBeCloseTo(1, 9);
      expect(m.lightIntensity).toBeGreaterThanOrEqual(0);
      // the sky's two LUTs carry the whole of its brightness between them
      expect(m.lutB!.shareA * (1 - m.lutB!.mix) + m.lutB!.shareB * m.lutB!.mix).toBeCloseTo(1, 6);
      // the light is the sun's between the hand-overs and the ring's outside them
      const sunLit = p > up && p < down;
      if (Math.abs(p - up) > 0.3 && Math.abs(p - down) > 0.3) {
        expect(m.tod.moon, `phase ${p}`).toBe(!sunLit);
        expect(dot3(m.sunDir, sunLit ? orbitalSun(p) : orbitalRingLight(p))).toBeCloseTo(1, 9);
      }
      if (prev) {
        // a quarter of a degree of the day is a fifth of a second: nothing moves much in it (the sun comes out from behind the
        // land, or goes behind it, in three or four seconds: the light moves fastest there)
        const handing = Math.min(Math.abs(p - up), Math.abs(p - down)) < 4;
        for (let c = 0; c < 3; c++) expect(Math.abs(light[c] - prev.light[c]), `light at ${p}`).toBeLessThan(handing ? 0.3 : 0.1);
        expect(Math.abs(m.darkness - prev.dark), `darkness at ${p}`).toBeLessThan(0.02);
        expect(Math.abs(Math.log(m.exposure / prev.exposure)), `exposure at ${p}`).toBeLessThan(0.03);
        expect(Math.abs(Math.log(m.skyScale / prev.sky)), `sky at ${p}`).toBeLessThan(0.09);
        // the light's direction only jumps where there is no light to show it
        if (dot3(m.sunDir, prev.dir) < Math.cos(1 * DEG)) expect(Math.max(lum(light), lum(prev.light)), `direction at ${p}`).toBeLessThan(0.08);
      }
      prev = { light, dir: [m.sunDir[0], m.sunDir[1], m.sunDir[2]], dark: m.darkness, exposure: m.exposure, sky: m.skyScale };
      darkest = Math.max(darkest, m.darkness);
      brightest = Math.max(brightest, lum(light));
    }
    expect(darkest).toBe(1);
    expect(brightest).toBeGreaterThan(2);
    // where the light changes hands there is none
    expect(lookAt(up).lightIntensity).toBeLessThan(0.005);
    expect(lookAt(down).lightIntensity).toBeLessThan(0.005);
    // the hours themselves are untouched by the mixing
    out.fogTable[0] = 99;
    out.orbital!.planet[0] = 99;
    for (const hr of hours) {
      expect(hr.fogTable[0]).not.toBe(99);
      expect(hr.orbital!.planet[0]).not.toBe(99);
    }
  }, 120000);
});

describe('Hyperion Ring in the menus', () => {
  it('is on the track list with its own name, place and colour: an orbital ring, raced from golden hour by default, under lights', () => {
    expect(info.name).toBe('Hyperion Ring');
    expect(trackCode(info.name)).toBe('HYP');
    expect(info.location).toMatch(/Saturn/);
    expect(info.orbital).toBeDefined();
    expect(info.floodlit).toBe(true);
    expect(info.winter).toBeUndefined();
    expect(info.megacity).toBeUndefined();
    expect(info.defaultTimeOfDay).toBe('golden');
    expect(TRACKS.filter((t) => t.info.orbital).map((t) => t.info.id)).toEqual(['hyperion']);
    expect(new Set(TRACKS.map((t) => t.info.color.toLowerCase())).size).toBe(TRACKS.length);
    expect(new Set(TRACKS.map((t) => trackCode(t.info.name))).size).toBe(TRACKS.length);
  });

  it('is the last round of the Xeno Cup: once, from its golden hour, on a clear day, with nothing in the forecast (the sky is the round)', () => {
    const rounds = CALENDAR.map((c, i) => ({ ...c, i })).filter((c) => c.trackId === 'hyperion');
    expect(rounds.map((r) => [r.i, r.environment.timeOfDay, r.environment.weather, r.forecast ?? 'stable'])).toEqual([[CALENDAR.length - 1, 'golden', 'clear', 'stable']]);
    const tracks = TRACKS.map((t) => t.info);
    const def = championshipDef(tracks);
    const last = def.rounds[def.rounds.length - 1];
    expect(last.trackId).toBe('hyperion');
    expect(last.laps.standard).toBe(lapsFor(info.defaultLaps, 'standard'));
    const car = CARS[0];
    const state = createChampionship({
      setup: { carId: car.id, livery: { primary: '#16e0bd', driver: 'Gabriel' }, difficulty: 'pro', opponents: 7, length: 'standard', startPosition: 'back', grid: 'standings' },
      tracks,
      playerName: 'Gabriel',
      playerLivery: { ...car.defaultLivery, driver: 'Gabriel' },
      car,
      seed: 4242,
    });
    expect(isPlayable(state, TRACKS.map((t) => t.info.id), CARS.map((c) => c.id))).toBe(true);
    const cfg = roundConfig(state, def.rounds.length - 1);
    expect(cfg).toMatchObject({ mode: 'race', trackId: 'hyperion', environment: { timeOfDay: 'golden', weather: 'clear' }, championship: { round: 7, rounds: 7 } });
    expect(cfg.forecast).toBeUndefined();
    // the hour of the round is the hour its day starts at: a standard race of the cup is long enough for the sunset, the night and the
    // sunrise (the night ends 163 s after a start at golden hour, and no car of the game laps this circuit in under 70 s)
    const sunrise = ((360 - ORBITAL_PHASE.golden) / 360) * ORBITAL.daySeconds;
    expect(sunrise).toBeGreaterThan(150);
    expect(sunrise).toBeLessThan(cfg.laps * 70);
  });
});

describe('A pack on Hyperion Ring', () => {
  it('twelve mixed cars race two laps, dry and in standing water, without a reset and hardly a wall', () => {
    for (const [seed, wetness] of [[0, 0], [1, 1]] as const) {
      const r = runPack('hyperion', 'mixed', 'pro', 12, 2, false, { seed, wetness });
      expect(r.finished, `finished, seed ${seed} wet ${wetness}`).toBe(12);
      expect(r.resets, `resets, seed ${seed} wet ${wetness}`).toBe(0);
      expect(r.walls, `wall hits, seed ${seed} wet ${wetness}`).toBeLessThan(6);
      expect(r.offTrack, `seconds off the road, seed ${seed} wet ${wetness}`).toBeLessThan(12);
      // places to pass: Skyward into Janus, the Edge into Titan, the hairpin
      expect(r.overtakes, `overtakes, seed ${seed} wet ${wetness}`).toBeGreaterThan(3);
    }
  }, 600000);
});
