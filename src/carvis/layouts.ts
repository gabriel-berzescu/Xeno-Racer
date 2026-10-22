/**
 * Main-thread layout numbers per body style: anchors, livery placement, lamp positions.
 * Derived from CarVisualSpec so they follow dimension changes; style-specific constants live here.
 */
import type { CarVisualSpec } from '../core/contracts';
import type { LiveryLayout } from './livery';

export type V3 = [number, number, number];

export interface CarLayout {
  zNose: number;
  zTail: number;
  /** driver's eye point (body frame) */
  eye: V3;
  hood: V3;
  bumper: V3;
  chase: V3;
  /** headlight positions for spotlights (x>0 = left) */
  headlight: V3;
  /** taillight glow centre */
  taillight: V3;
  /** rest wheel centres FL FR RL RR */
  wheels: [V3, V3, V3, V3];
  /** steering wheel centre + column direction */
  steerWheel: V3;
  steerTilt: number;
  livery: LiveryLayout;
}

/** Driver's eye point (body frame). Shared by the cockpit anchor and the interior builder. */
export function eyePoint(s: CarVisualSpec): V3 {
  const proto = s.style === 'prototype';
  // (the single-seater lies its driver back, the hips well ahead of the head: the eye is 55 cm over the seat reference and 37 cm behind
  // it, 10 cm under the halo's hoop)
  if (s.style === 'formula') return [s.seat.x, s.seat.y + 0.55, s.seat.z - 0.37];
  // (a 4x4 sits its driver bolt upright and high: the eye is 68 cm above the seat reference)
  const eyeRise = proto ? 0.56 : s.style === 'hatch' ? 0.66 : s.style === 'suv' ? 0.68 : 0.62;
  return [s.seat.x, s.seat.y + eyeRise, s.seat.z + (proto ? 0.05 : 0.1)];
}

/**
 * Where the single-seater ('formula') carries its lights and its tailpipe (body frame, +x the left), for its body (bodies/formula.ts),
 * its headlamp spots and the lamps the damage model knows:
 *   - noseLed: the left of the two LED headlamps, in the face of the step of its two-stage nose (the right one is mirrored);
 *   - beam: where the left lamp's beam starts, at the tip of the nose, 40 cm ahead of the lamp and as high (the spots cast no shadow:
 *     from the lamp itself they lit the top of the nose's lower stage, right in front of them, as bright as the road);
 *   - rainLight: the centre of the rain light on the tip of the crash structure (300 mm up, as the rules have it);
 *   - wingLed: the centre of the left rear-wing endplate's LED strip, on its trailing edge;
 *   - exhaust: the end of the one tailpipe, over the crash structure and under the rear wing (src/render/effects.ts buildTips blows
 *     the flames there: keep the two the same).
 */
export function formulaPoints(s: CarVisualSpec): { noseLed: V3; beam: V3; rainLight: V3; wingLed: V3; exhaust: V3 } {
  const zF = s.wheelbase / 2;
  const zR = -s.wheelbase / 2;
  const zTail = -(s.wheelbase / 2 + (s.length - s.wheelbase - s.frontOverhang));
  const hk = s.height / 0.95;
  return {
    noseLed: [0.072, 0.405 * hk, zF + 0.6],
    beam: [0.072, 0.405 * hk, zF + s.frontOverhang + 0.02],
    rainLight: [0, 0.31 * hk, zTail - 0.006],
    wingLed: [0.522, 0.785 * hk, zTail - 0.1],
    exhaust: [0, s.rideHeight + 0.41, zR - 0.5],
  };
}

