/**
 * The album as one continuous stream (pure: it needs only `createRenderer`, so it runs in the worker, in node and in the tests).
 *
 * A session starts at stream position 0 with one track. The streamer renders it a block at a time (`produce`); a little before the
 * track ends, the next one begins and the two are mixed with an equal-power crossfade, so the stream has no seams and the worklet
 * that plays it knows nothing about tracks. The tracks that follow come from a queue the player keeps up to date (`setQueue`): the
 * streamer takes them by ordinal, so a late or repeated update can never make it play the same track twice or skip one. When the
 * queue has nothing for it (or a track cannot be made) it falls back on the album's own order, so the music never stops.
 *
 * A skip (`skip`) drops whatever is being rendered and starts the new track at once, with a short fade-in, at a stream position the
 * caller chooses (a little ahead of the playhead: the worklet is fading the old track out until then).
 *
 * Marks tell the player when the audible track changes: at position 0 for the first track, at the first sample of a track a skip
 * started, and at the MIDDLE of the crossfade into a track that came by itself (the point where it is the louder of the two).
 */
import type { TrackRenderer } from './album';
import type { Mark } from './album-protocol';

export interface Chunk {
  /** Stream position of the first frame. */
  pos: number;
  l: Float32Array;
  r: Float32Array;
  marks: Mark[];
}

export interface StreamerOptions {
  sampleRate: number;
  createRenderer(id: string, sampleRate: number): TrackRenderer;
  /** Tracks to try, in order, when the queue is empty or a track cannot be made (the album's order after `afterId` is a good answer). */
  fallback?(afterId: string | null): readonly string[];
  /** Called when a track could not be made. */
  onError?(id: string, error: unknown): void;
  crossfadeSeconds?: number;
  /** The fade-in of a track a skip started. */
  skipFadeSeconds?: number;
  /** The fade-in of the first track of a session (a declick: the gain stage of the player does the real fade). */
  startFadeSeconds?: number;
}

export const CROSSFADE_SECONDS = 2.5;
export const SKIP_FADE_SECONDS = 0.35;
export const START_FADE_SECONDS = 0.02;

interface Playing {
  id: string;
  n: number;
  r: TrackRenderer;
  frames: number;
  /** Frames rendered so far. */
  done: number;
  /** Frames of fade-in at its head. */
  fade: number;
}

const HALF_PI = Math.PI / 2;

export class AlbumStreamer {
  private readonly sr: number;
  private readonly xf: number;
  private readonly skipFade: number;
  private readonly startFade: number;
  private pos = 0;
  private cur: Playing | null = null;
  private inc: Playing | null = null;
  private xfLen = 0;
  private xfDone = 0;
  /** A crossfade could not begin (the next track would not make): the current track plays to its end instead. */
  private noCross = false;
  /** Ordinal of the next track to begin by itself. */
  private started = 0;
  private epoch = 0;
  private queueBase = 0;
  private queueIds: readonly string[] = [];
  private pending: Mark[] = [];
  /** The renderer of the track that comes next, made ahead of time (nothing has been rendered from it): see warm(). */
  private spare: { id: string; r: TrackRenderer } | null = null;
  private retryAt = 0;
  private sa: [Float32Array, Float32Array] = [new Float32Array(0), new Float32Array(0)];
  private sb: [Float32Array, Float32Array] = [new Float32Array(0), new Float32Array(0)];

  constructor(private readonly o: StreamerOptions) {
    this.sr = o.sampleRate;
    this.xf = Math.round((o.crossfadeSeconds ?? CROSSFADE_SECONDS) * this.sr);
    this.skipFade = Math.round((o.skipFadeSeconds ?? SKIP_FADE_SECONDS) * this.sr);
    this.startFade = Math.round((o.startFadeSeconds ?? START_FADE_SECONDS) * this.sr);
  }

  /** The stream position of the next block. */
  get position(): number {
    return this.pos;
  }

  /** The id of the track being rendered (the one that is audible, or about to be, once the stream catches up). */
  get currentId(): string | null {
    return this.inc?.id ?? this.cur?.id ?? null;
  }

  get active(): boolean {
    return this.cur !== null;
  }

