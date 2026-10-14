/**
 * UI sounds: crisp, premium, fully synthesised with native nodes (no samples). Works on any
 * BaseAudioContext, so the same code renders live, offline and into the preview WAVs.
 *
 *  move      tiny glass tick (varies slightly so scrolling does not machine-gun)
 *  select    bright two-note confirm (perfect fifth, FM bell)
 *  back      soft falling two-note
 *  error     low dissonant double buzz
 *  countdown start-light beep (relay click + pure 880 Hz), identical for every red light
 *  go        higher, longer GO tone with a sub thump
 *  lap       two-note chime
 *  bestLap   rising E-major arpeggio with shimmer and sparkle
 *  finish    chequered "ding-ding-ding" then a held major chord
 */
import type { UiSound } from '../core/contracts';

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.0), ctx.sampleRate);
    const d = b.getChannelData(0);
    let s = 0x1234567;
    for (let i = 0; i < d.length; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      d[i] = ((s >>> 0) / 4294967296) * 2 - 1;
    }
    noiseCache.set(ctx, b);
  }
  return b;
}

function makeImpulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, n, sr);
  let s = 0x9e3779b1;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const x = ((s >>> 0) / 4294967296) * 2 - 1;
      const t = i / n;
      const k = 0.5 * Math.exp(-3.2 * t) + 0.04; // progressive HF damping
      lp += k * (x - lp);
      d[i] = lp * Math.exp(-decay * t * 3) * (1 - Math.exp(-i / (0.004 * sr)));
    }
  }
  return buf;
}

interface BellOpts {
  /** FM modulation index (brightness). */
  index?: number;
  /** Modulator / carrier ratio. */
  ratio?: number;
  pan?: number;
  attack?: number;
  send?: number;
}

export class UiSynth {
  private reverb: ConvolverNode;
  private reverbIn: GainNode;
  private busOut: GainNode;
  private lastMove = -1;

