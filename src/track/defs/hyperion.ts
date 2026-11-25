/**
 * Hyperion Ring: a grand-prix circuit on the floor of an orbital ring, a rotating habitat in orbit around Saturn, six hundred years
 * from now. The race is a heritage event: the circuit is built the way circuits were (asphalt, kerbs, gravel, armco), in a park of old
 * forest beside the western rim of the ring, and the cars are what they are everywhere else. The floor is flat under the wheels and
 * gravity is 1 g; the world beyond the fences is what is new (see `OrbitalRing`): the land climbs ahead and behind and closes
 * overhead, the rim is a wall of glass, and beyond it are the stars and the planet.
 *
 * Counter-clockwise, 5.28 km, 13-15 m of asphalt, 17 m of relief, eleven corners named for moons of Saturn. The lap (s from the
 * start line; the pits on the left, the main grandstand on the right):
 *
 *   Skyward     1.2 km of start straight due north, along the ring: the land ahead climbs into the sky
 *   Janus       a left of 80 degrees (R55): the heaviest braking of the lap, the first place to pass
 *   Epimetheus  a fast right kink (R150), climbing toward the rim
 *   Pandora     a left of 75 degrees (R100) over the top of the climb
 *   Atlas       the long fast left (60 degrees, R210) onto
 *   the Edge    700 m flat out on the terrace along the rim, 15 m above the park: the glass on the right, Saturn beyond it
 *   Titan       a left of 95 degrees (R140), braking downhill off the terrace
 *   Rhea        a left of 85 degrees (R85) down to the lake
 *   Dione       the hairpin (180 degrees right, R32) on the shore: the best place to pass
 *   Tethys      a left (45 degrees, R120) away from the water
 *   Enceladus   a right and a left (R130) taken in one breath, through the dip
 *   Phoebe      the last corner (135 degrees left, R62): its exit is the whole of Skyward
 *
 * Authored with the turtle layout (corner deflections and edge lengths; the Edge and the edge before Phoebe are solved so that the
 * loop closes), then turned a quarter to the left: the turtle's start straight runs east, the circuit's runs north. The map frame:
 * east = -x, north = +z; the ring's axis is east-west, so north and south are the way the floor curls up; the rim is to the west.
 */
import type { OrbitalRing } from '../../core/contracts';
import type { LayoutReport, TStep } from '../layout';
import { polyLayout, turtleVerts } from '../layout';
import type { Band, BarrierKind, HabitatDef, Key, Pvi, RingFloor, SideStyle, TerrainParams, TrackDef, Zone } from '../types';
import { band, m } from './dsl';

const g = (w: number): Band => band('grass', w);
const gravel = (w: number): Band => band('gravel', w);
const side = (bands: Band[], barrier?: BarrierKind): SideStyle => ({ bands, barrier });
/** The outside of a braking zone: a strip of asphalt, a gravel trap and a tyre wall. */
const trap = (w: number): SideStyle => side([band('asphalt', 3), gravel(w), g(4)], 'tires');

