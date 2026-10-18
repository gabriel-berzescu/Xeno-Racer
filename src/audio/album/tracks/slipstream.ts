// Slipstream: melodic dubstep for the album "Xeno-Racer Vol. 1".
// 150 BPM in half time, D major / B minor; the last build lifts a whole step to E major for the final drop and the outro.
// The hook is an 8-bar topline over Gmaj7 A F#m7 Bm7 | Em7 A7 Dadd9 D (IV V iii vi | ii V I): three rising calls answered by falling
// thirds, a climb to E6 held over A7, the leading tone landing on D6. The piano states it in the intro, each build teases its first
// half only, the drops sing it in full on the supersaw lead; drop 2 harmonises it, drop 3 is a step higher with the harmony and an
// octave-up bell. The growl follows the roots under it; a screech answers the lead's held notes in the second half of drops 2 and 3.
// Probe:  ALBUM=1 TRACK=sandbox/album/wip/slipstream.ts AUTOTRIM=1 SPEC=1 CLASH=1 npx vitest run tests/probes/album-render.test.ts
import { defineTrack, fx } from '../song';
import type { GrowlOpts, SynthOpts } from '../song';

// ── patches (README section 11: plain option objects) ────────────────────────────────────────────────────────────────

/** A soft piano: one FM pair whose brightness falls right after the hammer, a detuned triangle pair for the body, a faint octave. */
export const PIANO: SynthOpts = {
  layers: [
    { wave: 'fm', level: 1 },
    { wave: 'tri', unison: 2, detune: 1, level: 0.35 },
    { wave: 'sine', octave: 1, level: 0.1 },
  ],
  fmRatio: 1, fmIndex: 3.6, fmDecay: 0.32, fmSustain: 0.06, fmFeedback: 0.06,
  filter: 'lp', cutoff: 2800, res: 0.05, envAmt: 1.6, fAttack: 0.001, fDecay: 0.25, fSustain: 0.25, fRelease: 0.4, keytrack: 0.7, velFilter: 0.8,
  attack: 0.0015, decay: 3.2, sustain: 0, release: 0.7, velAmp: 0.8,
  unisonDetune: 6, spread: 0.5, voices: 14,
};

/** The verse voice: a round triangle lead with a little saw shimmer, legato, glide and a late vibrato. */
export const GLASS: SynthOpts = {
  mode: 'legato', voices: 1,
  layers: [
    { wave: 'tri', level: 1, phase: 'free' },
    { wave: 'saw', unison: 3, detune: 0.6, level: 0.22, phase: 'free' },
    { wave: 'sine', octave: 1, level: 0.12, phase: 'free' },
  ],
  filter: 'lp', cutoff: 2400, res: 0.1, envAmt: 0.6, fAttack: 0.02, fDecay: 0.5, fSustain: 0.6, keytrack: 0.5,
  attack: 0.025, decay: 0.5, sustain: 0.85, release: 0.4,
  glide: 0.07, vibDepth: 22, vibRate: 5.2, vibDelay: 0.35,
  unisonDetune: 9, spread: 0.6,
};

/** The builds' voice: a warm saw lead whose filter each build opens; legato and song-like (glide, late vibrato). */
export const VOX: SynthOpts = {
  mode: 'legato', voices: 1,
  layers: [
    { wave: 'saw', unison: 5, detune: 0.7, phase: 'free' },
    { wave: 'square', octave: -1, level: 0.3, phase: 'free' },
  ],
  filter: 'lp', cutoff: 2000, res: 0.15, envAmt: 1.0, fAttack: 0.01, fDecay: 0.35, fSustain: 0.5, keytrack: 0.6,
  attack: 0.015, decay: 0.4, sustain: 0.85, release: 0.35,
  glide: 0.06, vibDepth: 24, vibRate: 5.4, vibDelay: 0.3,
  unisonDetune: 12, spread: 0.6,
};

/** The main drop bass: the classic growl with more vowel travel and a brighter top, without a sub of its own (the sub is a channel). */
export const GROWL_MAIN: GrowlOpts = {
  preset: 'dubstep-growl', sub: 0,
  cutoff: 420, res: 0.4, lfoRate: 1, lfoPhase: 0.75, lfoDepth: 2.8, lfoFm: 2, lfoVowel: 1.1, vowel: 0.4, formant: 0.55,
  fmMix: 0.45, fmIndex: 2.8, drive: 16, fold: 0.25, clip: 7, tone: 9000, release: 0.05,
};

/** The talking growl of drop 2: wide vowel sweeps (yoi) on a quarter-note wobble, a brighter FM voice. */
export const GROWL_TALK: GrowlOpts = {
  preset: 'yoi', sub: 0, lfoPhase: 0.75, lfoRate: 1, lfoVowel: 2.2, formant: 0.8, fmMix: 0.5, fmIndex: 3.5, lfoFm: 2.5, drive: 17, fold: 0.22,
  tone: 9000, release: 0.05,
};

