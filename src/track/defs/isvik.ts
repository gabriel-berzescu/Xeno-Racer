/**
 * Isvik Circuit: a winter circuit on packed snow and the frozen Isvattnet, the way ice racing is done in Sweden and Finland.
 * Clockwise, about 4.2 km, 13 m wide between ploughed snowbanks, 12 m of relief, 16 named corners. The lap (s from the start line;
 * the paddock of red cabins is on the left):
 *
 *   main     435 m of start straight, gently downhill, to
 *   Granen   a fast right (48 deg, R100) into the forest, then the flowing medium-speed sweepers Tallen, Furu and Bjork, each
 *            a little too fast for the grip (a Vanta on a handful of throttle slides all the way), up and over the crest
 *   Lind     a slower right (85 deg, R130) at the top of the ridge, and
 *   Skogen   the long fast right (80 deg, R240) down through the spruce to the shore of Isvattnet
 *   the ice  850 m across the frozen lake, flat out on studs: Sjo1 and Sjo2, two long gentle bends in a straight line of
 *            snowbank markers, 15 m wide, where the road is ice (0.4 of dry asphalt, the packed snow around it 0.5)
 *   Vand     the switchbacks up the north shore: a right hairpin (R25, heavy braking from the ice), a short climb and a left
 *            hairpin back, the snowbank of the first an inch from the second
 *   Stranden / Kojan / Klippan   the old fishing village of red cabins on the shore road, a right, a left flick, a right
 *   Malet    the last corner (32 deg, R200) onto the start straight
 *
 * The lap is built with the turtle layout (corner deflection, radius, distance from the previous vertex; two edges are solved so
 * that the loop closes exactly). The road is packed snow (`winter.road`) and ice on the lake (`winter.patches`, a stretch of the
 * road that is flat at the level of the lake: `terrain.frozen`), with 0.8 m of packed shoulder and 2.2 m of deep snow at the foot
 * of the snowbank, which is the barrier (it slows a car, it does not throw it back).
 */
import { polyLayout, turtleVerts, type TStep } from '../layout';
import type { Band, Key, Pvi, TerrainParams, TrackDef, Zone } from '../types';
import { band, m } from './dsl';

const snow = (w: number): Band => band('snow', w);
const deep = (w: number): Band => band('deepsnow', w);

// clockwise: right turns are negative. `len` is the distance from the previous vertex; two edges (free) close the loop.
const steps: TStep[] = [
  { name: 'Granen', defl: -48, r: 100 },
  { name: 'Tallen', defl: 35, r: 170, len: 270 },
  { name: 'Furu', defl: -50, r: 130, len: 220 },
  { name: 'Bjork', defl: 40, r: 140, len: 210 },
  { name: 'Lind', defl: -85, r: 130, len: 270 },
  { name: 'Skogen', defl: -80, r: 240, len: 400 },
  { name: 'Sjo1', defl: 14, r: 450, free: true },
  { name: 'Sjo2', defl: -14, r: 400, len: 330 },
  { name: 'Vand1a', defl: -75, r: 25, len: 280 },
  { name: 'Vand1b', defl: -75, r: 25, len: 66 },
  { name: 'Vand2a', defl: 75, r: 25, len: 190 },
  { name: 'Vand2b', defl: 75, r: 25, len: 66 },
  { name: 'Stranden', defl: -85, r: 120, len: 280 },
  { name: 'Kojan', defl: 25, r: 200, free: true },
  { name: 'Klippan', defl: -80, r: 110, len: 230 },
  { name: 'Malet', defl: 'auto', r: 200, len: 240 },
];
const verts = turtleVerts(steps, { mainLen: 600, origin: { e: 0, n: 0 }, dir: -1 });
export const isvikLayout = polyLayout(verts, { sfAfterLastCorner: 100 });

