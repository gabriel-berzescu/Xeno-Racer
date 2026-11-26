/**
 * Halcyon Ring: a grand-prix circuit on an atoll of a great orbital ring, six thousand years from now. The ring (an Orbital) is 3.7
 * million kilometres across and turns once in twenty-four hours, which is what makes its floor weigh 1 g: it orbits its star as a
 * planet does, the ground is flat as far as the eye can tell, the sky is a sky, and the rest of the world is an arch across it (see
 * `OrbitalRing.great`). The race is a heritage event, as on Hyperion Ring: asphalt, kerbs, armco, and the cars of six thousand years
 * ago. The atoll is a ring of land round a lagoon, and the circuit goes round it.
 *
 * Clockwise, 5.47 km, 13-15 m of asphalt, 23 m of relief, eleven corners named for birds (and for a beach). The lap (s from the start line; the pits on
 * the right, the main grandstand on the left with the sea behind it):
 *
 *   Meridian    the start straight, due south down the east shore of the lagoon
 *   Kingfisher  a right of 90 degrees (R55): the heaviest braking but one, the first place to pass
 *   the Strand  800 m along the south beach, bending left all the way with the crescent of the bay, the wash forty metres off
 *   Sandpiper   a left kink (R170) out toward the point
 *   Curlew      the long right (98 degrees, R70) round the south-west point
 *   Tern        a fast right (R260) onto
 *   the Causeway  1.2 km due north across the water, the lagoon on the right and the open sea on the left: the arch of the world
 *               stands on the horizon ahead and goes up over the road
 *   Albatross   a right of 95 degrees (R48) at the end of it: the heaviest braking of the lap, the best place to pass
 *   Petrel      a left (R115) climbing the headland
 *   Osprey      the long right (115 degrees, R85) over the top of the cliff, 26 m above the sea
 *   Jackdaw     three fast bends (left, right, left: R145-150) down through the old wood, between trees a hundred metres tall
 *   Heron       the last corner (a right of 80 degrees, R60): its exit is the whole of Meridian
 *
 * Authored with the turtle layout (corner deflections and edge lengths; the Causeway and the edge before Heron are solved so that the
 * loop closes), then turned a quarter to the right: the turtle's start straight runs east, the circuit's runs south. The map frame:
 * east = -x, north = +z; the ring's axis is east-west, so north and south are the two ways round the ring, and the arch stands there.
 */
import type { OrbitalRing } from '../../core/contracts';
import type { LayoutReport, TStep } from '../layout';
import { polyLayout, turtleVerts } from '../layout';
import type { Band, BarrierKind, Key, OceanDef, Pvi, SideStyle, TerrainParams, TrackDef, Zone } from '../types';
import { band, m } from './dsl';
import { halcyonFleet } from './halcyonFleet';
import { halcyonGiants } from './halcyonGiants';

const g = (w: number): Band => band('grass', w);
const gravel = (w: number): Band => band('gravel', w);
const sand = (w: number): Band => band('sand', w);
const side = (bands: Band[], barrier?: BarrierKind): SideStyle => ({ bands, barrier });
/** The outside of a braking zone: a strip of asphalt, a gravel trap and a tyre wall. */
const trap = (w: number): SideStyle => side([band('asphalt', 3), gravel(w)], 'tires');
/** The same on the beach: the trap is the beach's own sand. */
const dune = (w: number): SideStyle => side([band('asphalt', 3), sand(w)], 'tires');

