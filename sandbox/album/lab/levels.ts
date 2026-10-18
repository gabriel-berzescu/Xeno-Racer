/**
 * Level calibration: renders every instrument preset alone (master bypassed, channel gain 0 dB) playing a standard pattern and
 * reports its integrated loudness and peak, so that all presets start at comparable levels and a composer's first mix is sane.
 *   node sandbox/album/run.mjs sandbox/album/lab/levels.ts [filter] [--json file]
 * Targets: sustained / rhythmic parts -20 LUFS, drums -22 LUFS for a hit per beat, effects -24 LUFS.
 */
import { defineTrack } from '../../../src/audio/album/song';
import type { Song } from '../../../src/audio/album/song';
import { DRUM_PRESETS } from '../../../src/audio/album/instruments/drums';
import { SYNTH_PRESETS } from '../../../src/audio/album/instruments/synth';
import { ACID_PRESETS, DARK_PRESETS, GROWL_PRESETS, REESE_PRESETS, SUB_PRESETS } from '../../../src/audio/album/instruments/bass';
import { RISER_PRESETS, IMPACT_PRESETS, ZAP_PRESETS } from '../../../src/audio/album/instruments/sfx';
import { AKIT_PRESETS } from '../../../src/audio/album/instruments/acoustic-kit';
import { BASSG_PRESETS, GUITAR_PRESETS } from '../../../src/audio/album/instruments/guitar';
import { measure } from '../../../src/audio/album/measure';
import { renderAll } from './tools';
import { writeFileSync } from 'node:fs';

const filter = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
const jsonArg = process.argv.indexOf('--json');
const sr = 48000;
const BPM = 120;

interface Case {
  key: string;
  target: number;
  make: (s: Song) => { play: (p: never, at: number, bars: number) => unknown; inst: unknown } & Record<string, unknown>;
  pattern: (s: Song) => unknown;
  bars: number;
}

