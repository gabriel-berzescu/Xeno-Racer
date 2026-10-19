/**
 * The catalogue of everything a composer can use, as data: factories, parameters (with ranges and units), presets, options,
 * drum / kit parts, effects and the mixer sections. It feeds the README tables (tests/probes/album-docs.test.ts regenerates
 * them, tests/album-engine.test.ts checks that they are up to date) and `describe()` for tooling.
 */
import { ParamSpecs, PresetDef } from './instrument';
import { ACID_PRESETS, ACID_SPECS, DARK_PRESETS, DARK_SPECS, GROWL_PRESETS, GROWL_SPECS, REESE_PRESETS, REESE_SPECS, SUB_PRESETS, SUB_SPECS } from './instruments/bass';
import { CLAP_SPECS, CYMBAL_SPECS, DRUM_PRESETS, HAT_SPECS, KICK_SPECS, PERC_SPECS, SNARE_SPECS, TOM_SPECS } from './instruments/drums';
import { AKIT_PARTS, AKIT_PRESETS, AKIT_SPECS } from './instruments/acoustic-kit';
import { BASSG_PRESETS, BASSG_SPECS, GUITAR_PRESETS, GUITAR_SPECS } from './instruments/guitar';
import { IMPACT_PRESETS, IMPACT_SPECS, RISER_PRESETS, RISER_SPECS, ZAP_PRESETS, ZAP_SPECS } from './instruments/sfx';
import { SYNTH_PRESETS, SYNTH_SPECS } from './instruments/synth';
import { AMP_SPECS, CHORUS_SPECS, CRUSH_SPECS, DELAY_SPECS, DRIVE_SPECS, FILTER_SPECS, GATE_SPECS, PHASER_SPECS, PUMP_SPECS, REVERB_FX_SPECS, WIDEN_SPECS } from './fx';
import { DELAY_RETURN_SPECS, DUCK_SPECS, MASTER_SPECS, REVERB_RETURN_SPECS, STRIP_SPECS } from './mixer';

export interface InstrumentDoc {
  /** Song method: `s.<factory>(...)`. */
  factory: string;
  /** Default name of the mixer channel (what automation paths start with); a second instance gets a number: synth2. */
  channel: string;
  /** What you write to play it: hits, notes, drum lanes ... */
  plays: string;
  /** A runnable one- or two-line example (uses `s` and the sections `S`; the tests execute every one). */
  example: string;
  title: string;
  summary: string;
  specs: ParamSpecs;
  /** Structural options (fixed when the instrument is created) and what they mean. */
  options: [name: string, doc: string][];
  presets: Record<string, PresetDef>;
  /** Pattern part names for kits. */
  parts?: readonly string[];
  /** Pattern notation hints specific to this instrument. */
  notes?: string[];
}

const only = (type: string): Record<string, PresetDef> => Object.fromEntries(Object.entries(DRUM_PRESETS).filter(([, p]) => p.type === type));

