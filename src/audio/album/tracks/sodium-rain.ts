// Sodium Rain: melodic dubstep for the album "Xeno-Racer Vol. 1". The night drive: city lights streaming past, rain on the windscreen,
// a long fast road under orange sodium lamps. 140 BPM in half time, B minor.
//
// The hook is an 8-bar topline over Bm G Em F# (i VI iv V, the major V with its A# leading tone). Bar 1 asks (F#4 B4 D5 and a sigh down
// to the 9th, C#5), bar 2 reaches (B4 D5 up to G5), bars 3-4 fall through a turn to the low F#; the second half asks again, reaches higher
// (D5 F#5 up to the peak B5) and falls to the leading tone A#4. Odd bars are short-long-short-LONG, even bars long-short-LONG: every
// long note lands on the snare. The verse and the breakdown sit on a lament: the bass falls a semitone at a time (B A# A G# G F# E F#)
// under a pedal of D and F#, with a calmer melody of its own that ends on the hook's cadence.
// The piano states the hook in the intro; the build gives its first half to the piano and its second half to the lead; the drops sing it
// over a wide reese, a sub and a wall of saws. After the soft breakdown (the lament, a bell with a long delay, the rain) a bridge brings
// the only new chords (G A Bm over a climbing bass, the voice soaring to D6); the final drop harmonises the hook, a bell and then the
// piano double it an octave up, and a last eight bars repeat its peak. The piano has the last word, over the rain, on an unresolved
// Bm(add9).
// Probe:  ALBUM=1 ONLY=sodium-rain AUTOTRIM=1 SPEC=1 CLASH=1 npx vitest run tests/probes/album-render.test.ts
import { ParamBase, defineTrack, dsp, fx, type Ctx, type Instrument, type ParamSpecs, type Pattern, type Song, type SynthOpts } from '../song';

// ── a custom instrument: rain on the windscreen (README section 11) ─────────────────────────────────────────────────────

const RAIN_SPECS = {
  level: { default: 0, min: -40, max: 12, unit: 'dB', doc: 'Trim in dB.' },
  density: { default: 30, min: 0, max: 150, unit: 'drops/s', doc: 'Raindrops per second on the glass.' },
  tone: { default: 3600, min: 600, max: 12000, unit: 'Hz', curve: 'exp', doc: "Centre of the drops' pitch range." },
  hiss: { default: 0.14, min: 0, max: 1, doc: 'Level of the soft wash of distant rain under the drops.' },
  width: { default: 0.85, min: 0, max: 1, doc: 'How far the drops spread across the stereo field.' },
} satisfies ParamSpecs;
const DROPS = 8;

/**
 * Rain: seeded random drops (a short noise tick through a band-pass at a random pitch; one in eight is a bigger, ringing drop lower down),
 * each panned on its own, over a band of soft noise that swells slowly. It is unpitched (one part, 'rain'): a hit with a length turns it on
 * (fading in over about a second) and fades it out when the length is over. Everything random comes from the channel's seed, one draw per
 * sample: the same samples at any block size.
 */
class Rain extends ParamBase<typeof RAIN_SPECS> implements Instrument {
  readonly stereo = true;
  readonly parts = ['rain'] as const;
  private readonly sr: number;
  private offIn = 0; // samples until the shower ends
  private readonly rng: dsp.Rng;
  private readonly noiseL: dsp.Noise;
  private readonly noiseR: dsp.Noise;
  private readonly flt: dsp.Svf[] = [];
  private readonly env = new Float64Array(DROPS);
  private readonly k = new Float64Array(DROPS);
  private readonly amp = new Float64Array(DROPS);
  private readonly gl = new Float64Array(DROPS);
  private readonly gr = new Float64Array(DROPS);
  private readonly life = new Int32Array(DROPS);
  private nextDrop = 0;
  private on = false;
  private lvl = 0;
  private vel = 1;
  private aL = 0;
  private bL = 0;
  private aR = 0;
  private bR = 0;
  private swell = 0.8;
  private swellTarget = 0.8;
  private swellCount = 0;
  private readonly kIn: number;
  private readonly kOut: number;
  private readonly kA: number;
  private readonly kB: number;
  private readonly kS: number;
  constructor(ctx: Ctx, opts: Partial<Record<keyof typeof RAIN_SPECS, number>> = {}) {
    super('Rain', RAIN_SPECS, opts);
    this.sr = ctx.sr;
    this.rng = new dsp.Rng(ctx.seed);
    this.noiseL = new dsp.Noise(ctx.seed ^ 0x2c1b3c6d);
    this.noiseR = new dsp.Noise(ctx.seed ^ 0x297a2d39);
    for (let i = 0; i < DROPS; i++) this.flt.push(new dsp.Svf());
    this.kIn = 1 - Math.exp(-1 / (0.8 * ctx.sr));
    this.kOut = 1 - Math.exp(-1 / (1.2 * ctx.sr));
    this.kA = 1 - Math.exp((-dsp.TAU * 5000) / ctx.sr); // the hiss is the difference of two low-passes: a band from 1.2 to 5 kHz
    this.kB = 1 - Math.exp((-dsp.TAU * 1200) / ctx.sr);
    this.kS = 1 - Math.exp(-1 / (0.35 * ctx.sr));
  }
  noteOn(): void {}
  noteOff(): void {}
  hit(_part: string, vel: number, dur: number): void {
    this.on = true;
    this.vel = vel;
    this.offIn = Math.max(1, Math.round(dur));
  }
  active(): boolean {
    if (this.on || this.lvl > 1e-4) return true;
    for (let d = 0; d < DROPS; d++) if (this.life[d] > 0) return true;
    return false;
  }
  private spawn(): void {
    const p = this.params;
    const rng = this.rng;
    const d = this.nextDrop;
    this.nextDrop = (d + 1) % DROPS;
    const big = rng.next() < 0.12;
    const f = p.tone * Math.pow(2, (big ? -1.3 : 0) + rng.bi() * 1.1);
    const q = big ? 7 + rng.next() * 8 : 1.5 + rng.next() * 3;
    this.flt[d].reset().set(f, q, this.sr);
    this.amp[d] = 2.6 * (big ? 1 : 0.25 + 0.55 * rng.next() * rng.next());
    this.env[d] = 1;
    this.k[d] = Math.exp(-1 / ((big ? 0.0025 : 0.0008) * this.sr));
    const pan = rng.bi() * p.width;
    this.gl[d] = Math.sqrt(0.5 * (1 - pan));
    this.gr[d] = Math.sqrt(0.5 * (1 + pan));
    this.life[d] = Math.round((big ? 0.06 : 0.025) * this.sr);
  }
  process(l: Float64Array, r: Float64Array, n: number): void {
    const p = this.params;
    const g = dsp.dbToLin(p.level) * this.vel * 0.9;
    const rate = p.density / this.sr;
    const hiss = p.hiss * 0.5;
    for (let i = 0; i < n; i++) {
      if (this.on && --this.offIn <= 0) this.on = false;
      this.lvl += ((this.on ? 1 : 0) - this.lvl) * (this.on ? this.kIn : this.kOut);
      const lv = this.lvl;
      if (this.rng.next() < rate * lv) this.spawn();
      if (--this.swellCount <= 0) {
        this.swellTarget = 0.55 + 0.45 * this.rng.next();
        this.swellCount = Math.round(0.4 * this.sr);
      }
      this.swell += (this.swellTarget - this.swell) * this.kS;
      const nl = this.noiseL.next();
      const nr = this.noiseR.next();
      this.aL += this.kA * (nl - this.aL);
      this.bL += this.kB * (this.aL - this.bL);
      this.aR += this.kA * (nr - this.aR);
      this.bR += this.kB * (this.aR - this.bR);
      const hs = hiss * this.swell * lv;
      let yl = (this.aL - this.bL) * hs;
      let yr = (this.aR - this.bR) * hs;
      for (let d = 0; d < DROPS; d++) {
        if (this.life[d] <= 0) continue;
        this.life[d]--;
        const e = this.env[d];
        this.env[d] = e * this.k[d];
        const f = this.flt[d];
        f.step(nl * e);
        const y = f.bp * f.k * this.amp[d];
        yl += y * this.gl[d];
        yr += y * this.gr[d];
      }
      l[i] += yl * g;
      r[i] += yr * g;
    }
  }
}

