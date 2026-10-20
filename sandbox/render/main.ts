/**
 * Render sandbox (owner: render).
 *
 *   sandbox/render.html?tod=golden&weather=clear&quality=high&cam=chase
 *
 * Query parameters
 *   tod       dawn | morning | noon | golden | dusk | night          (default golden)
 *   weather   clear | cloudy | overcast | rain | storm              (default clear; rain/storm: wet road, spray, rain)
 *   quality   low | medium | high | ultra                            (default high)
 *   cam       free | chase | chase-far | hood | bumper | cockpit | tv | orbit
 *             free = fixed photo cameras (see view), the others use the real camera rig
 *   view      hero | sky | sun | away | wide | ring | follow | side | top   (when cam=free)
 *             hero: viewAz (angle to the sun azimuth), dist, camY; follow/side: dist, camY, side
 *   scene     drift | eight | donut | wall | launch | cruise | grid   (default drift, procedural world)
 *   track     aurelia | kuroyama : use the REAL track scene (and real car visuals) instead of the
 *             procedural world; synthetic cars lap the centreline (v = speed m/s, s = start, d = lateral)
 *   realcars  1 = use src/carvis visuals even in the procedural world
 *   surface   gravel | grass | sand | dirt : force the wheel surface type of the synthetic cars (effects test)
 *   t         simulated seconds to fast-forward before the first frame (deterministic shots)
 *   freeze    1 = stop the simulation after the fast-forward
 *   shadows / aa / ao / bloom / mb / scale   override graphics settings
 *   tm        agx | aces      exp   exposure multiplier      aoDebug  ao | split
 *   speed     override the speed fed to the speed effects (m/s)
 *   shake     camera shake 0..1 (rig modes)    fov  base FOV
 *   w, h      canvas size (default window size)
 *   bench=1   measure 300 frames unthrottled, result in window.__BENCH__ (see bench.mjs)
 *   profile=1 per-pass GPU timing into stats.passMs
 *   cycle=low,high,...&every=40   apply quality presets live (exercises applyGraphics)
 * Keys (rig modes): C next camera, arrows look, B hold = look back.
 *
 * Dev tools next to this file: matrix.mjs (screenshot matrix of any parameters), probe.mjs (black-frame / NaN
 * detector via window.__PROBE__), perfwet.mjs (real-game GPU cost of dry vs rain vs storm), parity.mjs (picture
 * diff against a second dev server, used to prove the dry looks did not change).
 *
 * window.__READY__ is set after the first frames; window.__STATS__ exposes frame statistics.
 */
import { Object3D, PerspectiveCamera, Vector3 } from 'three';
import { CARS } from '../../src/cars';
import type { CarDefinition, CameraMode, GraphicsSettings, QualityLevel, TimeOfDay, TrackRuntime, VehicleState, Weather } from '../../src/core/contracts';
import { QUALITY_PRESETS } from '../../src/core/settings';
import type { CameraRig, TrackScene } from '../../src/core/systems';
import { createEffects } from '../../src/render/effects';
import { createRenderSystem } from '../../src/render/renderSystem';
import { PlaceholderCar, SyntheticCar, type Anchors, type Pattern } from './cars';
import { makeRingTrack } from './fakeTrack';
import { buildWorld, RING_RADIUS } from './world';

declare global {
  interface Window {
    __READY__?: boolean;
    __STATS__?: unknown;
    __SANDBOX__?: unknown;
  }
}

const q = new URLSearchParams(location.search);
const str = (k: string, d: string) => q.get(k) ?? d;
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const flag = (k: string): boolean | undefined => (q.has(k) ? q.get(k) !== '0' && q.get(k) !== 'false' && q.get(k) !== 'off' : undefined);

const tod = str('tod', 'golden') as TimeOfDay;
const weather = str('weather', 'clear') as Weather;
const quality = str('quality', 'high') as QualityLevel;
const camMode = str('cam', 'free');
const view = str('view', 'hero');
const sceneName = str('scene', 'drift');
const trackId = q.get('track');
const simT = num('t', 0);
const freeze = flag('freeze') ?? false;

