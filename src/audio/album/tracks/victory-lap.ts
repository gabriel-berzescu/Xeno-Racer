// Victory Lap: euphoric melodic dubstep for Xeno-Racer Vol. 1. 150 BPM in half time, Ab major.
//
// The hook is an 8-bar topline over a bass that walks down Ab G F Db and turns home Bb Eb Db Ab:
//   Ab | Eb/G | Fm7 | Db | Bbm7 | Ebsus4 Eb | Db Dbm | Ab
// Each odd bar opens with two pickups that leap to a syncopated long note (on the "and" of beat 2); the line climbs a little higher each
// time (Ab5, C6/Db6, Bb5), jumps an octave to Eb6 over Db and falls through the borrowed Dbm (its Fb, written E) home to Ab. A second
// theme, the counter-line, moves in turns (Eb F Eb, C Bb C, Db Eb Db) and fits under the hook note for note: it is the verse's pluck,
// the break's duet with the piano, and in the finale both themes sound together.
//
// Form (bars): intro 0-8 (the hook on the piano), verse 8-16 (the counter-line on a pluck, a light beat), build 16-24, drop 24-40,
// break 40-56 (a new progression with the piano, then the duet), build2 56-64, drop2 64-80 (the talking growl, the hook harmonised, a
// bell answering), switch 80-88 (future bass: chords bouncing on the hook's rhythm, the counter-line an octave up), finale 88-104 (both themes
// together over everything), outro 104-112 (the counter-line on the piano, the last chord rolled).
//
// Probe:  ALBUM=1 ONLY=victory-lap AUTOTRIM=1 SPEC=1 CLASH=1 npx vitest run tests/probes/album-render.test.ts
import { defineTrack, fx, midiToName } from '../song';
import type { GrowlOpts, SynthOpts } from '../song';

// ── patches ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A soft grand: an FM pair that is bright for a moment after the hammer, a triangle body, a faint octave. */
const KEYS: SynthOpts = {
  layers: [
    { wave: 'fm', level: 1 },
    { wave: 'tri', unison: 2, detune: 0.8, level: 0.3 },
    { wave: 'sine', octave: 1, level: 0.08 },
  ],
  fmRatio: 1, fmIndex: 2.4, fmDecay: 0.5, fmSustain: 0.1, fmFeedback: 0.04,
  filter: 'lp', cutoff: 3400, res: 0.05, envAmt: 1.3, fAttack: 0.001, fDecay: 0.35, fSustain: 0.3, fRelease: 0.5, keytrack: 0.7, velFilter: 0.9,
  attack: 0.002, decay: 4, sustain: 0, release: 0.9, velAmp: 0.75,
  unisonDetune: 5, spread: 0.55, voices: 16,
  click: 0.22, clickTone: 2200, clickDecay: 0.005, // the hammer
};

/** The drop lead: seven saws, a thin pulse an octave up for air, a sine an octave down for body; legato, glide, a late vibrato. */
const SKY: SynthOpts = {
  mode: 'legato', voices: 1,
  layers: [
    { wave: 'saw', unison: 7, detune: 1, phase: 'free' },
    { wave: 'pulse', octave: 1, unison: 2, detune: 0.5, level: 0.22, phase: 'free' },
    { wave: 'sine', octave: -1, level: 0.35, phase: 'free' },
  ],
  pw: 0.3,
  filter: 'lp', cutoff: 5200, res: 0.12, envAmt: 0.9, fAttack: 0.004, fDecay: 0.35, fSustain: 0.55, keytrack: 0.6,
  attack: 0.01, decay: 0.3, sustain: 0.9, release: 0.35,
  glide: 0.055, glideMode: 'fingered', vibDepth: 22, vibRate: 5.6, vibDelay: 0.28, // clean note starts; only the ~ swoop glides
  unisonDetune: 18, spread: 0.85,
};

/** The counter-line's voice: a hollow pulse trio with a sine core, softer than the lead, a slow pulse-width drift. */
const VOICE: SynthOpts = {
  mode: 'legato', voices: 1,
  layers: [
    { wave: 'pulse', unison: 3, detune: 0.6, phase: 'free' },
    { wave: 'sine', level: 0.6, phase: 'free' },
  ],
  pw: 0.42, pwmDepth: 0.12, pwmRate: 0.4,
  filter: 'lp', cutoff: 2600, res: 0.12, envAmt: 0.7, fAttack: 0.03, fDecay: 0.5, fSustain: 0.6, keytrack: 0.5,
  attack: 0.03, decay: 0.4, sustain: 0.9, release: 0.45,
  glide: 0.06, vibDepth: 18, vibRate: 5, vibDelay: 0.4,
  unisonDetune: 10, spread: 0.6,
};

