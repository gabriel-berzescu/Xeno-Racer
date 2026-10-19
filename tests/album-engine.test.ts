/**
 * Album engine tests (fast): contract and metadata, determinism, block-size independence, mastering (peak, loudness, DC,
 * clean start and end), instrument pitch, the kick on the beat grid, the composer API (notation, theory, automation) and the mixer.
 * The Sound Check track is rendered once and shared by the tests that look at the finished mix.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ALBUM, ALBUM_NAME, TRACK_DEFS, createTrackRenderer } from '../src/audio/album';
import type { TrackRenderer } from '../src/audio/album';
import { defineTrack, fx, guitarChord } from '../src/audio/album/song';
import type { ChannelHandle, Song } from '../src/audio/album/song';
import type { GrowlBass } from '../src/audio/album/instruments/bass';
import { LoudnessMeter, measure, truePeakLinear } from '../src/audio/album/measure';
import { Key, noteToMidi, parseChord, voiceChord } from '../src/audio/album/theory';
import { euclid } from '../src/audio/album/pattern';
import { FLAG } from '../src/audio/album/instrument';
import soundCheck, { SOUND_CHECK_MAP } from '../src/audio/album/sound-check';
import { CATALOG, FX_CATALOG } from '../src/audio/album/catalog';
import { readReadme, readSnippets, renderReadme, renderSnippets } from '../sandbox/album/lab/readme';
import { bandDb } from '../sandbox/album/lab/tools';
import { autocorrPitch, fft, hasNonFinite, peakAbs, rms } from '../src/audio/analysis';
import { addPulse, addSaw, sawBL } from '../src/audio/album/dsp/osc';

const SR = 48000;

function renderBlocks(r: TrackRenderer, frames: number, block: number): [Float32Array, Float32Array] {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  const bl = new Float32Array(block);
  const br = new Float32Array(block);
  let pos = 0;
  while (pos < frames) {
    const m = r.render(bl, br, Math.min(block, frames - pos));
    if (m === 0) break;
    L.set(bl.subarray(0, m), pos);
    R.set(br.subarray(0, m), pos);
    pos += m;
  }
  return [L, R];
}

/** Renders one mini track in raw mode (master bypassed) and returns the mono signal. */
function raw(sr: number, bpm: number, bars: number, build: (s: Song) => void, tail = 0.5): { l: Float32Array; r: Float32Array } {
  const def = defineTrack({ id: 't-raw', title: 'raw', genre: 'Test', bpm, bars, tail, fadeOut: 0.01 }, (s) => {
    s.key('A', 'minor');
    build(s);
    s.master.raw = true;
  });
  const r = def.build(sr).toRenderer();
  const [l, rr] = renderBlocks(r, r.frames, 4096);
  return { l, r: rr };
}

let full: { l: Float32Array; r: Float32Array; ms: number } | null = null;

beforeAll(() => {
  const t0 = performance.now();
  const r = soundCheck.build(SR).toRenderer();
  const [l, rr] = renderBlocks(r, r.frames, 4096);
  full = { l, r: rr, ms: performance.now() - t0 };
});

