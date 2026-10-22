/**
 * Cabin interior: seats, dash, console, door cards, driver (helmet, torso, limbs) sculpted as SDFs
 * and polygonized like the body, plus a steering wheel built from the PartBuilder.
 * Pure numeric / worker-safe.
 */
import type { BodyStyle, CarVisualSpec, QualityLevel } from '../core/contracts';
import { ZONE_STRIDE } from './blueprint';
import { VERTEX_STRIDE, type PartData, partToData } from './build-shared';
import { eyePoint } from './layouts';
import { PartBuilder, type V3 } from './parts';
import { polygonize } from './polygonize';
import { sdCapsule, sdEllipsoid, sdRoundBox, smin, type FieldFn } from './sdf';
import { roundPoly } from './shapes';

/** Interior part ids (zone z3.y). */
export const IPART = {
  seat: 40,
  seatAccent: 41,
  dash: 42,
  console: 43,
  doorCard: 44,
  floor: 45,
  helmet: 46,
  visor: 47,
  suit: 48,
  glove: 49,
  belt: 50,
  wheelRim: 51,
  wheelSpoke: 52,
  screen: 53,
  cage: 54,
  carbon: 1,
  metal: 3,
  shoe: 55,
  wheelScreen: 56,
  /** the single-seater's yoke: its live display (gear, speed, revs) and the row of shift lights over it (interiorMaterial.ts) */
  wheelDisplay: 57,
  shiftLights: 58,
} as const;

/**
 * The single-seater's yoke, in the wheel's own frame (+x the driver's right, +y up the wheel, the driver looking at its +z face): the
 * display's centre and half sizes, the shift lights' row (the first light's x, the step between lights, their count and height) and
 * where the grips are across. The interior material draws the display and lights from the same numbers (YOKE_GLSL).
 */
export const YOKE = {
  display: { x: 0, y: 0.016, hw: 0.05, hh: 0.031 },
  lights: { x0: -0.07, step: 0.01, n: 15, y: 0.06 },
  gripX: 0.124,
} as const;

export interface InteriorData {
  cabin: PartData;
  driver: PartData;
  /** coarse driver for AI cars */
  driverLite: PartData;
  wheel: PartData;
  /** steering wheel pivot + normal (body frame) */
  wheelPos: V3;
  wheelNormal: V3;
  /** head centre for cockpit-view hiding etc. */
  head: V3;
  /** instrument-cluster screen centre (body frame); the cluster face looks towards -Z */
  screen: V3;
}

interface IStyle {
  twoSeats: boolean;
  rearBench: boolean;
  cage: boolean;
  doorCards: boolean;
  bucket: boolean;
  seatTilt: number; // backrest tilt rad
  /** windscreen base (z) and dash-top height there */
  cowlZ: number;
  cowlY: number;
  floorY: number;
  /** where the steering wheel stands relative to the seat reference (up, forward), and how far it is tipped back from vertical */
  wheelUp: number;
  wheelFwd: number;
  wheelTilt: number;
  /** the cluster binnacle's height over the wheel centre */
  binUp: number;
  /** the cabin mesh's box: half width and the height of its top (the headrests and roof lining stop here) */
  halfW: number;
  top: number;
  /** half widths of the floor, the dash pad and the rear bench; the dash pad's half thickness; where the round air vents sit across */
  floorHalfW: number;
  dashHalfW: number;
  dashHy: number;
  benchHalfW: number;
  ventX: number;
  /** door cards: x of the card, centre height, half height, centre behind the cowl, half length, and the |x| beyond which a vertex is a card */
  doorX: number;
  doorY: number;
  doorHy: number;
  doorZ: number;
  doorHz: number;
  doorCut: number;
  /** how far behind the cowl the door cards run (m), and whether there is a second card for a rear door */
  doorBack: number;
  rearDoor: boolean;
}

/** What the older (low, narrow) cabins use for everything the 4x4 raises. */
const LOW_CABIN = {
  wheelUp: 0.3,
  wheelFwd: 0.56,
  wheelTilt: 0.4,
  binUp: 0.2,
  halfW: 0.85,
  top: 1.05,
  floorHalfW: 0.74,
  dashHalfW: 0.74,
  dashHy: 0.12,
  benchHalfW: 0.62,
  ventX: 0.62,
  doorX: 0.735,
  doorY: 0.62,
  doorHy: 0.26,
  doorZ: 0.62,
  doorHz: 0.62,
  doorCut: 0.7,
  doorBack: 1.3,
  rearDoor: false,
};

