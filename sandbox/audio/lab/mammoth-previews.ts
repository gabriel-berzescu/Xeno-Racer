/**
 * The Mammoth's engine, rendered to files for listening (Node): the raw engine voice, no master chain, so the levels are the voice's own
 * and the cars can be compared with each other at the level the game would give them before its buses.
 *
 *   node sandbox/audio/lab/run.mjs mammoth-previews.ts [--out previews/mammoth] [--only idle,run3,overrun,ab] [--ffmpeg path/to/ffmpeg.exe]
 *
 * Writes, for every scene, a 192 kbit MP3 (ffmpeg, stereo from the mono voice) and a spectrogram PNG:
 *   01-idle-and-blips         cold idle settling, then three blips of the throttle: the lope
 *   02-run3-exterior          full throttle through the gears (the lab's run3, 10 s)
 *   03-run3-cockpit           the same, as heard in the cabin
 *   04-vanta-run3-exterior    the Vanta GT's run3 for comparison (flat-plane V8, turbo)
 *   05-lift-off-overrun       a lift from 5000 rpm at full throttle: the burble and the pops
 *   06-ab-merged-then-dual    the same cross-plane V8 twice, its banks merged in an X-pipe and then in a true dual exhaust
 *   07-cockpit-idle-and-blips the idle and the blips in the cabin
 * The scenes that are not about the Mammoth use the same engine code as the game: nothing here is mixed or EQ'd.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CARS } from '../../../src/cars';
import type { CarDefinition, EngineSoundProfile } from '../../../src/core/contracts';
import { makeControlVector, readEngineInputs, writeEngineControls } from '../../../src/audio/controls';
import { EngineVoice, type EngineInputs } from '../../../src/audio/dsp/engine-voice';
import { peakAbs, rmsDb } from '../../../src/audio/analysis';
import { encodeWav16 } from '../../../src/audio/wav';
import { DriveSim } from '../drive-sim';
import { spectrogramPng } from './png';

const SR = 48000;
const args = process.argv.slice(2);
function opt(name: string, def: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}
const outDir = resolve(opt('out', 'previews/mammoth'));
const wavDir = resolve('.cache/audio-lab/previews');
const only = opt('only', '').split(',').filter(Boolean);
const FFMPEG = opt(
  'ffmpeg',
  process.env.FFMPEG ?? 'C:/Users/Gabriel/AppData/Local/Microsoft/WinGet/Packages/yt-dlp.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-N-123074-g4e32fb4c2a-win64-gpl/bin/ffmpeg.exe',
);
mkdirSync(outDir, { recursive: true });
mkdirSync(wavDir, { recursive: true });

const mammoth = CARS.find((c) => c.id === 'mammoth')!;
const vanta = CARS.find((c) => c.id === 'vanta-gt')!;

/** What the engine is told at time t: set the fields of `i` (the rest keep what they were). */
type Script = (t: number, i: EngineInputs) => void;

function limits(car: CarDefinition, i: EngineInputs): void {
  const e = car.physics.engine;
  i.idleRpm = e.idleRpm;
  i.limiterRpm = e.limiterRpm;
  i.redlineRpm = e.redlineRpm;
}

/** Render a scripted engine at 60 control frames a second. */
function renderScript(car: CarDefinition, profile: EngineSoundProfile, secs: number, script: Script, interior = 0, seed = 3): Float32Array {
  const v = new EngineVoice(SR, profile, seed);
  limits(car, v.inp);
  v.inp.interior = interior;
  const n = Math.floor(secs * SR);
  const sig = new Float32Array(n);
  const spf = Math.round(SR / 60);
  for (let f = 0; f * spf < n; f++) {
    script(f / 60, v.inp);
    v.process(sig.subarray(f * spf), Math.min(spf, n - f * spf));
  }
  return sig;
}

/** The drive through the gears of the lab (run3): full throttle from 38 % of the rev range until third gear nears the limiter, then the lift. */
function run3(car: CarDefinition, secs: number, interior: number, seed = 1): Float32Array {
  const e = car.physics.engine;
  const sim = new DriveSim(car, { gear: 1, rpm: e.idleRpm + 0.38 * (e.redlineRpm - e.idleRpm) });
  const v = new EngineVoice(SR, car.sound, seed);
  const n = Math.floor(secs * SR);
  const sig = new Float32Array(n);
  const vec = makeControlVector();
  const spf = Math.round(SR / 60);
  let lifted = -1;
  for (let f = 0; f * spf < n; f++) {
    const t = f / 60;
    if (lifted < 0 && sim.st.gear === 3 && sim.st.rpm > 0.9 * e.limiterRpm) lifted = t;
    sim.step(1 / 60, lifted < 0 ? 1 : 0, 0);
    writeEngineControls(vec, sim.st);
    readEngineInputs(vec, v.inp);
    v.inp.interior = interior;
    v.process(sig.subarray(f * spf), Math.min(spf, n - f * spf));
  }
  return sig;
}

