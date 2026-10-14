/**
 * Generative menu soundtrack — warm synthwave / ambient, built from a real chord progression with
 * smooth voice leading rather than random notes. Everything is native Web Audio synthesis.
 *
 *   key / tempo   A minor (Aeolian + harmonic-minor dominant), 96 BPM
 *   progression   | Am9 | Fmaj9 | Cmaj9 | G6/9 | Am9 | Fmaj9 | Dm9 | Esus4 - E7 |   (8 bars, loops)
 *   form          32 bars = 4 blocks:  intro  ->  groove  ->  full (lead melody)  ->  breakdown
 *   layers        detuned-saw pad with moving filter, sidechain-pumped bass, plucked arpeggio into a
 *                 dotted-eighth ping-pong delay, sparse stepwise lead, soft kick / clap / hats
 *
 * Scheduling is look-ahead on the audio clock; it can run live (timer + system update) or be
 * rendered into an OfflineAudioContext.
 */
import { Rng } from './dsp/util';

const BPM = 96;
const BEAT = 60 / BPM;
const STEP = BEAT / 4; // 16th note
const BAR_STEPS = 16;
const FORM_BARS = 32;

export const MUSIC_KEY = 'A minor';
/** Pitch classes (0 = C) that make up the chords of the progression, used by tests. */
export const MUSIC_PITCH_CLASSES = new Set([0, 2, 4, 5, 7, 8, 9, 11]); // C D E F G G# A B

