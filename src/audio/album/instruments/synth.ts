/**
 * The synth: one flexible instrument for pads, supersaw chords, plucks, arps, leads, FM bells, organs and stabs.
 *
 *   oscillator layers (up to 3: saw / square / pulse / triangle / sine / noise / 2-operator FM, each with octave, semitone,
 *   fine tune, level, unison voices with detune and stereo spread)  ->  drive  ->  filter (24 dB ladder or 12 dB SVF)
 *   ->  amplitude envelope. A filter ADSR, a vibrato, two tempo-locked LFOs and a small modulation matrix shape the sound.
 *
 * Three play modes: 'poly' (chords), 'mono' (a lead: last note priority, glide) and 'legato' (envelopes only retrigger when
 * no key is held). In 'mono' and 'legato' a note with the slide flag (~) glides from the previous one without retriggering (it must follow
 * it directly); in 'poly' every note has its own voice and a slide mark does nothing. `glide` (portamento) glides into every note whose voice is
 * still sounding, or with `glideMode: 'fingered'` only into a note that starts while the last one is held, touches it, or is slid.
 *
 * Build a new patch by passing options (`s.synth({ layers: [...], cutoff: 900, attack: 0.4 })`) or start from a preset
 * (`s.synth({ preset: 'supersaw-pad', cutoff: 1500 })`). Parameters are listed in SYNTH_SPECS, presets in SYNTH_PRESETS.
 */
import { Noise, Rng, TAU, clamp, dbToLin, mtof, sinCyc, tanh3 } from '../dsp/core';
import { Adsr, ENV_IDLE } from '../dsp/env';
import { Ladder, Svf } from '../dsp/filters';
import { addPulse, addSaw, addSine, addTri } from '../dsp/osc';
import { BLOCK, Ctx, FLAG, Instrument, LFO_SHAPES, ParamBase, ParamSpecs, PresetDef, checkKeys, pickWord, resolveOpts } from '../instrument';

export const SYNTH_SPECS = {
  level: { default: 0, min: -40, max: 24, unit: 'dB', doc: 'Trim in dB on top of the preset\'s calibrated loudness (0 = as calibrated; the fader is the channel\'s `gain` in the mix).' },
  cutoff: { default: 6000, min: 30, max: 20000, unit: 'Hz', curve: 'exp', doc: 'Filter cutoff (before envelope, key tracking and modulation).' },
  res: { default: 0.15, min: 0, max: 1, doc: 'Filter resonance (0.7+ rings, 0.95+ self-oscillates on the ladder).' },
  envAmt: { default: 0, min: -6, max: 6, unit: 'octaves', doc: 'How far the filter envelope opens (+) or closes (-) the cutoff, in octaves.' },
  keytrack: { default: 0.3, min: 0, max: 1, doc: 'How much the cutoff follows the pitch of the note (1 = fully).' },
  velFilter: { default: 0.5, min: 0, max: 4, unit: 'octaves', doc: 'Extra cutoff opening at full velocity, in octaves.' },
  drive: { default: 0, min: 0, max: 30, unit: 'dB', doc: 'Saturation before the filter.' },
  attack: { default: 0.005, min: 0.0005, max: 8, unit: 's', doc: 'Amplitude attack.' },
  decay: { default: 0.3, min: 0.01, max: 8, unit: 's', doc: 'Amplitude decay to the sustain level.' },
  sustain: { default: 0.8, min: 0, max: 1, doc: 'Amplitude sustain level (0 = a pluck that dies away on its own).' },
  release: { default: 0.25, min: 0.005, max: 10, unit: 's', doc: 'Amplitude release after the note ends.' },
  fAttack: { default: 0.002, min: 0.0005, max: 8, unit: 's', doc: 'Filter envelope attack.' },
  fDecay: { default: 0.35, min: 0.01, max: 8, unit: 's', doc: 'Filter envelope decay.' },
  fSustain: { default: 0.3, min: 0, max: 1, doc: 'Filter envelope sustain level.' },
  fRelease: { default: 0.3, min: 0.005, max: 10, unit: 's', doc: 'Filter envelope release.' },
  unisonDetune: { default: 14, min: 0, max: 100, unit: 'cents', doc: 'Detune spread of the unison voices (each layer scales it by its own `detune`).' },
  spread: { default: 0.8, min: 0, max: 1, doc: 'Stereo spread of the unison voices.' },
  pw: { default: 0.5, min: 0.05, max: 0.95, doc: 'Pulse width of pulse-wave layers.' },
  pwmDepth: { default: 0, min: 0, max: 0.45, doc: 'Pulse-width modulation depth (slow movement of the pulse width).' },
  pwmRate: { default: 0.5, min: 0.02, max: 8, unit: 'Hz', curve: 'exp', doc: 'Speed of the pulse-width modulation.' },
  sub: { default: 0, min: 0, max: 1, doc: 'Level of a sine sub oscillator one octave below the first layer.' },
  noise: { default: 0, min: 0, max: 1, doc: 'Level of white noise mixed into the oscillators.' },
  click: { default: 0, min: 0, max: 1, doc: 'Attack noise: a short burst of band-passed noise at the start of every new note (the hammer of a piano, the pick of a pluck). It is added after the filter and outside the amplitude envelope, so a dark patch or a slow attack keeps it, and it scales with the velocity of the note. 1 is a click as loud as the body of the note. 0 = off.' },
  clickDecay: { default: 0.012, min: 0.002, max: 0.15, unit: 's', curve: 'exp', doc: 'How fast the click dies away: the time constant of its exponential envelope (8.7 dB down after this long, 26 dB after three times, 43 dB after five).' },
  clickTone: { default: 2500, min: 200, max: 12000, unit: 'Hz', curve: 'exp', doc: 'Centre frequency of the band-pass the click goes through, for a middle-C note (see `clickKeytrack`).' },
  clickKeytrack: { default: 0.5, min: 0, max: 1, doc: 'How much the centre of the click follows the pitch of the note: 1 = an octave up in the note is an octave up in the click, 0 = the click always sits at `clickTone`.' },
  glide: { default: 0, min: 0, max: 2, unit: 's', doc: 'Portamento time in mono / legato modes (a slide-flagged note always glides, at least 60 ms). It glides into every note whose voice is still sounding, also one that starts in the release of the note before a rest; with the option `glideMode` set to fingered it glides only into a note that starts while the last one is held or touches it.' },
  vibDepth: { default: 0, min: 0, max: 100, unit: 'cents', doc: 'Vibrato depth (fades in after vibDelay).' },
  vibRate: { default: 5.5, min: 0.5, max: 12, unit: 'Hz', doc: 'Vibrato speed.' },
  vibDelay: { default: 0.25, min: 0, max: 3, unit: 's', doc: 'Time before the vibrato starts.' },
  pEnv: { default: 0, min: -48, max: 48, unit: 'semitones', doc: 'Pitch envelope: every note starts this far above (+) or below (-) its pitch and slides in.' },
  pEnvTime: { default: 0.08, min: 0.005, max: 2, unit: 's', doc: 'Time constant of the pitch envelope.' },
  bend: { default: 0, min: -24, max: 24, unit: 'semitones', doc: 'Pitch bend of the whole instrument (automate it for dives and rises).' },
  fmIndex: { default: 2, min: 0, max: 16, doc: 'FM layers: modulation index (brightness).' },
  fmRatio: { default: 2, min: 0.25, max: 16, doc: 'FM layers: modulator frequency as a ratio of the carrier (integers = harmonic, others = bell-like).' },
  fmDecay: { default: 0.4, min: 0.01, max: 6, unit: 's', doc: 'FM layers: how fast the index falls after the attack (the "pluck" of an FM tone).' },
  fmSustain: { default: 0.2, min: 0, max: 1, doc: 'FM layers: the fraction of the index that stays.' },
  fmFeedback: { default: 0, min: 0, max: 1, doc: 'FM layers: feedback of the modulator (brighter, grittier).' },
  lfo1Rate: { default: 1, min: 0.0625, max: 32, unit: 'cycles/beat', curve: 'exp', doc: 'Speed of LFO 1, locked to the tempo (0.25 = one cycle per 4/4 bar, 2 = eighth notes).' },
  lfo1Depth: { default: 1, min: 0, max: 1, doc: 'Master depth of LFO 1: it scales every `mods` entry that uses it (0 = off).' },
  lfo2Rate: { default: 0.25, min: 0.0625, max: 32, unit: 'cycles/beat', curve: 'exp', doc: 'Speed of LFO 2, locked to the tempo.' },
  lfo2Depth: { default: 1, min: 0, max: 1, doc: 'Master depth of LFO 2.' },
  velAmp: { default: 0.6, min: 0, max: 1, doc: 'How much velocity changes the loudness.' },
} satisfies ParamSpecs;

