/**
 * The kit of the hover builders (see hover.ts): the materials, a vertex buffer that carries a light per vertex, and the helpers that
 * fill it.
 *
 * Everything solid that hovers (the terraces' hulls and canopies, the drones) is one material in two programs (plain and instanced):
 * a white composite whose colour is in its vertices, and whose light is in them too (`aGlow`): a vertex shines by its own colour
 * times one of two levels the environment sets. That is how a hull carries its ring of light, its lines and the wash of its canopy
 * without a mesh, a material or a draw call of their own.
 */
import * as THREE from 'three';
import type { EnvironmentState } from '../../core/contracts';
import type { Ctx } from './ctx';

/** Linear RGB. */
export type RGB = readonly [number, number, number];

export function lin(hex: number): RGB {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/** What a vertex's light follows (`aGlow.w`). */
export const GLOW = {
  /** The light that holds a thing up: lit by day too (it shows in the hull's own shade), a little lower after dark. */
  lift: 0,
  /** Lights that come up with the darkness. */
  night: 1,
  /** A drone's second lamp: a slow pulse after dark; on a marshal drone an amber beacon, by day too. */
  lamp: 2,
} as const;

/** Radiance of the lift light per unit of its colour: by day (the exposure is a third of the night's) and at night. */
const LIFT_DAY = 1.7;
const LIFT_NIGHT = 1.25;
/** A marshal drone's beacon, by day and at night. */
const BEACON_DAY = 9;
const BEACON_NIGHT = 5;
/** The light a hull throws on the ground under it at night, where the pool is brightest (per unit of colour). */
const POOL_NIGHT = 0.05;
/** The least a lamp is drawn at (radians of the view), so that a point of light never falls between the pixels. */
const LAMP_MIN_ANGLE = 0.0011;

export class HoverBuf {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  glow: number[] = [];
  bill: number[] = [];
  idx: number[] = [];
  count = 0;

  /** A vertex: its colour, and its light (a colour and what it follows) if it has one. */
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: RGB, g: RGB | null = null, mode = 0, k = 1): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.col.push(c[0], c[1], c[2]);
    if (g) this.glow.push(g[0] * k, g[1] * k, g[2] * k, mode);
    else this.glow.push(0, 0, 0, 0);
    this.bill.push(0, 0, 0);
    return this.count++;
  }
  /** The last vertex is a corner of a lamp: a disc that faces the eye, `r` m in radius, round the vertex's own position. */
  lamp(cx: number, cy: number, r: number): void {
    const i = this.bill.length - 3;
    this.bill[i] = cx;
    this.bill[i + 1] = cy;
    this.bill[i + 2] = r;
  }
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }
  /** A quad wound so that it faces (nx, ny, nz). */
  fquad(a: number, b: number, c: number, d: number, nx: number, ny: number, nz: number): void {
    const P = this.pos;
    const ux = P[b * 3] - P[a * 3];
    const uy = P[b * 3 + 1] - P[a * 3 + 1];
    const uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[d * 3] - P[a * 3];
    const vy = P[d * 3 + 1] - P[a * 3 + 1];
    const vz = P[d * 3 + 2] - P[a * 3 + 2];
    const gx = uy * vz - uz * vy;
    const gy = uz * vx - ux * vz;
    const gz = ux * vy - uy * vx;
    if (gx * nx + gy * ny + gz * nz >= 0) this.quad(a, b, c, d);
    else this.quad(a, d, c, b);
  }
  get empty(): boolean {
    return this.idx.length === 0;
  }
  get triangles(): number {
    return this.idx.length / 3;
  }
  build(lamps = false): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glow, 4));
    if (lamps) g.setAttribute('aBill', new THREE.Float32BufferAttribute(this.bill, 3));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** What a node of a surface is: where, its colour, its light. */
export interface Node {
  x: number;
  y: number;
  z: number;
  c: RGB;
  g: RGB | null;
  mode: number;
  k: number;
}

/**
 * A smooth surface over a grid of nodes: `at(i, j, node)` for i = 0 .. ni (i = ni is i = 0 again when `closed`) and j = 0 .. nj.
 * The normals are the mean of the faces round a node (a row of nodes that fall on one point, a pole, shares one normal), and the
 * surface faces the way `facing` says on the whole: along a direction, or away from (toward, with `inward`) an upright axis.
 */
export type Facing = RGB | { cx: number; cz: number; inward?: boolean };

