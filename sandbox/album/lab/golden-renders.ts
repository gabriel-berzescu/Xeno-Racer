/**
 * Plays scripted notes through one instrument, the way the engine does (segments of at most 64 frames, cut at every event, offs before
 * ons), and hashes what comes out. The tests use `playScript` to measure instruments without building a song, and the hashes of the
 * growl and the synth as they were before the second round of the engine (the pitch envelope, the stereo width, the attack click) to
 * prove that those options change nothing while they are off.
 *
 *   node sandbox/album/run.mjs sandbox/album/lab/golden-renders.ts     (prints the hashes in the form the test file holds them)
 *
 * The hashes are of the 32-bit float samples (what the album stores), so that the last bit of a double does not matter; if you change
 * the growl or the synth on purpose, run the script and paste its output into tests/album-engine2.test.ts.
 */
import { createHash } from 'node:crypto';
import { FLAG, Transport } from '../../../src/audio/album/instrument';
import type { Ctx, Instrument } from '../../../src/audio/album/instrument';
import { GROWL_PRESETS, GrowlBass } from '../../../src/audio/album/instruments/bass';
import { SYNTH_PRESETS, Synth } from '../../../src/audio/album/instruments/synth';
import type { SynthOpts } from '../../../src/audio/album/instruments/synth';

export interface ScriptEvent {
  /** Position in beats. */
  beat: number;
  kind: 'on' | 'off';
  /** MIDI note. */
  note: number;
  vel?: number;
  flags?: number;
}

export function makeCtx(sr: number, bpm: number): Ctx {
  return { sr, bpm, barBeats: 4, transport: new Transport(), seed: 12345 };
}

/**
 * Plays `events` through `inst` for `seconds`. Event frames are round(beat * frames per beat), like the engine's; the transport is
 * advanced before every segment. Returns the left and right output (the right one stays empty for a mono instrument).
 */
export function playScript(inst: Instrument, ctx: Ctx, events: ScriptEvent[], seconds: number): { l: Float64Array; r: Float64Array } {
  const fpb = (ctx.sr * 60) / ctx.bpm;
  const total = Math.round(seconds * ctx.sr);
  const l = new Float64Array(total);
  const r = new Float64Array(total);
  const evs = events
    .map((e, i) => ({ e, f: Math.round(e.beat * fpb), i }))
    .sort((a, b) => a.f - b.f || (a.e.kind === 'off' ? 0 : 1) - (b.e.kind === 'off' ? 0 : 1) || a.i - b.i);
  let k = 0;
  for (let pos = 0; pos < total; ) {
    while (k < evs.length && evs[k].f <= pos) {
      const { e } = evs[k++];
      if (e.kind === 'on') inst.noteOn(e.note, e.vel ?? 0.8, Math.round(fpb), e.flags ?? 0);
      else inst.noteOff(e.note);
    }
    let end = Math.min(pos + 64, total);
    if (k < evs.length && evs[k].f < end) end = evs[k].f;
    ctx.transport.beat = pos / fpb;
    ctx.transport.frame = pos;
    inst.process(l.subarray(pos, end), r.subarray(pos, end), end - pos);
    pos = end;
  }
  return { l, r };
}

/** The first 16 hex digits of the SHA-256 of the samples rounded to 32-bit floats. */
export function hashFloat32(...channels: Float64Array[]): string {
  const h = createHash('sha256');
  for (const c of channels) {
    const f = Float32Array.from(c);
    h.update(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
  }
  return h.digest('hex').slice(0, 16);
}

// ── the growl: a held note, a slide, a short accent, a rest, a run of slides ─────────────────────────────

const A = FLAG.ACCENT;
const S = FLAG.SLIDE;
export const GROWL_SCRIPT: ScriptEvent[] = [
  { beat: 0, kind: 'on', note: 29, vel: 0.9 },
  { beat: 1.9, kind: 'off', note: 29 },
  { beat: 2, kind: 'on', note: 33, vel: 0.8 },
  { beat: 2.75, kind: 'on', note: 36, vel: 0.8, flags: S }, // tied to the A1 (its off is dropped)
  { beat: 3.5, kind: 'off', note: 36 },
  { beat: 4, kind: 'on', note: 38, vel: 1, flags: A },
  { beat: 4.4, kind: 'off', note: 38 },
  { beat: 5, kind: 'on', note: 33, vel: 0.7 },
  { beat: 6, kind: 'off', note: 33 },
  { beat: 6.5, kind: 'on', note: 41, vel: 0.6 },
  { beat: 6.75, kind: 'on', note: 43, vel: 0.6, flags: S },
  { beat: 7, kind: 'on', note: 45, vel: 0.9, flags: S },
  { beat: 7.5, kind: 'off', note: 45 },
];

export const GROWL_CASES: [string, Record<string, unknown>][] = [
  ...Object.keys(GROWL_PRESETS).map((p): [string, Record<string, unknown>] => [p, { preset: p }]),
  ['dubstep-growl beat-synced', { preset: 'dubstep-growl', lfoSync: 'beat' }],
  ['wub with glide', { preset: 'wub', glide: 0.08 }],
  ['riddim square lfo', { preset: 'riddim', lfoShape: 'square', lfoPhase: 0.75 }],
  ['dubstep-growl with envelope and comb', { preset: 'dubstep-growl', envAmt: 2, envDecay: 0.3, comb: 0.4 }],
];

export function growlHashes(sr = 48000, bpm = 140): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, opts] of GROWL_CASES) {
    const ctx = makeCtx(sr, bpm);
    const g = new GrowlBass(ctx, opts as never);
    const { l, r } = playScript(g, ctx, GROWL_SCRIPT, 9 * (60 / bpm) + 0.5);
    out[name] = hashFloat32(l, r);
  }
  return out;
}

