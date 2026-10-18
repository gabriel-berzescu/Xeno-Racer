/**
 * The album's shuffle bag (pure: no Web Audio, no DOM): the order the tracks play in.
 *
 * Every track plays once before any plays again (a bag is shuffled whole, then emptied), and the same track is never played twice in a
 * row, not even across a refill (the first track of a new bag is never the last of the one before). The order is decided ahead of
 * time: a queue always holds the next few tracks, so the player can have the next one rendered before it is needed, and what is
 * peeked at is what is played. The queue is kept in localStorage, so the next session carries on where the last one stopped (the car
 * is a car, and the radio is the radio) instead of starting from a new shuffle that may begin with the song just heard.
 *
 * Storage is optional: wherever it is missing, full or refused (private windows), the bag works for the session and starts from a new
 * shuffle the next time.
 */

export type Rng = () => number;

/** What is kept: the tracks still to come, in order, and the last one taken (what the next bag must not start with). */
export interface BagState {
  q: string[];
  last: string | null;
}

export const BAG_KEY = 'xeno-racer.album.v1';

/** The queue is topped up to at least this many tracks after every take. */
const LOOKAHEAD = 4;

/** Fisher-Yates, in place. */
function shuffle<T>(a: T[], rng: Rng): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class ShuffleBag {
  private readonly ids: readonly string[];
  private queue: string[] = [];
  private last: string | null = null;

  /**
   * @param ids   the tracks of the album (each once)
   * @param rng   a source of numbers in [0, 1) (Math.random by default; tests pass a seeded one)
   * @param saved a state from `state()`, possibly from an older build with other tracks or from a hand-edited save: whatever of it
   *              makes sense is kept, the rest is dropped
   */
  constructor(ids: readonly string[], private readonly rng: Rng = Math.random, saved?: unknown) {
    this.ids = [...new Set(ids)];
    if (saved && typeof saved === 'object') {
      const s = saved as Partial<BagState>;
      const known = new Set(this.ids);
      if (typeof s.last === 'string' && known.has(s.last)) this.last = s.last;
      if (Array.isArray(s.q)) {
        let prev = this.last;
        for (const id of s.q) {
          // (an id the album no longer has is dropped, and so is a track that would now follow itself)
          if (typeof id !== 'string' || !known.has(id) || (id === prev && this.ids.length > 1)) continue;
          this.queue.push(id);
          prev = id;
        }
      }
    }
    this.refill();
  }

  /** How many tracks the album has. */
  get size(): number {
    return this.ids.length;
  }

  /** The next `n` tracks, in the order they will play (at most the look-ahead). Nothing is taken. */
  peek(n: number): string[] {
    return this.queue.slice(0, Math.max(0, Math.min(n, this.queue.length)));
  }

  /**
   * The next track is being played: take it off the queue. `expect` names the track the caller knows is playing: if it is not the
   * head of the queue (the album went on without us, or has changed since the queue was saved) it is the one taken, wherever it was.
   * Null when the album is empty.
   */
  take(expect?: string): string | null {
    if (this.ids.length === 0) return null;
    let id: string;
    if (expect !== undefined && this.queue[0] !== expect) {
      const at = this.queue.indexOf(expect);
      if (at > 0) this.queue.splice(at, 1);
      id = expect;
    } else {
      id = this.queue.shift()!;
    }
    this.last = id;
    this.refill();
    return id;
  }

  /** Put the queue back as it should be saved. */
  state(): BagState {
    return { q: [...this.queue], last: this.last };
  }

  private refill(): void {
    if (this.ids.length === 0) return;
    while (this.queue.length < LOOKAHEAD) {
      const bag = shuffle([...this.ids], this.rng);
      const prev = this.queue.length ? this.queue[this.queue.length - 1] : this.last;
      // the first of the new bag must not repeat the last of the old: swap it with another (one track cannot avoid it)
      if (bag.length > 1 && bag[0] === prev) {
        const j = 1 + Math.min(bag.length - 2, Math.floor(this.rng() * (bag.length - 1)));
        [bag[0], bag[j]] = [bag[j], bag[0]];
      }
      this.queue.push(...bag);
    }
  }
}

// ── persistence ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The part of a Storage the bag needs (so tests can pass a fake). */
export interface BagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** localStorage, or null where there is none (or where touching it throws). */
export function defaultStorage(): BagStorage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** The bag of the album `ids`, carrying on from what was saved. */
export function loadBag(ids: readonly string[], storage: BagStorage | null = defaultStorage(), rng: Rng = Math.random): ShuffleBag {
  let saved: unknown;
  try {
    const raw = storage?.getItem(BAG_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch {
    /* unreadable or refused: a new shuffle */
  }
  return new ShuffleBag(ids, rng, saved);
}

export function saveBag(bag: ShuffleBag, storage: BagStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(BAG_KEY, JSON.stringify(bag.state()));
  } catch {
    /* full or refused: the order is lost with the session */
  }
}
