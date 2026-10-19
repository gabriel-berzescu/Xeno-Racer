/**
 * The race music's main-thread player and its place in the audio system, against stand-ins for the worker, the worklet node and the
 * audio context: who is told what and when, the gain ramps, the bag, the skips, the stop and the restart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlbumTrack } from '../src/audio/album';
import type { NodeIn, NodeOut, WorkerIn, WorkerOut } from '../src/audio/album-protocol';
import { ALBUM_DUCK_GAIN, ALBUM_FADE_IN_S, ALBUM_FADE_OUT_S, ALBUM_SKIP_FADE_S, AlbumPlayer, type AlbumPlayerOptions, type PlayNode, type WorkerLike, rampParam, smooth } from '../src/audio/album-player';
import { BAG_KEY, type BagStorage } from '../src/audio/album-shuffle';
import { createAudioSystemOn } from '../src/audio';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import type { NowPlaying } from '../src/core/contracts';

// ── stand-ins ────────────────────────────────────────────────────────────────────────────────────────────────────────

const SR = 48000;

interface Ev {
  type: 'set' | 'ramp';
  v: number;
  t: number;
}

/** An AudioParam that keeps its automation and can say what its value is at any time. */
class FParam {
  events: Ev[] = [];
  private initial: number;
  constructor(
    private readonly clock: { currentTime: number },
    v = 0,
  ) {
    this.initial = v;
  }
  get value(): number {
    return this.at(this.clock.currentTime);
  }
  set value(v: number) {
    this.initial = v;
    this.events = [];
  }
  at(now: number): number {
    let pv = this.initial;
    let pt = 0;
    for (const e of this.events) {
      if (e.type === 'set') {
        if (e.t > now) break;
        pv = e.v;
        pt = e.t;
      } else if (now >= e.t) {
        pv = e.v;
        pt = e.t;
      } else {
        return e.t === pt ? e.v : pv + ((e.v - pv) * (now - pt)) / (e.t - pt);
      }
    }
    return pv;
  }
  setValueAtTime(v: number, t: number): this {
    this.events.push({ type: 'set', v, t });
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.events.push({ type: 'ramp', v, t });
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    return this.linearRampToValueAtTime(v, t);
  }
  setTargetAtTime(v: number, t: number): this {
    return this.setValueAtTime(v, t);
  }
  cancelScheduledValues(t: number): this {
    this.events = this.events.filter((e) => e.t < t);
    return this;
  }
  /** The ramp events of the last automation: the values, in order. */
  ramp(): Ev[] {
    return this.events.filter((e) => e.type === 'ramp');
  }
}

class FGraphNode {
  to: unknown[] = [];
  connect(d?: unknown): unknown {
    if (d) this.to.push(d);
    return d ?? this;
  }
  disconnect(): void {
    this.to = [];
  }
}

class FGain extends FGraphNode {
  readonly gain: FParam;
  constructor(clock: { currentTime: number }) {
    super();
    this.gain = new FParam(clock, 1);
  }
}

/** Every other node the audio system makes (filters, oscillators, convolvers...): params and no-ops. */
class FAny extends FGraphNode {
  readonly gain: FParam;
  readonly frequency: FParam;
  readonly Q: FParam;
  readonly detune: FParam;
  readonly delayTime: FParam;
  readonly playbackRate: FParam;
  readonly positionX: FParam;
  readonly positionY: FParam;
  readonly positionZ: FParam;
  readonly threshold: FParam;
  readonly knee: FParam;
  readonly ratio: FParam;
  readonly attack: FParam;
  readonly release: FParam;
  type = '';
  buffer: unknown = null;
  curve: unknown = null;
  oversample = '';
  loop = false;
  constructor(clock: { currentTime: number }) {
    super();
    const p = (): FParam => new FParam(clock, 0);
    this.gain = p();
    this.frequency = p();
    this.Q = p();
    this.detune = p();
    this.delayTime = p();
    this.playbackRate = p();
    this.positionX = p();
    this.positionY = p();
    this.positionZ = p();
    this.threshold = p();
    this.knee = p();
    this.ratio = p();
    this.attack = p();
    this.release = p();
  }
  start(): void {}
  stop(): void {}
}

