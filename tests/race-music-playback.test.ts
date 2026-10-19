/**
 * What the worklet does with the stream: holds until told to play, plays it, fires the marks, stops cleanly when the buffer runs
 * dry, and fades out and lands on the new track when asked to skip. The worker's side is the real streamer, wired straight to the
 * playback the way the MessageChannel wires them.
 */
import { describe, expect, it } from 'vitest';
import type { TrackRenderer } from '../src/audio/album';
import { AlbumPlayback, DECAY_FRAMES, FADE_IN_FRAMES } from '../src/audio/album-playback';
import type { Mark } from '../src/audio/album-protocol';
import { AlbumStreamer } from '../src/audio/album-stream';

const SR = 16000;
const Q = 128;

function tone(freq: number, seconds: number, amp = 0.5): TrackRenderer {
  const frames = Math.round(seconds * SR);
  let pos = 0;
  return {
    frames,
    render(l, r, n) {
      const m = Math.min(n, frames - pos);
      for (let i = 0; i < m; i++) {
        const v = amp * Math.sin((2 * Math.PI * freq * (pos + i)) / SR);
        l[i] = v;
        r[i] = -v;
      }
      pos += m;
      return m;
    },
  };
}

const FREQ: Record<string, number> = { a: 100, b: 150, c: 200, d: 250 };

/** The worker and the worklet, joined: `feed` does what the worker's pump does, `play` runs the worklet's render quanta. */
class Rig {
  readonly streamer = new AlbumStreamer({
    sampleRate: SR,
    createRenderer: (id) => tone(FREQ[id] ?? 100, 30),
    crossfadeSeconds: 2,
    skipFadeSeconds: 0.4,
    startFadeSeconds: 0,
  });
  readonly marks: { mark: Mark; atFrame: number }[] = [];
  readonly pb = new AlbumPlayback({
    sampleRate: SR,
    capacity: 20 * SR,
    prebuffer: SR * 0.3,
    onTrack: (mark) => this.marks.push({ mark, atFrame: this.frames }),
  });
  readonly out: number[] = [];
  readonly outR: number[] = [];
  frames = 0;
  session = 1;

  constructor() {
    this.pb.receive({ type: 'reset', session: this.session });
  }

  /** The worker: render until `lead` seconds are in hand (and at least up to `force`). */
  feed(lead = 8, force = 0): void {
    const need = (): boolean => this.streamer.position - this.pb.played < lead * SR || this.streamer.position < force;
    while (need()) {
      const c = this.streamer.produce(4096);
      this.pb.receive({ type: 'pcm', session: this.session, pos: c.pos, l: c.l, r: c.r, marks: c.marks });
    }
  }

  /** The worklet: render `quanta` blocks of 128 frames into `out`. */
  play(quanta: number, keepFeeding = true): void {
    const l = new Float32Array(Q);
    const r = new Float32Array(Q);
    for (let k = 0; k < quanta; k++) {
      if (keepFeeding && k % 16 === 0) this.feed();
      this.pb.process(l, r, Q);
      for (let i = 0; i < Q; i++) {
        this.out.push(l[i]);
        this.outR.push(r[i]);
      }
      this.frames += Q;
    }
  }

  worstStep(from = 1, to = this.out.length): number {
    let w = 0;
    for (let i = Math.max(1, from); i < to; i++) w = Math.max(w, Math.abs(this.out[i] - this.out[i - 1]));
    return w;
  }
}

const sec = (s: number): number => Math.ceil((s * SR) / Q);

