/**
 * Preview renders: short WAVs of the key scenarios, produced by the REAL audio stack (worklet voices,
 * panners, buses, master compressor + limiter) in an OfflineAudioContext, with all faders at 1.0.
 * render-previews.mjs drives this page headlessly and writes the files to
 * previews/audio/.
 */
import { CARS, getCar } from '../../src/cars';
import { MenuMusic, UiSynth, buildMasterGraph } from '../../src/audio';
import { encodeWav16 } from '../../src/audio/wav';
import type { UiSound } from '../../src/core/contracts';
import { DEFAULT_VOLUMES, SR, renderScene, type SceneResult } from './harness';
import { followListener, impactCar, passByCar, run3Car, steppedCar, tireCar } from './scenarios';
import { db, peakAbs, rms, toBase64 } from './report-util';
import { simulateWiper } from './wiper-sim';

export interface PreviewWav {
  sr: number;
  channels: number;
  seconds: number;
  peakDb: number;
  rmsDb: number;
  base64: string;
  note: string;
}

/** `boostToDb`: scale the whole render so its peak is this many dBFS (for sounds that are quiet by design); the note says by how much. */
function pack(r: SceneResult, channels: 1 | 2, note: string, boostToDb?: number): PreviewWav {
  if (boostToDb !== undefined) {
    const pk = Math.max(peakAbs(r.left), peakAbs(r.right), 1e-9);
    const g = Math.pow(10, boostToDb / 20) / pk;
    r = { ...r, left: r.left.map((x) => x * g), right: r.right.map((x) => x * g) };
    note += ` [raised by ${db(g).toFixed(0)} dB: on its own it is far quieter than this, see the cockpit mixes for its real level]`;
  }
  let data: Float32Array[];
  if (channels === 1) {
    const m = new Float32Array(r.left.length);
    for (let i = 0; i < m.length; i++) m[i] = (r.left[i] + r.right[i]) * 0.5;
    data = [m];
  } else data = [r.left, r.right];
  const bytes = encodeWav16(data, r.sr);
  const peak = Math.max(peakAbs(r.left), peakAbs(r.right));
  const a = Math.floor(0.2 * r.sr);
  return {
    sr: r.sr,
    channels,
    seconds: r.left.length / r.sr,
    peakDb: db(peak),
    rmsDb: db(Math.max(rms(r.left, a, r.left.length), rms(r.right, a, r.right.length))),
    base64: toBase64(bytes),
    note,
  };
}

async function renderUiSequence(events: { t: number; sound: UiSound }[], seconds: number): Promise<SceneResult> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(seconds * SR), sampleRate: SR });
  const graph = buildMasterGraph(ctx, DEFAULT_VOLUMES);
  const ui = new UiSynth(ctx, graph.uiBus);
  for (const e of events) ui.play(e.sound, e.t + 0.02);
  const t0 = performance.now();
  const buf = await ctx.startRendering();
  return { left: buf.getChannelData(0).slice(), right: buf.getChannelData(1).slice(), sr: SR, renderMs: performance.now() - t0, quanta: 0 };
}

async function renderMusicPreview(seconds: number, startBar: number): Promise<SceneResult> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(seconds * SR), sampleRate: SR });
  const graph = buildMasterGraph(ctx, DEFAULT_VOLUMES);
  const music = new MenuMusic(ctx, graph.musicBus, { startBar });
  graph.setMusicGate(1, 0.05);
  music.renderUntil(seconds);
  const t0 = performance.now();
  const buf = await ctx.startRendering();
  return { left: buf.getChannelData(0).slice(), right: buf.getChannelData(1).slice(), sr: SR, renderMs: performance.now() - t0, quanta: 0 };
}

