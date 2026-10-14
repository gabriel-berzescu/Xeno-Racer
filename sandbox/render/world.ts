/**
 * Sandbox world (owner: render): a big asphalt ring and pad, grass, trees, barriers, a distant
 * mountain ring and a few tall objects. Purely procedural; stands in for the track module so the
 * render system can be judged on its own.
 */
import {
  BoxGeometry,
  CanvasTexture,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  LinearMipmapLinearFilter,
  LinearFilter,
  Vector3,
  Color,
} from 'three';
import { fbmTile } from '../../src/render/noise';

export const RING_RADIUS = 140;
export const ROAD_HALF_WIDTH = 9;
export const PAD_SIZE = 90;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function noiseTexture(size: number, fn: (u: number, v: number) => [number, number, number], srgb = true): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const [r, g, b] = fn(i / size, j / size);
      const o = (j * size + i) * 4;
      data[o] = Math.max(0, Math.min(255, r * 255));
      data[o + 1] = Math.max(0, Math.min(255, g * 255));
      data[o + 2] = Math.max(0, Math.min(255, b * 255));
      data[o + 3] = 255;
    }
  }
  const t = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function asphaltTexture(): DataTexture {
  return noiseTexture(512, (u, v) => {
    const a = fbmTile(u * 16, v * 16, 16, 4, 7);
    const b = fbmTile(u * 64, v * 64, 64, 3, 19);
    const speck = fbmTile(u * 128, v * 128, 128, 2, 31);
    const g = 0.27 + a * 0.09 + b * 0.06 + (speck > 0.72 ? 0.07 : 0);
    return [g, g * 0.99, g * 1.02];
  });
}

function grassTexture(): DataTexture {
  return noiseTexture(512, (u, v) => {
    const a = fbmTile(u * 8, v * 8, 8, 4, 3);
    const b = fbmTile(u * 64, v * 64, 64, 3, 13);
    const k = 0.5 * a + 0.5 * b;
    return [0.16 + k * 0.1, 0.27 + k * 0.17, 0.07 + k * 0.05];
  });
}

function concreteTexture(): DataTexture {
  return noiseTexture(256, (u, v) => {
    const a = fbmTile(u * 8, v * 8, 8, 4, 5);
    const g = 0.52 + a * 0.12;
    return [g, g, g * 0.97];
  });
}

export interface World {
  root: Group;
  /** Meshes that should receive a bright "tall caster" test. */
  update(dt: number): void;
}

