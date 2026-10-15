/**
 * Brennwald Ring: a fast, old-school grand-prix circuit through the pine and beech forest of the Hochwald uplands.
 * Clockwise, 6.84 km, 12-13 m wide, 90 m of elevation (12 m in the Kessel to 102 m on the Mutprobe crest), 17 named corners.
 * The lap (s from the start/finish line; pits on the left, main grandstand on the right):
 *
 *   main     665 m launch straight, gently downhill; pit building left, grandstand right
 *   Tor      T1, a medium-slow right (45 deg, R125) at the end of the straight: the first overtaking spot
 *   Birke / Hirsch / Hang   a left flick, a tighter right (80 deg, R170) and a long fast right (78 deg, R240) that turn the
 *            track back on itself
 *   Abfahrt  650 m of fast downhill (-5 %) with a long, flat-out left (Wald)
 *   Kessel   the valley compression at the bottom of the Abfahrt, kicking straight into the steep uphill left-right
 *            KesselL / KesselR (up to 9 %): flat out in the LMP, a lift in the GT
 *   Rampe    0.9 km uphill straight with two flat-out kinks, the slipstream battle, ending in
 *   Jaeger   the hairpin (125 deg, R30): heavy braking, the main overtaking place
 *   Ausfahrt / Mutprobe   a climbing left, then the blind crest at the top of the circuit (flat for the brave)
 *   Wacht    a fast right down the ridge
 *   Zwilling the fast double-apex right (two apexes, the second one tighter)
 *   Koehler  a slow right-left chicane just before the line
 *
 * The plan is written out as explicit straights and corners (S / T): the straights are the solved lengths of the layout design,
 * 'Rampe' and 'Rueck' are free and close the loop exactly. The terrain around the road is sculpted by the `bumpsAt` block (see
 * `terrain` below), fitted so that the ground beside the barrier follows the road profile.
 */
import type { Band, BarrierKind, Key, PlanEl, Pvi, SideStyle, TerrainParams, TrackDef, Zone } from '../types';
import { S, T, band, m } from './dsl';

const g = (w: number): Band => band('grass', w);
const gv = (w: number): Band => band('gravel', w);
const side = (bands: Band[], barrier?: BarrierKind): SideStyle => ({ bands, barrier });

// Straights are the solved lengths of the layout design; 'Rampe' and 'Rueck' are free and close the loop exactly.
const plan: PlanEl[] = [
  S('main', 664.6),
  T('Tor', -45, 125, { zoneBefore: 260, zoneAfter: 90, outside: side([gv(22), g(6)], 'tires'), inside: side([g(10)]) }),
  S('gTB', 111.0),
  T('Birke', 20, 280, { curbOut: 'none', outside: side([gv(8), g(4)]) }),
  S('gBH', 117.1),
  T('Hirsch', -80, 170, { zoneBefore: 120, zoneAfter: 60, outside: side([gv(16), g(5)], 'tires'), inside: side([g(8)]) }),
  S('gHH', 105.5),
  T('Hang', -78, 240, { zoneBefore: 40, zoneAfter: 60, curbOut: 'none', outside: side([gv(18), g(6)]), inside: side([g(7)]) }),
  S('AbfahrtA', 195.9),
  T('Wald', 21, 800),
  S('AbfahrtB', 143.1),
  T('KesselL', 30, 450, { zoneBefore: 80, zoneAfter: 20, outside: side([gv(7), g(4)]), inside: side([g(6)]) }),
  S('gK', 6.9),
  T('KesselR', -30, 450, { zoneBefore: 20, zoneAfter: 80, outside: side([gv(7), g(4)]), inside: side([g(6)]) }),
  S('Rampe0', 24.5),
  T('Rampe1', 8, 1200),
  S('RampeM', 101.3),
  T('Rampe2', -8, 1200),
  S('Rampe', 335.7, true),
  T('Jaeger', -125, 30, { zoneBefore: 240, zoneAfter: 110, outside: side([band('concrete', 5), gv(24)], 'tires'), inside: side([g(12)]) }),
  S('gJ', 82.6),
  T('Ausfahrt', 21, 300, { curbOut: 'none', outside: side([gv(10), g(5)]) }),
  S('gA', 166.1),
  T('Mutprobe', -8, 800, { zoneBefore: 60, zoneAfter: 60, outside: side([gv(8), g(4)]) }),
  S('gM', 228.1),
  T('Wacht', -21, 520, { zoneBefore: 40, zoneAfter: 40, outside: side([gv(12), g(5)]) }),
  S('Rueck', 305.1, true),
  T('ZwillingA', -32.5, 300, { zoneBefore: 40, zoneAfter: 0, curbOut: 'none', outside: side([gv(14), g(5)]), inside: side([g(6)]) }),
  S('gZ', 57.9),
  T('ZwillingB', -32.5, 170, { zoneBefore: 0, zoneAfter: 60, outside: side([gv(16), g(5)], 'tires'), inside: side([g(6)]) }),
  S('gZK', 282.4),
  T('KoehlerR', -38, 46, { zoneBefore: 70, zoneAfter: 20, curbIn: 'chicane', curbOut: 'chicane', outside: side([band('concrete', 5), g(3)], 'tires'), inside: side([band('concrete', 5), g(3)], 'tires') }),
  S('gKo', 48.6),
  T('KoehlerL', 38, 46, { zoneBefore: 20, zoneAfter: 60, curbIn: 'chicane', curbOut: 'chicane', outside: side([band('concrete', 5), g(3)], 'tires'), inside: side([band('concrete', 5), g(3)], 'tires') }),
  S('main0', 167.8),
];

