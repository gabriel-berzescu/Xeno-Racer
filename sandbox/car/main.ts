/**
 * Car showroom. Query: ?car=vanta-gt|kestrel-r|ronin-86|lmp-x|mammoth &view=front34|side|rear34|top|front|rear|chase|cockpit|low|lowrear|wheelF|wheelR|sheet
 *   &anim=0|1 &night=0|1 &q=low|medium|high &primary=%23hex &pattern=… &number=7 &metallic=0|1 &finish=0..1 &player=0|1
 *   &wet=0..1 (wet paint, beading, glass drops: env.wetness)  &rain=0..1 (env.rain; > 0 also marks the weather as rain)
 *   &dmg=fl:14:wall:25,sl:5:car   crash damage, applied straight to the model: zone:closing speed (m/s):wall|car:angle (deg to the
 *        barrier). Zones: fl fr f (front corners / centre), bl br b (rear), sl sr (flanks). &rub=sl:3 adds a scrape along a flank.
 *        window.__CAR__.hit('fl:14:wall:25') does the same from a script.
 *   ?lineup=N[&row=1]  a grid of N cars (random liveries); with row=1 the roster in a single row, each in its own default livery, seen from the
 *        front quarter: a size comparison (&cars=a,b,c picks which, &night=1 lights them).
 */
import * as THREE from 'three';
import { getCar } from '../../src/cars';
import { bodyCgZ, type CarDefinition, type EnvironmentState, type Livery, type QualityLevel, type VehicleState } from '../../src/core/contracts';
import { createCarVisual } from '../../src/carvis';
import { hullOf, type DamageEvent, type V3 } from '../../src/core/damage';
import { createStudioScene } from './studio';

const q = new URLSearchParams(location.search);
const carId = q.get('car') ?? 'vanta-gt';
const view = q.get('view') ?? 'front34';
const anim = q.get('anim') === '1';
const night = q.get('night') === '1';
const quality = (q.get('q') ?? 'high') as QualityLevel;
const isPlayer = q.get('player') !== '0';
const bare = q.get('floor') === '0';

if (q.get('cell')) (window as unknown as { __CARVIS_CELL__: number }).__CARVIS_CELL__ = parseFloat(q.get('cell')!);
if (q.get('dbg') === 'zones' || q.get('dbg') === 'normal' || q.get('dbg') === 'interior' || q.get('dbg') === 'zebra' || q.get('dbg') === 'clay') (window as unknown as { __CARVIS_DBG__: string }).__CARVIS_DBG__ = q.get('dbg')!;
if (q.get('hide')) (window as unknown as { __CARVIS_HIDE__: string }).__CARVIS_HIDE__ = q.get('hide')!;
const canvas = document.getElementById('c') as HTMLCanvasElement;
const refUrl = q.get('ref');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', alpha: !!refUrl });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = parseFloat(q.get('exp') ?? (night ? '1.0' : '0.95'));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
if (refUrl) {
  document.body.style.background = `#808080 url(${refUrl}) 0 0 / ${(q.get('rs') ?? '1920,1080').split(',')[0]}px ${(q.get('rs') ?? '1920,1080').split(',')[1]}px no-repeat`;
  canvas.style.opacity = q.get('alpha') ?? '0.6';
}
const pm = new THREE.PMREMGenerator(renderer);
const envRT = pm.fromScene(createStudioScene(), 0.02);
scene.environment = envRT.texture;
scene.environmentIntensity = night ? 0.06 : 1;
scene.background = refUrl ? null : new THREE.Color(night ? 0x020306 : 0x0d0f13);
if (!refUrl) scene.fog = new THREE.Fog(scene.background as THREE.Color, 14, 38);

// floor: dark satin with a soft light pool
const poolTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(256, 256, 20, 256, 256, 256);
  grd.addColorStop(0, '#3a3d45');
  grd.addColorStop(0.5, '#17191d');
  grd.addColorStop(1, '#07080a');
  g.fillStyle = grd;
  g.fillRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ map: poolTex, roughness: 0.32, metalness: 0.0, envMapIntensity: 0.5 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
