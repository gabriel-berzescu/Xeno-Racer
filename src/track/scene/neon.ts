/**
 * The night dressing of a megacity circuit (`SceneryDef.neon`): light strips along the walls, rings of light over the road, hoops in
 * the tunnels, traffic in the sky. Nothing here is physical: the cars drive through all of it.
 *
 * Everything that glows is one of two materials, so that the whole dressing is a handful of programs and a few dozen draw calls:
 *
 *   tube   a lit diffuser (pale by day) whose emissive is the vertex colour times a level that follows the darkness: the strips, the
 *          tubes of the rings, the hoops. A crisp line that the bloom gives a halo.
 *   glow   the light a tube throws on what is next to it, painted on: an additive sheet with the colour in its vertices, lying on the
 *          road under a strip or a ring, on the tunnel lining around a hoop (emissive surfaces light nothing by themselves).
 *
 * The tunnels have an instance of each of their own: a tunnel is lit by day too. The structure that carries the tubes (the rings'
 * frames and plinths, the hoops' ribs) is a third, plain material. The geometry is merged per stretch of the lap (`NEON_CHUNK`), so a
 * view draws the few stretches it sees.
 *
 *   neon.ts         the build
 *   neonKit.ts      the kit: materials, buffers per stretch, vertex helpers
 *   neonStrips.ts   the strips along the walls and their light on the road
 *   neonRings.ts    the rings over the road
 *   neonHolo.ts     the hologram hovering over the Halo's road
 *   neonTunnel.ts   the hoops, the lines at the foot of the walls and the portals of a tunnel
 *   neonSky.ts      the traffic in the sky
 */
import * as THREE from 'three';
import type { EnvironmentState } from '../../core/contracts';
import type { Ctx } from './ctx';
import { GLOW_NIGHT, NeonKit, TUNNEL_DAY, makeNeonMats } from './neonKit';
import { buildHologram } from './neonHolo';
import { buildRings, reserveRings } from './neonRings';
import { buildSkyTraffic } from './neonSky';
import { buildStrips } from './neonStrips';
import { buildTunnelNeon } from './neonTunnel';
import { lampTintFactors } from './wet';

/** The ground the rings stand on, kept clear of buildings: called before the city is built. */
export function reserveNeon(ctx: Ctx): void {
  const def = ctx.rt.def.scenery?.neon;
  if (def) reserveRings(ctx, def);
}

/**
 * More lamp heads for the lights that are cast from them (the render side's lit materials, lit rain and halos, the wet road): the
 * hoops of a tunnel, which have no post, no head and no pool on the road. The heads are published by the props (`userData.xrLamps`,
 * `ctx.lamps`); the list is replaced by a longer one, there and here.
 */
function addLampHeads(ctx: Ctx, group: THREE.Group, heads: number[]): void {
  if (!heads.length) return;
  let owner: THREE.Object3D = group;
  ctx.root.traverse((o) => {
    if (owner === group && o.userData.xrLamps) owner = o;
  });
  const old = (owner.userData.xrLamps as Float32Array | undefined) ?? new Float32Array(0);
  const all = new Float32Array(old.length + heads.length);
  all.set(old);
  all.set(heads, old.length);
  owner.userData.xrLamps = all;
  ctx.lamps = all;
  // (a circuit with no lamp posts at all: the tint the props would have published beside the heads)
  const tint = ctx.rt.def.scenery?.neon?.lampTint;
  if (owner === group && tint !== undefined) group.userData.xrLampTint = lampTintFactors(tint);
}

export function buildNeon(ctx: Ctx): THREE.Group | null {
  const def = ctx.rt.def.scenery?.neon;
  if (!def) return null;
  const group = new THREE.Group();
  group.name = 'neon';
  const mats = makeNeonMats(ctx);
  const kit = new NeonKit(ctx, def);
  buildStrips(kit);
  buildRings(kit);
  addLampHeads(ctx, group, buildTunnelNeon(kit));
  const sheets = kit.finish(group, mats);
  const sky = buildSkyTraffic(ctx, def);
  if (sky) group.add(sky);
  const holo = buildHologram(ctx, def);
  if (holo) group.add(holo);

  ctx.envListeners.push((env: EnvironmentState) => {
    // the same switch as the tubes' own (buildScene's nightGlow)
    const k = Math.min(1, Math.max(0, (env.darkness - 0.15) / 0.7));
    // a wet road is darker and throws light away from the eye: the painted light is fainter on it, and the reflections take over
    const wet = 1 - 0.45 * Math.min(1, env.wetness * 2);
    // (and it comes up later than the tubes do: at dusk the road is still lit by the sky, and a light shows on it less than it will)
    mats.glow.color.setScalar(GLOW_NIGHT * k * k * wet);
    const on = k > 0.02;
    for (const m of sheets) m.visible = on;
    mats.tunnelGlow.color.setScalar(GLOW_NIGHT * (TUNNEL_DAY + (1 - TUNNEL_DAY) * k));
  });
  return group;
}
