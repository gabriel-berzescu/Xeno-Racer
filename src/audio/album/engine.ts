/**
 * The streaming renderer. A Program (built by the Song from a track's score) is rendered a segment at a time (<= SEG frames,
 * cut at every event so notes start on their exact sample); the output of the master chain is staged and handed out in
 * whatever block sizes the caller asks for, so the audio is identical for every block size.
 */
import type { TrackRenderer } from './index';
import { clamp } from './dsp/core';
import { Instrument, ParamHost, ParamSpec, Transport } from './instrument';
import { Bus, Channel, Duck, DelayReturn, MasterBus, MixIO, ReverbReturn, SEG, Strip } from './mixer';

export type LaneCurve = 'lin' | 'exp' | 'step' | 'smooth' | 'in' | 'out';
export type LfoWave = 'sine' | 'tri' | 'saw' | 'ramp' | 'square' | 'sh' | 'smooth';

/** One score event, time in beats from the start of the song. */
export interface EventDef {
  beat: number;
  kind: 'on' | 'off' | 'hit';
  ch: number;
  note: number;
  vel: number;
  durBeats: number;
  flags: number;
  part: string;
}

/** Automation segment list for one parameter (times in beats). */
export interface LaneDef {
  host: ParamHost;
  name: string;
  t: number[];
  v: number[];
  /** curve[i] shapes the move from point i-1 to point i. */
  curve: LaneCurve[];
}

export interface LfoDef {
  host: ParamHost;
  name: string;
  startBeat: number;
  endBeat: number;
  /** cycles per beat */
  rate: number;
  /** in parameter units ('add') or octaves ('exp') */
  depth: number;
  shape: LfoWave;
  phase: number;
  mode: 'add' | 'exp';
  /** The automation path it was made for (for listings). */
  path?: string;
}

export interface ChannelDef {
  name: string;
  inst: Instrument;
  strip: Strip;
  bus: number;
  key: boolean;
  mute: boolean;
}

export interface Program {
  sr: number;
  /** Output length in frames (what `TrackRenderer.frames` reports). */
  frames: number;
  bpm: number;
  channels: ChannelDef[];
  buses: { name: string; strip: Strip }[];
  events: EventDef[];
  lanes: LaneDef[];
  lfos: LfoDef[];
  reverb: ReverbReturn;
  delay: DelayReturn;
  duck: Duck;
  master: MasterBus;
  transport: Transport;
  fadeIn: number;
  fadeOut: number;
}

interface Ev {
  f: number;
  kind: number; // 0 off, 1 on, 2 hit
  ch: number;
  note: number;
  vel: number;
  dur: number;
  flags: number;
  part: string;
}

function hashNoise(i: number): number {
  let x = (i | 0) * 0x9e3779b1;
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return ((x >>> 0) / 4294967296) * 2 - 1;
}

function lfoValue(shape: LfoWave, cycles: number): number {
  const ph = cycles - Math.floor(cycles);
  switch (shape) {
    case 'sine':
      return Math.sin(ph * Math.PI * 2);
    case 'tri':
      return ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
    case 'saw':
      return 2 * ph - 1;
    case 'ramp':
      return 1 - 2 * ph;
    case 'square':
      return ph < 0.5 ? 1 : -1;
    case 'sh':
      return hashNoise(Math.floor(cycles));
    default: {
      const a = hashNoise(Math.floor(cycles));
      const b = hashNoise(Math.floor(cycles) + 1);
      const s = ph * ph * (3 - 2 * ph);
      return a + (b - a) * s;
    }
  }
}

function curveShape(c: LaneCurve, x: number): number {
  switch (c) {
    case 'smooth':
      return x * x * (3 - 2 * x);
    case 'in':
      return x * x;
    case 'out':
      return 1 - (1 - x) * (1 - x);
    default:
      return x;
  }
}