floor.visible = !bare && !refUrl;
scene.add(floor);

const sun = new THREE.DirectionalLight(0xfff2e6, night ? 0.1 : 1.6);
sun.position.set(-5, 9, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -4;
sun.shadow.camera.right = 4;
sun.shadow.camera.top = 4;
sun.shadow.camera.bottom = -4;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 25;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
sun.shadow.radius = 5;
scene.add(sun);

const def: CarDefinition = getCar(carId);
const livery: Livery = { ...def.defaultLivery };
const pr = q.get('primary');
if (pr) livery.primary = pr.startsWith('#') ? pr : `#${pr}`;
const sec = q.get('secondary');
if (sec) livery.secondary = sec.startsWith('#') ? sec : `#${sec}`;
const acc = q.get('accent');
if (acc) livery.accent = acc.startsWith('#') ? acc : `#${acc}`;
const pat = q.get('pattern');
if (pat) livery.pattern = pat as Livery['pattern'];
if (q.get('number')) livery.number = parseInt(q.get('number')!, 10);
if (q.get('metallic')) livery.metallic = q.get('metallic') === '1';
if (q.get('finish')) livery.finish = parseFloat(q.get('finish')!);

const wetQ = Math.min(1, Math.max(0, parseFloat(q.get('wet') ?? '0') || 0));
const rainQ = Math.min(1, Math.max(0, parseFloat(q.get('rain') ?? '0') || 0));
const env: EnvironmentState = {
  settings: { timeOfDay: night ? 'night' : 'golden', weather: rainQ > 0.7 ? 'storm' : rainQ > 0 || wetQ > 0 ? 'rain' : 'clear' },
  sunDirection: new THREE.Vector3(-0.4, 0.6, 0.5).normalize(),
  sunIntensity: 3,
  darkness: night ? 0.95 : 0,
  fogColor: '#0d0f13',
  rain: rainQ,
  wetness: wetQ,
};

function makeState(d: CarDefinition): VehicleState {
  const v = d.visual;
  const mk = (): VehicleState['wheels'][0] => ({
    hub: new THREE.Vector3(),
    contactPoint: new THREE.Vector3(),
    contactNormal: new THREE.Vector3(0, 1, 0),
    steerAngle: 0,
    spin: 0,
    omega: 0,
    radius: 0.34,
    width: 0.25,
    compression: 0.3,
    suspensionVelocity: 0,
    contact: true,
    surface: 'asphalt',
    load: 3000,
    slipRatio: 0,
    slipAngle: 0,
    forceLong: 0,
    forceLat: 0,
    skid: 0,
    tempC: 80,
    brakeTempC: 150,
  });
  const st = {
    id: 0,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    angularVelocity: new THREE.Vector3(),
    speed: 0,
    forwardSpeed: 0,
    localAccel: new THREE.Vector3(),
    steer: 0,
    throttle: 0,
    brake: 0,
    handbrake: 0,
    clutch: 0,
    rpm: 3000,
    idleRpm: 900,
    redlineRpm: 7800,
    limiterRpm: 8000,
    gear: 3,
    gearCount: 6,
    engineLoad: 0.5,
    boost: 0,
    revLimiter: false,
    absActive: false,
    tcsActive: false,
    escActive: false,
    shiftCount: 0,
    backfireCount: 0,
    impactCount: 0,
    lastImpact: { strength: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), kind: 'ground' as const },
    scrape: 0,
    scrapePoint: new THREE.Vector3(),
    wheels: [mk(), mk(), mk(), mk()] as VehicleState['wheels'],
    airborne: false,
  } as VehicleState;
  const cgZ = bodyCgZ(v);
  st.position.set(0, v.cgHeight, cgZ);
  st.speed = 28;
  st.forwardSpeed = 28;
  st.rpm = 5200;
  const zs = [v.wheelbase / 2, v.wheelbase / 2, -v.wheelbase / 2, -v.wheelbase / 2];
  const xs = [v.trackFront / 2, -v.trackFront / 2, v.trackRear / 2, -v.trackRear / 2];
  for (let i = 0; i < 4; i++) {
    const r = i < 2 ? v.wheelRadiusFront : v.wheelRadiusRear;
    st.wheels[i].hub.set(xs[i], r, zs[i]);
    st.wheels[i].radius = r;
    st.wheels[i].width = i < 2 ? v.tireWidthFront : v.tireWidthRear;
  }
  return st;
}

