/**
 * Porto Vela: a floodlit street circuit through a Mediterranean harbour city on a hillside.
 * Counter-clockwise, 3.96 km, 9.5-14 m of asphalt between concrete walls and catch fences, 43 m of elevation (the quay at +3.4 m to
 * the old town at +46 m), twenty corners. The lap (s from the start/finish line; pits on the left, the main grandstand on the quay):
 *
 *   Cais      the 662 m waterfront straight along the harbour (the sea on the right), into a tight left (90 deg, R34) at the quay's end
 *   Farol     the climb up the east flank: three fast uphill sweepers (right-left-right, R150 / R110 / R300), flat out in the LMP
 *   Mirante   the left at the top (90 deg, R24) onto the Avenida da Colina, the long boulevard along the ridge, with two fast kinks
 *   Praca     the Praca Nova dog-leg: a left and a right in 20 m, between the blocks
 *   Cantareira  a medium-speed left-right (R75) before the straight to
 *   Se        the hairpin (165 deg, R14) behind the cathedral, the best place to pass
 *   Castelo   the Rua do Castelo, a narrow street that dives into the 210 m Castelo tunnel and out into
 *   Escadas   the right-hander at the foot of the steps (heavy braking from the tunnel)
 *   Descida   the Descida da Alfandega, 8 % downhill with two fast kinks, into
 *   Marina    the harbourside chicane (right-left, R38) and Doca, the last left (90 deg, R34) back onto the waterfront
 *
 * Authored with the turtle layout (corner deflections + edge lengths, two edges solved for closure). The map frame is the harbour's:
 * east = -x, north = +z, the waterfront at north = 0 with the sea to the south; `portovelaMap` converts for the scenery.
 */
import type { LayoutReport, TStep } from '../layout';
import { polyLayout, turtleVerts } from '../layout';
import type { Band, BarrierKind, Key, Pvi, SideStyle, TerrainParams, TrackDef, Zone } from '../types';
import { band, m } from './dsl';

const asphalt = (w: number): Band => band('asphalt', w);
const side = (bands: Band[], barrier?: BarrierKind): SideStyle => ({ bands, barrier });
/** An escape road on the outside of a heavy braking zone: a wide apron of asphalt ending in a tyre wall. */
const escape = (w: number): SideStyle => side([asphalt(w)], 'tires');

const steps: TStep[] = [
  { name: 'Cais', defl: 90, r: 34, zoneBefore: 240, zoneAfter: 25, outside: escape(17), inside: side([asphalt(2)], 'concrete') },
  { name: 'Farol1', defl: -22, r: 150, ls: 40, len: 300 },
  { name: 'Farol2', defl: 38, r: 110, ls: 40, len: 220, outside: side([asphalt(2)], 'tires'), zoneBefore: 40, zoneAfter: 20 },
  { name: 'Farol3', defl: -16, r: 300, ls: 35, len: 210 },
  { name: 'Mirante', defl: 90, r: 24, len: 130, zoneBefore: 210, zoneAfter: 25, outside: escape(15), inside: side([asphalt(2)], 'concrete') },
  { name: 'Colina1', defl: 22, r: 160, ls: 40, len: 340 },
  { name: 'Colina2', defl: -22, r: 160, ls: 40, len: 130 },
  { name: 'Praca1', defl: 90, r: 20, ls: 14, len: 260, zoneBefore: 190, zoneAfter: 10, outside: escape(14), inside: side([asphalt(2)], 'concrete') },
  { name: 'Praca2', defl: -90, r: 18, ls: 15, len: 70, zoneBefore: 10, zoneAfter: 30, outside: side([asphalt(2)], 'tires'), inside: side([asphalt(2)], 'concrete') },
  { name: 'Cantar1', defl: 42, r: 75, ls: 40, len: 230, zoneBefore: 70, zoneAfter: 20, outside: side([asphalt(2)], 'tires') },
  { name: 'Cantar2', defl: -42, r: 75, ls: 40, len: 100, zoneBefore: 20, zoneAfter: 40, outside: side([asphalt(2)], 'tires') },
  { name: 'Sea', defl: 82.5, r: 14, lsIn: 19, lsOut: 0, len: 300, free: true, zoneBefore: 230, zoneAfter: 0, outside: escape(16), inside: side([asphalt(2)], 'concrete') },
  { name: 'Seb', defl: 82.5, r: 14, lsIn: 0, lsOut: 19, len: 'join', zoneBefore: 0, zoneAfter: 50, outside: side([asphalt(2)], 'tires'), inside: side([asphalt(2)], 'concrete') },
  { name: 'Castelo', defl: -6, r: 260, ls: 30, len: 120 },
  { name: 'Escadas', defl: -69, r: 20, ls: 14, len: 330, zoneBefore: 150, zoneAfter: 20, outside: escape(14), inside: side([asphalt(2)], 'concrete') },
  { name: 'Descida1', defl: 12, r: 200, ls: 35, len: 120 },
  { name: 'Descida2', defl: -12, r: 200, ls: 35, len: 90 },
  { name: 'MarinaR', defl: -40, r: 38, len: 150, free: true, zoneBefore: 150, zoneAfter: 20, outside: escape(13), inside: side([asphalt(2)], 'concrete') },
  { name: 'MarinaL', defl: 40, r: 38, len: 80, zoneBefore: 20, zoneAfter: 30, outside: side([asphalt(2)], 'tires'), inside: side([asphalt(2)], 'concrete') },
  { name: 'Doca', defl: 'auto', r: 34, len: 70, zoneBefore: 100, zoneAfter: 10, outside: escape(18), inside: side([asphalt(2)], 'concrete') },
];