/** `only` = 'wiper' renders just the cockpit-wiper previews (the others take minutes). */
export async function renderPreviews(log: (m: string) => void, only?: string): Promise<Record<string, PreviewWav>> {
  const out: Record<string, PreviewWav> = {};
  if (only === 'wiper') {
    await renderWiperPreviews(out, log);
    return out;
  }

  // 1) each engine: full throttle through 3 gears, lift, overrun pops (chase camera, exterior)
  for (const car of CARS) {
    log(`engine ${car.id}`);
    const c = run3Car(car);
    const r = await renderScene({ seconds: 8, cars: [{ ...c, interior: 0 }], listener: followListener(c, 5, 1.6), volumes: DEFAULT_VOLUMES });
    out[`engine-${car.id}-run3`] = pack(r, 1, `${car.name}: WOT through 3 gears, lift at ${c.liftTime().toFixed(1)} s, overrun pops (chase camera)`);
  }

  // 2) cockpit (interior) mix of the turbo hot hatch: whistle, flutter, pops, more intake / mechanical
  {
    log('interior kestrel');
    const car = getCar('kestrel-r');
    const c = run3Car(car);
    const r = await renderScene({ seconds: 6.5, cars: [{ ...c, interior: 1 }], listener: followListener(c, 0, 1.0), volumes: DEFAULT_VOLUMES });
    out['engine-kestrel-r-interior'] = pack(r, 1, 'Kestrel R from the cockpit: turbo whistle + flutter, intake / mechanical forward, muffled exhaust');
  }

  // 3) tire squeal progression: front axle understeer, recover, rear axle oversteer
  {
    log('tires');
    const car = getCar('vanta-gt');
    const seg = (t: number, a: number, b: number): number => Math.min(1, Math.max(0, (t - a) / (b - a)));
    const frontSlide = (t: number): number => seg(t, 1.0, 3.2) * (1 - seg(t, 3.6, 4.2));
    const rearSlide = (t: number): number => seg(t, 4.6, 6.2) * (1 - seg(t, 6.5, 7.0));
    const sc = tireCar(car, () => 38, (t, w) => {
      const k = w < 2 ? frontSlide(t) : rearSlide(t);
      return { skid: Math.min(1, Math.max(0, (k - 0.35) / 0.5)), slipAngle: 0.02 + 0.3 * k, load: 4800 };
    });
    const stepper = sc.step;
    sc.step = (t, dt, st) => {
      stepper(t, dt, st);
      st.rpm = 4600;
      st.throttle = 0.55;
      st.engineLoad = 0.5;
      st.boost = 0.6;
    };
    const r = await renderScene({ seconds: 7.2, cars: [{ ...sc, interior: 1 }], volumes: DEFAULT_VOLUMES });
    out['tires-slide'] = pack(r, 2, 'Vanta GT at 38 m/s, cockpit: grip -> scrub -> tonal squeal -> ragged howl (front), recover, then rear axle slide');
  }

  // 4) impacts + scrape + glass
  {
    log('impacts');
    const car = getCar('vanta-gt');
    const sc = impactCar(
      car,
      [
        { t: 0.4, kind: 'wall', strength: 3 },
        { t: 1.5, kind: 'wall', strength: 10, localX: 0.8 },
        { t: 2.9, kind: 'wall', strength: 28, localX: -0.9 },
        { t: 5.0, kind: 'car', strength: 16, localX: 0.9 },
        { t: 6.0, kind: 'ground', strength: 12 },
      ],
      (t) => (t > 2.9 && t < 4.7 ? 0.9 * (1 - (t - 2.9) / 2.4) : 0),
      26,
    );
    const r = await renderScene({ seconds: 6.8, cars: [{ ...sc, interior: 0 }], volumes: DEFAULT_VOLUMES });
    out['impacts'] = pack(r, 2, 'wall tap / wall hit / big wall hit with glass + metal scrape / car-to-car / ground slam');
  }

  // 5) UI sounds
  {
    log('ui');
    const a = await renderUiSequence(
      [
        { t: 0.0, sound: 'move' },
        { t: 0.15, sound: 'move' },
        { t: 0.3, sound: 'move' },
        { t: 0.8, sound: 'select' },
        { t: 1.6, sound: 'back' },
        { t: 2.3, sound: 'error' },
        { t: 3.2, sound: 'lap' },
      ],
      4.2,
    );
    out['ui-menu'] = pack(a, 2, 'move x3, select, back, error, lap');
    const b = await renderUiSequence(
      [
        { t: 0.0, sound: 'countdown' },
        { t: 0.7, sound: 'countdown' },
        { t: 1.4, sound: 'countdown' },
        { t: 2.1, sound: 'countdown' },
        { t: 2.8, sound: 'countdown' },
        { t: 3.5, sound: 'go' },
        { t: 4.6, sound: 'bestLap' },
        { t: 5.9, sound: 'finish' },
      ],
      7.8,
    );
    out['ui-race'] = pack(b, 2, 'five start-light beeps, GO, best lap, finish');
  }

  // 6) music (groove -> full band with the lead melody)
  {
    log('music');
    const r = await renderMusicPreview(8, 16);
    out['music-menu'] = pack(r, 2, 'A minor, 96 BPM, Am9-Fmaj9-Cmaj9-G6/9: pad, pumping bass, arpeggio, lead, drums');
  }

  // 7) opponent pass-by: Doppler, panning, distance
  {
    log('doppler');
    const car = getCar('lmp-x');
    const pass = passByCar(car, -170, -9, 62, 0, 8200);
    const r = await renderScene({
      seconds: 5.6,
      cars: [pass],
      volumes: DEFAULT_VOLUMES,
      listener: (_t, L) => {
        L.px = 0;
        L.py = 1;
        L.pz = 0;
        L.fx = 0;
        L.fy = 0;
        L.fz = -1;
        L.ux = 0;
        L.uy = 1;
        L.uz = 0;
        L.vx = L.vy = L.vz = 0;
      },
    });
    out['passby-lmp-x'] = pack(r, 2, 'LMP-X passes a trackside microphone at 62 m/s (223 km/h): Doppler glide, left-to-right pan, distance roll-off');
  }

  // 8) weather: rain ambience, cabin, thunder, wet tires, wheelspin slush, pass-by spray
  await renderWeatherPreviews(out, log);
  // 9) the cockpit wiper: motor, rubber swish, the thunks at both ends of the sweep, a squeak now and then
  await renderWiperPreviews(out, log);
  return out;
}

