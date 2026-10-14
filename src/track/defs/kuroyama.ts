/**
 * Kuroyama Pass — a closed mountain loop, ~5.3 km, 8-9 m wide, steep grades (up to ~9.5 %), twelve tight
 * switchback hairpins, flowing ridge curves, guardrails close to the road, rock cuts, cliff edges, a short tunnel
 * through the summit. Counter-clockwise: valley straight -> T1 -> east zigzag climb (H1-H6) -> summit ridge
 * (C1-C4, tunnel) -> west zigzag descent (H7-H12) -> D1/D2 -> valley.
 */
import type { LayoutReport, TStep } from '../layout';
import { polyLayout, turtleVerts } from '../layout';
import type { Band, Key, Pvi, TerrainParams, TrackDef, Zone } from '../types';
import { band, m } from './dsl';

const R = 22;
const hairpin = (n: string, defl: number, len: number, free = false): TStep[] => [
  { name: n + 'a', defl: defl / 2, r: R, lsIn: 22, lsOut: 0, len, free },
  { name: n + 'b', defl: defl / 2, r: R, lsIn: 0, lsOut: 22, len: 'join' },
];

const steps: TStep[] = [
  { name: 'T1', defl: 90, r: 45, ls: 30 },
  { name: 'T2', defl: 90, r: 28, len: 110 },
  ...hairpin('H1', -180, 240),
  ...hairpin('H2', 180, 220),
  ...hairpin('H3', -180, 250),
  ...hairpin('H4', 180, 225),
  ...hairpin('H5', -180, 245),
  ...hairpin('H6', 180, 230),
  { name: 'C1', defl: -45, r: 80, len: 270 },
  { name: 'C2', defl: 60, r: 70, len: 160 },
  { name: 'C3', defl: -35, r: 90, len: 170 },
  { name: 'C4', defl: 25, r: 120, len: 140 },
  ...hairpin('H7', 180, 190, true),
  ...hairpin('H8', -180, 240),
  ...hairpin('H9', 180, 225),
  ...hairpin('H10', -180, 250),
  ...hairpin('H11', 180, 230),
  ...hairpin('H12', -180, 240),
  { name: 'D1', defl: 90, r: 45, len: 200 },
  { name: 'D2', defl: 'auto', r: 40, len: 200, free: true },
];

const verts = turtleVerts(steps, { mainLen: 900, origin: { e: 900, n: 0 } });
export const kuroyamaLayout: LayoutReport = polyLayout(verts, { sfAfterLastCorner: 140 });

/** +1 = left hairpin (inside lower => negative bank), -1 = right. */
const HAIRPIN_DIR: Record<string, 1 | -1> = { H1: -1, H2: 1, H3: -1, H4: 1, H5: -1, H6: 1, H7: 1, H8: -1, H9: 1, H10: -1, H11: 1, H12: -1 };

const bank: Key[] = [];
const widthKeys: Key[] = [
  { at: m('main0', 20), v: 4.0 },
  { at: m('main0', 60), v: 4.5 },
  { at: m('main/e', -260), v: 4.5 },
  { at: m('main/e', -60), v: 4.0 },
];
for (const [name, dir] of Object.entries(HAIRPIN_DIR)) {
  const deg = -3.2 * dir;
  bank.push({ at: m(name + 'a'), v: 0 }, { at: m(name + 'a/a'), v: deg }, { at: m(name + 'b/b'), v: deg }, { at: m(name + 'b/e'), v: 0 });
  widthKeys.push({ at: m(name + 'a'), v: 4.0 }, { at: m(name + 'a/a'), v: 4.6 }, { at: m(name + 'b/b'), v: 4.6 }, { at: m(name + 'b/e'), v: 4.0 });
}
const cornerBank = (name: string, deg: number) =>
  bank.push({ at: m(name), v: 0 }, { at: m(name + '/a'), v: deg }, { at: m(name + '/b'), v: deg }, { at: m(name + '/e'), v: 0 });
cornerBank('T1', -2);
cornerBank('T2', -3);
cornerBank('C1', 2);
cornerBank('C2', -3);
cornerBank('C3', 2);
cornerBank('C4', -2);
cornerBank('D1', -3);
cornerBank('D2', -3);

