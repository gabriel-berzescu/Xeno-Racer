/**
 * Micro-benchmarks of the engine's parts: CPU milliseconds per second of audio (lower is better; 100 ms/s = 10x real time).
 *   node sandbox/album/run.mjs sandbox/album/lab/bench.ts
 */
import { Reverb } from '../../../src/audio/album/dsp/reverb';
import { Ladder, Svf, Biquad } from '../../../src/audio/album/dsp/filters';
import { PingPongDelay } from '../../../src/audio/album/fx';
import { Transport } from '../../../src/audio/album/instrument';
import { Synth } from '../../../src/audio/album/instruments/synth';
import { BassGuitar, Guitar } from '../../../src/audio/album/instruments/guitar';
import { AcousticKit } from '../../../src/audio/album/instruments/acoustic-kit';
import { DrumKit } from '../../../src/audio/album/instruments/drums';
import { Chorus, Drive } from '../../../src/audio/album/fx';
import { GuitarAmp } from '../../../src/audio/album/dsp/amp';
import { DarkBass, GrowlBass, AcidBass, ReeseBass } from '../../../src/audio/album/instruments/bass';
import { MasterBus } from '../../../src/audio/album/mixer';

const sr = 48000;
const SEG = 64;
const ctx = { sr, bpm: 128, barBeats: 4, transport: new Transport(), seed: 1 };

function time(label: string, seconds: number, fn: (l: Float64Array, r: Float64Array, n: number, i: number) => void): void {
  const l = new Float64Array(SEG);
  const r = new Float64Array(SEG);
  const blocks = Math.round((seconds * sr) / SEG);
  // warm-up so that the JIT has seen the loop
  for (let i = 0; i < 400; i++) fn(l, r, SEG, i);
  const t0 = performance.now();
  for (let i = 0; i < blocks; i++) {
    l.fill(0);
    r.fill(0);
    fn(l, r, SEG, i);
  }
  const ms = performance.now() - t0;
  console.log(`${label.padEnd(44)} ${(ms / seconds).toFixed(1).padStart(7)} ms per second of audio`);
}

// shared stuff
const noiseL = new Float64Array(SEG);
const noiseR = new Float64Array(SEG);
for (let i = 0; i < SEG; i++) {
  noiseL[i] = Math.sin(i * 0.37) * 0.1;
  noiseR[i] = Math.sin(i * 0.41) * 0.1;
}
const tmpL = new Float64Array(SEG);
const tmpR = new Float64Array(SEG);

const rv = new Reverb(sr, {});
time('reverb (FDN, 8 lines)', 8, (l, r, n) => {
  tmpL.fill(0);
  tmpR.fill(0);
  rv.process(noiseL, noiseR, tmpL, tmpR, n);
});
const dl = new PingPongDelay(ctx, {});
time('ping-pong delay', 8, (_l, _r, n) => {
  tmpL.fill(0);
  tmpR.fill(0);
  dl.run(noiseL, noiseR, tmpL, tmpR, n);
});
const master = new MasterBus(sr);
time('master chain (eq, glue, sat, limiter)', 8, (l, r, n) => {
  for (let i = 0; i < n; i++) {
    l[i] = noiseL[i];
    r[i] = noiseR[i];
  }
  master.process(l, r, n);
});
const lad = new Ladder().set(1200, 0.4, sr);
time('1 ladder filter (per sample)', 8, (l, _r, n) => {
  for (let i = 0; i < n; i++) l[i] = lad.process(noiseL[i]);
});
const svf = new Svf().set(1200, 1, sr);
time('1 SVF filter', 8, (l, _r, n) => {
  for (let i = 0; i < n; i++) l[i] = svf.step(noiseL[i]);
});
const bq = new Biquad().lowpass(1200, 0.7, sr);
time('1 biquad (block)', 8, (l, _r, n) => {
  for (let i = 0; i < n; i++) l[i] = noiseL[i];
  bq.block(l, n);
});

function synthBench(label: string, preset: string, notes: number[], extra: Record<string, unknown> = {}): void {
  const s = new Synth(ctx, { preset, ...extra });
  for (const nt of notes) s.noteOn(nt, 0.8, 0, 0);
  time(label, 8, (l, r, n) => s.process(l, r, n));
}
synthBench('synth supersaw-pad, 4 notes', 'supersaw-pad', [57, 60, 64, 67]);
synthBench('synth supersaw-chord, 4 notes', 'supersaw-chord', [57, 60, 64, 67]);
synthBench('synth warm-pad, 4 notes', 'warm-pad', [57, 60, 64, 67]);
// plucks decay by themselves, so measure an arpeggio: a new note every sixteenth at 128 BPM
const pluck = new Synth(ctx, { preset: 'dark-pluck' });
const arpNotes = [57, 60, 64, 69, 64, 60];
const sixteenth128 = Math.round((sr * 60) / 128 / 4 / SEG);
time('synth dark-pluck arpeggio (16ths)', 8, (l, r, n, i) => {
  if (i % sixteenth128 === 0) pluck.noteOn(arpNotes[Math.floor(i / sixteenth128) % arpNotes.length], 0.8, 0, 0);
  pluck.process(l, r, n);
});
synthBench('synth supersaw-lead, mono', 'supersaw-lead', [69]);
synthBench('synth fm-epiano, 4 notes', 'fm-epiano', [57, 60, 64, 67]);

