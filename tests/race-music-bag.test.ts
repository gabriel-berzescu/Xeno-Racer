/**
 * The race music's shuffle bag: every track once before any repeats, never the same track twice in a row (across refills too),
 * and the order carries on from one session to the next.
 */
import { describe, expect, it } from 'vitest';
import { BAG_KEY, ShuffleBag, loadBag, saveBag, type BagStorage } from '../src/audio/album-shuffle';

/** A seeded generator (mulberry32), so a failing seed can be replayed. */
function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `t${i + 1}`);

function drawMany(bag: ShuffleBag, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(bag.take()!);
  return out;
}

class MemStorage implements BagStorage {
  data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
}

describe('shuffle bag', () => {
  it('plays every track once before any plays again', () => {
    for (const n of [2, 3, 4, 5, 8, 14]) {
      for (let seed = 1; seed <= 40; seed++) {
        const bag = new ShuffleBag(ids(n), rngOf(seed));
        const order = drawMany(bag, n * 6);
        for (let b = 0; b < 6; b++) {
          const window = order.slice(b * n, (b + 1) * n);
          expect(new Set(window).size, `n=${n} seed=${seed} bag ${b}`).toBe(n);
        }
      }
    }
  });

  it('never plays the same track twice in a row, across the refill of a bag too', () => {
    for (const n of [2, 3, 4, 7, 14]) {
      for (let seed = 1; seed <= 300; seed++) {
        const bag = new ShuffleBag(ids(n), rngOf(seed));
        const order = drawMany(bag, n * 8);
        for (let i = 1; i < order.length; i++) expect(order[i], `n=${n} seed=${seed} at ${i}`).not.toBe(order[i - 1]);
      }
    }
  });

  it('shuffles (the order is not the album order, and differs between seeds)', () => {
    const a = drawMany(new ShuffleBag(ids(14), rngOf(1)), 14);
    const b = drawMany(new ShuffleBag(ids(14), rngOf(2)), 14);
    expect(a).not.toEqual(ids(14));
    expect(a).not.toEqual(b);
  });

  it('is deterministic for a seed', () => {
    expect(drawMany(new ShuffleBag(ids(6), rngOf(7)), 20)).toEqual(drawMany(new ShuffleBag(ids(6), rngOf(7)), 20));
  });

  it('peeks at what it will play, without taking it', () => {
    const bag = new ShuffleBag(ids(5), rngOf(3));
    const peek = bag.peek(4);
    expect(peek).toHaveLength(4);
    expect(bag.peek(4)).toEqual(peek);
    expect(drawMany(bag, 4)).toEqual(peek);
    // (and what was peeked at before a refill is what the refill then plays)
    const bag2 = new ShuffleBag(ids(3), rngOf(9));
    const first = drawMany(bag2, 2);
    const seen = bag2.peek(4);
    expect(drawMany(bag2, 4)).toEqual(seen);
    expect(first).toHaveLength(2);
  });

  it('copes with an album of one track (it repeats: there is nothing else) and with an empty one', () => {
    const one = new ShuffleBag(['only'], rngOf(1));
    expect(drawMany(one, 3)).toEqual(['only', 'only', 'only']);
    const none = new ShuffleBag([], rngOf(1));
    expect(none.take()).toBeNull();
    expect(none.peek(3)).toEqual([]);
  });

  it('with two tracks it simply alternates', () => {
    const order = drawMany(new ShuffleBag(['a', 'b'], rngOf(5)), 8);
    for (let i = 2; i < order.length; i++) expect(order[i]).toBe(order[i - 2]);
    expect(order[0]).not.toBe(order[1]);
  });

  it('takes the track the caller knows is playing, wherever it is in the queue', () => {
    const bag = new ShuffleBag(ids(6), rngOf(11));
    const q = bag.peek(4);
    expect(bag.take(q[0])).toBe(q[0]);
    // the album went on by two: take the third of the queue, and the one it skipped over stays queued
    const q2 = bag.peek(4);
    expect(bag.take(q2[2])).toBe(q2[2]);
    expect(bag.peek(4)[0]).toBe(q2[0]);
    // a track the bag has never heard of is accepted and changes nothing in the queue
    const before = bag.peek(3);
    expect(bag.take('ghost')).toBe('ghost');
    expect(bag.peek(3)).toEqual(before);
  });
});

