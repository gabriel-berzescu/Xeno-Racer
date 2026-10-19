/**
 * The race music, main-thread side: the album that plays, shuffled, whenever someone drives.
 *
 *   worker   (album.worker.ts)   renders the tracks a few seconds ahead of the playhead and mixes them into one stream
 *      |  PCM over a MessageChannel, never through this thread
 *   worklet  (album.worklet.ts)  a ring buffer on the audio thread: plays the stream, reports the playhead and the track being heard
 *      |
 *   fade -> duck -> dest         two gain stages of this class: the fade in and out, and the pause menu's duck; `dest` is the
 *                                graph's raceMusicBus, which carries the Race music slider
 *
 * This class decides what plays and when: the shuffle bag (album-shuffle.ts), which track follows, the skips, the fades. It does
 * next to nothing per frame: it has no tick at all, only messages from the two threads and a timer at the end of a fade-out.
 *
 * Life cycle. `prime()` (behind the loading screen) gets the worker, the worklet and the first seconds of the first track ready
 * without a sound; `start()` (as the race begins) fades them in; `stop()` fades out and then lets go of the worklet, the worker
 * stays up, asleep. A `start()` while a session is up does not begin a new one: a restart keeps the song that is playing.
 * Where anything fails (no AudioWorklet, no Worker, the worker throws) the album gives up for the rest of the session and the
 * game goes on without it.
 *
 * Song changes are told to `onTrack` when they are HEARD (the worklet reports the playhead passing the mark), which is what the
 * card on the HUD and the pause menu show.
 */
import type { NowPlaying } from '../core/contracts';
import type { AlbumTrack } from './album';
import type { NodeIn, NodeOut, PlaybackStats, WorkerIn, WorkerOut } from './album-protocol';
import { type BagStorage, type Rng, ShuffleBag, defaultStorage, loadBag, saveBag } from './album-shuffle';
import { SKIP_FADE_SECONDS } from './album-stream';
import albumWorkletUrl from './album.worklet.ts?worker&url';

/** Fade in when the music starts, fade out when it stops (s). */
/** The songs of the first build with music (1.0.0 + Vol. 1's first five): its saved shuffle orders do not list the album they were made for. */
export const FIRST_RELEASE: readonly string[] = ['redline-protocol', 'third-eye-highway', 'slipstream', 'flat-out', 'black-ice-circuit'];

export const ALBUM_FADE_IN_S = 1.5;
export const ALBUM_FADE_OUT_S = 1.5;
/** A skip fades the old track out over this long, and the new one in over as long again (s): the streamer's own fade-in, see album-stream.ts. */
export const ALBUM_SKIP_FADE_S = SKIP_FADE_SECONDS;
/** The pause menu: the music drops by this much, over about this long (dB, s). */
export const ALBUM_DUCK_DB = -10;
export const ALBUM_DUCK_S = 0.4;
export const ALBUM_DUCK_GAIN = Math.pow(10, ALBUM_DUCK_DB / 20);

// ── the parts of the browser it needs, so that the tests can stand in for them ─────────────────────────────────────────

/** The part of a Worker the player uses. */
export interface WorkerLike {
  postMessage(m: WorkerIn, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<WorkerOut>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

/** The part of an AudioWorkletNode the player uses. */
export interface PlayNode {
  readonly port: {
    postMessage(m: NodeIn, transfer?: Transferable[]): void;
    onmessage: ((e: MessageEvent<NodeOut>) => void) | null;
  };
  connect(dest: AudioNode): unknown;
  disconnect(): void;
}

export interface AlbumPlayerOptions {
  /** Where the shuffle bag is kept (localStorage by default; null: nowhere). */
  storage?: BagStorage | null;
  rng?: Rng;
  makeWorker?(): WorkerLike;
  makeNode?(ctx: BaseAudioContext): Promise<PlayNode>;
  makeChannel?(): { port1: MessagePort; port2: MessagePort };
}

const moduleLoads = new WeakMap<BaseAudioContext, Promise<void>>();

/** The worklet module of the album, once per context. */
function loadModule(ctx: BaseAudioContext): Promise<void> {
  let p = moduleLoads.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(albumWorkletUrl);
    moduleLoads.set(ctx, p);
  }
  return p;
}

async function defaultNode(ctx: BaseAudioContext): Promise<PlayNode> {
  await loadModule(ctx);
  return new AudioWorkletNode(ctx, 'xr-album', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] }) as unknown as PlayNode;
}

