/**
 * Guitar lab: checks the string model and the amp with numbers.
 *   node sandbox/album/run.mjs sandbox/album/lab/guitar-lab.ts [preset] [--set gain=0.7 ...]
 * Prints: tuning error of clean notes, a 1/3-octave spectrum of a chugging rhythm part against a reference curve of typical
 * recorded rhythm guitar, the envelope of a palm-muted and an open chord, and the harmonic structure of one distorted note.
 */
import { defineTrack } from '../../../src/audio/album/song';
import type { Song } from '../../../src/audio/album/song';
import { pitchOf, renderAll, saveSpectrogram, saveWav, envelopeDb, db } from './tools';
import { welch } from '../../../src/audio/analysis';

const argv = process.argv.slice(2);
const preset = argv.find((a) => !a.startsWith('--') && !a.includes('=')) ?? 'punk-guitar-L';
const sets = argv.reduce<string[]>((acc, a, i) => (a === '--set' ? [...acc, argv[i + 1]] : acc), []);
const sr = 48000;

function render(pat: string, bars: number, bpm: number, extra: Record<string, number> = {}): Float32Array {
  const def = defineTrack({ id: 'gl', title: 'GL', genre: 'Test', bpm, bars, tail: 1 }, (s: Song) => {
    const ch = s.guitar(preset, { gain: 0 });
    for (const [k, v] of Object.entries(extra)) ch.inst.setParam(k, v);
    for (const kv of sets) {
      const [k, v] = kv.split('=');
      ch.inst.setParam(k, Number(v));
    }
    ch.play(s.notes(pat, { free: true }), 0, bars);
    s.master.raw = true;
  });
  const [l, r] = renderAll(def.build(sr).toRenderer());
  // a single-take preset can be panned hard to one side (punk-guitar-R): measure the sum of both sides
  const m = new Float32Array(l.length);
  for (let i = 0; i < m.length; i++) m[i] = l[i] + r[i];
  return m;
}

// 1) tuning of the dry string (gain 0, no boost, flat tone)
console.log('--- tuning (clean, amp neutral) ---');
for (const [name, midi] of [['E2', 40], ['A2', 45], ['E3', 52], ['A3', 57], ['E4', 64], ['A4', 69]] as [string, number][]) {
  const x = render(`${name}:8 - - - - - - -`, 1, 120, { gain: 0, boost: 0, tight: 0, sag: 0, gate: -90, bass: 0, mid: 0, treble: 0, presence: 0, detune: 0, pickup: 0, attackBend: 0, timing: 0 });
  const f = pitchOf(x, sr, Math.round(0.25 * sr), Math.round(0.6 * sr), 60, 1000);
  const target = 440 * Math.pow(2, (midi - 69) / 12);
  console.log(`${name}: ${f.toFixed(2)} Hz (target ${target.toFixed(2)}, error ${(1200 * Math.log2(f / target)).toFixed(1)} cents)`);
}

// 2) spectrum of a rhythm part vs a reference curve
console.log('--- rhythm spectrum (1/3 octave, dB relative to the 1 kHz band) ---');
const riff = '[A2,E3,A3]{pm} [A2,E3,A3]{pm} [A2,E3,A3]{pm} [A2,E3,A3]{pm} [C3,G3,C4]! . [D3,A3,D4] . | [A2,E3,A3]{pm} [A2,E3,A3]{pm} [E2,B2,E3]{pm} [E2,B2,E3]{pm} [G2,D3,G3]! . [A2,E3,A3]:2 .';
const x = render(riff, 8, 180);
saveWav('.cache/album-lab/out/guitar-lab-riff.wav', x, x, sr);
saveSpectrogram('.cache/album-lab/out/guitar-lab-riff.spec.png', x, sr, { fMax: 10000 });
const nfft = 16384;
const p = welch(x, nfft, Math.round(0.5 * sr), x.length);
const df = sr / nfft;
const centres = [63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500];
const bandPow = (fc: number): number => {
  const lo = fc / Math.pow(2, 1 / 6);
  const hi = fc * Math.pow(2, 1 / 6);
  let s = 0;
  for (let i = Math.floor(lo / df); i <= Math.ceil(hi / df); i++) s += p[i];
  return s;
};
const ref1k = bandPow(1000);
// reference: typical recorded distorted rhythm guitar, 1/3-oct level relative to 1 kHz
const REF: Record<number, number> = { 63: -14, 80: -8, 100: -4, 125: -2, 160: 0, 200: 1, 250: 1, 315: 1, 400: 1, 500: 1, 630: 1, 800: 1, 1000: 0, 1250: 0, 1600: -1, 2000: -2, 2500: -4, 3150: -6, 4000: -9, 5000: -13, 6300: -19, 8000: -27, 10000: -35, 12500: -43 };
const rows = centres.map((fc) => {
  const rel = 10 * Math.log10(bandPow(fc) / ref1k + 1e-12);
  const ref = REF[fc];
  return `${String(fc).padStart(6)} Hz  ${rel.toFixed(1).padStart(6)}  (ref ${String(ref).padStart(4)}, diff ${(rel - ref).toFixed(1).padStart(5)})  ${'#'.repeat(Math.max(0, Math.round(rel + 40) / 2))}`;
});
console.log(rows.join('\n'));

// 3) envelope of a palm-muted and an open chord
console.log('--- envelopes (rms dB per 20 ms window) ---');
for (const [label, pat] of [['palm-muted A5', '[A2,E3,A3]{pm}:2 . . . . . . .'], ['open A5 (note off after 1 beat)', '[A2,E3,A3]:4 - - - . . . .'], ['open A5 let ring', '[A2,E3,A3]{ring}:4 - - - . . . .']] as [string, string][]) {
  const y = render(pat, 1, 120);
  const e = envelopeDb(y, sr, 20, 20);
  console.log(`${label}: ` + e.db.slice(0, 26).map((v) => v.toFixed(0)).join(' '));
}

// 4) one distorted note: harmonic structure
console.log('--- one note A2 through the amp: harmonic levels (dB relative to the strongest) ---');
const one = render('A2:12 - - - - - - - - - - -', 1, 120);
const pp = welch(one, 32768, Math.round(0.3 * sr), Math.round(1.5 * sr));
const dff = sr / 32768;
const hs: string[] = [];
let hmax = 1e-20;
for (let h = 1; h <= 20; h++) {
  const f = 110 * h;
  let m = 0;
  for (let i = Math.round((f * 0.985) / dff); i <= Math.round((f * 1.015) / dff); i++) m = Math.max(m, pp[i]);
  hs.push(String(m));
  hmax = Math.max(hmax, m);
}
console.log(hs.map((v, i) => `h${i + 1}:${(10 * Math.log10(Number(v) / hmax + 1e-12)).toFixed(0)}`).join(' '));
let pkv = 0;
for (let i = 0; i < one.length; i++) pkv = Math.max(pkv, Math.abs(one[i]));
console.log(`peak ${db(pkv).toFixed(1)} dBFS`);
