/**
 * The album as one stream: tracks follow each other inside it with an equal-power crossfade, a skip cuts to another track, and the
 * stream is the same however it is cut into blocks. Tracks here are tones and constants (the real album is src/audio/album/).
 */
import { describe, expect, it } from 'vitest';
import type { TrackRenderer } from '../src/audio/album';
import { ALBUM, createTrackRenderer } from '../src/audio/album';
import { AlbumStreamer, type StreamerOptions } from '../src/audio/album-stream';
import type { Mark } from '../src/audio/album-protocol';

const SR = 8000;

/** A track of `seconds` that is a constant `value` (stereo: right is the left scaled by 0.5). */
function constant(value: number, seconds: number): TrackRenderer {
  const frames = Math.round(seconds * SR);
  let pos = 0;
  return {
    frames,
    render(l, r, n) {
      const m = Math.min(n, frames - pos);
      for (let i = 0; i < m; i++) {
        l[i] = value;
        r[i] = value * 0.5;
      }
      pos += m;
      return m;
    },
  };
}

/** A sine track. */
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
        r[i] = v;
      }
      pos += m;
      return m;
    },
  };
}

type Maker = (id: string) => TrackRenderer;

function streamer(make: Maker, extra: Partial<StreamerOptions> = {}): AlbumStreamer {
  return new AlbumStreamer({ sampleRate: SR, createRenderer: (id) => make(id), crossfadeSeconds: 2, skipFadeSeconds: 0.5, startFadeSeconds: 0, ...extra });
}

/** Produce `frames` frames in blocks of `block`; returns the stream and every mark. */
function run(s: AlbumStreamer, frames: number, block = 1000): { l: Float32Array; r: Float32Array; marks: Mark[] } {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  const marks: Mark[] = [];
  let at = 0;
  while (at < frames) {
    const n = Math.min(block, frames - at);
    const c = s.produce(n);
    l.set(c.l, at);
    r.set(c.r, at);
    marks.push(...c.marks);
    at += n;
  }
  return { l, r, marks };
}