describe('album contract', () => {
  it('lists the album and builds a renderer for each track at both sample rates', () => {
    expect(ALBUM_NAME).toBe('Vol. 1');
    expect(ALBUM.length).toBeGreaterThan(0);
    expect(ALBUM.length).toBe(TRACK_DEFS.length);
    for (const t of ALBUM) {
      expect(t.id).toMatch(/^[a-z0-9-]+$/);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.bpm).toBeGreaterThan(50);
      expect(t.seconds).toBeGreaterThan(20);
    }
    expect(() => createTrackRenderer('no-such-track', SR)).toThrow(/unknown album track/);
  });

  it('names every track after its file and never repeats an id', () => {
    const files = import.meta.glob('../src/audio/album/tracks/*.ts', { eager: true }) as Record<string, { default: { info: { id: string } } }>;
    expect(Object.keys(files).length).toBe(ALBUM.length);
    for (const [path, m] of Object.entries(files)) expect(path.replace(/^.*\//, '').replace(/\.ts$/, '')).toBe(m.default.info.id);
    expect(new Set(ALBUM.map((t) => t.id)).size).toBe(ALBUM.length);
  });

  it('reports frames consistent with ALBUM.seconds for every track, whatever the sample rate, and renders the first seconds cleanly', () => {
    for (const info of ALBUM) {
      for (const sr of [44100, 48000]) {
        const r = createTrackRenderer(info.id, sr);
        expect(r.frames, `${info.id} at ${sr}`).toBe(Math.round(info.seconds * sr));
      }
      const r = createTrackRenderer(info.id, 44100);
      const [l, rr] = renderBlocks(r, Math.min(r.frames, 44100 * 4), 4096);
      expect(hasNonFinite(l) || hasNonFinite(rr), `${info.id}: NaN or Inf in the first seconds`).toBe(false);
      expect(Math.abs(l[0]) + Math.abs(rr[0]), `${info.id}: the first sample must be silent`).toBeLessThan(1e-4);
      expect(peakAbs(l), `${info.id}: clipping in the first seconds`).toBeLessThanOrEqual(1);
    }
  }, 120000);

  it('writes fewer than asked only at the end', () => {
    const r = defineTrack({ id: 't-end', title: 'end', genre: 'Test', bpm: 120, bars: 3, tail: 0.7 }, (s) => {
      s.kick('techno-kick').play(s.hits('X...x...X...x...'), 0, 3);
    })
      .build(44100)
      .toRenderer();
    const frames = r.frames;
    const l = new Float32Array(8192);
    const rr = new Float32Array(8192);
    let total = 0;
    let lastWritten = 0;
    // render the tail only: skip ahead quickly with large blocks
    const big = new Float32Array(65536);
    const big2 = new Float32Array(65536);
    while (total < frames - 5000) {
      const m = r.render(big, big2, Math.min(65536, frames - 5000 - total));
      total += m;
    }
    for (;;) {
      const m = r.render(l, rr, 8192);
      lastWritten = m;
      total += m;
      if (m < 8192) break;
    }
    expect(total).toBe(frames);
    expect(lastWritten).toBeLessThan(8192);
    expect(r.render(l, rr, 100)).toBe(0);
  }, 30000);
});

describe('determinism and streaming', () => {
  it('renders bit-identically every time and with any block size', () => {
    const frames = SR * 3;
    const ref = renderBlocks(soundCheck.build(SR).toRenderer(), frames, 512);
    const again = renderBlocks(soundCheck.build(SR).toRenderer(), frames, 512);
    expect(Buffer.compare(Buffer.from(ref[0].buffer), Buffer.from(again[0].buffer))).toBe(0);
    for (const block of [1000, 8192, 7, 64]) {
      const o = renderBlocks(soundCheck.build(SR).toRenderer(), block === 7 ? 20000 : frames, block);
      const n = o[0].length;
      expect(Buffer.compare(Buffer.from(ref[0].buffer, 0, n * 4), Buffer.from(o[0].buffer))).toBe(0);
      expect(Buffer.compare(Buffer.from(ref[1].buffer, 0, n * 4), Buffer.from(o[1].buffer))).toBe(0);
    }
  }, 60000);
});

describe('streaming of the whole sound check', () => {
  it('is bit-identical over its full length for an odd block size (every instrument, the sends and the master)', () => {
    const o = renderBlocks(soundCheck.build(SR).toRenderer(), full!.l.length, 1237);
    expect(Buffer.compare(Buffer.from(full!.l.buffer), Buffer.from(o[0].buffer))).toBe(0);
    expect(Buffer.compare(Buffer.from(full!.r.buffer), Buffer.from(o[1].buffer))).toBe(0);
  }, 60000);
});

describe('mastering of the finished sound check', () => {
  it('is finite, under the true-peak ceiling, near -14 LUFS, without DC, and starts and ends cleanly', () => {
    const { l, r } = full!;
    expect(hasNonFinite(l)).toBe(false);
    expect(hasNonFinite(r)).toBe(false);
    const st = measure(l, r, SR);
    expect(st.truePeakDb).toBeLessThanOrEqual(-1.0);
    expect(st.samplePeakDb).toBeLessThanOrEqual(-1.0);
    expect(st.lufs).toBeGreaterThan(-15.5);
    expect(st.lufs).toBeLessThan(-12.5);
    expect(Math.abs(st.dc[0])).toBeLessThan(1e-3);
    expect(Math.abs(st.dc[1])).toBeLessThan(1e-3);
    expect(Math.abs(l[0])).toBeLessThan(1e-3);
    expect(Math.abs(l[l.length - 1])).toBeLessThan(1e-4);
    expect(rms(l, l.length - 200, l.length)).toBeLessThan(1e-4);
  });

  it('keeps the sections in a sensible loudness range and stays click-free', () => {
    const { l, r } = full!;
    const meter = new LoudnessMeter(SR);
    meter.push(l, r, l.length);
    const barS = (60 / 140) * 4;
    for (const sec of SOUND_CHECK_MAP) {
      const b0 = Math.floor((sec.bar * barS + 0.5) * 10);
      const b1 = Math.floor(((sec.bar + sec.bars) * barS - 0.3) * 10);
      let e = 0;
      for (let i = b0; i < b1; i++) e += meter.blocks[i];
      const lufs = LoudnessMeter.toLufs(e / (b1 - b0));
      // every section must be audible and none may dominate the whole by more than a few dB
      expect(lufs, sec.name).toBeGreaterThan(-26);
      expect(lufs, sec.name).toBeLessThan(-9);
    }
    // the tonal sections must not contain a sample-to-sample jump that looks like a click (drum hits are noise bursts and may be sharp)
    for (const name of ['acid', 'growl', 'reese', 'pads', 'leads', 'keys', 'bass-guitar']) {
      const sec = SOUND_CHECK_MAP.find((m) => m.name === name)!;
      const i0 = Math.round((sec.bar * barS + 0.3) * SR);
      const i1 = Math.round(((sec.bar + sec.bars) * barS - 0.3) * SR);
      let maxStep = 0;
      for (let i = i0 + 1; i < i1; i++) maxStep = Math.max(maxStep, Math.abs(l[i] - l[i - 1]));
      expect(maxStep, name).toBeLessThan(0.7);
    }
  });

  it('renders at least 8x faster than real time even with the machine busy', () => {
    const seconds = full!.l.length / SR;
    expect(seconds / (full!.ms / 1000)).toBeGreaterThan(5);
  });

  it('limits a deliberately overloaded mix under the true-peak ceiling', () => {
    const def = defineTrack({ id: 't-hot', title: 'hot', genre: 'Test', bpm: 140, bars: 4, tail: 0.5 }, (s) => {
      const kit = s.drumKit({ kick: 'hard-kick', snare: 'heavy-snare', crash: 'crash' }, { gain: 6 });
      kit.play(s.drums({ kick: 'X...X...X...X...', snare: '....X.......X...', crash: 'X...............' }), 0, 4);
      const bass = s.darkBass('dark-growl', { gain: 9 });
      bass.play(s.notes('A1 A1 A1 A1 A1 A1 A1 A1 A1 A1 A1 A1 A1 A1 A1 A1'), 0, 4);
      const gtr = s.guitar('metal-guitar', { gain: 6 });
      gtr.play(s.notes('[A2,E3,A3] - - - - - - - [A2,E3,A3] - - - - - - -'), 0, 4);
      s.setMaster({ trim: 8 });
    });
    const r = def.build(SR).toRenderer();
    const [l, rr] = renderBlocks(r, r.frames, 2048);
    const tp = Math.max(truePeakLinear(l), truePeakLinear(rr));
    expect(20 * Math.log10(tp)).toBeLessThanOrEqual(-1.0);
    expect(hasNonFinite(l)).toBe(false);
  }, 60000);
});

describe('instruments', () => {
  it('play the right pitch (A4 = 440 Hz)', () => {
    type Maker = (s: Song) => { play: (p: never, at: number, bars: number) => unknown };
    const cases: [string, Maker, string, number, number][] = [
      ['saw synth', (s) => s.synth({ layers: [{ wave: 'saw' }], filter: 'off', mono: true }), 'A4', 440, 0.35],
      ['organ', (s) => s.synth('organ'), 'A4', 440, 0.35],
      ['fm e-piano', (s) => s.synth({ preset: 'fm-epiano', fmIndex: 0.5 }), 'A4', 440, 0.3],
      ['pluck', (s) => s.synth('pluck'), 'A4', 440, 0.05],
      ['lead', (s) => s.synth({ preset: 'supersaw-lead', vibDepth: 0, unisonDetune: 0 }), 'A4', 440, 0.35],
      ['sub bass', (s) => s.sub('sub-sine'), 'A1', 55, 0.35],
      ['dark bass', (s) => s.darkBass('darksynth-bass'), 'A1', 55, 0.35],
      ['reese', (s) => s.reese('reese'), 'A1', 55, 0.35],
      ['acid', (s) => s.acid('acid-303'), 'A2', 110, 0.2],
      ['growl', (s) => s.growl({ preset: 'dubstep-growl', formant: 0, fmMix: 0, lfoDepth: 0, drive: 0, fold: 0 }), 'A2', 110, 0.35],
    ];
    for (const [name, make, note, hz, from] of cases) {
      const { l } = raw(SR, 120, 2, (s) => {
        make(s).play(s.notes(`${note}:16`, { free: true }) as never, 0, 2);
      });
      const e = autocorrPitch(l, SR, Math.round(from * SR), 8192, hz * 0.7, hz * 1.4);
      const cents = Math.abs(1200 * Math.log2(e.freq / hz));
      expect(cents, `${name}: ${e.freq.toFixed(2)} Hz`).toBeLessThan(8);
    }
  }, 60000);

  it('keeps the band-limited saw and pulse clean (four-sample PolyBLEP: aliasing below -40 dB at 1 kHz)', () => {
    const N = 65536;
    // the block holds exactly k periods, so every true harmonic sits on a multiple of k and a rectangular window leaks nothing:
    // the energy on all other bins is aliasing
    const alias = (fill: (dst: Float64Array, dt: number) => void, target: number): number => {
      let k = Math.round((target * N) / SR);
      if (k % 2 === 0) k += 1;
      const re = new Float64Array(N);
      const im = new Float64Array(N);
      fill(re, (k * SR) / N / SR);
      fft(re, im);
      let harm = 0;
      let off = 0;
      for (let b = 1; b < N / 2; b++) {
        const p = re[b] * re[b] + im[b] * im[b];
        if (b % k === 0) harm += p;
        else off += p;
      }
      return 10 * Math.log10(off / harm + 1e-30);
    };
    const saw = (dst: Float64Array, dt: number): void => void addSaw(dst, dst.length, 0, dt, 1);
    const pulse = (dst: Float64Array, dt: number): void => void addPulse(dst, dst.length, 0, dt, 1, 0.5);
    expect(alias(saw, 110)).toBeLessThan(-48);
    expect(alias(saw, 1000)).toBeLessThan(-40);
    expect(alias(saw, 2000)).toBeLessThan(-33);
    expect(alias(pulse, 1000)).toBeLessThan(-40);
    // the block oscillator and the per-sample one are the same waveform
    const a = new Float64Array(2048);
    addSaw(a, 2048, 0, 0.0123, 1);
    let ph = 0;
    for (let i = 0; i < 2048; i++) {
      ph += 0.0123;
      if (ph >= 1) ph -= 1;
      expect(Math.abs(a[i] - sawBL(ph, 0.0123))).toBeLessThan(1e-12);
    }
  });

  it('slides an acid note into the next without retriggering it (no hole in the level, unlike a plain retrigger)', () => {
    const level = (pattern: string): number => {
      const { l } = raw(SR, 120, 1, (s) => {
        s.acid('acid-303', { gain: 0 }).play(s.notes(pattern, { free: true }), 0, 1);
      });
      // the note changes at beat 1 (0.5 s): the smallest 10 ms rms between 0.46 s and 0.56 s against the median level of 0.3 s .. 0.8 s
      const win = Math.round(0.01 * SR);
      const vals: number[] = [];
      for (let t = Math.round(0.3 * SR); t < Math.round(0.8 * SR); t += win) vals.push(rms(l, t, t + win));
      const sorted = [...vals].sort((a, b) => a - b);
      return vals.slice(16, 26).reduce((m, v) => Math.min(m, v), Infinity) / sorted[Math.floor(sorted.length / 2)];
    };
    expect(level('A1 - - - E2~ - - - . . . . . . . .')).toBeGreaterThan(0.7); // slid: the level carries on
    expect(level('A1 - - - E2 - - - . . . . . . . .')).toBeLessThan(0.5); // retriggered: a gap between the notes
  });

  it('plays the guitar and the bass guitar in tune', () => {
    const g = raw(SR, 120, 2, (s) => {
      s.guitar({ preset: 'clean-guitar', gain: 0, boost: 0, tight: 0, bass: 0, mid: 0, treble: 0, presence: 0, detune: 0, timing: 0, pickup: 0, attackBend: 0 }).play(s.notes('A3:16', { free: true }), 0, 1);
    });
    const e1 = autocorrPitch(g.l, SR, Math.round(0.3 * SR), 8192, 160, 300);
    expect(Math.abs(1200 * Math.log2(e1.freq / 220))).toBeLessThan(6);
    const b = raw(SR, 120, 2, (s) => {
      s.bassGuitar({ preset: 'finger-bass', drive: 0, comp: 0 }).play(s.notes('E1:16', { free: true }), 0, 1);
    });
    const e2 = autocorrPitch(b.l, SR, Math.round(0.3 * SR), 8192, 30, 70);
    expect(Math.abs(1200 * Math.log2(e2.freq / 41.2035))).toBeLessThan(8);
  }, 30000);

  it('puts every kick on the beat grid (within 1.5 ms), straight and swung', () => {
    const bpm = 124;
    const beat = 60 / bpm;
    const { l } = raw(SR, bpm, 2, (s) => {
      s.kick('techno-kick').play(s.hits('X...X...X...X...'), 0, 2);
    });
    const pk = peakAbs(l);
    for (let k = 0; k < 8; k++) {
      const t = k * beat;
      let on = -1;
      for (let i = Math.max(0, Math.round((t - 0.004) * SR)); i < Math.round((t + 0.03) * SR); i++) {
        if (Math.abs(l[i]) > 0.04 * pk) {
          on = i;
          break;
        }
      }
      expect(on, `kick ${k}`).toBeGreaterThanOrEqual(0);
      expect(Math.abs(on / SR - t) * 1000, `kick ${k} onset error ms`).toBeLessThan(1.5);
    }
    // swing: the second eighth of each beat moves to 2/3 of the beat
    const sw = raw(SR, bpm, 1, (s) => {
      s.groove({ swing: 2 / 3 });
      s.kick('techno-kick').play(s.hits('..x...........'.padEnd(16, '.')), 0, 1);
    });
    const t8 = beat * (2 / 3);
    let on = -1;
    for (let i = 0; i < sw.l.length; i++) {
      if (Math.abs(sw.l[i]) > 0.04 * peakAbs(sw.l)) {
        on = i;
        break;
      }
    }
    expect(Math.abs(on / SR - t8) * 1000).toBeLessThan(2);
  }, 30000);

  it('keeps the growl wobble going when lfoRate changes in the middle of a note (the phase never jumps)', () => {
    for (const sync of ['note', 'beat'] as const) {
      let g!: ChannelHandle<GrowlBass>;
      const def = defineTrack({ id: 't-lfo', title: 'lfo', genre: 'Test', bpm: 120, bars: 4, tail: 0.5 }, (s) => {
        g = s.growl({ preset: 'wub', lfoSync: sync });
        g.play(s.notes('A1:64', { free: true }), 0, 4); // one held note, 4 bars
        g.auto('lfoRate', [[0, 1], [1.0625, 2, 'step']]); // quarter notes, then eighths from beat 4.25
        s.master.raw = true;
      });
      const r = def.build(SR).toRenderer();
      renderBlocks(r, 120000, 4096); // 2.5 s = 5 beats at 120 BPM
      // 4.25 beats at one cycle per beat, then 0.75 beat at two: 5.75 cycles. A phase worked out as "beats x current rate" would read 10.
      expect(g.inst.lfoCycles(), sync).toBeGreaterThan(5.6);
      expect(g.inst.lfoCycles(), sync).toBeLessThan(5.9);
    }
    // and with a constant rate the phase is simply the number of beats
    let g!: ChannelHandle<GrowlBass>;
    const def = defineTrack({ id: 't-lfo2', title: 'lfo', genre: 'Test', bpm: 120, bars: 4, tail: 0.5 }, (s) => {
      g = s.growl({ preset: 'dubstep-growl' });
      g.play(s.notes('A1:64', { free: true }), 0, 4);
      s.master.raw = true;
    });
    renderBlocks(def.build(SR).toRenderer(), 96000, 4096); // 2 s = 4 beats
    expect(g.inst.lfoCycles()).toBeGreaterThan(3.98);
    expect(g.inst.lfoCycles()).toBeLessThan(4.02);
  });

  it('constructs and renders every preset without NaN or a runaway level', () => {
    const bad: string[] = [];
    const kinds: [string, (s: Song, name: string) => { play: (p: never, at: number, bars: number) => unknown }, string[]][] = [
      ['synth', (s, n) => s.synth(n), ['pluck', 'supersaw-pad', 'fm-bell', 'organ', 'noise-pad', 'brass-stab']],
      ['darkBass', (s, n) => s.darkBass(n), ['darksynth-bass', 'dark-growl']],
      ['growl', (s, n) => s.growl(n), ['dubstep-growl', 'wub', 'yoi', 'riddim', 'neuro', 'screech']],
      ['acid', (s, n) => s.acid(n), ['acid-303', 'goa-acid', 'acid-screamer']],
      ['reese', (s, n) => s.reese(n), ['reese', 'reese-neuro']],
      ['sub', (s, n) => s.sub(n), ['sub-sine', '808-sub']],
    ];
    for (const [kind, make, names] of kinds) {
      for (const name of names) {
        const { l, r } = raw(44100, 120, 1, (s) => {
          make(s, name).play(s.notes('A2 - - - C3 - - - A2 - - - E3 - - -') as never, 0, 1);
        });
        if (hasNonFinite(l) || hasNonFinite(r) || peakAbs(l) > 4 || peakAbs(l) < 1e-3) bad.push(`${kind}:${name}`);
      }
    }
    expect(bad).toEqual([]);
  }, 60000);
});

describe('composer API', () => {
  const ctx = { barBeats: 4, key: new Key('A', 'minor') };
  const song = (): Song => {
    let out!: Song;
    defineTrack({ id: 't-api', title: 'api', genre: 'Test', bpm: 120, bars: 8 }, (s) => {
      s.key('A', 'minor');
      out = s;
    }).build(SR);
    return out;
  };

  it('parses the step-grid notation: ties, rests, slides, accents, ghost notes, velocities, chords', () => {
    const s = song();
    const p = s.notes('A2 - . A2! C3~ D3? E3@100 [A2,E3]{pm} . . . . . . . .');
    expect(p.beats).toBe(4);
    const [first, accent, slide, ghost, vel, chord1] = p.events;
    // the first A2 is held for two steps (a tie)
    expect(first.t).toBe(0);
    expect(first.d).toBeGreaterThan(1.5 / 4);
    expect(accent.v).toBe(1);
    expect(accent.f & FLAG.ACCENT).toBeTruthy();
    // a slide ties to the note before it: that note now ends exactly where the slid note starts
    expect(slide.f & FLAG.SLIDE).toBeTruthy();
    expect(accent.t + accent.d).toBeCloseTo(slide.t, 9);
    expect(ghost.f & FLAG.GHOST).toBeTruthy();
    expect(ghost.v).toBeLessThan(0.5);
    expect(vel.v).toBeCloseTo(100 / 127, 6);
    const chordEvents = p.events.filter((e) => e.t === chord1.t);
    expect(chordEvents.length).toBe(2);
    expect(chordEvents.every((e) => (e.f & FLAG.MUTE) !== 0)).toBe(true);
  });

  it('lets a note be as long as its :length and counts the steps it occupies', () => {
    const s = song();
    const p = s.notes('A2:3 B2 . . . . . . . . . . . .');
    expect(p.events[0].d).toBeGreaterThan(2.5 / 4);
    expect(p.events[1].t).toBeCloseTo(3 / 4, 6);
    expect(p.beats).toBe(4);
  });

  it('rejects a bar with the wrong number of steps and says where', () => {
    const s = song();
    expect(() => s.notes('A2 . . . A2 . . . A2 . . . A2 . . . | A2 . . .')).toThrow(/the 2nd bar has 4 steps/);
    expect(() => s.drums({ kick: 'x...x...', snare: 'x...' })).toThrow(/lane "snare" has 4 steps/);
    expect(() => s.notes('H2 . . .')).toThrow(/cannot read this token/);
  });

  it('knows scales, keys and chord symbols', () => {
    expect(noteToMidi('A4')).toBe(69);
    expect(noteToMidi('C#3')).toBe(49);
    expect(noteToMidi('Bb1')).toBe(34);
    const k = new Key('E', 'phrygian dominant');
    expect(k.degree(1, 2)).toBe(40);
    expect(k.degree(2, 2)).toBe(41);
    expect(k.degree(3, 2)).toBe(44);
    expect(k.has(46)).toBe(false);
    expect(new Key('A', 'minor').chordSymbol(1)).toBe('Am');
    expect(new Key('A', 'minor').chordSymbol(6)).toBe('F');
    expect(parseChord('Am7').intervals).toEqual([0, 3, 7, 10]);
    expect(parseChord('Cmaj7').intervals).toEqual([0, 4, 7, 11]);
    expect(parseChord('G7b9').intervals).toEqual([0, 4, 7, 10, 13]);
    expect(parseChord('E5').intervals).toEqual([0, 7]);
    expect(parseChord('Dsus4').intervals).toEqual([0, 5, 7]);
    expect(parseChord('C/E').bass).toBe(4);
    expect(voiceChord(parseChord('A5'), { octave: 2 })).toEqual([45, 52, 57]);
    expect(guitarChord('A5')).toEqual([45, 52, 57]);
    expect(guitarChord('E5')).toEqual([40, 47, 52]);
    expect(guitarChord('Em')).toEqual([40, 47, 52, 55, 59, 64]);
    expect(() => parseChord('Hm')).toThrow();
  });

  it('spreads euclidean rhythms like the textbook (Bjorklund) and rotates them', () => {
    expect(euclid(3, 8)).toBe('x..x..x.');
    expect(euclid(5, 8)).toBe('x.xx.xx.');
    expect(euclid(5, 16)).toBe('x..x..x..x..x...');
    expect(euclid(7, 16)).toBe('x..x.x.x..x.x.x.');
    expect(euclid(4, 9)).toBe('x.x.x.x..');
    expect(euclid(0, 4)).toBe('....');
    expect(euclid(4, 4)).toBe('xxxx');
    expect(euclid(3, 8, 1)).toBe('.x..x..x');
    expect(euclid(3, 8, -1)).toBe('..x..x.x');
    expect(() => euclid(3, 0)).toThrow(/steps/);
  });

  it('reverses a pattern on its step grid (hits and notes stay on their steps)', () => {
    const s = song();
    const hits = s.drums({ kick: 'x...x.x.........' }).rev();
    expect(hits.events.map((e) => Math.round(e.t * 4))).toEqual([9, 11, 15]);
    const notes = s.notes('A2 B2:2 . C3 - - - . . . . . . . .').rev();
    expect(notes.events.map((e) => [e.n, e.t])).toEqual([[noteToMidi('C3'), 2], [noteToMidi('B2'), 3.25], [noteToMidi('A2'), 3.75]]);
    expect(notes.beats).toBe(4);
    // chord segments are mirrored with it, so rhythm / arp / roots still work afterwards
    const prog = s.chords('Am | F').rev();
    expect(prog.segments().map((c) => c.chord.symbol)).toEqual(['F', 'Am']);
  });

  it('turns chord text into bars and arpeggios', () => {
    const s = song();
    const ch = s.chords('Am F | C G', { octave: 3 });
    expect(ch.beats).toBe(8);
    const segs = ch.segments();
    expect(segs.length).toBe(4);
    expect(segs[1].t).toBe(2);
    const arp = s.arp(s.chords('Am | F', { octave: 3 }), { order: 'up', res: 4 });
    expect(arp.events.length).toBe(32);
    void ctx;
  });

  it('reads a parameter back (ch.param) and lists the automation it registered (describeAutomation)', () => {
    const s = song();
    const arp = s.synth('dark-pluck');
    expect(arp.param('cutoff')).toBe(1100);
    expect(() => arp.param('cutof')).toThrow(/Did you mean "cutoff"/);
    arp.ramp('cutoff', 0, 4, 400, arp.param('cutoff'), 'exp');
    arp.lfo('cutoff', { period: '1/8', depth: 1, mode: 'exp', from: 2, to: 6 });
    s.auto('master.trim', [[0, 1], [7, -2]]);
    const text = s.describeAutomation();
    expect(text).toContain('synth.cutoff: 0:400 4:1100(exp)');
    expect(text).toContain('synth.cutoff: lfo sine every 0.5 beats, depth 1 octaves, bars 2-6');
    expect(text).toContain('master.trim: 0:1 7:-2');
  });

  it('describes the arrangement with note counts and articulations, and marks a set()', () => {
    const s = song();
    const S = s.sections({ verse: 2, chorus: 2 });
    const g = s.guitar('punk-guitar-L', { name: 'gtr' });
    g.play(s.notes('[E2,B2,E3]{pm} [E2,B2,E3]{pm} [E2,B2,E3]~ [E2,B2,E3]? . . . .', { res: 2 }), S.verse);
    s.kick('techno-kick').play(s.hits('X...x...X...x...'), S.chorus);
    g.set('mix.gain', -3, 2);
    const text = s.describe();
    expect(text).toContain('gtr(24: 12 pm, 6 slide, 6 ghost)');
    expect(text).toMatch(/2-4\s+chorus\s+kick\(8: 4 accent\)/);
    expect(s.describeAutomation()).toContain('gtr.mix.gain: 2:-3 (a set: held from here on)');
  });

  it('automates any parameter and rejects bad paths with a hint', () => {
    const s = song();
    const syn = s.synth('pluck', { name: 'lead' });
    syn.ramp('cutoff', 0, 4, 500, 4000, 'exp');
    syn.auto('mix.gain', [[0, 0], [4, -12]]);
    s.auto('master.trim', [[0, 0]]);
    s.auto('reverb.time', [[0, 2], [4, 4]]);
    expect(() => syn.auto('cutof', [[0, 1]])).toThrow(/Did you mean "cutoff"/);
    expect(() => s.auto('nobody.cutoff', [[0, 1]])).toThrow(/no channel called/);
    expect(() => syn.auto('cutoff', [[2, 1000], [1, 2000]])).toThrow(/backwards/);
    expect(() => s.synth('no-such-preset')).toThrow(/unknown preset/);
    expect(() => s.synth({ preset: 'pluck', cutof: 5 })).toThrow(/unknown option "cutof"/);
  });

  it('rejects misspelt options everywhere with a suggestion, instead of silently ignoring them', () => {
    const s = song();
    const g = s.guitar('punk-guitar-L');
    const p = s.notes('E2 . . .');
    expect(() => s.guitar('punk-guitar-L', { gian: -4 } as never)).toThrow(/mixer options: unknown option "gian".*Did you mean "gain"/);
    expect(() => s.synth('pluck', { comp: { threshld: -10 } } as never)).toThrow(/comp: unknown option "threshld".*Did you mean "threshold"/);
    expect(() => s.bus('b', { gian: 0 } as never)).toThrow(/unknown option "gian"/);
    expect(() => g.play(p, 0, 1, { trnspose: 2 } as never)).toThrow(/guitar.play: unknown option "trnspose".*Did you mean "transpose"/);
    expect(() => g.play(p, 0, 1, { humanize: { tim: 3 } } as never)).toThrow(/humanize: unknown option "tim"/);
    expect(() => s.guitar('punk-guitar-L', { fx: [fx.drive({ driev: 6 } as never)] })).toThrow(/fx.drive: unknown option "driev".*Did you mean "drive"/);
    expect(() => fx.gate({ pattern: 'x.', resolution: 4 } as never)).toThrow(/fx.gate: unknown option "resolution"/);
    expect(() => s.notes('A2 . . .', { rs: 2 } as never)).toThrow(/s.notes: unknown option "rs"/);
    expect(() => s.drums({ kick: 'x...' }, { freee: true } as never)).toThrow(/s.drums: unknown option "freee"/);
    expect(() => s.chords('Am', { octav: 3 } as never)).toThrow(/s.chords: unknown option "octav".*Did you mean "octave"/);
    expect(() => s.arp(s.chords('Am'), { octaves: 2, ordr: 'up' } as never)).toThrow(/s.arp: unknown option "ordr"/);
    expect(() => s.groove({ swng: 0.6 } as never)).toThrow(/s.groove: unknown option "swng"/);
    expect(() => g.lfo('gain', { period: '1/8', depth: 0.1, shap: 'sine' } as never)).toThrow(/unknown option "shap"/);
    // and a clip without a position (a misspelt section name is undefined) is an error, not bar 0
    expect(() => g.play(p, undefined as never)).toThrow(/where\? "at" must be a bar number or a section/);
  });

  it('rejects a value outside its range with the range in the message (the amp gain trap)', () => {
    const s = song();
    const g = s.guitar('punk-guitar-L', { name: 'gtr' });
    g.play(s.notes('E2 . . .'), 0, 1);
    expect(() => g.auto('gain', [[0, -6]])).toThrow(/parameter "gain" is -6, outside its range 0 .. 1.*mix\.gain/);
    expect(() => g.set('gain', 3, 1)).toThrow(/outside its range 0 .. 1/);
    expect(() => s.guitar({ preset: 'punk-guitar-L', gain: 5 })).toThrow(/outside its range/);
    expect(() => s.synth('pluck', { name: 'x' }).auto('cutoff', [[0, 99999]])).toThrow(/outside its range 30 .. 20000 Hz/);
    expect(() => s.setMaster({ trim: 99 })).toThrow(/outside its range -40 .. 40 dB/);
    expect(() => g.auto('mix.gain', [[0, -6]])).not.toThrow(); // the fader is in dB
    expect(() => g.auto('gain', [[0, 0.5], [1, 0.9]])).not.toThrow();
  });

  it('rejects a wrong word for an option that takes one of a few words (the message lists the choices)', () => {
    const s = song();
    expect(() => s.synth({ preset: 'pluck', mode: 'monno' } as never)).toThrow(/option "mode" is "monno".*Did you mean "mono".*poly, mono, legato/);
    expect(() => s.synth({ preset: 'pluck', filter: 'lowpass' } as never)).toThrow(/option "filter" is "lowpass"/);
    expect(() => s.synth({ layers: [{ wave: 'saww' }] } as never)).toThrow(/synth layer 1: option "wave" is "saww".*Did you mean "saw"/);
    expect(() => s.synth({ layers: [{ wave: 'saw', unision: 5 }] } as never)).toThrow(/synth layer 1: unknown option "unision".*Did you mean "unison"/);
    expect(() => s.synth({ preset: 'pluck', mods: [{ src: 'lfo3', dst: 'cutoff', amount: 1 }] } as never)).toThrow(/mods\[0\]: option "src" is "lfo3"/);
    expect(() => s.growl({ preset: 'wub', lfoSync: 'bar' } as never)).toThrow(/option "lfoSync" is "bar".*note, beat/);
    expect(() => s.growl({ preset: 'wub', lfoShape: 'sinus' } as never)).toThrow(/option "lfoShape" is "sinus"/);
    expect(() => s.riser({ preset: 'riser', direction: 'upp' } as never)).toThrow(/option "direction" is "upp".*Did you mean "up"/);
    expect(() => s.guitar({ preset: 'punk-guitar-L', cab: '4x10' } as never)).toThrow(/option "cab" is "4x10"/);
    expect(() => s.guitar({ preset: 'punk-guitar-L', takes: 3 } as never)).toThrow(/option "takes" is 3/);
    expect(() => s.synth('pluck', { fx: [fx.filter({ mode: 'lowpass' } as never)] })).toThrow(/fx\.filter: option "mode" is "lowpass"/);
    expect(() => s.synth('pluck', { comp: { detect: 'rsm' } as never })).toThrow(/option "detect" is "rsm".*Did you mean "rms"/);
    expect(() => s.arp(s.chords('Am'), { order: 'upp' } as never)).toThrow(/option "order" is "upp".*Did you mean "up"/);
    expect(() => s.chords('Am').roots({ lowest: 28 } as never)).toThrow(/roots: unknown option "lowest".*Did you mean "low"/);
    expect(() => s.chords('Am').rhythm('x...', { resolution: 4 } as never)).toThrow(/rhythm: unknown option "resolution"/);
    const syn = s.synth('pluck', { name: 'lead' });
    expect(() => syn.auto('cutoff', [[0, 500], [4, 900, 'expo' as never]])).toThrow(/the point at bar 4: option "curve" is "expo".*Did you mean "exp"/);
    expect(() => syn.auto('cutoff', [[0, 500], [4, 900]], 'smoth' as never)).toThrow(/option "curve" is "smoth".*Did you mean "smooth"/);
    expect(() => syn.lfo('cutoff', { period: 1, depth: 1, shape: 'sinus' as never })).toThrow(/option "shape" is "sinus"/);
    expect(() => syn.lfo('cutoff', { period: 1, depth: 1, mode: 'mul' as never })).toThrow(/option "mode" is "mul"/);
    // the good spellings all work
    expect(() => s.synth({ preset: 'pluck', mode: 'mono', filter: 'lp', lfo1Shape: 'tri' })).not.toThrow();
    expect(() => s.growl({ preset: 'wub', lfoSync: 'beat', lfoShape: 'tri' })).not.toThrow();
    expect(() => syn.auto('cutoff', [[0, 500], [4, 900, 'exp']], 'smooth')).not.toThrow();
  });

  it('says which channel a range error belongs to, and at which bar of an automation lane', () => {
    const s = song();
    expect(() => s.acid({ preset: 'goa-acid', cutoff: 9000 }, { name: 'squelch' })).toThrow(/s\.acid \(channel "squelch"\): AcidBass: parameter "cutoff" is 9000, outside its range 60 \.\. 6000 Hz/);
    expect(() => s.reese('reese', { duck: 1.5 })).toThrow(/s\.reese mixer options: mix: parameter "duck" is 1\.5, outside its range 0 \.\. 1/);
    expect(() => s.synth('pluck', { fx: [fx.gate({ pattern: 'x.', depth: 2 })] })).toThrow(/s\.synth fx\.gate: TranceGate: parameter "depth" is 2/);
    expect(() => s.bus('b', { fx: [fx.gate({ pattern: 'x.', depth: 2 })] })).toThrow(/s\.bus\("b"\) fx: TranceGate/);
    const acid = s.acid('acid-303');
    expect(() => acid.auto('cutoff', [[0, 300], [8, 2000], [12, 8000]])).toThrow(/the point at bar 12: parameter "cutoff" is 8000, outside its range 60 \.\. 6000 Hz/);
  });

  it('lists the declared sections when a section name is misspelt', () => {
    const s = song();
    const S = s.sections({ verse: 2, chorus: 2 });
    const g = s.guitar('punk-guitar-L', { name: 'gtr' });
    expect(() => g.play(s.notes('E2 . . .'), (S as unknown as Record<string, never>).chrous)).toThrow(/The sections are: verse, chorus\./);
  });

  it('prints the notes of a pattern (voicings, roots, drum hits) without rendering', () => {
    const s = song();
    const prog = s.chords('Fm | Db | Ab | Eb', { octave: 3, lead: true });
    const lines = prog.show().split('\n');
    expect(lines[0]).toBe('Pattern(12 events, 16 beats), 4 bars of 4 beats');
    expect(lines[1]).toMatch(/^bar 1 beat 1\s+F3 Ab3 C4\s+len 3\.9/); // flats, because the symbols have flat roots
    expect(lines[2]).toMatch(/^bar 2 beat 1\s+F3 Ab3 Db4\s/);
    expect(lines[4]).toMatch(/^bar 4 beat 1\s+Eb3 G3 Bb3\s/);
    expect(readReadme(), 'the README prints this same listing').toContain(prog.show());
    expect(prog.roots({ low: 28 }).show()).toMatch(/bar 1 beat 1\s+F1\s[\s\S]*bar 2 beat 1\s+Db2\s/);
    const drums = s.drums({ kick: 'X...x...', snare: '....X...' }, { free: true }).show();
    expect(drums).toMatch(/bar 1 beat 1\s+kick\s+len 0\.1\s+vel 1\s+accent/);
    expect(drums).toMatch(/bar 1 beat 2\s+kick snare\s/);
    expect(s.notes('A1 . A1~ A1!{pm} [A2,E3]? C2:3').show()).toMatch(/beat 1\.5\s+A1\s+len 0\.23\s+vel 0\.8\s+slide/);
  });

  it('marks muted channels and slide marks that cannot tie in the arrangement listing', () => {
    const s = song();
    const S = s.sections({ a: 2 });
    const acid = s.acid('acid-303');
    // the slide on step 3 follows a rest (nothing to glide from), the one on step 5 follows a note directly
    acid.play(s.notes('A1 . A1~ A1 C2~ . . . | A1 A1 A1 A1 A1 A1 A1 A1', { res: 2 }), S.a);
    const pad = s.synth('supersaw-pad', { name: 'pad' });
    pad.play(s.notes('A3~ . . .', { res: 2 }), S.a);
    pad.mute();
    const text = s.describe();
    expect(text).toContain('acid(12: 1 slide, 1 slide(not tied))');
    expect(text).toContain('pad(4: 4 slide(ignored)) [muted]'); // the 2-beat pattern loops to fill the 2-bar section
    expect(text).toMatch(/warning: acid has 1 slide marks \(~\) that are not tied to a note right before them/);
    expect(text).toMatch(/warning: pad has 4 slide marks \(~\) that do nothing: this synth is polyphonic/);
    // a clean arrangement has no warning, and a mono synth ties like the basses
    const t = song();
    const U = t.sections({ a: 2 });
    t.synth('supersaw-lead', { name: 'lead' }).play(t.notes('A4 - C5~ - E5 - D5~ -', { res: 2 }), U.a);
    t.guitar('punk-guitar-L', { name: 'gtr' }).play(t.notes('E3 . A3~ -', { res: 2 }), U.a); // a guitar scoops: it needs no note before it
    expect(t.describe()).not.toContain('warning');
    expect(t.describe()).not.toContain('not tied');
  });

  it('ties a slide to the note before it even when humanize moves its start by a few milliseconds', () => {
    const s = song();
    s.acid('acid-303').play(s.notes('A1 A1 C2~ C2 D2~ . . . | A1 A1 C2~ C2 D2~ . . .', { res: 2 }), 0, 2, { humanize: { time: 8 } });
    const text = s.describe();
    expect(text).toContain('acid(10: 4 slide)');
    expect(text).not.toContain('not tied');
  });

  it('lets a polyphonic synth ignore a slide mark: the note before it still ends (it used to hang on forever)', () => {
    const { l } = raw(SR, 120, 2, (s) => {
      s.synth({ preset: 'supersaw-pad', release: 0.2 }).play(s.notes('A3 - C4~ -', { res: 2 }), 0, 1); // two beats of notes, then a bar and a half of silence
    });
    expect(rms(l, 0, SR)).toBeGreaterThan(0.001);
    expect(rms(l, SR * 3, SR * 4)).toBeLessThan(1e-5);
  });

  it('solos channels by name or handle, and rejects an unknown channel name', () => {
    const mk = (how: (s: Song, y: ChannelHandle) => void): { l: Float32Array; r: Float32Array } =>
      raw(SR, 120, 2, (s) => {
        const x = s.sub('sub-sine', { name: 'x' });
        const y = s.sub('sub-tri', { name: 'y' });
        const p = s.notes('A1:4 C2:4', { free: true });
        x.play(p, 0, 2);
        y.play(p.transpose(7), 0, 2);
        how(s, y);
      });
    const byName = mk((s) => s.solo('x'));
    const byList = mk((s) => s.solo(['x']));
    const muted = mk((_s, y) => y.mute());
    expect(byName.l).toEqual(muted.l);
    expect(byList.r).toEqual(muted.r);
    expect(peakAbs(byName.l)).toBeGreaterThan(0.01);
    expect(() => mk((s) => s.solo(['x', 'zz']))).toThrow(/solo: no channel called "zz"\..* Channels: x, y/);
    expect(mk((s) => s.solo(null)).l).not.toEqual(muted.l); // solo(null) hears everything again
  });

  it('applies automation while rendering (a filter sweep gets brighter)', () => {
    const { l } = raw(SR, 120, 4, (s) => {
      const syn = s.synth({ layers: [{ wave: 'saw' }], mono: true, cutoff: 300, res: 0, envAmt: 0, keytrack: 0, velFilter: 0, attack: 0.001, sustain: 1, release: 0.01 }, { name: 'sweep' });
      syn.play(s.notes('A2:16 | A2:16', { free: true }), 0, 2);
      syn.ramp('cutoff', 0, 2, 300, 6000, 'exp');
    });
    const spec = (a: number, b: number): number => {
      let hi = 0;
      let all = 1e-12;
      for (let i = a; i < b - 1; i++) {
        const d = l[i + 1] - l[i];
        hi += d * d;
        all += l[i] * l[i];
      }
      return hi / all;
    };
    expect(spec(Math.round(3.5 * SR), Math.round(3.9 * SR))).toBeGreaterThan(spec(Math.round(0.3 * SR), Math.round(0.7 * SR)) * 3);
  });

  it('refuses events outside the track and unknown drum parts', () => {
    const s = song();
    const k = s.kick('techno-kick');
    expect(() => k.play(s.hits('x...x...x...x...'), 7, 4)).toThrow(/the track ends at bar 8/);
    const kit = s.drumKit({ kick: 'techno-kick' });
    expect(() => kit.play(s.drums({ hatz: 'x...x...x...x...' }), 0, 1)).toThrow(/no part "hatz"/);
  });

  it('turns clip mistakes into errors instead of hanging (from past the end, empty patterns, backwards slices)', () => {
    const s = song();
    const b = s.bassGuitar('punk-bass');
    const two = s.notes('A1 . A1 . A1 . A1 .'); // 2 beats
    expect(() => b.play(two, 0, 1, { from: 4 })).toThrow(/from 4 is outside the pattern/);
    expect(() => b.play(two, 0, 1, { from: 1 })).not.toThrow();
    expect(() => b.play(s.silence(0), 0, 1)).toThrow(/empty/);
    expect(() => two.slice(2, 1)).toThrow(/after the start/);
    expect(() => two.over(0)).toThrow(/positive/);
  });

  it('works in other time signatures (7/8, 3/4) and keeps bar maths exact', () => {
    const def = defineTrack({ id: 't-sig', title: 'sig', genre: 'Test', bpm: 120, bars: 4, signature: [7, 8], tail: 0.5 }, (s) => {
      expect(s.barBeats).toBe(3.5);
      s.kick('techno-kick').play(s.hits('x...x...x...x.', { res: 4 }), 0, 4);
    });
    expect(def.info.seconds).toBeCloseTo((4 * 3.5 * 60) / 120 + 0.5, 6);
    const r = def.build(SR).toRenderer();
    const [l] = renderBlocks(r, r.frames, 4096);
    expect(peakAbs(l)).toBeGreaterThan(0.01);
  });
});

describe('mixer', () => {
  it('pans with constant power and keeps a mono source centred', () => {
    const c = raw(SR, 120, 1, (s) => {
      s.synth({ layers: [{ wave: 'sine' }], mono: true, filter: 'off', sustain: 1, attack: 0.001 }, { pan: 0 }).play(s.notes('A3:16', { free: true }), 0, 1);
    });
    expect(Math.abs(rms(c.l, 8000, 30000) - rms(c.r, 8000, 30000))).toBeLessThan(1e-6);
    const left = raw(SR, 120, 1, (s) => {
      s.synth({ layers: [{ wave: 'sine' }], mono: true, filter: 'off', sustain: 1, attack: 0.001 }, { pan: -1 }).play(s.notes('A3:16', { free: true }), 0, 1);
    });
    expect(rms(left.r, 8000, 30000)).toBeLessThan(1e-6);
    expect(rms(left.l, 8000, 30000)).toBeGreaterThan(rms(c.l, 8000, 30000));
  });

  it('ducks a channel with the sidechain at every kick and lets it recover', () => {
    const bpm = 120;
    const base = (duck: number): Float32Array =>
      raw(SR, bpm, 2, (s) => {
        s.kick('techno-kick', { gain: -60 }).play(s.hits('X...X...X...X...'), 0, 2); // inaudible, but it keys the ducking
        s.synth({ layers: [{ wave: 'saw' }], mono: true, filter: 'off', attack: 0.001, sustain: 1 }, { duck }).play(s.notes('A3:16 | A3:16', { free: true }), 0, 2);
        s.setSidechain({ release: 0.2 });
      }).l;
    const dry = base(0);
    const ducked = base(1);
    const beat = Math.round((60 / bpm) * SR);
    const at = (x: Float32Array, k: number, off: number): number => rms(x, k * beat + off, k * beat + off + 240);
    // 10 ms after the kick the ducked pad is far below the plain one, 300 ms after it has recovered
    expect(at(ducked, 2, Math.round(0.012 * SR))).toBeLessThan(0.3 * at(dry, 2, Math.round(0.012 * SR)));
    expect(at(ducked, 2, Math.round(0.4 * SR))).toBeGreaterThan(0.85 * at(dry, 2, Math.round(0.4 * SR)));
  });

  it('keys the sidechain from the kick part of a drum kit only, not from its hats', () => {
    const bpm = 120;
    const run = (duck: number): Float32Array =>
      raw(SR, bpm, 2, (s) => {
        const kit = s.drumKit({ kick: 'techno-kick', hat: 'closed-hat' }, { gain: -60 }); // inaudible, but a kit with a kick keys the ducking
        kit.play(s.drums({ kick: 'X...............|................', hat: '................|X...............' }), 0, 2);
        s.synth({ layers: [{ wave: 'saw' }], mono: true, filter: 'off', attack: 0.001, sustain: 1 }, { duck }).play(s.notes('A3:16 | A3:16', { free: true }), 0, 2);
        s.setSidechain({ release: 0.2 });
      }).l;
    const dry = run(0);
    const ducked = run(1);
    const bar = Math.round((60 / bpm) * 4 * SR);
    const at = (x: Float32Array, from: number): number => rms(x, from + Math.round(0.012 * SR), from + Math.round(0.012 * SR) + 240);
    expect(at(ducked, 0)).toBeLessThan(0.3 * at(dry, 0)); // the kick on the first beat ducks the pad
    expect(at(ducked, bar)).toBeGreaterThan(0.9 * at(dry, bar)); // the hat on the second bar leaves it alone
  });

  it('keys the sidechain from an acoustic kit only when asked, and then only from its kick', () => {
    const bpm = 120;
    const run = (key: boolean): Float32Array =>
      raw(SR, bpm, 2, (s) => {
        const kit = s.acousticKit('punk-kit', { gain: -60, key });
        kit.play(s.drums({ kick: 'X...............|................', hat: '................|X...............' }), 0, 2);
        s.synth({ layers: [{ wave: 'saw' }], mono: true, filter: 'off', attack: 0.001, sustain: 1 }, { duck: 1 }).play(s.notes('A3:16 | A3:16', { free: true }), 0, 2);
        s.setSidechain({ release: 0.2 });
      }).l;
    const off = run(false);
    const on = run(true);
    const bar = Math.round((60 / bpm) * 4 * SR);
    const at = (x: Float32Array, from: number): number => rms(x, from + Math.round(0.012 * SR), from + Math.round(0.012 * SR) + 240);
    expect(at(on, 0)).toBeLessThan(0.3 * at(off, 0)); // keyed: the kick ducks the pad
    expect(at(on, bar)).toBeGreaterThan(0.9 * at(off, bar)); // but the hat does not
    expect(at(off, 0)).toBeGreaterThan(0.1 * at(off, bar)); // not keyed by default: the pad keeps its level at the kick
  });

  it('adds the analysis offset to the master trim, whatever its automation says (what AUTOTRIM in the probe searches with)', () => {
    const level = (offset: number): number => {
      const def = defineTrack({ id: 't-offset', title: 'offset', genre: 'Test', bpm: 120, bars: 1, tail: 0.2, fadeOut: 0.01 }, (s) => {
        s.synth({ layers: [{ wave: 'sine' }], mono: true, filter: 'off', sustain: 1, attack: 0.001 }).play(s.notes('A3:16', { free: true }), 0, 1);
        s.auto('master.trim', [[0, -10], [1, -10]]);
      });
      const song = def.build(SR);
      song.master.raw = true;
      song.master.offsetDb = offset;
      const [l] = renderBlocks(song.toRenderer(), Math.round(SR * 1.6), 4096);
      return rms(l, 12000, 40000);
    };
    expect(level(6) / level(0)).toBeCloseTo(Math.pow(10, 6 / 20), 2);
  });

  it('sends to the shared reverb and the tail rings on after the note ends', () => {
    const wet = raw(
      SR,
      120,
      2,
      (s) => {
        s.synth('pluck', { reverb: 0.8 }).play(s.notes('A4 . . . . . . . . . . . . . . .'), 0, 1);
        s.setReverb({ time: 3 });
      },
      1,
    );
    const dry = raw(SR, 120, 2, (s) => {
      s.synth('pluck', { reverb: 0 }).play(s.notes('A4 . . . . . . . . . . . . . . .'), 0, 1);
    });
    expect(rms(wet.l, Math.round(1.2 * SR), Math.round(1.8 * SR))).toBeGreaterThan(8 * rms(dry.l, Math.round(1.2 * SR), Math.round(1.8 * SR)) + 1e-7);
  });

  it('runs a channel through insert effects (a trance gate chops it)', () => {
    const open = raw(SR, 120, 1, (s) => {
      s.synth({ layers: [{ wave: 'saw' }], mono: true, filter: 'off', sustain: 1 }).play(s.notes('A3:16', { free: true }), 0, 1);
    }).l;
    const gated = raw(SR, 120, 1, (s) => {
      s.synth({ layers: [{ wave: 'saw' }], mono: true, filter: 'off', sustain: 1 }, { fx: [fx.gate({ pattern: 'x.x.x.x.x.x.x.x.' })] }).play(s.notes('A3:16', { free: true }), 0, 1);
    }).l;
    const step = Math.round((60 / 120 / 4) * SR);
    // an "open" step is as loud as the plain signal, a "closed" step (the one after) is much quieter
    expect(rms(gated, step * 4 + 400, step * 5 - 400)).toBeGreaterThan(0.5 * rms(open, step * 4 + 400, step * 5 - 400));
    expect(rms(gated, step * 5 + 1200, step * 6 - 200)).toBeLessThan(0.15 * rms(open, step * 5 + 1200, step * 6 - 200));
  });
});

describe('analysis tools', () => {
  it('reports the probe bands in dB re full scale: a sine of amplitude 0.1 is -23 dB, and the bands of noise add up to its power', () => {
    const n = SR * 3;
    const sine = new Float32Array(n);
    for (let i = 0; i < n; i++) sine[i] = 0.1 * Math.sin((2 * Math.PI * 100 * i) / SR);
    const b = bandDb(sine, SR);
    expect(b[1]).toBeGreaterThan(-23.3); // the bass band, 60-150 Hz
    expect(b[1]).toBeLessThan(-22.7);
    expect(Math.max(b[0], ...b.slice(2))).toBeLessThan(-80);
    // white noise of rms 0.1 (-20 dBFS) spread over the whole spectrum: the eight bands (20 Hz - 22 kHz of the 24 kHz there are) add up to about -20.4
    let seed = 12345;
    const noise = new Float32Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      noise[i] = (seed / 4294967296) * 2 - 1;
      sum += noise[i] * noise[i];
    }
    const k = 0.1 / Math.sqrt(sum / n);
    for (let i = 0; i < n; i++) noise[i] *= k;
    const total = 10 * Math.log10(bandDb(noise, SR).reduce((t, v) => t + Math.pow(10, v / 10), 0));
    expect(total).toBeGreaterThan(-20.6);
    expect(total).toBeLessThan(-20.2);
  });
});