class Target {
  readonly lanes: LaneDef[] = [];
  readonly lfos: LfoDef[] = [];
  private idx = 0;
  private last = NaN;
  readonly base: number;
  private readonly spec: ParamSpec;
  constructor(
    readonly host: ParamHost,
    readonly name: string,
  ) {
    this.base = host.params[name];
    this.spec = host.specs[name];
  }
  finish(): void {
    this.lanes.sort((a, b) => a.t[0] - b.t[0]);
  }
  private laneValue(l: LaneDef, beat: number): number {
    const t = l.t;
    const n = t.length;
    if (beat >= t[n - 1]) return l.v[n - 1];
    // find the segment (linear scan from the start is fine: lanes are short; use binary search for long ones)
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t[mid] <= beat) lo = mid;
      else hi = mid;
    }
    const c = l.curve[hi];
    const a = l.v[lo];
    const b = l.v[hi];
    if (c === 'step') return a;
    const x = (beat - t[lo]) / (t[hi] - t[lo]);
    const s = curveShape(c, x);
    if (c === 'exp' && a > 0 && b > 0) return a * Math.pow(b / a, s);
    return a + (b - a) * s;
  }
  evaluate(beat: number): void {
    let v = this.base;
    const lanes = this.lanes;
    if (lanes.length) {
      while (this.idx + 1 < lanes.length && lanes[this.idx + 1].t[0] <= beat) this.idx++;
      if (lanes[this.idx].t[0] <= beat) v = this.laneValue(lanes[this.idx], beat);
    }
    let add = 0;
    let oct = 0;
    for (let i = 0; i < this.lfos.length; i++) {
      const o = this.lfos[i];
      if (beat >= o.startBeat && beat < o.endBeat) {
        const x = lfoValue(o.shape, (beat - o.startBeat) * o.rate + o.phase) * o.depth;
        if (o.mode === 'exp') oct += x;
        else add += x;
      }
    }
    if (oct !== 0) v *= Math.pow(2, oct);
    v += add;
    v = clamp(v, this.spec.min, this.spec.max);
    if (v !== this.last) {
      this.last = v;
      this.host.setParam(this.name, v);
    }
  }
}

export interface ChannelMeter {
  name: string;
  /** Mean-square energy per frame the channel was awake (post-fader, left and right summed) since the last `readMeters`. */
  energy: number;
  /** Frames the channel was awake (idle channels are skipped and cost nothing). */
  frames: number;
  /** Total energy (left plus right, post-fader) since the last `readMeters`: divide by 2 x the frames of a section for its rms. */
  sum: number;
}

export class AlbumRenderer implements TrackRenderer {
  readonly frames: number;
  readonly sr: number;
  private readonly prog: Program;
  private readonly channels: Channel[];
  private readonly buses: Bus[];
  private readonly events: Ev[];
  private readonly targets: Target[];
  private evi = 0;
  private pos = 0; // input clock (frames of the song processed so far)
  private readonly total: number; // frames to process (song + limiter latency)
  private readonly latency: number;
  private readonly framesPerBeat: number;
  private readonly io = new MixIO();
  // scratch
  private readonly sl = new Float64Array(SEG);
  private readonly sr2 = new Float64Array(SEG);
  private readonly mixL = new Float64Array(SEG);
  private readonly mixR = new Float64Array(SEG);
  // staging of finished output
  private readonly stL = new Float32Array(SEG);
  private readonly stR = new Float32Array(SEG);
  private stPos = 0;
  private stLen = 0;
  private outPos = 0; // frames handed out
  private readonly fadeInFrames: number;
  private readonly fadeOutFrames: number;
  /** Set true to collect per-channel levels (cost: one multiply-add per sample per channel). */
  profile: { now: () => number; times: Map<string, number> } | null = null;
  private readonly startFrame: number;