describe('album streamer', () => {
  it('plays a track from its first sample and marks where it starts', () => {
    const s = streamer(() => constant(0.4, 10));
    expect(s.start('a', 1)).toBe(true);
    const { l, marks } = run(s, SR * 3);
    expect(l[0]).toBeCloseTo(0.4, 6);
    expect(l[SR * 3 - 1]).toBeCloseTo(0.4, 6);
    expect(marks).toEqual([{ pos: 0, id: 'a', n: 0, kind: 'start', epoch: 1 }]);
  });

  it('crosses into the next track with an equal-power fade, and marks the middle of it', () => {
    const lens: Record<string, [number, number]> = { a: [0.6, 10], b: [0.2, 10], c: [0.9, 10] };
    const s = streamer((id) => constant(...lens[id]));
    s.start('a', 1);
    s.setQueue(1, ['b', 'c']);
    const { l, marks } = run(s, SR * 22);
    // a plays alone to 8 s (10 s minus the 2 s crossfade)
    expect(l[7 * SR]).toBeCloseTo(0.6, 6);
    expect(l[8 * SR - 1]).toBeCloseTo(0.6, 3);
    // the crossfade: 0.6 cos(t) + 0.2 sin(t), t = x * pi / 2
    for (const x of [0, 0.25, 0.5, 0.75, 0.99]) {
      const i = 8 * SR + Math.round(x * 2 * SR);
      const t = (Math.round(x * 2 * SR) / (2 * SR)) * (Math.PI / 2);
      expect(l[i], `x=${x}`).toBeCloseTo(0.6 * Math.cos(t) + 0.2 * Math.sin(t), 5);
    }
    // b alone from 10 s, until its own crossfade into c at 16 s
    expect(l[12 * SR]).toBeCloseTo(0.2, 6);
    // c alone after its crossfade (16 s to 18 s)
    expect(l[19 * SR]).toBeCloseTo(0.9, 6);
    // marks: a at 0; b at the middle of the crossfade (9 s); c at the middle of the next (17 s)
    expect(marks.map((m) => [m.id, m.n, m.kind, m.pos])).toEqual([
      ['a', 0, 'start', 0],
      ['b', 1, 'next', 9 * SR],
      ['c', 2, 'next', 17 * SR],
    ]);
  });

  it('has no seam: the stream across a crossfade moves smoothly', () => {
    const make: Maker = (id) => (id === 'a' ? tone(110, 6) : tone(165, 6));
    const s = streamer(make);
    s.start('a', 1);
    s.setQueue(1, ['b']);
    const { l } = run(s, SR * 8);
    let worst = 0;
    for (let i = 1; i < l.length; i++) worst = Math.max(worst, Math.abs(l[i] - l[i - 1]));
    // (a 165 Hz tone at amplitude 0.5 moves at most 2 pi 165 / 8000 * 0.5 per sample; two tones in a crossfade a little more)
    expect(worst).toBeLessThan(0.1);
  });

  it('is the same stream however it is cut into blocks', () => {
    const make: Maker = (id) => (id === 'a' ? tone(110, 5) : id === 'b' ? tone(165, 5) : tone(220, 5));
    const ref = (() => {
      const s = streamer(make);
      s.start('a', 1);
      s.setQueue(1, ['b', 'c']);
      return run(s, SR * 11, 11 * SR);
    })();
    for (const block of [1, 7, 333, 4096]) {
      const s = streamer(make);
      s.start('a', 1);
      s.setQueue(1, ['b', 'c']);
      const got = run(s, SR * 11, block);
      let worst = 0;
      for (let i = 0; i < ref.l.length; i++) worst = Math.max(worst, Math.abs(got.l[i] - ref.l[i]), Math.abs(got.r[i] - ref.r[i]));
      expect(worst, `block ${block}`).toBeLessThan(1e-6);
      expect(got.marks.map((m) => m.pos)).toEqual(ref.marks.map((m) => m.pos));
    }
  });

  it('takes the next track from the queue by ordinal, so a late update cannot repeat one', () => {
    const made: string[] = [];
    const s = streamer((id) => {
      made.push(id);
      return constant(0.1, 4);
    });
    s.start('a', 1);
    s.setQueue(1, ['b', 'c', 'd']);
    run(s, SR * 3); // a is two seconds from its crossfade
    // the player moved on: the queue now starts at ordinal 2 (b was committed, it says), so the track after b is c
    s.setQueue(2, ['c', 'd', 'e']);
    run(s, SR * 4);
    // (b was started with the first queue; the next one begins by itself from the new one, at ordinal 2)
    expect(made.slice(0, 3)).toEqual(['a', 'b', 'c']);
    // a stale update that starts earlier than the track being rendered does not make it play twice
    s.setQueue(0, ['x', 'y']);
    run(s, SR * 4);
    expect(made.length).toBeGreaterThanOrEqual(4);
  });

  it('falls back on the album order when the queue has nothing, and when a track cannot be made', () => {
    const errors: string[] = [];
    const order = ['a', 'b', 'c'];
    const s = streamer(
      (id) => {
        if (id === 'b') throw new Error('broken track');
        return constant(order.indexOf(id) / 10 + 0.1, 3);
      },
      { fallback: (after) => order.slice(order.indexOf(after ?? '') + 1).concat(order.slice(0, order.indexOf(after ?? '') + 1)), onError: (id) => errors.push(id) },
    );
    s.start('a', 1);
    s.setQueue(1, ['b']); // b cannot be made: the one after it in the album is played
    const { marks } = run(s, SR * 7);
    expect(errors).toContain('b');
    expect(marks.map((m) => m.id).slice(0, 3)).toEqual(['a', 'c', 'a']);
  });

  it('crosses a track into itself when it is the only one', () => {
    const s = streamer(() => tone(100, 5));
    s.start('only', 1);
    s.setQueue(1, ['only', 'only']);
    const { l, marks } = run(s, SR * 12);
    expect(marks.filter((m) => m.kind === 'next').length).toBeGreaterThanOrEqual(2);
    let worst = 0;
    for (let i = 1; i < l.length; i++) worst = Math.max(worst, Math.abs(l[i] - l[i - 1]));
    expect(worst).toBeLessThan(0.1);
  });

  it('plays on when a track is shorter than the crossfade', () => {
    const lens: Record<string, number> = { a: 1, b: 1, c: 1 };
    const s = streamer((id) => constant(0.3, lens[id] ?? 1));
    s.start('a', 1);
    s.setQueue(1, ['b', 'c', 'a', 'b']);
    const { l, marks } = run(s, SR * 6);
    expect(marks.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < l.length; i += 97) expect(Number.isFinite(l[i])).toBe(true);
    expect(Math.max(...l)).toBeLessThan(0.43); // (equal power: at most 0.3 * sqrt(2))
  });

  it('goes on when a renderer ends before it said it would', () => {
    // (a track that claims six seconds and has two)
    const lying = (): TrackRenderer => {
      let pos = 0;
      return {
        frames: 6 * SR,
        render(l, r, n) {
          const m = Math.max(0, Math.min(n, 2 * SR - pos));
          for (let i = 0; i < m; i++) l[i] = r[i] = 0.5;
          pos += m;
          return m;
        },
      };
    };
    let first = true;
    const s = streamer(() => {
      if (first) {
        first = false;
        return lying();
      }
      return constant(0.5, 6);
    });
    s.start('a', 1);
    s.setQueue(1, ['b', 'c']);
    const { l, marks } = run(s, SR * 12);
    expect(marks.length).toBeGreaterThanOrEqual(2);
    expect(marks[1]).toMatchObject({ id: 'b', kind: 'next' });
    // b begins where a really ended, at 2 s
    expect(marks[1].pos).toBe(2 * SR);
    expect(l[3 * SR]).toBeCloseTo(0.5, 6);
  });
});

