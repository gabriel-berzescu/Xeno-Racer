/**
 * EffectsSystem (owner: render): tyre smoke, dust and debris, skidmarks, sparks, backfire flames,
 * impact bursts and contact shadows, driven purely by VehicleState.
 *
 * Everything is pooled and instanced; quality scales the pool sizes and emission rates. The soft
 * particles live in the render system's particle scene (drawn after AO with depth-aware fading);
 * skidmarks and contact shadows are ordinary decals in the main scene.
 */
import {
  AddEquation,
  CustomBlending,
  DataTexture,
  DoubleSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
  type Camera,
  type Scene,
} from 'three';
import type { CarDefinition, QualityLevel, SurfaceType, TrackRuntime, VehicleState } from '../core/contracts';
import type { EffectsSystem, RenderSystem } from '../core/systems';
import { makeSmokeAtlas } from './noise';
import { particleUniforms } from './post';
import type { XenoRenderSystem } from './renderSystem';
import { ContactShadows } from './fx/contactShadow';
import {
  chipFragment,
  chipVertex,
  flameFragment,
  flameVertex,
  glowFragment,
  glowVertex,
  particleCommon,
  puffFragment,
  puffVertex,
  sparkFragment,
  sparkVertex,
} from './fx/particleShaders';
import { ChipPool, FlamePool, GlowPool, makePuffSpec, PuffPool, rg, rnd, rr, SparkPool } from './fx/pools';
import { makeTrail, SkidMarks, type SkidTrail } from './fx/skidmarks';

interface QualityCaps {
  puffs: number;
  sparks: number;
  chips: number;
  flames: number;
  glows: number;
  skid: number;
  emit: number;
  sort: boolean;
}

const CAPS: Record<QualityLevel, QualityCaps> = {
  low: { puffs: 420, sparks: 140, chips: 60, flames: 24, glows: 24, skid: 6000, emit: 0.55, sort: false },
  medium: { puffs: 800, sparks: 300, chips: 120, flames: 32, glows: 32, skid: 10000, emit: 0.78, sort: true },
  high: { puffs: 1500, sparks: 600, chips: 240, flames: 48, glows: 48, skid: 15000, emit: 1.0, sort: true },
  ultra: { puffs: 2400, sparks: 900, chips: 360, flames: 64, glows: 64, skid: 20000, emit: 1.2, sort: true },
};

const MAX_CARS = 16;

interface ExhaustTip {
  x: number; y: number; z: number;
  dx: number; dy: number; dz: number;
}

interface CarFx {
  id: number;
  def: CarDefinition;
  tips: ExhaustTip[];
  trails: SkidTrail[];
  smokeAcc: number[];
  dustAcc: number[];
  chipAcc: number[];
  sparkAcc: number;
  prev: Float32Array; // previous contact points (4 x 3)
  hasPrev: boolean[];
  impactSeen: number;
  backfireSeen: number;
  slot: number;
  first: boolean;
}

function isHard(s: SurfaceType): boolean {
  return s === 'asphalt' || s === 'curb' || s === 'concrete';
}

interface SurfaceLook {
  /** dust albedo */
  r: number; g: number; b: number;
  /** dust amount factor */
  dust: number;
  dustAlpha: number;
  /** skid track colour / alpha */
  tr: number; tg: number; tb: number;
  trAlpha: number;
  chips: number;
}

