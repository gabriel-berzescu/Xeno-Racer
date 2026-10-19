# Xeno-Racer album engine: the composer's guide

The album is Xeno-Racer's own race music: instrumental, composed in code, synthesised sample by sample. No samples, no network,
no Web Audio. A track is one TypeScript file in `tracks/` that describes the music with data and a little code; the engine
renders it to stereo audio, deterministically (the same track gives the same samples every time), as a stream (block by block;
any block size gives the same samples), mastered to about -14 LUFS with a true-peak limiter.

Nobody can listen while composing here, so this guide also explains how to check a track with numbers and pictures (section 12).
Read sections 1-6 and 8 before writing; use 7 (the instruments) and 9 (the effects) as a reference, 10 for transitions and 14 for
genre starting points.

1. Quick start. 2. Time, bars and keys. 3. Patterns. 4. Chords, arps and bass lines. 5. Groove. 6. The arrangement and automation.
7. Instruments (overview). 8. The mixer. 9. Effects (overview). 10. Transitions and fills. 11. Your own sounds. 12. Checking your work.
13. CPU budget. 14. Genre starting points. 15. Honest notes on the instruments. 16. Adding the track to the album.
Reference A: every instrument's parameters and presets. Reference B: every effect's parameters.

**The ten things to know**

1. Bars count from 0; lengths and delay times are in beats (quarter notes).
2. A pattern is text on a sixteenth-note grid: `.` rest, `-` hold, `!` accent, `~` slide, `[A2,E3]` chord, `|` bar line (checked: the parser says
   when a bar has the wrong number of steps).
3. `channel.play(pattern, S.drop)` places a pattern and loops it to fill the section. Declare sections with `s.sections({ ... })`: the probe reports
   per section.
4. `s.drums({ kick: 'x...', snare: '....' })` for kits, `s.hits('x...')` for a single drum, `s.notes(...)` / `s.chords(...)` for everything pitched.
5. Every kick keys the sidechain: give basses, pads and chords `duck: 0.7` to `1` in their strip so that the kick punches through.
6. Every preset starts at a similar loudness at `gain: 0`. Set the channel gains (roughly -3 to -14 dB) so that nothing dominates, and set
   `s.setMaster({ trim })` last, until the probe says about -14 LUFS with the true peak at or below -1 dBTP.
7. Any parameter can be automated by name: `bass.ramp('cutoff', 0, 16, 300, 4000, 'exp')`, `bass.lfo('cutoff', { period: '1/8', depth: 1 })`.
8. You cannot listen: render with the probe, read the section table, open the spectrogram.
9. Be deterministic: no `Math.random()`, no clock (use `s.rng`).
10. The project's `npx tsc --noEmit` type-checks track files (vitest does not): run it before you finish. Mind the CPU: dense tracks render at 12-17x
    real time, 10x is the floor.

## 1. Quick start

Create `src/audio/album/tracks/<id>.ts`: the file name is the track id, and `id` in `defineTrack` must be the same. Everything you
need is imported from `../song`. This is the worked example, `sandbox/album/example-track.ts` (a test renders it, so it always works),
shown with the import it needs inside `tracks/`: copy it there and change the `id`.

<!-- gen:example -->
```ts
// The worked example of src/audio/album/README.md (the README embeds this file; tests/album-engine.test.ts renders it).
import { defineTrack, fx, guitarChord } from '../song';

export default defineTrack({ id: 'example', title: 'Worked Example', genre: 'Test', bpm: 126, bars: 24, tail: 3 }, (s) => {
  s.key('A', 'minor');
  const S = s.sections({ intro: 4, groove: 8, drop: 8, outro: 4 });
  const prog = 'Am | F | C | G'; // one chord per bar

  // ── instruments: every factory returns a channel; the second argument is its mixer strip ──
  const kick = s.kick('darksynth-kick', { gain: -3 }); // kicks key the sidechain by default
  const kit = s.drumKit({ snare: 'darksynth-snare', hat: { preset: 'closed-hat', pan: 0.2, gain: -6 }, crash: { preset: 'crash', gain: -8 } }, { gain: -4, reverb: 0.1 });
  const bass = s.darkBass('darksynth-bass', { gain: -6, duck: 0.8 });
  const pad = s.synth('supersaw-pad', { gain: -10, reverb: 0.3, duck: 0.7, fx: [fx.chorus()] });
  const arp = s.synth('dark-pluck', { gain: -9, reverb: 0.15, delay: 0.3 });
  const lead = s.synth('supersaw-lead', { gain: -9, reverb: 0.25, delay: 0.25 });
  const riser = s.riser('riser', { gain: -12 });

  // ── patterns: text on a 16th-note grid (| = bar line, . = rest, - = hold, ! accent, ~ slide) ──
  const four = s.hits('X...X...X...X...');
  const beat = s.drums({ snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.xo', crash: 'X...............' });
  const chords = s.chords(prog, { octave: 3, lead: true }); // voice-led chord notes, one bar each
  const roots = chords.roots({ rhythm: 'x.xxx.xxx.xxx.xx', low: 33 }); // bass on the chord roots
  const hook = s.notes('A4 . . C5 . . E5 - D5~ - E5 - A5 - - - | G5 . . E5 . . D5 . C5 - - - A4 - - -');

  // ── arrangement: place patterns on the bar timeline (a Section works as the position) ──
  pad.play(chords, S.intro.bar, S.intro.bars + S.groove.bars + S.drop.bars + S.outro.bars);
  arp.play(s.arp(chords, { order: 'updown', octaves: 2 }), S.intro.bar, S.intro.bars);
  arp.play(s.arp(chords, { order: 'up', octaves: 2, mask: 'xxx.xxx.xxxxxxx.' }), S.groove.bar, S.groove.bars + S.drop.bars);
  kick.play(four, S.groove.bar, S.groove.bars + S.drop.bars);
  kit.play(beat, S.groove.bar, S.groove.bars + S.drop.bars);
  bass.play(roots, S.groove.bar, S.groove.bars + S.drop.bars);
  lead.play(hook, S.drop.bar, S.drop.bars, { vel: 0.9 });
  riser.hit(S.drop.bar - 2, '', 1, 0, 8); // a riser: the hit length (8 beats) is the sweep length

  // ── automation and mixing: any parameter, by path ──
  arp.ramp('cutoff', S.intro.bar, S.intro.end, 500, arp.param('cutoff'), 'exp'); // filter opens over the intro, to the preset's own cutoff
  bass.lfo('cutoff', { period: '1/2', depth: 0.6, mode: 'exp', from: S.drop.bar, to: S.outro.bar }); // slow tempo-synced wobble
  s.auto('master.trim', [[0, 2.0], [S.outro.bar, 2.0], [S.outro.end, -3]]); // 2 dB brings the probe's reading to about -14 LUFS; -3 fades the outro
  s.setReverb({ time: 2.6, return: -9 });
  s.setDelay({ time: '1/8.', feedback: 0.4 });
  s.setSidechain({ release: 0.2 });

  // guitar chords from a fingering helper, for the outro
  const gtr = s.guitar('crunch-guitar', { gain: -12, reverb: 0.08 });
  gtr.play(s.pattern(4).chord(0, guitarChord('Am'), 4, 0.8).chord(4, guitarChord('F'), 4, 0.8).chord(8, guitarChord('C'), 4, 0.8).chord(12, guitarChord('G'), 4, 0.8).done(), S.outro.bar, S.outro.bars);
});
```
<!-- /gen -->

What happens: `defineTrack(meta, compose)` registers the track (it shows up in `ALBUM` as soon as the file exists, there is no list to
edit); `compose(s)` runs when a renderer is created. Every instrument factory (`s.kick`, `s.synth`, ...) returns a *channel*;
patterns are text on a step grid; `channel.play(pattern, bar, bars)` puts a pattern on the timeline; `auto`, `ramp` and `lfo` move
any parameter over time.

Render it and read the numbers (writes `previews/album/<id>.wav`, 48 kHz 16-bit, plus a report next to it):

```
ALBUM=1 ONLY=my-track AUTOTRIM=1 SPEC=1 npx vitest run tests/probes/album-render.test.ts
```

`AUTOTRIM=1` finds the master trim that gives -14 LUFS and prints the line to write; `SPEC=1` also writes a spectrogram PNG (section 12 explains
the report). Without them the probe just renders and reports. More switches, all in section 12: `CLASH=1` (the harmony check: wrong notes between parts), `BANDS=1` (which channel owns which frequency band),
`SOLO=acid,bass` (render only those channels) and `BARS=16-24` (zoom the spectrogram into those bars). `TRACK=path/to/file.ts` (instead of `ONLY`)
probes a track file that is not in the album; it imports the engine by a path that resolves from where it lies (as the files in
`sandbox/album/examples/` do), and the probe writes `previews/album/<id>.*` for it as for any track.

That is Git Bash syntax. In PowerShell the variables are set first and stay set for the rest of the session, so clear them afterwards:

```
$env:ALBUM='1'; $env:ONLY='my-track'; $env:AUTOTRIM='1'; $env:SPEC='1'; npx vitest run tests/probes/album-render.test.ts
Remove-Item Env:ALBUM, Env:ONLY, Env:AUTOTRIM, Env:SPEC
```

Four complete tracks written by following this guide are in `sandbox/album/examples/` (each probes at -14 LUFS; read them next to this guide):
`darksynth.ts` (synths, drums, a snare roll and riser into the drop, a custom patch, a pad high-pass and a wobble), `punk.ts` (acoustic kit, two
single-take guitars hard left and right, bass guitar, a lead, stops before the choruses, amp-gain automation), `goa.ts` (the rolling bass, a 303 line
with slides, a trance-gated pad, a break with a riser, a master fade-out) and `dubstep.ts` (half-time drums, voice-led supersaw chords, a growl over
its own sub, a build with risers, a music-bus filter, two drops and an ending).