describe('album streamer: the next track made ahead of time', () => {
  function counted() {
    const made: string[] = [];
    const s = streamer((id) => {
      made.push(id);
      return constant(0.3, 10);
    });
    return { s, made };
  }

  it('warm makes the renderer of the track that follows, once, and the crossfade uses it without making it again', () => {
    const { s, made } = counted();
    s.start('a', 1);
    s.setQueue(1, ['b', 'c']);
    expect(made).toEqual(['a']);
    s.warm();
    s.warm(); // (nothing to do the second time)
    expect(made).toEqual(['a', 'b']);
    run(s, SR * 9); // into the crossfade (a ends at 10 s, the fade begins at 8 s)
    expect(made).toEqual(['a', 'b']);
    // once b is playing, the next ready one is c
    s.warm();
    expect(made).toEqual(['a', 'b', 'c']);
  });

  it('a skip to the track that is ready does not make it again; a skip to another makes that one and keeps the ready one', () => {
    const { s, made } = counted();
    s.start('a', 1);
    s.setQueue(1, ['b', 'c']);
    s.warm();
    run(s, SR);
    s.skip('b', 2, 1, SR);
    expect(made).toEqual(['a', 'b']);
    s.setQueue(2, ['c', 'd']);
    s.warm();
    expect(made).toEqual(['a', 'b', 'c']);
    s.skip('z', 3, 2, SR);
    expect(made).toEqual(['a', 'b', 'c', 'z']);
    // c is still ready for the crossfade out of z
    s.setQueue(3, ['c', 'd']);
    s.warm();
    expect(made).toEqual(['a', 'b', 'c', 'z']);
  });

  it('a queue that changes replaces the ready renderer; a new session and a stop let it go', () => {
    const { s, made } = counted();
    s.start('a', 1);
    s.setQueue(1, ['b']);
    s.warm();
    s.setQueue(1, ['x']);
    s.warm();
    expect(made).toEqual(['a', 'b', 'x']);
    s.start('a2', 5);
    s.setQueue(1, ['x']);
    s.warm();
    expect(made).toEqual(['a', 'b', 'x', 'a2', 'x']);
    s.stop();
    s.warm(); // (nothing is playing: nothing to prepare)
    expect(made).toHaveLength(5);
  });

  it('a track that cannot be made ahead of time is reported when it is wanted, with the fallback', () => {
    const errors: string[] = [];
    const order = ['a', 'b', 'c'];
    const s = streamer(
      (id) => {
        if (id === 'b') throw new Error('broken');
        return constant(0.3, 6);
      },
      { onError: (id) => errors.push(id), fallback: (after) => order.slice(order.indexOf(after ?? '') + 1) },
    );
    s.start('a', 1);
    s.setQueue(1, ['b']);
    s.warm(); // (fails quietly)
    expect(errors).toEqual([]);
    const { marks } = run(s, SR * 8);
    expect(errors).toEqual(['b']);
    expect(marks.map((m) => m.id).slice(0, 2)).toEqual(['a', 'c']);
  });
});

