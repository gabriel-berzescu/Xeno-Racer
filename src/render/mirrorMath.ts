/**
 * The geometry of a planar mirror (owner: render). Pure maths on three.js vectors, no GL: the mirror system draws from it
 * and tests pin it.
 *
 * A mirror shows what a second eye would see from behind the glass: the viewer's eye mirrored in the glass plane. That
 * second eye looks back through the glass as through a window, so the image it sees through the window IS the mirror
 * image, with no flipping or oblique clipping needed beyond that. We build exactly that camera:
 *
 *   - it sits at the mirrored eye E' and looks along the glass normal, out of the glass's front face;
 *   - its frustum is the off-axis pyramid from E' through the glass outline (the "window"), so the render target holds the
 *     glass and nothing else, and its near plane IS the glass plane: the car's own mirror housing, the dashboard and
 *     whatever else lies behind the glass is clipped away without a clip plane (a clip plane would change every shader
 *     program);
 *   - because it faces the mirror's back, the image is horizontally flipped compared with the glass's own (u, v): the
 *     glass samples the target at (1 - u, v).
 *
 * Head movement moves E', so the picture in the glass shifts like a real mirror's. `convex` > 1 widens the window around
 * the glass by that factor while the whole target still lands on the glass, which is what a convex door mirror does: a
 * wider field of view, everything smaller. The vertical factor `convexY` can differ: a mirror is wide and short, and
 * wants more width of view than height.
 */
import { Frustum, Matrix4, PerspectiveCamera, Vector3, type Quaternion } from 'three';

export interface MirrorQuad {
  /** Glass centre and axes in world space. `normal` is the face the viewer looks at; right x up = normal. */
  center: Vector3;
  right: Vector3;
  up: Vector3;
  normal: Vector3;
  /** Half the glass width and height (m). */
  halfW: number;
  halfH: number;
}

export function makeQuad(): MirrorQuad {
  return { center: new Vector3(), right: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0), normal: new Vector3(0, 0, 1), halfW: 0.1, halfH: 0.05 };
}

/** Read a glass mesh's pose (unit-scale plane, local +Z = the face the driver sees) from its world matrix. */
export function quadFromMatrix(m: Matrix4, halfW: number, halfH: number, out: MirrorQuad): MirrorQuad {
  const e = m.elements;
  out.center.set(e[12], e[13], e[14]);
  out.right.set(e[0], e[1], e[2]).normalize();
  out.up.set(e[4], e[5], e[6]).normalize();
  out.normal.set(e[8], e[9], e[10]).normalize();
  out.halfW = halfW;
  out.halfH = halfH;
  return out;
}

/** The point mirrored in the plane through `c` with unit normal `n`. */
export function reflectPoint(p: Vector3, c: Vector3, n: Vector3, out: Vector3): Vector3 {
  const d = (p.x - c.x) * n.x + (p.y - c.y) * n.y + (p.z - c.z) * n.z;
  return out.set(p.x - 2 * d * n.x, p.y - 2 * d * n.y, p.z - 2 * d * n.z);
}

/** Distance (m) of the glass plane in front of the eye, negative when the eye is behind the glass. */
export function eyeDistance(eye: Vector3, q: MirrorQuad): number {
  return (eye.x - q.center.x) * q.normal.x + (eye.y - q.center.y) * q.normal.y + (eye.z - q.center.z) * q.normal.z;
}

export interface WindowView {
  /** The mirrored eye (world). */
  eye: Vector3;
  /** Camera axes in world space (columns of its rotation): x = -glass right, y = glass up, z = -glass normal. */
  xAxis: Vector3;
  yAxis: Vector3;
  zAxis: Vector3;
  near: number;
  far: number;
  /** Frustum extents on the near plane. */
  left: number;
  right: number;
  bottom: number;
  top: number;
}

export function makeWindowView(): WindowView {
  return {
    eye: new Vector3(),
    xAxis: new Vector3(1, 0, 0),
    yAxis: new Vector3(0, 1, 0),
    zAxis: new Vector3(0, 0, 1),
    near: 0.3,
    far: 1000,
    left: -1,
    right: 1,
    bottom: -1,
    top: 1,
  };
}

/** Nearer than this to the glass and the viewer is not looking into it (m). */
export const MIN_EYE_DISTANCE = 0.05;
/** The near plane sits this far in front of the glass plane (m): clips the housing cleanly without touching the glass itself. */
const NEAR_SLACK = 0.003;

/**
 * The mirror camera for a viewer at `eye`. False when the viewer is behind the glass or too close to it (the mirror is
 * edge-on or turned away): then there is nothing to draw.
 */
export function windowView(eye: Vector3, q: MirrorQuad, convex: number, far: number, out: WindowView, convexY = convex): boolean {
  const d = eyeDistance(eye, q);
  if (!(d > MIN_EYE_DISTANCE)) return false;
  reflectPoint(eye, q.center, q.normal, out.eye);
  out.xAxis.copy(q.right).negate();
  out.yAxis.copy(q.up);
  out.zAxis.copy(q.normal).negate();
  // glass centre in the mirrored eye's axes: depth d straight ahead, offset sideways as the real eye is offset from the glass centre
  const ex = eye.x - q.center.x;
  const ey = eye.y - q.center.y;
  const ez = eye.z - q.center.z;
  const cx = ex * q.right.x + ey * q.right.y + ez * q.right.z; // (E - C) . right = (C - E') . xAxis
  const cy = -(ex * q.up.x + ey * q.up.y + ez * q.up.z); // (C - E') . yAxis
  const kx = Math.max(convex, 0.01);
  const ky = Math.max(convexY, 0.01);
  const near = d + NEAR_SLACK;
  const s = near / d;
  out.near = near;
  out.far = Math.max(far, near + 1);
  out.left = (cx - kx * q.halfW) * s;
  out.right = (cx + kx * q.halfW) * s;
  out.bottom = (cy - ky * q.halfH) * s;
  out.top = (cy + ky * q.halfH) * s;
  return true;
}

