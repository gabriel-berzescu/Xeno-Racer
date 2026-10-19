/**
 * The synth's glideMode: with 'always' (the default, and what the synth always did) a mono or legato patch with glide above 0 glides into every
 * note whose voice is still sounding, also one that starts in the release of the note before a rest; 'fingered' glides only into a note that
 * starts while the last one is held or touches it, or that is slid (~).
 */
import { describe, expect, it } from 'vitest';
import { FLAG } from '../src/audio/album/instrument';
import { Synth } from '../src/audio/album/instruments/synth';
import type { SynthOpts } from '../src/audio/album/instruments/synth';
import { makeCtx, playScript } from '../sandbox/album/lab/golden-renders';
import type { ScriptEvent } from '../sandbox/album/lab/golden-renders';
import { crossings } from '../sandbox/album/lab/growl-dive-lab';
import { rms } from '../src/audio/analysis';
import { defineTrack } from '../src/audio/album/song';
import type { Song } from '../src/audio/album/song';

const SR = 48000;
const BPM = 120; // a beat is 0.5 s
const C4 = 60; // 261.6 Hz
const G4 = 67; // 392.0 Hz
const hz = (note: number): number => 440 * Math.pow(2, (note - 69) / 12);
const cents = (a: number, b: number): number => 1200 * Math.log2(a / b);

/** A legato sine lead: its zero crossings are its cycles. */
const LEAD: SynthOpts = { layers: [{ wave: 'sine', phase: 'free' }], mode: 'legato', voices: 1, filter: 'off', mono: true, attack: 0.001, sustain: 1, release: 0.3, glide: 0.1 };

function play(opts: SynthOpts, events: ScriptEvent[], seconds = 3): { t: number[]; l: Float64Array } {
  const ctx = makeCtx(SR, BPM);
  const { l } = playScript(new Synth(ctx, opts), ctx, events, seconds);
  return { t: crossings(l, SR, Math.round(0.001 * SR)), l };
}
/** The frequency of the first full cycle that starts at or after `at` seconds. */
function firstCycleAfter(t: number[], at: number): number {
  const i = t.findIndex((x) => x >= at);
  return 1 / (t[i + 1] - t[i]);
}
/** The frequency of the cycle that contains `at`. */
function freqAt(t: number[], at: number): number {
  let i = 0;
  while (i + 2 < t.length && t[i + 1] < at) i++;
  return 1 / (t[i + 1] - t[i]);
}

const on = (beat: number, note: number, flags = 0): ScriptEvent => ({ beat, kind: 'on', note, vel: 0.8, flags });
const off = (beat: number, note: number): ScriptEvent => ({ beat, kind: 'off', note });

// the second note (G4) starts at 0.75 s in the "gap" case, at 0.5 s in the others
const GAP = [on(0, C4), off(1, C4), on(1.5, G4), off(4, G4)]; // C4 is released at 0.5 s and still ringing out (release 0.3 s) when G4 starts at 0.75 s
const OVERLAP = [on(0, C4), on(1, G4), off(1.5, C4), off(4, G4)]; // G4 starts at 0.5 s while C4 is held
const TOUCH = [on(0, C4), off(1, C4), on(1, G4), off(4, G4)]; // C4 ends on the very tick G4 starts (what .legato() makes)
const NEAR = [on(0, C4), off(0.92, C4), on(1, G4), off(4, G4)]; // the default gate: 8 % of a step of air between two notes in a row
const TIED = [on(0, C4), on(1.5, G4, FLAG.SLIDE), off(4, G4)]; // what the song makes of `C4 - - - G4~`: the end of C4 is dropped, G4 is slid (starts at 0.75 s)
const SLID_AFTER_GAP = [on(0, C4), off(1, C4), on(1.5, G4, FLAG.SLIDE), off(4, G4)]; // a slide mark that follows a gap (the song warns about it)