export const CATALOG: InstrumentDoc[] = [
  {
    factory: 'kick',
    channel: 'kick',
    plays: 'hits (`s.hits`)',
    example: 's.kick(\'psy-kick\', { gain: -3 }).play(s.hits(\'X...x...X...x...\'), S.drop);',
    title: 'Kick drum',
    summary: 'Synthesised kick: a sine with a pitch drop, a beater click and saturation. Kicks key the sidechain by default.',
    specs: KICK_SPECS,
    options: [],
    presets: only('kick'),
    notes: ['Write it with `s.hits(...)`: `x` hit, `X` accent, `g` ghost, digits 1-9 velocity.'],
  },
  {
    factory: 'snare',
    channel: 'snare',
    plays: 'hits (`s.hits`)',
    example: 's.snare(\'darksynth-snare\', { reverb: 0.15 }).play(s.hits(\'....X.......X..g\'), S.drop);',
    title: 'Snare drum',
    summary: 'Synthesised snare: tonal body plus band-passed noise and a crack.',
    specs: SNARE_SPECS,
    options: [],
    presets: only('snare'),
    notes: ['`s.hits(...)`; velocity changes the noise brightness as well as the level.'],
  },
  {
    factory: 'clap',
    channel: 'clap',
    plays: 'hits (`s.hits`)',
    example: 's.clap(\'big-clap\').play(s.hits(\'....x.......x...\'), S.drop);',
    title: 'Clap',
    summary: 'Several quick noise bursts and a tail through a band-pass.',
    specs: CLAP_SPECS,
    options: [],
    presets: only('clap'),
  },
  {
    factory: 'hat',
    channel: 'hat',
    plays: 'hits (`s.hits`; `o` = open)',
    example: 's.hat(\'closed-hat\', { pan: 0.2, gain: -6 }).play(s.hits(\'x.x.x.x.x.x.x.xo\'), S.drop); // o = open hat',
    title: 'Hi-hat',
    summary: 'Metallic oscillator cluster plus noise. A hit with the `o` flag is the open hat; a closed hit chokes it.',
    specs: HAT_SPECS,
    options: [],
    presets: only('hat'),
    notes: ['`s.hits("x.x.x.xo")`: `o` = open hat.'],
  },
  {
    factory: 'tom',
    channel: 'tom',
    plays: 'notes (the pitch)',
    example: 's.tom(\'tom-low\').play(s.notes(\'A2 . . . D3 . F3 . A3 . . . . . . .\'), S.drop); // the note is the pitch',
    title: 'Tom (pitched)',
    summary: 'Pitch-dropping tom. Play notes: A2 gives the pitch as set, other notes transpose it.',
    specs: TOM_SPECS,
    options: [],
    presets: only('tom'),
    notes: ['Notes, not hits: `s.notes("A2 . D3 . F3 . A3 .")`.'],
  },
  {
    factory: 'cymbal',
    channel: 'cymbal',
    plays: 'hits; the reverse crash: a note as long as the swell',
    example: 's.cymbal(\'crash\').hit(S.drop.bar, \'\', 1);\ns.cymbal(\'reverse-crash\', { name: \'swell\' }).note(S.drop.bar - 1, \'A3\', 4, 1); // ends exactly where its note ends',
    title: 'Cymbals',
    summary: 'Crash, ride, splash, china and a reverse crash that swells to the end of the note, played back from modal-synthesis buffers.',
    specs: CYMBAL_SPECS,
    options: [],
    presets: only('cymbal'),
    notes: ['The reverse crash ends exactly where its note ends: write a note as long as the build you want (`s.notes("A3:16")` is one bar). The pitch of that note does not matter.'],
  },
  {
    factory: 'perc',
    channel: 'perc',
    plays: 'hits (`s.hits`)',
    example: 's.perc(\'shaker\', { gain: -4 }).play(s.hits(\'x.xxx.xxx.xxx.xx\'), S.drop);',
    title: 'Percussion',
    summary: 'Rim, clave, cowbell, shaker, tambourine, congas, block and finger snap.',
    specs: PERC_SPECS,
    options: [],
    presets: only('perc'),
  },
  {
    factory: 'drumKit',
    channel: 'drums',
    plays: 'drum lanes (`s.drums`)',
    example: 's.drumKit({ kick: \'psy-kick\', snare: \'tight-snare\', hat: { preset: \'closed-hat\', pan: 0.2 } }).play(s.drums({ kick: \'x...x...\', snare: \'....x...\', hat: \'x.x.x.xo\' }), S.drop);',
    title: 'Drum kit (electronic, custom)',
    summary: 'Several electronic drums behind one channel with part names of your choice: `s.drumKit({ kick: "psy-kick", snare: "tight-snare", hat: { preset: "closed-hat", pan: 0.2, gain: -4 } })`. Parameters are addressed as `part.param` (`kick.decay`, `hat.gain`, `snare.pan`). A kit with a kick part keys the sidechain by default, on its kick hits only (not the snare and the hats).',
    specs: {},
    options: [
      ['(part)', 'a preset name or `{ preset, ...overrides, gain: dB, pan: -1..1 }`; part names are free (kick, snare, hatC ...), the pattern lanes use them'],
    ],
    presets: {},
    notes: ['Patterns: `s.drums({ kick: "x...x...", snare: "....x...", hat: "x.x.x.xo" })`.'],
  },
  {
    factory: 'acousticKit',
    channel: 'kit',
    plays: 'drum lanes (`s.drums`)',
    example: 's.acousticKit(\'punk-kit\').play(s.drums({ kick: \'x...x.x.x...x.x.\', snare: \'....x.......x...\', hat: \'x.x.x.x.x.x.x.xo\', crash: \'X...............\' }), S.drop);',
    title: 'Acoustic drum kit',
    summary:
      'A rock / punk kit: kick, snare with rattling wires, rim shot, three toms, hi-hats, two crashes, ride, bell, splash and china, with a small room. Modal synthesis: drum heads are inharmonic decaying modes, harder hits get more high modes and more rattle. It does not key the sidechain unless the mix says `key: true` (then only its kick does).',
    specs: AKIT_SPECS,
    options: [['pan', 'object of part -> pan (-1..1) to move parts in the stereo field (drummer\'s view by default)']],
    presets: AKIT_PRESETS,
    parts: AKIT_PARTS,
    notes: [
      'Lanes: `s.drums({ kick: "x...", snare: "....x...", hat: "x.x.x.xo", crash: "X..." })`; `hat` is the closed hat and `o` opens it, `hatC` / `hatO` / `hatP` address them directly.',
      'Hit characters: `x` normal, `X` accent, `g` ghost note, `r` rim shot (on the snare lane), `f` flam, `m` muted cymbal.',
    ],
  },
  {
    factory: 'synth',
    channel: 'synth',
    plays: 'notes and chords',
    example: 's.synth(\'supersaw-pad\', { reverb: 0.3 }).play(s.chords(\'Am | F | C | G\', { octave: 3, lead: true }), S.drop);',
    title: 'Synth',
    summary:
      'The flexible one: pads, supersaw chords, plucks, arps, leads, FM bells, organs. Up to three oscillator layers (saw, square, pulse, triangle, sine, noise, 2-operator FM) with unison, a 24 dB ladder or 12 dB state-variable filter, amp and filter ADSRs, vibrato, glide, two tempo-locked LFOs and a small modulation matrix.',
    specs: SYNTH_SPECS,
    options: [
      ['layers', "array (1-3) of `{ wave, octave, semi, fine, level, unison (1-9), detune, phase }`; waves: saw square pulse tri sine noise fm; phase: 'random' (default), 'reset' (all voices start together: punchier) or 'free' (carries on: no clicks in mono)"],
      ['mode', "'poly' (chords, default), 'mono' (last note priority, glide) or 'legato' (envelopes only retrigger when no key is held)"],
      ['voices', 'polyphony in poly mode (default 8)'],
      ['filter', "'ladder' (24 dB, default), 'lp' / 'hp' / 'bp' / 'notch' (12 dB) or 'off'"],
      ['mono', 'force a mono (true) or stereo (false) output; default: stereo when any layer has unison > 1'],
      ['mods', 'array of `{ src: lfo1 | lfo2 | env | vel | key | rand, dst: cutoff | res | pitch | amp | pw | fm | drive, amount }` (cutoff in octaves, pitch in semitones)'],
      ['lfo1Shape / lfo2Shape', 'sine tri saw ramp square smooth sh'],
      ['subWave', "'sine' (default) or 'square' (the `sub` parameter's oscillator)"],
    ],
    presets: SYNTH_PRESETS,
    notes: ['Chords: `s.chords("Am | F")`, or notes in brackets `[A2,E3,A3]`. A slide `~` glides from the note right before it in `mode: \'mono\'` and `\'legato\'` (the lead presets); in the polyphonic default every note has its own voice and `~` does nothing.'],
  },
  {
    factory: 'sub',
    channel: 'sub',
    plays: 'notes',
    example: 's.sub(\'sub-sine\', { duck: 0.8 }).play(s.chords(\'Am | F | C | G\').roots({ low: 28 }), S.drop);',
    title: 'Sub bass',
    summary: 'A clean sine / triangle sub with optional harmonics and a pitch drop for 808 booms. Monophonic, with slides.',
    specs: SUB_SPECS,
    options: [],
    presets: SUB_PRESETS,
  },
  {
    factory: 'darkBass',
    channel: 'darkBass',
    plays: 'notes (mono)',
    example: 's.darkBass(\'darksynth-bass\', { duck: 0.8 }).play(s.notes(\'A1 A1 A1 A1 A1 A1 A1 A1 C2 C2 C2 C2 D2 D2 E2! E2\'), S.drop);',
    title: 'Darksynth bass',
    summary: 'Distorted rolling bass: a saw pair and a square into saturation, a resonant ladder filter that pops open on every note, a second saturation and a clean sub. The non-linear stages run at 2x oversampling.',
    specs: DARK_SPECS,
    options: [],
    presets: DARK_PRESETS,
    notes: ['Monophonic. `~` slides into the next note without retriggering the filter.'],
  },
  {
    factory: 'reese',
    channel: 'reese',
    plays: 'notes (mono)',
    example: 's.reese(\'reese\').play(s.notes(\'A1 - - - - - - - E1 - - - - - - -\'), S.drop);',
    title: 'Reese bass',
    summary: 'Detuned saws (three per side) that beat and swirl, a filter, saturation and a clean centred sub. Stereo.',
    specs: REESE_SPECS,
    options: [],
    presets: REESE_PRESETS,
    notes: [
      'For a rolling Goa / psytrance bass use the `rolling-bass` preset on `.xxx.xxx.xxx.xxx` with `duck: 1`: its notes are a sixteenth long. The other presets are made for held notes; on a sixteenth-note line their release (0.15 s) is longer than the step and the notes run into each other.',
      'It is stereo (`width` 0.8): a wide bass under a kick smears the low end, so keep `width` at 0.4 or less for a tight groove (`rolling-bass` does).',
    ],
  },
  {
    factory: 'growl',
    channel: 'growl',
    plays: 'notes (mono); held notes of a beat or more',
    example: 's.growl(\'dubstep-growl\').play(s.notes(\'A1:8 C2:8 | D2:8 A1:8\'), S.drop);',
    title: 'Growl / wobble bass',
    summary:
      'Dubstep bass: a saw pair and an FM oscillator through a wavefolder and saturation, two vowel (formant) band-pass filters and a 24 dB ladder, all moved by a tempo-synced LFO, plus a clean sub. Non-linear stages at 2x oversampling.',
    specs: GROWL_SPECS,
    options: [
      ['lfoShape', 'sine tri saw ramp square smooth sh'],
      ['lfoSync', "'note' (default: the wobble restarts at every note) or 'beat' (locked to the song's beat grid)"],
    ],
    presets: GROWL_PRESETS,
    notes: [
      'Play held notes of a beat or more. With `lfoSync: \'note\'` (the default) every note restarts the wobble, so a note shorter than one cycle never shows it: at `lfoRate` 1 that means notes shorter than a beat. For a rhythmic line of short notes use `lfoSync: \'beat\'`: the wobble then runs on the beat grid whatever the notes do, and the rests between notes cut it into pieces.',
      'Automate `lfoRate` (0.5 half notes, 1 quarters, 2 eighths, 4 sixteenths) for the classic speed-ups. Changing it while a note sounds bends the wobble\'s speed; the phase does not jump (put the change on a beat if you want it to line up).',
      'A note starts with the wobble at `lfoPhase` of its cycle: with a sine at 0 the filter is half open and opening; `lfoPhase` 0.75 starts closed and opens (the classic "wub" attack), 0.25 starts open and closes.',
      'The growl has a sub of its own (`sub`, 0.5). When you play a separate `s.sub` under it, set `sub: 0` on the growl (and `hp: 60` in its strip) so the two do not add up and beat. Its sweet spot is F1 to A2 (the `screech` preset: C3 to C4).',
      'A pitch dive: `pEnv` (up to 24 semitones either way) starts every new note that far above its pitch (below it, for a negative value) and settles into it within `pEnvTime` seconds, fast at first. The offset falls exponentially in semitones, half of it is gone after a seventh of the time and it is exactly gone when the time is up (a total, like the sidechain\'s `release`, not the time constant of the synth\'s and the sub\'s `pEnvTime`). `pEnv: 12, pEnvTime: 0.08` is the classic dive from an octave up in 80 ms. The growl\'s own sub dives with the rest, so the two never beat; a tied (`~`) note is not dived again, a note after a rest or a plain next note is. 0, the default, is off and changes nothing; automate `pEnv` to open a build with dives.',
    ],
  },
  {
    factory: 'acid',
    channel: 'acid',
    plays: 'notes (mono) with `!` and `~`',
    example: 's.acid(\'acid-303\').play(s.notes(\'A1 . A1 A2! . A1 . A1 C2~ . A1 A1 E2! . G1 A1~\'), S.drop); // ~ glides INTO C2 from the A1 right before it, and into the last A1 from G1',
    title: 'Acid bass (TB-303 style)',
    summary: 'A sawtooth / square into a resonant ladder filter (taken at the 18 dB point) with a decaying envelope, accents and slides, then overdrive.',
    specs: ACID_SPECS,
    options: [],
    presets: ACID_PRESETS,
    notes: [
      '`!` accents a note (louder, bigger sweep, builds up on consecutive accents). Automate `cutoff` upward over a build.',
      '`~` goes on the note you glide **into**, and that note must follow another note directly: `A1 C2~` glides from A1 up to C2 without retriggering (the filter envelope keeps running). After a rest (`A1 . C2~`) there is nothing to glide from: the mark does nothing and the arrangement listing says `slide(not tied)`.',
    ],
  },
  {
    factory: 'riser',
    channel: 'riser',
    plays: 'one hit whose length is the sweep',
    example: 's.riser(\'riser\').hit(S.drop.bar - 4, \'\', 1, 0, 16); // 16 beats: four bars of sweep',
    title: 'Riser / downlifter / whoosh',
    summary: 'Swept noise plus a rising (or falling) pitched tone. The length of the note or hit is the length of the sweep.',
    specs: RISER_SPECS,
    options: [['direction', "'up' (riser), 'down' (downlifter) or 'swell' (whoosh); presets set it"]],
    presets: RISER_PRESETS,
    notes: ['`riser.hit(bar, "", vel, 0, beats)` plays a sweep of `beats` beats; a note pattern works too (`s.notes("A3:16")` = one bar).'],
  },
  {
    factory: 'impact',
    channel: 'impact',
    plays: 'one hit',
    example: 's.impact(\'impact-deep\').hit(S.drop.bar, \'\', 1);',
    title: 'Impact',
    summary: 'A pitch-dropping sub boom, a low thump, a crack and a rumbling tail.',
    specs: IMPACT_SPECS,
    options: [],
    presets: IMPACT_PRESETS,
  },
  {
    factory: 'zap',
    channel: 'zap',
    plays: 'one hit',
    example: 's.zap(\'zap-fm\').hit(S.drop.bar - 0.25, \'\', 1);',
    title: 'Zap / siren',
    summary: 'Falling lasers, FM zaps, long pitch falls and sirens.',
    specs: ZAP_SPECS,
    options: [['wave', "'saw' (default), 'sine' or 'square'"]],
    presets: ZAP_PRESETS,
  },
  {
    factory: 'guitar',
    channel: 'guitar',
    plays: 'notes and chords (power chords, open chords)',
    example: 's.guitar(\'punk-guitar\').play(s.notes(\'[A2,E3,A3]{pm}:2 [A2,E3,A3]{pm}:2 [C3,G3,C4]!:4 [A2,E3,A3]:8\'), S.drop);',
    title: 'Electric guitar',
    summary:
      'Plucked-string waveguides (extended Karplus-Strong with pick position, a pickup comb, damping and palm muting), strummed chords, into an amp (noise gate, tight filter, screamer boost, three asymmetric gain stages at 2x oversampling, tone stack, sagging power amp) and a cabinet. Two takes, double-tracked hard left and right, by default.',
    specs: GUITAR_SPECS,
    options: [
      ['takes', '1 = one guitar (mono), 2 = a double-tracked pair hard left and right (default, stereo)'],
      ['cab', "'4x12' (default), '2x12', '1x12' or 'none'"],
      ['voices', 'strings that can sound at once per take (default 8)'],
      ['pan', 'default channel pan for a single take (the presets punk-guitar-L / -R use -1 / 1)'],
    ],
    presets: GUITAR_PRESETS,
    notes: [
      'Notes are MIDI pitches: a power chord is `[A2,E3,A3]` (or `guitarChord("A5")`), an open chord `guitarChord("Em")`. The strings of a chord start `strum` ms apart, low to high (high to low with `{up}`).',
      'Articulations: `{pm}` palm mute, `{ring}` let ring, `?` dead / ghost note, `!` accent, `~` slide up into the note, `{up}` up-stroke.',
    ],
  },
  {
    factory: 'bassGuitar',
    channel: 'bass',
    plays: 'notes (mono)',
    example: 's.bassGuitar(\'punk-bass\').play(s.notes(\'A1 A1 A1 A1 A1 A1 A1 A1 C2 C2 D2 D2 E2 E2 E2 E2\'), S.drop);',
    title: 'Bass guitar',
    summary: 'A plucked-string model (picked or fingered) through a bass amp with compression, overdrive and an 8x10 cabinet. Effectively monophonic.',
    specs: BASSG_SPECS,
    options: [['cab', "'bass-8x10' (default), 'bass-1x15' or 'none'"]],
    presets: BASSG_PRESETS,
    notes: ['`{pm}` palm mute, `?` ghost note, `~` slide, `{ring}` let ring.'],
  },
];

