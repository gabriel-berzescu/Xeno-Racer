// Flat Out: instrumental punk for Xeno-Racer Vol. 1. 192 BPM, E minor (choruses in the relative G major), the last chorus a whole tone
// up in A major. Two single-take rhythm guitars hard left and right, a picked bass, a punk kit, a lead guitar that sings the topline and
// a second lead that harmonises it in thirds.
//
// The idea: the hook is a "gear shift" - a three-note figure that climbs a third every bar, like an engine going through the gears, and
// ends on a tremolo-picked note at the top (the surf-punk attack). The verse sings low and syncopated over palm mutes that push the
// change into C an eighth early; the pre-chorus rings out in half notes and climbs a chain of steps to a leading tone held over a band
// stop; the chorus explodes into open eighths and long, high notes over I-V-vi-IV. The solo rides the Andalusian cadence (Em D C B): a bend, a rhythmic sequence, twin tremolo thirds,
// arpeggio runs. A breakdown leaves one guitar alone, the band builds back on E5, which is both the old tonic and the dominant of the new
// key, and the last chorus lands a tone higher. The outro plays the hook in the new key and ends on three stabs and a ringing A.
//
// Probe: ALBUM=1 TRACK=sandbox/album/wip/flat-out.ts AUTOTRIM=1 SPEC=1 npx vitest run tests/probes/album-render.test.ts
import { defineTrack } from '../song';
import type { Pattern } from '../song';

// ── harmony helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const E_MINOR = [4, 6, 7, 9, 11, 0, 2]; // E F# G A B C D (= G major)
const E_HARMONIC = [4, 6, 7, 9, 11, 0, 3]; // over B: the raised seventh D#
const A_MAJOR = [9, 11, 1, 2, 4, 6, 8]; // A B C# D E F# G# (= F# minor)
const TRIADS: Record<string, number[]> = {
  Em: [4, 7, 11], E: [4, 8, 11], C: [0, 4, 7], G: [7, 11, 2], D: [2, 6, 9], Am: [9, 0, 4], B: [11, 3, 6], A: [9, 1, 4], 'F#m': [6, 9, 1],
};
const pcOf = (m: number): number => ((m % 12) + 12) % 12;
/** The note `k` scale steps away from m (negative = down) in the scale `sc`. */
function stepIn(m: number, k: number, sc: number[]): number {
  let n = m;
  const dir = Math.sign(k);
  for (let left = Math.abs(k); left > 0; ) {
    n += dir;
    if (sc.includes(pcOf(n))) left--;
  }
  return n;
}
/** A semitone from a chord tone: the harmony note would rub against the rhythm guitars. */
const rubs = (pc: number, tri: number[]): boolean => !tri.includes(pc) && tri.some((t) => Math.abs(((pc - t + 18) % 12) - 6) === 1);
/**
 * A second guitar part a diatonic third below (dir -1) or above (dir +1) the melody, voice-led like a second guitarist would play it:
 * the candidates are the third, the fourth and the sixth; none may rub (a semitone) against a chord the note sounds over (all of them,
 * when it is held across a change); a held note (a beat or more) takes a chord tone; of what is left, the note nearest to the previous
 * harmony note wins (the third on a tie), so that the line moves smoothly. `parallel` keeps strict thirds wherever they do not rub (a
 * riff played by two guitars). `chordAt` gives the chord at a beat of the pattern.
 */
function harmonize(p: Pattern, chordAt: (beat: number) => string, dir: 1 | -1, key = E_MINOR, parallel = false): Pattern {
  let prev = NaN;
  return p.map((e) => {
    const first = chordAt(e.t);
    const tri = TRIADS[first];
    const sc = first === 'B' ? E_HARMONIC : key;
    const under = new Set<string>();
    for (let t = e.t; t < e.t + e.d - 1e-6; t += 0.25) under.add(chordAt(t));
    const ok = (h: number): boolean => [...under].every((c) => !rubs(pcOf(h), TRIADS[c]));
    const third = stepIn(e.n, 2 * dir, sc);
    let cands = [third, stepIn(e.n, 3 * dir, sc), stepIn(e.n, 5 * dir, sc)].filter(ok);
    if (e.d >= 0.95 && cands.some((x) => tri.includes(pcOf(x)))) cands = cands.filter((x) => tri.includes(pcOf(x)));
    if (!cands.length) cands = [third];
    if (parallel) cands = [cands[0]];
    const ref = Number.isNaN(prev) ? third : prev;
    const h = cands.reduce((best, x) => (Math.abs(x - ref) < Math.abs(best - ref) - 1e-9 ? x : best));
    prev = h;
    return { ...e, n: h };
  });
}

