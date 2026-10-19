/**
 * Acoustic drum kit (for punk, rock and anything that wants a real-sounding kit): kick, snare with rattling wires, rim
 * shots, three toms, closed / open / pedal hi-hat, two crashes, ride, ride bell, splash and china, all in one stereo
 * instrument with a small room.
 *
 * Modal synthesis: drum heads are sets of inharmonic damped modes (the Bessel-zero frequency ratios of an ideal membrane) with
 * a small pitch relaxation after the strike, the snare wires are noise whose level follows the head, cymbals and hats are
 * buffers of dense modal partials built once (dsp/cymbal.ts). Harder hits get more high modes, more wires and more
 * brightness, not only more volume.
 *
 * Parts (use them as lanes of s.drums({...})): kick, snare, rim, hat (closed; the o flag makes it open), hatC, hatO, hatP,
 * tomHi, tomMid, tomLo, crash, crash2, ride, bell, splash, china.
 */
import { Noise, Rng, TAU, dbToLin, sinCyc, tanh3 } from '../dsp/core';
import { Biquad } from '../dsp/filters';
import { Reverb } from '../dsp/reverb';
import { CymbalBuffer } from '../dsp/cymbal';
import { BLOCK, Ctx, FLAG, Instrument, ParamBase, ParamSpecs, PresetDef, resolveOpts } from '../instrument';
import { cymbalBuffer } from './drums';

export const AKIT_SPECS = {
  level: { default: 0, min: -30, max: 12, unit: 'dB', doc: 'Trim in dB on top of the preset\'s calibrated loudness (0 = as calibrated; the fader is the channel\'s `gain` in the mix).' },
  kickTune: { default: 62, min: 38, max: 110, unit: 'Hz', curve: 'exp', doc: 'Kick drum fundamental.' },
  kickDecay: { default: 0.2, min: 0.05, max: 0.7, unit: 's', doc: 'Kick ring time.' },
  kickClick: { default: 0.6, min: 0, max: 1.5, doc: 'Beater click (punk kicks want a lot).' },
  kickGain: { default: 0, min: -30, max: 12, unit: 'dB', doc: 'Kick level inside the kit.' },
  snareTune: { default: 205, min: 140, max: 340, unit: 'Hz', curve: 'exp', doc: 'Snare head pitch.' },
  snareDecay: { default: 0.16, min: 0.04, max: 0.6, unit: 's', doc: 'Snare ring time (head and wires).' },
  snareWires: { default: 0.8, min: 0, max: 1.6, doc: 'Level of the snare wires (the rattle).' },
  snareSnap: { default: 0.5, min: 0, max: 1.5, doc: 'Stick attack on the snare.' },
  snareGain: { default: 0, min: -30, max: 12, unit: 'dB', doc: 'Snare level inside the kit.' },
  tomTune: { default: 1, min: 0.6, max: 1.7, doc: 'Pitch multiplier of the three toms.' },
  tomDecay: { default: 1, min: 0.4, max: 2.2, doc: 'Ring-time multiplier of the toms.' },
  tomGain: { default: 0, min: -30, max: 12, unit: 'dB', doc: 'Tom level inside the kit.' },
  hatGain: { default: 0, min: -30, max: 12, unit: 'dB', doc: 'Hi-hat level inside the kit.' },
  hatTone: { default: 0, min: -1, max: 1, doc: 'Hi-hat brightness shift.' },
  hatDecay: { default: 1, min: 0.2, max: 1, doc: 'Open hat ring (1 = natural, lower = more damped).' },
  cymbalGain: { default: 0, min: -30, max: 12, unit: 'dB', doc: 'Crash / ride / splash / china level inside the kit.' },
  cymbalDecay: { default: 1, min: 0.25, max: 1, doc: 'Cymbal ring (1 = natural, lower = quicker choke).' },
  room: { default: 0.35, min: 0, max: 1.5, doc: 'Level of the room ambience.' },
  roomTime: { default: 0.45, min: 0.1, max: 2, unit: 's', doc: 'Length of the room ambience.' },
  tight: { default: 0, min: 0, max: 1, doc: 'Dampens all the drums (tape on the heads): shorter ring, drier sound.' },
} satisfies ParamSpecs;

