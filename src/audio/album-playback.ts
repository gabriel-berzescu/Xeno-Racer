/**
 * What the worklet does with the album's stream (pure: no Web Audio, so it is tested in node and the worklet is a few lines of glue).
 *
 * It holds the stream in a ring (album-ring.ts) and plays it, 128 frames at a time, with these rules:
 *  - Nothing is played until `playRequested` (the first seconds are buffered while the race loads), and after a stretch of silence
 *    (the start, a skip, a buffer that ran dry) it waits for `prebuffer` frames before it plays on, so a late block does not
 *    stutter the music.
 *  - A skip (`cut`) fades what is playing out over a short time, then jumps to the first sample of the newest track the worker has
 *    started since (a 'start' mark). Skips pressed while one is in progress move the destination, not the fade.
 *  - When the ring runs dry the music stops cleanly: the last sample decays to zero over a few dozen frames instead of stepping, and
 *    it comes back with a short fade-in. It counts an underrun; it never plays garbage and never loops.
 *  - A `Mark` of the stream is reported once the playhead has passed it, so that "now playing" changes when the track is heard,
 *    not when it was rendered.
 */
import { PcmRing } from './album-ring';
import type { LinkDown, Mark, PlaybackStats } from './album-protocol';

/** Frames over which the last sample decays after the music stops. */
export const DECAY_FRAMES = 32;
/** Frames of fade-in when the music (re)starts after silence. */
export const FADE_IN_FRAMES = 64;

export interface PlaybackOptions {
  sampleRate: number;
  /** Frames the ring holds (default 14 s). */
  capacity?: number;
  /** Frames to have buffered before the music (re)starts (default 0.3 s). */
  prebuffer?: number;
  /** A track has been heard. */
  onTrack?(mark: Mark): void;
}

export class AlbumPlayback {
  readonly ring: PcmRing;
  session = 0;
  /** `play` has been asked for. */
  playRequested = false;
  underruns = 0;
  overruns = 0;

  private readonly prebuffer: number;
  private readonly onTrack: (m: Mark) => void;
  /** Reading from the ring (as opposed to waiting for it to fill). */
  private playing = false;
  private marks: Mark[] = [];
  // a skip in progress
  private cutting = false;
  private cutLeft = 0;
  private cutTotal = 1;
  private cutEpoch = 0;
  private fadeIn = 0;
  // the last real sample, decaying to zero when the music stops
  private holdL = 0;
  private holdR = 0;
  private holdLeft = 0;
  // level meter
  private sumSq = 0;
  private peak = 0;
  private metered = 0;

  constructor(o: PlaybackOptions) {
    this.ring = new PcmRing(o.capacity ?? Math.ceil(14 * o.sampleRate));
    this.prebuffer = Math.max(0, o.prebuffer ?? Math.round(0.3 * o.sampleRate));
    this.onTrack = o.onTrack ?? ((): void => undefined);
  }

  /** The playhead, in stream frames. */
  get played(): number {
    return this.ring.rd;
  }

  /** Start over with a new stream (position 0). */
  reset(session: number): void {
    this.session = session;
    this.ring.clear(0);
    this.marks.length = 0;
    this.playing = false;
    this.cutting = false;
    this.fadeIn = 0;
  }

  /** A message from the worker. */
  receive(m: LinkDown): void {
    if (m.type === 'reset') {
      this.reset(m.session);
      return;
    }
    if (m.session !== this.session) return; // a leftover of an older stream
    if (!this.ring.write(m.pos, m.l, m.r)) {
      this.overruns++;
      return;
    }
    // (a rewrite replaces everything from its start on, the marks in it too)
    while (this.marks.length && this.marks[this.marks.length - 1].pos >= m.pos) this.marks.pop();
    for (const k of m.marks) this.marks.push(k);
  }

  /** Skip: fade out over `frames`, then land on the first track started with an epoch of at least `epoch`. */
  cut(epoch: number, frames: number): void {
    if (this.cutting) {
      // (another press in the middle of the fade: the same fade, a newer destination)
      this.cutEpoch = Math.max(this.cutEpoch, epoch);
      return;
    }
    this.cutting = true;
    this.cutEpoch = epoch;
    this.cutTotal = Math.max(1, Math.floor(frames));
    // (nothing audible to fade out: land as soon as the new track is there)
    this.cutLeft = this.playing && this.ring.fill > 0 ? this.cutTotal : 0;
  }