/** The screech that answers the lead (C3-C4): each short note opens from closed (an eighth-note wobble starting at the bottom). */
export const SCREECH: GrowlOpts = { preset: 'screech', sub: 0, lfoRate: 2, lfoPhase: 0.75, release: 0.06, tone: 8000 };

// ── harmony ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Hand-voiced chords: four notes in F#3-A4, smooth voice leading (the top line F#-A-F#-F#-E-E-E-F#), no seconds against the hook. */
const V: Record<string, string[]> = {
  Gmaj7: ['G3', 'B3', 'D4', 'F#4'],
  A: ['A3', 'C#4', 'E4', 'A4'],
  'F#m7': ['A3', 'C#4', 'E4', 'F#4'],
  Bm7: ['A3', 'B3', 'D4', 'F#4'],
  Em7: ['G3', 'B3', 'D4', 'E4'],
  A7: ['G3', 'A3', 'C#4', 'E4'],
  Dadd9: ['F#3', 'A3', 'D4', 'E4'],
  D: ['F#3', 'A3', 'D4', 'F#4'],
};
/** The sub's root of each chord (E1 .. D2). */
const SUBR: Record<string, string> = { Gmaj7: 'G1', A: 'A1', 'F#m7': 'F#1', Bm7: 'B1', Em7: 'E1', A7: 'A1', Dadd9: 'D2', D: 'D2' };
/** The piano's left hand: root and fifth. */
const LH: Record<string, string[]> = {
  Gmaj7: ['G2', 'D3'], A: ['A2', 'E3'], 'F#m7': ['F#2', 'C#3'], Bm7: ['B2', 'F#3'], Em7: ['E2', 'B2'], A7: ['A2', 'E3'], Dadd9: ['D2', 'A2'], D: ['D2', 'A2'],
};
const P1 = ['Gmaj7', 'A', 'F#m7', 'Bm7', 'Em7', 'A7', 'Dadd9', 'D']; // the hook's progression: IV V iii vi | ii V I
const PB = ['Gmaj7', 'A', 'F#m7', 'Bm7', 'Gmaj7', 'A', 'Bm7', 'A']; // the builds: they end on the dominant
const PV = ['Bm7', 'Gmaj7', 'D', 'A', 'Bm7', 'Gmaj7', 'Em7', 'A']; // the verse: vi IV I V
const PS = ['Gmaj7', 'Gmaj7', 'A', 'A', 'F#m7', 'F#m7', 'Bm7', 'Bm7']; // the slow hook: the first half of P1 at half speed
const PR = ['Em7', 'F#m7', 'Gmaj7', 'A', 'Em7', 'F#m7', 'Gmaj7', 'A']; // the bridge: ii iii IV V, twice, a rising bass

