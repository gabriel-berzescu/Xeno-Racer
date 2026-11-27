/**
 * What the fleet of an island circuit is made with (fleet.ts and its parts: the boats, the great ship): a vertex buffer whose
 * vertices know what they are, surfaces given as functions, and the one material everything shares.
 *
 * A vertex is one of four things (`aRig.x`):
 *   solid  a hull, a deck, a mast. `aRig.y`: its own light after dark, per unit of its colour (a line of light; below 0, a window
 *          with a warm lamp behind it);
 *          `aRig.z`: 1 where the colour is the boat's own hull colour times the vertex's; `aRig.w`: its roughness (0: the material's).
 *   sail   a membrane. Its vertices lie on its luff, and the shader spreads them: `aRig.y` m along the chord and `aRig.z` m of belly
 *          across it, turned about the luff by the boat's trim and drawn in by its furl. The colour is the boat's sail colour, and
 *          the vertex's own colour says where on the sail it is: red from the luff (0) to the leech (1), green from the foot (0) to
 *          the head (1), blue the height in battens over 32 (the veins of the leaf are drawn from it). `aRig.w` = 1 is a spar that
 *          goes with the sail and keeps its own colour.
 *   lamp   a corner of a disc that faces the eye (`aRig.y`, `aRig.z`: which corner; `aRig.w`: the radius in metres), never drawn
 *          smaller than a pixel, dark by day.
 *   lift   a surface that shines by day too (`aRig.y` per unit of its colour): the light under the great ship that holds it up.
 *
 * The material is a lit one (the scene's sun, sky and fog), in two programs: the boats' (instanced, double sided: a membrane has no
 * back) and the great ship's. A boat's roll, pitch and heave, its swing about its anchor, the trim of its sails and the breath in
 * them are the vertex shader's, from one clock and the instance's own numbers. A sail with the sun behind it is lit through: that
 * is what a membrane is, and it is most of what a fleet looks like against a low sun.
 */
import * as THREE from 'three';
import type { EnvironmentState } from '../../core/contracts';
import type { Ctx } from './ctx';

export type V3 = [number, number, number];
/** Linear RGB. */
export type RGB = readonly [number, number, number];
/** What a vertex is and its three numbers (see the head of this file). */
export type Rig = readonly [number, number, number, number];

export const KIND = { solid: 0, sail: 1, lamp: 2, lift: 3 } as const;
const PLAIN: Rig = [KIND.solid, 0, 0, 0];

const _c = new THREE.Color();
/** An sRGB hex colour as linear rgb, times k. */
export function lin(hex: number, k = 1): RGB {
  _c.set(hex);
  return [_c.r * k, _c.g * k, _c.b * k];
}
export function scaled(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k];
}

/** A solid vertex's rig: its light after dark, whether it takes the hull's colour, its roughness. */
export function solid(glow = 0, hull = false, rough = 0): Rig {
  return [KIND.solid, glow, hull ? 1 : 0, rough];
}

/** What the water shows of a boat (fleetMirror.ts): the outline of a sail, the side of a hull, or a lamp. */
export const IMAGE = { leaf: 0, jib: 1, claw: 2, hull: 3, lamp: 4 } as const;

export interface Image {
  kind: number;
  /** A sail's luff: its foot and its head (x, y in the boat's frame) and how it bends. A hull: its stem, from the water to the deck. A lamp's streak: from, to. */
  foot: [number, number];
  head: [number, number];
  bend: number;
  /** A sail's chord (m), a hull's length, a streak's width; a crab claw's clew. */
  c: number;
  clew: [number, number];
  /** How far to starboard of the keel it is. */
  z: number;
  /** A lamp's colour, a hull's paint (times its boat's hull colour unless `plain`); a sail's is its boat's. */
  col: RGB | null;
  plain?: boolean;
}