function styleFor(style: BodyStyle): IStyle {
  switch (style) {
    case 'gt':
      return { twoSeats: true, rearBench: false, cage: false, doorCards: true, bucket: false, seatTilt: 0.3, cowlZ: 0.45, cowlY: 0.88, floorY: 0.27, ...LOW_CABIN };
    case 'hatch':
      return { twoSeats: true, rearBench: true, cage: true, doorCards: true, bucket: true, seatTilt: 0.26, cowlZ: 0.55, cowlY: 0.95, floorY: 0.27, ...LOW_CABIN };
    case 'coupe':
      return { twoSeats: true, rearBench: true, cage: false, doorCards: true, bucket: true, seatTilt: 0.3, cowlZ: 0.5, cowlY: 0.9, floorY: 0.27, ...LOW_CABIN };
    case 'suv':
      // a bench-high cabin: the floor is half a metre off the road, the dash is a wide upright pad under a flat windscreen,
      // the seats are plain (no bolsters) and tilted back only a little, and the door cards run from the sill to the window ledge
      return {
        twoSeats: true,
        rearBench: true,
        cage: false,
        doorCards: true,
        bucket: false,
        seatTilt: 0.3,
        cowlZ: 0.7,
        cowlY: 1.3,
        floorY: 0.5,
        wheelUp: 0.36,
        wheelFwd: 0.5,
        wheelTilt: 0.52,
        binUp: 0.22,
        halfW: 0.9,
        top: 1.62,
        floorHalfW: 0.88,
        dashHalfW: 0.9,
        dashHy: 0.22,
        benchHalfW: 0.82,
        ventX: 0.76,
        doorX: 0.89,
        doorY: 0.93,
        doorHy: 0.4,
        doorZ: 0.535,
        doorHz: 0.47,
        doorCut: 0.86,
        doorBack: 1.95,
        rearDoor: true,
      };
    case 'formula':
      // the single-seater: lying back in a narrow tub, the back 60 degrees from upright (the shoulders under the helmet, below the
      // cockpit's rim), no cage (the roll hoop and the halo are the body's), the yoke over the thighs; the cabin box reaches from behind
      // the headrest to the footwell (cowlZ: the front bulkhead)
      return { twoSeats: false, rearBench: false, cage: false, doorCards: false, bucket: true, seatTilt: 1.05, cowlZ: 1.2, cowlY: 0.6, floorY: 0.08, ...LOW_CABIN, wheelUp: 0.33, wheelFwd: 0.05, wheelTilt: 0.4, halfW: 0.24, top: 0.82, floorHalfW: 0.17 };
    default:
      return { twoSeats: false, rearBench: false, cage: true, doorCards: false, bucket: true, seatTilt: 0.62, cowlZ: 0.9, cowlY: 0.64, floorY: 0.14, ...LOW_CABIN, wheelUp: 0.34, wheelFwd: 0.6, wheelTilt: 0.9 };
  }
}

