/**
 * The Volta's engine, rendered to files for listening (Node): the engine voice as the game runs it, through the game's own control mapping
 * (CarFrame: the vehicle state into the control vector), at the level the engine bus and the master give it at the default volumes
 * (0.81 x 0.72) and with the chassis (tyres, road, wind) at the effects bus's (0.72 x 0.72) where a scene has it: what reaches the master's
 * compressor and limiter, which are left out. So the levels are comparable from file to file, and the Volta with the LMP-X.
 *
 *   node sandbox/audio/lab/run.mjs volta-previews.ts [--out previews/volta] [--only idle,run,flyby,overrun,nitro,ab] [--ffmpeg path/to/ffmpeg.exe]
 *                                                     [--patch '{"brightness":0.9}']   (a variant of the Volta's profile, to compare)
 *
 * Writes, for every scene, a 192 kbit MP3 (ffmpeg) and a spectrogram PNG (0..2 kHz above: the firing line at 3 x rpm/60 and its 2nd and 3rd
 * harmonics; 0..12 kHz below: the MGU-K's whine on the 14th order, the gear whine, the turbo's whistle):
 *   01-idle-and-blips         the 3000 rpm idle, then three blips of the throttle, the last to the limiter (the engine alone)
 *   02-run-exterior           full throttle from 7000 rpm in first through all eight gears, then the lift: the chase camera, with the chassis
 *   03-run-cockpit            the same as heard by the driver, through a helmet in the open cockpit: the wind over it, the tyres beside it
 *   04-flyby                  trackside, 12 m from the line: the car goes past flat out at 290 km/h (Doppler, distance, the air's low-pass;
 *                             the engine alone, raised 9 dB as a trackside microphone would be)
 *   05-lift-off-overrun       full throttle at 11,500 rpm in sixth, then the lift and the brakes down to 90 km/h: the overrun, the downshifts,
 *                             the MGU-K harvesting (its faint whine) and the few pops, with the chassis
 *   06-nitro-shot             full throttle through the gears with a nitro shot burning from 3.0 to 7.0 s: the MGU-K deploys (its whine)
 *   07-nitro-shot-cockpit     the same in the cockpit
 *   08-lmp-x-then-volta       the LMP-X's run through its gears and then the Volta's, the same scene from the chase camera: the V10 and the V6
 * The DriveSim knows nothing of the electric motor: the shot's whine is the voice's, the car does not pull harder with it here.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CARS } from '../../../src/cars';
import type { CarDefinition, EngineSoundProfile } from '../../../src/core/contracts';
import { CarFrame } from '../../../src/audio/carsound';
import { readEngineInputs } from '../../../src/audio/controls';
import { ChassisVoice, readChassisInputs } from '../../../src/audio/dsp/chassis-voice';
import { EngineVoice, type EngineInputs } from '../../../src/audio/dsp/engine-voice';
import { OnePole } from '../../../src/audio/dsp/filters';
import { volumeCurve } from '../../../src/audio/graph';
import { makeListener, makeSpatialOut, computeSpatial } from '../../../src/audio/spatial';
import { peakAbs, rmsDb } from '../../../src/audio/analysis';
import { encodeWav16 } from '../../../src/audio/wav';
import { DEFAULT_SETTINGS } from '../../../src/core/settings';
import { DriveSim } from '../drive-sim';
import { spectrogramPng } from './png';

const SR = 48000;
const args = process.argv.slice(2);
function opt(name: string, def: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}
const outDir = resolve(opt('out', 'previews/volta'));
const wavDir = resolve('.cache/audio-lab/previews');
const only = opt('only', '').split(',').filter(Boolean);
const FFMPEG = opt(
  'ffmpeg',
  process.env.FFMPEG ?? 'C:/Users/Gabriel/AppData/Local/Microsoft/WinGet/Packages/yt-dlp.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-N-123074-g4e32fb4c2a-win64-gpl/bin/ffmpeg.exe',
);
mkdirSync(outDir, { recursive: true });
mkdirSync(wavDir, { recursive: true });

const base = CARS.find((c) => c.id === 'volta')!;
const volta: CarDefinition = { ...base, sound: { ...base.sound, ...(JSON.parse(opt('patch', '{}')) as Partial<EngineSoundProfile>) } };
const lmp = CARS.find((c) => c.id === 'lmp-x')!;
/** The engine bus and the effects bus, each through the master, at the default volumes (graph.ts): what the voices are turned down by. */
const G_ENGINE = volumeCurve(DEFAULT_SETTINGS.audio.engine) * volumeCurve(DEFAULT_SETTINGS.audio.master);
const G_EFFECTS = volumeCurve(DEFAULT_SETTINGS.audio.effects) * volumeCurve(DEFAULT_SETTINGS.audio.master);

/** A stereo scene: left and right. */
interface Stereo {
  l: Float32Array;
  r: Float32Array;
}

/** What the engine is told at time t: set the fields of `i` (the rest keep what they were). */
type Script = (t: number, i: EngineInputs) => void;