export interface FxDoc {
  name: string;
  /** A runnable example (uses `s`, `S` and `fx`; the tests execute every one). */
  example: string;
  summary: string;
  specs: ParamSpecs;
  options: [string, string][];
}

export const FX_CATALOG: FxDoc[] = [
  {
    name: 'drive',
    example: 's.darkBass(\'darksynth-bass\', { fx: [fx.drive({ mode: \'tube\', drive: 14 })] }).play(s.notes(\'A1:8 C2:8\'), S.drop);',
    summary: 'Waveshaper with 2x oversampling: soft (tanh), tube (asymmetric), hard clip or wavefolder, with tone and level. `fx.drive({ mode: "tube", drive: 14 })`.',
    specs: DRIVE_SPECS,
    options: [
      ['mode', "'soft' (default), 'tube', 'hard' or 'fold'"],
      ['oversample', 'false turns the 2x oversampling off (cheaper, a bit grittier)'],
    ],
  },
  {
    name: 'chorus',
    example: 's.synth(\'supersaw-pad\', { fx: [fx.chorus({ rate: 0.4, depth: 5 })] }).play(s.chords(\'Am\', { octave: 3 }), S.drop);',
    summary: 'Stereo chorus / flanger: modulated delay taps, a different modulation phase per side. Widens mono sources. `fx.chorus({ rate: 0.4, depth: 5 })`.',
    specs: CHORUS_SPECS,
    options: [['voices', 'delay taps per side (1-4, default 3)']],
  },
  {
    name: 'phaser',
    example: 's.synth(\'warm-pad\', { fx: [fx.phaser({ stages: 6, rate: 0.2 })] }).play(s.chords(\'Am\', { octave: 3 }), S.drop);',
    summary: 'All-pass phaser with feedback, offset sweeps per side. `fx.phaser({ stages: 6, rate: 0.2 })`.',
    specs: PHASER_SPECS,
    options: [['stages', 'all-pass stages per side (2-12, default 6)']],
  },
  {
    name: 'crusher',
    example: 's.synth(\'square-lead\', { fx: [fx.crusher({ bits: 8, rate: 4 })] }).play(s.notes(\'A4:8 E5:8\'), S.drop);',
    summary: 'Bit depth and sample-rate reduction (lo-fi, 8-bit). `fx.crusher({ bits: 8, rate: 4 })`.',
    specs: CRUSH_SPECS,
    options: [],
  },
  {
    name: 'widener',
    example: 's.synth(\'supersaw-pad\', { fx: [fx.widener({ width: 1.5 })] }).play(s.chords(\'Am\', { octave: 3 }), S.drop);',
    summary: 'Mid/side stereo width with a mono-below corner that keeps the lows centred. `fx.widener({ width: 1.5 })`.',
    specs: WIDEN_SPECS,
    options: [],
  },
  {
    name: 'gate',
    example: 's.synth(\'supersaw-pad\', { fx: [fx.gate({ pattern: \'x.xx.x.x\', res: 4 })] }).play(s.chords(\'Am\', { octave: 3 }), S.drop);',
    summary: 'Rhythmic (trance) gate locked to the song position: a step pattern chops the channel. `fx.gate({ pattern: "x.xx.x.x", res: 4 })`.',
    specs: GATE_SPECS,
    options: [
      ['pattern', "required: one character per step: 'x' open, '.' (or '-' or '0') closed, digits 1-9 partial (9 almost open); spaces and | are ignored. The pattern repeats on its own length, counted from the start of the song, so 16 steps at the default resolution is one bar and 8 steps is two beats"],
      ['res', 'steps per beat (4 = sixteenths, the default)'],
    ],
  },
  {
    name: 'pump',
    example: 's.synth(\'supersaw-chord\', { fx: [fx.pump({ pattern: \'x...x...x...x...\', depth: 0.8, release: 0.3 })] }).play(s.chords(\'Am | F\', { octave: 3 }), S.drop);',
    summary:
      'A tempo-locked pump on one channel: a duck with the shape of the sidechain (attack, hold, release, curve) that starts on the steps of a pattern instead of on the kick, so chords can pump on their own rhythm while the sub follows the kick. `fx.pump({ pattern: "x...x...x...x...", depth: 0.8 })`.',
    specs: PUMP_SPECS,
    options: [
      [
        'pattern',
        "one character per step: 'x' (or 'X') a full duck, '.' (or '-' or '0') none, digits 1-9 a duck of that part of the depth (9 = full); spaces and bar lines are ignored. The default is a duck on every beat of a 4/4 bar, 'x...x...x...x...'. Like the gate it repeats on its own length, counted from the start of the song, so 16 steps at the default resolution is one bar, and a pattern written as two bars is 32 steps",
      ],
      ['res', 'steps per beat (4 = sixteenths, the default)'],
    ],
  },
  {
    name: 'filter',
    example: 's.synth(\'saw-lead\', { fx: [fx.filter({ mode: \'lp\', cutoff: 800, lfoRate: 0.5, lfoDepth: 2 })] }).play(s.notes(\'A3:8 E3:8\'), S.drop);',
    summary: 'Low-pass / high-pass / band-pass / notch with a tempo-locked LFO for sweeps and wobbles. `fx.filter({ mode: "lp", cutoff: 800, lfoRate: 0.5, lfoDepth: 2 })`.',
    specs: FILTER_SPECS,
    options: [
      ['mode', "'lp' (default), 'hp', 'bp' or 'notch'"],
      ['shape', "LFO shape: 'sine' (default), 'tri', 'saw', 'ramp' or 'square'"],
    ],
  },
  {
    name: 'delay',
    example: 's.synth(\'pluck\', { fx: [fx.delay({ time: \'1/8.\', feedback: 0.4 })] }).play(s.notes(\'A4 . . . . . . . E5 . . . . . . .\'), S.drop);',
    summary: 'Tempo-synced ping-pong delay as an insert (the song-wide delay is a send: see Sends). `fx.delay({ time: 0.75, feedback: 0.4 })`.',
    specs: DELAY_SPECS,
    options: [['time', "also accepts a note division such as '1/8.' or '1/4t'"]],
  },
  {
    name: 'reverb',
    example: 's.snare(\'darksynth-snare\', { fx: [fx.reverb({ gated: true })] }).play(s.hits(\'....X.......X...\'), S.drop);',
    summary: 'Reverb as an insert, or the 80s gated reverb. `fx.reverb({ gated: true })` on a snare is the classic big snare.',
    specs: REVERB_FX_SPECS,
    options: [['gated', 'true: the tail is cut off by a gate keyed from the dry signal']],
  },
  {
    name: 'amp',
    example: 's.synth(\'saw-lead\', { fx: [fx.amp({ gain: 0.8, cab: \'4x12\' })] }).play(s.notes(\'A3:8 E3:8\'), S.drop);',
    summary: 'The guitar amp and cabinet on any channel (a synth lead, a bass, a drum loop). `fx.amp({ gain: 0.8, cab: "4x12" })`.',
    specs: AMP_SPECS,
    options: [['cab', "'4x12' (default), '2x12', '1x12', 'bass-8x10', 'bass-1x15' or 'none'"]],
  },
];

