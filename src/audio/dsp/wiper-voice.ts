/**
 * WiperVoice — the cockpit wiper, synthesised. Sweep commands (wiper-model.ts) carry an ABSOLUTE audio-clock frame, so every
 * stroke boundary lands on the sample the picture's blade reaches it; between commands the voice is asleep and free.
 *
 * One sweep is an out stroke and a back stroke of the same length, with the picture's cosine-eased motion: the blade's speed is
 * sin(pi * u) through each stroke (zero at both ends, peak at mid-stroke). Everything follows that speed, per sample:
 *
 *   swish      wet rubber across the glass: noise (a different one on each side) through a state-variable filter whose centre
 *              follows the blade's speed (about 520 Hz at the ends of a stroke, 2 kHz mid-stroke), a low wash of water under it,
 *              a band of dry-rubber sizzle above, a stick-slip grain, and the top taken off by the glass; the image travels with
 *              the blade: right at the park end of the sweep, left at the far end
 *   squelch    the odd small wet tick riding the swish (more of them on wetter glass)
 *   motor      a geared whine (about 440 Hz with two overtones, muffled by the cabin) that rises and falls a few percent through
 *              each stroke, over a low buzz of the armature; it spins up with the sweep, and in a storm (a pause of 0.12 s) keeps
 *              turning through the pause, in the rain it winds down at the park position
 *   thunks     a soft knock when the blade turns at the far end (a low body, a flop of the rubber lip, a tiny click) and a
 *              softer, lower one when it settles at the park position; pre-rendered, scattered in at the exact sample
 *   squeak     now and then, when the glass is not wet enough: a faint squeak or a short chatter late in a stroke
 *
 * Per-sweep details (pitch, level, which thunk, whether it squeaks) come with the command, and each stroke of a sweep gets a
 * little pitch and level of its own, so a storm's non-stop wiping never repeats itself. A sweep that arrives late is joined
 * part-way through (a short fade-in), one that is moved (same id) before it starts is moved, abort() fades everything out in
 * about 30 ms. No allocation after construction (apart from receiving a command); safe to call from an AudioWorklet.
 */
import { type SweepCommand, WIPER_THUNK_VARIANTS } from '../wiper-model';
import { SVF } from './filters';
import { Rng, TAU, clamp, cosCyc, lerp, sinCyc, smoothCoef, wrap1 } from './util';

// ── prototype thunks ─────────────────────────────────────────────────────────

export interface WiperBank {
  /** The knock at the far end of the sweep, and the settling at the park position: peak-normalised to 1. */
  rev: Float32Array[];
  park: Float32Array[];
}

function damped(x: Float32Array, sr: number, f0: number, tau: number, amp: number, at = 0): void {
  const k = Math.exp(-1 / (tau * sr));
  const att = Math.max(2, 0.0007 * sr);
  const w = (TAU * f0) / sr;
  const start = Math.round(at * sr);
  let env = amp;
  for (let n = 0; n + start < x.length && env > amp * 0.002; n++) {
    x[start + n] += env * Math.sin(w * n) * Math.min(1, (n + 1) / att);
    env *= k;
  }
}

function noiseBurst(x: Float32Array, sr: number, rng: Rng, kind: 'bp' | 'lp', fc: number, q: number, tau: number, attack: number, amp: number, at = 0): void {
  const a = new SVF();
  const b = new SVF();
  a.set(fc, q, sr);
  b.set(fc, 0.7, sr);
  const k = Math.exp(-1 / (tau * sr));
  const att = Math.max(2, attack * sr);
  const start = Math.round(at * sr);
  let env = amp;
  for (let n = 0; n + start < x.length && env > amp * 0.002; n++) {
    a.step(rng.s2());
    let y = a.bpn;
    if (kind === 'lp') {
      b.step(a.lp);
      y = b.lp * 1.8;
    }
    x[start + n] += y * env * Math.min(1, (n + 1) / att);
    env *= k;
  }
}

function finishProto(x: Float32Array, sr: number): Float32Array {
  // fade the last quarter so a cut-off tail never clicks, drop the low skirt (two one-pole high-passes at 55 Hz), peak = 1
  const n = x.length;
  const m = n >> 2;
  for (let i = 0; i < m; i++) x[n - m + i] *= 0.5 + 0.5 * Math.cos((Math.PI * i) / m);
  const a = 1 / (1 + (TAU * 55) / sr);
  for (let pass = 0; pass < 2; pass++) {
    let px = 0;
    let py = 0;
    for (let i = 0; i < n; i++) {
      const y = a * (py + x[i] - px);
      px = x[i];
      py = y;
      x[i] = y;
    }
  }
  let pk = 1e-9;
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(x[i]));
  for (let i = 0; i < n; i++) x[i] /= pk;
  return x;
}