export function makeInterior(spec: CarVisualSpec, quality: QualityLevel): InteriorData {
  const st = styleFor(spec.style);
  const sx = spec.seat.x, sy = spec.seat.y, sz = spec.seat.z;
  const proto = spec.style === 'prototype';
  // (an open cockpit: the body's tub is all there is round the driver, so the cabin is only the seat, the headrest and the footwell floor)
  const open = spec.style === 'formula';
  const tilt = st.seatTilt;
  const ct = Math.cos(tilt), sn = Math.sin(tilt);
  const floorY = st.floorY;

  const eye = eyePoint(spec);
  const wheelPos: V3 = [sx, sy + st.wheelUp, sz + st.wheelFwd];
  const wheelTilt = st.wheelTilt;
  const wheelNormal: V3 = [0, Math.sin(wheelTilt), -Math.cos(wheelTilt)];
  // instrument cluster: a hooded binnacle above the wheel rim (road cars) / a dash display (prototype)
  const binY = proto ? wheelPos[1] + 0.14 : wheelPos[1] + st.binUp;
  const binZ = wheelPos[2] + (proto ? 0.3 : 0.17);
  const screenC: V3 = [sx, binY, binZ - 0.085];
  // the helmet sits a little behind/below the eye point
  const head: V3 = [eye[0], eye[1] - 0.03, eye[2] - 0.07];
  const hipY = sy + 0.06;

  // ── cabin field ──────────────────────────────────────────────────────────
  const seat = (ax: number, y: number, z: number, cx: number): number => {
    const px = ax - cx;
    // cushion
    let d = sdRoundBox(px, y - (sy - 0.045), z - (sz + 0.1), 0.215, 0.055, 0.25, 0.04);
    // backrest: frame rotated about x so the back leans AWAY from the driver (towards -z as it rises)
    const by = y - (sy + 0.02), bz = z - (sz - 0.12);
    const ry = by * ct - bz * sn;
    const rz = by * sn + bz * ct;
    d = smin(d, sdRoundBox(px, ry - 0.27, rz, 0.215, 0.3, 0.055, 0.045), 0.05);
    if (st.bucket) {
      d = smin(d, sdRoundBox(Math.abs(px) - 0.19, ry - 0.22, rz - 0.03, 0.04, 0.2, 0.09, 0.03), 0.04);
      d = smin(d, sdRoundBox(Math.abs(px) - 0.18, y - (sy - 0.01), z - (sz + 0.12), 0.04, 0.04, 0.2, 0.025), 0.04);
    }
    return d;
  };
  const headrest = (ax: number, y: number, z: number, cx: number): number => sdRoundBox(ax - cx, y - (head[1] - 0.04), z - (head[2] - 0.2), 0.12, 0.1, 0.05, 0.04);

  const cageTube = (x: number, y: number, z: number): number => {
    if (!st.cage) return 1e9;
    const ax = Math.abs(x);
    const top = proto ? spec.height - 0.14 : Math.min(spec.height - 0.2, 1.1);
    const zh = sz - 0.34;
    // main hoop behind the seats: two uprights + cross bar
    let d = sdCapsule(ax, y, z, 0.5, floorY, zh, 0.48, top, zh, 0.018);
    d = Math.min(d, sdCapsule(ax, y, z, 0.48, top, zh, 0.0, top, zh, 0.018));
    return d;
  };

  const dRear = wheelPos[2] + 0.1;
  const dFront = st.cowlZ + 0.12;
  const dc = (dRear + dFront) * 0.5;
  const dh = Math.max(0.05, (dFront - dRear) * 0.5);
  const dashSlope = 0.3;
  const dashCenterTop = st.cowlY - 0.03 - dashSlope * dh;

  const cabin: FieldFn = (x, y, z) => {
    const ax = x < 0 ? -x : x;
    if (open) {
      // the floor of the tub, from behind the seat to where the chassis's underside starts to rise towards the nose (beyond, it would
      // show under the car)
      const f0 = sz - 0.3, f1 = spec.wheelbase / 2 - 0.55;
      const floor = sdRoundBox(ax, y - floorY, z - (f0 + f1) * 0.5, st.floorHalfW, 0.025, (f1 - f0) * 0.5, 0.015);
      // the headrest: a pad behind the helmet and one either side of it on the cockpit's rim, as one U (the rules' padding)
      const pads = Math.min(
        sdRoundBox(ax, y - (head[1] - 0.08), z - (head[2] - 0.185), 0.16, 0.06, 0.04, 0.03),
        sdRoundBox(ax - 0.165, y - (head[1] - 0.11), z - (head[2] - 0.025), 0.035, 0.045, 0.145, 0.025),
      );
      return Math.min(floor, smin(seat(x, y, z, sx), pads, 0.05));
    }
    // floor tub
    let d = sdRoundBox(ax, y - floorY, z - (sz - 0.1 + st.cowlZ * 0.5), proto ? 0.4 : st.floorHalfW, 0.025, (st.cowlZ - sz + 1.2) * 0.5 + 0.2, 0.015);
    d = Math.min(d, smin(seat(x, y, z, sx), headrest(ax, y, z, sx), 0.05));
    if (st.twoSeats) d = Math.min(d, smin(seat(x, y, z, -sx), headrest(ax, y, z, -sx), 0.05));
    if (st.rearBench) {
      d = Math.min(d, sdRoundBox(ax, y - (sy - 0.1), z - (sz - 0.82), st.benchHalfW, 0.07, 0.2, 0.04));
      d = Math.min(d, sdRoundBox(ax, y - (sy + 0.18), z - (sz - 1.02), st.benchHalfW, 0.26, 0.06, 0.05));
    }
    if (!proto) {
      // dash pad: a shallow sloping wedge from the windscreen base back to just ahead of the wheel
      const yy = y - dashSlope * (z - dc);
      let dash = sdRoundBox(ax, yy - (dashCenterTop - st.dashHy), z - dc, st.dashHalfW, st.dashHy, dh, 0.05);
      // instrument binnacle over the wheel
      dash = smin(dash, sdRoundBox(x - sx, y - binY, z - binZ, 0.2, 0.06, 0.085, 0.03), 0.04);
      d = Math.min(d, dash);
      // centre console
      d = Math.min(d, sdRoundBox(ax, y - (floorY + 0.19), z - (sz + 0.45), 0.1, 0.13, 0.62, 0.05));
      if (st.doorCards) d = Math.min(d, sdRoundBox(ax - st.doorX, y - st.doorY, z - (st.cowlZ - st.doorZ), 0.02, st.doorHy, st.doorHz, 0.015));
      if (st.rearDoor) d = Math.min(d, sdRoundBox(ax - st.doorX, y - st.doorY, z - (st.cowlZ - 1.45), 0.02, st.doorHy, 0.46, 0.015));
    } else {
      // monocoque: nose bulkhead ahead of the pedals, tunnel, a small dash display pod
      d = Math.min(d, sdRoundBox(ax, y - (floorY + 0.2), z - (st.cowlZ + 0.1), 0.34, 0.22, 0.1, 0.06));
      d = Math.min(d, sdRoundBox(ax, y - (floorY + 0.09), z - (sz + 0.5), 0.2, 0.09, 0.55, 0.05));
      d = Math.min(d, sdRoundBox(x - sx, y - binY, z - binZ, 0.17, 0.05, 0.085, 0.025));
    }
    d = Math.min(d, cageTube(x, y, z));
    return d;
  };

  // ── driver field ─────────────────────────────────────────────────────────
  // (the single-seater's hands hold its yoke's grips, where the wheel's own gloves are)
  const gripX = open ? YOKE.gripX : 0.17;
  const handL: V3 = [wheelPos[0] + gripX, wheelPos[1] + 0.02, wheelPos[2]];
  const handR: V3 = [wheelPos[0] - gripX, wheelPos[1] + 0.02, wheelPos[2]];

  // spine direction (leans back by the seat tilt); hips at the seat reference point
  const ux = 0, uy = ct, uz = -sn;
  const hip: V3 = [sx, hipY, sz];
  const at = (t: number): V3 => [hip[0], hip[1] + uy * t, hip[2] + uz * t];
  const chest = at(0.34);
  const shoulderC = at(0.5);
  const neck = at(0.55);
  // (the single-seater's tub is 56 cm across outside at the shoulders: its driver's are 47 cm, not 55)
  const shoulderW = open ? 0.16 : 0.2;
  void ux;
  const driver: FieldFn = (x, y, z) => {
    // helmet + neck
    let d = sdEllipsoid(x - head[0], y - head[1], z - head[2], 0.112, 0.138, 0.15);
    d = smin(d, sdCapsule(x, y, z, head[0], head[1] - 0.1, head[2] - 0.02, neck[0], neck[1], neck[2], 0.055), 0.04);
    // torso: capsule along the spine, shoulders as a cross capsule
    d = smin(d, sdCapsule(x, y, z, hip[0], hip[1] + 0.06, hip[2] + 0.02, chest[0], chest[1], chest[2], 0.17), 0.06);
    d = smin(d, sdCapsule(x, y, z, shoulderC[0] - shoulderW, shoulderC[1], shoulderC[2], shoulderC[0] + shoulderW, shoulderC[1], shoulderC[2], 0.075), 0.05);
    for (const sgn of [-1, 1]) {
      const sh: V3 = [sx + sgn * (shoulderW + 0.01), shoulderC[1] - 0.02, shoulderC[2] + 0.02];
      const hd: V3 = sgn > 0 ? handL : handR;
      // elbow: halfway to the hand, dropped and pushed out
      const el: V3 = [(sh[0] + hd[0]) * 0.5 + sgn * 0.07, Math.min(sh[1], hd[1]) - 0.08, (sh[2] + hd[2]) * 0.5 - 0.02];
      d = smin(d, sdCapsule(x, y, z, sh[0], sh[1], sh[2], el[0], el[1], el[2], 0.048), 0.03);
      d = smin(d, sdCapsule(x, y, z, el[0], el[1], el[2], hd[0], hd[1] - 0.02, hd[2], 0.04), 0.03);
      // legs: thigh forward from the hip, shin down to the pedal box
      const lx = sx + sgn * 0.1;
      const kneeY = hipY + (proto ? 0.12 : 0.1);
      d = smin(d, sdCapsule(x, y, z, lx, hipY, sz + 0.05, lx, kneeY, sz + 0.5, 0.078), 0.04);
      d = smin(d, sdCapsule(x, y, z, lx, kneeY, sz + 0.5, lx, floorY + 0.13, sz + 0.8, 0.055), 0.04);
      d = smin(d, sdRoundBox(x - lx, y - (floorY + 0.1), z - (sz + 0.87), 0.05, 0.05, 0.11, 0.03), 0.03);
    }
    return d;
  };

  /**
   * The single-seater's helmet as a zone (channel 14 < 0), not a part: in an open cockpit its lower edge is on show, and a part changes
   * only from one triangle to the next (a jagged edge round the neck), where a zone is cut smooth across them. Its rim is level, 12.5 cm
   * under the helmet's centre: below is the suit (and the shoulders, which reach the chin of a driver lying back).
   */
  const helmetZone = (x: number, y: number, z: number): number => {
    const e = Math.hypot((x - head[0]) / 0.124, (y - head[1]) / 0.152, (z - head[2]) / 0.165) - 1;
    return Math.max(e * 0.14, head[1] - 0.125 - y);
  };
  const driverKind = (x: number, y: number, z: number, nz: number): number => {
    const hx = x - head[0], hy = y - head[1], hz = z - head[2];
    const inHelmet = (hx * hx) / (0.13 * 0.13) + (hy * hy) / (0.155 * 0.155) + (hz * hz) / (0.17 * 0.17) < 1.15;
    if (inHelmet && !open) return IPART.helmet;
    if (y < floorY + 0.2 && z > sz + 0.6) return IPART.shoe;
    if (Math.hypot(x - handL[0], y - handL[1], z - handL[2]) < 0.07 || Math.hypot(x - handR[0], y - handR[1], z - handR[2]) < 0.07) return IPART.glove;
    return IPART.suit;
  };

  const cabinKind = (x: number, y: number, z: number, _nx: number, _ny: number, nz: number): number => {
    const ax = Math.abs(x);
    if (open) return y < floorY + 0.045 ? IPART.floor : IPART.seat;
    if (y < floorY + 0.045 && !(Math.abs(x - sx) < 0.25 && z > sz - 0.35 && z < sz + 0.4)) return IPART.floor;
    if (st.doorCards && !proto && ax > st.doorCut && z > st.cowlZ - st.doorBack) return IPART.doorCard;
    if (!proto && z > wheelPos[2] - 0.05 && y > floorY + 0.2 && ax > 0.15) return IPART.dash;
    if (!proto && z > wheelPos[2] - 0.05 && y > floorY + 0.35) return IPART.dash;
    if (!proto && ax < 0.14 && z > sz + 0.1) return IPART.console;
    if (st.cage && y > floorY + 0.3 && z < sz - 0.2) return IPART.cage;
    if (proto && z > st.cowlZ - 0.1) return IPART.carbon;
    return IPART.seat;
  };

  // ── mesh both ────────────────────────────────────────────────────────────
  const cell = quality === 'low' ? 0.055 : quality === 'medium' ? 0.045 : 0.038;
  const dcell = quality === 'low' ? 0.05 : quality === 'medium' ? 0.036 : 0.03;
  const dashMid = dc;
  const cabinZones = (x: number, y: number, z: number, _nx: number, ny: number, _nz: number, out: Float32Array): void => {
    // (no cluster in the open cockpit's cabin: its display is on the steering wheel)
    if (open) return;
    // cluster face: a thin slab at the binnacle's rear face (bounded behind too, or the seatback behind it gets the display)
    out[1] = Math.max(Math.abs(x - sx) - 0.178, Math.abs(y - binY) - 0.048, z - (binZ - 0.081), binZ - 0.15 - z);
    if (!proto) {
      const up = ny > 0.35 && z > dRear - 0.02 ? -1 : 1;
      const ax = Math.abs(x);
      // centre infotainment screen on the dash top, between driver and passenger
      out[2] = Math.max(Math.abs(x) - 0.12, Math.abs(z - (dashMid + 0.01)) - 0.055, up);
      // round air vents at the outer ends and one each side of the screen
      const vz = dashMid - 0.01;
      const v1 = Math.hypot(ax - st.ventX, z - vz) - 0.034;
      const v2 = Math.hypot(ax - 0.21, z - (vz + 0.02)) - 0.03;
      out[3] = Math.max(Math.min(v1, v2), up);
    } else {
      out[2] = 1;
      out[3] = 1;
    }
  };
  const cabinMesh = meshField(cabin, [-st.halfW, floorY - 0.05, sz - 1.25], [st.halfW, st.top, st.cowlZ + 0.3], cell, cabinKind, cabinZones);
  // (a driver lying back has the head well behind the hips: the box reaches back to the helmet)
  const dMin: [number, number, number] = [sx - 0.5, floorY, Math.min(sz - 0.3, head[2] - 0.25)];
  const dMax: [number, number, number] = [sx + 0.5, head[1] + 0.25, sz + 1.05];
  const dk = (x: number, y: number, z: number, _nx: number, _ny: number, nz: number): number => driverKind(x, y, z, nz);
  const driverZones = (x: number, y: number, z: number, _nx: number, _ny: number, _nz: number, out: Float32Array): void => {
    const hx = x - head[0], hy = y - head[1], hz = z - head[2];
    // visor: a wide slot on the front of the helmet, rounded at the ends
    out[0] = Math.max(0.035 - hz, Math.abs(hy - 0.012) - 0.045, Math.abs(hx) - 0.098) + 0.0;
    if (open) out[14] = helmetZone(x, y, z);
  };
  const driverMesh = meshField(driver, dMin, dMax, dcell, dk, driverZones);
  const driverLite = meshField(driver, dMin, dMax, 0.05, dk, driverZones);

  const wheelPb = new PartBuilder();
  buildSteeringWheel(wheelPb, spec.style);
  return {
    cabin: cabinMesh,
    driver: driverMesh,
    driverLite,
    wheel: partToData(wheelPb),
    wheelPos,
    wheelNormal,
    head,
    screen: screenC,
  };
}

