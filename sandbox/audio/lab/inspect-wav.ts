/**
 * Inspect rendered WAVs: spectrogram + waveform PNGs and level / spectral stats.
 *
 *   node sandbox/audio/lab/run.mjs inspect-wav.ts <file.wav> [more.wav ...] [--fmax 8000]
 *
 * Output goes to .cache/audio-lab/inspect-<name>.png (git-ignored).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { decodeWav16 } from '../../../src/audio/wav';
import { peakAbs, rmsDb, spectralCentroid, welch } from '../../../src/audio/analysis';
import { spectrogramPng } from './png';

const outDir = resolve('.cache/audio-lab');
mkdirSync(outDir, { recursive: true });
const args = process.argv.slice(2);
const fi = args.indexOf('--fmax');
const fmax = fi >= 0 ? +args[fi + 1] : 8000;
const files = args.filter((a, i) => a.endsWith('.wav') && args[i - 1] !== '--fmax');
for (const f of files) {
  const { sampleRate, channels } = decodeWav16(new Uint8Array(readFileSync(resolve(f))));
  const mono = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / channels.length;
  const png = spectrogramPng(mono, sampleRate, [
    { nfft: 4096, hop: 256, fMax: Math.min(1500, fmax), grid: 100, height: 260 },
    { nfft: 2048, hop: 256, fMax: fmax, grid: 1000, height: 300 },
  ]);
  const name = basename(f, '.wav');
  writeFileSync(resolve(outDir, `inspect-${name}.png`), png);
  const psd = welch(mono, 8192, 0, mono.length);
  console.log(
    `${name}: ${(mono.length / sampleRate).toFixed(2)} s, ${channels.length} ch, rms ${rmsDb(mono).toFixed(1)} dB, peak ${(20 * Math.log10(peakAbs(mono))).toFixed(1)} dB, centroid ${spectralCentroid(psd, sampleRate, 40, 12000).toFixed(0)} Hz -> .cache/audio-lab/inspect-${name}.png`,
  );
}