const pvi: Pvi[] = [
  { at: m('main0'), y: 12.0, vc: 60 },
  { at: m('main/m'), y: 10.2, vc: 90 },
  { at: m('Granen'), y: 8.8, vc: 60 },
  { at: m('Tallen/m'), y: 7.2, vc: 90 },
  { at: m('Furu/m'), y: 9.4, vc: 80 },
  { at: m('Bjork/m'), y: 11.6, vc: 100 },
  { at: m('Lind/m'), y: 9.0, vc: 80 },
  { at: m('Skogen/a'), y: 6.0, vc: 80 },
  { at: m('Skogen/e', 60), y: 3.5, vc: 70 },
  { at: m('Sjo2/e', 40), y: 3.5, vc: 50 },
  { at: m('Vand1a'), y: 7.6, vc: 50 },
  { at: m('Vand1b/e'), y: 8.6, vc: 30 },
  { at: m('Vand2a'), y: 13.6, vc: 50 },
  { at: m('Vand2b/e'), y: 14.6, vc: 30 },
  { at: m('Stranden/m'), y: 15.4, vc: 80 },
  { at: m('Kojan/m'), y: 16.2, vc: 90 },
  { at: m('Klippan/m'), y: 15.0, vc: 80 },
  { at: m('Malet/m'), y: 13.4, vc: 80 },
];

// half-widths of the road (m): 13 m, a metre or two wider across the ice, narrower in the village
const widths = (): Key[] => [
  { at: m('main0', 20), v: 6.5 },
  { at: m('Granen'), v: 6.5 },
  { at: m('Furu/m'), v: 6.25 },
  { at: m('Lind/m'), v: 6.25 },
  { at: m('Skogen/m'), v: 6.5 },
  { at: m('Skogen/e', 40), v: 7.5 },
  { at: m('Sjo2/e', 40), v: 7.5 },
  { at: m('Vand1a', -60), v: 6.5 },
  { at: m('Vand1b/e'), v: 6.5 },
  { at: m('Stranden/m'), v: 6.0 },
  { at: m('Kojan/m'), v: 5.75 },
  { at: m('Klippan/m'), v: 6.0 },
  { at: m('Malet'), v: 6.5 },
];

const zones: Zone[] = [
  // the paddock side of the start straight: a wider shoulder of packed snow between the road and the bank (the pit lane)
  { side: 'L', from: m('Malet/e'), to: m('main/m'), bands: [snow(4.5), deep(2.0)] },
  // on the lake the ground is flat: no fall away from the road
  { side: 'B', from: m('Skogen/e', 20), to: m('Sjo2/e', 60), cross: 0 },
];

const terrain: TerrainParams = {
  seed: 47,
  base: 9,
  hillAmp: 5,
  hillScale: 320,
  detailAmp: 0.45,
  detailScale: 22,
  mountains: { start: 700, full: 2600, amp: 300, scale: 1700 },
  reach: 55,
  falloff: 40,
  xfade: 5.5,
  frozen: { at: m('Sjo1/e', -40), along: 430, across: 210, level: 3.5, shore: 45 },
};

export const isvik: TrackDef = {
  info: {
    id: 'isvik',
    name: 'Isvik Circuit',
    location: 'Isvik, Lake Isvattnet, Norrland',
    description:
      'A winter circuit on packed snow and the frozen Isvattnet: flowing sweepers through the spruce between ploughed snowbanks, 850 m flat out across the ice where the studs bite and the tail comes round, and a heavy-braking switchback up the shore into the fishing village.',
    difficulty: 4,
    defaultLaps: 3,
    defaultTimeOfDay: 'golden',
    lengthHint: 4200,
    color: '#8fd3ff',
    floodlit: true,
    winter: true,
  },
  seed: 70331,
  dir: -1,
  plan: isvikLayout.plan,
  start: isvikLayout.start,
  pvi,
  bank: [],
  widthL: widths(),
  widthR: widths(),
  crown: 0,
  defaults: { bandsL: [snow(0.8), deep(2.2)], bandsR: [snow(0.8), deep(2.2)], barrierL: 'snowbank', barrierR: 'snowbank', cross: -0.02 },
  minRunoff: 1.5,
  curbs: false,
  mowing: false,
  winter: { road: 'snow', ground: 'deepsnow', patches: [{ from: m('Skogen/e', 70), to: m('Sjo2/e', 40), surf: 'ice' }] },
  zones,
  sectors: [m('Lind/e'), m('Vand1a')],
  terrain,
  scenery: {
    gantry: m('main'),
    marshals: ['Granen', 'Furu', 'Lind', 'Skogen', 'Vand1a', 'Vand2a', 'Stranden', 'Klippan'],
    lamps: [{ from: m('Malet/e'), to: m('main', 300), spacing: 36, side: 'B' }],
    brakeBoards: [
      { corner: 'Granen', dist: [200, 100, 50] },
      { corner: 'Vand1a', dist: [200, 150, 100, 50] },
      { corner: 'Stranden', dist: [100, 50] },
    ],
  },
};
