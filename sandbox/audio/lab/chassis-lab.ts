/**
 * Chassis lab (Node): tire squeal progression, surface noise vs speed, curb, wind, scrape, impacts.
 *
 *   node sandbox/audio/lab/run.mjs chassis-lab.ts squeal|surfaces|impacts|misc|levels
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChassisVoice, SURF, makeChassisInputs } from '../../../src/audio/dsp/chassis-voice';
import { makeSquealLevels, tireSqueal } from '../../../src/audio/tires';
import { makeVehicleState } from '../drive-sim';
import { peakAbs, rmsDb, spectralCentroid, welch, hasNonFinite, strongestPeak } from '../../../src/audio/analysis';
import { encodeWav16 } from '../../../src/audio/wav';
import { spectrogramPng } from './png';
import type { SurfaceType } from '../../../src/core/contracts';

const SR = 48000;
const outDir = resolve('.cache/audio-lab');
mkdirSync(outDir, { recursive: true });
const cmd = process.argv[2] ?? 'squeal';

function render(
  seconds: number,
  setup: (t: number, inp: ReturnType<typeof makeChassisInputs>) => void,
  stereo = true,
  lite = false,
): { l: Float32Array; r: Float32Array } {
  const v = new ChassisVoice(SR, 5);
  const n = Math.floor(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const spf = Math.round(SR / 60);
  v.inp.quality = lite ? 1 : 2;
  for (let f = 0; f * spf < n; f++) {
    setup(f / 60, v.inp);
    const off = f * spf;
    const len = Math.min(spf, n - off);
    v.process(l.subarray(off), stereo ? r.subarray(off) : null, len);
  }
  if (!stereo) r.set(l);
  return { l, r };
}

function save(name: string, l: Float32Array, r: Float32Array, spec = true): void {
  writeFileSync(resolve(outDir, `${name}.wav`), encodeWav16([l, r], SR));
  if (spec) {
    writeFileSync(
      resolve(outDir, `${name}.png`),
      spectrogramPng(l, SR, [
        { nfft: 2048, hop: 256, fMax: 12000, grid: 1000, height: 380 },
        { nfft: 4096, hop: 256, fMax: 1500, grid: 100, height: 220 },
      ]),
    );
  }
}

function seg(name: string, l: Float32Array, r: Float32Array, t0: number, t1: number): string {
  const a = Math.floor(t0 * SR);
  const b = Math.floor(t1 * SR);
  const m = new Float32Array(b - a);
  for (let i = a; i < b; i++) m[i - a] = (l[i] + r[i]) * 0.5;
  const psd = welch(m, 4096, 0, m.length);
  return `${name.padEnd(26)} rms ${rmsDb(m).toFixed(1).padStart(6)} dB  peak ${(20 * Math.log10(peakAbs(m) + 1e-9)).toFixed(1).padStart(6)} dB  centroid ${spectralCentroid(psd, SR, 60, 12000).toFixed(0)} Hz`;
}

if (cmd === 'squeal') {
  // one front wheel + one rear wheel go from grip to full slide while the car drives at 35 m/s
  const wFront = makeVehicleState().wheels[0];
  const wRear = makeVehicleState().wheels[2];
  const lv = makeSquealLevels();
  const T = 8;
  const { l, r } = render(T, (t, inp) => {
    inp.speed = 35;
    inp.interior = 1;
    for (const [idx, w, startT] of [
      [0, wFront, 0.5],
      [1, wFront, 0.5],
      [2, wRear, 0.5],
      [3, wRear, 0.5],
    ] as [number, typeof wFront, number][]) {
      const k = Math.min(1, Math.max(0, (t - startT) / 6));
      w.slipAngle = k * 0.3;
      w.slipRatio = 0;
      w.skid = Math.min(1, Math.max(0, (w.slipAngle - 0.1) / 0.14));
      w.load = 4800;
      w.contact = true;
      w.surface = 'asphalt';
      tireSqueal(w, idx, 35, lv);
      inp.tire[idx * 4] = lv.scrub;
      inp.tire[idx * 4 + 1] = lv.tone;
      inp.tire[idx * 4 + 2] = lv.howl;
      inp.tire[idx * 4 + 3] = lv.pitch;
    }
  });
  save('squeal-sweep', l, r);
  for (let s = 0; s < T; s++) {
    const a = Math.floor(s * SR);
    const m = new Float32Array(SR);
    for (let i = 0; i < SR; i++) m[i] = (l[a + i] + r[a + i]) * 0.5;
    const pk = strongestPeak(welch(m, 8192, 0, m.length), SR, 700, 1500);
    console.log(seg(`t=${s}-${s + 1}s (slip ${((Math.max(0, s - 0.5) / 6) * 17).toFixed(0)}deg)`, l, r, s, s + 1) + `  | tone peak ${pk.freq.toFixed(0)}Hz prominence ${pk.prominenceDb.toFixed(0)}dB`);
  }
  console.log('nonfinite:', hasNonFinite(l) || hasNonFinite(r));
} else if (cmd === 'surfaces') {
  const surfs: [string, number[]][] = [
    ['asphalt', [1, 0, 0, 0, 0, 0]],
    ['curb', [0, 1, 0, 0, 0, 0]],
    ['grass', [0, 0, 1, 0, 0, 0]],
    ['gravel', [0, 0, 0, 1, 0, 0]],
    ['sand', [0, 0, 0, 0, 1, 0]],
    ['dirt', [0, 0, 0, 0, 0, 1]],
  ];
  for (const [name, wts] of surfs) {
    const { l, r } = render(6, (t, inp) => {
      inp.speed = (t / 6) * 70;
      inp.interior = 1;
      for (let i = 0; i < 6; i++) inp.surf[i] = wts[i];
      if (name === 'curb') for (let w = 0; w < 4; w++) inp.curb[w] = w < 2 ? 1 : 0;
      for (let w = 0; w < 4; w++) {
        inp.tire[w * 4] = 0;
        inp.tire[w * 4 + 1] = 0;
        inp.tire[w * 4 + 2] = 0;
      }
    });
    save(`surface-${name}`, l, r, name === 'asphalt' || name === 'curb' || name === 'gravel');
    console.log(`--- ${name}`);
    for (const [a, b] of [
      [0.5, 1.5],
      [2, 3],
      [3.5, 4.5],
      [5, 6],
    ]) console.log(seg(`  ${(((a + b) / 2 / 6) * 70).toFixed(0)} m/s`, l, r, a, b));
  }
  // wind-only check at speed on asphalt
} else if (cmd === 'impacts') {
  const cases: [string, number, number][] = [
    ['wall-light', 0, 3],
    ['wall-medium', 0, 10],
    ['wall-heavy', 0, 28],
    ['car-light', 1, 3],
    ['car-heavy', 1, 20],
    ['ground', 2, 12],
  ];
  const T = cases.length * 2;
  let count = 0;
  const { l, r } = render(T, (t, inp) => {
    inp.speed = 0;
    const k = Math.floor(t / 2);
    const c = cases[Math.min(k, cases.length - 1)];
    if (Math.abs(t - k * 2 - 0.1) < 1 / 120 && count === k) {
      count++;
      inp.impactCount = count;
      inp.impactKind = c[1];
      inp.impactStrength = c[2];
      inp.impactPan = 0.2;
    }
  });
  save('impacts', l, r);
  cases.forEach((c, k) => console.log(seg(c[0], l, r, k * 2, k * 2 + 1.5)));
  console.log('nonfinite:', hasNonFinite(l) || hasNonFinite(r));
} else if (cmd === 'misc') {
  const { l, r } = render(9, (t, inp) => {
    inp.speed = t < 3 ? 70 : 30;
    inp.interior = t > 4.5 ? 1 : 0;
    inp.scrape = t > 3 && t < 6 ? 0.9 : 0;
    for (let w = 0; w < 4; w++) inp.tire[w * 4 + 3] = 1000;
  });
  save('misc-wind-scrape', l, r);
  console.log(seg('wind 70 m/s ext', l, r, 0.5, 2.5));
  console.log(seg('scrape ext 30 m/s', l, r, 3.5, 4.5));
  console.log(seg('scrape int 30 m/s', l, r, 5, 6));
  console.log(seg('plain 30 m/s int', l, r, 7, 9));
} else if (cmd === 'levels') {
  // quick calibration table
  const mk = (surf: number[], speed: number, interior: number, extra?: (i: ReturnType<typeof makeChassisInputs>) => void): string => {
    const { l, r } = render(1.6, (_t, inp) => {
      inp.speed = speed;
      inp.interior = interior;
      for (let i = 0; i < 6; i++) inp.surf[i] = surf[i];
      extra?.(inp);
    });
    const m = new Float32Array(Math.floor(0.8 * SR));
    for (let i = 0; i < m.length; i++) m[i] = (l[Math.floor(0.8 * SR) + i] + r[Math.floor(0.8 * SR) + i]) * 0.5;
    const pk = strongestPeak(welch(m, 8192, 0, m.length), SR, 600, 1600);
    return seg('', l, r, 0.8, 1.6) + `  | peak ${pk.freq.toFixed(0)}Hz prom ${pk.prominenceDb.toFixed(0)}dB`;
  };
  console.log('asphalt 60 int', mk([1, 0, 0, 0, 0, 0], 60, 1));
  console.log('asphalt 60 ext', mk([1, 0, 0, 0, 0, 0], 60, 0));
  console.log('wind-ish 80 ext (asphalt)', mk([1, 0, 0, 0, 0, 0], 80, 0));
  console.log('gravel 25 int', mk([0, 0, 0, 1, 0, 0], 25, 1));
  console.log('grass 25 int', mk([0, 0, 1, 0, 0, 0], 25, 1));
  console.log('curb 40 int', mk([0, 1, 0, 0, 0, 0], 40, 1, (i) => (i.curb[0] = i.curb[2] = 1)));
  console.log(
    'tone full 35 (1 wheel)',
    mk([1, 0, 0, 0, 0, 0], 35, 1, (i) => {
      i.tire[1] = 1;
      i.tire[3] = 1000;
    }),
  );
  console.log(
    'howl full 35 (1 wheel)',
    mk([1, 0, 0, 0, 0, 0], 35, 1, (i) => {
      i.tire[2] = 1;
      i.tire[3] = 900;
    }),
  );
  console.log(
    'scrub full 35 (1 wheel)',
    mk([1, 0, 0, 0, 0, 0], 35, 1, (i) => {
      i.tire[0] = 1;
    }),
  );
}
void SURF;
void (null as unknown as SurfaceType);