Files in this folder: `index.ts` (the contract with the player: `ALBUM`, `createTrackRenderer`), `song.ts` (the composer API: what
you import), `pattern.ts` and `theory.ts` (notation, chords, scales), `instruments/` (the sounds), `fx.ts` (insert effects),
`mixer.ts` (strips, sends, sidechain, master), `engine.ts` (the streaming renderer), `dsp/` (building blocks), `measure.ts`
(loudness), `catalog.ts` (the data behind the tables below), `sound-check.ts` (a track that plays every instrument in turn), `tracks/` (the
album's songs: every file there is in the album; `tracks/sound-check.ts` only re-exports the Sound Check, delete that file to take it out).

## 2. Time, bars and keys

- **Bars are counted from 0** and may be fractional: bar 0 is the first bar, `7.5` is halfway through bar 7. The section helpers
  hand you the numbers (`S.drop.bar`, `S.drop.bars`, `S.drop.end`).
- **Lengths and delay times are in beats** (quarter notes). A 4/4 bar is 4 beats. `meta.signature: [7, 8]` gives 3.5-beat bars.
- `meta.bars` is the length of the arrangement. The track lasts `bars` bars plus `meta.tail` seconds (default 3) for the reverb and
  delay to ring out; the last `meta.fadeOut` seconds (default: the tail, at most 2.5) fade to silence, and the first sample is
  exactly 0. `ALBUM[i].seconds` is computed from the meta without running your code, and the renderer's `frames` is
  `Math.round(seconds * sampleRate)` for any sample rate (44100 and 48000 are tested).
- One tempo per track (`meta.bpm`, quarter notes per minute). Use the half-time *feel* (a snare on beat 3) rather than a tempo
  change for half-time sections.
- Everything random is seeded: `s.rng.next()` gives deterministic numbers (0..1) and `s.rng.fork('name')` an independent stream.
  Never use `Math.random()` or the clock: the same track must render the same samples every time.
- The key is optional but unlocks `s.degrees(...)`, `s.degree(...)`: `s.key('E', 'phrygian dominant')`. Scales: major, minor, dorian,
  phrygian, lydian, mixolydian, locrian, harmonic minor, melodic minor, phrygian dominant, double harmonic, hungarian minor,
  whole tone, pentatonic major, pentatonic minor, blues, chromatic (aliases: ionian, aeolian, natural minor, harmonic, melodic,
  spanish, hijaz, freygish, arabic, byzantine, minor pentatonic, major pentatonic). Call `s.key()` again to modulate: a pattern uses
  the key that was current when you wrote it.
- `compose(s)` runs once when the renderer is built: keep it cheap (plain loops over a few thousand notes are fine).

## 3. Patterns

A pattern is notes and hits positioned in beats, written as text on a **step grid**. The default resolution is 4 steps per beat
(sixteenth notes); pass `{ res: 2 }` for eighths, `{ res: 8 }` for thirty-seconds, `{ res: 3 }` / `{ res: 6 }` for eighth / sixteenth
triplets. Tokens are separated by spaces. `|` marks bar lines: optional, but when present every bar must have exactly the right
number of steps (the parser tells you which bar is off and by how much). A pattern may be any whole number of beats long.

Code blocks marked `ts run` in this guide are executed by the test-suite, so they are known to work.

### Notes: `s.notes(text, opts?)`

| token | meaning |
|---|---|
| `A2` `C#3` `Bb1` | a note: name + octave (middle C is `C4`, A4 = 440 Hz; a bass guitar's low E is `E1`, a guitar's is `E2`) |
| `.` | rest (one step) |
| `-` | hold: extends the previous note by one step (also across a bar line) |
| `[A2,E3,A3]` | a chord (simultaneous notes, no spaces needed inside the brackets). Every modifier below goes after the note or the closing bracket |
| `!` after a note or a chord | accent: velocity 1 and the accent flag (louder; a bigger filter sweep on the acid bass) |
| `?` after a note or a chord | ghost note: quiet; on a guitar a muted scratch (`[E2,B2,E3]?`) |
| `~` | slide **into** this note from the previous one (a legato glide without retrigger). Put it on the note you arrive at, and that note must follow another note **directly**: `A1 C2~` glides from A1 up to C2, but `A1 . C2~` has nothing to glide from and the mark does nothing (the probe's listing counts it as `slide(not tied)` and warns). On a guitar and a bass guitar it is a quick scoop up into the note (from 2 / 1 semitones below, in about 60 / 50 ms) and needs no previous note |
| `'` | staccato (40 % of the step) |
| `:N` | length in steps: `A2:4` is the same as `A2 - - -` (the note occupies N steps; `A2:0.5` is half a step) |
| `@N` | velocity: `@80` is MIDI velocity 80 of 127; values up to 1 are fractions (`@0.6`) |
| `{name}` | articulation(s), comma separated: `pm` (palm mute), `ring` (let ring), `up` (up-stroke), `open`, `rim`, `flam`, `ghost`, `accent`, `slide`, `stac` |

Modifiers can come in any order: `A2!~:2@100{pm}`. Options: `vel` (default 0.8), `gate` (default 0.9: a note sounds 90 % of its
steps so that consecutive notes re-articulate), `art` (articulation(s) for every note), `res`, `free: true` (allow odd lengths and bars
of different lengths).

```ts run
const riff = s.notes('A1 . A1 A1 . A1 C2 . | A1 . A1 A1 . E2! D2~ -', { res: 2 }); // an eighth-note grid: 8 steps per bar
const wall = s.notes('[E2,B2,E3]{pm} [E2,B2,E3]{pm} [G2,D3,G3]! . [A2,E3,A3]{ring}:4'); // chords, articulations, a 4-step note
bass.play(riff, S.verse);
gtr.play(wall, S.verse);
```

### Drums: `s.drums({ lane: 'text' })` and `s.hits('text')`

One character per step; spaces and `|` are ignored; all lanes must have the same length. Lane names are the part names of the
instrument (`kick`, `snare`, `hat`, `crash` ...: see each drum below). `s.hits(...)` is a single lane for a one-sound instrument (a
kick, a snare, a clap, a riser ...).

| char | hit |
|---|---|
| `x` | normal (velocity 0.8) |
| `X` | accent (1.0) |
| `g` | ghost (0.4) |
| `1`-`9` | velocity 1/9 .. 9/9 |
| `o` / `O` | open (the open hat; `O` is an accented one) |
| `r` / `R` | rim shot / cross-stick (snare), accented |
| `f` | flam |
| `m` | muted: a cymbal hit that is choked right away (a hand on the cymbal), a kick with a softer click |
| `.` `-` `_` `0` | rest |

```ts run
const beat = s.drums({ kick: 'X...x...X...x.x.', snare: '....X.......X..g', hat: 'x.x.x.x.x.x.x.xo' });
const roll = s.drums({ snare: '1234567899999999' }); // a roll: velocity 1/9 rising to 9/9
kit.play(beat, S.verse);
kit.play(roll, S.verse.end - 1); // the last bar of the verse
kick.play(s.hits('x..x..x.x..x..x.'), S.drop);
kit.play(s.drums({ kick: s.euclid(5, 16), hat: 'xxxxxxxxxxxxxxxx' }), S.drop); // euclid(5, 16) = 'x..x..x..x..x...'
```

`s.euclid(hits, steps, rotate?)` spreads `hits` as evenly as possible over `steps` (Bjorklund): `(3, 8)` = `x..x..x.`, `(5, 8)` = `x.xx.xx.`,
`(7, 16)` = `x..x.x.x..x.x.x.`; `rotate` moves the pattern later by that many steps.

### Scale degrees: `s.degrees(text, { oct })`

Like `notes` but the tokens are degrees of the current key: `1`..`7` (`8` is the octave), a `b` or `#` prefix (`#7` is the raised seventh
of the harmonic minor), a `+` / `-` suffix to move an octave up or down, and all the modifiers above. `oct` is the octave of the tonic
(default 3).

```ts run
const line = s.degrees('1 . 3 5+ #7 . 5 3', { oct: 3 }); // in A minor: A3 . C4 E5 G#4 . E4 C4 (the degrees follow the key)
lead.play(line, S.drop);
```

### Building patterns in code

```ts run
const fillBar = s.pattern(1); // a one-bar builder: times in beats
fillBar.hit(2, 'snare', 0.8).hit(3, 'snare', 0.9).hit(3.5, 'snare', 1).hit(3.75, 'crash', 1); // beat, part, velocity, flags
kit.play(fillBar.done(), S.drop.end - 1);
const run = s.pattern(1);
for (let i = 0; i < 8; i++) run.note(i * 0.5, s.degree(1 + (i % 4) * 2, 3), 0.45, 0.6 + 0.05 * i); // beat, note, length, velocity, flags
lead.play(run.done(), S.drop.bar + 4);
```

`.note(beat, note, length, vel, flags)` takes a MIDI number or a name; `.chord(beat, notes, length, vel, flags)` several notes at once.

### Transforming patterns

Patterns are immutable values: every transform returns a new pattern. `transpose(n)`, `octave(n)`, `vel(factor | fn)`, `velTo(v)`,
`rotate(beats)`, `rev()`, `repeat(n)`, `then(...)`, `and(...)` (layer), `over(beats)` (loop or trim), `slice(from, to)` (both in beats), `gate(f)`,
`legato(gap?)`, `art('pm')`, `only('kick', ...)`, `without('hat', ...)`, `rename({ hat: 'hatC' })`, `scaleTime(0.5)` (twice as fast),
`filter(fn)`, `map(fn)`, `strum(beats, up?)`, `show()` (prints the notes: section 4). `rev()` mirrors on the step grid: a reversed sixteenth line stays on the grid.

```ts run
const up = riff.transpose(5).vel(0.8).rotate(0.5); // the originals stay as they were
const twice = riff.then(up); // back to back
const bones = beat.without('hat').only('kick', 'snare');
bass.play(twice, S.drop);
```

Loops in plain TypeScript are fine: `for (let b = 0; b < 8; b++) ch.play(b % 4 === 3 ? fill : groove, bar + b, 1)`.

## 4. Chords, arps and bass lines

`s.chords(text, opts?)` takes chord symbols: `Am F C G` is one chord per bar; `Am F | C G` puts two chords in each bar (a bar is split
equally between its chords); `Am . . F` continues a chord with `.`; `%` repeats the previous bar. Symbols: `Am`, `F#m7`, `Cmaj7`,
`G7`, `Bdim`, `Dsus4`, `E5` (power chord), `Am9`, `Gadd9`, `D7b9`, `Fmaj7#11`, `C/E` (slash bass), `Bm7b5`, `Caug`, `C6`, `G7sus4`, ...
Options: `octave` (of the root, default 3), `inversion`, `spread` ('close' | 'open' | 'drop2' | 'wide' | 'power'), `bass` (add the bass
note below), `range: [lo, hi]` (shift the voicing into a register), `add: [semitones]`, `lead: true` (smooth voice leading: each chord
picks the inversion nearest to the previous one), `vel`, `gate`, `strum` (beats between the notes).

The result is a pattern whose notes are the chords. It also remembers the chord segments, so `rhythm`, `arp` and `roots` can work on them:

```ts run
const prog = s.chords('Am | F | C | G', { octave: 3, lead: true }); // one chord per bar, smooth voice leading
pad.play(prog, S.verse); // plain sustained chords
stab.play(prog.rhythm('x..x..x.x..x..x.'), S.drop); // the chord re-struck on a rhythm (restarts at each chord)
arp.play(s.arp(prog, { order: 'updown', octaves: 2, res: 4 }), S.drop); // an arpeggio
bass.play(prog.roots({ rhythm: 'x.xxx.xxx.xxx.xx', low: 33 }), S.drop); // the chord roots as a bass line
const rich = s.chords('Am9 | Fmaj7#11 | C/E | G7sus4', { octave: 2, spread: 'open', bass: true, range: [40, 76] });
pad.play(rich, S.outro);
```

`arp` options: `res` (steps per beat, default 4), `order` (`up down updown downup converge diverge random asplayed`, or a list of indices),
`octaves` (default 1), `gate`, `vel`, `mask` (`'xxx.xx..'`: only the x steps play), `accent` (`'x...'`: accent those steps). `rhythm` and `roots`
take the same step characters as drum lanes (`x X g . 1-9`) and `{ res, gate, vel }`; a rhythm shorter than the chord loops inside it (an 8-step
rhythm on a 16-step bar plays twice). `roots` also takes `low`: each root goes into the octave that starts at that MIDI note, so `low: 28` gives
roots from E1 to D#2 and `low: 33` from A1 to G#2. Without a `rhythm`, `roots()` plays one long note per chord (90 % of its length); with one, each
hit lasts until the next hit (also x 0.9), or `len` steps when you give it (never past the next hit: `len: 1` keeps a roll's notes inside their sixteenths).
Other helpers on `s`: `s.note('A2')` (MIDI number), `s.chordNotes('Am7', { octave: 3 })`, `s.degree(5, 3)` (MIDI note of a scale degree),
and `guitarChord('Em')` / `guitarChord('A5')` (playable guitar voicings as MIDI notes).

**Looking at a pattern.** Any pattern can print itself: `process.stdout.write(prog.show() + '\n')` lists every onset with its bar and beat (counted
from 1 inside the pattern), the note names (with flats when a chord symbol has a flat root), the length in beats, the velocity and the
articulations. It is how you check a voicing, the register of `roots`, a transposition or a rhythm without rendering. For
`s.chords('Fm | Db | Ab | Eb', { octave: 3, lead: true })` it prints:

```
Pattern(12 events, 16 beats), 4 bars of 4 beats
bar 1 beat 1      F3 Ab3 C4             len 3.92      vel 0.8
bar 2 beat 1      F3 Ab3 Db4            len 3.92      vel 0.8
bar 3 beat 1      Eb3 Ab3 C4            len 3.92      vel 0.8
bar 4 beat 1      Eb3 G3 Bb3            len 3.92      vel 0.8
```

## 5. Groove

- `s.groove({ swing, unit, push, humanize })` sets the song-wide groove; `ch.groove({...})` overrides parts of it for one channel; a clip can
  override swing and humanize with `play(..., { swing, humanize })`. They apply to the clips placed *after* the call, and a new call to
  `s.groove` (or `ch.groove`) replaces the previous one.
- `swing`: where the second of each pair of subdivisions falls: 0.5 straight, 0.58 light, 0.667 triplet shuffle. `unit` is the
  subdivision that swings, in beats (0.5 = eighths, the default; 0.25 = sixteenths).
- `push` (ms): shifts a whole channel late (+) or early (-): a laid-back snare is `+8`, a driving hat `-4`.
- `humanize: { time: ms, vel: fraction }`: seeded random timing and velocity variation (leave it off for tight electronic parts).
- Per-note feel: velocity (`@`, `!`, `?`, `.vel()`), articulation, and `offset` (beats) in `play` for pickups and flams.

```ts run
s.groove({ swing: 0.58, unit: 0.25 }); // light sixteenth-note swing for everything placed from here on
kit.groove({ push: 4 }); // the kit sits a little behind
gtr.groove({ humanize: { time: 6, vel: 0.1 } }); // a human feel on the guitars
bass.play(riff, S.outro, undefined, { swing: 0.66 }); // this clip shuffles harder
```

## 6. The arrangement and automation

```ts run
lead.play(line, S.drop); // a Section as the position: the whole section; the pattern loops to fill it
lead.play(line, 40, 8); // bar 40, 8 bars (a pattern shorter than that loops, a longer one is cut)
bass.play(riff, 44); // once, rounded up to whole bars
gtr.play(wall, S.drop, undefined, { vel: 0.8, transpose: -2, offset: -0.25, gate: 0.8, from: 1, art: 'pm', humanize: { time: 6, vel: 0.1 } });
bass.note(30, 'A1', 2, 0.9); // one note: bar, note, length in beats, velocity, flags
kit.hit(31, 'crash', 1); // one hit: bar, part, velocity
riser.hit(S.drop.bar - 2, '', 1, 0, 8); // a one-shot with a length: bar, part, velocity, flags, beats (a riser sweeps for that long)
```

`const S = s.sections({ intro: 8, verse: 16, drop: 16, outro: 8 })` declares consecutive sections from bar 0; each has `bar`, `bars`,
`end` and shows up in the probe's report. `play(pattern, at, bars?, opts?)`: `at` (a bar number or a Section) is required, so a misspelt section name
(`S.chrous` is `undefined` in JavaScript) is an error and not bar 0. Options: `vel` (multiplier), `transpose` (semitones), `offset`
(beats, may be negative), `gate` (note-length multiplier), `from` (start inside the pattern, in beats), `art`, `only` (drum parts),
`rename` (drum parts), `humanize`, `swing`. A clip outside the track, or a drum part the instrument does not have, is an error that says
where. Several `play` calls on one channel simply add up. A clip ends where you say: a note still sounding at the end of the clip is
cut there (use fractional bars for stops: `play(p, S.bridge.bar, S.bridge.bars - 0.25)` leaves the last beat silent). A clip always starts
at the **beginning** of its pattern, wherever it is placed: to play bars 5-8 of a long chord pattern at bar 20, either build the pattern for
those bars or pass `from` (in beats: `from: 16`). Placing a 16-bar progression at bar 4 of its section plays its first bar there, not its
fifth: the CLASH=1 check catches the wrong chords this gives.

In `note(bar, note, beats, vel, flags)` and `hit(bar, part, vel, flags, beats)` the `flags` are a bit set of articulations (`FLAG.ACCENT`,
`FLAG.MUTE` = palm mute, `FLAG.RING`, `FLAG.SLIDE`, `FLAG.GHOST`, `FLAG.RIM`, `FLAG.FLAM`, `FLAG.OPEN`, `FLAG.UP`, `FLAG.STACCATO`, exported
from `../song`; combine with `|`), the same things the notation writes as `! ~ ? {pm}` ...; 0 means none. The part name `''` is the sound
of a one-sound instrument (a kick, a riser, an impact).

**Automation** moves any parameter of any instrument, effect, mixer strip, bus, the reverb, the delay, the sidechain and the master:

```ts run
bass.auto('cutoff', [[0, 300], [8, 4000, 'exp'], [16, 300]]); // [bar, value, curve?]: points joined by curves
arp.ramp('cutoff', S.intro.bar, S.intro.end, 500, arp.param('cutoff'), 'exp'); // the same for two points, ending on the preset's own cutoff
bass.set('drive', 20, 32); // 20 from bar 32 on
bass.lfo('cutoff', { period: '1/8', depth: 1.2, mode: 'exp', from: S.drop.bar, to: S.outro.bar }); // a tempo-synced wobble
s.auto('master.trim', [[0, 2], [60, 0]]);
s.auto('reverb.time', [[0, 1.5], [16, 4]]);
pad.auto('mix.gain', [[0, -30], [8, -6]]); // the mixer strip of the channel
pad.auto('fx.chorus.depth', [[0, 1], [16, 6]]); // an insert effect: fx.<name>.<param>
kit.auto('kick.decay', [[0, 0.2], [16, 0.45]]); // a part of an electronic drum kit: <part>.<param>
```

How lanes behave: before its first point a parameter keeps the value it was created with; between points it moves along the curve
into the next point; after the last point it **holds**, so a ramp that ends at 3500 leaves the parameter at 3500 for the rest of the song
(`ch.param('cutoff')` returns the value the instrument starts with, the preset's own, to end a ramp on). Several `auto` calls on one
parameter are consecutive clips: the one that started last wins. Two points may share a bar: the lane arrives at the first value and then jumps to the second
(`[[4, 20], [8, 600, 'exp'], [8, 20, 'step']]` rises to 600 at bar 8 and falls back to 20 right there; the listing shows `8:600(exp) 8:20(step)`). Curves (the move *into* a point): `lin` (default), `exp` (geometric: use it for frequencies), `step` (hold the previous value,
jump at the point), `smooth` (ease in and out), `in` (slow start), `out` (slow end). A point outside the parameter's range is an error (the range is in the message); an LFO that swings past it is clamped while rendering. LFO
options: `period` ('1/8', '1/4.', '1/4t' or a number of beats) or `perBar`, `depth` (parameter units, or octaves with `mode: 'exp'`),
`shape` (sine tri saw ramp square smooth sh), `from` / `to` (bars), `phase` (cycles). LFOs add to whatever the lane or the base value
is. A wrong path is an error that lists what is available and suggests the closest name. Path forms:

| path | what |
|---|---|
| `<channel>.<param>` | an instrument parameter (`bass.cutoff`) |
| `<channel>.<part>.<param>` | a part of an electronic drum kit (`drums.kick.decay`, `drums.hat.gain`) |
| `<channel>.mix.<param>` | the channel strip (`gain`, `pan`, `width`, `hp`, `lp`, `eqLow`, `eqMid`, `eqHigh`, `reverb`, `delay`, `duck` ...) |
| `<channel>.fx.<name>.<param>` | an insert effect (`name` is the effect's kind: `drive`, `chorus`; a second one is `drive2`) |
| `bus.<bus>.mix.<param>` | a bus strip |
| `master.<param>`, `reverb.<param>`, `delay.<param>`, `duck.<param>` | the master chain, the shared sends, the sidechain |

Through a channel handle (`bass.auto('cutoff', ...)`) the channel part of the path is added for you; `s.auto('bass.cutoff', ...)` is the same
thing with the whole path.

## 7. Instruments

Every factory is `s.<factory>(presetOrOptions?, mix?)`: the first argument is a preset name (`s.kick('psy-kick')`) or an options object
(`s.synth({ preset: 'pluck', cutoff: 2400 })`), the second is the mixer strip (section 8). Options are flat: any parameter below sets its
starting value; the other options listed (layers, mode, takes ...) are chosen when the instrument is created. A typo in an option name
(instrument, mixer strip, `play`, effect, pattern text, `groove`, `lfo`) or in a preset name is an error with a suggestion, and so is a value
outside a parameter's range and a word that is not one of the choices (`mode: 'monno'`, `lfoSync: 'bar'`, `fx.filter({ mode: 'lowpass' })`: the message lists
the choices). An error from an instrument, an effect or a strip names the channel it belongs to. Give a channel a `name` in the mix options (`s.synth('pluck', { gain: -6, name: 'arp2' })`) to use it in
automation paths and reports; otherwise it is called after the factory and a second one gets a number (`synth`, `synth2`).

<!-- gen:instruments -->
| factory | channel name | you write | what it is |
|---|---|---|---|
| `s.kick(...)` | `kick` | hits (`s.hits`) | Synthesised kick: a sine with a pitch drop, a beater click and saturation. |
| `s.snare(...)` | `snare` | hits (`s.hits`) | Synthesised snare: tonal body plus band-passed noise and a crack. |
| `s.clap(...)` | `clap` | hits (`s.hits`) | Several quick noise bursts and a tail through a band-pass. |
| `s.hat(...)` | `hat` | hits (`s.hits`; `o` = open) | Metallic oscillator cluster plus noise. |
| `s.tom(...)` | `tom` | notes (the pitch) | Pitch-dropping tom. |
| `s.cymbal(...)` | `cymbal` | hits; the reverse crash: a note as long as the swell | Crash, ride, splash, china and a reverse crash that swells to the end of the note, played back from modal-synthesis buffers. |
| `s.perc(...)` | `perc` | hits (`s.hits`) | Rim, clave, cowbell, shaker, tambourine, congas, block and finger snap. |
| `s.drumKit(...)` | `drums` | drum lanes (`s.drums`) | Several electronic drums behind one channel with part names of your choice: `s.drumKit({ kick: "psy-kick", snare: "tight-snare", hat: { preset: "closed-hat", pan: 0.2, gain: -4 } })`. |
| `s.acousticKit(...)` | `kit` | drum lanes (`s.drums`) | A rock / punk kit: kick, snare with rattling wires, rim shot, three toms, hi-hats, two crashes, ride, bell, splash and china, with a small room. |
| `s.synth(...)` | `synth` | notes and chords | The flexible one: pads, supersaw chords, plucks, arps, leads, FM bells, organs. |
| `s.sub(...)` | `sub` | notes | A clean sine / triangle sub with optional harmonics and a pitch drop for 808 booms. |
| `s.darkBass(...)` | `darkBass` | notes (mono) | Distorted rolling bass: a saw pair and a square into saturation, a resonant ladder filter that pops open on every note, a second saturation and a clean sub. |
| `s.reese(...)` | `reese` | notes (mono) | Detuned saws (three per side) that beat and swirl, a filter, saturation and a clean centred sub. |
| `s.growl(...)` | `growl` | notes (mono); held notes of a beat or more | Dubstep bass: a saw pair and an FM oscillator through a wavefolder and saturation, two vowel (formant) band-pass filters and a 24 dB ladder, all moved by a tempo-synced LFO, plus a clean sub. |
| `s.acid(...)` | `acid` | notes (mono) with `!` and `~` | A sawtooth / square into a resonant ladder filter (taken at the 18 dB point) with a decaying envelope, accents and slides, then overdrive. |
| `s.riser(...)` | `riser` | one hit whose length is the sweep | Swept noise plus a rising (or falling) pitched tone. |
| `s.impact(...)` | `impact` | one hit | A pitch-dropping sub boom, a low thump, a crack and a rumbling tail. |
| `s.zap(...)` | `zap` | one hit | Falling lasers, FM zaps, long pitch falls and sirens. |
| `s.guitar(...)` | `guitar` | notes and chords (power chords, open chords) | Plucked-string waveguides (extended Karplus-Strong with pick position, a pickup comb, damping and palm muting), strummed chords, into an amp (noise gate, tight filter, screamer boost, three asymmetric gain stages at 2x oversampling, tone stack, sagging power amp) and a cabinet. |
| `s.bassGuitar(...)` | `bass` | notes (mono) | A plucked-string model (picked or fingered) through a bass amp with compression, overdrive and an 8x10 cabinet. |
<!-- /gen -->

**Levels.** Every preset is calibrated so that, alone at channel `gain: 0`, it measures about the same loudness as its relatives
(integrated LUFS before the master): kicks -14, snares -16, claps -18, toms and cymbals -18, percussion -20, closed hats -26; chords, pads and
leads -20, plucks and arps -22; dark bass, reese, growl and sub -16, acid -18; impacts -18, risers -24, zaps -22; an acoustic kit -16;
guitars and bass guitars -18 (`sandbox/album/lab/levels.ts` measures them all). The `level` parameter of an instrument is a trim in dB
on top of that. A patch built from scratch starts at a similar level. Then set the channel gains in the mix (section 8).

### Writing guitar and bass guitar parts

- **Notes and chords.** A guitar plays MIDI notes (the open strings are E2 A2 D3 G3 B3 E4 = 40 45 50 55 59 64). A chord is a bracket group, `[E2,B2,E3]`;
  its strings start `strum` ms apart (5-10 ms), low to high, like a pick travelling across them; `{up}` on the chord reverses it (to alternate
  strokes, add `{up}` to every other chord). A power chord is root, fifth and octave: `[A2,E3,A3]`; on the low E string the roots E to G# (`[E2,B2,E3]`,
  `[G2,D3,G3]`), on the A string A to D# (`[B2,F#3,B3]`, `[C#3,G#3,C#4]`). `guitarChord('A5')`, `guitarChord('Em')` and `guitarChord('F#m')` return
  playable voicings (power, open and barre shapes; `{ dropD: true }` for drop-D power chords) as MIDI numbers, for `s.pattern().chord(...)`.
- **Articulations.** `{pm}` palm mute: the chug, gone in about 0.2 s (eighth notes in a verse); `{ring}` lets the strings ring after the note ends
  (without it the end of the note damps them): `[A2,E3,A3]!{ring}:16` rings for a bar (16 steps at the default resolution); `?` a dead-note scratch (`[E2,B2,E3]?`); `!` a harder pick; `~` a
  quick scoop up into the note, from two semitones below (one on the bass guitar), and it needs no previous note; `{up}` an up-stroke.
- **Double tracking.** `punk-guitar` is a pair of takes panned hard left and right, each with its own timing and tuning errors: one channel. For
  more control use two channels, `punk-guitar-L` (panned left) and `punk-guitar-R` (right, a slightly brighter tone), playing the same
  pattern; each channel has its own random timing and tuning (seeded by its name), so they do not phase. A pan in the mix options replaces the
  preset's own.
- **Tone.** The amp's `gain` is an instrument parameter from 0 (clean) through 0.3 (crunch) and 0.6 (punk) to 0.85 (metal) and is **not** the
  fader (`mix.gain`, dB): automate it for a build (`guitar.auto('gain', ...)`). `tight` trims the low end before the distortion (more is
  tighter chugs), `mid` pushes or scoops, `cab` picks the cabinet. `crunch-guitar` and `clean-guitar` for open chords, `lead-guitar` for single
  notes, `metal-guitar` for heavy riffs.
- **In the mix.** Give guitars `hp: 90` (the low end belongs to the bass and the kick) and no sidechain; a `mix.hp` automation from 1500 down to
  90 makes an intro that opens up; keep the lead a little lower than the rhythm guitars. The bass guitar plays the roots in eighths
  (`s.chords('E5 B5 C#5 A5').roots({ rhythm: 'xxxxxxxx', res: 2, low: 28 })` is a line of eighth notes on the chord roots, or write `E1 E1 E1 ...`); `{pm}` for a
  tight verse, `!` and `{ring}` for the last note.
- **Limits.** Eight strings can sound at once per take, so a ringing chord is cut when the next ones need its strings; there are no bends, vibrato,
  hammer-ons or harmonics: `~` is the only pitch articulation. The probe's arrangement listing counts the articulation marks of the patterns
  (`gtrL(177: 156 pm, 3 slide, 12 ghost, 3 accent)`); on the basses and the mono synths a slide mark with nothing to glide from is counted apart as
  `slide(not tied)` and explained in a warning line, and a muted channel is marked `[muted]`.

The parameter tables and the presets of every instrument are in **Reference A** at the end of this guide; the presets are named for what they are for, so read the preset table of an instrument before you tweak parameters.

## 8. The mixer

Every channel is an instrument, then its insert effects, an optional compressor, filters and EQ, a fader, a pan and the sends. The second
argument of every factory is the strip:

```ts run
const pad2 = s.synth('supersaw-pad', {
  name: 'pad2', // used in automation paths and reports
  gain: -8, pan: 0.2, width: 1.2, // dB, -1..1, stereo width
  hp: 120, lp: 12000, eqMid: -2, eqMidFreq: 700, // filters and a 3-band EQ (all automatable)
  reverb: 0.3, delay: 0.1, // sends to the shared reverb and delay (0..1)
  duck: 0.7, // how much the kick ducks this channel (the sidechain)
  fx: [fx.chorus(), fx.drive({ drive: 6 })], // inserts, in order (section 9)
  comp: { threshold: -18, ratio: 3, attack: 0.01, release: 0.15, makeup: 2 }, // a compressor after the inserts
});
pad2.play(s.chords('Am', { octave: 3 }), S.outro);
```

`bus: 'music'` routes a channel to a bus made with `s.bus('music', { ...strip options })` instead of straight to the master; `key: true` makes
a channel's hits trigger the sidechain (kicks do by default); `mute: true` silences it while you work.

**Two different `gain`s.** `gain` in the mix options and `ch.auto('mix.gain', ...)` is the fader in dB. A guitar (and `fx.amp`) also has an
instrument parameter called `gain`, the amp's drive from 0 (clean) to 1 (high gain): `guitar.auto('gain', ...)` moves the amp,
`guitar.auto('mix.gain', ...)` the fader. A value outside a parameter's range, in an option or in an automation point, is an error that
names the range (`-6` for an amp's `gain` says so), not a silent clamp; while the song renders, LFOs may swing past the range and are
clamped.

**Starting gains.** The channel `gain`s (dB) the four example tracks and the Sound Check use; each balanced in the probe, so they are a sound first
mix for the same roles (then adjust with the probe's channel column and set the master trim last):

| part | gain | part | gain |
|---|---|---|---|
| kick | -3 | acid (`goa-acid`) | -9 |
| snare / clap | -4 to -5 / -8 to -9 | pads | -10 to -12 |
| closed hats | -7 to -8 (off-beat open hats -10) | supersaw chords (`supersaw-chord`) | -7 |
| shaker / tambourine | -13 / -10 | plucks, arps, e-piano | -6 to -9 |
| crash / reverse crash | -6 to -12 | leads | -4 to -9 |
| acoustic kit | -7 | risers, whooshes | -14 (a long build) to -9 (a short one) |
| sub | -8 | impacts | -4 to -8 |
| dark bass / rolling bass | -10 / -6 | rhythm guitars | -4 each |
| growl (with `sub: 0`, over a sub at -8) | -3 | bass guitar / lead guitar | -5 / -7 |

Bright, busy parts (hats, shakers, tambourines, cymbals) are the usual cause of an overbright mix: the `high` and `air` columns of the probe
show it (section 12).

<!-- gen:mixer:strip -->
Automation path: `<channel>.mix.<param>`, e.g. `bass.mix.gain`.

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `gain` | 0 | -80 .. 24 | dB | Channel fader. |
| `pan` | 0 | -1 .. 1 |  | Stereo position (-1 left, 0 centre, 1 right). Constant-power for mono sources, balance for stereo ones. |
| `width` | 1 | 0 .. 2.5 |  | Stereo width of the channel (stereo sources only): 0 mono, 1 unchanged, 2 very wide. |
| `hp` | 20 | 10 .. 4000 | Hz | High-pass filter (12 dB/oct). 20 = off. |
| `lp` | 20000 | 200 .. 20000 | Hz | Low-pass filter (12 dB/oct). 20000 = off. |
| `eqLow` | 0 | -18 .. 18 | dB | Low shelf gain. |
| `eqLowFreq` | 110 | 30 .. 400 | Hz | Low shelf corner. |
| `eqMid` | 0 | -18 .. 18 | dB | Mid bell gain. |
| `eqMidFreq` | 1000 | 150 .. 8000 | Hz | Mid bell centre. |
| `eqMidQ` | 1 | 0.2 .. 8 |  | Mid bell width (higher = narrower). |
| `eqHigh` | 0 | -18 .. 18 | dB | High shelf gain. |
| `eqHighFreq` | 7500 | 2000 .. 16000 | Hz | High shelf corner. |
| `reverb` | 0 | 0 .. 2 |  | Send to the shared reverb (0..1; 0.2 is a typical amount). |
| `delay` | 0 | 0 .. 2 |  | Send to the shared tempo-synced delay (0..1). |
| `duck` | 0 | 0 .. 1 |  | How much the sidechain (the kick) ducks this channel: 0 none, 1 fully at each kick. |
<!-- /gen -->

**Sends.** One shared reverb and one shared tempo-synced ping-pong delay serve the whole song: set them once and open them per channel with
`reverb` / `delay`. Both can be automated (`reverb.time`, `delay.feedback`, `delay.return` ...) and ducked.

```ts run
s.setReverb({ time: 2.4, damp: 0.5, return: -9 });
s.setDelay({ time: '1/8.', feedback: 0.4, return: -10 }); // time: a note division ('1/8.', '1/4t') or beats
```

<!-- gen:mixer:reverb -->
Automation path: `reverb.<param>`.

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `time` | 2.4 | 0.1 .. 15 | s | Reverb time (RT60). |
| `damp` | 0.5 | 0 .. 1 |  | How much faster the highs decay than the lows. |
| `size` | 1 | 0.3 .. 3 |  | Room size (scales the delay lengths). |
| `preDelay` | 0.012 | 0 .. 0.3 | s | Pre-delay before the reverb starts. |
| `early` | 0.35 | 0 .. 1 |  | Level of the early reflections. |
| `mod` | 0.5 | 0 .. 1 |  | Modulation of the lines (keeps long tails smooth). |
| `lowCut` | 130 | 20 .. 1000 | Hz | High-pass on the wet signal (keeps the bass clean). |
| `highCut` | 9000 | 1000 .. 20000 | Hz | Low-pass on the wet signal. |
| `width` | 1 | 0 .. 1.5 |  | Stereo width of the wet signal. |
| `return` | -8 | -60 .. 12 | dB | Level of the reverb return into the mix. |
| `duck` | 0 | 0 .. 1 |  | Ducks the reverb return with the sidechain (clears space at each kick). |
<!-- /gen -->

<!-- gen:mixer:delay -->
Automation path: `delay.<param>`.

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `time` | 0.75 | 0.0625 .. 4 | beats | Delay time in beats (0.75 = dotted eighth, 0.5 = eighth, 1 = quarter). |
| `feedback` | 0.4 | 0 .. 0.95 |  | Repeats. |
| `pingpong` | 0.8 | 0 .. 1 |  | Left/right alternation of the repeats. |
| `tone` | 4200 | 500 .. 16000 | Hz | Low-pass in the loop (darker repeats). |
| `lowCut` | 160 | 20 .. 1500 | Hz | High-pass in the loop. |
| `drive` | 0.15 | 0 .. 1 |  | Soft saturation in the loop. |
| `mod` | 0.15 | 0 .. 1 |  | Slow pitch wobble of the repeats. |
| `return` | -9 | -60 .. 12 | dB | Level of the delay return into the mix. |
| `duck` | 0 | 0 .. 1 |  | Ducks the delay return with the sidechain. |
<!-- /gen -->

**Sidechain.** Channels with `key: true` (every kick, by default) trigger a ducking envelope at each hit, scaled by velocity; every strip, the
reverb and the delay can follow it with `duck` (0..1). A drum kit with a kick part keys it with its kick hits only; an acoustic kit does
not key it unless you ask for `key: true` (then only its kick does). `release` is the whole recovery, not a time constant: the ducked channel is
exactly back at full level that long after the hold. With the default `curve` and full depth it is back to -3 dB after a fifth of it, to about -1 dB
after a third and within 0.4 dB after half. At 140 BPM a sixteenth lasts 0.107 s, an eighth 0.214 s and a beat 0.43 s: `release: 0.1` lets a
rolling bass breathe between the kicks of a Goa track, 0.2 (the default) pumps on eighths, 0.3 to 0.4 on beats.

```ts run
s.setSidechain({ release: 0.2, curve: 1.4, attack: 0.004, hold: 0.02, depth: 1 }); // curve above 1 pumps: slow start, quick finish
```

<!-- gen:mixer:duck -->
Automation path: `duck.<param>`.

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `depth` | 1 | 0 .. 1 |  | Strength of the sidechain at velocity 1 (multiplied by each channel's `duck` amount). |
| `attack` | 0.004 | 0.0005 .. 0.05 | s | How fast the ducked channels drop at each kick. |
| `hold` | 0.02 | 0 .. 0.3 | s | Time the ducking is held at full depth. |
| `release` | 0.2 | 0.02 .. 1.5 | s | Recovery time: this long after the hold the ducked channel is back at full level exactly (a total, not a time constant). With the default curve and full depth it is back to -3 dB after a fifth of it, to about -1 dB after a third. |
| `curve` | 1 | 0.3 .. 4 |  | 1 = exponential recovery; above 1 the recovery starts slower and finishes quicker (pumping), below 1 the opposite. |
<!-- /gen -->

**Pump or duck?** The sidechain is one envelope for the whole song, started by the kick: every channel with `duck` dips together, on the kick's
hits. `fx.pump` (section 9, Reference B) is the same envelope started by a pattern of its own and applied to one channel. Use `duck` for the parts
that follow the kick (the sub, the bass, the growl); use `pump` for a part that should breathe on a rhythm that is not the kick's, such as future-bass
chords pumping on every beat while the kick plays the downbeat and its syncopations. `pump` takes the sidechain's `attack`, `hold`, `release` and
`curve` with the same meanings (a setting that works in `s.setSidechain({ ... })` works in `fx.pump({ ... })`: the gain follows the same curve to
within 1e-12), and its `depth` plays the part of the strip's `duck` (0 is off, an exact pass-through, and a change acts at once, also in the middle of
a duck). A channel can have both, and the two ducks multiply. The pump is locked to the song's beat grid: it does not drift, does not care how the song
is cut into segments and lands on the same frame as a kick written on the same step.

```ts run
// chords that pump on every beat on their own, while the kick and the sub keep the global sidechain
const pumped = s.synth('supersaw-chord', { name: 'pumped', gain: -9, fx: [fx.pump({ pattern: 'x...x...x...x...', depth: 0.8, release: 0.3, curve: 1.4 })] });
pumped.play(s.chords('Am | F', { octave: 3 }), S.drop);
pumped.ramp('fx.pump.depth', S.drop.bar, S.drop.bar + 4, 0, 0.8); // the pump grows in over the first four bars
```

**Master.** Trim, a tone shelf pair, a glue compressor, soft saturation, mono-bass and a look-ahead true-peak limiter (ceiling -1.4 dB,
inter-sample peaks detected on a 4x oversampled signal). **The trim is how you set the loudness of the whole track**: render, read the
probe's integrated LUFS and change the trim until it says about -14 (within 0.5 LU), with the true peak at or below -1 dBTP. Do it last,
after the mix is done.

```ts run
s.setMaster({ trim: 2.5, glue: 1, sat: 0.3 });
```

<!-- gen:mixer:master -->
Automation path: `master.<param>`.

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `trim` | 0 | -40 .. 40 | dB | Gain into the master chain: the knob that sets the loudness of the whole track (calibrate it so the probe reports about -14 LUFS). |
| `lowShelf` | 1 | -12 .. 12 | dB | Low shelf at 80 Hz. |
| `highShelf` | 0 | -12 .. 12 | dB | High shelf at 9 kHz. |
| `glue` | 1 | 0 .. 1 |  | Amount of the glue compressor (0 = bypass). |
| `glueThreshold` | -14 | -40 .. 0 | dB | Glue compressor threshold. |
| `glueRatio` | 1.8 | 1 .. 8 |  | Glue compressor ratio. |
| `glueAttack` | 0.03 | 0.001 .. 0.2 | s | Glue compressor attack. |
| `glueRelease` | 0.18 | 0.02 .. 1 | s | Glue compressor release. |
| `sat` | 0.25 | 0 .. 1 |  | Soft saturation of the master (0 = clean). |
| `monoBelow` | 90 | 20 .. 300 | Hz | Stereo information below this frequency is folded to mono. |
| `ceiling` | -1.4 | -6 .. -0.3 | dB | Limiter ceiling (true peak). -1.4 keeps the 16-bit WAV and any later resampling under -1 dBTP. |
| `release` | 0.09 | 0.01 .. 0.5 | s | Limiter release. |
<!-- /gen -->

**Buses.** A bus is processed after all its channels and before the master; it has the same strip as a channel (insert effects,
compressor, EQ, filters, gain), reachable in automation as `bus.<name>.mix.<param>`. A bus filter sweep over the whole drum bus or the
whole music bus is a classic transition (section 10).

```ts run
const music = s.bus('music', { hp: 30, comp: { threshold: -16, ratio: 2 } });
s.synth('string-pad', { name: 'strings', bus: 'music', gain: -10 }).play(s.chords('F', { octave: 3 }), S.outro);
music.auto('mix.lp', [[40, 20000], [47, 600, 'exp']]); // closes the music bus over the last bars before bar 47
```

## 9. Effects

Insert effects are recipes created with `fx.<name>(options)` and listed in a strip's `fx` array. They run in order, before the compressor
and EQ. Their parameters are automatable as `<channel>.fx.<name>.<param>`; a second effect of the same kind is called `drive2` (or
pass `name`).

The parameter tables of every effect are in **Reference B** at the end of this guide. In short: `fx.drive` (saturation: soft, tube, hard clip or wavefolder), `fx.chorus` (chorus / flanger), `fx.phaser`, `fx.crusher` (bit and sample-rate reduction), `fx.widener` (stereo width with the lows kept centred), `fx.gate` (a rhythmic trance gate locked to the song), `fx.pump` (a tempo-locked duck on one channel, with the shape of the sidechain: section 8), `fx.filter` (low-pass, high-pass, band-pass or notch with a tempo-locked LFO), `fx.delay` (ping-pong delay as an insert), `fx.reverb` (also the 80s gated reverb) and `fx.amp` (the guitar amp and cabinet on any channel).

## 10. Transitions and fills

What makes a drop land is made of a few small pieces. All of these run as written (given the channels of the worked example):

```ts run
// 1. a snare roll over the last two bars before the drop: eighths, then sixteenths with rising velocity
kit.play(s.drums({ snare: '1.2.3.4.5.6.7.8. | 1234567899999999' }), S.drop.bar - 2);
// 2. a riser under it (the hit length is the sweep length) and a reverse crash that ends exactly on the drop
riser.hit(S.drop.bar - 4, '', 1, 0, 16);
s.cymbal('reverse-crash', { name: 'swell' }).note(S.drop.bar - 1, 'A3', 4, 1);
// 3. an impact and a crash on the first beat of the drop
s.impact('impact-deep', { name: 'boom' }).hit(S.drop.bar, '', 1);
kit.hit(S.drop.bar, 'crash', 1);
// 4. a filter sweep on a whole bus that opens at the drop
const drumBus = s.bus('drums', {});
s.synth('noise-pad', { name: 'texture', bus: 'drums', gain: -14 }).play(s.chords('Am', { octave: 3 }), S.drop.bar - 4, 4);
drumBus.auto('mix.lp', [[S.drop.bar - 4, 400], [S.drop.bar, 20000, 'exp']]);
// 5. stop the pad a beat early so that the drop hits a silence: bars may be fractional
pad.play(s.chords('Am | F', { octave: 3 }), S.verse.end - 2, 1.75);
// 6. a delay throw on the last beat of a phrase, and a pitch dive
lead.set('mix.delay', 0.7, S.drop.end - 0.25);
lead.set('mix.delay', 0.1, S.drop.end);
lead.ramp('bend', S.drop.end - 1, S.drop.end, 0, -12, 'in');
// 7. a rhythmic gate chops a pad into a trance-gate pattern
s.synth('supersaw-pad', { name: 'gated', gain: -12, fx: [fx.gate({ pattern: 'x.xx.x.xx.x.xx.x' })] }).play(s.chords('Am | F', { octave: 3 }), S.drop);
// 8. an ending without an outro section: stop the last clips two beats early (a fractional bar), put a last chord and a boom on those two
// beats, and let the reverb and delay tails ring out (the track's `tail`, 3 s by default, then the fade-out)
lead.play(line, S.outro.bar, S.outro.bars - 0.5);
pad.play(s.chords('Am', { octave: 3 }), S.outro.end - 0.5, 0.5);
s.impact('impact', { name: 'boom3', gain: -6, reverb: 0.3 }).hit(S.outro.end - 0.5, '', 0.8);
```

More ideas: automate a high-pass on the pads (`pad.auto('mix.hp', ...)`) up to 800 Hz before the drop to thin the breakdown out; open the
`reverb` send of the snare for one hit; automate a growl's `lfoRate` from 1 to 2 to 4 over the last bars of a build; switch the drum
pattern to half time (kick on 1, snare on 3) for the breakdown; end a section with one beat of silence (leave the last beat out of every
pattern) before a crash.

## 11. Your own sounds

**A patch from the building blocks** needs no engine changes: a synth is layers + filter + envelopes + modulation. A patch is an ordinary
object: keep it in a constant, spread it, change one thing. Type the constant (`import type { SynthOpts } from '../song'`): without the
type, TypeScript widens `wave: 'saw'` to `string` and `tsc` rejects the object (the option types `SynthOpts`, `GrowlOpts`, `GuitarOpts`,
`BassGuitarOpts`, `AcousticKitOpts`, `RiserOpts`, `DrumOpts` and `KitPartSpec` are exported).

```ts run
const myPad: SynthOpts = {
  layers: [{ wave: 'saw', unison: 5, detune: 1 }, { wave: 'tri', octave: -1, level: 0.5 }],
  filter: 'lp', cutoff: 900, res: 0.2, envAmt: 1.5, fAttack: 0.6, fDecay: 1.5, fSustain: 0.4,
  attack: 0.5, release: 1.2, unisonDetune: 16, spread: 1,
  mods: [{ src: 'lfo1', dst: 'cutoff', amount: 0.8 }], lfo1Rate: 0.25, // a slow filter breath, tempo-locked
};
s.synth(myPad, { name: 'my-pad', gain: -6, reverb: 0.3 }).play(s.chords('Am', { octave: 3 }), S.outro);
s.synth({ ...myPad, cutoff: 500 }, { name: 'dark-pad' }); // a variation
s.synth({ preset: 'supersaw-pad', cutoff: 1200 }, { name: 'pad-1200' }); // start from a preset, change what you like
```

The preset tables are exported from `../song`: `SYNTH_PRESETS`, `DRUM_PRESETS` (every kick, snare, clap, hat, tom, cymbal and percussion
preset), `DARK_PRESETS`, `REESE_PRESETS`, `GROWL_PRESETS`, `ACID_PRESETS`, `SUB_PRESETS`, `RISER_PRESETS`, `IMPACT_PRESETS`, `ZAP_PRESETS`,
`AKIT_PRESETS`, `GUITAR_PRESETS` and `BASSG_PRESETS`. A preset's `opts` holds only what it changes from the defaults (Reference A lists
them per preset) and is typed loosely: copy values from there, and read a parameter with `ch.param('cutoff')` instead of from the table.

**A new instrument or effect** implements the `Instrument` / `Effect` interfaces (note on and off, `process` that *adds* into the
buffers, parameters) and is added with `s.add(name, (ctx) => new Mine(ctx), mix)` / `customFx(kind, name, make)`. Extend `ParamBase`
for parameters (specs with default, range, unit, doc: the same table that drives automation and validation), and use the DSP blocks
from `dsp`: band-limited oscillators (`sawBL`, `pulseBL`, `triBL`, `addSaw` ...), filters (`Svf`, `Ladder`, `Biquad`, `OnePole`), envelopes and
LFOs (`Adsr`, `Lfo`), delay lines and oversamplers, `Reverb`, `Compressor`, `KsString` (the guitar string), `GuitarAmp`, `Cabinet`, noise
and random generators (`Noise`, `Rng`) and the maths (`mtof`, `dbToLin`, `tanh3`, ...), all exported from `../song`. This file is
`sandbox/album/custom-instrument.ts`, rendered by a test:

<!-- gen:file:custom -->
```ts
// The custom instrument and effect of src/audio/album/README.md (the README embeds this file; tests/album-engine.test.ts renders it).
import { ParamBase, customFx, defineTrack, dsp, type Ctx, type Effect, type Instrument, type ParamSpecs } from '../song';

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
```
<!-- /gen -->

Rules for your own DSP: add into the buffers (never overwrite); keep per-sample work cheap and allocation-free; return `false` from
`active()` when the sound has really ended (idle instruments are skipped, which is what keeps long arrangements cheap); use
`MonoTracker` (exported) for last-note priority and real slides in a monophonic instrument, and then declare `readonly slides = 'tie' as const` on the
class: the song then ties a slid note to the note before it (also when humanize moves its start a few milliseconds) and the probe's listing warns about
slide marks that cannot tie; read tempo and position from `ctx.bpm` and `ctx.transport.beat` to stay locked to the song; use `ctx.seed` for anything
random.

## 12. Checking your work without listening

**The render probe** is your ears. `ALBUM=1 ONLY=<id> npx vitest run tests/probes/album-render.test.ts` renders the track (10-20 s for a
full-length track), writes `previews/album/<id>.wav` and `<id>.report.txt` (and, with `SPEC=1`, `<id>.spec.png`) and prints the report. This
is the Sound Check's, shortened (your numbers will differ):

```
=== sound-check "Sound Check" (Test, 140 BPM) ===
  length 70.36 s (ALBUM says 70.36 s), built in 109 ms, rendered in 2.15 s = 32.7x real time
  integrated -14.00 LUFS (target -14; ...), short-term max -10.9 LUFS, true peak -1.24 dBTP, sample peak -2.27 dBFS
  DC 2.6e-4 / 2.6e-4   rms -16.4 dBFS   first/last sample 0.00000 / 0.00000

  arrangement (bars, section, channels that play notes or hits in it):
     14-15  sub            sub(2) boom(1)
     15-17  dark-bass      main-kick(8: 8 accent) dark(32: 1 accent)
     17-19  supersaw       supersaw(18)
     19-21  pluck-arp      arp(16) trance-pluck(13)

  automation (path: bar:value points, (curve) into a point; lfo settings):
    acid.cutoff: 8:260 10:1500(exp)
    growl.lfoRate: 10:1 11:1(step) 11.5:2(step) 11.75:4(step)

  section              LUFS   TP dBTP  width dB    sub  bass lowmid   mid upmid  pres  high   air   channels (rms dBFS over the whole section)
  sub                  -13.4     -5.2     -32.2    -15   -15   -30   -48   -76   -91  -100  -107   sub -16, boom -22, reese -43
  dark-bass            -11.3     -4.2     -53.8    -17   -15   -18   -26   -34   -45   -55   -61   main-kick -14, dark -17, boom -46
  supersaw             -17.9     -9.9      -2.6    -51   -64   -25   -28   -33   -38   -43   -56   supersaw -24, main-kick -51, dark -57
  pluck-arp            -18.6     -4.9      -8.6    -51   -33   -25   -27   -32   -37   -42   -53   arp -26, trance-pluck -28, supersaw -52
```

How to read it:

- **Arrangement and automation** are listings of what you wrote, as the engine registered it: a channel missing from a section means no
  `play` reached it; a lane on the wrong path or in the wrong bars shows here (no audio needed). Each lane is `bar:value`, with the curve
  into a point in brackets.
- **LUFS** is the integrated loudness of the section (BS.1770, gated), **TP** its true peak, **width** the side energy against the mid in dB
  (0 = as wide as it gets, below -20 = nearly mono: right for drums and bass).
- **Bands** are the power of the mono mix in eight bands, in dB re full scale: the mean square of the part of the signal that lies in the band, so
  the eight add up to the mix's own power (a full-scale sine reads -3 dB, and a mix at -18 dBFS rms has its loudest bands around -22): `sub`
  20-60 Hz, `bass` 60-150, `lowmid` 150-400, `mid` 400-1200, `upmid` 1.2-3 kHz, `pres` 3-6 kHz, `high` 6-12 kHz, `air` above 12 kHz. Read a row
  left to right for the balance: from `mid` upwards it should fall away; a `pres`, `high` or `air` more than 3-4 dB above `upmid` is bright and
  harsh (hats, shakers, tambourines, cymbals and bright leads are the usual cause), a `sub` far above `bass` is boomy. Read a column top to
  bottom for how the sections differ. To find out *which channel* a band comes from, use `BANDS=1` (next).
- **`CLASH=1`: the harmony check.** Numbers and pictures cannot tell a right note from a wrong one; the score can. `CLASH=1` lists every place
  where two pitched notes sound together a minor second or a minor ninth apart (C5 over a B4, a Db5 over the C of a C chord: the intervals that
  sound like a mistake) and, below C3, a major second (two bass notes a tone apart are mud), grouped by bar with the channels and the notes:
  `bar 39 (beat 3): lead F5 / saws E4, minor 9th (4 sixteenths)`. It reads the score, not the audio (notes from start to end, not their release
  tails; drums, muted channels and ghost notes are left out), so it is instant. A clash can be meant (a passing note, an appoggiatura that
  resolves on the next sixteenth); one that lasts several sixteenths on a strong beat usually is not. Run it after every change of notes or
  voicings; `song.clashes()` returns the same text in code. `no clashes` is the goal for a lead over its chords. `CLASH=2` also checks the
  synths' octave layers above the written note (`supersaw-chord` sounds every note an octave up too) against the other parts: a harmony line a
  semitone under the chords' upper octave shows up there.
- **`BANDS=1`: which channel owns a band.** The probe renders every channel that sounds alone (with the master's glue and saturation off, so that
  the numbers add up the way the mix's do; one extra render per channel, a few seconds each) and prints, for every section, the band levels of
  each channel under the mix's own row. A `.` means more than 25 dB under the mix in that band. In the Goa example's groove section:

```
  section / channel       sub  bass lowmid   mid upmid  pres  high   air
  groove                  -20   -19   -21   -26   -33   -39   -35   -34   (the mix)
    kick                  -20   -18   -20   -26   -33   -42   -49   -54
    bass                  -21   -25   -28   -32   -39   -55     .     .
    shaker                  .     .     .     .     .   -47   -36   -34
    ohat                    .     .     .     .   -54   -43   -37   -36
```

  The kick carries the sub and the bass bands, the bass and the acid the lowmid and mid, and the shaker and the hat are the whole of `high` and
  `air`: if those two columns stand out, they are what to lower.
- **`SOLO=acid,bass`: listen to some channels only.** The probe renders only those channels (the files get a `.solo-acid+bass` suffix and the
  loudness gates are skipped), so the tables and the spectrogram show just them. In code: `s.solo('acid')`, `s.solo(handle)` or a list
  (`s.solo(['acid', 'bass'])`; `s.solo(null)` hears everything again). `mute: true` or `ch.mute()` takes a channel out the other way round; the
  arrangement listing marks a muted channel `[muted]`.
- **`BARS=16-24`: zoom the spectrogram.** The picture shows only those bars (as wide as ever, so the detail grows with the zoom, and the faint
  lines then mark every bar). A growl's wobble, an acid line's cutoff arcs or a trance gate only show up zoomed, and alone:
  `SOLO=growl SPEC=1 BARS=8-12`.
- **Channels** are the rms of each channel over the whole section (post fader, before the master, left and right averaged, dBFS), loudest first, so
  a part that plays one bar of eight reads 9 dB lower, a channel that is silent in a section does not appear, and a `master.trim` fade shows only in the
  LUFS column. A preset alone at `gain: 0`
  reads 0 to 4 dB below its calibrated LUFS (section 7: rms is not K-weighted, and a bass weighs less), and the master compresses the sum,
  so use the column to compare channels with each other: anything more than about 12 dB under the loudest melodic channel will hardly be heard.
- **Loudness.** The target is -14 LUFS integrated with the true peak at or below -1 dBTP. The probe asserts it (-15.5 .. -12.5 passes), together
  with finite output, no DC and a silent first and last sample, so a track that misses the target fails with a message that says by how much.
  **`AUTOTRIM=1` finds the master trim for you**: it renders up to five times and prints `s.setMaster({ trim: 3.7 })` (or, when
  `master.trim` is automated, the dB to add to each value); a plain "trim by X dB" estimate would undershoot, because the master compresses.
- **A bigger drop.** A drop should be 1.5-3 LU louder than the section before it, but loudness is mostly kick and bass, and the master glue
  and limiter flatten what you add: more parts in the drop barely move the number. Take level out of the section *before* the drop instead:
  half-time drums or no kick for a few bars, `set('mix.gain', ...)` 3-6 dB lower on the bass and the hats until the drop, a high-pass
  on the pad (`pad.auto('mix.hp', ...)`), a quieter pad. A break without a kick at all may land 4 LU or more under the drop: that is fine.
  What makes a *build* loud is its risers, noise washes and snare rolls (a first draft of the dubstep example had its riser at -6 and the
  build came out louder than the drop): lower them first (a riser at -14, a wash at -15, the roll at velocity 0.7).
- **Printing from a track or a test:** use `process.stdout.write('...\n')`; `console.log` output can be swallowed by the test reporter.

**Scripts.** To look at a track without rendering it, or to run your own analysis, write a script and run it with
`node sandbox/album/run.mjs path/to/script.ts` (any TypeScript file: its imports are bundled; print with `process.stdout.write`). A track module
is imported by path; `defineTrack(...)` returns a `TrackDef`, `build(sampleRate)` composes it into a `Song`, and the song has `describe()`,
`describeAutomation()` and `toRenderer()`:

<!-- gen:file:script -->
```ts
// A script that builds a track, prints its arrangement and automation without rendering anything, then renders it block by block (the way
// the player does) and measures it. Run any script like this one with:  node sandbox/album/run.mjs sandbox/album/lab/script-example.ts
import soundCheck from '../../../src/audio/album/sound-check'; // a track module: import it by path (the album's index.ts needs Vite)
import { measure } from '../../../src/audio/album/measure';

const sr = 48000;
const song = soundCheck.build(sr); // defineTrack(...) returns a TrackDef: build(sampleRate) composes the track and returns the Song
process.stdout.write(`${song.describe()}\n\n${song.describeAutomation()}\n\n`); // the arrangement (note counts, articulations) and the automation lanes

const r = song.toRenderer(); // the streaming renderer of the player: r.frames and r.render(l, r, n)
const L = new Float32Array(r.frames);
const R = new Float32Array(r.frames);
const bl = new Float32Array(4096);
const br = new Float32Array(4096);
for (let pos = 0; pos < r.frames; ) {
  const n = r.render(bl, br, Math.min(4096, r.frames - pos)); // any block size gives the same samples
  L.set(bl.subarray(0, n), pos);
  R.set(br.subarray(0, n), pos);
  pos += n;
}
const m = measure(L, R, sr); // integrated LUFS, true peak, DC ...
process.stdout.write(`${(r.frames / sr).toFixed(1)} s, ${m.lufs.toFixed(2)} LUFS, true peak ${m.truePeakDb.toFixed(2)} dBTP\n`); // console.log may be swallowed by vitest
```
<!-- /gen -->

**The spectrogram** (`SPEC=1`) is one picture of the whole track: time runs left to right (a coloured strip on top marks the sections, bright
vertical lines their starts, faint ones every four bars), frequency runs bottom to top on a log scale from 30 Hz to 16 kHz (faint horizontal
lines at 50, 100, 200, 500 Hz, 1, 2, 5, 10 kHz, brighter at 100 Hz, 1 kHz and 10 kHz), brightness is level, tilted by 4.5 dB per octave so
that bass and treble show on one scale. An AI agent can open the PNG directly. Kicks are short arcs falling to the bottom, bass lines
bright horizontal bars at the bottom, snares and hats vertical stripes, builds rising diagonals, filter sweeps moving bright regions, a held
pad a band of horizontal lines; a drop should be a fuller picture than the break before it. (The change of texture at about 700 Hz is
where two analysis windows meet.)

**The instrument lab** renders one instrument alone, without the master chain, and prints peak, rms, LUFS, spectral centroid, decay time
and band energies; it writes `.cache/album-lab/out/<factory>-<preset>.wav`, `.spec.png` (the probe's picture: log frequency) and `.wave.png` (the waveform of the first 0.6 s):

```
node sandbox/album/run.mjs sandbox/album/lab/instrument-lab.ts darkBass darksynth-bass --pat "A1 . A1 A1 . A1 C2 . | A1 . A1 A1 . E2 D2 -" --bpm 128 --bars 2
node sandbox/album/run.mjs sandbox/album/lab/instrument-lab.ts acousticKit punk-kit --bpm 180 --lanes "kick:x...x.x.x...x.x.,snare:....x.......x..."
node sandbox/album/run.mjs sandbox/album/lab/instrument-lab.ts synth supersaw-pad --pat "[A2,E3,A3,C4]:16" --set cutoff=900
```

Other tools in `sandbox/album/lab/`: `guitar-lab.ts` (tuning, spectrum against a reference curve, envelopes and harmonics of the guitar),
`levels.ts` (the loudness of every preset), `profile.ts` (CPU time per channel of a track), `bench.ts` (CPU cost of the engine's parts),
`fuzz.ts` and `fuzz-mix.ts` (every parameter of every instrument, effect and mixer section at its extremes: nothing may blow up),
`fuzz-pattern.ts` (random notation and transforms: nothing may hang), `qa.ts` (every preset: clicks at note ends, silent tails, DC, velocity
response, stereo balance), `drum-report.ts` (numbers for every electronic drum), `evidence.ts` (the measurements quoted in section 15),
`speed.ts` (the render speed of a dense 3.5-minute track), `hash-album.ts` (the SHA-256 of the audio of every track of the album and of the Sound Check:
run it with `--save before.json` before a change to the engine and with `--check before.json` after it; with every new feature off, no hash may move)
and `pump-lab.ts` (how close `fx.pump` is to the sidechain, where its ducks land, what it costs).

**Tests**: `npx vitest run tests/album-engine.test.ts` (about 15 s) checks determinism, block-size independence, the master of the Sound
Check (peak, loudness, DC, clean start and end), the pitch of the instruments, the kick on the beat grid, the notation, the mixer, the
metadata of every track of the album and that the first seconds of each render cleanly, and that this README is up to date and its code
runs and type-checks. It does **not** measure the loudness of your track: the probe does (above). After changing a parameter, a preset, an
example or the README, regenerate the tables and `sandbox/album/readme-snippets.ts` with `DOCS=1 npx vitest run tests/probes/album-docs.test.ts`.

**A checklist before you call a track done:** every section declared and named; each section's loudness and channel table makes sense;
kick and sub not fighting (duck the sub and the bass with `duck`, or keep their notes off the kick); trim set for -14 LUFS; true peak
<= -1 dBTP; the first and last seconds sound intended (an intro and an outro composed, not cut); something changes every 4-8 bars; the
engine test file is green; `npx tsc --noEmit` is clean (vitest does not type-check); the render is well above real time (section 13).

## 13. CPU budget

The renderer runs in a worker during a race: the target is a dense 3.5-minute track in under 20 s on one core (10x real time). Measured
with `sandbox/album/lab/bench.ts` on the development machine (12th gen Intel Core i5-12600HX, node 24, 48 kHz): milliseconds of CPU per
second of audio.

| part | ms per second |
|---|---|
| shared reverb / ping-pong delay / master chain | 5 / 2 / 2 |
| supersaw pad or chord, 4 notes held | 7.5-8.5 (each extra unison voice per note costs about 0.15) |
| warm pad, fm e-piano (4 notes) | 6 / 5 |
| supersaw lead (mono) | 3.6 |
| dark-pluck arpeggio in sixteenths | 10 |
| dark bass / growl / acid / reese (held note) | 4.6 / 8 / 4 / 3 |
| guitar pair (2 takes, power chords in eighths) / one take | 13 / 7 |
| bass guitar (eighths) | 4 |
| acoustic kit, busy punk bar (the room alone is 5.5) | 13 |
| electronic drum kit, busy bar | 3-4 |
| chorus / drive insert | 1.6 / 1.5 |
| pump insert (`curve` 1 / a bent `curve`, ducking half of the time) | 0.3 / 1.0 |

A mix of 12 busy channels costs 70-90 ms per second (11-14x real time); the sound check, which plays one instrument at a time, renders at
about 33x. Idle channels cost nothing (instruments that are silent are skipped), so arrangements that bring instruments in and out are
cheap. The costly levers: unison voices (`unison`), polyphony (`voices`, long `release` on chords), arpeggios of overlapping plucks,
stereo ladder filters (`filter: 'lp'`, the 12 dB state-variable filter, is cheaper for pads), guitar takes (`takes: 1`) and the acoustic
kit's room (`room: 0.15` costs the same as `room: 0.8`; only 0 turns it off).

## 14. Genre starting points

Starting points, not rules. Gains are in dB on top of the calibrated levels (the table of starting gains is in section 8); the snippets are patterns of the shapes meant, adapt keys. Each genre has a complete track in `sandbox/album/examples/`.

**Darksynth / cyberpunk (95-130 BPM).** Kick `darksynth-kick`, snare `darksynth-snare` with `fx: [fx.reverb({ gated: true })]` (the 80s gated
snare), layered with `big-clap`; `closed-hat` on sixteenths with `o` on the last step. Bass: `darkBass` on sixteenths with a few `!` accents
and `~` slides, plus a `sub` doubling the roots, both with `duck: 0.8`. Arps: `synth('dark-pluck')` over `s.arp(chords, { order: 'updown',
octaves: 2 })` into a dotted-eighth delay; pads `supersaw-pad`; the hook on `supersaw-lead` (delay 0.3, reverb 0.25); `brass-stab` hits;
for a half-time section put the snare only on beat 3 and use `dark-sustain` bass with long notes. Minor keys (E, F#, A, C#); the harmonic
minor's raised seventh (`#7`, or the V chord `B7` in E minor) adds tension. Builds: section 10.

**Goa trance (140-148 BPM).** Kick `psy-kick` four on the floor (`s.hits('X...X...X...X...')`). The rolling off-beat bass is
`s.synth('psy-bass', { gain: -6, duck: 1 })` playing `prog.roots({ rhythm: '.xxx.xxx.xxx.xxx', len: 1, low: 28 })`, the three sixteenths after each
kick: its saw restarts on every note, so every sixteenth hits the same (Third Eye Highway's roll, sd 0.03 dB from note to note), it is mono, and
`len: 1` keeps each note inside its sixteenth so that the third one does not ring into the kick. (`s.reese('rolling-bass')` is the older recipe:
its free-running detuned saws make the notes wander over about 8 dB; `sandbox/album/lab/goa-roll.ts` measures both.) Set `s.setSidechain({ release: 0.1 })`: the duck is gone 0.1 s after its hold, so the first off-beat
sixteenth (0.106 s after the kick at 142 BPM) is within 0.1 dB of full level (with the default 0.2 it is still 0.8 dB down). Acid: `acid('goa-acid')` sixteen-step lines (gain -9) with `!` accents and `~` slides on the
notes you glide into (`'F#2 . F#3! F#2 G2 A2~ ...'`: `G2 A2~` glides, `. A2~` would not), and `ramp('cutoff', ...)` over the groove (300 to 2000 Hz,
then 900 to 2400 in the drop). Arps and leads: `trance-pluck` (-7) over `s.arp(chords, { order: 'up', octaves: 2, res: 4 })`, `trance-lead` (-6)
with long legato phrases; open hats on the off-beat eighths (`'..o...o...o...o.'` on a `hat`, -10), `shaker` (-13) and `tambourine` (-10)
sixteenths, a `crash` on the first bar of a section; pads (-12) through `fx.gate({ pattern: 'x.xx.x.xx.x.xx.x' })`, with `fx.gate.depth` at 0.4 in
the break and 1 in the drop. Hats, shakers and tambourines are what makes a Goa mix bright: if `high` and `air` stand out in the probe, `BANDS=1`
shows which of them to lower. Keys: `s.key('F#', 'phrygian')`, `'E', 'phrygian'`, `'harmonic minor'` or `'phrygian dominant'` (the lowered second
gives the exotic colour); a long build with a `riser` over the whole break (16 beats), a `reverse-crash` that ends on the drop, and a break without
the kick for 4-16 bars. A complete, balanced track: `sandbox/album/examples/goa.ts`.

**Melodic dubstep (140-150 BPM, half time).** Kick `punchy-kick` or `808-kick` on beat 1 plus syncopations that stay off the snare
(`X.........x.....`): in half time the snare owns beat 3, so a kick there would sit under it; `trap-snare` and `clap` only on beat 3 of each bar
(`'........X.......'`); rolling `closed-hat` sixteenths with ghost hits (`'x.xgx.xgx.xgx.xg'`, -8). Emotional minor progressions:
`s.chords('Fm | Db | Ab | Eb', { octave: 3, lead: true })` in `supersaw-chord` (-7, `duck` 0.9; held, or re-struck with
`.rhythm('x..x..x...x..x..')`: a rhythm shorter than the chord loops inside it), `fm-epiano` or `pluck` arps. The drop: `s.growl('dubstep-growl')`
(-3) on held notes of one or two beats (`'F1:6 . . F1:4 F2:4'`); give the growl `sub: 0` and `hp: 60` in its strip when the bottom is a separate
`s.sub('sub-sine')` (-8) on `prog.roots({ low: 28 })` (otherwise two subs add up and beat); automate `lfoRate` 1 -> 2 -> 4 at the end of each
phrase; for short, rhythmic growl notes use `lfoSync: 'beat'`, which keeps the wobble on the beat grid whatever the notes do. `supersaw-lead`
melodies (-6). Transitions: `s.riser('riser')` under the whole build (-14), `s.riser('noise-wash')` (-15) and `s.riser('whoosh')` (-14) are presets of
the same factory, a snare roll with rising velocity (at 0.7 of full), `s.impact('impact')` on the first beat of the drop. The loudness of a build
comes from exactly these, so set them first (a riser at -6 made a build louder than its own drop) and let `chords.auto('mix.hp', ...)` and a
closing filter on a `music` bus take the rest out of it. Sidechain strongly: `duck` 0.8-1 on chords, 0.7 on the growl, 0.9 on the sub,
`s.setSidechain({ release: 0.25, curve: 1.4 })`. Future-bass chords that pump on a rhythm of their own, not the kick's, take `fx: [fx.pump({ pattern: 'x...x...x...x...', depth: 0.8, release: 0.3, curve: 1.4 })]`
in their strip, with a light `duck` or none: they duck on every beat (`'x.x.x.x.x.x.x.x.'` ducks on every eighth, and a bar line makes a longer pattern:
`'x...x...x...x... | x...x...x..x..x.'`), while the sub and the growl keep their `duck` and follow the kick. Ramp `fx.pump.depth` up from 0 to open a build into
the pump. A complete, balanced track: `sandbox/album/examples/dubstep.ts`.

**Punk (170-200 BPM).** `acousticKit('punk-kit')`. A verse beat (the skate beat): kick `x.......x.x.....`, snare on 2 and 4 `....x.......x...`, closed
hat eighths `x.x.x.x.x.x.x.x.`; a chorus beat: kick on every beat `x...x...x...x...`, snare on the off-beat eighths `..x...x...x...x.` (or on 2
and 4), ride or hat eighths, a `crash` on the first beat of each chorus; a fill: `tomHi: '..........xx....'`, `tomMid: '............xx..'`,
`tomLo: '..............xX'` on the last bar; a stop: everything but a kick and a snare hit on the last beat (`kick: 'x.......X.......'`). Guitars and
bass: see "Writing guitar and bass guitar parts" in section 7. Keep the arrangement short and fast: intro, verse, chorus, verse, chorus, bridge,
final chorus (a key change up a whole tone is a classic), stops and a ringing last chord. Starting gains that balance in the probe: kit -7,
each guitar -4, bass guitar -5, lead -7 (a hard-panned single take reads 3 dB lower in the channel column than the same part centred, so compare
the two guitars with each other). Loud and dense: `s.setMaster({ glue: 1, sat: 0.3 })`, trim with `AUTOTRIM=1`.

## 15. Honest notes on the instruments

Nobody could listen while this was built: everything was verified with measurements (spectra, tuning, envelopes, levels, tests), not by
ear. The physics and the usual studio practice were followed, but treat the sounds as well-engineered starting points whose character
needs a human ear to confirm. The numbers below come from `sandbox/album/lab/` (`evidence.ts`, `drum-report.ts`, `guitar-lab.ts`,
`qa.ts`); run them to reproduce.

- **Electronic drums.** Kicks, snares and claps follow the classic synthesis recipes (a pitch-dropped sine with click and saturation; tonal
  body plus noise; staggered noise bursts) and are the most reliable sounds in the engine. Measured: the kicks start at 140-310 Hz (the 808 at
  82 Hz) and fall to 46-60 Hz (the 808 rings for 1.1 s to -40 dB, the techno and darksynth kicks are down in 0.65 s); the snares centre at 5-7 kHz
  (`heavy-snare`: 1.7 kHz, body-heavy) with a 190 ms (darksynth) or 80 ms (tight) tail; claps centre at 2.5-3 kHz; closed hats centre at
  9-11 kHz and are gone in 20-40 ms. Cymbals are modal (dozens of damped inharmonic partials with beating twins plus a noise band, built once per track); the
  crash rings 2.4 s to -40 dB, the ride 2.1 s, the splash 0.9 s. Whether they sound like cymbals rather than "metallic and a bit tonal"
  is exactly what could not be heard.
- **Acoustic kit.** Drum heads are modal (membrane mode ratios, pitch relaxation); the snare has a wire-rattle model whose level follows the
  head; the room is a small reverb. It has the right structure (attack, body, rattle, room, velocity-dependent timbre), which should be
  enough for fast punk where the kit sits under guitars, but it is a synthesised kit, not the micro-detail of a sampled one.
- **Synths.** Band-limited oscillators (four-sample PolyBLEP, not oversampled), the usual supersaw detune pattern (the classic seven-saw spread),
  ladder and state-variable filters. Measured aliasing (energy off the harmonic series against the signal): saw -52 dB at 110 Hz, -45 dB at
  440 Hz, -43 dB at 1 kHz, -36 dB at 2 kHz, -39 dB at 4 kHz; triangle far lower. That is inaudible inside a mix or behind a low-pass filter,
  and may show as a faint inharmonic haze on a bright, loud solo lead in the top octaves with the filter wide open: keep such leads dark or put
  them through `fx.filter`. One
  supersaw note measures 59 % of its energy within +-20 cents of the pitch and a side/mid ratio of -2 dB (very wide). FM bells and
  e-pianos are simple two-operator FM.
- **Bass instruments.** Sub, darksynth bass, reese, growl and acid are built from the usual recipes (saturation at 2x oversampling, vowel
  band-passes and a wavefolder for the growl, a 24 dB ladder tapped at 18 dB for the acid). Measured: the growl's centroid swings 280 to
  720 Hz at the LFO rate (about 2.1-2.3 cycles per second for quarter notes at 140 BPM; the `screech` preset reaches 1.6 kHz; with the growl's own sub off,
  as in the dubstep example, 176 to 840 Hz with a period of exactly one beat); an accented
  `acid-303` note is 3.4 dB louder and 5-6 dB brighter in the first 30 ms; a slid acid note glides 55 -> 82 Hz in about 50 ms with no gap in the level, where a
  retriggered note shows a 6 dB hole; the reese's level swirls by 8 dB over a held note. The exact taste of a 303 or of a modern growl
  is approximate.
- **Guitar.** The least certain instrument and the most worked on. Strings are waveguides (pick position, pickup comb, loop damping, palm
  mute, strum timing, double-tracking with independent timing and tuning errors); the amp is three asymmetric gain stages at 2x
  oversampling with coupling filters, a tone stack, sag and a gate; the cabinet is a chain of filters. Measured: in tune to within a few
  cents; a distorted note has a harmonic series falling steadily (h2 as strong as h1, h5 20 dB down, h13-h20 24-38 dB down) with both even
  and odd harmonics; a palm-muted chord falls 37 dB in 160 ms and 50 dB in about 220 ms; an open chord loses only 1-2 dB over its first half
  second (the amp's compression); the spectrum of a chugging riff sits within about 3 dB of a typical recorded-rhythm-guitar curve from 800 Hz to
  6 kHz, runs 3-7 dB heavy between 150 and 630 Hz, and falls away faster than that curve above 6 kHz (`punk-guitar` and `punk-guitar-L` are the
  darkest of the presets, `metal-guitar` the brightest). That curve is my own rough reference, not a measured corpus. So it is
  clearly a distorted guitar in every measurement, but a recorded rhythm guitar has micro-timing, pick noise, string buzz and
  amp-and-speaker interaction that are only approximated: next to a real one it will sound like a good simulation. Clean and crunch tones
  are less convincing than high-gain ones, because the string model's attack is the weak point. Since the punk track (Flat Out): palm mutes
  darken after their pick click as a palm does (`muteDark`: 60-100 ms after the pick a muted chord's centroid is 239 Hz against 652 Hz for an
  open one), held notes take a finger vibrato (`vibrato`, `vibratoRate`, `vibratoDelay`; `lead-guitar` swings 5-39 cents at 5.6 Hz), `bend` bends
  every sounding string (automate it), `pickVar` varies the pick from note to note, a new chord damps one left ringing, and the 4x12 cabinet
  sits within about 2 dB of the reference curve from 125 Hz to 8 kHz. Still missing: hammer-ons, pull-offs and harmonics.
- **Bass guitar.** The same string model through a bass amp that keeps the lows under 220 Hz clean and drives the band above with a mid push
  (`punk-bass` has 9 dB more energy above 400 Hz than before: the growl that cuts through guitars); picked punk tones are better than
  fingerstyle, which stays clean.
- **Acoustic kit, since Flat Out.** A beater click on the kick (3-6 kHz in its first 8 ms up 10 dB), a stick crack on the snare with far
  less hiss above 12 kHz, a stick attack on the toms. Every guitar and bass preset is calibrated to -18 LUFS, every kit to -16.
- **Risers, impacts, zaps.** Simple and effective; the impact's character depends heavily on the reverb send.
- **Mastering.** Real BS.1770 loudness and inter-sample peak detection, but a single simple limiter: dense, heavily limited material can
  pump. Lower the trim and the master saturation rather than pushing.
- **Limits of the engine.** One tempo and one time signature per track; mono basses cannot play chords (last note wins); drum hits have no
  sample-style velocity layers (velocity changes level and some brightness; the acoustic kit changes the most); only 44100 and 48000 Hz are tested.

## 16. Adding the track to the album

1. The file `tracks/<id>.ts` must `export default defineTrack({ id, title, genre, bpm, bars, ... }, compose)` with `id` equal to the file name
   (lowercase, digits, hyphens) and `genre` one of `Cyberpunk`, `Goa trance`, `Melodic dubstep`, `Punk` (`Test` for tests). The track appears
   in `ALBUM` automatically (the registry globs `tracks/*.ts`), ordered by genre and then file name.
2. `ALBUM[i].seconds` is `bars * barLength + tail`; the renderer's `frames` always agrees with it. Aim for 3:00-3:45 (at 128 BPM in 4/4,
   96-112 bars).
3. Run the probe (`ALBUM=1 ONLY=<id> AUTOTRIM=1 SPEC=1 npx vitest run tests/probes/album-render.test.ts`), write the trim it prints, check the
   section table and the spectrogram. The probe is the album's mastering gate: it fails a track that is not finite, whose true peak is above
   -1 dBTP, whose loudness is outside -15.5 .. -12.5 LUFS, that has DC or that does not start and end in silence.
4. Run `npx vitest run tests/album-engine.test.ts`: it checks every track's metadata at both sample rates and that its first seconds render
   cleanly (full-length mastering is the probe's job: `ALBUM=1 npx vitest run tests/probes/album-render.test.ts` renders and gates every track).
5. Run `npx tsc --noEmit`: vitest transpiles without type-checking, so a type error in a track file only shows up there (and `npm run build` runs it first, so a type error breaks the build).

The contract with the player (`index.ts`) never changes: `ALBUM`, `ALBUM_NAME`, `createTrackRenderer(id, sampleRate)` returning
`{ frames, render(l, r, n) }`. A renderer is streaming and deterministic, and is safe to run in a Web Worker.

## Reference A. Instruments: parameters and presets

### Kick

<!-- gen:instrument:kick -->
Synthesised kick: a sine with a pitch drop, a beater click and saturation. Kicks key the sidechain by default.

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.kick('psy-kick', { gain: -3 }).play(s.hits('X...x...X...x...'), S.drop);
```

- Write it with `s.hits(...)`: `x` hit, `X` accent, `g` ghost, digits 1-9 velocity.

Parameters (all automatable; also usable as options):

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `level` | 0 | -30 .. 12 | dB | Trim in dB on top of the preset's calibrated loudness (0 = as calibrated; the fader is the channel's `gain` in the mix). |
| `pitch` | 52 | 28 .. 130 | Hz | The note the kick settles on (its fundamental): 45-60 Hz for dark, heavy kicks, up to 80 for tight ones. |
| `sweep` | 2.3 | 0 .. 4.5 | octaves | How far above `pitch` the kick starts. 1 = soft 808, 2-3 = punchy, 3.5+ = psytrance zap. |
| `sweepTime` | 0.038 | 0.004 .. 0.25 | s | Time constant of the pitch drop. Short = clicky/zappy, long = booming. |
| `punch` | 0.4 | 0 .. 1 |  | Extra fast pitch snap and level in the first 8 ms: the chest thump. |
| `decay` | 0.36 | 0.05 .. 1.8 | s | Amplitude decay (time to -60 dB). Shorter than the beat spacing keeps the bass clear. |
| `hold` | 0 | 0 .. 0.4 | s | Time the level is held before it decays (808 booms). |
| `click` | 0.35 | 0 .. 1 |  | Level of the beater click. |
| `clickTone` | 3200 | 800 .. 9000 | Hz | Pitch of the click: low = thud, high = tick. |
| `drive` | 10 | 0 .. 36 | dB | Saturation: harmonics, loudness and aggression. |
| `tone` | 9000 | 400 .. 18000 | Hz | Low-pass: lower values make a rounder kick. |
| `tail` | 0.15 | 0 .. 1 |  | Level of a longer pure sub tone under the body. |
| `velocity` | 0.6 | 0 .. 1 |  | How much velocity changes the level and the click (0 = every hit equally loud). |

Presets:

| preset | what it is for | its settings (the rest are the defaults) |
|---|---|---|
| `darksynth-kick` | Big, punchy 80s-style synthwave kick with a bright click and a long weighty tail. 90-130 BPM. | pitch 50, sweep 2.4, sweepTime 0.04, punch 0.5, decay 0.42, click 0.5, clickTone 3500, drive 14, tone 8000, tail 0.25 |
| `techno-kick` | Hard, saturated four-on-the-floor kick with a medium tail. 120-140 BPM. | pitch 54, sweep 2, sweepTime 0.03, punch 0.3, decay 0.5, click 0.3, clickTone 2800, drive 20, tone 7000, tail 0.1 |
| `psy-kick` | Goa / psytrance kick: very fast pitch zap, tight tail so the off-beat bass fits, strong click. 138-150 BPM. | pitch 47, sweep 3.2, sweepTime 0.02, punch 0.75, decay 0.21, click 0.65, clickTone 4500, drive 22, tone 9500, tail 0.04 |
| `punchy-kick` | Tight modern kick for dubstep / EDM: short, round, clean low end. | pitch 55, sweep 2.1, sweepTime 0.03, punch 0.45, decay 0.3, click 0.35, clickTone 3000, drive 8, tone 6500, tail 0.12 |
| `hard-kick` | Extremely distorted gabber-style kick. | pitch 60, sweep 2.6, sweepTime 0.03, punch 0.8, decay 0.45, click 0.5, clickTone 2600, drive 32, tone 6000, tail 0 |
| `808-kick` | Long sine boom with a soft click: half-time drops and sub-heavy bass music. | pitch 46, sweep 1, sweepTime 0.06, punch 0.2, decay 0.95, hold 0.05, click 0.1, clickTone 1800, drive 3, tone 3000, tail 0.4 |
| `club-kick` | Clean, deep house-style kick. | pitch 52, sweep 1.8, sweepTime 0.035, punch 0.35, decay 0.34, click 0.25, clickTone 2600, drive 5, tone 6000, tail 0.1 |
<!-- /gen -->

### Snare

<!-- gen:instrument:snare -->
Synthesised snare: tonal body plus band-passed noise and a crack.

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.snare('darksynth-snare', { reverb: 0.15 }).play(s.hits('....X.......X..g'), S.drop);
```

- `s.hits(...)`; velocity changes the noise brightness as well as the level.

Parameters (all automatable; also usable as options):

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `level` | 0 | -30 .. 12 | dB | Trim in dB on top of the preset's calibrated loudness (0 = as calibrated; the fader is the channel's `gain` in the mix). |
| `tune` | 190 | 100 .. 420 | Hz | Pitch of the drum body. |
| `body` | 0.7 | 0 .. 1.5 |  | Level of the tonal body (the "thump"). |
| `bodyDecay` | 0.11 | 0.02 .. 0.6 | s | Decay of the body. |
| `noise` | 0.85 | 0 .. 1.5 |  | Level of the noise (the snare wires). |
| `noiseDecay` | 0.2 | 0.03 .. 1.2 | s | Decay of the noise. Long = big gated-reverb snare. |
| `noiseTone` | 4300 | 1200 .. 10000 | Hz | Centre of the noise band: lower = fatter, higher = crisper. |
| `noiseQ` | 0.9 | 0.3 .. 5 |  | Narrowness of the noise band. |
| `snap` | 0.5 | 0 .. 1.5 |  | The first crack: a very short loud burst of noise. |
| `tail` | 0 | 0 .. 1 |  | Adds a slow noise tail behind the hit (a poor man's reverb). |
| `drive` | 6 | 0 .. 30 | dB | Saturation. |
| `velocity` | 0.7 | 0 .. 1 |  | How much velocity changes level and brightness. |

Presets:

| preset | what it is for | its settings (the rest are the defaults) |
|---|---|---|
| `darksynth-snare` | Big 80s snare: fat body, long noise decay (pair it with fx.reverb({ gated: true }) for the full gated-reverb sound). | tune 185, body 0.75, bodyDecay 0.13, noise 0.9, noiseDecay 0.28, noiseTone 3800, snap 0.7, tail 0.25, drive 9 |
| `tight-snare` | Short, punchy snare for fast music. | tune 200, body 0.6, bodyDecay 0.08, noise 0.85, noiseDecay 0.13, noiseTone 4800, snap 0.5, tail 0, drive 6 |
| `trap-snare` | Crisp, high snare for half-time dubstep drops. | tune 230, body 0.55, bodyDecay 0.09, noise 1, noiseDecay 0.2, noiseTone 5500, snap 0.9, tail 0.1, drive 8 |
| `heavy-snare` | Low, heavy snare with a lot of body. | tune 150, body 1, bodyDecay 0.18, noise 0.8, noiseDecay 0.25, noiseTone 3300, snap 0.6, tail 0.3, drive 12 |
<!-- /gen -->

### Clap

<!-- gen:instrument:clap -->
Several quick noise bursts and a tail through a band-pass.

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.clap('big-clap').play(s.hits('....x.......x...'), S.drop);
```

Parameters (all automatable; also usable as options):

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `level` | 0 | -30 .. 12 | dB | Trim in dB on top of the preset's calibrated loudness (0 = as calibrated; the fader is the channel's `gain` in the mix). |
| `tone` | 1500 | 600 .. 4000 | Hz | Centre of the noise band. |
| `q` | 1.2 | 0.4 .. 5 |  | Narrowness of the band. |
| `decay` | 0.16 | 0.04 .. 0.8 | s | Length of the final tail. |
| `bursts` | 4 | 1 .. 7 |  | Number of quick bursts before the tail (the "hands"). |
| `spread` | 9 | 3 .. 25 | ms | Time between the bursts. |
| `drive` | 4 | 0 .. 24 | dB | Saturation. |
| `velocity` | 0.6 | 0 .. 1 |  | How much velocity changes the level. |

Presets:

| preset | what it is for | its settings (the rest are the defaults) |
|---|---|---|
| `clap` | Classic synth clap. | tone 1500, decay 0.16, bursts 4, spread 9, drive 4 |
| `big-clap` | Wide, long clap: layer under a snare. | tone 1300, q 0.9, decay 0.28, bursts 5, spread 11, drive 6 |
| `tight-clap` | Short clap for fast tempos. | tone 1800, decay 0.09, bursts 3, spread 7, drive 4 |
<!-- /gen -->

### Hi-hat

<!-- gen:instrument:hat -->
Metallic oscillator cluster plus noise. A hit with the `o` flag is the open hat; a closed hit chokes it.

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.hat('closed-hat', { pan: 0.2, gain: -6 }).play(s.hits('x.x.x.x.x.x.x.xo'), S.drop); // o = open hat
```

- `s.hits("x.x.x.xo")`: `o` = open hat.

Parameters (all automatable; also usable as options):

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `level` | 0 | -30 .. 12 | dB | Trim in dB on top of the preset's calibrated loudness (0 = as calibrated; the fader is the channel's `gain` in the mix). |
| `pitch` | 1 | 0.5 .. 2 |  | Tunes the metallic cluster (1 = classic). |
| `decay` | 0.05 | 0.01 .. 0.5 | s | Closed hat length. |
| `openDecay` | 0.38 | 0.08 .. 1.6 | s | Open hat length (hits with the o flag). |
| `tone` | 7000 | 2500 .. 12000 | Hz | High-pass: lower = fuller, higher = thinner and brighter. |
| `bright` | 15000 | 6000 .. 20000 | Hz | Low-pass on top. |
| `noise` | 0.35 | 0 .. 1 |  | Mix of white noise into the metallic sound (sizzle). |
| `velocity` | 0.7 | 0 .. 1 |  | How much velocity changes level and brightness. |

Presets:

| preset | what it is for | its settings (the rest are the defaults) |
|---|---|---|
| `closed-hat` | Crisp closed hi-hat (use the o flag in a pattern for the open one). | decay 0.05, openDecay 0.38, tone 7000, noise 0.35 |
| `tight-hat` | Very short, bright hat for 16th-note patterns. | decay 0.03, openDecay 0.25, tone 8000, noise 0.3, bright 17000 |
| `dark-hat` | Fuller, darker hat for synthwave. | decay 0.06, openDecay 0.45, tone 5500, noise 0.45, bright 12000, pitch 0.85 |
<!-- /gen -->

### Tom

<!-- gen:instrument:tom -->
Pitch-dropping tom. Play notes: A2 gives the pitch as set, other notes transpose it.

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.tom('tom-low').play(s.notes('A2 . . . D3 . F3 . A3 . . . . . . .'), S.drop); // the note is the pitch
```

- Notes, not hits: `s.notes("A2 . D3 . F3 . A3 .")`.

Parameters (all automatable; also usable as options):

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `level` | 0 | -30 .. 12 | dB | Trim in dB on top of the preset's calibrated loudness (0 = as calibrated; the fader is the channel's `gain` in the mix). |
| `pitch` | 110 | 50 .. 400 | Hz | Fundamental of the tom. A note given by the pattern transposes it (A2 = as set, one octave up = double). |
| `drop` | 0.5 | 0 .. 2 | octaves | How far above the pitch the tom starts (the dive). |
| `dropTime` | 0.06 | 0.01 .. 0.3 | s | Time constant of the dive. |
| `decay` | 0.34 | 0.05 .. 1.5 | s | Decay. |
| `click` | 0.4 | 0 .. 1 |  | Stick attack. |
| `overtone` | 0.3 | 0 .. 1 |  | Level of the inharmonic overtones (membrane modes). |
| `drive` | 3 | 0 .. 24 | dB | Saturation. |
| `velocity` | 0.7 | 0 .. 1 |  | How much velocity changes the level. |

Presets:

| preset | what it is for | its settings (the rest are the defaults) |
|---|---|---|
| `synth-tom` | Electronic tom with a long dive (pitched: play notes). | pitch 110, drop 0.9, dropTime 0.08, decay 0.4, click 0.3, overtone 0.15, drive 4 |
| `tom-low` | Low tom. | pitch 85, drop 0.5, decay 0.45, click 0.4, overtone 0.3 |
| `tom-mid` | Mid tom. | pitch 125, drop 0.5, decay 0.38, click 0.4, overtone 0.3 |
| `tom-high` | High tom. | pitch 180, drop 0.45, decay 0.3, click 0.45, overtone 0.3 |
<!-- /gen -->

### Cymbals

<!-- gen:instrument:cymbal -->
Crash, ride, splash, china and a reverse crash that swells to the end of the note, played back from modal-synthesis buffers.

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.cymbal('crash').hit(S.drop.bar, '', 1);
s.cymbal('reverse-crash', { name: 'swell' }).note(S.drop.bar - 1, 'A3', 4, 1); // ends exactly where its note ends
```

- The reverse crash ends exactly where its note ends: write a note as long as the build you want (`s.notes("A3:16")` is one bar). The pitch of that note does not matter.

Parameters (all automatable; also usable as options):

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `level` | 0 | -30 .. 12 | dB | Trim in dB on top of the preset's calibrated loudness (0 = as calibrated; the fader is the channel's `gain` in the mix). |
| `decay` | 1 | 0.2 .. 1 |  | Shortens the ring-out (1 = natural length, 0.3 = choked quickly). |
| `tone` | 0 | -1 .. 1 |  | Brightness shift: negative = darker, positive = brighter. |
| `velocity` | 0.8 | 0 .. 1 |  | How much velocity changes level and brightness. |

Presets:

| preset | what it is for | its settings (the rest are the defaults) |
|---|---|---|
| `crash` | Crash cymbal (about 2.8 s). | recipe crash |
| `crash-dark` | Darker crash. | recipe crash-dark |
| `splash` | Short splash. | recipe splash |
| `china` | Trashy china. | recipe china |
| `ride` | Ride with a clear ping. | recipe ride |
| `ride-bell` | Ride bell. | recipe ride-bell |
| `reverse-crash` | Reversed crash that swells up and ends exactly when the note ends: place a note of the length you want (e.g. 4 beats) so that it finishes on the downbeat. | recipe crash, reverse true |
<!-- /gen -->

### Percussion

<!-- gen:instrument:perc -->
Rim, clave, cowbell, shaker, tambourine, congas, block and finger snap.

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.perc('shaker', { gain: -4 }).play(s.hits('x.xxx.xxx.xxx.xx'), S.drop);
```

Parameters (all automatable; also usable as options):

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `level` | 0 | -30 .. 12 | dB | Trim in dB on top of the preset's calibrated loudness (0 = as calibrated; the fader is the channel's `gain` in the mix). |
| `tune` | 1 | 0.4 .. 2.5 |  | Pitch multiplier of the percussion sound. |
| `decay` | 1 | 0.2 .. 4 |  | Length multiplier of the sound. |
| `tone` | 1 | 0.4 .. 2.5 |  | Brightness multiplier of the filtering. |
| `velocity` | 0.7 | 0 .. 1 |  | How much velocity changes the level. |

Presets:

| preset | what it is for | its settings (the rest are the defaults) |
|---|---|---|
| `rim` | Rim shot. | kind rim |
| `clave` | Clave. | kind clave |
| `cowbell` | 808 cowbell. | kind cowbell |
| `shaker` | Shaker. | kind shaker |
| `tambourine` | Tambourine. | kind tambourine |
| `conga` | Low conga (pitched: play notes around C4). | kind conga |
| `conga-hi` | High conga. | kind conga-hi |
| `block` | Wood block. | kind block |
| `snap` | Finger snap. | kind snap |
<!-- /gen -->

### Electronic drum kit

<!-- gen:instrument:drumKit -->
Several electronic drums behind one channel with part names of your choice: `s.drumKit({ kick: "psy-kick", snare: "tight-snare", hat: { preset: "closed-hat", pan: 0.2, gain: -4 } })`. Parameters are addressed as `part.param` (`kick.decay`, `hat.gain`, `snare.pan`). A kit with a kick part keys the sidechain by default, on its kick hits only (not the snare and the hats).

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.drumKit({ kick: 'psy-kick', snare: 'tight-snare', hat: { preset: 'closed-hat', pan: 0.2 } }).play(s.drums({ kick: 'x...x...', snare: '....x...', hat: 'x.x.x.xo' }), S.drop);
```

- Patterns: `s.drums({ kick: "x...x...", snare: "....x...", hat: "x.x.x.xo" })`.

| option | meaning |
|---|---|
| `(part)` | a preset name or `{ preset, ...overrides, gain: dB, pan: -1..1 }`; part names are free (kick, snare, hatC ...), the pattern lanes use them |
<!-- /gen -->

### Acoustic drum kit

<!-- gen:instrument:acousticKit -->
A rock / punk kit: kick, snare with rattling wires, rim shot, three toms, hi-hats, two crashes, ride, bell, splash and china, with a small room. Modal synthesis: drum heads are inharmonic decaying modes, harder hits get more high modes and more rattle. It does not key the sidechain unless the mix says `key: true` (then only its kick does).

Parts: `kick`, `snare`, `rim`, `hat`, `hatC`, `hatO`, `hatP`, `tomHi`, `tomMid`, `tomLo`, `crash`, `crash2`, `ride`, `bell`, `splash`, `china`.

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.acousticKit('punk-kit').play(s.drums({ kick: 'x...x.x.x...x.x.', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.xo', crash: 'X...............' }), S.drop);
```

- Lanes: `s.drums({ kick: "x...", snare: "....x...", hat: "x.x.x.xo", crash: "X..." })`; `hat` is the closed hat and `o` opens it, `hatC` / `hatO` / `hatP` address them directly.
- Hit characters: `x` normal, `X` accent, `g` ghost note, `r` rim shot (on the snare lane), `f` flam, `m` muted cymbal.

| option | meaning |
|---|---|
| `pan` | object of part -> pan (-1..1) to move parts in the stereo field (drummer's view by default) |

Parameters (all automatable; also usable as options):

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `level` | 0 | -30 .. 12 | dB | Trim in dB on top of the preset's calibrated loudness (0 = as calibrated; the fader is the channel's `gain` in the mix). |
| `kickTune` | 62 | 38 .. 110 | Hz | Kick drum fundamental. |
| `kickDecay` | 0.2 | 0.05 .. 0.7 | s | Kick ring time. |
| `kickClick` | 0.6 | 0 .. 1.5 |  | Beater click (punk kicks want a lot). |
| `kickGain` | 0 | -30 .. 12 | dB | Kick level inside the kit. |
| `snareTune` | 205 | 140 .. 340 | Hz | Snare head pitch. |
| `snareDecay` | 0.16 | 0.04 .. 0.6 | s | Snare ring time (head and wires). |
| `snareWires` | 0.8 | 0 .. 1.6 |  | Level of the snare wires (the rattle). |
| `snareSnap` | 0.5 | 0 .. 1.5 |  | Stick attack on the snare. |
| `snareGain` | 0 | -30 .. 12 | dB | Snare level inside the kit. |
| `tomTune` | 1 | 0.6 .. 1.7 |  | Pitch multiplier of the three toms. |
| `tomDecay` | 1 | 0.4 .. 2.2 |  | Ring-time multiplier of the toms. |
| `tomGain` | 0 | -30 .. 12 | dB | Tom level inside the kit. |
| `hatGain` | 0 | -30 .. 12 | dB | Hi-hat level inside the kit. |
| `hatTone` | 0 | -1 .. 1 |  | Hi-hat brightness shift. |
| `hatDecay` | 1 | 0.2 .. 1 |  | Open hat ring (1 = natural, lower = more damped). |
| `cymbalGain` | 0 | -30 .. 12 | dB | Crash / ride / splash / china level inside the kit. |
| `cymbalDecay` | 1 | 0.25 .. 1 |  | Cymbal ring (1 = natural, lower = quicker choke). |
| `room` | 0.35 | 0 .. 1.5 |  | Level of the room ambience. |
| `roomTime` | 0.45 | 0.1 .. 2 | s | Length of the room ambience. |
| `tight` | 0 | 0 .. 1 |  | Dampens all the drums (tape on the heads): shorter ring, drier sound. |

Presets:

| preset | what it is for | its settings (the rest are the defaults) |
|---|---|---|
| `rock-kit` | A natural, medium-sized rock kit with a lively room. |  |
| `punk-kit` | Tight, loud, clicky punk kit: high-tuned snare with plenty of rattle, short kick with a strong beater, bright hats, a small room. | kickTune 68, kickDecay 0.16, kickClick 0.95, snareTune 225, snareDecay 0.13, snareWires 1, snareSnap 0.8, tomTune 1.1, room 0.3, roomTime 0.35, hatTone 0.2, tight 0.15 |
| `dry-kit` | Close-miked, dry and tight (no room): easy to fit in a dense mix. | room 0.05, tight 0.5, kickDecay 0.14, snareDecay 0.11, kickClick 0.7 |
| `big-room-kit` | Large, open kit with a long room: epic punk / rock choruses. | kickTune 58, kickDecay 0.26, snareTune 195, snareDecay 0.2, room 0.8, roomTime 1.1, tomDecay 1.3 |
| `garage-kit` | Loose, lo-fi garage kit: low-tuned, rattly, boxy room. | kickTune 56, kickDecay 0.18, snareTune 180, snareDecay 0.2, snareWires 1.2, room 0.55, roomTime 0.3, hatTone -0.3, tomTune 0.85 |
<!-- /gen -->

### Synth

<!-- gen:instrument:synth -->
The flexible one: pads, supersaw chords, plucks, arps, leads, FM bells, organs. Up to three oscillator layers (saw, square, pulse, triangle, sine, noise, 2-operator FM) with unison, a 24 dB ladder or 12 dB state-variable filter, amp and filter ADSRs, vibrato, glide, two tempo-locked LFOs and a small modulation matrix.

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.synth('supersaw-pad', { reverb: 0.3 }).play(s.chords('Am | F | C | G', { octave: 3, lead: true }), S.drop);
```

- Chords: `s.chords("Am | F")`, or notes in brackets `[A2,E3,A3]`. A slide `~` glides from the note right before it in `mode: 'mono'` and `'legato'` (the lead presets); in the polyphonic default every note has its own voice and `~` does nothing.

| option | meaning |
|---|---|
| `layers` | array (1-3) of `{ wave, octave, semi, fine, level, unison (1-9), detune, phase }`; waves: saw square pulse tri sine noise fm; phase: 'random' (default), 'reset' (all voices start together: punchier) or 'free' (carries on: no clicks in mono) |
| `mode` | 'poly' (chords, default), 'mono' (last note priority, glide) or 'legato' (envelopes only retrigger when no key is held) |
| `voices` | polyphony in poly mode (default 8) |
| `filter` | 'ladder' (24 dB, default), 'lp' / 'hp' / 'bp' / 'notch' (12 dB) or 'off' |
| `mono` | force a mono (true) or stereo (false) output; default: stereo when any layer has unison > 1 |
| `mods` | array of `{ src: lfo1 / lfo2 / env / vel / key / rand, dst: cutoff / res / pitch / amp / pw / fm / drive, amount }` (cutoff in octaves, pitch in semitones) |
| `lfo1Shape / lfo2Shape` | sine tri saw ramp square smooth sh |
| `subWave` | 'sine' (default) or 'square' (the `sub` parameter's oscillator) |

Parameters (all automatable; also usable as options):

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `level` | 0 | -40 .. 24 | dB | Trim in dB on top of the preset's calibrated loudness (0 = as calibrated; the fader is the channel's `gain` in the mix). |
| `cutoff` | 6000 | 30 .. 20000 | Hz | Filter cutoff (before envelope, key tracking and modulation). |
| `res` | 0.15 | 0 .. 1 |  | Filter resonance (0.7+ rings, 0.95+ self-oscillates on the ladder). |
| `envAmt` | 0 | -6 .. 6 | octaves | How far the filter envelope opens (+) or closes (-) the cutoff, in octaves. |
| `keytrack` | 0.3 | 0 .. 1 |  | How much the cutoff follows the pitch of the note (1 = fully). |
| `velFilter` | 0.5 | 0 .. 4 | octaves | Extra cutoff opening at full velocity, in octaves. |
| `drive` | 0 | 0 .. 30 | dB | Saturation before the filter. |
| `attack` | 0.005 | 0.0005 .. 8 | s | Amplitude attack. |
| `decay` | 0.3 | 0.01 .. 8 | s | Amplitude decay to the sustain level. |
| `sustain` | 0.8 | 0 .. 1 |  | Amplitude sustain level (0 = a pluck that dies away on its own). |
| `release` | 0.25 | 0.005 .. 10 | s | Amplitude release after the note ends. |
| `fAttack` | 0.002 | 0.0005 .. 8 | s | Filter envelope attack. |
| `fDecay` | 0.35 | 0.01 .. 8 | s | Filter envelope decay. |
| `fSustain` | 0.3 | 0 .. 1 |  | Filter envelope sustain level. |
| `fRelease` | 0.3 | 0.005 .. 10 | s | Filter envelope release. |
| `unisonDetune` | 14 | 0 .. 100 | cents | Detune spread of the unison voices (each layer scales it by its own `detune`). |
| `spread` | 0.8 | 0 .. 1 |  | Stereo spread of the unison voices. |
| `pw` | 0.5 | 0.05 .. 0.95 |  | Pulse width of pulse-wave layers. |
| `pwmDepth` | 0 | 0 .. 0.45 |  | Pulse-width modulation depth (slow movement of the pulse width). |
| `pwmRate` | 0.5 | 0.02 .. 8 | Hz | Speed of the pulse-width modulation. |
| `sub` | 0 | 0 .. 1 |  | Level of a sine sub oscillator one octave below the first layer. |
| `noise` | 0 | 0 .. 1 |  | Level of white noise mixed into the oscillators. |
| `glide` | 0 | 0 .. 2 | s | Portamento time in mono / legato modes (a slide-flagged note always glides, at least 60 ms). |
| `vibDepth` | 0 | 0 .. 100 | cents | Vibrato depth (fades in after vibDelay). |
| `vibRate` | 5.5 | 0.5 .. 12 | Hz | Vibrato speed. |
| `vibDelay` | 0.25 | 0 .. 3 | s | Time before the vibrato starts. |
| `pEnv` | 0 | -48 .. 48 | semitones | Pitch envelope: every note starts this far above (+) or below (-) its pitch and slides in. |
| `pEnvTime` | 0.08 | 0.005 .. 2 | s | Time constant of the pitch envelope. |
| `bend` | 0 | -24 .. 24 | semitones | Pitch bend of the whole instrument (automate it for dives and rises). |
| `fmIndex` | 2 | 0 .. 16 |  | FM layers: modulation index (brightness). |
| `fmRatio` | 2 | 0.25 .. 16 |  | FM layers: modulator frequency as a ratio of the carrier (integers = harmonic, others = bell-like). |
| `fmDecay` | 0.4 | 0.01 .. 6 | s | FM layers: how fast the index falls after the attack (the "pluck" of an FM tone). |
| `fmSustain` | 0.2 | 0 .. 1 |  | FM layers: the fraction of the index that stays. |
| `fmFeedback` | 0 | 0 .. 1 |  | FM layers: feedback of the modulator (brighter, grittier). |
| `lfo1Rate` | 1 | 0.0625 .. 32 | cycles/beat | Speed of LFO 1, locked to the tempo (0.25 = one cycle per 4/4 bar, 2 = eighth notes). |
| `lfo1Depth` | 1 | 0 .. 1 |  | Master depth of LFO 1: it scales every `mods` entry that uses it (0 = off). |
| `lfo2Rate` | 0.25 | 0.0625 .. 32 | cycles/beat | Speed of LFO 2, locked to the tempo. |
| `lfo2Depth` | 1 | 0 .. 1 |  | Master depth of LFO 2. |
| `velAmp` | 0.6 | 0 .. 1 |  | How much velocity changes the loudness. |

Presets:

| preset | what it is for | its settings (the rest are the defaults) |
|---|---|---|
| `default` | A plain filtered saw: the starting point for your own patch. | layers saw, cutoff 5000, attack 0.005, decay 0.3, sustain 0.8, release 0.25 |
| `supersaw-pad` | Huge slow pad: six detuned saws and three more an octave down, soft attack, long release, gentle filter movement. Put fx.chorus() and some reverb on it. | filter lp, layers sawx6 + sawx3(-1 oct), unisonDetune 20, spread 1, cutoff 1800, res 0.1, envAmt 1.2, fAttack 0.8, fDecay 1.5, fSustain 0.5, attack 0.7, decay 1, sustain 0.9, release 1.6, keytrack 0.5 |
| `supersaw-chord` | Bright EDM / dubstep / trance supersaw chords: six saws detuned 24 cents and two more an octave up, quick attack, open filter. Melodic-dubstep staple. | filter lp, layers sawx6 + sawx2(+1 oct), unisonDetune 24, spread 1, cutoff 6500, res 0.1, envAmt 0.8, fDecay 0.6, fSustain 0.5, attack 0.008, decay 0.5, sustain 0.85, release 0.35, keytrack 0.6, drive 3, voices 10 |
| `supersaw-lead` | Soaring mono lead: seven saws and a square an octave down, glide, delayed vibrato. Needs a delay and reverb. | mode legato, voices 1, layers sawx7 + square(-1 oct), unisonDetune 16, spread 0.7, cutoff 7000, res 0.15, envAmt 0.6, fDecay 0.4, fSustain 0.6, attack 0.012, decay 0.3, sustain 0.9, release 0.3, glide 0.05, vibDepth 18, vibDelay 0.3, keytrack 0.7 |
| `saw-lead` | Classic synthwave lead: two detuned saws + a square octave down, resonant filter, a little glide. | mode legato, voices 1, mono false, layers sawx2 + square(-1 oct), unisonDetune 10, spread 0.5, cutoff 4200, res 0.3, envAmt 1.5, fDecay 0.5, fSustain 0.4, attack 0.006, decay 0.3, sustain 0.85, release 0.2, glide 0.04, vibDepth 10, vibDelay 0.25, keytrack 0.6 |
| `square-lead` | Hollow PWM lead (chiptune / 80s). | mode legato, voices 1, layers pulsex2, unisonDetune 8, spread 0.6, pw 0.35, pwmDepth 0.2, pwmRate 0.6, cutoff 3800, res 0.2, envAmt 1, fDecay 0.3, fSustain 0.6, attack 0.005, decay 0.2, sustain 0.9, release 0.15, glide 0.02 |
| `trance-lead` | Bright, resonant Goa / trance lead with a pluck at the start of each note and a long ring. | mode legato, voices 1, layers sawx5 + sawx3(+1 oct), unisonDetune 12, spread 0.7, cutoff 3200, res 0.35, envAmt 2.6, fDecay 0.28, fSustain 0.35, attack 0.004, decay 0.4, sustain 0.8, release 0.45, glide 0.03, keytrack 0.8 |
| `pluck` | Bright plucked synth: short, snappy, with a filter snap. For arps and melodies. | layers sawx2 + square(+1 oct), unisonDetune 8, spread 0.6, cutoff 1800, res 0.2, envAmt 3, fDecay 0.25, fSustain 0, attack 0.002, decay 0.35, sustain 0, release 0.15, keytrack 0.7, voices 10 |
| `dark-pluck` | Darksynth arp pluck: gritty saw + square, mid-heavy, quick filter snap. 16th-note arpeggios. | layers sawx2 + square(-1 oct), unisonDetune 10, spread 0.5, cutoff 1100, res 0.28, envAmt 3.2, fDecay 0.2, fSustain 0, attack 0.002, decay 0.28, sustain 0, release 0.1, keytrack 0.6, drive 4, voices 8 |
| `trance-pluck` | Psychedelic Goa arpeggio pluck: resonant, short, very bright snap. | layers sawx2 + saw(+1 oct), unisonDetune 6, spread 0.5, cutoff 1400, res 0.5, envAmt 3.6, fDecay 0.18, fSustain 0, attack 0.001, decay 0.22, sustain 0, release 0.08, keytrack 0.8, voices 8 |
| `arp-bright` | Short, bright, plinky arp voice for melodic music. | layers sawx3, unisonDetune 9, spread 0.8, cutoff 3500, res 0.15, envAmt 2, fDecay 0.18, fSustain 0.1, attack 0.002, decay 0.2, sustain 0.05, release 0.12, keytrack 0.8, voices 8 |
| `warm-pad` | Soft analog-style pad: detuned saws and triangle, dark filter, slow. | filter lp, layers sawx3 + tri(-1 oct), unisonDetune 14, spread 0.9, cutoff 1100, res 0.12, envAmt 0.8, fAttack 1.2, fDecay 2, fSustain 0.6, attack 0.9, decay 1, sustain 0.9, release 1.8, keytrack 0.4 |
| `string-pad` | String ensemble pad: lots of saws, slow bow. Add fx.chorus(). | filter lp, layers sawx5, unisonDetune 10, spread 1, cutoff 3200, res 0.05, envAmt 0.4, fAttack 0.5, fDecay 1.2, fSustain 0.7, attack 0.45, decay 0.6, sustain 0.95, release 0.9, keytrack 0.5, vibDepth 5, vibDelay 0.8 |
| `brass-stab` | Synthwave brass stab: saw stack with a filter swell on each hit. | filter lp, layers sawx4 + saw(-1 oct), unisonDetune 12, spread 0.7, cutoff 900, res 0.12, envAmt 2.8, fAttack 0.05, fDecay 0.4, fSustain 0.35, attack 0.02, decay 0.3, sustain 0.7, release 0.18, keytrack 0.6, voices 8, drive 2 |
| `organ` | Drawbar-style organ (sine layers at 8', 4' and 2 2/3'). | layers sine + sine(+1 oct) + sine(+1 oct), filter off, attack 0.008, decay 0.1, sustain 1, release 0.08, velAmp 0.2, mono true |
| `fm-bell` | DX-style bell: inharmonic FM ratio, index that dies away. | layers fm, fmRatio 3.5, fmIndex 4.5, fmDecay 1.2, fmSustain 0.05, filter off, attack 0.002, decay 2.2, sustain 0, release 0.8, mono true, voices 8 |
| `fm-epiano` | Electric piano (Rhodes-ish): FM with a tine overtone and a quickly falling index. | layers fm + sine, fmRatio 1, fmIndex 2.4, fmDecay 0.45, fmSustain 0.12, fmFeedback 0.1, filter off, attack 0.003, decay 1.4, sustain 0.25, release 0.4, mono true, voices 10 |
| `fm-bass-pluck` | Punchy FM pluck for melodic lines (works one or two octaves below middle C). | layers fm, fmRatio 1, fmIndex 3.2, fmDecay 0.12, fmSustain 0.1, filter off, attack 0.002, decay 0.3, sustain 0.4, release 0.15, mono true, voices 6, drive 3 |
| `psy-bass` | Goa / psytrance off-beat roll: one saw restarted on every note (each sixteenth hits the same), a ladder that snaps shut, mono. Play the three sixteenths after each kick: chords.roots({ rhythm: ".xxx", len: 1, low: 28 }). | mode mono, voices 1, mono true, layers saw, filter ladder, cutoff 600, res 0.35, envAmt 2.4, fAttack 0.0005, fDecay 0.09, fSustain 0.2, fRelease 0.01, keytrack 0, velFilter 0.2, attack 0.0008, decay 0.1, sustain 0.6, release 0.006, velAmp 0.15, drive 5 |
| `noise-pad` | Airy noise texture with a filter that follows the pitch (wind, breath). | layers noise, filter bp, cutoff 1500, res 0.55, keytrack 1, attack 1, decay 1, sustain 0.8, release 1.5, mono false, spread 1, unisonDetune 0 |
<!-- /gen -->

### Sub bass

<!-- gen:instrument:sub -->
A clean sine / triangle sub with optional harmonics and a pitch drop for 808 booms. Monophonic, with slides.

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.sub('sub-sine', { duck: 0.8 }).play(s.chords('Am | F | C | G').roots({ low: 28 }), S.drop);
```

Parameters (all automatable; also usable as options):

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `level` | 0 | -40 .. 12 | dB | Trim in dB on top of the preset's calibrated loudness (0 = as calibrated; the fader is the channel's `gain` in the mix). |
| `shape` | 0 | 0 .. 1 |  | 0 = pure sine, 1 = triangle (a little more body). |
| `harmonics` | 0.25 | 0 .. 1 |  | Saturation that adds 2nd/3rd harmonics so the bass is audible on small speakers. |
| `tone` | 900 | 80 .. 4000 | Hz | Low-pass on top of the harmonics. |
| `attack` | 0.004 | 0.0005 .. 1 | s | Attack time. |
| `decay` | 5 | 0.05 .. 8 | s | Decay time towards the sustain level. |
| `sustain` | 1 | 0 .. 1 |  | Sustain level (0 with a short decay gives a 808-style boom). |
| `release` | 0.1 | 0.005 .. 3 | s | Release time. |
| `glide` | 0 | 0 .. 1 | s | Portamento between successive notes. |
| `pEnv` | 0 | -24 .. 24 | semitones | Pitch drop at the start of every note (808 boom: 12). |
| `pEnvTime` | 0.05 | 0.005 .. 0.5 | s | Time constant of the pitch drop. |
| `velocity` | 0.4 | 0 .. 1 |  | How much velocity changes the level. |

Presets:

| preset | what it is for | its settings (the rest are the defaults) |
|---|---|---|
| `sub-sine` | Pure, clean sine sub with a touch of harmonics. The default low end. | shape 0, harmonics 0.2 |
| `sub-saturated` | Sub with strong harmonics: stays audible on laptop speakers and phones. | shape 0.3, harmonics 0.7, tone 1500 |
| `sub-tri` | Triangle sub: a rounder, fuller low end. | shape 1, harmonics 0.15 |
| `808-sub` | 808-style boom: pitch drop at the start and a long decay (set a note length of 1-2 beats). | shape 0, harmonics 0.35, pEnv 10, pEnvTime 0.05, decay 1.2, sustain 0, release 0.3, attack 0.002 |
<!-- /gen -->

### Darksynth bass

<!-- gen:instrument:darkBass -->
Distorted rolling bass: a saw pair and a square into saturation, a resonant ladder filter that pops open on every note, a second saturation and a clean sub. The non-linear stages run at 2x oversampling.

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.darkBass('darksynth-bass', { duck: 0.8 }).play(s.notes('A1 A1 A1 A1 A1 A1 A1 A1 C2 C2 C2 C2 D2 D2 E2! E2'), S.drop);
```

- Monophonic. `~` slides into the next note without retriggering the filter.

Parameters (all automatable; also usable as options):

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `level` | 0 | -40 .. 12 | dB | Trim in dB on top of the preset's calibrated loudness (0 = as calibrated; the fader is the channel's `gain` in the mix). |
| `cutoff` | 700 | 40 .. 9000 | Hz | Filter cutoff before the envelope opens it. |
| `res` | 0.25 | 0 .. 1 |  | Filter resonance. |
| `envAmt` | 3.2 | -4 .. 6 | octaves | How far the filter envelope opens the cutoff on every note (the "pluck" of a rolling bass). |
| `envDecay` | 0.22 | 0.02 .. 3 | s | How fast the filter closes again. |
| `envSustain` | 0.15 | 0 .. 1 |  | Filter envelope sustain level. |
| `drive` | 16 | 0 .. 42 | dB | Saturation before the filter: the growl. |
| `clip` | 8 | 0 .. 36 | dB | Saturation after the filter: weight and aggression. |
| `bias` | 0.12 | -0.6 .. 0.6 |  | Asymmetry of the saturation (even harmonics, a thicker sound). |
| `detune` | 9 | 0 .. 40 | cents | Detune between the two saws. |
| `saw` | 1 | 0 .. 1 |  | Level of the saw pair. |
| `square` | 0.5 | 0 .. 1 |  | Level of the square wave (a hollow body under the saws). |
| `pw` | 0.5 | 0.05 .. 0.95 |  | Pulse width of the square. |
| `sub` | 0.5 | 0 .. 1 |  | Level of a clean sine sub (not distorted). |
| `keytrack` | 0.3 | 0 .. 1 |  | How much the cutoff follows the pitch. |
| `glide` | 0 | 0 .. 1 | s | Portamento between successive notes (slide-flagged notes always glide). |
| `attack` | 0.002 | 0.0005 .. 1 | s | Amplitude attack. |
| `decay` | 0.6 | 0.02 .. 6 | s | Amplitude decay to the sustain level. |
| `sustain` | 1 | 0 .. 1 |  | Amplitude sustain level. |
| `release` | 0.06 | 0.005 .. 2 | s | Amplitude release. |
| `tone` | 7500 | 500 .. 18000 | Hz | Low-pass at the end of the chain. |
| `velocity` | 0.5 | 0 .. 1 |  | How much velocity changes the level. |
| `velFilter` | 0.6 | 0 .. 3 | octaves | Extra filter opening at full velocity. |

Presets:

| preset | what it is for | its settings (the rest are the defaults) |
|---|---|---|
| `darksynth-bass` | The rolling, distorted 16th-note bass of Carpenter Brut / Perturbator: saw pair + square, heavy drive, a filter that pops open on every note. |  |
| `dark-growl` | Meaner and more open: more drive, more resonance, slower filter. | drive 24, clip 12, res 0.4, envAmt 2.6, envDecay 0.32, cutoff 600, bias 0.2 |
| `dark-sustain` | A held, buzzing bass for half-time sections: the filter stays mostly open. | cutoff 900, envAmt 1.2, envDecay 0.5, envSustain 0.5, drive 18, release 0.12, decay 2 |
| `dark-pluck` | Short, tight bass notes with a very quick filter snap. | envAmt 3.8, envDecay 0.1, envSustain 0, decay 0.2, sustain 0.2, release 0.04, cutoff 500, drive 14 |
| `dark-clean` | Cleaner, warmer (less distortion): for verses and intros. | drive 6, clip 3, bias 0.05, cutoff 500, envAmt 2, res 0.15, square 0.3 |
<!-- /gen -->

### Reese bass

<!-- gen:instrument:reese -->
Detuned saws (three per side) that beat and swirl, a filter, saturation and a clean centred sub. Stereo.

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.reese('reese').play(s.notes('A1 - - - - - - - E1 - - - - - - -'), S.drop);
```

- For a rolling Goa / psytrance bass use the `rolling-bass` preset on `.xxx.xxx.xxx.xxx` with `duck: 1`: its notes are a sixteenth long. The other presets are made for held notes; on a sixteenth-note line their release (0.15 s) is longer than the step and the notes run into each other.
- It is stereo (`width` 0.8): a wide bass under a kick smears the low end, so keep `width` at 0.4 or less for a tight groove (`rolling-bass` does).

Parameters (all automatable; also usable as options):

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `level` | 0 | -40 .. 12 | dB | Trim in dB on top of the preset's calibrated loudness (0 = as calibrated; the fader is the channel's `gain` in the mix). |
| `detune` | 18 | 1 .. 60 | cents | Detune of the saws (the beating that makes the reese). |
| `drift` | 0.5 | 0 .. 1 |  | Slow movement of the detune (the phase-shifting "swirl"). |
| `driftRate` | 0.22 | 0.02 .. 4 | Hz | Speed of the swirl. |
| `cutoff` | 900 | 80 .. 8000 | Hz | Filter cutoff. |
| `res` | 0.22 | 0 .. 0.9 |  | Filter resonance. |
| `envAmt` | 1.2 | -4 .. 6 | octaves | Filter envelope amount. |
| `envDecay` | 0.5 | 0.02 .. 4 | s | Filter envelope decay. |
| `envSustain` | 0.5 | 0 .. 1 |  | Filter envelope sustain. |
| `drive` | 9 | 0 .. 36 | dB | Saturation after the filter. |
| `width` | 0.8 | 0 .. 1 |  | Stereo width of the saws (the sub stays centred). |
| `sub` | 0.6 | 0 .. 1 |  | Clean sine sub level. |
| `glide` | 0.03 | 0 .. 1 | s | Portamento (slide-flagged notes glide at least 60 ms). |
| `attack` | 0.01 | 0.0005 .. 2 | s | Attack. |
| `decay` | 1 | 0.02 .. 6 | s | Decay. |
| `sustain` | 1 | 0 .. 1 |  | Sustain. |
| `release` | 0.15 | 0.005 .. 3 | s | Release. |
| `tone` | 9000 | 500 .. 18000 | Hz | Low-pass at the end. |
| `velocity` | 0.4 | 0 .. 1 |  | How much velocity changes the level. |

Presets:

| preset | what it is for | its settings (the rest are the defaults) |
|---|---|---|
| `reese` | Classic reese: three detuned saws per side that beat and swirl, dark filter, a clean sub underneath. Melodic dubstep / DnB bass. |  |
| `reese-wide` | Wider, brighter reese for drops: more detune and drift, more drive. | detune 28, drift 0.8, width 1, cutoff 1500, drive 14, res 0.3 |
| `reese-dark` | Dark, menacing, slow: low cutoff, little movement. | detune 12, drift 0.3, cutoff 500, envAmt 0.6, drive 7 |
| `reese-neuro` | Aggressive neuro bass: heavy drive, resonant filter. | detune 22, drift 0.9, driftRate 0.6, cutoff 1100, res 0.5, drive 22, envAmt 2, envDecay 0.25 |
| `rolling-bass` | Goa / psytrance off-beat bass: short plucky notes (the filter snaps open and shut in 80 ms, release 40 ms) so that a sixteenth-note line stays separate, and narrow so that it sits tight under the kick. Play it on the three sixteenths after each kick (`.xxx.xxx.xxx.xxx`) with `duck: 1`. | cutoff 700, width 0.4, envAmt 2, envDecay 0.08, decay 0.15, sustain 0.4, release 0.04 |
<!-- /gen -->

### Growl bass

<!-- gen:instrument:growl -->
Dubstep bass: a saw pair and an FM oscillator through a wavefolder and saturation, two vowel (formant) band-pass filters and a 24 dB ladder, all moved by a tempo-synced LFO, plus a clean sub. Non-linear stages at 2x oversampling.

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.growl('dubstep-growl').play(s.notes('A1:8 C2:8 | D2:8 A1:8'), S.drop);
```

- Play held notes of a beat or more. With `lfoSync: 'note'` (the default) every note restarts the wobble, so a note shorter than one cycle never shows it: at `lfoRate` 1 that means notes shorter than a beat. For a rhythmic line of short notes use `lfoSync: 'beat'`: the wobble then runs on the beat grid whatever the notes do, and the rests between notes cut it into pieces.
- Automate `lfoRate` (0.5 half notes, 1 quarters, 2 eighths, 4 sixteenths) for the classic speed-ups. Changing it while a note sounds bends the wobble's speed; the phase does not jump (put the change on a beat if you want it to line up).
- A note starts with the wobble at `lfoPhase` of its cycle: with a sine at 0 the filter is half open and opening; `lfoPhase` 0.75 starts closed and opens (the classic "wub" attack), 0.25 starts open and closes.
- The growl has a sub of its own (`sub`, 0.5). When you play a separate `s.sub` under it, set `sub: 0` on the growl (and `hp: 60` in its strip) so the two do not add up and beat. Its sweet spot is F1 to A2 (the `screech` preset: C3 to C4).
- A pitch dive: `pEnv` (up to 24 semitones either way) starts every new note that far above its pitch (below it, for a negative value) and settles into it within `pEnvTime` seconds, fast at first. The offset falls exponentially in semitones, half of it is gone after a seventh of the time and it is exactly gone when the time is up (a total, like the sidechain's `release`, not the time constant of the synth's and the sub's `pEnvTime`). `pEnv: 12, pEnvTime: 0.08` is the classic dive from an octave up in 80 ms. The growl's own sub dives with the rest, so the two never beat; a tied (`~`) note is not dived again, a note after a rest or a plain next note is. 0, the default, is off and changes nothing; automate `pEnv` to open a build with dives.

| option | meaning |
|---|---|
| `lfoShape` | sine tri saw ramp square smooth sh |
| `lfoSync` | 'note' (default: the wobble restarts at every note) or 'beat' (locked to the song's beat grid) |

Parameters (all automatable; also usable as options):

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `level` | 0 | -40 .. 12 | dB | Trim in dB on top of the preset's calibrated loudness (0 = as calibrated; the fader is the channel's `gain` in the mix). |
| `cutoff` | 500 | 40 .. 9000 | Hz | Filter cutoff at the closed end of the wobble. |
| `res` | 0.4 | 0 .. 1 |  | Filter resonance. |
| `lfoRate` | 1 | 0.125 .. 16 | cycles/beat | Wobble speed, locked to the tempo: 0.5 = half notes, 1 = quarter notes, 2 = eighths, 3 = eighth triplets, 4 = sixteenths. Changing it while a note sounds bends the speed; the wobble does not jump. |
| `lfoPhase` | 0 | 0 .. 1 | cycles | Where in its cycle the wobble is when a note starts (lfoSync "note") or on the beat (lfoSync "beat"). A sine at 0 starts half open and opens; 0.25 starts fully open and closes; 0.5 starts half open and closes; 0.75 starts closed and opens (saw: starts closed at 0, ramp and square: open). |
| `lfoDepth` | 2.6 | 0 .. 6 | octaves | How far the wobble opens the filter above `cutoff`. |
| `lfoFm` | 1.5 | 0 .. 10 |  | How much the wobble moves the FM index (the "yoi" in the tone). |
| `lfoVowel` | 0.6 | 0 .. 3 |  | How far the wobble moves through the vowels (formant filter). |
| `vowel` | 0 | 0 .. 4 |  | Vowel position of the formant filter: 0 A, 1 E, 2 I, 3 O, 4 U. |
| `formant` | 0.5 | 0 .. 1 |  | Mix of the formant (vowel) filter. |
| `fmMix` | 0.5 | 0 .. 1 |  | Mix of the FM oscillator against the saws. |
| `fmRatio` | 1 | 0.25 .. 8 |  | FM modulator ratio (1 / 2 / 3 harmonic, 1.5 / 2.5 gnarlier). |
| `fmIndex` | 3 | 0 .. 12 |  | FM index (base brightness). |
| `drive` | 14 | 0 .. 40 | dB | Saturation before the filters. |
| `fold` | 0.25 | 0 .. 1 |  | Wavefolder amount (harsh, metallic overtones). |
| `clip` | 6 | 0 .. 30 | dB | Saturation after the filters. |
| `comb` | 0 | 0 .. 0.95 |  | Comb filter feedback (robotic, hollow resonance tuned to the note). |
| `sub` | 0.5 | 0 .. 1 |  | Level of a clean sine sub under the growl. |
| `detune` | 12 | 0 .. 40 | cents | Detune between the two saws. |
| `envAmt` | 0 | -4 .. 6 | octaves | Extra filter opening at the start of each note. |
| `envDecay` | 0.15 | 0.02 .. 3 | s | Decay of that opening. |
| `glide` | 0 | 0 .. 1 | s | Portamento. |
| `pEnv` | 0 | -24 .. 24 | semitones | Pitch dive: every new note starts this far above (+) or below (-) its pitch and settles into it within `pEnvTime`, fast at first (the classic dive into the note). A tied (~) note is not re-enveloped; the growl's own sub dives with it. 0 = off. |
| `pEnvTime` | 0.08 | 0.005 .. 1 | s | How long the dive takes: the offset falls exponentially in semitones (half of it is gone after a seventh of this time, 92 % after half of it) and is exactly gone when the time is up. A total, not a time constant like the synth's `pEnvTime`. |
| `attack` | 0.003 | 0.0005 .. 1 | s | Attack. |
| `decay` | 1 | 0.02 .. 6 | s | Decay. |
| `sustain` | 1 | 0 .. 1 |  | Sustain. |
| `release` | 0.08 | 0.005 .. 3 | s | Release. |
| `tone` | 9000 | 500 .. 18000 | Hz | Low-pass at the end. |
| `velocity` | 0.4 | 0 .. 1 |  | How much velocity changes the level. |

Presets:

| preset | what it is for | its settings (the rest are the defaults) |
|---|---|---|
| `dubstep-growl` | The classic growl: saw + FM, vowel formants morphing with a quarter-note wobble, heavy distortion. Use on held bass notes of 1-2 beats in half-time drops. |  |
| `wub` | Simple big "wub": saw pair, no formants, an eighth-note wobble on the filter (the cleanest, most predictable bass). | fmMix 0.15, formant 0, lfoRate 2, lfoDepth 3.2, lfoFm 0.5, lfoVowel 0, drive 10, fold 0.1, res 0.5, cutoff 260 |
| `yoi` | Talking "yoi-yoi" growl: vowels sweep strongly, slower wobble. | formant 0.85, lfoVowel 2.4, lfoRate 0.5, lfoDepth 1.2, vowel 0.3, fmMix 0.4, drive 16, res 0.35, cutoff 700 |
| `riddim` | Riddim: square-wave gating wobble at triplet speed, folded and brutal. | lfoRate 3, lfoDepth 3.6, fold 0.5, drive 20, formant 0.3, lfoVowel 0.5, fmMix 0.3, res 0.45, cutoff 220 |
| `neuro` | Neuro-style: fast sample-and-hold movement, resonant and metallic (comb on). | lfoRate 4, lfoDepth 2, lfoFm 3.5, lfoVowel 1.5, comb 0.5, fmMix 0.6, fmRatio 1.5, drive 24, fold 0.35, res 0.55, cutoff 600, clip 10 |
| `screech` | High, bright, screaming FM lead-bass for melodic dubstep fills (play it around C3-C4). | cutoff 2600, lfoDepth 1.5, lfoRate 1, fmMix 0.85, fmIndex 5, lfoFm 4, fmRatio 2, formant 0.6, vowel 1.5, lfoVowel 1, drive 18, fold 0.3, sub 0.15, res 0.5 |
<!-- /gen -->

### Acid bass

<!-- gen:instrument:acid -->
A sawtooth / square into a resonant ladder filter (taken at the 18 dB point) with a decaying envelope, accents and slides, then overdrive.

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.acid('acid-303').play(s.notes('A1 . A1 A2! . A1 . A1 C2~ . A1 A1 E2! . G1 A1~'), S.drop); // ~ glides INTO C2 from the A1 right before it, and into the last A1 from G1
```

- `!` accents a note (louder, bigger sweep, builds up on consecutive accents). Automate `cutoff` upward over a build.
- `~` goes on the note you glide **into**, and that note must follow another note directly: `A1 C2~` glides from A1 up to C2 without retriggering (the filter envelope keeps running). After a rest (`A1 . C2~`) there is nothing to glide from: the mark does nothing and the arrangement listing says `slide(not tied)`.

Parameters (all automatable; also usable as options):

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `level` | 0 | -40 .. 12 | dB | Trim in dB on top of the preset's calibrated loudness (0 = as calibrated; the fader is the channel's `gain` in the mix). |
| `cutoff` | 380 | 60 .. 6000 | Hz | Base cutoff: where the filter sits when closed. Sweep it up over a build-up. |
| `res` | 0.78 | 0 .. 1 |  | Resonance: the squelch (0.9+ nearly self-oscillates). |
| `envMod` | 0.65 | 0 .. 1 |  | How far every note opens the filter (0.5 gentle, 1 = wide open). |
| `decay` | 0.28 | 0.05 .. 2 | s | How fast the filter closes after each note (short = plucky, long = open and wailing). |
| `accent` | 0.75 | 0 .. 1 |  | Strength of accented notes (!): louder, a bigger filter sweep, shorter decay; consecutive accents build up. |
| `slide` | 0.06 | 0.01 .. 0.5 | s | Glide time of slid notes (~). |
| `square` | 0 | 0 .. 1 |  | Waveform: 0 = sawtooth, 1 = square (hollow). |
| `drive` | 7 | 0 .. 36 | dB | Overdrive after the filter (the dirty acid sound). |
| `tone` | 7000 | 800 .. 18000 | Hz | Low-pass after the overdrive. |
| `tune` | 0 | -100 .. 100 | cents | Fine tuning. |
| `release` | 0.02 | 0.005 .. 1 | s | Amplitude release at the end of a note. |

Presets:

| preset | what it is for | its settings (the rest are the defaults) |
|---|---|---|
| `acid-303` | The TB-303: sawtooth into a resonant ladder, filter envelope, accents (!) and slides (~). Write 16-step lines with ! and ~ for the squelch. |  |
| `goa-acid` | Goa / psytrance acid: high resonance, fast filter decay, strong accents, driven. For 16th-note lines at 140-148 BPM. | cutoff 420, res 0.86, envMod 0.8, decay 0.19, accent 0.9, drive 11, slide 0.05 |
| `acid-soft` | Gentle acid: less resonance, longer decay, lightly driven (verses, intros, slow builds). | cutoff 520, res 0.5, envMod 0.45, decay 0.45, accent 0.5, drive 3 |
| `acid-square` | Hollow, squarer acid. | square 1, cutoff 460, res 0.7, envMod 0.6, decay 0.3, drive 6 |
| `acid-screamer` | Wide-open screaming acid for peaks: very high resonance and a big envelope. | cutoff 600, res 0.93, envMod 1, decay 0.22, accent 1, drive 16 |
<!-- /gen -->

### Riser

<!-- gen:instrument:riser -->
Swept noise plus a rising (or falling) pitched tone. The length of the note or hit is the length of the sweep.

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.riser('riser').hit(S.drop.bar - 4, '', 1, 0, 16); // 16 beats: four bars of sweep
```

- `riser.hit(bar, "", vel, 0, beats)` plays a sweep of `beats` beats; a note pattern works too (`s.notes("A3:16")` = one bar).

| option | meaning |
|---|---|
| `direction` | 'up' (riser), 'down' (downlifter) or 'swell' (whoosh); presets set it |

Parameters (all automatable; also usable as options):

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `level` | 0 | -40 .. 12 | dB | Trim in dB on top of the preset's calibrated loudness (0 = as calibrated; the fader is the channel's `gain` in the mix). |
| `startHz` | 220 | 40 .. 12000 | Hz | Centre of the noise band at the start of the sweep. |
| `endHz` | 9000 | 100 .. 18000 | Hz | Centre of the noise band at the end of the sweep. |
| `q` | 1.6 | 0.4 .. 10 |  | Narrowness of the noise band (higher = more whistle-like). |
| `noise` | 0.9 | 0 .. 1.5 |  | Level of the swept noise. |
| `tone` | 0.35 | 0 .. 1.5 |  | Level of the pitched sweep (a saw stack rising with the noise). |
| `toneStart` | 110 | 30 .. 4000 | Hz | Pitch of the tone at the start. |
| `toneEnd` | 1760 | 60 .. 8000 | Hz | Pitch of the tone at the end. |
| `detune` | 18 | 0 .. 60 | cents | Detune of the tone voices (thickness). |
| `width` | 1 | 0 .. 1 |  | Stereo width of the noise. |
| `curve` | 2 | 0.5 .. 5 |  | Shape of the build: 1 linear, 2 accelerating, higher = most of the rise at the very end. |
| `swell` | 2.2 | 0.5 .. 5 |  | Shape of the loudness build (higher = quieter for longer, then a rush). |
| `tail` | 30 | 2 .. 400 | ms | Fade-out at the end of the sweep (short = cut on the downbeat). |
| `drive` | 3 | 0 .. 24 | dB | Saturation. |

Presets:

| preset | what it is for | its settings (the rest are the defaults) |
|---|---|---|
| `riser` | Classic build-up: swept noise plus a rising tone. The note length is the length of the build (4-16 beats). | direction up |
| `riser-bright` | Higher, whistling riser (narrow band, high start). | direction up, startHz 700, endHz 14000, q 4, toneStart 440, toneEnd 3520, tone 0.5 |
| `riser-dark` | Low, rumbling build with a growing tone: darksynth. | direction up, startHz 90, endHz 4000, q 1.2, toneStart 55, toneEnd 880, tone 0.5, drive 8 |
| `downlifter` | Falling sweep that fades away: for after a drop or into a break. | direction down, startHz 120, endHz 9000, tone 0.3 |
| `whoosh` | Swell up and back down (transitions between sections). | direction swell, startHz 200, endHz 7000, tone 0.1, q 1.2 |
| `noise-wash` | Pure noise swell (no tone): drum-roll style build or a big breath. | direction up, tone 0, q 0.8, startHz 300, endHz 12000 |
<!-- /gen -->

### Impact

<!-- gen:instrument:impact -->
A pitch-dropping sub boom, a low thump, a crack and a rumbling tail.

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.impact('impact-deep').hit(S.drop.bar, '', 1);
```

Parameters (all automatable; also usable as options):

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `level` | 0 | -40 .. 12 | dB | Trim in dB on top of the preset's calibrated loudness (0 = as calibrated; the fader is the channel's `gain` in the mix). |
| `subHz` | 36 | 20 .. 100 | Hz | The pitch the sub boom settles on. |
| `drop` | 1.3 | 0 .. 3 | octaves | How far above `subHz` the boom starts. |
| `decay` | 2.2 | 0.2 .. 6 | s | Length of the boom. |
| `thump` | 0.8 | 0 .. 1.5 |  | Level of the low noise thump. |
| `crack` | 0.5 | 0 .. 1.5 |  | Level of the high crack at the start. |
| `rumble` | 0.5 | 0 .. 1 |  | Level of the slow, wide rumble tail. |
| `drive` | 8 | 0 .. 30 | dB | Saturation. |

Presets:

| preset | what it is for | its settings (the rest are the defaults) |
|---|---|---|
| `impact` | Big cinematic impact: pitch-dropping sub boom, low thump, crack and a rumbling tail. Land it on the first beat of a drop. |  |
| `impact-short` | Tighter impact for fast music. | decay 1.1, drop 1, thump 0.9, rumble 0.25 |
| `impact-deep` | Very low and long, mostly sub. | subHz 30, decay 3.2, drop 1.6, crack 0.2, rumble 0.7 |
| `boom` | Dry boom with no tail: for accents. | decay 0.7, rumble 0, crack 0.3, thump 1 |
<!-- /gen -->

### Zap

<!-- gen:instrument:zap -->
Falling lasers, FM zaps, long pitch falls and sirens.

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.zap('zap-fm').hit(S.drop.bar - 0.25, '', 1);
```

| option | meaning |
|---|---|
| `wave` | 'saw' (default), 'sine' or 'square' |

Parameters (all automatable; also usable as options):

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `level` | 0 | -40 .. 12 | dB | Trim in dB on top of the preset's calibrated loudness (0 = as calibrated; the fader is the channel's `gain` in the mix). |
| `startHz` | 4000 | 50 .. 12000 | Hz | Pitch at the start. |
| `endHz` | 80 | 20 .. 8000 | Hz | Pitch at the end. |
| `time` | 0.18 | 0.02 .. 3 | s | Time constant of the pitch move. |
| `decay` | 0.35 | 0.04 .. 4 | s | Amplitude decay. |
| `fm` | 0 | 0 .. 12 |  | FM amount (metallic / alien). |
| `sirenRate` | 0 | 0 .. 8 | Hz | Siren: pitch wobble speed (0 = off). |
| `sirenDepth` | 0 | 0 .. 24 | semitones | Siren: pitch wobble depth. |
| `drive` | 4 | 0 .. 30 | dB | Saturation. |

Presets:

| preset | what it is for | its settings (the rest are the defaults) |
|---|---|---|
| `zap` | Laser zap: a fast falling saw. | wave saw |
| `zap-fm` | Alien FM zap. | wave sine, fm 6, startHz 2400, endHz 120, time 0.25, decay 0.5 |
| `siren` | Wailing siren (long notes): a held pitch with a slow wobble. | wave saw, startHz 700, endHz 700, sirenRate 0.7, sirenDepth 7, decay 4, time 0.05, drive 8 |
| `pitch-fall` | A long falling tone (tape-stop feel). | wave sine, startHz 1200, endHz 40, time 0.8, decay 1.4, drive 2 |
<!-- /gen -->

### Electric guitar

<!-- gen:instrument:guitar -->
Plucked-string waveguides (extended Karplus-Strong with pick position, a pickup comb, damping and palm muting), strummed chords, into an amp (noise gate, tight filter, screamer boost, three asymmetric gain stages at 2x oversampling, tone stack, sagging power amp) and a cabinet. Two takes, double-tracked hard left and right, by default.

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.guitar('punk-guitar').play(s.notes('[A2,E3,A3]{pm}:2 [A2,E3,A3]{pm}:2 [C3,G3,C4]!:4 [A2,E3,A3]:8'), S.drop);
```

- Notes are MIDI pitches: a power chord is `[A2,E3,A3]` (or `guitarChord("A5")`), an open chord `guitarChord("Em")`. The strings of a chord start `strum` ms apart, low to high (high to low with `{up}`).
- Articulations: `{pm}` palm mute, `{ring}` let ring, `?` dead / ghost note, `!` accent, `~` slide up into the note, `{up}` up-stroke.

| option | meaning |
|---|---|
| `takes` | 1 = one guitar (mono), 2 = a double-tracked pair hard left and right (default, stereo) |
| `cab` | '4x12' (default), '2x12', '1x12' or 'none' |
| `voices` | strings that can sound at once per take (default 8) |
| `pan` | default channel pan for a single take (the presets punk-guitar-L / -R use -1 / 1) |

Parameters (all automatable; also usable as options):

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `level` | 0 | -30 .. 12 | dB | Trim in dB on top of the preset's calibrated loudness (0 = as calibrated; the fader is the channel's `gain` in the mix). |
| `gain` | 0.65 | 0 .. 1 |  | Amp gain: 0 clean, 0.3 crunch, 0.6 punk / hard rock, 0.85 high-gain metal. |
| `tight` | 0.5 | 0 .. 1 |  | How much low end is cut before the distortion (tighter, more focused chugs). |
| `bass` | 0 | -12 .. 12 | dB | Tone stack: bass. |
| `mid` | 1 | -12 .. 12 | dB | Tone stack: mids (negative = scooped metal tone, positive = honky rock). |
| `treble` | -0.5 | -12 .. 12 | dB | Tone stack: treble. |
| `presence` | -1.5 | -12 .. 12 | dB | Tone stack: presence (the fizz and air on top). |
| `boost` | 0.4 | 0 .. 1 |  | Screamer-style mid boost in front of the amp: focus and push. |
| `sag` | 0.4 | 0 .. 1 |  | Power-amp sag: compression and softness on loud notes. |
| `gate` | -62 | -90 .. -30 | dB | Noise-gate threshold (-90 = off): cuts the hiss-like tail of a note that is fading out. |
| `cabBright` | 0 | -1 .. 1 |  | Cabinet brightness (mic nearer the centre of the speaker cone = brighter). |
| `decay` | 2.6 | 0.3 .. 8 | s | How long an open string rings (time to -60 dB). |
| `bright` | 0.55 | 0 .. 1 |  | Brightness of the strings: how well the high harmonics survive. |
| `pickPos` | 0.17 | 0.05 .. 0.5 |  | Where the string is picked (near the bridge = thinner and brighter). |
| `pickHard` | 0.65 | 0 .. 1 |  | Pick hardness (attack brightness). |
| `pickup` | 0.14 | 0 .. 0.35 |  | Pickup position from the bridge (0 = off; neck pickups are further). |
| `strum` | 7 | 0 .. 40 | ms | Time between the strings of a strummed chord. |
| `timing` | 4 | 0 .. 30 | ms | Random timing error of each take (the looseness of a human double-track). |
| `detune` | 3 | 0 .. 20 | cents | Random tuning error of each take. |
| `muteDecay` | 0.16 | 0.04 .. 0.6 | s | Ring time of palm-muted notes. |
| `muteDark` | 0.86 | 0 .. 0.97 |  | How dark a palm-muted note gets after its pick click (the palm kills the high harmonics first): 0 = only shorter, 0.9 = a deep chug. |
| `releaseDamp` | 0.04 | 0.01 .. 0.5 | s | How quickly the strings are silenced at the end of a note (unless {ring}). |
| `attackBend` | 0.12 | 0 .. 1 | semitones | Sharpness of a hard-picked string at the very start (it settles within 40 ms). |
| `vibrato` | 0 | 0 .. 1.5 | semitones | Finger vibrato on held notes: how far the pitch swings up and back (0 = none; 0.3-0.5 for a singing lead). |
| `vibratoRate` | 5.6 | 1 .. 10 | Hz | Speed of the vibrato. |
| `vibratoDelay` | 0.2 | 0 .. 1.5 | s | How long a note sounds before the vibrato starts (then it fades in over 0.25 s): short notes stay straight. |
| `bend` | 0 | -12 .. 12 | semitones | String bend of every sounding string (automate it: `lead.auto('bend', ...)` bends a held note up and back). |
| `pickVar` | 0.1 | 0 .. 0.4 |  | Random variation of the pick position and hardness from note to note (a human hand never picks twice the same). |
| `velocity` | 0.7 | 0 .. 1 |  | How much velocity changes the picking strength and brightness. |
| `width` | 1 | 0 .. 1 |  | Stereo width of a double-tracked pair (1 = hard left and right, 0 = both in the centre). |

Presets:

| preset | what it is for | its settings (the rest are the defaults) |
|---|---|---|
| `punk-guitar` | Double-tracked punk rhythm guitar (hard left and right): a Marshall-style crunch with plenty of mids, tight palm mutes. Use power chords like [A2,E3,A3] and {pm} for the chugging verses. | takes 2, gain 0.62, tight 0.5, bass 1.5, mid 0.5, treble 2, presence 2, boost 0.45, strum 5, timing 5 |
| `punk-guitar-L` | Single punk guitar panned hard LEFT (use with punk-guitar-R playing the same part for a manual double-track, or a different part for harmony). | takes 1, pan -1, gain 0.62, tight 0.5, bass 1.5, mid 0.5, treble 2, presence 2, boost 0.45, strum 5, timing 6, detune 4 |
| `punk-guitar-R` | Single punk guitar panned hard RIGHT (slightly different tone from -L for a realistic double-track). | takes 1, pan 1, gain 0.66, tight 0.45, bass 1, mid 1, treble 2.5, presence 2.5, boost 0.4, strum 5, timing 6, detune 4, cabBright 0.2 |
| `power-chord-wall` | Bigger and thicker for choruses: more gain, more low end, longer strum. | takes 2, gain 0.72, tight 0.4, bass 3, mid 0, treble 2, presence 2, boost 0.5, sag 0.5, strum 7 |
| `crunch-guitar` | Open, ringing crunch (lighter gain): strummed open chords like E, A, D, Em, Am. | takes 2, gain 0.42, tight 0.3, bass 1, mid 1, treble 3.5, presence 3, cabBright 0.8, boost 0.2, sag 0.5, strum 9, decay 3.2, bright 0.65 |
| `clean-guitar` | Clean, chiming electric guitar (intros, quiet parts). | takes 1, gain 0.05, tight 0.2, bass 0, mid 0, treble 3, presence 3, boost 0, sag 0.1, gate -80, strum 10, decay 3.5, bright 0.7, cab 2x12 |
| `lead-guitar` | Singing lead: higher gain with a mid push, single mono take, finger vibrato on held notes (play single notes; slides ~ and an automated bend add expression). | takes 1, gain 0.8, tight 0.35, bass -1, mid 2, treble 1, presence 1, boost 0.7, sag 0.4, strum 0, decay 4, bright 0.6, pickPos 0.22, pickup 0.2, vibrato 0.4, vibratoRate 5.6, vibratoDelay 0.2 |
| `metal-guitar` | High-gain scooped tone with very tight palm mutes (for heavier moments). | takes 2, gain 0.88, tight 0.75, bass 2, mid -3, treble 3, presence 3, boost 0.65, sag 0.3, strum 4 |
<!-- /gen -->

### Bass guitar

<!-- gen:instrument:bassGuitar -->
A plucked-string model (picked or fingered) through a bass amp with compression, overdrive and an 8x10 cabinet. Effectively monophonic.

Example (`S.drop` is a section declared with `s.sections({ ... })`):

```ts
s.bassGuitar('punk-bass').play(s.notes('A1 A1 A1 A1 A1 A1 A1 A1 C2 C2 D2 D2 E2 E2 E2 E2'), S.drop);
```

- `{pm}` palm mute, `?` ghost note, `~` slide, `{ring}` let ring.

| option | meaning |
|---|---|
| `cab` | 'bass-8x10' (default), 'bass-1x15' or 'none' |

Parameters (all automatable; also usable as options):

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `level` | 0 | -30 .. 12 | dB | Trim in dB on top of the preset's calibrated loudness (0 = as calibrated; the fader is the channel's `gain` in the mix). |
| `decay` | 2.4 | 0.3 .. 6 | s | How long an open string rings. |
| `bright` | 0.5 | 0 .. 1 |  | Brightness of the strings (round vs clanky). |
| `pickPos` | 0.2 | 0.08 .. 0.5 |  | Where the string is plucked (near the bridge = more attack). |
| `pickHard` | 0.55 | 0 .. 1 |  | Pick / finger hardness (attack brightness). |
| `pickup` | 0.2 | 0 .. 0.4 |  | Pickup position (0 = off). |
| `drive` | 0.35 | 0 .. 1 |  | Overdrive in the bass amp. |
| `comp` | 0.45 | 0 .. 1 |  | Compression in the bass amp. |
| `bass` | 2 | -12 .. 12 | dB | Tone: bass. |
| `mid` | 0 | -12 .. 12 | dB | Tone: mids. |
| `treble` | 2 | -12 .. 12 | dB | Tone: treble. |
| `muteDecay` | 0.2 | 0.05 .. 0.8 | s | Ring time of palm-muted notes. |
| `releaseDamp` | 0.06 | 0.01 .. 0.6 | s | How quickly the string is silenced at the end of a note (unless {ring}). |
| `attackBend` | 0.08 | 0 .. 0.6 | semitones | Pitch sharpness of a hard pluck at the very start. |
| `velocity` | 0.6 | 0 .. 1 |  | How much velocity changes the pluck. |

Presets:

| preset | what it is for | its settings (the rest are the defaults) |
|---|---|---|
| `punk-bass` | Picked, bright, driven punk bass: roots in eighth notes (with {pm} for the muted verses). | bright 0.65, pickHard 0.75, pickPos 0.17, drive 0.4, comp 0.5, bass 2, treble 2.5 |
| `rock-bass` | Round, growly rock bass with a little drive. | bright 0.5, pickHard 0.5, drive 0.28, comp 0.4, mid 1.5 |
| `finger-bass` | Warm fingerstyle bass, clean and round. | bright 0.3, pickHard 0.2, pickPos 0.3, drive 0.05, comp 0.35, bass 3, treble 0, decay 3 |
| `dirty-bass` | Fuzzy, overdriven bass for garage and noisy parts. | bright 0.6, pickHard 0.7, drive 0.75, comp 0.5, mid 2, treble 1 |
<!-- /gen -->

## Reference B. Insert effects: parameters

### drive

<!-- gen:fx:drive -->
Waveshaper with 2x oversampling: soft (tanh), tube (asymmetric), hard clip or wavefolder, with tone and level. `fx.drive({ mode: "tube", drive: 14 })`.

Example:

```ts
s.darkBass('darksynth-bass', { fx: [fx.drive({ mode: 'tube', drive: 14 })] }).play(s.notes('A1:8 C2:8'), S.drop);
```

| option | meaning |
|---|---|
| `mode` | 'soft' (default), 'tube', 'hard' or 'fold' |
| `oversample` | false turns the 2x oversampling off (cheaper, a bit grittier) |

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `drive` | 12 | 0 .. 48 | dB | Gain into the shaper: more drive, more harmonics and compression. |
| `bias` | 0 | -1 .. 1 |  | DC offset into the shaper: adds even harmonics (asymmetric clipping). |
| `tone` | 9000 | 200 .. 20000 | Hz | Low-pass after the shaper (tames the fizz). |
| `level` | 0 | -30 .. 12 | dB | Output trim after the shaper. |
| `mix` | 1 | 0 .. 1 |  | Dry/wet. |
<!-- /gen -->

### chorus

<!-- gen:fx:chorus -->
Stereo chorus / flanger: modulated delay taps, a different modulation phase per side. Widens mono sources. `fx.chorus({ rate: 0.4, depth: 5 })`.

Example:

```ts
s.synth('supersaw-pad', { fx: [fx.chorus({ rate: 0.4, depth: 5 })] }).play(s.chords('Am', { octave: 3 }), S.drop);
```

| option | meaning |
|---|---|
| `voices` | delay taps per side (1-4, default 3) |

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `rate` | 0.6 | 0.02 .. 10 | Hz | LFO speed. |
| `depth` | 3.5 | 0 .. 15 | ms | Modulation depth of the delay taps. |
| `delay` | 14 | 1 .. 40 | ms | Centre delay (short = flanger, 12-25 = chorus). |
| `feedback` | 0 | -0.9 .. 0.9 |  | Feedback (with a short delay this is a flanger). |
| `mix` | 0.5 | 0 .. 1 |  | Wet level (the dry signal always stays at full level). |
| `spread` | 1 | 0 .. 1 |  | Stereo spread of the voices. |
<!-- /gen -->

### phaser

<!-- gen:fx:phaser -->
All-pass phaser with feedback, offset sweeps per side. `fx.phaser({ stages: 6, rate: 0.2 })`.

Example:

```ts
s.synth('warm-pad', { fx: [fx.phaser({ stages: 6, rate: 0.2 })] }).play(s.chords('Am', { octave: 3 }), S.drop);
```

| option | meaning |
|---|---|
| `stages` | all-pass stages per side (2-12, default 6) |

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `rate` | 0.3 | 0.02 .. 8 | Hz | Sweep speed. |
| `depth` | 0.8 | 0 .. 1 |  | Sweep range in octaves/4. |
| `centre` | 900 | 100 .. 6000 | Hz | Centre frequency of the sweep. |
| `feedback` | 0.5 | -0.95 .. 0.95 |  | Resonance of the notches. |
| `mix` | 0.5 | 0 .. 1 |  | Wet level (equal parts of dry and wet = deepest notches). |
<!-- /gen -->

### crusher

<!-- gen:fx:crusher -->
Bit depth and sample-rate reduction (lo-fi, 8-bit). `fx.crusher({ bits: 8, rate: 4 })`.

Example:

```ts
s.synth('square-lead', { fx: [fx.crusher({ bits: 8, rate: 4 })] }).play(s.notes('A4:8 E5:8'), S.drop);
```

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `bits` | 8 | 1 .. 16 |  | Bit depth (quantisation). |
| `rate` | 4 | 1 .. 64 |  | Sample-rate reduction factor (1 = off). |
| `mix` | 1 | 0 .. 1 |  | Dry/wet. |
<!-- /gen -->

### widener

<!-- gen:fx:widener -->
Mid/side stereo width with a mono-below corner that keeps the lows centred. `fx.widener({ width: 1.5 })`.

Example:

```ts
s.synth('supersaw-pad', { fx: [fx.widener({ width: 1.5 })] }).play(s.chords('Am', { octave: 3 }), S.drop);
```

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `width` | 1.3 | 0 .. 2.5 |  | Side level: 0 = mono, 1 = unchanged, 2 = very wide. |
| `monoBelow` | 140 | 20 .. 600 | Hz | Below this frequency the side signal is removed (keeps the lows centred). |
<!-- /gen -->

### gate

<!-- gen:fx:gate -->
Rhythmic (trance) gate locked to the song position: a step pattern chops the channel. `fx.gate({ pattern: "x.xx.x.x", res: 4 })`.

Example:

```ts
s.synth('supersaw-pad', { fx: [fx.gate({ pattern: 'x.xx.x.x', res: 4 })] }).play(s.chords('Am', { octave: 3 }), S.drop);
```

| option | meaning |
|---|---|
| `pattern` | required: one character per step: 'x' open, '.' (or '-' or '0') closed, digits 1-9 partial (9 almost open); spaces and / are ignored. The pattern repeats on its own length, counted from the start of the song, so 16 steps at the default resolution is one bar and 8 steps is two beats |
| `res` | steps per beat (4 = sixteenths, the default) |

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `depth` | 1 | 0 .. 1 |  | How far the gate closes (1 = silent between hits). |
| `attack` | 2 | 0.2 .. 50 | ms | Opening time. |
| `release` | 25 | 0.5 .. 400 | ms | Closing time. |
<!-- /gen -->

### pump

<!-- gen:fx:pump -->
A tempo-locked pump on one channel: a duck with the shape of the sidechain (attack, hold, release, curve) that starts on the steps of a pattern instead of on the kick, so chords can pump on their own rhythm while the sub follows the kick. `fx.pump({ pattern: "x...x...x...x...", depth: 0.8 })`.

Example:

```ts
s.synth('supersaw-chord', { fx: [fx.pump({ pattern: 'x...x...x...x...', depth: 0.8, release: 0.3 })] }).play(s.chords('Am | F', { octave: 3 }), S.drop);
```

| option | meaning |
|---|---|
| `pattern` | one character per step: 'x' (or 'X') a full duck, '.' (or '-' or '0') none, digits 1-9 a duck of that part of the depth (9 = full); spaces and bar lines are ignored. The default is a duck on every beat of a 4/4 bar, 'x...x...x...x...'. Like the gate it repeats on its own length, counted from the start of the song, so 16 steps at the default resolution is one bar, and a pattern written as two bars is 32 steps |
| `res` | steps per beat (4 = sixteenths, the default) |

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `depth` | 0.8 | 0 .. 1 |  | How far the channel ducks at each step of the pattern: 1 = silent at the bottom of the duck, 0 = off (an exact pass-through). It acts at once, also in the middle of a duck, like the strip's `duck`. |
| `attack` | 0.004 | 0.0005 .. 0.05 | s | How fast the channel drops at each step of the pattern (the sidechain's `attack`). |
| `hold` | 0.02 | 0 .. 0.3 | s | Time the duck is held at full depth. |
| `release` | 0.2 | 0.02 .. 1.5 | s | Recovery time: this long after the hold the channel is back at full level exactly (a total, not a time constant). With the default curve and full depth it is back to -3 dB after a fifth of it, to about -1 dB after a third. |
| `curve` | 1 | 0.3 .. 4 |  | 1 = exponential recovery; above 1 the recovery starts slower and finishes quicker (pumping), below 1 the opposite. |
<!-- /gen -->

### filter

<!-- gen:fx:filter -->
Low-pass / high-pass / band-pass / notch with a tempo-locked LFO for sweeps and wobbles. `fx.filter({ mode: "lp", cutoff: 800, lfoRate: 0.5, lfoDepth: 2 })`.

Example:

```ts
s.synth('saw-lead', { fx: [fx.filter({ mode: 'lp', cutoff: 800, lfoRate: 0.5, lfoDepth: 2 })] }).play(s.notes('A3:8 E3:8'), S.drop);
```

| option | meaning |
|---|---|
| `mode` | 'lp' (default), 'hp', 'bp' or 'notch' |
| `shape` | LFO shape: 'sine' (default), 'tri', 'saw', 'ramp' or 'square' |

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `cutoff` | 1200 | 20 .. 20000 | Hz | Centre / corner frequency. |
| `res` | 0.8 | 0.3 .. 20 |  | Resonance as Q (0.7 = flat, 4 = pronounced, 12 = whistling). |
| `lfoRate` | 0 | 0 .. 16 | cycles/beat | LFO speed, locked to the song tempo (0 = off). 0.25 = one cycle per bar in 4/4. |
| `lfoDepth` | 1 | 0 .. 6 | octaves | LFO swing of the cutoff, in octaves each way. |
| `lfoPhase` | 0 | 0 .. 1 |  | LFO phase offset (0..1 of a cycle). |
| `mix` | 1 | 0 .. 1 |  | Dry/wet. |
<!-- /gen -->

### delay

<!-- gen:fx:delay -->
Tempo-synced ping-pong delay as an insert (the song-wide delay is a send: see Sends). `fx.delay({ time: 0.75, feedback: 0.4 })`.

Example:

```ts
s.synth('pluck', { fx: [fx.delay({ time: '1/8.', feedback: 0.4 })] }).play(s.notes('A4 . . . . . . . E5 . . . . . . .'), S.drop);
```

| option | meaning |
|---|---|
| `time` | also accepts a note division such as '1/8.' or '1/4t' |

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `time` | 0.75 | 0.0625 .. 4 | beats | Delay time in beats (0.75 = dotted eighth, 0.5 = eighth, 0.25 = sixteenth, 1 = quarter). |
| `feedback` | 0.4 | 0 .. 0.95 |  | How much of the output returns to the input. |
| `pingpong` | 0.8 | 0 .. 1 |  | Amount of left/right alternation (0 = plain stereo echo). |
| `tone` | 4200 | 500 .. 16000 | Hz | Low-pass in the feedback loop (darker repeats). |
| `lowCut` | 160 | 20 .. 1500 | Hz | High-pass in the feedback loop (thinner repeats). |
| `drive` | 0.15 | 0 .. 1 |  | Soft saturation in the loop (tape-like warmth). |
| `mod` | 0.15 | 0 .. 1 |  | Slow pitch wobble of the repeats. |
| `mix` | 1 | 0 .. 1 |  | Wet level (as an insert; as the song-wide send it is the return level). |
<!-- /gen -->

### reverb

<!-- gen:fx:reverb -->
Reverb as an insert, or the 80s gated reverb. `fx.reverb({ gated: true })` on a snare is the classic big snare.

Example:

```ts
s.snare('darksynth-snare', { fx: [fx.reverb({ gated: true })] }).play(s.hits('....X.......X...'), S.drop);
```

| option | meaning |
|---|---|
| `gated` | true: the tail is cut off by a gate keyed from the dry signal |

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `time` | 1.6 | 0.1 .. 12 | s | Reverb time (RT60). |
| `damp` | 0.5 | 0 .. 1 |  | High-frequency damping. |
| `size` | 1 | 0.3 .. 3 |  | Room size. |
| `preDelay` | 0.012 | 0 .. 0.3 | s | Pre-delay. |
| `mix` | 0.3 | 0 .. 1 |  | Wet level (dry stays at full level). |
| `hold` | 140 | 10 .. 1000 | ms | Gated mode: how long the gate stays open after the dry signal. |
| `close` | 70 | 5 .. 500 | ms | Gated mode: closing time. |
| `threshold` | -34 | -80 .. 0 | dB | Gated mode: the dry level that opens the gate. |
<!-- /gen -->

### amp

<!-- gen:fx:amp -->
The guitar amp and cabinet on any channel (a synth lead, a bass, a drum loop). `fx.amp({ gain: 0.8, cab: "4x12" })`.

Example:

```ts
s.synth('saw-lead', { fx: [fx.amp({ gain: 0.8, cab: '4x12' })] }).play(s.notes('A3:8 E3:8'), S.drop);
```

| option | meaning |
|---|---|
| `cab` | '4x12' (default), '2x12', '1x12', 'bass-8x10', 'bass-1x15' or 'none' |

| parameter | default | range | unit | what it does |
|---|---|---|---|---|
| `gain` | 0.65 | 0 .. 1 |  | Amp gain: 0 clean, 0.3 crunch, 0.6 punk / hard rock, 0.85 high-gain. |
| `tight` | 0.5 | 0 .. 1 |  | How much low end is cut before the distortion. |
| `bass` | 0 | -12 .. 12 | dB | Tone stack: bass. |
| `mid` | 1 | -12 .. 12 | dB | Tone stack: mids. |
| `treble` | -0.5 | -12 .. 12 | dB | Tone stack: treble. |
| `presence` | -1.5 | -12 .. 12 | dB | Tone stack: presence. |
| `boost` | 0.4 | 0 .. 1 |  | Screamer-style mid boost in front of the amp. |
| `sag` | 0.4 | 0 .. 1 |  | Power-amp sag (compression on loud notes). |
| `gate` | -62 | -90 .. -30 | dB | Noise-gate threshold (-90 = off). |
| `cabBright` | 0 | -1 .. 1 |  | Cabinet brightness. |
| `level` | -12 | -40 .. 12 | dB | Output level (the amp is loud: the default leaves room in the mix). |
| `mix` | 1 | 0 .. 1 |  | Dry/wet. |
<!-- /gen -->