// ── elevation: valley bottom 12 m (Kessel) .. crest 102 m (Mutprobe); worst grades +9 % (Kesselwand) and -5.5 % (down from the Mutprobe) ──
// vertical curves: tightest crest R 1100 m (Mutprobe), tightest sag R 945 m (Kessel compression, tuned so the GT only just touches the
// bump stops and the 313 km/h LMP bottoms briefly, as a real Eau-Rouge-style compression would)
const pvi: Pvi[] = [
  { at: m('main'), y: 61.0, vc: 100 },
  { at: m('Tor'), y: 49.5, vc: 90 },
  { at: m('Hirsch/m'), y: 45.5, vc: 150 },
  { at: m('Hang/e'), y: 44.0, vc: 70 }, // the brow at the top of the Abfahrt
  { at: m('Wald/m'), grade: -0.05, vc: 90 },
  { at: m('KesselL', -6), y: 10.0, vc: 130 }, // the Kessel compression
  { at: m('KesselL/m'), grade: 0.09, vc: 70 }, // the steep ramp
  { at: m('Rampe0', 20), grade: 0.075, vc: 60 }, // the crest at the top of the Kesselwand
  { at: m('Jaeger'), grade: 0.029, vc: 80 },
  { at: m('Mutprobe/m'), grade: 0.026, vc: 90 }, // the blind crest
  { at: m('Wacht'), grade: -0.055, vc: 120 },
  { at: m('ZwillingB/e'), grade: -0.027, vc: 150 },
];

/** Bank for one corner: ramps in over the entry clothoid, constant on the arc, ramps out (right turns positive). */
function cornerBank(name: string, deg: number): Key[] {
  return [{ at: m(name), v: 0 }, { at: m(name + '/a'), v: deg }, { at: m(name + '/b'), v: deg }, { at: m(name + '/e'), v: 0 }];
}
const bank: Key[] = [
  ...cornerBank('Tor', 3.5),
  ...cornerBank('Birke', -3),
  ...cornerBank('Hirsch', 4.5),
  ...cornerBank('Hang', 5.5),
  ...cornerBank('KesselL', -5.5),
  ...cornerBank('KesselR', 5.5),
  // the hairpin's clothoids are short: spread the 5 degrees over 10 m of straight on either side so the bank never twists faster than 0.5 deg/m
  { at: m('Jaeger', -10), v: 0 },
  { at: m('Jaeger/a'), v: 5 },
  { at: m('Jaeger/b'), v: 5 },
  { at: m('Jaeger/e', 10), v: 0 },
  ...cornerBank('Ausfahrt', -4),
  ...cornerBank('Mutprobe', 1.5),
  ...cornerBank('Wacht', 3),
  ...cornerBank('ZwillingA', 5),
  ...cornerBank('ZwillingB', 5.5),
  ...cornerBank('KoehlerR', 2),
  ...cornerBank('KoehlerL', -2),
];

// asphalt half-widths: 6.5 m (13 m) on the straight and through the busy first sector, 6 m (12 m) in the forest
const widths = (): Key[] => [
  { at: m('main0', 20), v: 6.5 },
  { at: m('main', 520), v: 6.5 },
  { at: m('Tor/m'), v: 6.5 },
  { at: m('gTB'), v: 6.3 },
  { at: m('Hirsch/m'), v: 6.4 },
  { at: m('Hang/m'), v: 6.4 },
  { at: m('AbfahrtA'), v: 6.0 },
  { at: m('KesselL'), v: 6.0 },
  { at: m('KesselR/e'), v: 6.0 },
  { at: m('Rampe', 100), v: 6.25 },
  { at: m('Rampe/e', -150), v: 6.5 },
  { at: m('Jaeger/m'), v: 6.5 },
  { at: m('Jaeger/e', 60), v: 6.4 },
  { at: m('gA'), v: 6.0 },
  { at: m('Wacht/m'), v: 6.0 },
  { at: m('ZwillingA'), v: 6.25 },
  { at: m('gZK', 40), v: 6.25 },
  { at: m('KoehlerR', -40), v: 6.5 },
  { at: m('KoehlerL/e', 30), v: 6.5 },
];