/** The chords: the supersaw staple with a future-bass wobble (pitch and filter on LFO 1) that only the switch turns on. */
const CHORDS: SynthOpts = {
  preset: 'supersaw-chord',
  mods: [
    { src: 'lfo1', dst: 'pitch', amount: 0.22 },
    { src: 'lfo1', dst: 'cutoff', amount: 0.8 },
  ],
  lfo1Rate: 2, lfo1Depth: 0,
};

/** The main growl: a brighter vowel (E) than the classic, a second-harmonic FM, an eighth-note wobble that opens from closed. */
const GROWL_A: GrowlOpts = {
  preset: 'dubstep-growl', sub: 0,
  cutoff: 380, res: 0.45, lfoRate: 2, lfoPhase: 0.75, lfoDepth: 3.0, lfoFm: 2.2, lfoVowel: 1.4, vowel: 1.2, formant: 0.6,
  fmMix: 0.5, fmRatio: 2, fmIndex: 3.2, drive: 17, fold: 0.3, clip: 7, envAmt: 1.2, envDecay: 0.12, tone: 9000, release: 0.05,
  width: 0.6, pEnv: 3, pEnvTime: 0.05, // wide above 200 Hz; every note bites down into its pitch from a minor third above
};

/** The talking growl of drop 2: an O that sweeps through the vowels on a half-note wobble. */
const TALK: GrowlOpts = {
  preset: 'yoi', sub: 0, lfoRate: 0.5, lfoPhase: 0.75, vowel: 3, lfoVowel: 2.6, formant: 0.85, fmMix: 0.45, fmIndex: 3.4, lfoFm: 2.4,
  drive: 16, fold: 0.22, tone: 9000, release: 0.06,
  width: 0.8, pEnv: -5, pEnvTime: 0.12, // wide; each word scoops up a fourth into its vowel
};

// ── harmony ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Hand-voiced chords in G3-C5 (the hook lives above C5). No Ab4 under the Ab chord: its octave layer would sit a semitone above the hook's G5. */
const V: Record<string, string[]> = {
  Ab: ['Ab3', 'C4', 'Eb4', 'C5'],
  'Eb/G': ['G3', 'Bb3', 'Eb4', 'Bb4'],
  Fm7: ['Ab3', 'C4', 'Eb4', 'F4'],
  Db: ['Ab3', 'Db4', 'F4', 'Ab4'],
  Bbm7: ['Ab3', 'Db4', 'F4', 'Bb4'],
  Ebsus4: ['Bb3', 'Eb4', 'Ab4', 'Bb4'],
  Eb: ['Bb3', 'Eb4', 'G4', 'Bb4'],
  Dbm: ['Ab3', 'Db4', 'E4', 'Ab4'], // E = Fb, the borrowed minor iv
  // the break
  Dbmaj7: ['Ab3', 'Db4', 'F4', 'C5'],
  Cm7: ['G3', 'C4', 'Eb4', 'Bb4'],
  Fm: ['Ab3', 'C4', 'Eb4', 'Ab4'], // Fm7 without its F (the bass has it)
  'Fm/Eb': ['Ab3', 'C4', 'F4', 'Ab4'],
};
/** The bass root of each chord, as a MIDI note in F1-Eb2 (the sub and the growls). */
const ROOT: Record<string, number> = {
  Ab: 32, 'Eb/G': 31, Fm7: 29, Db: 37, Bbm7: 34, Ebsus4: 39, Eb: 39, Dbm: 37,
  Dbmaj7: 37, Cm7: 36, Fm: 29, 'Fm/Eb': 39,
};

/** The piano's left hand: the bass note and a fifth or the chord's third above it (G2-Bb3). */
const LH: Record<string, string[]> = {
  Ab: ['Ab2', 'Eb3'], 'Eb/G': ['G2', 'Eb3'], Fm7: ['F2', 'C3'], Db: ['Db3', 'Ab3'], Bbm7: ['Bb2', 'F3'], Ebsus4: ['Eb3', 'Bb3'], Eb: ['Eb3', 'Bb3'],
  Dbm: ['Db3', 'Ab3'], Dbmaj7: ['Db3', 'Ab3'], Cm7: ['C3', 'G3'], Fm: ['F2', 'C3'], 'Fm/Eb': ['Eb3', 'C4'],
};

type Seg = readonly [chord: string, steps: number];
type Bar = readonly Seg[];
const one = (c: string): Bar => [[c, 16]];
/** The hook's progression: one chord a bar, two in bars 6 and 7. */
const P1: Bar[] = [one('Ab'), one('Eb/G'), one('Fm7'), one('Db'), one('Bbm7'), [['Ebsus4', 8], ['Eb', 8]], [['Db', 8], ['Dbm', 8]], one('Ab')];
/** The builds: the first half of P1, then ii held and the dominant, suspended and resolved. */
const PB: Bar[] = [one('Ab'), one('Eb/G'), one('Fm7'), one('Db'), one('Bbm7'), one('Bbm7'), one('Ebsus4'), one('Eb')];
/** The break: IV iii vi vi/5 IV iii ii V, the bass falling Db C F Eb. */
const PBR: Bar[] = [one('Dbmaj7'), one('Cm7'), one('Fm'), one('Fm/Eb'), one('Dbmaj7'), one('Cm7'), one('Bbm7'), [['Ebsus4', 8], ['Eb', 8]]];