// clockwise: right turns are negative. `len` is the distance from the previous vertex; two edges (free) close the loop.
const steps: TStep[] = [
  { name: 'Kingfisher', defl: -90, r: 55, zoneBefore: 260, zoneAfter: 60, outside: trap(26), inside: side([g(12)]) },
  // (the Strand is one long bend, flat out, along the crescent of the bay)
  { name: 'Strand', defl: 20, r: 900, len: 470, curbIn: 'none', curbOut: 'none', zoneBefore: 0, zoneAfter: 0 },
  { name: 'Sandpiper', defl: 18, r: 170, len: 440, zoneBefore: 60, zoneAfter: 40, outside: side([g(3), sand(11)]), inside: side([g(8)]) },
  { name: 'Curlew', defl: -98, r: 70, len: 310, zoneBefore: 150, zoneAfter: 60, outside: dune(20), inside: side([g(10)]) },
  { name: 'Tern', defl: -30, r: 260, len: 330, zoneBefore: 40, zoneAfter: 30, outside: side([band('asphalt', 3), sand(8)], 'tires') },
  { name: 'Albatross', defl: -95, r: 48, free: true, zoneBefore: 300, zoneAfter: 60, outside: trap(30), inside: side([g(10)]) },
  { name: 'Petrel', defl: 55, r: 115, len: 330, zoneBefore: 60, zoneAfter: 40, outside: side([gravel(10), g(4)], 'tires') },
  { name: 'Osprey', defl: -115, r: 85, len: 300, zoneBefore: 90, zoneAfter: 50, outside: trap(16), inside: side([g(10)]) },
  { name: 'Jackdaw1', defl: 42, r: 145, len: 330, zoneBefore: 40, zoneAfter: 20, outside: side([gravel(9), g(4)]) },
  { name: 'Jackdaw2', defl: -42, r: 145, len: 250, zoneBefore: 20, zoneAfter: 20, outside: side([gravel(9), g(4)]) },
  { name: 'Jackdaw3', defl: 55, r: 150, len: 240, zoneBefore: 20, zoneAfter: 30, outside: side([gravel(9), g(4)]) },
  { name: 'Heron', defl: 'auto', r: 60, free: true, zoneBefore: 120, zoneAfter: 50, outside: trap(20), inside: side([g(10)]) },
];

/** The turtle's map turned a quarter to the right: its east is the circuit's south, its north the circuit's east. */
const verts = turtleVerts(steps, { mainLen: 950, origin: { e: 0, n: 0 }, dir: -1 }).map((v) => ({ ...v, e: v.n, n: -v.e }));
export const halcyonLayout: LayoutReport = polyLayout(verts, { sfAfterLastCorner: 320 });

// ── the ring ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A floor that turns once in 24 hours weighs 1 g at 1.855 million km from the axis (g = w^2 r, the same sum that gives Hyperion
// Ring its day of five minutes at 22.4 km). The band of land and sea is 32 000 km wide; the atoll lies 12 000 km from its eastern
// edge. World x = -east.
const RING_RADIUS = 1.855e9;
/** The sea. */
const SEA = 0;
export const halcyonRing: OrbitalRing = { radius: RING_RADIUS, z: 0, y: SEA, rims: [-1.2e7, 2.0e7], canopy: 0, great: true };

/** Bank for one corner: ramps in over the entry clothoid, constant on the arc, ramps out (right turns positive). */
function cornerBank(name: string, deg: number): Key[] {
  return [{ at: m(name), v: 0 }, { at: m(name + '/a'), v: deg }, { at: m(name + '/b'), v: deg }, { at: m(name + '/e'), v: 0 }];
}
const bank: Key[] = [
  ...cornerBank('Kingfisher', 2),
  ...cornerBank('Strand', -1),
  ...cornerBank('Sandpiper', -2),
  ...cornerBank('Curlew', 3),
  ...cornerBank('Tern', 2.5),
  ...cornerBank('Albatross', 2),
  ...cornerBank('Petrel', -3),
  ...cornerBank('Osprey', 4),
  ...cornerBank('Jackdaw1', -2.5),
  ...cornerBank('Jackdaw2', 2.5),
  ...cornerBank('Jackdaw3', -2.5),
  ...cornerBank('Heron', 3),
];

// asphalt half-widths: 7.5 m (15 m) on Meridian and into Kingfisher, 7 m round the beach, 7.5 m on the Causeway and into Albatross,
// 6.5 m over the headland and down through the wood
const widths = (): Key[] => [
  { at: m('main0', 60), v: 7.5 },
  { at: m('Kingfisher/e'), v: 7.5 },
  { at: m('S1', 60), v: 7 },
  { at: m('Tern'), v: 7 },
  { at: m('Tern/e'), v: 7.5 },
  { at: m('Albatross/e'), v: 7.5 },
  { at: m('S6', 60), v: 6.5 },
  { at: m('Jackdaw3/e'), v: 6.5 },
  { at: m('Heron/a'), v: 7 },
  { at: m('Heron/e'), v: 7 },
];