// ── the buffer ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export class FleetBuf {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  rig: number[] = [];
  idx: number[] = [];
  count = 0;
  /** What the water shows of it. */
  images: Image[] = [];

  v(p: V3, n: V3, c: RGB, rig: Rig = PLAIN): number {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    this.col.push(c[0], c[1], c[2]);
    this.rig.push(rig[0], rig[1], rig[2], rig[3]);
    return this.count++;
  }
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  get triangles(): number {
    return this.idx.length / 3;
  }
  /** A flat quad, counter-clockwise seen from its front. */
  quad(a: V3, b: V3, c: V3, d: V3, col: RGB, rig: Rig = PLAIN): void {
    const n = faceNormal(a, b, d);
    const i = this.v(a, n, col, rig);
    this.v(b, n, col, rig);
    this.v(c, n, col, rig);
    this.v(d, n, col, rig);
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aRig', new THREE.Float32BufferAttribute(this.rig, 4));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

function faceNormal(a: V3, b: V3, c: V3): V3 {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const x = uy * vz - uz * vy;
  const y = uz * vx - ux * vz;
  const z = ux * vy - uy * vx;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

// ── surfaces ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** n + 1 numbers from a to b. */
export function span(n: number, a = 0, b = 1): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(a + ((b - a) * i) / n);
  return out;
}

export type SurfaceFn = (u: number, v: number, out: V3) => void;

/**
 * The normal of a surface at (u, v): dP/du x dP/dv by differences taken inside [u0, u1] x [v0, v1]. At a pole (a bow, the head of a
 * sail: one of the derivatives is nothing) it is the normal a little way in from it.
 */
function surfaceNormal(f: SurfaceFn, u: number, v: number, lim: [number, number, number, number], flip: boolean): V3 {
  const a: V3 = [0, 0, 0];
  const b: V3 = [0, 0, 0];
  const eu = (lim[1] - lim[0]) * 2e-3;
  const ev = (lim[3] - lim[2]) * 2e-3;
  const um = (lim[0] + lim[1]) / 2;
  const vm = (lim[2] + lim[3]) / 2;
  for (let step = 0; step < 6; step++) {
    const ua = Math.max(lim[0], u - eu);
    const ub = Math.min(lim[1], u + eu);
    const va = Math.max(lim[2], v - ev);
    const vb = Math.min(lim[3], v + ev);
    f(ua, v, a);
    f(ub, v, b);
    const px = b[0] - a[0];
    const py = b[1] - a[1];
    const pz = b[2] - a[2];
    f(u, va, a);
    f(u, vb, b);
    const qx = b[0] - a[0];
    const qy = b[1] - a[1];
    const qz = b[2] - a[2];
    const x = py * qz - pz * qy;
    const y = pz * qx - px * qz;
    const z = px * qy - py * qx;
    const l = Math.hypot(x, y, z);
    if (l > 1e-7 * (Math.hypot(px, py, pz) + 1e-9) * (Math.hypot(qx, qy, qz) + 1e-9) && l > 1e-12) {
      const s = flip ? -1 / l : 1 / l;
      return [x * s, y * s, z * s];
    }
    // step off the pole, toward the middle of the patch
    u += (um - u) * 0.04 * (step + 1);
    v += (vm - v) * 0.04 * (step + 1);
  }
  return [0, 1, 0];
}

export interface Paint {
  c: RGB;
  rig?: Rig;
}

export interface PatchOpts {
  /** The surface faces the other way than dP/du x dP/dv. */
  flip?: boolean;
  /** Each cell has four vertices of its own, painted at the cell's middle: a band of another colour ends on a line. */
  cells?: boolean;
  /** Where a vertex is kept, if not where the surface is (a sail's vertices lie on its luff). */
  store?: (u: number, v: number, p: V3) => V3;
}

/**
 * A smooth surface P(u, v) over the grid us x vs. `paint` gives a vertex its colour and its rig, from where it is on the surface
 * and its normal. Triangles that have come down to a line (at a pole) are left out.
 */
export function patch(buf: FleetBuf, us: number[], vs: number[], f: SurfaceFn, paint: (u: number, v: number, p: V3, n: V3) => Paint, opts: PatchOpts = {}): void {
  const nu = us.length;
  const nv = vs.length;
  const lim: [number, number, number, number] = [us[0], us[nu - 1], vs[0], vs[nv - 1]];
  const flip = opts.flip === true;
  const P: V3[] = [];
  const N: V3[] = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const p: V3 = [0, 0, 0];
      f(us[i], vs[j], p);
      P.push(p);
      N.push(surfaceNormal(f, us[i], vs[j], lim, flip));
    }
  }
  const same = (a: V3, b: V3): boolean => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 1e-6;
  const emit = (a: number, b: number, c: number, d: number, ia: number, ib: number, ic: number, id: number): void => {
    // (a, b, c, d) round the cell: counter-clockwise seen from the side dP/du x dP/dv points to
    const t1 = !same(P[a], P[b]) && !same(P[b], P[c]) && !same(P[a], P[c]);
    const t2 = !same(P[a], P[c]) && !same(P[c], P[d]) && !same(P[a], P[d]);
    if (flip) {
      if (t1) buf.tri(ia, ic, ib);
      if (t2) buf.tri(ia, id, ic);
    } else {
      if (t1) buf.tri(ia, ib, ic);
      if (t2) buf.tri(ia, ic, id);
    }
  };
  const put = (k: number, u: number, v: number, pt: Paint): number => buf.v(opts.store ? opts.store(u, v, P[k]) : P[k], N[k], pt.c, pt.rig);
  if (opts.cells) {
    for (let j = 0; j + 1 < nv; j++) {
      for (let i = 0; i + 1 < nu; i++) {
        const a = j * nu + i;
        const b = a + 1;
        const c = a + nu + 1;
        const d = a + nu;
        const um = (us[i] + us[i + 1]) / 2;
        const vm = (vs[j] + vs[j + 1]) / 2;
        const pm: V3 = [0, 0, 0];
        f(um, vm, pm);
        const pt = paint(um, vm, pm, N[a]);
        emit(a, b, c, d, put(a, us[i], vs[j], pt), put(b, us[i + 1], vs[j], pt), put(c, us[i + 1], vs[j + 1], pt), put(d, us[i], vs[j + 1], pt));
      }
    }
    return;
  }
  const base = buf.count;
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) put(j * nu + i, us[i], vs[j], paint(us[i], vs[j], P[j * nu + i], N[j * nu + i]));
  for (let j = 0; j + 1 < nv; j++) {
    for (let i = 0; i + 1 < nu; i++) {
      const a = j * nu + i;
      emit(a, a + 1, a + nu + 1, a + nu, base + a, base + a + 1, base + a + nu + 1, base + a + nu);
    }
  }
}