export const AKIT_PARTS = ['kick', 'snare', 'rim', 'hat', 'hatC', 'hatO', 'hatP', 'tomHi', 'tomMid', 'tomLo', 'crash', 'crash2', 'ride', 'bell', 'splash', 'china'] as const;
type PartName = (typeof AKIT_PARTS)[number];

/** Stereo position (-1..1, drummer's view) and room-send level of every part. */
const PART_MIX: Record<PartName, { pan: number; send: number }> = {
  kick: { pan: 0, send: 0.1 },
  snare: { pan: -0.05, send: 0.35 },
  rim: { pan: -0.05, send: 0.3 },
  hat: { pan: -0.35, send: 0.12 },
  hatC: { pan: -0.35, send: 0.12 },
  hatO: { pan: -0.35, send: 0.15 },
  hatP: { pan: -0.35, send: 0.12 },
  tomHi: { pan: -0.25, send: 0.4 },
  tomMid: { pan: 0.1, send: 0.4 },
  tomLo: { pan: 0.4, send: 0.4 },
  crash: { pan: -0.5, send: 0.25 },
  crash2: { pan: 0.55, send: 0.25 },
  ride: { pan: 0.45, send: 0.2 },
  bell: { pan: 0.45, send: 0.2 },
  splash: { pan: -0.25, send: 0.2 },
  china: { pan: 0.3, send: 0.2 },
};

export interface AcousticKitOpts {
  preset?: string;
  name?: string;
  [param: string]: unknown;
}

/** One struck drum: a bank of decaying sine modes with a slight pitch relaxation, plus an optional noise part. */
interface Mode {
  ratio: number;
  amp: number;
  /** T60 as a fraction of the drum's decay. */
  decay: number;
}

interface DrumVoice {
  on: boolean;
  t: number;
  ph: Float64Array;
  amps: Float64Array;
  ks: Float64Array;
  f: number;
  g: number;
  vel: number;
  noiseAmp: number;
  noiseAmp2: number;
  wireLp: number;
  clk: number;
  flags: number;
  rattle: number;
  fade: number;
  eq: Biquad;
  hp: Biquad;
  pk: Biquad;
  /** Band-pass for the attack (the kick's beater, the snare's stick crack, the toms' stick). */
  bp: Biquad;
  /** Low-pass on the snare wires (real wires roll off above 8-10 kHz: without it the snare hisses). */
  lp: Biquad;
}

const SNARE_MODES: Mode[] = [
  { ratio: 1, amp: 1, decay: 1 },
  { ratio: 1.593, amp: 0.55, decay: 0.7 },
  { ratio: 2.136, amp: 0.4, decay: 0.5 },
  { ratio: 2.295, amp: 0.3, decay: 0.45 },
  { ratio: 2.653, amp: 0.22, decay: 0.35 },
  { ratio: 2.917, amp: 0.18, decay: 0.3 },
  { ratio: 3.5, amp: 0.1, decay: 0.25 },
];
const TOM_MODES: Mode[] = [
  { ratio: 1, amp: 1, decay: 1 },
  { ratio: 1.593, amp: 0.36, decay: 0.6 },
  { ratio: 2.136, amp: 0.2, decay: 0.45 },
  { ratio: 2.295, amp: 0.12, decay: 0.4 },
];

interface CymVoice {
  on: boolean;
  pos: number;
  g: number;
  lpL: number;
  lpR: number;
  lpK: number;
  choke: number;
  fade: number;
  recipe: PartName;
  decayMul: number;
}