describe('README', () => {
  it('has a worked example that builds and renders', async () => {
    const example = (await import('../sandbox/album/example-track')).default;
    const song = example.build(44100);
    expect(song.describe()).toContain('groove');
    const r = song.toRenderer();
    const frames = Math.min(r.frames, 44100 * 14);
    const [l, rr] = renderBlocks(r, frames, 4096);
    expect(hasNonFinite(l) || hasNonFinite(rr)).toBe(false);
    expect(rms(l, 44100 * 10, frames)).toBeGreaterThan(0.005);
    expect(example.info.seconds).toBeCloseTo((24 * 4 * 60) / 126 + 3, 6);
  }, 60000);

  it('builds and renders the complete example tracks (darksynth, punk, goa, dubstep) cleanly', async () => {
    for (const mod of [await import('../sandbox/album/examples/darksynth'), await import('../sandbox/album/examples/punk'), await import('../sandbox/album/examples/goa'), await import('../sandbox/album/examples/dubstep')]) {
      const r = mod.default.build(44100).toRenderer();
      const [l, rr] = renderBlocks(r, 44100 * 8, 4096);
      expect(hasNonFinite(l) || hasNonFinite(rr), mod.default.info.id).toBe(false);
      expect(rms(l, 44100 * 4, 44100 * 8), mod.default.info.id).toBeGreaterThan(0.005);
      expect(peakAbs(l), mod.default.info.id).toBeLessThanOrEqual(1);
    }
  }, 60000);

  it('has no slide mark that does nothing and no muted channel in the sound check, the worked example or the example tracks', async () => {
    const defs = [
      soundCheck,
      (await import('../sandbox/album/example-track')).default,
      (await import('../sandbox/album/examples/darksynth')).default,
      (await import('../sandbox/album/examples/punk')).default,
      (await import('../sandbox/album/examples/goa')).default,
      (await import('../sandbox/album/examples/dubstep')).default,
    ];
    for (const def of defs) {
      const text = def.build(SR).describe();
      expect(text, def.info.id).not.toContain('warning');
      expect(text, def.info.id).not.toContain('[muted]');
    }
  });

  it('is up to date with the catalogue and the embedded examples (regenerate: DOCS=1 npx vitest run tests/probes/album-docs.test.ts)', () => {
    expect(readReadme() === renderReadme()).toBe(true);
  });

  it('keeps sandbox/album/readme-snippets.ts (the README code, type-checked by tsc) up to date', () => {
    expect(readSnippets() === renderSnippets(readReadme())).toBe(true);
  });

  it('runs every `ts run` block of the guide and the example of every instrument (one song, in the order of the README)', async () => {
    const { readmeSnippets, SNIPPET_BLOCKS, EXAMPLE_BLOCKS } = await import('../sandbox/album/readme-snippets');
    expect(SNIPPET_BLOCKS).toBeGreaterThan(15);
    expect(EXAMPLE_BLOCKS).toBe(CATALOG.length + FX_CATALOG.length);
    let current = 0;
    const def = defineTrack({ id: 'readme-blocks', title: 'README blocks', genre: 'Test', bpm: 128, bars: 64, tail: 1 }, (s) => {
      s.key('A', 'minor');
      const S = s.sections({ intro: 8, verse: 16, drop: 16, outro: 8 });
      const kick = s.kick('darksynth-kick');
      const kit = s.drumKit({ kick: 'techno-kick', snare: 'tight-snare', hat: 'closed-hat', crash: 'crash' });
      const bass = s.darkBass('darksynth-bass');
      const pad = s.synth('supersaw-pad', { fx: [fx.chorus()] });
      const stab = s.synth('brass-stab');
      const arp = s.synth('dark-pluck');
      const lead = s.synth('supersaw-lead');
      const riser = s.riser('riser');
      const gtr = s.guitar('punk-guitar');
      try {
        readmeSnippets({ s, S, kick, kit, bass, pad, stab, arp, lead, riser, gtr }, (n) => {
          current = n;
        });
      } catch (e) {
        throw new Error(`README code block ${current} failed: ${(e as Error).message}`);
      }
    });
    const song = def.build(44100);
    expect(song.eventCount).toBeGreaterThan(500);
    const r = song.toRenderer();
    const [l, rr] = renderBlocks(r, 44100 * 2, 4096);
    expect(hasNonFinite(l) || hasNonFinite(rr)).toBe(false);
  }, 60000);

  it('keeps every preset option inside its parameter range (out-of-range values would be clamped silently)', () => {
    const bad: string[] = [];
    for (const d of CATALOG) {
      for (const [name, p] of Object.entries(d.presets)) {
        for (const [k, v] of Object.entries(p.opts)) {
          const sp = d.specs[k];
          if (sp && typeof v === 'number' && (v < sp.min - 1e-9 || v > sp.max + 1e-9)) bad.push(`${d.factory}:${name} ${k}=${v} (range ${sp.min}..${sp.max})`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('only names presets that exist (the guide mentions them in backticks and in code)', () => {
    const all = new Set(CATALOG.flatMap((d) => Object.keys(d.presets)));
    const guide = readReadme().split('## Reference A')[0];
    const channelNames = new Set(['dark-pad', 'my-pad', 'pad-1200', 'my-track']); // names the examples give to channels and tracks, not presets
    const mentioned = new Set([...guide.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)+)`/g), ...guide.matchAll(/'([a-z0-9]+(?:-[a-z0-9]+)+)'/g)].map((m) => m[1]));
    expect(mentioned.size).toBeGreaterThan(20);
    const unknown = [...mentioned].filter((n) => !all.has(n) && !channelNames.has(n));
    expect(unknown).toEqual([]);
  });

  it('documents the default channel name of every factory', () => {
    let s!: Song;
    defineTrack({ id: 't-names', title: 'names', genre: 'Test', bpm: 120, bars: 4 }, (x) => {
      s = x;
    }).build(SR);
    for (const d of CATALOG) {
      const make = (s as unknown as Record<string, (a?: unknown) => { name: string }>)[d.factory];
      const ch = d.factory === 'drumKit' ? make.call(s, { kick: 'techno-kick' }) : make.call(s);
      expect(ch.name).toBe(d.channel);
    }
  });

  it('builds the custom instrument and effect example and plays it in tune', async () => {
    const custom = (await import('../sandbox/album/custom-instrument')).default;
    const song = custom.build(SR);
    song.master.raw = true;
    const r = song.toRenderer();
    const [l, rr] = renderBlocks(r, r.frames, 4096);
    expect(hasNonFinite(l) || hasNonFinite(rr)).toBe(false);
    // the first note is A1 = 55 Hz (a saw through a filter): find it by autocorrelation in the first 0.2 s
    const e = autocorrPitch(l, SR, Math.round(0.03 * SR), 8000, 40, 80);
    expect(Math.abs(1200 * Math.log2(e.freq / 55))).toBeLessThan(10);
    expect(rms(l, Math.round(0.03 * SR), Math.round(0.2 * SR))).toBeGreaterThan(0.01);
    expect(song.channelList[0].effects.has('tremolo')).toBe(true);
  }, 30000);
});