// ── patches (README section 11: plain option objects) ────────────────────────────────────────────────────────────────

/** A felt piano for the night: one FM pair whose brightness fades slowly, two slightly detuned triangles (the unison strings), a faint
 *  stretched octave; dark, with a long ring and a pedal-like release. The hammer is felt: a quiet, low, short thump of noise. */
export const NIGHT_PIANO: SynthOpts = {
  layers: [
    { wave: 'fm', level: 1 },
    { wave: 'tri', unison: 2, detune: 1, level: 0.32 },
    { wave: 'sine', octave: 1, fine: 4, level: 0.14 },
  ],
  fmRatio: 1, fmIndex: 2.4, fmDecay: 0.7, fmSustain: 0.1, fmFeedback: 0.02,
  filter: 'lp', cutoff: 2000, res: 0.04, envAmt: 1.5, fAttack: 0.001, fDecay: 0.45, fSustain: 0.22, fRelease: 0.6, keytrack: 0.75, velFilter: 1.1,
  attack: 0.002, decay: 5, sustain: 0, release: 1.3, velAmp: 0.85,
  unisonDetune: 5, spread: 0.55, voices: 12,
  click: 0.22, clickDecay: 0.006, clickTone: 1000, clickKeytrack: 0.6,
};

/** The voice of the drops: five warm saws, a hollow pulse and a sine an octave down for body; legato, a slow late vibrato; it glides only
 *  into the slid notes (the sighs and the cries), every other note starts on its own pitch. */
export const NIGHT_LEAD: SynthOpts = {
  mode: 'legato', voices: 1, glideMode: 'fingered',
  layers: [
    { wave: 'saw', unison: 5, detune: 0.8, phase: 'free' },
    { wave: 'pulse', level: 0.4, phase: 'free' },
    { wave: 'sine', octave: -1, level: 0.28, phase: 'free' },
  ],
  pw: 0.32,
  filter: 'lp', cutoff: 2600, res: 0.16, envAmt: 0.9, fAttack: 0.025, fDecay: 0.6, fSustain: 0.55, fRelease: 0.4, keytrack: 0.6, velFilter: 0.6,
  attack: 0.018, decay: 0.7, sustain: 0.85, release: 0.45,
  glide: 0.08, vibDepth: 22, vibRate: 5, vibDelay: 0.38,
  unisonDetune: 15, spread: 0.75, drive: 2,
};

/** The verse voice: a soft triangle with a breath of noise and a thin pulse shimmer an octave up; slow vibrato; glides only into slid notes. */
export const HALO: SynthOpts = {
  mode: 'legato', voices: 1, glideMode: 'fingered',
  layers: [
    { wave: 'tri', level: 1, phase: 'free' },
    { wave: 'pulse', unison: 2, detune: 0.5, octave: 1, level: 0.12, phase: 'free' },
    { wave: 'noise', level: 0.05 },
  ],
  pw: 0.22,
  filter: 'lp', cutoff: 3200, res: 0.08, envAmt: 0.5, fAttack: 0.05, fDecay: 0.8, fSustain: 0.6, keytrack: 0.5,
  attack: 0.045, decay: 0.8, sustain: 0.8, release: 0.6,
  glide: 0.07, vibDepth: 16, vibRate: 4.6, vibDelay: 0.5,
  unisonDetune: 8, spread: 0.7,
};

/** A glass bell for the rain: FM at a slightly stretched third harmonic, a long fading ring. */
export const GLASS_BELL: SynthOpts = {
  layers: [{ wave: 'fm', level: 1 }, { wave: 'sine', octave: 1, level: 0.12 }],
  fmRatio: 3.01, fmIndex: 2.2, fmDecay: 0.9, fmSustain: 0.05,
  filter: 'off', attack: 0.002, decay: 2.8, sustain: 0, release: 1.5, velAmp: 0.7, mono: true, voices: 10,
};

/** The city lights: a soft, short pluck for the high arpeggios (a saw pair and a triangle an octave up, a quick filter snap). */
export const STREAM: SynthOpts = {
  layers: [{ wave: 'saw', unison: 2, detune: 1, level: 0.8 }, { wave: 'tri', octave: 1, level: 0.5 }],
  filter: 'lp', cutoff: 1500, res: 0.15, envAmt: 2.4, fAttack: 0.001, fDecay: 0.18, fSustain: 0.05, keytrack: 0.8,
  attack: 0.002, decay: 0.32, sustain: 0, release: 0.25, unisonDetune: 10, spread: 0.8, voices: 10,
  click: 0.15, clickDecay: 0.004, clickTone: 3500, clickKeytrack: 0.3, // a light pick
};

