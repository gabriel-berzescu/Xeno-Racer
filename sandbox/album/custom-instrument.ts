// The custom instrument and effect of src/audio/album/README.md (the README embeds this file; tests/album-engine.test.ts renders it).
import { ParamBase, customFx, defineTrack, dsp, type Ctx, type Effect, type Instrument, type ParamSpecs } from '../../src/audio/album/song';

// ── an instrument: a mono band-limited saw through a resonant filter and an ADSR ─────────────────────────────────
const BUZZ_SPECS = {
  cutoff: { default: 1200, min: 50, max: 12000, unit: 'Hz', curve: 'exp', doc: 'Filter cutoff.' },
  res: { default: 1.2, min: 0.5, max: 12, doc: 'Filter resonance (Q).' },
  release: { default: 0.15, min: 0.01, max: 3, unit: 's', doc: 'Release time.' },
} satisfies ParamSpecs; // name, default, range, unit, doc: what automation, validation and the README tables are made from

class Buzz extends ParamBase<typeof BUZZ_SPECS> implements Instrument {
  readonly stereo = false; // a mono source writes only `l`; the channel strip pans it
  private readonly sr: number;
  private readonly env = new dsp.Adsr();
  private readonly filter = new dsp.Svf();
  private phase = 0;
  private dt = 0; // phase step per sample
  private gain = 0;
  constructor(ctx: Ctx, opts: Partial<Record<keyof typeof BUZZ_SPECS, number>> = {}) {
    super('Buzz', BUZZ_SPECS, opts); // the options are the starting values of the parameters
    this.sr = ctx.sr;
  }
  noteOn(note: number, vel: number): void {
    this.dt = dsp.mtof(note) / this.sr;
    this.gain = 0.15 + 0.5 * vel;
    this.env.set(0.003, 0.3, 0.6, this.params.release, this.sr);
    this.env.gateOn();
  }
  noteOff(): void {
    this.env.gateOff();
  }
  hit(): void {} // this is not a drum
  active(): boolean {
    return this.env.active; // idle instruments are skipped: say when the sound has really ended
  }
  process(l: Float64Array, _r: Float64Array, n: number): void {
    if (!this.env.active) return;
    this.filter.set(this.params.cutoff, this.params.res, this.sr); // read the (automated) parameters once per call
    let ph = this.phase;
    for (let i = 0; i < n; i++) {
      ph += this.dt;
      if (ph >= 1) ph -= 1;
      l[i] += this.filter.step(dsp.sawBL(ph, this.dt)) * this.env.next() * this.gain; // add into the buffer, never overwrite
    }
    this.phase = ph;
  }
}

// ── an effect: a tempo-locked tremolo ─────────────────────────────────────────────────────────────────────────
const TREMOLO_SPECS = {
  depth: { default: 0.7, min: 0, max: 1, doc: 'How far the level dips.' },
  rate: { default: 2, min: 0.0625, max: 32, unit: 'cycles/beat', doc: 'Speed, locked to the tempo (2 = eighth notes).' },
} satisfies ParamSpecs;

class Tremolo extends ParamBase<typeof TREMOLO_SPECS> implements Effect {
  readonly mono = true; // the same gain on both sides: a mono channel stays mono through it
  private readonly framesPerBeat: number;
  constructor(private readonly ctx: Ctx, opts: Partial<Record<keyof typeof TREMOLO_SPECS, number>> = {}) {
    super('Tremolo', TREMOLO_SPECS, opts);
    this.framesPerBeat = (ctx.sr * 60) / ctx.bpm;
  }
  processMono(x: Float64Array, n: number): void {
    const beat = this.ctx.transport.beat; // song position of x[0], so the tremolo never drifts from the beat
    const { depth, rate } = this.params;
    for (let i = 0; i < n; i++) x[i] *= 1 - depth * 0.5 * (1 - Math.cos(dsp.TAU * (beat + i / this.framesPerBeat) * rate));
  }
  process(l: Float64Array, r: Float64Array, n: number): void {
    this.processMono(l, n);
    this.processMono(r, n);
  }
  active(): boolean {
    return false; // no tail
  }
}

export default defineTrack({ id: 'custom', title: 'Custom Instrument', genre: 'Test', bpm: 120, bars: 4, tail: 1 }, (s) => {
  s.key('A', 'minor');
  // s.add(name, make, mix): the new instrument is an ordinary channel from here on
  const buzz = s.add('buzz', (ctx) => new Buzz(ctx, { cutoff: 900 }), { gain: -6, reverb: 0.1, fx: [customFx('tremolo', 'tremolo', (ctx) => new Tremolo(ctx))] });
  buzz.play(s.notes('A1 . A1 A1 . A1 C2 . | A1 . A1 A1 . E2! D2 - | A1 . A1 A1 . A1 C2 . | G1 . G1 G1 . B1 D2 -', { res: 2 }), 0, 4);
  buzz.ramp('cutoff', 0, 4, 400, 4000, 'exp'); // your parameters are automatable like the built-in ones
  buzz.auto('fx.tremolo.depth', [[0, 0], [2, 0], [3, 0.9]]); // so are the parameters of your effect
});