/** A round spar along a path, its radius given at each point; the ends are left open. */
export function tube(buf: FleetBuf, path: V3[], radius: number[], sides: number, c: RGB, rig: Rig = PLAIN): void {
  const n = path.length;
  const base = buf.count;
  let ux = 0;
  let uy = 0;
  let uz = 1;
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    let tz = b[2] - a[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    // a reference square to the tangent, carried along the path so that the spar does not twist
    if (i === 0 && Math.abs(tz) > 0.95) {
      ux = 1;
      uz = 0;
    }
    const d = ux * tx + uy * ty + uz * tz;
    ux -= tx * d;
    uy -= ty * d;
    uz -= tz * d;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const vx = ty * uz - tz * uy;
    const vy = tz * ux - tx * uz;
    const vz = tx * uy - ty * ux;
    for (let j = 0; j <= sides; j++) {
      const an = (j / sides) * Math.PI * 2;
      const cs = Math.cos(an);
      const sn = Math.sin(an);
      const nx = ux * cs + vx * sn;
      const ny = uy * cs + vy * sn;
      const nz = uz * cs + vz * sn;
      buf.v([path[i][0] + nx * radius[i], path[i][1] + ny * radius[i], path[i][2] + nz * radius[i]], [nx, ny, nz], c, rig);
    }
  }
  const row = sides + 1;
  for (let i = 0; i + 1 < n; i++) {
    for (let j = 0; j < sides; j++) {
      const a = base + i * row + j;
      const b = a + 1;
      const cc = a + row;
      const dd = cc + 1;
      buf.idx.push(a, b, cc, b, dd, cc);
    }
  }
}