/** The drop's wall: seven saws spread wide, a quiet airy octave above, a gentle swell on each chord and a long release. */
export const WIDE_SAW: SynthOpts = {
  layers: [{ wave: 'saw', unison: 7, detune: 1 }, { wave: 'saw', unison: 3, detune: 0.6, octave: 1, level: 0.22 }],
  filter: 'lp', cutoff: 3600, res: 0.08, envAmt: 0.7, fAttack: 0.06, fDecay: 0.9, fSustain: 0.55, fRelease: 0.8, keytrack: 0.5,
  attack: 0.03, decay: 0.9, sustain: 0.85, release: 0.9, unisonDetune: 22, spread: 1, voices: 12, drive: 2,
};

/** The night sky: five slow saws and a triangle, dark, breathing on a two-bar LFO. */
export const NIGHT_PAD: SynthOpts = {
  layers: [{ wave: 'saw', unison: 5, detune: 1 }, { wave: 'tri', level: 0.6 }],
  filter: 'lp', cutoff: 1300, res: 0.12, envAmt: 0.8, fAttack: 1.4, fDecay: 2.5, fSustain: 0.6, fRelease: 2, keytrack: 0.4,
  attack: 1.1, decay: 1.6, sustain: 0.9, release: 1.6, unisonDetune: 16, spread: 1, voices: 10,
  mods: [{ src: 'lfo1', dst: 'cutoff', amount: 0.35 }], lfo1Rate: 0.125,
};

/** The drop bass: a wide, slowly swirling reese without a sub of its own (the sub is a channel); its filter wobbles by automation. */
const REESE = { preset: 'reese', sub: 0, detune: 20, drift: 0.7, driftRate: 0.16, cutoff: 650, res: 0.28, envAmt: 0.9, envDecay: 0.7, envSustain: 0.55, drive: 9, width: 0.9, glide: 0.04, attack: 0.012, release: 0.35, tone: 3600 };
const KICK = { preset: 'punchy-kick', pitch: 49, sweep: 2.2, decay: 0.38, tail: 0.08, click: 0.28, tone: 5200 }; // deep, but its tail short: the sub holds the low end
const SNARE = { preset: 'trap-snare', tune: 200, body: 0.7, noiseDecay: 0.27, noiseTone: 4600, tail: 0.3 };

// ── harmony ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The hook's chords for the saws and the pad: close, voice-led (F#3-G4), and never a second against the hook (no 9th in Bm: the hook
 *  sings it; plain G: the hook's G5 would rub on an F#). */
const V: Record<string, string[]> = {
  Bm: ['F#3', 'B3', 'D4', 'F#4'],
  G: ['G3', 'B3', 'D4', 'G4'],
  Em: ['G3', 'B3', 'E4', 'G4'],
  'F#': ['F#3', 'A#3', 'C#4', 'F#4'],
};
/** The lament: D and F# stay on top while the bass falls a semitone a bar (the voicing leaves out B over the A#, A over the G#). */
const VL: Record<string, string[]> = {
  Bm: ['F#3', 'B3', 'D4'],
  'Bm/A#': ['F#3', 'A#3', 'D4'],
  'Bm/A': ['F#3', 'A3', 'D4'],
  'G#m7b5': ['F#3', 'B3', 'D4'],
  Gmaj7: ['F#3', 'B3', 'D4'],
  'D/F#': ['F#3', 'A3', 'D4'],
  Em7: ['G3', 'B3', 'D4'],
  'F#': ['F#3', 'A#3', 'C#4'],
};
/** The bridge: the same close register, A major (the natural seventh) climbing to the tonic, then F#sus4 and the real dominant. */
const VB: Record<string, string[]> = {
  Gmaj7: ['F#3', 'B3', 'D4'],
  A: ['E3', 'A3', 'C#4'],
  Bm: ['F#3', 'B3', 'D4'],
  'F#sus4': ['F#3', 'B3', 'C#4'],
  'F#': ['F#3', 'A#3', 'C#4'],
};
/** The sub's roots (E1-B1), the piano's bass notes an octave up. */
const ROOT: Record<string, string> = {
  Bm: 'B1', G: 'G1', Em: 'E1', 'F#': 'F#1', 'Bm/A#': 'A#1', 'Bm/A': 'A1', 'G#m7b5': 'G#1', Gmaj7: 'G1', 'D/F#': 'F#1', Em7: 'E1', A: 'A1', 'F#sus4': 'F#1',
};
const ROOT2: Record<string, string> = Object.fromEntries(Object.entries(ROOT).map(([k, v]) => [k, v.replace('1', '2')]));
/** The piano's left hand under the hook: root, fifth, octave and tenth, rolled. */
const LH: Record<string, string[]> = {
  Bm: ['B2', 'F#3', 'B3', 'D4'],
  G: ['G2', 'D3', 'G3', 'B3'],
  Em: ['E2', 'B2', 'E3', 'G3'],
  'F#': ['F#2', 'C#3', 'F#3', 'A#3'],
};
/** The high shimmer over the drops: three notes per chord above the hook, chosen so that none is a semitone from the hook, its
 *  harmony or its octave-up double (Bm is B-F#-E, an open Bm11: the hook's D5 and C#5 would rub on a D or a C#). */
const SHIM: Record<string, string[]> = {
  Bm: ['F#5', 'B5', 'E6'],
  G: ['A5', 'B5', 'D6'],
  Em: ['B5', 'D6', 'E6'],
  'F#': ['A#5', 'C#6', 'F#6'],
};
const P1 = ['Bm', 'G', 'Em', 'F#', 'Bm', 'G', 'Em', 'F#']; // the hook: i VI iv V, twice
const PB = ['Gmaj7', 'A', 'Bm', 'Bm', 'Gmaj7', 'A', 'F#sus4', 'F#']; // the bridge: VI VII i, twice, the second time onto the dominant
const PL = ['Bm', 'Bm/A#', 'Bm/A', 'G#m7b5', 'Gmaj7', 'D/F#', 'Em7', 'F#']; // the lament: B A# A G# G F# E F# in the bass

