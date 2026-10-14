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
import { followListener, impactCar, passByCar, run3Car, tireCar } from './scenarios';
import { db, peakAbs, rms, toBase64 } from './report-util';

export interface PreviewWav {
  sr: number;
  channels: number;
  seconds: number;
  peakDb: number;
  rmsDb: number;
  base64: string;
  note: string;
}

function pack(r: SceneResult, channels: 1 | 2, note: string): PreviewWav {
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

export async function renderPreviews(log: (m: string) => void): Promise<Record<string, PreviewWav>> {
  const out: Record<string, PreviewWav> = {};

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

  return out;
}