export type SynthWave = 'saw' | 'square' | 'pulse' | 'tri' | 'sine' | 'noise' | 'fm';

export interface SynthLayer {
  wave: SynthWave;
  /** Octave shift (default 0). */
  octave?: number;
  /** Semitone shift (default 0). */
  semi?: number;
  /** Fine tune in cents (default 0). */
  fine?: number;
  /** Level 0..1 (default 1). */
  level?: number;
  /** Unison voices (1..9, default 1). */
  unison?: number;
  /** Relative detune of this layer's unison (multiplies `unisonDetune`, default 1). */
  detune?: number;
  /** Phase at note start: 'random' (default for unison), 'reset' (all voices start at 0, punchy), 'free' (carry on, click-free in mono). */
  phase?: 'random' | 'reset' | 'free';
}

export type ModSource = 'lfo1' | 'lfo2' | 'env' | 'vel' | 'key' | 'rand';
export type ModDest = 'cutoff' | 'res' | 'pitch' | 'amp' | 'pw' | 'fm' | 'drive';
export interface ModRoute {
  src: ModSource;
  dst: ModDest;
  /** In the destination's unit: octaves for cutoff, semitones for pitch, 0..1 for res / amp / pw / fm (fm: index units), dB for drive. */
  amount: number;
}

export interface SynthOpts {
  preset?: string;
  /** Oscillator layers (1..3). */
  layers?: SynthLayer[];
  /** 'poly' (default), 'mono', 'legato'. */
  mode?: 'poly' | 'mono' | 'legato';
  /** Polyphony (default 8 in poly mode, 1 otherwise). */
  voices?: number;
  /** Filter: 'ladder' (24 dB, default), 'lp' / 'hp' / 'bp' / 'notch' (12 dB state-variable) or 'off'. */
  filter?: 'ladder' | 'lp' | 'hp' | 'bp' | 'notch' | 'off';
  /** Force a mono (true) or stereo (false) output. Default: stereo when any layer has unison > 1. */
  mono?: boolean;
  /** Modulation routes (see ModRoute). */
  mods?: ModRoute[];
  /** LFO shapes: 'sine' (default), 'tri', 'saw', 'ramp', 'square', 'smooth' (random glide), 'sh' (random steps). */
  lfo1Shape?: 'sine' | 'tri' | 'saw' | 'ramp' | 'square' | 'smooth' | 'sh';
  lfo2Shape?: 'sine' | 'tri' | 'saw' | 'ramp' | 'square' | 'smooth' | 'sh';
  /** Sub oscillator wave: 'sine' (default) or 'square'. */
  subWave?: 'sine' | 'square';
  /** Which notes a `glide` above 0 glides into (mono and legato modes): 'always' (default) or 'fingered' (only into a note that starts while the last one is held). */
  glideMode?: 'always' | 'fingered';
  name?: string;
  [param: string]: unknown;
}

const STRUCT = ['layers', 'mode', 'voices', 'filter', 'mono', 'mods', 'lfo1Shape', 'lfo2Shape', 'subWave', 'glideMode'] as const;

const SYNTH_WAVES = ['saw', 'square', 'pulse', 'tri', 'sine', 'noise', 'fm'] as const;
const LAYER_KEYS = ['wave', 'octave', 'semi', 'fine', 'level', 'unison', 'detune', 'phase'];
const MOD_SOURCES = ['lfo1', 'lfo2', 'env', 'vel', 'key', 'rand'] as const;
const MOD_DESTS = ['cutoff', 'res', 'pitch', 'amp', 'pw', 'fm', 'drive'] as const;

const MAXU = 9;
const MAXL = 3;

