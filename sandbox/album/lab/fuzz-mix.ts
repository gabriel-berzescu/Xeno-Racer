/**
 * Parameter fuzz for the effects and the mixer: every insert effect, the channel strip, the master, the shared reverb and delay and
 * the sidechain, each parameter at its minimum, its maximum and a random value (and everything random at once), on a noisy
 * source with a kick keying the sidechain. Every result must be finite and bounded.
 *   node sandbox/album/run.mjs sandbox/album/lab/fuzz-mix.ts [filter]
 */
import { defineTrack, fx } from '../../../src/audio/album/song';
import type { FxSpec, Song } from '../../../src/audio/album/song';
import { FX_CATALOG, MIXER_CATALOG } from '../../../src/audio/album/catalog';
import { Rng } from '../../../src/audio/album/dsp/core';
import { renderAll } from './tools';

const filter = process.argv[2] ?? '';
const sr = 44100;
const rng = new Rng(4242);
let runs = 0;
let bad = 0;

type Setter = (s: Song, ch: ReturnType<Song['synth']>, set: Record<string, number>) => void;

function check(label: string, setup: Setter, set: Record<string, number>, extraFx: boolean): void {
  runs++;
  let info = '';
  try {
    const def = defineTrack({ id: 'fm', title: 'fm', genre: 'Test', bpm: 130, bars: 2, tail: 0.5, fadeOut: 0.01 }, (s: Song) => {
      s.key('A', 'minor');
      s.kick('techno-kick', { gain: -6 }).play(s.hits('X...x...X...x.x.|X...x...X...x.xx'), 0, 2);
      const mix = extraFx ? { reverb: 0.5, delay: 0.5, duck: 0.8 } : { reverb: 0.5, delay: 0.5, duck: 0.8 };
      const ch = s.synth({ layers: [{ wave: 'saw', unison: 3 }, { wave: 'noise', level: 0.3 }], filter: 'off', sustain: 1 }, { ...mix, fx: [fx.chorus()] });
      ch.play(s.notes('[A2,E3,A3,C4]:16 | [F2,C3,F3,A3]:16'), 0, 2);
      setup(s, ch, set);
    });
    const [L, R] = renderAll(def.build(sr).toRenderer());
    let pk = 0;
    for (let i = 0; i < L.length; i++) {
      const a = Math.abs(L[i]);
      const b = Math.abs(R[i]);
      if (!(a < 1e9) || !(b < 1e9)) {
        info = 'NaN/Inf';
        break;
      }
      pk = Math.max(pk, a, b);
    }
    if (!info && pk > 4) info = `peak ${pk.toFixed(1)}`;
  } catch (e) {
    info = (e as Error).message;
  }
  if (info) {
    bad++;
    console.log(`${label}: ${info}`);
  }
}

// insert effects: each parameter at min / max / random, set by automation from bar 0
for (const f of FX_CATALOG) {
  if (filter && !f.name.includes(filter)) continue;
  const names = Object.keys(f.specs);
  const variants: { label: string; set: Record<string, number> }[] = [{ label: 'defaults', set: {} }];
  for (const k of names) variants.push({ label: `${k}=min`, set: { [k]: f.specs[k].min } }, { label: `${k}=max`, set: { [k]: f.specs[k].max } });
  for (let i = 0; i < 4; i++) variants.push({ label: `random#${i}`, set: Object.fromEntries(names.map((k) => [k, f.specs[k].min + rng.next() * (f.specs[k].max - f.specs[k].min)])) });
  for (const v of variants) {
    check(
      `fx.${f.name} ${v.label}`,
      (s, _ch, set) => {
        const opts = f.name === 'gate' ? { pattern: 'x.xx.x.x' } : {};
        const e = s.synth({ layers: [{ wave: 'saw', unison: 3 }, { wave: 'noise', level: 0.3 }], filter: 'off', sustain: 1 }, { name: 'victim', reverb: 0.3, fx: [(fx as unknown as Record<string, (o?: unknown) => FxSpec>)[f.name](opts)] });
        e.play(s.notes('[A2,E3,A3,C4]:16 | [F2,C3,F3,A3]:16'), 0, 2);
        for (const [k, val] of Object.entries(set)) e.auto(`fx.${f.name}.${k}`, [[0, val]]);
      },
      v.set,
      true,
    );
  }
}

// mixer sections
for (const m of MIXER_CATALOG) {
  if (filter && !m.id.includes(filter)) continue;
  const names = Object.keys(m.specs);
  const variants: { label: string; set: Record<string, number> }[] = [];
  for (const k of names) variants.push({ label: `${k}=min`, set: { [k]: m.specs[k].min } }, { label: `${k}=max`, set: { [k]: m.specs[k].max } });
  for (let i = 0; i < 4; i++) variants.push({ label: `random#${i}`, set: Object.fromEntries(names.map((k) => [k, m.specs[k].min + rng.next() * (m.specs[k].max - m.specs[k].min)])) });
  for (const v of variants) {
    check(
      `${m.id} ${v.label}`,
      (s, ch, set) => {
        for (const [k, val] of Object.entries(set)) {
          if (m.id === 'strip') ch.auto(`mix.${k}`, [[0, val]]);
          else s.auto(`${m.id === 'duck' ? 'duck' : m.id}.${k}`, [[0, val]]);
        }
      },
      v.set,
      false,
    );
  }
}
console.log(`${runs} renders, ${bad} problems`);
