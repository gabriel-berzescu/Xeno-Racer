/**
 * The synth's attack click (click, clickDecay, clickTone, clickKeytrack): a short burst of band-passed noise at the start of every new note.
 * It is off by default and then the synth must be what it always was, sample for sample: the golden hashes below were taken before it existed.
 */
import { describe, expect, it } from 'vitest';
import { defineTrack } from '../src/audio/album/song';
import { FLAG } from '../src/audio/album/instrument';
import { Synth } from '../src/audio/album/instruments/synth';
import type { SynthOpts } from '../src/audio/album/instruments/synth';
import { makeCtx, playScript, synthHashes } from '../sandbox/album/lab/golden-renders';
import type { ScriptEvent } from '../sandbox/album/lab/golden-renders';
import { CLICK_ONLY, clickAlone, repeated, rmsOf, spectrumCentre } from '../sandbox/album/lab/click-lab';
import { hasNonFinite } from '../src/audio/analysis';

const SR = 48000;

// The hashes of the synth rendered by sandbox/album/lab/golden-renders.ts, taken before the click existed. If you change the synth on
// purpose, run `node sandbox/album/run.mjs sandbox/album/lab/golden-renders.ts` and paste what it prints here.
const SYNTH_GOLDEN: Record<string, string> = {
  'supersaw-pad': '9491a035fe80048c',
  'supersaw-chord': 'ac7adad6a3ca1892',
  'warm-pad': '0f6ebe98ee9afe68',
  'string-pad': '76d505182f598a68',
  'brass-stab': 'f422a4ed3d8f6cf7',
  pluck: 'd69f4de95f2944ea',
  'dark-pluck': '2719410e6e2dc246',
  'trance-pluck': 'c6e8490d3e673b5a',
  'arp-bright': '35c2bd71659a9057',
  'fm-epiano': '76b1a54867da5126',
  'fm-bell': 'cc888fc5c019dcc3',
  organ: 'a43cf58f0c1fe197',
  'noise-pad': '16b7fb041896ac93',
  'fm-bass-pluck': '21056cbabada9507',
  'supersaw-lead': '8cc882e18edbaaec',
  'saw-lead': '951c0a4fb2c87d54',
  'square-lead': '5688f7d16224e6dd',
  'trance-lead': '99d7ecbcbe3c490e',
  'psy-bass': '613f99ddebe58802',
  'pluck with noise and sub': 'c606f3b27428011d',
  'plain saw, no filter': 'c6d75c3ec67c6d75',
};

const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-12));
const cents = (a: number, b: number): number => 1200 * Math.log2(a / b);

function play(opts: SynthOpts | string, events: ScriptEvent[], seconds: number, bpm = 120): { l: Float64Array; r: Float64Array } {
  const ctx = makeCtx(SR, bpm);
  return playScript(new Synth(ctx, opts), ctx, events, seconds);
}
const one = (note = 60, vel = 0.8, beats = 2): ScriptEvent[] => [{ beat: 0, kind: 'on', note, vel }, { beat: beats, kind: 'off', note }];

describe('the synth with the click off', () => {
  it('renders sample for sample what it rendered before the click existed (every preset, mono and stereo, poly and legato)', () => {
    expect(synthHashes()).toEqual(SYNTH_GOLDEN);
  });

  it('is untouched by the other click settings while click is 0', () => {
    for (const preset of ['pluck', 'supersaw-chord', 'saw-lead']) {
      const a = play(preset, one(), 1);
      const b = play({ preset, clickDecay: 0.1, clickTone: 9000, clickKeytrack: 1 } as SynthOpts, one(), 1);
      expect(Buffer.compare(Buffer.from(a.l.buffer), Buffer.from(b.l.buffer)), preset).toBe(0);
      expect(Buffer.compare(Buffer.from(a.r.buffer), Buffer.from(b.r.buffer)), preset).toBe(0);
    }
  });
});

