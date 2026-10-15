/**
 * Track sandbox: renders a track with a stand-in light rig (Sky + PMREM + sun with shadows + filmic tone mapping).
 *
 * URL params:
 *   track=aurelia|kuroyama   q=low|medium|high|ultra   veg=0..1   tod=golden|morning|noon|dusk|night
 *   s=1200 [d=0]             driver-eye camera 1.1 m above the road at s, looking down the track
 *   view=overview|aerial|grandstand|chase|tv|map|treelab   (tv: i=<index>)
 *   x,y,z,tx,ty,tz           free camera (position, target)     fov=62
 *   cs,cd,ch & ts,td,th      camera / target in track coordinates (s, lateral d, height above ground)
 *   lights=0..6              start lights state      anim=0 freezes update dt      tm=agx|aces
 *   wet=0..1 rain=0..1       env.wetness / env.rain (wet asphalt, puddles, ripples, darker verge)
 * Sets W.__READY__ and W.__STATS__ = { drawCalls, triangles, loadMs }.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { EnvironmentState, QualityLevel, TimeOfDay, TrackFrame } from '../../src/core/contracts';
import type { TrackScene } from '../../src/core/systems';
import { buildTrackScene, loadTrackRuntime } from '../../src/track';
import type { TrackRuntimeImpl } from '../../src/track';
import { drawMap } from './map';
import { buildTreeLab } from './treelab';

const q = new URLSearchParams(location.search);
const trackId = q.get('track') ?? 'aurelia';
const quality = (q.get('q') ?? 'high') as QualityLevel;
const vegetation = parseFloat(q.get('veg') ?? '0.85');
const tod = (q.get('tod') ?? (trackId === 'kuroyama' ? 'morning' : 'golden')) as TimeOfDay;
const view = q.get('view') ?? (q.has('s') ? 'drive' : 'overview');
const fov = parseFloat(q.get('fov') ?? '62');
const animOn = q.get('anim') !== '0';

const W = window as unknown as {
  __READY__?: boolean;
  __STATS__?: Record<string, number>;
  __SCENE__?: TrackScene;
  __RT__?: TrackRuntimeImpl;
  __CAM__?: THREE.PerspectiveCamera;
};

interface TodDef {
  elev: number;
  azim: number;
  turb: number;
  rayleigh: number;
  mie: number;
  mieG: number;
  sunColor: number;
  sunI: number;
  envI: number;
  fog: number;
  fogD: number;
  exposure: number;
  darkness: number;
}
const TODS: Record<TimeOfDay, TodDef> = {
  golden: { elev: 9, azim: 255, turb: 7, rayleigh: 2.4, mie: 0.006, mieG: 0.86, sunColor: 0xffc590, sunI: 3.3, envI: 0.85, fog: 0xc3c8cf, fogD: 0.00026, exposure: 0.62, darkness: 0 },
  morning: { elev: 20, azim: 95, turb: 5, rayleigh: 1.8, mie: 0.004, mieG: 0.82, sunColor: 0xffe2c0, sunI: 3.6, envI: 0.9, fog: 0xc9d6df, fogD: 0.00032, exposure: 0.6, darkness: 0 },
  noon: { elev: 58, azim: 180, turb: 3, rayleigh: 1.2, mie: 0.003, mieG: 0.8, sunColor: 0xfff4e6, sunI: 4.2, envI: 1.0, fog: 0xbfd2e0, fogD: 0.0004, exposure: 0.55, darkness: 0 },
  dawn: { elev: 4, azim: 100, turb: 6, rayleigh: 2.6, mie: 0.007, mieG: 0.88, sunColor: 0xffb98a, sunI: 2.4, envI: 0.7, fog: 0xd9b9a6, fogD: 0.0006, exposure: 0.62, darkness: 0.1 },
  dusk: { elev: 1.2, azim: 262, turb: 8, rayleigh: 3.0, mie: 0.008, mieG: 0.9, sunColor: 0xff9a5a, sunI: 2.0, envI: 0.55, fog: 0xc79a8a, fogD: 0.0007, exposure: 0.7, darkness: 0.45 },
  night: { elev: -12, azim: 262, turb: 2, rayleigh: 0.3, mie: 0.001, mieG: 0.7, sunColor: 0x7a8fc0, sunI: 0.25, envI: 0.06, fog: 0x0a0e18, fogD: 0.0009, exposure: 0.9, darkness: 1 },
};

const canvas = document.getElementById('c') as HTMLCanvasElement;
const mapCanvas = document.getElementById('map') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;

const rt = loadTrackRuntime(trackId) as TrackRuntimeImpl;
W.__RT__ = rt;

if (view === 'map') {
  canvas.style.display = 'none';
  mapCanvas.style.display = 'block';
  drawMap(mapCanvas, rt);
  W.__STATS__ = { drawCalls: 0, triangles: 0, loadMs: 0 };
  W.__READY__ = true;
} else {
  void main();
}

async function main(): Promise<void> {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = q.get('tm') === 'agx' ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
  const T = TODS[tod];
  renderer.toneMappingExposure = T.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, window.innerWidth / window.innerHeight, 0.15, 14000);
  W.__CAM__ = camera;

  // ── sky + environment ─────────────────────────────────────────────────────────
  const el = (T.elev * Math.PI) / 180;
  const az = (T.azim * Math.PI) / 180;
  const sunDir = new THREE.Vector3(-Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
  const makeSky = () => {
    const sky = new Sky();
    sky.scale.setScalar(450000);
    const u = sky.material.uniforms;
    u.turbidity.value = T.turb;
    u.rayleigh.value = T.rayleigh;
    u.mieCoefficient.value = T.mie;
    u.mieDirectionalG.value = T.mieG;
    u.sunPosition.value.copy(sunDir);
    return sky;
  };
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(makeSky());
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = T.envI;
  const skyMesh = makeSky();
  scene.add(skyMesh);
  scene.fog = new THREE.FogExp2(T.fog, T.fogD);

  const sun = new THREE.DirectionalLight(T.sunColor, T.sunI);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  sc.near = 10;
  sc.far = 900;
  sc.left = sc.bottom = -170;
  sc.right = sc.top = 170;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.35;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x4a5a38, tod === 'night' ? 0.02 : 0.18);
  scene.add(hemi);

  const wetQ = Math.min(1, Math.max(0, parseFloat(q.get('wet') ?? '0') || 0));
  const rainQ = Math.min(1, Math.max(0, parseFloat(q.get('rain') ?? '0') || 0));
  const env: EnvironmentState = {
    settings: { timeOfDay: tod, weather: rainQ > 0.7 ? 'storm' : rainQ > 0 || wetQ > 0 ? 'rain' : 'clear' },
    sunDirection: sunDir.clone(),
    sunIntensity: T.sunI,
    darkness: T.darkness,
    fogColor: '#' + new THREE.Color(T.fog).getHexString(),
    rain: rainQ,
    wetness: wetQ,
  };

  // ── track ─────────────────────────────────────────────────────────────────────
  const t0 = performance.now();
  const track =
    view === 'treelab'
      ? buildTreeLab(quality, env, q)
      : await buildTrackScene(rt, {
          quality,
          vegetation,
          env,
          renderer,
          onProgress: (f, label) => console.info(`[track] ${(f * 100).toFixed(0)}% ${label}`),
        });
  const loadMs = performance.now() - t0;
  W.__SCENE__ = track;
  scene.add(track.root);
  track.setEnvironment(env);
  if (q.has('lights')) track.setStartLights(parseInt(q.get('lights')!, 10));

  // ── camera placement ──────────────────────────────────────────────────────────
  const frame: TrackFrame = {
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    left: new THREE.Vector3(),
    widthLeft: 0,
    widthRight: 0,
    wallLeft: 0,
    wallRight: 0,
    curvature: 0,
    bank: 0,
  };
  const b = rt.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
  const tmp = new THREE.Vector3();

  const placeDrive = (s: number, d: number, h = 1.1) => {
    rt.frameAt(s, frame);
    rt.pointAt(s, d, tmp);
    camera.position.copy(tmp).addScaledVector(frame.normal, h);
    const target = new THREE.Vector3();
    rt.frameAt(s + 60, frame);
    rt.pointAt(s + 60, d * 0.5, target);
    target.y += h * 0.9;
    camera.lookAt(target);
  };

  if (q.has('cs')) {
    // camera in track coordinates: cs,cd,ch (s, lateral offset, height above ground) looking at ts,td,th
    const p = new THREE.Vector3();
    rt.pointAt(parseFloat(q.get('cs')!), parseFloat(q.get('cd') ?? '0'), p);
    camera.position.set(p.x, p.y + parseFloat(q.get('ch') ?? '2'), p.z);
    const tg = new THREE.Vector3();
    rt.pointAt(parseFloat(q.get('ts') ?? q.get('cs')!), parseFloat(q.get('td') ?? '0'), tg);
    camera.lookAt(tg.x, tg.y + parseFloat(q.get('th') ?? '1'), tg.z);
  } else if (q.has('x')) {
    camera.position.set(+q.get('x')!, +(q.get('y') ?? 20), +(q.get('z') ?? 0));
    camera.lookAt(+(q.get('tx') ?? cx), +(q.get('ty') ?? 0), +(q.get('tz') ?? cz));
  } else if (view === 'drive') {
    placeDrive(parseFloat(q.get('s') ?? '0'), parseFloat(q.get('d') ?? '0'), parseFloat(q.get('h') ?? '1.1'));
  } else if (view === 'chase') {
    const s = parseFloat(q.get('s') ?? '0');
    rt.frameAt(s, frame);
    rt.pointAt(s, parseFloat(q.get('d') ?? '0'), tmp);
    camera.position.copy(tmp).addScaledVector(frame.tangent, -7).addScaledVector(frame.normal, 2.3);
    camera.lookAt(tmp.clone().addScaledVector(frame.tangent, 25).addScaledVector(frame.normal, 0.6));
  } else if (view === 'aerial') {
    camera.up.set(0, 0, 1);
    camera.position.set(cx, span * 0.95, cz + 1);
    camera.lookAt(cx, 0, cz);
    camera.far = 30000;
  } else if (view === 'grandstand') {
    const s = parseFloat(q.get('s') ?? '40');
    rt.frameAt(s, frame);
    rt.pointAt(s, -(frame.wallRight + 30), tmp);
    camera.position.copy(tmp);
    camera.position.y += 7;
    rt.pointAt(s + 140, 4, tmp);
    camera.lookAt(tmp.x, tmp.y + 1.5, tmp.z);
  } else if (view === 'tv') {
    const i = parseInt(q.get('i') ?? '0', 10) % track.tvCameras.length;
    const c = track.tvCameras[i];
    camera.position.copy(c.position);
    rt.pointAt(c.s + 25, 0, tmp);
    camera.lookAt(tmp.x, tmp.y + 1, tmp.z);
  } else {
    // overview: raised three-quarter view from the south-west
    camera.position.set(cx - span * 0.15, span * 0.55, cz - span * 0.7);
    camera.lookAt(cx, b.minY, cz);
    camera.far = 30000;
  }

  // ── loop ──────────────────────────────────────────────────────────────────────
  const clock = new THREE.Clock();
  let frames = 0;
  let fps = 0;
  const dirOffset = sunDir.clone().multiplyScalar(500);
  const render = () => {
    const dt = animOn ? Math.min(clock.getDelta(), 0.1) : 0;
    if (!animOn) clock.getDelta();
    track.update(dt, camera);
    // keep the sun's shadow frustum around the camera
    sun.position.copy(camera.position).add(dirOffset);
    sun.target.position.copy(camera.position);
    sun.target.updateMatrixWorld();
    renderer.render(scene, camera);
    frames++;
    W.__STATS__ = {
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      loadMs: Math.round(loadMs),
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      fps,
    };
    if (frames % 20 === 0) {
      const now = performance.now();
      fps = 20000 / Math.max(1, now - lastT);
      lastT = now;
      hud.textContent = `${trackId}  ${quality}  ${fps.toFixed(0)} fps  calls ${renderer.info.render.calls}  tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k  load ${loadMs.toFixed(0)} ms`;
    }
    requestAnimationFrame(render);
  };
  let lastT = performance.now();
  // draw-call / triangle breakdown of what the camera currently sees, grouped by object name prefix
  (window as unknown as { __BREAKDOWN__: () => Record<string, { calls: number; tris: number }> }).__BREAKDOWN__ = () => {
    const fr = new THREE.Frustum();
    fr.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const out: Record<string, { calls: number; tris: number }> = {};
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      let vis = true;
      for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) vis = false;
      if (!vis || (m.frustumCulled && !fr.intersectsObject(m))) return;
      const g = m.geometry;
      const idx = g.index ? g.index.count : g.attributes.position.count;
      const n = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
      const parts = (m.name || '(unnamed)').split('_');
      const key = parts[0] + (['tile', 'tree0', 'tree1', 'bar', 'prop'].includes(parts[0]) ? '_' + parts[1] : '');
      const e = (out[key] ??= { calls: 0, tris: 0 });
      e.calls += 1;
      e.tris += Math.round((idx / 3) * n);
    });
    return out;
  };
  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });
  // hole scanner (dev tool): render a top-down view over a world-space rectangle against a magenta background and
  // count magenta pixels. Anything magenta is a gap in the ground / road meshes.
  (window as unknown as Record<string, unknown>).__SCAN__ = (cx: number, cz: number, halfW: number, y: number, px = 1024): number => {
    const sc = new THREE.Scene();
    sc.add(track.root);
    sc.background = new THREE.Color(0xff00ff);
    const cam = new THREE.OrthographicCamera(-halfW, halfW, halfW, -halfW, 1, y + 2000);
    cam.position.set(cx, y, cz);
    cam.up.set(0, 0, -1);
    cam.lookAt(cx, 0, cz);
    cam.updateMatrixWorld();
    const rt = new THREE.WebGLRenderTarget(px, px, { depthBuffer: true });
    const prevTM = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = false;
    renderer.setRenderTarget(rt);
    renderer.render(sc, cam);
    renderer.setRenderTarget(null);
    renderer.shadowMap.enabled = true;
    renderer.toneMapping = prevTM;
    const buf = new Uint8Array(px * px * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, px, px, buf);
    rt.dispose();
    scene.add(track.root);
    let n = 0;
    const hits: number[] = [];
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i] > 200 && buf[i + 1] < 90 && buf[i + 2] > 200) {
        n++;
        if (hits.length < 40) {
          const k = i / 4;
          // world position of the pixel (top-down view, up = -z: image x -> world x; rows are read bottom-first, so row 0 is the largest z)
          hits.push(Math.round(cx - halfW + ((k % px) + 0.5) * ((2 * halfW) / px)), Math.round(cz + halfW - (Math.floor(k / px) + 0.5) * ((2 * halfW) / px)));
        }
      }
    }
    (window as unknown as Record<string, unknown>).__SCAN_HITS__ = hits;
    (window as unknown as Record<string, unknown>).__SCAN_BUF__ = buf;
    return n;
  };
  void skyMesh;
  render();
  // two frames so shadows / env are settled before the screenshot tool looks
  requestAnimationFrame(() => requestAnimationFrame(() => (W.__READY__ = true)));
}