export interface MixerDoc {
  id: string;
  title: string;
  path: string;
  specs: ParamSpecs;
}

export const MIXER_CATALOG: MixerDoc[] = [
  { id: 'strip', title: 'Channel strip', path: '`<channel>.mix.<param>`, e.g. `bass.mix.gain`', specs: STRIP_SPECS },
  { id: 'master', title: 'Master', path: '`master.<param>`', specs: MASTER_SPECS },
  { id: 'reverb', title: 'Shared reverb', path: '`reverb.<param>`', specs: REVERB_RETURN_SPECS },
  { id: 'delay', title: 'Shared delay', path: '`delay.<param>`', specs: DELAY_RETURN_SPECS },
  { id: 'duck', title: 'Sidechain', path: '`duck.<param>`', specs: DUCK_SPECS },
];

// ── markdown helpers ─────────────────────────────────────────────────────────

const fmt = (x: number): string => (Number.isInteger(x) ? String(x) : String(Number(x.toPrecision(4))));

/** Markdown table of a parameter set: name, default, range, unit, what it does. */
export function specTable(specs: ParamSpecs): string {
  const rows = Object.entries(specs).map(([k, v]) => `| \`${k}\` | ${fmt(v.default)} | ${fmt(v.min)} .. ${fmt(v.max)} | ${v.unit ?? ''} | ${v.doc.replace(/\|/g, '/')} |`);
  return ['| parameter | default | range | unit | what it does |', '|---|---|---|---|---|', ...rows].join('\n');
}

