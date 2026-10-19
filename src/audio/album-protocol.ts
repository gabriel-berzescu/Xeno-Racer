/**
 * The race music's messages: who says what to whom. Types only (no code), shared by the three threads that make the album play.
 *
 *   main thread  (album-player.ts)   decides what plays: the shuffle bag, the skips, the fades and ducking of the gain stages
 *   worker       (album.worker.ts)   renders the tracks ahead of the playhead and mixes them into one stream (src/audio/album/)
 *   worklet      (album.worklet.ts)  a ring buffer of that stream, read by the audio thread, and the clock everything is measured on
 *
 *        main --- WorkerIn ---------> worker            main --- NodeIn --------> worklet
 *        main <-- WorkerOut --------- worker            main <-- NodeOut -------- worklet
 *                                     worker --- LinkDown --> worklet     (a MessageChannel the main thread made, one end each)
 *                                     worker <-- LinkUp ----- worklet
 *
 * The PCM goes from the worker straight to the worklet, never through the main thread.
 *
 * The stream. A session is one continuous stereo stream whose frames are numbered from 0 ("stream position"). The worker writes
 * it in order, a block at a time, a few seconds ahead of the playhead (`played`, the worklet's read position). Tracks follow
 * each other inside it with a crossfade the worker has already mixed, so the worklet knows nothing about tracks: it plays frames,
 * and fires a `Mark` when the playhead passes the point where a track became audible.
 */
import type { AlbumTrack } from './album';

/** A point of the stream where the audible track changes. */
export interface Mark {
  /** Stream position of the point: the first sample of a track that starts cleanly, the middle of the crossfade into one that does not. */
  pos: number;
  id: string;
  /** Which track of the session this is (0 = the first one played since the session began). */
  n: number;
  /**
   * 'start': the first track of the session, or the one a skip landed on (the player committed it when it asked for it).
   * 'next': the album went on by itself (the player commits it when it is heard).
   */
  kind: 'start' | 'next';
  /** The player's counter of starts and skips when the track was begun: an event of an older epoch is a leftover and is ignored. */
  epoch: number;
}

// ── main -> worker ──────────────────────────────────────────────────────────────────────────────────────────────────

export type WorkerIn =
  /** First message: the sample rate of the audio context, and the end of the link to the worklet. */
  | { type: 'init'; sampleRate: number; port: MessagePort }
  /** A new session: stream position 0 is the start of track `id` (ordinal `n`, always 0). */
  | { type: 'start'; session: number; epoch: number; id: string; n: number }
  /** The tracks after the one the player has committed: ids[0] is the track with ordinal `base`. Resent whenever the bag moves. */
  | { type: 'queue'; base: number; ids: string[] }
  /**
   * Cut to track `id` (ordinal `n`) now. `frames` is the length of the fade-out the worklet is playing (the new track starts in the
   * stream just after it, and fades in itself).
   */
  | { type: 'skip'; epoch: number; id: string; n: number; frames: number }
  /** Stop rendering and let go of the tracks. */
  | { type: 'stop' };

// ── worker -> main ──────────────────────────────────────────────────────────────────────────────────────────────────

export type WorkerOut =
  /** The worker is up and has read the album. */
  | { type: 'ready'; album: AlbumTrack[]; name: string }
  | { type: 'error'; message: string }
  /** About once a second while rendering: how much audio was rendered, and how long it took (for the debug stats). */
  | { type: 'load'; frames: number; ms: number };

// ── worker -> worklet (the link) ────────────────────────────────────────────────────────────────────────────────────

export type LinkDown =
  | { type: 'reset'; session: number }
  /**
   * Frames [pos, pos + l.length) of the stream. A chunk may start before the end of what the worklet holds: a skip rewrites the stream
   * from a point a little ahead of the playhead, and everything after it is the old track's and is dropped.
   */
  | { type: 'pcm'; session: number; pos: number; l: Float32Array; r: Float32Array; marks: Mark[] };

// ── worklet -> worker (the link) ────────────────────────────────────────────────────────────────────────────────────

export type LinkUp = { type: 'status'; session: number; played: number };

// ── main -> worklet ─────────────────────────────────────────────────────────────────────────────────────────────────

export type NodeIn =
  | { type: 'link'; port: MessagePort }
  /** Start playing (until then the worklet only buffers: the first seconds are ready when the race starts). */
  | { type: 'play' }
  /** Skip: fade out over `frames`, then jump to the first track started with an epoch of at least `epoch`. */
  | { type: 'cut'; epoch: number; frames: number }
  | { type: 'dispose' };

// ── worklet -> main ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface PlaybackStats {
  /** The playhead, in stream frames. */
  played: number;
  /** Frames buffered ahead of it. */
  fill: number;
  /** Times the buffer ran dry while playing. */
  underruns: number;
  /** Chunks dropped because they did not fit. */
  overruns: number;
  /** Level of what was played since the last report (before the gain stages). */
  rms: number;
  peak: number;
  playing: boolean;
}

export type NodeOut = { type: 'track'; mark: Mark } | ({ type: 'stats' } & PlaybackStats);
