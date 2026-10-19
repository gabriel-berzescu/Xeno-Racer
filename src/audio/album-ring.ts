/**
 * A stereo ring buffer indexed by STREAM POSITION (pure: no Web Audio), the worklet's store of the album's stream.
 *
 * Frame `p` of the stream lives at slot `p % capacity`, so a chunk can be written at any position inside the window the ring holds,
 * not only at its end: a skip makes the worker go back and rewrite the stream from a point a little ahead of the playhead, and the
 * old track's frames past that point are simply written over (and `wr` moves back with the write, dropping what followed).
 * `rd` is the read head (the next frame to be played) and `wr` one past the last valid frame; both only ever count up, except that a
 * rewrite moves `wr` back to the end of what it wrote.
 */
export class PcmRing {
  readonly capacity: number;
  private readonly l: Float32Array;
  private readonly r: Float32Array;
  /** Stream position of the next frame to read. */
  rd = 0;
  /** One past the last valid frame (the stream position the next chunk is expected at). */
  wr = 0;
  /** Slot of `rd`. */
  private rdi = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(2, Math.floor(capacity));
    this.l = new Float32Array(this.capacity);
    this.r = new Float32Array(this.capacity);
  }

  /** Frames waiting to be read. */
  get fill(): number {
    return this.wr - this.rd;
  }

  /** Empty, with the read head at stream position `pos`. */
  clear(pos = 0): void {
    this.rd = this.wr = pos;
    this.rdi = pos % this.capacity;
  }

  /**
   * Store frames [pos, pos + n) of the stream. The part before the read head is late and is dropped. Anything the ring held from
   * `pos` on is replaced: `wr` becomes `pos + n`. A gap between the old `wr` and `pos` (which a well-behaved writer never leaves) is
   * filled with silence. Returns false, storing nothing, when the chunk would run more than a whole ring ahead of the read head.
   */
  write(pos: number, l: Float32Array, r: Float32Array, n = l.length): boolean {
    let skip = 0;
    if (pos < this.rd) {
      skip = this.rd - pos;
      if (skip >= n) return true; // all of it is late
    }
    const from = pos + skip;
    const len = n - skip;
    if (from + len - this.rd > this.capacity) return false;
    if (from > this.wr) this.fillSilence(this.wr, from);
    this.copyIn(from, l, r, skip, len);
    this.wr = from + len;
    return true;
  }

  /** Copy up to `n` frames from the read head into `outL` / `outR` at `off`, and advance the head. Returns how many. */
  read(outL: Float32Array, outR: Float32Array, n: number, off = 0): number {
    const m = Math.min(n, this.fill);
    if (m <= 0) return 0;
    const cap = this.capacity;
    const first = Math.min(m, cap - this.rdi);
    outL.set(this.l.subarray(this.rdi, this.rdi + first), off);
    outR.set(this.r.subarray(this.rdi, this.rdi + first), off);
    if (first < m) {
      outL.set(this.l.subarray(0, m - first), off + first);
      outR.set(this.r.subarray(0, m - first), off + first);
    }
    this.rd += m;
    this.rdi = (this.rdi + m) % cap;
    return m;
  }

  /** Move the read head to stream position `pos` (clamped to the valid frames). */
  seek(pos: number): void {
    const p = Math.max(this.rd, Math.min(this.wr, pos));
    this.rdi = (this.rdi + (p - this.rd)) % this.capacity;
    this.rd = p;
  }

  private slot(pos: number): number {
    return (this.rdi + (pos - this.rd)) % this.capacity;
  }

  private copyIn(pos: number, l: Float32Array, r: Float32Array, srcOff: number, len: number): void {
    const cap = this.capacity;
    let at = this.slot(pos);
    let done = 0;
    while (done < len) {
      const k = Math.min(len - done, cap - at);
      this.l.set(l.subarray(srcOff + done, srcOff + done + k), at);
      this.r.set(r.subarray(srcOff + done, srcOff + done + k), at);
      done += k;
      at = 0;
    }
  }

  private fillSilence(from: number, to: number): void {
    const cap = this.capacity;
    let at = this.slot(from);
    let left = to - from;
    while (left > 0) {
      const k = Math.min(left, cap - at);
      this.l.fill(0, at, at + k);
      this.r.fill(0, at, at + k);
      left -= k;
      at = 0;
    }
  }
}
