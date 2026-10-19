/**
 * Where each car's mirror glass is and which way it faces (body frame: +Z forward, +Y up, +X left, the driver on the
 * left). Pure numbers, worker-safe: the bodies build the door-mirror housings from it, the main thread puts the live
 * glass on the same spots (mirrors.ts), and the tests check what the driver can see.
 *
 * A mirror's glass is turned the way a driver would set it: its normal bisects the way to the eye and the direction it
 * should look (back, a little outward for a door mirror so a sliver of the flank shows, a little downward so the road
 * is in it). Sizes are real: a door mirror is about 16 x 10 cm and convex, a rear-view mirror about 22 x 7 cm and flat.
 * The cabins here are compact, so the rear-view mirror hangs lower and nearer the driver's side than the roof header it
 * would sit on in a larger car (about 22 degrees to the right of the driver's line of sight, clear of the timing panel
 * of the HUD at 16:9); it still reads as a mirror on a short stalk from the windscreen.
 */
import type { BodyStyle, CarVisualSpec } from '../core/contracts';
import { eyePoint } from './layouts';

export type V3 = [number, number, number];

export interface MirrorPose {
  /** Glass centre. */
  pos: V3;
  /** Unit axes of the glass: it faces `normal` (toward the driver), `right` x `up` = `normal`. */
  right: V3;
  up: V3;
  normal: V3;
  halfW: number;
  halfH: number;
  /** 1 = flat; > 1 widens what the glass shows (convex door mirrors): across the glass and up it. */
  convex: number;
  convexY: number;
}

export interface MirrorLayout {
  /** Door mirrors: glass poses by side (the left one is on the driver's side, +X). */
  left: MirrorPose;
  right: MirrorPose;
  /** Door-mirror housing: how far it reaches forward of the glass (m) and which part it is made of (carbon, textured black plastic, or the body's paint). */
  housing: { depth: number; carbon: boolean; black?: boolean };
  /** The rear-view mirror in the cabin; null for the prototype, which has a screen instead. */
  interior: MirrorPose | null;
  /** The prototype's dash display for the rear camera; null for road cars. */
  screen: MirrorPose | null;
  /** The rear camera: position in the body frame, looking out of the tail, tipped down by `pitchDown` rad. */
  rear: { pos: V3; pitchDown: number };
}