// elevation (the sea is 0): Meridian 7 m up on the shore of the lagoon, down to the beach (the Strand is 3 m above the wash), the
// Causeway level at 3 m, then the climb from Albatross over the headland (26 m at the top of Osprey) and down through the wood
const pvi: Pvi[] = [
  { at: m('main0', 150), y: 7.0, vc: 100 },
  { at: m('main', 380), y: 7.0, vc: 120 },
  { at: m('Kingfisher'), y: 6.3, vc: 80 },
  { at: m('Kingfisher/e', 30), y: 4.4, vc: 70 },
  { at: m('Strand/a'), y: 3.2, vc: 120 },
  { at: m('Sandpiper/m'), y: 3.0, vc: 80 },
  { at: m('Curlew/m'), y: 3.5, vc: 80 },
  { at: m('Tern/m'), y: 3.2, vc: 80 },
  { at: m('S5', 160), y: 3.0, vc: 120 },
  { at: m('Albatross', -160), y: 3.0, vc: 120 },
  { at: m('Albatross/m'), y: 3.9, vc: 60 },
  { at: m('S6/m'), y: 8.2, vc: 80 },
  { at: m('Petrel/m'), y: 14.0, vc: 80 },
  { at: m('Osprey/a'), y: 22.2, vc: 50 },
  { at: m('Osprey/m'), y: 26.2, vc: 70 },
  { at: m('Osprey/e'), y: 25.4, vc: 80 },
  { at: m('Jackdaw1/m'), y: 21.8, vc: 90 },
  { at: m('Jackdaw2/m'), y: 16.4, vc: 90 },
  { at: m('Jackdaw3/m'), y: 11.6, vc: 90 },
  { at: m('Heron/m'), y: 8.6, vc: 70 },
  { at: m('Heron/e', 50), y: 7.3, vc: 80 },
];

const zones: Zone[] = [
  // Meridian: the pit wall on the right (the pit lane and the garages stand behind it, on the shore of the lagoon), a concrete apron
  // and the catch fence in front of the main grandstand on the left
  { side: 'R', from: m('main0', 30), to: m('main', 300), bands: [band('asphalt', 3.5)], barrier: 'concrete' },
  { side: 'L', from: m('main0', 30), to: m('main', 380), bands: [band('concrete', 5)], barrier: 'fence' },
  // the Strand: the beach is the run-off on the left, a verge and the armco on the lagoon side
  { side: 'L', from: m('Kingfisher/e', 70), to: m('Sandpiper', -70), bands: [g(2.5), sand(7)], barrier: 'armco' },
  // the Causeway: paved from rail to rail, a low rail on each side and the water beyond it
  { side: 'B', from: m('Tern/e', 40), to: m('Albatross', -310), bands: [band('concrete', 3.2)], barrier: 'guardrail' },
];

// Rocks and islets in the sea (world x = -east, z = north; the start straight is near x = 0, the Causeway near x = 1300, the Strand
// near z = 0 and the headland near z = 1550): stacks under the cliff of the headland, one off the south-west point and one off the
// east shore, and low sandy islets on the reef to the south and far out to the west.
const ISLETS: NonNullable<OceanDef['islets']> = [
  { x: 770, z: 1715, r: 30, h: 36, sheer: 0.9 },
  { x: 850, z: 1780, r: 17, h: 22, sheer: 0.92 },
  { x: 610, z: 1690, r: 22, h: 27, sheer: 0.9 },
  { x: 1030, z: 1800, r: 38, h: 30, sheer: 0.8 },
  { x: -230, z: 1390, r: 44, h: 40, sheer: 0.82 },
  { x: -330, z: 520, r: 24, h: 15, sheer: 0.85 },
  { x: 1270, z: -420, r: 28, h: 19, sheer: 0.88 },
  { x: 330, z: -470, r: 80, h: 4.6, sheer: 0.1 },
  { x: 700, z: -610, r: 120, h: 5.4, sheer: 0.1 },
  { x: -130, z: -430, r: 60, h: 4.2, sheer: 0.1 },
  { x: 1980, z: 640, r: 135, h: 6, sheer: 0.1 },
  { x: 2120, z: 1210, r: 70, h: 4.4, sheer: 0.1 },
];