async function renderWiperPreviews(out: Record<string, PreviewWav>, log: (m: string) => void): Promise<void> {
  const car = getCar('vanta-gt');
  // the wiper alone, raised to a comfortable level to hear what it is made of
  for (const [name, rain, note] of [
    ['wiper-only-rain', 0.55, 'the cockpit wiper alone in the "rain" preset (0.55): one sweep every 3.24 s, the motor winds down at the park position, the glass squeaks now and then'],
    ['wiper-only-storm', 1, 'the cockpit wiper alone in a storm (1.0): a sweep every 0.96 s, the motor never stops, a different sweep every time'],
  ] as const) {
    log(name);
    const sim = simulateWiper({ seconds: 14, rain, fps: 60, jitter: 0.25, seed: 4, plannerSeed: 3 });
    const r = await renderScene({ seconds: 12, cars: [], wiper: { sweeps: sim.sweeps }, volumes: DEFAULT_VOLUMES });
    out[name] = pack(r, 2, note, -3);
  }
  // in the cabin: engine at a steady cruise, a lift, the cruise again, the cabin rain, wet tires, and the wiper on top
  for (const [name, rain, wet, note] of [
    ['wiper-rain-cockpit', 0.55, 0.75, 'Vanta GT in the cockpit view in the "rain" preset: a light cruise, a lift at 8 s, the cruise again. Cabin rain, wet tires and the wiper (a sweep every 3.24 s)'],
    ['wiper-storm-cockpit', 1, 1, 'the same cruise in a storm: the wiper never stops (a sweep every 0.96 s) under the roar of the rain'],
  ] as const) {
    log(name);
    const sim = simulateWiper({ seconds: 18, rain, fps: 60, jitter: 0.25, seed: 4, plannerSeed: 3 });
    const c = steppedCar(car, [
      { t: 0, rpm: 3400, throttle: 0.3, load: 0.3, speed: 33, gear: 4 },
      { t: 8, rpm: 3000, throttle: 0, load: 0, speed: 31, gear: 4 },
      { t: 11, rpm: 3400, throttle: 0.3, load: 0.3, speed: 33, gear: 4 },
    ]);
    const r = await renderScene({
      seconds: 16,
      cars: [{ ...c, interior: 1 }],
      listener: followListener(c, 0, 1.0),
      weather: { rain, interior: 1, speed: 33 },
      wetness: wet,
      wiper: { sweeps: sim.sweeps },
      volumes: DEFAULT_VOLUMES,
    });
    out[name] = pack(r, 2, note);
  }
}

