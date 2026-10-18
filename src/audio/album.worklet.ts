/**
 * AudioWorklet entry for the race music. Registers
 *   'xr-album'   a stereo ring buffer that plays the album's stream (album-playback.ts holds the logic; this file is the glue)
 *
 * The stream is rendered by a Web Worker (album.worker.ts), which sends it straight to this processor over a MessageChannel; the
 * processor reports its playhead back to that worker about ten times a second (so it knows how far ahead to render) and tells the
 * main thread which track is being heard (so "now playing" changes when the track does, not when it was rendered).
 *
 * Kept apart from engine.worklet.ts: this module is a few kilobytes, loads in a moment, and has nothing to do with the car sounds.
 * Keep this file free of DOM / Web Audio main-thread APIs: it runs inside AudioWorkletGlobalScope.
 */
import { AlbumPlayback } from './album-playback';
import type { LinkDown, LinkUp, NodeIn, NodeOut } from './album-protocol';

// AudioWorkletGlobalScope globals (not in the project's lib set)
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: new (options: any) => unknown): void; // eslint-disable-line
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

export interface AlbumProcessorOptions {
  /** Frames the ring holds (default 14 s). */
  capacity?: number;
  /** Frames to have buffered before the music starts (default 0.3 s). */
  prebuffer?: number;
}

/** The playhead goes to the worker every this many render quanta of 128 frames (about 90 ms), the level figures to the main thread every 4th of those. */
const STATUS_EVERY = 32;
const STATS_EVERY = 128;

class AlbumProcessor extends AudioWorkletProcessor {
  private readonly pb: AlbumPlayback;
  private link: MessagePort | null = null;
  private quanta = 0;
  private dead = false;
  private scratch = new Float32Array(128);

  constructor(options: { processorOptions?: AlbumProcessorOptions }) {
    super();
    const o = options?.processorOptions ?? {};
    this.pb = new AlbumPlayback({
      sampleRate,
      capacity: o.capacity,
      prebuffer: o.prebuffer,
      onTrack: (mark) => this.port.postMessage({ type: 'track', mark } satisfies NodeOut),
    });
    this.port.onmessage = (e: MessageEvent<NodeIn>): void => {
      const m = e.data;
      switch (m.type) {
        case 'link':
          this.link = m.port;
          m.port.onmessage = (ev: MessageEvent<LinkDown>): void => this.pb.receive(ev.data);
          break;
        case 'play':
          this.pb.playRequested = true;
          break;
        case 'cut':
          this.pb.cut(m.epoch, m.frames);
          break;
        case 'dispose':
          this.dead = true;
          this.link?.close();
          this.link = null;
          break;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.dead) return false;
    const out = outputs[0];
    const l = out && out[0];
    if (!l) return true;
    // (a mono output gets the left channel; the right is made in a scratch block)
    let r = out[1];
    if (!r) {
      if (this.scratch.length < l.length) this.scratch = new Float32Array(l.length);
      r = this.scratch;
    }
    this.pb.process(l, r, l.length);
    this.quanta++;
    if (this.quanta % STATUS_EVERY === 0 && this.link) {
      this.link.postMessage({ type: 'status', session: this.pb.session, played: this.pb.played } satisfies LinkUp);
    }
    if (this.quanta % STATS_EVERY === 0) this.port.postMessage({ type: 'stats', ...this.pb.stats() } satisfies NodeOut);
    return true;
  }
}

registerProcessor('xr-album', AlbumProcessor);