// The atoll: a ring of land round a lagoon, low and sandy to the south and east, a headland of rock with the old wood on it to the
// north. The land is the ground beside the road (widths from the centreline; the right of the road is the inside of the circuit, the
// lagoon; the left is the open sea), and where it is narrow the road is a causeway.
const ocean: OceanDef = {
  level: SEA,
  outside: 'L',
  left: [
    { at: m('main0', 100), v: 165 },
    { at: m('main', 420), v: 150 },
    { at: m('Kingfisher/m'), v: 150 },
    { at: m('Strand/a'), v: 64 },
    { at: m('Strand/b'), v: 60 },
    { at: m('Sandpiper'), v: 66 },
    { at: m('Curlew/m'), v: 105 },
    { at: m('Tern/a'), v: 60 },
    { at: m('Tern/e', 60), v: 23 },
    { at: m('Albatross', -360), v: 23 },
    { at: m('Albatross', -120), v: 120 },
    { at: m('Albatross/e'), v: 105 },
    { at: m('Petrel/m'), v: 70 },
    { at: m('Osprey/m'), v: 64 },
    { at: m('Jackdaw1/m'), v: 150 },
    { at: m('Jackdaw2/m'), v: 250 },
    { at: m('Jackdaw3/m'), v: 240 },
    { at: m('Heron/m'), v: 190 },
  ],
  right: [
    { at: m('main0', 100), v: 185 },
    { at: m('main', 420), v: 170 },
    { at: m('Kingfisher/m'), v: 150 },
    { at: m('Strand/a'), v: 100 },
    { at: m('Strand/b'), v: 105 },
    { at: m('Sandpiper'), v: 100 },
    { at: m('Curlew/m'), v: 90 },
    { at: m('Tern/a'), v: 50 },
    { at: m('Tern/e', 60), v: 23 },
    { at: m('Albatross', -360), v: 23 },
    { at: m('Albatross', -120), v: 60 },
    { at: m('Albatross/e'), v: 95 },
    { at: m('Petrel/m'), v: 170 },
    { at: m('Osprey/m'), v: 250 },
    { at: m('Jackdaw1/m'), v: 300 },
    { at: m('Jackdaw2/m'), v: 300 },
    { at: m('Jackdaw3/m'), v: 270 },
    { at: m('Heron/m'), v: 220 },
  ],
  rise: {
    // beaches to the south and east, the rock of the Causeway's shoulders, and the cliff under the headland
    left: [
      { at: m('main0', 100), v: 0.07 },
      { at: m('Tern/a'), v: 0.07 },
      { at: m('Tern/e', 60), v: 0.5 },
      { at: m('Albatross', -360), v: 0.5 },
      { at: m('Albatross/m'), v: 0.16 },
      { at: m('Petrel/a'), v: 0.5 },
      { at: m('Petrel/m'), v: 1.1 },
      { at: m('Osprey/e'), v: 1.1 },
      { at: m('Jackdaw2/m'), v: 0.3 },
      { at: m('Heron/m'), v: 0.1 },
    ],
    right: [
      { at: m('main0', 100), v: 0.08 },
      { at: m('Tern/a'), v: 0.07 },
      { at: m('Tern/e', 60), v: 0.5 },
      { at: m('Albatross', -360), v: 0.5 },
      { at: m('Albatross/m'), v: 0.12 },
      { at: m('Osprey/m'), v: 0.22 },
      { at: m('Heron/m'), v: 0.12 },
    ],
  },
  // the lagoon is five metres deep at its deepest and shelves slowly; the sea falls away to twenty-two
  bed: { left: [22, 0.085], right: [5.2, 0.028] },
  warp: [34, 300],
  // rocks off the headland and off the south-west point, and three motus on the reef south of the Strand
  islets: ISLETS,
};

/** The sea, for whoever dresses it (the water is at this level everywhere). */
export const HALCYON_SEA = SEA;