class Voice {
  active = false;
  gate = false;
  note = 60;
  vel = 1;
  age = 0;
  rand = 0;
  slideNote = 60; // current glide position (semitones)
  glideK = 1;
  vibAge = 0;
  fmT = 0;
  readonly ph = new Float64Array(MAXL * MAXU);
  readonly modPh = new Float64Array(MAXL * MAXU);
  readonly aenv = new Adsr();
  readonly fenv = new Adsr();
  readonly svfL = new Svf();
  readonly svfR = new Svf();
  readonly ladL = new Ladder();
  readonly ladR = new Ladder();
  subPh = 0;
  fmPh = 0;
  fmFb = 0;
  // the attack click of this note: its envelope (0 = none, it ends below CLICK_FLOOR), the per-sample decay, the amplitude, a band-pass
  // and a noise generator of its own (seeded per note, so the noise does not depend on how the song is cut into segments)
  clickEnv = 0;
  clickK = 0;
  clickGain = 0;
  readonly clickBp = new Svf();
  readonly clickNoise = new Noise(1);
}

/** The click is over when its envelope is under this (-80 dB): the voice then ends with its amplitude envelope as usual. */
const CLICK_FLOOR = 1e-4;
/** The band-pass of the click: a Q of 1, so about an octave wide. */
const CLICK_Q = 1;
/**
 * Scales the click so that click = 1 starts about as loud as the start of a plucked note (sandbox/album/lab/click-lab.ts: the rms of the
 * click over the first 3 ms against that of the body, with a velocity of 0.8: pluck -1.8 dB, dark-pluck -1.3 dB, trance-pluck +3.8 dB,
 * arp-bright +0.6 dB). It is relative to the level of the preset, like the body, and 1 is a lot for a pad that swells in.
 */
const CLICK_GAIN = 1.3;

function lfoShape(shape: string, ph: number, rnd: number, rnd2: number): number {
  switch (shape) {
    case 'tri':
      return ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
    case 'saw':
      return 2 * ph - 1;
    case 'ramp':
      return 1 - 2 * ph;
    case 'square':
      return ph < 0.5 ? 1 : -1;
    case 'sh':
      return rnd;
    case 'smooth': {
      const s = ph * ph * (3 - 2 * ph);
      return rnd + (rnd2 - rnd) * s;
    }
    default:
      return sinCyc(ph);
  }
}

function hashRand(i: number): number {
  let x = Math.imul(i | 0, 0x9e3779b1);
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  return ((x >>> 0) / 4294967296) * 2 - 1;
}

export class Synth extends ParamBase<typeof SYNTH_SPECS> implements Instrument {
  readonly stereo: boolean;
  /** Mono and legato modes tie a slid note to the one before it; in poly mode every note has its own voice. */
  get slides(): 'tie' | 'none' {
    return this.mode === 'poly' ? 'none' : 'tie';
  }
  private readonly sr: number;
  private readonly ctx: Ctx;
  private readonly voices: Voice[] = [];
  private readonly layers: Required<SynthLayer>[];
  private readonly mode: 'poly' | 'mono' | 'legato';
  private readonly filterType: 'ladder' | 'lp' | 'hp' | 'bp' | 'notch' | 'off';
  private readonly mods: ModRoute[];
  private readonly lfo1Shape: string;
  private readonly lfo2Shape: string;
  private readonly subWave: 'sine' | 'square';
  private readonly glideMode: 'always' | 'fingered';
  private offTick = -1; // the tick at which the last key was let go (mono and legato modes): a note that starts on the same tick touches it
  private readonly rng: Rng;
  private readonly noise: Noise;
  private readonly held: number[] = [];
  private tick = 0;
  private noteCount = 0; // notes started so far: the seed of the click noise of the next one
  private readonly clickSeed: number;
  // per-segment scratch
  private readonly bl = new Float64Array(BLOCK);
  private readonly br = new Float64Array(BLOCK);
  private readonly bm = new Float64Array(BLOCK);
  private readonly aenv = new Float64Array(BLOCK);
  private readonly fenvv = new Float64Array(BLOCK);
  private readonly unisonOffs: Float64Array[] = []; // per layer: unison detune pattern in [-1, 1]
  private readonly unisonW: Float64Array[] = [];
  private readonly unisonGrp: Uint8Array[] = []; // 0 = left group, 1 = right group, 2 = centre
  private readonly dtu = new Float64Array(MAXL * MAXU);
  private readonly mod = { cutoff: 0, res: 0, pitch: 0, amp: 0, pw: 0, fm: 0, drive: 0 };

  /** The pitches a note sounds at, in semitones from it: the layers loud enough to hear (noise aside) and the sub oscillator. */
  get pitches(): number[] {
    const loud = Math.max(...this.layers.map((l) => l.level));
    const out = new Set<number>();
    for (const l of this.layers) if (l.wave !== 'noise' && l.level >= 0.3 * loud) out.add(l.octave * 12 + l.semi);
    if (this.params.sub >= 0.3) out.add(this.layers[0].octave * 12 + this.layers[0].semi - 12);
    return [...out].sort((x, y) => x - y);
  }

