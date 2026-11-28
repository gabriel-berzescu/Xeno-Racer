/**
 * Halcyon Ring (headless): the layout brief as numbers, the atoll it goes round (the sea, the lagoon, the causeway across it), the
 * great ring it lies on (its size and its day, where the sun stands at each of the game's hours, the arch that is the light of its
 * night), the circuit in the menus and in the cup, and a pack of twelve racing on it. The generic track checks (closed loop,
 * continuity, widths, grid, design limits) run for it in tests/track.test.ts like for every circuit; this file is what is particular
 * to it.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { TimeOfDay } from '../src/core/contracts';
import { CARS } from '../src/cars';
import { CALENDAR, championshipDef, createChampionship, isPlayable, lapsFor, roundConfig } from '../src/game/championship';
import { envKey, solveEnvironment, solveOrbitalHour } from '../src/render/environment';
import { GREAT, GREAT_PHASE, greatArchLight, greatHour, ORBITAL, orbitalSun } from '../src/render/orbital';
import { TOD } from '../src/render/presets';
import { TRACKS, loadTrackRuntime } from '../src/track';
import type { TrackRuntimeImpl } from '../src/track/runtime';
import { trackCode } from '../src/ui/format';
import { runPack } from './probes/pack-race';

const rt = loadTrackRuntime('halcyon') as TrackRuntimeImpl;
rt.ensureField();
const info = TRACKS.find((t) => t.info.id === 'halcyon')!.info;
const ring = info.orbital!;
const ocean = rt.def.terrain.ocean!;
const SEA = ocean.level;
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
const elevation = (v: readonly number[]): number => Math.asin(v[1]) / DEG;
/** The ground `d` metres to the left of the road at s (negative: to the right), as the scene draws it. */
const _p = new Vector3();
const beside = (s: number, d: number): number => {
  rt.pointAt(((s % L) + L) % L, d, _p);
  return rt.fieldHeight(_p.x, _p.z);
};
const sun = (phase: number) => orbitalSun(phase, [0, 0, 0], GREAT.sunAxis);