/** A lamp: a small disc that faces the eye, brightest in the middle. */
export function lamp(buf: FleetBuf, p: V3, r: number, c: RGB, k = 1): void {
  const n: V3 = [0, 1, 0];
  const centre = buf.v(p, n, scaled(c, k), [KIND.lamp, 0, 0, r]);
  const dim = scaled(c, k * 0.3);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    buf.v(p, n, dim, [KIND.lamp, Math.cos(a), Math.sin(a), r]);
  }
  for (let i = 0; i < 6; i++) buf.tri(centre, centre + 1 + i, centre + 1 + ((i + 1) % 6));
}

/** Someone on deck, `h` m tall, seen from no nearer than a stone's throw: a body in the colour of a shirt and a head. */
export function figure(buf: FleetBuf, x: number, y: number, z: number, h: number, shirt: RGB, skin: RGB, turn: number): void {
  const prism = (y0: number, y1: number, r0: number, r1: number, c: RGB): void => {
    for (let i = 0; i < 3; i++) {
      const a0 = turn + (i / 3) * Math.PI * 2;
      const a1 = turn + ((i + 1) / 3) * Math.PI * 2;
      buf.quad(
        [x + Math.cos(a1) * r0, y0, z + Math.sin(a1) * r0],
        [x + Math.cos(a0) * r0, y0, z + Math.sin(a0) * r0],
        [x + Math.cos(a0) * r1, y1, z + Math.sin(a0) * r1],
        [x + Math.cos(a1) * r1, y1, z + Math.sin(a1) * r1],
        c,
      );
    }
  };
  prism(y, y + h * 0.8, 0.3, 0.2, shirt);
  prism(y + h * 0.8, y + h, 0.16, 0.13, skin);
}

// ── the material ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Radiance of a lamp at night per unit of its colour (the water's image of it is drawn from the same number), and the least a lamp is drawn at (radians of the view: about a pixel). */
export const LAMP_RADIANCE = 7;
const LAMP = LAMP_RADIANCE;
const LAMP_MIN_ANGLE = 0.0012;
/** A lit window or a line of light, a sail's own light and the light under the great ship (by day and at night). */
const WINDOW = 1.5;
const SAIL_GLOW = 0.085;
const LIFT_DAY = 2.4;
const LIFT_NIGHT = 1.3;

export interface FleetMats {
  /** The boats: instanced, double sided. */
  boats: THREE.MeshStandardMaterial;
  /** The great ship: one mesh, its outside only. */
  ship: THREE.MeshStandardMaterial;
  /** What they read (`uFleet`): the lamps' level (0 by day .. 1), the clock (s), the sails' own light, the lift light. */
  shared: { value: THREE.Vector4 };
}

/** How much of the night's light is on at a darkness: riding lights come on at dusk, well before the sky is black. */
function lampLevel(darkness: number): number {
  const t = Math.min(1, Math.max(0, (darkness - 0.1) / 0.36));
  return t * t * (3 - 2 * t);
}