const _m = new Matrix4();

/** Put a window view on a camera: pose, projection, matrices. The camera must not call updateProjectionMatrix afterwards. */
export function applyWindowView(cam: PerspectiveCamera, v: WindowView): void {
  cam.matrixAutoUpdate = true;
  cam.position.copy(v.eye);
  _m.makeBasis(v.xAxis, v.yAxis, v.zAxis);
  cam.quaternion.setFromRotationMatrix(_m);
  cam.near = v.near;
  cam.far = v.far;
  cam.projectionMatrix.makePerspective(v.left, v.right, v.top, v.bottom, v.near, v.far);
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  cam.updateMatrixWorld(true);
}

const _frustum = new Frustum();
const _pv = new Matrix4();
const _sphere = new Vector3();

/** Is the glass inside the camera's frustum (a bounding sphere test) and turned toward it. */
export function quadSeenBy(cam: PerspectiveCamera, q: MirrorQuad, margin = 0.02): boolean {
  _sphere.copy(cam.position);
  if (eyeDistance(_sphere, q) <= MIN_EYE_DISTANCE) return false;
  _pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_pv);
  // a sphere around the glass
  const r = Math.hypot(q.halfW, q.halfH) + margin;
  for (let i = 0; i < 6; i++) {
    const p = _frustum.planes[i];
    if (p.normal.x * q.center.x + p.normal.y * q.center.y + p.normal.z * q.center.z + p.constant < -r) return false;
  }
  return true;
}

const _p = new Vector3();

/**
 * How many pixels the glass spans on a `height` px tall view of `cam`: its width and height (the longer of its two
 * opposite edges' projections). Sizes the mirror's render target so the picture is about one texel per pixel.
 */
export function quadPixelSize(cam: PerspectiveCamera, q: MirrorQuad, height: number, out: { w: number; h: number }): { w: number; h: number } {
  const half = height * 0.5;
  // the glass corner (sx, sy) in screen pixels from the centre of the view, along x or y
  const proj = (sx: number, sy: number, axis: 'x' | 'y'): number => {
    _p.copy(q.center).addScaledVector(q.right, sx * q.halfW).addScaledVector(q.up, sy * q.halfH).applyMatrix4(cam.matrixWorldInverse);
    if (!(-_p.z > 1e-3)) return NaN;
    _p.applyMatrix4(cam.projectionMatrix);
    return axis === 'x' ? _p.x * half * cam.aspect : _p.y * half;
  };
  const wTop = Math.abs(proj(1, 1, 'x') - proj(-1, 1, 'x'));
  const wBot = Math.abs(proj(1, -1, 'x') - proj(-1, -1, 'x'));
  const hL = Math.abs(proj(-1, 1, 'y') - proj(-1, -1, 'y'));
  const hR = Math.abs(proj(1, 1, 'y') - proj(1, -1, 'y'));
  out.w = Math.max(wTop, wBot);
  out.h = Math.max(hL, hR);
  if (!(out.w > 0) || !(out.h > 0)) {
    out.w = 0;
    out.h = 0;
  }
  return out;
}

/** The render target size for a glass that spans `pxW` x `pxH` screen pixels: scaled, snapped to 8 px and kept within [min, max]. */
export function targetSize(pxW: number, pxH: number, scale: number, min: number, max: number, out: { w: number; h: number }): { w: number; h: number } {
  const snap = (v: number): number => Math.min(max, Math.max(min, Math.round((v * scale) / 8) * 8));
  out.w = snap(pxW);
  out.h = snap(pxH);
  return out;
}

/**
 * Does a target of `cur` px still suit a want of `want` px? Resizing a render target reallocates it, so it only happens
 * when the glass has clearly grown or shrunk on screen.
 */
export function sizeStillFits(cur: number, want: number): boolean {
  return cur > 0 && want <= cur * 1.35 && want >= cur * 0.7;
}

/** Which frames a mirror redraws: every `rate`-th, staggered by `slot` so mirrors on the same rate do not all fall on one frame. */
export function drawsOnFrame(frame: number, rate: number, slot: number): boolean {
  return rate <= 1 || (frame + slot) % rate === 0;
}

/** Heading helper for the HUD mirror: a camera quaternion from the car's world quaternion with the camera looking backward (car -Z). */
export function rearCameraQuaternion(carQuat: Quaternion, pitchDown: number, out: Quaternion): Quaternion {
  // The car frame faces +Z, a camera looks down its own -Z: with no extra rotation the camera already looks out of the tail.
  out.copy(carQuat);
  if (pitchDown !== 0) {
    const s = Math.sin(-pitchDown / 2);
    const c = Math.cos(-pitchDown / 2);
    // rotate about the camera's own X axis (pitch down = a negative turn about +X for a camera looking along -Z)
    const x = out.x, y = out.y, z = out.z, w = out.w;
    out.set(w * s + x * c, y * c + z * s, z * c - y * s, w * c - x * s);
  }
  return out;
}