  /** Begin a session: stream position 0 is the first sample of track `id` (ordinal `n`). False when no track could be made. */
  start(id: string, epoch: number, n = 0): boolean {
    this.pos = 0;
    this.epoch = epoch;
    this.inc = null;
    this.pending = [];
    this.spare = null;
    this.noCross = false;
    this.retryAt = 0;
    return this.begin(id, n, this.startFade);
  }

  /** Cut to track `id` (ordinal `n`) now, at stream position `at` (default: where the stream is). */
  skip(id: string, epoch: number, n: number, at?: number): boolean {
    if (at !== undefined && at >= 0 && at < this.pos) this.pos = at;
    this.epoch = epoch;
    this.inc = null;
    this.noCross = false;
    this.pending = [];
    return this.begin(id, n, this.skipFade);
  }

  /** The tracks after the committed one: ids[0] has ordinal `base`. */
  setQueue(base: number, ids: readonly string[]): void {
    this.queueBase = base;
    this.queueIds = ids;
  }

  stop(): void {
    this.cur = this.inc = null;
    this.spare = null;
    this.pending = [];
  }

  /**
   * Make the renderer of the track that follows the current one now, while there is time: a track can take a moment to set up, and
   * the next crossfade, or a skip (the track it goes to is nearly always this one), should not have to wait for it. The worker calls
   * this when the buffer is full and it has nothing else to do; it costs nothing when the right renderer is ready already.
   */
  warm(): void {
    if (!this.cur) return;
    const id = this.nextId(this.cur.id);
    if (this.spare?.id === id) return;
    this.spare = null;
    try {
      this.spare = { id, r: this.o.createRenderer(id, this.sr) };
    } catch {
      // (it is reported when the track is wanted, and the fallbacks tried then)
    }
  }