describe('Halcyon Ring layout', () => {
  it('is a closed clockwise loop of 5.3-5.6 km made of the named corners, in order', () => {
    expect(rt.plan.closureError).toBeLessThan(0.01);
    expect(rt.plan.totalTurn / DEG).toBeCloseTo(-360, 1);
    expect(rt.def.dir).toBe(-1);
    expect(L).toBeGreaterThan(5300);
    expect(L).toBeLessThan(5600);
    expect(rt.corners.map((c) => c.name)).toEqual(['Kingfisher', 'Strand', 'Sandpiper', 'Curlew', 'Tern', 'Albatross', 'Petrel', 'Osprey', 'Jackdaw1', 'Jackdaw2', 'Jackdaw3', 'Heron']);
    for (let i = 1; i < rt.corners.length; i++) expect(rt.corners[i].sStart).toBeGreaterThan(rt.corners[i - 1].sEnd - 1e-6);
    expect(Math.abs(info.lengthHint - L)).toBeLessThan(6);
  });

  it('has Meridian across the line, due south, and a right of 90 degrees to brake for at its end', () => {
    const kingfisher = corner('Kingfisher');
    const heron = corner('Heron');
    expect(kingfisher.sStart + (L - heron.sEnd)).toBeGreaterThan(780);
    // due south (-z): the southern foot of the arch stands over the road ahead of the grid
    for (let s = 0; s < kingfisher.sStart - 30; s += 50) {
      expect(rt.Z[at(s + 20)] - rt.Z[at(s)]).toBeCloseTo(-20, 1);
      expect(Math.abs(rt.X[at(s + 20)] - rt.X[at(s)])).toBeLessThan(0.05);
    }
    expect(kingfisher.dir).toBe(-1);
    expect(kingfisher.angle / DEG).toBeCloseTo(90, 0);
    expect(kingfisher.radius).toBeLessThanOrEqual(60);
    // the last corner gives onto it: a right of 80 degrees, 320 m before the line
    expect(heron.dir).toBe(-1);
    expect(heron.angle / DEG).toBeCloseTo(80, 0);
    expect(L - heron.sEnd).toBeCloseTo(320, 0);
  });

  it('goes along the beach in one long bend to the left (the Strand), flat out, three metres above the wash', () => {
    const strand = corner('Strand');
    expect(strand.dir).toBe(1);
    expect(strand.radius).toBeGreaterThanOrEqual(900);
    expect(strand.sEnd - strand.sStart).toBeGreaterThan(300);
    for (let s = strand.sStart; s < strand.sEnd; s += 40) {
      expect(yAt(s) - SEA, `s=${s.toFixed(0)}`).toBeGreaterThan(2.9);
      expect(yAt(s) - SEA).toBeLessThan(4.6);
      // the open sea on the left, 90 m from the road and nearer; and the run-off on that side is the beach's own sand
      expect(beside(s, 95)).toBeLessThan(SEA);
    }
    expect(rt.def.zones.some((z) => z.side === 'L' && z.bands?.some((b) => b.surf === 'sand'))).toBe(true);
  });

  it('crosses the water on the Causeway: 1.25 km and more due north, level, the longest straight, the lagoon on the right and the open sea on the left', () => {
    const tern = corner('Tern');
    const albatross = corner('Albatross');
    const a = tern.sEnd;
    const b = albatross.sStart;
    expect(b - a).toBeGreaterThan(1250);
    for (let i = 1; i < rt.corners.length; i++) if (rt.corners[i] !== albatross) expect(rt.corners[i].sStart - rt.corners[i - 1].sEnd).toBeLessThan(b - a - 300);
    for (let s = a + 10; s < b - 10; s += 25) {
      const i = at(s);
      expect(Math.abs(rt.curvature[i])).toBeLessThan(1e-9);
      // due north (+z): the northern foot of the arch stands over the road ahead
      expect(rt.Z[at(s + 10)]).toBeGreaterThan(rt.Z[i] + 9.9);
    }
    // level, three metres over the water, between the ramps at its two ends
    for (let s = a + 200; s < b - 200; s += 25) expect(Math.abs(yAt(s) - (SEA + 3))).toBeLessThan(0.1);
    // water on both sides for a kilometre of it, from sixty metres off the road: shallow on the right, deep on the left
    for (let s = a + 150; s < b - 320; s += 50) {
      expect(beside(s, 60), `left of s=${s.toFixed(0)}`).toBeLessThan(SEA - 0.5);
      expect(beside(s, -60), `right of s=${s.toFixed(0)}`).toBeLessThan(SEA - 0.3);
      expect(SEA - beside(s, -220)).toBeLessThan(ocean.bed.right[0] + 0.1);
      expect(SEA - beside(s, 220)).toBeGreaterThan(8);
    }
    // and at its end the heaviest braking of the lap: a right of 95 degrees, tighter than any other corner
    expect(albatross.dir).toBe(-1);
    expect(albatross.angle / DEG).toBeCloseTo(95, 0);
    for (const c of rt.corners) expect(c.radius).toBeGreaterThanOrEqual(albatross.radius);
  });

  it('climbs the headland to the cliff top of Osprey, the top of the lap, and comes down through the three bends of the old wood', () => {
    const osprey = corner('Osprey');
    let iMax = 0;
    for (let i = 0; i < N; i++) if (rt.py[i] > rt.py[iMax]) iMax = i;
    expect(iMax * h).toBeGreaterThan(osprey.sStart);
    expect(iMax * h).toBeLessThan(osprey.sEnd);
    expect(rt.py[iMax] - SEA).toBeGreaterThan(24);
    expect(osprey.dir).toBe(-1);
    expect(osprey.angle / DEG).toBeGreaterThan(110);
    // the sea is under the cliff, on the outside of the bend: 110 m from the road it is water, twenty metres and more below it
    const mid = (osprey.sArcA + osprey.sArcB) / 2;
    expect(beside(mid, 110)).toBeLessThan(SEA);
    expect(yAt(mid) - SEA).toBeGreaterThan(22);
    // left, right, left, flat or nearly, one into the next, downhill all the way
    const j = ['Jackdaw1', 'Jackdaw2', 'Jackdaw3'].map(corner);
    expect(j.map((c) => c.dir)).toEqual([1, -1, 1]);
    for (const c of j) expect(c.radius).toBeGreaterThanOrEqual(145);
    expect(j[1].sStart - j[0].sEnd).toBeLessThan(100);
    expect(j[2].sStart - j[1].sEnd).toBeLessThan(100);
    expect(yAt(j[0].sStart)).toBeGreaterThan(yAt(j[1].sStart) + 3);
    expect(yAt(j[1].sStart)).toBeGreaterThan(yAt(j[2].sStart) + 3);
    expect(yAt(j[2].sStart)).toBeGreaterThan(yAt(corner('Heron').sEnd) + 3);
  });

  it('is a circuit of the old kind: grass, gravel and sand beyond the kerbs, armco and tyres, 13 to 15 m of road, three sectors', () => {
    expect(rt.def.paved).toBeFalsy();
    expect(rt.def.scenery?.city).toBeUndefined();
    expect(rt.def.scenery?.vegetation?.species[0][0]).toBe('palm');
    for (let i = 0; i < N; i += 10) {
      expect(rt.widthLeft[i] + rt.widthRight[i]).toBeGreaterThanOrEqual(13 - 1e-6);
      expect(rt.widthLeft[i] + rt.widthRight[i]).toBeLessThanOrEqual(15 + 1e-6);
    }
    const [s1, s2] = rt.sectors;
    expect(s1).toBeCloseTo(corner('Tern').sEnd, 3);
    expect(s2).toBeCloseTo(corner('Osprey').sEnd, 3);
    for (const len of [s1, s2 - s1, L - s2]) expect(len).toBeGreaterThan(1000);
  });
});

