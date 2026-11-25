/**
 * What the built world of an orbital habitat is made with (habitat.ts and its parts: the rim works, the stalks, the settlements, the
 * viaducts): a geometry buffer, bodies of revolution on a leaning axis, tubes, and the two materials everything shares.
 *
 * `structure`: one lit material for every surface. The vertex colour is the albedo; `aSurf` carries the roughness, the metalness
 * and what the surface shows after dark (nothing, panes of glass of which a share are lit rooms, or an even glow), and `aWuv` the
 * panes' grid. By day a glazed band is pale glass in white frames; with the dark the lit panes come on, each with its own warmth.
 * Far away the panes fade to their mean (screen-space derivatives), so that a band a kilometre off is a line and not a shimmer.
 *
 * `lights`: one draw call of points for everything small that shines (lamps along a parapet, a lit door, the slow white beacons),
 * additive, at zero by day so that its program exists whatever the hour, and faded by the haze toward nothing instead of toward the
 * haze's colour.
 */
import * as THREE from 'three';
import type { Ctx } from './ctx';

export type V3 = [number, number, number];

/** What a surface is: albedo (linear), roughness, metalness and its light after dark. */
export interface Surf {
  col: V3;
  rough: number;
  metal: number;
  /** 0: none. 0..1: glazing, the share of its panes that are lit rooms after dark. 2..3: an even glow of strength (win - 2). */
  win?: number;
  seed?: number;
}

const _c = new THREE.Color();
/** An sRGB hex colour as linear rgb, times k. */
export function lin(hex: number, k = 1): V3 {
  _c.set(hex);
  return [_c.r * k, _c.g * k, _c.b * k];
}
export function surf(hex: number, rough: number, metal = 0, win = 0, seed = 0): Surf {
  return { col: lin(hex), rough, metal, win, seed };
}
/** The same surface, its albedo scaled. */
export function tone(s: Surf, k: number): Surf {
  return { ...s, col: [s.col[0] * k, s.col[1] * k, s.col[2] * k] };
}
/** The same surface with another seed (another set of lit rooms). */
export function seeded(s: Surf, seed: number): Surf {
  return { ...s, seed };
}

// ── the palette ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const PAL = {
  /** Warm white composite: the body of everything. */
  white: surf(0xe9e6dc, 0.62),
  /** The same, a shade down: plinths, undersides, the second colour of a facade. */
  shell: surf(0xd9d6cc, 0.7),
  /** Pale structure seen against the sky (masts, struts). */
  bone: surf(0xf1eee6, 0.5),
  /** Pale blue-green glass: a third of its rooms lit after dark. */
  glass: surf(0x8fb7b2, 0.16, 0.35, 0.34),
  /** Glass with most of its rooms lit: galleries, halls, lanterns. */
  glassLit: surf(0x9cc2ba, 0.16, 0.35, 0.8),
  /** Deeper glass, few rooms lit: the long bands of a stem. */
  glassDim: surf(0x7da6a6, 0.18, 0.4, 0.18),
  /** A cove of warm light (the lip of a disc, the line under a coping). */
  cove: surf(0xe6dcc4, 0.6, 0, 2.55),
  /** Brushed gold. */
  gold: surf(0xc9a35a, 0.34, 0.85),
  copper: surf(0xb87a4e, 0.4, 0.8),
  /** Living green: lawns and terraces, and the two greens of a crown of trees. */
  lawn: surf(0x5f8a3c, 0.95),
  leaf: surf(0x3f6f2c, 0.95),
  leaf2: surf(0x5b8a36, 0.95),
  /** Water held in a basin. */
  water: surf(0x4f8f96, 0.08, 0.3),
};

/** Light colours (linear; the points are additive, so these are what they add). */
export const LAMP = {
  warm: lin(0xffd9a0),
  pale: lin(0xfff1d6),
  white: lin(0xf4f7ff),
};