  /** The next `n` frames of the stream. Silent when there is nothing to play. */
  produce(n: number): Chunk {
    const start = this.pos;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    let filled = 0;
    while (filled < n) {
      if (!this.cur && !this.recover(start + filled)) break;
      const cur = this.cur!;
      const k = n - filled;
      if (this.inc) {
        const m = Math.min(k, this.xfLen - this.xfDone);
        this.mix(l, r, filled, m);
        filled += m;
        if (this.xfDone >= this.xfLen) {
          this.cur = this.inc;
          this.inc = null;
        }
        continue;
      }
      const left = cur.frames - cur.done;
      const toCross = this.noCross ? left : left - this.xf;
      if (toCross <= 0) {
        if (left <= 0) this.cur = null; // (it has ended: whatever comes next starts here)
        else if (!this.beginCrossfade(start + filled)) this.noCross = true;
        continue;
      }
      const m = Math.min(k, toCross);
      const w = this.renderCur(l, r, filled, m);
      filled += w;
      if (w < m) cur.done = cur.frames; // (it ended before it said it would)
    }
    this.pos = start + n;
    const marks: Mark[] = [];
    while (this.pending.length && this.pending[0].pos < this.pos) marks.push(this.pending.shift()!);
    return { pos: start, l, r, marks };
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Make track `id` the current one, from its first sample at the current stream position. */
  private begin(id: string, n: number, fadeFrames: number): boolean {
    const t = this.make(id, n, fadeFrames);
    this.cur = t;
    if (!t) return false;
    this.started = t.n + 1;
    this.pending.push({ pos: this.pos, id: t.id, n: t.n, kind: 'start', epoch: this.epoch });
    return true;
  }

  /** A track made from `id`, or from the first of the fallbacks that makes. */
  private make(id: string, n: number, fade: number): Playing | null {
    const attempt = (c: string): Playing | null => {
      try {
        let r: TrackRenderer;
        if (this.spare && this.spare.id === c) {
          r = this.spare.r;
          this.spare = null;
        } else r = this.o.createRenderer(c, this.sr);
        if (r.frames > 0) return { id: c, n, r, frames: r.frames, done: 0, fade };
      } catch (e) {
        this.o.onError?.(c, e);
      }
      return null;
    };
    let t = attempt(id);
    if (t) return t;
    for (const c of this.o.fallback?.(id) ?? []) {
      if (c === id) continue;
      t = attempt(c);
      if (t) return t;
    }
    return null;
  }

  /** The id of the track that follows the one being rendered. */
  private nextId(from: string | null): string {
    const at = this.started - this.queueBase;
    if (at >= 0 && at < this.queueIds.length) return this.queueIds[at];
    return this.o.fallback?.(from)[0] ?? from ?? '';
  }

  /** Nothing is playing (a track ended with no crossfade, or none could be made): try to start the next, not too often. */
  private recover(absPos: number): boolean {
    if (absPos < this.retryAt) return false;
    const from = this.currentId;
    const t = this.make(this.nextId(from), this.started, 0);
    if (!t) {
      this.retryAt = absPos + this.sr * 2;
      return false;
    }
    this.cur = t;
    this.noCross = false;
    this.started = t.n + 1;
    this.pending.push({ pos: absPos, id: t.id, n: t.n, kind: 'next', epoch: this.epoch });
    return true;
  }

  /** The current track is within a crossfade of its end: bring the next one in. False when it cannot be made. */
  private beginCrossfade(absPos: number): boolean {
    const cur = this.cur!;
    const t = this.make(this.nextId(cur.id), this.started, 0);
    if (!t) return false;
    this.started = t.n + 1;
    const len = Math.min(this.xf, cur.frames - cur.done, t.frames);
    if (len < 1) {
      // too short to overlap: a straight cut
      this.cur = t;
      this.pending.push({ pos: absPos, id: t.id, n: t.n, kind: 'next', epoch: this.epoch });
      return true;
    }
    this.inc = t;
    this.xfLen = len;
    this.xfDone = 0;
    this.pending.push({ pos: absPos + Math.floor(len / 2), id: t.id, n: t.n, kind: 'next', epoch: this.epoch });
    return true;
  }

  /**
   * One block of a track. A renderer that throws is a broken track, not a broken stream: it is reported, counted as ended, and the
   * album goes on to the next one.
   */
  private safeRender(p: Playing, l: Float32Array, r: Float32Array, m: number): number {
    try {
      const w = Math.max(0, Math.min(m, p.r.render(l, r, m)));
      return Number.isFinite(w) ? w : 0;
    } catch (e) {
      this.o.onError?.(p.id, e);
      p.done = p.frames;
      l.fill(0, 0, m);
      r.fill(0, 0, m);
      return 0;
    }
  }

  /** Render the current track alone into the block at `off`; the fade-in of its head is applied. Returns the frames written. */
  private renderCur(l: Float32Array, r: Float32Array, off: number, m: number): number {
    const cur = this.cur!;
    const w = this.safeRender(cur, l.subarray(off, off + m), r.subarray(off, off + m), m);
    if (cur.done < cur.fade) {
      for (let i = 0; i < w; i++) {
        const t = cur.done + i;
        if (t >= cur.fade) break;
        const g = Math.sin(HALF_PI * (t / cur.fade));
        l[off + i] *= g;
        r[off + i] *= g;
      }
    }
    cur.done += w;
    return w;
  }

  /** Render both tracks of a crossfade and mix them equal-power into the block at `off`. */
  private mix(l: Float32Array, r: Float32Array, off: number, m: number): void {
    const cur = this.cur!;
    const inc = this.inc!;
    if (this.sa[0].length < m) {
      this.sa = [new Float32Array(m), new Float32Array(m)];
      this.sb = [new Float32Array(m), new Float32Array(m)];
    }
    const [al, ar] = this.sa;
    const [bl, br] = this.sb;
    // (renderers are free to add into their blocks: start them from silence)
    al.fill(0, 0, m);
    ar.fill(0, 0, m);
    bl.fill(0, 0, m);
    br.fill(0, 0, m);
    const wa = this.safeRender(cur, al.subarray(0, m), ar.subarray(0, m), m);
    const wb = this.safeRender(inc, bl.subarray(0, m), br.subarray(0, m), m);
    for (let i = 0; i < m; i++) {
      const t = (this.xfDone + i) / this.xfLen;
      const a = Math.cos(HALF_PI * t);
      const b = Math.sin(HALF_PI * t);
      l[off + i] = al[i] * a + bl[i] * b;
      r[off + i] = ar[i] * a + br[i] * b;
    }
    cur.done += wa;
    inc.done += wb;
    this.xfDone += m;
  }
}
