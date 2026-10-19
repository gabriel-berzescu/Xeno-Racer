/**
 * Fuzz for the composer API: random note / drum / chord text and random pattern transforms and placements. Every call must either
 * return normally or throw an Error with a message (never hang, never throw something else), and everything that is placed must render.
 * A hang shows as a missing "done" line: run it under a timeout.
 *   timeout 300 node sandbox/album/run.mjs sandbox/album/lab/fuzz-pattern.ts [seed]
 */
import { defineTrack } from '../../../src/audio/album/song';
import type { Pattern, Song } from '../../../src/audio/album/song';
import { Rng } from '../../../src/audio/album/dsp/core';
import { renderAll } from './tools';

const seed = Number(process.argv[2] ?? 1);
const rng = new Rng(seed);
const pick = <T>(a: readonly T[]): T => a[Math.floor(rng.next() * a.length)];
const NOTE_TOKENS = ['A2', 'C#3', 'Bb1', 'E4', '.', '-', '.', '-', '[A2,E3]', '[C3,G3,C4]', 'A2!', 'A2?', "A2'", 'A2~', 'A2:3', 'A2:0.5', 'A2@90', 'A2@0.5', 'A2{pm}', 'A2{ring,up}', 'A2!~:2@100{pm}', '|', 'X9', '[A2', 'A2{', '::', '@', '5', '#7', 'b3'];
const DRUM_CHARS = ['x', 'X', 'g', 'o', 'O', 'r', 'R', 'f', 'm', '.', '-', '_', '0', '1', '5', '9', '|', ' ', 'z', '?'];
const CHORD_TOKENS = ['Am', 'F', 'C', 'G7', 'Bdim', 'E5', 'Dsus4', 'Cmaj7', 'F#m7b5', 'C/E', '%', '.', '-', '|', 'H', 'Am9', 'Gadd9', 'X'];

let calls = 0;
let errors = 0;
const bad: string[] = [];
function attempt(label: string, fn: () => unknown): unknown {
  calls++;
  try {
    return fn();
  } catch (e) {
    errors++;
    if (!(e instanceof Error) || !e.message) bad.push(`${label}: threw ${String(e)}`);
    return undefined;
  }
}
const text = (tokens: readonly string[], n: number, sep: string): string => Array.from({ length: n }, () => pick(tokens)).join(sep);