/**
 * A progression on a 16-step rhythm per bar: 'x' strikes (X accented), '-' holds, '.' rests. A held note is struck again where the
 * chord changes under it, and `pick` turns a chord into what is played (its voicing, its root, a riff note).
 */
function onBars(prog: readonly Bar[], rhythm: string | readonly string[], pick: (chord: string, ch: string) => string): string {
  return prog
    .map((bar, i) => {
      const r = (typeof rhythm === 'string' ? rhythm : rhythm[i % rhythm.length]).replace(/[\s|]/g, '');
      if (r.length !== 16) throw new Error(`rhythm "${r}" is not 16 steps`);
      const at: string[] = [];
      for (const [c, n] of bar) for (let k = 0; k < n; k++) at.push(c);
      const out: string[] = [];
      let k = 0;
      let ch = '';
      while (k < 16) {
        const c = r[k];
        const start = c !== '.' && c !== '-' ? c : c === '-' && ch !== '' && at[k] !== at[k - 1] ? ch : '';
        if (start === '') {
          if (c === '.') ch = '';
          out.push('.');
          k++;
          continue;
        }
        ch = start;
        let n = 1;
        while (k + n < 16 && r[k + n] === '-' && at[k + n] === at[k]) n++;
        out.push(`${pick(at[k], start)}${start === start.toUpperCase() && start !== start.toLowerCase() ? '!' : ''}:${n}`);
        k += n;
      }
      return out.join(' ');
    })
    .join(' | ');
}
const chordOf = (c: string): string => `[${V[c].join(',')}]`;
const rootOf = (c: string): string => midiToName(ROOT[c], true);
/** A bass riff: x the root, o the octave above, f the fifth above (upper case accented). */
const riffNote = (c: string, ch: string): string => midiToName(ROOT[c] + ({ x: 0, o: 12, f: 7 } as Record<string, number>)[ch.toLowerCase()], true);

// ── melodies ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const HOOK_A = '. . C5:2 Eb5:2 Ab5:6 G5:2 Ab5:2 | Bb5:6 G5:4 Eb5:6 | . . C5:2 Eb5:2 Ab5:6 Bb5:2 C6:2 | Db6!:6 C6:2 Ab5:8';
const HOOK_B1 = '. . Db5:2 F5:2 Bb5:6 Ab5:2 F5:2 | Ab5:8 G5:4 Eb5:4';
const HOOK = `${HOOK_A} | ${HOOK_B1} | Eb6!~:4 Db6:2 Ab5:2 E5:6 Db5:2 | C5:4 Eb5:4 Ab5:8`; // ~: the lead swoops up the octave from Eb5
// the second time the end climbs back up to the high tonic
const HOOK_END = `${HOOK_A} | ${HOOK_B1} | Eb6!~:4 Db6:2 Ab5:2 E5:6 Ab5:2 | C6:4 Bb5:2 C6:2 Ab5:8`;
// the last statement: the octave leap goes on up to F6, and the line hangs on C6
const HOOK_FINAL = `${HOOK_A} | ${HOOK_B1} | Eb6!~:6 F6!:2 Eb6:4 Db6:4 | C6:16`;
// the harmony a third (or a fourth) below the hook
const HARM_A = '. . Ab4:2 C5:2 Eb5:6 Eb5:2 C5:2 | G5:6 Eb5:4 Bb4:6 | . . Ab4:2 C5:2 F5:6 F5:2 Ab5:2 | Ab5:6 Ab5:2 F5:8';
const HARM_B1 = '. . Bb4:2 Db5:2 F5:6 F5:2 Db5:2 | Eb5:8 Eb5:4 Bb4:4';
const HARM = `${HARM_A} | ${HARM_B1} | Ab5:4 Ab5:2 F5:2 Db5:6 Ab4:2 | Ab4:4 C5:4 Eb5:8`;
const HARM_END = `${HARM_A} | ${HARM_B1} | Ab5:4 Ab5:2 F5:2 Db5:6 E5:2 | Ab5:4 G5:2 Ab5:2 Eb5:8`;
// the counter-line: turns around a note, fitting under the hook note for note
const COUNTER =
  'Eb5:6 F5:2 Eb5:4 C5:4 | Bb4:8 G4:4 Bb4:4 | C5:6 Bb4:2 C5:4 Ab4:4 | F5:8 Eb5:4 Db5:4 | ' +
  'Db5:6 Eb5:2 Db5:4 Bb4:4 | Bb4:8 Bb4:4 G4:4 | F5:8 E5:8 | Eb5:8 C5:8';