// ── guitar and bass vocabulary (eighth-note grid: 8 steps a bar) ─────────────────────────────────────────────────────────────
const PC: Record<string, string> = { E: '[E2,B2,E3]', 'F#': '[F#2,C#3,F#3]', G: '[G2,D3,G3]', A: '[A2,E3,A3]', B: '[B2,F#3,B3]', C: '[C3,G3,C4]', D: '[D3,A3,D4]' };
const ROOT: Record<string, string> = { Em: 'E', E: 'E', 'F#m': 'F#', G: 'G', Am: 'A', A: 'A', B: 'B', C: 'C', D: 'D' };
const LOW: Record<string, string> = { E: 'E1', 'F#': 'F#1', G: 'G1', A: 'A1', B: 'B1', C: 'C2', D: 'D2' };
const rep = (tok: string, n: number): string => Array(n).fill(tok).join(' ');
const pc = (ch: string): string => PC[ROOT[ch]];
const lo = (ch: string): string => LOW[ROOT[ch]];
/** Palm-muted eighths. */
const pmBar = (ch: string): string => rep(`${pc(ch)}{pm}`, 8);
/** Open eighths, the first one accented. */
const openBar = (ch: string): string => `${pc(ch)}! ${rep(pc(ch), 7)}`;
/** Two big strums a bar, left ringing (each new strum damps the last). */
const halfRing = (ch: string): string => `${pc(ch)}!{ring}:4 ${pc(ch)}{ring}:4`;
const bassBar = (ch: string, art = ''): string => `${lo(ch)}!${art} ${rep(`${lo(ch)}${art}`, 7)}`;
const times = <T,>(xs: T[], n: number): T[] => Array.from({ length: n }, () => xs).flat();

// ── the chart ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const CH = {
  intro: times(['Em', 'C', 'G', 'D'], 2),
  verse: times(['Em', 'Em', 'C', 'D'], 4),
  pre: ['C', 'D', 'Em', 'Em', 'Am', 'C', 'D', 'D'],
  chorus: times(['G', 'D', 'Em', 'C'], 4),
  hook: ['Em', 'C', 'G', 'D'],
  solo: times(['Em', 'D', 'C', 'B'], 4),
  final: times(['A', 'E', 'F#m', 'D'], 4),
  outro: ['F#m', 'D', 'A', 'E', 'D', 'E', 'A', 'A'],
};
const chordOf = (list: string[]) => (beat: number): string => list[Math.min(list.length - 1, Math.floor(beat / 4 + 1e-9))];
/** The verse's chords: the guitars push the C an eighth early, on the and of 4 of every second bar. */
const verseChord = (beat: number): string => (beat % 16 >= 7.5 - 1e-9 && beat % 16 < 8 ? 'C' : CH.verse[Math.floor(beat / 4 + 1e-9) % 16]);