export function surface(buf: HoverBuf, ni: number, nj: number, closed: boolean, facing: Facing, at: (i: number, j: number, node: Node) => void): void {
  const axis = Array.isArray(facing) ? null : (facing as { cx: number; cz: number; inward?: boolean });
  const ref: RGB = axis ? [0, 0, 0] : (facing as RGB);
  const cols = closed ? ni : ni + 1;
  const rows = nj + 1;
  const n = cols * rows;
  const P = new Float64Array(n * 3);
  const Nn = new Float64Array(n * 3);
  const nodes: Node[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const node: Node = { x: 0, y: 0, z: 0, c: [1, 1, 1], g: null, mode: 0, k: 1 };
      at(i, j, node);
      nodes.push(node);
      const o = (j * cols + i) * 3;
      P[o] = node.x;
      P[o + 1] = node.y;
      P[o + 2] = node.z;
    }
  }
  const id = (i: number, j: number): number => j * cols + (i % cols);
  let toward = 0;
  const quads: number[] = [];
  for (let j = 0; j < nj; j++) {
    for (let i = 0; i < ni; i++) {
      const a = id(i, j);
      const b = id(i + 1, j);
      const c = id(i + 1, j + 1);
      const d = id(i, j + 1);
      quads.push(a, b, c, d);
      // the face's normal by its diagonals (it holds for a quad with two corners on one point)
      const ux = P[c * 3] - P[a * 3];
      const uy = P[c * 3 + 1] - P[a * 3 + 1];
      const uz = P[c * 3 + 2] - P[a * 3 + 2];
      const vx = P[d * 3] - P[b * 3];
      const vy = P[d * 3 + 1] - P[b * 3 + 1];
      const vz = P[d * 3 + 2] - P[b * 3 + 2];
      const gx = uy * vz - uz * vy;
      const gy = uz * vx - ux * vz;
      const gz = ux * vy - uy * vx;
      if (axis) toward += (gx * ((P[a * 3] + P[c * 3]) / 2 - axis.cx) + gz * ((P[a * 3 + 2] + P[c * 3 + 2]) / 2 - axis.cz)) * (axis.inward ? -1 : 1);
      else toward += gx * ref[0] + gy * ref[1] + gz * ref[2];
      for (const q of [a, b, c, d]) {
        Nn[q * 3] += gx;
        Nn[q * 3 + 1] += gy;
        Nn[q * 3 + 2] += gz;
      }
    }
  }
  // a pole: the nodes of a row on one point
  for (let j = 0; j < rows; j++) {
    let pole = true;
    for (let i = 1; i < cols && pole; i++) {
      const a = (j * cols) * 3;
      const b = (j * cols + i) * 3;
      if (Math.abs(P[a] - P[b]) + Math.abs(P[a + 1] - P[b + 1]) + Math.abs(P[a + 2] - P[b + 2]) > 1e-6) pole = false;
    }
    if (!pole) continue;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let i = 0; i < cols; i++) {
      const o = (j * cols + i) * 3;
      sx += Nn[o];
      sy += Nn[o + 1];
      sz += Nn[o + 2];
    }
    for (let i = 0; i < cols; i++) {
      const o = (j * cols + i) * 3;
      Nn[o] = sx;
      Nn[o + 1] = sy;
      Nn[o + 2] = sz;
    }
  }
  const sign = toward >= 0 ? 1 : -1;
  const base = buf.count;
  for (let q = 0; q < n; q++) {
    const l = Math.hypot(Nn[q * 3], Nn[q * 3 + 1], Nn[q * 3 + 2]) || 1;
    const node = nodes[q];
    buf.v(P[q * 3], P[q * 3 + 1], P[q * 3 + 2], (sign * Nn[q * 3]) / l, (sign * Nn[q * 3 + 1]) / l, (sign * Nn[q * 3 + 2]) / l, node.c, node.g, node.mode, node.k);
  }
  for (let q = 0; q < quads.length; q += 4) {
    const a = base + quads[q];
    const b = base + quads[q + 1];
    const c = base + quads[q + 2];
    const d = base + quads[q + 3];
    if (sign > 0) buf.quad(a, b, c, d);
    else buf.quad(a, d, c, b);
  }
}

export interface HoverMats {
  /** The hulls and canopies. */
  solid: THREE.MeshStandardMaterial;
  /** The drones: the same material for instances that turn and bob, with lamps that face the eye. */
  drone: THREE.MeshStandardMaterial;
  crowd: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  /** The light on the ground under a hull: an additive sheet, its colour in the vertices. */
  pool: THREE.MeshBasicMaterial;
}

