/**
 * The camera drones of an orbital circuit (`HoverDef.drones`): white things the size of a suitcase that hold station over the
 * outside of the corners and along the straights, 6 to 20 m up: a slab of a body between four ducts with no rotor in them (a ring
 * of the lift light under each), a camera under its nose, a white lamp at the nose and a lamp of the circuit's colour at the tail
 * that pulses slowly after dark. Over the marshal
 * posts of the slowest corners hangs a larger one whose tail lamp is an amber beacon.
 *
 * One instanced draw call. A drone's turning about (it looks at nothing in particular), its bob and its lamps are the vertex shader's
 * (see hoverKit.ts), from one clock: nothing is moved here after the build.
 */
import * as THREE from 'three';
import { mulberry32 } from '../math';
import { resolveMark } from '../plan';
import type { HoverDef } from '../types';
import type { Ctx } from './ctx';
import { GLOW, HoverBuf, type HoverMats, type RGB, lin, surface } from './hoverKit';
import type { TvCam } from './hoverTerrace';

const SHELL = lin(0xeeebe2);
const BELLY = lin(0xd6d3c9);
const DARK = lin(0x16181c);
const BLACK: RGB = [0, 0, 0];
const LIFT = lin(0xdcebff);
const WHITE = lin(0xfff4e2);

/** Half length, half height, half width of the body (m), where the four ducts sit and their radii. */
const BX = 0.4;
const BY = 0.085;
const BZ = 0.15;
const DUCT_X = 0.26;
const DUCT_Z = 0.29;
const DUCT_R = 0.17;
const DUCT_IN = 0.132;
const DUCT_H = 0.036;
/** A marshal drone is this many times a camera drone. */
const MARSHAL = 2.4;
/** Radiance of the lamps at night per unit of their colour (they are a few centimetres across: the bloom makes the point). */
const LAMP = 9;

function droneGeometry(accent: RGB): THREE.BufferGeometry {
  const buf = new HoverBuf();
  // the body: a slab with round shoulders, paler above
  surface(buf, 10, 4, true, { cx: 0, cz: 0 }, (i, j, n) => {
    const t = (i / 10) * Math.PI * 2;
    const lat = (0.5 - j / 4) * Math.PI;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const cl = Math.pow(Math.cos(lat), 0.6);
    n.x = BX * cl * Math.sign(c) * Math.pow(Math.abs(c), 0.7);
    n.y = BY * Math.sin(lat);
    n.z = BZ * cl * Math.sign(s) * Math.pow(Math.abs(s), 0.7);
    n.c = lat > -0.2 ? SHELL : BELLY;
  });
  // four ducts with no rotor in them: a ring of the lift light under each (that is what holds a drone up, as it holds a terrace)
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cx = sx * DUCT_X;
      const cz = sz * DUCT_Z;
      // the section, round the ring: outside low, outside high, inside high, inside low
      const SR = [DUCT_R, DUCT_R, DUCT_IN, DUCT_IN, DUCT_R];
      const SY = [-DUCT_H, DUCT_H, DUCT_H, -DUCT_H, -DUCT_H];
      const SG = [1, 0, 0, 1, 1];
      surface(buf, 10, 4, true, { cx, cz }, (i, j, n) => {
        const t = (i / 10) * Math.PI * 2;
        n.x = cx + SR[j] * Math.cos(t);
        n.y = SY[j];
        n.z = cz + SR[j] * Math.sin(t);
        n.c = SG[j] ? BELLY : SHELL;
        n.g = SG[j] ? LIFT : null;
        n.mode = GLOW.lift;
        n.k = 0.4;
      });
    }
  }
  // the camera: a dark ball under the nose
  surface(buf, 6, 3, true, { cx: 0.27, cz: 0 }, (i, j, n) => {
    const t = (i / 6) * Math.PI * 2;
    const lat = (0.5 - j / 3) * Math.PI;
    n.x = 0.27 + 0.08 * Math.cos(lat) * Math.cos(t);
    n.y = -BY - 0.045 + 0.08 * Math.sin(lat);
    n.z = 0.08 * Math.cos(lat) * Math.sin(t);
    n.c = DARK;
  });
  // the lamps: discs that face the eye, at the tips so that they show from below
  const lamp = (x: number, y: number, r: number, col: RGB, mode: number): void => {
    const c = buf.v(x, y, 0, 0, 1, 0, BLACK, col, mode, LAMP);
    buf.lamp(0, 0, r);
    const rim: number[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      // (the rim is a little dimmer than the middle: the disc reads as round)
      rim.push(buf.v(x, y, 0, 0, 1, 0, BLACK, col, mode, LAMP * 0.45));
      buf.lamp(Math.cos(a), Math.sin(a), r);
    }
    for (let i = 0; i < 8; i++) buf.tri(c, rim[i], rim[(i + 1) % 8]);
  };
  lamp(BX + 0.02, -0.01, 0.032, WHITE, GLOW.night);
  lamp(-BX - 0.02, -0.01, 0.036, accent, GLOW.lamp);
  return buf.build(true);
}

export interface Drones {
  mesh: THREE.InstancedMesh;
  triangles: number;
  count: number;
}