/** One bar: a note or a chord struck on a 16-step rhythm ('x' strikes, 'X' accents, '-' holds, '.' rests). */
function strikeBar(what: string | readonly string[], rhythm: string): string {
  const r = rhythm.replace(/\s/g, '');
  const head = typeof what === 'string' ? what : `[${what.join(',')}]`;
  const out: string[] = [];
  let i = 0;
  while (i < r.length) {
    if (r[i] === 'x' || r[i] === 'X') {
      let n = 1;
      while (r[i + n] === '-') n++;
      out.push(`${head}${r[i] === 'X' ? '!' : ''}:${n}`);
      i += n;
    } else {
      out.push('.');
      i++;
    }
  }
  return out.join(' ');
}
/** A progression mapped through a table, one bar per chord, on a rhythm (one for every bar, or one per bar, cycling). */
function progText(names: readonly string[], table: Record<string, string | readonly string[]>, rhythm: string | readonly string[]): string {
  return names.map((c, i) => strikeBar(table[c], typeof rhythm === 'string' ? rhythm : rhythm[i % rhythm.length])).join(' | ');
}
/** Rolled chords: the notes enter `step` beats apart from the bottom up and ring to the end of the bar (the sustain pedal). */
function rolled(s: Song, names: readonly string[], table: Record<string, readonly string[]>, step: number, vel: number): Pattern {
  const b = s.pattern(names.length);
  names.forEach((c, i) => table[c].forEach((n, j) => b.note(i * 4 + j * step, n, 4 - j * step - 0.05, vel * (j === 0 ? 1 : 0.85))));
  return b.done();
}
/** Broken chords in eighths (`figure` indexes the chord's notes, -1 rests); short notes that the piano's release lets ring. */
function broken(s: Song, names: readonly string[], table: Record<string, readonly string[]>, figure: readonly number[], vel: number): Pattern {
  const b = s.pattern(names.length);
  names.forEach((c, i) =>
    figure.forEach((k, j) => {
      if (k >= 0) b.note(i * 4 + j * 0.5, table[c][k], 0.45, vel * (j % 2 === 0 ? 1 : 0.8));
    }),
  );
  return b.done();
}
/** The high arpeggio: three notes per bar played 1-2-3-2 on `res` steps per beat (3: eighth-note triplets). */
function shimmer(s: Song, names: readonly string[], res: number, vel: number): Pattern {
  const b = s.pattern(names.length);
  const order = [0, 1, 2, 1];
  names.forEach((c, i) => {
    for (let k = 0; k < 4 * res; k++) b.note(i * 4 + k / res, SHIM[c][order[k % 4]], 0.9 / res, vel * (k % 4 === 0 ? 1 : 0.72));
  });
  return b.done();
}

// ── melodies ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// the hook (F#4-B5), one string per bar; `~` glides the lead into the sighs and the cries (the polyphonic voices drop the marks)
const H = [
  'F#4:2 B4:4 D5:2 C#5~:8', // Bm: the question, sighing onto the 9th
  'B4:6 D5:2 G5~:8', // G: the reach
  'F#5:4 E5:2 D5:2 E5:4 B4:4', // Em: the turn
  'C#5:6 A#4:2 F#4:8', // F#: down to the low fifth
  'F#4:2 B4:4 D5:2 C#5~:8', // Bm: the question again
  'D5:6 F#5:2 B5!~:8', // G: the peak
  'A5:4 G5:2 F#5:2 G5:4 E5:4', // Em: the turn, a third higher
  'F#5:6 C#5:2 A#4:8', // F#: onto the leading tone
];
const H8_END = 'F#5:4 E5:2 C#5:2 A#4:4 C#5:4'; // the last bar of a drop climbs back towards the tonic
// the builds' last bar climbs the F#7 chord to F#5, the note F# and Bm share, so that its delay throw rings into the drop without a rub;
// the first build leaves its last beat silent, the second holds the F# alone through two beats of silence
const H8_BREATH = 'A#4:4 C#5:2 E5:2 F#5:4 . . . .';
const H8_HOLD = 'A#4:4 C#5:2 E5:2 F#5:8';
const HM8_HOLD = 'F#4:4 A#4:2 C#5:10';
const HOOK = H.join(' | ');
const HOOK_END = [...H.slice(0, 7), H8_END].join(' | ');
// the harmony a third or a fourth under the hook, all chord tones (the drops' second voice)
const HM = [
  'D4:2 F#4:4 B4:2 A4:8',
  'G4:6 B4:2 D5:8',
  'D5:4 B4:8 G4:4',
  'A#4:6 F#4:2 C#4:8',
  'D4:2 F#4:4 B4:2 A4:8',
  'B4:6 D5:2 G5:8',
  'E5:6 D5:2 E5:4 B4:4',
  'C#5:6 A#4:2 F#4:8',
];
const HM8_END = 'C#5:6 A#4:2 F#4:4 A#4:4';
const HARM = HM.join(' | ');
const HARM_END = [...HM.slice(0, 7), HM8_END].join(' | ');
// the verse melody over the lament: pickups into held notes, rising against the falling bass; the second half climbs to B5 and ends on
// the hook's own cadence (C#5 A#4 F#4)
const VM = [
  '. . . . B4:2 C#5:2 D5:8',
  'E5:4 D5:4 A#4:8',
  '. . . . A4:2 D5:2 F#5:8',
  'F#5:4 E5:4 D5:8',
  '. . . . B4:2 D5:2 F#5:6 E5:2',
  'D5:8 . . . . A4:2 B4:2',
  'D5:4 B4:4 G4:8',
  'A#4:6 C#5:2 E5:8',
  '. . . . D5:2 E5:2 F#5:8',
  'F#5:4 E5:4 D5:8',
  '. . . . D5:2 F#5:2 A5:8',
  'F#5:6 E5:2 D5:4 B4:4',
  '. . . . D5:2 F#5:2 B5:6 A5:2',
  'F#5:8 . . . . D5:2 E5:2',
  'G5:4 F#5:4 E5:4 D5:4',
  'C#5:6 A#4:2 F#4:8',
];
const VERSE_A = VM.slice(0, 8).join(' | ');
// the breakdown's bell sings the first half with a long delay: every bar ends on a note the next chord keeps (the A# of bar 2 becomes an
// F#, the G of bar 7 an E), so that the echoes never rub on the falling bass
const BELL_BD = [VM[0], 'E5:4 D5:4 F#4:8', ...VM.slice(2, 6), 'D5:4 B4:4 E5:8', VM[7]].join(' | ');
const VERSE_B = VM.slice(8).join(' | ');

// the bridge: long notes climbing a third a bar (D5 F#5, E5, D5 F#5, B5 ...), up to D6 and C#6, hanging on the leading tone A#5
const BRIDGE = [
  '. . . . D5:4 F#5~:8', // Gmaj7 (the voice scoops up into its long notes)
  'E5:12 C#5:4', // A
  '. . . . D5:4 F#5~:8', // Bm
  'B5:12 A5:2 F#5:2', // Bm
  '. . . . B5:4 D6~:8', // Gmaj7
  'C#6:12 B5:2 A5:2', // A
  'B5:8 C#6:8', // F#sus4
  'A#5:8 . . . . . . . .', // F#: the voice stops on the leading tone, two beats before the build
].join(' | ');

// ── the bass lines: the reese on the roots, their octaves and fifths ─────────────────────────────────────────────────────

