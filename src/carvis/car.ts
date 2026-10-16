/**
 * CarVisual implementation: assembles the shared geometry, per-car materials, wheels, lights and
 * animates them from VehicleState.
 *
 * Three detail levels share one set of cached geometry per (car, quality):
 *   LOD0  player / close-up : sculpted body, glass, real wheels, brakes, cabin, driver, steering wheel
 *   LOD1  AI, near          : coarser body + wheels, driver bust
 *   LOD2  AI, far           : ~5k-triangle baked-colour body + 4 dark tyres
 */
import {
  AddEquation,
  CustomBlending,
  OneFactor,
  SrcAlphaFactor,
  ZeroFactor,
  Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  LOD,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Sphere,
  SpotLight,
  Vector3,
} from 'three';
import type { CarDefinition, DamageMode, EnvironmentState, Livery, QualityLevel, VehicleState } from '../core/contracts';
import { CarDamage, ImpactObserver, MAX_DENTS, hullOf, type CarDamageControl, type DamageEvent } from '../core/damage';
import type { CarVisual } from '../core/systems';
import { VERTEX_STRIDE, type BodyData, type PartData } from './build';
import { makeDamageGeometry, partBounds } from './damageGeometry';
import { anyLampFlickers, packDamage, settleDentDepth } from './damageUniforms';
import { loadCarData } from './dataSource';
import { createInteriorMaterial } from './interiorMaterial';
import { computeLayout, wheelLook } from './layouts';
import { createMirrorRig, type MirrorRig } from './mirrors';
import { paintLivery, type LiveryTextures, type LiveryTier } from './livery';
import { acquireTireTextTexture } from './textures';
import { createBodyMaterials, createFarMaterial, type BodyMaterials } from './materials';
import { createWheelMaterial } from './wheelMaterial';

/** Tunables the render/game side may want to adjust. */
export const CARVIS_TUNING = {
  /** SpotLight intensity (candela) for the player's headlights at full darkness. */
  headlightIntensity: 120,
  headlightDistance: 110,
  headlightAngle: 0.62,
  /** darkness above which the real spotlights switch on (avoids a shader recompile every frame) */
  headlightOnDarkness: 0.3,
  /** metres from camera where AI cars swap to the far LOD */
  farLodDistance: 55,
};

interface GeoSet {
  paint0: BufferGeometry;
  glass0: BufferGeometry;
  paint1: BufferGeometry;
  glass1: BufferGeometry;
  far: BufferGeometry;
  wheel0: [BufferGeometry, BufferGeometry];
  cal0: [BufferGeometry, BufferGeometry];
  wheel1: [BufferGeometry, BufferGeometry];
  cal1: [BufferGeometry, BufferGeometry];
  cabin: BufferGeometry;
  driver: BufferGeometry;
  driverLite: BufferGeometry;
  steer: BufferGeometry;
  refs: number;
}
const geoCache = new Map<string, GeoSet>();

function attachAttrs(g: BufferGeometry, ib: InterleavedBuffer): void {
  g.setAttribute('position', new InterleavedBufferAttribute(ib, 3, 0));
  g.setAttribute('normal', new InterleavedBufferAttribute(ib, 3, 3));
  g.setAttribute('aZ0', new InterleavedBufferAttribute(ib, 4, 6));
  g.setAttribute('aZ1', new InterleavedBufferAttribute(ib, 4, 10));
  g.setAttribute('aZ2', new InterleavedBufferAttribute(ib, 4, 14));
  g.setAttribute('aZ3', new InterleavedBufferAttribute(ib, 4, 18));
}

function bodyGeos(d: BodyData): { paint: BufferGeometry; glass: BufferGeometry } {
  const ib = new InterleavedBuffer(d.vertices, VERTEX_STRIDE);
  const box = new Box3().setFromArray([...d.bounds.min, ...d.bounds.max]);
  const sphere = box.getBoundingSphere(new Sphere());
  const mk = (idx: Uint32Array): BufferGeometry => {
    const g = new BufferGeometry();
    attachAttrs(g, ib);
    g.setIndex(new BufferAttribute(idx, 1));
    g.boundingBox = box;
    g.boundingSphere = sphere;
    return g;
  };
  return { paint: mk(d.paintIndex), glass: mk(d.glassIndex) };
}