function solidMaterial(shared: { value: THREE.Vector4 }, drone: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.44, metalness: 0, vertexColors: true, envMapIntensity: 0.85 });
  m.name = drone ? 'hoverDrone' : 'hoverSolid';
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uHover = shared;
    let vs = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>\nuniform vec4 uHover;\nattribute vec4 aGlow;\nvarying vec3 vGlow;${drone ? '\nattribute vec4 aDrone;\nattribute vec3 aBill;' : ''}`,
    );
    if (drone) {
      // a drone turns about its own axis to look at nothing in particular, and rides the air: all of it from one clock and the
      // instance's own numbers (aDrone: phase, how fast it turns, how far it bobs (m), 1 = a marshal's)
      vs = vs
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
	float xrPh = aDrone.x * 6.2831853;
	float xrYaw = 1.1 * sin(uHover.z * aDrone.y + xrPh) + 0.8 * sin(uHover.z * aDrone.y * 0.37 + xrPh * 1.7);
	float xrC = cos(xrYaw);
	float xrS = sin(xrYaw);
	objectNormal.xz = vec2(xrC * objectNormal.x + xrS * objectNormal.z, xrC * objectNormal.z - xrS * objectNormal.x);`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
	transformed.xz = vec2(xrC * transformed.x + xrS * transformed.z, xrC * transformed.z - xrS * transformed.x);
	transformed.y += aDrone.z * (sin(uHover.z * 0.83 + xrPh * 3.0) + 0.45 * sin(uHover.z * 0.31 + xrPh));
	transformed.x += aDrone.z * 0.7 * sin(uHover.z * 0.23 + xrPh * 5.0);
	transformed.z += aDrone.z * 0.7 * sin(uHover.z * 0.19 + xrPh * 7.0);
	vec3 xrCol = aGlow.rgb;
	float xrLv = aGlow.a < 0.5 ? uHover.x : uHover.y;
	if (aGlow.a > 1.5) {
		if (aDrone.w > 0.5) {
			// the beacon: two flashes and a rest
			float f = fract(uHover.z * 0.8 + aDrone.x);
			xrCol = vec3(1.0, 0.52, 0.06);
			xrLv = uHover.w * max(1.0 - smoothstep(0.0, 0.09, abs(f - 0.1)), 1.0 - smoothstep(0.0, 0.09, abs(f - 0.34)));
		} else {
			xrLv *= 0.1 + 0.9 * pow(0.5 + 0.5 * sin(uHover.z * 1.6 + xrPh * 9.0), 6.0);
		}
	}
	vGlow = xrCol * xrLv;`,
        )
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
	if (aBill.z > 0.0) {
		// a lamp: a small disc that faces the eye, never smaller than a pixel or so, and fainter by as much as it is drawn larger
		float xrR = aBill.z * length(instanceMatrix[0].xyz);
		float xrSize = max(xrR, -mvPosition.z * ${LAMP_MIN_ANGLE.toFixed(4)});
		// (a lamp that is off is not there)
		mvPosition.xy += aBill.xy * (xrSize * step(0.002, xrLv));
		gl_Position = projectionMatrix * mvPosition;
		vGlow *= (xrR * xrR) / (xrSize * xrSize);
	}`,
        );
    } else {
      vs = vs.replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvGlow = aGlow.rgb * (aGlow.a < 0.5 ? uHover.x : uHover.y);');
    }
    shader.vertexShader = vs;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance = vGlow;');
  };
  m.customProgramCacheKey = () => (drone ? 'xr-hover-drone-v1' : 'xr-hover-solid-v1');
  // (a composite hull looks the same wet or dry)
  m.userData.noWet = true;
  return m;
}

export function makeHoverMats(ctx: Ctx, crowdTex: THREE.Texture): HoverMats {
  // x: the lift light's level, y: the night lights' level (0 by day .. 1), z: the clock (s), w: the beacons' level
  const shared = { value: new THREE.Vector4(LIFT_DAY, 0, 0, BEACON_DAY) };
  const solid = solidMaterial(shared, false);
  const drone = solidMaterial(shared, true);
  // the spectators: the stands' own crowd, with a little light of its own after dark (the canopy's)
  const crowd = new THREE.MeshStandardMaterial({ map: crowdTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.95, metalness: 0, vertexColors: true, emissive: 0xffeedd, emissiveMap: crowdTex, emissiveIntensity: 0 });
  crowd.name = 'hoverCrowd';
  crowd.userData.noWet = true;
  const glass = new THREE.MeshStandardMaterial({ color: 0xcfe6ee, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.24, side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1.5 });
  glass.name = 'hoverGlass';
  glass.userData.noWet = true;
  const pool = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  pool.name = 'hoverPool';
  // additive colour, but keep the destination alpha: the wet-road shader stores its reflection flag there
  pool.blending = THREE.CustomBlending;
  pool.blendEquation = THREE.AddEquation;
  pool.blendSrc = THREE.OneFactor;
  pool.blendDst = THREE.OneFactor;
  pool.blendSrcAlpha = THREE.ZeroFactor;
  pool.blendDstAlpha = THREE.OneFactor;
  pool.color.setScalar(0);
  ctx.disposables.push(solid, drone, crowd, glass, pool);
  ctx.nightGlow.push({ mat: crowd, day: 0, night: 0.16 });
  ctx.updaters.push((dt) => {
    shared.value.z += dt;
  });
  ctx.envListeners.push((env: EnvironmentState) => {
    // the same switch as the neon kit's tubes (buildScene's nightGlow)
    const k = Math.min(1, Math.max(0, (env.darkness - 0.15) / 0.7));
    shared.value.x = LIFT_DAY + (LIFT_NIGHT - LIFT_DAY) * k;
    shared.value.y = k;
    shared.value.w = BEACON_DAY + (BEACON_NIGHT - BEACON_DAY) * k;
    // the light on the ground comes up later than the lights do (at dusk the ground is still lit by the sky), and less on a wet one
    pool.color.setScalar(POOL_NIGHT * k * k * (1 - 0.45 * Math.min(1, env.wetness * 2)));
  });
  return { solid, drone, crowd, glass, pool };
}
