/**
 * Xenon Ring: a grand-prix circuit through a megacity after dark, between towers of light, on boulevards closed for the race.
 * Clockwise, 4.82 km, 13-15 m of asphalt between concrete walls and catch fences, 34 m of relief (the city stands on a slope: the
 * Strip uptown at +44 m, the Datastream in the lower city at +11 m), fourteen corners. The lap (s from the start line; the pits on
 * the left, the main grandstand on the right):
 *
 *   Strip       950 m of boulevard between the towers, under the start ring, into
 *   Chrome      a right of 90 degrees (R45): the heaviest braking of the lap, the first place to pass
 *   Flux        a left and a right (R125), downhill between the blocks, then 320 m down to
 *   Spire       the long fast right (90 degrees, R170) round the foot of the tallest tower, onto
 *   Datastream  650 m flat out through the lower city, 320 m of it in the Conduit, the tunnel under the arcology, ring after ring of light
 *   Halo        the banked carousel (180 degrees, R95, 8 degrees of bank), climbing as it turns
 *   Arcade      270 m to the hairpin (165 degrees, R24) of the arcade district: the best place to pass
 *   Synapse     a right and a left (R150) taken in one breath, climbing
 *   Kernel      a right (75 degrees, R80) onto the avenue uptown, where Ghost is a left-right flick (R160)
 *   Neon        the last corner (90 degrees, R70): its exit is the whole Strip
 *
 * Authored with the turtle layout (corner deflections and edge lengths; the Datastream and the edge before Neon are solved so that
 * the loop closes). The map frame: east = -x, north = +z; the Strip runs east along north = 0 and everything else lies south of it.
 */
import type { LayoutReport, TStep } from '../layout';
import { polyLayout, turtleVerts } from '../layout';
import type { Band, BarrierKind, Key, Pvi, SideStyle, TerrainParams, TrackDef, Zone } from '../types';
import { band, m } from './dsl';

const asphalt = (w: number): Band => band('asphalt', w);
const side = (bands: Band[], barrier?: BarrierKind): SideStyle => ({ bands, barrier });
/** The outside of a braking zone: a wide apron of asphalt ending in a tyre wall. */
const escape = (w: number): SideStyle => side([asphalt(w)], 'tires');

// clockwise: right turns are negative. `len` is the distance from the previous vertex; two edges (free) close the loop.
const steps: TStep[] = [
  { name: 'Chrome', defl: -90, r: 45, zoneBefore: 270, zoneAfter: 40, outside: escape(20), inside: side([asphalt(4)], 'concrete') },
  { name: 'Flux1', defl: 38, r: 125, len: 280, zoneBefore: 50, zoneAfter: 20, outside: side([asphalt(7)], 'tires') },
  { name: 'Flux2', defl: -38, r: 125, len: 205, zoneBefore: 20, zoneAfter: 50, outside: side([asphalt(7)], 'tires') },
  { name: 'Spire', defl: -90, r: 170, len: 600, zoneBefore: 120, zoneAfter: 60, outside: escape(12), inside: side([asphalt(5)], 'concrete') },
  // the Halo: two halves of 90 degrees joined without a transition = one banked arc of 180 degrees
  { name: 'Halo', defl: -90, r: 95, lsIn: 60, lsOut: 0, free: true, zoneBefore: 150, zoneAfter: 0, outside: side([asphalt(6)], 'fence'), inside: side([asphalt(9)], 'concrete') },
  { name: 'Halo2', defl: -90, r: 95, lsIn: 0, lsOut: 60, len: 'join', zoneBefore: 0, zoneAfter: 80, outside: side([asphalt(6)], 'fence'), inside: side([asphalt(9)], 'concrete') },
  // the Arcade hairpin: two halves joined the same way
  { name: 'Arcade', defl: 82.5, r: 24, lsIn: 24, lsOut: 0, len: 430, zoneBefore: 230, zoneAfter: 0, outside: escape(17), inside: side([asphalt(3)], 'concrete') },
  { name: 'Arcade2', defl: 82.5, r: 24, lsIn: 0, lsOut: 24, len: 'join', zoneBefore: 0, zoneAfter: 50, outside: side([asphalt(6)], 'tires'), inside: side([asphalt(3)], 'concrete') },
  { name: 'Synapse1', defl: -28, r: 150, len: 230, zoneBefore: 40, zoneAfter: 20, outside: side([asphalt(6)], 'tires') },
  { name: 'Synapse2', defl: 28, r: 150, len: 200, zoneBefore: 20, zoneAfter: 40, outside: side([asphalt(6)], 'tires') },
  { name: 'Kernel', defl: -75, r: 80, len: 260, zoneBefore: 130, zoneAfter: 40, outside: escape(13), inside: side([asphalt(4)], 'concrete') },
  { name: 'Ghost1', defl: 25, r: 160, len: 180 },
  { name: 'Ghost2', defl: -25, r: 160, len: 135 },
  { name: 'Neon', defl: 'auto', r: 70, free: true, zoneBefore: 110, zoneAfter: 40, outside: escape(11), inside: side([asphalt(4)], 'concrete') },
];