const verts = turtleVerts(steps, { mainLen: 850, origin: { e: 1000, n: 0 } });
export const portovelaLayout: LayoutReport = polyLayout(verts, { sfAfterLastCorner: 100 });

/** Map frame (east, north) -> world (x, z), for scenery that is placed on the harbour map. */
export const portovelaMap = (e: number, n: number): { x: number; z: number } => ({ x: -e, z: n });

/** Bank for one corner: ramps in over the entry clothoid, constant on the arc, ramps out (right turns positive). */
function cornerBank(name: string, deg: number): Key[] {
  return [{ at: m(name), v: 0 }, { at: m(name + '/a'), v: deg }, { at: m(name + '/b'), v: deg }, { at: m(name + '/e'), v: 0 }];
}
const bank: Key[] = [
  ...cornerBank('Farol1', 2),
  ...cornerBank('Farol2', -2.5),
  ...cornerBank('Farol3', 1.5),
  ...cornerBank('Colina1', -1.5),
  ...cornerBank('Colina2', 1.5),
  ...cornerBank('Cantar1', -2),
  ...cornerBank('Cantar2', 2),
  ...cornerBank('Descida1', -1),
  ...cornerBank('Descida2', 1),
  ...cornerBank('MarinaR', 1.5),
  ...cornerBank('MarinaL', -1.5),
];

// asphalt half-widths: 6 m (12 m) on the waterfront, widening to 7 m (14 m) from 250 m on into the first corner (room to brake
// three abreast), 5.8 on the boulevards, 5 in the streets between the blocks, 4.75 in the narrow Rua do Castelo and its tunnel
const widths = (): Key[] => [
  { at: m('main0', 40), v: 6 },
  { at: m('main', 250), v: 6 },
  { at: m('main', 520), v: 7 },
  { at: m('Cais/m'), v: 7 },
  { at: m('S1', 40), v: 6 },
  { at: m('S1/m'), v: 5.8 },
  { at: m('Mirante'), v: 5.5 },
  { at: m('S5/m'), v: 5.8 },
  { at: m('Praca1', -40), v: 5.8 },
  { at: m('Praca1'), v: 5.0 },
  { at: m('Praca2/e', 20), v: 5.0 },
  { at: m('S9/m'), v: 5.4 },
  { at: m('Cantar2/e'), v: 5.2 },
  { at: m('Sea', -20), v: 5.6 },
  { at: m('Seb/e'), v: 5.2 },
  { at: m('S13/m'), v: 4.75 },
  { at: m('S14/m'), v: 4.75 },
  { at: m('Escadas'), v: 5.0 },
  { at: m('S15/m'), v: 5.6 },
  { at: m('MarinaR', -30), v: 5.4 },
  { at: m('Doca/e'), v: 6.0 },
];

// elevation: the quay at +3.4 m, the climb (6 %) to the old town at +46 m, the ridge boulevard, the Rua do Castelo, then 8 % down to the harbour
const pvi: Pvi[] = [
  { at: m('main'), y: 3.4, vc: 100 },
  { at: m('Cais'), y: 4.2, vc: 40 },
  { at: m('S1/m'), y: 8.5, vc: 60 },
  { at: m('Farol1/m'), y: 17.5, vc: 80 },
  { at: m('Farol2/m'), y: 31, vc: 80 },
  { at: m('Farol3/m'), y: 41.5, vc: 90 },
  { at: m('Mirante'), y: 46, vc: 60 },
  { at: m('Colina1'), y: 46.5, vc: 90 },
  { at: m('Colina2'), y: 46, vc: 90 },
  { at: m('Praca1'), y: 44.5, vc: 40 },
  { at: m('S9/m'), y: 43.5, vc: 60 },
  { at: m('Sea'), y: 41, vc: 30 },
  { at: m('Castelo'), y: 38.5, vc: 60 },
  { at: m('S14/m'), y: 36.5, vc: 60 },
  { at: m('Escadas'), y: 33.5, vc: 40 },
  { at: m('Descida1'), y: 27, vc: 60 },
  { at: m('Descida2'), y: 19.5, vc: 60 },
  { at: m('MarinaR'), y: 8.5, vc: 50 },
  { at: m('MarinaL'), y: 4.8, vc: 50 },
  { at: m('Doca'), y: 3.8, vc: 40 },
  { at: m('main0'), y: 3.5, vc: 40 },
];

