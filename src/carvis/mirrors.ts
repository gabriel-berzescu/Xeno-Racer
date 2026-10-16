/**
 * The live mirrors of the player's car (main thread): the glass the render system draws the road behind into, the
 * rear-view mirror in the cabin (housing and stalk), the prototype's dash display and the rear camera. The door-mirror
 * housings and their glass faces are part of the body mesh (mirrorParts.ts); here the live glass sits a millimetre in
 * front of those faces, and only in the cockpit view.
 *
 * The glass meshes carry a plain dark placeholder material: the render system (src/render/mirrors.ts) owns the glass
 * shader and swaps it in when the car's mirrors are attached, so the car can be built (and shown in the sandboxes)
 * without it. Everything here is static relative to the car, so the matrices are set once.
 */
import {
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { CarMirrorGlass, CarMirrors, CarVisualSpec } from '../core/contracts';
import { glassOutline, mirrorLayout, type MirrorPose, type V3 } from './mirrorLayout';
import { GLASS_INSET, inGlassFrame } from './mirrorParts';

export interface MirrorRig {
  /** Housings and glass: add to the player's (LOD0) group. */
  group: Group;
  /** What the render system sees. */
  api: CarMirrors;
  /** Show or hide the live glass (the cockpit view). */
  setCockpit(on: boolean): void;
  dispose(): void;
}

const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();

function basis(m: MirrorPose, out: Matrix4, offset = 0): Matrix4 {
  _x.set(...m.right);
  _y.set(...m.up);
  _z.set(...m.normal);
  out.makeBasis(_x, _y, _z);
  const p = inGlassFrame(m, 0, 0, offset);
  out.setPosition(p[0], p[1], p[2]);
  return out;
}

/** The glass face as a mesh outline: a fan around its centre, UV 0..1 over the bounding box, facing +Z. */
function glassGeometry(halfW: number, halfH: number): BufferGeometry {
  const ring = glassOutline(halfW, halfH, 28, 3.4);
  const n = ring.length;
  const pos = new Float32Array((n + 1) * 3);
  const uv = new Float32Array((n + 1) * 2);
  const nor = new Float32Array((n + 1) * 3);
  uv[0] = 0.5;
  uv[1] = 0.5;
  nor[2] = 1;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = ring[i];
    pos[(i + 1) * 3] = x;
    pos[(i + 1) * 3 + 1] = y;
    uv[(i + 1) * 2] = x / (2 * halfW) + 0.5;
    uv[(i + 1) * 2 + 1] = y / (2 * halfH) + 0.5;
    nor[(i + 1) * 3 + 2] = 1;
    idx.push(0, 1 + i, 1 + ((i + 1) % n));
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

const AX_Y = new Vector3(0, 1, 0);

/** A cylinder between two body-frame points. */
function rod(a: V3, b: V3, radius: number, mat: MeshStandardMaterial): Mesh {
  const va = new Vector3(...a);
  const vb = new Vector3(...b);
  const len = va.distanceTo(vb);
  const m = new Mesh(new CylinderGeometry(radius, radius * 1.15, len, 10, 1), mat);
  m.position.copy(va).add(vb).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(AX_Y, vb.sub(va).normalize());
  m.castShadow = false;
  return m;
}

export function createMirrorRig(spec: CarVisualSpec): MirrorRig {
  const L = mirrorLayout(spec);
  const group = new Group();
  group.name = 'mirrors';
  const disposables: Array<{ dispose(): void }> = [];
  const glass: CarMirrorGlass[] = [];
  const glassMeshes: Mesh[] = [];

  // dark, glossy fallback until the render system swaps in the glass shader
  const placeholder = new MeshBasicMaterial({ color: 0x06080b });
  const plastic = new MeshStandardMaterial({ color: 0x0a0b0d, roughness: 0.5, metalness: 0.1 });
  disposables.push(placeholder, plastic);

  const addGlass = (m: MirrorPose, kind: 'reflect' | 'camera', name: string): void => {
    const hw = m.halfW * GLASS_INSET;
    const hh = m.halfH * GLASS_INSET;
    const geo = glassGeometry(hw, hh);
    disposables.push(geo);
    const mesh = new Mesh(geo, placeholder);
    mesh.name = 'mirror.' + name;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(basis(m, new Matrix4(), 0.0022));
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = false;
    mesh.renderOrder = 3;
    group.add(mesh);
    glassMeshes.push(mesh);
    glass.push({ kind, mesh, halfW: hw, halfH: hh, convex: m.convex, convexY: m.convexY });
  };

  addGlass(L.left, 'reflect', 'left');
  addGlass(L.right, 'reflect', 'right');

  if (L.interior) {
    const m = L.interior;
    addGlass(m, 'reflect', 'interior');
    // housing: a slim rounded box behind the glass, on a ball joint and a stalk up to the windscreen header
    const box = new Mesh(new RoundedBoxGeometry(2 * m.halfW + 0.016, 2 * m.halfH + 0.016, 0.02, 4, 0.009), plastic);
    disposables.push(box.geometry);
    box.matrixAutoUpdate = false;
    box.matrix.copy(basis(m, new Matrix4(), -0.0105));
    box.castShadow = false;
    group.add(box);
    const top = inGlassFrame(m, m.halfW * 0.1, m.halfH + 0.006, -0.016);
    const mount: V3 = [top[0], top[1] + 0.045, top[2] + 0.025];
    const stalk = rod(top, mount, 0.0075, plastic);
    disposables.push(stalk.geometry);
    group.add(stalk);
    const ball = new Mesh(new SphereGeometry(0.0115, 14, 10), plastic);
    ball.position.set(...top);
    disposables.push(ball.geometry);
    group.add(ball);
  }

  if (L.screen) {
    const m = L.screen;
    addGlass(m, 'camera', 'screen');
    const box = new Mesh(new RoundedBoxGeometry(2 * m.halfW + 0.026, 2 * m.halfH + 0.026, 0.03, 3, 0.008), plastic);
    disposables.push(box.geometry);
    box.matrixAutoUpdate = false;
    box.matrix.copy(basis(m, new Matrix4(), -0.0165));
    box.castShadow = false;
    group.add(box);
    // a short bracket down to the dash
    const foot = inGlassFrame(m, 0, -m.halfH - 0.012, -0.02);
    const bracket = rod(foot, [foot[0], foot[1] - 0.07, foot[2] + 0.01], 0.01, plastic);
    disposables.push(bracket.geometry);
    group.add(bracket);
  }

  // the rear camera: with no turn of its own it already looks out of the tail (-Z in the car's frame)
  const rearCamera = new Object3D();
  rearCamera.name = 'mirror.rearCamera';
  rearCamera.position.set(...L.rear.pos);
  rearCamera.quaternion.copy(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -L.rear.pitchDown));
  group.add(rearCamera);

  const api: CarMirrors = { glass, rearCamera, live: true, hide: [], lowDetail: { hide: [], show: [] } };
  let cockpit = false;
  return {
    group,
    api,
    setCockpit(on: boolean): void {
      cockpit = on;
      // the live glass shows in the cockpit view while the render system draws into it
      for (const m of glassMeshes) m.visible = cockpit && api.live;
    },
    dispose(): void {
      for (const d of disposables) d.dispose();
    },
  };
}