export class AcousticKit extends ParamBase<typeof AKIT_SPECS> implements Instrument {
  readonly stereo = true;
  readonly parts: readonly string[] = AKIT_PARTS;
  /** With `key: true` on the channel only the kick triggers the sidechain (not the snare, hats and cymbals). */
  keyed(part: string): boolean {
    return part === 'kick';
  }
  private readonly sr: number;
  private readonly noise: Noise;
  private readonly noise2: Noise;
  private readonly rng: Rng;
  private readonly kickV: DrumVoice[] = [];
  private readonly snareV: DrumVoice[] = [];
  private readonly tomV: { part: PartName; v: DrumVoice }[] = [];
  private readonly cym: CymVoice[] = [];
  private readonly buffers = new Map<PartName, CymbalBuffer>();
  private readonly room: Reverb;
  private readonly roomL = new Float64Array(BLOCK);
  private readonly roomR = new Float64Array(BLOCK);
  private readonly sendL = new Float64Array(BLOCK);
  private readonly sendR = new Float64Array(BLOCK);
  private readonly panMul: Record<string, { l: number; r: number }> = {};
  private readonly prepared = new Set<PartName>();
  private lastRoomTime = -1;
  /** Samples of room tail left after the last hit (the instrument is skipped when idle). */
  private roomTail = 0;
  private readonly recipeOf: Partial<Record<PartName, string>> = {
    hat: 'hatClosed',
    hatC: 'hatClosed',
    hatO: 'hatOpen',
    hatP: 'hatPedal',
    crash: 'crash',
    crash2: 'crash-dark',
    ride: 'ride',
    bell: 'ride-bell',
    splash: 'splash',
    china: 'china',
  };

  constructor(ctx: Ctx, input?: AcousticKitOpts | string) {
    const o = resolveOpts('acoustic kit', AKIT_PRESETS, input ?? 'rock-kit', AKIT_SPECS, ['pan']);
    super('AcousticKit', AKIT_SPECS, o);
    this.sr = ctx.sr;
    this.noise = new Noise(ctx.seed);
    this.noise2 = new Noise(ctx.seed ^ 0x1f83d9ab);
    this.rng = new Rng(ctx.seed);
    this.room = new Reverb(ctx.sr, { time: 0.45, damp: 0.6, size: 0.5, early: 0.9, preDelay: 0.004, lowCut: 180, highCut: 9000, mod: 0.3 });
    const pan = (o.pan as Record<string, number> | undefined) ?? {};
    for (const part of AKIT_PARTS) {
      const pp = clampPan(pan[part] ?? PART_MIX[part].pan);
      const a = (pp + 1) * 0.25 * Math.PI;
      this.panMul[part] = { l: Math.cos(a) * Math.SQRT2, r: Math.sin(a) * Math.SQRT2 };
    }
    const mk = (modes: number): DrumVoice => ({
      on: false,
      t: 0,
      ph: new Float64Array(modes),
      amps: new Float64Array(modes),
      ks: new Float64Array(modes),
      f: 100,
      g: 1,
      vel: 1,
      noiseAmp: 0,
      noiseAmp2: 0,
      wireLp: 0,
      clk: 0,
      flags: 0,
      rattle: 0,
      fade: 1,
      eq: new Biquad(),
      hp: new Biquad(),
      pk: new Biquad(),
      bp: new Biquad(),
      lp: new Biquad(),
    });
    for (let i = 0; i < 3; i++) this.kickV.push(mk(3));
    for (let i = 0; i < 3; i++) this.snareV.push(mk(SNARE_MODES.length));
    for (const part of ['tomHi', 'tomMid', 'tomLo'] as PartName[]) for (let i = 0; i < 2; i++) this.tomV.push({ part, v: mk(TOM_MODES.length) });
    for (let i = 0; i < 6; i++) this.cym.push({ on: false, pos: 0, g: 1, lpL: 0, lpR: 0, lpK: 1, choke: 1, fade: 1, recipe: 'crash', decayMul: 1 });
    // the cymbal buffers are built by prepare() (the Song passes the parts the track uses) or on the first hit
  }

  /** Builds the cymbal buffers for the given parts (null = all). Called by the Song with the parts a track actually uses. */
  prepare(used: Set<string> | null): void {
    for (const part of AKIT_PARTS) {
      const recipe = this.recipeOf[part];
      if (!recipe) continue;
      if (this.buffers.has(part)) continue;
      if (used && !used.has(part) && !(part === 'hatC' && used.has('hat')) && !(part === 'hatO' && used.has('hat'))) continue;
      this.buffers.set(part, cymbalBuffer(recipe, this.sr));
      this.prepared.add(part);
    }
  }

