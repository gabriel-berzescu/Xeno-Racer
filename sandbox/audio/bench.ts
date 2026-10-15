/**
 * Interactive audio test bench (for humans). Drives the REAL audio system (createAudioSystem) with a
 * mock vehicle so every sound can be auditioned and tweaked without the game:
 *   - engines: pick a car or edit a custom profile live (cylinders / layout / crank / turbo / exhaust...),
 *     sliders or a simulated drivetrain ("rev through the gears"), keyboard W/S + gamepad triggers
 *   - tires / road: surface, speed, front / rear skid, rear wheelspin, squeal sweep, curb, scrape, thumps, airborne
 *   - weather: rain + wetness sliders, dry / rain / storm presets, thunder on demand (cabin view for the roof drumming)
 *   - impacts: wall / car / ground x light / medium / heavy
 *   - opponents: up to 11 cars overtaking around you (LOD, Doppler, panning), trackside camera
 *   - UI sounds, music, faders, live spectrum + scope + meters, self-test and preview download
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { CARS, getCar } from '../../src/cars';
import { type AudioSystemInternals, createAudioSystem } from '../../src/audio';
import { UI_SOUND_LIST } from '../../src/audio/ui-sounds';
import { DEFAULT_SETTINGS } from '../../src/core/settings';
import type { AudioSettings, CarDefinition, EngineSoundProfile, SurfaceType, VehicleState } from '../../src/core/contracts';
import type { CarSound } from '../../src/core/systems';
import { DriveSim, makeVehicleState } from './drive-sim';
import { type Saved, runGroups } from './report-run';

// ── tiny DOM helpers ───────────────────────────────────────────────────────────

type Kid = Node | string;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}

interface Ctl {
  el: HTMLElement;
  get(): number;
  set(v: number): void;
}

function slider(label: string, min: number, max: number, step: number, value: number, onInput?: (v: number) => void, unit = ''): Ctl {
  const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  const out = h('output');
  const fmt = (v: number): string => (step < 1 ? v.toFixed(step < 0.1 ? 2 : 1) : String(Math.round(v))) + unit;
  out.textContent = fmt(value);
  input.addEventListener('input', () => {
    out.textContent = fmt(+input.value);
    onInput?.(+input.value);
  });
  return {
    el: h('label', { class: 'row' }, h('span', {}, label), input, out),
    get: () => +input.value,
    set: (v) => {
      input.value = String(v);
      out.textContent = fmt(v);
    },
  };
}

function toggle(label: string, value: boolean, onChange?: (v: boolean) => void): Ctl {
  const input = h('input', { type: 'checkbox' });
  input.checked = value;
  input.addEventListener('change', () => onChange?.(input.checked));
  return {
    el: h('label', { class: 'row chk' }, input, h('span', {}, label)),
    get: () => (input.checked ? 1 : 0),
    set: (v) => {
      input.checked = v > 0.5;
    },
  };
}

function select<T extends string>(label: string, options: readonly T[], value: T, onChange?: (v: T) => void): { el: HTMLElement; get(): T; set(v: T): void } {
  const s = h('select');
  for (const o of options) s.append(h('option', { value: o }, o));
  s.value = value;
  s.addEventListener('change', () => onChange?.(s.value as T));
  return {
    el: h('label', { class: 'row' }, h('span', {}, label), s),
    get: () => s.value as T,
    set: (v) => {
      s.value = v;
    },
  };
}

function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', { class: cls, type: 'button' }, label);
  b.addEventListener('click', onClick);
  return b;
}

function panel(title: string, ...kids: Kid[]): HTMLElement {
  return h('section', { class: 'panel' }, h('h2', {}, title), ...kids);
}

// ── the bench ──────────────────────────────────────────────────────────────────

type Mode = 'manual' | 'drive' | 'cycle';
type CamMode = 'cockpit' | 'chase' | 'trackside';

interface Opponent {
  sound: CarSound;
  sim: DriveSim;
  dx: number;
  dz: number;
  dv: number;
}

const SURFACES: SurfaceType[] = ['asphalt', 'concrete', 'curb', 'grass', 'gravel', 'sand', 'dirt'];

export function startBench(): void {
  const app = document.getElementById('app')!;
  document.getElementById('out')!.style.display = 'none';
  app.style.display = 'block';

  let vols: AudioSettings = { ...DEFAULT_SETTINGS.audio };
  const sys = createAudioSystem(vols) as unknown as AudioSystemInternals;

  // ── state ────────────────────────────────────────────────────────────────────
  let car: CarDefinition = getCar('vanta-gt');
  let profile: EngineSoundProfile = { ...car.sound };
  let player: CarSound = sys.createCarSound(profile, true);
  let sim = new DriveSim(car, { gear: 1 });
  const manual = makeVehicleState(0);
  const opponents: Opponent[] = [];
  let mode: Mode = 'manual';
  let cam: CamMode = 'chase';
  const camera = new PerspectiveCamera(62, 1.6, 0.1, 2000);
  const camPos = new Vector3();
  const camPrev = new Vector3();
  const camVel = new Vector3();
  let pedal = 0;
  let brake = 0;
  const keys = new Set<string>();
  let squealT = -1;
  let cycleT = 0;
  let thumpFrames = 0;
  let lastFrame = performance.now();
  let pendingShift = false;
  let pendingBackfire = false;
  let manualZ = 0;

  const rebuildPlayer = (): void => {
    player.dispose();
    player = sys.createCarSound(profile, true);
  };

  // ── controls ─────────────────────────────────────────────────────────────────
  const startBtn = button('Click here (or press any key / gamepad button) to start audio', () => void sys.unlock(), 'start');
  const status = h('div', { class: 'status' });

  const carSel = select('car', [...CARS.map((c) => c.id), 'custom'] as string[], car.id, (id) => {
    if (id !== 'custom') {
      car = getCar(id);
      profile = { ...car.sound };
      sim = new DriveSim(car, { gear: 1 });
      syncProfileUi();
    }
    rebuildPlayer();
  });
  const modeSel = select('drive mode', ['manual', 'drive', 'cycle'] as Mode[], mode, (m) => {
    mode = m;
    if (m !== 'manual') sim = new DriveSim(car, { gear: 1 });
  });
  const camSel = select('camera', ['chase', 'cockpit', 'trackside'] as CamMode[], cam, (c) => {
    cam = c;
    manualZ = 0;
    sim = new DriveSim(car, { gear: 1 });
  });
  const interiorChk = toggle('force interior mix (otherwise cockpit camera = interior)', false);

  const rpm = slider('rpm', 600, 10000, 10, 3000);
  const thr = slider('throttle (manual / pedal)', 0, 1, 0.01, 0);
  const boost = slider('boost', 0, 1, 0.01, 0);
  const limiter = toggle('rev limiter cutting', false);
  const speedS = slider('speed', 0, 90, 1, 30, undefined, ' m/s');
  const shiftBtn = button('shift (clunk + dip)  [E]', () => (pendingShift = true));
  const popBtn = button('backfire pop  [B]', () => (pendingBackfire = true));

  const surface = select('surface (all wheels)', SURFACES, 'asphalt');
  const skidF = slider('front axle skid', 0, 1, 0.01, 0);
  const skidR = slider('rear axle skid', 0, 1, 0.01, 0);
  const slip = slider('slip angle', 0, 0.4, 0.005, 0.02);
  const spinS = slider('rear wheelspin (slip ratio)', 0, 0.8, 0.01, 0);
  const scrape = slider('scrape (metal grinding)', 0, 1, 0.01, 0);
  const curb = toggle('left wheels on the curb', false);
  const air = toggle('airborne', false);
  const sweepBtn = button('squeal sweep (front, then rear)', () => (squealT = 0));
  const thumpBtn = button('suspension thump', () => (thumpFrames = 4));

  // custom profile editor
  const cylSel = select('cylinders', ['4', '6', '8', '10', '12'], String(profile.cylinders), (v) => {
    profile.cylinders = +v as EngineSoundProfile['cylinders'];
    markCustom();
  });
  const layoutSel = select('layout', ['inline', 'v', 'flat'], profile.layout, (v) => {
    profile.layout = v;
    markCustom();
  });
  const crankSel = select('crank', ['flat', 'crossplane', 'boxer'], profile.crankType, (v) => {
    profile.crankType = v;
    markCustom();
  });
  const dispS = slider('displacement', 1, 7, 0.1, profile.displacement, (v) => {
    profile.displacement = v;
    markCustom();
  }, ' L');
  const turboChk = toggle('turbo', profile.turbo, (v) => {
    profile.turbo = v;
    markCustom();
  });
  const openS = slider('exhaust openness', 0, 1, 0.01, profile.exhaustOpenness, (v) => {
    profile.exhaustOpenness = v;
    markCustom();
  });
  const brightS = slider('brightness', 0, 1, 0.01, profile.brightness, (v) => {
    profile.brightness = v;
    markCustom();
  });
  const whineS = slider('gear whine', 0, 1, 0.01, profile.gearWhine, (v) => {
    profile.gearWhine = v;
    markCustom();
  });
  const crackS = slider('crackle', 0, 1, 0.01, profile.crackle, (v) => {
    profile.crackle = v;
    markCustom();
  });
  let rebuildTimer = 0;
  function markCustom(): void {
    carSel.set('custom');
    window.clearTimeout(rebuildTimer);
    rebuildTimer = window.setTimeout(rebuildPlayer, 250);
  }
  function syncProfileUi(): void {
    cylSel.set(String(profile.cylinders));
    layoutSel.set(profile.layout);
    crankSel.set(profile.crankType);
    dispS.set(profile.displacement);
    turboChk.set(profile.turbo ? 1 : 0);
    openS.set(profile.exhaustOpenness);
    brightS.set(profile.brightness);
    whineS.set(profile.gearWhine);
    crackS.set(profile.crackle);
    rpm.set(Math.round(car.physics.engine.limiterRpm * 0.35));
  }

  const impactBtns: HTMLElement[] = [];
  for (const [kind, label] of [
    ['wall', 'wall'],
    ['car', 'car'],
    ['ground', 'ground'],
  ] as const) {
    for (const [name, v] of [
      ['light', 3],
      ['medium', 10],
      ['heavy', 28],
    ] as const) {
      impactBtns.push(
        button(`${label} ${name}`, () => {
          const st = currentState();
          st.impactCount++;
          st.lastImpact.kind = kind;
          st.lastImpact.strength = v;
          st.lastImpact.point.set(Math.random() < 0.5 ? 0.9 : -0.9, 0.5, 0.4).add(st.position);
        }),
      );
    }
  }

  // weather: the same call the game makes (rain + water on the track), presets match the game's weather presets
  const applyWeather = (): void => sys.setWeather(rainS.get(), wetS.get());
  const rainS = slider('rain (ambience)', 0, 1, 0.01, 0, applyWeather);
  const wetS = slider('wetness (tires, spray)', 0, 1, 0.01, 0, applyWeather);
  const preset = (r: number, w: number): void => {
    rainS.set(r);
    wetS.set(w);
    applyWeather();
  };
  const weatherBtns = [
    button('dry (0 / 0)', () => preset(0, 0)),
    button('rain (0.55 / 0.75)', () => preset(0.55, 0.75)),
    button('storm (1 / 1)', () => preset(1, 1)),
  ];
  const thunderBtns = [button('thunder: near (3 km)', () => sys.triggerThunder(3)), button('thunder: far (9 km)', () => sys.triggerThunder(9, 0.8))];

  const oppCount = slider('opponents around you', 0, 11, 1, 0, (n) => setOpponents(n));
  const passBtn = button('Doppler pass-by (trackside camera)', () => {
    cam = 'trackside';
    camSel.set('trackside');
    manualZ = -200;
    sim = new DriveSim(car, { gear: 3, speed: 55 });
    mode = 'drive';
    modeSel.set('drive');
    pedal = 1;
    thr.set(1);
  });

  const volSliders = (['master', 'engine', 'effects', 'music', 'ui'] as (keyof AudioSettings)[]).map((k) =>
    slider(k, 0, 1, 0.01, vols[k], (v) => {
      vols = { ...vols, [k]: v };
      sys.setVolumes(vols);
    }),
  );
  const pauseChk = toggle('paused (cars muted, UI stays)', false, (p) => sys.setPaused(p));
  const musicChk = toggle('menu music', false, (on) => sys.setMusic(on));
  const uiBtns = UI_SOUND_LIST.map((s) => button(s, () => sys.ui(s)));

  const readout = h('pre', { class: 'readout' });
  const testOut = h('pre', { class: 'testout' }, 'self-test not run');
  const testBtn = button('Run offline self-test (same checks as ?test=1)', async () => {
    testBtn.disabled = true;
    const saved: Saved = { results: {}, checks: {}, timings: {} };
    const t0 = performance.now();
    try {
      const rep = await runGroups(null, saved, { onStart: (g) => (testOut.textContent = `running ${g}… (${Math.round((performance.now() - t0) / 1000)} s)`) });
      testOut.textContent =
        `${rep.passed}/${rep.checks} checks passed in ${(rep.ms / 1000).toFixed(1)} s` +
        (rep.failed.length ? '\n\nFAILED:\n' + rep.failed.map((c) => `- ${c.name}: ${c.value} (${c.limit})`).join('\n') : '\n\nall green');
    } catch (e) {
      testOut.textContent = 'self-test error: ' + String(e);
    }
    testBtn.disabled = false;
  });
  const previewBtn = button('Render + download preview WAVs', async () => {
    previewBtn.disabled = true;
    const { renderPreviews } = await import('./previews');
    const wavs = await renderPreviews((m) => (testOut.textContent = 'rendering ' + m));
    for (const [name, w] of Object.entries(wavs)) {
      const bin = atob(w.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const a = h('a', { href: URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })), download: `${name}.wav` });
      a.click();
      await new Promise((r) => setTimeout(r, 250));
    }
    testOut.textContent = `downloaded ${Object.keys(wavs).length} previews`;
    previewBtn.disabled = false;
  });

  // visualiser
  const canvas = h('canvas', { width: '960', height: '240', class: 'viz' });
  const g2 = canvas.getContext('2d')!;
  let analyser: AnalyserNode | null = null;
  const fft = new Float32Array(2048);
  const wave = new Float32Array(2048);
  let peakHold = -100;

  // ── layout ───────────────────────────────────────────────────────────────────
  app.append(
    h('header', {}, h('h1', {}, 'Xeno-Racer audio bench'), startBtn, status),
    h(
      'div',
      { class: 'grid' },
      panel('Engine', carSel.el, modeSel.el, camSel.el, interiorChk.el, rpm.el, thr.el, boost.el, limiter.el, speedS.el, h('div', { class: 'btns' }, shiftBtn, popBtn), h('p', { class: 'hint' }, 'W / up = throttle, S / down = brake, E = shift, B = pop. Gamepad: RT throttle, LT brake, RB shift.')),
      panel('Custom engine profile (live)', cylSel.el, layoutSel.el, crankSel.el, dispS.el, turboChk.el, openS.el, brightS.el, whineS.el, crackS.el, h('p', { class: 'hint' }, 'Any change switches to "custom" and rebuilds the voice. Try V8 + crossplane for the burble, 4 + flat + boxer for the rumble.')),
      panel('Tires, road, chassis', surface.el, skidF.el, skidR.el, slip.el, spinS.el, scrape.el, curb.el, air.el, h('div', { class: 'btns' }, sweepBtn, thumpBtn)),
      panel(
        'Weather',
        rainS.el,
        wetS.el,
        h('div', { class: 'btns' }, ...weatherBtns),
        h('div', { class: 'btns' }, ...thunderBtns),
        h('p', { class: 'hint' }, 'Rain follows the camera: chase / trackside = open air, cockpit = muffled with drumming on the roof and ticks on the windscreen. Wetness drives the tire hiss, spray and the softer squeal / wheelspin slush of every car. Thunder needs rain; a storm brings it every 20-60 s by itself.'),
      ),
      panel('Impacts', h('div', { class: 'btns' }, ...impactBtns)),
      panel('Opponents / spatial', oppCount.el, passBtn, h('p', { class: 'hint' }, 'Opponents overtake and fall back around the player: nearest 4 get the full model, the rest the lite one, beyond 150 m they are silent. Chase / cockpit / trackside cameras change the spatialisation.')),
      panel('Sounds', h('div', { class: 'btns' }, ...uiBtns), musicChk.el, pauseChk.el, ...volSliders.map((s) => s.el)),
      panel('Verification', h('div', { class: 'btns' }, testBtn, previewBtn), testOut),
    ),
    h('section', { class: 'panel wide' }, h('h2', {}, 'Live output'), canvas, readout),
  );

  // ── input ────────────────────────────────────────────────────────────────────
  const onKey = (e: KeyboardEvent, down: boolean): void => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (down) {
      keys.add(k);
      if (k === 'e') pendingShift = true;
      if (k === 'b') pendingBackfire = true;
    } else keys.delete(k);
  };
  window.addEventListener('keydown', (e) => onKey(e, true));
  window.addEventListener('keyup', (e) => onKey(e, false));

  // ── opponents ────────────────────────────────────────────────────────────────
  function setOpponents(n: number): void {
    while (opponents.length > n) opponents.pop()!.sound.dispose();
    while (opponents.length < n) {
      const i = opponents.length;
      const c = CARS[(i + 1) % CARS.length];
      opponents.push({
        sound: sys.createCarSound(c.sound, false),
        sim: new DriveSim(c, { gear: 2 + (i % 3), seed: 100 + i }),
        dx: (i % 2 ? 1 : -1) * (3 + (i % 4) * 2.5),
        dz: -70 + i * 13,
        dv: -14 + ((i * 7) % 11) * 2.7,
      });
    }
  }

  // ── per-frame ────────────────────────────────────────────────────────────────
  function currentState(): VehicleState {
    return mode === 'manual' ? manual : sim.st;
  }

  function applyChassis(st: VehicleState): void {
    const inAir = air.get() > 0.5;
    for (let i = 0; i < 4; i++) {
      const w = st.wheels[i];
      w.surface = surface.get();
      if (curb.get() > 0.5 && i % 2 === 0 && !inAir) w.surface = 'curb';
      w.contact = !inAir;
      const front = i < 2;
      let s = front ? skidF.get() : skidR.get();
      let sa = slip.get();
      if (squealT >= 0) {
        const t = squealT;
        const k = front ? Math.min(1, Math.max(0, (t - 0.3) / 3.2)) * (1 - Math.min(1, Math.max(0, (t - 3.9) / 0.8))) : Math.min(1, Math.max(0, (t - 5.2) / 3.2)) * (1 - Math.min(1, Math.max(0, (t - 8.6) / 0.8)));
        s = Math.min(1, Math.max(0, (k - 0.3) / 0.5));
        sa = 0.02 + 0.3 * k;
      }
      w.skid = s;
      w.slipAngle = sa;
      w.load = 4500;
      w.slipRatio = front ? 0 : spinS.get();
      if (!front && w.slipRatio > 0.01) w.omega = (st.speed * (1 + 3 * w.slipRatio)) / w.radius;
      w.suspensionVelocity = thumpFrames > 0 && i === 0 ? 1.4 : 0;
    }
    st.airborne = inAir;
    st.scrape = scrape.get();
  }

  function frame(): void {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    if (dt <= 0) return;

    // pedals: keyboard + gamepad + slider
    let p = thr.get();
    let b = 0;
    if (keys.has('w') || keys.has('arrowup')) p = 1;
    if (keys.has('s') || keys.has('arrowdown')) b = 1;
    for (const gp of navigator.getGamepads?.() ?? []) {
      if (!gp) continue;
      if (gp.buttons.some((x) => x.pressed)) void sys.unlock(); // keep trying: Chrome may not count pad presses as activation
      if (gp.buttons[7]?.value > 0.02) p = Math.max(p, gp.buttons[7].value);
      if (gp.buttons[6]?.value > 0.02) b = Math.max(b, gp.buttons[6].value);
      if (gp.buttons[5]?.pressed && !pendingShift) pendingShift = true;
    }
    pedal = p;
    brake = b;

    // squeal sweep timeline
    if (squealT >= 0) {
      squealT += dt;
      if (squealT > 9.6) squealT = -1;
    }
    if (thumpFrames > 0) thumpFrames--;

    const e = car.physics.engine;
    let st: VehicleState;
    if (mode === 'manual') {
      st = manual;
      st.rpm = rpm.get();
      st.idleRpm = e.idleRpm;
      st.redlineRpm = e.redlineRpm;
      st.limiterRpm = e.limiterRpm;
      st.throttle = pedal;
      st.engineLoad = pedal;
      st.boost = profile.turbo ? boost.get() : 0;
      st.revLimiter = limiter.get() > 0.5;
      st.gear = 3;
      st.speed = speedS.get();
      st.forwardSpeed = st.speed;
      st.velocity.set(0, 0, st.speed);
      for (const w of st.wheels) {
        w.radius = car.physics.tireRear.radius;
        w.omega = st.speed / w.radius;
      }
      manualZ += st.speed * dt;
      if (cam === 'trackside' && manualZ > 220) manualZ = -220;
      st.position.set(0, 0.5, manualZ);
    } else {
      st = sim.st;
      let thrNow = pedal;
      let brkNow = brake;
      if (mode === 'cycle') {
        cycleT += dt;
        const ph = cycleT % 14;
        // launch through the gears, lift, coast with brakes, downshift, repeat
        thrNow = ph < 7.5 ? 1 : ph < 10.5 ? 0 : ph < 12 ? 0.55 : 0;
        brkNow = ph >= 10.5 && ph < 12 ? 0.35 : 0;
        if (ph < dt) sim = new DriveSim(car, { gear: 1, rpm: e.idleRpm + 0.3 * (e.redlineRpm - e.idleRpm) });
      }
      sim.step(dt, thrNow, brkNow);
      st = sim.st;
      if (cam === 'trackside' && st.position.z > 220) sim = new DriveSim(car, { gear: Math.max(1, st.gear), speed: st.speed });
    }
    if (pendingShift) {
      st.shiftCount++;
      pendingShift = false;
    }
    if (pendingBackfire) {
      st.backfireCount++;
      pendingBackfire = false;
    }
    applyChassis(st);

    // camera
    const car0 = st.position;
    if (cam === 'chase') {
      camPos.set(car0.x, car0.y + 1.3, car0.z - 6.5);
      camera.position.copy(camPos);
      camera.lookAt(car0.x, car0.y + 0.8, car0.z + 12);
    } else if (cam === 'cockpit') {
      camPos.set(car0.x + 0.36, car0.y + 0.55, car0.z - 0.4);
      camera.position.copy(camPos);
      camera.lookAt(car0.x + 0.36, car0.y + 0.5, car0.z + 20);
    } else {
      camPos.set(-14, 1.6, 0);
      camera.position.copy(camPos);
      camera.lookAt(0, 1.2, 40);
    }
    camera.updateMatrixWorld();
    camVel.copy(camPos).sub(camPrev).multiplyScalar(1 / dt);
    camPrev.copy(camPos);
    if (cam === 'trackside' || dt > 0.049) camVel.set(0, 0, cam === 'trackside' ? 0 : camVel.z);

    player.setInterior(cam === 'cockpit' || interiorChk.get() > 0.5);
    player.update(st, dt);

    // opponents: overtaking around the player
    for (const o of opponents) {
      o.dz += o.dv * dt;
      if (o.dz > 90) o.dz -= 180;
      if (o.dz < -90) o.dz += 180;
      const cyc = (now / 1000 + o.dx) % 16;
      o.sim.step(dt, cyc < 9 ? 1 : cyc < 12 ? 0 : 0.5, 0);
      const s = o.sim.st;
      s.position.set(car0.x + o.dx, 0.5, car0.z + o.dz);
      s.velocity.set(0, 0, st.speed + o.dv);
      o.sound.update(s, dt);
    }

    sys.setListener(camera, camVel);
    sys.update(dt);
    draw(st);
  }

  // ── visualiser + readout ─────────────────────────────────────────────────────
  function draw(st: VehicleState): void {
    if (!analyser && sys.unlocked) {
      analyser = sys.ctx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0.6;
      sys.graph.limiter.connect(analyser);
    }
    const W = canvas.width;
    const H = canvas.height;
    g2.fillStyle = '#0b0c10';
    g2.fillRect(0, 0, W, H);
    if (analyser) {
      analyser.getFloatFrequencyData(fft);
      analyser.getFloatTimeDomainData(wave);
      const sr = sys.ctx.sampleRate;
      const bins = fft.length;
      // spectrum, log frequency 30 Hz .. 16 kHz
      g2.strokeStyle = '#16e0bd';
      g2.beginPath();
      for (let x = 0; x < W * 0.7; x++) {
        const f = 30 * Math.pow(16000 / 30, x / (W * 0.7));
        const i = Math.min(bins - 1, Math.round((f / (sr / 2)) * bins));
        const y = H - Math.max(0, Math.min(1, (fft[i] + 100) / 80)) * (H - 10);
        if (x === 0) g2.moveTo(x, y);
        else g2.lineTo(x, y);
      }
      g2.stroke();
      g2.fillStyle = '#3a3f4b';
      for (const f of [100, 1000, 10000]) {
        const x = (Math.log(f / 30) / Math.log(16000 / 30)) * W * 0.7;
        g2.fillRect(x, 0, 1, H);
        g2.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3, 12);
      }
      // scope
      g2.strokeStyle = '#ff2e63';
      g2.beginPath();
      const x0 = W * 0.72;
      for (let i = 0; i < 512; i++) {
        const x = x0 + (i / 512) * (W * 0.27);
        const y = H / 2 - wave[i] * (H * 0.45);
        if (i === 0) g2.moveTo(x, y);
        else g2.lineTo(x, y);
      }
      g2.stroke();
      let pk = 0;
      let sq = 0;
      for (let i = 0; i < wave.length; i++) {
        pk = Math.max(pk, Math.abs(wave[i]));
        sq += wave[i] * wave[i];
      }
      const pkDb = 20 * Math.log10(Math.max(pk, 1e-6));
      const rmsDb = 10 * Math.log10(Math.max(sq / wave.length, 1e-12));
      peakHold = Math.max(pkDb, peakHold - 0.4);
      g2.fillStyle = '#eef0f3';
      g2.fillText(`peak ${pkDb.toFixed(1)} dBFS   hold ${peakHold.toFixed(1)}   rms ${rmsDb.toFixed(1)}`, x0, H - 8);
    }
    const ctx = sys.ctx as AudioContext;
    status.textContent = `audio: ${sys.unlocked ? 'running' : 'suspended (click / key / pad button)'}  |  ${ctx.sampleRate} Hz  |  base latency ${(((ctx as AudioContext).baseLatency ?? 0) * 1000).toFixed(1)} ms`;
    startBtn.style.display = sys.unlocked ? 'none' : '';
    readout.textContent =
      `rpm ${st.rpm.toFixed(0).padStart(5)}  gear ${String(st.gear).padStart(2)}  speed ${(st.speed * 3.6).toFixed(0).padStart(3)} km/h  load ${st.engineLoad.toFixed(2)}  throttle ${st.throttle.toFixed(2)}  boost ${st.boost.toFixed(2)}  limiter ${st.revLimiter ? 'CUT' : '-'}  ` +
      `shifts ${st.shiftCount}  pops ${st.backfireCount}  hits ${st.impactCount}  opponents ${opponents.length}  rain ${rainS.get().toFixed(2)}  wet ${wetS.get().toFixed(2)}`;
  }

  const loop = (): void => {
    frame();
    requestAnimationFrame(loop);
  };
  syncProfileUi();
  requestAnimationFrame(loop);

  // first-gesture unlock (the system also installs its own listeners)
  window.addEventListener('pointerdown', () => void sys.unlock(), { once: false });
  (window as unknown as { __BENCH__: unknown }).__BENCH__ = { sys, camera, get state() { return currentState(); } };
  window.__READY__ = true;
}