export function hash1(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

// ── geometry buffer ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export class HabBuf {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  sf: number[] = [];
  wuv: number[] = [];
  idx: number[] = [];
  n = 0;
  get empty(): boolean {
    return this.idx.length === 0;
  }
  get tris(): number {
    return this.idx.length / 3;
  }
  v(p: V3, n: V3, s: Surf, k = 1, u = 0, w = 0): number {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    this.col.push(s.col[0] * k, s.col[1] * k, s.col[2] * k);
    this.sf.push(s.rough, s.metal, s.win ?? 0, s.seed ?? 0);
    this.wuv.push(u, w);
    return this.n++;
  }
  /** A flat quad, counter-clockwise seen from its front (or facing `toward`, if given); `uv`: the panes' grid at its four corners. */
  quad(a: V3, b: V3, c: V3, d: V3, s: Surf, opt?: { toward?: V3; uv?: [number, number][]; k?: number[] }): void {
    const n = faceNormal(a, b, d);
    let flip = false;
    if (opt?.toward && n[0] * opt.toward[0] + n[1] * opt.toward[1] + n[2] * opt.toward[2] < 0) {
      flip = true;
      n[0] = -n[0];
      n[1] = -n[1];
      n[2] = -n[2];
    }
    const base = this.n;
    const p = [a, b, c, d];
    for (let i = 0; i < 4; i++) this.v(p[i], n, s, opt?.k?.[i] ?? 1, opt?.uv?.[i][0] ?? 0, opt?.uv?.[i][1] ?? 0);
    if (flip) this.idx.push(base, base + 3, base + 2, base, base + 2, base + 1);
    else this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  tri(a: V3, b: V3, c: V3, s: Surf, toward?: V3, k = 1): void {
    const n = faceNormal(a, b, c);
    let flip = false;
    if (toward && n[0] * toward[0] + n[1] * toward[1] + n[2] * toward[2] < 0) {
      flip = true;
      n[0] = -n[0];
      n[1] = -n[1];
      n[2] = -n[2];
    }
    const base = this.n;
    this.v(a, n, s, k);
    this.v(b, n, s, k);
    this.v(c, n, s, k);
    if (flip) this.idx.push(base, base + 2, base + 1);
    else this.idx.push(base, base + 1, base + 2);
  }
  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    geo.setAttribute('aSurf', new THREE.BufferAttribute(new Float32Array(this.sf), 4));
    geo.setAttribute('aWuv', new THREE.BufferAttribute(new Float32Array(this.wuv), 2));
    geo.setIndex(this.n > 65535 ? new THREE.BufferAttribute(new Uint32Array(this.idx), 1) : new THREE.BufferAttribute(new Uint16Array(this.idx), 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

function faceNormal(a: V3, b: V3, c: V3): V3 {
  const ax = b[0] - a[0];
  const ay = b[1] - a[1];
  const az = b[2] - a[2];
  const bx = c[0] - a[0];
  const by = c[1] - a[1];
  const bz = c[2] - a[2];
  const x = ay * bz - az * by;
  const y = az * bx - ax * bz;
  const z = ax * by - ay * bx;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

// ── frames ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** An origin and three unit vectors: `up` is the axis of whatever is built on it. */
export interface Frame {
  o: V3;
  ex: V3;
  up: V3;
  ez: V3;
  /** Whatever is built on the frame is this many times as long along ex (a shell drawn out of a dome); 1 when left out. */
  sx?: number;
}

export function frameAt(o: V3, up: V3 = [0, 1, 0], yaw = 0): Frame {
  const ul = Math.hypot(up[0], up[1], up[2]) || 1;
  const u: V3 = [up[0] / ul, up[1] / ul, up[2] / ul];
  // ex: world x made square to the axis (the axis of a ring leans in the y-z plane, so this is world x itself), then turned by yaw
  let ex: V3 = [1 - u[0] * u[0], -u[0] * u[1], -u[0] * u[2]];
  const el = Math.hypot(ex[0], ex[1], ex[2]);
  ex = el < 1e-5 ? [0, 0, 1] : [ex[0] / el, ex[1] / el, ex[2] / el];
  let ez: V3 = [ex[1] * u[2] - ex[2] * u[1], ex[2] * u[0] - ex[0] * u[2], ex[0] * u[1] - ex[1] * u[0]];
  if (yaw) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const e2: V3 = [ex[0] * c + ez[0] * s, ex[1] * c + ez[1] * s, ex[2] * c + ez[2] * s];
    ez = [-ex[0] * s + ez[0] * c, -ex[1] * s + ez[1] * c, -ex[2] * s + ez[2] * c];
    ex = e2;
  }
  return { o, ex, up: u, ez };
}

/** A point of the frame: `a` along ex, `h` along the axis, `b` along ez. */
export function at(f: Frame, a: number, h: number, b: number): V3 {
  if (f.sx) a *= f.sx;
  return [f.o[0] + f.ex[0] * a + f.up[0] * h + f.ez[0] * b, f.o[1] + f.ex[1] * a + f.up[1] * h + f.ez[1] * b, f.o[2] + f.ex[2] * a + f.up[2] * h + f.ez[2] * b];
}
export function dirOf(f: Frame, a: number, h: number, b: number): V3 {
  return [f.ex[0] * a + f.up[0] * h + f.ez[0] * b, f.ex[1] * a + f.up[1] * h + f.ez[1] * b, f.ex[2] * a + f.up[2] * h + f.ez[2] * b];
}
/** A normal of the frame: a direction, with the frame's stretch undone the way a normal needs it. */
function norOf(f: Frame, a: number, h: number, b: number): V3 {
  if (!f.sx) return dirOf(f, a, h, b);
  const n = dirOf(f, a / f.sx, h, b);
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}
/** The same frame moved to one of its own points, turned by yaw, and (if asked) stretched along its ex. */
export function moved(f: Frame, a: number, h: number, b: number, yaw = 0, sx?: number): Frame {
  const o = at(f, a, h, b);
  if (!yaw) return { o, ex: f.ex, up: f.up, ez: f.ez, sx };
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { o, up: f.up, ex: dirOf(f, c, 0, s), ez: dirOf(f, -s, 0, c), sx };
}

// ── bodies of revolution ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A point of a profile: radius and height on the axis. `s` is the surface from this point to the next one; `crease` makes the
 * shading break here (otherwise the normals of the two neighbouring stretches are blended); `k` darkens or lightens the albedo at
 * this ring (painted shade); `win`: the stretch to the next point is glazing of this many panes round and floors up.
 */
export interface LPt {
  r: number;
  h: number;
  s?: Surf;
  crease?: boolean;
  k?: number;
  win?: [number, number];
}

/**
 * A body of revolution round the frame's axis. The profile is walked with the outside on the right: up an outer wall, inward over
 * a top, outward under an overhang. `arc`: only this part of the turn ([from, to] in turns), for shells cut open.
 */
export function lathe(buf: HabBuf, f: Frame, pts: LPt[], segs: number, s0: Surf, arc?: [number, number]): void {
  const n = pts.length;
  // normals of the stretches in the (r, h) plane
  const nr: number[] = [];
  const nh: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const dr = pts[i + 1].r - pts[i].r;
    const dh = pts[i + 1].h - pts[i].h;
    const l = Math.hypot(dr, dh) || 1;
    nr.push(dh / l);
    nh.push(-dr / l);
  }
  const a0 = (arc ? arc[0] : 0) * Math.PI * 2;
  const a1 = (arc ? arc[1] : 1) * Math.PI * 2;
  const cs: number[] = [];
  const sn: number[] = [];
  for (let j = 0; j <= segs; j++) {
    const a = a0 + ((a1 - a0) * j) / segs;
    cs.push(Math.cos(a));
    sn.push(Math.sin(a));
  }
  let s = s0;
  for (let i = 0; i + 1 < n; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    if (p.s) s = p.s;
    if (Math.abs(q.r - p.r) < 1e-6 && Math.abs(q.h - p.h) < 1e-6) continue;
    // the normal at each end: this stretch's own at a crease (or where the surface changes), else blended with the neighbour's
    let r0 = nr[i];
    let h0 = nh[i];
    if (i > 0 && !p.crease && !p.s) {
      r0 += nr[i - 1];
      h0 += nh[i - 1];
    }
    let r1 = nr[i];
    let h1 = nh[i];
    if (i + 2 < n && !q.crease && !q.s) {
      r1 += nr[i + 1];
      h1 += nh[i + 1];
    }
    const l0 = Math.hypot(r0, h0) || 1;
    const l1 = Math.hypot(r1, h1) || 1;
    r0 /= l0;
    h0 /= l0;
    r1 /= l1;
    h1 /= l1;
    const base = buf.n;
    const k0 = p.k ?? 1;
    const k1 = q.k ?? 1;
    for (let j = 0; j <= segs; j++) {
      const c = cs[j];
      const z = sn[j];
      const u = p.win ? (j / segs) * p.win[0] : 0;
      buf.v(at(f, p.r * c, p.h, p.r * z), norOf(f, r0 * c, h0, r0 * z), s, k0, u, 0);
      buf.v(at(f, q.r * c, q.h, q.r * z), norOf(f, r1 * c, h1, r1 * z), s, k1, u, p.win ? p.win[1] : 0);
    }
    // the winding that faces the stretch's normal: with the outside on the right of the walk it is (lower j, upper j, lower j+1)
    for (let j = 0; j < segs; j++) {
      const a = base + j * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      if (p.r > 1e-6) buf.idx.push(a, b, c);
      if (q.r > 1e-6) buf.idx.push(b, d, c);
    }
  }
}

/** A profile's points from a function of t in 0..1 (n stretches). */
export function curve(n: number, fn: (t: number) => [number, number], more?: Partial<LPt>): LPt[] {
  const out: LPt[] = [];
  for (let i = 0; i <= n; i++) {
    const [r, h] = fn(i / n);
    out.push({ r, h, ...more });
  }
  return out;
}

/** A tube along a path (round, `sides` sides), its radius given at each point; the ends are left open. */
export function tube(buf: HabBuf, path: V3[], radius: number[], sides: number, s: Surf): void {
  const n = path.length;
  const base = buf.n;
  let ux = 0;
  let uy = 1;
  let uz = 0;
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
    // a reference square to the tangent, carried along the path so that the tube does not twist
    if (i === 0 && Math.abs(ty) > 0.95) {
      ux = 1;
      uy = 0;
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
      const c = Math.cos(an);
      const sn = Math.sin(an);
      const nx = ux * c + vx * sn;
      const ny = uy * c + vy * sn;
      const nz = uz * c + vz * sn;
      buf.v([path[i][0] + nx * radius[i], path[i][1] + ny * radius[i], path[i][2] + nz * radius[i]], [nx, ny, nz], s);
    }
  }
  const row = sides + 1;
  for (let i = 0; i + 1 < n; i++) {
    for (let j = 0; j < sides; j++) {
      const a = base + i * row + j;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      buf.idx.push(a, b, c, b, d, c);
    }
  }
}

/** A box on a frame: centre (a, h, b) in the frame, half-sizes along ex, up and ez; `top` and `bottom` faces on request. */
export function box(buf: HabBuf, f: Frame, a: number, h: number, b: number, ha: number, hh: number, hb: number, s: Surf, top = true, bottom = false): void {
  const P = (i: number, j: number, k: number): V3 => at(f, a + i * ha, h + j * hh, b + k * hb);
  buf.quad(P(1, -1, -1), P(1, -1, 1), P(1, 1, 1), P(1, 1, -1), s, { toward: f.ex });
  buf.quad(P(-1, -1, 1), P(-1, -1, -1), P(-1, 1, -1), P(-1, 1, 1), s, { toward: [-f.ex[0], -f.ex[1], -f.ex[2]] });
  buf.quad(P(1, -1, 1), P(-1, -1, 1), P(-1, 1, 1), P(1, 1, 1), s, { toward: f.ez });
  buf.quad(P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1), s, { toward: [-f.ez[0], -f.ez[1], -f.ez[2]] });
  if (top) buf.quad(P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1), s, { toward: f.up });
  if (bottom) buf.quad(P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), s, { toward: [-f.up[0], -f.up[1], -f.up[2]] });
}