interface FakeCtx {
  state: string;
  currentTime: number;
  sampleRate: number;
  destination: FGraphNode;
  listener: Record<string, FParam>;
  audioWorklet: { addModule(): Promise<void> };
  createGain(): FGain;
  advance(s: number): void;
  gains: FGain[];
}

function fakeContext(state = 'running'): FakeCtx {
  const clock = { currentTime: 0 };
  const gains: FGain[] = [];
  const listener: Record<string, FParam> = {};
  for (const k of ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ']) listener[k] = new FParam(clock, 0);
  const base = {
    state,
    sampleRate: SR,
    destination: new FGraphNode(),
    listener,
    audioWorklet: { addModule: () => Promise.resolve() },
    createGain: () => {
      const g = new FGain(clock);
      gains.push(g);
      return g;
    },
    createBuffer: (ch: number, len: number, sr: number) => ({ length: len, sampleRate: sr, numberOfChannels: ch, getChannelData: () => new Float32Array(len) }),
    addEventListener: () => undefined,
    gains,
    advance(s: number) {
      clock.currentTime += s;
    },
  };
  return new Proxy(base, {
    get(t, p, r) {
      if (p === 'currentTime') return clock.currentTime;
      if (p in t) return Reflect.get(t, p, r);
      if (typeof p === 'string' && p.startsWith('create')) return () => new FAny(clock);
      return undefined;
    },
  }) as unknown as FakeCtx;
}

class FWorker implements WorkerLike {
  posts: WorkerIn[] = [];
  terminated = false;
  onmessage: ((e: MessageEvent<WorkerOut>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  postMessage(m: WorkerIn): void {
    this.posts.push(m);
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(m: WorkerOut): void {
    this.onmessage?.({ data: m } as MessageEvent<WorkerOut>);
  }
  of<T extends WorkerIn['type']>(type: T): Extract<WorkerIn, { type: T }>[] {
    return this.posts.filter((p) => p.type === type) as Extract<WorkerIn, { type: T }>[];
  }
}

class FPlayNode extends FGraphNode implements PlayNode {
  posts: NodeIn[] = [];
  disposed = false;
  port = {
    postMessage: (m: NodeIn): void => {
      this.posts.push(m);
      if (m.type === 'dispose') this.disposed = true;
    },
    onmessage: null as ((e: MessageEvent<NodeOut>) => void) | null,
  };
  emit(m: NodeOut): void {
    this.port.onmessage?.({ data: m } as MessageEvent<NodeOut>);
  }
  of<T extends NodeIn['type']>(type: T): Extract<NodeIn, { type: T }>[] {
    return this.posts.filter((p) => p.type === type) as Extract<NodeIn, { type: T }>[];
  }
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

const TRACKS: AlbumTrack[] = ['a', 'b', 'c', 'd', 'e'].map((x, i) => ({ id: `t-${x}`, title: `Song ${x.toUpperCase()}`, genre: `Genre ${i}`, bpm: 120, seconds: 180 }));

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

interface Rig {
  ctx: FakeCtx;
  player: AlbumPlayer;
  worker: FWorker;
  nodes: FPlayNode[];
  storage: MemStorage;
  heard: (NowPlaying | null)[];
  out: FGain;
  node(): FPlayNode;
  /** The worker has read the album. */
  ready(): void;
  /** The worklet reports a track heard. */
  heardTrack(mark: { pos?: number; id: string; n: number; kind: 'start' | 'next'; epoch: number }): void;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

async function makeRig(opts: Partial<AlbumPlayerOptions> & { storage?: MemStorage; ctx?: FakeCtx; tracks?: AlbumTrack[] } = {}): Promise<Rig> {
  const ctx = opts.ctx ?? fakeContext();
  const worker = new FWorker();
  const nodes: FPlayNode[] = [];
  const storage = opts.storage ?? new MemStorage();
  const out = new FGain(ctx);
  const tracks = opts.tracks ?? TRACKS;
  const player = new AlbumPlayer(ctx as unknown as BaseAudioContext, out as unknown as AudioNode, {
    storage,
    rng: rngOf(5),
    makeWorker: () => worker,
    makeNode: async () => {
      const nd = new FPlayNode();
      nodes.push(nd);
      return nd;
    },
    makeChannel: () => ({ port1: {} as MessagePort, port2: {} as MessagePort }),
    ...opts,
  });
  const heard: (NowPlaying | null)[] = [];
  player.onTrack = (np) => heard.push(np);
  const rig: Rig = {
    ctx,
    player,
    worker,
    nodes,
    storage,
    heard,
    out,
    node: () => nodes[nodes.length - 1],
    ready: () => worker.emit({ type: 'ready', album: tracks, name: 'Vol. T' }),
    heardTrack: (m) => rig.node().emit({ type: 'track', mark: { pos: 0, ...m } }),
  };
  return rig;
}

/** The player's fade stage and duck stage: the two gains it made first. */
const fadeOf = (r: Rig): FGain => r.ctx.gains[0];
const duckOf = (r: Rig): FGain => r.ctx.gains[1];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ── the ramps ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('gain ramps', () => {
  it('rampParam builds a smooth curve from where the param is to the target, in short linear steps', () => {
    const ctx = fakeContext();
    const p = new FParam(ctx, 0.2);
    rampParam(ctx as unknown as BaseAudioContext, p as unknown as AudioParam, 1, 1.5);
    const r = p.ramp();
    expect(r).toHaveLength(32);
    expect(r[r.length - 1]).toMatchObject({ v: 1, t: 1.5 });
    for (let i = 1; i < r.length; i++) expect(r[i].v).toBeGreaterThan(r[i - 1].v);
    expect(p.at(0)).toBeCloseTo(0.2, 6);
    expect(p.at(0.75)).toBeCloseTo(0.2 + 0.8 * smooth(0.5), 2);
    expect(p.at(2)).toBe(1);
    // gentle at both ends: the first step is far smaller than the middle ones
    expect(r[0].v - 0.2).toBeLessThan((r[15].v - r[14].v) * 1.0);
  });

  it('a ramp that interrupts another starts from the value the first had reached (no jump)', () => {
    const ctx = fakeContext();
    const p = new FParam(ctx, 0);
    rampParam(ctx as unknown as BaseAudioContext, p as unknown as AudioParam, 1, 1.5);
    ctx.advance(0.6);
    const mid = p.value;
    expect(mid).toBeGreaterThan(0.1);
    expect(mid).toBeLessThan(0.9);
    rampParam(ctx as unknown as BaseAudioContext, p as unknown as AudioParam, 0, 1.5);
    expect(p.value).toBeCloseTo(mid, 6);
    ctx.advance(0.75);
    expect(p.value).toBeLessThan(mid);
    ctx.advance(1);
    expect(p.value).toBe(0);
  });
});

// ── the life cycle ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('album player', () => {
  it('prime builds the worker and the worklet and begins a session silently; start fades it in', async () => {
    const r = await makeRig();
    r.player.prime();
    await flush();
    expect(r.nodes).toHaveLength(1);
    const init = r.worker.of('init')[0];
    expect(init.sampleRate).toBe(SR);
    expect(r.node().of('link')).toHaveLength(1);
    expect(r.worker.of('start')).toHaveLength(0); // (waits for the worker to say it has the album)
    r.ready();
    const start = r.worker.of('start');
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({ n: 0, epoch: 1, session: 1 });
    expect(TRACKS.map((t) => t.id)).toContain(start[0].id);
    const q = r.worker.of('queue')[0];
    expect(q.base).toBe(1);
    expect(q.ids).toHaveLength(4);
    // (the first song and the four queued after it are one whole bag of the five songs: all different)
    expect(new Set([start[0].id, ...q.ids]).size).toBe(5);
    expect(q.ids[0]).not.toBe(start[0].id);
    // silent until started
    expect(r.node().of('play')).toHaveLength(0);
    expect(fadeOf(r).gain.value).toBe(0);
    r.player.start();
    expect(r.node().of('play')).toHaveLength(1);
    const ramp = fadeOf(r).gain.ramp();
    expect(ramp[ramp.length - 1]).toMatchObject({ v: 1, t: ALBUM_FADE_IN_S });
    r.ctx.advance(ALBUM_FADE_IN_S + 0.1);
    expect(fadeOf(r).gain.value).toBe(1);
    // no second session for a second start (a restart keeps the song)
    r.player.start();
    expect(r.worker.of('start')).toHaveLength(1);
    expect(r.node().of('play')).toHaveLength(1);
  });

  it('start without prime builds everything and plays once the worker is ready', async () => {
    const r = await makeRig();
    r.player.start();
    await flush();
    expect(r.node().of('play')).toHaveLength(0);
    r.ready();
    expect(r.worker.of('start')).toHaveLength(1);
    expect(r.node().of('play')).toHaveLength(1);
    expect(r.player.active).toBe(true);
  });

  it('announces a song when the worklet reports it heard, with its title, genre and the album name', async () => {
    const r = await makeRig();
    r.player.start();
    await flush();
    r.ready();
    const first = r.worker.of('start')[0];
    r.heardTrack({ id: first.id, n: 0, kind: 'start', epoch: 1 });
    expect(r.heard).toHaveLength(1);
    const t = TRACKS.find((x) => x.id === first.id)!;
    expect(r.heard[0]).toEqual({ id: t.id, title: t.title, genre: t.genre, album: 'Vol. T' });
    expect(r.player.track).toEqual(r.heard[0]);
  });

  it('commits a song the album went on to by itself when it is heard, and sends the queue again', async () => {
    const r = await makeRig();
    r.player.start();
    await flush();
    r.ready();
    const first = r.worker.of('start')[0];
    r.heardTrack({ id: first.id, n: 0, kind: 'start', epoch: 1 });
    const q1 = r.worker.of('queue')[0];
    r.heardTrack({ id: q1.ids[0], n: 1, kind: 'next', epoch: 1 });
    const q2 = r.worker.of('queue');
    expect(q2).toHaveLength(2);
    expect(q2[1].base).toBe(2);
    expect(q2[1].ids[0]).toBe(q1.ids[1]);
    expect(r.player.track?.id).toBe(q1.ids[0]);
    // what is kept: the next session starts after this one
    const saved = JSON.parse(r.storage.getItem(BAG_KEY)!) as { q: string[]; last: string };
    expect(saved.last).toBe(q1.ids[0]);
    expect(saved.q[0]).toBe(q1.ids[1]);
  });

  it('plays the album once through before any song twice, and never one twice in a row, over a long session', async () => {
    const r = await makeRig();
    r.player.start();
    await flush();
    r.ready();
    const order = [r.worker.of('start')[0].id];
    r.heardTrack({ id: order[0], n: 0, kind: 'start', epoch: 1 });
    for (let k = 1; k < 17; k++) {
      const q = r.worker.of('queue');
      const id = q[q.length - 1].ids[0];
      order.push(id);
      r.heardTrack({ id, n: k, kind: 'next', epoch: 1 });
    }
    for (let b = 0; b < 3; b++) expect(new Set(order.slice(b * 5, b * 5 + 5)).size).toBe(5);
    for (let i = 1; i < order.length; i++) expect(order[i]).not.toBe(order[i - 1]);
  });

  it('skips: a cut for the worklet, a skip for the worker, the next song of the bag, committed at once', async () => {
    const r = await makeRig();
    r.player.start();
    await flush();
    r.ready();
    const first = r.worker.of('start')[0];
    r.heardTrack({ id: first.id, n: 0, kind: 'start', epoch: 1 });
    const q = r.worker.of('queue')[0];
    r.player.skip();
    const cut = r.node().of('cut');
    const skip = r.worker.of('skip');
    expect(cut).toEqual([{ type: 'cut', epoch: 2, frames: Math.round(ALBUM_SKIP_FADE_S * SR) }]);
    expect(skip).toEqual([{ type: 'skip', epoch: 2, id: q.ids[0], n: 1, frames: Math.round(ALBUM_SKIP_FADE_S * SR) }]);
    // the queue the worker is told next starts after the song skipped to
    const qs = r.worker.of('queue');
    expect(qs[qs.length - 1].base).toBe(2);
    expect(qs[qs.length - 1].ids[0]).toBe(q.ids[1]);
    // a leftover of the old line (epoch 1) is ignored; the new song's start is announced and not committed twice
    r.heardTrack({ id: q.ids[1], n: 1, kind: 'next', epoch: 1 });
    expect(r.player.track?.id).toBe(first.id);
    r.heardTrack({ id: q.ids[0], n: 1, kind: 'start', epoch: 2 });
    expect(r.player.track?.id).toBe(q.ids[0]);
    expect(r.worker.of('queue')).toHaveLength(qs.length);
  });

  it('skips through the bag when the button is mashed: each press the next song, no repeats', async () => {
    const r = await makeRig();
    r.player.start();
    await flush();
    r.ready();
    const first = r.worker.of('start')[0];
    r.heardTrack({ id: first.id, n: 0, kind: 'start', epoch: 1 });
    const want = r.worker.of('queue')[0].ids.slice(0, 3);
    r.player.skip();
    r.player.skip();
    r.player.skip();
    expect(r.worker.of('skip').map((s) => [s.id, s.n, s.epoch])).toEqual([
      [want[0], 1, 2],
      [want[1], 2, 3],
      [want[2], 3, 4],
    ]);
  });

  it('ignores a skip before anything plays and after the music was stopped', async () => {
    const r = await makeRig();
    r.player.skip();
    r.player.prime();
    await flush();
    r.ready();
    r.player.skip(); // primed, not playing
    expect(r.worker.of('skip')).toHaveLength(0);
    r.player.start();
    r.player.stop();
    r.player.skip(); // fading out
    expect(r.worker.of('skip')).toHaveLength(0);
  });

  it('stop fades out over 1.5 s, then lets go of the worklet and the worker; a later start is a new session with the next song', async () => {
    const r = await makeRig();
    r.player.start();
    await flush();
    r.ready();
    const first = r.worker.of('start')[0];
    r.heardTrack({ id: first.id, n: 0, kind: 'start', epoch: 1 });
    r.ctx.advance(ALBUM_FADE_IN_S + 0.1);
    r.player.stop();
    expect(r.heard[r.heard.length - 1]).toBeNull();
    const ramp = fadeOf(r).gain.ramp();
    expect(ramp[ramp.length - 1]).toMatchObject({ v: 0, t: r.ctx.currentTime + ALBUM_FADE_OUT_S });
    // still up while it fades
    vi.advanceTimersByTime(1000);
    expect(r.node().disposed).toBe(false);
    r.ctx.advance(ALBUM_FADE_OUT_S + 0.1);
    vi.advanceTimersByTime(800);
    expect(r.node().disposed).toBe(true);
    expect(r.worker.of('stop')).toHaveLength(1);
    expect(r.worker.terminated).toBe(false); // (the worker stays up, asleep)
    expect(fadeOf(r).gain.value).toBe(0);
    // another drive: a new worklet, a new session, the song after the last one
    const queued = r.worker.of('queue');
    const next = queued[queued.length - 1].ids[0];
    r.player.start();
    await flush();
    r.ready();
    expect(r.nodes).toHaveLength(2);
    const start2 = r.worker.of('start');
    expect(start2).toHaveLength(2);
    expect(start2[1]).toMatchObject({ session: 2, id: next, n: 0 });
    expect(start2[1].id).not.toBe(first.id);
  });

  it('a start in the middle of a stop brings the same song back (no new session)', async () => {
    const r = await makeRig();
    r.player.start();
    await flush();
    r.ready();
    const first = r.worker.of('start')[0];
    r.heardTrack({ id: first.id, n: 0, kind: 'start', epoch: 1 });
    r.ctx.advance(ALBUM_FADE_IN_S + 0.1);
    r.player.stop();
    r.ctx.advance(0.6);
    const mid = fadeOf(r).gain.value;
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(0.95);
    r.player.start();
    expect(fadeOf(r).gain.value).toBeCloseTo(mid, 6); // from where it had got to
    vi.advanceTimersByTime(3000);
    expect(r.node().disposed).toBe(false);
    expect(r.worker.of('start')).toHaveLength(1);
    expect(r.player.track?.id).toBe(first.id);
    r.ctx.advance(ALBUM_FADE_IN_S + 0.1);
    expect(fadeOf(r).gain.value).toBe(1);
  });

  it('stopping a primed session that never played lets go at once', async () => {
    const r = await makeRig();
    r.player.prime();
    await flush();
    r.ready();
    r.player.stop();
    expect(r.node().disposed).toBe(true);
    expect(r.worker.of('stop')).toHaveLength(1);
  });

  it('stopping while the worklet is still being made cancels the boot', async () => {
    let resolveNode: (n: PlayNode) => void = () => undefined;
    const late = new FPlayNode();
    const r = await makeRig({ makeNode: () => new Promise<PlayNode>((res) => (resolveNode = res)) });
    r.player.start();
    r.player.stop();
    resolveNode(late);
    await flush();
    expect(late.to).toHaveLength(0); // disconnected
    expect(r.worker.of('init')).toHaveLength(0);
    expect(r.worker.of('start')).toHaveLength(0);
  });

  it('the pause menu ducks it by 10 dB and brings it back, smoothly', async () => {
    const r = await makeRig();
    r.player.start();
    await flush();
    r.ready();
    r.ctx.advance(2);
    r.player.setDucked(true);
    const ramp = duckOf(r).gain.ramp();
    expect(ramp[ramp.length - 1].v).toBeCloseTo(ALBUM_DUCK_GAIN, 6);
    expect(20 * Math.log10(ALBUM_DUCK_GAIN)).toBeCloseTo(-10, 6);
    r.ctx.advance(0.2);
    const mid = duckOf(r).gain.value;
    expect(mid).toBeLessThan(1);
    expect(mid).toBeGreaterThan(ALBUM_DUCK_GAIN);
    r.ctx.advance(0.5);
    expect(duckOf(r).gain.value).toBeCloseTo(ALBUM_DUCK_GAIN, 6);
    r.player.setDucked(false);
    r.ctx.advance(0.6);
    expect(duckOf(r).gain.value).toBe(1);
  });

  it('does not swell on the way out when the pause menu is left to quit', async () => {
    const r = await makeRig();
    r.player.start();
    await flush();
    r.ready();
    r.ctx.advance(2);
    r.player.setDucked(true);
    r.ctx.advance(1);
    r.player.stop(); // quit from the pause menu...
    r.player.setDucked(false); // ...which resumes first
    r.ctx.advance(0.5);
    expect(duckOf(r).gain.value).toBeCloseTo(ALBUM_DUCK_GAIN, 6);
    r.ctx.advance(2);
    vi.advanceTimersByTime(2000);
    // and the next drive starts at the right level
    expect(duckOf(r).gain.value).toBe(1);
  });

  it('gives up for the session when the worker fails, and says nothing more', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await makeRig();
    r.player.start();
    await flush();
    r.ready();
    r.worker.onerror?.({ message: 'boom' } as ErrorEvent);
    expect(r.player.active).toBe(false);
    expect(r.node().disposed).toBe(true);
    expect(r.worker.terminated).toBe(true);
    expect(r.heard[r.heard.length - 1]).toBeNull();
    r.player.start();
    r.player.skip();
    r.player.prime();
    await flush();
    expect(r.nodes).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('gives up cleanly when the worklet cannot be made, and when the album is empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = await makeRig({
      makeNode: () => Promise.reject(new Error('no AudioWorklet')),
    });
    bad.player.start();
    await flush();
    expect(bad.player.active).toBe(false);
    const warned = warn.mock.calls.length;
    const empty = await makeRig({ tracks: [] });
    empty.player.start();
    await flush();
    empty.ready();
    expect(empty.player.active).toBe(false);
    expect(empty.worker.of('start')).toHaveLength(0);
    // (an album with no songs in it is not an error: nothing is said about it)
    expect(warn.mock.calls.length).toBe(warned);
    warn.mockRestore();
  });

  it('relays the worker\'s trouble and its cost, and keeps the worklet\'s last figures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await makeRig();
    r.player.start();
    await flush();
    r.ready();
    r.worker.emit({ type: 'error', message: 'track x: broken' });
    expect(r.player.errors).toBe(1);
    expect(r.player.active).toBe(true);
    r.worker.emit({ type: 'load', frames: SR * 10, ms: 1000 });
    expect(r.player.xRealtime).toBeCloseTo(10, 6);
    r.node().emit({ type: 'stats', played: 100, fill: SR * 7, underruns: 0, overruns: 0, rms: 0.1, peak: 0.3, playing: true });
    expect(r.player.buffered).toBeCloseTo(7, 6);
    expect(r.player.minFill).toBe(SR * 7);
    warn.mockRestore();
  });

  it('works without any storage', async () => {
    const r = await makeRig({ storage: null as unknown as MemStorage });
    r.player.start();
    await flush();
    r.ready();
    expect(r.worker.of('start')).toHaveLength(1);
  });

  it('the next session carries on from the bag a previous one left in storage', async () => {
    const storage = new MemStorage();
    const r1 = await makeRig({ storage });
    r1.player.start();
    await flush();
    r1.ready();
    const first = r1.worker.of('start')[0];
    r1.heardTrack({ id: first.id, n: 0, kind: 'start', epoch: 1 });
    const next = r1.worker.of('queue')[0].ids;
    r1.player.dispose();
    const r2 = await makeRig({ storage, rng: rngOf(77) });
    r2.player.start();
    await flush();
    r2.ready();
    expect(r2.worker.of('start')[0].id).toBe(next[0]);
    expect(r2.worker.of('queue')[0].ids[0]).toBe(next[1]);
  });
});

// ── in the audio system ───────────────────────────────────────────────────────────────────────────────────────────────

describe('race music in the audio system', () => {
  async function makeSystem(raceMusic = 0.45, state = 'running') {
    const ctx = fakeContext(state);
    const worker = new FWorker();
    const nodes: FPlayNode[] = [];
    const made = { workers: 0 };
    const storage = new MemStorage();
    const sys = createAudioSystemOn(ctx as unknown as BaseAudioContext, { ...DEFAULT_SETTINGS.audio, raceMusic }, {
      storage,
      rng: rngOf(3),
      makeWorker: () => {
        made.workers++;
        return worker;
      },
      makeNode: async () => {
        const n = new FPlayNode();
        nodes.push(n);
        return n;
      },
      makeChannel: () => ({ port1: {} as MessagePort, port2: {} as MessagePort }),
    });
    const heard: (NowPlaying | null)[] = [];
    sys.setAlbumListener((np) => heard.push(np));
    const internals = sys as unknown as { menuApplied: boolean; albumApplied: boolean; driving: boolean; album: AlbumPlayer | null };
    return { ctx, sys, worker, nodes, made, heard, internals };
  }
  const cleanup: { dispose(): void }[] = [];
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!.dispose();
  });

  it('the menu theme plays on the menus and no album is made', async () => {
    const s = await makeSystem();
    cleanup.push(s.sys);
    s.sys.setMusic(true);
    expect(s.internals.menuApplied).toBe(true);
    expect(s.internals.albumApplied).toBe(false);
    expect(s.internals.album).toBeNull();
    expect(s.made.workers).toBe(0);
  });

  it('driving brings the album in and sends the menu theme out; the way back swaps them again', async () => {
    const s = await makeSystem();
    cleanup.push(s.sys);
    s.sys.setMusic(true);
    s.sys.setMusic(false); // (startRace)
    expect(s.internals.menuApplied).toBe(false);
    s.sys.primeAlbum();
    await flush();
    s.worker.emit({ type: 'ready', album: TRACKS, name: 'Vol. T' });
    expect(s.nodes[0].of('play')).toHaveLength(0);
    s.sys.setDriving(true);
    expect(s.internals.albumApplied).toBe(true);
    expect(s.nodes[0].of('play')).toHaveLength(1);
    const first = s.worker.of('start')[0];
    s.nodes[0].emit({ type: 'track', mark: { pos: 0, id: first.id, n: 0, kind: 'start', epoch: 1 } });
    expect(s.heard[s.heard.length - 1]?.title).toMatch(/^Song/);
    // the results screen asks for the menu theme: it stays out while the album plays
    s.sys.setMusic(true);
    expect(s.internals.menuApplied).toBe(false);
    s.sys.setMusic(false); // (the replay)
    s.sys.setMusic(true);
    expect(s.internals.menuApplied).toBe(false);
    expect(s.internals.albumApplied).toBe(true);
    // back to the menus
    s.sys.setDriving(false);
    expect(s.internals.albumApplied).toBe(false);
    expect(s.internals.menuApplied).toBe(true);
    expect(s.heard[s.heard.length - 1]).toBeNull();
  });

  it('with the Race music slider at 0 no album is ever made, and the menu theme keeps the results screen as it always had', async () => {
    const s = await makeSystem(0);
    cleanup.push(s.sys);
    s.sys.setMusic(true);
    s.sys.setMusic(false); // startRace
    s.sys.primeAlbum();
    s.sys.setDriving(true);
    await flush();
    expect(s.made.workers).toBe(0);
    expect(s.internals.albumApplied).toBe(false);
    expect(s.internals.menuApplied).toBe(false); // (a race: no music at all)
    s.sys.setMusic(true); // the results
    expect(s.internals.menuApplied).toBe(true);
    s.sys.setMusic(false); // the replay
    expect(s.internals.menuApplied).toBe(false);
  });

  it('the slider follows live: leaving 0 mid-drive starts the album, reaching 0 stops it and the theme is not forced back', async () => {
    const s = await makeSystem(0);
    cleanup.push(s.sys);
    s.sys.setDriving(true);
    expect(s.internals.albumApplied).toBe(false);
    s.sys.setVolumes({ ...DEFAULT_SETTINGS.audio, raceMusic: 0.5 });
    await flush();
    expect(s.internals.albumApplied).toBe(true);
    expect(s.made.workers).toBe(1);
    s.worker.emit({ type: 'ready', album: TRACKS, name: 'Vol. T' });
    expect(s.nodes[0].of('play')).toHaveLength(1);
    s.sys.setVolumes({ ...DEFAULT_SETTINGS.audio, raceMusic: 0.6 }); // (a slider tick: nothing restarts)
    expect(s.worker.of('start')).toHaveLength(1);
    s.sys.setVolumes({ ...DEFAULT_SETTINGS.audio, raceMusic: 0 });
    expect(s.internals.albumApplied).toBe(false);
    expect(s.internals.menuApplied).toBe(false);
  });

  it('the Race music slider has a stage of its own: the album does not go through the menu theme\'s volume', async () => {
    const s = await makeSystem(0.45);
    cleanup.push(s.sys);
    const graph = (s.sys as unknown as { graph: { raceMusicBus: FGain; musicBus: FGain } }).graph;
    expect(graph.raceMusicBus).not.toBe(graph.musicBus);
    expect(graph.raceMusicBus.gain.value).toBeCloseTo(0.45 * 0.45, 6);
    expect(graph.musicBus.gain.value).toBeCloseTo(0.5 * 0.5, 6);
    s.sys.setVolumes({ ...DEFAULT_SETTINGS.audio, raceMusic: 0.9, music: 0.1 });
    s.ctx.advance(2);
    const rm = graph.raceMusicBus.gain.value;
    expect(rm).toBeCloseTo(0.81, 2);
    expect(graph.musicBus.gain.value).toBeCloseTo(0.01, 2);
  });

  it('the pause ducks the album, and a skip asks for the next song', async () => {
    const s = await makeSystem();
    cleanup.push(s.sys);
    s.sys.setDriving(true);
    await flush();
    s.worker.emit({ type: 'ready', album: TRACKS, name: 'Vol. T' });
    const first = s.worker.of('start')[0];
    s.nodes[0].emit({ type: 'track', mark: { pos: 0, id: first.id, n: 0, kind: 'start', epoch: 1 } });
    s.sys.setPaused(true);
    // (the album's duck stage is the one that feeds the Race music bus)
    const bus = (s.sys as unknown as { graph: { raceMusicBus: FGain } }).graph.raceMusicBus;
    const duck = s.ctx.gains.find((g) => g.to.includes(bus))!;
    expect(duck.gain.ramp().pop()?.v).toBeCloseTo(ALBUM_DUCK_GAIN, 6);
    s.ctx.advance(0.6);
    expect(duck.gain.value).toBeCloseTo(ALBUM_DUCK_GAIN, 6);
    s.sys.skipTrack();
    expect(s.worker.of('skip')).toHaveLength(1);
    s.sys.setPaused(false);
    s.ctx.advance(0.6);
    expect(duck.gain.value).toBe(1);
    // (a pause and a resume in the same instant leave it at full level, not stuck halfway)
    s.sys.setPaused(true);
    s.sys.setPaused(false);
    s.ctx.advance(1);
    expect(duck.gain.value).toBe(1);
  });

  it('waits for the context to run: the stream is built and the audio is unlocked', async () => {
    const s = await makeSystem(0.45, 'suspended');
    cleanup.push(s.sys);
    s.sys.setDriving(true);
    await flush();
    expect(s.made.workers).toBe(1); // built and buffering already
    expect(s.internals.albumApplied).toBe(true);
  });
});
