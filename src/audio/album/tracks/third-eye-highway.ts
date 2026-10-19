// Third Eye Highway: Goa trance for Xeno-Racer Vol. 1. 145 BPM, F#: phrygian grooves (the lowered second, G) under a
// harmonic-minor hook over F#m | D | E | C# (i - bVI - bVII - V, the C# major chord brings the leading tone E#).
//
// Form (bars): intro 0-8, groove 8-24, tease 24-32, theme 32-48, acid 48-64, float 64-72 and build 72-80 (the break),
// peak 80-96, climax 96-104, outro 104-120.
//
// Probe:  ALBUM=1 TRACK=sandbox/album/wip/third-eye-highway.ts AUTOTRIM=1 SPEC=1 npx vitest run tests/probes/album-render.test.ts
import { Pattern, defineTrack, fx, type SynthOpts } from '../song';

const TRIM = 2.3; // master trim in dB (AUTOTRIM=1)

/** Bars of note text joined with bar lines. */
const bars = (...b: string[]): string => b.join(' | ');

// ── patches ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// The break voice: a soft, breathy saw-and-triangle lead with a slow vibrato, for the theme in augmentation.
const astral: SynthOpts = {
  mode: 'legato', voices: 1,
  layers: [{ wave: 'saw', unison: 3, detune: 0.6, phase: 'free' }, { wave: 'tri', octave: 1, level: 0.4, phase: 'free' }],
  filter: 'lp', cutoff: 1900, res: 0.18, envAmt: 0.9, fAttack: 0.08, fDecay: 0.7, fSustain: 0.55, keytrack: 0.5,
  attack: 0.05, decay: 0.6, sustain: 0.9, release: 0.8, glide: 0.07, unisonDetune: 9, spread: 0.6,
  vibDepth: 20, vibRate: 5.2, vibDelay: 0.35,
};

// The roll: one key-synced saw through the 24 dB ladder, snapping open on every note. The oscillator restarts on each note and the
// release (6 ms) ends before the next sixteenth, so every hit of the roll is the same (the reese's free-running, detuned saws made the
// level of the sixteenths wander over an 8 dB range). Rounder and deeper than the reese, it leaves the upper mids to the 303. The ladder
// rather than the 12 dB filter: its waveform is less skewed, and the master's saturation turned the skew of the other into DC (12x more).
const psyBass: SynthOpts = {
  mode: 'mono', voices: 1, mono: true,
  layers: [{ wave: 'saw', phase: 'reset' }],
  filter: 'ladder', cutoff: 600, res: 0.35, envAmt: 2.4, fAttack: 0.0005, fDecay: 0.09, fSustain: 0.2, fRelease: 0.01, keytrack: 0, velFilter: 0.2,
  attack: 0.0008, decay: 0.1, sustain: 0.6, release: 0.006, velAmp: 0.15, drive: 5, level: 17.5, // level: as loud as the reese roll it replaces
};

// The octave above the hook in the climax: mostly triangle, a fixed low-pass and no key tracking, so that it shines without screaming.
const sky: SynthOpts = {
  mode: 'legato', voices: 1,
  layers: [{ wave: 'tri', phase: 'free' }, { wave: 'saw', unison: 3, detune: 0.5, level: 0.35, phase: 'free' }],
  filter: 'lp', cutoff: 3400, res: 0.1, keytrack: 0, envAmt: 0.5, fDecay: 0.3, fSustain: 0.6,
  attack: 0.01, decay: 0.4, sustain: 0.85, release: 0.4, glide: 0.03, unisonDetune: 8, spread: 0.5,
  vibDepth: 10, vibRate: 5.6, vibDelay: 0.4,
};