function fleetMaterial(shared: { value: THREE.Vector4 }, boats: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: boats ? 0.42 : 0.5, metalness: 0, envMapIntensity: 0.9, side: boats ? THREE.DoubleSide : THREE.FrontSide });
  m.name = boats ? 'fleetBoats' : 'fleetShip';
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uFleet = shared;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform vec4 uFleet; // the lamps' level (0 by day .. 1), the clock (s), the sails' own light, the lift light
attribute vec4 aRig;
varying vec4 vFleetGlow; // a vertex's own light, and what the vertex is
varying float vFleetRough;
varying vec3 vFleetSail; // on a membrane: from the luff to the leech, the height in battens, 1
#ifdef USE_INSTANCING
attribute vec4 aBoat; // phase, how far it rolls (rad; below 0: under way, it does not swing), the sails' trim (rad), how far they are furled
attribute vec3 aTintA; // the sails' colour
attribute vec3 aTintB; // the hull's
#endif`,
      )
      .replace(
        '#include <color_vertex>',
        /* glsl */ `#include <color_vertex>
	float fKind = aRig.x;
	bool fSail = fKind > 0.5 && fKind < 1.5;
	bool fLamp = fKind > 1.5 && fKind < 2.5;
	vec3 fGlow = vec3(0.0);
	vFleetRough = 0.0;
	vFleetSail = vec3(0.0);
	if (fSail) {
		if (aRig.w < 0.5) {
			// paler toward the head, a pale line down the luff, a shade deeper toward the leech
			// (the great ship's own sails: its hull's colour with a little gold in it)
			vec3 fTint = vec3(0.96, 0.89, 0.74);
#ifdef USE_INSTANCING
			fTint = aTintA;
#endif
			vColor.rgb = mix(fTint, vec3(1.0), 0.03 + 0.4 * color.g * color.g + 0.25 * max(0.0, 1.0 - color.r * 5.0)) * (1.0 - 0.07 * color.r);
			vFleetSail = vec3(color.r, color.b * 32.0, 1.0);
			fGlow = vColor.rgb * uFleet.z;
		}
		vFleetRough = 0.6;
	} else if (fLamp) {
		fGlow = color * (uFleet.x * ${LAMP.toFixed(1)});
		vColor.rgb = vec3(0.0);
	} else if (fKind > 2.5) {
		fGlow = color * (aRig.y * uFleet.w);
	} else {
		// (below 0: glass, dark by day, and the lamp behind it is warm whatever the glass)
		fGlow = (aRig.y < 0.0 ? vec3(1.0, 0.66, 0.34) * -aRig.y : color * aRig.y) * (uFleet.x * ${WINDOW.toFixed(2)});
#ifdef USE_INSTANCING
		if (aRig.z > 0.5) vColor.rgb *= aTintB;
#endif
		vFleetRough = aRig.w;
	}`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `#include <beginnormal_vertex>
#ifdef USE_INSTANCING
	float fPh = aBoat.x * 6.2831853;
	float fT = uFleet.y;
	float fTrim = aBoat.z;
	// the belly of a sail is to leeward; head to wind there is none, and the membrane only breathes
	float fBelly = clamp(fTrim * 5.0 + 0.2 * sin(fT * 1.7 + fPh * 5.0 + position.y * 0.3), -1.0, 1.0);
	float fTc = cos(fTrim);
	float fTs = sin(fTrim);
	if (fSail) {
		objectNormal = normalize(vec3(objectNormal.xy * fBelly, objectNormal.z));
		objectNormal.xz = vec2(objectNormal.x * fTc + objectNormal.z * fTs, objectNormal.z * fTc - objectNormal.x * fTs);
	}
	// a boat at anchor swings a little about its cable
	float fSwing = aBoat.y > 0.0 ? 0.07 * sin(fT * 0.19 + fPh * 3.0) + 0.03 * sin(fT * 0.43 + fPh * 7.0) : 0.0;
	float fSc = cos(fSwing);
	float fSs = sin(fSwing);
	objectNormal.xz = vec2(objectNormal.x * fSc + objectNormal.z * fSs, objectNormal.z * fSc - objectNormal.x * fSs);
#endif`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
#ifdef USE_INSTANCING
	if (fSail) {
		float fKeep = 1.0 - aBoat.w;
		float fP = aRig.y * fKeep;
		float fQ = aRig.z * fKeep * fBelly;
		transformed.x += fTs * fQ - fTc * fP;
		transformed.z += fTs * fP + fTc * fQ;
	}
	transformed.xz = vec2(transformed.x * fSc + transformed.z * fSs, transformed.z * fSc - transformed.x * fSs);
	// it rides the water: roll, pitch and heave, small angles
	float fAmp = abs(aBoat.y);
	float fRoll = fAmp * (sin(fT * 0.83 + fPh) + 0.45 * sin(fT * 1.37 + fPh * 2.3));
	float fPitch = fAmp * 0.4 * sin(fT * 0.67 + fPh * 1.7);
	float fY = transformed.y;
	transformed.y += transformed.z * fRoll + transformed.x * fPitch + fAmp * 1.5 * sin(fT * 0.74 + fPh * 4.1);
	transformed.z -= fY * fRoll;
	transformed.x -= fY * fPitch;
#endif`,
      )
      .replace(
        '#include <project_vertex>',
        /* glsl */ `#include <project_vertex>
	if (fLamp) {
		// a disc that faces the eye, never smaller than a pixel or so, and fainter by as much as it is drawn larger
		float fR = aRig.w;
#ifdef USE_INSTANCING
		fR *= length(instanceMatrix[0].xyz);
#endif
		float fSize = max(fR, -mvPosition.z * ${LAMP_MIN_ANGLE.toFixed(4)});
		// (a lamp that is off is not there)
		mvPosition.xy += aRig.yz * (fSize * step(0.004, uFleet.x));
		gl_Position = projectionMatrix * mvPosition;
		fGlow *= (fR * fR) / (fSize * fSize);
	}
	vFleetGlow = vec4(fGlow, fKind);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vFleetGlow;\nvarying float vFleetRough;\nvarying vec3 vFleetSail;')
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
	if (vFleetSail.z > 0.5) {
		// the veins of the leaf: battens that climb a little from the luff to the leech, gone where they would be finer than a pixel
		float fV = vFleetSail.y - vFleetSail.x * 0.55;
		float fW = fwidth(fV);
		float fVein = (1.0 - smoothstep(0.03, 0.03 + 1.5 * fW, abs(fract(fV) - 0.5))) * (1.0 - smoothstep(0.12, 0.4, fW));
		diffuseColor.rgb *= 1.0 - 0.13 * fVein;
	}`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\tif (vFleetRough > 0.0) roughnessFactor = vFleetRough;')
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
#if NUM_DIR_LIGHTS > 0
	if (vFleetGlow.a > 0.5 && vFleetGlow.a < 1.5 && dot(normal, directionalLights[0].direction) < 0.0) {
		// the sun is behind the membrane and comes through it: a little less of it, and deeper in colour
		normal = -normal;
		diffuseColor.rgb *= 0.4 + 0.5 * diffuseColor.rgb;
	}
#endif`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vFleetGlow.rgb;');
  };
  m.customProgramCacheKey = () => 'xr-fleet-v1';
  // (a composite hull and a membrane look the same wet or dry)
  m.userData.noWet = true;
  return m;
}

export function makeFleetMats(ctx: Ctx): FleetMats {
  const shared = { value: new THREE.Vector4(0, 0, 0, LIFT_DAY) };
  const boats = fleetMaterial(shared, true);
  const ship = fleetMaterial(shared, false);
  ctx.disposables.push(boats, ship);
  ctx.updaters.push((dt) => {
    // (kept small: the shader takes sines of it)
    shared.value.y = (shared.value.y + dt) % 7200;
  });
  ctx.envListeners.push((env: EnvironmentState) => {
    const k = lampLevel(env.darkness);
    shared.value.x = k;
    shared.value.z = SAIL_GLOW * k;
    shared.value.w = LIFT_DAY + (LIFT_NIGHT - LIFT_DAY) * k;
  });
  return { boats, ship, shared };
}
