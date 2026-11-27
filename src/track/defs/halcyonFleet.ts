/**
 * Who came to watch at Halcyon Ring (`SceneryDef.fleet`; world x = -east, z = north: see halcyon.ts for the map).
 *
 * The wind is the trade wind of an atoll, from the east-south-east. A boat at anchor lies head to it, so the fleet's sails stand
 * across the view of a car going north up the Causeway (and the evening sun, in the south-south-east, is on the side of them the
 * driver sees), and across the view south from the Strand, where the same sun comes through them.
 *
 * The lagoon is shallow: a metre of water forty metres off the Causeway, two at a hundred, three and a half at two hundred and
 * fifty. So the boats lie in three lines by what they draw, canoes and catamarans nearest the road, sloops behind them, ketches
 * behind those; a ship of three masts needs deep water and lies off the east shore, off the south-east point and out to the west.
 *
 * The great ship hangs in the west. The sun of this place is in the east all day (up in the north-north-east, due east at noon, down
 * in the south-south-east), so whatever hangs in the eastern sky shows the circuit its shaded side from dawn to dusk, and whatever
 * hangs in the west is lit; and the west is where a car looks on the Strand, with nothing else in that sky. It lies along the ring
 * (north and south are the two ways round it), its bow to the north.
 */
import type { FleetDef } from '../types';

export const halcyonFleet: FleetDef = {
  seed: 8026,
  wind: 115,
  moorings: [
    // ── the Causeway, on the lagoon side (the road runs north along x = 1293) ──
    // the near line, 40 to 90 m off the road: canoes and catamarans in a metre of water
    { line: [[1226, 80], [1231, 600], [1226, 1160]], spread: 22, count: 30, kinds: { proa: 3, cat: 2 }, group: 3 },
    // the middle line, 90 to 165 m: sloops among them
    { line: [[1164, 70], [1170, 600], [1160, 1120]], spread: 34, count: 24, kinds: { sloop: 3, cat: 2, proa: 1 }, group: 4 },
    // the far line, 170 to 260 m: ketches, whose mastheads stand over all the rest
    { line: [[1086, 110], [1076, 600], [1086, 1060]], spread: 40, count: 17, kinds: { ketch: 3, sloop: 2 }, group: 2 },
    // ── the lagoon at large ──
    { line: [[640, 230], [520, 520], [450, 800], [560, 1000]], spread: 110, count: 22, kinds: { sloop: 2, cat: 2, ketch: 1.5, proa: 1 }, group: 3 },
    // under the pits, on the lagoon's east shore
    { line: [[330, 240], [300, 560], [335, 860]], spread: 30, count: 10, kinds: { proa: 2, cat: 2, sloop: 1 }, group: 2 },
    // ── the open sea ──
    // off the Strand's beach
    { line: [[210, -180], [480, -200], [760, -290], [940, -350]], spread: 42, count: 24, kinds: { sloop: 3, ketch: 2, cat: 2, proa: 1 }, group: 3 },
    // beyond Kingfisher, ahead of a car on the start straight
    { line: [[-80, -190], [40, -260], [120, -300]], spread: 45, count: 7, kinds: { ketch: 2, sloop: 2 } },
    // off the east shore, inside the big ships
    { line: [[-320, 140], [-350, 560], [-330, 980]], spread: 45, count: 9, kinds: { ketch: 2, sloop: 2 }, group: 2 },
    // west of the Causeway, where the bottom falls away
    { line: [[1470, 180], [1490, 660], [1465, 1140]], spread: 36, count: 6, kinds: { ketch: 2, sloop: 1 } },
  ],
  berths: [
    // the big ships off the east shore, lying along it (their sides to the island)
    { x: -520, z: 190, kind: 'tall', heading: 18 },
    { x: -575, z: 470, kind: 'tall', heading: 8 },
    { x: -540, z: 780, kind: 'tall', heading: 22 },
    { x: -480, z: 1080, kind: 'tall', heading: 30 },
    // one off the south-east point, to the right of the arch for a car on the grid, and one west of the Causeway
    { x: 205, z: -345, kind: 'tall' },
    { x: 1500, z: 830, kind: 'tall' },
  ],
  courses: [
    // a ship under sail out to the west, north and south along the Causeway a third of a kilometre off
    { kind: 'tall', marks: [[1600, 100], [1600, 1160], [1760, 1160], [1760, 100]], speed: 2.2 },
    // two sloops and three catamarans in the middle of the lagoon
    { kind: 'sloop', marks: [[780, 290], [780, 910], [900, 910], [900, 290]], boats: 2, speed: 2.6 },
    { kind: 'cat', marks: [[940, 280], [940, 920], [1012, 920], [1012, 280]], boats: 3, speed: 3.4 },
    // canoes running along the Strand's beach beside the cars
    { kind: 'proa', marks: [[240, -112], [800, -232], [791, -273], [231, -153]], boats: 3, speed: 3 },
    // a ship standing out to sea north of the headland and back, for whoever looks out from the cliff at Osprey
    { kind: 'tall', marks: [[830, 1930], [650, 2430], [500, 2380], [680, 1880]], speed: 2.2 },
    // a ketch off the east shore, outside the big ships
    { kind: 'ketch', marks: [[-690, 80], [-690, 1150], [-810, 1150], [-810, 80]], speed: 2.4 },
  ],
  ship: { x: 3700, z: -150, altitude: 1000, length: 2200, heading: 350 },
};