const eul = new THREE.Euler();
const tmpV = new THREE.Vector3();
function animate(st: VehicleState, d: CarDefinition, t: number, dt: number): void {
  const v = d.visual;
  const cgZ = bodyCgZ(v);
  const pitch = 0.012 * Math.sin(t * 1.3) - 0.01 * (st.brake > 0.05 ? 1 : 0);
  const roll = 0.02 * Math.sin(t * 0.9);
  const heave = 0.012 * Math.sin(t * 2.1);
  eul.set(pitch, 0, roll, 'YXZ');
  st.quaternion.setFromEuler(eul);
  st.position.set(0, heave, 0).add(tmpV.set(0, v.cgHeight, cgZ).applyQuaternion(st.quaternion));
  const zs = [v.wheelbase / 2, v.wheelbase / 2, -v.wheelbase / 2, -v.wheelbase / 2];
  const xs = [v.trackFront / 2, -v.trackFront / 2, v.trackRear / 2, -v.trackRear / 2];
  const speed = 28;
  const maxSteer = d.physics.chassis.maxSteer;
  st.steer = Math.sin(t * 0.8);
  st.brake = Math.sin(t * 0.55) > 0.55 ? 1 : 0;
  st.gear = Math.sin(t * 0.2) > 0.9 ? -1 : 3;
  for (let i = 0; i < 4; i++) {
    const r = i < 2 ? v.wheelRadiusFront : v.wheelRadiusRear;
    const w = st.wheels[i];
    // hub in car frame with some suspension travel, then to world
    const lift = 0.025 * Math.sin(t * 2.3 + i * 1.7);
    tmpV.set(xs[i], r + lift, zs[i]).applyQuaternion(st.quaternion);
    w.hub.set(0, heave, 0).add(tmpV);
    w.omega = speed / r;
    w.spin = (w.spin + w.omega * dt) % (Math.PI * 2);
    w.steerAngle = i < 2 ? -st.steer * maxSteer : 0;
    w.brakeTempC = 150 + 600 * (0.5 + 0.5 * Math.sin(t * 0.55 + i));
  }
}

interface ViewDef {
  pos: [number, number, number];
  look: [number, number, number];
  fov: number;
  carRelative?: boolean;
  up?: [number, number, number];
}