function mtof(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

interface Seg {
  /** Bass root (MIDI). */
  bass: number;
  /** Pad voicing (MIDI). */
  pad: number[];
  /** Notes the arp / lead may use (MIDI, mid-high register). */
  tones: number[];
  /** First step inside the bar, and length in steps. */
  at: number;
  len: number;
}

/** One entry per bar; bar 7 is split in two segments (Esus4 -> E7). */
const PROGRESSION: Seg[][] = [
  [{ bass: 33, pad: [57, 60, 64, 67, 71], tones: [69, 72, 76, 79, 83], at: 0, len: 16 }], // Am9
  [{ bass: 29, pad: [57, 60, 64, 67], tones: [69, 72, 76, 77, 79], at: 0, len: 16 }], // Fmaj9 (Am7/F)
  [{ bass: 36, pad: [59, 62, 64, 67], tones: [67, 71, 72, 74, 79], at: 0, len: 16 }], // Cmaj9 (Em7/C)
  [{ bass: 31, pad: [59, 62, 64, 69], tones: [67, 71, 74, 76, 81], at: 0, len: 16 }], // G6/9
  [{ bass: 33, pad: [57, 60, 64, 67, 71], tones: [69, 72, 76, 79, 83], at: 0, len: 16 }], // Am9
  [{ bass: 29, pad: [57, 60, 64, 67], tones: [69, 72, 76, 77, 79], at: 0, len: 16 }], // Fmaj9
  [{ bass: 38, pad: [57, 60, 64, 65], tones: [69, 72, 74, 76, 77], at: 0, len: 16 }], // Dm9 (Fmaj7/D)
  [
    { bass: 28, pad: [59, 62, 64, 69], tones: [69, 71, 74, 76, 81], at: 0, len: 8 }, // E7sus4
    { bass: 28, pad: [59, 62, 64, 68], tones: [68, 71, 74, 76, 80], at: 8, len: 8 }, // E7
  ],
];

type Layer = 'pad' | 'bass' | 'kick' | 'snare' | 'hat' | 'arp' | 'lead';
const FORM: Record<number, Layer[]> = {
  0: ['pad', 'bass', 'hat'],
  1: ['pad', 'bass', 'kick', 'snare', 'hat', 'arp'],
  2: ['pad', 'bass', 'kick', 'snare', 'hat', 'arp', 'lead'],
  3: ['pad', 'bass', 'arp'],
};

const ARP_PATTERNS = [
  [0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1],
  [0, 2, 1, 3, 2, 4, 3, 1, 0, 2, 1, 3, 2, 4, 3, 2],
  [4, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 4],
];
const ARP_MASK = [
  [1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0, 1, 0],
  [1, 0, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1],
];

export interface MusicOptions {
  /** Start inside the form (bar index) — handy for previews of the full band. */
  startBar?: number;
  seed?: number;
}

export class MenuMusic {
  private ctx: BaseAudioContext;
  private out: GainNode;
  private padBus: GainNode;
  private bassBus: GainNode;
  private arpBus: GainNode;
  private leadBus: GainNode;
  private drumBus: GainNode;
  private duck: GainNode;
  private reverb: ConvolverNode;
  private reverbSend: GainNode;
  private delayIn: GainNode;
  private nodes: AudioNode[] = [];
  private noise: AudioBuffer;
  private rng: Rng;
  private running = false;
  private nextTime = 0;
  private step = 0; // global 16th counter
  private startBar: number;
  private lastLead = 76;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: BaseAudioContext, dest: AudioNode, opts: MusicOptions = {}) {
    this.ctx = ctx;
    this.startBar = opts.startBar ?? 0;
    this.rng = new Rng((opts.seed ?? 20241) | 0);
    this.out = ctx.createGain();
    this.out.gain.value = 0.72;
    this.out.connect(dest);

    // sidechain duck shared by the tonal layers
    this.duck = ctx.createGain();
    this.duck.gain.value = 1;
    this.duck.connect(this.out);
    this.padBus = ctx.createGain();
    this.bassBus = ctx.createGain();
    this.arpBus = ctx.createGain();
    this.leadBus = ctx.createGain();
    this.drumBus = ctx.createGain();
    this.padBus.gain.value = 0.2;
    this.bassBus.gain.value = 0.5;
    this.arpBus.gain.value = 0.2;
    this.leadBus.gain.value = 0.22;
    this.drumBus.gain.value = 0.85;
    this.padBus.connect(this.duck);
    this.bassBus.connect(this.duck);
    this.arpBus.connect(this.duck);
    this.leadBus.connect(this.out);
    this.drumBus.connect(this.out);

    // shared reverb (damped, ~3 s)
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeReverbIR(3.2);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(wet);
    wet.connect(this.out);
    for (const [bus, amt] of [
      [this.padBus, 0.55],
      [this.arpBus, 0.45],
      [this.leadBus, 0.6],
      [this.drumBus, 0.18],
    ] as [GainNode, number][]) {
      const s = ctx.createGain();
      s.gain.value = amt;
      bus.connect(s);
      s.connect(this.reverbSend);
      this.nodes.push(s);
    }

    // dotted-eighth stereo ping-pong delay for arp + lead
    this.delayIn = ctx.createGain();
    this.delayIn.gain.value = 1;
    const dl = ctx.createDelay(1.5);
    const dr = ctx.createDelay(1.5);
    dl.delayTime.value = STEP * 3;
    dr.delayTime.value = STEP * 3;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 3200;
    const merger = ctx.createChannelMerger(2);
    this.delayIn.connect(dl);
    dl.connect(damp);
    damp.connect(dr);
    dr.connect(fb);
    fb.connect(dl);
    dl.connect(merger, 0, 0);
    dr.connect(merger, 0, 1);
    const dOut = ctx.createGain();
    dOut.gain.value = 0.5;
    merger.connect(dOut);
    dOut.connect(this.out);
    this.arpBus.connect(this.delayIn);
    this.leadBus.connect(this.delayIn);
    this.nodes.push(dl, dr, fb, damp, merger, dOut, wet);

    // shared noise for drums
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    const r = new Rng(777);
    for (let i = 0; i < d.length; i++) d[i] = r.s2();
  }

  private makeReverbIR(seconds: number): AudioBuffer {
    const sr = this.ctx.sampleRate;
    const n = Math.floor(sr * seconds);
    const buf = this.ctx.createBuffer(2, n, sr);
    const r = new Rng(4242);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const k = 0.45 * Math.exp(-4 * t) + 0.025;
        lp += k * (r.s2() - lp);
        d[i] = lp * Math.exp(-5.2 * t) * (1 - Math.exp(-i / (0.02 * sr)));
      }
    }
    return buf;
  }

  // ── transport ─────────────────────────────────────────────────────────────

  /** Begin (or resume) playing; bars restart at the beginning of the current form position. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.nextTime = this.ctx.currentTime + 0.12;
    this.step = Math.floor(this.step / BAR_STEPS) * BAR_STEPS || this.startBar * BAR_STEPS;
    this.tick();
    if (typeof setInterval === 'function' && !(typeof OfflineAudioContext !== 'undefined' && this.ctx instanceof OfflineAudioContext)) {
      this.timer = setInterval(() => this.tick(), 120);
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Schedule everything that falls inside the look-ahead window. */
  tick(): void {
    if (!this.running) return;
    // generous look-ahead so a throttled background timer (1 Hz) does not leave gaps in the music
    const horizon = this.ctx.currentTime + 1.6;
    while (this.nextTime < horizon) {
      this.scheduleStep(this.step, this.nextTime);
      this.step++;
      this.nextTime += STEP;
    }
  }

  /** Offline rendering: schedule every step up to `seconds`. */
  renderUntil(seconds: number): void {
    this.running = true;
    this.nextTime = 0.05;
    this.step = this.startBar * BAR_STEPS;
    while (this.nextTime < seconds) {
      this.scheduleStep(this.step, this.nextTime);
      this.step++;
      this.nextTime += STEP;
    }
    this.running = false;
  }

  dispose(): void {
    this.stop();
    for (const n of [this.out, this.padBus, this.bassBus, this.arpBus, this.leadBus, this.drumBus, this.duck, this.reverb, this.reverbSend, this.delayIn, ...this.nodes]) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  // ── arrangement ───────────────────────────────────────────────────────────

  private scheduleStep(globalStep: number, t: number): void {
    const bar = Math.floor(globalStep / BAR_STEPS);
    const s = globalStep % BAR_STEPS;
    const formBar = bar % FORM_BARS;
    const block = Math.floor(formBar / 8);
    const layers = FORM[block];
    const barInProg = bar % 8;
    const segs = PROGRESSION[barInProg];
    const seg = segs.length === 1 || s < segs[1].at ? segs[0] : segs[1];
    const has = (l: Layer): boolean => layers.includes(l);

    // pad: new chord at each segment start
    if (has('pad') && s === seg.at) this.pad(t, seg, seg.len * STEP, block === 3 ? 1.0 : 0.8);

    // drums
    if (has('kick')) {
      // 1, 3 and a syncopated "and of 3" now and then
      if (s === 0 || s === 8 || (s === 11 && barInProg % 2 === 1)) this.kick(t, s === 0 ? 1 : 0.85);
    }
    if (has('snare') && (s === 4 || s === 12)) this.clap(t, 0.9);
    if (has('hat')) {
      if (s % 2 === 0) this.hat(t, s % 4 === 2 ? 0.55 : 0.32, false);
      if (s === 14 && barInProg % 2 === 1) this.hat(t, 0.5, true);
    }

    // bass: eighth-note pulse (quarter-note sustain in the intro / breakdown)
    if (has('bass')) {
      const soft = block === 0 || block === 3;
      if (soft) {
        if (s === seg.at) this.bass(t, seg.bass, seg.len * STEP * 0.96, 0.7, false);
      } else if (s % 2 === 0) {
        const up = s === 6 || s === 14;
        const note = up ? seg.bass + 12 : seg.bass;
        this.bass(t, note, STEP * 1.7, up ? 0.5 : 0.85, true);
      }
    }

    // arpeggio
    if (has('arp')) {
      const dens = block === 3 ? 0 : 1;
      const pat = ARP_PATTERNS[(bar >> 1) % ARP_PATTERNS.length];
      const mask = ARP_MASK[bar % 2];
      if (mask[s] || (dens === 0 && s % 2 === 0)) {
        const note = seg.tones[pat[s] % seg.tones.length] + (pat[s] >= 4 ? 0 : 0);
        this.pluck(t, note, STEP * 1.6, block === 3 ? 0.28 : 0.4 + 0.12 * (s % 4 === 0 ? 1 : 0));
      }
    }

    // lead: stepwise melody on chord tones, resolving onto chord tones on strong beats
    if (has('lead')) this.leadStep(t, formBar, s, seg);
  }

  // ── lead melody ───────────────────────────────────────────────────────────

  private leadTemplates = [
    [
      [0, 6],
      [6, 2],
      [8, 8],
    ],
    [
      [0, 4],
      [4, 4],
      [8, 6],
    ],
    [
      [0, 10],
      [10, 3],
      [13, 3],
    ],
    [
      [2, 6],
      [8, 4],
      [12, 4],
    ],
  ];
  private leadPlan: { bar: number; events: Map<number, number> } | null = null;

  private leadStep(t: number, formBar: number, s: number, seg: Seg): void {
    // plan the bar's rhythm at its first step; play every other bar so the melody breathes
    if (!this.leadPlan || this.leadPlan.bar !== formBar) {
      const events = new Map<number, number>();
      if (formBar % 2 === 0 || this.rng.u() < 0.3) {
        const tpl = this.leadTemplates[Math.floor(this.rng.u() * this.leadTemplates.length)];
        for (const [at, len] of tpl) events.set(at, len);
      }
      this.leadPlan = { bar: formBar, events };
    }
    const len = this.leadPlan.events.get(s);
    if (len === undefined) return;
    // candidate notes: the segment tones plus the octave below, within a singing range
    const pool: number[] = [];
    for (const n of seg.tones) {
      pool.push(n, n - 12);
    }
    const lo = pool.filter((n) => n >= 69 && n <= 86).sort((a, b) => a - b);
    // prefer nearest to the previous note with a small bias toward stepwise motion
    let best = lo[0];
    let bestScore = Infinity;
    for (const n of lo) {
      const jump = Math.abs(n - this.lastLead);
      const score = Math.abs(jump - 2.5) + this.rng.u() * 1.2 + (n === this.lastLead ? 1.5 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = n;
      }
    }
    this.lastLead = best;
    this.lead(t, best, len * STEP * 0.96, 0.5);
  }

  // ── voices ────────────────────────────────────────────────────────────────

  private env(g: GainNode, t: number, a: number, peak: number, d: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  private pad(t: number, seg: Seg, dur: number, level: number): void {
    const ctx = this.ctx;
    const attack = 1.1;
    const release = 1.9;
    const total = dur + release;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 0.8;
    f.frequency.setValueAtTime(700, t);
    f.frequency.linearRampToValueAtTime(1500, t + dur * 0.6);
    f.frequency.linearRampToValueAtTime(800, t + total);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.11 + this.rng.u() * 0.06;
    const lg = ctx.createGain();
    lg.gain.value = 260;
    lfo.connect(lg);
    lg.connect(f.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(level, t + attack);
    g.gain.setValueAtTime(level, t + Math.max(attack, dur - 0.2));
    g.gain.linearRampToValueAtTime(0.0001, t + total);
    f.connect(g);
    g.connect(this.padBus);
    lfo.start(t);
    lfo.stop(t + total + 0.1);
    const per = 1 / Math.sqrt(seg.pad.length);
    for (const m of seg.pad) {
      const fr = mtof(m);
      for (const [type, det, gain] of [
        ['sawtooth', -9, 0.5],
        ['sawtooth', 8, 0.5],
        ['triangle', 0, 0.55],
      ] as [OscillatorType, number, number][]) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = fr;
        o.detune.value = det + (this.rng.u() - 0.5) * 4;
        const og = ctx.createGain();
        og.gain.value = gain * per * 0.5;
        o.connect(og);
        og.connect(f);
        o.start(t);
        o.stop(t + total + 0.1);
      }
    }
  }

  private bass(t: number, midi: number, dur: number, vel: number, pluck: boolean): void {
    const ctx = this.ctx;
    const fr = mtof(midi);
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 2.2;
    lp.frequency.setValueAtTime(pluck ? 1100 : 420, t);
    lp.frequency.exponentialRampToValueAtTime(pluck ? 260 : 300, t + (pluck ? 0.16 : dur));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.008);
    g.gain.setValueAtTime(vel, t + Math.max(0.01, dur - 0.08));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = fr;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = fr;
    const sg = ctx.createGain();
    sg.gain.value = 0.9;
    saw.connect(lp);
    lp.connect(g);
    sub.connect(sg);
    sg.connect(g);
    g.connect(this.bassBus);
    saw.start(t);
    sub.start(t);
    saw.stop(t + dur + 0.05);
    sub.stop(t + dur + 0.05);
  }

  private pluck(t: number, midi: number, dur: number, vel: number): void {
    const ctx = this.ctx;
    const fr = mtof(midi);
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(3600, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + 0.2);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.14);
    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    o1.frequency.value = fr;
    o1.detune.value = -6;
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.value = fr;
    o2.detune.value = 7;
    const o2g = ctx.createGain();
    o2g.gain.value = 0.4;
    o1.connect(lp);
    o2.connect(o2g);
    o2g.connect(lp);
    lp.connect(g);
    g.connect(this.arpBus);
    for (const o of [o1, o2]) {
      o.start(t);
      o.stop(t + dur + 0.2);
    }
  }

  private lead(t: number, midi: number, dur: number, vel: number): void {
    const ctx = this.ctx;
    const fr = mtof(midi);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.03);
    g.gain.setValueAtTime(vel * 0.85, t + Math.max(0.05, dur * 0.7));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.25);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    lp.Q.value = 0.7;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(fr * 0.985, t);
    o.frequency.exponentialRampToValueAtTime(fr, t + 0.05);
    const o2 = ctx.createOscillator();
    o2.type = 'sawtooth';
    o2.frequency.value = fr;
    o2.detune.value = 5;
    const o2g = ctx.createGain();
    o2g.gain.value = 0.22;
    // gentle vibrato after the attack
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vg = ctx.createGain();
    vg.gain.setValueAtTime(0, t);
    vg.gain.linearRampToValueAtTime(fr * 0.0035, t + 0.35);
    vib.connect(vg);
    vg.connect(o.frequency);
    vg.connect(o2.frequency);
    o.connect(lp);
    o2.connect(o2g);
    o2g.connect(lp);
    lp.connect(g);
    g.connect(this.leadBus);
    for (const x of [o, o2, vib]) {
      x.start(t);
      x.stop(t + dur + 0.3);
    }
  }

  private kick(t: number, vel: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.85 * vel, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(g);
    g.connect(this.drumBus);
    o.start(t);
    o.stop(t + 0.36);
    // click
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 2500;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.12 * vel, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
    n.connect(f);
    f.connect(ng);
    ng.connect(this.drumBus);
    n.start(t);
    n.stop(t + 0.02);
    // sidechain pump
    this.duck.gain.setValueAtTime(0.42, t);
    this.duck.gain.linearRampToValueAtTime(1, t + 0.2);
  }

  private clap(t: number, vel: number): void {
    const ctx = this.ctx;
    for (const dt of [0, 0.011, 0.023]) {
      const n = ctx.createBufferSource();
      n.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1900;
      f.Q.value = 0.8;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + dt);
      g.gain.linearRampToValueAtTime(0.32 * vel, t + dt + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dt + (dt === 0.023 ? 0.16 : 0.03));
      n.connect(f);
      f.connect(g);
      g.connect(this.drumBus);
      n.start(t + dt, this.rng.u() * 0.5);
      n.stop(t + dt + 0.2);
    }
  }

  private hat(t: number, vel: number, open: boolean): void {
    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7200;
    const g = ctx.createGain();
    const d = open ? 0.18 : 0.04;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.12 * vel, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    n.connect(f);
    f.connect(g);
    g.connect(this.drumBus);
    n.start(t, this.rng.u() * 0.5);
    n.stop(t + d + 0.02);
  }
}

export const MUSIC_INFO = { bpm: BPM, key: MUSIC_KEY, bars: FORM_BARS, stepSeconds: STEP, barSeconds: STEP * BAR_STEPS };
/** Chord roots in MIDI per bar of the 8-bar progression (tests verify the harmony against the render). */
export const MUSIC_BASS_ROOTS = PROGRESSION.map((segs) => segs.map((s) => s.bass % 12));

/** Pitch classes (0 = C) of the pad voicing + melody pool per bar segment, for harmony tests. */
export const MUSIC_CHORD_PITCHES: number[][][] = PROGRESSION.map((segs) => segs.map((s) => Array.from(new Set([...s.pad, ...s.tones, s.bass])).map((m) => m % 12)));