describe('album streamer: a broken track', () => {
  it('a renderer that throws mid-track is skipped, and the stream goes on with the next track', () => {
    const errors: string[] = [];
    let calls = 0;
    const broken = (): TrackRenderer => ({
      frames: 20 * SR,
      render(l, r, n) {
        // (writes some garbage, then fails on its third block)
        for (let i = 0; i < n; i++) l[i] = r[i] = 0.9;
        if (++calls === 3) throw new Error('engine bug');
        return n;
      },
    });
    const s = streamer((id) => (id === 'bad' ? broken() : constant(0.2, 8)), { onError: (id) => errors.push(id) });
    s.start('bad', 1);
    s.setQueue(1, ['good', 'good']);
    const { l, marks } = run(s, SR * 6, 500);
    expect(errors).toEqual(['bad']);
    // the garbage of the failed block is not in the stream, and the next track begins where the broken one stopped
    expect(Math.max(...Array.from(l.slice(2 * 500)).map((v) => Math.abs(v)))).toBeLessThan(0.25);
    expect(marks.map((m) => m.id)).toEqual(['bad', 'good']);
    expect(marks[1].pos).toBe(2 * 500);
    expect(l[SR * 5]).toBeCloseTo(0.2, 6);
  });

  it('a renderer that throws inside a crossfade drops that track without a stall', () => {
    const errors: string[] = [];
    const s = streamer(
      (id) =>
        id === 'bad'
          ? {
              frames: 10 * SR,
              render: () => {
                throw new Error('nope');
              },
            }
          : constant(0.3, 6),
      { onError: (id) => errors.push(id), fallback: (after) => (after === 'bad' ? ['good'] : ['good']) },
    );
    s.start('a', 1);
    s.setQueue(1, ['bad', 'good']);
    const { l, marks } = run(s, SR * 14);
    expect(errors).toContain('bad');
    expect(marks.some((m) => m.id === 'good')).toBe(true);
    for (let i = 0; i < l.length; i++) expect(Number.isFinite(l[i])).toBe(true);
    // (the outgoing track fades out under nothing, and the next one starts where it ends: the longest silence is the end of that fade)
    let quiet = 0;
    let longest = 0;
    for (let i = SR; i < 13 * SR; i++) {
      quiet = Math.abs(l[i]) < 0.02 ? quiet + 1 : 0;
      longest = Math.max(longest, quiet);
    }
    expect(longest).toBeLessThan(0.4 * SR);
    expect(l[10 * SR]).toBeCloseTo(0.3, 6);
  });
});