const terrain: TerrainParams = {
  seed: 8026,
  ocean,
  base: 5.2,
  hillAmp: 3.4,
  hillScale: 360,
  detailAmp: 0.45,
  detailScale: 34,
  // the headland: a hill of rock under the old wood, inside the long right over the cliff and down the esses
  bumpsAt: [
    { at: m('Osprey/m'), d: -150, r: 250, h: 24 },
    { at: m('Jackdaw1/m'), d: -40, r: 230, h: 12 },
    { at: m('Jackdaw2/m'), d: 90, r: 240, h: 9 },
    { at: m('Petrel/m'), d: -110, r: 170, h: 9 },
  ],
  reach: 70,
  falloff: 44,
  xfade: 6,
};

export const halcyon: TrackDef = {
  info: {
    id: 'halcyon',
    name: 'Halcyon Ring',
    location: 'Halcyon Orbital, Tau Ceti',
    description:
      'A heritage circuit on an atoll of a great orbital ring, six thousand years from now: a beach, a causeway flat out across the lagoon toward the arch of the world, a cliff top over the sea and three fast bends down through a wood of trees a hundred metres tall.',
    difficulty: 3,
    defaultLaps: 3,
    defaultTimeOfDay: 'golden',
    lengthHint: 5470,
    color: '#8fe36a',
    floodlit: true,
    orbital: halcyonRing,
  },
  seed: 80260,
  dir: -1,
  plan: halcyonLayout.plan,
  start: halcyonLayout.start,
  pvi,
  bank,
  widthL: widths(),
  widthR: widths(),
  crown: 0.015,
  defaults: { bandsL: [g(6)], bandsR: [g(6)], barrierL: 'armco', barrierR: 'armco', cross: -0.03 },
  zones,
  sectors: [m('Tern/e'), m('Osprey/e')],
  terrain,
  scenery: {
    stands: [
      { at: m('main', 190), length: 330, side: 'L', gap: 13, rows: 22, roof: true },
      { at: m('Kingfisher', -90), length: 150, side: 'L', gap: 40, rows: 14, roof: false },
      { at: m('Albatross', -70), length: 120, side: 'L', gap: 44, rows: 12, roof: false },
    ],
    pits: { from: m('main0', 40), to: m('main', 320), side: 'R' },
    gantry: m('main'),
    bridges: [{ at: m('main', 480), brand: 2 }],
    marshals: ['Kingfisher', 'Sandpiper', 'Curlew', 'Tern', 'Albatross', 'Petrel', 'Osprey', 'Jackdaw1', 'Jackdaw3', 'Heron'],
    boards: [
      { at: m('Kingfisher', -150), side: 'L', gap: 34, brand: 0 },
      { at: m('Curlew', 30), side: 'L', gap: 26, brand: 5 },
      { at: m('Albatross', 40), side: 'L', gap: 36, brand: 7 },
      { at: m('Heron', 20), side: 'L', gap: 28, brand: 3 },
    ],
    brakeBoards: [
      { corner: 'Kingfisher', dist: [300, 200, 150, 100, 50] },
      { corner: 'Curlew', dist: [150, 100, 50] },
      { corner: 'Albatross', dist: [300, 200, 150, 100, 50] },
      { corner: 'Osprey', dist: [100, 50] },
      { corner: 'Heron', dist: [150, 100, 50] },
    ],
    // floodlight masts all the way round (the nights of a great ring are bright, but a race in the rain is not). On Meridian the
    // grandstand side only (the pit side carries the start-straight TV camera); staggered from side to side everywhere else
    lamps: [
      { from: m('main0', 40), to: m('Kingfisher', -30), spacing: 38, side: 'L' },
      { from: m('Kingfisher', -20), to: m('Heron/e', 20), spacing: 46, side: 'B', stagger: true },
    ],
    // the low island: palms first, with broadleaves and pines behind the beaches (the old wood is the giants')
    vegetation: {
      species: [['palm', 0.42], ['oak', 0.32], ['pine', 0.16], ['poplar', 0.1]],
      density: 1.25,
      forestThreshold: -0.1,
      forestScale: 240,
      clearance: 2.4,
      ramp: 10,
      reach: 260,
      slopeMax: 0.8,
      scale: 15,
    },
    giants: halcyonGiants,
    fleet: halcyonFleet,
  },
};