  constructor(ctx: Ctx, input: SynthOpts | string | undefined) {
    const o = resolveOpts('synth', SYNTH_PRESETS, input ?? 'default', SYNTH_SPECS, STRUCT);
    super('Synth', SYNTH_SPECS, o);
    this.ctx = ctx;
    this.sr = ctx.sr;
    this.rng = new Rng(ctx.seed);
    this.noise = new Noise(ctx.seed ^ 0x5bd1e995);
    this.clickSeed = (ctx.seed ^ 0x3c6ef372) | 0;
    const layers = (o.layers as SynthLayer[] | undefined) ?? [{ wave: 'saw' }];
    if (layers.length < 1 || layers.length > MAXL) throw new Error(`synth: 1 to ${MAXL} layers please (got ${layers.length})`);
    this.layers = layers.map((l, i) => {
      const who = `synth layer ${i + 1}`;
      checkKeys(who, l, LAYER_KEYS);
      const wave = pickWord(who, 'wave', l.wave, SYNTH_WAVES, 'saw');
      return {
        wave,
        octave: l.octave ?? 0,
        semi: l.semi ?? 0,
        fine: l.fine ?? 0,
        level: l.level ?? 1,
        unison: wave === 'fm' ? 1 : clamp(Math.round(l.unison ?? 1), 1, MAXU),
        detune: l.detune ?? 1,
        phase: pickWord(who, 'phase', l.phase, ['random', 'reset', 'free'] as const, (l.unison ?? 1) > 1 && wave !== 'fm' ? 'random' : 'reset'),
      };
    });
    this.mode = pickWord('synth', 'mode', o.mode, ['poly', 'mono', 'legato'] as const, 'poly');
    this.filterType = pickWord('synth', 'filter', o.filter, ['ladder', 'lp', 'hp', 'bp', 'notch', 'off'] as const, 'ladder');
    this.mods = ((o.mods as ModRoute[] | undefined) ?? []).map((m, i) => {
      const who = `synth mods[${i}]`;
      checkKeys(who, m, ['src', 'dst', 'amount']);
      if (typeof m.amount !== 'number' || !Number.isFinite(m.amount)) throw new Error(`${who}: "amount" must be a number`);
      return { src: pickWord(who, 'src', m.src, MOD_SOURCES), dst: pickWord(who, 'dst', m.dst, MOD_DESTS), amount: m.amount };
    });
    this.lfo1Shape = pickWord('synth', 'lfo1Shape', o.lfo1Shape, LFO_SHAPES, 'sine');
    this.lfo2Shape = pickWord('synth', 'lfo2Shape', o.lfo2Shape, LFO_SHAPES, 'sine');
    this.subWave = pickWord('synth', 'subWave', o.subWave, ['sine', 'square'] as const, 'sine');
    this.glideMode = pickWord('synth', 'glideMode', o.glideMode, ['always', 'fingered'] as const, 'always');
    const anyUni = this.layers.some((l) => l.unison > 1);
    this.stereo = o.mono === true ? false : o.mono === false ? true : anyUni;
    const nv = this.mode === 'poly' ? Math.round((o.voices as number) ?? 8) : 1;
    for (let i = 0; i < clamp(nv, 1, 24); i++) this.voices.push(new Voice());
    // unison patterns
    for (const l of this.layers) {
      const U = l.unison;
      const offs = new Float64Array(U);
      const w = new Float64Array(U);
      const pan = new Float64Array(U);
      for (let u = 0; u < U; u++) {
        offs[u] = U === 1 ? 0 : (2 * u) / (U - 1) - 1;
        pan[u] = U === 1 ? 0 : offs[u];
        w[u] = 1;
      }
      // the classic 7-saw pattern is slightly uneven: widen the outer voices a little
      if (U === 7) {
        const k = [-1, -0.5651, -0.1759, 0, 0.1794, 0.5600, 1];
        for (let u = 0; u < 7; u++) offs[u] = k[u];
      }
      this.unisonOffs.push(offs);
      this.unisonW.push(w);
      this.unisonGrp.push(Uint8Array.from(pan, (x) => (x <= -0.3 ? 0 : x >= 0.3 ? 1 : 2)));
    }
    for (const v of this.voices) {
      for (let i = 0; i < v.ph.length; i++) v.modPh[i] = (i * 0.1618) % 1;
    }
  }

  // ── events ───────────────────────────────────────────────────────────────

  private setupEnv(v: Voice): void {
    const p = this.params;
    v.aenv.set(p.attack, p.decay, p.sustain, p.release, this.sr);
    v.fenv.set(p.fAttack, p.fDecay, p.fSustain, p.fRelease, this.sr);
  }

  private startVoice(v: Voice, note: number, vel: number, retrigger: boolean, flags: number): void {
    const p = this.params;
    const wasHeld = v.gate; // a key of this voice was down when the new note came
    v.note = note;
    v.vel = vel;
    v.gate = true;
    v.age = 0;
    this.setupEnv(v);
    if (retrigger || !v.active) {
      v.rand = this.rng.bi();
      v.vibAge = 0;
      v.fmT = 0;
      v.aenv.gateOn();
      v.fenv.gateOn();
      if (!v.active) {
        v.aenv.value = 0;
        v.fenv.value = 0;
      } else if (this.mode === 'poly') v.fenv.value = 0;
      // oscillator phases
      for (let li = 0; li < this.layers.length; li++) {
        const L = this.layers[li];
        for (let u = 0; u < L.unison; u++) {
          const idx = li * MAXU + u;
          if (L.phase === 'reset') v.ph[idx] = 0;
          else if (L.phase === 'random' || !v.active) v.ph[idx] = this.rng.next();
        }
      }
      v.subPh = 0;
      v.fmPh = 0;
      v.fmFb = 0;
      v.ladL.reset();
      v.ladR.reset();
      v.svfL.reset();
      v.svfR.reset();
      // the attack click: every new note (not a tied one) has its own, and its own noise
      this.noteCount++;
      if (p.click > 0) this.startClick(v, note, vel);
    }
    // glideMode 'always' glides into every note whose voice is still sounding (also one that starts in the release of the note before a rest);
    // 'fingered' only into a note that starts while the last key is held or touches it (released on the very same tick: notes made with .legato())
    const connected = this.glideMode === 'always' || wasHeld || this.tick === this.offTick;
    const glideOn = (this.mode !== 'poly' && p.glide > 0 && connected) || (flags & FLAG.SLIDE) !== 0;
    if (!v.active || !glideOn) {
      v.slideNote = note;
      v.glideK = 1;
    } else {
      const t = (flags & FLAG.SLIDE) !== 0 ? Math.max(p.glide, 0.06) : p.glide;
      v.glideK = 1 - Math.exp(-1 / (Math.max(t, 0.002) * this.sr * 0.35));
    }
    v.active = true;
  }

  /**
   * Starts the attack click of a note: white noise (its own generator, seeded by the number of the note: the same song always clicks the
   * same way, however it is cut into segments) through a band-pass at `clickTone`, moved by `clickKeytrack` with the pitch, under an
   * exponential envelope, scaled by the velocity. The settings are those of the moment the note starts.
   */
  private startClick(v: Voice, note: number, vel: number): void {
    const p = this.params;
    const fc = clamp(p.clickTone * Math.pow(2, (p.clickKeytrack * (note - 60)) / 12), 100, this.sr * 0.45);
    v.clickBp.reset();
    v.clickBp.set(fc, CLICK_Q, this.sr);
    v.clickK = Math.exp(-1 / (p.clickDecay * this.sr));
    v.clickEnv = 1;
    // the band-passed noise grows with the square root of its centre frequency (a constant Q): scaled back, a click keeps its loudness as its tone moves
    v.clickGain = p.click * vel * CLICK_GAIN * Math.sqrt(2500 / fc) * dbToLin(p.level - 10) * 0.5;
    v.clickNoise.s = (Math.imul(this.noteCount, 0x9e3779b1) ^ this.clickSeed) | 0 || 0x2545f491;
    for (let i = 0; i < 8; i++) v.clickNoise.next(); // close seeds start far apart
  }

