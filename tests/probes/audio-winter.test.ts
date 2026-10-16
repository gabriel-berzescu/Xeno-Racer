/**
 * The levels of the winter surface voices against the others (dB, rms), at a few speeds; written to .cache/audio-winter.txt.
 * Run: AUDIOW=1 npx vitest run tests/probes/audio-winter.test.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { rms, spectralCentroid, welch } from '../../src/audio/analysis';
import { ChassisVoice } from '../../src/audio/dsp/chassis-voice';

const SR = 48000;
const RUN = process.env.AUDIOW === '1';

function render(seconds: number, setup: (v: ChassisVoice) => void): Float32Array {
  const v = new ChassisVoice(SR, 5);
  const n = Math.floor(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  setup(v);
  for (let f = 0; f * 800 < n; f++) v.process(l.subarray(f * 800), r.subarray(f * 800), Math.min(800, n - f * 800));
  return l;
}

describe.skipIf(!RUN)('winter surface voices', () => {
  it('levels', () => {
    const rows: string[] = [];
    const names = ['asphalt', 'curb', 'grass', 'gravel', 'sand', 'dirt', 'snow', 'ice'];
    for (const speed of [10, 20, 40, 60]) {
      for (let i = 0; i < names.length; i++) {
        const l = render(1.6, (v) => {
          v.inp.speed = speed;
          v.inp.surf.fill(0);
          v.inp.surf[i] = 1;
        });
        const db = 20 * Math.log10(rms(l, Math.floor(0.8 * SR), l.length) + 1e-9);
        const c = spectralCentroid(welch(l, 8192, Math.floor(0.8 * SR), l.length), SR, 60, 12000);
        rows.push(`${String(speed).padStart(3)} m/s  ${names[i].padEnd(8)} ${db.toFixed(1).padStart(6)} dB  centroid ${c.toFixed(0)} Hz`);
      }
      rows.push('');
    }
    mkdirSync('.cache', { recursive: true });
    writeFileSync('.cache/audio-winter.txt', rows.join('\n') + '\n');
  });
});