export function buildWiperBank(sr: number): WiperBank {
  const rng = new Rng(0x51ed270b);
  const len = Math.round(0.2 * sr);
  const rev: Float32Array[] = [];
  const park: Float32Array[] = [];
  for (let i = 0; i < WIPER_THUNK_VARIANTS; i++) {
    const f = WIPER_THUNK_VARIANTS > 1 ? i / (WIPER_THUNK_VARIANTS - 1) : 0;
    // far end: the arm turns and the rubber lip flips over. A knock at 150-230 Hz, a flop of the rubber, a click, and the
    // backlash of the linkage a moment later
    {
      const x = new Float32Array(len);
      const f1 = lerp(150, 230, f) * (0.97 + 0.06 * rng.u());
      damped(x, sr, f1, 0.016, 1);
      damped(x, sr, f1 * (2.25 + 0.3 * rng.u()), 0.01, 0.5);
      damped(x, sr, f1 * (3.8 + 0.6 * rng.u()), 0.006, 0.22);
      noiseBurst(x, sr, rng, 'lp', 520 * (0.9 + 0.2 * rng.u()), 0.7, 0.01, 0.0012, 0.45);
      noiseBurst(x, sr, rng, 'bp', 2400 * (0.9 + 0.2 * rng.u()), 1, 0.0028, 0.0002, 1.4);
      const lash = 0.018 + 0.008 * rng.u();
      damped(x, sr, f1 * 1.07, 0.012, 0.22, lash);
      noiseBurst(x, sr, rng, 'bp', 1900, 1, 0.0025, 0.0002, 0.5, lash);
      rev.push(finishProto(x, sr));
    }
    // park: lower and softer; the arm settles on its stop with a second, fainter knock
    {
      const x = new Float32Array(len);
      const f1 = lerp(100, 160, f) * (0.97 + 0.06 * rng.u());
      damped(x, sr, f1, 0.021, 1);
      damped(x, sr, f1 * (2.2 + 0.3 * rng.u()), 0.012, 0.42);
      damped(x, sr, f1 * (3.6 + 0.6 * rng.u()), 0.007, 0.15);
      noiseBurst(x, sr, rng, 'lp', 380 * (0.9 + 0.2 * rng.u()), 0.7, 0.014, 0.0014, 0.5);
      noiseBurst(x, sr, rng, 'bp', 1800 * (0.9 + 0.2 * rng.u()), 1, 0.003, 0.0003, 0.9);
      const settle = 0.028 + 0.012 * rng.u();
      damped(x, sr, f1 * 1.05, 0.016, 0.4, settle);
      noiseBurst(x, sr, rng, 'bp', 1500, 1, 0.0026, 0.0003, 0.3, settle);
      park.push(finishProto(x, sr));
    }
  }
  return { rev, park };
}

const bankCache = new Map<number, WiperBank>();
/** One bank per sample rate, shared by every voice in the worklet scope. */
export function getWiperBank(sr: number): WiperBank {
  let b = bankCache.get(sr);
  if (!b) {
    b = buildWiperBank(sr);
    bankCache.set(sr, b);
  }
  return b;
}

// ── calibration ──────────────────────────────────────────────────────────────

/**
 * Linear levels of each layer at its loudest (before the per-sweep details, which move them by up to +-1.8 dB). Set against the
 * cabin rain, the roof drumming in particular (all layers together: the loudest 100 ms of the wiper is about 3 dB under the median
 * 100 ms of the drumming in the "rain" preset, 1 dB under in a storm; about 6-9 dB under the whole cabin rain), and measured, not
 * guessed: see tests/audio-wiper.test.ts and sandbox/audio/lab/wiper-lab.ts (--detail --bands).
 */
export const WIPER_CAL = {
  /** Swish at mid-stroke (per channel). */
  swish: 0.038,
  /** Squelch ticks on the swish. */
  tick: 0.022,
  /** Gear whine and armature buzz at full speed. */
  whine: 0.005,
  buzz: 0.0018,
  /** Peak of the knock at the far end and of the settling at the park position. */
  rev: 0.043,
  park: 0.029,
  /** Squeak and chatter peaks. */
  squeak: 0.0058,
  chatter: 0.1,
};

