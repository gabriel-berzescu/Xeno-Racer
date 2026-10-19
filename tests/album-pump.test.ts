/**
 * fx.pump: a tempo-locked duck on one channel, with the shape of the sidechain (mixer.ts), keyed by the beat grid instead of by the kick.
 * Tested at the level of the effect (against a Duck fed the same triggers, against the grid at two tempos, across cuts, seeks and sleeps)
 * and in real songs (against a muted kick keying the sidechain on the same steps).
 */
import { describe, expect, it } from 'vitest';
import { defineTrack, fx } from '../src/audio/album/song';
import type { Song } from '../src/audio/album/song';
import { Ctx, Transport } from '../src/audio/album/instrument';
import { Pump } from '../src/audio/album/fx';
import { Duck, MixIO } from '../src/audio/album/mixer';
import { FX_CATALOG } from '../src/audio/album/catalog';

const SR = 48000;

function renderBlocks(r: { frames: number; render(l: Float32Array, r: Float32Array, n: number): number }, frames: number, block: number): [Float32Array, Float32Array] {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  const bl = new Float32Array(block);
  const br = new Float32Array(block);
  let pos = 0;
  while (pos < frames) {
    const m = r.render(bl, br, Math.min(block, frames - pos));
    if (m === 0) break;
    L.set(bl.subarray(0, m), pos);
    R.set(br.subarray(0, m), pos);
    pos += m;
  }
  return [L, R];
}

/** Renders one mini track in raw mode (master bypassed). */
function raw(sr: number, bpm: number, bars: number, build: (s: Song) => void, opts: { startFrame?: number; tail?: number } = {}): { l: Float32Array; r: Float32Array } {
  const def = defineTrack({ id: 't-raw2', title: 'raw', genre: 'Test', bpm, bars, tail: opts.tail ?? 0.5, fadeOut: 0.01 }, (s) => {
    s.key('A', 'minor');
    build(s);
    s.master.raw = true;
  });
  const r = def.build(sr).toRenderer(opts.startFrame ? { startFrame: opts.startFrame } : {});
  const [l, rr] = renderBlocks(r, r.frames, 4096);
  return { l, r: rr };
}

// ── fx.pump ──────────────────────────────────────────────────────────────────────────────────────────────

function pumpCtx(bpm: number, sr = SR): Ctx {
  return { sr, bpm, barBeats: 4, transport: new Transport(), seed: 1 };
}

/** Runs a pump over frames [from, to) on a signal of ones, in blocks of the sizes `block(i)` gives; returns the gain it applied to each frame. */
function pumpGain(pump: Pump, ctx: Ctx, from: number, to: number, block: (i: number) => number = () => 64, stereo = false): Float64Array {
  const fpb = (ctx.sr * 60) / ctx.bpm;
  const out = new Float64Array(to - from);
  let pos = from;
  for (let i = 0; pos < to; i++) {
    const n = Math.min(block(i), to - pos);
    ctx.transport.beat = pos / fpb;
    ctx.transport.frame = pos;
    const l = new Float64Array(n).fill(1);
    if (stereo) {
      const r = new Float64Array(n).fill(1);
      pump.process(l, r, n);
    } else pump.processMono(l, n);
    out.set(l, pos - from);
    pos += n;
  }
  return out;
}

/** The frames where a pattern starts a duck: step k is at round(k * frames per step), like the events of the score. */
function stepFrames(pattern: string, bpm: number, bars: number, res = 4, sr = SR): number[] {
  const chars = [...pattern.replace(/[\s|]/g, '')];
  const spStep = (sr * 60) / bpm / res;
  const out: number[] = [];
  for (let k = 0; k < bars * 4 * res; k++) if (chars[k % chars.length] !== '.' && chars[k % chars.length] !== '-' && chars[k % chars.length] !== '0') out.push(Math.round(k * spStep));
  return out;
}