describe('album playback', () => {
  it('buffers without a sound until it is told to play, then waits for the prebuffer', () => {
    const rig = new Rig();
    rig.streamer.start('a', 1);
    rig.feed();
    rig.play(sec(0.5), false);
    expect(rig.out.every((v) => v === 0)).toBe(true);
    expect(rig.pb.played).toBe(0);
    expect(rig.pb.stats().playing).toBe(false);
    rig.pb.playRequested = true;
    rig.play(sec(0.5));
    expect(rig.pb.played).toBeGreaterThan(0.4 * SR);
    expect(Math.max(...rig.out.map(Math.abs))).toBeGreaterThan(0.4);
  });

  it('does not play on a buffer below the prebuffer', () => {
    const rig = new Rig();
    rig.streamer.start('a', 1);
    rig.pb.playRequested = true;
    const c = rig.streamer.produce(Math.round(0.1 * SR)); // 0.1 s: less than the 0.3 s asked
    rig.pb.receive({ type: 'pcm', session: 1, pos: 0, l: c.l, r: c.r, marks: c.marks });
    rig.play(sec(0.2), false);
    expect(rig.out.every((v) => v === 0)).toBe(true);
    rig.feed(1);
    rig.play(sec(0.2), false);
    expect(Math.max(...rig.out.map(Math.abs))).toBeGreaterThan(0.1);
  });

  it('plays the stream exactly as it was sent (after a few frames of fade-in), left and right', () => {
    const rig = new Rig();
    rig.streamer.start('a', 1);
    rig.pb.playRequested = true;
    rig.play(sec(2));
    const ref = tone(100, 30);
    const l = new Float32Array(rig.out.length);
    const r = new Float32Array(rig.out.length);
    ref.render(l, r, rig.out.length);
    for (let i = FADE_IN_FRAMES; i < rig.out.length; i++) {
      expect(rig.out[i]).toBeCloseTo(l[i], 5);
      expect(rig.outR[i]).toBeCloseTo(r[i], 5);
    }
    expect(rig.pb.underruns).toBe(0);
  });

  it('reports a track once the playhead has passed its mark, not before', () => {
    const rig = new Rig();
    rig.streamer.start('a', 1);
    rig.streamer.setQueue(1, ['b', 'c']);
    rig.pb.playRequested = true;
    rig.play(sec(30));
    expect(rig.marks.map((m) => [m.mark.id, m.mark.kind, m.mark.pos])).toEqual([
      ['a', 'start', 0],
      ['b', 'next', 29 * SR],
    ]);
    for (const m of rig.marks) {
      expect(m.atFrame).toBeGreaterThanOrEqual(m.mark.pos);
      expect(m.atFrame - m.mark.pos).toBeLessThan(2 * Q + 1);
    }
  });

  it('stops cleanly when the buffer runs dry: the last sample decays, no step, and it counts the underrun', () => {
    const rig = new Rig();
    rig.streamer.start('a', 1);
    rig.pb.playRequested = true;
    rig.feed(1.2);
    const dry = rig.streamer.position; // (a little over 1.2 s: the worker sends whole blocks)
    rig.play(sec(3), false); // (it is not fed again: that much, then nothing)
    expect(rig.pb.underruns).toBe(1);
    // after the data ended it decays to exactly zero within a few dozen frames
    expect(rig.out[dry + DECAY_FRAMES + 2]).toBe(0);
    expect(rig.out.slice(dry + DECAY_FRAMES + 2).every((v) => v === 0)).toBe(true);
    expect(rig.worstStep()).toBeLessThan(0.1);
  });

  it('comes back after an underrun when the stream does, with a fade-in', () => {
    const rig = new Rig();
    rig.streamer.start('a', 1);
    rig.pb.playRequested = true;
    rig.feed(1);
    rig.play(sec(2), false);
    const silent = rig.out.length;
    rig.feed(2);
    rig.play(sec(1), false);
    expect(Math.max(...rig.out.slice(silent).map(Math.abs))).toBeGreaterThan(0.3);
    expect(rig.worstStep()).toBeLessThan(0.1);
    expect(rig.pb.underruns).toBe(1);
  });

  it('drops chunks of an older session and starts over on a reset', () => {
    const rig = new Rig();
    rig.streamer.start('a', 1);
    rig.pb.playRequested = true;
    rig.play(sec(1));
    const stale = rig.streamer.produce(1000);
    rig.pb.receive({ type: 'reset', session: 2 });
    rig.pb.receive({ type: 'pcm', session: 1, pos: 0, l: stale.l, r: stale.r, marks: stale.marks });
    expect(rig.pb.ring.fill).toBe(0);
    expect(rig.pb.played).toBe(0);
    rig.session = 2;
    rig.streamer.start('b', 2);
    rig.play(sec(1));
    expect(rig.marks.map((m) => m.mark.id)).toEqual(['a', 'b']);
  });

  it('counts a chunk that does not fit instead of overwriting what has not been played', () => {
    const pb = new AlbumPlayback({ sampleRate: SR, capacity: 1000, prebuffer: 100 });
    pb.receive({ type: 'reset', session: 1 });
    pb.receive({ type: 'pcm', session: 1, pos: 0, l: new Float32Array(800), r: new Float32Array(800), marks: [] });
    pb.receive({ type: 'pcm', session: 1, pos: 800, l: new Float32Array(800), r: new Float32Array(800), marks: [] });
    expect(pb.overruns).toBe(1);
    expect(pb.ring.fill).toBe(800);
  });
});