/** Render a scripted engine at 60 control frames a second (the engine alone, centred). */
function renderScript(car: CarDefinition, secs: number, script: Script, interior = 0, seed = 3): Stereo {
  const v = new EngineVoice(SR, car.sound, seed);
  v.helmet = car.visual.openCockpit === true;
  const e = car.physics.engine;
  Object.assign(v.inp, { idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, redlineRpm: e.redlineRpm, interior });
  const n = Math.floor(secs * SR);
  const sig = new Float32Array(n);
  const spf = Math.round(SR / 60);
  for (let f = 0; f * spf < n; f++) {
    script(f / 60, v.inp);
    v.process(sig.subarray(f * spf), Math.min(spf, n - f * spf));
  }
  const l = sig.map((x) => x * G_ENGINE);
  return { l, r: l.slice() };
}

/**
 * A drive with the lab's DriveSim at 60 control frames a second, through the game's own control mapping (CarFrame, the listener riding with
 * the car): `pedal(t)` is the throttle, `brake(t)` the brakes, `nitro(t)` the shot's level (0..1). With `chassis` the tyres, the road and the
 * wind are mixed in. `frame` may move the listener (a flyby): it returns the gain and the air's low-pass for the frame, the engine alone.
 */
function drive(
  car: CarDefinition,
  secs: number,
  opts: {
    gear?: number;
    rpm?: number;
    speed?: number;
    interior?: number;
    seed?: number;
    chassis?: boolean;
    pedal: (t: number) => number;
    brake?: (t: number) => number;
    nitro?: (t: number) => number;
    frame?: (t: number, sim: DriveSim, v: EngineVoice) => { gain: number; lpHz: number };
  },
): Stereo {
  const sim = new DriveSim(car, { gear: opts.gear ?? 1, rpm: opts.rpm, speed: opts.speed });
  const seed = opts.seed ?? 1;
  const v = new EngineVoice(SR, car.sound, seed);
  const ch = new ChassisVoice(SR, seed + 7);
  v.helmet = ch.helmet = car.visual.openCockpit === true;
  const cf = new CarFrame(true);
  const listener = makeListener();
  const n = Math.floor(secs * SR);
  const eng = new Float32Array(n);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const spf = Math.round(SR / 60);
  const lp = new OnePole();
  let g0 = 1;
  for (let f = 0; f * spf < n; f++) {
    const t = f / 60;
    sim.step(1 / 60, opts.pedal(t), opts.brake?.(t) ?? 0);
    sim.st.nitro = opts.nitro?.(t) ?? 0;
    listener.pz = sim.st.position.z + 2.2;
    listener.py = sim.st.position.y;
    cf.compute(sim.st, 1 / 60, listener, opts.interior ?? 0, 2, false);
    readEngineInputs(cf.vec, v.inp);
    readChassisInputs(cf.vec, ch.inp);
    const off = f * spf;
    const len = Math.min(spf, n - off);
    const blk = eng.subarray(off, off + len);
    // (a listener of its own sets the Doppler time-scale before the voice renders the frame)
    const placed = opts.frame?.(t, sim, v);
    v.process(blk, len);
    if (opts.chassis) ch.process(l.subarray(off, off + len), r.subarray(off, off + len), len);
    if (placed) {
      // the panner's distance law and the air's low-pass, ramped over the frame (what the graph does after the voice)
      const { gain, lpHz } = placed;
      const k = 1 - Math.exp((-2 * Math.PI * lpHz) / SR);
      for (let i = 0; i < len; i++) {
        lp.y += k * (blk[i] - lp.y);
        blk[i] = lp.y * (g0 + ((gain - g0) * (i + 1)) / len);
      }
      g0 = gain;
    }
  }
  for (let i = 0; i < n; i++) {
    const e = eng[i] * G_ENGINE;
    l[i] = e + l[i] * G_EFFECTS;
    r[i] = e + r[i] * G_EFFECTS;
  }
  return { l, r };
}

/** The 3000 rpm idle with the throttle blipped at the given times (size = how far it is opened; the engine free-revs on its own inertia). */
function idleAndBlips(car: CarDefinition, blips: { t: number; size: number }[]): Script {
  const e = car.physics.engine;
  let rpm = e.idleRpm;
  let last = 0;
  return (t, i) => {
    const dt = t - last;
    last = t;
    let thr = 0;
    for (const b of blips) if (t >= b.t && t < b.t + 0.16 + 0.22 * b.size) thr = b.size;
    // (an engine with 0.07 kg m^2 on its crank: it is at 12,000 rpm in a quarter of a second and back down nearly as fast)
    const target = thr > 0 ? Math.min(e.limiterRpm, e.idleRpm + 10500 * thr) : e.idleRpm;
    const k = thr > 0 ? 1 - Math.exp(-dt / 0.08) : 1 - Math.exp(-dt / 0.22);
    rpm += (target - rpm) * k;
    i.rpm = rpm;
    i.throttle = thr;
    i.pedal = thr;
    i.load = 0.3 * thr + 0.05;
    i.boost = 0.4 * thr;
    i.limiter = rpm > e.limiterRpm * 0.995 ? 1 : 0;
  };
}