// counter-clockwise: left turns are positive. `len` is the distance from the previous vertex; two edges (free) close the loop.
const steps: TStep[] = [
  { name: 'Janus', defl: 80, r: 55, zoneBefore: 280, zoneAfter: 60, outside: trap(26), inside: side([g(12)]) },
  { name: 'Epimetheus', defl: -35, r: 150, len: 370, zoneBefore: 40, zoneAfter: 40, outside: side([gravel(10), g(6)]) },
  { name: 'Pandora', defl: 75, r: 100, len: 330, zoneBefore: 110, zoneAfter: 50, outside: trap(18), inside: side([g(10)]) },
  { name: 'Atlas', defl: 60, r: 210, len: 370, zoneBefore: 40, zoneAfter: 40, outside: side([band('asphalt', 4), gravel(12), g(4)], 'tires') },
  { name: 'Titan', defl: 95, r: 140, free: true, zoneBefore: 200, zoneAfter: 60, outside: trap(24), inside: side([g(12)]) },
  { name: 'Rhea', defl: 85, r: 85, len: 400, zoneBefore: 110, zoneAfter: 50, outside: trap(18), inside: side([g(10)]) },
  // the Dione hairpin: two halves of 90 degrees joined without a transition = one arc of 180 degrees
  { name: 'Dione', defl: -90, r: 32, lsIn: 26, lsOut: 0, len: 480, zoneBefore: 230, zoneAfter: 0, outside: trap(22), inside: side([g(6)]) },
  { name: 'Dione2', defl: -90, r: 32, lsIn: 0, lsOut: 26, len: 'join', zoneBefore: 0, zoneAfter: 60, outside: side([band('asphalt', 3), gravel(10), g(4)], 'tires'), inside: side([g(6)]) },
  { name: 'Tethys', defl: 45, r: 120, len: 400, zoneBefore: 60, zoneAfter: 40, outside: side([gravel(10), g(6)], 'tires') },
  { name: 'Enceladus1', defl: -32, r: 130, len: 260, zoneBefore: 40, zoneAfter: 20, outside: side([gravel(8), g(6)]) },
  { name: 'Enceladus2', defl: 32, r: 130, len: 200, zoneBefore: 20, zoneAfter: 40, outside: side([gravel(8), g(6)]) },
  { name: 'Phoebe', defl: 'auto', r: 62, free: true, zoneBefore: 150, zoneAfter: 50, outside: trap(20), inside: side([g(10)]) },
];

/** The turtle's map turned a quarter to the left: its east is the circuit's north, its north the circuit's west. */
const verts = turtleVerts(steps, { mainLen: 1420, origin: { e: 720, n: 0 }, dir: 1 }).map((v) => ({ ...v, e: -v.n, n: v.e }));
export const hyperionLayout: LayoutReport = polyLayout(verts, { sfAfterLastCorner: 300 });

// ── the ring ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A floor 22.4 km from the axis turns once in five minutes for 1 g (g = w^2 r): a day and a night of the ring last five minutes
// together. The band of land is 6 km wide; the circuit lies beside its western rim. World x = -east.
const RING_RADIUS = 22400;
/** The floor's level under the circuit (m). */
const FLOOR = 20;
/** The lowest line of the floor: half way between the circuit's north and south ends. */
const RING_Z = 190;
/** The rims: 240 m west of the Edge, and 4.8 km east of the start straight. */
const RIMS: [number, number] = [-4800, 1160];

export const hyperionRing: OrbitalRing = { radius: RING_RADIUS, z: RING_Z, y: FLOOR, rims: RIMS, canopy: 2600 };
const ringFloor: RingFloor = { radius: RING_RADIUS, z: RING_Z, flat: 980, full: 2600, rims: RIMS, berm: 17, bermW: 330 };

/** Bank for one corner: ramps in over the entry clothoid, constant on the arc, ramps out (left turns negative). */
function cornerBank(name: string, deg: number): Key[] {
  return [{ at: m(name), v: 0 }, { at: m(name + '/a'), v: deg }, { at: m(name + '/b'), v: deg }, { at: m(name + '/e'), v: 0 }];
}
const bank: Key[] = [
  ...cornerBank('Janus', -2),
  ...cornerBank('Epimetheus', 2),
  ...cornerBank('Pandora', -3),
  ...cornerBank('Atlas', -3.5),
  ...cornerBank('Titan', -4),
  ...cornerBank('Rhea', -3),
  // the hairpin's clothoids are short: the bank is spread over 10 m of straight on either side
  { at: m('Dione', -10), v: 0 },
  { at: m('Dione/a'), v: 2.5 },
  { at: m('Dione2/b'), v: 2.5 },
  { at: m('Dione2/e', 10), v: 0 },
  ...cornerBank('Tethys', -2.5),
  ...cornerBank('Enceladus1', 2),
  ...cornerBank('Enceladus2', -2),
  ...cornerBank('Phoebe', -3),
];