/** The crown of a tree seen from far away: a lumpy green dome of a few sides, r wide and h high, standing on the frame. */
export function crown(buf: HabBuf, f: Frame, a: number, h0: number, b: number, r: number, h: number, rnd: () => number): void {
  const g = rnd();
  const s = g < 0.5 ? PAL.leaf : PAL.leaf2;
  const k = 0.75 + rnd() * 0.5;
  const fr = moved(f, a, h0, b, rnd() * 6.28);
  lathe(
    buf,
    fr,
    [
      { r: r * 0.55, h: 0, k: k * 0.55 },
      { r: r, h: h * 0.38, k: k * 0.8 },
      { r: r * 0.72, h: h * 0.8, k },
      { r: 0, h, k: k * 1.12 },
    ],
    5,
    s,
  );
}

// ── the ring ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Which way is up at world z on the floor of a ring whose lowest line is at `z0`: toward the axis (it leans back over the circuit). */
export function ringUp(radius: number, z0: number, z: number): V3 {
  const sn = Math.max(-0.9, Math.min(0.9, (z - z0) / radius));
  return [0, Math.sqrt(1 - sn * sn), -sn];
}

// ── materials ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface HabMaterials {
  structure: THREE.MeshStandardMaterial;
  lights: THREE.PointsMaterial;
}

