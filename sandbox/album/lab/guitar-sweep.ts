/**
 * Sweeps one guitar parameter and prints a compact spectrum comparison:
 *   node sandbox/album/run.mjs sandbox/album/lab/guitar-sweep.ts punk-guitar-L gain 0.3,0.45,0.6,0.75 [--set a=b]
 */
import { defineTrack } from '../../../src/audio/album/song';
import type { Song } from '../../../src/audio/album/song';
import { renderAll } from './tools';
import { welch } from '../../../src/audio/analysis';

const [preset, param, values] = process.argv.slice(2);
const sets = process.argv.slice(2).reduce<string[]>((acc, a, i, arr) => (a === '--set' ? [...acc, arr[i + 1]] : acc), []);
const sr = 48000;
const riff = '[A2,E3,A3]{pm} [A2,E3,A3]{pm} [A2,E3,A3]{pm} [A2,E3,A3]{pm} [C3,G3,C4]! . [D3,A3,D4] . | [A2,E3,A3]{pm} [A2,E3,A3]{pm} [E2,B2,E3]{pm} [E2,B2,E3]{pm} [G2,D3,G3]! . [A2,E3,A3]:2 .';
const centres = [80, 125, 200, 315, 500, 800, 1250, 2000, 3150, 5000, 8000, 12500];
const REF = [-8, -2, 1, 1, 1, 1, 0, -2, -6, -13, -27, -43];
console.log('param value'.padEnd(14) + centres.map((c) => String(c).padStart(6)).join('') + '   rms-err(125..8k)');
console.log('reference'.padEnd(14) + REF.map((v) => String(v).padStart(6)).join(''));
for (const v of (values ?? '').split(',')) {
  const def = defineTrack({ id: 'gs', title: 'GS', genre: 'Test', bpm: 180, bars: 8, tail: 1 }, (s: Song) => {
    const ch = s.guitar(preset, { gain: 0 });
    for (const kv of sets) { const [k, val] = kv.split('='); ch.inst.setParam(k, Number(val)); }
    if (param) ch.inst.setParam(param, Number(v));
    ch.play(s.notes(riff, { free: true }), 0, 8);
    s.master.raw = true;
  });
  const x = renderAll(def.build(sr).toRenderer())[0];
  const nfft = 16384;
  const p = welch(x, nfft, Math.round(0.5 * sr), x.length);
  const df = sr / nfft;
  const band = (fc: number): number => { let s = 0; for (let i = Math.floor(fc / Math.pow(2, 1 / 6) / df); i <= Math.ceil((fc * Math.pow(2, 1 / 6)) / df); i++) s += p[i]; return s; };
  const ref = band(1000);
  const rel = centres.map((c) => 10 * Math.log10(band(c) / ref + 1e-12));
  let e = 0, k = 0;
  rel.forEach((r, i) => { if (centres[i] >= 125 && centres[i] <= 8000) { e += (r - REF[i]) ** 2; k++; } });
  let pk = 0; for (let i = 0; i < x.length; i++) pk = Math.max(pk, Math.abs(x[i]));
  console.log(`${param}=${v}`.padEnd(14) + rel.map((r) => r.toFixed(1).padStart(6)).join('') + `   ${Math.sqrt(e / k).toFixed(1)} dB  peak ${(20 * Math.log10(pk)).toFixed(1)}`);
}