const SURF: Record<SurfaceType, SurfaceLook> = {
  asphalt: { r: 0.5, g: 0.5, b: 0.5, dust: 0, dustAlpha: 0, tr: 0.012, tg: 0.012, tb: 0.014, trAlpha: 0.82, chips: 0 },
  curb: { r: 0.55, g: 0.5, b: 0.45, dust: 0, dustAlpha: 0, tr: 0.012, tg: 0.012, tb: 0.014, trAlpha: 0.6, chips: 0 },
  concrete: { r: 0.6, g: 0.58, b: 0.55, dust: 0, dustAlpha: 0, tr: 0.015, tg: 0.015, tb: 0.017, trAlpha: 0.7, chips: 0 },
  grass: { r: 0.34, g: 0.36, b: 0.2, dust: 0.35, dustAlpha: 0.2, tr: 0.045, tg: 0.06, tb: 0.022, trAlpha: 0.34, chips: 0.5 },
  gravel: { r: 0.56, g: 0.53, b: 0.49, dust: 1.0, dustAlpha: 0.26, tr: 0.11, tg: 0.1, tb: 0.09, trAlpha: 0.3, chips: 1.0 },
  sand: { r: 0.8, g: 0.68, b: 0.46, dust: 1.3, dustAlpha: 0.36, tr: 0.3, tg: 0.24, tb: 0.15, trAlpha: 0.28, chips: 0.2 },
  dirt: { r: 0.44, g: 0.33, b: 0.22, dust: 1.0, dustAlpha: 0.26, tr: 0.055, tg: 0.04, tb: 0.028, trAlpha: 0.42, chips: 0.7 },
};

