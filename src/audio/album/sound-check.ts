/**
 * Sound Check: every instrument of the engine in turn, a few bars each, on a plain 140 BPM grid in A minor. It exists so that
 * composers and tests can hear and measure each instrument (and it is a worked example of the composer API). Render it with
 *   ALBUM=1 ONLY=sound-check npx vitest run tests/probes/album-render.test.ts
 * The section table SOUND_CHECK_MAP lists where each instrument plays (bar, length).
 *
 * The song lives here, one level above tracks/, so that the engine's tests and the probe keep working when the album's real tracks
 * replace it: tracks/sound-check.ts only re-exports it (delete that file to take the Sound Check out of the album).
 */
import { defineTrack, fx, guitarChord } from './song';

/** Where each part of the sound check plays: bar (0-based), number of bars and what is in it. */
export const SOUND_CHECK_MAP = [
  { name: 'electro-kit', bar: 0, bars: 2, what: 'electronic drum kit: darksynth kick, snare + clap, hats, crash, toms' },
  { name: 'kicks', bar: 2, bars: 3, what: 'six kick presets, two hits each, one hit per beat: darksynth, techno, psy, punchy, hard, 808' },
  { name: 'acoustic-kit', bar: 5, bars: 3, what: 'acoustic punk kit: beat, then a tom fill into a crash' },
  { name: 'acid', bar: 8, bars: 2, what: '303 acid line with accents and slides, filter sweep' },
  { name: 'growl', bar: 10, bars: 2, what: 'dubstep growl bass, wobble speeding up' },
  { name: 'reese', bar: 12, bars: 2, what: 'reese bass' },
  { name: 'sub', bar: 14, bars: 1, what: 'sub bass and an 808 boom' },
  { name: 'dark-bass', bar: 15, bars: 2, what: 'distorted darksynth bass in 16ths, ducked by the kick' },
  { name: 'supersaw', bar: 17, bars: 2, what: 'supersaw chords' },
  { name: 'pluck-arp', bar: 19, bars: 2, what: 'dark pluck arpeggio, then a trance pluck' },
  { name: 'pads', bar: 21, bars: 2, what: 'warm pad and string pad' },
  { name: 'leads', bar: 23, bars: 2, what: 'supersaw lead with slides and a saw lead' },
  { name: 'keys', bar: 25, bars: 1, what: 'organ A4 (tuning reference), FM bell, FM e-piano' },
  { name: 'fx', bar: 26, bars: 3, what: 'riser, impact, downlifter, zap' },
  { name: 'guitar', bar: 29, bars: 4, what: 'punk guitars: palm-muted chugs, power chords, open chords, a slide and a lead' },
  { name: 'bass-guitar', bar: 33, bars: 2, what: 'punk bass guitar: eighths, palm mutes, a slide' },
  { name: 'sends', bar: 35, bars: 2, what: 'single plucks with the reverb and delay sends opening up' },
  { name: 'sidechain', bar: 37, bars: 2, what: 'pad pumping under a four-on-the-floor kick' },
] as const;