function farGeo(d: BodyData): BufferGeometry {
  const n = d.vertices.length / VERTEX_STRIDE;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = i * VERTEX_STRIDE;
    pos[i * 3] = d.vertices[o];
    pos[i * 3 + 1] = d.vertices[o + 1];
    pos[i * 3 + 2] = d.vertices[o + 2];
    nor[i * 3] = d.vertices[o + 3];
    nor[i * 3 + 1] = d.vertices[o + 4];
    nor[i * 3 + 2] = d.vertices[o + 5];
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new Float32BufferAttribute(d.colors ?? new Float32Array(n * 3).fill(1), 3));
  g.setIndex(new BufferAttribute(d.index, 1));
  const box = new Box3().setFromArray([...d.bounds.min, ...d.bounds.max]);
  g.boundingBox = box;
  g.boundingSphere = box.getBoundingSphere(new Sphere());
  return g;
}

function partGeometry(d: PartData, sphereR = 3.2): BufferGeometry {
  const ib = new InterleavedBuffer(d.vertices, VERTEX_STRIDE);
  const g = new BufferGeometry();
  attachAttrs(g, ib);
  g.setIndex(new BufferAttribute(d.index, 1));
  // instanced meshes: culling must cover every wheel position of the car (root-local), so use a generous sphere
  g.boundingSphere = new Sphere(new Vector3(0, 0.4, 0), sphereR);
  g.boundingBox = new Box3(new Vector3(-1.4, 0, -2.6), new Vector3(1.4, 1.2, 2.6));
  return g;
}

function buildGeoSet(data: Awaited<ReturnType<typeof loadCarData>>): GeoSet {
  const b0 = bodyGeos(data.lod0);
  const b1 = bodyGeos(data.lod1);
  const w0 = data.wheels0, w1 = data.wheels1;
  const dual = (a: PartData, b: PartData): [BufferGeometry, BufferGeometry] => {
    const ga = partGeometry(a);
    return [ga, a === b ? ga : partGeometry(b)];
  };
  return {
    paint0: b0.paint,
    glass0: b0.glass,
    paint1: b1.paint,
    glass1: b1.glass,
    far: farGeo(data.lod2),
    wheel0: dual(w0.front, w0.rear),
    cal0: [partGeometry(w0.caliperFront), partGeometry(w0.caliperRear)],
    wheel1: dual(w1.front, w1.rear),
    cal1: [partGeometry(w1.caliperFront), partGeometry(w1.caliperRear)],
    cabin: partGeometry(data.interior.cabin),
    driver: partGeometry(data.interior.driver),
    driverLite: partGeometry(data.interior.driverLite),
    steer: partGeometry(data.interior.wheel),
    refs: 0,
  };
}

function disposeGeoSet(s: GeoSet): void {
  const seen = new Set<BufferGeometry>();
  for (const g of [s.paint0, s.glass0, s.paint1, s.glass1, s.far, ...s.wheel0, ...s.cal0, ...s.wheel1, ...s.cal1, s.cabin, s.driver, s.driverLite, s.steer]) {
    if (seen.has(g)) continue;
    seen.add(g);
    g.dispose();
  }
}

// shared, tiny resources
let glowTex: CanvasTexture | null = null;
function groundGlowTexture(): CanvasTexture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const g = c.getContext('2d')!;
  // canvas top maps to the plane edge nearest the car: brightest at the nose, fading to nothing ahead
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, 'rgba(255,244,220,0.5)');
  grad.addColorStop(0.3, 'rgba(255,240,210,0.26)');
  grad.addColorStop(0.7, 'rgba(255,236,200,0.07)');
  grad.addColorStop(1, 'rgba(255,235,200,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 256);
  // soft lateral falloff
  g.globalCompositeOperation = 'destination-in';
  const lat = g.createLinearGradient(0, 0, 64, 0);
  lat.addColorStop(0, 'rgba(0,0,0,0)');
  lat.addColorStop(0.5, 'rgba(0,0,0,1)');
  lat.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = lat;
  g.fillRect(0, 0, 64, 256);
  glowTex = new CanvasTexture(c);
  return glowTex;
}