function viewFor(name: string, d: CarDefinition): ViewDef {
  const v = d.visual;
  if (q.get('cam')) {
    const c = q.get('cam')!.split(',').map(Number);
    const l = (q.get('look') ?? '0,0.6,0').split(',').map(Number);
    return { pos: [c[0], c[1], c[2]], look: [l[0], l[1], l[2]], fov: parseFloat(q.get('fov') ?? '30') };
  }
  const L = v.length;
  // a tall body (the 4x4, 1.84 m) is framed higher and from a little further back, so its roof and the light bar stay in the picture
  const ky = v.height > 1.5 ? v.height / 1.3 : 1;
  const s = (L / 4.6) * (v.style === 'prototype' ? 1.22 : 1) * (ky > 1 ? 1.12 : 1);
  const table: Record<string, ViewDef> = {
    front34: { pos: [3.7 * s, 1.25 * ky, 5.1 * s], look: [0, 0.52 * ky, 0.15], fov: 26 },
    rear34: { pos: [-3.7 * s, 1.35 * ky, -5.1 * s], look: [0, 0.55 * ky, -0.15], fov: 26 },
    side: { pos: [8.6 * s, 0.68 * ky, 0], look: [0, 0.58 * ky, 0], fov: 21 },
    top: { pos: [0, 9.5, 0.01], look: [0, 0, 0], fov: 22, up: [-1, 0, 0] },
    front: { pos: [0, 0.75 * ky, 8.5 * s], look: [0, 0.58 * ky, 0], fov: 21 },
    rear: { pos: [0, 0.95 * ky, -8.5 * s], look: [0, 0.6 * ky, 0], fov: 21 },
    low: { pos: [2.6 * s, 0.42, 3.4 * s], look: [0, 0.45 * ky, 0.2], fov: 32 },
    lowrear: { pos: [-2.6 * s, 0.5, -3.6 * s], look: [0, 0.5 * ky, -0.2], fov: 32 },
    chase: { pos: [0, 1.8, -6.0], look: [0, v.height, -0.2], fov: 62, carRelative: true },
    cockpit: { pos: [0, 0, 0], look: [0, 0, 0], fov: 75, carRelative: true },
    wheelF: { pos: [3.0, 0.45, 1.4 + (v.wheelbase / 2 - 1.35)], look: [v.trackFront / 2, 0.36, v.wheelbase / 2], fov: 28 },
    wheelR: { pos: [-3.0, 0.45, -1.4 - (v.wheelbase / 2 - 1.35)], look: [-v.trackRear / 2, 0.36, -v.wheelbase / 2], fov: 28 },
  };
  return table[name] ?? table.front34;
}

const state = makeState(def);
let carVisual: Awaited<ReturnType<typeof createCarVisual>>;
const cam = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.05, 200);

const refCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
const silMat = new THREE.MeshBasicMaterial({ color: 0x00a0ff, side: THREE.DoubleSide });
function setupRef(): THREE.OrthographicCamera {
  // ?ref=<url>&rf=fx,fy&rr=rx,ry&rs=W,H&flip=0|1 : photo wheel centres in photo px; overlays an orthographic side render
  const [fx, fy] = (q.get('rf') ?? '0,0').split(',').map(Number);
  const [rx, ry] = (q.get('rr') ?? '0,0').split(',').map(Number);
  const [W, H] = (q.get('rs') ?? '1920,1080').split(',').map(Number);
  const flip = q.get('flip') === '1';
  const v = def.visual;
  const s = Math.hypot(rx - fx, ry - fy) / v.wheelbase;
  const zF = v.wheelbase / 2;
  const Rf = v.wheelRadiusFront;
  const ang = Math.atan2(ry - fy, rx - fx);
  // horizontal: u = -z (nose left) or +z (nose right)
  const u0 = flip ? zF : -zF;
  refCam.left = u0 - fx / s;
  refCam.right = u0 + (W - fx) / s;
  refCam.top = Rf + fy / s;
  refCam.bottom = Rf - (H - fy) / s;
  refCam.updateProjectionMatrix();
  refCam.position.set(flip ? -10 : 10, 0, 0);
  refCam.lookAt(0, 0, 0);
  void ang;
  if (q.get('grid') === '1') drawGrid(fx, fy, s, flip, W, H, zF, Rf);
  return refCam;
}

let gridDrawn = false;
function drawGrid(fx: number, fy: number, s: number, flip: boolean, W: number, H: number, zF: number, Rf: number): void {
  if (gridDrawn) return;
  gridDrawn = true;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  c.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none';
  document.body.appendChild(c);
  const g = c.getContext('2d')!;
  g.font = '13px monospace';
  for (let z = -3; z <= 3; z += 0.25) {
    const px = flip ? fx + s * (z - zF) : fx + s * (zF - z);
    g.strokeStyle = Math.abs(z * 4 - Math.round(z * 4)) < 1e-6 && Math.round(z * 4) % 4 === 0 ? 'rgba(255,0,255,0.85)' : 'rgba(255,0,255,0.35)';
    g.beginPath();
    g.moveTo(px, 0);
    g.lineTo(px, H);
    g.stroke();
    g.fillStyle = '#f0f';
    g.fillText(z.toFixed(2), px + 2, 14);
  }
  for (let y = 0; y <= 1.6; y += 0.1) {
    const py = fy - s * (y - Rf);
    g.strokeStyle = Math.round(y * 10) % 5 === 0 ? 'rgba(0,255,255,0.9)' : 'rgba(0,255,255,0.4)';
    g.beginPath();
    g.moveTo(0, py);
    g.lineTo(W, py);
    g.stroke();
    g.fillStyle = '#0ff';
    g.fillText(y.toFixed(1), 4, py - 2);
  }
}