  constructor(prog: Program, opts: { startFrame?: number } = {}) {
    this.prog = prog;
    this.sr = prog.sr;
    this.frames = prog.frames;
    this.latency = prog.master.limiter.latency;
    this.total = prog.frames + this.latency;
    this.framesPerBeat = (prog.sr * 60) / prog.bpm;
    this.startFrame = Math.max(0, Math.floor(opts.startFrame ?? 0));
    this.fadeInFrames = Math.max(1, Math.round(prog.fadeIn * prog.sr));
    this.fadeOutFrames = Math.max(1, Math.round(prog.fadeOut * prog.sr));
    this.channels = prog.channels.map((c) => {
      const ch = new Channel(c.name, c.inst, c.strip, c.bus, c.key);
      ch.muted = c.mute;
      return ch;
    });
    this.buses = prog.buses.map((b) => new Bus(b.name, b.strip));
    // events -> frames, stable order: offs before ons at the same frame
    const list: { e: Ev; order: number }[] = [];
    prog.events.forEach((d, i) => {
      const f = Math.round(d.beat * this.framesPerBeat);
      if (f < this.startFrame && d.kind !== 'off') return;
      list.push({
        e: {
          f: Math.max(0, f - this.startFrame),
          kind: d.kind === 'off' ? 0 : d.kind === 'on' ? 1 : 2,
          ch: d.ch,
          note: d.note,
          vel: d.vel,
          dur: Math.max(1, Math.round(d.durBeats * this.framesPerBeat)),
          flags: d.flags,
          part: d.part,
        },
        order: i,
      });
    });
    list.sort((a, b) => a.e.f - b.e.f || (a.e.kind === 0 ? 0 : 1) - (b.e.kind === 0 ? 0 : 1) || a.order - b.order);
    this.events = list.filter((x) => !(x.e.kind === 0 && x.e.f <= 0 && this.startFrame > 0)).map((x) => x.e);
    // automation targets
    const map = new Map<string, Target>();
    const get = (host: ParamHost, name: string): Target => {
      const key = `${hostId(host)}:${name}`;
      let m = map.get(key);
      if (!m) {
        m = new Target(host, name);
        map.set(key, m);
      }
      return m;
    };
    for (const l of prog.lanes) get(l.host, l.name).lanes.push(l);
    for (const o of prog.lfos) get(o.host, o.name).lfos.push(o);
    this.targets = [...map.values()];
    for (const t of this.targets) t.finish();
    prog.transport.beat = 0;
    prog.transport.frame = 0;
  }

  /** Total frames left to hand out. */
  get remaining(): number {
    return this.frames - this.outPos;
  }

  /** Reads and resets the per-channel level meters. */
  readMeters(): ChannelMeter[] {
    const out: ChannelMeter[] = [];
    for (const c of this.channels) {
      out.push({ name: c.name, energy: c.strip.meterFrames ? c.strip.meterEnergy / c.strip.meterFrames : 0, frames: c.strip.meterFrames, sum: c.strip.meterEnergy });
      c.strip.meterEnergy = 0;
      c.strip.meterFrames = 0;
    }
    return out;
  }

  render(l: Float32Array, r: Float32Array, n: number): number {
    let written = 0;
    const want = Math.min(n, this.frames - this.outPos);
    while (written < want) {
      if (this.stPos >= this.stLen) {
        if (this.pos >= this.total) break;
        this.fill();
      }
      const m = Math.min(want - written, this.stLen - this.stPos);
      for (let i = 0; i < m; i++) {
        l[written + i] = this.stL[this.stPos + i];
        r[written + i] = this.stR[this.stPos + i];
      }
      this.stPos += m;
      written += m;
      this.outPos += m;
    }
    return written;
  }

  private dispatch(e: Ev): void {
    const ch = this.channels[e.ch];
    ch.idle = false;
    ch.quietSamples = 0;
    switch (e.kind) {
      case 0:
        ch.inst.noteOff(e.note);
        break;
      case 1:
        ch.inst.noteOn(e.note, e.vel, e.dur, e.flags);
        if (ch.key && (!ch.inst.keyed || ch.inst.keyed(e.part))) this.prog.duck.trigger(e.vel);
        break;
      default:
        ch.inst.hit(e.part, e.vel, e.dur, e.flags);
        if (ch.key && (!ch.inst.keyed || ch.inst.keyed(e.part))) this.prog.duck.trigger(e.vel);
        break;
    }
  }