  noteOn(note: number, vel: number, dur: number, flags: number): void {
    // General-MIDI style fallback so note patterns also work: 36 kick, 38 snare, 42 closed hat, 46 open hat, 49 crash, 51 ride
    const map: Record<number, PartName> = { 36: 'kick', 35: 'kick', 38: 'snare', 40: 'snare', 37: 'rim', 42: 'hatC', 44: 'hatP', 46: 'hatO', 41: 'tomLo', 45: 'tomMid', 48: 'tomHi', 49: 'crash', 57: 'crash2', 51: 'ride', 53: 'bell', 55: 'splash', 52: 'china' };
    this.hit(map[Math.round(note)] ?? 'kick', vel, dur, flags);
  }
  noteOff(): void {}

  hit(part: string, vel: number, _dur: number, flags: number): void {
    this.roomTail = Math.round((this.params.roomTime * 2.2 + 0.3) * this.sr);
    const p = (part === '' ? 'kick' : part) as PartName;
    const g = Math.pow(Math.max(vel, 0.03), 1.25) * (flags & FLAG.ACCENT ? 1.1 : 1) * (flags & FLAG.GHOST ? 0.8 : 1);
    switch (p) {
      case 'kick':
        this.trigKick(vel, g, flags);
        break;
      case 'snare':
        this.trigSnare(vel, g, flags, false);
        break;
      case 'rim':
        this.trigSnare(vel, g, flags, true);
        break;
      case 'tomHi':
      case 'tomMid':
      case 'tomLo':
        this.trigTom(p, vel, g, flags);
        break;
      default:
        this.trigCymbal(p, vel, g, flags);
    }
  }

  private pickVoice(list: DrumVoice[]): DrumVoice {
    for (const o of list) if (o.on) o.flags |= 0x10000; // marks "being choked"
    let v = list.find((x) => !x.on);
    if (!v) {
      v = list[0];
      for (const o of list) if (o.t > v.t) v = o;
    }
    return v;
  }

  private trigKick(vel: number, g: number, flags: number): void {
    const p = this.params;
    const v = this.pickVoice(this.kickV);
    const tight = 1 - 0.55 * p.tight;
    v.on = true;
    v.t = 0;
    v.fade = 1;
    v.g = g;
    v.vel = vel;
    v.f = p.kickTune;
    v.ph.fill(0);
    const T = p.kickDecay * tight;
    v.amps[0] = 1;
    v.amps[1] = 0.45;
    v.amps[2] = 0.3;
    v.ks[0] = Math.exp(-6.9 / (T * this.sr));
    v.ks[1] = Math.exp(-6.9 / (T * 0.55 * this.sr));
    v.ks[2] = Math.exp(-6.9 / (T * 0.25 * this.sr));
    v.clk = p.kickClick * (0.5 + 0.5 * vel) * (flags & FLAG.MUTE ? 0.5 : 1);
    v.noiseAmp = 1;
    v.flags = flags & 0xffff;
    // static tone: scoop the boxiness, add beater presence
    v.eq.peaking(380, 1.1, -5, this.sr);
    v.pk.peaking(3400, 0.9, 3, this.sr);
    v.bp.bandpass(3800, 0.8, this.sr);
    v.eq.reset();
    v.pk.reset();
    v.bp.reset();
  }

  private trigSnare(vel: number, g: number, flags: number, rim: boolean): void {
    const p = this.params;
    const v = this.pickVoice(this.snareV);
    const tight = 1 - 0.55 * p.tight;
    v.on = true;
    v.t = 0;
    v.fade = 1;
    v.g = g;
    v.vel = vel;
    v.flags = (flags & 0xffff) | (rim ? FLAG.RIM : 0);
    v.f = rim ? 1500 : p.snareTune * (0.97 + 0.06 * vel);
    v.ph.fill(0);
    const T = (rim ? 0.03 : p.snareDecay) * tight;
    const hard = 0.35 + 0.65 * vel;
    for (let k = 0; k < SNARE_MODES.length; k++) {
      const m = SNARE_MODES[k];
      v.amps[k] = m.amp * Math.pow(hard, 0.7 + 0.5 * k);
      v.ks[k] = Math.exp(-6.9 / (Math.max(T * m.decay, 0.004) * this.sr));
    }
    v.noiseAmp = (rim ? 0.08 : 1) * p.snareWires * (flags & FLAG.GHOST ? 0.6 : 1) * (0.5 + 0.5 * hard);
    v.noiseAmp2 = 1;
    v.clk = p.snareSnap * (0.4 + 0.6 * vel);
    v.wireLp = 0;
    v.rattle = 0;
    v.hp.highpass(1700, 0.8, this.sr);
    v.pk.peaking(4200, 0.9, 3, this.sr);
    v.lp.lowpass(9000, 0.6, this.sr);
    v.bp.bandpass(rim ? 2400 : 1800, 1.1, this.sr);
    v.hp.reset();
    v.pk.reset();
    v.lp.reset();
    v.bp.reset();
    v.eq.peaking(3300, 1.2, 2, this.sr);
    v.eq.reset();
    // wire decay constants are stored in ks beyond the modes? keep them in locals of process via params
  }