describe('The atoll', () => {
  it('is land beside the road and water everywhere else: the sea is at one level, and the road is never less than 2.9 m above it', () => {
    expect(rt.terrain.lakeLevel).toBe(SEA);
    for (let i = 0; i < N; i += 3) {
      expect(rt.py[i] - SEA).toBeGreaterThan(2.9);
      // dry ground beyond the barrier on both sides, all the way round (the coast wanders, but not into the road; on the Causeway
      // the shoulder is a few metres of rock and then the water)
      expect(beside(i * h, rt.L.wall[i] + 5), `left of s=${(i * h).toFixed(0)}`).toBeGreaterThan(SEA + 0.05);
      expect(beside(i * h, -(rt.R.wall[i] + 5)), `right of s=${(i * h).toFixed(0)}`).toBeGreaterThan(SEA + 0.05);
    }
  });

  it('goes round a lagoon: shallow water inside the circuit, the open sea outside it', () => {
    const b = rt.bounds;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    // the middle of the lagoon, and the water a few hundred metres round it
    for (const [dx, dz] of [[0, 0], [200, 0], [-200, 0], [0, 200], [0, -250]]) {
      const depth = SEA - rt.fieldHeight(cx + dx, cz + dz);
      expect(depth, `lagoon at ${dx}, ${dz}`).toBeGreaterThan(1.5);
      expect(depth).toBeLessThan(ocean.bed.right[0] + 0.1);
    }
    // the open sea is the outside of a clockwise circuit: the left of the road
    expect(ocean.outside).toBe('L');
    for (const [x, z] of [[b.minX - 700, cz], [b.maxX + 400, cz], [cx, b.minZ - 900], [cx, b.maxZ + 900], [b.minX - 4000, b.minZ - 4000]]) {
      expect(SEA - rt.fieldHeight(x, z), `sea at ${x.toFixed(0)}, ${z.toFixed(0)}`).toBeGreaterThan(14);
    }
    // (and the sea bed does not step where the baked coast ends: the far sea is as deep as the sea beside it)
    expect(SEA - rt.fieldHeight(b.maxX + 3000, cz)).toBeCloseTo(ocean.bed.left[0], 0);
  });

  it('has rocks and islets standing in its sea: each rises out of the water, well clear of the road', () => {
    const islets = ocean.islets!;
    expect(islets.length).toBeGreaterThanOrEqual(8);
    for (const it of islets) {
      expect(rt.fieldHeight(it.x, it.z) - SEA, `islet at ${it.x}, ${it.z}`).toBeGreaterThan(it.h * 0.6);
      let nearest = Infinity;
      for (let i = 0; i < N; i += 4) nearest = Math.min(nearest, Math.hypot(rt.X[i] - it.x, rt.Z[i] - it.z));
      expect(nearest - it.r, `islet at ${it.x}, ${it.z}`).toBeGreaterThan(110);
    }
    // stacks under the cliff of the headland, north of Osprey
    const osprey = corner('Osprey');
    const io = at((osprey.sArcA + osprey.sArcB) / 2);
    expect(islets.filter((it) => it.z > rt.Z[io] + 100 && Math.abs(it.x - rt.X[io]) < 300 && it.h > 20).length).toBeGreaterThanOrEqual(3);
  });
});