/** The settings a preset changes from the instrument's defaults, as short text (the calibration trim `level` is left out). */
export function presetSettings(opts: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(opts)) {
    if (k === 'level') continue;
    if (k === 'layers' && Array.isArray(v)) {
      parts.push(`layers ${v.map((l: { wave?: string; unison?: number; octave?: number }) => `${l.wave ?? '?'}${l.unison && l.unison > 1 ? `x${l.unison}` : ''}${l.octave ? `(${l.octave > 0 ? '+' : ''}${l.octave} oct)` : ''}`).join(' + ')}`);
    } else if (Array.isArray(v)) parts.push(`${k} (${v.length})`);
    else if (v !== null && typeof v === 'object') parts.push(`${k} {...}`);
    else parts.push(`${k} ${typeof v === 'number' ? fmt(v) : String(v)}`);
  }
  return parts.join(', ');
}

export function presetTable(presets: Record<string, PresetDef>): string {
  const rows = Object.entries(presets).map(([k, v]) => `| \`${k}\` | ${v.doc.replace(/\|/g, '/')} | ${presetSettings(v.opts).replace(/\|/g, '/')} |`);
  return ['| preset | what it is for | its settings (the rest are the defaults) |', '|---|---|---|', ...rows].join('\n');
}

export function optionTable(options: [string, string][]): string {
  const rows = options.map(([k, v]) => `| \`${k}\` | ${v.replace(/\|/g, '/')} |`);
  return ['| option | meaning |', '|---|---|', ...rows].join('\n');
}