/** Where the sound sits across the cabin (-1 = left .. 1 = right): the park end of the sweep is on the right, the far end on the left. */
const PAN_PARK = 0.42;
const PAN_FAR = -0.38;

/** Trims for isolating layers while measuring (all 1 in normal use). */
export interface WiperTrim {
  swish: number;
  tick: number;
  whine: number;
  buzz: number;
  thunk: number;
  squeak: number;
}

// ── the voice ────────────────────────────────────────────────────────────────

const LATE_TOL_S = 0.012;
const MOTOR_UP_S = 0.025;
const MOTOR_DOWN_S = 0.09;
const JOIN_FADE_S = 0.012;
const F_GEAR = 438;
const F_BUZZ = 56;

class Sweep {
  id = 0;
  f0 = 0;
  strokeN = 1;
  span = 2;
  end = 2;
  invStroke = 1;
  holdN = 0;
  dwell = 2.4;
  wet = 0.6;
  level = 1;
  pitch = 1;
  bright = 1;
  outGain = 1;
  backGain = 1;
  /** A little pitch of its own for each stroke of the sweep (from the seed). */
  pOut = 1;
  pBack = 1;
  revF = 0;
  parkF = 0;
  revIdx = 0;
  parkIdx = 0;
  revGain = 1;
  parkGain = 1;
  revDone = false;
  parkDone = false;
  sqOn = false;
  sqStarted = false;
  sqF0 = 0;
  sqN = 1;
  sqKind = 0;
  sqFreq = 2600;
  sqLevel = 1;
  seed = 1;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export class WiperVoice {
  readonly trim: WiperTrim = { swish: 1, tick: 1, whine: 1, buzz: 1, thunk: 1, squeak: 1 };
  /** `gain` 0 = silent (pause, hidden tab); the voice goes quiet at once and stops computing. */
  readonly inp = { gain: 1 };
  private readonly sr: number;
  private readonly bank: WiperBank;
  private readonly rng: Rng;

  private queue: Sweep[] = [];
  private cur: Sweep | null = null;
  /** The highest sweep id that is over (played, superseded or dropped): a message that moves such a sweep arrives too late. */
  private doneId = 0;
  private holdUntil = 0;
  private frameEnd = 0;
  private aborted = false;

  // motor
  private mot = 0;
  private phG = 0;
  private phM = 0;
  private wowPh = 0;
  private wowRate = 2.8;
  private pitchNow = 1;
  private buzzA = 0;
  private buzzB = 0;
  private readonly cabin = new SVF();

  // swish
  private readonly sL = new SVF();
  private readonly sR = new SVF();
  private readonly hL = new SVF();
  private readonly hR = new SVF();
  private lsL = 0;
  private lsR = 0;
  private ls2L = 0;
  private ls2R = 0;
  private texL = 0;
  private texR = 0;
  private tickEnv = 0;
  private readonly tickBp = new SVF();
  private chatEnv = 0;
  private readonly chatBp = new SVF();

  // squeak / chatter
  private sqArmed = false;
  private sqStart = 0;
  private sqOn = false;
  private sqT = 0;
  private sqN = 1;
  private sqPh = 0;
  private sqVib = 0;
  private sqSlip = 0;
  private sqSlipRate = 50;
  private sqKind = 0;
  private sqFreq = 2600;
  private sqLevel = 1;
  private lpSq = 0;

  // ring of scattered thunks
  private readonly mask: number;
  private readonly accL: Float32Array;
  private readonly accR: Float32Array;
  private pos = 0;
  private ringBusyUntil = 0;

  // output
  private gOut = 1;
  private joinEnv = 1;

  constructor(sr: number, seed = 1) {
    this.sr = sr;
    this.bank = getWiperBank(sr);
    this.rng = new Rng(seed * 7919 + 101);
    let longest = 0;
    for (const p of this.bank.rev) longest = Math.max(longest, p.length);
    for (const p of this.bank.park) longest = Math.max(longest, p.length);
    const ring = nextPow2(longest + 1024);
    this.mask = ring - 1;
    this.accL = new Float32Array(ring);
    this.accR = new Float32Array(ring);
    this.cabin.set(1100, 0.6, sr);
    this.tickBp.set(2700, 1.5, sr);
    this.chatBp.set(2000, 6, sr);
  }

  /** Is the voice producing (or about to produce) sound? */
  get awake(): boolean {
    return this.cur !== null || this.mot > 1e-3 || this.sqOn || this.frameEnd < this.ringBusyUntil || this.tickEnv > 1e-5 || this.chatEnv > 1e-5;
  }

  /** Sweeps waiting for their turn (diagnostics / tests). */
  get pending(): number {
    return this.queue.length;
  }

  /** Queue a sweep (any time before its start; a start in the past joins it part-way). */
  queueSweep(c: SweepCommand): void {
    if (!(Number.isFinite(c.f0) && c.strokeN >= 1)) return;
    const id = Number.isFinite(c.id) && c.id > 0 ? Math.floor(c.id) : 0;
    if (id > 0) {
      // the same sweep again moves one that has not started; one that is playing or over stays as it is
      if (id <= this.doneId || (this.cur !== null && this.cur.id === id)) return;
      const k = this.queue.findIndex((q) => q.id === id);
      if (k >= 0) this.queue.splice(k, 1);
    }
    const s = new Sweep();
    const sr = this.sr;
    const num = (x: number, d: number): number => (Number.isFinite(x) ? x : d);
    s.id = id;
    s.f0 = Math.round(c.f0);
    s.strokeN = Math.max(1, Math.round(c.strokeN));
    s.span = 2 * s.strokeN;
    s.end = s.f0 + s.span;
    s.invStroke = 1 / s.strokeN;
    s.dwell = Math.max(0, num(c.dwell, 2.4));
    s.holdN = s.dwell <= 0.6 ? Math.round((s.dwell + 0.1) * sr) : 0;
    s.wet = clamp(num(c.wet, 0.6), 0, 1);
    s.level = clamp(num(c.level, 1), 0.1, 4);
    s.pitch = clamp(num(c.pitch, 1), 0.8, 1.25);
    s.bright = clamp(num(c.bright, 1), 0.7, 1.4);
    s.outGain = clamp(num(c.outGain, 1), 0.1, 4);
    s.backGain = clamp(num(c.backGain, 1), 0.1, 4);
    s.revIdx = clamp(Math.floor(num(c.revIdx, 0)), 0, WIPER_THUNK_VARIANTS - 1);
    s.parkIdx = clamp(Math.floor(num(c.parkIdx, 0)), 0, WIPER_THUNK_VARIANTS - 1);
    s.revGain = clamp(num(c.revGain, 1), 0, 4);
    s.parkGain = clamp(num(c.parkGain, 1), 0, 4);
    s.revF = s.f0 + s.strokeN;
    s.parkF = s.end;
    s.sqOn = c.sqOn > 0;
    s.sqKind = c.sqKind > 0.5 ? 1 : 0;
    s.sqFreq = clamp(num(c.sqFreq, 2600), 1200, 5000);
    s.sqLevel = clamp(num(c.sqLevel, 1), 0, 2);
    s.sqN = Math.max(16, Math.round(clamp(num(c.sqDur, 0.12), 0.03, 0.4) * sr));
    s.sqF0 = s.f0 + Math.round((c.sqStroke > 0.5 ? s.strokeN : 0) + clamp(num(c.sqAt, 0.8), 0.05, 0.95) * s.strokeN);
    s.seed = Math.floor(num(c.seed, 1));
    s.pOut = 1 + 0.012 * (((s.seed >> 20) & 255) / 127.5 - 1);
    s.pBack = 1 + 0.012 * (((s.seed >> 12) & 255) / 127.5 - 1);
    // keep the queue sorted by start
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].f0 > s.f0) i--;
    this.queue.splice(i, 0, s);
  }

  /** Drop everything queued and fade out whatever sounds (camera change, pause, rain over): about 30 ms, no click. */
  abort(): void {
    for (const q of this.queue) this.doneId = Math.max(this.doneId, q.id);
    if (this.cur) this.doneId = Math.max(this.doneId, this.cur.id);
    this.queue.length = 0;
    this.holdUntil = 0;
    if (this.awake) this.aborted = true;
    else this.quiesce();
  }

  /** Wipe the audio state (filters, ring, motor): the voice is silent and will start the next sweep from rest. */
  private quiesce(): void {
    this.cur = null;
    this.mot = 0;
    this.sqOn = false;
    this.sqArmed = false;
    this.accL.fill(0);
    this.accR.fill(0);
    this.ringBusyUntil = 0;
    this.sL.reset();
    this.sR.reset();
    this.hL.reset();
    this.hR.reset();
    this.lsL = this.lsR = this.ls2L = this.ls2R = 0;
    this.cabin.reset();
    this.tickBp.reset();
    this.chatBp.reset();
    this.texL = this.texR = 0;
    this.tickEnv = this.chatEnv = 0;
    this.buzzA = this.buzzB = 0;
    this.lpSq = 0;
    this.gOut = 1;
    this.aborted = false;
  }

  /** Immediate reset (tests, a new context): no fade, nothing queued. */
  reset(): void {
    this.queue.length = 0;
    this.holdUntil = 0;
    this.doneId = 0;
    this.quiesce();
  }

  /** Render `n` samples into outL / outR (overwritten), the first of them being audio-context frame `frame0`. */
  process(outL: Float32Array, outR: Float32Array, n: number, frame0: number, offset = 0): void {
    let done = 0;
    while (done < n) {
      const len = Math.min(128, n - done);
      this.block(outL, outR, offset + done, len, frame0 + done);
      done += len;
    }
  }

  private scatter(proto: Float32Array, gain: number, pan: number, at: number, frame: number): void {
    const gl = gain * Math.sqrt(1 - pan);
    const gr = gain * Math.sqrt(1 + pan);
    const aL = this.accL;
    const aR = this.accR;
    const mask = this.mask;
    const p0 = this.pos + at;
    const n = proto.length;
    for (let i = 0; i < n; i++) {
      const h = proto[i];
      aL[(p0 + i) & mask] += gl * h;
      aR[(p0 + i) & mask] += gr * h;
    }
    const until = frame + at + n + 2;
    if (until > this.ringBusyUntil) this.ringBusyUntil = until;
  }

  /** The sweep's point events that fall in [f, f + len): the knock at the far end, the settling at park, the start of a squeak. */
  private events(c: Sweep, f: number, len: number): void {
    if (this.aborted) return;
    const T = this.trim;
    const sr = this.sr;
    const rng = this.rng;
    const lateN = Math.round(LATE_TOL_S * sr);
    const dwellSoft = c.dwell <= 0.6 ? 0.72 : 1;
    if (!c.revDone && c.revF < f + len) {
      c.revDone = true;
      if (c.revF + lateN >= f && T.thunk > 0) this.scatter(this.bank.rev[c.revIdx], WIPER_CAL.rev * c.revGain * c.level * T.thunk, PAN_FAR, Math.max(0, c.revF - f), f);
    }
    if (!c.parkDone && c.parkF < f + len) {
      c.parkDone = true;
      if (c.parkF + lateN >= f && T.thunk > 0) this.scatter(this.bank.park[c.parkIdx], WIPER_CAL.park * c.parkGain * c.level * dwellSoft * T.thunk, PAN_PARK, Math.max(0, c.parkF - f), f);
    }
    if (c.sqOn && !c.sqStarted && c.sqF0 < f + len) {
      c.sqStarted = true;
      if (c.sqF0 + c.sqN > f + 4 && !this.sqOn) {
        this.sqArmed = true;
        this.sqStart = c.sqF0;
        this.sqT = Math.max(0, f - c.sqF0);
        this.sqN = c.sqN;
        this.sqKind = c.sqKind;
        this.sqFreq = c.sqFreq * (0.97 + 0.06 * rng.u());
        this.sqLevel = c.sqLevel * c.level;
        this.sqSlipRate = c.sqKind === 0 ? 34 + 28 * rng.u() : 46 + 32 * rng.u();
        this.sqSlip = 0;
        this.sqVib = rng.u();
        this.sqPh = rng.u();
        this.chatBp.set(this.sqFreq * 0.78, 6, sr);
      }
    }
  }

  private block(outL: Float32Array, outR: Float32Array, o: number, len: number, f: number): void {
    const sr = this.sr;
    const rng = this.rng;
    this.frameEnd = f + len;
    const T = this.trim;

    // ── which sweep? ────────────────────────────────────────────────────────
    let c = this.cur;
    if (c && f >= c.end) {
      this.events(c, f, len); // the settling at the park position falls on the very end of the sweep, maybe on this block's first sample
      this.holdUntil = Math.max(this.holdUntil, c.end + c.holdN);
      this.doneId = Math.max(this.doneId, c.id);
      c = this.cur = null;
    }
    // (an aborted voice takes no new sweep until its fade is over: the next block after that picks it up, part-way through)
    while (!this.aborted && this.queue.length > 0 && this.queue[0].f0 < f + len) {
      const q = this.queue.shift() as Sweep;
      if (q.end - f < 0.02 * sr) {
        this.doneId = Math.max(this.doneId, q.id);
        continue; // over (or all but) by the time it got here
      }
      if (c) this.doneId = Math.max(this.doneId, c.id); // superseded
      c = this.cur = q;
      if (q.f0 < f - 1) {
        // late: join part-way through, fading in; the motor is already at speed
        this.joinEnv = 0;
        if (f - q.f0 > 0.05 * sr) this.mot = 1;
      }
      this.wowPh = ((q.seed & 1023) / 1024) % 1;
      this.wowRate = 2.2 + 1.4 * (((q.seed >> 10) & 1023) / 1024);
    }

    // ── asleep? ─────────────────────────────────────────────────────────────
    if (!c && !this.awake && f >= this.holdUntil) {
      this.pos = (this.pos + len) & 0x3fffffff;
      for (let i = 0; i < len; i++) {
        outL[o + i] = 0;
        outR[o + i] = 0;
      }
      if (this.aborted || this.gOut !== 1) this.quiesce();
      return;
    }

    // ── motor target, output gain ───────────────────────────────────────────
    const motT = !this.aborted && (c !== null || f < this.holdUntil) ? 1 : 0;
    const kMotUp = smoothCoef(MOTOR_UP_S, 1 / sr);
    const kMotDn = smoothCoef(MOTOR_DOWN_S, 1 / sr);
    const gT = this.aborted ? 0 : this.inp.gain;
    const kG = smoothCoef(gT < this.gOut ? (this.aborted ? 0.006 : 0.04) : 0.03, 1 / sr);
    const kJoin = smoothCoef(JOIN_FADE_S, 1 / sr);

    if (c) this.events(c, f, len);

    // ── per-block parameters from the blade's state at the block centre ─────
    let vC = 0;
    let aC = 0;
    let swGain = 0;
    let wWash = 0;
    let wHiss = 0;
    let tickRate = 0;
    if (c) {
      const xc = f + (len >> 1) - c.f0;
      if (xc >= 0 && xc < c.span) {
        const back = xc >= c.strokeN;
        const u = (back ? xc - c.strokeN : xc) * c.invStroke;
        vC = sinCyc(0.5 * u);
        aC = back ? 0.5 + 0.5 * cosCyc(0.5 * u) : 0.5 - 0.5 * cosCyc(0.5 * u);
      }
      // the body of the swish brightens with the blade's speed (about 600 Hz at the ends of a stroke, 2.2 kHz mid-stroke);
      // above it a band of dry-rubber sizzle that only a quick blade on damp glass makes
      const fc = (520 + 1500 * vC) * c.bright;
      const fh = (2300 + 1700 * vC) * c.bright;
      this.sL.set(fc, 0.7, sr);
      this.sR.set(fc * 1.04, 0.7, sr);
      this.hL.set(fh, 0.9, sr);
      this.hR.set(fh * 1.04, 0.9, sr);
      const wet = c.wet;
      // a sheet of water washes (low); damp glass has more of the dry rubber's sizzle
      wWash = 0.85 * (0.35 + 0.65 * wet);
      wHiss = (0.06 + 0.4 * vC * vC) * (1.15 - 0.6 * wet);
      swGain = WIPER_CAL.swish * (0.7 + 0.5 * wet) * c.level * T.swish;
      tickRate = (3 + 28 * wet) * vC;
    }
    const pan = PAN_PARK + (PAN_FAR - PAN_PARK) * aC;
    const gpl = Math.sqrt(1 - pan);
    const gpr = Math.sqrt(1 + pan);
    const level = c ? c.level : 1;
    const tickAmp = WIPER_CAL.tick * level * T.tick;
    const texK = 0.04;
    const texN = 12.1 * 0.3; // unit-std one-pole noise x 30 % depth
    const tickP = tickRate / sr;

    // ── per sample ──────────────────────────────────────────────────────────
    const c0 = c ? c.f0 : 0;
    const span = c ? c.span : 0;
    const strokeN = c ? c.strokeN : 1;
    const invStroke = c ? c.invStroke : 1;
    const outG = c ? c.outGain : 1;
    const backG = c ? c.backGain : 1;
    const pitch = c ? c.pitch : 1;
    const pOut = c ? c.pOut : 1;
    const pBack = c ? c.pBack : 1;
    const tickK = Math.exp(-1 / (0.0016 * sr));
    const chatK = Math.exp(-1 / (0.0035 * sr));
    const sL = this.sL;
    const sR = this.sR;
    const hL = this.hL;
    const hR = this.hR;
    let lsL = this.lsL;
    let lsR = this.lsR;
    let ls2L = this.ls2L;
    let ls2R = this.ls2R;
    // the glass and the cabin take the top off the swish: two poles, 5.5 kHz and 3.8 kHz
    const kSw = 1 - Math.exp((-TAU * 5500) / sr);
    const kSw2 = 1 - Math.exp((-TAU * 3800) / sr);
    const accL = this.accL;
    const accR = this.accR;
    const mask = this.mask;
    const cabin = this.cabin;
    const tickBp = this.tickBp;
    const chatBp = this.chatBp;
    let mot = this.mot;
    let gOut = this.gOut;
    let join = this.joinEnv;
    let texL = this.texL;
    let texR = this.texR;
    let tickEnv = this.tickEnv;
    let chatEnv = this.chatEnv;
    let phG = this.phG;
    let phM = this.phM;
    let pitchNow = this.pitchNow;
    let wow = this.wowPh;
    let buzzA = this.buzzA;
    let buzzB = this.buzzB;
    const wowInc = this.wowRate / sr;
    const buzzLp = 1 - Math.exp((-TAU * 330) / sr);
    let pos = this.pos;

    for (let i = 0; i < len; i++) {
      // the blade
      const xi = f + i - c0;
      let v = 0;
      let strokeG = 1;
      if (c !== null && xi >= 0 && xi < span) {
        const back = xi >= strokeN;
        const u = (back ? xi - strokeN : xi) * invStroke;
        v = sinCyc(0.5 * u);
        strokeG = back ? backG : outG;
        pitchNow = pitch * (back ? pBack : pOut);
      }

      // motor
      mot += (motT > mot ? kMotUp : kMotDn) * (motT - mot);
      join += kJoin * (1 - join);
      const dr = mot * join;

      // swish (two decorrelated channels) and squelch
      let swL = 0;
      let swR = 0;
      if (v > 0) {
        const nL = rng.s2();
        const nR = rng.s2();
        sL.step(nL);
        sR.step(nR);
        hL.step(nL);
        hR.step(nR);
        lsL += kSw * (sL.bpn + wWash * sL.lp + wHiss * hL.bpn - lsL);
        lsR += kSw * (sR.bpn + wWash * sR.lp + wHiss * hR.bpn - lsR);
        ls2L += kSw2 * (lsL - ls2L);
        ls2R += kSw2 * (lsR - ls2R);
        texL += texK * (nR - texL);
        texR += texK * (nL - texR);
        const mL = 1 + texN * texL;
        const mR = 1 + texN * texR;
        const sw = swGain * strokeG * v * Math.sqrt(Math.sqrt(v)) * join;
        swL = ls2L * sw * (mL < 0.15 ? 0.15 : mL) * gpl;
        swR = ls2R * sw * (mR < 0.15 ? 0.15 : mR) * gpr;
        if (tickP > 0 && rng.u() < tickP) {
          const u = rng.u();
          const a = tickAmp * (0.5 + 1.6 * u * u * u);
          if (a > tickEnv) tickEnv = a;
        }
      }
      let tk = 0;
      if (tickEnv > 1e-5) {
        tk = tickBp.step(rng.s2()) * tickEnv * join;
        tickEnv *= tickK;
      }

      // motor: gear whine + armature buzz, muffled by the cabin
      let mo = 0;
      if (dr > 1e-4) {
        wow += wowInc;
        if (wow >= 1) wow -= 1;
        const load = 1 + 0.045 * v + 0.008 * sinCyc(wow);
        const fg = F_GEAR * pitchNow * (0.62 + 0.38 * mot) * load;
        phG += fg / sr;
        if (phG >= 1) phG -= 1;
        const fm = F_BUZZ * pitchNow * (0.4 + 0.6 * mot) * (1 + 0.03 * v);
        phM += fm / sr;
        if (phM >= 1) phM -= 1;
        const h2 = phG * 2;
        const h3 = phG * 3;
        const tone = sinCyc(phG) + 0.38 * sinCyc(h2 - Math.floor(h2)) + 0.14 * sinCyc(h3 - Math.floor(h3));
        const aw = WIPER_CAL.whine * dr * dr * (0.5 + 0.5 * v) * (1 + 0.05 * sinCyc(phM)) * T.whine * level;
        const saw = 1 - 2 * phM;
        buzzA += buzzLp * (saw - buzzA);
        buzzB += buzzLp * (buzzA - buzzB);
        const ab = WIPER_CAL.buzz * dr * dr * (0.45 + 0.55 * v) * T.buzz * level;
        cabin.step(tone * aw + buzzB * 3 * ab);
        mo = cabin.lp;
      } else {
        cabin.step(0); // keep the filter state decaying instead of freezing
      }

      // squeak / chatter
      let sq = 0;
      if (this.sqArmed && f + i >= this.sqStart) {
        this.sqArmed = false;
        this.sqOn = true;
        this.sqT = f + i - this.sqStart;
      }
      if (this.sqOn) {
        const tt = this.sqT / this.sqN;
        const env = sinCyc(0.5 * tt);
        const e2 = env * env;
        if (this.sqKind === 0) {
          const vib = 0.05 * sinCyc(wrap1(this.sqVib + this.sqT * (4.4 / sr)));
          const fq = this.sqFreq * (1 + vib + 0.07 * (tt - 0.5));
          this.sqPh += fq / sr;
          if (this.sqPh >= 1) this.sqPh -= 1;
          this.sqSlip += this.sqSlipRate / sr;
          if (this.sqSlip >= 1) this.sqSlip -= 1;
          const s = 0.5 + 0.5 * sinCyc(this.sqSlip);
          const am = 0.25 + 0.75 * s * s;
          const p2 = this.sqPh * 2;
          const p3 = this.sqPh * 3;
          const x = sinCyc(this.sqPh) + 0.48 * sinCyc(p2 - Math.floor(p2)) + 0.2 * sinCyc(p3 - Math.floor(p3));
          this.lpSq += 0.55 * (x - this.lpSq);
          sq = this.lpSq * e2 * am * WIPER_CAL.squeak * this.sqLevel * T.squeak;
        } else {
          this.sqSlip += this.sqSlipRate / sr;
          if (this.sqSlip >= 1) {
            this.sqSlip -= 1 + 0.35 * (rng.u() - 0.5);
            chatEnv = WIPER_CAL.chatter * (0.55 + 0.45 * rng.u()) * this.sqLevel * T.squeak;
          }
          if (chatEnv > 1e-5) {
            sq = chatBp.step(rng.s2()) * chatEnv * (0.4 + 0.6 * env);
            chatEnv *= chatK;
          }
        }
        this.sqT++;
        if (this.sqT >= this.sqN) this.sqOn = false;
      } else if (chatEnv > 1e-5) {
        sq = chatBp.step(rng.s2()) * chatEnv;
        chatEnv *= chatK;
      }
      sq *= join;

      // the scattered thunks
      const q = pos & mask;
      const rL = accL[q];
      const rR = accR[q];
      accL[q] = 0;
      accR[q] = 0;
      pos++;

      // mix: the sources that sit on the blade are panned with it
      gOut += kG * (gT - gOut);
      const onBlade = tk + sq;
      outL[o + i] = (swL + mo + onBlade * gpl + rL) * gOut;
      outR[o + i] = (swR + mo + onBlade * gpr + rR) * gOut;
    }

    this.lsL = lsL;
    this.lsR = lsR;
    this.ls2L = ls2L;
    this.ls2R = ls2R;
    this.mot = mot;
    this.gOut = gOut;
    this.joinEnv = join;
    this.texL = texL;
    this.texR = texR;
    this.tickEnv = tickEnv;
    this.chatEnv = chatEnv;
    this.phG = phG;
    this.phM = phM;
    this.pitchNow = pitchNow;
    this.wowPh = wow;
    this.buzzA = buzzA;
    this.buzzB = buzzB;
    this.pos = pos & 0x3fffffff;

    // an aborted voice that has faded out is wiped clean, ready for the next sweep
    if (this.aborted && gOut < 1e-3) this.quiesce();
  }
}