async function renderWeatherPreviews(out: Record<string, PreviewWav>, log: (m: string) => void): Promise<void> {
  const ramp = (t: number, a: number, b: number): number => Math.min(1, Math.max(0, (t - a) / (b - a)));
  // rain alone, outside: dry -> drizzle -> the "rain" preset -> storm
  {
    log('rain exterior');
    const r = await renderScene({
      seconds: 28,
      cars: [],
      weather: { rain: (t) => (t < 1 ? 0 : t < 8 ? 0.15 + 0.4 * ramp(t, 1.5, 7) : t < 16 ? 0.55 : 0.55 + 0.45 * ramp(t, 16, 21)) },
      volumes: DEFAULT_VOLUMES,
    });
    out['rain-exterior'] = pack(r, 2, 'open air: dry for a second, drizzle building to the "rain" preset (0.55) by 8 s, held, then swelling to the full storm by 21 s (no engines)');
  }
  // the same rain from the cockpit: muffled, drumming on the roof, ticks on the windscreen; cut from outside at 10 s
  {
    log('rain interior');
    const r = await renderScene({
      seconds: 20,
      cars: [],
      weather: { rain: 0.8, interior: (t) => (t < 10 ? 0 : 1), speed: (t) => (t < 10 ? 0 : 20 + 3 * (t - 10)) },
      volumes: DEFAULT_VOLUMES,
    });
    out['rain-cockpit'] = pack(r, 2, 'heavy rain: open air for 10 s, then the cockpit view: muffled bed, roof drumming and windscreen ticks (more of them as the car speeds up from 20 to 50 m/s)');
  }
  // a storm with thunder (near, then far)
  {
    log('thunder');
    const r = await renderScene({
      seconds: 40,
      cars: [],
      weather: {
        rain: 1,
        thunders: [
          { t: 4, ev: { distanceKm: 3, level: 1, pan: -0.4, seed: 11 } },
          { t: 24, ev: { distanceKm: 8.5, level: 0.75, pan: 0.5, seed: 22 } },
        ],
      },
      volumes: DEFAULT_VOLUMES,
    });
    out['storm-thunder'] = pack(r, 2, 'full storm with two claps of distant thunder: 3 km (4 s) and 8.5 km (24 s), slow rolling rumble with a long decay');
  }
  // driving in the storm: engine + wet tires + rain; chase camera, then the cockpit
  {
    log('storm drive');
    const car = getCar('vanta-gt');
    const c = run3Car(car);
    const r = await renderScene({
      seconds: 14,
      cars: [{ ...c, interior: (t: number) => (t < 7 ? 0 : 1) }],
      listener: followListener(c, 5, 1.6),
      weather: { rain: 1, interior: (t) => (t < 7 ? 0 : 1), speed: () => 30 },
      wetness: 1,
      volumes: DEFAULT_VOLUMES,
    });
    out['storm-drive'] = pack(r, 2, 'Vanta GT at full throttle in a storm: chase camera for 7 s (rain, tire hiss and spray under the engine), then the cockpit view');
  }
  // tires: dry road, then wet; a cornering squeal on each; coasting so the tires are audible
  {
    log('wet tires');
    const car = getCar('vanta-gt');
    const slideAt = (t: number): number => ramp((t % 6) - 0, 1.2, 2.6) * (1 - ramp(t % 6, 3.4, 4.2));
    const sc = tireCar(car, () => 38, (t, w) => {
      const k = w < 2 ? slideAt(t) : 0;
      return { skid: Math.min(1, Math.max(0, (k - 0.35) / 0.5)), slipAngle: 0.02 + 0.3 * k, load: 4800 };
    });
    const stepper = sc.step;
    sc.step = (t, dt, st) => {
      stepper(t, dt, st);
      st.rpm = 3800;
      st.throttle = 0.12;
      st.engineLoad = 0.15;
    };
    const r = await renderScene({ seconds: 12, cars: [{ ...sc, interior: 1 }], wetness: (t) => (t < 6 ? 0 : 0.75), volumes: DEFAULT_VOLUMES });
    out['wet-tires-squeal'] = pack(r, 2, 'cockpit, 38 m/s, coasting: a front-axle slide on the DRY road (0-6 s: tonal squeal) and the same slide on the WET road (6-12 s: duller, softer squeal over the hiss of the tires)');
  }
  // wheelspin: dry screech, then wet slush
  {
    log('wheelspin');
    const car = getCar('vanta-gt');
    const sc = tireCar(car, (t) => 2 + 4.5 * (t % 6), (t, w) => {
      const k = Math.max(0, 1 - (t % 6) / 4.2);
      return w >= 2 ? { skid: 0.55 * k + 0.01, slipAngle: 0.01, slipRatio: 0.6 * k, load: 5000 } : { skid: 0, slipAngle: 0.01, load: 3500 };
    });
    const stepper = sc.step;
    sc.step = (t, dt, st) => {
      stepper(t, dt, st);
      const k = Math.max(0, 1 - (t % 6) / 4.2);
      for (let i = 2; i < 4; i++) st.wheels[i].omega = (st.speed * (1 + 2.5 * k)) / 0.34;
      st.rpm = 5200;
      st.throttle = 1;
      st.engineLoad = 0.9;
    };
    const r = await renderScene({ seconds: 12, cars: [{ ...sc, interior: 0 }], listener: followListener(sc, 5, 1.6), wetness: (t) => (t < 6 ? 0 : 0.75), volumes: DEFAULT_VOLUMES });
    out['wet-wheelspin'] = pack(r, 2, 'standing start with the rear wheels spinning: DRY (0-6 s: screeching tonal squeal) and WET (6-12 s: no screech, a sloshing spray of slush)');
  }
  // an opponent passes the microphone on a wet road
  {
    log('wet pass-by');
    const car = getCar('lmp-x');
    const pass = passByCar(car, -170, -9, 62, 0, 8200);
    const r = await renderScene({
      seconds: 5.6,
      cars: [pass],
      wetness: 0.85,
      weather: { rain: 0.55 },
      volumes: DEFAULT_VOLUMES,
      listener: (_t, L) => {
        L.px = 0;
        L.py = 1;
        L.pz = 0;
        L.fx = 0;
        L.fy = 0;
        L.fz = -1;
        L.ux = 0;
        L.uy = 1;
        L.uz = 0;
        L.vx = L.vy = L.vz = 0;
      },
    });
    out['passby-lmp-x-wet'] = pack(r, 2, 'the LMP-X passes a trackside microphone at 62 m/s in the rain: Doppler engine plus a whoosh of spray, rain in the background');
  }
}
