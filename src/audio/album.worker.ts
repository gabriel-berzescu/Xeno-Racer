/**
 * The album's renderer: a Web Worker that makes the music a few seconds ahead of the playhead and hands it to the audio thread.
 *
 * The tracks are synthesized by src/audio/album/ (pure TypeScript, about ten times faster than real time on a core), far too much
 * work for the main thread's frame budget, so it is done here. The worker mixes the tracks into one continuous stream
 * (album-stream.ts) and sends it, a block at a time, straight to the AudioWorklet that plays it (album.worklet.ts) over a
 * MessageChannel the main thread made for the two of them; the main thread never sees the PCM. How far ahead to render is decided
 * by the playhead the worklet reports about ten times a second: it keeps about eight seconds in hand, and when the buffer is full it
 * sleeps (an idle worker costs a timer a tenth of a second).
 *
 * Protocol: see album-protocol.ts.
 */
import { ALBUM, ALBUM_NAME, createTrackRenderer } from './album';
import type { LinkDown, LinkUp, WorkerIn, WorkerOut } from './album-protocol';
import { AlbumStreamer } from './album-stream';

interface Scope {
  postMessage(m: WorkerOut): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
}
const scope = self as unknown as Scope;

/** Frames per block: ~90 ms of audio, ~9 ms of rendering for a real track. */
const BLOCK = 4096;
/** How far ahead of the playhead to render. */
const LEAD_SECONDS = 8;
/** The longest stretch of rendering before the worker looks at its messages again (a skip must not wait for a whole refill). */
const SLICE_MS = 12;
/** How often the worker looks at the playhead when the buffer is full. */
const IDLE_MS = 100;
/** After a skip, render at least this much of the new track at once (the old one is fading out meanwhile). */
const SKIP_HEAD_SECONDS = 0.8;
/** A margin for the playhead moving on while the skip's message is in flight: the new track starts this far past the fade-out. */
const SKIP_MARGIN_SECONDS = 0.3;

let sampleRate = 48000;
let link: MessagePort | null = null;
let streamer: AlbumStreamer | null = null;
let session = 0;
let running = false;
/** The playhead as the worklet last reported it. */
let played = 0;
/** After a skip: render at least up to here, whatever the playhead says. */
let forceTo = 0;
let timer: ReturnType<typeof setTimeout> | 0 = 0;
let yielding = false;
let rendered = 0;
let spent = 0;
let reportedAt = 0;
let lastError = '';

const post = (m: WorkerOut): void => scope.postMessage(m);

/** The album's own order after `afterId`, wrapping round: what to play when nothing else says. */
function fallbackAfter(afterId: string | null): string[] {
  const ids = ALBUM.map((t) => t.id);
  const i = afterId === null ? -1 : ids.indexOf(afterId);
  return [...ids.slice(i + 1), ...ids.slice(0, i + 1)];
}

function fail(what: string, e: unknown): void {
  const message = `${what}: ${e instanceof Error ? e.message : String(e)}`;
  if (message === lastError) return; // (one report of the same trouble, not one every retry)
  lastError = message;
  post({ type: 'error', message });
}

function init(m: Extract<WorkerIn, { type: 'init' }>): void {
  sampleRate = m.sampleRate;
  link = m.port;
  link.onmessage = (e: MessageEvent<LinkUp>): void => {
    const s = e.data;
    if (s.type !== 'status' || s.session !== session) return;
    played = s.played;
    if (running && !timer && !yielding) schedule(0);
  };
  streamer = new AlbumStreamer({
    sampleRate,
    createRenderer: createTrackRenderer,
    fallback: fallbackAfter,
    onError: (id, e) => fail(`track ${id}`, e),
  });
  // (plain copies: the album's own objects are not ours to send)
  post({ type: 'ready', album: ALBUM.map((t) => ({ id: t.id, title: t.title, genre: t.genre, bpm: t.bpm, seconds: t.seconds })), name: ALBUM_NAME });
}

function schedule(ms: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(pump, ms);
}

/** Run again at once, without the clamp a timer has once it has been rescheduled from itself a few times. */
const turn = new MessageChannel();
turn.port1.onmessage = (): void => {
  yielding = false;
  pump();
};
function again(): void {
  if (timer) {
    clearTimeout(timer);
    timer = 0;
  }
  if (yielding) return;
  yielding = true;
  turn.port2.postMessage(0);
}

function pump(): void {
  timer = 0;
  if (!running || !streamer || !link) return;
  try {
    const t0 = performance.now();
    const lead = Math.round(LEAD_SECONDS * sampleRate);
    const wants = (): boolean => streamer!.position - played < lead || streamer!.position < forceTo;
    while (wants()) {
      const c = streamer.produce(BLOCK);
      const msg: LinkDown = { type: 'pcm', session, pos: c.pos, l: c.l, r: c.r, marks: c.marks };
      link.postMessage(msg, [c.l.buffer, c.r.buffer]);
      rendered += BLOCK;
      if (performance.now() - t0 >= SLICE_MS) break;
    }
    const now = performance.now();
    spent += now - t0;
    if (now - reportedAt >= 1000 && rendered > 0) {
      post({ type: 'load', frames: rendered, ms: spent });
      rendered = 0;
      spent = 0;
      reportedAt = now;
    }
    if (wants()) again();
    else {
      // the buffer is full: make the next track ready while there is nothing else to do (a skip, or the next crossfade, will use it)
      streamer.warm();
      schedule(IDLE_MS);
    }
  } catch (e) {
    fail('render', e);
    schedule(1000);
  }
}

scope.onmessage = (e: MessageEvent<WorkerIn>): void => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init':
        init(m);
        break;
      case 'start': {
        if (!streamer || !link) break;
        session = m.session;
        played = 0;
        forceTo = 0;
        lastError = '';
        link.postMessage({ type: 'reset', session } satisfies LinkDown);
        streamer.start(m.id, m.epoch, m.n);
        running = true;
        reportedAt = performance.now();
        again();
        break;
      }
      case 'queue':
        streamer?.setQueue(m.base, m.ids);
        break;
      case 'skip': {
        if (!streamer) break;
        // the worklet is fading the old track out over `frames`; the new one starts just after that, in the stream, overwriting the old
        // track's frames from there on
        const at = played + m.frames + Math.round(SKIP_MARGIN_SECONDS * sampleRate);
        streamer.skip(m.id, m.epoch, m.n, at);
        forceTo = streamer.position + Math.round(SKIP_HEAD_SECONDS * sampleRate);
        if (running) again();
        break;
      }
      case 'stop':
        running = false;
        streamer?.stop();
        if (timer) clearTimeout(timer);
        timer = 0;
        break;
    }
  } catch (err) {
    fail(m.type, err);
  }
};