// asphalt half-widths: 7.5 m (15 m) on Skyward and into Janus, 7 m round the rest, 6.5 m from the lake to the last corner
const widths = (): Key[] => [
  { at: m('main0', 60), v: 7.5 },
  { at: m('Janus/e'), v: 7.5 },
  { at: m('S1', 80), v: 7 },
  { at: m('Rhea/e'), v: 7 },
  { at: m('S6', 80), v: 6.5 },
  { at: m('Dione', -40), v: 6.5 },
  { at: m('Dione/a'), v: 7.5 },
  { at: m('Dione2/b'), v: 7.5 },
  { at: m('S8', 60), v: 6.5 },
  { at: m('Enceladus2/e'), v: 6.5 },
  { at: m('Phoebe/a'), v: 7 },
  { at: m('Phoebe/e'), v: 7 },
];

// elevation: the park is level (the floor of a ring is as flat as its builders wanted it), and the rim stands on a bank: the road climbs
// 15 m from Janus to the terrace of the Edge, comes down through Titan and Rhea to the lake, and dips once more before the last corner
const pvi: Pvi[] = [
  { at: m('main0', 140), y: 20.0, vc: 100 },
  { at: m('main', 500), y: 20.4, vc: 160 },
  { at: m('Janus'), y: 21.0, vc: 80 },
  { at: m('S1', 60), y: 22.6, vc: 80 },
  { at: m('Epimetheus/m'), y: 25.6, vc: 80 },
  { at: m('Pandora/m'), y: 30.6, vc: 90 },
  { at: m('Atlas/a'), y: 33.4, vc: 90 },
  { at: m('Atlas/e'), y: 35.0, vc: 100 },
  { at: m('S4/m'), y: 35.7, vc: 240 },
  { at: m('Titan', -70), y: 35.0, vc: 80 },
  { at: m('Titan/m'), y: 31.4, vc: 100 },
  { at: m('Rhea', -30), y: 26.4, vc: 70 },
  { at: m('Rhea/m'), y: 23.4, vc: 70 },
  { at: m('S6/m'), y: 21.4, vc: 120 },
  { at: m('Dione', -30), y: 20.9, vc: 50 },
  { at: m('Dione2/e', 30), y: 21.3, vc: 50 },
  { at: m('S8/m'), y: 21.0, vc: 80 },
  { at: m('Tethys/m'), y: 20.0, vc: 80 },
  { at: m('Enceladus1/m'), y: 18.7, vc: 70 },
  { at: m('Enceladus2/m'), y: 18.5, vc: 70 },
  { at: m('Phoebe/a'), y: 19.2, vc: 60 },
  { at: m('Phoebe/e'), y: 20.0, vc: 60 },
];

const zones: Zone[] = [
  // Skyward: the pit wall on the left (the pit lane and the garages stand behind it), a concrete apron and the catch fence in front of
  // the main grandstand on the right
  { side: 'L', from: m('main0', 30), to: m('main', 340), bands: [band('asphalt', 3.5)], barrier: 'concrete' },
  { side: 'R', from: m('main0', 30), to: m('main', 440), bands: [band('concrete', 5)], barrier: 'fence' },
  // the Edge: a white wall on the rim side (beyond it the bank climbs to the glass), a wide verge toward the park
  { side: 'R', from: m('Atlas/e', 30), to: m('Titan', -210), bands: [g(4)], barrier: 'concrete' },
  { side: 'L', from: m('Atlas/e', 30), to: m('Titan', -210), bands: [g(9)], barrier: 'armco' },
];

