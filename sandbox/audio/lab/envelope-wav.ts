/** Print the short-time RMS envelope of a WAV: node sandbox/audio/lab/run.mjs envelope-wav.ts file.wav [--win 50] */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeWav16 } from '../../../src/audio/wav';
import { rms } from '../../../src/audio/analysis';

const args = process.argv.slice(2);
const wi = args.indexOf('--win');
const winMs = wi >= 0 ? +args[wi + 1] : 50;
const file = args.find((a) => a.endsWith('.wav'))!;
const { sampleRate, channels } = decodeWav16(new Uint8Array(readFileSync(resolve(file))));
const x = channels[0];
const w = Math.floor((winMs / 1000) * sampleRate);
const out: string[] = [];
for (let s = 0; s + w <= x.length; s += w) out.push((20 * Math.log10(rms(x, s, s + w) + 1e-9)).toFixed(0));
console.log(`${file} rms per ${winMs} ms window (dB):\n` + out.join(' '));