const verts = turtleVerts(steps, { mainLen: 1100, origin: { e: 0, n: 0 }, dir: -1 });
export const xenonLayout: LayoutReport = polyLayout(verts, { sfAfterLastCorner: 260 });

/** Bank for one corner: ramps in over the entry clothoid, constant on the arc, ramps out (right turns positive). */
function cornerBank(name: string, deg: number): Key[] {
  return [{ at: m(name), v: 0 }, { at: m(name + '/a'), v: deg }, { at: m(name + '/b'), v: deg }, { at: m(name + '/e'), v: 0 }];
}
const bank: Key[] = [
  ...cornerBank('Chrome', 2),
  ...cornerBank('Flux1', -2.5),
  ...cornerBank('Flux2', 2.5),
  ...cornerBank('Spire', 4),
  // the Halo: 8 degrees all the way round its two halves
  { at: m('Halo'), v: 0 },
  { at: m('Halo/a'), v: 8 },
  { at: m('Halo2/b'), v: 8 },
  { at: m('Halo2/e'), v: 0 },
  // the hairpin's clothoids are short: the bank is spread over 10 m of straight on either side
  { at: m('Arcade', -10), v: 0 },
  { at: m('Arcade/a'), v: -3 },
  { at: m('Arcade2/b'), v: -3 },
  { at: m('Arcade2/e', 10), v: 0 },
  ...cornerBank('Synapse1', 2.5),
  ...cornerBank('Synapse2', -2.5),
  ...cornerBank('Kernel', 3.5),
  ...cornerBank('Ghost1', -2),
  ...cornerBank('Ghost2', 2),
  ...cornerBank('Neon', 3),
];

// asphalt half-widths: 7.5 m (15 m) on the Strip and into Chrome, 7 m through the lower city and the Halo, 6.5 m on the climb back
const widths = (): Key[] => [
  { at: m('main0', 60), v: 7.5 },
  { at: m('Chrome/e'), v: 7.5 },
  { at: m('S1', 80), v: 7 },
  { at: m('Spire/e'), v: 7 },
  { at: m('Halo'), v: 7 },
  { at: m('Halo/a'), v: 7.5 },
  { at: m('Halo2/b'), v: 7.5 },
  { at: m('S6', 60), v: 7 },
  { at: m('Arcade2/e'), v: 7 },
  { at: m('S8', 80), v: 6.5 },
  { at: m('Ghost2/e'), v: 6.5 },
  { at: m('Neon/a'), v: 7 },
  { at: m('Neon/e'), v: 7 },
];

// elevation: the road follows the slope the city stands on (3 % from north to south): the Strip at +44 m, down through Flux to the
// Datastream at +11 m, and back up through the Halo, the arcade district and the avenue
const pvi: Pvi[] = [
  { at: m('main0', 140), y: 44.5, vc: 100 },
  { at: m('main', 300), y: 44.0, vc: 120 },
  { at: m('Chrome'), y: 43.2, vc: 60 },
  { at: m('S1', 30), y: 41.4, vc: 60 },
  { at: m('Flux1/m'), y: 35.2, vc: 80 },
  { at: m('Flux2/m'), y: 30.2, vc: 80 },
  { at: m('S3/e', -40), y: 19.4, vc: 100 },
  { at: m('Spire/m'), y: 13.6, vc: 120 },
  { at: m('Spire/e', 40), y: 12.0, vc: 80 },
  { at: m('S4/m'), y: 10.6, vc: 160 },
  { at: m('Halo'), y: 11.2, vc: 80 },
  { at: m('Halo/b'), y: 14.2, vc: 80 },
  { at: m('Halo2/e'), y: 17.8, vc: 70 },
  { at: m('S6/m'), y: 18.4, vc: 80 },
  { at: m('Arcade', -30), y: 19.0, vc: 40 },
  { at: m('Arcade2/e', 30), y: 20.6, vc: 40 },
  { at: m('Synapse1/m'), y: 23.4, vc: 80 },
  { at: m('Synapse2/m'), y: 26.6, vc: 80 },
  { at: m('Kernel/m'), y: 29.8, vc: 70 },
  { at: m('Ghost1/m'), y: 34.4, vc: 80 },
  { at: m('Ghost2/m'), y: 38.2, vc: 70 },
  { at: m('Neon/a'), y: 41.6, vc: 60 },
  { at: m('Neon/e'), y: 44.0, vc: 60 },
];

const zones: Zone[] = [
  // the Strip: the pit wall on the left (the pit lane and the garages stand behind it), a concrete apron and the catch fence in front of
  // the main grandstand on the right
  { side: 'L', from: m('main0', 30), to: m('main', 340), bands: [asphalt(3.5)], barrier: 'concrete' },
  { side: 'R', from: m('main0', 30), to: m('main', 440), bands: [band('concrete', 5)], barrier: 'fence' },
];

