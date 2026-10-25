/**
 * The car roster. All makes and models are fictional.
 */
import { bodyCgZ, type CarDefinition, type CarVisualSpec, type EngineSoundProfile } from '../core/contracts';
import type { TireSpec, VehicleSpec } from '../physics/spec';

const DEG = Math.PI / 180;

/** Tire radius from an ISO size like 265/35R20. */
function tireRadius(widthMm: number, aspect: number, rimIn: number): number {
  return (rimIn * 25.4) / 2000 + (widthMm * aspect) / 100000;
}

function roadTire(widthMm: number, aspect: number, rimIn: number, mu: number, extra: Partial<TireSpec> = {}): TireSpec {
  return {
    radius: tireRadius(widthMm, aspect, rimIn),
    width: widthMm / 1000,
    inertia: 1.5,
    mu,
    loadSensitivity: 0.16,
    nominalLoad: 4000,
    peakSlipAngle: 7.5 * DEG,
    peakSlipRatio: 0.11,
    slideRatio: 0.78,
    relaxationLength: 0.45,
    rollingResistance: 0.012,
    optimalTemp: 85,
    tempWindow: 45,
    coldGrip: 0.88,
    ...extra,
  };
}

/** Collision hull derived from the body dimensions so physics and visuals agree. */
function hullFromVisual(v: CarVisualSpec, cgToFrontAxle: number): Pick<VehicleSpec['chassis'], 'hullHalf' | 'hullOffset'> {
  const rearOverhang = v.length - v.wheelbase - v.frontOverhang;
  const front = v.wheelbase / 2 + v.frontOverhang;
  const rear = -(v.wheelbase / 2 + rearOverhang);
  const cgZ = bodyCgZ({ wheelbase: v.wheelbase, cgToFrontAxle }); // the CG along the body, from the body origin
  const bottom = v.rideHeight;
  const top = v.height * 0.92; // the roof is narrower than the box; shave it a bit
  return {
    hullHalf: { x: v.width / 2, y: (top - bottom) / 2, z: (front - rear) / 2 },
    hullOffset: { x: 0, y: (top + bottom) / 2 - v.cgHeight, z: (front + rear) / 2 - cgZ },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Vanta GT — front-mid-engined twin-turbo V8 grand tourer. The all-rounder.
// ─────────────────────────────────────────────────────────────────────────────
const vantaVisual: CarVisualSpec = {
  style: 'gt',
  length: 4.62,
  width: 1.97,
  height: 1.22,
  wheelbase: 2.7,
  trackFront: 1.67,
  trackRear: 1.63,
  frontOverhang: 1.0,
  wheelRadiusFront: tireRadius(265, 35, 20),
  wheelRadiusRear: tireRadius(305, 30, 20),
  tireWidthFront: 0.265,
  tireWidthRear: 0.305,
  rimRadiusFront: 0.254,
  rimRadiusRear: 0.254,
  rideHeight: 0.12,
  cgHeight: 0.46,
  cgToFrontAxle: 1.431,
  wing: 0.25,
  engine: 'front',
  exhaust: { count: 4, side: 'split' },
  seat: { x: 0.36, y: 0.42, z: -0.35 },
};

const vanta: CarDefinition = {
  id: 'vanta-gt',
  name: 'Vanta GT',
  maker: 'Xeno Automobili',
  description:
    'A front-mid-engined grand tourer with a 4.0 L twin-turbo flat-plane V8. Planted, fast and honest — until you lift mid-corner.',
  class: 'GT',
  drivetrain: 'RWD',
  stats: { powerHp: 610, torqueNm: 700, massKg: 1480, topSpeedKmh: 338, zeroTo100: 4.6 },
  visual: vantaVisual,
  sound: { cylinders: 8, layout: 'v', crankType: 'flat', displacement: 4.0, turbo: true, exhaustOpenness: 0.6, brightness: 0.68, gearWhine: 0.12, crackle: 0.55 },
  defaultLivery: { primary: '#1c2c5a', secondary: '#e9eaee', accent: '#ff6a1a', pattern: 'stripes', number: 7, driver: 'You', finish: 0, metallic: true },
  physics: {
    chassis: {
      mass: 1480,
      inertia: { x: 2700, y: 2650, z: 560 },
      cgHeight: 0.46,
      wheelbase: 2.7,
      cgToFrontAxle: 1.431,
      trackFront: 1.67,
      trackRear: 1.63,
      maxSteer: 32 * DEG,
      ackermann: 0.6,
      ...hullFromVisual(vantaVisual, 1.431),
    },
    engine: {
      idleRpm: 900,
      redlineRpm: 7800,
      limiterRpm: 8000,
      torqueCurve: [
        [0, 300], [1000, 380], [2000, 560], [2500, 690], [3000, 700], [4000, 700], [5000, 700],
        [6000, 690], [6500, 662], [7000, 622], [7500, 578], [8000, 520], [8500, 440],
      ],
      engineBraking: 120,
      inertia: 0.22,
      turbo: { baseFraction: 0.55, spoolTime: 0.35, spoolRpm: 1800 },
    },
    drivetrain: {
      layout: 'RWD',
      gears: [3.13, 2.12, 1.63, 1.3, 1.07, 0.88, 0.71],
      reverse: 2.9,
      finalDrive: 3.7,
      efficiency: 0.9,
      shiftTime: 0.08,
      upshiftRpm: 7600,
      downshiftRpm: 3800,
      diff: { type: 'lsd', preload: 80, powerLock: 0.35, coastLock: 0.2 },
      frontSplit: 0,
    },
    brakes: { frontTorque: 3300, rearTorque: 1400, handbrakeTorque: 2400, discHeatCapacity: 4200 },
    aero: { dragArea: 0.74, liftAreaFront: 0.22, liftAreaRear: 0.32 },
    // track-biased performance tires: superb dry, mediocre in standing water
    tireFront: roadTire(265, 35, 20, 1.14, { wetGrip: 0.66 }),
    tireRear: roadTire(305, 30, 20, 1.14, { wetGrip: 0.66 }),
    suspFront: { travel: 0.12, spring: 46000, bump: 2400, rebound: 4400, antiRoll: 32000, camber: -1.6 * DEG },
    suspRear: { travel: 0.12, spring: 52000, bump: 2600, rebound: 4800, antiRoll: 22000, camber: -1.2 * DEG },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Kestrel R — front-drive 2.0 turbo hot hatch. Grippy, pointy, lift-off oversteer.
// ─────────────────────────────────────────────────────────────────────────────
const kestrelVisual: CarVisualSpec = {
  style: 'hatch',
  length: 4.32,
  width: 1.82,
  height: 1.44,
  wheelbase: 2.62,
  trackFront: 1.56,
  trackRear: 1.54,
  frontOverhang: 0.92,
  wheelRadiusFront: tireRadius(235, 35, 19),
  wheelRadiusRear: tireRadius(235, 35, 19),
  tireWidthFront: 0.235,
  tireWidthRear: 0.235,
  rimRadiusFront: 0.2413,
  rimRadiusRear: 0.2413,
  rideHeight: 0.13,
  cgHeight: 0.52,
  cgToFrontAxle: 0.996,
  wing: 0.15,
  engine: 'front',
  exhaust: { count: 2, side: 'center' },
  seat: { x: 0.38, y: 0.5, z: -0.2 },
};

const kestrel: CarDefinition = {
  id: 'kestrel-r',
  name: 'Kestrel R',
  maker: 'Kestrel Motorworks',
  description:
    'A 320 hp front-drive hot hatch with a helical limited-slip diff. Pulls you out of corners — and swings its tail if you brake late.',
  class: 'Sport',
  drivetrain: 'FWD',
  stats: { powerHp: 320, torqueNm: 420, massKg: 1320, topSpeedKmh: 270, zeroTo100: 5.6 },
  visual: kestrelVisual,
  sound: { cylinders: 4, layout: 'inline', crankType: 'flat', displacement: 2.0, turbo: true, exhaustOpenness: 0.5, brightness: 0.55, gearWhine: 0.1, crackle: 0.7 },
  defaultLivery: { primary: '#eceef0', secondary: '#d0102b', accent: '#15161a', pattern: 'split', number: 21, driver: 'You', finish: 0, metallic: false },
  physics: {
    chassis: {
      mass: 1320,
      inertia: { x: 2250, y: 2150, z: 480 },
      cgHeight: 0.52,
      wheelbase: 2.62,
      cgToFrontAxle: 0.996,
      trackFront: 1.56,
      trackRear: 1.54,
      maxSteer: 34 * DEG,
      ackermann: 0.7,
      ...hullFromVisual(kestrelVisual, 0.996),
    },
    engine: {
      idleRpm: 850,
      redlineRpm: 6800,
      limiterRpm: 7000,
      torqueCurve: [
        [0, 180], [1000, 220], [1500, 320], [2000, 420], [3000, 420], [4000, 420], [5000, 420],
        [5500, 402], [6000, 376], [6500, 342], [7000, 292], [7500, 230],
      ],
      engineBraking: 75,
      inertia: 0.16,
      turbo: { baseFraction: 0.5, spoolTime: 0.45, spoolRpm: 1700 },
    },
    drivetrain: {
      layout: 'FWD',
      gears: [3.54, 2.26, 1.64, 1.31, 1.05, 0.84],
      reverse: 3.25,
      finalDrive: 3.62,
      efficiency: 0.92,
      shiftTime: 0.16,
      upshiftRpm: 6600,
      downshiftRpm: 3200,
      diff: { type: 'lsd', preload: 40, powerLock: 0.4, coastLock: 0.1 },
      frontSplit: 1,
    },
    brakes: { frontTorque: 2700, rearTorque: 700, handbrakeTorque: 2000, discHeatCapacity: 3300 },
    aero: { dragArea: 0.72, liftAreaFront: 0.04, liftAreaRear: 0.08 },
    tireFront: roadTire(235, 35, 19, 1.08, { wetGrip: 0.72 }),
    tireRear: roadTire(235, 35, 19, 1.08, { wetGrip: 0.72 }),
    suspFront: { travel: 0.13, spring: 42000, bump: 2300, rebound: 4000, antiRoll: 26000, camber: -1.4 * DEG },
    suspRear: { travel: 0.13, spring: 34000, bump: 1900, rebound: 3400, antiRoll: 30000, camber: -1.6 * DEG },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Ronin 86 — light, balanced, naturally aspirated boxer coupe on skinny tires.
// ─────────────────────────────────────────────────────────────────────────────
const roninVisual: CarVisualSpec = {
  style: 'coupe',
  length: 4.26,
  width: 1.78,
  height: 1.3,
  wheelbase: 2.57,
  trackFront: 1.52,
  trackRear: 1.55,
  frontOverhang: 0.86,
  wheelRadiusFront: tireRadius(215, 40, 18),
  wheelRadiusRear: tireRadius(215, 40, 18),
  tireWidthFront: 0.215,
  tireWidthRear: 0.215,
  rimRadiusFront: 0.2286,
  rimRadiusRear: 0.2286,
  rideHeight: 0.12,
  cgHeight: 0.46,
  cgToFrontAxle: 1.208,
  wing: 0.35,
  engine: 'front',
  exhaust: { count: 2, side: 'split' },
  seat: { x: 0.36, y: 0.38, z: -0.45 },
};

const ronin: CarDefinition = {
  id: 'ronin-86',
  name: 'Ronin 86',
  maker: 'Ronin',
  description:
    'Light, balanced and naturally aspirated, on deliberately modest tires. It will slide at any speed you ask it to — the purest teacher on the grid.',
  class: 'Road',
  drivetrain: 'RWD',
  stats: { powerHp: 240, torqueNm: 250, massKg: 1200, topSpeedKmh: 254, zeroTo100: 6.6 },
  visual: roninVisual,
  sound: { cylinders: 4, layout: 'flat', crankType: 'boxer', displacement: 2.4, turbo: false, exhaustOpenness: 0.45, brightness: 0.5, gearWhine: 0.05, crackle: 0.25 },
  defaultLivery: { primary: '#f2c200', secondary: '#121316', accent: '#ffffff', pattern: 'arrow', number: 86, driver: 'You', finish: 0, metallic: false },
  physics: {
    chassis: {
      mass: 1200,
      inertia: { x: 2000, y: 1950, z: 420 },
      cgHeight: 0.46,
      wheelbase: 2.57,
      cgToFrontAxle: 1.208,
      trackFront: 1.52,
      trackRear: 1.55,
      maxSteer: 38 * DEG,
      ackermann: 0.4,
      ...hullFromVisual(roninVisual, 1.208),
    },
    engine: {
      idleRpm: 800,
      redlineRpm: 7400,
      limiterRpm: 7600,
      torqueCurve: [
        [0, 130], [1000, 160], [2000, 200], [3000, 230], [3700, 250], [4500, 244], [5000, 240],
        [6000, 236], [7000, 244], [7400, 228], [7800, 200],
      ],
      engineBraking: 55,
      inertia: 0.12,
      turbo: null,
    },
    drivetrain: {
      layout: 'RWD',
      gears: [3.63, 2.19, 1.54, 1.21, 1.0, 0.77],
      reverse: 3.44,
      finalDrive: 4.3,
      efficiency: 0.91,
      shiftTime: 0.15,
      upshiftRpm: 7300,
      downshiftRpm: 4000,
      diff: { type: 'lsd', preload: 60, powerLock: 0.5, coastLock: 0.3 },
      frontSplit: 0,
    },
    brakes: { frontTorque: 2300, rearTorque: 820, handbrakeTorque: 2200, discHeatCapacity: 3000 },
    aero: { dragArea: 0.66, liftAreaFront: 0.02, liftAreaRear: 0.05 },
    // modest treaded tires: the least grip in the dry, the most of it kept in the wet
    tireFront: roadTire(215, 40, 18, 1.0, { peakSlipAngle: 8 * DEG, slideRatio: 0.82, wetGrip: 0.76 }),
    tireRear: roadTire(215, 40, 18, 1.0, { peakSlipAngle: 8 * DEG, slideRatio: 0.82, wetGrip: 0.76 }),
    suspFront: { travel: 0.13, spring: 34000, bump: 2000, rebound: 3500, antiRoll: 24000, camber: -1.5 * DEG },
    suspRear: { travel: 0.13, spring: 38000, bump: 2100, rebound: 3700, antiRoll: 16000, camber: -1.2 * DEG },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Xeno LMP-X — naturally aspirated V10 prototype. Downforce, slicks, no mercy.
// ─────────────────────────────────────────────────────────────────────────────
const lmpVisual: CarVisualSpec = {
  style: 'prototype',
  length: 4.75,
  width: 1.9,
  height: 1.05,
  wheelbase: 2.95,
  trackFront: 1.62,
  trackRear: 1.58,
  frontOverhang: 1.0,
  wheelRadiusFront: 0.345,
  wheelRadiusRear: 0.355,
  tireWidthFront: 0.31,
  tireWidthRear: 0.34,
  rimRadiusFront: 0.2286,
  rimRadiusRear: 0.2286,
  rideHeight: 0.06,
  cgHeight: 0.3,
  cgToFrontAxle: 1.593,
  wing: 1,
  engine: 'mid',
  exhaust: { count: 2, side: 'center' },
  seat: { x: 0.3, y: 0.3, z: 0.1 },
};

const lmp: CarDefinition = {
  id: 'lmp-x',
  name: 'LMP-X',
  maker: 'Xeno Racing',
  description:
    'A 950 kg prototype with a screaming 4.5 L V10 and more downforce than weight at 250 km/h. Slicks need heat and hate grass and gravel. Respect it.',
  class: 'Prototype',
  drivetrain: 'RWD',
  stats: { powerHp: 690, torqueNm: 590, massKg: 950, topSpeedKmh: 318, zeroTo100: 2.6 },
  visual: lmpVisual,
  sound: { cylinders: 10, layout: 'v', crankType: 'flat', displacement: 4.5, turbo: false, exhaustOpenness: 1, brightness: 0.88, gearWhine: 0.8, crackle: 0.6 },
  defaultLivery: { primary: '#0e0f13', secondary: '#16e0bd', accent: '#ff2e63', pattern: 'shards', number: 1, driver: 'You', finish: 0.5, metallic: false },
  physics: {
    chassis: {
      mass: 950,
      inertia: { x: 1750, y: 1650, z: 300 },
      cgHeight: 0.3,
      wheelbase: 2.95,
      cgToFrontAxle: 1.593,
      trackFront: 1.62,
      trackRear: 1.58,
      maxSteer: 24 * DEG,
      ackermann: 0.2,
      ...hullFromVisual(lmpVisual, 1.593),
    },
    engine: {
      idleRpm: 1600,
      redlineRpm: 9300,
      limiterRpm: 9500,
      torqueCurve: [
        [0, 250], [2000, 360], [3000, 420], [4000, 480], [5000, 530], [6000, 560], [7000, 582],
        [8000, 590], [8500, 572], [9000, 532], [9500, 470], [10000, 400],
      ],
      engineBraking: 140,
      inertia: 0.09,
      turbo: null,
    },
    drivetrain: {
      layout: 'RWD',
      gears: [2.92, 2.18, 1.76, 1.47, 1.26, 1.1],
      reverse: 2.8,
      finalDrive: 3.25,
      efficiency: 0.93,
      shiftTime: 0.04,
      upshiftRpm: 9100,
      downshiftRpm: 5500,
      diff: { type: 'lsd', preload: 120, powerLock: 0.45, coastLock: 0.3 },
      frontSplit: 0,
    },
    brakes: { frontTorque: 4400, rearTorque: 2300, handbrakeTorque: 1500, discHeatCapacity: 2600 },
    aero: { dragArea: 1.05, liftAreaFront: 1.55, liftAreaRear: 2.05 },
    tireFront: {
      ...roadTire(310, 30, 18, 1.62),
      radius: 0.345,
      width: 0.31,
      inertia: 1.3,
      loadSensitivity: 0.2,
      nominalLoad: 4500,
      peakSlipAngle: 5.2 * DEG,
      peakSlipRatio: 0.085,
      slideRatio: 0.72,
      relaxationLength: 0.3,
      optimalTemp: 95,
      tempWindow: 35,
      coldGrip: 0.74,
      // (wet-weather compound fitted when it rains: slicks would keep barely half)
      wetGrip: 0.6,
      // (a racing tyre, dry slick or wet: the king of the asphalt, and on grass, dirt and gravel a good deal worse than a road tyre, wet
      // or dry — a racing wet's shallow grooves clear water from asphalt, not mud from turf; src/physics/surfaces.ts)
      slick: 1,
    },
    tireRear: {
      ...roadTire(340, 30, 18, 1.62),
      radius: 0.355,
      width: 0.34,
      inertia: 1.4,
      loadSensitivity: 0.2,
      nominalLoad: 4500,
      peakSlipAngle: 5.2 * DEG,
      peakSlipRatio: 0.085,
      slideRatio: 0.72,
      relaxationLength: 0.3,
      optimalTemp: 95,
      tempWindow: 35,
      coldGrip: 0.74,
      // (wet-weather compound fitted when it rains: slicks would keep barely half)
      wetGrip: 0.6,
      slick: 1,
    },
    suspFront: { travel: 0.07, spring: 110000, bump: 4200, rebound: 7000, antiRoll: 60000, camber: -2.8 * DEG },
    suspRear: { travel: 0.07, spring: 125000, bump: 4600, rebound: 7600, antiRoll: 42000, camber: -1.8 * DEG },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Mammoth — supercharged cross-plane V8 4x4 on all-terrain tyres. Brutal off the line, anywhere.
// ─────────────────────────────────────────────────────────────────────────────
// What it does on a flat plane (tests/probes/mammoth-probe.test.ts holds the table, tests/mammoth.test.ts the bounds): 0-100 km/h in 3.8 s with the
// traction control on (all four tyres pull: 1.06 g in first gear, 60 mph in 3.6 s), 200 in 14.2 s, the quarter mile in 12.0 s, and 260 km/h flat out
// in sixth (the drag of a brick, CdA 1.8, has used up the 710 hp long before the revs have; seventh and eighth are for cruising). It stops from
// 100 in 37.1 m with ABS (1.06 g) and holds 0.89 g on the skidpad, leaning 5 degrees at the limit where a sports car leans one; it squats 3.3 degrees
// under power and dives 3.3 under the brakes (a sports car: 0.6 and 1.2). On grass, gravel, dirt and sand it keeps 78-90 % of its asphalt grip where a
// road tyre keeps 50-70, and on deep snow 90 % of its packed-snow grip against 65, and it loses less speed to the ploughing; on a kerb of 12 cm at
// 200 km/h its long-travel suspension keeps two fifths of the load on the wheel a sports car is thrown into the air by. Thrown into a flick at 110 km/h,
// or over the apex kerb of a corner at the limit, it lifts an inner wheel; it cannot be tipped by a wall, a bank or loose ground in this model (its
// tyres hold 1.05 g, a rollover takes 1.2). On packed snow, studded like every car there, it gets to 100 in 5.6 s against 10 for the rear- and
// front-drive cars, and corners worse than they do (0.46 g against 0.50-0.56: heavy, tall and wide). On a lap it is level with the Kestrel in the dry
// (5-13 % behind the Vanta), second to the LMP-X in the rain on four circuits of five, and the quickest road car at Isvik, dry and in the snow.

/**
 * An all-terrain tyre: open blocks and a tall sidewall. Less bite on asphalt (a lower `mu` than a road tyre of the size, and a longer
 * answer: a taller, softer carcass peaks at a larger slip angle and takes a longer run to build its force), much more of it on loose
 * ground (`offroad`, src/physics/surfaces.ts), and good in the wet (the voids clear the water). It is a big tyre: 3.6 kg m^2 of wheel,
 * and twice the rubber and the surface of a low-profile road tyre, so the work of cornering under 2.4 t warms it no more than a sports
 * car warms its own (`heatScale`: lap after lap on Aurelia it runs 67-76 C, its working temperature, where without it it cooked at 130 C and lost a
 * tenth of its grip).
 */
function allTerrainTire(widthMm: number, aspect: number, rimIn: number, mu: number, extra: Partial<TireSpec> = {}): TireSpec {
  return roadTire(widthMm, aspect, rimIn, mu, {
    inertia: 3.6,
    loadSensitivity: 0.15,
    nominalLoad: 6000,
    peakSlipAngle: 9 * DEG,
    peakSlipRatio: 0.13,
    slideRatio: 0.86,
    relaxationLength: 0.62,
    rollingResistance: 0.015,
    optimalTemp: 70,
    tempWindow: 55,
    coldGrip: 0.9,
    wetGrip: 0.8,
    offroad: 1,
    heatScale: 1.9,
    ...extra,
  });
}

const mammothVisual: CarVisualSpec = {
  style: 'suv',
  length: 4.9,
  width: 2.04,
  height: 1.84,
  wheelbase: 2.95,
  trackFront: 1.72,
  trackRear: 1.72,
  frontOverhang: 0.86,
  wheelRadiusFront: tireRadius(315, 55, 20),
  wheelRadiusRear: tireRadius(315, 55, 20),
  tireWidthFront: 0.315,
  tireWidthRear: 0.315,
  rimRadiusFront: 0.254,
  rimRadiusRear: 0.254,
  rideHeight: 0.27,
  cgHeight: 0.72,
  cgToFrontAxle: 1.357,
  wing: 0,
  engine: 'front',
  exhaust: { count: 2, side: 'side' },
  seat: { x: 0.4, y: 0.8, z: -0.1 },
};

const mammoth: CarDefinition = {
  id: 'mammoth',
  name: 'Mammoth',
  maker: 'Xeno Overland',
  description:
    'A 2.4-tonne 4x4 with a supercharged 6.2 L cross-plane V8 and all-terrain tyres. Launches like nothing else on any surface and shrugs at gravel — just never ask it to dance through fast bends.',
  class: 'SUV',
  drivetrain: 'AWD',
  // (measured: 0-100 in 3.83 s with the traction control on, 260.6 km/h after 150 s flat out; the curve gives 709.6 hp at 6200 rpm and 880 Nm at 4800)
  stats: { powerHp: 710, torqueNm: 880, massKg: 2450, topSpeedKmh: 260, zeroTo100: 3.8 },
  visual: mammothVisual,
  sound: {
    cylinders: 8, layout: 'v', crankType: 'crossplane', displacement: 6.2, turbo: false, exhaustOpenness: 0.7, brightness: 0.42, gearWhine: 0.15, crackle: 0.5,
    supercharger: { ratio: 2.5, lobes: 4 }, exhaustSystem: 'dual',
  },
  // (satin dark olive over black cladding, an orange break line, orange recovery hooks: the accent colour is the hooks')
  defaultLivery: { primary: '#444b34', secondary: '#101112', accent: '#ff7a00', pattern: 'split', number: 4, driver: 'You', finish: 0.78, metallic: false },
  physics: {
    chassis: {
      mass: 2450,
      inertia: { x: 4600, y: 4800, z: 1200 },
      cgHeight: 0.72,
      wheelbase: 2.95,
      cgToFrontAxle: 1.357,
      trackFront: 1.72,
      trackRear: 1.72,
      maxSteer: 34 * DEG,
      ackermann: 0.6,
      ...hullFromVisual(mammothVisual, 1.357),
    },
    engine: {
      idleRpm: 650,
      redlineRpm: 6200,
      limiterRpm: 6500,
      // a positive-displacement blower: full boost from just off idle, no lag (no `turbo`)
      torqueCurve: [
        [0, 420], [1000, 580], [1500, 700], [2000, 780], [2500, 830], [3000, 855], [3500, 870], [4000, 878], [4800, 880],
        [5200, 872], [5600, 852], [6000, 830], [6200, 815], [6500, 775], [7000, 640],
      ],
      engineBraking: 160,
      inertia: 0.3,
      turbo: null,
    },
    drivetrain: {
      layout: 'AWD',
      gears: [4.71, 3.14, 2.11, 1.67, 1.29, 1.0, 0.84, 0.67],
      reverse: 3.3,
      finalDrive: 3.7,
      efficiency: 0.86,
      shiftTime: 0.12,
      upshiftRpm: 6300,
      downshiftRpm: 3600,
      // (the rear differential; the centre one splits 40:60 front:rear and locks up under power, the front one is open)
      diff: { type: 'lsd', preload: 100, powerLock: 0.35, coastLock: 0.2 },
      frontSplit: 0.4,
      centerDiff: { type: 'lsd', preload: 120, powerLock: 0.35, coastLock: 0.2 },
      frontDiff: { type: 'open', preload: 0, powerLock: 0, coastLock: 0 },
    },
    // (sized for the weight: a full pedal asks for 1.34 g, more than the tyres give, so ABS has the last word on dry asphalt as on a sports car)
    brakes: { frontTorque: 4600, rearTorque: 2300, handbrakeTorque: 2200, discHeatCapacity: 5200 },
    // a brick with a light bar: 3.3 m^2 of frontal area at a Cd of 0.55, no downforce, a little lift (0.5 kN at the top speed: 2 % of the weight)
    aero: { dragArea: 1.8, liftAreaFront: -0.1, liftAreaRear: -0.06 },
    // (1.03 on asphalt, where a road tyre of the size has 1.1-1.15; the studded tyre of a winter circuit has its own friction, src/physics/compound.ts)
    tireFront: allTerrainTire(315, 55, 20, 1.045),
    tireRear: allTerrainTire(315, 55, 20, 1.045),
    // Long travel and soft: 24 and 26 cm, so that a 12 cm kerb or the foot of a snowbank is a bump and not a launch ramp. Wheel rates of 32 and 36 kN/m
    // (1.11 Hz on a 660 kg front corner, 1.27 Hz on a 560 kg rear one) with bars of 12 and 2 kN/m give 142 kNm/rad of roll stiffness: the 5 degrees at
    // 0.89 g that the body shows (m a (h - roll centre) over it), and 3.3 degrees of pitch at 1 g. 58 % of the roll stiffness is at the front, where the
    // car weighs more: a tall, short-tracked car shifts 7 kN across its axles at the limit, and a set-up with 54 % of it at the rear (a bar of 7 kN/m there)
    // gave a higher skidpad figure but left the lighter rear axle an inner wheel at 0.5 kN, a tail that swung in a lane change to 27 degrees of body slip
    // (a Vanta: 7) and a spin without the aids.
    // Damped at 0.33 in bump and 0.61 in rebound at the front (0.36 and 0.67 at the rear), so that a hard flick at speed unloads an inner wheel for a moment.
    suspFront: { travel: 0.24, spring: 32000, bump: 3000, rebound: 5600, antiRoll: 12000, camber: -0.4 * DEG },
    suspRear: { travel: 0.26, spring: 36000, bump: 3200, rebound: 6000, antiRoll: 2000, camber: -0.2 * DEG },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Volta — a 2026-rules turbo-hybrid single-seater. Wings that open on the straights, and an electric motor only the nitro wakes.
// ─────────────────────────────────────────────────────────────────────────────
// What it does on a flat plane (MAMMOTH=all CAR=volta npx vitest run tests/probes/mammoth-probe.test.ts prints the table; tests/volta.test.ts
// holds the bounds and measures the grip at speed): 0-100 km/h in 2.42 s with the traction control on, the slicks' limit with the nitro or
// without, 200 in 5.6 s and 330 km/h flat out in eighth with the wings open (303 with them shut); a nitro shot, the 350 kW motor, takes 200 to 4.3 s and the top speed to the cut at 345. It stops from 100 in 18.8 m
// with ABS (2.1 g) and from 200 in 58 m, at up to 4.4 g from 300 km/h, and holds 2.39 g on the skidpad, 2.5 g at 150 km/h, 3.1 at 200 and 3.7 at
// 240 (where the drag of the wings and of the loaded tyres takes all the engine has). In the wet it keeps 64 % of that (54 % in standing water)
// and stops from 100 in 26 m (30). On a lap the AI drivers are 3.9-5.7 % quicker in it than in the LMP-X dry and 5.1-6.3 % in a storm
// (tests/ai.test.ts), and on the studded tyres of Isvik level with it: the engine alone has the LMP-X's power for its weight.

// The Volta's body: 5.3 m long, 1.9 m wide over the tyres, 0.95 m to the top of the airbox, an open cockpit with the driver on the centre line.
const voltaVisual: CarVisualSpec = {
  style: 'formula',
  length: 5.3,
  width: 1.9,
  height: 0.95,
  wheelbase: 3.4,
  trackFront: 1.56,
  trackRear: 1.5,
  frontOverhang: 1.05,
  wheelRadiusFront: 0.352,
  wheelRadiusRear: 0.356,
  tireWidthFront: 0.28,
  tireWidthRear: 0.375,
  rimRadiusFront: 0.2286,
  rimRadiusRear: 0.2286,
  rideHeight: 0.05,
  cgHeight: 0.28,
  cgToFrontAxle: 1.87,
  wing: 1,
  engine: 'mid',
  exhaust: { count: 1, side: 'center' },
  // (the driver lies back: the seat reference is at the hips, 37 cm ahead of the eye, which sits 1.45 m behind the front axle)
  seat: { x: 0, y: 0.22, z: 0.62 },
  openCockpit: true,
};

// The Volta's voice: a 1.6 L 90-degree V6 with a flat crank (even firing, three pulses a turn), one turbo, one central tailpipe, and the MGU-K's whine.
const voltaSound: EngineSoundProfile = {
  cylinders: 6, layout: 'v', crankType: 'flat', displacement: 1.6, turbo: true, exhaustOpenness: 1, brightness: 0.95, gearWhine: 0.7, crackle: 0.15,
  exhaustSystem: 'merged',
  // no muffler, and a wastegate that opens wide flat out: the firing harmonics go up to 10 kHz past the turbine, a hard, high rasp
  wastegate: 1,
  // its loudness measured as it is driven (its own revs, on boost), and the lift of its 3000 rpm idle gone by 4500 rpm (not 6600)
  limiterRpm: 12500,
  idleLiftTo: 1.5,
  // no blow-off valve (the wastegate holds the boost on a lift: no 'pssh'), and a seamless-shift gearbox: an upshift is a 20 ms flick in
  // the note, as the physics' shiftTime, not a road car's 70 ms gap. Driven flat out through the physics, at 60 and 144 frames a second,
  // it is under -3 dB for 8 to 16 ms and 5 to 7 dB deep (held as the frames come, 40 to 64 ms and 8 to 10 dB; tests/audio-volta.test.ts)
  blowOff: false,
  shiftDip: 0.02,
  // the MGU-K's whine on the 14th order of the crank (2.6 kHz at 11,000 rpm): 12 to 23 dB over the rest of the engine in its band while a
  // nitro shot deploys it, 14 to 18 dB under that while it harvests on a lift (tests/audio-volta.test.ts)
  electric: 1,
  // and only as much of it as the motor's power at the road speed, as the physics' `electric` below: all of it to 290 km/h, 5 dB under that
  // at 320 and 11 dB at 340 (200 and 100 of its 350 kW), and from 345 none, the murmur it has on the throttle without a shot
  electricTaper: { powerKw: 350, fullToKmh: 290, zeroAtKmh: 345 },
};

// The Volta itself: 800 kg with the driver and an average fuel load, 45 % of it on the front axle, on slicks.
const volta: CarDefinition = {
  id: 'volta',
  name: 'Volta',
  maker: 'Xeno Racing',
  description:
    'A 2026-rules single-seater: 800 kg, a 1.6 L turbo V6 and wings that open on the straights. Its 350 kW electric motor wakes only with the nitro — and without it, nothing is missing.',
  class: 'Formula',
  drivetrain: 'RWD',
  // (measured: 0-100 in 2.42 s with the traction control on, 330.0 km/h flat out with the wings open; the curve gives 564.5 hp at 12,000 rpm and
  // 380 Nm from 8000 to 10,500, the engine alone: the electric motor is the nitro)
  stats: { powerHp: 565, torqueNm: 380, massKg: 800, topSpeedKmh: 330, zeroTo100: 2.4 },
  visual: voltaVisual,
  sound: voltaSound,
  defaultLivery: { primary: '#e9edf2', secondary: '#1f6bff', accent: '#d7ff1e', pattern: 'stripes', number: 26, driver: 'You', finish: 0.5, metallic: false },
  physics: {
    chassis: {
      mass: 800,
      inertia: { x: 1700, y: 1600, z: 240 },
      cgHeight: 0.28,
      wheelbase: 3.4,
      cgToFrontAxle: 1.87,
      trackFront: 1.56,
      trackRear: 1.5,
      maxSteer: 24 * DEG,
      ackermann: 0.15,
      ...hullFromVisual(voltaVisual, 1.87),
    },
    engine: {
      idleRpm: 3000,
      redlineRpm: 12000,
      limiterRpm: 12500,
      // the 2026 engine alone, 421 kW: about 380 Nm from 7000 to 10,500 rpm (300 at 4000), then the same power on to 12,000 (the fuel flow is capped)
      torqueCurve: [
        [0, 150], [2000, 215], [3000, 255], [4000, 300], [5000, 335], [6000, 362], [7000, 377], [8000, 380], [10500, 380],
        [11000, 363], [11500, 348], [12000, 335], [12500, 312], [13000, 270],
      ],
      engineBraking: 150,
      inertia: 0.07,
      // (no MGU-H in 2026 to spin the turbo up: a light one with a hint of lag)
      turbo: { baseFraction: 0.9, spoolTime: 0.1, spoolRpm: 4000 },
      // the MGU-K, deployed only as the nitro: 350 kW and 500 Nm at the crank, full to 290 km/h and nothing from 345
      electric: { powerKw: 350, torqueNm: 500, fullToKmh: 290, zeroAtKmh: 345 },
    },
    drivetrain: {
      layout: 'RWD',
      // (12,000 rpm is 99 / 132 / 160 / 189 / 223 / 253 / 289 / 334 km/h)
      gears: [4.51, 3.38, 2.79, 2.37, 2.01, 1.77, 1.55, 1.34],
      reverse: 3.0,
      finalDrive: 3.6,
      efficiency: 0.94,
      // (seamless shifts)
      shiftTime: 0.02,
      upshiftRpm: 11800,
      downshiftRpm: 7000,
      diff: { type: 'lsd', preload: 120, powerLock: 0.45, coastLock: 0.3 },
      frontSplit: 0,
    },
    // (a full pedal asks for 4.0 g, 61 % of it at the front: below about 210 km/h the tyres take less than that and ABS has the last word, above it
    // the brakes are the limit, so a stop from 300 km/h peaks at 4.4 g over a tenth of a second, drag included, where with 4400 / 2900 Nm it reached
    // 5.0; 2026's cars brake at 3.3-3.8 g, and the AI drivers lap no slower for it)
    brakes: { frontTorque: 3350, rearTorque: 2200, handbrakeTorque: 1500, discHeatCapacity: 2600 },
    // corner mode: 3.8 m^2 of downforce area, 43 % of it at the front, and a CdA of 1.0 (the car pulls 3.7 g at 240 km/h); straight mode, the wing
    // flaps open: 22 % less drag and 28 % less downforce (330.0 km/h flat out where corner mode gives 303)
    aero: {
      dragArea: 1.0,
      liftAreaFront: 1.64,
      liftAreaRear: 2.16,
      straightMode: { dragArea: 0.78, liftAreaFront: 1.18, liftAreaRear: 1.56 },
    },
    tireFront: {
      ...roadTire(280, 45, 18, 1.75),
      radius: voltaVisual.wheelRadiusFront,
      inertia: 1.2,
      // (a racing slick's friction falls less with its load than a road tyre's: 1.07 times mu on the 2 kN a wheel carries at rest, 0.93 on the
      // 7 kN of a fast corner, where at 0.2 it was 1.11 and 0.89, so the car keeps more of the downforce it is given. Under about 0.1 the launch
      // control's clutch, sized to 1.15 times mu, takes more than the slicks hold at rest, and the traction control cuts in bursts off the line.
      // Still more than the studded winter tyre's 0.06: tests/winter-handling.test.ts)
      loadSensitivity: 0.12,
      nominalLoad: 4500,
      peakSlipAngle: 5.2 * DEG,
      peakSlipRatio: 0.085,
      slideRatio: 0.72,
      relaxationLength: 0.3,
      optimalTemp: 90,
      tempWindow: 45,
      coldGrip: 0.74,
      // (a soft racing compound turns more of its work into heat than a road tyre of its size, the narrow front the more: a dry AI lap runs the
      // fronts at 76-98 C and the rears at 81-92, about the optimum, where at 1.15 and 1.5 they ran at 60-78 and 67-78 and gave up a tenth of their
      // grip to the cold)
      heatScale: 0.75,
      // (wet-weather compound fitted when it rains)
      wetGrip: 0.6,
      slick: 1,
    },
    tireRear: {
      ...roadTire(375, 35, 18, 1.75),
      radius: voltaVisual.wheelRadiusRear,
      inertia: 1.35,
      loadSensitivity: 0.12,
      nominalLoad: 4500,
      peakSlipAngle: 5.2 * DEG,
      peakSlipRatio: 0.085,
      slideRatio: 0.72,
      relaxationLength: 0.3,
      optimalTemp: 90,
      tempWindow: 45,
      coldGrip: 0.74,
      heatScale: 1.0,
      wetGrip: 0.6,
      slick: 1,
    },
    // (6 cm of travel at 5 cm off the ground: with 5 cm at 4 cm the floor struck the road in Brennwald's compression at 308 km/h.) Bars of 60 and
    // 70 kN/m put 48 % of the roll stiffness at the front, on 45 % of the weight: with 54 % (90 and 50 kN/m) the fronts gave up first and the car
    // held 2.31 g on the skidpad, now 2.40
    suspFront: { travel: 0.06, spring: 250000, bump: 5000, rebound: 8500, antiRoll: 60000, camber: -3 * DEG },
    suspRear: { travel: 0.06, spring: 300000, bump: 5500, rebound: 9500, antiRoll: 70000, camber: -1.8 * DEG },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Dieci — a 2004-style single-seater. A 3.0 L V10 screaming to 19,300 rpm, fixed wings, grooved tyres, and nothing electric.
// ─────────────────────────────────────────────────────────────────────────────
// What it does on a flat plane (tests/physics.test.ts, .cache/physics-metrics.txt; tests/dieci.test.ts holds the bounds and measures the grip
// at speed): 0-100 km/h in 2.63 s with the traction control on, 200 in 4.67 s, 300 in 9.4 s and 332 km/h flat out in seventh; from a grid start,
// the engine already held at 10,000 rpm against the clutch, 2.48 and 4.50 s. A nitro shot, the ordinary bottle, takes 200 to 3.65 s and the top
// speed to seventh's limiter at 345. It stops from 100 in 18.3 m with ABS and from 200 in 55 m, at 4.7 g from 300 km/h, and holds 2.64 g on
// the skidpad, 2.7 g at 150 km/h, 3.4 at 200 and 4.3 at 250. In the wet it keeps 66 % of that (56 % in standing water) and stops from 100 in
// 24 m (27). On a lap the AI drivers are 5.8 % quicker in it than in the Volta on the four road circuits, dry, and 5.6 % in a storm (7-8 % on
// the fast Aurelia and Brennwald, 3.5-4 % on the tight Kuroyama), and 1-3 % on the studded tyres of Isvik (tests/ai.test.ts).
// It leaves the line at 10,000 rpm, its launchRpm: 0.17 s slower to 100 on the flat than at the 4900 a road car is held at (car-metrics'
// dragRun), since the engine first revs past 8700 before the clutch bites and the clutch then slips up to 54 km/h, not 26, at what the tyres
// take at rest.

// The Dieci's body: 4.55 m long, 1.8 m wide over the tyres, 0.95 m to the top of the airbox, an open cockpit with the driver on the centre
// line. formulaEra 2004 draws it with a body of its own (src/carvis/bodies/formula04.ts: the high nose, the periscopes, the beam wing) on
// 13-inch grooved wheels, and its flames come out of the periscopes (src/render/effects.ts).
const dieciVisual: CarVisualSpec = {
  style: 'formula',
  formulaEra: 2004,
  length: 4.55,
  width: 1.8,
  height: 0.95,
  wheelbase: 3.1,
  trackFront: 1.46,
  trackRear: 1.41,
  frontOverhang: 0.97,
  // (13-inch rims in 660 mm tyres)
  wheelRadiusFront: 0.33,
  wheelRadiusRear: 0.33,
  tireWidthFront: 0.325,
  tireWidthRear: 0.375,
  rimRadiusFront: 0.1651,
  rimRadiusRear: 0.1651,
  rideHeight: 0.05,
  cgHeight: 0.275,
  cgToFrontAxle: 1.674,
  wing: 1,
  engine: 'mid',
  exhaust: { count: 2, side: 'periscope' },
  // (the hips 1.05 m behind the front axle: the eye 1.42 m behind it and 73 cm up, as the build sheet has it, formulaCockpit)
  seat: { x: 0, y: 0.22, z: 0.5 },
  openCockpit: true,
};

// The Dieci's voice: a 3.0 L V10 with a flat crank (even firing, five pulses a turn) to 19,300 rpm, no turbo, and two short open
// periscopes whose ends reflect little, so that its scream rises to the limiter in every gear (tests/audio-dieci.test.ts).
const dieciSound: EngineSoundProfile = {
  cylinders: 10, layout: 'v', crankType: 'flat', displacement: 3.0, turbo: false, exhaustOpenness: 1, brightness: 0.95, gearWhine: 0.75, crackle: 0.35,
  exhaustSystem: 'short',
  // its loudness measured over its own revs, and the lift of its 4000 rpm idle gone by 5600 rpm (not 8800)
  limiterRpm: 19300,
  idleLiftTo: 1.4,
  // an upshift that cuts the ignition: through the physics' 30 ms shift the note is 3 dB and more down for 28 to 32 ms, 9 to 12 dB at its
  // deepest (not seamless: the Volta's is a flick of 8 to 16 ms; a road car's gearbox leaves a gap of 70 ms). The 1-2 is longer wherever the
  // traction control is working, from the grid or flat out in 1st: it clamps the throttle to about a tenth of the pedal for some 50 ms just
  // after the shift and holds it under half for 150, so from rest the note is 3 dB down for 84 ms of the shift's first 150 at 60 frames a
  // second (tests/audio-dieci.test.ts, ARCHITECTURE.md)
  shiftDip: 0.04,
  // its traction control and its launch control cut the spark, not the throttle: in 1st gear flat out from rest it stutters 3 dB and more
  // louder than the same torque heard as a lighter load (tests/audio-dieci.test.ts)
  ignitionCut: true,
};

// The Dieci itself: 640 kg with the driver and an average fuel load (the 600 kg rule and 40 kg of fuel), 46 % of it on the front axle.
const dieci: CarDefinition = {
  id: 'dieci',
  name: 'Dieci',
  maker: 'Xeno Racing',
  description:
    'A 2004-style single-seater: 640 kg, a 3.0 L V10 screaming to 19,300 rpm, grooved tyres on 13-inch rims, and nothing electric. The quickest car here, and an octave above the rest.',
  class: 'Formula',
  drivetrain: 'RWD',
  // (measured: 0-100 in 2.63 s with the traction control on, 332.4 km/h flat out; the curve gives 911.9 hp at 18,500 rpm and 375 Nm at 16,500)
  stats: { powerHp: 912, torqueNm: 375, massKg: 640, topSpeedKmh: 332, zeroTo100: 2.6 },
  visual: dieciVisual,
  sound: dieciSound,
  // (the big blocks of colour of the time's liveries, without their sponsors: shards of charcoal and white over burnt orange on the nose,
  // the sidepods, the engine cover and the endplates; the opponents' orange car is split in black, so a field of Diecis tells them apart)
  defaultLivery: { primary: '#e2541b', secondary: '#23262b', accent: '#f4f4f2', pattern: 'shards', number: 19, driver: 'You', finish: 0, metallic: false },
  physics: {
    chassis: {
      mass: 640,
      inertia: { x: 1100, y: 1050, z: 170 },
      cgHeight: 0.275,
      wheelbase: 3.1,
      cgToFrontAxle: 1.674,
      trackFront: 1.46,
      trackRear: 1.41,
      maxSteer: 24 * DEG,
      ackermann: 0.15,
      ...hullFromVisual(dieciVisual, 1.674),
    },
    engine: {
      idleRpm: 4000,
      redlineRpm: 19000,
      limiterRpm: 19300,
      // the 2004 V10: 375 Nm at 16,500 rpm and 680 kW at 18,500, a flat top (674 kW at 17,500, 672.5 at 19,000)
      torqueCurve: [
        [0, 50], [4000, 110], [6000, 175], [8000, 235], [10000, 288], [12000, 325], [14000, 355], [15500, 370], [16500, 375],
        [17500, 368], [18500, 351], [19000, 338], [19300, 330], [20000, 295],
      ],
      // (52 Nm at 18,000 rpm with the throttle shut, about half what a bare V10 drags, 95, as the engine-braking maps of the period left it.
      // With 110, a bare V10's, the engine held the rears locked in a stop on a wet road with the wheel turned once ABS had let their brakes
      // go, and in standing water the car spun in two of eight such stops from 250 and 180 km/h with the AI's aids; with 50 in none)
      engineBraking: 50,
      // (a throttle map: in this model a part throttle also loses what the engine drags, and with 50 Nm and no map 35 % of the pedal gave 26 %
      // of the torque at 17,000 rpm, which in first gear on snow spun the rears at once: the power slide of tests/winter-handling.test.ts went
      // from 10 to 30 degrees of body slip in 0.17 s. With the map it gives 16 %, and the slide takes 0.37 s)
      throttleGamma: 1.3,
      inertia: 0.05,
      turbo: null,
      // the launch control holds it at 10,000 rpm off the line (on a winter circuit at 4900, as a road car)
      launchRpm: 10000,
    },
    drivetrain: {
      layout: 'RWD',
      // (19,000 rpm is 116 / 153 / 182 / 216 / 253 / 295 / 344 km/h: a long second, so that a car on the limit of a 60 m bend at 145 km/h holds
      // its gear; with a second to 148 the shift jolted it there, which the skidpad read as 0.09 g more grip than the car holds)
      gears: [5.09, 3.85, 3.25, 2.73, 2.34, 2.0, 1.72],
      reverse: 3.0,
      finalDrive: 4.0,
      efficiency: 0.94,
      // (an ignition cut, not a seamless shift)
      shiftTime: 0.03,
      upshiftRpm: 19000,
      downshiftRpm: 12500,
      diff: { type: 'lsd', preload: 120, powerLock: 0.45, coastLock: 0.3 },
      frontSplit: 0,
    },
    // (a full pedal asks for 4.2 g, 60 % of it at the front: above about 195 km/h the brakes are the limit, below it the tyres and ABS, so a
    // stop from 300 km/h peaks at 4.7 g over a tenth of a second, drag included, as the period's carbon brakes did (4.57 with 2500 / 1700 Nm:
    // tests/dieci.test.ts's stopFrom, after a second flat out in 7th), and passes 200 at 4.2 g)
    brakes: { frontTorque: 2600, rearTorque: 1750, handbrakeTorque: 1500, discHeatCapacity: 2400 },
    // fixed wings of medium downforce: 3.95 m^2 of downforce area, 44 % of it at the front, and a CdA of 1.25. (The period's estimates, 4.1 and
    // 1.30, were worked out in air of 1.18 kg/m^3; in this air, 1.225, these give the same forces.)
    aero: { dragArea: 1.25, liftAreaFront: 1.738, liftAreaRear: 2.212 },
    // grooved dry tyres: four grooves cost the contact patch some grip, and the more the harder it is pressed (1.87 on the 1.4 kN a front wheel
    // carries at rest, as the Volta's slick on its 1.8 kN, but 1.47 on the 7 kN of a fast corner, nine tenths of the slick's 1.63), and leave no
    // tread for grass, dirt or gravel, so they take the slick's table of surfaces
    tireFront: {
      ...roadTire(325, 51, 13, 1.65),
      radius: dieciVisual.wheelRadiusFront,
      inertia: 1.0,
      loadSensitivity: 0.2,
      nominalLoad: 4500,
      peakSlipAngle: 6.5 * DEG,
      peakSlipRatio: 0.09,
      slideRatio: 0.74,
      relaxationLength: 0.4,
      optimalTemp: 90,
      tempWindow: 45,
      coldGrip: 0.74,
      heatScale: 0.9,
      // (wet-weather compound fitted when it rains)
      wetGrip: 0.64,
      slick: 1,
    },
    tireRear: {
      ...roadTire(375, 44, 13, 1.65),
      radius: dieciVisual.wheelRadiusRear,
      inertia: 1.15,
      loadSensitivity: 0.2,
      nominalLoad: 4500,
      peakSlipAngle: 6.5 * DEG,
      peakSlipRatio: 0.09,
      slideRatio: 0.74,
      relaxationLength: 0.4,
      optimalTemp: 90,
      tempWindow: 45,
      coldGrip: 0.74,
      heatScale: 1.3,
      wetGrip: 0.64,
      slick: 1,
    },
    suspFront: { travel: 0.06, spring: 250000, bump: 4500, rebound: 7500, antiRoll: 60000, camber: -3 * DEG },
    suspRear: { travel: 0.06, spring: 300000, bump: 5000, rebound: 8700, antiRoll: 70000, camber: -1.8 * DEG },
  },
};

// (the newest cars last, the Mammoth, the Volta and then the Dieci: tests take CARS[3] for the LMP-X)
export const CARS: CarDefinition[] = [vanta, kestrel, ronin, lmp, mammoth, volta, dieci];

export function getCar(id: string): CarDefinition {
  const c = CARS.find((c) => c.id === id);
  if (!c) throw new Error(`Unknown car '${id}'`);
  return c;
}