export default defineTrack({ id: 'sound-check', title: 'Sound Check', genre: 'Test', bpm: 140, bars: 39, tail: 3.5 }, (s) => {
  s.key('A', 'minor');
  s.setMaster({ trim: 3.0 }); // found with the probe's AUTOTRIM=1: integrated about -14 LUFS
  s.setReverb({ time: 2.4, return: -9 });
  s.setDelay({ time: '1/8.', feedback: 0.42, return: -10 });
  const T = Object.fromEntries(SOUND_CHECK_MAP.map((m) => [m.name, m]));
  for (const m of SOUND_CHECK_MAP) {
    const sec = s.section(m.name, m.bars);
    if (sec.bar !== m.bar) throw new Error(`sound-check: section ${m.name} starts at bar ${sec.bar}, expected ${m.bar}`);
  }

  // ── electronic drum kit ──────────────────────────────────────────────────
  const kit = s.drumKit(
    {
      kick: 'darksynth-kick',
      snare: 'darksynth-snare',
      clap: 'clap',
      hat: { preset: 'closed-hat', pan: 0.25, gain: 0 },
      crash: { preset: 'crash', gain: 0, pan: -0.2 },
      tomHi: { preset: 'tom-high', pan: -0.3 },
      tomMid: { preset: 'tom-mid', pan: 0 },
      tomLo: { preset: 'tom-low', pan: 0.3 },
    },
    { name: 'electro', gain: 0, reverb: 0.12 },
  );
  kit.play(
    s.drums({
      kick: 'X.......X.....x.|X...x...X.x...x.',
      snare: '....X.......X...|....X.......Xxxx',
      clap: '....x.......x...|....x.......x...',
      hat: 'x.x.x.x.x.x.x.o.|xxxxxxxxxxxxxxxx',
      crash: 'X...............|................',
      tomHi: '................|............x...',
      tomMid: '................|.............x..',
      tomLo: '................|..............x.',
    }),
    T['electro-kit'].bar,
    T['electro-kit'].bars,
  );

  // ── kick presets ─────────────────────────────────────────────────────────
  const kicks = s.drumKit(
    { k1: 'darksynth-kick', k2: 'techno-kick', k3: 'psy-kick', k4: 'punchy-kick', k5: 'hard-kick', k6: '808-kick' },
    { name: 'kicks', gain: 0 },
  );
  kicks.play(
    s.drums({
      k1: 'x...x...........|................|................',
      k2: '........x...x...|................|................',
      k3: '................|x...x...........|................',
      k4: '................|........x...x...|................',
      k5: '................|................|x...x...........',
      k6: '................|................|........x.......',
    }),
    T.kicks.bar,
    T.kicks.bars,
  );

  // ── acoustic kit ─────────────────────────────────────────────────────────
  const ak = s.acousticKit('punk-kit', { name: 'acoustic', gain: 0 });
  ak.play(
    s.drums({
      kick: 'x...x.x.x...x.x.|x.x...x.x...x.x.|x...x...x...x...',
      snare: '....x.......x...|....x.......x...|....g.g.xxxx....',
      hat: 'x.x.x.x.x.x.x.xo|x.x.x.x.x.x.x.xo|................',
      tomHi: '................|................|........x.......',
      tomMid: '................|................|.........x.x....',
      tomLo: '................|................|...........x.x..',
      crash: 'X...............|................|............X...',
    }),
    T['acoustic-kit'].bar,
    T['acoustic-kit'].bars,
  );

  // ── acid ─────────────────────────────────────────────────────────────────
  const acid = s.acid('acid-303', { name: 'acid', gain: 0, reverb: 0.05, delay: 0.1 });
  acid.play(s.notes('A1 . A1 A2! . A1 . A1 C2~ . A1 A1 E2! . G1 A1~ | A1 . A1 A2! . A1 . A1 C2~ . D2 D2! E2~ - - E1'), T.acid.bar, T.acid.bars);
  acid.ramp('cutoff', T.acid.bar, T.acid.bar + T.acid.bars, 260, 1500, 'exp');

  // ── growl ────────────────────────────────────────────────────────────────
  const growl = s.growl('dubstep-growl', { name: 'growl', gain: 0 });
  growl.play(s.notes('A1 - - - - - - - C2 - - - D2 - - - | A1 - - - - - - - E1 - - - . . . .'), T.growl.bar, T.growl.bars);
  growl.auto('lfoRate', [[T.growl.bar, 1], [T.growl.bar + 1, 1, 'step'], [T.growl.bar + 1.5, 2, 'step'], [T.growl.bar + 1.75, 4, 'step']]);

  // ── reese ────────────────────────────────────────────────────────────────
  const reese = s.reese('reese', { name: 'reese', gain: 0, reverb: 0.05 });
  reese.play(s.notes('A1 - - - - - - - C2 - - - - - - - | D2 - - - - - - - A1 - - - - - - -'), T.reese.bar, T.reese.bars);

  // ── sub ──────────────────────────────────────────────────────────────────
  const sub = s.sub('sub-sine', { name: 'sub', gain: 0 });
  sub.play(s.notes('A1 - - - - - - - E2 - - - . . . .'), T.sub.bar, T.sub.bars);
  const boom = s.sub('808-sub', { name: 'boom', gain: 0 });
  boom.note(T.sub.bar + 0.75, 'A1', 4);

  // ── kick + darksynth bass with sidechain ────────────────────────────────
  const mainKick = s.kick('darksynth-kick', { name: 'main-kick', gain: 0 });
  for (const sec of [T['dark-bass'], T.sidechain]) mainKick.play(s.hits('X...X...X...X...'), sec.bar, sec.bars);
  const dark = s.darkBass('darksynth-bass', { name: 'dark', gain: 0, duck: 0.85, reverb: 0.03 });
  dark.play(s.notes('A1 A1 A1 A1 A1 A1 A1 A1 A1 A1 A1 A1 C2 C2 D2 D2 | A1 A1 A1 A1 A1 A1 A1 A1 A1 A1 E2! E2 D2 D2 C2 C2'), T['dark-bass'].bar, T['dark-bass'].bars);
  s.setSidechain({ release: 0.2, curve: 1.4 });

  // ── supersaw chords ──────────────────────────────────────────────────────
  const saw = s.synth('supersaw-chord', { name: 'supersaw', gain: 0, reverb: 0.2, delay: 0.1, duck: 0 });
  saw.play(s.chords('Am F', { octave: 3, lead: true }).rhythm('x..x..x.', { res: 2 }), T.supersaw.bar, T.supersaw.bars);

  // ── plucks and arps ──────────────────────────────────────────────────────
  const arp = s.synth('dark-pluck', { name: 'arp', gain: 0, reverb: 0.15, delay: 0.25 });
  arp.play(s.arp(s.chords('Am', { octave: 3 }), { order: 'updown', octaves: 2, res: 4 }), T['pluck-arp'].bar, 1);
  const tpl = s.synth('trance-pluck', { name: 'trance-pluck', gain: 0, reverb: 0.15, delay: 0.25 });
  tpl.play(s.arp(s.chords('F', { octave: 3 }), { order: 'up', octaves: 2, res: 4, mask: 'xxx.xxx.xxxxxxx.' }), T['pluck-arp'].bar + 1, 1);

  // ── pads ─────────────────────────────────────────────────────────────────
  const pad = s.synth('warm-pad', { name: 'pad', gain: 0, reverb: 0.3, fx: [fx.chorus({ mix: 0.5 })] });
  pad.play(s.chords('Am', { octave: 3 }), T.pads.bar, 1);
  const strings = s.synth('string-pad', { name: 'strings', gain: 0, reverb: 0.3, fx: [fx.chorus({ mix: 0.4 })] });
  strings.play(s.chords('F', { octave: 3 }), T.pads.bar + 1, 1);

  // ── leads ────────────────────────────────────────────────────────────────
  const lead = s.synth('supersaw-lead', { name: 'lead', gain: 0, reverb: 0.2, delay: 0.3 });
  lead.play(s.notes('A4 . . . C5 . E5 - D5~ - E5 - A5 - - - | G5 . E5 . D5 - C5~ . A4 - - - . . . .'), T.leads.bar, 2);
  const lead2 = s.synth('saw-lead', { name: 'saw-lead', gain: 0, reverb: 0.15, delay: 0.2 });
  lead2.play(s.notes('E5 . . . . . . . . . . . . . . . | C5 . . . . . . . . . . . . . . .'), T.leads.bar, 2);

  // ── keys ─────────────────────────────────────────────────────────────────
  const organ = s.synth('organ', { name: 'organ', gain: 0 });
  organ.note(T.keys.bar, 'A4', 1.5);
  const bell = s.synth('fm-bell', { name: 'bell', gain: 0, reverb: 0.25, delay: 0.1 });
  bell.note(T.keys.bar + 0.375, 'E5', 1.5);
  const ep = s.synth('fm-epiano', { name: 'epiano', gain: 0, reverb: 0.15 });
  ep.play(s.chords('Am7', { octave: 3 }), T.keys.bar + 0.75, 0.25);

  // ── transitions ──────────────────────────────────────────────────────────
  const riser = s.riser('riser', { name: 'riser', gain: 0, reverb: 0.1 });
  riser.hit(T.fx.bar, '', 1, 0, 8);
  const impact = s.impact('impact', { name: 'impact', gain: 0 });
  impact.hit(T.fx.bar + 2, '', 1);
  const down = s.riser('downlifter', { name: 'downlifter', gain: 0 });
  down.hit(T.fx.bar + 2, '', 1, 0, 4);
  const zap = s.zap('zap', { name: 'zap', gain: 0, delay: 0.2 });
  zap.hit(T.fx.bar + 2.5, '', 1);
  zap.hit(T.fx.bar + 2.75, '', 0.6);

  // ── guitars ──────────────────────────────────────────────────────────────
  const gtr = s.guitar('punk-guitar', { name: 'guitar', gain: 0, reverb: 0.06 });
  const g0 = T.guitar.bar;
  gtr.play(s.notes('[E2,B2,E3]{pm} [E2,B2,E3]{pm} [E2,B2,E3]{pm} [E2,B2,E3]{pm} [G2,D3,G3]! . [A2,E3,A3] . [E2,B2,E3]{pm} [E2,B2,E3]{pm} [E2,B2,E3]{pm} [E2,B2,E3]{pm} [D3,A3,D4]! . [E3,B3,E4] -'), g0, 1);
  gtr.play(s.notes('[A2,E3,A3] - - - [E3,B3,E4] - - - [G2,D3,G3] - - - [D3,A3,D4] - - -'), g0 + 1, 1);
  gtr.play(
    s
      .pattern(1)
      .chord(0, guitarChord('Em'), 1, 0.85, 0)
      .chord(1, guitarChord('A'), 1, 0.85, 0)
      .chord(2, guitarChord('D'), 1, 0.85, 0)
      .chord(3, guitarChord('G'), 1, 0.85, 0)
      .done()
      .strum(0.04),
    g0 + 2,
    1,
  );
  const lg = s.guitar('lead-guitar', { name: 'lead-gtr', gain: 0, reverb: 0.15, delay: 0.2 });
  lg.play(s.notes('E4:2 G4~:2 A4:2 B4!:2 A4~:2 G4 E4~ - - - -'), g0 + 3, 1);

  // ── bass guitar ──────────────────────────────────────────────────────────
  const bg = s.bassGuitar('punk-bass', { name: 'bass-gtr', gain: 0 });
  bg.play(s.notes('E1{pm} E1{pm} E1{pm} E1{pm} E1 E1 E1 E1 G1 G1 A1 A1 B1 B1 A1 G1 | E1 . E1 E1 . E1~ G1 . A1 - A1? . E1~ - - -'), T['bass-guitar'].bar, 2);

  // ── sends ────────────────────────────────────────────────────────────────
  const sp = s.synth('pluck', { name: 'send-pluck', gain: 6, reverb: 0, delay: 0 });
  sp.play(s.notes('A4 . . . . . . . E5 . . . . . . . | A4 . . . . . . . C5 . . . . . . .'), T.sends.bar, 2);
  sp.ramp('mix.reverb', T.sends.bar, T.sends.bar + 1, 0, 0.8);
  sp.ramp('mix.delay', T.sends.bar + 1, T.sends.bar + 2, 0, 0.9);

  // ── sidechain pad ────────────────────────────────────────────────────────
  const sc = s.synth('supersaw-pad', { name: 'sc-pad', gain: 0, duck: 0.9, reverb: 0.1 });
  sc.play(s.chords('Am | F', { octave: 3 }), T.sidechain.bar, 2);
});
