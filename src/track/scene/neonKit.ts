/**
 * The kit of the neon builders (see neon.ts): the materials, the buffers per stretch of the lap and the vertex helpers.
 */
import * as THREE from 'three';
import { resolveMark } from '../plan';
import type { TrackRuntimeImpl } from '../runtime';
import type { Mark, NeonDef } from '../types';
import type { Ctx } from './ctx';
import { GeoBuf } from './geom';

/** Linear RGB. */
export type RGB = readonly [number, number, number];

export function rgb(hex: number): RGB {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/** Metres of lap per merged mesh. */
export const NEON_CHUNK = 320;

/**
 * A tube's radiance at night, per unit of its colour (scene units: the night's exposure is 4.6 and the bloom takes what is over 1.6
 * after exposure). At 2 the strongest channel of a colour is about 9 on the display's scale: the tone mapper turns the core into a
 * pale tint of the colour, with a hard edge, and the bloom lays the colour itself round it. Much higher and the halo swallows the
 * line; much lower and a strip 13 cm tall is lost against the lit windows and the advertising a hundred metres off.
 */
const TUBE_NIGHT = 2.0;
/** The share of white in a tube's light: the core of a neon tube is paler than its halo. */
const TUBE_WHITE = 0.07;
/** The painted light at night where a sheet has all of it (the ground at the foot of a strip), per unit of the colour. */
export const GLOW_NIGHT = 0.045;
/** A tunnel is lit by day as well, and the day's exposure is a third of the night's: its lights are that much stronger then. */
export const TUNNEL_DAY = 3.2;

export interface NeonMats {
  tube: THREE.MeshStandardMaterial;
  tunnelTube: THREE.MeshStandardMaterial;
  frame: THREE.MeshStandardMaterial;
  glow: THREE.MeshBasicMaterial;
  tunnelGlow: THREE.MeshBasicMaterial;
}

function tubeMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xd4dade, roughness: 0.32, metalness: 0, vertexColors: true, emissive: 0xffffff, emissiveIntensity: 0 });
  m.name = 'neonTube';
  // the vertex colour is the light's colour: it tints the diffuser a little and is the whole of the emissive
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <color_fragment>', 'diffuseColor.rgb *= mix( vec3( 1.0 ), vColor.rgb, 0.3 );')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb + ${TUBE_WHITE.toFixed(3)};`);
  };
  m.customProgramCacheKey = () => 'xr-neon-tube-v1';
  // (wet or dry, a lamp's diffuser looks the same)
  m.userData.noWet = true;
  return m;
}

function glowMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  m.name = 'neonGlow';
  // additive colour, but keep the destination alpha: the wet-road shader stores its reflection flag there
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneFactor;
  m.blendSrcAlpha = THREE.ZeroFactor;
  m.blendDstAlpha = THREE.OneFactor;
  m.color.setScalar(0);
  return m;
}

export function makeNeonMats(ctx: Ctx): NeonMats {
  const tube = tubeMaterial();
  const tunnelTube = tubeMaterial();
  tunnelTube.name = 'neonTubeTunnel';
  const frame = new THREE.MeshStandardMaterial({ color: 0x2c3038, roughness: 0.5, metalness: 0.65, envMapIntensity: 0.9 });
  frame.name = 'neonFrame';
  const glow = glowMaterial();
  const tunnelGlow = glowMaterial();
  tunnelGlow.name = 'neonGlowTunnel';
  ctx.disposables.push(tube, tunnelTube, frame, glow, tunnelGlow);
  ctx.nightGlow.push({ mat: tube, day: 0, night: TUBE_NIGHT }, { mat: tunnelTube, day: TUBE_NIGHT * TUNNEL_DAY, night: TUBE_NIGHT });
  return { tube, tunnelTube, frame, glow, tunnelGlow };
}

/** The buffers the builders fill, and what they all need to know of the circuit. */
export class NeonKit {
  readonly rt: TrackRuntimeImpl;
  private readonly tubes: (GeoBuf | undefined)[] = [];
  private readonly glows: (GeoBuf | undefined)[] = [];
  readonly frame = new GeoBuf();
  readonly tunnelTube = new GeoBuf();
  readonly tunnelGlow = new GeoBuf();