  private trigTom(part: PartName, vel: number, g: number, flags: number): void {
    const p = this.params;
    // pick a voice of this tom (two per tom)
    const mine = this.tomV.filter((x) => x.part === part);
    for (const x of mine) if (x.v.on) x.v.flags |= 0x10000;
    let slot = mine.find((x) => !x.v.on) ?? mine[0];
    for (const x of mine) if (x.v.on && x.v.t > slot.v.t) slot = x;
    const v = slot.v;
    const base = part === 'tomHi' ? 188 : part === 'tomMid' ? 148 : 104;
    const tight = 1 - 0.5 * p.tight;
    v.on = true;
    v.t = 0;
    v.fade = 1;
    v.g = g;
    v.vel = vel;
    v.f = base * p.tomTune;
    v.ph.fill(0);
    const T = (part === 'tomHi' ? 0.32 : part === 'tomMid' ? 0.4 : 0.52) * p.tomDecay * tight;
    for (let k = 0; k < TOM_MODES.length; k++) {
      const m = TOM_MODES[k];
      v.amps[k] = m.amp * Math.pow(0.4 + 0.6 * vel, 0.8 + 0.5 * k);
      v.ks[k] = Math.exp(-6.9 / (Math.max(T * m.decay, 0.01) * this.sr));
    }
    v.clk = 0.5 * (0.4 + 0.6 * vel);
    v.flags = flags & 0xffff;
    v.eq.peaking(2400, 1, 2, this.sr);
    v.eq.reset();
    v.bp.bandpass(2700, 0.9, this.sr);
    v.bp.reset();
  }

  private trigCymbal(part: PartName, vel: number, g: number, flags: number): void {
    const p = this.params;
    let buf = this.buffers.get(part);
    if (!buf) {
      const recipe = this.recipeOf[part];
      if (!recipe) throw new Error(`acoustic kit: unknown part "${part}". Parts: ${AKIT_PARTS.join(', ')}`);
      buf = cymbalBuffer(recipe, this.sr);
      this.buffers.set(part, buf);
    }
    const isHat = part === 'hat' || part === 'hatC' || part === 'hatO' || part === 'hatP';
    let which: PartName = part;
    if (part === 'hat') which = flags & FLAG.OPEN ? 'hatO' : 'hatC';
    if (which === 'hatO' && !this.buffers.has('hatO')) this.buffers.set('hatO', cymbalBuffer('hatOpen', this.sr));
    if (which === 'hatC' && !this.buffers.has('hatC')) this.buffers.set('hatC', cymbalBuffer('hatClosed', this.sr));
    // choke: a closed / pedal hat cuts the open one; the same cymbal is re-struck
    for (const c of this.cym) {
      if (!c.on) continue;
      const cHat = c.recipe === 'hat' || c.recipe === 'hatC' || c.recipe === 'hatO' || c.recipe === 'hatP';
      if (c.recipe === which || (isHat && cHat && which !== 'hatO')) c.choke = Math.min(c.choke, 0.999);
    }
    let v = this.cym.find((x) => !x.on);
    if (!v) v = this.cym[0];
    v.on = true;
    v.recipe = which;
    v.pos = 0;
    v.g = g * dbToLin(isHat ? p.hatGain : p.cymbalGain);
    v.lpL = 0;
    v.lpR = 0;
    v.choke = 1;
    v.fade = 1;
    const tone = isHat ? p.hatTone : 0;
    const fc = 3000 * Math.pow(2, 2.8 * Math.pow(vel, 0.8) + tone * 1.4);
    v.lpK = 1 - Math.exp((-TAU * Math.min(fc, this.sr * 0.45)) / this.sr);
    const dm = which === 'hatO' ? p.hatDecay : isHat ? 1 : p.cymbalDecay;
    v.decayMul = Math.pow(0.0005, (1 - dm) / (0.6 * this.sr));
    if (flags & FLAG.MUTE) v.decayMul = Math.pow(0.0005, 1 / (0.12 * this.sr));
  }