  /** Adds the click of a voice to the output: after the filter and the amplitude envelope, so neither a dark patch nor a slow attack takes it away. */
  private addClick(v: Voice, outL: Float64Array, outR: Float64Array, n: number, stereo: boolean): void {
    const bp = v.clickBp;
    const noise = v.clickNoise;
    const k = v.clickK;
    const g = v.clickGain;
    let env = v.clickEnv;
    for (let i = 0; i < n; i++) {
      bp.step(noise.next());
      const c = bp.k * bp.bp * env * g; // the band-pass with a peak gain of 1
      outL[i] += c;
      if (stereo) outR[i] += c;
      env *= k;
      if (env <= CLICK_FLOOR) {
        env = 0; // over, on a sample that does not depend on where the segments end
        break;
      }
    }
    v.clickEnv = env;
  }

  noteOn(note: number, vel: number, _dur: number, flags: number): void {
    const p = this.params;
    void p;
    if (this.mode === 'poly') {
      let v = this.voices.find((x) => !x.active);
      if (!v) {
        // steal: prefer a releasing voice with the lowest level, then the oldest
        let best: Voice | null = null;
        let bestScore = Infinity;
        for (const x of this.voices) {
          const score = (x.gate ? 1000 : 0) + x.aenv.value * 100 - x.age * 0.0001;
          if (score < bestScore) {
            bestScore = score;
            best = x;
          }
        }
        v = best as Voice;
      }
      this.startVoice(v, note, vel, true, flags);
      return;
    }
    const v = this.voices[0];
    const slide = (flags & FLAG.SLIDE) !== 0;
    if (slide) this.held.length = 0;
    const legato = slide || (this.mode === 'legato' && this.held.length > 0 && v.gate);
    this.held.push(note);
    if (this.held.length > 16) this.held.shift();
    this.startVoice(v, note, vel, !legato, flags);
  }

  noteOff(note: number): void {
    if (this.mode === 'poly') {
      // release the oldest sounding voice of this pitch
      let pick: Voice | null = null;
      for (const v of this.voices) if (v.active && v.gate && v.note === note && (!pick || v.age > pick.age)) pick = v;
      if (pick) {
        pick.gate = false;
        pick.aenv.gateOff();
        pick.fenv.gateOff();
      }
      return;
    }
    const v = this.voices[0];
    const i = this.held.lastIndexOf(note);
    if (i >= 0) this.held.splice(i, 1);
    if (!v.active) return;
    if (v.note === note) {
      if (this.held.length > 0) {
        // fall back to the previously held key (legato)
        const prev = this.held[this.held.length - 1];
        v.note = prev;
        v.glideK = 1 - Math.exp(-1 / (Math.max(this.params.glide, 0.02) * this.sr * 0.35));
      } else {
        v.gate = false;
        v.aenv.gateOff();
        v.fenv.gateOff();
        this.offTick = this.tick;
      }
    }
  }

  hit(_part: string, vel: number, dur: number, flags: number): void {
    this.noteOn(60, vel, dur, flags);
    // a one-shot hit has no note-off in the score: release it after the planned length
    this.pendingOff.push({ at: this.tick + Math.max(1, dur), note: 60 });
  }
  private readonly pendingOff: { at: number; note: number }[] = [];

  // ── rendering ────────────────────────────────────────────────────────────

  process(l: Float64Array, r: Float64Array, n: number): void {
    this.tick += n;
    for (let i = this.pendingOff.length - 1; i >= 0; i--) {
      if (this.pendingOff[i].at <= this.tick) {
        this.noteOff(this.pendingOff[i].note);
        this.pendingOff.splice(i, 1);
      }
    }
    for (const v of this.voices) if (v.active) this.renderVoice(v, l, r, n);
  }

  active(): boolean {
    for (const v of this.voices) if (v.active) return true;
    return false;
  }

  private lfoValue(which: 1 | 2): number {
    const p = this.params;
    const beat = this.ctx.transport.beat;
    const rate = which === 1 ? p.lfo1Rate : p.lfo2Rate;
    const shape = which === 1 ? this.lfo1Shape : this.lfo2Shape;
    const cyc = beat * rate;
    const ph = cyc - Math.floor(cyc);
    const idx = Math.floor(cyc);
    return lfoShape(shape, ph, hashRand(idx + which * 7919), hashRand(idx + 1 + which * 7919)) * (which === 1 ? p.lfo1Depth : p.lfo2Depth);
  }