export default defineTrack({ id: 'third-eye-highway', title: 'Third Eye Highway', genre: 'Goa trance', bpm: 145, bars: 120, tail: 4 }, (s) => {
  s.key('F#', 'phrygian');
  const S = s.sections({ intro: 8, groove: 16, tease: 8, theme: 16, acid: 16, float: 8, build: 8, peak: 16, climax: 8, outro: 16 });

  // ── instruments ───────────────────────────────────────────────────────────────────────────────────────────────────
  const kick = s.kick('psy-kick', { gain: -3 });
  const bass = s.synth(psyBass, { name: 'bass', gain: -6, duck: 1 });
  const acid = s.acid('goa-acid', { name: 'acid', gain: -9, pan: -0.08, delay: 0.1, fx: [fx.drive({ mode: 'tube', drive: 6, mix: 0.5 })] });
  const clap = s.clap('clap', { gain: -9, reverb: 0.12, pan: 0.05 });
  const snare = s.snare('tight-snare', { name: 'snare', gain: -10, reverb: 0.1 });
  const chat = s.hat('tight-hat', { name: 'chat', gain: -12, pan: -0.2 });
  const ohat = s.hat('closed-hat', { name: 'ohat', gain: -11, pan: 0.18 });
  const shaker = s.perc('shaker', { name: 'shaker', gain: -15, pan: 0.32 });
  const tamb = s.perc('tambourine', { name: 'tamb', gain: -13, pan: -0.3 });
  const congaLo = s.perc({ preset: 'conga', tune: 0.974 }, { name: 'congaLo', gain: -10, pan: -0.25, reverb: 0.1 }); // C4 sounds F#3
  const congaHi = s.perc({ preset: 'conga-hi', tune: 1.121 }, { name: 'congaHi', gain: -12, pan: 0.3, reverb: 0.1 }); // C4 sounds F#4
  const crash = s.cymbal('crash', { gain: -9, reverb: 0.2 });
  const swell = s.cymbal('reverse-crash', { name: 'swell', gain: -11 });
  // the pad and the arp without their octave layers: the pad's sub-octave saws sat in the 303's register (under a high-pass anyway),
  // the pluck's octave-up saw landed on the hook's passing notes
  const pad = s.synth({ preset: 'supersaw-pad', layers: [{ wave: 'saw', unison: 6 }] }, { name: 'pad', gain: -12, duck: 0.7, reverb: 0.35, hp: 220, fx: [fx.gate({ pattern: 'xx.xx.x.xx.xx.x.', depth: 1 }), fx.chorus({ rate: 0.3, depth: 4 })] });
  const arp = s.synth({ preset: 'trance-pluck', layers: [{ wave: 'saw', unison: 2, detune: 0.4 }], cutoff: 1700 }, { name: 'arp', gain: -8, delay: 0.2, reverb: 0.15, pan: 0.22, duck: 0.3 });
  const spin = s.synth({ preset: 'trance-pluck', cutoff: 1100, res: 0.55 }, { name: 'spin', gain: -11, delay: 0.25, reverb: 0.2, pan: -0.2, duck: 0.3, fx: [fx.filter({ mode: 'lp', cutoff: 2200, res: 1.4, lfoRate: 0.125, lfoDepth: 1.3 }), fx.phaser({ rate: 0.12, depth: 0.85, centre: 1400, feedback: 0.55, mix: 0.45 })] });
  const lead = s.synth({ preset: 'trance-lead', vibDepth: 14, vibRate: 5.6, vibDelay: 0.4 }, { name: 'lead', gain: -4, delay: 0.28, reverb: 0.25 });
  const harm = s.synth({ preset: 'supersaw-lead', layers: [{ wave: 'saw', unison: 7, phase: 'free' }] }, { name: 'harm', gain: -12, delay: 0.2, reverb: 0.3, pan: 0.15 }); // without the preset's sub-octave square: it doubled the second voice down into the arp
  const flute = s.synth(astral, { name: 'astral', gain: -4, delay: 0.4, reverb: 0.55 });
  const drone = s.sub('sub-sine', { name: 'drone', gain: -16 }); // the low F# under the break
  const skyLead = s.synth(sky, { name: 'sky', gain: -14, delay: 0.3, reverb: 0.4 });
  const riser = s.riser('riser', { gain: -15 });
  const wash = s.riser('noise-wash', { name: 'wash', gain: -17 });
  const down = s.riser('downlifter', { name: 'down', gain: -14, reverb: 0.3 });
  const boom = s.impact('impact', { name: 'boom', gain: -7, reverb: 0.25 });
  const zap = s.zap('zap-fm', { name: 'zap', gain: -15, delay: 0.45, reverb: 0.35 });

  // ── harmony ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const prog = s.chords('F#m | F#m | D | D | E | E | C# | C#', { octave: 3, lead: true }); // two bars per chord
  const progSlow = s.chords('F#m | % | % | % | D | % | % | % | E | % | % | % | C# | % | % | %', { octave: 3, lead: true }); // the break: four bars per chord

  // ── the hook: Theme A, eight bars. Bars 1-4 ask, 5-8 answer with the same rhythms a step higher; the peak is the C#6 of bar 6,
  // and the leading tone E#5 of bar 8 pulls back to F#5. Over F#m the line turns through the phrygian G; over D, E and C# it takes G#.
  const themeA = s.notes(bars(
    'F#5! - - C#5 - - F#5 - A5 - - - G5 - A5 -',
    'B5 - - - - - A5 - - - - G5 F#5 - E5 -',
    'F#5 - - - - - - - - - D5 - E5 - F#5 -',
    'B5~ - - - - - - - A5 - G#5 - F#5 - E5 -',
    'G#5 - - E5 - - G#5 - B5 - - - A5 - B5 -',
    'C#6!~ - - - - - B5 - - - - A5 G#5 - E5 -',
    'E#5 - - - - - - - - - C#5 - E#5 - G#5 -',
    'B5~ - - - - - - - A5 - G#5 - F#5 - E#5 -',
  ));
  // the climax answer: the same question, then up to E6 and down through the phrygian-dominant D6 over C#
  const answerHi = s.notes(bars(
    'G#5 - - E5 - - G#5 - B5 - - - C#6 - D6 -',
    'E6!~ - - - - - - - D6 - C#6 - B5 - G#5 -',
    'E#5 - - - - - - - G#5 - - - B5 - C#6 -',
    'D6 - - - C#6 - - - B5 - G#5 - E#5 - - -',
  ));
  const themeHi = themeA.slice(0, 16).then(answerHi);
  // the second voice of the peak: thirds and fourths under the hook, chord tones on the strong beats
  const harmA = s.notes(bars(
    'C#5 - - A4 - - C#5 - F#5 - - - E5 - F#5 -',
    'F#5 - - - - - - - E5 - - - C#5 - - -',
    'D5 - - - - - - - - - A4 - C#5 - D5 -',
    'D5 - - - - - - - F#5 - E5 - D5 - C#5 -',
    'E5 - - B4 - - E5 - G#5 - - - F#5 - G#5 -',
    'G#5 - - - - - - - E5 - - - - - B4 -',
    'C#5 - - - - - - - - - G#4 - C#5 - E#5 -',
    'G#5 - - - - - - - E#5 - - - C#5 - - -',
  ));
  const harmHi = harmA.slice(0, 16).then(s.notes(bars(
    'E5 - - B4 - - E5 - G#5 - - - A5 - B5 -',
    'B5 - - - - - - - B5 - G#5 - - - E5 -',
    'C#5 - - - - - - - E#5 - - - G#5 - - -',
    'B5 - - - G#5 - - - - - E#5 - C#5 - - -',
  )));

  // ── the spinner: a psychedelic sixteenth figure, a pedal pair under a top voice that winds through the phrygian mode
  // (three-step cells against the four-step beat, so it rolls over the bar line)
  const spinner = s.notes(bars(
    'F#4 C#5 F#5 F#4 C#5 A5 F#4 C#5 G5 F#4 C#5 F#5 F#4 C#5 E5 C#5',
    'F#4 C#5 F#5 F#4 C#5 A5 F#4 C#5 B5 F#4 C#5 A5 F#4 C#5 G5 A5',
  ));
  // in the break the figure sits an octave lower under the pad, so its top voice leaves out the G (it would grind on the pad's F#),
  // and in its second bar the pedal steps up to A for two cells, out of the way of the soft lead's passing G5
  const spinnerFloat = s.notes(bars(
    'F#4 C#5 F#5 F#4 C#5 A5 F#4 C#5 E5 F#4 C#5 F#5 F#4 C#5 E5 C#5',
    'F#4 C#5 F#5 F#4 C#5 A5 A4 C#5 B5 A4 C#5 A5 F#4 C#5 E5 A5',
  ));
  // the same figure over the D chord of the break (the pedal pair becomes D-A, the top voice keeps to the chord's scale)
  const spinnerD = s.notes(bars(
    'D4 A4 D5 D4 A4 F#5 D4 A4 E5 D4 A4 D5 D4 A4 B4 A4',
    'D4 A4 D5 D4 A4 F#5 D4 A4 A5 D4 A4 F#5 D4 A4 E5 F#5',
  ));
  const themeArp = s.arp(prog, { order: 'up', octaves: 2, res: 4 });
  const climaxArp = s.arp(prog, { order: [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 2, 5, 0, 1, 2, 4], octaves: 2, res: 4 }); // up, down, then a skip: fresh motion, clear of the hook's passing notes

  // ── the 303: one-bar cells in F# phrygian (a slide ~ always follows a note directly)
  const acidR1 = s.notes('F#2 . F#3! F#2 . F#2 C#3~ . G2 F#2 . F#2 A2! G2~ F#2 E2'); // the b2 lands with the kick and falls to F#
  const acidR1b = s.notes('F#2 . F#3! F#2 . F#2 C#3~ . G2 F#2 . F#2 A2! C#3~ E3 F#3!'); // the phrase end climbs
  const acidR2 = s.notes('F#2 F#3! . F#2 G2 F#2~ . F#2 C#3! . F#2 E3~ . F#2 A2 C#3~');
  const acidR3 = s.notes('F#3! F#2 F#3 G3~ F#3 . C#3! F#2 F#3 A3~ G3 F#3 . E3! F#3~ C#3');
  const acidGroove = Pattern.concat([acidR1, acidR1, acidR1, acidR1b, acidR1, acidR1, acidR1, acidR1b, acidR1, acidR2, acidR1, acidR1b, acidR1, acidR2, acidR1, acidR2]);
  // the acid section is a 16-bar solo: a question-and-answer riff, a three-step accent cycle that rolls across the beat, then the top
  // octave with a new turn every second bar, and a last bar that breaks off into the break
  const acidSolo = s.notes(bars(
    'F#2 . F#2 F#3! . F#2 . F#2 A2 . F#2 C#3! . F#2 D3~ C#3',
    'F#2 . F#2 F#3! . F#2 . F#2 G2 . F#2 E3! . F#2 F#3~ E3',
    'F#2 . F#2 F#3! . F#2 . F#2 A2 . F#2 C#3! . F#2 D3~ C#3',
    'F#2 . F#2 F#3! . F#2 A2~ F#2 G2 . F#2 E3! . F#2 A3~ G3',
    'F#2 F#2 F#3! F#2 . F#2 C#3~ F#2 A2 . F#2 C#3! . F#2 D3~ C#3',
    'F#2 F#2 F#3! F#2 . F#2 C#3~ F#2 G2 . F#2 E3! F#2 G3~ F#3 E3',
    'F#2 F#3! F#2 F#2 F#3! F#2 F#2 F#3! F#2 F#2 F#3! F#2 F#2 F#3! F#2 E3~',
    'F#2 F#3! F#2 G2 A3! G2~ F#2 C#3! F#2 E2 F#3! E3~ F#2 G3! F#3~ C#3',
    'F#3! F#2 F#3 G3~ F#3 . C#3! F#2 F#3 A3~ G3 F#3 . E3! F#3~ C#3',
    'F#3! F#2 F#3 G3~ F#3 . C#3! F#2 F#3 A3~ G3 F#3 . E3! D3~ C#3',
    'F#3! F#2 F#3 G3~ F#3 . C#3! F#2 F#3 A3~ G3 F#3 . E3! F#3~ C#3',
    'F#3! F#2 F#3 G3~ A3 . C#4! F#2 F#3 A3~ G3 F#3 . E3! F#3~ G3',
    'F#3! F#2 F#3 G3~ F#3 . C#3! F#2 F#3 A3~ B3 A3 . G3! F#3~ E3',
    'F#3! F#2 F#3 G3~ F#3 . C#3! F#2 F#3 A3~ G3 F#3 . E3! F#3~ C#3',
    'F#3! F#3 F#2 F#3! F#3 F#2 F#3! F#3 F#2 F#3! F#3 F#2 F#3! F#3 F#2 C#3~',
    'F#3! . . . A3! G3~ . . F#3! . . . . . . .',
  ));
  // over the progression the cell follows the chord: root, octave and fifth down low, the colour tones an octave up so that they never
  // rub a second against the bass; over C# it keeps to the dominant's own notes (C#, E#, G#, B)
  const acidTheme = s.notes(bars(
    'F#2 . F#3! F#2 . F#2 C#3~ . G2 F#2 . F#2 A2! G2~ F#2 E2',
    'F#2 . F#3! F#2 . F#2 C#3~ . F#2 A2 . F#2 C#3! B2~ A2 E2',
    'D2 . D3! D2 . D2 A2~ . D2 E3 . D2 F#3! E3~ D2 A2',
    'D2 . D3! D2 . D2 A2~ . D2 F#2 . D2 A2! F#2~ D2 E3',
    'E2 . E3! E2 . E2 B2~ . E2 F#3 . E2 G#2! F#3~ E2 D3',
    'E2 . E3! E2 . E2 B2~ . E2 G#2 . E2 B2! G#2~ E2 D3',
    'C#2 . C#3! C#2 . C#2 G#2~ . C#2 E#3 . C#2 B2! G#2~ C#2 E#2',
    'C#2 . C#3! C#2 . C#2 G#2~ . C#2 E#2 . C#2 G#2! B2~ G#2 E#2',
  ));
  // the climax: the 303 an octave up in a stream of sixteenths, chord tones and safe colours only (it shares the pad's octave)
  const acidClimax = s.notes(bars(
    'F#2 F#3! F#2 F#3 A3~ F#3 . C#4! F#2 F#3 E3~ F#3 . A3! C#4~ B3',
    'F#2 F#3! F#2 F#3 A3~ F#3 . C#4! F#2 F#3 E3~ F#3 . E4! C#4~ A3',
    'D2 D3! D2 D3 F#3~ D3 . A3! D2 D3 E3~ D3 . F#3! A3~ D4',
    'D2 D3! D2 D3 F#3~ D3 . A3! D2 D3 E3~ F#3 . A3! B3~ A3',
    'E2 E3! E2 E3 G#3~ E3 . B3! E2 E3 F#3~ E3 . G#3! B3~ E4',
    'E2 E3! E2 E3 G#3~ E3 . B3! E2 E3 F#3~ G#3 . B3! E4~ D4',
    'C#2 C#3! C#2 C#3 E#3~ C#3 . G#3! C#2 C#3 B2~ C#3 . E#3! G#3~ C#4',
    'C#2 C#3! C#2 C#3 E#3~ C#3 . G#3! C#2 C#3 B2~ C#3 . G#3! B3~ E#3',
  ));

  // ── bass: the off-beat roll; a four-bar pedal with a turn into the next phrase
  const roll = '.xxx.xxx.xxx.xxx';
  const pedal4 = s.notes(bars(
    '. F#1 F#1 F#1 . F#1 F#1 F#1 . F#1 F#1 F#1 . F#1 F#1 F#1',
    '. F#1 F#1 F#1 . F#1 F#1 F#1 . F#1 F#1 F#1 . F#1 F#1 F#1',
    '. F#1 F#1 F#1 . F#1 F#1 F#1 . F#1 F#1 F#1 . F#1 F#1 F#1',
    '. F#1 F#1 F#1 . F#1 F#1 F#1 . F#1 F#1 F#1 . F#1 G1 A1',
  ));
  // roots() holds each hit until the next one, so the third sixteenth would ring on under the kick: every note is cut to one sixteenth
  const sixteenths = (p: Pattern): Pattern => p.map((e) => ({ ...e, d: Math.min(e.d, 0.225) }));
  const progBass = sixteenths(prog.roots({ rhythm: roll, low: 30 })); // F#1, D2, E2, C#2
  const slowBass = sixteenths(progSlow.roots({ rhythm: roll, low: 30 }));

  // ── drums
  const four = s.hits('X...X...X...X...');
  const fourEnd = s.hits('X...X...X.......'); // the last beat left out: a breath before a new section
  const backbeat = s.hits('....X.......X...');
  const offHat = s.hits('..o...o...o...o.');
  const offHatAcc = s.hits('..O...o...O...o.');
  const tick = s.hits('.x.x.x.x.x.x.x.x');
  const tickG = s.hits('.x.g.x.g.x.g.x.g');
  const shake = s.hits('xgxgxgxgxgxgxgxg');
  const tambs = s.hits('....x.......x...'); // with the clap on two and four
  const snareFill = s.hits('............x.xX');
  const roll4 = s.hits(bars('3...4...5...6...', '4.4.5.5.6.6.7.7.', '5566667777888888', '8888999999999999'));
  const congaPat = s.notes('C4 . . C4 . . . . C4 . . . . . C4 .');
  const congaHiPat = s.notes('. . G4 . . . C4 . . . C4 . . G4 . .');

  // ── arrangement ──────────────────────────────────────────────────────────────────────────────────────────────────
  const A = S;
  // intro: an alien call, the pad and the spinner opening up; ticks and a shaker from bar 4; a dark riser into the first kick
  zap.hit(A.intro.bar, '', 0.9);
  pad.play(s.chords('F#m', { octave: 3 }), A.intro.bar, 8);
  spin.play(spinner, A.intro.bar, A.intro.bars + 8); // it leaves when the clap arrives
  bass.play(pedal4, A.intro.bar + 4, 4); // the roll arrives high-passed: its tick is heard before its weight (see bass.mix.hp)
  acid.play(acidR1, A.intro.bar + 2, 6); // the 303 bubbles up from far away
  congaLo.play(congaPat, A.intro.bar + 4, 4);
  congaHi.play(congaHiPat, A.intro.bar + 6, 2);
  shaker.play(shake, A.intro.bar + 4, 4);
  chat.play(tickG, A.intro.bar + 6, 2);
  riser.hit(A.intro.bar + 6, '', 0.9, 0, 8);
  swell.note(A.intro.end - 1, 'A3', 4, 0.9);

  // groove: kick, the roll, ticks and open hats; the clap and the tambourine join at bar 16
  for (const b of [A.groove.bar, A.groove.bar + 8, A.tease.bar, A.theme.bar, A.theme.bar + 8, A.acid.bar, A.acid.bar + 8, A.peak.bar, A.peak.bar + 8, A.climax.bar, A.outro.bar]) crash.hit(b, '', 1);
  boom.hit(A.groove.bar, '', 0.8);
  kick.play(four, A.groove.bar, A.groove.bars - 1);
  kick.play(fourEnd, A.groove.end - 1, 1);
  bass.play(pedal4, A.groove);
  chat.play(tick, A.groove);
  ohat.play(offHat, A.groove);
  clap.play(backbeat, A.groove.bar + 8, 8);
  tamb.play(tambs, A.groove.bar + 8, 8);
  snare.play(snareFill, A.groove.bar + 7, 1);
  snare.play(snareFill, A.groove.end - 1, 1);
  acid.play(acidGroove, A.groove);
  congaLo.play(congaPat, A.groove.bar + 12, 4); // a tribal lift into the tease
  congaHi.play(congaHiPat, A.groove.bar + 14, 2);

  // tease: the hook's first two bars ask twice; the acid answers each time from the top octave
  kick.play(four, A.tease.bar, A.tease.bars - 1);
  kick.play(fourEnd, A.tease.end - 1, 1);
  bass.play(pedal4, A.tease);
  chat.play(tick, A.tease);
  ohat.play(offHat, A.tease);
  clap.play(backbeat, A.tease);
  tamb.play(tambs, A.tease);
  lead.play(themeA.slice(0, 8), A.tease.bar, 2);
  lead.play(themeA.slice(0, 8), A.tease.bar + 4, 2);
  acid.play(acidR1, A.tease.bar, 2);
  acid.play(acidR3, A.tease.bar + 2, 2);
  acid.play(acidR1, A.tease.bar + 4, 2);
  acid.play(acidR3, A.tease.bar + 6, 2);
  pad.play(s.chords('A', { octave: 3 }), A.tease.bar, A.tease.bars - 0.25); // A C# E over the F# bass: F#m7 without its root, clear of the acid's G
  snare.play(s.hits('x.x.x.x.xxxxXXXX'), A.tease.end - 1, 1);
  swell.note(A.tease.end - 1, 'A3', 4, 1);

  // theme: the progression arrives; the hook twice (the second time it hands its last note to the acid section)
  boom.hit(A.theme.bar, '', 1);
  kick.play(four, A.theme.bar, A.theme.bars - 1);
  kick.play(fourEnd, A.theme.end - 1, 1);
  bass.play(progBass, A.theme);
  chat.play(tick, A.theme);
  ohat.play(offHatAcc, A.theme);
  clap.play(backbeat, A.theme);
  tamb.play(tambs, A.theme);
  shaker.play(shake, A.theme);
  pad.play(prog, A.theme);
  arp.play(themeArp, A.theme);
  lead.play(themeA, A.theme.bar, 8);
  lead.play(themeA, A.theme.bar + 8, 8);
  harm.play(harmA.filter((e) => [2, 3, 6, 7].includes(Math.floor(e.t / 4))), A.theme.bar + 8, 8); // the second voice, on the held notes only
  acid.play(acidTheme, A.theme);
  snare.play(snareFill, A.theme.bar + 7, 1);
  snare.play(s.hits('x.x.x.x.xxxxXXXX'), A.theme.end - 1, 1);

  // acid: back on the pedal; the 303 alone in front, then up an octave with the spinner and the congas
  lead.note(A.acid.bar, 'F#5', 6, 0.9);
  kick.play(four, A.acid.bar, A.acid.bars - 1);
  kick.play(s.hits('X...X...........'), A.acid.end - 1, 1);
  bass.play(pedal4, A.acid.bar, A.acid.bars - 1);
  bass.play(s.notes('. F#1 F#1 F#1 . F#1 F#1 F#1 . . . . . . . .'), A.acid.end - 1, 1);
  chat.play(tick, A.acid);
  ohat.play(offHat, A.acid);
  clap.play(backbeat, A.acid.bar, A.acid.bars - 1);
  tamb.play(tambs, A.acid);
  congaLo.play(congaPat, A.acid);
  congaHi.play(congaHiPat, A.acid.bar + 8, 8);
  acid.play(acidSolo, A.acid);
  snare.play(snareFill, A.acid.bar + 7, 1);
  spin.play(spinner, A.acid.bar + 8, 7.5);
  zap.hit(A.acid.bar + 15.5, '', 1);
  for (const b of [A.tease.bar - 0.5, A.acid.bar - 0.25, A.climax.bar - 0.5]) zap.hit(b, '', 0.7); // sparse alien calls at the seams

  // the break, part one (float): no drums; the hook in augmentation on the soft voice, the pad slowly gated
  down.hit(A.float.bar, '', 0.9, 0, 8);
  pad.play(progSlow, A.float.bar, A.float.bars + A.build.bars);
  flute.play(themeA.scaleTime(2), A.float.bar, A.float.bars + A.build.bars);
  spin.play(spinnerFloat.octave(-1), A.float.bar, 4);
  spin.play(spinnerD.octave(-1), A.float.bar + 4, 4);
  drone.note(A.float.bar, 'F#1', 8 * 4 - 1, 0.8);
  shaker.play(shake, A.float.bar + 4, 4);

  // the break, part two (build): the roll returns on the chords, the 303 creeps in, a riser and a snare roll to the drop
  bass.play(slowBass.slice(32, 64), A.build.bar, A.build.bars - 0.25);
  acid.play(acidTheme.slice(24, 32), A.build.bar + 4, 4); // the C# bars only: the build sits on the dominant
  chat.play(tick, A.build.bar + 4, 4);
  snare.play(roll4, A.build.bar + 4, 4);
  riser.hit(A.build.bar, '', 1, 0, 32);
  wash.hit(A.build.end - 2, '', 1, 0, 8);
  swell.note(A.build.end - 1, 'A3', 4, 1);

  // peak: the drop; the hook with its second voice, then the high answer
  boom.hit(A.peak.bar, '', 1);
  for (const sec of [A.peak, A.climax]) {
    kick.play(four, sec.bar, sec.bars);
    bass.play(progBass, sec);
    chat.play(tick, sec);
    ohat.play(offHatAcc, sec);
    clap.play(backbeat, sec);
    tamb.play(tambs, sec);
    shaker.play(shake, sec);
    pad.play(prog, sec);
    arp.play(sec === A.climax ? climaxArp : themeArp, sec);
    acid.play(sec === A.climax ? acidClimax : acidTheme, sec);
  }
  lead.play(themeA, A.peak.bar, 8);
  harm.play(harmA, A.peak.bar, 8);
  lead.play(themeHi, A.peak.bar + 8, 8);
  harm.play(harmHi, A.peak.bar + 8, 8);
  // climax: the high version once more with its second voice, the 303 an octave up and screaming, the congas back in
  lead.play(themeHi, A.climax.bar, 8);
  harm.play(harmHi, A.climax.bar, 8);
  skyLead.play(themeHi.octave(1), A.climax.bar, 8); // the last time, the hook also sings an octave higher
  // the congas are tuned (root and fifth), so over the progression they follow the chord: F#, D, E, C#
  [0, -4, -2, -5].forEach((tr, i) => {
    congaLo.play(congaPat, A.climax.bar + 2 * i, 2, { transpose: tr });
    congaHi.play(congaHiPat, A.climax.bar + 2 * i, 2, { transpose: tr });
  });
  snare.play(snareFill, A.peak.bar + 7, 1);
  snare.play(snareFill, A.peak.end - 1, 1);
  snare.play(s.hits('x.x.x.x.xxxxXXXX'), A.climax.end - 1, 1);

  // outro: the pedal groove, the hook's last note resolving, the layers leave one by one, a last boom
  lead.note(A.outro.bar, 'F#5', 8, 0.9);
  kick.play(four, A.outro.bar, A.outro.bars - 1);
  kick.play(s.hits('X...............'), A.outro.end - 1, 1);
  bass.play(pedal4, A.outro.bar, A.outro.bars - 1);
  chat.play(tick, A.outro.bar, 12);
  ohat.play(offHat, A.outro.bar, 8);
  clap.play(backbeat, A.outro.bar, 8);
  tamb.play(tambs, A.outro.bar, 8);
  acid.play(acidR1, A.outro.bar, 8);
  acid.play(acidR2, A.outro.bar + 8, 7);
  snare.play(snareFill, A.outro.bar + 7, 1);
  spin.play(spinner, A.outro.bar + 2, 6); // after the hook's last note has gone
  flute.play(themeA.slice(0, 8), A.outro.bar + 8, 2, { vel: 0.85 }); // the hook's first words drift past twice, far away
  flute.play(themeA.slice(0, 8), A.outro.bar + 12, 2, { vel: 0.75 });
  pad.play(s.chords('F#m', { octave: 3 }), A.outro.end - 1, 1); // the last chord, ungated (see pad.fx.gate.depth)
  flute.note(A.outro.end - 1, 'F#5', 4, 0.7);
  boom.hit(A.outro.end - 1, '', 0.7);

  // ── automation ───────────────────────────────────────────────────────────────────────────────────────────────────
  // the 303 evolves all the way through: cutoff, resonance and decay
  acid.auto('cutoff', [
    [A.intro.bar + 2, 150], [A.groove.bar, 260, 'exp'], [A.groove.bar + 8, 700, 'exp'], [A.tease.bar, 1300, 'exp'], [A.tease.end, 1500],
    [A.theme.bar, 520, 'step'], [A.theme.end, 700],
    [A.acid.bar, 380, 'step'], [A.acid.bar + 8, 2400, 'exp'], [A.acid.bar + 8, 900, 'step'], [A.acid.end, 2800, 'exp'],
    [A.build.bar + 4, 200, 'step'], [A.build.end, 1400, 'exp'],
    [A.peak.bar, 800, 'step'], [A.climax.end, 1900, 'exp'],
    [A.outro.bar, 1500, 'step'], [A.outro.end, 260, 'exp'],
  ]);
  acid.auto('res', [[A.groove.bar, 0.8], [A.tease.end, 0.88], [A.acid.bar, 0.86, 'step'], [A.acid.end, 0.93], [A.build.bar, 0.86, 'step'], [A.climax.end, 0.9], [A.outro.end, 0.8]]);
  acid.auto('decay', [[A.groove.bar, 0.15], [A.tease.end, 0.24], [A.theme.bar, 0.17, 'step'], [A.acid.bar, 0.18, 'step'], [A.acid.end, 0.34], [A.build.bar, 0.18, 'step'], [A.outro.end, 0.15]]);
  acid.auto('mix.gain', [[A.intro.bar + 2, -15], [A.groove.bar, -9, 'smooth'], [A.theme.bar, -9], [A.theme.bar, -13, 'step'], [A.acid.bar, -9, 'step'], [A.peak.bar, -12, 'step'], [A.outro.bar, -9, 'step']]);
  acid.auto('envMod', [[A.climax.bar, 0.8], [A.climax.bar, 1, 'step'], [A.outro.bar, 0.8, 'step']]); // the climax: wide open
  acid.auto('accent', [[A.climax.bar, 0.9], [A.climax.bar, 1, 'step'], [A.outro.bar, 0.9, 'step']]);
  // the spinner's own filter opens over the intro, the lead's over the tease
  spin.auto('fx.filter.cutoff', [[A.intro.bar, 400], [A.intro.end, 2200, 'exp'], [A.float.bar, 900, 'step'], [A.float.end, 1800, 'exp'], [A.outro.bar, 2200, 'step'], [A.outro.bar + 12, 300, 'exp']]);
  lead.auto('cutoff', [[A.tease.bar, 1100], [A.tease.end, 3200, 'exp']]);
  pad.auto('mix.hp', [[A.intro.bar, 900], [A.intro.end, 220, 'exp'], [A.tease.bar, 1400, 'step'], [A.tease.end - 0.25, 300, 'exp'], [A.tease.end, 220, 'step'], [A.build.end - 2, 220], [A.build.end - 0.25, 1200, 'exp'], [A.build.end, 220, 'step']]);
  pad.auto('fx.gate.depth', [[A.intro.bar, 0.25], [A.theme.bar, 1, 'step'], [A.float.bar, 0.3, 'step'], [A.build.bar, 0.6, 'step'], [A.peak.bar, 1, 'step'], [A.outro.end - 1, 0, 'step']]);
  bass.auto('mix.hp', [[A.intro.bar + 4, 420], [A.intro.end, 90, 'exp'], [A.intro.end, 20, 'step'], [A.tease.bar + 4, 20], [A.tease.end - 0.25, 320, 'exp'], [A.tease.end, 20, 'step'], [A.build.bar, 260, 'step'], [A.build.end - 0.25, 30, 'exp'], [A.build.end, 20, 'step']]);
  pad.auto('mix.gain', [[A.intro.bar, -9], [A.intro.end, -13], [A.float.bar, -13], [A.float.bar, -6, 'step'], [A.build.bar, -8], [A.peak.bar, -13, 'step'], [A.outro.end - 1, -9, 'step']]); // louder while it is alone in the intro and the break
  shaker.auto('mix.gain', [[A.intro.bar + 4, -27], [A.intro.bar + 6, -15, 'in']]); // fades in instead of switching the top end on
  spin.auto('mix.gain', [[A.intro.bar, -8], [A.intro.end, -11], [A.float.bar, -11], [A.float.bar, -8, 'step'], [A.float.end, -11, 'step']]);
  lead.auto('mix.delay', [[A.acid.bar, 0.28], [A.acid.bar, 0.65, 'step'], [A.acid.bar + 2, 0.28, 'step'], [A.outro.bar, 0.65, 'step'], [A.outro.bar + 2, 0.28, 'step']]); // throws on the held resolutions
  s.auto('reverb.time', [[A.acid.end - 1, 3.2], [A.float.bar, 5, 'smooth'], [A.build.end - 1, 4.5], [A.peak.bar, 3.2, 'step']]);

  // ── mix ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  s.setReverb({ time: 3.2, return: -9, lowCut: 200 });
  s.setDelay({ time: '1/8.', feedback: 0.38, return: -9 });
  s.setSidechain({ release: 0.1 });
  s.setMaster({ trim: TRIM });
});