// the builds: the hook's first half, an arpeggio rising over ii, the dominant's Eb6 held into the drop (the last beat silent)
const BUILD_MEL = `${HOOK_A} | ${HOOK_B1.split('|')[0].trim()} | F5:4 Ab5:4 Bb5:4 Db6:4 | Eb6:16 | Eb6:12 . . . .`;
// the break's melody over PBR: long, high, floating
const BREAK_MEL = 'C6:8 Ab5:4 F5:4 | G5:12 F5:2 Eb5:2 | Eb5:8 F5:4 Ab5:4 | C6:16 | Ab5:8 C6:4 Ab5:4 | G5:8 Bb5:4 G5:4 | F5:8 Db5:4 F5:4 | Ab5:8 G5:8';
// a bell answering in the hook's long notes (drop 2)
const BELL_ANS =
  '. . . . . . . . . . . . . . . . | . . . . . . . . . . Bb5:2 Eb6:2 G6:2 | . . . . . . . . . . . . . . . . | . . . . . . . . . . Ab5:2 Db6:2 F6:2 | ' +
  '. . . . . . . . . . . . . . . . | . . . . . . . . . . . . G6:2 Eb6:2 | . . . . . . . . . . . . . . . . | . . . . . . . . . . C6:2 Eb6:2 Ab6:2';

// ── bass riffs (16 steps a bar, over the chords' roots: x root, o octave, f fifth) ─────────────────────────────────────
// the snare owns step 8: the riffs leave 8 and 9 to it; the kick hits on 0 and 10 with them
const RIFF_1 = ['x---..o-..x--x--', 'x--x--o-..x---..'];
const RIFF_2 = ['x-.x-.o-..o-x-f-', 'x--x--o-..x-o-x-'];
const TALK_1 = ['x-------..o-x---', 'x-x-....x-------'];
const SWITCH_BASS = ['X---............', 'X---............'];

// ── drums (16 steps a bar) ─────────────────────────────────────────────────────────────────────────────────────────────
const KICK_DROP = 'X.........x..... | X.....x...x.....';
const KICK_VERSE = 'X.........x..... | X...............';