  constructor(readonly ctx: Ctx, readonly def: NeonDef) {
    this.rt = ctx.rt;
  }

  private slot(list: (GeoBuf | undefined)[], s: number): GeoBuf {
    const k = Math.min(Math.floor(this.rt.wrapS(s) / NEON_CHUNK), Math.ceil(this.rt.length / NEON_CHUNK) - 1);
    return (list[k] ??= new GeoBuf());
  }
  /** The tube buffer of the stretch of the lap that holds s. */
  tube(s: number): GeoBuf {
    return this.slot(this.tubes, s);
  }
  glow(s: number): GeoBuf {
    return this.slot(this.glows, s);
  }
  sOf(m: Mark): number {
    return resolveMark(this.rt.plan.marks, this.rt.length, m);
  }
  /** The sample at s (0 .. count - 1). */
  index(s: number): number {
    return Math.round(this.rt.wrapS(s) / this.rt.spacing) % this.rt.count;
  }
  inTunnel(s: number): boolean {
    const w = this.rt.wrapS(s);
    for (const [a, b] of this.rt.tunnelSpans) if (w >= a && w <= b) return true;
    return false;
  }

  /** Turn the buffers into meshes. Returns the glow sheets outside the tunnels (hidden by day). */
  finish(group: THREE.Group, mats: NeonMats): THREE.Mesh[] {
    const sheets: THREE.Mesh[] = [];
    const add = (buf: GeoBuf | undefined, mat: THREE.Material, name: string, kind: 'tube' | 'glow' | 'frame'): THREE.Mesh | null => {
      if (!buf || buf.empty) return null;
      const geo = buf.build();
      geo.deleteAttribute('uv');
      if (kind === 'glow') geo.deleteAttribute('normal');
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = name;
      mesh.castShadow = kind === 'frame';
      mesh.receiveShadow = kind !== 'glow';
      if (kind === 'glow') mesh.renderOrder = 3;
      group.add(mesh);
      return mesh;
    };
    const n = Math.max(this.tubes.length, this.glows.length);
    for (let k = 0; k < n; k++) {
      add(this.tubes[k], mats.tube, `neon_tube_${k}`, 'tube');
      const g = add(this.glows[k], mats.glow, `neon_glow_${k}`, 'glow');
      if (g) sheets.push(g);
    }
    add(this.frame, mats.frame, 'neon_frame', 'frame');
    add(this.tunnelTube, mats.tunnelTube, 'neon_tube_tunnel', 'tube');
    add(this.tunnelGlow, mats.tunnelGlow, 'neon_glow_tunnel', 'glow');
    return sheets;
  }
}

/** A vertex with a colour (times k). */
export function nv(buf: GeoBuf, x: number, y: number, z: number, nx: number, ny: number, nz: number, c: RGB, k = 1): number {
  const i = buf.v(x, y, z, nx, ny, nz, 0, 0);
  buf.color(c[0] * k, c[1] * k, c[2] * k);
  return i;
}

export const WHITE: RGB = [1, 1, 1];
/** A vertex of the plain structure (its buffer carries no colours). */
export function fv(buf: GeoBuf, x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
  return buf.v(x, y, z, nx, ny, nz, 0, 0);
}

/** A quad wound so that it faces (nx, ny, nz). */
export function nquad(buf: GeoBuf, a: number, b: number, c: number, d: number, nx: number, ny: number, nz: number): void {
  const P = buf.pos;
  const ux = P[b * 3] - P[a * 3];
  const uy = P[b * 3 + 1] - P[a * 3 + 1];
  const uz = P[b * 3 + 2] - P[a * 3 + 2];
  const vx = P[d * 3] - P[a * 3];
  const vy = P[d * 3 + 1] - P[a * 3 + 1];
  const vz = P[d * 3 + 2] - P[a * 3 + 2];
  const gx = uy * vz - uz * vy;
  const gy = uz * vx - ux * vz;
  const gz = ux * vy - uy * vx;
  if (gx * nx + gy * ny + gz * nz >= 0) buf.quad(a, b, c, d);
  else buf.quad(a, d, c, b);
}