const zones: Zone[] = [
  // Pit straight: pit wall on the left (as on the other circuits, so the start-straight TV cameras sit on the pit apron and
  // the grandstand side stays behind the cars), concrete apron + catch fencing in front of the main stand on the right
  { side: 'L', from: m('main0', 30), to: m('main', 330), bands: [band('asphalt', 3.5)], barrier: 'concrete' },
  { side: 'R', from: m('main0', 30), to: m('main', 215), bands: [band('concrete', 6), g(7)], barrier: 'concrete' },
  { side: 'R', from: m('main', 215), to: m('main', 400), bands: [band('concrete', 6), g(7)], barrier: 'fence' },
];

const terrain: TerrainParams = {
  seed: 31,
  base: 30,
  hillAmp: 5,
  hillScale: 260,
  detailAmp: 0.9,
  detailScale: 26,
  mountains: { start: 500, full: 2400, amp: 380, scale: 1700 },
  reach: 70,
  falloff: 30,
  xfade: 5,
  // terrain sculpted around the track: 52 Gaussian bumps (radius 250 m, spaced ~280 m) least-squares fitted to the design heights
  // beside the barrier (road profile + valley floors); refit if the plan or the profile changes
  bumpsAt: [
    // <bumps>
    { at: ['main', 27], d: 424, r: 250, h: 19.3 },
    { at: ['main', 60], d: 30, r: 250, h: 6.6 },
    { at: ['main', 96], d: -365, r: 250, h: 7.0 },
    { at: ['main', 240], d: 244, r: 250, h: 24.1 },
    { at: ['main', 276], d: -150, r: 250, h: 13.1 },
    { at: ['main', 489], d: -330, r: 250, h: 13.8 },
    { at: ['main', 636], d: 279, r: 250, h: 24.3 },
    { at: ['Tor', 4], d: -116, r: 250, h: 8.0 },
    { at: ['Tor', 115], d: 425, r: 250, h: 28.4 },
    { at: ['Birke', 131], d: 154, r: 250, h: 17.6 },
    { at: ['gBH', 40], d: 425, r: 250, h: 10.7 },
    { at: ['Hirsch', 85], d: 378, r: 250, h: 36.2 },
    { at: ['Hirsch', 223], d: 231, r: 250, h: 16.0 },
    { at: ['gHH', 102], d: 95, r: 250, h: 7.1 },
    { at: ['Hang', 224], d: 66, r: 250, h: 7.4 },
    { at: ['AbfahrtA', 191], d: 71, r: 250, h: 10.8 },
    { at: ['Wald', 196], d: -116, r: 250, h: -10.2 },
    { at: ['AbfahrtB', 141], d: 431, r: 250, h: 35.5 },
    { at: ['KesselL', 49], d: -193, r: 250, h: -11.8 },
    { at: ['KesselL', 265], d: -388, r: 250, h: 13.8 },
    { at: ['KesselR', 154], d: 205, r: 250, h: 25.9 },
    { at: ['Rampe1', 10], d: 331, r: 250, h: 32.5 },
    { at: ['Rampe1', 61], d: -293, r: 250, h: 24.2 },
    { at: ['Rampe1', 166], d: 87, r: 250, h: 20.0 },
    { at: ['Rampe2', 79], d: 202, r: 250, h: 31.5 },
    { at: ['Rampe2', 208], d: -43, r: 250, h: 16.0 },
    { at: ['Rampe', 57], d: 343, r: 250, h: 29.4 },
    { at: ['Rampe', 207], d: 106, r: 250, h: 11.9 },
    { at: ['Jaeger', 19], d: 272, r: 250, h: 36.0 },
    { at: ['Jaeger', 49], d: 223, r: 250, h: 24.9 },
    { at: ['Jaeger', 70], d: 411, r: 250, h: 23.0 },
    { at: ['gJ', 69], d: 37, r: 250, h: 27.8 },
    { at: ['gA', 19], d: 274, r: 250, h: 7.9 },
    { at: ['gA', 25], d: -122, r: 250, h: 28.3 },
    { at: ['Mutprobe', 51], d: 80, r: 250, h: 45.6 },
    { at: ['Mutprobe', 78], d: -316, r: 250, h: -17.6 },
    { at: ['gM', 88], d: -91, r: 250, h: 33.1 },
    { at: ['Wacht', 25], d: 135, r: 250, h: 23.6 },
    { at: ['Wacht', 250], d: 16, r: 250, h: 27.3 },
    { at: ['Rueck', 65], d: 286, r: 250, h: 14.5 },
    { at: ['Rueck', 188], d: -327, r: 250, h: 7.5 },
    { at: ['Rueck', 263], d: -57, r: 250, h: 13.3 },
    { at: ['ZwillingA', 27], d: 214, r: 250, h: 23.1 },
    { at: ['ZwillingA', 201], d: 215, r: 250, h: 20.2 },
    { at: ['gZ', 35], d: -53, r: 250, h: 6.9 },
    { at: ['ZwillingB', 79], d: 316, r: 250, h: 28.0 },
    { at: ['gZK', 36], d: 112, r: 250, h: 7.4 },
    { at: ['gZK', 69], d: -282, r: 250, h: 10.2 },
    { at: ['gZK', 216], d: 327, r: 250, h: 25.8 },
    { at: ['gZK', 249], d: -67, r: 250, h: 10.4 },
    { at: ['KoehlerR', 41], d: 190, r: 250, h: 12.0 },
    { at: ['main0', 48], d: -185, r: 250, h: 17.9 },
    // </bumps>
  ],
};