describe('The great ring', () => {
  it('turns once in twenty-four hours for 1 g, is open to space, and is flat as far as the eye can tell', () => {
    // g = w^2 r, the sum that gives Hyperion Ring its day of five minutes: a floor 1.855 million km from the axis takes a day
    expect(Math.abs(2 * Math.PI * Math.sqrt(ring.radius / 9.81) - GREAT.daySeconds)).toBeLessThan(60);
    expect(GREAT.daySeconds).toBe(86400);
    expect(ring.great).toBe(true);
    expect(ring.canopy).toBe(0);
    // a band of land and sea tens of thousands of kilometres wide, the atoll well inside it
    expect(ring.rims[1] - ring.rims[0]).toBeGreaterThan(2e7);
    for (let i = 0; i < N; i += 50) {
      expect(rt.X[i] - ring.rims[0]).toBeGreaterThan(1e7);
      expect(ring.rims[1] - rt.X[i]).toBeGreaterThan(1e7);
    }
    // the floor curls up as Hyperion's does, and nobody can see it: five kilometres away it has risen by less than a centimetre
    expect(ring.radius - Math.sqrt(ring.radius * ring.radius - 5000 * 5000)).toBeLessThan(0.01);
    expect(rt.def.terrain.ring).toBeUndefined();
    // (the habitat ring's numbers are its own)
    expect(ORBITAL.daySeconds).toBe(300);
  });

  it('has the sun where the ring puts it: as high as at that hour on the ground, always in the eastern sky, 66.6 degrees up at noon', () => {
    for (const t of ['dawn', 'morning', 'golden', 'dusk'] as const) expect(elevation(sun(GREAT_PHASE[t])), t).toBeCloseTo(TOD[t].elDeg, 6);
    expect(elevation(sun(GREAT_PHASE.noon))).toBeCloseTo(GREAT.sunAxis, 9);
    expect(GREAT.sunAxis).toBeCloseTo(90 - 23.4, 9);
    // it rises in the north-north-east (23.4 degrees east of north), stands due east at noon and sets in the south-south-east
    const rise = sun(0);
    expect(rise[1]).toBeCloseTo(0, 9);
    expect(Math.atan2(-rise[0], rise[2]) / DEG).toBeCloseTo(23.4, 6);
    const noon = sun(90);
    expect(noon[2]).toBeCloseTo(0, 9);
    expect(noon[0]).toBeLessThan(0);
    const set = sun(180);
    expect(Math.atan2(-set[0], -set[2]) / DEG).toBeCloseTo(23.4, 6);
    for (let p = 0; p < 360; p += 15) expect(sun(p)[0]).toBeLessThan(-0.39);
    // morning before noon, in the north-east; the golden hour and dusk after it, in the south-east
    expect(GREAT_PHASE.dawn).toBeLessThan(GREAT_PHASE.morning);
    expect(GREAT_PHASE.morning).toBeLessThan(90);
    expect(sun(GREAT_PHASE.morning)[2]).toBeGreaterThan(0);
    expect(GREAT_PHASE.golden).toBeGreaterThan(90);
    expect(GREAT_PHASE.dusk).toBeGreaterThan(GREAT_PHASE.golden);
    expect(GREAT_PHASE.dusk).toBeLessThan(180);
    expect(sun(GREAT_PHASE.golden)[2]).toBeLessThan(0);
    // night is two hours after sunset: the sun is well down
    expect(GREAT_PHASE.night).toBe(GREAT.nightPhase);
    expect(elevation(sun(GREAT_PHASE.night))).toBeLessThan(-20);
  });

  it('has an arch whose lit half goes from the north at sunset over the zenith at midnight to the south at sunrise', () => {
    const up = (p: number) => elevation(greatArchLight(p));
    expect(up(180)).toBeCloseTo(45, 9);
    expect(greatArchLight(180)[2]).toBeGreaterThan(0);
    expect(up(270)).toBeCloseTo(90, 9);
    expect(up(360)).toBeCloseTo(45, 9);
    expect(greatArchLight(359.9)[2]).toBeLessThan(0);
    // at the hour called night its middle stands sixty degrees up, due north
    const n = greatArchLight(GREAT_PHASE.night);
    expect(elevation(n)).toBeCloseTo(60, 9);
    expect(n[0]).toBe(0);
    expect(n[2]).toBeGreaterThan(0);
    // by day the preset is the ground's own, with the ring's sun; by night the arch is the light, in place of the moon
    for (const t of ['dawn', 'morning', 'noon', 'golden', 'dusk'] as const) {
      const preset = greatHour(t);
      expect(preset.moon).toBe(false);
      expect(preset).toMatchObject({ sunE: TOD[t].sunE, skyGain: TOD[t].skyGain, exposure: TOD[t].exposure, darkness: TOD[t].darkness, phaseDeg: GREAT_PHASE[t] });
    }
    const night = greatHour('night');
    expect(night.moon).toBe(true);
    expect(night.sunE).toBe(GREAT.archLight);
    expect(night.sunE).toBeGreaterThan(TOD.night.sunE * 1.3);
    expect(night.exposure).toBeLessThan(TOD.night.exposure);
    expect(night.darkness).toBe(1);
  });

  it('is its own environment at every hour: an ordinary sky with the ring to draw across it, clear air, and no day that turns', async () => {
    for (const timeOfDay of HOURS) {
      const plain = await solveEnvironment({ timeOfDay, weather: 'clear' });
      const sol = await solveEnvironment({ timeOfDay, weather: 'clear', orbital: ring });
      expect(envKey(sol.settings)).not.toBe(envKey(plain.settings));
      const look = sol.orbital!;
      expect(look.ring).toEqual(ring);
      expect(look.phase).toBeCloseTo(GREAT_PHASE[timeOfDay], 9);
      expect(look.planetLum).toBe(0);
      expect(look.landSun).toEqual(GREAT.landSun);
      expect(sol.lutB).toBeNull();
      // the true sun is the ring's
      const s = sun(look.phase);
      for (let c = 0; c < 3; c++) expect(sol.trueSunDir[c]).toBeCloseTo(s[c], 6);
      // the sky's bright side is its light's, as under any ordinary sky
      expect(sol.skyAz[0] * sol.sunDir[2] - sol.skyAz[1] * sol.sunDir[0]).toBeCloseTo(0, 6);
      // no moon (the arch is the moon), no aurora, no city
      expect(sol.moonVis).toBe(0);
      expect(sol.aurora).toBe(0);
      expect(sol.city).toEqual([0, 0, 0]);
      // the air of an island: clearer than an ordinary day's by the ring's clarity, and no clearer
      expect(plain.fogDensity / sol.fogDensity).toBeCloseTo(GREAT.clarity, 6);
      // the hour does not turn: any phase asked for is the still hour
      expect(await solveOrbitalHour({ timeOfDay, weather: 'clear', orbital: ring }, 123)).toBe(sol);
      if (timeOfDay !== 'night') {
        expect(sol.tod.moon, timeOfDay).toBe(false);
        for (let c = 0; c < 3; c++) expect(sol.sunDir[c]).toBeCloseTo(sol.trueSunDir[c], 6);
        // the sky is as bright as the ground's at that hour (a whole atmosphere, an open sky)
        expect(sol.skyScale).toBeCloseTo(plain.skyScale, 9);
      }
    }
    const noon = await solveEnvironment({ timeOfDay: 'noon', weather: 'clear', orbital: ring });
    expect(noon.sunElevation / DEG).toBeCloseTo(GREAT.sunAxis, 6);
    expect(noon.darkness).toBe(0);
    expect(lum(noon.sunRadiance)).toBeGreaterThan(0);
  }, 60000);

  it('has a night lit by the arch: a light from the north, sixty degrees up, brighter than a moon; no sun in the sky, most of the stars', async () => {
    const night = await solveEnvironment({ timeOfDay: 'night', weather: 'clear', orbital: ring });
    const moonlit = await solveEnvironment({ timeOfDay: 'night', weather: 'clear' });
    expect(night.tod.moon).toBe(true);
    expect(elevation(night.sunDir)).toBeCloseTo(60, 4);
    expect(night.sunDir[2]).toBeGreaterThan(0.49);
    expect(Math.abs(night.sunDir[0])).toBeLessThan(1e-6);
    expect(night.trueSunDir[1]).toBeLessThan(-0.35);
    expect(night.lightIntensity).toBeCloseTo(GREAT.archLight, 6);
    expect(night.lightIntensity).toBeGreaterThan(moonlit.lightIntensity * 1.3);
    expect(lum(night.sunRadiance)).toBe(0);
    expect(night.darkness).toBe(1);
    expect(night.stars).toBeCloseTo(GREAT.nightStars, 9);
    expect(night.stars).toBeLessThan(moonlit.stars);
    // and in the rain the deck hides the arch and the night is a night
    const wet = await solveEnvironment({ timeOfDay: 'night', weather: 'rain', orbital: ring });
    expect(wet.deck).toBe(1);
    expect(wet.lightIntensity).toBeLessThan(night.lightIntensity * 0.1);
  }, 60000);
});