const _q = new Vector3();
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _fwdCam = new Vector3();
const _posCam = new Vector3();
const _spec = makePuffSpec();

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}
function smooth(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export function createEffects(render: RenderSystem, track: TrackRuntime, quality: QualityLevel): EffectsSystem {
  const xr = render as Partial<XenoRenderSystem> & RenderSystem;
  const caps = CAPS[quality];
  const parent: Scene = xr.particleScene ?? xr.scene;
  const mainScene: Scene = xr.scene;
  const stats = (xr as XenoRenderSystem).stats;

  // ── atlas + materials ──
  const atlasData = makeSmokeAtlas(256);
  const atlas = new DataTexture(atlasData, 256, 256, RGBAFormat, UnsignedByteType);
  atlas.magFilter = LinearFilter;
  atlas.minFilter = LinearMipmapLinearFilter;
  atlas.generateMipmaps = true;
  atlas.needsUpdate = true;
  atlas.name = 'xr.smokeAtlas';

  const baseMat = {
    depthTest: false,
    depthWrite: false,
    transparent: true,
    side: DoubleSide,
    toneMapped: false,
    fog: false,
  };
  const U = particleUniforms;
  const shared = { uDepth: U.uDepth, uHasDepth: U.uHasDepth, uResolution: U.uResolution, uNearFar: U.uNearFar, uSunDir: U.uSunDir, uSunLight: U.uSunLight, uSkyAmb: U.uSkyAmb, uGroundAmb: U.uGroundAmb, uFogColor: U.uFogColor, uFogDensity: U.uFogDensity };

  const puffMat = new ShaderMaterial({
    ...baseMat,
    name: 'xr.fx.puff',
    uniforms: { ...shared, uAtlas: { value: atlas }, uSoftness: { value: 0.85 } },
    vertexShader: puffVertex,
    fragmentShader: particleCommon + puffFragment,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneMinusSrcAlphaFactor,
  });
  const sparkMat = new ShaderMaterial({
    ...baseMat,
    name: 'xr.fx.spark',
    uniforms: { ...shared },
    vertexShader: sparkVertex,
    fragmentShader: particleCommon + sparkFragment,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneFactor,
  });
  const flameMat = new ShaderMaterial({
    ...baseMat,
    name: 'xr.fx.flame',
    uniforms: { ...shared, uAtlas: { value: atlas } },
    vertexShader: flameVertex,
    fragmentShader: particleCommon + flameFragment,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneFactor,
  });
  const glowMat = new ShaderMaterial({
    ...baseMat,
    name: 'xr.fx.glow',
    uniforms: { ...shared },
    vertexShader: glowVertex,
    fragmentShader: particleCommon + glowFragment,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneFactor,
  });
  const chipMat = new ShaderMaterial({
    ...baseMat,
    name: 'xr.fx.chip',
    uniforms: { ...shared },
    vertexShader: chipVertex,
    fragmentShader: particleCommon + chipFragment,
    blending: NormalBlending,
  });

  const puffs = new PuffPool(caps.puffs, puffMat, caps.sort);
  const sparks = new SparkPool(caps.sparks, sparkMat);
  const flames = new FlamePool(caps.flames, flameMat);
  const chips = new ChipPool(caps.chips, chipMat);
  const glows = new GlowPool(caps.glows, glowMat);
  parent.add(puffs.mesh, chips.mesh, flames.mesh, sparks.mesh, glows.mesh);

  const skid = new SkidMarks(caps.skid);
  mainScene.add(skid.mesh);
  const blobs = new ContactShadows(MAX_CARS);
  mainScene.add(blobs.mesh);

  const records = new Map<number, CarFx>();
  let windX = 1.2;
  let windZ = 0.55;
  let clock = 0;

  // scratch for contact blobs
  const wX = new Float32Array(4), wY = new Float32Array(4), wZ = new Float32Array(4);
  const wW = new Float32Array(4), wD = new Float32Array(4), wO = new Float32Array(4);

  // ── helpers ──

  function buildTips(def: CarDefinition): ExhaustTip[] {
    const v = def.visual;
    const tips: ExhaustTip[] = [];
    const zr = -(v.length - v.frontOverhang - v.wheelbase / 2) + 0.03;
    const y = v.style === 'prototype' ? v.height * 0.5 : v.rideHeight + 0.2;
    const { count, side } = v.exhaust;
    const back = (x: number, z: number, dx = 0, dz = -1): void => {
      const l = Math.hypot(dx, 0.06, dz);
      tips.push({ x, y, z, dx: dx / l, dy: -0.06 / l, dz: dz / l });
    };
    if (side === 'side') {
      const per = count === 4 ? 2 : 1;
      for (const s of [-1, 1]) {
        for (let k = 0; k < per; k++) back(s * (v.width / 2 - 0.02), -v.wheelbase / 2 + 0.6 + k * 0.22, s * 0.9, -0.45);
      }
    } else if (side === 'center') {
      if (count === 1) back(0, zr);
      else if (count === 2) {
        back(-Math.min(0.2, v.width * 0.1), zr);
        back(Math.min(0.2, v.width * 0.1), zr);
      } else {
        for (const x of [-0.36, -0.14, 0.14, 0.36]) back(x * Math.min(1, v.width / 1.8), zr);
      }
    } else {
      if (count <= 2) {
        back(-v.width * 0.3, zr);
        back(v.width * 0.3, zr);
      } else {
        for (const x of [-0.37, -0.25, 0.25, 0.37]) back(x * v.width, zr);
      }
    }
    return tips;
  }

  function surfaceAt(s: SurfaceType): SurfaceLook {
    return SURF[s] ?? SURF.asphalt;
  }

  /** Ground height under the car (mean of the wheel contact points). */
  function groundYOf(s: VehicleState): number {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 4; i++) {
      if (s.wheels[i].contact) {
        sum += s.wheels[i].contactPoint.y;
        n++;
      }
    }
    return n > 0 ? sum / n : s.position.y - 0.4;
  }

  function emitSmoke(rec: CarFx, s: VehicleState, i: number, amt: number, dt: number): void {
    const w = s.wheels[i];
    const rate = (4 + 50 * amt * amt) * caps.emit;
    let acc = rec.smokeAcc[i] + rate * dt;
    let n = Math.floor(acc);
    rec.smokeAcc[i] = acc - n;
    if (n > 6) n = 6;
    const cp = w.contactPoint;
    const ox = rec.prev[i * 3], oy = rec.prev[i * 3 + 1], oz = rec.prev[i * 3 + 2];
    for (let k = 0; k < n; k++) {
      const f = (k + rnd()) / n;
      const px = rec.hasPrev[i] ? ox + (cp.x - ox) * f : cp.x;
      const py = rec.hasPrev[i] ? oy + (cp.y - oy) * f : cp.y;
      const pz = rec.hasPrev[i] ? oz + (cp.z - oz) * f : cp.z;
      const sp = _spec;
      sp.x = px + rg() * 0.2;
      sp.y = py + 0.05 + rnd() * 0.08;
      sp.z = pz + rg() * 0.2;
      sp.vx = s.velocity.x * 0.28 + rg() * 0.7;
      sp.vy = rr(0.5, 1.2) + amt * 1.3;
      sp.vz = s.velocity.z * 0.28 + rg() * 0.7;
      sp.r0 = rr(0.3, 0.46) + 0.12 * amt;
      sp.r1 = rr(0.8, 1.2) + 1.25 * amt;
      sp.life = rr(1.4, 2.1) + 0.9 * amt;
      sp.alpha = (0.08 + 0.34 * amt) * rr(0.75, 1.1);
      const g = rr(0.76, 0.9);
      sp.cr = g; sp.cg = g; sp.cb = g * 1.02;
      sp.rotVel = 0.3;
      sp.drag = 1.25;
      sp.buoy = 0.55;
      sp.wind = 1;
      puffs.spawn(sp);
    }
  }

  function emitDust(rec: CarFx, s: VehicleState, i: number, look: SurfaceLook, amt: number, dt: number): void {
    const w = s.wheels[i];
    const rate = (2 + 30 * amt) * caps.emit;
    let acc = rec.dustAcc[i] + rate * dt;
    let n = Math.floor(acc);
    rec.dustAcc[i] = acc - n;
    if (n > 5) n = 5;
    const cp = w.contactPoint;
    for (let k = 0; k < n; k++) {
      const sp = _spec;
      sp.x = cp.x + rg() * 0.3;
      sp.y = cp.y + 0.08 + rnd() * 0.1;
      sp.z = cp.z + rg() * 0.3;
      const up = rr(0.9, 2.6) * (0.5 + amt);
      sp.vx = -s.velocity.x * 0.1 + rg() * 1.4;
      sp.vy = up;
      sp.vz = -s.velocity.z * 0.1 + rg() * 1.4;
      sp.r0 = 0.32;
      sp.r1 = rr(0.8, 1.3) + amt * 0.5;
      sp.life = rr(0.8, 1.5);
      sp.alpha = look.dustAlpha * rr(0.6, 1.0) * (0.4 + 0.6 * Math.min(1, amt));
      const t = rr(0.92, 1.08);
      sp.cr = look.r * t; sp.cg = look.g * t; sp.cb = look.b * t;
      sp.rotVel = 0.4;
      sp.drag = 1.7;
      sp.buoy = 0.25;
      sp.wind = 0.9;
      puffs.spawn(sp);
    }
  }

  function emitChips(rec: CarFx, s: VehicleState, i: number, look: SurfaceLook, amt: number, dt: number, gy: number): void {
    const rate = 14 * amt * look.chips * caps.emit;
    let acc = rec.chipAcc[i] + rate * dt;
    let n = Math.floor(acc);
    rec.chipAcc[i] = acc - n;
    if (n > 3) n = 3;
    const cp = s.wheels[i].contactPoint;
    for (let k = 0; k < n; k++) {
      const t = rr(0.5, 0.95);
      chips.spawn(
        cp.x + rg() * 0.2, cp.y + 0.1, cp.z + rg() * 0.2,
        -s.velocity.x * 0.25 + rg() * 2.5, rr(1.5, 5) * (0.6 + amt), -s.velocity.z * 0.25 + rg() * 2.5,
        rr(0.7, 1.4), rr(0.012, 0.03), look.tr * 1.6 + 0.04 * t, look.tg * 1.6 + 0.04 * t, look.tb * 1.6 + 0.04 * t, gy,
      );
    }
  }

  function emitScrapeSparks(rec: CarFx, s: VehicleState, dt: number, gy: number): void {
    const rate = 430 * s.scrape * clamp(s.speed / 35, 0.25, 1.4) * caps.emit;
    let acc = rec.sparkAcc + rate * dt;
    let n = Math.floor(acc);
    rec.sparkAcc = acc - n;
    if (n > 14) n = 14;
    const sp = s.scrapePoint;
    for (let k = 0; k < n; k++) {
      const dirx = rg() * 2, diry = rnd() * 1.4, dirz = rg() * 2;
      const speed = rr(3, 9);
      sparks.spawn(
        sp.x + rg() * 0.12, sp.y + rg() * 0.08, sp.z + rg() * 0.12,
        -s.velocity.x * 0.15 + dirx * speed * 0.45, diry * speed * 0.7 + rr(0.3, 2.2), -s.velocity.z * 0.15 + dirz * speed * 0.45,
        rr(0.28, 0.8), rr(0.015, 0.026), rr(9, 20), gy,
      );
    }
    // hot glow where metal meets the wall (reads from any angle, feeds bloom)
    glows.spawn(sp.x, sp.y, sp.z, s.velocity.x, s.velocity.y, s.velocity.z, 0.08 + 0.1 * s.scrape, 0.07, 1.0, 0.72, 0.36, 0.5 + 1.1 * s.scrape);
  }

  function impactBurst(s: VehicleState, gy: number): void {
    const im = s.lastImpact;
    const k = clamp(im.strength, 0.12, 1);
    const p = im.point;
    const nx = im.normal.x, ny = im.normal.y, nz = im.normal.z;
    const vd = s.velocity.x * nx + s.velocity.y * ny + s.velocity.z * nz;
    const rx = s.velocity.x - 2 * vd * nx, ry = s.velocity.y - 2 * vd * ny, rz = s.velocity.z - 2 * vd * nz;
    const ground = im.kind === 'ground';
    const ns = Math.round((ground ? 8 : 24) + (ground ? 30 : 120) * k);
    for (let i = 0; i < ns; i++) {
      const sp = rr(2, 11) * (0.5 + k);
      sparks.spawn(
        p.x + rg() * 0.1, p.y + rg() * 0.1, p.z + rg() * 0.1,
        rx * 0.2 + nx * rr(1, 5) + rg() * sp, ry * 0.2 + ny * rr(1, 5) + rnd() * sp * 0.6, rz * 0.2 + nz * rr(1, 5) + rg() * sp,
        rr(0.3, 0.95), rr(0.012, 0.024), rr(7, 16), gy,
      );
    }
    const nc = Math.round(6 + 44 * k);
    const dust = ground ? SURF.dirt : SURF.concrete;
    for (let i = 0; i < nc; i++) {
      chips.spawn(
        p.x + rg() * 0.15, p.y + rg() * 0.1, p.z + rg() * 0.15,
        nx * rr(1, 4) + rg() * 5, ny * rr(1, 4) + rr(1, 5), nz * rr(1, 4) + rg() * 5,
        rr(0.8, 1.7), rr(0.016, 0.04), dust.r * 0.55, dust.g * 0.55, dust.b * 0.55, gy,
      );
    }
    const np = 2 + Math.round(6 * k);
    for (let i = 0; i < np; i++) {
      const sp = _spec;
      sp.x = p.x + rg() * 0.3; sp.y = p.y + rg() * 0.2; sp.z = p.z + rg() * 0.3;
      sp.vx = nx * rr(0.8, 3) + rg() * 1.6 + s.velocity.x * 0.12;
      sp.vy = ny * rr(0.8, 3) + rr(0.4, 1.6);
      sp.vz = nz * rr(0.8, 3) + rg() * 1.6 + s.velocity.z * 0.12;
      sp.r0 = 0.45; sp.r1 = 1.5 + 1.6 * k; sp.life = rr(1.1, 2.0);
      sp.alpha = 0.32 + 0.25 * k;
      sp.cr = dust.r; sp.cg = dust.g; sp.cb = dust.b;
      sp.rotVel = 0.5; sp.drag = 1.6; sp.buoy = 0.2; sp.wind = 0.9;
      puffs.spawn(sp);
    }
  }

  function backfire(rec: CarFx, s: VehicleState): void {
    const v = rec.def.visual;
    _v1.set(0, v.cgHeight, v.cgToFrontAxle - v.wheelbase / 2).applyQuaternion(s.quaternion);
    const ox = s.position.x - _v1.x, oy = s.position.y - _v1.y, oz = s.position.z - _v1.z;
    for (let i = 0; i < rec.tips.length; i++) {
      if (i > 0 && rnd() > 0.8) continue;
      const t = rec.tips[i];
      _v2.set(t.x, t.y, t.z).applyQuaternion(s.quaternion);
      _v3.set(t.dx, t.dy, t.dz).applyQuaternion(s.quaternion);
      const px = ox + _v2.x, py = oy + _v2.y, pz = oz + _v2.z;
      flames.spawn(px, py, pz, _v3.x, _v3.y, _v3.z, rr(0.45, 0.9), rr(0.07, 0.11), rr(0.09, 0.16), rr(3.5, 6), 1, s.velocity.x, s.velocity.y, s.velocity.z);
      // a short round flash at the tip (reads from any angle, feeds bloom)
      glows.spawn(px, py, pz, s.velocity.x, s.velocity.y, s.velocity.z, rr(0.2, 0.3), 0.08, 1.0, 0.62, 0.26, rr(3, 5));
      for (let k = 0; k < 4; k++) {
        sparks.spawn(
          px, py, pz,
          s.velocity.x + _v3.x * rr(4, 10) + rg() * 3, s.velocity.y + _v3.y * 6 + rr(0.5, 2.5), s.velocity.z + _v3.z * rr(4, 10) + rg() * 3,
          rr(0.2, 0.5), rr(0.01, 0.016), rr(5, 10), s.position.y - 0.4,
        );
      }
      const sp = _spec;
      sp.x = px; sp.y = py; sp.z = pz;
      sp.vx = s.velocity.x * 0.2 + _v3.x * 2; sp.vy = 0.6; sp.vz = s.velocity.z * 0.2 + _v3.z * 2;
      sp.r0 = 0.12; sp.r1 = 0.7; sp.life = 0.9; sp.alpha = 0.16;
      sp.cr = 0.14; sp.cg = 0.14; sp.cb = 0.16; sp.rotVel = 0.5; sp.drag = 1.8; sp.buoy = 0.3; sp.wind = 1;
      puffs.spawn(sp);
    }
  }

  function updateBlob(rec: CarFx, s: VehicleState): void {
    const v = rec.def.visual;
    let nx = 0, ny = 0, nz = 0, ax = 0, ay = 0, az = 0, c = 0;
    for (let i = 0; i < 4; i++) {
      const w = s.wheels[i];
      if (!w.contact) continue;
      nx += w.contactNormal.x; ny += w.contactNormal.y; nz += w.contactNormal.z;
      ax += w.contactPoint.x; ay += w.contactPoint.y; az += w.contactPoint.z;
      c++;
    }
    let clearance = 1.2;
    if (c === 0) {
      nx = 0; ny = 1; nz = 0;
      ax = s.position.x; ay = s.position.y - 1.2; az = s.position.z;
    } else {
      nx /= c; ny /= c; nz /= c; ax /= c; ay /= c; az /= c;
    }
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    // forward projected onto the plane
    _v1.set(0, 0, 1).applyQuaternion(s.quaternion);
    const fd = _v1.x * nx + _v1.y * ny + _v1.z * nz;
    let fx = _v1.x - nx * fd, fy = _v1.y - ny * fd, fz = _v1.z - nz * fd;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    // left = n x f
    const lx = ny * fz - nz * fy, ly = nz * fx - nx * fz, lz = nx * fy - ny * fx;
    const h = (s.position.x - ax) * nx + (s.position.y - ay) * ny + (s.position.z - az) * nz;
    clearance = h;
    const cx = s.position.x - nx * h + nx * 0.014, cy = s.position.y - ny * h + ny * 0.014, cz = s.position.z - nz * h + nz * 0.014;
    const lift = clamp(1 - (clearance - v.cgHeight) / 0.9, 0, 1);
    const real = xr.graphics && xr.graphics.shadows !== 'off';
    const bodyOp = (real ? 0.3 : 0.55) * lift * (s.airborne ? 0 : 1);
    // body centre along the car: offset from CG toward the body middle
    const zOff = (v.wheelbase + 2 * v.frontOverhang - v.length) / 2 - (v.cgToFrontAxle - v.wheelbase / 2);
    for (let i = 0; i < 4; i++) {
      const w = s.wheels[i];
      wX[i] = w.contactPoint.x + nx * 0.012; wY[i] = w.contactPoint.y + ny * 0.012; wZ[i] = w.contactPoint.z + nz * 0.012;
      wW[i] = w.width * 1.7 + 0.12;
      wD[i] = w.radius * 1.25;
      wO[i] = w.contact ? (real ? 0.4 : 0.6) * clamp(w.load / 3500, 0.25, 1) : 0;
    }
    blobs.set(
      rec.slot,
      cx + fx * zOff, cy + fy * zOff, cz + fz * zOff,
      lx, ly, lz, nx, ny, nz, fx, fy, fz,
      v.width * 1.22, v.length * 1.08, bodyOp,
      wX, wY, wZ, wW, wD, wO,
    );
  }

  function updateCar(rec: CarFx, s: VehicleState, dt: number): void {
    const gy = groundYOf(s);
    if (rec.first) {
      rec.first = false;
      rec.impactSeen = s.impactCount;
      rec.backfireSeen = s.backfireCount;
    }
    const speed = s.speed;

    for (let i = 0; i < 4; i++) {
      const w = s.wheels[i];
      const cp = w.contactPoint;
      const look = surfaceAt(w.surface);
      const hard = isHard(w.surface);
      const trail = rec.trails[i];

      if (w.contact) {
        if (hard) {
          const amt = smooth(0.17, 0.95, w.skid) * (0.55 + 0.45 * smooth(50, 100, w.tempC));
          if (w.skid > 0.2) {
            const a = smooth(0.2, 0.9, w.skid) * look.trAlpha;
            skid.addPoint(trail, cp.x, cp.y, cp.z, w.contactNormal.x, w.contactNormal.y, w.contactNormal.z, w.width * 0.9, look.tr, look.tg, look.tb, a);
          } else if (trail.active) {
            if (trail.hasEdges) skid.addPoint(trail, cp.x, cp.y, cp.z, w.contactNormal.x, w.contactNormal.y, w.contactNormal.z, w.width * 0.9, look.tr, look.tg, look.tb, 0);
            skid.endTrail(trail);
          }
          if (amt > 0.02) emitSmoke(rec, s, i, amt, dt);
        } else {
          // soft surfaces: faint tracks whenever the car is moving, dust + chips by speed
          if (speed > 3 && (w.skid > 0.12 || speed > 9)) {
            const a = (0.5 + 0.5 * w.skid) * look.trAlpha;
            skid.addPoint(trail, cp.x, cp.y, cp.z, w.contactNormal.x, w.contactNormal.y, w.contactNormal.z, w.width * 0.85, look.tr, look.tg, look.tb, a);
          } else if (trail.active) {
            skid.endTrail(trail);
          }
          if (look.dust > 0 && speed > 2.5) {
            // a rolling wheel lifts a little; wheelspin and slides throw the real clouds
            const amt = clamp(speed / 30, 0, 1) * look.dust * (0.22 + 0.78 * clamp(w.skid + 2 * Math.abs(w.slipRatio) + 2 * Math.abs(w.slipAngle), 0, 1));
            if (amt > 0.02) emitDust(rec, s, i, look, amt, dt);
            if (look.chips > 0 && amt > 0.1) emitChips(rec, s, i, look, amt, dt, gy);
          }
        }
        rec.prev[i * 3] = cp.x; rec.prev[i * 3 + 1] = cp.y; rec.prev[i * 3 + 2] = cp.z;
        rec.hasPrev[i] = true;
      } else {
        if (trail.active) skid.endTrail(trail);
        rec.hasPrev[i] = false;
      }
    }

    if (s.scrape > 0.04) emitScrapeSparks(rec, s, dt, gy);

    if (s.impactCount !== rec.impactSeen) {
      rec.impactSeen = s.impactCount;
      impactBurst(s, gy);
    }
    if (s.backfireCount !== rec.backfireSeen) {
      rec.backfireSeen = s.backfireCount;
      backfire(rec, s);
    }

    updateBlob(rec, s);
  }

  // ── public API ──

  const api: EffectsSystem = {
    registerCar(id: number, def: CarDefinition): void {
      if (records.has(id)) return;
      records.set(id, {
        id,
        def,
        tips: buildTips(def),
        trails: [makeTrail(), makeTrail(), makeTrail(), makeTrail()],
        smokeAcc: [0, 0, 0, 0],
        dustAcc: [0, 0, 0, 0],
        chipAcc: [0, 0, 0, 0],
        sparkAcc: 0,
        prev: new Float32Array(12),
        hasPrev: [false, false, false, false],
        impactSeen: 0,
        backfireSeen: 0,
        slot: blobs.slotFor(id),
        first: true,
      });
    },

    unregisterCar(id: number): void {
      const rec = records.get(id);
      if (!rec) return;
      for (const t of rec.trails) skid.endTrail(t);
      blobs.release(id);
      records.delete(id);
    },

    update(dt: number, cars: readonly VehicleState[], camera: Camera): void {
      if (!(dt > 0)) return;
      dt = Math.min(dt, 0.1);
      clock += dt;
      windX = 1.2 + Math.sin(clock * 0.13) * 0.5;
      windZ = 0.55 + Math.cos(clock * 0.11) * 0.4;

      skid.beginFrame();
      for (let i = 0; i < cars.length; i++) {
        const rec = records.get(cars[i].id);
        if (rec) updateCar(rec, cars[i], dt);
      }
      skid.endFrame();

      puffs.update(dt, windX, windZ);
      sparks.update(dt);
      flames.update(dt);
      chips.update(dt);
      glows.update(dt);

      camera.getWorldPosition(_posCam);
      camera.getWorldDirection(_fwdCam);
      puffs.fill(_posCam.x, _posCam.y, _posCam.z, _fwdCam.x, _fwdCam.y, _fwdCam.z);
      sparks.fill();
      flames.fill();
      chips.fill();
      glows.fill();
      if (stats) void stats;
    },

    clear(): void {
      puffs.clear();
      sparks.clear();
      flames.clear();
      chips.clear();
      glows.clear();
      skid.clear();
      blobs.clear();
      for (const rec of records.values()) {
        for (const t of rec.trails) skid.endTrail(t);
        rec.hasPrev.fill(false);
        rec.first = true;
      }
    },

    dispose(): void {
      parent.remove(puffs.mesh, chips.mesh, flames.mesh, sparks.mesh, glows.mesh);
      mainScene.remove(skid.mesh, blobs.mesh);
      puffs.dispose();
      sparks.dispose();
      flames.dispose();
      chips.dispose();
      glows.dispose();
      skid.dispose();
      blobs.dispose();
      puffMat.dispose();
      sparkMat.dispose();
      flameMat.dispose();
      glowMat.dispose();
      chipMat.dispose();
      atlas.dispose();
      records.clear();
    },
  };

  void track;
  void _q;
  return api;
}