export function computeLayout(s: CarVisualSpec): CarLayout {
  const zF = s.wheelbase / 2;
  const zR = -s.wheelbase / 2;
  const zNose = zF + s.frontOverhang;
  const zTail = -(s.wheelbase / 2 + (s.length - s.wheelbase - s.frontOverhang));
  const hw = s.width / 2;
  const proto = s.style === 'prototype';
  const eye = eyePoint(s);
  const roofY = s.height;
  const style = s.style;
  const suv = style === 'suv';
  // (the 4x4's hood is 1.32 m up and its power dome 1.37: the hood camera rides 8 cm over this, and the headlamp spots sit at the lamps' 1.12 m)
  const hoodY = style === 'prototype' ? 0.62 : style === 'gt' ? 0.9 : style === 'coupe' ? 0.88 : suv ? 1.4 : 0.97;
  const lay: LiveryLayout = {
    zNose: zNose + 0.06,
    zTail: zTail - 0.06,
    yMax: Math.max(1.5, s.height + 0.15),
    halfW: hw + 0.06,
    // (the roundel rides the front door of the 4x4: its panel is a metre taller than a coupe's)
    door: suv ? { z: 0.16, y: 1.0, r: 0.2 } : { z: style === 'prototype' ? 0.2 : (zF + zR) * 0.5 - 0.1, y: style === 'prototype' ? 0.5 : 0.6, r: style === 'prototype' ? 0.17 : 0.2 },
    // (the 4x4's hood number rides the front of the power dome, clear of the hood camera that sits 1.2 m behind the nose)
    hood: { z: style === 'coupe' ? zNose - 1.25 : suv ? zNose - 0.385 : zNose - 0.9, r: suv ? 0.17 : 0.2 },
    belt: style === 'hatch' ? 0.98 : suv ? 1.22 : 0.93,
  };
  // the livery patterns are drawn for a car 1.3 m tall: a 4x4's flank is lifted onto its own body panels (see livery.ts)
  // (and the chevrons and hoops hang from the middle of the wheelbase as on the other cars, not from the roundel on the front door)
  if (suv) {
    lay.rise = { scale: 1.12, shift: 0.2 };
    lay.patternZ = (zF + zR) * 0.5 - 0.1;
    // (the arrow's tip stops at the grille, not over the nose: the number plate sits on the dome ahead of the hood camera)
    lay.hoodArrow = zNose - 0.92;
    lay.dust = { amount: 1, wheelZ: [zF, zR] };
    lay.trueRound = true;
  }
  const layout: CarLayout = {
    zNose,
    zTail,
    eye,
    hood: [0, hoodY + 0.08, zNose - (suv ? 1.2 : 1.0)],
    bumper: [0, suv ? 0.62 : 0.38, zNose + 0.02],
    chase: [0, roofY, (zF + zR) * 0.5 - 0.2],
    headlight: [hw - 0.28, hoodY - 0.28, zNose - 0.28],
    taillight: [0, suv ? 1.1 : 0.8, zTail + 0.05],
    wheels: [
      [s.trackFront / 2, s.wheelRadiusFront, zF],
      [-s.trackFront / 2, s.wheelRadiusFront, zF],
      [s.trackRear / 2, s.wheelRadiusRear, zR],
      [-s.trackRear / 2, s.wheelRadiusRear, zR],
    ],
    steerWheel: [s.seat.x, s.seat.y + 0.3, s.seat.z + 0.68],
    steerTilt: 0.38,
    livery: lay,
  };
  if (style === 'formula') {
    // the single-seater: the roundel on the sidepod's flank, the number on the nose behind its step, a split at its sidepods' height;
    // the hood camera is the T-camera over the airbox, the bumper camera a nose camera 10 cm over the nose's lower stage, the headlamp spots are
    // its two LED lamps in the nose, starting at the nose's tip (formulaPoints)
    const p = formulaPoints(s);
    lay.door = { z: eye[2] - 0.6, y: 0.37 * (s.height / 0.95), r: 0.11 };
    lay.hood = { z: zF + 0.3, r: 0.072 };
    lay.belt = 0.5;
    lay.trueRound = true;
    layout.hood = [0, s.height + 0.08, eye[2] - 0.5];
    layout.bumper = [0, 0.4 * (s.height / 0.95), zNose - 0.22];
    layout.headlight = [p.beam[0], p.beam[1], p.beam[2]];
    layout.taillight = [p.rainLight[0], p.rainLight[1], p.rainLight[2]];
  }
  return layout;
}

export interface WheelLook {
  rimColor: [number, number, number];
  rimMetal: number;
  rimRough: number;
  rimCC: number;
  nutColor: [number, number, number];
  caliper: [number, number, number];
  slick: number;
  tread: number;
}

/** Linear-space colours. */
export function wheelLook(style: CarVisualSpec['style']): WheelLook {
  switch (style) {
    case 'gt':
      return { rimColor: [0.085, 0.09, 0.1], rimMetal: 1, rimRough: 0.3, rimCC: 0.5, nutColor: [0.75, 0.75, 0.78], caliper: [0.85, 0.5, 0.02], slick: 0, tread: 1 };
    case 'hatch':
      return { rimColor: [0.012, 0.012, 0.014], rimMetal: 0.6, rimRough: 0.3, rimCC: 0.9, nutColor: [0.7, 0.7, 0.72], caliper: [0.62, 0.015, 0.02], slick: 0, tread: 1 };
    case 'coupe':
      return { rimColor: [0.62, 0.36, 0.12], rimMetal: 1, rimRough: 0.26, rimCC: 0.3, nutColor: [0.8, 0.8, 0.82], caliper: [0.6, 0.02, 0.02], slick: 0, tread: 1 };
    case 'suv':
      // satin-black beadlock wheels with raw steel bolts, orange calipers behind them, a treaded all-terrain tyre
      return { rimColor: [0.016, 0.016, 0.018], rimMetal: 0.85, rimRough: 0.36, rimCC: 0.15, nutColor: [0.62, 0.63, 0.66], caliper: [0.95, 0.2, 0.0], slick: 0, tread: 1 };
    case 'formula':
      // black magnesium rims behind carbon closing panels, a red centre-lock nut, a slick (its sidewall lettering in the compound's yellow: car.ts)
      return { rimColor: [0.014, 0.014, 0.016], rimMetal: 0.6, rimRough: 0.38, rimCC: 0.3, nutColor: [0.7, 0.04, 0.03], caliper: [0.05, 0.05, 0.05], slick: 1, tread: 0 };
    default:
      return { rimColor: [0.018, 0.018, 0.02], rimMetal: 0.85, rimRough: 0.42, rimCC: 0, nutColor: [0.05, 0.6, 0.5], caliper: [0.05, 0.05, 0.05], slick: 1, tread: 0 };
  }
}