  /** Fill `L` and `R` (the first `n` frames) with the next stretch of the music. */
  process(L: Float32Array, R: Float32Array, n: number): void {
    let o = 0;
    if (this.playRequested) {
      while (o < n) {
        if (this.cutting && this.cutLeft <= 0 && !this.land()) break; // faded out, and the new track is not here yet
        if (!this.playing) {
          if (this.ring.fill < this.prebuffer || this.ring.fill === 0) break;
          this.playing = true;
          this.fadeIn = FADE_IN_FRAMES;
        }
        const m = this.cutting ? Math.min(n - o, this.cutLeft) : n - o;
        const got = this.ring.read(L, R, m, o);
        if (got > 0) {
          this.shape(L, R, o, got);
          o += got;
          if (this.cutting) this.cutLeft -= got;
        }
        if (got < m) {
          // the ring ran dry
          this.underruns++;
          this.playing = false;
          if (this.cutting) this.cutLeft = 0; // (a fade that cannot finish is finished: on to the new track)
          break;
        }
      }
    }
    if (o > 0) {
      this.holdL = L[o - 1];
      this.holdR = R[o - 1];
      this.holdLeft = DECAY_FRAMES;
    }
    if (o < n) this.silence(L, R, o, n);
    this.meter(L, R, n);
    while (this.marks.length && this.marks[0].pos < this.ring.rd) this.onTrack(this.marks.shift()!);
  }

  /** The level and buffer figures since the last call. */
  stats(): PlaybackStats {
    const s: PlaybackStats = {
      played: this.ring.rd,
      fill: this.ring.fill,
      underruns: this.underruns,
      overruns: this.overruns,
      rms: this.metered > 0 ? Math.sqrt(this.sumSq / this.metered) : 0,
      peak: this.peak,
      playing: this.playing && this.playRequested,
    };
    this.sumSq = this.peak = 0;
    this.metered = 0;
    return s;
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The fade-out is done: jump to the newest track started since the skip was asked for. False while there is none yet. */
  private land(): boolean {
    let target: Mark | null = null;
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const k = this.marks[i];
      if (k.kind === 'start' && k.epoch >= this.cutEpoch) {
        target = k;
        break;
      }
    }
    if (!target) return false;
    this.ring.seek(target.pos);
    // (marks before the target are the old track's)
    while (this.marks.length && this.marks[0] !== target) this.marks.shift();
    this.cutting = false;
    this.playing = false; // (the loop waits for the prebuffer, then fades in a few frames)
    return true;
  }

  /** The gain of a skip's fade-out and of a restart's fade-in, applied to `count` frames at `off`. */
  private shape(L: Float32Array, R: Float32Array, off: number, count: number): void {
    if (!this.cutting && this.fadeIn <= 0) return;
    for (let i = 0; i < count; i++) {
      let g = 1;
      if (this.cutting) g = Math.cos((Math.PI / 2) * Math.min(1, (this.cutTotal - this.cutLeft + i) / this.cutTotal));
      if (this.fadeIn > 0) {
        g *= 1 - this.fadeIn / FADE_IN_FRAMES;
        this.fadeIn--;
      }
      L[off + i] *= g;
      R[off + i] *= g;
    }
  }

  private silence(L: Float32Array, R: Float32Array, from: number, to: number): void {
    for (let i = from; i < to; i++) {
      if (this.holdLeft > 0) {
        const g = this.holdLeft / DECAY_FRAMES;
        L[i] = this.holdL * g;
        R[i] = this.holdR * g;
        this.holdLeft--;
      } else {
        L[i] = 0;
        R[i] = 0;
      }
    }
  }

  private meter(L: Float32Array, R: Float32Array, n: number): void {
    let s = 0;
    let p = this.peak;
    for (let i = 0; i < n; i++) {
      const a = L[i];
      const b = R[i];
      s += a * a + b * b;
      const m = Math.max(Math.abs(a), Math.abs(b));
      if (m > p) p = m;
    }
    this.sumSq += s * 0.5;
    this.peak = p;
    this.metered += n;
  }
}