  // ── rendering ────────────────────────────────────────────────────────────

  process(l: Float64Array, r: Float64Array, n: number): void {
    const p = this.params;
    const out = dbToLin(p.level + (0));
    if (this.roomTail > 0) this.roomTail -= n;
    const sendL = this.sendL;
    const sendR = this.sendR;
    sendL.fill(0, 0, n);
    sendR.fill(0, 0, n);
    const addMono = (x: number, i: number, part: PartName): void => {
      const m = this.panMul[part];
      const y = x * out;
      l[i] += y * m.l;
      r[i] += y * m.r;
      const s = PART_MIX[part].send * y;
      sendL[i] += s * m.l;
      sendR[i] += s * m.r;
    };
    // kick
    for (const v of this.kickV) if (v.on) this.renderKick(v, n, (x, i) => addMono(x * dbToLin(p.kickGain), i, 'kick'));
    for (const v of this.snareV) if (v.on) this.renderSnare(v, n, (x, i) => addMono(x * dbToLin(p.snareGain), i, v.flags & FLAG.RIM ? 'rim' : 'snare'));
    for (const t of this.tomV) if (t.v.on) this.renderTom(t.v, t.part, n, (x, i) => addMono(x * dbToLin(p.tomGain), i, t.part));
    for (const c of this.cym) if (c.on) this.renderCym(c, n, l, r, out, sendL, sendR);
    // room
    if (p.room > 0) {
      if (p.roomTime !== this.lastRoomTime) {
        this.room.setParam('time', p.roomTime);
        this.lastRoomTime = p.roomTime;
      }
      this.roomL.fill(0, 0, n);
      this.roomR.fill(0, 0, n);
      this.room.process(sendL, sendR, this.roomL, this.roomR, n);
      const g = p.room * 1.6;
      for (let i = 0; i < n; i++) {
        l[i] += this.roomL[i] * g;
        r[i] += this.roomR[i] * g;
      }
    }
  }

  private renderKick(v: DrumVoice, n: number, add: (x: number, i: number) => void): void {
    const sr = this.sr;
    const f0 = v.f;
    const click = v.clk;
    const nz = this.noise;
    const chokeK = (v.flags & 0x10000) !== 0;
    let { t } = v;
    for (let i = 0; i < n; i++) {
      const ts = t / sr;
      const bend = 1 + 0.55 * Math.exp(-ts / 0.012) + 0.12 * Math.exp(-ts / 0.05);
      let y = 0;
      for (let k = 0; k < 3; k++) {
        const ratio = k === 0 ? 1 : k === 1 ? 1.9 : 3.6;
        v.ph[k] += (f0 * ratio * (k === 0 ? bend : 1 + (bend - 1) * 0.3)) / sr;
        if (v.ph[k] >= 1) v.ph[k] -= 1;
        y += sinCyc(v.ph[k]) * v.amps[k];
        v.amps[k] *= v.ks[k];
      }
      // beater click: a hard beater slaps the head, a short burst centred near 4 kHz (what cuts through the guitars), a pitched tick and
      // a thump of air; only a little of the burst is left broadband
      let c = 0;
      if (t < 0.014 * sr) {
        const w = nz.next();
        const e = Math.exp(-t / (0.0019 * sr));
        c = (v.bp.process(w) * 2.6 + w * 0.22) * e * click;
        c += sinCyc((ts * 2900) % 1) * Math.exp(-t / (0.0011 * sr)) * click * 0.45;
        c += sinCyc((ts * 1800) % 1) * Math.exp(-t / (0.0025 * sr)) * click * 0.35;
      }
      let x = (y * 0.9 + c) * v.g;
      x = tanh3(x * 1.8) * 0.75;
      x = v.pk.process(v.eq.process(x));
      if (chokeK) {
        v.fade -= 1 / (0.008 * sr);
        if (v.fade <= 0) {
          v.on = false;
          break;
        }
        x *= v.fade;
      }
      add(x, i);
      t++;
    }
    v.t = t;
    if (v.amps[0] < 3e-4 && v.amps[1] < 3e-4) v.on = false;
  }