describe('the synth attack click', () => {
  it('has the parameters, with their ranges, and checks them', () => {
    const s = new Synth(makeCtx(SR, 120), 'pluck');
    expect(s.specs.click).toMatchObject({ default: 0, min: 0, max: 1 });
    expect(s.specs.clickDecay).toMatchObject({ default: 0.012, unit: 's' });
    expect(s.specs.clickTone).toMatchObject({ default: 2500, unit: 'Hz' });
    expect(s.specs.clickKeytrack).toMatchObject({ default: 0.5 });
    expect(() => new Synth(makeCtx(SR, 120), { preset: 'pluck', click: 2 } as SynthOpts)).toThrow(/parameter "click" is 2, outside its range 0 \.\. 1/);
    expect(() => new Synth(makeCtx(SR, 120), { preset: 'pluck', clickTone: 50 } as SynthOpts)).toThrow(/parameter "clickTone" is 50/);
    expect(() => new Synth(makeCtx(SR, 120), { preset: 'pluck', clikc: 1 } as never)).toThrow(/unknown option "clikc".*Did you mean "click"/);
  });

  it('is a transient at the start of the note, on the frame of the note, and is gone after a few decay times', () => {
    const tau = 0.012;
    const frames = 137; // an odd tempo: the note frame is not a round number
    const ctx = makeCtx(SR, 137);
    const fpb = (SR * 60) / 137;
    const ev: ScriptEvent[] = [];
    for (let k = 1; k < 6; k++) ev.push({ beat: k, kind: 'on', note: 60, vel: 0.8 }, { beat: k + 0.5, kind: 'off', note: 60 });
    const x = playScript(new Synth(ctx, { ...CLICK_ONLY, click: 1, clickDecay: tau } as SynthOpts), ctx, ev, 6.5 * (60 / 137)).l;
    void frames;
    for (let k = 1; k < 6; k++) {
      const f = Math.round(k * fpb);
      let first = f - 100;
      while (Math.abs(x[first]) < 1e-12) first++;
      expect(first, `note ${k}`).toBe(f); // the click starts on the sample of the note
      expect(rmsOf(x, f - 480, f), `silence before note ${k}`).toBeLessThan(1e-9);
      const head = rmsOf(x, f, f + Math.round(0.003 * SR));
      expect(head).toBeGreaterThan(1e-3);
      // 8.7 dB down per decay time, 26 dB after three, gone (-60 dB or more) after eight
      expect(db(rmsOf(x, f + Math.round(3 * tau * SR), f + Math.round(3.5 * tau * SR))) - db(head), `note ${k} after 3 decay times`).toBeLessThan(-18);
      expect(db(rmsOf(x, f + Math.round(8 * tau * SR), f + Math.round(8.5 * tau * SR))) - db(head), `note ${k} after 8 decay times`).toBeLessThan(-55);
    }
  });

  it('follows its envelope: the time to fall 20 dB is ln(10) * clickDecay', () => {
    for (const tau of [0.003, 0.012, 0.05]) {
      const x = clickAlone({ clickDecay: tau }, 60, 40);
      const win = Math.round(0.001 * SR);
      const hop = Math.round(0.25 * SR);
      const env: number[] = [];
      for (let w = 0; w < 300; w++) {
        let e = 0;
        for (let k = 0; k < 40; k++) e += Math.pow(rmsOf(x, k * hop + w * win, k * hop + (w + 1) * win), 2);
        env.push(Math.sqrt(e / 40));
      }
      const t20 = env.findIndex((v) => v < env[0] * 0.1);
      expect(t20, `tau ${tau}`).toBeGreaterThanOrEqual(Math.floor(Math.LN10 * tau * 1000) - 1);
      expect(t20, `tau ${tau}`).toBeLessThanOrEqual(Math.ceil(Math.LN10 * tau * 1000) + 2);
    }
  });

  it('is centred where clickTone says, and follows the pitch of the note by clickKeytrack', () => {
    for (const [tone, key, note] of [[2500, 0, 60], [2500, 0.5, 60], [2500, 0.5, 48], [2500, 0.5, 84], [2500, 1, 72], [800, 0.5, 60], [6000, 0, 60], [400, 0, 60], [10000, 0, 60]] as const) {
      const x = clickAlone({ clickTone: tone, clickKeytrack: key }, note, 60);
      const want = tone * Math.pow(2, (key * (note - 60)) / 12);
      const c = spectrumCentre(x);
      expect(Math.abs(cents(c.geo, want)), `clickTone ${tone}, keytrack ${key}, note ${note}: ${c.geo.toFixed(0)} Hz against ${want.toFixed(0)} Hz`).toBeLessThan(120);
    }
    // an octave in the note is key octaves in the click
    const lo = spectrumCentre(clickAlone({ clickKeytrack: 1 }, 48, 60)).geo;
    const hi = spectrumCentre(clickAlone({ clickKeytrack: 1 }, 72, 60)).geo;
    expect(Math.abs(cents(hi / lo, 4)), 'two octaves up').toBeLessThan(120);
    const same = spectrumCentre(clickAlone({ clickKeytrack: 0 }, 48, 60)).geo / spectrumCentre(clickAlone({ clickKeytrack: 0 }, 84, 60)).geo;
    expect(Math.abs(cents(same, 1)), 'no keytracking').toBeLessThan(120);
  });

  it('scales with the velocity and with the level of the preset, not with the filter or the amplitude envelope', () => {
    const loud = rmsOf(clickAlone({}, 60, 20, 1), 0, 20 * 12000);
    const soft = rmsOf(clickAlone({}, 60, 20, 0.5), 0, 20 * 12000);
    expect(db(loud) - db(soft)).toBeCloseTo(6.02, 0);
    expect(db(rmsOf(clickAlone({ click: 0.5 }, 60, 20), 0, 20 * 12000)) - db(rmsOf(clickAlone({ click: 1 }, 60, 20), 0, 20 * 12000))).toBeCloseTo(-6.02, 0);
    // the level trim of the synth moves it like the body
    expect(db(rmsOf(clickAlone({ level: 6 }, 60, 20), 0, 20 * 12000)) - db(rmsOf(clickAlone({ level: 0 }, 60, 20), 0, 20 * 12000))).toBeCloseTo(6, 0);
    // and it keeps its loudness as its tone moves (a constant-Q band-pass would get louder with its centre)
    const a = rmsOf(clickAlone({ clickTone: 800, clickKeytrack: 0 }, 60, 60), 0, 60 * 12000);
    const b = rmsOf(clickAlone({ clickTone: 6000, clickKeytrack: 0 }, 60, 60), 0, 60 * 12000);
    expect(Math.abs(db(a) - db(b))).toBeLessThan(1.5);
  });

  it('survives a dark filter and a slow attack (it is added after the filter and outside the amplitude envelope)', () => {
    const hp = (x: Float64Array, a: number, b: number): number => {
      const y = new Float64Array(x.length);
      for (let i = 2; i < x.length; i++) y[i] = x[i] - 2 * x[i - 1] + x[i - 2]; // a crude 2 kHz high-pass
      return rmsOf(y, a, b);
    };
    const w = Math.round(0.03 * SR);
    for (const opts of [
      { preset: 'pluck', cutoff: 150, envAmt: 0, keytrack: 0, velFilter: 0 },
      { preset: 'warm-pad', attack: 0.7 },
    ] as SynthOpts[]) {
      const off = play({ ...opts, click: 0 }, one(60, 0.8, 2), 1).l;
      const on = play({ ...opts, click: 0.5 }, one(60, 0.8, 2), 1).l;
      expect(db(hp(on, 0, w)) - db(hp(off, 0, w)), JSON.stringify(opts)).toBeGreaterThan(40);
      // and the rest of the note is the note: after the click the two renders agree
      let worst = 0;
      for (let i = Math.round(0.2 * SR); i < SR; i++) worst = Math.max(worst, Math.abs(on[i] - off[i]));
      expect(worst, JSON.stringify(opts)).toBeLessThan(1e-9);
    }
  });

  it('is the same every time, and does not depend on how the song is cut into segments; every note has its own noise', () => {
    const chord: ScriptEvent[] = [
      ...[60, 64, 67].map((n): ScriptEvent => ({ beat: 0, kind: 'on', note: n, vel: 0.8 })),
      ...[60, 64, 67].map((n): ScriptEvent => ({ beat: 1.5, kind: 'off', note: n })),
      ...[62, 65, 69].map((n): ScriptEvent => ({ beat: 2, kind: 'on', note: n, vel: 0.8 })),
      ...[62, 65, 69].map((n): ScriptEvent => ({ beat: 3.5, kind: 'off', note: n })),
    ];
    const opts: SynthOpts = { ...CLICK_ONLY, click: 0.8 }; // the click alone: the oscillators and the filter have a segment grid of their own
    const a = play(opts, chord, 2.5);
    const b = play(opts, chord, 2.5);
    expect(Buffer.compare(Buffer.from(a.l.buffer), Buffer.from(b.l.buffer))).toBe(0);
    // the same notes with extra do-nothing events cutting the segments in other places: the same bits
    const cut = [...chord, ...Array.from({ length: 40 }, (_, i): ScriptEvent => ({ beat: 0.013 + i * 0.0617, kind: 'off', note: 20 }))];
    const c = play(opts, cut, 2.5);
    expect(Buffer.compare(Buffer.from(a.l.buffer), Buffer.from(c.l.buffer))).toBe(0);
    expect(hasNonFinite(a.l) || hasNonFinite(a.r)).toBe(false);
    // two notes struck one after the other do not click with the same noise
    const x = clickAlone({}, 60, 2);
    const n = Math.round(0.25 * SR);
    let same = 0;
    let e = 0;
    for (let i = 0; i < 200; i++) {
      same += x[i] * x[n + i];
      e += x[i] * x[i];
    }
    expect(Math.abs(same / e)).toBeLessThan(0.5);
  });

  it('is not made again by a tied (slid) note, and a note after it is', () => {
    const lead: SynthOpts = { ...CLICK_ONLY, mode: 'legato', voices: 1, click: 1, glide: 0.05 };
    const ev = (slide: boolean): ScriptEvent[] => [
      { beat: 0, kind: 'on', note: 60, vel: 0.8 },
      { beat: 2, kind: 'on', note: 64, vel: 0.8, flags: slide ? FLAG.SLIDE : 0 },
      { beat: 3, kind: 'off', note: 64 },
    ];
    const tied = play(lead, ev(true), 2).l;
    const fresh = play(lead, ev(false), 2).l;
    const f2 = SR; // beat 2 at 120 BPM
    // legato mode retriggers only when no key is held: a tied note does not click again, a plain next note (the first is still held, so it is legato
    // too) does not either; with the first note released before the next one starts, it does
    expect(rmsOf(tied, f2, f2 + 144)).toBeLessThan(1e-9);
    expect(rmsOf(fresh, f2, f2 + 144)).toBeLessThan(1e-9);
    const apart: ScriptEvent[] = [
      { beat: 0, kind: 'on', note: 60, vel: 0.8 },
      { beat: 1, kind: 'off', note: 60 },
      { beat: 2, kind: 'on', note: 64, vel: 0.8 },
      { beat: 3, kind: 'off', note: 64 },
    ];
    const a = play(lead, apart, 2).l;
    expect(rmsOf(a, 0, 144)).toBeGreaterThan(1e-3);
    expect(rmsOf(a, f2, f2 + 144)).toBeGreaterThan(1e-3);
    // mono mode retriggers every note that is not slid
    const mono: SynthOpts = { ...lead, mode: 'mono' };
    expect(rmsOf(play(mono, ev(false), 2).l, f2, f2 + 144)).toBeGreaterThan(1e-3);
    expect(rmsOf(play(mono, ev(true), 2).l, f2, f2 + 144)).toBeLessThan(1e-9);
  });

  it('outlives a very short note, and the voice lives until it is over', () => {
    const ctx = makeCtx(SR, 120);
    const s = new Synth(ctx, { ...CLICK_ONLY, click: 1, clickDecay: 0.05, release: 0.005 } as SynthOpts);
    // a note 1 ms long: its amplitude envelope is over in a few ms, its click is not
    const { l } = playScript(s, ctx, [{ beat: 0, kind: 'on', note: 60, vel: 1 }, { beat: 0.002, kind: 'off', note: 60 }], 0.5);
    expect(rmsOf(l, Math.round(0.03 * SR), Math.round(0.04 * SR))).toBeGreaterThan(0.05 * rmsOf(l, 0, Math.round(0.003 * SR)));
    expect(s.active(), 'the click is over after half a second').toBe(false);
    // while it sounds the channel is active, so that the engine does not put it to sleep
    const ctx2 = makeCtx(SR, 120);
    const s2 = new Synth(ctx2, { ...CLICK_ONLY, click: 1, clickDecay: 0.05, release: 0.005 } as SynthOpts);
    s2.noteOn(60, 1, 0, 0);
    s2.noteOff(60);
    const buf = new Float64Array(64);
    const dummy = new Float64Array(64);
    for (let i = 0; i < 20; i++) s2.process(buf, dummy, 64);
    expect(s2.active()).toBe(true);
  });

  it('is in both channels of a stereo synth, and leaves the harmony check alone (pitches)', () => {
    const st = play({ preset: 'supersaw-chord', click: 1 }, one(60, 0.8, 1), 0.5);
    const base = play({ preset: 'supersaw-chord' }, one(60, 0.8, 1), 0.5);
    let dl = 0;
    let dr = 0;
    let diff = 0;
    for (let i = 0; i < 480; i++) {
      dl += Math.pow(st.l[i] - base.l[i], 2);
      dr += Math.pow(st.r[i] - base.r[i], 2);
      diff += Math.pow(st.l[i] - base.l[i] - (st.r[i] - base.r[i]), 2);
    }
    expect(dl).toBeGreaterThan(1e-6);
    expect(diff / dl, 'the same click in both channels').toBeLessThan(1e-12);
    expect(dr / dl).toBeCloseTo(1, 6);
    for (const preset of ['supersaw-chord', 'pluck', 'fm-epiano', 'organ', 'noise-pad', 'warm-pad']) {
      expect(new Synth(makeCtx(SR, 120), { preset, click: 1 } as SynthOpts).pitches, preset).toEqual(new Synth(makeCtx(SR, 120), preset).pitches);
    }
    // the click is noise: a patch that is nothing but the click has no pitch to clash with
    expect(new Synth(makeCtx(SR, 120), { layers: [{ wave: 'noise' }], click: 1 } as SynthOpts).pitches).toEqual([]);
  });

  it('can be automated through the song (the click grows from note to note), also on a pad', () => {
    const heads: number[] = [];
    const def = defineTrack({ id: 't-click', title: 'click', genre: 'Test', bpm: 120, bars: 5, tail: 0.3, fadeOut: 0.01 }, (s) => {
      const syn = s.synth({ ...CLICK_ONLY } as SynthOpts, { name: 'k' });
      syn.play(s.notes('A3:16 | A3:16 | A3:16 | A3:16 | A3:16', { free: true }), 0, 5);
      syn.auto('click', [[0, 0], [4, 1]]);
      s.master.raw = true;
    });
    const r = def.build(SR).toRenderer();
    const l = new Float32Array(r.frames);
    const rr = new Float32Array(r.frames);
    let pos = 0;
    const bl = new Float32Array(4096);
    const br = new Float32Array(4096);
    while (pos < r.frames) {
      const m = r.render(bl, br, Math.min(4096, r.frames - pos));
      if (!m) break;
      l.set(bl.subarray(0, m), pos);
      rr.set(br.subarray(0, m), pos);
      pos += m;
    }
    for (let bar = 0; bar < 5; bar++) heads.push(rmsOf(l, bar * 2 * SR, bar * 2 * SR + Math.round(0.01 * SR)));
    expect(heads[0]).toBeLessThan(1e-9);
    for (let i = 1; i < 5; i++) expect(heads[i], heads.map((v) => v.toExponential(1)).join(' ')).toBeGreaterThan(heads[i - 1] * 1.05);
    expect(heads[4]).toBeGreaterThan(2.5 * heads[1]); // 1 against 0.25, within the spread of different noise
  });
});