describe('album streamer: skips', () => {
  it('cuts to the new track at the position given, with a fade-in, and marks it', () => {
    const s = streamer((id) => constant(id === 'a' ? 0.3 : 0.8, 20));
    s.start('a', 1);
    run(s, SR * 5);
    expect(s.position).toBe(SR * 5);
    // the playhead is somewhere before 5 s: the new track starts at 3.5 s, over the old one's frames from there on
    expect(s.skip('z', 2, 7, Math.round(3.5 * SR))).toBe(true);
    expect(s.position).toBe(Math.round(3.5 * SR));
    const c = s.produce(SR * 2);
    expect(c.pos).toBe(Math.round(3.5 * SR));
    expect(c.marks).toEqual([{ pos: Math.round(3.5 * SR), id: 'z', n: 7, kind: 'start', epoch: 2 }]);
    // 0.5 s fade-in (sine), then the full level
    expect(c.l[0]).toBeCloseTo(0, 6);
    const mid = Math.round(0.25 * SR);
    expect(c.l[mid]).toBeCloseTo(0.8 * Math.sin((Math.PI / 2) * 0.5), 3);
    expect(c.l[Math.round(0.6 * SR)]).toBeCloseTo(0.8, 6);
    // the fade-in is smooth
    let worst = 0;
    for (let i = 1; i < c.l.length; i++) worst = Math.max(worst, Math.abs(c.l[i] - c.l[i - 1]));
    expect(worst).toBeLessThan(0.01);
  });

  it('never rewinds past where the stream is', () => {
    const s = streamer(() => constant(0.5, 20));
    s.start('a', 1);
    run(s, SR);
    s.skip('b', 2, 1, SR * 99); // (a position beyond the stream: it starts where the stream is)
    expect(s.position).toBe(SR);
  });

  it('drops the old line: its marks, the crossfade it was in, the tracks it was about to start', () => {
    const s = streamer(() => constant(0.5, 6));
    s.start('a', 1);
    s.setQueue(1, ['b', 'c', 'd']);
    // into the crossfade (a ends at 6 s, the fade begins at 4 s)
    run(s, SR * 5);
    s.skip('x', 2, 1, SR * 5);
    s.setQueue(2, ['y', 'z']);
    const { marks } = run(s, SR * 9);
    const next = marks.filter((m) => m.kind === 'next');
    expect(marks[0]).toMatchObject({ id: 'x', kind: 'start', epoch: 2 });
    // the track after x is the one the new queue names, and nothing of the old line (b) comes back
    expect(next[0]?.id).toBe('y');
    expect(marks.some((m) => m.id === 'b')).toBe(false);
  });

  it('can start a session again from position 0', () => {
    const s = streamer(() => constant(0.5, 6));
    s.start('a', 1);
    run(s, SR * 2);
    s.start('b', 5, 0);
    expect(s.position).toBe(0);
    const c = s.produce(100);
    expect(c.pos).toBe(0);
    expect(c.marks).toEqual([{ pos: 0, id: 'b', n: 0, kind: 'start', epoch: 5 }]);
  });
});

describe('album streamer with the real album', () => {
  // (until the first song lands in src/audio/album/tracks there is nothing to stream, and nothing to test)
  it.skipIf(ALBUM.length === 0)('streams the first track of the album: finite, audible, with a start mark', () => {
    const first = ALBUM[0];
    const sr = 44100;
    const s = new AlbumStreamer({ sampleRate: sr, createRenderer: createTrackRenderer });
    expect(s.start(first.id, 1)).toBe(true);
    let peak = 0;
    let energy = 0;
    const marks: Mark[] = [];
    for (let i = 0; i < 40; i++) {
      const c = s.produce(4096);
      marks.push(...c.marks);
      for (let k = 0; k < c.l.length; k++) {
        const v = Math.max(Math.abs(c.l[k]), Math.abs(c.r[k]));
        expect(Number.isFinite(v)).toBe(true);
        if (v > peak) peak = v;
        energy += c.l[k] * c.l[k];
      }
    }
    expect(marks[0]).toMatchObject({ pos: 0, id: first.id, kind: 'start', n: 0 });
    expect(peak).toBeGreaterThan(0.001);
    expect(peak).toBeLessThan(4);
    expect(energy).toBeGreaterThan(0);
  });
});