export function buildWorld(): World {
  const root = new Group();
  root.name = 'sandbox.world';
  const rand = rng(12345);

  // ground (grass), huge
  const grassMap = grassTexture();
  grassMap.repeat.set(900, 900);
  const grass = new Mesh(new PlaneGeometry(9000, 9000), new MeshStandardMaterial({ map: grassMap, roughness: 0.95, metalness: 0 }));
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = -0.02;
  grass.receiveShadow = true;
  root.add(grass);

  // asphalt ring (as 160 trapezoid-ish boxes would be heavy; use a RingGeometry via custom shape)
  const asphaltMap = asphaltTexture();
  asphaltMap.repeat.set(1, 1);
  const asphaltMat = new MeshStandardMaterial({ map: asphaltMap, roughness: 0.62, metalness: 0, color: new Color(1, 1, 1) });
  const ringSegs = 160;
  const ringGeo = new PlaneGeometry(1, 1, ringSegs, 1);
  {
    const pos = ringGeo.attributes.position;
    const uv = ringGeo.attributes.uv;
    for (let i = 0; i <= ringSegs; i++) {
      const a = (i / ringSegs) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      for (let k = 0; k < 2; k++) {
        const idx = i + k * (ringSegs + 1);
        const r = RING_RADIUS + (k === 0 ? ROAD_HALF_WIDTH : -ROAD_HALF_WIDTH);
        pos.setXYZ(idx, c * r, 0, s * r);
        uv.setXY(idx, (i / ringSegs) * (2 * Math.PI * RING_RADIUS) / 6, k * (ROAD_HALF_WIDTH * 2) / 6);
      }
    }
    ringGeo.computeVertexNormals();
    // normals must point up
    const n = ringGeo.attributes.normal;
    for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  }
  const ring = new Mesh(ringGeo, asphaltMat);
  ring.receiveShadow = true;
  ring.frustumCulled = false;
  root.add(ring);

  // the pad (infield)
  const padMap = asphaltTexture();
  padMap.repeat.set(PAD_SIZE / 6, PAD_SIZE / 6);
  const pad = new Mesh(new PlaneGeometry(PAD_SIZE, PAD_SIZE), new MeshStandardMaterial({ map: padMap, roughness: 0.62, metalness: 0 }));
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = 0.003;
  pad.receiveShadow = true;
  root.add(pad);

  // lane markings: white edge lines + dashed centre, drawn as thin boxes
  const lineMat = new MeshStandardMaterial({ color: 0xe8e8e0, roughness: 0.7 });
  const lineGeo = new BoxGeometry(0.2, 0.01, 3);
  const dashCount = 120;
  const dashes = new InstancedMesh(lineGeo, lineMat, dashCount);
  const m = new Matrix4(), q = new Quaternion(), p = new Vector3(), sc = new Vector3(1, 1, 1);
  for (let i = 0; i < dashCount; i++) {
    const a = ((i + 0.25) / dashCount) * Math.PI * 2;
    p.set(Math.cos(a) * RING_RADIUS, 0.012, Math.sin(a) * RING_RADIUS);
    q.setFromAxisAngle(new Vector3(0, 1, 0), -a);
    m.compose(p, q, sc);
    dashes.setMatrixAt(i, m);
  }
  dashes.receiveShadow = true;
  root.add(dashes);
  for (const side of [-1, 1]) {
    const edge = new Mesh(new PlaneGeometry(1, 1, 200, 1), lineMat);
    const pos = edge.geometry.attributes.position;
    for (let i = 0; i <= 200; i++) {
      const a = (i / 200) * Math.PI * 2;
      const r1 = RING_RADIUS + side * (ROAD_HALF_WIDTH - 0.5) + 0.12;
      const r2 = RING_RADIUS + side * (ROAD_HALF_WIDTH - 0.5) - 0.12;
      pos.setXYZ(i, Math.cos(a) * r1, 0.011, Math.sin(a) * r1);
      pos.setXYZ(i + 201, Math.cos(a) * r2, 0.011, Math.sin(a) * r2);
    }
    const n = edge.geometry.attributes.position.count;
    edge.geometry.computeVertexNormals();
    const nn = edge.geometry.attributes.normal;
    for (let i = 0; i < n; i++) nn.setXYZ(i, 0, 1, 0);
    edge.frustumCulled = false;
    edge.receiveShadow = true;
    root.add(edge);
  }

  // barrier walls: concrete blocks along part of the outer edge and one wall in the pad
  const concrete = concreteTexture();
  concrete.repeat.set(1, 1);
  const wallMat = new MeshStandardMaterial({ map: concrete, roughness: 0.85 });
  const blockGeo = new BoxGeometry(3.2, 1.0, 0.6);
  const blocks = new InstancedMesh(blockGeo, wallMat, 150);
  for (let i = 0; i < 150; i++) {
    const a = (i / 150) * Math.PI * 2 * 0.62 + 0.4;
    const r = RING_RADIUS + ROAD_HALF_WIDTH + 2.2;
    p.set(Math.cos(a) * r, 0.5, Math.sin(a) * r);
    q.setFromAxisAngle(new Vector3(0, 1, 0), -a + Math.PI / 2);
    m.compose(p, q, sc);
    blocks.setMatrixAt(i, m);
  }
  blocks.castShadow = true;
  blocks.receiveShadow = true;
  root.add(blocks);
  const padWall = new Mesh(new BoxGeometry(34, 1.1, 0.7), wallMat);
  padWall.position.set(0, 0.55, -PAD_SIZE / 2 + 4);
  padWall.castShadow = true;
  padWall.receiveShadow = true;
  root.add(padWall);

  // trees
  const trunkGeo = new CylinderGeometry(0.28, 0.4, 5, 7);
  trunkGeo.translate(0, 2.5, 0);
  const canopyGeo = new IcosahedronGeometry(3.4, 1);
  canopyGeo.translate(0, 7.2, 0);
  const trunkMat = new MeshStandardMaterial({ color: 0x4b3523, roughness: 0.95 });
  const canopyMat = new MeshStandardMaterial({ color: 0x4d8a34, roughness: 0.85 });
  const treeCount = 520;
  const trunks = new InstancedMesh(trunkGeo, trunkMat, treeCount);
  const canopies = new InstancedMesh(canopyGeo, canopyMat, treeCount);
  let placed = 0;
  while (placed < treeCount) {
    const a = rand() * Math.PI * 2;
    const r = 30 + Math.pow(rand(), 0.7) * 900;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const rr = Math.hypot(x, z);
    if (Math.abs(rr - RING_RADIUS) < ROAD_HALF_WIDTH + 7) continue; // keep the road clear
    if (Math.abs(x) < PAD_SIZE / 2 + 8 && Math.abs(z) < PAD_SIZE / 2 + 8) continue;
    const s = 0.8 + rand() * 1.3;
    p.set(x, 0, z);
    q.setFromAxisAngle(new Vector3(0, 1, 0), rand() * 6.28);
    sc.set(s, s * (0.85 + rand() * 0.4), s);
    m.compose(p, q, sc);
    trunks.setMatrixAt(placed, m);
    canopies.setMatrixAt(placed, m);
    canopies.setColorAt(placed, new Color().setHSL(0.27 + rand() * 0.06, 0.45, 0.2 + rand() * 0.07));
    placed++;
  }
  sc.set(1, 1, 1);
  for (const t of [trunks, canopies]) {
    t.castShadow = true;
    t.receiveShadow = true;
    t.frustumCulled = false;
    root.add(t);
  }

  // distant mountain ring for aerial perspective
  const mountainMat = new MeshStandardMaterial({ color: 0x55604a, roughness: 1, flatShading: true });
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2 + rand() * 0.2;
    const r = 2300 + rand() * 1500;
    const h = 260 + rand() * 520;
    const cone = new Mesh(new ConeGeometry(260 + rand() * 360, h, 7 + Math.floor(rand() * 3)), mountainMat);
    cone.position.set(Math.cos(a) * r, h / 2 - 8, Math.sin(a) * r);
    cone.rotation.y = rand() * 6;
    cone.frustumCulled = false;
    root.add(cone);
  }

  // tall light poles + a grandstand block (shadow-distance tests)
  const poleGeo = new CylinderGeometry(0.2, 0.3, 24, 8);
  poleGeo.translate(0, 12, 0);
  const poleMat = new MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.5, metalness: 0.7 });
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r = RING_RADIUS - ROAD_HALF_WIDTH - 5;
    const pole = new Mesh(poleGeo, poleMat);
    pole.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    pole.castShadow = true;
    root.add(pole);
  }
  const stand = new Mesh(new BoxGeometry(70, 14, 18), new MeshStandardMaterial({ color: 0xb9b6ac, roughness: 0.8 }));
  stand.position.set(RING_RADIUS + 38, 7, 0);
  stand.castShadow = true;
  stand.receiveShadow = true;
  root.add(stand);

  // a stack of test boxes in the pad
  const boxMat = new MeshStandardMaterial({ color: 0xc23b3b, roughness: 0.6 });
  for (let i = 0; i < 4; i++) {
    const b = new Mesh(new BoxGeometry(1.6, 1.6 + i * 0.4, 1.6), boxMat);
    b.position.set(-24 + i * 2.4, 0.8 + i * 0.2, 10);
    b.castShadow = true;
    b.receiveShadow = true;
    root.add(b);
  }

  return { root, update() {} };
}

export { CanvasTexture };