const def = defineTrack({ id: 'fz-pattern', title: 'fz', genre: 'Test', bpm: 150, bars: 16, tail: 0.5, fadeOut: 0.01 }, (s: Song) => {
  s.key('A', 'minor');
  const kit = s.drumKit({ kick: 'techno-kick', snare: 'tight-snare', hat: 'closed-hat' });
  const syn = s.synth('pluck');
  const bass = s.darkBass('darksynth-bass');
  const pats: Pattern[] = [];
  for (let i = 0; i < 1200; i++) {
    const kind = Math.floor(rng.next() * 4);
    const free = rng.next() < 0.5;
    if (kind === 0) {
      const p = attempt('notes', () => s.notes(text(NOTE_TOKENS, 1 + Math.floor(rng.next() * 20), ' '), { res: pick([1, 2, 3, 4, 6, 8]), free })) as Pattern | undefined;
      if (p) pats.push(p);
    } else if (kind === 1) {
      const p = attempt('degrees', () => s.degrees(text(['1', '2', '3', '5+', '7-', 'b3', '#7', '.', '-', '|', '8', '9', 'x'], 1 + Math.floor(rng.next() * 12), ' '), { oct: pick([2, 3, 4]), free })) as Pattern | undefined;
      if (p) pats.push(p);
    } else if (kind === 2) {
      const lane = text(DRUM_CHARS, 1 + Math.floor(rng.next() * 24), '');
      const p = attempt('drums', () => s.drums({ kick: lane, snare: free ? text(DRUM_CHARS, lane.length, '') : lane }, { free })) as Pattern | undefined;
      if (p) pats.push(p);
    } else {
      const p = attempt('chords', () => s.chords(text(CHORD_TOKENS, 1 + Math.floor(rng.next() * 8), ' '), { octave: pick([1, 2, 3]), lead: rng.next() < 0.5, strum: pick([0, 0.05]) })) as Pattern | undefined;
      if (p) pats.push(p);
    }
  }
  // random transforms
  const xs: ((p: Pattern) => Pattern)[] = [
    (p) => p.transpose(pick([-24, -1, 0, 7, 100])),
    (p) => p.octave(pick([-3, 0, 2])),
    (p) => p.vel(pick([0, 0.5, 2, -1])),
    (p) => p.velTo(pick([0, 0.5, 1, 3])),
    (p) => p.rotate(pick([-5, -0.3, 0, 0.5, 7, 1e6])),
    (p) => p.rev(),
    (p) => p.repeat(pick([0, 1, 3])),
    (p) => p.over(pick([0, 0.5, 1, 4, 16, -2])),
    (p) => p.slice(pick([0, 1, 2, 5]), pick([0, 1, 3, 8])),
    (p) => p.gate(pick([0, 0.5, 2, -1])),
    (p) => p.legato(pick([0, 0.1, 5])),
    (p) => p.art(pick(['pm', 'ring', 'up', 'nonsense'])),
    (p) => p.only('kick', 'snare'),
    (p) => p.without('hat'),
    (p) => p.rename({ kick: 'snare' }),
    (p) => p.scaleTime(pick([0, 0.5, 2, -1])),
    (p) => p.strum(pick([0, 0.05, 0.5, -0.1]), rng.next() < 0.5),
    (p) => p.rhythm(pick(['x', 'x.x.', '....', 'x..x..x.', 'z']), { res: pick([1, 2, 4, 0]) }),
    (p) => s.arp(p, { order: pick(['up', 'down', 'updown', 'downup', 'converge', 'diverge', 'random', 'asplayed', [0, 2, 1], []]), octaves: pick([0, 1, 3]), res: pick([1, 4, 8]), gate: pick([0, 0.5, 2]), mask: pick(['x.x.', '....', undefined]) }),
    (p) => p.roots({ rhythm: pick(['x.xx', undefined, '....']), low: pick([20, 28, 60]), res: pick([1, 4]) }),
    (p) => p.and(pick(pats)),
    (p) => p.then(pick(pats)),
  ];
  let placed = 0;
  for (let i = 0; i < 3000; i++) {
    let p = pick(pats);
    const n = 1 + Math.floor(rng.next() * 3);
    for (let k = 0; k < n; k++) {
      const x = pick(xs);
      const q = attempt('transform', () => x(p)) as Pattern | undefined;
      if (q) p = q;
    }
    const target = pick([kit, syn, bass]);
    const bar = pick([0, 3, 7.5, 15, 16, -1, 20]);
    const bars = pick([undefined, 1, 2, 4, 0, -1, 0.25]);
    const ok = attempt('play', () => target.play(p, bar, bars, { vel: pick([1, 0.5, 0]), transpose: pick([0, 5]), offset: pick([0, -0.25, 1]), gate: pick([1, 0.5]), from: pick([0, 0, 1, 99]), humanize: pick([undefined, { time: 5, vel: 0.1 }]), swing: pick([undefined, 0.6, 0.9]) }));
    if (ok !== undefined) placed++;
  }
  process.stdout.write(`composed: ${pats.length} patterns, ${placed} clips placed, ${calls} calls, ${errors} errors (all with messages)\n`);
});

const song = def.build(44100);
const r = song.toRenderer();
const [l, rr] = renderAll(r);
let pk = 0;
let nan = false;
for (let i = 0; i < l.length; i++) {
  if (!(l[i] === l[i]) || !(rr[i] === rr[i])) nan = true;
  pk = Math.max(pk, Math.abs(l[i]), Math.abs(rr[i]));
}
process.stdout.write(`rendered ${(l.length / 44100).toFixed(1)} s with ${song.eventCount} events: ${nan ? 'NaN FOUND' : 'finite'}, peak ${pk.toFixed(3)}\n`);
if (bad.length) process.stdout.write(`PROBLEMS:\n${bad.slice(0, 20).join('\n')}\n`);
process.stdout.write(`done (seed ${seed})${bad.length || nan ? ' with problems' : ''}\n`);