function meshField(
  field: FieldFn,
  min: [number, number, number],
  max: [number, number, number],
  cell: number,
  part: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => number,
  zones?: (x: number, y: number, z: number, nx: number, ny: number, nz: number, out: Float32Array) => void,
): PartData {
  const m = polygonize({ min, max, cell, field, lipschitz: 1.3 });
  const n = m.stats.vertices;
  const vertices = new Float32Array(n * VERTEX_STRIDE);
  const hs = [0.03, 0.08, 0.17];
  const hw = [0.5, 0.3, 0.2];
  const zbuf = new Float32Array(ZONE_STRIDE);
  for (let i = 0; i < n; i++) {
    const o = i * VERTEX_STRIDE;
    const x = m.positions[i * 3], y = m.positions[i * 3 + 1], z = m.positions[i * 3 + 2];
    const nx = m.normals[i * 3], ny = m.normals[i * 3 + 1], nz = m.normals[i * 3 + 2];
    vertices[o] = x; vertices[o + 1] = y; vertices[o + 2] = z;
    vertices[o + 3] = nx; vertices[o + 4] = ny; vertices[o + 5] = nz;
    for (let k = 0; k < ZONE_STRIDE; k++) vertices[o + 6 + k] = 1;
    if (zones) {
      zbuf.fill(1);
      zones(x, y, z, nx, ny, nz, zbuf);
      for (let k = 0; k < 4; k++) vertices[o + 6 + k] = zbuf[k];
      // (channel 14: the helmet of a driver whose helmet is a zone; 1, as before, on every other mesh)
      vertices[o + 6 + 14] = zbuf[14];
    }
    let occ = 0;
    for (let k = 0; k < hs.length; k++) {
      let d = field(x + nx * hs[k], y + ny * hs[k], z + nz * hs[k]);
      if (d < 0) d = 0;
      occ += (hw[k] * (hs[k] - d)) / hs[k];
    }
    vertices[o + 6 + 12] = Math.min(1, Math.max(0.12, 1 - 1.2 * occ));
    vertices[o + 6 + 13] = part(x, y, z, nx, ny, nz);
  }
  return { vertices, index: m.indices };
}

