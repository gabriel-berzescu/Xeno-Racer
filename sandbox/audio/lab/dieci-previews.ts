/**
 * The Dieci's engine, rendered to files for listening (Node): the engine voice as the game runs it, driven by the real physics on a flat
 * plane (PhysicsWorld: its gearbox shuts the throttle for an upshift and blips it for a downshift, its traction control cuts the throttle
 * in the low gears) through the game's own control mapping (CarFrame: the vehicle state into the control vector), at the level the engine
 * bus and the master give it at the default volumes (0.81 x 0.72) and with the chassis (tyres, road, wind) at the effects bus's
 * (0.72 x 0.72) where a scene has it: what reaches the master's compressor and limiter, which are left out. So the levels are comparable
 * from file to file, with the Volta's previews (sandbox/audio/lab/volta-previews.ts) and with the two cars it is played against here.
 *
 *   node sandbox/audio/lab/run.mjs dieci-previews.ts [--out previews/dieci] [--only idle,run,flyby,overrun,nitro,ab] [--ffmpeg path/to/ffmpeg.exe]
 *                                                     [--patch '{"crackle":0.3}']   (a variant of the Dieci's profile, to compare)
 *
 * Writes, for every scene, a 192 kbit MP3 (ffmpeg) and a spectrogram PNG (0..5 kHz above: the firing line at 5 x rpm/60 and its 2nd and
 * 3rd harmonics, the 10th and 15th orders; 0..24 kHz below, to Nyquist: the gear whine, the crackle, and nothing folded back):
 *   01-idle-and-blips         the 4000 rpm idle, then three blips of the throttle, the last to the limiter (the engine alone)
 *   02-run-exterior           full throttle from a standstill through all seven gears, then the lift at 12 s: the chase camera, with the chassis
 *   03-run-cockpit            the same as heard by the driver, through a helmet in the open cockpit: the airbox over it, the wind, the tyres
 *   04-flyby                  trackside, 12 m from the line: the car goes past flat out in 7th at 300 km/h (Doppler, distance, the air's
 *                             low-pass; the engine alone, raised 9 dB as a trackside microphone would be)
 *   05-lift-off-overrun       flat out at 300 km/h in 7th for a second and a half, then the lift and the brakes down to 70 km/h: the overrun,
 *                             the six blipped downshifts and the pops, with the chassis
 *   06-nitro-shot             full throttle from a standstill with a nitro shot burning from 3.0 to 7.0 s: the bottle's push and torque,
 *                             which the voice hears only as the revs and the gears coming quicker (it has nothing electric to whine)
 *   07-volta-then-dieci       the Volta's run from a standstill and then the Dieci's, the same scene from the chase camera: the 2026 V6 and
 *                             the 2004 V10
 *   08-lmp-x-then-dieci       the LMP-X's run and then the Dieci's: two V10s, 9000 rpm and 19,000
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Quaternion, Vector3 } from 'three';
import { CARS } from '../../../src/cars';
import type { CarDefinition, EngineSoundProfile, VehicleState } from '../../../src/core/contracts';
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
import { PhysicsWorld, createFlatTrack } from '../../../src/physics';
import { spectrogramPng } from './png';

const SR = 48000;
const args = process.argv.slice(2);
function opt(name: string, def: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}
const outDir = resolve(opt('out', 'previews/dieci'));
const wavDir = resolve('.cache/audio-lab/previews');
const only = opt('only', '').split(',').filter(Boolean);
const FFMPEG = opt(
  'ffmpeg',
  process.env.FFMPEG ?? 'C:/Users/Gabriel/AppData/Local/Microsoft/WinGet/Packages/yt-dlp.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-N-123074-g4e32fb4c2a-win64-gpl/bin/ffmpeg.exe',
);
mkdirSync(outDir, { recursive: true });
mkdirSync(wavDir, { recursive: true });

const base = CARS.find((c) => c.id === 'dieci')!;
const dieci: CarDefinition = { ...base, sound: { ...base.sound, ...(JSON.parse(opt('patch', '{}')) as Partial<EngineSoundProfile>) } };
const volta = CARS.find((c) => c.id === 'volta')!;
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
 * A drive through the real physics on a flat plane at 60 frames a second, the gearbox shifting itself, through the game's own control
 * mapping (CarFrame, the listener riding with the car): `pedal(t, kmh)` is the throttle, `brake(t, kmh)` the brakes, `nitro(t)` the shot's
 * level (0..1). `kmh` in `gear` starts it rolling. With `chassis` the tyres, the road and the wind are mixed in. `frame` may move the
 * listener (a flyby): it returns the gain and the air's low-pass for the frame, the engine alone.
 */