/** One bar on a 16-step rhythm: 'x' strikes (X accented), '-' holds, '.' rests. `what` is a note or a chord. */
function strike(what: string | readonly string[], rhythm: string): string {
  const r = rhythm.replace(/\s/g, '');
  const head = typeof what === 'string' ? what : `[${what.join(',')}]`;
  const out: string[] = [];
  for (let i = 0; i < r.length; ) {
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
/** A progression (chord names) mapped through a table and struck on a rhythm (one rhythm, or one per bar, cycling). */
function onBars(names: readonly string[], table: Record<string, string | readonly string[]>, rhythm: string | readonly string[]): string {
  return names.map((c, i) => strike(table[c], typeof rhythm === 'string' ? rhythm : rhythm[i % rhythm.length])).join(' | ');
}

// ── melodies ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// the hook, in the drop register (A4-E6). Bars 1, 3 and 5 share one rhythm (3-3-2-4-2-2), each call starting higher (B4, C#5, E5);
// bars 2 and 4 answer downwards; bar 6 climbs once more to the peak, E6 held over A7, and the leading tone C#6 lands on D6
const HOOK_A = 'B4:3 D5:3 E5:2 F#5:4 E5:2 D5:2 | E5:6 C#5:2 A4:8 | C#5:3 E5:3 F#5:2 A5:4 F#5:2 E5:2 | F#5:6 D5:2 B4:8';
const HOOK_B = 'E5:3 G5:3 A5:2 B5:4 A5:2 G5:2 | A5:3 B5:3 C#6:2 E6!~:6 C#6:2 | D6:12 C#6:2 B5:2';
const HOOK = `${HOOK_A} | ${HOOK_B} | A5:10 . . . . . .`;
const HOOK_END = `${HOOK_A} | ${HOOK_B} | A5:4 B5:2 C#6:2 D6:8`; // the second time it climbs back to the tonic
// the harmony below the hook: thirds where they are chord tones, fourths and sixths where a third would rub (no G above the F# of
// Gmaj7, no C# under the D of the chords' upper octave)
const HARM_A = 'F#4:3 B4:5 D5:4 B4:4 | C#5:6 A4:2 E4:8 | A4:3 C#5:5 E5:4 C#5:4 | D5:6 B4:2 F#4:8';
const HARM_B = 'B4:3 E5:5 G5:4 E5:4 | E5:3 G5:3 A5:2 C#6:6 A5:2 | F#5:12 E5:2 D5:2';
const HARM = `${HARM_A} | ${HARM_B} | F#5:10 . . . . . .`;
const HARM_END = `${HARM_A} | ${HARM_B} | F#5:6 A5:10`;
// the builds: the first half of the hook, its first call again, then a rising pre-drop line that hangs on B5 (the 9th of A, the 3rd of the
// Gmaj7 the drop lands on); the last beat is silent
const BUILD_MEL = `${HOOK_A} | B4:3 D5:3 E5:2 F#5:4 E5:2 D5:2 | E5:6 C#5:2 A4:8 | D5:3 E5:3 F#5:2 A5:8 | B5:12 . . . .`;
// the verse (over Bm7 Gmaj7 D A | Bm7 Gmaj7 Em7 A): eighth-note pickups into held notes, speech-like
const VERSE_MEL =
  '. . F#4:2 B4:2 C#5:2 D5:6 C#5:2 | B4:8 . . A4:2 B4:2 D5:2 | E5:4 D5:2 A4:6 . . . . | . . E4:2 A4:2 B4:2 C#5:8 | ' +
  '. . F#4:2 B4:2 C#5:2 D5:4 E5:2 F#5:2 | F#5:6 E5:2 D5:4 B4:4 | . . G4:2 B4:2 D5:2 E5:4 D5:2 B4:2 | C#5:12 . . . .';
// the breakdown's second half: the hook's first half at half speed (each chord two bars), wide and slow
const HOOK_SLOW =
  'B4:6 D5:6 E5:4 | F#5:8 E5:4 D5:4 | E5:12 C#5:4 | A4:16 | C#5:6 E5:6 F#5:4 | A5:8 F#5:4 E5:4 | F#5:12 D5:4 | B4:16';
const BELL_SLOW =
  '. . . . . . . . . . . . . . . . | . . . . . . . . . . . . . . . . | . . . . . . . . . . . . . . . . | . . . . . . . . . . E6:2 C#6:2 A5:2 | ' +
  '. . . . . . . . . . . . . . . . | . . . . . . . . . . . . . . . . | . . . . . . . . . . . . . . . . | . . . . . . . . . . F#6:2 D6:2 B5:2';
// the bridge: new material over a bass that climbs E F# G A twice, a figure rising a step each bar; the second time it reaches A5, and it
// settles on C#5 over A, the chord that is V of D and IV of E: the pivot into the E-major build, whose first note is that C#5
const BRIDGE_MEL =
  '. . E4:2 G4:2 B4:2 D5:8 | . . F#4:2 A4:2 C#5:2 E5:8 | . . B4:2 D5:2 E5:2 F#5:8 | E5:6 C#5:2 A4:8 | ' +
  '. . E4:2 G4:2 B4:2 D5:4 E5:4 | . . F#4:2 A4:2 C#5:2 E5:4 F#5:4 | . . B4:2 D5:2 F#5:2 A5:8 | A4:4 B4:4 C#5:8';
// a bell answering in the hook's gaps (drop 2, the breakdown)
const BELL_MEL =
  '. . . . . . . . . . . . . . . . | . . . . . . . . . . E6:2 C#6:2 A5:2 | . . . . . . . . . . . . . . . . | . . . . . . . . . . F#6:2 D6:2 B5:2 | ' +
  '. . . . . . . . . . . . . . . . | . . . . . . . . . . . . . . . . | . . . . A6:4 F#6:4 E6:4 | . . . . . . . . . . . . A5 B5 D6 E6';

// ── the bass lines (F#1-D3: roots, octaves, a walk-up) ─────────────────────────────────────────────────────────────────

// drop 1, first eight: a held root with the kick, a gap for the snare, then root and octave with the second kick
const GROWL_1 =
  'G1:6 . . . . G1:3 G2:2 . | A1:3 A1:3 . . . . A1:2 A2:2 A1:2 | F#1:6 . . . . F#1:3 F#2:2 . | B1:3 B1:3 . . . . B1:2 B2:2 B1:2 | ' +
  'E1:6 . . . . E1:3 E2:2 . | A1:3 A1:3 . . . . A1:2 A2:2 A1:2 | D2:6 . . . . D2:3 D3:2 . | D2:3 D2:3 . . . . D2:2 F#2:2 A2:2';
// the second eight: busier answers (octave and fifth) after the snare
const GROWL_2 =
  'G1:6 . . . . G1:2 G2:2 G1:2 | A1:3 A1:3 . . . . A2:2 A1:2 E2:2 | F#1:6 . . . . F#1:2 F#2:2 F#1:2 | B1:3 B1:3 . . . . B2:2 B1:2 F#2:2 | ' +
  'E1:6 . . . . E1:2 E2:2 E1:2 | A1:3 A1:3 . . . . A2:2 A1:2 C#2:2 | D2:6 . . . . D2:2 D3:2 D2:2 | D2:8 D2:4 D2:2 D2:2';
// the second eights of drops 2 and 3: the growl leaves the second half of the even bars to the screech
const GROWL_3 =
  'G1:6 . . . . G1:2 G2:2 G1:2 | A1:3 A1:3 . . . . . . . . . . | F#1:6 . . . . F#1:2 F#2:2 F#1:2 | B1:3 B1:3 . . . . . . . . . . | ' +
  'E1:6 . . . . E1:2 E2:2 E1:2 | A1:3 A1:3 . . . . . . . . . . | D2:6 . . . . D2:2 D3:2 D2:2 | D2:3 D2:3 . . . . . . . . . .';
// the screech's answers: a chord arpeggio climbing while the lead holds its note (and the bell, in drop 2, falls)
const SCREECH_ANS =
  '. . . . . . . . . . . . . . . . | . . . . . . . . . . A3:2 C#4:2 E4:2 | . . . . . . . . . . . . . . . . | . . . . . . . . . . B3:2 D4:2 F#4:2 | ' +
  '. . . . . . . . . . . . . . . . | . . . . . . . . . . C#4:2 E4:2 G4:2 | . . . . . . . . . . . . . . . . | . . . . . . . . . . F#3:2 A3:2 D4:2';
// the talking growl (drop 2's first eight): a long vowel sweep, then a three-note stutter and a long answer
const TALK_1 =
  'G1:8 . . G2:4 G1:2 | A1:2 A1:2 A1:2 . . . . A1:6 | F#1:8 . . F#2:4 F#1:2 | B1:2 B1:2 B1:2 . . . . B1:6 | ' +
  'E1:8 . . E2:4 E1:2 | A1:2 A1:2 A1:2 . . . . A1:6 | D2:8 . . D3:4 D2:2 | D2:2 D2:2 D2:2 . . . . D2:6';
// build 2's tease: the growl wakes up under a closed filter
const TEASE = 'G1:12 . . . . | A1:12 . . . . | F#1:12 . . . . | B1:8 . . . . . . . .';

// ── drums (16 steps a bar) ────────────────────────────────────────────────────────────────────────────────────────────
const KICK_DROP = 'X.........x..... | X..x......x.....'; // on 1 and after the snare, never under it; the second bar pushes on the dotted eighth
const KICK_TALK = 'X.........x..... | X.........x.....';

export default defineTrack({ id: 'slipstream', title: 'Slipstream', genre: 'Melodic dubstep', bpm: 150, bars: 122, tail: 4 }, (s) => {
  s.key('D', 'major');
  const S = s.sections({ intro: 8, verse: 8, build: 8, drop: 16, breakdown: 16, build2: 8, drop2: 16, bridge: 8, build3: 8, drop3: 16, outro: 10 });
  const UP = 2; // the lift: build 3, drop 3 and the outro are a whole step up, in E major

  const music = s.bus('music', {}); // chords, pad, piano and arp: one filter for the transitions

  // ── drums ──
  const kick = s.kick('punchy-kick', { gain: -4 });
  const snare = s.snare('trap-snare', { gain: -5, reverb: 0.24, key: true }); // the backbeat ducks the music too: the half-time pump on 1 and 3
  const clap = s.clap('big-clap', { gain: -9, reverb: 0.3, pan: -0.08 });
  const roll = s.snare({ preset: 'trap-snare', tune: 200 }, { name: 'roll', gain: -12, reverb: 0.2 }); // rolls and fills: not keyed
  const hat = s.hat('closed-hat', { gain: -9, pan: 0.18 });
  const shaker = s.perc('shaker', { gain: -15, pan: -0.25 });
  const crash = s.cymbal('crash', { gain: -11, reverb: 0.15 });
  const swell = s.cymbal('reverse-crash', { name: 'swell', gain: -13 });
  // ── bass ──
  const sub = s.sub('sub-sine', { gain: -8, duck: 0.9 });
  const growl = s.growl(GROWL_MAIN, { name: 'growl', gain: -3, duck: 0.7, hp: 60, eqMid: -3, eqMidFreq: 1100 }); // a dip where the lead sings
  const talk = s.growl(GROWL_TALK, { name: 'talk', gain: -4, duck: 0.7, hp: 60, eqMid: -3, eqMidFreq: 1100 });
  const screech = s.growl(SCREECH, { name: 'screech', gain: -9, duck: 0.4, hp: 150 });
  // ── harmony and melody ──
  const chords = s.synth('supersaw-chord', { name: 'chords', gain: -6.5, duck: 0.9, reverb: 0.25, hp: 140, width: 1.25, bus: 'music' });
  const pad = s.synth('supersaw-pad', { name: 'pad', gain: -11, duck: 0.6, reverb: 0.4, hp: 120, fx: [fx.chorus()], bus: 'music' });
  const piano = s.synth(PIANO, { name: 'piano', gain: -6, reverb: 0.35, delay: 0.12, bus: 'music' });
  const glass = s.synth(GLASS, { name: 'glass', gain: -5, reverb: 0.3, delay: 0.25 });
  const vox = s.synth(VOX, { name: 'vox', gain: -5.5, reverb: 0.3, delay: 0.25 });
  const lead = s.synth('supersaw-lead', { name: 'lead', gain: -4, reverb: 0.3, delay: 0.22, duck: 0.25 });
  const harm = s.synth('supersaw-lead', { name: 'harm', gain: -10, reverb: 0.3, delay: 0.2, duck: 0.25 });
  const bell = s.synth('fm-bell', { name: 'bell', gain: -12, reverb: 0.4, delay: 0.3 });
  const arp = s.synth('pluck', { name: 'arp', gain: -13, delay: 0.2, duck: 0.5, bus: 'music' });
  // ── transitions ──
  const riser = s.riser('riser', { gain: -16 });
  const wash = s.riser('noise-wash', { name: 'wash', gain: -18 });
  const down = s.riser('downlifter', { name: 'down', gain: -14, reverb: 0.3 });
  const boom = s.impact('impact', { name: 'boom', gain: -6, reverb: 0.3 });

  // ── patterns ──
  const held = 'x---------------';
  const hook = s.notes(HOOK);
  const hookEnd = s.notes(HOOK_END);
  const keysHook = s.notes(HOOK.replace('~', '')); // the hook for the piano and the bell (polyphonic: no slide)
  const keysHookEnd = s.notes(HOOK_END.replace('~', ''));
  const harmony = s.notes(HARM);
  const harmonyEnd = s.notes(HARM_END);
  const buildMel = s.notes(BUILD_MEL);
  const verseMel = s.notes(VERSE_MEL);
  const bridgeMel = s.notes(BRIDGE_MEL);
  const bellMel = s.notes(BELL_MEL);
  const screechAns = s.notes(SCREECH_ANS);
  const chordsP1 = s.notes(onBars(P1, V, held));
  const chordsPB = s.notes(onBars(PB, V, held));
  const chordsPV = s.notes(onBars(PV, V, held));
  const stabsP1 = s.notes(onBars(P1, V, 'x--x--x-x--x--x-'));
  const pianoLH = s.notes(onBars(P1, LH, held));
  const pianoPV = s.notes(onBars(PV, V, 'x-------x-------'));
  const subP1 = s.notes(onBars(P1, SUBR, 'x-----....x-----'));
  const subHeldP1 = s.notes(onBars(P1, SUBR, held));
  const subPV = s.notes(onBars(PV, SUBR, held));
  // the arps play Bm7 (B D F# A) over the Gmaj7 bars: Gmaj9 without its root, so that no G sits a minor second above the chords' F#
  const arpP1 = s.arp(s.chords('Bm7 | A | F#m7 | Bm7 | Em7 | A7 | Dadd9 | D', { octave: 4, lead: true }), { order: 'up', octaves: 1, res: 4, mask: 'x.xxx.xxx.xxx.xx' });
  const pianoArpPV = s.arp(s.chords('Bm7 | Bm7 | D | A | Bm7 | Bm7 | Em7 | A', { octave: 3, lead: true }), { order: 'updown', octaves: 2, res: 2 });

  const kickVerse = s.hits('X.........x..... | X...............');
  const kickFour = s.hits('X...x...X...x...');
  const kickEights = s.hits('x.x.x.x.x.x.x.x.');
  const back = s.hits('........X.......');
  const twoFour = s.hits('....x.......x...');
  const hats8 = s.hits('x.x.x.x.x.x.x.x.');
  const hatsOff = s.hits('..x...x...x...x.');
  const hats16 = s.hits('x.xgx.xgx.xgx.xg | x.xgx.xgx.xgxxxo');
  const shake16 = s.hits('x.xxx.xxx.xxx.xx');
  const fillEnd = s.hits('............x.xX'); // the last bar of an eight
  const roll8 = s.hits('3.3.3.3.4.4.4.4. | 5.5.5.5.6.6.6.6.');
  const roll16 = s.hits('6666777777888888');
  const roll32 = s.hits('999999999999999999999999........', { res: 8 }); // the last beat is the silence before the drop
  const roll32short = s.hits('9999999999999999................', { res: 8 }); // build 3: two beats of roll, then two of held breath

  // ── a build: the chords re-struck faster and faster, the snare rolling up, the riser, the silence before the drop ──
  // (no sub and a high-passed kick: the low end is saved for the drop, so the build is never as loud as what it leads to)
  // tease (build 2): the first four bars are half time with the growl waking up under a closed filter
  // breath (build 3): the roll, the chords and the pad stop two beats early; the voice holds its high note alone into the drop
  const build = (at: number, o: { up?: number; tease?: boolean; breath?: boolean } = {}): void => {
    const transpose = o.up ?? 0;
    const end = o.breath ? 7.5 : 7.75;
    chords.play(s.notes(onBars(PB, V, 'x-x-x-x-x-x-x-x-')), at, 6, { transpose, vel: 0.7 });
    chords.play(s.notes(onBars(PB.slice(6), V, ['xxxxxxxxxxxxxxxx', o.breath ? 'xxxxxxxx........' : 'xxxxxxxxxxxx....'])), at + 6, 2, { transpose, vel: 0.7 });
    chords.auto('mix.hp', [[at, 160], [at + end, 900, 'exp'], [at + 8, 140, 'step']]);
    pad.play(chordsPB, at, end, { transpose, vel: 0.7 });
    vox.play(buildMel, at, 7.75, { transpose });
    vox.auto('cutoff', [[at, 1200], [at + 7.75, 6500, 'exp']]);
    vox.auto('mix.delay', [[at + 7, 0.25], [at + 7, 0.55, 'step'], [at + 8, 0.25, 'step']]); // a delay throw on the last held note
    if (o.tease) {
      kick.play(kickVerse, at, 4, { vel: 0.7 });
      clap.play(back, at, 4, { vel: 0.6 });
      growl.play(s.notes(TEASE), at, 4, { transpose, vel: 0.6 });
      growl.auto('cutoff', [[at, 130], [at + 4, 420, 'exp']]);
      growl.auto('lfoRate', [[at, 0.5], [at + 3, 1, 'step'], [at + 4, 1, 'step']]);
    } else {
      kick.play(kickFour, at, 4, { vel: 0.7 });
      clap.play(twoFour, at, 4, { vel: 0.6 });
    }
    hat.play(hats8, at, 6, { vel: 0.55 });
    kick.play(kickFour, at + 4, 2, { vel: 0.7 });
    kick.play(kickEights, at + 6, 1, { vel: 0.7 });
    kick.auto('mix.hp', [[at, 20], [at, 220, 'step'], [at + 8, 20, 'step']]);
    roll.play(roll8, at + 4, 2, { vel: 0.65 });
    roll.play(roll16, at + 6, 1, { vel: 0.65 });
    roll.play(o.breath ? roll32short : roll32, at + 7, 1, { vel: 0.65 });
    roll.auto('tune', [[at + 4, 190], [at + end, 420, 'exp'], [at + 8, 200, 'step']]);
    riser.hit(at, '', 1, 0, 31);
    wash.hit(at + 4, '', 1, 0, 15);
    swell.note(at + 7, 'A3', 4, 1);
    music.auto('mix.lp', [[at, 2500], [at + end, 20000, 'exp']]);
  };

  // ── a drop: half-time drums, the sub and a growl on the roots, chords, the hook; two eights ──
  // gap (drop 2): the beat and the bass stop for the first two bars of the second eight (the chords and the hook go on) and slam back
  type Ch = typeof growl;
  const drop = (at: number, d: { up?: number; first: [Ch, string]; second: [Ch, string]; kick1?: string; gap?: number; answers?: boolean }): void => {
    const transpose = d.up ?? 0;
    const gap = d.gap ?? 0;
    const b2 = at + 8 + gap; // where the second eight's beat starts
    const rest = { transpose, from: gap * 4 }; // the second eight's patterns, entered after the gap
    boom.hit(at, '', 1);
    crash.hit(at, '', 1);
    crash.hit(b2, '', gap ? 1 : 0.8);
    if (gap) {
      boom.hit(b2, '', 0.9);
      riser.hit(at + 8, '', 0.9, 0, gap * 4);
      roll.play(roll16, b2 - 1, 1, { vel: 0.6 });
      swell.note(b2 - 1, 'A3', 4, 0.9);
    }
    kick.play(s.hits(d.kick1 ?? KICK_DROP), at, 8);
    kick.play(s.hits(KICK_DROP), b2, 8 - gap);
    for (const ch of [snare, clap]) {
      ch.play(back, at, 8);
      ch.play(back, b2, 8 - gap);
    }
    hat.play(hats8, at, 8, { vel: 0.75 });
    hat.play(hats16, b2, 8 - gap, { vel: 0.8 });
    roll.play(fillEnd, at + 7, 1, { vel: 0.75 });
    roll.play(fillEnd, at + 15, 1, { vel: 0.8 });
    sub.play(subP1, at, 8, { transpose });
    sub.play(subP1, b2, 8 - gap, rest);
    d.first[0].play(s.notes(d.first[1]), at, 8, { transpose });
    d.second[0].play(s.notes(d.second[1]), b2, 8 - gap, rest);
    if (d.answers) screech.play(screechAns, at + 8, 8, { transpose });
    // the classic speed-ups at the ends of the phrases
    growl.auto('lfoRate', [[at, 1], [at + 3.5, 2, 'step'], [at + 4, 1, 'step'], [at + 7, 2, 'step'], [at + 7.5, 4, 'step'], [at + 8, 1, 'step'],
      [at + 11.5, 2, 'step'], [at + 12, 1, 'step'], [at + 15, 2, 'step'], [at + 15.5, 4, 'step'], [at + 16, 1, 'step']]);
    chords.play(chordsP1, at, 8, { transpose });
    chords.play(stabsP1, at + 8, 8, { transpose });
    lead.play(hook, at, 8, { transpose });
    lead.play(hookEnd, at + 8, 8, { transpose });
  };

  // ── intro: the hook on the piano over a pad that opens ──
  pad.play(chordsP1, S.intro, undefined, { vel: 0.8 });
  pad.auto('cutoff', [[0, 500], [8, 1800, 'exp']]);
  piano.play(keysHook, S.intro, undefined, { transpose: -12, vel: 0.75 });
  piano.play(pianoLH, S.intro, undefined, { vel: 0.55 });
  shaker.play(shake16, 4, 4, { vel: 0.5 });
  hat.play(hatsOff, 6, 2, { vel: 0.45 });
  swell.note(S.verse.bar - 1, 'A3', 4, 0.8);

  // ── verse: a light half-time beat, the sub, the verse melody ──
  kick.play(kickVerse, S.verse, undefined, { vel: 0.6 });
  clap.play(back, S.verse, undefined, { vel: 0.55 });
  hat.play(hatsOff, S.verse, undefined, { vel: 0.55 });
  shaker.play(shake16, S.verse, undefined, { vel: 0.5 });
  sub.play(subPV, S.verse);
  pad.play(chordsPV, S.verse, undefined, { vel: 0.75 });
  piano.play(pianoPV, S.verse.bar, 4, { vel: 0.45 });
  piano.play(pianoArpPV, S.verse.bar + 4, 4, { vel: 0.4, from: 16 }); // the arp's second four bars
  glass.play(verseMel, S.verse);
  roll.play(s.hits('............x.xx'), S.verse.end - 1, 1, { vel: 0.45 });
  // the sub sits lower outside the drops
  sub.auto('mix.gain', [[0, -13], [S.drop.bar, -8, 'step'], [S.breakdown.bar, -13, 'step'], [S.drop2.bar, -8, 'step'], [S.bridge.bar, -14, 'step'],
    [S.drop3.bar, -8, 'step'], [S.outro.bar, -12, 'step']]);

  build(S.build.bar);
  drop(S.drop.bar, { first: [growl, GROWL_1], second: [growl, GROWL_2] });
  arp.play(arpP1, S.drop.bar + 8, 8, { vel: 0.7 });
  // the way out of each drop: the lead's last held tonic dives an octave over the final two beats
  for (const end of [S.drop.end, S.drop2.end, S.drop3.end]) lead.auto('bend', [[end - 0.5, 0], [end, -12, 'in'], [end, 0, 'step']]);

  // ── breakdown: the verse again with a bell an octave above it; then the hook at half speed on the piano, the bell answering ──
  down.hit(S.breakdown.bar, '', 1, 0, 8);
  pad.play(chordsPV, S.breakdown.bar, 8, { vel: 0.8 });
  piano.play(pianoArpPV, S.breakdown.bar, 8, { vel: 0.5 });
  glass.play(verseMel, S.breakdown.bar, 8);
  bell.play(verseMel, S.breakdown.bar + 4, 4, { from: 16, transpose: 12, vel: 0.45 }); // a sparkle an octave up on the second half
  hat.play(hatsOff, S.breakdown.bar + 4, 4, { vel: 0.5 });
  shaker.play(shake16, S.breakdown.bar + 4, 4, { vel: 0.45 });
  // (the hook at half speed: the piano an octave down, the voice joining at its own octave for the second four bars)
  const slow = S.breakdown.bar + 8;
  pad.play(s.notes(onBars(PS, V, held)), slow, 8, { vel: 0.8 });
  piano.play(s.notes(HOOK_SLOW), slow, 8, { transpose: -12, vel: 0.8 });
  piano.play(s.notes(onBars(PS, LH, held)), slow, 8, { vel: 0.55 });
  glass.play(s.notes(HOOK_SLOW), slow + 4, 4, { from: 16, vel: 0.85 });
  bell.play(s.notes(BELL_SLOW), slow, 8, { vel: 0.7 });
  sub.play(s.notes(onBars(PS, SUBR, held)), slow, 8);
  kick.play(kickVerse, slow, 8, { vel: 0.65 });
  clap.play(back, slow, 8, { vel: 0.55 });
  hat.play(hats8, slow, 4, { vel: 0.5 });
  hat.play(hats16, slow + 4, 4, { vel: 0.55 });
  shaker.play(shake16, slow + 4, 4, { vel: 0.4 });
  swell.note(S.build2.bar - 1, 'A3', 4, 0.8);

  build(S.build2.bar, { tease: true });
  piano.play(buildMel, S.build2.bar, 7.75, { transpose: -12, vel: 0.6 });
  // drop 2: the talking growl first, the harmony on the hook, the bell answering; then the beat stops for two bars and slams back with
  // the screech answering the lead
  drop(S.drop2.bar, { first: [talk, TALK_1], second: [growl, GROWL_3], kick1: KICK_TALK, gap: 2, answers: true });
  talk.auto('lfoRate', [[S.drop2.bar, 1], [S.drop2.bar + 3.5, 2, 'step'], [S.drop2.bar + 4, 1, 'step'], [S.drop2.bar + 7, 2, 'step'], [S.drop2.bar + 7.5, 4, 'step'], [S.drop2.bar + 8, 1, 'step']]);
  harm.play(harmony, S.drop2.bar, 8);
  harm.play(harmonyEnd, S.drop2.bar + 8, 8);
  bell.play(bellMel, S.drop2.bar, 16, { vel: 0.75 });
  arp.play(arpP1, S.drop2.bar + 8, 8, { vel: 0.75 });

  // ── bridge: new material on the piano over a climbing bass, the voice joining the second time; it ends on the pivot chord A ──
  down.hit(S.bridge.bar, '', 1, 0, 8);
  pad.play(s.notes(onBars(PR, V, held)), S.bridge, undefined, { vel: 0.8 });
  piano.play(bridgeMel, S.bridge, undefined, { vel: 0.8 });
  piano.play(s.notes(onBars(PR, LH, held)), S.bridge, undefined, { vel: 0.55 });
  glass.play(bridgeMel, S.bridge.bar + 4, 4, { from: 16, vel: 0.8 });
  sub.play(s.notes(onBars(PR, SUBR, held)), S.bridge.bar + 4, 4, { from: 16 });
  shaker.play(shake16, S.bridge.bar + 4, 4, { vel: 0.4 });
  hat.play(hatsOff, S.bridge.bar + 6, 2, { vel: 0.45 });
  riser.hit(S.bridge.end - 2, '', 0.8, 0, 8);
  swell.note(S.build3.bar - 1, 'A3', 4, 0.8);

  // ── the last build and drop, a whole step up ──
  build(S.build3.bar, { up: UP, breath: true });
  drop(S.drop3.bar, { up: UP, first: [growl, GROWL_2], second: [growl, GROWL_3], answers: true });
  harm.play(harmony, S.drop3.bar, 8, { transpose: UP });
  harm.play(harmonyEnd, S.drop3.bar + 8, 8, { transpose: UP });
  bell.play(keysHook, S.drop3.bar, 8, { transpose: UP + 12, vel: 0.6 });
  bell.play(keysHookEnd, S.drop3.bar + 8, 8, { transpose: UP + 12, vel: 0.6 });
  arp.play(arpP1, S.drop3.bar, 16, { transpose: UP, vel: 0.75 });

  // ── outro: the hook on the piano one last time, in E, climbing to the tonic; then the last chord, rolled, left to ring ──
  down.hit(S.outro.bar, '', 0.8, 0, 8);
  pad.play(chordsP1, S.outro.bar, 8, { transpose: UP, vel: 0.8 });
  piano.play(keysHookEnd, S.outro.bar, 8, { transpose: UP - 12, vel: 0.75 });
  piano.play(pianoLH, S.outro.bar, 8, { transpose: UP, vel: 0.55 });
  kick.play(kickVerse, S.outro.bar, 4, { vel: 0.6 });
  clap.play(back, S.outro.bar, 4, { vel: 0.5 });
  hat.play(hatsOff, S.outro.bar, 4, { vel: 0.5 });
  sub.play(subHeldP1, S.outro.bar, 8, { transpose: UP });
  const fin = S.outro.end - 2;
  pad.play(s.notes('[E3,G#3,B3,E4,F#4]:32'), fin, 2, { vel: 0.75 });
  piano.play(s.notes('[E2,B2,E3,G#3,B3,E4]:32').strum(0.1), fin, 2, { vel: 0.65 });
  sub.play(s.notes('E1:32'), fin, 2, { vel: 0.6 });
  bell.note(fin, 'B5', 8, 0.4);

  // ── the music bus: half closed at the start, open by the verse; each build closes it and sweeps it open ──
  music.auto('mix.lp', [[0, 4000], [S.intro.end, 12000, 'exp'], [S.verse.end, 20000, 'exp']]);

  s.setReverb({ time: 3.2, preDelay: 0.025, return: -9, lowCut: 200, highCut: 8000 });
  s.setDelay({ time: '1/8.', feedback: 0.35, return: -11 });
  s.setSidechain({ release: 0.25, curve: 1.4 });
  s.setMaster({ trim: 5.7 }); // found with the probe's AUTOTRIM=1
});