  private renderSnare(v: DrumVoice, n: number, add: (x: number, i: number) => void): void {
    const sr = this.sr;
    const p = this.params;
    const rim = (v.flags & FLAG.RIM) !== 0;
    const nz = this.noise;
    const nz2 = this.noise2;
    const wireT = Math.max(p.snareDecay * (1 - 0.55 * p.tight), 0.03);
    const w1 = Math.exp(-6.9 / (wireT * 1.1 * sr));
    const w2 = Math.exp(-6.9 / (wireT * 3.2 * sr));
    const rK = 1 - Math.exp((-TAU * 70) / sr);
    let { t } = v;
    for (let i = 0; i < n; i++) {
      const ts = t / sr;
      let y = 0;
      if (rim) {
        // cross-stick: a woody knock of two short modes plus a click
        v.ph[0] += 1480 / sr;
        v.ph[1] += 880 / sr;
        y = (sinCyc(v.ph[0] % 1) * 0.6 + sinCyc(v.ph[1] % 1) * 0.5) * v.amps[0] * Math.exp(-ts / 0.006);
        y += nz.next() * Math.exp(-t / (0.0015 * sr)) * 0.6;
        v.amps[0] *= 1;
      } else {
        const drop = 1 + 0.07 * Math.exp(-ts / 0.02);
        for (let k = 0; k < SNARE_MODES.length; k++) {
          v.ph[k] += (v.f * SNARE_MODES[k].ratio * drop) / sr;
          if (v.ph[k] >= 1) v.ph[k] -= 1;
          y += sinCyc(v.ph[k]) * v.amps[k];
          v.amps[k] *= v.ks[k];
        }
      }
      // wires: noise, high-passed, with a rattle modulation; level follows the head plus a slower tail
      let wire = 0;
      if (!rim || v.noiseAmp > 0.01) {
        const w = nz2.next();
        v.rattle += rK * (nz.next() - v.rattle);
        const rat = 1 + 3.2 * v.rattle;
        const env = v.noiseAmp * (0.8 * Math.pow(w1, t) + 0.28 * Math.pow(w2, t));
        wire = v.hp.process(w) * env * rat * 0.9;
        wire = v.lp.process(v.pk.process(wire));
      }
      // stick: a bright tick, then the crack of the stick on the head (band-passed, a few milliseconds)
      let tick = 0;
      if (t < 0.02 * sr) {
        const w = nz.next();
        tick = (t < 0.006 * sr ? w * Math.exp(-t / (0.0008 * sr)) * 0.75 : 0) + v.bp.process(w) * Math.exp(-t / (0.0032 * sr)) * 2.2;
        tick *= v.clk;
      }
      let x = (y * 0.7 + wire * 0.75 + tick) * v.g;
      x = tanh3(x * 1.5) * 0.8;
      x = v.eq.process(x);
      if ((v.flags & 0x10000) !== 0) {
        v.fade -= 1 / (0.008 * sr);
        if (v.fade <= 0) {
          v.on = false;
          break;
        }
        x *= v.fade;
      }
      add(x, i);
      t++;
    }
    v.t = t;
    const tailGone = t > (rim ? 0.15 : wireT * 4.5) * sr;
    if (tailGone) v.on = false;
  }

  private renderTom(v: DrumVoice, part: PartName, n: number, add: (x: number, i: number) => void): void {
    const sr = this.sr;
    const nz = this.noise;
    let { t } = v;
    for (let i = 0; i < n; i++) {
      const ts = t / sr;
      const bend = 1 + 0.16 * Math.exp(-ts / 0.035);
      let y = 0;
      for (let k = 0; k < TOM_MODES.length; k++) {
        v.ph[k] += (v.f * TOM_MODES[k].ratio * bend) / sr;
        if (v.ph[k] >= 1) v.ph[k] -= 1;
        y += sinCyc(v.ph[k]) * v.amps[k];
        v.amps[k] *= v.ks[k];
      }
      let c = 0;
      if (t < 0.016 * sr) {
        const w = nz.next();
        c = (w * Math.exp(-t / (0.0012 * sr)) + v.bp.process(w) * Math.exp(-t / (0.0026 * sr)) * 2.4) * v.clk;
      }
      let x = (y * 0.85 + c) * v.g;
      x = tanh3(x * 1.3) * 0.85;
      x = v.eq.process(x);
      if ((v.flags & 0x10000) !== 0) {
        v.fade -= 1 / (0.01 * sr);
        if (v.fade <= 0) {
          v.on = false;
          break;
        }
        x *= v.fade;
      }
      add(x, i);
      t++;
    }
    v.t = t;
    if (v.amps[0] < 3e-4) v.on = false;
    void part;
  }