  constructor(
    private ctx: BaseAudioContext,
    private dest: AudioNode,
  ) {
    this.busOut = ctx.createGain();
    this.busOut.gain.value = 0.8;
    this.busOut.connect(dest);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx, 0.9, 1.6);
    this.reverbIn = ctx.createGain();
    this.reverbIn.gain.value = 1;
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    this.reverbIn.connect(this.reverb);
    this.reverb.connect(wet);
    wet.connect(dest);
  }

  dispose(): void {
    for (const n of [this.busOut, this.reverb, this.reverbIn]) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  private out(pan: number, send: number): { node: AudioNode } {
    const g = this.ctx.createGain();
    if (typeof this.ctx.createStereoPanner === 'function' && pan !== 0) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      p.connect(this.busOut);
      if (send > 0) {
        const s = this.ctx.createGain();
        s.gain.value = send;
        p.connect(s);
        s.connect(this.reverbIn);
      }
    } else {
      g.connect(this.busOut);
      if (send > 0) {
        const s = this.ctx.createGain();
        s.gain.value = send;
        g.connect(s);
        s.connect(this.reverbIn);
      }
    }
    return { node: g };
  }

  /** FM bell: carrier + modulator, exponential decay, plus an inharmonic partial for the "ting". */
  private bell(when: number, freq: number, dur: number, peak: number, o: BellOpts = {}): void {
    const ctx = this.ctx;
    const index = o.index ?? 1.6;
    const ratio = o.ratio ?? 2;
    const attack = o.attack ?? 0.003;
    const { node: out } = this.out(o.pan ?? 0, o.send ?? 0.35);
    const env = out as GainNode;
    env.gain.setValueAtTime(0.0001, when);
    env.gain.linearRampToValueAtTime(peak, when + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    const car = ctx.createOscillator();
    car.type = 'sine';
    car.frequency.value = freq;
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = freq * ratio;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(freq * index, when);
    mg.gain.exponentialRampToValueAtTime(freq * 0.02, when + dur * 0.6);
    mod.connect(mg);
    mg.connect(car.frequency);
    car.connect(env);
    // inharmonic partial
    const p2 = ctx.createOscillator();
    p2.type = 'sine';
    p2.frequency.value = freq * 2.76;
    const pg = ctx.createGain();
    pg.gain.setValueAtTime(0.16, when);
    pg.gain.exponentialRampToValueAtTime(0.0001, when + dur * 0.35);
    p2.connect(pg);
    pg.connect(env);
    for (const o2 of [car, mod, p2]) {
      o2.start(when);
      o2.stop(when + dur + 0.05);
    }
  }

  /** Plain enveloped tone. */
  private tone(
    when: number,
    type: OscillatorType,
    freq: number,
    dur: number,
    peak: number,
    opts: { attack?: number; release?: number; pan?: number; send?: number; lp?: number; glideTo?: number; glideTime?: number; detune?: number } = {},
  ): void {
    const ctx = this.ctx;
    const attack = opts.attack ?? 0.003;
    const release = opts.release ?? 0.04;
    const { node: out } = this.out(opts.pan ?? 0, opts.send ?? 0.2);
    const env = out as GainNode;
    env.gain.setValueAtTime(0.0001, when);
    env.gain.linearRampToValueAtTime(peak, when + attack);
    env.gain.setValueAtTime(peak, when + Math.max(attack, dur - release));
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, when);
    if (opts.glideTo) o.frequency.exponentialRampToValueAtTime(opts.glideTo, when + (opts.glideTime ?? 0.03));
    if (opts.detune) o.detune.value = opts.detune;
    let node: AudioNode = o;
    if (opts.lp) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = opts.lp;
      f.Q.value = 0.5;
      o.connect(f);
      node = f;
    }
    node.connect(env);
    o.start(when);
    o.stop(when + dur + 0.05);
  }

  private click(when: number, fc: number, q: number, dur: number, peak: number, pan = 0): void {
    const ctx = this.ctx;
    const { node: out } = this.out(pan, 0.1);
    const env = out as GainNode;
    env.gain.setValueAtTime(peak, when);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = fc;
    f.Q.value = q;
    src.connect(f);
    f.connect(env);
    src.start(when, Math.random() * 0.5);
    src.stop(when + dur + 0.02);
  }

  play(kind: UiSound, when = this.ctx.currentTime + 0.005): void {
    const t = when;
    switch (kind) {
      case 'move': {
        // random detune so repeated moves feel organic; rate-limited to avoid pile-ups
        if (t - this.lastMove < 0.025) return;
        this.lastMove = t;
        const f = 1650 * (1 + (Math.random() - 0.5) * 0.05);
        this.tone(t, 'sine', f, 0.034, 0.2, { attack: 0.0015, release: 0.028, glideTo: f * 0.8, glideTime: 0.03, send: 0.12 });
        this.click(t, 3200, 2, 0.006, 0.08);
        break;
      }
      case 'select':
        this.bell(t, 880, 0.24, 0.42, { index: 1.2, pan: -0.1, send: 0.3 });
        this.bell(t + 0.055, 1318.5, 0.34, 0.46, { index: 1.4, pan: 0.1, send: 0.35 });
        this.click(t, 4200, 3, 0.006, 0.05);
        break;
      case 'back':
        this.tone(t, 'triangle', 988, 0.1, 0.28, { attack: 0.004, release: 0.07, send: 0.15, lp: 3400 });
        this.tone(t + 0.055, 'triangle', 740, 0.16, 0.3, { attack: 0.004, release: 0.12, send: 0.2, lp: 2800 });
        break;
      case 'error':
        for (const [dt, f] of [
          [0, 165],
          [0.12, 155],
        ] as [number, number][]) {
          this.tone(t + dt, 'sawtooth', f, 0.1, 0.34, { attack: 0.006, release: 0.05, lp: 1000, send: 0.05 });
          this.tone(t + dt, 'sawtooth', f * 1.0, 0.1, 0.2, { attack: 0.006, release: 0.05, lp: 900, send: 0.05, detune: 22 });
        }
        break;
      case 'countdown':
        // start-light relay click then a pure, dry beep
        this.click(t, 2400, 1.5, 0.012, 0.22);
        this.tone(t + 0.004, 'sine', 880, 0.14, 0.5, { attack: 0.002, release: 0.045, send: 0.05 });
        this.tone(t + 0.004, 'sine', 1760, 0.14, 0.07, { attack: 0.002, release: 0.045, send: 0.05 });
        break;
      case 'go':
        this.click(t, 3000, 1.2, 0.014, 0.26);
        this.tone(t + 0.004, 'sine', 1180, 0.42, 0.38, { attack: 0.002, release: 0.28, glideTo: 1319, glideTime: 0.03, send: 0.15 });
        this.tone(t + 0.004, 'sine', 2638, 0.3, 0.07, { attack: 0.002, release: 0.2, send: 0.1 });
        this.tone(t + 0.004, 'sine', 1760, 0.36, 0.11, { attack: 0.002, release: 0.24, send: 0.1 });
        this.tone(t, 'sine', 110, 0.16, 0.32, { attack: 0.003, release: 0.12, glideTo: 55, glideTime: 0.12, send: 0 });
        break;
      case 'lap':
        this.bell(t, 659.3, 0.42, 0.42, { index: 1.1, pan: -0.15, send: 0.4 });
        this.bell(t + 0.11, 987.8, 0.62, 0.48, { index: 1.2, pan: 0.15, send: 0.45 });
        break;
      case 'bestLap': {
        const notes = [659.3, 830.6, 987.8, 1318.5];
        notes.forEach((f, i) => {
          this.bell(t + i * 0.075, f, 0.7 + i * 0.1, 0.4 + i * 0.03, { index: 1.3, pan: -0.25 + i * 0.17, send: 0.5 });
          this.bell(t + i * 0.075 + 0.006, f * 2.003, 0.5, 0.12, { index: 0.8, pan: 0.2 - i * 0.12, send: 0.5 });
        });
        // sparkle
        for (let i = 0; i < 6; i++) this.click(t + 0.2 + i * 0.07 + Math.random() * 0.03, 7500 + Math.random() * 2500, 6, 0.05, 0.05, (Math.random() - 0.5) * 1.4);
        this.bell(t + 0.32, 1318.5, 1.1, 0.34, { index: 0.9, send: 0.6 });
        break;
      }
      case 'finish': {
        // chequered flag: three quick dings then a held A-major chord
        for (let i = 0; i < 3; i++) this.bell(t + i * 0.12, 1318.5, 0.34, 0.32, { index: 1.0, pan: (i - 1) * 0.3, send: 0.3 });
        const t2 = t + 0.42;
        [440, 554.4, 659.3, 880].forEach((f, i) => {
          this.bell(t2 + i * 0.02, f, 1.5, 0.24, { index: 0.8, ratio: 1, pan: -0.3 + i * 0.2, send: 0.6, attack: 0.008 });
          this.tone(t2 + i * 0.02, 'triangle', f, 1.4, 0.06, { attack: 0.05, release: 0.9, send: 0.6, lp: 3000 });
        });
        this.tone(t2, 'sine', 110, 1.3, 0.2, { attack: 0.01, release: 0.8, send: 0.2 });
        break;
      }
    }
  }
}

export const UI_SOUND_LIST: UiSound[] = ['move', 'select', 'back', 'error', 'countdown', 'go', 'lap', 'bestLap', 'finish'];