function bassBench(label: string, make: () => { noteOn(n: number, v: number, d: number, f: number): void; process(l: Float64Array, r: Float64Array, n: number): void }): void {
  const b = make();
  b.noteOn(33, 0.9, 0, 0);
  time(label, 8, (l, r, n) => b.process(l, r, n));
}
bassBench('dark bass (held)', () => new DarkBass(ctx, 'darksynth-bass'));
bassBench('growl bass (held)', () => new GrowlBass(ctx, 'dubstep-growl'));
bassBench('acid bass (held)', () => new AcidBass(ctx, 'acid-303'));
bassBench('reese bass (held)', () => new ReeseBass(ctx, 'reese'));

// a punk rhythm part: a power chord every eighth note at 180 BPM (a sustained chord left to die away would measure the denormal
// tail of the strings instead, which a real render never reaches: idle instruments are skipped)
const g = new Guitar(ctx, 'punk-guitar');
const eighth = Math.round((sr * 60) / 180 / 2 / SEG);
time('guitar, 2 takes, power chords in eighths', 8, (l, r, n, i) => {
  if (i % eighth === 0) for (const nt of [45, 52, 57]) g.noteOn(nt, 0.9, 0, 0);
  if (i % eighth === Math.floor(eighth * 0.8)) for (const nt of [45, 52, 57]) g.noteOff(nt);
  g.process(l, r, n);
});
const amp = new GuitarAmp(sr, {});
time('guitar amp + cab alone (1 take)', 8, (l, _r, n) => {
  for (let i = 0; i < n; i++) l[i] = noiseL[i];
  amp.process(l, n);
});

// bass guitar: eighth notes at 180 BPM
const bg = new BassGuitar(ctx, 'punk-bass');
time('bass guitar, eighth notes', 8, (l, r, n, i) => {
  if (i % eighth === 0) bg.noteOn(33, 0.9, 0, 0);
  if (i % eighth === Math.floor(eighth * 0.8)) bg.noteOff(33);
  bg.process(l, r, n);
});

// drum kits playing a busy punk / dance bar (kick on the beat, snare on 2 and 4, hats in eighths / sixteenths)
const sixteenth = Math.round((sr * 60) / 160 / 4 / SEG);
const ak = new AcousticKit(ctx, 'punk-kit');
ak.prepare?.(new Set(['kick', 'snare', 'hat', 'crash']));
time('acoustic kit (punk-kit), busy bar', 8, (l, r, n, i) => {
  if (i % sixteenth === 0) {
    const step = Math.floor(i / sixteenth) % 16;
    if (step % 4 === 0) ak.hit('kick', 0.9, 0, 0);
    if (step === 4 || step === 12) ak.hit('snare', 0.9, 0, 0);
    if (step % 2 === 0) ak.hit('hat', 0.7, 0, 0);
    if (step === 0) ak.hit('crash', 0.9, 0, 0);
  }
  ak.process(l, r, n);
});
const ek = new DrumKit(ctx, { kick: 'techno-kick', snare: 'tight-snare', hat: 'closed-hat', crash: 'crash' });
time('electronic drum kit, busy bar', 8, (l, r, n, i) => {
  if (i % sixteenth === 0) {
    const step = Math.floor(i / sixteenth) % 16;
    if (step % 4 === 0) ek.hit('kick', 0.9, 0, 0);
    if (step === 4 || step === 12) ek.hit('snare', 0.9, 0, 0);
    ek.hit('hat', 0.7, 0, step % 4 === 2 ? 512 : 0);
    if (step === 0) ek.hit('crash', 0.9, 0, 0);
  }
  ek.process(l, r, n);
});

// insert effects on a stereo signal
const ch = new Chorus(ctx, {});
time('chorus insert', 8, (l, r, n) => {
  for (let i = 0; i < n; i++) {
    l[i] = noiseL[i];
    r[i] = noiseR[i];
  }
  ch.process(l, r, n);
});
const dr = new Drive(ctx, { drive: 14 });
time('drive insert (2x oversampled), mono', 8, (l, _r, n) => {
  for (let i = 0; i < n; i++) l[i] = noiseL[i];
  dr.processMono(l, n);
});