// Elevation: constant grades between marks (hairpins are flatter than the legs), closed with an explicit end height.
const g: [string, number, number][] = [];
const pvi: Pvi[] = [
  { at: m('main'), y: 20.0, vc: 80 },
  { at: m('main/e', -200), grade: 0.004, vc: 120 },
  { at: m('T1/m'), grade: 0.02, vc: 40 },
  { at: m('T2/e'), grade: 0.055, vc: 40 },
];
for (const k of [1, 2, 3, 4, 5, 6]) {
  pvi.push({ at: m(`H${k}a`), grade: k % 2 ? 0.088 : 0.09, vc: 30 }, { at: m(`H${k}b/e`), grade: 0.03, vc: 30 });
}
pvi.push(
  { at: m('C1/m'), grade: 0.05, vc: 60 },
  { at: m('C2/m'), grade: 0.03, vc: 40 },
  { at: m('C3/m'), grade: 0.02, vc: 40 },
  { at: m('C4/m'), grade: 0.0, vc: 40 },
  { at: m('H7a'), grade: -0.035, vc: 60 },
  { at: m('H7b/e'), grade: -0.03, vc: 30 },
);
for (const k of [8, 9, 10, 11, 12]) {
  pvi.push({ at: m(`H${k}a`), grade: -0.099, vc: 30 }, { at: m(`H${k}b/e`), grade: -0.03, vc: 30 });
}
pvi.push({ at: m('D1/m'), grade: -0.08, vc: 40 }, { at: m('D2/m'), grade: -0.08, vc: 30 }, { at: m('main0'), y: 20.4, vc: 40 });
void g;

const terrain: TerrainParams = {
  seed: 11,
  base: 0,
  // the mountain flank: a plane fitted to the road (rises north and east), with a valley floor and a north face
  tilts: [
    { x0: 0, z0: 0, h0: -34.77, gx: -0.0431, gz: 0.3834, lo: 18, hi: 185, soft: 28 },
    { x0: 0, z0: 500, h0: 0, gx: 0, gz: -0.6, lo: -120, hi: 0, soft: 20 },
  ],
  hillAmp: 7,
  hillScale: 240,
  detailAmp: 1.4,
  detailScale: 20,
  mountains: { start: 600, full: 2600, amp: 900, scale: 2000 },
  reach: 34,
  falloff: 26,
  xfade: 11,
  // the summit hill the tunnel pierces
  bumpsAt: [{ at: m('S18', 100), r: 85, h: 26 }],
};

const dirt: Band = band('dirt', 0.9);
const gr: Band = band('grass', 1.3);

export const kuroyama: TrackDef = {
  info: {
    id: 'kuroyama',
    name: 'Kuroyama Pass',
    location: 'Kuroyama Range, Northern Honshu',
    description:
      'A closed mountain road: twelve tight switchbacks up one flank, a ridge crossing through a short tunnel with cliff-edge views, and a plunging descent back to the valley. Narrow, steep, guardrail-close and unforgiving.',
    difficulty: 5,
    defaultLaps: 2,
    defaultTimeOfDay: 'morning',
    lengthHint: 5250,
    color: '#ff2e63',
  },
  seed: 8711,
  dir: 1,
  plan: kuroyamaLayout.plan,
  start: kuroyamaLayout.start,
  pvi,
  bank,
  widthL: widthKeys,
  widthR: widthKeys,
  crown: 0.02,
  curbs: false,
  centerLine: true,
  mowing: false,
  minRunoff: 2.0,
  defaults: { bandsL: [dirt, gr], bandsR: [dirt, gr], barrierL: 'guardrail', barrierR: 'guardrail', cross: -0.05 },
  zones: [] as Zone[],
  tunnels: [{ from: m('S18', 45), to: m('S18', 160) }],
  sectors: [m('H4b/e'), m('H10a')],
  terrain,
  scenery: {
    rockCuts: true,
    roadSigns: {
      chevrons: Array.from({ length: 12 }, (_, i) => `H${i + 1}`),
      warn: Array.from({ length: 12 }, (_, i) => ({ corner: `H${i + 1}`, dist: 70 })),
      mirrors: ['H2', 'H4', 'H6', 'H8', 'H10', 'H12'],
    },
    vegetation: { species: [['pine', 0.76], ['birch', 0.14], ['oak', 0.1]], density: 2.2, forestThreshold: -0.18, forestScale: 150, clearance: 5, ramp: 22, reach: 320, slopeMax: 1.15, scale: 14 },
  },
};
