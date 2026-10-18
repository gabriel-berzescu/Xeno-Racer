/**
 * Quality sweep over every preset of every instrument (master bypassed): renders a standard phrase and reports anything odd.
 *   node sandbox/album/run.mjs sandbox/album/lab/qa.ts [factory-filter] [--all]
 * Checks per preset: finite output, peak level, DC offset, a silent tail (no stuck notes or runaway tails), clicks at note ends
 * (the largest sample-to-sample step right after a note-off against the steps while it sounded), velocity response (louder when
 * played harder), and stereo balance. Prints only the anomalies unless --all is given, then a summary line.
 */
import { defineTrack } from '../../../src/audio/album/song';
import type { Song } from '../../../src/audio/album/song';
import { CATALOG } from '../../../src/audio/album/catalog';
import { renderAll } from './tools';

const filter = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
const showAll = process.argv.includes('--all');
const sr = 48000;
const BPM = 120;
const beat = 60 / BPM;

const HIT_FACTORIES = new Set(['kick', 'snare', 'clap', 'hat', 'perc']);
const rmsOf = (x: Float32Array, a: number, b: number): number => {
  let s = 0;
  const n = Math.max(1, Math.min(b, x.length) - a);
  for (let i = a; i < Math.min(b, x.length); i++) s += x[i] * x[i];
  return Math.sqrt(s / n);
};
const maxStep = (x: Float32Array, a: number, b: number): number => {
  let m = 0;
  for (let i = Math.max(1, a); i < Math.min(b, x.length); i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
};
const dbf = (x: number): number => 20 * Math.log10(Math.max(x, 1e-12));

interface Phrase {
  build: (s: Song, vel: number, ch: ReturnType<Song['add']>) => void;
  /** times (s) of note-offs, for the click scan */
  offs: number[];
  bars: number;
}

function phraseFor(factory: string, preset: string): Phrase {
  if (HIT_FACTORIES.has(factory)) {
    return { build: (s, vel, ch) => ch.play(s.hits('x...x...x...x...'), 0, 2, { vel }), offs: [], bars: 2 };
  }
  if (factory === 'cymbal') {
    const rev = /reverse/.test(preset);
    return {
      build: (s, vel, ch) => (rev ? ch.play(s.notes('A3:16', { free: true }), 0, 2, { vel }) : ch.play(s.hits('x...............|................'), 0, 2, { vel })),
      offs: [],
      bars: 2,
    };
  }
  if (factory === 'riser' || factory === 'impact' || factory === 'zap') {
    return { build: (s, vel, ch) => ch.hit(0, '', vel, 0, factory === 'riser' ? 4 : 1), offs: [], bars: 2 };
  }
  if (factory === 'tom') {
    return { build: (s, vel, ch) => ch.play(s.notes('A2 . . . A2 . . . A2 . . . . . . .'), 0, 2, { vel }), offs: [], bars: 2 };
  }
  if (factory === 'acousticKit') {
    return {
      build: (s, vel, ch) => ch.play(s.drums({ kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.xo', crash: 'x...............' }), 0, 2, { vel }),
      offs: [],
      bars: 2,
    };
  }
  if (factory === 'guitar') {
    const off1 = 8 * beat / 2 * 0.9875 / 0.9875;
    void off1;
    return {
      build: (s, vel, ch) => ch.play(s.notes('[A2,E3,A3]:8 . . . . . . . . | [C3,G3,C4]:8 . . . . . . . .'), 0, 2, { vel }),
      offs: [1.975 * beat, 1.975 * beat + 4 * beat * 1],
      bars: 2,
    };
  }
  // sustained notes: two notes of 2 beats (gate 0.9: they end 0.025 beats early... ends at (steps - 0.1)/4 beats)
  const end = (8 - 0.1) / 4;
  return {
    build: (s, vel, ch) => ch.play(s.notes('A2:8 . . . . . . . . | C3:8 . . . . . . . .'), 0, 2, { vel }),
    offs: [end * beat, 4 * beat + end * beat],
    bars: 2,
  };
}

function render(factory: string, preset: string | undefined, vel: number): { l: Float32Array; r: Float32Array; ph: Phrase } {
  const ph = phraseFor(factory, preset ?? '');
  const def = defineTrack({ id: 'qa', title: 'qa', genre: 'Test', bpm: BPM, bars: ph.bars, tail: 2.5, fadeOut: 0.01 }, (s: Song) => {
    s.key('A', 'minor');
    const f = (s as unknown as Record<string, (o?: unknown, m?: unknown) => ReturnType<Song['add']>>)[factory];
    const ch = factory === 'drumKit' ? f.call(s, { kick: 'techno-kick', snare: 'tight-snare', hat: 'closed-hat', crash: 'crash' }, { gain: 0 }) : f.call(s, preset, { gain: 0 });
    if (factory === 'drumKit') ch.play(s.drums({ kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.xo', crash: 'x...............' }), 0, 2, { vel });
    else ph.build(s, vel, ch);
    s.master.raw = true;
  });
  const [l, r] = renderAll(def.build(sr).toRenderer());
  return { l, r, ph };
}

let issues = 0;
let count = 0;
const entries: { factory: string; preset: string | undefined }[] = [];
for (const d of CATALOG) {
  if (filter && !d.factory.includes(filter)) continue;
  const names = Object.keys(d.presets);
  if (names.length === 0) entries.push({ factory: d.factory, preset: undefined });
  else for (const p of names) entries.push({ factory: d.factory, preset: p });
}

for (const e of entries) {
  count++;
  const notes: string[] = [];
  const { l, r, ph } = render(e.factory, e.preset, 0.9);
  let pk = 0;
  let sum = 0;
  let bad = false;
  for (let i = 0; i < l.length; i++) {
    const a = Math.abs(l[i]);
    const b = Math.abs(r[i]);
    if (!(a < 1e9) || !(b < 1e9)) bad = true;
    pk = Math.max(pk, a, b);
    sum += l[i] + r[i];
  }
  if (bad) notes.push('NaN/Inf');
  const peakDb = dbf(pk);
  const bodyRms = rmsOf(l, 0, Math.round(ph.bars * 4 * beat * sr));
  const dc = Math.abs(sum / (2 * l.length));
  if (pk > 4) notes.push(`peak ${peakDb.toFixed(1)} dBFS (very hot for a raw channel)`);
  if (dc > 0.05 * Math.max(bodyRms, 1e-6) && dc > 1e-3) notes.push(`DC ${dc.toExponential(1)} (${(dc / bodyRms).toFixed(2)} of rms)`);
  // tail: the last 0.2 s, 2 s after the phrase
  const tailRms = Math.max(rmsOf(l, l.length - Math.round(0.25 * sr), l.length), rmsOf(r, r.length - Math.round(0.25 * sr), r.length));
  if (tailRms > 3e-4 && e.factory !== 'riser') notes.push(`tail still ${dbf(tailRms).toFixed(0)} dBFS 2.2 s after the phrase`);
  // clicks right after note-offs
  for (const off of ph.offs) {
    const o = Math.round(off * sr);
    const during = Math.max(maxStep(l, o - Math.round(0.06 * sr), o), maxStep(r, o - Math.round(0.06 * sr), o));
    const after = Math.max(maxStep(l, o, o + Math.round(0.006 * sr)), maxStep(r, o, o + Math.round(0.006 * sr)));
    if (after > 2.2 * during && after > 0.01) notes.push(`click at note end ${off.toFixed(2)} s: step ${after.toFixed(3)} vs ${during.toFixed(3)} while sounding`);
  }
  // velocity response
  const lo = render(e.factory, e.preset, 0.3);
  const hi = render(e.factory, e.preset, 1.0);
  const win = Math.round(Math.min(1.0, ph.bars * 2 * beat) * sr);
  const rLo = rmsOf(lo.l, 0, win);
  const rHi = rmsOf(hi.l, 0, win);
  if (e.factory !== 'riser' && !(rHi > rLo * 0.999)) notes.push(`harder playing is not louder (vel 0.3 rms ${dbf(rLo).toFixed(1)}, vel 1 ${dbf(rHi).toFixed(1)} dBFS)`);
  // stereo balance
  const rl = rmsOf(l, 0, l.length);
  const rr = rmsOf(r, 0, r.length);
  const bal = dbf(rl) - dbf(rr);
  if (rl > 1e-5 && Math.abs(bal) > 2 && !/-(L|R)$/.test(e.preset ?? '')) notes.push(`stereo balance ${bal.toFixed(1)} dB (L - R)`);
  if (notes.length) issues += notes.length;
  if (notes.length || showAll) console.log(`${(e.factory + ':' + (e.preset ?? '-')).padEnd(34)} peak ${peakDb.toFixed(1).padStart(6)} dBFS  vel0.3->1 ${(dbf(rHi) - dbf(rLo)).toFixed(1).padStart(5)} dB  ${notes.length ? '<<< ' + notes.join('; ') : 'ok'}`);
}
console.log(`${count} presets checked, ${issues} issues`);
