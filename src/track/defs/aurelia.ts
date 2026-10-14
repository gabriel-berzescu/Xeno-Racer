/**
 * Aurelia Ring — the flagship GP circuit. Counter-clockwise, ~4.8 km, a ring of rolling green hills
 * around the infield Lake Aurelia. Authored with the turtle layout (corner deflections + edge lengths).
 *
 * Lap story: 940 m launch straight (slightly downhill) -> T1 tight hairpin (heavy braking) -> five flowing
 * esses climbing the north-east ridge (T2-T6) -> a 540 m downhill back straight -> the long banked
 * Carousel (T7/T7b, 170 deg) -> plunge to the tight chicane (T8/T9) -> uphill blind crest (T10) ->
 * downhill braking zone into the T11 left -> T12 -> T13 onto the straight.
 */
import type { LayoutReport } from '../layout';
import { polyLayout, turtleVerts } from '../layout';
import type { Band, BarrierKind, Key, Pvi, SideStyle, TerrainParams, TrackDef } from '../types';
import { band, m } from './dsl';
import type { TStep } from '../layout';

const g = (w: number): Band => band('grass', w);
const side = (bands: Band[], barrier?: BarrierKind): SideStyle => ({ bands, barrier });

const steps: TStep[] = [
  { name: 'T1', defl: 150, r: 30, ls: 28, zoneBefore: 250, zoneAfter: 110, outside: side([band('concrete', 9), band('gravel', 24)], 'tires'), inside: side([g(14)]) },
  { name: 'T2', defl: -35, r: 200, len: 360, outside: side([band('gravel', 10), g(8)]) },
  { name: 'T3', defl: 62, r: 150, len: 300, outside: side([band('gravel', 14), g(6)], 'tires') },
  { name: 'T4', defl: -68, r: 140, len: 270, outside: side([band('gravel', 14), g(6)], 'tires') },
  { name: 'T5', defl: 62, r: 150, len: 300, outside: side([band('gravel', 14), g(6)], 'tires') },
  { name: 'T6', defl: -35, r: 200, len: 320, outside: side([band('gravel', 10), g(8)]) },
  // the Carousel: two 85 deg halves joined without a transition = one 170 deg banked arc
  { name: 'T7', defl: 85, r: 85, lsIn: 60, lsOut: 0, len: 300, free: true, zoneBefore: 90, zoneAfter: 0, outside: side([g(5)], 'concrete'), inside: side([g(16)]) },
  { name: 'T7b', defl: 85, r: 85, lsIn: 0, lsOut: 60, len: 'join', zoneBefore: 0, zoneAfter: 110, outside: side([g(5)], 'concrete'), inside: side([g(16)]) },
  { name: 'T8', defl: 48, r: 38, len: 340, zoneBefore: 60, zoneAfter: 20, curbIn: 'chicane', curbOut: 'chicane', outside: side([band('concrete', 6), g(5)], 'tires'), inside: side([band('concrete', 6), g(5)], 'tires') },
  { name: 'T9', defl: -55, r: 38, len: 80, zoneBefore: 20, zoneAfter: 60, curbIn: 'chicane', curbOut: 'chicane', outside: side([band('concrete', 6), g(5)], 'tires'), inside: side([band('concrete', 6), g(5)], 'tires') },
  { name: 'T10', defl: -40, r: 200, len: 280 },
  { name: 'T11', defl: 67, r: 45, len: 280, free: true, zoneBefore: 240, zoneAfter: 60, outside: side([band('gravel', 28)], 'tires'), inside: side([g(10)]) },
  { name: 'T12', defl: -35, r: 100, len: 280 },
  { name: 'T13', defl: 'auto', r: 70, len: 180, zoneBefore: 60, zoneAfter: 30, outside: side([band('concrete', 8), g(8)]) },
];

const verts = turtleVerts(steps, { mainLen: 1135, origin: { e: 1650, n: 140 } });
export const aureliaLayout: LayoutReport = polyLayout(verts, { sfAfterLastCorner: 280 });

/** Smooth bank for one corner: ramps in over the entry clothoid, constant on the arc, ramps out. */
function cornerBank(name: string, deg: number, from0 = true, to0 = true): Key[] {
  const k: Key[] = [];
  if (from0) k.push({ at: m(name), v: 0 });
  k.push({ at: m(name + '/a'), v: deg }, { at: m(name + '/b'), v: deg });
  if (to0) k.push({ at: m(name + '/e'), v: 0 });
  return k;
}

const widths = (): Key[] => [
  { at: m('main0', 30), v: 7 },
  { at: m('main0', 110), v: 8 },
  { at: m('main/e', -300), v: 8 },
  { at: m('main/e', -150), v: 7 },
  { at: m('T1/m'), v: 7.5 },
  { at: m('S1'), v: 7 },
  { at: m('T7'), v: 7 },
  { at: m('T7/a'), v: 7.5 },
  { at: m('T7b/b'), v: 7.5 },
  { at: m('T7b/e'), v: 7 },
  { at: m('T8', -30), v: 6.5 },
  { at: m('T9/e', 20), v: 6.5 },
  { at: m('S10'), v: 7 },
];

const terrain: TerrainParams = {
  seed: 7,
  base: 17,
  hillAmp: 11,
  hillScale: 480,
  detailAmp: 0.8,
  detailScale: 42,
  // Lake Aurelia in the infield (world x = -east)
  lake: { x: -735, z: 430, rx: 305, rz: 185, rot: 0.15, level: 0, depth: 14, shore: 60 },
  bumps: [
    { x: -420, z: 1000, r: 260, h: 14 },
    { x: -1050, z: 820, r: 240, h: 10 },
    { x: -300, z: 380, r: 160, h: 6 },
  ],
  mountains: { start: 650, full: 2500, amp: 560, scale: 2600 },
  reach: 120,
  falloff: 100,
};