// The slope the city stands on: 3 % down from the north (uptown) to the south (the lower city), levelling out at both ends; hardly a
// hill otherwise (a megacity is terraces and decks), and no mountains: the horizon is towers. East = -x, north = +z.
const terrain: TerrainParams = {
  seed: 61,
  base: 0,
  tilts: [{ x0: 0, z0: 0, h0: 44, gx: 0, gz: 0.0307, lo: 10.5, hi: 45.5, soft: 6 }],
  hillAmp: 1.6,
  hillScale: 300,
  detailAmp: 0.25,
  detailScale: 30,
  reach: 60,
  falloff: 45,
  xfade: 6,
};

export const xenon: TrackDef = {
  info: {
    id: 'xenon',
    name: 'Xenon Ring',
    location: 'Xenon District, Shinkai Megacity',
    description:
      'A grand-prix circuit through a megacity that never sleeps: a kilometre of boulevard between towers of light, the Flux esses down to the lower city, a tunnel taken flat out under the arcology, the long banked Halo, a hairpin in the arcade district and a climb back uptown through the Synapse esses.',
    difficulty: 3,
    defaultLaps: 3,
    defaultTimeOfDay: 'night',
    lengthHint: 4820,
    color: '#b45cff',
    floodlit: true,
  },
  seed: 20891,
  dir: -1,
  plan: xenonLayout.plan,
  start: xenonLayout.start,
  pvi,
  bank,
  widthL: widths(),
  widthR: widths(),
  crown: 0.015,
  minRunoff: 2.5,
  mowing: false,
  paved: true,
  defaults: { bandsL: [asphalt(3)], bandsR: [asphalt(3)], barrierL: 'fence', barrierR: 'fence', cross: -0.01 },
  zones,
  // the Conduit: the tunnel under the arcology, on the Datastream
  tunnels: [{ from: m('S4', 150), to: m('S4', 470), lining: 0xa8c8ff, portal: 0x4a5564, cover: 9 }],
  sectors: [m('Spire/e'), m('Arcade2/e')],
  terrain,
  scenery: {
    // the Xeno colours as light: teal along the left wall, hot pink along the right, violet between them
    neon: {
      strips: [0x16e0bd, 0xff2e63],
      rings: [{ at: m('main', 0), color: 0x16e0bd }, { at: m('Halo', -60), color: 0xb45cff }, { at: m('Halo2/e', 40), color: 0xff2e63 }, { at: m('Arcade', -200), color: 0x16e0bd }, { at: m('Neon/e', 60), color: 0xb45cff }],
      hoops: { every: 24, colors: [0x16e0bd, 0xff2e63, 0xb45cff] },
      skyLanes: 3,
      lampTint: 0xcfe4ff,
    },
    city: {
      style: 'neon',
      seed: 89,
      // the grandstand side of the Strip stays clear
      open: [{ from: m('main0', 20), to: m('main', 460), side: 'R' }],
      skyline: { reach: 900, density: 0.9, top: 320 },
      landmarks: [
        // the Spire: the tallest tower of the city, inside the long right that bears its name
        { kind: 'spire', at: m('Spire/m'), d: -145, height: 400 },
        // the arcology the Conduit runs under
        { kind: 'arcology', width: 160, height: 96 },
      ],
    },
    stands: [
      { at: m('main', 215), length: 340, side: 'R', gap: 13, rows: 22, roof: true, rearAds: true },
      { at: m('Arcade', -120), length: 130, side: 'L', gap: 34, rows: 12, roof: false },
    ],
    pits: { from: m('main0', 40), to: m('main', 360), side: 'L' },
    gantry: m('main'),
    bridges: [
      { at: m('main', 560), brand: 2 },
      { at: m('S3', 160), brand: 6 },
    ],
    marshals: ['Chrome', 'Flux1', 'Flux2', 'Spire', 'Halo2', 'Arcade', 'Synapse1', 'Kernel', 'Ghost2', 'Neon'],
    boards: [
      { at: m('Chrome', -140), side: 'L', gap: 30, brand: 0 },
      { at: m('Spire', 60), side: 'L', gap: 26, brand: 5 },
      { at: m('Arcade', -60), side: 'R', gap: 30, brand: 7 },
      { at: m('Kernel', 30), side: 'L', gap: 26, brand: 3 },
    ],
    brakeBoards: [
      { corner: 'Chrome', dist: [300, 200, 150, 100, 50] },
      { corner: 'Spire', dist: [100, 50] },
      { corner: 'Halo', dist: [150, 100, 50] },
      { corner: 'Arcade', dist: [200, 150, 100, 50] },
      { corner: 'Kernel', dist: [100, 50] },
      { corner: 'Neon', dist: [100, 50] },
    ],
    // street lamps all the way round, staggered from side to side; on the Strip the grandstand side only (the pit side carries the
    // start-straight TV camera and the pit lane)
    lamps: [
      { from: m('main0', 20), to: m('Chrome', -20), spacing: 30, side: 'R', height: 11, arm: 3, gap: 1.2 },
      { from: m('Chrome/e', 10), to: m('S4', 130), spacing: 30, side: 'B', stagger: true, height: 11, arm: 3, gap: 1.2 },
      { from: m('S4', 490), to: m('Neon/e', -10), spacing: 30, side: 'B', stagger: true, height: 11, arm: 3, gap: 1.2 },
    ],
  },
};
