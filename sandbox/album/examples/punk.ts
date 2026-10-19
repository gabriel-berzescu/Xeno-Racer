// Example track: a short punk-rock instrumental (184 BPM, E major): acoustic punk kit, two single-take guitars hard left and right, a bass
// guitar and a lead guitar, stops before the choruses. Written by following src/audio/album/README.md. It is not part of the album.
// Probe it:  ALBUM=1 TRACK=sandbox/album/examples/punk.ts AUTOTRIM=1 SPEC=1 npx vitest run tests/probes/album-render.test.ts
// To build on it, copy it to src/audio/album/tracks/<id>.ts, change the import to '../song' and the id to the file name.
import { defineTrack } from '../../../src/audio/album/song';

export default defineTrack({ id: 'example-punk', title: 'Example Punk', genre: 'Test', bpm: 184, bars: 28, tail: 3 }, (s) => {
  s.key('E', 'major');
  const S = s.sections({ intro: 2, verse: 8, chorus: 8, bridge: 4, final: 6 });

  // ── channels ──
  const kit = s.acousticKit('punk-kit', { gain: -7, reverb: 0.06 });
  const gtrL = s.guitar('punk-guitar-L', { name: 'gtrL', gain: -4, hp: 90 });
  const gtrR = s.guitar('punk-guitar-R', { name: 'gtrR', gain: -4, hp: 90 });
  const bass = s.bassGuitar('punk-bass', { gain: -5 });
  const lead = s.guitar('lead-guitar', { name: 'lead', gain: -7, reverb: 0.15, delay: 0.25 });

  // ── power chords (root, fifth, octave) and bar builders on an eighth-note grid (8 steps per bar) ──
  const PC = { E: '[E2,B2,E3]', A: '[A2,E3,A3]', B: '[B2,F#3,B3]', Cs: '[C#3,G#3,C#4]' };
  const ROOT = { E: 'E1', A: 'A1', B: 'B1', Cs: 'C#2' };
  type Ch = keyof typeof PC;
  const eighths = (tok: string, n = 8) => Array(n).fill(tok).join(' ');
  const pmBar = (c: Ch) => eighths(`${PC[c]}{pm}`);
  const openBar = (c: Ch) => `${PC[c]}!{ring}:2 ${eighths(PC[c], 6)}`; // ring on beat 1, then open eighths
  const bassBar = (c: Ch, art = '') => eighths(`${ROOT[c]}${art}`);
  const part = (bars: string[]) => s.notes(bars.join(' | '), { res: 2 });

  // intro: palm-muted E alone (filtered), then open
  const introGtr = part([pmBar('E'), openBar('E')]);
  // verse: palm-muted eighths, two dead-note scratches, a slide up into the B, a stop on the last beat
  const scratchBar = `${eighths(`${PC.E}{pm}`, 6)} ${PC.E}? ${PC.E}?`;
  const verseGtr = part([
    pmBar('E'), scratchBar, pmBar('A'), `${eighths(`${PC.A}{pm}`, 4)} ${PC.A} ${PC.B}~:3`,
    pmBar('E'), scratchBar, pmBar('A'), `${eighths(`${PC.B}{pm}`, 4)} ${PC.B}!:2 . .`,
  ]);
  const verseBass = part([
    bassBar('E', '{pm}'), bassBar('E', '{pm}'), bassBar('A', '{pm}'), bassBar('B', '{pm}'),
    bassBar('E', '{pm}'), bassBar('E', '{pm}'), bassBar('A', '{pm}'), `${eighths(`${ROOT.B}{pm}`, 4)} ${ROOT.B}!:2 . .`,
  ]);
  const chorusGtr = part([openBar('E'), openBar('B'), openBar('Cs'), openBar('A')]);
  const chorusBass = part([bassBar('E'), bassBar('B'), bassBar('Cs'), bassBar('A')]);
  const bridgeGtr = part([`${PC.Cs}{ring}:8`, `${PC.A}{ring}:8`, `${PC.E}{ring}:8`, pmBar('B')]);
  const bridgeBass = part([`${ROOT.Cs}:4 ${ROOT.Cs}:4`, `${ROOT.A}:4 ${ROOT.A}:4`, `${ROOT.E}:4 ${ROOT.E}:4`, bassBar('B')]);
  const leadLine = s.notes('G#4:3 B4 C#5:4 | E5:4 C#5:2 B4:2 | G#4:3 E4 F#4 G#4~:3 | F#4:2 G#4 A4 B4~:4', { res: 2 });
  const finalGtr = part([openBar('E'), openBar('B'), openBar('Cs'), openBar('A'), openBar('B'), `${PC.E}!{ring}:8`]);
  const finalBass = part([bassBar('E'), bassBar('B'), bassBar('Cs'), bassBar('A'), bassBar('B'), `${ROOT.E}!{ring}:8`]);

  // ── drums ──
  const verseBeat = s.drums({ kick: 'x.......x.x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' });
  const stopBar = s.drums({ kick: 'x.......X.......', snare: '....x...X.......', hat: 'x.x.x.x.........' });
  const chorusBeat = s.drums({ kick: 'x...x...x...x...', snare: '..x...x...x...x.', ride: 'x.x.x.x.x.x.x.x.' });
  const tomFill = s.drums({
    kick: 'x.......x.......', snare: '....x...xx......', tomHi: '..........xx....', tomMid: '............xx..', tomLo: '..............xX',
  });
  const halfTime = s.drums({ kick: 'x.....x.........', snare: '........X.......', hat: 'x.x.x.x.x.x.x.x.' });
  const roll = s.drums({ kick: 'x...............', snare: '1.2.3.4.56789XXX' });

  // ── arrangement ──
  for (const g of [gtrL, gtrR]) {
    g.play(introGtr, S.intro);
    g.play(verseGtr, S.verse);
    g.play(chorusGtr, S.chorus);
    g.play(bridgeGtr, S.bridge.bar, S.bridge.bars - 0.25); // stop: the last beat of the bridge is silent
    g.play(finalGtr, S.final);
  }
  bass.play(chorusBass.slice(0, 4), 1, 1); // enters in the second intro bar
  bass.play(verseBass, S.verse);
  bass.play(chorusBass, S.chorus);
  bass.play(bridgeBass, S.bridge.bar, S.bridge.bars - 0.25);
  bass.play(finalBass, S.final);
  lead.play(leadLine, S.bridge.bar, S.bridge.bars - 0.25);

  kit.play(tomFill, 1, 1);
  kit.hit(1, 'crash', 1);
  kit.play(verseBeat, S.verse.bar, S.verse.bars - 1);
  kit.play(stopBar, S.verse.end - 1, 1);
  kit.play(chorusBeat, S.chorus.bar, S.chorus.bars - 1);
  kit.play(tomFill, S.chorus.end - 1, 1);
  kit.hit(S.chorus.bar, 'crash', 1);
  kit.hit(S.chorus.bar + 4, 'crash2', 0.9);
  kit.play(halfTime, S.bridge.bar, S.bridge.bars - 1);
  kit.play(roll, S.bridge.end - 1, 0.75);
  kit.play(chorusBeat, S.final.bar, S.final.bars - 1);
  kit.hit(S.final.bar, 'crash', 1);
  kit.hit(S.final.bar, 'crash2', 0.8);
  kit.hit(S.final.bar + 4, 'crash', 1);
  kit.hit(S.final.end - 1, 'crash', 1);
  kit.hit(S.final.end - 1, 'kick', 1);

  // ── automation: the intro opens from a thin high-passed guitar; the amp gain climbs across the bridge ──
  for (const g of [gtrL, gtrR]) {
    g.auto('mix.hp', [[0, 1500], [1, 90, 'exp']]);
    g.auto('gain', [[S.bridge.bar, 0.35, 'step'], [S.bridge.end - 0.25, 0.75], [S.final.bar, g.param('gain'), 'step']]);
    g.set('mix.gain', -8, S.bridge.bar); // the bridge sits lower so that the final chorus lifts
    g.set('mix.gain', -4, S.final.bar);
  }
  bass.set('mix.gain', -8, S.bridge.bar);
  bass.set('mix.gain', -5, S.final.bar);

  // ── sends and master ──
  s.setReverb({ time: 1.2, return: -12 });
  s.setDelay({ time: '1/8.', feedback: 0.3 });
  s.setMaster({ glue: 1, sat: 0.3, trim: 2.0 }); // AUTOTRIM's value
});