// The floor of the ring: level parkland with the gentlest of swells, a lake inside the circuit (between the start straight and the
// hairpin), and the ring itself: the ground curls up to the north and south and ends in a bank at each rim. No mountains: the
// horizon is the rest of the world.
const terrain: TerrainParams = {
  seed: 2626,
  ring: ringFloor,
  base: FLOOR,
  hillAmp: 3.2,
  hillScale: 420,
  detailAmp: 0.5,
  detailScale: 36,
  // Lake Huygens (world x = -east)
  lake: { x: 232, z: 250, rx: 150, rz: 235, rot: 0.1, level: 17.6, depth: 9, shore: 45 },
  reach: 90,
  falloff: 60,
  xfade: 6,
};

// The built world beyond the fences (world x = -east, z = north): white, glass, gardens and a little gold.
const habitat: HabitatDef = {
  // the foot of the western rim's glass: 4 km of plinth each way along the turn of the ring, a pier under every rib, and two
  // galleries opposite the Edge (its middle, and the braking for Titan)
  rim: {
    side: 1,
    reach: 4080,
    galleries: [
      { at: 120, length: 170 },
      { at: -360, length: 110 },
    ],
  },
  // the stalks: east and north-east of the circuit on the open land beyond the main grandstand, one ahead on each long straight
  // where the land has begun to climb (they lean with it); none to the west, where the rim is
  stalks: [
    // the Hyperion stalk: ahead and to the right all the way down Skyward
    { x: -520, z: 2350, height: 1100, landmark: true, tiers: [{ kind: 'dish', at: 0.27, r: 150 }, { kind: 'dish', at: 0.47, r: 112 }, { kind: 'halo', at: 0.66, r: 96 }, { kind: 'dish', at: 0.81, r: 58 }, { kind: 'collar', at: 0.92, r: 24 }] },
    // beyond the main grandstand
    { x: -820, z: 150, height: 640, tiers: [{ kind: 'dish', at: 0.42, r: 88 }, { kind: 'dish', at: 0.68, r: 58 }, { kind: 'collar', at: 0.87, r: 21 }] },
    { x: -1700, z: 1100, height: 820, tiers: [{ kind: 'collar', at: 0.3, r: 36 }, { kind: 'dish', at: 0.53, r: 108 }, { kind: 'halo', at: 0.75, r: 68 }] },
    { x: -2600, z: -200, height: 900, tiers: [{ kind: 'dish', at: 0.36, r: 120 }, { kind: 'dish', at: 0.58, r: 84 }, { kind: 'dish', at: 0.78, r: 52 }] },
    { x: -1500, z: -1100, height: 560, tiers: [{ kind: 'dish', at: 0.5, r: 80 }, { kind: 'collar', at: 0.76, r: 21 }] },
    { x: -2300, z: 2600, height: 680, tiers: [{ kind: 'collar', at: 0.34, r: 30 }, { kind: 'dish', at: 0.6, r: 90 }] },
    // ahead on the Edge, where the land climbs to the south
    { x: 250, z: -2700, height: 760, tiers: [{ kind: 'dish', at: 0.4, r: 100 }, { kind: 'halo', at: 0.63, r: 74 }, { kind: 'collar', at: 0.86, r: 21 }] },
    { x: -350, z: -2000, height: 480, tiers: [{ kind: 'dish', at: 0.56, r: 70 }, { kind: 'collar', at: 0.82, r: 17 }] },
    // far ahead on Skyward, to the left of the road
    { x: 500, z: 3700, height: 700, tiers: [{ kind: 'dish', at: 0.45, r: 95 }, { kind: 'dish', at: 0.71, r: 58 }] },
  ],
  // the settlements: on the north shore of Lake Huygens, in the park inside the circuit, beyond the run-off of Janus, of Pandora
  // and of Phoebe, round the foot of the nearest stalk, and one far out to the east
  settlements: [
    { x: 245, z: 590, r: 112, count: 34 },
    { x: 715, z: 420, r: 118, count: 36 },
    { x: 40, z: 1215, r: 150, count: 44 },
    { x: 770, z: 1370, r: 130, count: 34 },
    { x: 230, z: -990, r: 140, count: 40 },
    { x: -570, z: 250, r: 190, count: 54 },
    { x: -1750, z: -450, r: 210, count: 56, spire: 52 },
  ],
};