function aim(cam: THREE.PerspectiveCamera, name: string, aspect: number): void {
  const vd = viewFor(name, def);
  cam.fov = vd.fov;
  cam.aspect = aspect;
  cam.updateProjectionMatrix();
  if (name === 'cockpit') {
    carVisual.anchors.cockpit.getWorldPosition(cam.position);
    cam.lookAt(cam.position.x, cam.position.y - 0.04, cam.position.z + 10);
  } else if (name === 'chase') {
    cam.position.set(...vd.pos);
    carVisual.anchors.chase.getWorldPosition(tmpV);
    cam.lookAt(tmpV);
  } else {
    cam.position.set(...vd.pos);
    if (vd.up) cam.up.set(...vd.up);
    else cam.up.set(0, 1, 0);
    cam.lookAt(...vd.look);
  }
}

function render(): void {
  const W = innerWidth, H = innerHeight;
  if (view === 'sheet') {
    const names = ['front34', 'side', 'rear34', 'top', 'chase', 'front'];
    renderer.setScissorTest(true);
    const cw = Math.floor(W / 2), ch = Math.floor(H / 3);
    names.forEach((n, i) => {
      const cx = (i % 2) * cw, cy = H - (Math.floor(i / 2) + 1) * ch;
      renderer.setViewport(cx, cy, cw, ch);
      renderer.setScissor(cx, cy, cw, ch);
      aim(cam, n, cw / ch);
      renderer.render(scene, cam);
    });
    renderer.setScissorTest(false);
  } else if (refUrl) {
    renderer.setViewport(0, 0, W, H);
    scene.overrideMaterial = q.get('sil') === '1' ? silMat : null;
    renderer.render(scene, setupRef());
  } else {
    renderer.setViewport(0, 0, W, H);
    aim(cam, view, W / H);
    
    renderer.render(scene, cam);
  }
}