describe('fx.pump', () => {
  it('is listed with the effects and its options are checked', () => {
    expect(FX_CATALOG.map((f) => f.name)).toContain('pump');
    expect(() => fx.pump({ pattern: 'x...', resolution: 4 } as never)).toThrow(/fx.pump: unknown option "resolution"/);
    expect(() => fx.pump({ depht: 0.5 } as never)).toThrow(/fx.pump: unknown option "depht".*Did you mean "depth"/);
    const make = (o: object): Pump => new Pump(pumpCtx(120), o);
    expect(() => make({ pattern: '' })).toThrow(/empty pattern/);
    expect(() => make({ pattern: 'x..a' })).toThrow(/bad pattern character "a"/);
    expect(() => make({ depth: 2 })).toThrow(/Pump: parameter "depth" is 2, outside its range 0 \.\. 1/);
    expect(() => make({ res: 0 })).toThrow(/"res" \(steps per beat\) must be a positive number/);
    expect(() => make({ pattern: 'x.x.', release: 5 })).toThrow(/parameter "release" is 5/);
  });

  it('ducks exactly on the steps of the pattern, at two tempos (the frame of each step is the frame of a score event)', () => {
    for (const bpm of [120, 137]) {
      for (const [pattern, res] of [['x...x...x...x...', 4], ['x..x..x.x.x..x..|.x.x.x.x....x...', 4], ['x.x.|..x.', 2]] as const) {
        const ctx = pumpCtx(bpm);
        const pump = new Pump(ctx, { pattern, res, release: 0.06, hold: 0.005 });
        const bars = 4;
        const total = Math.round(((bars * 4 * 60) / bpm) * SR);
        const g = pumpGain(pump, ctx, 0, total);
        const steps = stepFrames(pattern, bpm, bars, res).filter((t) => t < total - 100);
        // a duck's first frame is the first frame of its step: the frame before it is untouched, the frame itself is already lower
        for (const t of steps) {
          if (t === 0) expect(g[0], `${bpm} bpm ${pattern} first step`).toBeLessThan(1);
          else {
            expect(g[t - 1], `${bpm} bpm ${pattern}: frame before ${t}`).toBeGreaterThan(g[t]);
            expect(g[t], `${bpm} bpm ${pattern}: frame ${t}`).toBeLessThan(1);
          }
        }
        // and nothing else ducks: every frame where the gain starts to fall is a step
        const falls: number[] = [];
        for (let i = 2; i < total - 100; i++) if (g[i] < g[i - 1] - 1e-12 && !(g[i - 1] < g[i - 2] - 1e-12)) falls.push(i);
        expect(falls, `${bpm} bpm ${pattern}`).toEqual(steps.filter((t) => t > 1));
        // the bottom of every duck is 1 - depth (0.8 by default: 0.2)
        let min = 1;
        for (let i = 0; i < total; i++) min = Math.min(min, g[i]);
        expect(min).toBeCloseTo(0.2, 6);
      }
    }
  });

  it('has the shape of the global sidechain: the same attack, hold, release and curve (a Duck keyed on the same frames gives the same gain)', () => {
    const bpm = 140;
    const fpb = (SR * 60) / bpm;
    for (const o of [
      { depth: 1 },
      { depth: 0.8, release: 0.25, curve: 1.4 },
      { depth: 0.5, attack: 0.02, hold: 0.1, release: 0.5, curve: 0.6 },
      { depth: 1, release: 1.5, curve: 3, hold: 0.3 },
      { depth: 0.9, attack: 0.0005, hold: 0, release: 0.02, curve: 4 },
    ]) {
      for (const pattern of ['x...x...x...x...', 'xxxxxxxxxxxxxxxx', 'x..x..x..x..x...']) {
        const ctx = pumpCtx(bpm);
        const pump = new Pump(ctx, { pattern, ...o });
        const total = SR * 4;
        const g = pumpGain(pump, ctx, 0, total);
        // the sidechain, fed by the engine's rule: segments of at most 64 frames, cut at every trigger
        const duck = new Duck(SR);
        for (const [k, v] of Object.entries(o)) duck.setParam(k, v);
        const io = new MixIO();
        const trig = new Set(stepFrames(pattern, bpm, 4));
        const want = new Float64Array(total);
        for (let pos = 0; pos < total; ) {
          if (trig.has(pos)) duck.trigger(1);
          let end = Math.min(total, pos + 64);
          for (let f = pos + 1; f < end; f++) if (trig.has(f)) end = f;
          duck.fill(io, end - pos);
          for (let i = 0; i < end - pos; i++) want[pos + i] = io.duckActive ? io.duck[i] : 1;
          pos = end;
        }
        let worst = 0;
        for (let i = 0; i < total; i++) worst = Math.max(worst, Math.abs(g[i] - want[i]));
        expect(worst, `${JSON.stringify(o)} ${pattern}`).toBeLessThan(1e-9);
      }
    }
    void fpb;
  });

  it('applies depth 0 as an exact pass-through, and lets depth be automated (also in the middle of a duck)', () => {
    const ctx = pumpCtx(120);
    const pump = new Pump(ctx, { depth: 0 });
    const x = new Float64Array(64);
    for (let i = 0; i < 64; i++) x[i] = Math.sin(i * 0.37) * 0.3 + 1e-9 * i;
    const y = Float64Array.from(x);
    for (let blk = 0; blk < 400; blk++) {
      ctx.transport.beat = (blk * 64) / ((SR * 60) / 120);
      pump.processMono(y, 64);
      for (let i = 0; i < 64; i++) expect(Object.is(y[i], x[i]), `block ${blk} sample ${i}`).toBe(true);
    }
    // depth 0 .. 1 stepped from block to block: the bottom of each duck follows it
    const c2 = pumpCtx(120);
    const p2 = new Pump(c2, { pattern: 'x...x...x...x...', release: 0.1 });
    const fpb = (SR * 60) / 120;
    const bottoms: number[] = [];
    let pos = 0;
    for (const d of [0, 0.25, 0.5, 0.75, 1]) {
      p2.setParam('depth', d);
      let min = 1;
      // one beat per depth: 24000 frames
      for (let end = pos + Math.round(fpb); pos < end; pos += 64) {
        c2.transport.beat = pos / fpb;
        const buf = new Float64Array(64).fill(1);
        p2.processMono(buf, 64);
        for (let i = 0; i < 64; i++) min = Math.min(min, buf[i]);
      }
      bottoms.push(min);
    }
    expect(bottoms[0]).toBe(1);
    for (let i = 1; i < bottoms.length; i++) expect(bottoms[i]).toBeLessThan(bottoms[i - 1]);
    expect(bottoms[4]).toBeCloseTo(0, 6);
    // a depth turned down to 0 in the middle of a duck lifts it at once; turned up again it ducks again from where the envelope is
    const c3 = pumpCtx(120);
    const p3 = new Pump(c3, { release: 0.5, depth: 1 });
    const a = pumpGain(p3, c3, 0, 3000);
    expect(a[2000]).toBeLessThan(0.5);
    p3.setParam('depth', 0);
    const b = pumpGain(p3, c3, 3000, 3200);
    expect(Math.min(...b)).toBe(1);
    p3.setParam('depth', 1);
    const c = pumpGain(p3, c3, 3200, 6000);
    expect(c[0]).toBeLessThan(0.5); // the envelope is still down there (the replay found it)
  });

  it('gives the stereo path the mono result on both sides', () => {
    const bpm = 128;
    const ctxA = pumpCtx(bpm);
    const ctxB = pumpCtx(bpm);
    const a = new Pump(ctxA, { pattern: 'x..x..x.x.x..x..', curve: 1.5, depth: 0.7 });
    const b = new Pump(ctxB, { pattern: 'x..x..x.x.x..x..', curve: 1.5, depth: 0.7 });
    const fpb = (SR * 60) / bpm;
    let seed = 7;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296 - 0.5;
    };
    for (let pos = 0; pos < SR * 2; pos += 64) {
      const x = new Float64Array(64);
      for (let i = 0; i < 64; i++) x[i] = rnd();
      const l = Float64Array.from(x);
      const r = Float64Array.from(x);
      const m = Float64Array.from(x);
      ctxA.transport.beat = pos / fpb;
      ctxB.transport.beat = pos / fpb;
      a.processMono(m, 64);
      b.process(l, r, 64);
      for (let i = 0; i < 64; i++) {
        expect(Object.is(l[i], m[i])).toBe(true);
        expect(Object.is(r[i], m[i])).toBe(true);
      }
    }
  });

  it('is not shifted by how the song is cut into segments, by a seek, or by a channel that slept', () => {
    for (const bpm of [120, 137]) {
      const pattern = 'x..x..x.x.x..x..|x...x.......x...';
      const opts = { pattern, release: 0.3, curve: 1.4, hold: 0.03 };
      const total = SR * 6;
      const ctx0 = pumpCtx(bpm);
      const ref = pumpGain(new Pump(ctx0, opts), ctx0, 0, total);
      // any cut into segments (down to single frames and to blocks longer than the engine's 64) gives the same bits
      for (const cut of [(i: number) => 1 + ((i * 37) % 64), () => 17, () => 64, () => 200, (i: number) => (i % 2 ? 1 : 63)]) {
        const ctx = pumpCtx(bpm);
        const g = pumpGain(new Pump(ctx, opts), ctx, 0, cut === undefined ? total : Math.min(total, SR * 2), cut);
        for (let i = 0; i < g.length; i++) if (g[i] !== ref[i]) throw new Error(`${bpm} bpm: frame ${i}: ${g[i]} against ${ref[i]}`);
      }
      // a pump that starts in the middle of the song (a renderer made with startFrame) gives the gain the whole run has there
      for (const from of [1234, 31337, 90001, 143999, 144000, 187654]) {
        const ctx = pumpCtx(bpm);
        const g = pumpGain(new Pump(ctx, opts), ctx, from, from + SR);
        let worst = 0;
        for (let i = 0; i < g.length; i++) worst = Math.max(worst, Math.abs(g[i] - ref[from + i]));
        expect(worst, `${bpm} bpm, seek to ${from}`).toBeLessThan(1e-12);
      }
      // a channel the engine skipped for a while (its process() is not called, the transport moves on)
      const ctx = pumpCtx(bpm);
      const pump = new Pump(ctx, opts);
      const part1 = pumpGain(pump, ctx, 0, 40000);
      const part2 = pumpGain(pump, ctx, 100000, 150000);
      for (let i = 0; i < part1.length; i++) expect(part1[i]).toBe(ref[i]);
      let worst = 0;
      for (let i = 0; i < part2.length; i++) worst = Math.max(worst, Math.abs(part2[i] - ref[100000 + i]));
      expect(worst).toBeLessThan(1e-12);
      // and going back in time (a loop) lands on the grid too
      const back = pumpGain(pump, ctx, 5000, 20000);
      worst = 0;
      for (let i = 0; i < back.length; i++) worst = Math.max(worst, Math.abs(back[i] - ref[5000 + i]));
      expect(worst).toBeLessThan(1e-12);
    }
  });

  it('survives a transport that never moves, an empty pattern of ducks and a very dense one', () => {
    const ctx = pumpCtx(120);
    const stuck = new Pump(ctx, { pattern: 'x...' });
    const buf = new Float64Array(64).fill(1);
    let lowest = 1;
    for (let i = 0; i < 3000; i++) {
      buf.fill(1);
      stuck.processMono(buf, 64); // beat stays 0
      lowest = Math.min(lowest, ...buf);
    }
    expect(lowest).toBeLessThan(0.3);
    const none = new Pump(pumpCtx(120), { pattern: '....' });
    const ones = new Float64Array(64).fill(1);
    none.processMono(ones, 64);
    expect(Math.min(...ones)).toBe(1);
    const c = pumpCtx(150);
    const dense = pumpGain(new Pump(c, { pattern: 'xxxxxxxxxxxxxxxx', res: 8, release: 1.5, hold: 0.3, curve: 4 }), c, 0, SR * 3);
    for (const v of dense) expect(v >= 0.2 - 1e-9 && v <= 1).toBe(true);
  });

  it('does in a real song what the sidechain does with a kick on the same steps: the same gain, frame for frame (also after a seek)', () => {
    for (const bpm of [120, 137]) {
      const sine = { layers: [{ wave: 'sine' as const }], mono: true, filter: 'off' as const, sustain: 1, attack: 0.001, release: 0.01 };
      const params = { attack: 0.006, hold: 0.03, release: 0.25, curve: 1.4 };
      const pattern = 'X..X..X.X.X..X..|X...X.......X...';
      const notes = 'A3:16 | A3:16 | A3:16 | A3:16';
      const viaKick = raw(SR, bpm, 4, (s) => {
        s.kick('techno-kick', { mute: true }).play(s.hits(pattern), 0, 4); // silent, but it keys the sidechain
        s.synth(sine, { duck: 1 }).play(s.notes(notes, { free: true }), 0, 4);
        s.setSidechain({ depth: 1, ...params });
      }).l;
      const viaPump = raw(SR, bpm, 4, (s) => {
        s.synth(sine, { fx: [fx.pump({ pattern, depth: 1, ...params })] }).play(s.notes(notes, { free: true }), 0, 4);
      }).l;
      const plain = raw(SR, bpm, 4, (s) => {
        s.synth(sine).play(s.notes(notes, { free: true }), 0, 4);
      }).l;
      let worst = 0;
      let lowest = 1;
      const songEnd = Math.round(4 * 4 * ((SR * 60) / bpm)); // the kick's pattern ends with the song, the pump goes on ducking the note's release tail
      for (let i = 0; i < songEnd; i++) {
        worst = Math.max(worst, Math.abs(viaKick[i] - viaPump[i]));
        if (Math.abs(plain[i]) > 0.05) lowest = Math.min(lowest, Math.abs(viaPump[i] / plain[i]));
      }
      expect(lowest, `${bpm} bpm: the pump does duck`).toBeLessThan(0.1);
      expect(worst, `${bpm} bpm: against the sidechain`).toBeLessThan(2e-6); // float32 output
      // a renderer that starts in the middle of the song ducks on the same frames as the one that ran through it
      const fpb = (SR * 60) / bpm;
      const start = Math.round(5.3 * fpb);
      const seeked = raw(
        SR,
        bpm,
        4,
        (s) => {
          s.synth(sine, { fx: [fx.pump({ pattern, depth: 1, ...params })] }).play(s.notes(notes, { free: true }), 0, 4);
        },
        { startFrame: start },
      ).l;
      // the notes that began before the seek are not played (the score is not replayed), so compare from the first bar line after it:
      // the ratio to the plain signal is the gain, and it must be the same in both
      const plainSeeked = raw(SR, bpm, 4, (s) => s.synth(sine).play(s.notes(notes, { free: true }), 0, 4), { startFrame: start }).l;
      const bar = Math.round(4 * fpb);
      const from = Math.ceil(start / bar) * bar - start + 50;
      let worstSeek = 0;
      let checked = 0;
      for (let i = from; i < seeked.length; i++) {
        if (Math.abs(plainSeeked[i]) > 0.05) {
          worstSeek = Math.max(worstSeek, Math.abs(seeked[i] / plainSeeked[i] - viaPump[start + i] / plain[start + i]));
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(SR);
      expect(worstSeek, `${bpm} bpm: after a seek`).toBeLessThan(2e-4);
    }
  });

  it('leaves a real channel bit-identical at depth 0 (mono and stereo), and a digit in the pattern is a duck of that part of the depth', () => {
    for (const stereo of [false, true]) {
      const make = (fxs: ReturnType<typeof fx.pump>[]): { l: Float32Array; r: Float32Array } =>
        raw(SR, 130, 2, (s) => {
          s.synth({ layers: [{ wave: 'saw', unison: stereo ? 5 : 1 }], mono: !stereo, cutoff: 3000, sustain: 1 }, { fx: fxs, reverb: 0.2, delay: 0.1 }).play(s.notes('A3 . C4 E4 . G4 A4 - | A3:8', { res: 2 }), 0, 2);
        });
      const none = make([]);
      const off = make([fx.pump({ depth: 0, pattern: 'x.x.x...x..x....' })]);
      expect(Buffer.compare(Buffer.from(none.l.buffer), Buffer.from(off.l.buffer))).toBe(0);
      expect(Buffer.compare(Buffer.from(none.r.buffer), Buffer.from(off.r.buffer))).toBe(0);
      const on = make([fx.pump({ depth: 0.5, pattern: 'x.x.x...x..x....' })]);
      expect(Buffer.compare(Buffer.from(none.l.buffer), Buffer.from(on.l.buffer))).not.toBe(0);
    }
    const ctx = pumpCtx(120);
    const g = pumpGain(new Pump(ctx, { pattern: '5...9...|1...', depth: 0.9, hold: 0.05 }), ctx, 0, SR * 6);
    const lowest = (a: number, b: number): number => Math.min(...g.subarray(a, b));
    const beat = SR / 2;
    expect(lowest(0, beat)).toBeCloseTo(1 - 0.9 * (5 / 9), 3);
    expect(lowest(beat, 2 * beat)).toBeCloseTo(1 - 0.9 * (9 / 9), 3);
    expect(lowest(2 * beat, 3 * beat)).toBeCloseTo(1 - 0.9 * (1 / 9), 3);
    expect(lowest(3 * beat, 4 * beat)).toBeCloseTo(1 - 0.9 * (5 / 9), 3); // the pattern is 12 steps long: it comes round to the 5 again
  });

  it('works as an insert of a real channel: it pumps the chords on its own pattern while the sidechain follows the kick, mono and stereo', () => {
    const run = (stereo: boolean, pump: boolean): { l: Float32Array; r: Float32Array } =>
      raw(SR, 120, 2, (s) => {
        s.synth({ layers: [{ wave: 'saw', unison: stereo ? 3 : 1 }], mono: !stereo, filter: 'off', sustain: 1, attack: 0.001 }, { fx: pump ? [fx.pump({ pattern: 'x...x...x...x...', release: 0.3 })] : [] }).play(
          s.notes('A3:16 | A3:16', { free: true }),
          0,
          2,
        );
      });
    for (const stereo of [false, true]) {
      const dry = run(stereo, false);
      const wet = run(stereo, true);
      const beat = SR / 2;
      const rms = (x: Float32Array, a: number, b: number): number => {
        let e = 0;
        for (let i = a; i < b; i++) e += x[i] * x[i];
        return Math.sqrt(e / (b - a));
      };
      // 10 ms into a beat the chord is far down, 0.4 s into it it is back
      expect(rms(wet.l, beat * 2 + 480, beat * 2 + 720) / rms(dry.l, beat * 2 + 480, beat * 2 + 720)).toBeLessThan(0.45);
      expect(rms(wet.l, beat * 2 + 19200, beat * 2 + 19440) / rms(dry.l, beat * 2 + 19200, beat * 2 + 19440)).toBeGreaterThan(0.98);
      if (stereo) expect(rms(wet.r, beat * 2 + 480, beat * 2 + 720) / rms(dry.r, beat * 2 + 480, beat * 2 + 720)).toBeLessThan(0.45);
    }
  });
});
