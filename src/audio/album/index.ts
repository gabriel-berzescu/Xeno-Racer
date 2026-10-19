/**
 * The album: Xeno-Racer's own race music, instrumental, composed in code and synthesized sample by sample (no samples, no network).
 * It plays shuffled whenever someone drives; the menus keep their own theme (music.ts).
 *
 * This file is the contract between the music engine (this folder: instruments, mixer, the songs in tracks/) and the player
 * (src/audio/album-player.ts and its worker), which renders a track a few seconds ahead in a Web Worker and streams it to the music bus.
 * The engine is pure TypeScript with no Web Audio and no DOM, deterministic (a track renders the same every time), so it runs the same
 * in the worker, in node (the tests, the WAV previews) and anywhere else.
 *
 * Every module in tracks/ that default-exports a `defineTrack(...)` is part of the album: drop a file in, it shows up here.
 * Composer documentation: README.md in this folder.
 */
import type { TrackDef } from './song';

/** A track of the album, as the player and the UI see it. */
export interface AlbumTrack {
  /** Stable id: the file name of the song in tracks/ (e.g. 'neon-overdrive'). */
  readonly id: string;
  readonly title: string;
  /** The style, as shown to the player: 'Cyberpunk', 'Goa trance', 'Melodic dubstep', 'Punk'. */
  readonly genre: string;
  readonly bpm: number;
  /** Length in seconds. */
  readonly seconds: number;
}

/** Renders one track from its start, a block at a time. */
export interface TrackRenderer {
  /** Total length in frames at the sample rate it was made for. */
  readonly frames: number;
  /** Renders the next `n` frames (from where the last call stopped) into `l` and `r` (each at least `n` long); returns how many it wrote, fewer than `n` only at the end. */
  render(l: Float32Array, r: Float32Array, n: number): number;
}

/** The album's name, as the "now playing" card shows it. */
export const ALBUM_NAME = 'Vol. 1';

// ─────────────────────────────────────────────────────────────────────────────
// the registry
// ─────────────────────────────────────────────────────────────────────────────

const modules = import.meta.glob('./tracks/*.ts', { eager: true }) as Record<string, { default: TrackDef }>;

const GENRE_ORDER = ['Cyberpunk', 'Goa trance', 'Melodic dubstep', 'Punk'];

/** The track definitions, in album order (genre, then file name). */
export const TRACK_DEFS: readonly TrackDef[] = Object.entries(modules)
  .map(([path, m]) => ({ path, def: m.default }))
  .filter((x) => x.def && x.def.info)
  .sort((a, b) => {
    const ga = GENRE_ORDER.indexOf(a.def.info.genre);
    const gb = GENRE_ORDER.indexOf(b.def.info.genre);
    return (ga < 0 ? 99 : ga) - (gb < 0 ? 99 : gb) || a.path.localeCompare(b.path);
  })
  .map((x) => x.def);

export const ALBUM: readonly AlbumTrack[] = TRACK_DEFS.map((d) => d.info);

/** A renderer for the track `id` at `sampleRate`. Throws for an unknown id. */
export function createTrackRenderer(id: string, sampleRate: number): TrackRenderer {
  const def = TRACK_DEFS.find((d) => d.info.id === id);
  if (!def) throw new Error(`unknown album track: ${id}`);
  return def.build(sampleRate).toRenderer();
}