function save(name: string, x: Stereo, gainDb = 0): void {
  const g = Math.pow(10, gainDb / 20);
  const l = gainDb === 0 ? x.l : x.l.map((s) => s * g);
  const r = gainDb === 0 ? x.r : x.r.map((s) => s * g);
  const wav = resolve(wavDir, `volta-${name}.wav`);
  writeFileSync(wav, encodeWav16([l, r], SR));
  const mp3 = resolve(outDir, `${name}.mp3`);
  if (existsSync(FFMPEG)) {
    execFileSync(FFMPEG, ['-nostdin', '-y', '-loglevel', 'error', '-i', wav, '-b:a', '192k', mp3]);
  }
  const mono = l.map((s, i) => 0.5 * (s + r[i]));
  writeFileSync(
    resolve(outDir, `${name}.png`),
    spectrogramPng(mono, SR, [
      { nfft: 4096, hop: 256, fMax: 2000, grid: 100, height: 260 },
      { nfft: 2048, hop: 256, fMax: 12000, grid: 1000, height: 220 },
    ]),
  );
  const pk = Math.max(peakAbs(l), peakAbs(r));
  console.log(`${name.padEnd(24)} ${(l.length / SR).toFixed(1).padStart(5)} s  rms ${rmsDb(mono).toFixed(1).padStart(6)} dB  peak ${(20 * Math.log10(pk + 1e-9)).toFixed(1).padStart(6)} dB`);
}

const want = (k: string): boolean => only.length === 0 || only.includes(k);
const flat = (): number => 1;
/** Full throttle until `tLift`, then nothing. */
const until = (tLift: number) => (t: number): number => (t < tLift ? 1 : 0);
/** A nitro shot from t0 to t1, ramped in and out over 0.15 s as the game's NitroTank does. */
const shot = (t0: number, t1: number) => (t: number): number => Math.max(0, Math.min(1, (t - t0) / 0.15, (t1 - t) / 0.15));

if (want('idle')) {
  save('01-idle-and-blips', renderScript(volta, 12, idleAndBlips(volta, [{ t: 3.0, size: 0.35 }, { t: 5.6, size: 0.65 }, { t: 8.2, size: 1 }])));
}
if (want('run')) {
  save('02-run-exterior', drive(volta, 14, { rpm: 7000, pedal: until(12), chassis: true }));
  save('03-run-cockpit', drive(volta, 14, { rpm: 7000, pedal: until(12), chassis: true, interior: 1 }));
}
if (want('flyby')) {
  // the car in seventh, flat out, passes a listener standing 12 m to the side of its line at t = 4 s
  const L = makeListener();
  const sp = makeSpatialOut();
  let z0 = Number.NaN;
  const sig = drive(volta, 8, {
    gear: 7,
    speed: 290 / 3.6,
    pedal: flat,
    frame: (t, sim, v) => {
      if (Number.isNaN(z0)) z0 = sim.st.position.z + 4 * sim.st.speed;
      L.px = 12;
      L.py = 1.2;
      L.pz = z0;
      computeSpatial(L, 0, 0.5, sim.st.position.z, 0, 0, sim.st.velocity.z, false, sp);
      v.inp.timeScale = sp.timeScale;
      // (an opponent's panner: the inverse law from 4 m with a rolloff of 1.15)
      return { gain: 4 / (4 + 1.15 * Math.max(0, sp.distance - 4)), lpHz: sp.lpHz };
    },
  });
  save('04-flyby', sig, 9);
}
if (want('overrun')) {
  // in sixth at 11,500 rpm for a second and a half, then off the throttle and hard on the brakes down to 90 km/h
  save('05-lift-off-overrun', drive(volta, 7, { gear: 6, rpm: 11500, pedal: until(1.5), brake: (t) => (t >= 1.7 && t < 5.2 ? 1 : 0), chassis: true }));
}
if (want('nitro')) {
  save('06-nitro-shot', drive(volta, 10, { rpm: 7000, pedal: flat, nitro: shot(3, 7), chassis: true }));
  save('07-nitro-shot-cockpit', drive(volta, 10, { rpm: 7000, pedal: flat, nitro: shot(3, 7), chassis: true, interior: 1 }));
}
if (want('ab')) {
  const e = lmp.physics.engine;
  const a = drive(lmp, 9, { rpm: e.idleRpm + 0.45 * (e.redlineRpm - e.idleRpm), pedal: until(8), chassis: true });
  const b = drive(volta, 9, { rpm: 7000, pedal: until(8), chassis: true });
  const gap = Math.floor(0.8 * SR);
  const join = (x: Float32Array, y: Float32Array): Float32Array => {
    const o = new Float32Array(x.length + gap + y.length);
    o.set(x, 0);
    o.set(y, x.length + gap);
    return o;
  };
  save('08-lmp-x-then-volta', { l: join(a.l, b.l), r: join(a.r, b.r) });
}