const AX_Y = new Vector3(0, 1, 0);
const AX_X = new Vector3(1, 0, 0);
const AX_Z = new Vector3(0, 0, 1);
const ONE = new Vector3(1, 1, 1);

export async function createCarVisual(def: CarDefinition, livery: Livery, quality: QualityLevel): Promise<CarVisual> {
  const spec = def.visual;
  const dbgCell = (globalThis as { __CARVIS_CELL__?: number }).__CARVIS_CELL__;
  const key = `${def.id}|${quality}|${dbgCell ?? ''}|${JSON.stringify(spec)}`;
  const data = await loadCarData(def.id, spec, quality, false, dbgCell);
  let gs = geoCache.get(key);
  if (!gs) {
    gs = buildGeoSet(data);
    geoCache.set(key, gs);
  }
  gs.refs++;
  const layout = computeLayout(spec);

  const root = new Group();
  root.name = `car:${def.id}`;

  // ── body materials + livery ───────────────────────────────────────────────
  const mats: BodyMaterials = createBodyMaterials();
  const U = mats.uniforms;
  const dbgMode = (globalThis as { __CARVIS_DBG__?: string }).__CARVIS_DBG__;
  U.uDbg.value = dbgMode === 'zones' ? 1 : dbgMode === 'normal' ? 2 : dbgMode === 'zebra' ? 3 : dbgMode === 'clay' ? 4 : 0;
  // AI cars (the default) paint a smaller livery atlas; setPlayer(true) upgrades it to the full quality tier
  let tier: LiveryTier = 'ai';
  let curLivery: Livery = livery;
  let textures: LiveryTextures = paintLivery(livery, layout.livery, tier);
  U.uSide.value = textures.side;
  U.uTop.value = textures.top;
  U.uEnd.value = textures.end;
  U.uRange.value.set(layout.livery.zNose, layout.livery.zTail, layout.livery.yMax, layout.livery.halfW);
  if (data.lod0.info) U.uProj.value.set(...data.lod0.info.projector);
  if (spec.style === 'prototype') {
    U.uGlassAlpha.value = 0.42;
    U.uInteriorCarbon.value = 1;
  }

  const farMat = createFarMaterial(U);
  let farBaseRough = farMat.roughness;
  let lastWet = 0;

  const interiorMat = createInteriorMaterial();
  const IU = interiorMat.uniforms;
  IU.uScreenC.value.set(...data.interior.screen);

  const applyLivery = (l: Livery): void => {
    U.uPrimary.value.set(l.primary);
    U.uSecond.value.set(l.secondary);
    U.uAccent.value.set(l.accent);
    U.uFlake.value = l.metallic ? 1 : 0;
    U.uFinish.value = l.finish;
    curLivery = l;
    textures = paintLivery(l, layout.livery, tier, textures);
    farBaseRough = 0.3 + 0.5 * l.finish;
    farMat.roughness = farBaseRough * (1 - 0.5 * lastWet);
    IU.uAccent.value.set(l.accent);
    IU.uPrimary.value.set(l.primary);
  };
  applyLivery(livery);

  const mkStatic = (g: BufferGeometry, m: Mesh['material'], shadow: boolean): Mesh => {
    const mesh = new Mesh(g, m);
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    return mesh;
  };

  // ── wheels ─────────────────────────────────────────────────────────────────
  const look = wheelLook(spec.style);
  const wheelMat = createWheelMaterial();
  const WU = wheelMat.uniforms;
  WU.uRimColor.value.setRGB(...look.rimColor);
  WU.uRimMetal.value = look.rimMetal;
  WU.uRimRough.value = look.rimRough;
  WU.uRimCC.value = look.rimCC;
  WU.uNutColor.value.setRGB(...look.nutColor);
  WU.uCaliper.value.setRGB(...look.caliper);
  WU.uSlick.value = look.slick;
  WU.uTread.value = look.tread;
  const tireText = acquireTireTextTexture(spec, look.slick > 0.5, livery.accent);
  WU.uTireText.value = tireText.tex;
  const mkInst = (g: BufferGeometry, mat: Mesh['material'], shadow: boolean): InstancedMesh => {
    const m = new InstancedMesh(g, mat, 2);
    m.instanceMatrix.setUsage(DynamicDrawUsage);
    m.setColorAt(0, new Color(0, 0, 0));
    m.setColorAt(1, new Color(0, 0, 0));
    m.instanceColor!.setUsage(DynamicDrawUsage);
    m.castShadow = shadow;
    m.receiveShadow = true;
    return m;
  };
  const wheels0 = [mkInst(gs.wheel0[0], wheelMat.material, true), mkInst(gs.wheel0[1], wheelMat.material, true)];
  const cal0 = [mkInst(gs.cal0[0], wheelMat.material, false), mkInst(gs.cal0[1], wheelMat.material, false)];
  const wheels1 = [mkInst(gs.wheel1[0], wheelMat.material, true), mkInst(gs.wheel1[1], wheelMat.material, true)];
  const cal1 = [mkInst(gs.cal1[0], wheelMat.material, false), mkInst(gs.cal1[1], wheelMat.material, false)];
  for (const cm of [...cal0, ...cal1]) {
    cm.setColorAt(0, new Color(0, 0, 0));
    cm.setColorAt(1, new Color(0, 0, 1)); // right-hand calipers are mirrored in z by the shader
  }

  // far wheels: one instanced cylinder mesh with per-instance (width, R, R) scale
  const farWheelGeo = new CylinderGeometry(1, 1, 1, 10, 1);
  farWheelGeo.rotateZ(Math.PI / 2);
  farWheelGeo.boundingSphere = new Sphere(new Vector3(0, 0.4, 0), 3.2);
  const farWheelMat = new MeshStandardMaterial({ color: 0x0d0d0f, roughness: 0.85, metalness: 0 });
  const farWheels = new InstancedMesh(farWheelGeo, farWheelMat, 4);
  farWheels.instanceMatrix.setUsage(DynamicDrawUsage);
  farWheels.castShadow = false;

  // ── interior ───────────────────────────────────────────────────────────────
  const cabinMesh = mkStatic(gs.cabin, interiorMat.material, false);
  const driverMesh = mkStatic(gs.driver, interiorMat.material, false);
  const driverLiteMesh = mkStatic(gs.driverLite, interiorMat.material, false);
  const steerMesh = new Mesh(gs.steer, interiorMat.material);
  const steerGroup = new Group();
  steerGroup.position.set(...data.interior.wheelPos);
  const wn = data.interior.wheelNormal;
  const tiltAng = Math.atan2(wn[1], -wn[2]);
  const qBase = new Quaternion().setFromAxisAngle(AX_X, tiltAng).multiply(new Quaternion().setFromAxisAngle(AX_Y, Math.PI));
  steerGroup.quaternion.copy(qBase);
  steerGroup.add(steerMesh);
  const steerRatio = spec.style === 'prototype' ? 7 : spec.style === 'coupe' ? 12.5 : 13;
  const steerLock = Math.min(Math.PI * 2.5, def.physics.chassis.maxSteer * steerRatio);
  const qSteer = new Quaternion();

  // ── assemble levels ────────────────────────────────────────────────────────
  const paint0 = mkStatic(gs.paint0, mats.paint, true);
  const glass0 = mkStatic(gs.glass0, mats.glass, false);
  glass0.renderOrder = 2;
  const g0 = new Group();
  g0.name = 'lod0';
  g0.add(paint0, glass0, ...wheels0, ...cal0, cabinMesh, driverMesh, steerGroup);

  const paint1 = mkStatic(gs.paint1, mats.paint, true);
  const glass1 = mkStatic(gs.glass1, mats.glass, false);
  glass1.renderOrder = 2;
  const g1 = new Group();
  g1.name = 'lod1';
  g1.add(paint1, glass1, ...wheels1, ...cal1, driverLiteMesh);

  const farBody = mkStatic(gs.far, farMat, false);
  const g2 = new Group();
  g2.name = 'lod2';
  g2.add(farBody, farWheels);

  // AI cars cast their shadows from the cheap far mesh (invisible in the colour pass) at every distance
  const proxyMat = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const shadowProxy = new Mesh(gs.far, proxyMat);
  shadowProxy.matrixAutoUpdate = false;
  shadowProxy.castShadow = true;
  shadowProxy.receiveShadow = false;
  shadowProxy.frustumCulled = true;
  for (const m of [paint1, ...wheels1]) m.castShadow = false;
  const proxyWheels = new InstancedMesh(farWheelGeo, proxyMat, 4);
  proxyWheels.instanceMatrix = farWheels.instanceMatrix;
  proxyWheels.castShadow = true;
  proxyWheels.receiveShadow = false;

  const lodAI = new LOD();
  lodAI.addLevel(g1, 0);
  lodAI.addLevel(g2, CARVIS_TUNING.farLodDistance, 0.05);
  root.add(g0, lodAI, shadowProxy, proxyWheels);

  // ── lights ─────────────────────────────────────────────────────────────────
  const hl = layout.headlight;
  const spots: SpotLight[] = [];
  for (const sg of [1, -1]) {
    // low beam: aimed ~45 m down the road with a gentle decay, so the pool reaches far instead of
    // burning out the tarmac just ahead of the bumper
    const sp = new SpotLight(0xfff0dc, 0, CARVIS_TUNING.headlightDistance, CARVIS_TUNING.headlightAngle, 1.0, 1.0);
    sp.position.set(sg * hl[0], hl[1], hl[2]);
    sp.target.position.set(sg * hl[0] * 0.85, 0, hl[2] + 45);
    sp.castShadow = false;
    sp.visible = false;
    root.add(sp, sp.target);
    spots.push(sp);
  }
  // additive colour, but keep the destination alpha: the wet-road shader stores its reflection flag there
  const glowMat = new MeshBasicMaterial({ map: groundGlowTexture(), color: 0xfff0d6, transparent: true, depthWrite: false, opacity: 0 });
  glowMat.blending = CustomBlending;
  glowMat.blendEquation = AddEquation;
  glowMat.blendSrc = SrcAlphaFactor;
  glowMat.blendDst = OneFactor;
  glowMat.blendSrcAlpha = ZeroFactor;
  glowMat.blendDstAlpha = OneFactor;
  const glow = new Mesh(new PlaneGeometry(1, 1), glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.scale.set(6.5, 15, 1);
  glow.position.set(0, 0.05, layout.zNose + 7.2);
  glow.renderOrder = 4;
  glow.visible = false;
  glow.frustumCulled = false;
  root.add(glow);

  // ── crash damage ───────────────────────────────────────────────────────────
  // The model (src/core/damage.ts) is a fold over the car's hit events; here it is fed from the VehicleState, drawn
  // through the body shader's uniform tables (damageShader.ts) and, for the lamps, through the lights themselves.
  const hull = hullOf(spec);
  const dmg = new CarDamage(hull, makeDamageGeometry(data.lod0, spec));
  const observer = new ImpactObserver(hull);
  let dmgMode: DamageMode = 'visual';
  let dmgWritten = -1;
  const dentShown = new Float32Array(MAX_DENTS);
  let dentMoving = false;
  let dmgClock = 0;
  let replaying = false;
  /** every event the car took in live play, so a replay can hand the race's own damage back when it ends */
  const liveLog: DamageEvent[] = [];
  const lampsNow = new Float32Array([1, 1, 1, 1]);
  if (spec.style === 'prototype') U.uDmgBase.value = 1;
  {
    const [lo, hi] = partBounds(data.interior.cabin.vertices);
    U.uCabinMin.value.set(lo[0], lo[1], lo[2]);
    U.uCabinMax.value.set(hi[0], hi[1], hi[2]);
  }
  const takeEvent = (e: DamageEvent): void => {
    dmg.apply(e);
    liveLog.push(e);
    damage.onEvent?.(e);
  };
  const damage: CarDamageControl = {
    get mode() {
      return dmgMode;
    },
    state: dmg,
    onEvent: null,
    lamps: lampsNow,
    get paint() {
      return parseInt(curLivery.primary.slice(1), 16);
    },
    get otherAt() {
      return observer.otherAt;
    },
    set otherAt(f) {
      observer.otherAt = f;
    },
    setMode(m: DamageMode): void {
      if (m === dmgMode) return;
      dmgMode = m;
      if (m === 'off') {
        dmg.reset();
        liveLog.length = 0;
      }
      observer.reset();
    },
    repair(): void {
      dmg.reset();
      liveLog.length = 0;
      observer.reset();
    },
    replay(list, frame): void {
      if (dmgMode === 'off') return;
      if (list) {
        replaying = true;
        dmg.syncTo(list, frame);
      } else if (replaying) {
        replaying = false;
        dmg.reset();
        for (const e of liveLog) dmg.apply(e);
        observer.reset();
      }
    },
  };

  /** The live mirrors (src/carvis/mirrors.ts): built the first time this becomes the player's car. */
  let mirrorRig: MirrorRig | null = null;
  let playerMode = false;
  let cockpitMode = false;
  let spotsOn = false;
  const hideShell = dbgMode === 'interior';
  const hideList = ((globalThis as { __CARVIS_HIDE__?: string }).__CARVIS_HIDE__ ?? '').split(',');
  const applyVisibility = (): void => {
    paint0.visible = !hideShell && !hideList.includes('paint');
    glass0.visible = !hideShell && !hideList.includes('glass');
    cabinMesh.visible = !hideList.includes('cabin');
    g0.visible = playerMode;
    lodAI.visible = !playerMode;
    shadowProxy.visible = !playerMode;
    proxyWheels.visible = !playerMode;
    driverMesh.visible = playerMode && !cockpitMode && !hideList.includes('driver');
    mirrorRig?.setCockpit(playerMode && cockpitMode);
    steerGroup.visible = playerMode && !hideList.includes('steer');
    for (const s of spots) s.visible = playerMode && spotsOn;
  };
  applyVisibility();

  const tri = (g: BufferGeometry): number => (g.index ? g.index.count / 3 : 0);
  root.userData.carvis = {
    triangles: {
      lod0: tri(gs.paint0) + tri(gs.glass0) + tri(gs.wheel0[0]) * 2 + tri(gs.wheel0[1]) * 2 + tri(gs.cal0[0]) * 2 + tri(gs.cal0[1]) * 2 + tri(gs.cabin) + tri(gs.driver) + tri(gs.steer),
      lod1: tri(gs.paint1) + tri(gs.glass1) + tri(gs.wheel1[0]) * 2 + tri(gs.wheel1[1]) * 2 + tri(gs.cal1[0]) * 2 + tri(gs.cal1[1]) * 2 + tri(gs.driverLite),
      lod2: tri(gs.far) + 4 * 20,
      parts0: { paint: tri(gs.paint0), glass: tri(gs.glass0), wheels: tri(gs.wheel0[0]) * 2 + tri(gs.wheel0[1]) * 2, cabin: tri(gs.cabin), driver: tri(gs.driver) },
    },
    drawCalls: { lod0: 1 + 1 + 2 + 2 + 1 + 1 + 1, lod1: 1 + 1 + 2 + 2 + 1, lod2: 2 },
  };

  const anchors = {
    hood: new Object3D(),
    bumper: new Object3D(),
    cockpit: new Object3D(),
    chase: new Object3D(),
  };
  anchors.hood.position.set(...layout.hood);
  anchors.bumper.position.set(...layout.bumper);
  anchors.cockpit.position.set(...layout.eye);
  anchors.chase.position.set(...layout.chase);
  root.add(anchors.hood, anchors.bumper, anchors.cockpit, anchors.chase);

  const cgZ = spec.cgToFrontAxle - spec.wheelbase / 2;
  const tmp = new Vector3();
  const qi = new Quaternion();
  const qs = new Quaternion();
  const qx = new Quaternion();
  const qc = new Quaternion();
  const qa = new Quaternion();
  const qw = new Quaternion();
  const mat4 = new Matrix4();
  const col = new Color();
  const sFront = new Vector3(spec.tireWidthFront, spec.wheelRadiusFront, spec.wheelRadiusFront);
  const sRear = new Vector3(spec.tireWidthRear, spec.wheelRadiusRear, spec.wheelRadiusRear);
  const qFlip = new Quaternion().setFromAxisAngle(AX_Y, Math.PI);
  const camberF = def.physics.suspFront.camber;
  const camberR = def.physics.suspRear.camber;
  let disposed = false;

  const visual: CarVisual = {
    root,
    anchors,
    get mirrors() {
      return mirrorRig?.api;
    },
    damage,
    update(state: VehicleState, _dt: number, env: EnvironmentState): void {
      const q = state.quaternion;
      root.quaternion.copy(q);
      tmp.set(0, spec.cgHeight, cgZ).applyQuaternion(q);
      root.position.copy(state.position).sub(tmp);
      qi.copy(q).invert();
      const full = playerMode;
      const wm = full ? wheels0 : wheels1;
      const cm = full ? cal0 : cal1;
      for (let i = 0; i < 4; i++) {
        const w = state.wheels[i];
        const axle = i >> 1;
        const side = i & 1;
        tmp.copy(w.hub).sub(root.position).applyQuaternion(qi);
        qs.setFromAxisAngle(AX_Y, w.steerAngle);
        const camber = axle === 0 ? camberF : camberR;
        qc.setFromAxisAngle(AX_Z, side ? camber : -camber);
        qx.setFromAxisAngle(AX_X, w.spin % (Math.PI * 2));
        qa.copy(qs).multiply(qc);
        qw.copy(qa).multiply(qx);
        if (side) {
          qw.multiply(qFlip);
          qa.multiply(qFlip);
        }
        col.setRGB(w.omega, w.brakeTempC, 0);
        mat4.compose(tmp, qw, ONE);
        wm[axle].setMatrixAt(side, mat4);
        wm[axle].setColorAt(side, col);
        mat4.compose(tmp, qa, ONE);
        cm[axle].setMatrixAt(side, mat4);
        if (!full) {
          mat4.compose(tmp, qa, axle === 0 ? sFront : sRear);
          farWheels.setMatrixAt(i, mat4);
        }
      }
      for (let a = 0; a < 2; a++) {
        wm[a].instanceMatrix.needsUpdate = true;
        wm[a].instanceColor!.needsUpdate = true;
        cm[a].instanceMatrix.needsUpdate = true;
      }
      if (!full) farWheels.instanceMatrix.needsUpdate = true;
      if (full) {
        qSteer.setFromAxisAngle(AX_Z, -state.steer * steerLock);
        steerGroup.quaternion.copy(qBase).multiply(qSteer);
        const cl = IU.uCluster.value;
        const span = state.limiterRpm > 0 ? state.limiterRpm : 8000;
        cl.set(Math.min(1, Math.max(0, state.rpm / span)), state.gear, state.speed * 3.6, state.revLimiter ? 1 : 0);
      }

      // the light through the glass: the sun rarely reaches the dash and wheel under the roof, and with the black trim
      // the cockpit view fell to pure black even at noon (QA). A soft window light all day, fading out after dusk.
      IU.uFill.value = 0.055 * (1 - env.darkness);
      // rain: wet paint (shader), a glossier and darker far LOD, shinier tyres
      U.uWet.value = env.wetness;
      U.uSpd.value = state.speed;
      if (env.wetness !== lastWet) {
        lastWet = env.wetness;
        farMat.roughness = farBaseRough * (1 - 0.5 * lastWet);
        farMat.color.setScalar(1 - 0.14 * lastWet);
        WU.uWet.value = lastWet;
      }

      // crash damage: a new impact becomes dents, scrapes and broken lamps; the uniforms follow the model
      if (dmgMode !== 'off' && !replaying) observer.update(state, _dt, takeEvent);
      dmgClock += _dt;
      const dentsChanged = dmg.version !== dmgWritten;
      if (dentsChanged || dentMoving) dentMoving = settleDentDepth(dmg, dentShown, _dt);
      if (dentsChanged || dentMoving || (dmgMode !== 'off' && anyLampFlickers(dmg))) {
        dmgWritten = dmg.version;
        packDamage(dmg, dmgMode, U, dmgClock, dentShown);
      }
      const lampOut = U.uLampOut.value;
      lampsNow[0] = lampOut.x;
      lampsNow[1] = lampOut.y;
      lampsNow[2] = lampOut.z;
      lampsNow[3] = lampOut.w;

      // lights
      const dark = env.darkness;
      const head = Math.min(1, Math.max(0, (dark - 0.25) / 0.35));
      U.uHead.value = head;
      U.uDrl.value = 1 - 0.5 * head;
      U.uTail.value = 0.12 + 0.88 * head;
      U.uBrake.value = state.brake > 0.05 ? 1 : 0;
      U.uRev.value = state.gear === -1 ? 1 : 0;
      const wantSpots = dark > CARVIS_TUNING.headlightOnDarkness;
      if (wantSpots !== spotsOn) {
        spotsOn = wantSpots;
        for (const s of spots) s.visible = playerMode && spotsOn;
      }
      // (a broken headlight goes dark; the spot stays "visible" at zero so the lights in the scene never change count)
      if (spotsOn) {
        spots[0].intensity = CARVIS_TUNING.headlightIntensity * head * lampOut.x;
        spots[1].intensity = CARVIS_TUNING.headlightIntensity * head * lampOut.y;
      }
      const showGlow = !playerMode && head > 0.02;
      glow.visible = showGlow;
      // (on a wet road the lamps' light skids away as reflection instead of pooling: a much fainter decal)
      if (showGlow) (glow.material as MeshBasicMaterial).opacity = head * 0.8 * (1 - 0.7 * env.wetness) * 0.5 * (lampOut.x + lampOut.y);
      root.updateMatrixWorld(true);
    },
    setLivery(l: Livery): void {
      applyLivery(l);
    },
    setPlayer(on: boolean): void {
      playerMode = on;
      if (on && !mirrorRig) {
        mirrorRig = createMirrorRig(spec);
        // in a mirror the player's body is the coarse one (its wheels stay the full-detail ones: only they are posed in player mode)
        mirrorRig.api.hide.push(cabinMesh, driverMesh, steerGroup, driverLiteMesh, ...wheels1, ...cal1);
        mirrorRig.api.lowDetail.hide.push(paint0, glass0);
        mirrorRig.api.lowDetail.show.push(lodAI);
        g0.add(mirrorRig.group);
      }
      const want: LiveryTier = on ? quality : 'ai';
      if (want !== tier) {
        // different resolution: repaint into fresh textures
        const old = textures;
        tier = want;
        textures = paintLivery(curLivery, layout.livery, tier);
        U.uSide.value = textures.side;
        U.uTop.value = textures.top;
        U.uEnd.value = textures.end;
        old.dispose();
      }
      applyVisibility();
    },
    setCockpitView(on: boolean): void {
      cockpitMode = on;
      applyVisibility();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      mirrorRig?.dispose();
      mats.paint.dispose();
      mats.glass.dispose();
      textures.dispose();
      wheelMat.material.dispose();
      interiorMat.material.dispose();
      farMat.dispose();
      proxyMat.dispose();
      farWheelMat.dispose();
      farWheelGeo.dispose();
      tireText.release();
      glow.geometry.dispose();
      (glow.material as MeshBasicMaterial).dispose();
      for (const m of [...wheels0, ...cal0, ...wheels1, ...cal1, farWheels, proxyWheels]) m.dispose();
      for (const s of spots) s.dispose();
      const set = geoCache.get(key);
      if (set && --set.refs <= 0) {
        disposeGeoSet(set);
        geoCache.delete(key);
      }
    },
  };
  return visual;
}
