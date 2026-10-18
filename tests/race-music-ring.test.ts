/**
 * The ring buffer the worklet keeps the album's stream in: indexed by stream position, so a skip can rewrite the stream from a point
 * ahead of the playhead.
 */
import { describe, expect, it } from 'vitest';
import { PcmRing } from '../src/audio/album-ring';

/** Frames pos..pos+n-1 of a ramp: left = position, right = -position. */
function ramp(pos: number, n: number): [Float32Array, Float32Array] {
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = pos + i;
    r[i] = -(pos + i);
  }
  return [l, r];
}

function readAll(ring: PcmRing, n: number): { l: Float32Array; r: Float32Array; got: number } {
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const got = ring.read(l, r, n);
  return { l, r, got };
}

describe('PCM ring', () => {
  it('reads back what was written, in order', () => {
    const ring = new PcmRing(100);
    expect(ring.write(0, ...ramp(0, 40))).toBe(true);
    expect(ring.fill).toBe(40);
    const a = readAll(ring, 25);
    expect(a.got).toBe(25);
    expect(Array.from(a.l.slice(0, 3))).toEqual([0, 1, 2]);
    expect(Array.from(a.r.slice(0, 3))).toEqual([-0, -1, -2]);
    expect(ring.rd).toBe(25);
    const b = readAll(ring, 25);
    expect(b.got).toBe(15); // only what is there
    expect(b.l[0]).toBe(25);
    expect(b.l[14]).toBe(39);
    expect(ring.fill).toBe(0);
    expect(readAll(ring, 5).got).toBe(0);
  });

  it('wraps round the end of the ring', () => {
    const ring = new PcmRing(64);
    let pos = 0;
    let expectNext = 0;
    for (let round = 0; round < 40; round++) {
      expect(ring.write(pos, ...ramp(pos, 23))).toBe(true);
      pos += 23;
      const { l, got } = readAll(ring, 23);
      expect(got).toBe(23);
      for (let i = 0; i < 23; i++) expect(l[i]).toBe(expectNext++);
    }
  });

  it('refuses a chunk that would run more than a ring ahead of the read head', () => {
    const ring = new PcmRing(50);
    expect(ring.write(0, ...ramp(0, 50))).toBe(true);
    expect(ring.write(50, ...ramp(50, 1))).toBe(false);
    readAll(ring, 10);
    expect(ring.write(50, ...ramp(50, 10))).toBe(true);
    expect(ring.write(60, ...ramp(60, 1))).toBe(false);
    expect(ring.fill).toBe(50);
  });

  it('rewrites the stream from a position ahead of the read head, dropping what followed', () => {
    const ring = new PcmRing(200);
    ring.write(0, ...ramp(0, 120));
    readAll(ring, 10); // the playhead is at 10
    // a skip: the stream is rewritten from 40 on, with other content (offset by 1000)
    const [l, r] = ramp(1040, 30);
    expect(ring.write(40, l, r)).toBe(true);
    expect(ring.wr).toBe(70); // (the old track's frames 70..119 are gone)
    const { l: out, got } = readAll(ring, 100);
    expect(got).toBe(60);
    expect(out[0]).toBe(10);
    expect(out[29]).toBe(39);
    expect(out[30]).toBe(1040); // the new track begins at 40
    expect(out[59]).toBe(1069);
  });

  it('drops the late part of a chunk that starts before the read head, and all of one that is entirely late', () => {
    const ring = new PcmRing(100);
    ring.write(0, ...ramp(0, 30));
    readAll(ring, 20);
    expect(ring.write(15, ...ramp(15, 25))).toBe(true); // frames 15..39: 15..19 are late
    expect(ring.wr).toBe(40);
    const { l, got } = readAll(ring, 40);
    expect(got).toBe(20);
    expect(l[0]).toBe(20);
    const before = ring.wr;
    expect(ring.write(2, ...ramp(2, 10))).toBe(true);
    expect(ring.wr).toBe(before);
  });

  it('fills a gap with silence instead of leaving what was there', () => {
    const ring = new PcmRing(64);
    ring.write(0, ...ramp(1, 20)); // frames hold 1..20
    readAll(ring, 20);
    ring.write(20, ...ramp(100, 10));
    readAll(ring, 10);
    // a chunk that skips 15 frames ahead
    ring.write(45, ...ramp(500, 5));
    const { l } = readAll(ring, 20);
    expect(Array.from(l.slice(0, 15))).toEqual(new Array(15).fill(0));
    expect(l[15]).toBe(500);
  });

  it('seeks forward within the valid frames', () => {
    const ring = new PcmRing(100);
    ring.write(0, ...ramp(0, 60));
    ring.seek(25);
    expect(ring.rd).toBe(25);
    expect(readAll(ring, 1).l[0]).toBe(25);
    ring.seek(1000); // clamped to the end
    expect(ring.rd).toBe(60);
    ring.seek(5); // never backwards
    expect(ring.rd).toBe(60);
  });

  it('clears to a position', () => {
    const ring = new PcmRing(32);
    ring.write(0, ...ramp(0, 20));
    ring.clear(0);
    expect(ring.fill).toBe(0);
    expect(ring.write(0, ...ramp(0, 10))).toBe(true);
    expect(readAll(ring, 10).l[9]).toBe(9);
  });
});