/** A cold idle that settles (the choke's high idle falls away), with the throttle blipped at the given times (size = how far it is opened). */
function idleAndBlips(car: CarDefinition, secs: number, blips: { t: number; size: number }[]): Script {
  const e = car.physics.engine;
  let rpm = e.idleRpm * 1.75;
  let last = 0;
  return (t, i) => {
    const dt = t - last;
    last = t;
    let thr = 0;
    for (const b of blips) if (t >= b.t && t < b.t + 0.22 + 0.25 * b.size) thr = b.size;
    const idleT = e.idleRpm * (1 + 0.75 * Math.exp(-t / 2.6));
    // a blip: the engine free-revs (no load but its own inertia) up to a speed that grows with the opening, then falls back
    const target = thr > 0 ? idleT + 6200 * thr : idleT;
    const k = thr > 0 ? 1 - Math.exp(-dt / 0.1) : 1 - Math.exp(-dt / 0.32);
    rpm += (target - rpm) * k;
    i.rpm = rpm;
    i.throttle = thr;
    i.pedal = thr;
    i.load = 0.28 * thr + 0.05;
    i.boost = 0;
    void secs;
  };
}

/** A lift-off: full throttle through 3000..5000 rpm, then the pedal comes off at `tLift` and the car slows on the engine. */
function liftOff(car: CarDefinition, tLift: number): Script {
  const e = car.physics.engine;
  return (t, i) => {
    const lift = t >= tLift;
    i.rpm = lift ? Math.max(e.idleRpm * 1.6, 5000 - ((t - tLift) / 5.2) * 3900) : 3000 + 2000 * Math.min(1, t / tLift);
    i.throttle = lift ? 0 : 1;
    i.pedal = lift ? 0 : 1;
    i.load = lift ? 0 : 1;
  };
}

/** A pull at a steady 3000..4200 rpm at full throttle (a rev sweep), for the A/B. */
function pull(from: number, to: number, t0: number, t1: number): Script {
  return (t, i) => {
    const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    i.rpm = from + (to - from) * u;
    i.throttle = i.pedal = i.load = 1;
  };
}

function save(name: string, sig: Float32Array, gainDb = 0): void {
  const g = Math.pow(10, gainDb / 20);
  const x = gainDb === 0 ? sig : sig.map((s) => s * g);
  const wav = resolve(wavDir, `${name}.wav`);
  writeFileSync(wav, encodeWav16([x], SR));
  const mp3 = resolve(outDir, `${name}.mp3`);
  if (existsSync(FFMPEG)) {
    execFileSync(FFMPEG, ['-nostdin', '-y', '-loglevel', 'error', '-i', wav, '-ac', '2', '-b:a', '192k', mp3]);
  }
  writeFileSync(
    resolve(outDir, `${name}.png`),
    spectrogramPng(x, SR, [
      { nfft: 4096, hop: 256, fMax: 1500, grid: 100, height: 240 },
      { nfft: 2048, hop: 256, fMax: 8000, grid: 1000, height: 200 },
    ]),
  );
  console.log(`${name.padEnd(28)} ${(x.length / SR).toFixed(1).padStart(5)} s  rms ${rmsDb(x).toFixed(1).padStart(6)} dB  peak ${(20 * Math.log10(peakAbs(x) + 1e-9)).toFixed(1).padStart(6)} dB`);
}

const want = (k: string): boolean => only.length === 0 || only.includes(k);

if (want('idle')) {
  const blips = [
    { t: 6.2, size: 0.3 },
    { t: 8.6, size: 0.55 },
    { t: 11.0, size: 0.8 },
  ];
  save('01-idle-and-blips', renderScript(mammoth, mammoth.sound, 15, idleAndBlips(mammoth, 15, blips)));
  save('07-cockpit-idle-and-blips', renderScript(mammoth, mammoth.sound, 15, idleAndBlips(mammoth, 15, blips), 1));
}
if (want('run3')) {
  save('02-run3-exterior', run3(mammoth, 10, 0));
  save('03-run3-cockpit', run3(mammoth, 10, 1));
  save('04-vanta-run3-exterior', run3(vanta, 10, 0));
}
if (want('overrun')) save('05-lift-off-overrun', renderScript(mammoth, mammoth.sound, 8, liftOff(mammoth, 1.6)));
if (want('ab')) {
  // the same scene twice, the banks merged in an X-pipe and then in a true dual exhaust: a warm idle, a roll up through 1000..2200 rpm on a light
  // pedal (where the lope lives), then a pull at full throttle through 2200..4600
  const scene = (): Script => {
    const e = mammoth.physics.engine;
    return (t, i) => {
      if (t < 2.4) {
        i.rpm = e.idleRpm * 1.06;
        i.throttle = i.pedal = 0;
        i.load = 0.06;
      } else if (t < 5.2) {
        const u = (t - 2.4) / 2.8;
        i.rpm = e.idleRpm * 1.06 + (2200 - e.idleRpm * 1.06) * u * u;
        i.throttle = i.pedal = 0.22;
        i.load = 0.2;
      } else {
        const u = Math.min(1, (t - 5.2) / 3);
        i.rpm = 2200 + 2400 * u;
        i.throttle = i.pedal = i.load = 1;
      }
    };
  };
  const a = renderScript(mammoth, { ...mammoth.sound, exhaustSystem: 'merged' }, 8.4, scene());
  const b = renderScript(mammoth, { ...mammoth.sound, exhaustSystem: 'dual' }, 8.4, scene());
  const gap = new Float32Array(Math.floor(0.8 * SR));
  const both = new Float32Array(a.length + gap.length + b.length);
  both.set(a, 0);
  both.set(b, a.length + gap.length);
  save('06-ab-merged-then-dual', both);
}