describe('album playback: skipping', () => {
  /** What the player does on a press: the cut to the worklet, the skip to the worker (which chooses the position as the real worker does). */
  function press(rig: Rig, id: string, epoch: number, n: number): void {
    const frames = Math.round(0.4 * SR);
    rig.pb.cut(epoch, frames);
    const at = rig.pb.played + frames + Math.round(0.3 * SR);
    rig.streamer.skip(id, epoch, n, at);
    rig.feed(8, rig.streamer.position + Math.round(0.8 * SR));
  }

  it('fades the old track out, lands on the new track and fades it in: no step anywhere', () => {
    const rig = new Rig();
    rig.streamer.start('a', 1);
    rig.streamer.setQueue(1, ['b', 'c']);
    rig.pb.playRequested = true;
    rig.play(sec(3));
    const pressedAt = rig.out.length;
    press(rig, 'c', 2, 1);
    rig.play(sec(3));
    // the fade-out: the level of the old tone falls from full to nothing over 0.4 s
    const fade = Math.round(0.4 * SR);
    const env = (from: number, to: number): number => Math.max(...rig.out.slice(from, to).map(Math.abs));
    expect(env(pressedAt, pressedAt + 200)).toBeGreaterThan(0.4);
    expect(env(pressedAt + fade - 100, pressedAt + fade + 50)).toBeLessThan(0.05);
    // then the new track, 200 Hz, fading in over 0.4 s
    const after = rig.out.slice(pressedAt + fade + Math.round(0.5 * SR), pressedAt + fade + Math.round(0.6 * SR));
    let crossings = 0;
    for (let i = 1; i < after.length; i++) if (after[i - 1] < 0 && after[i] >= 0) crossings++;
    expect(crossings).toBeGreaterThanOrEqual(1); // 200 Hz over 0.1 s: two cycles (a 100 Hz tone gives one)
    expect(rig.worstStep(pressedAt - 2)).toBeLessThan(0.1);
    // the new track is reported once, with the epoch of the press
    const starts = rig.marks.filter((m) => m.mark.kind === 'start').map((m) => [m.mark.id, m.mark.epoch]);
    expect(starts).toEqual([
      ['a', 1],
      ['c', 2],
    ]);
    // and the track the old line was going to bring in is never reported
    expect(rig.marks.some((m) => m.mark.id === 'b')).toBe(false);
  });

  it('keeps the same fade when the button is pressed again, and lands on the newest track', () => {
    const rig = new Rig();
    rig.streamer.start('a', 1);
    rig.streamer.setQueue(1, ['b', 'c', 'd']);
    rig.pb.playRequested = true;
    rig.play(sec(3));
    const t0 = rig.out.length;
    press(rig, 'b', 2, 1);
    rig.play(sec(0.1));
    press(rig, 'd', 3, 2); // pressed again 0.1 s later, in the middle of the fade
    rig.play(sec(2.5));
    const starts = rig.marks.filter((m) => m.mark.kind === 'start').map((m) => m.mark.id);
    expect(starts).toEqual(['a', 'd']); // b was never landed on
    expect(rig.worstStep(t0 - 2)).toBeLessThan(0.1);
    // the fade-out was not restarted by the second press: it is silent 0.4 s after the first
    const quiet = rig.out.slice(t0 + Math.round(0.4 * SR) - 50, t0 + Math.round(0.4 * SR) + 20);
    expect(Math.max(...quiet.map(Math.abs))).toBeLessThan(0.05);
  });

  it('waits in silence for a new track that has not arrived, and lands when it does', () => {
    const rig = new Rig();
    rig.streamer.start('a', 1);
    rig.pb.playRequested = true;
    rig.play(sec(2));
    const t0 = rig.out.length;
    rig.pb.cut(2, Math.round(0.4 * SR));
    rig.play(sec(1), false); // (the worker has not answered yet)
    expect(Math.max(...rig.out.slice(t0 + Math.round(0.45 * SR)).map(Math.abs))).toBe(0);
    const t1 = rig.out.length;
    rig.streamer.skip('b', 2, 1, rig.pb.played + 1000);
    rig.feed(8, rig.streamer.position + SR);
    rig.play(sec(1));
    expect(Math.max(...rig.out.slice(t1).map(Math.abs))).toBeGreaterThan(0.2);
    expect(rig.marks.filter((m) => m.mark.kind === 'start').map((m) => m.mark.id)).toEqual(['a', 'b']);
  });

  it('skips cleanly when there is less than a fade of old music left', () => {
    const rig = new Rig();
    rig.streamer.start('a', 1);
    rig.pb.playRequested = true;
    rig.feed(0.5);
    rig.play(sec(0.3), false);
    rig.pb.cut(2, Math.round(0.4 * SR)); // 0.2 s of buffer, a 0.4 s fade
    rig.streamer.skip('b', 2, 1, rig.pb.played + 100);
    rig.feed(8, rig.streamer.position + SR);
    rig.play(sec(2));
    expect(rig.marks.filter((m) => m.mark.kind === 'start').map((m) => m.mark.id)).toEqual(['a', 'b']);
    expect(rig.worstStep()).toBeLessThan(0.12);
  });

  it('a skip asked for before anything plays lands on the new track at once', () => {
    const rig = new Rig();
    rig.streamer.start('a', 1);
    rig.feed();
    rig.pb.cut(2, Math.round(0.4 * SR));
    rig.streamer.skip('b', 2, 1, 0);
    rig.feed(8, SR);
    rig.pb.playRequested = true;
    rig.play(sec(1));
    expect(rig.marks.filter((m) => m.mark.kind === 'start').map((m) => m.mark.id)).toEqual(['b']);
  });
});