const zones: Zone[] = [
  // Pit straight: the pit wall on the left (the pit lane and the garages stand behind it), a concrete apron and the catch fence in front of
  // the main grandstand on the quay side
  { side: 'L', from: m('main0', 20), to: m('main', 330), bands: [band('asphalt', 3.5)], barrier: 'concrete' },
  { side: 'R', from: m('main0', 20), to: m('main', 440), bands: [band('concrete', 4)], barrier: 'fence' },
];

// The hillside: the ground climbs 6 % from the quay (the tilt), the harbour is the sea south of the waterfront (a bay between the west bank and
// the east headland, with three piers), the range behind the city rises far to the north. East = -x, north = +z (see portovelaMap).
const terrain: TerrainParams = {
  seed: 5,
  base: 0,
  tilts: [{ x0: 0, z0: 0, h0: 3.2, gx: 0, gz: 0.062, lo: 0, hi: 58, soft: 18 }],
  hillAmp: 4,
  hillScale: 240,
  detailAmp: 0.5,
  detailScale: 24,
  // the castle hill over the tunnel: a long ridge (three overlapping bumps make a flat crest for the castle's curtain wall)
  bumpsAt: [57, 127, 197].map((d) => ({ at: m('S14', d), r: 60, h: 7.5 })),
  mountains: { start: 650, full: 2500, amp: 420, scale: 1500 },
  reach: 60,
  falloff: 50,
  xfade: 6,
  sea: {
    level: 0,
    quay: 3.2,
    levelled: 70,
    // the sea south of the waterfront (north = -72 m is the quay edge), the west bank and the east headland, and three piers
    water: [[-9000, -9000, 9000, -72]],
    land: [
      [-9000, -1500, -260, -72],
      [1130, -1000, 9000, -72],
      [330, -330, 356, -72],
      [640, -240, 666, -72],
      [880, -190, 904, -72],
    ],
  },
};