const DEG = Math.PI / 180;
/** How much wider than its glass a mirror sees: door mirrors are convex, the interior mirror a wide-angle one (the cabins are compact). */
const DOOR_CONVEX = 1.8;
const DOOR_CONVEX_Y = 1.45;
const INSIDE_CONVEX = 1.45;
const INSIDE_CONVEX_Y = 1.2;

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function norm(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * A glass at `pos` set for a driver whose eye is at `eye`, so that the centre of the glass shows the direction `look`
 * (unit, pointing away from the glass into the scene). Up is the world's up tipped into the glass plane.
 */
export function setMirror(pos: V3, eye: V3, look: V3, halfW: number, halfH: number, convex: number, convexY = convex): MirrorPose {
  const toEye = norm(sub(eye, pos));
  const normal = norm([toEye[0] + look[0], toEye[1] + look[1], toEye[2] + look[2]]);
  const d = normal[1];
  const up = norm([-d * normal[0], 1 - d * normal[1], -d * normal[2]]);
  const right = cross(up, normal);
  return { pos, right, up, normal, halfW, halfH, convex, convexY };
}

interface Style {
  /** Left door mirror glass centre and half sizes. */
  door: { pos: V3; hw: number; hh: number; out: number };
  housing: { depth: number; carbon: boolean; black?: boolean };
  /** Rear-view mirror centre and half sizes (null: none). */
  inside: { pos: V3; hw: number; hh: number } | null;
  /** Dash display centre and half sizes (null: none). */
  screen: { pos: V3; hw: number; hh: number } | null;
  /** Rear camera above the tail: height and distance forward of the tail. */
  rear: { y: number; fromTail: number; pitch: number };
}

function styleFor(style: BodyStyle, spec: CarVisualSpec): Style {
  const hk = spec.height / 1.05;
  switch (style) {
    case 'gt':
      return {
        door: { pos: [0.94, 0.99, 0.24], hw: 0.07, hh: 0.045, out: 12 },
        housing: { depth: 0.1, carbon: true },
        inside: { pos: [0.22, 1.13, 0.1], hw: 0.072, hh: 0.028 },
        screen: null,
        rear: { y: 1.0, fromTail: 0.1, pitch: 1.5 },
      };
    case 'hatch':
      return {
        door: { pos: [0.905, 1.07, 0.335], hw: 0.066, hh: 0.045, out: 12 },
        housing: { depth: 0.095, carbon: false },
        inside: { pos: [0.24, 1.27, 0.24], hw: 0.072, hh: 0.028 },
        screen: null,
        rear: { y: 1.33, fromTail: 0.14, pitch: 2 },
      };
    case 'coupe':
      return {
        door: { pos: [0.925, 0.995, 0.24], hw: 0.064, hh: 0.043, out: 12 },
        housing: { depth: 0.092, carbon: false },
        inside: { pos: [0.19, 1.13, 0.12], hw: 0.072, hh: 0.028 },
        screen: null,
        rear: { y: 1.02, fromTail: 0.12, pitch: 1.5 },
      };
    case 'suv':
      // big truck mirrors on arms at the foot of the A-pillars: far enough back that the driver sees the left one through the door
      // window (the line from the eye crosses the cabin wall 5 cm inside the window's front edge, not behind the pillar) and inside
      // the cockpit view; a wide interior mirror hung from the header, a rear camera over the roof edge
      return {
        door: { pos: [1.06, 1.45, 0.66], hw: 0.092, hh: 0.064, out: 11 },
        housing: { depth: 0.12, carbon: false, black: true },
        inside: { pos: [0.15, 1.7, 0.44], hw: 0.088, hh: 0.03 },
        screen: null,
        rear: { y: 1.97, fromTail: 0.45, pitch: 3 },
      };
    default:
      return {
        door: { pos: [0.745, 0.97 * hk, 0.66], hw: 0.058, hh: 0.04, out: 10 },
        housing: { depth: 0.085, carbon: true },
        inside: null,
        screen: { pos: [0.1, 0.8, 0.62], hw: 0.075, hh: 0.03 },
        rear: { y: 1.12 * hk, fromTail: 2.05, pitch: 3 },
      };
  }
}

export function mirrorLayout(spec: CarVisualSpec): MirrorLayout {
  const s = styleFor(spec.style, spec);
  const eye = eyePoint(spec);
  const zTail = -(spec.wheelbase / 2 + (spec.length - spec.wheelbase - spec.frontOverhang));

  // a door mirror looks back and a little away from the car, and a little down
  const b = s.door.out * DEG;
  const lookL: V3 = norm([Math.sin(b), -0.04, -Math.cos(b)]);
  const lookR: V3 = norm([-Math.sin(b), -0.04, -Math.cos(b)]);
  const dp = s.door.pos;
  const left = setMirror(dp, eye, lookL, s.door.hw, s.door.hh, DOOR_CONVEX, DOOR_CONVEX_Y);
  const right = setMirror([-dp[0], dp[1], dp[2]], eye, lookR, s.door.hw, s.door.hh, DOOR_CONVEX, DOOR_CONVEX_Y);

  let interior: MirrorPose | null = null;
  if (s.inside) interior = setMirror(s.inside.pos, eye, norm([0, -0.02, -1]), s.inside.hw, s.inside.hh, INSIDE_CONVEX, INSIDE_CONVEX_Y);

  // a display is not set like a mirror: it simply faces the driver
  const screen: MirrorPose | null = s.screen ? facing(s.screen.pos, eye, s.screen.hw, s.screen.hh) : null;

  return {
    left,
    right,
    housing: s.housing,
    interior,
    screen,
    rear: { pos: [0, s.rear.y, zTail + s.rear.fromTail], pitchDown: s.rear.pitch * DEG },
  };
}

/** A flat panel at `pos` turned to face the eye, upright (a display, not a mirror). */
export function facing(pos: V3, eye: V3, halfW: number, halfH: number): MirrorPose {
  const normal = norm(sub(eye, pos));
  const d = normal[1];
  const up = norm([-d * normal[0], 1 - d * normal[1], -d * normal[2]]);
  const right = cross(up, normal);
  return { pos, right, up, normal, halfW, halfH, convex: 1, convexY: 1 };
}

/** Glass outline in the glass plane: a rounded rectangle (superellipse, exponent `p`), `n` points counter-clockwise from +x. */
export function glassOutline(halfW: number, halfH: number, n = 28, p = 3.4): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const x = Math.sign(c) * Math.pow(Math.abs(c), 2 / p) * halfW;
    const y = Math.sign(s) * Math.pow(Math.abs(s), 2 / p) * halfH;
    out.push([x, y]);
  }
  return out;
}