const canvas = document.getElementById('game') as HTMLCanvasElement;
if (q.has('w')) canvas.style.width = `${num('w', 1600)}px`;
if (q.has('h')) canvas.style.height = `${num('h', 900)}px`;

const graphics: GraphicsSettings = { ...QUALITY_PRESETS[quality] };
const sh = q.get('shadows');
if (sh === 'off' || sh === 'low' || sh === 'high') graphics.shadows = sh;
const aa = q.get('aa');
if (aa === 'off' || aa === 'fxaa' || aa === 'smaa') graphics.antialias = aa;
graphics.ambientOcclusion = flag('ao') ?? graphics.ambientOcclusion;
graphics.bloom = flag('bloom') ?? graphics.bloom;
graphics.motionBlur = flag('mb') ?? graphics.motionBlur;
graphics.renderScale = num('scale', graphics.renderScale);

interface CarVis {
  root: Object3D;
  anchors: Anchors;
  update(state: VehicleState, dt: number): void;
  /** Real car visuals only: show the interior / hide the roof for the cockpit camera. */
  cockpit?(on: boolean): void;
}

const raw = window as unknown as Record<string, unknown>;

async function main(): Promise<void> {
  const render = await createRenderSystem(canvas, graphics);
  await render.setEnvironment({ timeOfDay: tod, weather });
  const tm = q.get('tm');
  if (tm === 'aces' && render.debug.final) render.debug.final.mode = 'aces';
  if (q.get('aoDebug') && render.debug.ao) render.debug.ao.setDisplayMode(q.get('aoDebug') === 'ao' ? 'AO' : 'Split');
  if (flag('profile')) render.debug.profile = true;
  if (q.has('exp') && render.debug.final) render.debug.final.exposure = render.debug.final.exposure * num('exp', 1);

  // ── world: the real track, or the procedural one ──
  let track: TrackRuntime;
  let trackScene: TrackScene | null = null;
  let world: { update(dt: number): void } | null = null;
  let tvCameras: TrackScene['tvCameras'] = [];
  if (trackId) {
    const { loadTrackRuntime, buildTrackScene } = await import('../../src/track');
    track = loadTrackRuntime(trackId);
    trackScene = await buildTrackScene(track, { quality, vegetation: graphics.vegetation, env: render.env, renderer: render.renderer });
    // where the hills hide the sun from the circuit (the game does the same once its track scene is built)
    await render.setTerrain(trackScene.terrain ?? null);
    render.scene.add(trackScene.root);
    trackScene.setEnvironment(render.env);
    tvCameras = trackScene.tvCameras;
  } else {
    const w = buildWorld();
    render.scene.add(w.root);
    world = w;
    track = makeRingTrack();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.2;
      tvCameras.push({ position: new Vector3(Math.cos(a) * (RING_RADIUS + 22), 5, Math.sin(a) * (RING_RADIUS + 22)), s: (a / (Math.PI * 2)) * track.length });
    }
  }

  // ── cars ──
  const PAD_Z = 45;
  const patternFor: Record<string, Pattern> = { drift: 'drift', eight: 'eight', donut: 'donut', wall: 'wall', launch: 'launch', cruise: 'cruise', grid: 'static' };
  const mainPattern = patternFor[sceneName] ?? 'drift';
  const synth: SyntheticCar[] = [];
  const visuals: CarVis[] = [];
  const useReal = !!trackId || flag('realcars') === true;

  const makeVisual = async (def: CarDefinition, i: number): Promise<CarVis> => {
    if (useReal) {
      try {
        const { createCarVisual } = await import('../../src/carvis');
        const v = await createCarVisual(def, def.defaultLivery, quality);
        v.setPlayer(i === 0);
        return { root: v.root, anchors: v.anchors as unknown as Anchors, update: (s, dt) => v.update(s, dt, render.env), cockpit: (on) => v.setCockpitView(on) };
      } catch (e) {
        console.warn('real car visual failed, using placeholder:', e);
      }
    }
    const p = new PlaceholderCar(def, ['#1c2c5a', '#d0102b', '#f2c200', '#0e0f13'][i % 4]);
    return { root: p.root, anchors: p.anchors, update: (s) => p.update(s) };
  };
  const addCar = async (i: number, pattern: Pattern, opts: ConstructorParameters<typeof SyntheticCar>[3]) => {
    const def = CARS[(num('car', 0) + i) % CARS.length];
    const s = new SyntheticCar(i, def, pattern, opts);
    const v = await makeVisual(def, i);
    v.root.name = `car${i}`;
    render.scene.add(v.root);
    synth.push(s);
    visuals.push(v);
  };
  if (trackId) {
    const v0 = num('v', 48);
    const s0 = num('s', 20);
    await addCar(0, 'lap', { track, s: s0, d: num('d', 0), speed: v0 });
    await addCar(1, 'lap', { track, s: s0 + 45, d: -4, speed: v0 * 0.97 });
    await addCar(2, 'lap', { track, s: s0 - 70, d: 3, speed: v0 * 1.02 });
  } else if (sceneName === 'grid') {
    for (let i = 0; i < 4; i++) await addCar(i, 'static', { x: -9 + i * 6, z: 0 + (i % 2) * 5, heading: 0.1 * i, speed: 0 });
  } else if (sceneName === 'wall') {
    await addCar(0, 'wall', { x: -20, z: -PAD_Z + 7.2, heading: Math.PI / 2, speed: 22 });
  } else if (sceneName === 'launch') {
    await addCar(0, 'launch', { x: 0, z: -30, heading: 0, speed: 10 });
  } else if (sceneName === 'cruise') {
    await addCar(0, 'ring', { speed: num('v', 55) });
  } else {
    await addCar(0, mainPattern, { x: 0, z: 0, heading: 0, speed: mainPattern === 'donut' ? 14 : 19, radius: mainPattern === 'donut' ? 6.5 : 26, dir: 1 });
    await addCar(1, 'circle', { x: 28, z: -18, heading: 1.0, speed: 17, radius: 22, dir: -1 });
  }

  // ── camera: fixed photo cameras or the real rig ──
  let rig: CameraRig | null = null;
  if (camMode !== 'free') {
    const { createCameraRig } = await import('../../src/render/cameraRig');
    rig = createCameraRig(track, tvCameras);
    rig.setFov(num('fov', 62));
    rig.setShake(num('shake', 0.6));
    rig.setMode(camMode as CameraMode);
  }
  const photoCam = new PerspectiveCamera(num('fov', 60), innerWidth / innerHeight, 0.15, 6000);
  const camera = (): PerspectiveCamera => (rig ? rig.camera : photoCam);
  const sunDir = render.env.sunDirection;
  const effects = createEffects(render, track, graphics.quality);
  for (let i = 0; i < synth.length; i++) effects.registerCar(synth[i].id, synth[i].def);
  const states = synth.map((s) => s.state);
  const surf = q.get('surface');
  if (surf) for (const c of synth) c.surfaceOverride = surf as never;
  const look = { x: 0, y: 0, back: false };
  const keys = new Set<string>();
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    keys.add(e.key.toLowerCase());
    if (e.key.toLowerCase() === 'c' && rig) console.log('camera ->', rig.next());
  });
  window.addEventListener('keyup', (e: KeyboardEvent) => keys.delete(e.key.toLowerCase()));
  const readKeys = () => {
    look.x = (keys.has('arrowright') ? 1 : 0) - (keys.has('arrowleft') ? 1 : 0);
    look.y = (keys.has('arrowup') ? 1 : 0) - (keys.has('arrowdown') ? 1 : 0);
    look.back = keys.has('b');
  };

  function placeFreeCamera(): void {
    const c0 = synth[0].state.position;
    const camera = photoCam;
    switch (view) {
      case 'sky': {
        const az = new Vector3(sunDir.x, 0, sunDir.z).normalize();
        camera.position.set(-az.x * 10, 1.7, -az.z * 10);
        camera.lookAt(az.x * 100, 22 + sunDir.y * 40, az.z * 100);
        break;
      }
      case 'sun': {
        // look straight at the sun / moon, offset by sunOff degrees of elevation
        const off = (num('sunOff', 6) * Math.PI) / 180;
        const el = Math.asin(sunDir.y) + off;
        const az = new Vector3(sunDir.x, 0, sunDir.z).normalize();
        camera.position.set(c0.x - az.x * num('dist', 14), c0.y - 0.4 + num('camY', 1.6), c0.z - az.z * num('dist', 14));
        camera.lookAt(camera.position.x + az.x * Math.cos(el) * 100, camera.position.y + Math.sin(el) * 100, camera.position.z + az.z * Math.cos(el) * 100);
        break;
      }
      case 'away': {
        const az = new Vector3(sunDir.x, 0, sunDir.z).normalize();
        camera.position.set(az.x * 14, 1.7, az.z * 14);
        camera.lookAt(-az.x * 100, 12, -az.z * 100);
        break;
      }
      case 'follow': {
        const st = synth[0].state;
        const fx = Math.sin(synth[0].yaw), fz = Math.cos(synth[0].yaw);
        const d = num('dist', 7);
        camera.position.set(st.position.x - fx * d, st.position.y - 0.45 + num('camY', 1.6), st.position.z - fz * d);
        camera.lookAt(st.position.x + fx * 4, st.position.y + 0.25, st.position.z + fz * 4);
        break;
      }
      case 'side': {
        const st = synth[0].state;
        const lx = Math.cos(synth[0].yaw), lz = -Math.sin(synth[0].yaw);
        const sgn = num('side', 1);
        const d = num('dist', 5);
        camera.position.set(st.position.x + lx * d * sgn, st.position.y - 0.45 + num('camY', 0.8), st.position.z + lz * d * sgn);
        camera.lookAt(st.position.x, st.position.y, st.position.z);
        break;
      }
      case 'top':
        camera.position.set(c0.x + 0.01, c0.y + num('camY', 70), c0.z + 0.01);
        camera.lookAt(c0.x, c0.y, c0.z);
        break;
      case 'wide':
        camera.position.set(-60, 14, -70);
        camera.lookAt(0, 3, 0);
        break;
      case 'ring':
        camera.position.set(RING_RADIUS + 40, 6, -40);
        camera.lookAt(RING_RADIUS - 20, 2, 10);
        break;
      default: {
        // hero: low 3/4 shot. viewAz = angle between the view direction and the sun azimuth
        // (0 = looking into the sun, 90 = sun from the side, 180 = sun behind the camera).
        const az = new Vector3(sunDir.x, 0, sunDir.z).normalize();
        const a = (num('viewAz', 60) * Math.PI) / 180;
        const vx = az.x * Math.cos(a) - az.z * Math.sin(a);
        const vz = az.x * Math.sin(a) + az.z * Math.cos(a);
        const dist = num('dist', 9);
        camera.position.set(c0.x - vx * dist, c0.y - 0.45 + num('camY', 1.1), c0.z - vz * dist);
        camera.lookAt(c0.x, c0.y + 0.3, c0.z);
      }
    }
  }

  /** Drive the active camera (rig or photo camera) for one step. */
  let cockpitOn = false;
  const updateCamera = (dt: number): void => {
    if (rig) {
      const want = rig.mode === 'cockpit';
      if (want !== cockpitOn) {
        cockpitOn = want;
        visuals[0].cockpit?.(want);
      }
      const st = synth[0].state;
      rig.update(dt, { state: st, anchors: visuals[0].anchors as never }, look);
    } else placeFreeCamera();
    camera().updateMatrixWorld();
  };

  // ── fast-forward (deterministic shots) ──
  const FIXED = 1 / 60;
  const poseVisuals = (dt: number) => {
    for (let i = 0; i < synth.length; i++) visuals[i].update(synth[i].state, dt);
  };
  const stepSim = (dt: number) => {
    for (const s of synth) s.step(dt);
    poseVisuals(dt);
    updateCamera(dt);
    trackScene?.update(dt, camera());
    effects.update(dt, states, camera());
  };
  poseVisuals(0);
  rig?.snap();
  updateCamera(FIXED);
  for (let t = 0; t < simT; t += FIXED) stepSim(FIXED);
  render.setCloudTime(num('cloud', simT));

  raw.__SANDBOX__ = { render, synth, visuals, camera: camera(), rig, effects, track, trackScene };

  const resize = () => {
    const w = q.has('w') ? num('w', innerWidth) : innerWidth;
    const h = q.has('h') ? num('h', innerHeight) : innerHeight;
    render.resize(w, h);
    photoCam.aspect = w / h;
    photoCam.updateProjectionMatrix();
    rig?.setAspect(w / h);
  };
  addEventListener('resize', resize);
  resize();

  /**
   * Shimmer test: render the (static) scene twice with the shadow focus moved by (dx, dz) metres and
   * report how many pixels of a screen region changed. With texel snapping only a handful do;
   * without it shadow edges crawl.
   */
  raw.__SHIMMER__ = (dx: number, dz: number, snap: boolean) => {
    render.sun.snap = snap;
    render.sun.markDirty();
    const ditherU = render.debug.final?.uniforms.get('dither');
    if (ditherU) ditherU.value = 0;
    updateCamera(0.0001);
    const gl = render.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const rx = Math.floor(w * 0.2), ry = Math.floor(h * 0.45), rw = Math.floor(w * 0.6), rh = Math.floor(h * 0.45);
    const grab = (fx: number, fz: number) => {
      render.setFocus(new Vector3(fx, 0, fz));
      for (let i = 0; i < 2; i++) render.render(camera(), 1 / 60, 0);
      const buf = new Uint8Array(rw * rh * 4);
      gl.readPixels(rx, ry, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return buf;
    };
    const base = synth[0].state.position;
    const a = grab(base.x, base.z);
    const b = grab(base.x + dx, base.z + dz);
    let sum = 0, max = 0, o1 = 0, o3 = 0, o8 = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      sum += d;
      if (d > max) max = d;
      if (d > 1) o1++;
      if (d > 3) o3++;
      if (d > 8) o8++;
    }
    render.sun.snap = true;
    if (ditherU) ditherU.value = 1;
    return { meanAbs: +(sum / (a.length / 4)).toFixed(4), max, over1: o1, over3: o3, over8: o8, of: a.length / 4 };
  };
  /** Render one frame and return the mean colour of a 24x14 pixel grid of the canvas (black-frame detector). */
  raw.__PROBE__ = () => {
    updateCamera(0.0001);
    render.render(camera(), 1 / 60, 0);
    const gl = render.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(4);
    let r = 0, g = 0, b = 0, n = 0, nan = 0;
    for (let j = 0; j < 14; j++) {
      for (let i = 0; i < 24; i++) {
        gl.readPixels(Math.floor(((i + 0.5) / 24) * w), Math.floor(((j + 0.5) / 14) * h), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        r += px[0]; g += px[1]; b += px[2]; n++;
        if (px[0] + px[1] + px[2] === 0) nan++;
      }
    }
    return { r: +(r / n).toFixed(1), g: +(g / n).toFixed(1), b: +(b / n).toFixed(1), blackPixels: nan, of: n };
  };

  // ?bench=1 : unthrottled loop (MessageChannel pump, no vsync): 150 warm-up frames (the GPU boosts its
  // clocks), then 300 measured; frame ms = wall time over the window with the GPU drained at both ends.
  // Result in window.__BENCH__
  const bench = flag('bench') ?? false;
  const profileMode = flag('profile') ?? false; // per-pass queries only resolve when frames are vsync-paced
  const benchRes: { gpu: number[]; raw: number[]; cpu: number[]; wall: number[] } = { gpu: [], raw: [], cpu: [], wall: [] };
  const pump = new MessageChannel();
  let benchT0 = 0;
  // ?cycle=low,high,ultra,...&every=40 : apply those quality presets live every N frames (exercises applyGraphics)
  const cycle = (q.get('cycle') ?? '').split(',').filter(Boolean) as QualityLevel[];
  const cycleEvery = num('every', 40);
  const cycleLog: unknown[] = [];
  raw.__CYCLE__ = cycleLog;
  let last = performance.now();
  let frames = 0;
  const speedOverride = q.has('speed') ? num('speed', 0) : null;
  const loop = (nowIn?: number) => {
    const now = nowIn ?? performance.now();
    const wall = now - last;
    const dt = bench ? FIXED : Math.min(0.1, wall / 1000);
    last = now;
    readKeys();
    if (!freeze) {
      let acc = dt;
      while (acc > 1e-6) {
        const step = Math.min(FIXED, acc);
        for (const s of synth) s.step(step);
        effects.update(step, states, camera());
        acc -= step;
      }
    }
    poseVisuals(dt);
    updateCamera(Math.max(dt, 1 / 500));
    trackScene?.update(dt, camera());
    world?.update(dt);
    render.setFocus(synth[0].state.position);
    render.render(camera(), dt, speedOverride ?? synth[0].state.speed);
    frames++;
    // pipelined like the real game; only the measurement window edges wait for the GPU to drain
    if (bench && (frames === 150 || frames === 450)) render.renderer.getContext().finish();
    if (bench && frames === 150) benchT0 = performance.now();
    if (cycle.length && frames % cycleEvery === 0 && frames / cycleEvery <= cycle.length) {
      const next = cycle[frames / cycleEvery - 1];
      render.applyGraphics({ ...QUALITY_PRESETS[next] });
      cycleLog.push({ applied: next, frame: frames });
    } else if (cycle.length && frames % cycleEvery === cycleEvery - 6) {
      cycleLog.push({ frame: frames, ...(render.stats as unknown as Record<string, number>) });
    }
    if (bench && frames > 150) {
      benchRes.gpu.push(render.stats.gpuMs);
      benchRes.raw.push(render.stats.gpuMsRaw);
      benchRes.cpu.push(render.stats.cpuMs);
      if (frames === 450) {
        const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
        const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
        const st = render.stats;
        raw.__BENCH__ = {
          quality: graphics.quality,
          internal: `${st.width}x${st.height}`,
          gpuMs: +median(benchRes.raw).toFixed(3),
          gpuMsMin: +Math.min(...benchRes.raw).toFixed(3),
          gpuMsMean: +avg(benchRes.gpu).toFixed(3),
          cpuMs: +avg(benchRes.cpu).toFixed(3),
          // wall time per frame over 300 frames with the GPU drained at both ends = sustainable frame time
          frameMs: +((performance.now() - benchT0) / 300).toFixed(3),
          drawCalls: st.drawCalls,
          triangles: st.triangles,
          cascades: st.cascades,
          gpuMemMB: st.gpuMemMB,
          passMs: Object.fromEntries(Object.entries(st.passMs).map(([k, v]) => [k, +v.toFixed(3)])),
        };
        window.__READY__ = true;
      }
    }
    if (frames === 4 && !cycle.length && !bench) window.__READY__ = true;
    if (cycle.length && frames === cycleEvery * (cycle.length + 1)) window.__READY__ = true;
    schedule();
  };
  const schedule = () => {
    if (bench && !profileMode) pump.port2.postMessage(0);
    else requestAnimationFrame(loop);
  };
  pump.port1.onmessage = () => loop();
  schedule();

  window.__STATS__ = new Proxy(
    {},
    {
      get(_t, key) {
        const s = render.stats as unknown as Record<string, number>;
        if (key === 'toJSON') return () => ({ ...s });
        return s[key as string];
      },
      ownKeys: () => Object.keys(render.stats),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    },
  );
}

main().catch((e) => {
  console.error('sandbox failed', e);
  throw e;
});