  /** Renders the next segment of the song into the staging buffers. */
  private fill(): void {
    const prog = this.prog;
    const start = this.pos;
    let end = Math.min(start + SEG, this.total);
    while (this.evi < this.events.length && this.events[this.evi].f <= start) this.dispatch(this.events[this.evi++]);
    if (this.evi < this.events.length && this.events[this.evi].f < end) end = this.events[this.evi].f;
    const n = Math.max(1, end - start);
    const beat = (start + this.startFrame) / this.framesPerBeat;
    prog.transport.beat = beat;
    prog.transport.frame = start + this.startFrame;
    for (let i = 0; i < this.targets.length; i++) this.targets[i].evaluate(beat);

    const io = this.io;
    const mixL = this.mixL;
    const mixR = this.mixR;
    mixL.fill(0, 0, n);
    mixR.fill(0, 0, n);
    io.revL.fill(0, 0, n);
    io.revR.fill(0, 0, n);
    io.dlyL.fill(0, 0, n);
    io.dlyR.fill(0, 0, n);
    io.revUsed = false;
    io.dlyUsed = false;
    prog.duck.fill(io, n);
    for (const b of this.buses) {
      b.l.fill(0, 0, n);
      b.r.fill(0, 0, n);
    }
    const sl = this.sl;
    const sr2 = this.sr2;
    const prof = this.profile;
    for (let c = 0; c < this.channels.length; c++) {
      const ch = this.channels[c];
      if (ch.idle || ch.muted) continue;
      const t0 = prof ? prof.now() : 0;
      sl.fill(0, 0, n);
      const stereo = ch.inst.stereo;
      if (stereo) sr2.fill(0, 0, n);
      ch.inst.process(sl, sr2, n);
      const bus = ch.bus >= 0 ? this.buses[ch.bus] : null;
      const before = ch.strip.meterEnergy;
      ch.strip.process(sl, sr2, n, stereo, bus ? bus.l : mixL, bus ? bus.r : mixR, io);
      // idle detection: silent output and no sounding voices for a while
      const e = ch.strip.meterEnergy - before;
      if (e < 1e-10 * n && !ch.inst.active()) {
        ch.quietSamples += n;
        if (ch.quietSamples > prog.sr * 0.3) ch.idle = true;
      } else ch.quietSamples = 0;
      if (prof) prof.times.set(ch.name, (prof.times.get(ch.name) ?? 0) + prof.now() - t0);
    }
    for (const b of this.buses) {
      const t0 = prof ? prof.now() : 0;
      b.strip.process(b.l, b.r, n, true, mixL, mixR, io);
      if (prof) prof.times.set(`bus:${b.name}`, (prof.times.get(`bus:${b.name}`) ?? 0) + prof.now() - t0);
    }
    {
      const t0 = prof ? prof.now() : 0;
      prog.reverb.process(io, mixL, mixR, n);
      prog.delay.process(io, mixL, mixR, n);
      const t1 = prof ? prof.now() : 0;
      prog.master.process(mixL, mixR, n);
      if (prof) {
        prof.times.set('sends', (prof.times.get('sends') ?? 0) + t1 - t0);
        prof.times.set('master', (prof.times.get('master') ?? 0) + prof.now() - t1);
      }
    }
    // stage the output: the first `latency` frames of the master output are the limiter's pre-roll and are dropped
    let from = 0;
    if (start < this.latency) from = Math.min(n, this.latency - start);
    let m = 0;
    for (let i = from; i < n; i++) {
      const outIdx = start + i - this.latency;
      let g = 1;
      if (outIdx < this.fadeInFrames) {
        const x = outIdx / this.fadeInFrames;
        g = x * x * (3 - 2 * x);
      }
      const rem = this.frames - 1 - outIdx;
      if (rem < this.fadeOutFrames) {
        const x = Math.max(0, rem) / this.fadeOutFrames;
        g *= x * x * (3 - 2 * x);
      }
      let a = mixL[i] * g;
      let b = mixR[i] * g;
      // belt and braces: the limiter keeps the signal under the ceiling; this only guards NaN/Inf and the +-1 rail
      if (!(a === a)) a = 0;
      if (!(b === b)) b = 0;
      this.stL[m] = a > 1 ? 1 : a < -1 ? -1 : a;
      this.stR[m] = b > 1 ? 1 : b < -1 ? -1 : b;
      m++;
    }
    this.stPos = 0;
    this.stLen = m;
    this.pos = end;
  }
}

let HOST_IDS = 0;
const hostIds = new WeakMap<object, number>();
function hostId(h: object): number {
  let id = hostIds.get(h);
  if (id === undefined) {
    id = ++HOST_IDS;
    hostIds.set(h, id);
  }
  return id;
}