// the first eight of a drop: long notes, the swirl and the wobble do the moving
const REESE_A =
  'B1:16 | G1:16 | E1:16 | F#1:8 . . F#1:2 F#2:4 | ' +
  'B1:16 | G1:16 | E1:12 . . E2:2 | F#1:6 . . F#1:4 F#2:4';
// the second eight: each bar answers the snare with an octave or a fifth
const REESE_B =
  'B1:6 . . B1:4 B2:4 | G1:6 . . G1:4 D2:4 | E1:6 . . E1:4 B1:4 | F#1:6 . . F#1:2 C#2:2 F#2:4 | ' +
  'B1:6 . . B1:4 B2:4 | G1:6 . . G1:4 D2:4 | E1:6 . . E1:4 B1:4 | F#1:4 F#2:4 C#2:4 F#2:4';
// drop 2's second eight: the reese swoops up an octave and back on every bar (slides), the wub the final drop talks with
const REESE_D =
  'B1:8 B2~:4 B1~:4 | G1:8 G2~:4 G1~:4 | E1:8 E2~:4 E1~:4 | F#1:8 F#2~:4 C#2~:4 | ' +
  'B1:8 B2~:4 B1~:4 | G1:8 G2~:4 D2~:4 | E1:8 E2~:4 B1~:4 | F#1:4 F#2~:4 C#2~:4 F#2~:4';
// the finale: octave bounces after the snare
const REESE_C = P1.map((c) => {
  const r = ROOT[c];
  const up = r.replace('1', '2');
  return `${r}:6 . . ${r}:2 ${up}:2 ${r}:2 ${up}:2`;
}).join(' | ');

// ── drums (16 steps a bar) ────────────────────────────────────────────────────────────────────────────────────────────
const KICK_DROP = 'X.........x..... | X.........x..x..'; // on 1 and after the snare, never under it
const KICK_FIN = 'X.........x..x.. | X......x..x..x..';
const KICK_VERSE = 'X.........x..... | X...............';
const BACK = '........X.......';
const HAT8 = 'x.x.x.x.x.x.x.x.';
const HAT8_R = 'x.x.x.x.x.x.....'; // beat 4 left to a roll
const HAT16 = 'xgxgxgxgxgxgxgxg';
const HAT16_R = 'xgxgxgxgxgxg....';
const HAT_OFF = '..x...x...x...x.';
const SHAKE = 'x.xxx.xxx.xxx.xx';
const FILL = '............x.xX';

