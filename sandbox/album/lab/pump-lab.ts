/**
 * Measures fx.pump: how far its gain is from the global sidechain's (the same attack, hold, release and curve, keyed on the same frames),
 * where its ducks land against the frames of the score's events, what it costs, and what a seek costs.
 *   node sandbox/album/run.mjs sandbox/album/lab/pump-lab.ts
 */
import { Pump } from '../../../src/audio/album/fx';
import { Transport } from '../../../src/audio/album/instrument';
import type { Ctx } from '../../../src/audio/album/instrument';
import { Duck, MixIO } from '../../../src/audio/album/mixer';

const SR = 48000;
const ctxOf = (bpm: number): Ctx => ({ sr: SR, bpm, barBeats: 4, transport: new Transport(), seed: 1 });

function run(pump: Pump, ctx: Ctx, from: number, to: number, stereo = false): Float64Array {
  const fpb = (ctx.sr * 60) / ctx.bpm;
  const out = new Float64Array(to - from);
  for (let pos = from; pos < to; pos += 64) {
    const n = Math.min(64, to - pos);
    ctx.transport.beat = pos / fpb;
    const l = new Float64Array(n).fill(1);
    if (stereo) pump.process(l, new Float64Array(n).fill(1), n);
    else pump.processMono(l, n);
    out.set(l, pos - from);
  }
  return out;
}

function triggers(pattern: string, bpm: number, bars: number): Set<number> {
  const chars = [...pattern.replace(/[\s|]/g, '')];
  const sp = (SR * 60) / bpm / 4;
  const s = new Set<number>();
  for (let k = 0; k < bars * 16; k++) if (chars[k % chars.length] === 'x') s.add(Math.round(k * sp));
  return s;
}

const settings: Record<string, number>[] = [
  { depth: 1 },
  { depth: 0.8 },
  { depth: 0.8, release: 0.25, curve: 1.4 },
  { depth: 0.5, attack: 0.02, hold: 0.1, release: 0.5, curve: 0.6 },
  { depth: 1, release: 1.5, curve: 3, hold: 0.3 },
];
process.stdout.write('gain against the global sidechain (a Duck keyed on the same frames), 4 s at 140 BPM, largest difference:\n');
for (const o of settings) {
  for (const pattern of ['x...x...x...x...', 'xxxxxxxxxxxxxxxx']) {
    const ctx = ctxOf(140);
    const g = run(new Pump(ctx, { pattern, ...o }), ctx, 0, SR * 4);
    const duck = new Duck(SR);
    for (const [k, v] of Object.entries(o)) duck.setParam(k, v);
    const io = new MixIO();
    const trig = triggers(pattern, 140, 4);
    let worst = 0;
    let lowest = 1;
    for (let pos = 0; pos < SR * 4; ) {
      if (trig.has(pos)) duck.trigger(1);
      let end = Math.min(SR * 4, pos + 64);
      for (let f = pos + 1; f < end; f++) if (trig.has(f)) end = f;
      duck.fill(io, end - pos);
      for (let i = 0; i < end - pos; i++) {
        const want = io.duckActive ? io.duck[i] : 1;
        worst = Math.max(worst, Math.abs(g[pos + i] - want));
        lowest = Math.min(lowest, want);
      }
      pos = end;
    }
    process.stdout.write(`  ${JSON.stringify(o).padEnd(70)} ${pattern}  worst ${worst.toExponential(2)}  (the duck goes down to ${lowest.toFixed(3)})\n`);
  }
}

// where the ducks land: the frame where the gain first falls, against the frame of the score event of the same step
process.stdout.write('\nlanding of the ducks against the frames of the score\'s events (step k at round(k / 4 * frames per beat)):\n');
for (const bpm of [120, 128, 137, 140, 145.5]) {
  const ctx = ctxOf(bpm);
  const g = run(new Pump(ctx, { pattern: 'x...x...x...x...', release: 0.1, hold: 0.005 }), ctx, 0, SR * 8);
  const fpb = (SR * 60) / bpm;
  let worst = 0;
  let n = 0;
  for (let k = 1; k < 8 * (bpm / 60) - 2; k++) {
    const want = Math.round(k * fpb);
    let first = -1;
    for (let i = want - 50; i < want + 50; i++) {
      if (g[i] < g[i - 1] - 1e-12) {
        first = i;
        break;
      }
    }
    worst = Math.max(worst, Math.abs(first - want));
    n++;
  }
  process.stdout.write(`  ${String(bpm).padStart(6)} BPM: ${n} beats, largest offset ${worst} frames\n`);
}

// cost: milliseconds of CPU per second of audio, a mono and a stereo channel, with the curve at 1 (a running product) and bent (pow + exp per sample)
function bench(label: string, o: Record<string, unknown>, stereo: boolean): void {
  const ctx = ctxOf(140);
  const pump = new Pump(ctx, o);
  const fpb = (SR * 60) / 140;
  const l = new Float64Array(64);
  const r = new Float64Array(64);
  const secs = 20;
  const blocks = (secs * SR) / 64;
  let best = Infinity;
  for (let rep = 0; rep < 5; rep++) {
    const t0 = performance.now();
    for (let b = 0; b < blocks; b++) {
      ctx.transport.beat = (b * 64) / fpb;
      l.fill(0.3);
      r.fill(0.3);
      if (stereo) pump.process(l, r, 64);
      else pump.processMono(l, 64);
    }
    best = Math.min(best, (performance.now() - t0) / secs);
  }
  process.stdout.write(`  ${label.padEnd(58)} ${best.toFixed(2).padStart(6)} ms per second of audio\n`);
}
process.stdout.write('\ncost (best of 5):\n');
bench('mono, quarters, release 0.2, curve 1', { pattern: 'x...x...x...x...' }, false);
bench('stereo, quarters, release 0.2, curve 1', { pattern: 'x...x...x...x...' }, true);
bench('stereo, quarters, release 0.3, curve 1.4', { pattern: 'x...x...x...x...', release: 0.3, curve: 1.4 }, true);
bench('stereo, eighths, release 0.25, curve 1.4 (always ducking)', { pattern: 'x.x.x.x.x.x.x.x.', release: 0.25, curve: 1.4 }, true);
bench('stereo, depth 0 (does nothing)', { depth: 0 }, true);
{
  const l = new Float64Array(64).fill(0.3);
  for (let i = 0; i < 64; i++) l[i] = 0.3;
  let best = Infinity;
  for (const o of [{}, { release: 1.5, hold: 0.3, attack: 0.05 }]) {
    const ctx = ctxOf(140);
    const pump = new Pump(ctx, o);
    best = Infinity;
    for (let rep = 0; rep < 20; rep++) {
      const t0 = performance.now();
      ctx.transport.beat = 500 + rep * 13.7; // far into the song, never where the last call stopped: a seek every time
      pump.processMono(l, 64);
      best = Math.min(best, performance.now() - t0);
    }
    process.stdout.write(`  one seek (a block that is not where the last one stopped), ${JSON.stringify(o).padEnd(42)} ${best.toFixed(3)} ms\n`);
  }
}