describe('synth glideMode', () => {
  it("'always' is the default and what the synth always did; the option is checked", () => {
    for (const events of [GAP, OVERLAP, TOUCH, NEAR, TIED, SLID_AFTER_GAP]) {
      const a = play(LEAD, events);
      const b = play({ ...LEAD, glideMode: 'always' }, events);
      expect(Buffer.compare(Buffer.from(a.l.buffer), Buffer.from(b.l.buffer))).toBe(0);
    }
    expect(() => new Synth(makeCtx(SR, BPM), { ...LEAD, glideMode: 'fingerd' } as never)).toThrow(/option "glideMode" is "fingerd".*Did you mean "fingered".*always, fingered/);
    expect(() => new Synth(makeCtx(SR, BPM), { preset: 'supersaw-lead', glideMode: 'fingered' })).not.toThrow();
    // a polyphonic synth has no portamento between notes: the option changes nothing there
    const chord = [on(0, C4), on(0, G4), off(2, C4), off(2, G4), on(2.5, 64), off(3, 64)];
    const p1 = play({ ...LEAD, mode: 'poly', voices: 4, glide: 0.1 }, chord);
    const p2 = play({ ...LEAD, mode: 'poly', voices: 4, glide: 0.1, glideMode: 'fingered' }, chord);
    expect(Buffer.compare(Buffer.from(p1.l.buffer), Buffer.from(p2.l.buffer))).toBe(0);
  });

  it("with a gap, 'always' still glides into the note out of the release of the one before; 'fingered' starts the note on its own pitch", () => {
    const always = play(LEAD, GAP);
    const fingered = play({ ...LEAD, glideMode: 'fingered' }, GAP);
    const at = 0.75; // G4 starts
    // today: the pitch is still near C4 in the first cycle and glides up over a few tenths of a second
    expect(firstCycleAfter(always.t, at + 0.0005), 'always: the first cycle').toBeLessThan(hz(G4) * 0.9);
    expect(Math.abs(cents(freqAt(always.t, at + 1.2), hz(G4)))).toBeLessThan(5);
    // fingered: the first cycle already is G4
    expect(Math.abs(cents(firstCycleAfter(fingered.t, at + 0.0005), hz(G4))), 'fingered: the first cycle').toBeLessThan(25);
    expect(Math.abs(cents(freqAt(fingered.t, at + 0.05), hz(G4)))).toBeLessThan(5);
    // and the first note is the same in both
    expect(Math.abs(cents(freqAt(fingered.t, 0.3), hz(C4)))).toBeLessThan(5);
  });

  it("with overlapping notes, 'fingered' glides with `glide` like 'always' (and the longer the glide the slower)", () => {
    for (const mode of ['legato', 'mono'] as const) {
      const a = play({ ...LEAD, mode }, OVERLAP);
      const f = play({ ...LEAD, mode, glideMode: 'fingered' }, OVERLAP);
      for (const r of [a, f]) {
        const first = firstCycleAfter(r.t, 0.5005);
        expect(first, `${mode}: the first cycle is still near C4`).toBeLessThan(hz(G4) * 0.9);
        expect(first).toBeGreaterThan(hz(C4) * 0.97);
        expect(Math.abs(cents(freqAt(r.t, 0.5 + 1.2), hz(G4)))).toBeLessThan(5);
      }
      // the same glide in both modes: the pitch 80 ms into it agrees to a few cents
      expect(Math.abs(cents(freqAt(f.t, 0.58), freqAt(a.t, 0.58))), mode).toBeLessThan(10);
    }
    // a slower glide takes longer: 0.4 s against 0.1 s
    const slow = play({ ...LEAD, glideMode: 'fingered', glide: 0.4 }, OVERLAP);
    const quick = play({ ...LEAD, glideMode: 'fingered', glide: 0.1 }, OVERLAP);
    expect(freqAt(slow.t, 0.5 + 0.2)).toBeLessThan(freqAt(quick.t, 0.5 + 0.2));
  });

  it("with touching notes (one ends on the tick the next starts: .legato()) 'fingered' glides; with the air of the default gate between them it does not", () => {
    const touch = play({ ...LEAD, glideMode: 'fingered' }, TOUCH);
    expect(firstCycleAfter(touch.t, 0.5005), 'touching').toBeLessThan(hz(G4) * 0.9);
    expect(Math.abs(cents(freqAt(touch.t, 1.7), hz(G4)))).toBeLessThan(5);
    const near = play({ ...LEAD, glideMode: 'fingered' }, NEAR);
    expect(Math.abs(cents(firstCycleAfter(near.t, 0.5005), hz(G4))), 'a gap of 8 % of a step').toBeLessThan(25);
    // 'always' glides into both
    expect(firstCycleAfter(play(LEAD, NEAR).t, 0.5005)).toBeLessThan(hz(G4) * 0.9);
  });

  it('keeps the slide flag: a slid note glides in both modes, and at least 60 ms', () => {
    for (const glideMode of ['always', 'fingered'] as const) {
      // the way the song writes it: the note before is held until the slid one starts
      const r = play({ ...LEAD, glide: 0.005, glideMode }, TIED);
      const at = 0.75;
      expect(firstCycleAfter(r.t, at + 0.0005), `${glideMode}: tied`).toBeLessThan(hz(G4) * 0.9);
      // a glide of at least 60 ms (the time constant is a third of it): still short of G4 after 30 ms, on it after half a second
      expect(freqAt(r.t, at + 0.03), glideMode).toBeLessThan(hz(G4) * 0.99);
      expect(Math.abs(cents(freqAt(r.t, at + 0.6), hz(G4))), glideMode).toBeLessThan(5);
    }
    // the mark alone is enough: after a gap, with the note before still ringing out (a long release), a slid note glides in both modes
    // while a plain one glides in 'always' and jumps in 'fingered'
    const ringing: SynthOpts = { ...LEAD, release: 3 };
    for (const glideMode of ['always', 'fingered'] as const) {
      const slid = play({ ...ringing, glideMode }, SLID_AFTER_GAP);
      expect(firstCycleAfter(slid.t, 0.7505), `${glideMode}: slid after a gap`).toBeLessThan(hz(G4) * 0.9);
      const plain = play({ ...ringing, glideMode }, [on(0, C4), off(1, C4), on(1.5, G4), off(4, G4)]);
      const first = firstCycleAfter(plain.t, 0.7505);
      if (glideMode === 'always') expect(first, 'always: plain after a gap').toBeLessThan(hz(G4) * 0.9);
      else expect(Math.abs(cents(first, hz(G4))), 'fingered: plain after a gap').toBeLessThan(25);
    }
  });

  it("connects overlapping notes in 'legato' mode but retriggers notes that only touch (the vibrato starts again): overlap them with .legato(-0.1) or a gate above 1", () => {
    const vib: SynthOpts = { ...LEAD, glide: 0, vibDepth: 60, vibRate: 5, vibDelay: 0.1, release: 0.05 };
    const spread = (t: number[], from: number, to: number): number => {
      const c: number[] = [];
      for (let i = 0; i + 1 < t.length; i++) if (t[i] >= from && t[i + 1] <= to) c.push(1200 * Math.log2(1 / (t[i + 1] - t[i])));
      const m = c.reduce((a, b) => a + b, 0) / c.length;
      return Math.sqrt(c.reduce((a, b) => a + (b - m) * (b - m), 0) / c.length);
    };
    const overlap = play(vib, OVERLAP); // G4 starts at 0.5 s, C4 has been vibrating since 0.1 s
    const touch = play(vib, TOUCH);
    const sOver = spread(overlap.t, 0.55, 0.75);
    const sTouch = spread(touch.t, 0.55, 0.75);
    expect(sOver, `overlapping: ${sOver.toFixed(1)} cents, touching: ${sTouch.toFixed(1)} cents`).toBeGreaterThan(2 * sTouch);
    expect(sOver).toBeGreaterThan(25);
    // the same through the song: Pattern.legato(gap) with a negative gap overlaps the notes, and so does a gate above 1
    const viaSong = (make: (line: ReturnType<Song['notes']>) => ReturnType<Song['notes']>, gate?: number): number => {
      const def = defineTrack({ id: 't-leg', title: 'leg', genre: 'Test', bpm: BPM, bars: 2, tail: 0.2, fadeOut: 0.01 }, (sg) => {
        const line = make(sg.notes('C4 - - - G4 - - - C4 - - - G4 - - -', { res: 4 }));
        sg.synth(vib, { name: 'lead' }).play(line, 0, 1, gate ? { gate } : {});
        sg.master.raw = true;
      });
      const r = def.build(SR).toRenderer();
      const l = new Float32Array(r.frames);
      const rr = new Float32Array(r.frames);
      const bl = new Float32Array(4096);
      const br = new Float32Array(4096);
      for (let pos = 0; pos < r.frames; ) {
        const m = r.render(bl, br, Math.min(4096, r.frames - pos));
        if (!m) break;
        l.set(bl.subarray(0, m), pos);
        rr.set(br.subarray(0, m), pos);
        pos += m;
      }
      // the second note starts at beat 1 = 0.5 s
      return spread(crossings(Float64Array.from(l), SR, Math.round(0.001 * SR)), 0.55, 0.75);
    };
    expect(viaSong((p) => p.legato(-0.1)), 'legato(-0.1)').toBeGreaterThan(25);
    expect(viaSong((p) => p, 1.2), 'gate 1.2').toBeGreaterThan(25);
    expect(viaSong((p) => p.legato()), 'legato()').toBeLessThan(15);
    expect(viaSong((p) => p), 'the default gate').toBeLessThan(15);
  });

  it("makes overlapping notes in 'legato' mode with glide 0 a legato connection without portamento: the pitch jumps, the envelope goes on", () => {
    const slowAttack: SynthOpts = { ...LEAD, glide: 0, attack: 0.5 };
    for (const glideMode of ['always', 'fingered'] as const) {
      const r = play({ ...slowAttack, glideMode }, OVERLAP);
      expect(Math.abs(cents(firstCycleAfter(r.t, 0.5005), hz(G4))), glideMode).toBeLessThan(25);
      // the amplitude does not start again from zero (a retriggered note would swell in for half a second)
      const before = rms(r.l, Math.round(0.45 * SR), Math.round(0.5 * SR));
      const after = rms(r.l, Math.round(0.5 * SR), Math.round(0.55 * SR));
      expect(after / before, glideMode).toBeGreaterThan(0.8);
    }
  });
});
