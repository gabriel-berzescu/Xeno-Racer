/**
 * The old wood and the sea rocks of Halcyon Ring (`SceneryDef.giants`; world x = -east, z = north: see halcyon.ts for the map).
 *
 * The wood stands on the headland: on the hill inside Osprey, on both sides of the three Jackdaw bends (the road runs between rows
 * of trunks there) and, thinner, on toward Heron. The outside of Osprey is kept open: that is the cliff top, and the view north to
 * the sea, the arch of rock and the arch of the world behind it. At the golden hour the sun stands 23 degrees east of south and
 * eight degrees high, which is two degrees off the line of the road between Jackdaw 2 and Jackdaw 3: the wood is thin and has a
 * glade on that line, south of Jackdaw 3, so that the light comes up the road between the trunks.
 */
import type { GiantsDef } from '../types';

export const halcyonGiants: GiantsDef = {
  seed: 6026,
  wood: {
    groves: [
      // the hill inside Osprey
      { x: 765, z: 1395, r: 175 },
      // down the three bends
      { x: 660, z: 1385, r: 150 },
      { x: 565, z: 1300, r: 185 },
      { x: 440, z: 1215, r: 185 },
      { x: 345, z: 1095, r: 170 },
      // thinning out toward Heron
      { x: 245, z: 1005, r: 135, density: 0.7 },
      { x: 140, z: 985, r: 105, density: 0.42 },
      { x: 40, z: 965, r: 80, density: 0.3 },
    ],
    glades: [
      // the cliff top outside Osprey and the last of the climb to it: the view to the north (no tree of any kind stands in a glade)
      { x: 790, z: 1645, r: 100 },
      { x: 885, z: 1590, r: 75 },
      // the way of the evening light up the road from Jackdaw 3
      { x: 262, z: 930, r: 46 },
    ],
    spacing: 26,
    height: [88, 132],
    girth: [6, 11],
  },
  lone: [
    // the sentinel on the south-west point, outside Curlew: the mark the Strand is driven toward
    { x: 1132, z: -362, height: 121, girth: 10.4 },
  ],
  // due north of the last of the climb to Osprey, 290 m off the cliff, its eastern end grown out of one of the stacks: from the road
  // there the arch of the world rises behind it and through it
  arch: { x: 905, z: 1792, bearing: 0, span: 56, rise: 58, cap: 17 },
  boulders: [
    { x: 800, z: 1612, r: 60, n: 16, size: 5 },
    { x: 905, z: 1790, r: 70, n: 10, size: 4.5 },
    { x: 770, z: 1715, r: 44, n: 8, size: 4 },
  ],
};
