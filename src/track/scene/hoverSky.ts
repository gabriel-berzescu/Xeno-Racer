/**
 * The traffic in the sky of an orbital circuit (`HoverDef.lanes`): a few long lanes of craft, far fewer and slower than a megacity's,
 * with long gaps between them: unhurried. By day a craft is a pale speck in the sun; after dark a white lamp ahead and a lamp of the
 * circuit's colour behind.
 *
 * A lane is laid out on the map (east, north) at a height over the floor, and inside a ring it follows the floor: a lane that runs
 * north or south climbs into the sky with the land, which is the plainest way there is of showing where one is. One instanced draw
 * call of sprites that face the eye, additive, moved in the vertex shader from one clock (the megacity's neonSky.ts is its twin and
 * is left as it is). A craft beyond the camera's far plane is drawn on it: the lanes are longer than the view.
 */
import * as THREE from 'three';
import type { EnvironmentState } from '../../core/contracts';
import { mulberry32 } from '../math';
import type { HoverDef } from '../types';
import type { Ctx } from './ctx';

/** Metres between two craft of a lane, on average, and their speed (m/s), where the lane does not say. */
const GAP = 520;
const SPEED = 24;
/** A craft's lights as one lamp (m), and the least it is drawn at (radians of the view). */
const SIZE = 3.2;
const MIN_ANGLE = 0.0015;
/** Radiance of a headlamp at night, and of a hull in the sun by day (scene units). */
const NIGHT = 6.0;
const DAY = 1.5;

const VERT = /* glsl */ `
uniform float uTime;
uniform float uNight;
uniform vec3 uDay;
uniform float uHaze;
uniform vec3 uTail;
uniform vec3 uRing;      // the ring's radius (0: flat ground), the north of its lowest line, the floor's height there
attribute vec4 aFrom;    // where the lane starts (east, north), its height over the floor, the craft's place along it at time 0 (m)
attribute vec4 aWay;     // the lane's direction on the map (east, north), its length (m), the craft's speed (m/s)
attribute vec2 aCraft;   // 0 = the lamp ahead / 1 = the lamp behind, how bright
varying vec2 vUv;
varying vec3 vCol;
void main() {
  float len = aWay.z;
  float tail = aCraft.x;
  float u = mod(aFrom.w + aWay.w * uTime, len);
  vec2 en = aFrom.xy + aWay.xy * (u - tail * 9.0);
  float h = aFrom.z;
  vec3 p = vec3(-en.x, uRing.z + h, en.y);
  vec3 dir = vec3(-aWay.x, 0.0, aWay.y);
  if (uRing.x > 0.0) {
    // on the inside of a cylinder whose axis runs east-west: the north is an arc of the floor
    float th = (en.y - uRing.y) / uRing.x;
    float rr = uRing.x - h;
    float sh = sin(th * 0.5);
    p.y += rr * 2.0 * sh * sh;
    p.z = uRing.y + rr * sin(th);
    dir = normalize(vec3(-aWay.x, aWay.y * sin(th), aWay.y * cos(th)));
  }
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float dist = max(-mv.z, 1.0);
  // the lamp ahead is seen from ahead of the craft, the lamp behind from behind it; a little of both from the side
  float ahead = dot(normalize(cameraPosition - p), dir);
  float seen = 0.2 + 0.8 * smoothstep(-0.2, 0.3, mix(ahead, -ahead, tail));
  // the lane fades in and out at its ends
  float ends = smoothstep(0.0, 500.0, u) * (1.0 - smoothstep(len - 500.0, len, u));
  float size = max(${SIZE.toFixed(2)}, dist * ${MIN_ANGLE.toFixed(4)});
  float spread = ${SIZE.toFixed(2)} / size;
  mv.xy += position.xy * size;
  gl_Position = projectionMatrix * mv;
  // (beyond the far plane: on it)
  gl_Position.z = min(gl_Position.z, gl_Position.w * 0.99995);
  vec3 lamp = mix(vec3(1.0, 0.95, 0.86), uTail, tail) * (uNight * aCraft.y * seen);
  // by day the craft itself: one speck, not two
  vec3 hull = uDay * (1.0 - tail);
  vCol = (lamp + hull) * (ends * spread * spread * exp(-dist * uHaze));
  vUv = position.xy;
}
`;

const FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
void main() {
  float d2 = dot(vUv, vUv);
  float a = exp(-d2 * 6.0) - 0.0025;
  if (a <= 0.0) discard;
  gl_FragColor = vec4(vCol * a, 1.0);
}
`;

export function buildSkyLanes(ctx: Ctx, def: HoverDef): { mesh: THREE.Mesh; triangles: number } | null {
  const lanes = def.lanes;
  if (!lanes?.length) return null;
  const rt = ctx.rt;
  const rng = mulberry32((rt.def.seed ^ 0x5c1e5) >>> 0);
  const from: number[] = [];
  const way: number[] = [];
  const craft: number[] = [];
  for (const lane of lanes) {
    const de = lane.to[0] - lane.from[0];
    const dn = lane.to[1] - lane.from[1];
    const len = Math.hypot(de, dn);
    if (len < 1200) continue;
    const ue = de / len;
    const un = dn / len;
    const gap = lane.gap ?? GAP;
    const speed = lane.speed ?? SPEED;
    for (const dir of [1, -1]) {
      // the two ways fly side by side, one a little over the other
      const e0 = (dir > 0 ? lane.from[0] : lane.to[0]) - un * dir * 16;
      const n0 = (dir > 0 ? lane.from[1] : lane.to[1]) + ue * dir * 16;
      const h = lane.height + dir * 9;
      const n = Math.max(2, Math.round(len / gap));
      for (let i = 0; i < n; i++) {
        // (long, uneven gaps: now and then two craft in company)
        const u = ((i + 0.05 + 0.9 * rng()) / n) * len;
        const v = speed * (0.85 + 0.3 * rng());
        const bright = 0.55 + 0.45 * rng();
        for (const tail of [0, 1]) {
          from.push(e0, n0, h, u);
          way.push(ue * dir, un * dir, len, v);
          craft.push(tail, tail ? bright * 0.7 : bright);
        }
      }
    }
  }
  if (!from.length) return null;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute('aFrom', new THREE.InstancedBufferAttribute(new Float32Array(from), 4));
  geo.setAttribute('aWay', new THREE.InstancedBufferAttribute(new Float32Array(way), 4));
  geo.setAttribute('aCraft', new THREE.InstancedBufferAttribute(new Float32Array(craft), 2));
  geo.instanceCount = from.length / 4;
  const ring = rt.info.orbital;
  const tail = new THREE.Color(def.accent ?? rt.info.color);
  const uniforms = {
    uTime: { value: 0 },
    uNight: { value: 0 },
    uDay: { value: new THREE.Vector3() },
    uHaze: { value: 0.00012 },
    uTail: { value: new THREE.Vector3(tail.r + 0.25, tail.g + 0.25, tail.b + 0.25) },
    uRing: { value: ring ? new THREE.Vector3(ring.radius, ring.z, ring.y) : new THREE.Vector3(0, 0, rt.bounds.minY) },
  };
  const mat = new THREE.ShaderMaterial({ name: 'hoverSkyLanes', uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, fog: false, toneMapped: false });
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneFactor;
  mat.blendSrcAlpha = THREE.ZeroFactor;
  mat.blendDstAlpha = THREE.OneFactor;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'hover_sky_lanes';
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  ctx.disposables.push(geo, mat);
  ctx.updaters.push((dt) => {
    uniforms.uTime.value += dt;
  });
  ctx.envListeners.push((env: EnvironmentState) => {
    // the lamps show from dusk on; by day a hull in the sun, as bright as the sun is (none under a deck of cloud); rain hides the far ones
    const k = Math.min(1, Math.max(0, (env.darkness - 0.3) / 0.5));
    uniforms.uNight.value = NIGHT * k;
    const sun = Math.min(1, env.sunIntensity / 3) * (1 - k) * (1 - Math.min(1, env.rain * 2));
    uniforms.uDay.value.set(1.0, 0.97, 0.9).multiplyScalar(DAY * sun);
    uniforms.uHaze.value = 0.00012 + 0.0016 * env.rain;
  });
  return { mesh, triangles: 2 * geo.instanceCount };
}