export const hyperion: TrackDef = {
  info: {
    id: 'hyperion',
    name: 'Hyperion Ring',
    location: 'Hyperion Orbital, Saturn',
    description:
      'A heritage circuit on the floor of an orbital ring, six hundred years from now: a start straight toward land that climbs into the sky, a terrace flat out along the glass rim with Saturn beyond it, a hairpin on the shore of a lake, and a day that lasts five minutes.',
    difficulty: 3,
    defaultLaps: 3,
    defaultTimeOfDay: 'golden',
    lengthHint: 5280,
    color: '#5d7bff',
    floodlit: true,
    orbital: hyperionRing,
  },
  seed: 26260,
  dir: 1,
  plan: hyperionLayout.plan,
  start: hyperionLayout.start,
  pvi,
  bank,
  widthL: widths(),
  widthR: widths(),
  crown: 0.015,
  defaults: { bandsL: [g(6)], bandsR: [g(6)], barrierL: 'armco', barrierR: 'armco', cross: -0.03 },
  zones,
  sectors: [m('Atlas/e'), m('Dione2/e')],
  terrain,
  scenery: {
    stands: [
      { at: m('main', 215), length: 340, side: 'R', gap: 13, rows: 22, roof: true },
      { at: m('Janus', -90), length: 150, side: 'R', gap: 40, rows: 14, roof: false },
      { at: m('Dione', -110), length: 140, side: 'L', gap: 36, rows: 12, roof: false },
    ],
    pits: { from: m('main0', 40), to: m('main', 360), side: 'L' },
    gantry: m('main'),
    bridges: [
      { at: m('main', 560), brand: 2 },
      { at: m('S6', 150), brand: 6 },
    ],
    marshals: ['Janus', 'Epimetheus', 'Pandora', 'Atlas', 'Titan', 'Rhea', 'Dione2', 'Tethys', 'Enceladus2', 'Phoebe'],
    boards: [
      { at: m('Janus', -150), side: 'R', gap: 34, brand: 0 },
      { at: m('Pandora', 30), side: 'R', gap: 28, brand: 5 },
      { at: m('Titan', 40), side: 'R', gap: 32, brand: 7 },
      { at: m('Phoebe', 20), side: 'R', gap: 30, brand: 3 },
    ],
    brakeBoards: [
      { corner: 'Janus', dist: [300, 200, 150, 100, 50] },
      { corner: 'Pandora', dist: [100, 50] },
      { corner: 'Titan', dist: [200, 150, 100, 50] },
      { corner: 'Rhea', dist: [100, 50] },
      { corner: 'Dione', dist: [200, 150, 100, 50] },
      { corner: 'Phoebe', dist: [150, 100, 50] },
    ],
    // floodlight masts on the grandstand side of Skyward (the pit side carries the start-straight TV camera), and round the two
    // slowest corners; the rest of the lap is lit by the land overhead
    lamps: [
      { from: m('main0', 40), to: m('Janus', -30), spacing: 38, side: 'R' },
      { from: m('Dione', -200), to: m('Dione2/e', 60), spacing: 36, side: 'L' },
      { from: m('Phoebe', -120), to: m('Phoebe/e', 20), spacing: 36, side: 'R' },
    ],
    // the old forest of the park: oak before anything else
    vegetation: {
      species: [['oak', 0.5], ['birch', 0.2], ['pine', 0.18], ['poplar', 0.12]],
      density: 2.0,
      forestThreshold: -0.12,
      forestScale: 260,
      clearance: 2.4,
      ramp: 10,
      reach: 260,
      slopeMax: 0.9,
      scale: 16,
    },
    habitat,
  },
};