/** The generated README section of one instrument (heading excluded). */
export function instrumentSection(d: InstrumentDoc): string {
  const out: string[] = [d.summary, ''];
  if (d.parts) out.push(`Parts: ${d.parts.map((p) => `\`${p}\``).join(', ')}.`, '');
  out.push('Example (`S.drop` is a section declared with `s.sections({ ... })`):', '', '```ts', d.example, '```', '');
  if (d.notes) out.push(...d.notes.map((n) => `- ${n}`), '');
  if (d.options.length) out.push(optionTable(d.options), '');
  if (Object.keys(d.specs).length) out.push('Parameters (all automatable; also usable as options):', '', specTable(d.specs), '');
  if (Object.keys(d.presets).length) out.push('Presets:', '', presetTable(d.presets), '');
  return out.join('\n').trimEnd();
}

export function describe(): { instruments: string[]; mixer: string[] } {
  return { instruments: CATALOG.map((c) => c.factory), mixer: MIXER_CATALOG.map((m) => m.id) };
}

// ── README generation ────────────────────────────────────────────────────────

/** The sources the README embeds: `example` is the worked example track, `custom` the custom instrument and effect. */
export type ReadmeSources = Record<string, string>;

/** The first sentence of a summary (up to a full stop followed by a space or the end), with its full stop. */
export function firstSentence(text: string): string {
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(text);
  return m ? m[0] : text;
}

/** The generated section for one `<!-- gen:kind:id -->` marker. */
function generated(kind: string, id: string | undefined, sources: ReadmeSources): string {
  switch (kind) {
    case 'instrument': {
      const d = CATALOG.find((c) => c.factory === id);
      if (!d) throw new Error(`README marker: no instrument "${id}"`);
      return instrumentSection(d);
    }
    case 'fx': {
      const d = FX_CATALOG.find((c) => c.name === id);
      if (!d) throw new Error(`README marker: no effect "${id}"`);
      return [d.summary, '', 'Example:', '', '```ts', d.example, '```', '', ...(d.options.length ? [optionTable(d.options), ''] : []), specTable(d.specs)].join('\n');
    }
    case 'mixer': {
      const d = MIXER_CATALOG.find((c) => c.id === id);
      if (!d) throw new Error(`README marker: no mixer section "${id}"`);
      return [`Automation path: ${d.path}.`, '', specTable(d.specs)].join('\n');
    }
    case 'instruments':
      return ['| factory | channel name | you write | what it is |', '|---|---|---|---|', ...CATALOG.map((c) => `| \`s.${c.factory}(...)\` | \`${c.channel}\` | ${c.plays} | ${firstSentence(c.summary).replace(/\|/g, '/')} |`)].join('\n');
    case 'example':
    case 'file': {
      const key = kind === 'example' ? 'example' : (id ?? '');
      const src = sources[key];
      if (src === undefined) throw new Error(`README marker: no source file "${key}" (known: ${Object.keys(sources).join(', ')})`);
      return ['```ts', src.trimEnd(), '```'].join('\n');
    }
    default:
      throw new Error(`README marker: unknown kind "${kind}"`);
  }
}

/** Regenerates every `<!-- gen:... -->` block of the README from the catalogue and the embedded source files. */
export function fillReadme(readme: string, sources: ReadmeSources): string {
  return readme.replace(/<!-- gen:([a-z]+)(?::([A-Za-z0-9_-]+))? -->[\s\S]*?<!-- \/gen -->/g, (_m, kind: string, id: string | undefined) => {
    return `<!-- gen:${kind}${id ? `:${id}` : ''} -->\n${generated(kind, id, sources)}\n<!-- /gen -->`;
  });
}