/** How much of the night's light is on at a darkness: lamps come on at dusk, well before the sky is black. */
function lampLevel(darkness: number): number {
  const t = Math.min(1, Math.max(0, (darkness - 0.1) / 0.36));
  return t * t * (3 - 2 * t);
}

export function makeHabMaterials(ctx: Ctx): HabMaterials {
  const uNight = { value: 0 };
  const uTime = { value: 0 };

  const structure = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 1, metalness: 1, envMapIntensity: 0.9 });
  structure.name = 'habitat';
  structure.onBeforeCompile = (shader) => {
    shader.uniforms.uHabNight = uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aSurf;\nattribute vec2 aWuv;\nvarying vec4 vHabSurf;\nvarying vec2 vHabWuv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vHabSurf = aSurf;\n  vHabWuv = aWuv;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform float uHabNight;
varying vec4 vHabSurf;
varying vec2 vHabWuv;
vec3 gHabEmit;
float habHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
  gHabEmit = vec3(0.0);
  {
    float win = vHabSurf.z;
    if (win > 1.5) {
      // an even glow: a cove of warm light
      gHabEmit = vec3(1.0, 0.8, 0.52) * (win - 2.0) * uHabNight;
    } else if (win > 0.0) {
      vec2 fw = fwidth(vHabWuv);
      float lod = smoothstep(0.3, 0.9, max(fw.x, fw.y));
      vec2 cell = floor(vHabWuv);
      vec2 fr = fract(vHabWuv);
      float h = habHash(cell + vHabSurf.w * 61.7);
      // the frames between the panes (white, like the structure), as wide as a tenth of a pane and never thinner than a pixel
      vec2 e = max(vec2(0.07), fw * 0.7);
      float pane = smoothstep(0.0, e.x, fr.x) * smoothstep(0.0, e.x, 1.0 - fr.x) * smoothstep(0.0, e.y, fr.y) * smoothstep(0.0, e.y, 1.0 - fr.y);
      pane = mix(pane, 0.8, lod);
      diffuseColor.rgb = mix(vec3(0.78, 0.77, 0.72), diffuseColor.rgb * (0.82 + 0.3 * fract(h * 5.3)), pane);
      // lit rooms: a share of the panes, each with its own warmth and strength
      float lit = step(1.0 - win, h);
      vec3 warm = mix(vec3(1.0, 0.70, 0.36), vec3(1.0, 0.88, 0.66), fract(h * 9.7));
      float level = 0.55 + 0.9 * fract(h * 3.1);
      vec3 room = warm * level * lit;
      vec3 meanRoom = vec3(1.0, 0.79, 0.51) * win;
      gHabEmit = mix(room * pane, meanRoom * 0.8, lod) * uHabNight;
    }
  }`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = clamp(vHabSurf.x, 0.04, 1.0);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = clamp(vHabSurf.y, 0.0, 1.0);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += gHabEmit * 1.7;');
  };
  structure.customProgramCacheKey = () => 'habitat-structure-v1';

  const lights = new THREE.PointsMaterial({ color: 0xffffff, vertexColors: true, size: 1, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true });
  lights.name = 'habitatLights';
  lights.onBeforeCompile = (shader) => {
    shader.uniforms.uHabNight = uNight;
    shader.uniforms.uHabTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aLamp;\nuniform float uHabNight;\nuniform float uHabTime;\nvarying float vHabLamp;')
      .replace(
        'gl_PointSize = size;',
        /* glsl */ `gl_PointSize = size * aLamp.x;
  {
    // aLamp.y: below 0 a steady lamp, else the phase of a slow beacon (a breath every six seconds)
    float f = fract(uHabTime / 6.0 + aLamp.y);
    float beat = aLamp.y < 0.0 ? 1.0 : 0.12 + 0.88 * smoothstep(0.0, 0.25, f) * (1.0 - smoothstep(0.3, 0.75, f));
    vHabLamp = uHabNight * beat;
  }`,
      )
      .replace(
        '#include <fog_vertex>',
        /* glsl */ `{
    // never smaller than a pixel and a half: a lamp too far to have a size keeps its light, spread over that
    float px = gl_PointSize;
    gl_PointSize = clamp(px, 1.6, 40.0);
    vHabLamp *= min(1.0, (px * px) / (1.6 * 1.6));
  }
#include <fog_vertex>`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vHabLamp;')
      .replace('#include <map_particle_fragment>', '{ float r = length(gl_PointCoord - 0.5) * 2.0; float g = 1.0 - smoothstep(0.0, 1.0, r); diffuseColor.a *= (0.22 * g + 0.78 * g * g * g * g) * vHabLamp; }')
      .replace(
        '#include <fog_fragment>',
        /* glsl */ `#ifdef USE_FOG
  #ifdef FOG_EXP2
    gl_FragColor.rgb *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    gl_FragColor.rgb *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
  #endif
#endif`,
      );
  };
  lights.customProgramCacheKey = () => 'habitat-lights-v1';

  ctx.envListeners.push((env) => {
    uNight.value = lampLevel(env.darkness);
  });
  ctx.updaters.push((_dt, _camera, time) => {
    uTime.value = time % 3600;
  });
  ctx.disposables.push(structure, lights);
  return { structure, lights };
}

/** The small lights: positions, colours (times a strength), sizes in metres and phases, drawn as one object. */
export class HabLights {
  pos: number[] = [];
  col: number[] = [];
  lamp: number[] = [];
  /** `size`: the diameter of the glow in metres; `phase` below 0 (the default): steady, else 0..1, a slow beacon. */
  add(p: V3, c: V3, strength: number, size: number, phase = -1): void {
    this.pos.push(p[0], p[1], p[2]);
    this.col.push(c[0] * strength, c[1] * strength, c[2] * strength);
    this.lamp.push(size, phase);
  }
  get count(): number {
    return this.lamp.length / 2;
  }
  build(mat: THREE.PointsMaterial): THREE.Points | null {
    if (!this.count) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    geo.setAttribute('aLamp', new THREE.BufferAttribute(new Float32Array(this.lamp), 2));
    geo.computeBoundingSphere();
    const pts = new THREE.Points(geo, mat);
    pts.name = 'habitat_lights';
    return pts;
  }
}