export const brennwald: TrackDef = {
  info: {
    id: 'brennwald',
    name: 'Brennwald Ring',
    location: 'Brennwald Forest, Hochwald Uplands',
    description:
      'A fast, old-school grand-prix circuit cut through pine and beech forest: a plunging descent into the Kessel compression and the steep uphill flick that follows, a kilometre of climbing straight to a heavy-braking hairpin, a blind crest taken flat by the brave, a fast double-apex and a tight chicane before the line.',
    difficulty: 4,
    defaultLaps: 3,
    defaultTimeOfDay: 'golden',
    lengthHint: 6843,
    color: '#ffb02e',
  },
  seed: 31337,
  dir: -1,
  plan,
  start: { x: 0, z: 0, phi: -Math.PI * (320 / 180) },
  pvi,
  bank,
  widthL: widths(),
  widthR: widths(),
  defaults: { bandsL: [g(5)], bandsR: [g(5)], barrierL: 'armco', barrierR: 'armco', cross: -0.035 },
  zones,
  sectors: [m('Hang/e'), m('Ausfahrt/m')],
  terrain,
  scenery: {
    stands: [
      { at: m('main', 215), length: 340, side: 'R', gap: 13, rows: 22, roof: true },
      { at: m('main', 545), length: 110, side: 'R', gap: 13, rows: 12, roof: false },
      { at: m('Tor', 150), length: 150, side: 'L', gap: 30, rows: 12, roof: false },
      { at: m('Jaeger', 40), length: 130, side: 'L', gap: 36, rows: 14, roof: false },
    ],
    pits: { from: m('main0', 40), to: m('main', 360), side: 'L' },
    gantry: m('main'),
    bridges: [
      { at: m('main', 470), brand: 2 },
      { at: m('KesselL', -40), brand: 6 },
    ],
    marshals: ['Tor', 'Birke', 'Hirsch', 'Hang', 'KesselL', 'KesselR', 'Jaeger', 'Ausfahrt', 'Wacht', 'ZwillingA', 'ZwillingB', 'KoehlerR', 'KoehlerL'],
    // lamp posts on the grandstand side only: the pit side (left) carries the start-straight TV camera (s = 160), which a pole
    // right in front of its lens would ruin; the pit building and the pit lane are lit by their own windows
    lamps: [{ from: m('main0', 40), to: m('main', 460), spacing: 38, side: 'R' }],
    boards: [
      { at: m('main', 80), side: 'R', gap: 30, brand: 0 },
      { at: m('Hirsch', 60), side: 'L', gap: 30, brand: 1 },
      { at: m('Hang/m'), side: 'L', gap: 34, brand: 4 },
      { at: m('Rampe', 40), side: 'L', gap: 26, brand: 7 },
      { at: m('Wacht', 30), side: 'L', gap: 26, brand: 5 },
      { at: m('gZ'), side: 'L', gap: 30, brand: 3 },
    ],
    brakeBoards: [
      { corner: 'Tor', dist: [300, 200, 150, 100, 50] },
      { corner: 'Hirsch', dist: [150, 100, 50] },
      { corner: 'Jaeger', dist: [300, 200, 150, 100, 50] },
      { corner: 'ZwillingB', dist: [100, 50] },
      { corner: 'KoehlerR', dist: [200, 100, 50] },
    ],
    vegetation: {
      species: [['pine', 0.74], ['birch', 0.14], ['oak', 0.12]],
      density: 2.4,
      forestThreshold: -0.3,
      forestScale: 220,
      clearance: 2.2,
      ramp: 9,
      reach: 230,
      slopeMax: 1.0,
      scale: 15,
    },
  },
};