const DRUM_TARGET: Record<string, number> = { kick: -14, snare: -16, clap: -18, hat: -26, tom: -18, cymbal: -18, perc: -20 };
const cases: Case[] = [];
const hits = (txt: string) => (s: Song) => s.hits(txt, { free: true });
for (const [name, p] of Object.entries(DRUM_PRESETS)) {
  const f = p.type;
  const pat = f === 'hat' ? 'x.x.x.x.x.x.x.x.' : f === 'cymbal' ? 'X.......' + '........' : f === 'perc' ? 'x...x...x...x...' : 'x...x...x...x...';
  const bars = 4;
  cases.push({
    key: `${f}:${name}`,
    target: DRUM_TARGET[f] ?? -20,
    make: (s) => (s as never as Record<string, (o: string) => never>)[f](name) as never,
    pattern: p.opts.reverse ? (s) => s.notes('A3:16 - - - - - - - - - - - - - - -', { free: true }) : hits(pat),
    bars,
  });
}
const noteCase = (kind: string, factory: string, name: string, notes: string, target = -20, bars = 4): void => {
  cases.push({ key: `${kind}:${name}`, target, make: (s) => (s as never as Record<string, (o: string) => never>)[factory](name) as never, pattern: (s) => s.notes(notes, { free: true }), bars });
};
const CHORD = '[A2,E3,A3,C4] - - - - - - - - - - - - - - - | . . . . . . . . . . . . . . . . ';
const ARP = 'A3 C4 E4 A4 E4 C4 A3 E3 A3 C4 E4 A4 E4 C4 A3 E3';
for (const name of Object.keys(SYNTH_PRESETS)) {
  if (/pluck|arp/.test(name)) noteCase('synth', 'synth', name, ARP, -22);
  else if (/lead/.test(name)) noteCase('synth', 'synth', name, 'A4 - - - C5 - - - E5 - - - D5 - - -');
  else if (/bell|epiano/.test(name)) noteCase('synth', 'synth', name, 'A4 - - - - - - - . . . . . . . .', -22);
  else noteCase('synth', 'synth', name, CHORD);
}
const BASS = 'A1 - - . A1 - - . C2 - - . D2 - - .';
for (const name of Object.keys(DARK_PRESETS)) noteCase('dark', 'darkBass', name, BASS, name === 'dark-pluck' ? -20 : -16);
// the rolling bass is judged on the line it is made for: three sixteenths after every kick
for (const name of Object.keys(REESE_PRESETS)) noteCase('reese', 'reese', name, name === 'rolling-bass' ? '. A1 A1 A1 . A1 A1 A1 . C2 C2 C2 . D2 D2 D2' : BASS, -16);
for (const name of Object.keys(GROWL_PRESETS)) noteCase('growl', 'growl', name, BASS.replace(/A1/g, 'A2').replace('C2', 'C3').replace('D2', 'D3'), -16);
for (const name of Object.keys(ACID_PRESETS)) noteCase('acid', 'acid', name, 'A1 . A1 A2! . A1 . A1 C2~ . A1 A1 E2! . G1 A1~', -18);
for (const name of Object.keys(SUB_PRESETS)) noteCase('sub', 'sub', name, 'A1 - - - E2 - - - A1 - - - . . . .', -16);
for (const name of Object.keys(RISER_PRESETS)) cases.push({ key: `riser:${name}`, target: -24, make: (s) => s.riser(name) as never, pattern: (s) => s.hits('x...............', { free: true }), bars: 1 });
for (const name of Object.keys(IMPACT_PRESETS)) cases.push({ key: `impact:${name}`, target: -18, make: (s) => s.impact(name) as never, pattern: (s) => s.hits('x...............', { free: true }), bars: 2 });
for (const name of Object.keys(ZAP_PRESETS)) cases.push({ key: `zap:${name}`, target: -22, make: (s) => s.zap(name) as never, pattern: (s) => s.hits('x...............', { free: true }), bars: 1 });
for (const name of Object.keys(AKIT_PRESETS)) {
  cases.push({
    key: `acoustic-kit:${name}`,
    target: -16,
    make: (s) => s.acousticKit(name) as never,
    pattern: (s) => s.drums({ kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' }, { free: true }),
    bars: 4,
  });
}
for (const name of Object.keys(GUITAR_PRESETS)) {
  noteCase('guitar', 'guitar', name, '[A2,E3,A3]{pm} [A2,E3,A3]{pm} [A2,E3,A3]{pm} [A2,E3,A3]{pm} [C3,G3,C4]! . [D3,A3,D4] . [A2,E3,A3]{pm} [A2,E3,A3]{pm} [E2,B2,E3]{pm} [E2,B2,E3]{pm} [G2,D3,G3]! . [A2,E3,A3] -', -18);
}
for (const name of Object.keys(BASSG_PRESETS)) noteCase('bassguitar', 'bassGuitar', name, 'A1 A1 A1 A1 A1 A1 A1 A1 C2 C2 C2 C2 D2 D2 E2 E2', -18);

const results: Record<string, number> = {};
console.log('instrument:preset'.padEnd(36) + 'LUFS    peak    target  trim');
for (const c of cases) {
  if (filter && !c.key.includes(filter)) continue;
  const def = defineTrack({ id: 'lv', title: 'LV', genre: 'Test', bpm: BPM, bars: c.bars, tail: 1 }, (s: Song) => {
    s.key('A', 'minor');
    const ch = c.make(s) as unknown as { play(p: unknown, at: number, bars: number): unknown };
    ch.play(c.pattern(s), 0, c.bars);
    s.master.raw = true;
  });
  const r = def.build(sr).toRenderer();
  const [L, R] = renderAll(r);
  const st = measure(L, R, sr);
  const trim = c.target - st.lufs;
  results[c.key] = Math.round(trim * 10) / 10;
  console.log(`${c.key.padEnd(36)}${st.lufs.toFixed(1).padStart(5)}  ${st.samplePeakDb.toFixed(1).padStart(6)}  ${String(c.target).padStart(6)}  ${trim >= 0 ? '+' : ''}${trim.toFixed(1)}`);
}
if (jsonArg >= 0) writeFileSync(process.argv[jsonArg + 1], JSON.stringify(results, null, 1));