export default defineTrack({ id: 'victory-lap', title: 'Victory Lap', genre: 'Melodic dubstep', bpm: 150, bars: 112, tail: 4 }, (s) => {
  s.key('Ab', 'major');
  const S = s.sections({ intro: 8, verse: 8, build: 8, drop: 16, break: 16, build2: 8, drop2: 16, switch: 8, finale: 16, outro: 8 });

  const music = s.bus('music', {}); // chords, pad, keys, arp: one filter for the transitions

  // ── drums ──
  const kick = s.kick('punchy-kick', { gain: -4 });
  const snare = s.snare({ preset: 'trap-snare', tune: 178 }, { gain: -5, reverb: 0.28, key: true }); // the backbeat pumps the music too
  const clap = s.clap('big-clap', { gain: -9, reverb: 0.32, pan: 0.06 });
  const roll = s.snare('tight-snare', { name: 'roll', gain: -12, reverb: 0.2 });
  const hat = s.hat('tight-hat', { gain: -10, pan: -0.15 });
  const ohat = s.hat('closed-hat', { name: 'ohat', gain: -13, pan: 0.2 });
  const ride = s.cymbal('ride', { gain: -17, pan: 0.25 });
  const shaker = s.perc('shaker', { gain: -15, pan: 0.3 });
  const crash = s.cymbal('crash', { gain: -11, reverb: 0.15 });
  const swell = s.cymbal('reverse-crash', { name: 'swell', gain: -13 });
  // ── bass ──
  const sub = s.sub('sub-sine', { gain: -8, duck: 0.9 });
  const growl = s.growl(GROWL_A, { name: 'growl', gain: -3, duck: 0.7, hp: 60, eqMid: -3, eqMidFreq: 1200 });
  const talk = s.growl(TALK, { name: 'talk', gain: -4, duck: 0.7, hp: 60, eqMid: -2, eqMidFreq: 1200 });
  // ── harmony and melody ──
  // the chords breathe on every beat (the pump) and still give way to the kick and the snare (a lighter duck)
  const chords = s.synth(CHORDS, { name: 'chords', gain: -6.5, duck: 0.4, reverb: 0.25, hp: 150, width: 1.25, bus: 'music', fx: [fx.pump({ pattern: 'x...x...x...x...', depth: 0, release: 0.28, curve: 1.6 })] });
  const pad = s.synth('string-pad', { name: 'pad', gain: -12, duck: 0.6, reverb: 0.4, hp: 130, fx: [fx.chorus()], bus: 'music' });
  const keys = s.synth(KEYS, { name: 'keys', gain: -6, reverb: 0.35, delay: 0.1, bus: 'music' });
  const pluck = s.synth({ preset: 'pluck', click: 0.3, clickTone: 4500, clickDecay: 0.004 }, { name: 'pluck', gain: -10, reverb: 0.2, delay: 0.3, duck: 0.4 });
  const lead = s.synth(SKY, { name: 'lead', gain: -4.5, reverb: 0.3, delay: 0.22, duck: 0.25 });
  const harm = s.synth(SKY, { name: 'harm', gain: -11, reverb: 0.3, delay: 0.2, duck: 0.25, pan: -0.2 });
  const voice = s.synth(VOICE, { name: 'voice', gain: -7, reverb: 0.32, delay: 0.25, duck: 0.3, pan: 0.12 });
  const bell = s.synth('fm-bell', { name: 'bell', gain: -12, reverb: 0.4, delay: 0.3 });
  const arp = s.synth('arp-bright', { name: 'arp', gain: -14, delay: 0.2, duck: 0.5, bus: 'music' });
  // ── transitions ──
  const riser = s.riser('riser', { gain: -16 });
  const wash = s.riser('noise-wash', { name: 'wash', gain: -18 });
  const down = s.riser('downlifter', { name: 'down', gain: -14, reverb: 0.3 });
  const boom = s.impact('impact', { name: 'boom', gain: -6, reverb: 0.3 });

  // ── patterns ──
  const held = 'x---------------';
  const hook = s.notes(HOOK);
  const keysHook = s.notes(HOOK.replace(/~/g, '')); // the piano and the bell are polyphonic: no slide
  const hookEnd = s.notes(HOOK_END);
  const hookFinal = s.notes(HOOK_FINAL);
  const counter = s.notes(COUNTER);
  const chordsP1 = s.notes(onBars(P1, held, chordOf));
  const chordsPB = s.notes(onBars(PB, held, chordOf));
  const chordsBR = s.notes(onBars(PBR, held, chordOf));
  const stabsP1 = s.notes(onBars(P1, 'x-.x-.x-x-.x-.x-', chordOf));
  const subP1 = s.notes(onBars(P1, 'x-----....x-----', rootOf));
  const subHeldP1 = s.notes(onBars(P1, held, rootOf));
  const subBR = s.notes(onBars(PBR, held, rootOf));
  const lhOf = (c: string): string => `[${LH[c].join(',')}]`;
  const lhP1 = s.notes(onBars(P1, 'x-------x-------', lhOf));
  const lhBR = s.notes(onBars(PBR, 'x-------x-------', lhOf));
  const riff1 = s.notes(onBars(P1, RIFF_1, riffNote));
  const riff2 = s.notes(onBars(P1, RIFF_2, riffNote));
  const talk1 = s.notes(onBars(P1, TALK_1, riffNote));
  const switchBass = s.notes(onBars(P1, SWITCH_BASS, riffNote));
  // the chords on the hook's own rhythm (the switch): every note of the hook strikes the chord under it
  const hookRhythm = HOOK.split('|').map((bar) => {
    let r = '';
    for (const tok of bar.trim().split(/\s+/)) {
      if (tok === '.') r += '.';
      else {
        const n = Number(tok.split(':')[1] ?? 1);
        r += 'x' + '-'.repeat(n - 1);
      }
    }
    return r;
  });
  const chordsOnHook = s.notes(onBars(P1, hookRhythm, chordOf));
  const arpP1 = s.arp(s.notes(onBars(P1, held, chordOf)).transpose(12), { order: 'up', octaves: 1, res: 4, mask: 'x.xxx.xxx.xxx.xx' });
  const keysArpBR = s.arp(chordsBR, { order: 'updown', octaves: 1, res: 2 }); // one octave: the Dbmaj7's root an octave up would sit a semitone above its C5

  const four = s.hits('X...x...X...x...');
  const eights = s.hits('x.x.x.x.x.x.x.x.');
  const back = s.hits('........X.......');
  const twoFour = s.hits('....X.......X...');
  const hats8 = s.hits('x.x.x.x.x.x.x.x.');
  const hatsOff = s.hits('..x...x...x...x.');
  const hats16 = s.hits('x.xgx.xgx.xgx.xg | x.xgx.xgxgxgxxxx');
  const openOff = s.hits('..o...o...o...o.');
  const shake16 = s.hits('x.xxx.xxx.xxx.xx');
  const fillEnd = s.hits('............x.xX');
  const roll8 = s.hits('3.3.3.3.4.4.4.4. | 5.5.5.5.6.6.6.6.');
  const roll16 = s.hits('6666777777888888');
  const roll32 = s.hits('999999999999999999999999........', { res: 8 }); // the last beat is the breath before the drop

  // ── a build: chords re-struck faster, the hook teased, a roll, a riser, the chords bent up an octave into the silence ──
  const build = (at: number): void => {
    chords.play(s.notes(onBars(PB, 'x---x---x---x---', chordOf)), at, 4, { vel: 0.7 });
    chords.play(s.notes(onBars(PB.slice(4), 'x-x-x-x-x-x-x-x-', chordOf)), at + 4, 2, { vel: 0.72 });
    chords.play(s.notes(onBars(PB.slice(6), ['xxxxxxxxxxxxxxxx', 'xxxxxxxxxxxx....'], chordOf)), at + 6, 2, { vel: 0.74 });
    chords.auto('mix.hp', [[at, 160], [at + 7.75, 1000, 'exp'], [at + 8, 150, 'step']]);
    chords.auto('bend', [[at + 7, 0], [at + 7.75, 12, 'in'], [at + 8, 0, 'step']]);
    pad.play(chordsPB, at, 7.75, { vel: 0.7 });
    voice.play(s.notes(BUILD_MEL), at, 7.75, { vel: 0.85 });
    voice.auto('cutoff', [[at, 1400], [at + 7.75, 6000, 'exp']]);
    voice.auto('mix.delay', [[at + 6, 0.25], [at + 6, 0.5, 'step'], [at + 8, 0.25, 'step']]);
    kick.play(four, at, 6, { vel: 0.7 });
    kick.play(eights, at + 6, 1, { vel: 0.72 });
    kick.auto('mix.hp', [[at, 20], [at, 200, 'step'], [at + 8, 20, 'step']]);
    clap.play(twoFour, at, 6, { vel: 0.6 });
    hat.play(hats8, at, 6, { vel: 0.55 });
    roll.play(roll8, at + 4, 2, { vel: 0.65 });
    roll.play(roll16, at + 6, 1, { vel: 0.65 });
    roll.play(roll32, at + 7, 1, { vel: 0.65 });
    roll.auto('tune', [[at + 4, 200], [at + 7.75, 410, 'exp'], [at + 8, 200, 'step']]);
    riser.hit(at, '', 1, 0, 31);
    wash.hit(at + 4, '', 1, 0, 15);
    swell.note(at + 7, 'A3', 4, 1);
    music.auto('mix.lp', [[at, 2400], [at + 7.75, 20000, 'exp']]);
  };

  // ── a drop: half-time drums, sub and growl on the roots, chords, the hook; two eights ──
  type Ch = typeof growl;
  const drop = (at: number, d: { first: [Ch, string]; second: [Ch, string]; melody?: [string, string] }): void => {
    boom.hit(at, '', 1);
    crash.hit(at, '', 1);
    crash.hit(at + 8, '', 0.8);
    kick.play(s.hits(KICK_DROP), at, 16);
    snare.play(back, at, 16);
    clap.play(back, at, 16);
    hat.play(hats8, at, 8, { vel: 0.75 });
    hat.play(hats16, at + 8, 8, { vel: 0.8 });
    ohat.play(openOff, at + 8, 8, { vel: 0.5 });
    roll.play(fillEnd, at + 7, 1, { vel: 0.75 });
    roll.play(fillEnd, at + 15, 1, { vel: 0.8 });
    sub.play(subP1, at, 16);
    d.first[0].play(s.notes(d.first[1]), at, 8);
    d.second[0].play(s.notes(d.second[1]), at + 8, 8);
    // the speed-ups at the ends of the phrases
    growl.auto('lfoRate', [[at, 2], [at + 7, 4, 'step'], [at + 7.5, 8, 'step'], [at + 8, 2, 'step'], [at + 15, 4, 'step'], [at + 15.5, 8, 'step'], [at + 16, 2, 'step']]);
    chords.play(chordsP1, at, 8);
    chords.play(stabsP1, at + 8, 8);
    lead.play(s.notes(d.melody?.[0] ?? HOOK), at, 8);
    lead.play(s.notes(d.melody?.[1] ?? HOOK_END), at + 8, 8);
    arp.play(arpP1, at + 8, 8, { vel: 0.7 });
  };

  // ── intro: the hook on the piano, an octave down, over strings that open ──
  pad.play(chordsP1, S.intro, undefined, { vel: 0.8 });
  pad.auto('cutoff', [[0, 600], [8, 3200, 'exp']]);
  keys.play(keysHook, S.intro, undefined, { transpose: -12, vel: 0.72 });
  keys.play(lhP1, S.intro, undefined, { vel: 0.5 });
  chords.play(s.notes(onBars(P1.slice(4), 'x---x---x---x---', chordOf)), 4, 4, { vel: 0.42, from: 0 }); // a soft pulse joins under the second half
  shaker.play(shake16, 4, 4, { vel: 0.45 });
  hat.play(hatsOff, 6, 2, { vel: 0.4 });
  swell.note(S.verse.bar - 1, 'A3', 4, 0.8);

  // ── verse: a light beat, the sub, the counter-line on the pluck, the chords low in the mix ──
  kick.play(s.hits(KICK_VERSE), S.verse, undefined, { vel: 0.6 });
  clap.play(back, S.verse, undefined, { vel: 0.55 });
  hat.play(hatsOff, S.verse, undefined, { vel: 0.5 });
  shaker.play(shake16, S.verse, undefined, { vel: 0.45 });
  sub.play(subHeldP1, S.verse);
  pad.play(chordsP1, S.verse, undefined, { vel: 0.75 });
  chords.play(s.notes(onBars(P1, 'x-------x-------', chordOf)), S.verse, undefined, { vel: 0.5 });
  pluck.play(counter, S.verse, undefined, { vel: 0.8 });
  keys.play(lhP1, S.verse, undefined, { vel: 0.4 });
  roll.play(s.hits('............x.xx'), S.verse.end - 1, 1, { vel: 0.45 });
  // the sub sits lower outside the drops
  sub.auto('mix.gain', [[0, -13], [S.drop.bar, -8, 'step'], [S.break.bar, -13, 'step'], [S.drop2.bar, -8, 'step'], [S.switch.bar, -11, 'step'], [S.finale.bar, -8, 'step'], [S.outro.bar, -12, 'step']]);

  build(S.build.bar);
  drop(S.drop.bar, { first: [growl, onBars(P1, RIFF_1, riffNote)], second: [growl, onBars(P1, RIFF_2, riffNote)] });
  for (const end of [S.drop.end, S.drop2.end]) lead.auto('bend', [[end - 0.5, 0], [end, -12, 'in'], [end, 0, 'step']]);

  // ── break: the new progression on the piano and the strings, the bell singing high; then the duet over P1 ──
  down.hit(S.break.bar, '', 1, 0, 8);
  const br = S.break.bar;
  pad.play(chordsBR, br, 8, { vel: 0.8 });
  keys.play(keysArpBR, br, 8, { vel: 0.5 });
  keys.play(lhBR, br, 8, { vel: 0.5 });
  bell.play(s.notes(BREAK_MEL), br, 8, { vel: 0.7 });
  sub.play(subBR, br + 4, 4, { from: 16 });
  // the duet: the hook on the piano at its own pitch, the counter-line on the voice under it; the beat comes back in the second half
  const duet = br + 8;
  pad.play(chordsP1, duet, 8, { vel: 0.8 });
  keys.play(keysHook, duet, 8, { vel: 0.75 });
  keys.play(lhP1, duet, 8, { vel: 0.5 });
  voice.play(counter, duet, 8, { vel: 0.75 });
  sub.play(subHeldP1, duet, 8);
  kick.play(s.hits(KICK_VERSE), duet + 4, 4, { vel: 0.6 });
  clap.play(back, duet + 4, 4, { vel: 0.5 });
  hat.play(hats8, duet + 4, 4, { vel: 0.5 });
  shaker.play(shake16, duet, 8, { vel: 0.4 });
  swell.note(S.build2.bar - 1, 'A3', 4, 0.8);

  build(S.build2.bar);

  // ── drop 2: the talking growl first, the hook harmonised, the bell answering ──
  drop(S.drop2.bar, { first: [talk, onBars(P1, TALK_1, riffNote)], second: [growl, onBars(P1, RIFF_2, riffNote)] });
  talk.auto('lfoRate', [[S.drop2.bar, 0.5], [S.drop2.bar + 3, 1, 'step'], [S.drop2.bar + 4, 0.5, 'step'], [S.drop2.bar + 7, 1, 'step'], [S.drop2.bar + 7.5, 2, 'step'], [S.drop2.bar + 8, 0.5, 'step']]);
  harm.play(s.notes(HARM), S.drop2.bar, 8);
  harm.play(s.notes(HARM_END), S.drop2.bar + 8, 8);
  bell.play(s.notes(BELL_ANS), S.drop2.bar, 16, { vel: 0.75 });

  // ── switch: a lighter future-bass bar of eight between the drops: the growls rest (a dive on each downbeat), the chords bounce
  // on the hook's own rhythm with a pitch wobble, the counter-line sings an octave up, trap hats roll ──
  const sw = S.switch.bar;
  crash.hit(sw, '', 0.8);
  kick.play(s.hits('X.....x...x.....'), sw, 7, { vel: 0.85 });
  snare.play(back, sw, 7, { vel: 0.9 });
  clap.play(back, sw, 7, { vel: 0.8 });
  hat.play(s.hits('x...x...x...x...x...x...x...x... | x...x...x...x...x...x...xxxxxxxx', { res: 8 }), sw, 7, { vel: 0.7 });
  chords.play(chordsOnHook, sw, 8, { vel: 0.85 });
  chords.auto('lfo1Depth', [[sw, 0], [sw, 1, 'step'], [S.switch.end, 0, 'step']]);
  voice.play(counter, sw, 8, { transpose: 12, vel: 0.85 });
  sub.play(subHeldP1, sw, 8);
  growl.play(switchBass, sw, 8, { vel: 0.85 });
  pluck.play(arpP1, sw, 8, { vel: 0.6 });
  // the way into the finale: a roll over the last bar, the breath
  roll.play(roll16, S.switch.end - 1, 1, { vel: 0.7 });
  roll.play(roll32, S.switch.end - 1, 1, { vel: 0.7 });
  swell.note(S.switch.end - 1, 'A3', 4, 1);
  riser.hit(S.switch.end - 2, '', 0.9, 0, 8);

  // ── finale: both themes together over everything ──
  drop(S.finale.bar, { first: [growl, onBars(P1, RIFF_1, riffNote)], second: [growl, onBars(P1, RIFF_2, riffNote)], melody: [HOOK, HOOK_FINAL] });
  voice.play(counter, S.finale.bar, 16, { vel: 0.85 });
  bell.play(hookFinal, S.finale.bar + 8, 6, { transpose: 12, vel: 0.55 }); // an octave above the lead, until its last climb
  ride.play(s.hits('x.x.x.x.x.x.x.x.'), S.finale.bar + 8, 8, { vel: 0.6 });
  lead.auto('bend', [[S.finale.end - 0.5, 0], [S.finale.end, -12, 'in'], [S.finale.end, 0, 'step']]);

  // ── outro: the counter-line on the piano over the strings, the beat thinning; the last chord rolled and left to ring ──
  down.hit(S.outro.bar, '', 0.8, 0, 8);
  pad.play(chordsP1, S.outro.bar, 6, { vel: 0.8 });
  keys.play(counter, S.outro.bar, 6, { vel: 0.75 });
  keys.play(lhP1, S.outro.bar, 6, { vel: 0.5 });
  kick.play(s.hits(KICK_VERSE), S.outro.bar, 4, { vel: 0.6 });
  clap.play(back, S.outro.bar, 4, { vel: 0.5 });
  hat.play(hatsOff, S.outro.bar, 4, { vel: 0.45 });
  sub.play(subHeldP1, S.outro.bar, 6);
  const fin = S.outro.end - 2;
  pad.play(s.notes(`[${V.Dbm.join(',')}]:16 [${V.Ab.join(',')}]:16`), fin, 2, { vel: 0.75 });
  keys.play(s.notes('[Db2,Ab2,Db3,E3,Ab3]:16 [Ab1,Eb2,Ab2,C3,Eb3,Ab3]:16').strum(0.08), fin, 2, { vel: 0.65 });
  sub.play(s.notes('Db2:16 Ab1:16'), fin, 2, { vel: 0.6 });
  bell.note(fin + 1, 'C6', 8, 0.4);

  // ── the pump: a soft pulse in the intro and the verse, off in the builds (the chords are struck faster there), deep in the drops, deepest in the switch
  chords.auto('fx.pump.depth', [[0, 0.3], [S.build.bar, 0, 'step'], [S.drop.bar, 0.75, 'step'], [S.break.bar, 0, 'step'], [S.drop2.bar, 0.75, 'step'],
    [S.switch.bar, 0.9, 'step'], [S.finale.bar, 0.75, 'step'], [S.outro.bar, 0, 'step']]);
  chords.auto('mix.duck', [[S.switch.bar, 0.4], [S.switch.bar, 0.15, 'step'], [S.finale.bar, 0.4, 'step']]); // in the switch the pump alone
  // the switch's downbeat hits dive in from an octave above
  growl.auto('pEnv', [[S.switch.bar, 3], [S.switch.bar, 12, 'step'], [S.finale.bar, 3, 'step']]);
  growl.auto('pEnvTime', [[S.switch.bar, 0.05], [S.switch.bar, 0.22, 'step'], [S.finale.bar, 0.05, 'step']]);

  // ── the music bus: half closed at the start, open by the verse ──
  music.auto('mix.lp', [[0, 3500], [S.intro.end, 12000, 'exp'], [S.verse.end, 20000, 'exp']]);

  s.setReverb({ time: 3.0, preDelay: 0.03, return: -9, lowCut: 220, highCut: 8500 });
  s.setDelay({ time: '1/8.', feedback: 0.35, return: -11 });
  s.setSidechain({ release: 0.24, curve: 1.4 });
  s.setMaster({ trim: 4.9 }); // found with the probe's AUTOTRIM=1
});