describe('Halcyon Ring in the menus', () => {
  it('is on the track list with its own name, place and colour: a great ring, raced at golden hour by default, under lights', () => {
    expect(info.name).toBe('Halcyon Ring');
    expect(trackCode(info.name)).toBe('HAL');
    expect(info.location).toMatch(/Tau Ceti/);
    expect(info.orbital?.great).toBe(true);
    expect(info.floodlit).toBe(true);
    expect(info.winter).toBeUndefined();
    expect(info.megacity).toBeUndefined();
    expect(info.defaultTimeOfDay).toBe('golden');
    expect(TRACKS.filter((t) => t.info.orbital?.great).map((t) => t.info.id)).toEqual(['halcyon']);
    expect(TRACKS[TRACKS.length - 1].info.id).toBe('halcyon');
    expect(new Set(TRACKS.map((t) => t.info.color.toLowerCase())).size).toBe(TRACKS.length);
    expect(new Set(TRACKS.map((t) => trackCode(t.info.name))).size).toBe(TRACKS.length);
  });

  it('is the last round of the Xeno Cup: once, at dawn, on a clear day, with nothing in the forecast (a season that began in a golden hour ends in a sunrise)', () => {
    const rounds = CALENDAR.map((c, i) => ({ ...c, i })).filter((c) => c.trackId === 'halcyon');
    expect(rounds.map((r) => [r.i, r.environment.timeOfDay, r.environment.weather, r.forecast ?? 'stable'])).toEqual([[CALENDAR.length - 1, 'dawn', 'clear', 'stable']]);
    expect(CALENDAR[0].environment.timeOfDay).toBe('golden');
    const tracks = TRACKS.map((t) => t.info);
    const def = championshipDef(tracks);
    const last = def.rounds[def.rounds.length - 1];
    expect(last.trackId).toBe('halcyon');
    expect(last.laps.standard).toBe(lapsFor(info.defaultLaps, 'standard'));
    const car = CARS[0];
    const state = createChampionship({
      setup: { carId: car.id, livery: { primary: '#16e0bd', driver: 'Alex' }, difficulty: 'pro', opponents: 7, length: 'standard', startPosition: 'back', grid: 'standings' },
      tracks,
      playerName: 'Alex',
      playerLivery: { ...car.defaultLivery, driver: 'Alex' },
      car,
      seed: 4242,
    });
    expect(isPlayable(state, TRACKS.map((t) => t.info.id), CARS.map((c) => c.id))).toBe(true);
    const cfg = roundConfig(state, def.rounds.length - 1);
    expect(cfg).toMatchObject({ mode: 'race', trackId: 'halcyon', environment: { timeOfDay: 'dawn', weather: 'clear' }, championship: { round: 8, rounds: 8 } });
    expect(cfg.forecast).toBeUndefined();
    // at dawn the sun is up in the north-north-east and the lit half of the arch is the southern one: it stands over Meridian, ahead of the grid
    const s = sun(GREAT_PHASE.dawn);
    expect(s[1]).toBeGreaterThan(0);
    expect(s[2]).toBeGreaterThan(0.8);
  });
});

describe('A pack on Halcyon Ring', () => {
  it('twelve mixed cars race two laps, dry and in standing water, without a reset and hardly a wall', () => {
    for (const [seed, wetness] of [[0, 0], [1, 1]] as const) {
      const r = runPack('halcyon', 'mixed', 'pro', 12, 2, false, { seed, wetness });
      expect(r.finished, `finished, seed ${seed} wet ${wetness}`).toBe(12);
      expect(r.resets, `resets, seed ${seed} wet ${wetness}`).toBe(0);
      expect(r.walls, `wall hits, seed ${seed} wet ${wetness}`).toBeLessThan(6);
      expect(r.offTrack, `seconds off the road, seed ${seed} wet ${wetness}`).toBeLessThan(12);
      // places to pass: Meridian into Kingfisher, the Causeway into Albatross
      expect(r.overtakes, `overtakes, seed ${seed} wet ${wetness}`).toBeGreaterThan(3);
    }
  }, 600000);
});