  private renderCym(c: CymVoice, n: number, l: Float64Array, r: Float64Array, out: number, sendL: Float64Array, sendR: Float64Array): void {
    const buf = this.buffers.get(c.recipe);
    if (!buf) {
      c.on = false;
      return;
    }
    const len = buf.l.length;
    const m = this.panMul[c.recipe === 'hatC' || c.recipe === 'hatO' || c.recipe === 'hatP' ? 'hat' : c.recipe];
    const send = PART_MIX[c.recipe].send;
    let { pos, lpL, lpR, choke, fade } = c;
    for (let i = 0; i < n; i++) {
      if (pos >= len - 1) {
        c.on = false;
        break;
      }
      const a = buf.l[pos];
      const b = buf.r[pos];
      lpL += c.lpK * (a - lpL);
      lpR += c.lpK * (b - lpR);
      let g = c.g * fade * out;
      if (choke < 1) {
        choke -= 1 / (0.01 * this.sr);
        if (choke <= 0) {
          c.on = false;
          break;
        }
        g *= choke;
      }
      // the stereo buffer is narrowed towards the part's pan position
      const mono = (lpL + lpR) * 0.5;
      const sl = mono + (lpL - mono) * 0.7;
      const sr2 = mono + (lpR - mono) * 0.7;
      const yl = sl * g * m.l * 0.9;
      const yr = sr2 * g * m.r * 0.9;
      l[i] += yl;
      r[i] += yr;
      sendL[i] += yl * send;
      sendR[i] += yr * send;
      pos++;
      fade *= c.decayMul;
    }
    c.pos = pos;
    c.lpL = lpL;
    c.lpR = lpR;
    c.choke = choke;
    c.fade = fade;
    if (fade < 1e-3) c.on = false;
  }

  active(): boolean {
    return this.roomTail > 0 || this.kickV.some((v) => v.on) || this.snareV.some((v) => v.on) || this.tomV.some((t) => t.v.on) || this.cym.some((c) => c.on);
  }
}

function clampPan(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}

export const AKIT_PRESETS: Record<string, PresetDef> = {
  'rock-kit': { doc: 'A natural, medium-sized rock kit with a lively room.', opts: { level: 0.2 } },
  'punk-kit': {
    doc: 'Tight, loud, clicky punk kit: high-tuned snare with plenty of rattle, short kick with a strong beater, bright hats, a small room.',
    opts: { level: 0.6, kickTune: 68, kickDecay: 0.16, kickClick: 0.95, snareTune: 225, snareDecay: 0.13, snareWires: 1, snareSnap: 0.8, tomTune: 1.1, room: 0.3, roomTime: 0.35, hatTone: 0.2, tight: 0.15 },
  },
  'dry-kit': { doc: 'Close-miked, dry and tight (no room): easy to fit in a dense mix.', opts: { level: 1.9, room: 0.05, tight: 0.5, kickDecay: 0.14, snareDecay: 0.11, kickClick: 0.7 } },
  'big-room-kit': { doc: 'Large, open kit with a long room: epic punk / rock choruses.', opts: { level: -0.4, kickTune: 58, kickDecay: 0.26, snareTune: 195, snareDecay: 0.2, room: 0.8, roomTime: 1.1, tomDecay: 1.3 } },
  'garage-kit': { doc: 'Loose, lo-fi garage kit: low-tuned, rattly, boxy room.', opts: { level: -0.3, kickTune: 56, kickDecay: 0.18, snareTune: 180, snareDecay: 0.2, snareWires: 1.2, room: 0.55, roomTime: 0.3, hatTone: -0.3, tomTune: 0.85 } },
};