describe('shuffle bag, kept between sessions', () => {
  it('carries on from where the last session stopped', () => {
    const store = new MemStorage();
    const album = ids(7);
    const bag = loadBag(album, store, rngOf(21));
    const played = drawMany(bag, 3);
    saveBag(bag, store);
    const next = bag.peek(4);
    const again = loadBag(album, store, rngOf(99)); // (another seed: the saved order is kept, not made again)
    expect(again.peek(4)).toEqual(next);
    expect(next[0]).not.toBe(played[2]); // not the song just heard
    // and the rest of the bag is the rest of the same bag: the first seven tracks of the two sessions are all different
    const rest = drawMany(again, 4);
    expect(new Set([...played, ...rest]).size).toBe(7);
  });

  it('writes what it keeps as JSON under one key', () => {
    const store = new MemStorage();
    const bag = loadBag(ids(4), store, rngOf(2));
    bag.take();
    saveBag(bag, store);
    const raw = store.getItem(BAG_KEY)!;
    const saved = JSON.parse(raw) as { q: string[]; last: string };
    expect(saved.q.length).toBeGreaterThanOrEqual(4);
    expect(saved.last).toMatch(/^t\d$/);
  });

  it('starts a new shuffle where nothing usable was kept', () => {
    for (const raw of [null, '', 'not json', '42', 'null', '[]', '{"q":"abc"}', '{"q":[1,2,3],"last":7}', '{"q":{"a":1}}']) {
      const store = new MemStorage();
      if (raw !== null) store.setItem(BAG_KEY, raw);
      const bag = loadBag(ids(5), store, rngOf(4));
      const order = drawMany(bag, 5);
      expect(new Set(order).size, String(raw)).toBe(5);
    }
  });

  it('forgets tracks the album no longer has, and never repeats the last song because of it', () => {
    const store = new MemStorage();
    store.setItem(BAG_KEY, JSON.stringify({ q: ['gone', 't2', 'gone2', 't2', 't3'], last: 't1' }));
    const bag = loadBag(ids(4), store, rngOf(8));
    const q = bag.peek(4);
    expect(q[0]).toBe('t2');
    for (let i = 1; i < q.length; i++) expect(q[i]).not.toBe(q[i - 1]);
    expect(q).not.toContain('gone');
    // a saved queue that would start with the song just played is not allowed to
    store.setItem(BAG_KEY, JSON.stringify({ q: ['t1', 't2', 't3', 't4'], last: 't1' }));
    expect(loadBag(ids(4), store, rngOf(8)).peek(1)[0]).not.toBe('t1');
  });

  it('takes the new tracks of a bigger album into the next bag', () => {
    const store = new MemStorage();
    const small = loadBag(ids(3), store, rngOf(6));
    drawMany(small, 4);
    saveBag(small, store);
    const big = loadBag(ids(8), store, rngOf(6));
    const order = drawMany(big, 40);
    for (const id of ids(8)) expect(order, id).toContain(id);
  });

  it('plays the songs an update adds at once: shuffled into the saved order, starting with a new one', () => {
    // a save from the first build with music: five songs, no album list kept (the player passes that build's five as the legacy album)
    const store = new MemStorage();
    const five = loadBag(ids(5), store, rngOf(3));
    drawMany(five, 2);
    saveBag(five, store);
    const old = JSON.parse(store.getItem(BAG_KEY)!) as { q: string[]; last: string; album?: string[] };
    delete old.album;
    store.setItem(BAG_KEY, JSON.stringify(old));
    expect(loadBag(ids(10), store, rngOf(5)).peek(4).every((id) => Number(id.slice(1)) <= 5)).toBe(true); // without knowing its album: as saved
    const ten = loadBag(ids(10), store, rngOf(5), ids(5)); // the player says what the first build had
    const order = drawMany(ten, 10);
    expect(Number(order[0].slice(1))).toBeGreaterThan(5); // a new song first
    expect(order.slice(0, 10).filter((id) => Number(id.slice(1)) > 5).sort()).toEqual(['t10', 't6', 't7', 't8', 't9']); // all five within ten
    for (let i = 1; i < order.length; i++) expect(order[i]).not.toBe(order[i - 1]);
    expect(order[0]).not.toBe(old.last);
  });

  it('knows from the album it kept which songs are new (not the ones already played from the bag)', () => {
    const store = new MemStorage();
    const seven = loadBag(ids(7), store, rngOf(11));
    drawMany(seven, 5); // the queue no longer holds the five just played
    saveBag(seven, store);
    expect((JSON.parse(store.getItem(BAG_KEY)!) as { album: string[] }).album).toEqual(ids(7));
    const nine = loadBag(ids(9), store, rngOf(12));
    const next = nine.peek(4);
    expect(['t8', 't9']).toContain(next[0]); // a new song first
    expect(next.filter((id) => id === 't8' || id === 't9').length).toBe(2); // both new ones soon
    // none of the songs just played comes back before the rest of the old bag
    const savedQ = (JSON.parse(store.getItem(BAG_KEY)!) as { q: string[] }).q;
    expect(nine.peek(4).filter((id) => !['t8', 't9'].includes(id))).toEqual(savedQ.slice(0, 2));
  });

  it('works without any storage: none, one that throws on read, one that throws on write', () => {
    expect(() => loadBag(ids(3), null, rngOf(1)).take()).not.toThrow();
    const reads: BagStorage = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {},
    };
    expect(loadBag(ids(3), reads, rngOf(1)).take()).toMatch(/^t/);
    const writes: BagStorage = {
      getItem: () => null,
      setItem() {
        throw new Error('QuotaExceededError');
      },
    };
    const bag = loadBag(ids(3), writes, rngOf(1));
    expect(() => saveBag(bag, writes)).not.toThrow();
    expect(() => saveBag(bag, null)).not.toThrow();
  });
});