/** Steering wheel around the origin, wheel plane XY, the driver sees the +Z side. */
function buildSteeringWheel(pb: PartBuilder, style: BodyStyle): void {
  if (style === 'formula') {
    buildYoke(pb);
    return;
  }
  if (style === 'prototype') {
    // formula-style wheel: rounded body with two grips and a screen
    pb.setPart(IPART.carbon);
    pb.box([0, 0.0, 0], 0.15, 0.085, 0.017);
    pb.setPart(IPART.wheelRim);
    for (const sg of [-1, 1]) pb.box([sg * 0.195, 0.0, 0], 0.035, 0.09, 0.022);
    pb.setPart(IPART.wheelScreen);
    pb.box([0, 0.015, 0.0185], 0.08, 0.04, 0.001);
    pb.setPart(IPART.metal);
    for (const [bx, by] of [[-0.1, -0.04], [0.1, -0.04], [-0.06, -0.06], [0.06, -0.06]] as Array<[number, number]>) {
      pb.cylinder([bx, by, 0.0175], [bx, by, 0.0215], 0.01, 0.01, 10, true);
    }
    pb.setPart(IPART.glove);
    for (const sg of [-1, 1]) pb.ellipsoid([sg * 0.2, 0.0, -0.01], 0.05, 0.065, 0.045, 14, 9);
    return;
  }
  // (the 4x4's wheel is a big round chunky one: 41 cm across, a 4.7 cm rim, no flat bottom)
  const suv = style === 'suv';
  const R = suv ? 0.205 : style === 'hatch' ? 0.18 : 0.175;
  const tube = suv ? 0.0235 : style === 'coupe' ? 0.0145 : 0.018;
  const N = 40;
  const rings: V3[][] = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;
    let r = R;
    if (style !== 'hatch' && !suv) {
      const cy = Math.sin(t);
      if (cy < -0.78) r = R * (0.78 / -cy);
    }
    const px = Math.cos(t) * r, py = Math.sin(t) * r;
    const ux = Math.cos(t), uy = Math.sin(t);
    const rg: V3[] = [];
    const M = 10;
    for (let k = 0; k < M; k++) {
      const a = (k / M) * Math.PI * 2;
      const ca = Math.cos(a) * tube, sa = Math.sin(a) * tube * 1.1;
      rg.push([px + ux * ca, py + uy * ca, sa]);
    }
    rings.push(rg);
  }
  pb.setPart(IPART.wheelRim);
  pb.loft(rings);
  pb.setPart(IPART.wheelSpoke);
  pb.cylinder([0, 0, -0.012], [0, 0, 0.028], suv ? 0.062 : 0.05, suv ? 0.056 : 0.045, 24, true);
  pb.box([0, 0, 0.0], R * 0.95, suv ? 0.026 : 0.017, 0.007);
  pb.box([0, suv ? -0.1 : -0.07, 0.0], suv ? 0.026 : 0.017, suv ? 0.1 : 0.07, 0.007);
  pb.setPart(IPART.seatAccent);
  pb.box([0, R, 0.0], 0.007, 0.012, tube * 1.15);
  pb.setPart(IPART.glove);
  for (const sg of [-1, 1]) pb.ellipsoid([sg * R, 0.01, -0.005], 0.05, 0.062, 0.042, 14, 9);
}