export default defineTrack({ id: 'sodium-rain', title: 'Sodium Rain', genre: 'Melodic dubstep', bpm: 140, bars: 116, tail: 4.5 }, (s) => {
  s.key('B', 'minor');
  const S = s.sections({ intro: 8, verse: 16, build: 8, drop: 16, verse2: 8, breakdown: 8, bridge: 8, build2: 8, drop2: 16, finale: 8, outro: 12 });

  const music = s.bus('music', {}); // the saws, the pad, the piano and the arp: one filter for the transitions

  // ── drums ──
  const kick = s.kick(KICK, { gain: -4.5, eqMid: -3, eqMidFreq: 280, eqMidQ: 1.2 }); // deep, without the boxy low-mids
  const snare = s.snare(SNARE, { gain: -5, reverb: 0.3, key: true, fx: [fx.reverb({ time: 2.4, mix: 0.22, damp: 0.55 })] }); // the big tail; the backbeat pumps the music too
  const clap = s.clap('big-clap', { gain: -10, reverb: 0.4, pan: 0.06 });
  const rim = s.perc('rim', { name: 'rim', gain: -13, reverb: 0.4, pan: -0.1 });
  const roll = s.snare({ preset: 'trap-snare', tune: 215 }, { name: 'roll', gain: -13, reverb: 0.25 });
  const hat = s.hat('closed-hat', { gain: -10, pan: 0.16 });
  const shaker = s.perc('shaker', { name: 'shaker', gain: -17, pan: -0.28 });
  const crash = s.cymbal('crash-dark', { name: 'crash', gain: -12, reverb: 0.25 });
  const swell = s.cymbal('reverse-crash', { name: 'swell', gain: -14 });
  // ── bass ──
  const sub = s.sub('sub-sine', { gain: -9, duck: 0.9 });
  const reese = s.reese(REESE, { name: 'reese', gain: -7, duck: 0.75, hp: 70, eqMid: -3.5, eqMidFreq: 800, eqMidQ: 0.8 }); // a dip where the lead sings
  // ── harmony ──
  // the saws breathe on every beat (their own pump, the Polarize / Fortress sound) and still duck a little for the kick's syncopations
  const saws = s.synth(WIDE_SAW, { name: 'saws', gain: -7, duck: 0.45, reverb: 0.3, hp: 160, width: 1.3, bus: 'music',
    fx: [fx.pump({ pattern: 'x...x...x...x...', depth: 0, release: 0.3, curve: 1.4 })] });
  const pad = s.synth(NIGHT_PAD, { name: 'pad', gain: -12, duck: 0.5, reverb: 0.5, hp: 110, fx: [fx.chorus({ rate: 0.25, depth: 4, mix: 0.4 })], bus: 'music' });
  const piano = s.synth(NIGHT_PIANO, { name: 'piano', gain: -6, reverb: 0.42, delay: 0.14, bus: 'music' });
  piano.groove({ push: 3, humanize: { time: 3, vel: 0.06 } }); // a player's hands, not a grid: a little late, never early
  const arp = s.synth(STREAM, { name: 'arp', gain: -2, delay: 0.3, reverb: 0.25, duck: 0.4, hp: 300, bus: 'music' });
  // ── melody ──
  const lead = s.synth(NIGHT_LEAD, { name: 'lead', gain: -2.5, reverb: 0.3, delay: 0.2, duck: 0.2 });
  const harm = s.synth(NIGHT_LEAD, { name: 'harm', gain: -9.5, reverb: 0.32, delay: 0.2, duck: 0.25 });
  const halo = s.synth(HALO, { name: 'halo', gain: -7, reverb: 0.4, delay: 0.16 });
  const bell = s.synth(GLASS_BELL, { name: 'bell', gain: -8, reverb: 0.45, delay: 0.42, pan: 0.15 });
  // ── atmosphere and transitions ──
  const rain = s.add('rain', (ctx) => new Rain(ctx), { gain: -6, hp: 600, lp: 11000 });
  const riser = s.riser('riser', { gain: -17 });
  const wash = s.riser('noise-wash', { name: 'wash', gain: -18 });
  const down = s.riser('downlifter', { name: 'down', gain: -15, reverb: 0.35 });
  const boom = s.impact('impact', { name: 'boom', gain: -7, reverb: 0.35 });
  const car = s.riser({ preset: 'whoosh', startHz: 250, endHz: 2400, tone: 0.05, q: 0.9 }, { name: 'car', gain: -22, reverb: 0.3 }); // a car passing

  // ── patterns ──
  const held = 'x---------------';
  const keys = (text: string): Pattern => s.notes(text.replace(/[~!]/g, '')); // the hook for the piano and the bell: polyphonic, no slides
  // how a pianist would phrase a melody: the long notes on the snare sung out, the pickups lighter, the second half (the peak) a little louder
  const phrased = (p: Pattern): Pattern => p.vel((e) => e.v * (e.d >= 1.4 ? 1.08 : e.d < 0.75 ? 0.86 : 1) * (Math.floor(e.t / 4) % 8 >= 4 && Math.floor(e.t / 4) % 8 < 6 ? 1.07 : 1));
  const hook = s.notes(HOOK);
  const hookEnd = s.notes(HOOK_END);
  const sawsP1 = s.notes(progText(P1, V, held));
  const padP1 = sawsP1;
  const padPL = s.notes(progText(PL, VL, held));
  const subP1 = s.notes(progText(P1, ROOT, held));
  const subPL = s.notes(progText(PL, ROOT, held));
  const pianoLH = rolled(s, P1, LH, 0.5, 0.5);
  const pianoBassPL = rolled(s, PL, Object.fromEntries(PL.map((c) => [c, [ROOT2[c]]])), 0, 0.55);
  const pianoBrokenPL = broken(s, PL, VL, [0, 1, 2, 1, 2, 1, 0, 1], 0.36);
  const shim = shimmer(s, P1, 3, 0.6);
  const hats = (bar: number, n: number, sixteenths: boolean, vel: number, rollEvery = 2): void => {
    for (let b = 0; b < n; b++) {
      const rollHere = (b + 1) % rollEvery === 0;
      const p = sixteenths ? (rollHere ? HAT16_R : HAT16) : rollHere ? HAT8_R : HAT8;
      hat.play(s.hits(p), bar + b, 1, { vel });
      if (rollHere) hat.play(s.hits('345678', { res: 6 }), bar + b + 0.75, 0.25, { vel });
    }
  };

  // ── a build: chords re-struck faster and faster, the snare rolling up, the riser, the silence before the drop ──
  // (no sub and a high-passed kick: the low end is saved for the drop, so the build is never as loud as what it leads to)
  const build = (at: number, o: { second?: boolean } = {}): void => {
    const end = o.second ? 7.5 : 7.75;
    saws.play(s.notes(progText(P1, V, 'x---x---x---x---')), at, 6, { vel: 0.62 });
    saws.play(s.notes(progText(P1.slice(6), V, ['x-x-x-x-x-x-x-x-', o.second ? 'xxxxxxxx........' : 'xxxxxxxxxxxx....'])), at + 6, 2, { vel: 0.62 });
    saws.auto('mix.hp', [[at, 200], [at + end, 1000, 'exp'], [at + 8, 160, 'step']]);
    saws.auto('fx.pump.depth', [[at, 0], [at + 4, 0], [at + 8, 0.45]]); // the build opens into the drop's pump
    pad.play(padP1, at, end, { vel: 0.7 });
    piano.play(phrased(keys(HOOK)), at, 4, { vel: 0.8 });
    piano.play(pianoLH, at, 4, { vel: 1 });
    const second = s.notes([H[4], H[5], H[6], o.second ? H8_HOLD : H8_BREATH].join(' | '));
    lead.play(second, at + 4, 4);
    lead.auto('cutoff', [[at + 4, 900], [at + 7.75, 5200, 'exp'], [at + 8, NIGHT_LEAD.cutoff as number, 'step']]);
    lead.auto('mix.delay', [[at + 7.5, 0.2], [at + 7.5, 0.55, 'step'], [at + 8, 0.2, 'step']]); // a delay throw on the last held note
    if (o.second) {
      harm.play(s.notes([HM[4], HM[5], HM[6], HM8_HOLD].join(' | ')), at + 4, 4, { vel: 0.85 });
      lead.play(hook, at, 4, { vel: 0.7 });
      lead.auto('cutoff', [[at, 600], [at + 4, 900, 'exp']]);
      reese.play(s.notes(progText(P1.slice(4), ROOT, held)), at + 4, 3.5, { vel: 0.7 });
      reese.auto('cutoff', [[at + 4, 140], [at + 7.5, 520, 'exp'], [at + 8, 700, 'step']]);
    }
    kick.play(s.hits('X.......X.......'), at, 4, { vel: 0.72 });
    kick.play(s.hits('X...X...X...X...'), at + 4, 2, { vel: 0.72 });
    kick.play(s.hits('X.X.X.X.X.X.X.X.'), at + 6, 1, { vel: 0.72 });
    kick.auto('mix.hp', [[at, 20], [at, 200, 'step'], [at + 8, 20, 'step']]);
    clap.play(s.hits('....x.......x...'), at, 6, { vel: 0.5 });
    hat.play(s.hits(HAT8), at, 6, { vel: 0.5 });
    roll.play(s.hits('3.3.4.4.5.5.6.6. | 6.6.7.7.7.7.8.8.'), at + 4, 2, { vel: 0.65 });
    roll.play(s.hits('6677778888889999'), at + 6, 1, { vel: 0.65 });
    roll.play(s.hits(o.second ? '9999999999999999................' : '999999999999999999999999........', { res: 8 }), at + 7, 1, { vel: 0.65 });
    roll.auto('tune', [[at + 4, 200], [at + end, 410, 'exp'], [at + 8, 215, 'step']]);
    riser.hit(at, '', 1, 0, 31);
    wash.hit(at + 4, '', 1, 0, 15);
    swell.note(at + 7, 'A3', 4, 1);
    music.auto('mix.lp', [[at, 2600], [at + end, 20000, 'exp']]);
  };

  // ── a drop: half-time drums, the sub and the reese on the roots, the saws, the hook; two eights ──
  const drop = (at: number, o: { final?: boolean } = {}): void => {
    boom.hit(at, '', 1);
    crash.hit(at, '', 1);
    crash.hit(at + 8, '', 0.75);
    kick.play(s.hits(KICK_DROP), at, 16);
    for (const ch of [snare, clap]) ch.play(s.hits(BACK), at, 16);
    hats(at, 8, false, 0.7, 4);
    hats(at + 8, 8, true, 0.75, 2);
    roll.play(s.hits(FILL), at + 7, 1, { vel: 0.7 });
    roll.play(s.hits(FILL), at + 15, 1, { vel: 0.8 });
    sub.play(subP1, at, 16);
    reese.play(s.notes(REESE_A), at, 8);
    reese.play(s.notes(o.final ? REESE_D : REESE_B), at + 8, 8);
    // the wobble: half notes, then quarters, eighths on the last bar of each eight
    reese.lfo('cutoff', { period: 2, depth: o.final ? 1.4 : 1.1, mode: 'exp', from: at, to: at + 7 });
    reese.lfo('cutoff', { period: 0.5, depth: 1.2, mode: 'exp', from: at + 7, to: at + 8 });
    reese.lfo('cutoff', { period: 1, depth: 1.2, mode: 'exp', from: at + 8, to: at + 15 });
    reese.lfo('cutoff', { period: 0.5, depth: 1.3, mode: 'exp', from: at + 15, to: at + 16 });
    saws.play(sawsP1, at, 8);
    saws.play(s.notes(progText(P1, V, 'x---------x-----')), at + 8, 8);
    saws.auto('fx.pump.depth', [[at, 0.65]]); // the full pump from the downbeat (held through the finale)
    lead.play(hook, at, 8);
    lead.play(hookEnd, at + 8, 8);
    arp.play(shim, at + (o.final ? 0 : 8), o.final ? 16 : 8, { vel: o.final ? 0.85 : 0.75 });
    if (o.final) {
      harm.play(s.notes(HARM), at, 8);
      harm.play(s.notes(HARM_END), at + 8, 8);
      bell.play(keys(HOOK), at, 8, { transpose: 12, vel: 0.55 });
      piano.play(keys(HOOK_END), at + 8, 8, { transpose: 12, vel: 0.85 });
    }
  };

  // ── intro: the rain, a pad that opens, the hook on the piano ──
  rain.hit(0, 'rain', 0.9, 0, 10 * 4);
  pad.play(padP1, S.intro, undefined, { vel: 0.7 });
  pad.auto('cutoff', [[0, 500], [8, 1300, 'exp']]);
  piano.play(phrased(keys(HOOK)), S.intro, undefined, { vel: 0.72 });
  piano.play(pianoLH, S.intro);
  sub.play(subP1, 4, 4, { vel: 0.6, from: 16 });
  swell.note(S.verse.bar - 1, 'A3', 4, 0.7);
  hat.play(s.hits(HAT_OFF), 6, 2, { vel: 0.4 });
  car.hit(2, '', 0.8, 0, 8);
  car.auto('mix.pan', [[2, -0.85], [4, 0.85]]);

  // ── verse: the lament; a soft half-time beat, the sub, the verse melody on the halo voice ──
  pad.play(padPL, S.verse, undefined, { vel: 0.7 });
  piano.play(pianoBassPL, S.verse);
  piano.play(pianoBrokenPL, S.verse);
  halo.play(s.notes(VERSE_A), S.verse.bar, 8);
  halo.play(s.notes(VERSE_B), S.verse.bar + 8, 8);
  bell.play(keys(VM.slice(12).join(' | ')), S.verse.bar + 12, 4, { transpose: 12, vel: 0.45 }); // a sparkle over the climb
  sub.play(subPL, S.verse);
  kick.play(s.hits(KICK_VERSE), S.verse.bar, 8, { vel: 0.5 });
  rim.play(s.hits(BACK), S.verse.bar, 8, { vel: 0.6 });
  hat.play(s.hits(HAT_OFF), S.verse.bar + 4, 4, { vel: 0.45 });
  shaker.play(s.hits(SHAKE), S.verse.bar + 4, 4, { vel: 0.4 });
  crash.hit(S.verse.bar + 8, '', 0.6);
  kick.play(s.hits(KICK_DROP), S.verse.bar + 8, 8, { vel: 0.55 });
  snare.play(s.hits(BACK), S.verse.bar + 8, 8, { vel: 0.6 });
  clap.play(s.hits(BACK), S.verse.bar + 8, 8, { vel: 0.5 });
  hats(S.verse.bar + 8, 8, false, 0.55, 4);
  shaker.play(s.hits(SHAKE), S.verse.bar + 8, 8, { vel: 0.45 });
  roll.play(s.hits(FILL), S.verse.end - 1, 1, { vel: 0.5 });
  // the sub sits lower outside the drops
  sub.auto('mix.gain', [[0, -14], [S.drop.bar, -9, 'step'], [S.verse2.bar, -12, 'step'], [S.drop2.bar, -9, 'step'], [S.outro.bar, -13, 'step']]);

  build(S.build.bar);
  drop(S.drop.bar);
  // the way out of each drop: the lead's tonic, held, dives an octave
  lead.note(S.verse2.bar, 'B4', 4, 0.8);
  lead.auto('bend', [[S.verse2.bar + 0.4, 0], [S.verse2.bar + 1, -12, 'in'], [S.verse2.bar + 1, 0, 'step']]);

  // ── verse 2: the beat goes on under the lament; the reese, closed, walks down with the bass; the climbing verse on the piano ──
  down.hit(S.verse2.bar, '', 1, 0, 8);
  kick.play(s.hits(KICK_VERSE), S.verse2, undefined, { vel: 0.6 });
  snare.play(s.hits(BACK), S.verse2, undefined, { vel: 0.7 });
  clap.play(s.hits(BACK), S.verse2, undefined, { vel: 0.55 });
  hats(S.verse2.bar, 8, false, 0.55, 4);
  shaker.play(s.hits(SHAKE), S.verse2, undefined, { vel: 0.4 });
  sub.play(subPL, S.verse2);
  reese.play(subPL, S.verse2, undefined, { vel: 0.7 });
  reese.auto('cutoff', [[S.verse2.bar, 360], [S.verse2.end, 360], [S.verse2.end, 700, 'step']]);
  reese.auto('mix.gain', [[S.verse2.bar, -7], [S.verse2.bar, -13, 'step'], [S.verse2.end, -7, 'step']]);
  pad.play(padPL, S.verse2, undefined, { vel: 0.65 });
  piano.play(phrased(keys(VERSE_B)), S.verse2, undefined, { vel: 0.75 });
  piano.play(pianoBassPL, S.verse2);
  bell.play(keys(VM.slice(12).join(' | ')), S.verse2.bar + 4, 4, { transpose: 12, vel: 0.4 });

  roll.play(s.hits(FILL), S.verse2.end - 1, 1, { vel: 0.6 });

  // ── breakdown: no beat; the lament on the piano and the pad, the verse melody on a bell with a long delay, the rain ──
  down.hit(S.breakdown.bar, '', 0.8, 0, 8);
  crash.hit(S.breakdown.bar, '', 0.5);
  car.hit(S.breakdown.bar + 3, '', 0.7, 0, 8);
  car.auto('mix.pan', [[S.breakdown.bar + 3, 0.85], [S.breakdown.bar + 5, -0.85]]);
  rain.hit(S.breakdown.bar, 'rain', 0.8, 0, 12 * 4);
  pad.play(padPL, S.breakdown.bar, 8, { vel: 0.75 });
  piano.play(rolled(s, PL, Object.fromEntries(PL.map((c) => [c, [ROOT2[c], ...VL[c]]])), 0.5, 0.5), S.breakdown.bar, 8);
  bell.play(keys(BELL_BD), S.breakdown.bar, 8, { transpose: 12, vel: 0.55 });
  s.auto('delay.feedback', [[S.breakdown.bar, 0.42], [S.breakdown.bar, 0.55, 'step'], [S.breakdown.bar + 8, 0.42, 'step']]);

  // ── bridge: something new before the last build: VI VII i over a bass that climbs G A B, the halo voice soaring from D5 to D6 and
  // hanging on the leading tone; the beat creeps back in ──
  const back = S.bridge.bar;
  pad.play(s.notes(progText(PB, VB, held)), S.bridge, undefined, { vel: 0.72 });
  piano.play(rolled(s, PB, Object.fromEntries(PB.map((c) => [c, [ROOT2[c], ...VB[c]]])), 0.5, 0.5), S.bridge);
  halo.play(s.notes(BRIDGE), S.bridge);
  bell.play(keys(BRIDGE), back + 4, 4, { from: 16, vel: 0.35 });
  sub.play(s.notes(progText(PB, ROOT, held)), S.bridge, undefined, { vel: 0.75 });
  kick.play(s.hits(KICK_VERSE), back + 4, 4, { vel: 0.45 });
  rim.play(s.hits(BACK), back + 4, 4, { vel: 0.5 });
  hat.play(s.hits(HAT_OFF), back + 6, 2, { vel: 0.4 });
  swell.note(S.build2.bar - 1, 'A3', 4, 0.8);
  music.auto('mix.lp', [[S.breakdown.bar, 6000], [back, 6000], [S.bridge.end, 12000, 'exp']]);

  build(S.build2.bar, { second: true });
  drop(S.drop2.bar, { final: true });

  // ── finale: the hook's second half twice, everything at once; the reese bounces in octaves, the saws pulse in eighths ──
  const F = S.finale.bar;
  const peak = [H[4], H[5], H[6], H[7], H[4], H[5], H[6], H8_END].join(' | ');
  const peakHarm = [HM[4], HM[5], HM[6], HM[7], HM[4], HM[5], HM[6], HM8_END].join(' | ');
  boom.hit(F, '', 0.9);
  crash.hit(F, '', 1);
  crash.hit(F + 4, '', 0.8);
  kick.play(s.hits(KICK_FIN), F, 8);
  for (const ch of [snare, clap]) ch.play(s.hits(BACK), F, 8);
  hats(F, 8, true, 0.8, 2);
  roll.play(s.hits('........x.x.xxxX'), F + 7, 1, { vel: 0.8 });
  sub.play(subP1, F, 8);
  reese.play(s.notes(REESE_C), F, 8);
  reese.lfo('cutoff', { period: 1, depth: 1.2, mode: 'exp', from: F, to: F + 7 });
  reese.lfo('cutoff', { period: 0.5, depth: 1.3, mode: 'exp', from: F + 7, to: F + 8 });
  saws.play(s.notes(progText(P1, V, 'x-x-x-x-x-x-x-x-')), F, 8, { vel: 0.9 });
  lead.play(s.notes(peak), F, 8);
  harm.play(s.notes(peakHarm), F, 8);
  bell.play(keys(peak), F, 8, { transpose: 12, vel: 0.55 });
  piano.play(keys(peak), F, 8, { transpose: 12, vel: 0.65 });
  arp.play(shim, F, 8, { vel: 0.85 });

  // ── outro: the drop's last note dies away; the hook on the piano one last time over the rain; an open Bm(add9) left to ring ──
  const O = S.outro.bar;
  lead.note(O, 'B4', 4, 0.75);
  lead.auto('bend', [[O + 0.4, 0], [O + 1, -12, 'in'], [O + 1, 0, 'step']]);
  down.hit(O, '', 0.9, 0, 8);
  rain.hit(O, 'rain', 0.85, 0, 12 * 4);
  reese.note(O, 'B1', 8, 0.6);
  reese.auto('cutoff', [[O, 700], [O + 2, 160, 'exp']]);
  pad.play(padP1, O, 8, { vel: 0.7 });
  piano.play(phrased(keys(HOOK)), O, 8, { vel: 0.72 });
  piano.play(pianoLH, O, 8);
  sub.play(subP1, O, 4, { vel: 0.7 });
  kick.play(s.hits(KICK_VERSE), O, 4, { vel: 0.55 });
  hat.play(s.hits(HAT_OFF), O, 4, { vel: 0.4 });
  // the question one last time, then the last chord rolled from the bottom up and left to ring: Bm with the 9th on top, unresolved
  pad.play(s.notes('[F#3,B3,D4,F#4]:64'), O + 8, 4, { vel: 0.6 });
  sub.play(s.notes('B1:64'), O + 8, 4, { vel: 0.5 });
  piano.play(keys(H[0]), O + 8, 1, { vel: 0.62 });
  const fin = s.pattern(3);
  ['B1', 'F#2', 'B2', 'F#3', 'B3', 'D4', 'C#5'].forEach((n, j) => fin.note(j * 0.16, n, 12 - j * 0.16, j === 0 ? 0.55 : 0.47));
  piano.play(fin.done(), O + 9, 3);
  bell.note(O + 9, 'C#6', 8, 0.35);

  // ── the music bus: half closed at the start, open by the verse ──
  music.auto('mix.lp', [[0, 3500], [S.intro.end, 20000, 'exp']]);

  s.setReverb({ time: 4.2, size: 1.3, preDelay: 0.035, damp: 0.55, lowCut: 240, highCut: 7000, mod: 0.6, return: -9, duck: 0.25 }); // a long, dark hall that breathes with the kick
  s.setDelay({ time: '1/8.', feedback: 0.42, tone: 3200, lowCut: 350, pingpong: 0.9, mod: 0.25, return: -10, duck: 0.3 });
  s.setSidechain({ release: 0.3, curve: 1.4 });
  s.setMaster({ trim: 5.9 }); // found with the probe's AUTOTRIM=1
});