/** ?lineup=12 : a grid of AI cars (all four models, varied liveries) plus the player car, to test sharing, LOD and cost. */
async function lineup(count: number): Promise<void> {
  const { CARS } = await import('../../src/cars');
  const row = q.get('row') === '1';
  const picks = q.get('cars') ? q.get('cars')!.split(',').map((id) => CARS.findIndex((c) => c.id === id)).filter((i) => i >= 0) : null;
  const patterns: Livery['pattern'][] = ['solid', 'stripes', 'split', 'arrow', 'hoops', 'shards'];
  const hues = ['#c4161c', '#1c6bd8', '#f2c200', '#18a058', '#ece8e0', '#8a2be2', '#ff7a18', '#2ad1c4', '#2b2f3a', '#ff2e63', '#6a7a8c', '#a0e020'];
  const t0 = performance.now();
  const cars: Array<{ visual: Awaited<ReturnType<typeof createCarVisual>>; state: VehicleState; def: CarDefinition }> = [];
  const cols = 4;
  const jobs: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    const d = row && picks ? CARS[picks[i % picks.length]] : CARS[i % CARS.length];
    const lv: Livery = row ? { ...d.defaultLivery } : { ...d.defaultLivery, primary: hues[i % hues.length], secondary: hues[(i + 5) % hues.length], accent: hues[(i + 3) % hues.length], pattern: patterns[i % patterns.length], number: 3 + i * 7, metallic: i % 2 === 0 };
    jobs.push(
      createCarVisual(d, lv, quality).then((visual) => {
        const st = makeState(d);
        const col = i % cols, rowIdx = Math.floor(i / cols);
        const ox = row ? (i - (count - 1) / 2) * 3.3 : (col - (cols - 1) / 2) * 3.6;
        const oz = row ? -i * 0.0 : -rowIdx * 6.5;
        st.position.x += ox;
        st.position.z += oz;
        for (const w of st.wheels) {
          w.hub.x += ox;
          w.hub.z += oz;
        }
        visual.setPlayer(row ? true : i === 0);
        scene.add(visual.root);
        cars.push({ visual, state: st, def: d });
      }),
    );
  }
  await Promise.all(jobs);
  const buildMs = performance.now() - t0;
  for (const c of cars) c.visual.update(c.state, 0, env);
  const cw = innerWidth, ch = innerHeight;
  cam.fov = row ? 30 : 40;
  cam.aspect = cw / ch;
  cam.updateProjectionMatrix();
  if (row) {
    cam.position.set(-9.5 * (count / 5), 2.1, 15 * (count / 5));
    cam.lookAt(0, 0.85, 0);
  } else {
    cam.position.set(9, 4.2, 12.5);
    cam.lookAt(0, 0.4, -6);
  }
  renderer.render(scene, cam);
  const info = renderer.info;
  (window as unknown as Record<string, unknown>).__STATS__ = { triangles: info.render.triangles, drawCalls: info.render.calls, buildMs: Math.round(buildMs), cars: count };
  // (a hook for the GPU benchmark in .cache/dmg/microbench.mjs: damage every car alike, repair them, push the change to the shader)
  (window as unknown as Record<string, unknown>).__LINEUP__ = {
    renderer,
    scene,
    camera: cam,
    cars: cars.map((c) => c.visual),
    render: () => renderer.render(scene, cam),
    update: () => cars.forEach((c) => c.visual.update(c.state, 0, env)),
    hit: (spec: string) => cars.forEach((c) => applyCrashes(spec, c.visual, c.def)),
    rub: (spec: string) => cars.forEach((c) => applyRubs(spec, c.visual, c.def)),
    repair: () => cars.forEach((c) => c.visual.damage?.repair()),
  };
  (window as unknown as Record<string, unknown>).__READY__ = true;
}

/** One synthetic crash event for the showroom car (see the header for the token). */
function crashEvent(token: string, of: CarDefinition = def): DamageEvent | null {
  const [zone, sRaw, kindRaw = 'wall', angRaw = '25'] = token.split(':');
  const h = hullOf(of.visual);
  const s = parseFloat(sRaw);
  const a = (parseFloat(angRaw) * Math.PI) / 180;
  const kind = kindRaw === 'car' ? 'car' : 'wall';
  const sgn = zone.endsWith('r') && zone.length === 2 ? -1 : 1;
  const midZ = (h.front + h.rear) / 2;
  let p: V3;
  let n: V3;
  let slide: V3;
  const V = s / Math.max(Math.sin(a), 0.05);
  if (zone[0] === 'f' || zone[0] === 'b') {
    const front = zone[0] === 'f';
    const z = front ? h.front : h.rear;
    const side = zone.length === 1 ? 0 : sgn;
    p = [side * h.hw, h.top, z];
    if (kind === 'car' || zone.length === 1) {
      n = [0, 0, front ? -1 : 1];
      slide = [0.4 * side, 0, 1];
    } else {
      // a corner against a barrier on that side, the car angled into it
      n = [-side * Math.cos(a), 0, (front ? -1 : 1) * Math.sin(a)];
      slide = [-side * Math.sin(a) * Math.cos(a) * V, 0, (front ? 1 : -1) * Math.cos(a) * Math.cos(a) * V];
    }
  } else {
    const side = zone === 'sr' ? -1 : 1;
    p = [side * h.hw, (h.top + h.bottom) / 2, midZ];
    n = [-side, 0, 0];
    slide = [0, 0, Math.max(V, 6)];
  }
  const e: DamageEvent = { type: 'hit', kind, strength: s, p, n, slide };
  if (kind === 'car') e.paint = 0x2a62d0;
  return e;
}
function applyCrashes(spec: string, to: Awaited<ReturnType<typeof createCarVisual>> = carVisual, of: CarDefinition = def): void {
  for (const t of spec.split(',').filter(Boolean)) {
    const e = crashEvent(t, of);
    if (e) to.damage?.state.apply(e);
  }
}
function applyRubs(spec: string, to: Awaited<ReturnType<typeof createCarVisual>> = carVisual, of: CarDefinition = def): void {
  const h = hullOf(of.visual);
  for (const t of spec.split(',').filter(Boolean)) {
    const [zone, amountRaw = '3'] = t.split(':');
    const side = zone === 'sr' ? -1 : 1;
    const amount = parseFloat(amountRaw);
    for (let i = 0; i < Math.ceil(amount / 0.6); i++) {
      to.damage?.state.apply({ type: 'rub', kind: 'wall', p: [side * h.hw, h.top, h.front - 0.3 - i * 0.7], n: [-side, 0, 0], amount: 0.6, slide: [0, 0, 40] });
    }
  }
}