  private renderVoice(v: Voice, outL: Float64Array, outR: Float64Array, n: number): void {
    const p = this.params;
    const sr = this.sr;
    const stereo = this.stereo;
    const bl = this.bl;
    const br = this.br;
    const bm = this.bm;
    // ── modulation matrix (k-rate) ───────────────────────────────────────────
    const m = this.mod;
    m.cutoff = 0;
    m.res = 0;
    m.pitch = 0;
    m.amp = 0;
    m.pw = 0;
    m.fm = 0;
    m.drive = 0;
    if (this.mods.length) {
      const l1 = this.lfoValue(1);
      const l2 = this.lfoValue(2);
      for (const r of this.mods) {
        let s = 0;
        switch (r.src) {
          case 'lfo1':
            s = l1;
            break;
          case 'lfo2':
            s = l2;
            break;
          case 'env':
            s = v.fenv.value;
            break;
          case 'vel':
            s = v.vel;
            break;
          case 'key':
            s = (v.note - 60) / 48;
            break;
          default:
            s = v.rand;
        }
        m[r.dst] += s * r.amount;
      }
    }
    // ── pitch ────────────────────────────────────────────────────────────────
    const gk = v.glideK;
    // glide runs per segment: n samples at once
    if (gk < 1) {
      const k = 1 - Math.pow(1 - gk, n);
      v.slideNote += (v.note - v.slideNote) * k;
      if (Math.abs(v.note - v.slideNote) < 1e-4) {
        v.slideNote = v.note;
        v.glideK = 1;
      }
    } else v.slideNote = v.note;
    v.age += n;
    v.vibAge += n / sr;
    let semis = v.slideNote + p.bend + m.pitch;
    if (p.pEnv !== 0) semis += p.pEnv * Math.exp(-(v.age / sr) / p.pEnvTime);
    if (p.vibDepth > 0) {
      const vibFade = clamp((v.vibAge - p.vibDelay) / 0.35, 0, 1);
      semis += (p.vibDepth / 100) * vibFade * sinCyc((v.vibAge * p.vibRate) % 1);
    }
    // ── oscillators ──────────────────────────────────────────────────────────
    // Unison voices are summed into three buffers (left group, right group, centre) and spread afterwards: one store per
    // oscillator and sample instead of two multiply-adds.
    bl.fill(0, 0, n);
    if (stereo) {
      br.fill(0, 0, n);
      bm.fill(0, 0, n);
    }
    const pwBase = clamp(p.pw + m.pw, 0.05, 0.95);
    let pw = pwBase;
    if (p.pwmDepth > 0) pw = clamp(pwBase + p.pwmDepth * sinCyc(((this.tick / sr) * p.pwmRate) % 1), 0.05, 0.95);
    const fmIdxEnv = p.fmSustain + (1 - p.fmSustain) * Math.exp(-(v.age / sr) / p.fmDecay);
    const fmIndex = Math.max(0, (p.fmIndex + m.fm) * fmIdxEnv);
    for (let li = 0; li < this.layers.length; li++) {
      const L = this.layers[li];
      if (L.level <= 0) continue;
      const base = mtof(semis + L.octave * 12 + L.semi + L.fine / 100);
      const U = L.unison;
      const offs = this.unisonOffs[li];
      const grp = this.unisonGrp[li];
      // normalisation: unison voices add in power
      const norm = L.level / Math.sqrt(U);
      for (let u = 0; u < U; u++) {
        const idx = li * MAXU + u;
        const cents = offs[u] * p.unisonDetune * L.detune;
        const dt = (base * Math.pow(2, cents / 1200)) / sr;
        let dst: Float64Array;
        let g: number;
        if (!stereo) {
          dst = bl;
          g = norm;
        } else if (grp[u] === 0) {
          dst = bl;
          g = norm * Math.SQRT2;
        } else if (grp[u] === 1) {
          dst = br;
          g = norm * Math.SQRT2;
        } else {
          dst = bm;
          g = norm;
        }
        let ph = v.ph[idx];
        switch (L.wave) {
          case 'saw':
            ph = addSaw(dst, n, ph, dt, g);
            break;
          case 'square':
            ph = addPulse(dst, n, ph, dt, g, 0.5);
            break;
          case 'pulse':
            ph = addPulse(dst, n, ph, dt, g, pw);
            break;
          case 'tri':
            ph = addTri(dst, n, ph, dt, g);
            break;
          case 'sine':
            ph = addSine(dst, n, ph, dt, g);
            break;
          case 'noise':
            for (let i = 0; i < n; i++) {
              bl[i] += this.noise.next() * norm;
              if (stereo) br[i] += this.noise.next() * norm;
            }
            break;
          default: {
            // 2-operator FM: carrier ph, modulator v.fmPh (FM layers always have one unison voice)
            const ratio = p.fmRatio;
            const mdt = dt * ratio;
            let mp = v.fmPh;
            let fb = v.fmFb;
            const fbAmt = p.fmFeedback * 1.2;
            const idxR = fmIndex / TAU;
            for (let i = 0; i < n; i++) {
              ph += dt;
              if (ph >= 1) ph -= 1;
              mp += mdt;
              if (mp >= 1) mp -= 1;
              let mq = mp + fbAmt * fb * 0.15;
              mq -= Math.floor(mq);
              const mod = sinCyc(mq);
              fb = mod;
              let x = ph + idxR * mod;
              x -= Math.floor(x);
              dst[i] += sinCyc(x) * g;
            }
            v.fmPh = mp;
            v.fmFb = fb;
          }
        }
        v.ph[idx] = ph;
      }
    }
    if (stereo) {
      // combine the groups and apply the stereo spread (side signal scaled)
      const spread = p.spread;
      for (let i = 0; i < n; i++) {
        const c = bm[i];
        const lv = bl[i] + c;
        const rv = br[i] + c;
        const mid = (lv + rv) * 0.5;
        const side = (lv - rv) * 0.5 * spread;
        bl[i] = mid + side;
        br[i] = mid - side;
      }
    }
    if (p.sub > 0) {
      const f = mtof(semis + this.layers[0].octave * 12 + this.layers[0].semi - 12) / sr;
      let ph = v.subPh;
      const g = p.sub * 0.7;
      const sq = this.subWave === 'square';
      for (let i = 0; i < n; i++) {
        ph += f;
        if (ph >= 1) ph -= 1;
        const y = (sq ? (ph < 0.5 ? 1 : -1) * 0.6 : sinCyc(ph)) * g;
        bl[i] += y;
        if (stereo) br[i] += y;
      }
      v.subPh = ph;
    }
    if (p.noise > 0) {
      const g = p.noise * 0.5;
      for (let i = 0; i < n; i++) {
        const y = this.noise.next() * g;
        bl[i] += y;
        if (stereo) br[i] += this.noise.next() * g;
      }
    }
    // ── envelopes ────────────────────────────────────────────────────────────
    const ae = this.aenv;
    const fe = this.fenvv;
    const idle = v.aenv.fill(ae, n);
    v.fenv.fill(fe, n);
    // ── drive and filter (coefficients every 16 samples) ─────────────────────
    const drv = p.drive + m.drive;
    const driveG = drv > 0 ? dbToLin(drv) : 1;
    const driveN = 1 / Math.sqrt(driveG * 0.5 + 0.5);
    const ft = this.filterType;
    const keyOct = (p.keytrack * (v.slideNote - 60)) / 12;
    const velOct = p.velFilter * v.vel;
    const resP = clamp(p.res + m.res, 0, 1.1);
    const mode = ft === 'lp' ? 0 : ft === 'hp' ? 1 : ft === 'bp' ? 2 : 3;
    const q = 0.5 + resP * resP * 14;
    const ladGain = 1 + 0.45 * resP;
    for (let c0 = 0; c0 < n; c0 += 16) {
      const c1 = Math.min(n, c0 + 16);
      if (drv > 0) {
        for (let i = c0; i < c1; i++) bl[i] = tanh3(bl[i] * driveG) * driveN;
        if (stereo) for (let i = c0; i < c1; i++) br[i] = tanh3(br[i] * driveG) * driveN;
      }
      if (ft === 'off') continue;
      const fc = clamp(p.cutoff * Math.pow(2, p.envAmt * fe[c0] + keyOct + velOct + m.cutoff), 20, sr * 0.45);
      if (ft === 'ladder') {
        v.ladL.set(fc, resP, sr);
        v.ladL.block(bl, c0, c1, ladGain);
        if (stereo) {
          v.ladR.set(fc, resP, sr);
          v.ladR.block(br, c0, c1, ladGain);
        }
      } else {
        v.svfL.set(fc, q, sr);
        v.svfL.blockRange(bl, c0, c1, mode);
        if (stereo) {
          v.svfR.set(fc, q, sr);
          v.svfR.blockRange(br, c0, c1, mode);
        }
      }
    }
    // ── amplitude and output ─────────────────────────────────────────────────
    const velG = 1 - p.velAmp + p.velAmp * Math.pow(v.vel, 1.3);
    const level = dbToLin(p.level + (-10)) * velG * 0.5 * (m.amp !== 0 ? Math.max(0, 1 + m.amp) : 1);
    const end = idle >= 0 ? idle : n;
    for (let i = 0; i < end; i++) {
      const g = ae[i] * level;
      outL[i] += bl[i] * g;
      if (stereo) outR[i] += br[i] * g;
    }
    if (v.clickEnv > CLICK_FLOOR) this.addClick(v, outL, outR, n, stereo);
    if (idle >= 0 && !(v.clickEnv > CLICK_FLOOR)) v.active = false; // a click that outlives a very short note keeps the voice alive until it is over
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// presets
// ─────────────────────────────────────────────────────────────────────────────

const SAW7: SynthLayer = { wave: 'saw', unison: 7 };
const SAW6: SynthLayer = { wave: 'saw', unison: 6 };

export const SYNTH_PRESETS: Record<string, PresetDef> = {
  default: { doc: 'A plain filtered saw: the starting point for your own patch.', opts: { level: -0.5, layers: [{ wave: 'saw' }], cutoff: 5000, attack: 0.005, decay: 0.3, sustain: 0.8, release: 0.25 } },
  'supersaw-pad': {
    doc: 'Huge slow pad: six detuned saws and three more an octave down, soft attack, long release, gentle filter movement. Put fx.chorus() and some reverb on it.',
    opts: { filter: 'lp', layers: [SAW6, { wave: 'saw', unison: 3, octave: -1, level: 0.6, detune: 0.6 }], unisonDetune: 20, spread: 1, cutoff: 1800, res: 0.1, envAmt: 1.2, fAttack: 0.8, fDecay: 1.5, fSustain: 0.5, attack: 0.7, decay: 1, sustain: 0.9, release: 1.6, keytrack: 0.5, level: -4.5 },
  },
  'supersaw-chord': {
    doc: 'Bright EDM / dubstep / trance supersaw chords: six saws detuned 24 cents and two more an octave up, quick attack, open filter. Melodic-dubstep staple.',
    opts: { filter: 'lp', layers: [SAW6, { wave: 'saw', unison: 2, octave: 1, level: 0.35, detune: 0.7 }], unisonDetune: 24, spread: 1, cutoff: 6500, res: 0.1, envAmt: 0.8, fDecay: 0.6, fSustain: 0.5, attack: 0.008, decay: 0.5, sustain: 0.85, release: 0.35, keytrack: 0.6, drive: 3, level: -4, voices: 10 },
  },
  'supersaw-lead': {
    doc: 'Soaring mono lead: seven saws and a square an octave down, glide, delayed vibrato. Needs a delay and reverb.',
    opts: { mode: 'legato', voices: 1, layers: [{ wave: 'saw', unison: 7, phase: 'free' }, { wave: 'square', octave: -1, level: 0.3, phase: 'free' }], unisonDetune: 16, spread: 0.7, cutoff: 7000, res: 0.15, envAmt: 0.6, fDecay: 0.4, fSustain: 0.6, attack: 0.012, decay: 0.3, sustain: 0.9, release: 0.3, glide: 0.05, vibDepth: 18, vibDelay: 0.3, keytrack: 0.7, level: 4 },
  },
  'saw-lead': {
    doc: 'Classic synthwave lead: two detuned saws + a square octave down, resonant filter, a little glide.',
    opts: { level: 5.5, mode: 'legato', voices: 1, mono: false, layers: [{ wave: 'saw', unison: 2, detune: 0.5, phase: 'free' }, { wave: 'square', octave: -1, level: 0.5, phase: 'free' }], unisonDetune: 10, spread: 0.5, cutoff: 4200, res: 0.3, envAmt: 1.5, fDecay: 0.5, fSustain: 0.4, attack: 0.006, decay: 0.3, sustain: 0.85, release: 0.2, glide: 0.04, vibDepth: 10, vibDelay: 0.25, keytrack: 0.6 },
  },
  'square-lead': {
    doc: 'Hollow PWM lead (chiptune / 80s).',
    opts: { level: 2.5, mode: 'legato', voices: 1, layers: [{ wave: 'pulse', unison: 2, detune: 0.4, phase: 'free' }], unisonDetune: 8, spread: 0.6, pw: 0.35, pwmDepth: 0.2, pwmRate: 0.6, cutoff: 3800, res: 0.2, envAmt: 1, fDecay: 0.3, fSustain: 0.6, attack: 0.005, decay: 0.2, sustain: 0.9, release: 0.15, glide: 0.02 },
  },
  'trance-lead': {
    doc: 'Bright, resonant Goa / trance lead with a pluck at the start of each note and a long ring.',
    opts: { mode: 'legato', voices: 1, layers: [{ wave: 'saw', unison: 5, phase: 'free' }, { wave: 'saw', unison: 3, octave: 1, level: 0.3, detune: 0.8, phase: 'free' }], unisonDetune: 12, spread: 0.7, cutoff: 3200, res: 0.35, envAmt: 2.6, fDecay: 0.28, fSustain: 0.35, attack: 0.004, decay: 0.4, sustain: 0.8, release: 0.45, glide: 0.03, keytrack: 0.8, level: 7.5 },
  },
  pluck: {
    doc: 'Bright plucked synth: short, snappy, with a filter snap. For arps and melodies.',
    opts: { layers: [{ wave: 'saw', unison: 2, detune: 0.5 }, { wave: 'square', octave: 1, level: 0.3 }], unisonDetune: 8, spread: 0.6, cutoff: 1800, res: 0.2, envAmt: 3, fDecay: 0.25, fSustain: 0, attack: 0.002, decay: 0.35, sustain: 0, release: 0.15, keytrack: 0.7, voices: 10, level: 9.5 },
  },
  'dark-pluck': {
    doc: 'Darksynth arp pluck: gritty saw + square, mid-heavy, quick filter snap. 16th-note arpeggios.',
    opts: { layers: [{ wave: 'saw', unison: 2, detune: 0.6 }, { wave: 'square', level: 0.45, octave: -1 }], unisonDetune: 10, spread: 0.5, cutoff: 1100, res: 0.28, envAmt: 3.2, fDecay: 0.2, fSustain: 0, attack: 0.002, decay: 0.28, sustain: 0, release: 0.1, keytrack: 0.6, drive: 4, voices: 8, level: 11.5 },
  },
  'trance-pluck': {
    doc: 'Psychedelic Goa arpeggio pluck: resonant, short, very bright snap.',
    opts: { layers: [{ wave: 'saw', unison: 2, detune: 0.4 }, { wave: 'saw', octave: 1, level: 0.35 }], unisonDetune: 6, spread: 0.5, cutoff: 1400, res: 0.5, envAmt: 3.6, fDecay: 0.18, fSustain: 0, attack: 0.001, decay: 0.22, sustain: 0, release: 0.08, keytrack: 0.8, voices: 8, level: 15 },
  },
  'arp-bright': {
    doc: 'Short, bright, plinky arp voice for melodic music.',
    opts: { level: 10.5, layers: [{ wave: 'saw', unison: 3, detune: 0.5 }], unisonDetune: 9, spread: 0.8, cutoff: 3500, res: 0.15, envAmt: 2, fDecay: 0.18, fSustain: 0.1, attack: 0.002, decay: 0.2, sustain: 0.05, release: 0.12, keytrack: 0.8, voices: 8 },
  },
  'warm-pad': {
    doc: 'Soft analog-style pad: detuned saws and triangle, dark filter, slow.',
    opts: { level: -3.5, filter: 'lp', layers: [{ wave: 'saw', unison: 3, detune: 0.7 }, { wave: 'tri', octave: -1, level: 0.6 }], unisonDetune: 14, spread: 0.9, cutoff: 1100, res: 0.12, envAmt: 0.8, fAttack: 1.2, fDecay: 2, fSustain: 0.6, attack: 0.9, decay: 1, sustain: 0.9, release: 1.8, keytrack: 0.4 },
  },
  'string-pad': {
    doc: 'String ensemble pad: lots of saws, slow bow. Add fx.chorus().',
    opts: { level: -4, filter: 'lp', layers: [{ wave: 'saw', unison: 5, detune: 0.5 }], unisonDetune: 10, spread: 1, cutoff: 3200, res: 0.05, envAmt: 0.4, fAttack: 0.5, fDecay: 1.2, fSustain: 0.7, attack: 0.45, decay: 0.6, sustain: 0.95, release: 0.9, keytrack: 0.5, vibDepth: 5, vibDelay: 0.8 },
  },
  'brass-stab': {
    doc: 'Synthwave brass stab: saw stack with a filter swell on each hit.',
    opts: { level: -1.5, filter: 'lp', layers: [{ wave: 'saw', unison: 4, detune: 0.8 }, { wave: 'saw', octave: -1, level: 0.5 }], unisonDetune: 12, spread: 0.7, cutoff: 900, res: 0.12, envAmt: 2.8, fAttack: 0.05, fDecay: 0.4, fSustain: 0.35, attack: 0.02, decay: 0.3, sustain: 0.7, release: 0.18, keytrack: 0.6, voices: 8, drive: 2 },
  },
  organ: {
    doc: 'Drawbar-style organ (sine layers at 8\', 4\' and 2 2/3\').',
    opts: { level: -11.5, layers: [{ wave: 'sine', level: 1 }, { wave: 'sine', octave: 1, level: 0.7 }, { wave: 'sine', octave: 1, semi: 7, level: 0.4 }], filter: 'off', attack: 0.008, decay: 0.1, sustain: 1, release: 0.08, velAmp: 0.2, mono: true },
  },
  'fm-bell': {
    doc: 'DX-style bell: inharmonic FM ratio, index that dies away.',
    opts: { layers: [{ wave: 'fm' }], fmRatio: 3.5, fmIndex: 4.5, fmDecay: 1.2, fmSustain: 0.05, filter: 'off', attack: 0.002, decay: 2.2, sustain: 0, release: 0.8, mono: true, voices: 8, level: 0.5 },
  },
  'fm-epiano': {
    doc: 'Electric piano (Rhodes-ish): FM with a tine overtone and a quickly falling index.',
    opts: { level: 5, layers: [{ wave: 'fm' }, { wave: 'sine', octave: 0, level: 0.3 }], fmRatio: 1, fmIndex: 2.4, fmDecay: 0.45, fmSustain: 0.12, fmFeedback: 0.1, filter: 'off', attack: 0.003, decay: 1.4, sustain: 0.25, release: 0.4, mono: true, voices: 10 },
  },
  'fm-bass-pluck': {
    doc: 'Punchy FM pluck for melodic lines (works one or two octaves below middle C).',
    opts: { level: 1.5, layers: [{ wave: 'fm' }], fmRatio: 1, fmIndex: 3.2, fmDecay: 0.12, fmSustain: 0.1, filter: 'off', attack: 0.002, decay: 0.3, sustain: 0.4, release: 0.15, mono: true, voices: 6, drive: 3 },
  },
  'psy-bass': {
    doc: 'Goa / psytrance off-beat roll: one saw restarted on every note (each sixteenth hits the same), a ladder that snaps shut, mono. Play the three sixteenths after each kick: chords.roots({ rhythm: ".xxx", len: 1, low: 28 }).',
    opts: { mode: 'mono', voices: 1, mono: true, layers: [{ wave: 'saw', phase: 'reset' }], filter: 'ladder', cutoff: 600, res: 0.35, envAmt: 2.4, fAttack: 0.0005, fDecay: 0.09, fSustain: 0.2, fRelease: 0.01, keytrack: 0, velFilter: 0.2, attack: 0.0008, decay: 0.1, sustain: 0.6, release: 0.006, velAmp: 0.15, drive: 5, level: 17.5 },
  },
  'noise-pad': {
    doc: 'Airy noise texture with a filter that follows the pitch (wind, breath).',
    opts: { level: 11.5, layers: [{ wave: 'noise' }], filter: 'bp', cutoff: 1500, res: 0.55, keytrack: 1, attack: 1, decay: 1, sustain: 0.8, release: 1.5, mono: false, spread: 1, unisonDetune: 0 },
  },
};