export function buildDrones(ctx: Ctx, def: HoverDef, mats: HoverMats, cams: readonly TvCam[]): Drones | null {
  const dd = def.drones;
  if (!dd) return null;
  const rt = ctx.rt;
  const sc = rt.def.scenery;
  const L = rt.length;
  const rng = mulberry32((rt.def.seed ^ 0xd205e5) >>> 0);
  const index = (s: number): number => Math.round(rt.wrapS(s) / rt.spacing) % rt.count;
  const mark = (m: import('../types').Mark): number => resolveMark(rt.plan.marks, L, m);
  const gapS = (a: number, b: number): number => Math.abs(rt.wrapS(a - b + L / 2) - L / 2);
  // what stands over the road: the gantry (and the ring of light at it), the footbridges, the banner
  const over: [number, number][] = [];
  if (sc?.gantry !== undefined) over.push([mark(sc.gantry), 14]);
  for (const r of sc?.neon?.rings ?? []) over.push([mark(r.at), 14]);
  for (const b of sc?.bridges ?? []) over.push([mark(b.at), 14]);
  if (def.banner) over.push([mark(def.banner.at), 12]);
  const spots: number[] = [];
  const p = new THREE.Vector3();
  /** A drone at s, `out` m beyond the edge of the asphalt (the kerb) on one side, `up` m over the road. */
  const add = (s: number, sgn: 1 | -1, out: number, up: number, kind: number): boolean => {
    const k = index(s);
    const S = sgn > 0 ? rt.L : rt.R;
    // (over the run-off, never over the barrier or beyond it: the lamp masts, the fences and the trees are there)
    const d = S.W[k] + S.curbW[k] + Math.min(out, Math.max(1.5, S.wall[k] - S.W[k] - S.curbW[k] - 2.5));
    if (kind === 0) {
      if (over.some(([o, r]) => gapS(s, o) < r)) return false;
      rt.pointAt(rt.wrapS(s), sgn * d, p);
      if (cams.some((c) => (c.position.x - p.x) * (c.position.x - p.x) + (c.position.z - p.z) * (c.position.z - p.z) < 22 * 22)) return false;
    } else {
      rt.pointAt(rt.wrapS(s), sgn * out, p);
    }
    spots.push(p.x, p.y + up, p.z, kind);
    return true;
  };
  // over the outside of every corner: one, or two round a long one
  const cs = rt.corners;
  for (const c of cs) {
    const arc = c.sArcB - c.sArcA;
    const n = arc > 60 ? 2 : 1;
    const sgn = c.dir > 0 ? -1 : 1;
    for (let j = 0; j < n; j++) add(c.sArcA + (arc * (j + 0.3 + 0.4 * rng())) / n, sgn, 2 + 6 * rng(), 6 + 7 * rng(), 0);
  }
  // along the straights, from side to side
  const every = dd.every ?? 150;
  let side: 1 | -1 = 1;
  for (let i = 0; i < cs.length; i++) {
    const a = cs[i].sEnd;
    const len = rt.wrapS(cs[(i + 1) % cs.length].sStart - a);
    const n = Math.round(len / every);
    for (let j = 0; j < n; j++) {
      // (a drone that would hang in a gantry or in front of a TV camera moves along a little, twice at the most)
      const s = a + (len * (j + 0.35 + 0.3 * rng())) / n;
      const out = 2 + 4 * rng();
      const up = 9 + 11 * rng();
      if (!add(s, side, out, up, 0) && !add(s + 26, side, out, up, 0)) add(s - 26, side, out, up, 0);
      side = side > 0 ? -1 : 1;
    }
  }
  // the marshal drones: over the post on the outside of the corner (see props.ts: 3.2 m behind the barrier at the apex)
  for (const name of dd.marshals ?? []) {
    const c = cs.find((q) => q.name === name);
    if (!c) continue;
    const s = (c.sArcA + c.sArcB) / 2;
    const sgn = c.dir > 0 ? -1 : 1;
    const k = index(s);
    add(s, sgn, (sgn > 0 ? rt.L : rt.R).wall[k] + 3.2, 0, 1);
    const o = spots.length - 4;
    // (over the hut and its flag: 9 m over the ground it stands on)
    spots[o + 1] = rt.heightXZ(spots[o], spots[o + 2]) + 9;
  }
  const count = spots.length / 4;
  if (!count) return null;
  const geo = droneGeometry(lin(def.accent ?? new THREE.Color(rt.info.color).getHex()));
  const tris = (geo.index?.count ?? 0) / 3;
  const info = new Float32Array(count * 4);
  const mesh = new THREE.InstancedMesh(geo, mats.drone, count);
  mesh.name = 'hover_drones';
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sv = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < count; i++) {
    const marshal = spots[i * 4 + 3] > 0.5;
    const sc1 = marshal ? MARSHAL : 0.9 + 0.25 * rng();
    q.setFromAxisAngle(up, rng() * Math.PI * 2);
    m4.compose(p.set(spots[i * 4], spots[i * 4 + 1], spots[i * 4 + 2]), q, sv.setScalar(sc1));
    mesh.setMatrixAt(i, m4);
    // phase, how fast it turns (rad/s), how far it bobs (m, in its own scale), 1 = a marshal's
    info[i * 4] = rng();
    info[i * 4 + 1] = marshal ? 0.05 : 0.07 + 0.09 * rng();
    info[i * 4 + 2] = (marshal ? 0.16 : 0.1 + 0.12 * rng()) / sc1;
    info[i * 4 + 3] = marshal ? 1 : 0;
  }
  geo.setAttribute('aDrone', new THREE.InstancedBufferAttribute(info, 4));
  mesh.instanceMatrix.needsUpdate = true;
  // (they are all over the circuit: one draw call whatever the view)
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  ctx.disposables.push(geo);
  return { mesh, triangles: tris * count, count };
}
