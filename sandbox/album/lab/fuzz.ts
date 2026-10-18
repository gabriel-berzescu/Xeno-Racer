/**
 * Parameter fuzz: for every instrument, sets each parameter to its minimum, maximum and a mid value (one at a time, and then
 * all at once at random) and renders a short phrase: every result must be finite and bounded. Prints the offenders.
 *   node sandbox/album/run.mjs sandbox/album/lab/fuzz.ts [factory-filter]
 */
import { defineTrack } from '../../../src/audio/album/song';
import type { Song } from '../../../src/audio/album/song';
import { CATALOG } from '../../../src/audio/album/catalog';
import { renderAll } from './tools';
import { Rng } from '../../../src/audio/album/dsp/core';

const filter = process.argv[2] ?? '';
const sr = 44100;
const rng = new Rng(77);
const NOTE_PAT: Record<string, string> = {
  tom: 'A2 . A2 . A2 . A2 .',
  guitar: '[A2,E3,A3] . . . [C3,G3,C4]{pm} . . . [A2,E3,A3]{ring} . . . . . . .',
  default: 'A2 - - . C3 - - . A2 - . . E3 - - .',
};
const DRUMS = new Set(['kick', 'snare', 'clap', 'hat', 'cymbal', 'perc']);
let bad = 0;
let runs = 0;
for (const d of CATALOG) {
  if (!d.factory || (filter && !d.factory.includes(filter))) continue;
  if (d.factory === 'drumKit') continue;
  const specNames = Object.keys(d.specs);
  const presets = Object.keys(d.presets);
  const variants: { label: string; set: Record<string, number> }[] = [{ label: 'defaults', set: {} }];
  for (const k of specNames) {
    const sp = d.specs[k];
    variants.push({ label: `${k}=min`, set: { [k]: sp.min } }, { label: `${k}=max`, set: { [k]: sp.max } });
  }
  for (let i = 0; i < 4; i++) {
    const set: Record<string, number> = {};
    for (const k of specNames) set[k] = d.specs[k].min + rng.next() * (d.specs[k].max - d.specs[k].min);
    variants.push({ label: `random#${i}`, set });
  }
  const presetName = presets[0];
  for (const v of variants) {
    runs++;
    let ok = true;
    let info = '';
    try {
      const def = defineTrack({ id: 'fz', title: 'fz', genre: 'Test', bpm: 130, bars: 1, tail: 0.3, fadeOut: 0.01 }, (s: Song) => {
        s.key('A', 'minor');
        const f = (s as unknown as Record<string, (o?: unknown, m?: unknown) => { play(p: unknown, at: number, bars: number): unknown; inst: { setParam(n: string, v: number): void } }>)[d.factory];
        const ch = f.call(s, presetName);
        for (const [k, val] of Object.entries(v.set)) ch.inst.setParam(k, val);
        const pat = DRUMS.has(d.factory) ? s.hits('x...x.x.x...x.xx', { free: true }) : s.notes(NOTE_PAT[d.factory] ?? NOTE_PAT.default, { free: true });
        ch.play(pat, 0, 1);
        s.master.raw = true;
      });
      const [L, R] = renderAll(def.build(sr).toRenderer());
      let pk = 0;
      for (let i = 0; i < L.length; i++) {
        const a = Math.abs(L[i]);
        const b = Math.abs(R[i]);
        if (!(a === a) || !(b === b) || a === Infinity || b === Infinity) {
          ok = false;
          info = 'NaN/Inf';
          break;
        }
        pk = Math.max(pk, a, b);
      }
      if (ok && pk > 30) {
        ok = false;
        info = `peak ${pk.toFixed(1)}`;
      }
    } catch (e) {
      ok = false;
      info = (e as Error).message;
    }
    if (!ok) {
      bad++;
      console.log(`${d.factory}:${presetName} ${v.label}: ${info}`);
    }
  }
}
console.log(`${runs} renders, ${bad} problems`);