const pvi: Pvi[] = [
  { at: m('main0', 0), y: 13.0, vc: 40 },
  { at: m('main'), y: 14.0, vc: 160 },
  { at: m('main/e', -150), y: 10.0, vc: 160 },
  { at: m('T1/m'), y: 7.0, vc: 80 },
  { at: m('T2/m'), y: 12.0, vc: 80 },
  { at: m('T3/m'), y: 17.5, vc: 80 },
  { at: m('T4/m'), y: 23.0, vc: 80 },
  { at: m('T5/m'), y: 28.0, vc: 80 },
  { at: m('T6/m'), y: 31.5, vc: 100 },
  { at: m('S6/m'), y: 33.5, vc: 220 },
  { at: m('T7'), y: 27.0, vc: 100 },
  { at: m('T7b/m'), y: 20.0, vc: 80 },
  { at: m('T7b/e'), y: 17.0, vc: 60 },
  { at: m('S8/m'), y: 11.5, vc: 60 },
  { at: m('T8/m'), y: 7.5, vc: 30 },
  { at: m('T9/m'), y: 6.5, vc: 30 },
  { at: m('S10/m'), y: 13.0, vc: 60 },
  { at: m('T10/m'), y: 22.5, vc: 70 },
  { at: m('S11/m'), y: 14.5, vc: 100 },
  { at: m('T11/m'), y: 9.5, vc: 60 },
  { at: m('S12/m'), y: 11.5, vc: 60 },
  { at: m('T12/m'), y: 12.5, vc: 60 },
  { at: m('T13/m'), y: 13.0, vc: 60 },
];

export const aurelia: TrackDef = {
  info: {
    id: 'aurelia',
    name: 'Aurelia Ring',
    location: 'Lago Aurelia, Verdane Hills',
    description:
      'A modern grand-prix circuit ringed around a mirror-still lake. A 940 m launch straight into a tight hairpin, flowing esses along the ridge, the long banked Carousel, a tight chicane, a blind crest and a downhill braking zone.',
    difficulty: 3,
    defaultLaps: 3,
    defaultTimeOfDay: 'golden',
    lengthHint: 4795,
    color: '#16e0bd',
  },
  seed: 20251,
  dir: 1,
  plan: aureliaLayout.plan,
  start: aureliaLayout.start,
  pvi,
  bank: [
    ...cornerBank('T2', 2.5),
    ...cornerBank('T3', -3),
    ...cornerBank('T4', 3.5),
    ...cornerBank('T5', -3),
    ...cornerBank('T6', 2.5),
    { at: m('T7'), v: 0 },
    { at: m('T7/a'), v: -10 },
    { at: m('T7b/b'), v: -10 },
    { at: m('T7b/e'), v: 0 },
    ...cornerBank('T8', -2),
    ...cornerBank('T9', 2),
    ...cornerBank('T10', 2),
    ...cornerBank('T11', -3.5),
    ...cornerBank('T12', 2),
    ...cornerBank('T13', -3),
  ],
  widthL: widths(),
  widthR: widths(),
  defaults: { bandsL: [g(12)], bandsR: [g(12)], barrierL: 'armco', barrierR: 'armco', cross: -0.035 },
  zones: [
    // Pit straight: pit wall on the left, concrete apron + catch fence on the right (grandstand side)
    { side: 'L', from: m('T13/e', -20), to: m('main/e', -262), bands: [band('asphalt', 3.5)], barrier: 'concrete' },
    { side: 'R', from: m('T13/e', -20), to: m('main/e', -262), bands: [band('concrete', 6), g(7)], barrier: 'fence' },
  ],
  sectors: [m('T6/e'), m('T10/e')],
  terrain,
  scenery: {
    stands: [
      { at: m('main', 200), length: 340, side: 'R', gap: 13, rows: 22, roof: true },
      { at: m('main', 520), length: 120, side: 'R', gap: 13, rows: 14, roof: false },
      { at: m('T1/m', -220), length: 150, side: 'R', gap: 40, rows: 12, roof: false },
    ],
    pits: { from: m('main0', 120), to: m('main', 380), side: 'L' },
    bridges: [{ at: m('main', -300), brand: 2 }],
    gantry: m('main'),
    marshals: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7b', 'T8', 'T10', 'T11', 'T12', 'T13'],
    lamps: [{ from: m('main0', 40), to: m('main', 520), spacing: 38, side: 'B' }],
    boards: [
      { at: m('T1', -120), side: 'R', gap: 30, brand: 0 },
      { at: m('T7', -30), side: 'R', gap: 24, brand: 5 },
      { at: m('T11', 40), side: 'R', gap: 36, brand: 7 },
      { at: m('T4/m'), side: 'L', gap: 22, brand: 3 },
    ],
    brakeBoards: [
      { corner: 'T1', dist: [300, 200, 150, 100, 50] },
      { corner: 'T7', dist: [200, 100, 50] },
      { corner: 'T8', dist: [100, 50] },
      { corner: 'T11', dist: [200, 100, 50] },
    ],
    vegetation: { species: [['oak', 0.62], ['poplar', 0.12], ['birch', 0.14], ['pine', 0.12]], density: 1.5, forestThreshold: -0.02, forestScale: 190, clearance: 9, ramp: 45, reach: 420, slopeMax: 0.65, scale: 12 },
  },
};