/**
 * The single-seater's yoke (2026), around the origin as the other wheels are: a carbon plate 28 cm across and 16 cm tall with a grip at
 * either end, the display in the middle (IPART.wheelDisplay: gear, speed and revs, live), the row of fifteen shift lights over it
 * (IPART.shiftLights), rotary switches and buttons round it, the shift paddles and the quick release behind, and the gloves on the grips.
 */
function buildYoke(pb: PartBuilder): void {
  const D = YOKE.display, Ls = YOKE.lights, gx = YOKE.gripX;
  // the plate: straight across the top, the grips' ends standing a little proud of it, the bottom cut away between them for the knees
  const half: number[] = [0.05, -0.04, 0.085, -0.056, 0.104, -0.078, 0.13, -0.08, 0.142, -0.06, 0.142, 0.055, 0.13, 0.08, 0.1, 0.072];
  const outline: number[] = [0, -0.034, ...half];
  for (let i = half.length - 2; i >= 0; i -= 2) outline.push(-half[i], half[i + 1]);
  pb.setPart(IPART.carbon);
  pb.extrude(roundPoly(outline, 0.012, 4), { o: [0, 0, -0.012], u: [1, 0, 0], v: [0, 1, 0] }, 0.024, 0.004, 2);
  // the grips: thick, rubber-covered, a little forward at their ends
  pb.setPart(IPART.wheelRim);
  for (const sg of [-1, 1]) {
    pb.tube([[sg * (gx + 0.008), 0.07, -0.004], [sg * gx, 0.04, 0.002], [sg * gx, -0.02, 0.003], [sg * (gx - 0.004), -0.066, -0.002]], 0.019, 12, true);
  }
  // the display in a black bezel, and the shift lights in a strip over it
  pb.setPart(IPART.wheelRim);
  pb.box([D.x, D.y, 0.0125], D.hw + 0.006, D.hh + 0.006, 0.0006);
  pb.setPart(IPART.wheelDisplay);
  pb.box([D.x, D.y, 0.0135], D.hw, D.hh, 0.0006);
  pb.setPart(IPART.carbon);
  pb.box([0, Ls.y, 0.0128], -Ls.x0 + 0.008, 0.0065, 0.001);
  pb.setPart(IPART.shiftLights);
  for (let i = 0; i < Ls.n; i++) pb.box([Ls.x0 + i * Ls.step, Ls.y, 0.0142], 0.0034, 0.0034, 0.0006);
  // black rotary switches low on the plate, coloured buttons beside the display
  pb.setPart(IPART.wheelRim);
  for (const [bx, by] of [[-0.078, -0.036], [0.078, -0.036], [-0.034, -0.05], [0.034, -0.05]] as Array<[number, number]>) {
    pb.cylinder([bx, by, 0.011], [bx, by, 0.022], 0.0105, 0.0095, 12, true);
  }
  pb.setPart(IPART.seatAccent);
  for (const [bx, by] of [[-0.075, 0.038], [0.075, 0.038], [-0.075, 0.008], [0.075, 0.008]] as Array<[number, number]>) {
    pb.cylinder([bx, by, 0.011], [bx, by, 0.017], 0.0075, 0.0075, 10, true);
  }
  // the paddles behind the grips, and the quick release on the column
  pb.setPart(IPART.carbon);
  for (const sg of [-1, 1]) pb.box([sg * 0.085, 0.01, -0.024], 0.032, 0.03, 0.003);
  pb.setPart(IPART.metal);
  pb.cylinder([0, 0, -0.012], [0, 0, -0.05], 0.022, 0.018, 16, true);
  // the gloves: the fingers round the grips, the thumbs on the plate's face beside the display
  pb.setPart(IPART.glove);
  for (const sg of [-1, 1]) {
    pb.ellipsoid([sg * (gx + 0.004), 0.004, -0.004], 0.031, 0.05, 0.034, 14, 9);
    pb.ellipsoid([sg * (gx - 0.026), 0.028, 0.014], 0.017, 0.009, 0.008, 10, 6);
  }
}