// ── the synth: chords, an arpeggio, a legato lead with slides ────────────────────────────────────────────

const CHORD: ScriptEvent[] = [
  ...[57, 60, 64].map((n): ScriptEvent => ({ beat: 0, kind: 'on', note: n, vel: 0.8 })),
  ...[57, 60, 64].map((n): ScriptEvent => ({ beat: 2, kind: 'off', note: n })),
  ...[53, 57, 60, 65].map((n): ScriptEvent => ({ beat: 2.5, kind: 'on', note: n, vel: 0.6 })),
  ...[53, 57, 60, 65].map((n): ScriptEvent => ({ beat: 3.5, kind: 'off', note: n })),
  ...[69, 72, 76, 81, 76, 72].flatMap((n, i): ScriptEvent[] => [
    { beat: 4 + i * 0.25, kind: 'on', note: n, vel: 0.5 + 0.08 * i, flags: i === 3 ? A : 0 },
    { beat: 4 + i * 0.25 + 0.2, kind: 'off', note: n },
  ]),
];
const LEAD: ScriptEvent[] = [
  { beat: 0, kind: 'on', note: 69, vel: 0.8 },
  { beat: 1, kind: 'on', note: 72, vel: 0.8, flags: S }, // tied
  { beat: 2, kind: 'off', note: 72 },
  { beat: 2.5, kind: 'on', note: 76, vel: 0.9 },
  { beat: 3, kind: 'off', note: 76 },
  { beat: 3.25, kind: 'on', note: 74, vel: 0.5 },
  { beat: 3.75, kind: 'on', note: 71, vel: 0.5, flags: S },
  { beat: 5, kind: 'off', note: 71 },
];

export const SYNTH_CASES: [string, SynthOpts | string, ScriptEvent[]][] = [
  ...['supersaw-pad', 'supersaw-chord', 'warm-pad', 'string-pad', 'brass-stab', 'pluck', 'dark-pluck', 'trance-pluck', 'arp-bright', 'fm-epiano', 'fm-bell', 'organ', 'noise-pad', 'fm-bass-pluck'].map(
    (p): [string, SynthOpts | string, ScriptEvent[]] => [p, p, CHORD],
  ),
  ...['supersaw-lead', 'saw-lead', 'square-lead', 'trance-lead', 'psy-bass'].map((p): [string, SynthOpts | string, ScriptEvent[]] => [p, p, LEAD]),
  ['pluck with noise and sub', { preset: 'pluck', noise: 0.2, sub: 0.4, pEnv: 3 }, CHORD],
  ['plain saw, no filter', { layers: [{ wave: 'saw' }], filter: 'off', mono: true }, CHORD],
];

export function synthHashes(sr = 48000, bpm = 140): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, opts, script] of SYNTH_CASES) {
    const ctx = makeCtx(sr, bpm);
    const s = new Synth(ctx, opts);
    const { l, r } = playScript(s, ctx, script, 6 * (60 / bpm) + 1.5);
    out[name] = hashFloat32(l, r);
  }
  return out;
}

void SYNTH_PRESETS;

// run as a script: print the hashes in the form the test holds them
if (typeof process !== 'undefined' && process.argv[1] && /golden-renders/.test(process.argv[1])) {
  const fmt = (name: string, h: Record<string, string>): string => `const ${name}: Record<string, string> = ${JSON.stringify(h, null, 2)};\n`;
  process.stdout.write(fmt('GROWL_GOLDEN', growlHashes()));
  process.stdout.write(fmt('SYNTH_GOLDEN', synthHashes()));
}