function defaultWorker(): WorkerLike {
  return new Worker(new URL('./album.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}

// ── gain ramps ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A smooth 0..1 curve (raised cosine): gentle at both ends, so a fade has no corner to hear. */
export const smooth = (x: number): number => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));

/**
 * Take `p` from where it is to `to` over `seconds`, along a smooth curve. Built from short linear ramps (not setValueCurveAtTime /
 * setTargetAtTime, which a later cancelScheduledValues snaps back from): the ramp can be interrupted at any moment and the next one
 * starts from the value the first had reached.
 */
export function rampParam(ctx: BaseAudioContext, p: AudioParam, to: number, seconds: number, steps = 32): void {
  const t = ctx.currentTime;
  const from = p.value;
  p.cancelScheduledValues(t);
  p.setValueAtTime(from, t);
  if (seconds <= 0 || from === to) {
    p.setValueAtTime(to, t + Math.max(0, seconds));
    return;
  }
  for (let i = 1; i <= steps; i++) p.linearRampToValueAtTime(from + (to - from) * smooth(i / steps), t + (seconds * i) / steps);
}

// ── the player ──────────────────────────────────────────────────────────────────────────────────────────────────────

export class AlbumPlayer {
  /** Told when a song starts to be heard, and with null when the music stops. */
  onTrack: ((np: NowPlaying | null) => void) | null = null;
  /** Told once when the album gives up for the session (no worklet, no worker, the worker died): the menu theme may have the music again. */
  onFail: (() => void) | null = null;
  /** The worklet's last report (debugging, and the figures QA looks at). */
  stats: PlaybackStats | null = null;
  /** The worker's last report: the audio it rendered over the time it took (x real time). */
  xRealtime = 0;
  /** The smallest buffer the worklet has reported while playing, in frames. */
  minFill = Infinity;
  /** Times the worker reported trouble. */
  errors = 0;

  private readonly fade: GainNode;
  private readonly duck: GainNode;
  private readonly storage: BagStorage | null;
  private readonly rng: Rng;
  private worker: WorkerLike | null = null;
  private node: PlayNode | null = null;
  private tracks: AlbumTrack[] = [];
  private byId = new Map<string, AlbumTrack>();
  private albumName = '';
  private bag: ShuffleBag | null = null;
  private current: NowPlaying | null = null;
  /** Playing was asked for (start) and not undone (stop). */
  private wanted = false;
  private ducked = false;
  /** The level the duck stage is going to (or is at). */
  private duckTo = 1;
  private booting = false;
  private sessionUp = false;
  private playing = false;
  private failed = false;
  private disposed = false;
  /** Counts boots and teardowns: a boot that finds it changed has been cancelled. */
  private gen = 0;
  private session = 0;
  /** Counts starts and skips: events of an older epoch are leftovers. */
  private epoch = 0;
  /** Tracks committed in this session (the next one's ordinal). */
  private seq = 0;
  private stopTimer: ReturnType<typeof setTimeout> | 0 = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    dest: AudioNode,
    private readonly o: AlbumPlayerOptions = {},
  ) {
    this.fade = ctx.createGain();
    this.fade.gain.value = 0;
    this.duck = ctx.createGain();
    this.duck.gain.value = 1;
    this.fade.connect(this.duck);
    this.duck.connect(dest);
    this.storage = o.storage === undefined ? defaultStorage() : o.storage;
    this.rng = o.rng ?? Math.random;
  }

  /** The song being heard, or null. */
  get track(): NowPlaying | null {
    return this.current;
  }

  /** The music is on (asked for, and not given up on). */
  get active(): boolean {
    return this.wanted && !this.failed;
  }

  /** It has given up for this session. */
  get isFailed(): boolean {
    return this.failed;
  }

  /** Seconds of music buffered ahead of the playhead, as of the last report. */
  get buffered(): number {
    return this.stats ? this.stats.fill / this.ctx.sampleRate : 0;
  }

  /**
   * Get ready without a sound (behind the loading screen): the worker and the worklet are up and the first seconds of the first
   * track are rendered, so that `start()` is instant and has nothing to catch up with.
   */
  prime(): void {
    if (this.disposed || this.failed) return;
    this.boot();
  }

  /** The music begins, or comes back: it fades in over 1.5 s. A session in progress goes on (the song is not restarted). */
  start(): void {
    if (this.disposed || this.failed) return;
    const was = this.wanted;
    this.wanted = true;
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = 0;
    }
    this.syncDuck();
    if (this.sessionUp) {
      if (this.playing) {
        rampParam(this.ctx, this.fade.gain, 1, ALBUM_FADE_IN_S); // (it was fading out: back in, from wherever it had got to)
        if (!was && this.lastTrack) this.setCurrent(this.lastTrack.id);
      } else this.engage();
    } else this.boot();
  }

  /** The music stops: it fades out over 1.5 s, and the worklet is let go of after that. */
  stop(): void {
    if (!this.wanted && !this.booting && !this.sessionUp) return;
    this.wanted = false;
    this.setCurrent(null);
    if (!this.playing) {
      this.teardown();
      return;
    }
    rampParam(this.ctx, this.fade.gain, 0, ALBUM_FADE_OUT_S);
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      this.stopTimer = 0;
      if (!this.wanted) this.teardown();
    }, ALBUM_FADE_OUT_S * 1000 + 150);
  }

  /** Skip to the next song of the bag, with a short fade. */
  skip(): void {
    if (!this.sessionUp || !this.playing || !this.wanted || !this.bag || !this.worker || !this.node) return;
    const id = this.bag.take();
    if (id === null) return;
    saveBag(this.bag, this.storage);
    const n = this.seq++;
    this.epoch++;
    const frames = Math.round(ALBUM_SKIP_FADE_S * this.ctx.sampleRate);
    this.node.port.postMessage({ type: 'cut', epoch: this.epoch, frames });
    this.worker.postMessage({ type: 'skip', epoch: this.epoch, id, n, frames });
    this.sendQueue();
  }

  /** The pause menu: the music drops by 10 dB (smoothly), and comes back. */
  setDucked(on: boolean): void {
    this.ducked = on;
    // (while it fades out for good -- a quit from the pause menu -- the level is left alone: it must not swell on the way out)
    if (!this.wanted && this.sessionUp) return;
    this.syncDuck();
  }

  private syncDuck(): void {
    const to = this.ducked ? ALBUM_DUCK_GAIN : 1;
    // (compared with where the last ramp was sent, not with the param's value: that is as of the last render quantum and a ramp
    // asked for a moment ago has not moved it yet)
    if (to === this.duckTo) return;
    this.duckTo = to;
    rampParam(this.ctx, this.duck.gain, to, ALBUM_DUCK_S, 16);
  }

  get isDucked(): boolean {
    return this.ducked;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.wanted = false;
    this.teardown();
    try {
      this.worker?.terminate();
    } catch {
      /* gone already */
    }
    this.worker = null;
    this.fade.disconnect();
    this.duck.disconnect();
  }

  // ── bringing it up ─────────────────────────────────────────────────────────────────────────────────────────────────

  private lastTrack: NowPlaying | null = null;

  private boot(): void {
    if (this.booting || this.sessionUp) return;
    this.booting = true;
    const gen = ++this.gen;
    void this.bootAsync(gen);
  }

  private async bootAsync(gen: number): Promise<void> {
    try {
      const worker = this.ensureWorker();
      const node = await (this.o.makeNode ?? defaultNode)(this.ctx);
      if (gen !== this.gen || this.disposed) {
        node.disconnect();
        return;
      }
      this.node = node;
      node.connect(this.fade as unknown as AudioNode);
      node.port.onmessage = (e): void => this.onNode(e.data);
      // one end of a channel to the worklet, the other to the worker: the PCM goes between them and never through here
      const ch = this.o.makeChannel ? this.o.makeChannel() : new MessageChannel();
      node.port.postMessage({ type: 'link', port: ch.port1 }, [ch.port1]);
      worker.postMessage({ type: 'init', sampleRate: this.ctx.sampleRate, port: ch.port2 }, [ch.port2]);
      // (the worker answers with the album, and the session begins then: see onWorker)
    } catch (e) {
      this.fail('could not start', e);
    }
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const w = (this.o.makeWorker ?? defaultWorker)();
    w.onmessage = (e): void => this.onWorker(e.data);
    w.onerror = (e): void => this.fail('the worker failed', e.message ?? e);
    this.worker = w;
    return w;
  }

  private onWorker(m: WorkerOut): void {
    switch (m.type) {
      case 'ready':
        this.tracks = m.album;
        this.byId = new Map(m.album.map((t) => [t.id, t]));
        this.albumName = m.name;
        this.beginSession();
        break;
      case 'error':
        this.errors++;
        console.warn('[album]', m.message);
        break;
      case 'load':
        this.xRealtime = m.ms > 0 ? m.frames / this.ctx.sampleRate / (m.ms / 1000) : 0;
        break;
    }
  }

  /** The worker has read the album and the worklet is linked: begin a stream with the next track of the bag. */
  private beginSession(): void {
    if (!this.node || !this.worker || this.sessionUp || this.disposed) return;
    if (this.tracks.length === 0) {
      // (no songs in the album yet: not an error, there is just nothing to play)
      this.fail('the album has no tracks', undefined, true);
      return;
    }
    this.bag = loadBag(
      this.tracks.map((t) => t.id),
      this.storage,
      this.rng,
      FIRST_RELEASE, // a save from the first build with music does not list its album: it had these five songs
    );
    const first = this.bag.take();
    if (first === null) return;
    saveBag(this.bag, this.storage);
    this.session++;
    this.epoch++;
    this.seq = 1;
    this.booting = false;
    this.sessionUp = true;
    this.minFill = Infinity;
    this.worker.postMessage({ type: 'start', session: this.session, epoch: this.epoch, id: first, n: 0 });
    this.sendQueue();
    if (this.wanted) this.engage();
  }

  /** The music is wanted and the stream is up: let the worklet play, and fade in. */
  private engage(): void {
    if (!this.node || this.playing) return;
    this.playing = true;
    this.node.port.postMessage({ type: 'play' });
    rampParam(this.ctx, this.fade.gain, 1, ALBUM_FADE_IN_S);
  }

  private sendQueue(): void {
    if (!this.bag || !this.worker) return;
    this.worker.postMessage({ type: 'queue', base: this.seq, ids: this.bag.peek(4) });
  }

  // ── the worklet's reports ──────────────────────────────────────────────────────────────────────────────────────────

  private onNode(m: NodeOut): void {
    if (m.type === 'stats') {
      this.stats = m;
      if (m.playing && m.fill < this.minFill) this.minFill = m.fill;
      return;
    }
    const mark = m.mark;
    if (!this.sessionUp || mark.epoch !== this.epoch) return; // a leftover of a track that has been skipped
    if (mark.kind === 'next' && this.bag) {
      // the album went on by itself: this is the track it is on now
      this.bag.take(mark.id);
      saveBag(this.bag, this.storage);
      this.seq = Math.max(this.seq, mark.n + 1);
      this.sendQueue();
    }
    this.setCurrent(mark.id);
  }

  private setCurrent(id: string | null): void {
    const t = id === null ? undefined : this.byId.get(id);
    this.current = t ? { id: t.id, title: t.title, genre: t.genre, album: this.albumName } : null;
    if (this.current) this.lastTrack = this.current;
    this.onTrack?.(this.current);
  }

  // ── letting go ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private teardown(): void {
    this.gen++;
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = 0;
    }
    try {
      this.worker?.postMessage({ type: 'stop' });
    } catch {
      /* gone already */
    }
    const node = this.node;
    this.node = null;
    if (node) {
      try {
        node.port.postMessage({ type: 'dispose' });
        node.port.onmessage = null;
        node.disconnect();
      } catch {
        /* gone already */
      }
    }
    this.sessionUp = false;
    this.playing = false;
    this.booting = false;
    this.stats = null;
    // (silent at once: the next start fades in from nothing, at the level the pause menu asks for)
    this.fade.gain.cancelScheduledValues(this.ctx.currentTime);
    this.fade.gain.value = 0;
    this.duck.gain.cancelScheduledValues(this.ctx.currentTime);
    this.duckTo = this.ducked ? ALBUM_DUCK_GAIN : 1;
    this.duck.gain.value = this.duckTo;
  }

  private fail(what: string, e?: unknown, quiet = false): void {
    if (this.failed) return;
    this.failed = true;
    if (!quiet) console.warn(`[album] ${what}; the race music is off for this session`, e ?? '');
    this.wanted = false;
    this.setCurrent(null);
    this.teardown();
    try {
      this.worker?.terminate();
    } catch {
      /* gone already */
    }
    this.worker = null;
    this.onFail?.();
  }
}