export default defineTrack({ id: 'flat-out', title: 'Flat Out', genre: 'Punk', bpm: 192, bars: 141, tail: 3.5 }, (s) => {
  s.key('E', 'minor');
  const S = s.sections({ count: 1, intro: 8, verse1: 16, pre1: 8, chorus1: 16, hook: 4, verse2: 16, pre2: 8, chorus2: 16, solo: 16, breakdown: 8, final: 16, outro: 8 });

  // ── the band ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const kit = s.acousticKit('punk-kit', { gain: -7, reverb: 0.05 });
  const gtrL = s.guitar('punk-guitar-L', { name: 'gtrL', gain: -4, hp: 100, eqMid: -1.5, eqMidFreq: 300, eqMidQ: 0.8 });
  const gtrR = s.guitar('punk-guitar-R', { name: 'gtrR', gain: -4, hp: 100, eqMid: -1.5, eqMidFreq: 300, eqMidQ: 0.8 });
  const bass = s.bassGuitar('punk-bass', { gain: -5 });
  const lead = s.guitar('lead-guitar', { name: 'lead', gain: -6, hp: 160, reverb: 0.14, delay: 0.12 });
  const harm = s.guitar({ preset: 'lead-guitar', mid: 1, treble: 2, vibratoRate: 5.1 }, { name: 'harm', gain: -7, pan: 0.35, hp: 160, reverb: 0.16, delay: 0.08 });
  const wall = s.guitar({ preset: 'crunch-guitar', takes: 1 }, { name: 'wall', gain: -11, hp: 220, pan: -0.15 });
  const gtrs = [gtrL, gtrR];
  // human time: the drummer and the bass player a few milliseconds loose, the second lead a little looser than the first
  kit.groove({ humanize: { time: 3, vel: 0.07 } });
  bass.groove({ humanize: { time: 2, vel: 0.05 } });
  lead.groove({ humanize: { time: 4, vel: 0.06 } });
  harm.groove({ humanize: { time: 6, vel: 0.06 } });

  const g = (bars: string[], gate = 1): Pattern => s.notes(bars.join(' | '), { res: 2, gate });
  const g16 = (bars: string[], gate = 1): Pattern => s.notes(bars.join(' | '), { res: 4, gate });
  const D = (lanes: Record<string, string>): Pattern => s.drums(lanes);

  // ── count-in: four stick clicks and a snare pickup ─────────────────────────────────────────────────────────────────────────
  kit.play(D({ rim: '6...7...8...9...', snare: '..............67' }), S.count.bar, 1);

  // ── intro and hook: the gear shift ─────────────────────────────────────────────────────────────────────────────────────────
  for (const gt of gtrs) {
    gt.play(g([...CH.intro.slice(0, 7).map(openBar), `${pc('D')}! ${rep(pc('D'), 5)} . .`]), S.intro);
    gt.play(g([...CH.hook.slice(0, 3).map(openBar), `${pc('D')}! ${rep(pc('D'), 5)} . .`]), S.hook);
  }
  // the bass: roots in eighths; where the band stops on the last beat it runs up alone into the verse (B C# D D# -> E)
  const pickupBar = s.notes(`D2!:2 ${rep('D2:2', 5)} B1 C#2 D2 D#2!`, { res: 4, gate: 0.9 });
  bass.play(g(CH.intro.slice(0, 7).map((c) => bassBar(c))), S.intro.bar, 7);
  bass.play(pickupBar, S.intro.end - 1, 1);
  bass.play(g(CH.hook.slice(0, 3).map((c) => bassBar(c))), S.hook.bar, 3);
  bass.play(pickupBar, S.hook.end - 1, 1);
  // the lead: three notes up, again, a third higher every bar, then the top note tremolo-picked; the second time the targets are
  // tremolo-picked too and the second guitar plays the same figure a third above
  const GEAR = [
    ['E4', 'F#4', 'G4'],
    ['G4', 'A4', 'B4'],
    ['B4', 'C5', 'D5'],
  ];
  const gearClean = GEAR.map(([a, b, c]) => `${a}:2 ${b}:2 ${c}:4 ${a}:2 ${b}:2 ${c}:4`);
  const gearTrem = GEAR.map(([a, b, c]) => `${a}:2 ${b}:2 ${rep(c, 4)} ${a}:2 ${b}:2 ${rep(c, 4)}`);
  const topTrem = `D5:2 E5:2 ${rep('F#5', 12)}`;
  const downTrem = `${rep('F#5', 4)} ${rep('E5', 4)} ${rep('D5', 4)} A4:2 . .`;
  const hookA = g16([...gearClean, topTrem]);
  const hookB = g16([...gearTrem, downTrem]);
  lead.play(hookA, S.intro.bar, 4);
  lead.play(hookB, S.intro.bar + 4, 4);
  harm.play(harmonize(hookB, chordOf(CH.hook), 1, E_MINOR, true), S.intro.bar + 4, 4);
  lead.play(hookB, S.hook);
  harm.play(harmonize(hookB, chordOf(CH.hook), 1, E_MINOR, true), S.hook);

  // ── verses: palm mutes that push the chord changes an eighth early ─────────────────────────────────────────────────────────
  const E = pc('Em');
  const verseRiff = [
    pmBar('Em'),
    `${rep(`${E}{pm}`, 7)} ${pc('C')}!`,
    `- ${rep(`${pc('C')}{pm}`, 7)}`,
    `${rep(`${pc('D')}{pm}`, 4)} ${rep(pc('D'), 4)}`,
  ];
  const verseBass = [bassBar('Em', '{pm}'), `E1!{pm} ${rep('E1{pm}', 6)} C2!`, `- ${rep('C2{pm}', 7)}`, `D2!{pm} ${rep('D2{pm}', 3)} ${rep('D2', 4)}`];
  const verseBassFill = [...verseBass.slice(0, 3), `D2!{pm} ${rep('D2{pm}', 3)} D2 D2 F#2 A2`];
  const verseGtr = g(times(verseRiff, 4), 0.9);
  for (const sec of [S.verse1, S.verse2]) {
    gtrL.play(verseGtr, sec);
    bass.play(g([...verseBass, ...verseBassFill, ...verseBass, ...verseBassFill], 0.9), sec);
  }
  gtrR.play(verseGtr, S.verse1);
  gtrR.play(verseGtr.slice(16, 64), S.verse2.bar + 4, 12); // verse 2 starts with the left guitar alone for four bars
  // the verse topline enters after four bars of riff: a rising triad with the last note pushed across the bar line, answered a step
  // lower; the second phrase reaches higher; the third climbs to E5 and hands over to the pre-chorus. Verse 2 scoops into its peaks.
  const verseLead = g(
    [
      'E4 - G4 - B4 - - A4', '- - G4 - E4 - - -', 'E4 - G4 - C5 - - B4', '- - A4 - F#4 - D4 -',
      'E4 - G4 - B4 - - D5', '- - B4 - G4 - E4 -', 'G4 - - E4 G4 - A4 -', 'F#4 - - - - - . .',
      'E4 - G4 - B4 - - D5', '- - E5 - D5 - B4 -', 'C5 - - - B4 - G4 -', 'A4 - - - - - . .',
    ],
    0.95,
  );
  const verseLead2 = g(
    [
      'E4 - G4 - B4~ - - A4', '- - G4 - E4 - - -', 'E4 - G4 - C5~ - - B4', '- - A4 - F#4 - D4 -',
      'E4 - G4 - B4~ - - D5', '- - B4 - G4 - E4 -', 'G4 - - E4 G4 - A4 -', 'F#4~ - - - - - . .',
      'E4 - G4 - B4~ - - D5', '- - E5~ - D5 - B4 -', 'C5 - - - B4 - G4 -', 'A4~ - - - - - . .',
    ],
    0.95,
  );
  lead.play(verseLead, S.verse1.bar + 4, 12);
  lead.play(verseLead2, S.verse2.bar + 4, 12);
  harm.play(harmonize(verseLead2.slice(16, 48), verseChord, 1), S.verse2.bar + 8, 8); // above: below the low verse line it would sink into the rhythm guitars

  // ── pre-chorus: a chain of steps up to the leading tone, held over a stop ───────────────────────────────────────────────────
  const preGtr = g([...CH.pre.slice(0, 6).map(halfRing), openBar('D'), `${pc('D')}!{ring}:4 . . . .`]);
  const preBass = g([...CH.pre.slice(0, 7).map((c) => bassBar(c)), 'D2!:4 . . . .']);
  const preLead = g(['C5 - - - B4 - C5 -', 'D5 - - - - - . .', 'D5 - - - C5 - D5 -', 'E5 - - - - - . .', 'E5 - - - D5 - E5 -', 'G5 - - - - - . .', 'F#5 - - - - - - -', '- - - - - - . .'], 0.97);
  for (const sec of [S.pre1, S.pre2]) {
    for (const gt of gtrs) gt.play(preGtr, sec);
    bass.play(preBass, sec);
    lead.play(preLead, sec);
  }
  harm.play(harmonize(preLead.slice(16, 32), chordOf(CH.pre.slice(4)), -1), S.pre2.bar + 4, 4);

  // ── choruses: G D Em C, the topline up high ─────────────────────────────────────────────────────────────────────────────────
  const chorusGtr = g(CH.chorus.map(openBar));
  const chorusBassBars = CH.chorus.map((c) => bassBar(c));
  chorusBassBars[7] = 'C2! C2 C2 C2 E2 E2 D2 D2'; // the third, then the fifth of G leads into it
  chorusBassBars[15] = 'C2! C2 C2 C2 D2 D2 D#2 D#2'; // climbs into the E
  const chorusBass = g(chorusBassBars);
  const chorusLead = g(
    [
      'G5! - - - - - F#5@0.7 G5', 'A5 - - - F#5 - D5 -', 'E5 - - - - - D5@0.7 E5', 'G5 - - - E5 - C5 -',
      'G5! - - - - - F#5@0.7 G5', 'A5 - - - B5 - A5 -', 'B5! - - - - - A5@0.7 G5', 'E5 - - - - - . .',
      'G5! - - - - - F#5@0.7 G5', 'A5 - - - F#5 - D5 -', 'E5 - - - - - D5@0.7 E5', 'G5 - - - E5 - C5 -',
      'G5! - - - - - F#5@0.7 G5', 'A5 - - - B5 - A5 -', 'B5! - - - A5 - F#5 -', 'G5! - - - - - . .',
    ],
    0.97,
  );
  const chorusHarm = harmonize(chorusLead, chordOf(CH.chorus), -1);
  for (const sec of [S.chorus1, S.chorus2]) {
    for (const gt of gtrs) gt.play(chorusGtr, sec);
    bass.play(chorusBass, sec);
    lead.play(chorusLead, sec);
  }
  harm.play(chorusHarm.slice(32, 64), S.chorus1.bar + 8, 8);
  harm.play(chorusHarm, S.chorus2);

  // ── solo over Em D C B ───────────────────────────────────────────────────────────────────────────────────────────────────────
  for (const gt of gtrs) {
    gt.play(g(CH.solo.slice(0, 8).map(pmBar), 0.9), S.solo.bar, 8);
    gt.play(g(CH.solo.slice(8, 15).map(openBar).concat([`${pc('B')}!{ring}:8`])), S.solo.bar + 8, 8);
  }
  bass.play(g(CH.solo.slice(0, 8).map((c) => bassBar(c, '{pm}')), 0.9), S.solo.bar, 8);
  bass.play(g([...CH.solo.slice(8, 15).map((c) => bassBar(c)), 'B1!{ring}:8']), S.solo.bar + 8, 8);
  const soloA = g(['A4 - - - - - A4 G4', 'F#4 - - - A4 - D5 -', 'E5 - - - D5 - C5 -', 'B4 - - - D#5 - F#5 -', 'E5 - . E5 G5 - E5 -', 'F#5 - . F#5 A5 - F#5 -', 'G5 - . G5 E5 - C5 -', 'D#5 - F#5 - B5 - - -'], 0.95);
  const soloTrem = g16([`${rep('B5', 8)} ${rep('G5', 8)}`, `${rep('A5', 8)} ${rep('F#5', 8)}`, `${rep('G5', 8)} ${rep('E5', 8)}`, `${rep('F#5', 8)} ${rep('D#5', 8)}`]);
  const soloRun = g16(['E5 F#5 G5 E5 F#5 G5 A5 F#5 G5 A5 B5 G5 A5 B5 C6 A5', 'D6 A5 F#5 D5 A5 F#5 D5 A4 F#5 D5 A4 F#4 A4 D5 F#5 A5', 'G5 E5 C5 G4 C5 E5 G5 C6 B5 G5 E5 C5 E5 G5 B5 C6', 'B5!{ring}:16'], 0.9);
  lead.play(soloA, S.solo.bar, 8);
  lead.play(soloTrem, S.solo.bar + 8, 4);
  harm.play(harmonize(soloTrem, chordOf(CH.solo.slice(8, 12)), -1, E_MINOR, true), S.solo.bar + 8, 4);
  lead.play(soloRun, S.solo.bar + 12, 4);
  // the first note of the solo is bent up a whole tone (A4 sounds B4), held, and let down before the next A4
  const b0 = S.solo.bar;
  lead.auto('bend', [[b0, 0], [b0 + 0.09, 2, 'out'], [b0 + 0.7, 2], [b0 + 0.74, 0]]);

  // ── breakdown: one guitar alone, then the band builds back on E5 (the dominant of the new key) ─────────────────────────────
  const bd = S.breakdown.bar;
  const chugA = `${E}!{pm} . ${E}{pm} ${E}{pm} . ${E}{pm} ${E}{pm} ${E}{pm}`;
  const chugB = `${E}!{pm} . ${E}{pm} ${E}{pm} . ${E}{pm} ${pc('G')}! ${pc('A')}!`;
  const bdRiff = g([chugA, chugB, chugA, chugB, chugA, chugB], 0.9);
  gtrL.play(bdRiff, bd, 6);
  gtrR.play(bdRiff.slice(8, 24), bd + 2, 4);
  for (const gt of gtrs) gt.play(g([openBar('E'), `${E}! ${rep(E, 5)} . .`]), bd + 6, 2);
  bass.play(g(['E1!{pm} . E1{pm} E1{pm} . E1{pm} E1{pm} E1{pm}', 'E1!{pm} . E1{pm} E1{pm} . E1{pm} G1! A1!'], 0.9), bd + 4, 2);
  bass.play(g([bassBar('E'), `E1! ${rep('E1', 5)} . .`]), bd + 6, 2);
  // the amp: a touch more gain in the choruses, pulled back for the breakdown and opened up again while the band builds
  for (const gt of gtrs) {
    const a = gt.param('gain');
    gt.auto('gain', [
      [S.chorus1.bar, a + 0.03, 'step'], [S.chorus1.end, a, 'step'], [S.chorus2.bar, a + 0.03, 'step'], [S.chorus2.end, a, 'step'],
      [bd + 6, a - 0.18, 'step'], [bd + 7.75, a + 0.05], [S.final.bar, a + 0.03, 'step'], [S.final.end, a, 'step'],
    ]);
  }

  // ── final chorus: a tone up, in A ───────────────────────────────────────────────────────────────────────────────────────────
  const finalBassBars = CH.final.map((c) => bassBar(c));
  finalBassBars[7] = 'D2! D2 D2 D2 F#2 F#2 E2 E2'; // the third, then the fifth of A leads into it
  const finalLead = chorusLead.transpose(2);
  for (const gt of gtrs) gt.play(g(CH.final.map(openBar)), S.final);
  bass.play(g(finalBassBars), S.final);
  lead.play(finalLead, S.final);
  harm.play(harmonize(finalLead, chordOf(CH.final), -1, A_MAJOR), S.final);
  // a third guitar, lighter and brighter, plays the chords an octave up in the middle of the stereo picture
  const UP: Record<string, string> = { A: '[A3,E4,A4]', E: '[E3,B3,E4]', 'F#m': '[F#3,C#4,F#4]', D: '[A3,D4,A4]' };
  wall.play(g(CH.final.map((c) => `${UP[c]}! ${rep(UP[c], 7)}`)), S.final);
  wall.play(g(CH.outro.slice(0, 4).map((c) => `${UP[c]}! ${rep(UP[c], 7)}`)), S.outro.bar, 4);

  // ── outro: the hook in F# minor, three stabs, a ringing A ───────────────────────────────────────────────────────────────────
  const ob = S.outro.bar;
  for (const gt of gtrs) {
    gt.play(g(CH.outro.slice(0, 4).map(openBar)), ob, 4);
    gt.play(g([`${pc('D')}! - . ${pc('D')}! - . ${pc('D')}! -`, `${pc('E')}! - . ${pc('E')}! - . ${pc('E')}! -`, `${pc('A')}!{ring}:8`, `${pc('A')}!{ring}:8`], 0.85), ob + 4, 4);
  }
  bass.play(g(CH.outro.slice(0, 4).map((c) => bassBar(c))), ob, 4);
  bass.play(g(['D2! - . D2! - . D2! -', 'E1! - . E1! - . E1! -', 'A1!{ring}:8', 'A1!{ring}:8'], 0.85), ob + 4, 4);
  const hookOut = hookB.transpose(2);
  lead.play(hookOut, ob, 4);
  harm.play(harmonize(hookOut, chordOf(CH.outro), 1, A_MAJOR, true), ob, 4);
  const endLead = g(['F#5 - - - - - E5 -', 'E5 - - - G#5 - B5 -', 'A5 - - - - - - -', 'A5!{ring}:8'], 0.97);
  lead.play(endLead, ob + 4, 4);
  harm.play(harmonize(endLead.slice(0, 8), chordOf(['D', 'E']), -1, A_MAJOR), ob + 4, 2);
  harm.play(g(['C#5 - - - - - - -', 'C#5!{ring}:8'], 0.97), ob + 6, 2); // the last chord: A5 over C#5, both chord tones

  // ── drums ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const HAT8 = '8.5.8.5.8.5.8.5.';
  const skate = D({ kick: 'x.......x.x.....', snare: '....X.......X...', hat: HAT8 });
  const skateB = D({ kick: 'x.x.....x.x.....', snare: '....X.......X...', hat: '8.5.8.5.8.5.8.5o' });
  const skateFill = D({ kick: 'x.......x.x.....', snare: '....X.......5678', hat: '8.5.8.5.8.5.....' });
  const skateToms = D({ kick: 'x.......x.......', snare: '....X...xx......', tomHi: '..........xx....', tomMid: '............xx..', tomLo: '..............xX', hat: '8.5.8.5.........' });
  const skateRide = D({ kick: 'x.......x.x.....', snare: '....X.......X...', ride: HAT8 });
  const skateRideB = D({ kick: 'x.x.....x.x.....', snare: '....X.......X...', ride: HAT8 });
  const skateRideFill = D({ kick: 'x.......x.x.....', snare: '....X.......5678', ride: '8.5.8.5.8.5.....' });
  const polka = D({ kick: 'x...x...x...x...', snare: '..X...8...X...8.', hat: '8...7...8...7...' });
  const polkaRide = D({ kick: 'x...x...x...x...', snare: '..X...8...X...8.', ride: '8...7...8...7...' });
  const polkaCrash = D({ kick: 'x...x...x...x...', snare: '..X...8...X...8.', crash: '8.......8.......', crash2: '....7.......7...' });
  const polkaFill = D({ kick: 'x...x...x.......', snare: '..X...8...X.5678', hat: '8...7...8.......' });
  const polkaToms = D({ kick: 'x...x...........', snare: '..X...8.xx......', tomHi: '..........xx....', tomMid: '............xx..', tomLo: '..............xX' });
  const bigFill = D({ kick: 'x.......x.......', snare: 'X.x.x.x.6789....', tomHi: '............xx..', tomLo: '..............xX' });
  const tomBeat = D({ kick: 'x...x...x...x...', snare: '....x.......x...', tomLo: '6.5.6.5.6.5.6.5.' });
  const snare8 = D({ kick: 'x...x...x...x...', snare: 'x.x.x.x.x.x.x.x.' });
  const crash = (bar: number, v = 1, second = false): void => {
    kit.hit(bar, 'crash', v);
    if (second) kit.hit(bar, 'crash2', v * 0.85);
  };
  /** Places one bar of drums per entry. */
  const bars = (at: number, list: Pattern[]): void => list.forEach((p, i) => kit.play(p, at + i, 1));

  // intro and hook
  bars(S.intro.bar, [polka, polka, polka, polkaFill, polka, polka, polka, polkaToms]);
  crash(S.intro.bar, 1, true);
  crash(S.intro.bar + 4);
  bars(S.hook.bar, [polka, polka, polka, polkaToms]);
  crash(S.hook.bar, 1, true);
  // verses
  for (const sec of [S.verse1, S.verse2]) {
    const v = sec.bar;
    bars(v, [skate, skateB, skate, skateFill, skate, skateB, skate, skateToms]);
    // the second half of verse 2 moves from the hats to the ride
    if (sec === S.verse1) bars(v + 8, [skate, skateB, skate, skateFill, skate, skateB, skate, bigFill]);
    else bars(v + 8, [skateRide, skateRideB, skateRide, skateRideFill, skateRide, skateRideB, skateRide, bigFill]);
    crash(v);
    crash(v + 8, 0.9);
  }
  // pre-choruses: floor-tom drive, snare eighths, the stop
  const stop = D({ kick: 'X...............', crash: 'X...............', snare: '............5678' });
  for (const sec of [S.pre1, S.pre2]) {
    bars(sec.bar, [tomBeat, tomBeat, tomBeat, tomBeat, tomBeat, tomBeat, snare8, stop]);
    crash(sec.bar, 0.9);
    crash(sec.bar + 4, 0.9);
  }
  // choruses
  for (const sec of [S.chorus1, S.chorus2]) {
    const c = sec.bar;
    const second = sec === S.chorus2;
    const body = second ? polkaCrash : polkaRide;
    bars(c, [polkaRide, polkaRide, polkaRide, polkaFill, polkaRide, polkaRide, polkaRide, polkaToms, body, body, body, polkaFill, body, body, body, bigFill]);
    crash(c, 1, true);
    crash(c + 4, 0.9);
    crash(c + 8, 1, true);
    crash(c + 12, 0.9);
  }
  // solo: ride and skate beat, then the polka beat with crashes
  bars(S.solo.bar, [skateRide, skateRide, skateRide, skateFill, skateRide, skateRide, skateRide, skateToms, polka, polka, polka, polkaFill, polka, polka, polka, bigFill]);
  crash(S.solo.bar, 1, true);
  for (const k of [4, 8, 10, 12, 14]) crash(S.solo.bar + k, 0.85);
  // breakdown: silence, hats, kick and snare, snare eighths, the roll
  bars(bd + 2, [D({ hatC: '6.5.6.5.6.5.6.5.' }), D({ hatC: '6.5.6.5.6.5.6.5.' }), D({ kick: 'x...x.x...x.x.x.', snare: '....X.......X...', hat: HAT8 }), D({ kick: 'x...x.x...x.x.x.', snare: '....X.......X.x.', hat: '8.5.8.5.8.5.8...' }), snare8, D({ kick: 'x.......x.......', snare: '1234567899999999' })]);
  crash(bd + 4, 0.8);
  // final chorus
  const f = S.final.bar;
  bars(f, [polkaCrash, polkaCrash, polkaCrash, polkaFill, polkaCrash, polkaCrash, polkaCrash, polkaToms, polkaCrash, polkaCrash, polkaCrash, polkaFill, polkaCrash, polkaCrash, polkaCrash, bigFill]);
  crash(f, 1, true);
  crash(f + 8, 1, true);
  // outro: the hook, three stabs, the roll and the last hit
  bars(ob, [polka, polka, polka, polkaFill]);
  crash(ob, 1, true);
  const stabs = D({ kick: 'X.....X.....X...', snare: 'X.....X.....X...', crash: 'X.....X.....X...' });
  bars(ob + 4, [stabs, stabs, D({ kick: 'X...............', crash: 'X...............', crash2: 'X...............', tomHi: '....xxxx........', tomMid: '........xxxx....', tomLo: '............xxxx' }), D({ kick: 'X...............', snare: 'X...............', crash: 'X...............', crash2: 'X...............' })]);

  // ── groove, sends and master ────────────────────────────────────────────────────────────────────────────────────────────────
  lead.auto('mix.delay', [[S.solo.bar, 0.22, 'step'], [S.solo.end, 0.12, 'step']]);
  lead.auto('mix.reverb', [[S.intro.bar, 0.3], [S.verse1.bar, 0.14, 'step'], [S.hook.bar, 0.3, 'step'], [S.verse2.bar, 0.14, 'step'], [S.solo.bar + 8, 0.28, 'step'], [S.solo.bar + 12, 0.14, 'step'], [ob, 0.28, 'step']]);
  s.setReverb({ time: 1.4, damp: 0.55, return: -11, lowCut: 200 });
  s.setDelay({ time: '1/8.', feedback: 0.28, return: -14, tone: 3800 });
  s.setMaster({ glue: 1, sat: 0.3, trim: -0.5 }); // AUTOTRIM's value
});