function drive(
  car: CarDefinition,
  secs: number,
  opts: {
    gear?: number;
    kmh?: number;
    interior?: number;
    seed?: number;
    chassis?: boolean;
    pedal: (t: number, kmh: number) => number;
    brake?: (t: number, kmh: number) => number;
    nitro?: (t: number) => number;
    frame?: (t: number, st: VehicleState, v: EngineVoice) => { gain: number; lpHz: number };
  },
): Stereo {
  const world = new PhysicsWorld(createFlatTrack());
  const vehicle = world.addVehicle(car);
  vehicle.gear = opts.gear ?? 1;
  vehicle.placeOnGround(new Vector3(), new Quaternion(), (opts.kmh ?? 0) / 3.6);
  vehicle.setTemperatures(1);
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
    const kmh = vehicle.state.speed * 3.6;
    vehicle.controls.throttle = opts.pedal(t, kmh);
    vehicle.controls.brake = opts.brake?.(t, kmh) ?? 0;
    vehicle.nitro = opts.nitro?.(t) ?? 0;
    world.step(1 / 60);
    const st = vehicle.state;
    // (the listener rides with the car, 2.2 m off it: no Doppler)
    listener.px = st.position.x;
    listener.py = st.position.y;
    listener.pz = st.position.z + 2.2;
    listener.vx = st.velocity.x;
    listener.vy = st.velocity.y;
    listener.vz = st.velocity.z;
    cf.compute(st, 1 / 60, listener, opts.interior ?? 0, 2, false);
    readEngineInputs(cf.vec, v.inp);
    readChassisInputs(cf.vec, ch.inp);
    const off = f * spf;
    const len = Math.min(spf, n - off);
    const blk = eng.subarray(off, off + len);
    // (a listener of its own sets the Doppler time-scale before the voice renders the frame)
    const placed = opts.frame?.(t, st, v);
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

/** The idle with the throttle blipped at the given times (size = how far it is opened; the engine free-revs on its own inertia). */
function idleAndBlips(car: CarDefinition, blips: { t: number; size: number }[]): Script {
  const e = car.physics.engine;
  let rpm = e.idleRpm;
  let last = 0;
  return (t, i) => {
    const dt = t - last;
    last = t;
    let thr = 0;
    for (const b of blips) if (t >= b.t && t < b.t + 0.16 + 0.22 * b.size) thr = b.size;
    // (a V10 with 0.05 kg m^2 on its crank: it is at 15,000 rpm in a fifth of a second and back down nearly as fast; a full blip reaches the limiter)
    const target = thr > 0 ? Math.min(e.limiterRpm, e.idleRpm + 1.1 * (e.limiterRpm - e.idleRpm) * thr) : e.idleRpm;
    const k = thr > 0 ? 1 - Math.exp(-dt / 0.06) : 1 - Math.exp(-dt / 0.2);
    rpm += (target - rpm) * k;
    i.rpm = rpm;
    i.throttle = thr;
    i.pedal = thr;
    i.load = 0.3 * thr + 0.05;
    i.boost = 0;
    i.limiter = rpm > e.limiterRpm * 0.995 ? 1 : 0;
  };
}

function save(name: string, x: Stereo, gainDb = 0): void {
  const g = Math.pow(10, gainDb / 20);
  const l = gainDb === 0 ? x.l : x.l.map((s) => s * g);
  const r = gainDb === 0 ? x.r : x.r.map((s) => s * g);
  const wav = resolve(wavDir, `dieci-${name}.wav`);
  writeFileSync(wav, encodeWav16([l, r], SR));
  const mp3 = resolve(outDir, `${name}.mp3`);
  if (existsSync(FFMPEG)) {
    execFileSync(FFMPEG, ['-nostdin', '-y', '-loglevel', 'error', '-i', wav, '-b:a', '192k', mp3]);
  }
  const mono = l.map((s, i) => 0.5 * (s + r[i]));
  writeFileSync(
    resolve(outDir, `${name}.png`),
    spectrogramPng(mono, SR, [
      { nfft: 4096, hop: 256, fMax: 5000, grid: 500, height: 300 },
      { nfft: 2048, hop: 256, fMax: 24000, grid: 2000, height: 240 },
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
/** Join scenes with 0.8 s of silence between them. */
function join(...xs: Stereo[]): Stereo {
  const gap = Math.floor(0.8 * SR);
  const len = xs.reduce((s, x) => s + x.l.length, 0) + gap * (xs.length - 1);
  const o: Stereo = { l: new Float32Array(len), r: new Float32Array(len) };
  let at = 0;
  for (const x of xs) {
    o.l.set(x.l, at);
    o.r.set(x.r, at);
    at += x.l.length + gap;
  }
  return o;
}

if (want('idle')) {
  save('01-idle-and-blips', renderScript(dieci, 12, idleAndBlips(dieci, [{ t: 3.0, size: 0.35 }, { t: 5.6, size: 0.65 }, { t: 8.2, size: 1 }])));
}
if (want('run')) {
  save('02-run-exterior', drive(dieci, 14, { pedal: until(12), chassis: true }));
  save('03-run-cockpit', drive(dieci, 14, { pedal: until(12), chassis: true, interior: 1 }));
}
if (want('flyby')) {
  // the car in seventh, flat out, passes a listener standing 12 m to the side of its line at t = 4 s
  const L = makeListener();
  const sp = makeSpatialOut();
  let z0 = Number.NaN;
  const sig = drive(dieci, 8, {
    gear: 7,
    kmh: 300,
    pedal: flat,
    frame: (t, st, v) => {
      if (Number.isNaN(z0)) z0 = st.position.z + 4 * st.speed;
      L.px = 12;
      L.py = 1.2;
      L.pz = z0;
      computeSpatial(L, st.position.x, 0.5, st.position.z, st.velocity.x, 0, st.velocity.z, false, sp);
      v.inp.timeScale = sp.timeScale;
      // (an opponent's panner: the inverse law from 4 m with a rolloff of 1.15)
      return { gain: 4 / (4 + 1.15 * Math.max(0, sp.distance - 4)), lpHz: sp.lpHz };
    },
  });
  save('04-flyby', sig, 9);
}
if (want('overrun')) {
  // in seventh at 300 km/h for a second and a half, then off the throttle and hard on the brakes down to 70 km/h, then rolling
  let braking = true;
  const brake = (t: number, kmh: number): number => {
    if (kmh < 70) braking = false;
    return t >= 1.5 && braking ? 1 : 0;
  };
  save('05-lift-off-overrun', drive(dieci, 6, { gear: 7, kmh: 300, pedal: until(1.5), brake, chassis: true }));
}
if (want('nitro')) {
  save('06-nitro-shot', drive(dieci, 10, { pedal: flat, nitro: shot(3, 7), chassis: true }));
}
if (want('ab')) {
  const run = (car: CarDefinition): Stereo => drive(car, 9, { pedal: until(8), chassis: true });
  const d = run(dieci);
  save('07-volta-then-dieci', join(run(volta), d));
  save('08-lmp-x-then-dieci', join(run(lmp), d));
}