async function main(): Promise<void> {
  if (q.get('lineup')) {
    await lineup(parseInt(q.get('lineup')!, 10) || 12);
    return;
  }
  const t0 = performance.now();
  carVisual = await createCarVisual(def, livery, quality);
  const buildMs = performance.now() - t0;
  carVisual.setPlayer(isPlayer);
  if (q.get('far') === '1') {
    const lod = carVisual.root.children.find((c) => (c as THREE.LOD).isLOD) as THREE.LOD | undefined;
    if (lod) lod.levels[1].distance = 0;
  }
  carVisual.setCockpitView(view === 'cockpit');
  scene.add(carVisual.root);
  (window as unknown as Record<string, unknown>).__CAR__ = {
    visual: carVisual,
    def,
    state,
    env,
    renderer,
    render: () => render(),
    hit: (t: string) => applyCrashes(t),
    rub: (t: string) => applyRubs(t),
  };
  if (q.get('dmg')) applyCrashes(q.get('dmg')!);
  if (q.get('rub')) applyRubs(q.get('rub')!);
  carVisual.update(state, 0, env);
  render();
  if (q.get('bench') === '1') {
    // CPU cost + allocation check of CarVisual.update (no GL work)
    const mem = (): number => ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
    for (let i = 0; i < 2000; i++) {
      animate(state, def, i * 0.01, 0.016);
      carVisual.update(state, 0.016, env);
    }
    const gc = (globalThis as unknown as { gc?: () => void }).gc;
    gc?.();
    const m0 = mem();
    const N = 50000;
    const t0b = performance.now();
    for (let i = 0; i < N; i++) {
      animate(state, def, i * 0.01, 0.016);
      carVisual.update(state, 0.016, env);
    }
    const t1b = performance.now();
    gc?.();
    const m1 = mem();
    (window as unknown as Record<string, unknown>).__BENCH__ = { updatesPerCallMicros: ((t1b - t0b) * 1000) / N, heapDeltaKB: (m1 - m0) / 1024, N };
  }
  const info = renderer.info;
  (window as unknown as Record<string, unknown>).__STATS__ = { triangles: info.render.triangles, drawCalls: info.render.calls, buildMs: Math.round(buildMs), car: carVisual.root.userData.carvis };
  (window as unknown as Record<string, unknown>).__READY__ = true;
  if (anim) {
    let t = 0;
    let last = performance.now();
    const loop = (): void => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      t += dt;
      animate(state, def, t, dt);
      carVisual.update(state, dt, env);
      render();
      requestAnimationFrame(loop);
    };
    loop();
  }
}
main().catch((e) => {
  console.error(e);
  throw e;
});