export const portovela: TrackDef = {
  info: {
    id: 'portovela',
    name: 'Porto Vela',
    location: 'Porto Vela, Costa Dourada',
    description:
      'A floodlit street circuit through a harbour city on a hillside: a flat-out run along the quay, a fast climb up the old town, tight corners between the blocks, a hairpin behind the cathedral, a tunnel under the castle and a harbourside chicane. Concrete walls and catch fences all the way round.',
    difficulty: 5,
    defaultLaps: 3,
    defaultTimeOfDay: 'dusk',
    lengthHint: 3960,
    color: '#ff9f1c',
    floodlit: true,
  },
  seed: 4242,
  dir: 1,
  plan: portovelaLayout.plan,
  start: portovelaLayout.start,
  pvi,
  bank,
  widthL: widths(),
  widthR: widths(),
  crown: 0.015,
  minRunoff: 2,
  centerLine: true,
  mowing: false,
  paved: true,
  defaults: { bandsL: [asphalt(2)], bandsR: [asphalt(2)], barrierL: 'fence', barrierR: 'fence', cross: -0.01 },
  zones,
  // the lining under warm sodium lamps, the portals in the city's sandstone (floodlit after dark), the ground over the tube the castle hill's
  tunnels: [{ from: m('S14', 22), to: m('S14', 232), lining: 0xffd49a, portal: 0xc9b48c, cover: 7 }],
  sectors: [m('Farol3'), m('Cantar2/e')],
  terrain,
  scenery: {
    // painted like a city street: zebra crossings between the blocks, a yellow box through the Praca dog-leg, lane arrows before the
    // corners, manhole covers off the racing line
    markings: [
      ...[m('S1', 60), m('Farol1', -60), m('S3', 40), m('S5', 130), m('S5', 220), m('S7', 100), m('S9', 80), m('S11', 90), m('S15', 20), m('S17', 40)].map((at) => ({ kind: 'zebra' as const, at })),
      { kind: 'box', at: m('Praca1', 6), len: 34 },
      { kind: 'arrow', at: m('Cais', -90), d: 2.6, turn: 1 },
      { kind: 'arrow', at: m('Mirante', -80), d: 2.6, turn: 1 },
      { kind: 'arrow', at: m('Praca1', -70), d: 2.6, turn: 1 },
      { kind: 'arrow', at: m('Praca2', -4), d: -2.4, turn: -1 },
      { kind: 'arrow', at: m('Escadas', -80), d: -2.6, turn: -1 },
      { kind: 'arrow', at: m('MarinaR', -70), d: -2.6, turn: -1 },
      { kind: 'arrow', at: m('Doca', -90), d: 2.6, turn: 1 },
      { kind: 'arrow', at: m('S5', 70), d: -2.6, turn: 0 },
      { kind: 'manhole', at: m('S1', 100), d: 3.4 },
      { kind: 'manhole', at: m('S5', 60), d: -3.9 },
      { kind: 'manhole', at: m('S7', 40), d: 1.6 },
      { kind: 'manhole', at: m('S9', 100), d: -3.4 },
      { kind: 'manhole', at: m('S11', 60), d: 3.9 },
      { kind: 'manhole', at: m('S15', 30), d: -3.0 },
      { kind: 'manhole', at: m('S17', 40), d: 2.9 },
      { kind: 'manhole', at: m('S2', 30), d: -4.0 },
    ],
    city: {
      seed: 21,
      // the quay side of the waterfront (the sea, the stands) stays clear
      open: [{ from: m('Doca', 10), to: m('Cais', 60), side: 'R' }],
      skyline: { reach: 1000, density: 0.85 },
      bunting: [m('main', 90), m('Cais', -150), m('Mirante', -120), m('Colina1', 60), m('Praca1', -120), m('Cantar1', -60), m('Sea', -170), m('Escadas', -150), m('Descida1', -40), m('MarinaR', -120)],
      // stone arches across the Descida (after the Escadas) and the Avenida da Colina
      arches: [{ at: m('S15', 30) }, { at: m('S5', 110) }],
      landmarks: [
        { kind: 'lighthouse', e: 1150, n: -985, scale: 1.1 },
        // the cathedral stands at the end of the Avenida da Colina, behind the hairpin, facing the cars as they brake for it
        { kind: 'cathedral', e: -283, n: 648, yaw: 90 },
        // the castle on the hill over the Castelo tunnel
        { kind: 'castle', at: m('S14', 127), d: 0, yaw: 90 },
      ],
      // the castle hill: cypresses and holm oaks along its crest, a few palms
      groves: [
        { at: m('S14', 127), along: 100, across: 34, count: 70, species: [['poplar', 0.4], ['oak', 0.45], ['palm', 0.15]] },
        // and the park below it
        { at: m('S14', 127), along: 150, across: 75, count: 60, minRise: 0, species: [['oak', 0.5], ['poplar', 0.25], ['palm', 0.25]] },
      ],
      palms: [
        { from: m('S1', 10), to: m('Farol1', -20), side: 'B', spacing: 17, gap: 2.6 },
        { from: m('S5', 30), to: m('Colina1', 20), side: 'B', spacing: 19, gap: 2.6 },
        { from: m('Colina2', 30), to: m('Praca1', -30), side: 'B', spacing: 19, gap: 2.6 },
        { from: m('S15', 0), to: m('MarinaR', -30), side: 'B', spacing: 20, gap: 2.6 },
      ],
    },
    harbour: {
      boats: 16,
      // the container quay on the east headland's west face (the booms reach west over the water: +x in the world)
      cranes: [-150, -270, -390, -510, -630].map((n) => ({ e: 1128, n, yaw: 0, scale: 1 })),
    },
    stands: [{ at: m('main', 215), length: 340, side: 'R', gap: 13, rows: 22, roof: true, rearAds: true }],
    pits: { from: m('main0', 40), to: m('main', 360), side: 'L' },
    gantry: m('main'),
    // the long gap between the Cais camera and the Farol sweepers
    tvMarks: [m('S1', 100)],
    // street lamps: floodlight masts on the quay side of the straight (the pit side carries the start-straight TV camera and the pit
    // lane), staggered along the streets
    lamps: [
      { from: m('main0', 20), to: m('Cais', 30), spacing: 26, side: 'R', height: 9.5, arm: 2.8, gap: 1.2 },
      { from: m('S1', 20), to: m('Doca', -40), spacing: 26, side: 'B', stagger: true, height: 9.5, arm: 2.8, gap: 1.2 },
    ],
  },
};
